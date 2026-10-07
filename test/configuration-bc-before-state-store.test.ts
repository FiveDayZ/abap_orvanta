import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { ConfigurationBcBeforeStateStore } from "../src/configuration-bc-before-state-store.js"
import { stateFixture } from "./configuration-bc-state-fixture.js"

test("immutable native before-state survives a fresh store and concurrent duplicate capture", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-bc-state-store-"))
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  t.after(() => rm(root, { recursive: true, force: true }))
  const f = await stateFixture(),
    state = await f.invoke(),
    store = new ConfigurationBcBeforeStateStore(root)
  const results = await Promise.all(
    Array.from({ length: 8 }, () => store.capture(async () => state))
  )
  assert.equal(new Set(results.map((r) => r.reference)).size, 1)
  assert.deepEqual(await readdir(join(root, "configuration-bc-before-state")), [
    `${results[0]!.reference}.json`
  ])
  const before = await readFile(
    join(root, "configuration-bc-before-state", `${results[0]!.reference}.json`),
    "utf8"
  )
  const again = new ConfigurationBcBeforeStateStore(root)
  assert.deepEqual(await again.read(results[0]!.reference, results[0]!.binding), state)
  assert.equal(results[0]!.executable, false)
  assert.equal(results[0]!.recoveryPermit, false)
  await store.capture(async () => state)
  assert.equal(
    await readFile(
      join(root, "configuration-bc-before-state", `${results[0]!.reference}.json`),
      "utf8"
    ),
    before
  )
  await assert.rejects(
    again.read(results[0]!.reference, { ...results[0]!.binding, user: "OTHER" }),
    /BINDING_INVALID/
  )
  await assert.rejects(again.read("../escape", results[0]!.binding))
  state.cts.buffer.data = "AAAA"
  // The persisted value is independent of a mutable caller object.
  assert.notEqual(
    (await again.read(results[0]!.reference, results[0]!.binding)).cts.buffer.data,
    state.cts.buffer.data
  )
})
test("capture failure or corrupt native/CTS buffers produce no published evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-bc-state-invalid-"))
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  t.after(() => rm(root, { recursive: true, force: true }))
  const f = await stateFixture(),
    original = await f.invoke(),
    store = new ConfigurationBcBeforeStateStore(root)
  await assert.rejects(
    store.capture(async () => {
      throw Error("DEPENDENCY_FAILED")
    }),
    /DEPENDENCY_FAILED/
  )
  for (const kind of ["data", "cts", "version", "count", "permit", "layout"] as const) {
    const state = structuredClone(original)
    if (kind === "data") state.buffer.data = "AAAA"
    if (kind === "cts") state.cts.buffer.data += "\n"
    if (kind === "version") state.versions.guard = "c".repeat(64)
    if (kind === "count") state.counts.T006 = 2
    if (kind === "layout") Object.assign(state.layouts, { T006: "c".repeat(64) })
    if (kind === "permit") Object.assign(state.buffer, { recoveryPermit: true })
    await assert.rejects(store.capture(async () => state))
  }
  assert.deepEqual(await readdir(root), [])
})
test("disk corruption and mismatched reference cannot turn bytes into recovery permission", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-bc-state-corrupt-"))
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  t.after(() => rm(root, { recursive: true, force: true }))
  const f = await stateFixture(),
    store = new ConfigurationBcBeforeStateStore(root),
    ref = await store.capture(() => f.invoke())
  const path = join(root, "configuration-bc-before-state", `${ref.reference}.json`)
  const saved = JSON.parse(await readFile(path, "utf8"))
  saved.state.buffer.recoveryPermit = true
  await writeFile(path, JSON.stringify(saved))
  await assert.rejects(store.read(ref.reference, ref.binding), /CORRUPT/)
  await assert.rejects(
    store.capture(() => f.invoke()),
    /CORRUPT/
  )
})
