import assert from "node:assert/strict"
import test from "node:test"
import type { RemoteFunctionRequest } from "../src/backend.js"
import type { OperandType } from "../src/table-expression.js"
import { calculationTypeOf } from "../src/table-expression.js"
import {
  groupedReadColumns,
  parseGroupedTableSelect,
  pushableFilters,
  readGroupedRows,
  selectEvaluatesTerms,
  type SelectSubqueryCondition
} from "../src/table-query.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"

// `IN (SELECT ...)` is the one `WHERE` form the reader cannot express at all: its structured filter
// takes one column, one operator and one literal, so a set test is decided here - like a term, over a
// read that completed - and comparing the two sides is a comparison of *values*, not of printed text.
// These tests pin both halves: what the grammar claims, and what the merge does with it.

const type = (dataType: string, decimals = 0): OperandType => ({
  // The calculation type is the one this layer's own classifier derives, so the fixture cannot make
  // the comparison class look right for the wrong reason: only `dataType` is read by the comparison.
  calculationType: calculationTypeOf(dataType)!,
  dataType,
  decimals
})

/** The classes the comparison switch reads, one entry per branch of it. */
const types: Record<string, OperandType> = {
  MSEHI: type("CHAR"),
  WERKS: type("CHAR"),
  MATNR: type("NUMC"),
  ZAEHL: type("INT4"),
  ADDKO: type("DEC", 6),
  TEMP_VALUE: type("FLTP", 16),
  RAW16: type("RAW")
}

function subqueryOf(sql: string): SelectSubqueryCondition {
  const select = parseGroupedTableSelect(sql)
  assert.ok(select, `not claimed: ${sql}`)
  const condition = select.groups[0]![0]!
  assert.ok("select" in condition, `not a subquery condition: ${sql}`)
  return condition as SelectSubqueryCondition
}

/** Merge one statement with hand-written branch and inner answers, so each rule is pinned alone. */
async function merge(
  sql: string,
  outer: { rows: Record<string, unknown>[]; truncated?: boolean },
  inner: { rows: Record<string, unknown>[]; truncated?: boolean },
  asked: string[][] = []
) {
  const select = parseGroupedTableSelect(sql)
  assert.ok(select)
  return readGroupedRows(
    select,
    async (filters) => {
      asked.push(filters.map((filter) => `${filter.column}=${filter.value}`))
      return { rows: outer.rows, truncated: outer.truncated === true, detail: {} }
    },
    undefined,
    (column) => types[column],
    async (innerSelect) => ({
      values: inner.rows.map((row) => String(row[innerSelect.columns[0]!] ?? "")),
      truncated: inner.truncated === true,
      type: types[innerSelect.columns[0]!]
    })
  )
}

const refusal = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error("expected a refusal, got an answer")
}

test("the grammar reads an IN (SELECT ...) test as its own condition", () => {
  const condition = subqueryOf("SELECT MSEHI FROM T006 WHERE MSEHI IN (SELECT MSEHI FROM T001)")
  assert.equal(condition.column, "MSEHI")
  assert.equal(condition.negated, false)
  assert.equal(condition.valueColumn, "MSEHI")
  assert.equal(condition.select.tableName, "T001")
  assert.equal(condition.text, "MSEHI IN (SELECT MSEHI FROM T001)")
  // A subquery condition is not a pushed filter: the reader has no set operator.
  assert.deepEqual(pushableFilters([condition]), [])
  // The tested column has to be read even when the statement does not select it, and the dictionary
  // has to be read before the first read, because the comparison class comes from it.
  assert.equal(
    selectEvaluatesTerms(
      parseGroupedTableSelect("SELECT ZAEHL FROM T006 WHERE MSEHI IN (SELECT MSEHI FROM T001)")!
    ),
    true
  )
})

