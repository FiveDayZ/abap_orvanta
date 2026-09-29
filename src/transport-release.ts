import { z } from "zod"
import { transportNumberSchema } from "./transport-delivery.js"

/**
 * Transport release (OP2, the `transport` scenario family).
 *
 * Why this cannot be a plain service-side RFC call: on this release `TRINT_RELEASE_REQUEST` - the
 * function module the transport organizer calls to release a request - reports
 * `remoteEnabled = false` (read from its interface on w200 on 2026-09-29), and the CTS ADT surface
 * on this platform is read-only (its only advertised paths are `/sap/bc/cts/transports` and
 * `/sap/bc/cts/transportchecks`; there is no import or release resource). The only route is a
 * branch inside the SAP-side repository helper, exactly like SM12 release and job control. The
 * helper branch is `RELEASE_TRANSPORT_TASK`, protocol 2.16.
 *
 * What the callee demands, read from its interface in the same round:
 *   * `IV_TRKORR` (`E070-TRKORR`) is the only required input; every other input is an optional
 *     `TRBOOLEAN` flag, so nothing structured has to cross the boundary.
 *   * It raises 17 typed exceptions, so the failure reason is a named condition rather than a
 *     return code this service would have to interpret. `NO_AUTHORIZATION` is the CTS authority
 *     refusal (`S_CTS_ADMI`/`S_CTS_ADM`), which the helper reports as `TRANSPORT_NO_AUTHORITY`
 *     instead of attempting a release the SAP user is not entitled to.
 *   * Its `ES_REQUEST`/`ET_DELETED_TASKS` exports are `TRWBO_REQUEST`/`TRWBO_T_E070`, which are
 *     NOT DDIC objects (`read_ddic_structure` reports not-found on w200). The helper therefore does
 *     not declare or read them, and proves the release by re-reading `E070` and requiring the
 *     request to have left the modifiable states instead.
 *
 * Releasing a request also releases its tasks and exports its objects to the request's target
 * system. That is an irreversible step on a different system, so this tool demands the caller name
 * the exact request twice: the number it read and the same number as an explicit release intent.
 * The helper refuses the call when the two differ.
 */

/** The confirmation string a release demands, checked before SAP is touched. */
export const TRANSPORT_RELEASE_CONFIRMATION = "RELEASE_TRANSPORT"

export const releaseTransportTaskSchema = z
  .object({
    connectionId: z.string().min(1).max(32),
    transportNumber: transportNumberSchema,
    /**
     * The same transport number again. It exists so that a release cannot be issued by a caller
     * that only pattern-matched the first field: the helper compares the two and refuses a
     * mismatch, which is the check that keeps a wrong request from being exported.
     */
    releaseRequest: transportNumberSchema,
    confirmation: z.literal("RELEASE_TRANSPORT"),
    operationId: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,64}$/)
      .optional()
  })
  .strict()

export type ReleaseTransportTaskInput = z.input<typeof releaseTransportTaskSchema>
export type ReleaseTransportTaskParsed = z.infer<typeof releaseTransportTaskSchema>

/**
 * Every code a caller can receive. A code the helper does not send is replaced by
 * `TRANSPORT_RELEASE_FAILED` rather than passed through, so an ad-hoc helper string can never look
 * like part of this contract.
 *
 * `TRANSPORT_NOT_MODIFIABLE` and `TRANSPORT_STILL_MODIFIABLE` are the two ends of the same proof:
 * the helper refuses to release a request that is not in a modifiable state, and refuses to report
 * success while the request is still modifiable afterwards.
 */
export const TRANSPORT_RELEASE_CODES = [
  "TRANSPORT_RELEASE_FAILED",
  "TRANSPORT_NUMBER_REQUIRED",
  "TRANSPORT_NUMBER_INVALID",
  "TRANSPORT_NOT_FOUND",
  "TRANSPORT_NOT_MODIFIABLE",
  "TRANSPORT_IDENTITY_MISMATCH",
  "TRANSPORT_NO_AUTHORITY",
  "TRANSPORT_ALREADY_RELEASED",
  "TRANSPORT_OBJECT_CHECK_FAILED",
  "TRANSPORT_EXPORT_FAILED",
  "TRANSPORT_READBACK_FAILED",
  "TRANSPORT_STILL_MODIFIABLE",
  "TRANSPORT_HELPER_UNSUPPORTED",
  "TRANSPORT_RESPONSE_INVALID",
  "TRANSPORT_RELEASED"
] as const

export type TransportReleaseCode = (typeof TRANSPORT_RELEASE_CODES)[number]

export function transportReleaseCode(value: string): string {
  const upper = value.trim().toUpperCase()
  return (TRANSPORT_RELEASE_CODES as readonly string[]).includes(upper)
    ? upper
    : "TRANSPORT_RELEASE_FAILED"
}

