import assert from "node:assert/strict"
import test from "node:test"
import {
  readConfigurationNumberRange,
  numberRangeIntervalLayout
} from "../src/configuration-number-range.js"
import {
  previewConfigurationNumberRange,
  numberRangePreviewDomains,
  numberRangePreviewFunction
} from "../src/configuration-number-range-preview.js"
import { toolContracts } from "../src/contracts.js"
import { toolNamesForProfile } from "../src/tool-registry.js"

const input = { connectionId: "w200", objectName: "ZTEST", subobject: "", year: "0000" }
const change = (overrides = {}) => ({
  action: "update",
  intervalNumber: "01",
  fromNumber: "0001",
  toNumber: "9999",
  external: false,
  ...overrides
})
const row = (overrides = {}) => ({
  CLIENT: "200",
  OBJECT: "ZTEST",
  SUBOBJECT: "",
  TOYEAR: "0000",
  NRRANGENR: "01",
  FROMNUMBER: "0001",
  TONUMBER: "9999",
  NRLEVEL: "00000000000000000001",
  EXTERNIND: "",
  ...overrides
})
const properties = {
  OBJECT: "ZTEST",
  DOMLEN: "CHAR4",
  YEARIND: "",
  DTELSOBJ: "",
  BUFFER: "",
  NOIVBUFFER: "00000000",
  NRTAB: "",
  NRINTFLD: "",
  NREXTFLD: "",
  NRFLD: "",
  NRSOBJFLD: "",
  NRELEFLD: "",
  RFCDEST: "",
  NRCHECKASCII: ""
}
const noMutation = async () => assert.fail("No allocation or maintenance RFC execution")
const domain = async (name: string) => {
  const reviewed = numberRangePreviewDomains[name as keyof typeof numberRangePreviewDomains]
  return {
    connectionId: "w200",
    objectKind: "domain",
    objectName: name,
    fingerprint: reviewed.fingerprint,
    definition: {
      dataType: reviewed.dataType,
      length: reviewed.length,
      decimals: 0,
      conversionExit: ""
    }
  }
}
const fn = async () => numberRangePreviewFunction
function fixture(rows = async () => [row()], patch = {}, readObject?: () => Promise<unknown>) {
  let calls = 0
  const read = (value: Parameters<typeof readConfigurationNumberRange>[0], allYears = false) =>
    readConfigurationNumberRange(
      value,
      "200",
      {
        runQuery: async () => {
          calls++
          return rows()
        },
        callRemoteFunction: noMutation
      },
      readObject ??
        (async () => ({
          connectionId: "w200",
          objectKind: "numberRangeObject",
          objectName: "ZTEST",
          version: "a".repeat(40),
          fingerprint: "a".repeat(64),
          definition: { properties: { ...properties, ...patch } }
        })),
      async () => ({
        connectionId: "w200",
        objectName: "NRIV",
        objectKind: "transparentTable",
        fingerprint: numberRangeIntervalLayout
      }),
      noMutation,
      allYears
    )
  return { read, calls: () => calls }
}
const preview = (f = fixture(), changes = [change()], raw: unknown = { ...input, changes }) =>
  previewConfigurationNumberRange(raw, "200", f.read, domain, fn)
const codes = (r: Awaited<ReturnType<typeof preview>>) => r.findings?.map((f) => f.code)

test("numeric preflight composes all interval confirmations, preserves level and stays partial", async () => {
  const f = fixture(),
    result = await preview(f)
  assert.equal(f.calls(), 4)
  assert.equal(result.status, "partial")
  assert.deepEqual(result.findings, [])
  assert.equal(result.projectedIntervals?.[0]?.currentLevel, row().NRLEVEL)
  assert.equal(result.coverage.complete, false)
  assert.equal(result.coverage.checksComplete, true)
  assert.equal(result.saveAvailable, false)
  assert.equal(result.usableForWritePrecondition, false)
  assert.match(result.preflightFingerprint!, /^[a-f0-9]{64}$/)
  assert.equal(toolContracts.preview_configuration_number_range.annotations?.readOnlyHint, true)
  assert.ok(toolNamesForProfile("readonly").includes("preview_configuration_number_range"))
})

