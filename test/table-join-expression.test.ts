import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  parseJoinedTableSelect,
  readJoinedRows,
  type JoinedReadBranch,
  type JoinedTableSelect
} from "../src/table-query.js"
import { calculationTypeOf, type OperandType } from "../src/table-expression.js"

function parse(sql: string): JoinedTableSelect {
  const parsed = parseJoinedTableSelect(sql)
  assert.ok(parsed, `expected a translation for: ${sql}`)
  return parsed
}

/** The dictionary as the tool layer hands it over: keyed by the qualified name the term used. */
function types(fields: Record<string, string>): {
  resolve: (column: string) => OperandType | undefined
  asked: string[]
} {
  const table = new Map<string, OperandType>()
  for (const [name, dataType] of Object.entries(fields)) {
    const calculationType = calculationTypeOf(dataType)
    assert.ok(calculationType, `${dataType} should classify`)
    table.set(name, { calculationType, dataType, decimals: 0 })
  }
  const asked: string[] = []
  return {
    asked,
    resolve: (column) => {
      asked.push(column)
      return table.get(column)
    }
  }
}

/** A scripted reader: one entry per table, plus the read requests it received. */
function readerFor(tables: Record<string, { columns: string[]; rows: string[][] }>) {
  const calls: Array<{ tableName: string; columns: string[]; filters: unknown[] }> = []
  const truncated = new Set<string>()
  const read = async (
    tableName: string,
    columns: string[],
    filters: Array<{ column: string; operator: string; value: string }>
  ): Promise<JoinedReadBranch> => {
    calls.push({ tableName, columns, filters })
    const table = tables[tableName]
    assert.ok(table, `unexpected table read: ${tableName}`)
    const rows = table.rows
      .filter((row) =>
        filters.every((filter) => {
          const value = row[table.columns.indexOf(filter.column)] ?? ""
          return filter.operator === "EQ" ? value === filter.value : true
        })
      )
      .map((row) =>
        Object.fromEntries(columns.map((c) => [c, row[table.columns.indexOf(c)] ?? ""]))
      )
    return { rows, truncated: truncated.has(tableName), detail: { table: tableName } }
  }
  return { read, calls, truncated }
}

const T006 = {
  T006: { columns: ["MANDT", "MSEHI", "ZAEHL", "ADDKO"], rows: [["200", "KG", "7", "0.000000"]] },
  T001: { columns: ["MANDT", "BUTXT"], rows: [["200", "Orvanta"]] }
}

const joined = (sql: string) => parse(sql)

test("a term over a qualified column is parsed into the joined projection", () => {
  const parsed = joined(
    "SELECT A.ZAEHL / 2, B.BUTXT FROM T006 A INNER JOIN T001 B ON A.MANDT = B.MANDT"
  )
  assert.deepEqual(parsed.columns, ["B.BUTXT"])
  assert.equal(parsed.expressions.length, 1)
  assert.equal(parsed.expressions[0]!.text, "A.ZAEHL / 2")
  assert.equal(parsed.expressions[0]!.column, "EXPR_1")
})

// A bare qualified column is a column, not a term, no matter that it parses as an arithmetic primary.
test("a bare qualified column is still a selected column", () => {
  const parsed = joined(
    "SELECT A.ZAEHL, B.BUTXT FROM T006 A INNER JOIN T001 B ON A.MANDT = B.MANDT"
  )
  assert.deepEqual(parsed.columns, ["A.ZAEHL", "B.BUTXT"])
  assert.deepEqual(parsed.expressions, [])
})

test("a term's own references are qualified and checked like every other reference", () => {
  assert.throws(
    () => joined("SELECT ZAEHL / 2, B.BUTXT FROM T006 A INNER JOIN T001 B ON A.MANDT = B.MANDT"),
    /TABLE_QUERY_JOIN_COLUMN_UNQUALIFIED/
  )
  assert.throws(
    () => joined("SELECT C.ZAEHL / 2 FROM T006 A INNER JOIN T001 B ON A.MANDT = B.MANDT"),
    /TABLE_QUERY_JOIN_ALIAS_UNKNOWN: C\.ZAEHL/
  )
})

