import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { PRODUCT_VERSION } from "../dist/src/version.js"

const functionName = "ZCMCP_FM_1501"
// Frozen from active SAP source on 2026-09-07; changing this baseline requires source review.
export const fixtureFingerprint = "757408ee9993823810270e6601327c6d4860c7f8d4323c1fdd83606151cccb78"

export async function validateDebugger(call, { execute = false, timeoutMs = 30_000 } = {}) {
  const evidence = {
    observedAt: new Date().toISOString(),
    functionName,
    mode: execute ? "approved-fixture" : "preflight",
    status: "Partially Verified",
    checks: [],
    cleanupErrors: [],
    rfcInvoked: false,
    sessionOwned: false,
    cleanupComplete: true
  }
  let before, assignment, filePath, breakpointLine, pending, invocation
  let breakpointAttempted = false
  async function check(name, args = {}) {
    const value = await call(name, args)
    evidence.checks.push({ tool: name, outcome: "passed" })
    return value
  }
  async function verifyFixture() {
    const definition = await check("read_function_module_interface", { functionName })
    assert.equal(definition.fingerprint, fixtureFingerprint, "Fixture changed; review required")
    assert.equal(definition.remoteEnabled, true)
    return definition
  }
  async function waitPaused() {
    const deadline = Date.now() + timeoutMs
    do {
      if (invocation) throw new Error("RFC completed before the expected debugger pause")
      const state = await call("abap_debug_status", {})
      if (state.state === "paused") return state
      if (state.state === "error") throw new Error(state.lastError || "Debugger listener failed")
      await new Promise((resolve) => setTimeout(resolve, 200))
    } while (Date.now() < deadline)
    throw new Error("Timed out waiting for a real SAP debugger pause")
  }
  async function cleanupStep(name, args) {
    try {
      return await check(name, args)
    } catch (error) {
      evidence.cleanupErrors.push({ tool: name, error: String(error) })
    }
  }
  try {
    const initial = await check("abap_debug_status")
    if (initial.state !== "idle") {
      evidence.blocker = "An existing debug session must be left untouched"
      return evidence
    }
    before = await verifyFixture()
    assignment = await check("inspect_repository_assignment", {
      objectName: functionName,
      objectType: "FUGR/FF"
    })
    filePath = `adt://${before.connectionId}/sap/bc/adt/functions/groups/${before.functionGroup.toLowerCase()}/fmodules/${functionName.toLowerCase()}`
    breakpointLine =
      before.source.findIndex((line) => /^\s*IF\s+iv_input\s+IS\s+INITIAL\./i.test(line)) + 1
    assert.ok(breakpointLine > 0, "Fixture breakpoint statement is missing")
    if (!execute) {
      const result = await check("abap_debug_session", { action: "precheck" })
      assert.equal(result.state, "idle")
      assert.equal(result.breakpointCount, 0)
      assert.equal(result.precheck?.readOnly, true)
      assert.equal(result.precheck?.listenerStarted, false)
      assert.equal(result.precheck?.executionValidated, false)
      evidence.precheck = result.precheck
      evidence.blocker =
        result.precheck.status === "metadata_available"
          ? "Metadata available; real execution and cleanup compatibility remain unverified"
          : `Debugger precheck: ${result.precheck.status}`
      if (result.precheck.status === "failed") evidence.status = "Failed"
      return evidence
    }
    try {
      await check("abap_debug_session", { action: "start" })
      evidence.sessionOwned = true
      evidence.cleanupComplete = false
    } catch (error) {
      // Endpoint failure alone does not establish whether version, routing or configuration is responsible.
      if (/unsupported-endpoint|listener-not-found-ambiguous/.test(String(error))) {
        evidence.blocker = String(error)
        const state = await check("abap_debug_status")
        assert.equal(state.state, "idle", "Failed start left an uncertain debug session")
        assert.equal(state.breakpointCount, 0)
        return evidence
      }
      throw error
    }
    breakpointAttempted = true
    const breakpoint = await check("abap_debug_breakpoint", {
      action: "set",
      filePath,
      lineNumbers: [breakpointLine]
    })
    assert.equal(breakpoint.breakpoints?.[0]?.verified, true)
    await verifyFixture()
    const args = {
      functionName,
      expectedInterfaceFingerprint: before.fingerprint,
      acknowledgePotentialSideEffects: true
    }
    evidence.rfcInvoked = true
    // Handle rejection immediately, including failures that arrive while polling the debugger.
    pending = call("test_remote_function_module", {
      ...args,
      inputParameters: { IV_INPUT: "VALIDATION" },
      expectedOutputs: { EV_OUTPUT: "MCP:VALIDATION" }
    }).then(
      (result) => (invocation = { result }),
      (error) => (invocation = { error: String(error) })
    )
    evidence.paused = await waitPaused()
    const stack = await check("abap_debug_stack", { threadId: 1 })
    assert.ok(stack.length > 0)
    evidence.stack = stack
    const variables = await check("abap_debug_variable", {
      threadId: 1,
      frameId: stack[0].frameId,
      variableName: "IV_INPUT"
    })
    assert.equal(variables.variables?.[0]?.value, "VALIDATION")
    evidence.variable = { name: "IV_INPUT", value: "VALIDATION" }
    const stepped = await check("abap_debug_step", { threadId: 1, stepType: "stepOver" })
    assert.equal(stepped.state, "paused")
    assert.ok(
      stepped.topFrame &&
        (stepped.topFrame.line !== stack[0].line ||
          stepped.topFrame.include !== stack[0].include ||
          stepped.topFrame.program !== stack[0].program),
      "stepOver did not move the execution position"
    )
    evidence.stepOver = stepped
    await check("abap_debug_step", { threadId: 1, stepType: "continue" })
    await pending
    pending = undefined
    assert.equal(invocation.error, undefined, invocation.error)
    assert.equal(invocation.result.status, "passed")
    assert.equal(invocation.result.outputs?.EV_OUTPUT, "MCP:VALIDATION")
    evidence.happyPath = invocation.result
    await check("abap_debug_breakpoint", {
      action: "remove",
      filePath,
      lineNumbers: [breakpointLine]
    })
    breakpointAttempted = false
    // Technical contract cases, not business transaction acceptance.
    for (const [input, expectations] of [
      ["12345678901234567890", { expectedOutputs: { EV_OUTPUT: "MCP:12345678901234567890" } }],
      ["", { expectedException: "INVALID_INPUT" }]
    ]) {
      await verifyFixture()
      const result = await check("test_remote_function_module", {
        ...args,
        inputParameters: { IV_INPUT: input },
        ...expectations
      })
      assert.equal(result.status, "passed")
      if (expectations.expectedException)
        assert.equal(result.expectedException, expectations.expectedException)
      else assert.deepEqual(result.outputs, expectations.expectedOutputs)
    }
    evidence.status = "Passed"
  } catch (error) {
    evidence.status = "Failed"
    evidence.error = String(error)
  } finally {
    if (evidence.sessionOwned) {
      if (breakpointAttempted)
        await cleanupStep("abap_debug_breakpoint", {
          action: "remove",
          filePath,
          lineNumbers: [breakpointLine]
        })
      const state = await cleanupStep("abap_debug_status", {})
      if (state?.state === "paused")
        await cleanupStep("abap_debug_step", { threadId: 1, stepType: "continue" })
      await cleanupStep("abap_debug_session", { action: "stop" })
      const stopped = await cleanupStep("abap_debug_status", {})
      if (stopped?.state !== "idle" || stopped?.breakpointCount !== 0)
        evidence.cleanupErrors.push({ tool: "abap_debug_status", error: "Idle cleanup not proven" })
      if (pending) {
        await pending
        evidence.pendingRfc = invocation
      }
      evidence.cleanupComplete = evidence.cleanupErrors.length === 0
    }
    if (before) {
      const after = await cleanupStep("read_function_module_interface", { functionName })
      evidence.sourceUnchanged = after?.fingerprint === before.fingerprint
      if (!evidence.sourceUnchanged)
        evidence.cleanupErrors.push({
          tool: "read_function_module_interface",
          error: "Baseline changed or unreadable"
        })
    }
    if (assignment) {
      const after = await cleanupStep("inspect_repository_assignment", {
        objectName: functionName,
        objectType: "FUGR/FF"
      })
      evidence.assignmentUnchanged = JSON.stringify(after) === JSON.stringify(assignment)
      if (!evidence.assignmentUnchanged)
        evidence.cleanupErrors.push({
          tool: "inspect_repository_assignment",
          error: "Assignment changed or unreadable"
        })
    }
    if (evidence.cleanupErrors.length) {
      evidence.cleanupComplete = false
      evidence.status = "Failed"
    }
  }
  return evidence
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const endpoint = new URL(process.env.ABAP_MCP_ENDPOINT || "http://127.0.0.1:4847/mcp")
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/mcp"
  )
    throw new Error("Use a credential-free local ORVANTA /mcp endpoint")
  const connectionId = process.env.ABAP_MCP_CONNECTION || "w200"
  const client = new Client({ name: "orvanta-debug-acceptance", version: "1.0.0" })
  const report = { startedAt: new Date().toISOString(), connectionId, status: "Failed" }
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint))
    report.server = client.getServerVersion()
    assert.equal(report.server.version, PRODUCT_VERSION, "Switch the reviewed candidate first")
    const tool = (await client.listTools()).tools.find((tool) => tool.name === "abap_debug_session")
    assert.ok(tool?.inputSchema.properties?.action?.enum?.includes("precheck"))
    const result = await validateDebugger(
      async (name, args) => {
        const response = await client.callTool(
          { name, arguments: { connectionId, ...args } },
          undefined,
          { timeout: 120_000 }
        )
        const text = response.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
        if (response.isError) throw new Error(`${name}: ${text}`)
        return JSON.parse(text.split("\nOperation Receipt\n", 1)[0])
      },
      { execute: process.env.ABAP_MCP_DEBUG_ACCEPTED === "ZCMCP_FM_1501" }
    )
    Object.assign(report, result)
    process.exitCode =
      result.status === "Passed" ? 0 : result.status === "Partially Verified" ? 2 : 1
  } catch (error) {
    report.error = String(error)
    process.exitCode = 1
  } finally {
    await client.close()
    report.finishedAt = new Date().toISOString()
    const suffix = report.startedAt.replace(/[:.]/g, "-")
    const path = new URL(`../../.doc/m64-debug-acceptance-${suffix}.json`, import.meta.url)
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" })
    console.log(JSON.stringify({ ...report, evidence: path.pathname }, null, 2))
  }
}
