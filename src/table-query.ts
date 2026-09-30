import { z } from "zod"
import { createHash } from "node:crypto"
import type { RemoteFunctionRequest, SapBackend } from "./backend.js"
import { reviewedTableReaderDefinition } from "./system-info.js"
import { assertTableAllowed } from "./table-allowlist.js"
// The decimal arithmetic the expression layer and the SUM aggregate share. Defined once, in the
// expression module, so a scale rule cannot drift between the two places that render a number.
import {
  arithmeticColumns,
  compareDecimals,
  evaluateArithmetic,
  formatScaled,
  numericParts,
  parseArithmetic,
  type ArithmeticNode,
  type OperandType
} from "./table-expression.js"

const identifier = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]{0,29}$/)
const dictionaryField = z
  .string()
  .max(30)
  .regex(/^(?:[A-Z][A-Z0-9_]*|\/[A-Z0-9_]+\/[A-Z][A-Z0-9_]*)$/)
const includeMarkers = [".INCLUDE", ".INCLU--AP"] as const
const reviewedAlignedReader = z.object({
  functionName: z.literal("BBP_RFC_READ_TABLE"),
  remoteEnabled: z.literal(true),
  updateTask: z.literal(false),
  sourceFingerprint: z.literal("e08069939315d594527fe58fc1a52e32e583d0987bc173295ddb816be9051b94"),
  interfaceFingerprint: z.literal(
    "d85d035301f09d00229fa830e7c4cd7c63c8a167055d53bb62ddebb44d17743a"
  )
})
export const tableQuerySchema = z
  .object({
    connectionId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    tableName: identifier,
    columns: z
      .array(z.union([identifier, z.literal("*")]))
      .min(1)
      .max(1024),
    filters: z
      .array(
        z
          .object({
            column: identifier,
            operator: z.enum(["EQ", "NE", "LT", "LE", "GT", "GE"]),
            value: z
              .string()
              .max(40)
              .refine((value) => !/[\u0000-\u001f\u007f]/.test(value))
          })
          .strict()
      )
      .max(8)
      .default([]),
    maxRows: z.number().int().min(1).max(500).default(100)
  })
  .strict()

const tableDefinition = z.object({
  objectKind: z.literal("transparentTable"),
  objectName: identifier,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  definition: z.object({
    tableClass: z.literal("TRANSP"),
    fields: z
      .array(
        z.object({
          name: z.union([dictionaryField, z.enum(includeMarkers)]),
          key: z.boolean().optional()
        })
      )
      .min(1)
      .max(1026)
  })
})
const metadataSchema = z
  .array(
    z.object({
      FIELDNAME: dictionaryField,
      TYPE: z.string().length(1),
      LENGTH: z.string().regex(/^\d{1,6}$/),
      OFFSET: z.string().regex(/^\d{1,6}$/)
    })
  )
  .min(1)
  .max(1024)
type Metadata = z.infer<typeof metadataSchema>
const operators = { EQ: "=", NE: "<>", LT: "<", LE: "<=", GT: ">", GE: ">=" } as const
/** A stable failure code plus the evidence the caller needs to correct the request in one step. */
class TableQueryFailure extends Error {
  constructor(
    readonly code: string,
    readonly detail: Record<string, unknown> = {}
  ) {
    super(code)
  }
}
/** Upper bound on the projection sample returned with a failure; DDIC tables can exceed 1000 columns. */
const validColumnSampleLimit = 64
/**
 * The evidence a refusal may carry beside its code, in the order a message should state it.
 *
 * A refusal reaches the caller two ways: `read_abap_table` returns the whole result object, and
 * `execute_data_query` throws a one-line `SAP_TABLE_QUERY_FAILED: <code>; stage=<stage>`. The second
 * path used to drop everything but the code - which made the evidence invisible exactly where it was
 * needed, on the statement the caller actually wrote. This list is the one place that decides what
 * survives that path, so adding a detail to `TableQueryFailure` means adding it here too.
 */
export const tableQueryEvidenceKeys = [
  "invalidColumns",
  "validColumns",
  "validColumnCount",
  "definitionFieldCount",
  "overflowColumn",
  "overflowRawValue",
  "overflowRowIndex",
  "overflowRowKey"
] as const

/**
 * Render that evidence as a `; key=value` suffix, or an empty string when the refusal carried none.
 * Values are JSON-encoded so a field's raw text arrives quoted and escaped rather than merged into
 * the message, and the encoding is bounded by the same limits that produced the value (a column name,
 * a 512-character record buffer, a row index, a key object).
 */
export function tableQueryEvidence(result: Record<string, unknown>): string {
  const parts: string[] = []
  for (const key of tableQueryEvidenceKeys) {
    const value = result[key]
    if (value === undefined) continue
    parts.push(`${key}=${JSON.stringify(value)}`)
  }
  return parts.join("; ")
}
/**
 * The one native failure that licenses the degraded path: ADT answered the data preview with HTTP
 * 200 and a zero-byte HTML body, which is this release's way of saying the endpoint is not served.
 * Exported so the caller and the reader compare against the same string instead of a second copy.
 */
export const nativeEmptyHtml =
  "SAP_DATA_QUERY_RESPONSE_INVALID: expected XML data preview; HTTP 200; mediaType=text/html; root=unparsed; bytes=0. No empty result was inferred."

export async function readAbapTable(
  raw: unknown,
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  readTable: (connectionId: string, tableName: string) => Promise<unknown>,
  readReader: (
    connectionId: string,
    functionName: "RFC_READ_TABLE" | "BBP_RFC_READ_TABLE"
  ) => Promise<unknown>,
  nativeFailure?: Error
) {
  const parsed = tableQuerySchema.safeParse(raw)
  if (!parsed.success) throw new Error("TABLE_QUERY_INPUT_INVALID")
  const input = parsed.data
  const allFields = input.columns.length === 1 && input.columns[0] === "*"
  if (input.columns.includes("*") && !allFields) throw new Error("TABLE_QUERY_INPUT_INVALID")
  if (new Set(input.columns).size !== input.columns.length)
    throw new Error("TABLE_QUERY_DUPLICATE_COLUMN")
  // D5-2 ruling W3: the allowlist is authoritative for this read path *including* the RFC
  // fallback. It runs before any SAP access, so a rejected table never reaches the backend and
  // never depends on the backend's own table-class check to be safe.
  assertTableAllowed(input.tableName)
  const connectionId = input.connectionId.toLowerCase()
  // Conditions are compiled from structured operands, never parsed from caller SQL.
  const conditions = input.filters.map(({ column, operator, value }, index) => {
    const text = `${index ? "AND " : ""}${column} ${operators[operator]} '${value.replaceAll("'", "''")}'`
    if (text.length > 72) throw new Error("TABLE_QUERY_FILTER_TOO_LONG")
    return { TEXT: text }
  })
  let stage = "dictionary"
  let method: "adt_query" | "rfc_read_table" | "bbp_rfc_read_table" = "adt_query"
  let definitionFingerprint: string | undefined
  let nativeCode: string | undefined
  let layoutSummary: { fieldCount: number; totalLength: number; types: string[] } | undefined
  const base = {
    connectionId,
    tableName: input.tableName,
    columns: input.columns,
    maxRows: input.maxRows,
    readOnly: true,
    order: "unspecified",
    clientHandling: "sap_session_default",
    snapshot: false
  }
  try {
    let rawDefinition: unknown
    try {
      rawDefinition = await readTable(connectionId, input.tableName)
    } catch (error) {
      if (error instanceof Error && /(?:^|:\s)DDIC_OBJECT_NOT_FOUND(?::|$)/.test(error.message))
        throw new Error("TABLE_QUERY_TABLE_NOT_FOUND")
      return readWithRfcMetadataFallback(input, base, conditions, backend, readReader)
    }
    // The DDIC probe answers a missing object as a result instead of throwing, so the
    // table-not-found verdict has to be read from the payload too. Without this a table with no DDIC
    // definition would be reported as a dictionary mismatch instead of falling back to the RFC
    // metadata path below.
    if (
      rawDefinition !== null &&
      typeof rawDefinition === "object" &&
      (rawDefinition as { status?: unknown }).status === "not-found"
    )
      throw new Error("TABLE_QUERY_TABLE_NOT_FOUND")
    const definition = tableDefinition.safeParse(rawDefinition)
    if (!definition.success || definition.data.objectName !== input.tableName)
      throw new Error("TABLE_QUERY_DICTIONARY_INVALID")
    definitionFingerprint = definition.data.fingerprint
    const declaredColumns = definition.data.definition.fields.map((field) => field.name)
    const allColumns = declaredColumns.filter((name) => !name.startsWith("."))
    if (allFields) input.columns = [...allColumns]
    base.columns = input.columns
    // A caller cannot act on a bare "field invalid": the 17:10 incident spent a round trip on
    // read_abap_table(DD02L, [... DDLANGUAGE]) because DD02L has 31 columns and DDLANGUAGE is not one
    // of them (it lives in DD02V), and nothing in the reply said which column was wrong. Name the
    // offending columns and hand back the real projection set instead.
    //
    // The definition is judged first: when it is itself unusable, every requested column looks
    // invalid and blaming the request would hide the real defect.
    if (
      allColumns.length === 0 ||
      allColumns.length > 1024 ||
      new Set(allColumns).size !== allColumns.length
    )
      throw new TableQueryFailure("TABLE_QUERY_DEFINITION_INCOMPLETE", {
        definitionFieldCount: allColumns.length,
        ...(allColumns.length > 0
          ? { validColumns: allColumns.slice(0, validColumnSampleLimit) }
          : {})
      })
    const requested = [...input.columns, ...input.filters.map((filter) => filter.column)]
    const invalidColumns = [...new Set(requested.filter((name) => !allColumns.includes(name)))]
    if (invalidColumns.length > 0)
      throw new TableQueryFailure("TABLE_QUERY_FIELD_INVALID", {
        invalidColumns,
        validColumns: allColumns.slice(0, validColumnSampleLimit),
        validColumnCount: allColumns.length
      })
    let data: Record<string, unknown>[]
    let fieldMetadata: Metadata | undefined
    let verifyDefinition = false
    stage = "native_query"
    try {
      if (nativeFailure) throw nativeFailure
      data = await backend.runQuery(
        connectionId,
        `SELECT ${input.columns.join(", ")} FROM ${input.tableName}${conditions.length ? ` WHERE ${conditions.map((condition) => condition.TEXT).join(" ")}` : ""}`,
        input.maxRows + 1,
        { allowScopedFallback: false }
      )
    } catch (error) {
      if (!(error instanceof Error) || error.message !== nativeEmptyHtml) throw error
      nativeCode = "SAP_DATA_QUERY_RESPONSE_INVALID"
      method = "rfc_read_table"
      stage = "reader_definition"
      if (
        !reviewedTableReaderDefinition.safeParse(await readReader(connectionId, "RFC_READ_TABLE"))
          .success
      )
        throw new Error("TABLE_QUERY_READER_UNVERIFIED")
      let functionName: "RFC_READ_TABLE" | "BBP_RFC_READ_TABLE" = "RFC_READ_TABLE"
      let dataCalls = 0
      const invoke = async (
        columns: string[],
        noData: boolean,
        options = conditions,
        limit = input.maxRows + 1
      ) => {
        if (!noData && ++dataCalls > 256) throw new Error("TABLE_QUERY_REQUEST_BUDGET_EXCEEDED")
        const expectedColumns = columns.length ? columns : allColumns
        const request: RemoteFunctionRequest = {
          functionName,
          inputParameters: {
            QUERY_TABLE: input.tableName,
            DELIMITER: "|",
            NO_DATA: noData ? "X" : "",
            ROWSKIPS: "0",
            ROWCOUNT: String(noData ? 1 : limit),
            OPTIONS: noData ? [] : options,
            FIELDS: columns.map((FIELDNAME) => ({ FIELDNAME })),
            DATA: []
          },
          outputParameters: [
            { name: "FIELDS", kind: "table", fields: ["FIELDNAME", "TYPE", "LENGTH", "OFFSET"] },
            { name: "DATA", kind: "table", fields: ["WA"] }
          ]
        }
        const response = await backend.callRemoteFunction(connectionId, request)
        if (response.fault) {
          throw new Error(
            response.fault.name === "NOT_AUTHORIZED"
              ? "TABLE_QUERY_NOT_AUTHORIZED"
              : "TABLE_QUERY_RFC_FAILED"
          )
        }
        const fields = metadataSchema.safeParse(response.outputs.FIELDS)
        const rows = response.outputs.DATA
        if (
          !fields.success ||
          fields.data.length !== expectedColumns.length ||
          fields.data.some((field, index) => field.FIELDNAME !== expectedColumns[index]) ||
          !Array.isArray(rows) ||
          rows.length > (noData ? 0 : limit)
        )
          throw new Error("TABLE_QUERY_RESPONSE_INVALID")
        return { fields: fields.data, rows }
      }
      // The reviewed legacy FM casts the entire row into a fixed work buffer.
      // Check the full table, not only the projection, before any data SELECT.
      stage = "layout_preflight"
      // An empty FIELDS request independently expands Includes in SAP. Never omit
      // hidden components from the whole-row safety check by merely dropping markers.
      const layout = await invoke(
        declaredColumns.length === allColumns.length ? allColumns : [],
        true
      )
      layoutSummary = {
        fieldCount: layout.fields.length,
        totalLength: layout.fields.reduce((sum, field) => sum + Number(field.LENGTH), 0),
        types: [...new Set(layout.fields.map((field) => field.TYPE))].sort()
      }
      if (
        layout.fields.some(
          (field) =>
            !["C", "N", "D", "T", "P", "I", "F", "X", "b", "s"].includes(field.TYPE) ||
            Number(field.LENGTH) < 1
        ) ||
        layout.fields.reduce((sum, field) => sum + Number(field.LENGTH), 0) > 8000
      )
        throw new Error("TABLE_QUERY_LEGACY_LAYOUT_UNSUPPORTED")
      const selected = input.columns.map(
        (name) => layout.fields.find((field) => field.FIELDNAME === name)!
      )
      if (
        input.filters
          .map((filter) => filter.column)
          .some(
            (name) =>
              !["C", "N", "D", "T"].includes(layout.fields.find((f) => f.FIELDNAME === name)!.TYPE)
          )
      )
        throw new Error("TABLE_QUERY_LEGACY_LAYOUT_UNSUPPORTED")
      const width =
        selected.reduce((sum, field) => sum + Number(field.LENGTH), 0) + selected.length - 1
      if (
        selected.some(
          (field) => !["C", "N", "D", "T", "P", "I", "F", "b", "s"].includes(field.TYPE)
        )
      )
        throw new Error("TABLE_QUERY_LEGACY_LAYOUT_UNSUPPORTED")
      if (layout.fields.some((field) => !["C", "N", "D", "T"].includes(field.TYPE))) {
        // Conservative byte bound includes Unicode width, numeric storage and
        // per-component alignment padding within the reviewed 30000-char buffer.
        // DDIC stores INT1/2/4 as X; runtime metadata also uses b/s for small integers.
        // Numeric text output is checked for overflow; byte projections remain unsupported.
        const bytes = layout.fields.reduce(
          (sum, field) => sum + Math.max(Number(field.LENGTH) * 2, 8) + 7,
          0
        )
        if (bytes > 30000) throw new Error("TABLE_QUERY_LEGACY_LAYOUT_UNSUPPORTED")
        stage = "aligned_reader_definition"
        if (
          !reviewedAlignedReader.safeParse(await readReader(connectionId, "BBP_RFC_READ_TABLE"))
            .success
        )
          throw new Error("TABLE_QUERY_READER_UNVERIFIED")
        functionName = "BBP_RFC_READ_TABLE"
        method = "bbp_rfc_read_table"
        stage = "aligned_layout_preflight"
        const aligned = await invoke(allColumns, true)
        if (
          aligned.fields.some((field, index) => {
            const expected = layout.fields[index]!
            return (
              field.TYPE !== expected.TYPE ||
              Number(field.LENGTH) !== Number(expected.LENGTH) ||
              Number(field.OFFSET) !== Number(expected.OFFSET)
            )
          })
        )
          throw new Error("TABLE_QUERY_METADATA_CHANGED")
      }
      stage = "rfc_query"
      if (
        width > 512 ||
        allFields ||
        selected.some((f) => !["C", "N", "D", "T"].includes(f.TYPE))
      ) {
        verifyDefinition = true
        const keys = definition.data.definition.fields
          .filter((field) => field.key && !field.name.startsWith("."))
          .map((field) => field.name)
        fieldMetadata = selected
        data = await readCompleteRows(
          input.columns,
          keys,
          layout.fields,
          input.maxRows,
          conditions,
          invoke
        )
      } else {
        const response = await invoke(input.columns, false)
        let offset = 0
        if (
          response.fields.some((field, index) => {
            const expected = selected[index]!
            const invalid =
              field.TYPE !== expected.TYPE ||
              Number(field.LENGTH) !== Number(expected.LENGTH) ||
              Number(field.OFFSET) !== offset
            offset += Number(field.LENGTH) + 1
            return invalid
          })
        )
          throw new Error("TABLE_QUERY_METADATA_CHANGED")
        fieldMetadata = response.fields
        data = response.rows.map((row) => {
          if (typeof row.WA !== "string" || row.WA.length > 512)
            throw new Error("TABLE_QUERY_RESPONSE_INVALID")
          const cells = row.WA.split("|")
          if (
            cells.length !== input.columns.length ||
            cells.some((cell, index) => cell.length > Number(selected[index]!.LENGTH))
          )
            throw new Error("TABLE_QUERY_RESPONSE_INVALID")
          return Object.fromEntries(
            input.columns.map((name, index) => [name, cells[index]!.trim()])
          )
        })
      }
    }
    if (verifyDefinition) {
      const current = tableDefinition.safeParse(await readTable(connectionId, input.tableName))
      if (
        !current.success ||
        current.data.objectName !== input.tableName ||
        current.data.fingerprint !== definitionFingerprint
      )
        throw new Error("TABLE_QUERY_METADATA_CHANGED")
    }
    stage = "response_validation"
    if (!Array.isArray(data) || data.length > input.maxRows + 1)
      throw new Error("TABLE_QUERY_RESPONSE_INVALID")
    const rows = data.map((row) => {
      if (
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        Object.keys(row).length !== input.columns.length ||
        input.columns.some((name) => {
          const value = row[name]
          return (
            typeof value !== "string" &&
            !(typeof value === "number" && Number.isFinite(value)) &&
            !(value instanceof Date && Number.isFinite(value.valueOf()))
          )
        })
      )
        throw new Error("TABLE_QUERY_RESPONSE_INVALID")
      return Object.fromEntries(input.columns.map((name) => [name, row[name]]))
    })
    return {
      ...base,
      status: "ok",
      method,
      definitionSource: "adt_ddic",
      tableClassVerified: true,
      definitionFingerprint,
      nativeCode,
      representation: method === "adt_query" ? "adt_decoded" : "sap_text_trimmed",
      fieldMetadata,
      returnedCount: Math.min(rows.length, input.maxRows),
      truncated: rows.length > input.maxRows,
      data: rows.slice(0, input.maxRows)
    }
  } catch (error) {
    const code =
      error instanceof Error &&
      [
        "TABLE_QUERY_DICTIONARY_INVALID",
        "TABLE_QUERY_DEFINITION_INCOMPLETE",
        "TABLE_QUERY_TABLE_NOT_FOUND",
        "TABLE_QUERY_FIELD_INVALID",
        "TABLE_QUERY_READER_UNVERIFIED",
        "TABLE_QUERY_NOT_AUTHORIZED",
        "TABLE_QUERY_RFC_FAILED",
        "TABLE_QUERY_RESPONSE_INVALID",
        "TABLE_QUERY_LEGACY_LAYOUT_UNSUPPORTED",
        "TABLE_QUERY_ROW_TOO_WIDE",
        "TABLE_QUERY_METADATA_CHANGED",
        "TABLE_QUERY_KEY_UNSUPPORTED",
        "TABLE_QUERY_ROW_CHANGED",
        "TABLE_QUERY_NUMERIC_OVERFLOW",
        "TABLE_QUERY_REQUEST_BUDGET_EXCEEDED"
      ].includes(error.message)
        ? error.message
        : "TABLE_QUERY_READ_FAILED"
    return {
      ...base,
      status: "unavailable",
      method,
      stage,
      code,
      definitionFingerprint,
      nativeCode,
      ...(layoutSummary ? { layoutSummary } : {}),
      // Evidence attached by TableQueryFailure: which columns were rejected and what the table
      // actually declares. Absent for every other failure, so existing consumers see the same shape.
      ...(error instanceof TableQueryFailure ? error.detail : {}),
      returnedCount: 0,
      truncated: null,
      data: null
    }
  }
}