test("20-digit adjacency and overlap retain precision beyond Number safe integers", async () => {
  const f = fixture(
    async () => [
      row({
        FROMNUMBER: "00009007199254740992",
        TONUMBER: "00009007199254740993",
        NRLEVEL: "00009007199254740992"
      })
    ],
    { DOMLEN: "NUMC20" }
  )
  const result = await preview(f, [
    change({
      action: "create",
      intervalNumber: "02",
      fromNumber: "00009007199254740994",
      toNumber: "00009007199254740995"
    })
  ])
  assert.deepEqual(result.findings, [])
  const overlap = await preview(f, [
    change({
      action: "create",
      intervalNumber: "02",
      fromNumber: "00009007199254740993",
      toNumber: "99999999999999999999"
    })
  ])
  assert.ok(codes(overlap)?.includes("INTERVAL_OVERLAP"))
  assert.equal(overlap.projectedIntervals?.[1]?.toNumber, "99999999999999999999")
})

test("shrink, used lower bound and mode switch cannot silently reset persisted level", async () => {
  const f = fixture(async () => [row({ NRLEVEL: "00000000000000000050" })])
  const shrink = await preview(f, [change({ toNumber: "0049" })])
  assert.equal(shrink.status, "blocked")
  assert.ok(codes(shrink)?.includes("CURRENT_LEVEL_OUTSIDE_PROPOSED_INTERVAL"))
  assert.ok(codes(shrink)?.includes("UPPER_BOUND_SHRINK"))
  const boundary = await preview(f, [change({ toNumber: "0050" })])
  assert.equal(boundary.status, "partial")
  assert.deepEqual(codes(boundary), ["UPPER_BOUND_SHRINK"])
  assert.ok(
    codes(await preview(f, [change({ fromNumber: "0002" })]))?.includes("LOWER_BOUND_IN_USE")
  )
  const mode = await preview(f, [change({ external: true })])
  assert.ok(codes(mode)?.includes("EXTERNAL_REQUIRES_INITIAL_LEVEL"))
  assert.ok(codes(mode)?.includes("INTERNAL_EXTERNAL_SWITCH"))
  assert.equal(mode.projectedIntervals?.[0]?.currentLevel, "00000000000000000050")
})

test("inclusive overlap checks unchanged neighbors and simultaneous proposed changes", async () => {
  const f = fixture(async () => [
    row({ TONUMBER: "0049" }),
    row({ NRRANGENR: "02", FROMNUMBER: "0050", TONUMBER: "0100", NRLEVEL: "00000000000000000000" })
  ])
  assert.ok(codes(await preview(f, [change({ toNumber: "0050" })]))?.includes("INTERVAL_OVERLAP"))
  const simultaneous = await preview(f, [
    change({ toNumber: "0050" }),
    change({ intervalNumber: "02", fromNumber: "0051", toNumber: "0100" })
  ])
  assert.equal(simultaneous.status, "partial")
  assert.deepEqual(simultaneous.findings, [])
})

test("bounds, domain width and create/update identity are checked", async () => {
  const cases = [
    [change({ fromNumber: "0050", toNumber: "0050" }), "LOWER_NOT_LESS_THAN_UPPER"],
    [change({ fromNumber: "0000" }), "INTERNAL_LOWER_MUST_BE_POSITIVE"],
    [change({ fromNumber: "1" }), "DOMAIN_LENGTH_MISMATCH"],
    [change({ action: "create" }), "INTERVAL_ALREADY_EXISTS"],
    [change({ intervalNumber: "02" }), "INTERVAL_NOT_FOUND"]
  ] as const
  for (const [proposal, code] of cases)
    assert.ok(codes(await preview(fixture(), [proposal]))?.includes(code))
  const empty = await preview(
    fixture(async () => []),
    [change({ action: "create" })]
  )
  assert.equal(empty.status, "partial")
  assert.deepEqual(empty.findings, [])
  assert.equal(empty.projectedIntervals?.[0]?.currentLevel, "00000000000000000000")
})

