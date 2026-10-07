import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import { configurationUnitApiBody } from "./configuration-unit-api.js"
import type { inspectConfigurationBteRoute } from "./configuration-bte-route.js"
import {
  configurationBteMetadataApi as api,
  configurationBteMetadataLayouts as layouts,
  configurationBteMetadataPins as pins,
  configurationBteMetadataFieldContracts as contracts
} from "./configuration-bte-metadata-api.js"

export const configurationBteMetadataSchema = z
  .object({ connectionId: z.string().toLowerCase().pipe(z.literal("w200")) })
  .strict()

const canonical = (v: unknown) =>
  JSON.stringify(v, (_key, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]])
        )
      : x
  )
function fail(suffix: string): never {
  throw Error(`BTE_METADATA_${suffix}`)
}
const parameter = z.object({
  name: z.string(),
  typeName: z.string(),
  optional: z.boolean(),
  passByValue: z.boolean()
})

/** Active source and the full external ABI must agree; no caller-selected function is executed. */
export function attestConfigurationBteMetadataApi(raw: unknown) {
  const d = z
    .object({
      connectionId: z.literal("w200"),
      functionName: z.literal(api.functionName),
      functionGroup: z.literal(api.functionGroup),
      remoteEnabled: z.literal(true),
      updateTask: z.literal(false),
      updateTaskMode: z.literal(""),
      globalInterface: z.literal(false),
      sourceFingerprint: z.literal(pins.source),
      interfaceFingerprint: z.literal(pins.interface),
      source: z.array(z.string()),
      importParameters: z.array(z.never()),
      changingParameters: z.array(z.never()),
      exceptions: z.array(z.never()),
      exportParameters: z.array(parameter),
      tableParameters: z.array(parameter)
    })
    .safeParse(raw)
  if (!d.success) fail("API_UNVERIFIED")
  const sorted = (rows: readonly unknown[]) =>
    canonical([...rows].sort((a, b) => canonical(a).localeCompare(canonical(b))))
  if (
    configurationUnitApiBody(d.data.source) !== configurationUnitApiBody(api.source) ||
    sorted(d.data.exportParameters) !== sorted(api.exportParameters) ||
    sorted(d.data.tableParameters) !== sorted(api.tableParameters)
  )
    fail("API_UNVERIFIED")
  return { source: d.data.sourceFingerprint, interface: d.data.interfaceFingerprint }
}

type Name = keyof typeof layouts
function primitive(c: { dataType: string; length?: number }) {
  let value: z.ZodType<string> = z
    .string()
    .max(c.length ?? 16)
    .refine((s) => !/\p{Cc}/u.test(s))
  if (c.dataType === "NUMC") value = value.refine((s) => /^\d*$/.test(s))
  if (c.dataType === "INT4")
    value = value.refine(
      (s) =>
        /^-?\d+$/.test(s) &&
        Number.isSafeInteger(Number(s)) &&
        Number(s) >= -2147483648 &&
        Number(s) <= 2147483647
    )
  if (c.dataType === "DATS") value = value.refine((s) => /^(?:\d{8}|\d{4}-\d{2}-\d{2})$/.test(s))
  if (c.dataType === "TIMS") value = value.refine((s) => /^(?:\d{6}|\d{2}:\d{2}:\d{2})$/.test(s))
  return value
}
const row = (name: Name) =>
  z
    .object(
      Object.fromEntries(
        layouts[name].fields.map((f) => [
          f,
          primitive(contracts[name][f as keyof (typeof contracts)[typeof name]])
        ])
      )
    )
    .strict()
export const configurationBteMetadataResponse = z
  .object({
    EV_CODE: z.literal("METADATA_READ_OK"),
    EV_MESSAGE: z.string().max(220),
    EV_READ_ONLY: z.literal("X"),
    EV_FRESH: z.literal(""),
    ET_HEADER: z.array(row("VIMDESC")).length(1),
    ET_NAMTAB: z.array(row("VIMNAMTAB")).min(1).max(200),
    ET_EVENTS: z.array(row("TVIMF")).max(64)
  })
  .strict()
const rejected = z.enum([
  "SCOPE_UNSUPPORTED",
  "AUTHORIZATION_DENIED",
  "ROUTE_UNSUPPORTED",
  "METADATA_LIMIT_EXCEEDED",
  "METADATA_INVALID",
  "METADATA_CHANGED",
  "NATIVE_METADATA_FAILED"
])

