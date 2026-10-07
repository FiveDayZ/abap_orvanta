import assert from "node:assert/strict"
import test from "node:test"
import { preflightFixture } from "./configuration-bc-preflight-fixture.js"
import { configurationBcPreflightKeys } from "../src/configuration-bc-preflight.js"

test("local replay binds nineteen fixed keys and preserves eight related rows including absence", async () => {
  const f = preflightFixture(),
    result = await f.invoke()
  assert.equal(result.rows.length, 19)
  assert.equal(new Set(result.rows.map((r) => r.tableName)).size, 9)
  assert.deepEqual(
    result.rows.map((r) => ({ tableName: r.tableName, key: r.key })),
    configurationBcPreflightKeys
  )
  assert.equal(result.rows.filter((r) => r.action === "create").length, 10)
  assert.equal(result.rows.filter((r) => r.action === "unchanged").length, 1)
  const guard = result.rows.filter((r) => r.role === "preserve")
  assert.equal(guard.length, 8)
  assert.equal(guard.filter((r) => r.presence === "present").length, 7)
  assert.deepEqual(
    guard.find((r) => r.tableName === "T006_OIB"),
    {
      tableName: "T006_OIB",
      key: { MANDT: "200", MSEHI: "KNM" },
      role: "preserve",
      presence: "missing",
      action: "preserve",
      before: null,
      after: null,
      differences: []
    }
  )
  for (const row of guard) assert.deepEqual(row.before, row.after)
  for (const name of [
    "executable",
    "activationAvailable",
    "simulation",
    "methodExecutionAvailable",
    "snapshot"
  ] as const)
    assert.equal(result[name], false)
  assert.equal(result.scope.allCuniKeys, false)
  assert.equal(result.apiIdentities.length, 4)
  assert.deepEqual(f.counts, { snapshot: 2, preview: 1, route: 2, guard: 2, definition: 8 })
  await f.invoke()
  assert.equal(f.counts.definition, 16, "new request must reattest, no cache")
})

for (const invalid of [
  { connectionId: "w300" },
  { bcSetId: "OTHER" },
  { version: "C" },
  { client: "300" },
  { nativeGuardVersion: "short" },
  { nativeCandidateVersion: "A".repeat(64) },
  { activate: true },
  { simulate: true },
  { unitKey: "KG" },
  { transportRequest: "GR2K923429" }
])
  test(`schema refuses scope/command input before reads: ${Object.keys(invalid)[0]}`, async () => {
    const f = preflightFixture()
    await assert.rejects(f.invoke({ ...f.input, ...invalid }))
    assert.ok(Object.values(f.counts).every((n) => n === 0))
  })

for (const name of [
  "nativeTargetVersion",
  "nativeCandidateVersion",
  "nativeMetadataVersion",
  "nativeGuardVersion"
] as const)
  test(`stale ${name} retracts the full preflight`, async () => {
    const f = preflightFixture()
    await assert.rejects(
      f.invoke({ ...f.input, [name]: "0".repeat(64) }),
      /BINDING_INVALID|VERSION_CONFLICT/
    )
  })