test("unreviewed annual, subobject, buffer, domain and alpha formats have no findings", async () => {
  for (const patch of [
    { YEARIND: "X" },
    { DTELSOBJ: "SUB" },
    { BUFFER: "L" },
    { NRTAB: "GROUPS" },
    { DOMLEN: "__proto__" }
  ]) {
    const r = await preview(fixture(undefined, patch))
    assert.equal(r.status, "unsupported")
    assert.equal(r.findings, null)
    assert.equal(r.preflightFingerprint, null)
  }
  assert.equal(
    (await preview(fixture(async () => [row({ FROMNUMBER: "AAAA" })]))).status,
    "unsupported"
  )
})

test("changing, failed and truncated observations discard proposed results", async () => {
  let n = 0
  const changed = await preview(
    fixture(async () => [row({ NRLEVEL: ++n > 2 ? "00000000000000000002" : row().NRLEVEL })])
  )
  assert.equal(changed.status, "changed")
  assert.equal(changed.findings, null)
  assert.equal(changed.projectedIntervals, null)
  assert.equal(changed.preflightFingerprint, null)
  const fail = await preview(
    fixture(async () => {
      throw Error("403")
    })
  )
  assert.equal(fail.status, "unavailable")
  assert.equal(fail.findings, null)
  const limited = await preview(
    fixture(async () => [row(), row({ NRRANGENR: "02" }), row({ NRRANGENR: "03" })]),
    [change()],
    { ...input, changes: [change()], maxIntervals: 2 }
  )
  assert.equal(limited.status, "unavailable")
  assert.equal(limited.preflightFingerprint, null)
})

test("metadata drift fails closed; absent object never runs interval query", async () => {
  let n = 0
  await assert.rejects(
    previewConfigurationNumberRange(
      { ...input, changes: [change()] },
      "200",
      fixture().read,
      async (name) => ({
        ...(await domain(name)),
        fingerprint: ++n === 1 ? numberRangePreviewDomains.CHAR4.fingerprint : "b".repeat(64)
      }),
      fn
    ),
    /METADATA_UNVERIFIED/
  )
  const f = fixture(undefined, {}, async () => ({
    connectionId: "w200",
    objectName: "ZTEST",
    objectType: "numberRangeObject",
    status: "not-found",
    exists: false,
    authoritative: true,
    readOnly: true
  }))
  const absent = await preview(f)
  assert.equal(absent.status, "not_found")
  assert.equal(f.calls(), 0)
  assert.equal(absent.findings, null)
})

test("strict boundary rejects hidden writes, interval filter and duplicate changes before read", async () => {
  const f = fixture()
  for (const raw of [
    { ...input, connectionId: "w300", changes: [change()] },
    { ...input, changes: [change(), change()] },
    { ...input, intervalNumber: "01", changes: [change()] },
    { ...input, changes: [change({ currentLevel: "0" })] },
    { ...input, changes: [change({ action: "delete" })] },
    { ...input, changes: [change({ fromNumber: "1e3" })] }
  ])
    await assert.rejects(preview(f, [change()], raw))
  assert.equal(f.calls(), 0)
})

const annualInput = { connectionId: "w200", objectName: "ZTEST", subobject: "", yearScope: "all" }
const annual = (
  rows: () => Promise<ReturnType<typeof row>[]>,
  changes = [change({ year: "2026" })]
) => preview(fixture(rows, { YEARIND: "X" }), changes, { ...annualInput, changes })

