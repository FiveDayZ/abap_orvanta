import { z } from "zod"
import type { SapBackend } from "./backend.js"
import {
  configurationUnitFields,
  configurationUnitTextPreviewInputSchema
} from "./configuration-unit.js"
import {
  attestConfigurationUnitApplyApi,
  configurationUnitApplyApi,
  configurationUnitApplyApiBodyFingerprint
} from "./configuration-unit-apply-api.js"

const text = (length: number) =>
  z
    .string()
    .max(length)
    .refine((value) => !/\p{Cc}/u.test(value))
    .pipe(z.string().trim().min(1))
// Advertise an object schema; enforce cross-field restrictions before any SAP read.
export const configurationUnitTextApplyInputSchema = z
  .object({
    connectionId: z.literal("w200"),
    unitKey: z
      .string()
      .min(1)
      .max(3)
      .refine((v) => v === v.trim() && !/[|*\p{Cc}]/u.test(v)),
    language: configurationUnitTextPreviewInputSchema.shape.language.unwrap(),
    expectedReadFingerprint: configurationUnitTextPreviewInputSchema.shape.expectedReadFingerprint,
    expectedTextVersion: z.string().regex(/^[a-f0-9]{64}$/),
    patch: z.object({ MSEHT: text(10).optional(), MSEHL: text(30).optional() }).strict(),
    requestNumber: z.string().regex(/^GR2K[0-9]{6}$/),
    taskNumber: z.string().regex(/^GR2K[0-9]{6}$/),
    operationId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
    acknowledgeConfigurationWrite: z.literal(true)
  })
  .strict()
export const configurationUnitTextApplySchema = configurationUnitTextApplyInputSchema
  .refine(
    (value) => Object.values(value.patch).some((entry) => entry !== undefined),
    "Patch is empty"
  )
  .refine((value) => value.requestNumber !== value.taskNumber, "Request and task must differ")

const rowSchema = z
  .object(
    Object.fromEntries(
      configurationUnitFields.T006A.map((name, index) => [
        name,
        z
          .string()
          .max([3, 1, 3, 3, 6, 10, 30][index]!)
          .refine((v) => !/\p{Cc}/u.test(v))
      ])
    )
  )
  .strict()
const replySchema = z
  .object({
    EV_CODE: z.string(),
    EV_SYSTEM: z.literal("GR2"),
    EV_CLIENT: z.literal("200"),
    EV_USER: z
      .string()
      .min(1)
      .max(12)
      .refine((v) => !/\p{Cc}/u.test(v)),
    EV_COMMITTED: z.enum(["", "X"]),
    EV_BEFORE_VERSION: z.string(),
    EV_TEXT_VERSION: z.string(),
    EV_TASK: z.string(),
    EV_TABKEY: z.string(),
    EV_MSGID: z.string().max(20),
    EV_MSGNO: z.string().max(3),
    ES_TEXT: rowSchema
  })
  .strict()
const declinedCodes = new Set([
  "SCOPE_UNSUPPORTED",
  "INPUT_INVALID",
  "AUTHORIZATION_DENIED",
  "UNIT_LOCK_FAILED",
  "CTS_LOCK_FAILED",
  "CLIENT_POLICY_UNSUPPORTED",
  "ALE_POLICY_UNSUPPORTED",
  "ALE_POLICY_UNAVAILABLE",
  "CTS_CONTAINER_INVALID",
  "READ_PRECONDITION_FAILED",
  "TEXT_VERSION_CHANGED",
  "CTS_OBJECT_CHECK_FAILED",
  "CTS_LOCKABLE_OBJECT_UNSUPPORTED",
  "CTS_KEY_CHECK_FAILED",
  "CTS_APPEND_FAILED",
  "CTS_RECORDING_NOT_OBSERVED",
  "TEXT_UPDATE_FAILED",
  "TEXT_READBACK_FAILED",
  "EXECUTION_FAILED"
])
const equalRows = (left: Record<string, string>, right: Record<string, string>) =>
  configurationUnitFields.T006A.every((field) => left[field]?.trimEnd() === right[field]?.trimEnd())

