import assert from "node:assert/strict"
import test from "node:test"
import { formatSciResult, SCI_HELPER, SCI_HELPER_FINGERPRINT } from "../src/sci.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"

const input = {
  connectionId: "w200",
  action: "run" as const,
  acknowledgePotentialSideEffects: true as const
}
const finding = {
  TYPE: "W",
  NUMBER: "000",
  MESSAGE: "Critical statement",
  MESSAGE_V1: "CL_CI_TEST_CRITICAL_STATEMENTS",
  MESSAGE_V2: "0011",
  MESSAGE_V3: "LZORVANTA_MCP_COREU02",
  MESSAGE_V4: "0006",
  ROW: "816",
  FIELD: ""
}
function response(rows = [finding], code = "FINDINGS_LIMITED", count = rows.length) {
  return {
    outputs: {
      EV_STATUS: "W",
      EV_CODE: code,
      EV_ENGINE: "SCI",
      EV_VERSION: "1.0",
      EV_SCOPE: "ZORVANTA_MCP_CORE",
      EV_VARIANT: "SYNTAX_CRITICAL_V1",
      EV_COUNT: String(count)
    },
    tableOutputs: { ET_RESULTS: rows }
  }
}

test("SCI findings preserve positions and never claim native ATC or a passed gate", () => {
  const result = JSON.parse(formatSciResult(response(), input))
  assert.equal(result.engine, "SCI")
  assert.equal(result.nativeAtc, false)
  assert.equal(result.qualityGate, "not_evaluated")
  assert.equal(result.coverage, "limited")
  assert.equal(result.execution, "returned")
  assert.equal(result.totalFindings, 1)
  assert.equal(result.findings[0].line, 816)
  assert.equal(result.findings[0].column, 6)
  assert.equal(result.findings[0].severity, "W")
  assert.equal(result.truncated, false)
  assert.equal(result.helperFingerprint, SCI_HELPER_FINGERPRINT)
})

test("SCI empty findings do not become a passed quality gate", () => {
  const result = JSON.parse(formatSciResult(response([], "NO_FINDINGS_UNVERIFIED"), input))
  assert.equal(result.totalFindings, 0)
  assert.equal(result.qualityGate, "not_evaluated")
  assert.equal(result.code, "NO_FINDINGS_UNVERIFIED")
})

test("SCI precheck separates configured rules from execution and findings", () => {
  const raw = response()
  Object.assign(raw.outputs, {
    EV_STATUS: "S",
    EV_CODE: "PREFLIGHT_ONLY",
    EV_VARIANT: "DEFAULT"
  })
  const result = JSON.parse(formatSciResult(raw, { ...input, action: "precheck" }))
  assert.equal(result.execution, "not_run")
  assert.equal(result.configuredRules.length, 1)
  assert.equal(result.totalFindings, undefined)
  assert.deepEqual(result.findings, [])
  assert.equal(result.qualityGate, "not_evaluated")
})

test("SCI row and text truncation are explicit", () => {
  const raw = response(
    Array.from({ length: 1000 }, () => finding),
    "TRUNCATED_LIMITED",
    1001
  )
  const result = JSON.parse(formatSciResult(raw, input))
  assert.equal(result.truncated, true)
  assert.equal(result.totalFindings, 1001)
  assert.equal(result.returnedFindings, 1000)
  const textResult = JSON.parse(
    formatSciResult(response([{ ...finding, FIELD: "TEXT_TRUNCATED" }]), input)
  )
  assert.equal(textResult.truncated, true)
})

test("SCI rejects errors, inconsistent state, unknown engines, malformed and missing data", () => {
  for (const overrides of [
    { EV_STATUS: "E", EV_CODE: "SCI_RUN_FAILED" },
    { EV_STATUS: "S" },
    { EV_ENGINE: "ATC" },
    { EV_SCOPE: "OTHER" },
    { EV_SCOPE: "ZCODEX_MCP_CORE" },
    { EV_VERSION: "2.0" },
    { EV_VARIANT: "DEFAULT" },
    { EV_COUNT: "2" },
    { EV_COUNT: "-1" },
    { EV_CODE: "PASSED" }
  ]) {
    const raw = response()
    Object.assign(raw.outputs, overrides)
    assert.throws(() => formatSciResult(raw, input))
  }
  assert.throws(() => formatSciResult({}, input))
  assert.throws(() => formatSciResult(response([{ ...finding, TYPE: "S" }]), input))
  assert.throws(() => formatSciResult(response([{ ...finding, ROW: "bad" }]), input))
  assert.throws(() => formatSciResult(response([{ ...finding, MESSAGE_V4: "" }]), input))
})

test("SCI tool reuses guarded RFC execution with a pinned helper and explicit action", async () => {
  class RecordingTools extends ToolService {
    received: Parameters<ToolService["testRemoteFunctionModule"]>[0] | undefined
    override async testRemoteFunctionModule(
      args: Parameters<ToolService["testRemoteFunctionModule"]>[0]
    ) {
      this.received = args
      return JSON.stringify(response())
    }
  }
  const tools = new RecordingTools(new MockBackend())
  const result = JSON.parse(await tools.runSciAnalysis(input))
  assert.equal(result.qualityGate, "not_evaluated")
  assert.equal(tools.received?.functionName, "Z_ORVANTA_MCP_SCI_API")
  assert.equal(result.scope.objectName, "ZORVANTA_MCP_CORE")
  assert.equal(tools.received?.expectedInterfaceFingerprint, SCI_HELPER_FINGERPRINT)
  assert.deepEqual(tools.received?.inputParameters, { IV_ACTION: "RUN" })
  assert.equal(tools.received?.acknowledgePotentialSideEffects, true)
})

test("SCI tool refuses unapproved execution, a missing helper, and a mismatched helper", async () => {
  const tools = new ToolService(new MockBackend())
  await assert.rejects(
    tools.runSciAnalysis({ ...input, acknowledgePotentialSideEffects: false as never }),
    /acknowledgePotentialSideEffects/
  )
  await assert.rejects(tools.runSciAnalysis(input), /FUNCTION_READ_FAILED/)
  class WrongHelperBackend extends MockBackend {
    override callSapRepository(
      connectionId: string,
      request: Parameters<MockBackend["callSapRepository"]>[1]
    ) {
      return super.callSapRepository(connectionId, {
        ...request,
        objectName: request.objectName === SCI_HELPER ? "ZCMCP_FM_1501" : request.objectName
      })
    }
    override async callRemoteFunction(): Promise<never> {
      assert.fail("Mismatched helper must be rejected before invoking SAP")
    }
  }
  await assert.rejects(
    new ToolService(new WrongHelperBackend()).runSciAnalysis(input),
    /fingerprint changed/
  )
})
