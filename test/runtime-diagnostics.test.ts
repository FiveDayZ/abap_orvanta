import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { startHttpServer } from "../src/http.js"
import {
  buildRuntimeDiagnosticReport as report,
  parseRuntimeDump,
  validateRuntimeDiagnosticInput
} from "../src/runtime-diagnostics.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"
import type { DumpInfo } from "../src/backend.js"

// Synthetic fixture follows the section IDs and table layout observed on ECC.
function sample(id = "dump-1", time = "2026-09-07 16:47:19"): DumpInfo {
  return {
    id,
    errorType: "SYNTAX_ERROR",
    text: `<h4 id="HEADER">Header</h4><TABLE>
    <TR><TD>Program</TD><TD>SAPLZEXAMPLE</TD></TR>
    <TR><TD>Runtime Error</TD><TD>SYNTAX_ERROR</TD></TR>
    <TR><TD>Date/Time</TD><TD>${time} (System)</TD></TR>
    <TR><TD>User</TD><TD>TESTER</TD></TR>
    <TR><TD>Client</TD><TD>200</TD></TR></TABLE>
    <h4 id="ERROR">Analysis</h4>Missing&nbsp;ENDFUNCTION<br>password="private-value"
    <script>untrustedScript()</script><style>hidden-value</style>
    <h4 id="TERMINATION">Termination</h4>SOAP framework
    <h4 id="SOURCE">Source</h4><TABLE><TR><TD>&gt;&gt;&gt;&gt;&gt;</TD><TD>token=source-secret</TD></TR></TABLE>
    <h4 id="STACK">Calls</h4><TABLE><TR><TH>No.</TH><TH>Event</TH><TH>Program</TH><TH>Include</TH><TH>Line</TH></TR>
    ${Array.from({ length: 8 }, (_, index) => `<TR><TD><a href="adt://GR2/sap/bc/adt/programs/includes/soapimpl/source/main?context=x">${8 - index}</a></TD><TD>PREPARE_CALL</TD><TD>SAPFRAMEWORK</TD><TD>SOAPIMPL</TD><TD>${601 - index}</TD></TR>`).join("")}
    </TABLE>`
  }
}

test("ST22 parses ECC tables, entities, stack and safe source references without leaking raw HTML", () => {
  const result = parseRuntimeDump(sample(), "w200")
  assert.equal(result.program, "SAPLZEXAMPLE")
  assert.equal(result.systemTime, "2026-09-07T16:47:19")
  assert.equal(result.callStack.length, 8)
  assert.equal(result.callStack[0]?.line, 601)
  assert.equal(
    result.callStack[0]?.sourceUri,
    "adt://w200/sap/bc/adt/programs/includes/soapimpl/source/main"
  )
  assert.equal(result.source, undefined)
  assert.match(result.errorAnalysis, /Missing ENDFUNCTION/)
  assert.doesNotMatch(
    JSON.stringify(result),
    /private-value|untrustedScript|hidden-value|source-secret/
  )
  const source = parseRuntimeDump(sample(), "w200", true).source!
  assert.equal(source[0]?.terminationPoint, true)
  assert.equal(source[0]?.line, null)
  assert.equal(source[0]?.text, "token=[REDACTED]")
})

test("ST22 supports Chinese labels and treats external links as non-navigable evidence", () => {
  const dump = sample()
  dump.text = dump.text
    .replace("Program", "程序")
    .replace("Runtime Error", "运行时错误")
    .replace("Date/Time", "日期/时间")
    .replace("Missing&nbsp;ENDFUNCTION", "嵌套错误")
    .replaceAll("adt://GR2", "https://untrusted.invalid")
  const result = parseRuntimeDump(dump, "w200")
  assert.match(result.errorAnalysis, /嵌套错误/)
  assert.ok(result.callStack.every((frame) => frame.sourceUri === null))
})

test("ST22 differentiates unavailable, empty feed and malformed/login documents", () => {
  assert.equal(
    report({ connectionId: "w200" }, { available: false, dumps: [] }).status,
    "unavailable"
  )
  const empty = report({ connectionId: "w200" }, { available: true, dumps: [] })
  assert.equal(empty.status, "ok")
  assert.equal(empty.qualityGate, "not_evaluated")
  for (const html of ["", "<form>Password</form>", "<h4 id=HEADER>incomplete</h4>"]) {
    const result = report(
      { connectionId: "w200" },
      { available: true, dumps: [{ ...sample(), text: html }] }
    )
    assert.equal(result.status, "partial")
    assert.equal(result.parsedCount, 0)
    assert.equal(result.parseFailures[0]?.reason, "UNRECOGNIZED_DUMP_HEADER")
  }
})

test("ST22 groups recurring errors without discarding occurrences and filters before limiting", () => {
  const feed = { available: true, dumps: [sample("old", "2026-09-07 16:47:10"), sample("new")] }
  const all = report({ connectionId: "W200", maxResults: 1 }, feed)
  assert.equal(all.connectionId, "w200")
  assert.equal(all.matchedCount, 2)
  assert.equal(all.dumps[0]?.dumpId, "new")
  assert.equal(all.truncated, true)
  assert.equal(all.groups[0]?.count, 2)
  const filtered = report(
    {
      connectionId: "w200",
      program: "soapimpl",
      username: "tester",
      errorType: "syntax_error",
      fromSystemTime: "2026-09-07T16:47:19",
      toSystemTime: "2026-09-07T16:47:19"
    },
    feed
  )
  assert.equal(filtered.matchedCount, 1)
  assert.equal(report({ connectionId: "w200", program: "SAPLZ" }, feed).matchedCount, 0)
  assert.equal(report({ connectionId: "w200", dumpId: "missing" }, feed).dumpIdFoundInFeed, false)
})

