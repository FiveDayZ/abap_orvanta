import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import {
  groupedReadColumns,
  parseGroupedTableSelect,
  pushableFilters,
  readGroupedRows,
  selectEvaluatesTerms,
  type GroupedTableSelect
} from "../src/table-query.js"
import { calculationTypeOf, type OperandType } from "../src/table-expression.js"

function select(sql: string): GroupedTableSelect {
  const parsed = parseGroupedTableSelect(sql)
  assert.ok(parsed, `expected a translation for: ${sql}`)
  return parsed
}

/** The dictionary as the tool layer would hand it over: DDIC type names, not reader codes. */
function types(fields: Record<string, string>): (column: string) => OperandType | undefined {
  const table = new Map<string, OperandType>()
  for (const [name, dataType] of Object.entries(fields)) {
    const calculationType = calculationTypeOf(dataType)
    assert.ok(calculationType, `${dataType} should classify`)
    table.set(name, { calculationType, dataType, decimals: 0 })
  }
  return (column) => table.get(column)
}

/** One read that returns the given rows; `filters` records what the statement pushed down. */
function readFrom(
  rows: Record<string, unknown>[],
  filters: unknown[] = [],
  truncated = false
): (pushed: unknown[]) => Promise<{
  rows: Record<string, unknown>[]
  truncated: boolean
  detail: Record<string, unknown>
}> {
  return async (pushed) => {
    filters.push(pushed)
    return { rows: rows.map((row) => ({ ...row })), truncated, detail: {} }
  }
}

const t006Types = types({
  MSEHI: "UNIT",
  ZAEHL: "INT4",
  NENNR: "INT4",
  ADDKO: "DEC",
  TEMP_VALUE: "FLTP"
})

