import assert from "node:assert/strict"
import test from "node:test"
import {
  inspectConfigurationBcImpact,
  configurationBcActivationFunctions,
  configurationBcActivationIncludes
} from "../src/configuration-bc-impact.js"
import type { readConfigurationBcDependencies } from "../src/configuration-bc-audit.js"
import type { readConfigurationBcSet } from "../src/configuration-bc-set.js"
import type { compareConfigurationBcSet } from "../src/configuration-bc-compare.js"
import { toolContracts } from "../src/contracts.js"
import { toolNamesForProfile } from "../src/tool-registry.js"

type Graph = Awaited<ReturnType<typeof readConfigurationBcDependencies>>
type Content = Awaited<ReturnType<typeof readConfigurationBcSet>>
type Comparison = Awaited<ReturnType<typeof compareConfigurationBcSet>>
const input = { connectionId: "w200", bcSetId: "ZROOT", version: "N", language: "ZH" }
const header = (ID: string) => ({
  ID,
  VERSION: "N",
  CATEGORY: "",
  TYPE: "TMV",
  MODDATE: "20261003",
  MODTIME: "100000"
})
// Synthetic adapter observations test composition, not SAP business or activation outcomes.
function fixture() {
  const graph = {
    status: "partial",
    nodes: [{ id: "ZROOT", depth: 0, status: "read", header: header("ZROOT") }],
    edges: [],
    cycles: [] as string[][],
    frontier: [],
    coverage: { observedGraphComplete: true, complete: false, truncated: false },
    readFingerprint: "a".repeat(64)
  }
  const options = {
    graphChanged: false,
    graphFailed: false,
    contentChanged: false,
    contentFailed: false,
    comparisonChanged: false,
    headerChanged: false,
    truncated: false,
    inventoryChanged: false,
    inventoryFailed: false,
    inventoryPartial: false,
    unitCallsPerComparison: 2,
    keysFlag: "UKY"
  }
  let graphReads = 0,
    comparisons = 0,
    unitCalls = 0
  const contents = new Map<string, number>(),
    requestedTables: string[] = []
  const run = (
    raw: unknown = input,
    client = "200",
    readFunction?: (name: string) => Promise<unknown>,
    readInclude: ((name: string) => Promise<unknown>) | undefined = async (name) =>
      activationInclude(name)
  ) =>
    inspectConfigurationBcImpact(
      raw,
      client,
      async () => {
        graphReads++
        if (options.graphFailed)
          return { ...graph, status: "unavailable", nodes: null } as unknown as Graph
        return {
          ...graph,
          frontier:
            options.graphChanged && graphReads > 1
              ? [{ id: "ZCHANGED", reason: "node_limit" }]
              : graph.frontier
        } as unknown as Graph
      },
      async (value) => {
        requestedTables.push(value.objectName)
        const key = value.bcSetId + "/" + value.objectName,
          count = contents.get(key) ?? 0
        contents.set(key, count + 1)
        if (options.contentFailed && count) throw Error("403")
        return {
          status: "partial",
          header: {
            ...header(value.bcSetId),
            MODDATE: options.headerChanged ? "20261004" : "20261003"
          },
          readFingerprint: options.contentChanged && count ? "c".repeat(64) : "b".repeat(64),
          coverage: { truncated: options.truncated },
          records: [{ RECNUMBER: "1" }],
          values: [{ RECNUMBER: "1", FIELDNAME: "MSEHI", VALUE: "KNM", FLAG: options.keysFlag }],
          languageValues: [],
          recordInventory:
            value.includeRecordInventory && !options.inventoryFailed
              ? {
                  status: options.inventoryPartial ? "partial" : "read",
                  complete: !options.inventoryPartial,
                  fingerprint: options.inventoryPartial
                    ? null
                    : options.inventoryChanged && count
                      ? "e".repeat(64)
                      : "d".repeat(64),
                  tableNames: ["T006", "T006A", "ZTOTHER"],
                  unsupportedTableNames: ["ZTOTHER"],
                  records: []
                }
              : null,
          evidence: {}
        } as unknown as Content
      },
      async (value, beforeUnitRead) => {
        comparisons++
        let blocked = false
        for (let i = 0; i < options.unitCallsPerComparison; i++) {
          try {
            beforeUnitRead()
            unitCalls++
          } catch {
            blocked = true
            break
          }
        }
        return {
          status: blocked ? "incomparable" : "partial",
          code: blocked ? "BC_SET_COMPARISON_RECHECK_UNAVAILABLE" : null,
          coverage: {
            sourceFingerprint: options.comparisonChanged ? "c".repeat(64) : "b".repeat(64)
          },
          evidence: { valuesRechecked: !blocked },
          rows: blocked
            ? []
            : [
                {
                  recordNumber: "1",
                  key: options.keysFlag === "UKY" ? { MSEHI: "KNM" } : null,
                  status: "partial",
                  fields: [
                    {
                      field: value.objectName === "T006" ? "DIMID" : "MSEHT",
                      status: options.keysFlag === "UKY" ? "target_missing" : "incomparable",
                      expected: "stored",
                      current: null
                    }
                  ]
                }
              ]
        } as unknown as Comparison
      },
      readFunction,
      readInclude
    )
  return {
    graph,
    options,
    run,
    counts: () => ({ graphReads, comparisons, unitCalls, requestedTables })
  }
}
test("impact report composes selected observations while remaining explicitly partial", async () => {
  const f = fixture(),
    r = await f.run()
  assert.equal(r.status, "partial")
  assert.equal(r.items!.length, 2)
  assert.deepEqual(
    r.items!.map((i) => i.objectName),
    ["T006", "T006A"]
  )
  assert.equal(r.fieldCounts!.target_missing, 2)
  assert.equal(r.coverage.unitReaderInvocations, 4)
  assert.equal(r.coverage.complete, false)
  assert.equal(r.activationAvailable, false)
  assert.equal(r.evidence.graphRechecked, true)
  assert.equal(r.evidence.contentsRechecked, true)
  assert.match(r.readFingerprint!, /^[a-f0-9]{64}$/)
  assert.equal(f.counts().graphReads, 2)
  assert.ok(f.counts().requestedTables.every((t) => ["T006", "T006A"].includes(t)))
})