async function readWithRfcMetadataFallback(
  input: z.infer<typeof tableQuerySchema>,
  base: {
    connectionId: string
    tableName: string
    columns: string[]
    maxRows: number
    readOnly: boolean
    order: string
    clientHandling: string
    snapshot: boolean
  },
  conditions: { TEXT: string }[],
  backend: Pick<SapBackend, "callRemoteFunction">,
  readReader: (
    connectionId: string,
    functionName: "RFC_READ_TABLE" | "BBP_RFC_READ_TABLE"
  ) => Promise<unknown>
) {
  let stage = "dictionary_fallback_precondition"
  let method: "rfc_read_table" | "bbp_rfc_read_table" = "rfc_read_table"
  let functionName: "RFC_READ_TABLE" | "BBP_RFC_READ_TABLE" = "RFC_READ_TABLE"
  let readerFallbackCode: string | undefined
  let definitionFingerprint: string | undefined
  let layoutSummary: { fieldCount: number; totalLength: number; types: string[] } | undefined
  const fail = (code: string) => ({
    ...base,
    status: "unavailable",
    method,
    definitionSource: "unavailable",
    stage,
    code,
    definitionFingerprint,
    nativeCode: "DDIC_METADATA_UNAVAILABLE",
    ...(readerFallbackCode ? { readerFallbackCode } : {}),
    ...(layoutSummary ? { layoutSummary } : {}),
    returnedCount: 0,
    truncated: null,
    data: null
  })
  try {
    if (input.columns.includes("*")) throw new Error("TABLE_QUERY_DICTIONARY_FALLBACK_UNSUPPORTED")
    stage = "reader_definition"
    if (
      !reviewedTableReaderDefinition.safeParse(
        await readReader(base.connectionId, "RFC_READ_TABLE")
      ).success
    )
      throw new Error("TABLE_QUERY_READER_UNVERIFIED")

    const invoke = async (columns: string[], noData: boolean) => {
      const request: RemoteFunctionRequest = {
        functionName,
        inputParameters: {
          QUERY_TABLE: input.tableName,
          DELIMITER: "|",
          NO_DATA: noData ? "X" : "",
          ROWSKIPS: "0",
          ROWCOUNT: String(noData ? 1 : input.maxRows + 1),
          OPTIONS: noData ? [] : conditions,
          FIELDS: columns.map((FIELDNAME) => ({ FIELDNAME })),
          DATA: []
        },
        outputParameters: [
          { name: "FIELDS", kind: "table", fields: ["FIELDNAME", "TYPE", "LENGTH", "OFFSET"] },
          { name: "DATA", kind: "table", fields: ["WA"] }
        ]
      }
      const response = await backend.callRemoteFunction(base.connectionId, request)
      if (response.fault) {
        const faultName = response.fault.name.trim().toUpperCase()
        throw new Error(
          faultName === "NOT_AUTHORIZED"
            ? "TABLE_QUERY_NOT_AUTHORIZED"
            : faultName === "DATA_BUFFER_EXCEEDED"
              ? "TABLE_QUERY_DATA_BUFFER_EXCEEDED"
              : faultName === "DDIC_METADATA_UNAVAILABLE"
                ? "TABLE_QUERY_DDIC_METADATA_UNAVAILABLE"
                : "TABLE_QUERY_RFC_FAILED"
        )
      }
      const fields = metadataSchema.safeParse(response.outputs.FIELDS)
      const rows = response.outputs.DATA
      if (
        !fields.success ||
        (columns.length > 0 &&
          (fields.data.length !== columns.length ||
            fields.data.some((field, index) => field.FIELDNAME !== columns[index]))) ||
        !Array.isArray(rows) ||
        rows.length > (noData ? 0 : input.maxRows + 1)
      )
        throw new Error("TABLE_QUERY_RESPONSE_INVALID")
      return { fields: fields.data, rows }
    }

    stage = "rfc_metadata_preflight"
    let layout: Awaited<ReturnType<typeof invoke>>
    try {
      layout = await invoke([], true)
    } catch (error) {
      if (
        !(error instanceof Error) ||
        ![
          "TABLE_QUERY_DATA_BUFFER_EXCEEDED",
          "TABLE_QUERY_DDIC_METADATA_UNAVAILABLE",
          "TABLE_QUERY_RFC_FAILED"
        ].includes(error.message)
      ) {
        throw error
      }
      stage = "aligned_reader_definition"
      if (
        !reviewedAlignedReader.safeParse(await readReader(base.connectionId, "BBP_RFC_READ_TABLE"))
          .success
      )
        throw new Error("TABLE_QUERY_READER_UNVERIFIED")
      functionName = "BBP_RFC_READ_TABLE"
      method = "bbp_rfc_read_table"
      readerFallbackCode =
        error.message === "TABLE_QUERY_DATA_BUFFER_EXCEEDED"
          ? "DATA_BUFFER_EXCEEDED"
          : "DDIC_METADATA_UNAVAILABLE"
      stage = "aligned_rfc_metadata_preflight"
      layout = await invoke([], true)
    }
    const fieldNames = layout.fields.map((field) => field.FIELDNAME)
    layoutSummary = {
      fieldCount: layout.fields.length,
      totalLength: layout.fields.reduce((sum, field) => sum + Number(field.LENGTH), 0),
      types: [...new Set(layout.fields.map((field) => field.TYPE))].sort()
    }
    if (
      new Set(fieldNames).size !== fieldNames.length ||
      layout.fields.some(
        (field) =>
          !["C", "N", "D", "T", "P", "I", "F", "X", "b", "s"].includes(field.TYPE) ||
          Number(field.LENGTH) < 1
      ) ||
      layoutSummary.totalLength > 8000 ||
      [...input.columns, ...input.filters.map((filter) => filter.column)].some(
        (name) => !fieldNames.includes(name)
      )
    )
      throw new Error("TABLE_QUERY_LEGACY_LAYOUT_UNSUPPORTED")
    if (layout.fields.some((field) => !["C", "N", "D", "T"].includes(field.TYPE))) {
      const bytes = layout.fields.reduce(
        (sum, field) => sum + Math.max(Number(field.LENGTH) * 2, 8) + 7,
        0
      )
      if (bytes > 30000) throw new Error("TABLE_QUERY_LEGACY_LAYOUT_UNSUPPORTED")
    }
    const selected = input.columns.map(
      (name) => layout.fields.find((field) => field.FIELDNAME === name)!
    )
    const filtered = input.filters.map(
      (filter) => layout.fields.find((field) => field.FIELDNAME === filter.column)!
    )
    const width =
      selected.reduce((sum, field) => sum + Number(field.LENGTH), 0) + selected.length - 1
    if (
      width > 512 ||
      [...selected, ...filtered].some((field) => !["C", "N", "D", "T"].includes(field.TYPE))
    )
      throw new Error("TABLE_QUERY_DICTIONARY_FALLBACK_UNSUPPORTED")
    const fingerprint = (fields: Metadata) =>
      createHash("sha256")
        .update(JSON.stringify({ tableName: input.tableName, fields }))
        .digest("hex")
    definitionFingerprint = fingerprint(layout.fields)

    stage = "rfc_query"
    const response = await invoke(input.columns, false)
    let offset = 0
    if (
      response.fields.some((field, index) => {
        const expected = selected[index]!
        const invalid =
          field.TYPE !== expected.TYPE ||
          Number(field.LENGTH) !== Number(expected.LENGTH) ||
          Number(field.OFFSET) !== offset
        offset += Number(field.LENGTH) + 1
        return invalid
      })
    )
      throw new Error("TABLE_QUERY_METADATA_CHANGED")
    const rows = response.rows.map((row) => {
      const wa = (row as { WA?: unknown } | null)?.WA
      if (typeof wa !== "string" || wa.length > 512) throw new Error("TABLE_QUERY_RESPONSE_INVALID")
      const cells = wa.split("|")
      if (
        cells.length !== input.columns.length ||
        cells.some((cell, index) => cell.length > Number(selected[index]!.LENGTH))
      )
        throw new Error("TABLE_QUERY_RESPONSE_INVALID")
      return Object.fromEntries(input.columns.map((name, index) => [name, cells[index]!.trim()]))
    })

    stage = "rfc_metadata_recheck"
    const current = await invoke([], true)
    if (fingerprint(current.fields) !== definitionFingerprint)
      throw new Error("TABLE_QUERY_METADATA_CHANGED")
    return {
      ...base,
      status: "ok",
      method,
      definitionSource: "rfc_metadata",
      tableClassVerified: false,
      definitionFingerprint,
      nativeCode: "DDIC_METADATA_UNAVAILABLE",
      readerFallbackCode,
      representation: "sap_text_trimmed",
      fieldMetadata: response.fields,
      returnedCount: Math.min(rows.length, input.maxRows),
      truncated: rows.length > input.maxRows,
      data: rows.slice(0, input.maxRows)
    }
  } catch (error) {
    const code =
      error instanceof Error &&
      [
        "TABLE_QUERY_DICTIONARY_FALLBACK_UNSUPPORTED",
        "TABLE_QUERY_READER_UNVERIFIED",
        "TABLE_QUERY_NOT_AUTHORIZED",
        "TABLE_QUERY_RFC_FAILED",
        "TABLE_QUERY_DATA_BUFFER_EXCEEDED",
        "TABLE_QUERY_DDIC_METADATA_UNAVAILABLE",
        "TABLE_QUERY_RESPONSE_INVALID",
        "TABLE_QUERY_LEGACY_LAYOUT_UNSUPPORTED",
        "TABLE_QUERY_METADATA_CHANGED"
      ].includes(error.message)
        ? error.message
        : "TABLE_QUERY_READ_FAILED"
    return fail(code)
  }
}

type ReadRows = (
  columns: string[],
  noData: boolean,
  options?: { TEXT: string }[],
  limit?: number
) => Promise<{ fields: Metadata; rows: unknown[] }>

async function readCompleteRows(
  columns: string[],
  keys: string[],
  layout: Metadata,
  maxRows: number,
  originalConditions: { TEXT: string }[],
  invoke: ReadRows
): Promise<Record<string, string>[]> {
  const byName = new Map(layout.map((field) => [field.FIELDNAME, field]))
  const width = (names: string[]) =>
    names.reduce((sum, name) => sum + Number(byName.get(name)!.LENGTH), 0) + names.length - 1
  const read = async (names: string[], options?: { TEXT: string }[], limit?: number) => {
    const response = await invoke(names, false, options, limit)
    let offset = 0
    for (const field of response.fields) {
      const expected = byName.get(field.FIELDNAME)!
      if (
        field.TYPE !== expected.TYPE ||
        Number(field.LENGTH) !== Number(expected.LENGTH) ||
        Number(field.OFFSET) !== offset
      )
        throw new Error("TABLE_QUERY_METADATA_CHANGED")
      offset += Number(field.LENGTH) + 1
    }
    return response.rows.map((raw, rowIndex) => {
      const wa = (raw as { WA?: unknown } | null)?.WA
      if (typeof wa !== "string" || wa.length > 512 || wa.slice(offset - 1).trim())
        throw new Error("TABLE_QUERY_RESPONSE_INVALID")
      // SOAP can omit CHAR tail padding. Preserve leading padding and delimiters
      // inside actual field values by decoding the verified fixed offsets.
      const padded = wa.padEnd(offset - 1, " ")
      // A refusal the caller cannot locate is a refusal it cannot correct: RFC_READ_TABLE answers with
      // fixed-offset text and carries no row identity of its own, so the key columns the projection
      // happens to include are read out of the same buffer. A projection that carries none of them
      // leaves the key absent rather than inventing one - which is stated in the tool contract.
      const rowKey: Record<string, string> = {}
      for (const name of keys) {
        const field = response.fields.find((candidate) => candidate.FIELDNAME === name)
        if (!field) continue
        const start = Number(field.OFFSET)
        rowKey[name] = padded.slice(start, start + Number(field.LENGTH)).trim()
      }
      return Object.fromEntries(
        response.fields.map((field, index) => {
          const start = Number(field.OFFSET)
          if (index && padded[start - 1] !== "|") throw new Error("TABLE_QUERY_RESPONSE_INVALID")
          const text = padded.slice(start, start + Number(field.LENGTH))
          const value = text.trim()
          if (
            ["P", "I", "F", "b", "s"].includes(field.TYPE) &&
            (!/^[+-]?\d[\d., ]*(?:[Ee][+-]?\d+)?[+-]?$/.test(value) || value.includes("*"))
          )
            throw new TableQueryFailure("TABLE_QUERY_NUMERIC_OVERFLOW", {
              overflowColumn: field.FIELDNAME,
              // Untrimmed on purpose: the guard fires on the trimmed text, and which clause named it
              // (replacement asterisks, or a form that is not a plain decimal) is only decidable from
              // the padded buffer the reader actually decoded.
              overflowRawValue: text,
              overflowRowIndex: rowIndex,
              ...(Object.keys(rowKey).length > 0 ? { overflowRowKey: rowKey } : {})
            })
          return [field.FIELDNAME, value]
        })
      )
    })
  }
  if (width(columns) <= 512) return read(columns)
  if (
    !keys.length ||
    keys.length > 16 ||
    keys.some((name) => !["C", "N", "D", "T"].includes(byName.get(name)?.TYPE ?? "")) ||
    width(keys) > 512
  )
    throw new Error("TABLE_QUERY_KEY_UNSUPPORTED")
  const groups: string[][] = []
  let group = [...keys]
  for (const name of columns.filter((column) => !keys.includes(column))) {
    if (width([name]) > 512) throw new Error("TABLE_QUERY_ROW_TOO_WIDE")
    if (width([...keys, name]) > 512) {
      if (group.length > keys.length) groups.push(group)
      // The full primary key remains in WHERE. It need not consume TAB512
      // output space when reading one long field from that unique record.
      groups.push([name])
      group = [...keys]
      continue
    }
    if (width([...group, name]) > 512) {
      groups.push(group)
      group = [...keys]
    }
    group.push(name)
  }
  groups.push(group)
  const keyRows = await read(keys)
  const identity = (row: Record<string, string>) => JSON.stringify(keys.map((key) => row[key]))
  if (new Set(keyRows.map(identity)).size !== keyRows.length)
    throw new Error("TABLE_QUERY_RESPONSE_INVALID")
  if (1 + keyRows.length * groups.length * 2 > 256)
    throw new Error("TABLE_QUERY_REQUEST_BUDGET_EXCEEDED")
  const result: Record<string, string>[] = []
  for (const key of keyRows) {
    const options = [
      ...originalConditions,
      ...keys.map((name, index) => {
        const value = key[name]!
        const TEXT = `${index || originalConditions.length ? "AND " : ""}${name} = '${value.replaceAll("'", "''")}'`
        if (value.length > 40 || /[\u0000-\u001f\u007f]/.test(value) || TEXT.length > 72)
          throw new Error("TABLE_QUERY_KEY_UNSUPPORTED")
        return { TEXT }
      })
    ]
    const collect = async () => {
      const row: Record<string, string> = {}
      for (const names of groups) {
        const rows = await read(names, options, 2)
        if (
          rows.length !== 1 ||
          (keys.every((name) => names.includes(name)) && identity(rows[0]!) !== identity(key))
        )
          throw new Error("TABLE_QUERY_ROW_CHANGED")
        Object.assign(row, rows[0])
      }
      return Object.fromEntries(columns.map((name) => [name, row[name]!]))
    }
    const first = await collect()
    // Two equal observations detect ordinary concurrent edits, not a database snapshot.
    if (JSON.stringify(first) !== JSON.stringify(await collect()))
      throw new Error("TABLE_QUERY_ROW_CHANGED")
    result.push(first)
  }
  if (result.length > maxRows + 1) throw new Error("TABLE_QUERY_RESPONSE_INVALID")
  return result
}

/** A filter as the reader's own schema defines it, so the parser below cannot drift from it. */
type SelectFilter = z.infer<typeof tableQuerySchema>["filters"][number]

/**
 * One comparison whose left side is an arithmetic term rather than a column, for example
 * `ZAEHL / 2 >= 3`.
 *
 * The reader's structured filter takes a column name, an operator and a literal, so a term cannot be
 * handed to it: there is nothing to push down. The condition is therefore kept apart from the pushed
 * filters and decided in the service, after a read that is complete - the rule `ORDER BY` already
 * follows, for the same reason. A term read off a truncated page would filter a sample and report
 * the matches of that sample as the matches of the statement.
 */
export interface SelectTermCondition {
  /** The term as the caller wrote it, for messages and for `querySource.whereExpressions`. */
  text: string
  node: ArithmeticNode
  operator: SelectFilter["operator"]
  /** The literal the term is compared with, exactly as written. */
  value: string
}

/**
 * One `IN (SELECT ...)` test: the inner statement's single selected column holds a set of values, and
 * the outer row matches when its own value is in that set (`IN`) or outside it (`NOT IN`).
 *
 * The reader's structured filter takes one column, one operator and one literal - it has no set
 * operator and cannot nest a read - so the test is decided here, over a complete outer read, for the
 * same reason a `WHERE` term is. The inner statement is parsed by this same grammar and read
 * completely: a set that stopped at the row bound is a sample of the values, and "the rows whose
 * value is in a sample" is not the answer to the question that was asked.
 *
 * Comparing the two sides is a comparison of values, not of text: `NUMC` keys, packed numbers and
 * character fields do not compare the way their printed form suggests. The comparison class is taken
 * from the dictionary type of both columns, and a pair this layer cannot compare under SAP's own
 * rules is refused by name rather than compared as text.
 */
export interface SelectSubqueryCondition {
  /** The outer column whose value is tested. */
  column: string
  /** True when the caller wrote `NOT IN`. */
  negated: boolean
  /** The inner statement, parsed by the same single-table grammar. */
  select: GroupedTableSelect
  /** The inner statement's one selected column: the values the set holds. */
  valueColumn: string
  /** The whole test as the caller wrote it, for messages and for the published mapping. */
  text: string
}

/**
 * One uncorrelated scalar subquery in a comparison: `ZAEHL = (SELECT COUNT(*) FROM T001)`, or a
 * comparison of a column with the single value an inner statement answers.
 *
 * The inner statement is one this same grammar translates, and it must answer **exactly one row**:
 * a count, a sum, a minimum or a maximum (one row by construction, when it groups by nothing), or a
 * single plain column whose read returned exactly one row. Several rows are refused by name rather
 * than reduced to one of them - picking a row would answer a question nobody asked - and so is a row
 * that stopped at the row bound, because a value read from a sample is not the value of the
 * statement. No row at all is refused too: SQL reads that as NULL and answers "unknown", a
 * three-valued rule this layer does not reproduce.
 *
 * The comparison is the same one the `IN (SELECT ...)` test makes, and follows the same discipline:
 * the class comes from the dictionary type of both sides (characters compare with trailing blanks
 * ignored, numbers as exact decimals), and a pair this layer cannot compare - a floating point
 * field, a mixed pair, a type in neither class, an empty numeric value - is refused by name rather
 * than compared as printed text. Ordering a character value (`<`, `>`, `<=`, `>=`) is refused as
 * well: SAP orders character fields by its own collation, which this layer cannot state.
 */
export interface SelectScalarCondition {
  /** The outer column whose value is compared with the scalar. */
  column: string
  operator: SelectFilter["operator"]
  /** The inner statement, parsed by the same single-table grammar. */
  select: GroupedTableSelect
  /** The inner column the value is read from, or null when the inner statement is `COUNT(*)`. */
  valueColumn: string | null
  /** The whole comparison as the caller wrote it, for messages and the published mapping. */
  text: string
}

/**
 * One conjunct of a disjunct: a comparison the reader can apply itself, a term this service decides,
 * a set test this service decides, or a scalar comparison this service decides. The four are told
 * apart structurally, without a tag that would have to be stripped before a filter reaches the
 * reader: a pushed filter has a column, an operator and **no** inner statement; a scalar comparison
 * has all three; a set test has an inner statement and a negation instead of an operator; and a term
 * has neither a column to push nor an inner statement (it is the only one without `column`).
 */
export type SelectCondition =
  | SelectFilter
  | SelectTermCondition
  | SelectSubqueryCondition
  | SelectScalarCondition

/** The conditions of one disjunct that can be handed to the reader; the rest are decided here. */
export function pushableFilters(conditions: SelectCondition[]): SelectFilter[] {
  return conditions.filter(
    (condition): condition is SelectFilter =>
      "column" in condition && "operator" in condition && !("select" in condition)
  )
}

/** The term conditions of one disjunct, in the order they were written. */
function termConditions(conditions: SelectCondition[]): SelectTermCondition[] {
  return conditions.filter(
    (condition): condition is SelectTermCondition =>
      !("column" in condition) && !("select" in condition)
  )
}

/** The set tests of one disjunct, in the order they were written. */
function subqueryConditions(conditions: SelectCondition[]): SelectSubqueryCondition[] {
  return conditions.filter(
    (condition): condition is SelectSubqueryCondition =>
      "select" in condition && "negated" in condition
  )
}

/** The scalar comparisons of one disjunct, in the order they were written. */
function scalarConditions(conditions: SelectCondition[]): SelectScalarCondition[] {
  return conditions.filter(
    (condition): condition is SelectScalarCondition =>
      "select" in condition && "operator" in condition
  )
}

