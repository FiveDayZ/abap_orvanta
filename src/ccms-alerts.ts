import { ALLOWLIST_MAX_ROWS } from "./table-allowlist.js"

/**
 * CCMS (RZ20) alert history, read from `ALALERTDB` - the alert database the operator approved on
 * 2026-09-28.
 *
 * What this is: the alerts the monitoring architecture has *recorded*, each with the monitored
 * object and field, the severities and status the architecture stored, and the time the alert
 * cleared. What this is deliberately not: a live alert monitor. RZ20 displays the in-memory MTE
 * tree, which this table does not contain, so an empty `openOnly` result says no alert is stored as
 * open and never that the system is healthy right now.
 *
 * Three limits are measured facts of w200 rather than guesses, and each one is repeated in the
 * answer's notes so a caller never has to read this comment to avoid misreading the result:
 *
 *   - `SEVERITY`, `STATUS` and `VALUE` are integer fields (DDIC type I, length 10). The reader
 *     refuses a filter on a non-character column with `TABLE_QUERY_LEGACY_LAYOUT_UNSUPPORTED`, so
 *     this tool refuses such a filter itself (`CCMS_ALERTS_SCOPE_INVALID`) instead of forwarding a
 *     request whose failure mode would be indistinguishable from an empty result.
 *   - `MANDT` is not part of the table key, so the table is not client-isolated: a 500-row
 *     unfiltered read on w200 returned client 200 (493 rows), 100 (4), 000 (1) and two rows with an
 *     empty client. The client filter is therefore explicit and opt-in.
 *   - Projection width decides the row ceiling. `MSGTEXT` and `MSGARG1`-`MSGARG4` are 128 bytes
 *     each; including them raised `TABLE_QUERY_REQUEST_BUDGET_EXCEEDED` at `maxRows` 200 on w200,
 *     while the projection below returned 500 rows unfiltered. They are left out, and the answer
 *     says so.
 *
 * The read goes through the same reviewed table-query path `read_abap_table` uses, so the allowlist
 * and the fingerprint-verified readers apply unchanged. Read-only: nothing is written, and no
 * status or severity is translated - the domain texts live in `DD07L`.
 */

export const CCMS_ALERTS_DEFAULT_ROWS = 200
/** Longest accepted filter value; the reviewed reader builds one quoted condition per column. */
export const CCMS_ALERTS_FILTER_LIMIT = 40
/** The reviewed reader accepts at most this many conditions in one read. */
export const CCMS_ALERTS_FILTER_LIMIT_COUNT = 8

/**
 * The projection, in DDIC order, chosen so the whole row stays inside one 512-character chunk and
 * inside the reader's data-call budget. Widths are the w200 DD03L lengths: 424 bytes over 26
 * columns. `VALUE`, `SEVERITY` and `STATUS` are integer-typed and are returned verbatim.
 */
export const CCMS_ALERT_COLUMNS = [
  "ALSYSID",
  "MSEGNAME",
  "ALUNIQNUM",
  "ALINDEX",
  "ALERTDATE",
  "ALERTTIME",
  "MTSYSID",
  "MTMCNAME",
  "MTCLASS",
  "MTINDEX",
  "VALUE",
  "SEVERITY",
  "STATUS",
  "OBJECTNAME",
  "FIELDNAME",
  "GONEDATE",
  "GONETIME",
  "REPORTEDBY",
  "STATCHGDAT",
  "STATCHGTIM",
  "STATCHGBY",
  "MSGID",
  "MSGCLASS",
  "MANDT",
  "USERID",
  "MSCGLID"
] as const

export type CcmsAlertOperator = "EQ" | "NE" | "LT" | "LE" | "GT" | "GE"
export type CcmsAlertFilter = {
  column: string
  operator: CcmsAlertOperator
  value: string
}

/** The shape the reviewed table path answers with, narrowed to what this tool consumes. */
export type CcmsAlertReadResult = {
  status?: string | undefined
  code?: string | undefined
  stage?: string | undefined
  detail?: unknown
  returnedCount?: number | undefined
  truncated?: boolean | null | undefined
  data?: Array<Record<string, unknown>> | null | undefined
}

export type CcmsAlertTableReader = (query: {
  tableName: string
  columns: string[]
  filters: CcmsAlertFilter[]
  maxRows: number
}) => Promise<CcmsAlertReadResult>

export type CcmsAlertsOptions = {
  maxRows?: number | undefined
  alertDateFrom?: string | undefined
  alertDateTo?: string | undefined
  clearedFrom?: string | undefined
  clearedTo?: string | undefined
  openOnly?: boolean | undefined
  alertSystem?: string | undefined
  monitorSet?: string | undefined
  objectName?: string | undefined
  fieldName?: string | undefined
  client?: string | undefined
}

