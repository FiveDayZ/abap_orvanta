import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import {
  configurationBcCtsApi as api,
  configurationBcCtsDependencies as dependencies,
  configurationBcCtsLayouts as layouts
} from "./configuration-bc-cts-api.js"
import { configurationUnitApiBody } from "./configuration-unit-api.js"

export const configurationBcCtsSchema = z
  .object({
    connectionId: z.literal("w200"),
    bcSetId: z.literal("EHS_CUNI_KNM"),
    version: z.literal("N"),
    requestNumber: z.literal("GR2K923429"),
    taskNumber: z.literal("GR2K923430")
  })
  .strict()
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
  tableParameters: z.array(z.never()),
  changingParameters: z.array(z.never()),
  exceptions: z.array(z.never()),
  sourceFingerprint: hex,
  interfaceFingerprint: hex,
  source: z.array(z.string())
})
const body = configurationUnitApiBody(api.source)
export const configurationBcCtsBodyFingerprint = createHash("sha256").update(body).digest("hex")
export function attestConfigurationBcCtsApi(raw: unknown) {
  const v = definition.parse(raw)
  const sorted = (rows: readonly unknown[]) =>
    JSON.stringify([...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
  const headers = v.source.filter((line) => /^\s*FUNCTION\s+/i.test(line))
  if (
    headers.length !== 1 ||
    headers[0]!.trim().toUpperCase() !== `FUNCTION ${api.functionName}.` ||
    configurationUnitApiBody(v.source) !== body ||
    sorted(v.importParameters) !== sorted(api.importParameters) ||
    sorted(v.exportParameters) !== sorted(api.exportParameters)
  )
    throw Error("CONFIGURATION_BC_CTS_API_NOT_ATTESTED")
  return { source: v.sourceFingerprint, interface: v.interfaceFingerprint }
}
const count = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,2})$/)
  .transform(Number)
  .pipe(z.number().max(256))
const response = z
  .object({
    EV_CODE: z.literal("CTS_READ_OK"),
    EV_SYSTEM: z.literal("GR2"),
    EV_CLIENT: z.literal("200"),
    EV_USER: z.string().regex(/^[A-Z0-9_]{1,12}$/),
    EV_REQUEST: z.literal("GR2K923429"),
    EV_TASK: z.literal("GR2K923430"),
    EV_CTS_VERSION: hex,
    EV_DATA_BASE64: z.string().min(4).max(699052),
    EV_DATA_BYTES: z.string().regex(/^[1-9][0-9]{0,5}$/),
    EV_OBJECT_COUNT: count,
    EV_KEY_COUNT: count,
    EV_STRING_KEY_COUNT: count
  })
  .strict()
const refusals = z.enum([
  "SCOPE_UNSUPPORTED",
  "INPUT_INVALID",
  "AUTHORIZATION_DENIED",
  "LIMIT_EXCEEDED",
  "READ_FAILED",
  "HEADER_MISSING",
  "CLIENT_MISSING",
  "HEADER_SCOPE_INVALID",
  "ENTRY_SCOPE_INVALID",
  "READ_CHANGED",
  "HASH_FAILED",
  "ENCODING_FAILED"
])

