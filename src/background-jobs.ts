import { z } from "zod"

/**
 * Background-job control (OP2, N3). The four tools behind SM36/SM37 that the assessment named as the
 * largest single gap in operations coverage.
 *
 * Why these cannot be plain service-side RFC calls: on this release `BP_JOB_CREATE`,
 * `BP_JOB_MODIFY`, `BP_JOB_RELEASE` and `BP_JOB_DELETE` all report `remoteEnabled = false`, so the
 * only route is a branch inside the SAP-side repository helper. That helper body lives in
 * `ZORVANTA_MCP_CORE`, which is protected by the self-write guard, so these branches reach SAP
 * through a carrier program the operator runs in SE38 - not through the service.
 *
 * Dialog safety: `BP_JOB_CREATE` requires `JOB_CR_DIALOG` and `BP_JOB_MODIFY` requires `DIALOG`, and
 * both accept the constant `BTC_NO`. The helper always passes `BTC_NO`, because an external RFC must
 * never raise a screen (AGENTS section 7.5).
 *
 * Authority: this module does not invent an authority object. `BP_JOB_DELETE` checks
 * `S_BTCH_JOB` (`JOBGROUP`/`JOBACTION`) itself and falls back to a batch-admin check, and
 * `BP_JOB_RELEASE` checks `S_RZL_ADM` for the intercepted-job path; the helper maps the FMs'
 * `NO_*_AUTHORITY`-style exceptions into stable codes rather than swallowing them.
 */

/** The confirmation string each write demands, checked before SAP is touched. */
export const JOB_CONFIRMATIONS = {
  create: "CREATE_BACKGROUND_JOB",
  modify: "MODIFY_BACKGROUND_JOB",
  release: "RELEASE_BACKGROUND_JOB",
  cancel: "CANCEL_BACKGROUND_JOB"
} as const

export type JobControlAction = keyof typeof JOB_CONFIRMATIONS

/** One step of a job, as SM36 defines it: an ABAP program plus an optional variant. */
export interface BackgroundJobStep {
  readonly programName: string
  readonly variantName?: string | undefined
}

const JOB_NAME = /^[A-Za-z0-9_/]{1,32}$/
// TBTCO-JOBCOUNT is BTCJOBCNT/CHAR8 and every one of the 500 rows sampled on w200 was exactly
// eight digits, so an identity that is not eight digits cannot identify a job SAP holds. The read
// tools already demand `^\d{8}$`; keeping the write side identical is what stops a caller from
// being handed a job it could never release.
const JOB_COUNT = /^[0-9]{8}$/
const PROGRAM_NAME = /^[A-Za-z0-9_/=%]{1,40}$/
const VARIANT_NAME = /^[A-Za-z0-9_/]{1,14}$/
const USER_NAME = /^[A-Za-z0-9_.-]{1,12}$/

/**
 * A stable, machine-readable failure code for the caller. Every code is checked by a test, and an
 * unrecognised helper code becomes `JOB_CONTROL_FAILED` rather than being passed through, so a
 * caller can never be handed an ad-hoc string as if it were part of the contract.
 */
export const JOB_CONTROL_CODES = [
  "JOB_CONTROL_FAILED",
  "JOB_NAME_INVALID",
  "JOB_COUNT_INVALID",
  "JOB_NOT_FOUND",
  "JOB_STEP_INVALID",
  "JOB_STEP_REQUIRED",
  "JOB_TOO_MANY_STEPS",
  "JOB_TARGET_USER_INVALID",
  "JOB_START_TIME_INVALID",
  "JOB_ALREADY_RELEASED",
  "JOB_ALREADY_RUNNING",
  "JOB_NOT_DELETABLE",
  "JOB_NOT_MODIFIABLE",
  "JOB_NO_AUTHORITY",
  "JOB_DUPLICATE",
  "JOB_HELPER_UNSUPPORTED",
  "JOB_RESPONSE_INVALID",
  "JOB_RESPONSE_SCOPE_MISMATCH",
  // Added with cancel_background_job. Each one is produced by the JOB_CANCEL branch and checked by a
  // test, so a caller never receives an unrecognised helper string.
  "JOB_IDENTITY_REQUIRED",
  "JOB_NOT_RELEASABLE",
  "JOB_STATUS_UNCHANGED",
  "JOB_STILL_PRESENT",
  "JOB_LOCKED",
  "JOB_COMMIT_FAILED",
  "JOB_RELEASE_FAILED",
  "JOB_CANCEL_FAILED",
  "JOB_HAVE_NO_STEPS",
  // Added with create_background_job and modify_background_job. `JOB_PAYLOAD_INVALID` is the arm's
  // own refusal for a payload that mixes the two halves of a modify or names a fact the tool does
  // not accept, and `JOB_CREATE_FAILED` is what a failed JOB_OPEN/JOB_SUBMIT/JOB_CLOSE reports.
  // Every one of them is produced by the JOB_CREATE and JOB_MODIFY_* arms and checked by a test, so
  // a caller never receives an unrecognised helper string.
  "JOB_PAYLOAD_INVALID",
  "JOB_CREATE_FAILED",
  // Added with the modify de-release correction. SAP's own modify path releases a job whose head
  // carries a start date, so both modify arms put such a job back to scheduled (BP_JOB_MODIFY
  // opcode 18) before reading it back; this is what a de-release that SAP itself refuses reports,
  // and it is deliberately distinct from JOB_STATUS_UNCHANGED - the requested change did land, the
  // job was simply left released against the tool's contract.
  "JOB_DERELEASE_FAILED",
  // Success codes are registered too, not just failures: the result builder maps the helper's code
  // through the same whitelist, so omitting them would report a successful release or cancellation
  // as JOB_CONTROL_FAILED.
  "JOB_RELEASED",
  "JOB_CANCELLED",
  "JOB_CREATED",
  "JOB_MODIFIED",
  "JOB_NOT_FOUND_AFTER_RELEASE"
] as const
export type JobControlCode = (typeof JOB_CONTROL_CODES)[number]

