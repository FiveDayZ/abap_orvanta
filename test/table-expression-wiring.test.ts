import assert from "node:assert/strict"
import test from "node:test"
import type { RemoteFunctionRequest } from "../src/backend.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"

// The wiring proof. The unit tests above call `readGroupedRows` with a type map handed to them, so
// they cannot show that `execute_data_query` actually builds one - and a term computed under a
// guessed calculation type is exactly the failure this layer exists to prevent. This test drives the
// tool, so the dictionary read and the resolver are on the path the caller uses.

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

// The reader's own one-character type for ZAEHL is deliberately "C" here while DD03L says INT4: the
// two disagree on purpose, so the answer shows which source the calculation type came from. If the
// reader's type had been used, ZAEHL would be a character field, `ZAEHL / 2` would be a packed
// division, and the answer would be a refusal instead of 4.
interface FakeTable {
  name: string
  fields: string[]
  readerTypes: Record<string, string>
  rows: Record<string, string>[]
}

const table: FakeTable = {
  name: "T006",
  fields: ["MANDT", "MSEHI", "ZAEHL", "TEMP_VALUE", "RAW16"],
  readerTypes: { MANDT: "C", MSEHI: "C", ZAEHL: "C", TEMP_VALUE: "C", RAW16: "C" } as Record<
    string,
    string
  >,
  rows: [{ MANDT: "200", MSEHI: "1", ZAEHL: "7", TEMP_VALUE: "0.000000000E+00", RAW16: "0" }]
}

/** The second table of a joined statement, and the one a term's operand is not read from. */
const second: FakeTable = {
  name: "T001",
  fields: ["MANDT", "BUTXT"],
  readerTypes: { MANDT: "C", BUTXT: "C" } as Record<string, string>,
  rows: [{ MANDT: "200", BUTXT: "Orbit" }]
}
const dictionary = {
  name: "DD03L",
  fields: ["FIELDNAME", "DATATYPE", "LENG", "DECIMALS", "TABNAME", "AS4LOCAL"],
  readerTypes: { DECIMALS: "N", LENG: "N" } as Record<string, string>,
  rows: [
    {
      FIELDNAME: "MSEHI",
      DATATYPE: "UNIT",
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
      FIELDNAME: "TEMP_VALUE",
      DATATYPE: "FLTP",
      LENG: "000016",
      DECIMALS: "16",
      TABNAME: "T006",
      AS4LOCAL: "A"
    },
    // A real dictionary row that carries no type: the DDIC type column is empty for the pseudo-fields
    // of an Include, which is what one looks like. The field exists in the table definition, so the
    // platform accepts it, and the refusal has to come from this layer.
    {
      FIELDNAME: "RAW16",
      DATATYPE: "",
      LENG: "000016",
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
      FIELDNAME: "MANDT",
      DATATYPE: "CLNT",
      LENG: "000003",
      DECIMALS: "0",
      TABNAME: "T001",
      AS4LOCAL: "A"
    },
    {
      FIELDNAME: "BUTXT",
      DATATYPE: "CHAR",
      LENG: "000025",
      DECIMALS: "0",
      TABNAME: "T001",
      AS4LOCAL: "A"
    }
  ]
}
const tables = [table, second, dictionary]
const definition = (entry: (typeof tables)[number]) => ({
  objectKind: "transparentTable",
  objectName: entry.name,
  fingerprint: "a".repeat(64),
  definition: {
    tableClass: "TRANSP",
    fields: entry.fields.map((name) => ({ name, key: name === "MSEHI" }))
  }
})
const lengths: Record<string, string> = {
  MANDT: "000003",
  BUTXT: "000025",
  MSEHI: "000003",
  ZAEHL: "000010",
  TEMP_VALUE: "000016",
  FIELDNAME: "000030",
  DATATYPE: "000004",
  LENG: "000006",
  DECIMALS: "000006",
  TABNAME: "000030",
  AS4LOCAL: "000001",
  RAW16: "000016"
}