const mutations: [string, (f: ReturnType<typeof preflightFixture>) => void][] = [
  [
    "unbound related metadata version",
    (f) => {
      f.data.guard.native.EV_METADATA_VERSION = "0".repeat(64)
    }
  ],
  [
    "missing complete field",
    (f) => {
      delete f.data.guard.native.ET_T006J[0].ISOTXT
    }
  ],
  [
    "duplicate related key",
    (f) => {
      f.data.guard.native.ET_T006J[1] = f.data.guard.native.ET_T006J[0]
    }
  ],
  [
    "foreign ISO key",
    (f) => {
      f.data.guard.native.ET_T006I[0].ISOCODE = "OTHER"
    }
  ],
  [
    "method registration",
    (f) => {
      f.data.route.methods.push({ METHODNAME: "OTHER" })
    }
  ],
  [
    "member table drift",
    (f) => {
      f.data.route.native.ET_OBJS[0].TABNAME = "OTHER"
    }
  ],
  [
    "wrong system",
    (f) => {
      f.data.preview.native.EV_SYSTEM = "GR3"
    }
  ],
  [
    "wrong authenticated user",
    (f) => {
      f.data.guard.native.EV_USER = "OTHER"
    }
  ],
  [
    "wrong body identity",
    (f) => {
      f.data.preview.bodyFingerprint = "0".repeat(64)
    }
  ],
  [
    "incomplete candidate key",
    (f) => {
      f.data.preview.native.ET_T006A.pop()
    }
  ],
  [
    "out of scope candidate",
    (f) => {
      f.data.preview.native.ET_T006[0].MSEHI = "KG"
    }
  ],
  [
    "candidate alias points elsewhere",
    (f) => {
      f.data.preview.native.ET_T006B[0].MSEHI = "KG"
    }
  ],
  [
    "duplicate candidate",
    (f) => {
      f.data.preview.native.ET_T006A[1] = f.data.preview.native.ET_T006A[0]
    }
  ],
  [
    "unbound native candidate version",
    (f) => {
      f.data.preview.native.EV_CANDIDATE_VERSION = "0".repeat(64)
    }
  ],
  [
    "bad diff status",
    (f) => {
      f.data.preview.native.EV_DIFFERENCES = f.data.preview.native.EV_DIFFERENCES.replace(
        ":NEW;",
        ":EQL;"
      )
    }
  ],
  [
    "extra diff",
    (f) => {
      f.data.preview.native.EV_DIFFERENCES += "T006:1:MSEHI:NEW;"
    }
  ],
  [
    "changed API body",
    (f) => {
      f.definitions.Z_ORVANTA_CFG_BC_READ!.source.splice(1, 0, "COMMIT WORK.")
    }
  ],
  [
    "changed API interface",
    (f) => {
      f.definitions.Z_ORVANTA_CFG_BC_READ!.importParameters = []
    }
  ],
  [
    "write capability advertised",
    (f) => {
      f.data.guard.executable = true
    }
  ],
  [
    "locked snapshot advertised",
    (f) => {
      f.data.snapshot.snapshot = true
    }
  ]
]
for (const [name, mutate] of mutations)
  test(`invalid child response retracts full preflight: ${name}`, async () => {
    const f = preflightFixture()
    mutate(f)
    await assert.rejects(f.invoke())
  })

for (const name of ["snapshot", "route", "guard"] as const)
  test(`late ${name} payload drift without changed version retracts full preflight`, async () => {
    const f = preflightFixture(),
      reader = f.readers[name]
    f.readers[name] = async () => {
      const value = await reader()
      if (f.counts[name] === 2) {
        if (name === "snapshot") value.native.ET_T006D[0].MASS = "999"
        if (name === "route") value.native.ET_OBJH[0].OBJTRANSP = "1"
        if (name === "guard") value.native.ET_T006J[0].ISOTXT = "changed"
      }
      return value
    }
    await assert.rejects(f.invoke(), /TARGET_CHANGED|ROUTE_CHANGED|GUARD_CHANGED/)
  })
test("late API identity drift retracts full preflight", async () => {
  const f = preflightFixture(),
    reader = f.readers.definition
  f.readers.definition = async (name) => {
    const v = await reader(name)
    if (f.counts.definition > 4) v.interfaceFingerprint = "0".repeat(64)
    return v
  }
  await assert.rejects(f.invoke(), /API_CHANGED/)
})
test("wrong source or client is refused before any child read", async () => {
  const f = preflightFixture()
  await assert.rejects(
    f.invoke({ ...f.input, nativeSourceVersion: "0".repeat(64) }),
    /SOURCE_NOT_ATTESTED/
  )
  await assert.rejects(f.invoke(f.input, "300"), /SCOPE_UNSUPPORTED/)
  assert.ok(Object.values(f.counts).every((n) => n === 0))
})
for (const name of ["snapshot", "preview", "route", "guard", "definition"] as const)
  test(`read failure has no partial result or retry: ${name}`, async () => {
    const f = preflightFixture()
    let attempts = 0
    f.readers[name] = async () => {
      attempts++
      throw Error("original read fault")
    }
    await assert.rejects(f.invoke(), /original read fault/)
    assert.equal(attempts, name === "definition" ? 4 : 1)
  })
