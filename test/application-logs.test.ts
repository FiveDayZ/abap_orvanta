import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  ApplicationLogService,
  APPLICATION_LOG_APPROVAL_FILE,
  APPLICATION_LOG_HELPER
} from "../src/application-logs.js"
import { startHttpServer } from "../src/http.js"
import { MockBackend } from "./mock-backend.js"
import { ToolService } from "../src/tools.js"

const fingerprint = "a".repeat(64)
const revision = "b".repeat(64)
const number = (value: number) => String(value).padStart(20, "0")
const header = (id = 1) => ({
  logNumber: number(id),
  object: "ZTEST",
  subobject: "IMPORT",
  externalNumber: "TEST",
  username: "DEVELOPER",
  program: "ZTEST",
  transaction: "",
  systemTime: "2026-09-08T10:00:00",
  messageCount: 2
})
const message = (id = 1) => ({
  number: id,
  type: "E",
  messageClass: "ZTEST",
  messageNumber: "001",
  text: "中文错误 password=hidden",
  textTruncated: false,
  textUnavailable: false,
  systemTime: null
})
const approval = {
  connectionId: "w200",
  url: "https://sap.example.invalid",
  client: "200",
  username: "DEVELOPER",
  sourceFingerprint: fingerprint,
  interfaceFingerprint: fingerprint,
  allowMessages: true
}
const definition = {
  functionName: APPLICATION_LOG_HELPER,
  functionGroup: "ZORVANTA_LOG",
  sourceFingerprint: fingerprint,
  interfaceFingerprint: fingerprint,
  remoteEnabled: true,
  updateTask: false
}
function response(action: "SEARCH" | "READ" = "SEARCH") {
  return {
    version: "1",
    action,
    client: "200",
    authenticatedUser: "DEVELOPER",
    readOnly: true,
    status: "ok",
    code: "OK",
    headers: [{ ...header(), messageCount: action === "READ" ? 1 : 2 }],
    messages: action === "READ" ? [message()] : [],
    hasMore: false,
    revision,
    fromSystemTime: "2026-09-08T00:00:00",
    toSystemTime: "2026-09-08T23:59:59"
  }
}
function discoveryResponse(ids = [3, 2, 1]) {
  return {
    version: "1",
    action: "DISCOVER",
    client: "200",
    authenticatedUser: "DEVELOPER",
    readOnly: true,
    status: "ok",
    code: "OK",
    headers: ids.map((id) => {
      const { logNumber, object, subobject, systemTime } = header(id)
      return { logNumber, object, subobject, systemTime }
    }),
    messages: [],
    hasMore: false
  }
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "orvanta-slg1-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const backend = new MockBackend()
  let reads = 0
  const state = { reply: JSON.stringify(response()), definition: { ...definition }, invocations: 0 }
  backend.callRemoteFunction = async (_id, request) => {
    state.invocations++
    assert.equal(request.functionName, APPLICATION_LOG_HELPER)
    assert.deepEqual(request.outputParameters, [{ name: "EV_RESULT", kind: "scalar" }])
    assert.ok(
      ["SEARCH", "READ_DIAGNOSTIC", "DISCOVER"].includes(String(request.inputParameters.IV_ACTION))
    )
    if (request.inputParameters.IV_ACTION === "DISCOVER") {
      assert.ok(Number(request.inputParameters.IV_LIMIT) >= 1)
      assert.ok(Number(request.inputParameters.IV_LIMIT) <= 20)
      for (const key of [
        "IV_OBJECT",
        "IV_SUBOBJECT",
        "IV_EXTERNAL",
        "IV_USER",
        "IV_FROM",
        "IV_TO",
        "IV_AFTER_LOG",
        "IV_LOGNUMBER",
        "IV_REVISION"
      ])
        assert.equal(request.inputParameters[key], "")
    }
    return { outputs: { EV_RESULT: state.reply } }
  }
  const service = new ApplicationLogService(backend, root, async () => {
    reads++
    return state.definition
  })
  const approve = (value: unknown = { version: 1, connections: [approval] }) =>
    writeFile(join(root, APPLICATION_LOG_APPROVAL_FILE), JSON.stringify(value), "utf8")
  return { root, backend, state, service, approve, reads: () => reads }
}

