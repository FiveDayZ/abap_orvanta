import { z } from "zod"
import { createHash } from "node:crypto"
import type { SapBackend } from "./backend.js"
import { createReviewedTableReader, type ReviewedReaderSource } from "./reviewed-table-reader.js"
import { configurationObjectSchema } from "./configuration-object.js"
import { assertTableAllowed, TABLE_TIERS } from "./table-allowlist.js"

export const configurationActivitiesSchema = configurationObjectSchema.extend({
  maxActivities: z.number().int().min(1).max(100).default(20),
  resolveMaintenanceObjects: z.boolean().default(false)
})

const mappingFields = [
  "OBJECTNAME",
  "OBJECTTYPE",
  "TABNAME",
  "COVER",
  "CANDIDATE",
  "DDIC",
  "PRIM_TABLE",
  "VIEWGRANT",
  "TAB_FILLED"
] as const
const objectTypes = {
  S: "table with text table",
  V: "view",
  L: "logical transport object",
  C: "view cluster",
  T: "single transaction object",
  D: "virtual object"
} as const
const mappingRow = z.object({
  OBJECTNAME: z.string().min(1).max(30),
  OBJECTTYPE: z.enum(["S", "V", "L", "C", "T", "D"]),
  TABNAME: z.enum(["T006", "T006A"]),
  COVER: z.string(),
  CANDIDATE: z.string(),
  DDIC: z.string(),
  PRIM_TABLE: z.string(),
  VIEWGRANT: z.string(),
  TAB_FILLED: z.string()
})

/** Dedicated unit-domain metadata scope; never extends the generic read_abap_table allowlist. */
export async function resolveConfigurationMaintenanceObjects(
  connectionId: string,
  objectName: string,
  client: string,
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  readTable: (name: string) => Promise<unknown>,
  readFunction: (name: string) => Promise<unknown>
) {
  if (connectionId !== "w200" || client !== "200" || !["T006", "T006A"].includes(objectName))
    throw new Error("CONFIGURATION_IMG_MAPPING_SCOPE_UNSUPPORTED")
  const verifyLayout = async () => {
    if (
      !z
        .object({
          connectionId: z.literal(connectionId),
          objectName: z.literal("OBJS"),
          objectKind: z.literal("transparentTable"),
          active: z.literal(true).optional(),
          fingerprint: z.literal("dc1667a4e14e0d69b372ef3a7704052d5456d0542b1d45390bb1a662a5723451")
        })
        .safeParse(await readTable("OBJS")).success
    )
      throw new Error("CONFIGURATION_IMG_MAPPING_LAYOUT_UNVERIFIED")
  }
  await verifyLayout()
  const sources: ReviewedReaderSource[] = []
  const warnings: string[] = []
  const read = createReviewedTableReader(
    backend,
    connectionId,
    () => readFunction("RFC_READ_TABLE"),
    sources,
    warnings
  )
  const rawRows = await read({
    table: "OBJS",
    fields: mappingFields,
    filters: { TABNAME: objectName },
    maximum: 16,
    codePrefix: "CONFIGURATION_IMG_MAPPING_",
    mapError: (error) =>
      error instanceof Error && error.message.startsWith("CONFIGURATION_IMG_MAPPING_")
        ? error.message
        : "CONFIGURATION_IMG_MAPPING_QUERY_FAILED"
  })
  if (rawRows === null) throw new Error(sources[0]?.code ?? "CONFIGURATION_IMG_MAPPING_UNAVAILABLE")
  // ponytail: at most 16 registered objects; transaction associations are also capped at 16.
  if (sources[0]?.status === "truncated")
    throw new Error("CONFIGURATION_IMG_MAPPING_LIMIT_EXCEEDED")
  const rows = z.array(mappingRow).parse(rawRows)
  const unique = new Map<string, z.infer<typeof mappingRow>>()
  for (const row of rows) {
    const key = `${row.OBJECTTYPE}:${row.OBJECTNAME}`
    const previous = unique.get(key)
    if (previous && JSON.stringify(previous) !== JSON.stringify(row))
      throw new Error("CONFIGURATION_IMG_MAPPING_AMBIGUOUS")
    unique.set(key, row)
  }
  await verifyLayout()
  const ordered = [...unique.values()].sort((a, b) =>
    `${a.OBJECTTYPE}:${a.OBJECTNAME}`.localeCompare(`${b.OBJECTTYPE}:${b.OBJECTNAME}`)
  )
  return {
    rows: ordered,
    fingerprint: createHash("sha256").update(JSON.stringify(ordered)).digest("hex"),
    sources,
    warnings
  }
}

