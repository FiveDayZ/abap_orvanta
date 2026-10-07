import assert from "node:assert/strict"
import test from "node:test"
import {
  readConfigurationNumberRange,
  numberRangeIntervalLayout,
  numberRangeIntervalFields
} from "../src/configuration-number-range.js"
import {
  readConfigurationBcSet,
  findConfigurationBcSets,
  configurationBcSetLayouts,
  configurationBcSetFields,
  configurationBcSetDomains,
  configurationBcMaintenanceTables
} from "../src/configuration-bc-set.js"
import { toolContracts } from "../src/contracts.js"
import { toolNamesForProfile } from "../src/tool-registry.js"
import {
  inspectConfigurationTransport,
  configurationTransportLayouts,
  configurationTransportDomains,
  configurationTransportFields,
  configurationUnitTextTransportLayouts,
  configurationUnitTextTransportFields
} from "../src/configuration-transport.js"
import { compareConfigurationUnit } from "../src/configuration-compare.js"
import {
  readConfigurationUnitProjection,
  configurationUnitComparisonLayouts,
  configurationUnitLayouts
} from "../src/configuration-unit.js"
import {
  readConfigurationFiRule,
  configurationFiRuleLayouts,
  configurationFiRuleFields,
  configurationFiActivationDomain
} from "../src/configuration-fi-rule.js"

const nrInput = {
  connectionId: "w200",
  objectName: "ZTEST",
  subobject: "",
  year: "0000",
  maxIntervals: 2
}
const row = (NRRANGENR = "01") => ({
  ...Object.fromEntries(numberRangeIntervalFields.map((f) => [f, ""])),
  CLIENT: "200",
  OBJECT: "ZTEST",
  TOYEAR: "0000",
  NRRANGENR,
  FROMNUMBER: "00000000000000000001",
  TONUMBER: "99999999999999999999",
  NRLEVEL: "99999999999999999998"
})
const definition = () => ({
  connectionId: "w200",
  objectKind: "numberRangeObject",
  objectName: "ZTEST",
  version: "a".repeat(40),
  fingerprint: "a".repeat(64),
  definition: { properties: { OBJECT: "ZTEST", YEARIND: "", DTELSOBJ: "", BUFFER: "X" } }
})
const table = async (objectName: string) => ({
  connectionId: "w200",
  objectKind: "transparentTable",
  objectName,
  fingerprint:
    objectName === "NRIV"
      ? numberRangeIntervalLayout
      : objectName in configurationBcMaintenanceTables
        ? configurationBcMaintenanceTables[
            objectName as keyof typeof configurationBcMaintenanceTables
          ].fingerprint
        : configurationBcSetLayouts[objectName as keyof typeof configurationBcSetLayouts],
  ...(objectName in configurationBcMaintenanceTables
    ? {
        definition: {
          fields: configurationBcMaintenanceTables[
            objectName as keyof typeof configurationBcMaintenanceTables
          ].keyFields.map((name) => ({ name, key: true }))
        }
      }
    : {})
})
const noRfc = async () =>
  assert.fail("No allocation, activation or fallback after native success/error")
const nr = (
  read = async () => [row()],
  raw: unknown = nrInput,
  readObject: () => Promise<unknown> = async () => definition()
) =>
  readConfigurationNumberRange(
    raw,
    "200",
    { runQuery: read, callRemoteFunction: noRfc },
    readObject,
    table,
    noRfc
  )

test("number-range reader preserves 20-digit values, rechecks and never allocates", async () => {
  let calls = 0
  const result = await nr(async () => {
    calls++
    return [row()]
  })
  assert.equal(result.intervals?.[0]?.NRLEVEL, "99999999999999999998")
  assert.equal(result.complete, true)
  assert.equal(result.status, "read")
  assert.match(result.readFingerprint!, /^[a-f0-9]{64}$/)
  assert.equal(calls, 2)
  assert.equal(result.saveAvailable, false)
})
test("number-range scope and active definition fail closed before any values", async () => {
  const reject = async () => assert.fail("invalid scope must not read")
  await assert.rejects(nr(reject, { ...nrInput, connectionId: "w300" }), /SCOPE_UNSUPPORTED/)
  await assert.rejects(nr(reject, { ...nrInput, subobject: "TOOLONG" }))
  await assert.rejects(nr(reject, { ...nrInput, year: "2026" }), /YEAR_UNSUPPORTED/)
  await assert.rejects(
    nr(reject, nrInput, async () => ({ ...definition(), objectName: "OTHER" })),
    /DEFINITION_MISMATCH/
  )
})
test("number-range change and failed confirmation discard values", async () => {
  let calls = 0
  const changed = await nr(async () => [
    calls++ ? { ...row(), NRLEVEL: "00000000000000000000" } : row()
  ])
  assert.equal(changed.status, "changed")
  assert.equal(changed.intervals, null)
  const denied = await nr(async () => {
    throw Error("HTTP 403")
  })
  assert.equal(denied.status, "unavailable")
  assert.equal(denied.readFingerprint, null)
  assert.equal(denied.intervals, null)
})
test("new interval during confirmation cannot produce complete fingerprint", async () => {
  let calls = 0
  const result = await nr(async () =>
    calls++ ? [row("01"), row("02"), row("03")] : [row("01"), row("02")]
  )
  assert.equal(result.truncated, true)
  assert.equal(result.complete, false)
  assert.equal(result.evidence.valuesRechecked, false)
  assert.equal(result.readFingerprint, null)
})
test("duplicate intervals do not look like absence", async () => {
  const result = await nr(async () => [row(), row()])
  assert.equal(result.status, "unavailable")
  assert.equal(result.evidence.sources[0]?.code, "NUMBER_RANGE_DUPLICATE_INTERVAL")
})
test("authoritative missing number-range object is confirmed without interval access", async () => {
  const result = await nr(
    async () => assert.fail("No NRIV read for missing definition"),
    nrInput,
    async () => ({
      connectionId: "w200",
      objectName: "ZTEST",
      objectType: "numberRangeObject",
      status: "not-found",
      exists: false,
      authoritative: true,
      readOnly: true
    })
  )
  assert.equal(result.status, "not_found")
  assert.equal(result.intervals, null)
  assert.equal(result.readFingerprint, null)
  assert.equal(result.evidence.valuesRechecked, false)
})

