import { createHash } from "node:crypto"
import { z } from "zod"
import { assertTableAllowed, TABLE_TIERS } from "./table-allowlist.js"
import { configurationImgDetailLanguage } from "./configuration-img-details.js"
import type { findConfigurationActivities } from "./configuration-img.js"

const identifier = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]{0,29}$/)
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/)
export const configurationObjectSchema = z
  .object({
    connectionId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,100}$/)
      .transform((v) => v.toLowerCase()),
    objectName: identifier,
    expectedDefinitionFingerprint: fingerprint.optional()
  })
  .strict()

export const configurationDescriptorSchema = configurationObjectSchema.extend({
  includeImg: z.boolean().default(false),
  language: configurationImgDetailLanguage.optional()
})

const objectEvidence = z.object({
  connectionId: z.string(),
  objectKind: z.string(),
  objectName: identifier,
  version: z.string().min(1),
  fingerprint,
  status: z.string().optional(),
  active: z.boolean().optional()
})
const tableEvidence = objectEvidence.extend({
  objectKind: z.literal("transparentTable"),
  packageName: z.string(),
  definition: z.object({
    tableClass: z.literal("TRANSP"),
    description: z.string(),
    deliveryClass: z.string(),
    dataBrowserMaintenance: z.enum(["allowed", "restricted", "notAllowed"]),
    fields: z
      .array(
        z.object({
          name: identifier,
          position: z.number().int().positive(),
          key: z.boolean(),
          dataElement: z.string(),
          description: z.string(),
          referenceTable: z.string().optional(),
          referenceField: z.string().optional()
        })
      )
      .min(1)
      .max(64)
  })
})
const metadataEvidence = z.object({
  connectionId: z.string(),
  tableName: z.literal("DD03L"),
  status: z.literal("ok"),
  readOnly: z.literal(true),
  truncated: z.literal(false),
  returnedCount: z.number().int(),
  data: z
    .array(
      z
        .object({
          TABNAME: identifier,
          AS4LOCAL: z.literal("A"),
          FIELDNAME: identifier,
          DATATYPE: z.string().min(1),
          LENG: z.string().regex(/^\d{1,6}$/),
          DECIMALS: z.string().regex(/^\d{1,6}$/)
        })
        .strict()
    )
    .min(1)
    .max(64)
})
const elementEvidence = objectEvidence.extend({
  objectKind: z.literal("dataElement"),
  definition: z.object({ domainName: z.string() })
})
const domainEvidence = objectEvidence.extend({
  objectKind: z.literal("domain"),
  definition: z.object({
    dataType: z.string().min(1),
    length: z.number().int().positive(),
    decimals: z.number().int().nonnegative(),
    lowercase: z.boolean(),
    conversionExit: z.string(),
    valueTable: z.string(),
    fixedValues: z
      .array(z.object({ low: z.string(), high: z.string(), description: z.string() }))
      .max(500)
  })
})

function assertEvidence(
  evidence: z.infer<typeof objectEvidence>,
  connectionId: string,
  name: string
) {
  if (
    evidence.connectionId !== connectionId ||
    evidence.objectName !== name ||
    evidence.active === false ||
    (evidence.status !== undefined && evidence.status !== "ok")
  )
    throw new Error(`CONFIGURATION_OBJECT_EVIDENCE_MISMATCH: ${name}`)
}