test("impact composes whole-set inventories without promoting unsupported tables to values", async () => {
  const f = fixture(),
    r = await f.run({ ...input, includeRecordInventory: true })
  assert.equal(r.coverage.wholeSetRecordInventory, "read_rechecked")
  assert.deepEqual(r.coverage.unsupportedInventoryTables, ["ZTOTHER"])
  assert.equal(r.recordInventories?.length, 1)
  assert.match(r.readFingerprint!, /^[a-f0-9]{64}$/)
  assert.ok(f.counts().requestedTables.every((name) => ["T006", "T006A"].includes(name)))
  assert.equal(r.activationAvailable, false)
  assert.equal(r.coverage.complete, false)
  assert.equal((await fixture().run()).recordInventories, null)
})

test("impact inventory changes and failures retract scope evidence; truncation remains partial", async () => {
  for (const option of ["inventoryChanged", "inventoryFailed", "inventoryPartial"] as const) {
    const f = fixture()
    f.options[option] = true
    const r = await f.run({ ...input, includeRecordInventory: true })
    assert.equal(r.readFingerprint, null, option)
    assert.equal(r.coverage.wholeSetRecordInventory, "incomplete", option)
    assert.equal(r.activationAvailable, false, option)
    if (option !== "inventoryPartial") {
      assert.equal(r.status, option === "inventoryChanged" ? "changed" : "unavailable")
      assert.equal(r.recordInventories, null, option)
      assert.equal(r.items, null, option)
    }
  }
  const incomplete = fixture()
  incomplete.graph.coverage.observedGraphComplete = false
  const partial = await incomplete.run({ ...input, includeRecordInventory: true })
  assert.equal(partial.coverage.wholeSetRecordInventory, "incomplete")
  assert.equal(partial.readFingerprint, null)
})
test("one global budget covers comparisons and confirmations across nodes and tables", async () => {
  const f = fixture()
  f.graph.nodes.push({ id: "ZCHILD", depth: 1, status: "read", header: header("ZCHILD") })
  const r = await f.run({ ...input, maxTargetReads: 3 })
  assert.equal(f.counts().unitCalls, 3)
  assert.equal(r.coverage.unitReaderInvocations, 3)
  assert.equal(r.coverage.deniedTargetReads, 1)
  assert.equal(r.coverage.targetBudgetExhausted, true)
  assert.equal(r.items!.length, 4)
  assert.equal(r.readFingerprint, null)
  assert.equal(r.fieldCounts!.target_missing, 1)
  const zero = fixture(),
    skipped = await zero.run({ ...input, maxTargetReads: 0 })
  assert.equal(zero.counts().comparisons, 0)
  assert.equal(zero.counts().unitCalls, 0)
  assert.ok(skipped.items!.every((i) => i.code === "BC_IMPACT_TARGET_READ_LIMIT"))
})
test("graph, header and content linkage drift discard every composed observation", async () => {
  for (const option of [
    "graphChanged",
    "contentChanged",
    "comparisonChanged",
    "headerChanged"
  ] as const) {
    const f = fixture()
    f.options[option] = true
    const r = await f.run()
    assert.equal(r.status, "changed", option)
    assert.equal(r.items, null)
    assert.equal(r.fieldCounts, null)
    assert.equal(r.readFingerprint, null)
  }
})
test("unavailable graph or content confirmation never yields target absence or trusted counts", async () => {
  const f = fixture()
  f.options.graphFailed = true
  const failed = await f.run()
  assert.equal(failed.status, "unavailable")
  assert.equal(f.counts().comparisons, 0)
  const g = fixture()
  g.options.contentFailed = true
  const confirmation = await g.run()
  assert.equal(confirmation.status, "unavailable")
  assert.equal(confirmation.items, null)
  assert.equal(confirmation.fieldCounts, null)
})
test("truncation, unresolved keys, cycles and unexpanded references cannot become complete reports", async () => {
  const f = fixture()
  f.options.truncated = true
  const truncated = await f.run()
  assert.equal(f.counts().comparisons, 0)
  assert.equal(truncated.readFingerprint, null)
  const g = fixture()
  g.graph.cycles = [["ZROOT", "ZROOT"]]
  assert.equal((await g.run()).readFingerprint, null)
  const h = fixture()
  h.graph.coverage.observedGraphComplete = false
  assert.equal((await h.run()).readFingerprint, null)
  const variable = fixture()
  variable.options.keysFlag = "KEY"
  const unknown = await variable.run()
  assert.equal(unknown.items![0]!.storedUnitKeyCells![0]!.flag, "KEY")
  assert.equal(unknown.items![0]!.comparison!.rows[0]!.key, null)
  assert.equal(unknown.fieldCounts!.incomparable, 2)
  assert.equal(unknown.coverage.unresolvedRecordCount, 2)
  assert.equal(unknown.coverage.activationKeyResolved, false)
})
test("scope, language, budgets and undeclared inputs refuse before adapter calls", async () => {
  const f = fixture()
  for (const bad of [
    { ...input, connectionId: "w300" },
    { ...input, version: "C" },
    { ...input, language: undefined },
    { ...input, maxNodes: 6 },
    { ...input, maxTargetReads: 41 },
    { ...input, objectName: "USR02" }
  ])
    await assert.rejects(f.run(bad))
  await assert.rejects(f.run(input, "300"), /SCOPE_UNSUPPORTED/)
  assert.equal(f.counts().graphReads, 0)
  assert.equal(toolContracts.inspect_configuration_bc_impact.annotations.readOnlyHint, true)
  for (const profile of ["config", "readonly"] as const)
    assert.ok(toolNamesForProfile(profile).includes("inspect_configuration_bc_impact"))
})

