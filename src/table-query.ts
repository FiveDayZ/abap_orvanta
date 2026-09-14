import { z } from "zod"
import type { RemoteFunctionRequest, SapBackend } from "./backend.js"
import { reviewedTableReaderDefinition } from "./system-info.js"

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
const nativeEmptyHtml =
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
    const definition = tableDefinition.safeParse(await readTable(connectionId, input.tableName))
    if (!definition.success || definition.data.objectName !== input.tableName)
      throw new Error("TABLE_QUERY_DICTIONARY_INVALID")
    definitionFingerprint = definition.data.fingerprint
    const declaredColumns = definition.data.definition.fields.map((field) => field.name)
    const allColumns = declaredColumns.filter((name) => !name.startsWith("."))
    if (allFields) input.columns = [...allColumns]
    base.columns = input.columns
    if (
      allColumns.length === 0 ||
      allColumns.length > 1024 ||
      new Set(allColumns).size !== allColumns.length ||
      [...input.columns, ...input.filters.map((filter) => filter.column)].some(
        (name) => !allColumns.includes(name)
      )
    )
      throw new Error("TABLE_QUERY_FIELD_INVALID")
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
      returnedCount: 0,
      truncated: null,
      data: null
    }
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

export function parseSimpleTableSelect(sql: string) {
  // Same finite-grammar approach as scoped-query.ts; never translate arbitrary SQL.
  const match = sql.match(
    /^\s*SELECT\s+(\*|[A-Z][A-Z0-9_]*(?:\s*,\s*[A-Z][A-Z0-9_]*)*)\s+FROM\s+([A-Z][A-Z0-9_]*)\s+WHERE\s+([\s\S]+?)\s*$/i
  )
  if (!match) return undefined
  let rest = match[3]!
  const filters: { column: string; operator: "EQ"; value: string }[] = []
  while (rest) {
    const condition = rest.match(/^([A-Z][A-Z0-9_]*)\s*=\s*'((?:[^']|'')*)'\s*(?:AND\s+|$)/i)
    if (!condition || filters.length === 8) return undefined
    filters.push({
      column: condition[1]!.toUpperCase(),
      operator: "EQ",
      value: condition[2]!.replaceAll("''", "'")
    })
    rest = rest.slice(condition[0].length)
    if (!rest && /\bAND\s+$/i.test(condition[0])) return undefined
  }
  return {
    tableName: match[2]!.toUpperCase(),
    columns: match[1]!.split(/\s*,\s*/).map((column) => column.toUpperCase()),
    filters
  }
}
