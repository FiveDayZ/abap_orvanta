import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import {
  createReviewedTableReader,
  reviewedTableReaderDefinition,
  type ReviewedReaderSource,
  type ReviewedRow
} from "./reviewed-table-reader.js"

export const configurationFiFormulaPins = {
  GB90: "e302054a6ff1e71c1531f8bbbf0b92e991338b137813cb89f72613eb0a659f33",
  GB901: "40bb7a60e4b06f679c5d135126d42e67225602d18aac20e119ce78f69d472a59",
  BOOL_ID: "39d0019e285f917aa6d105e5debb5742f4fe6fccea49389ea33f6039b5b837c6",
  CHAR2: "51f3328828b6042e97b70807b39b6efeabcfc9c3fdc91155fec278001a6209c9",
  TEXT60: "394fae5e6bf01ebf7dc9f75b096f4e7888e4dc355441640df649b4057b333b1a",
  RFC_DB_FLD: "9224d55ab87c9ba021ef7d60295a331f0dd6861666470207a1b53e93ee48e197",
  TAB512: "53835e1e01740879a5253269720d45d9f3a8f7cd80c852fdeb49fdf4fbd9b626",
  G_BOOL_GET_BOOLID_IN_TABLE: {
    source: "493b6420d62b040225dbb7c2dae774c049e72c57052e0274047a21eeac136239",
    interface: "b78fa168462ec1d906fdb351a635ada2996d389f851e6198667d63a2931106da"
  }
} as const

const headerFields = ["MANDT", "BOOLID", "BOOLTYPE", "CLASSID", "AUTHGR", "INITEXIT", "MULTILINE"]
// The client trailer keeps CHAR60 formula spaces inside the wire row, even if SOAP omits row padding.
const lineFields = ["BOOLID", "SEQNR", "BOOLEXP", "MANDT"]
const offsets = [0, 11, 13, 73]
const lengths = [11, 2, 60, 3]
// G_BOOL_GET_ELEMS_FORMULA has a 2700-character buffer; larger selections remain unsupported.
const maximumLines = 45
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
function fail(code: string): never {
  throw Error(`FI_RULE_FORMULA_${code}`)
}
const errorCode = (error: unknown) =>
  error instanceof Error && /HTTP 401|logon.*failed/i.test(error.message)
    ? "FI_RULE_FORMULA_AUTHENTICATION_REJECTED"
    : error instanceof Error && /^FI_RULE_FORMULA_[A-Z_]+$/.test(error.message)
      ? error.message
      : "FI_RULE_FORMULA_READ_FAILED"

