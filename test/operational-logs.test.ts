import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  OperationalLogService,
  OPERATIONAL_LOG_APPROVAL_FILE,
  OPERATIONAL_LOG_HELPER
} from "../src/operational-logs.js"
import { MockBackend } from "./mock-backend.js"

const fingerprint = "a".repeat(64)
const scope = {
  connectionId: "w200",
  fromSystemTime: "2026-09-08T10:00:00",
  toSystemTime: "2026-09-08T11:00:00"
}
const job = {
  jobName: "ZJOB",
  jobCount: "00000001",
  status: "F",
  username: "DEVELOPER",
  executionUser: "DEVELOPER",
  server: "instance1",
  scheduledSystemTime: scope.fromSystemTime,
  startSystemTime: scope.fromSystemTime,
  endSystemTime: scope.toSystemTime
}
const common = {
  version: "1",
  client: "200",
  authenticatedUser: "DEVELOPER",
  readOnly: true,
  status: "ok",
  code: "OK"
}
const reportInput = { connectionId: "w200", report: "ZREPORT" }
const reportReply = () => ({
  ...common,
  action: "REPORT_PARAMETERS",
  report: "ZREPORT",
  parameters: [],
  complete: true
})
test("report parameters require separate scope and reject input before metadata or invocation", async (t) => {
  const f = await fixture(t)
  await f.approve({ enabledSources: ["SM37", "SM37_DETAILS", "SP01"] })
  assert.equal(
    JSON.parse(await f.service.readReportParameters(reportInput)).code,
    "SOURCE_NOT_APPROVED"
  )
  await assert.rejects(f.service.readReportParameters({ ...reportInput, report: "*" }))
  assert.equal(f.state.reads, 0)
  assert.equal(f.state.calls, 0)
})
test("report parameter scope drift prevents any helper call", async (t) => {
  const f = await fixture(t)
  await f.approve({ enabledSources: ["REPORT_PARAMETERS"] })
  f.state.sourceFingerprint = "b".repeat(64)
  await assert.rejects(f.service.readReportParameters(reportInput), /FINGERPRINT_MISMATCH/)
  assert.equal(f.state.calls, 0)
})
test("report parameter request cannot enable defaults or pass execution input", async (t) => {
  const f = await fixture(t)
  await f.approve({ enabledSources: ["REPORT_PARAMETERS"] })
  f.state.reply = JSON.stringify(reportReply())
  const result = JSON.parse(await f.service.readReportParameters(reportInput))
  assert.deepEqual(f.state.lastInput, {
    IV_ACTION: "REPORT_PARAMETERS",
    IV_PROGRAM: "ZREPORT",
    IV_LIMIT: "200"
  })
  assert.equal(result.definitionSource, "existing_compiled_selection_metadata")
  assert.equal(result.defaultValuesAvailable, false)
})
test("report parameter failure cannot carry metadata and scope cannot change", async (t) => {
  const f = await fixture(t)
  await f.approve({ enabledSources: ["REPORT_PARAMETERS"] })
  for (const change of [
    { status: "forbidden", code: "NO_AUTHORITY" },
    { report: "OTHER" },
    { client: "000" },
    { complete: false }
  ]) {
    f.state.reply = JSON.stringify({ ...reportReply(), ...change })
    await assert.rejects(f.service.readReportParameters(reportInput))
  }
  f.state.reply = JSON.stringify({
    ...reportReply(),
    report: null,
    status: "unsupported",
    code: "READ_ONLY_UNSUPPORTED"
  })
  assert.equal(JSON.parse(await f.service.readReportParameters(reportInput)).status, "unsupported")
})
const detailsInput = { connectionId: "w200", jobName: "ZJOB", jobCount: "00000001" }
const spoolInput = { ...detailsInput, stepNumber: 1, spoolId: "123" }
const spoolReply = () => ({
  ...common,
  action: "JOB_SPOOL",
  job: { jobName: "ZJOB", jobCount: "00000001" },
  stepNumber: 1,
  spoolId: "0000000123",
  page: 1,
  spoolStamp: "created:modified:C",
  lines: ["first", "second"]
})
test("spool scope is independent of job-details approval and validates cursors before SAP access", async (t) => {
  const f = await fixture(t)
  await f.approve({ enabledSources: ["SM37_DETAILS"] })
  assert.equal(JSON.parse(await f.service.readJobSpool(spoolInput)).code, "SOURCE_NOT_APPROVED")
  await assert.rejects(f.service.readJobSpool({ ...spoolInput, afterLine: 1 }), /expectedRevision/)
  assert.equal(f.state.calls, 0)
  assert.equal(f.state.reads, 0)
})
test("spool reader sends a bounded exact job-step request without caller-supplied SQL", async (t) => {
  const f = await fixture(t)
  await f.approve({ enabledSources: ["SP01"] })
  f.state.reply = JSON.stringify(spoolReply())
  const result = JSON.parse(await f.service.readJobSpool(spoolInput))
  assert.equal(result.lines.length, 2)
  assert.deepEqual(f.state.lastInput, {
    IV_ACTION: "JOB_SPOOL",
    IV_JOBNAME: "ZJOB",
    IV_JOBCOUNT: "00000001",
    IV_STEP: "1",
    IV_SPOOLID: "123",
    IV_PAGE: "1",
    IV_LIMIT: "1000"
  })
})
test("spool helper cannot return data with denied permissions", async (t) => {
  const f = await fixture(t)
  await f.approve({ enabledSources: ["SP01"] })
  f.state.reply = JSON.stringify({ ...spoolReply(), status: "forbidden", code: "NO_AUTHORITY" })
  await assert.rejects(f.service.readJobSpool(spoolInput), /RESPONSE_INVALID/)
})
test("spool helper drift prevents invocation", async (t) => {
  const f = await fixture(t)
  await f.approve({ enabledSources: ["SP01"] })
  f.state.sourceFingerprint = "c".repeat(64)
  await assert.rejects(f.service.readJobSpool(spoolInput), /FINGERPRINT_MISMATCH/)
  assert.equal(f.state.calls, 0)
})
const detailsReply = () => ({
  ...common,
  action: "JOB_DETAILS",
  job,
  steps: [
    {
      stepNumber: 1,
      program: "ZREPORT",
      variant: "DAILY",
      executionUser: "DEVELOPER",
      spoolId: "0000000123",
      stepTypeCode: ""
    }
  ],
  complete: true
})