/** Exact customer API attestation is required before any native dispatch. */
export async function readConfigurationBcCts(
  raw: unknown,
  client: string,
  username: string,
  backend: Pick<SapBackend, "callRemoteFunction">,
  readers: {
    definition: (name: string) => Promise<unknown>
    table: (name: string) => Promise<unknown>
  }
) {
  const input = configurationBcCtsSchema.parse(raw)
  if (client !== "200") throw Error("CONFIGURATION_BC_CTS_SCOPE_UNSUPPORTED")
  const attest = async () => {
    const checks = [
      async () => attestConfigurationBcCtsApi(await readers.definition(api.functionName)),
      ...Object.entries(dependencies).map(([name, pin]) => async () => {
        const v = z
          .object({
            connectionId: z.literal("w200"),
            functionName: z.literal(name),
            remoteEnabled: z.literal(pin.remoteEnabled),
            updateTask: z.literal(false),
            sourceFingerprint: z.literal(pin.source),
            interfaceFingerprint: z.literal(pin.interface)
          })
          .parse(await readers.definition(name))
        return {
          functionName: name,
          source: v.sourceFingerprint,
          interface: v.interfaceFingerprint
        }
      }),
      ...Object.entries(layouts).map(([name, pin]) => async () => {
        const v = z
          .object({
            connectionId: z.literal("w200"),
            objectName: z.literal(name),
            objectKind: z.literal("transparentTable"),
            fingerprint: z.literal(pin)
          })
          .parse(await readers.table(name))
        return { tableName: name, layout: v.fingerprint }
      })
    ]
    const result = []
    for (let offset = 0; offset < checks.length; offset += 4) {
      const settled = await Promise.allSettled(
        checks.slice(offset, offset + 4).map((read) => read())
      )
      for (const v of settled) {
        if (v.status === "rejected") throw v.reason
        result.push(v.value)
      }
    }
    return result
  }
  const identities = await attest()
  const invoke = async () => {
    const r = await backend.callRemoteFunction("w200", {
      functionName: api.functionName,
      inputParameters: {
        IV_BC_SET: input.bcSetId,
        IV_VERSION: input.version,
        IV_REQUEST: input.requestNumber,
        IV_TASK: input.taskNumber
      },
      outputParameters: api.exportParameters.map((p) => ({ name: p.name, kind: "scalar" as const }))
    })
    if (r.fault) throw Error("CONFIGURATION_BC_CTS_FAULT")
    if (r.outputs.EV_CODE !== "CTS_READ_OK") {
      const code = refusals.safeParse(r.outputs.EV_CODE)
      throw Error(`CONFIGURATION_BC_CTS_${code.success ? code.data : "INVALID_RESPONSE"}`)
    }
    const v = response.parse(r.outputs)
    if (v.EV_USER !== username.toUpperCase()) throw Error("CONFIGURATION_BC_CTS_BINDING_INVALID")
    const bytes = Buffer.from(v.EV_DATA_BASE64, "base64")
    if (
      bytes.length === 0 ||
      bytes.length > 524288 ||
      bytes.length !== Number(v.EV_DATA_BYTES) ||
      bytes.toString("base64") !== v.EV_DATA_BASE64 ||
      createHash("sha256").update(bytes).digest("hex") !== v.EV_CTS_VERSION
    )
      throw Error("CONFIGURATION_BC_CTS_BUFFER_INVALID")
    return v
  }
  const first = await invoke(),
    second = await invoke()
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw Error("CONFIGURATION_BC_CTS_READ_CHANGED")
  if (JSON.stringify(await attest()) !== JSON.stringify(identities))
    throw Error("CONFIGURATION_BC_CTS_METADATA_CHANGED")
  return {
    ...input,
    system: first.EV_SYSTEM,
    client,
    user: first.EV_USER,
    readOnly: true,
    executable: false,
    activationAvailable: false,
    snapshot: false,
    recoveryAvailable: false,
    scope: "two_complete_transport_roots_not_a_CUNI_projection",
    counts: {
      objects: first.EV_OBJECT_COUNT,
      keys: first.EV_KEY_COUNT,
      stringKeys: first.EV_STRING_KEY_COUNT
    },
    ctsVersion: first.EV_CTS_VERSION,
    buffer: {
      format: "sap_export_data_buffer_base64",
      encoding: "opaque_native_typed_data",
      data: first.EV_DATA_BASE64,
      bytes: Number(first.EV_DATA_BYTES),
      keyPaddingPreserved: true,
      clientSideImportAvailable: false,
      recoveryPermit: false
    },
    bodyFingerprint: configurationBcCtsBodyFingerprint,
    identities,
    evidence: { apiInvocations: 2, identityPasses: 2, rawBytesRechecked: true },
    warning:
      "Requires the exact approved customer API. Entire fixed request/task CTS rows include unrelated entries for preservation. Native bytes retain padding and string keys; they are opaque to the client and are not a restore command. Sequential observations are not locked snapshots. No activation, simulation, CTS/configuration write, cleanup, commit or release is performed."
  }
}
