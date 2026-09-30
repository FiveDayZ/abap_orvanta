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
  type SelectScalarCondition
} from "../src/table-query.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"

// An uncorrelated scalar subquery, `X = (SELECT COUNT(*) FROM ...)`, is the last `WHERE` form the
// finite dialect adds. The reader's structured filter takes one column, one operator and one literal,
// and it cannot nest a read, so the comparison is decided here - over a read that completed - against
// a value that has to be *the* value of the inner statement: one row, exactly. These tests pin the
// grammar, the exactly-one-row rule, the comparison class both sides are placed in, and the wiring.

const type = (dataType: string, decimals = 0): OperandType => ({
  calculationType: calculationTypeOf(dataType)!,
  dataType,
  decimals
})

const types: Record<string, OperandType> = {
  MSEHI: type("CHAR"),
  WERKS: type("CHAR"),
  MATNR: type("NUMC"),
  ZAEHL: type("INT4"),
  ADDKO: type("DEC", 6),
  TEMP_VALUE: type("FLTP", 16),
  RAW16: type("RAW")
}

function scalarOf(sql: string): SelectScalarCondition {
  const select = parseGroupedTableSelect(sql)
  assert.ok(select, `not claimed: ${sql}`)
  const condition = select.groups[0]![0]!
  assert.ok("select" in condition, `not a scalar condition: ${sql}`)
  return condition as SelectScalarCondition
}

