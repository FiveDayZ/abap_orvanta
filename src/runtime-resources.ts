import { z } from "zod"
import type { SapBackend } from "./backend.js"

/**
 * The runtime-resource reads behind SM50/SM66, SM04, ST03, DB02 and AL11.
 *
 * Where the read happens: ADT publishes no work-process, session, performance, database-activity or
 * filesystem endpoint, so nothing here can come from the platform. A read-only probe of w200 on
 * 2026-09-25 found `TH_WPINFO` (SM50/SM66), `TH_USER_LIST` (SM04) and
 * `EPS2_GET_DIRECTORY_LISTING` (AL11) remote-enabled with output tables that resolve to verified RFC
 * scalar types, and the three reads were built on that direct SOAP-RFC path - where, measured on
 * w200 on 2026-09-30, all three answered with zero rows. They now go through `RuntimeHelperRead`,
 * the separately approved `RUNTIME` scope of the in-SAP helper `Z_ORVANTA_OPS_READ` (protocol 1.1),
 * which makes the same kernel calls locally. The two metrics reads have no direct path at all:
 * `DB6PMHSD`/`DB6PMHSB` are outside the service-side table allowlist and
 * `SWNC_COLLECTOR_GET_SYSTEMLOAD` exports a row type the external RFC path cannot serialize.
 * `SWNC_GET_WORKLOAD_DIRECTORY` still goes over SOAP-RFC directly: it answers today and needs none
 * of this.
 *
 * What this module owns: not the call, the approval gate or the reply schema - `src/operational-logs.ts`
 * owns those - but what the rows mean. Each returned row carries the lifted names below **and** the
 * untranslated row in `raw`, and `interpretedFields` states which SAP field every name came from.
 * Numeric code columns are reported as the kernel returned them: the domain fixed values were not
 * read, so no code is turned into a label, and the tallies count the kernel's own values rather than
 * a meaning this tool invented. Every read is a snapshot: it observes the state at the moment of the
 * call and keeps no history.
 */

const WP_FIELDS = [
  "WP_NO",
  "WP_ITYPE",
  "WP_TYP",
  "WP_PID",
  "WP_ISTATUS",
  "WP_STATUS",
  "WP_IWAIT",
  "WP_WAITING",
  "WP_SEM",
  "WP_IRESTRT",
  "WP_RESTART",
  "WP_DUMPS",
  "WP_CPU",
  "WP_ELTIME",
  "WP_MANDT",
  "WP_BNAME",
  "WP_REPORT",
  "WP_IACTION",
  "WP_ACTION",
  "WP_TABLE",
  "WP_SERVER",
  "WP_WAITINF",
  "WP_WAITTIM",
  "WP_SEMSTAT",
  "WP_INDEX"
] as const

const SESSION_FIELDS = [
  "TID",
  "MANDT",
  "BNAME",
  "TCODE",
  "TERM",
  "ZEIT",
  "MASTER",
  "TRACE",
  "EXTMODI",
  "INTMODI",
  "TYPE",
  "STAT",
  "PROTOCOL",
  "GUIVERSION",
  "RFC_TYPE",
  "HOSTADDR"
] as const

/** The work-process columns the tool lifts out of the row, and the SAP field each one came from. */
const WORK_PROCESS_FIELDS = {
  number: "WP_NO",
  typeCode: "WP_ITYPE",
  type: "WP_TYP",
  processId: "WP_PID",
  statusCode: "WP_ISTATUS",
  status: "WP_STATUS",
  userId: "WP_BNAME",
  client: "WP_MANDT",
  report: "WP_REPORT",
  actionCode: "WP_IACTION",
  action: "WP_ACTION",
  table: "WP_TABLE",
  server: "WP_SERVER",
  cpuTime: "WP_CPU",
  elapsedTime: "WP_ELTIME",
  waitTime: "WP_WAITTIM",
  waitReason: "WP_WAITINF",
  semaphore: "WP_SEM",
  semaphoreState: "WP_SEMSTAT",
  restarts: "WP_RESTART",
  dumps: "WP_DUMPS",
  index: "WP_INDEX"
} as const

/** The session columns the tool lifts, and the SAP field each one came from. */
const SESSION_FIELD_MAP = {
  sessionId: "TID",
  client: "MANDT",
  user: "BNAME",
  transaction: "TCODE",
  terminal: "TERM",
  time: "ZEIT",
  masterSession: "MASTER",
  trace: "TRACE",
  externalMode: "EXTMODI",
  internalMode: "INTMODI",
  sessionType: "TYPE",
  state: "STAT",
  protocol: "PROTOCOL",
  guiVersion: "GUIVERSION",
  rfcType: "RFC_TYPE",
  hostAddress: "HOSTADDR"
} as const

/** Fingerprints of the two monitor interfaces, read from w200 on 2026-09-25. */
export const reviewedWorkProcessDefinition = z.object({
  functionName: z.literal("TH_WPINFO"),
  remoteEnabled: z.literal(true),
  updateTask: z.literal(false),
  sourceFingerprint: z.literal("cf3be4d651ae9af6f156fde4d8cf6ea3fd932102df575ae1d4908eae23e2ed16"),
  interfaceFingerprint: z.literal(
    "e5d7078c36abdbbe48cb23c47071e101f82320ec1723dbc7f93b7a4c8edc2f70"
  )
})

export const reviewedSessionListDefinition = z.object({
  functionName: z.literal("TH_USER_LIST"),
  remoteEnabled: z.literal(true),
  updateTask: z.literal(false),
  sourceFingerprint: z.literal("1cc2a482e5e08b3edbe5ce921d8fe4c5ae4065b7088da7154d5aeadd006716dc"),
  interfaceFingerprint: z.literal(
    "8d88542a7b1793f646033e41bb96ffb59b27b4fb73d58190b4a9fc103e429a01"
  )
})

/**
 * The third monitor interface, read from w200 on 2026-09-25.
 *
 * `EPS2_GET_DIRECTORY_LISTING` is the newer of the two directory listings: its `EPS2FILI` row type
 * carries five fields (name, size, timestamp, owner, return code) against the three of the older
 * `EPSFILI`, and both were fully resolvable to RFC scalar types.
 */
export const reviewedDirectoryDefinition = z.object({
  functionName: z.literal("EPS2_GET_DIRECTORY_LISTING"),
  remoteEnabled: z.literal(true),
  updateTask: z.literal(false),
  sourceFingerprint: z.literal("50a403b6ad5276063ac101178f612c19650e92f9a5610dfe9b8b19784fd7bde6"),
  interfaceFingerprint: z.literal(
    "3951eb2659cf3bf01fd74769262050bec5ffd84c83517b84d23f0725a0c3ebeb"
  )
})

export type RuntimeResourceSource = {
  table:
    | "TH_WPINFO"
    | "TH_USER_LIST"
    | "EPS2_GET_DIRECTORY_LISTING"
    | "SWNC_GET_WORKLOAD_DIRECTORY"
    | "DB6PMHSD"
    | "DB6PMHSB"
    | "SWNC_COLLECTOR_GET_SYSTEMLOAD"
  status: "ok" | "unavailable" | "invalid"
  method: "rfc_call" | "helper"
  returnedCount: number
  code?: string
}