/**
 * The comparison operators the finite grammar translates, longest token first so `<=` is never read
 * as `<`. This is deliberately the same set {@link readAbapTable} accepts: the degraded path has no
 * business refusing a comparison the reader it calls can already express.
 */
const selectOperators: readonly (readonly [string, SelectFilter["operator"]])[] = [
  ["<=", "LE"],
  [">=", "GE"],
  ["<>", "NE"],
  ["=", "EQ"],
  ["<", "LT"],
  [">", "GT"]
]

/**
 * The finite fallback grammar:
 * `SELECT <projection> FROM <table> [WHERE <disjunction>] [GROUP BY <keys>] [ORDER BY <keys>]
 * [LIMIT <n>]`, where the disjunction is `AND`-joined comparisons joined by `OR`, the projection is
 * `*`, a column list, or a list of aggregates, and the ordering is a key list.
 *
 * Three bounds are refusals rather than silent adjustments. {@link selectDisjunctLimit} bounds the
 * `OR` branches, because every branch is one server-side read; {@link selectOrderLimit} bounds the
 * sort keys, which are evaluated in the service (the reader has no ordering parameter at all);
 * {@link selectGroupLimit} bounds the `GROUP BY` keys, which are compared in the service. `LIMIT` is
 * not a fourth bound of that kind: it never refuses anything and never shrinks a read - it bounds the
 * answer, and the statement is refused outright when the rows it would bound are a sample.
 */
const selectDisjunctLimit = 8
const selectOrderLimit = 8
const selectGroupLimit = 8

/** The aggregates this grammar can evaluate exactly. Anything else is refused by name. */
export type AggregateFunction = "COUNT" | "SUM" | "MIN" | "MAX"
const aggregateFunctions: readonly AggregateFunction[] = ["COUNT", "SUM", "MIN", "MAX"]

export interface SelectAggregate {
  fn: AggregateFunction
  /** `null` for `COUNT(*)`, the only aggregate that counts whole rows rather than one column. */
  column: string | null
}

/**
 * One arithmetic term in the projection, evaluated by this service rather than by SAP.
 *
 * The platform cannot evaluate it on this release, so the value is computed from the columns the
 * same read returned - which is only defensible because `table-expression.ts` reproduces ABAP's
 * calculation type, and refuses by name whatever it cannot reproduce exactly.
 */
export interface SelectExpression {
  /** The expression as the caller wrote it, for the published mapping and for messages. */
  text: string
  node: ArithmeticNode
  /** The column the answer publishes; see {@link expressionColumnName}. */
  column: string
}

/**
 * The column an expression publishes. Unlike an aggregate, an expression's text does not map to a
 * readable name without inventing one (`A.X * 2` would have to become `A_X_2`, and two different
 * expressions could then collide), so the name follows the projection position and the exact mapping
 * is returned as `querySource.expressionColumns`. Nothing has to be guessed from this rule.
 */
export function expressionColumnName(index: number): string {
  return `EXPR_${index + 1}`
}

export interface GroupedTableSelect {
  tableName: string
  columns: string[]
  aggregates: SelectAggregate[]
  /** Arithmetic terms in the projection, each published under its own derived column. */
  expressions: SelectExpression[]
  groupBy: string[]
  /**
   * True when the answer needs the row's own columns rather than a projection: `SELECT *`, and every
   * aggregate or `GROUP BY` statement, whose row identity is what makes a union of `OR` branches
   * countable without counting a row twice.
   */
  readWholeRow: boolean
  /**
   * Disjunction of conjunctions: a row matches when every conjunct of **one** group matches. Always
   * at least one group, and every group holds at least one conjunct, so a single-conjunct statement
   * and its grouped form are the same shape. A conjunct is either pushed to the reader or - when its
   * left side is a term - decided here; see {@link SelectCondition}.
   */
  groups: SelectCondition[][]
  orderBy: { column: string; direction: "asc" | "desc" }[]
  /**
   * The statement's own `LIMIT`, or `undefined` when it had none. It is applied after `ORDER BY` and
   * after grouping, because it bounds the answer rather than the read: `LIMIT` never shrinks what is
   * read, so a limited aggregate over a truncated read is still refused rather than counted partially.
   */
  limit?: number | undefined
}

/**
 * The column an aggregate publishes, derived from the expression itself so a caller can sort the
 * result (`sortColumns`, `ORDER BY`) without inventing an alias this grammar does not have:
 * `COUNT(*)` publishes `COUNT`, `SUM(NETWR)` publishes `SUM_NETWR`, and so on. The mapping is also
 * returned as `querySource.aggregateColumns` so nothing has to be guessed from this rule.
 */
export function aggregateColumnName(aggregate: SelectAggregate): string {
  return aggregate.fn === "COUNT" && aggregate.column === null
    ? "COUNT"
    : `${aggregate.fn}_${aggregate.column}`
}

/** The expression as the caller wrote it, used in messages and in the published mapping. */
export function aggregateExpression(aggregate: SelectAggregate): string {
  return `${aggregate.fn}(${aggregate.column ?? "*"})`
}

/**
 * The columns the reader must return for a statement.
 *
 * An aggregate or `GROUP BY` statement reads the whole row even though the answer is a count, because
 * row identity is what lets the merge tell "the same row matched two `OR` branches" from "two rows
 * matched": without it a count over overlapping branches would count one row twice.
 */
export function groupedReadColumns(
  select: Pick<
    GroupedTableSelect,
    "columns" | "readWholeRow" | "aggregates" | "groupBy" | "expressions" | "groups"
  >
): string[] {
  const wholeRow = select.readWholeRow || select.aggregates.length > 0 || select.groupBy.length > 0
  if (wholeRow) return ["*"]
  // An expression reads the columns it names, so they are read even though the answer publishes
  // only the derived value: without them the term could not be computed at all. A term in the WHERE
  // clause is read for the same reason, and its columns are dropped from the answer again - they are
  // evidence for the predicate, not part of what was selected. The column an `IN (SELECT ...)` test
  // or a scalar comparison tests is read for the same reason, and dropped the same way when it was
  // not selected.
  return [
    ...new Set([
      ...select.columns,
      ...select.expressions.flatMap((expression) => arithmeticColumns(expression.node)),
      ...select.groups.flatMap((group) => [
        ...termConditions(group).flatMap((condition) => arithmeticColumns(condition.node)),
        ...subqueryConditions(group).map((condition) => condition.column),
        ...scalarConditions(group).map((condition) => condition.column)
      ])
    ])
  ]
}

/**
 * True when the statement holds something this service has to evaluate itself - a term in the
 * projection, a term in the `WHERE` clause, an `IN (SELECT ...)` test, or a scalar comparison against
 * a subquery. Operand types have to come from the dictionary before the first read in every one of
 * those cases, and reading the dictionary is not free, so it is done only when the statement actually
 * needs it.
 *
 * The same predicate decides whether a column that was read for a predicate has to be dropped from
 * the answer again: it is evidence, not something the statement selected.
 */
export function selectEvaluatesTerms(
  select: Pick<GroupedTableSelect, "expressions" | "groups">
): boolean {
  return (
    select.expressions.length > 0 ||
    select.groups.some(
      (group) =>
        termConditions(group).length > 0 ||
        subqueryConditions(group).length > 0 ||
        scalarConditions(group).length > 0
    )
  )
}

/** The term conditions of every disjunct, for the mapping the answer publishes. */
function whereExpressions(
  select: Pick<GroupedTableSelect, "groups">
): GroupedReadResult["whereExpressions"] {
  return select.groups.flatMap((group, disjunct) =>
    termConditions(group).map((condition) => ({
      expression: condition.text,
      operator: condition.operator,
      value: condition.value,
      disjunct
    }))
  )
}

/** The `IN (SELECT ...)` tests of every disjunct, for the mapping the answer publishes. */
function whereSubqueries(
  select: Pick<GroupedTableSelect, "groups">,
  resolved: Map<string, ResolvedSubquery>
): GroupedReadResult["whereSubqueries"] {
  return select.groups.flatMap((group, disjunct) =>
    subqueryConditions(group).map((condition) => ({
      condition: condition.text,
      column: condition.column,
      negated: condition.negated,
      values: resolved.get(condition.text)?.values.size ?? 0,
      disjunct
    }))
  )
}

/**
 * The scalar comparisons of every disjunct, for the mapping the answer publishes.
 *
 * Unlike the values of a set - which are not repeated, because a set can be arbitrarily large - the
 * one value a scalar statement answered is published as the reader wrote it: it is the other half of
 * the comparison the caller asked for, and the answer says what was asked.
 */
function whereScalars(
  select: Pick<GroupedTableSelect, "groups">,
  resolved: Map<string, ResolvedScalar>
): GroupedReadResult["whereScalars"] {
  return select.groups.flatMap((group, disjunct) =>
    scalarConditions(group).map((condition) => ({
      condition: condition.text,
      column: condition.column,
      operator: condition.operator,
      value: resolved.get(condition.text)?.value ?? "",
      valueColumn: condition.valueColumn,
      disjunct
    }))
  )
}

/** The columns a statement publishes: the grouped columns, then one column per derived value. */
function groupedOutputColumns(
  select: Pick<GroupedTableSelect, "columns" | "aggregates" | "expressions">
): string[] {
  return [
    ...select.columns,
    ...select.aggregates.map(aggregateColumnName),
    ...select.expressions.map((expression) => expression.column)
  ]
}

const projectionFunctionPattern = /^([A-Z][A-Z0-9_]*)\s*\(/i
const projectionItemPattern =
  /^(?:(COUNT|SUM|MIN|MAX)\s*\(\s*(\*|[A-Z][A-Z0-9_]*)\s*\)|([A-Z][A-Z0-9_]*))$/i

/**
 * The refusal for a projection item that starts like a function call.
 *
 * A name outside the four aggregates is refused by name, which is this grammar's whole advantage over
 * the platform's empty-HTML answer: that one says nothing. A name that IS one of the four must never
 * be called unsupported. `SELECT COUNT(*) AS CNT FROM ADMI_RUN` used to be answered with "COUNT is not
 * translated. Supported aggregates are COUNT, SUM, MIN, MAX" - a sentence that contradicts itself and
 * hides the real cause, which is the alias. The translated forms are named instead, together with the
 * fact that the answer carries its own column name, because that is what the caller has to write.
 */
function projectionFunctionRefusal(item: string, name: string): Error {
  if ((aggregateFunctions as readonly string[]).includes(name)) {
    const forms = ["COUNT(*)", ...aggregateFunctions.map((fn) => `${fn}(<column>)`)]
    return new Error(
      `TABLE_QUERY_AGGREGATE_FORM_UNSUPPORTED: ${name} is supported, but "${item}" is not a form this ` +
        `dialect translates. Write ${forms.join(", ")} with no alias or nested call around it, and no ` +
        `arithmetic: a term is translated over columns, not over or inside an aggregate. The answer ` +
        `names its own column, so an alias is not needed.`
    )
  }
  return new Error(
    `TABLE_QUERY_AGGREGATE_UNSUPPORTED: ${name} is not translated. Supported aggregates are ` +
      `${aggregateFunctions.join(", ")}; AVG is not among them because it is SUM divided by ` +
      `COUNT, which this statement can ask for in two columns.`
  )
}

/**
 * Read the projection, or refuse.
 *
 * A function name this grammar does not evaluate is refused **by name** - the message can say what to
 * write instead, which the platform's own "empty HTML" error cannot. Any other expression (an
 * arithmetic term, `CASE`, `X AS Y`) is left to the platform: this parser cannot describe it, and
 * guessing would answer a question the caller did not ask.
 */
function parseProjection(text: string):
  | {
      columns: string[]
      aggregates: SelectAggregate[]
      expressions: SelectExpression[]
      selectAll: boolean
    }
  | undefined {
  const items = text.split(/\s*,\s*/)
  if (items.length === 0) return undefined
  const columns: string[] = []
  const aggregates: SelectAggregate[] = []
  const terms: Array<{ text: string; node: ArithmeticNode }> = []
  for (const item of items) {
    if (item === "*") {
      if (items.length > 1) {
        throw new Error(
          "TABLE_QUERY_AGGREGATE_WITH_WILDCARD: * cannot be combined with aggregates, expressions " +
            "or other columns - select the columns and terms explicitly."
        )
      }
      return { columns: ["*"], aggregates: [], expressions: [], selectAll: true }
    }
    const match = item.match(projectionItemPattern)
    if (!match) {
      // An arithmetic term this service evaluates itself. A term that names a qualified column
      // (`A.X`) belongs to the joined dialect and is left to it, exactly as before.
      const node = parseArithmetic(item)
      if (node) {
        const referenced = arithmeticColumns(node)
        if (!referenced.some((column) => column.includes("."))) {
          terms.push({ text: item, node })
          continue
        }
      }
      const call = item.match(projectionFunctionPattern)
      if (call) {
        throw projectionFunctionRefusal(item, call[1]!.toUpperCase())
      }
      return undefined
    }
    if (match[1]) {
      const fn = match[1]!.toUpperCase() as AggregateFunction
      const argument = match[2]!.toUpperCase()
      if (argument === "*" && fn !== "COUNT") {
        throw new Error(
          `TABLE_QUERY_AGGREGATE_ARGUMENT: ${fn}(*) has no meaning - ${fn} needs a column, and only ` +
            `COUNT may count whole rows.`
        )
      }
      aggregates.push({ fn, column: argument === "*" ? null : argument })
      continue
    }
    columns.push(match[3]!.toUpperCase())
  }
  if (new Set(columns).size !== columns.length) return undefined
  const names = aggregates.map(aggregateColumnName)
  if (new Set(names).size !== names.length) {
    throw new Error(
      "TABLE_QUERY_AGGREGATE_DUPLICATE: the same aggregate expression was selected twice, so one " +
        "published column would overwrite the other."
    )
  }
  // A derived name that shadows a selected column would publish two different answers under one key.
  const aggregateShadowed = names.filter((name) => columns.includes(name))
  if (aggregateShadowed.length > 0) {
    throw new Error(
      `TABLE_QUERY_AGGREGATE_SHADOWED: ${aggregateShadowed.join(", ")} is both a selected column ` +
        `and the column an aggregate publishes; rename the selected column out of the way.`
    )
  }
  // A projection that reads no column at all would publish one constant for every row. The platform
  // cannot evaluate it, and a constant is not what a table read is for, so it is refused rather than
  // answered with a column that says nothing about the table. A term that names a column counts as
  // reading one, whether or not a bare column is also selected.
  if (
    terms.length > 0 &&
    columns.length === 0 &&
    aggregates.length === 0 &&
    terms.every((term) => arithmeticColumns(term.node).length === 0)
  ) {
    throw new Error(
      `TABLE_QUERY_EXPRESSION_CONSTANT: ${terms.map((term) => `"${term.text}"`).join(", ")} reads ` +
        "no column, so the answer would repeat one constant. Select a column or a term over columns."
    )
  }
  const expressions: SelectExpression[] = terms.map((term, index) => ({
    text: term.text,
    node: term.node,
    column: expressionColumnName(index)
  }))
  // A derived name that shadows a selected column or an aggregate would publish two different
  // answers under one key.
  const outputNames = [...columns, ...names]
  const shadowed = expressions
    .map((expression) => expression.column)
    .filter((column) => outputNames.includes(column))
  if (shadowed.length > 0) {
    throw new Error(
      `TABLE_QUERY_EXPRESSION_SHADOWED: ${shadowed.join(", ")} is both a selected column and the ` +
        `column an expression publishes; rename the selected column out of the way.`
    )
  }
  return { columns, aggregates, expressions, selectAll: false }
}

function parseGroupBy(text: string): string[] | undefined {
  const keys: string[] = []
  let rest = text.trim()
  while (rest) {
    const key = rest.match(/^([A-Z][A-Z0-9_]*)([\s\S]*)$/i)
    if (!key || keys.length === selectGroupLimit) return undefined
    const column = key[1]!.toUpperCase()
    if (keys.includes(column)) return undefined
    keys.push(column)
    const after = key[2]!.trim()
    if (!after) break
    if (/^(ASC|DESC)\b/i.test(after)) {
      throw new Error(
        "TABLE_QUERY_GROUP_BY_DIRECTION: GROUP BY takes column names only; a direction belongs to " +
          "ORDER BY, which sorts the groups this statement returns."
      )
    }
    if (!after.startsWith(",")) return undefined
    rest = after.slice(1).trim()
    if (!rest) return undefined
  }
  return keys.length > 0 ? keys : undefined
}

/**
 * One comparison plus the separator that follows it. The literal is consumed by this pattern, so an
 * `AND`/`OR` inside a string value (`STATUS = 'OR'`) is part of the value and never a separator.
 */
const conjunctPattern =
  /^([A-Z][A-Z0-9_]*)\s*(<=|>=|<>|=|<|>)\s*('(?:[^']|'')*'|-?\d+(?:\.\d+)?)\s*(AND\s+|OR\s+|$)/i

/**
 * The same shape with an arithmetic term on the left. The term is split off at the **first** operator
 * token, which is sound because no arithmetic operator this grammar translates contains `<`, `>` or
 * `=`: a term is built from `+ - * /`, parentheses, numbers and column names.
 */
const termConjunctPattern =
  /^([\s\S]*?)\s*(<=|>=|<>|=|<|>)\s*('(?:[^']|'')*'|-?\d+(?:\.\d+)?)\s*(AND\s+|OR\s+|$)/i

/** The literal a term is compared with must be a number; a term is a number, not a character value. */
const termLiteralPattern = /^-?\d+(?:\.\d+)?$/

/**
 * The head of an `IN (SELECT ...)` test: one column, optional `NOT`, then `IN (`, anchored so it only
 * matches where a conjunct starts. `IN` is not one of {@link selectOperators}, so the two comparison
 * forms decline this shape and cannot claim it first.
 */
