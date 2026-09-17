import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { checkQuality } from "../src/quality-checks.js"
import { startHttpServer } from "../src/http.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"

const uri = "adt://w200/sap/bc/adt/oo/classes/zcl_demo"
const otherUri = "adt://w200/sap/bc/adt/programs/programs/zdemo"
const input = { connectionId: "w200", fileUris: [uri] }

test("quality syntax default does not execute ATC or Unit and never passes a gate", async () => {
  const backend = new MockBackend()
  backend.diagnostics = async () => []
  backend.runAtc = async () => {
    throw new Error("ATC must not execute")
  }
  backend.runUnitTests = async () => {
    throw new Error("Unit must not execute")
  }
  const result = await checkQuality(backend, input)
  assert.equal(result.status, "completed")
  assert.equal(result.qualityGate, "not_evaluated")
  assert.ok(result.results[0]?.syntax.status === "completed")
  assert.equal(result.results[0]?.syntax.findingCount, 0)
  assert.equal(result.results[0]?.atc.status, "not_requested")
  assert.equal(result.sci.status, "not_executed")
})

test("quality keeps native ATC provenance, raw findings and documentation references", async () => {
  const backend = new MockBackend()
  const result = await checkQuality(backend, {
    ...input,
    includeAtc: true,
    acknowledgePotentialSideEffects: true
  })
  assert.ok(result.results[0]?.atc.status === "completed")
  assert.ok(result.results[0]?.syntax.status === "completed")
  assert.equal(result.results[0]?.atc.variant, "DEFAULT")
  assert.equal(result.results[0]?.atc.findings?.[0]?.docUri, "/sap/bc/adt/atc/doc/mock")
  assert.equal(result.results[0]?.syntax.findings?.[0]?.severity, "W")
  assert.equal(result.qualityGate, "not_evaluated")
})

test("quality unsupported ATC does not discard syntax or substitute SCI", async () => {
  const backend = new MockBackend()
  backend.runAtc = async () => {
    throw new Error("atc capability unsupported-endpoint (HTTP 404): missing")
  }
  const result = await checkQuality(backend, {
    ...input,
    includeAtc: true,
    acknowledgePotentialSideEffects: true
  })
  assert.equal(result.status, "partial")
  assert.equal(result.results[0]?.syntax.status, "completed")
  assert.equal(result.results[0]?.atc.status, "unavailable")
  assert.equal(result.sci.status, "not_executed")
})

test("quality preserves incomplete, complete and unknown ATC object-set evidence", async () => {
  for (const complete of [false, true, undefined]) {
    const backend = new MockBackend()
    backend.runAtc = async () => ({
      variant: "DEFAULT",
      findings: [],
      ...(complete === undefined
        ? {}
        : { execution: { objectSetIsComplete: complete, requestedMaximumVerdicts: 100 } })
    })
    const result = await checkQuality(backend, {
      ...input,
      includeAtc: true,
      maxFindings: 200,
      acknowledgePotentialSideEffects: true
    })
    const atc = result.results[0]!.atc
    assert.ok(atc.status === "partial" || atc.status === "completed")
    assert.equal(result.status, complete === false ? "partial" : "completed")
    assert.equal(atc.status, complete === false ? "partial" : "completed")
    assert.equal(
      atc.coverage.objectSet,
      complete === undefined ? "unknown" : complete ? "complete" : "incomplete"
    )
    assert.equal(atc.coverage.requestedMaximumVerdicts, complete === undefined ? null : 100)
    assert.equal(atc.coverage.serverTruncation, "unknown")
    assert.equal(atc.coverage.findingCountScope, "retrieved_findings")
    assert.equal(atc.coverage.perRuleExecution, "not_verified")
    assert.equal(atc.findingCount, 0)
    assert.equal(atc.truncated, false)
    assert.equal(result.qualityGate, "not_evaluated")
  }
})

test("quality failed syntax does not stop later objects or an independent ATC check", async () => {
  const backend = new MockBackend()
  let calls = 0
  backend.diagnostics = async () => {
    if (++calls === 1)
      throw new Error(
        "syntax-diagnostics capability forbidden-or-not-authorized (HTTP 403): denied"
      )
    return []
  }
  const result = await checkQuality(backend, {
    ...input,
    fileUris: [uri, otherUri],
    includeAtc: true,
    acknowledgePotentialSideEffects: true
  })
  assert.equal(calls, 2)
  assert.equal(result.status, "partial")
  assert.equal(result.results[0]?.syntax.status, "failed")
  assert.equal(result.results[0]?.atc.status, "completed")
  assert.equal(result.results[1]?.syntax.status, "completed")
})

test("quality reports truncation without changing total finding counts", async () => {
  const backend = new MockBackend()
  const diagnostics = await backend.diagnostics()
  const atc = await backend.runAtc()
  backend.diagnostics = async () => [...diagnostics, ...diagnostics]
  backend.runAtc = async () => ({ ...atc, findings: [...atc.findings, ...atc.findings] })
  const result = await checkQuality(backend, {
    ...input,
    maxFindings: 1,
    includeAtc: true,
    acknowledgePotentialSideEffects: true
  })
  for (const engine of [result.results[0]!.syntax, result.results[0]!.atc]) {
    assert.ok(engine.status === "completed")
    assert.equal(engine.findingCount, 2)
    assert.equal(engine.findings?.length, 1)
    assert.equal(engine.truncated, true)
  }
})

