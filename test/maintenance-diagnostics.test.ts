import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  MaintenanceDiagnosticService,
  MAINTENANCE_HELPER,
  MAINTENANCE_APPROVAL_FILE,
  isFailedUpdate
} from "../src/maintenance-diagnostics.js"
import { startHttpServer } from "../src/http.js"
import { MockBackend } from "./mock-backend.js"

const fingerprint = "a".repeat(64)
const scope = { connectionId: "w200", username: "DEVELOPER" }
const period = { fromSystemTime: "2026-09-10T08:00:00", toSystemTime: "2026-09-10T08:30:00" }
const common = {
  version: "1",
  client: "200",
  authenticatedUser: "DEVELOPER",
  readOnly: true,
  status: "ok",
  code: "OK",
  hasMore: false
}
const lock = {
  client: "200",
  username: "DEVELOPER",
  tableName: "ZTAB",
  lockObject: "EZTAB",
  argument: "200000001",
  mode: "E",
  ownerSystemTime: period.fromSystemTime,
  host: "instance1",
  transaction: "ZEDIT"
}
const header = {
  updateKey: "A".repeat(32),
  client: "200",
  username: "DEVELOPER",
  systemTime: period.fromSystemTime,
  program: "ZREPORT",
  transaction: "ZEDIT",
  server: "instance1",
  state: 253,
  returnCode: 4
}
const lockReply = () => ({ ...common, action: "LOCK_SEARCH", entries: [{ ...lock }] })
const updateReply = () => ({ ...common, action: "UPDATE_SEARCH", entries: [{ ...header }] })
const detailReply = () => ({
  ...common,
  action: "UPDATE_DETAIL",
  header: { ...header },
  modules: [{ number: 1, functionName: "ZUPDATE", mode: "1", returnCode: 4 }],
  errors: [
    {
      number: 1,
      functionName: "ZUPDATE",
      program: "LZUPDATEU01",
      line: 12,
      messageClass: "ZMSG",
      messageNumber: "001",
      textUnavailable: true
    }
  ]
})

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "orvanta-maintenance-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const backend = new MockBackend()
  const state = {
    calls: 0,
    reads: 0,
    reply: JSON.stringify(lockReply()),
    drift: false,
    inputs: {} as Record<string, unknown>
  }
  backend.callRemoteFunction = async (_id, request) => {
    state.calls++
    assert.equal(request.functionName, MAINTENANCE_HELPER)
    state.inputs = request.inputParameters
    return { outputs: { EV_RESULT: state.reply } }
  }
  const service = new MaintenanceDiagnosticService(
    backend,
    root,
    async () => {
      state.reads++
      return {
        functionName: MAINTENANCE_HELPER,
        functionGroup: "ZORVANTA_MAINT",
        remoteEnabled: true,
        updateTask: false,
        interfaceFingerprint: fingerprint,
        sourceFingerprint: state.drift ? "b".repeat(64) : fingerprint
      }
    },
    async () => ({ status: "outcome_unknown", secret: "must not leak", sapLock: "not proof" })
  )
  const approval = {
    connectionId: "w200",
    url: "https://sap.example.invalid",
    client: "200",
    username: "DEVELOPER",
    sourceFingerprint: fingerprint,
    interfaceFingerprint: fingerprint,
    enabledSources: ["SM12", "SM13"]
  }
  const approve = async (entries: unknown[] = [approval]) =>
    writeFile(
      join(root, MAINTENANCE_APPROVAL_FILE),
      JSON.stringify({ version: 1, connections: entries })
    )
  return { root, backend, state, service, approval, approve }
}

test("maintenance routes are unavailable without approval, never an empty success", async (t) => {
  const f = await fixture(t)
  const result = JSON.parse(await f.service.searchLocks(scope))
  assert.equal(result.status, "unavailable")
  assert.equal(result.entries, null)
  assert.equal(f.state.calls, 0)
  assert.equal(f.state.reads, 0)
})

test("maintenance exact scope and budgets reject before helper metadata or invocation", async (t) => {
  const f = await fixture(t)
  await f.approve()
  for (const invalid of [
    { username: "*" },
    { maxResults: 101 },
    { tableName: "ZTAB*" },
    { argument: "\n" },
    { argument: "key\n" },
    { action: "UNLOCK" }
  ]) {
    await assert.rejects(f.service.searchLocks({ ...scope, ...invalid }))
  }
  await assert.rejects(
    f.service.searchUpdates({ ...scope, ...period, toSystemTime: "2026-09-10T10:00:00" }),
    /3600/
  )
  await assert.rejects(f.service.readUpdate({ ...scope, updateKey: "*" }))
  assert.equal(f.state.calls, 0)
  assert.equal(f.state.reads, 0)
})

