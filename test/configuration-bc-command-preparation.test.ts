import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { ConfigurationBcBeforeStateStore } from "../src/configuration-bc-before-state-store.js"
import { prepareConfigurationBcCommand } from "../src/configuration-bc-command-preparation.js"
import { stateFixture } from "./configuration-bc-state-fixture.js"

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "orvanta-bc-command-preparation-"))
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  t.after(() => rm(root, { recursive: true, force: true }))
  const f = await stateFixture(),
    state = await f.invoke(),
    store = new ConfigurationBcBeforeStateStore(root),
    captured = await store.capture(async () => state)
  const request = {
    connectionId: "w200",
    bcSetId: "EHS_CUNI_KNM",
    version: "N",
    requestNumber: "GR2K923429",
    taskNumber: "GR2K923430",
    operationId: "r54-prepare-01",
    beforeStateReference: captured.reference
  }
  let reads = 0
  const invoke = (raw: unknown = request, binding = captured.binding, current = state) =>
    prepareConfigurationBcCommand(raw, binding, store, async () => {
      reads++
      return structuredClone(current)
    })
  return {
    root,
    state,
    store,
    captured,
    request,
    invoke,
    get reads() {
      return reads
    }
  }
}

test("preparation binds durable reference and fresh complete state without write or recovery permission", async (t) => {
  const f = await setup(t),
    path = join(f.root, "configuration-bc-before-state", `${f.captured.reference}.json`),
    bytes = await readFile(path)
  const result = await f.invoke()
  assert.equal(f.reads, 1)
  assert.equal(result.receiptOwner, "WriteOperationReceiptStore")
  assert.equal(result.readOnly, true)
  assert.equal(result.nativeBeforeStateRechecked, true)
  assert.equal(result.lockedSnapshot, false)
  assert.equal(result.executable, false)
  assert.equal(result.recoveryAvailable, false)
  assert.ok(result.blockedBy.includes("sap_locked_before_state_not_established"))
  assert.ok(result.requiredNativeChecks.includes("sap_enqueue"))
  assert.deepEqual(result.beforeState.versions, f.state.versions)
  assert.equal("buffer" in result.beforeState, false)
  assert.equal("cts" in result.beforeState, false)
  assert.deepEqual(await readFile(path), bytes)
  assert.deepEqual(await readdir(f.root), ["configuration-bc-before-state"])
})

test("foreign authenticated users, client scopes and external buffers fail before current SAP read", async (t) => {
  const f = await setup(t)
  await assert.rejects(
    f.invoke(f.request, { ...f.captured.binding, user: "OTHER" }),
    /BINDING_INVALID/
  )
  await assert.rejects(
    f.invoke(f.request, {
      ...f.captured.binding,
      client: "300"
    } as unknown as typeof f.captured.binding)
  )
  await assert.rejects(f.invoke({ ...f.request, connectionId: "w300" }))
  await assert.rejects(f.invoke({ ...f.request, beforeStateReference: "../escape" }))
  for (const patch of [
    { restoreBytes: "AAAA" },
    { approved: true },
    { allowWrite: true },
    { release: true }
  ])
    await assert.rejects(f.invoke({ ...f.request, ...patch }))
  assert.equal(f.reads, 0)
})

test("missing immutable references do not trigger SAP reads or create a new before-state", async (t) => {
  const f = await setup(t)
  await assert.rejects(f.invoke({ ...f.request, beforeStateReference: "c".repeat(64) }), /ENOENT/)
  assert.equal(f.reads, 0)
  assert.deepEqual(await readdir(join(f.root, "configuration-bc-before-state")), [
    `${f.captured.reference}.json`
  ])
})

test("a fresh valid different native buffer refuses stale preparation without changing stored evidence", async (t) => {
  const f = await setup(t),
    current = structuredClone(f.state)
  const bytes = Buffer.concat([Buffer.from(current.buffer.data, "base64"), Buffer.from("changed")])
  current.buffer.data = bytes.toString("base64")
  current.buffer.bytes = bytes.length
  current.versions.state = createHash("sha256").update(bytes).digest("hex")
  await assert.rejects(f.invoke(f.request, f.captured.binding, current), /BEFORE_STATE_CHANGED/)
  assert.equal(f.reads, 1)
  assert.deepEqual(await f.store.read(f.captured.reference, f.captured.binding), f.state)
})

test("fresh identity or counts drift cannot pass on equal configuration bytes alone", async (t) => {
  const f = await setup(t)
  for (const kind of ["identity", "counts"] as const) {
    const current = structuredClone(f.state)
    if (kind === "identity") current.identity.interface = "c".repeat(64)
    else current.counts.T006 = current.counts.T006 === 0 ? 1 : 0
    await assert.rejects(f.invoke(f.request, f.captured.binding, current), /BEFORE_STATE_CHANGED/)
  }
})

test("corrupt CTS, layout or version evidence fails before any prepared result is returned", async (t) => {
  const f = await setup(t)
  for (const kind of ["cts", "layout", "version"] as const) {
    const current = structuredClone(f.state)
    if (kind === "cts") current.cts.buffer.data = "AAAA"
    if (kind === "layout") current.layoutFingerprint = "c".repeat(64)
    if (kind === "version") current.versions.guard = "c".repeat(64)
    await assert.rejects(f.invoke(f.request, f.captured.binding, current), /BEFORE_STATE_/)
  }
})

test("failed fresh reader is propagated; equal persisted before-state is never substituted", async (t) => {
  const f = await setup(t)
  await assert.rejects(
    prepareConfigurationBcCommand(f.request, f.captured.binding, f.store, async () => {
      throw Error("CONFIGURATION_BC_NATIVE_READ_CHANGED")
    }),
    /NATIVE_READ_CHANGED/
  )
})

test("valid full CTS drift is rejected even when the displayed configuration remains equal", async (t) => {
  const f = await setup(t),
    current = structuredClone(f.state)
  const bytes = Buffer.concat([
    Buffer.from(current.cts.buffer.data, "base64"),
    Buffer.from("new CTS entry")
  ])
  const version = createHash("sha256").update(bytes).digest("hex")
  current.cts.buffer.data = bytes.toString("base64")
  current.cts.buffer.bytes = bytes.length
  current.cts.ctsVersion = version
  current.nativeCtsVersion = version
  current.versions.cts = version
  await assert.rejects(f.invoke(f.request, f.captured.binding, current), /BEFORE_STATE_CHANGED/)
  assert.equal(f.reads, 1)
})