const codeSet = new Set<string>(JOB_CONTROL_CODES)

export function jobControlCode(value: unknown): JobControlCode {
  const text = typeof value === "string" ? value.trim() : ""
  return (codeSet.has(text) ? text : "JOB_CONTROL_FAILED") as JobControlCode
}

/** Normalise and validate a job name before anything reaches SAP. */
export function jobName(value: string): string {
  const text = value.trim().toUpperCase()
  if (!JOB_NAME.test(text)) throw new Error("JOB_NAME_INVALID")
  return text
}

export function jobCount(value: string): string {
  const text = value.trim()
  if (!JOB_COUNT.test(text)) throw new Error("JOB_COUNT_INVALID")
  return text
}

export function jobTargetUser(value: string): string {
  const text = value.trim().toUpperCase()
  if (!USER_NAME.test(text)) throw new Error("JOB_TARGET_USER_INVALID")
  return text
}

/**
 * Validate a step list.
 *
 * A create or modify must name at least one step: SAP's own `BP_JOB_CREATE` rejects a job without
 * steps, and letting an empty list through would turn a caller's mistake into a SAP-side exception
 * with no useful text. The cap exists because the helper carries steps as an internal table and an
 * unbounded list is a resource-consumption risk at the RFC boundary.
 */
export function jobSteps(steps: readonly BackgroundJobStep[]): BackgroundJobStep[] {
  if (steps.length === 0) throw new Error("JOB_STEP_REQUIRED")
  if (steps.length > 20) throw new Error("JOB_TOO_MANY_STEPS")
  return steps.map((step) => {
    const programName = step.programName.trim().toUpperCase()
    if (!PROGRAM_NAME.test(programName)) throw new Error("JOB_STEP_INVALID")
    const variantName = step.variantName?.trim().toUpperCase() ?? ""
    if (variantName !== "" && !VARIANT_NAME.test(variantName)) throw new Error("JOB_STEP_INVALID")
    return variantName === "" ? { programName } : { programName, variantName }
  })
}

/**
 * `BP_JOB_CREATE`'s `JOB_CR_STDT_OUT` carries the scheduled start. The helper accepts the same
 * `YYYY-MM-DDTHH:MM:SS` shape the read tools use, in SAP local time, and refuses anything else
 * rather than letting SAP interpret an ambiguous string.
 */
export const JOB_START_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$/

export function jobStartTime(value: string): { readonly date: string; readonly time: string } {
  const text = value.trim()
  if (!JOB_START_TIME.test(text)) throw new Error("JOB_START_TIME_INVALID")
  const date = `${text.slice(0, 4)}${text.slice(5, 7)}${text.slice(8, 10)}`
  const time = `${text.slice(11, 13)}${text.slice(14, 16)}${text.slice(17, 19)}`
  // Reject impossible dates/times here so SAP is never asked to interpret them.
  if (
    Number(time.slice(0, 2)) > 23 ||
    Number(time.slice(2, 4)) > 59 ||
    Number(time.slice(4, 6)) > 59
  )
    throw new Error("JOB_START_TIME_INVALID")
  const month = Number(date.slice(4, 6))
  const day = Number(date.slice(6, 8))
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error("JOB_START_TIME_INVALID")
  return { date, time }
}

