import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import {
  createReviewedTableReader,
  type ReviewedReaderSource,
  type ReviewedRow
} from "./reviewed-table-reader.js"

export const configurationNumberRangeSchema = z
  .object({
    connectionId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,100}$/)
      .toLowerCase(),
    objectName: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[ZY][A-Z0-9_]{0,9}$/),
    subobject: z
      .string()
      .max(6)
      .refine((v) => !/[\p{Cc}|']/u.test(v)),
    year: z.string().regex(/^\d{4}$/),
    intervalNumber: z
      .string()
      .regex(/^[A-Za-z0-9]{1,2}$/)
      .optional(),
    maxIntervals: z.number().int().min(2).max(100).default(100)
  })
  .strict()
export const configurationNumberRangeScopeSchema = configurationNumberRangeSchema
  .omit({ year: true, intervalNumber: true })
  .strict()
export const numberRangeIntervalLayout =
  "a4a8ca2622e69afb3dbb80dabd0458bb86bb658761563aedc9507ff4f5d8c105"
export const numberRangeIntervalFields = [
  "CLIENT",
  "OBJECT",
  "SUBOBJECT",
  "NRRANGENR",
  "TOYEAR",
  "FROMNUMBER",
  "TONUMBER",
  "NRLEVEL",
  "EXTERNIND"
] as const
const definitionSchema = z.object({
  connectionId: z.literal("w200"),
  objectKind: z.literal("numberRangeObject"),
  objectName: z.string(),
  version: z.string().regex(/^[A-Fa-f0-9]{40}$/),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  active: z.literal(true).optional(),
  definition: z.object({ properties: z.record(z.string()) })
})

