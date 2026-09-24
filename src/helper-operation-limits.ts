/**
 * Every MCP SAP helper receives the operation to run in `IV_OPERATION`, whose DDIC type fixes the
 * maximum length of an operation name:
 *
 * - `Z_ORVANTA_MCP_DDIC_API` : `VALUE(IV_OPERATION) LIKE BAPIRET2-PARAMETER` -> `BAPI_PARAM`, CHAR 32
 * - `Z_ORVANTA_MCP_DYNPRO_API` / `Z_ORVANTA_MCP_EXECUTE` : `LIKE RS38L-NAME` -> `RS38L_FNAM`, CHAR 30
 *
 * The generator assigns that type from one place (`$operationDbField` in
 * `scripts/bootstrap-sap-helper.ps1`: `BAPIRET2-PARAMETER` for the DDIC helper, `RS38L-NAME` for
 * every other helper), which is also why the limit is per helper and not one global constant: an
 * operation of 31 or 32 characters fits the DDIC helper and is unreachable in the shared
 * repository body that `Z_ORVANTA_MCP_EXECUTE` and `Z_ORVANTA_MCP_DYNPRO_API` both deploy.
 *
 * Verified live on w200 (client 200) on 2026-09-22: the DDIC helper interface line is
 * `VALUE(IV_OPERATION) LIKE  BAPIRET2-PARAMETER`, and `DD03L` reports `LENG 000032` for
 * `BAPIRET2-PARAMETER` and `000030` for `RS38L-NAME`.
 *
 * A longer operation name is truncated by the RFC layer before the helper's `CASE iv_operation`
 * runs, so the `WHEN` arm can never match and the helper answers `OPERATION_NOT_SUPPORTED` (DDIC)
 * or `OPERATION_NOT_ALLOWED` (repository) even though its own capability list advertises the
 * operation. Four delivered operations were exposed that way and have since been renamed to fit:
 *
 * - `RESUME_TRANSPARENT_TABLE_ACTIVATION` (35, DDIC) -> `RESUME_TABLE_ACTIVATION` (24)
 * - `READ_ENHANCEMENT_IMPLEMENTATION` (31, repository) -> `READ_ENHANCEMENT_IMPL` (21)
 * - `DELETE_ENHANCEMENT_IMPLEMENTATION` (33, repository) -> `DELETE_ENHANCEMENT_IMPL` (23)
 * - `MANAGE_CLASSIC_BADI_IMPLEMENTATION` (34, repository) -> `MANAGE_CLASSIC_BADI_IMPL` (24)
 *
 * The service therefore refuses to send an operation that cannot be delivered, before any SAP
 * call, instead of relying on the helper to reject it.
 */
import { PreSapValidationError } from "./pre-sap-validation.js"

export interface HelperOperationParameter {
  /** DDIC type of the helper's `IV_OPERATION` import parameter. */
  ddicType: string
  /** Character length of that DDIC type. */
  length: number
}

/**
 * Character length of each DDIC type that carries a helper's `IV_OPERATION`.
 *
 * Read-only evidence, w200 client 200 on 2026-09-22: `DD03L` reports `BAPIRET2-PARAMETER` with
 * `LENG 000032` and `RS38L-NAME` with `LENG 000030`. The limit a helper enforces is therefore a
 * property of the parameter type its generator declares, and this table is what turns that type
 * into a number. `test/helper-operation-limits.test.ts` checks the generator's declaration against
 * it, so neither can drift alone.
 */
export const OPERATION_PARAMETER_TYPE_LENGTHS: Readonly<Record<string, number>> = {
  "BAPIRET2-PARAMETER": 32,
  "RS38L-NAME": 30
}

export const HELPER_OPERATION_PARAMETERS: Readonly<Record<string, HelperOperationParameter>> = {
  Z_ORVANTA_MCP_DDIC_API: { ddicType: "BAPIRET2-PARAMETER", length: 32 },
  Z_ORVANTA_MCP_DYNPRO_API: { ddicType: "RS38L-NAME", length: 30 },
  Z_ORVANTA_MCP_EXECUTE: { ddicType: "RS38L-NAME", length: 30 }
}

/**
 * Operations that exceed their helper's `IV_OPERATION` length and are therefore not deliverable.
 *
 * It must stay EMPTY, and it is deliberately still exported: an over-long operation is a defect to
 * rename, never a state to record, so an entry here is a claim that a shipped tool is dead while
 * its capability report still says `available`. The list exists so that a future over-long
 * operation becomes an explicit, reviewable entry that fails the test suite, instead of a silent
 * truncation that only shows up as `OPERATION_NOT_SUPPORTED` on the target system.
 */
export const HELPER_OPERATIONS_BLOCKED_BY_PARAMETER_LENGTH: readonly {
  helper: string
  operation: string
  tool: string
}[] = []

export function helperOperationParameter(helper: string): HelperOperationParameter | undefined {
  return HELPER_OPERATION_PARAMETERS[helper.toUpperCase()]
}

/**
 * Raised before any SAP call when an operation cannot be delivered to its helper.
 *
 * The receipt builder treats this error as proof that SAP was never contacted, so a rejected
 * operation is reported as `sapInvocationStarted: false` / `outcomeMayBeUnknown: false` instead of
 * leaving the caller unable to tell whether the write reached SAP.
 */
export class HelperOperationNotDeliverableError extends PreSapValidationError {
  readonly helper: string
  readonly operation: string
  readonly parameterLength: number

  constructor(
    helper: string,
    operation: string,
    parameter: HelperOperationParameter,
    blocked: boolean
  ) {
    const truncated = operation.slice(0, parameter.length)
    super(
      `HELPER_OPERATION_NOT_DELIVERABLE: operation "${operation}" is ${operation.length} characters, ` +
        `but ${helper.toUpperCase()} declares IV_OPERATION as ${parameter.ddicType} ` +
        `(${parameter.length} characters), so SAP would receive "${truncated}" and the helper would ` +
        `reject it. The operation was not sent and no SAP state changed.` +
        (blocked
          ? ` This operation is known to be blocked: redeploy the helper body with an opcode of at most ${parameter.length} characters.`
          : "")
    )
    this.name = "HelperOperationNotDeliverableError"
    this.helper = helper.toUpperCase()
    this.operation = operation
    this.parameterLength = parameter.length
  }
}

/**
 * Reject an operation that the target helper cannot receive, before any SAP call.
 *
 * The message keeps the helper, the declared DDIC type, the limit and the truncated value the
 * helper would have seen, so the caller can correct the operation instead of guessing why SAP
 * reported an unsupported operation.
 */
export function assertHelperOperationDeliverable(helper: string, operation: string): void {
  const parameter = helperOperationParameter(helper)
  if (!parameter) return
  if (operation.length <= parameter.length) return
  const blocked = HELPER_OPERATIONS_BLOCKED_BY_PARAMETER_LENGTH.some(
    (entry) => entry.helper === helper.toUpperCase() && entry.operation === operation
  )
  throw new HelperOperationNotDeliverableError(helper, operation, parameter, blocked)
}
