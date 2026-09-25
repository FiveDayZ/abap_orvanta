import assert from "node:assert/strict"
import test from "node:test"
import { MockBackend } from "./mock-backend.js"
import { ToolService } from "../src/tools.js"
import {
  nativeEmptyHtml,
  parseJoinedTableSelect,
  readJoinedRows,
  type JoinedReadBranch
} from "../src/table-query.js"

const parse = (sql: string) => {
  const parsed = parseJoinedTableSelect(sql)
  assert.ok(parsed, `expected the join grammar to describe: ${sql}`)
  return parsed
}

const refuse = (sql: string) => {
  assert.equal(parseJoinedTableSelect(sql), undefined, `expected a refusal for: ${sql}`)
}

const throws = (sql: string, code: string) => {
  assert.throws(
    () => parseJoinedTableSelect(sql),
    (error: Error) => error.message.includes(code),
    `expected ${code} for: ${sql}`
  )
}

test("an inner join reads both tables, qualifies every column and keeps the ON key", () => {
  assert.deepEqual(
    parse(
      "SELECT A.TRKORR, B.AS4TEXT FROM E070 A INNER JOIN E07T B ON A.TRKORR = B.TRKORR " +
        "WHERE A.TRSTATUS = 'R' ORDER BY B.AS4TEXT DESC"
    ),
    {
      tables: [
        { tableName: "E070", alias: "A", joinType: "inner", on: [] },
        {
          tableName: "E07T",
          alias: "B",
          joinType: "inner",
          on: [{ left: { alias: "B", column: "TRKORR" }, right: { alias: "A", column: "TRKORR" } }]
        }
      ],
      columns: ["A.TRKORR", "B.AS4TEXT"],
      aggregates: [],
      groupBy: [],
      where: [{ alias: "A", column: "TRSTATUS", operator: "EQ", value: "R" }],
      orderBy: [{ column: "B.AS4TEXT", direction: "desc" }]
    }
  )
})

test("the alias defaults to the table name, and ON may be written either way round", () => {
  const select = parse("SELECT E070.TRKORR FROM E070 JOIN E07T ON E07T.TRKORR = E070.TRKORR")
  assert.deepEqual(
    select.tables.map((table) => table.alias),
    ["E070", "E07T"]
  )
  assert.deepEqual(select.tables[1]!.on, [
    { left: { alias: "E07T", column: "TRKORR" }, right: { alias: "E070", column: "TRKORR" } }
  ])
})

test("three tables, several keys per join and a grouped projection are described", () => {
  const select = parse(
    "SELECT A.JOBNAME, COUNT(*) FROM TBTCO A " +
      "INNER JOIN TBTCP B ON A.JOBNAME = B.JOBNAME AND A.JOBCOUNT = B.JOBCOUNT " +
      "LEFT JOIN TSP01 C ON A.JOBNAME = C.JOBNAME " +
      "GROUP BY A.JOBNAME"
  )
  assert.equal(select.tables.length, 3)
  assert.equal(select.tables[1]!.on.length, 2)
  assert.equal(select.tables[2]!.joinType, "left")
  assert.deepEqual(select.columns, ["A.JOBNAME"])
  assert.deepEqual(select.aggregates, [{ fn: "COUNT", column: null }])
  assert.deepEqual(select.groupBy, ["A.JOBNAME"])
})

test("an ON literal is a condition of that join, not a probe key", () => {
  const select = parse(
    "SELECT A.TRKORR FROM E070 A INNER JOIN E07T B ON A.TRKORR = B.TRKORR AND B.AS4LANGU = 'E'"
  )
  assert.deepEqual(select.tables[1]!.on, [
    { left: { alias: "B", column: "TRKORR" }, right: { alias: "A", column: "TRKORR" } },
    { left: { alias: "B", column: "AS4LANGU" }, right: { literal: "E" } }
  ])
})

test("a single-table statement is not a joined statement", () => {
  refuse("SELECT * FROM TBTCO WHERE STATUS = 'F'")
  refuse("SELECT MANDT FROM T000")
})

