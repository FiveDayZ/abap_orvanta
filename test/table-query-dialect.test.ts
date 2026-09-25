import assert from "node:assert/strict"
import test from "node:test"
import {
  branchRowKey,
  parseGroupedTableSelect,
  readGroupedRows,
  sortRowsByColumns
} from "../src/table-query.js"

const select = (sql: string) => {
  const parsed = parseGroupedTableSelect(sql)
  assert.ok(parsed, `expected the grammar to describe: ${sql}`)
  return parsed
}

const refuse = (sql: string) => {
  assert.equal(parseGroupedTableSelect(sql), undefined, `expected a refusal for: ${sql}`)
}

test("the grammar reads one conjunct, disjuncts and an ordering", () => {
  // The single-conjunct statement is the shape the fallback path has always pushed down.
  assert.deepEqual(select("SELECT * FROM TBTCO WHERE STATUS = 'F'"), {
    tableName: "TBTCO",
    columns: ["*"],
    groups: [[{ column: "STATUS", operator: "EQ", value: "F" }]],
    orderBy: []
  })

  // `OR` of `AND`s: no parentheses, so no precedence rule has to be invented.
  assert.deepEqual(
    select(
      "SELECT MANDT, JOBNUM FROM TBTCO WHERE SDATE = '20260925' AND STATUS = 'F' OR STATUS = 'A'"
    ),
    {
      tableName: "TBTCO",
      columns: ["MANDT", "JOBNUM"],
      groups: [
        [
          { column: "SDATE", operator: "EQ", value: "20260925" },
          { column: "STATUS", operator: "EQ", value: "F" }
        ],
        [{ column: "STATUS", operator: "EQ", value: "A" }]
      ],
      orderBy: []
    }
  )

  // Every operator the reader accepts, longest token first: `<=` must never be read as `<`.
  const operators = select(
    "SELECT * FROM T WHERE A <= '1' AND B >= '2' AND C <> '3' AND D = '4' AND E < '5' AND F > '6'"
  ).groups[0]!
  assert.deepEqual(
    operators.map((filter) => filter.operator),
    ["LE", "GE", "NE", "EQ", "LT", "GT"]
  )
})

test("the grammar reads ORDER BY with its keys, directions and a missing WHERE", () => {
  assert.deepEqual(
    select("SELECT * FROM TBTCO WHERE STATUS = 'F' ORDER BY SDATE DESC, JOBNUM").orderBy,
    [
      { column: "SDATE", direction: "desc" },
      { column: "JOBNUM", direction: "asc" }
    ]
  )
  // Without a WHERE the statement is a bounded read of the table, which the reader supports.
  assert.deepEqual(select("SELECT MANDT FROM T000 ORDER BY MTEXT"), {
    tableName: "T000",
    columns: ["MANDT"],
    groups: [[]],
    orderBy: [{ column: "MTEXT", direction: "asc" }]
  })
  assert.deepEqual(select("SELECT MANDT FROM T000").groups, [[]])
})

test("the grammar refuses what it cannot describe exactly", () => {
  // Aggregates, grouping, joins and expressions stay out: a wrong reading of any of them is a wrong
  // answer, and this path exists to avoid exactly that.
  refuse("SELECT COUNT(*) FROM TBTCO")
  refuse("SELECT * FROM TBTCO GROUP BY STATUS")
  refuse("SELECT * FROM TBTCO WHERE STATUS = 'F' GROUP BY STATUS")
  refuse("SELECT * FROM TBTCO WHERE LENGTH(STATUS) = 1")
  refuse("SELECT * FROM TBTCO INNER JOIN TBTCO2 ON 1 = 1")
  refuse("SELECT * FROM TBTCO WHERE (STATUS = 'F' OR STATUS = 'A') AND SDATE = '20260925'")
  // Truncated and unterminated statements are refusals, not filters with missing operands.
  refuse("SELECT * FROM TBTCO WHERE STATUS = 'F' AND ")
  refuse("SELECT * FROM TBTCO WHERE STATUS = 'F' OR ")
  refuse("SELECT * FROM TBTCO WHERE STATUS LIKE 'F%'")
  refuse("SELECT * FROM TBTCO WHERE STATUS = 'F' LIMIT 10")
  refuse("SELECT * FROM TBTCO WHERE UNTERMINATED = 'F")
})

