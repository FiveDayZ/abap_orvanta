import assert from "node:assert/strict"
import test from "node:test"
import {
  configurationBcCommandContract,
  reconcileConfigurationBcCommand
} from "../src/configuration-bc-command-contract.js"

const ref = "a".repeat(64)
const sample = {
  beforeStateReference: ref,
  complete: true,
  configuration: "before",
  cts: "before",
  protectionPreserved: true,
  locks: "released",
  logs: "unknown",
  nativeStarted: false,
  commit: "unknown",
  sideEffectsAccounted: true
}
test("command contract rejects external bytes and keeps existing receipt ownership with execution disabled", () => {
  const input = {
    connectionId: "w200",
    bcSetId: "EHS_CUNI_KNM",
    version: "N",
    requestNumber: "GR2K923429",
    taskNumber: "GR2K923430",
    operationId: "r52-command-01",
    beforeStateReference: ref
  }
  const result = configurationBcCommandContract(input)
  assert.equal(result.receiptOwner, "WriteOperationReceiptStore")
  assert.equal(result.executable, false)
  assert.equal(result.recoveryAvailable, false)
  assert.match(result.duplicatePolicy, /never_replay/)
  for (const patch of [
    { restoreBytes: "AAAA" },
    { operationId: "../escape" },
    { taskNumber: "GR2K923492" },
    { release: true }
  ])
    assert.throws(() => configurationBcCommandContract({ ...input, ...patch }))
})
test("reconciliation requires configuration, CTS, protections, locks, logs and known commit evidence", () => {
  assert.equal(reconcileConfigurationBcCommand(ref, sample).state, "not_started")
  assert.equal(
    reconcileConfigurationBcCommand(ref, {
      ...sample,
      nativeStarted: true,
      configuration: "candidate",
      cts: "recorded",
      commit: "committed",
      logs: "success"
    }).state,
    "applied"
  )
  assert.equal(
    reconcileConfigurationBcCommand(ref, { ...sample, nativeStarted: true, commit: "rolled_back" })
      .state,
    "not_applied"
  )
  assert.equal(
    reconcileConfigurationBcCommand(ref, {
      ...sample,
      nativeStarted: true,
      commit: "committed",
      configuration: "mixed"
    }).state,
    "partial"
  )
  assert.equal(
    reconcileConfigurationBcCommand(ref, {
      ...sample,
      nativeStarted: true,
      commit: "committed",
      protectionPreserved: false
    }).state,
    "partial"
  )
  assert.throws(
    () => reconcileConfigurationBcCommand(ref, { ...sample, beforeStateReference: "b".repeat(64) }),
    /BINDING_INVALID/
  )
})
test("matching current before values never resolve an unknown native historical outcome", () => {
  const result = reconcileConfigurationBcCommand(ref, { ...sample, nativeStarted: true })
  assert.equal(result.state, "unknown")
  assert.equal(result.historicalOutcomeKnown, false)
  assert.equal(result.replayAllowed, false)
  assert.equal(result.recoveryAvailable, false)
  assert.equal(result.nextAction, "retain_target_protection_and_review")
})
for (const patch of [
  { complete: false },
  { locks: "held" },
  { locks: "unknown" },
  { logs: "unknown" },
  { protectionPreserved: null },
  { sideEffectsAccounted: false },
  { commit: "unknown" },
  { cts: "changed" }
])
  test(`incomplete applied proof ${JSON.stringify(patch)} cannot claim success or authorize replay`, () => {
    const result = reconcileConfigurationBcCommand(ref, {
      ...sample,
      nativeStarted: true,
      configuration: "candidate",
      cts: "recorded",
      commit: "committed",
      logs: "success",
      ...patch
    })
    assert.notEqual(result.state, "applied")
    assert.equal(result.replayAllowed, false)
    assert.equal(result.recoveryAvailable, false)
  })
