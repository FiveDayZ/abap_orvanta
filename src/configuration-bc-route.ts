import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import { configurationUnitApiBody } from "./configuration-unit-api.js"
import {
  configurationBcPreviewSchema,
  configurationBcPreviewSourceVersion
} from "./configuration-bc-preview.js"
import type { readConfigurationBcNative } from "./configuration-bc-native.js"
import {
  configurationBcRouteApi as api,
  configurationBcRouteLayouts as layouts
} from "./configuration-bc-route-api.js"

export const configurationBcRouteSchema = configurationBcPreviewSchema
export const configurationBcRouteIncludes = {
  RDDSOBJI: {
    sourceUri: "/sap/bc/adt/programs/includes/rddsobji/source/main",
    sourceFingerprint: "15681f5ca997cd9a93719c86d33f6e383fcf9acefdbecccc64a59fb851038dd4",
    lineCount: 136
  },
  MUNITF03: {
    sourceUri: "/sap/bc/adt/programs/includes/munitf03/source/main",
    sourceFingerprint: "392e2a6ca2eb60bd4dd15c44edcf4cd031670f7dffe6131bb76822803330d6f7",
    lineCount: 312
  }
} as const
const hex = z.string().regex(/^[a-f0-9]{64}$/)
const body = configurationUnitApiBody(api.source)
const sorted = (rows: readonly unknown[]) =>
  JSON.stringify([...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
export function attestConfigurationBcRouteApi(raw: unknown) {
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
    throw Error("CONFIGURATION_BC_ROUTE_API_NOT_ATTESTED")
  return { source: v.sourceFingerprint, interface: v.interfaceFingerprint }
}
type Snapshot = Awaited<ReturnType<typeof readConfigurationBcNative>>
type Name = keyof typeof layouts
const row = (name: Name) =>
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
    EV_CODE: z.literal("ROUTE_READ_OK"),
    EV_SYSTEM: z.literal("GR2"),
    EV_CLIENT: z.literal("200"),
    EV_USER: z.string().min(1).max(12),
    EV_SOURCE_VERSION: hex,
    EV_TARGET_VERSION: hex,
    EV_METADATA_VERSION: hex,
    ET_OBJH: z.array(row("OBJH")).length(1),
    ET_OBJS: z.array(row("OBJS")).min(1).max(20),
    ET_OBJM: z.array(row("OBJM")).max(10)
  })
  .strict()

