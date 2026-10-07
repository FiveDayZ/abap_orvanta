import assert from "node:assert/strict"
import test from "node:test"
import {
  configurationNumberRangeScopeSchema,
  readConfigurationNumberRange,
  numberRangeIntervalLayout
} from "../src/configuration-number-range.js"
import {
  readConfigurationNumberRangeScope,
  numberRangeScopeFunctions,
  numberRangeScopeIncludes,
  resolveNumberRangeSubobjectSource
} from "../src/configuration-number-range-scope.js"
import { toolContracts } from "../src/contracts.js"
import { toolNamesForProfile } from "../src/tool-registry.js"

const input = { connectionId: "w200", objectName: "ZTEST", subobject: "", maxIntervals: 100 }
const row = (overrides = {}) => ({
  CLIENT: "200",
  OBJECT: "ZTEST",
  SUBOBJECT: "",
  NRRANGENR: "01",
  TOYEAR: "2023",
  FROMNUMBER: "0001",
  TONUMBER: "9999",
  NRLEVEL: "00000000000000000001",
  EXTERNIND: "",
  ...overrides
})
const noExecution = async () => assert.fail("No list/init/update/allocation function execution")
const source = async (name: string) => ({
  functionName: name,
  remoteEnabled: false,
  updateTask: false,
  ...numberRangeScopeFunctions[name as keyof typeof numberRangeScopeFunctions]
})
const include = async (name: string) =>
  "Source from " +
  name +
  " (lines 1-2 of 2, 2 lines retrieved):\n\nFull Source SHA-256: " +
  numberRangeScopeIncludes[name as keyof typeof numberRangeScopeIncludes] +
  "\nURI: /sap/bc/adt/functions/groups/snr1/includes/" +
  name.toLowerCase() +
  "/source"
const table = async (name: string) => ({
  connectionId: "w200",
  objectKind: "transparentTable",
  objectName: name,
  fingerprint: "f".repeat(64),
  definition: {
    tableClass: "TRANSP",
    fields: [{ name: "CODE", position: 1, key: true, dataElement: "ZSOBJ_E" }]
  }
})
const element = async (name: string) => ({
  connectionId: "w200",
  objectKind: "dataElement",
  objectName: name,
  fingerprint: "c".repeat(64),
  definition: { domainName: "ZSOBJ" }
})
const domain = async (name: string) => ({
  connectionId: "w200",
  objectKind: "domain",
  objectName: name,
  fingerprint: "d".repeat(64),
  definition: { dataType: "CHAR", length: 4, conversionExit: "", valueTable: "ZMASTER" }
})
function fixture(rows = async () => [row()], properties = {}, absent = false) {
  const queries: string[] = []
  const read = (value: unknown) =>
    readConfigurationNumberRange(
      { ...configurationNumberRangeScopeSchema.parse(value), year: "0000" },
      "200",
      {
        runQuery: async (_connection, query) => {
          queries.push(query)
          return rows()
        },
        callRemoteFunction: noExecution
      },
      async () =>
        absent
          ? {
              connectionId: "w200",
              objectName: "ZTEST",
              objectType: "numberRangeObject",
              status: "not-found",
              exists: false,
              authoritative: true,
              readOnly: true
            }
          : {
              connectionId: "w200",
              objectName: "ZTEST",
              objectKind: "numberRangeObject",
              version: "a".repeat(40),
              fingerprint: "a".repeat(64),
              definition: {
                properties: { OBJECT: "ZTEST", YEARIND: "X", DTELSOBJ: "", ...properties }
              }
            },
      async () => ({
        connectionId: "w200",
        objectName: "NRIV",
        objectKind: "transparentTable",
        fingerprint: numberRangeIntervalLayout
      }),
      noExecution,
      true
    )
  return { read, queries }
}
const scope = (f = fixture(), raw: unknown = input) =>
  readConfigurationNumberRangeScope(raw, "200", f.read, element, domain, source, include, table)

