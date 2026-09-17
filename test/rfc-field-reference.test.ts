import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { startHttpServer } from "../src/http.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"

const base = { connectionId: "w200", functionName: "ZCMCP_FM_1501" }

function fixture(
  options: {
    type?: string
    field?: Record<string, string>
    missing?: boolean
    duplicate?: boolean
    error?: string
    wrongTable?: boolean
    structure?: boolean
    tableParameter?: boolean
    elementError?: boolean
    domainHeader?: Record<string, string>
    outputReference?: boolean
  } = {}
) {
  const backend = new MockBackend()
  const repository = backend.callSapRepository.bind(backend)
  const ddic = backend.callSapDdic.bind(backend)
  const requests: string[] = []
  backend.callSapRepository = async (id, request) => {
    const result = await repository(id, request)
    if (request.operation !== "READ_FUNCTION_INTERFACE") return result
    return {
      ...result,
      source: result.source
        .map((line) => {
          if (line === "I|1|TYP|CHAR20") return `I|1|TYP|${options.type ?? "ZREF-EXTERNAL_ID"}`
          if (line === "I|1|OPTIONAL|") return "I|1|OPTIONAL|X"
          if (options.outputReference && line === "E|1|TYP|CHAR40") {
            return "E|1|TYP|ZREF-EXTERNAL_ID"
          }
          return line
        })
        .map((line) => (options.tableParameter ? line.replace(/^I\|/, "T|") : line))
    }
  }
  backend.callSapDdic = async (id, request) => {
    requests.push(`${request.operation}:${request.objectName}`)
    if (options.elementError && request.objectName === "CHAR20") {
      throw new Error("Element read denied")
    }
    if (
      options.domainHeader &&
      request.operation === "READ_DOMAIN" &&
      request.objectName === "CHAR20"
    ) {
      return { ...(await ddic(id, request)), header: options.domainHeader }
    }
    if (request.objectName !== "ZREF" && request.objectName !== "/NS/ZREF") {
      return ddic(id, request)
    }
    const result = await ddic(id, { operation: "READ_STRUCTURE", objectName: "BAPIRET2" })
    if (options.error)
      return { ...result, status: "E", code: options.error, message: options.error }
    if (request.operation === "READ_STRUCTURE" && !options.structure) {
      return { ...result, status: "E", code: "OBJECT_TYPE_MISMATCH", message: "Not a structure" }
    }
    const field = options.field ?? {
      FIELDNAME: "EXTERNAL_ID",
      ROLLNAME: "CHAR20",
      COMPTYPE: "E",
      DATATYPE: "CHAR",
      LENG: "20"
    }
    return {
      ...result,
      header: {
        TABNAME: options.wrongTable ? "OTHER" : request.objectName,
        TABCLASS: options.structure ? "INTTAB" : "TRANSP"
      },
      fields: options.missing ? [] : options.duplicate ? [field, field] : [field]
    }
  }
  return { backend, requests, tools: new ToolService(backend) }
}

test("optional TABLE-FIELD input resolves to its data element and preserves scalar length", async () => {
  const { tools, backend, requests } = fixture()
  const metadata = JSON.parse(
    await tools.readFunctionModuleInterface({
      ...base,
      includeExecutionSupport: true
    })
  )
  assert.equal(metadata.executionSupport.supported, true, JSON.stringify(metadata.executionSupport))
  assert.deepEqual(
    metadata.executionSupport.parameters.find((p: { name: string }) => p.name === "IV_INPUT"),
    {
      name: "IV_INPUT",
      typeName: "ZREF-EXTERNAL_ID",
      optional: true,
      direction: "import",
      kind: "scalar",
      maxCharacters: 20,
      valueContract: { dataType: "CHAR", length: 20 },
      supported: true
    }
  )
  assert.ok(requests.includes("READ_TRANSPARENT_TABLE:ZREF"))
  assert.ok(!requests.some((request) => request.endsWith(":ZREF-EXTERNAL_ID")))
  const result = JSON.parse(
    await tools.testRemoteFunctionModule({
      ...base,
      inputParameters: { IV_INPUT: "x".repeat(20) },
      expectedOutputs: { EV_OUTPUT: `MCP:${"x".repeat(20)}` },
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true
    })
  )
  assert.equal(result.status, "passed")
  await assert.rejects(
    tools.testRemoteFunctionModule({
      ...base,
      inputParameters: { IV_INPUT: "x".repeat(21) },
      expectedOutputs: { EV_OUTPUT: "unused" },
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true
    }),
    /IV_INPUT exceeds 20 characters/
  )
  assert.equal(backend.remoteFunctionCalls, 1)
})