test("job details require a separate approval before metadata or RFC access", async (t) => {
  const f = await fixture(t)
  await f.approve()
  const result = JSON.parse(await f.service.readJobDetails(detailsInput))
  assert.equal(result.code, "SOURCE_NOT_APPROVED")
  assert.equal(f.state.reads, 0)
  assert.equal(f.state.calls, 0)
})

test("job details return metadata without claiming variants, spool bodies or execution", async (t) => {
  const f = await fixture(t)
  await f.approve({ enabledSources: ["SM37_DETAILS"] })
  f.state.reply = JSON.stringify(detailsReply())
  const result = JSON.parse(await f.service.readJobDetails(detailsInput))
  assert.equal(result.steps[0].variant, "DAILY")
  assert.equal(result.steps[0].spoolId, "0000000123")
  assert.equal(result.variantValuesAvailable, false)
  assert.equal(result.spoolContentAvailable, false)
  assert.equal(result.executionAvailable, false)
  assert.match(result.revision, /^[a-f0-9]{64}$/)
  assert.equal(f.state.calls, 1)
})

test("job details reject wrong jobs, duplicate steps and data in failed replies", async (t) => {
  const f = await fixture(t)
  await f.approve({ enabledSources: ["SM37_DETAILS"] })
  const reply = detailsReply()
  f.state.reply = JSON.stringify({ ...reply, job: { ...job, jobCount: "00000002" } })
  await assert.rejects(f.service.readJobDetails(detailsInput), /SCOPE_MISMATCH/)
  f.state.reply = JSON.stringify({ ...reply, steps: [...reply.steps, ...reply.steps] })
  await assert.rejects(f.service.readJobDetails(detailsInput), /SCOPE_MISMATCH/)
  f.state.reply = JSON.stringify({ ...reply, status: "forbidden", code: "NO_AUTHORITY" })
  await assert.rejects(f.service.readJobDetails(detailsInput), /RESPONSE_INVALID/)
})