const bcInput = {
  connectionId: "w200",
  bcSetId: "ZTEST",
  version: "N",
  objectName: "T006A",
  maxRecords: 2,
  maxValues: 2
}
const findBc = (
  rows: () => Promise<Record<string, string>[]>,
  raw: unknown = { connectionId: "w200", version: "N", objectName: "T006A", maxRecords: 2 }
) =>
  findConfigurationBcSets(
    raw,
    "200",
    {
      runQuery: async (_id, sql) => {
        assert.match(sql, /FROM SCPRRECA WHERE VERSION = 'N' AND TABLENAME = 'T006A'/)
        return rows()
      },
      callRemoteFunction: noRfc
    },
    table,
    noRfc
  )
const candidate = (ID: string, RECNUMBER = "1") => ({
  ID,
  RECNUMBER,
  VERSION: "N",
  TABLENAME: "T006A"
})
test("BC Set discovery deduplicates IDs but validates each record key and scope", async () => {
  const r = await findBc(async () => [candidate("ZONE"), candidate("ZONE", "2")])
  assert.equal(r.status, "candidates")
  assert.deepEqual(r.candidates, ["ZONE"])
  assert.match(r.readFingerprint!, /^[a-f0-9]{64}$/)
  assert.equal(r.coverage.headersVerified, false)
  const empty = await findBc(async () => [])
  assert.equal(empty.status, "no_selected_records")
  await assert.rejects(
    findBc(async () => [], { connectionId: "w300", version: "N", objectName: "T006A" }),
    /SCOPE_UNSUPPORTED/
  )
  await assert.rejects(
    findBc(async () => [], { connectionId: "w200", version: "N", objectName: "USR02" })
  )
  const duplicate = await findBc(async () => [candidate("ZONE"), candidate("ZONE")])
  assert.equal(duplicate.status, "unavailable")
  assert.equal(duplicate.candidates, null)
})
test("BC Set discovery distinguishes failed, changed and truncated reads", async () => {
  const failed = await findBc(async () => {
    throw Error("403")
  })
  assert.equal(failed.status, "unavailable")
  assert.equal(failed.candidates, null)
  let reads = 0
  const changed = await findBc(async () => [candidate(reads++ ? "ZTWO" : "ZONE")])
  assert.equal(changed.status, "changed")
  assert.equal(changed.readFingerprint, null)
  const truncated = await findBc(async () => [
    candidate("ZONE"),
    candidate("ZTWO"),
    candidate("ZTHREE")
  ])
  assert.equal(truncated.status, "partial")
  assert.equal(truncated.coverage.truncated, true)
  assert.equal(truncated.readFingerprint, null)
})
const bcRow = (
  name: keyof typeof configurationBcSetFields,
  extra: Record<string, string> = {}
) => ({
  ...Object.fromEntries(configurationBcSetFields[name].map((f) => [f, ""])),
  ID: "ZTEST",
  VERSION: "N",
  ...(name === "SCPRATTR" ? {} : { TABLENAME: "T006A", RECNUMBER: "1" }),
  ...extra
})
const bc = (
  query: (sql: string) => Promise<Record<string, string>[]>,
  raw: unknown = bcInput,
  readMetadata: (name: string) => Promise<unknown> = table
) =>
  readConfigurationBcSet(
    raw,
    "200",
    { runQuery: async (_id, sql) => query(sql), callRemoteFunction: noRfc },
    readMetadata,
    async (objectName) => ({
      connectionId: "w200",
      objectKind: "domain",
      objectName,
      fingerprint: configurationBcSetDomains[objectName as keyof typeof configurationBcSetDomains]
    }),
    noRfc
  )
