import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import test from "node:test"
import { AdtBackend } from "../src/adt-backend.js"
import { parseConnections } from "../src/config.js"
import {
  configurationBcTypePoolReadPins as pins,
  isConfigurationBcTypePoolUri,
  readConfigurationBcTypePool
} from "../src/configuration-bc-type-pool.js"
import type { RemoteFunctionResult } from "../src/backend.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"

const uri = "adt://w200/sap/bc/adt/vit/wb/object_type/typedg/object_name/SCPR"
function fixture() {
  const backend = new MockBackend()
  let nativeCalls = 0,
    definitionReads = 0
  const native: RemoteFunctionResult = {
    outputs: {
      PROG_INF: { PROGNAME: "%_CSCPR", PROG_TYPE: "I" },
      SOURCE_EXTENDED: [{ LINE: "TYPE-POOL SCPR." }, { LINE: "  TYPES scpr_test TYPE c.  " }]
    }
  }
  const definition = {
    connectionId: "w200",
    functionName: "RPY_PROGRAM_READ",
    remoteEnabled: true,
    updateTask: false,
    sourceFingerprint: String(pins.RPY_PROGRAM_READ.source),
    interfaceFingerprint: String(pins.RPY_PROGRAM_READ.interface)
  }
  const readers = {
    definition: async () => {
      definitionReads++
      return definition
    },
    structure: async (name: "RPY_PROG" | "ABAPTXT255") => ({
      connectionId: "w200",
      objectName: name,
      objectKind: "structure",
      fingerprint: String(pins[name])
    })
  }
  backend.callRemoteFunction = async (id, request) => {
    nativeCalls++
    assert.equal(id, "w200")
    assert.equal(request.functionName, "RPY_PROGRAM_READ")
    assert.deepEqual(request.inputParameters, {
      PROGRAM_NAME: "%_CSCPR",
      WITH_INCLUDELIST: "",
      ONLY_SOURCE: "X",
      ONLY_TEXTS: "",
      READ_LATEST_VERSION: "",
      WITH_LOWERCASE: "X",
      SOURCE_EXTENDED: []
    })
    return structuredClone(native)
  }
  return {
    backend,
    readers,
    native,
    definition,
    invoke: () => readConfigurationBcTypePool("w200", uri, backend, readers),
    nativeCalls: () => nativeCalls,
    definitionReads: () => definitionReads
  }
}

test("type pool read preserves rows and pins the sole active native request", async () => {
  const f = fixture(),
    result = await f.invoke()
  assert.equal(result.source, "TYPE-POOL SCPR.\r\n  TYPES scpr_test TYPE c.  ")
  assert.equal(result.sourceFingerprint, createHash("sha256").update(result.source).digest("hex"))
  assert.equal(result.representation, "rfc_char255_rows_crlf")
  assert.equal(result.sourceVersion, "active")
  assert.equal(f.nativeCalls(), 1)
  assert.equal(f.definitionReads(), 2)
})

test("type pool scope cannot become a generic program or cross-client source reader", async () => {
  const f = fixture()
  for (const target of [uri + "?inactive=true", uri + "/../OTHER", uri.replace("SCPR", "ABAP")]) {
    assert.equal(isConfigurationBcTypePoolUri(target), false)
    await assert.rejects(
      readConfigurationBcTypePool("w200", target, f.backend, f.readers),
      /SCOPE_INVALID/
    )
  }
  await assert.rejects(
    readConfigurationBcTypePool("w300", uri, f.backend, f.readers),
    /SCOPE_INVALID/
  )
  await assert.rejects(
    readConfigurationBcTypePool("w200", uri.replace("w200", "w300"), f.backend, f.readers),
    /SCOPE_INVALID/
  )
  const details = f.backend.connectionDetails.bind(f.backend)
  f.backend.connectionDetails = (id) => ({ ...details(id), client: "300" })
  await assert.rejects(f.invoke(), /SCOPE_INVALID/)
  assert.equal(f.nativeCalls(), 0)
  assert.equal(f.definitionReads(), 0)
})

test("type pool reader refuses changed API or layout before native dispatch", async () => {
  for (const patch of [
    { sourceFingerprint: "0".repeat(64) },
    { interfaceFingerprint: "0".repeat(64) },
    { remoteEnabled: false },
    { updateTask: true }
  ]) {
    const f = fixture()
    Object.assign(f.definition, patch)
    await assert.rejects(f.invoke())
    assert.equal(f.nativeCalls(), 0)
  }
  const f = fixture(),
    structure = f.readers.structure
  f.readers.structure = async (name) => ({
    ...(await structure(name)),
    fingerprint: "0".repeat(64)
  })
  await assert.rejects(f.invoke())
  assert.equal(f.nativeCalls(), 0)
})