/**
 * Input for `release_background_job`.
 *
 * `confirmation` is the literal `RELEASE_BACKGROUND_JOB`; it is validated before SAP is touched, so
 * an accidental call (the classic copy-paste of a read's arguments) stops in the service rather than
 * in the scheduler.
 */
export const releaseBackgroundJobSchema = z
  .object({
    connectionId: z.string().min(1).max(32),
    jobName: z.string().min(1).max(32),
    jobCount: z.string().min(1).max(8),
    confirmation: z.literal("RELEASE_BACKGROUND_JOB"),
    operationId: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,64}$/)
      .optional()
  })
  .strict()

export type ReleaseBackgroundJobInput = z.input<typeof releaseBackgroundJobSchema>

/**
 * Input for `cancel_background_job`.
 *
 * Cancelling is irreversible - the job row and its schedule are gone - so it is a separate tool from
 * release rather than a mode flag: different confirmation string, different lifecycle, different
 * reversal story. `confirmation` is checked before SAP is touched.
 */
export const cancelBackgroundJobSchema = z
  .object({
    connectionId: z.string().min(1).max(32),
    jobName: z.string().min(1).max(32),
    jobCount: z.string().min(1).max(8),
    confirmation: z.literal("CANCEL_BACKGROUND_JOB"),
    operationId: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,64}$/)
      .optional()
  })
  .strict()

export type CancelBackgroundJobInput = z.input<typeof cancelBackgroundJobSchema>

/**
 * One step of a create or a modify, as the caller writes it. The schema only bounds the field
 * lengths; the names themselves are normalised and checked by `jobSteps()` before SAP is touched,
 * because that is where the same rules the read tools use are enforced.
 */
const backgroundJobStepSchema = z
  .object({
    programName: z.string().min(1).max(40),
    variantName: z.string().min(1).max(14).optional()
  })
  .strict()

/**
 * Input for `create_background_job`.
 *
 * The stack of refusals mirrors the other two control tools: the confirmation string is a literal,
 * the shape is strict (a caller cannot smuggle a job count, a status or a step property past the
 * helper), and every value is normalised by the shared validators before the helper is called - so
 * an ambiguous create stops in the service instead of becoming a SAP-side exception.
 *
 * `startTime` is the same `YYYY-MM-DDTHH:MM:SS` shape the read tools print, interpreted in SAP local
 * time; `targetUser` is optional and defaults inside the helper to the user it runs as.
 */
export const createBackgroundJobSchema = z
  .object({
    connectionId: z.string().min(1).max(32),
    jobName: z.string().min(1).max(32),
    steps: z.array(backgroundJobStepSchema).min(1),
    startTime: z.string().min(1).max(19),
    targetUser: z.string().min(1).max(12).optional(),
    confirmation: z.literal("CREATE_BACKGROUND_JOB"),
    operationId: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,64}$/)
      .optional()
  })
  .strict()

export type CreateBackgroundJobInput = z.input<typeof createBackgroundJobSchema>

/** The strict field set a modify accepts. It is declared once because both the parsed schema below
 * and the raw shape the tool contract publishes are built from it. */
const modifyBackgroundJobFields = {
  connectionId: z.string().min(1).max(32),
  jobName: z.string().min(1).max(32),
  jobCount: z.string().min(1).max(8),
  action: z.enum(["header", "steps"]),
  startTime: z.string().min(1).max(19).optional(),
  targetUser: z.string().min(1).max(12).optional(),
  steps: z.array(backgroundJobStepSchema).min(1).optional(),
  confirmation: z.literal("MODIFY_BACKGROUND_JOB"),
  operationId: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,64}$/)
    .optional()
}

/**
 * Input for `modify_background_job`.
 *
 * One tool with two arms rather than two tools, because both arms address the same stored job with
 * the same identity and the same precondition (only a job SAP still holds as scheduled may be
 * changed); they differ in which structure SAP rewrites. `action` selects the arm and the two
 * payloads do not overlap, so a caller that asks to change the header *and* the steps in one call is
 * refused here - SAP would answer it with a generic rejection that names neither field.
 *
 * The cross-field rule is applied by the same function the helper's payload builder uses
 * (`jobModifyProblem`), so the schema and the service can never disagree about what a coherent
 * request is.
 */
export const modifyBackgroundJobSchema = z
  .object(modifyBackgroundJobFields)
  .strict()
  .superRefine((value, context) => {
    const problem = jobModifyProblem(value)
    if (problem !== null) context.addIssue({ code: z.ZodIssueCode.custom, message: problem })
  })