const subqueryHeadPattern = /^([A-Z][A-Z0-9_]*)\s+(NOT\s+)?IN\s*\(/i

/**
 * The head of a scalar comparison: one column, one comparison operator, then an opening parenthesis.
 * The two comparison forms above both insist on a literal after the operator, and a parenthesised
 * statement is not a literal, so neither can claim this shape first; the set test's head requires
 * `IN`, which is not one of {@link selectOperators}.
 */
const scalarHeadPattern = /^([A-Z][A-Z0-9_]*)\s*(<=|>=|<>|=|<|>)\s*\(/i

/**
 * How deep `IN (SELECT ...)` may nest. Every level is another complete read, so the bound is about
 * cost as much as about meaning: a statement nested deeper than this is refused by name rather than
 * answered with a read chain nobody bounded.
 */
const selectSubqueryDepthLimit = 3

function parseConjunct(text: string, depth: number) {
  const scalar = parseScalarConjunct(text, depth)
  if (scalar) return scalar
  const subquery = parseSubqueryConjunct(text, depth)
  if (subquery) return subquery
  const plain = parsePlainConjunct(text)
  if (plain) return plain
  return parseTermConjunct(text)
}

/**
 * The index of the `)` closing the `(` at `open`, or `undefined` when the text has none. Single quotes
 * are honoured so a literal holding a parenthesis cannot close the block early, and `''` inside such
 * a literal is an escaped quote rather than its end - a nested statement is cut out by counting, not
 * by a regular expression, because it carries clauses and parentheses of its own.
 */
function matchingParen(text: string, open: number): number | undefined {
  let depth = 0
  let inLiteral = false
  for (let index = open; index < text.length; index++) {
    const character = text[index]!
    if (inLiteral) {
      if (character !== "'") continue
      if (text[index + 1] === "'") {
        index++
        continue
      }
      inLiteral = false
      continue
    }
    if (character === "'") {
      inLiteral = true
      continue
    }
    if (character === "(") {
      depth++
      continue
    }
    if (character === ")") {
      depth--
      if (depth === 0) return index
      if (depth < 0) return undefined
    }
  }
  return undefined
}

/**
 * One `IN (SELECT ...)` test. The inner statement is parsed by this same grammar, which is what makes
 * the set well defined: it is the values of one column of one table, narrowed by a `WHERE` clause this
 * dialect understands - not arbitrary SQL and not a correlated reference.
 *
 * Everything this form cannot answer exactly is refused by name rather than dropped or approximated:
 * an inner statement this grammar does not translate, a projection that is not exactly one plain
 * column (a count or a calculated value in a set is a different question, and a limited or ordered
 * page is not a set), and nesting deeper than {@link selectSubqueryDepthLimit}. A shape that is not an
 * `IN (SELECT ...)` at all is not claimed here, so its reply stays the platform's own error - a
 * correlated inner statement, whose `WHERE` compares against the outer row, is outside this grammar
 * and is therefore left to the platform rather than answered as if it were a set.
 */
function parseSubqueryConjunct(text: string, depth: number) {
  const head = text.match(subqueryHeadPattern)
  if (!head) return undefined
  const open = head[0].length - 1
  const close = matchingParen(text, open)
  if (close === undefined) return undefined
  const inner = text.slice(open + 1, close).trim()
  if (!inner) return undefined
  if (depth >= selectSubqueryDepthLimit) {
    throw new Error(
      `TABLE_QUERY_SUBQUERY_DEPTH: IN (SELECT ...) is nested ${depth} deep, and this dialect reads at ` +
        `most ${selectSubqueryDepthLimit} levels. Ask the inner statement first and write the values ` +
        "it returned into an IN list, or narrow the statement."
    )
  }
  const select = parseGroupedTableSelect(inner, depth + 1)
  if (!select) {
    throw new Error(
      `TABLE_QUERY_SUBQUERY_UNSUPPORTED: the statement inside IN (...) is not one this dialect ` +
        `translates: ${inner.slice(0, 60)}. The inner statement is SELECT <one column> FROM <one ` +
        "table> with an optional WHERE clause."
    )
  }
  if (
    select.columns.length !== 1 ||
    select.readWholeRow ||
    select.aggregates.length > 0 ||
    select.expressions.length > 0 ||
    select.groupBy.length > 0 ||
    select.orderBy.length > 0 ||
    select.limit !== undefined
  ) {
    throw new Error(
      "TABLE_QUERY_SUBQUERY_PROJECTION: the statement inside IN (...) must select exactly one plain " +
        "column and nothing else - a set of values, not a count, not a calculated column, not a whole " +
        "row, not a grouping, not an order and not a limited page. Write SELECT <column> FROM <table> " +
        "[WHERE ...]."
    )
  }
  const column = head[1]!.toUpperCase()
  const after = text.slice(close + 1)
  const separatorMatch = after.match(/^(\s*)(AND\s+|OR\s+|$)/i)
  if (!separatorMatch) return undefined
  const separator = separatorMatch[2]!.trim().toUpperCase()
  return {
    condition: {
      column,
      negated: head[2] !== undefined,
      select,
      valueColumn: select.columns[0]!,
      text: `${column} ${head[2] !== undefined ? "NOT " : ""}IN (${inner})`
    } as SelectCondition,
    separator:
      separator === "AND"
        ? ("and" as const)
        : separator === "OR"
          ? ("or" as const)
          : ("end" as const),
    consumed: close + 1 + separatorMatch[0]!.length
  }
}

/**
 * One scalar comparison: `<column> <operator> (SELECT ...)`.
 *
 * The inner statement is parsed by this same grammar - so it is one table, one projection and a
 * `WHERE` clause this dialect understands, not arbitrary SQL - and it has to answer exactly one row:
 * one aggregate over no groups, or one plain column whose read returned one row. Everything else is
 * refused by name rather than answered: several rows (picking one would answer a different question),
 * no row (SQL's NULL, a three-valued rule this layer does not reproduce), a projection that is
 * neither one aggregate nor one plain column, and a limited or ordered page (a page is not a value).
 *
 * `IN (SELECT ...)` is not claimed here: `IN` is not one of {@link selectOperators}, so the set test's
 * own head pattern owns that shape, and this one requires an operator then `(SELECT`.
 */
function parseScalarConjunct(text: string, depth: number) {
  const head = text.match(scalarHeadPattern)
  if (!head) return undefined
  const open = head[0].length - 1
  // A parenthesised expression this grammar does not translate (`(A + B) * 2 > 3`, say) is not a
  // scalar subquery: only a statement inside the parentheses is claimed, and anything else is left
  // to the platform's own answer.
  if (!/^SELECT\b/i.test(text.slice(open + 1).replace(/^\s+/, ""))) return undefined
  const operator = selectOperators.find(([token]) => token === head[2])?.[1]
  if (!operator) return undefined
  const close = matchingParen(text, open)
  if (close === undefined) return undefined
  const inner = text.slice(open + 1, close).trim()
  if (!inner) return undefined
  if (depth >= selectSubqueryDepthLimit) {
    throw new Error(
      `TABLE_QUERY_SCALAR_DEPTH: a scalar subquery is nested ${depth} deep, and this dialect reads at ` +
        `most ${selectSubqueryDepthLimit} levels. Ask the inner statement first and write the value it ` +
        "returned into the comparison, or narrow the statement."
    )
  }
  const select = parseGroupedTableSelect(inner, depth + 1)
  if (!select) {
    throw new Error(
      `TABLE_QUERY_SCALAR_UNSUPPORTED: the statement inside the scalar subquery is not one this ` +
        `dialect translates: ${inner.slice(0, 60)}. The inner statement is SELECT <one column> or ` +
        "SELECT COUNT|SUM|MIN|MAX(<column>) FROM <one table> with an optional WHERE clause."
    )
  }
  // `readWholeRow` is true for an aggregate statement too - an aggregate reads the whole row to count
  // it, and `SELECT *` is carried as the single column `*` - so the projection, not that flag, is what
  // says which of the two shapes this is, and the wildcard is named rather than read as a column.
  const aggregate = select.aggregates[0]
  const oneAggregate =
    select.aggregates.length === 1 && select.columns.length === 0 && select.expressions.length === 0
  const oneColumn =
    select.columns.length === 1 &&
    select.columns[0] !== "*" &&
    select.aggregates.length === 0 &&
    select.expressions.length === 0
  if (!oneAggregate && !oneColumn) {
    throw new Error(
      "TABLE_QUERY_SCALAR_PROJECTION: the statement inside a scalar subquery must answer exactly one " +
        "value - one aggregate (COUNT, SUM, MIN, MAX) or one plain column - and nothing else. A whole " +
        "row, several columns, a calculated column and a mixed projection are all refused; a " +
        "comparison has one value on the right-hand side."
    )
  }
  if (select.orderBy.length > 0 || select.limit !== undefined) {
    throw new Error(
      "TABLE_QUERY_SCALAR_PAGE: the statement inside a scalar subquery must not be ordered or " +
        "limited: a page is not a value, and a `LIMIT 1` would hide the several rows this layer " +
        "refuses to choose between. Narrow the inner WHERE clause instead, or aggregate."
    )
  }
  const column = head[1]!.toUpperCase()
  const after = text.slice(close + 1)
  const separatorMatch = after.match(/^(\s*)(AND\s+|OR\s+|$)/i)
  if (!separatorMatch) return undefined
  const separator = separatorMatch[2]!.trim().toUpperCase()
  return {
    condition: {
      column,
      operator,
      select,
      valueColumn: oneAggregate ? aggregate!.column : select.columns[0]!,
      text: `${column} ${head[2]} (${inner})`
    } as SelectCondition,
    separator:
      separator === "AND"
        ? ("and" as const)
        : separator === "OR"
          ? ("or" as const)
          : ("end" as const),
    consumed: close + 1 + separatorMatch[0]!.length
  }
}

function parsePlainConjunct(text: string) {
  const match = text.match(conjunctPattern)
  if (!match) return undefined
  const operator = selectOperators.find(([token]) => token === match[2])?.[1]
  if (!operator) return undefined
  const literal = match[3]!
  const value = literal.startsWith("'") ? literal.slice(1, -1).replaceAll("''", "'") : literal
  // The reader bounds a filter value at 40 characters. Refusing here keeps the caller's reply the
  // original ADT error instead of a schema rejection about a request they never wrote.
  if (value.length > 40) return undefined
  const separator = match[4]!.trim().toUpperCase()
  return {
    condition: { column: match[1]!.toUpperCase(), operator, value } as SelectCondition,
    separator:
      separator === "AND"
        ? ("and" as const)
        : separator === "OR"
          ? ("or" as const)
          : ("end" as const),
    consumed: match[0].length
  }
}

/**
 * A comparison whose left side is an arithmetic term. Everything this form cannot decide exactly is
 * refused by name: a literal that is not a number, and a term that names no column (`1 + 1 = 2` is a
 * statement about nothing). A term that names a qualified column (`A.X * 2`) is not claimed at all -
 * resolving it needs the join, so the statement is left to the joined dialect.
 */
function parseTermConjunct(text: string) {
  const match = text.match(termConjunctPattern)
  if (!match) return undefined
  const operator = selectOperators.find(([token]) => token === match[2])?.[1]
  if (!operator) return undefined
  const node = parseArithmetic(match[1]!.trim())
  if (!node) return undefined
  // A bare column is the **plain** form's shape, which `parsePlainConjunct` owns. Reaching this point
  // with one means that form declined it - a literal longer than the reader accepts, say - and the
  // statement has to keep the platform's own error rather than be reinterpreted as arithmetic.
  if (node.kind === "column") return undefined
  const columns = arithmeticColumns(node)
  if (columns.some((column) => column.includes("."))) return undefined
  const term = match[1]!.trim()
  const literal = match[3]!
  const value = literal.startsWith("'") ? literal.slice(1, -1).replaceAll("''", "'") : literal
  if (!termLiteralPattern.test(value)) {
    throw new Error(
      `TABLE_QUERY_WHERE_EXPRESSION_LITERAL: ${term} ${match[2]} "${value}" compares a calculated ` +
        `number with a value that is not a number. Compare a term with a numeric literal, or write ` +
        `the whole predicate the way SAP would read it.`
    )
  }
  if (columns.length === 0) {
    throw new Error(
      `TABLE_QUERY_EXPRESSION_CONSTANT: "${term}" in the WHERE clause reads no column, so it would ` +
        `filter every row or none of them whatever the table holds. Name a column in the term.`
    )
  }
  const separator = match[4]!.trim().toUpperCase()
  return {
    condition: { text: term, node, operator, value } as SelectCondition,
    separator:
      separator === "AND"
        ? ("and" as const)
        : separator === "OR"
          ? ("or" as const)
          : ("end" as const),
    consumed: match[0].length
  }
}

function parseOrderBy(text: string): GroupedTableSelect["orderBy"] | undefined {
  const keys: GroupedTableSelect["orderBy"] = []
  let rest = text.trim()
  while (rest) {
    const key = rest.match(/^([A-Z][A-Z0-9_]*)(?:\s+(ASC|DESC))?\s*(?:,\s*|$)/i)
    if (!key || keys.length === selectOrderLimit) return undefined
    keys.push({
      column: key[1]!.toUpperCase(),
      direction: key[2]?.toUpperCase() === "DESC" ? "desc" : "asc"
    })
    rest = rest.slice(key[0].length).trim()
  }
  return keys.length > 0 ? keys : undefined
}

/**
 * Split a trailing `LIMIT <n>` off a statement's clause text.
 *
 * `LIMIT` is the one clause whose position is checked here rather than by a clause pattern, because
 * it is the only clause that may follow any other and must follow all of them. It is also the one
 * clause whose whole meaning is a single number, so a malformed one is refused by name instead of
 * being dropped: a statement whose limit was silently ignored answers a different question than the
 * one that was asked, and the difference is exactly the row count.
 *
 * The search runs on the literal-masked text so a value that happens to contain ` LIMIT 5 ` cannot be
 * mistaken for the clause, while the returned text is cut from the original so the literals survive.
 * It also counts parentheses: a `LIMIT` inside `IN (SELECT ...)` bounds the inner statement, not this
 * one, and reading it as this statement's limit would answer a different question - a different row
 * count, taken from the wrong statement.
 */
function splitTrailingLimit(text: string): { text: string; limit: number | undefined } {
  const at = topLevelLimitIndex(maskLiterals(text))
  if (at === undefined) return { text, limit: undefined }
  const argument = text.slice(at + "LIMIT".length).trim()
  if (!/^\d+$/.test(argument)) {
    throw new Error(
      "TABLE_QUERY_LIMIT_FORM: LIMIT takes one whole number of rows and must be the last clause of " +
        `the statement (found "LIMIT ${argument || "<no number>"}"). Write LIMIT <n> at the end.`
    )
  }
  return { text: text.slice(0, at).trim(), limit: Number(argument) }
}

/**
 * The index of the `LIMIT` keyword that belongs to this statement, or `undefined` when it has none.
 * A keyword inside parentheses belongs to the statement nested there, so the scan tracks depth.
 */
function topLevelLimitIndex(masked: string): number | undefined {
  let depth = 0
  for (let index = 0; index < masked.length; index++) {
    const character = masked[index]!
    if (character === "(") {
      depth++
      continue
    }
    if (character === ")") {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth > 0 || !/[A-Za-z]/.test(character)) continue
    if (/[A-Za-z0-9_]/.test(masked[index - 1] ?? "")) continue
    if (/^LIMIT\b/i.test(masked.slice(index))) return index
  }
  return undefined
}

/**
 * Parse the degraded-path grammar in full, or return `undefined` so the caller keeps the platform's
 * own error.
 *
 * Nothing here is translated "best effort": a statement this pattern cannot describe exactly is
 * refused, because the alternative is a query whose meaning in SAP differs from the SQL the caller
 * wrote. Parentheses are therefore absent on purpose - without them the grouping is unambiguous
 * (`OR` of `AND`s) and no precedence rule has to be invented.
 *
 * Statements the grammar *does* understand but cannot answer exactly (an ungrouped selected column, a
 * `SUM(*)`, a function that is not one of the four aggregates) throw a `TABLE_QUERY_*` error naming
 * the fix. The caller only reaches this parser after the platform's own path failed with the known
 * empty-HTML answer, so a descriptive refusal is strictly more useful than that error.
 *
 * `depth` counts how many `IN (SELECT ...)` levels enclose this statement. The parser is the same at
 * every level, so the inner statement is parsed by exactly the rules of the outer one.
 */
/**
 * Split a `WHERE` tail into its `WHERE` text and the optional `GROUP BY` / `ORDER BY` key lists,
 * looking only outside parentheses.
 *
 * A clause inside a parenthesis belongs to a nested statement - that is what a subquery is - so a
 * pattern that ignores parentheses cuts the outer `WHERE` in the middle of one: in
 * `WHERE ZAEHL = (SELECT ZAEHL FROM T001 ORDER BY ZAEHL)` that `ORDER BY` is the inner statement's,
 * and splitting there would decline a statement this grammar does translate. The keyword also has to
 * stand on its own, so that a column named `GROUPBY` is not a clause.
 *
 * Nothing else is skipped, deliberately: a *literal* that spells a clause keyword is still split there
 * and then refused by `parseGroupBy` / `parseOrderBy`, because a key list cannot end in the literal's
 * closing quote. That refusal is the intended outcome - this grammar never guesses which reading the
 * caller meant - and it is pinned by a test. Unbalanced parentheses are not judged here either: the
 * `WHERE` text is handed on as it stands and the conjunct parser refuses it.
 */
function splitWhereTail(
  tail: string
): { where: string; groupBy?: string; orderBy?: string } | undefined {
  let depth = 0
  let groupAt: { start: number; end: number } | undefined
  let orderAt: { start: number; end: number } | undefined
  for (let index = 0; index < tail.length; index += 1) {
    const character = tail[index]!
    if (character === "(") depth += 1
    else if (character === ")" && depth > 0) depth -= 1
    if (depth !== 0 || !/\s/.test(character)) continue
    const rest = tail.slice(index)
    const group = rest.match(/^\s+GROUP\s+BY\s+/i)
    const order = rest.match(/^\s+ORDER\s+BY\s+/i)
    if (group) {
      if (groupAt) return undefined
      groupAt = { start: index, end: index + group[0].length }
    } else if (order) {
      if (orderAt) return undefined
      orderAt = { start: index, end: index + order[0].length }
    }
  }
  // `ORDER BY` after `GROUP BY` is the only order SQL allows; anything else is not a shape to guess at.
  if (groupAt && orderAt && orderAt.start < groupAt.start) return undefined
  const boundary = groupAt?.start ?? orderAt?.start
  const where = (boundary === undefined ? tail : tail.slice(0, boundary))
    .replace(/^WHERE\s+/i, "")
    .trim()
  if (!where) return undefined
  const groupBy = groupAt
    ? tail.slice(groupAt.end, orderAt?.start ?? tail.length).trim()
    : undefined
  const orderBy = orderAt ? tail.slice(orderAt.end).trim() : undefined
  return {
    where,
    ...(groupBy === undefined ? {} : { groupBy }),
    ...(orderBy === undefined ? {} : { orderBy })
  }
}

export function parseGroupedTableSelect(sql: string, depth = 1): GroupedTableSelect | undefined {
  // Same finite-grammar approach as scoped-query.ts; never translate arbitrary SQL.
  const match = sql.match(/^\s*SELECT\s+([\s\S]*?)\s+FROM\s+([A-Z][A-Z0-9_]*)\s*([\s\S]*?)\s*$/i)
  if (!match) return undefined
  const projection = parseProjection(match[1]!.trim())
  if (!projection) return undefined
  const tableName = match[2]!.toUpperCase()
  const limitSplit = splitTrailingLimit(match[3]!.trim())
  const tail = limitSplit.text
  const groups: SelectCondition[][] = []
  let groupBy: string[] = []
  let orderBy: GroupedTableSelect["orderBy"] = []
  if (tail) {
    if (/^WHERE\b/i.test(tail)) {
      // The `WHERE` text and the optional `GROUP BY` / `ORDER BY` keys are separated by scanning for the
      // clause keywords, counting parentheses and skipping literals - not by a pattern. A pattern would
      // cut inside a parenthesis: in `WHERE ZAEHL = (SELECT ZAEHL FROM T001 ORDER BY ZAEHL)` that
      // `ORDER BY` belongs to the inner statement, and splitting there declines a statement this
      // grammar does translate. Literals are skipped for the same reason, so a string that contains
      // " ORDER BY " stays part of the `WHERE` text. A key list that really does start at the top level
      // is still refused by `parseGroupBy` / `parseOrderBy` when it is not a key list.
      const split = splitWhereTail(tail)
      if (!split) return undefined
      let rest = split.where
      if (split.groupBy !== undefined) {
        const keys = parseGroupBy(split.groupBy)
        if (!keys) return undefined
        groupBy = keys
      }
      if (split.orderBy !== undefined) {
        const keys = parseOrderBy(split.orderBy)
        if (!keys) return undefined
        orderBy = keys
      }
      if (!rest) return undefined
      for (;;) {
        if (groups.length === selectDisjunctLimit) return undefined
        const group: SelectCondition[] = []
        for (;;) {
          if (group.length === 8) return undefined
          const conjunct = parseConjunct(rest, depth)
          if (!conjunct) return undefined
          group.push(conjunct.condition)
          rest = rest.slice(conjunct.consumed).trim()
          if (conjunct.separator === "and") {
            // `... AND ` with nothing behind it looks like a truncated statement, not a filter.
            if (!rest) return undefined
            continue
          }
          if (conjunct.separator === "or" && !rest) return undefined
          break
        }
        groups.push(group)
        if (!rest) break
      }
    } else {
      const clauses = tail.match(
        /^(?:GROUP\s+BY\s+([A-Z][\s\S]*?)(?:\s+ORDER\s+BY\s+([\s\S]+))?|ORDER\s+BY\s+([\s\S]+))$/i
      )
      if (!clauses) return undefined
      if (clauses[1] !== undefined) {
        const keys = parseGroupBy(clauses[1])
        if (!keys) return undefined
        groupBy = keys
      }
      const orderText = clauses[1] !== undefined ? clauses[2] : clauses[3]
      if (orderText !== undefined) {
        const keys = parseOrderBy(orderText)
        if (!keys) return undefined
        orderBy = keys
      }
    }
  }
  const keyed = projection.aggregates.length > 0 || groupBy.length > 0
  if (keyed) {
    if (projection.selectAll) {
      throw new Error(
        "TABLE_QUERY_AGGREGATE_WITH_WILDCARD: * cannot be grouped or aggregated over - name the " +
          "grouping columns and the aggregate expressions you want."
      )
    }
    if (projection.expressions.length > 0) {
      throw new Error(
        "TABLE_QUERY_EXPRESSION_GROUPED: an arithmetic term is evaluated per row, and a grouped " +
          "answer has no single row to evaluate it on. Select the term without GROUP BY, or compute " +
          "it in SAP. Terms over grouped columns are not translated."
      )
    }
    // The grouped columns and the selected columns must be the same set. A selected column that is
    // not grouped has no single value per group (the answer would carry one arbitrary row's value),
    // and a grouped column that is not selected cannot be read off the answer at all.
    const selected = [...projection.columns].sort()
    const grouped = [...groupBy].sort()
    if (
      selected.length !== grouped.length ||
      selected.some((column, index) => column !== grouped[index])
    ) {
      throw new Error(
        "TABLE_QUERY_GROUP_BY_KEYS_MISMATCH: GROUP BY must name exactly the selected columns " +
          `(selected ${selected.length ? selected.join(", ") : "none"}, grouped ` +
          `${grouped.length ? grouped.join(", ") : "none"}). Select each grouping column and group ` +
          "by exactly those columns, or drop the GROUP BY."
      )
    }
  }
  return {
    tableName,
    columns: projection.columns,
    aggregates: projection.aggregates,
    expressions: projection.expressions,
    groupBy,
    readWholeRow: projection.selectAll || keyed,
    groups: groups.length > 0 ? groups : [[]],
    orderBy,
    limit: limitSplit.limit
  }
}

/**
 * Stable identity of one row within a projection, used to collapse rows that several `OR` branches
 * returned. Two rows that agree on every projected column are the same answer to the caller: the
 * reader returns no row identity, and the projected values are all the caller ever sees.
 */
export function branchRowKey(row: Record<string, unknown>, columns: string[]): string {
  // `SELECT *` is expanded by the reader, not by the parser, so the projection here is the row's own
  // key set. Keying on the literal "*" would collapse every row into one.
  const names = columns.length === 0 || columns.includes("*") ? Object.keys(row) : columns
  return JSON.stringify(
    [...names].sort().map((column) => [column, row[column] === undefined ? null : row[column]])
  )
}

/** One disjunct's read, as the caller's reader reports it. */
export interface GroupedReadBranch {
  rows: Record<string, unknown>[]
  /** True when the read hit the reader's row bound: this holds a sample, not the whole match set. */
  truncated: boolean
  /** The reader's own detail for this branch, passed through so no evidence is lost in the merge. */
  detail: Record<string, unknown>
}

/**
 * What the caller's reader reports for one inner statement of an `IN (SELECT ...)` test.
 *
 * The set is a set of values of one column, and every value has to be exact: a set that stopped at
 * the row bound is a sample, and a value this layer cannot compare under SAP's own rules would make
 * the membership test a comparison of printed text. Both are refusals, raised by the caller of
 * {@link readGroupedRows} because only it can read a table.
 */
export interface SubqueryRead {
  /** The inner column's values as the reader returned them, one per inner row, duplicates included. */
  values: string[]
  /** True when a read of the inner statement stopped at the row bound: the set is then a sample. */
  truncated: boolean
  /** The inner column's SAP type, which decides how the two sides are compared. */
  type: OperandType | undefined
}

export interface GroupedReadResult {
  rows: Record<string, unknown>[]
  /** How many reads the statement needed: one per disjunct. */
  disjuncts: number
  /**
   * Rows dropped because an earlier disjunct had already returned the same row. Non-zero only when
   * the read returned the whole row - see {@link GroupedReadResult.repeatedProjectedRows}.
   */
  deduplicatedRows: number
  /**
   * Rows kept whose projected values match an earlier row's.
   *
   * A partial projection cannot tell two rows apart - two different rows may agree on every selected
   * column - so nothing is dropped because of it, and this count reports the ambiguity instead of
   * quietly turning the caller's `OR` into a `DISTINCT`. Membership is exact either way: every
   * returned row matches the statement, and every matching row appears at least once.
   */
  repeatedProjectedRows: number
  /** Branch ordinals that hit the row bound and therefore hold a sample. */
  incompleteBranches: number[]
  orderByApplied: boolean
  /** True when the statement asked for aggregates or groups, so `rows` is its result, not a page. */
  aggregated: boolean
  /** How many groups the answer holds; 0 unless {@link GroupedReadResult.aggregated}. */
  groupCount: number
  /** Which expression published which column, so a caller can order the result without guessing. */
  aggregateColumns: Array<{ expression: string; column: string }>
  /** The same mapping for the arithmetic terms this service evaluated itself. */
  expressionColumns: Array<{ expression: string; column: string }>
  /**
   * The `WHERE` conditions this service decided rather than the reader: a term cannot be pushed into
   * the reader's structured filter, so which disjunct carried it and what it compared are published
   * for the same reason the aggregates and the terms are - the answer says what was asked.
   */
  whereExpressions: Array<{
    expression: string
    operator: SelectFilter["operator"]
    value: string
    disjunct: number
  }>
  /**
   * The `IN (SELECT ...)` tests this service decided. The set itself is not repeated here - it is the
   * inner statement's answer, which the caller asked for as part of one statement - but which test
   * ran, on which column, in which disjunct, with how many values, is published for the same reason
   * the terms are: the answer says what was asked.
   */
  whereSubqueries: Array<{
    condition: string
    column: string
    negated: boolean
    values: number
    disjunct: number
  }>
  /**
   * The scalar comparisons this service decided, one entry per comparison: which comparison ran, on
   * which column, with which operator, against which inner column, and the value the inner statement
   * answered. The value is repeated here because a scalar is one value - unlike a set, which the
   * mapping counts rather than repeats.
   */
  whereScalars: Array<{
    condition: string
    column: string
    operator: SelectFilter["operator"]
    value: string
    valueColumn: string | null
    disjunct: number
  }>
  /** The statement's own `LIMIT`, or null when it had none. */
  limit: number | null
}

/** The types whose values ABAP compares as numbers and the reader prints as numbers. */
const numericDataTypes = new Set([
  "INT1",
  "INT2",
  "INT4",
  "INT8",
  "DEC",
  "CURR",
  "QUAN",
  "ACCP",
  "PREC"
])

/**
 * The types whose values ABAP compares as characters. `NUMC`, `DATS` and `TIMS` are here on purpose:
 * they are printed as digits and still compared as characters, with trailing blanks ignored.
 */
const characterDataTypes = new Set([
  "CHAR",
  "NUMC",
  "DATS",
  "TIMS",
  "LCHR",
  "STRG",
  "SSTRING",
  "VARC",
  "CLNT",
  "UNIT",
  "CUKY",
  "LANG"
])

/**
 * How two values of a dictionary type are compared for equality.
 *
 * This is deliberately not the calculation type of `table-expression.ts`: a calculation type says how
 * ABAP would *compute* with a value, while this says how it would *compare* it. `NUMC` is the clearest
 * case - it calculates as a packed number and compares as characters, so treating it as a number would
 * put `'0007'` and `'7'` on different sides of a membership test.
 *
 * `float` and `undefined` both mean this layer cannot reproduce SAP's comparison: a binary float has
 * no exact decimal form, and a type in neither set (a raw field, a type this release does not carry)
 * has comparison rules this layer cannot state. Both are refused by name.
 */
function comparisonClass(type: OperandType): "numeric" | "character" | "float" | undefined {
  const dataType = type.dataType.toUpperCase()
  if (dataType === "FLTP" || dataType.startsWith("DF")) return "float"
  if (numericDataTypes.has(dataType)) return "numeric"
  if (characterDataTypes.has(dataType)) return "character"
  return undefined
}

/**
 * The key a value is compared by, or `undefined` when this layer cannot compare it exactly.
 *
 * A character value is keyed with its trailing blanks removed, which is what SAP does with character
 * fields of different declared lengths: `'A'` read from a `CHAR(10)` and `'A'` read from a `CHAR(4)`
 * are the same value even though the reader prints one with more blanks. A numeric value is keyed as
 * an exact decimal, so `'0007.50'` and `'7.5'` are one key and `'7.5'` and `'7.05'` are two. A value
 * that is not an exact decimal - an empty numeric field, a float in scientific notation - has no key,
 * and the caller refuses the statement rather than comparing printed text.
 */
function membershipKey(value: string, kind: "numeric" | "character"): string | undefined {
  if (kind === "character") return value.replace(/\s+$/, "")
  const match = value.trim().match(/^([+-]?)(\d+)(?:\.(\d*))?$/)
  if (!match) return undefined
  const whole = match[2]!.replace(/^0+(?=\d)/, "")
  const fraction = (match[3] ?? "").replace(/0+$/, "")
  const sign = match[1] === "-" && (whole !== "0" || fraction !== "") ? "-" : ""
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`
}

/** One resolved `IN (SELECT ...)` test: the set of keys, and the class they were keyed by. */
interface ResolvedSubquery {
  values: Set<string>
  kind: "numeric" | "character"
  valueColumn: string
}

/**
 * Read every inner statement of the statement's `IN (SELECT ...)` tests and key each value.
 *
 * This runs before the outer reads, so a test whose set cannot be established refuses the statement
 * without reading the outer table at all: nothing has been filtered when the caller reads the refusal.
 * Every value of the set has to be exact, because a value this layer cannot key would be compared as
 * text, and "the same printed text" is not "the same value" for a `NUMC`, a packed number or a
 * character field of another length.
 */
async function resolveSubqueries(
  select: Pick<GroupedTableSelect, "groups">,
  readSubquery: ((select: GroupedTableSelect) => Promise<SubqueryRead>) | undefined,
  columnTypes: ((column: string) => OperandType | undefined) | undefined
): Promise<Map<string, ResolvedSubquery>> {
  const resolved = new Map<string, ResolvedSubquery>()
  for (const group of select.groups) {
    for (const condition of subqueryConditions(group)) {
      if (resolved.has(condition.text)) continue
      if (!readSubquery)
        throw new Error(
          `TABLE_QUERY_SUBQUERY_UNAVAILABLE: ${condition.text} needs a read of ` +
            `${condition.select.tableName} to establish its set, and this path has no reader for a ` +
            "nested statement. Nothing was filtered."
        )
      const inner = await readSubquery(condition.select)
      if (inner.truncated)
        throw new Error(
          `TABLE_QUERY_SUBQUERY_INCOMPLETE: the set in ${condition.text} was read from ` +
            `${condition.select.tableName} and stopped at the row bound, so it is a sample of the ` +
            "values rather than the values. A row whose value is outside a sample is not a row whose " +
            "value is outside the set. Narrow the inner WHERE clause until its read completes. " +
            "Nothing was filtered."
        )
      if (!columnTypes)
        throw new Error(
          `TABLE_QUERY_SUBQUERY_TYPE_UNAVAILABLE: ${condition.text} needs the SAP type of ` +
            `${condition.column} and of ${condition.valueColumn} to compare them, and this path has ` +
            "no dictionary access. Nothing was filtered."
        )
      const outerType = columnTypes(condition.column)
      if (!outerType)
        throw new Error(
          `TABLE_QUERY_SUBQUERY_TYPE_UNKNOWN: the dictionary describes no typed field ` +
            `${condition.column} of the table being read, so how SAP compares it with ` +
            `${condition.valueColumn} is unknown. Check the field name.`
        )
      if (!inner.type)
        throw new Error(
          `TABLE_QUERY_SUBQUERY_TYPE_UNKNOWN: the dictionary describes no typed field ` +
            `${condition.valueColumn} of ${condition.select.tableName}, so how SAP compares it with ` +
            `${condition.column} is unknown. Check the field name.`
        )
      const outerClass = comparisonClass(outerType)
      const innerClass = comparisonClass(inner.type)
      if (outerClass === "float" || innerClass === "float")
        throw new Error(
          `TABLE_QUERY_SUBQUERY_FLOAT: ${condition.text} compares ` +
            `${outerClass === "float" ? condition.column : condition.valueColumn}, which is a ` +
            "floating-point field with no exact decimal value, so membership cannot be decided " +
            "exactly. Compare whole-number or packed-decimal fields instead."
        )
      if (!outerClass || !innerClass)
        throw new Error(
          `TABLE_QUERY_SUBQUERY_TYPE: ${condition.text} compares ${condition.column} ` +
            `(${outerType.dataType}) with ${condition.valueColumn} (${inner.type.dataType}), and ` +
            "this layer cannot state how SAP compares one of those types. Compare two character " +
            "fields, or two numeric fields, or write the statement the way SAP would read it."
        )
      if (outerClass !== innerClass)
        throw new Error(
          `TABLE_QUERY_SUBQUERY_TYPE: ${condition.text} compares ${condition.column} ` +
            `(${outerType.dataType}, compared as ${outerClass}) with ${condition.valueColumn} ` +
            `(${inner.type.dataType}, compared as ${innerClass}). SAP converts the two sides to a ` +
            "common type before comparing them, and this layer does not reproduce that conversion - " +
            "doing the comparison anyway would answer a different question. Compare fields of the " +
            "same kind."
        )
      const values = new Set<string>()
      for (const value of inner.values) {
        const key = membershipKey(value, innerClass)
        if (key === undefined)
          throw new Error(
            `TABLE_QUERY_SUBQUERY_VALUE: ${condition.valueColumn} of ` +
              `${condition.select.tableName} returned "${value.slice(0, 40)}", which is not an exact ` +
              `decimal number and so cannot be compared with ${condition.column}. An empty numeric ` +
              "field has no value this layer can place: narrow the inner statement so it does not " +
              "return one, or compare character fields."
          )
        values.add(key)
      }
      resolved.set(condition.text, { values, kind: innerClass, valueColumn: condition.valueColumn })
    }
  }
  return resolved
}

/**
 * Decide one `IN (SELECT ...)` test for one row: the row's own value, keyed the same way as the set's
 * values, either is or is not in the set.
 *
 * A value this layer cannot key refuses the whole statement instead of failing the row, for the same
 * reason a term does: a row that failed the predicate because it could not be read is
 * indistinguishable from a row that does not match, and the answer would silently be a subset.
 */
function matchesSubqueryCondition(
  condition: SelectSubqueryCondition,
  resolved: ResolvedSubquery,
  row: Record<string, unknown>
): boolean {
  const value = String(row[condition.column] ?? "")
  const key = membershipKey(value, resolved.kind)
  if (key === undefined)
    throw new Error(
      `TABLE_QUERY_SUBQUERY_VALUE: the row's ${condition.column} holds "${value.slice(0, 40)}", ` +
        `which is not an exact decimal number and so cannot be compared with ` +
        `${resolved.valueColumn}. An empty numeric field has no value this layer can place.`
    )
  return condition.negated !== resolved.values.has(key)
}

/**
 * What the caller's reader reports for the inner statement of a scalar comparison.
 *
 * The inner statement is answered by the same code that answers the outer one, so an aggregate has
 * already been computed when this arrives: `rows` is the inner statement's own answer - one row per
 * group - and `column` says which key inside that row holds the value.
 */
export interface ScalarRead {
  /** The inner statement's own rows: its groups, or the rows its single-column read returned. */
  rows: Record<string, unknown>[]
  /** True when a read of the inner statement stopped at the row bound: the value is then a sample. */
  truncated: boolean
  /** The key of the value inside `rows[0]`: an aggregate's derived name, or the selected column. */
  column: string
  /** The value's SAP type, which decides how the two sides are compared. */
  type: OperandType | undefined
}

/** One resolved scalar comparison: the value's key, the class it was keyed by, and the raw value. */
interface ResolvedScalar {
  key: string
  kind: "numeric" | "character"
  value: string
  valueColumn: string | null
}

/**
 * `COUNT` answers a whole number this layer computes; SAP's own type for it is `INT4`. Exported so the
 * caller that reads an inner statement types a count the same way this module does.
 */
export const countOperandType: OperandType = { calculationType: "i", dataType: "INT4", decimals: 0 }

/** How the inner column is named in a message or a refusal: `COUNT(*)` has no dictionary column. */
function scalarSourceName(condition: SelectScalarCondition): string {
  return condition.valueColumn ?? "COUNT(*)"
}

/**
 * Read every inner statement of the statement's scalar comparisons, check that each answered exactly
 * one value, and key that value.
 *
 * This runs before the outer reads, so a scalar that cannot be established refuses the statement
 * without reading the outer table at all: nothing has been filtered when the caller reads the refusal.
 * The comparison class comes from the dictionary types of both sides, exactly as the `IN (SELECT ...)`
 * test does - the two are the same comparison, one against a set and one against a single value - and
 * an ordering comparison on character values is refused here, because SAP's collation for ordering a
 * character field is not something this layer can state.
 */
async function resolveScalars(
  select: Pick<GroupedTableSelect, "groups">,
  readScalar: ((select: GroupedTableSelect) => Promise<ScalarRead>) | undefined,
  columnTypes: ((column: string) => OperandType | undefined) | undefined
): Promise<Map<string, ResolvedScalar>> {
  const resolved = new Map<string, ResolvedScalar>()
  for (const group of select.groups) {
    for (const condition of scalarConditions(group)) {
      if (resolved.has(condition.text)) continue
      if (!readScalar)
        throw new Error(
          `TABLE_QUERY_SCALAR_UNAVAILABLE: ${condition.text} needs a read of ` +
            `${condition.select.tableName} to establish its value, and this path has no reader for a ` +
            "nested statement. Nothing was filtered."
        )
      const inner = await readScalar(condition.select)
      const source = scalarSourceName(condition)
      if (inner.truncated)
        throw new Error(
          `TABLE_QUERY_SCALAR_INCOMPLETE: the value in ${condition.text} was read from ` +
            `${condition.select.tableName} and stopped at the row bound, so it is one value of a ` +
            "sample rather than the value of the statement. Narrow the inner WHERE clause until its " +
            "read completes, or aggregate in the inner statement. Nothing was filtered."
        )
      if (inner.rows.length === 0)
        throw new Error(
          `TABLE_QUERY_SCALAR_ROWS: the statement inside ${condition.text} answered no row, and a ` +
            "comparison with no value is unknown in SQL - a three-valued rule this layer does not " +
            "reproduce. Aggregate in the inner statement (COUNT answers 0 rather than nothing), or " +
            "narrow it so that it always answers one row. Nothing was filtered."
        )
      if (inner.rows.length > 1)
        throw new Error(
          `TABLE_QUERY_SCALAR_ROWS: the statement inside ${condition.text} answered ` +
            `${inner.rows.length} rows, so it has no single value; this layer will not pick one of ` +
            "them. Aggregate in the inner statement, or narrow its WHERE clause until one row is " +
            "left. Nothing was filtered."
        )
      if (!columnTypes)
        throw new Error(
          `TABLE_QUERY_SCALAR_TYPE_UNAVAILABLE: ${condition.text} needs the SAP type of ` +
            `${condition.column} and of ${source} to compare them, and this path has no dictionary ` +
            "access. Nothing was filtered."
        )
      const outerType = columnTypes(condition.column)
      if (!outerType)
        throw new Error(
          `TABLE_QUERY_SCALAR_TYPE_UNKNOWN: the dictionary describes no typed field ` +
            `${condition.column} of the table being read, so how SAP compares it with ${source} is ` +
            "unknown. Check the field name."
        )
      if (!inner.type)
        throw new Error(
          `TABLE_QUERY_SCALAR_TYPE_UNKNOWN: the dictionary describes no typed field ${source} of ` +
            `${condition.select.tableName}, so how SAP compares it with ${condition.column} is ` +
            "unknown. Check the field name."
        )
      const outerClass = comparisonClass(outerType)
      const innerClass = comparisonClass(inner.type)
      if (outerClass === "float" || innerClass === "float")
        throw new Error(
          `TABLE_QUERY_SCALAR_FLOAT: ${condition.text} compares ` +
            `${outerClass === "float" ? condition.column : source}, which is a floating-point field ` +
            "with no exact decimal value, so the comparison cannot be decided exactly. Compare " +
            "whole-number or packed-decimal fields instead."
        )
      if (!outerClass || !innerClass)
        throw new Error(
          `TABLE_QUERY_SCALAR_TYPE: ${condition.text} compares ${condition.column} ` +
            `(${outerType.dataType}) with ${source} (${inner.type.dataType}), and this layer cannot ` +
            "state how SAP compares one of those types. Compare two character fields, or two numeric " +
            "fields, or write the statement the way SAP would read it."
        )
      if (outerClass !== innerClass)
        throw new Error(
          `TABLE_QUERY_SCALAR_TYPE: ${condition.text} compares ${condition.column} ` +
            `(${outerType.dataType}, compared as ${outerClass}) with ${source} ` +
            `(${inner.type.dataType}, compared as ${innerClass}). SAP converts the two sides to a ` +
            "common type before comparing them, and this layer does not reproduce that conversion - " +
            "doing the comparison anyway would answer a different question. Compare fields of the " +
            "same kind."
        )
      if (innerClass === "character" && condition.operator !== "EQ" && condition.operator !== "NE")
        throw new Error(
          `TABLE_QUERY_SCALAR_ORDER: ${condition.text} orders a character value. SAP orders ` +
            "character fields by its own collation, which this layer cannot state, so only = and <> " +
            "are decided here. Compare numeric fields, or ask SAP for the ordering."
        )
      const value = String(inner.rows[0]![inner.column] ?? "")
      const key = membershipKey(value, innerClass)
      if (key === undefined)
        throw new Error(
          `TABLE_QUERY_SCALAR_VALUE: ${source} of ${condition.select.tableName} returned ` +
            `"${value.slice(0, 40)}", which is not an exact decimal number and so cannot be compared ` +
            `with ${condition.column}. An empty numeric value - what an aggregate over no row ` +
            "returns - has no value this layer can place: narrow the inner statement so it always " +
            "has one, or compare character fields."
        )
      resolved.set(condition.text, {
        key,
        kind: innerClass,
        value,
        valueColumn: condition.valueColumn
      })
    }
  }
  return resolved
}

/** The comparison an operator asks for, given an exact three-way comparison. */
function scalarComparison(comparison: number, operator: SelectFilter["operator"]): boolean {
  switch (operator) {
    case "EQ":
      return comparison === 0
    case "NE":
      return comparison !== 0
    case "LT":
      return comparison < 0
    case "LE":
      return comparison <= 0
    case "GT":
      return comparison > 0
    case "GE":
      return comparison >= 0
  }
}

/**
 * Decide one scalar comparison for one row, in the class the two sides were placed in.
 *
 * A character pair was limited to `=` and `<>` when the comparison was established, so the ordering
 * branch below is only ever reached by a numeric pair, compared exactly - never through a binary
 * float, which the resolution above refuses by name.
 */
function matchesScalarCondition(
  condition: SelectScalarCondition,
  resolved: ResolvedScalar,
  row: Record<string, unknown>
): boolean {
  const value = String(row[condition.column] ?? "")
  const key = membershipKey(value, resolved.kind)
  if (key === undefined)
    throw new Error(
      `TABLE_QUERY_SCALAR_VALUE: the row's ${condition.column} holds "${value.slice(0, 40)}", which ` +
        `is not an exact decimal number and so cannot be compared with ` +
        `${resolved.valueColumn ?? "COUNT(*)"}. An empty numeric field has no value this layer can ` +
        "place."
    )
  if (resolved.kind === "character")
    return condition.operator === "EQ" ? key === resolved.key : key !== resolved.key
  const comparison = compareDecimals(key, resolved.key)
  if (comparison === undefined)
    throw new Error(
      `TABLE_QUERY_SCALAR_VALUE: ${condition.column} or the value it is compared with is not an ` +
        "exact decimal number, so this layer cannot decide the comparison without a binary float."
    )
  return scalarComparison(comparison, condition.operator)
}

/**
 * The comparator behind both the statement's `ORDER BY` and the tool's own `sortColumns`. One
 * implementation, so the two ways of asking for an order cannot disagree.
 *
 * The comparison is lexical with numeric awareness over the reader's text representation, which is
 * not SAP's type-aware ordering (`NUMC` and `DATS` sort as characters here, not as numbers or
 * dates): a caller who needs SAP's ordering must get it from the platform, not from this degraded
 * path.
 */
function compareText(left: unknown, right: unknown): number {
  return String(left ?? "").localeCompare(String(right ?? ""), undefined, {
    numeric: true,
    sensitivity: "base"
  })
}

/** The reader answers an initial field as an empty string, so empty - not null - means "no value". */
function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === ""
}

