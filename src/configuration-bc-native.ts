import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import { configurationUnitApiBody } from "./configuration-unit-api.js"
import {
  configurationBcNativeReadApi as api,
  configurationBcNativeLayouts as layouts
} from "./configuration-bc-native-api.js"
import { configurationBcNativeTypes } from "./configuration-bc-native-types.js"

export const configurationBcNativeSchema = z
  .object({
    connectionId: z.literal("w200"),
    bcSetId: z.literal("EHS_CUNI_KNM"),
    version: z.literal("N")
  })
  .strict()

export const configurationBcNativeSourcePins = {
  T006: "68445907a7e02498cba125b359631f8121b8f411f1651f6b8a32cbab27d1cbb1",
  T006A: "b3adb6899b5fe95f18838d2bf2eec361f3359d20fcb6d7b9d5f10f6e33df0c2b",
  T006B: "41f208bfc3d3a11116fd4d102ee064541ecab5dedcc3fca1024cf6c87d9bad51",
  T006C: "6ca82a7a54b68e4e0dfa81d93ff428b37461463719cd31748155feb7f3b01d0f",
  T006D: "f71a3ed75487b48a905e0a79c7bf0f5569e3114dad901c12fca34899cb90057c"
} as const
const tableNames = Object.keys(
  configurationBcNativeSourcePins
) as (keyof typeof configurationBcNativeSourcePins)[]
const expectedBody = configurationUnitApiBody(api.source)
export const configurationBcNativeBodyFingerprint = createHash("sha256")
  .update(expectedBody)
  .digest("hex")
