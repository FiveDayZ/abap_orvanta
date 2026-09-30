import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import {
  groupedReadColumns,
  parseGroupedTableSelect,
  readGroupedRows,
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

/** One read that returns the given rows and never truncates. */
const rowsFrom =
  (rows: Record<string, unknown>[]) =>
  async (): Promise<{
    rows: Record<string, unknown>[]
    truncated: boolean
    detail: Record<string, unknown>
  }> => ({
    rows: rows.map((row) => ({ ...row })),
    truncated: false,
    detail: {}
  })

describe("an arithmetic term in the projection", () => {
  it("is parsed into the statement and published under a derived column", () => {
    const parsed = select("SELECT MANDT, ZAEHL * 2 FROM T006")
    assert.equal(parsed.columns.length, 1)
    assert.equal(parsed.expressions.length, 1)
    assert.equal(parsed.expressions[0]!.text, "ZAEHL * 2")
    assert.equal(parsed.expressions[0]!.column, "EXPR_1")
    // A partial projection is still not an identity, so the term does not make the read whole-row.
    assert.equal(parsed.readWholeRow, false)
  })

  // The term reads columns the answer does not publish, so they have to be read anyway - without
  // them the term could not be computed at all.
  it("reads the columns the term names, not just the ones it publishes", () => {
    assert.deepEqual(groupedReadColumns(select("SELECT MANDT, ZAEHL * NENNR FROM T006")), [
      "MANDT",
      "ZAEHL",
      "NENNR"
    ])
  })

  it("computes each row from that row's own values, exactly", async () => {
    const parsed = select("SELECT MSEHI, ZAEHL * 2 FROM T006")
    const result = await readGroupedRows(
      parsed,
      rowsFrom([
        { MSEHI: "1", ZAEHL: "3" },
        { MSEHI: "10", ZAEHL: "86400" }
      ]),
      500,
      types({ ZAEHL: "INT4" })
    )
    assert.deepEqual(result.rows, [
      { MSEHI: "1", EXPR_1: "6" },
      { MSEHI: "10", EXPR_1: "172800" }
    ])
    assert.deepEqual(result.expressionColumns, [{ expression: "ZAEHL * 2", column: "EXPR_1" }])
  })

  // The term reads ZAEHL, so ZAEHL was read - and the answer holds exactly what the statement
  // selected, which is what the same projection without the term would hold.
  it("publishes the projection and not the columns read only for the term", async () => {
    const parsed = select("SELECT MSEHI, ZAEHL * 2 FROM T006")
    const result = await readGroupedRows(
      parsed,
      rowsFrom([{ MSEHI: "1", ZAEHL: "3" }]),
      500,
      types({ ZAEHL: "INT4" })
    )
    assert.deepEqual(Object.keys(result.rows[0]!).sort(), ["EXPR_1", "MSEHI"])
  })

  it("keeps a packed product to the sum of both scales", async () => {
    const parsed = select("SELECT ADDKO * 2.50 FROM T006")
    const result = await readGroupedRows(
      parsed,
      rowsFrom([{ ADDKO: "0.000001" }]),
      500,
      types({ ADDKO: "DEC" })
    )
    assert.equal(result.rows[0]!.EXPR_1, "0.00000250")
  })

  it("computes several terms in one statement under separate columns", async () => {
    const parsed = select("SELECT ZAEHL + 1, ZAEHL * 2 FROM T006")
    const result = await readGroupedRows(
      parsed,
      rowsFrom([{ ZAEHL: "4" }]),
      500,
      types({ ZAEHL: "INT4" })
    )
    assert.deepEqual(result.rows[0], { EXPR_1: "5", EXPR_2: "8" })
  })

  // The point of evaluating before the sort: `ORDER BY EXPR_1` orders the values the caller sees, and
  // the projection check accepts a derived column name because the statement publishes it. The read
  // returns 3, 1, 2, so an answer of 2, 4, 6 can only come from ordering the derived values.
  it("orders by a derived column", async () => {
    const parsed = select("SELECT ZAEHL * 2 FROM T006 ORDER BY EXPR_1")
    assert.equal(parsed.orderBy[0]!.column, "EXPR_1")
    const result = await readGroupedRows(
      parsed,
      rowsFrom([{ ZAEHL: "3" }, { ZAEHL: "1" }, { ZAEHL: "2" }]),
      500,
      types({ ZAEHL: "INT4" })
    )
    assert.deepEqual(
      result.rows.map((row) => row.EXPR_1),
      ["2", "4", "6"]
    )
  })

  it("applies LIMIT after the terms are computed", async () => {
    const parsed = select("SELECT ZAEHL * 10 FROM T006 LIMIT 2")
    const result = await readGroupedRows(
      parsed,
      rowsFrom([{ ZAEHL: "1" }, { ZAEHL: "2" }, { ZAEHL: "3" }]),
      500,
      types({ ZAEHL: "INT4" })
    )
    assert.equal(result.rows.length, 2)
    assert.deepEqual(
      result.rows.map((row) => row.EXPR_1),
      ["10", "20"]
    )
  })

  // A date is an integer to the calculation-type rule (d as i), so this is the documented answer and
  // not a date increment. Pinned so nobody "fixes" it into something SAP would not compute.
  it("computes a date as the integer its digits spell", async () => {
    const parsed = select("SELECT DATUM + 1 FROM T006")
    const result = await readGroupedRows(
      parsed,
      rowsFrom([{ DATUM: "20260930" }]),
      500,
      types({ DATUM: "DATS" })
    )
    assert.equal(result.rows[0]!.EXPR_1, "20260931")
  })
})

describe("what an arithmetic term refuses", () => {
  function refusal(sql: string, sql2?: string): string {
    try {
      select(sql2 ?? sql)
    } catch (error) {
      return (error as Error).message
    }
    throw new Error(`expected a refusal for: ${sql}`)
  }

  it("refuses a term that reads no column", () => {
    const message = refusal("SELECT 1 + 1 FROM T006")
    assert.match(message, /^TABLE_QUERY_EXPRESSION_CONSTANT:/)
    assert.match(message, /reads no column/)
  })

  it("refuses a term together with GROUP BY, where no single row defines it", () => {
    const message = refusal("SELECT ZAEHL, ZAEHL * 2 FROM T006 GROUP BY ZAEHL")
    assert.match(message, /^TABLE_QUERY_EXPRESSION_GROUPED:/)
    assert.match(message, /no single row/)
  })

  it("refuses a term together with an aggregate", () => {
    const message = refusal("SELECT COUNT(*), ZAEHL * 2 FROM T006")
    assert.match(message, /^TABLE_QUERY_EXPRESSION_GROUPED:/)
  })

  it("leaves a qualified term to the joined dialect instead of claiming it", () => {
    assert.equal(parseGroupedTableSelect("SELECT A.ZAEHL * 2 FROM T006 A"), undefined)
  })

  it("leaves a projection it cannot describe to the platform", () => {
    for (const sql of [
      "SELECT ZAEHL AS Z FROM T006",
      "SELECT ZAEHL + FROM T006",
      "SELECT ZAEHL % 2 FROM T006"
    ])
      assert.equal(parseGroupedTableSelect(sql), undefined, `${sql} should not be translated`)
  })

  // Arithmetic over columns moved into the dialect; arithmetic over or inside an aggregate did not,
  // and the refusal has to say exactly that rather than "arithmetic is not supported".
  it("refuses arithmetic around or inside an aggregate, naming the aggregate", () => {
    for (const sql of ["SELECT COUNT(*) + 1 FROM T006", "SELECT SUM(ZAEHL * 2) FROM T006"])
      assert.throws(
        () => parseGroupedTableSelect(sql),
        /TABLE_QUERY_AGGREGATE_FORM_UNSUPPORTED: (COUNT|SUM)/,
        sql
      )
  })

  it("refuses a term whose operand the dictionary does not type", async () => {
    const parsed = select("SELECT ZAEHL * 2 FROM T006")
    await assert.rejects(
      readGroupedRows(parsed, rowsFrom([{ ZAEHL: "3" }]), 500, types({})),
      /TABLE_QUERY_EXPRESSION_TYPE_UNKNOWN: .*ZAEHL/
    )
  })

  // Without a dictionary the calculation type would have to be guessed, and a guessed calculation
  // type is how a service answers a question nobody asked.
  it("refuses to compute at all when it has no operand types", async () => {
    const parsed = select("SELECT ZAEHL * 2 FROM T006")
    await assert.rejects(
      readGroupedRows(parsed, rowsFrom([{ ZAEHL: "3" }]), 500),
      /TABLE_QUERY_EXPRESSION_TYPE_UNAVAILABLE/
    )
  })

  it("refuses a value the calculation cannot use, naming the column", async () => {
    const parsed = select("SELECT MSEHI * 2 FROM T006")
    await assert.rejects(
      readGroupedRows(parsed, rowsFrom([{ MSEHI: "%" }]), 500, types({ MSEHI: "CHAR" })),
      /TABLE_QUERY_EXPRESSION_NOT_NUMERIC: column MSEHI holds "%"/
    )
  })

  // A floating point operand is refused for what it is, not for how the reader rendered it.
  it("refuses a floating point operand by name", async () => {
    const parsed = select("SELECT TEMP_VALUE * 2 FROM T006")
    await assert.rejects(
      readGroupedRows(
        parsed,
        rowsFrom([{ TEMP_VALUE: "0.000000000E+00" }]),
        500,
        types({ TEMP_VALUE: "FLTP" })
      ),
      /TABLE_QUERY_EXPRESSION_FLOAT: .*FLTP/
    )
  })

  // An incomplete read is refused for the reason the statement cannot be answered completely, not
  // for whatever its arithmetic happened to hit: the completeness check runs first.
  it("refuses an incomplete ordered read before it evaluates anything", async () => {
    const parsed = select("SELECT MSEHI, MSEHI * 2 FROM T006 ORDER BY MSEHI")
    await assert.rejects(
      readGroupedRows(
        parsed,
        async () => ({ rows: [{ MSEHI: "%" }], truncated: true, detail: {} }),
        1,
        types({ MSEHI: "CHAR" })
      ),
      /TABLE_QUERY_ORDER_BY_INCOMPLETE/
    )
  })
})
