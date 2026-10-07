import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import { createReviewedTableReader, type ReviewedReaderSource } from "./reviewed-table-reader.js"

export const configurationBteProductSchema = z
  .object({
    connectionId: z.string().toLowerCase().pipe(z.literal("w200")),
    productName: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[ZY][A-Z0-9_]{0,7}$/),
    active: z.boolean(),
    maxAssignmentsPerKind: z.number().int().min(2).max(200).default(100),
    expectedFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
  })
  .strict()

// Active w200 DDIC and standard function definitions read on 2026-10-07, r72.
export const configurationBteProductLayouts = {
  TBE24: "c5a94543cc76c4f89574167a704d4f591377d1ad66e77d268c0e865719c22ec5",
  TBE34: "d86a1962b0c0c98d48d90a4f3632f4d77f6229eecc719d8643ea27d6f250ef20",
  TPS34: "85f840b31746ccf8d31aa1a56f5c67c6833801833701e9858b07c78d546de30f"
} as const
export const configurationBteProductFields = {
  TBE24: ["MANDT", "PRDKT", "RFCDS", "AKTIV"],
  TBE34: ["MANDT", "EVENT", "PRDKT", "LAND", "APPLK", "FUNCT", "MONIT"],
  TPS34: ["MANDT", "PROCS", "LAND", "APPLK", "FUNCT", "PRDKT", "MONIT"]
} as const
const keys = {
  TBE24: ["MANDT", "PRDKT"],
  TBE34: ["MANDT", "EVENT", "PRDKT", "LAND", "APPLK"],
  // A process assignment key does NOT include the product. Never infer it from TBE34.
  TPS34: ["MANDT", "PROCS", "LAND", "APPLK"]
} as const
export const configurationBteProductDomains = {
  CUSTP_BF: "22141e657ba9c7476fbe93b003041b1195f9cc8e42b3f24029fa16ea6911cc6b",
  XFELD: "45375053b04c7107310d18d9d9ea0233dde5d11f935369c113298e5df16f2c18"
} as const
export const configurationBteProductApi = {
  functionName: "VIEW_MAINTENANCE_NO_DIALOG",
  functionGroup: "SVIM",
  source: "aef8ff0659768c8c723583f7d084449063afc5980060f4c45b3c5641a499b861",
  interface: "096a143263b04e39e651e1f42a8038df2193fca019eaf41b7e34d1829d72816b"
} as const
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((key) => [key, v[key]])
        )
      : v
  )
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex")
function fail(suffix: string): never {
  throw Error(`BTE_PRODUCT_${suffix}`)
}

