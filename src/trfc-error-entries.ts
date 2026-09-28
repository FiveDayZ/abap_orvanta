import type { SapBackend } from "./backend.js"
import { ALLOWLIST_MAX_ROWS } from "./table-allowlist.js"
import {
  createReviewedTableReader,
  type ReviewedReaderSource,
  type ReviewedRow
} from "./reviewed-table-reader.js"

/**
 * The SM58 tRFC error queue, read from `ARFCSSTATE`.
 *
 * Why this table and not `ARFCSDATA`: both were approved for registration by the operator on
 * 2026-09-28, but only `ARFCSSTATE` has a readable layout. `ARFCSDATA` is a payload container -
 * `ARFCBLCNT` (RAW 4) plus `ARFCDATA01`..`ARFCDATA07` (RAW 255 each) - so it is 1785 bytes of RAW
 * with no character column at all. Byte projections fail closed in this reader and the joined row
 * would exceed the 512-character limit the legacy path accepts, so registering it would declare a
 * read path that cannot work. It is deliberately not registered, and that decision is recorded here
 * and in `.doc/code-update-20260928-*.md`.
 *
 * What this answers that `read_qrfc_queues` does not: `TRFCQSTATE` reports qRFC/tRFC LUW states in
 * the *queue* tables, while `ARFCSSTATE` is the kernel's tRFC error bookkeeping (transaction SM58) -
 * the LUW itself, its destination, function module, return flag, retry count and the kernel's own
 * message variable. The two are different tables in different states, not two views of one.
 *
 * Field selection comes from the DD03L rows of w200 and from the DDIC definition read back on
 * 2026-09-28 (`read_ddic_transparent_table`: package SRFC, tableClass TRANSP, deliveryClass L,
 * version 20110901122124, fingerprint 25f6c13d...). `ARFCSTATE` is published verbatim and never
 * translated; its own DDIC description names the stored codes (RECORDED, CPICERR, MAILED, READ, ...)
 * and the domain lives in DD07L, which `read_abap_table` already reaches.
 *
 * Read path: the shared reviewed reader - native data preview first, then the fingerprint-checked
 * `RFC_READ_TABLE` implementation only when the platform answers the observed empty HTML document.
 * No generic SQL fallback, no writes.
 */

export const TRFC_ERROR_DEFAULT_ROWS = 200

/**
 * Longest accepted filter value.
 *
 * `ARFCDEST` is CHAR 32, the widest field this tool filters on, and the reviewed reader refuses any
 * generated condition longer than 68 characters - `ARFCDEST = '<32 characters>'` is 45, so 32 is both
 * the field's own width and comfortably inside the reader's cap.
 */
export const TRFC_ERROR_FILTER_LIMIT = 32

/**
 * The projection. Every character, date, time and numeric-text field of ARFCSSTATE except
 * `ARFCRESERV` (a SYULINE filler with no diagnostic value) and `HASH` (RAW 40, which fails closed):
 * 211 characters plus delimiters, well inside the 512-character row the legacy path carries.
 */
const STATE_FIELDS = [
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
] as const

const TABLE = "ARFCSSTATE"

export const TRFC_ERROR_TABLE = TABLE

function trfcFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : ""
  if (text.startsWith("SAP_DATA_QUERY_RESPONSE_INVALID:")) return "SAP_DATA_QUERY_RESPONSE_INVALID"
  switch (text) {
    case "TRFC_ERROR_SCOPE_INVALID":
    case "TRFC_ERROR_FALLBACK_UNVERIFIED":
    case "TRFC_ERROR_NOT_AUTHORIZED":
    case "TRFC_ERROR_RFC_FAILED":
    case "TRFC_ERROR_RESPONSE_INVALID":
    case "TRFC_ERROR_RESPONSE_SCOPE_MISMATCH":
    case "TRFC_ERROR_AMBIGUOUS_RESULT":
      return text
    default:
      return "TRFC_ERROR_QUERY_FAILED"
  }
}