/**
 * The strict field set the tool contract publishes.
 *
 * It is exported separately because a refined schema is a `ZodEffects` and no longer exposes
 * `.shape`, while the MCP client has to be handed the raw shape; every call is still parsed through
 * the refined schema above.
 */
export const modifyBackgroundJobShape = modifyBackgroundJobFields

export type ModifyBackgroundJobInput = z.input<typeof modifyBackgroundJobSchema>

/**
 * The one rule that decides whether a modify request is coherent, returning the stable code to
 * refuse with or `null`.
 *
 * `action:"header"` names at least one header field and no steps; `action:"steps"` names a non-empty
 * step list and neither header field. The service calls this before it builds a payload, so a
 * request that would make the helper guess which half of the job was meant is refused without SAP
 * being contacted, and the caller is told which code it broke rather than being handed SAP's
 * generic rejection.
 */
export function jobModifyProblem(input: {
  readonly action: "header" | "steps"
  readonly startTime?: string | undefined
  readonly targetUser?: string | undefined
  readonly steps?: readonly BackgroundJobStep[] | undefined
}): string | null {
  const hasHeader = input.startTime !== undefined || input.targetUser !== undefined
  if (input.action === "header") {
    // A header change that also carries steps is two operations in one call.
    if (input.steps !== undefined) return "JOB_PAYLOAD_INVALID"
    if (!hasHeader) return "JOB_PAYLOAD_INVALID"
    return null
  }
  // The step arm is the mirror image: header fields belong to the other arm.
  if (hasHeader) return "JOB_PAYLOAD_INVALID"
  if (input.steps === undefined || input.steps.length === 0) return "JOB_STEP_REQUIRED"
  return null
}

/**
 * What the service reports back after a job write. `released` and `steps` come from the helper's own
 * read-back, never from the request, so a caller sees what SAP now holds rather than what was asked
 * for.
 */
export interface JobControlResult {
  readonly action: JobControlAction
  readonly connectionId: string
  readonly readOnly: false
  readonly status: "ok" | "failed" | "duplicate"
  readonly code: string
  readonly message: string
  readonly jobName: string
  readonly jobCount: string
  readonly jobStatus: string | null
  readonly stepCount: number | null
  readonly confirmation: string
  readonly idempotencyKey: string | null
  readonly readBack: {
    readonly performed: boolean
    readonly jobExists: boolean | null
    readonly jobStatusAfter: string | null
    readonly stepCountAfter: number | null
  }
  readonly warnings: readonly string[]
}

export const JOB_CONTROL_WARNINGS = [
  "A job write changes the batch scheduler. The service does not schedule, release or delete anything on its own: every action names its confirmation string and is a separate tool call.",
  "Job status and step count are read back from SAP after the write; they are not echoed from the request.",
  "A released job runs under the target user's authorizations, not the caller's.",
  "The idempotency key is a local receipt, not a SAP-side lock. It proves what this service sent, never what the scheduler holds."
] as const

/**
 * The helper's reply: `status`/`code`/`message` arrive in the SOAP reply envelope (the same channel
 * every repository operation uses), while the job facts arrive as `M|<index>|<KEY>|<value>` rows in
 * `source`, written by the helper's `add_repo_payload` macro.
 */
export interface JobHelperReply {
  readonly status: string
  readonly code: string
  readonly message: string
  readonly metadata: Readonly<Record<string, string>>
}

/**
 * Parse the helper's payload rows into the job facts it read back.
 *
 * Deliberately strict, like the transport tools: an unparseable line is an error rather than
 * something to skip, because a malformed reply must not be read as a successful one whose fields
 * merely went missing.
 */
export function jobPayloadRows(
  source: readonly string[],
  options: { readonly skipForeignKinds?: boolean } = {}
): Readonly<Record<string, string>> {
  const metadata: Record<string, string> = {}
  for (const line of source) {
    const match = line.match(/^([A-Z]+)\|(\d+)\|([A-Z0-9_]+)\|(.*)$/)
    if (!match?.[1] || !match[2] || !match[3])
      throw new Error(`job helper returned an invalid payload line: ${line}`)
    if (match[1] !== "M") {
      // A refusal that happens before the arm emits anything returns without refreshing the reply
      // table, so the caller's own request rows (`H|`/`S|`) arrive with the refusal. See
      // jobReplyMetadata for why a refusal is read tolerantly and a success is not.
      if (options.skipForeignKinds === true) continue
      throw new Error(`job helper returned an unknown payload kind: ${line}`)
    }
    metadata[match[3]] = (match[4] ?? "").replaceAll("%7C", "|").replaceAll("%25", "%")
  }
  return metadata
}

