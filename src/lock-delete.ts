import { z } from "zod"

/**
 * SM12 lock release (OP2, the `locks` scenario family).
 *
 * Why this cannot be a plain service-side RFC call: on this release `ENQUE_DELETE` - the function
 * module SM12 itself calls to drop a lock entry - reports `remoteEnabled = false` (read from its
 * interface on w200 on 2026-09-28), so the only route is a branch inside the SAP-side repository
 * helper, exactly like job control. The helper branch is `LOCK_DELETE`, protocol 2.15.
 *
 * What the callee demands, read from its source in the same round:
 *   * It has no `AUTHORITY-CHECK` of its own; SM12's program `RSENQRR2` checks object `S_ENQUE`
 *     with field `S_ENQ_ACT` - `DLOU` for the caller's own locks, `DLFU` for another user's lock,
 *     `ALL` as the full permission. The helper therefore performs that check itself.
 *   * Its key is the `SEQG3` row: it replays the row's own `GUSR`/`GUSRVB` to the kernel. The helper
 *     copies the row it just read instead of rebuilding one from caller input.
 *   * It exports `SUBRC` but never assigns it, so the helper's proof of success is the absence of
 *     the entry when the lock table is read again - not a return code.
 *
 * The identity a caller must supply is exactly what `search_sap_locks` reports for one entry
 * (owner, table, argument, mode, and the lock object when it is known), because a key the read side
 * did not produce is a key this write side cannot have observed.
 */

/** The confirmation string a release demands, checked before SAP is touched. */
export const LOCK_DELETE_CONFIRMATION = "DELETE_SAP_LOCK"

const username = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]{1,12}$/)
/** `SEQG3-GNAME` is `EQEGRANAME`, CHAR 30, and holds a table name. */
const tableName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_/]+$/)
  .max(30)
/** `SEQG3-GOBJ` is `EQEOBJ`, CHAR 16, and holds the lock object name. */
const lockObject = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_/]+$/)
  .max(16)
/**
 * `SEQG3-GARG` is `EQEGRAARG` (domain `EQDARG`, CHAR 150, lowercase). It is an exact key component,
 * so it is never translated to upper case and an empty argument means "the entry whose argument is
 * empty" - the helper matches the field value it read, not a pattern.
 */
const lockArgument = z
  .string()
  .max(150)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Control characters are not allowed")

/**
 * `SEQG3-GMODE`: `E` exclusive, `S` shared, `X` exclusive non-cumulative. A value outside this set
 * cannot identify an entry the kernel holds, so it is refused at the service boundary.
 */
export const lockModeSchema = z.enum(["E", "S", "X"])

export const deleteSapLockSchema = z
  .object({
    connectionId: z.string().min(1).max(32),
    username,
    tableName,
    argument: lockArgument,
    mode: lockModeSchema,
    lockObject: lockObject.optional(),
    confirmation: z.literal("DELETE_SAP_LOCK"),
    operationId: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,64}$/)
      .optional()
  })
  .strict()

export type DeleteSapLockInput = z.input<typeof deleteSapLockSchema>
export type DeleteSapLockParsed = z.infer<typeof deleteSapLockSchema>

/**
 * Every code a caller can receive. A code the helper does not send is replaced by
 * `LOCK_DELETE_FAILED` rather than passed through, so an ad-hoc helper string can never look like
 * part of this contract.
 *
 * `LOCK_NOT_FOUND` and `LOCK_STILL_PRESENT` are the two ends of the same proof: the helper refuses
 * to delete when no live entry matches the key, and refuses to report success when the entry is
 * still there afterwards.
 */
export const LOCK_DELETE_CODES = [
  "LOCK_DELETE_FAILED",
  "LOCK_KEY_INCOMPLETE",
  "LOCK_KEY_INVALID",
  "LOCK_MODE_INVALID",
  "LOCK_NO_AUTHORITY",
  "LOCK_NOT_FOUND",
  "LOCK_KEY_AMBIGUOUS",
  "LOCK_READ_FAILED",
  "LOCK_READ_LIMIT",
  "LOCK_DELETE_REFUSED",
  "LOCK_READBACK_FAILED",
  "LOCK_STILL_PRESENT",
  "LOCK_HELPER_UNSUPPORTED",
  "LOCK_RESPONSE_INVALID",
  "LOCK_DELETED"
] as const

export type LockDeleteCode = (typeof LOCK_DELETE_CODES)[number]

export function lockDeleteCode(value: string): string {
  const upper = value.trim().toUpperCase()
  return (LOCK_DELETE_CODES as readonly string[]).includes(upper) ? upper : "LOCK_DELETE_FAILED"
}