test("maintenance approvals bind connection, source and both helper fingerprints", async (t) => {
  const f = await fixture(t)
  await f.approve([{ ...f.approval, client: "100" }])
  await assert.rejects(f.service.searchLocks(scope), /CONNECTION_MISMATCH/)
  await f.approve([f.approval, f.approval])
  await assert.rejects(f.service.searchLocks(scope), /DUPLICATE/)
  await f.approve([{ ...f.approval, enabledSources: ["SM13"] }])
  assert.equal(JSON.parse(await f.service.searchLocks(scope)).code, "SOURCE_NOT_APPROVED")
  await f.approve()
  f.state.drift = true
  await assert.rejects(f.service.searchLocks(scope), /FINGERPRINT_MISMATCH/)
  assert.equal(f.state.calls, 0)
})

test("malformed maintenance approval fails closed before SAP", async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.root, MAINTENANCE_APPROVAL_FILE), "{broken")
  await assert.rejects(f.service.searchLocks(scope), /APPROVAL_INVALID/)
  assert.equal(f.state.calls, 0)
})

test("lock scope is exact, wildcard characters in arguments are literal, receipts stay local", async (t) => {
  const f = await fixture(t)
  await f.approve()
  f.state.reply = JSON.stringify({ ...lockReply(), entries: [{ ...lock, argument: "200A*+" }] })
  const r = JSON.parse(
    await f.service.searchLocks({
      ...scope,
      tableName: "ztab",
      lockObject: "eztab",
      argument: "200A*+",
      operationId: "operation-1"
    })
  )
  assert.equal(r.status, "ok")
  assert.equal(r.entries[0].argument, "200A*+")
  assert.equal(f.state.inputs.IV_ARGUMENT, "200A*+")
  assert.equal(f.state.inputs.IV_TABLE, "ZTAB")
  assert.equal(r.localOperation.provesSapLockOwnership, false)
  assert.equal(r.localOperation.status, "outcome_unknown")
  assert.ok(!JSON.stringify(r).includes("must not leak"))
  assert.equal(r.transactionSnapshot, false)
})

for (const scenario of [
  "client",
  "user",
  "table",
  "object",
  "argument",
  "overlimit",
  "more",
  "error-data",
  "code",
  "extra-field",
  "html"
]) {
  test(`lock results reject invalid response: ${scenario}`, async (t) => {
    const f = await fixture(t)
    await f.approve()
    const r: any = lockReply()
    if (scenario === "client") r.entries[0].client = "100"
    if (scenario === "user") r.entries[0].username = "OTHER"
    if (scenario === "table") r.entries[0].tableName = "OTHER"
    if (scenario === "object") r.entries[0].lockObject = "OTHER"
    if (scenario === "argument") r.entries[0].argument = "OTHER"
    if (scenario === "overlimit") r.entries.push({ ...lock })
    if (scenario === "more") {
      r.entries = []
      r.hasMore = true
    }
    if (scenario === "error-data") {
      r.status = "forbidden"
      r.code = "NO_AUTHORITY"
    }
    if (scenario === "code") r.code = "NOT_FOUND"
    if (scenario === "extra-field") r.entries[0].ownerToken = "hidden"
    f.state.reply = scenario === "html" ? "<html>Login</html>" : JSON.stringify(r)
    await assert.rejects(
      f.service.searchLocks({
        ...scope,
        tableName: "ZTAB",
        lockObject: "EZTAB",
        argument: lock.argument,
        maxResults: 1
      }),
      /MAINTENANCE_RESPONSE/
    )
    assert.equal(f.state.calls, 1)
  })
}

test("no locks, forbidden, unsupported and native overflow remain distinct", async (t) => {
  const f = await fixture(t)
  await f.approve()
  for (const [status, code] of [
    ["ok", "OK"],
    ["forbidden", "NO_AUTHORITY"],
    ["unsupported", "LIMIT_EXCEEDED"]
  ]) {
    f.state.reply = JSON.stringify({ ...lockReply(), status, code, entries: [] })
    const result = JSON.parse(await f.service.searchLocks(scope))
    assert.equal(result.status, status)
    assert.deepEqual(result.entries, status === "ok" ? [] : null)
  }
})

test("failed update header search enforces client user time and failure status", async (t) => {
  const f = await fixture(t)
  await f.approve()
  f.state.reply = JSON.stringify(updateReply())
  const result = JSON.parse(await f.service.searchUpdates({ ...scope, ...period }))
  assert.equal(result.entries[0].updateKey, header.updateKey)
  assert.equal(result.entries[0].returnCode, 4)
  for (const change of [
    { client: "100" },
    { username: "OTHER" },
    { systemTime: "2026-09-10T09:00:00" },
    { state: 255, returnCode: 255 }
  ]) {
    f.state.reply = JSON.stringify({ ...updateReply(), entries: [{ ...header, ...change }] })
    await assert.rejects(f.service.searchUpdates({ ...scope, ...period }), /SCOPE_MISMATCH/)
  }
  f.state.reply = JSON.stringify({ ...updateReply(), entries: [header, header] })
  await assert.rejects(f.service.searchUpdates({ ...scope, ...period }), /SCOPE_MISMATCH/)
})

test("known update failure predicate excludes pending and scheduling return codes", () => {
  for (const rc of [0, 1, 241, 245, 246, 250, 253, 254, 255])
    assert.equal(isFailedUpdate(255, rc), false)
  for (const rc of [2, 4, 100, 101, 199, 200, 201]) assert.equal(isFailedUpdate(1, rc), true)
  assert.equal(isFailedUpdate(253, 255), true)
})