test("annual composite identities keep same-number years distinct and avoid disjoint-year overlaps", async () => {
  const r = await annual(
    async () => [
      row({
        TOYEAR: "2026",
        FROMNUMBER: "0200",
        TONUMBER: "0300",
        NRLEVEL: "00000000000000000200"
      }),
      row({ TOYEAR: "2023", TONUMBER: "0100" }),
      row({
        NRRANGENR: "02",
        TOYEAR: "2023",
        FROMNUMBER: "0200",
        TONUMBER: "0300",
        NRLEVEL: "00000000000000000000"
      }),
      row({ NRRANGENR: "02", TOYEAR: "2026", TONUMBER: "0100" })
    ],
    [
      change({ year: "2023", toNumber: "0100" }),
      change({ year: "2026", fromNumber: "0200", toNumber: "0300" })
    ]
  )
  assert.equal(r.status, "partial")
  assert.deepEqual(r.findings, [])
  assert.deepEqual(
    r.projectedIntervals?.map((x) => [
      x.intervalNumber,
      x.year,
      x.effectiveFromYear,
      x.effectiveToYear
    ]),
    [
      ["01", "2023", "0000", "2023"],
      ["01", "2026", "2024", "2026"],
      ["02", "2023", "0000", "2023"],
      ["02", "2026", "2024", "2026"]
    ]
  )
  assert.equal(r.projectedIntervals?.[1]?.currentLevel, "00000000000000000200")
  assert.equal(r.year, null)
  assert.equal(r.yearScope, "all")
  assert.equal(r.saveAvailable, false)
})

test("annual overlap considers intersecting effective years even for different cutoffs", async () => {
  const r = await annual(
    async () => [
      row({ TOYEAR: "2023", TONUMBER: "0100" }),
      row({
        TOYEAR: "2026",
        FROMNUMBER: "0200",
        TONUMBER: "0300",
        NRLEVEL: "00000000000000000000"
      }),
      row({ NRRANGENR: "02", TOYEAR: "2025", FROMNUMBER: "0250", TONUMBER: "0400" })
    ],
    [change({ year: "2026", fromNumber: "0200", toNumber: "0300" })]
  )
  assert.equal(r.status, "blocked")
  assert.deepEqual(
    r.findings?.find((f) => f.code === "INTERVAL_OVERLAP"),
    {
      severity: "error",
      code: "INTERVAL_OVERLAP",
      intervalNumber: "01",
      relatedIntervalNumber: "02",
      year: "2026",
      relatedYear: "2025"
    }
  )
})

test("inserting a year recomputes neighbor coverage and blocks changing a used range", async () => {
  for (const level of ["00000000000000000000", "00000000000000000050"]) {
    const r = await annual(
      async () => [row({ TOYEAR: "2026", TONUMBER: "0100", NRLEVEL: level })],
      [change({ action: "create", year: "2023", fromNumber: "0200", toNumber: "0300" })]
    )
    assert.equal(r.status, level.endsWith("50") ? "blocked" : "partial")
    assert.deepEqual(r.findings, [
      {
        severity: level.endsWith("50") ? "error" : "risk",
        code: "YEAR_COVERAGE_CHANGED",
        intervalNumber: "01",
        year: "2026"
      }
    ])
    assert.equal(r.projectedIntervals?.[1]?.effectiveFromYear, "2024")
    assert.equal(r.projectedIntervals?.[1]?.currentLevel, level)
  }
})

test("annual create/update uses year-specific existence and preserves exact-mode behavior", async () => {
  const rows = async () => [
    row({ TOYEAR: "2023", TONUMBER: "0100" }),
    row({ TOYEAR: "2026", TONUMBER: "0100" })
  ]
  assert.equal(
    (
      await annual(rows, [
        change({ year: "2023", toNumber: "0100" }),
        change({ year: "2026", toNumber: "0100" })
      ])
    ).status,
    "partial"
  )
  const r = await annual(rows, [
    change({ action: "create", year: "2023" }),
    change({ year: "2025" })
  ])
  assert.deepEqual(
    r.findings?.map((f) => [f.code, f.year]),
    [
      ["INTERVAL_ALREADY_EXISTS", "2023"],
      ["INTERVAL_NOT_FOUND", "2025"]
    ]
  )
  const legacy = await preview()
  assert.equal(legacy.year, "0000")
  assert.equal(legacy.yearScope, undefined)
  assert.equal(legacy.projectedIntervals?.[0]?.year, undefined)
})