test("all-year reader keys interval plus year and derives the standard effective ranges", async () => {
  const f = fixture(async () => [
    row({ TOYEAR: "2026" }),
    row({ TOYEAR: "2023" }),
    row({ NRRANGENR: "02", TOYEAR: "2025" })
  ])
  const r = await scope(f)
  assert.equal(f.queries.length, 4)
  assert.ok(
    f.queries.every(
      (q) => q.includes("SUBOBJECT = ''") && !q.includes("TOYEAR =") && !q.includes("NRRANGENR =")
    )
  )
  assert.deepEqual(
    r.effectiveIntervals?.map((v) => [v.NRRANGENR, v.effectiveFromYear, v.effectiveToYear]),
    [
      ["01", "0000", "2023"],
      ["01", "2024", "2026"],
      ["02", "0000", "2025"]
    ]
  )
  assert.equal(r.effectiveIntervals?.[0]?.NRLEVEL, row().NRLEVEL)
  assert.equal(r.status, "read")
  assert.equal(r.yearScope, "all")
  assert.equal(r.coverage.intervalProjectionComplete, true)
  assert.equal(r.coverage.complete, false)
  assert.equal(r.saveAvailable, false)
  assert.equal(r.usableForWritePrecondition, false)
  assert.match(r.readFingerprint!, /^[a-f0-9]{64}$/)
})

test("literal subobject reads preserve metadata but never infer source-table existence", async () => {
  const f = fixture(async () => [row({ SUBOBJECT: "AB01" })], { DTELSOBJ: "ZSOBJ_E" })
  const r = await scope(f, { ...input, subobject: "AB01" })
  assert.ok(f.queries.every((q) => q.includes("SUBOBJECT = 'AB01'")))
  assert.equal(r.subobject.requiredByDefinition, true)
  assert.equal(r.subobject.metadata?.element.objectName, "ZSOBJ_E")
  assert.equal(r.subobject.metadata?.domain.definition.valueTable, "ZMASTER")
  assert.equal(r.subobject.formatStatus, "literal_length_only")
  assert.equal(r.subobject.metadata?.source.status, "resolved_metadata")
  assert.equal(r.subobject.existenceStatus, "unverified")
  const empty = await scope(
    fixture(async () => [], { DTELSOBJ: "ZSOBJ_E" }),
    { ...input, subobject: "MISS" }
  )
  assert.equal(empty.status, "empty")
  assert.equal(empty.subobject.existenceStatus, "unverified")
  assert.deepEqual(empty.intervals, [])
})

test("empty intervals and missing definitions stay distinct; nonannual all-years is compatible", async () => {
  assert.equal((await scope(fixture(async () => []))).status, "empty")
  const absent = fixture(undefined, {}, true),
    r = await scope(absent)
  assert.equal(r.status, "not_found")
  assert.equal(r.intervals, null)
  assert.equal(absent.queries.length, 0)
  const nonannual = await scope(fixture(async () => [row({ TOYEAR: "0000" })], { YEARIND: "" }))
  assert.equal(nonannual.annual, false)
  assert.deepEqual(
    nonannual.effectiveIntervals?.map((v) => [v.effectiveFromYear, v.effectiveToYear]),
    [["0000", "0000"]]
  )
})

test("duplicate compound keys and invalid annual/nonannual years fail closed", async () => {
  for (const f of [
    fixture(async () => [row(), row()]),
    fixture(async () => [row({ TOYEAR: "0000" })]),
    fixture(async () => [row({ TOYEAR: "1900" })]),
    fixture(undefined, { YEARIND: "" })
  ]) {
    const r = await scope(f)
    assert.equal(r.status, "unavailable")
    assert.equal(r.intervals, null)
    assert.equal(r.readFingerprint, null)
  }
})

test("truncated and changing all-year observations discard every effective range", async () => {
  const truncated = await scope(
    fixture(async () => [
      row({ TOYEAR: "2022" }),
      row({ TOYEAR: "2023" }),
      row({ TOYEAR: "2024" })
    ]),
    { ...input, maxIntervals: 2 }
  )
  assert.equal(truncated.coverage.truncated, true)
  assert.equal(truncated.effectiveIntervals, null)
  let n = 0
  const changed = await scope(
    fixture(async () => [row({ NRLEVEL: ++n > 2 ? "00000000000000000002" : row().NRLEVEL })])
  )
  assert.equal(changed.status, "changed")
  assert.equal(changed.intervals, null)
  assert.equal(changed.effectiveIntervals, null)
  assert.equal(changed.readFingerprint, null)
  const denied = await scope(
    fixture(async () => {
      throw Error("HTTP 403")
    })
  )
  assert.equal(denied.status, "unavailable")
  assert.equal(denied.intervals, null)
})

