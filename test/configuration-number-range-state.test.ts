import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { configurationNumberRangeNativeTables as layouts } from "../src/configuration-number-range-native.js"
import {
  ConfigurationNumberRangeStateStore,
  verifiedNumberRangeSnapshot
} from "../src/configuration-number-range-state.js"

const version = "a".repeat(64)
const snapshot = () => ({
  EV_CODE: "READ_OK",
  EV_SYSTEM: "GR2",
  EV_CLIENT: "200",
  EV_VERSION: version,
  ES_DEFINITION: {
    ...Object.fromEntries(layouts.TNRO.fields.map((field) => [field, ""])),
    OBJECT: "ZORVCFGNR"
  },
  ET_INTERVALS: [
    {
      CLIENT: "200",
      OBJECT: "ZORVCFGNR",
      SUBOBJECT: "",
      NRRANGENR: "02",
      TOYEAR: "0000",
      FROMNUMBER: "00000000000000000001",
      TONUMBER: "00000000000000000100",
      NRLEVEL: "00000000000000000000",
      EXTERNIND: ""
    }
  ]
})

test("server-owned snapshot capture is immutable and absent versions remain unavailable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-number-range-state-"))
  t.diagnostic(`Retained local evidence: ${root}; SAP0`)
  const store = new ConfigurationNumberRangeStateStore(root)
  assert.equal(await store.read("ZORVCFGNR", version), null)
  const first = await store.capture("ZORVCFGNR", snapshot())
  const path = join(root, "configuration-number-range-state", `${first.reference}.json`)
  const bytes = await readFile(path)
  const second = await store.capture("ZORVCFGNR", snapshot())
  assert.deepEqual(second, first)
  assert.deepEqual(await readFile(path), bytes)
  assert.deepEqual(await store.read("ZORVCFGNR", version), snapshot())
  assert.equal(first.usableForWritePrecondition, false)
})

test("tampered contents and conflicting versions cannot overwrite or supply before state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-number-range-state-corrupt-"))
  t.diagnostic(`Retained local evidence: ${root}; SAP0`)
  const store = new ConfigurationNumberRangeStateStore(root)
  const first = await store.capture("ZORVCFGNR", snapshot())
  const path = join(root, "configuration-number-range-state", `${first.reference}.json`)
  const changed = snapshot()
  changed.ET_INTERVALS[0]!.NRLEVEL = "00000000000000000001"
  const original = await readFile(path)
  await assert.rejects(store.capture("ZORVCFGNR", changed), /STATE_VERSION_CONFLICT/)
  assert.deepEqual(await readFile(path), original)
  const envelope = JSON.parse(original.toString())
  envelope.snapshot = changed
  await writeFile(path, JSON.stringify(envelope))
  await assert.rejects(store.read("ZORVCFGNR", version), /STATE_CORRUPT/)
})

test("state validation rejects unbound objects, incomplete fields, duplicate keys and paths", async () => {
  const store = new ConfigurationNumberRangeStateStore(tmpdir())
  await assert.rejects(store.read("../credentials", version))
  await assert.rejects(store.read("ZORVCFGNR", "../credentials"))
  const incomplete = snapshot()
  delete (incomplete.ES_DEFINITION as Record<string, string>).DOMLEN
  for (const value of [
    incomplete,
    { ...snapshot(), EV_CLIENT: "300" },
    { ...snapshot(), ET_INTERVALS: [...snapshot().ET_INTERVALS, ...snapshot().ET_INTERVALS] },
    { ...snapshot(), ET_INTERVALS: [{ ...snapshot().ET_INTERVALS[0], OBJECT: "ZOTHER" }] }
  ])
    assert.throws(() => verifiedNumberRangeSnapshot(value, "ZORVCFGNR"))
})