test("update detail preserves modules error IDs revision and non-causal correlation hints", async (t) => {
  const f = await fixture(t)
  await f.approve()
  f.state.reply = JSON.stringify(detailReply())
  const input = { ...scope, updateKey: header.updateKey }
  const first = JSON.parse(await f.service.readUpdate(input))
  assert.equal(first.data.errors[0].messageNumber, "001")
  assert.equal(first.data.errors[0].textUnavailable, true)
  assert.equal(first.correlationCandidates.causalLinkProven, false)
  assert.equal(first.correlationCandidates.executableArguments, false)
  assert.equal(first.correlationCandidates.search_background_jobs.jobName, null)
  assert.equal(
    JSON.parse(await f.service.readUpdate({ ...input, expectedRevision: first.revision })).status,
    "ok"
  )
  const drift = detailReply()
  drift.errors[0]!.line++
  f.state.reply = JSON.stringify(drift)
  const changed = JSON.parse(
    await f.service.readUpdate({ ...input, expectedRevision: first.revision })
  )
  assert.equal(changed.code, "DATA_CHANGED")
  assert.equal(changed.data, null)
})

for (const scenario of [
  "key",
  "module",
  "duplicate",
  "parameters",
  "missing",
  "not-found",
  "changed"
]) {
  test(`update detail integrity: ${scenario}`, async (t) => {
    const f = await fixture(t)
    await f.approve()
    const r: any = detailReply()
    if (scenario === "key") r.header.updateKey = "B".repeat(32)
    if (scenario === "module") r.errors[0].functionName = "OTHER"
    if (scenario === "duplicate") r.modules.push({ ...r.modules[0] })
    if (scenario === "parameters") r.errors[0].VARMSGVAL = "sensitive"
    if (scenario === "missing") r.header = null
    const unavailable = ["not-found", "changed"].includes(scenario)
    if (unavailable) {
      r.header = null
      r.modules = []
      r.errors = []
      r.status = scenario === "not-found" ? "not_found" : "unsupported"
      r.code = scenario === "not-found" ? "NOT_FOUND" : "DATA_CHANGED"
    }
    f.state.reply = JSON.stringify(r)
    if (unavailable) {
      const result = JSON.parse(
        await f.service.readUpdate({ ...scope, updateKey: header.updateKey })
      )
      assert.equal(result.data, null)
      assert.equal(result.code, r.code)
    } else
      await assert.rejects(
        f.service.readUpdate({ ...scope, updateKey: header.updateKey }),
        /MAINTENANCE_RESPONSE/
      )
  })
}

test("batch2 MCP tools are read-only and do not invoke unapproved helpers", async (t) => {
  const f = await fixture(t)
  const server = await startHttpServer(f.backend, 0, f.root)
  const c = new Client({ name: "batch2-protocol", version: "1" })
  try {
    const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl))
    await c.connect(transport as Parameters<Client["connect"]>[0])
    const list = await c.listTools()
    for (const [name, args] of [
      ["search_sap_locks", scope],
      ["search_failed_updates", { ...scope, ...period }],
      ["read_failed_update", { ...scope, updateKey: header.updateKey }]
    ] as const) {
      assert.equal(list.tools.find((x) => x.name === name)?.annotations?.readOnlyHint, true)
      const result = await c.callTool({ name, arguments: args })
      assert.notEqual(result.isError, true)
      const body = JSON.parse((result.content as Array<{ text: string }>)[0]!.text)
      assert.equal(body.code, "HELPER_NOT_APPROVED")
    }
    assert.equal(f.state.calls, 0)
  } finally {
    await c.close()
    await server.close()
  }
})

test("authored maintenance helper preserves read-only source and native permission boundaries", async () => {
  const source = await readFile("scripts/maintenance-diagnostic-source.mjs", "utf8")
  const body = source.split("String.raw`")[1]!.split("`")[0]!
  const overlongLines = body
    .split("\n")
    .map((line, index) => ({ line: index + 1, width: line.length }))
    .filter(({ width }) => width > 72)
  assert.deepEqual(overlongLines, [], "SAP function source transport is limited to 72 columns")
  assert.match(source, /S_ENQUE/)
  assert.match(source, /DPFU/)
  assert.match(source, /S_ADMI_FCD/)
  assert.match(source, /UADM/)
  assert.match(source, /gargnowc = 'X'/)
  assert.match(source, /WHERE vbkey = lv_key AND vbmandt = sy-mandt/)
  assert.match(source, /lt_modules\[\] <> lt_modules_after\[\]/)
  assert.ok(
    !/^\s*(?:UPDATE|DELETE FROM|INSERT INTO|MODIFY|COMMIT WORK|ROLLBACK WORK|SUBMIT|CALL TRANSACTION)\b/im.test(
      source
    )
  )
  assert.ok(!/CALL FUNCTION 'DEQUEUE|FROM vbdata\b/i.test(source))
})
