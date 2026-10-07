import assert from "node:assert/strict"
import test from "node:test"
import { configurationBcMetadataScope } from "../src/configuration-bc-metadata.js"
import { MockBackend } from "./mock-backend.js"

const request = { operation: "READ_DOMAIN" as const, objectName: "MANDT" }
function fixture() {
  const backend = new MockBackend(),
    calls = { ddic: 0, repository: 0, source: 0, query: 0, remote: 0 }
  let changed = false
  backend.callSapDdic = async () => {
    calls.ddic++
    return { fields: [{ NAME: changed ? "CHANGED" : "MANDT" }] } as unknown as Awaited<
      ReturnType<MockBackend["callSapDdic"]>
    >
  }
  backend.callSapRepository = async () => {
    calls.repository++
    return { source: [changed ? "CHANGED" : "SOURCE"] } as Awaited<
      ReturnType<MockBackend["callSapRepository"]>
    >
  }
  backend.readSourceByUri = async (_connection, uri) => {
    calls.source++
    return { source: changed ? "CHANGED" : "SOURCE", uriUsed: uri }
  }
  backend.runQuery = async () => {
    calls.query++
    return [{ value: String(calls.query) }]
  }
  backend.callRemoteFunction = async () => {
    calls.remote++
    return { outputs: { VALUE: String(calls.remote) } }
  }
  return { backend, calls, change: () => (changed = true) }
}

test("preflight metadata scope deduplicates definitions and performs fresh complete rechecks", async () => {
  const f = fixture(),
    scope = configurationBcMetadataScope(f.backend)
  const first = await scope.backend.callSapDdic("w200", request)
  first.fields[0]!.NAME = "caller mutation"
  assert.equal((await scope.backend.callSapDdic("w200", request)).fields[0]!.NAME, "MANDT")
  await Promise.all([
    scope.backend.callSapRepository("w200", {
      operation: "READ_FUNCTION_INTERFACE",
      objectName: "Z_READ"
    }),
    scope.backend.callSapRepository("w200", {
      objectName: "Z_READ",
      operation: "READ_FUNCTION_INTERFACE"
    })
  ])
  await scope.backend.readSourceByUri("w200", "/source")
  await scope.backend.readSourceByUri("w200", "/source")
  assert.deepEqual(f.calls, { ddic: 1, repository: 1, source: 1, query: 0, remote: 0 })
  const evidence = await scope.verify()
  assert.equal(evidence.uniqueReads, 3)
  assert.equal(evidence.reusedReads, 3)
  assert.equal(evidence.freshRechecks, 3)
  assert.equal(evidence.physicalReads, 6)
  assert.equal(evidence.configurationRowsCached, false)
  assert.deepEqual(f.calls, { ddic: 2, repository: 2, source: 2, query: 0, remote: 0 })
  await assert.rejects(scope.backend.callSapDdic("w200", request), /SCOPE_CLOSED/)
  await assert.rejects(scope.verify(), /SCOPE_CLOSED/)
})

for (const kind of ["ddic", "repository", "source"] as const)
  test(`closing ${kind} drift retracts the preflight`, async () => {
    const f = fixture(),
      scope = configurationBcMetadataScope(f.backend)
    if (kind === "ddic") await scope.backend.callSapDdic("w200", request)
    else if (kind === "repository")
      await scope.backend.callSapRepository("w200", {
        operation: "READ_FUNCTION_INTERFACE",
        objectName: "Z_READ"
      })
    else await scope.backend.readSourceByUri("w200", "/source")
    f.change()
    await assert.rejects(scope.verify(), /METADATA_CHANGED/)
  })

test("rows, native calls, other connections and non-read operations are never cached", async () => {
  const f = fixture(),
    scope = configurationBcMetadataScope(f.backend)
  for (let i = 0; i < 2; i++) {
    await scope.backend.runQuery("w200", "SELECT value FROM source", 1)
    await scope.backend.callRemoteFunction("w200", {
      functionName: "Z_READ",
      inputParameters: {},
      outputParameters: []
    })
    await scope.backend.callSapDdic("w300", request)
    await scope.backend.callSapDdic("w200", { operation: "CAPABILITIES", objectName: "" })
    await scope.backend.callSapRepository("w200", {
      operation: "CAPABILITIES",
      objectName: ""
    })
    await scope.backend.readSourceByUri("w300", "/source")
  }
  assert.deepEqual(f.calls, { ddic: 4, repository: 2, source: 2, query: 2, remote: 2 })
  assert.equal((await scope.verify()).uniqueReads, 0)
})

test("simultaneous preflights use isolated baselines and no cache survives a request", async () => {
  const f = fixture(),
    a = configurationBcMetadataScope(f.backend),
    b = configurationBcMetadataScope(f.backend)
  await Promise.all([
    a.backend.callSapDdic("w200", request),
    b.backend.callSapDdic("w200", request)
  ])
  assert.equal(f.calls.ddic, 2)
  await a.verify()
  await b.verify()
  const c = configurationBcMetadataScope(f.backend)
  await c.backend.callSapDdic("w200", request)
  assert.equal(f.calls.ddic, 5)
})

test("a failed shared read remains failed and a closing service failure is not hidden", async () => {
  const f = fixture(),
    failed = configurationBcMetadataScope(f.backend)
  f.backend.callSapDdic = async () => {
    f.calls.ddic++
    throw Error("SAP unavailable")
  }
  await assert.rejects(failed.backend.callSapDdic("w200", request), /SAP unavailable/)
  await assert.rejects(failed.backend.callSapDdic("w200", request), /SAP unavailable/)
  await assert.rejects(failed.verify(), /SAP unavailable/)
  assert.equal(f.calls.ddic, 1)
  const g = fixture(),
    scope = configurationBcMetadataScope(g.backend)
  await scope.backend.callSapDdic("w200", request)
  g.backend.callSapDdic = async () => {
    throw Error("closing SAP failure")
  }
  await assert.rejects(scope.verify(), /closing SAP failure/)
})

test("large nested metadata repetition retains one fresh read per identity at closing", async () => {
  const f = fixture(),
    scope = configurationBcMetadataScope(f.backend)
  for (let pass = 0; pass < 100; pass++)
    await Promise.all(
      Array.from({ length: 11 }, (_, index) =>
        scope.backend.callSapDdic("w200", { ...request, objectName: `TYPE${index}` })
      )
    )
  assert.equal(f.calls.ddic, 11)
  const result = await scope.verify()
  assert.equal(result.logicalReads, 1100)
  assert.equal(result.reusedReads, 1089)
  assert.equal(result.freshRechecks, 11)
  assert.equal(result.physicalReads, 22)
  assert.equal(f.calls.ddic, 22)
})
