import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import {
  ConfigurationBcBeforeStateStore,
  type ConfigurationBcStateBinding
} from "./configuration-bc-before-state-store.js"
import { configurationBcCommandRequestSchema } from "./configuration-bc-command-contract.js"
import { configurationBcPreflightKeys } from "./configuration-bc-preflight.js"
import { configurationBcStateTables } from "./configuration-bc-state-api.js"
import { configurationBcRecoveryCheckApi as api } from "./configuration-bc-recovery-check-api.js"
import { configurationUnitApiBody } from "./configuration-unit-api.js"
import { hashWriteInput } from "./write-operation-receipts.js"

// w200 live source/interface reads on 2026-10-05; these pins do not prove runtime conversion.
export const configurationBcRecoveryDependencies = {
  SCPR_DB_TABLE_TABFLDDEF_GET: {
    source: "032368671c7e8816fa3a97710a5795ababa9811c416d70425b1f0c4db7af5ba0",
    interface: "dca5f484468d333a60c097a44ead101729b065fd2891f608dbb8bcbafa6f14d4"
  },
  SCPR_CT_VALUE_CONVERT_INT_EXT: {
    source: "db76d20610890412f3caa9df80316689d3cad88170097087a068e2cb935be8c0",
    interface: "7a61d6cf41159fe5810f10b9ca73daca75ead478e6e578cdb11c8dfe505a5ddf"
  },
  SCPR_CPROF_CT_PROFDATA_CONVERT: {
    source: "58e7119821a8ec1fb3b94f756f2ea6f8705d391d671e92d8951b689981b29123",
    interface: "678844a691d83ea076f1c72c74d62daa7b68846bfe20300c57c7af597f00dfdc"
  },
  SCPR_CT_VALUE_CONV_EXT_INT_STR: {
    source: "c530a0980390a563a3f5a7d660ad0380b3c675502f5ddf6ee9a321069ab28d33",
    interface: "828900ac2f81c1c04c2f9c23eee356a4cc7c7dfd27bf1c41d8705faaaaf02480"
  },
  SCPR_CT_CURRKEY_GET: {
    source: "77331397170134c73ccce879147cc72de168108a65f2b36fcaddbb6a88fb8748",
    interface: "483f4a27cc888c674d3cdc58a893857e2d221c3aecc69e1e168aa8d3e720b222"
  },
  VIEW_CONVERSION_OUTPUT: {
    source: "cabbcb4e1a6f89ef529b47e85b069b9ef51d7c724d22b57935283d40b2d9bb63",
    interface: "06ce9aa72c7f3fa1dd3296af5f5a80dfe9243285b5b143451af94f6063becc6f"
  },
  RS_CONV_EX_2_IN_NO_DD: {
    source: "2a31f6057d9ed394bc208305e13e4c439e43cb71d648734f9fe5d5093340d009",
    interface: "5c937657853f9497ec3de103841aad8a7f125f4ff0e758a5f021879c0aeeb0c7"
  },
  SCMS_BASE64_DECODE_STR: {
    source: "0e7c53df677028244972a57dd7e64fb70399dd8da630165860f8dddb65795bbb",
    interface: "b3ddf62cc52f0db74d95634b3899f72acaebf361cf13bf52052abfe16c696dff"
  },
  SCMS_BASE64_ENCODE_STR: {
    source: "4d23ea3348507f29194d3429ba8f9205f159187d38a6ff3cc56295fc295ffbd0",
    interface: "d7e534d1aac8fe64eff242d5cff1366e3dbdca88769d7a3f0f405f88a5e919c9"
  },
  CALCULATE_HASH_FOR_RAW: {
    source: "874f8e777eda4b72aecd34ab11153af0fe291ca777b8023c96c13c1119bfd458",
    interface: "9d0e795153f6118bb966e18c6d4bdbca7e66f927c75bfe8e9fcf22d4fb153779"
  }
} as const
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
export const configurationBcRecoveryCheckBodyFingerprint = createHash("sha256")
  .update(body)
  .digest("hex")