/** Row and value limits shared by both reads. */
export const RUNTIME_RESOURCES_DEFAULT_ROWS = 200
export const RUNTIME_RESOURCES_MAX_ROWS = 500
/** `TH_WPINFO.SRVNAME` is `MSXXLIST-NAME` (`CHAR40`); a longer value cannot match any server. */
export const RUNTIME_RESOURCES_SERVER_LIMIT = 40
/** `TH_USER_LIST` has no user import, so the user name is only a service-side filter. */
export const RUNTIME_RESOURCES_USER_LIMIT = 12
/** `EPS2_GET_DIRECTORY_LISTING.IV_DIR_NAME` is `EPS2FILNAM` (`CHAR200`). */
export const RUNTIME_RESOURCES_DIRECTORY_LIMIT = 200
/** `EPS2_GET_DIRECTORY_LISTING.FILE_MASK` is `EPSF-EPSFILNAM` (`CHAR40`). */
export const RUNTIME_RESOURCES_MASK_LIMIT = 40
/**
 * The helper's own ceiling per read, taken from the branch guards in `scripts/runtime-read-source.mjs`
 * and `scripts/db-perf-source.mjs` (`lv_limit > 200` returns without reading). The service-side cap is
 * wider, so a larger row limit is refused by the helper rather than trimmed here.
 */
const HELPER_ROW_CAP = 200

const codes = [
  "RUNTIME_RESOURCES_SCOPE_INVALID",
  "RUNTIME_RESOURCES_ROW_LIMIT_INVALID",
  "RUNTIME_RESOURCES_FUNCTION_UNVERIFIED",
  "RUNTIME_RESOURCES_NOT_AUTHORIZED",
  "RUNTIME_RESOURCES_RFC_FAILED",
  "RUNTIME_RESOURCES_RESPONSE_INVALID",
  "RUNTIME_RESOURCES_RESPONSE_EMPTY"
] as const

function failure(error: unknown): string {
  const text = error instanceof Error ? error.message : ""
  return (codes as readonly string[]).includes(text) ? text : "RUNTIME_RESOURCES_CALL_FAILED"
}

function rowLimit(requested: number | undefined): number {
  if (requested === undefined) return RUNTIME_RESOURCES_DEFAULT_ROWS
  if (!Number.isInteger(requested) || requested < 1 || requested > RUNTIME_RESOURCES_MAX_ROWS)
    throw new Error("RUNTIME_RESOURCES_ROW_LIMIT_INVALID")
  return requested
}

function printable(value: string | undefined, limit: number): string {
  if (value === undefined) return ""
  const trimmed = value.trim()
  if (!trimmed) return ""
  if (trimmed.length > limit || /[\u0000-\u001f\u007f]/.test(trimmed))
    throw new Error("RUNTIME_RESOURCES_SCOPE_INVALID")
  return trimmed
}

/**
 * A faithful tally of the values the kernel returned.
 *
 * Counting the raw values is the honest summary here: the alternative - grouping codes into
 * "busy"/"free"/"waiting" buckets - would assert a meaning the domain texts were never read for.
 */
function tally(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) {
    const key = value || "(empty)"
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

type Session = Record<string, string>

/** What one helper-backed runtime read produced. src/operational-logs.ts owns the call, the
 * approval gate and the reply schema; this module owns what the rows mean. */
export type RuntimeHelperOutcome =
  | { unavailable: string; reason?: string | undefined }
  | { reply: RuntimeHelperReply }

export type RuntimeHelperReply = {
  action: "WP_LIST" | "USER_LIST" | "DIR_LIST" | "DB_ACTIVITY" | "PERF_SNAPSHOT"
  status: "ok" | "not_found" | "forbidden" | "unsupported"
  code: string
  reason?: string | undefined
  calleeSubrc?: string | undefined
  calleeException?: string | undefined
  server?: string
  kernelRowCount?: string
  directory?: string
  fileCounter?: string
  errorCounter?: string
  systemId?: string
  periodType?: string
  periodStart?: string
  timeUnit?: string
  rows?: Session[]
  historyRows?: Session[]
  bufferPoolRows?: Session[]
  truncated?: boolean
}

export type RuntimeHelperRead = (
  action: "WP_LIST" | "USER_LIST" | "DIR_LIST" | "DB_ACTIVITY" | "PERF_SNAPSHOT",
  parameters: Record<string, string>
) => Promise<RuntimeHelperOutcome>

/** The action names the reader accepts, taken from the one signature that defines them. */
type RuntimeHelperReadAction = Parameters<RuntimeHelperRead>[0]

/** One helper call, reduced to either its ok reply or one transcribed failure line. */
type HelperAnswer =
  | { ok: true; reply: RuntimeHelperReply }
  | { ok: false; code: string; status: "unavailable" | "invalid"; warning: string }

/** One lifted row: the named values plus the untranslated SAP row they were lifted from. */
type WorkProcessEntry = Record<keyof typeof WORK_PROCESS_FIELDS, string> & { raw: Session }
type SessionEntry = Record<keyof typeof SESSION_FIELD_MAP, string> & { raw: Session }

/**
 * Rows as the SOAP-RFC reader returns them: trimmed text.
 *
 * A numeric cell stays the reader's own rendering of that value: DIR_LIST carries DEC and INT4
 * columns, so rejecting anything but a string would reject a valid answer, and parsing them into
 * numbers would state a precision the answer never claimed. Objects, arrays and booleans are still
 * refused - those are not scalar row values.
 */
function tableRows(value: unknown): Session[] {
  if (!Array.isArray(value)) throw new Error("RUNTIME_RESOURCES_RESPONSE_INVALID")
  return value.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new Error("RUNTIME_RESOURCES_RESPONSE_INVALID")
    const record: Session = {}
    for (const field of Object.keys(row)) {
      const cell = (row as Record<string, unknown>)[field]
      if (typeof cell === "string") record[field] = cell.trim()
      else if (typeof cell === "number" && Number.isFinite(cell)) record[field] = String(cell)
      else throw new Error("RUNTIME_RESOURCES_RESPONSE_INVALID")
    }
    return record
  })
}

function lift<Mapping extends Record<string, string>>(
  row: Session,
  mapping: Mapping
): Record<keyof Mapping, string> {
  const lifted = {} as Record<keyof Mapping, string>
  for (const [name, field] of Object.entries(mapping))
    lifted[name as keyof Mapping] = row[field] ?? ""
  return lifted
}

/**
 * What the helper answered, transcribed into one warning line.
 *
 * The code is the helper's own and the callee's raw sub-return code and declared exception name
 * travel with it as they were sent: none of the three is turned into a label this service invented.
 */
function helperAnswer(reply: RuntimeHelperReply): string {
  const parts = [reply.code]
  if (reply.reason !== undefined) parts.push(`reason=${reply.reason}`)
  if (reply.calleeSubrc !== undefined) parts.push(`calleeSubrc=${reply.calleeSubrc}`)
  if (reply.calleeException !== undefined) parts.push(`calleeException=${reply.calleeException}`)
  return parts.join(" ")
}

/** A reply that never happened, named by the code the approval gate or the transport produced. */
function helperUnavailable(outcome: { unavailable: string; reason?: string | undefined }): string {
  return outcome.reason === undefined
    ? outcome.unavailable
    : `${outcome.unavailable} reason=${outcome.reason}`
}

