import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { readAbapTable } from "../src/table-query.js"
import { parseSapDataQueryResponse } from "../src/data-query.js"
import type { RemoteFunctionRequest, RemoteFunctionResult, SapBackend } from "../src/backend.js"
import { startHttpServer } from "../src/http.js"
import { MockBackend } from "./mock-backend.js"
import { AdtBackend } from "../src/adt-backend.js"
import { listenOnUnblockedPort } from "./loopback-port.js"

const input = { connectionId: "w200", tableName: "TFDIR", columns: ["ID", "TEXT"], maxRows: 1 }
const definition = {
  objectKind: "transparentTable",
  objectName: "TFDIR",
  fingerprint: "a".repeat(64),
  definition: { tableClass: "TRANSP", fields: [{ name: "ID", key: true }, { name: "TEXT" }] }
}
const reader = {
  functionName: "RFC_READ_TABLE",
  remoteEnabled: true,
  updateTask: false,
  sourceFingerprint: "7b9a603493673d26f75e555616b24d150e407ce03eff57e9c68f0b30b1ba0c2d",
  interfaceFingerprint: "d06cc5c1ce05960bde526ecf27e38606134146474cc8da19f93ac2abd3e48074"
}
const alignedReader = {
  functionName: "BBP_RFC_READ_TABLE",
  remoteEnabled: true,
  updateTask: false,
  sourceFingerprint: "e08069939315d594527fe58fc1a52e32e583d0987bc173295ddb816be9051b94",
  interfaceFingerprint: "d85d035301f09d00229fa830e7c4cd7c63c8a167055d53bb62ddebb44d17743a"
}
let emptyHtml: unknown
try {
  parseSapDataQueryResponse({ body: "", status: 200, headers: { "content-type": "text/html" } })
} catch (error) {
  emptyHtml = error
}

const collect = (
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  request: unknown = input,
  ddic: unknown = definition,
  fm: unknown = reader
) =>
  readAbapTable(
    request,
    backend,
    async () => ddic,
    async () => fm
  )

function fixture(
  change: (result: RemoteFunctionResult, request: RemoteFunctionRequest) => RemoteFunctionResult = (
    result
  ) => result
) {
  const requests: RemoteFunctionRequest[] = []
  return {
    requests,
    runQuery: async () => {
      throw emptyHtml
    },
    callRemoteFunction: async (_connection: string, request: RemoteFunctionRequest) => {
      requests.push(request)
      const columns = (request.inputParameters.FIELDS as { FIELDNAME: string }[]).map(
        (field) => field.FIELDNAME
      )
      let offset = 0
      const fields = columns.map((FIELDNAME) => {
        const length = FIELDNAME === "ID" ? 4 : 40
        const value = { FIELDNAME, TYPE: "C", LENGTH: String(length), OFFSET: String(offset) }
        offset += length + 1
        return value
      })
      return change(
        {
          outputs: {
            FIELDS: fields,
            DATA:
              request.inputParameters.NO_DATA === "X"
                ? []
                : [
                    { WA: columns.map((column) => (column === "ID" ? "0001" : "Alpha")).join("|") },
                    { WA: columns.map((column) => (column === "ID" ? "0002" : "Beta")).join("|") }
                  ]
          }
        },
        request
      )
    }
  }
}

test("table query compiles structured filters, preserves native values and detects truncation", async () => {
  const result = await collect(
    {
      runQuery: async (connection, sql, limit, options) => {
        assert.deepEqual(options, { allowScopedFallback: false })
        assert.equal(connection, "w200")
        assert.equal(sql, "SELECT ID, TEXT FROM TFDIR WHERE TEXT = 'O''Brien' AND ID >= '0001'")
        assert.equal(limit, 2)
        return [
          { ID: "0001", TEXT: "O'Brien" },
          { ID: "0002", TEXT: "O'Brien" }
        ]
      },
      callRemoteFunction: async () => assert.fail("unexpected RFC")
    },
    {
      ...input,
      filters: [
        { column: "TEXT", operator: "EQ", value: "O'Brien" },
        { column: "ID", operator: "GE", value: "0001" }
      ]
    }
  )
  assert.equal(result.status, "ok")
  assert.equal(result.method, "adt_query")
  assert.equal(result.truncated, true)
  assert.deepEqual(result.data, [{ ID: "0001", TEXT: "O'Brien" }])
  assert.equal(result.order, "unspecified")
  assert.equal(result.snapshot, false)
  assert.equal(result.definitionFingerprint, definition.fingerprint)
})

