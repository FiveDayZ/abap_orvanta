import assert from "node:assert/strict"
import test from "node:test"
import { collectUserAuthorizations } from "../src/user-authorizations.js"
import { parseSapDataQueryResponse } from "../src/data-query.js"
import type { RemoteFunctionRequest, SapBackend } from "../src/backend.js"

const readerDefinition = {
  functionName: "RFC_READ_TABLE",
  remoteEnabled: true,
  updateTask: false,
  sourceFingerprint: "7b9a603493673d26f75e555616b24d150e407ce03eff57e9c68f0b30b1ba0c2d",
  interfaceFingerprint: "d06cc5c1ce05960bde526ecf27e38606134146474cc8da19f93ac2abd3e48074"
}

let emptyHtml: unknown
try {
  parseSapDataQueryResponse({ body: "", status: 200, headers: { "content-type": "text/html" } })
} catch (error) {
  emptyHtml = error
}

type Double = {
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">
  tables: string[]
  conditions: string[]
}

/** The approved assignment tables are not in the shared mock, so rows are stored per table. */
function double(rows: Record<string, string[][]>): Double {
  const tables: string[] = []
  const conditions: string[] = []
  const backend = {
    runQuery: async () => {
      throw emptyHtml
    },
    callRemoteFunction: async (_connection: string, request: RemoteFunctionRequest) => {
      assert.equal(request.functionName, "RFC_READ_TABLE")
      const fields = request.inputParameters.FIELDS as { FIELDNAME: string }[]
      const table = String(request.inputParameters.QUERY_TABLE)
      const options = (request.inputParameters.OPTIONS ?? []) as { TEXT: string }[]
      tables.push(table)
      conditions.push(options.map((option) => option.TEXT).join(" AND "))
      return {
        outputs: {
          FIELDS: fields,
          DATA: (rows[table] ?? []).map((values) => ({ WA: values.join("|") }))
        }
      }
    }
  }
  return { backend: backend as unknown as Double["backend"], tables, conditions }
}

const assignmentRow = [
  "200", // MANDT
  "Z_ROLE_DISPLAY", // AGR_NAME
  "WYS", // UNAME
  "20260101", // FROM_DAT
  "99991231", // TO_DAT
  "", // EXCLUDE
  "20260101", // CHANGE_DAT
  "101500", // CHANGE_TIM
  "2026010110150000000", // CHANGE_TST
  "", // ORG_FLAG
  "X" // COL_FLAG
]

const transactionRow = [
  "200", // MANDT
  "Z_ROLE_DISPLAY", // AGR_NAME
  "TR", // TYPE
  "SE38", // TCODE
  "", // EXCLUDE
  "X", // DIRECT
  "", // INHERITED
  "00001" // FOLDER
]

const profileRow = [
  "200", // MANDT
  "WYS", // BNAME
  "SAP_ALL" // PROFILE
]

test("a user read reports assignments and profiles as stored, never as an authorization decision", async () => {
  const { backend, tables, conditions } = double({
    AGR_USERS: [assignmentRow],
    UST04: [profileRow]
  })
  const result = await collectUserAuthorizations(
    backend,
    "w200",
    { userName: "WYS" },
    async () => readerDefinition
  )
  assert.equal(result.status, "ok")
  assert.equal(result.readOnly, true)
  assert.equal(result.notAnAuthorizationCheck, true)
  assert.deepEqual(tables, ["AGR_USERS", "UST04"], "AGR_TCODES needs a role or a flag")
  assert.deepEqual(conditions, ["UNAME = 'WYS'", "BNAME = 'WYS'"])
  assert.equal(result.counts.roleAssignments, 1)
  assert.equal(result.roleAssignments[0]!.roleName, "Z_ROLE_DISPLAY")
  assert.equal(result.roleAssignments[0]!.validFrom, "20260101")
  assert.equal(result.roleAssignments[0]!.validTo, "99991231")
  assert.equal(result.roleAssignments[0]!.collectiveFlag, "X")
  assert.equal(result.counts.profiles, 1)
  assert.equal(result.profiles[0]!.profile, "SAP_ALL")
  assert.match(result.notes.join(" "), /not an authorization check/)
  assert.match(result.notes.join(" "), /SU53\/ST01/)
  assert.match(result.notes.join(" "), /AGR_TCODES was not read/)
  assert.match(result.notes.join(" "), /does not decide whether an assignment is active/)
})

test("a role read filters both the assignment and the transaction table by role name", async () => {
  const { backend, tables, conditions } = double({
    AGR_USERS: [assignmentRow],
    AGR_TCODES: [transactionRow]
  })
  const result = await collectUserAuthorizations(
    backend,
    "w200",
    { roleName: "Z_ROLE_DISPLAY" },
    async () => readerDefinition
  )
  assert.deepEqual(tables, ["AGR_USERS", "AGR_TCODES"])
  assert.deepEqual(conditions, ["AGR_NAME = 'Z_ROLE_DISPLAY'", "AGR_NAME = 'Z_ROLE_DISPLAY'"])
  assert.equal(result.counts.roleTransactions, 1)
  assert.equal(result.roleTransactions[0]!.transactionCode, "SE38")
  assert.equal(result.roleTransactions[0]!.direct, "X")
  assert.equal(result.roleTransactions[0]!.nodeType, "TR")
  assert.equal(result.filters.includeRoleTransactions, true)
  assert.equal(result.filters.includeProfiles, false)
})

test("a profile read keeps its own condition", async () => {
  const { backend, tables, conditions } = double({ UST04: [profileRow] })
  const result = await collectUserAuthorizations(
    backend,
    "w200",
    { profileName: "SAP_ALL" },
    async () => readerDefinition
  )
  assert.deepEqual(tables, ["AGR_USERS", "UST04"])
  assert.deepEqual(conditions, ["", "PROFILE = 'SAP_ALL'"])
  assert.equal(result.profiles[0]!.userName, "WYS")
})

test("an unfiltered read stays on the widest-narrowest table and says so", async () => {
  const { backend, tables } = double({ AGR_USERS: [assignmentRow] })
  const result = await collectUserAuthorizations(backend, "w200", {}, async () => readerDefinition)
  assert.deepEqual(tables, ["AGR_USERS"])
  assert.equal(result.notes.filter((note) => /was not read/.test(note)).length, 2)
  assert.equal(result.filters.includeProfiles, false)
})

test("an over-long role name is refused before SAP is called", async () => {
  const { backend, tables } = double({})
  await assert.rejects(
    collectUserAuthorizations(
      backend,
      "w200",
      { roleName: "R".repeat(31) },
      async () => readerDefinition
    ),
    /USER_AUTHORIZATIONS_SCOPE_INVALID/
  )
  assert.deepEqual(tables, [])
})

test("a bounded read reports truncation per table", async () => {
  const { backend } = double({ AGR_USERS: [assignmentRow, assignmentRow, assignmentRow] })
  const result = await collectUserAuthorizations(
    backend,
    "w200",
    { maxRows: 2 },
    async () => readerDefinition
  )
  assert.equal(result.status, "partial")
  assert.equal(result.counts.roleAssignments, 2)
  assert.equal(result.truncated.roleAssignments, true)
  assert.equal(result.truncated.profiles, false)
})
