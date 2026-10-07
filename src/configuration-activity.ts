import { z } from "zod"
import type { SapBackend } from "./backend.js"
import { configurationObjectSchema } from "./configuration-object.js"
import {
  configurationImgDetailLanguage,
  readConfigurationImgActivityDetails
} from "./configuration-img-details.js"
import { createReviewedTableReader, type ReviewedReaderSource } from "./reviewed-table-reader.js"

export const configurationActivitySchema = configurationObjectSchema
  .pick({ connectionId: true })
  .extend({
    activityId: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9_/]{1,20}$/),
    language: configurationImgDetailLanguage.optional()
  })

export const configurationActivityLayouts = {
  CUS_IMGACH: "66dc39d4bb427dcd68ec903287450f811dcd71eee8933a11e322e14783b6af6a",
  CUS_ACTOBJ: "b07c51f5e069ebdd1814afd6f33b2d49bca96baa5f312399a8354c2be0b746a1"
} as const
export const configurationActivityHeaderFields = [
  "ACTIVITY",
  "DOCU_ID",
  "ATTRIBUTES",
  "C_ACTIVITY",
  "TCODE"
]
const objectFields = [
  "ACT_ID",
  "OBJECTTYPE",
  "OBJECTNAME",
  "TCODE",
  "SUBOBJNAME",
  "VARIANT",
  "TXN_NO_CON",
  "IMG_POS",
  "SUPRESS_FL"
]
const codeOf = (error: unknown) =>
  error instanceof Error && /^CONFIGURATION_ACTIVITY_[A-Z_]+$/.test(error.message)
    ? error.message
    : "CONFIGURATION_ACTIVITY_QUERY_FAILED"

/** Dedicated exact IMG metadata reader; never grants access to configuration values or execution. */
export async function readConfigurationActivity(
  raw: unknown,
  client: string,
  defaultLanguage: string,
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  readTable: (name: string) => Promise<unknown>,
  readFunction: (name: string) => Promise<unknown>
) {
  const layouts = configurationActivityLayouts,
    headerFields = configurationActivityHeaderFields
  const input = configurationActivitySchema.parse(raw)
  if (input.connectionId !== "w200" || client !== "200")
    throw new Error("CONFIGURATION_ACTIVITY_SCOPE_UNSUPPORTED")
  const language = configurationImgDetailLanguage.parse(input.language ?? defaultLanguage)
  const sources: ReviewedReaderSource[] = []
  const warnings: string[] = []
  const verified = new Set<keyof typeof layouts>()
  const verify = async (name: keyof typeof layouts) => {
    if (
      !z
        .object({
          connectionId: z.literal(input.connectionId),
          objectName: z.literal(name),
          objectKind: z.literal("transparentTable"),
          active: z.literal(true).optional(),
          fingerprint: z.literal(layouts[name])
        })
        .safeParse(await readTable(name)).success
    )
      throw new Error("CONFIGURATION_ACTIVITY_LAYOUT_UNVERIFIED")
  }
  const reader = createReviewedTableReader(
    backend,
    input.connectionId,
    () => readFunction("RFC_READ_TABLE"),
    sources,
    warnings
  )
  const read = async (
    table: keyof typeof layouts,
    fields: string[],
    filters: Record<string, string>,
    maximum: number
  ) => {
    if (!verified.has(table)) {
      await verify(table)
      verified.add(table)
    }
    const rows = await reader({
      table,
      fields,
      filters,
      maximum,
      codePrefix: "CONFIGURATION_ACTIVITY_",
      mapError: codeOf
    })
    if (rows === null) throw new Error(sources.at(-1)?.code ?? "CONFIGURATION_ACTIVITY_UNAVAILABLE")
    if (sources.at(-1)?.status === "truncated")
      throw new Error("CONFIGURATION_ACTIVITY_LIMIT_EXCEEDED")
    return rows
  }
  const headers = await read("CUS_IMGACH", headerFields, { ACTIVITY: input.activityId }, 1)
  const header = headers[0]
  if (header && (!/^[A-Z0-9_/]{0,20}$/.test(header.C_ACTIVITY!) || header.DOCU_ID!.length > 64))
    throw new Error("CONFIGURATION_ACTIVITY_RESPONSE_INVALID")
  let maintenanceObjects: { status: string; objects: Record<string, string>[]; code?: string }
  if (!header) maintenanceObjects = { status: "header_not_found", objects: [] }
  else if (!header.C_ACTIVITY)
    maintenanceObjects = { status: "no_customizing_activity", objects: [] }
  else {
    try {
      // S_CUS_IMG_ACTIVITY_GET_OBJECTS uses precisely CUS_IMGACH.C_ACTIVITY -> CUS_ACTOBJ.ACT_ID.
      // ponytail: cap one activity's associations at 16; add pagination when real evidence requires it.
      const objects = await read("CUS_ACTOBJ", objectFields, { ACT_ID: header.C_ACTIVITY }, 16)
      const unique = [...new Map(objects.map((row) => [JSON.stringify(row), row])).values()]
      unique.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      maintenanceObjects = { status: unique.length ? "read" : "not_found", objects: unique }
    } catch (error) {
      maintenanceObjects = { status: "unavailable", code: codeOf(error), objects: [] }
    }
  }
  // An absent header must not suppress an independently stored title or node reference.
  const details = await readConfigurationImgActivityDetails(
    input.connectionId,
    client,
    language,
    [{ ACTIVITY: input.activityId, DOCU_ID: header?.DOCU_ID ?? "" }],
    backend,
    readTable,
    readFunction
  )
  const confirmation = await read("CUS_IMGACH", headerFields, { ACTIVITY: input.activityId }, 1)
  if (JSON.stringify(confirmation) !== JSON.stringify(headers))
    throw new Error("CONFIGURATION_ACTIVITY_HEADER_CHANGED")
  for (const table of verified) await verify(table)
  const detail = details.activities[0]
  return {
    connectionId: input.connectionId,
    activityId: input.activityId,
    status: "partial",
    readOnly: true,
    saveAvailable: false,
    header: { status: header ? "read" : "not_found", table: "CUS_IMGACH", value: header ?? null },
    title: detail?.title ?? {
      status: "unavailable",
      code: "code" in details ? details.code : "CONFIGURATION_IMG_DETAIL_UNAVAILABLE"
    },
    path: detail?.path ?? { status: "unavailable", complete: false },
    documentation: header
      ? (detail?.documentation ?? { status: "unknown" })
      : { status: "header_not_found", reference: null, readability: "unknown" },
    maintenanceObjects,
    maintenanceRoute: {
      status: "metadata_only",
      executionAvailable: false,
      businessApi: "unknown"
    },
    evidence: {
      sources,
      warnings,
      details: Object.fromEntries(Object.entries(details).filter(([k]) => k !== "activities")),
      definitionsRechecked: true,
      headerRechecked: true,
      snapshot: false
    },
    warnings: [
      "Exact activity identifier only; document identifiers, transactions and physical node identifiers are not interchangeable.",
      "Missing headers or references do not prove global absence. Paths cover reviewed physical structures only; complete SPRO visibility remains unverified.",
      "Maintenance objects are metadata associations, not verified executable APIs or authorization to read/change their configuration. No CTS or business validation attestation."
    ]
  }
}
