import assert from "node:assert/strict"
import test from "node:test"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"

type Parameter = {
  name: string
  typeName: string
  direction: string
  kind: string
  maxCharacters?: number
  valueContract: unknown
  supported: boolean
}

function trackedBackend() {
  const backend = new MockBackend()
  const queries: string[] = []
  const operations: string[] = []
  const originalRunQuery = backend.runQuery.bind(backend)
  const originalDdic = backend.callSapDdic.bind(backend)
  backend.runQuery = async (connectionId, sql) => {
    queries.push(sql)
    return originalRunQuery(connectionId, sql)
  }
  backend.callSapDdic = async (connectionId, request) => {
    operations.push(`${request.operation}:${request.objectName}`)
    return originalDdic(connectionId, request)
  }
  return { backend, queries, operations }
}

test("a domain-less data element resolves from its own DD04L scalar type", async () => {
  const { backend, queries, operations } = trackedBackend()
  const metadata = JSON.parse(
    await new ToolService(backend).readFunctionModuleInterface({
      connectionId: "w200",
      functionName: "ZCMCP_FM_STRINGVAL",
      includeExecutionSupport: true
    })
  ) as { executionSupport: { supported: boolean; reasons: string[]; parameters: Parameter[] } }

  assert.equal(
    metadata.executionSupport.supported,
    true,
    JSON.stringify(metadata.executionSupport.reasons)
  )
  assert.deepEqual(
    metadata.executionSupport.parameters.map((parameter) => ({
      name: parameter.name,
      direction: parameter.direction,
      kind: parameter.kind,
      maxCharacters: parameter.maxCharacters,
      valueContract: parameter.valueContract
    })),
    [
      {
        name: "IV_INPUT",
        direction: "import",
        kind: "scalar",
        maxCharacters: undefined,
        // STRG is variable length: LENG 000000 must not become a fixed width.
        valueContract: { dataType: "STRG" }
      },
      {
        name: "EV_RESULT",
        direction: "export",
        kind: "scalar",
        maxCharacters: undefined,
        valueContract: { dataType: "STRG" }
      }
    ]
  )
  // One DD04L read resolves the shared element for both parameters.
  assert.deepEqual(queries, [
    "SELECT ROLLNAME, DOMNAME, DATATYPE, LENG, DECIMALS FROM DD04L " +
      "WHERE ROLLNAME = 'STRINGVAL' AND AS4LOCAL = 'A'"
  ])
  assert.ok(operations.includes("READ_DATA_ELEMENT:STRINGVAL"))
  assert.ok(operations.includes("READ_TRANSPARENT_TABLE:DD04L"))
})

test("a domain-bearing data element still resolves through its domain header", async () => {
  const { backend, queries, operations } = trackedBackend()
  const metadata = JSON.parse(
    await new ToolService(backend).readFunctionModuleInterface({
      connectionId: "w200",
      functionName: "ZCMCP_FM_1501",
      includeExecutionSupport: true
    })
  ) as { executionSupport: { supported: boolean; reasons: string[]; parameters: Parameter[] } }

  assert.equal(
    metadata.executionSupport.supported,
    true,
    JSON.stringify(metadata.executionSupport.reasons)
  )
  assert.deepEqual(
    metadata.executionSupport.parameters.map((parameter) => ({
      name: parameter.name,
      maxCharacters: parameter.maxCharacters,
      valueContract: parameter.valueContract
    })),
    [
      { name: "IV_INPUT", maxCharacters: 20, valueContract: { dataType: "CHAR", length: 20 } },
      { name: "EV_OUTPUT", maxCharacters: 40, valueContract: { dataType: "CHAR", length: 40 } }
    ]
  )
  assert.ok(operations.includes("READ_DOMAIN:CHAR20"))
  // A domain-bearing element never pays for the DD04L fallback.
  assert.deepEqual(queries, [])
  assert.equal(
    operations.some((entry) => entry.includes("DD04L")),
    false
  )
})

test("an element whose active DD04L row is missing still fails closed", async () => {
  const metadata = JSON.parse(
    await new ToolService(new MockBackend()).readFunctionModuleInterface({
      connectionId: "w200",
      functionName: "ZCMCP_FM_UNTYPED",
      includeExecutionSupport: true
    })
  ) as { executionSupport: { supported: boolean; reasons: string[]; parameters: Parameter[] } }

  assert.equal(metadata.executionSupport.supported, false)
  assert.deepEqual(metadata.executionSupport.reasons, [
    "IV_INPUT: Unverified RFC scalar type for ZCMCP_UNTYPED"
  ])
  assert.equal(metadata.executionSupport.parameters[0]?.supported, false)
})

test("a DD04L read that cannot be verified keeps the element unverified", async () => {
  const backend = new MockBackend()
  backend.runQuery = async () => {
    // The observed native data-preview failure; the fallback reader is unverifiable in the
    // mock, so the element must stay unresolved rather than be accepted.
    throw new Error(
      "SAP_DATA_QUERY_RESPONSE_INVALID: expected XML data preview; HTTP 200; " +
        "mediaType=text/html; root=unparsed; bytes=0. No empty result was inferred."
    )
  }
  const metadata = JSON.parse(
    await new ToolService(backend).readFunctionModuleInterface({
      connectionId: "w200",
      functionName: "ZCMCP_FM_STRINGVAL",
      includeExecutionSupport: true
    })
  ) as { executionSupport: { supported: boolean; reasons: string[] } }

  assert.equal(metadata.executionSupport.supported, false)
  assert.deepEqual(metadata.executionSupport.reasons, [
    "IV_INPUT: Unverified RFC scalar type for STRINGVAL",
    "EV_RESULT: Unverified RFC scalar type for STRINGVAL"
  ])
})