/** The TID is stored as four separate fields; the composite is published as one readable value. */
const transactionId = (row: ReviewedRow) =>
  `${row.ARFCIPID ?? ""}${row.ARFCPID ?? ""}${row.ARFCTIME ?? ""}${row.ARFCTIDCNT ?? ""}`

export type TrfcErrorEntriesOptions = {
  destination?: string | undefined
  functionModule?: string | undefined
  state?: string | undefined
  user?: string | undefined
  maxRows?: number | undefined
}

export async function collectTrfcErrorEntries(
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  connectionId: string,
  options: TrfcErrorEntriesOptions,
  readDefinition: () => Promise<unknown>
) {
  const requested = Math.floor(options.maxRows ?? TRFC_ERROR_DEFAULT_ROWS)
  if (!Number.isFinite(requested) || requested < 1) throw new Error("TRFC_ERROR_ROW_LIMIT_INVALID")
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

  const filters: ReviewedRow = {}
  if (options.destination) filters.ARFCDEST = options.destination
  if (options.functionModule) filters.ARFCFNAM = options.functionModule
  if (options.state) filters.ARFCSTATE = options.state
  if (options.user) filters.ARFCUSER = options.user

  const rows = await readTable({
    table: TABLE,
    fields: STATE_FIELDS,
    filters,
    maximum,
    filterLengthLimit: TRFC_ERROR_FILTER_LIMIT,
    codePrefix: "TRFC_ERROR_",
    mapError: trfcFailure
  })

  const entries = (rows ?? []).map((row) => ({
    destination: row.ARFCDEST!,
    transactionId: transactionId(row),
    luwCount: row.ARFCLUWCNT!,
    state: row.ARFCSTATE!,
    functionModule: row.ARFCFNAM!,
    expectedReturn: row.ARFCRETURN!,
    date: row.ARFCDATUM!,
    time: row.ARFCUZEIT!,
    user: row.ARFCUSER!,
    retryCount: row.ARFCRETRYS!,
    transactionCode: row.ARFCTCODE!,
    remoteHost: row.ARFCRHOST!,
    message: row.ARFCMSG!
  }))

  const source = sources[0]
  const status =
    source === undefined || source.status === "unavailable" || source.status === "invalid"
      ? "unavailable"
      : source.status === "truncated"
        ? "partial"
        : "ok"
  return {
    status,
    connectionId,
    readOnly: true,
    filters: {
      destination: options.destination ?? null,
      functionModule: options.functionModule ?? null,
      state: options.state ?? null,
      user: options.user ?? null
    },
    rowLimit: maximum,
    rowLimitRequested: requested,
    rowLimitApplied: requested > ALLOWLIST_MAX_ROWS,
    filterValueLimit: TRFC_ERROR_FILTER_LIMIT,
    entries,
    count: entries.length,
    truncated: source?.status === "truncated",
    notes: [
      "state is the code stored in ARFCSSTATE and is reported verbatim, never translated; the DDIC " +
        "description of the field names the values it can hold (RECORDED, CPICERR, MAILED, READ, " +
        "...) and the domain texts are in DD07L, which read_abap_table can already reach.",
      "transactionId is the composite of ARFCIPID, ARFCPID, ARFCTIME and ARFCTIDCNT; the fields are " +
        "published separately as well, so one entry can be addressed exactly.",
      "retryCount is the table's own counter, reported as stored; this tool does not retry or " +
        "release a tRFC LUW and has no write path at all.",
      "the tRFC payload (ARFCSDATA: ARFCBLCNT plus ARFCDATA01..07, RAW) is not published: it has no " +
        "character column and its row exceeds the 512-character limit the legacy read path accepts, " +
        "so ARFCSDATA is deliberately not in the read allowlist.",
      "filters are exact and case-sensitive and are combined with AND; a value longer than 32 " +
        "characters is refused with TRFC_ERROR_SCOPE_INVALID before SAP is touched."
    ],
    sources,
    queryTimestamp: new Date().toISOString(),
    queryWarnings
  }
}