test("statements this grammar will not answer are refused by name", () => {
  throws("SELECT TRKORR FROM E070 A JOIN E07T B ON A.TRKORR = B.TRKORR", "COLUMN_UNQUALIFIED")
  throws("SELECT * FROM E070 A JOIN E07T B ON A.TRKORR = B.TRKORR", "JOIN_WILDCARD")
  throws("SELECT C.TRKORR FROM E070 A JOIN E07T B ON A.TRKORR = B.TRKORR", "ALIAS_UNKNOWN")
  throws(
    "SELECT A.TRKORR FROM E070 A JOIN E07T B ON A.TRKORR = B.TRKORR WHERE C.X = '1'",
    "ALIAS_UNKNOWN"
  )
  throws(
    "SELECT A.TRKORR FROM E070 A RIGHT JOIN E07T B ON A.TRKORR = B.TRKORR",
    "JOIN_TYPE_UNSUPPORTED"
  )
  throws(
    "SELECT A.TRKORR FROM E070 A CROSS JOIN E07T B ON A.TRKORR = B.TRKORR",
    "JOIN_TYPE_UNSUPPORTED"
  )
  throws("SELECT A.TRKORR FROM E070 A JOIN E07T B", "JOIN_ON_MISSING")
  throws("SELECT A.TRKORR FROM E070 A JOIN E07T B ON A.TRKORR > B.TRKORR", "JOIN_ON_OPERATOR")
  throws("SELECT A.TRKORR FROM E070 A JOIN E07T B ON A.TRKORR = C.TRKORR", "JOIN_ON_ALIAS")
  throws(
    "SELECT A.TRKORR FROM E070 A JOIN E07T B ON A.TRKORR = B.TRKORR " +
      "JOIN E071 C ON B.TRKORR = C.TRKORR JOIN E07T D ON C.TRKORR = D.TRKORR",
    "JOIN_TABLE_LIMIT"
  )
  throws(
    "SELECT A.TRKORR FROM E070 A JOIN E07T B ON A.TRKORR = B.TRKORR WHERE A.X = '1' OR A.Y = '2'",
    "JOIN_WHERE_OR"
  )
  throws(
    "SELECT A.TRKORR FROM E070 A JOIN E07T B ON A.TRKORR = B.TRKORR WHERE A.X = B.Y",
    "JOIN_WHERE_CROSS_TABLE"
  )
  throws(
    "SELECT A.TRKORR FROM E070 A JOIN E07T B ON A.TRKORR = B.TRKORR WHERE X = '1'",
    "COLUMN_UNQUALIFIED"
  )
  throws(
    "SELECT A.TRKORR FROM E070 A LEFT JOIN E07T B ON A.TRKORR = B.TRKORR WHERE B.AS4TEXT = 'x'",
    "JOIN_WHERE_OUTER_COLUMN"
  )
  throws(
    "SELECT A.TRKORR FROM E070 A LEFT JOIN E07T B ON A.TRKORR = B.TRKORR JOIN E071 C ON B.TRKORR = C.TRKORR",
    "JOIN_OUTER_NOT_LAST"
  )
  throws(
    "SELECT A.TRKORR, COUNT(*) FROM E070 A JOIN E07T B ON A.TRKORR = B.TRKORR GROUP BY A.TRKORR DESC",
    "GROUP_BY_DIRECTION"
  )
  throws(
    "SELECT A.TRKORR, COUNT(*) FROM E070 A JOIN E07T B ON A.TRKORR = B.TRKORR",
    "GROUP_BY_KEYS_MISMATCH"
  )
  // A second name on one table (`A AS X`) is not a shape this grammar describes, so the statement
  // keeps the platform's own error rather than a guess at which name the caller meant.
  refuse("SELECT A.TRKORR FROM E070 A AS X JOIN E07T B ON A.TRKORR = B.TRKORR")
})

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
          if (filter.operator === "EQ") return value === filter.value
          if (filter.operator === "NE") return value !== filter.value
          return true
        })
      )
      .map((row) =>
        Object.fromEntries(columns.map((c) => [c, row[table.columns.indexOf(c)] ?? ""]))
      )
    return { rows, truncated: truncated.has(tableName), detail: { table: tableName } }
  }
  return { read, calls, truncated }
}

const completed = async (
  select: Parameters<typeof readJoinedRows>[0],
  scripted: ReturnType<typeof readerFor>
) => readJoinedRows(select, scripted.read, 500)

