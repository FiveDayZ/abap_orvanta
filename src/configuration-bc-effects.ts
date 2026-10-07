import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import type {
  ConfigurationBcBeforeStateStore,
  ConfigurationBcStateBinding
} from "./configuration-bc-before-state-store.js"
import { configurationBcCommandRequestSchema } from "./configuration-bc-command-contract.js"
import {
  configurationBcEffectsApi as api,
  configurationBcEffectsLayouts,
  configurationBcEffectsScope
} from "./configuration-bc-effects-api.js"
import { configurationBcStateLayouts } from "./configuration-bc-state-api.js"
import {
  configurationBcCtsApi,
  configurationBcCtsDependencies,
  configurationBcCtsLayouts
} from "./configuration-bc-cts-api.js"
import { attestConfigurationBcCtsApi } from "./configuration-bc-cts.js"
import { configurationBcRecoveryDependencies } from "./configuration-bc-recovery-check.js"
import { configurationUnitApiBody } from "./configuration-unit-api.js"
import { hashWriteInput } from "./write-operation-receipts.js"

// Live w200 reads on 2026-10-06. Include identity covers the standard descriptor-cache FORM.
export const configurationBcEffectsInclude = {
  objectName: "LSCPRHIF01",
  objectType: "FUGR/I",
  sourceUri: "/sap/bc/adt/functions/groups/scprhi/includes/lscprhif01/source/main",
  sourceFingerprint: "627cbd2dcb9eff8443aee3256bf4b3e79fcef5a94132c3c590ab1cfe84215111"
} as const
export const configurationBcEffectsDependencies = {
  ...configurationBcCtsDependencies,
  SCPR_HI_KEY_TO_ACTKEY: {
    source: "0ad008ba2a0e3bd17fb88ccda0a2cbb4629c03853743ef4a8fddd8f5945e74d5",
    interface: "3e3d4512e8f8f5a83864a0900caf38b5870961e19dcd902193fe646b71e51e1f"
  },
  SCPR_DB_TABLE_TABFLDDEF_GET: configurationBcRecoveryDependencies.SCPR_DB_TABLE_TABFLDDEF_GET,
  SCPR_CT_VALUE_CONVERT_INT_EXT: configurationBcRecoveryDependencies.SCPR_CT_VALUE_CONVERT_INT_EXT,
  SCPR_CT_CURRKEY_GET: configurationBcRecoveryDependencies.SCPR_CT_CURRKEY_GET,
  VIEW_CONVERSION_OUTPUT: configurationBcRecoveryDependencies.VIEW_CONVERSION_OUTPUT
}
export const configurationBcEffectsAllLayouts: Record<string, string> = {
  ...configurationBcStateLayouts,
  ...configurationBcEffectsLayouts,
  ...configurationBcCtsLayouts
}
const hex = z.string().regex(/^[a-f0-9]{64}$/)
const parameter = z
  .object({
    name: z.string(),
    typeName: z.string(),
    optional: z.boolean(),
    passByValue: z.boolean(),
    description: z.string().optional()
  })
  .strict()
  .transform(({ description: _description, ...signature }) => signature)
const body = configurationUnitApiBody(api.source)
export const configurationBcEffectsBodyFingerprint = createHash("sha256").update(body).digest("hex")
export function attestConfigurationBcEffectsApi(raw: unknown) {
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
    throw Error("CONFIGURATION_BC_EFFECTS_API_NOT_ATTESTED")
  return { source: v.sourceFingerprint, interface: v.interfaceFingerprint }
}
const count = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,2})$/)
  .transform(Number)
  .pipe(z.number().max(512))