test("the grammar reads NOT IN, a following conjunct and a following disjunct", () => {
  const notIn = subqueryOf("SELECT MSEHI FROM T006 WHERE MSEHI NOT IN (SELECT MSEHI FROM T001)")
  assert.equal(notIn.negated, true)
  const select = parseGroupedTableSelect(
    "SELECT MSEHI FROM T006 WHERE MSEHI IN (SELECT MSEHI FROM T001) AND ZAEHL = '7' OR MSEHI = '9'"
  )
  assert.ok(select)
  assert.equal(select.groups.length, 2)
  assert.equal(select.groups[0]!.length, 2)
  assert.ok("select" in select.groups[0]![0]!)
  assert.ok("column" in select.groups[0]![1]! && "operator" in select.groups[0]![1]!)
})

test("the grammar cuts the inner statement out by counting parentheses, not by a pattern", () => {
  const condition = subqueryOf(
    "SELECT MSEHI FROM T006 WHERE MSEHI IN (SELECT MSEHI FROM T001 WHERE WERKS IN (SELECT WERKS FROM T001)) AND ZAEHL = '7'"
  )
  assert.equal(condition.select.tableName, "T001")
  // The inner statement carries its own set test, and the outer conjunct after the closing parenthesis
  // is still read as a conjunct: a pattern could not have found that closing parenthesis.
  const outer = parseGroupedTableSelect(
    "SELECT MSEHI FROM T006 WHERE MSEHI IN (SELECT MSEHI FROM T001 WHERE WERKS IN (SELECT WERKS FROM T001)) AND ZAEHL = '7'"
  )
  assert.ok(outer)
  assert.equal(outer.groups[0]!.length, 2)
})

test("a LIMIT inside the subquery is not read as the outer statement's LIMIT", async () => {
  // The inner statement may not be a limited page - a page is not a set - and the outer statement's
  // own limit is still applied: the two limits must not be confused for one another.
  const stolen = await refusal(
    merge(
      "SELECT MSEHI FROM T006 WHERE MSEHI IN (SELECT MSEHI FROM T001 LIMIT 5)",
      { rows: [] },
      { rows: [] }
    )
  )
  assert.match(stolen, /^TABLE_QUERY_SUBQUERY_PROJECTION/)
  const outerLimit = parseGroupedTableSelect(
    "SELECT MSEHI FROM T006 WHERE MSEHI IN (SELECT MSEHI FROM T001) LIMIT 1"
  )
  assert.equal(outerLimit?.limit, 1)
})

test("the grammar refuses what it cannot answer exactly, naming the fix", async () => {
  const cases: [string, RegExp][] = [
    [
      "SELECT MSEHI FROM T006 WHERE MSEHI IN (SELECT COUNT(*) FROM T001)",
      /^TABLE_QUERY_SUBQUERY_PROJECTION/
    ],
    [
      "SELECT MSEHI FROM T006 WHERE MSEHI IN (SELECT MSEHI FROM T001 WHERE ZAEHL = WERKS)",
      /^TABLE_QUERY_SUBQUERY_UNSUPPORTED/
    ],
    [
      "SELECT MSEHI FROM T006 WHERE MSEHI IN (SELECT MSEHI FROM T001 WHERE WERKS IN (SELECT WERKS FROM T001 WHERE MSEHI IN (SELECT MSEHI FROM T006))))",
      /^TABLE_QUERY_SUBQUERY_DEPTH/
    ]
  ]
  for (const [sql, expected] of cases) {
    const message = await refusal(Promise.resolve().then(() => parseGroupedTableSelect(sql)))
    assert.match(message, expected, sql)
  }
})

test("a joined statement leaves the set test to the platform instead of claiming it", () => {
  // The joined dialect's `WHERE` takes a conjunction of qualified comparisons only. A set test there
  // is not translated, and it is not mis-read either - the statement keeps the platform's own error.
  assert.equal(
    parseGroupedTableSelect("SELECT MSEHI FROM T006 WHERE MSEHI IN (SELECT MSEHI FROM T001)")
      ?.tableName,
    "T006"
  )
})

