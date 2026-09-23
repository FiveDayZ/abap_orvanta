import assert from "node:assert/strict"
import test from "node:test"
import { readAbapTable } from "../src/table-query.js"
import type { RemoteFunctionRequest, RemoteFunctionResult } from "../src/backend.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"
import { createServer } from "node:http"
import { AdtBackend } from "../src/adt-backend.js"
import { listenOnUnblockedPort } from "./loopback-port.js"

const legacy = {
  functionName: "RFC_READ_TABLE",
  remoteEnabled: true,
  updateTask: false,
  sourceFingerprint: "7b9a603493673d26f75e555616b24d150e407ce03eff57e9c68f0b30b1ba0c2d",
  interfaceFingerprint: "d06cc5c1ce05960bde526ecf27e38606134146474cc8da19f93ac2abd3e48074"
}
const aligned = {
  ...legacy,
  functionName: "BBP_RFC_READ_TABLE",
  sourceFingerprint: "e08069939315d594527fe58fc1a52e32e583d0987bc173295ddb816be9051b94",
  interfaceFingerprint: "d85d035301f09d00229fa830e7c4cd7c63c8a167055d53bb62ddebb44d17743a"
}
const input = {
  connectionId: "w200",
  tableName: "TFDIR",
  columns: ["ID"],
  filters: [{ column: "ID", operator: "EQ", value: "0001" }],
  maxRows: 1
}

function fixture(type = "P") {
  const definition = {
    objectKind: "transparentTable",
    objectName: "TFDIR",
    fingerprint: "a".repeat(64),
    definition: {
      tableClass: "TRANSP",
      fields: [
        { name: "ID" },
        { name: ".INCLUDE" },
        { name: ".INCLU--AP" },
        { name: "/VSO/AMOUNT" }
      ]
    }
  }
  const fields = [
    { FIELDNAME: "ID", TYPE: "C", LENGTH: "4", OFFSET: "0" },
    { FIELDNAME: "/VSO/AMOUNT", TYPE: type, LENGTH: "13", OFFSET: "5" }
  ]
  const requests: RemoteFunctionRequest[] = []
  const readers: string[] = []
  const backend = {
    runQuery: async (): Promise<Record<string, unknown>[]> => {
      throw new Error(
        "SAP_DATA_QUERY_RESPONSE_INVALID: expected XML data preview; HTTP 200; mediaType=text/html; root=unparsed; bytes=0. No empty result was inferred."
      )
    },
    callRemoteFunction: async (
      _connectionId: string,
      request: RemoteFunctionRequest
    ): Promise<RemoteFunctionResult> => {
      requests.push(request)
      const names = (request.inputParameters.FIELDS as { FIELDNAME: string }[]).map(
        (field) => field.FIELDNAME
      )
      return {
        outputs: {
          FIELDS: structuredClone(
            names.length ? names.map((name) => fields.find((f) => f.FIELDNAME === name)!) : fields
          ),
          DATA: request.inputParameters.NO_DATA === "X" ? [] : [{ WA: "0001" }]
        }
      }
    }
  }
  const readReader = async (_connection: string, name: string) => {
    readers.push(name)
    return name === legacy.functionName ? legacy : aligned
  }
  return {
    definition,
    fields,
    requests,
    readers,
    backend,
    readReader,
    read: () => readAbapTable(input, backend, async () => definition, readReader)
  }
}

test("Includes and namespaced physical fields are cross-checked against the full SAP layout", async () => {
  const f = fixture("C")
  const result = await f.read()
  assert.equal(result.status, "ok")
  assert.equal(result.method, "rfc_read_table")
  assert.deepEqual(f.requests[0]!.inputParameters.FIELDS, [])
  assert.equal(f.requests[0]!.inputParameters.NO_DATA, "X")
  assert.deepEqual(result.data, [{ ID: "0001" }])
  assert.deepEqual(f.readers, ["RFC_READ_TABLE"])
})

for (const type of ["P", "I", "F", "X", "b", "s"]) {
  test(`mixed ${type} layout uses only the verified aligned reader for actual data`, async () => {
    const f = fixture(type)
    const result = await f.read()
    assert.equal(result.status, "ok")
    assert.equal(result.method, "bbp_rfc_read_table")
    assert.equal("representation" in result && result.representation, "sap_text_trimmed")
    assert.equal(result.truncated, false)
    assert.deepEqual(result.data, [{ ID: "0001" }])
    assert.deepEqual(f.readers, ["RFC_READ_TABLE", "BBP_RFC_READ_TABLE"])
    assert.deepEqual(
      f.requests.map((r) => [r.functionName, r.inputParameters.NO_DATA]),
      [
        ["RFC_READ_TABLE", "X"],
        ["BBP_RFC_READ_TABLE", "X"],
        ["BBP_RFC_READ_TABLE", ""]
      ]
    )
    assert.equal(f.requests[2]!.inputParameters.ROWCOUNT, "2")
    assert.equal(f.requests[2]!.inputParameters.ROWSKIPS, "0")
    assert.deepEqual(f.requests[2]!.inputParameters.OPTIONS, [{ TEXT: "ID = '0001'" }])
  })
}

