import assert from "node:assert/strict"
import test from "node:test"
import { collectRoleAuthorizations } from "../src/role-authorizations.js"
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
  fields: string[][]
}

/** The approved authorization tables are not in the shared mock, so rows are stored per table. */
function double(rows: Record<string, string[][]>, failing: string[] = []): Double {
  const tables: string[] = []
  const conditions: string[] = []
  const fields: string[][] = []
  const backend = {
    runQuery: async () => {
      throw emptyHtml
    },
    callRemoteFunction: async (_connection: string, request: RemoteFunctionRequest) => {
      assert.equal(request.functionName, "RFC_READ_TABLE")
      const requested = request.inputParameters.FIELDS as { FIELDNAME: string }[]
      const table = String(request.inputParameters.QUERY_TABLE)
      const options = (request.inputParameters.OPTIONS ?? []) as { TEXT: string }[]
      tables.push(table)
      conditions.push(options.map((option) => option.TEXT).join(" AND "))
      fields.push(requested.map((field) => field.FIELDNAME))
      if (failing.includes(table)) return { fault: { name: "NOT_AUTHORIZED" } }
      // A real read is filtered by SAP, and the reviewed reader refuses a row whose filtered field
      // does not match, so the double has to filter as well.
      const names = requested.map((field) => field.FIELDNAME)
      const predicates = options.map((option) => {
        const parsed = /^([A-Z0-9_/]+) = '(.*)'$/.exec(option.TEXT)
        assert.ok(parsed, `unexpected condition ${option.TEXT}`)
        return { index: names.indexOf(parsed[1]!), value: parsed[2]!.replaceAll("''", "'") }
      })
      const matching = (rows[table] ?? []).filter((row) =>
        predicates.every((predicate) => row[predicate.index] === predicate.value)
      )
      return {
        outputs: {
          FIELDS: requested,
          DATA: matching.map((values) => ({ WA: values.join("|") }))
        }
      }
    }
  }
  return { backend: backend as unknown as Double["backend"], tables, conditions, fields }
}

const value = (object: string, field: string, low: string, high = "", counter = "000001") => [
  "200", // MANDT
  "Z_WMS_FHTZS_02_8050", // AGR_NAME
  counter, // COUNTER
  object, // OBJECT
  field, // FIELD
  low, // LOW
  high, // HIGH
  "", // DELETED
  "", // MODIFIED
  "", // COPIED
  "", // NEU
  "", // AUTH
  "", // VARIANT
  "000001" // NODE
]

const level = (variable: string, low: string, high = "", counter = "000001") => [
  "200", // MANDT
  "Z_WMS_FHTZS_02_8050", // AGR_NAME
  counter, // COUNTER
  variable, // VARBL
  low, // LOW
  high // HIGH
]

const profile = (language: string, name: string, text: string) => [
  "200", // MANDT
  "Z_WMS_FHTZS_02_8050", // AGR_NAME
  language, // LANGU
  name, // PROFILE
  text // PTEXT
]

const profileObject = (name: string, object: string, auth: string, status = "A") => [
  "200", // MANDT
  name, // PROFN
  object, // OBJCT
  auth, // AUTH
  status // AKTPS
]

const subprofile = (name: string, sub: string, status = "A") => [
  "200", // MANDT
  name, // PROFN
  sub, // SUBPROF
  status // AKTPS
]

