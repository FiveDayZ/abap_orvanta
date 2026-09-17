import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { z } from "zod"
import { toolContracts } from "../src/contracts.js"
import { startHttpServer } from "../src/http.js"
import {
  formatSciV2Result,
  sciTargetSchema,
  SCI_V2_HELPER,
  SCI_V2_FINGERPRINT
} from "../src/sci-v2.js"
import { type SciInput } from "../src/sci.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"

const input: SciInput = {
  connectionId: "w200",
  action: "run",
  target: { objectType: "PROG", objectName: "ZCODEX_MCP_DYNPRO" },
  acknowledgePotentialSideEffects: true
}
const finding = {
  TYPE: "W",
  NUMBER: "000",
  MESSAGE: "Critical statement",
  MESSAGE_V1: "CL_CI_TEST_CRITICAL_STATEMENTS",
  MESSAGE_V2: "0011",
  MESSAGE_V3: "ZCODEX_MCP_DYNPRO",
  MESSAGE_V4: "6",
  ROW: "14",
  FIELD: ""
}
function response(count = 1) {
  return {
    outputs: {
      EV_STATUS: "W",
      EV_CODE:
        count === 0
          ? "NO_FINDINGS_UNVERIFIED"
          : count > 1000
            ? "TRUNCATED_LIMITED"
            : "FINDINGS_LIMITED",
      EV_ENGINE: "SCI",
      EV_VERSION: "2.0",
      EV_VARIANT: "SYNTAX_CRITICAL_V1",
      EV_COUNT: String(count),
      EV_OBJTYPE: "PROG",
      EV_OBJNAME: "ZCODEX_MCP_DYNPRO",
      EV_PROGRAM: "ZCODEX_MCP_DYNPRO",
      EV_PACKAGE: "ZABAP",
      EV_SYNTAX: "001",
      EV_CRITICAL: "002"
    },
    tableOutputs: {
      ET_RESULTS: Array.from({ length: Math.min(count, 1000) }, () => ({ ...finding }))
    }
  }
}

test("SCI E1 contract accepts explicit main-object targets and preserves legacy input", () => {
  const schema = z.object(toolContracts.run_sci_analysis.inputSchema)
  assert.ok(schema.safeParse(input).success)
  assert.ok(schema.safeParse({ ...input, target: undefined }).success)
  for (const objectType of ["PROG", "CLAS", "FUGR"]) {
    assert.ok(sciTargetSchema.safeParse({ objectType, objectName: "Z_OBJECT" }).success)
  }
  for (const target of [
    null,
    {},
    { objectType: "FUNC", objectName: "Z_FM" },
    { objectType: "DEVC", objectName: "ZABAP" },
    { objectType: "PROG", objectName: "SAPLTEST" },
    { objectType: "PROG", objectName: "Z*" },
    { objectType: "PROG", objectName: "Z_A Z_B" },
    { objectType: "PROG", objectName: "z_test" },
    { objectType: "PROG", objectName: "Z".repeat(41) },
    { objectType: "CLAS", objectName: "Z".repeat(31) },
    { objectType: "FUGR", objectName: "Z_CORE", includeRelated: true }
  ])
    assert.equal(schema.safeParse({ ...input, target }).success, false)
})

test("SCI E1 precheck attests identity and applicability, not rule execution", () => {
  const raw = response(0)
  raw.outputs.EV_STATUS = "S"
  raw.outputs.EV_CODE = "PREFLIGHT_ONLY"
  const result = JSON.parse(formatSciV2Result(raw, { ...input, action: "precheck" }))
  assert.equal(result.execution, "not_run")
  assert.deepEqual(result.requestedTarget, input.target)
  assert.equal(result.scope.packageName, "ZABAP")
  assert.equal(result.totalFindings, undefined)
  assert.equal(result.selectedRules.length, 2)
  assert.equal(result.selectedRules[0].version, "001")
  assert.equal(result.selectedRules[1].version, "002")
  assert.ok(
    result.selectedRules.every((rule: { completion: string }) => rule.completion === "not_run")
  )
  assert.equal(result.qualityGate, "not_evaluated")
})

test("SCI E1 reports findings, empty results and truncation without a passed gate", () => {
  for (const count of [0, 1, 1001]) {
    const result = JSON.parse(formatSciV2Result(response(count), input))
    assert.equal(result.totalFindings, count)
    assert.equal(result.returnedFindings, Math.min(count, 1000))
    assert.equal(result.truncated, count > 1000)
    assert.equal(result.qualityGate, "not_evaluated")
    assert.equal(result.nativeAtc, false)
    assert.equal(result.selectedRules[0].completion, "not_attested")
  }
  const raw = response()
  raw.tableOutputs.ET_RESULTS[0]!.FIELD = "TEXT_TRUNCATED"
  assert.equal(JSON.parse(formatSciV2Result(raw, input)).truncated, true)
})