test("ambiguous year scopes and duplicate compound changes are refused before reads", async () => {
  const f = fixture()
  for (const raw of [
    { ...annualInput, year: "2026", changes: [change({ year: "2026" })] },
    { ...annualInput, changes: [change()] },
    { ...annualInput, changes: [change({ year: "1900" })] },
    { ...annualInput, changes: [change({ year: "2026" }), change({ year: "2026" })] },
    { ...input, changes: [change({ year: "2026" })] },
    { ...annualInput, changes: [change({ year: "2026", currentLevel: "0" })] },
    { ...annualInput, changes: [change({ year: "2026", action: "delete" })] }
  ])
    await assert.rejects(preview(f, [], raw))
  assert.equal(f.calls(), 0)
})

test("annual buffered, subobject and nonannual objects produce no verdict", async () => {
  for (const patch of [{ YEARIND: "X", BUFFER: "X" }, { YEARIND: "X", DTELSOBJ: "SUB" }, {}]) {
    const f = fixture(async () => [], patch),
      changes = [change({ year: "2026" })]
    const r = await preview(f, changes, { ...annualInput, changes })
    assert.equal(r.status, "unsupported")
    assert.equal(r.findings, null)
    assert.equal(r.projectedIntervals, null)
    assert.equal(r.preflightFingerprint, null)
  }
  await assert.rejects(
    previewConfigurationNumberRange(
      { ...annualInput, changes: [change({ year: "2026" })] },
      "200",
      async (value) => fixture().read(value),
      domain,
      fn
    ),
    /YEAR_FILTERED/
  )
})

test("changing or truncated annual observations discard findings and effective projections", async () => {
  let n = 0
  const f = fixture(
      async () => [
        row({ TOYEAR: "2026", NRLEVEL: ++n > 2 ? "00000000000000000002" : row().NRLEVEL })
      ],
      { YEARIND: "X" }
    ),
    changes = [change({ year: "2026" })]
  const r = await preview(f, changes, { ...annualInput, changes })
  assert.equal(r.status, "changed")
  assert.equal(r.findings, null)
  assert.equal(r.projectedIntervals, null)
  assert.equal(r.preflightFingerprint, null)
  const limited = await preview(
    fixture(
      async () => [row({ TOYEAR: "2023" }), row({ TOYEAR: "2024" }), row({ TOYEAR: "2026" })],
      { YEARIND: "X" }
    ),
    changes,
    { ...annualInput, changes, maxIntervals: 2 }
  )
  assert.equal(limited.status, "unavailable")
  assert.equal(limited.projectedIntervals, null)
})

test("empty annual objects can project a first year while a used year's shrink stays blocked", async () => {
  const first = await annual(async () => [], [change({ action: "create", year: "1901" })])
  assert.equal(first.status, "partial")
  assert.deepEqual(first.findings, [])
  assert.equal(first.projectedIntervals?.[0]?.effectiveFromYear, "0000")
  const shrink = await annual(
    async () => [row({ TOYEAR: "2026", NRLEVEL: "00000000000000000050" })],
    [change({ year: "2026", toNumber: "0049" })]
  )
  assert.equal(shrink.status, "blocked")
  assert.ok(codes(shrink)?.includes("CURRENT_LEVEL_OUTSIDE_PROPOSED_INTERVAL"))
  assert.ok(codes(shrink)?.includes("UPPER_BOUND_SHRINK"))
  assert.equal(shrink.projectedIntervals?.[0]?.currentLevel, "00000000000000000050")
  const withinLevel = await annual(
    async () => [row({ TOYEAR: "2026", NRLEVEL: "00000000000000000050" })],
    [change({ year: "2026", toNumber: "0050" })]
  )
  assert.equal(withinLevel.status, "blocked")
  assert.deepEqual(withinLevel.findings, [
    { severity: "error", code: "UPPER_BOUND_SHRINK", intervalNumber: "01", year: "2026" }
  ])
})