test("table query rejects unsafe or unbounded inputs before SAP access", async () => {
  for (const patch of [
    { tableName: "T000 WHERE 1=1" },
    { columns: [] },
    { columns: ["*", "ID"] },
    { columns: ["ID", "id"] },
    { columns: Array.from({ length: 1025 }, (_, i) => `F${i}`) },
    { maxRows: 0 },
    { maxRows: 501 },
    { maxRows: 1.5 },
    { sql: "DELETE FROM T000" },
    { rowSkips: 1 },
    { client: "000" },
    { sort: "ID" },
    { filters: [{ column: "ID OR 1=1", operator: "EQ", value: "x" }] },
    { filters: [{ column: "ID", operator: "LIKE", value: "%" }] },
    { filters: [{ column: "ID", operator: "EQ", value: "x\nOR 1=1" }] },
    { filters: [{ column: "ID", operator: "EQ", value: "'".repeat(40) }] },
    { filters: Array(9).fill({ column: "ID", operator: "EQ", value: "1" }) }
  ]) {
    await assert.rejects(
      readAbapTable(
        { ...input, ...patch },
        {
          runQuery: async () => assert.fail("unexpected native call"),
          callRemoteFunction: async () => assert.fail("unexpected RFC")
        },
        async () => assert.fail("unexpected DDIC"),
        async () => assert.fail("unexpected reader")
      ),
      /TABLE_QUERY_/
    )
  }
})

test("table query checks actual transparent table and field definitions before data access", async () => {
  for (const ddic of [
    null,
    { ...definition, objectName: "OTHER" },
    { ...definition, objectKind: "structure" },
    { ...definition, definition: { ...definition.definition, tableClass: "VIEW" } },
    { ...definition, definition: { ...definition.definition, fields: [{ name: "ID" }] } },
    {
      ...definition,
      definition: { ...definition.definition, fields: [{ name: "ID" }, { name: "ID" }] }
    }
  ]) {
    const backend = fixture()
    backend.runQuery = async () => assert.fail("unexpected native query")
    const result = await collect(backend, input, ddic)
    assert.equal(result.status, "unavailable")
    assert.equal(result.data, null)
    assert.equal(backend.requests.length, 0)
  }
})

test("a rejected projection names the offending columns and the real one (17:10 incident)", async () => {
  // DD02L really has no DDLANGUAGE (it is in DD02V). The caller could not tell that from the bare
  // TABLE_QUERY_FIELD_INVALID it received, so the reply must carry the evidence itself.
  const backend = fixture()
  backend.runQuery = async () => assert.fail("unexpected native query")
  const result = (await collect(
    backend,
    { ...input, columns: ["ID", "DDLANGUAGE"], filters: [] },
    definition
  )) as {
    status: string
    code: string
    invalidColumns?: string[]
    validColumns?: string[]
    validColumnCount?: number
    data: null
    definitionFingerprint?: string
  }
  assert.equal(result.status, "unavailable")
  assert.equal(result.code, "TABLE_QUERY_FIELD_INVALID")
  assert.deepEqual(result.invalidColumns, ["DDLANGUAGE"])
  assert.deepEqual(result.validColumns, ["ID", "TEXT"])
  assert.equal(result.validColumnCount, 2)
  assert.equal(result.data, null)
  assert.match(result.definitionFingerprint ?? "", /^[a-f0-9]{64}$/)
  assert.equal(backend.requests.length, 0)

  // A filter column is part of the projection contract too, and is reported the same way.
  const filtered = (await collect(
    backend,
    { ...input, columns: ["ID"], filters: [{ column: "MANDT", operator: "EQ", value: "200" }] },
    definition
  )) as { code: string; invalidColumns?: string[] }
  assert.equal(filtered.code, "TABLE_QUERY_FIELD_INVALID")
  assert.deepEqual(filtered.invalidColumns, ["MANDT"])
})