/**
 * Ask the helper once and hand the caller either its reply or one failure line.
 *
 * Nothing is thrown: an unavailable gate, a non-ok reply and a call that never completed are all
 * answers about the read, and the caller reports them as such. A failure raised above the helper -
 * an unreadable approval file, a fingerprint mismatch, a reply the schema rejected - keeps the code
 * this module would use for it and carries its own message with it, so the cause is not lost.
 */
async function helperRead(
  read: RuntimeHelperRead,
  action: RuntimeHelperReadAction,
  parameters: Record<string, string>
): Promise<HelperAnswer> {
  try {
    const outcome = await read(action, parameters)
    if (!("reply" in outcome))
      return {
        ok: false,
        code: outcome.unavailable,
        status: "unavailable",
        warning: helperUnavailable(outcome)
      }
    if (outcome.reply.status !== "ok")
      return {
        ok: false,
        code: outcome.reply.code,
        status: "unavailable",
        warning: helperAnswer(outcome.reply)
      }
    return { ok: true, reply: outcome.reply }
  } catch (error) {
    const code = failure(error)
    const detail = error instanceof Error ? error.message : ""
    return {
      ok: false,
      code,
      status: code === "RUNTIME_RESOURCES_RESPONSE_INVALID" ? "invalid" : "unavailable",
      warning: detail && detail !== code ? `${code} (${detail})` : code
    }
  }
}

export interface WorkProcessOptions {
  serverName?: string | undefined
  maxRows?: number | undefined
}

export async function collectWorkProcesses(
  read: RuntimeHelperRead,
  connectionId: string,
  options: WorkProcessOptions,
  readDefinition: () => Promise<unknown>
) {
  const requested = rowLimit(options.maxRows)
  const serverName = printable(options.serverName, RUNTIME_RESOURCES_SERVER_LIMIT)
  const source: RuntimeResourceSource = {
    table: "TH_WPINFO",
    status: "unavailable",
    method: "helper",
    returnedCount: 0
  }
  const queryWarnings: string[] = []
  const notes = [
    "Work process rows come from TH_WPINFO, the kernel's own work process list (the source behind " +
      "SM50/SM66), read as a snapshot through the separately approved RUNTIME helper scope. No " +
      "history is kept and nothing is aggregated across calls.",
    "No value is translated: `type`, `typeCode`, `status` and `statusCode` are the kernel's own " +
      "values, and the domain fixed values were not read, so no code is mapped to a label.",
    "Each entry carries the untranslated SAP row in `raw`, and `interpretedFields` names the SAP " +
      "field every lifted value came from.",
    "This read cannot restart, stop, debug or resubmit a work process; it only observes the list."
  ]
  if (!serverName)
    notes.push(
      "No serverName was given, so the kernel returned its own default list for the application " +
        "server that handled the call."
    )
  else
    notes.push(
      "The helper upper-cases serverName in its own copy before it validates the value and " +
        "passes it to the kernel's SRVNAME import, so the kernel's list was selected by the " +
        "upper-cased name while the value reported here keeps the caller's own spelling."
    )
  if (requested > HELPER_ROW_CAP)
    notes.push(
      `The helper reads at most ${HELPER_ROW_CAP} rows per call, so a row cap of ${requested} is ` +
        "refused by the helper itself and this answer carries the helper's own code instead of rows."
    )

  let rows: Session[] = []
  let helperTruncated = false
  try {
    if (!reviewedWorkProcessDefinition.safeParse(await readDefinition()).success)
      throw new Error("RUNTIME_RESOURCES_FUNCTION_UNVERIFIED")
    const answer = await helperRead(read, "WP_LIST", {
      IV_SERVER: serverName,
      IV_LIMIT: String(requested)
    })
    if (!answer.ok) {
      source.status = answer.status
      source.code = answer.code
      queryWarnings.push(`WP_LIST: ${answer.warning}`)
    } else {
      rows = tableRows(answer.reply.rows)
      // A running application server always has work processes, so an empty list is not an answer.
      if (!rows.length) throw new Error("RUNTIME_RESOURCES_RESPONSE_EMPTY")
      helperTruncated = answer.reply.truncated === true
      source.status = "ok"
      source.returnedCount = rows.length
    }
  } catch (error) {
    source.code = failure(error)
    if (source.code === "RUNTIME_RESOURCES_RESPONSE_INVALID") source.status = "invalid"
    queryWarnings.push(`WP_LIST: ${source.code}`)
  }

  const truncated = helperTruncated || rows.length > requested
  if (truncated)
    notes.push(
      `The answer is partial: the row cap is ${requested} and the helper reported that the kernel ` +
        "held more work processes than that, so the rows beyond the cap were not read into the result."
    )
  const selected = rows.slice(0, requested)
  const workProcesses: WorkProcessEntry[] = selected.map((row) => ({
    ...lift(row, WORK_PROCESS_FIELDS),
    raw: row
  }))

  return {
    status: !rows.length
      ? ("unavailable" as const)
      : truncated
        ? ("partial" as const)
        : ("ok" as const),
    connectionId,
    readOnly: true,
    serverName,
    filters: { serverName: serverName || null },
    rowLimit: requested,
    rowLimitRequested: options.maxRows ?? null,
    rowLimitApplied: requested,
    returnedCount: selected.length,
    truncated,
    workProcesses,
    counts: {
      returned: selected.length,
      byType: tally(selected.map((row) => row.WP_TYP ?? "")),
      byStatus: tally(selected.map((row) => row.WP_STATUS ?? "")),
      byServer: tally(selected.map((row) => row.WP_SERVER ?? ""))
    },
    interpretedFields: { ...WORK_PROCESS_FIELDS },
    notes,
    sources: [source],
    queryTimestamp: new Date().toISOString(),
    queryWarnings
  }
}

export interface UserSessionOptions {
  userName?: string | undefined
  maxRows?: number | undefined
}