test("an inner join pairs rows on the key and reads only the columns the statement uses", async () => {
  const scripted = readerFor({
    E070: {
      columns: ["TRKORR", "TRSTATUS", "TRFUNCTION"],
      rows: [
        ["K900001", "R", "X"],
        ["K900002", "D", "Y"],
        ["K900003", "R", "Z"]
      ]
    },
    E07T: {
      columns: ["TRKORR", "AS4TEXT", "AS4USER"],
      rows: [
        ["K900001", "first text", "WYS"],
        ["K900003", "third text", "WYS"],
        ["K900004", "orphan", "WYS"]
      ]
    }
  })
  const result = await completed(
    parse(
      "SELECT A.TRKORR, B.AS4TEXT FROM E070 A INNER JOIN E07T B ON A.TRKORR = B.TRKORR " +
        "WHERE A.TRSTATUS = 'R' ORDER BY A.TRKORR"
    ),
    scripted
  )
  assert.deepEqual(result.rows, [
    { "A.TRKORR": "K900001", "B.AS4TEXT": "first text" },
    { "A.TRKORR": "K900003", "B.AS4TEXT": "third text" }
  ])
  assert.equal(result.truncated, false)
  assert.equal(result.orderByApplied, true)
  assert.deepEqual(
    scripted.calls.map((call) => call.tableName),
    ["E070", "E07T"]
  )
  // Only the projected key and the pushed-down predicate are read from the first table; the second
  // table is read for its own key and the projected text, and nothing else.
  // The reader's column order is its own business, so a read is compared as a set: the first table is
  // read for the projected key and the pushed-down predicate, the second for its own key and the
  // projected text, and nothing else on either side.
  assert.deepEqual([...scripted.calls[0]!.columns].sort(), ["TRKORR", "TRSTATUS"])
  assert.deepEqual(scripted.calls[0]!.filters, [{ column: "TRSTATUS", operator: "EQ", value: "R" }])
  assert.deepEqual([...scripted.calls[1]!.columns].sort(), ["AS4TEXT", "TRKORR"])
  assert.deepEqual(scripted.calls[1]!.filters, [])
  assert.deepEqual(result.join.tables[1]!.onKeys, ["B.TRKORR = A.TRKORR"])
  assert.deepEqual(result.join.reads, [{ table: "E070" }, { table: "E07T" }])
})

test("a left join keeps the unmatched row and leaves the optional side empty", async () => {
  const scripted = readerFor({
    E070: { columns: ["TRKORR"], rows: [["K1"], ["K2"], ["K3"]] },
    E07T: {
      columns: ["TRKORR", "AS4TEXT"],
      rows: [
        ["K1", "one"],
        ["K3", "three"]
      ]
    }
  })
  const result = await completed(
    parse("SELECT A.TRKORR, B.AS4TEXT FROM E070 A LEFT JOIN E07T B ON A.TRKORR = B.TRKORR"),
    scripted
  )
  assert.deepEqual(result.rows, [
    { "A.TRKORR": "K1", "B.AS4TEXT": "one" },
    { "A.TRKORR": "K2", "B.AS4TEXT": "" },
    { "A.TRKORR": "K3", "B.AS4TEXT": "three" }
  ])
})

test("an ON literal is pushed to the optional read, not used as a probe key", async () => {
  const scripted = readerFor({
    E070: { columns: ["TRKORR"], rows: [["K1"], ["K2"]] },
    E07T: {
      columns: ["TRKORR", "AS4LANGU", "AS4TEXT"],
      rows: [
        ["K1", "D", "deutsch"],
        ["K2", "E", "english"]
      ]
    }
  })
  const result = await completed(
    parse(
      "SELECT A.TRKORR, B.AS4TEXT FROM E070 A LEFT JOIN E07T B ON A.TRKORR = B.TRKORR " +
        "AND B.AS4LANGU = 'D'"
    ),
    scripted
  )
  assert.deepEqual(result.rows, [
    { "A.TRKORR": "K1", "B.AS4TEXT": "deutsch" },
    { "A.TRKORR": "K2", "B.AS4TEXT": "" }
  ])
  // The language condition reached the second read as a filter, so SAP decided it.
  assert.deepEqual(scripted.calls[1]!.filters, [{ column: "AS4LANGU", operator: "EQ", value: "D" }])
  assert.deepEqual(result.join.tables[1]!.pushedFilters, [
    { column: "AS4LANGU", operator: "EQ", value: "D" }
  ])
})

test("a join on two keys only pairs rows that agree on both", async () => {
  const scripted = readerFor({
    TBTCO: {
      columns: ["JOBNAME", "JOBCOUNT", "STATUS"],
      rows: [
        ["JOB1", "1", "F"],
        ["JOB1", "2", "F"]
      ]
    },
    TBTCP: {
      columns: ["JOBNAME", "JOBCOUNT", "STEPCOUNT"],
      rows: [
        ["JOB1", "1", "0100"],
        ["JOB1", "3", "0100"]
      ]
    }
  })
  const result = await completed(
    parse(
      "SELECT A.JOBNAME, B.STEPCOUNT FROM TBTCO A INNER JOIN TBTCP B " +
        "ON A.JOBNAME = B.JOBNAME AND A.JOBCOUNT = B.JOBCOUNT"
    ),
    scripted
  )
  assert.deepEqual(result.rows, [{ "A.JOBNAME": "JOB1", "B.STEPCOUNT": "0100" }])
})