export const TRANSPORT_RELEASE_WARNINGS = [
  "Releasing a request exports its objects to the request's target system and cannot be undone from this service. The service does not decide which request matters: every release names the exact request twice, carries a confirmation string and is its own tool call.",
  "Releasing the request also releases its tasks. Objects that live in a task travel with the request, so a task with objects is exported even when the request header itself lists none.",
  "The state is resolved against E070 when the call runs, not against the transport list the caller kept: a request that is no longer modifiable is refused as TRANSPORT_NOT_MODIFIABLE instead of being reported as released.",
  "Success is proved by re-reading E070 and requiring the status to be R (released) or O (released and imported), never by the callee's own return value.",
  "The CTS authority objects apply (S_CTS_ADMI and S_CTS_ADM with CTS_ADMFCT). A release the SAP user is not authorized for is refused by the helper as TRANSPORT_NO_AUTHORITY, not attempted.",
  "The helper does not perform a COMMIT WORK of its own for this operation: the callee owns its export work. A release that fails still leaves a transport log entry in the target system's queue history.",
  "The idempotency key is a local receipt, not a SAP-side reservation. It proves what this service sent, never what E070 holds."
] as const

/** The helper's reply: `status`/`code`/`message` plus `M|`/`G|` payload rows. */
export interface TransportHelperReply {
  readonly status: string
  readonly code: string
  readonly message: string
  readonly metadata: Readonly<Record<string, string>>
  readonly messages: readonly { readonly msgty: string; readonly text: string }[]
}

export interface TransportReleaseResult {
  readonly action: "release"
  readonly connectionId: string
  readonly readOnly: false
  readonly status: "ok" | "failed"
  readonly code: string
  readonly message: string
  readonly transport: {
    readonly number: string
    readonly statusBefore: string
    readonly statusAfter: string
  }
  readonly released: boolean
  readonly confirmation: string
  readonly messages: readonly { readonly type: string; readonly text: string }[]
  readonly readBack: {
    readonly performed: boolean
    readonly statusAfter: string | null
    readonly calleeReturnCode: string | null
  }
  readonly idempotencyKey: string | null
  readonly warnings: readonly string[]
}

/**
 * Turn a helper reply for `RELEASE_TRANSPORT_TASK` into the caller-visible result.
 *
 * Success must carry the helper's own release marker: a reply that claims `S` without it is an
 * invalid reply, not a release whose evidence went missing. The echoed number and statuses come from
 * the reply rather than from the request, so a caller compares what SAP acted on with what it asked
 * for.
 */
export function transportReleaseResult(
  connectionId: string,
  reply: TransportHelperReply
): TransportReleaseResult {
  const ok = reply.status.toUpperCase() === "S"
  const released = (reply.metadata["RELEASED"] ?? "").trim().toUpperCase()
  if (ok && released !== "X") throw new Error("TRANSPORT_RESPONSE_INVALID")
  const statusAfter = (reply.metadata["STATUS_AFTER"] ?? "").trim()
  return {
    action: "release",
    connectionId,
    readOnly: false,
    status: ok ? "ok" : "failed",
    code: transportReleaseCode(reply.code),
    message: reply.message,
    transport: {
      number: (reply.metadata["TRKORR"] ?? "").trim(),
      statusBefore: (reply.metadata["STATUS_BEFORE"] ?? "").trim(),
      statusAfter
    },
    released: ok,
    confirmation: TRANSPORT_RELEASE_CONFIRMATION,
    messages: reply.messages.map((entry) => ({
      type: entry.msgty.trim(),
      text: entry.text
    })),
    readBack: {
      // The status is the evidence: the helper only answers S after re-reading E070 and finding a
      // released status. `performed` is false when the release never happened.
      performed: ok,
      statusAfter: ok ? statusAfter : null,
      calleeReturnCode: null
    },
    idempotencyKey: null,
    warnings: TRANSPORT_RELEASE_WARNINGS
  }
}

/**
 * Parse the helper's `M|`/`G|` payload rows.
 *
 * Strict on purpose: a malformed line is an error rather than a field that quietly went missing,
 * because a reply whose evidence cannot be read must not be reported as a successful release.
 */
export function transportPayloadRows(source: readonly string[]): {
  metadata: Record<string, string>
  messages: { msgty: string; text: string }[]
} {
  const metadata: Record<string, string> = {}
  const grouped = new Map<string, Record<string, string>>()
  for (const line of source) {
    const match = line.match(/^([A-Z]+)\|(\d+)\|([A-Z0-9_]+)\|(.*)$/)
    if (!match?.[1] || !match[2] || !match[3])
      throw new Error(`transport helper returned an invalid payload line: ${line}`)
    const value = (match[4] ?? "").replaceAll("%7C", "|").replaceAll("%25", "%")
    if (match[1] === "M") metadata[match[3]] = value
    else if (match[1] === "G") {
      const row = grouped.get(match[2]) ?? {}
      row[match[3]] = value
      grouped.set(match[2], row)
    } else throw new Error(`transport helper returned an unknown payload kind: ${line}`)
  }
  const messages = [...grouped.entries()]
    .sort((left, right) => Number(left[0]) - Number(right[0]))
    .map(([, row]) => ({ msgty: row["MSGTY"] ?? "", text: row["TEXT"] ?? "" }))
  return { metadata, messages }
}