export async function collectUserSessions(
  read: RuntimeHelperRead,
  connectionId: string,
  options: UserSessionOptions,
  readDefinition: () => Promise<unknown>
) {
  const requested = rowLimit(options.maxRows)
  const userName = printable(options.userName, RUNTIME_RESOURCES_USER_LIMIT).toUpperCase()
  const source: RuntimeResourceSource = {
    table: "TH_USER_LIST",
    status: "unavailable",
    method: "helper",
    returnedCount: 0
  }
  const queryWarnings: string[] = []
  const notes = [
    "Session rows come from TH_USER_LIST, the kernel's own user and session list (the source " +
      "behind SM04), read as a snapshot through the separately approved RUNTIME helper scope. No " +
      "history is kept.",
    "Both of the kernel's table parameters are supplied, because LIST (UINFO) is mandatory and the " +
      "call aborts with CX_SY_DYN_CALL_PARAM_MISSING without it, but only USRLIST (USRINFO) is " +
      "read: one of LIST's fields carries a type this service cannot verify, so a session the " +
      "kernel reports only there is not claimed by this tool.",
    "No value is translated: `state`, `sessionType`, `externalMode`, `internalMode` and `protocol` " +
      "are the kernel's own codes and the domain fixed values were not read.",
    "Each entry carries the untranslated SAP row in `raw`, and `interpretedFields` names the SAP " +
      "field every lifted value came from.",
    "This read cannot terminate a session, send a message to a user or change a session's state."
  ]
  if (userName)
    notes.push(
      `userName was applied in the service after the kernel's list was read, because TH_USER_LIST ` +
        `has no user import parameter: an empty result means "no session of ${userName} in this ` +
        `snapshot", not "the user does not exist". The helper stops at the row cap before that ` +
        `filter runs, so a session of ${userName} lying beyond the cap does not appear.`
    )
  if (requested > HELPER_ROW_CAP)
    notes.push(
      `The helper reads at most ${HELPER_ROW_CAP} rows per call, so a row cap of ${requested} is ` +
        "refused by the helper itself and this answer carries the helper's own code instead of rows."
    )

  let rows: Session[] = []
  let kernelRowCount: number | null = null
  let helperTruncated = false
  try {
    if (!reviewedSessionListDefinition.safeParse(await readDefinition()).success)
      throw new Error("RUNTIME_RESOURCES_FUNCTION_UNVERIFIED")
    // The helper's own diagnostic alias is applied by the transport layer, next to the one JOB_LOG
    // already uses. It only switches the arm into writing a stage name; the arm's own final write
    // still replaces it on success, so a successful read is unaffected.
    const answer = await helperRead(read, "USER_LIST", { IV_LIMIT: String(requested) })
    if (!answer.ok) {
      source.status = answer.status
      source.code = answer.code
      queryWarnings.push(`USER_LIST: ${answer.warning}`)
    } else {
      rows = tableRows(answer.reply.rows)
      // A running application server always has sessions, so an empty list is not an answer.
      if (!rows.length) throw new Error("RUNTIME_RESOURCES_RESPONSE_EMPTY")
      kernelRowCount = integer(answer.reply.kernelRowCount ?? "")
      helperTruncated = answer.reply.truncated === true
      source.status = "ok"
      source.returnedCount = rows.length
    }
  } catch (error) {
    source.code = failure(error)
    if (source.code === "RUNTIME_RESOURCES_RESPONSE_INVALID") source.status = "invalid"
    queryWarnings.push(`USER_LIST: ${source.code}`)
  }

  const matched = userName
    ? rows.filter((row) => (row.BNAME ?? "").toUpperCase() === userName)
    : rows
  const truncated = helperTruncated || matched.length > requested
  if (truncated)
    notes.push(
      `The answer is partial: the row cap is ${requested} and the kernel held more sessions than ` +
        "that, so the rows beyond the cap were not read into the result."
    )
  const selected = matched.slice(0, requested)
  const sessions: SessionEntry[] = selected.map((row) => ({
    ...lift(row, SESSION_FIELD_MAP),
    raw: row
  }))

  return {
    status: !rows.length
      ? ("unavailable" as const)
      : truncated
        ? ("partial" as const)
        : ("ok" as const),
    connectionId,
    readOnly: true,
    filters: { userName: userName || null, applied: userName ? "service_side" : "none" },
    rowLimit: requested,
    rowLimitRequested: options.maxRows ?? null,
    rowLimitApplied: requested,
    /**
     * The kernel's own row count, as the helper reported it, or the rows this service actually
     * received when the helper sent no count. Reported so the service-side filter stays visible.
     */
    kernelRowCount: kernelRowCount ?? rows.length,
    matchedCount: matched.length,
    returnedCount: selected.length,
    truncated,
    sessions,
    counts: {
      returned: selected.length,
      byUser: tally(selected.map((row) => row.BNAME ?? "")),
      byRfcType: tally(selected.map((row) => row.RFC_TYPE ?? "")),
      bySessionType: tally(selected.map((row) => row.TYPE ?? ""))
    },
    interpretedFields: { ...SESSION_FIELD_MAP },
    notes,
    sources: [source],
    queryTimestamp: new Date().toISOString(),
    queryWarnings
  }
}

/**
 * `EPS2FILI`, the DIR_LIST row type, read from w200 DD03L on 2026-09-25.
 *
 * Every lifted name is supported by the data element behind the field: `EPS2FILNAM` (name,
 * `CHAR200`), `EPS2FILSIZ` (`DEC15`), `EPS2TIMESTMP` (timestamp, `CHAR30`), `EPSFILOWN` (owner,
 * `CHAR8`) and `EPSFTPRC` (return code, domain `EPSRC`). The return code is lifted verbatim - its
 * fixed values were not read, so it is never turned into a success/failure verdict.
 */
export const DIRECTORY_FIELD_MAP = {
  name: "NAME",
  size: "SIZE",
  modifiedAt: "MTIM",
  owner: "OWNER",
  returnCode: "RC"
} as const

const DIRECTORY_FIELDS = Object.values(DIRECTORY_FIELD_MAP)

type DirectoryEntry = Record<keyof typeof DIRECTORY_FIELD_MAP, string> & { raw: Session }

/** A scalar output as text, or "" when the kernel did not return it. */
function scalarText(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return ""
}

/** The value read as a whole number, or null when it is not one. */
function integer(value: string): number | null {
  return /^\d+$/.test(value) ? Number(value) : null
}

export interface FileSystemDirectoryOptions {
  directory?: string | undefined
  fileMask?: string | undefined
  maxRows?: number | undefined
}

/**
 * List one directory of the application server, as AL11 does.
 *
 * Deliberately narrow: it reads names, sizes, timestamps, owners and per-entry return codes from the
 * kernel's own listing and never opens a file. What is visible is decided by the operating-system
 * user the instance runs under and by the kernel's own authorization check, and the request carries
 * the name exactly as the caller gave it - the answer reports the kernel's own `DIR_NAME` back, so a
 * caller can see which path was really listed.
 */
