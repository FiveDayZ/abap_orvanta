/**
 * Authorization trace, read service-side.
 *
 * Two halves, both reached over the same SOAP-RFC path `get_sap_system_info` uses for
 * `RFC_SYSTEM_INFO` - no in-SAP helper is involved in either.
 *
 * The SWITCH. `AUTH_TRACE_GET_STATUS` (function group `SAUTHTRACE`) is remote-enabled on this release
 * and its whole interface is one `BOOLE` export with no imports, no table parameters and no declared
 * exceptions. The polarity of `RC` is the whole contract, and the function's own body admits two
 * opposite readings: the old-kernel branch maps `auth/authorization_trace = 'Y'` to `RC = 'X'` (trace
 * on), while the new-kernel branch maps a failing `AUTH_TRACE ACTION='INFO'` call to the same
 * `'X'`. It was settled by reading the callers, not by picking the likelier story - `AUTH_TRACE_RESET`
 * and `AUTH_TRACE_INTERN_GET_NAME` both do `IF lv_rc <> 'X'. EXIT. ENDIF.` under the comment "If the
 * trace is not active, we do not need to do anything", so `'X'` means the trace IS active. Evidence:
 * `.doc/n3-auth-trace-status-contract-forensics-20260927.md` section 3.5.
 *
 * The ROWS. The trace results live in `USOB_AUTHVALTRC` ("Authorization Trace Result: Objects and
 * Values", TRANSP, package `S_PROFGEN`), which this service may not read as a table: it is not in the
 * D5-2 allowlist, and the allowlist is default-deny rather than a recommendation. SAP's own
 * `SAUTHTRACE` pair is used instead, and both modules are remote-enabled with a shape the service can
 * actually carry:
 *
 *   - `AUTH_TRACE_GET_AUTHVAL_KEY` takes no input and exports `P_AUTHVALTRC_KEY`
 *     (`USOB_AUTHVALTRC_KEY_T`) - the distinct NAME/TYPE pairs, CHAR only. Its body is
 *     `select name type from usob_authvaltrc into corresponding fields of table p_authvaltrc_key
 *     group by name type`.
 *   - `AUTH_TRACE_GET_AUTHVAL_DATA` imports `P_AUTHVALTRC_KEY` (`USOB_AUTHVALTRC_KEY_T`) and exports
 *     `P_AUTHVALTRC_DATA` (`USOB_AUTHVALTRC_T`, row type `USOB_AUTHVALTRC`) plus `P_DBCNT`. Its body
 *     is `select * from usob_authvaltrc into table p_authvaltrc_data for all entries in
 *     p_authvaltrc_key where name = p_authvaltrc_key-name and type = p_authvaltrc_key-type`.
 *
 * The keys are always read first, and the data read is skipped when that list is empty. This is not
 * politeness: `FOR ALL ENTRIES` over an EMPTY driver table drops the whole `WHERE` and selects the
 * entire table, so calling the data module with no keys would silently turn a targeted read into an
 * unbounded one.
 *
 * The data read is paged. The callee returns `select *` and has no row or column bound of its own, so
 * one call over every key of w200 produced a reply this service refuses (`SAP SOAP response exceeded
 * 10 MiB`, read from the live system on 2026-09-30). Keys are therefore handed over in pages of
 * `AUTH_TRACE_DATA_PAGE`, a page the transport refuses is halved and retried down to one key, and the
 * rows are accumulated across the pages that answered. A key whose single-key page still fails is
 * counted in `failedKeys`, and the read is reported as `partial` rather than as a complete answer.
 *
 * `FIELDSUSED` is `XUBITVEC16`, RAW(2) - a plain fixed-length type, not an unverifiable one; what is
 * unverifiable is its MEANING. Which of the sixteen bits marks which of the ten FIELD slots as
 * checked is applied on a path this service cannot read (the `SAUTHTRACE` group itself contains no
 * decoder: its only two readers select the row and pass it on, and the group's generated `%_RFC`
 * wrappers declare the parameters without touching them). The vector is therefore returned verbatim,
 * exactly as the transport delivered it, and is deliberately NOT interpreted into a field list. The
 * checked values themselves are in `FIELD1..FIELD9` and `FIELD0` and are returned as stored.
 *
 * Nothing here starts, stops, clears or activates a trace, and nothing here is an authorization
 * decision about any user: the rows are what the kernel recorded, transcribed.
 */
