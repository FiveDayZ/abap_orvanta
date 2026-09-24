/**
 * Raised by a local guard that rejects the caller's request before the write reaches SAP.
 *
 * A write receipt reports `sapInvocationStarted`, and `outcomeMayBeUnknown` follows it. That flag
 * existing at all is the point: a caller that cannot tell whether a write reached SAP has to go and
 * reconcile SAP state by hand. Claiming the invocation started when a pure argument check refused
 * the request therefore costs the caller a manual recovery procedure for a state that cannot have
 * changed. Proven live on w200: `upsert_lock_object` refused `EZPMCTPRP` in 50 ms without any SAP
 * call and still answered `sapInvocationStarted: true` / `outcomeMayBeUnknown: true`.
 *
 * Throw this only where both hold: the guard inspects nothing but the caller's own arguments, and it
 * runs before the first backend call of its tool. `preSapValidation` exists so that a guard can make
 * that claim at the point where it is provable, instead of every helper it calls having to be
 * classified as safe or unsafe.
 */
export class PreSapValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PreSapValidationError"
  }
}

/**
 * Run one pure local guard and report any rejection as proof that SAP was not contacted.
 *
 * The closure must not touch the backend: it is what makes the claim true, so keep it to argument
 * checks. An error that is already a PreSapValidationError passes through unchanged so the original
 * name and message survive nesting.
 */
export function preSapValidation<T>(guard: () => T): T {
  try {
    return guard()
  } catch (error) {
    if (error instanceof PreSapValidationError) throw error
    throw new PreSapValidationError(error instanceof Error ? error.message : String(error))
  }
}
