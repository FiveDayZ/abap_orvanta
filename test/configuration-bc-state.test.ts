import assert from "node:assert/strict"
import test from "node:test"
import { stateFixture } from "./configuration-bc-state-fixture.js"
import { configurationBcStateApi as api } from "../src/configuration-bc-state-api.js"
import { attestConfigurationBcStateApi } from "../src/configuration-bc-state.js"

test("native state composes bounded before/CTS observations and opaque byte validation without write permission", async () => {
  const f = await stateFixture(),
    v = await f.invoke()
  assert.equal(v.buffer.data, f.native.EV_DATA_BASE64)
  assert.equal(v.buffer.nativeRoundtrip, true)
  assert.deepEqual(v.scope, { object: "CUNI", tableCount: 9, keyCount: 19, allCuniKeys: false })
  assert.deepEqual(v.evidence, {
    apiInvocations: 2,
    preflightPasses: 2,
    ctsPasses: 2,
    identityPasses: 2
  })
  assert.equal(v.counts.T006_OIB, 0)
  assert.equal(v.executable, false)
  assert.equal(v.snapshot, false)
  assert.equal(v.recoveryAvailable, false)
  assert.equal(v.buffer.clientSideImportAvailable, false)
  assert.equal(v.buffer.recoveryPermit, false)
  assert.deepEqual(f.calls, { native: 2, preflight: 2, cts: 2, definition: 2 })
})
test("wrong scope, omitted versions and external buffers are refused before any dependency call", async () => {
  const f = await stateFixture()
  for (const patch of [
    { connectionId: "w300" },
    { taskNumber: "GR2K923429" },
    { restoreBytes: "AAAA" },
    { activate: true },
    { nativeGuardVersion: "A".repeat(64) },
    { nativeTargetVersion: undefined }
  ])
    await assert.rejects(f.invoke({ ...f.input, ...patch }))
  await assert.rejects(f.invoke(f.input, "300"), /SCOPE_UNSUPPORTED/)
  assert.deepEqual(f.calls, { native: 0, preflight: 0, cts: 0, definition: 0 })
})
test("missing customer API fails before native dispatch or preflight", async () => {
  const f = await stateFixture()
  f.readers.definition = async () => {
    throw Error("FUNCTION_NOT_FOUND")
  }
  await assert.rejects(f.invoke(), /FUNCTION_NOT_FOUND/)
  assert.equal(f.calls.native, 0)
  assert.equal(f.calls.preflight, 0)
})
test("attestation rejects body/interface/header drift but tolerates named parameter display order", async () => {
  const f = await stateFixture()
  const v = structuredClone(f.definition)
  v.importParameters.reverse()
  v.exportParameters.reverse()
  assert.doesNotThrow(() => attestConfigurationBcStateApi(v))
  for (const patch of [
    { source: [...v.source, "COMMIT WORK."] },
    { remoteEnabled: false },
    { changingParameters: [{ name: "RESTORE" }] },
    { source: ["FUNCTION Z_WRONG.", ...api.source, "ENDFUNCTION."] },
    { importParameters: [] }
  ])
    assert.throws(() => attestConfigurationBcStateApi({ ...v, ...patch }))
})
for (const [field, value] of Object.entries({
  EV_SYSTEM: "GR3",
  EV_CLIENT: "300",
  EV_USER: "OTHER",
  EV_REQUEST: "GR2K923472",
  EV_TASK: "GR2K923429",
  EV_SOURCE_VERSION: "c".repeat(64),
  EV_TARGET_VERSION: "c".repeat(64),
  EV_CANDIDATE_VERSION: "c".repeat(64),
  EV_METADATA_VERSION: "c".repeat(64),
  EV_GUARD_VERSION: "c".repeat(64),
  EV_CTS_VERSION: "c".repeat(64),
  EV_DATA_BYTES: "1",
  EV_DATA_BASE64: "AAAA",
  EV_STATE_VERSION: "c".repeat(64),
  EV_ROUNDTRIP: "",
  EV_ROW_COUNTS: "T006=1;"
}))
  test(`native state refuses ${field} drift with no second dispatch`, async () => {
    const f = await stateFixture()
    f.native[field] = value
    await assert.rejects(f.invoke())
    assert.equal(f.calls.native, 1)
  })
