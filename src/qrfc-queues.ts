import type { SapBackend } from "./backend.js"
import { ALLOWLIST_MAX_ROWS } from "./table-allowlist.js"
import {
  createReviewedTableReader,
  type ReviewedReaderSource,
  type ReviewedRow
} from "./reviewed-table-reader.js"

/**
 * qRFC / tRFC queue state, read from the three queue tables the operator approved on 2026-09-25:
 * `TRFCQOUT` (outbound queues), `TRFCQIN` (inbound queues) and `TRFCQSTATE` (LUW state).
 *
 * Field selection comes from the DD03L evidence of w200 (positions, key flags, data elements and
 * lengths were read, not guessed), and the columns are published under readable names while the raw
 * codes stay verbatim: `QSTATE` and `ARFCSTATE` are stored as domain codes and this tool does not
 * translate them - the domain texts live in `DD07L`, which the metadata allowlist already covers.
 * Every field list stays well under the 512-character row the reviewed reader can carry.
 *
 * Read path: the shared reviewed reader - native data preview first, then the fingerprint-checked
 * `RFC_READ_TABLE` implementation only when the platform answers the observed empty HTML document.
 * No generic SQL fallback, no writes.
 */

export const QRFC_QUEUE_DEFAULT_ROWS = 200
/** Longest filter value: the reviewed reader caps each generated condition at 68 characters. */
export const QRFC_QUEUE_FILTER_LIMIT = 24

const TABLES = {
  TRFCQOUT: [
    "MANDT",
    "ARFCIPID",
    "ARFCPID",
    "ARFCTIME",
    "ARFCTIDCNT",
    "QNAME",
    "DEST",
    "QCOUNT",
    "HPQNAME",
    "NOSEND",
    "QSTATE",
    "QLOCKCNT",
    "QRFCUSER",
    "QRFCFNAM",
    "QRFCDATUM",
    "QRFCUZEIT",
    "QLUWCNT",
    "QMAILED",
    "ERRMESS"
  ],
  TRFCQIN: [
    "MANDT",
    "ARFCIPID",
    "ARFCPID",
    "ARFCTIME",
    "ARFCTIDCNT",
    "QNAME",
    "QCOUNT",
    "HPQNAME",
    "DEST",
    "NOSEND",
    "QSTATE",
    "QLOCKCNT",
    "QRFCUSER",
    "QRFCFNAM",
    "QRFCDATUM",
    "QRFCUZEIT",
    "ORGTID",
    "QLUWCNT",
    "BATCHPLA",
    "RETRYDATE",
    "RETRYTIME",
    "RETRYNR",
    "QMAILED",
    "ERRMESS"
  ],
  TRFCQSTATE: [
    "MANDT",
    "ARFCIPID",
    "ARFCPID",
    "ARFCTIME",
    "ARFCTIDCNT",
    "ARFCDEST",
    "ARFCLUWCNT",
    "ARFCSTATE",
    "ARFCFNAM",
    "ARFCRETURN",
    "ARFCUZEIT",
    "ARFCDATUM",
    "ARFCUSER",
    "ARFCRETRYS",
    "ARFCTCODE",
    "ARFCRHOST",
    "ARFCMSG"
  ]
} as const
type Table = keyof typeof TABLES

function queueFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : ""
  if (text.startsWith("SAP_DATA_QUERY_RESPONSE_INVALID:")) return "SAP_DATA_QUERY_RESPONSE_INVALID"
  switch (text) {
    case "QRFC_QUEUE_SCOPE_INVALID":
    case "QRFC_QUEUE_FALLBACK_UNVERIFIED":
    case "QRFC_QUEUE_NOT_AUTHORIZED":
    case "QRFC_QUEUE_RFC_FAILED":
    case "QRFC_QUEUE_RESPONSE_INVALID":
    case "QRFC_QUEUE_RESPONSE_SCOPE_MISMATCH":
    case "QRFC_QUEUE_AMBIGUOUS_RESULT":
      return text
    default:
      return "QRFC_QUEUE_QUERY_FAILED"
  }
}

/** The TID is stored as four separate fields; the composite is published as one readable value. */
const transactionId = (row: ReviewedRow) =>
  `${row.ARFCIPID ?? ""}${row.ARFCPID ?? ""}${row.ARFCTIME ?? ""}${row.ARFCTIDCNT ?? ""}`

export type QrfcQueuesOptions = {
  queueName?: string | undefined
  destination?: string | undefined
  includeLuwStates?: boolean | undefined
  maxRows?: number | undefined
}

