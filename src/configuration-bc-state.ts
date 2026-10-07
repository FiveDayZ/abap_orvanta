import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import { configurationUnitApiBody } from "./configuration-unit-api.js"
import {
  configurationBcPreflightKeys,
  configurationBcPreflightSchema
} from "./configuration-bc-preflight.js"
import { configurationBcCtsSchema, type readConfigurationBcCts } from "./configuration-bc-cts.js"
import {
  configurationBcStateApi as api,
  configurationBcStateTables,
  configurationBcStateLayouts,
  configurationBcStateLayoutFingerprint
} from "./configuration-bc-state-api.js"
import { hashWriteInput } from "./write-operation-receipts.js"
import { configurationBcNativeReadApi } from "./configuration-bc-native-api.js"
import { configurationBcPreviewApi } from "./configuration-bc-preview-api.js"
import { configurationBcRouteApi } from "./configuration-bc-route-api.js"
import { configurationBcGuardApi } from "./configuration-bc-guard-api.js"
import { configurationBcCtsApi } from "./configuration-bc-cts-api.js"

const hex = z.string().regex(/^[a-f0-9]{64}$/)
const versions = ["source", "target", "candidate", "metadata", "guard"] as const
export const configurationBcStateSchema = configurationBcPreflightSchema
  .extend({
    requestNumber: z.literal("GR2K923429"),
    taskNumber: z.literal("GR2K923430"),
    nativeCtsVersion: hex
  })
  .strict()