const response = z
  .object({
    EV_CODE: z.literal("EFFECTS_READ_OK"),
    EV_SYSTEM: z.literal("GR2"),
    EV_CLIENT: z.literal("200"),
    EV_USER: z.string().regex(/^[A-Z0-9_]{1,12}$/),
    EV_REQUEST: z.literal("GR2K923429"),
    EV_TASK: z.literal("GR2K923430"),
    EV_CTS_VERSION: hex,
    EV_SCOPE_VERSION: z.literal(configurationBcEffectsScope),
    EV_EFFECTS_VERSION: hex,
    EV_ROW_COUNTS: z.string().max(100),
    EV_PROFILE_COUNT: z
      .string()
      .regex(/^[1-9][0-9]?$/)
      .transform(Number)
      .pipe(z.number().max(32)),
    EV_DATA_BASE64: z.string().min(4).max(699052),
    EV_DATA_BYTES: z.string().regex(/^[1-9][0-9]{0,5}$/),
    EV_ROUNDTRIP: z.literal("X")
  })
  .strict()
const refusalCodes = new Set(
  api.source
    .flatMap((line) => [...line.matchAll(/ev_code\s*=\s*'([A-Z0-9_]+)'/gi)].map((m) => m[1]!))
    .filter((code) => code !== "EFFECTS_READ_OK")
)

export type ConfigurationBcEffectsEvidence = Awaited<ReturnType<typeof readConfigurationBcEffects>>

/** Revalidate immutable evidence on publication and read; this never grants recovery. */
export function assertConfigurationBcEffectsEvidence(
  effects: ConfigurationBcEffectsEvidence,
  state: Awaited<ReturnType<ConfigurationBcBeforeStateStore["read"]>>,
  reference: string
) {
  const input = configurationBcCommandRequestSchema.parse(
    Object.fromEntries(
      [
        "connectionId",
        "bcSetId",
        "version",
        "requestNumber",
        "taskNumber",
        "operationId",
        "beforeStateReference"
      ].map((name) => [name, effects[name as keyof ConfigurationBcEffectsEvidence]])
    )
  )
  if (input.beforeStateReference !== reference)
    throw Error("CONFIGURATION_BC_EFFECTS_BINDING_INVALID")
  for (const name of [
    "connectionId",
    "bcSetId",
    "version",
    "requestNumber",
    "taskNumber",
    "system",
    "client",
    "user"
  ] as const)
    if (effects[name] !== state[name]) throw Error("CONFIGURATION_BC_EFFECTS_BINDING_INVALID")
  if (
    effects.readOnly !== true ||
    effects.snapshot !== false ||
    effects.executable !== false ||
    effects.activationAvailable !== false ||
    effects.recoveryAvailable !== false ||
    effects.currentStateRechecked !== false ||
    effects.ctsRecoveryChecked !== false ||
    effects.scopeVersion !== configurationBcEffectsScope ||
    effects.bodyFingerprint !== configurationBcEffectsBodyFingerprint ||
    effects.ctsVersion !== state.versions.cts ||
    effects.buffer.nativeRoundtrip !== true ||
    effects.buffer.clientSideImportAvailable !== false ||
    effects.buffer.recoveryPermit !== false
  )
    throw Error("CONFIGURATION_BC_EFFECTS_EVIDENCE_INVALID")
  const fields = ["matched", "records", "headers", "variables", "links"]
  if (
    Object.keys(effects.counts).sort().join(",") !== [...fields].sort().join(",") ||
    Object.values(effects.counts).some((v) => !Number.isInteger(v) || v < 0 || v > 512) ||
    effects.counts.matched > effects.counts.records ||
    !Number.isInteger(effects.profileCount) ||
    effects.profileCount < 1 ||
    effects.profileCount > 32 ||
    effects.profileCount > effects.counts.matched + 1
  )
    throw Error("CONFIGURATION_BC_EFFECTS_COUNTS_INVALID")
  const bytes = Buffer.from(effects.buffer.data, "base64")
  if (
    !bytes.length ||
    bytes.length > 524288 ||
    bytes.length !== effects.buffer.bytes ||
    bytes.toString("base64") !== effects.buffer.data ||
    createHash("sha256").update(bytes).digest("hex") !== effects.effectsVersion
  )
    throw Error("CONFIGURATION_BC_EFFECTS_BUFFER_INVALID")
  const identities = effects.identities
  const expectedNames = [
    api.functionName,
    configurationBcCtsApi.functionName,
    configurationBcEffectsInclude.objectName,
    ...Object.keys(configurationBcEffectsDependencies),
    ...Object.keys(configurationBcEffectsAllLayouts)
  ].sort()
  if (
    identities
      .map((v) =>
        "functionName" in v ? v.functionName : "objectName" in v ? v.objectName : v.tableName
      )
      .sort()
      .join(",") !== expectedNames.join(",")
  )
    throw Error("CONFIGURATION_BC_EFFECTS_IDENTITIES_INVALID")
  for (const identity of identities) {
    if ("tableName" in identity) {
      if (identity.fingerprint !== configurationBcEffectsAllLayouts[identity.tableName])
        throw Error("CONFIGURATION_BC_EFFECTS_IDENTITIES_INVALID")
    } else if ("objectName" in identity) {
      if (
        identity.objectType !== configurationBcEffectsInclude.objectType ||
        identity.source !== configurationBcEffectsInclude.sourceFingerprint
      )
        throw Error("CONFIGURATION_BC_EFFECTS_IDENTITIES_INVALID")
    } else {
      hex.parse(identity.source)
      hex.parse(identity.interface)
      const pin =
        configurationBcEffectsDependencies[
          identity.functionName as keyof typeof configurationBcEffectsDependencies
        ]
      if (pin && (identity.source !== pin.source || identity.interface !== pin.interface))
        throw Error("CONFIGURATION_BC_EFFECTS_IDENTITIES_INVALID")
    }
  }
}

