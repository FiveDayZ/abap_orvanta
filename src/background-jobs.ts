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
const JOB_COUNT = /^[0-9]{1,8}$/
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
  "JOB_RESPONSE_SCOPE_MISMATCH"
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
export function jobPayloadRows(source: readonly string[]): Readonly<Record<string, string>> {
  const metadata: Record<string, string> = {}
  for (const line of source) {
    const match = line.match(/^([A-Z]+)\|(\d+)\|([A-Z0-9_]+)\|(.*)$/)
    if (!match?.[1] || !match[2] || !match[3])
      throw new Error(`job helper returned an invalid payload line: ${line}`)
    if (match[1] !== "M") throw new Error(`job helper returned an unknown payload kind: ${line}`)
    metadata[match[3]] = (match[4] ?? "").replaceAll("%7C", "|").replaceAll("%25", "%")
  }
  return metadata
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
