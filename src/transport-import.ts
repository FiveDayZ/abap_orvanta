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
 * `INSPECT_TRANSPORT_IMPORT`, protocol 2.18, and it is a read (`R`).
 *
 * The callee is `TMS_TP_IMPORT`, and the arm calls it in SAP's own simulation mode (`SIMULATE_MODE`
 * is the literal `L`). What that mode does is SAP's behaviour, not something this tool has verified:
 * the first real calls on w200 (2026-09-29) came back with the callee's own messages about starting
 * `tp` and about a request's import having already run, so the arm makes no claim that no `tp`
 * process was started. What the arm does establish structurally is that neither the system name nor
 * the simulate mode crosses the interface, so no caller can ask it for a real import.
 *
 * `VERDICT` is the callee's own exception name, not this service's reading of it, and the helper
 * emits it on every path together with the raw `CALLEE_SUBRC`. That is the 2.18 correction: the 2.17
 * arm translated the number into a meaning (1 into `no-authority`, 2 into `not-allowed`) and dropped
 * every payload row when it reported a failure. Nine real calls on w200 on 2026-09-29 showed the
 * translation was wrong in both directions - a failed tp start was labelled a refusal, and a refusal
 * was labelled a failure - and the same request returned two different outcomes minutes apart. The
 * arm now reports what SAP raised, so a caller reads the callee's own vocabulary (`enqueue_failed`,
 * `tp_reported_info`, ...) beside the callee's own message and decides what it means.
 *
 * A declared exception is the callee answering the question, so it travels under
 * `TRANSPORT_IMPORT_CHECKED` even when the answer is no; only an undeclared one (`CALLEE_SUBRC` 99)
 * is a malfunction and reports `TRANSPORT_IMPORT_CHECK_FAILED` - and it carries the same rows, so it
 * is still attributable to a request.
 *
 * The one side effect the arm does disclose is the callee's own `TMS_TP_IMPORT_DEQUEUE`, which
 * clears stale TMS locks for the system before the checks run. The import buffer is deliberately not
 * read - on this release it is not a table - so the reply reports the request's own `E070` status in
 * this system instead and claims nothing about buffer membership.
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
 * precheck is an answer, and the verdict it carries is what says so. From 2.18 that verdict is the
 * callee's own exception name, so the answer states which exception SAP raised instead of a meaning
 * this service inferred from the number.
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

/**
 * Every verdict the 2.18 arm can send: the callee's own exception names, plus `importable` for the
 * no-exception answer. `unknown` is the arm's name for an undeclared exception. A word outside this
 * set is replaced rather than passed through, for the same reason an unknown code is: the helper is
 * version-gated, so an unlisted verdict means something is wrong with the reply, and letting an
 * ad-hoc string through would make it look like part of the contract.
 */
export const TRANSPORT_IMPORT_VERDICTS = [
  "importable",
  "permission_denied",
  "import_not_allowed",
  "enqueue_failed",
  "tp_call_failed",
  "tp_interface_error",
  "tp_reported_error",
  "tp_reported_info",
  "unknown"
] as const

export type TransportImportVerdict = (typeof TRANSPORT_IMPORT_VERDICTS)[number]

export function transportImportVerdict(value: string): string {
  const lower = value.trim().toLowerCase()
  return (TRANSPORT_IMPORT_VERDICTS as readonly string[]).includes(lower) ? lower : "unknown"
}

export const TRANSPORT_IMPORT_WARNINGS = [
  "This is a precheck, not an import. It never puts the request into the import buffer and never applies an object: the helper calls TMS_TP_IMPORT in SAP's own simulation mode, which runs the callee's own checks. That the mode exits before the tp call is SAP's documented behaviour and is NOT verified by this tool - the callee's own messages on the first real calls on w200 named tp - so this reply makes no claim that no tp process was started.",
  "An importable verdict is a readiness answer, not a promise. It reports that the callee raised no exception at the moment of the call; it does not prove the request is in this system's import buffer, and it cannot say the objects will apply cleanly.",
  "The import buffer is deliberately not read. On this release it is not a table, so this tool reports the request's own E070 status in this system as LOCAL_E070_STATUS (or not-found) and makes no claim about buffer membership.",
  "The call is not free of side effects: the callee's own TMS_TP_IMPORT_DEQUEUE clears stale TMS locks for the system before it runs the checks. Nothing is enqueued and no object is changed.",
  "The verdict is the callee's own exception name, reported verbatim with the raw calleeSubrc, and this tool does not interpret it. Which of those exceptions means the checks refused the request and which means the callee could not do its job is the callee's own vocabulary and is not established here - a real call on w200 returned enqueue_failed, a name that reads like a malfunction, for a request whose message said its import had already run. Read verdict and calleeSubrc beside helperMessage, which is the callee's own text, and treat all three as the reply's evidence rather than as a conclusion about the request.",
  "An undeclared exception is the one malfunction this tool reports as an error: it arrives as calleeSubrc 99, a verdict of unknown and the code TRANSPORT_IMPORT_CHECK_FAILED, and it still carries the request number and the local E070 status so it can be attributed.",
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
  /**
   * The callee's raw `sy-subrc`, or `null` when the reply carried no `CALLEE_SUBRC` row. It is what
   * makes the verdict checkable rather than trusted: a caller can map the number back to the
   * exception list the arm declares and see that `verdict` is a name, not an interpretation.
   */
  readonly calleeSubrc: number | null
  readonly localE070Status: string
  readonly helperMessage: string
  readonly warnings: readonly string[]
}

/**
 * Turn a helper reply for `INSPECT_TRANSPORT_IMPORT` into the caller-visible result.
 *
 * Success must carry a verdict and a sub-return code: a reply that claims `S` without them cannot
 * say what the checks decided or which exception they raised, and that is an invalid reply - not a
 * precheck whose evidence went missing, and not a refusal. Both are required rather than optional
 * because the 2.18 helper emits them on every path, so their absence means the reply did not come
 * from the arm this contract describes.
 *
 * The echoed number and the reported status come from the reply rather than from the request, so a
 * caller compares what SAP checked with what it asked for.
 */
export function transportImportResult(
  connectionId: string,
  reply: ImportHelperReply
): ImportTransportQueueResult {
  const ok = reply.status.toUpperCase() === "S"
  const rawVerdict = (reply.metadata["VERDICT"] ?? "").trim()
  const rawSubrc = (reply.metadata["CALLEE_SUBRC"] ?? "").trim()
  const calleeSubrc = /^\d{1,3}$/.test(rawSubrc) ? Number(rawSubrc) : null
  if (ok && (rawVerdict === "" || calleeSubrc === null)) {
    throw new Error("TRANSPORT_RESPONSE_INVALID")
  }
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
    verdict: transportImportVerdict(rawVerdict),
    calleeSubrc,
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
