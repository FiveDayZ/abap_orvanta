import { z } from "zod"
import { createHash } from "node:crypto"
import type { RemoteFunctionRequest, SapBackend } from "./backend.js"
import { reviewedTableReaderDefinition } from "./system-info.js"
import { assertTableAllowed } from "./table-allowlist.js"

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
    return response.rows.map((raw) => {
      const wa = (raw as { WA?: unknown } | null)?.WA
      if (typeof wa !== "string" || wa.length > 512 || wa.slice(offset - 1).trim())
        throw new Error("TABLE_QUERY_RESPONSE_INVALID")
      // SOAP can omit CHAR tail padding. Preserve leading padding and delimiters
      // inside actual field values by decoding the verified fixed offsets.
      const padded = wa.padEnd(offset - 1, " ")
      return Object.fromEntries(
        response.fields.map((field, index) => {
          const start = Number(field.OFFSET)
          if (index && padded[start - 1] !== "|") throw new Error("TABLE_QUERY_RESPONSE_INVALID")
          const value = padded.slice(start, start + Number(field.LENGTH)).trim()
          if (
            ["P", "I", "F", "b", "s"].includes(field.TYPE) &&
            (!/^[+-]?\d[\d., ]*(?:[Ee][+-]?\d+)?[+-]?$/.test(value) || value.includes("*"))
          )
            throw new Error("TABLE_QUERY_NUMERIC_OVERFLOW")
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
 * `SELECT <projection> FROM <table> [WHERE <disjunction>] [GROUP BY <keys>] [ORDER BY <keys>]`,
 * where the disjunction is `AND`-joined comparisons joined by `OR`, the projection is `*`, a column
 * list, or a list of aggregates, and the ordering is a key list.
 *
 * Three bounds are refusals rather than silent adjustments. {@link selectDisjunctLimit} bounds the
 * `OR` branches, because every branch is one server-side read; {@link selectOrderLimit} bounds the
 * sort keys, which are evaluated in the service (the reader has no ordering parameter at all);
 * {@link selectGroupLimit} bounds the `GROUP BY` keys, which are compared in the service.
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

export interface GroupedTableSelect {
  tableName: string
  columns: string[]
  aggregates: SelectAggregate[]
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
   * and its grouped form are the same shape.
   */
  groups: SelectFilter[][]
  orderBy: { column: string; direction: "asc" | "desc" }[]
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
  select: Pick<GroupedTableSelect, "columns" | "readWholeRow" | "aggregates" | "groupBy">
): string[] {
  const wholeRow = select.readWholeRow || select.aggregates.length > 0 || select.groupBy.length > 0
  return wholeRow ? ["*"] : select.columns
}

/** The columns a statement publishes: the grouped columns, then one column per aggregate. */
function groupedOutputColumns(
  select: Pick<GroupedTableSelect, "columns" | "aggregates">
): string[] {
  return [...select.columns, ...select.aggregates.map(aggregateColumnName)]
}

const projectionFunctionPattern = /^([A-Z][A-Z0-9_]*)\s*\(/i
const projectionItemPattern =
  /^(?:(COUNT|SUM|MIN|MAX)\s*\(\s*(\*|[A-Z][A-Z0-9_]*)\s*\)|([A-Z][A-Z0-9_]*))$/i

/**
 * Read the projection, or refuse.
 *
 * A function name this grammar does not evaluate is refused **by name** - the message can say what to
 * write instead, which the platform's own "empty HTML" error cannot. Any other expression (an
 * arithmetic term, `CASE`, `X AS Y`) is left to the platform: this parser cannot describe it, and
 * guessing would answer a question the caller did not ask.
 */
function parseProjection(
  text: string
): { columns: string[]; aggregates: SelectAggregate[]; selectAll: boolean } | undefined {
  const items = text.split(/\s*,\s*/)
  if (items.length === 0) return undefined
  const columns: string[] = []
  const aggregates: SelectAggregate[] = []
  for (const item of items) {
    if (item === "*") {
      if (items.length > 1) {
        throw new Error(
          "TABLE_QUERY_AGGREGATE_WITH_WILDCARD: * cannot be combined with aggregates or other " +
            "columns - select the grouped columns explicitly."
        )
      }
      return { columns: ["*"], aggregates: [], selectAll: true }
    }
    const match = item.match(projectionItemPattern)
    if (!match) {
      const call = item.match(projectionFunctionPattern)
      if (call) {
        const name = call[1]!.toUpperCase()
        throw new Error(
          `TABLE_QUERY_AGGREGATE_UNSUPPORTED: ${name} is not translated. Supported aggregates are ` +
            `${aggregateFunctions.join(", ")}; AVG is not among them because it is SUM divided by ` +
            `COUNT, which this statement can ask for in two columns.`
        )
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
  const shadowed = names.filter((name) => columns.includes(name))
  if (shadowed.length > 0) {
    throw new Error(
      `TABLE_QUERY_AGGREGATE_SHADOWED: ${shadowed.join(", ")} is both a selected column and the ` +
        `column an aggregate publishes; rename the selected column out of the way.`
    )
  }
  return { columns, aggregates, selectAll: false }
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

function parseConjunct(text: string) {
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
    filter: { column: match[1]!.toUpperCase(), operator, value } as SelectFilter,
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
 */
export function parseGroupedTableSelect(sql: string): GroupedTableSelect | undefined {
  // Same finite-grammar approach as scoped-query.ts; never translate arbitrary SQL.
  const match = sql.match(/^\s*SELECT\s+([\s\S]*?)\s+FROM\s+([A-Z][A-Z0-9_]*)\s*([\s\S]*?)\s*$/i)
  if (!match) return undefined
  const projection = parseProjection(match[1]!.trim())
  if (!projection) return undefined
  const tableName = match[2]!.toUpperCase()
  const tail = match[3]!.trim()
  const groups: SelectFilter[][] = []
  let groupBy: string[] = []
  let orderBy: GroupedTableSelect["orderBy"] = []
  if (tail) {
    if (/^WHERE\b/i.test(tail)) {
      // The optional `GROUP BY` / `ORDER BY` clauses are split off by pattern, not by a tokenizer. A
      // string literal that itself contains " ORDER BY " therefore splits in the wrong place - and is
      // then refused by `parseOrderBy`, because a key list cannot end in the literal's closing quote.
      // A refusal is the intended outcome: this grammar never guesses which reading the caller meant.
      const where = tail.match(
        /^WHERE\s+([\s\S]*?)(?:\s+GROUP\s+BY\s+([A-Z][\s\S]*?))?(?:\s+ORDER\s+BY\s+([\s\S]+))?$/i
      )
      if (!where) return undefined
      let rest = where[1]!.trim()
      if (where[2] !== undefined) {
        const keys = parseGroupBy(where[2])
        if (!keys) return undefined
        groupBy = keys
      }
      if (where[3] !== undefined) {
        const keys = parseOrderBy(where[3])
        if (!keys) return undefined
        orderBy = keys
      }
      if (!rest) return undefined
      for (;;) {
        if (groups.length === selectDisjunctLimit) return undefined
        const group: SelectFilter[] = []
        for (;;) {
          if (group.length === 8) return undefined
          const conjunct = parseConjunct(rest)
          if (!conjunct) return undefined
          group.push(conjunct.filter)
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
    groupBy,
    readWholeRow: projection.selectAll || keyed,
    groups: groups.length > 0 ? groups : [[]],
    orderBy
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

/** A plain decimal as the reader writes it, split so it can be added without floating point error. */
function numericParts(
  value: string
): { sign: number; integer: string; fraction: string } | undefined {
  const match = value.trim().match(/^(-)?(\d+)(?:\.(\d+))?$/)
  if (!match) return undefined
  return { sign: match[1] ? -1 : 1, integer: match[2]!, fraction: match[3] ?? "" }
}

/** Render a scaled integer back into the reader's decimal notation, keeping the widest scale seen. */
function formatScaled(total: number, scale: number): string {
  const sign = total < 0 ? "-" : ""
  const digits = String(Math.abs(total)).padStart(scale + 1, "0")
  return scale === 0
    ? `${sign}${digits}`
    : `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`
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
    "columns" | "aggregates" | "groupBy" | "readWholeRow" | "groups" | "orderBy"
  >,
  readBranch: (filters: SelectFilter[]) => Promise<GroupedReadBranch>,
  rowBound?: number
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
  const rows: Record<string, unknown>[] = []
  const seen = new Set<string>()
  const incompleteBranches: number[] = []
  let deduplicatedRows = 0
  let repeatedProjectedRows = 0
  for (const [index, group] of select.groups.entries()) {
    const branch = await readBranch(group)
    if (branch.truncated) incompleteBranches.push(index)
    for (const row of branch.rows) {
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
  const base = {
    disjuncts: select.groups.length,
    deduplicatedRows,
    repeatedProjectedRows,
    incompleteBranches,
    aggregated: keyed,
    groupCount: keyed ? result.length : 0,
    aggregateColumns: select.aggregates.map((aggregate) => ({
      expression: aggregateExpression(aggregate),
      column: aggregateColumnName(aggregate)
    }))
  }
  if (select.orderBy.length > 0) {
    return { rows: sortRowsByColumns(result, select.orderBy), ...base, orderByApplied: true }
  }
  return { rows: result, ...base, orderByApplied: false }
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