const parameter = z.object({
  name: z.string(),
  typeName: z.string(),
  optional: z.boolean(),
  passByValue: z.boolean()
})
const body = configurationUnitApiBody(api.source)
export const configurationBcStateBodyFingerprint = createHash("sha256").update(body).digest("hex")
export function attestConfigurationBcStateApi(raw: unknown) {
  const v = z
    .object({
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
    .parse(raw)
  const headers = v.source.filter((line) => /^\s*FUNCTION\s+/i.test(line))
  const sorted = (rows: { name: string }[]) =>
    [...rows].sort((a, b) => a.name.localeCompare(b.name))
  if (
    headers.length !== 1 ||
    headers[0]!.trim().toUpperCase() !== `FUNCTION ${api.functionName}.` ||
    configurationUnitApiBody(v.source) !== body ||
    hashWriteInput(sorted(v.importParameters)) !== hashWriteInput(sorted(api.importParameters)) ||
    hashWriteInput(sorted(v.exportParameters)) !== hashWriteInput(sorted(api.exportParameters))
  )
    throw Error("CONFIGURATION_BC_STATE_API_NOT_ATTESTED")
  return { source: v.sourceFingerprint, interface: v.interfaceFingerprint }
}
const response = z
  .object({
    EV_CODE: z.literal("STATE_READ_OK"),
    EV_SYSTEM: z.literal("GR2"),
    EV_CLIENT: z.literal("200"),
    EV_USER: z.string().regex(/^[A-Z0-9_]{1,12}$/),
    EV_REQUEST: z.literal("GR2K923429"),
    EV_TASK: z.literal("GR2K923430"),
    EV_SOURCE_VERSION: hex,
    EV_TARGET_VERSION: hex,
    EV_CANDIDATE_VERSION: hex,
    EV_METADATA_VERSION: hex,
    EV_GUARD_VERSION: hex,
    EV_CTS_VERSION: hex,
    EV_STATE_VERSION: hex,
    EV_DATA_BASE64: z.string().min(4).max(699052),
    EV_DATA_BYTES: z.string().regex(/^[1-9][0-9]{0,5}$/),
    EV_ROW_COUNTS: z.string().max(160),
    EV_ROUNDTRIP: z.literal("X")
  })
  .strict()
const refusalCodes = new Set<string>([
  "SCOPE_UNSUPPORTED",
  "INPUT_INVALID",
  "DEPENDENCY_FAILED",
  "DEPENDENCY_REFUSED",
  "BINDING_INVALID",
  "VERSION_CONFLICT",
  "LIMIT_EXCEEDED",
  "ROUNDTRIP_FAILED",
  "READ_CHANGED",
  "HASH_FAILED",
  "ENCODING_FAILED"
])
// Preserve only root codes declared by the attested local dependency bodies, never arbitrary text.
for (const dependency of [
  configurationBcNativeReadApi,
  configurationBcPreviewApi,
  configurationBcRouteApi,
  configurationBcGuardApi,
  configurationBcCtsApi
])
  for (const line of dependency.source)
    for (const match of line.matchAll(/ev_code\s*=\s*'([A-Z0-9_]+)'/gi))
      if (!match[1]!.endsWith("_OK")) refusalCodes.add(match[1]!)
const refused = z.string().refine((value) => refusalCodes.has(value))
type Cts = Awaited<ReturnType<typeof readConfigurationBcCts>>

/** Composes already attested readers; no generic RFC execution, restore bytes or write permit. */
export async function readConfigurationBcBeforeState(
  raw: unknown,
  client: string,
  username: string,
  backend: Pick<SapBackend, "callRemoteFunction">,
  readers: {
    definition: () => Promise<unknown>
    preflight: (input: z.infer<typeof configurationBcPreflightSchema>) => Promise<unknown>
    cts: (input: z.infer<typeof configurationBcCtsSchema>) => Promise<Cts>
  }
) {
  const input = configurationBcStateSchema.parse(raw)
  if (client !== "200") throw Error("CONFIGURATION_BC_STATE_SCOPE_UNSUPPORTED")
  const { nativeCtsVersion, requestNumber, taskNumber, ...preflightInput } = input
  const ctsInput = configurationBcCtsSchema.parse({
    connectionId: input.connectionId,
    bcSetId: input.bcSetId,
    version: input.version,
    requestNumber,
    taskNumber
  })
  const identity = attestConfigurationBcStateApi(await readers.definition())
  const preflight = async () => {
    const v = z
      .object({
        ...configurationBcPreflightSchema.shape,
        system: z.literal("GR2"),
        client: z.literal("200"),
        user: z.literal(username.toUpperCase()),
        readOnly: z.literal(true),
        executable: z.literal(false),
        activationAvailable: z.literal(false),
        snapshot: z.literal(false),
        scope: z.object({
          object: z.literal("CUNI"),
          tableCount: z.literal(9),
          keyCount: z.literal(19),
          allCuniKeys: z.literal(false)
        }),
        versions: z
          .object({ source: hex, target: hex, candidate: hex, metadata: hex, guard: hex })
          .strict(),
        rows: z
          .array(
            z.object({
              tableName: z.string(),
              key: z.record(z.string()),
              presence: z.enum(["present", "missing"])
            })
          )
          .length(19),
        apiIdentities: z.array(z.unknown()).length(4)
      })
      .parse(await readers.preflight(preflightInput))
    for (const name of versions)
      if (
        v.versions[name] !==
        input[`native${name[0]!.toUpperCase()}${name.slice(1)}Version` as keyof typeof input]
      )
        throw Error("CONFIGURATION_BC_STATE_BINDING_INVALID")
    if (
      hashWriteInput(v.rows.map(({ tableName, key }) => ({ tableName, key }))) !==
      hashWriteInput(configurationBcPreflightKeys)
    )
      throw Error("CONFIGURATION_BC_STATE_KEYS_INVALID")
    return v
  }
  const cts = async () => {
    const v = await readers.cts(ctsInput)
    if (
      v.system !== "GR2" ||
      v.client !== client ||
      v.user !== username.toUpperCase() ||
      v.ctsVersion !== nativeCtsVersion ||
      v.bcSetId !== input.bcSetId ||
      v.version !== input.version ||
      v.requestNumber !== requestNumber ||
      v.taskNumber !== taskNumber ||
      !v.readOnly ||
      v.snapshot ||
      v.recoveryAvailable ||
      v.executable ||
      v.buffer.recoveryPermit ||
      v.buffer.clientSideImportAvailable
    )
      throw Error("CONFIGURATION_BC_STATE_CTS_BINDING_INVALID")
    return v
  }
  const before = await preflight(),
    ctsBefore = await cts()
  const expectedCounts = Object.fromEntries(
    configurationBcStateTables.map((name) => [
      name,
      before.rows.filter((row) => row.tableName === name && row.presence === "present").length
    ])
  )
  const invoke = async () => {
    const r = await backend.callRemoteFunction("w200", {
      functionName: api.functionName,
      outputParameters: api.exportParameters.map((p) => ({
        name: p.name,
        kind: "scalar" as const
      })),
      inputParameters: {
        IV_BC_SET: input.bcSetId,
        IV_VERSION: input.version,
        IV_REQUEST: requestNumber,
        IV_TASK: taskNumber,
        ...Object.fromEntries(
          [...versions, "cts"].map((name) => [
            `IV_${name.toUpperCase()}_VERSION`,
            input[`native${name[0]!.toUpperCase()}${name.slice(1)}Version` as keyof typeof input]
          ])
        )
      }
    })
    if (r.fault) throw Error("CONFIGURATION_BC_STATE_FAULT")
    if (r.outputs.EV_CODE !== "STATE_READ_OK") {
      const code = refused.safeParse(r.outputs.EV_CODE)
      throw Error(`CONFIGURATION_BC_STATE_${code.success ? code.data : "INVALID_RESPONSE"}`)
    }
    const v = response.parse(r.outputs)
    if (v.EV_USER !== username.toUpperCase()) throw Error("CONFIGURATION_BC_STATE_BINDING_INVALID")
    for (const name of [...versions, "cts"])
      if (
        v[`EV_${name.toUpperCase()}_VERSION` as keyof typeof v] !==
        input[`native${name[0]!.toUpperCase()}${name.slice(1)}Version` as keyof typeof input]
      )
        throw Error("CONFIGURATION_BC_STATE_VERSION_CONFLICT")
    const bytes = Buffer.from(v.EV_DATA_BASE64, "base64")
    if (
      !bytes.length ||
      bytes.length > 524288 ||
      bytes.length !== Number(v.EV_DATA_BYTES) ||
      bytes.toString("base64") !== v.EV_DATA_BASE64 ||
      createHash("sha256").update(bytes).digest("hex") !== v.EV_STATE_VERSION
    )
      throw Error("CONFIGURATION_BC_STATE_BUFFER_INVALID")
    const counts = configurationBcStateTables
      .map((name) => `${name}=${expectedCounts[name]};`)
      .join("")
    if (v.EV_ROW_COUNTS !== counts) throw Error("CONFIGURATION_BC_STATE_COUNTS_INVALID")
    return v
  }
  const first = await invoke(),
    second = await invoke()
  if (hashWriteInput(first) !== hashWriteInput(second))
    throw Error("CONFIGURATION_BC_STATE_READ_CHANGED")
  if (hashWriteInput(await cts()) !== hashWriteInput(ctsBefore))
    throw Error("CONFIGURATION_BC_STATE_CTS_CHANGED")
  if (hashWriteInput(await preflight()) !== hashWriteInput(before))
    throw Error("CONFIGURATION_BC_STATE_PREFLIGHT_CHANGED")
  if (
    hashWriteInput(attestConfigurationBcStateApi(await readers.definition())) !==
    hashWriteInput(identity)
  )
    throw Error("CONFIGURATION_BC_STATE_API_CHANGED")
  return {
    ...input,
    system: "GR2" as const,
    client: "200" as const,
    user: username.toUpperCase(),
    readOnly: true as const,
    executable: false as const,
    activationAvailable: false as const,
    recoveryAvailable: false as const,
    snapshot: false as const,
    scope: { object: "CUNI", tableCount: 9, keyCount: 19, allCuniKeys: false },
    versions: { ...before.versions, cts: nativeCtsVersion, state: first.EV_STATE_VERSION },
    counts: expectedCounts,
    layouts: { ...configurationBcStateLayouts },
    layoutFingerprint: configurationBcStateLayoutFingerprint,
    buffer: {
      format: "sap_export_data_buffer_base64" as const,
      data: first.EV_DATA_BASE64,
      bytes: Number(first.EV_DATA_BYTES),
      nativeRoundtrip: true as const,
      clientSideImportAvailable: false as const,
      recoveryPermit: false as const
    },
    cts: ctsBefore,
    bodyFingerprint: configurationBcStateBodyFingerprint,
    identity,
    evidence: { apiInvocations: 2, preflightPasses: 2, ctsPasses: 2, identityPasses: 2 },
    warning:
      "Fixed native nine-table before-state only. Missing rows remain absent typed-table entries. Native IMPORT/re-EXPORT is checked internally, but no restore command, atomic snapshot, lock, activation or configuration/CTS mutation is provided."
  }
}