test("job details reject helper drift without executing the RFC", async (t) => {
  const f = await fixture(t)
  await f.approve({ enabledSources: ["SM37_DETAILS"] })
  f.state.sourceFingerprint = "b".repeat(64)
  await assert.rejects(f.service.readJobDetails(detailsInput), /FINGERPRINT_MISMATCH/)
  assert.equal(f.state.calls, 0)
})
const message = (number: number) => ({
  number,
  systemTime: scope.fromSystemTime,
  type: "E",
  messageClass: "ZMSG",
  messageNumber: "001",
  text: "password=secret",
  textTruncated: false
})
const searchReply = () => ({
  ...common,
  action: "JOB_SEARCH",
  fromSystemTime: scope.fromSystemTime,
  toSystemTime: scope.toSystemTime,
  jobs: [job],
  hasMore: false
})
const systemReply = () => ({
  ...common,
  action: "SYSTEM_READ",
  fromSystemTime: scope.fromSystemTime,
  toSystemTime: scope.toSystemTime,
  server: "instance1",
  coverage: "local_instance_bounded_tail",
  scannedRecords: 3,
  truncated: true,
  entries: [
    {
      id: "1:180",
      client: "200",
      server: "instance1",
      systemTime: scope.fromSystemTime,
      username: "DEVELOPER",
      program: "ZJOB",
      transaction: "",
      messageId: "ABC",
      type: "E",
      text: "token=secret",
      textUnavailable: false,
      textTruncated: false
    }
  ]
})
test("the strict reply envelope accepts the optional CAPABILITIES payload and rejects any other key", async (t) => {
  const f = await fixture(t)
  await f.approve()
  // The helper's CAPABILITIES self-description reuses this envelope and carries its rows in an
  // optional `payload` array; a business reply that happens to carry the key stays valid, and
  // every unknown key is still rejected because the object remains `.strict()`.
  f.state.reply = JSON.stringify({
    ...searchReply(),
    payload: [`HELPER|${OPERATIONAL_LOG_HELPER}`, "PROTOCOL|MAX|1.0"]
  })
  const result = JSON.parse(await f.service.searchJobs({ ...scope, jobName: "ZJOB" }))
  assert.equal(result.status, "ok")
  assert.equal(result.returnedCount, 1)
  assert.equal("payload" in result, false)
  for (const change of [{ payload: "HELPER|Z_ORVANTA_OPS_READ" }, { payloadRows: [] }]) {
    f.state.reply = JSON.stringify({ ...searchReply(), ...change })
    await assert.rejects(f.service.searchJobs({ ...scope, jobName: "ZJOB" }), /RESPONSE_INVALID/)
  }
})

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "orvanta-ops-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const backend = new MockBackend()
  const state = {
    calls: 0,
    lastInput: {} as Record<string, unknown>,
    reads: 0,
    sourceFingerprint: fingerprint,
    reply: JSON.stringify(searchReply())
  }
  backend.callRemoteFunction = async (_id, request) => {
    state.calls++
    state.lastInput = request.inputParameters ?? {}
    assert.equal(request.functionName, OPERATIONAL_LOG_HELPER)
    assert.deepEqual(request.outputParameters, [{ name: "EV_RESULT", kind: "scalar" }])
    return { outputs: { EV_RESULT: state.reply } }
  }
  const service = new OperationalLogService(backend, root, async () => {
    state.reads++
    return {
      functionName: OPERATIONAL_LOG_HELPER,
      functionGroup: "ZORVANTA_LOG",
      remoteEnabled: true,
      updateTask: false,
      sourceFingerprint: state.sourceFingerprint,
      interfaceFingerprint: fingerprint
    }
  })
  const approval = {
    connectionId: "w200",
    url: "https://sap.example.invalid",
    client: "200",
    username: "DEVELOPER",
    sourceFingerprint: fingerprint,
    interfaceFingerprint: fingerprint,
    enabledSources: ["SM37", "SM21"]
  }
  const approve = (change: object = {}) =>
    writeFile(
      join(root, OPERATIONAL_LOG_APPROVAL_FILE),
      JSON.stringify({ version: 1, connections: [{ ...approval, ...change }] })
    )
  return { service, state, approve }
}

test("operational log routes distinguish missing files from missing connection approvals", async (t) => {
  const f = await fixture(t)
  const reads = [
    () => f.service.searchJobs({ ...scope, jobName: "ZJOB" }),
    () => f.service.readJobLog({ connectionId: "w200", jobName: "ZJOB", jobCount: "00000001" }),
    () => f.service.readSystem(scope)
  ]
  for (const read of reads) {
    const result = JSON.parse(await read())
    assert.equal(result.code, "HELPER_NOT_APPROVED")
    assert.equal(result.reason, "APPROVAL_FILE_MISSING")
  }
  await f.approve({ connectionId: "other" })
  for (const read of reads) {
    const result = JSON.parse(await read())
    assert.equal(result.code, "HELPER_NOT_APPROVED")
    assert.equal(result.reason, "CONNECTION_NOT_APPROVED")
  }
  assert.equal(f.state.calls, 0)
  assert.equal(f.state.reads, 0)
})