test("a dictionary read without a usable projection is not blamed on the caller", async () => {
  const backend = fixture()
  backend.runQuery = async () => assert.fail("unexpected native query")
  // Only include markers: the field list parses, but no addressable column remains.
  const result = (await collect(backend, input, {
    ...definition,
    definition: { ...definition.definition, fields: [{ name: ".INCLUDE" }] }
  })) as { status: string; code: string; definitionFieldCount?: number; invalidColumns?: string[] }
  assert.equal(result.status, "unavailable")
  assert.equal(result.code, "TABLE_QUERY_DEFINITION_INCOMPLETE")
  assert.equal(result.definitionFieldCount, 0)
  assert.equal(result.invalidColumns, undefined)
  assert.equal(backend.requests.length, 0)

  // Duplicate names in the definition are also a dictionary problem, not a bad request.
  const duplicated = (await collect(backend, input, {
    ...definition,
    definition: { ...definition.definition, fields: [{ name: "ID" }, { name: "ID" }] }
  })) as { code: string; definitionFieldCount?: number }
  assert.equal(duplicated.code, "TABLE_QUERY_DEFINITION_INCOMPLETE")
  assert.equal(duplicated.definitionFieldCount, 2)
})

test("table query preserves genuine empty results and never falls back on arbitrary native failure", async () => {
  for (const error of [
    null,
    new Error("HTTP 403 SECRET"),
    new Error("HTTP 404"),
    new Error("SAP_DATA_QUERY_RESPONSE_INVALID: nonempty HTML"),
    new Error("TABLE_QUERY_SECRET")
  ]) {
    const result = await collect({
      runQuery: async () => {
        if (error) throw error
        return []
      },
      callRemoteFunction: async () => assert.fail("unexpected fallback")
    })
    assert.equal(result.status, error ? "unavailable" : "ok")
    assert.deepEqual(result.data, error ? null : [])
    assert.equal(result.truncated, error ? null : false)
    assert.doesNotMatch(JSON.stringify(result), /SECRET/)
  }
})

test("table query verifies the reader and complete layout before bounded legacy data read", async () => {
  const backend = fixture()
  const result = await collect(backend, {
    ...input,
    columns: ["TEXT", "ID"],
    filters: [{ column: "ID", operator: "GE", value: "0001" }]
  })
  assert.equal(result.status, "ok")
  assert.equal(result.method, "rfc_read_table")
  assert.equal(result.nativeCode, "SAP_DATA_QUERY_RESPONSE_INVALID")
  assert.equal(result.truncated, true)
  assert.deepEqual(result.data, [{ TEXT: "Alpha", ID: "0001" }])
  assert.equal(backend.requests.length, 2)
  const [layout, data] = backend.requests
  assert.equal(layout!.functionName, "RFC_READ_TABLE")
  assert.equal(layout!.inputParameters.NO_DATA, "X")
  assert.deepEqual(layout!.inputParameters.OPTIONS, [])
  assert.deepEqual(layout!.inputParameters.FIELDS, [{ FIELDNAME: "ID" }, { FIELDNAME: "TEXT" }])
  assert.equal(data!.inputParameters.ROWCOUNT, "2")
  assert.equal(data!.inputParameters.ROWSKIPS, "0")
  assert.equal(data!.inputParameters.NO_DATA, "")
  assert.deepEqual(data!.inputParameters.OPTIONS, [{ TEXT: "ID >= '0001'" }])
})

