import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import {
  attestConfigurationUnitApplyApi,
  configurationUnitApplyApi,
  configurationUnitApplyApiBodyFingerprint
} from "./configuration-unit-apply-api.js"
import { configurationUnitReadApiBodyFingerprint } from "./configuration-unit-api.js"
import { configurationUnitFields } from "./configuration-unit.js"
import {
  configurationUnitTextRowSchema,
  configurationUnitTextVersion
} from "./configuration-unit-reconcile.js"
import { WriteOperationReceiptStore, hashWriteInput } from "./write-operation-receipts.js"

// Internal acceptance driver, deliberately absent from the public MCP tool surface.
export const nativeUnitStaleInputSchema = z
  .object({
    connectionId: z.literal("w200"),
    unitKey: z.literal("KG"),
    language: z.literal("ZH"),
    requestNumber: z.literal("GR2K923429"),
    taskNumber: z.literal("GR2K923430"),
    operationId: z.string().regex(/^unit-native-stale-[A-Za-z0-9._:-]{1,40}$/)
  })
  .strict()
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const unitSchema = z.object({
  connectionId: z.literal("w200"),
  client: z.literal("200"),
  unitKey: z.literal("KG"),
  readOnly: z.literal(true),
  saveAvailable: z.literal(false),
  readFingerprint: hash,
  text: z.object({ requestedLanguage: z.literal("ZH"), sapLanguage: z.literal("1") }),
  evidence: z.object({ valuesRechecked: z.literal(true), snapshot: z.literal(false) }),
  apiSnapshot: z.object({
    status: z.literal("read"),
    code: z.literal("READ"),
    data: configurationUnitTextRowSchema,
    textVersion: hash,
    bodyFingerprint: z.literal(configurationUnitReadApiBodyFingerprint),
    versionScope: z.literal("SAP_GR2_200_full_T006A_row_v1"),
    versionOrigin: z.literal("sap_sha256_fixed_width_utf8")
  })
})
const checkNames = [
  "requestType",
  "taskType",
  "requestOpen",
  "taskOpen",
  "requestIsRoot",
  "taskParent",
  "taskOwnerMatchesConfiguredUser",
  "requestClient",
  "taskClient",
  "requestCategory",
  "taskCategory",
  "transportTarget"
] as const
const ctsRow = z.record(z.string().max(120))
const transportSchema = z.object({
  connectionId: z.literal("w200"),
  client: z.literal("200"),
  requestNumber: z.literal("GR2K923429"),
  taskNumber: z.literal("GR2K923430"),
  status: z.literal("metadata_matches"),
  readOnly: z.literal(true),
  saveAvailable: z.literal(false),
  checks: z.object(Object.fromEntries(checkNames.map((name) => [name, z.literal(true)]))).strict(),
  observed: z.object({
    request: z.array(ctsRow).length(1),
    requestClient: z.array(ctsRow).length(1),
    task: z.array(ctsRow).length(1),
    taskClient: z.array(ctsRow).length(1)
  }),
  keyRecording: z.object({
    status: z.enum(["table_entries_observed", "no_table_entries"]),
    target: z.object({
      client: z.literal("200"),
      unitKey: z.literal("KG"),
      language: z.literal("ZH"),
      sapLanguage: z.literal("1")
    }),
    representation: z.literal("sap_text_trimmed"),
    E071KReadback: z.literal("bounded_trimmed_projection"),
    observed: z.object({
      requestE071: z.array(ctsRow).max(32),
      requestE071K: z.array(ctsRow).max(32),
      taskE071: z.array(ctsRow).max(32),
      taskE071K: z.array(ctsRow).max(32)
    }),
    readerLimits: z.object({ maximumRowsPerProjection: z.literal(32) })
  }),
  evidence: z.object({ definitionsRechecked: z.literal(true), snapshot: z.literal(false) })
})
const lockSchema = z.object({
  connectionId: z.literal("w200"),
  client: z.literal("200"),
  status: z.literal("ok"),
  hasMore: z.literal(false),
  entries: z.array(z.object({ client: z.literal("200"), username: z.string() })).max(100)
})
export interface NativeUnitSafetyReaders {
  readDefinition(): Promise<unknown>
  readUnit(): Promise<unknown>
  inspectTransport(): Promise<unknown>
  readLocks?(argument: string): Promise<unknown>
}
const safeCode = (error: unknown) =>
  error instanceof Error && /^[A-Z][A-Z0-9_]{0,100}$/.test(error.message)
    ? error.message
    : "NATIVE_SAFETY_OBSERVATION_UNAVAILABLE"

