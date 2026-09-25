import assert from "node:assert/strict"
import test from "node:test"
import { collectSystemInfo } from "../src/system-info.js"
import { parseSapDataQueryResponse } from "../src/data-query.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"
import type { RemoteFunctionRequest, RemoteFunctionResult, SapBackend } from "../src/backend.js"

const definition = {
  functionName: "RFC_READ_TABLE",
  remoteEnabled: true,
  updateTask: false,
  sourceFingerprint: "7b9a603493673d26f75e555616b24d150e407ce03eff57e9c68f0b30b1ba0c2d",
  interfaceFingerprint: "d06cc5c1ce05960bde526ecf27e38606134146474cc8da19f93ac2abd3e48074"
}
let emptyHtml: unknown
try {
  parseSapDataQueryResponse({ body: "", status: 200, headers: { "content-type": "text/html" } })
} catch (error) {
  emptyHtml = error
}
const collect = (backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">) =>
  collectSystemInfo(backend, "w200", "200", async () => definition)

function fallbackBackend(
  transform: (
    result: RemoteFunctionResult,
    request: RemoteFunctionRequest
  ) => RemoteFunctionResult = (result) => result
) {
  const requests: RemoteFunctionRequest[] = []
  const mock = new MockBackend()
  return {
    requests,
    runQuery: async () => {
      throw emptyHtml
    },
    callRemoteFunction: async (_connection: string, request: RemoteFunctionRequest) => {
      requests.push(request)
      if (request.functionName === "RFC_SYSTEM_INFO") {
        // The kernel's own system information. Only the fields the service lifts out are populated,
        // and RFCDATABS is deliberately absent: it is never read as a database release.
        return {
          outputs: {
            RFCSI_EXPORT: {
              RFCSYSID: "W20",
              RFCSAPRL: "731",
              RFCKERNRL: "721",
              RFCDBSYS: "ORACLE",
              RFCHOST: "sapw20",
              RFCOPSYS: "Linux",
              RFCTZONE: "10800"
            }
          }
        }
      }
      assert.equal(request.functionName, "RFC_READ_TABLE")
      const fields = request.inputParameters.FIELDS as { FIELDNAME: string }[]
      const rows = await mock.runQuery(
        "w200",
        `SELECT * FROM ${request.inputParameters.QUERY_TABLE}`
      )
      return transform(
        {
          outputs: {
            FIELDS: fields,
            DATA: rows.map((row) => ({
              WA: fields.map(({ FIELDNAME }) => row[FIELDNAME]).join("|")
            }))
          }
        },
        request
      )
    }
  }
}

test("system information uses component release and distinct standard-time rule data", async () => {
  const backend = new MockBackend()
  const base = backend.runQuery.bind(backend)
  backend.runQuery = async (connection, sql) => {
    const rows = await base(connection, sql)
    if (sql.includes("FROM TTZR")) rows[0]!.UTCDIFF = "053015"
    return rows
  }
  const result = await collect(backend)
  assert.equal(result.status, "ok")
  assert.equal(result.systemType, "ECC")
  assert.equal(result.sapRelease, "731")
  assert.equal(result.releaseSource, "CVERS.SAP_BASIS.RELEASE")
  assert.equal(result.timezone?.utcOffset, "UTC+5:30:15")
  assert.equal(result.timezone?.rawOffset, "P0800")
  assert.equal(result.timezone?.offsetKind, "standard_time")
  assert.equal(result.sources.length, 6)
  assert.ok(result.sources.every((source) => source.method === "adt_query"))
})

test("system type does not infer ECC from SAP_BASIS and prefers S4CORE", async () => {
  for (const [names, expected] of [
    [["SAP_BASIS"], "Unknown"],
    [["SAP_BASIS", "SAP_APPL"], "ECC"],
    [["SAP_BASIS", "SAP_APPL", "S4CORE"], "S/4HANA"],
    [["S4COREOP"], "S/4HANA"]
  ] as const) {
    const backend = new MockBackend()
    const base = backend.runQuery.bind(backend)
    backend.runQuery = async (connection, sql) =>
      sql.includes("FROM CVERS")
        ? names.map((COMPONENT) => ({ COMPONENT, RELEASE: "731", EXTRELEASE: "", COMP_TYPE: "S" }))
        : base(connection, sql)
    const result = await collect(backend)
    assert.equal(result.systemType, expected)
    if (!names.some((name) => name === "SAP_BASIS")) {
      assert.equal(result.sapRelease, "")
      assert.equal(result.status, "partial")
    }
  }
})

test("system information bounds every read and marks component truncation", async () => {
  const backend = new MockBackend()
  const base = backend.runQuery.bind(backend)
  const result = await collect({
    callRemoteFunction: backend.callRemoteFunction.bind(backend),
    runQuery: async (connection, sql, limit) => {
      assert.equal(limit, sql.includes("FROM CVERS") ? 501 : 2)
      if (sql.includes("FROM CVERS"))
        return Array.from({ length: 501 }, (_, index) => ({
          COMPONENT: index === 0 ? "SAP_APPL" : index === 1 ? "SAP_BASIS" : `C${index}`,
          RELEASE: "731",
          EXTRELEASE: "",
          COMP_TYPE: "S"
        }))
      return base(connection, sql)
    }
  })
  assert.equal(result.status, "partial")
  assert.equal(result.componentsComplete, false)
  assert.equal(result.softwareComponents.length, 500)
  assert.equal(result.systemType, "Unknown")
  assert.equal(result.sources.find((source) => source.table === "CVERS")?.status, "truncated")
})

test("system information rejects duplicate, incomplete, oversized and cross-client native rows", async () => {
  for (const mode of ["duplicate", "missing", "oversized", "scope", "ambiguous"]) {
    const backend = new MockBackend()
    const base = backend.runQuery.bind(backend)
    backend.runQuery = async (connection, sql) => {
      const rows = await base(connection, sql)
      if (sql.includes("FROM CVERS")) {
        if (mode === "duplicate") return [rows[0]!, rows[0]!]
        if (mode === "missing") delete rows[0]!.RELEASE
        if (mode === "oversized") return Array(502).fill(rows[0])
      }
      if (sql.includes("FROM T000")) {
        if (mode === "scope") rows[0]!.MANDT = "000"
        if (mode === "ambiguous") return [rows[0]!, rows[0]!]
      }
      return rows
    }
    const result = await collect(backend)
    assert.equal(result.status, "partial", mode)
    assert.ok(
      result.sources.some((source) => source.status === "unavailable"),
      mode
    )
  }
})

test("system information keeps missing description and invalid offset explicit", async () => {
  for (const invalid of [false, true]) {
    const backend = new MockBackend()
    const base = backend.runQuery.bind(backend)
    backend.runQuery = async (connection, sql) => {
      if (sql.includes("FROM TTZZT")) return []
      const rows = await base(connection, sql)
      if (sql.includes("FROM TTZR") && invalid) rows[0]!.UTCDIFF = "P0800"
      return rows
    }
    const result = await collect(backend)
    assert.equal(result.status, "partial")
    if (invalid) {
      assert.equal(result.timezone, null)
      assert.ok(result.queryWarnings.includes("TTZR: SYSTEM_INFO_OFFSET_INVALID"))
      assert.equal(result.sources.find((source) => source.table === "TTZR")?.status, "invalid")
    } else {
      assert.equal(result.timezone?.description, "")
      assert.equal(result.timezone?.utcOffset, "UTC+8")
    }
  }
})

test("system information never falls back for empty results or unrelated errors and redacts failures", async () => {
  for (const error of [
    null,
    new Error("HTTP 403 password=SECRET"),
    new Error("HTTP 404"),
    new Error("SQL error"),
    new Error("SYSTEM_INFO_SECRET"),
    new Error("SAP_DATA_QUERY_RESPONSE_INVALID: HTTP 200 bytes=1")
  ]) {
    const result = await collect({
      runQuery: async () => {
        if (error) throw error
        return []
      },
      callRemoteFunction: async () => assert.fail("unexpected RFC fallback")
    })
    assert.equal(result.status, "unavailable")
    assert.equal(result.currentClient, null)
    assert.equal(result.componentsComplete, false)
    assert.equal(result.timezone, null)
    assert.doesNotMatch(JSON.stringify(result), /SECRET|password/)
    assert.equal(result.sources.length, 3)
  }
})

test("system information checks client before reading", async () => {
  for (const client of ["", "20", "200' OR 1=1", "2000"]) {
    await assert.rejects(
      collectSystemInfo(
        {
          runQuery: async () => assert.fail("unexpected query"),
          callRemoteFunction: async () => assert.fail("unexpected RFC")
        },
        "w200",
        client,
        async () => assert.fail("unexpected definition")
      ),
      /CLIENT_INVALID/
    )
  }
})

test("system information fallback is fixed, bounded, read-only and checks definition once", async () => {
  const backend = fallbackBackend()
  let definitions = 0
  const result = await collectSystemInfo(backend, "w200", "200", async () => {
    definitions++
    return definition
  })
  assert.equal(result.status, "ok")
  assert.equal(definitions, 1)
  assert.equal(result.sources.length, 6)
  assert.ok(
    result.sources.every(
      (source) =>
        source.method === "rfc_read_table" &&
        source.nativeCode === "SAP_DATA_QUERY_RESPONSE_INVALID"
    )
  )
  assert.deepEqual(
    backend.requests.map((r) => r.inputParameters.QUERY_TABLE),
    ["T000", "CVERS", "TTZCU", "TTZZ", "TTZR", "TTZZT"]
  )
  for (const { inputParameters: input } of backend.requests) {
    assert.equal(input.ROWSKIPS, "0")
    assert.equal(input.ROWCOUNT, input.QUERY_TABLE === "CVERS" ? "501" : "2")
    assert.equal(input.DELIMITER, "|")
    assert.deepEqual(input.DATA, [])
    if (input.QUERY_TABLE !== "CVERS")
      assert.match((input.OPTIONS as { TEXT: string }[])[0]!.TEXT, /^(MANDT|CLIENT) = '200'$/)
  }
})

test("system information fallback fails closed on definition drift or definition failure", async () => {
  for (const patch of [
    { functionName: "OTHER" },
    { remoteEnabled: false },
    { updateTask: true },
    { sourceFingerprint: "changed" },
    { interfaceFingerprint: "changed" },
    null
  ]) {
    const backend = fallbackBackend()
    const result = await collectSystemInfo(backend, "w200", "200", async () => {
      if (patch === null) throw new Error("SECRET")
      return { ...definition, ...patch }
    })
    assert.equal(result.status, "unavailable")
    assert.equal(backend.requests.length, 0)
    assert.doesNotMatch(JSON.stringify(result), /SECRET/)
  }
})

test("system information fallback rejects faults, malformed data and scope mismatches", async () => {
  for (const mode of ["fault", "missing", "order", "delimiter", "scope", "overflow"]) {
    const backend = fallbackBackend((result, request) => {
      if (mode === "fault")
        return {
          outputs: {},
          fault: { code: "SOAP", name: "NOT_AUTHORIZED", message: "SECRET" }
        }
      if (mode === "missing") delete result.outputs.DATA
      if (mode === "order") (result.outputs.FIELDS as object[]).reverse()
      if (mode === "delimiter") (result.outputs.DATA as { WA: string }[])[0]!.WA += "|"
      if (mode === "scope" && request.inputParameters.QUERY_TABLE === "T000")
        (result.outputs.DATA as { WA: string }[])[0]!.WA = "000|Other|T|OTHER|0"
      if (mode === "overflow") result.outputs.DATA = Array(502).fill({ WA: "" })
      return result
    })
    const result = await collect(backend)
    assert.notEqual(result.status, "ok", mode)
    assert.equal(result.currentClient, null, mode)
    assert.doesNotMatch(JSON.stringify(result), /SECRET/)
  }
})

test("system information tool distinguishes hidden components from unavailable components", async () => {
  const tools = new ToolService(new MockBackend())
  // The kernel half of the baseline is gated on RFC_SYSTEM_INFO's interface fingerprint, and the
  // mock stores function-module source rather than a full RFC interface, so the pinned definition
  // is supplied here. The six-table half still runs against the mock.
  tools.readFunctionModuleInterface = async (input) =>
    JSON.stringify(
      input.functionName === "RFC_SYSTEM_INFO"
        ? {
            functionName: "RFC_SYSTEM_INFO",
            remoteEnabled: true,
            updateTask: false,
            sourceFingerprint: "5c2431d92d424a243fd5d283b3dd592ab7b5c00384cf65977e8eb0bd0410b33e",
            interfaceFingerprint: "cfd8b63dbdb6fa990a83153590dc8195f05dad49f2a6b9fabd68106955579896"
          }
        : { functionName: input.functionName }
    )
  for (const includeComponents of [false, true]) {
    const response = await tools.getSapSystemInfo({ connectionId: "w200", includeComponents })
    const result = JSON.parse(response.slice(response.indexOf("{")))
    assert.equal(result.status, "ok")
    assert.equal(result.componentsIncluded, includeComponents)
    assert.equal(result.componentsComplete, true)
    assert.equal(result.softwareComponents.length, includeComponents ? 2 : 0)
    assert.equal(result.currentClient.category, "Test")
    assert.equal(result.currentClient.categoryCode, "T")
    assert.match(response, /standard time/)
    // The summary carries the SCC4 question operations actually asks, without parsing the payload.
    assert.match(response, /- Client role: Test \(T\)/)
    assert.match(response, /change protection: /)
  }
})

test("system information labels reflect reviewed cross-client domain semantics", async () => {
  const expected = {
    "": "Changes to Repository and cross-client Customizing allowed",
    "1": "No changes to cross-client Customizing objects",
    "2": "No changes to Repository objects",
    "3": "No changes to Repository and cross-client Customizing objects",
    "9": "9"
  }
  for (const [code, label] of Object.entries(expected)) {
    const backend = new MockBackend()
    const base = backend.runQuery.bind(backend)
    backend.runQuery = async (connection, sql) => {
      const rows = await base(connection, sql)
      if (sql.includes("FROM T000")) rows[0]!.CCNOCLIIND = code
      return rows
    }
    const response = await new ToolService(backend).getSapSystemInfo({ connectionId: "w200" })
    const result = JSON.parse(response.slice(response.indexOf("{")))
    assert.equal(result.currentClient.changeProtectionCode, code)
    assert.equal(result.currentClient.changeProtection, label)
    assert.equal(
      result.currentClient.changeProtectionScope,
      "Repository and cross-client Customizing"
    )
    assert.ok(
      response.includes(`change protection: ${label} (${code || "blank"})`),
      `the summary did not carry the decoded change protection for code "${code}"`
    )
  }
})

test("system information tool integrates native and verified fallback paths without changing query backend", async () => {
  const backend = new MockBackend()
  const native = backend.runQuery.bind(backend)
  const fallback = fallbackBackend()
  backend.runQuery = async (connection, sql) => {
    if (sql.includes("FROM CVERS")) throw emptyHtml
    const rows = await native(connection, sql)
    if (sql.includes("FROM TTZR")) {
      rows[0]!.UTCSIGN = "-"
      rows[0]!.UTCDIFF = "033000"
    }
    if (sql.includes("FROM TTZZ") && !sql.includes("FROM TTZZT")) rows[0]!.DSTRULE = "TEST"
    return rows
  }
  backend.callRemoteFunction = fallback.callRemoteFunction
  const tools = new ToolService(backend)
  let definitions = 0
  tools.readFunctionModuleInterface = async (input) => {
    assert.equal(input.connectionId, "w200")
    definitions++
    if (input.functionName === "RFC_SYSTEM_INFO") {
      return JSON.stringify({
        functionName: "RFC_SYSTEM_INFO",
        remoteEnabled: true,
        updateTask: false,
        sourceFingerprint: "5c2431d92d424a243fd5d283b3dd592ab7b5c00384cf65977e8eb0bd0410b33e",
        interfaceFingerprint: "cfd8b63dbdb6fa990a83153590dc8195f05dad49f2a6b9fabd68106955579896"
      })
    }
    assert.equal(input.functionName, "RFC_READ_TABLE")
    return JSON.stringify(definition)
  }
  const text = await tools.getSapSystemInfo({ connectionId: "W200", includeComponents: true })
  const result = JSON.parse(text.slice(text.indexOf("{")))
  assert.equal(result.status, "ok")
  // Two reviewed readers were read: RFC_READ_TABLE for the six fixed tables, RFC_SYSTEM_INFO for
  // the kernel half of the baseline.
  assert.equal(definitions, 2)
  assert.deepEqual(fallback.requests.map((request) => request.functionName).sort(), [
    "RFC_READ_TABLE",
    "RFC_SYSTEM_INFO"
  ])
  assert.equal(result.timezone.utcOffset, "UTC-3:30")
  assert.equal(result.timezone.dstRule, "TEST")
  assert.equal(
    result.sources.filter((source: { method: string }) => source.method === "rfc_read_table")
      .length,
    1
  )
  assert.match(text, /standard time.*DST rule: TEST/)
})
