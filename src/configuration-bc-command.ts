import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import {
  ConfigurationBcBeforeStateStore,
  type ConfigurationBcStateBinding
} from "./configuration-bc-before-state-store.js"
import {
  ConfigurationBcExecutionStore,
  type ConfigurationBcExecutionIdentity
} from "./configuration-bc-execution-store.js"
import { configurationBcCommandRequestSchema } from "./configuration-bc-command-contract.js"
import { configurationBcRecordKernel } from "./configuration-bc-record-kernel.js"
import {
  configurationBcApplyApi,
  configurationBcRecoverApi,
  configurationBcReconcileApi,
  configurationBcOwnerInclude
} from "./configuration-bc-owner-api.js"
import {
  configurationBcOwnerFunctionPins,
  configurationBcOwnerLayoutPins,
  configurationBcOwnerIncludePins
} from "./configuration-bc-owner-pins.js"
import { configurationBcStateApi } from "./configuration-bc-state-api.js"
import { configurationBcRecoveryCheckApi } from "./configuration-bc-recovery-check-api.js"
import { configurationBcEffectsApi } from "./configuration-bc-effects-api.js"
import { configurationBcNativeReadApi } from "./configuration-bc-native-api.js"
import { configurationBcPreviewApi } from "./configuration-bc-preview-api.js"
import { configurationBcRouteApi } from "./configuration-bc-route-api.js"
import { configurationBcGuardApi } from "./configuration-bc-guard-api.js"
import { configurationBcCtsApi } from "./configuration-bc-cts-api.js"
import { configurationUnitApiBody } from "./configuration-unit-api.js"
import { hashWriteInput, type WriteOperationReceiptStore } from "./write-operation-receipts.js"

const hex = z.string().regex(/^[a-f0-9]{64}$/)
const base = configurationBcCommandRequestSchema.extend({ effectsReference: hex }).strict()
export const configurationBcApplySchema = base
  .extend({
    acknowledgeConfigurationWrite: z.literal(true),
    acknowledgeIndependentProtocol: z.literal(true),
    acknowledgeLocalActivationLinks: z.literal(true),
    acknowledgeCtsRecording: z.literal(true)
  })
  .strict()
export const configurationBcRecoverSchema = base
  .extend({
    applyOperationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{7,79}$/),
    applyReceiptHash: hex,
    acknowledgeConfigurationWrite: z.literal(true),
    acknowledgeIndependentProtocol: z.literal(true),
    acknowledgeLocalActivationLinks: z.literal(true),
    acknowledgeCtsKeyCleanup: z.literal(true)
  })
  .strict()
export const configurationBcReconcileSchema = base
  .extend({ command: z.enum(["apply", "recover"]), expectedReceiptHash: hex })
  .strict()
type Request = z.infer<typeof base>
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex")
const target = "CONFIG:BC:CUNI:200"
export const configurationBcNativeReplySchema = z
  .object({
    EV_CODE: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
    EV_SYSTEM: z.literal("GR2"),
    EV_CLIENT: z.literal("200"),
    EV_USER: z.string().regex(/^[A-Z0-9_]{1,12}$/),
    EV_OPERATION_HASH: hex,
    EV_BEFORE_REFERENCE: hex,
    EV_COMMIT: z.enum(["not_started", "rolled_back", "committed", "unknown"]),
    EV_PHASE: z.enum([
      "precheck",
      "rolled_back",
      "configuration_commit",
      "configuration_committed",
      "cts_cleanup",
      "complete",
      "observed"
    ]),
    EV_CONFIGURATION: z.enum(["unknown", "before", "candidate", "other"]),
    EV_PROTECTED: z.enum(["unknown", "preserved"]),
    EV_CTS: z.enum(["unknown", "before", "recorded", "changed"]),
    EV_EFFECTS: z.enum(["unknown", "before", "recorded", "changed"]),
    EV_LOCKS: z.enum(["unknown", "released", "held"]),
    EV_PROTOCOL: z.enum(["unknown", "started", "complete", "retained_unfinished"]),
    EV_ACT_ID: z.string().regex(/^(?:[A-Fa-f0-9]{32})?$/),
    EV_FRAME_BASE64: z.string().max(2097152),
    EV_FRAME_VERSION: z.string().regex(/^(?:[a-f0-9]{64})?$/),
    EV_MSGID: z.string().max(20),
    EV_MSGNO: z.string().max(3),
    EV_MSGV1: z.string().max(50),
    EV_MSGV2: z.string().max(50),
    EV_MSGV3: z.string().max(50),
    EV_MSGV4: z.string().max(50)
  })
  .strict()