// Reviewed active w200/200 ECC 7.31 sources, 2026-10-02. The wrapper calls only this dependency.
export const configurationImgReaders = [
  {
    functionName: "SCOUT_IMG_ACTIVITY_GET_W_OBJ",
    remoteEnabled: true,
    interfaceFingerprint: "b8746e93647f5e6f834d6769c8c6785d4c34877dd496f4ba933499ac88011da7",
    sourceFingerprint: "c2ba743d97b04b6751680140be4aa31a5a8cfd0096acfa6481ea29393fbc104e"
  },
  {
    functionName: "S_CUS_IMG_ACTIVITY_GET_W_OBJ",
    remoteEnabled: false,
    interfaceFingerprint: "5dc4467baa2cb8414a616c57a1845554834e6609fc4de8421c68cc5ea0ef47d8",
    sourceFingerprint: "cf7bc3e4d445c7ab370066e03c266e548bb61dadbcee916465871f794979b607"
  }
] as const

const headerFields = [
  "ACTIVITY",
  "DOCU_ID",
  "ATTRIBUTES",
  "C_ACTIVITY",
  "TCODE",
  "FUSER",
  "FDATE",
  "FTIME",
  "LUSER",
  "LDATE",
  "LTIME"
]
const header = z.object({
  ACTIVITY: z.string().trim().min(1).max(20),
  DOCU_ID: z.string(),
  ATTRIBUTES: z.string(),
  C_ACTIVITY: z.string().max(20),
  TCODE: z.string()
})

/** Called only for T objects derived from the selected unit table's verified OBJS registrations. */
export async function readConfigurationTransactionActivities(
  connectionId: string,
  objectName: string,
  client: string,
  transactionName: string,
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  readTable: (name: string) => Promise<unknown>,
  readFunction: (name: string) => Promise<unknown>
) {
  if (
    connectionId !== "w200" ||
    client !== "200" ||
    !["T006", "T006A"].includes(objectName) ||
    !/^[A-Z0-9_/]{1,20}$/.test(transactionName)
  )
    throw new Error("CONFIGURATION_IMG_TRANSACTION_SCOPE_UNSUPPORTED")
  const pins = {
    TSTC: "44e8612fb2a6250584d3c6800498b7c3dd4c33de3790fc13dc0c2793e1b2ce26",
    CUS_ACTOBJ: "b07c51f5e069ebdd1814afd6f33b2d49bca96baa5f312399a8354c2be0b746a1",
    CUS_IMGACH: "66dc39d4bb427dcd68ec903287450f811dcd71eee8933a11e322e14783b6af6a"
  }
  const verify = async () => {
    for (const [name, fingerprint] of Object.entries(pins))
      if (
        !z
          .object({
            connectionId: z.literal(connectionId),
            objectName: z.literal(name),
            objectKind: z.literal("transparentTable"),
            active: z.literal(true).optional(),
            fingerprint: z.literal(fingerprint)
          })
          .safeParse(await readTable(name)).success
      )
        throw new Error("CONFIGURATION_IMG_TRANSACTION_LAYOUT_UNVERIFIED")
  }
  await verify()
  const sources: ReviewedReaderSource[] = []
  const warnings: string[] = []
  const read = createReviewedTableReader(
    backend,
    connectionId,
    () => readFunction("RFC_READ_TABLE"),
    sources,
    warnings
  )
  const required = async (
    table: string,
    fields: readonly string[],
    filters: Record<string, string>,
    maximum = 16
  ) => {
    const rows = await read({
      table,
      fields,
      filters,
      maximum,
      codePrefix: "CONFIGURATION_IMG_TRANSACTION_",
      mapError: (error) =>
        error instanceof Error && error.message.startsWith("CONFIGURATION_IMG_TRANSACTION_")
          ? error.message
          : "CONFIGURATION_IMG_TRANSACTION_QUERY_FAILED"
    })
    const source = sources[sources.length - 1]!
    if (rows === null) throw new Error(source.code ?? "CONFIGURATION_IMG_TRANSACTION_UNAVAILABLE")
    if (source.status === "truncated")
      throw new Error("CONFIGURATION_IMG_TRANSACTION_LIMIT_EXCEEDED")
    return rows
  }
  const transactions = await required("TSTC", ["TCODE", "PGMNA"], { TCODE: transactionName }, 1)
  if (transactions.length !== 1) throw new Error("CONFIGURATION_IMG_TRANSACTION_NOT_FOUND")
  // Observed S_CUS_IMG_ACTIVITY_GET_W_TCODE relationship: TCODE -> ACT_ID -> C_ACTIVITY.
  const associations = z
    .array(z.object({ ACT_ID: z.string().min(1).max(20), TCODE: z.literal(transactionName) }))
    .parse(await required("CUS_ACTOBJ", ["ACT_ID", "TCODE"], { TCODE: transactionName }))
  const rows: z.infer<typeof header>[] = []
  for (const activity of [...new Set(associations.map((row) => row.ACT_ID))].sort()) {
    const found = z.array(header).parse(
      await required("CUS_IMGACH", ["ACTIVITY", "DOCU_ID", "ATTRIBUTES", "C_ACTIVITY", "TCODE"], {
        C_ACTIVITY: activity
      })
    )
    if (found.some((row) => row.C_ACTIVITY !== activity))
      throw new Error("CONFIGURATION_IMG_TRANSACTION_SCOPE_MISMATCH")
    rows.push(...found)
  }
  await verify()
  return {
    rows,
    sources,
    warnings,
    transaction: transactions[0]!,
    method: "transaction_metadata_join" as const
  }
}