test("a role is resolved into stored authorization objects, fields and values, never into a decision", async () => {
  const { backend, tables, conditions, fields } = double({
    AGR_1251: [
      value("S_TCODE", "TCD", "ZW60"),
      value("S_TCODE", "TCD", "ZW65", "", "000002"),
      value("ZDOC", "ZWERKS2", "*", "", "000005")
    ],
    AGR_1252: [level("$WERKS", "8050")],
    AGR_PROF: [profile("1", "T-G2802611", "role profile")]
  })
  const result = await collectRoleAuthorizations(
    backend,
    "w200",
    { roleName: "Z_WMS_FHTZS_02_8050" },
    async () => readerDefinition
  )
  assert.equal(result.status, "ok")
  assert.equal(result.readOnly, true)
  assert.equal(result.notAnAuthorizationCheck, true)
  assert.deepEqual(tables, ["AGR_1251", "AGR_1252", "AGR_PROF"], "the profile path needs its flag")
  assert.deepEqual(conditions, [
    "AGR_NAME = 'Z_WMS_FHTZS_02_8050'",
    "AGR_NAME = 'Z_WMS_FHTZS_02_8050'",
    "AGR_NAME = 'Z_WMS_FHTZS_02_8050'"
  ])
  assert.deepEqual(fields[0], [
    "MANDT",
    "AGR_NAME",
    "COUNTER",
    "OBJECT",
    "FIELD",
    "LOW",
    "HIGH",
    "DELETED",
    "MODIFIED",
    "COPIED",
    "NEU",
    "AUTH",
    "VARIANT",
    "NODE"
  ])
  assert.deepEqual(
    result.authorizationObjects.map((entry) => entry.object),
    ["S_TCODE", "ZDOC"],
    "objects keep the order SAP returned"
  )
  const tcode = result.authorizationObjects[0]!
  assert.equal(tcode.fields.length, 1)
  assert.deepEqual(
    tcode.fields[0]!.values.map((entry) => entry.low),
    ["ZW60", "ZW65"],
    "both stored values of the same object and field are kept"
  )
  assert.equal(tcode.fields[0]!.values[1]!.counter, "000002")
  assert.equal(
    result.authorizationObjects[1]!.fields[0]!.values[0]!.low,
    "*",
    "wildcards stay verbatim"
  )
  assert.equal(result.counts.authorizationObjects, 2)
  assert.equal(result.counts.authorizationFields, 2)
  assert.equal(result.counts.authorizationValues, 3)
  assert.deepEqual(result.organizationLevels, [
    { variable: "$WERKS", low: "8050", high: "", counter: "000001" }
  ])
  assert.deepEqual(result.profiles, [
    { language: "1", profile: "T-G2802611", text: "role profile" }
  ])
  assert.equal(result.profileObjects, null)
  const notes = result.notes.join(" ")
  assert.match(notes, /not an authorization check/)
  assert.match(notes, /never interpreted/)
  assert.match(notes, /USOBT\/USOBT_C and USOBX\/USOBX_C are deliberately not read/)
  assert.match(notes, /cannot prove that a role does not exist/)
  assert.match(notes, /UST10S\/UST10C\) was not read/)
})

test("the profile path expands each distinct profile once, never once per language", async () => {
  const { backend, tables, conditions } = double({
    AGR_1251: [value("S_TCODE", "TCD", "ZW60")],
    AGR_1252: [],
    AGR_PROF: [
      profile("1", "T-G2802611", "role profile"),
      profile("E", "T-G2802611", "role profile"),
      profile("1", "T-G2802612", "second role profile")
    ],
    UST10S: [
      profileObject("T-G2802611", "S_TCODE", "T-G280261100"),
      profileObject("T-G2802611", "ZDOC", "T-G280261101", ""),
      profileObject("T-G2802612", "S_TCODE", "T-G280261200")
    ],
    UST10C: [subprofile("T-G2802611", "S_A.SYSTEM"), subprofile("T-G2802612", "S_A.USER")]
  })
  const result = await collectRoleAuthorizations(
    backend,
    "w200",
    { roleName: "Z_WMS_FHTZS_02_8050", includeProfileObjects: true },
    async () => readerDefinition
  )
  assert.equal(result.status, "ok")
  assert.deepEqual(tables, [
    "AGR_1251",
    "AGR_1252",
    "AGR_PROF",
    "UST10S",
    "UST10C",
    "UST10S",
    "UST10C"
  ])
  assert.deepEqual(conditions.slice(3), [
    "PROFN = 'T-G2802611'",
    "PROFN = 'T-G2802611'",
    "PROFN = 'T-G2802612'",
    "PROFN = 'T-G2802612'"
  ])
  assert.equal(result.profileObjects?.length, 2)
  const first = result.profileObjects![0]!
  assert.equal(first.profile, "T-G2802611")
  assert.deepEqual(
    first.objects.map((entry) => [
      entry.authorizationObject,
      entry.authorizationName,
      entry.status
    ]),
    [
      ["S_TCODE", "T-G280261100", "A"],
      ["ZDOC", "T-G280261101", ""]
    ],
    "the profile's stored status is reported verbatim"
  )
  assert.deepEqual(first.subprofiles, [{ subprofile: "S_A.SYSTEM", status: "A" }])
  assert.equal(result.counts.profileObjects, 3)
  assert.equal(result.counts.profileSubprofiles, 2)
  assert.equal(result.filters.includeProfileObjects, true)
  assert.match(
    result.notes.join(" "),
    /the profile's object list \(UST10S\/UST10C\), not its field values/
  )
})