test("SLG1 preserves boundary-length Unicode text and truncation flags and rejects oversized text", async (t) => {
  const f = await fixture(t)
  await f.approve()
  const input = { connectionId: "w200", logNumber: number(1) }
  for (const length of [4095, 4096]) {
    const text = "\u4e2d".repeat(length - 1) + "\u7ec8"
    for (const textTruncated of [false, true]) {
      f.state.reply = JSON.stringify({
        ...response("READ"),
        messages: [{ ...message(), text, textTruncated }]
      })
      const result = JSON.parse(await f.service.read(input))
      assert.equal(result.messages[0].text, text)
      assert.equal(result.messages[0].textTruncated, textTruncated)
      assert.equal(result.messages[0].textUnavailable, false)
    }
  }
  f.state.reply = JSON.stringify({
    ...response("READ"),
    messages: [{ ...message(), text: "\u4e2d".repeat(4097) }]
  })
  await assert.rejects(f.service.read(input), /RESPONSE_INVALID/)
})

test("SLG1 distinguishes missing approval files from missing connection approvals", async (t) => {
  const f = await fixture(t)
  const input = { connectionId: "w200" }
  const missing = JSON.parse(await f.service.discover(input))
  assert.equal(missing.code, "HELPER_NOT_APPROVED")
  assert.equal(missing.reason, "APPROVAL_FILE_MISSING")
  await f.approve({ version: 1, connections: [] })
  const absent = JSON.parse(await f.service.discover(input))
  assert.equal(absent.code, "HELPER_NOT_APPROVED")
  assert.equal(absent.reason, "CONNECTION_NOT_APPROVED")
  assert.equal(f.state.invocations, 0)
  assert.equal(f.reads(), 0)
  assert.ok(!JSON.stringify([missing, absent]).includes(f.root))
})

test("SLG1 unapproved helper and message route are unavailable without any SAP calls", async (t) => {
  const f = await fixture(t)
  assert.equal(
    JSON.parse(await f.service.discover({ connectionId: "w200" })).code,
    "HELPER_NOT_APPROVED"
  )
  assert.equal(
    JSON.parse(await f.service.search({ connectionId: "w200", object: "ZTEST" })).code,
    "HELPER_NOT_APPROVED"
  )
  await f.approve({ version: 1, connections: [{ ...approval, allowMessages: false }] })
  assert.equal(
    JSON.parse(await f.service.read({ connectionId: "w200", logNumber: number(1) })).code,
    "MESSAGE_READ_NOT_APPROVED"
  )
  assert.equal(f.reads(), 0)
  assert.equal(f.state.invocations, 0)
})

test("SLG1 discovery returns only bounded descending references without enabling messages", async (t) => {
  const f = await fixture(t)
  await f.approve({ version: 1, connections: [{ ...approval, allowMessages: false }] })
  f.state.reply = JSON.stringify(discoveryResponse())
  const result = JSON.parse(await f.service.discover({ connectionId: "w200" }))
  assert.equal(result.sampled, true)
  assert.equal(result.returnedCount, 3)
  assert.equal(result.hasMore, undefined)
  assert.deepEqual(result.samples, discoveryResponse().headers)
  assert.equal(
    JSON.parse(await f.service.read({ connectionId: "w200", logNumber: number(1) })).code,
    "MESSAGE_READ_NOT_APPROVED"
  )
  assert.equal(f.state.invocations, 1)
})

test("SLG1 discovery rejects extra scope and excessive budgets before SAP access", async (t) => {
  const f = await fixture(t)
  for (const input of [
    { maxResults: 0 },
    { maxResults: 21 },
    { maxResults: 1.5 },
    { object: "*" },
    { fromSystemTime: "2026-09-08T00:00:00" },
    { sql: "SELECT * FROM BALHDR" }
  ])
    await assert.rejects(f.service.discover({ connectionId: "w200", ...input }))
  assert.equal(f.reads(), 0)
  assert.equal(f.state.invocations, 0)
})

