import type { SapBackend } from "./backend.js"
import { ALLOWLIST_MAX_ROWS } from "./table-allowlist.js"
import {
  createReviewedTableReader,
  type ReviewedReaderSource,
  type ReviewedRow
} from "./reviewed-table-reader.js"

/**
 * IDoc control records and their status records, read from the two tables the operator approved on
 * 2026-09-25: `EDIDC` (control records) and `EDIDS` (status records).
 *
 * Field selection comes from the DD03L evidence of w200. Codes stay verbatim: `STATUS`, `DIRECT` and
 * `TEST` are stored domain codes (`EDI_STATUS`, `EDI_DIRECT`, `EDI_TEST`) and this tool does not
 * translate them, exactly as it never maps a status text of its own. `EDIDS` is only read when a
 * single `docnum` is given or when status records are explicitly requested without a document filter,
 * because the reader supports one condition per call and an unfiltered status-record read is large.
 *
 * Read path: the shared reviewed reader - native data preview first, then the fingerprint-checked
 * `RFC_READ_TABLE` implementation only when the platform answers the observed empty HTML document.
 * No generic SQL fallback, no writes.
 */

export const IDOC_STATUS_DEFAULT_ROWS = 200
/** Longest filter value: the reviewed reader caps each generated condition at 68 characters. */
export const IDOC_STATUS_FILTER_LIMIT = 30

const TABLES = {
  EDIDC: [
    "MANDT",
    "DOCNUM",
    "DOCREL",
    "STATUS",
    "DOCTYP",
    "DIRECT",
    "RCVPOR",
    "RCVPRT",
    "RCVPRN",
    "SNDPOR",
    "SNDPRT",
    "SNDPRN",
    "MESTYP",
    "IDOCTP",
    "CIMTYP",
    "CREDAT",
    "CRETIM",
    "UPDDAT",
    "UPDTIM",
    "TEST",
    "SERIAL",
    "REFINT",
    "REFGRP",
    "REFMES",
    "MAXSEGNUM"
  ],
  EDIDS: [
    "MANDT",
    "DOCNUM",
    "LOGDAT",
    "LOGTIM",
    "COUNTR",
    "CREDAT",
    "CRETIM",
    "STATUS",
    "UNAME",
    "REPID",
    "ROUTID",
    "STACOD",
    "STATXT",
    "SEGNUM",
    "SEGFELD",
    "STAMQU",
    "STAMID",
    "STAMNO",
    "TID",
    "APPL_LOG"
  ]
} as const
type Table = keyof typeof TABLES

function idocFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : ""
  if (text.startsWith("SAP_DATA_QUERY_RESPONSE_INVALID:")) return "SAP_DATA_QUERY_RESPONSE_INVALID"
  switch (text) {
    case "IDOC_STATUS_SCOPE_INVALID":
    case "IDOC_STATUS_FALLBACK_UNVERIFIED":
    case "IDOC_STATUS_NOT_AUTHORIZED":
    case "IDOC_STATUS_RFC_FAILED":
    case "IDOC_STATUS_RESPONSE_INVALID":
    case "IDOC_STATUS_RESPONSE_SCOPE_MISMATCH":
    case "IDOC_STATUS_AMBIGUOUS_RESULT":
      return text
    default:
      return "IDOC_STATUS_QUERY_FAILED"
  }
}

export type IdocStatusOptions = {
  docnum?: string | undefined
  status?: string | undefined
  messageType?: string | undefined
  includeStatusRecords?: boolean | undefined
  maxRows?: number | undefined
}

