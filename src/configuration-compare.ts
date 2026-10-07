import { z } from "zod"
import {
  configurationUnitSchema,
  configurationUnitFields,
  type readConfigurationUnitProjection
} from "./configuration-unit.js"

const comparableFields = Object.entries(configurationUnitFields).flatMap(([table, fields]) =>
  fields
    .filter((field) => !["MANDT", "MSEHI", "SPRAS"].includes(field))
    .map((field) => `${table}.${field}`)
)
export const configurationUnitCompareInputSchema = z
  .object({
    from: z.enum(["w200", "w300"]),
    to: z.enum(["w200", "w300"]),
    unitKey: configurationUnitSchema.shape.unitKey,
    language: configurationUnitSchema.shape.language.unwrap(),
    ignoreFields: z
      .array(
        z
          .string()
          .refine(
            (field) => comparableFields.includes(field),
            "Only projected non-key fields may be ignored"
          )
      )
      .max(comparableFields.length)
      .default([])
  })
  .strict()

export const configurationUnitCompareSchema = configurationUnitCompareInputSchema.refine(
  (input) => input.from !== input.to,
  "Select two distinct systems"
)

export async function compareConfigurationUnit(
  raw: unknown,
  read: (
    connectionId: string,
    unitKey: string,
    language: string
  ) => ReturnType<typeof readConfigurationUnitProjection>
) {
  const input = configurationUnitCompareSchema.parse(raw)
  const startedAt = new Date().toISOString()
  const observe = async (connectionId: string) => {
    try {
      return {
        status: "observed" as const,
        result: await read(connectionId, input.unitKey, input.language)
      }
    } catch {
      return {
        status: "unavailable" as const,
        result: null,
        code: "CONFIGURATION_COMPARE_SIDE_UNAVAILABLE"
      }
    }
  }
  const from = await observe(input.from),
    to = await observe(input.to)
  const parts = ["unit", "text"] as const
  const ignored = [...new Set(input.ignoreFields)].sort()
  const rows: {
    table: string
    key: Record<string, string>
    status: string
    differences: { field: string; from: string; to: string }[]
  }[] = []
  for (const part of parts) {
    const table = part === "unit" ? "T006" : "T006A"
    const a = from.result?.[part],
      b = to.result?.[part]
    const readable = (value: typeof a) =>
      value !== undefined && ["read", "not_found"].includes(value.status)
    let status = "incomparable"
    const differences: { field: string; from: string; to: string }[] = []
    if (readable(a) && readable(b)) {
      if (a!.status === "not_found" || b!.status === "not_found")
        status =
          a!.status === b!.status
            ? "absent_in_both"
            : a!.status === "not_found"
              ? "to_only"
              : "from_only"
      else {
        for (const field of configurationUnitFields[table]) {
          if (["MANDT", "MSEHI", "SPRAS"].includes(field) || ignored.includes(`${table}.${field}`))
            continue
          if (a!.data![field] !== b!.data![field])
            differences.push({ field, from: a!.data![field]!, to: b!.data![field]! })
        }
        status = differences.length ? "different" : "equal_projection"
      }
    }
    rows.push({
      table,
      key:
        part === "unit"
          ? { MSEHI: input.unitKey }
          : { MSEHI: input.unitKey, language: input.language },
      status,
      differences
    })
  }
  return {
    from: input.from,
    to: input.to,
    unitKey: input.unitKey,
    language: input.language,
    status: rows.some((row) => row.status === "incomparable") ? "incomparable" : "partial",
    readOnly: true,
    saveAvailable: false,
    rows,
    observations: { from, to },
    rules: {
      key: "internal_case_sensitive_MSEHI_plus_ISO_language_for_text",
      client: "each_connection_client_filter; MANDT_not_compared",
      language: "explicit_ISO_language; local_SPRAS_not_compared; no_fallback",
      ignoredFields: ignored,
      derivedFields: [],
      omittedFields: { T006: ["TEMP_VALUE", "PRESS_VAL"], T006A: [] },
      representation: "sap_text_trimmed"
    },
    evidence: { startedAt, finishedAt: new Date().toISOString(), snapshot: false, complete: false },
    warnings: [
      "Only one exact internal unit key and one explicit language are compared. Equality covers projected fields only; FLTP fields and other languages are omitted.",
      "Sequential reads are not an atomic cross-system snapshot. Failed or changed reads remain incomparable; no synchronization or transport is performed."
    ]
  }
}