test("quality validates the entire batch before any SAP request", async () => {
  const backend = new MockBackend()
  let calls = 0
  backend.diagnostics = async () => {
    calls++
    return []
  }
  const invalid = [
    "adt://w201/sap/bc/adt/oo/classes/zcl_demo",
    "http://w200/sap/bc/adt/oo/classes/zcl_demo",
    `${uri}?scope=package`,
    `${uri}#main`,
    uri.replace("w200", "user:password@w200"),
    uri.replace("w200", "w200:8000"),
    uri.replace("zcl_demo", "%2e%2e"),
    uri.replace("zcl_demo", "../zcl_demo"),
    "adt://w200/sap/bc/adt/packages/zabap",
    "adt://w200/sap/bc/adt/functions/groups/zorvanta_mcp_core"
  ]
  for (const target of invalid) {
    await assert.rejects(checkQuality(backend, { ...input, fileUris: [uri, target] }))
  }
  for (const extra of [
    { fileUris: [] },
    { fileUris: Array(11).fill(uri) },
    { fileUris: [uri, `${uri}/source/main`] },
    { fileUris: [uri, uri.toUpperCase()] },
    { maxFindings: 0 },
    { maxFindings: 201 },
    { maxFindings: 1.5 },
    { includeAtc: true }
  ]) {
    await assert.rejects(checkQuality(backend, { ...input, ...extra }))
  }
  assert.equal(calls, 0)
})

test("quality transport errors remain failed and messages redact known secrets", async () => {
  const backend = new MockBackend()
  backend.diagnostics = async () => {
    throw new Error("connection failed password=secret123")
  }
  const result = await checkQuality(backend, input)
  assert.equal(result.results[0]?.syntax.status, "failed")
  assert.ok(result.results[0]?.syntax.status === "failed")
  assert.doesNotMatch(result.results[0]?.syntax.message ?? "", /secret123/)
})

test("quality accepts exact function-module and include URIs without expanding a function group", async () => {
  const targets = [
    "adt://w200/sap/bc/adt/functions/groups/zorvanta_mcp_core/fmodules/z_orvanta_mcp_sci_api",
    "adt://w200/sap/bc/adt/functions/groups/zorvanta_mcp_core/includes/lzorvanta_mcp_coretop"
  ]
  const calls: string[] = []
  const result = await checkQuality(
    {
      diagnostics: async (_connection, target) => {
        calls.push(target)
        return []
      },
      runAtc: async () => {
        throw new Error("not requested")
      }
    },
    { ...input, fileUris: targets }
  )
  assert.deepEqual(calls, targets)
  assert.equal(result.status, "completed")
})

test("quality action rejects conflicting legacy scopes and preserves old ATC output", async () => {
  const tools = new ToolService(new MockBackend())
  await assert.rejects(
    tools.runAtcAnalysis({ ...input, action: "check_quality", scope: "package" })
  )
  await assert.rejects(
    tools.runAtcAnalysis({ ...input, action: "check_quality", objectName: "ZCL_DEMO" })
  )
  assert.match(
    await tools.runAtcAnalysis({
      connectionId: "w200",
      objectUri: uri
    }),
    /Mock ATC finding/
  )
  const result = JSON.parse(await tools.runAtcAnalysis({ ...input, action: "check_quality" }))
  assert.equal(result.qualityGate, "not_evaluated")
})

test("quality action is available through MCP and rejects excessive batch size", async () => {
  const state = await mkdtemp(join(tmpdir(), "abap-quality-test-"))
  const backend = new MockBackend()
  backend.runAtc = async () => ({
    variant: "DEFAULT",
    findings: [],
    execution: { objectSetIsComplete: false, requestedMaximumVerdicts: 100 }
  })
  const running = await startHttpServer(backend, 0, state)
  const client = new Client({ name: "quality-test", version: "1" })
  try {
    const transport = new StreamableHTTPClientTransport(new URL(running.mcpUrl))
    await client.connect(transport as Parameters<Client["connect"]>[0])
    const result = await client.callTool({
      name: "run_atc_analysis",
      arguments: { ...input, action: "check_quality" }
    })
    assert.equal(result.isError, undefined)
    const content = result.content as { type: string; text: string }[]
    assert.equal(JSON.parse(content[0]!.text).results[0].syntax.status, "completed")
    const precheck = await client.callTool({
      name: "run_atc_analysis",
      arguments: { action: "precheck_atc", connectionId: "w200" }
    })
    assert.equal(precheck.isError, undefined)
    const metadata = JSON.parse((precheck.content as { text: string }[])[0]!.text)
    assert.equal(metadata.status, "metadata_available")
    assert.equal(metadata.runCreationAttempted, false)
    assert.equal(metadata.variantValidated, false)
    const incomplete = await client.callTool({
      name: "run_atc_analysis",
      arguments: {
        ...input,
        action: "check_quality",
        includeAtc: true,
        acknowledgePotentialSideEffects: true
      }
    })
    assert.equal(incomplete.isError, undefined)
    const report = JSON.parse((incomplete.content as { text: string }[])[0]!.text)
    assert.equal(report.status, "partial")
    assert.equal(report.results[0].syntax.status, "completed")
    assert.equal(report.results[0].atc.coverage.objectSet, "incomplete")
    assert.equal(report.results[0].atc.coverage.requestedMaximumVerdicts, 100)
    assert.equal(report.qualityGate, "not_evaluated")
    const invalid = await client.callTool({
      name: "run_atc_analysis",
      arguments: { ...input, action: "check_quality", fileUris: Array(11).fill(uri) }
    })
    assert.equal(invalid.isError, true)
  } finally {
    await client.close()
    await running.close()
    await rm(state, { recursive: true, force: true })
  }
})
