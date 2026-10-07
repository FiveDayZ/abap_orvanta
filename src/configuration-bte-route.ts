import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import { createReviewedTableReader, type ReviewedReaderSource } from "./reviewed-table-reader.js"
import { configurationBteProductApi } from "./configuration-bte-product.js"

export const configurationBteRouteSchema = z
  .object({
    connectionId: z.string().toLowerCase().pipe(z.literal("w200")),
    maxProducts: z.number().int().min(2).max(200).default(100)
  })
  .strict()

// Actual w200 dictionary definitions, r72/r73. No caller-selected table or transaction.
export const configurationBteRouteLayouts = {
  TSTC: {
    fingerprint: "44e8612fb2a6250584d3c6800498b7c3dd4c33de3790fc13dc0c2793e1b2ce26",
    fields: ["TCODE", "PGMNA", "DYPNO", "MENUE", "CINFO", "ARBGB"],
    keys: ["TCODE"]
  },
  TSTCP: {
    fingerprint: "3e1fbedb85417c67e46620f28802c734c01b45cc124fafe3734070d5ba2aea24",
    fields: ["TCODE", "PARAM"],
    keys: ["TCODE"]
  },
  TVDIR: {
    fingerprint: "162419f276b3971ebb3fd1b41b9d52ff76c6588dd61d52226b34b2f9a71a1e59",
    fields: [
      "TABNAME",
      "AREA",
      "DEVCLASS",
      "TYPE",
      "LISTE",
      "DETAIL",
      "OCCURS",
      "CLTCODE",
      "BASTAB",
      "NEWGENER",
      "GENDATE",
      "GENTIME",
      "FLAG"
    ],
    keys: ["TABNAME"]
  },
  TVIMF: {
    fingerprint: "173d730f8fec4e6071723ac870a83f844d68ecfdfa4971c84efd1317f3ef2924",
    fields: ["TABNAME", "EVENT", "FORMNAME"],
    keys: ["TABNAME", "EVENT"]
  },
  TBE24: {
    fingerprint: "c5a94543cc76c4f89574167a704d4f591377d1ad66e77d268c0e865719c22ec5",
    fields: ["MANDT", "PRDKT", "RFCDS", "AKTIV"],
    keys: ["MANDT", "PRDKT"]
  },
  TBE24T: {
    fingerprint: "4cd1dd171c71c1edc06d8c0417e4646acb8c7d0f6608978029dde574cb03186c",
    fields: ["MANDT", "SPRAS", "PRDKT", "TXT50"],
    keys: ["MANDT", "SPRAS", "PRDKT"]
  }
} as const
const canonical = (v: unknown) =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]])
        )
      : x
  )
function fail(suffix: string): never {
  throw Error(`BTE_ROUTE_${suffix}`)
}

/** Parameter transactions may launch anything. Only this exact SM30 product path is recognised. */
export function resolveBteProductParameters(raw: string) {
  const m = /^\/\*([A-Z0-9_]+)\s+(.+)$/.exec(raw)
  if (!m) return null
  const values: Record<string, string> = {}
  for (const part of m[2]!.split(";").filter((x) => x.trim())) {
    const item = /^\s*([A-Z0-9_]+)=([A-Z0-9_]+)\s*$/.exec(part)
    if (!item || item[1]! in values) return null
    values[item[1]!] = item[2]!
  }
  if (
    m[1] !== "SM30" ||
    values.VIEWNAME !== "TBE24" ||
    values.UPDATE !== "X" ||
    Object.keys(values).sort().join(",") !== "UPDATE,VIEWNAME"
  )
    return null
  return { transaction: "SM30", tableName: "TBE24", mode: "update" }
}