test("subobject metadata drift discards projections; unsupported conversion remains unreviewed", async () => {
  const f = fixture(async () => [row({ SUBOBJECT: "AB01" })], { DTELSOBJ: "ZSOBJ_E" })
  let n = 0
  const changed = await readConfigurationNumberRangeScope(
    { ...input, subobject: "AB01" },
    "200",
    f.read,
    element,
    async (name) => ({
      ...(await domain(name)),
      fingerprint: ++n === 1 ? "d".repeat(64) : "e".repeat(64)
    }),
    source,
    include,
    table
  )
  assert.equal(changed.status, "changed")
  assert.equal(changed.subobject.metadata, null)
  assert.equal(changed.effectiveIntervals, null)
  const conversion = await readConfigurationNumberRangeScope(
    { ...input, subobject: "AB01" },
    "200",
    f.read,
    element,
    async (name) => ({
      ...(await domain(name)),
      definition: { ...(await domain(name)).definition, conversionExit: "ALPHA" }
    }),
    source,
    include,
    table
  )
  assert.equal(conversion.subobject.formatStatus, "unreviewed")
  assert.equal(conversion.subobject.existenceStatus, "unverified")
})

test("source and DDIC mismatch fail closed, and a filtered-year callback is refused", async () => {
  const f = fixture()
  await assert.rejects(
    readConfigurationNumberRangeScope(
      input,
      "200",
      f.read,
      element,
      domain,
      async (name) => ({
        ...(await source(name)),
        sourceFingerprint: "b".repeat(64)
      }),
      include,
      table
    ),
    /SOURCE_UNVERIFIED/
  )
  assert.equal(f.queries.length, 0)
  await assert.rejects(
    readConfigurationNumberRangeScope(
      input,
      "200",
      async (value) => ({ ...(await f.read(value)), year: "2023" }),
      element,
      domain,
      source,
      include,
      table
    ),
    /YEAR_FILTERED/
  )
  await assert.rejects(
    readConfigurationNumberRangeScope(
      { ...input, subobject: "AB01" },
      "200",
      fixture(async () => [], { DTELSOBJ: "ZSOBJ_E" }).read,
      async (name) => ({ ...(await element(name)), objectName: "OTHER" }),
      domain,
      source,
      include,
      table
    ),
    /METADATA_UNVERIFIED/
  )
})

test("new scope is readonly and refuses year, interval and wildcard-like scope expansion", async () => {
  assert.equal(toolContracts.read_configuration_number_range_scope.annotations?.readOnlyHint, true)
  assert.ok(toolNamesForProfile("readonly").includes("read_configuration_number_range_scope"))
  const f = fixture()
  for (const raw of [
    { ...input, year: "2023" },
    { ...input, intervalNumber: "01" },
    { ...input, allSubobjects: true },
    { ...input, connectionId: "w300" }
  ])
    await assert.rejects(scope(f, raw))
  assert.equal(f.queries.length, 0)
})

test("source resolution uses first matching key by position and recognizes client domains", async () => {
  const r = await resolveNumberRangeSubobjectSource(
    "ZSOBJ",
    "ZMASTER",
    async (name) => ({
      ...(await table(name)),
      definition: {
        tableClass: "TRANSP",
        fields: [
          { name: "SECOND", position: 3, key: true, dataElement: "ZSOBJ_E" },
          { name: "TENANT", position: 1, key: true, dataElement: "MANDT" },
          { name: "FIRST", position: 2, key: true, dataElement: "ZSOBJ_E" }
        ]
      }
    }),
    async (name) => ({
      ...(await element(name)),
      definition: { domainName: name === "MANDT" ? "MANDT" : "ZSOBJ" }
    }),
    async (name) => ({
      ...(await domain(name)),
      definition: {
        ...(await domain(name)).definition,
        dataType: name === "MANDT" ? "CLNT" : "CHAR"
      }
    })
  )
  assert.equal(r.status, "resolved_metadata")
  assert.equal(r.fieldName, "FIRST")
  assert.deepEqual(r.matchingKeyFields, ["FIRST", "SECOND"])
  assert.deepEqual(r.clientFields, ["TENANT"])
  assert.equal(r.rowUniqueness, "unverified")
  assert.equal(r.existenceStatus, "unverified")
})