export async function collectFileSystemDirectory(
  read: RuntimeHelperRead,
  connectionId: string,
  options: FileSystemDirectoryOptions,
  readDefinition: () => Promise<unknown>
) {
  const requested = rowLimit(options.maxRows)
  const directory = printable(options.directory, RUNTIME_RESOURCES_DIRECTORY_LIMIT)
  // The kernel resolves the name it is given; refusing a parent reference keeps one call on the path
  // the caller named instead of letting it walk upward from there.
  if (!directory || directory.split(/[\\/]/).includes(".."))
    throw new Error("RUNTIME_RESOURCES_SCOPE_INVALID")
  const fileMask = printable(options.fileMask, RUNTIME_RESOURCES_MASK_LIMIT)
  const source: RuntimeResourceSource = {
    table: "EPS2_GET_DIRECTORY_LISTING",
    status: "unavailable",
    method: "helper",
    returnedCount: 0
  }
  const queryWarnings: string[] = []
  const notes = [
    "Directory entries come from EPS2_GET_DIRECTORY_LISTING, the kernel's own directory listing " +
      "(the source behind AL11), read as a snapshot through the separately approved RUNTIME helper " +
      "scope. File contents are never read, and this tool cannot create, move, rename or delete " +
      "anything.",
    "What appears depends on the operating-system user the instance runs under and on the kernel's " +
      "own authorization check; this tool widens neither.",
    "An empty listing is reported as an empty listing: it is not evidence that the directory does " +
      "not exist, and not evidence that it is empty for other callers.",
    "No value is translated: `name`, `size`, `modifiedAt` and `owner` are the kernel's own values, " +
      "and `returnCode` is its per-entry code with the domain fixed values unread.",
    "Each entry carries the untranslated SAP row in `raw`, and `interpretedFields` names the SAP " +
      "field every lifted value came from."
  ]
  if (!fileMask)
    notes.push("No fileMask was given, so the kernel applied its own default selection.")
  if (requested > HELPER_ROW_CAP)
    notes.push(
      `The helper reads at most ${HELPER_ROW_CAP} rows per call, so a row cap of ${requested} is ` +
        "refused by the helper itself and this answer carries the helper's own code instead of rows."
    )

  let rows: Session[] = []
  let listed = { directory: "", files: "", errors: "" }
  let helperTruncated = false
  try {
    if (!reviewedDirectoryDefinition.safeParse(await readDefinition()).success)
      throw new Error("RUNTIME_RESOURCES_FUNCTION_UNVERIFIED")
    const answer = await helperRead(read, "DIR_LIST", {
      IV_DIR: directory,
      IV_MASK: fileMask,
      IV_LIMIT: String(requested)
    })
    if (!answer.ok) {
      source.status = answer.status
      source.code = answer.code
      queryWarnings.push(`DIR_LIST: ${answer.warning}`)
    } else {
      // Unlike the work process and session lists, an empty directory is an ordinary answer.
      rows = tableRows(answer.reply.rows)
      listed = {
        directory: answer.reply.directory ?? "",
        files: answer.reply.fileCounter ?? "",
        errors: answer.reply.errorCounter ?? ""
      }
      helperTruncated = answer.reply.truncated === true
      source.status = "ok"
      source.returnedCount = rows.length
    }
  } catch (error) {
    source.code = failure(error)
    if (source.code === "RUNTIME_RESOURCES_RESPONSE_INVALID") source.status = "invalid"
    queryWarnings.push(`DIR_LIST: ${source.code}`)
  }

  const truncated = helperTruncated || rows.length > requested
  if (truncated)
    notes.push(
      `The answer is partial: the row cap is ${requested} and the kernel held more entries than ` +
        "that, so the entries beyond the cap were not read into the result."
    )
  const selected = rows.slice(0, requested)
  const entries: DirectoryEntry[] = selected.map((row) => ({
    ...lift(row, DIRECTORY_FIELD_MAP),
    raw: row
  }))

  if (source.status === "ok") {
    const counted = integer(listed.files)
    // Only comparable when nothing was cut: a capped row list is shorter than the kernel's count.
    if (!truncated && counted !== null && counted !== rows.length)
      queryWarnings.push(
        `DIR_LIST: FILE_COUNTER is ${counted} but the row list carried ` +
          `${rows.length} entries, so the kernel's own count and its row list disagree.`
      )
    const errored = integer(listed.errors)
    if (errored !== null && errored > 0)
      queryWarnings.push(
        `DIR_LIST: ERROR_COUNTER is ${errored}, so the kernel reported at least one entry it could ` +
          "not process."
      )
    if (listed.directory && listed.directory !== directory)
      notes.push(
        `The kernel reported DIR_NAME=${listed.directory}, which differs from the requested ` +
          `${directory}; the answer reports the kernel's own value.`
      )
  }

  return {
    status:
      source.status !== "ok"
        ? ("unavailable" as const)
        : truncated
          ? ("partial" as const)
          : ("ok" as const),
    connectionId,
    readOnly: true,
    directory,
    filters: { directory, fileMask: fileMask || null },
    /** The kernel's own echo of the directory it listed; null when it returned none. */
    directoryReported: listed.directory || null,
    /** The kernel's own counters, verbatim; not recomputed from the rows this service kept. */
    kernelCounters: { files: listed.files || null, errors: listed.errors || null },
    rowLimit: requested,
    rowLimitRequested: options.maxRows ?? null,
    rowLimitApplied: requested,
    returnedCount: selected.length,
    truncated,
    entries,
    counts: {
      returned: selected.length,
      byReturnCode: tally(selected.map((row) => row.RC ?? ""))
    },
    interpretedFields: { ...DIRECTORY_FIELD_MAP },
    notes,
    sources: [source],
    queryTimestamp: new Date().toISOString(),
    queryWarnings
  }
}

const WORKLOAD_DIRECTORY_FIELDS = [
  "ASSIGNDSYS",
  "COMPONENT",
  "PERIODTYPE",
  "PERIODSTRT",
  "FIRSTRECDY",
  "FIRSTRECTI",
  "LASTRECDY",
  "LASTRECTI",
  "AGR_TZONE",
  "LONG_COMPONENT"
] as const

/** The workload directory columns the tool lifts, and the SAP field each one came from. */
const WORKLOAD_DIRECTORY_FIELD_MAP = {
  assignedSystem: "ASSIGNDSYS",
  component: "COMPONENT",
  periodType: "PERIODTYPE",
  periodStart: "PERIODSTRT",
  firstRecordDate: "FIRSTRECDY",
  firstRecordTime: "FIRSTRECTI",
  lastRecordDate: "LASTRECDY",
  lastRecordTime: "LASTRECTI",
  aggregationTimezone: "AGR_TZONE",
  longComponent: "LONG_COMPONENT"
} as const

type WorkloadDirectoryEntry = Record<keyof typeof WORKLOAD_DIRECTORY_FIELD_MAP, string> & {
  raw: Session
}

/**
 * The workload directory, read from w200 on 2026-09-26.
 *
 * `SWNC_GET_WORKLOAD_DIRECTORY` is the one member of the workload family this service can call: it
 * takes no inputs and exports a single table whose ten fields all resolve to verified RFC scalar
 * types. Every read that carries the workload *numbers* is out of reach, which is why this reader is
 * named for the directory and not for a snapshot: `SWNC_COLLECTOR_GET_AGGREGATES`,
 * `SWNC_GET_WORKLOAD_SNAPSHOT`, `SWNC_GET_WORKLOAD_STATISTIC`, `SWNC_READ_SNAPSHOT` and
 * `SAPWLN3_AGGREGATE_SNAPSHOT_GET` are remote-enabled, but their aggregate row structures
 * (`SWNCGL_T_AGG*`) are refused by the interface verifier - either the generated field names fail
 * its name check or a scalar type such as `SWNCTASKTYPERAW` cannot be verified. The single-record
 * read `SWNC_STATREC_READ` is remote-enabled too, but its `NORMAL_RECORDS` table - the record header
 * that gives a subrecord its user, transaction and response time - is refused as well, so what
 * remains are context-free subrecords. The best-supported source, `SWNC_COLLECTOR_KERNEL_STAT`, is
 * fully resolvable but **not** remote-enabled, so it needs the in-SAP helper. Those facts are
 * recorded in the runtime-resources gap in `ops-coverage.ts`; this reader claims only what it reads.
 */
export const reviewedWorkloadDirectoryDefinition = z.object({
  functionName: z.literal("SWNC_GET_WORKLOAD_DIRECTORY"),
  remoteEnabled: z.literal(true),
  updateTask: z.literal(false),
  sourceFingerprint: z.literal("80c9c534b86010b44769b225c0fb4795d85bdaa03c6c51504fd0db17f86171af"),
  interfaceFingerprint: z.literal(
    "cbf0f41e2155f4906dc0943db710fb03d158449a19a287482b01462a54919c4c"
  )
})

export interface WorkloadDirectoryOptions {
  maxRows?: number | undefined
}

