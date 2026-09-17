import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { startHttpServer } from "../src/http.js"
import { ToolService } from "../src/tools.js"
import { InvocationReceiptStore } from "../src/invocation-receipts.js"
import { buildRemoteFunctionEnvelope, parseRemoteFunctionResponse } from "../src/adt-backend.js"
import { MockBackend } from "./mock-backend.js"

function record(count: number): Record<string, string> {
  return Object.fromEntries([
    ["MESSAGE", "TEST"],
    ...Array.from({ length: count - 1 }, (_, i) => [`FIELD${i + 1}`, `V${i + 1}`])
  ])
}

function wideBackend(count: number) {
  const backend = new MockBackend()
  const original = backend.callSapDdic.bind(backend)
  backend.callSapDdic = async (id, request) => {
    const result = await original(id, request)
    return request.operation === "READ_STRUCTURE" && request.objectName === "BAPIRET2"
      ? {
          ...result,
          fields: Object.keys(record(count)).map((FIELDNAME) => ({
            FIELDNAME,
            ROLLNAME: "CHAR20",
            COMPTYPE: "E"
          }))
        }
      : result
  }
  return backend
}

const base = {
  connectionId: "w200",
  functionName: "ZCMCP_FM_1801",
  inputParameters: {},
  acknowledgePotentialSideEffects: true as const
}

for (const count of [110, 500]) {
  test(`RFC ${count}-field structure and table row pass metadata, inputs, expected and actual outputs`, async () => {
    const backend = wideBackend(count)
    const tools = new ToolService(backend)
    const metadata = JSON.parse(
      await tools.readFunctionModuleInterface({
        ...base,
        includeExecutionSupport: true
      })
    )
    assert.equal(metadata.executionSupport.supported, true)
    assert.ok(
      metadata.executionSupport.parameters.every(
        (p: { fields: string[] }) => p.fields.length === count
      )
    )
    const row = record(count)
    const result = JSON.parse(
      await tools.testRemoteFunctionModule({
        ...base,
        structureInputs: { IS_REQUEST: row },
        tableInputs: { CT_ITEMS: [row] },
        expectedStructureOutputs: { ES_RESPONSE: { ...row, MESSAGE: "MCP:TEST" } },
        expectedTableOutputs: { CT_ITEMS: [{ ...row, MESSAGE: "ROW:TEST" }] },
        expectedInterfaceFingerprint: metadata.fingerprint
      })
    )
    assert.equal(result.status, "passed")
    assert.deepEqual(result.structureOutputs.ES_RESPONSE, { ...row, MESSAGE: "MCP:TEST" })
    assert.deepEqual(result.tableOutputs.CT_ITEMS, [{ ...row, MESSAGE: "ROW:TEST" }])
    assert.equal(backend.remoteFunctionCalls, 1)
  })
}

