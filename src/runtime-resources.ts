import { z } from "zod"
import type { SapBackend } from "./backend.js"

/**
 * The runtime-resource reads behind SM50/SM66 and SM04.
 *
 * Why they are service-side: the assessment expected this family to need the in-SAP helper,
 * because ADT publishes no work-process, session, performance, database-activity or filesystem
 * endpoint. A read-only probe of w200 on 2026-09-25 narrowed that: `TH_WPINFO` (the kernel's work
 * process list, the source behind SM50/SM66) and `TH_USER_LIST` (the user/session list behind
 * SM04) are remote-enabled standard function modules whose output tables resolve to verified RFC
 * scalar types, so the service can call them directly through the same SOAP-RFC path
 * `get_sap_system_info` already uses for `RFC_SYSTEM_INFO`. No helper operation, no carrier, no
 * manual F8. `read_performance_snapshot`, `read_db_activity` and `read_file_system_directory`
 * remain open and are *not* claimed here.
 *
 * What is interpreted, and what is not: each returned row carries the lifted names below **and**
 * the untranslated row in `raw`, and `interpretedFields` states which SAP field every name came
 * from. Numeric code columns are reported as the kernel returned them: the domain fixed values
 * were not read, so no code is turned into a label, and the tallies count the kernel's own values
 * rather than a meaning this tool invented. Both reads are snapshots: they observe the state at
 * the moment of the call and keep no history.
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

export type RuntimeResourceSource = {
  table: "TH_WPINFO" | "TH_USER_LIST"
  status: "ok" | "unavailable" | "invalid"
  method: "rfc_call"
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

/** One lifted row: the named values plus the untranslated SAP row they were lifted from. */
type WorkProcessEntry = Record<keyof typeof WORK_PROCESS_FIELDS, string> & { raw: Session }
type SessionEntry = Record<keyof typeof SESSION_FIELD_MAP, string> & { raw: Session }