// Only metadata-reader callbacks are available here; activation execution is not an adapter.
function activationSource(name: string) {
  const pin =
    configurationBcActivationFunctions[name as keyof typeof configurationBcActivationFunctions]
  assert.ok(pin)
  return {
    connectionId: "w200",
    functionName: name,
    ...pin,
    updateTask: false,
    source: Array(pin.lineCount).fill("synthetic source")
  }
}
test("optional activation audit rechecks reviewed functions and includes without enabling execution", async () => {
  const f = fixture(),
    calls: string[] = []
  const read = async (name: string) => {
    calls.push(name)
    return activationSource(name)
  }
  const legacy = await f.run(input, "200", read)
  assert.equal(legacy.activationBoundary, null)
  assert.equal(calls.length, 0)
  const r = await fixture().run({ ...input, includeActivationBoundary: true }, "200", read),
    b = r.activationBoundary!
  const count = Object.keys(configurationBcActivationFunctions).length
  assert.equal(calls.length, 2 * count)
  assert.deepEqual(calls.slice(0, count), calls.slice(count))
  assert.equal(b.includes!.length, 4)
  assert.equal(b.evidence.functionReaderInvocations, 42)
  assert.equal(b.evidence.includeReaderInvocations, 8)
  assert.equal(b.evidence.readerInvocationLimit, 50)
  assert.equal(b.authorityDefinition!.objectName, "S_BCSETS")
  assert.equal(b.authorityDefinition!.enabled, true)
  assert.equal(b.authorityDefinition!.currentUserAuthorized, null)
  assert.deepEqual(b.optionDefinition!.activationType["1"], { dialog: "N" })
  assert.deepEqual(b.optionDefinition!.completeOnly["2"], { unchecked: "Y" })
  assert.deepEqual(b.directTableUpdatePolicy!.valueFlagsByNoStandard.F, ["FIX"])
  assert.equal(b.directTableUpdatePolicy!.scope, "existing_record_direct_table_update_branch")
  assert.equal(b.status, "source_attested")
  assert.equal(b.evidence.sourcesRechecked, true)
  assert.match(b.sourceFingerprint!, /^[a-f0-9]{64}$/)
  assert.equal(b.sources!.filter((x) => x.remoteEnabled).length, 1)
  assert.ok(b.observations!.some((x) => x.finding.includes("connection R/3*")))
  assert.equal(b.coverage.atomicRollbackProved, false)
  assert.equal(b.coverage.headlessRouteProved, false)
  assert.equal(b.coverage.runtimeExecuted, false)
  assert.equal(b.coverage.currentUserAuthorization, "not_checked")
  assert.equal(b.activationAvailable, false)
  assert.equal(r.activationAvailable, false)
})
test("unreviewed identity, mode, source, interface and truncation withhold activation facts", async () => {
  for (const patch of [
    { connectionId: "w300" },
    { functionName: "OTHER" },
    { remoteEnabled: true },
    { updateTask: true },
    { sourceFingerprint: "0".repeat(64) },
    { interfaceFingerprint: "0".repeat(64) },
    { source: [] }
  ]) {
    const r = await fixture().run(
      { ...input, includeActivationBoundary: true },
      "200",
      async (name) => ({ ...activationSource(name), ...patch })
    )
    assert.equal(r.activationBoundary!.status, "unreviewed")
    assert.equal(r.activationBoundary!.sources, null)
    assert.equal(r.activationBoundary!.observations, null)
    assert.equal(r.activationBoundary!.sourceFingerprint, null)
    assert.equal(r.activationAvailable, false)
  }
})
test("changed or unavailable confirmations discard source verdicts independently of data observations", async () => {
  for (const failure of ["changed", "unavailable"]) {
    let calls = 0
    const r = await fixture().run(
      { ...input, includeActivationBoundary: true },
      "200",
      async (name) => {
        calls++
        if (
          calls === Object.keys(configurationBcActivationFunctions).length + 1 &&
          failure === "unavailable"
        )
          throw Error("read failed")
        return {
          ...activationSource(name),
          ...(calls === Object.keys(configurationBcActivationFunctions).length + 1
            ? { sourceFingerprint: "0".repeat(64) }
            : {})
        }
      }
    )
    assert.equal(calls, Object.keys(configurationBcActivationFunctions).length + 1)
    assert.equal(r.activationBoundary!.status, failure)
    assert.equal(r.activationBoundary!.observations, null)
    assert.equal(r.activationBoundary!.sourceFingerprint, null)
    assert.equal(r.activationBoundary!.evidence.sourcesRechecked, false)
    assert.equal(r.status, "partial")
    assert.equal(r.fieldCounts!.target_missing, 2)
    assert.equal(r.activationAvailable, false)
  }
  assert.equal(
    (await fixture().run({ ...input, includeActivationBoundary: true })).activationBoundary!.status,
    "unavailable"
  )
  await assert.rejects(fixture().run({ ...input, includeActivationBoundary: "true" }))
})