/**
 * Sum the values the reader returned, or refuse. A sum is the one aggregate whose value the service
 * has to *compute* rather than pick, so it is the one that can be silently wrong.
 *
 * Every value is scaled to a common number of decimals and added as an integer: a sum of `1.1` and
 * `2.2` is `3.3`, not the `3.3000000000000003` that doubles would produce. A value that is not a
 * plain decimal, or an addend or total outside the range a double holds exactly (2^53), is refused
 * instead of approximated - a caller who gets a number from this tool must be able to trust it.
 */
function sumValues(expression: string, values: string[]): string {
  const parsed: Array<{ value: string; parts: NonNullable<ReturnType<typeof numericParts>> }> = []
  for (const value of values) {
    const parts = numericParts(value)
    if (!parts) {
      throw new Error(
        `TABLE_QUERY_AGGREGATE_NOT_NUMERIC: ${expression} met the value "${value.slice(0, 40)}", ` +
          "which is not a plain decimal number. Sum a field only when every value is numeric; " +
          "COUNT, MIN and MAX do not interpret the values at all."
      )
    }
    parsed.push({ value, parts })
  }
  if (parsed.length === 0) return ""
  const scale = Math.max(...parsed.map((entry) => entry.parts.fraction.length))
  let total = 0
  for (const entry of parsed) {
    const digits = entry.parts.integer + entry.parts.fraction.padEnd(scale, "0")
    const scaled = Number(digits) * entry.parts.sign
    if (!Number.isSafeInteger(scaled)) {
      throw new Error(
        `TABLE_QUERY_AGGREGATE_NOT_EXACT: the value "${entry.value.slice(0, 40)}" carries more ` +
          "digits than a double can add exactly (2^53). Sum a narrower window, or aggregate in SAP."
      )
    }
    total += scaled
    if (!Number.isSafeInteger(total)) {
      throw new Error(
        `TABLE_QUERY_AGGREGATE_NOT_EXACT: the running total left the exact range at ` +
          `"${entry.value.slice(0, 40)}". Sum a narrower window, or aggregate in SAP.`
      )
    }
  }
  return formatScaled(total, scale)
}