/** Rows as the SOAP-RFC reader returns them: trimmed strings, no type coercion. */
function tableRows(value: unknown): Session[] {
  if (!Array.isArray(value)) throw new Error("RUNTIME_RESOURCES_RESPONSE_INVALID")
  return value.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new Error("RUNTIME_RESOURCES_RESPONSE_INVALID")
    const record: Session = {}
    for (const field of Object.keys(row)) {
      const cell = (row as Session)[field]
      if (typeof cell !== "string") throw new Error("RUNTIME_RESOURCES_RESPONSE_INVALID")
      record[field] = cell.trim()
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

export interface WorkProcessOptions {
  serverName?: string | undefined
  maxRows?: number | undefined
}

export async function collectWorkProcesses(
  backend: Pick<SapBackend, "callRemoteFunction">,
  connectionId: string,
  options: WorkProcessOptions,
  readDefinition: () => Promise<unknown>
) {
  const requested = rowLimit(options.maxRows)
  const serverName = printable(options.serverName, RUNTIME_RESOURCES_SERVER_LIMIT)
  const source: RuntimeResourceSource = {
    table: "TH_WPINFO",
    status: "unavailable",
    method: "rfc_call",
    returnedCount: 0
  }
  const queryWarnings: string[] = []
  const notes = [
    "Work process rows come from TH_WPINFO, the kernel's own work process list (the source behind " +
      "SM50/SM66), read as a snapshot. No history is kept and nothing is aggregated across calls.",
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

  let workProcesses: WorkProcessEntry[] = []
  let rows: Session[] = []
  try {
    if (!reviewedWorkProcessDefinition.safeParse(await readDefinition()).success)
      throw new Error("RUNTIME_RESOURCES_FUNCTION_UNVERIFIED")
    const result = await backend.callRemoteFunction(connectionId, {
      functionName: "TH_WPINFO",
      inputParameters: serverName ? { SRVNAME: serverName } : {},
      outputParameters: [{ name: "WPLIST", kind: "table", fields: [...WP_FIELDS] }]
    })
    if (result.fault)
      throw new Error(
        result.fault.name === "NOT_AUTHORIZED"
          ? "RUNTIME_RESOURCES_NOT_AUTHORIZED"
          : "RUNTIME_RESOURCES_RFC_FAILED"
      )
    const raw = result.outputs.WPLIST
    if (raw === undefined) throw new Error("RUNTIME_RESOURCES_RESPONSE_INVALID")
    rows = tableRows(raw)
    if (!rows.length) throw new Error("RUNTIME_RESOURCES_RESPONSE_EMPTY")
    source.status = "ok"
    source.returnedCount = rows.length
  } catch (error) {
    source.code = failure(error)
    if (source.code === "RUNTIME_RESOURCES_RESPONSE_INVALID") source.status = "invalid"
    queryWarnings.push(`TH_WPINFO: ${source.code}`)
  }

  const truncated = rows.length > requested
  if (truncated)
    notes.push(
      `The kernel returned ${rows.length} work processes and the row cap is ${requested}, so the ` +
        "answer is partial: the rows beyond the cap were not read into the result."
    )
  const selected = rows.slice(0, requested)
  workProcesses = selected.map((row) => ({
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
  backend: Pick<SapBackend, "callRemoteFunction">,
  connectionId: string,
  options: UserSessionOptions,
  readDefinition: () => Promise<unknown>
) {
  const requested = rowLimit(options.maxRows)
  const userName = printable(options.userName, RUNTIME_RESOURCES_USER_LIMIT).toUpperCase()
  const source: RuntimeResourceSource = {
    table: "TH_USER_LIST",
    status: "unavailable",
    method: "rfc_call",
    returnedCount: 0
  }
  const queryWarnings: string[] = []
  const notes = [
    "Session rows come from TH_USER_LIST, the kernel's own user and session list (the source " +
      "behind SM04), read as a snapshot. No history is kept.",
    "Only the USRLIST output is requested. The kernel's LIST output is not read because one of its " +
      "fields carries a type this service cannot verify, so a session the kernel reports only there " +
      "is not claimed by this tool.",
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
        `snapshot", not "the user does not exist".`
    )

  let rows: Session[] = []
  try {
    if (!reviewedSessionListDefinition.safeParse(await readDefinition()).success)
      throw new Error("RUNTIME_RESOURCES_FUNCTION_UNVERIFIED")
    const result = await backend.callRemoteFunction(connectionId, {
      functionName: "TH_USER_LIST",
      inputParameters: {},
      outputParameters: [{ name: "USRLIST", kind: "table", fields: [...SESSION_FIELDS] }]
    })
    if (result.fault)
      throw new Error(
        result.fault.name === "NOT_AUTHORIZED"
          ? "RUNTIME_RESOURCES_NOT_AUTHORIZED"
          : "RUNTIME_RESOURCES_RFC_FAILED"
      )
    const raw = result.outputs.USRLIST
    if (raw === undefined) throw new Error("RUNTIME_RESOURCES_RESPONSE_INVALID")
    rows = tableRows(raw)
    if (!rows.length) throw new Error("RUNTIME_RESOURCES_RESPONSE_EMPTY")
    source.status = "ok"
    source.returnedCount = rows.length
  } catch (error) {
    source.code = failure(error)
    if (source.code === "RUNTIME_RESOURCES_RESPONSE_INVALID") source.status = "invalid"
    queryWarnings.push(`TH_USER_LIST: ${source.code}`)
  }

  const matched = userName
    ? rows.filter((row) => (row.BNAME ?? "").toUpperCase() === userName)
    : rows
  const truncated = matched.length > requested
  if (truncated)
    notes.push(
      `The matching rows are ${matched.length} and the row cap is ${requested}, so the answer is ` +
        "partial: the rows beyond the cap were not read into the result."
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
    /** Rows the kernel returned before the service-side user filter; reported so a filter is visible. */
    kernelRowCount: rows.length,
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
