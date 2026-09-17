import assert from "node:assert/strict"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"

const { validateDebugger, fixtureFingerprint } = await import(
  pathToFileURL(resolve("scripts/probe-debug-acceptance.mjs")).href
)

function fixture(
  options: {
    unsupported?: boolean
    busy?: boolean
    badVariable?: boolean
    cleanupFailure?: boolean
    moved?: boolean
    changed?: boolean
    rfcFailure?: boolean
  } = {}
) {
  let state = options.busy ? "paused" : "idle"
  let breakpoints = 0
  let complete: ((value: unknown) => void) | undefined
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const frame = { frameId: 1, program: "SAPLZCMCP_FG_1501", include: "LZCMCP_FG_1501U01", line: 11 }
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    calls.push({ name, args })
    switch (name) {
      case "read_function_module_interface":
        return {
          connectionId: "w200",
          functionGroup: "ZCMCP_FG_1501",
          remoteEnabled: true,
          fingerprint: options.changed ? "changed" : fixtureFingerprint,
          source: ["FUNCTION ZCMCP_FM_1501.", "  IF iv_input IS INITIAL."]
        }
      case "inspect_repository_assignment":
        return { packageName: "ZABAP", transportNumber: "TEST_ONLY" }
      case "abap_debug_status":
        return { state, breakpointCount: breakpoints }
      case "abap_debug_session":
        if (args.action === "precheck")
          return {
            state,
            breakpointCount: breakpoints,
            precheck: {
              status: options.unsupported ? "not_advertised" : "metadata_available",
              readOnly: true,
              listenerStarted: false,
              executionValidated: false
            }
          }
        if (args.action === "start") {
          if (options.unsupported) throw new Error("unsupported-endpoint (HTTP 404)")
          state = "listening"
        } else {
          if (options.cleanupFailure) throw new Error("stop failed")
          state = "idle"
          breakpoints = 0
        }
        return { state }
      case "abap_debug_breakpoint":
        breakpoints = args.action === "set" ? 1 : 0
        return { breakpoints: [{ verified: true }] }
      case "test_remote_function_module":
        if (breakpoints) {
          if (options.rfcFailure) throw new Error("RFC failed")
          state = "paused"
          return new Promise((done) => {
            complete = done
          })
        }
        return {
          status: "passed",
          outputs: args.expectedOutputs,
          expectedException: args.expectedException
        }
      case "abap_debug_stack":
        return [frame]
      case "abap_debug_variable":
        return { variables: [{ value: options.badVariable ? "WRONG" : "VALIDATION" }] }
      case "abap_debug_step":
        if (args.stepType === "stepOver")
          return {
            state: "paused",
            topFrame: { ...frame, line: options.moved === false ? 11 : 12 }
          }
        state = "listening"
        complete?.({ status: "passed", outputs: { EV_OUTPUT: "MCP:VALIDATION" } })
        return { state }
      default:
        throw new Error(`Unexpected tool: ${name}`)
    }
  }
  return { call, calls }
}

test("debug acceptance distinguishes unavailable live endpoints from a pass", async () => {
  const backend = fixture({ unsupported: true })
  const result = await validateDebugger(backend.call)
  assert.equal(result.status, "Partially Verified")
  assert.match(result.blocker, /not_advertised/)
  assert.equal(result.rfcInvoked, false)
  assert.equal(
    backend.calls.some(({ name }) => name === "abap_debug_breakpoint"),
    false
  )
})

test("debug preflight never invokes RFC or starts a listener", async () => {
  const backend = fixture()
  const result = await validateDebugger(backend.call)
  assert.equal(result.status, "Partially Verified")
  assert.equal(result.cleanupComplete, true)
  assert.equal(
    backend.calls.some(({ name }) => name === "test_remote_function_module"),
    false
  )
  assert.deepEqual(
    backend.calls
      .filter(({ name }) => name === "abap_debug_session")
      .map(({ args }) => args.action),
    ["precheck"]
  )
})

test("debug acceptance leaves an existing user session untouched", async () => {
  const backend = fixture({ busy: true })
  const result = await validateDebugger(backend.call, { execute: true })
  assert.equal(result.status, "Partially Verified")
  assert.deepEqual(
    backend.calls.map(({ name }) => name),
    ["abap_debug_status"]
  )
})

test("debug acceptance rejects a changed fixture before any listener or RFC", async () => {
  const backend = fixture({ changed: true })
  const result = await validateDebugger(backend.call, { execute: true })
  assert.equal(result.status, "Failed")
  assert.equal(
    backend.calls.some(({ name }) => name === "abap_debug_session"),
    false
  )
})

test("debug acceptance covers pause, stack, value, step, RFC cases and cleanup", async () => {
  const backend = fixture()
  const result = await validateDebugger(backend.call, { execute: true })
  assert.equal(result.status, "Passed")
  assert.equal(result.cleanupComplete, true)
  assert.equal(result.sourceUnchanged, true)
  assert.equal(result.assignmentUnchanged, true)
  const inputs = backend.calls
    .filter(({ name }) => name === "test_remote_function_module")
    .map(({ args }) => args.inputParameters)
  assert.deepEqual(inputs, [
    { IV_INPUT: "VALIDATION" },
    { IV_INPUT: "12345678901234567890" },
    { IV_INPUT: "" }
  ])
})

for (const options of [
  { badVariable: true },
  { moved: false },
  { cleanupFailure: true },
  { rfcFailure: true }
]) {
  test(`debug acceptance fails honestly and attempts cleanup: ${JSON.stringify(options)}`, async () => {
    const backend = fixture(options)
    const result = await validateDebugger(backend.call, { execute: true })
    assert.equal(result.status, "Failed")
    assert.ok(
      backend.calls.some(
        ({ name, args }) => name === "abap_debug_session" && args.action === "stop"
      )
    )
    if (options.cleanupFailure) {
      assert.equal(result.cleanupComplete, false)
      assert.ok(result.cleanupErrors.length)
    }
  })
}