test("table query uses verified RFC metadata when the ADT dictionary endpoint is unavailable", async () => {
  const requests: RemoteFunctionRequest[] = []
  const fullLayout = [
    { FIELDNAME: "MANDT", TYPE: "C", LENGTH: "3", OFFSET: "0" },
    { FIELDNAME: "IMP_NAME", TYPE: "C", LENGTH: "20", OFFSET: "3" },
    { FIELDNAME: "IMP_CLASS", TYPE: "C", LENGTH: "30", OFFSET: "23" }
  ]
  const result = await readAbapTable(
    {
      connectionId: "w200",
      tableName: "SXCI",
      columns: ["IMP_NAME", "IMP_CLASS"],
      filters: [{ column: "MANDT", operator: "EQ", value: "200" }],
      maxRows: 1
    },
    {
      runQuery: async () => assert.fail("unexpected native query"),
      callRemoteFunction: async (_connectionId, request) => {
        requests.push(request)
        const columns = (request.inputParameters.FIELDS as { FIELDNAME: string }[]).map(
          (field) => field.FIELDNAME
        )
        if (request.inputParameters.NO_DATA === "X") {
          return { outputs: { FIELDS: fullLayout, DATA: [] } }
        }
        assert.deepEqual(columns, ["IMP_NAME", "IMP_CLASS"])
        return {
          outputs: {
            FIELDS: [
              { FIELDNAME: "IMP_NAME", TYPE: "C", LENGTH: "20", OFFSET: "0" },
              { FIELDNAME: "IMP_CLASS", TYPE: "C", LENGTH: "30", OFFSET: "21" }
            ],
            DATA: [{ WA: "ZVL02N_IMPL|ZCL_VL02N_IMPL" }, { WA: "ZOTHER_IMPL|ZCL_OTHER_IMPL" }]
          }
        }
      }
    },
    async () => {
      throw new Error("HTTP 500 dictionary unavailable")
    },
    async () => reader
  )

  assert.equal(result.status, "ok")
  assert.equal(result.method, "rfc_read_table")
  assert.equal("definitionSource" in result ? result.definitionSource : null, "rfc_metadata")
  assert.equal("tableClassVerified" in result ? result.tableClassVerified : null, false)
  assert.equal(result.nativeCode, "DDIC_METADATA_UNAVAILABLE")
  assert.match(result.definitionFingerprint ?? "", /^[a-f0-9]{64}$/)
  assert.equal(result.truncated, true)
  assert.deepEqual(result.data, [{ IMP_NAME: "ZVL02N_IMPL", IMP_CLASS: "ZCL_VL02N_IMPL" }])
  assert.equal(requests.length, 3)
  assert.deepEqual(requests[0]!.inputParameters.FIELDS, [])
  assert.deepEqual(requests[1]!.inputParameters.OPTIONS, [{ TEXT: "MANDT = '200'" }])
  assert.deepEqual(requests[2]!.inputParameters.FIELDS, [])
})

test("table query reports a confirmed missing DDIC table without trying RFC readers", async () => {
  let remoteCalls = 0
  let readerCalls = 0
  const result = await readAbapTable(
    {
      connectionId: "w200",
      tableName: "SXCI",
      columns: ["*"],
      maxRows: 1
    },
    {
      runQuery: async () => assert.fail("unexpected native query"),
      callRemoteFunction: async () => {
        remoteCalls++
        return { outputs: {} }
      }
    },
    async () => {
      throw new Error(
        "SAP DDIC helper rejected the operation: DDIC_OBJECT_NOT_FOUND: DDIC object does not exist"
      )
    },
    async () => {
      readerCalls++
      return reader
    }
  )

  assert.equal(result.status, "unavailable")
  assert.equal("stage" in result ? result.stage : null, "dictionary")
  assert.equal("code" in result ? result.code : null, "TABLE_QUERY_TABLE_NOT_FOUND")
  assert.equal(result.returnedCount, 0)
  assert.equal(result.data, null)
  assert.equal(remoteCalls, 0)
  assert.equal(readerCalls, 0)
})