export async function collectIdocStatus(
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  connectionId: string,
  options: IdocStatusOptions,
  readDefinition: () => Promise<unknown>
) {
  const requested = Math.floor(options.maxRows ?? IDOC_STATUS_DEFAULT_ROWS)
  if (!Number.isFinite(requested) || requested < 1) throw new Error("IDOC_STATUS_ROW_LIMIT_INVALID")
  const maximum = Math.min(requested, ALLOWLIST_MAX_ROWS)
  const sources: ReviewedReaderSource[] = []
  const queryWarnings: string[] = []
  const readTable = createReviewedTableReader(
    backend,
    connectionId,
    readDefinition,
    sources,
    queryWarnings
  )
  const read = (table: Table, filters: ReviewedRow) => {
    for (const value of Object.values(filters)) {
      if (value.length > IDOC_STATUS_FILTER_LIMIT) throw new Error("IDOC_STATUS_SCOPE_INVALID")
    }
    return readTable({
      table,
      fields: TABLES[table],
      filters,
      maximum,
      filterLengthLimit: IDOC_STATUS_FILTER_LIMIT,
      codePrefix: "IDOC_STATUS_",
      mapError: idocFailure
    })
  }

  const controlFilters: ReviewedRow = {}
  if (options.docnum) controlFilters.DOCNUM = options.docnum
  if (options.status) controlFilters.STATUS = options.status
  if (options.messageType) controlFilters.MESTYP = options.messageType
  const controlRows = await read("EDIDC", controlFilters)

  const includeStatusRecords = options.includeStatusRecords ?? Boolean(options.docnum)
  const statusFilters: ReviewedRow = options.docnum ? { DOCNUM: options.docnum } : {}
  const statusRows = includeStatusRecords ? await read("EDIDS", statusFilters) : null

  const idocs = (controlRows ?? []).map((row) => ({
    docnum: row.DOCNUM!,
    documentRelease: row.DOCREL!,
    status: row.STATUS!,
    direction: row.DIRECT!,
    basicType: row.DOCTYP!,
    messageType: row.MESTYP!,
    idocType: row.IDOCTP!,
    extensionType: row.CIMTYP!,
    sender: {
      port: row.SNDPOR!,
      partnerType: row.SNDPRT!,
      partnerNumber: row.SNDPRN!
    },
    receiver: {
      port: row.RCVPOR!,
      partnerType: row.RCVPRT!,
      partnerNumber: row.RCVPRN!
    },
    createdDate: row.CREDAT!,
    createdTime: row.CRETIM!,
    updatedDate: row.UPDDAT!,
    updatedTime: row.UPDTIM!,
    test: row.TEST!,
    serial: row.SERIAL!,
    reference: {
      interchange: row.REFINT!,
      group: row.REFGRP!,
      message: row.REFMES!
    },
    maxSegmentNumber: row.MAXSEGNUM!
  }))
  const statusRecords = (statusRows ?? []).map((row) => ({
    docnum: row.DOCNUM!,
    logDate: row.LOGDAT!,
    logTime: row.LOGTIM!,
    counter: row.COUNTR!,
    createdDate: row.CREDAT!,
    createdTime: row.CRETIM!,
    status: row.STATUS!,
    user: row.UNAME!,
    program: row.REPID!,
    routine: row.ROUTID!,
    statusCode: row.STACOD!,
    statusText: row.STATXT!,
    segmentNumber: row.SEGNUM!,
    segmentField: row.SEGFELD!,
    messageQualifier: row.STAMQU!,
    messageClass: row.STAMID!,
    messageNumber: row.STAMNO!,
    tid: row.TID!,
    applicationLog: row.APPL_LOG!
  }))

  const failed = sources.filter(
    (item) => item.status === "unavailable" || item.status === "invalid"
  )
  const truncatedSources = sources.filter((item) => item.status === "truncated")
  const status =
    failed.length === sources.length
      ? "unavailable"
      : failed.length || truncatedSources.length
        ? "partial"
        : "ok"
  return {
    status,
    connectionId,
    readOnly: true,
    filters: {
      docnum: options.docnum ?? null,
      status: options.status ?? null,
      messageType: options.messageType ?? null,
      includeStatusRecords
    },
    rowLimit: maximum,
    rowLimitRequested: requested,
    rowLimitApplied: requested > ALLOWLIST_MAX_ROWS,
    filterValueLimit: IDOC_STATUS_FILTER_LIMIT,
    idocCount: idocs.length,
    idocsTruncated: sources.find((item) => item.table === "EDIDC")?.status === "truncated",
    idocs,
    statusRecordCount: statusRecords.length,
    statusRecordsTruncated: sources.find((item) => item.table === "EDIDS")?.status === "truncated",
    statusRecords,
    notes: [
      "status, direction and test are the domain codes stored in EDIDC (EDI_STATUS, EDI_DIRECT, " +
        "EDI_TEST) plus the status text EDIDS carries; none of them is translated here.",
      "the feed reports control records and status records exactly as stored; a status text the " +
        "source system left blank is returned blank rather than filled in.",
      includeStatusRecords
        ? "EDIDS was read for the same DOCNUM filter"
        : "EDIDS was not read: pass docnum (exact) or includeStatusRecords to read status records, " +
          "because the reviewed reader supports one condition per call."
    ],
    sources,
    queryTimestamp: new Date().toISOString(),
    queryWarnings
  }
}