test("operational logs fail closed before SAP calls for missing approval, source gate and identity drift", async (t) => {
  const f = await fixture(t)
  assert.equal(
    JSON.parse(await f.service.searchJobs({ ...scope, jobName: "ZJOB" })).code,
    "HELPER_NOT_APPROVED"
  )
  await f.approve({ enabledSources: ["SM37"] })
  assert.equal(JSON.parse(await f.service.readSystem(scope)).code, "SOURCE_NOT_APPROVED")
  assert.equal(f.state.reads, 0)
  await f.approve({ client: "100" })
  await assert.rejects(f.service.searchJobs({ ...scope, jobName: "ZJOB" }), /CONNECTION_MISMATCH/)
  await f.approve()
  f.state.sourceFingerprint = "b".repeat(64)
  await assert.rejects(f.service.readSystem(scope), /FINGERPRINT_MISMATCH/)
  assert.equal(f.state.calls, 0)
})

test("operational inputs reject wildcard, SQL scope, bad dates, budgets and unversioned pages", async (t) => {
  const f = await fixture(t)
  for (const change of [
    { jobName: "*" },
    { maxResults: 51 },
    { fromSystemTime: "2026-02-30T00:00:00" },
    { toSystemTime: "2026-09-10T11:00:00" },
    { afterJobCount: "1" },
    { sql: "SELECT * FROM TBTCO" }
  ])
    await assert.rejects(f.service.searchJobs({ ...scope, jobName: "ZJOB", ...change }))
  await assert.rejects(f.service.readSystem({ ...scope, toSystemTime: "2026-09-08T11:00:01" }))
  await assert.rejects(
    f.service.readJobLog({
      connectionId: "w200",
      jobName: "ZJOB",
      jobCount: "00000001",
      afterMessageNumber: 1
    })
  )
  assert.equal(f.state.calls, 0)
  assert.equal(f.state.reads, 0)
})

test("job search validates keyset order, filter, client and explicit scheduled-time scope", async (t) => {
  const f = await fixture(t)
  await f.approve()
  const first = JSON.parse(await f.service.searchJobs({ ...scope, jobName: "zjob" }))
  assert.equal(first.returnedCount, 1)
  assert.equal(first.timeField, "scheduledSystemTime")
  for (const change of [
    { client: "100" },
    { authenticatedUser: "OTHER" },
    { hasMore: true },
    { jobs: [job, job] },
    { jobs: [{ ...job, jobName: "OTHER" }] },
    { jobs: [{ ...job, scheduledSystemTime: "2026-09-07T10:00:00" }] },
    { status: "forbidden", code: "NO_AUTHORITY" }
  ]) {
    f.state.reply = JSON.stringify({ ...searchReply(), ...change })
    await assert.rejects(f.service.searchJobs({ ...scope, jobName: "ZJOB" }))
  }
  f.state.reply = JSON.stringify({
    ...searchReply(),
    status: "forbidden",
    code: "NO_AUTHORITY",
    jobs: []
  })
  assert.equal(
    JSON.parse(await f.service.searchJobs({ ...scope, jobName: "ZJOB" })).status,
    "forbidden"
  )
})

test("job diagnostic reasons are allowlisted without changing unsupported status codes", async (t) => {
  const f = await fixture(t)
  await f.approve()
  const reply = {
    ...common,
    action: "JOB_LOG",
    status: "unsupported",
    code: "READ_ONLY_UNSUPPORTED",
    reason: "TEMSE_CODEPAGE",
    job: null,
    messages: [],
    complete: true
  }
  const input = { connectionId: "w200", jobName: "ZJOB", jobCount: "00000001" }
  f.state.reply = JSON.stringify(reply)
  const result = JSON.parse(await f.service.readJobLog(input))
  assert.equal(result.reason, "TEMSE_CODEPAGE")
  assert.equal(result.code, "READ_ONLY_UNSUPPORTED")
  for (const change of [{ reason: "password=secret" }, { status: "ok", code: "OK" }]) {
    f.state.reply = JSON.stringify({ ...reply, ...change })
    await assert.rejects(f.service.readJobLog(input), /RESPONSE_INVALID/)
  }
})

