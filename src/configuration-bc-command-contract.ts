import { z } from "zod"
import { configurationBcRecordKernel } from "./configuration-bc-record-kernel.js"
import {
  configurationBcStateKeyCount,
  configurationBcStateProtectionKeyCount
} from "./configuration-bc-state-api.js"

const hex = z.string().regex(/^[a-f0-9]{64}$/)

/**
 * Three of these labels carry the pilot's size as an English word, and a caller matches them by exact
 * string, so a hand-written word is a claim about the scope that nothing checks. The counts are derived
 * elsewhere - the readback covers every complete fixed key, the unchanged keys are the guard layout's
 * protection keys, and the record kernel owns its own insert/protect split - so the labels are spelled
 * from those constants. The rendered strings are unchanged, so no caller sees a different vocabulary.
 */
const COUNT_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty"
] as const
const countWord = (value: number) => {
  const word = COUNT_WORDS[value]
  if (word === undefined) throw Error("CONFIGURATION_BC_COMMAND_COUNT_UNSPELLABLE")
  return word
}

/** Each blocking reason is a string a caller matches, so it is written once and named. */
export const configurationBcBlockedReason = {
  nativeBeforeState: "native_before_state_runtime_acceptance",
  headlessApi: "approved_headless_activation_and_recovery_api",
  writeAuthorization: "specific_configuration_and_cts_write_authorization",
  distributionResolver: "distribution_resolver_can_write_SCDTSYNC_and_invoke_remote_RFC",
  lockNotEstablished: "sap_locked_before_state_not_established",
  saveAndRecoveryNotExecuted: "standard_save_and_recovery_not_executed",
  recoveryNotExecuted: "configuration_and_cts_recovery_not_executed"
} as const

/**
 * The closed vocabulary of reasons a BC command result can report as blocking, with the results that
 * report each one. Three of these used to reach a caller while being declared nowhere - the
 * preparation and the two readback arms each carried their own literals - so a reader could not tell
 * what they meant, and one declared reason never reached a caller at all because the preparation
 * rechecks that state in the same call. The declaration is the authority: the arms select from it, and
 * the guard test checks the reported-by claims against what each arm actually reports, so a reason no
 * result reports is a declaration to remove rather than a silent leftover.
 */
export const configurationBcBlockedReasons = [
  { reason: configurationBcBlockedReason.nativeBeforeState, reportedBy: ["command_contract"] },
  {
    reason: configurationBcBlockedReason.headlessApi,
    reportedBy: ["command_contract", "command_preparation"]
  },
  {
    reason: configurationBcBlockedReason.writeAuthorization,
    reportedBy: ["command_contract", "command_preparation", "effects_readback", "recovery_check"]
  },
  {
    reason: configurationBcBlockedReason.distributionResolver,
    reportedBy: ["command_contract", "command_preparation"]
  },
  {
    reason: configurationBcBlockedReason.lockNotEstablished,
    reportedBy: ["command_preparation", "effects_readback", "recovery_check"]
  },
  {
    reason: configurationBcBlockedReason.saveAndRecoveryNotExecuted,
    reportedBy: ["effects_readback"]
  },
  {
    reason: configurationBcBlockedReason.recoveryNotExecuted,
    reportedBy: ["recovery_check"]
  }
] as const

/** What the apply contract reports: the command itself is blocked by all four. */
export const configurationBcCommandBlockedBy = [
  configurationBcBlockedReason.nativeBeforeState,
  configurationBcBlockedReason.headlessApi,
  configurationBcBlockedReason.writeAuthorization,
  configurationBcBlockedReason.distributionResolver
]

/**
 * What the preparation reports: the same list without the before state it rechecks in this call, plus
 * the lock it deliberately does not take because it reads a snapshot.
 */
export const configurationBcPreparationBlockedBy = [
  configurationBcBlockedReason.headlessApi,
  configurationBcBlockedReason.writeAuthorization,
  configurationBcBlockedReason.distributionResolver,
  configurationBcBlockedReason.lockNotEstablished
]

/** What the effects readback reports: the lock it does not take, the save it does not run, and authorization. */
export const configurationBcEffectsBlockedBy = [
  configurationBcBlockedReason.lockNotEstablished,
  configurationBcBlockedReason.saveAndRecoveryNotExecuted,
  configurationBcBlockedReason.writeAuthorization
]

/** What the recovery check reports: the lock it does not take, the recovery it does not run, and authorization. */
export const configurationBcRecoveryBlockedBy = [
  configurationBcBlockedReason.lockNotEstablished,
  configurationBcBlockedReason.recoveryNotExecuted,
  configurationBcBlockedReason.writeAuthorization
]

