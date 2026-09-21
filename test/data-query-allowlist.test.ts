import assert from "node:assert/strict"
import test from "node:test"
import { ToolService, assertQueryTablesAllowed } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"

test("the query allowlist enumerates every table the statement reads", () => {
  assert.deepEqual(assertQueryTablesAllowed("SELECT WERKS FROM T001W"), ["T001W"])
  assert.deepEqual(assertQueryTablesAllowed("select werks from t001w"), ["T001W"])
  assert.deepEqual(assertQueryTablesAllowed("SELECT * FROM T001W AS W WHERE W~WERKS = '1000'"), [
    "T001W"
  ])
  assert.deepEqual(
    assertQueryTablesAllowed("SELECT * FROM T001W INNER JOIN T001 ON T001W~WERKS = T001~WERKS"),
    ["T001", "T001W"]
  )
  // A string literal that looks like a table reference is masked, not parsed.
  assert.deepEqual(assertQueryTablesAllowed("SELECT MANDT FROM T000 WHERE MTEXT = 'FROM USR02'"), [
    "T000"
  ])
  // A subquery's own tables count as well: the inner FROM is a read path too.
  assert.deepEqual(
    assertQueryTablesAllowed("SELECT * FROM T000 WHERE MANDT IN ( SELECT MANDT FROM T001 )"),
    ["T000", "T001"]
  )
})

test("a table outside the allowlist is rejected on the native path", async () => {
  const backend = new MockBackend()
  let nativeCalls = 0
  backend.runQuery = async () => {
    nativeCalls++
    // The mock used to answer this table, which is exactly how the bypass went unnoticed.
    return [{ ID: "1", NAME: "ALPHA" }]
  }
  const tools = new ToolService(backend)
  const query = (sql: string) =>
    tools.executeDataQuery({
      connectionId: "w200",
      sql,
      displayMode: "internal",
      rowRange: { start: 0, end: 1 }
    })

  await assert.rejects(
    query("SELECT * FROM ZDATA"),
    /TABLE_NOT_ALLOWED: table ZDATA is not present/
  )
  await assert.rejects(query("SELECT * FROM USR02"), /table USR02 is explicitly excluded/)
  await assert.rejects(query("SELECT * FROM MARA"), /table MARA is collected but not yet/)
  await assert.rejects(
    query("SELECT * FROM T001W JOIN ZDATA ON T001W~WERKS = ZDATA~ID"),
    /TABLE_NOT_ALLOWED: table ZDATA/
  )
  assert.equal(nativeCalls, 0, "no rejected statement may reach SAP")
})

test("a statement whose tables cannot be enumerated is rejected before SAP access", async () => {
  const backend = new MockBackend()
  let nativeCalls = 0
  backend.runQuery = async () => {
    nativeCalls++
    return []
  }
  const tools = new ToolService(backend)
  const query = (sql: string) =>
    tools.executeDataQuery({
      connectionId: "w200",
      sql,
      displayMode: "internal",
      rowRange: { start: 0, end: 1 }
    })

  // Dynamic table name, comma-joined table list, and a missing FROM target all fail closed: the
  // allowlist cannot name what it cannot parse, and guessing would defeat it.
  await assert.rejects(query("SELECT * FROM @lt_table"), /TABLE_ALLOWLIST_UNVERIFIABLE/)
  await assert.rejects(query("SELECT * FROM T000, T001"), /TABLE_ALLOWLIST_UNVERIFIABLE/)
  await assert.rejects(query("SELECT * FROM"), /TABLE_ALLOWLIST_UNVERIFIABLE/)
  assert.equal(nativeCalls, 0, "no unenumerable statement may reach SAP")
})

test("an allowlisted statement still reaches the native path", async () => {
  const backend = new MockBackend()
  const statements: string[] = []
  backend.runQuery = async (_connectionId, sql) => {
    statements.push(sql)
    return [{ WERKS: "1000", NAME1: "ALPHA PLANT" }]
  }
  const result = JSON.parse(
    await new ToolService(backend).executeDataQuery({
      connectionId: "w200",
      sql: "SELECT WERKS, NAME1 FROM T001W WHERE WERKS = '1000'",
      displayMode: "internal",
      rowRange: { start: 0, end: 1 }
    })
  )
  assert.deepEqual(statements, ["SELECT WERKS, NAME1 FROM T001W WHERE WERKS = '1000'"])
  assert.deepEqual(result.data, [{ WERKS: "1000", NAME1: "ALPHA PLANT" }])
})