function harness(options: { failDictionary?: boolean } = {}) {
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
          TYPE: entry.readerTypes[FIELDNAME] ?? "C",
          LENGTH: lengths[FIELDNAME]!,
          OFFSET: String(offset)
        }
        offset += Number(field.LENGTH) + 1
        return field
      })
      if (request.inputParameters.NO_DATA === "X") return { outputs: { FIELDS: fields, DATA: [] } }
      // The legacy reader is the default; the aligned one is reached only as a fallback, and these
      // small tables never need it. Whichever the reader picked, it is one of the two reviewed ones.
      assert.ok(["RFC_READ_TABLE", "BBP_RFC_READ_TABLE"].includes(request.functionName))
      // A dictionary answer that cannot be parsed: the read does not complete, which is a different
      // failure from a dictionary that types nothing.
      if (options.failDictionary && entry.name === "DD03L")
        return { outputs: { FIELDS: fields, DATA: [{ WA: "x" }] } }
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
    JSON.stringify(
      definition(
        tables.find((entry) => entry.name === (input as { objectName: string }).objectName)!
      )
    )
  tools.readFunctionModuleInterface = async (input: unknown) =>
    JSON.stringify(
      (input as { functionName: string }).functionName === legacy.functionName ? legacy : aligned
    )
  return { tools, requests }
}