test("ST22 validates time ranges, calendar dates, offsets and connection IDs before backend access", async () => {
  for (const invalid of [
    { fromSystemTime: "2026-02-30T00:00:00" },
    { fromSystemTime: "2026-09-08T00:00:00", toSystemTime: "2026-09-07T00:00:00" },
    { systemUtcOffset: "+14:01" },
    { systemUtcOffset: "+15:00" },
    { connectionId: "w200/other" },
    { maxResults: 51 }
  ])
    assert.throws(() => validateRuntimeDiagnosticInput({ connectionId: "w200", ...invalid }))
  const backend = new MockBackend()
  let reads = 0
  backend.listDumps = async () => {
    reads++
    return { available: true, dumps: [sample()] }
  }
  const tools = new ToolService(backend)
  await assert.rejects(
    tools.diagnoseSapFailure({ connectionId: "w200", operationId: "unknown" }),
    /receipt not found/
  )
  await assert.rejects(tools.diagnoseSapFailure({ connectionId: "w200", maxResults: 0 }))
  assert.equal(reads, 0)
})

test("ST22 correlation requires explicit timezone and remains non-causal", () => {
  const input = { connectionId: "w200", operationId: "op-1" }
  const feed = { available: true, dumps: [sample()] }
  const receipt = {
    status: "failed",
    toolName: "test_remote_function_module",
    startedAt: "2026-09-07T08:47:18Z",
    finishedAt: "2026-09-07T08:47:20Z"
  }
  const unknown = report(input, feed, receipt)
  assert.equal(unknown.correlation?.[0]?.withinTimeWindow, null)
  const known = report(
    { ...input, systemUtcOffset: "+08:00", correlationWindowSeconds: 0 },
    feed,
    receipt
  )
  assert.equal(known.correlation?.[0]?.candidate, true)
  assert.equal(known.correlation?.[0]?.causalRelationship, "not_proven")
  assert.equal(
    report({ ...input, systemUtcOffset: "+00:00" }, feed, receipt).correlation?.[0]?.candidate,
    false
  )
  assert.equal(
    report({ ...input, systemUtcOffset: "+08:00" }, feed, { ...receipt, finishedAt: undefined })
      .correlation?.[0]?.withinTimeWindow,
    null
  )
  assert.throws(() => report(input, feed, { status: "not_found" }), /receipt not found/)
})

test("ST22 bounds document and feed parsing and marks incomplete evidence", () => {
  const oversized = { ...sample(), text: "x".repeat(256 * 1024 + 1) }
  assert.equal(
    report({ connectionId: "w200" }, { available: true, dumps: [oversized] }).parseFailures[0]
      ?.reason,
    "DUMP_DOCUMENT_TOO_LARGE"
  )
  const many = Array.from({ length: 501 }, (_, i) => ({ ...sample(String(i)), text: "" }))
  const bounded = report({ connectionId: "w200" }, { available: true, dumps: many })
  assert.equal(bounded.inspectedCount, 500)
  assert.equal(bounded.truncated, true)
  const total = report(
    { connectionId: "w200" },
    {
      available: true,
      dumps: Array.from({ length: 40 }, (_, i) => ({
        ...sample(String(i)),
        text: "x".repeat(256 * 1024)
      }))
    }
  )
  assert.equal(total.inspectedCount, 32)
  assert.ok(total.warnings.includes("TOTAL_PARSE_BYTE_LIMIT"))
})

test("ST22 MCP protocol returns structured diagnostics and rejects unknown receipts without SAP reads", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "orvanta-diagnostics-"))
  const backend = new MockBackend()
  let reads = 0
  backend.listDumps = async () => {
    reads++
    return { available: true, dumps: [sample()] }
  }
  const running = await startHttpServer(backend, 0, stateRoot)
  const client = new Client({ name: "diagnostic-test", version: "1" })
  try {
    const transport = new StreamableHTTPClientTransport(new URL(running.mcpUrl))
    await client.connect(transport as Parameters<Client["connect"]>[0])
    const tool = (await client.listTools()).tools.find(
      (item) => item.name === "diagnose_sap_failure"
    )
    assert.equal(tool?.annotations?.readOnlyHint, true)
    const result = await client.callTool({
      name: "diagnose_sap_failure",
      arguments: { connectionId: "w200" }
    })
    assert.equal(result.isError, undefined)
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text)
    assert.equal(parsed.dumps[0].callStack.length, 8)
    assert.equal(parsed.readOnly, true)
    assert.equal(reads, 1)
    const failed = await client.callTool({
      name: "diagnose_sap_failure",
      arguments: { connectionId: "w200", operationId: "missing" }
    })
    assert.equal(failed.isError, true)
    assert.equal(reads, 1)
  } finally {
    await client.close()
    await running.close()
    await rm(stateRoot, { recursive: true, force: true })
  }
})