/**
 * Read the payload rows of a job helper reply, tolerating the request rows a refusal echoes back.
 *
 * The helper refuses a request by setting `status`/`code`/`message` and returning, and several of
 * those returns happen before the arm reaches its first `REFRESH it_source`. The reply table then
 * still holds the rows the caller sent, so a strict reading would replace SAP's own code - the
 * answer the caller needs - with a parser complaint about SAP's evidence. A reply that claims
 * success is still read strictly, because there the rows are the evidence and a malformed one must
 * not pass as a success whose fields merely went missing.
 */
export function jobReplyMetadata(result: {
  readonly status: string
  readonly source?: readonly string[] | undefined
}): Readonly<Record<string, string>> {
  const refused = result.status.trim().toUpperCase() !== "S"
  return jobPayloadRows(result.source ?? [], { skipForeignKinds: refused })
}

/**
 * Turn a helper reply for `JOB_RELEASE` into the caller-visible result.
 *
 * The released status must come back from SAP, and the helper refuses to answer `S` without one, so
 * a reply that claims success but carries no status is treated as an invalid reply rather than
 * reported as a successful release whose status happens to be blank.
 */
export function jobReleaseResult(connectionId: string, reply: JobHelperReply): JobControlResult {
  const ok = reply.status.toUpperCase() === "S"
  const jobStatus = (reply.metadata["STATUS"] ?? "").trim()
  if (ok && jobStatus === "") throw new Error("JOB_RESPONSE_INVALID")
  const stepText = (reply.metadata["STEP_COUNT"] ?? "").trim()
  const stepCount = stepText === "" ? null : Number(stepText)
  return {
    action: "release",
    connectionId,
    readOnly: false,
    status: ok ? "ok" : "failed",
    code: jobControlCode(reply.code),
    message: reply.message,
    jobName: (reply.metadata["JOBNAME"] ?? "").trim(),
    jobCount: (reply.metadata["JOBCOUNT"] ?? "").trim(),
    jobStatus: jobStatus === "" ? null : jobStatus,
    stepCount,
    confirmation: JOB_CONFIRMATIONS.release,
    idempotencyKey: null,
    readBack: {
      performed: ok,
      jobExists: ok ? true : null,
      jobStatusAfter: jobStatus === "" ? null : jobStatus,
      stepCountAfter: stepCount
    },
    warnings: JOB_CONTROL_WARNINGS
  }
}

/**
 * Turn a helper reply for `JOB_CANCEL` into the caller-visible result.
 *
 * Cancelling is proved by absence, not by presence: a successful cancel must report that the job is
 * gone, so `jobExists` is `false` on success and the status is `null` (there is no status left to
 * report). A success reply that still carries a status would mean the helper's read-back found the
 * row, so it is refused as invalid rather than reported as a cancelled job that somehow still has
 * one.
 */
export function jobCancelResult(connectionId: string, reply: JobHelperReply): JobControlResult {
  const ok = reply.status.toUpperCase() === "S"
  const statusBefore = (reply.metadata["STATUS_BEFORE"] ?? "").trim()
  if (ok && statusBefore === "") throw new Error("JOB_RESPONSE_INVALID")
  return {
    action: "cancel",
    connectionId,
    readOnly: false,
    status: ok ? "ok" : "failed",
    code: jobControlCode(reply.code),
    message: reply.message,
    jobName: (reply.metadata["JOBNAME"] ?? "").trim(),
    jobCount: (reply.metadata["JOBCOUNT"] ?? "").trim(),
    jobStatus: null,
    stepCount: null,
    confirmation: JOB_CONFIRMATIONS.cancel,
    idempotencyKey: null,
    readBack: {
      performed: ok,
      // Absence is the evidence: the helper only answers S after re-reading TBTCO and finding nothing.
      jobExists: ok ? false : null,
      jobStatusAfter: null,
      stepCountAfter: null
    },
    warnings: [
      ...JOB_CONTROL_WARNINGS,
      `Job status before cancellation: ${statusBefore === "" ? "unknown" : statusBefore}. A cancelled job cannot be restored; its schedule and log entries are removed by SAP.`
    ]
  }
}

/**
 * The repository-helper arms these two tools dispatch to.
 *
 * They are named here rather than imported from `SapRepositoryOperation` in `src/backend.ts`, because
 * that closed union does not list them: the job-control pair it carries is the 2.13/2.14
 * release/cancel arm, and a helper that serves those does not carry these. The registry pins the
 * version that does (2.19 for create, 2.21 for modify) and names the same three opcodes, which is
 * what the capability report compares against the helper's own capability list - so a body that
 * lacks an arm is reported as unavailable instead of being called and failing.
 */
