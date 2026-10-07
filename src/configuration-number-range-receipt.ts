import type { z } from "zod"
import {
  configurationNumberRangeCommandSchema,
  configurationNumberRangeFailure,
  configurationNumberRangeSnapshotSchema,
  type applyConfigurationNumberRange
} from "./configuration-number-range-command.js"
import { hashWriteInput, type WriteOperationReceiptStore } from "./write-operation-receipts.js"

type Result = Awaited<ReturnType<typeof applyConfigurationNumberRange>>
type Input = z.infer<typeof configurationNumberRangeCommandSchema>

/** Receipt protection for the number range command; SAP deployment is independently attested. */
export async function protectConfigurationNumberRangeCommand(
  raw: unknown,
  receipts: WriteOperationReceiptStore,
  action: (
    input: Input,
    beforeInvoke: (operationId: string, snapshot: unknown) => Promise<void>
  ) => Promise<Result>
) {
  const input = configurationNumberRangeCommandSchema.parse(raw)
  const started = Date.now()
  const reserved = await receipts.reserve({
    connectionId: input.connectionId,
    toolName: "apply_configuration_number_range",
    operationId: input.operationId,
    // An interval command checks and versions the entire object's client state.
    targetKey: `CONFIG:NRIV:200:${input.objectName}`,
    protectUnknownTarget: true,
    inputHash: hashWriteInput(input),
    preChangeSummary: `Complete ${input.objectName}/200 version ${input.expectedVersion}; ${input.action} interval ${input.intervalNumber}.`,
    recoveryGuide:
      "Read the complete number range definition and all client 200 intervals, native commit and cleanup result. Never retry or roll back automatically. Intervals remain local; no CTS import or release."
  })
  if (reserved.status !== "reserved")
    return {
      status: "protection_refused" as const,
      protectionStatus: reserved.status,
      operationId: input.operationId,
      sapInvocationStarted: false,
      retryAvailable: false,
      operationReceipt: reserved.receipt
    }

  let sapInvocationStarted = false
  let result: Result | undefined
  const persistedReceipt = async (
    finished: Record<string, unknown>
  ): Promise<Record<string, unknown>> => {
    // The store decoder normalizes key order; expose its durable hash for later reconciliation.
    const persisted = await receipts.status(input.connectionId, input.operationId)
    if (
      typeof persisted.receiptHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(persisted.receiptHash) ||
      persisted.connectionId !== input.connectionId ||
      persisted.toolName !== "apply_configuration_number_range" ||
      persisted.operationIdHash !== reserved.reservation.receipt.operationIdHash ||
      persisted.targetKeyHash !== reserved.reservation.receipt.targetKeyHash ||
      persisted.inputHash !== reserved.reservation.receipt.inputHash ||
      persisted.status !== finished.status
    )
      throw Error("CONFIGURATION_NR_RECEIPT_UNAVAILABLE")
    return { ...finished, receiptHash: persisted.receiptHash }
  }
  try {
    result = await action(input, async (operationId, snapshot) => {
      if (operationId !== input.operationId || sapInvocationStarted)
        throw Error("CONFIGURATION_NR_RECEIPT_INVOCATION_MISMATCH")
      const before = configurationNumberRangeSnapshotSchema.parse(snapshot)
      if (
        before.EV_VERSION !== input.expectedVersion ||
        before.ES_DEFINITION.OBJECT !== input.objectName
      )
        throw Error("CONFIGURATION_NR_RECEIPT_PRECHANGE_MISMATCH")
      await receipts.recordPreChangeEvidence(reserved.reservation, {
        observedAt: new Date().toISOString(),
        target: `NRIV:${input.objectName}:200`,
        exists: true,
        active: null,
        version: before.EV_VERSION,
        fingerprint: before.EV_VERSION,
        packageName: null,
        requestNumber: null,
        taskNumber: null,
        observationStatus: "complete",
        sources: ["Z_ORVANTA_CFG_NR_READ", "TNRO", "NRIV"],
        warnings: ["NRIV intervals are local client only; no CTS recording."]
      })
      await receipts.markSapInvocationStarted(reserved.reservation)
      sapInvocationStarted = true
    })
    if (
      !sapInvocationStarted ||
      result.operationId !== input.operationId ||
      result.objectName !== input.objectName ||
      result.client !== "200"
    )
      throw Error("CONFIGURATION_NR_RECEIPT_RESULT_MISMATCH")
    const serialized = JSON.stringify(result)
    if (result.status === "unknown" || result.outcomeMayBeUnknown) {
      const operationReceipt = await receipts.fail(
        reserved.reservation,
        Error(
          `${result.failure?.code ?? "CONFIGURATION_NR_OUTCOME_UNKNOWN"}:${result.failure?.evidenceHash ?? hashWriteInput(result)}`
        ),
        Date.now() - started,
        result.failure?.code
      )
      return { ...result, operationReceipt: await persistedReceipt(operationReceipt) }
    }
    const operationReceipt = await receipts.complete(
      reserved.reservation,
      serialized,
      Date.now() - started
    )
    return { ...result, operationReceipt: await persistedReceipt(operationReceipt) }
  } catch (error) {
    const failure =
      result?.failure ??
      configurationNumberRangeFailure(
        "receipt",
        sapInvocationStarted
          ? "CONFIGURATION_NR_FINALIZATION_UNKNOWN"
          : "CONFIGURATION_NR_PRE_INVOKE_REFUSED",
        error
      )
    let operationReceipt: Record<string, unknown>
    try {
      operationReceipt = await persistedReceipt(
        await receipts.fail(
          reserved.reservation,
          result?.failure ? Error(`${failure.code}:${failure.evidenceHash}`) : error,
          Date.now() - started,
          failure.code
        )
      )
    } catch {
      operationReceipt = {
        status: "interrupted",
        sapInvocationStarted,
        outcomeMayBeUnknown: sapInvocationStarted,
        automaticRetry: false,
        automaticRollback: false
      }
    }
    return {
      ...result,
      status: sapInvocationStarted ? ("unknown" as const) : ("declined" as const),
      operationId: input.operationId,
      code:
        error instanceof Error && /^CONFIGURATION_NR_[A-Z_]+$/.test(error.message)
          ? error.message
          : sapInvocationStarted
            ? "CONFIGURATION_NR_FINALIZATION_UNKNOWN"
            : "CONFIGURATION_NR_PRE_INVOKE_REFUSED",
      sapInvocationStarted,
      outcomeMayBeUnknown: sapInvocationStarted,
      retryAvailable: false,
      failure,
      operationReceipt
    }
  }
}