import { z } from "zod"
import type { SapBackend } from "./backend.js"

/**
 * The interfaces this module depends on, read from w200 on 2026-09-27 (status) and 2026-09-30 (the
 * key/data pair) and pinned, because a function module can be replaced under a running service: a
 * reader that only checked the name would keep answering from a body that no longer means that.
 */
export const reviewedAuthTraceStatusDefinition = z.object({
  functionName: z.literal("AUTH_TRACE_GET_STATUS"),
  remoteEnabled: z.literal(true),
  updateTask: z.literal(false),
  sourceFingerprint: z.literal("935db5a6ecdef645047308de0702b7adce1fcc52cff50401508651a187dce652"),
  interfaceFingerprint: z.literal(
    "d603edfe08b0a65b1d23c94b8a9bdc2704c7bd6cdab0d55995ae8ed425990965"
  )
})

export const reviewedAuthTraceKeyDefinition = z.object({
  functionName: z.literal("AUTH_TRACE_GET_AUTHVAL_KEY"),
  remoteEnabled: z.literal(true),
  updateTask: z.literal(false),
  sourceFingerprint: z.literal("74b8e04b500939e7db468a223df9aa3d98ac16650a8c6ea05000c997dbc6392c"),
  interfaceFingerprint: z.literal(
    "a161259ac6c983af19292556b3f0692e7c1adfe08fe0982671e97a7493b72fb2"
  )
})

export const reviewedAuthTraceDataDefinition = z.object({
  functionName: z.literal("AUTH_TRACE_GET_AUTHVAL_DATA"),
  remoteEnabled: z.literal(true),
  updateTask: z.literal(false),
  sourceFingerprint: z.literal("2ea7593f3ae6867782d2fe8926ff16d5b8dcf948d1ab270302ca1edd102aba1e"),
  interfaceFingerprint: z.literal(
    "76c7cc1ff6817726d3a24f144721353c932656b7530d2cd273078ce1edfd1113"
  )
})

/** The two CHAR key fields the callee's own `WHERE` actually filters on (`OBJECT`/`HASH` are not). */
const AUTH_TRACE_KEY_FIELDS = ["NAME", "TYPE"] as const

/**
 * The projection of `USOB_AUTHVALTRC` this module asks for, in the table's own column order. `MANDT`
 * and the row's own modification stamps (`MODDATE`/`MODTIME`/`MODIFIER`) are not projected: the first
 * is the client every other reader in this service already fixes, and the last three record when the
 * trace table row was last written rather than anything about the check that was traced.
 */
export const AUTH_TRACE_ROW_FIELDS = [
  "NAME",
  "TYPE",
  "OBJECT",
  "HASH",
  "ABAPPROG",
  "ABAPLINE",
  "FIELDSUSED",
  "FIELD1",
  "FIELD2",
  "FIELD3",
  "FIELD4",
  "FIELD5",
  "FIELD6",
  "FIELD7",
  "FIELD8",
  "FIELD9",
  "FIELD0"
] as const

/** A row cell is transport text; the widest real cell is `XUVAL` at 40 characters. */
const remoteCell = z.string().max(512)

/**
 * Distinct `(NAME, TYPE)` pairs handed to the data read in one call. The callee's `FOR ALL ENTRIES`
 * turns each key into one more `OR` term on the database, and the whole table is the ceiling, so this
 * bound is what keeps a troubleshooting read from becoming a bulk export. Truncation is reported.
 */
export const AUTH_TRACE_KEY_LIMIT = 200

/**
 * Keys handed to the data read in one call, before any splitting.
 *
 * The callee has no row bound of its own: `select * ... for all entries` brings back every column of
 * every matching row, and this service refuses a SOAP reply above 10 MiB. Handing over all 170 keys
 * of w200 did exactly that on the first live call - `SAP SOAP response exceeded 10 MiB` - so the keys
 * are handed over in pages and the rows are accumulated across them. The page is a starting size, not
 * a limit: a page whose reply the transport refuses is split in half and retried, down to one key, so
 * the read converges on what this table's density actually allows instead of depending on a constant
 * that would have to be re-tuned for every system.
 */
