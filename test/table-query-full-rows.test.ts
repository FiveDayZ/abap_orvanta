import assert from "node:assert/strict"
import test from "node:test"
import { parseGroupedTableSelect, readAbapTable, tableQuerySchema } from "../src/table-query.js"
import { parseRemoteFunctionResponse } from "../src/adt-backend.js"
import type { RemoteFunctionRequest } from "../src/backend.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"

const nativeError = new Error(
  "SAP_DATA_QUERY_RESPONSE_INVALID: expected XML data preview; HTTP 200; mediaType=text/html; root=unparsed; bytes=0. No empty result was inferred."
)
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

function fixture(count = 110, rowCount = 6) {
  const names = [
    "MANDT",
    "WERKS",
    "ZRKJHH",
    "KUNNR",
    "AMOUNT",
    ...Array.from({ length: count - 5 }, (_, i) => `F${i + 5}`)
  ]
  const lengths = [3, 4, 20, 10, 24]
  const layout = names.map((FIELDNAME, index) => ({
    FIELDNAME,
    TYPE: index === 4 ? "P" : "C",
    LENGTH: String(lengths[index] ?? (count > 110 ? 5 : 16))
  }))
  const definition = {
    objectKind: "transparentTable",
    objectName: "TFDIR",
    fingerprint: "a".repeat(64),
    definition: { tableClass: "TRANSP", fields: names.map((name, i) => ({ name, key: i < 3 })) }
  }
  const rows = Array.from({ length: rowCount }, (_, i) =>
    Object.fromEntries(
      names.map((name, j) => [
        name,
        j === 0
          ? "200"
          : j === 1
            ? i % 2
              ? "809P"
              : "810P"
            : j === 2
              ? String(Math.floor(i / 2)).padStart(20, "0")
              : j === 3
                ? "0001100059"
                : j === 4
                  ? "9007199254740993.123-"
                  : j === 5
                    ? "a|b"
                    : `v${j}`
      ])
    )
  )
  const requests: RemoteFunctionRequest[] = []
  const backend = {
    runQuery: async () => {
      throw nativeError
    },
    callRemoteFunction: async (_connection: string, request: RemoteFunctionRequest) => {
      requests.push(request)
      const selected = (request.inputParameters.FIELDS as { FIELDNAME: string }[]).map(
        (x) => x.FIELDNAME
      )
      const fields = (selected.length ? selected : names).map((name) => ({
        ...layout.find((f) => f.FIELDNAME === name)!,
        OFFSET: "0"
      }))
      let offset = 0
      for (const field of fields) {
        field.OFFSET = String(offset)
        offset += Number(field.LENGTH) + 1
      }
      if (request.inputParameters.NO_DATA === "X") return { outputs: { FIELDS: fields, DATA: [] } }
      assert.equal(request.functionName, "BBP_RFC_READ_TABLE")
      assert.ok(offset - 1 <= 512)
      let selectedRows = rows
      for (const { TEXT } of request.inputParameters.OPTIONS as { TEXT: string }[]) {
        const m = TEXT.match(/^(?:AND )?([A-Z0-9_]+) = '((?:[^']|'')*)'$/)!
        assert.ok(m, TEXT)
        selectedRows = selectedRows.filter((row) => row[m[1]!] === m[2]!.replaceAll("''", "'"))
      }
      return {
        outputs: {
          FIELDS: fields,
          DATA: selectedRows.slice(0, Number(request.inputParameters.ROWCOUNT)).map((row) => ({
            WA: fields
              .map((field) => {
                const value = row[field.FIELDNAME]!
                return field.TYPE === "P"
                  ? value.padStart(Number(field.LENGTH))
                  : value.padEnd(Number(field.LENGTH))
              })
              .join("|")
          }))
        }
      }
    }
  }
  const readReader = async (_id: string, name: string) =>
    name === legacy.functionName ? legacy : aligned
  const input = {
    connectionId: "w200",
    tableName: "TFDIR",
    columns: ["*"],
    filters: [{ column: "KUNNR", operator: "EQ", value: "0001100059" }],
    maxRows: 5
  }
  return {
    names,
    layout,
    definition,
    rows,
    requests,
    backend,
    readReader,
    input,
    read: () => readAbapTable(input, backend, async () => definition, readReader)
  }
}