test("M7 captured ZTPMC_RKH-ZRKZZ type chain resolves CHAR50 without business data", async () => {
  const { backend } = fixture({ type: "ZTPMC_RKH-ZRKZZ" })
  const ddic = backend.callSapDdic.bind(backend)
  backend.callSapDdic = async (id, request) => {
    if (request.objectName === "ZTPMC_RKH") {
      const result = await ddic(id, { ...request, objectName: "ZREF" })
      return {
        ...result,
        header: { ...result.header, TABNAME: "ZTPMC_RKH" },
        fields: [{ FIELDNAME: "ZRKZZ", ROLLNAME: "ZPMCEZZDH", COMPTYPE: "E" }]
      }
    }
    if (request.operation === "READ_DATA_ELEMENT" && request.objectName === "ZPMCEZZDH") {
      const result = await ddic(id, { ...request, objectName: "CHAR20" })
      return { ...result, header: { ROLLNAME: "ZPMCEZZDH", DOMNAME: "CHAR50" } }
    }
    if (request.operation === "READ_DOMAIN" && request.objectName === "CHAR50") {
      const result = await ddic(id, { ...request, objectName: "CHAR20" })
      return { ...result, header: { DOMNAME: "CHAR50", DATATYPE: "CHAR", LENG: "50" } }
    }
    return ddic(id, request)
  }
  const tools = new ToolService(backend)
  const metadata = JSON.parse(
    await tools.readFunctionModuleInterface({
      ...base,
      includeExecutionSupport: true
    })
  )
  assert.equal(metadata.executionSupport.supported, true)
  assert.equal(metadata.executionSupport.parameters[0].maxCharacters, 50)
  await assert.rejects(
    tools.testRemoteFunctionModule({
      ...base,
      inputParameters: { IV_INPUT: "x".repeat(51) },
      expectedOutputs: { EV_OUTPUT: "unused" },
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true
    }),
    /IV_INPUT exceeds 50 characters/
  )
  assert.equal(backend.remoteFunctionCalls, 0)
})

for (const options of [{ structure: true }, { type: "/NS/ZREF-EXTERNAL_ID" }]) {
  test(`field reference supports verified structure or namespace ${JSON.stringify(options)}`, async () => {
    const { tools } = fixture(options)
    const metadata = JSON.parse(
      await tools.readFunctionModuleInterface({
        ...base,
        includeExecutionSupport: true
      })
    )
    assert.equal(metadata.executionSupport.supported, true)
  })
}

for (const [label, options] of [
  ["missing field", { missing: true }],
  ["duplicate field", { duplicate: true }],
  ["wrong table", { wrongTable: true }],
  ["table position", { tableParameter: true }],
  ["malformed reference", { type: "ZREF-EXTERNAL_ID-EXTRA" }],
  ["missing parent", { error: "DDIC_OBJECT_NOT_FOUND" }],
  ["permission failure", { error: "NO_AUTHORITY" }],
  ["element read failure", { elementError: true }],
  ["wrong domain identity", { domainHeader: { DOMNAME: "OTHER", DATATYPE: "CHAR", LENG: "20" } }],
  ["deep domain", { domainHeader: { DOMNAME: "CHAR20", DATATYPE: "STRG", LENG: "20" } }],
  ["missing domain type", { domainHeader: { DOMNAME: "CHAR20", LENG: "20" } }],
  ["invalid domain length", { domainHeader: { DOMNAME: "CHAR20", DATATYPE: "CHAR", LENG: "0" } }],
  ["deep field", { field: { FIELDNAME: "EXTERNAL_ID", ROLLNAME: "CHAR20", COMPTYPE: "S" } }],
  ["unknown direct type", { field: { FIELDNAME: "EXTERNAL_ID", DATATYPE: "STRG", LENG: "20" } }],
  ["zero direct length", { field: { FIELDNAME: "EXTERNAL_ID", DATATYPE: "CHAR", LENG: "0" } }]
] as const) {
  test(`unsafe field reference rejects before dispatch: ${label}`, async () => {
    const { backend, tools, requests } = fixture(options)
    const metadata = JSON.parse(
      await tools.readFunctionModuleInterface({
        ...base,
        includeExecutionSupport: true
      })
    )
    assert.equal(metadata.executionSupport.supported, false)
    // Omitting the optional parameter must not bypass an unresolved interface.
    await assert.rejects(
      tools.testRemoteFunctionModule({
        ...base,
        inputParameters: {},
        expectedOutputs: { EV_OUTPUT: "unused" },
        expectedInterfaceFingerprint: metadata.fingerprint,
        acknowledgePotentialSideEffects: true
      }),
      /Function interface is not supported/
    )
    assert.equal(backend.remoteFunctionCalls, 0)
    if ("error" in options) assert.ok(!requests.includes("READ_TRANSPARENT_TABLE:ZREF"))
  })
}