function parseUnit(raw: unknown) {
  const value = unitSchema.safeParse(raw)
  if (!value.success) throw Error("NATIVE_SAFETY_FULL_ROW_UNVERIFIED")
  const row = value.data.apiSnapshot.data
  if (
    row.MANDT !== "200" ||
    row.SPRAS !== "1" ||
    row.MSEHI?.trimEnd() !== "KG" ||
    !row.MSEHL?.trim() ||
    configurationUnitTextVersion(row) !== value.data.apiSnapshot.textVersion
  )
    throw Error("NATIVE_SAFETY_FULL_ROW_UNVERIFIED")
  return value.data
}
function parseTransport(raw: unknown) {
  const parsed = transportSchema.safeParse(raw)
  if (!parsed.success) throw Error("NATIVE_SAFETY_CTS_UNVERIFIED")
  const value = parsed.data
  for (const [name, rows] of Object.entries(value.keyRecording.observed)) {
    const number = name.startsWith("task") ? value.taskNumber : value.requestNumber
    if (rows.some((row) => row.TRKORR !== number)) throw Error("NATIVE_SAFETY_CTS_UNVERIFIED")
  }
  if (
    value.observed.request[0]?.TRKORR !== value.requestNumber ||
    value.observed.task[0]?.TRKORR !== value.taskNumber ||
    value.observed.requestClient[0]?.TRKORR !== value.requestNumber ||
    value.observed.taskClient[0]?.TRKORR !== value.taskNumber ||
    value.observed.task[0]?.AS4USER !== "WYS"
  )
    throw Error("NATIVE_SAFETY_CTS_UNVERIFIED")
  return value
}

export async function prepareNativeUnitStale(raw: unknown, readers: NativeUnitSafetyReaders) {
  const input = nativeUnitStaleInputSchema.parse(raw)
  const firstDefinition = attestConfigurationUnitApplyApi(await readers.readDefinition())
  const first = parseUnit(await readers.readUnit())
  const transport = parseTransport(await readers.inspectTransport())
  const locks: { argument: string; status: string; code: string | null }[] = []
  for (const argument of ["*T006*", "*GR2K923429*", "*GR2K923430*"]) {
    if (!readers.readLocks) {
      locks.push({ argument, status: "not_requested", code: null })
      continue
    }
    try {
      const read = lockSchema.safeParse(await readers.readLocks(argument))
      if (!read.success || read.data.entries.some((row) => row.username.toUpperCase() !== "WYS"))
        throw Error("NATIVE_SAFETY_LOCKS_UNVERIFIED")
      locks.push({
        argument,
        status: read.data.entries.length ? "locks_observed" : "no_observed_locks",
        code: null
      })
    } catch (error) {
      locks.push({ argument, status: "unavailable", code: safeCode(error) })
    }
  }
  const second = parseUnit(await readers.readUnit())
  const finalDefinition = attestConfigurationUnitApplyApi(await readers.readDefinition())
  if (
    firstDefinition.sourceFingerprint !== finalDefinition.sourceFingerprint ||
    firstDefinition.interfaceFingerprint !== finalDefinition.interfaceFingerprint
  )
    throw Error("NATIVE_SAFETY_API_CHANGED")
  if (
    first.readFingerprint !== second.readFingerprint ||
    first.apiSnapshot.textVersion !== second.apiSnapshot.textVersion
  )
    throw Error("NATIVE_SAFETY_VALUES_CHANGED")
  const originalVersion = first.apiSnapshot.textVersion
  const invalidVersion = (originalVersion[0] === "0" ? "1" : "0") + originalVersion.slice(1)
  const core = {
    ...input,
    scenario: "native_locked_stale_version" as const,
    functionName: configurationUnitApplyApi.functionName,
    sourceFingerprint: firstDefinition.sourceFingerprint,
    interfaceFingerprint: firstDefinition.interfaceFingerprint,
    bodyFingerprint: configurationUnitApplyApiBodyFingerprint,
    beforeText: first.apiSnapshot.data,
    originalVersion,
    readFingerprint: first.readFingerprint,
    cts: { observed: transport.observed, keys: transport.keyRecording.observed },
    // No proposed value change even if the stale guard were defective.
    inputParameters: {
      IV_UNIT_KEY: "KG",
      IV_LANGUAGE: "1",
      IV_EXPECTED_VERSION: invalidVersion,
      IV_SET_MSEHT: "",
      IV_MSEHT: "",
      IV_SET_MSEHL: "X",
      IV_MSEHL: first.apiSnapshot.data.MSEHL!,
      IV_REQUEST: "GR2K923429",
      IV_TASK: "GR2K923430"
    },
    expectedCode: "TEXT_VERSION_CHANGED" as const,
    maximumNativeCalls: 1 as const
  }
  return {
    ...core,
    planFingerprint: digest(core),
    observedAt: new Date().toISOString(),
    nativeInvoked: false,
    executionAuthorized: false,
    locks,
    warnings: [
      "Preparation never authorizes a native command.",
      "CTS is a bounded trimmed projection, not raw key/import proof.",
      "Rechecked reads are not an atomic snapshot; later execution rechecks all preconditions."
    ]
  }
}
export type NativeUnitStalePlan = Awaited<ReturnType<typeof prepareNativeUnitStale>>
const grantSchema = z
  .object({
    scenario: z.literal("native_locked_stale_version"),
    planFingerprint: hash,
    acknowledgeOneNativeCall: z.literal(true)
  })
  .strict()