test("post-read source drift and metadata failures retract the result without a retry", async () => {
  const f = fixture()
  f.readers.definition = async () => ({
    ...f.definition,
    sourceFingerprint: f.nativeCalls() ? "0".repeat(64) : f.definition.sourceFingerprint
  })
  await assert.rejects(f.invoke())
  assert.equal(f.nativeCalls(), 1)
  const other = fixture()
  other.readers.structure = async () => {
    throw Error("native metadata unavailable")
  }
  await assert.rejects(other.invoke(), /native metadata unavailable/)
  assert.equal(other.nativeCalls(), 0)
})

test("native source identity, row limits, header and transport errors cannot return success", async () => {
  for (const outputs of [
    { PROG_INF: { PROGNAME: "SCPR", PROG_TYPE: "I" } },
    { SOURCE_EXTENDED: [] },
    { SOURCE_EXTENDED: [{ LINE: "REPORT different." }] },
    { SOURCE_EXTENDED: [{ LINE: "TYPE-POOL SCPR.\nREPORT injected." }] },
    { SOURCE_EXTENDED: [{ LINE: "TYPE-POOL SCPR." }, { LINE: "x".repeat(256) }] },
    { SOURCE_EXTENDED: Array.from({ length: 4097 }, () => ({ LINE: "TYPE-POOL SCPR." })) },
    {
      SOURCE_EXTENDED: [
        { LINE: "TYPE-POOL SCPR." },
        ...Array.from({ length: 1600 }, () => ({ LINE: "字".repeat(255) }))
      ]
    }
  ]) {
    const f = fixture()
    Object.assign(f.native.outputs, outputs)
    await assert.rejects(f.invoke())
    assert.equal(f.nativeCalls(), 1)
  }
  const f = fixture()
  f.native.fault = { code: "Server", name: "PERMISSION_ERROR", message: "internal details" }
  await assert.rejects(f.invoke(), /TYPE_POOL_READ_REJECTED/)
  assert.equal(f.nativeCalls(), 1)
})

test("the URI tool exposes native source provenance and preserves ordinary URI behavior", async () => {
  const f = fixture(),
    service = new ToolService(f.backend)
  service.readFunctionModuleInterface = async () => JSON.stringify(await f.readers.definition())
  service.readDdicStructure = async ({ objectName }) =>
    JSON.stringify(await f.readers.structure(objectName as "RPY_PROG" | "ABAPTXT255"))
  let adtReads = 0
  f.backend.readSourceByUri = async (_id, target) => {
    adtReads++
    return { source: "REPORT ordinary.", uriUsed: target }
  }
  const result = await service.getObjectByUri({
    connectionId: "w200",
    uri,
    startLine: 1,
    lineCount: 1
  })
  assert.match(result, /Source Provider: RPY_PROGRAM_READ/)
  assert.match(result, /Full Source SHA-256: [a-f0-9]{64}/)
  assert.match(result, /```abap\n  TYPES scpr_test TYPE c\.  \n```/)
  assert.equal(adtReads, 0)
  const ordinary = await service.getObjectByUri({
    connectionId: "w200",
    uri: uri.replace("SCPR", "OTHER")
  })
  assert.match(ordinary, /REPORT ordinary\./)
  assert(!ordinary.includes("Source Provider:"))
  assert.equal(adtReads, 1)
  assert.equal(f.nativeCalls(), 1)
})

test("actual SOAP backend preserves CHAR255 indentation only for the standard source reader", async (t) => {
  const server = createServer((request, response) => {
    request.resume()
    response.writeHead(200, { "Content-Type": "text/xml" })
    response.end("<r><SOURCE_EXTENDED><item><LINE>  lowercase </LINE></item></SOURCE_EXTENDED></r>")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  assert(address && typeof address !== "string")
  const backend = new AdtBackend(
    parseConnections({
      connections: [
        {
          id: "mock",
          url: `http://127.0.0.1:${address.port}`,
          client: "200",
          username: "test",
          passwordEnv: "DUMMY_UNUSED"
        }
      ]
    }),
    () => "test-placeholder"
  )
  t.after(() => backend.close())
  const request = {
    inputParameters: {},
    outputParameters: [{ name: "SOURCE_EXTENDED", kind: "table" as const, fields: ["LINE"] }]
  }
  const read = await backend.callRemoteFunction("mock", {
    ...request,
    functionName: "RPY_PROGRAM_READ"
  })
  assert.deepEqual(read.outputs.SOURCE_EXTENDED, [{ LINE: "  lowercase " }])
  const other = await backend.callRemoteFunction("mock", { ...request, functionName: "Z_OTHER" })
  assert.deepEqual(other.outputs.SOURCE_EXTENDED, [{ LINE: "lowercase" }])
})