export async function collectWorkloadDirectory(
  backend: Pick<SapBackend, "callRemoteFunction">,
  connectionId: string,
  options: WorkloadDirectoryOptions,
  readDefinition: () => Promise<unknown>
) {
  const requested = rowLimit(options.maxRows)
  const source: RuntimeResourceSource = {
    table: "SWNC_GET_WORKLOAD_DIRECTORY",
    status: "unavailable",
    method: "rfc_call",
    returnedCount: 0
  }
  const queryWarnings: string[] = []
  const notes = [
    "Directory rows come from SWNC_GET_WORKLOAD_DIRECTORY, the workload collector's own index of " +
      "the data it holds, read as a snapshot. No history is kept.",
    "This is the index, not the workload. The collector's aggregate rows - response and wait times, " +
      "database and CPU time, user and transaction workload - are not readable by this service, so " +
      "no such number appears here and this tool is not a performance snapshot.",
    "An empty directory is reported as an empty directory: it means the collector holds no data for " +
      "any period type, which is the normal state after a collector restart or on a system that " +
      "never collected. It is not evidence that performance is fine.",
    "No value is translated: `periodType` is the kernel's own code and the domain fixed values were " +
      "not read, so the tally counts the kernel's raw codes rather than named periods.",
    "`periodStart`, the first and last record date and time are the kernel's own DATS/TIMS values " +
      "returned verbatim, and `aggregationTimezone` is its own aggregation time zone; this service " +
      "converts none of them and holds no second source to cross-check them against.",
    "Each entry carries the untranslated SAP row in `raw`, and `interpretedFields` names the SAP " +
      "field every lifted value came from."
  ]

  let rows: Session[] = []
  let emptyByKernel = false
  try {
    if (!reviewedWorkloadDirectoryDefinition.safeParse(await readDefinition()).success)
      throw new Error("RUNTIME_RESOURCES_FUNCTION_UNVERIFIED")
    const result = await backend.callRemoteFunction(connectionId, {
      functionName: "SWNC_GET_WORKLOAD_DIRECTORY",
      inputParameters: {},
      outputParameters: [
        { name: "WORKLOAD_DIRECTORY", kind: "table", fields: [...WORKLOAD_DIRECTORY_FIELDS] }
      ]
    })
    if (result.fault) {
      // The interface declares NO_DATA_FOUND for "the collector holds nothing". That is an answer,
      // not a failure, so it is reported the way an empty directory listing is: status ok, no rows.
      if (result.fault.name === "NO_DATA_FOUND") emptyByKernel = true
      else
        throw new Error(
          result.fault.name === "NOT_AUTHORIZED"
            ? "RUNTIME_RESOURCES_NOT_AUTHORIZED"
            : "RUNTIME_RESOURCES_RFC_FAILED"
        )
    }
    if (emptyByKernel) {
      source.status = "ok"
      source.code = "NO_DATA_FOUND"
      notes.push(
        "The kernel answered with its own NO_DATA_FOUND exception, which is how the interface " +
          "reports that the collector holds no workload data."
      )
    } else {
      const raw = result.outputs.WORKLOAD_DIRECTORY
      if (raw === undefined) throw new Error("RUNTIME_RESOURCES_RESPONSE_INVALID")
      rows = tableRows(raw)
      source.status = "ok"
      source.returnedCount = rows.length
    }
  } catch (error) {
    source.code = failure(error)
    if (source.code === "RUNTIME_RESOURCES_RESPONSE_INVALID") source.status = "invalid"
    queryWarnings.push(`SWNC_GET_WORKLOAD_DIRECTORY: ${source.code}`)
  }

  const truncated = rows.length > requested
  if (truncated)
    notes.push(
      `The kernel returned ${rows.length} directory rows and the row cap is ${requested}, so the ` +
        "answer is partial: the rows beyond the cap were not read into the result."
    )
  const selected = rows.slice(0, requested)
  const entries: WorkloadDirectoryEntry[] = selected.map((row) => ({
    ...lift(row, WORKLOAD_DIRECTORY_FIELD_MAP),
    raw: row
  }))

  return {
    status:
      source.status !== "ok"
        ? ("unavailable" as const)
        : truncated
          ? ("partial" as const)
          : ("ok" as const),
    connectionId,
    readOnly: true,
    /** True only when the kernel said so itself, which is distinct from an empty row table. */
    collectorReportedEmpty: emptyByKernel,
    rowLimit: requested,
    rowLimitRequested: options.maxRows ?? null,
    rowLimitApplied: requested,
    returnedCount: selected.length,
    truncated,
    entries,
    counts: {
      returned: selected.length,
      byPeriodType: tally(selected.map((row) => row.PERIODTYPE ?? "")),
      byComponent: tally(selected.map((row) => row.COMPONENT ?? ""))
    },
    interpretedFields: { ...WORKLOAD_DIRECTORY_FIELD_MAP },
    notes,
    sources: [source],
    queryTimestamp: new Date().toISOString(),
    queryWarnings
  }
}

/**
 * The two metrics reads, which have no direct path at all.
 *
 * `DB_ACTIVITY` reads the DB6 collector's history tables inside the helper: neither table carries a
 * client column, and the helper applies no `SYSID` predicate, so a row written by another system is
 * returned exactly as it is stored and each row's own `SYSID` is what tells them apart.
 *
 * `PERF_SNAPSHOT` reads the collector's system-load rows. The helper calls
 * `SWNC_COLLECTOR_GET_SYSTEMLOAD` locally, because that function module's export table type cannot be
 * serialized over the external RFC path. Its time and counter columns are passed through as text
 * without a divisor, and the answer names the unit the helper reported so a value cannot be read as
 * a different one.
 *
 * Both lifted maps below rename fields the generators actually emit, taken verbatim from
 * `scripts/db-perf-source.mjs`. Where a column's meaning is not established, it is deliberately not
 * lifted and stays visible in the entry's `raw` row.
 */

/** `DB6PMHSD`, the database-activity history row ("DB6: Database Performance Statistics History"). */
export const DB_ACTIVITY_HISTORY_FIELD_MAP = {
  systemId: "SYSID",
  compTime: "COMPTIME",
  partition: "PARTITN",
  poolDataLogicalReads: "PL_D_LRS",
  poolDataPhysicalReads: "PL_D_PRS",
  poolDataWrites: "PL_D_WS",
  poolIndexLogicalReads: "PL_I_LRS",
  poolIndexPhysicalReads: "PL_I_PRS",
  poolIndexWrites: "PL_I_WS",
  commitStatements: "CMMT_SQLST",
  rollbackStatements: "RBCK_SQLST",
  lockWaits: "LCK_WAITS",
  lockWaitTime: "LCK_W_TM",
  deadlocks: "DEADLOCKS",
  lockEscalations: "LCK_ESCALS",
  exclusiveLockEscalations: "XLK_ESCALS",
  bufferPoolAverageReadTime: "BP_AV_RTM",
  bufferPoolAverageWriteTime: "BP_AV_WTM"
} as const