export const AUTH_TRACE_DATA_PAGE = 32

/** How far a page may be halved: 32, 16, 8, 4, 2, 1. */
const AUTH_TRACE_SPLIT_DEPTH = 5

export type AuthTraceStatusSource = {
  table: "AUTH_TRACE_GET_STATUS"
  status: "ok" | "unavailable" | "invalid"
  method: "rfc_call"
  returnedCount: number
  code?: string
}

export type AuthTraceRowSource = {
  table: "USOB_AUTHVALTRC"
  function: "AUTH_TRACE_GET_AUTHVAL_DATA"
  keyFunction: "AUTH_TRACE_GET_AUTHVAL_KEY"
  /**
   * `partial` is its own state: rows came back, but at least one key's page could not be read, so the
   * rows are not the whole answer. Reporting that as `ok` would present a subset as the result.
   */
  status: "ok" | "empty" | "partial" | "unavailable" | "invalid"
  method: "rfc_call"
  keysAvailable: number
  keysSelected: number
  /** Keys that were actually handed to a data call that answered. Keys in a failed page are not. */
  keysUsed: number
  /** True when some selected key was never read, whether by the key ceiling or by the row bound. */
  keysTruncated: boolean
  returnedCount: number
  /** Rows SAP counted across the pages that answered; null when no page reported a count. */
  sapCount: number | null
  /** Data calls that answered, after any splits. */
  pages: number
  /** Keys whose page failed even at one key: their rows are missing from this answer. */
  failedKeys: number
  code?: string
  /**
   * The transport's own one-line message when a failure collapsed into `_CALL_FAILED`, present only
   * then. This module's own codes carry no message because the code already says everything.
   */
  failureMessage?: string | null
}

export type AuthTraceRow = Record<(typeof AUTH_TRACE_ROW_FIELDS)[number], string>

/**
 * Read whether the kernel's authorization trace is switched on.
 *
 * `readDefinition` is injected so this module stays testable without a live connection and so the
 * caller decides how the interface metadata is fetched (`read_function_module_interface`), exactly
 * as `collectServerFacts` does for `RFC_SYSTEM_INFO`.
 */
export async function collectAuthTraceStatus(
  backend: Pick<SapBackend, "callRemoteFunction">,
  connectionId: string,
  readDefinition: () => Promise<unknown>
) {
  const source: AuthTraceStatusSource = {
    table: "AUTH_TRACE_GET_STATUS",
    status: "unavailable",
    method: "rfc_call",
    returnedCount: 0
  }
  const queryWarnings: string[] = []
  const notes = [
    "Value is the kernel's own authorization-trace switch (AUTH_TRACE_GET_STATUS.RC). It does not " +
      "resolve a user's authorizations, and it is not an authorization decision about anyone.",
    "The flag is a snapshot of the moment. Nothing here starts, stops, clears or activates a trace."
  ]

  let traceActive: boolean | null = null
  try {
    if (!reviewedAuthTraceStatusDefinition.safeParse(await readDefinition()).success)
      throw new Error("AUTH_TRACE_STATUS_FUNCTION_UNVERIFIED")
    const result = await backend.callRemoteFunction(connectionId, {
      functionName: "AUTH_TRACE_GET_STATUS",
      inputParameters: {},
      outputParameters: [{ name: "RC", kind: "scalar" }]
    })
    if (result.fault) {
      throw new Error(
        result.fault.name === "NOT_AUTHORIZED"
          ? "AUTH_TRACE_STATUS_NOT_AUTHORIZED"
          : "AUTH_TRACE_STATUS_RFC_FAILED"
      )
    }
    const raw = result.outputs.RC
    if (raw === undefined || raw === null) throw new Error("AUTH_TRACE_STATUS_RESPONSE_INVALID")
    // BOOLE is CHAR 1: 'X' is on (see the header), anything else is off. Any value that is neither
    // is reported as an invalid reply rather than being coerced to false, so an unexpected payload
    // stays visible instead of silently reading as "trace off".
    const text = String(raw).trim().toUpperCase()
    if (text !== "X" && text !== "") throw new Error("AUTH_TRACE_STATUS_RESPONSE_INVALID")
    traceActive = text === "X"
    source.status = "ok"
    source.returnedCount = 1
  } catch (error) {
    source.code = authTraceFailure(error, "STATUS")
    if (source.code === "AUTH_TRACE_STATUS_RESPONSE_INVALID") source.status = "invalid"
    queryWarnings.push(`AUTH_TRACE_GET_STATUS: ${source.code}`)
  }

  return {
    status: traceActive === null ? ("unavailable" as const) : ("ok" as const),
    connectionId,
    readOnly: true as const,
    traceActive,
    traceSwitchSource: traceActive === null ? null : "AUTH_TRACE_GET_STATUS.RC",
    source,
    notes,
    queryTimestamp: new Date().toISOString(),
    queryWarnings
  }
}