test("dictionary-unavailable fallback uses the verified aligned reader after legacy metadata overflow", async () => {
  const requests: RemoteFunctionRequest[] = []
  const readers: string[] = []
  const fullLayout = [
    { FIELDNAME: "MANDT", TYPE: "C", LENGTH: "3", OFFSET: "0" },
    { FIELDNAME: "IMP_NAME", TYPE: "C", LENGTH: "20", OFFSET: "3" },
    { FIELDNAME: "IMP_CLASS", TYPE: "C", LENGTH: "30", OFFSET: "23" },
    { FIELDNAME: "LONG_TEXT", TYPE: "C", LENGTH: "600", OFFSET: "53" }
  ]
  const result = await readAbapTable(
    {
      connectionId: "w200",
      tableName: "SXCI",
      columns: ["IMP_NAME", "IMP_CLASS"],
      filters: [{ column: "MANDT", operator: "EQ", value: "200" }],
      maxRows: 1
    },
    {
      runQuery: async () => assert.fail("unexpected native query"),
      callRemoteFunction: async (_connectionId, request) => {
        requests.push(request)
        if (request.functionName === "RFC_READ_TABLE") {
          return {
            outputs: {},
            fault: {
              code: "SOAP-ENV:Server",
              name: "DATA_BUFFER_EXCEEDED",
              message: "must not be exposed"
            }
          }
        }
        const columns = (request.inputParameters.FIELDS as { FIELDNAME: string }[]).map(
          (field) => field.FIELDNAME
        )
        if (request.inputParameters.NO_DATA === "X") {
          return { outputs: { FIELDS: fullLayout, DATA: [] } }
        }
        assert.deepEqual(columns, ["IMP_NAME", "IMP_CLASS"])
        return {
          outputs: {
            FIELDS: [
              { FIELDNAME: "IMP_NAME", TYPE: "C", LENGTH: "20", OFFSET: "0" },
              { FIELDNAME: "IMP_CLASS", TYPE: "C", LENGTH: "30", OFFSET: "21" }
            ],
            DATA: [{ WA: "ZVL02N_IMPL|ZCL_VL02N_IMPL" }]
          }
        }
      }
    },
    async () => {
      throw new Error("HTTP 500 dictionary unavailable")
    },
    async (_connectionId, functionName) => {
      readers.push(functionName)
      return functionName === "RFC_READ_TABLE" ? reader : alignedReader
    }
  )

  assert.equal(result.status, "ok")
  assert.equal(result.method, "bbp_rfc_read_table")
  assert.equal(
    "readerFallbackCode" in result ? result.readerFallbackCode : null,
    "DATA_BUFFER_EXCEEDED"
  )
  assert.deepEqual(result.data, [{ IMP_NAME: "ZVL02N_IMPL", IMP_CLASS: "ZCL_VL02N_IMPL" }])
  assert.deepEqual(readers, ["RFC_READ_TABLE", "BBP_RFC_READ_TABLE"])
  assert.deepEqual(
    requests.map((request) => [request.functionName, request.inputParameters.NO_DATA]),
    [
      ["RFC_READ_TABLE", "X"],
      ["BBP_RFC_READ_TABLE", "X"],
      ["BBP_RFC_READ_TABLE", ""],
      ["BBP_RFC_READ_TABLE", "X"]
    ]
  )
  assert.doesNotMatch(JSON.stringify(result), /must not be exposed/)
})