function aggregateValue(aggregate: SelectAggregate, members: Record<string, unknown>[]): unknown {
  const expression = aggregateExpression(aggregate)
  if (aggregate.fn === "COUNT" && aggregate.column === null) return members.length
  const column = aggregate.column!
  // Every aggregate except `COUNT(*)` ignores empty values, the way SQL ignores NULL: an initial
  // field is absent data, not a zero and not a value to compare.
  const present = members.filter((row) => !isEmptyValue(row[column]))
  if (aggregate.fn === "COUNT") return present.length
  if (aggregate.fn === "SUM") {
    return sumValues(
      expression,
      present.map((row) => String(row[column]))
    )
  }
  let best: unknown
  for (const row of present) {
    const value = row[column]
    if (best === undefined) {
      best = value
      continue
    }
    const comparison = compareText(value, best)
    if (aggregate.fn === "MIN" ? comparison < 0 : comparison > 0) best = value
  }
  return best === undefined ? "" : best
}

/**
 * Fold the merged rows into groups and aggregate each one.
 *
 * Groups appear in the order their first row appeared, which is the reader's own order and therefore
 * stable; `ORDER BY` (or the tool's `sortColumns`) is what turns that into a ranking.
 */
function aggregateRows(
  rows: Record<string, unknown>[],
  select: Pick<GroupedTableSelect, "columns" | "aggregates" | "groupBy">
): Record<string, unknown>[] {
  const grouped = new Map<string, Record<string, unknown>[]>()
  for (const row of rows) {
    const key = JSON.stringify(
      select.groupBy.map((column) => [column, isEmptyValue(row[column]) ? "" : String(row[column])])
    )
    const members = grouped.get(key)
    if (members) members.push(row)
    else grouped.set(key, [row])
  }
  // `COUNT(*)` over an empty match set is 0, not "no rows": the caller asked a question that has an
  // answer, and SQL agrees. Without `GROUP BY` there is exactly one group, empty or not.
  if (rows.length === 0 && select.groupBy.length === 0 && select.aggregates.length > 0) {
    grouped.set("[]", [])
  }
  return [...grouped.values()].map((members) => {
    const output: Record<string, unknown> = {}
    // Grouped columns hold the same value in every member, by construction of the key.
    for (const column of select.columns) output[column] = members[0]?.[column] ?? ""
    for (const aggregate of select.aggregates) {
      output[aggregateColumnName(aggregate)] = aggregateValue(aggregate, members)
    }
    return output
  })
}

/**
 * Run a grouped statement as one read per disjunct and merge the results.
 *
 * Four rules keep the merge from inventing an answer:
 *
 * - **Row identity.** Only a read that returned the whole row has one: `SELECT *` includes the key
 *   fields, so a row returned by two disjuncts is the same row. With a partial projection, identical
 *   projected values prove nothing, so such rows are counted as repeats and kept. Aggregate and
 *   `GROUP BY` statements always read the whole row for exactly this reason: without identity, a row
 *   matched by two overlapping branches would be counted twice.
 * - **Membership versus ordering.** Without `ORDER BY` the answer is a page of matching rows, and a
 *   disjunct that hit the row bound is reported through `incompleteBranches`. With `ORDER BY` the
 *   answer claims to be the top of an ordering, which a sample cannot support, so the statement is
 *   refused rather than answered with rows that are not the top.
 * - **Aggregates are exact or absent.** A count of a sample is a count of the sample, so any
 *   aggregate over a truncated read is refused instead of reported with a smaller number.
 * - **No invented values.** `SUM` refuses a value it cannot add exactly, and every aggregate ignores
 *   empty values rather than treating them as zero.
 */
export async function readGroupedRows(
  select: Pick<
    GroupedTableSelect,
    | "columns"
    | "aggregates"
    | "expressions"
    | "groupBy"
    | "readWholeRow"
    | "groups"
    | "orderBy"
    | "limit"
  >,
  readBranch: (filters: SelectFilter[]) => Promise<GroupedReadBranch>,
  rowBound?: number,
  /**
   * The SAP type of each column a term reads. Resolving it needs the dictionary, which this
   * function has no connection for, so the caller supplies it - and it is required in practice: with
   * a term in the statement and no way to type its operands, nothing is evaluated and the statement
   * is refused rather than computed under a guessed calculation rule.
   */
  columnTypes?: (column: string) => OperandType | undefined,
  /**
   * How to read the inner statement of an `IN (SELECT ...)` test. This function cannot read a table -
   * it only merges what it is handed - so the caller supplies the reader, exactly as it supplies the
   * branch reader. A statement with a set test and no reader for its inner statement is refused by
   * name rather than answered with the test dropped.
   */
  readSubquery?: (select: GroupedTableSelect) => Promise<SubqueryRead>,
  /**
   * How to read the inner statement of a scalar comparison. Supplied for the same reason as the set
   * test's reader, and it answers with the inner statement's own rows - an aggregate has already been
   * computed by the time it arrives - so this function can check that there is exactly one value.
   */
  readScalar?: (select: GroupedTableSelect) => Promise<ScalarRead>
): Promise<GroupedReadResult> {
  const keyed = select.aggregates.length > 0 || select.groupBy.length > 0
  // An `ORDER BY` column that is not projected would compare `undefined` with `undefined` for every
  // row: a sort that reports success while changing nothing is worse than a refusal, and the fix is
  // one word in the SELECT list. `SELECT *` needs no check - the reader expands it to every column -
  // and an aggregate statement compares against the columns it publishes.
  const outputColumns = groupedOutputColumns(select)
  const unprojected =
    select.readWholeRow && !keyed
      ? []
      : [...new Set(select.orderBy.map((key) => key.column))].filter(
          (column) => !outputColumns.includes(column)
        )
  if (unprojected.length > 0) {
    throw new Error(
      `TABLE_QUERY_ORDER_BY_COLUMN_NOT_SELECTED: ORDER BY ${unprojected.join(", ")} is not in the ` +
        `projection, so the rows carry nothing to compare. Add it to the SELECT list (or select *).`
    )
  }
  const fullRow = select.readWholeRow || keyed
  // Identity is taken over what the read actually returned. For a projection that is not the whole
  // row, that is the projection itself; for a whole-row read the key is the row's own column set, so
  // a grouped column must never shrink the identity to the grouped columns alone - two rows of one
  // group would collapse into one and `COUNT(*)` would undercount silently.
  const identityColumns = fullRow ? ["*"] : select.columns
  // The set of every `IN (SELECT ...)` test is established before the first outer read, so a test
  // whose set is a sample, untyped or uncomparable refuses the statement with nothing read yet.
  const subqueries = await resolveSubqueries(select, readSubquery, columnTypes)
  // A scalar comparison's value is established the same way and at the same point: before the first
  // outer read, so a comparison with no single value refuses the statement with nothing filtered yet.
  const scalars = await resolveScalars(select, readScalar, columnTypes)
  const rows: Record<string, unknown>[] = []
  const seen = new Set<string>()
  const incompleteBranches: number[] = []
  const incompleteTermBranches: number[] = []
  const incompleteSubqueryBranches: number[] = []
  const incompleteScalarBranches: number[] = []
  let deduplicatedRows = 0
  let repeatedProjectedRows = 0
  for (const [index, group] of select.groups.entries()) {
    // Only the comparisons the reader can express itself are pushed. A term is kept for this side:
    // pushing it is impossible (the reader's filter takes one column name), and dropping it would
    // return rows the statement excludes, so it is decided here - over the branch's own rows, and
    // only when that read was complete. An `IN (SELECT ...)` test and a scalar comparison are decided
    // here for the same reason: the reader has no set operator and cannot nest a read.
    const terms = termConditions(group)
    const tests = subqueryConditions(group)
    const values = scalarConditions(group)
    const branch = await readBranch(pushableFilters(group))
    if (branch.truncated) {
      incompleteBranches.push(index)
      if (terms.length > 0) incompleteTermBranches.push(index)
      if (tests.length > 0) incompleteSubqueryBranches.push(index)
      if (values.length > 0) incompleteScalarBranches.push(index)
    }
    const matched =
      terms.length === 0 && tests.length === 0 && values.length === 0
        ? branch.rows
        : branch.rows.filter(
            (row) =>
              terms.every((condition) => matchesTermCondition(condition, row, columnTypes)) &&
              tests.every((condition) =>
                matchesSubqueryCondition(condition, subqueries.get(condition.text)!, row)
              ) &&
              values.every((condition) =>
                matchesScalarCondition(condition, scalars.get(condition.text)!, row)
              )
          )
    for (const row of matched) {
      const key = branchRowKey(row, identityColumns)
      if (seen.has(key)) {
        if (fullRow) {
          deduplicatedRows++
          continue
        }
        repeatedProjectedRows++
      } else {
        seen.add(key)
      }
      rows.push(row)
    }
  }
  const bound = rowBound === undefined ? "the row bound" : `the ${rowBound}-row bound`
  // A test or a term in the `WHERE` clause is checked first: when one of these branches is a sample,
  // the local comparison filtered that sample and would report its matches as the statement's
  // matches, so nothing else about the statement can be answered either.
  if (incompleteSubqueryBranches.length > 0) {
    throw new Error(
      `TABLE_QUERY_WHERE_SUBQUERY_INCOMPLETE: an IN (SELECT ...) test is decided here, over the rows ` +
        `the read returned, but ${incompleteSubqueryBranches.length} of ${select.groups.length} ` +
        `read(s) stopped at ${bound} (branch${incompleteSubqueryBranches.length > 1 ? "es" : ""} ` +
        `${incompleteSubqueryBranches.join(", ")}). The matches of a sample are not the matches of ` +
        "the statement. Narrow the WHERE clause with a comparison the reader can push down (a plain " +
        "column comparison) until every read completes. Nothing was filtered."
    )
  }
  if (incompleteScalarBranches.length > 0) {
    throw new Error(
      `TABLE_QUERY_WHERE_SCALAR_INCOMPLETE: a scalar comparison is decided here, over the rows the ` +
        `read returned, but ${incompleteScalarBranches.length} of ${select.groups.length} read(s) ` +
        `stopped at ${bound} (branch${incompleteScalarBranches.length > 1 ? "es" : ""} ` +
        `${incompleteScalarBranches.join(", ")}). The matches of a sample are not the matches of the ` +
        "statement. Narrow the WHERE clause with a comparison the reader can push down (a plain " +
        "column comparison) until every read completes. Nothing was filtered."
    )
  }
  if (incompleteTermBranches.length > 0) {
    throw new Error(
      `TABLE_QUERY_WHERE_EXPRESSION_INCOMPLETE: a term in the WHERE clause is decided here, over ` +
        `the rows the read returned, but ${incompleteTermBranches.length} of ` +
        `${select.groups.length} read(s) stopped at ${bound} ` +
        `(branch${incompleteTermBranches.length > 1 ? "es" : ""} ` +
        `${incompleteTermBranches.join(", ")}). The matches of a sample are not the matches of the ` +
        `statement. Narrow the WHERE clause with a comparison the reader can push down (a plain ` +
        `column comparison) until every read completes. Nothing was filtered.`
    )
  }
  if (keyed && incompleteBranches.length > 0) {
    throw new Error(
      `TABLE_QUERY_AGGREGATE_INCOMPLETE: an aggregate describes the whole match set, but ` +
        `${incompleteBranches.length} of ${select.groups.length} read(s) stopped at ${bound} ` +
        `(branch${incompleteBranches.length > 1 ? "es" : ""} ${incompleteBranches.join(", ")}), so ` +
        `the count would be a count of the sample. Narrow the WHERE clause until every read ` +
        `completes. Nothing was aggregated.`
    )
  }
  if (!keyed && select.orderBy.length > 0 && incompleteBranches.length > 0) {
    throw new Error(
      `TABLE_QUERY_ORDER_BY_INCOMPLETE: ORDER BY describes the whole match set, but ` +
        `${incompleteBranches.length} of ${select.groups.length} read(s) stopped at ${bound} ` +
        `(branch${incompleteBranches.length > 1 ? "es" : ""} ${incompleteBranches.join(", ")}). ` +
        `Narrow the WHERE clause until every read completes, or sort the returned page with ` +
        `sortColumns. Nothing was ordered.`
    )
  }
  const result = keyed ? aggregateRows(rows, select) : rows
  // Terms are evaluated after the completeness refusals, so a statement that cannot be answered
  // completely is refused for that reason rather than for whatever its arithmetic happened to hit
  // first, and before the sort, so `ORDER BY` a derived column orders the values the caller sees.
  applyExpressions(result, select.expressions, columnTypes)
  // `ORDER BY` decides which rows the answer holds and `LIMIT` decides how many of them, so the sort
  // comes first: slicing before it would answer with the first rows read in whatever order the reader
  // happened to return them, which is the one order the caller explicitly did not ask for. `LIMIT`
  // bounds the answer, never the read, so the completeness refusals above still see the whole match
  // set and a limited answer over a sample is refused rather than trimmed.
  const ordered = select.orderBy.length > 0 ? sortRowsByColumns(result, select.orderBy) : result
  const limited = select.limit === undefined ? ordered : ordered.slice(0, select.limit)
  // A term reads columns it does not publish. They were read because the term needed them, and they
  // are dropped again so the answer holds exactly what the statement selected - the same set the
  // same projection would hold without the term. This covers a term in the `WHERE` clause too: its
  // operands are evidence for the predicate, and the statement selected them nowhere.
  if (!keyed && !select.readWholeRow && selectEvaluatesTerms(select)) {
    const published = new Set(groupedOutputColumns(select))
    for (const row of limited)
      for (const column of Object.keys(row)) if (!published.has(column)) delete row[column]
  }
  return {
    rows: limited,
    disjuncts: select.groups.length,
    deduplicatedRows,
    repeatedProjectedRows,
    incompleteBranches,
    aggregated: keyed,
    groupCount: keyed ? limited.length : 0,
    aggregateColumns: select.aggregates.map((aggregate) => ({
      expression: aggregateExpression(aggregate),
      column: aggregateColumnName(aggregate)
    })),
    expressionColumns: select.expressions.map((expression) => ({
      expression: expression.text,
      column: expression.column
    })),
    whereExpressions: whereExpressions(select),
    whereSubqueries: whereSubqueries(select, subqueries),
    whereScalars: whereScalars(select, scalars),
    limit: select.limit ?? null,
    orderByApplied: select.orderBy.length > 0
  }
}

/**
 * Decide one `WHERE` term for one row: compute it exactly and compare it with the literal.
 *
 * The comparison runs over decimal text, never through a binary float (see `compareDecimals`). A
 * value the evaluator cannot compute exactly - a floating point operand, a packed division, a text
 * that is not a number - refuses the whole statement rather than dropping the row: a row that fails
 * the predicate because it could not be read would be indistinguishable from a row that does not
 * match, and the answer would silently be a subset.
 */
function matchesTermCondition(
  condition: SelectTermCondition,
  row: Record<string, unknown>,
  columnTypes?: (column: string) => OperandType | undefined
): boolean {
  const value = evaluateArithmetic(condition.node, (column) => {
    if (!columnTypes)
      throw new Error(
        `TABLE_QUERY_EXPRESSION_TYPE_UNAVAILABLE: ${condition.text} in the WHERE clause needs the ` +
          `SAP type of ${column} to pick a calculation type, and this path has no dictionary access. ` +
          "Nothing was filtered."
      )
    const type = columnTypes(column)
    if (!type)
      throw new Error(
        `TABLE_QUERY_EXPRESSION_TYPE_UNKNOWN: the dictionary describes no typed field ${column} of ` +
          `the table being read (or names a type this layer cannot place), so the calculation type ` +
          `for ${condition.text} is unknown. Check the field name.`
      )
    return { text: String(row[column] ?? ""), type }
  })
  const comparison = compareDecimals(value, condition.value)
  if (comparison === undefined)
    throw new Error(
      `TABLE_QUERY_WHERE_EXPRESSION_VALUE: ${condition.text} evaluated to "${value.slice(0, 40)}", ` +
        `which is not a plain decimal number, so it cannot be compared with ${condition.value}.`
    )
  switch (condition.operator) {
    case "EQ":
      return comparison === 0
    case "NE":
      return comparison !== 0
    case "LT":
      return comparison < 0
    case "LE":
      return comparison <= 0
    case "GT":
      return comparison > 0
    case "GE":
      return comparison >= 0
  }
}

/**
 * Add one derived column per arithmetic term to every row.
 *
 * Each term reads the row's own values - the same text the caller is looking at - and the operand
 * types come from the dictionary, so the calculation type ABAP would use is the one used here. The
 * evaluator is exact or it refuses; a row it cannot compute fails the whole statement, because an
 * answer whose derived column is sometimes blank would be read as "no value" rather than "not
 * computed".
 */
function applyExpressions(
  rows: Record<string, unknown>[],
  expressions: SelectExpression[],
  columnTypes?: (column: string) => OperandType | undefined
): void {
  if (expressions.length === 0) return
  for (const expression of expressions) {
    for (const column of arithmeticColumns(expression.node)) {
      if (!columnTypes)
        throw new Error(
          `TABLE_QUERY_EXPRESSION_TYPE_UNAVAILABLE: ${expression.text} needs the SAP type of ` +
            `${column} to pick a calculation type, and this path has no dictionary access. ` +
            "Nothing was computed."
        )
      if (!columnTypes(column))
        throw new Error(
          `TABLE_QUERY_EXPRESSION_TYPE_UNKNOWN: the dictionary describes no typed field ${column} ` +
            `of the table being read (or names a type this layer cannot place), so the calculation ` +
            `type for ${expression.text} is unknown. Check the field name.`
        )
    }
  }
  for (const row of rows) {
    for (const expression of expressions) {
      row[expression.column] = evaluateArithmetic(expression.node, (column) => {
        const type = columnTypes?.(column)
        if (!type) return undefined
        return { text: String(row[column] ?? ""), type }
      })
    }
  }
}