export const JOB_REPOSITORY_OPERATIONS = [
  "JOB_CREATE",
  "JOB_MODIFY_HEADER",
  "JOB_MODIFY_STEP"
] as const

export type JobRepositoryOperation = (typeof JOB_REPOSITORY_OPERATIONS)[number]

/**
 * One repository-helper request as these two tools send it.
 *
 * `jobName` is the CREATE identity and `jobName` + `jobCount` the MODIFY identity: neither travels
 * in the payload, so there is exactly one source for who the target is. The schedule, the target
 * user and the steps travel as `IT_SOURCE` rows built by {@link jobSourceRows}.
 */
export interface JobRepositoryRequest {
  readonly operation: JobRepositoryOperation
  readonly jobName: string
  readonly jobCount?: string | undefined
  readonly source: string[]
}

/** The helper's reply as the job result builders read it. */
export interface JobRepositoryReply {
  readonly status: string
  readonly code: string
  readonly message: string
  readonly source?: string[] | undefined
}

/**
 * The repository channel a job write needs: one call, `IT_SOURCE` rows in, `IT_SOURCE` rows out.
 *
 * Narrow on purpose. The two job tools need exactly this much of the backend, which keeps their
 * refusal tests able to run without a SAP connection and states in one type what a job write is
 * allowed to touch.
 */
export interface JobRepositoryChannel {
  callSapRepository(
    connectionId: string,
    request: JobRepositoryRequest
  ): Promise<JobRepositoryReply>
}

/**
 * One `IT_SOURCE` row in the `KIND|INDEX|PROPERTY|VALUE` shape the helper parses.
 *
 * The escaping is the same one every other repository payload uses (`%` -> `%25`, `|` -> `%7C`), and
 * it is applied to the value only: the helper splits on `|` and translates only the property to
 * upper case. The row must fit `ABAPTXT255`, which is the type of the table it travels in.
 */
export function jobPayloadLine(
  kind: "H" | "S",
  index: number,
  property: string,
  value: string
): string {
  const line = `${kind}|${index}|${property}|${value.replaceAll("%", "%25").replaceAll("|", "%7C")}`
  if (line.length > 255) throw new Error("JOB_PAYLOAD_INVALID")
  return line
}

/** The header facts and steps a create or a modify sends. Every field is optional here; which ones
 * are required is decided by the caller (a create needs date and time, a header modify needs at
 * least one header field, a step modify needs steps), so this function states the wire shape only. */
export interface JobSourcePayload {
  readonly targetUser?: string | undefined
  readonly startDate?: string | undefined
  readonly startTime?: string | undefined
  readonly steps?: readonly BackgroundJobStep[] | undefined
}

/**
 * Build the `IT_SOURCE` rows for a create or a modify.
 *
 * The order is fixed - the header rows first, then the steps in ascending index - so the same
 * request always produces the same payload, which is what makes a receipt and a test able to compare
 * it. An empty payload is refused: a job write that carries no fact at all is a caller mistake, not
 * a request SAP should interpret.
 */
export function jobSourceRows(payload: JobSourcePayload): string[] {
  const rows: string[] = []
  if (payload.targetUser !== undefined)
    rows.push(jobPayloadLine("H", 1, "TARGET_USER", payload.targetUser))
  if (payload.startDate !== undefined)
    rows.push(jobPayloadLine("H", 1, "START_DATE", payload.startDate))
  if (payload.startTime !== undefined)
    rows.push(jobPayloadLine("H", 1, "START_TIME", payload.startTime))
  payload.steps?.forEach((step, index) => {
    rows.push(jobPayloadLine("S", index + 1, "PROGRAM", step.programName))
    // A step without a variant is submitted without one; an empty VARIANT row would be a variant
    // named "" rather than no variant at all.
    if (step.variantName !== undefined)
      rows.push(jobPayloadLine("S", index + 1, "VARIANT", step.variantName))
  })
  if (rows.length === 0) throw new Error("JOB_PAYLOAD_INVALID")
  return rows
}

/** Read the helper's `M|index|KEY|value` payload rows into the job facts it reported. */
function jobHelperReply(result: JobRepositoryReply): JobHelperReply {
  return {
    status: result.status,
    code: result.code,
    message: result.message,
    metadata: jobReplyMetadata(result)
  }
}

/**
 * Create one job (SM36) through `JOB_OPEN` / `JOB_SUBMIT` / `JOB_CLOSE` in the helper.
 *
 * Validation runs first and completely: the confirmation string, the job name, the schedule, the
 * target user and every step are checked here, so a request that cannot be honoured is refused
 * without the helper - and therefore without SAP - being contacted. The job count is deliberately
 * not an input: SAP assigns it when the job is opened, and the read-back is what reports it.
 */
