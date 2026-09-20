/**
 * Why a payload reports `qualityGate: "not_evaluated"`.
 *
 * `not_evaluated` is a truthful verdict, but on its own it is ambiguous in a way that matters: a
 * caller that only reads the gate value cannot tell "no check ran" from "a check ran, but it was
 * not the native ATC gate", and both have been read as *passing*. `gateReason` carries that
 * distinction explicitly.
 *
 * The vocabulary is deliberately closed. Anything that reports a quality gate should use one of
 * these values rather than a free-form string, so the reasons stay comparable across tools.
 */

/** The gate value that always accompanies a `gateReason`. */
export const QUALITY_GATE_NOT_EVALUATED = "not_evaluated" as const

export type QualityGateReason =
  /** The gate was not executed at all: nothing was run, so nothing can be concluded. */
  | "not_run"
  /** Something executed and returned findings, but it is not the native ATC gate. Never ATC. */
  | "not_native_atc"
  /**
   * Engines executed - possibly including native ATC - but this service reports their output and
   * does not compute a pass/fail gate. `status: "completed"` means "the engine returned", never
   * "quality passed".
   */
  | "no_gate_verdict"
  /** This payload reports no quality gate; the field is present for a uniform response shape. */
  | "not_a_quality_gate"

export const QUALITY_GATE_REASON_NOT_RUN: QualityGateReason = "not_run"
export const QUALITY_GATE_REASON_NOT_NATIVE_ATC: QualityGateReason = "not_native_atc"
export const QUALITY_GATE_REASON_NO_GATE_VERDICT: QualityGateReason = "no_gate_verdict"
export const QUALITY_GATE_REASON_NOT_A_QUALITY_GATE: QualityGateReason = "not_a_quality_gate"

/**
 * The `qualityGate` / `gateReason` pair, so a call site cannot set the gate and forget the reason
 * or the other way round.
 */
export function qualityGateNotEvaluated(reason: QualityGateReason): {
  qualityGate: typeof QUALITY_GATE_NOT_EVALUATED
  gateReason: QualityGateReason
} {
  return { qualityGate: QUALITY_GATE_NOT_EVALUATED, gateReason: reason }
}