test("the grammar bounds disjuncts, conjuncts, values and sort keys", () => {
  const or = (count: number) =>
    `SELECT * FROM T WHERE ${Array.from({ length: count }, (_, index) => `A = '${index}'`).join(" OR ")}`
  assert.equal(select(or(8)).groups.length, 8)
  refuse(or(9))

  const and = (count: number) =>
    `SELECT * FROM T WHERE ${Array.from({ length: count }, (_, index) => `A = '${index}'`).join(" AND ")}`
  assert.equal(select(and(8)).groups[0]!.length, 8)
  refuse(and(9))

  // The reader bounds a filter value at 40 characters; the parser must not accept more.
  assert.equal(select(`SELECT * FROM T WHERE A = '${"x".repeat(40)}'`).groups[0]!.length, 1)
  refuse(`SELECT * FROM T WHERE A = '${"x".repeat(41)}'`)

  const keys = (count: number) =>
    `SELECT * FROM T ORDER BY ${Array.from({ length: count }, () => "A").join(", ")}`
  assert.equal(select(keys(8)).orderBy.length, 8)
  refuse(keys(9))
  refuse("SELECT * FROM T ORDER BY")
})

test("a literal that contains ORDER BY is refused rather than split in the wrong place", () => {
  // The split is pattern-based, so ` OR`/`AND` inside a value are safe, but a value that looks like
  // a trailing ORDER BY clause must never be mistaken for one.
  assert.deepEqual(select("SELECT * FROM T WHERE TEXT = 'OR' AND STATUS = 'A'").groups, [
    [
      { column: "TEXT", operator: "EQ", value: "OR" },
      { column: "STATUS", operator: "EQ", value: "A" }
    ]
  ])
  assert.deepEqual(select("SELECT * FROM T WHERE TEXT = 'A AND B'").groups, [
    [{ column: "TEXT", operator: "EQ", value: "A AND B" }]
  ])
  refuse("SELECT * FROM T WHERE TEXT = 'X ORDER BY Y'")
  refuse("SELECT * FROM T WHERE TEXT = 'X ORDER BY Y' AND STATUS = 'A'")
})

test("a row's identity is its projected values, and * means the row's own columns", () => {
  const columns = ["MANDT", "JOBNUM", "STATUS"]
  const alpha = { MANDT: "200", JOBNUM: "0001", STATUS: "F" }
  const beta = { MANDT: "200", JOBNUM: "0002", STATUS: "A" }
  assert.equal(branchRowKey(alpha, columns), branchRowKey({ ...alpha }, columns))
  assert.notEqual(branchRowKey(alpha, columns), branchRowKey(beta, columns))
  // A `SELECT *` branch is keyed on the row's own columns: keying on the literal "*" would collapse
  // every row into one.
  assert.notEqual(branchRowKey(alpha, ["*"]), branchRowKey(beta, ["*"]))
})

test("the grouped reader merges disjuncts and reports what it could not complete", async () => {
  const duplicate = { MANDT: "200", JOBNUM: "0001", STATUS: "F" }
  const branches: Record<string, Record<string, unknown>[]> = {
    "STATUS=F": [duplicate],
    "STATUS=A": [duplicate, { MANDT: "200", JOBNUM: "0002", STATUS: "A" }]
  }
  const read: Parameters<typeof readGroupedRows>[1] = async (filters) => ({
    rows: branches[`STATUS=${filters[0]!.value}`]!,
    truncated: false,
    detail: { method: "rfc_read_table" }
  })

  // A partial projection cannot tell two rows apart, so a row that both disjuncts returned is kept
  // and counted: dropping it would answer a `DISTINCT` the caller never asked for.
  const projected = await readGroupedRows(
    select("SELECT MANDT, JOBNUM, STATUS FROM TBTCO WHERE STATUS = 'F' OR STATUS = 'A'"),
    read
  )
  assert.equal(projected.disjuncts, 2)
  assert.deepEqual(
    projected.rows.map((row) => row.JOBNUM),
    ["0001", "0001", "0002"]
  )
  assert.equal(projected.deduplicatedRows, 0)
  assert.equal(projected.repeatedProjectedRows, 1)
  assert.deepEqual(projected.incompleteBranches, [])
  assert.equal(projected.orderByApplied, false)

  // The whole row is an identity - `SELECT *` carries the key fields - so the same row is returned
  // once, and the merge says how many it collapsed.
  const full = await readGroupedRows(
    select("SELECT * FROM TBTCO WHERE STATUS = 'F' OR STATUS = 'A'"),
    read
  )
  assert.deepEqual(
    full.rows.map((row) => row.JOBNUM),
    ["0001", "0002"]
  )
  assert.equal(full.deduplicatedRows, 1)
  assert.equal(full.repeatedProjectedRows, 0)
})