test("dictionary-unavailable fallback uses the verified aligned reader after legacy metadata failure", async () => {
  const requests: RemoteFunctionRequest[] = []
  const result = await readAbapTable(
    input,
    {
      runQuery: async () => assert.fail("unexpected native query"),
      callRemoteFunction: async (_connectionId, request) => {
        requests.push(request)
        if (request.functionName === "RFC_READ_TABLE") {
          return {
            outputs: {},
            fault: {
              code: "SOAP-ENV:Server",
              name: "TABLE_NOT_AVAILABLE",
              message: "must not be exposed"
            }
          }
        }
        const noData = request.inputParameters.NO_DATA === "X"
        return {
          outputs: {
            FIELDS: [
              { FIELDNAME: "ID", TYPE: "C", LENGTH: "4", OFFSET: "0" },
              { FIELDNAME: "TEXT", TYPE: "C", LENGTH: "40", OFFSET: noData ? "4" : "5" }
            ],
            DATA: noData ? [] : [{ WA: "0001|Alpha" }]
          }
        }
      }
    },
    async () => {
      throw new Error("HTTP 500 dictionary unavailable")
    },
    async (_connectionId, functionName) =>
      functionName === "RFC_READ_TABLE" ? reader : alignedReader
  )

  assert.equal(result.status, "ok")
  assert.equal(result.method, "bbp_rfc_read_table")
  assert.equal(
    "readerFallbackCode" in result ? result.readerFallbackCode : null,
    "DDIC_METADATA_UNAVAILABLE"
  )
  assert.deepEqual(result.data, [{ ID: "0001", TEXT: "Alpha" }])
  assert.deepEqual(
    requests.map((request) => [request.functionName, request.inputParameters.NO_DATA]),
    [
      ["RFC_READ_TABLE", "X"],
      ["BBP_RFC_READ_TABLE", "X"],
      ["BBP_RFC_READ_TABLE", ""],
      ["BBP_RFC_READ_TABLE", "X"]
    ]
  )
  assert.doesNotMatch(JSON.stringify(result), /must not be exposed/)
})

test("dictionary-unavailable fallback stops after one aligned metadata failure", async () => {
  const readers: string[] = []
  let calls = 0
  const result = await readAbapTable(
    input,
    {
      runQuery: async () => assert.fail("unexpected native query"),
      callRemoteFunction: async () => {
        calls++
        return {
          outputs: {},
          fault: { code: "SOAP-ENV:Server", name: "TABLE_NOT_AVAILABLE", message: "SECRET" }
        }
      }
    },
    async () => {
      throw new Error("HTTP 500 dictionary unavailable")
    },
    async (_connectionId, functionName) => {
      readers.push(functionName)
      return functionName === "RFC_READ_TABLE" ? reader : alignedReader
    }
  )

  assert.equal(result.status, "unavailable")
  assert.equal("code" in result ? result.code : null, "TABLE_QUERY_RFC_FAILED")
  assert.equal(calls, 2)
  assert.deepEqual(readers, ["RFC_READ_TABLE", "BBP_RFC_READ_TABLE"])
  assert.doesNotMatch(JSON.stringify(result), /SECRET/)
})

test("dictionary-unavailable fallback rejects wildcard and non-character projections", async () => {
  for (const request of [
    { ...input, columns: ["*"] },
    { ...input, columns: ["ID"] }
  ]) {
    let calls = 0
    const result = await readAbapTable(
      request,
      {
        runQuery: async () => assert.fail("unexpected native query"),
        callRemoteFunction: async () => {
          calls++
          return {
            outputs: {
              FIELDS: [{ FIELDNAME: "ID", TYPE: "P", LENGTH: "8", OFFSET: "0" }],
              DATA: []
            }
          }
        }
      },
      async () => {
        throw new Error("HTTP 500 dictionary unavailable")
      },
      async () => reader
    )
    assert.equal(result.status, "unavailable")
    assert.equal(
      "code" in result ? result.code : null,
      "TABLE_QUERY_DICTIONARY_FALLBACK_UNSUPPORTED"
    )
    assert.equal(calls, request.columns[0] === "*" ? 0 : 1)
  }
})

test("table query rejects definition drift and reader failure without RFC execution", async () => {
  for (const patch of [
    { sourceFingerprint: "b".repeat(64) },
    { interfaceFingerprint: "b".repeat(64) },
    { remoteEnabled: false },
    { updateTask: true },
    { functionName: "OTHER" }
  ]) {
    const backend = fixture()
    const result = await collect(backend, input, definition, { ...reader, ...patch })
    assert.equal(result.status, "unavailable")
    assert.equal(backend.requests.length, 0)
  }
  const backend = fixture()
  const result = await readAbapTable(
    input,
    backend,
    async () => definition,
    async () => {
      throw new Error("SECRET")
    }
  )
  assert.equal(result.status, "unavailable")
  assert.equal(backend.requests.length, 0)
  assert.doesNotMatch(JSON.stringify(result), /SECRET/)
})