const bcQuery = async (sql: string) =>
  sql.includes("FROM SCPRATTR")
    ? [bcRow("SCPRATTR")]
    : sql.includes("FROM SCPRRECA")
      ? [bcRow("SCPRRECA")]
      : sql.includes("FROM SCPRPPRL")
        ? []
        : sql.includes("FROM SCPRVALL")
          ? []
          : [bcRow("SCPRVALS", { FIELDNAME: "MSEHT", FLAG: "VAR", VALUE: "example" })]
test("BC Set flags remain descriptive; selected content is always partial", async () => {
  const result = await bc(bcQuery)
  assert.equal(result.status, "partial")
  assert.equal(result.values?.[0]?.flagMeaning, "value_required")
  assert.equal(result.activationAvailable, false)
  assert.equal(result.coverage.complete, false)
  assert.match(result.readFingerprint!, /^[a-f0-9]{64}$/)
  await assert.rejects(bc(bcQuery, { ...bcInput, objectName: "USR02" }))
  await assert.rejects(bc(bcQuery, { ...bcInput, version: "A" }))
})

test("CUNI companion source projections use reviewed distinct keys without reading target values", async () => {
  for (const objectName of ["T006B", "T006C", "T006D"] as const) {
    const queries: string[] = [],
      pin = configurationBcMaintenanceTables[objectName]
    const r = await bc(
      async (sql) => {
        queries.push(sql)
        if (sql.includes("FROM SCPRRECA"))
          return [bcRow("SCPRRECA", { TABLENAME: objectName, OBJECTNAME: "CUNI", OBJECTTYPE: "T" })]
        if (sql.includes("FROM SCPRVALS"))
          return [
            bcRow("SCPRVALS", {
              TABLENAME: objectName,
              FIELDNAME: pin.keyFields[1],
              FLAG: "KEY",
              VALUE: objectName === "T006D" ? "PRESS" : "D"
            })
          ]
        return bcQuery(sql)
      },
      { ...bcInput, objectName }
    )
    assert.equal(r.status, "partial")
    assert.deepEqual(r.maintenanceTable?.keyFields, pin.keyFields)
    assert.equal(r.maintenanceTable?.targetReadAvailable, false)
    assert.equal(r.maintenanceTable?.targetWriteAvailable, false)
    assert.equal(r.maintenanceTable?.keyReconstruction, "not_performed")
    assert.match(r.readFingerprint!, /^[a-f0-9]{64}$/)
    assert.ok(queries.every((sql) => !sql.includes(`FROM ${objectName} `)))
    assert.ok(
      queries
        .filter((sql) => /FROM SCPR(VALS|VALL|RECA)/.test(sql))
        .every((sql) => sql.includes(`TABLENAME = '${objectName}'`))
    )
    assert.equal(r.activationAvailable, false)
  }
})

test("companion DDIC fingerprint or key drift is refused before source-content reads", async () => {
  for (const mismatch of ["fingerprint", "key"] as const) {
    let queries = 0
    await assert.rejects(
      bc(
        async () => {
          queries++
          return []
        },
        { ...bcInput, objectName: "T006D" },
        async (name) => ({
          ...(await table(name)),
          ...(mismatch === "fingerprint"
            ? { fingerprint: "f".repeat(64) }
            : { definition: { fields: [{ name: "MSEHI", key: true }] } })
        })
      ),
      /BC_SET_MAINTENANCE_LAYOUT_UNVERIFIED/
    )
    assert.equal(queries, 0)
  }
})

test("companion projections retain duplicate, truncation, language failure and drift protections", async () => {
  for (const condition of ["duplicate", "truncated", "changed", "unavailable"] as const) {
    let reads = 0
    const r = await bc(
      async (sql) => {
        if (sql.includes("FROM SCPRRECA")) return [bcRow("SCPRRECA", { TABLENAME: "T006B" })]
        if (sql.includes("FROM SCPRVALL")) {
          if (condition === "unavailable") throw Error("HTTP 403")
          const row = bcRow("SCPRVALL", {
            TABLENAME: "T006B",
            FIELDNAME: "MSEH3",
            LANGU: "D",
            VALUE: condition === "changed" ? String(reads++) : "KNM"
          })
          return condition === "duplicate"
            ? [row, row]
            : condition === "truncated"
              ? [row, { ...row, LANGU: "E" }, { ...row, LANGU: "1" }]
              : [row]
        }
        if (sql.includes("FROM SCPRVALS")) return []
        return bcQuery(sql)
      },
      { ...bcInput, objectName: "T006B" }
    )
    assert.equal(r.readFingerprint, null, condition)
    assert.equal(r.activationAvailable, false)
    if (condition === "changed") assert.equal(r.status, "changed")
    if (condition === "truncated") assert.equal(r.coverage.truncated, true)
  }
})