test("ordering is refused when a branch holds only a sample, and applied when every branch completed", async () => {
  const parsed = select(
    "SELECT MANDT, STATUS FROM TBTCO WHERE STATUS = 'F' OR STATUS = 'A' ORDER BY MANDT"
  )
  await assert.rejects(
    readGroupedRows(
      parsed,
      async (filters) => ({
        rows: [{ MANDT: "200", STATUS: filters[0]!.value }],
        truncated: filters[0]!.value === "A",
        detail: {}
      }),
      500
    ),
    /TABLE_QUERY_ORDER_BY_INCOMPLETE: ORDER BY describes the whole match set, but 1 of 2 read\(s\) stopped at the 500-row bound \(branch 1\)/
  )

  const sorted = await readGroupedRows(
    select(
      "SELECT MANDT, JOBNUM FROM TBTCO WHERE STATUS = 'F' OR STATUS = 'A' ORDER BY JOBNUM DESC"
    ),
    async (filters) => ({
      rows:
        filters[0]!.value === "F"
          ? [{ MANDT: "200", JOBNUM: "0009" }]
          : [{ MANDT: "200", JOBNUM: "0010" }],
      truncated: false,
      detail: {}
    })
  )
  assert.equal(sorted.orderByApplied, true)
  assert.deepEqual(
    sorted.rows.map((row) => row.JOBNUM),
    ["0010", "0009"]
  )
})

test("ordering a column that is not projected is refused before any read", async () => {
  let reads = 0
  await assert.rejects(
    readGroupedRows(
      select("SELECT MANDT, JOBNUM FROM TBTCO WHERE STATUS = 'F' ORDER BY SDATE"),
      async () => {
        reads++
        return { rows: [], truncated: false, detail: {} }
      }
    ),
    /TABLE_QUERY_ORDER_BY_COLUMN_NOT_SELECTED: ORDER BY SDATE is not in the projection/
  )
  assert.equal(reads, 0, "the refusal must precede the read it would otherwise waste")

  // `SELECT *` is expanded by the reader, so it carries every column and needs no such check.
  const all = await readGroupedRows(
    select("SELECT * FROM TBTCO WHERE STATUS = 'F' ORDER BY SDATE"),
    async () => ({
      rows: [{ SDATE: "20260925" }],
      truncated: false,
      detail: {}
    })
  )
  assert.equal(all.orderByApplied, true)
})

test("the shared comparator sorts by several keys with numeric awareness", () => {
  const rows = [
    { MANDT: "200", JOBNUM: "10" },
    { MANDT: "200", JOBNUM: "9" },
    { MANDT: "100", JOBNUM: "1" }
  ]
  assert.deepEqual(
    sortRowsByColumns(rows, [
      { column: "MANDT", direction: "asc" },
      { column: "JOBNUM", direction: "asc" }
    ]).map((row) => `${row.MANDT}/${row.JOBNUM}`),
    ["100/1", "200/9", "200/10"]
  )
  // No keys is not a sort: the input order is returned untouched, not re-sorted alphabetically.
  assert.deepEqual(sortRowsByColumns(rows, []), rows)
})