test("no value table, nonmatching keys and unsupported layouts never imply existence", async () => {
  assert.equal(
    (await resolveNumberRangeSubobjectSource("ZSOBJ", "", noExecution, noExecution, noExecution))
      .status,
    "no_value_table"
  )
  assert.equal(
    (await resolveNumberRangeSubobjectSource("OTHER", "ZMASTER", table, element, domain)).status,
    "no_matching_key"
  )
  for (const fields of [
    [{ name: "CODE", position: 1, key: true, dataElement: "" }],
    [{ name: "CODE", position: 1, key: true, dataElement: "ZSOBJ_E", componentKind: "include" }],
    [
      { name: "CODE", position: 1, key: true, dataElement: "ZSOBJ_E" },
      { name: "OTHER", position: 1, key: true, dataElement: "ZSOBJ_E" }
    ]
  ])
    assert.equal(
      (
        await resolveNumberRangeSubobjectSource(
          "ZSOBJ",
          "ZMASTER",
          async (name) => ({
            ...(await table(name)),
            definition: { tableClass: "TRANSP", fields }
          }),
          noExecution,
          noExecution
        )
      ).status,
      "unreviewed_layout"
    )
  await assert.rejects(
    resolveNumberRangeSubobjectSource(
      "ZSOBJ",
      "ZMASTER",
      async (name) => ({ ...(await table(name)), objectName: "OTHER" }),
      element,
      domain
    ),
    /SOURCE_UNVERIFIED/
  )
  await assert.rejects(
    resolveNumberRangeSubobjectSource("ZSOBJ", "X;SELECT", noExecution, noExecution, noExecution),
    /SOURCE_UNVERIFIED/
  )
})

test("source-table drift discards projections and incomplete source reads fail before NRIV", async () => {
  const f = fixture(async () => [row({ SUBOBJECT: "AB01" })], { DTELSOBJ: "ZSOBJ_E" })
  let n = 0
  const r = await readConfigurationNumberRangeScope(
    { ...input, subobject: "AB01" },
    "200",
    f.read,
    element,
    domain,
    source,
    include,
    async (name) => ({
      ...(await table(name)),
      fingerprint: ++n === 1 ? "f".repeat(64) : "e".repeat(64)
    })
  )
  assert.equal(r.status, "changed")
  assert.equal(r.subobject.metadata, null)
  assert.equal(r.readFingerprint, null)
  assert.equal(r.intervals, null)
  assert.equal(r.maintenanceBoundary.status, "blocked")
  const untouched = fixture()
  await assert.rejects(
    readConfigurationNumberRangeScope(
      input,
      "200",
      untouched.read,
      element,
      domain,
      source,
      async (name) => (await include(name)).replace("of 2", "of 3"),
      table
    ),
    /SOURCE_UNVERIFIED/
  )
  assert.equal(untouched.queries.length, 0)
})

test("namespaced domain metadata retains the old interval scope without querying unreviewed tables", async () => {
  const r = await readConfigurationNumberRangeScope(
    { ...input, subobject: "AB01" },
    "200",
    fixture(async () => [row({ SUBOBJECT: "AB01" })], { DTELSOBJ: "ZSOBJ_E" }).read,
    async (name) => ({ ...(await element(name)), definition: { domainName: "/Z/SOBJ" } }),
    async (name) => ({
      ...(await domain(name)),
      definition: { ...(await domain(name)).definition, valueTable: "/Z/MASTER" }
    }),
    source,
    include,
    noExecution
  )
  assert.equal(r.status, "read")
  assert.equal(r.subobject.metadata?.domain.objectName, "/Z/SOBJ")
  assert.equal(r.subobject.metadata?.source.status, "unreviewed_value_table")
  assert.equal(r.subobject.existenceStatus, "unverified")
  assert.equal(r.saveAvailable, false)
})
