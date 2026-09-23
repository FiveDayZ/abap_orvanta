import { createHash } from "node:crypto"
import { z } from "zod"
import { CUSTOMER_CONNECTION_ID } from "./customer-scope.js"

export const CONFIGURATION_TABLE = "ZTPMC_TPCFG"
export const CONFIGURATION_DDIC = "4c617b912277d9d19b9e0bd8760dbfd53c541adb2129b30a5b040bb6cdd537ed"
export const CONFIGURATION_MODE_DOMAIN = "ZPMCDO_TP_MODE"
export const CONFIGURATION_MODE_FINGERPRINT =
  "f5c684b93e738169493fa2525211d125ed9d90085193f3e0bffdd5f9f122fff7"
export const CONFIGURATION_TYPES = [
  ["MANDT", "CLNT", 3, "MANDT"],
  ["WERKS_D", "CHAR", 4, "WERKS"],
  ["ZPMCEL_TP_ACTIVE", "CHAR", 1, ""],
  ["ZPMCEL_TP_MODE", "CHAR", 1, "ZPMCDO_TP_MODE"],
  ["DATAB", "DATS", 8, "DATUM"],
  ["DATBI", "DATS", 8, "DATUM"],
  ["ZPMCEL_TP_CFGVERS", "NUMC", 6, ""],
  ["AENAM", "CHAR", 12, "USNAM"],
  ["AEDAT", "DATS", 8, "DATUM"],
  ["AEZET", "TIMS", 6, "UZEIT"]
] as const
const metadataRow = z
  .object({
    ROLLNAME: z.string(),
    DATATYPE: z.string(),
    LENG: z.string().regex(/^\d{1,6}$/),
    DECIMALS: z.string().regex(/^\d{1,6}$/),
    DOMNAME: z.string()
  })
  .strict()
