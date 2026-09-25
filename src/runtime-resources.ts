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
  table: "TH_WPINFO" | "TH_USER_LIST" | "EPS2_GET_DIRECTORY_LISTING" | "SWNC_GET_WORKLOAD_DIRECTORY"
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
/** `EPS2_GET_DIRECTORY_LISTING.IV_DIR_NAME` is `EPS2FILNAM` (`CHAR200`). */
export const RUNTIME_RESOURCES_DIRECTORY_LIMIT = 200
/** `EPS2_GET_DIRECTORY_LISTING.FILE_MASK` is `EPSF-EPSFILNAM` (`CHAR40`). */
export const RUNTIME_RESOURCES_MASK_LIMIT = 40

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
  backend: Pick<SapBackend, "callRemoteFunction">,
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
    method: "rfc_call",
    returnedCount: 0
  }
  const queryWarnings: string[] = []
  const notes = [
    "Directory entries come from EPS2_GET_DIRECTORY_LISTING, the kernel's own directory listing " +
      "(the source behind AL11), read as a snapshot. File contents are never read, and this tool " +
      "cannot create, move, rename or delete anything.",
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

  let rows: Session[] = []
  let listed = { directory: "", files: "", errors: "" }
  try {
    if (!reviewedDirectoryDefinition.safeParse(await readDefinition()).success)
      throw new Error("RUNTIME_RESOURCES_FUNCTION_UNVERIFIED")
    const result = await backend.callRemoteFunction(connectionId, {
      functionName: "EPS2_GET_DIRECTORY_LISTING",
      inputParameters: fileMask
        ? { IV_DIR_NAME: directory, FILE_MASK: fileMask }
        : { IV_DIR_NAME: directory },
      outputParameters: [
        { name: "DIR_NAME", kind: "scalar" },
        { name: "FILE_COUNTER", kind: "scalar" },
        { name: "ERROR_COUNTER", kind: "scalar" },
        { name: "DIR_LIST", kind: "table", fields: [...DIRECTORY_FIELDS] }
      ]
    })
    if (result.fault)
      throw new Error(
        result.fault.name === "NOT_AUTHORIZED"
          ? "RUNTIME_RESOURCES_NOT_AUTHORIZED"
          : "RUNTIME_RESOURCES_RFC_FAILED"
      )
    const raw = result.outputs.DIR_LIST
    if (raw === undefined) throw new Error("RUNTIME_RESOURCES_RESPONSE_INVALID")
    // Unlike the work process and session lists, an empty directory is an ordinary answer.
    rows = tableRows(raw)
    listed = {
      directory: scalarText(result.outputs.DIR_NAME),
      files: scalarText(result.outputs.FILE_COUNTER),
      errors: scalarText(result.outputs.ERROR_COUNTER)
    }
    source.status = "ok"
    source.returnedCount = rows.length
  } catch (error) {
    source.code = failure(error)
    if (source.code === "RUNTIME_RESOURCES_RESPONSE_INVALID") source.status = "invalid"
    queryWarnings.push(`EPS2_GET_DIRECTORY_LISTING: ${source.code}`)
  }

  const truncated = rows.length > requested
  if (truncated)
    notes.push(
      `The kernel returned ${rows.length} entries and the row cap is ${requested}, so the answer ` +
        "is partial: the entries beyond the cap were not read into the result."
    )
  const selected = rows.slice(0, requested)
  const entries: DirectoryEntry[] = selected.map((row) => ({
    ...lift(row, DIRECTORY_FIELD_MAP),
    raw: row
  }))

  if (source.status === "ok") {
    const counted = integer(listed.files)
    if (counted !== null && counted !== rows.length)
      queryWarnings.push(
        `EPS2_GET_DIRECTORY_LISTING: FILE_COUNTER is ${counted} but DIR_LIST carried ` +
          `${rows.length} entries, so the kernel's own count and its row list disagree.`
      )
    const errored = integer(listed.errors)
    if (errored !== null && errored > 0)
      queryWarnings.push(
        `EPS2_GET_DIRECTORY_LISTING: ERROR_COUNTER is ${errored}, so the kernel reported at least ` +
          "one entry it could not process."
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