/** One native metadata read, bracketed by version/route reads. Cached values never grant a write. */
export async function inspectConfigurationBteMetadata(
  raw: unknown,
  client: string,
  backend: Pick<SapBackend, "callRemoteFunction">,
  readers: {
    definition: (name: string) => Promise<unknown>
    layout: (name: Name) => Promise<unknown>
    route: () => Promise<Awaited<ReturnType<typeof inspectConfigurationBteRoute>>>
  }
) {
  const input = configurationBteMetadataSchema.parse(raw)
  if (client !== "200") fail("SCOPE_UNSUPPORTED")
  const verify = async () => {
    for (const [name, p] of Object.entries(layouts)) {
      const d = z
        .object({
          connectionId: z.literal("w200"),
          objectName: z.literal(name),
          objectKind: z.literal(name === "TVIMF" ? "transparentTable" : "structure"),
          fingerprint: z.literal(p.fingerprint),
          active: z.literal(true).optional(),
          definition: z.object({ fields: z.array(z.object({ name: z.string() })) })
        })
        .safeParse(await readers.layout(name as Name))
      if (
        !d.success ||
        canonical(d.data.definition.fields.map((f) => f.name)) !== canonical(p.fields)
      )
        fail("LAYOUT_UNVERIFIED")
    }
    for (const [name, p] of Object.entries(pins.standard)) {
      if (
        !z
          .object({
            connectionId: z.literal("w200"),
            functionName: z.literal(name),
            functionGroup: z.literal(p.functionGroup),
            remoteEnabled: z.literal(false),
            updateTask: z.literal(false),
            updateTaskMode: z.literal(""),
            sourceFingerprint: z.literal(p.source),
            interfaceFingerprint: z.literal(p.interface)
          })
          .safeParse(await readers.definition(name)).success
      )
        fail("STANDARD_API_UNVERIFIED")
    }
    return attestConfigurationBteMetadataApi(await readers.definition(api.functionName))
  }
  const identity = await verify(),
    before = await readers.route()
  if (
    before.status !== "standard_product_maintenance_route_observed" ||
    !before.products.complete ||
    before.connectionId !== "w200" ||
    before.client !== "200"
  )
    fail("ROUTE_UNVERIFIED")
  const r = await backend.callRemoteFunction(input.connectionId, {
    functionName: api.functionName,
    inputParameters: Object.fromEntries(api.tableParameters.map((p) => [p.name, []])),
    outputParameters: [
      ...api.exportParameters.map((p) => ({ name: p.name, kind: "scalar" as const })),
      ...api.tableParameters.map((p) => ({
        name: p.name,
        kind: "table" as const,
        fields: [...layouts[p.typeName].fields]
      }))
    ]
  })
  // A native read is not replayed on fault, refusal, malformed response or metadata drift.
  if (r.fault) fail("NATIVE_FAULT")
  if (r.outputs.EV_CODE !== "METADATA_READ_OK") {
    const code = rejected.safeParse(r.outputs.EV_CODE)
    fail(code.success ? code.data : "RESPONSE_INVALID")
  }
  const parsed = configurationBteMetadataResponse.safeParse(r.outputs)
  if (!parsed.success) fail("RESPONSE_INVALID")
  const native = parsed.data,
    h = native.ET_HEADER[0]!,
    directory = before.maintenance.directory
  if (
    !directory ||
    h.VIEWNAME !== "TBE24" ||
    h.MAINTVIEW !== "TBE24" ||
    h.AREA !== "BFTM" ||
    h.BASTAB !== "X" ||
    h.TEXTTAB !== "TBE24T" ||
    h.TEXTTBEXST !== "X" ||
    h.NEWGENER !== "" ||
    ["AREA", "LISTE", "DEVCLASS", "TYPE", "DETAIL"].some((f) => h[f] !== directory[f]) ||
    h.GENDATE!.replaceAll("-", "") !== directory.GENDATE ||
    h.GENTIME!.replaceAll(":", "") !== directory.GENTIME
  )
    fail("HEADER_MISMATCH")
  if (canonical(native.ET_EVENTS) !== canonical(before.maintenance.events)) fail("EVENT_MISMATCH")
  const fields = new Set<string>()
  for (const f of native.ET_NAMTAB) {
    if (
      !["TBE24", "TBE24T"].includes(f.BASTABNAME!) ||
      !/^[A-Z][A-Z0-9_]*$/.test(f.VIEWFIELD!) ||
      !["", "X"].includes(f.TEXTTABFLD!) ||
      (f.TEXTTABFLD === "X") !== (f.BASTABNAME === "TBE24T")
    )
      fail("FIELD_SCOPE_INVALID")
    const id = canonical([f.BASTABNAME, f.VIEWFIELD])
    if (fields.has(id)) fail("DUPLICATE_FIELD")
    fields.add(id)
  }
  await verify()
  const after = await readers.route()
  if (
    before.fingerprint !== after.fingerprint ||
    canonical(before.maintenance) !== canonical(after.maintenance) ||
    !after.products.complete ||
    after.status !== before.status
  )
    fail("READ_CHANGED")
  return {
    connectionId: "w200",
    client,
    status: "native_metadata_read",
    readOnly: true,
    executable: false,
    writeAvailable: false,
    fresh: false,
    fingerprint: createHash("sha256")
      .update(canonical({ identity, route: before.fingerprint, native }))
      .digest("hex"),
    routeFingerprint: before.fingerprint,
    api: { functionName: api.functionName, ...identity },
    native,
    coverage: {
      nativeCalls: 1,
      displayAuthorityChecked: true,
      atomicSnapshot: false,
      cachedControlBlocks: true,
      writeAuthorityChecked: false,
      handlerInvoked: false
    },
    executionBlockers: [
      "BTE_CACHED_METADATA_IS_NOT_WRITE_PERMISSION",
      "BTE_PRODUCT_WRITE_ADAPTER_PENDING"
    ],
    warnings: [
      "Standard metadata may be cached. Version and route agreement do not prove a locked snapshot or write permission."
    ]
  }
}