test("unknown markers, duplicate physical fields and unexpanded definitions fail closed", async () => {
  for (const mode of ["unknown", "duplicate", "unexpanded", "extra", "markerOnly"]) {
    const f = fixture()
    if (mode === "unknown") f.definition.definition.fields[1]!.name = ".ANYTHING"
    if (mode === "duplicate") f.definition.definition.fields.push({ name: "ID" })
    if (mode === "unexpanded") f.definition.definition.fields.pop()
    if (mode === "extra") f.fields.push({ ...f.fields[0]!, FIELDNAME: "HIDDEN" })
    if (mode === "markerOnly") f.definition.definition.fields = [{ name: ".INCLUDE" }]
    const result = await f.read()
    assert.equal(result.status, "unavailable", mode)
    assert.ok(f.requests.every((r) => r.inputParameters.NO_DATA === "X"))
  }
})

test("mixed reader refuses deep, unknown, zero-length and excessive whole-row layouts", async () => {
  for (const type of ["g", "y", "u", "h", "8", "a", "e"]) {
    const f = fixture(type)
    const result = await f.read()
    assert.equal(result.status, "unavailable", type)
    assert.deepEqual("layoutSummary" in result && result.layoutSummary, {
      fieldCount: 2,
      totalLength: 17,
      types: ["C", type].sort()
    })
    assert.deepEqual(f.readers, ["RFC_READ_TABLE"])
    assert.equal(f.requests.length, 1)
  }
  for (const length of ["0", "8001"]) {
    const f = fixture()
    f.fields[1]!.LENGTH = length
    assert.equal((await f.read()).status, "unavailable")
    assert.equal(f.requests.length, 1)
  }
})

test("byte projection and numeric filters remain unsupported in the mixed fallback", async () => {
  for (const type of ["P", "X", "b", "s"]) {
    for (const filter of [false, true]) {
      if (!filter && type !== "X") continue
      const f = fixture(type)
      f.fields[1]!.FIELDNAME = "AMOUNT"
      f.definition.definition.fields[3]!.name = "AMOUNT"
      const request = filter
        ? { ...input, filters: [{ column: "AMOUNT", operator: "EQ", value: "1" }] }
        : { ...input, columns: ["AMOUNT"] }
      const result = await readAbapTable(request, f.backend, async () => f.definition, f.readReader)
      assert.equal(result.status, "unavailable")
      assert.equal(f.requests.length, 1)
    }
  }
})

test("aligned reader identity, interface, source and read failures never authorize data reads", async () => {
  for (const patch of [
    { functionName: "OTHER" },
    { remoteEnabled: false },
    { updateTask: true },
    { sourceFingerprint: "b".repeat(64) },
    { interfaceFingerprint: "b".repeat(64) },
    null
  ]) {
    const f = fixture()
    const result = await readAbapTable(
      input,
      f.backend,
      async () => f.definition,
      async (_connection, name) => {
        if (name === legacy.functionName) return legacy
        if (!patch) throw new Error("SECRET")
        return { ...aligned, ...patch }
      }
    )
    assert.equal(result.status, "unavailable")
    assert.equal(f.requests.length, 1)
    assert.doesNotMatch(JSON.stringify(result), /SECRET/)
  }
})

test("aligned layout drift, permission errors and data failures do not fall back or retry", async () => {
  for (const mode of ["type", "length", "offset", "field", "metadataData", "denied", "dataError"]) {
    const f = fixture()
    const invoke = f.backend.callRemoteFunction
    f.backend.callRemoteFunction = async (connection, request) => {
      const result = await invoke(connection, request)
      if (request.functionName !== aligned.functionName) return result
      if (mode === "dataError") {
        if (!request.inputParameters.NO_DATA) throw new Error("SECRET")
        return result
      }
      if (mode === "denied")
        return { outputs: {}, fault: { code: "SOAP", name: "NOT_AUTHORIZED", message: "SECRET" } }
      const fields = result.outputs.FIELDS as Record<string, string>[]
      if (mode === "type") fields[1]!.TYPE = "C"
      if (mode === "length") fields[1]!.LENGTH = "14"
      if (mode === "offset") fields[1]!.OFFSET = "6"
      if (mode === "field") fields[1]!.FIELDNAME = "OTHER"
      if (mode === "metadataData") result.outputs.DATA = [{ WA: "unexpected" }]
      return result
    }
    const result = await f.read()
    assert.equal(result.status, "unavailable", mode)
    assert.equal(f.requests.length, mode === "dataError" ? 3 : 2)
    assert.doesNotMatch(JSON.stringify(result), /SECRET/)
  }
})