test("table query rejects unsupported whole-row layouts even when only a safe column is projected", async () => {
  for (const patch of [
    { TYPE: "F" },
    { TYPE: "P" },
    { TYPE: "g" },
    { LENGTH: "8001" },
    { LENGTH: "0" }
  ]) {
    const backend = fixture((response) => {
      Object.assign((response.outputs.FIELDS as object[])[1]!, patch)
      return response
    })
    const result = await collect(backend, { ...input, columns: ["ID"] })
    assert.equal(result.status, "unavailable")
    assert.equal(backend.requests.length, 1)
    assert.ok(backend.requests.every((request) => request.inputParameters.NO_DATA === "X"))
  }
})

test("table query refuses a single field beyond TAB512 before data read", async () => {
  const backend = fixture((response) => {
    Object.assign((response.outputs.FIELDS as object[])[1]!, { LENGTH: "513" })
    return response
  })
  const result = await collect(backend)
  assert.equal(result.status, "unavailable")
  assert.equal("code" in result && result.code, "TABLE_QUERY_ROW_TOO_WIDE")
  assert.equal(backend.requests.length, 1)
})

test("table query rejects malformed layout, data in metadata and authorization faults", async () => {
  for (const mode of ["missing", "wrongField", "wrongOrder", "metadataData", "fault"]) {
    const backend = fixture((response) => {
      if (mode === "missing") delete response.outputs.FIELDS
      if (mode === "wrongField")
        (response.outputs.FIELDS as { FIELDNAME: string }[])[0]!.FIELDNAME = "WRONG"
      if (mode === "wrongOrder") (response.outputs.FIELDS as object[]).reverse()
      if (mode === "metadataData") response.outputs.DATA = [{ WA: "unexpected" }]
      if (mode === "fault")
        return { outputs: {}, fault: { code: "SOAP", name: "NOT_AUTHORIZED", message: "SECRET" } }
      return response
    })
    const result = await collect(backend)
    assert.equal(result.status, "unavailable")
    assert.equal(backend.requests.length, 1)
    assert.doesNotMatch(JSON.stringify(result), /SECRET/)
  }
})

test("table query rejects data schema drift, delimiter collisions, oversized and excess rows", async () => {
  for (const mode of [
    "length",
    "type",
    "offset",
    "delimiter",
    "longCell",
    "extraRows",
    "missingData"
  ]) {
    const backend = fixture((response, request) => {
      if (request.inputParameters.NO_DATA === "X") return response
      const field = (response.outputs.FIELDS as Record<string, string>[])[0]!
      if (mode === "length") field.LENGTH = "5"
      if (mode === "type") field.TYPE = "N"
      if (mode === "offset") field.OFFSET = "1"
      if (mode === "delimiter") response.outputs.DATA = [{ WA: "0001|a|b" }]
      if (mode === "longCell") response.outputs.DATA = [{ WA: "00011|Alpha" }]
      if (mode === "extraRows") response.outputs.DATA = Array(3).fill({ WA: "0001|Alpha" })
      if (mode === "missingData") delete response.outputs.DATA
      return response
    })
    const result = await collect(backend)
    assert.equal(result.status, "unavailable", mode)
    assert.equal(result.data, null)
  }
})

test("table query supports native numeric/date values and rejects missing, extra or non-scalar cells", async () => {
  for (const rows of [
    [{ ID: 1.5, TEXT: new Date("2026-09-08T00:00:00Z") }],
    [{ ID: "0001" }],
    [{ ID: "0001", TEXT: "a", SECRET: "x" }],
    [{ ID: NaN, TEXT: "a" }],
    [{ ID: "0001", TEXT: {} }]
  ]) {
    const result = await collect({
      runQuery: async () => rows,
      callRemoteFunction: async () => assert.fail("unexpected RFC")
    })
    assert.equal(
      result.status,
      typeof rows[0]!.ID === "number" && Number.isFinite(rows[0]!.ID) ? "ok" : "unavailable"
    )
    assert.doesNotMatch(JSON.stringify(result), /SECRET/)
  }
})