/** One prospective AKTIV change. Exact product, both assignment kinds, no handler invocation. */
export async function previewConfigurationBteProduct(
  raw: unknown,
  client: string,
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  readers: {
    table: (name: string) => Promise<unknown>
    domain: (name: string) => Promise<unknown>
    definition: (name: string) => Promise<unknown>
  }
) {
  const input = configurationBteProductSchema.parse(raw)
  if (client !== "200") fail("SCOPE_UNSUPPORTED")
  const verify = async () => {
    for (const name of ["TBE24", "TBE34", "TPS34"] as const) {
      const definition = z
        .object({
          connectionId: z.literal("w200"),
          objectKind: z.literal("transparentTable"),
          objectName: z.literal(name),
          fingerprint: z.literal(configurationBteProductLayouts[name]),
          active: z.literal(true).optional(),
          definition: z.object({
            tableClass: z.literal("TRANSP"),
            fields: z.array(z.object({ name: z.string(), key: z.boolean() }))
          })
        })
        .safeParse(await readers.table(name))
      if (!definition.success) fail("LAYOUT_UNVERIFIED")
      if (
        canonical(definition.data.definition.fields.map((f) => f.name)) !==
          canonical(configurationBteProductFields[name]) ||
        canonical(definition.data.definition.fields.filter((f) => f.key).map((f) => f.name)) !==
          canonical(keys[name])
      )
        fail("LAYOUT_UNVERIFIED")
    }
    for (const name of ["CUSTP_BF", "XFELD"] as const) {
      if (
        !z
          .object({
            connectionId: z.literal("w200"),
            objectKind: z.literal("domain"),
            objectName: z.literal(name),
            fingerprint: z.literal(configurationBteProductDomains[name]),
            active: z.literal(true).optional()
          })
          .safeParse(await readers.domain(name)).success
      )
        fail("DOMAIN_UNVERIFIED")
    }
    if (
      !z
        .object({
          connectionId: z.literal("w200"),
          functionName: z.literal(configurationBteProductApi.functionName),
          functionGroup: z.literal(configurationBteProductApi.functionGroup),
          remoteEnabled: z.literal(false),
          updateTask: z.literal(false),
          updateTaskMode: z.literal(""),
          sourceFingerprint: z.literal(configurationBteProductApi.source),
          interfaceFingerprint: z.literal(configurationBteProductApi.interface)
        })
        .safeParse(await readers.definition(configurationBteProductApi.functionName)).success
    )
      fail("API_UNVERIFIED")
  }
  await verify()
  const sources: ReviewedReaderSource[] = [],
    warnings: string[] = []
  const reader = createReviewedTableReader(
    backend,
    input.connectionId,
    () => readers.definition("RFC_READ_TABLE"),
    sources,
    warnings
  )
  const read = async () => {
    const state: Record<string, Record<string, string>[]> = {}
    for (const table of ["TBE24", "TBE34", "TPS34"] as const) {
      const rows = await reader({
        table,
        fields: configurationBteProductFields[table],
        filters: { MANDT: client, PRDKT: input.productName },
        maximum: table === "TBE24" ? 1 : input.maxAssignmentsPerKind,
        codePrefix: "BTE_PRODUCT_",
        mapError: (error) =>
          error instanceof Error && /^BTE_PRODUCT_[A-Z_]+$/.test(error.message)
            ? error.message
            : "BTE_PRODUCT_QUERY_FAILED",
        validate: (records) => {
          if (records.some((row) => row.MANDT !== client || row.PRDKT !== input.productName))
            fail("RESPONSE_SCOPE_MISMATCH")
          const ids = records.map((row) => canonical(keys[table].map((key) => row[key])))
          if (new Set(ids).size !== records.length) fail("DUPLICATE_KEY")
          if (table === "TBE24" && records.some((r) => !["", "X"].includes(r.AKTIV!)))
            fail("FLAG_INVALID")
        }
      })
      if (!rows) fail(sources.at(-1)?.code?.replace(/^BTE_PRODUCT_/, "") ?? "READ_UNAVAILABLE")
      if (sources.at(-1)?.status === "truncated") fail("LIMIT_EXCEEDED")
      state[table] = rows.sort((a, b) => canonical(a).localeCompare(canonical(b)))
    }
    return state
  }
  const before = await read()
  await verify()
  const second = await read()
  if (canonical(before) !== canonical(second)) fail("READ_CHANGED")
  if (before.TBE24!.length !== 1) fail("NOT_FOUND")
  const fingerprint = hash({
    connectionId: input.connectionId,
    client,
    productName: input.productName,
    before,
    layouts: configurationBteProductLayouts,
    domains: configurationBteProductDomains,
    api: configurationBteProductApi
  })
  if (input.expectedFingerprint && input.expectedFingerprint !== fingerprint)
    fail("VERSION_CONFLICT")
  const product = before.TBE24![0]!,
    proposed = { ...product, AKTIV: input.active ? "X" : "" }
  const changed = product.AKTIV !== proposed.AKTIV
  return {
    connectionId: input.connectionId,
    client,
    action: "set_bte_product_active",
    productName: input.productName,
    readOnly: true,
    executable: false,
    writeAvailable: false,
    status: "preview_only",
    executionBlocker: "BTE_PRODUCT_WRITE_ADAPTER_PENDING",
    fingerprint,
    change: {
      tableName: "TBE24",
      key: { MANDT: client, PRDKT: input.productName },
      before: product,
      after: proposed,
      changedFields: changed ? ["AKTIV"] : [],
      noOp: !changed
    },
    assignments: { events: before.TBE34, processes: before.TPS34 },
    impact: {
      eventCount: before.TBE34!.length,
      processCount: before.TPS34!.length,
      assignmentCount: before.TBE34!.length + before.TPS34!.length,
      sharedProduct: before.TBE34!.length + before.TPS34!.length > 1,
      activationChanged: changed,
      externalDestination: product.RFCDS
    },
    standardApiCandidate: {
      ...configurationBteProductApi,
      remoteEnabled: false,
      invoked: false,
      requiresCustomerAdapter: true,
      genericRfcExecutionSupported: false,
      prerequisites: [
        "maintenance control blocks and typed TOTAL/EXTRACT",
        "explicit authorization and enqueue",
        "reviewed generated product maintenance path and key-level CTS",
        "single commit ownership, failure rollback and recovery"
      ]
    },
    coverage: {
      productRead: true,
      bothAssignmentKindsRead: true,
      completeWithinBound: true,
      twoReadAgreement: true,
      handlerInterfacesInspected: false,
      effectiveExecutionOrderInspected: false,
      authorizedForWrite: false,
      runtimeInspected: false,
      atomicSnapshot: false
    },
    sources,
    warnings
  }
}