export async function createBackgroundJob(
  channel: JobRepositoryChannel,
  input: CreateBackgroundJobInput
): Promise<string> {
  const parsed = createBackgroundJobSchema.parse(input)
  if (parsed.confirmation !== JOB_CONFIRMATIONS.create)
    throw new Error(`confirmation must be ${JOB_CONFIRMATIONS.create}`)
  const connectionId = parsed.connectionId.toLowerCase()
  const start = jobStartTime(parsed.startTime)
  const steps = jobSteps(parsed.steps)
  const targetUser = parsed.targetUser === undefined ? undefined : jobTargetUser(parsed.targetUser)
  const source = jobSourceRows({
    ...(targetUser === undefined ? {} : { targetUser }),
    startDate: start.date,
    startTime: start.time,
    steps
  })
  const result = await channel.callSapRepository(connectionId, {
    operation: "JOB_CREATE",
    jobName: jobName(parsed.jobName),
    source
  })
  return JSON.stringify(jobCreateResult(connectionId, jobHelperReply(result)), null, 2)
}

/**
 * Modify one scheduled job (SM37) through the helper's header arm or its step arm.
 *
 * `action` decides which arm runs, and the two are mutually exclusive: the coherence rule is
 * enforced before the payload is built, so a call that names a new schedule *and* a new step list
 * never reaches SAP. Only a job SAP still holds as scheduled can be changed; the helper reads the
 * job back and refuses the rest as JOB_NOT_MODIFIABLE.
 */
export async function modifyBackgroundJob(
  channel: JobRepositoryChannel,
  input: ModifyBackgroundJobInput
): Promise<string> {
  const parsed = modifyBackgroundJobSchema.parse(input)
  if (parsed.confirmation !== JOB_CONFIRMATIONS.modify)
    throw new Error(`confirmation must be ${JOB_CONFIRMATIONS.modify}`)
  const problem = jobModifyProblem(parsed)
  if (problem !== null) throw new Error(problem)
  const connectionId = parsed.connectionId.toLowerCase()
  const identity = {
    jobName: jobName(parsed.jobName),
    jobCount: jobCount(parsed.jobCount)
  }
  if (parsed.action === "header") {
    const start = parsed.startTime === undefined ? undefined : jobStartTime(parsed.startTime)
    const targetUser =
      parsed.targetUser === undefined ? undefined : jobTargetUser(parsed.targetUser)
    const source = jobSourceRows({
      ...(targetUser === undefined ? {} : { targetUser }),
      ...(start === undefined ? {} : { startDate: start.date, startTime: start.time })
    })
    const result = await channel.callSapRepository(connectionId, {
      operation: "JOB_MODIFY_HEADER",
      ...identity,
      source
    })
    return JSON.stringify(jobModifyResult(connectionId, jobHelperReply(result)), null, 2)
  }
  const source = jobSourceRows({ steps: jobSteps(parsed.steps ?? []) })
  const result = await channel.callSapRepository(connectionId, {
    operation: "JOB_MODIFY_STEP",
    ...identity,
    source
  })
  return JSON.stringify(jobModifyResult(connectionId, jobHelperReply(result)), null, 2)
}

/**
 * Turn a helper reply for `JOB_CREATE` into the caller-visible result.
 *
 * A create is proved by the identity and the status SAP read back after `JOB_CLOSE`: the job count
 * is what makes the new job addressable, and the status is SAP's own answer about the row it now
 * holds. A reply that claims success with either of them missing is refused as invalid rather than
 * reported as a created job whose count happens to be blank - the caller would have no way to
 * release, modify or cancel what it was told it had just created.
 */