test("table query distinguishes legacy empty data and initial text from failures", async () => {
  for (const rows of [[], [{ WA: "    |    " }]]) {
    const result = await collect(
      fixture((response, request) => {
        if (request.inputParameters.NO_DATA !== "X") response.outputs.DATA = rows
        return response
      })
    )
    assert.equal(result.status, "ok")
    assert.equal(result.truncated, false)
    assert.deepEqual(result.data, rows.length ? [{ ID: "", TEXT: "" }] : [])
  }
})

test("table query is callable through the real local MCP transport and rejects unsafe requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "abap-table-query-"))
  const backend = new MockBackend()
  backend.runQuery = async () => [{ MANDT: "200", MTEXT: "Development" }]
  const running = await startHttpServer(backend, 0, root)
  const client = new Client({ name: "table-query-test", version: "1" })
  try {
    const transport = new StreamableHTTPClientTransport(new URL(running.mcpUrl))
    await client.connect(transport as Parameters<Client["connect"]>[0])
    const response = await client.callTool({
      name: "read_abap_table",
      arguments: {
        connectionId: "w200",
        tableName: "T000",
        columns: ["MANDT", "MTEXT"],
        maxRows: 1
      }
    })
    assert.ok(!response.isError)
    const text = (response.content as { type: string; text?: string }[])[0]!.text!
    const result = JSON.parse(text)
    assert.equal(result.status, "ok")
    assert.deepEqual(result.data, [{ MANDT: "200", MTEXT: "Development" }])
    const invalid = await client.callTool({
      name: "read_abap_table",
      arguments: {
        connectionId: "w200",
        tableName: "T000; DELETE",
        columns: ["MANDT"]
      }
    })
    assert.equal(invalid.isError, true)
  } finally {
    await client.close()
    await running.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("table query legacy path uses actual HTTP and SOAP parsing for metadata and padded Unicode rows", async (t) => {
  let reads = 0
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost")
    if (url.pathname === "/sap/bc/adt/datapreview/freestyle") {
      response.writeHead(200, { "Content-Type": "text/html" })
      response.end("")
    } else if (url.pathname === "/sap/bc/soap/rfc") {
      reads++
      let body = ""
      for await (const chunk of request) body += chunk.toString()
      assert.match(body, /RFC_READ_TABLE/)
      assert.match(body, /<QUERY_TABLE>TFDIR<\/QUERY_TABLE>/)
      const noData = /<NO_DATA>X<\/NO_DATA>/.test(body)
      assert.equal(noData, reads === 1)
      assert.match(body, noData ? /<ROWCOUNT>1<\/ROWCOUNT>/ : /<ROWCOUNT>2<\/ROWCOUNT>/)
      assert.match(body, /<ROWSKIPS>0<\/ROWSKIPS>/)
      const metadata = [
        { FIELDNAME: "ID", TYPE: "C", LENGTH: "000004", OFFSET: "000000" },
        { FIELDNAME: "TEXT", TYPE: "C", LENGTH: "000040", OFFSET: "000005" }
      ]
        .map(
          (field) =>
            `<item>${Object.entries(field)
              .map(([name, value]) => `<${name}>${value}</${name}>`)
              .join("")}</item>`
        )
        .join("")
      const data = noData ? "" : "<item><WA>0001|\u4e2d\u6587\u6837\u672c       </WA></item>"
      response.writeHead(200, { "Content-Type": "text/xml" })
      response.end(
        `<Envelope><Body><RFC_READ_TABLE.Response><FIELDS>${metadata}</FIELDS><DATA>${data}</DATA></RFC_READ_TABLE.Response></Body></Envelope>`
      )
    } else {
      response.writeHead(200, { "Content-Type": "application/xml", "x-csrf-token": "test-only" })
      response.end("<graph/>")
    }
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
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  })
  const result = await collect(backend)
  assert.equal(result.status, "ok")
  assert.equal(result.method, "rfc_read_table")
  assert.equal(reads, 2)
  assert.deepEqual(result.data, [{ ID: "0001", TEXT: "\u4e2d\u6587\u6837\u672c" }])
})
