import assert from "node:assert/strict"
import test from "node:test"
import type { SapBackend, RemoteFunctionResult } from "../src/backend.js"
import { ToolService } from "../src/tools.js"

// `run_abap_program` executes the program's real logic through the target system's
// Z_ORVANTA_RUN_PROGRAM runner, so the guards around it are the whole safety story: the caller has
// to confirm, SAP standard programs are refused, and a non-zero SUBMIT return code is reported as
// failed rather than passed. These tests pin those guards and the two return-code outcomes.

interface RemoteCall {
  connectionId: string
  request: { functionName: string; inputParameters: Record<string, unknown> }
}

function serviceWith(result: RemoteFunctionResult) {
  const calls: RemoteCall[] = []
  const backend = {
    connectionIds: () => ["w200"],
    connectionDetails: () => ({}),
    callRemoteFunction: async (connectionId: string, request: RemoteCall["request"]) => {
      calls.push({ connectionId, request })
      return result
    }
  } as unknown as SapBackend
  return { tools: new ToolService(backend), calls }
}

const invocation = {
  connectionId: "w200",
  programName: "ZORVANTA_MCP_DYNPRO_R11",
  confirmation: "RUN_ABAP_PROGRAM"
}

test("run_abap_program: a zero return code is reported as passed, with no automatic retry", async () => {
  const { tools, calls } = serviceWith({ outputs: { EV_SUBRC: "0" } })

  const output = JSON.parse(await tools.runAbapProgram(invocation)) as Record<string, unknown>

  assert.equal(output.status, "passed")
  assert.equal(output.subrc, "0")
  assert.equal(output.programName, "ZORVANTA_MCP_DYNPRO_R11")
  assert.equal(output.runner, "Z_ORVANTA_RUN_PROGRAM")
  assert.equal(output.sideEffectsAcknowledged, true)
  assert.equal(output.automaticRetry, false)
  assert.equal(output.detail, undefined, "a passing run needs no explanation")
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.request.functionName, "Z_ORVANTA_RUN_PROGRAM")
  assert.deepEqual(calls[0]?.request.inputParameters, { IV_PROGRAM: "ZORVANTA_MCP_DYNPRO_R11" })
})

test("run_abap_program: a non-zero return code is reported as failed and explained", async () => {
  const { tools } = serviceWith({ outputs: { EV_SUBRC: "4" } })

  const output = JSON.parse(await tools.runAbapProgram(invocation)) as Record<string, unknown>

  assert.equal(output.status, "failed")
  assert.equal(output.subrc, "4")
  assert.match(String(output.detail), /non-zero SUBRC/)
})

test("run_abap_program: the program name is upper-cased before it reaches SAP", async () => {
  const { tools, calls } = serviceWith({ outputs: { EV_SUBRC: "0" } })

  await tools.runAbapProgram({ ...invocation, programName: "zorvanta_mcp_dynpro_r11" })

  assert.deepEqual(calls[0]?.request.inputParameters, { IV_PROGRAM: "ZORVANTA_MCP_DYNPRO_R11" })
})

test("run_abap_program: an SAP standard program is refused before SAP is contacted", async () => {
  const { tools, calls } = serviceWith({ outputs: { EV_SUBRC: "0" } })

  await assert.rejects(
    tools.runAbapProgram({ ...invocation, programName: "RSPARAM" }),
    /must name a Z\* or Y\* customer program/
  )
  assert.equal(calls.length, 0, "a refused program must not reach SAP")
})

test("run_abap_program: the confirmation is checked before SAP is contacted", async () => {
  const { tools, calls } = serviceWith({ outputs: { EV_SUBRC: "0" } })

  await assert.rejects(
    tools.runAbapProgram({ ...invocation, confirmation: "RUN_ABAP_PROGRAM " }),
    /confirmation must be RUN_ABAP_PROGRAM/
  )
  assert.equal(calls.length, 0, "an unconfirmed call must not reach SAP")
})

test("run_abap_program: a SOAP fault is reported as a fault, never as a passing run", async () => {
  const { tools } = serviceWith({
    outputs: {},
    fault: { name: "CX_SY_RFC", code: "RFC_ERROR", message: "Function not found" }
  })

  await assert.rejects(tools.runAbapProgram(invocation), /SAP SOAP fault: CX_SY_RFC RFC_ERROR/)
})

test("run_abap_program: a missing return code is an error rather than an assumed success", async () => {
  const { tools } = serviceWith({ outputs: {} })

  await assert.rejects(tools.runAbapProgram(invocation), /did not return EV_SUBRC/)
})