// A grouped answer has no single row to evaluate a term on, exactly as on the single-table path.
test("a term is refused together with an aggregate or a GROUP BY", () => {
  assert.throws(
    () => joined("SELECT COUNT(*), A.ZAEHL / 2 FROM T006 A INNER JOIN T001 B ON A.MANDT = B.MANDT"),
    /TABLE_QUERY_EXPRESSION_GROUPED/
  )
  assert.throws(
    () =>
      joined(
        "SELECT A.ZAEHL / 2, B.BUTXT FROM T006 A INNER JOIN T001 B ON A.MANDT = B.MANDT " +
          "GROUP BY A.ZAEHL, B.BUTXT"
      ),
    /TABLE_QUERY_EXPRESSION_GROUPED/
  )
})

// A projection that reads no column at all would publish one constant for every joined row, which is
// not what a table read is for. A constant term beside a real column is fine - the answer still says
// something about the tables - and that is exactly the rule the single-table path applies.
test("a term that reads no column is refused only when nothing else is selected", () => {
  assert.throws(
    () => joined("SELECT 1 + 1 FROM T006 A INNER JOIN T001 B ON A.MANDT = B.MANDT"),
    /TABLE_QUERY_EXPRESSION_CONSTANT/
  )
  const withColumn = joined(
    "SELECT 1 + 1, B.BUTXT FROM T006 A INNER JOIN T001 B ON A.MANDT = B.MANDT"
  )
  assert.deepEqual(withColumn.columns, ["B.BUTXT"])
  assert.equal(withColumn.expressions.length, 1)
})

// `ORDER BY EXPR_1` is not part of the joined ORDER BY grammar (every key there is qualified), so the
// statement stays untranslated rather than being sorted by something the caller did not name. This is
// a known limit of the joined dialect, not a silent reinterpretation.
test("the joined dialect does not claim ORDER BY of a derived column", () => {
  assert.equal(
    parseJoinedTableSelect(
      "SELECT A.ZAEHL / 2 FROM T006 A INNER JOIN T001 B ON A.MANDT = B.MANDT ORDER BY EXPR_1"
    ),
    undefined
  )
})

test("the operand is read, the derived column is published, and the operand is not", async () => {
  const scripted = readerFor(T006)
  const result = await readJoinedRows(
    joined("SELECT A.ZAEHL / 2, B.BUTXT FROM T006 A INNER JOIN T001 B ON A.MANDT = B.MANDT"),
    scripted.read,
    500,
    types({ "A.ZAEHL": "INT4" }).resolve
  )
  assert.deepEqual([...scripted.calls[0]!.columns].sort(), ["MANDT", "ZAEHL"])
  // 7 / 2 is 4 under integer arithmetic, and the answer holds the derived column - not ZAEHL, which
  // was read only because the term needed it.
  assert.deepEqual(result.rows, [{ "B.BUTXT": "Orvanta", EXPR_1: "4" }])
  assert.deepEqual(result.expressionColumns, [{ expression: "A.ZAEHL / 2", column: "EXPR_1" }])
})

// The operand of an integer term decides the answer: the same statement over the same row answers 4
// and not 3.5, and that is the calculation type the dictionary gave, not a guess from the value.
test("the value follows the type the dictionary gave the qualified operand", async () => {
  const scripted = readerFor(T006)
  const resolver = types({ "A.ZAEHL": "INT4" })
  const result = await readJoinedRows(
    joined("SELECT A.ZAEHL / 2 FROM T006 A INNER JOIN T001 B ON A.MANDT = B.MANDT"),
    scripted.read,
    500,
    resolver.resolve
  )
  assert.deepEqual(result.rows, [{ EXPR_1: "4" }])
  // The resolver is asked for the qualified name, so a term cannot be typed by the wrong table's
  // field of the same name.
  assert.deepEqual([...new Set(resolver.asked)], ["A.ZAEHL"])
})

