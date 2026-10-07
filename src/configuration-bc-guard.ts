import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import { configurationUnitApiBody } from "./configuration-unit-api.js"
import {
  configurationBcPreviewSchema,
  configurationBcPreviewSourceVersion
} from "./configuration-bc-preview.js"
import {
  configurationBcGuardApi as api,
  configurationBcGuardLayouts as layouts
} from "./configuration-bc-guard-api.js"

const hex = z.string().regex(/^[a-f0-9]{64}$/)
export const configurationBcGuardSchema = configurationBcPreviewSchema
  .extend({ nativeMetadataVersion: hex })
  .strict()
type Table = keyof typeof layouts
export const configurationBcGuardKeys: { tableName: Table; key: Record<string, string> }[] = [
  { tableName: "T006I", key: { CLIENT: "200", ISOCODE: "KPA" } },
  ...["1", "D", "E"].map((language) => ({
    tableName: "T006J" as const,
    key: { CLIENT: "200", LANGU: language, ISOCODE: "KPA" }
  })),
  ...["1", "D", "E"].map((language) => ({
    tableName: "T006T" as const,
    key: { MANDT: "200", SPRAS: language, DIMID: "PRESS" }
  })),
  { tableName: "T006_OIB", key: { MANDT: "200", MSEHI: "KNM" } }
]
const names = Object.keys(layouts) as Table[]
const members = ["T006", "T006A", "T006B", "T006C", "T006D", ...names].sort()
const body = configurationUnitApiBody(api.source)
const sorted = (rows: readonly unknown[]) =>
  JSON.stringify([...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))

export function attestConfigurationBcGuardApi(raw: unknown) {
  const parameter = z.object({
    name: z.string(),
    typeName: z.string(),
    optional: z.boolean(),
    passByValue: z.boolean()
  })
  const v = z
    .object({
      connectionId: z.literal("w200"),
      functionName: z.literal(api.functionName),
      functionGroup: z.literal(api.functionGroup),
      remoteEnabled: z.literal(true),
      updateTask: z.literal(false),
      updateTaskMode: z.literal(""),
      sourceFingerprint: hex,
      interfaceFingerprint: hex,
      source: z.array(z.string()),
      importParameters: z.array(parameter),
      exportParameters: z.array(parameter),
      tableParameters: z.array(parameter),
      changingParameters: z.array(z.never()),
      exceptions: z.array(z.never())
    })
    .parse(raw)
  const headers = v.source.filter((s) => /^\s*FUNCTION /i.test(s))
  if (
    headers.length !== 1 ||
    headers[0]!.trim().toUpperCase() !== `FUNCTION ${api.functionName}.` ||
    configurationUnitApiBody(v.source) !== body ||
    sorted(v.importParameters) !== sorted(api.importParameters) ||
    sorted(v.exportParameters) !== sorted(api.exportParameters) ||
    sorted(v.tableParameters) !== sorted(api.tableParameters)
  )
    throw Error("CONFIGURATION_BC_GUARD_API_NOT_ATTESTED")
  return { source: v.sourceFingerprint, interface: v.interfaceFingerprint }
}

const routeSchema = z.object({
  connectionId: z.literal("w200"),
  client: z.literal("200"),
  bcSetId: z.literal("EHS_CUNI_KNM"),
  version: z.literal("N"),
  readOnly: z.literal(true),
  executable: z.literal(false),
  activationAvailable: z.literal(false),
  methodExecutionAvailable: z.literal(false),
  snapshot: z.literal(false),
  metadataVersion: hex,
  object: z.object({
    name: z.literal("CUNI"),
    type: z.literal("T"),
    transportType: z.literal("TDAT")
  }),
  members: z
    .array(
      z
        .object({ OBJECTNAME: z.literal("CUNI"), OBJECTTYPE: z.literal("T"), TABNAME: z.string() })
        .passthrough()
    )
    .length(9),
  methods: z.array(z.never()),
  methodSources: z.array(z.never()),
  native: z
    .object({
      EV_SYSTEM: z.literal("GR2"),
      EV_CLIENT: z.literal("200"),
      EV_USER: z.string().min(1).max(12),
      EV_SOURCE_VERSION: hex,
      EV_TARGET_VERSION: hex,
      EV_METADATA_VERSION: hex,
      ET_OBJH: z
        .array(z.object({ CLIDEP: z.literal("X"), LANGDEP: z.literal("X") }).passthrough())
        .length(1)
    })
    .passthrough()
})
const row = (name: Table) =>
  z
    .object(
      Object.fromEntries(
        layouts[name].fields.map((f) => [
          f,
          z
            .string()
            .max(128)
            .refine((s) => !/[\u0000-\u001f\u007f]/.test(s))
        ])
      )
    )
    .strict()