/**
 * Read the trace-result rows behind `USOB_AUTHVALTRC`, through SAP's own key/data pair.
 *
 * `authorizationObject` narrows the read to one `NAME` before the keys are handed back to SAP. The
 * comparison is exact and case-sensitive, like every other filter in this family: SAP stores the
 * object name upper-cased, and a filter this module normalised would hide a caller's typo instead of
 * answering "no trace row for that name".
 */
export async function collectAuthTraceRows(
  backend: Pick<SapBackend, "callRemoteFunction">,
  connectionId: string,
  readDefinition: (functionName: string) => Promise<unknown>,
  options: { authorizationObject?: string | undefined; maxRows: number }
) {
  const source: AuthTraceRowSource = {
    table: "USOB_AUTHVALTRC",
    function: "AUTH_TRACE_GET_AUTHVAL_DATA",
    keyFunction: "AUTH_TRACE_GET_AUTHVAL_KEY",
    status: "empty",
    method: "rfc_call",
    keysAvailable: 0,
    keysSelected: 0,
    keysUsed: 0,
    keysTruncated: false,
    returnedCount: 0,
    sapCount: null,
    pages: 0,
    failedKeys: 0
  }
  const queryWarnings: string[] = []
  const notes = [
    "The rows are SAP's own trace results from USOB_AUTHVALTRC, read through AUTH_TRACE_GET_AUTHVAL_KEY " +
      "and AUTH_TRACE_GET_AUTHVAL_DATA. The table itself is outside this service's table allowlist; " +
      "these two remote-enabled readers are used instead of reading it directly.",
    "FIELDSUSED is returned verbatim as the transport delivered it, in the encoding SAP's SOAP-RFC " +
      "layer used. This service does not decode which bit maps to which FIELD slot: that mapping is " +
      "applied on a path it cannot read, and no decoder exists in the SAUTHTRACE function group, whose " +
      "only two readers select the row and pass it on. The checked values are in FIELD1..FIELD9 and " +
      "FIELD0 and are returned as stored.",
    "A trace row is a record of an authorization check the kernel observed, not a verdict: nothing " +
      "here states that a user is or is not authorized."
  ]
  let rows: AuthTraceRow[] = []
  // Which half the failure belongs to is tracked here rather than derived from the error text, so a
  // transport error in the key read cannot be reported as a data-read failure.
  let stage: "KEY" | "DATA" = "KEY"

  try {
    if (
      !reviewedAuthTraceKeyDefinition.safeParse(await readDefinition("AUTH_TRACE_GET_AUTHVAL_KEY"))
        .success
    )
      throw new Error("AUTH_TRACE_KEY_FUNCTION_UNVERIFIED")
    const keyResult = await backend.callRemoteFunction(connectionId, {
      functionName: "AUTH_TRACE_GET_AUTHVAL_KEY",
      inputParameters: {},
      outputParameters: [
        { name: "P_AUTHVALTRC_KEY", kind: "table", fields: [...AUTH_TRACE_KEY_FIELDS] }
      ]
    })
    if (keyResult.fault) throw new Error(keyFault(keyResult.fault.name))
    const keyOutput = keyResult.outputs.P_AUTHVALTRC_KEY
    if (!Array.isArray(keyOutput)) throw new Error("AUTH_TRACE_KEY_RESPONSE_INVALID")
    const keySchema = z.object({ NAME: remoteCell, TYPE: remoteCell })
    const keys: Array<{ NAME: string; TYPE: string }> = []
    for (const raw of keyOutput) {
      const parsed = keySchema.safeParse(raw)
      if (!parsed.success) throw new Error("AUTH_TRACE_KEY_RESPONSE_INVALID")
      keys.push({ NAME: parsed.data.NAME.trim(), TYPE: parsed.data.TYPE.trim() })
    }
    source.keysAvailable = keys.length
    const selected = options.authorizationObject
      ? keys.filter((key) => key.NAME === options.authorizationObject)
      : keys
    source.keysSelected = selected.length
    const used = selected.slice(0, AUTH_TRACE_KEY_LIMIT)

    // See the header: an empty driver table drops the callee's own WHERE, so a targeted read would
    // become the whole table. The data read is therefore never issued without at least one key.
    if (used.length === 0) {
      source.status = "empty"
    } else {
      stage = "DATA"
      if (
        !reviewedAuthTraceDataDefinition.safeParse(
          await readDefinition("AUTH_TRACE_GET_AUTHVAL_DATA")
        ).success
      )
        throw new Error("AUTH_TRACE_DATA_FUNCTION_UNVERIFIED")
      const rowSchema = z.object(
        Object.fromEntries(AUTH_TRACE_ROW_FIELDS.map((field) => [field, remoteCell]))
      )
      const failures: string[] = []

      // One page of keys. Splitting happens here, not in the caller: the only reason a page fails is
      // that its reply is too big for the transport, and halving is what turns that one failure into
      // two answerable reads. A fault, a malformed reply or an unverified interface names something
      // the key count cannot change, so those are recorded against the page instead of being split.
      const readPage = async (page: Array<{ NAME: string; TYPE: string }>, depth: number) => {
        if (rows.length >= options.maxRows) return
        try {
          const dataResult = await backend.callRemoteFunction(connectionId, {
            functionName: "AUTH_TRACE_GET_AUTHVAL_DATA",
            inputParameters: { P_AUTHVALTRC_KEY: page.map((key) => ({ ...key })) },
            outputParameters: [
              { name: "P_AUTHVALTRC_DATA", kind: "table", fields: [...AUTH_TRACE_ROW_FIELDS] },
              { name: "P_DBCNT", kind: "scalar" }
            ]
          })
          if (dataResult.fault) throw new Error(dataFault(dataResult.fault.name))
          const dataOutput = dataResult.outputs.P_AUTHVALTRC_DATA
          if (!Array.isArray(dataOutput)) throw new Error("AUTH_TRACE_DATA_RESPONSE_INVALID")
          const pageRows = dataOutput.map((raw) => {
            const parsed = rowSchema.safeParse(raw)
            if (!parsed.success) throw new Error("AUTH_TRACE_DATA_RESPONSE_INVALID")
            return parsed.data as AuthTraceRow
          })
          rows = rows.concat(pageRows)
          source.pages += 1
          // Only keys of an answering page count as read: the summary says "N row(s) from M key(s)",
          // and a key whose page failed contributed none of them.
          source.keysUsed += page.length
          const sapCount = dataResult.outputs.P_DBCNT
          if (typeof sapCount === "string" && /^\d+$/.test(sapCount.trim())) {
            const counted = Number.parseInt(sapCount.trim(), 10)
            source.sapCount = (source.sapCount ?? 0) + counted
          }
        } catch (error) {
          const code = authTraceFailure(error, "DATA")
          if (
            page.length > 1 &&
            depth < AUTH_TRACE_SPLIT_DEPTH &&
            code === "AUTH_TRACE_DATA_CALL_FAILED"
          ) {
            const half = Math.ceil(page.length / 2)
            await readPage(page.slice(0, half), depth + 1)
            await readPage(page.slice(half), depth + 1)
            return
          }
          source.failedKeys += page.length
          // The FIRST failure names the cause: later pages usually fail for the same reason, and a
          // code overwritten by a later page would describe the symptom rather than the cause.
          if (source.code === undefined) {
            source.code = code
            // The root-cause message is kept, bounded and single-line. Without it every transport
            // failure on this half collapses into one code - which is exactly what a first live call
            // of this read produced ("SAP SOAP response exceeded 10 MiB"), and a refusal whose cause
            // cannot be read cannot be acted on. It is the transport's own message, never a
            // credential and never a value from the table.
            source.failureMessage = authTraceFailureMessage(error)
          }
          const detail = authTraceFailureMessage(error)
          failures.push(`${code}${detail ? `: ${detail}` : ""}`)
        }
      }

      let consumed = 0
      while (consumed < used.length && rows.length < options.maxRows) {
        const page = used.slice(consumed, consumed + AUTH_TRACE_DATA_PAGE)
        consumed += page.length
        await readPage(page, 0)
      }
      source.keysTruncated = source.keysUsed < selected.length
      source.returnedCount = rows.length
      // Three states, in this order: every page answered; some answered and some did not, so the rows
      // are real but incomplete; or nothing answered at all, and only then does the kind of failure
      // decide between "the reply was malformed" and "the read could not be made".
      if (source.failedKeys === 0) source.status = rows.length === 0 ? "empty" : "ok"
      else if (source.pages > 0) source.status = "partial"
      else if (source.code?.endsWith("_RESPONSE_INVALID")) source.status = "invalid"
      else source.status = "unavailable"
      if (failures.length) queryWarnings.push(`AUTH_TRACE_GET_AUTHVAL_DATA: ${failures.join("; ")}`)
    }
  } catch (error) {
    source.code = authTraceFailure(error, stage)
    if (source.code.endsWith("_RESPONSE_INVALID")) source.status = "invalid"
    else source.status = "unavailable"
    rows = []
    // The root-cause message is kept, bounded and single-line. Without it every transport failure on
    // this half collapses into one code - which is exactly what a first live call of this read
    // produced, and a refusal whose cause cannot be read cannot be acted on. It is the transport's
    // own message (a SOAP faultstring or the decoder that refused the reply), never a credential and
    // never a value from the table.
    source.failureMessage = authTraceFailureMessage(error)
    queryWarnings.push(
      `${
        stage === "KEY" ? "AUTH_TRACE_GET_AUTHVAL_KEY" : "AUTH_TRACE_GET_AUTHVAL_DATA"
      }: ${source.code}${source.failureMessage ? `: ${source.failureMessage}` : ""}`
    )
  }

  const traceRowsTruncated = rows.length > options.maxRows
  // The top-level status is the switch half's: a row read that came back `partial` still answered,
  // and its own state says so. Only a row half that produced nothing at all makes this service's
  // answer unavailable.
  const rowHalfMissing = source.status === "unavailable" || source.status === "invalid"
  return {
    status: rowHalfMissing ? ("unavailable" as const) : ("ok" as const),
    connectionId,
    readOnly: true as const,
    authorizationObjectFilter: options.authorizationObject ?? null,
    traceRows: rows.slice(0, options.maxRows),
    traceRowsTruncated,
    traceRowSource: source,
    notes,
    queryTimestamp: new Date().toISOString(),
    queryWarnings
  }
}