/** The results that report blocking reasons, by the name the vocabulary uses. */
export const configurationBcBlockedByArms = {
  command_contract: configurationBcCommandBlockedBy,
  command_preparation: configurationBcPreparationBlockedBy,
  effects_readback: configurationBcEffectsBlockedBy,
  recovery_check: configurationBcRecoveryBlockedBy
} as const
export const configurationBcCommandRequestSchema = z
  .object({
    connectionId: z.literal("w200"),
    bcSetId: z.literal("EHS_CUNI_KNM"),
    version: z.literal("N"),
    requestNumber: z.literal("GR2K923429"),
    taskNumber: z.literal("GR2K923430"),
    operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{7,79}$/),
    beforeStateReference: hex
  })
  .strict()
const observation = z
  .object({
    beforeStateReference: hex,
    complete: z.boolean(),
    configuration: z.enum(["before", "candidate", "mixed", "other", "unknown"]),
    cts: z.enum(["before", "recorded", "changed", "unknown"]),
    protectionPreserved: z.boolean().nullable(),
    locks: z.enum(["released", "held", "unknown"]),
    logs: z.enum(["success", "failure", "unknown"]),
    nativeStarted: z.boolean(),
    commit: z.enum(["committed", "rolled_back", "unknown"]),
    sideEffectsAccounted: z.boolean()
  })
  .strict()

/** Pure contract preparation: never dispatches APPLY/RECOVER, allocates a transport or releases locks. */
export function configurationBcCommandContract(raw: unknown) {
  const input = configurationBcCommandRequestSchema.parse(raw)
  return {
    ...input,
    executable: false as const,
    recoveryAvailable: false as const,
    duplicatePolicy: "reuse_receipt_then_reconcile_never_replay" as const,
    receiptOwner: "WriteOperationReceiptStore" as const,
    requiredNativeChecks: [
      "approved_budget",
      "authenticated_binding",
      "source_and_layout_attestation",
      "sap_enqueue",
      "locked_before_state",
      "native_versions",
      `${countWord(configurationBcRecordKernel.mutableCount)}_mutable_records_${countWord(configurationBcRecordKernel.protectedCount)}_protected_records`,
      "lossless_standard_record_preparation",
      "cts_open_owned_task",
      "headless_route_and_commit_boundaries"
    ],
    successProof: [
      `complete_${countWord(configurationBcStateKeyCount)}_key_readback`,
      "exact_cts_recording",
      `${countWord(configurationBcStateProtectionKeyCount)}_protected_keys_unchanged`,
      "shared_PRESS_dimension_unchanged",
      "locks_released",
      "logs_and_independent_side_effects_accounted"
    ],
    blockedBy: [...configurationBcCommandBlockedBy]
  }
}

/** Current observations cannot turn an unknown historical commit into a known rollback. */
export function reconcileConfigurationBcCommand(expectedReference: string, raw: unknown) {
  hex.parse(expectedReference)
  const value = observation.parse(raw)
  if (value.beforeStateReference !== expectedReference)
    throw Error("CONFIGURATION_BC_COMMAND_BINDING_INVALID")
  let state: "not_started" | "applied" | "not_applied" | "partial" | "unknown" = "unknown"
  if (
    value.complete &&
    value.protectionPreserved === true &&
    value.locks === "released" &&
    value.sideEffectsAccounted
  ) {
    if (
      !value.nativeStarted &&
      value.configuration === "before" &&
      value.cts === "before" &&
      value.commit !== "committed"
    )
      state = "not_started"
    else if (
      value.nativeStarted &&
      value.configuration === "candidate" &&
      value.cts === "recorded" &&
      value.logs === "success" &&
      value.commit === "committed"
    )
      state = "applied"
    else if (
      value.nativeStarted &&
      value.configuration === "before" &&
      value.cts === "before" &&
      value.commit === "rolled_back"
    )
      state = "not_applied"
    else if (
      value.nativeStarted &&
      value.commit === "committed" &&
      (value.configuration === "mixed" || value.cts === "changed" || value.logs === "failure")
    )
      state = "partial"
  } else if (
    value.complete &&
    value.nativeStarted &&
    value.commit === "committed" &&
    value.protectionPreserved === false
  )
    state = "partial"
  return {
    state,
    current: { configuration: value.configuration, cts: value.cts },
    historicalOutcomeKnown: state !== "unknown",
    replayAllowed: false as const,
    recoveryAvailable: false as const,
    nextAction:
      state === "applied" || state === "not_started" || state === "not_applied"
        ? "retain_receipt"
        : "retain_target_protection_and_review"
  }
}