export function attestConfigurationBcRecoveryCheckApi(raw: unknown) {
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
    throw Error("CONFIGURATION_BC_RECOVERY_CHECK_API_NOT_ATTESTED")
  return { source: v.sourceFingerprint, interface: v.interfaceFingerprint }
}
const response = z
  .object({
    EV_CODE: z.literal("RECOVERY_CHECK_OK"),
    EV_SYSTEM: z.literal("GR2"),
    EV_CLIENT: z.literal("200"),
    EV_USER: z.string().regex(/^[A-Z0-9_]{1,12}$/),
    EV_STATE_VERSION: hex,
    EV_LAYOUT_VERSION: hex,
    EV_ROW_COUNTS: z.string().max(160),
    EV_ROW_PROOFS: z.string().max(4000),
    EV_PROOF_BASE64: z.string().min(4).max(65536),
    EV_PROOF_VERSION: hex,
    EV_ROUNDTRIP: z.literal("X")
  })
  .strict()
const refusals = new Set(
  api.source
    .flatMap((line) => [...line.matchAll(/ev_code\s*=\s*'([A-Z0-9_]+)'/gi)].map((m) => m[1]!))
    .filter((code) => code !== "RECOVERY_CHECK_OK")
)

/** Internal only: caller supplies an immutable reference, never native buffers or a write permit. */
export async function checkConfigurationBcRecovery(
  raw: unknown,
  authenticatedBinding: ConfigurationBcStateBinding,
  store: ConfigurationBcBeforeStateStore,
  backend: Pick<SapBackend, "callRemoteFunction">,
  readers: {
    definition: () => Promise<unknown>
    standardDefinition: (name: string) => Promise<unknown>
    tableDefinition: (name: string) => Promise<unknown>
  }
) {
  const input = configurationBcCommandRequestSchema.parse(raw)
  for (const name of ["connectionId", "bcSetId", "version", "requestNumber", "taskNumber"] as const)
    if (input[name] !== authenticatedBinding[name])
      throw Error("CONFIGURATION_BC_RECOVERY_CHECK_BINDING_INVALID")
  const state = await store.read(input.beforeStateReference, authenticatedBinding)
  const attest = async () => {
    const [identity, dependencies, layouts] = await Promise.all([
      readers.definition().then(attestConfigurationBcRecoveryCheckApi),
      Promise.all(
        Object.entries(configurationBcRecoveryDependencies).map(async ([name, expected]) => {
          const v = z
            .object({
              connectionId: z.literal("w200"),
              functionName: z.literal(name),
              sourceFingerprint: hex,
              interfaceFingerprint: hex
            })
            .parse(await readers.standardDefinition(name))
          if (
            v.sourceFingerprint !== expected.source ||
            v.interfaceFingerprint !== expected.interface
          )
            throw Error("CONFIGURATION_BC_RECOVERY_CHECK_DEPENDENCY_NOT_ATTESTED")
          return { functionName: name, ...expected }
        })
      ),
      Promise.all(
        configurationBcStateTables.map(async (name) => {
          const v = z
            .object({
              connectionId: z.literal("w200"),
              objectName: z.literal(name),
              fingerprint: hex
            })
            .parse(await readers.tableDefinition(name))
          if (v.fingerprint !== state.layouts[name])
            throw Error("CONFIGURATION_BC_RECOVERY_CHECK_LAYOUT_NOT_ATTESTED")
          return { tableName: name, fingerprint: v.fingerprint }
        })
      )
    ])
    return { identity, dependencies, layouts }
  }
  const before = await attest()
  const result = await backend.callRemoteFunction("w200", {
    functionName: api.functionName,
    outputParameters: api.exportParameters.map((p) => ({ name: p.name, kind: "scalar" as const })),
    inputParameters: {
      IV_BC_SET: input.bcSetId,
      IV_VERSION: input.version,
      IV_REQUEST: input.requestNumber,
      IV_TASK: input.taskNumber,
      ...Object.fromEntries(
        Object.entries(state.versions).map(([name, v]) => [`IV_${name.toUpperCase()}_VERSION`, v])
      ),
      IV_DATA_BASE64: state.buffer.data
    }
  })
  if (result.fault) throw Error("CONFIGURATION_BC_RECOVERY_CHECK_FAULT")
  if (result.outputs.EV_CODE !== "RECOVERY_CHECK_OK")
    throw Error(
      `CONFIGURATION_BC_RECOVERY_CHECK_${typeof result.outputs.EV_CODE === "string" && refusals.has(result.outputs.EV_CODE) ? result.outputs.EV_CODE : "INVALID_RESPONSE"}`
    )
  const v = response.parse(result.outputs)
  if (
    v.EV_USER !== state.user ||
    v.EV_STATE_VERSION !== state.versions.state ||
    v.EV_LAYOUT_VERSION !== state.layoutFingerprint
  )
    throw Error("CONFIGURATION_BC_RECOVERY_CHECK_BINDING_INVALID")
  const counts = configurationBcStateTables.map((name) => `${name}=${state.counts[name]};`).join("")
  if (v.EV_ROW_COUNTS !== counts) throw Error("CONFIGURATION_BC_RECOVERY_CHECK_COUNTS_INVALID")
  const lines = v.EV_ROW_PROOFS.split("\n")
  if (lines.length !== 19) throw Error("CONFIGURATION_BC_RECOVERY_CHECK_ROWS_INVALID")
  const rows = lines.map((line, i) => {
    const parts = line.split("|"),
      key = configurationBcPreflightKeys[i]!
    if (
      parts.length !== 5 ||
      parts[0] !== String(i + 1) ||
      parts[1] !== key.tableName ||
      !["X", " "].includes(parts[2]!) ||
      !hex.safeParse(parts[3]).success ||
      parts[3] !== parts[4]
    )
      throw Error("CONFIGURATION_BC_RECOVERY_CHECK_ROWS_INVALID")
    return {
      index: i + 1,
      tableName: key.tableName,
      key: { ...key.key },
      presence: parts[2] === "X" ? ("present" as const) : ("missing" as const),
      rowVersion: parts[3]!
    }
  })
  for (const name of configurationBcStateTables)
    if (
      rows.filter((r) => r.tableName === name && r.presence === "present").length !==
      state.counts[name]
    )
      throw Error("CONFIGURATION_BC_RECOVERY_CHECK_COUNTS_INVALID")
  const bytes = Buffer.from(v.EV_PROOF_BASE64, "base64")
  if (
    !bytes.length ||
    bytes.toString("base64") !== v.EV_PROOF_BASE64 ||
    createHash("sha256").update(bytes).digest("hex") !== v.EV_PROOF_VERSION
  )
    throw Error("CONFIGURATION_BC_RECOVERY_CHECK_PROOF_INVALID")
  // Source checks bracket the call; this is still not a locked transaction or current-state read.
  if (hashWriteInput(await attest()) !== hashWriteInput(before))
    throw Error("CONFIGURATION_BC_RECOVERY_CHECK_API_CHANGED")
  return {
    ...input,
    system: state.system,
    client: state.client,
    user: state.user,
    readOnly: true as const,
    executable: false as const,
    recoveryAvailable: false as const,
    snapshot: false as const,
    nativeValueRoundtrip: true as const,
    currentStateRechecked: false as const,
    missingRowDeletionExecuted: false as const,
    ctsRecoveryChecked: false as const,
    identity: before.identity,
    dependencyIdentities: before.dependencies,
    layoutIdentities: before.layouts,
    bodyFingerprint: configurationBcRecoveryCheckBodyFingerprint,
    stateVersion: state.versions.state,
    layoutFingerprint: state.layoutFingerprint,
    counts: { ...state.counts },
    rows,
    proof: { version: v.EV_PROOF_VERSION, bytes: bytes.length },
    blockedBy: [
      "sap_locked_before_state_not_established",
      "configuration_and_cts_recovery_not_executed",
      "specific_configuration_and_cts_write_authorization"
    ]
  }
}
