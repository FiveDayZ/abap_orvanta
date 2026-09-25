import { z } from "zod"
import type { SapBackend } from "./backend.js"

/**
 * The guarded table reader shared by the system-information tools.
 *
 * Every system-information read has the same shape: try the native data preview, and when the
 * platform answers it with the empty HTML document this release serves (w200 does, for every table),
 * fall back to the reviewed `RFC_READ_TABLE` implementation only. The fallback is gated on the
 * reader's own interface fingerprint, so a changed or unreviewed reader is refused rather than used,
 * and there is no generic SQL fallback.
 *
 * The reader owns provenance: the caller passes a source record in and the reader fills it in, so a
 * failed table is reported as a status with a code instead of aborting the whole tool.
 */

export type ReviewedReaderStatus = "ok" | "empty" | "unavailable" | "truncated" | "invalid"

export type ReviewedReaderSource = {
  table: string
  status: ReviewedReaderStatus
  method: "adt_query" | "rfc_read_table"
  returnedCount: number
  code?: string
  nativeCode?: string
}

/** The exact empty-HTML data-preview failure. Only this failure permits the reviewed fallback. */
export const NATIVE_PREVIEW_EMPTY_HTML =
  "SAP_DATA_QUERY_RESPONSE_INVALID: expected XML data preview; HTTP 200; mediaType=text/html; " +
  "root=unparsed; bytes=0. No empty result was inferred."

/** One row of a table read: field name to trimmed text. */
export type ReviewedRow = Record<string, string>

export type ReviewedReadOptions = {
  table: string
  fields: readonly string[]
  filters: ReviewedRow
  maximum: number
  /** Prefix for the reader's own validation codes, so each tool keeps its documented vocabulary. */
  codePrefix: string
  /** Longest accepted filter value; the reader refuses longer input instead of sending it. */
  filterLengthLimit?: number
  /** Maps any thrown error to the tool's own stable code. */
  mapError: (error: unknown) => string
  /** Extra per-row validation after the generic field checks. */
  validate?: (rows: ReviewedRow[]) => void
}

export const reviewedTableReaderDefinition = z.object({
  functionName: z.literal("RFC_READ_TABLE"),
  remoteEnabled: z.literal(true),
  updateTask: z.literal(false),
  sourceFingerprint: z.literal("7b9a603493673d26f75e555616b24d150e407ce03eff57e9c68f0b30b1ba0c2d"),
  interfaceFingerprint: z.literal(
    "d06cc5c1ce05960bde526ecf27e38606134146474cc8da19f93ac2abd3e48074"
  )
})

export function createReviewedTableReader(
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  connectionId: string,
  readDefinition: () => Promise<unknown>,
  sources: ReviewedReaderSource[],
  warnings: string[]
) {
  let reviewed: Promise<unknown> | undefined
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`

  return async (options: ReviewedReadOptions): Promise<ReviewedRow[] | null> => {
    const { table, fields, filters, maximum, mapError, codePrefix } = options
    const fail = (suffix: string) => new Error(`${codePrefix}${suffix}`)
    const filterLengthLimit = options.filterLengthLimit ?? 30
    const source: ReviewedReaderSource = {
      table,
      status: "unavailable",
      method: "adt_query",
      returnedCount: 0
    }
    sources.push(source)
    try {
      const conditions = Object.entries(filters).map(([name, value]) => {
        if (!fields.includes(name) || value.length > filterLengthLimit) throw fail("SCOPE_INVALID")
        const condition = `${name} = ${literal(value)}`
        if (condition.length > 68) throw fail("SCOPE_INVALID")
        return condition
      })
      let rows: Record<string, unknown>[]
      try {
        rows = await backend.runQuery(
          connectionId,
          `SELECT ${fields.join(", ")} FROM ${table}${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""}`,
          maximum + 1
        )
      } catch (error) {
        if (!(error instanceof Error) || error.message !== NATIVE_PREVIEW_EMPTY_HTML) throw error
        source.nativeCode = "SAP_DATA_QUERY_RESPONSE_INVALID"
        source.method = "rfc_read_table"
        // Only the reviewed legacy read implementation is allowed; no generic SQL fallback.
        reviewed ??= readDefinition().then((definition) => {
          if (!reviewedTableReaderDefinition.safeParse(definition).success)
            throw fail("FALLBACK_UNVERIFIED")
        })
        await reviewed
        const result = await backend.callRemoteFunction(connectionId, {
          functionName: "RFC_READ_TABLE",
          inputParameters: {
            QUERY_TABLE: table,
            DELIMITER: "|",
            NO_DATA: "",
            ROWSKIPS: "0",
            ROWCOUNT: String(maximum + 1),
            OPTIONS: conditions.map((condition, index) => ({
              TEXT: `${index ? "AND " : ""}${condition}`
            })),
            FIELDS: fields.map((FIELDNAME) => ({ FIELDNAME })),
            DATA: []
          },
          outputParameters: [
            { name: "FIELDS", kind: "table", fields: ["FIELDNAME"] },
            { name: "DATA", kind: "table", fields: ["WA"] }
          ]
        })
        if (result.fault) {
          throw new Error(result.fault.name === "NOT_AUTHORIZED" ? "NOT_AUTHORIZED" : "RFC_FAILED")
        }
        const metadata = result.outputs.FIELDS
        const data = result.outputs.DATA
        if (
          !Array.isArray(metadata) ||
          !Array.isArray(data) ||
          metadata.length !== fields.length ||
          metadata.some((field, index) => field.FIELDNAME !== fields[index]) ||
          data.length > maximum + 1
        )
          throw fail("RESPONSE_INVALID")
        rows = data.map((row) => {
          if (typeof row.WA !== "string" || row.WA.length > 512) throw fail("RESPONSE_INVALID")
          const values = row.WA.split("|")
          if (values.length !== fields.length) throw fail("RESPONSE_INVALID")
          return Object.fromEntries(fields.map((field, index) => [field, values[index]!.trim()]))
        })
      }
      if (!Array.isArray(rows) || rows.length > maximum + 1) throw fail("RESPONSE_INVALID")
      const schema = z.object(
        Object.fromEntries(fields.map((field) => [field, z.string().max(512)]))
      )
      const parsed = rows.map((row) => {
        const value = schema.safeParse(row)
        if (!value.success) throw fail("RESPONSE_INVALID")
        const record = Object.fromEntries(
          Object.entries(value.data).map(([key, cell]) => [key, cell.trim()])
        )
        if (Object.entries(filters).some(([key, expected]) => record[key] !== expected))
          throw fail("RESPONSE_SCOPE_MISMATCH")
        return record
      })
      if (maximum === 1 && parsed.length > 1) throw fail("AMBIGUOUS_RESULT")
      options.validate?.(parsed)
      source.returnedCount = Math.min(parsed.length, maximum)
      source.status = parsed.length > maximum ? "truncated" : parsed.length ? "ok" : "empty"
      if (source.status !== "ok") warnings.push(`${table}: ${source.status}`)
      return parsed.slice(0, maximum)
    } catch (error) {
      source.code = mapError(error)
      warnings.push(`${table}: ${source.code}`)
      return null
    }
  }
}
