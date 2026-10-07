import assert from "node:assert/strict"
import test from "node:test"
import {
  configurationBcAuditLayouts,
  configurationBcAuditFunctions,
  configurationBcAuditFields,
  readConfigurationBcDependencies,
  readConfigurationBcLogs
} from "../src/configuration-bc-audit.js"
import { toolContracts } from "../src/contracts.js"
import { toolNamesForProfile } from "../src/tool-registry.js"
import {
  NATIVE_PREVIEW_EMPTY_HTML,
  reviewedTableReaderDefinition
} from "../src/reviewed-table-reader.js"

const input = { connectionId: "w200", bcSetId: "ZROOT", version: "N" }
const activation = "A".repeat(32)
const row = (table: keyof typeof configurationBcAuditFields, value: Record<string, string>) => ({
  ...Object.fromEntries(configurationBcAuditFields[table].map((f) => [f, ""])),
  ...value
})
const header = (ID: string, CATEGORY = "") => row("SCPRATTR", { ID, VERSION: "N", CATEGORY })
const edge = (ID: string, SUBPROFILE: string, PROF_POSIT = "1") =>
  row("SCPRPPRL", { ID, VERSION: "N", SUBPROFILE, PROF_POSIT })
const message = (LINE_NR: string, values: Record<string, string> = {}) =>
  row("SCPRACPM", { ACT_ID: activation, LINE_NR, BCSET_ID: "ZROOT", MSGTY: "E", ...values })
const logHeader = (ACT_ID = activation, T_MANDT = "200") =>
  row("SCPRACPP", { ACT_ID, T_MANDT, ACT_DATE: "20261003", ACT_TIME: "090000" })
function fixture() {
  const rows: Record<string, Record<string, string>[]> = {
    SCPRATTR: [header("ZROOT")],
    SCPRPPRL: [],
    SCPRACPM: [],
    SCPRACPP: []
  }
  const calls: string[] = [],
    counts = new Map<string, number>()
  const options = {
    failed: "",
    changed: "",
    layout: false,
    source: false,
    fallback: false,
    conflictingReferences: false
  }
  const backend = {
    runQuery: async (_id: string, sql: string, maximum: number) => {
      calls.push(sql)
      if (options.fallback) throw Error(NATIVE_PREVIEW_EMPTY_HTML)
      const table = /FROM (\w+)/.exec(sql)![1]!,
        count = counts.get(sql) ?? 0
      counts.set(sql, count + 1)
      if (options.failed === table) throw Error("403")
      const filters = [...sql.matchAll(/(\w+) = '([^']*)'/g)]
      const selected = rows[table]!.filter((r) => filters.every((f) => r[f[1]!] === f[2]))
      if (options.conflictingReferences && sql.includes("PARENT_ID ="))
        return selected.slice(0, maximum).map((r) => ({ ...r, MSGTY: "W" }))
      return options.changed === table && count ? [] : selected.slice(0, maximum)
    },
    callRemoteFunction: async (
      _id: string,
      request: { functionName: string; inputParameters: Record<string, unknown> }
    ) => {
      assert.equal(request.functionName, "RFC_READ_TABLE")
      const fields = request.inputParameters.FIELDS as { FIELDNAME: string }[]
      assert.equal(
        request.inputParameters.ROWCOUNT,
        request.inputParameters.QUERY_TABLE === "SCPRATTR" ? "2" : "9"
      )
      return { outputs: { FIELDS: fields, DATA: [] } }
    }
  }
  const table = async (objectName: string) => ({
    connectionId: "w200",
    objectName,
    objectKind: "transparentTable",
    fingerprint: options.layout
      ? "bad"
      : configurationBcAuditLayouts[objectName as keyof typeof configurationBcAuditLayouts]
  })
  const fn = async (functionName: string) => {
    if (functionName === "RFC_READ_TABLE")
      return {
        functionName,
        remoteEnabled: true,
        updateTask: false,
        sourceFingerprint: reviewedTableReaderDefinition.shape.sourceFingerprint.value,
        interfaceFingerprint: reviewedTableReaderDefinition.shape.interfaceFingerprint.value
      }
    const [sourceFingerprint, interfaceFingerprint] =
      configurationBcAuditFunctions[functionName as keyof typeof configurationBcAuditFunctions]
    return {
      functionName,
      remoteEnabled: false,
      updateTask: false,
      sourceFingerprint: options.source ? "bad" : sourceFingerprint,
      interfaceFingerprint
    }
  }
  return {
    rows,
    calls,
    options,
    dependencies: (raw: unknown = input, client = "200") =>
      readConfigurationBcDependencies(raw, client, backend, table, fn),
    logs: (raw: unknown = input, client = "200") =>
      readConfigurationBcLogs(raw, client, backend, table, fn)
  }
}

