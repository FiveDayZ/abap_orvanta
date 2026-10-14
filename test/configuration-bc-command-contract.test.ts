import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  configurationBcBlockedByArms,
  configurationBcBlockedReasons,
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

test("every blocking reason a caller can receive is declared, and the declaration matches the arms", () => {
  // The strings below are written out here rather than read from the module, so a change to the
  // vocabulary or to an arm's order has to be made in two places on purpose.
  const recorded: Record<string, string[]> = {
    command_contract: [
      "native_before_state_runtime_acceptance",
      "approved_headless_activation_and_recovery_api",
      "specific_configuration_and_cts_write_authorization",
      "distribution_resolver_can_write_SCDTSYNC_and_invoke_remote_RFC"
    ],
    command_preparation: [
      "approved_headless_activation_and_recovery_api",
      "specific_configuration_and_cts_write_authorization",
      "distribution_resolver_can_write_SCDTSYNC_and_invoke_remote_RFC",
      "sap_locked_before_state_not_established"
    ],
    effects_readback: [
      "sap_locked_before_state_not_established",
      "standard_save_and_recovery_not_executed",
      "specific_configuration_and_cts_write_authorization"
    ],
    recovery_check: [
      "sap_locked_before_state_not_established",
      "configuration_and_cts_recovery_not_executed",
      "specific_configuration_and_cts_write_authorization"
    ]
  }
  const arms = configurationBcBlockedByArms as Record<string, readonly string[]>
  // The delivered order is part of what a caller receives, so it is pinned rather than sorted.
  for (const [arm, reasons] of Object.entries(recorded)) {
    assert.deepEqual([...arms[arm]!], reasons, `arm ${arm} changed what it reports or the order`)
  }
  // The declared vocabulary has to cover every reason the arms report, and every declared reason has
  // to be reported by the arms it names - the two directions are checked against different sources.
  const declared: string[] = configurationBcBlockedReasons.map((entry) => entry.reason)
  assert.equal(new Set(declared).size, declared.length, "a reason is declared twice")
  for (const [arm, reasons] of Object.entries(recorded))
    for (const reason of reasons)
      assert.ok(declared.includes(reason), `${arm} reports ${reason}, which no declaration covers`)
  for (const entry of configurationBcBlockedReasons) {
    const actual = Object.entries(recorded)
      .filter(([, reasons]) => reasons.includes(entry.reason))
      .map(([arm]) => arm)
      .sort()
    assert.deepEqual(
      actual,
      [...entry.reportedBy].sort(),
      `${entry.reason} declares reported-by ${entry.reportedBy.join("/")} but the arms say ${actual.join("/")}`
    )
  }
  // One declared reason is deliberately not reported by any arm other than the apply contract: the
  // preparation rechecks that state in the same call, so it must not claim to be blocked by it.
  const rechecked = "native_before_state_runtime_acceptance"
  assert.ok(recorded.command_contract!.includes(rechecked))
  assert.equal(recorded.command_preparation!.includes(rechecked), false)
  assert.deepEqual(
    [...recorded.command_preparation!],
    [
      ...recorded.command_contract!.filter((reason) => reason !== rechecked),
      "sap_locked_before_state_not_established"
    ],
    "the preparation no longer equals the contract minus the state it rechecks plus the lock it skips"
  )
  // And the three arms select the strings instead of carrying them again.
  for (const module of [
    "../src/configuration-bc-command-preparation.js",
    "../src/configuration-bc-effects.js",
    "../src/configuration-bc-recovery-check.js"
  ]) {
    const text = readFileSync(new URL(module, import.meta.url), "utf8")
    for (const reason of declared)
      assert.equal(
        text.includes(`"${reason}"`),
        false,
        `${module} carries ${reason} as a literal instead of selecting it`
      )
  }
})