test("a capped side or a capped join is reported instead of silently joined", async () => {
  const scripted = readerFor({
    E070: { columns: ["TRKORR"], rows: [["K1"], ["K2"]] },
    E07T: {
      columns: ["TRKORR", "AS4TEXT"],
      rows: [
        ["K1", "one"],
        ["K2", "two"]
      ]
    }
  })
  scripted.truncated.add("E07T")
  const select = parse("SELECT A.TRKORR, B.AS4TEXT FROM E070 A JOIN E07T B ON A.TRKORR = B.TRKORR")
  const sampled = await readJoinedRows(select, scripted.read, 500)
  assert.equal(sampled.truncated, true)
  assert.deepEqual(sampled.join.incompleteAliases, ["B"])

  const bounded = await readJoinedRows(select, scripted.read, 1)
  assert.equal(bounded.truncated, true)
  assert.equal(bounded.rows.length, 1)

  // An aggregate over either kind of sample would be a count of the sample, so it is refused.
  await assert.rejects(
    readJoinedRows(
      parse(
        "SELECT A.TRKORR, COUNT(*) FROM E070 A JOIN E07T B ON A.TRKORR = B.TRKORR GROUP BY A.TRKORR"
      ),
      scripted.read,
      500
    ),
    /TABLE_QUERY_AGGREGATE_INCOMPLETE/
  )
  await assert.rejects(
    readJoinedRows(
      parse("SELECT A.TRKORR FROM E070 A JOIN E07T B ON A.TRKORR = B.TRKORR ORDER BY A.TRKORR"),
      scripted.read,
      1
    ),
    /TABLE_QUERY_ORDER_BY_INCOMPLETE/
  )
})

test("joined rows can be grouped and aggregated, and sorted by a published column", async () => {
  const scripted = readerFor({
    E070: {
      columns: ["TRKORR", "TRSTATUS", "TRFUNCTION"],
      rows: [
        ["K1", "R", "X"],
        ["K2", "R", "X"],
        ["K3", "D", "Y"]
      ]
    },
    E07T: {
      columns: ["TRKORR", "AS4TEXT"],
      rows: [
        ["K1", "one"],
        ["K2", "two"],
        ["K3", "three"]
      ]
    }
  })
  const grouped = await completed(
    parse(
      "SELECT B.AS4TEXT, COUNT(*) FROM E070 A JOIN E07T B ON A.TRKORR = B.TRKORR " +
        "WHERE A.TRSTATUS = 'R' GROUP BY B.AS4TEXT ORDER BY B.AS4TEXT DESC"
    ),
    scripted
  )
  assert.equal(grouped.aggregated, true)
  assert.equal(grouped.groupCount, 2)
  assert.deepEqual(grouped.rows, [
    { "B.AS4TEXT": "two", COUNT: 1 },
    { "B.AS4TEXT": "one", COUNT: 1 }
  ])
  assert.deepEqual(grouped.aggregateColumns, [{ expression: "COUNT(*)", column: "COUNT" }])
})

test("an ORDER BY that names no published column is refused before anything is read", async () => {
  const scripted = readerFor({
    E070: { columns: ["TRKORR"], rows: [["K1"]] },
    E07T: { columns: ["TRKORR", "AS4TEXT"], rows: [["K1", "one"]] }
  })
  await assert.rejects(
    completed(
      parse("SELECT A.TRKORR FROM E070 A JOIN E07T B ON A.TRKORR = B.TRKORR ORDER BY B.AS4TEXT"),
      scripted
    ),
    /TABLE_QUERY_ORDER_BY_COLUMN_NOT_SELECTED/
  )
  assert.equal(scripted.calls.length, 0)
})

const legacyReader = {
  functionName: "RFC_READ_TABLE",
  remoteEnabled: true,
  updateTask: false,
  sourceFingerprint: "7b9a603493673d26f75e555616b24d150e407ce03eff57e9c68f0b30b1ba0c2d",
  interfaceFingerprint: "d06cc5c1ce05960bde526ecf27e38606134146474cc8da19f93ac2abd3e48074"
}
const alignedReader = {
  ...legacyReader,
  functionName: "BBP_RFC_READ_TABLE",
  sourceFingerprint: "e08069939315d594527fe58fc1a52e32e583d0987bc173295ddb816be9051b94",
  interfaceFingerprint: "d85d035301f09d00229fa830e7c4cd7c63c8a167055d53bb62ddebb44d17743a"
}

/**
 * The wiring proof: `execute_data_query`'s fallback must answer a joined statement through the same
 * single-table reader, one read per table, with the predicate pushed to the table that owns it.
 */