test("the merge answers an IN test by value: trailing blanks do not separate two character values", async () => {
  // The reader prints a character field over its declared length, so the same value read from two
  // fields of different lengths arrives with different padding. SAP compares character fields with
  // trailing blanks ignored; a text comparison would report "no such value".
  const result = await merge(
    "SELECT MSEHI FROM T006 WHERE MSEHI IN (SELECT MSEHI FROM T001)",
    { rows: [{ MSEHI: "1  " }, { MSEHI: "2  " }] },
    { rows: [{ MSEHI: "1     " }, { MSEHI: "1" }] }
  )
  assert.deepEqual(result.rows, [{ MSEHI: "1  " }])
  assert.deepEqual(result.whereSubqueries, [
    {
      condition: "MSEHI IN (SELECT MSEHI FROM T001)",
      column: "MSEHI",
      negated: false,
      values: 1,
      disjunct: 0
    }
  ])
})

test("the merge answers NOT IN as the complement, and tells the two apart in the mapping", async () => {
  const result = await merge(
    "SELECT MSEHI FROM T006 WHERE MSEHI NOT IN (SELECT MSEHI FROM T001)",
    { rows: [{ MSEHI: "1" }, { MSEHI: "2" }] },
    { rows: [{ MSEHI: "1" }] }
  )
  assert.deepEqual(result.rows, [{ MSEHI: "2" }])
  assert.equal(result.whereSubqueries[0]!.negated, true)
})

test("a numeric set test compares numbers, so 007 and 7 are one value", async () => {
  // `NUMC` is the case that makes the class matter: it is printed as digits and compared as
  // characters, so padding zeros are part of the value. `INT4` is the opposite - the reader prints the
  // same number with or without leading zeros - and both sides have to agree on which rule applies.
  const result = await merge(
    "SELECT ZAEHL FROM T006 WHERE ZAEHL IN (SELECT ZAEHL FROM T001)",
    { rows: [{ ZAEHL: "7  " }, { ZAEHL: "8  " }] },
    { rows: [{ ZAEHL: "007" }] }
  )
  assert.deepEqual(result.rows, [{ ZAEHL: "7  " }])
})

test("a packed set test compares exact decimals", async () => {
  const result = await merge(
    "SELECT ADDKO FROM T006 WHERE ADDKO IN (SELECT ADDKO FROM T001)",
    { rows: [{ ADDKO: "7.500000" }, { ADDKO: "7.050000" }] },
    { rows: [{ ADDKO: "7.5" }] }
  )
  assert.deepEqual(result.rows, [{ ADDKO: "7.500000" }])
})

test("a comparison this layer cannot reproduce is refused, never done as text", async () => {
  const mixed = await refusal(
    merge(
      "SELECT MSEHI FROM T006 WHERE MSEHI IN (SELECT ZAEHL FROM T001)",
      { rows: [{ MSEHI: "7" }] },
      { rows: [{ ZAEHL: "7" }] }
    )
  )
  assert.match(mixed, /^TABLE_QUERY_SUBQUERY_TYPE/)
  assert.match(mixed, /compared as character/)
  const float = await refusal(
    merge(
      "SELECT ZAEHL FROM T006 WHERE ZAEHL IN (SELECT TEMP_VALUE FROM T001)",
      { rows: [{ ZAEHL: "7" }] },
      { rows: [{ TEMP_VALUE: "1.000000000E+00" }] }
    )
  )
  assert.match(float, /^TABLE_QUERY_SUBQUERY_FLOAT/)
  const raw = await refusal(
    merge(
      "SELECT ZAEHL FROM T006 WHERE ZAEHL IN (SELECT RAW16 FROM T001)",
      { rows: [{ ZAEHL: "7" }] },
      { rows: [{ RAW16: "00" }] }
    )
  )
  assert.match(raw, /^TABLE_QUERY_SUBQUERY_TYPE/)
  // The refusal has to say which of the two reasons applies: a type in neither class is not the same
  // thing as a mixed pair, and a caller told the wrong one cannot fix the statement.
  assert.match(raw, /cannot state how SAP compares/)
})

