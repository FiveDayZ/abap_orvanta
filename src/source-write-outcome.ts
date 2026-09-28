import type { SourceMutationInfo } from "./backend.js"
import { redactDiagnosticText } from "./runtime-diagnostics.js"

/**
 * The stored read-back error is remote text, so it is redacted and bounded like every other piece of
 * remote diagnostic text this service keeps. The bound is shared with the receipt schema: a value
 * longer than the schema allows would make the whole receipt unreadable, and an unreadable receipt
 * keeps the write lock fail closed. The untruncated text stays in the tool answer, where
 * `SOURCE_READBACK_UNAVAILABLE` carries it as an activation message.
 */
export const MAX_READBACK_ERROR = 2000

function boundedReadbackError(value: string): string {
  return redactDiagnosticText(value).slice(0, MAX_READBACK_ERROR)
}

/**
 * What SAP holds *after* a source write that was saved but not activated.
 *
 * 2026-09-28 09:59 (ZCL_PMC_TP_REPACK): the replacement removed a declaration the still-active
 * version used, so the save landed as an inactive draft and the activation failed. The tool reported
 * the two fingerprints that determine that state - active = 797b42c5… (unchanged), inactive =
 * 4796620e… (exactly the candidate) - and the receipt in the same answer still said
 * `outcomeMayBeUnknown: true`, which tells the caller to reconcile a state this service had just
 * finished measuring. Overstating uncertainty is not the safe direction: it is the same defect class
 * as the 2026-09-26 09:55 false fingerprint mismatch, where an operation that had landed was
 * reported as unknown.
 *
 * The rule lives here, once: a post-state is *determined* only when read-back shows SAP holding
 * exactly the candidate as an inactive draft while the active version is something else. Everything
 * else - a read-back error, a missing fingerprint, a draft that differs from the candidate - stays
 * unknown.
 */
export interface SourceWriteOutcome {
  saveSucceeded: boolean
  unlockSucceeded: boolean
  activationAttempted: boolean | null
  activationSucceeded: boolean
  /** The candidate this service asked SAP to store, not what SAP kept. */
  intendedFingerprint: string | null
  activeFingerprint: string | null
  inactiveFingerprint: string | null
  readbackError: string | null
}

/**
 * The backend's write result, as the receipt reports it. One translation point: the field names
 * below are the ones the tool text and the write-operation receipt both use, so the two renderings
 * cannot drift apart.
 */
export function sourceWriteOutcome(result: SourceMutationInfo): SourceWriteOutcome {
  return {
    saveSucceeded: result.saveSucceeded ?? true,
    unlockSucceeded: result.unlockSucceeded ?? true,
    activationAttempted: result.activationAttempted ?? null,
    activationSucceeded: result.activationSucceeded ?? result.activation.success,
    intendedFingerprint: result.sourceFingerprintAfter ?? null,
    activeFingerprint: result.activeFingerprint ?? null,
    inactiveFingerprint: result.inactiveFingerprint ?? null,
    // An empty string is "no error text", not a read-back error: storing it would fail the receipt
    // schema's minimum length and take the whole receipt down with it.
    readbackError: result.readbackError ? boundedReadbackError(result.readbackError) : null
  }
}

/**
 * True only when the post-state was measured, never when it was inferred.
 *
 * `inactiveFingerprint === intendedFingerprint` proves the draft is byte-for-byte the candidate and
 * `activeFingerprint !== intendedFingerprint` proves the change is not active. A failed read-back
 * (`readbackError`) disqualifies it: the active version was not read, so "unchanged" would be an
 * assumption. A failed unlock disqualifies it too - the lock state is unresolved.
 */
export function sourceWriteOutcomeIsDetermined(outcome: SourceWriteOutcome): boolean {
  return (
    outcome.saveSucceeded &&
    outcome.unlockSucceeded &&
    !outcome.activationSucceeded &&
    outcome.readbackError === null &&
    outcome.intendedFingerprint !== null &&
    outcome.inactiveFingerprint !== null &&
    outcome.inactiveFingerprint === outcome.intendedFingerprint &&
    outcome.activeFingerprint !== outcome.intendedFingerprint
  )
}

/** The payload both the tool text and the receipt render, from this one object. */
export function sourceWriteOutcomePayload(outcome: SourceWriteOutcome): Record<string, unknown> {
  return { ...outcome, automaticRetry: false, automaticRollback: false }
}

/**
 * A write that reached SAP, saved, and did not activate.
 *
 * It carries the observation rather than only a message because the receipt layer has to decide the
 * outcome from data, not from prose. `recoveryGuide` names the next call for the determined case, so
 * the machine-readable receipt is as actionable as the error text.
 */
export class SourceSavedNotActivatedError extends Error {
  readonly outcome: SourceWriteOutcome
  readonly recoveryGuide: string

  constructor(message: string, outcome: SourceWriteOutcome, recoveryGuide: string) {
    super(message)
    this.name = "SourceSavedNotActivatedError"
    this.outcome = outcome
    this.recoveryGuide = recoveryGuide
  }
}

export function isSourceSavedNotActivatedError(
  value: unknown
): value is SourceSavedNotActivatedError {
  // The class identity survives the tool boundary because nothing between the tool and the receipt
  // layer rewraps it; the name check keeps a structured clone (or a future wrapper) recognizable.
  return (
    value instanceof SourceSavedNotActivatedError ||
    (value instanceof Error && value.name === "SourceSavedNotActivatedError")
  )
}

/**
 * What the caller does next, in the determined case: repair the draft that is already on SAP under
 * the fingerprint the read-back returned. The active version is untouched, so nothing has to be
 * reconciled first and the original replacement must not be repeated (the draft already holds it).
 */
export function sourceWriteRecoveryGuide(outcome: SourceWriteOutcome, objectName: string): string {
  if (!sourceWriteOutcomeIsDetermined(outcome)) {
    return (
      `Read back ${objectName} from SAP and compare it with the pre-change summary and the requested ` +
      `change: this service did not receive a read-back that determines what SAP now holds. Do not ` +
      `repeat the same replacement. Reconcile the active and inactive source before using ` +
      `abap_activate on the approved object, and if the state is interrupted or uncertain, resolve ` +
      `locks and transport assignment in SAP before using a new operationId.`
    )
  }
  return (
    `${objectName} holds the intended text as an inactive draft (${String(outcome.inactiveFingerprint)}) ` +
    `and the active version is unchanged (${String(outcome.activeFingerprint)}). Repair that draft by ` +
    `calling replace_string_in_abap_object again with recoverInactiveSource=true and ` +
    `expectedSourceFingerprint set to the draft fingerprint above, then activate and read back. Do not ` +
    `repeat the original replacement and do not re-read the active version to build a new oldString: ` +
    `the draft already contains it.`
  )
}