test("an empty role name is refused before SAP is called and says nothing about existence", async () => {
  const blank = double({ AGR_1251: [], AGR_1252: [], AGR_PROF: [] })
  await assert.rejects(
    collectRoleAuthorizations(
      blank.backend,
      "w200",
      { roleName: "   " },
      async () => readerDefinition
    ),
    /ROLE_AUTHORIZATIONS_SCOPE_INVALID/
  )
  assert.deepEqual(blank.tables, [])
  const long = double({ AGR_1251: [], AGR_1252: [], AGR_PROF: [] })
  await assert.rejects(
    collectRoleAuthorizations(
      long.backend,
      "w200",
      { roleName: "R".repeat(31) },
      async () => readerDefinition
    ),
    /ROLE_AUTHORIZATIONS_SCOPE_INVALID/
  )
  assert.deepEqual(long.tables, [])
})

test("an impossible row limit is refused with the tool's own code", async () => {
  const { backend, tables } = double({})
  await assert.rejects(
    collectRoleAuthorizations(
      backend,
      "w200",
      { roleName: "Z_ROLE", maxRows: 0 },
      async () => readerDefinition
    ),
    /ROLE_AUTHORIZATIONS_ROW_LIMIT_INVALID/
  )
  assert.deepEqual(tables, [])
})

test("a bounded read reports truncation per source instead of claiming a complete role", async () => {
  const { backend } = double({
    AGR_1251: [
      value("S_TCODE", "TCD", "ZW60"),
      value("S_TCODE", "TCD", "ZW65", "", "000002"),
      value("ZDOC", "ZWERKS2", "*", "", "000005")
    ],
    AGR_1252: [level("$WERKS", "8050")],
    AGR_PROF: [profile("1", "T-G2802611", "role profile")]
  })
  const result = await collectRoleAuthorizations(
    backend,
    "w200",
    { roleName: "Z_WMS_FHTZS_02_8050", maxRows: 2 },
    async () => readerDefinition
  )
  assert.equal(result.status, "partial")
  assert.equal(result.counts.authorizationValues, 2)
  assert.equal(result.truncated.authorizationValues, true)
  assert.equal(result.truncated.organizationLevels, false)
  assert.equal(result.truncated.profiles, false)
  assert.equal(result.rowLimit, 2)
})

test("the row limit is capped at the allowlist ceiling and the answer says so", async () => {
  const { backend } = double({ AGR_1251: [], AGR_1252: [], AGR_PROF: [] })
  const result = await collectRoleAuthorizations(
    backend,
    "w200",
    { roleName: "Z_WMS_FHTZS_02_8050", maxRows: 900 },
    async () => readerDefinition
  )
  assert.equal(result.rowLimitRequested, 900)
  assert.equal(result.rowLimit, 500)
  assert.equal(result.rowLimitApplied, true)
})

test("a refused read keeps the tool's own code and never invents an answer", async () => {
  const { backend } = double({}, ["AGR_1251", "AGR_1252", "AGR_PROF"])
  const result = await collectRoleAuthorizations(
    backend,
    "w200",
    { roleName: "Z_WMS_FHTZS_02_8050" },
    async () => readerDefinition
  )
  assert.equal(result.status, "unavailable")
  assert.deepEqual(result.authorizationObjects, [])
  assert.deepEqual(result.organizationLevels, [])
  assert.deepEqual(result.profiles, [])
  assert.ok(result.sources.every((source) => source.code === "ROLE_AUTHORIZATIONS_NOT_AUTHORIZED"))
  assert.ok(result.queryWarnings.includes("AGR_1251: ROLE_AUTHORIZATIONS_NOT_AUTHORIZED"))
})