export const LOCK_DELETE_WARNINGS = [
  "Releasing a lock removes an entry another session is holding. The service does not decide which locks matter: every release names the exact key, a confirmation string and its own tool call.",
  "The key is resolved against the live lock table, not against the search result the caller kept: an entry that no longer exists is refused as LOCK_NOT_FOUND instead of being reported as released.",
  "Success is proved by the absence of the entry when the lock table is read again, never by the callee's own return code - ENQUE_DELETE exports SUBRC without ever assigning it.",
  "SM12's own authority objects apply: S_ENQUE/S_ENQ_ACT with DLOU for the caller's own locks, DLFU for another user's, or ALL. A release the SAP user is not authorized for is refused by the helper, not attempted.",
  "The lock table lives in the kernel's shared memory, so no commit is involved and none is claimed. The kernel still writes its SM12/GEO audit entry for the deletion.",
  "The idempotency key is a local receipt, not a SAP-side reservation. It proves what this service sent, never what the lock table holds."
] as const

/**
 * The helper's reply: `status`/`code`/`message` arrive in the SOAP envelope every repository
 * operation uses, while the lock facts arrive as `M|<index>|<KEY>|<value>` rows in `source`.
 */
export interface LockHelperReply {
  readonly status: string
  readonly code: string
  readonly message: string
  readonly metadata: Readonly<Record<string, string>>
}

/**
 * Parse the helper's payload rows. Strict on purpose: a malformed line is an error rather than a
 * field that quietly went missing, because a reply whose evidence cannot be read must not be
 * reported as a successful release.
 */
export function lockPayloadRows(source: readonly string[]): Readonly<Record<string, string>> {
  const metadata: Record<string, string> = {}
  for (const line of source) {
    const match = line.match(/^([A-Z]+)\|(\d+)\|([A-Z0-9_]+)\|(.*)$/)
    if (!match?.[1] || !match[2] || !match[3])
      throw new Error(`lock helper returned an invalid payload line: ${line}`)
    if (match[1] !== "M") throw new Error(`lock helper returned an unknown payload kind: ${line}`)
    metadata[match[3]] = (match[4] ?? "").replaceAll("%7C", "|").replaceAll("%25", "%")
  }
  return metadata
}

export interface LockDeleteResult {
  readonly action: "delete"
  readonly connectionId: string
  readonly readOnly: false
  readonly status: "ok" | "failed"
  readonly code: string
  readonly message: string
  readonly lock: {
    readonly owner: string
    readonly tableName: string
    readonly argument: string
    readonly mode: string
    readonly lockObject: string
  }
  readonly released: boolean
  readonly confirmation: string
  readonly idempotencyKey: string | null
  readonly readBack: {
    readonly performed: boolean
    readonly lockPresentAfter: boolean | null
    readonly calleeReturnCode: string | null
  }
  readonly warnings: readonly string[]
}

/**
 * Turn a helper reply for `LOCK_DELETE` into the caller-visible result.
 *
 * Success must carry the helper's own deletion marker: a reply that claims `S` without it is an
 * invalid reply, not a release whose evidence went missing. The echoed key comes from the reply
 * rather than from the request, so a caller compares what SAP acted on with what it asked for.
 */
export function lockDeleteResult(connectionId: string, reply: LockHelperReply): LockDeleteResult {
  const ok = reply.status.toUpperCase() === "S"
  const deleted = (reply.metadata["DELETED"] ?? "").trim().toUpperCase()
  if (ok && deleted !== "X") throw new Error("LOCK_RESPONSE_INVALID")
  return {
    action: "delete",
    connectionId,
    readOnly: false,
    status: ok ? "ok" : "failed",
    code: lockDeleteCode(reply.code),
    message: reply.message,
    lock: {
      owner: (reply.metadata["OWNER"] ?? "").trim(),
      tableName: (reply.metadata["TABLE"] ?? "").trim(),
      argument: (reply.metadata["ARGUMENT"] ?? "").trim(),
      mode: (reply.metadata["MODE"] ?? "").trim(),
      lockObject: (reply.metadata["OBJECT"] ?? "").trim()
    },
    released: ok,
    confirmation: LOCK_DELETE_CONFIRMATION,
    idempotencyKey: null,
    readBack: {
      // Absence is the evidence: the helper only answers S after re-reading the lock table and
      // finding no entry for this key. `performed` is false when the release never happened.
      performed: ok,
      lockPresentAfter: ok ? false : null,
      calleeReturnCode: null
    },
    warnings: LOCK_DELETE_WARNINGS
  }
}