test("dependency graph preserves positions, missing selected versions and cycles across branches", async () => {
  const f = fixture()
  f.rows.SCPRATTR!.push(header("ZONE"), header("ZTWO"))
  f.rows.SCPRPPRL = [
    edge("ZROOT", "ZTWO", "10"),
    edge("ZROOT", "ZONE", "2"),
    edge("ZONE", "ZTWO"),
    edge("ZTWO", "ZONE"),
    edge("ZTWO", "ZMISSING", "2")
  ]
  const r = await f.dependencies()
  assert.deepEqual(
    r.edges!.slice(0, 2).map((e) => e.child),
    ["ZONE", "ZTWO"]
  )
  assert.ok(r.cycles!.some((c) => c.join("/") === "ZONE/ZTWO/ZONE"))
  assert.deepEqual(r.coverage.missingSelectedVersion, ["ZMISSING"])
  assert.equal(r.readFingerprint, null)
  assert.equal(r.coverage.activationOrderResolved, false)
  assert.ok(f.calls.every((sql) => sql.includes("VERSION = 'N'")))
})
test("depth and node budgets retain unvisited references without exceeding the read scope", async () => {
  const f = fixture()
  f.rows.SCPRPPRL = [edge("ZROOT", "ZONE"), edge("ZROOT", "ZTWO", "2")]
  for (const limit of [{ maxDepth: 0 }, { maxNodes: 1 }]) {
    f.calls.length = 0
    const r = await f.dependencies({ ...input, ...limit })
    assert.equal(r.nodes!.length, 1)
    assert.equal(r.edges!.length, 2)
    assert.equal(r.frontier!.length, 2)
    assert.equal(r.readFingerprint, null)
    assert.equal(f.calls.length, 4)
  }
})
test("stable empty graphs are distinct from missing or unsupported headers", async () => {
  const f = fixture(),
    empty = await f.dependencies()
  assert.equal(empty.coverage.observedGraphComplete, true)
  assert.match(empty.readFingerprint!, /^[a-f0-9]{64}$/)
  f.rows.SCPRATTR = []
  const missing = await f.dependencies()
  assert.equal(missing.status, "not_found")
  f.rows.SCPRATTR = [header("ZROOT", "S")]
  f.calls.length = 0
  const unsupported = await f.dependencies()
  assert.equal(unsupported.nodes![0]!.status, "unsupported_category")
  assert.ok(f.calls.every((sql) => !sql.includes("SCPRPPRL")))
})
test("logs deduplicate references, preserve raw errors and filter recorded target client", async () => {
  const f = fixture()
  f.rows.SCPRACPM = [
    message("1", { PARENT_ID: "ZROOT", PROTOFLAG: "E" }),
    message("2", { BCSET_ID: "ZCHILD", PARENT_ID: "ZROOT" })
  ]
  f.rows.SCPRACPP = [logHeader()]
  const r = await f.logs()
  assert.equal(r.activations!.length, 1)
  assert.equal(r.activations![0]!.messages!.length, 2)
  assert.equal(r.activations![0]!.messages![0]!.MSGTY, "E")
  assert.equal(r.coverage.completionStatusDerived, false)
  assert.equal(r.coverage.historicalVersionResolved, false)
  assert.ok(
    f.calls
      .filter((sql) => sql.includes("FROM SCPRACPP"))
      .every((sql) => sql.includes("T_MANDT = '200'"))
  )
  f.rows.SCPRACPP = [logHeader(activation, "300")]
  const other = await f.logs()
  assert.equal(other.activations![0]!.status, "no_header_for_recorded_target_client")
  assert.equal(other.activations![0]!.messages, null)
})
test("empty logs and bounded unexpanded activation IDs do not imply the latest successful activation", async () => {
  const f = fixture(),
    empty = await f.logs()
  assert.equal(empty.status, "no_selected_references")
  f.rows.SCPRACPM = [message("1"), message("1", { ACT_ID: "B".repeat(32) })]
  f.rows.SCPRACPP = [logHeader()]
  const limited = await f.logs({ ...input, maxActivations: 1 })
  assert.equal(limited.activations!.length, 1)
  assert.deepEqual(limited.unexpandedActivationIds, ["B".repeat(32)])
  assert.equal(limited.coverage.truncated, true)
  assert.equal(limited.readFingerprint, null)
  assert.equal(limited.coverage.latestActivationProven, false)
})
test("failed, changed, truncated and duplicate reads cannot produce a trusted audit", async () => {
  const f = fixture()
  f.options.failed = "SCPRPPRL"
  assert.equal((await f.dependencies()).nodes, null)
  f.options.failed = ""
  const changed = fixture()
  changed.options.changed = "SCPRATTR"
  assert.equal((await changed.dependencies()).status, "changed")
  const g = fixture()
  g.rows.SCPRPPRL = [edge("ZROOT", "ZONE"), edge("ZROOT", "ZTWO"), edge("ZROOT", "ZTHREE")]
  const truncated = await g.dependencies({ ...input, maxChildren: 2 })
  assert.equal(truncated.coverage.truncated, true)
  assert.equal(truncated.readFingerprint, null)
  g.rows.SCPRPPRL = [edge("ZROOT", "ZONE"), edge("ZROOT", "ZONE")]
  assert.equal((await g.dependencies()).status, "unavailable")
  const h = fixture()
  h.options.failed = "SCPRACPM"
  assert.equal((await h.logs()).activations, null)
  const logChanged = fixture()
  logChanged.rows.SCPRACPM = [message("1")]
  logChanged.options.changed = "SCPRACPM"
  assert.equal((await logChanged.logs()).activations, null)
  const conflict = fixture()
  conflict.rows.SCPRACPM = [message("1", { PARENT_ID: "ZROOT" })]
  conflict.options.conflictingReferences = true
  const conflicting = await conflict.logs()
  assert.equal(conflicting.status, "changed")
  assert.equal(conflicting.activations, null)
  assert.equal(conflicting.readFingerprint, null)
})
test("scope, source and layout refusals occur before data queries; profiles stay read-only", async () => {
  const f = fixture()
  for (const run of [f.dependencies, f.logs]) {
    await assert.rejects(run({ ...input, version: "C" }))
    await assert.rejects(run({ ...input, connectionId: "w300" }), /SCOPE_UNSUPPORTED/)
    await assert.rejects(run(input, "300"), /SCOPE_UNSUPPORTED/)
    await assert.rejects(run({ ...input, unexpected: true }))
  }
  f.options.layout = true
  await assert.rejects(f.logs(), /LAYOUT_UNVERIFIED/)
  f.options.layout = false
  f.options.source = true
  await assert.rejects(f.dependencies(), /SOURCE_UNVERIFIED/)
  assert.equal(f.calls.length, 0)
  for (const name of [
    "read_configuration_bc_dependencies",
    "read_configuration_bc_logs"
  ] as const) {
    assert.equal(toolContracts[name].annotations.readOnlyHint, true)
    assert.ok(toolNamesForProfile("readonly").includes(name))
    assert.ok(toolNamesForProfile("config").includes(name))
  }
})
test("only the reviewed empty-HTML fallback is used for bounded reads", async () => {
  const f = fixture()
  f.options.fallback = true
  const r = await f.dependencies()
  assert.equal(r.status, "not_found")
  assert.ok(r.evidence.sources.every((s) => s.method === "rfc_read_table"))
})