test("an empty numeric value has no key, so it refuses rather than comparing as text", async () => {
  const outerEmpty = await refusal(
    merge(
      "SELECT ZAEHL FROM T006 WHERE ZAEHL IN (SELECT ZAEHL FROM T001)",
      { rows: [{ ZAEHL: "" }] },
      { rows: [{ ZAEHL: "7" }] }
    )
  )
  assert.match(outerEmpty, /^TABLE_QUERY_SUBQUERY_VALUE/)
  const innerEmpty = await refusal(
    merge(
      "SELECT ZAEHL FROM T006 WHERE ZAEHL IN (SELECT ZAEHL FROM T001)",
      { rows: [{ ZAEHL: "7" }] },
      { rows: [{ ZAEHL: "" }] }
    )
  )
  assert.match(innerEmpty, /^TABLE_QUERY_SUBQUERY_VALUE/)
})

test("a sample is not a set: both sides of the test have to complete", async () => {
  // The inner read decides what the set *is*, so a truncated one refuses before the outer table is
  // read at all - nothing has been filtered when the caller reads the refusal.
  const asked: string[][] = []
  const inner = await refusal(
    merge(
      "SELECT MSEHI FROM T006 WHERE MSEHI IN (SELECT MSEHI FROM T001)",
      { rows: [{ MSEHI: "1" }] },
      { rows: [{ MSEHI: "1" }], truncated: true },
      asked
    )
  )
  assert.match(inner, /^TABLE_QUERY_SUBQUERY_INCOMPLETE/)
  assert.deepEqual(asked, [], "the outer table was not read")
  // The outer read decides which rows the answer holds, so a truncated one is a sample of the matches.
  const outer = await refusal(
    merge(
      "SELECT MSEHI FROM T006 WHERE MSEHI IN (SELECT MSEHI FROM T001)",
      { rows: [{ MSEHI: "1" }], truncated: true },
      { rows: [{ MSEHI: "1" }] }
    )
  )
  assert.match(outer, /^TABLE_QUERY_WHERE_SUBQUERY_INCOMPLETE/)
})

test("a set test whose set cannot be read is refused, not dropped", async () => {
  const select = parseGroupedTableSelect(
    "SELECT MSEHI FROM T006 WHERE MSEHI IN (SELECT MSEHI FROM T001)"
  )
  assert.ok(select)
  const message = await refusal(
    readGroupedRows(
      select,
      async () => ({ rows: [], truncated: false, detail: {} }),
      undefined,
      (column) => types[column]
    )
  )
  assert.match(message, /^TABLE_QUERY_SUBQUERY_UNAVAILABLE/)
})

test("the tested column is read but is not part of the answer", async () => {
  const asked: string[][] = []
  const select = parseGroupedTableSelect(
    "SELECT ZAEHL FROM T006 WHERE MSEHI IN (SELECT MSEHI FROM T001)"
  )!
  // The column the test compares has to be in the read even though the statement selects another one:
  // without it the row carries nothing to compare.
  assert.deepEqual(groupedReadColumns(select), ["ZAEHL", "MSEHI"])
  const result = await readGroupedRows(
    select,
    async () => {
      asked.push([])
      return { rows: [{ ZAEHL: "7", MSEHI: "1" }], truncated: false, detail: {} }
    },
    undefined,
    (column) => types[column],
    async () => ({ values: ["1"], truncated: false, type: types.MSEHI })
  )
  assert.deepEqual(result.rows, [{ ZAEHL: "7" }])
  assert.equal(asked.length, 1)
})

// ---------------------------------------------------------------------------------------------
// The wiring: `execute_data_query` on the real path, so the dictionary reads and the reader calls
// the inner statement causes are visible.
// ---------------------------------------------------------------------------------------------

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

interface FakeTable {
  name: string
  fields: string[]
  rows: Record<string, string>[]
}