export async function collectQrfcQueues(
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  connectionId: string,
  options: QrfcQueuesOptions,
  readDefinition: () => Promise<unknown>
) {
  const requested = Math.floor(options.maxRows ?? QRFC_QUEUE_DEFAULT_ROWS)
  if (!Number.isFinite(requested) || requested < 1) throw new Error("QRFC_QUEUE_ROW_LIMIT_INVALID")
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
      if (value.length > QRFC_QUEUE_FILTER_LIMIT) throw new Error("QRFC_QUEUE_SCOPE_INVALID")
    }
    return readTable({
      table,
      fields: TABLES[table],
      filters,
      maximum,
      filterLengthLimit: QRFC_QUEUE_FILTER_LIMIT,
      codePrefix: "QRFC_QUEUE_",
      mapError: queueFailure
    })
  }

  const queueFilters: ReviewedRow = {}
  if (options.queueName) queueFilters.QNAME = options.queueName
  if (options.destination) queueFilters.DEST = options.destination
  const outboundRows = await read("TRFCQOUT", queueFilters)
  const inboundRows = await read("TRFCQIN", queueFilters)

  const includeLuwStates = options.includeLuwStates ?? Boolean(options.destination)
  const luwFilters: ReviewedRow =
    includeLuwStates && options.destination ? { ARFCDEST: options.destination } : {}
  const luwRows = includeLuwStates ? await read("TRFCQSTATE", luwFilters) : null

  const outbound = (outboundRows ?? []).map((row) => ({
    queueName: row.QNAME!,
    destination: row.DEST!,
    transactionId: transactionId(row),
    queueCount: row.QCOUNT!,
    highPriorityQueueName: row.HPQNAME!,
    noSend: row.NOSEND!,
    state: row.QSTATE!,
    lockCount: row.QLOCKCNT!,
    user: row.QRFCUSER!,
    functionModule: row.QRFCFNAM!,
    date: row.QRFCDATUM!,
    time: row.QRFCUZEIT!,
    luwCount: row.QLUWCNT!,
    mailed: row.QMAILED!,
    errorMessage: row.ERRMESS!
  }))
  const inbound = (inboundRows ?? []).map((row) => ({
    queueName: row.QNAME!,
    destination: row.DEST!,
    transactionId: transactionId(row),
    originalTransactionId: row.ORGTID!,
    queueCount: row.QCOUNT!,
    highPriorityQueueName: row.HPQNAME!,
    noSend: row.NOSEND!,
    state: row.QSTATE!,
    lockCount: row.QLOCKCNT!,
    user: row.QRFCUSER!,
    functionModule: row.QRFCFNAM!,
    date: row.QRFCDATUM!,
    time: row.QRFCUZEIT!,
    luwCount: row.QLUWCNT!,
    batchPlanned: row.BATCHPLA!,
    retryDate: row.RETRYDATE!,
    retryTime: row.RETRYTIME!,
    retryNumber: row.RETRYNR!,
    mailed: row.QMAILED!,
    errorMessage: row.ERRMESS!
  }))
  const luwStates = (luwRows ?? []).map((row) => ({
    destination: row.ARFCDEST!,
    luwCount: row.ARFCLUWCNT!,
    state: row.ARFCSTATE!,
    functionModule: row.ARFCFNAM!,
    returnCode: row.ARFCRETURN!,
    date: row.ARFCDATUM!,
    time: row.ARFCUZEIT!,
    user: row.ARFCUSER!,
    retryCount: row.ARFCRETRYS!,
    transactionCode: row.ARFCTCODE!,
    remoteHost: row.ARFCRHOST!,
    message: row.ARFCMSG!
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
      queueName: options.queueName ?? null,
      destination: options.destination ?? null,
      includeLuwStates
    },
    rowLimit: maximum,
    rowLimitRequested: requested,
    rowLimitApplied: requested > ALLOWLIST_MAX_ROWS,
    filterValueLimit: QRFC_QUEUE_FILTER_LIMIT,
    outbound,
    inbound,
    luwStates,
    counts: {
      outbound: outbound.length,
      inbound: inbound.length,
      luwStates: luwStates.length
    },
    truncated: {
      outbound: sources.find((item) => item.table === "TRFCQOUT")?.status === "truncated",
      inbound: sources.find((item) => item.table === "TRFCQIN")?.status === "truncated",
      luwStates: sources.find((item) => item.table === "TRFCQSTATE")?.status === "truncated"
    },
    notes: [
      "state values are the domain codes stored in QRFCSTATE and ARFCSTATE, reported verbatim and " +
        "never translated; the domain texts are in DD07L, which read_abap_table can already reach.",
      "transactionId is the composite of ARFCIPID, ARFCPID, ARFCTIME and ARFCTIDCNT; the fields are " +
        "published separately as well.",
      "queueCount and luwCount are the table's own counters, reported as stored.",
      includeLuwStates
        ? "TRFCQSTATE was read"
        : "TRFCQSTATE was not read: it is only queried when includeLuwStates is set or a destination " +
          "filter is given, because an unfiltered LUW state read is the widest of the three tables."
    ],
    sources,
    queryTimestamp: new Date().toISOString(),
    queryWarnings
  }
}