export function jobCreateResult(connectionId: string, reply: JobHelperReply): JobControlResult {
  const ok = reply.status.toUpperCase() === "S"
  const jobStatus = (reply.metadata["STATUS"] ?? "").trim()
  const jobCount = (reply.metadata["JOBCOUNT"] ?? "").trim()
  if (ok && (jobStatus === "" || jobCount === "")) throw new Error("JOB_RESPONSE_INVALID")
  const stepText = (reply.metadata["STEP_COUNT"] ?? "").trim()
  const stepCount = stepText === "" ? null : Number(stepText)
  // A create opens the job before it can know whether the rest of the request is acceptable, and
  // JOB_OPEN commits that row itself, so a later refusal can leave a scheduled job behind. The helper
  // deletes it again and says which of the three outcomes it reached; saying so in the receipt is not
  // optional, because the alternative is a caller that reads "failed" and retries into JOB_DUPLICATE
  // without ever being told why. A cleanup that failed is reported with the job's identity so
  // cancel_background_job can be used on it.
  const cleanup = (reply.metadata["CLEANUP"] ?? "").trim().toUpperCase()
  const cleanupMessage = (reply.metadata["MESSAGE"] ?? "").trim()
  const cleanupWarnings: string[] = []
  if (cleanup === "DELETE_FAILED") {
    cleanupWarnings.push(
      `SAP refused to delete the job this call had already opened${jobCount === "" ? "" : ` (${(reply.metadata["JOBNAME"] ?? "").trim()}/${jobCount})`}, so it still exists${jobStatus === "" ? " in status unknown" : ` in status ${jobStatus}`}; cancel it with cancel_background_job before retrying this name, or the retry answers JOB_DUPLICATE${cleanupMessage === "" ? "" : `. SAP said: ${cleanupMessage}`}`
    )
  } else if (cleanup === "DELETED") {
    cleanupWarnings.push(
      "The job this call had already opened was deleted again after the failure, so a retry with the same name is not blocked by it."
    )
  } else if (cleanup === "NOT_NEEDED") {
    cleanupWarnings.push(
      "No job was left behind by this failure: the helper either never opened one or found none to delete."
    )
  }
  return {
    action: "create",
    connectionId,
    readOnly: false,
    status: ok ? "ok" : "failed",
    code: jobControlCode(reply.code),
    message: reply.message,
    jobName: (reply.metadata["JOBNAME"] ?? "").trim(),
    jobCount,
    jobStatus: jobStatus === "" ? null : jobStatus,
    stepCount,
    confirmation: JOB_CONFIRMATIONS.create,
    idempotencyKey: null,
    readBack: {
      performed: ok,
      jobExists: ok ? true : null,
      jobStatusAfter: jobStatus === "" ? null : jobStatus,
      stepCountAfter: stepCount
    },
    warnings: [
      ...JOB_CONTROL_WARNINGS,
      ...cleanupWarnings,
      "The job count is assigned by SAP when the job is opened; it is returned here because every later modify, release or cancel is addressed by that exact pair.",
      "The helper pre-checks every step's variant with SAP's own report-value check and refuses an unknown one as JOB_STEP_INVALID, but the program name itself is not verified to exist at creation time: SAP reports a step whose program is missing when the job is due to run, not when the job is created."
    ]
  }
}

/**
 * Turn a helper reply for `JOB_MODIFY_HEADER` or `JOB_MODIFY_STEP` into the caller-visible result.
 *
 * The modified state must come back from SAP: a modify whose reply carries no status proves nothing
 * about the job it claims to have changed, so it is refused as an invalid reply rather than reported
 * as a success whose status happens to be blank. The schedule and the target user are reported from
 * the helper's read-back whenever it carries them, and never echoed from the request.
 */
export function jobModifyResult(connectionId: string, reply: JobHelperReply): JobControlResult {
  const ok = reply.status.toUpperCase() === "S"
  const jobStatus = (reply.metadata["STATUS"] ?? "").trim()
  if (ok && jobStatus === "") throw new Error("JOB_RESPONSE_INVALID")
  const stepText = (reply.metadata["STEP_COUNT"] ?? "").trim()
  const stepCount = stepText === "" ? null : Number(stepText)
  const date = (reply.metadata["START_DATE"] ?? "").trim()
  const time = (reply.metadata["START_TIME"] ?? "").trim()
  const user = (reply.metadata["TARGET_USER"] ?? "").trim()
  const readBackFacts: string[] = []
  const schedule = `${date}${time}`
  if (schedule !== "") readBackFacts.push(`scheduled start ${schedule}`)
  if (user !== "") readBackFacts.push(`target user ${user}`)
  return {
    action: "modify",
    connectionId,
    readOnly: false,
    status: ok ? "ok" : "failed",
    code: jobControlCode(reply.code),
    message: reply.message,
    jobName: (reply.metadata["JOBNAME"] ?? "").trim(),
    jobCount: (reply.metadata["JOBCOUNT"] ?? "").trim(),
    jobStatus: jobStatus === "" ? null : jobStatus,
    stepCount,
    confirmation: JOB_CONFIRMATIONS.modify,
    idempotencyKey: null,
    readBack: {
      performed: ok,
      jobExists: ok ? true : null,
      jobStatusAfter: jobStatus === "" ? null : jobStatus,
      stepCountAfter: stepCount
    },
    warnings: [
      ...JOB_CONTROL_WARNINGS,
      ...(ok && readBackFacts.length > 0
        ? [`Read back from SAP after the modification: ${readBackFacts.join(", ")}.`]
        : []),
      "A modify only rewrites the stored job; it never starts the job and never releases it."
    ]
  }
}