describe("an arithmetic term in the WHERE clause", () => {
  // The reader's structured filter takes a column name, an operator and a literal: a term has no
  // column to name, so it cannot be pushed and is kept for this side of the read.
  it("is kept out of the pushed filters and reported as a term", () => {
    const parsed = select("SELECT MSEHI FROM T006 WHERE ZAEHL / 2 = 3")
    assert.equal(parsed.groups.length, 1)
    assert.equal(parsed.groups[0]!.length, 1)
    assert.deepEqual(pushableFilters(parsed.groups[0]!), [])
    const condition = parsed.groups[0]![0]!
    if (!condition || "column" in condition) throw new Error("expected a term condition")
    assert.equal(condition.text, "ZAEHL / 2")
    assert.equal(condition.operator, "EQ")
    assert.equal(condition.value, "3")
    assert.equal(selectEvaluatesTerms(parsed), true)
  })

  it("pushes the plain comparisons of the same conjunct and keeps only the term", () => {
    const parsed = select("SELECT MSEHI FROM T006 WHERE MSEHI = 'KG' AND ZAEHL / 2 = 0")
    assert.deepEqual(pushableFilters(parsed.groups[0]!), [
      { column: "MSEHI", operator: "EQ", value: "KG" }
    ])
    assert.equal(parsed.groups[0]!.length, 2)
  })

  // `OR` is a union of reads, so each branch carries its own term and the published map says which.
  it("keeps a term per disjunct", () => {
    const parsed = select("SELECT MSEHI FROM T006 WHERE ZAEHL / 2 = 0 OR ZAEHL * 2 = 4")
    assert.equal(parsed.groups.length, 2)
    assert.deepEqual(pushableFilters(parsed.groups[0]!), [])
    assert.deepEqual(pushableFilters(parsed.groups[1]!), [])
    const second = parsed.groups[1]![0]!
    if (!second || "column" in second) throw new Error("expected a term condition")
    assert.equal(second.text, "ZAEHL * 2")
  })

  // Reads the operands even though the answer publishes neither: without them the predicate could
  // not be decided at all.
  it("reads the columns the term names", () => {
    assert.deepEqual(groupedReadColumns(select("SELECT MSEHI FROM T006 WHERE ZAEHL / 2 = 3")), [
      "MSEHI",
      "ZAEHL"
    ])
  })

  it("filters rows with the term and drops its operands from the answer", async () => {
    const pushed: unknown[] = []
    const parsed = select("SELECT MSEHI FROM T006 WHERE ZAEHL / 2 = 3")
    const result = await readGroupedRows(
      parsed,
      // 5 / 2 is 3 under integer arithmetic (commercial rounding), 7 / 2 is 4.
      readFrom(
        [
          { MSEHI: "%", ZAEHL: "7" },
          { MSEHI: "KG", ZAEHL: "5" }
        ],
        pushed
      ),
      500,
      t006Types
    )
    assert.deepEqual(pushed, [[]])
    assert.deepEqual(result.rows, [{ MSEHI: "KG" }])
    assert.deepEqual(result.whereExpressions, [
      { expression: "ZAEHL / 2", operator: "EQ", value: "3", disjunct: 0 }
    ])
  })

  // Integer arithmetic rounds commercially, so `7 / 2` is `4` and not `3.5`: the comparison follows
  // the calculation type the dictionary gave, exactly as the projection does.
  it("compares the value the calculation type produces", async () => {
    const rows = [{ MSEHI: "A", ZAEHL: "7" }]
    const rounded = await readGroupedRows(
      select("SELECT MSEHI FROM T006 WHERE ZAEHL / 2 = 4"),
      readFrom(rows),
      500,
      t006Types
    )
    assert.deepEqual(rounded.rows, [{ MSEHI: "A" }])
    const truncated = await readGroupedRows(
      select("SELECT MSEHI FROM T006 WHERE ZAEHL / 2 = 3"),
      readFrom(rows),
      500,
      t006Types
    )
    assert.deepEqual(truncated.rows, [])
  })

  // The comparison is numeric over decimal text, never string equality: `3` and `3.0` are the same
  // number, and a caller who writes either means it.
  it("compares decimals as numbers, not as text", async () => {
    const result = await readGroupedRows(
      select("SELECT MSEHI FROM T006 WHERE ZAEHL / 2 = 3.0"),
      readFrom([{ MSEHI: "A", ZAEHL: "6" }]),
      500,
      t006Types
    )
    assert.deepEqual(result.rows, [{ MSEHI: "A" }])
  })

  it("decides the predicate before grouping, so an aggregate counts the matches", async () => {
    const result = await readGroupedRows(
      select("SELECT COUNT(*) FROM T006 WHERE ZAEHL / 2 = 3"),
      readFrom([
        { MSEHI: "A", ZAEHL: "5" },
        { MSEHI: "B", ZAEHL: "6" },
        { MSEHI: "C", ZAEHL: "7" }
      ]),
      500,
      t006Types
    )
    assert.deepEqual(result.rows, [{ COUNT: 2 }])
  })

  // A term read off a truncated page filters a sample; the matches of a sample are not the matches of
  // the statement, so it is refused rather than answered with a subset.
  it("refuses a term over a read that stopped at the row bound", async () => {
    await assert.rejects(
      readGroupedRows(
        select("SELECT MSEHI FROM T006 WHERE ZAEHL / 2 = 3"),
        readFrom([{ MSEHI: "A", ZAEHL: "7" }], [], true),
        500,
        t006Types
      ),
      /TABLE_QUERY_WHERE_EXPRESSION_INCOMPLETE: .*1 of 1 read\(s\) stopped at the 500-row bound.*Nothing was filtered/
    )
  })

  // The same truncated read without a term stays a disclosed page: membership is still exact, only
  // incomplete, which is what `incompleteBranches` reports.
  it("keeps reporting an incomplete read as a page when no term is decided here", async () => {
    const result = await readGroupedRows(
      select("SELECT MSEHI FROM T006 WHERE MSEHI = 'KG'"),
      readFrom([{ MSEHI: "KG" }], [], true),
      500,
      t006Types
    )
    assert.deepEqual(result.incompleteBranches, [0])
    assert.deepEqual(result.rows, [{ MSEHI: "KG" }])
  })

  // A row whose operand cannot be computed fails the statement: a row dropped because it could not be
  // read would be indistinguishable from a row that does not match.
  it("refuses the statement when a value cannot be computed, rather than dropping the row", async () => {
    await assert.rejects(
      readGroupedRows(
        select("SELECT MSEHI FROM T006 WHERE MSEHI * 2 = 4"),
        readFrom([{ MSEHI: "KG", ZAEHL: "1" }]),
        500,
        t006Types
      ),
      /TABLE_QUERY_EXPRESSION_NOT_NUMERIC: column MSEHI holds "KG"/
    )
  })

  it("refuses a floating point operand by name", async () => {
    await assert.rejects(
      readGroupedRows(
        select("SELECT MSEHI FROM T006 WHERE TEMP_VALUE * 2 > 1"),
        readFrom([{ MSEHI: "A", TEMP_VALUE: "0.000000000E+00" }]),
        500,
        t006Types
      ),
      /TABLE_QUERY_EXPRESSION_FLOAT/
    )
  })

  it("refuses a packed division by name", async () => {
    await assert.rejects(
      readGroupedRows(
        select("SELECT MSEHI FROM T006 WHERE ADDKO / 2 = 1"),
        readFrom([{ MSEHI: "A", ADDKO: "0.000000" }]),
        500,
        t006Types
      ),
      /TABLE_QUERY_EXPRESSION_DIVISION_SCALE/
    )
  })

  // Without the dictionary there is no calculation type, and inventing one would answer a different
  // question - even when the value alone would happen to give the same answer.
  it("refuses a term it cannot type", async () => {
    await assert.rejects(
      readGroupedRows(
        select("SELECT MSEHI FROM T006 WHERE ZAEHL / 2 = 3"),
        readFrom([{ MSEHI: "A", ZAEHL: "7" }]),
        500
      ),
      /TABLE_QUERY_EXPRESSION_TYPE_UNAVAILABLE: ZAEHL \/ 2 in the WHERE clause needs the SAP type of ZAEHL/
    )
    await assert.rejects(
      readGroupedRows(
        select("SELECT MSEHI FROM T006 WHERE MISSING / 2 = 3"),
        readFrom([{ MSEHI: "A", MISSING: "7" }]),
        500,
        t006Types
      ),
      /TABLE_QUERY_EXPRESSION_TYPE_UNKNOWN/
    )
  })

  it("needs no dictionary when the statement has no term at all", () => {
    assert.equal(selectEvaluatesTerms(select("SELECT MSEHI FROM T006 WHERE MSEHI = 'KG'")), false)
    assert.equal(selectEvaluatesTerms(select("SELECT MSEHI, ZAEHL * 2 FROM T006")), true)
  })
})