test("job messages hash the bounded complete read, redact text and reject changed continuation", async (t) => {
  const f = await fixture(t)
  await f.approve()
  const reply = {
    ...common,
    action: "JOB_LOG",
    job,
    messages: [message(1), message(2)],
    complete: true
  }
  f.state.reply = JSON.stringify(reply)
  const input = { connectionId: "w200", jobName: "ZJOB", jobCount: "00000001", maxMessages: 1 }
  const first = JSON.parse(await f.service.readJobLog(input))
  assert.equal(first.nextAfterMessageNumber, 1)
  assert.doesNotMatch(JSON.stringify(first), /secret/)
  const next = { ...input, afterMessageNumber: 1, expectedRevision: first.revision }
  assert.equal(JSON.parse(await f.service.readJobLog(next)).messages[0].number, 2)
  f.state.reply = JSON.stringify({ ...reply, messages: [message(1)] })
  assert.equal(JSON.parse(await f.service.readJobLog(next)).code, "LOG_CHANGED")
  f.state.reply = JSON.stringify({ ...reply, messages: [message(2)] })
  await assert.rejects(f.service.readJobLog(input), /MESSAGE_ORDER/)
})

test("job logs preserve boundary-length Unicode text and truncation flags and reject oversized text", async (t) => {
  const f = await fixture(t)
  await f.approve()
  const input = { connectionId: "w200", jobName: "ZJOB", jobCount: "00000001" }
  const reply = { ...common, action: "JOB_LOG", job, complete: true }
  for (const length of [4095, 4096]) {
    const text = "\u4e2d".repeat(length - 1) + "\u7ec8"
    for (const textTruncated of [false, true]) {
      f.state.reply = JSON.stringify({
        ...reply,
        messages: [{ ...message(1), text, textTruncated }]
      })
      const result = JSON.parse(await f.service.readJobLog(input))
      assert.equal(result.messages[0].text, text)
      assert.equal(result.messages[0].textTruncated, textTruncated)
    }
  }
  f.state.reply = JSON.stringify({
    ...reply,
    messages: [{ ...message(1), text: "\u4e2d".repeat(4097) }]
  })
  await assert.rejects(f.service.readJobLog(input), /RESPONSE_INVALID/)
})

test("system logs preserve boundary-length Unicode text and truncation flags and reject oversized text", async (t) => {
  const f = await fixture(t)
  await f.approve()
  const reply = systemReply()
  for (const length of [4095, 4096]) {
    const text = "\u4e2d".repeat(length - 1) + "\u7ec8"
    for (const textTruncated of [false, true]) {
      f.state.reply = JSON.stringify({
        ...reply,
        entries: [{ ...reply.entries[0], text, textTruncated }]
      })
      const result = JSON.parse(await f.service.readSystem(scope))
      assert.equal(result.entries[0].text, text)
      assert.equal(result.entries[0].textTruncated, textTruncated)
      assert.equal(result.entries[0].textUnavailable, false)
      assert.equal(result.coverage, "local_instance_bounded_tail")
      assert.equal(result.truncated, true)
    }
  }
  f.state.reply = JSON.stringify({
    ...reply,
    entries: [{ ...reply.entries[0], text: "\u4e2d".repeat(4097) }]
  })
  await assert.rejects(f.service.readSystem(scope), /RESPONSE_INVALID/)
})

test("system log responses preserve incomplete tail coverage and reject scope or privacy leaks", async (t) => {
  const f = await fixture(t)
  await f.approve()
  f.state.reply = JSON.stringify(systemReply())
  const result = JSON.parse(await f.service.readSystem(scope))
  assert.equal(result.coverage, "local_instance_bounded_tail")
  assert.equal(result.truncated, true)
  assert.doesNotMatch(JSON.stringify(result), /secret/)
  for (const change of [
    { entries: [{ ...systemReply().entries[0], type: "p" }] },
    { entries: [{ ...systemReply().entries[0], client: "100" }] },
    { entries: [{ ...systemReply().entries[0], server: "another" }] },
    { entries: [{ ...systemReply().entries[0], textUnavailable: true }] },
    { entries: [...systemReply().entries, ...systemReply().entries] },
    { scannedRecords: 0 },
    { coverage: "all_instances" },
    { raw: "secret" }
  ]) {
    f.state.reply = JSON.stringify({ ...systemReply(), ...change })
    await assert.rejects(f.service.readSystem(scope))
  }
})