test("SLG1 discovery fails closed on drift, leaked fields, wrong identity, order and status", async (t) => {
  const f = await fixture(t)
  await f.approve()
  f.state.definition.sourceFingerprint = revision
  await assert.rejects(f.service.discover({ connectionId: "w200" }), /FINGERPRINT_MISMATCH/)
  assert.equal(f.state.invocations, 0)
  f.state.definition = { ...definition }
  f.state.reply = JSON.stringify(discoveryResponse())
  await assert.rejects(f.service.discover({ connectionId: "w200", maxResults: 1 }))
  for (const change of [
    { headers: [header()] },
    { headers: discoveryResponse([1, 2]).headers },
    { headers: discoveryResponse([1, 1]).headers },
    { headers: discoveryResponse(Array.from({ length: 21 }, (_, i) => 21 - i)).headers },
    { client: "100" },
    { authenticatedUser: "OTHER" },
    { hasMore: true },
    { messages: [message()] },
    { revision },
    { fromSystemTime: "2026-09-08T00:00:00" },
    { status: "forbidden", code: "NO_AUTHORITY" }
  ]) {
    f.state.reply = JSON.stringify({ ...discoveryResponse(), ...change })
    await assert.rejects(f.service.discover({ connectionId: "w200" }))
  }
  for (const [status, code] of [
    ["ok", "OK"],
    ["forbidden", "NO_AUTHORITY"],
    ["unsupported", "READ_ONLY_UNSUPPORTED"]
  ]) {
    f.state.reply = JSON.stringify({ ...discoveryResponse([]), status, code })
    const result = JSON.parse(await f.service.discover({ connectionId: "w200" }))
    assert.equal(result.status, status)
    assert.equal(result.returnedCount, status === "ok" ? 0 : undefined)
  }
})

test("SLG1 rejects invalid scope, dates, pagination and budgets before approval or SAP reads", async (t) => {
  const f = await fixture(t)
  for (const input of [
    { object: "*" },
    { maxResults: 51 },
    { fromSystemTime: "2026-02-30T00:00:00" },
    { fromSystemTime: "2026-09-08T00:00:00" },
    { fromSystemTime: "2026-09-08T00:00:00", toSystemTime: "2026-09-10T00:00:00" },
    { fromSystemTime: "2026-09-08T23:00:00", toSystemTime: "2026-09-08T01:00:00" },
    { externalNumber: "*" }
  ])
    await assert.rejects(f.service.search({ connectionId: "w200", object: "ZTEST", ...input }))
  await assert.rejects(
    f.service.read({ connectionId: "w200", logNumber: number(1), afterMessageNumber: 1 })
  )
  await assert.rejects(
    f.service.read({ connectionId: "w200", logNumber: number(1), maxMessages: 201 })
  )
  assert.equal(f.reads(), 0)
  assert.equal(f.state.invocations, 0)
})

test("SLG1 rejects corrupt approval, wrong connection, duplicate entries and source/interface drift", async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.root, APPLICATION_LOG_APPROVAL_FILE), "invalid-json")
  await assert.rejects(
    f.service.search({ connectionId: "w200", object: "ZTEST" }),
    /APPROVAL_INVALID/
  )
  for (const value of [
    { ...approval, url: "https://another.example.invalid" },
    { ...approval, client: "100" },
    { ...approval, username: "OTHER" }
  ]) {
    await f.approve({ version: 1, connections: [value] })
    await assert.rejects(
      f.service.search({ connectionId: "w200", object: "ZTEST" }),
      /CONNECTION_MISMATCH/
    )
  }
  await f.approve({ version: 1, connections: [approval, approval] })
  await assert.rejects(f.service.search({ connectionId: "w200", object: "ZTEST" }), /DUPLICATE/)
  await f.approve()
  for (const key of ["sourceFingerprint", "interfaceFingerprint"] as const) {
    f.state.definition = { ...definition, [key]: revision }
    await assert.rejects(
      f.service.search({ connectionId: "w200", object: "ZTEST" }),
      /FINGERPRINT_MISMATCH/
    )
  }
  assert.equal(f.state.invocations, 0)
})

test("SLG1 search preserves scope, keyset cursors and explicit SAP local times", async (t) => {
  const f = await fixture(t)
  await f.approve()
  f.state.reply = JSON.stringify({ ...response(), hasMore: true })
  const result = JSON.parse(
    await f.service.search({
      connectionId: "W200",
      object: "ztest",
      subobject: "import",
      externalNumber: "TEST",
      username: "developer",
      maxResults: 1,
      afterLogNumber: number(0),
      fromSystemTime: "2026-09-08T00:00:00",
      toSystemTime: "2026-09-08T23:59:59"
    })
  )
  assert.equal(result.nextAfterLogNumber, number(1))
  assert.equal(result.headers.length, 1)
  assert.equal(result.qualityGate, "not_evaluated")
  assert.equal(result.readOnly, true)
  assert.equal(f.state.invocations, 1)
})