test("SCI E1 rejects mismatched identity, versions, execution state and malformed findings", () => {
  for (const change of [
    { EV_OBJTYPE: "FUGR" },
    { EV_OBJNAME: "Z_OTHER" },
    { EV_PROGRAM: "Z_OTHER" },
    { EV_PACKAGE: "" },
    { EV_SYNTAX: "002" },
    { EV_CRITICAL: "001" },
    { EV_VERSION: "1.0" },
    { EV_COUNT: "2" },
    { EV_STATUS: "S" },
    { EV_CODE: "PASSED" }
  ]) {
    const raw = response()
    Object.assign(raw.outputs, change)
    assert.throws(() => formatSciV2Result(raw, input))
  }
  for (const change of [
    { TYPE: "S" },
    { ROW: "-1" },
    { MESSAGE_V4: "bad" },
    { MESSAGE_V1: "CL_CI_TEST_OTHER" },
    { FIELD: "UNKNOWN" },
    { ROW: "9007199254740993" }
  ]) {
    const raw = response()
    Object.assign(raw.tableOutputs.ET_RESULTS[0]!, change)
    assert.throws(() => formatSciV2Result(raw, input))
  }
  assert.throws(() => formatSciV2Result(response(), { ...input, action: "precheck" }))
  const error = response(0)
  Object.assign(error.outputs, { EV_STATUS: "E", EV_CODE: "NOT_MAIN_PROGRAM", EV_OBJNAME: "" })
  assert.throws(() => formatSciV2Result(error, input), /NOT_MAIN_PROGRAM/)
})

test("SCI E1 routes only explicit targets to the pinned V2 helper and never retries", async () => {
  class RecordingTools extends ToolService {
    calls: Parameters<ToolService["testRemoteFunctionModule"]>[0][] = []
    fail = false
    override async testRemoteFunctionModule(
      args: Parameters<ToolService["testRemoteFunctionModule"]>[0]
    ) {
      this.calls.push(args)
      if (this.fail) throw new Error("Timeout; outcome unknown")
      return JSON.stringify(response())
    }
  }
  const tools = new RecordingTools(new MockBackend())
  await tools.runSciAnalysis(input)
  assert.equal(tools.calls[0]?.functionName, SCI_V2_HELPER)
  assert.equal(tools.calls[0]?.expectedInterfaceFingerprint, SCI_V2_FINGERPRINT)
  assert.deepEqual(tools.calls[0]?.inputParameters, {
    IV_ACTION: "RUN",
    IV_OBJECT_TYPE: "PROG",
    IV_OBJECT_NAME: "ZCODEX_MCP_DYNPRO"
  })
  await assert.rejects(
    tools.runSciAnalysis({ ...input, target: { objectType: "FUNC", objectName: "Z_FM" } as never })
  )
  assert.equal(tools.calls.length, 1)
  tools.fail = true
  await assert.rejects(tools.runSciAnalysis(input), /Timeout/)
  assert.equal(tools.calls.length, 2)
})

test("SCI E1 rejects missing helpers and unapproved calls before SAP execution", async () => {
  const tools = new ToolService(new MockBackend())
  await assert.rejects(
    tools.runSciAnalysis({ ...input, acknowledgePotentialSideEffects: false as never }),
    /acknowledgePotentialSideEffects/
  )
  await assert.rejects(tools.runSciAnalysis(input), /FUNCTION_NOT_FOUND/)
})

test("SCI E1 HTTP tool exposes target and routes it to V2 without silently using V1", async () => {
  class RecordingBackend extends MockBackend {
    objects: string[] = []
    override callSapRepository(
      connectionId: string,
      request: Parameters<MockBackend["callSapRepository"]>[1]
    ) {
      if (request.objectName) this.objects.push(request.objectName)
      return super.callSapRepository(connectionId, request)
    }
  }
  const backend = new RecordingBackend()
  const stateRoot = await mkdtemp(join(tmpdir(), "sci-e1-protocol-"))
  const server = await startHttpServer(backend, 0, stateRoot)
  const client = new Client({ name: "sci-e1-protocol", version: "1" })
  try {
    const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl))
    await client.connect(transport as Parameters<Client["connect"]>[0])
    const contract = (await client.listTools()).tools.find(
      (tool) => tool.name === "run_sci_analysis"
    )
    assert.ok(contract?.inputSchema.properties?.target)
    const result = await client.callTool({ name: "run_sci_analysis", arguments: { ...input } })
    assert.equal(result.isError, true)
    assert.ok(backend.objects.includes(SCI_V2_HELPER))
    assert.ok(!backend.objects.includes("Z_ORVANTA_MCP_SCI_API"))
    const count = backend.objects.length
    const invalid = await client.callTool({
      name: "run_sci_analysis",
      arguments: { ...input, target: { objectType: "PROG", objectName: "SAPMSSY0" } }
    })
    assert.equal(invalid.isError, true)
    assert.equal(backend.objects.length, count)
    assert.ok(contract?.inputSchema.properties?.profile)
    const missingTarget = await client.callTool({
      name: "run_sci_analysis",
      arguments: { ...input, target: undefined, profile: "syntax_critical_sql" }
    })
    assert.equal(missingTarget.isError, true)
    assert.equal(backend.objects.length, count)
    const extended = await client.callTool({
      name: "run_sci_analysis",
      arguments: { ...input, profile: "syntax_critical_sql" }
    })
    assert.equal(extended.isError, true)
    assert.ok(backend.objects.slice(count).includes("Z_ORVANTA_MCP_SCI_E2"))
    assert.ok(!backend.objects.slice(count).includes(SCI_V2_HELPER))
  } finally {
    await client.close()
    await server.close()
    await rm(stateRoot, { recursive: true, force: true })
  }
})