/** `DB6PMHSB`, the buffer-pool history row ("DB6: Buffer Pool Statistics History"). */
export const DB_ACTIVITY_BUFFER_POOL_FIELD_MAP = {
  systemId: "SYSID",
  compTime: "COMPTIME",
  partition: "PARTITN",
  bufferPoolName: "BP_NAME",
  bufferPoolSize: "BP_SZ",
  poolDataLogicalReads: "PL_D_LRS",
  poolDataPhysicalReads: "PL_D_PRS",
  poolDataWrites: "PL_D_WS",
  poolIndexLogicalReads: "PL_I_LRS",
  poolIndexPhysicalReads: "PL_I_PRS",
  poolIndexWrites: "PL_I_WS",
  poolTempDataLogicalReads: "PL_TD_LRS",
  poolTempDataPhysicalReads: "PL_TD_PRS",
  poolTempIndexLogicalReads: "PL_TI_LRS",
  poolTempIndexPhysicalReads: "PL_TI_PRS",
  autoResize: "AUTOSIZE"
} as const

/** `SWNCSYSLOAD`, the system-load row of `SWNC_T_SYSLOAD`, as the helper emits it. */
export const PERFORMANCE_SNAPSHOT_FIELD_MAP = {
  component: "COMPONENT",
  periodType: "PERIODTYPE",
  periodStart: "PERIODSTRT",
  firstRecordDate: "FIRSTRECDY",
  firstRecordTime: "FIRSTRECTI",
  lastRecordDate: "LASTRECDY",
  lastRecordTime: "LASTRECTI",
  count: "COUNT",
  guiCount: "GUICNT",
  dbActivityCount: "DBACTIVCNT",
  dbProcedureCount: "DBP_COUNT",
  elapsedTime: "ELAPSEDTI",
  responseTime: "RESPTI",
  processTime: "PROCTI",
  queueTime: "QUETI",
  rollWaitTime: "ROLLWAITTI",
  guiTime: "GUITIME",
  guiNetTime: "GUINETTIME",
  cpuTime: "CPUTI",
  vmCpuTime: "VMC_CPU_TIME",
  dbTime: "DBTI",
  dbProcedureTime: "DBP_TIME",
  loadGenerationTime: "LOADGENTI",
  commitTime: "COMMITTI",
  lockTime: "LOCKTI",
  cpicTime: "CPICTI",
  ddicTime: "DDICTI",
  bytes: "BYTES",
  physicalCalls: "PHYCALLS",
  physicalReadCount: "PHYREADCNT",
  physicalChangeRecords: "PHYCHNGREC"
} as const

type DbActivityHistoryEntry = Record<keyof typeof DB_ACTIVITY_HISTORY_FIELD_MAP, string> & {
  raw: Session
}

type DbActivityBufferPoolEntry = Record<keyof typeof DB_ACTIVITY_BUFFER_POOL_FIELD_MAP, string> & {
  raw: Session
}

type PerformanceSnapshotEntry = Record<keyof typeof PERFORMANCE_SNAPSHOT_FIELD_MAP, string> & {
  raw: Session
}

export interface DbActivityOptions {
  maxRows?: number | undefined
}

/**
 * The DB6 collector's own history: database activity and buffer pool rows.
 *
 * Read-only and unfiltered by system on purpose. `DB6PMHSD` and `DB6PMHSB` have no client column and
 * the helper applies no `SYSID` predicate, so filtering by the caller's own system id would silently
 * drop rows this answer is meant to show. The rows are reported with the `SYSID` they were stored
 * with, and no comparison is drawn between them.
 */
export async function collectDbActivity(
  read: RuntimeHelperRead,
  connectionId: string,
  options: DbActivityOptions
) {
  const requested = rowLimit(options.maxRows)
  const sources: RuntimeResourceSource[] = [
    { table: "DB6PMHSD", status: "unavailable", method: "helper", returnedCount: 0 },
    { table: "DB6PMHSB", status: "unavailable", method: "helper", returnedCount: 0 }
  ]
  const queryWarnings: string[] = []
  const notes = [
    "Database activity rows come from the DB6 collector's history tables DB6PMHSD (database " +
      "performance statistics history) and DB6PMHSB (buffer pool statistics history), read with the " +
      "helper's own Open SQL: neither table may be read directly by this service, because both are " +
      "outside its allowlist.",
    "Each row carries the SYSID it was stored with, and no SYSID predicate was applied: the tables " +
      "have no client column and the helper filters by no system, so rows written by another system " +
      "are returned exactly as they are stored. `systemId` is the helper's own SY-SYSID - the system " +
      "it ran on, not a filter and not proof that the rows belong to it; `counts.bySystemId` shows " +
      "the values the rows themselves carry.",
    "The helper reads each table newest first (ORDER BY COMPTIME DESCENDING) and stops at the row " +
      "cap, so a truncated answer holds the newest rows rather than an arbitrary prefix.",
    "Every value is text: a numeric column is converted to text before it is concatenated, so a wide " +
      "counter keeps all of its digits instead of being reduced to a floating-point number.",
    "No value is translated: the columns are reported as they are stored, and no unit, rate or " +
      "comparison between rows is derived here.",
    "Each entry carries the untranslated row in `raw`, and `interpretedFields` names the table column " +
      "every lifted value came from. A lifted name is this service's own description of the column; " +
      "the field texts behind those columns were not read.",
    "An empty list is reported as an empty list per table: it means the collector stored no history " +
      "there, not that the database did no work."
  ]
  if (requested > HELPER_ROW_CAP)
    notes.push(
      `The helper reads at most ${HELPER_ROW_CAP} rows per table per call, so a row cap of ` +
        `${requested} is refused by the helper itself and this answer carries the helper's own code ` +
        "instead of rows."
    )

  let historyRaw: Session[] = []
  let bufferPoolRaw: Session[] = []
  let systemId = ""
  let truncated = false
  let problem: { code: string; status: "unavailable" | "invalid"; warning: string } | undefined
  const answer = await helperRead(read, "DB_ACTIVITY", { IV_LIMIT: String(requested) })
  if (!answer.ok) {
    problem = { code: answer.code, status: answer.status, warning: answer.warning }
  } else {
    try {
      historyRaw = tableRows(answer.reply.historyRows)
      bufferPoolRaw = tableRows(answer.reply.bufferPoolRows)
      systemId = answer.reply.systemId ?? ""
      truncated = answer.reply.truncated === true
    } catch (error) {
      const code = failure(error)
      problem = {
        code,
        status: code === "RUNTIME_RESOURCES_RESPONSE_INVALID" ? "invalid" : "unavailable",
        warning: code
      }
    }
  }

  if (problem)
    for (const source of sources) {
      source.status = problem.status
      source.code = problem.code
    }
  else for (const source of sources) source.status = "ok"
  if (problem) queryWarnings.push(`DB_ACTIVITY: ${problem.warning}`)
  sources[0]!.returnedCount = historyRaw.length
  sources[1]!.returnedCount = bufferPoolRaw.length

  const historyRows: DbActivityHistoryEntry[] = historyRaw.map((row) => ({
    ...lift(row, DB_ACTIVITY_HISTORY_FIELD_MAP),
    raw: row
  }))
  const bufferPoolRows: DbActivityBufferPoolEntry[] = bufferPoolRaw.map((row) => ({
    ...lift(row, DB_ACTIVITY_BUFFER_POOL_FIELD_MAP),
    raw: row
  }))

  return {
    status: problem ? ("unavailable" as const) : truncated ? ("partial" as const) : ("ok" as const),
    connectionId,
    readOnly: true,
    /** The helper's own SY-SYSID: where it ran, not a filter and not the rows' own system. */
    systemId,
    /** No system predicate is possible here; the rows keep their own SYSID in `raw` and lifted. */
    filters: { systemId: null },
    rowLimit: requested,
    rowLimitRequested: options.maxRows ?? null,
    rowLimitApplied: requested,
    returnedCount: historyRows.length + bufferPoolRows.length,
    truncated,
    historyRows,
    bufferPoolRows,
    counts: {
      returned: historyRows.length + bufferPoolRows.length,
      history: historyRows.length,
      bufferPool: bufferPoolRows.length,
      bySystemId: tally([...historyRaw, ...bufferPoolRaw].map((row) => row.SYSID ?? ""))
    },
    interpretedFields: {
      historyRows: { ...DB_ACTIVITY_HISTORY_FIELD_MAP },
      bufferPoolRows: { ...DB_ACTIVITY_BUFFER_POOL_FIELD_MAP }
    },
    notes,
    sources,
    queryTimestamp: new Date().toISOString(),
    queryWarnings
  }
}