const hex = z.string().regex(/^[a-f0-9]{64}$/)
const parameter = z.object({
  name: z.string(),
  typeName: z.string(),
  optional: z.boolean(),
  passByValue: z.boolean()
})
const definition = z.object({
  connectionId: z.literal("w200"),
  functionName: z.literal(api.functionName),
  functionGroup: z.literal(api.functionGroup),
  remoteEnabled: z.literal(true),
  updateTask: z.literal(false),
  updateTaskMode: z.literal(""),
  importParameters: z.array(parameter),
  exportParameters: z.array(parameter),
  tableParameters: z.array(parameter),
  changingParameters: z.array(z.never()),
  exceptions: z.array(z.never()),
  sourceFingerprint: hex,
  interfaceFingerprint: hex,
  source: z.array(z.string())
})
export function attestConfigurationBcNativeApi(raw: unknown) {
  const value = definition.parse(raw)
  const sorted = (rows: readonly unknown[]) =>
    JSON.stringify([...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
  const headers = value.source.filter((line) => /^\s*FUNCTION\s+/i.test(line))
  if (
    headers.length !== 1 ||
    headers[0]!.trim().toUpperCase() !== `FUNCTION ${api.functionName}.` ||
    configurationUnitApiBody(value.source) !== expectedBody ||
    sorted(value.importParameters) !== sorted(api.importParameters) ||
    sorted(value.exportParameters) !== sorted(api.exportParameters) ||
    sorted(value.tableParameters) !== sorted(api.tableParameters)
  )
    throw Error("CONFIGURATION_BC_NATIVE_API_NOT_ATTESTED")
  return { source: value.sourceFingerprint, interface: value.interfaceFingerprint }
}

const fields = (name: keyof typeof layouts) =>
  z
    .object(
      Object.fromEntries(
        layouts[name].fields.map((n) => [
          n,
          z
            .string()
            .max(128)
            .refine((v) => !/[\u0000-\u001f\u007f]/.test(v))
        ])
      )
    )
    .strict()
const snapshotSchema = z
  .object({
    EV_CODE: z.literal("READ_OK"),
    EV_SYSTEM: z.literal("GR2"),
    EV_CLIENT: z.literal("200"),
    EV_USER: z.string().min(1).max(12),
    EV_SOURCE_VERSION: hex,
    EV_TARGET_VERSION: hex,
    ET_T006: z.array(fields("T006")).max(1),
    ET_T006A: z.array(fields("T006A")).max(3),
    ET_T006B: z.array(fields("T006B")).max(3),
    ET_T006C: z.array(fields("T006C")).max(3),
    ET_T006D: z.array(fields("T006D")).max(1)
  })
  .strict()
export function scopedSnapshot(raw: unknown) {
  const value = snapshotSchema.parse(raw)
  for (const name of tableNames) {
    const rows = value[`ET_${name}`],
      seen = new Set<string>()
    for (const row of rows) {
      const language = row.SPRAS?.trimEnd(),
        key =
          name === "T006D"
            ? row.DIMID
            : name === "T006B"
              ? row.MSEH3
              : name === "T006C"
                ? row.MSEH6
                : row.MSEHI
      if (
        row.MANDT !== "200" ||
        key?.trimEnd() !== (name === "T006D" ? "PRESS" : name === "T006C" ? "kN/m2" : "KNM") ||
        ((name === "T006A" || name === "T006B" || name === "T006C") &&
          !["1", "D", "E"].includes(language ?? "")) ||
        seen.has(language ?? "")
      )
        throw Error("CONFIGURATION_BC_NATIVE_RESPONSE_SCOPE_INVALID")
      seen.add(language ?? "")
    }
  }
  return value
}

/** Native before-state only. No source-to-target conversion, mutation or activation route. */
export async function readConfigurationBcNative(
  raw: unknown,
  client: string,
  backend: Pick<SapBackend, "callRemoteFunction">,
  readDefinition: (name: string) => Promise<unknown>,
  readTable: (name: string) => Promise<unknown>,
  readType: (kind: "dataElement" | "domain", name: string) => Promise<unknown>,
  readSource: (name: keyof typeof configurationBcNativeSourcePins) => Promise<unknown>
) {
  const input = configurationBcNativeSchema.parse(raw)
  if (client !== "200") throw Error("CONFIGURATION_BC_NATIVE_SCOPE_UNSUPPORTED")
  let calls = 0,
    sourceReads = 0,
    metadataReads = 0
  const source = async () => {
    for (const name of tableNames) {
      sourceReads++
      const result = z
        .object({
          connectionId: z.literal("w200"),
          client: z.literal("200"),
          bcSetId: z.literal(input.bcSetId),
          version: z.literal("N"),
          objectName: z.literal(name),
          readOnly: z.literal(true),
          readFingerprint: z.literal(configurationBcNativeSourcePins[name]),
          recordInventory: z.object({
            complete: z.literal(true),
            fingerprint: z.literal(
              "d9653312beab7ac191387dbd41ae7ee5e87e010a14d7b4c2432c08565c3aecce"
            )
          }),
          coverage: z.object({ truncated: z.literal(false) }),
          dependencies: z.array(z.never())
        })
        .safeParse(await readSource(name))
      if (!result.success) throw Error("CONFIGURATION_BC_NATIVE_SOURCE_NOT_ATTESTED")
    }
  }
  const attest = async () => {
    for (const [name, expected] of Object.entries(layouts)) {
      metadataReads++
      const result = z
        .object({
          connectionId: z.literal("w200"),
          objectName: z.literal(name),
          objectKind: z.literal("transparentTable"),
          fingerprint: z.literal(expected.fingerprint),
          definition: z.object({ fields: z.array(z.object({ name: z.string() })) })
        })
        .parse(await readTable(name))
      if (
        JSON.stringify(result.definition.fields.map((f) => f.name)) !==
        JSON.stringify(expected.fields)
      )
        throw Error("CONFIGURATION_BC_NATIVE_LAYOUT_NOT_ATTESTED")
    }
    for (const expected of Object.values(configurationBcNativeTypes)) {
      metadataReads++
      z.object({
        connectionId: z.literal("w200"),
        objectName: z.literal(expected.name),
        objectKind: z.literal(expected.kind),
        fingerprint: z.literal(expected.fingerprint)
      }).parse(await readType(expected.kind, expected.name))
    }
    metadataReads++
    z.object({
      connectionId: z.literal("w200"),
      functionName: z.literal("CALCULATE_HASH_FOR_RAW"),
      remoteEnabled: z.literal(false),
      updateTask: z.literal(false),
      sourceFingerprint: z.literal(
        "874f8e777eda4b72aecd34ab11153af0fe291ca777b8023c96c13c1119bfd458"
      ),
      interfaceFingerprint: z.literal(
        "9d0e795153f6118bb966e18c6d4bdbca7e66f927c75bfe8e9fcf22d4fb153779"
      )
    }).parse(await readDefinition("CALCULATE_HASH_FOR_RAW"))
    metadataReads++
    return attestConfigurationBcNativeApi(await readDefinition(api.functionName))
  }
  await source()
  const before = await attest()
  const invoke = async () => {
    calls++
    const r = await backend.callRemoteFunction("w200", {
      functionName: api.functionName,
      inputParameters: {
        IV_BC_SET: input.bcSetId,
        IV_VERSION: input.version,
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
    if (r.fault) throw Error("CONFIGURATION_BC_NATIVE_READ_FAULT")
    if (r.outputs.EV_CODE !== "READ_OK") {
      const code = z
        .enum([
          "SCOPE_UNSUPPORTED",
          "INPUT_INVALID",
          "AUTHORIZATION_DENIED",
          "SOURCE_NOT_FOUND",
          "SOURCE_SCOPE_INVALID",
          "SOURCE_LIMIT_EXCEEDED",
          "READ_CHANGED",
          "HASH_FAILED"
        ])
        .safeParse(r.outputs.EV_CODE)
      throw Error(`CONFIGURATION_BC_NATIVE_${code.success ? code.data : "INVALID_RESPONSE"}`)
    }
    return scopedSnapshot(r.outputs)
  }
  const first = await invoke(),
    second = await invoke()
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw Error("CONFIGURATION_BC_NATIVE_READ_CHANGED")
  await source()
  if (JSON.stringify(await attest()) !== JSON.stringify(before))
    throw Error("CONFIGURATION_BC_NATIVE_METADATA_CHANGED")
  const states = tableNames.flatMap((name) =>
    (["T006A", "T006B", "T006C"].includes(name) ? ["1", "D", "E"] : [null]).map((language) => {
      const row = first[`ET_${name}`].find(
        (r) => language === null || r.SPRAS?.trimEnd() === language
      )
      return {
        tableName: name,
        key: {
          MANDT: "200",
          ...(language === null ? {} : { SPRAS: language }),
          ...(name === "T006D"
            ? { DIMID: "PRESS" }
            : name === "T006B"
              ? { MSEH3: "KNM" }
              : name === "T006C"
                ? { MSEH6: "kN/m2" }
                : { MSEHI: "KNM" })
        },
        status: row ? "present" : "missing",
        mappingConflict:
          row && (name === "T006B" || name === "T006C") ? row.MSEHI!.trimEnd() !== "KNM" : false
      }
    })
  )
  return {
    ...input,
    client,
    readOnly: true,
    activationAvailable: false,
    saveAvailable: false,
    snapshot: false,
    versionOrigin: "sap_sha256_native_data_buffer",
    versionScope:
      "complete_five_table_rows_including_missing_rows_and_FLTP; GR2/200/user/EHS_CUNI_KNM/N",
    sourceValueFingerprints: configurationBcNativeSourcePins,
    bodyFingerprint: configurationBcNativeBodyFingerprint,
    states,
    native: first,
    evidence: {
      apiInvocations: calls,
      apiInvocationLimit: 2,
      sourceReaderInvocations: sourceReads,
      sourceReaderInvocationLimit: 10,
      metadataReads,
      metadataReadLimit: 248
    },
    warning:
      "Sequential repeated observations are not a locked snapshot. SOAP fields are display strings; native versions retain full typed rows, float fields and padding. No language overlay, value conversion, activation, simulation, CTS recording or write approval is produced."
  }
}