/** Future explicitly approved negative acceptance only; no public tool or automatic invocation. */
export async function runApprovedNativeUnitStale(
  plan: NativeUnitStalePlan,
  grant: unknown,
  readers: NativeUnitSafetyReaders,
  backend: Pick<SapBackend, "callRemoteFunction">,
  receipts: WriteOperationReceiptStore
) {
  const authorization = grantSchema.parse(grant)
  const {
    planFingerprint: _fingerprint,
    observedAt: _observedAt,
    nativeInvoked: _invoked,
    executionAuthorized: _authorized,
    locks: _locks,
    warnings: _warnings,
    ...approvedCore
  } = plan
  if (digest(approvedCore) !== plan.planFingerprint) throw Error("NATIVE_SAFETY_PLAN_CHANGED")
  if (
    authorization.planFingerprint !== plan.planFingerprint ||
    Date.now() - Date.parse(plan.observedAt) > 300_000 ||
    !Number.isFinite(Date.parse(plan.observedAt)) ||
    Date.parse(plan.observedAt) > Date.now()
  )
    throw Error("NATIVE_SAFETY_PLAN_UNAUTHORIZED_OR_EXPIRED")
  const current = await prepareNativeUnitStale(
    nativeUnitStaleInputSchema.parse({
      connectionId: plan.connectionId,
      unitKey: plan.unitKey,
      language: plan.language,
      requestNumber: plan.requestNumber,
      taskNumber: plan.taskNumber,
      operationId: plan.operationId
    }),
    readers
  )
  if (
    current.planFingerprint !== plan.planFingerprint ||
    digest(current.inputParameters) !== digest(plan.inputParameters)
  )
    throw Error("NATIVE_SAFETY_PLAN_CHANGED")
  if (current.locks.some((row) => row.status !== "no_observed_locks"))
    throw Error("NATIVE_SAFETY_LOCK_PRECONDITION_UNVERIFIED")
  const reserved = await receipts.reserve({
    connectionId: "w200",
    toolName: "probe_configuration_unit_native_stale",
    operationId: current.operationId,
    targetKey: "CONFIG:T006A:200:KG",
    inputHash: hashWriteInput(current.inputParameters),
    preChangeSummary:
      "One approved native stale rejection probe; KG/ZH MSEHL remains the current value",
    recoveryGuide:
      "Read full row, CTS and locks independently; never retry or restore automatically"
  })
  if (reserved.status !== "reserved") throw Error("NATIVE_SAFETY_RECEIPT_REFUSED")
  const reservation = reserved.reservation
  const startedAt = Date.now()
  let firstError: unknown
  const result: {
    status: string
    nativeCalls: number
    nativeCode: string | null
    firstCause: string | null
    automaticRetry: false
    automaticRestore: false
    valueUnchanged: boolean
    ctsProjectionUnchanged: boolean
    locksRechecked: boolean
    receipt?: unknown
    rawReply?: unknown
  } = {
    status: "unknown",
    nativeCalls: 0,
    nativeCode: null,
    firstCause: null,
    automaticRetry: false,
    automaticRestore: false,
    valueUnchanged: false,
    ctsProjectionUnchanged: false,
    locksRechecked: false
  }
  try {
    await receipts.recordPreChangeEvidence(reservation, {
      observedAt: current.observedAt,
      target: "CONFIG:T006A:200:KG:ZH",
      exists: true,
      active: true,
      version: current.originalVersion,
      fingerprint: current.readFingerprint,
      packageName: null,
      requestNumber: current.requestNumber,
      taskNumber: current.taskNumber,
      observationStatus: "complete",
      sources: ["native_full_T006A", "bounded_CTS_projection", "approved_user_client_locks"],
      warnings: current.warnings
    })
    await receipts.markSapInvocationStarted(reservation)
    result.nativeCalls = 1
    const reply = await backend.callRemoteFunction("w200", {
      functionName: configurationUnitApplyApi.functionName,
      inputParameters: { ...current.inputParameters },
      outputParameters: configurationUnitApplyApi.exportParameters.map((parameter) => ({
        name: parameter.name,
        kind: parameter.name === "ES_TEXT" ? "structure" : "scalar",
        ...(parameter.name === "ES_TEXT" ? { fields: [...configurationUnitFields.T006A] } : {})
      }))
    })
    result.rawReply = reply
    if (
      typeof reply.outputs.EV_CODE === "string" &&
      /^[A-Z][A-Z0-9_]{0,99}$/.test(reply.outputs.EV_CODE)
    )
      result.nativeCode = reply.outputs.EV_CODE
    const output = z
      .object({
        EV_CODE: z.string().max(100),
        EV_SYSTEM: z.literal("GR2"),
        EV_CLIENT: z.literal("200"),
        EV_USER: z.literal("WYS"),
        EV_COMMITTED: z.literal(""),
        EV_BEFORE_VERSION: z.literal(""),
        EV_TEXT_VERSION: z.literal(""),
        EV_TASK: z.literal(""),
        EV_TABKEY: z.literal(""),
        EV_MSGID: z.string().max(20),
        EV_MSGNO: z.string().max(3),
        ES_TEXT: configurationUnitTextRowSchema
      })
      .strict()
      .safeParse(reply.outputs)
    if (
      reply.fault ||
      !output.success ||
      output.data.EV_CODE !== "TEXT_VERSION_CHANGED" ||
      Object.values(output.data.ES_TEXT).some((value) => value.trim() !== "")
    )
      throw Error("NATIVE_SAFETY_UNEXPECTED_NATIVE_OUTCOME")
    result.status = "native_rejection_observed"
  } catch (error) {
    firstError = error
    result.firstCause = safeCode(error)
  }
  // Always observe after possible dispatch; a clean current row cannot erase the first unknown outcome.
  if (result.nativeCalls) {
    try {
      const after = await prepareNativeUnitStale(
        nativeUnitStaleInputSchema.parse({
          connectionId: current.connectionId,
          unitKey: current.unitKey,
          language: current.language,
          requestNumber: current.requestNumber,
          taskNumber: current.taskNumber,
          operationId: current.operationId
        }),
        readers
      )
      result.valueUnchanged = after.originalVersion === current.originalVersion
      result.ctsProjectionUnchanged = digest(after.cts) === digest(current.cts)
      result.locksRechecked = after.locks.every((row) => row.status === "no_observed_locks")
      if (
        after.sourceFingerprint !== current.sourceFingerprint ||
        after.interfaceFingerprint !== current.interfaceFingerprint ||
        !result.valueUnchanged ||
        !result.ctsProjectionUnchanged ||
        !result.locksRechecked
      )
        throw Error("NATIVE_SAFETY_POST_OBSERVATION_CHANGED")
    } catch (error) {
      firstError ??= error
      result.firstCause ??= safeCode(error)
      result.status = "unknown"
    }
  }
  if (result.firstCause) {
    result.status = "unknown"
    await receipts.fail(reservation, firstError ?? Error(result.firstCause), Date.now() - startedAt)
  } else {
    result.status = "native_stale_rejection_verified"
    await receipts.complete(reservation, JSON.stringify(result), Date.now() - startedAt)
  }
  result.receipt = await receipts.status("w200", current.operationId)
  return result
}
