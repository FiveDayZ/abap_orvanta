import assert from "node:assert/strict"
import test from "node:test"
import {
  aggregateColumnName,
  aggregateExpression,
  branchRowKey,
  groupedReadColumns,
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
    aggregates: [],
    groupBy: [],
    // `SELECT *` is already the whole row, which is the identity a merge needs.
    readWholeRow: true,
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
      aggregates: [],
      groupBy: [],
      // A partial projection is not an identity: two rows may agree on both columns.
      readWholeRow: false,
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
    aggregates: [],
    groupBy: [],
    readWholeRow: false,
    groups: [[]],
    orderBy: [{ column: "MTEXT", direction: "asc" }]
  })
  assert.deepEqual(select("SELECT MANDT FROM T000").groups, [[]])
})

test("the grammar refuses what it cannot describe exactly", () => {
  // Joins, expressions and subqueries stay out: a wrong reading of any of them is a wrong answer, and
  // this path exists to avoid exactly that. Aggregates and `GROUP BY` are read now (they have their
  // own tests below), including their refusal to combine with `*`.
  refuse("SELECT * FROM TBTCO INNER JOIN TBTCO2 ON 1 = 1")
  refuse("SELECT * FROM TBTCO LEFT OUTER JOIN TBTCO2 ON 1 = 1")
  refuse("SELECT * FROM TBTCO WHERE LENGTH(STATUS) = 1")
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

test("the grammar reads aggregates and groups, and publishes one column per aggregate", () => {
  const grouped = select("SELECT STATUS, COUNT(*) FROM TBTCO GROUP BY STATUS")
  assert.deepEqual(grouped.columns, ["STATUS"])
  assert.deepEqual(grouped.aggregates, [{ fn: "COUNT", column: null }])
  assert.deepEqual(grouped.groupBy, ["STATUS"])
  // A grouped statement reads the whole row: row identity is what keeps a row matched by two
  // overlapping `OR` branches out of the count twice.
  assert.equal(grouped.readWholeRow, true)
  assert.deepEqual(groupedReadColumns(grouped), ["*"])

  // Several aggregates, a WHERE, an ordering by the grouping column, and a missing GROUP BY.
  const summed = select(
    "SELECT UNAME, SUM(NETWR), MAX(ERDAT) FROM TBTCO WHERE BUKRS = '1000' GROUP BY UNAME ORDER BY UNAME DESC"
  )
  assert.deepEqual(summed.aggregates, [
    { fn: "SUM", column: "NETWR" },
    { fn: "MAX", column: "ERDAT" }
  ])
  assert.deepEqual(summed.orderBy, [{ column: "UNAME", direction: "desc" }])
  assert.deepEqual(summed.groups, [[{ column: "BUKRS", operator: "EQ", value: "1000" }]])

  // `COUNT(*)` without a group is one row, and `GROUP BY` without an aggregate is the distinct key
  // list - both are statements, not errors.
  assert.deepEqual(select("SELECT COUNT(*) FROM TBTCO").aggregates, [{ fn: "COUNT", column: null }])
  assert.equal(select("SELECT UNAME FROM TBTCO GROUP BY UNAME").readWholeRow, true)
  assert.deepEqual(select("SELECT UNAME FROM TBTCO GROUP BY UNAME ORDER BY UNAME").orderBy, [
    { column: "UNAME", direction: "asc" }
  ])

  // The published column name is derived from the expression, so a caller can order by it; the
  // mapping is returned with the answer as well, so nothing has to be guessed.
  assert.equal(aggregateColumnName({ fn: "COUNT", column: null }), "COUNT")
  assert.equal(aggregateColumnName({ fn: "COUNT", column: "UNAME" }), "COUNT_UNAME")
  assert.equal(aggregateColumnName({ fn: "SUM", column: "NETWR" }), "SUM_NETWR")
  assert.equal(aggregateExpression({ fn: "MAX", column: "ERDAT" }), "MAX(ERDAT)")
  assert.equal(aggregateExpression({ fn: "COUNT", column: null }), "COUNT(*)")
})

test("the grammar refuses aggregates and groupings it cannot answer exactly", () => {
  const throws = (sql: string, pattern: RegExp) =>
    assert.throws(() => parseGroupedTableSelect(sql), pattern, sql)

  // A function outside the four aggregates is refused by name, with the fix in the message.
  throws("SELECT AVG(NETWR) FROM TBTCO", /TABLE_QUERY_AGGREGATE_UNSUPPORTED: AVG/)
  // Only `COUNT` counts whole rows.
  throws("SELECT SUM(*) FROM TBTCO", /TABLE_QUERY_AGGREGATE_ARGUMENT: SUM\(\*\)/)
  // `*` cannot be combined with, or grouped by way of, an aggregate statement.
  throws("SELECT *, COUNT(*) FROM TBTCO", /TABLE_QUERY_AGGREGATE_WITH_WILDCARD/)
  throws("SELECT * FROM TBTCO GROUP BY STATUS", /TABLE_QUERY_AGGREGATE_WITH_WILDCARD/)
  // A selected column that is not grouped has no single value per group; a grouped column that is
  // not selected cannot be read off the answer.
  throws("SELECT STATUS, COUNT(*) FROM TBTCO", /TABLE_QUERY_GROUP_BY_KEYS_MISMATCH/)
  throws("SELECT STATUS, COUNT(*) FROM TBTCO GROUP BY SDATE", /TABLE_QUERY_GROUP_BY_KEYS_MISMATCH/)
  throws(
    "SELECT STATUS, JOBNUM, COUNT(*) FROM TBTCO GROUP BY STATUS",
    /TABLE_QUERY_GROUP_BY_KEYS_MISMATCH/
  )
  // Two identical aggregates would publish one column twice, and a derived name may not shadow a
  // selected column.
  throws(
    "SELECT STATUS, COUNT(*), COUNT(*) FROM TBTCO GROUP BY STATUS",
    /TABLE_QUERY_AGGREGATE_DUPLICATE/
  )
  throws("SELECT COUNT, COUNT(*) FROM TBTCO", /TABLE_QUERY_AGGREGATE_SHADOWED: COUNT/)
  // A direction belongs to ORDER BY, not to the grouping.
  throws(
    "SELECT STATUS, COUNT(*) FROM TBTCO GROUP BY STATUS DESC",
    /TABLE_QUERY_GROUP_BY_DIRECTION/
  )

  // Bounds and malformed key lists are plain refusals, like every other bound in this grammar.
  const keys = (count: number) =>
    `SELECT ${Array.from({ length: count }, (_, index) => `F${index}`).join(", ")} FROM T ` +
    `GROUP BY ${Array.from({ length: count }, (_, index) => `F${index}`).join(", ")}`
  assert.equal(select(keys(8)).groupBy.length, 8)
  refuse(keys(9))
  refuse("SELECT STATUS, COUNT(*) FROM TBTCO GROUP BY STATUS, STATUS")
  refuse("SELECT STATUS, COUNT(*) FROM TBTCO GROUP BY")
})

test("the grouped reader counts each row once across overlapping disjuncts", async () => {
  const duplicate = { MANDT: "200", JOBNUM: "0001", STATUS: "F" }
  const read: Parameters<typeof readGroupedRows>[1] = async (filters) =>
    filters[0]!.value === "F"
      ? { rows: [duplicate], truncated: false, detail: {} }
      : {
          // The second branch sees the same row again plus one of its own: a count over the union is
          // two rows, not three.
          rows: [duplicate, { MANDT: "200", JOBNUM: "0002", STATUS: "A" }],
          truncated: false,
          detail: {}
        }

  const counted = await readGroupedRows(
    select("SELECT COUNT(*) FROM TBTCO WHERE STATUS = 'F' OR STATUS = 'A'"),
    read
  )
  assert.equal(counted.aggregated, true)
  assert.equal(counted.groupCount, 1)
  assert.deepEqual(counted.rows, [{ COUNT: 2 }])
  assert.equal(counted.deduplicatedRows, 1)
  assert.equal(counted.repeatedProjectedRows, 0)
  assert.deepEqual(counted.aggregateColumns, [{ expression: "COUNT(*)", column: "COUNT" }])
})

test("an aggregate over a truncated read is refused rather than reported smaller", async () => {
  await assert.rejects(
    readGroupedRows(
      select("SELECT COUNT(*) FROM TBTCO WHERE STATUS = 'F' OR STATUS = 'A'"),
      async (filters) => ({
        rows: [{ MANDT: "200", JOBNUM: "0001", STATUS: filters[0]!.value }],
        truncated: filters[0]!.value === "A",
        detail: {}
      }),
      500
    ),
    /TABLE_QUERY_AGGREGATE_INCOMPLETE: an aggregate describes the whole match set, but 1 of 2 read\(s\) stopped at the 500-row bound \(branch 1\)/
  )
  // A page is still an answer when the caller asked for rows: only the aggregate refuses.
  const page = await readGroupedRows(
    select("SELECT MANDT, JOBNUM FROM TBTCO WHERE STATUS = 'F' OR STATUS = 'A'"),
    async (filters) => ({
      rows: [{ MANDT: "200", JOBNUM: "0001", STATUS: filters[0]!.value }],
      truncated: filters[0]!.value === "A",
      detail: {}
    }),
    500
  )
  assert.deepEqual(page.incompleteBranches, [1])
  assert.equal(page.aggregated, false)
})

test("groups carry exact counts and sums, and ignore empty values", async () => {
  const rows: Record<string, unknown>[] = [
    { UNAME: "A", NETWR: "1.1", ERDAT: "20260201" },
    { UNAME: "A", NETWR: "2.2", ERDAT: "20260101" },
    { UNAME: "A", NETWR: "", ERDAT: "" },
    { UNAME: "B", NETWR: "5", ERDAT: "" }
  ]
  const read: Parameters<typeof readGroupedRows>[1] = async () => ({
    rows,
    truncated: false,
    detail: {}
  })

  const grouped = await readGroupedRows(
    select(
      "SELECT UNAME, COUNT(*), COUNT(NETWR), SUM(NETWR), MIN(ERDAT), MAX(ERDAT) FROM TBTCO GROUP BY UNAME"
    ),
    read
  )
  assert.equal(grouped.groupCount, 2)
  assert.deepEqual(grouped.aggregateColumns, [
    { expression: "COUNT(*)", column: "COUNT" },
    { expression: "COUNT(NETWR)", column: "COUNT_NETWR" },
    { expression: "SUM(NETWR)", column: "SUM_NETWR" },
    { expression: "MIN(ERDAT)", column: "MIN_ERDAT" },
    { expression: "MAX(ERDAT)", column: "MAX_ERDAT" }
  ])
  // `COUNT(*)` counts rows, the other aggregates ignore the empty value; the sum of `1.1` and `2.2`
  // is `3.3` because the service adds scaled integers, not doubles; `MIN`/`MAX` ignore the empty
  // date and publish the reader's own text.
  assert.deepEqual(grouped.rows, [
    {
      UNAME: "A",
      COUNT: 3,
      COUNT_NETWR: 2,
      SUM_NETWR: "3.3",
      MIN_ERDAT: "20260101",
      MAX_ERDAT: "20260201"
    },
    { UNAME: "B", COUNT: 1, COUNT_NETWR: 1, SUM_NETWR: "5", MIN_ERDAT: "", MAX_ERDAT: "" }
  ])

  // Groups appear in first-seen order, and `ORDER BY` over a published column is what ranks them.
  // The rows carry a key column because identity is the row's values: two rows that agree on every
  // column are the same row to this reader, and counting them twice would be the guess.
  const ranked = await readGroupedRows(
    select(
      "SELECT UNAME, COUNT(*) FROM TBTCO WHERE UNAME = 'x' OR UNAME = 'y' GROUP BY UNAME ORDER BY COUNT DESC"
    ),
    async (filters) =>
      filters[0]!.value === "x"
        ? {
            rows: [
              { UNAME: "x", JOBNUM: "0001" },
              { UNAME: "x", JOBNUM: "0002" },
              { UNAME: "y", JOBNUM: "0003" }
            ],
            truncated: false,
            detail: {}
          }
        : { rows: [], truncated: false, detail: {} }
  )
  assert.equal(ranked.orderByApplied, true)
  assert.deepEqual(ranked.rows, [
    { UNAME: "x", COUNT: 2 },
    { UNAME: "y", COUNT: 1 }
  ])
})

test("a sum the service cannot compute exactly is refused, and an empty match set still counts", async () => {
  const summing = (value: string) =>
    readGroupedRows(select("SELECT SUM(NETWR) FROM TBTCO"), async () => ({
      rows: [{ NETWR: value }],
      truncated: false,
      detail: {}
    }))
  // A trailing sign convention the reader uses for packed numbers is not a decimal this service will
  // add: the caller gets a refusal instead of a number that is quietly wrong.
  await assert.rejects(summing("9007199254740993.123-"), /TABLE_QUERY_AGGREGATE_NOT_NUMERIC/)
  await assert.rejects(summing("abc"), /TABLE_QUERY_AGGREGATE_NOT_NUMERIC/)
  await assert.rejects(summing("9007199254740993"), /TABLE_QUERY_AGGREGATE_NOT_EXACT: the value/)
  await assert.rejects(
    readGroupedRows(select("SELECT SUM(NETWR) FROM TBTCO"), async () => ({
      // Each addend is exact on its own; their sum is not, so the answer is refused rather than
      // rounded to the nearest double.
      rows: [{ NETWR: "9007199254740991" }, { NETWR: "1" }],
      truncated: false,
      detail: {}
    })),
    /TABLE_QUERY_AGGREGATE_NOT_EXACT: the running total/
  )

  // No matching row is zero rows counted, not an error and not an empty answer.
  const empty = await readGroupedRows(
    select("SELECT COUNT(*) FROM TBTCO WHERE STATUS = 'X'"),
    async () => ({ rows: [], truncated: false, detail: {} })
  )
  assert.deepEqual(empty.rows, [{ COUNT: 0 }])
  assert.equal(empty.groupCount, 1)
  // With `GROUP BY` there is no group to report, because the caller asked for the keys.
  const noGroups = await readGroupedRows(
    select("SELECT STATUS, COUNT(*) FROM TBTCO GROUP BY STATUS"),
    async () => ({ rows: [], truncated: false, detail: {} })
  )
  assert.deepEqual(noGroups.rows, [])
  assert.equal(noGroups.groupCount, 0)
})
