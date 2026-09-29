import { z } from "zod"
import { transportNumberSchema } from "./transport-delivery.js"
import { transportPayloadRows } from "./transport-release.js"

/**
 * Transport import precheck (OP2, the `transport` scenario family).
 *
 * Why this cannot be a plain service-side RFC call: the CTS ADT surface on this platform is
 * read-only (its only advertised paths are `/sap/bc/cts/transports` and
 * `/sap/bc/cts/transportchecks`, and neither imports anything), and the TMS entry points report
 * `remoteEnabled = false` on this release, so the only route is a branch inside the SAP-side
 * repository helper - exactly like the release next to it. The helper branch is
 * `INSPECT_TRANSPORT_IMPORT`, protocol 2.17, and it is a read (`R`).
 *
 * The callee is `TMS_TP_IMPORT`, and the arm calls it in SAP's own simulation mode (`SIMULATE_MODE`
 * is the literal `L`): the callee runs its authority, project, predecessor and CVERS checks and then
 * exits before the import buffer enqueue and before the `tp` call. Nothing is enqueued, no object is
 * applied and no `tp` is started. Neither the system name nor the simulate mode crosses the
 * interface, so no caller can ask this arm to import.
 *
 * A refused check is the answer to the question, not a failure: `VERDICT` is `no-authority` when the
 * SAP user lacks the CTS authority (`S_CTS_ADMI` and `S_CTS_ADM` with `CTS_ADMFCT`) and
 * `not-allowed` when a project, predecessor or CVERS check refused. Both arrive as the success code
 * `TRANSPORT_IMPORT_CHECKED`. Only a malfunction is an error.
 *
 * The one side effect is the callee's own `TMS_TP_IMPORT_DEQUEUE`, which clears stale TMS locks for
 * the system before the checks run. The import buffer is deliberately not read - on this release it
 * is not a table - so the reply reports the request's own `E070` status in this system instead and
 * claims nothing about buffer membership.
 */

export const importTransportQueueSchema = z
  .object({
    connectionId: z.string().min(1).max(32),
    transportNumber: transportNumberSchema,
    /**
     * Accepted for call-shape parity with `release_transport_task` and deliberately unused: a
     * precheck reserves no write receipt, so there is no operation to key and no idempotency to
     * protect.
     */
    operationId: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,64}$/)
      .optional()
  })
  .strict()

export type ImportTransportQueueInput = z.input<typeof importTransportQueueSchema>
export type ImportTransportQueueParsed = z.infer<typeof importTransportQueueSchema>

/**
 * Every code a caller can receive. A code the helper does not send is replaced by
 * `TRANSPORT_IMPORT_CHECK_FAILED` rather than passed through, so an ad-hoc helper string can never
 * look like part of this contract.
 *
 * `TRANSPORT_IMPORT_CHECKED` is the success code even when the checks refuse the import: a refused
 * precheck is an answer, and the verdict it carries (`not-allowed`, `no-authority`) is what says so.
 * `TRANSPORT_NUMBER_REQUIRED` and `TRANSPORT_NUMBER_INVALID` are the arm's own input refusals, which
 * arrive before the callee is called at all.
 */
export const TRANSPORT_IMPORT_CODES = [
  "TRANSPORT_IMPORT_CHECK_FAILED",
  "TRANSPORT_NUMBER_REQUIRED",
  "TRANSPORT_NUMBER_INVALID",
  "TRANSPORT_IMPORT_CHECKED",
  "TRANSPORT_HELPER_UNSUPPORTED",
  "TRANSPORT_RESPONSE_INVALID"
] as const

export type TransportImportCode = (typeof TRANSPORT_IMPORT_CODES)[number]

export function transportImportCode(value: string): string {
  const upper = value.trim().toUpperCase()
  return (TRANSPORT_IMPORT_CODES as readonly string[]).includes(upper)
    ? upper
    : "TRANSPORT_IMPORT_CHECK_FAILED"
}

