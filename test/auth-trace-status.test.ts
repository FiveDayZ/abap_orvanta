import assert from "node:assert/strict"
import test from "node:test"
import {
  collectAuthTraceStatus,
  reviewedAuthTraceStatusDefinition
} from "../src/auth-trace-status.js"
import type { RemoteFunctionRequest, SapBackend } from "../src/backend.js"

/**
 * `AUTH_TRACE_GET_STATUS.RC` is the whole contract of this read, and its polarity is the one thing
 * that could silently invert the answer. These tests pin it from both ends:
 *
 *  - the definition must carry BOTH fingerprints, so a replaced function module cannot keep
 *    answering from a body that no longer means what the caller thinks;
 *  - `'X'` must read as trace-active, because that is what SAP's own callers do with it
 *    (`AUTH_TRACE_RESET`, `AUTH_TRACE_INTERN_GET_NAME`: `IF lv_rc <> 'X'. EXIT. ENDIF.` under
 *    "If the trace is not active"). A future edit that flips this to `=== ""` turns the tool into
 *    a plausible-looking falsehood, which is exactly what these cases refuse.
 */

const pinnedDefinition = {
  functionName: "AUTH_TRACE_GET_STATUS",
  remoteEnabled: true,
  updateTask: false,
  sourceFingerprint: "935db5a6ecdef645047308de0702b7adce1fcc52cff50401508651a187dce652",
  interfaceFingerprint: "d603edfe08b0a65b1d23c94b8a9bdc2704c7bd6cdab0d55995ae8ed425990965"
}

function double(
  rc: unknown,
  options: { fault?: { code: string; name: string; message: string } } = {}
) {
  const requests: RemoteFunctionRequest[] = []
  const backend = {
    callRemoteFunction: async (_connection: string, request: RemoteFunctionRequest) => {
      requests.push(request)
      if (options.fault) return { outputs: {}, fault: options.fault }
      return { outputs: { RC: rc } }
    }
  }
  return { backend: backend as unknown as Pick<SapBackend, "callRemoteFunction">, requests }
}

test("AUTH_TRACE_GET_STATUS is called with the pinned interface and no inputs", async () => {
  const { backend, requests } = double("X")
  const result = await collectAuthTraceStatus(backend, "w200", async () => pinnedDefinition)
  assert.equal(result.status, "ok")
  assert.equal(result.traceActive, true)
  assert.equal(result.traceSwitchSource, "AUTH_TRACE_GET_STATUS.RC")
  assert.equal(result.readOnly, true)
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.functionName, "AUTH_TRACE_GET_STATUS")
  // The function module takes no input; sending one would be inventing a contract.
  assert.deepEqual(requests[0]?.inputParameters, {})
  assert.deepEqual(requests[0]?.outputParameters, [{ name: "RC", kind: "scalar" }])
})

test("RC='X' means the trace IS active, and a blank RC means it is not", async () => {
  // 'X' -> active. This is the assertion that would fail if the polarity were inverted.
  const active = await collectAuthTraceStatus(
    double("X").backend,
    "w200",
    async () => pinnedDefinition
  )
  assert.equal(active.traceActive, true)

  // ' ' -> inactive (BOOLE CHAR 1, unset).
  const inactive = await collectAuthTraceStatus(
    double(" ").backend,
    "w200",
    async () => pinnedDefinition
  )
  assert.equal(inactive.status, "ok")
  assert.equal(inactive.traceActive, false)

  // Lower-case x is the same value to the kernel; it must not be reported as unknown.
  const lower = await collectAuthTraceStatus(
    double("x").backend,
    "w200",
    async () => pinnedDefinition
  )
  assert.equal(lower.traceActive, true)
})

test("an unexpected RC value is invalid, never silently 'trace off'", async () => {
  const { backend } = double("Z")
  const result = await collectAuthTraceStatus(backend, "w200", async () => pinnedDefinition)
  assert.equal(result.status, "unavailable")
  assert.equal(result.traceActive, null)
  assert.equal(result.source.status, "invalid")
  assert.equal(result.source.code, "AUTH_TRACE_STATUS_RESPONSE_INVALID")
})

test("a missing RC export is invalid rather than an unavailable feature", async () => {
  const { backend } = double(undefined)
  const result = await collectAuthTraceStatus(backend, "w200", async () => pinnedDefinition)
  assert.equal(result.source.code, "AUTH_TRACE_STATUS_RESPONSE_INVALID")
  assert.equal(result.traceActive, null)
})

test("a definition that does not match the pinned fingerprints is refused", async () => {
  // A replaced function module must not keep answering: change only the source fingerprint.
  const { backend, requests } = double("X")
  const drifted = { ...pinnedDefinition, sourceFingerprint: "0".repeat(64) }
  const result = await collectAuthTraceStatus(backend, "w200", async () => drifted)
  assert.equal(result.status, "unavailable")
  assert.equal(result.traceActive, null)
  assert.equal(result.source.code, "AUTH_TRACE_STATUS_FUNCTION_UNVERIFIED")
  // The refusal happens before SAP is touched at all.
  assert.equal(requests.length, 0)
})

test("an interface drift is refused independently of the source fingerprint", async () => {
  const { backend, requests } = double("X")
  const drifted = { ...pinnedDefinition, interfaceFingerprint: "0".repeat(64) }
  const result = await collectAuthTraceStatus(backend, "w200", async () => drifted)
  assert.equal(result.source.code, "AUTH_TRACE_STATUS_FUNCTION_UNVERIFIED")
  assert.equal(requests.length, 0)
})

test("a not-authorized fault keeps its own code instead of becoming a generic failure", async () => {
  const { backend } = double("X", {
    fault: { code: "1", name: "NOT_AUTHORIZED", message: "no authority" }
  })
  const result = await collectAuthTraceStatus(backend, "w200", async () => pinnedDefinition)
  assert.equal(result.source.code, "AUTH_TRACE_STATUS_NOT_AUTHORIZED")
  assert.equal(result.traceActive, null)
})

test("the pinned definition rejects the three literals it does not verify", async () => {
  // Guards the pin itself: dropping a fingerprint from the schema would make the cases above pass
  // for the wrong reason.
  assert.equal(reviewedAuthTraceStatusDefinition.safeParse(pinnedDefinition).success, true)
  const noSource = { ...pinnedDefinition, sourceFingerprint: undefined }
  assert.equal(reviewedAuthTraceStatusDefinition.safeParse(noSource).success, false)
})