test("five complete 110-field rows preserve compound keys, exact numeric text and embedded delimiters", async () => {
  const f = fixture()
  const result = await f.read()
  assert.equal(result.status, "ok")
  assert.equal(result.returnedCount, 5)
  assert.equal(result.truncated, true)
  assert.deepEqual(result.data, f.rows.slice(0, 5))
  assert.ok(result.data!.every((row) => Object.keys(row).length === 110))
  assert.equal(result.data![0]!.AMOUNT, "9007199254740993.123-")
  assert.equal(result.data![0]!.F5, "a|b")
  assert.ok(
    f.requests
      .filter((r) => r.inputParameters.NO_DATA === "")
      .slice(1)
      .every((r) =>
        (r.inputParameters.OPTIONS as { TEXT: string }[]).some((x) =>
          x.TEXT.includes("KUNNR = '0001100059'")
        )
      )
  )
})

test("1024 fields are accepted without dropping columns; 1025 and mixed wildcard are rejected", async () => {
  const f = fixture(1024, 1)
  const result = await f.read()
  assert.equal(result.status, "ok")
  assert.equal(Object.keys(result.data![0]!).length, 1024)
  assert.equal(
    tableQuerySchema.safeParse({
      ...f.input,
      columns: Array.from({ length: 1025 }, (_, i) => `F${i}`)
    }).success,
    false
  )
  await assert.rejects(
    readAbapTable(
      { ...f.input, columns: ["*", "MANDT"] },
      f.backend,
      async () => f.definition,
      f.readReader
    ),
    /INPUT_INVALID/
  )
})

test("numeric-only projection keeps leading buffer padding and full decimal precision", async () => {
  const f = fixture()
  const result = await readAbapTable(
    { ...f.input, columns: ["AMOUNT"] },
    f.backend,
    async () => f.definition,
    f.readReader
  )
  assert.equal(result.status, "ok")
  assert.deepEqual(
    result.data,
    f.rows.slice(0, 5).map((row) => ({ AMOUNT: row.AMOUNT }))
  )
})

test("complete rows retain empty fields separately from exact zero and negative numeric text", async () => {
  const f = fixture()
  f.rows[0]!.F6 = ""
  f.rows[0]!.AMOUNT = "0.000"
  f.rows[1]!.F6 = "0000"
  const result = await f.read()
  assert.equal(result.status, "ok")
  assert.equal(result.data![0]!.F6, "")
  assert.equal(result.data![0]!.AMOUNT, "0.000")
  assert.equal(result.data![1]!.F6, "0000")
  assert.equal(result.data![1]!.AMOUNT, "9007199254740993.123-")
  assert.ok(result.data!.every((row) => Object.keys(row).length === 110))
})

for (const length of [500, 512]) {
  test(`complete rows keep a ${length}-character field without repeating keys in its output`, async () => {
    const f = fixture()
    f.layout[5]!.LENGTH = String(length)
    f.rows.forEach((row, index) => {
      row.F5 = `R${index}|${"x".repeat(length - 4)}Z`
    })
    const result = await f.read()
    assert.equal(result.status, "ok")
    assert.equal(result.returnedCount, 5)
    assert.deepEqual(result.data, f.rows.slice(0, 5))
    assert.ok(result.data!.every((row) => String(row.F5).length === length))
    const singles = f.requests.filter(
      (request) =>
        request.inputParameters.NO_DATA === "" &&
        JSON.stringify(request.inputParameters.FIELDS) === JSON.stringify([{ FIELDNAME: "F5" }])
    )
    assert.equal(singles.length, 12)
    for (const request of singles) {
      const options = request.inputParameters.OPTIONS as { TEXT: string }[]
      assert.equal(request.inputParameters.ROWCOUNT, "2")
      assert.equal(options.length, 4)
      for (const field of ["KUNNR", "MANDT", "WERKS", "ZRKJHH"]) {
        assert.ok(
          options.some(
            (option) =>
              option.TEXT.startsWith(`${field} = `) || option.TEXT.startsWith(`AND ${field} = `)
          )
        )
      }
    }
  })
}