/** CUNI/T metadata and method source observations. No method is executed. */
export { response as configurationBcRouteResponseSchema }
export async function inspectConfigurationBcRoute(
  raw: unknown,
  client: string,
  backend: Pick<SapBackend, "callRemoteFunction">,
  readSnapshot: () => Promise<Snapshot>,
  readDefinition: (name: string) => Promise<unknown>,
  readTable: (name: Name) => Promise<unknown>,
  readInclude: (name: keyof typeof configurationBcRouteIncludes) => Promise<unknown>
) {
  const input = configurationBcRouteSchema.parse(raw)
  if (client !== "200") throw Error("CONFIGURATION_BC_ROUTE_SCOPE_UNSUPPORTED")
  if (input.nativeSourceVersion !== configurationBcPreviewSourceVersion)
    throw Error("CONFIGURATION_BC_ROUTE_SOURCE_NOT_ATTESTED")
  const before = await readSnapshot()
  const check = (snapshot: Snapshot) => {
    if (
      snapshot.native.EV_SOURCE_VERSION !== input.nativeSourceVersion ||
      snapshot.native.EV_TARGET_VERSION !== input.nativeTargetVersion
    )
      throw Error("CONFIGURATION_BC_ROUTE_VERSION_CONFLICT")
  }
  check(before)
  let metadataReads = 0,
    apiInvocations = 0
  const attest = async () => {
    for (const name of Object.keys(layouts) as Name[]) {
      metadataReads++
      z.object({
        connectionId: z.literal("w200"),
        objectKind: z.literal("transparentTable"),
        objectName: z.literal(name),
        fingerprint: z.literal(layouts[name].fingerprint)
      }).parse(await readTable(name))
    }
    for (const [name, pin] of Object.entries(configurationBcRouteIncludes)) {
      metadataReads++
      z.object({
        connectionId: z.literal("w200"),
        objectName: z.literal(name),
        sourceUri: z.literal(pin.sourceUri),
        sourceFingerprint: z.literal(pin.sourceFingerprint),
        lineCount: z.literal(pin.lineCount)
      }).parse(await readInclude(name as keyof typeof configurationBcRouteIncludes))
    }
    metadataReads++
    return attestConfigurationBcRouteApi(await readDefinition(api.functionName))
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
    if (r.fault) throw Error("CONFIGURATION_BC_ROUTE_FAULT")
    if (r.outputs.EV_CODE !== "ROUTE_READ_OK") {
      const code = z
        .enum([
          "SCOPE_UNSUPPORTED",
          "INPUT_INVALID",
          "SOURCE_NOT_ATTESTED",
          "AUTHORIZATION_DENIED",
          "READ_FAILED",
          "VERSION_CONFLICT",
          "OBJECT_NOT_DEFINED",
          "MEMBERS_MISSING",
          "MEMBER_LIMIT",
          "METHOD_LIMIT",
          "METADATA_CHANGED",
          "HASH_FAILED"
        ])
        .safeParse(r.outputs.EV_CODE)
      throw Error(`CONFIGURATION_BC_ROUTE_${code.success ? code.data : "INVALID_RESPONSE"}`)
    }
    const v = response.parse(r.outputs)
    if (
      v.EV_SOURCE_VERSION !== input.nativeSourceVersion ||
      v.EV_TARGET_VERSION !== input.nativeTargetVersion ||
      v.EV_USER !== before.native.EV_USER
    )
      throw Error("CONFIGURATION_BC_ROUTE_BINDING_INVALID")
    for (const name of Object.keys(layouts) as Name[]) {
      const seen = new Set<string>()
      for (const row of v[`ET_${name}`]) {
        if (row.OBJECTNAME !== "CUNI" || row.OBJECTTYPE !== "T")
          throw Error("CONFIGURATION_BC_ROUTE_RESPONSE_SCOPE_INVALID")
        const key = JSON.stringify(layouts[name].keys.map((k) => row[k]))
        if (seen.has(key)) throw Error("CONFIGURATION_BC_ROUTE_DUPLICATE_KEY")
        seen.add(key)
      }
    }
    // SOAP serializes an initial DATS as 0000-00-00; keep the native text.
    if (
      v.ET_OBJH[0]!.LUSER !== "" ||
      !["", "00000000", "0000-00-00"].includes(v.ET_OBJH[0]!.LDATE!)
    )
      throw Error("CONFIGURATION_BC_ROUTE_AUDIT_FIELDS_UNEXPECTED")
    for (const method of v.ET_OBJM)
      if (
        !["AFTER_IMP", "BEFORE_EXP"].includes(method.METHOD!) ||
        !/^[/A-Z0-9_]{1,30}$/.test(method.METHODNAME!)
      )
        throw Error("CONFIGURATION_BC_ROUTE_METHOD_INVALID")
    return v
  }
  const first = await invoke(),
    second = await invoke()
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw Error("CONFIGURATION_BC_ROUTE_READ_CHANGED")
  const methodNames = [...new Set(first.ET_OBJM.map((m) => m.METHODNAME!))].sort()
  const readMethods = async () => {
    const methods = []
    for (const name of methodNames) {
      metadataReads++
      const v = z
        .object({
          connectionId: z.literal("w200"),
          functionName: z.literal(name),
          remoteEnabled: z.boolean(),
          updateTask: z.boolean(),
          sourceFingerprint: hex,
          interfaceFingerprint: hex,
          source: z.array(z.string()).min(1).max(10000)
        })
        .parse(await readDefinition(name))
      methods.push({
        functionName: name,
        remoteEnabled: v.remoteEnabled,
        updateTask: v.updateTask,
        sourceFingerprint: v.sourceFingerprint,
        interfaceFingerprint: v.interfaceFingerprint,
        lineCount: v.source.length
      })
    }
    return methods
  }
  const methodSources = await readMethods()
  const after = await readSnapshot()
  check(after)
  if (JSON.stringify(before.native) !== JSON.stringify(after.native))
    throw Error("CONFIGURATION_BC_ROUTE_TARGET_CHANGED")
  if (
    JSON.stringify(await attest()) !== JSON.stringify(definition) ||
    JSON.stringify(await readMethods()) !== JSON.stringify(methodSources)
  )
    throw Error("CONFIGURATION_BC_ROUTE_METADATA_CHANGED")
  const header = first.ET_OBJH[0]!
  return {
    ...input,
    client,
    readOnly: true,
    executable: false,
    activationAvailable: false,
    methodExecutionAvailable: false,
    snapshot: false,
    metadataVersion: first.EV_METADATA_VERSION,
    versionOrigin: "sap_sha256_native_data_buffer",
    object: { name: "CUNI", type: "T", transportType: "TDAT" },
    importHandling:
      (
        { "": "unknown", "1": "not_importable", "2": "dialog", "3": "automatic" } as Record<
          string,
          string
        >
      )[header.IMPORTABLE!] ?? "unknown",
    transportHandling:
      (
        { "": "unknown", "1": "manual", "2": "automatic", "3": "not_required" } as Record<
          string,
          string
        >
      )[header.OBJTRANSP!] ?? "unknown",
    members: first.ET_OBJS,
    methods: first.ET_OBJM,
    methodSources,
    otherMemberTables: first.ET_OBJS.map((m) => m.TABNAME!).filter(
      (n) => !["T006", "T006A", "T006B", "T006C", "T006D"].includes(n)
    ),
    unresolved: [
      "STANDARD_ACTIVATION_DEPENDENCIES_NOT_ATTESTED",
      "AFTER_IMPORT_DEPENDENCIES_NOT_ATTESTED",
      "CTS_AND_RECOVERY_NOT_ATTESTED"
    ],
    native: first,
    bodyFingerprint: createHash("sha256").update(body).digest("hex"),
    evidence: {
      apiInvocations,
      apiInvocationLimit: 2,
      metadataReads,
      metadataReadLimit: 32,
      before: before.evidence,
      after: after.evidence
    },
    warning:
      "Observed CUNI/T metadata and method source identities only. No dynamic method, GUI routine, activation, simulation, CTS, log or configuration write is invoked. Source readback does not prove an executable activation route or its dependencies. Repeated sequential observations are not locked snapshots."
  }
}