test("noncanonical Base64 is refused even if permissive decoder returns the same bytes", async () => {
  const f = await stateFixture()
  f.native.EV_DATA_BASE64 += "\n"
  await assert.rejects(f.invoke(), /BUFFER_INVALID/)
})
for (const code of [
  "DEPENDENCY_FAILED",
  "DEPENDENCY_REFUSED",
  "ROUNDTRIP_FAILED",
  "VERSION_CONFLICT",
  "AUTHORIZATION_DENIED",
  "UNRECOGNIZED"
])
  test(`native state ${code} never publishes partial data or retries`, async () => {
    const f = await stateFixture()
    f.native.EV_CODE = code
    await assert.rejects(
      f.invoke(),
      new RegExp(code === "UNRECOGNIZED" ? "INVALID_RESPONSE" : code)
    )
    assert.equal(f.calls.native, 1)
  })
test("SOAP fault is refused even when success-shaped outputs exist", async () => {
  const f = await stateFixture(),
    original = f.backend.callRemoteFunction
  f.backend.callRemoteFunction = async (c, r) => ({ ...(await original(c, r)), fault: "failure" })
  await assert.rejects(f.invoke(), /FAULT/)
})
test("second native response drift retracts the whole result", async () => {
  const f = await stateFixture(),
    original = f.backend.callRemoteFunction
  f.backend.callRemoteFunction = async (c, r) => {
    if (f.calls.native === 1) f.native.EV_ROUNDTRIP = ""
    return original(c, r)
  }
  await assert.rejects(f.invoke())
  assert.equal(f.calls.native, 2)
})
test("closing CTS and preflight reads plus final API identity are mandatory", async () => {
  for (const kind of ["cts", "preflight", "definition"] as const) {
    const f = await stateFixture()
    const wrap =
      <T>(read: () => Promise<T>) =>
      async () => {
        const result = await read()
        if (f.calls[kind] === 2) throw Error(`closing_${kind}_failed`)
        return result
      }
    if (kind === "cts") f.readers.cts = wrap(f.readers.cts)
    if (kind === "preflight") f.readers.preflight = wrap(f.readers.preflight)
    if (kind === "definition") f.readers.definition = wrap(f.readers.definition)
    await assert.rejects(f.invoke(), new RegExp(`closing_${kind}_failed`))
    assert.equal(f.calls.native, 2)
  }
})
test("schema-valid preflight drift in keys, presence or API identities is rejected", async () => {
  const f = await stateFixture(),
    original = f.readers.preflight
  f.readers.preflight = async () => {
    const v = await original()
    if (f.calls.preflight === 2) v.apiIdentities[0]!.source = "c".repeat(64)
    return v
  }
  await assert.rejects(f.invoke(), /PREFLIGHT_CHANGED/)
})
test("preflight missing/duplicate keys never reach the native API", async () => {
  const f = await stateFixture()
  f.preflight.rows[1]!.key = { ...f.preflight.rows[0]!.key }
  await assert.rejects(f.invoke(), /KEYS_INVALID/)
  assert.equal(f.calls.native, 0)
})
test("closing CTS count-only drift is rejected even with identical buffer digest", async () => {
  const f = await stateFixture(),
    original = f.readers.cts
  f.readers.cts = async () => {
    const v = await original()
    if (f.calls.cts === 2) v.counts.keys++
    return v
  }
  await assert.rejects(f.invoke(), /CTS_CHANGED/)
})
test("candidate stays ECC7.31/RSSOURCE compatible and has no mutating statements", () => {
  assert.ok(api.source.length > 300)
  for (const line of api.source)
    assert.ok(line.length <= 72, `RSSOURCE width ${line.length}: ${line}`)
  const source = api.source.join("\n")
  assert.doesNotMatch(
    source,
    /\b(COMMIT WORK|ROLLBACK WORK|UPDATE|INSERT|MODIFY|DELETE|CALL TRANSACTION|STARTING NEW TASK|ENQUEUE_|DEQUEUE_)\b/
  )
  assert.doesNotMatch(source, /\b(DATA\(|VALUE\s*#|NEW\s+#|@\w)/)
})