test("each operand is typed by its own alias's table", async () => {
  const scripted = readerFor(T006)
  const resolver = types({ "A.ZAEHL": "INT4", "B.MANDT": "NUMC" })
  const result = await readJoinedRows(
    joined("SELECT A.ZAEHL / 2, B.MANDT * 1 FROM T006 A INNER JOIN T001 B ON A.MANDT = B.MANDT"),
    scripted.read,
    500,
    resolver.resolve
  )
  assert.deepEqual([...new Set(resolver.asked)].sort(), ["A.ZAEHL", "B.MANDT"])
  // NUMC is character-like, so `B.MANDT * 1` is packed arithmetic: `200` stays `200`.
  assert.deepEqual(result.rows, [{ EXPR_1: "4", EXPR_2: "200" }])
})

// Without the dictionary there is no calculation type, and inventing one would answer a different
// question - even when the value alone would happen to give the same answer.
test("a term that cannot be typed is refused by name", async () => {
  const scripted = readerFor(T006)
  await assert.rejects(
    readJoinedRows(
      joined("SELECT A.ZAEHL / 2 FROM T006 A INNER JOIN T001 B ON A.MANDT = B.MANDT"),
      scripted.read,
      500
    ),
    /TABLE_QUERY_EXPRESSION_TYPE_UNAVAILABLE: A\.ZAEHL \/ 2 needs the SAP type of A\.ZAEHL/
  )
  await assert.rejects(
    readJoinedRows(
      joined("SELECT A.MSEHI * 2 FROM T006 A INNER JOIN T001 B ON A.MANDT = B.MANDT"),
      scripted.read,
      500,
      types({ "A.ZAEHL": "INT4" }).resolve
    ),
    /TABLE_QUERY_EXPRESSION_TYPE_UNKNOWN/
  )
})

test("a value that cannot be computed refuses the statement rather than dropping the row", async () => {
  const scripted = readerFor(T006)
  await assert.rejects(
    readJoinedRows(
      joined("SELECT A.MSEHI * 2 FROM T006 A INNER JOIN T001 B ON A.MANDT = B.MANDT"),
      scripted.read,
      500,
      types({ "A.MSEHI": "UNIT" }).resolve
    ),
    /TABLE_QUERY_EXPRESSION_NOT_NUMERIC: column A\.MSEHI holds "KG"/
  )
  await assert.rejects(
    readJoinedRows(
      joined("SELECT A.ADDKO / 2 FROM T006 A INNER JOIN T001 B ON A.MANDT = B.MANDT"),
      scripted.read,
      500,
      types({ "A.ADDKO": "DEC" }).resolve
    ),
    /TABLE_QUERY_EXPRESSION_DIVISION_SCALE/
  )
})

// An unmatched outer-join row carries the reader's own empty value on the optional side, and a term
// cannot be computed from it. Reporting 0 would be a number the table never held, so the statement is
// refused - the same exact-or-refuse rule, applied to the row the join produced.
test("a term over the optional side of an outer join refuses the unmatched row", async () => {
  const scripted = readerFor({
    T006: {
      columns: ["MANDT", "ZAEHL"],
      rows: [
        ["200", "7"],
        ["300", "5"]
      ]
    },
    T001: { columns: ["MANDT", "BUTXT"], rows: [["200", "Orvanta"]] }
  })
  await assert.rejects(
    readJoinedRows(
      joined("SELECT B.BUTXT, B.MANDT * 1 FROM T006 A LEFT JOIN T001 B ON A.MANDT = B.MANDT"),
      scripted.read,
      500,
      types({ "B.MANDT": "NUMC" }).resolve
    ),
    /TABLE_QUERY_EXPRESSION_NOT_NUMERIC: column B\.MANDT holds ""/
  )
})

// A page is not a wrong answer for a term: every row that came back carries its own exact value, and
// `truncated` says the page is not the whole match set. This is where a projected term differs from a
// term in `WHERE`, which decides membership and therefore needs the complete read.
test("a term over a truncated join is computed for the rows that came back", async () => {
  const scripted = readerFor(T006)
  scripted.truncated.add("T006")
  const result = await readJoinedRows(
    joined("SELECT A.ZAEHL / 2 FROM T006 A INNER JOIN T001 B ON A.MANDT = B.MANDT"),
    scripted.read,
    500,
    types({ "A.ZAEHL": "INT4" }).resolve
  )
  assert.equal(result.truncated, true)
  assert.deepEqual(result.rows, [{ EXPR_1: "4" }])
})