const response = z
  .object({
    EV_CODE: z.literal("GUARD_READ_OK"),
    EV_SYSTEM: z.literal("GR2"),
    EV_CLIENT: z.literal("200"),
    EV_USER: z.string().min(1).max(12),
    EV_SOURCE_VERSION: hex,
    EV_TARGET_VERSION: hex,
    EV_METADATA_VERSION: hex,
    EV_GUARD_VERSION: hex,
    ET_T006I: z.array(row("T006I")).max(1),
    ET_T006J: z.array(row("T006J")).max(3),
    ET_T006T: z.array(row("T006T")).max(3),
    ET_T006_OIB: z.array(row("T006_OIB")).max(1)
  })
  .strict()
const keyOf = (name: Table, row: Record<string, string>) =>
  JSON.stringify(layouts[name].keys.map((k) => row[k]?.trimEnd()))

/** Fixed related-key before-state. A missing row is explicit, never a write permission. */
export { response as configurationBcGuardResponseSchema }
export async function readConfigurationBcGuard(
  raw: unknown,
  client: string,
  backend: Pick<SapBackend, "callRemoteFunction">,
  readRoute: () => Promise<unknown>,
  readDefinition: () => Promise<unknown>,
  readTable: (name: Table) => Promise<unknown>
) {
  const input = configurationBcGuardSchema.parse(raw)
  if (client !== "200") throw Error("CONFIGURATION_BC_GUARD_SCOPE_UNSUPPORTED")
  if (input.nativeSourceVersion !== configurationBcPreviewSourceVersion)
    throw Error("CONFIGURATION_BC_GUARD_SOURCE_NOT_ATTESTED")
  let apiInvocations = 0,
    metadataReads = 0,
    routeReads = 0
  const route = async () => {
    routeReads++
    const v = routeSchema.parse(await readRoute())
    if (
      v.metadataVersion !== input.nativeMetadataVersion ||
      v.native.EV_METADATA_VERSION !== input.nativeMetadataVersion ||
      v.native.EV_SOURCE_VERSION !== input.nativeSourceVersion ||
      v.native.EV_TARGET_VERSION !== input.nativeTargetVersion
    )
      throw Error("CONFIGURATION_BC_GUARD_VERSION_CONFLICT")
    if (JSON.stringify(v.members.map((m) => m.TABNAME).sort()) !== JSON.stringify(members))
      throw Error("CONFIGURATION_BC_GUARD_ROUTE_SCOPE_UNSUPPORTED")
    return v
  }
  const before = await route()
  const attest = async () => {
    for (const name of names) {
      metadataReads++
      const v = z
        .object({
          connectionId: z.literal("w200"),
          objectKind: z.literal("transparentTable"),
          objectName: z.literal(name),
          fingerprint: z.literal(layouts[name].fingerprint),
          definition: z.object({
            fields: z.array(z.object({ name: z.string(), key: z.boolean() }))
          })
        })
        .parse(await readTable(name))
      if (
        JSON.stringify(v.definition.fields.map((f) => f.name)) !==
          JSON.stringify(layouts[name].fields) ||
        JSON.stringify(v.definition.fields.filter((f) => f.key).map((f) => f.name)) !==
          JSON.stringify(layouts[name].keys)
      )
        throw Error("CONFIGURATION_BC_GUARD_LAYOUT_NOT_ATTESTED")
    }
    metadataReads++
    return attestConfigurationBcGuardApi(await readDefinition())
  }
  const definition = await attest()
  const invoke = async () => {
    apiInvocations++
    const r = await backend.callRemoteFunction("w200", {
      functionName: api.functionName,
      inputParameters: {
        IV_BC_SET: input.bcSetId,
        IV_VERSION: input.version,
        IV_SOURCE_VERSION: input.nativeSourceVersion,
        IV_TARGET_VERSION: input.nativeTargetVersion,
        IV_METADATA_VERSION: input.nativeMetadataVersion,
        ...Object.fromEntries(api.tableParameters.map((p) => [p.name, []]))
      },
      outputParameters: [
        ...api.exportParameters.map((p) => ({ name: p.name, kind: "scalar" as const })),
        ...api.tableParameters.map((p) => ({
          name: p.name,
          kind: "table" as const,
          fields: [...layouts[p.typeName].fields]
        }))
      ]
    })
    if (r.fault) throw Error("CONFIGURATION_BC_GUARD_FAULT")
    if (r.outputs.EV_CODE !== "GUARD_READ_OK") {
      const code = z
        .enum([
          "SCOPE_UNSUPPORTED",
          "INPUT_INVALID",
          "SOURCE_NOT_ATTESTED",
          "AUTHORIZATION_DENIED",
          "ROUTE_READ_FAILED",
          "ROUTE_SCOPE_UNSUPPORTED",
          "READ_FAILED",
          "VERSION_CONFLICT",
          "OBJECT_NOT_DEFINED",
          "MEMBERS_MISSING",
          "MEMBER_LIMIT",
          "METHOD_LIMIT",
          "METADATA_CHANGED",
          "PROTECTION_LIMIT",
          "PROTECTION_CHANGED",
          "HASH_FAILED"
        ])
        .safeParse(r.outputs.EV_CODE)
      throw Error(`CONFIGURATION_BC_GUARD_${code.success ? code.data : "INVALID_RESPONSE"}`)
    }
    const v = response.parse(r.outputs)
    if (
      v.EV_USER !== before.native.EV_USER ||
      v.EV_SOURCE_VERSION !== input.nativeSourceVersion ||
      v.EV_TARGET_VERSION !== input.nativeTargetVersion ||
      v.EV_METADATA_VERSION !== input.nativeMetadataVersion
    )
      throw Error("CONFIGURATION_BC_GUARD_BINDING_INVALID")
    for (const name of names) {
      const allowed = new Set(
          configurationBcGuardKeys
            .filter((k) => k.tableName === name)
            .map((k) => keyOf(name, k.key))
        ),
        seen = new Set<string>()
      for (const row of v[`ET_${name}`]) {
        const key = keyOf(name, row)
        if (!allowed.has(key) || seen.has(key))
          throw Error("CONFIGURATION_BC_GUARD_RESPONSE_SCOPE_INVALID")
        seen.add(key)
      }
    }
    return v
  }
  const first = await invoke(),
    second = await invoke()
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw Error("CONFIGURATION_BC_GUARD_READ_CHANGED")
  const after = await route()
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw Error("CONFIGURATION_BC_GUARD_ROUTE_CHANGED")
  if (JSON.stringify(await attest()) !== JSON.stringify(definition))
    throw Error("CONFIGURATION_BC_GUARD_METADATA_CHANGED")
  const states = configurationBcGuardKeys.map(({ tableName, key }) => {
    const values = first[`ET_${tableName}`].find(
      (row) => keyOf(tableName, row) === keyOf(tableName, key)
    )
    return {
      tableName,
      key,
      status: values ? ("present" as const) : ("missing" as const),
      values: values ?? null
    }
  })
  return {
    ...input,
    client,
    readOnly: true,
    executable: false,
    activationAvailable: false,
    methodExecutionAvailable: false,
    snapshot: false,
    guardVersion: first.EV_GUARD_VERSION,
    versionOrigin: "sap_sha256_native_data_buffer",
    states,
    scope: {
      object: before.object,
      keyCount: states.length,
      memberTables: names,
      allCuniKeys: false
    },
    native: first,
    bodyFingerprint: createHash("sha256").update(body).digest("hex"),
    evidence: {
      apiInvocations,
      apiInvocationLimit: 2,
      metadataReads,
      metadataReadLimit: 10,
      routeReads,
      routeReadLimit: 2
    },
    warning:
      "Complete fields for eight fixed related keys only. Missing rows are observations, not validation or permission to create. Source/target/route versions and sequential reads are bound; no locked snapshot, whole CUNI coverage, activation, methods, configuration/CTS/log writes or recovery is provided."
  }
}