/** Only formula IDs observed in the selected validation's steps; no public table/ID selector. */
export async function readConfigurationFiFormulas(
  connectionId: string,
  client: string,
  booleanClass: string,
  steps: ReviewedRow[],
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  readers: {
    table(name: string): Promise<unknown>
    domain(name: string): Promise<unknown>
    structure(name: string): Promise<unknown>
    function(name: string): Promise<unknown>
  }
) {
  if (connectionId !== "w200" || client !== "200") fail("SCOPE_UNSUPPORTED")
  const startedAt = new Date().toISOString()
  const sources: ReviewedReaderSource[] = []
  const warnings: string[] = []
  const blockers: string[] = []
  const references: { step: string; role: "condition" | "check"; formulaId: string }[] = []
  let items: { formulaId: string; header: ReviewedRow | null; lines: ReviewedRow[] }[] | null = null
  let status = "unavailable"
  let readFingerprint: string | null = null
  let definitionsRechecked = false
  const attest = async () => {
    for (const [names, kind, reader] of [
      [["GB90", "GB901"], "transparentTable", readers.table],
      [["BOOL_ID", "CHAR2", "TEXT60"], "domain", readers.domain],
      [["RFC_DB_FLD", "TAB512"], "structure", readers.structure]
    ] as const)
      for (const name of names) {
        const result = z
          .object({
            connectionId: z.literal("w200"),
            objectKind: z.literal(kind),
            objectName: z.literal(name),
            fingerprint: z.literal(configurationFiFormulaPins[name]),
            active: z.literal(true).optional()
          })
          .safeParse(await reader(name))
        if (!result.success) fail("LAYOUT_UNVERIFIED")
      }
    if (!reviewedTableReaderDefinition.safeParse(await readers.function("RFC_READ_TABLE")).success)
      fail("READER_UNVERIFIED")
    const storage = configurationFiFormulaPins.G_BOOL_GET_BOOLID_IN_TABLE
    if (
      !z
        .object({
          connectionId: z.literal("w200"),
          functionName: z.literal("G_BOOL_GET_BOOLID_IN_TABLE"),
          remoteEnabled: z.literal(false),
          updateTask: z.literal(false),
          sourceFingerprint: z.literal(storage.source),
          interfaceFingerprint: z.literal(storage.interface)
        })
        .safeParse(await readers.function("G_BOOL_GET_BOOLID_IN_TABLE")).success
    )
      fail("STORAGE_SOURCE_UNVERIFIED")
  }
  try {
    for (const step of steps)
      for (const [role, field] of [
        ["condition", "CONDID"],
        ["check", "CHECKID"]
      ] as const) {
        const id = step[field]
        if (!id || id.length > 11 || /[^\x20-\x7e]/.test(id)) fail("REFERENCE_INVALID")
        references.push({ step: step.VALSEQNR!, role, formulaId: id })
      }
    const ids = [...new Set(references.map((reference) => reference.formulaId))].sort()
    if (!ids.length) fail("REFERENCES_MISSING")
    if (ids.length > 20) fail("REFERENCE_LIMIT")
    await attest()
    const headers = createReviewedTableReader(
      backend,
      connectionId,
      () => readers.function("RFC_READ_TABLE"),
      sources,
      warnings
    )
    const readLines = async (formulaId: string): Promise<ReviewedRow[]> => {
      const source: ReviewedReaderSource = {
        table: "GB901",
        status: "unavailable",
        method: "rfc_read_table",
        returnedCount: 0
      }
      sources.push(source)
      try {
        // No delimiter or trimming: a pipe or a space can belong to a quoted formula operand.
        const reply = await backend.callRemoteFunction(connectionId, {
          functionName: "RFC_READ_TABLE",
          inputParameters: {
            QUERY_TABLE: "GB901",
            DELIMITER: "",
            NO_DATA: "",
            ROWSKIPS: "0",
            ROWCOUNT: String(maximumLines + 1),
            OPTIONS: [
              { TEXT: "MANDT = '200'" },
              { TEXT: `AND BOOLID = '${formulaId.replaceAll("'", "''")}'` }
            ],
            FIELDS: lineFields.map((FIELDNAME) => ({ FIELDNAME })),
            DATA: []
          },
          outputParameters: [
            { name: "FIELDS", kind: "table", fields: ["FIELDNAME", "OFFSET", "LENGTH", "TYPE"] },
            { name: "DATA", kind: "table", fields: ["WA"] }
          ]
        })
        if (reply.fault)
          fail(reply.fault.name === "NOT_AUTHORIZED" ? "NOT_AUTHORIZED" : "RFC_FAILED")
        const metadata = reply.outputs.FIELDS
        const data = reply.outputs.DATA
        if (
          !Array.isArray(metadata) ||
          metadata.length !== lineFields.length ||
          metadata.some(
            (field, index) =>
              field.FIELDNAME !== lineFields[index] ||
              !/^\d+$/.test(field.OFFSET ?? "") ||
              Number(field.OFFSET) !== offsets[index] ||
              !/^\d+$/.test(field.LENGTH ?? "") ||
              Number(field.LENGTH) !== lengths[index] ||
              field.TYPE !== "C"
          ) ||
          !Array.isArray(data) ||
          data.length > maximumLines + 1
        )
          fail("RESPONSE_INVALID")
        const rows: ReviewedRow[] = []
        const keys = new Set<string>()
        for (const row of data) {
          // Refuse shortened SOAP rows; padding them would fabricate formula characters.
          if (
            typeof row.WA !== "string" ||
            row.WA.length < 76 ||
            row.WA.length > 512 ||
            /[\r\n\u0000]/.test(row.WA) ||
            row.WA.slice(76).trim()
          )
            fail("TEXT_FIDELITY_UNVERIFIED")
          const parsed = Object.fromEntries(
            lineFields.map((name, index) => [
              name,
              row.WA!.slice(offsets[index], offsets[index]! + lengths[index]!)
            ])
          )
          parsed.BOOLID = parsed.BOOLID!.trimEnd()
          if (parsed.MANDT !== client || parsed.BOOLID !== formulaId)
            fail("RESPONSE_SCOPE_MISMATCH")
          if (!parsed.SEQNR!.trim() || keys.has(parsed.SEQNR!)) fail("SEQUENCE_INVALID")
          keys.add(parsed.SEQNR!)
          rows.push(parsed)
        }
        rows.sort((a, b) => (a.SEQNR! < b.SEQNR! ? -1 : a.SEQNR! > b.SEQNR! ? 1 : 0))
        source.returnedCount = Math.min(rows.length, maximumLines)
        source.status = rows.length > maximumLines ? "truncated" : rows.length ? "ok" : "empty"
        if (rows.length > maximumLines) fail("READ_TRUNCATED")
        return rows
      } catch (error) {
        source.code = errorCode(error)
        throw error
      }
    }
    const read = async () => {
      const result = []
      for (const formulaId of ids) {
        const header = await headers({
          table: "GB90",
          fields: headerFields,
          filters: { MANDT: client, BOOLID: formulaId },
          maximum: 1,
          codePrefix: "FI_RULE_FORMULA_",
          mapError: errorCode
        })
        if (header === null) fail("HEADER_UNAVAILABLE")
        result.push({ formulaId, header: header[0] ?? null, lines: await readLines(formulaId) })
      }
      return result
    }
    const first = await read()
    const confirmation = await read()
    await attest()
    definitionsRechecked = true
    if (JSON.stringify(first) !== JSON.stringify(confirmation)) {
      status = "changed"
      blockers.push("FI_RULE_FORMULA_READ_CHANGED")
    } else {
      for (const item of first) {
        if (!item.header) blockers.push("FI_RULE_FORMULA_HEADER_MISSING")
        else if (item.header.CLASSID !== booleanClass)
          blockers.push("FI_RULE_FORMULA_CLASS_MISMATCH")
        if (!item.lines.length) blockers.push("FI_RULE_FORMULA_ROWS_MISSING")
      }
      // Do not publish incomplete formula fragments or an empty body as a complete definition.
      if (blockers.length) status = "partial"
      else {
        items = first
        status = "raw_content_read"
        readFingerprint = hash({ client, booleanClass, references, items })
      }
    }
  } catch (error) {
    blockers.push(errorCode(error))
    if (sources.some((source) => source.code === "FI_RULE_FORMULA_AUTHENTICATION_REJECTED"))
      blockers.push("FI_RULE_FORMULA_AUTHENTICATION_REJECTED")
  }
  return {
    status,
    references,
    items,
    readFingerprint,
    readOnly: true,
    saveAvailable: false,
    blockers: [...new Set(blockers)],
    coverage: {
      storedRowsComplete: status === "raw_content_read",
      complete: false,
      maximumFormulaIds: 20,
      maximumLinesPerFormula: maximumLines,
      textRepresentation: "gb901_char60_rows",
      rowPaddingPreserved: status === "raw_content_read",
      statements: "not_reconstructed",
      operatorsAndOperands: "not_parsed",
      dependencies: "not_read",
      initializationAndSharedExits: "not_checked",
      generatedCode: "not_checked",
      businessTrigger: "not_performed",
      snapshot: false
    },
    evidence: {
      startedAt,
      finishedAt: new Date().toISOString(),
      sources,
      warnings,
      definitionsRechecked
    }
  }
}