test("execute_data_query answers a joined statement with one read per table", async () => {
  const tables: Record<string, { fields: Array<[string, string, string]>; rows: string[][] }> = {
    E070: {
      fields: [
        ["TRKORR", "C", "4"],
        ["TRSTATUS", "C", "1"]
      ],
      rows: [
        ["K001", "R"],
        ["K002", "D"],
        ["K003", "R"]
      ]
    },
    E07T: {
      fields: [
        ["TRKORR", "C", "4"],
        ["AS4TEXT", "C", "4"]
      ],
      rows: [
        ["K001", "one1"],
        ["K003", "thre"],
        ["K004", "orph"]
      ]
    }
  }
  const optionsSeen: string[][] = []
  const backend = new MockBackend()
  backend.runQuery = async (): Promise<Record<string, unknown>[]> => {
    throw new Error(nativeEmptyHtml)
  }
  backend.callRemoteFunction = async (_connectionId, request) => {
    const table = tables[String(request.inputParameters.QUERY_TABLE)]!
    const metadata = request.inputParameters.NO_DATA === "X"
    const requested = (request.inputParameters.FIELDS as { FIELDNAME: string }[]).map(
      (field) => field.FIELDNAME
    )
    const names =
      metadata || requested.length === 0 ? table.fields.map(([name]) => name) : requested
    let offset = 0
    const fields = names.map((name) => {
      const field = table.fields.find(([candidate]) => candidate === name)!
      const entry = {
        FIELDNAME: name,
        TYPE: field[1],
        LENGTH: field[2],
        OFFSET: String(offset)
      }
      offset += Number(field[2]) + 1
      return entry
    })
    if (metadata) return { outputs: { FIELDS: fields, DATA: [] } }
    const options = (request.inputParameters.OPTIONS ?? []) as { TEXT: string }[]
    optionsSeen.push(options.map((option) => option.TEXT))
    const conditions = options.map((option) => {
      const match = option.TEXT.replace(/^AND\s+/, "").match(/^([A-Z0-9_]+)\s*(=|<>)\s*'(.*)'$/)!
      return { column: match[1]!, value: match[3]! }
    })
    const data = table.rows
      .filter((row) =>
        conditions.every(
          (condition) =>
            (row[table.fields.findIndex(([name]) => name === condition.column)] ?? "") ===
            condition.value
        )
      )
      .map((row) => ({
        WA: names.map((name) => row[table.fields.findIndex(([field]) => field === name)]).join("|")
      }))
    return { outputs: { FIELDS: fields, DATA: data } }
  }
  const tools = new ToolService(backend)
  tools.readDdicTransparentTable = async (input) =>
    JSON.stringify({
      objectKind: "transparentTable",
      objectName: input.objectName,
      fingerprint: "a".repeat(64),
      definition: {
        tableClass: "TRANSP",
        fields: tables[input.objectName]!.fields.map(([name]) => ({ name }))
      }
    })
  tools.readFunctionModuleInterface = async ({ functionName }) =>
    JSON.stringify(functionName === "RFC_READ_TABLE" ? legacyReader : alignedReader)
  const result = JSON.parse(
    await tools.executeDataQuery({
      connectionId: "w200",
      sql:
        "SELECT A.TRKORR, B.AS4TEXT FROM E070 A INNER JOIN E07T B ON A.TRKORR = B.TRKORR " +
        "WHERE A.TRSTATUS = 'R'",
      displayMode: "internal",
      rowRange: { start: 0, end: 10 },
      maxRows: 10
    })
  )
  assert.deepEqual(result.data, [
    { "A.TRKORR": "K001", "B.AS4TEXT": "one1" },
    { "A.TRKORR": "K003", "B.AS4TEXT": "thre" }
  ])
  assert.equal(result.querySource.aggregated, false)
  // The WHERE conjunct is recorded against the table that owns it, and the join key is the only
  // condition of the second table.
  assert.deepEqual(result.querySource.join.tables, [
    {
      alias: "A",
      tableName: "E070",
      joinType: "inner",
      onKeys: [],
      pushedFilters: [{ column: "TRSTATUS", operator: "EQ", value: "R" }]
    },
    {
      alias: "B",
      tableName: "E07T",
      joinType: "inner",
      onKeys: ["B.TRKORR = A.TRKORR"],
      pushedFilters: []
    }
  ])
  // The predicate reached the first table's read and the second read carried no predicate at all.
  assert.deepEqual(optionsSeen[0], ["TRSTATUS = 'R'"])
  assert.deepEqual(optionsSeen[1], [])
})