export const TRANSPORT_IMPORT_WARNINGS = [
  "This is a precheck, not an import. It never puts the request into the import buffer, never runs tp and never applies an object: the helper calls TMS_TP_IMPORT in SAP's own simulation mode, which runs the checks and then exits before the buffer enqueue and before the tp call.",
  "The verdict is a readiness answer, not a promise. It reports that SAP's authority, project, predecessor and CVERS checks raised no objection at the moment of the call; it does not prove the request is in this system's import buffer, and it cannot say the objects will apply cleanly.",
  "The import buffer is deliberately not read. On this release it is not a table, so this tool reports the request's own E070 status in this system as LOCAL_E070_STATUS (or not-found) and makes no claim about buffer membership.",
  "The call is not free of side effects: the callee's own TMS_TP_IMPORT_DEQUEUE clears stale TMS locks for the system before it runs the checks. Nothing is enqueued and no object is changed.",
  "A refused check is reported as a verdict, not as a failure: VERDICT is no-authority when the SAP user lacks the CTS authority (S_CTS_ADMI and S_CTS_ADM with CTS_ADMFCT), and not-allowed when a project, predecessor or CVERS check refused. Only a malfunction is reported as an error.",
  "The transport number is validated on both sides, and neither side is the looser one: the service accepts only the 10-character shape a request number has in this system (three characters, then K, then six, all A-Z and 0-9), and the helper re-checks the length and rejects any character outside A-Z, a-z, 0-9 and underscore before it calls the callee."
] as const

/** The helper's reply: `status`/`code`/`message` plus `M|`/`G|` payload rows. */
export interface ImportHelperReply {
  readonly status: string
  readonly code: string
  readonly message: string
  readonly metadata: Readonly<Record<string, string>>
  readonly messages: readonly { readonly msgty: string; readonly text: string }[]
}

export interface ImportTransportQueueResult {
  readonly action: "inspect-import"
  readonly connectionId: string
  readonly readOnly: true
  readonly status: "ok" | "failed"
  readonly code: string
  readonly message: string
  readonly transportNumber: string
  readonly simulateMode: string
  readonly importable: boolean
  readonly verdict: string
  readonly localE070Status: string
  readonly helperMessage: string
  readonly warnings: readonly string[]
}

/**
 * Turn a helper reply for `INSPECT_TRANSPORT_IMPORT` into the caller-visible result.
 *
 * Success must carry a verdict: a reply that claims `S` without one cannot say what the checks
 * decided, and that is an invalid reply - not a precheck whose evidence went missing, and not a
 * refusal. The echoed number and the reported status come from the reply rather than from the
 * request, so a caller compares what SAP checked with what it asked for.
 */
export function transportImportResult(
  connectionId: string,
  reply: ImportHelperReply
): ImportTransportQueueResult {
  const ok = reply.status.toUpperCase() === "S"
  const verdict = (reply.metadata["VERDICT"] ?? "").trim()
  if (ok && verdict === "") throw new Error("TRANSPORT_RESPONSE_INVALID")
  return {
    action: "inspect-import",
    connectionId,
    readOnly: true,
    status: ok ? "ok" : "failed",
    code: transportImportCode(reply.code),
    message: reply.message,
    transportNumber: (reply.metadata["TRKORR"] ?? "").trim(),
    simulateMode: (reply.metadata["SIMULATE_MODE"] ?? "").trim(),
    importable: (reply.metadata["IMPORTABLE"] ?? "").trim().toUpperCase() === "X",
    verdict,
    localE070Status: (reply.metadata["LOCAL_E070_STATUS"] ?? "").trim(),
    helperMessage: (reply.metadata["MESSAGE"] ?? "").trim(),
    warnings: TRANSPORT_IMPORT_WARNINGS
  }
}

/**
 * The import precheck reads the same `M|`/`G|` payload rows as the release branch, so both transport
 * tools are served by one parser (see `transportPayloadRows`) rather than by two dialects that could
 * drift apart.
 */
export { transportPayloadRows }