/** `NOT_AUTHORIZED` keeps its own code; every other fault is the generic transport failure. */
function keyFault(name: string): string {
  return name.trim().toUpperCase() === "NOT_AUTHORIZED"
    ? "AUTH_TRACE_KEY_NOT_AUTHORIZED"
    : "AUTH_TRACE_KEY_RFC_FAILED"
}

function dataFault(name: string): string {
  return name.trim().toUpperCase() === "NOT_AUTHORIZED"
    ? "AUTH_TRACE_DATA_NOT_AUTHORIZED"
    : "AUTH_TRACE_DATA_RFC_FAILED"
}

function authTraceFailure(error: unknown, scope: "STATUS" | "KEY" | "DATA"): string {
  const message = error instanceof Error ? error.message : String(error)
  const known = [
    `AUTH_TRACE_${scope}_FUNCTION_UNVERIFIED`,
    `AUTH_TRACE_${scope}_NOT_AUTHORIZED`,
    `AUTH_TRACE_${scope}_RFC_FAILED`,
    `AUTH_TRACE_${scope}_RESPONSE_INVALID`
  ]
  return known.includes(message) ? message : `AUTH_TRACE_${scope}_CALL_FAILED`
}

/** A one-line, bounded rendering of the failure, or null when it is one of this module's own codes. */
function authTraceFailureMessage(error: unknown): string | null {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim()
  if (message === "" || /^AUTH_TRACE_(STATUS|KEY|DATA)_[A-Z_]+$/.test(message)) return null
  return message.length > 400 ? `${message.slice(0, 400)}...` : message
}