test("whole BC Set inventory preserves record numbers shared by different tables", async () => {
  const inventory = [
    bcRow("SCPRRECA", { TABLENAME: "T006", OBJECTNAME: "CUNI", OBJECTTYPE: "T" }),
    bcRow("SCPRRECA", { OBJECTNAME: "CUNI", OBJECTTYPE: "T" }),
    bcRow("SCPRRECA", { TABLENAME: "ZTOTHER", OBJECTNAME: "ZOTHER", OBJECTTYPE: "V" })
  ]
  const queries: string[] = []
  const result = await bc(
    async (sql) => {
      queries.push(sql)
      return sql.includes("FROM SCPRRECA")
        ? sql.includes("TABLENAME =")
          ? [inventory[1]!]
          : inventory
        : bcQuery(sql)
    },
    { ...bcInput, maxRecords: 5, includeRecordInventory: true }
  )
  assert.equal(result.recordInventory?.complete, true)
  assert.deepEqual(result.recordInventory?.tableNames, ["T006", "T006A", "ZTOTHER"])
  assert.deepEqual(result.recordInventory?.unsupportedTableNames, ["ZTOTHER"])
  assert.equal(result.recordInventory?.maintenanceObjects?.length, 2)
  assert.match(result.recordInventory?.fingerprint!, /^[a-f0-9]{64}$/)
  assert.equal(result.activationAvailable, false)
  assert.equal(result.coverage.complete, false)
  assert.ok(queries.every((sql) => !sql.includes("FROM ZTOTHER")))
  assert.equal(
    queries.filter((sql) => sql.includes("FROM SCPRRECA") && !sql.includes("TABLENAME =")).length,
    2
  )
})

test("whole inventory is opt-in and does not alter selected-value fingerprints", async () => {
  const before = await bc(bcQuery)
  assert.equal(before.recordInventory, null)
  const queries: string[] = []
  const after = await bc(
    async (sql) => {
      queries.push(sql)
      return bcQuery(sql)
    },
    { ...bcInput, includeRecordInventory: true }
  )
  assert.equal(after.recordInventory?.complete, true)
  assert.equal(after.readFingerprint, before.readFingerprint)
  assert.equal(queries.filter((sql) => sql.includes("FROM SCPRRECA")).length, 4)
  const defaultQueries: string[] = []
  await bc(async (sql) => {
    defaultQueries.push(sql)
    return bcQuery(sql)
  })
  assert.equal(defaultQueries.filter((sql) => sql.includes("FROM SCPRRECA")).length, 2)
})

test("inventory failure, duplication and truncation never authorize a complete scope", async () => {
  for (const failure of ["denied", "duplicate", "truncated"] as const) {
    const result = await bc(
      async (sql) => {
        if (!sql.includes("FROM SCPRRECA") || sql.includes("TABLENAME =")) return bcQuery(sql)
        if (failure === "denied") throw Error("HTTP 403")
        const row = bcRow("SCPRRECA")
        return failure === "duplicate"
          ? [row, row]
          : [
              row,
              bcRow("SCPRRECA", { TABLENAME: "T006" }),
              bcRow("SCPRRECA", { TABLENAME: "ZTOTHER" })
            ]
      },
      { ...bcInput, includeRecordInventory: true }
    )
    assert.equal(result.recordInventory?.complete, false, failure)
    assert.equal(result.recordInventory?.fingerprint, null, failure)
    assert.equal(result.readFingerprint, null, failure)
    assert.equal(result.activationAvailable, false, failure)
    if (failure !== "truncated") {
      assert.equal(result.status, "unavailable", failure)
      assert.equal(result.recordInventory?.records, null, failure)
    }
  }
})

test("inventory drift and inconsistent selected-record linkage discard the full observation", async () => {
  for (const mismatch of ["drift", "projection"] as const) {
    let inventoryReads = 0
    const result = await bc(
      async (sql) => {
        if (!sql.includes("FROM SCPRRECA") || sql.includes("TABLENAME =")) return bcQuery(sql)
        const row = bcRow("SCPRRECA")
        return mismatch === "projection"
          ? []
          : [row, bcRow("SCPRRECA", { TABLENAME: inventoryReads++ ? "ZCHANGED" : "T006" })]
      },
      { ...bcInput, maxRecords: 5, includeRecordInventory: true }
    )
    assert.equal(result.status, "changed", mismatch)
    assert.equal(result.recordInventory?.records, null, mismatch)
    assert.equal(result.header, null, mismatch)
    assert.equal(result.readFingerprint, null, mismatch)
  }
})
test("BC Set language evidence keeps distinct language keys and invalidates changed reads", async () => {
  let reads = 0
  const languageQuery = async (sql: string) =>
    sql.includes("FROM SCPRVALL")
      ? [
          bcRow("SCPRVALL", { FIELDNAME: "MSEHT", LANGU: "E", FLAG: "FIX", VALUE: "English" }),
          bcRow("SCPRVALL", { FIELDNAME: "MSEHT", LANGU: "1", FLAG: "XXX", VALUE: "中文" })
        ]
      : bcQuery(sql)
  const result = await bc(languageQuery)
  assert.equal(result.languageValues?.length, 2)
  assert.equal(
    result.languageValues?.find((row) => row.LANGU === "E")?.flagMeaning,
    "fixed_protected"
  )
  assert.equal(result.coverage.unknownLanguageFlags, 1)
  assert.equal(result.coverage.languageOverlayApplied, false)
  assert.equal(result.coverage.recordNumberIsBusinessKey, false)
  assert.match(result.readFingerprint!, /^[a-f0-9]{64}$/)
  const changed = await bc(async (sql) =>
    sql.includes("FROM SCPRVALL")
      ? [bcRow("SCPRVALL", { FIELDNAME: "MSEHT", LANGU: "E", VALUE: String(reads++) })]
      : bcQuery(sql)
  )
  assert.equal(changed.status, "changed")
  assert.equal(changed.languageValues, null)
  assert.equal(changed.readFingerprint, null)
  const failed = await bc(async (sql) => {
    if (sql.includes("FROM SCPRVALL")) throw Error("HTTP 403")
    return bcQuery(sql)
  })
  assert.equal(failed.coverage.languageValues, "unavailable_or_not_requested")
  assert.equal(failed.languageValues, null)
  assert.equal(failed.readFingerprint, null)
})