test("SLG1 empty, forbidden, missing and unsupported results never mask failure as no logs", async (t) => {
  const f = await fixture(t)
  await f.approve()
  for (const [status, code] of [
    ["ok", "OK"],
    ["forbidden", "NO_AUTHORITY"],
    ["not_found", "NOT_FOUND"],
    ["unsupported", "READ_ONLY_UNSUPPORTED"]
  ]) {
    f.state.reply = JSON.stringify({ ...response(), status, code, headers: [] })
    const result = JSON.parse(await f.service.search({ connectionId: "w200", object: "ZTEST" }))
    assert.equal(result.status, status)
    if (status === "ok") assert.equal(result.returnedCount, 0)
    else assert.equal(result.headers, undefined)
  }
})

test("SLG1 rejects malformed responses, cross-client/user data, inconsistent status and filter violations", async (t) => {
  const f = await fixture(t)
  await f.approve()
  for (const raw of [
    "<html>login</html>",
    "",
    "x".repeat(1024 * 1024 + 1),
    ...[
      { version: "2" },
      { client: "100" },
      { authenticatedUser: "OTHER" },
      { readOnly: false },
      { status: "forbidden", code: "NO_AUTHORITY" },
      { hasMore: true },
      { headers: [header(), header()] },
      { headers: [{ ...header(), object: "OTHER" }] },
      { headers: [{ ...header(), systemTime: "2026-09-07T00:00:00" }] },
      { fromSystemTime: "2026-09-01T00:00:00" },
      { messages: [message()] }
    ].map((change) => JSON.stringify({ ...response(), ...change }))
  ]) {
    f.state.reply = raw
    await assert.rejects(f.service.search({ connectionId: "w200", object: "ZTEST" }))
  }
})

test("SLG1 diagnostic reasons are allowlisted and retain the existing unsupported contract", async (t) => {
  const f = await fixture(t)
  await f.approve()
  const reply = {
    ...response("READ"),
    status: "unsupported",
    code: "READ_ONLY_UNSUPPORTED",
    reason: "BLOCK_LAYOUT",
    headers: [],
    messages: [],
    hasMore: false
  }
  const input = { connectionId: "w200", logNumber: number(1) }
  f.state.reply = JSON.stringify(reply)
  const result = JSON.parse(await f.service.read(input))
  assert.equal(result.reason, "BLOCK_LAYOUT")
  assert.equal(result.code, "READ_ONLY_UNSUPPORTED")
  for (const change of [{ reason: "password=secret" }, { status: "ok", code: "OK" }]) {
    f.state.reply = JSON.stringify({ ...reply, ...change })
    await assert.rejects(f.service.read(input), /RESPONSE_INVALID/)
  }
})

test("SLG1 message pages preserve numbers, revision and text flags without returning secrets", async (t) => {
  const f = await fixture(t)
  await f.approve()
  f.state.reply = JSON.stringify({ ...response("READ"), headers: [header()], hasMore: true })
  const first = JSON.parse(
    await f.service.read({ connectionId: "w200", logNumber: number(1), maxMessages: 1 })
  )
  assert.equal(first.nextAfterMessageNumber, 1)
  assert.equal(first.revision, revision)
  assert.match(first.messages[0].text, /中文错误/)
  assert.doesNotMatch(JSON.stringify(first), /hidden/)
  f.state.reply = JSON.stringify({
    ...response("READ"),
    messages: [{ ...message(2), textTruncated: true }]
  })
  const second = JSON.parse(
    await f.service.read({
      connectionId: "w200",
      logNumber: number(1),
      afterMessageNumber: 1,
      expectedRevision: revision
    })
  )
  assert.equal(second.messages[0].number, 2)
  assert.equal(second.messages[0].textTruncated, true)
  for (const change of [
    { revision: fingerprint },
    { headers: [header()], messages: [] },
    { headers: [header(2)] },
    { messages: [message(2), message(1)] }
  ]) {
    f.state.reply = JSON.stringify({ ...response("READ"), ...change })
    await assert.rejects(
      f.service.read({ connectionId: "w200", logNumber: number(1), expectedRevision: revision })
    )
  }
})