const fields = [
  "MANDT",
  "WERKS",
  "ACTIVE",
  "TPMODE",
  "DATAB",
  "DATBI",
  "CFGVERS",
  "AENAM",
  "AEDAT",
  "AEZET"
]
const date = z
  .string()
  .refine(
    (v) =>
      v === "00000000" ||
      (/^\d{8}$/.test(v) &&
        v.slice(0, 4) !== "0000" &&
        Number.isFinite(
          Date.parse(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T00:00:00Z`)
        ) &&
        new Date(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T00:00:00Z`)
          .toISOString()
          .slice(0, 10)
          .replaceAll("-", "") === v),
    "Expected valid YYYYMMDD or initial 00000000"
  )
const character = z
  .string()
  .max(1)
  .regex(/^[\x20-\x7e]?$/)
export const configurationPreviewSchema = z
  .object({
    connectionId: z.literal(CUSTOMER_CONNECTION_ID),
    plant: z.string().regex(/^[A-Z0-9]{4}$/),
    changes: z
      .object({
        ACTIVE: character.optional(),
        TPMODE: character.transform((value) => (value === " " ? "" : value)).optional(),
        DATAB: date.optional(),
        DATBI: date.optional()
      })
      .strict()
      .default({}),
    expectedRowFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
  })
  .strict()

export async function previewConfiguration(
  raw: unknown,
  readDefinition: () => Promise<unknown>,
  readRows: (input: unknown) => Promise<unknown>,
  readTypes: (input: unknown) => Promise<unknown>,
  readModeDomain: () => Promise<unknown>
) {
  const input = configurationPreviewSchema.parse(raw)
  const definition = z
    .object({
      objectName: z.literal(CONFIGURATION_TABLE),
      fingerprint: z.literal(CONFIGURATION_DDIC)
    })
    .parse(await readDefinition())
  const typeEvidence = []
  for (const [name, type, length, domain] of CONFIGURATION_TYPES) {
    const metadata = z
      .object({
        connectionId: z.literal(CUSTOMER_CONNECTION_ID),
        tableName: z.literal("DD04L"),
        status: z.literal("ok"),
        readOnly: z.literal(true),
        returnedCount: z.literal(1),
        truncated: z.literal(false),
        data: z.array(metadataRow).length(1)
      })
      .safeParse(
        await readTypes({
          connectionId: CUSTOMER_CONNECTION_ID,
          tableName: "DD04L",
          columns: ["ROLLNAME", "DATATYPE", "LENG", "DECIMALS", "DOMNAME"],
          filters: [
            { column: "ROLLNAME", operator: "EQ", value: name },
            { column: "AS4LOCAL", operator: "EQ", value: "A" }
          ],
          maxRows: 2
        })
      )
    if (!metadata.success) throw new Error(`CONFIGURATION_TYPE_METADATA_UNAVAILABLE: ${name}`)
    const row = metadata.data.data[0]!
    if (
      row.ROLLNAME !== name ||
      row.DATATYPE !== type ||
      Number(row.LENG) !== length ||
      Number(row.DECIMALS) !== 0 ||
      row.DOMNAME !== domain
    )
      throw new Error(`CONFIGURATION_TYPE_METADATA_CHANGED: ${name}`)
    typeEvidence.push({
      dataElement: name,
      dataType: type,
      length,
      decimals: 0,
      domainName: domain
    })
  }
  const modeDomain = z
    .object({
      connectionId: z.literal(CUSTOMER_CONNECTION_ID),
      objectKind: z.literal("domain"),
      objectName: z.literal(CONFIGURATION_MODE_DOMAIN),
      fingerprint: z.literal(CONFIGURATION_MODE_FINGERPRINT),
      definition: z.object({
        dataType: z.literal("CHAR"),
        length: z.literal(1),
        decimals: z.literal(0),
        lowercase: z.literal(false),
        conversionExit: z.literal(""),
        valueTable: z.literal(""),
        fixedValues: z
          .array(
            z.object({
              low: z.string().max(1),
              high: z.literal("")
            })
          )
          .length(3)
      })
    })
    .safeParse(await readModeDomain())
  if (!modeDomain.success) throw new Error("CONFIGURATION_MODE_DOMAIN_UNAVAILABLE_OR_CHANGED")
  const allowedValues = modeDomain.data.definition.fixedValues.map((item) => item.low).sort()
  if (JSON.stringify(allowedValues) !== JSON.stringify(["", "E", "S"]))
    throw new Error("CONFIGURATION_MODE_DOMAIN_UNAVAILABLE_OR_CHANGED")
  const proposedMode = input.changes.TPMODE
  if (proposedMode !== undefined && !allowedValues.includes(proposedMode))
    throw new Error("CONFIGURATION_DOMAIN_VALUE_INVALID: TPMODE")
  const query = {
    connectionId: input.connectionId,
    tableName: CONFIGURATION_TABLE,
    columns: fields,
    filters: [
      { column: "MANDT", operator: "EQ", value: "200" },
      { column: "WERKS", operator: "EQ", value: input.plant }
    ],
    maxRows: 2
  }
  const result = z
    .object({
      status: z.string(),
      code: z.string().optional(),
      definitionFingerprint: z.string().optional(),
      truncated: z.boolean().nullable(),
      data: z.unknown()
    })
    .parse(await readRows(query))
  const base = {
    connectionId: CUSTOMER_CONNECTION_ID,
    client: "200",
    tableName: CONFIGURATION_TABLE,
    plant: input.plant,
    readOnly: true,
    saveAvailable: false,
    validation: "structural_and_domain",
    businessValidation: "not_verified",
    snapshot: false,
    typeMetadataValidation: "matched",
    typeMetadataFingerprint: createHash("sha256")
      .update(JSON.stringify(typeEvidence))
      .digest("hex"),
    typeMetadata: typeEvidence,
    definitionFingerprint: definition.fingerprint,
    domainMetadata: {
      field: "TPMODE",
      domainName: CONFIGURATION_MODE_DOMAIN,
      fingerprint: modeDomain.data.fingerprint,
      allowedValues,
      scope: "fixed_values_only"
    }
  }
  if (result.status !== "ok")
    return {
      ...base,
      status: "unavailable",
      code: result.code ?? "CONFIGURATION_READ_UNAVAILABLE",
      data: null,
      differences: null
    }
  if (result.definitionFingerprint !== CONFIGURATION_DDIC || result.truncated !== false)
    throw new Error("CONFIGURATION_READ_INCOMPLETE_OR_CHANGED")
  const rows = z.array(z.record(z.string())).max(1).parse(result.data)
  if (!rows.length) return { ...base, status: "not_found", data: null, differences: null }
  const row = rows[0]!
  if (
    Object.keys(row).length !== fields.length ||
    fields.some((f) => !(f in row)) ||
    row.MANDT !== "200" ||
    row.WERKS !== input.plant
  )
    throw new Error("CONFIGURATION_SCOPE_OR_FIELDS_MISMATCH")
  const ordered = Object.fromEntries(fields.map((f) => [f, row[f]]))
  const fingerprint = createHash("sha256").update(JSON.stringify(ordered)).digest("hex")
  if (input.expectedRowFingerprint && input.expectedRowFingerprint !== fingerprint)
    return {
      ...base,
      status: "changed",
      data: null,
      differences: null,
      rowFingerprint: fingerprint
    }
  const after = { ...ordered, ...input.changes }
  const effectiveMode = after.TPMODE === " " ? "" : after.TPMODE
  if (effectiveMode === undefined || !allowedValues.includes(effectiveMode))
    throw new Error("CONFIGURATION_DOMAIN_VALUE_INVALID: TPMODE")
  date.parse(after.DATAB)
  date.parse(after.DATBI)
  if (after.DATAB !== "00000000" && after.DATBI !== "00000000" && after.DATAB! > after.DATBI!)
    throw new Error("CONFIGURATION_DATE_RANGE_INVALID")
  const differences = Object.entries(input.changes)
    .filter(([field, value]) => row[field] !== value)
    .map(([field, to]) => ({ field, from: row[field], to }))
  return {
    ...base,
    status: "preview",
    data: ordered,
    rowFingerprint: fingerprint,
    differences,
    domainValueValidation: {
      field: "TPMODE",
      effectiveValue: effectiveMode,
      status: "valid",
      currentValueValid: allowedValues.includes(row.TPMODE === " " ? "" : row.TPMODE!)
    },
    warnings: [
      "No save, locks, transport or audit changes are performed.",
      "Only TPMODE fixed domain values are validated; ACTIVE business values, mode transitions and business maintenance rules are not validated.",
      "Fingerprint covers returned values, not a transaction snapshot or authorization to write."
    ]
  }
}