type Reply = z.infer<typeof configurationBcNativeReplySchema>
export interface ConfigurationBcCommandEnvironment {
  binding: ConfigurationBcStateBinding
  before: ConfigurationBcBeforeStateStore
  executions: ConfigurationBcExecutionStore
  receipts: WriteOperationReceiptStore
  backend: Pick<SapBackend, "callRemoteFunction">
  readers: {
    definition(name: string): Promise<unknown>
    include(name: string): Promise<string[]>
    table(name: string): Promise<unknown>
  }
}
const normalize = (v: readonly string[]) =>
  v
    .map((l) => l.trimEnd())
    .join("\n")
    .trim()
const apis = [
  configurationBcApplyApi,
  configurationBcRecoverApi,
  configurationBcReconcileApi,
  configurationBcStateApi,
  configurationBcRecoveryCheckApi,
  configurationBcEffectsApi,
  configurationBcNativeReadApi,
  configurationBcPreviewApi,
  configurationBcRouteApi,
  configurationBcGuardApi,
  configurationBcCtsApi
]
export async function attestConfigurationBcOwner(
  readers: ConfigurationBcCommandEnvironment["readers"]
) {
  const identities: unknown[] = []
  const checks = [
    ...apis.map((api) => async () => {
      const d = z
        .object({
          connectionId: z.literal("w200"),
          functionName: z.literal(api.functionName),
          remoteEnabled: z.literal(true),
          updateTask: z.literal(false),
          updateTaskMode: z.literal(""),
          source: z.array(z.string()),
          sourceFingerprint: hex,
          interfaceFingerprint: hex,
          importParameters: z.array(z.unknown()),
          exportParameters: z.array(z.unknown()),
          tableParameters: z.array(z.unknown()),
          changingParameters: z.array(z.never()),
          exceptions: z.array(z.never())
        })
        .parse(await readers.definition(api.functionName))
      if (
        configurationUnitApiBody(d.source) !== configurationUnitApiBody(api.source) ||
        d.source.filter((l) => /^\s*FUNCTION\s+/i.test(l)).length !== 1 ||
        !d.source.some((l) => l.trim().toUpperCase() === `FUNCTION ${api.functionName}.`)
      )
        throw Error("CONFIGURATION_BC_OWNER_API_NOT_ATTESTED")
      for (const n of ["importParameters", "exportParameters", "tableParameters"] as const) {
        const signature = (rows: unknown[]) =>
          rows
            .map((v) =>
              z
                .object({
                  name: z.string(),
                  typeName: z.string(),
                  optional: z.boolean(),
                  passByValue: z.boolean()
                })
                .parse(v)
            )
            .sort((a, b) => a.name.localeCompare(b.name))
        const expected =
          n === "tableParameters" ? ("tableParameters" in api ? api.tableParameters : []) : api[n]
        if (hashWriteInput(signature(d[n])) !== hashWriteInput(signature([...expected])))
          throw Error("CONFIGURATION_BC_OWNER_INTERFACE_NOT_ATTESTED")
      }
      return {
        name: api.functionName,
        source: d.sourceFingerprint,
        interface: d.interfaceFingerprint
      }
    }),
    ...[configurationBcRecordKernel, configurationBcOwnerInclude].map((inc) => async () => {
      const source = await readers.include(inc.includeName)
      if (normalize(source) !== normalize(inc.source))
        throw Error("CONFIGURATION_BC_OWNER_INCLUDE_NOT_ATTESTED")
      return { name: inc.includeName, source: sha(normalize(source)) }
    }),
    ...Object.entries(configurationBcOwnerIncludePins).map(([name, pin]) => async () => {
      const source = sha(normalize(await readers.include(name)))
      if (source !== pin) throw Error("CONFIGURATION_BC_OWNER_STANDARD_INCLUDE_NOT_ATTESTED")
      return { name, source }
    }),
    ...Object.entries(configurationBcOwnerFunctionPins).map(([name, pin]) => async () => {
      z.object({
        connectionId: z.literal("w200"),
        functionName: z.literal(name),
        sourceFingerprint: z.literal(pin.source),
        interfaceFingerprint: z.literal(pin.interface),
        remoteEnabled: z.literal(pin.remoteEnabled),
        updateTask: z.literal(pin.updateTask)
      }).parse(await readers.definition(name))
      return { name, ...pin }
    }),
    ...Object.entries(configurationBcOwnerLayoutPins).map(([name, pin]) => async () => {
      z.object({
        connectionId: z.literal("w200"),
        objectName: z.literal(name),
        fingerprint: z.literal(pin)
      }).parse(await readers.table(name))
      return { name, fingerprint: pin }
    })
  ]
  for (let offset = 0; offset < checks.length; offset += 4) {
    const results = await Promise.allSettled(
      checks.slice(offset, offset + 4).map((check) => check())
    )
    for (const result of results) {
      if (result.status === "rejected") throw result.reason
      identities.push(result.value)
    }
  }
  return hashWriteInput(identities)
}
function validateReply(raw: unknown, input: Request, user: string): Reply {
  const r = configurationBcNativeReplySchema.parse(raw)
  if (
    r.EV_USER !== user ||
    r.EV_OPERATION_HASH !== sha(input.operationId) ||
    r.EV_BEFORE_REFERENCE !== input.beforeStateReference
  )
    throw Error("CONFIGURATION_BC_NATIVE_BINDING_INVALID")
  if (r.EV_FRAME_BASE64) {
    const bytes = Buffer.from(r.EV_FRAME_BASE64, "base64")
    if (
      bytes.length === 0 ||
      bytes.length > 1572864 ||
      bytes.toString("base64") !== r.EV_FRAME_BASE64 ||
      sha(bytes) !== r.EV_FRAME_VERSION
    )
      throw Error("CONFIGURATION_BC_NATIVE_FRAME_INVALID")
  }
  return r
}
const outcome = (r: Reply, command: "apply" | "recover") => {
  const wanted = command === "apply" ? "candidate" : "before"
  const effect = command === "apply" ? "recorded" : "before"
  if (
    r.EV_CODE === (command === "apply" ? "APPLIED" : "RECOVERED") &&
    r.EV_COMMIT === "committed" &&
    r.EV_PHASE === "complete" &&
    r.EV_CONFIGURATION === wanted &&
    r.EV_PROTECTED === "preserved" &&
    r.EV_CTS === effect &&
    r.EV_EFFECTS === effect &&
    r.EV_LOCKS === "released" &&
    r.EV_PROTOCOL === "complete" &&
    r.EV_ACT_ID &&
    r.EV_FRAME_VERSION &&
    (command !== "apply" || r.EV_FRAME_BASE64)
  )
    return command === "apply" ? ("applied" as const) : ("recovered" as const)
  // A refused guard has no maintenance/protocol invocation. Any other failure stays protected.
  if (
    [
      "SCOPE_UNSUPPORTED",
      "INPUT_INVALID",
      "AUTHORIZATION_DENIED",
      "PREEXISTING_LOCK_UNSUPPORTED",
      "BCSET_LOCK_FAILED",
      "TABLE_LOCK_FAILED",
      "CTS_LOCK_FAILED",
      "READ_PRECONDITION_FAILED",
      "BUFFER_INVALID",
      "PILOT_BEFORE_INVALID",
      "EFFECTS_BEFORE_INVALID",
      "CTS_PILOT_CONTAINER_MISSING",
      "CTS_EXISTING_KEY_OVERLAP",
      "DISTRIBUTION_POLICY_UNSUPPORTED",
      "ALE_POLICY_UNSUPPORTED",
      "AFTER_IMPORT_UNSUPPORTED",
      "BEFORE_CHANGED",
      "FRAME_REQUIRED",
      "FRAME_INVALID",
      "APPLY_HISTORY_UNPROVEN",
      "PROTECTION_CHANGED",
      "RECOVERY_CURRENT_CHANGED",
      "SOURCE_CHANGED",
      "CANDIDATE_CHANGED",
      "CANDIDATE_SCOPE_INVALID",
      "RECORD_PREPARATION_FAILED",
      "BATCH_SCOPE_INVALID",
      "CTS_CONTAINER_INVALID",
      "CTS_OBJECT_UNSUPPORTED",
      "CTS_KEY_UNSUPPORTED",
      "DUPLICATE_NATIVE_OPERATION",
      "GUID_FAILED"
    ].includes(r.EV_CODE) &&
    r.EV_COMMIT === "rolled_back" &&
    r.EV_PHASE === "rolled_back" &&
    r.EV_LOCKS === "released" &&
    r.EV_PROTOCOL === "unknown"
  )
    return "declined" as const
  return "unknown" as const
}
const publicEvidence = (r: Reply) => ({
  code: r.EV_CODE,
  commit: r.EV_COMMIT,
  phase: r.EV_PHASE,
  configuration: r.EV_CONFIGURATION,
  protection: r.EV_PROTECTED,
  cts: r.EV_CTS,
  effects: r.EV_EFFECTS,
  locks: r.EV_LOCKS,
  protocol: r.EV_PROTOCOL,
  activationId: r.EV_ACT_ID || null,
  frameVersion: r.EV_FRAME_VERSION || null,
  messageId: r.EV_MSGID || null,
  messageNumber: r.EV_MSGNO || null,
  nativeEvidenceHash: hashWriteInput(r)
})

