import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import { configurationBteRouteLayouts } from "./configuration-bte-route.js"
import { configurationBteProductApi } from "./configuration-bte-product.js"
import { createReviewedTableReader, type ReviewedReaderSource } from "./reviewed-table-reader.js"

export const configurationFiActivationRouteSchema = z
  .object({ connectionId: z.string().toLowerCase().pipe(z.literal("w200")) })
  .strict()
const tables = ["TSTC", "TSTCP", "TVDIR", "TVIMF"] as const
type Table = (typeof tables)[number]
const fail = (suffix: string): never => {
  throw Error(`FI_ACTIVATION_ROUTE_${suffix}`)
}

/** Recognise data only. An unknown parameter transaction is never executed or guessed. */
export function resolveFiActivationParameters(raw: string) {
  const match = /^\/\*SM30\s+(.+)$/.exec(raw)
  if (!match) return null
  const values: Record<string, string> = {}
  for (const part of match[1]!.split(";").filter((value) => value.trim())) {
    const item = /^\s*([A-Z0-9_]+)=([A-Z0-9_]+)\s*$/.exec(part)
    if (!item || item[1]! in values) return null
    values[item[1]!] = item[2]!
  }
  if (
    Object.keys(values).sort().join(",") !== "UPDATE,VIEWNAME" ||
    values.UPDATE !== "X" ||
    !/^[A-Z][A-Z0-9_]{0,29}$/.test(values.VIEWNAME!)
  )
    return null
  return { transaction: "SM30", viewName: values.VIEWNAME!, mode: "update" } as const
}