test("standalone long-field reads reject missing, duplicate and changed rows", async () => {
  for (const mode of ["missing", "duplicate", "changed"]) {
    const f = fixture()
    f.layout[5]!.LENGTH = "500"
    f.rows.forEach((row) => {
      row.F5 = "x".repeat(500)
    })
    const invoke = f.backend.callRemoteFunction
    let singles = 0
    f.backend.callRemoteFunction = async (id, request) => {
      if (
        request.inputParameters.NO_DATA === "" &&
        JSON.stringify(request.inputParameters.FIELDS) === JSON.stringify([{ FIELDNAME: "F5" }])
      ) {
        singles++
        if (singles === 1 && mode === "missing") f.rows.splice(0, 1)
        if (singles === 1 && mode === "duplicate") f.rows.push({ ...f.rows[0]! })
        if (singles === 2 && mode === "changed") f.rows[0]!.F5 = "y".repeat(500)
      }
      return invoke(id, request)
    }
    const result = await f.read()
    assert.equal(result.status, "unavailable", mode)
    assert.equal("code" in result && result.code, "TABLE_QUERY_ROW_CHANGED", mode)
    assert.equal(result.data, null)
  }
})

test("definition drift after wide reads rejects the entire response", async () => {
  const f = fixture()
  let reads = 0
  const result = await readAbapTable(
    f.input,
    f.backend,
    async () => ({
      ...f.definition,
      fingerprint: ++reads === 1 ? "a".repeat(64) : "b".repeat(64)
    }),
    f.readReader
  )
  assert.equal(result.status, "unavailable")
  assert.equal("code" in result && result.code, "TABLE_QUERY_METADATA_CHANGED")
  assert.equal(result.data, null)
})

test("full-row reader returns genuine empty data and refuses missing keys, oversized fields and byte output", async () => {
  assert.deepEqual((await fixture(110, 0).read()).data, [])
  for (const mode of ["noKeys", "wide", "byte"]) {
    const f = fixture()
    if (mode === "noKeys")
      f.definition.definition.fields.forEach((x) => {
        x.key = false
      })
    if (mode === "wide") f.layout[5]!.LENGTH = "513"
    if (mode === "byte") f.layout[5]!.TYPE = "X"
    const result = await f.read()
    assert.equal(result.status, "unavailable", mode)
    assert.equal(result.data, null)
    assert.ok(f.requests.every((r) => r.inputParameters.NO_DATA === "X"))
  }
})

test("numeric overflow, duplicate keys, deleted rows and edits never return partial success", async () => {
  for (const mode of ["overflow", "duplicate", "deleted", "changed"]) {
    const f = fixture()
    if (mode === "overflow") f.rows[0]!.AMOUNT = "****************"
    if (mode === "duplicate") f.rows[1] = { ...f.rows[0]! }
    const invoke = f.backend.callRemoteFunction
    let dataCalls = 0
    f.backend.callRemoteFunction = async (id, request) => {
      if (request.inputParameters.NO_DATA === "") {
        dataCalls++
        if (mode === "deleted" && dataCalls === 2) f.rows.splice(0, 1)
        if (mode === "changed" && dataCalls === 3) f.rows[0]!.AMOUNT = "5.123"
      }
      return invoke(id, request)
    }
    const result = await f.read()
    assert.equal(result.status, "unavailable", mode)
    assert.equal(result.data, null, mode)
  }
})

test("request budget rejects large wide fetches before per-key reads", async () => {
  const f = fixture(110, 100)
  f.input.maxRows = 100
  const result = await f.read()
  assert.equal(result.status, "unavailable")
  assert.equal("code" in result && result.code, "TABLE_QUERY_REQUEST_BUDGET_EXCEEDED")
  assert.equal(f.requests.filter((r) => r.inputParameters.NO_DATA === "").length, 1)
})

test("table-reader SOAP preserves WA leading padding while ordinary RFC responses retain trimming", () => {
  const body = "<Envelope><Body><DATA><item><WA> 12| a|b   </WA></item></DATA></Body></Envelope>"
  const shape = [{ name: "DATA", kind: "table" as const, fields: ["WA"] }]
  assert.deepEqual(parseRemoteFunctionResponse(body, shape, true).outputs.DATA, [
    { WA: " 12| a|b   " }
  ])
  assert.deepEqual(parseRemoteFunctionResponse(body, shape).outputs.DATA, [{ WA: "12| a|b" }])
})