test("BC Set duplicate or truncated language values cannot produce a trusted fingerprint", async () => {
  const row = bcRow("SCPRVALL", { FIELDNAME: "MSEHT", LANGU: "E" })
  const duplicate = await bc(async (sql) =>
    sql.includes("FROM SCPRVALL") ? [row, row] : bcQuery(sql)
  )
  assert.equal(duplicate.languageValues, null)
  assert.equal(duplicate.readFingerprint, null)
  const truncated = await bc(async (sql) =>
    sql.includes("FROM SCPRVALL")
      ? ["E", "1", "D"].map((LANGU) => ({ ...row, LANGU }))
      : bcQuery(sql)
  )
  assert.equal(truncated.coverage.truncated, true)
  assert.equal(truncated.readFingerprint, null)
})

test("switch and unknown BC Set categories do not query classic content", async () => {
  for (const CATEGORY of ["S", "?"]) {
    const result = await bc(async (sql) => {
      if (sql.includes("FROM SCPRATTR")) return [bcRow("SCPRATTR", { CATEGORY })]
      assert.ok(sql.includes("FROM SCPRPPRL"), "unsupported category queried classic payload")
      return []
    })
    assert.equal(result.status, "unsupported_category")
    assert.equal(result.records, null)
    assert.equal(result.values, null)
    assert.equal(result.languageValues, null)
    assert.equal(result.readFingerprint, null)
  }
})

test("BC Set failures, changes and unknown flags are explicit", async () => {
  const denied = await bc(async () => {
    throw Error("HTTP 403")
  })
  assert.equal(denied.status, "unavailable")
  assert.equal(denied.values, null)
  assert.equal(denied.readFingerprint, null)
  let reads = 0
  const changed = await bc(async (sql) =>
    sql.includes("FROM SCPRVALS")
      ? [bcRow("SCPRVALS", { FIELDNAME: "MSEHT", FLAG: "XXX", VALUE: String(reads++) })]
      : bcQuery(sql)
  )
  assert.equal(changed.status, "changed")
  assert.equal(changed.header, null)
  assert.equal(changed.values, null)
  const unknown = await bc(async (sql) =>
    sql.includes("FROM SCPRVALS")
      ? [bcRow("SCPRVALS", { FIELDNAME: "MSEHT", FLAG: "XXX" })]
      : bcQuery(sql)
  )
  assert.equal(unknown.coverage.unknownFlags, 1)
  assert.equal(unknown.values?.[0]?.flagMeaning, "unknown")
})
test("BC Set confirmation truncation invalidates fingerprint", async () => {
  let reads = 0
  const result = await bc(async (sql) =>
    sql.includes("FROM SCPRVALS")
      ? [
          bcRow("SCPRVALS", { FIELDNAME: "MSEHT" }),
          bcRow("SCPRVALS", { FIELDNAME: "MSEHL" }),
          ...(reads++ ? [bcRow("SCPRVALS", { FIELDNAME: "MSEH3" })] : [])
        ]
      : bcQuery(sql)
  )
  assert.equal(result.coverage.truncated, true)
  assert.equal(result.readFingerprint, null)
})
test("new domain tools are read-only and available in configuration and readonly profiles", () => {
  for (const name of [
    "read_configuration_number_range",
    "read_configuration_bc_set",
    "find_configuration_bc_sets",
    "inspect_configuration_transport",
    "compare_configuration_unit",
    "read_configuration_fi_rule"
  ] as const) {
    assert.equal(toolContracts[name].annotations.readOnlyHint, true)
    for (const profile of ["config", "readonly"] as const)
      assert.ok(toolNamesForProfile(profile).includes(name))
  }
})