const outer: FakeTable = {
  name: "T006",
  fields: ["MANDT", "MSEHI", "ZAEHL"],
  // `MSEHI` is declared over three characters and the second row's value is padded on purpose: the
  // two sides of the test are read from fields of different declared lengths.
  rows: [
    { MANDT: "200", MSEHI: "1", ZAEHL: "7" },
    { MANDT: "200", MSEHI: "2", ZAEHL: "3" }
  ]
}
const innerTable: FakeTable = {
  name: "T001",
  fields: ["MANDT", "MSEHI"],
  rows: [
    { MANDT: "200", MSEHI: "1" },
    { MANDT: "200", MSEHI: "1" }
  ]
}
const dictionary: FakeTable = {
  name: "DD03L",
  fields: ["FIELDNAME", "DATATYPE", "LENG", "DECIMALS", "TABNAME", "AS4LOCAL"],
  rows: [
    {
      FIELDNAME: "MSEHI",
      DATATYPE: "CHAR",
      LENG: "000003",
      DECIMALS: "0",
      TABNAME: "T006",
      AS4LOCAL: "A"
    },
    {
      FIELDNAME: "ZAEHL",
      DATATYPE: "INT4",
      LENG: "000010",
      DECIMALS: "0",
      TABNAME: "T006",
      AS4LOCAL: "A"
    },
    {
      FIELDNAME: "MANDT",
      DATATYPE: "CLNT",
      LENG: "000003",
      DECIMALS: "0",
      TABNAME: "T006",
      AS4LOCAL: "A"
    },
    // The inner field is declared over five characters, so the reader prints the same value with more
    // padding than the outer table's field does.
    {
      FIELDNAME: "MSEHI",
      DATATYPE: "CHAR",
      LENG: "000005",
      DECIMALS: "0",
      TABNAME: "T001",
      AS4LOCAL: "A"
    },
    {
      FIELDNAME: "ZAEHL",
      DATATYPE: "INT4",
      LENG: "000010",
      DECIMALS: "0",
      TABNAME: "T001",
      AS4LOCAL: "A"
    },
    {
      FIELDNAME: "MANDT",
      DATATYPE: "CLNT",
      LENG: "000003",
      DECIMALS: "0",
      TABNAME: "T001",
      AS4LOCAL: "A"
    }
  ]
}
const tables = [outer, innerTable, dictionary]
const lengths: Record<string, string> = {
  MANDT: "000003",
  MSEHI: "000005",
  ZAEHL: "000010",
  FIELDNAME: "000030",
  DATATYPE: "000004",
  LENG: "000006",
  DECIMALS: "000006",
  TABNAME: "000030",
  AS4LOCAL: "000001"
}
const readerTypes: Record<string, string> = { DECIMALS: "N", LENG: "N", ZAEHL: "C" }

function harness() {
  const requests: RemoteFunctionRequest[] = []
  const backend = Object.assign(new MockBackend(), {
    runQuery: async () => {
      throw nativeError
    },
    callRemoteFunction: async (_connection: string, request: RemoteFunctionRequest) => {
      requests.push(request)
      const entry = tables.find(
        (candidate) => candidate.name === request.inputParameters.QUERY_TABLE
      )!
      const selected = (request.inputParameters.FIELDS as { FIELDNAME: string }[]).map(
        (field) => field.FIELDNAME
      )
      const names = selected.length ? selected : entry.fields
      let offset = 0
      const fields = names.map((FIELDNAME) => {
        const field = {
          FIELDNAME,
          TYPE: readerTypes[FIELDNAME] ?? "C",
          LENGTH: lengths[FIELDNAME]!,
          OFFSET: String(offset)
        }
        offset += Number(field.LENGTH) + 1
        return field
      })
      if (request.inputParameters.NO_DATA === "X") return { outputs: { FIELDS: fields, DATA: [] } }
      let rows = entry.rows
      for (const { TEXT } of (request.inputParameters.OPTIONS ?? []) as { TEXT: string }[]) {
        const match = TEXT.match(/^(?:AND )?([A-Z0-9_]+) = '((?:[^']|'')*)'$/)
        assert.ok(match, TEXT)
        rows = rows.filter((row) => String(row[match[1]! as keyof typeof row]) === match[2])
      }
      return {
        outputs: {
          FIELDS: fields,
          DATA: rows.slice(0, Number(request.inputParameters.ROWCOUNT)).map((row) => ({
            WA: fields
              .map((field) =>
                String(row[field.FIELDNAME as keyof typeof row]).padEnd(Number(field.LENGTH))
              )
              .join("|")
          }))
        }
      }
    }
  })
  const tools = new ToolService(backend)
  tools.readDdicTransparentTable = async (input: unknown) =>
    JSON.stringify({
      objectKind: "transparentTable",
      objectName: (input as { objectName: string }).objectName,
      fingerprint: "a".repeat(64),
      definition: {
        tableClass: "TRANSP",
        fields: tables
          .find((entry) => entry.name === (input as { objectName: string }).objectName)!
          .fields.map((name) => ({ name, key: name === "MANDT" }))
      }
    })
  tools.readFunctionModuleInterface = async (input: unknown) =>
    JSON.stringify(
      (input as { functionName: string }).functionName === legacy.functionName ? legacy : aligned
    )
  return { tools, requests }
}