/**
 * Order rows by a key list, using the same comparator as the tool's own `sortColumns` input so the
 * two ways of asking for an order cannot disagree.
 */
export function sortRowsByColumns(
  rows: Record<string, unknown>[],
  sorts: Array<{ column: string; direction: "asc" | "desc" }>
): Record<string, unknown>[] {
  if (!sorts.length) return rows
  return [...rows].sort((left, right) => {
    for (const sort of sorts) {
      const comparison = compareText(left[sort.column], right[sort.column])
      if (comparison) return sort.direction === "asc" ? comparison : -comparison
    }
    return 0
  })
}

/**
 * Every table a SELECT reads from, taken from a **string-masked** statement, or `undefined` when
 * the tables cannot be enumerated statically.
 *
 * The caller must treat `undefined` as a rejection. A statement whose tables cannot be named cannot
 * be allowlisted, and guessing one — or falling back to "the first FROM" — is exactly how a read
 * path bypasses an allowlist. The statement is rejected without reaching SAP instead.
 *
 * `undefined` therefore covers: no `FROM` at all, a target that is not an identifier (a host
 * variable or dynamic table name), and a comma-separated table list, whose members this grammar
 * cannot enumerate with confidence. Explicit `JOIN` targets and subqueries are enumerated.
 */
export function selectedTableNames(maskedSql: string): string[] | undefined {
  const names = new Set<string>()
  const keywords = /\b(?:FROM|JOIN)\b/gi
  let match: RegExpExecArray | null
  while ((match = keywords.exec(maskedSql)) !== null) {
    let at = match.index + match[0].length
    while (at < maskedSql.length && /\s/.test(maskedSql[at]!)) at++
    const rest = maskedSql.slice(at)
    // `FROM ( SELECT ... )`: the derived table carries no name of its own, and the inner FROM is
    // matched by a later iteration of this same scan.
    if (rest.startsWith("(")) continue
    const identifier = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)/)
    if (!identifier) return undefined
    names.add(identifier[1]!.toUpperCase())
    const tail = rest.slice(identifier[0].length)
    const clause = tail.search(/\b(?:WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|INTO|UP\s+TO|ENDSELECT)\b/i)
    const scope = clause >= 0 ? tail.slice(0, clause) : tail
    let depth = 0
    for (const character of scope) {
      if (character === "(") depth++
      else if (character === ")") depth--
      else if (character === "," && depth === 0) return undefined
    }
  }
  return names.size > 0 ? [...names].sort() : undefined
}

/* ------------------------------------------------------------------------------------------------
 * Joined statements (OP1-7)
 *
 * The degraded path has always answered one table, because the native ADT preview is not served on
 * this release and the RFC reader takes one table at a time. Ops questions are rarely single-table -
 * "which jobs produced no spool", "which IDocs belong to which partner" - so this section adds a
 * bounded join to the same finite grammar: at most {@link joinTableLimit} allowlisted tables, an
 * equality `ON` clause per join, and every remaining comparison written as
 * `WHERE <alias>.<column> <op> <literal>`.
 *
 * Four rules keep a join from answering a different question than the caller asked:
 *
 * - **Qualification is mandatory.** Every column reference is written `<alias>.<column>`. An
 *   unqualified name would have to be resolved against two table definitions to know which side the
 *   comparison belongs to, and a predicate placed on the wrong side of an outer join is a different
 *   answer - so such a statement is refused instead of guessed at.
 * - **Predicates are pushed down, never re-implemented.** A `WHERE` conjunct is handed to the reader
 *   of the table it names, so SAP's own type-aware comparison decides it. The service compares only
 *   join keys, and those are text comparisons over the reader's own representation.
 * - **`WHERE` never touches the optional side of an outer join.** In SQL such a predicate filters the
 *   joined result rather than the optional read, which is exactly what a pushed-down filter cannot
 *   express; the statement is refused and the caller is told to move the condition into `ON`, where
 *   pushing it down is right.
 * - **A capped read is reported, never silently joined.** A side that hits the row bound turns the
 *   merge into a sample of a join, so the answer carries `truncated` plus the aliases involved, and an
 *   aggregate or `ORDER BY` over such a merge is refused outright.
 * ---------------------------------------------------------------------------------------------- */

/** How many tables one joined statement may read; every extra table is another bounded read. */
const joinTableLimit = 3
/** How many probe keys one `ON` clause may carry. */
const joinOnLimit = 8
/** Keywords that may never be read as an alias. */
const joinKeywords = new Set([
  "AS",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "CROSS",
  "OUTER",
  "JOIN",
  "ON",
  "WHERE",
  "GROUP",
  "ORDER"
])
/** `ALIAS.COLUMN`, the only column reference a joined statement may contain. */
const qualifiedPattern = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/
const qualifiedJoinPattern = /^([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)/

/** One `ON` condition: the join key of the table being introduced, and what it must equal. */
export interface JoinOnCondition {
  left: { alias: string; column: string }
  right: { alias: string; column: string } | { literal: string }
}

/**
 * The join kinds this grammar translates.
 *
 * `left`, `right` and `full` are the outer joins: each keeps the rows of one side - or of both, for
 * `full` - that the other side has no match for, and writes the reader's own empty value into the
 * columns of the absent side. Which side that is decides where a `WHERE` predicate stays truthful,
 * so it is a property of the join and not of the reading of it. `cross` pairs every row with every
 * row and therefore carries no `ON` clause at all.
 */
export type JoinType = "inner" | "left" | "right" | "full" | "cross"

export interface JoinedTableRef {
  tableName: string
  /** The name every column reference of this table uses; the alias, or the table name itself. */
  alias: string
  /** `inner` for the first table, which no join introduces. */
  joinType: JoinType
  on: JoinOnCondition[]
}

export interface JoinWhereCondition {
  alias: string
  column: string
  operator: SelectFilter["operator"]
  value: string
}

export interface JoinedTableSelect {
  tables: JoinedTableRef[]
  /** Published names, qualified as `ALIAS.COLUMN`, in the order the caller wrote them. */
  columns: string[]
  aggregates: SelectAggregate[]
  /**
   * Arithmetic terms over qualified columns, evaluated by this service on the joined rows.
   *
   * A derived column is named `EXPR_1`, `EXPR_2` ... in projection order. That name is not qualified,
   * and every selected column here is, so the two namespaces cannot collide by construction.
   */
  expressions: SelectExpression[]
  /** Qualified names, exactly the selected columns when the statement is keyed. */
  groupBy: string[]
  /** Conjuncts only: a join never merges `OR` branches, so each is one read per table. */
  where: JoinWhereCondition[]
  orderBy: { column: string; direction: "asc" | "desc" }[]
  /** The statement's own `LIMIT`, or `undefined` when it had none; applied after `ORDER BY`. */
  limit?: number | undefined
}

/** Split `ALIAS.COLUMN` into its parts, or `undefined` when it is not a qualified reference. */
function splitQualified(text: string): { alias: string; column: string } | undefined {
  const match = text.match(qualifiedPattern)
  if (!match) return undefined
  const alias = match[1]!.toUpperCase()
  const column = match[2]!.toUpperCase()
  if (!/^[A-Z][A-Z0-9_]{0,29}$/.test(column)) return undefined
  return { alias, column }
}

/**
 * Blank every string literal, keeping all offsets. Clause boundaries are then searched on the masked
 * text, so a value that contains ` WHERE ` or ` ORDER BY ` cannot split a statement in the wrong place.
 */
function maskLiterals(text: string): string {
  let result = ""
  let inString = false
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!
    if (character === "'") {
      if (inString && text[index + 1] === "'") {
        result += "  "
        index++
        continue
      }
      inString = !inString
      result += " "
      continue
    }
    result += inString ? " " : character
  }
  return result
}

/** Where the table list ends and `WHERE`/`GROUP BY`/`ORDER BY` begin. */
function splitJoinTail(text: string): { from: string; tail: string } | undefined {
  const match = maskLiterals(text).match(/\b(?:WHERE|GROUP\s+BY|ORDER\s+BY)\b/i)
  if (!match) return { from: text.trim(), tail: "" }
  const from = text.slice(0, match.index!).trim()
  if (!from) return undefined
  return { from, tail: text.slice(match.index!).trim() }
}

/** A `FROM`/`JOIN` target: the table name plus the alias its column references must use. */
function parseJoinTableRef(
  text: string
): { tableName: string; alias: string; consumed: number } | undefined {
  const match = text.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/i)
  if (!match) return undefined
  const tableName = match[1]!.toUpperCase()
  const candidate = match[2]?.toUpperCase()
  const named = candidate !== undefined && !joinKeywords.has(candidate)
  const alias = named ? candidate : tableName
  if (!/^[A-Z][A-Z0-9_]{0,29}$/.test(tableName) || !/^[A-Z][A-Z0-9_]{0,29}$/.test(alias))
    return undefined
  return { tableName, alias, consumed: named ? match[0]!.length : match[1]!.length }
}