/** Fixed OB28 metadata route. Uses the existing reviewed reader, never the maintenance API. */
export async function inspectConfigurationFiActivationRoute(
  raw: unknown,
  client: string,
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  readers: {
    table: (name: string) => Promise<unknown>
    definition: (name: string) => Promise<unknown>
  }
) {
  const input = configurationFiActivationRouteSchema.parse(raw)
  if (client !== "200") fail("SCOPE_UNSUPPORTED")
  const verify = async () => {
    for (const table of tables) {
      const pin = configurationBteRouteLayouts[table],
        result = z
          .object({
            connectionId: z.literal("w200"),
            objectName: z.literal(table),
            objectKind: z.literal("transparentTable"),
            fingerprint: z.literal(pin.fingerprint),
            active: z.literal(true).optional(),
            definition: z.object({
              tableClass: z.literal("TRANSP"),
              fields: z.array(z.object({ name: z.string(), key: z.boolean() }))
            })
          })
          .safeParse(await readers.table(table))
      if (
        !result.success ||
        JSON.stringify(result.data.definition.fields.map((field) => field.name)) !==
          JSON.stringify(pin.fields) ||
        JSON.stringify(
          result.data.definition.fields.filter((field) => field.key).map((field) => field.name)
        ) !== JSON.stringify(pin.keys)
      )
        fail("LAYOUT_UNVERIFIED")
    }
    if (
      !z
        .object({
          connectionId: z.literal("w200"),
          functionName: z.literal(configurationBteProductApi.functionName),
          functionGroup: z.literal(configurationBteProductApi.functionGroup),
          remoteEnabled: z.literal(false),
          updateTask: z.literal(false),
          sourceFingerprint: z.literal(configurationBteProductApi.source),
          interfaceFingerprint: z.literal(configurationBteProductApi.interface)
        })
        .safeParse(await readers.definition(configurationBteProductApi.functionName)).success
    )
      fail("API_DEFINITION_UNVERIFIED")
  }
  await verify()
  const sources: ReviewedReaderSource[] = [],
    warnings: string[] = [],
    reader = createReviewedTableReader(
      backend,
      input.connectionId,
      () => readers.definition("RFC_READ_TABLE"),
      sources,
      warnings
    )
  const read = async () => {
    const readTable = async (table: Table, filters: Record<string, string>, maximum: number) => {
      const rows = await reader({
        table,
        fields: configurationBteRouteLayouts[table].fields,
        filters,
        maximum,
        codePrefix: "FI_ACTIVATION_ROUTE_",
        mapError: (error) =>
          error instanceof Error && /^FI_ACTIVATION_ROUTE_[A-Z_]+$/.test(error.message)
            ? error.message
            : error instanceof Error && /HTTP 401|logon.*failed/i.test(error.message)
              ? "FI_ACTIVATION_ROUTE_AUTHENTICATION_REJECTED"
              : "FI_ACTIVATION_ROUTE_READ_FAILED",
        validate: (records) => {
          if (
            records.some((row) =>
              Object.entries(filters).some(([key, value]) => row[key] !== value)
            )
          )
            fail("RESPONSE_SCOPE_MISMATCH")
          const keys = records.map((row) =>
            JSON.stringify(configurationBteRouteLayouts[table].keys.map((key) => row[key]))
          )
          if (new Set(keys).size !== keys.length) fail("DUPLICATE_KEY")
        }
      })
      if (!rows) throw Error(sources.at(-1)?.code ?? "FI_ACTIVATION_ROUTE_READ_FAILED")
      if (sources.at(-1)?.status === "truncated") fail("READ_TRUNCATED")
      return rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    }
    const transaction = await readTable("TSTC", { TCODE: "OB28" }, 1),
      parameters = await readTable("TSTCP", { TCODE: "OB28" }, 1),
      resolved = resolveFiActivationParameters(parameters[0]?.PARAM ?? "")
    const directory = resolved ? await readTable("TVDIR", { TABNAME: resolved.viewName }, 1) : null,
      events = resolved ? await readTable("TVIMF", { TABNAME: resolved.viewName }, 64) : null
    return { transaction, parameters, resolved, directory, events }
  }
  const before = await read(),
    after = await read()
  await verify()
  if (JSON.stringify(before) !== JSON.stringify(after)) fail("READ_CHANGED")
  const directory = before.directory?.[0] ?? null,
    routeObserved =
      before.transaction[0]?.PGMNA === "" &&
      before.transaction[0]?.DYPNO === "0000" &&
      before.resolved !== null &&
      directory !== null &&
      /^[A-Z0-9_]{1,26}$/.test(directory.AREA!) &&
      directory.NEWGENER === ""
  return {
    connectionId: input.connectionId,
    client,
    readOnly: true,
    status: routeObserved ? "maintenance_route_candidate" : "maintenance_route_unconfirmed",
    saveAvailable: false,
    writeAvailable: false,
    automaticRetry: false,
    transaction: {
      code: "OB28",
      definition: before.transaction[0] ?? null,
      parameters: before.parameters[0]?.PARAM ?? null,
      recognised: before.resolved
    },
    maintenance: {
      directory,
      events: before.events,
      functionGroup: routeObserved ? directory!.AREA : null,
      targetTable: "T001D",
      targetTableRelationship: "not_verified",
      generatedSourcesReviewed: false,
      nativeControlBlocksReviewed: false,
      authorityLockCtsLuwVerified: false
    },
    standardApiCandidate: {
      ...configurationBteProductApi,
      definitionRechecked: true,
      invoked: false,
      requiresCustomerAdapter: true
    },
    blockers: [
      ...(routeObserved ? [] : ["FI_ACTIVATION_ROUTE_UNCONFIRMED"]),
      "FI_ACTIVATION_ROUTE_TARGET_RELATIONSHIP_UNVERIFIED",
      "FI_ACTIVATION_ROUTE_GENERATED_OWNER_UNREVIEWED",
      "FI_ACTIVATION_ROUTE_AUTHORITY_LOCK_CTS_LUW_UNVERIFIED"
    ],
    readFingerprint: createHash("sha256")
      .update(JSON.stringify({ input, client, before }))
      .digest("hex"),
    coverage: { twoReadAgreement: true, atomicSnapshot: false, nativeExecution: false },
    sources,
    warnings
  }
}