function query(sql: string) {
  const { tools, requests } = harness()
  return {
    requests,
    run: () =>
      tools.executeDataQuery({
        connectionId: "w200",
        displayMode: "internal",
        sql,
        maxRows: 5,
        rowRange: { start: 0, end: 5 }
      })
  }
}

test("execute_data_query reads the inner statement and types both sides of the test", async () => {
  const { requests, run } = query("SELECT MSEHI FROM T006 WHERE MSEHI IN (SELECT MSEHI FROM T001)")
  const result = JSON.parse(await run())
  assert.deepEqual(result.data, [{ MSEHI: "1" }])
  assert.deepEqual(result.querySource.whereSubqueries, [
    {
      condition: "MSEHI IN (SELECT MSEHI FROM T001)",
      column: "MSEHI",
      negated: false,
      values: 1,
      disjunct: 0
    }
  ])
  // Two tables were typed, and each dictionary read is the one that table forced: without a set test
  // this statement never touches DD03L at all.
  const dictionary = requests.filter((request) => request.inputParameters.QUERY_TABLE === "DD03L")
  assert.equal(dictionary.length, 4, "one layout preflight and one read per typed table")
  const filters = requests
    .flatMap((request) => (request.inputParameters.OPTIONS ?? []) as { TEXT: string }[])
    .map((option) => option.TEXT)
  assert.equal(filters.filter((text) => text === "TABNAME = 'T006'").length, 1)
  assert.equal(filters.filter((text) => text === "TABNAME = 'T001'").length, 1)
  // The inner statement is a read of its own table, through the same reader, and it happens before the
  // outer read: the set has to exist before any row can be tested against it.
  const tablesRead = requests
    .filter((request) => request.inputParameters.NO_DATA !== "X")
    .map((request) => request.inputParameters.QUERY_TABLE)
    .filter((tableName) => tableName !== "DD03L")
  assert.deepEqual(tablesRead, ["T001", "T006"])
})

test("execute_data_query reads no dictionary for a statement without a set test", async () => {
  const { requests, run } = query("SELECT MSEHI FROM T006")
  const result = JSON.parse(await run())
  assert.equal(requests.filter((r) => r.inputParameters.QUERY_TABLE === "DD03L").length, 0)
  assert.deepEqual(result.data, [{ MSEHI: "1" }, { MSEHI: "2" }])
  assert.deepEqual(result.querySource.whereSubqueries, [])
})

test("execute_data_query refuses an inner statement that is not a set, through the real path", async () => {
  const { run } = query("SELECT MSEHI FROM T006 WHERE MSEHI IN (SELECT COUNT(*) FROM T001)")
  const message = await refusal(run())
  assert.match(message, /TABLE_QUERY_SUBQUERY_PROJECTION/)
})