test("legacy permission denial does not attempt the aligned reader", async () => {
  const f = fixture()
  f.backend.callRemoteFunction = async () => ({
    outputs: {},
    fault: { code: "SOAP", name: "NOT_AUTHORIZED", message: "denied" }
  })
  assert.equal((await f.read()).status, "unavailable")
  assert.deepEqual(f.readers, ["RFC_READ_TABLE"])
})

test("ToolService resolves each requested reader instead of reusing the legacy fingerprint", async () => {
  const f = fixture()
  const backend = new MockBackend()
  backend.runQuery = f.backend.runQuery
  backend.callRemoteFunction = f.backend.callRemoteFunction
  const tools = new ToolService(backend)
  tools.readDdicTransparentTable = async () => JSON.stringify(f.definition)
  tools.readFunctionModuleInterface = async ({ connectionId, functionName }) =>
    JSON.stringify(await f.readReader(connectionId, functionName))
  const result = JSON.parse(await tools.readAbapTable(input))
  assert.equal(result.status, "ok")
  assert.equal(result.method, "bbp_rfc_read_table")
  assert.deepEqual(f.readers, ["RFC_READ_TABLE", "BBP_RFC_READ_TABLE"])
})

test("small-integer mixed fallback completes actual HTTP/SOAP parsing without legacy data execution", async (t) => {
  const f = fixture("s")
  const calls: string[] = []
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/sap/bc/adt/datapreview/freestyle")) {
      response.writeHead(200, { "Content-Type": "text/html" })
      response.end("")
      return
    }
    if (request.url?.startsWith("/sap/bc/soap/rfc")) {
      let body = ""
      for await (const chunk of request) body += chunk.toString()
      const name = body.includes("BBP_RFC_READ_TABLE") ? aligned.functionName : legacy.functionName
      const noData = body.includes("<NO_DATA>X</NO_DATA>")
      calls.push(`${name}:${noData ? "metadata" : "data"}`)
      assert.ok(noData || name === aligned.functionName)
      assert.match(body, /<QUERY_TABLE>TFDIR<\/QUERY_TABLE>/)
      assert.match(body, /<ROWSKIPS>0<\/ROWSKIPS>/)
      const fields = noData ? f.fields : [f.fields[0]!]
      const metadata = fields
        .map(
          (field) =>
            `<item>${Object.entries(field)
              .map(([key, value]) => `<${key}>${value}</${key}>`)
              .join("")}</item>`
        )
        .join("")
      response.writeHead(200, { "Content-Type": "text/xml" })
      response.end(
        `<Envelope><Body><${name}.Response><FIELDS>${metadata}</FIELDS><DATA>${
          noData ? "" : "<item><WA>0001</WA></item><item><WA>0002</WA></item>"
        }</DATA></${name}.Response></Body></Envelope>`
      )
      return
    }
    response.writeHead(200, { "Content-Type": "application/xml", "x-csrf-token": "test-only" })
    response.end("<graph/>")
  })
  await listenOnUnblockedPort(server)
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const backend = new AdtBackend(
    [
      {
        id: "w200",
        url: `http://127.0.0.1:${address.port}`,
        client: "200",
        language: "EN",
        username: "test",
        passwordEnv: "TEST_UNUSED",
        allowUnauthorized: false
      }
    ],
    () => "test-only"
  )
  t.after(async () => {
    await backend.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const result = await readAbapTable(input, backend, async () => f.definition, f.readReader)
  assert.equal(result.status, "ok")
  assert.equal(result.method, "bbp_rfc_read_table")
  assert.equal(result.truncated, true)
  assert.deepEqual(result.data, [{ ID: "0001" }])
  assert.deepEqual(calls, [
    "RFC_READ_TABLE:metadata",
    "BBP_RFC_READ_TABLE:metadata",
    "BBP_RFC_READ_TABLE:data"
  ])
})