const ctsInput = { connectionId: "w200", requestNumber: "ABCK000001", taskNumber: "ABCK000002" }
const cts = (change: Record<string, string> = {}, fail = false) =>
  inspectConfigurationTransport(
    ctsInput,
    "200",
    "TESTUSER",
    {
      runQuery: async (_id, sql) => {
        if (fail) throw Error("HTTP 403")
        const request = sql.includes(ctsInput.requestNumber)
        const number = request ? ctsInput.requestNumber : ctsInput.taskNumber
        return sql.includes("FROM E070C")
          ? [{ TRKORR: number, CLIENT: "200", TARCLIENT: "", EXTENDED_STATE: "", OVERTAKER: "" }]
          : [
              {
                ...Object.fromEntries(
                  configurationTransportFields.E070.map((field) => [field, ""])
                ),
                TRKORR: number,
                TRFUNCTION: request ? "W" : "Q",
                TRSTATUS: "D",
                KORRDEV: "CUST",
                AS4USER: "TESTUSER",
                STRKORR: request ? "" : ctsInput.requestNumber,
                TARSYSTEM: request ? "TARGET" : "",
                ...change
              }
            ]
      },
      callRemoteFunction: noRfc
    },
    async (objectName) => ({
      connectionId: "w200",
      objectName,
      objectKind: "transparentTable",
      fingerprint:
        configurationTransportLayouts[objectName as keyof typeof configurationTransportLayouts]
    }),
    async (objectName) => ({
      connectionId: "w200",
      objectName,
      objectKind: "domain",
      fingerprint:
        configurationTransportDomains[objectName as keyof typeof configurationTransportDomains]
    }),
    noRfc
  )
test("CTS W/Q metadata matches never constitute write authorization", async () => {
  const result = await cts()
  assert.equal(result.status, "metadata_matches")
  assert.equal(result.writeAdmission, "blocked")
  assert.equal(result.keyRecording.officialEncoding, "not_verified")
  assert.equal((await cts({ TRFUNCTION: "K" })).status, "rejected")
  assert.equal((await cts({ TRSTATUS: "L" })).status, "rejected")
  assert.equal((await cts({ AS4USER: "OTHER" })).status, "rejected")
  assert.equal((await cts({}, true)).status, "unavailable")
})