export async function readConfigurationNumberRange(
  raw: unknown,
  client: string,
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  readObject: (name: string) => Promise<unknown>,
  readTable: (name: string) => Promise<unknown>,
  readFunction: (name: string) => Promise<unknown>,
  allYears = false
) {
  const input = configurationNumberRangeSchema.parse(raw)
  if (input.connectionId !== "w200" || client !== "200")
    throw new Error("NUMBER_RANGE_SCOPE_UNSUPPORTED")
  const startedAt = new Date().toISOString()
  const verifyLayout = async () => {
    if (
      !z
        .object({
          connectionId: z.literal("w200"),
          objectName: z.literal("NRIV"),
          objectKind: z.literal("transparentTable"),
          fingerprint: z.literal(numberRangeIntervalLayout),
          active: z.literal(true).optional()
        })
        .safeParse(await readTable("NRIV")).success
    )
      throw new Error("NUMBER_RANGE_LAYOUT_UNVERIFIED")
  }
  await verifyLayout()
  const observedDefinition = await readObject(input.objectName)
  const absent = z.object({
    connectionId: z.literal("w200"),
    objectName: z.literal(input.objectName),
    objectType: z.literal("numberRangeObject"),
    status: z.literal("not-found"),
    exists: z.literal(false),
    authoritative: z.literal(true),
    readOnly: z.literal(true)
  })
  if (absent.safeParse(observedDefinition).success) {
    const confirmed = absent.safeParse(await readObject(input.objectName)).success
    await verifyLayout()
    return {
      connectionId: input.connectionId,
      client,
      objectName: input.objectName,
      subobject: input.subobject,
      year: allYears ? null : input.year,
      status: confirmed ? "not_found" : "changed",
      readOnly: true,
      saveAvailable: false,
      intervals: null,
      definition: null,
      definitionFingerprint: null,
      readFingerprint: null,
      complete: false,
      truncated: false,
      representation: "sap_text_trimmed",
      currentLevelMeaning: "persisted_NRIV_NRLEVEL_only",
      evidence: {
        startedAt,
        finishedAt: new Date().toISOString(),
        sources: [],
        warnings: [],
        layoutFingerprint: numberRangeIntervalLayout,
        definitionsRechecked: true,
        valuesRechecked: false,
        snapshot: false
      },
      warnings: [
        confirmed
          ? "The authoritative number-range object read reported absence twice; no interval query, maintenance or allocation API was invoked."
          : "The number-range definition changed after an authoritative absence observation; no interval query, maintenance or allocation API was invoked."
      ]
    }
  }
  const definition = definitionSchema.parse(observedDefinition)
  if (
    definition.objectName !== input.objectName ||
    definition.definition.properties.OBJECT !== input.objectName
  )
    throw new Error("NUMBER_RANGE_DEFINITION_MISMATCH")
  const properties = definition.definition.properties
  if (!["", "X"].includes(properties.YEARIND ?? "?") || properties.DTELSOBJ === undefined)
    throw new Error("NUMBER_RANGE_DEFINITION_UNVERIFIED")
  if (!properties.DTELSOBJ && input.subobject !== "")
    throw new Error("NUMBER_RANGE_SUBOBJECT_UNSUPPORTED")
  if (!allYears && properties.YEARIND === "" && input.year !== "0000")
    throw new Error("NUMBER_RANGE_YEAR_UNSUPPORTED")
  const sources: ReviewedReaderSource[] = [],
    warnings: string[] = []
  const read = createReviewedTableReader(
    backend,
    input.connectionId,
    () => readFunction("RFC_READ_TABLE"),
    sources,
    warnings
  )
  const filters: Record<string, string> = {
    CLIENT: client,
    OBJECT: input.objectName,
    SUBOBJECT: input.subobject
  }
  if (!allYears) {
    filters.TOYEAR = input.year
    if (input.intervalNumber) filters.NRRANGENR = input.intervalNumber
  }
  const key = (row: ReviewedRow) =>
    allYears ? JSON.stringify([row.NRRANGENR, row.TOYEAR]) : row.NRRANGENR!
  const canonical = (rows: ReviewedRow[]) =>
    rows.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
  const observe = () =>
    read({
      table: "NRIV",
      fields: numberRangeIntervalFields,
      filters,
      maximum: input.maxIntervals,
      codePrefix: "NUMBER_RANGE_",
      mapError: (error) =>
        error instanceof Error && /^NUMBER_RANGE_[A-Z_]+$/.test(error.message)
          ? error.message
          : "NUMBER_RANGE_QUERY_FAILED",
      validate: (rows) => {
        const keys = new Set<string>()
        for (const row of rows) {
          if (
            !/^\d{20}$/.test(row.NRLEVEL!) ||
            !["", "X"].includes(row.EXTERNIND!) ||
            !/^[A-Za-z0-9]{1,2}$/.test(row.NRRANGENR!) ||
            row.FROMNUMBER!.length > 20 ||
            row.TONUMBER!.length > 20 ||
            (allYears &&
              (!/^\d{4}$/.test(row.TOYEAR!) ||
                (properties.YEARIND === "" ? row.TOYEAR !== "0000" : row.TOYEAR! <= "1900")))
          )
            throw new Error("NUMBER_RANGE_RESPONSE_INVALID")
          if (keys.has(key(row))) throw new Error("NUMBER_RANGE_DUPLICATE_INTERVAL")
          keys.add(key(row))
        }
      }
    })
  const first = await observe()
  const firstTruncated = sources.at(-1)?.status === "truncated"
  const second = first !== null && !firstTruncated ? await observe() : null
  const truncated = sources.some((source) => source.status === "truncated")
  await verifyLayout()
  const confirmation = definitionSchema.parse(await readObject(input.objectName))
  if (
    confirmation.objectName !== input.objectName ||
    confirmation.definition.properties.OBJECT !== input.objectName
  )
    throw new Error("NUMBER_RANGE_DEFINITION_MISMATCH")
  const definitionChanged =
    confirmation.fingerprint !== definition.fingerprint ||
    confirmation.version !== definition.version
  const valuesChanged =
    first !== null &&
    second !== null &&
    JSON.stringify(canonical(first)) !== JSON.stringify(canonical(second))
  const unavailable = first === null || (!firstTruncated && second === null)
  const changed = definitionChanged || valuesChanged
  const intervals = changed || unavailable ? null : canonical(first!)
  const complete = intervals !== null && !truncated
  return {
    connectionId: input.connectionId,
    client,
    objectName: input.objectName,
    subobject: input.subobject,
    year: allYears ? null : input.year,
    status: changed
      ? "changed"
      : unavailable
        ? "unavailable"
        : truncated
          ? "partial"
          : intervals!.length
            ? "read"
            : "not_found",
    readOnly: true,
    saveAvailable: false,
    intervals,
    definition: definition.definition,
    definitionFingerprint: definition.fingerprint,
    readFingerprint: complete
      ? createHash("sha256")
          .update(
            JSON.stringify({
              client,
              objectName: input.objectName,
              subobject: input.subobject,
              year: allYears ? null : input.year,
              intervalNumber: allYears ? null : (input.intervalNumber ?? null),
              definition: definition.fingerprint,
              intervals
            })
          )
          .digest("hex")
      : null,
    complete,
    truncated,
    representation: "sap_text_trimmed",
    currentLevelMeaning: "persisted_NRIV_NRLEVEL_only",
    evidence: {
      startedAt,
      finishedAt: new Date().toISOString(),
      sources,
      warnings,
      layoutFingerprint: numberRangeIntervalLayout,
      definitionsRechecked: true,
      valuesRechecked: second !== null && !changed && !truncated,
      snapshot: false
    },
    warnings: [
      "No number allocation API is called. Persisted NRLEVEL does not attest buffered next numbers or availability; no Number conversion is applied.",
      allYears
        ? "Exact customer object and literal subobject across all years only; empty subobject is not a wildcard. Sequential bounded reads do not establish an atomic snapshot, master-data existence or business-use safety. No interval maintenance, current-level reset or transport operation."
        : "Exact customer object, subobject and year only. Reads are sequential; limits and changes do not establish a complete snapshot. No interval maintenance, current-level reset or transport operation."
    ]
  }
}