/** Internal reader: native CTS binding comes only from the existing immutable state store. */
export async function readConfigurationBcEffects(
  raw: unknown,
  authenticatedBinding: ConfigurationBcStateBinding,
  store: ConfigurationBcBeforeStateStore,
  backend: Pick<SapBackend, "callRemoteFunction">,
  readers: {
    definition: (name: string) => Promise<unknown>
    include: () => Promise<unknown>
    table: (name: string) => Promise<unknown>
  }
) {
  const input = configurationBcCommandRequestSchema.parse(raw)
  for (const name of ["connectionId", "bcSetId", "version", "requestNumber", "taskNumber"] as const)
    if (input[name] !== authenticatedBinding[name])
      throw Error("CONFIGURATION_BC_EFFECTS_BINDING_INVALID")
  const state = await store.read(input.beforeStateReference, authenticatedBinding)
  const attest = async () => {
    const checks = [
      async () => ({
        functionName: api.functionName,
        ...attestConfigurationBcEffectsApi(await readers.definition(api.functionName))
      }),
      async () => ({
        functionName: configurationBcCtsApi.functionName,
        ...attestConfigurationBcCtsApi(await readers.definition(configurationBcCtsApi.functionName))
      }),
      async () => {
        const v = z
          .object({
            connectionId: z.literal("w200"),
            objectName: z.literal(configurationBcEffectsInclude.objectName),
            objectType: z.literal(configurationBcEffectsInclude.objectType),
            sourceFingerprint: z.literal(configurationBcEffectsInclude.sourceFingerprint)
          })
          .parse(await readers.include())
        return { objectName: v.objectName, objectType: v.objectType, source: v.sourceFingerprint }
      },
      ...Object.entries(configurationBcEffectsDependencies).map(([name, pin]) => async () => {
        const v = z
          .object({
            connectionId: z.literal("w200"),
            functionName: z.literal(name),
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
      ...Object.entries(configurationBcEffectsAllLayouts).map(([name, pin]) => async () => {
        const v = z
          .object({
            connectionId: z.literal("w200"),
            objectName: z.literal(name),
            objectKind: z.literal("transparentTable"),
            fingerprint: z.literal(pin)
          })
          .parse(await readers.table(name))
        return { tableName: name, fingerprint: v.fingerprint }
      })
    ]
    const identities = []
    for (let offset = 0; offset < checks.length; offset += 4) {
      const results = await Promise.allSettled(
        checks.slice(offset, offset + 4).map((check) => check())
      )
      for (const result of results) {
        if (result.status === "rejected") throw result.reason
        identities.push(result.value)
      }
    }
    return identities
  }
  const before = await attest()
  const result = await backend.callRemoteFunction("w200", {
    functionName: api.functionName,
    inputParameters: {
      IV_BC_SET: input.bcSetId,
      IV_VERSION: input.version,
      IV_REQUEST: input.requestNumber,
      IV_TASK: input.taskNumber,
      IV_CTS_VERSION: state.versions.cts
    },
    outputParameters: api.exportParameters.map((p) => ({ name: p.name, kind: "scalar" as const }))
  })
  if (result.fault) throw Error("CONFIGURATION_BC_EFFECTS_FAULT")
  if (result.outputs.EV_CODE !== "EFFECTS_READ_OK")
    throw Error(
      `CONFIGURATION_BC_EFFECTS_${typeof result.outputs.EV_CODE === "string" && refusalCodes.has(result.outputs.EV_CODE) ? result.outputs.EV_CODE : "INVALID_RESPONSE"}`
    )
  const v = response.parse(result.outputs)
  if (v.EV_USER !== state.user || v.EV_CTS_VERSION !== state.versions.cts)
    throw Error("CONFIGURATION_BC_EFFECTS_BINDING_INVALID")
  const fields = ["matched", "records", "headers", "variables", "links"] as const
  const pieces = v.EV_ROW_COUNTS.split(";")
  if (pieces.length !== 6 || pieces.pop() !== "")
    throw Error("CONFIGURATION_BC_EFFECTS_COUNTS_INVALID")
  const counts = Object.fromEntries(
    fields.map((name, i) => {
      const prefix = `${name}=`
      if (!pieces[i]?.startsWith(prefix)) throw Error("CONFIGURATION_BC_EFFECTS_COUNTS_INVALID")
      return [name, count.parse(pieces[i]!.slice(prefix.length))]
    })
  ) as Record<(typeof fields)[number], number>
  if (counts.matched > counts.records || v.EV_PROFILE_COUNT > counts.matched + 1)
    throw Error("CONFIGURATION_BC_EFFECTS_COUNTS_INVALID")
  const bytes = Buffer.from(v.EV_DATA_BASE64, "base64")
  if (
    !bytes.length ||
    bytes.length > 524288 ||
    bytes.length !== Number(v.EV_DATA_BYTES) ||
    bytes.toString("base64") !== v.EV_DATA_BASE64 ||
    createHash("sha256").update(bytes).digest("hex") !== v.EV_EFFECTS_VERSION
  )
    throw Error("CONFIGURATION_BC_EFFECTS_BUFFER_INVALID")
  // Sequential observations are not a locked snapshot; a changed attestation discards the result.
  if (hashWriteInput(await attest()) !== hashWriteInput(before))
    throw Error("CONFIGURATION_BC_EFFECTS_API_CHANGED")
  return {
    ...input,
    system: state.system,
    client: state.client,
    user: state.user,
    readOnly: true as const,
    snapshot: false as const,
    executable: false as const,
    activationAvailable: false as const,
    recoveryAvailable: false as const,
    currentStateRechecked: false as const,
    ctsRecoveryChecked: false as const,
    scopeVersion: configurationBcEffectsScope,
    ctsVersion: state.versions.cts,
    effectsVersion: v.EV_EFFECTS_VERSION,
    bodyFingerprint: configurationBcEffectsBodyFingerprint,
    counts,
    profileCount: v.EV_PROFILE_COUNT,
    identities: before,
    buffer: {
      data: v.EV_DATA_BASE64,
      bytes: bytes.length,
      nativeRoundtrip: true as const,
      clientSideImportAvailable: false as const,
      recoveryPermit: false as const
    },
    blockedBy: [
      "sap_locked_before_state_not_established",
      "standard_save_and_recovery_not_executed",
      "specific_configuration_and_cts_write_authorization"
    ]
  }
}