/** Metadata only: the existing customizing tier grants no configuration write authority. */
export async function describeConfigurationObject(
  raw: unknown,
  client: string,
  readDefinition: (name: string) => Promise<unknown>,
  readMetadata: (query: unknown) => Promise<unknown>,
  readElement: (name: string) => Promise<unknown>,
  readDomain: (name: string) => Promise<unknown>,
  readImg?: () => Promise<Awaited<ReturnType<typeof findConfigurationActivities>>>
) {
  const input = configurationDescriptorSchema.parse(raw)
  if (input.language && !input.includeImg)
    throw new Error("CONFIGURATION_OBJECT_IMG_OPTIONS_INVALID")
  if (
    input.includeImg &&
    (input.connectionId !== "w200" ||
      client !== "200" ||
      !["T006", "T006A"].includes(input.objectName))
  )
    throw new Error("CONFIGURATION_OBJECT_IMG_SCOPE_UNSUPPORTED")
  assertTableAllowed(input.objectName)
  if (!(TABLE_TIERS.customizing as readonly string[]).includes(input.objectName))
    throw new Error("CONFIGURATION_OBJECT_SCOPE_UNSUPPORTED: only the approved customizing tier")
  z.string()
    .regex(/^\d{3}$/)
    .parse(client)
  const startedAt = new Date().toISOString()
  const readTable = async () => {
    const rawTable = await readDefinition(input.objectName)
    const envelope = z
      .object({
        status: z.string().optional(),
        active: z.boolean().optional(),
        definition: z.object({ fields: z.array(z.object({ name: z.string() })) }).optional()
      })
      .parse(rawTable)
    if (envelope.status === "not-found") throw new Error("CONFIGURATION_OBJECT_NOT_FOUND")
    if (envelope.active === false) throw new Error("CONFIGURATION_OBJECT_INACTIVE")
    if (
      envelope.definition &&
      (envelope.definition.fields.length > 64 ||
        envelope.definition.fields.some((f) => !identifier.safeParse(f.name).success))
    )
      throw new Error(
        "CONFIGURATION_OBJECT_LAYOUT_UNSUPPORTED: maximum 64 flat fields; no Include/Append markers"
      )
    const result = tableEvidence.parse(rawTable)
    assertEvidence(result, input.connectionId, input.objectName)
    return result
  }
  // ponytail: 64 flat fields bound metadata/API calls; expand only with a reviewed read budget.
  const table = await readTable()
  if (
    input.expectedDefinitionFingerprint &&
    input.expectedDefinitionFingerprint !== table.fingerprint
  )
    throw new Error("CONFIGURATION_OBJECT_DEFINITION_CHANGED")
  const fields = [...table.definition.fields].sort((a, b) => a.position - b.position)
  if (
    new Set(fields.map((f) => f.name)).size !== fields.length ||
    new Set(fields.map((f) => f.position)).size !== fields.length ||
    !fields.some((f) => f.key)
  )
    throw new Error("CONFIGURATION_OBJECT_FIELDS_INVALID")
  const query = {
    connectionId: input.connectionId,
    tableName: "DD03L",
    columns: ["TABNAME", "AS4LOCAL", "FIELDNAME", "DATATYPE", "LENG", "DECIMALS"],
    filters: [
      { column: "TABNAME", operator: "EQ", value: input.objectName },
      { column: "AS4LOCAL", operator: "EQ", value: "A" }
    ],
    maxRows: 65
  }
  const rawMetadata = await readMetadata(query)
  const metadataStatus = z
    .object({ status: z.string(), code: z.string().optional() })
    .parse(rawMetadata)
  if (metadataStatus.status !== "ok")
    throw new Error(
      `CONFIGURATION_OBJECT_METADATA_UNAVAILABLE: ${metadataStatus.code ?? metadataStatus.status}`
    )
  const metadata = metadataEvidence.parse(rawMetadata)
  if (
    metadata.connectionId !== input.connectionId ||
    metadata.returnedCount !== fields.length ||
    metadata.data.length !== fields.length ||
    new Set(metadata.data.map((f) => f.FIELDNAME)).size !== fields.length ||
    metadata.data.some(
      (f) => f.TABNAME !== input.objectName || !fields.some((v) => v.name === f.FIELDNAME)
    )
  )
    throw new Error("CONFIGURATION_OBJECT_METADATA_MISMATCH")

  const elements = new Map<string, z.infer<typeof elementEvidence>>()
  const domains = new Map<string, z.infer<typeof domainEvidence>>()
  for (const field of fields) {
    if (!field.dataElement || elements.has(field.dataElement)) continue
    const name = identifier.parse(field.dataElement)
    const element = elementEvidence.parse(await readElement(name))
    assertEvidence(element, input.connectionId, name)
    elements.set(name, element)
    if (!element.definition.domainName || domains.has(element.definition.domainName)) continue
    const domainName = identifier.parse(element.definition.domainName)
    const domain = domainEvidence.parse(await readDomain(domainName))
    assertEvidence(domain, input.connectionId, domainName)
    domains.set(domainName, domain)
  }
  const describedFields = fields.map((field) => {
    const scalar = metadata.data.find((f) => f.FIELDNAME === field.name)!
    const element = elements.get(field.dataElement)
    const domain = element ? domains.get(element.definition.domainName) : undefined
    if (
      Number(scalar.LENG) < 1 ||
      (domain &&
        (domain.definition.dataType !== scalar.DATATYPE ||
          domain.definition.length !== Number(scalar.LENG) ||
          domain.definition.decimals !== Number(scalar.DECIMALS)))
    )
      throw new Error(`CONFIGURATION_OBJECT_TYPE_MISMATCH: ${field.name}`)
    return {
      ...field,
      dataType: scalar.DATATYPE,
      length: Number(scalar.LENG),
      decimals: Number(scalar.DECIMALS),
      domainName: element ? element.definition.domainName : null,
      domainMetadataStatus: domain ? "read" : element ? "no_domain" : "unknown",
      foreignKey: { status: "unknown", reason: "DDIC foreign-key relationship was not read" }
    }
  })
  if (input.includeImg && !readImg) throw new Error("CONFIGURATION_OBJECT_IMG_UNAVAILABLE")
  const img = input.includeImg ? await readImg!() : null
  if (
    img &&
    (img.connectionId !== input.connectionId ||
      img.objectName !== input.objectName ||
      img.definitionFingerprint !== table.fingerprint ||
      !img.readOnly ||
      img.saveAvailable)
  )
    throw new Error("CONFIGURATION_OBJECT_IMG_EVIDENCE_MISMATCH")
  const confirmation = await readTable()
  if (confirmation.fingerprint !== table.fingerprint || confirmation.version !== table.version)
    throw new Error("CONFIGURATION_OBJECT_DEFINITION_CHANGED")
  const primaryKey = describedFields.filter((f) => f.key).map((f) => f.name)
  const clientFields = describedFields.filter((f) => f.dataType === "CLNT")
  const clientDependency =
    clientFields.length === 0
      ? "independent"
      : clientFields.length === 1 && describedFields[0] === clientFields[0] && clientFields[0]!.key
        ? "dependent"
        : "unknown"
  const descriptor = {
    connectionId: input.connectionId,
    sessionClient: client,
    objectName: input.objectName,
    objectKind: table.objectKind,
    packageName: table.packageName,
    definitionVersion: table.version,
    definitionFingerprint: table.fingerprint,
    description: table.definition.description,
    deliveryClass: table.definition.deliveryClass,
    dataBrowserMaintenance: table.definition.dataBrowserMaintenance,
    scope: { tier: "customizing", metadataOnly: true },
    clientDependency,
    clientField: clientDependency === "dependent" ? clientFields[0]!.name : null,
    primaryKey,
    businessKey:
      clientDependency === "unknown"
        ? null
        : primaryKey.filter(
            (name) => clientDependency !== "dependent" || name !== clientFields[0]!.name
          ),
    languageKeyFields: describedFields
      .filter((f) => f.key && f.dataType === "LANG")
      .map((f) => f.name),
    timeDependency: {
      status: "unknown",
      dateFields: describedFields.filter((f) => f.dataType === "DATS").map((f) => f.name)
    },
    fields: describedFields,
    dataElements: [...elements.values()],
    domains: [...domains.values()],
    maintenanceRoute: {
      status: "unknown",
      reason: img
        ? "IMG mapping was read; no official maintenance API was established"
        : "No official maintenance API or maintenance-object mapping was established"
    },
    img: img ?? {
      status: "unknown",
      reason: "IMG activities, paths, transactions and documentation were not read"
    },
    transportPolicy: {
      status: "unknown",
      reason: "Request/task types, client recording policy and E071K key encoding were not verified"
    },
    capabilities: { describe: true, readValues: false, preview: false, apply: false },
    writeRefusalReasons: [
      "MAINTENANCE_API_NOT_VERIFIED",
      "BUSINESS_RULES_NOT_VERIFIED",
      "CTS_KEY_RECORDING_NOT_VERIFIED"
    ]
  }
  return {
    ...descriptor,
    descriptorFingerprint: createHash("sha256").update(JSON.stringify(descriptor)).digest("hex"),
    status: "partial",
    readOnly: true,
    saveAvailable: false,
    evidence: {
      startedAt,
      finishedAt: new Date().toISOString(),
      snapshot: false,
      sources: [
        "read_ddic_transparent_table",
        "read_abap_table(DD03L)",
        "read_ddic_data_element",
        "read_ddic_domain"
      ],
      definitionRechecked: true,
      missing: [
        "foreign_keys",
        "business_semantics",
        "maintenance_route",
        ...(img ? ["complete_img_paths", "documentation_content"] : ["img_mapping"]),
        "cts_policy"
      ]
    },
    warnings: [
      "DDIC maintenance permission and delivery class do not authorize writes or prove a maintenance API.",
      "Sequential metadata reads are not an atomic snapshot; the recheck guards only the table definition."
    ]
  }
}
