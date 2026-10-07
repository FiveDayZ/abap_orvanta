import assert from "node:assert/strict"
import test from "node:test"
import { configurationBcSourceScope } from "../src/configuration-bc-source-scope.js"
import { configurationBcNativeSourcePins } from "../src/configuration-bc-native.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"
import { preflightFixture } from "./configuration-bc-preflight-fixture.js"

const input = (objectName: keyof typeof configurationBcNativeSourcePins = "T006") => ({
  connectionId: "w200" as const,
  bcSetId: "EHS_CUNI_KNM" as const,
  version: "N" as const,
  objectName,
  maxRecords: 50 as const,
  maxValues: 100 as const,
  maxDependencies: 32 as const,
  includeRecordInventory: true as const
})
// Contract-only synthetic envelopes. Their pins are not live SAP observations.
const source = (objectName: keyof typeof configurationBcNativeSourcePins = "T006") => ({
  ...input(objectName),
  client: "200",
  readOnly: true,
  readFingerprint: configurationBcNativeSourcePins[objectName] as string,
  recordInventory: {
    complete: true,
    fingerprint: "d9653312beab7ac191387dbd41ae7ee5e87e010a14d7b4c2432c08565c3aecce"
  },
  coverage: { truncated: false, targetValueComparison: "not_performed" },
  dependencies: [],
  evidence: { observedAt: "synthetic" }
})

test("nested source checks share five projections but retain independent fresh closing reads", async () => {
  let physical = 0
  const scope = configurationBcSourceScope(async (v) => {
    physical++
    return { ...source(v.objectName), evidence: { observedAt: String(physical) } }
  })
  const names = Object.keys(
    configurationBcNativeSourcePins
  ) as (keyof typeof configurationBcNativeSourcePins)[]
  for (let pass = 0; pass < 32; pass++)
    await Promise.all(names.map((name) => scope.read(input(name))))
  assert.equal(physical, 5)
  const evidence = await scope.verify()
  assert.equal(physical, 10)
  assert.equal(evidence.logicalReads, 160)
  assert.equal(evidence.reusedReads, 155)
  assert.equal(evidence.freshRechecks, 5)
  assert.equal(evidence.physicalProjectionReads, 10)
  assert.equal(evidence.targetRowsCached, false)
  assert.equal(evidence.ctsRowsCached, false)
  assert.equal(evidence.crossRequestReuse, false)
  await assert.rejects(scope.read(input()), /SOURCE_SCOPE_CLOSED/)
  await assert.rejects(scope.verify(), /SOURCE_SCOPE_CLOSED/)
})

for (const patch of [
  { connectionId: "w300" },
  { bcSetId: "OTHER" },
  { version: "C" },
  { objectName: "OTHER" },
  { maxValues: 50 },
  { includeRecordInventory: false },
  { save: true }
])
  test(`source scope refuses unsupported ${Object.keys(patch)[0]} before dispatch`, async () => {
    let calls = 0
    const scope = configurationBcSourceScope(async () => {
      calls++
      return source()
    })
    await assert.rejects(scope.read({ ...input(), ...patch }))
    assert.equal(calls, 0)
  })

for (const patch of [
  { readFingerprint: "0".repeat(64) },
  { recordInventory: { complete: false } },
  { coverage: { truncated: true, targetValueComparison: "not_performed" } },
  { dependencies: [{ bcSetId: "CHILD" }] },
  { client: "300" }
])
  test(`fresh closing ${Object.keys(patch)[0]} failure retracts the scope`, async () => {
    let calls = 0
    const scope = configurationBcSourceScope(async () => {
      calls++
      return calls === 1 ? source() : { ...source(), ...patch }
    })
    await scope.read(input())
    await assert.rejects(scope.verify(), /SOURCE_NOT_ATTESTED/)
    assert.equal(calls, 2)
    await assert.rejects(scope.read(input()), /SOURCE_SCOPE_CLOSED/)
  })