function activationInclude(name: string) {
  const pin =
    configurationBcActivationIncludes[name as keyof typeof configurationBcActivationIncludes]
  assert.ok(pin)
  return { connectionId: "w200", objectName: name, ...pin }
}
test("unreviewed include identity, canonical URI, hash or truncation discards every source-derived policy", async () => {
  for (const patch of [
    { connectionId: "w300" },
    { objectName: "OTHER" },
    { sourceUri: "/other/source/main" },
    { sourceFingerprint: "0".repeat(64) },
    { lineCount: 1 }
  ]) {
    const r = await fixture().run(
        { ...input, includeActivationBoundary: true },
        "200",
        async (name) => activationSource(name),
        async (name) => ({ ...activationInclude(name), ...patch })
      ),
      b = r.activationBoundary!
    assert.equal(b.status, "unreviewed")
    assert.equal(b.failedInclude, "LSCPRACF01")
    for (const key of [
      "sources",
      "includes",
      "observations",
      "authorityDefinition",
      "optionDefinition",
      "directTableUpdatePolicy",
      "sourceFingerprint"
    ] as const)
      assert.equal(b[key], null, key)
    assert.equal(b.evidence.functionReaderInvocations, 21)
    assert.equal(b.evidence.includeReaderInvocations, 1)
    assert.equal(r.fieldCounts!.target_missing, 2)
  }
})
test("changed or failed include confirmation cannot retain options or authorization facts", async () => {
  for (const mode of ["changed", "unavailable"]) {
    let reads = 0
    const r = await fixture().run(
        { ...input, includeActivationBoundary: true },
        "200",
        async (name) => activationSource(name),
        async (name) => {
          reads++
          if (reads === 5 && mode === "unavailable") throw Error("source unavailable")
          return {
            ...activationInclude(name),
            ...(reads === 5 ? { sourceFingerprint: "0".repeat(64) } : {})
          }
        }
      ),
      b = r.activationBoundary!
    assert.equal(b.status, mode)
    assert.equal(b.failedInclude, "LSCPRACF01")
    assert.equal(b.authorityDefinition, null)
    assert.equal(b.optionDefinition, null)
    assert.equal(b.directTableUpdatePolicy, null)
    assert.equal(b.includes, null)
    assert.equal(b.sources, null)
    assert.equal(b.sourceFingerprint, null)
    assert.equal(b.evidence.functionReaderInvocations, 42)
    assert.equal(b.evidence.includeReaderInvocations, 5)
    assert.equal(b.evidence.sourcesRechecked, false)
    assert.equal(r.activationAvailable, false)
  }
})