async function prepare(input: Request, env: ConfigurationBcCommandEnvironment) {
  for (const n of ["connectionId", "bcSetId", "version", "requestNumber", "taskNumber"] as const)
    if (input[n] !== env.binding[n]) throw Error("CONFIGURATION_BC_COMMAND_BINDING_INVALID")
  const linked = await env.before.readEffects(input.effectsReference, env.binding)
  if (linked.beforeStateReference !== input.beforeStateReference)
    throw Error("CONFIGURATION_BC_COMMAND_EFFECTS_BINDING_INVALID")
  const { state, effects } = linked
  if (effects.profileCount !== 1 || Object.values(effects.counts).some((n) => n !== 0))
    throw Error("CONFIGURATION_BC_NONEMPTY_PROFILE_UNSUPPORTED")
  return {
    state,
    effects,
    native: {
      IV_OPERATION_HASH: sha(input.operationId),
      IV_BEFORE_REFERENCE: input.beforeStateReference,
      IV_STATE_BASE64: state.buffer.data,
      IV_STATE_VERSION: state.versions.state,
      ...Object.fromEntries(
        ["source", "target", "candidate", "metadata", "guard", "cts"].map((n) => [
          `IV_${n.toUpperCase()}_VERSION`,
          state.versions[n as keyof typeof state.versions]
        ])
      ),
      IV_CTS_BASE64: state.cts.buffer.data,
      IV_EFFECTS_BASE64: effects.buffer.data,
      IV_EFFECTS_VERSION: effects.effectsVersion,
      IV_FRAME_BASE64: "",
      IV_FRAME_VERSION: ""
    } as Record<string, string>
  }
}
export async function executeConfigurationBcCommand(
  command: "apply" | "recover",
  raw: unknown,
  env: ConfigurationBcCommandEnvironment
) {
  const input =
    command === "apply"
      ? configurationBcApplySchema.parse(raw)
      : configurationBcRecoverSchema.parse(raw)
  const toolName = `${command}_configuration_bc_set`,
    started = Date.now()
  const reserved = await env.receipts.reserve({
    connectionId: "w200",
    toolName,
    operationId: input.operationId,
    targetKey: target,
    inputHash: hashWriteInput(input),
    protectUnknownTarget: true,
    preChangeSummary: `Fixed CUNI ten-row ${command}; nine protected keys; before ${input.beforeStateReference}.`,
    recoveryGuide:
      "Do not replay. Reconcile the original receipt and native protocol/configuration/effects/CTS. Recovery requires the immutable applied frame; CTS cleanup and historical protocol are separate durable phases."
  })
  if (reserved.status !== "reserved")
    return {
      status: "protection_refused",
      sapInvocationStarted: false,
      replayAllowed: false,
      operationReceipt: reserved.receipt
    }
  let invoked = false
  try {
    const prepared = await prepare(input, env)
    if (command === "recover") {
      const recover = configurationBcRecoverSchema.parse(input),
        priorHash = sha(recover.applyOperationId)
      const receipt = await env.receipts.status("w200", recover.applyOperationId)
      const prior = await env.executions.readAuthenticated(priorHash, env.binding.user, "result")
      if (
        receipt.receiptHash !== recover.applyReceiptHash ||
        receipt.toolName !== "apply_configuration_bc_set" ||
        receipt.status !== "completed" ||
        receipt.outcomeMayBeUnknown ||
        receipt.operationIdHash !== priorHash ||
        receipt.targetKeyHash !== sha(target) ||
        receipt.inputHash !== prior.identity.inputHash ||
        receipt.resultHash !== sha(z.string().parse(prior.value.resultDigest)) ||
        prior.identity.command !== "apply" ||
        prior.identity.beforeStateReference !== input.beforeStateReference ||
        prior.identity.effectsReference !== input.effectsReference
      )
        throw Error("CONFIGURATION_BC_APPLY_RECEIPT_UNPROVEN")
      const outputs = configurationBcNativeReplySchema.parse(prior.value.native)
      if (outcome(outputs, "apply") !== "applied")
        throw Error("CONFIGURATION_BC_APPLY_RECEIPT_UNPROVEN")
      prepared.native.IV_FRAME_BASE64 = outputs.EV_FRAME_BASE64
      prepared.native.IV_FRAME_VERSION = outputs.EV_FRAME_VERSION
    }
    const identity: ConfigurationBcExecutionIdentity = {
      connectionId: "w200",
      system: "GR2",
      client: "200",
      user: env.binding.user,
      operationHash: sha(input.operationId),
      beforeStateReference: input.beforeStateReference,
      effectsReference: input.effectsReference,
      command,
      inputHash: hashWriteInput(input)
    }
    const attestation = await attestConfigurationBcOwner(env.readers)
    await env.executions.publish(identity, "intent", { input: prepared.native, attestation })
    await env.receipts.recordPreChangeEvidence(reserved.reservation, {
      observedAt: new Date().toISOString(),
      target,
      exists: true,
      active: null,
      version: prepared.state.versions.state,
      fingerprint: prepared.state.versions.state,
      packageName: null,
      requestNumber: input.requestNumber,
      taskNumber: input.taskNumber,
      observationStatus: "complete",
      sources: ["immutable_native_before", "immutable_native_effects"],
      warnings: ["Native command must recheck all state while holding SAP locks."]
    })
    if ((await attestConfigurationBcOwner(env.readers)) !== attestation)
      throw Error("CONFIGURATION_BC_OWNER_CHANGED")
    await env.receipts.markSapInvocationStarted(reserved.reservation)
    invoked = true
    const api = command === "apply" ? configurationBcApplyApi : configurationBcRecoverApi
    const response = await env.backend.callRemoteFunction("w200", {
      functionName: api.functionName,
      inputParameters: prepared.native,
      outputParameters: api.exportParameters.map((p) => ({ name: p.name, kind: "scalar" as const }))
    })
    if (response.fault) throw Error("CONFIGURATION_BC_NATIVE_FAULT")
    const native = validateReply(response.outputs, input, env.binding.user)
    if (
      command === "recover" &&
      native.EV_FRAME_VERSION &&
      native.EV_FRAME_VERSION !== prepared.native.IV_FRAME_VERSION
    )
      throw Error("CONFIGURATION_BC_RECOVERY_FRAME_CHANGED")
    const status = outcome(native, command)
    const result = {
      status,
      operationId: input.operationId,
      command,
      beforeStateReference: input.beforeStateReference,
      effectsReference: input.effectsReference,
      sapInvocationStarted: true,
      outcomeMayBeUnknown: status === "unknown",
      replayAllowed: false,
      recoveryAvailable: status === "applied",
      evidence: publicEvidence(native)
    }
    const resultDigest = hashWriteInput(result)
    await env.executions.publish(identity, "result", { native, resultDigest })
    if ((await attestConfigurationBcOwner(env.readers)) !== attestation)
      throw Error("CONFIGURATION_BC_OWNER_CHANGED")
    if (status === "unknown") {
      await env.receipts.fail(
        reserved.reservation,
        Error(`Native outcome ${hashWriteInput(native)}`),
        Date.now() - started,
        "CFG_BC_OUTCOME_UNKNOWN"
      )
    } else await env.receipts.complete(reserved.reservation, resultDigest, Date.now() - started)
    return { ...result, operationReceipt: await env.receipts.status("w200", input.operationId) }
  } catch (error) {
    const errorHash = sha(error instanceof Error ? String(error) : String(error))
    try {
      await env.receipts.fail(
        reserved.reservation,
        Error(errorHash),
        Date.now() - started,
        invoked ? "CFG_BC_OUTCOME_UNKNOWN" : "CFG_BC_PREINVOKE_REFUSED"
      )
    } catch {
      /* Preserve interruption; never dispatch/replay here. */
    }
    return {
      status: invoked ? "unknown" : "declined",
      command,
      operationId: input.operationId,
      sapInvocationStarted: invoked,
      outcomeMayBeUnknown: invoked,
      replayAllowed: false,
      recoveryAvailable: false,
      errorHash,
      operationReceipt: await env.receipts
        .status("w200", input.operationId)
        .catch(() => ({ status: "interrupted", outcomeMayBeUnknown: invoked }))
    }
  }
}