test("RFC 110-field allowlisted invocation uses the same expanded limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-wide-rfc-"))
  try {
    const backend = wideBackend(110)
    const tools = new ToolService(backend, undefined, new InvocationReceiptStore(root, "wide-rfc"))
    const metadata = JSON.parse(await tools.readFunctionModuleInterface(base))
    const row = record(110)
    const result = JSON.parse(
      await tools.invokeCustomerFunctionModule({
        ...base,
        requestId: "wide-110",
        expectedInterfaceFingerprint: metadata.fingerprint,
        structureInputs: { IS_REQUEST: row },
        tableInputs: { CT_ITEMS: [row] }
      })
    )
    assert.equal(result.status, "completed")
    assert.deepEqual(result.structureOutputs.ES_RESPONSE, { ...row, MESSAGE: "MCP:TEST" })
    assert.deepEqual(result.tableOutputs.CT_ITEMS, [{ ...row, MESSAGE: "ROW:TEST" }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("RFC rejects 501-field metadata and request/assertion records before invocation", async () => {
  const backend = wideBackend(501)
  const metadata = JSON.parse(
    await new ToolService(backend).readFunctionModuleInterface({
      ...base,
      includeExecutionSupport: true
    })
  )
  assert.equal(metadata.executionSupport.supported, false)
  assert.match(JSON.stringify(metadata.executionSupport), /500 fields/)
  const small = wideBackend(110)
  const tools = new ToolService(small)
  for (const input of [
    { structureInputs: { IS_REQUEST: record(501) } },
    { tableInputs: { CT_ITEMS: [record(501)] } },
    { expectedStructureOutputs: { ES_RESPONSE: record(501) } },
    { expectedTableOutputs: { CT_ITEMS: [record(501)] } }
  ])
    await assert.rejects(tools.testRemoteFunctionModule({ ...base, ...input }), /500 fields/)
  assert.equal(small.remoteFunctionCalls, 0)
  assert.equal(backend.remoteFunctionCalls, 0)
})

test("RFC wider records retain total payload, row, single-value and unknown-field guards", async () => {
  const backend = wideBackend(500)
  const tools = new ToolService(backend)
  const metadata = JSON.parse(await tools.readFunctionModuleInterface(base))
  const guarded = {
    ...base,
    expectedInterfaceFingerprint: metadata.fingerprint,
    expectedStructureOutputs: { ES_RESPONSE: { MESSAGE: "MCP:TEST" } }
  }
  const large = Object.fromEntries(Object.keys(record(500)).map((name) => [name, "X".repeat(4096)]))
  await assert.rejects(
    tools.testRemoteFunctionModule({
      ...guarded,
      structureInputs: { IS_REQUEST: large }
    }),
    /1 MiB/
  )
  await assert.rejects(
    tools.testRemoteFunctionModule({
      ...guarded,
      structureInputs: { IS_REQUEST: { MESSAGE: "X".repeat(4097) } }
    }),
    /4096 characters/
  )
  await assert.rejects(
    tools.testRemoteFunctionModule({
      ...guarded,
      tableInputs: { CT_ITEMS: Array.from({ length: 201 }, () => record(1)) }
    }),
    /200 rows/
  )
  await assert.rejects(
    tools.testRemoteFunctionModule({
      ...guarded,
      structureInputs: { IS_REQUEST: { MESSAGE: "TEST", UNKNOWN: "X" } },
      tableInputs: { CT_ITEMS: [] }
    }),
    /Unknown field/
  )
  assert.equal(backend.remoteFunctionCalls, 0)
})

test("RFC refuses oversized actual output without silently dropping fields", async () => {
  const backend = wideBackend(500)
  backend.callRemoteFunction = async () => ({
    outputs: { ES_RESPONSE: record(501), CT_ITEMS: [] }
  })
  const tools = new ToolService(backend)
  const metadata = JSON.parse(await tools.readFunctionModuleInterface(base))
  await assert.rejects(
    tools.testRemoteFunctionModule({
      ...base,
      expectedInterfaceFingerprint: metadata.fingerprint,
      structureInputs: { IS_REQUEST: record(1) },
      tableInputs: { CT_ITEMS: [] },
      expectedStructureOutputs: { ES_RESPONSE: record(1) }
    }),
    /structureOutputs.ES_RESPONSE must not contain more than 500 fields/
  )
})

test("RFC MCP client can submit a 110-field header and receives every returned field", async () => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-wide-rfc-protocol-"))
  const backend = wideBackend(110)
  const metadata = JSON.parse(await new ToolService(backend).readFunctionModuleInterface(base))
  const running = await startHttpServer(backend, 0, root)
  const client = new Client({ name: "wide-rfc-test", version: "1" })
  try {
    const transport = new StreamableHTTPClientTransport(new URL(running.mcpUrl))
    await client.connect(transport as Parameters<Client["connect"]>[0])
    const row = record(110)
    const result = await client.callTool({
      name: "test_remote_function_module",
      arguments: {
        ...base,
        operationId: "wide-rfc-110",
        expectedInterfaceFingerprint: metadata.fingerprint,
        structureInputs: { IS_REQUEST: row },
        tableInputs: { CT_ITEMS: [row] },
        expectedStructureOutputs: { ES_RESPONSE: { ...row, MESSAGE: "MCP:TEST" } }
      }
    })
    assert.equal(result.isError, undefined, JSON.stringify(result.content))
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0]!.text)
    assert.equal(payload.status, "passed")
    assert.deepEqual(payload.structureOutputs.ES_RESPONSE, { ...row, MESSAGE: "MCP:TEST" })
    assert.deepEqual(payload.tableOutputs.CT_ITEMS, [{ ...row, MESSAGE: "ROW:TEST" }])
    assert.equal(backend.remoteFunctionCalls, 1)
  } finally {
    await client.close()
    await running.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("RFC SOAP preserves all 110 structure and table fields including the last field", () => {
  const row = record(110)
  const fields = Object.keys(row)
  const shapes = [
    { name: "ES_RESPONSE", kind: "structure" as const, fields },
    { name: "CT_ITEMS", kind: "table" as const, fields }
  ]
  const xml = buildRemoteFunctionEnvelope({
    functionName: base.functionName,
    inputParameters: { IS_REQUEST: row, CT_ITEMS: [row] },
    outputParameters: shapes
  })
  assert.equal((xml.match(/<FIELD109>V109<\/FIELD109>/g) ?? []).length, 2)
  const content = Object.entries(row)
    .map(([key, value]) => `<${key}>${value}</${key}>`)
    .join("")
  const response = parseRemoteFunctionResponse(
    `<Envelope><Body><ZCMCP_FM_1801.Response><ES_RESPONSE>${content}</ES_RESPONSE><CT_ITEMS><item>${content}</item></CT_ITEMS></ZCMCP_FM_1801.Response></Body></Envelope>`,
    shapes
  )
  assert.deepEqual(response.outputs, { ES_RESPONSE: row, CT_ITEMS: [row] })
})