/** The `ON` conditions of one join, ending at the next join keyword or at the end of the list. */
function parseJoinOn(
  text: string,
  alias: string,
  previous: string[],
  joinType: JoinType
): { conditions: JoinOnCondition[]; rest: string } | undefined {
  const pattern =
    /^([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\s*(<=|>=|<>|=|<|>)\s*([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*|'(?:[^']|'')*'|-?\d+(?:\.\d+)?)/i
  const conditions: JoinOnCondition[] = []
  let rest = text.trim()
  while (rest) {
    if (conditions.length === joinOnLimit) return undefined
    const match = rest.match(pattern)
    if (!match) return undefined
    const left = splitQualified(match[1]!)
    if (!left) return undefined
    const operator = match[2]!
    if (operator !== "=") {
      throw new Error(
        `TABLE_QUERY_JOIN_ON_OPERATOR: ON ${left.alias}.${left.column} ${operator} ... is a range, ` +
          "not a join key. ON takes equality between two columns (or between a column and a " +
          "literal); put a range comparison in WHERE."
      )
    }
    const target = match[3]!
    // The condition may be written either way round; the table this join introduces is the probe
    // side either way.
    const columnRight = splitQualified(target)
    if (columnRight) {
      const swapped = left.alias !== alias && columnRight.alias === alias
      const probe = swapped ? columnRight : left
      const other = swapped ? left : columnRight
      if (probe.alias !== alias)
        throw new Error(
          `TABLE_QUERY_JOIN_ON_ALIAS: ON ${match[1]} = ${target} must relate ${alias} to a table ` +
            `joined before it (${previous.join(", ")}).`
        )
      if (!previous.includes(other.alias))
        throw new Error(
          `TABLE_QUERY_JOIN_ON_ALIAS: ON ${match[1]} = ${target} references ${other.alias}, which ` +
            `is neither ${alias} nor a table joined before it (${previous.join(", ")}).`
        )
      conditions.push({ left: probe, right: other })
    } else {
      const literal = target.startsWith("'") ? target.slice(1, -1).replaceAll("''", "'") : target
      if (literal.length > 40) return undefined
      // A literal in ON is a condition a pair must satisfy to exist, so it can only be applied to
      // the read of a table whose rows this join is free to drop. Which side that is depends on the
      // join: INNER and LEFT drop none of the tables joined before them, RIGHT keeps the table it
      // introduces and drops the earlier ones, and FULL keeps both. Applying one to a preserved
      // read would delete the very rows the join exists to keep - a wrong answer, not a refusal.
      if (joinType === "full")
        throw new Error(
          `TABLE_QUERY_JOIN_ON_ALIAS: ON ${match[1]} = ${target} would apply a literal condition ` +
            `to one side of a FULL JOIN of ${alias}, which keeps the rows of both sides - so ` +
            "neither read may be filtered by it. A WHERE conjunct cannot express it either. " +
            "Compare two columns in ON, or ask SAP."
        )
      if (joinType === "right" && !previous.includes(left.alias))
        throw new Error(
          `TABLE_QUERY_JOIN_ON_ALIAS: ON ${match[1]} = ${target} must name a table joined before ` +
            `this RIGHT JOIN (${previous.join(", ")}). ${alias} keeps its rows whether or not the ` +
            "condition holds, so a literal naming it would delete the rows this join exists to " +
            "keep; write it in WHERE instead, where a conjunct on the preserved side is applied " +
            "to that read."
        )
      if (joinType !== "right" && left.alias !== alias)
        throw new Error(
          `TABLE_QUERY_JOIN_ON_ALIAS: ON ${match[1]} = ${target} must name the table this join ` +
            `introduces (${alias}) on the left of the comparison.`
        )
      conditions.push({ left, right: { literal } })
    }
    rest = rest.slice(match[0].length)
    const and = rest.match(/^\s+AND\s+([\s\S]*)$/i)
    if (and) {
      rest = and[1]!.trim()
      if (!rest) return undefined
      continue
    }
    if (/^\s*$/.test(rest)) return { conditions, rest: "" }
    if (/^\s+(?:INNER|LEFT|RIGHT|FULL|CROSS|JOIN)\b/i.test(rest))
      return { conditions, rest: rest.trim() }
    return undefined
  }
  return conditions.length > 0 ? { conditions, rest: "" } : undefined
}

/** The whole table list, with the join that introduces each table after the first. */
function parseJoinedTables(text: string): JoinedTableRef[] | undefined {
  const first = parseJoinTableRef(text)
  if (!first) return undefined
  const tables: JoinedTableRef[] = [
    { tableName: first.tableName, alias: first.alias, joinType: "inner", on: [] }
  ]
  let rest = text.slice(first.consumed).trim()
  while (rest) {
    if (tables.length === joinTableLimit) {
      throw new Error(
        `TABLE_QUERY_JOIN_TABLE_LIMIT: a joined statement reads at most ${joinTableLimit} tables, ` +
          "because every table is another bounded read. Split the question, or ask SAP."
      )
    }
    const join = rest.match(
      /^(INNER\s+|LEFT\s+(?:OUTER\s+)?|RIGHT\s+(?:OUTER\s+)?|FULL\s+(?:OUTER\s+)?|CROSS\s+)?JOIN\b/i
    )
    if (!join) return undefined
    const keyword = (join[1] ?? "").trim().toUpperCase()
    const joinType: JoinType = keyword.startsWith("LEFT")
      ? "left"
      : keyword.startsWith("RIGHT")
        ? "right"
        : keyword.startsWith("FULL")
          ? "full"
          : keyword.startsWith("CROSS")
            ? "cross"
            : "inner"
    const target = parseJoinTableRef(rest.slice(join[0].length).trim())
    if (!target) return undefined
    const afterTarget = rest.slice(join[0].length).trim().slice(target.consumed).trim()
    if (joinType === "cross") {
      // A cross join is the statement that deliberately pairs every row with every row, so an `ON`
      // clause here is not a missing key but a contradiction: the caller asked for both "pair
      // everything" and "pair only what matches". Guessing which one was meant would answer a
      // different question than the one written, so it is refused and the fix is named.
      if (/^ON\b/i.test(afterTarget)) {
        throw new Error(
          `TABLE_QUERY_JOIN_CROSS_ON: CROSS JOIN ${target.tableName} carries an ON clause, but a ` +
            "cross join has no key - it pairs every row of both tables. Drop the ON clause, or " +
            "write INNER JOIN ... ON if only matching rows are wanted."
        )
      }
      tables.push({ tableName: target.tableName, alias: target.alias, joinType, on: [] })
      rest = afterTarget
      continue
    }
    if (!/^ON\b/i.test(afterTarget)) {
      throw new Error(
        `TABLE_QUERY_JOIN_ON_MISSING: the join of ${target.tableName} has no ON clause, so the ` +
          "statement would pair every row with every row. Write ON <alias>.<column> = " +
          "<alias>.<column>."
      )
    }
    const parsed = parseJoinOn(
      afterTarget.replace(/^ON\b/i, "").trim(),
      target.alias,
      tables.map((table) => table.alias),
      joinType
    )
    if (!parsed || parsed.conditions.length === 0) return undefined
    tables.push({
      tableName: target.tableName,
      alias: target.alias,
      joinType,
      on: parsed.conditions
    })
    rest = parsed.rest
  }
  return tables
}

/** The projection of a joined statement: qualified columns and the four supported aggregates. */
function parseJoinProjection(
  text: string,
  aliases: string[]
):
  | { columns: string[]; aggregates: SelectAggregate[]; expressions: SelectExpression[] }
  | undefined {
  const items = text.split(/\s*,\s*/)
  if (items.length === 0) return undefined
  const columns: string[] = []
  const aggregates: SelectAggregate[] = []
  const terms: Array<{ text: string; node: ArithmeticNode }> = []
  const qualify = (reference: string, item: string): string => {
    const split = splitQualified(reference)
    if (!split)
      throw new Error(
        `TABLE_QUERY_JOIN_COLUMN_UNQUALIFIED: ${item} is not written as <alias>.<column>. In a ` +
          `joined statement every column reference names its table (aliases: ${aliases.join(", ")}), ` +
          "because a comparison on the wrong side of a join is a different answer."
      )
    if (!aliases.includes(split.alias))
      throw new Error(
        `TABLE_QUERY_JOIN_ALIAS_UNKNOWN: ${reference} names ${split.alias}, which is not a table in ` +
          `this statement (aliases: ${aliases.join(", ")}).`
      )
    return `${split.alias}.${split.column}`
  }
  for (const item of items) {
    if (item === "*") {
      throw new Error(
        "TABLE_QUERY_JOIN_WILDCARD: * has no meaning in a joined statement - name each column as " +
          "<alias>.<column>, so the answer says which table every value came from."
      )
    }
    const aggregate = item.match(
      /^(COUNT|SUM|MIN|MAX)\s*\(\s*(\*|[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\s*\)$/i
    )
    if (aggregate) {
      const fn = aggregate[1]!.toUpperCase() as AggregateFunction
      const argument = aggregate[2]!
      if (argument === "*" && fn !== "COUNT") {
        throw new Error(
          `TABLE_QUERY_AGGREGATE_ARGUMENT: ${fn}(*) has no meaning - ${fn} needs a column, and only ` +
            `COUNT may count whole rows.`
        )
      }
      aggregates.push({
        fn,
        column: argument === "*" ? null : qualify(argument, item)
      })
      continue
    }
    const call = item.match(projectionFunctionPattern)
    if (call) {
      throw projectionFunctionRefusal(item, call[1]!.toUpperCase())
    }
    // An arithmetic term over the joined tables' own columns, written with every reference qualified
    // (`A.ZAEHL / 2`). A term is evaluated on the joined row, so its operands are qualified the same
    // way every other reference is, and each one is checked against the aliases of this statement.
    const node = parseArithmetic(item)
    if (node && node.kind !== "column") {
      for (const reference of arithmeticColumns(node)) qualify(reference, item)
      terms.push({ text: item, node })
      continue
    }
    columns.push(qualify(item, item))
  }
  if (new Set(columns).size !== columns.length) return undefined
  const names = aggregates.map(aggregateColumnName)
  if (new Set(names).size !== names.length) {
    throw new Error(
      "TABLE_QUERY_AGGREGATE_DUPLICATE: the same aggregate expression was selected twice, so one " +
        "published column would overwrite the other."
    )
  }
  const shadowed = names.filter((name) => columns.includes(name))
  if (shadowed.length > 0) {
    throw new Error(
      `TABLE_QUERY_AGGREGATE_SHADOWED: ${shadowed.join(", ")} is both a selected column and the ` +
        `column an aggregate publishes; rename the selected column out of the way.`
    )
  }
  // A projection that reads no column at all would publish one constant for every row.
  if (
    terms.length > 0 &&
    columns.length === 0 &&
    aggregates.length === 0 &&
    terms.every((term) => arithmeticColumns(term.node).length === 0)
  ) {
    throw new Error(
      `TABLE_QUERY_EXPRESSION_CONSTANT: ${terms.map((term) => `"${term.text}"`).join(", ")} reads ` +
        "no column, so the answer would repeat one constant. Select a column or a term over columns."
    )
  }
  const expressions: SelectExpression[] = terms.map((term, index) => ({
    text: term.text,
    node: term.node,
    column: expressionColumnName(index)
  }))
  return { columns, aggregates, expressions }
}

/** A qualified key list for `GROUP BY` / `ORDER BY`. */
function parseQualifiedKeys(
  text: string,
  limit: number,
  direction: boolean
): JoinedTableSelect["orderBy"] | undefined {
  const keys: JoinedTableSelect["orderBy"] = []
  let rest = text.trim()
  while (rest) {
    const match = rest.match(
      /^([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)(?:\s+(ASC|DESC))?\s*(?:,\s*|$)/i
    )
    if (!match) return undefined
    if (match[2] !== undefined && !direction)
      throw new Error(
        "TABLE_QUERY_GROUP_BY_DIRECTION: GROUP BY takes column names only; a direction belongs to " +
          "ORDER BY, which sorts the groups this statement returns."
      )
    const split = splitQualified(match[1]!)
    if (!split) return undefined
    const name = `${split.alias}.${split.column}`
    if (keys.some((key) => key.column === name) || keys.length === limit) return undefined
    keys.push({
      column: name,
      direction: match[2]?.toUpperCase() === "DESC" ? "desc" : "asc"
    })
    rest = rest.slice(match[0].length).trim()
  }
  return keys.length > 0 ? keys : undefined
}

/** The `WHERE` conjuncts of a joined statement: one table, one column, one literal, `AND` only. */
function parseJoinWhere(text: string, aliases: string[]): JoinWhereCondition[] | undefined {
  const conditions: JoinWhereCondition[] = []
  let rest = text.trim()
  while (rest) {
    if (conditions.length === selectDisjunctLimit) return undefined
    const match = rest.match(
      /^([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\s*(<=|>=|<>|=|<|>)\s*('(?:[^']|'')*'|-?\d+(?:\.\d+)?)([\s\S]*)$/
    )
    if (!match) {
      const reference = rest.match(qualifiedJoinPattern)
      if (reference)
        throw new Error(
          `TABLE_QUERY_JOIN_WHERE_CROSS_TABLE: ${rest.slice(0, 40)} compares two tables or a ` +
            "column with a column. A WHERE conjunct compares one column with a literal; a " +
            "column-to-column condition belongs in the ON clause of the join it relates."
        )
      if (/^[A-Za-z_][A-Za-z0-9_]*\s*(<=|>=|<>|=|<|>)/.test(rest))
        throw new Error(
          `TABLE_QUERY_JOIN_COLUMN_UNQUALIFIED: ${rest.slice(0, 40)} does not name its table. Write ` +
            `it as <alias>.<column> (aliases: ${aliases.join(", ")}).`
        )
      return undefined
    }
    const left = splitQualified(match[1]!)
    if (!left) return undefined
    if (!aliases.includes(left.alias))
      throw new Error(
        `TABLE_QUERY_JOIN_ALIAS_UNKNOWN: ${match[1]} names ${left.alias}, which is not a table in ` +
          `this statement (aliases: ${aliases.join(", ")}).`
      )
    const operator = selectOperators.find(([token]) => token === match[2])?.[1]
    if (!operator) return undefined
    const literal = match[3]!
    const value = literal.startsWith("'") ? literal.slice(1, -1).replaceAll("''", "'") : literal
    // The reader bounds a filter value at 40 characters, so a longer literal cannot be pushed down.
    if (value.length > 40) return undefined
    conditions.push({ alias: left.alias, column: left.column, operator, value })
    const after = match[4]!.trim()
    if (!after) break
    const and = after.match(/^AND\s+([\s\S]*)$/i)
    if (!and) {
      if (/^OR\b/i.test(after))
        throw new Error(
          "TABLE_QUERY_JOIN_WHERE_OR: a joined statement reads each table once, so it takes a " +
            "conjunction (AND) only. Ask the two branches as two statements."
        )
      return undefined
    }
    rest = and[1]!.trim()
    if (!rest) return undefined
  }
  return conditions
}

/**
 * Parse a joined statement, or return `undefined` when this is not one.
 *
 * Statements the grammar understands but refuses throw a `TABLE_QUERY_*` error naming the fix, on the
 * same reasoning as {@link parseGroupedTableSelect}: the caller only reaches this parser after the
 * platform's own path answered with the known empty-HTML failure, so a descriptive refusal is
 * strictly more useful than that error. Everything here is decided before the first read, so a
 * statement that violates a rule never reaches SAP.
 */
export function parseJoinedTableSelect(sql: string): JoinedTableSelect | undefined {
  const head = sql.match(/^\s*SELECT\s+([\s\S]*?)\s+FROM\s+([\s\S]*)$/i)
  if (!head) return undefined
  if (!/\bJOIN\b/i.test(maskLiterals(head[2]!))) return undefined
  const limitSplit = splitTrailingLimit(head[2]!)
  const split = splitJoinTail(limitSplit.text)
  if (!split) return undefined
  const tables = parseJoinedTables(split.from)
  if (!tables) return undefined
  const aliases = tables.map((table) => table.alias)
  if (new Set(aliases).size !== aliases.length) {
    throw new Error(
      `TABLE_QUERY_JOIN_ALIAS_DUPLICATE: ${aliases.join(", ")} names a table twice, so a column ` +
        "reference would be ambiguous. Give each joined table its own alias."
    )
  }
  const outerIndex = tables.findIndex(
    (table) => table.joinType === "left" || table.joinType === "right" || table.joinType === "full"
  )
  if (outerIndex >= 0 && outerIndex !== tables.length - 1) {
    throw new Error(
      "TABLE_QUERY_JOIN_OUTER_NOT_LAST: a LEFT, RIGHT or FULL JOIN must be the last join in this " +
        "grammar. An inner join after an outer join removes the null-extended rows again, and this " +
        "path will not guess which of the two readings the caller meant."
    )
  }
  const projection = parseJoinProjection(head[1]!.trim(), aliases)
  if (!projection) return undefined
  const tail = split.tail
  let where: JoinWhereCondition[] = []
  let groupBy: string[] = []
  let orderBy: JoinedTableSelect["orderBy"] = []
  if (tail) {
    if (/^WHERE\b/i.test(tail)) {
      const clause = tail.match(
        /^WHERE\s+([\s\S]*?)(?:\s+GROUP\s+BY\s+([\s\S]*?))?(?:\s+ORDER\s+BY\s+([\s\S]+))?$/i
      )
      if (!clause) return undefined
      if (clause[2] !== undefined) {
        const keys = parseQualifiedKeys(clause[2], selectGroupLimit, false)
        if (!keys) return undefined
        groupBy = keys.map((key) => key.column)
      }
      if (clause[3] !== undefined) {
        const keys = parseQualifiedKeys(clause[3], selectOrderLimit, true)
        if (!keys) return undefined
        orderBy = keys
      }
      const conditions = parseJoinWhere(clause[1]!, aliases)
      if (!conditions) return undefined
      where = conditions
    } else {
      const clause = tail.match(
        /^(?:GROUP\s+BY\s+([\s\S]*?)(?:\s+ORDER\s+BY\s+([\s\S]+))?|ORDER\s+BY\s+([\s\S]+))$/i
      )
      if (!clause) return undefined
      if (clause[1] !== undefined) {
        const keys = parseQualifiedKeys(clause[1], selectGroupLimit, false)
        if (!keys) return undefined
        groupBy = keys.map((key) => key.column)
      }
      const orderText = clause[1] !== undefined ? clause[2] : clause[3]
      if (orderText !== undefined) {
        const keys = parseQualifiedKeys(orderText, selectOrderLimit, true)
        if (!keys) return undefined
        orderBy = keys
      }
    }
  }
  if (outerIndex >= 0) {
    const outer = tables[outerIndex]!
    // Which side keeps its rows without a match decides where a `WHERE` predicate stays truthful.
    // Every predicate is pushed into the read of the table it names, so removing rows there also
    // removes the joined rows they would have produced - which is exactly right on the preserved
    // side and exactly wrong on the optional one. For a LEFT join the optional side is the table the
    // join introduces; for a RIGHT join it is everything joined before it; a FULL join has two
    // preserved sides and therefore no side on which a pushed-down predicate keeps its meaning.
    const optionalAliases =
      outer.joinType === "left"
        ? [outer.alias]
        : outer.joinType === "right"
          ? tables.slice(0, outerIndex).map((table) => table.alias)
          : tables.map((table) => table.alias)
    const offending = where.filter((condition) => optionalAliases.includes(condition.alias))
    if (offending.length > 0) {
      throw new Error(
        `TABLE_QUERY_JOIN_WHERE_OUTER_COLUMN: ${offending
          .map((condition) => `${condition.alias}.${condition.column}`)
          .join(
            ", "
          )} is on the optional side of the ${outer.joinType.toUpperCase()} JOIN of ${outer.alias}. ` +
          "A WHERE predicate there filters the joined result, which this path cannot evaluate in " +
          "SAP; " +
          (outer.joinType === "full"
            ? "a FULL JOIN keeps both sides, so no ON clause can carry it either - compare columns " +
              "in ON, or ask SAP."
            : "move it into the ON clause of that join, where it is applied to the optional read.")
      )
    }
  }
  const keyed = projection.aggregates.length > 0 || groupBy.length > 0
  if (keyed) {
    if (projection.expressions.length > 0) {
      throw new Error(
        "TABLE_QUERY_EXPRESSION_GROUPED: an arithmetic term is evaluated per row, and a grouped " +
          "answer has no single row to evaluate it on. Select the term without GROUP BY, or compute " +
          "it in SAP. Terms over grouped columns are not translated."
      )
    }
    const selected = [...projection.columns].sort()
    const grouped = [...groupBy].sort()
    if (
      selected.length !== grouped.length ||
      selected.some((column, index) => column !== grouped[index])
    ) {
      throw new Error(
        "TABLE_QUERY_GROUP_BY_KEYS_MISMATCH: GROUP BY must name exactly the selected columns " +
          `(selected ${selected.length ? selected.join(", ") : "none"}, grouped ` +
          `${grouped.length ? grouped.join(", ") : "none"}). Select each grouping column and group ` +
          "by exactly those columns, or drop the GROUP BY."
      )
    }
  }
  return {
    tables,
    columns: projection.columns,
    aggregates: projection.aggregates,
    expressions: projection.expressions,
    groupBy,
    where,
    orderBy,
    limit: limitSplit.limit
  }
}

/** One side of a join, as the caller's reader reports it. */
export interface JoinedReadBranch {
  rows: Record<string, unknown>[]
  /** True when the read hit the reader's row bound: this side holds a sample. */
  truncated: boolean
  /** The reader's own evidence for this read, passed through so nothing is lost. */
  detail: Record<string, unknown>
}

export interface JoinedReadResult {
  rows: Record<string, unknown>[]
  truncated: boolean
  orderByApplied: boolean
  aggregated: boolean
  groupCount: number
  aggregateColumns: Array<{ expression: string; column: string }>
  /**
   * The projected terms, as `querySource.expressionColumns` reports them on the single-table path.
   */
  expressionColumns: Array<{ expression: string; column: string }>
  /** The statement's own `LIMIT`, or null when it had none. */
  limit: number | null
  join: {
    tables: Array<{
      alias: string
      tableName: string
      joinType: JoinType
      onKeys: string[]
      pushedFilters: SelectFilter[]
    }>
    /** Aliases whose read stopped at the row bound, in join order. */
    incompleteAliases: string[]
    /** One entry per read, in join order. */
    reads: Record<string, unknown>[]
    joinedRows: number
  }
}

/** The reader answers an initial field as an empty string; a join key compares the same way. */
function joinKeyValue(row: Record<string, unknown>, qualified: string): string {
  const value = row[qualified]
  return value === undefined || value === null ? "" : String(value)
}

/**
 * Run a joined statement: one bounded read per table, a hash join on the `ON` keys, then the same
 * grouping, ordering and `LIMIT` rules the single-table path applies.
 *
 * The join kind decides what an unmatched key produces. `inner` and `cross` drop nothing extra and
 * add nothing extra; `left` keeps the accumulated side's unmatched rows, `right` keeps the newly
 * read table's, and `full` keeps both. An absent side is written with the reader's own empty value,
 * which is the same thing an initial field already means everywhere else in this path.
 */
export async function readJoinedRows(
  select: JoinedTableSelect,
  readTable: (
    tableName: string,
    columns: string[],
    filters: SelectFilter[]
  ) => Promise<JoinedReadBranch>,
  rowBound: number,
  columnTypes?: (column: string) => OperandType | undefined
): Promise<JoinedReadResult> {
  const aggregated = select.aggregates.length > 0 || select.groupBy.length > 0
  const published = [...select.columns, ...select.aggregates.map(aggregateColumnName)]
  const unprojected = [...new Set(select.orderBy.map((key) => key.column))].filter(
    (column) => !published.includes(column)
  )
  if (unprojected.length > 0) {
    throw new Error(
      `TABLE_QUERY_ORDER_BY_COLUMN_NOT_SELECTED: ORDER BY ${unprojected.join(", ")} is not in the ` +
        `projection, so the rows carry nothing to compare. Add it to the SELECT list.`
    )
  }
  // Only the columns the statement actually uses are read: the projection, the aggregate arguments,
  // both sides of every join key, and every pushed-down predicate. A joined row is therefore never
  // built from columns the caller did not ask about or compare.
  const needed = new Map<string, string[]>()
  const demand = (qualified: string) => {
    const split = splitQualified(qualified)
    if (!split) return
    const list = needed.get(split.alias) ?? []
    if (!list.includes(split.column)) list.push(split.column)
    needed.set(split.alias, list)
  }
  for (const column of [...select.columns, ...select.groupBy]) demand(column)
  for (const key of select.orderBy) demand(key.column)
  // A term's operands are read even though the answer publishes only the derived column.
  for (const expression of select.expressions)
    for (const column of arithmeticColumns(expression.node)) demand(column)
  for (const aggregate of select.aggregates) if (aggregate.column) demand(aggregate.column)
  for (const table of select.tables)
    for (const condition of table.on) {
      demand(`${condition.left.alias}.${condition.left.column}`)
      if ("alias" in condition.right) demand(`${condition.right.alias}.${condition.right.column}`)
    }
  for (const condition of select.where) demand(`${condition.alias}.${condition.column}`)

  const pushed = new Map<string, SelectFilter[]>()
  const push = (alias: string, filter: SelectFilter) => {
    const list = pushed.get(alias) ?? []
    list.push(filter)
    pushed.set(alias, list)
  }
  for (const condition of select.where)
    push(condition.alias, {
      column: condition.column,
      operator: condition.operator,
      value: condition.value
    })
  for (const table of select.tables)
    for (const condition of table.on)
      if ("literal" in condition.right)
        // The condition reaches the read of the table it names - which is not always the table the
        // join introduces: a RIGHT JOIN may constrain only a table it is free to drop.
        push(condition.left.alias, {
          column: condition.left.column,
          operator: "EQ",
          value: condition.right.literal
        })

  const incompleteAliases: string[] = []
  const reads: Record<string, unknown>[] = []
  const readSide = async (table: JoinedTableRef): Promise<Record<string, unknown>[]> => {
    const branch = await readTable(
      table.tableName,
      needed.get(table.alias) ?? [],
      pushed.get(table.alias) ?? []
    )
    if (branch.truncated) incompleteAliases.push(table.alias)
    reads.push(branch.detail)
    const columns = needed.get(table.alias) ?? []
    return branch.rows.map((row) => {
      const qualified: Record<string, unknown> = {}
      for (const column of columns) qualified[`${table.alias}.${column}`] = row[column]
      return qualified
    })
  }

  let rows = await readSide(select.tables[0]!)
  let truncated = rows.length > rowBound
  for (let index = 1; index < select.tables.length && !truncated; index++) {
    const table = select.tables[index]!
    const right = await readSide(table)
    const keys = table.on.filter(
      (condition): condition is JoinOnCondition & { right: { alias: string; column: string } } =>
        "alias" in condition.right
    )
    const buckets = new Map<string, Record<string, unknown>[]>()
    for (const row of right) {
      const key = JSON.stringify(
        keys.map((condition) =>
          joinKeyValue(row, `${condition.left.alias}.${condition.left.column}`)
        )
      )
      const bucket = buckets.get(key)
      if (bucket) bucket.push(row)
      else buckets.set(key, [row])
    }
    const merged: Record<string, unknown>[] = []
    const matchedKeys = new Set<string>()
    for (const partial of rows) {
      const key = JSON.stringify(
        keys.map((condition) =>
          joinKeyValue(partial, `${condition.right.alias}.${condition.right.column}`)
        )
      )
      const matches = buckets.get(key)
      if (matches && matches.length > 0) {
        matchedKeys.add(key)
        for (const match of matches) merged.push({ ...partial, ...match })
      } else if (table.joinType === "left" || table.joinType === "full") {
        // No matching row: the optional side stays empty, the way the reader writes an initial field.
        const empty: Record<string, unknown> = {}
        for (const column of needed.get(table.alias) ?? []) empty[`${table.alias}.${column}`] = ""
        merged.push({ ...partial, ...empty })
      }
      if (merged.length > rowBound) break
    }
    if ((table.joinType === "right" || table.joinType === "full") && merged.length <= rowBound) {
      // The rows of this table that nothing on the left matched. A right join preserves this side
      // and a full join preserves both, so these rows are part of the answer and every alias joined
      // before this one is written with the reader's own empty value. The guard above is what keeps
      // this honest: when the loop stopped at the row bound some keys were never probed, and a key
      // that was never probed would look unmatched - so a stopped join emits no synthetic rows at all.
      const empty: Record<string, unknown> = {}
      for (const alias of select.tables.slice(0, index).map((joined) => joined.alias))
        for (const column of needed.get(alias) ?? []) empty[`${alias}.${column}`] = ""
      for (const [key, bucket] of buckets) {
        if (matchedKeys.has(key)) continue
        for (const row of bucket) {
          merged.push({ ...empty, ...row })
          if (merged.length > rowBound) break
        }
        if (merged.length > rowBound) break
      }
    }
    rows = merged
    if (rows.length > rowBound) truncated = true
  }
  if (incompleteAliases.length > 0) truncated = true
  const bound = `the ${rowBound}-row bound`
  if (aggregated && truncated) {
    throw new Error(
      `TABLE_QUERY_AGGREGATE_INCOMPLETE: an aggregate describes the whole match set, but ` +
        `${incompleteAliases.length > 0 ? `the read of ${incompleteAliases.join(", ")} stopped at ${bound}` : `the join stopped at ${bound}`}, ` +
        `so the count would be a count of the sample. Narrow the WHERE clause until every read ` +
        `completes. Nothing was aggregated.`
    )
  }
  if (!aggregated && select.orderBy.length > 0 && truncated) {
    throw new Error(
      `TABLE_QUERY_ORDER_BY_INCOMPLETE: ORDER BY describes the whole match set, but ` +
        `${incompleteAliases.length > 0 ? `the read of ${incompleteAliases.join(", ")} stopped at ${bound}` : `the join stopped at ${bound}`}. ` +
        `Narrow the WHERE clause until every read completes, or sort the returned page with ` +
        `sortColumns. Nothing was ordered.`
    )
  }
  // Terms are evaluated after the completeness refusals, for the same reason the single-table path
  // does it there: a statement that cannot be answered completely is refused for that reason rather
  // than for whatever its arithmetic happened to hit first. Unlike the single-table path the joined
  // rows are keyed `ALIAS.COLUMN`, so a term's operand is read from the row directly and the terms
  // are the only place qualified names reach the evaluator.
  applyExpressions(rows, select.expressions, columnTypes)
  const result = aggregated ? aggregateRows(rows, select) : rows
  const ordered = select.orderBy.length > 0 ? sortRowsByColumns(result, select.orderBy) : result
  // `LIMIT` bounds the answer rather than the reads, so it is taken from the ordered rows: the
  // completeness refusals above still see the whole match set, and a limited answer over a sample is
  // refused instead of trimmed.
  const limited = select.limit === undefined ? ordered : ordered.slice(0, select.limit)
  // A joined row carries the join keys and the pushed-down predicate columns as well, but only the
  // projection is the answer: publishing the key of the other side would put a column in the reply
  // that the caller never selected, and an absent optional side reads as the reader's own empty value.
  const outputRows = aggregated
    ? limited
    : limited.slice(0, rowBound).map((row) => {
        const output: Record<string, unknown> = {}
        for (const column of [...select.columns, ...select.expressions.map((e) => e.column)]) {
          const value = row[column]
          output[column] = value === undefined || value === null ? "" : value
        }
        return output
      })
  return {
    rows: outputRows,
    truncated,
    orderByApplied: select.orderBy.length > 0,
    aggregated,
    groupCount: aggregated ? limited.length : 0,
    aggregateColumns: select.aggregates.map((aggregate) => ({
      expression: aggregateExpression(aggregate),
      column: aggregateColumnName(aggregate)
    })),
    expressionColumns: select.expressions.map((expression) => ({
      expression: expression.text,
      column: expression.column
    })),
    limit: select.limit ?? null,
    join: {
      tables: select.tables.map((table) => ({
        alias: table.alias,
        tableName: table.tableName,
        joinType: table.joinType,
        onKeys: table.on.map((condition) =>
          "alias" in condition.right
            ? `${condition.left.alias}.${condition.left.column} = ${condition.right.alias}.${condition.right.column}`
            : `${condition.left.alias}.${condition.left.column} = '${condition.right.literal}'`
        ),
        pushedFilters: pushed.get(table.alias) ?? []
      })),
      incompleteAliases,
      reads,
      joinedRows: rows.length
    }
  }
}
