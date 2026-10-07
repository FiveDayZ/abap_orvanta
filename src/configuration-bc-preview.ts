import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import { configurationUnitApiBody } from "./configuration-unit-api.js"
import {
  configurationBcNativeSchema,
  type readConfigurationBcNative
} from "./configuration-bc-native.js"
import { configurationBcNativeLayouts as layouts } from "./configuration-bc-native-api.js"
import { configurationBcPreviewApi as api } from "./configuration-bc-preview-api.js"
import {
  configurationBcPreviewFunctions as functions,
  configurationBcPreviewIncludes as includes,
  configurationBcPreviewStructures as structures
} from "./configuration-bc-preview-pins.js"

const hex = z.string().regex(/^[a-f0-9]{64}$/)
export const configurationBcPreviewSchema = configurationBcNativeSchema
  .extend({
    nativeSourceVersion: hex,
    nativeTargetVersion: hex
  })
  .strict()
export const configurationBcPreviewSourceVersion =
  "73783f69f1bf9805b058fbc9bab0adb8cc8047f85c837ee16c174a9edd0f512b"
const body = configurationUnitApiBody([...api.source])
export const configurationBcPreviewBodyFingerprint = createHash("sha256").update(body).digest("hex")
const sorted = (rows: readonly unknown[]) =>
  JSON.stringify([...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
export function attestConfigurationBcPreviewApi(raw: unknown) {
  const parameter = z.object({
    name: z.string(),
    typeName: z.string(),
    optional: z.boolean(),
    passByValue: z.boolean()
  })
  const result = z
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
  if (
    configurationUnitApiBody(result.source) !== body ||
    result.source.filter((s) => /^\s*FUNCTION /i.test(s)).length !== 1 ||
    result.source
      .find((s) => /^\s*FUNCTION /i.test(s))
      ?.trim()
      .toUpperCase() !== `FUNCTION ${api.functionName}.` ||
    sorted(result.importParameters) !== sorted(api.importParameters) ||
    sorted(result.exportParameters) !== sorted(api.exportParameters) ||
    sorted(result.tableParameters) !== sorted(api.tableParameters)
  )
    throw Error("CONFIGURATION_BC_PREVIEW_API_NOT_ATTESTED")
  return { source: result.sourceFingerprint, interface: result.interfaceFingerprint }
}
type Snapshot = Awaited<ReturnType<typeof readConfigurationBcNative>>
type Name = "T006" | "T006A" | "T006B" | "T006C" | "T006D"
const names: Name[] = ["T006", "T006A", "T006B", "T006C", "T006D"]
const rowSchema = (name: Name) =>
  z
    .object(
      Object.fromEntries(
        layouts[name].fields.map((n) => [
          n,
          z
            .string()
            .max(128)
            .refine((s) => !/[\u0000-\u001f\u007f]/.test(s))
        ])
      )
    )
    .strict()
const responseSchema = z
  .object({
    EV_CODE: z.literal("PREVIEW_OK"),
    EV_SYSTEM: z.literal("GR2"),
    EV_CLIENT: z.literal("200"),
    EV_USER: z.string().min(1).max(12),
    EV_SOURCE_VERSION: hex,
    EV_TARGET_VERSION: hex,
    EV_CANDIDATE_VERSION: hex,
    EV_DIFFERENCES: z.string().max(5000),
    EV_ERROR_FIELD: z.literal(""),
    ET_T006: z.array(rowSchema("T006")).length(1),
    ET_T006A: z.array(rowSchema("T006A")).length(3),
    ET_T006B: z.array(rowSchema("T006B")).length(3),
    ET_T006C: z.array(rowSchema("T006C")).length(3),
    ET_T006D: z.array(rowSchema("T006D")).length(1)
  })
  .strict()

/** Fixed hypothetical standard USE update. This is not an activation plan or simulator. */
export { responseSchema as configurationBcPreviewResponseSchema }
export async function previewConfigurationBcNative(
  raw: unknown,
  client: string,
  backend: Pick<SapBackend, "callRemoteFunction">,
  readSnapshot: () => Promise<Snapshot>,
  readDefinition: (name: string) => Promise<unknown>,
  readStructure: (name: string) => Promise<unknown>,
  readInclude: (name: keyof typeof includes) => Promise<unknown>
) {
  const input = configurationBcPreviewSchema.parse(raw)
  if (client !== "200") throw Error("CONFIGURATION_BC_PREVIEW_SCOPE_UNSUPPORTED")
  if (input.nativeSourceVersion !== configurationBcPreviewSourceVersion)
    throw Error("CONFIGURATION_BC_PREVIEW_SOURCE_NOT_ATTESTED")
  const before = await readSnapshot()
  const checkSnapshot = (s: Snapshot) => {
    if (
      s.native.EV_SOURCE_VERSION !== input.nativeSourceVersion ||
      s.native.EV_TARGET_VERSION !== input.nativeTargetVersion
    )
      throw Error("CONFIGURATION_BC_PREVIEW_VERSION_CONFLICT")
    if (s.states.some((r) => r.mappingConflict))
      throw Error("CONFIGURATION_BC_PREVIEW_ALIAS_CONFLICT")
  }
  checkSnapshot(before)
  let metadataReads = 0,
    apiInvocations = 0
  const attest = async () => {
    for (const [name, pin] of Object.entries(functions)) {
      metadataReads++
      z.object({
        connectionId: z.literal("w200"),
        functionName: z.literal(name),
        remoteEnabled: z.literal(pin.remoteEnabled),
        updateTask: z.literal(false),
        sourceFingerprint: z.literal(pin.sourceFingerprint),
        interfaceFingerprint: z.literal(pin.interfaceFingerprint),
        source: z.array(z.string()).length(pin.lineCount)
      }).parse(await readDefinition(name))
    }
    for (const [name, pin] of Object.entries(structures)) {
      metadataReads++
      z.object({
        connectionId: z.literal("w200"),
        objectName: z.literal(name),
        objectKind: z.literal("structure"),
        fingerprint: z.literal(pin)
      }).parse(await readStructure(name))
    }
    for (const [name, pin] of Object.entries(includes)) {
      metadataReads++
      z.object({
        connectionId: z.literal("w200"),
        objectName: z.literal(name),
        sourceUri: z.literal(pin.sourceUri),
        sourceFingerprint: z.literal(pin.sourceFingerprint),
        lineCount: z.literal(pin.lineCount)
      }).parse(await readInclude(name as keyof typeof includes))
    }
    metadataReads++
    return attestConfigurationBcPreviewApi(await readDefinition(api.functionName))
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
    if (r.fault) throw Error("CONFIGURATION_BC_PREVIEW_FAULT")
    if (r.outputs.EV_CODE !== "PREVIEW_OK") {
      const code = z
        .enum([
          "SCOPE_UNSUPPORTED",
          "INPUT_INVALID",
          "SOURCE_NOT_ATTESTED",
          "READ_FAILED",
          "VERSION_CONFLICT",
          "ALIAS_CONFLICT",
          "USER_FORMAT_UNAVAILABLE",
          "SOURCE_CHANGED",
          "LAYOUT_UNAVAILABLE",
          "LAYOUT_UNSUPPORTED",
          "LAYOUT_CHANGED",
          "KEY_MISSING",
          "SOURCE_FLAG_UNSUPPORTED",
          "VALUE_TRUNCATED",
          "CONVERSION_FAILED",
          "CONVERSION_EXIT_UNREVIEWED",
          "USER_FORMAT_CHANGED",
          "HASH_FAILED"
        ])
        .safeParse(r.outputs.EV_CODE)
      throw Error(`CONFIGURATION_BC_PREVIEW_${code.success ? code.data : "INVALID_RESPONSE"}`)
    }
    const v = responseSchema.parse(r.outputs)
    if (
      v.EV_SOURCE_VERSION !== input.nativeSourceVersion ||
      v.EV_TARGET_VERSION !== input.nativeTargetVersion ||
      v.EV_USER !== before.native.EV_USER
    )
      throw Error("CONFIGURATION_BC_PREVIEW_BINDING_INVALID")
    for (const name of names)
      for (const [i, row] of v[`ET_${name}`].entries()) {
        if (
          row.MANDT !== "200" ||
          (row.SPRAS !== undefined && row.SPRAS !== ["1", "D", "E"][i]) ||
          (name === "T006D" ? row.DIMID !== "PRESS" : row.MSEHI !== "KNM") ||
          (name === "T006B" && row.MSEH3 !== "KNM") ||
          (name === "T006C" && row.MSEH6 !== "kN/m2")
        )
          throw Error("CONFIGURATION_BC_PREVIEW_RESPONSE_SCOPE_INVALID")
      }
    return v
  }
  const first = await invoke(),
    second = await invoke()
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw Error("CONFIGURATION_BC_PREVIEW_READ_CHANGED")
  const after = await readSnapshot()
  checkSnapshot(after)
  if (JSON.stringify(before.native) !== JSON.stringify(after.native))
    throw Error("CONFIGURATION_BC_PREVIEW_BEFORE_CHANGED")
  if (JSON.stringify(await attest()) !== JSON.stringify(definition))
    throw Error("CONFIGURATION_BC_PREVIEW_METADATA_CHANGED")
  const entries = first.EV_DIFFERENCES.split(";")
  if (entries.pop() !== "") throw Error("CONFIGURATION_BC_PREVIEW_DIFF_INVALID")
  let index = 0
  const rows = names.flatMap((name) =>
    first[`ET_${name}`].map((row, i) => {
      const old = before.native[`ET_${name}`].find(
        (r) => row.SPRAS === undefined || r.SPRAS === row.SPRAS
      )
      const differences = layouts[name].fields.map((field) => {
        const prefix = `${name}:${i + 1}:${field}:`,
          entry = entries[index++]
        if (!entry?.startsWith(prefix)) throw Error("CONFIGURATION_BC_PREVIEW_DIFF_INVALID")
        const status = z.enum(["NEW", "CHG", "EQL"]).parse(entry.slice(prefix.length))
        if ((!old && status !== "NEW") || (old && status === "NEW"))
          throw Error("CONFIGURATION_BC_PREVIEW_DIFF_INVALID")
        return {
          field,
          status,
          before: old?.[field] ?? null,
          after: row[field]!,
          comparisonOrigin: "sap_typed_field_comparison" as const
        }
      })
      return {
        tableName: name,
        key: before.states.find(
          (s) => s.tableName === name && (row.SPRAS === undefined || s.key.SPRAS === row.SPRAS)
        )!.key,
        status: old
          ? differences.some((d) => d.status === "CHG")
            ? "change"
            : "unchanged"
          : "create",
        before: old ?? null,
        after: row,
        differences,
        sharedDimension: name === "T006D"
      }
    })
  )
  if (index !== entries.length) throw Error("CONFIGURATION_BC_PREVIEW_DIFF_INVALID")
  return {
    ...input,
    client,
    readOnly: true,
    activationAvailable: false,
    saveAvailable: false,
    executable: false,
    simulation: false,
    snapshot: false,
    candidateVersion: first.EV_CANDIDATE_VERSION,
    versionOrigin: "sap_sha256_native_data_buffer",
    policy: "CREATE_INITIAL_OR_UPDATE_USE",
    languagePolicy: {
      sourcePlaceholder: "D",
      selected: ["1", "D", "E"],
      approvedForActivation: false
    },
    clientMapping: { source: "001", target: "200" },
    omittedFields: { T006: ["PRESS_VAL", "PRESS_UNIT"], T006D: ["PRESS_DEP"] },
    rows,
    native: first,
    bodyFingerprint: configurationBcPreviewBodyFingerprint,
    evidence: {
      apiInvocations,
      apiInvocationLimit: 2,
      metadataReads,
      metadataReadLimit: 28,
      before: before.evidence,
      after: after.evidence
    },
    warning:
      "Hypothetical standard USE update: new rows start initial; existing rows retain omitted fields. Source-client and language overlay are explicit preview choices, not approved activation options. Shared PRESS affects other units. No standard loader, activation, simulation, CTS, logs, commit or configuration write is called. Sequential repeated observations are not locked snapshots; SOAP values are display strings, equality and versions originate in SAP."
  }
}