test("optional CTS unit text reads bounded table entries and keeps exact key recording unknown", async () => {
  const run = async (mode = "observed") => {
    let headerReads = 0,
      entryReads = 0,
      unitReads = 0
    const result = await inspectConfigurationTransport(
      { ...ctsInput, unitText: { unitKey: "KG", language: "ZH" } },
      "200",
      "TESTUSER",
      {
        runQuery: async (_id, sql, limit) => {
          const number = sql.includes(ctsInput.taskNumber)
              ? ctsInput.taskNumber
              : ctsInput.requestNumber,
            request = number === ctsInput.requestNumber
          if (sql.includes("FROM E070C "))
            return [
              { TRKORR: number, CLIENT: "200", TARCLIENT: "", EXTENDED_STATE: "", OVERTAKER: "" }
            ]
          if (sql.includes("FROM E070 ")) {
            headerReads++
            return [
              {
                ...Object.fromEntries(configurationTransportFields.E070.map((f) => [f, ""])),
                TRKORR: number,
                TRFUNCTION: request ? "W" : "Q",
                TRSTATUS: "D",
                KORRDEV: "CUST",
                AS4USER: "TESTUSER",
                STRKORR: request
                  ? ""
                  : mode === "wrong_parent"
                    ? "ABCK000003"
                    : ctsInput.requestNumber,
                TARSYSTEM: request ? "TARGET" : "",
                ...(mode === "header_drift" && headerReads > 2 ? { TRSTATUS: "L" } : {})
              }
            ]
          }
          entryReads++
          assert.equal(limit, 33)
          assert.ok(!sql.includes("TABKEY ="))
          if (mode === "denied") throw Error("HTTP 403")
          const table = sql.includes("FROM E071K ") ? "E071K" : "E071"
          assert.ok(sql.includes(table === "E071K" ? "OBJNAME = 'T006A'" : "OBJ_NAME = 'CUNI'"))
          if (mode === "empty" || (mode === "missing_master" && table === "E071")) return []
          const row = {
            ...Object.fromEntries(configurationUnitTextTransportFields[table].map((f) => [f, ""])),
            TRKORR: number,
            AS4POS: "000001",
            PGMID: "R3TR",
            OBJECT: table === "E071" ? "TDAT" : "TABU",
            OBJ_NAME: "CUNI",
            OBJNAME: "T006A",
            MASTERTYPE: "TDAT",
            MASTERNAME: mode === "wrong_master" ? "OTHER" : "CUNI",
            TABKEY: mode === "wildcard" ? "200*" : "2001KG"
          }
          if (mode === "key_drift" && entryReads > 4) row.TABKEY = "2001LB"
          if (mode === "truncated")
            return Array.from({ length: 33 }, (_v, i) => ({
              ...row,
              AS4POS: String(i + 1).padStart(6, "0")
            }))
          if (mode === "duplicate") return [row, row]
          return [row]
        },
        callRemoteFunction: noRfc
      },
      async (objectName) => ({
        connectionId: "w200",
        objectName,
        objectKind: "transparentTable",
        fingerprint: (
          { ...configurationTransportLayouts, ...configurationUnitTextTransportLayouts } as Record<
            string,
            string
          >
        )[objectName]
      }),
      async (objectName) => ({
        connectionId: "w200",
        objectName,
        objectKind: "domain",
        fingerprint:
          configurationTransportDomains[objectName as keyof typeof configurationTransportDomains]
      }),
      noRfc,
      async (input) => {
        unitReads++
        assert.equal(input.unitKey, "KG")
        return {
          connectionId: "w200",
          client: "200",
          unitKey: "KG",
          readOnly: true,
          saveAvailable: false,
          readFingerprint:
            mode === "unit_drift" && unitReads === 2 ? "b".repeat(64) : "a".repeat(64),
          unit: { status: "read", data: { MANDT: "200", MSEHI: "KG" } },
          text: {
            status: "read",
            requestedLanguage: "ZH",
            sapLanguage: "1",
            data: { MANDT: "200", MSEHI: "KG", SPRAS: "1" }
          },
          evidence: { valuesRechecked: true, snapshot: false }
        }
      }
    )
    return { result, entryReads, unitReads }
  }
  for (const [mode, status] of [
    ["observed", "table_entries_observed"],
    ["wildcard", "table_entries_observed"],
    ["empty", "no_table_entries"],
    ["wrong_master", "master_mismatch"],
    ["missing_master", "master_unresolved"],
    ["denied", "unavailable"],
    ["duplicate", "unavailable"],
    ["truncated", "truncated"],
    ["key_drift", "changed"],
    ["unit_drift", "changed"],
    ["header_drift", "changed"],
    ["wrong_parent", "blocked"]
  ]) {
    const { result, entryReads, unitReads } = await run(mode),
      keys = result.keyRecording
    assert.ok("observed" in keys)
    assert.equal(keys.status, status)
    assert.equal(keys.exactRowRecording, "not_verified")
    assert.equal(keys.officialEncoding, "not_verified")
    assert.equal(keys.importStatus, "not_checked")
    assert.equal(result.writeAdmission, "blocked")
    assert.equal(keys.readerLimits.entryReaderInvocations, entryReads)
    assert.ok(entryReads <= 8 && unitReads <= 2)
    if (["changed", "truncated", "unavailable", "blocked"].includes(status!)) {
      assert.equal(keys.observed, null)
      assert.equal(keys.readFingerprint, null)
    }
  }
  const legacy = await cts()
  assert.equal("observed" in legacy.keyRecording, false)
})

test("CTS unit key input rejects arbitrary key claims and missing language before SAP", async () => {
  for (const unitText of [
    { unitKey: "KG" },
    { unitKey: "KG", language: "ZH", tabkey: "2001KG" },
    { unitKey: "KG", language: "ZH", ctsVerified: true },
    { unitKey: "LONG", language: "ZH" }
  ])
    await assert.rejects(
      inspectConfigurationTransport(
        { ...ctsInput, unitText },
        "200",
        "TESTUSER",
        { runQuery: noRfc, callRemoteFunction: noRfc },
        noRfc,
        noRfc,
        noRfc
      )
    )
})

const unitProjection = (connectionId: string, unitKey: string, language: string, value = "same") =>
  readConfigurationUnitProjection(
    { connectionId, unitKey, language },
    connectionId === "w200" ? "200" : "300",
    language,
    {
      runQuery: async (_id, sql) => {
        const fields = /^SELECT (.+) FROM (\w+)/.exec(sql)![1]!
        const result: Record<string, string> = {
          ...Object.fromEntries(fields.split(", ").map((field) => [field, ""])),
          MANDT: connectionId === "w200" ? "200" : "300",
          MSEHI: unitKey,
          SPRAS: "E",
          LAISO: language,
          MSEHT: value
        }
        return [Object.fromEntries(fields!.split(", ").map((field) => [field, result[field]!]))]
      },
      callRemoteFunction: noRfc
    },
    async (objectName) => ({
      connectionId,
      objectName,
      objectKind: "transparentTable",
      fingerprint:
        configurationUnitComparisonLayouts[connectionId as "w200" | "w300"][
          objectName as keyof typeof configurationUnitLayouts
        ]
    }),
    async () => ({
      connectionId,
      objectName: "MSEHI",
      objectKind: "dataElement",
      fingerprint: "f0577fd354c1f756fcd69c082c6b7ccafe3970fc736acc3105caf2d2e557e2d2",
      definition: { domainName: "MEINS" }
    }),
    async () => ({
      connectionId,
      objectName: "MEINS",
      objectKind: "domain",
      fingerprint: "61bf4adf8f8321410beaee2104e8e99102efe3d9ccebade64e49f8d5a1056373",
      definition: { dataType: "UNIT", length: 3, lowercase: true, conversionExit: "CUNIT" }
    }),
    noRfc
  )