/** One attested customer command, no generic write fallback and no automatic retry. */
export async function applyConfigurationUnitText(
  raw: unknown,
  client: string,
  backend: Pick<SapBackend, "callRemoteFunction">,
  readDefinition: () => Promise<unknown>,
  preview: (input: unknown) => Promise<unknown>,
  readUnit: (input: unknown) => Promise<unknown>,
  beforeInvoke: () => Promise<void>
) {
  const input = configurationUnitTextApplySchema.parse(raw)
  if (client !== "200") throw Error("CONFIGURATION_UNIT_APPLY_SCOPE_UNSUPPORTED")
  const first = attestConfigurationUnitApplyApi(await readDefinition())
  const draft = z
    .object({
      status: z.enum(["draft", "no_changes"]),
      unitKey: z.literal(input.unitKey),
      sapLanguage: z.string().regex(/^[A-Za-z0-9]$/),
      before: rowSchema,
      after: rowSchema,
      apiPrecondition: z.object({
        status: z.literal("match"),
        textVersion: z.literal(input.expectedTextVersion),
        lockedComparisonVerified: z.literal(false)
      })
    })
    .safeParse(
      await preview({
        connectionId: input.connectionId,
        unitKey: input.unitKey,
        language: input.language,
        expectedReadFingerprint: input.expectedReadFingerprint,
        expectedTextVersion: input.expectedTextVersion,
        patch: input.patch
      })
    )
  if (!draft.success) throw Error("CONFIGURATION_UNIT_APPLY_PRECONDITION_FAILED")
  const value = draft.data
  if (
    value.before.MANDT !== client ||
    value.before.SPRAS !== value.sapLanguage ||
    value.before.MSEHI?.trimEnd() !== input.unitKey
  ) {
    throw Error("CONFIGURATION_UNIT_APPLY_PRECONDITION_FAILED")
  }
  // Derive desired values independently; a misleading preview must not broaden the command.
  const desired: Record<string, string> = { ...value.before }
  for (const [field, entry] of Object.entries(input.patch)) {
    if (entry !== undefined) desired[field] = entry
  }
  if (!equalRows(value.after, desired)) throw Error("CONFIGURATION_UNIT_APPLY_PRECONDITION_FAILED")
  const second = attestConfigurationUnitApplyApi(await readDefinition())
  if (
    first.sourceFingerprint !== second.sourceFingerprint ||
    first.interfaceFingerprint !== second.interfaceFingerprint
  ) {
    throw Error("CONFIGURATION_UNIT_APPLY_API_CHANGED")
  }
  // Receipt persistence is the final gate, immediately before the sole command dispatch.
  await beforeInvoke()
  let result
  try {
    result = await backend.callRemoteFunction(input.connectionId, {
      functionName: configurationUnitApplyApi.functionName,
      inputParameters: {
        IV_UNIT_KEY: input.unitKey,
        IV_LANGUAGE: value.sapLanguage,
        IV_EXPECTED_VERSION: input.expectedTextVersion,
        IV_SET_MSEHT: input.patch.MSEHT === undefined ? "" : "X",
        IV_MSEHT: input.patch.MSEHT ?? "",
        IV_SET_MSEHL: input.patch.MSEHL === undefined ? "" : "X",
        IV_MSEHL: input.patch.MSEHL ?? "",
        IV_REQUEST: input.requestNumber,
        IV_TASK: input.taskNumber
      },
      outputParameters: configurationUnitApplyApi.exportParameters.map((p) => ({
        name: p.name,
        kind: p.name === "ES_TEXT" ? "structure" : "scalar",
        ...(p.name === "ES_TEXT" ? { fields: [...configurationUnitFields.T006A] } : {})
      }))
    })
  } catch {
    throw Error(
      "CONFIGURATION_UNIT_APPLY_OUTCOME_UNKNOWN; read back unit and CTS task; do not retry"
    )
  }
  const reply = replySchema.safeParse(result.outputs)
  if (result.fault || !reply.success) throw Error("CONFIGURATION_UNIT_APPLY_OUTCOME_UNKNOWN")
  const output = reply.data
  const common = {
    connectionId: input.connectionId,
    unitKey: input.unitKey,
    language: input.language,
    sapLanguage: value.sapLanguage,
    functionName: configurationUnitApplyApi.functionName,
    bodyFingerprint: configurationUnitApplyApiBodyFingerprint,
    sapUser: output.EV_USER,
    automaticRetry: false,
    requestNumber: input.requestNumber,
    taskNumber: input.taskNumber
  }
  if (declinedCodes.has(output.EV_CODE)) {
    if (
      output.EV_COMMITTED !== "" ||
      output.EV_BEFORE_VERSION !== "" ||
      output.EV_TEXT_VERSION !== "" ||
      output.EV_TASK !== "" ||
      output.EV_TABKEY !== ""
    ) {
      throw Error("CONFIGURATION_UNIT_APPLY_OUTCOME_UNKNOWN")
    }
    const final = attestConfigurationUnitApplyApi(await readDefinition())
    if (
      final.sourceFingerprint !== first.sourceFingerprint ||
      final.interfaceFingerprint !== first.interfaceFingerprint
    )
      throw Error("CONFIGURATION_UNIT_APPLY_OUTCOME_UNKNOWN")
    return {
      ...common,
      status: "blocked",
      code: output.EV_CODE,
      committed: false,
      sapInvoked: true,
      messageId: output.EV_MSGID,
      messageNumber: output.EV_MSGNO
    }
  }
  const noChanges = output.EV_CODE === "NO_CHANGES"
  if (
    (!noChanges && output.EV_CODE !== "APPLIED") ||
    output.EV_BEFORE_VERSION !== input.expectedTextVersion ||
    !/^[a-f0-9]{64}$/.test(output.EV_TEXT_VERSION) ||
    !equalRows(output.ES_TEXT, desired) ||
    (noChanges
      ? output.EV_COMMITTED !== "" ||
        !equalRows(value.before, desired) ||
        output.EV_TEXT_VERSION !== input.expectedTextVersion ||
        output.EV_TASK !== "" ||
        output.EV_TABKEY !== ""
      : output.EV_COMMITTED !== "X" ||
        output.EV_TEXT_VERSION === input.expectedTextVersion ||
        output.EV_TASK !== input.taskNumber ||
        output.EV_TABKEY !== `${client}${value.sapLanguage}${input.unitKey.padEnd(3, " ")}`)
  ) {
    throw Error("CONFIGURATION_UNIT_APPLY_OUTCOME_UNKNOWN")
  }
  // An invalid/unavailable read after dispatch remains uncertain; never report a false clean failure.
  const readback = z
    .object({
      apiSnapshot: z.object({
        status: z.literal("read"),
        textVersion: z.literal(output.EV_TEXT_VERSION),
        data: rowSchema
      })
    })
    .safeParse(
      await readUnit({
        connectionId: input.connectionId,
        unitKey: input.unitKey,
        language: input.language,
        includeApiSnapshot: true
      })
    )
  if (!readback.success || !equalRows(readback.data.apiSnapshot.data, desired)) {
    throw Error("CONFIGURATION_UNIT_APPLY_POST_COMMIT_READBACK_UNCERTAIN")
  }
  const final = attestConfigurationUnitApplyApi(await readDefinition())
  if (
    final.sourceFingerprint !== first.sourceFingerprint ||
    final.interfaceFingerprint !== first.interfaceFingerprint
  )
    throw Error("CONFIGURATION_UNIT_APPLY_OUTCOME_UNKNOWN")
  return {
    ...common,
    status: noChanges ? "no_changes" : "applied",
    code: output.EV_CODE,
    committed: !noChanges,
    sapInvoked: true,
    textVersion: output.EV_TEXT_VERSION,
    data: output.ES_TEXT,
    exactKeyRecording: noChanges ? "not_performed" : "sap_receipt_observed",
    tabkey: output.EV_TABKEY || null,
    readbackVerified: true
  }
}