test("finite SELECT fallback accepts escaped literals and rejects unsupported SQL", () => {
  assert.deepEqual(
    parseGroupedTableSelect("SELECT * FROM TFDIR WHERE KUNNR = 'O''Brien' AND WERKS = '809P'"),
    {
      tableName: "TFDIR",
      columns: ["*"],
      groups: [
        [
          { column: "KUNNR", operator: "EQ", value: "O'Brien" },
          { column: "WERKS", operator: "EQ", value: "809P" }
        ]
      ],
      orderBy: []
    }
  )
  // The degraded path translates exactly the comparisons read_abap_table can express. Refusing
  // "<" or ">" here would be the service being stricter than the reader it calls.
  assert.deepEqual(
    parseGroupedTableSelect(
      "SELECT MANDT, BUKRS FROM ZTPMC_BZWL WHERE ZPOSNR >= 100 AND ZPOSNR <= 200 " +
        "AND WERKS <> '809P' AND ZPKGMATNR > '0' AND ZPKGTYPE < 9 AND ZPKGDESC = 'x''y'"
    ),
    {
      tableName: "ZTPMC_BZWL",
      columns: ["MANDT", "BUKRS"],
      groups: [
        [
          { column: "ZPOSNR", operator: "GE", value: "100" },
          { column: "ZPOSNR", operator: "LE", value: "200" },
          { column: "WERKS", operator: "NE", value: "809P" },
          { column: "ZPKGMATNR", operator: "GT", value: "0" },
          { column: "ZPKGTYPE", operator: "LT", value: "9" },
          { column: "ZPKGDESC", operator: "EQ", value: "x'y" }
        ]
      ],
      orderBy: []
    }
  )
  // A bare number keeps its sign and decimals; the reader quotes it for SAP.
  assert.deepEqual(parseGroupedTableSelect("SELECT * FROM TFDIR WHERE N > -12.5")?.groups[0], [
    { column: "N", operator: "GT", value: "-12.5" }
  ])
  // A statement without a WHERE is one bounded read of the table, and an OR or an ORDER BY is now
  // part of the dialect rather than a refusal: each is read by the grouped reader.
  assert.deepEqual(parseGroupedTableSelect("SELECT * FROM TFDIR")?.groups, [[]])
  assert.equal(
    parseGroupedTableSelect("SELECT * FROM TFDIR WHERE ID = '1' OR ID = '2'")?.groups.length,
    2
  )
  assert.deepEqual(
    parseGroupedTableSelect("SELECT * FROM TFDIR WHERE ID = '1' ORDER BY ID")?.orderBy,
    [{ column: "ID", direction: "asc" }]
  )
  for (const sql of [
    "SELECT * FROM TFDIR WHERE ID = '1' AND ",
    "SELECT * FROM TFDIR WHERE ID = '1' OR ",
    "SELECT COUNT(*) FROM TFDIR WHERE ID = '1'",
    "SELECT * FROM TFDIR WHERE ID = '1';DELETE FROM TFDIR",
    // Not the dialect: C-style inequality is not ABAP Open SQL, and a value beyond the reader's
    // 40-character bound is refused here rather than rejected later as a malformed request.
    "SELECT * FROM TFDIR WHERE ID != '1'",
    `SELECT * FROM TFDIR WHERE ID = '${"x".repeat(41)}'`,
    // The comparison token must not be glued to the value or dropped.
    "SELECT * FROM TFDIR WHERE ID '1'",
    "SELECT * FROM TFDIR WHERE ID >=< '1'"
  ]) {
    assert.equal(parseGroupedTableSelect(sql), undefined, sql)
  }
  // Exactly the reader's ceiling: the ninth conjunct is not translated.
  const eight = Array.from({ length: 8 }, (_, index) => `F${index} = '1'`).join(" AND ")
  assert.equal(parseGroupedTableSelect(`SELECT * FROM TFDIR WHERE ${eight}`)?.groups[0]?.length, 8)
  assert.equal(
    parseGroupedTableSelect(`SELECT * FROM TFDIR WHERE ${eight} AND F8 = '1'`),
    undefined
  )
})