test("SLG1 MCP registration uses its explicit state root and cannot enable an unapproved helper", async (t) => {
  const f = await fixture(t)
  const running = await startHttpServer(f.backend, 0, f.root)
  const client = new Client({ name: "slg1-test", version: "1" })
  try {
    const transport = new StreamableHTTPClientTransport(new URL(running.mcpUrl))
    await client.connect(transport as Parameters<Client["connect"]>[0])
    for (const extra of [{ object: "*" }, { maxResults: 21 }, { sql: "SELECT * FROM BALHDR" }]) {
      const invalid = await client.callTool({
        name: "discover_application_logs",
        arguments: { connectionId: "w200", ...extra }
      })
      assert.equal(invalid.isError, true)
    }
    for (const [name, args] of [
      ["discover_application_logs", {}],
      ["search_application_logs", { object: "ZTEST" }],
      ["read_application_log", { logNumber: number(1) }]
    ] as const) {
      const result = await client.callTool({ name, arguments: { connectionId: "w200", ...args } })
      assert.equal(result.isError, undefined)
      const payload = JSON.parse((result.content as Array<{ text: string }>)[0]!.text)
      assert.equal(payload.status, "unavailable")
      assert.equal(payload.code, "HELPER_NOT_APPROVED")
      assert.equal(payload.reason, "APPROVAL_FILE_MISSING")
    }
    const correlation = await client.callTool({
      name: "correlate_sap_logs",
      arguments: {
        connectionId: "w200",
        fromSystemTime: "2026-09-08T10:00:00",
        toSystemTime: "2026-09-08T11:00:00",
        systemLog: {},
        includeDumps: false
      }
    })
    assert.equal(correlation.isError, undefined)
    const correlated = JSON.parse((correlation.content as Array<{ text: string }>)[0]!.text)
    assert.equal(correlated.status, "unavailable")
    assert.equal(correlated.sources[0].code, "HELPER_NOT_APPROVED")
    assert.equal(correlated.sources[0].reason, "APPROVAL_FILE_MISSING")
    assert.equal(correlated.timeline.length, 0)
    assert.equal(f.state.invocations, 0)
  } finally {
    await client.close()
    await running.close()
  }
})

test("SLG1 MCP approved route checks live metadata and returns structured search/messages", async (t) => {
  const f = await fixture(t)
  const original = f.backend.callSapRepository.bind(f.backend)
  f.backend.callSapRepository = async (id, request) => {
    assert.equal(request.operation, "READ_FUNCTION_INTERFACE")
    assert.equal(request.objectName, APPLICATION_LOG_HELPER)
    const result = await original(id, { ...request, objectName: "ZCMCP_FM_1501" })
    return {
      ...result,
      source: result.source.map((line) =>
        line.startsWith("M|1|FUNCTION_GROUP|") ? "M|1|FUNCTION_GROUP|ZORVANTA_LOG" : line
      )
    }
  }
  const metadata = JSON.parse(
    await new ToolService(f.backend).readFunctionModuleInterface({
      connectionId: "w200",
      functionName: APPLICATION_LOG_HELPER
    })
  )
  await f.approve({
    version: 1,
    connections: [
      {
        ...approval,
        sourceFingerprint: metadata.sourceFingerprint,
        interfaceFingerprint: metadata.interfaceFingerprint
      }
    ]
  })
  const running = await startHttpServer(f.backend, 0, f.root)
  const client = new Client({ name: "slg1-approved-test", version: "1" })
  try {
    const transport = new StreamableHTTPClientTransport(new URL(running.mcpUrl))
    await client.connect(transport as Parameters<Client["connect"]>[0])
    for (const [name, args, reply] of [
      ["discover_application_logs", {}, discoveryResponse([1])],
      ["search_application_logs", { object: "ZTEST" }, response()],
      ["read_application_log", { logNumber: number(1) }, response("READ")]
    ] as const) {
      f.state.reply = JSON.stringify(reply)
      const result = await client.callTool({ name, arguments: { connectionId: "w200", ...args } })
      assert.equal(result.isError, undefined, JSON.stringify(result.content))
      const payload = JSON.parse((result.content as Array<{ text: string }>)[0]!.text)
      assert.equal(payload.status, "ok")
      assert.equal(payload.returnedCount, 1)
    }
    assert.equal(f.state.invocations, 3)
  } finally {
    await client.close()
    await running.close()
  }
})
