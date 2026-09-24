import assert from "node:assert/strict"
import test from "node:test"
import { z } from "zod"
import { toolContracts } from "../src/contracts.js"
import {
  formatSciE2Result,
  formatSciV2Result,
  SCI_E2_HELPER,
  SCI_E2_FINGERPRINT
} from "../src/sci-v2.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"

const input = {
  connectionId: "w200",
  action: "run" as const,
  profile: "syntax_critical_sql" as const,
  target: { objectType: "FUGR" as const, objectName: "ZORVANTA_MCP_CORE" },
  acknowledgePotentialSideEffects: true as const
}
const finding = {
  TYPE: "W",
  NUMBER: "000",
  MESSAGE: "SELECT in LOOP/ENDLOOP",
  MESSAGE_V1: "CL_CI_TEST_SELECT_NESTED",
  MESSAGE_V2: "0002",
  MESSAGE_V3: "LZORVANTA_MCP_COREU01",
  MESSAGE_V4: "4",
  ROW: "17",
  FIELD: ""
}
function response(count = 1) {
  return {
    outputs: {
      EV_STATUS: "W",
      EV_CODE: count
        ? count > 1000
          ? "TRUNCATED_LIMITED"
          : "FINDINGS_LIMITED"
        : "NO_FINDINGS_UNVERIFIED",
      EV_ENGINE: "SCI",
      EV_VERSION: "3.0",
      EV_VARIANT: "SYNTAX_CRITICAL_SQL_V1",
      EV_COUNT: String(count),
      EV_OBJTYPE: "FUGR",
      EV_OBJNAME: "ZORVANTA_MCP_CORE",
      EV_PROGRAM: "SAPLZORVANTA_MCP_CORE",
      EV_PACKAGE: "ZABAP",
      EV_SYNTAX: "001",
      EV_CRITICAL: "002",
      EV_NESTED: "000"
    },
    tableOutputs: {
      ET_RESULTS: Array.from({ length: Math.min(count, 1000) }, () => ({ ...finding }))
    }
  }
}

test("SCI E2 keeps native code/severity/position and all three pinned rule versions", () => {
  for (const [code, severity] of [
    ["0001", "N"],
    ["0002", "W"],
    ["0003", "N"]
  ]) {
    const raw = response()
    Object.assign(raw.tableOutputs.ET_RESULTS[0]!, { TYPE: severity, MESSAGE_V2: code })
    const result = JSON.parse(formatSciE2Result(raw, input))
    assert.equal(result.helper, SCI_E2_HELPER)
    assert.equal(result.findings[0].severity, severity)
    assert.equal(result.findings[0].code, code)
    assert.equal(result.findings[0].line, 17)
    assert.equal(result.qualityGate, "not_evaluated")
    assert.equal(result.nativeAtc, false)
    assert.deepEqual(
      result.selectedRules.map((rule: { version: string }) => rule.version),
      ["001", "002", "000"]
    )
  }
})

test("SCI E2 precheck and empty/truncated results never attest rule completion", () => {
  const raw = response(0)
  Object.assign(raw.outputs, { EV_STATUS: "S", EV_CODE: "PREFLIGHT_ONLY" })
  const precheck = JSON.parse(formatSciE2Result(raw, { ...input, action: "precheck" }))
  assert.equal(precheck.execution, "not_run")
  assert.equal(precheck.selectedRules[2].completion, "not_run")
  for (const count of [0, 1001]) {
    const run = JSON.parse(formatSciE2Result(response(count), input))
    assert.equal(run.totalFindings, count)
    assert.equal(run.truncated, count > 1000)
    assert.equal(run.qualityGate, "not_evaluated")
  }
})

test("SCI E2 rejects missing/drifted rule versions and cross-profile responses", () => {
  for (const overrides of [
    { EV_NESTED: "" },
    { EV_NESTED: "001" },
    { EV_NESTED: undefined },
    { EV_VERSION: "2.0" },
    { EV_VARIANT: "SYNTAX_CRITICAL_V1" },
    { EV_COUNT: "2" }
  ]) {
    const raw = response()
    Object.assign(raw.outputs, overrides)
    assert.throws(() => formatSciE2Result(raw, input))
  }
  assert.throws(() => formatSciV2Result(response(), input))
  const v2 = response()
  Object.assign(v2.outputs, { EV_VERSION: "2.0", EV_VARIANT: "SYNTAX_CRITICAL_V1" })
  assert.throws(() => formatSciV2Result(v2, input), /invalid rule/)
})

test("SCI E2 treats scanning errors and unexpected findings as failures, even with zero rows", () => {
  for (const code of ["SCAN_FAILED", "SCAN_INCLUDE_MISSING", "RESULT_RULE_MISMATCH"]) {
    const raw = response(0)
    Object.assign(raw.outputs, { EV_STATUS: "E", EV_CODE: code })
    assert.throws(() => formatSciE2Result(raw, input), new RegExp(code))
  }
  for (const changes of [
    { MESSAGE_V2: "9999" },
    { TYPE: "N" },
    { MESSAGE: "" },
    { MESSAGE_V1: "CL_CI_TEST_FOR_ALL_ENTRIES" },
    { MESSAGE_V1: "CL_CI_TEST_SCAN" }
  ]) {
    const raw = response()
    Object.assign(raw.tableOutputs.ET_RESULTS[0]!, changes)
    assert.throws(() => formatSciE2Result(raw, input))
  }
})

test("SCI E2 explicit profile routes to the new pin and never broadens missing-target requests", async () => {
  class RecordingTools extends ToolService {
    calls: Parameters<ToolService["testRemoteFunctionModule"]>[0][] = []
    override async testRemoteFunctionModule(
      args: Parameters<ToolService["testRemoteFunctionModule"]>[0]
    ) {
      this.calls.push(args)
      return JSON.stringify(response())
    }
  }
  const tools = new RecordingTools(new MockBackend())
  await assert.rejects(
    tools.runSciAnalysis({ ...input, target: undefined }),
    /requires an explicit target/
  )
  await assert.rejects(
    tools.runSciAnalysis({ ...input, profile: "DEFAULT" as never }),
    /Invalid SCI profile/
  )
  assert.equal(tools.calls.length, 0)
  await tools.runSciAnalysis(input)
  assert.equal(tools.calls[0]?.functionName, SCI_E2_HELPER)
  assert.equal(tools.calls[0]?.expectedInterfaceFingerprint, SCI_E2_FINGERPRINT)
  assert.deepEqual(tools.calls[0]?.expectedOutputs, { EV_ENGINE: "SCI", EV_VERSION: "3.0" })
  assert.deepEqual(tools.calls[0]?.inputParameters, {
    IV_ACTION: "RUN",
    IV_OBJECT_TYPE: "FUGR",
    IV_OBJECT_NAME: "ZORVANTA_MCP_CORE"
  })
})

test("SCI E2 contract is opt-in and unapproved/missing-helper calls cannot execute", async () => {
  const schema = z.object(toolContracts.run_sci_analysis.inputSchema)
  assert.ok(schema.safeParse(input).success)
  assert.equal(schema.safeParse({ ...input, profile: "FAE" }).success, false)
  const tools = new ToolService(new MockBackend())
  await assert.rejects(
    tools.runSciAnalysis({ ...input, acknowledgePotentialSideEffects: false as never }),
    /acknowledgePotentialSideEffects/
  )
  await assert.rejects(tools.runSciAnalysis(input), /FUNCTION_READ_FAILED/)
})