const compareInput = { from: "w200", to: "w300", unitKey: "kg", language: "EN" }
test("unit comparison aligns semantic keys and explicit client/language rules", async () => {
  const result = await compareConfigurationUnit(compareInput, unitProjection)
  assert.equal(result.status, "partial")
  assert.deepEqual(
    result.rows.map((row) => row.status),
    ["equal_projection", "equal_projection"]
  )
  assert.equal(result.evidence.complete, false)
  const different = await compareConfigurationUnit(compareInput, (id, key, lang) =>
    unitProjection(id, key, lang, id)
  )
  assert.deepEqual(different.rows[1]?.differences, [{ field: "MSEHT", from: "w200", to: "w300" }])
  const ignored = await compareConfigurationUnit(
    { ...compareInput, ignoreFields: ["T006A.MSEHT"] },
    (id, key, lang) => unitProjection(id, key, lang, id)
  )
  assert.equal(ignored.rows[1]?.status, "equal_projection")
  await assert.rejects(
    compareConfigurationUnit({ ...compareInput, ignoreFields: ["T006.MSEHI"] }, unitProjection)
  )
})
test("failed comparison side cannot report equality or deletion", async () => {
  const result = await compareConfigurationUnit(compareInput, async (id, key, lang) => {
    if (id === "w300") throw Error("HTTP 401")
    return unitProjection(id, key, lang)
  })
  assert.equal(result.status, "incomparable")
  assert.deepEqual(
    result.rows.map((row) => row.status),
    ["incomparable", "incomparable"]
  )
})

const fiInput = {
  connectionId: "w200",
  kind: "fi_validation",
  ruleName: "ZRULE",
  companyCode: "1000",
  applicationArea: "FI",
  callupPoint: "0001",
  maxSteps: 2
}
const fiRow = (
  table: keyof typeof configurationFiRuleFields,
  extra: Record<string, string> = {}
) => ({
  ...Object.fromEntries(configurationFiRuleFields[table].map((field) => [field, ""])),
  MANDT: "200",
  VALID: "ZRULE",
  BUKRS: "1000",
  EVENT: "0001",
  VALUSER: "FI",
  VALEVENT: "0001",
  BOOLCLASS: "TEST",
  RCLASS: "TEST",
  VALSEQNR: "001",
  ACTIV: "2",
  ...extra
})
const fi = (
  query: (table: keyof typeof configurationFiRuleFields) => Promise<Record<string, string>[]>
) =>
  readConfigurationFiRule(
    fiInput,
    "200",
    {
      runQuery: async (_id, sql) => {
        const match = /^SELECT (.+) FROM (\w+)/.exec(sql)!
        const rows = await query(match[2] as keyof typeof configurationFiRuleFields)
        return rows.map((row) =>
          Object.fromEntries(match[1]!.split(", ").map((field) => [field, row[field]!]))
        )
      },
      callRemoteFunction: noRfc
    },
    async (objectName) => ({
      connectionId: "w200",
      objectName,
      objectKind: "transparentTable",
      fingerprint: configurationFiRuleLayouts[objectName as keyof typeof configurationFiRuleLayouts]
    }),
    async () => ({
      connectionId: "w200",
      objectName: "GVSACTIV",
      objectKind: "domain",
      fingerprint: configurationFiActivationDomain
    }),
    noRfc
  )
test("FI configuration audit separates rule existence, organization assignment and activation level", async () => {
  const result = await fi(async (table) => [
    fiRow(table, table === "T001D" ? { VALID: "OTHER" } : {})
  ])
  assert.equal(result.rule.status, "read")
  assert.equal(result.activation.assignedToRequestedRule, false)
  assert.equal(result.activation.levelMeaning, "active_except_batch_input")
  assert.equal(result.application.classMatches, true)
  assert.equal(result.coverage.businessTrigger, "not_performed")
  assert.equal(result.saveAvailable, false)
  const missing = await fi(async (table) => (table === "GB93" ? [] : [fiRow(table)]))
  assert.equal(missing.rule.status, "not_found")
  assert.equal(missing.activation.levelMeaning, "active_except_batch_input")
})
test("FI configuration audit cannot equate failures or truncated steps with a complete rule", async () => {
  const denied = await fi(async () => {
    throw Error("HTTP 403")
  })
  assert.equal(denied.status, "unavailable")
  assert.equal(denied.rule.data, null)
  assert.equal(denied.readFingerprint, null)
  const truncated = await fi(async (table) =>
    table === "GB931"
      ? [fiRow(table), fiRow(table, { VALSEQNR: "002" }), fiRow(table, { VALSEQNR: "003" })]
      : [fiRow(table)]
  )
  assert.equal(truncated.steps.truncated, true)
  assert.equal(truncated.readFingerprint, null)
})