export async function reconcileConfigurationBcExecution(
  raw: unknown,
  env: ConfigurationBcCommandEnvironment
) {
  const input = configurationBcReconcileSchema.parse(raw)
  const receipt = await env.receipts.status("w200", input.operationId)
  if (
    receipt.status === "not_found" ||
    receipt.receiptHash !== input.expectedReceiptHash ||
    receipt.toolName !== `${input.command}_configuration_bc_set` ||
    receipt.targetKeyHash !== sha(target) ||
    receipt.operationIdHash !== sha(input.operationId)
  )
    throw Error("CONFIGURATION_BC_RECONCILE_RECEIPT_INVALID")
  const baseResult = {
    operationId: input.operationId,
    command: input.command,
    readOnly: true,
    replayAllowed: false,
    recoveryAvailable: false,
    receiptUnchanged: true
  }
  if (receipt.sapInvocationStarted === false)
    return { ...baseResult, status: "not_dispatched", operationReceipt: receipt }
  const intent = await env.executions.readAuthenticated(
    sha(input.operationId),
    env.binding.user,
    "intent"
  )
  if (
    intent.identity.beforeStateReference !== input.beforeStateReference ||
    intent.identity.effectsReference !== input.effectsReference ||
    intent.identity.command !== input.command ||
    intent.identity.inputHash !== receipt.inputHash
  )
    throw Error("CONFIGURATION_BC_RECONCILE_BINDING_INVALID")
  await prepare(input, env)
  const nativeInput = z.record(z.string()).parse(intent.value.input)
  try {
    const prior = await env.executions.read(intent.identity, "result")
    const native = validateReply(prior.native, input, env.binding.user)
    if (input.command === "apply") {
      nativeInput.IV_FRAME_BASE64 = native.EV_FRAME_BASE64
      nativeInput.IV_FRAME_VERSION = native.EV_FRAME_VERSION
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const first = await attestConfigurationBcOwner(env.readers)
  const response = await env.backend.callRemoteFunction("w200", {
    functionName: configurationBcReconcileApi.functionName,
    inputParameters: { ...nativeInput, IV_COMMAND: input.command === "apply" ? "A" : "R" },
    outputParameters: configurationBcReconcileApi.exportParameters.map((p) => ({
      name: p.name,
      kind: "scalar" as const
    }))
  })
  if (response.fault) throw Error("CONFIGURATION_BC_RECONCILE_READ_FAILED")
  const observed = validateReply(response.outputs, input, env.binding.user)
  if (
    (await attestConfigurationBcOwner(env.readers)) !== first ||
    hashWriteInput(await env.receipts.status("w200", input.operationId)) !== hashWriteInput(receipt)
  )
    throw Error("CONFIGURATION_BC_RECONCILE_CHANGED")
  // Observation never rewrites the historical failed/interrupted receipt or releases its target lock.
  const complete =
    observed.EV_CODE === "RECONCILED" &&
    observed.EV_PHASE === "observed" &&
    observed.EV_ACT_ID !== "" &&
    observed.EV_FRAME_VERSION !== "" &&
    observed.EV_COMMIT === "committed" &&
    observed.EV_PROTECTED === "preserved" &&
    observed.EV_LOCKS === "released" &&
    observed.EV_PROTOCOL === "complete" &&
    observed.EV_CONFIGURATION === (input.command === "apply" ? "candidate" : "before") &&
    observed.EV_CTS === (input.command === "apply" ? "recorded" : "before") &&
    observed.EV_EFFECTS === (input.command === "apply" ? "recorded" : "before")
  return {
    ...baseResult,
    status: complete ? "native_commit_observed" : "unknown",
    evidence: publicEvidence(observed),
    operationReceipt: receipt
  }
}