export async function inspectConfigurationBteRoute(
  raw: unknown,
  client: string,
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  readers: {
    table: (name: string) => Promise<unknown>
    definition: (name: string) => Promise<unknown>
  }
) {
  const input = configurationBteRouteSchema.parse(raw)
  if (client !== "200") fail("SCOPE_UNSUPPORTED")
  const verify = async () => {
    for (const [name, pin] of Object.entries(configurationBteRouteLayouts)) {
      const r = z
        .object({
          connectionId: z.literal("w200"),
          objectName: z.literal(name),
          objectKind: z.literal("transparentTable"),
          fingerprint: z.literal(pin.fingerprint),
          active: z.literal(true).optional(),
          definition: z.object({
            tableClass: z.literal("TRANSP"),
            fields: z.array(z.object({ name: z.string(), key: z.boolean() }))
          })
        })
        .safeParse(await readers.table(name))
      if (
        !r.success ||
        canonical(r.data.definition.fields.map((f) => f.name)) !== canonical(pin.fields) ||
        canonical(r.data.definition.fields.filter((f) => f.key).map((f) => f.name)) !==
          canonical(pin.keys)
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
      fail("API_UNVERIFIED")
  }
  await verify()
  const sources: ReviewedReaderSource[] = [],
    warnings: string[] = []
  const reader = createReviewedTableReader(
    backend,
    "w200",
    () => readers.definition("RFC_READ_TABLE"),
    sources,
    warnings
  )
  const read = async () => {
    const state: Record<string, Record<string, string>[]> = {}
    let productsComplete = true
    for (const table of ["TSTC", "TSTCP", "TVDIR", "TVIMF", "TBE24"] as const) {
      const filters: Record<string, string> =
        table === "TSTC" || table === "TSTCP"
          ? { TCODE: "BF24" }
          : table === "TBE24"
            ? { MANDT: client }
            : { TABNAME: "TBE24" }
      const fields =
        table === "TSTC" ? ["TCODE", "PGMNA", "DYPNO"] : configurationBteRouteLayouts[table].fields
      const rows = await reader({
        table,
        fields,
        filters,
        maximum: table === "TVIMF" ? 64 : table === "TBE24" ? input.maxProducts : 1,
        codePrefix: "BTE_ROUTE_",
        mapError: (e) =>
          e instanceof Error && /^BTE_ROUTE_[A-Z_]+$/.test(e.message)
            ? e.message
            : "BTE_ROUTE_READ_FAILED",
        validate: (records) => {
          if (records.some((r) => Object.entries(filters).some(([k, v]) => r[k] !== v)))
            fail("RESPONSE_SCOPE_MISMATCH")
          const ids = records.map((r) =>
            canonical(configurationBteRouteLayouts[table].keys.map((k) => r[k]))
          )
          if (new Set(ids).size !== ids.length) fail("DUPLICATE_KEY")
          if (table === "TBE24" && records.some((r) => !r.PRDKT || !["", "X"].includes(r.AKTIV!)))
            fail("PRODUCT_INVALID")
        }
      })
      if (!rows) fail(sources.at(-1)?.code?.replace(/^BTE_ROUTE_/, "") ?? "READ_FAILED")
      if (sources.at(-1)?.status === "truncated") {
        if (table !== "TBE24") fail("LIMIT_EXCEEDED")
        productsComplete = false
      }
      state[table] = rows.sort((a, b) => canonical(a).localeCompare(canonical(b)))
    }
    return { state, productsComplete }
  }
  const before = await read()
  await verify()
  const after = await read()
  if (canonical(before) !== canonical(after)) fail("READ_CHANGED")
  const state = before.state,
    parameters = state.TSTCP![0]?.PARAM ?? "",
    resolved = resolveBteProductParameters(parameters),
    directory = state.TVDIR![0] ?? null
  const routeObserved =
    !!resolved &&
    state.TSTC!.length === 1 &&
    state.TSTC![0]!.PGMNA === "" &&
    state.TSTC![0]!.DYPNO === "0000" &&
    !!directory &&
    directory.AREA === "BFTM" &&
    directory.BASTAB === "X" &&
    directory.NEWGENER === ""
  const fingerprint = createHash("sha256")
    .update(
      canonical({
        input,
        client,
        before,
        layouts: configurationBteRouteLayouts,
        api: configurationBteProductApi
      })
    )
    .digest("hex")
  return {
    connectionId: "w200",
    client,
    readOnly: true,
    executable: false,
    writeAvailable: false,
    status: routeObserved
      ? "standard_product_maintenance_route_observed"
      : "maintenance_route_unconfirmed",
    fingerprint,
    transaction: {
      code: "BF24",
      definition: state.TSTC![0] ?? null,
      parameters,
      recognised: resolved
    },
    maintenance: {
      tableName: "TBE24",
      directory,
      events: state.TVIMF,
      relatedTextTable: "TBE24T",
      textValuesInspected: false,
      generatedFunctionCandidate: routeObserved ? "TABLEPROC_BFTM" : null,
      generatedSourcesReviewed: false,
      controlBlocksInspected: false,
      authorityChecked: false,
      enqueueChecked: false,
      commitOwnershipVerified: false,
      ctsVerified: false
    },
    products: {
      complete: before.productsComplete,
      returnedCount: state.TBE24!.length,
      maximum: input.maxProducts,
      supportedCustomerProducts: state.TBE24!.filter((r) => /^[ZY][A-Z0-9_]{0,7}$/.test(r.PRDKT!)),
      namespace: "existing Z/Y only; other customer-table rows are excluded from candidate listing"
    },
    standardApiCandidate: {
      ...configurationBteProductApi,
      invoked: false,
      remoteEnabled: false,
      requiresCustomerAdapter: true
    },
    executionBlockers: [
      ...(routeObserved ? [] : ["BTE_ROUTE_UNCONFIRMED"]),
      "BTE_NATIVE_CONTROL_BLOCKS_PENDING",
      "BTE_CALLBACKS_AND_TEXT_PRESERVATION_PENDING",
      "BTE_PRODUCT_WRITE_ADAPTER_PENDING"
    ],
    coverage: {
      twoReadAgreement: true,
      atomicSnapshot: false,
      allProducts: before.productsComplete,
      bothAssignmentKindsInspected: false
    },
    sources,
    warnings
  }
}