describe("WHERE forms this grammar does not claim", () => {
  // A bare column is the plain form's shape. The plain form declining one (a literal longer than the
  // reader accepts) must leave the statement untranslated, not reinterpret it as arithmetic.
  it("does not claim a bare column comparison", () => {
    assert.equal(
      parseGroupedTableSelect(`SELECT * FROM T WHERE A = '${"x".repeat(41)}'`),
      undefined
    )
    assert.equal(parseGroupedTableSelect("SELECT * FROM T WHERE (A) = 1"), undefined)
  })

  // Resolving a qualified name needs the join, so the joined dialect owns the statement.
  it("does not claim a qualified column", () => {
    assert.equal(
      parseGroupedTableSelect("SELECT A.X FROM A JOIN B ON A.X = B.X WHERE A.X * 2 = 4"),
      undefined
    )
  })

  it("refuses a term compared with something that is not a number", () => {
    assert.throws(
      () => parseGroupedTableSelect("SELECT MSEHI FROM T006 WHERE ZAEHL / 2 = 'x'"),
      /TABLE_QUERY_WHERE_EXPRESSION_LITERAL/
    )
  })

  it("refuses a term that reads no column", () => {
    assert.throws(
      () => parseGroupedTableSelect("SELECT MSEHI FROM T006 WHERE 1 + 1 = 2"),
      /TABLE_QUERY_EXPRESSION_CONSTANT/
    )
  })
})