function query(sql: string, options: { failDictionary?: boolean } = {}) {
  const { tools, requests } = harness(options)
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

test("execute_data_query types a projected term from DD03L, not from the reader's field type", async () => {
  const { requests, run } = query("SELECT MSEHI, ZAEHL / 2 FROM T006")
  const result = JSON.parse(await run())
  // The operand types were read from the dictionary, and the dictionary read is the one the term
  // forced: without a term this statement never touches DD03L.
  const dictionaryReads = requests.filter((r) => r.inputParameters.QUERY_TABLE === "DD03L")
  assert.equal(dictionaryReads.length, 2, "one dictionary layout preflight and one dictionary read")
  // INT4 is an integer calculation, and integer division rounds commercially: 7 / 2 is 4. Reading the
  // reader's one-character type instead would have made this a packed division and refused it.
  assert.deepEqual(result.data, [{ MSEHI: "1", EXPR_1: "4" }])
  assert.deepEqual(result.querySource.expressionColumns, [
    { expression: "ZAEHL / 2", column: "EXPR_1" }
  ])
})

test("execute_data_query reads no dictionary for a statement without a term", async () => {
  const { requests, run } = query("SELECT MSEHI FROM T006")
  const result = JSON.parse(await run())
  assert.equal(requests.filter((r) => r.inputParameters.QUERY_TABLE === "DD03L").length, 0)
  assert.deepEqual(result.data, [{ MSEHI: "1" }])
  // The reply lists the derived columns of a statement that has none as an empty list, the way it
  // lists the aggregates of a statement that has none.
  assert.deepEqual(result.querySource.expressionColumns, [])
})

test("execute_data_query refuses a floating point operand for what it is, through the tool path", async () => {
  const { run } = query("SELECT MSEHI, TEMP_VALUE * 2 FROM T006")
  await assert.rejects(run(), /TABLE_QUERY_EXPRESSION_FLOAT: .*FLTP/)
})

test("execute_data_query refuses a term whose operand the dictionary leaves untyped", async () => {
  const { run } = query("SELECT MSEHI, RAW16 * 2 FROM T006")
  await assert.rejects(run(), /TABLE_QUERY_EXPRESSION_TYPE_UNKNOWN: .*RAW16/)
})

// A dictionary read that did not complete must not be reported as a dictionary that types nothing:
// the first is a failed read, the second is a fact about the field, and only one of them happened.
test("execute_data_query names a dictionary read that did not complete as such", async () => {
  const { run } = query("SELECT MSEHI, ZAEHL / 2 FROM T006", { failDictionary: true })
  await assert.rejects(
    run(),
    /TABLE_QUERY_EXPRESSION_DICTIONARY_UNAVAILABLE: .*DD03L.*TABLE_QUERY_RESPONSE_INVALID/
  )
})

// The same wiring on the WHERE path: the term is decided here, so its operand types have to come from
// the dictionary before the read, and the tool must not decide that by looking only at the projection.
test("execute_data_query types a WHERE term from DD03L and decides it here", async () => {
  const { requests, run } = query("SELECT MSEHI FROM T006 WHERE ZAEHL / 2 = 4")
  const result = JSON.parse(await run())
  assert.equal(requests.filter((r) => r.inputParameters.QUERY_TABLE === "DD03L").length, 2)
  // Nothing was pushed: the reader's structured filter takes a column name, and this condition has
  // none. ZAEHL was read for the predicate and is not published. One logical read is a layout
  // preflight plus the data read.
  const reads = requests.filter((r) => r.inputParameters.QUERY_TABLE === "T006")
  assert.equal(reads.length, 2)
  for (const read of reads) assert.deepEqual(read.inputParameters.OPTIONS ?? [], [])
  assert.deepEqual(result.data, [{ MSEHI: "1" }])
  assert.deepEqual(result.querySource.whereExpressions, [
    { expression: "ZAEHL / 2", operator: "EQ", value: "4", disjunct: 0 }
  ])
  assert.deepEqual(result.querySource.expressionColumns, [])
})

test("execute_data_query reads no dictionary for a plain comparison in the WHERE clause", async () => {
  const { requests, run } = query("SELECT MSEHI FROM T006 WHERE MSEHI = '1'")
  const result = JSON.parse(await run())
  assert.equal(requests.filter((r) => r.inputParameters.QUERY_TABLE === "DD03L").length, 0)
  assert.deepEqual(result.data, [{ MSEHI: "1" }])
  assert.deepEqual(result.querySource.whereExpressions, [])
})

test("execute_data_query refuses a WHERE term it cannot type, through the tool path", async () => {
  const { run } = query("SELECT MSEHI FROM T006 WHERE TEMP_VALUE * 2 > 1")
  await assert.rejects(run(), /TABLE_QUERY_EXPRESSION_FLOAT: .*FLTP/)
})

// The joined path needs the same typing, keyed by the alias: a term in a joined projection names
// `A.ZAEHL`, and the dictionary that types it is the one of the table `A` stands for.
test("execute_data_query types a joined term from the dictionary of the table its alias names", async () => {
  const { requests, run } = query(
    "SELECT A.ZAEHL / 2, B.BUTXT FROM T006 A INNER JOIN T001 B ON A.MANDT = B.MANDT"
  )
  const result = JSON.parse(await run())
  // Two calls per dictionary read: one layout preflight (no filter) and one data read (filtered).
  // Only `T006` is asked about, because only `T006` has a term operand - the join key of `B` needs no
  // dictionary at all, and asking about `T001` would be a read this statement does not need.
  const dictionaryOptions = requests
    .filter((r) => r.inputParameters.QUERY_TABLE === "DD03L")
    .map((r) =>
      ((r.inputParameters.OPTIONS ?? []) as { TEXT: string }[]).map((option) => option.TEXT).join()
    )
  assert.equal(dictionaryOptions.length, 2)
  const filtered = dictionaryOptions.filter((options) => options !== "")
  assert.equal(filtered.length, 1)
  assert.match(filtered[0]!, /TABNAME = 'T006'/)
  for (const options of dictionaryOptions) assert.doesNotMatch(options, /T001/)
  // INT4 is an integer calculation, so 7 / 2 is 4; the reader's own one-character type for ZAEHL is
  // deliberately "C" here, which would have made this a packed division and refused it.
  assert.deepEqual(result.data, [{ "B.BUTXT": "Orbit", EXPR_1: "4" }])
  assert.deepEqual(result.querySource.expressionColumns, [
    { expression: "A.ZAEHL / 2", column: "EXPR_1" }
  ])
})

test("execute_data_query reads no dictionary for a joined statement without a term", async () => {
  const { requests, run } = query(
    "SELECT A.MSEHI, B.BUTXT FROM T006 A INNER JOIN T001 B ON A.MANDT = B.MANDT"
  )
  const result = JSON.parse(await run())
  assert.equal(requests.filter((r) => r.inputParameters.QUERY_TABLE === "DD03L").length, 0)
  assert.deepEqual(result.data, [{ "A.MSEHI": "1", "B.BUTXT": "Orbit" }])
  assert.deepEqual(result.querySource.expressionColumns, [])
})