for (const datatype of ["CHAR", "NUMC", "DATS", "TIMS", "INT4"]) {
  test(`field reference accepts existing direct type ${datatype}`, async () => {
    const length = datatype === "DATS" ? "8" : datatype === "TIMS" ? "6" : "10"
    const { tools } = fixture({
      field: { FIELDNAME: "EXTERNAL_ID", COMPTYPE: "E", DATATYPE: datatype, LENG: length }
    })
    const metadata = JSON.parse(
      await tools.readFunctionModuleInterface({
        ...base,
        includeExecutionSupport: true
      })
    )
    assert.equal(metadata.executionSupport.supported, true)
    if (datatype === "CHAR" || datatype === "NUMC") {
      assert.equal(metadata.executionSupport.parameters[0].maxCharacters, 10)
    }
  })
}

test("allowlisted invocation and MCP discovery share the field reference resolver", async () => {
  const root = await mkdtemp(join(tmpdir(), "m7-field-reference-"))
  const { backend } = fixture()
  const server = await startHttpServer(backend, 0, root)
  const client = new Client({ name: "field-reference-test", version: "1" })
  try {
    const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl))
    await client.connect(transport as Parameters<Client["connect"]>[0])
    const response = await client.callTool({
      name: "read_function_module_interface",
      arguments: { ...base, includeExecutionSupport: true }
    })
    assert.equal(response.isError, undefined)
    const metadata = JSON.parse((response.content as Array<{ text: string }>)[0]!.text)
    assert.equal(metadata.executionSupport.supported, true)
    const called = await client.callTool({
      name: "invoke_customer_function_module",
      arguments: {
        ...base,
        operationId: "field-reference-ok",
        requestId: "field-reference-ok",
        inputParameters: { IV_INPUT: "TEST" },
        expectedInterfaceFingerprint: metadata.fingerprint,
        acknowledgePotentialSideEffects: true
      }
    })
    assert.equal(called.isError, undefined, JSON.stringify(called.content))
    const result = JSON.parse((called.content as Array<{ text: string }>)[0]!.text)
    assert.equal(result.outputs.EV_OUTPUT, "MCP:TEST")
    const rejected = await client.callTool({
      name: "invoke_customer_function_module",
      arguments: {
        ...base,
        operationId: "field-reference-long",
        requestId: "field-reference-long",
        inputParameters: { IV_INPUT: "x".repeat(21) },
        expectedInterfaceFingerprint: metadata.fingerprint,
        acknowledgePotentialSideEffects: true
      }
    })
    assert.equal(rejected.isError, true)
    assert.match(JSON.stringify(rejected.content), /IV_INPUT exceeds 20 characters/)
    assert.equal(backend.remoteFunctionCalls, 1)
  } finally {
    await client.close()
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("output field references retain scalar metadata and exact-result assertions", async () => {
  const { backend, tools } = fixture({ outputReference: true })
  const metadata = JSON.parse(
    await tools.readFunctionModuleInterface({
      ...base,
      includeExecutionSupport: true
    })
  )
  assert.equal(metadata.executionSupport.parameters[1].kind, "scalar")
  assert.equal(metadata.executionSupport.parameters[1].maxCharacters, 20)
  const result = JSON.parse(
    await tools.testRemoteFunctionModule({
      ...base,
      inputParameters: { IV_INPUT: "TEST" },
      expectedOutputs: { EV_OUTPUT: "MCP:TEST" },
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true
    })
  )
  assert.equal(result.status, "passed")
  backend.callRemoteFunction = async () => ({ outputs: { EV_OUTPUT: "x".repeat(21) } })
  await assert.rejects(
    tools.testRemoteFunctionModule({
      ...base,
      inputParameters: { IV_INPUT: "TEST" },
      expectedOutputs: { EV_OUTPUT: "MCP:TEST" },
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true
    }),
    /Output assertion failed for EV_OUTPUT/
  )
})