export interface PerformanceSnapshotOptions {
  /** One upper-case period letter (`SWNCPERITYPE`); empty lets the helper use its own default. */
  periodType?: string | undefined
  /** The period start as `YYYYMMDD`; empty lets the helper use its own default. */
  periodStart?: string | undefined
  maxRows?: number | undefined
}

/**
 * The workload collector's own system load, as ST03 shows it.
 *
 * The helper calls `SWNC_COLLECTOR_GET_SYSTEMLOAD` locally, so the row type never has to survive the
 * external RFC path. Read-only: the collection entry points (`SWNC_COLLECTOR_KERNEL_STAT`,
 * `SWNC_COLLECTOR_STARTER`) run a collection and commit, and are not used by this branch.
 */
export async function collectPerformanceSnapshot(
  read: RuntimeHelperRead,
  connectionId: string,
  options: PerformanceSnapshotOptions
) {
  const requested = rowLimit(options.maxRows)
  const periodType = printable(options.periodType, 1)
  if (periodType && !/^[A-Z]$/.test(periodType)) throw new Error("RUNTIME_RESOURCES_SCOPE_INVALID")
  const periodStart = printable(options.periodStart, 8)
  if (periodStart && !/^\d{8}$/.test(periodStart))
    throw new Error("RUNTIME_RESOURCES_SCOPE_INVALID")
  const source: RuntimeResourceSource = {
    table: "SWNC_COLLECTOR_GET_SYSTEMLOAD",
    status: "unavailable",
    method: "helper",
    returnedCount: 0
  }
  const queryWarnings: string[] = []

  let rowsRaw: Session[] = []
  let reported = { periodType: "", periodStart: "", timeUnit: "" }
  let truncated = false
  let problem: { code: string; status: "unavailable" | "invalid"; warning: string } | undefined
  const answer = await helperRead(read, "PERF_SNAPSHOT", {
    IV_PERIOD: periodType,
    IV_FROM: periodStart,
    IV_LIMIT: String(requested)
  })
  if (!answer.ok) {
    problem = { code: answer.code, status: answer.status, warning: answer.warning }
  } else {
    try {
      rowsRaw = tableRows(answer.reply.rows)
      reported = {
        periodType: answer.reply.periodType ?? "",
        periodStart: answer.reply.periodStart ?? "",
        timeUnit: answer.reply.timeUnit ?? ""
      }
      truncated = answer.reply.truncated === true
    } catch (error) {
      const code = failure(error)
      problem = {
        code,
        status: code === "RUNTIME_RESOURCES_RESPONSE_INVALID" ? "invalid" : "unavailable",
        warning: code
      }
    }
  }

  if (problem) {
    source.status = problem.status
    source.code = problem.code
    queryWarnings.push(`PERF_SNAPSHOT: ${problem.warning}`)
  } else {
    source.status = "ok"
    source.returnedCount = rowsRaw.length
  }

  const notes = [
    "System load rows come from SWNC_COLLECTOR_GET_SYSTEMLOAD, the collector's own system-load read " +
      "behind ST03, called inside the helper because its export table type cannot be serialized to " +
      "an external RFC caller. The answer is one snapshot of what the collector holds for one " +
      "period: nothing is aggregated here and no collection is started.",
    `timeUnit is echoed verbatim from the helper: ${reported.timeUnit || "(none)"}. This tool ` +
      "applies no divisor, scaling or unit conversion, so a time or counter value is the " +
      "collector's own number in that unit - the unit is the helper's word for it, not a unit this " +
      "service derived.",
    "No value is translated: `COMPONENT` and `PERIODTYPE` are the collector's own values and the " +
      "domain fixed values were not read, so no code is turned into a label.",
    "Each entry carries the untranslated row in `raw`, and `interpretedFields` names the field every " +
      "lifted value came from. A lifted name is this service's own description of the field and the " +
      "numbered counters CNT001..CNT009 are deliberately not lifted; both stay visible in `raw`.",
    "This read uses the collector's read-only loader only: it never starts the collector, never " +
      "aggregates and never writes. SWNC_COLLECTOR_KERNEL_STAT and SWNC_COLLECTOR_STARTER, which run " +
      "a collection and commit, are deliberately not used.",
    "An empty row list means the collector held no system-load data for the requested period; it is " +
      "not a measurement of zero load."
  ]
  if (!periodType)
    notes.push(
      "No periodType was given, so the helper applied its own default and this answer reports the " +
        `period the collector actually answered for: ${reported.periodType || "(none)"}.`
    )
  if (!periodStart)
    notes.push(
      "No periodStart was given, so the helper applied its own default date and this answer reports " +
        `the period the collector actually answered for: ${reported.periodStart || "(none)"}.`
    )
  if (requested > HELPER_ROW_CAP)
    notes.push(
      `The helper reads at most ${HELPER_ROW_CAP} rows per call, so a row cap of ${requested} is ` +
        "refused by the helper itself and this answer carries the helper's own code instead of rows."
    )
  if (truncated)
    notes.push(
      `The answer is partial: the row cap is ${requested} and the collector held more rows than ` +
        "that, so the rows beyond the cap were not read into the result."
    )

  const rows: PerformanceSnapshotEntry[] = rowsRaw.map((row) => ({
    ...lift(row, PERFORMANCE_SNAPSHOT_FIELD_MAP),
    raw: row
  }))

  return {
    status: problem ? ("unavailable" as const) : truncated ? ("partial" as const) : ("ok" as const),
    connectionId,
    readOnly: true,
    filters: { periodType: periodType || null, periodStart: periodStart || null },
    /** The helper's own echo of the period it read; distinct from the requested filter above. */
    periodType: reported.periodType,
    periodStart: reported.periodStart,
    /** The unit the helper named for every time and counter value, echoed without conversion. */
    timeUnit: reported.timeUnit,
    rowLimit: requested,
    rowLimitRequested: options.maxRows ?? null,
    rowLimitApplied: requested,
    returnedCount: rows.length,
    truncated,
    rows,
    counts: {
      returned: rows.length,
      byComponent: tally(rowsRaw.map((row) => row.COMPONENT ?? "")),
      byPeriodType: tally(rowsRaw.map((row) => row.PERIODTYPE ?? ""))
    },
    interpretedFields: { ...PERFORMANCE_SNAPSHOT_FIELD_MAP },
    notes,
    sources: [source],
    queryTimestamp: new Date().toISOString(),
    queryWarnings
  }
}