const datePattern = /^\d{8}$/
const text = (value: unknown) => (value === undefined || value === null ? "" : String(value))

/** A clear date is a real one only when it is eight digits and not the all-zero initial value. */
export function alertCleared(goneDate: string): boolean {
  return datePattern.test(goneDate) && goneDate !== "00000000"
}

export async function collectCcmsAlerts(
  read: CcmsAlertTableReader,
  connectionId: string,
  options: CcmsAlertsOptions
) {
  const requested = Math.floor(options.maxRows ?? CCMS_ALERTS_DEFAULT_ROWS)
  if (!Number.isFinite(requested) || requested < 1) throw new Error("CCMS_ALERTS_ROW_LIMIT_INVALID")
  const maximum = Math.min(requested, ALLOWLIST_MAX_ROWS)

  const dates: Array<[string, string | undefined]> = [
    ["alertDateFrom", options.alertDateFrom],
    ["alertDateTo", options.alertDateTo],
    ["clearedFrom", options.clearedFrom],
    ["clearedTo", options.clearedTo]
  ]
  for (const [name, value] of dates) {
    if (value !== undefined && !datePattern.test(value))
      throw new Error(`CCMS_ALERTS_SCOPE_INVALID: ${name} must be YYYYMMDD`)
  }
  const openOnly = options.openOnly ?? false
  // "Still open" and "cleared inside this window" are opposite selections; accepting both would
  // silently answer whichever the caller did not ask for.
  if (openOnly && (options.clearedFrom !== undefined || options.clearedTo !== undefined))
    throw new Error("CCMS_ALERTS_SCOPE_INVALID: openOnly excludes clearedFrom/clearedTo")
  if (
    options.alertDateFrom !== undefined &&
    options.alertDateTo !== undefined &&
    options.alertDateFrom > options.alertDateTo
  )
    throw new Error("CCMS_ALERTS_SCOPE_INVALID: alertDateFrom is after alertDateTo")
  if (
    options.clearedFrom !== undefined &&
    options.clearedTo !== undefined &&
    options.clearedFrom > options.clearedTo
  )
    throw new Error("CCMS_ALERTS_SCOPE_INVALID: clearedFrom is after clearedTo")

  // Every condition is built here from a named option, so no caller text reaches the condition
  // list except as a quoted literal the reader itself escapes.
  const filters: CcmsAlertFilter[] = []
  if (options.alertDateFrom !== undefined)
    filters.push({ column: "ALERTDATE", operator: "GE", value: options.alertDateFrom })
  if (options.alertDateTo !== undefined)
    filters.push({ column: "ALERTDATE", operator: "LE", value: options.alertDateTo })
  if (openOnly) filters.push({ column: "GONEDATE", operator: "EQ", value: "" })
  if (options.clearedFrom !== undefined)
    filters.push({ column: "GONEDATE", operator: "GE", value: options.clearedFrom })
  if (options.clearedTo !== undefined)
    filters.push({ column: "GONEDATE", operator: "LE", value: options.clearedTo })
  if (options.alertSystem !== undefined)
    filters.push({ column: "ALSYSID", operator: "EQ", value: options.alertSystem })
  if (options.monitorSet !== undefined)
    filters.push({ column: "MSEGNAME", operator: "EQ", value: options.monitorSet })
  if (options.objectName !== undefined)
    filters.push({ column: "OBJECTNAME", operator: "EQ", value: options.objectName })
  if (options.fieldName !== undefined)
    filters.push({ column: "FIELDNAME", operator: "EQ", value: options.fieldName })
  if (options.client !== undefined)
    filters.push({ column: "MANDT", operator: "EQ", value: options.client })
  for (const filter of filters) {
    if (filter.value.length > CCMS_ALERTS_FILTER_LIMIT)
      throw new Error(`CCMS_ALERTS_SCOPE_INVALID: ${filter.column} value exceeds the limit`)
  }
  if (filters.length > CCMS_ALERTS_FILTER_LIMIT_COUNT)
    throw new Error(
      `CCMS_ALERTS_SCOPE_INVALID: ${filters.length} conditions requested, the reader accepts ` +
        `${CCMS_ALERTS_FILTER_LIMIT_COUNT}`
    )

  const result = await read({
    tableName: "ALALERTDB",
    columns: [...CCMS_ALERT_COLUMNS],
    filters,
    maxRows: maximum
  })

  const notes = [
    "This is alert history from ALALERTDB, the persisted CCMS alert store - not the RZ20 live " +
      "monitor, which displays the in-memory MTE tree and is not in this table. An empty " +
      "openOnly answer therefore means no alert is stored as open; it is not a statement that " +
      "the system is healthy right now.",
    "Row order is unspecified: the reader has no ordering parameter, so these are not the newest " +
      "rows. Use alertDateFrom/alertDateTo to bound the window you actually mean.",
    "severity, status and value are integer fields (DDIC type I), returned verbatim and never " +
      "translated. They cannot be filtered: the reader refuses a condition on a non-character " +
      "column with TABLE_QUERY_LEGACY_LAYOUT_UNSUPPORTED, so this tool rejects such a request " +
      "itself rather than let a refusal look like an empty result. The domain texts are in DD07L, " +
      "which read_abap_table already reaches.",
    "ALALERTDB is not client-isolated: MANDT is not part of its key. A 500-row unfiltered read on " +
      "w200 returned client 200 (493 rows), 100 (4), 000 (1) and two rows with an empty client. " +
      "Every row carries its own client; pass client to restrict the read.",
    "cleared is derived from GONEDATE alone - true when it is a real eight-digit date other than " +
      "00000000. open is its negation. Nothing else is inferred and no status is translated.",
    "MSGTEXT and MSGARG1-MSGARG4 are deliberately not selected: at 128 bytes each they pushed the " +
      "read past its data-call budget (TABLE_QUERY_REQUEST_BUDGET_EXCEEDED at maxRows 200 on " +
      "w200), while this 26-column projection returned 500 rows unfiltered.",
    "maxRows bounds the read and truncated reports whether more rows exist; this is a bounded " +
      "sample and never a total."
  ]

  if (result.status !== "ok" || !Array.isArray(result.data)) {
    // The reader's own code and stage are reported verbatim so one vocabulary covers both the
    // budget refusal and the layout refusal; inventing a second set here would be a drift risk.
    return {
      status: "unavailable" as const,
      connectionId,
      readOnly: true,
      tableName: "ALALERTDB",
      code: result.code ?? "CCMS_ALERTS_QUERY_FAILED",
      stage: result.stage ?? "unknown",
      returnedCount: 0,
      truncated: null,
      data: null,
      filters: { applied: filters, count: filters.length },
      rowLimit: maximum,
      rowLimitRequested: requested,
      rowLimitApplied: requested > ALLOWLIST_MAX_ROWS,
      columns: [...CCMS_ALERT_COLUMNS],
      notes,
      queryTimestamp: new Date().toISOString()
    }
  }

  const alerts = result.data.map((row) => {
    const goneDate = text(row.GONEDATE)
    return {
      alertSystem: text(row.ALSYSID),
      monitorSet: text(row.MSEGNAME),
      alertUniqueNumber: text(row.ALUNIQNUM),
      alertIndex: text(row.ALINDEX),
      alertDate: text(row.ALERTDATE),
      alertTime: text(row.ALERTTIME),
      monitoringSystem: text(row.MTSYSID),
      monitoringContext: text(row.MTMCNAME),
      monitoringClass: text(row.MTCLASS),
      monitoringIndex: text(row.MTINDEX),
      value: text(row.VALUE),
      severity: text(row.SEVERITY),
      status: text(row.STATUS),
      objectName: text(row.OBJECTNAME),
      fieldName: text(row.FIELDNAME),
      clearedDate: goneDate,
      clearedTime: text(row.GONETIME),
      cleared: alertCleared(goneDate),
      open: !alertCleared(goneDate),
      reportedBy: text(row.REPORTEDBY),
      statusChangedDate: text(row.STATCHGDAT),
      statusChangedTime: text(row.STATCHGTIM),
      statusChangedBy: text(row.STATCHGBY),
      messageId: text(row.MSGID),
      messageClass: text(row.MSGCLASS),
      client: text(row.MANDT),
      userId: text(row.USERID),
      messageClassId: text(row.MSCGLID)
    }
  })

  const cleared = alerts.filter((alert) => alert.cleared).length
  const truncated = result.truncated === true
  return {
    status: truncated ? ("partial" as const) : ("ok" as const),
    connectionId,
    readOnly: true,
    tableName: "ALALERTDB",
    filters: { applied: filters, count: filters.length },
    rowLimit: maximum,
    rowLimitRequested: requested,
    rowLimitApplied: requested > ALLOWLIST_MAX_ROWS,
    clientFilterApplied: options.client !== undefined,
    openOnly,
    columns: [...CCMS_ALERT_COLUMNS],
    returnedCount: alerts.length,
    truncated,
    alerts,
    counts: {
      returned: alerts.length,
      clearedOpenState: { cleared, open: alerts.length - cleared }
    },
    notes,
    queryTimestamp: new Date().toISOString()
  }
}