export async function findConfigurationActivities(
  raw: unknown,
  backend: Pick<SapBackend, "callRemoteFunction">,
  readFunction: (name: string) => Promise<unknown>,
  readTable: (name: string) => Promise<unknown>,
  resolveObjects?: (
    objectName: string
  ) => Promise<Awaited<ReturnType<typeof resolveConfigurationMaintenanceObjects>>>,
  readTransaction?: (
    transactionName: string
  ) => Promise<Awaited<ReturnType<typeof readConfigurationTransactionActivities>>>
) {
  const input = configurationActivitiesSchema.parse(raw)
  if (
    input.resolveMaintenanceObjects &&
    (input.connectionId !== "w200" || !["T006", "T006A"].includes(input.objectName))
  )
    throw new Error("CONFIGURATION_IMG_MAPPING_SCOPE_UNSUPPORTED")
  assertTableAllowed(input.objectName)
  if (!(TABLE_TIERS.customizing as readonly string[]).includes(input.objectName))
    throw new Error("CONFIGURATION_IMG_SCOPE_UNSUPPORTED")
  const definition = z.object({
    connectionId: z.literal(input.connectionId),
    objectName: z.literal(input.objectName),
    objectKind: z.literal("transparentTable"),
    active: z.literal(true).optional(),
    version: z.string().min(1),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    definition: z.object({ tableClass: z.literal("TRANSP") })
  })
  const table = definition.parse(await readTable(input.objectName))
  if (
    input.expectedDefinitionFingerprint &&
    input.expectedDefinitionFingerprint !== table.fingerprint
  )
    throw new Error("CONFIGURATION_IMG_DEFINITION_CHANGED")
  const verifyReaders = async () => {
    for (const pin of configurationImgReaders) {
      const current = await readFunction(pin.functionName)
      if (
        !z
          .object({
            connectionId: z.literal(input.connectionId),
            functionName: z.literal(pin.functionName),
            remoteEnabled: z.literal(pin.remoteEnabled),
            updateTask: z.literal(false),
            interfaceFingerprint: z.literal(pin.interfaceFingerprint),
            sourceFingerprint: z.literal(pin.sourceFingerprint)
          })
          .safeParse(current).success
      )
        throw new Error("CONFIGURATION_IMG_API_UNVERIFIED")
    }
    if (
      !z
        .object({
          connectionId: z.literal(input.connectionId),
          objectName: z.literal("CUS_IMGACH"),
          objectKind: z.literal("transparentTable"),
          fingerprint: z.literal("66dc39d4bb427dcd68ec903287450f811dcd71eee8933a11e322e14783b6af6a")
        })
        .safeParse(await readTable("CUS_IMGACH")).success
    )
      throw new Error("CONFIGURATION_IMG_LAYOUT_UNVERIFIED")
  }
  if (input.resolveMaintenanceObjects && !resolveObjects)
    throw new Error("CONFIGURATION_IMG_MAPPING_UNAVAILABLE")
  const mapping = input.resolveMaintenanceObjects ? await resolveObjects!(input.objectName) : null
  const objects = mapping
    ? mapping.rows
    : [{ OBJECTNAME: input.objectName, OBJECTTYPE: "S" as const }]
  await verifyReaders()
  const activities = new Map<string, z.infer<typeof header>>()
  const routes = new Map<string, Set<string>>()
  const lookups: {
    objectName: string
    objectType: string
    status: string
    faultName?: string
    method?: string
    sources?: ReviewedReaderSource[]
    transaction?: Record<string, string>
  }[] = []
  for (const object of objects) {
    let found: z.infer<typeof header>[]
    if (mapping && object.OBJECTTYPE === "T") {
      if (!readTransaction) throw new Error("CONFIGURATION_IMG_TRANSACTION_UNAVAILABLE")
      const result = await readTransaction(object.OBJECTNAME)
      found = result.rows
      lookups.push({
        objectName: object.OBJECTNAME,
        objectType: object.OBJECTTYPE,
        status: found.length ? "read" : "empty",
        method: result.method,
        sources: result.sources,
        transaction: result.transaction
      })
    } else {
      const result = await backend.callRemoteFunction(input.connectionId, {
        functionName: configurationImgReaders[0].functionName,
        inputParameters: { OBJECTNAME: object.OBJECTNAME, OBJECTTYPE: object.OBJECTTYPE },
        outputParameters: [{ name: "ACTIVITIES_FOUND", kind: "table", fields: headerFields }]
      })
      // The wrapper also maps unexpected dependency exceptions to NOT_USED_IN_IMG_ACTIVITIES.
      if (result.fault) {
        if (!mapping) throw new Error(`CONFIGURATION_IMG_RFC_FAILED: ${result.fault.name}`)
        lookups.push({
          objectName: object.OBJECTNAME,
          objectType: object.OBJECTTYPE,
          status: "unavailable",
          faultName: result.fault.name
        })
        continue
      }
      const parsed = z.object({ ACTIVITIES_FOUND: z.array(header) }).safeParse(result.outputs)
      if (!parsed.success) throw new Error("CONFIGURATION_IMG_RESPONSE_INVALID")
      lookups.push({
        objectName: object.OBJECTNAME,
        objectType: object.OBJECTTYPE,
        status: parsed.data.ACTIVITIES_FOUND.length ? "read" : "empty"
      })
      found = parsed.data.ACTIVITIES_FOUND
    }
    for (const row of found) {
      const previous = activities.get(row.ACTIVITY)
      if (previous && JSON.stringify(previous) !== JSON.stringify(row))
        throw new Error("CONFIGURATION_IMG_AMBIGUOUS_RESULT")
      activities.set(row.ACTIVITY, row)
      const names = routes.get(row.ACTIVITY) ?? new Set<string>()
      names.add(`${object.OBJECTTYPE}:${object.OBJECTNAME}`)
      routes.set(row.ACTIVITY, names)
    }
  }
  await verifyReaders()
  if (mapping && (await resolveObjects!(input.objectName)).fingerprint !== mapping.fingerprint)
    throw new Error("CONFIGURATION_IMG_MAPPING_CHANGED")
  const confirmation = definition.parse(await readTable(input.objectName))
  if (confirmation.fingerprint !== table.fingerprint || confirmation.version !== table.version)
    throw new Error("CONFIGURATION_IMG_DEFINITION_CHANGED")
  // ponytail: SAP bounds the predicate to one object, not the row count; this caps output only.
  const ordered = [...activities.values()].sort((a, b) => a.ACTIVITY.localeCompare(b.ACTIVITY))
  return {
    connectionId: input.connectionId,
    objectName: input.objectName,
    definitionFingerprint: table.fingerprint,
    maintenanceObjectType: mapping ? null : "S",
    maintenanceObjectTypeMeaning: mapping ? null : objectTypes.S,
    maintenanceMapping: mapping
      ? {
          status: "read",
          fingerprint: mapping.fingerprint,
          sources: mapping.sources,
          warnings: mapping.warnings,
          scope: "w200/200 T006/T006A; OBJS metadata only"
        }
      : { status: "not_requested" },
    maintenanceObjects: objects.map((object) => ({
      objectName: object.OBJECTNAME,
      objectType: object.OBJECTTYPE,
      objectTypeMeaning: objectTypes[object.OBJECTTYPE],
      registration: mapping ? object : null
    })),
    lookups,
    status: "partial",
    readOnly: true,
    saveAvailable: false,
    activities: ordered.slice(0, input.maxActivities).map((row) => ({
      activityId: row.ACTIVITY,
      customizingActivityId: row.C_ACTIVITY,
      documentationId: row.DOCU_ID,
      attributeId: row.ATTRIBUTES,
      headerTransaction: row.TCODE,
      maintenanceObjects: [...routes.get(row.ACTIVITY)!].sort(),
      title: { status: "unknown" },
      path: { status: "unknown" }
    })),
    returnedCount: Math.min(ordered.length, input.maxActivities),
    observedCount: ordered.length,
    truncated: ordered.length > input.maxActivities,
    evidence: { readers: configurationImgReaders, definitionsRechecked: true, snapshot: false },
    warnings: [
      mapping
        ? "Only the selected unit table's registered OBJS objects were searched; registration does not authorize maintenance or access to other tables."
        : "Exact table-object lookup only; use resolveMaintenanceObjects for the reviewed unit-domain mapping.",
      "Per-object faults remain unavailable, never proof of absence; titles and hierarchy paths remain unknown.",
      "An empty result does not prove the object has no IMG activity through another maintenance object.",
      "headerTransaction is the activity header transaction, not a verified maintenance API or unique route.",
      "maxActivities limits returned output, not SAP retrieval; sequential reads are not an atomic snapshot.",
      "Titles, hierarchy paths, documentation content, business validation and CTS policy were not read."
    ]
  }
}