test("caller mutation and concurrent requests cannot contaminate the source baseline", async () => {
  let reads = 0
  const fresh = async () => {
    reads++
    return source()
  }
  const a = configurationBcSourceScope(fresh),
    b = configurationBcSourceScope(fresh)
  const raw = (await a.read(input())) as ReturnType<typeof source>
  raw.readFingerprint = "caller mutation"
  assert.equal(
    ((await a.read(input())) as ReturnType<typeof source>).readFingerprint,
    source().readFingerprint
  )
  await b.read(input())
  await Promise.all([a.verify(), b.verify()])
  assert.equal(reads, 4)
  await configurationBcSourceScope(fresh).read(input())
  assert.equal(reads, 5)
})

test("failed source reads are retained and closing transport errors are not hidden", async () => {
  let calls = 0
  const failed = configurationBcSourceScope(async () => {
    calls++
    throw Error("SAP unavailable")
  })
  await assert.rejects(failed.read(input()), /SAP unavailable/)
  await assert.rejects(failed.read(input()), /SAP unavailable/)
  await assert.rejects(failed.verify(), /SAP unavailable/)
  assert.equal(calls, 1)
  const closing = configurationBcSourceScope(async () => {
    if (++calls > 2) throw Error("closing SAP failure")
    return source()
  })
  await closing.read(input())
  await assert.rejects(closing.verify(), /closing SAP failure/)
})

test("ToolService publishes no preflight if shared BC Set source changes at closing", async (t) => {
  const f = preflightFixture(),
    backend = new MockBackend()
  const saved = {
    snapshot: ToolService.prototype.readConfigurationBcNativeSnapshot,
    preview: ToolService.prototype.previewConfigurationBcNative,
    route: ToolService.prototype.inspectConfigurationBcRoute,
    guard: ToolService.prototype.readConfigurationBcGuard,
    definition: ToolService.prototype.readFunctionModuleInterface
  }
  t.after(() => {
    ToolService.prototype.readConfigurationBcNativeSnapshot = saved.snapshot
    ToolService.prototype.previewConfigurationBcNative = saved.preview
    ToolService.prototype.inspectConfigurationBcRoute = saved.route
    ToolService.prototype.readConfigurationBcGuard = saved.guard
    ToolService.prototype.readFunctionModuleInterface = saved.definition
  })
  ToolService.prototype.readConfigurationBcNativeSnapshot = async function () {
    await this.readConfigurationBcSet(input())
    await this.readConfigurationBcSet(input())
    return JSON.stringify(await f.readers.snapshot())
  }
  ToolService.prototype.previewConfigurationBcNative = async () =>
    JSON.stringify(await f.readers.preview())
  ToolService.prototype.inspectConfigurationBcRoute = async () =>
    JSON.stringify(await f.readers.route())
  ToolService.prototype.readConfigurationBcGuard = async () =>
    JSON.stringify(await f.readers.guard())
  ToolService.prototype.readFunctionModuleInterface = async (v) =>
    JSON.stringify(await f.readers.definition(v.functionName))
  let reads = 0,
    drift = false
  class FreshSourceService extends ToolService {
    override async readConfigurationBcSet() {
      reads++
      return JSON.stringify({
        ...source(),
        readFingerprint: drift && reads % 2 === 0 ? "0".repeat(64) : source().readFingerprint
      })
    }
  }
  const service = new FreshSourceService(backend)
  const first = JSON.parse(await service.preflightConfigurationBcActivation(f.input))
  assert.equal(reads, 2)
  assert.equal(first.evidence.sourceReuse.logicalReads, 4)
  assert.equal(first.evidence.sourceReuse.reusedReads, 3)
  assert.equal(first.evidence.sourceReuse.freshRechecks, 1)
  assert.equal(f.counts.snapshot, 2, "native observations are not shared")
  drift = true
  await assert.rejects(service.preflightConfigurationBcActivation(f.input), /SOURCE_NOT_ATTESTED/)
  assert.equal(reads, 4, "new request opens and independently closes its own baseline")
})