test("execute_data_query routes full rows through the shared reader without repeating native ADT", async () => {
  const f = fixture()
  const backend = Object.assign(new MockBackend(), f.backend)
  let nativeCalls = 0
  backend.runQuery = async () => {
    nativeCalls++
    throw nativeError
  }
  const tools = new ToolService(backend)
  tools.readDdicTransparentTable = async () => JSON.stringify(f.definition)
  tools.readFunctionModuleInterface = async (input) =>
    JSON.stringify(await f.readReader(input.connectionId, input.functionName))
  const result = JSON.parse(
    await tools.executeDataQuery({
      connectionId: "w200",
      displayMode: "internal",
      sql: "SELECT * FROM TFDIR WHERE KUNNR = '0001100059'",
      maxRows: 5,
      rowRange: { start: 0, end: 5 }
    })
  )
  assert.equal(nativeCalls, 1)
  assert.equal(result.resultCount, 5)
  assert.equal(result.truncated, true)
  assert.deepEqual(result.data, f.rows.slice(0, 5))
  assert.equal(result.querySource.method, "bbp_rfc_read_table")
})

test("execute_data_query reads each disjunct on the server and merges what comes back", async () => {
  const f = fixture(6, 6)
  const backend = Object.assign(new MockBackend(), f.backend)
  backend.runQuery = async () => {
    throw nativeError
  }
  const tools = new ToolService(backend)
  tools.readDdicTransparentTable = async () => JSON.stringify(f.definition)
  tools.readFunctionModuleInterface = async (input) =>
    JSON.stringify(await f.readReader(input.connectionId, input.functionName))
  const sql = "SELECT * FROM TFDIR WHERE MANDT = '200' OR WERKS = '809P'"
  const result = JSON.parse(
    await tools.executeDataQuery({
      connectionId: "w200",
      displayMode: "internal",
      sql,
      maxRows: 5,
      rowRange: { start: 0, end: 5 }
    })
  )

  // Two disjuncts are two server-side reads: the `OR` is pushed down as a union of predicates rather
  // than compared in the service, where `NUMC` and dates would have to be re-typed by hand.
  const dataReads = f.requests.filter((request) => request.inputParameters.NO_DATA !== "X")
  assert.equal(dataReads.length, 2)
  assert.deepEqual(
    dataReads.map((request) =>
      (request.inputParameters.OPTIONS as { TEXT: string }[]).map((option) => option.TEXT)
    ),
    [["MANDT = '200'"], ["WERKS = '809P'"]]
  )
  assert.equal(result.querySource.disjuncts, 2)
  // The first branch stopped at the five-row bound, so it returned rows 0-4 while the second branch
  // returned the three `809P` rows - two of which it had already produced. A whole-row read
  // identifies them, so the union collapses those two instead of handing the caller the same row
  // twice, and keeps the third `809P` row it had not reached.
  assert.equal(result.querySource.deduplicatedRows, 2)
  assert.equal(result.querySource.repeatedProjectedRows, 0)
  // The first branch hit the five-row bound, so the answer is a page and says so.
  assert.deepEqual(result.querySource.incompleteBranches, [0])
  assert.equal(result.truncated, true)
  assert.equal(result.resultCount, 5)
})

test("execute_data_query refuses an ordering it cannot compute over the whole match set", async () => {
  const f = fixture(6, 6)
  const backend = Object.assign(new MockBackend(), f.backend)
  backend.runQuery = async () => {
    throw nativeError
  }
  const tools = new ToolService(backend)
  tools.readDdicTransparentTable = async () => JSON.stringify(f.definition)
  tools.readFunctionModuleInterface = async (input) =>
    JSON.stringify(await f.readReader(input.connectionId, input.functionName))
  const query = (sql: string) =>
    tools.executeDataQuery({
      connectionId: "w200",
      displayMode: "internal",
      sql,
      maxRows: 5,
      rowRange: { start: 0, end: 5 }
    })

  // Sorting the rows that happened to fit would answer "the top of the ordering" with rows that are
  // not, so the statement is refused with the branch that was cut.
  await assert.rejects(
    query("SELECT * FROM TFDIR WHERE MANDT = '200' OR WERKS = '809P' ORDER BY ZRKJHH"),
    /TABLE_QUERY_ORDER_BY_INCOMPLETE/
  )
  // A narrow enough filter completes every read, and then the ordering is real.
  const ordered = JSON.parse(
    await query(
      "SELECT * FROM TFDIR WHERE WERKS = '809P' AND KUNNR = '0001100059' ORDER BY ZRKJHH DESC"
    )
  )
  assert.equal(ordered.querySource.orderByApplied, true)
  assert.equal(ordered.querySource.incompleteBranches.length, 0)
  assert.deepEqual(
    ordered.data.map((row: Record<string, string>) => row.ZRKJHH),
    ["00000000000000000002", "00000000000000000001", "00000000000000000000"]
  )
})