/** Merge one statement with hand-written branch and inner answers, so each rule is pinned alone. */
async function merge(
  sql: string,
  outer: { rows: Record<string, unknown>[]; truncated?: boolean },
  inner: {
    rows: Record<string, unknown>[]
    truncated?: boolean
    column: string
    type?: OperandType
  },
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
    undefined,
    async () => ({
      rows: inner.rows,
      truncated: inner.truncated === true,
      column: inner.column,
      type: inner.type
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

test("the grammar reads a scalar comparison as its own condition", () => {
  const condition = scalarOf("SELECT MSEHI FROM T006 WHERE ZAEHL = (SELECT COUNT(*) FROM T001)")
  assert.equal(condition.column, "ZAEHL")
  assert.equal(condition.operator, "EQ")
  // `COUNT(*)` has no dictionary column, which is what tells the refusal messages what to name.
  assert.equal(condition.valueColumn, null)
  assert.equal(condition.select.tableName, "T001")
  assert.equal(condition.text, "ZAEHL = (SELECT COUNT(*) FROM T001)")
  // The reader has no way to express this, so it is not a pushed filter.
  assert.deepEqual(pushableFilters([condition]), [])
  // The compared column has to be read even when the statement does not select it, and both sides
  // have to be typed from the dictionary before the first read.
  const projected = parseGroupedTableSelect(
    "SELECT MSEHI FROM T006 WHERE ZAEHL = (SELECT COUNT(*) FROM T001)"
  )!
  assert.deepEqual(groupedReadColumns(projected), ["MSEHI", "ZAEHL"])
  assert.equal(selectEvaluatesTerms(projected), true)
})

test("the grammar reads every comparison operator and an aggregate's own column", () => {
  for (const [operator, token] of [
    ["EQ", "="],
    ["NE", "<>"],
    ["LT", "<"],
    ["LE", "<="],
    ["GT", ">"],
    ["GE", ">="]
  ] as const) {
    const condition = scalarOf(
      `SELECT MSEHI FROM T006 WHERE ZAEHL ${token} (SELECT COUNT(*) FROM T001)`
    )
    assert.equal(condition.operator, operator)
  }
  const sum = scalarOf("SELECT MSEHI FROM T006 WHERE ADDKO = (SELECT SUM(ADDKO) FROM T001)")
  assert.equal(sum.valueColumn, "ADDKO")
  const counted = scalarOf("SELECT MSEHI FROM T006 WHERE ZAEHL = (SELECT COUNT(MSEHI) FROM T001)")
  assert.equal(counted.valueColumn, "MSEHI")
  const single = scalarOf("SELECT MSEHI FROM T006 WHERE MSEHI = (SELECT MSEHI FROM T001)")
  assert.equal(single.valueColumn, "MSEHI")
})

test("the grammar keeps a parenthesised term a term, and an IN test a set test", () => {
  // A parenthesised arithmetic term is not a scalar subquery: only `(SELECT ...)` is claimed here.
  const term = parseGroupedTableSelect("SELECT MSEHI FROM T006 WHERE (ZAEHL + 1) * 2 > 3")!
  assert.ok(!("select" in term.groups[0]![0]!))
  assert.ok(!("column" in term.groups[0]![0]!))
  const set = parseGroupedTableSelect(
    "SELECT MSEHI FROM T006 WHERE MSEHI IN (SELECT MSEHI FROM T001)"
  )!
  const condition = set.groups[0]![0]!
  assert.ok("negated" in condition)
  assert.ok(!("operator" in condition))
})

test("the grammar reads a scalar comparison followed by a conjunct and by a disjunct", () => {
  const select = parseGroupedTableSelect(
    "SELECT MSEHI FROM T006 WHERE ZAEHL = (SELECT COUNT(*) FROM T001) AND MSEHI = 'A' OR ZAEHL > (SELECT COUNT(*) FROM T001)"
  )
  assert.ok(select)
  assert.equal(select.groups.length, 2)
  assert.equal(select.groups[0]!.length, 2)
  assert.equal(select.groups[1]!.length, 1)
  assert.equal((select.groups[1]![0] as SelectScalarCondition).operator, "GT")
})

test("the grammar cuts the inner statement out by counting parentheses", () => {
  const condition = scalarOf(
    "SELECT MSEHI FROM T006 WHERE ZAEHL = (SELECT COUNT(*) FROM T001 WHERE MSEHI IN (SELECT MSEHI FROM T001)) AND MSEHI = 'A'"
  )
  assert.equal(condition.select.tableName, "T001")
  // The inner statement carries a set test of its own, and the conjunct after the closing parenthesis
  // belongs to the outer statement.
  const outer = parseGroupedTableSelect(
    "SELECT MSEHI FROM T006 WHERE ZAEHL = (SELECT COUNT(*) FROM T001 WHERE MSEHI IN (SELECT MSEHI FROM T001)) AND MSEHI = 'A'"
  )!
  assert.equal(outer.groups[0]!.length, 2)
})

test("the grammar refuses an inner statement that is not one value", async () => {
  const projection = (sql: string) => refusal(Promise.resolve().then(() => scalarOf(sql)))
  assert.match(
    await projection("SELECT MSEHI FROM T006 WHERE ZAEHL = (SELECT MSEHI, WERKS FROM T001)"),
    /TABLE_QUERY_SCALAR_PROJECTION/
  )
  assert.match(
    await projection("SELECT MSEHI FROM T006 WHERE ZAEHL = (SELECT * FROM T001)"),
    /TABLE_QUERY_SCALAR_PROJECTION/
  )
  assert.match(
    await projection("SELECT MSEHI FROM T006 WHERE ZAEHL = (SELECT ZAEHL + 1 FROM T001)"),
    /TABLE_QUERY_SCALAR_PROJECTION|TABLE_QUERY_SCALAR_UNSUPPORTED/
  )
})

test("the grammar refuses a limited, an ordered and an untranslatable inner statement", async () => {
  const projection = (sql: string) => refusal(Promise.resolve().then(() => scalarOf(sql)))
  assert.match(
    await projection("SELECT MSEHI FROM T006 WHERE ZAEHL = (SELECT ZAEHL FROM T001 LIMIT 1)"),
    /TABLE_QUERY_SCALAR_PAGE/
  )
  assert.match(
    await projection(
      "SELECT MSEHI FROM T006 WHERE ZAEHL = (SELECT ZAEHL FROM T001 ORDER BY ZAEHL)"
    ),
    /TABLE_QUERY_SCALAR_PAGE/
  )
  assert.match(
    await projection(
      "SELECT MSEHI FROM T006 WHERE ZAEHL = (SELECT COUNT(*) FROM T001 HAVING COUNT(*) > 1)"
    ),
    /TABLE_QUERY_SCALAR_UNSUPPORTED/
  )
})

test("the grammar refuses a scalar nested deeper than the depth limit", async () => {
  const nested =
    "SELECT MSEHI FROM T006 WHERE ZAEHL = (SELECT COUNT(*) FROM T001 WHERE ZAEHL = " +
    "(SELECT COUNT(*) FROM T001 WHERE ZAEHL = (SELECT COUNT(*) FROM T001)))"
  const message = await refusal(Promise.resolve().then(() => parseGroupedTableSelect(nested)))
  assert.match(message, /TABLE_QUERY_SCALAR_DEPTH/)
})

test("a numeric scalar comparison decides every row, exactly", async () => {
  const sql = "SELECT MSEHI FROM T006 WHERE ZAEHL >= (SELECT COUNT(*) FROM T001)"
  const result = await merge(
    sql,
    {
      rows: [
        { MSEHI: "A", ZAEHL: "7" },
        { MSEHI: "B", ZAEHL: "2" }
      ]
    },
    { rows: [{ COUNT: "3" }], column: "COUNT", type: type("INT4") }
  )
  assert.deepEqual(result.rows, [{ MSEHI: "A" }])
  // The compared column was read and dropped again: it is evidence for the predicate, not selected.
  const equal = await merge(
    "SELECT MSEHI FROM T006 WHERE ZAEHL = (SELECT COUNT(*) FROM T001)",
    {
      rows: [
        { MSEHI: "A", ZAEHL: "3" },
        { MSEHI: "B", ZAEHL: "2" }
      ]
    },
    { rows: [{ COUNT: "3" }], column: "COUNT", type: type("INT4") }
  )
  assert.deepEqual(equal.rows, [{ MSEHI: "A" }])
  const notEqual = await merge(
    "SELECT MSEHI FROM T006 WHERE ZAEHL <> (SELECT COUNT(*) FROM T001)",
    {
      rows: [
        { MSEHI: "A", ZAEHL: "3" },
        { MSEHI: "B", ZAEHL: "2" }
      ]
    },
    { rows: [{ COUNT: "3" }], column: "COUNT", type: type("INT4") }
  )
  assert.deepEqual(notEqual.rows, [{ MSEHI: "B" }])
  // A numeric field is compared as the number, not as the text the reader printed: the reader pads a
  // numeric field, so `' 7'` and the count `'7'` are the same value. A text comparison would drop
  // this row instead of answering it.
  const padded = await merge(
    "SELECT MSEHI FROM T006 WHERE ZAEHL = (SELECT COUNT(*) FROM T001)",
    {
      rows: [
        { MSEHI: "A", ZAEHL: " 7" },
        { MSEHI: "B", ZAEHL: " 8" }
      ]
    },
    { rows: [{ COUNT: "7" }], column: "COUNT", type: type("INT4") }
  )
  assert.deepEqual(padded.rows, [{ MSEHI: "A" }])
  // Printed order and numeric order disagree for these two (`'10'` sorts before `'9'` as text), so a
  // comparison over the printed text would answer the opposite row.
  const multiDigit = await merge(
    "SELECT MSEHI FROM T006 WHERE ZAEHL > (SELECT COUNT(*) FROM T001)",
    {
      rows: [
        { MSEHI: "A", ZAEHL: "10" },
        { MSEHI: "B", ZAEHL: "9" }
      ]
    },
    { rows: [{ COUNT: "9" }], column: "COUNT", type: type("INT4") }
  )
  assert.deepEqual(multiDigit.rows, [{ MSEHI: "A" }])
})

test("a packed scalar is compared as an exact decimal, not as text", async () => {
  const result = await merge(
    "SELECT MSEHI FROM T006 WHERE ADDKO > (SELECT SUM(ADDKO) FROM T001)",
    {
      rows: [
        { MSEHI: "A", ADDKO: "1.000000" },
        { MSEHI: "B", ADDKO: "0.500000" }
      ]
    },
    { rows: [{ SUM_ADDKO: "0.500000" }], column: "SUM_ADDKO", type: type("DEC", 6) }
  )
  assert.deepEqual(result.rows, [{ MSEHI: "A" }])
})

test("a character scalar compares with trailing blanks ignored", async () => {
  // The two sides are printed over their own declared lengths: the outer field is `CHAR(3)` and the
  // inner one `CHAR(1)`, so the same value arrives padded differently. SAP ignores trailing blanks, so
  // this is a match; a text comparison would report no such value.
  const result = await merge(
    "SELECT ZAEHL FROM T006 WHERE MSEHI = (SELECT MSEHI FROM T001)",
    {
      rows: [
        { MSEHI: "1  ", ZAEHL: "7" },
        { MSEHI: "2  ", ZAEHL: "3" }
      ]
    },
    { rows: [{ MSEHI: "1" }], column: "MSEHI", type: type("CHAR") }
  )
  assert.deepEqual(result.rows, [{ ZAEHL: "7" }])
})

test("the comparison class comes from both dictionary types, and a mismatch is refused", async () => {
  const mismatch = await refusal(
    merge(
      "SELECT MSEHI FROM T006 WHERE MSEHI = (SELECT ZAEHL FROM T001)",
      { rows: [{ MSEHI: "1", ZAEHL: "7" }] },
      { rows: [{ ZAEHL: "7" }], column: "ZAEHL", type: type("INT4") }
    )
  )
  assert.match(mismatch, /TABLE_QUERY_SCALAR_TYPE/)
  const float = await refusal(
    merge(
      "SELECT MSEHI FROM T006 WHERE TEMP_VALUE = (SELECT COUNT(*) FROM T001)",
      { rows: [{ MSEHI: "1", TEMP_VALUE: "1.5" }] },
      { rows: [{ COUNT: "3" }], column: "COUNT", type: type("INT4") }
    )
  )
  assert.match(float, /TABLE_QUERY_SCALAR_FLOAT/)
  const unplaceable = await refusal(
    merge(
      "SELECT MSEHI FROM T006 WHERE RAW16 = (SELECT COUNT(*) FROM T001)",
      { rows: [{ MSEHI: "1", RAW16: "0000" }] },
      { rows: [{ COUNT: "3" }], column: "COUNT", type: type("INT4") }
    )
  )
  assert.match(unplaceable, /TABLE_QUERY_SCALAR_TYPE/)
  // Two sides that are in *neither* class are refused as well: the class is what decides how SAP
  // compares two fields, so a pair this layer cannot place is not compared by falling back to text.
  const neither = await refusal(
    merge(
      "SELECT MSEHI FROM T006 WHERE RAW16 = (SELECT RAW16 FROM T001)",
      { rows: [{ MSEHI: "1", RAW16: "0000" }] },
      { rows: [{ RAW16: "0000" }], column: "RAW16", type: type("RAW") }
    )
  )
  assert.match(neither, /TABLE_QUERY_SCALAR_TYPE/)
  const unknown = await refusal(
    merge(
      "SELECT MSEHI FROM T006 WHERE NOSUCH = (SELECT COUNT(*) FROM T001)",
      { rows: [{ MSEHI: "1" }] },
      { rows: [{ COUNT: "3" }], column: "COUNT", type: type("INT4") }
    )
  )
  assert.match(unknown, /TABLE_QUERY_SCALAR_TYPE_UNKNOWN/)
})

test("ordering a character value is refused, and equality is not", async () => {
  const ordering = await refusal(
    merge(
      "SELECT ZAEHL FROM T006 WHERE MSEHI < (SELECT MSEHI FROM T001)",
      { rows: [{ MSEHI: "1", ZAEHL: "7" }] },
      { rows: [{ MSEHI: "1" }], column: "MSEHI", type: type("CHAR") }
    )
  )
  assert.match(ordering, /TABLE_QUERY_SCALAR_ORDER/)
  const equality = await merge(
    "SELECT ZAEHL FROM T006 WHERE MSEHI <> (SELECT MSEHI FROM T001)",
    {
      rows: [
        { MSEHI: "1", ZAEHL: "7" },
        { MSEHI: "2", ZAEHL: "3" }
      ]
    },
    { rows: [{ MSEHI: "1" }], column: "MSEHI", type: type("CHAR") }
  )
  assert.deepEqual(equality.rows, [{ ZAEHL: "3" }])
})

test("an inner statement that is a sample, or has no single row, is refused", async () => {
  const truncated = await refusal(
    merge(
      "SELECT MSEHI FROM T006 WHERE ZAEHL = (SELECT ZAEHL FROM T001)",
      { rows: [{ MSEHI: "1", ZAEHL: "7" }] },
      { rows: [{ ZAEHL: "7" }], truncated: true, column: "ZAEHL", type: type("INT4") }
    )
  )
  assert.match(truncated, /TABLE_QUERY_SCALAR_INCOMPLETE/)
  const several = await refusal(
    merge(
      "SELECT MSEHI FROM T006 WHERE ZAEHL = (SELECT ZAEHL FROM T001)",
      { rows: [{ MSEHI: "1", ZAEHL: "7" }] },
      {
        rows: [{ ZAEHL: "7" }, { ZAEHL: "8" }],
        column: "ZAEHL",
        type: type("INT4")
      }
    )
  )
  assert.match(several, /TABLE_QUERY_SCALAR_ROWS/)
  assert.match(several, /answered 2 rows/)
  // No row at all is refused too: SQL reads that as NULL and answers "unknown", a three-valued rule
  // this layer does not reproduce - it does not read it as "no value, so nothing matches".
  const noRow = await refusal(
    merge(
      "SELECT MSEHI FROM T006 WHERE ZAEHL = (SELECT ZAEHL FROM T001)",
      { rows: [{ MSEHI: "1", ZAEHL: "7" }] },
      { rows: [], column: "ZAEHL", type: type("INT4") }
    )
  )
  assert.match(noRow, /TABLE_QUERY_SCALAR_ROWS/)
  assert.match(noRow, /answered no row/)
  const none = await refusal(
    merge(
      "SELECT MSEHI FROM T006 WHERE ZAEHL = (SELECT SUM(ZAEHL) FROM T001)",
      { rows: [{ MSEHI: "1", ZAEHL: "7" }] },
      { rows: [{ SUM_ZAEHL: "" }], column: "SUM_ZAEHL", type: type("INT4") }
    )
  )
  assert.match(none, /TABLE_QUERY_SCALAR_VALUE/)
})

test("a scalar decided over a truncated outer read is refused, not filtered", async () => {
  const message = await refusal(
    merge(
      "SELECT MSEHI FROM T006 WHERE ZAEHL = (SELECT COUNT(*) FROM T001)",
      { rows: [{ MSEHI: "1", ZAEHL: "3" }], truncated: true },
      { rows: [{ COUNT: "3" }], column: "COUNT", type: type("INT4") }
    )
  )
  assert.match(message, /TABLE_QUERY_WHERE_SCALAR_INCOMPLETE/)
})

test("the answer publishes which scalar comparison ran and what it compared with", async () => {
  const result = await merge(
    "SELECT MSEHI FROM T006 WHERE ZAEHL = (SELECT COUNT(*) FROM T001)",
    { rows: [{ MSEHI: "1", ZAEHL: "3" }] },
    { rows: [{ COUNT: "3" }], column: "COUNT", type: type("INT4") }
  )
  assert.deepEqual(result.whereScalars, [
    {
      condition: "ZAEHL = (SELECT COUNT(*) FROM T001)",
      column: "ZAEHL",
      operator: "EQ",
      value: "3",
      valueColumn: null,
      disjunct: 0
    }
  ])
  const none = await merge(
    "SELECT MSEHI FROM T006 WHERE MSEHI = '1'",
    { rows: [{ MSEHI: "1", ZAEHL: "3" }] },
    { rows: [], column: "COUNT", type: type("INT4") }
  )
  assert.deepEqual(none.whereScalars, [])
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
  rows: [
    { MANDT: "200", MSEHI: "1", ZAEHL: "7" },
    { MANDT: "200", MSEHI: "2", ZAEHL: "3" }
  ]
}
const innerTable: FakeTable = {
  name: "T001",
  fields: ["MANDT", "MSEHI", "ZAEHL"],
  rows: [
    { MANDT: "200", MSEHI: "1", ZAEHL: "3" },
    { MANDT: "200", MSEHI: "1", ZAEHL: "4" },
    { MANDT: "200", MSEHI: "2", ZAEHL: "5" }
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
    {
      FIELDNAME: "MSEHI",
      DATATYPE: "CHAR",
      LENG: "000003",
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
  MSEHI: "000003",
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
        maxRows: 10,
        rowRange: { start: 0, end: 10 }
      })
  }
}

test("execute_data_query reads the inner statement and types both sides of a scalar comparison", async () => {
  const { requests, run } = query(
    "SELECT MSEHI FROM T006 WHERE ZAEHL = (SELECT COUNT(*) FROM T001)"
  )
  const result = JSON.parse(await run())
  assert.deepEqual(result.data, [{ MSEHI: "2" }])
  assert.deepEqual(result.querySource.whereScalars, [
    {
      condition: "ZAEHL = (SELECT COUNT(*) FROM T001)",
      column: "ZAEHL",
      operator: "EQ",
      value: "3",
      valueColumn: null,
      disjunct: 0
    }
  ])
  const filters = requests
    .flatMap((request) => (request.inputParameters.OPTIONS ?? []) as { TEXT: string }[])
    .map((option) => option.TEXT)
  assert.equal(filters.filter((text) => text === "TABNAME = 'T006'").length, 1)
  assert.equal(filters.filter((text) => text === "TABNAME = 'T001'").length, 1)
  // The inner statement is read first: the value has to exist before any outer row is tested.
  const tablesRead = requests
    .filter((request) => request.inputParameters.NO_DATA !== "X")
    .map((request) => request.inputParameters.QUERY_TABLE)
    .filter((tableName) => tableName !== "DD03L")
  assert.deepEqual(tablesRead, ["T001", "T006"])
})

test("execute_data_query refuses an inner statement with several rows, through the real path", async () => {
  const { run } = query("SELECT MSEHI FROM T006 WHERE ZAEHL = (SELECT ZAEHL FROM T001)")
  const message = await refusal(run())
  assert.match(message, /TABLE_QUERY_SCALAR_ROWS/)
  assert.match(message, /answered 3 rows/)
})

test("execute_data_query reads no dictionary and publishes no scalar for a plain statement", async () => {
  const { requests, run } = query("SELECT MSEHI FROM T006 WHERE MSEHI = '1'")
  const result = JSON.parse(await run())
  assert.equal(requests.filter((r) => r.inputParameters.QUERY_TABLE === "DD03L").length, 0)
  assert.deepEqual(result.data, [{ MSEHI: "1" }])
  assert.deepEqual(result.querySource.whereScalars, [])
})
