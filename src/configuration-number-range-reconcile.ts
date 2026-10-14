import { createHash } from "node:crypto"
import { z } from "zod"
import { configurationNumberRangeApiReadInputSchema } from "./configuration-number-range-native.js"
import { configurationNumberRangeSnapshotSchema } from "./configuration-number-range-command.js"
import {
  verifiedNumberRangeSnapshot,
  numberRangeStateFingerprint,
  numberRangeFieldDifferences,
  type NumberRangeSnapshot
} from "./configuration-number-range-state.js"
const versionSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const configurationNumberRangeReconcileInputSchema =
  configurationNumberRangeApiReadInputSchema
    .omit({ captureState: true })
    .extend({
      operationId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
      includeFieldDifferences: z.boolean().optional(),
      expectedReceiptHash: versionSchema.optional(),
      expectedCurrentVersion: versionSchema.optional(),
      expectedCurrentFingerprint: versionSchema.optional()
    })
    .strict()
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const receiptSchema = z.object({
  connectionId: z.literal("w200"),
  toolName: z.literal("apply_configuration_number_range"),
  operationIdHash: z.string().regex(/^[a-f0-9]{64}$/),
  targetKeyHash: z.string().regex(/^[a-f0-9]{64}$/),
  receiptHash: z.string().regex(/^[a-f0-9]{64}$/),
  sapInvocationStarted: z.boolean().nullable(),
  outcomeMayBeUnknown: z.boolean(),
  status: z.string(),
  sapPreChangeEvidence: z
    .object({
      target: z.string(),
      version: z.string().nullable(),
      observationStatus: z.literal("complete")
    })
    .optional()
})

/** Observe without rewriting the historical receipt or treating current data as commit proof. */
export async function reconcileConfigurationNumberRange(
  raw: unknown,
  client: string,
  readReceipt: (connectionId: string, operationId: string) => Promise<unknown>,
  readSnapshot: (objectName: string) => Promise<unknown>,
  readBeforeSnapshot?: (objectName: string, version: string) => Promise<unknown>
) {
  const input = configurationNumberRangeReconcileInputSchema.parse(raw)
  if (client !== "200") throw Error("CONFIGURATION_NR_SCOPE_UNSUPPORTED")
  const detailed = input.includeFieldDifferences === true
  if (
    (detailed && input.objectName !== "ZORVCFGNR") ||
    (!detailed &&
      [
        input.expectedReceiptHash,
        input.expectedCurrentVersion,
        input.expectedCurrentFingerprint
      ].some((value) => value !== undefined))
  )
    throw Error("CONFIGURATION_NR_FIELD_COMPARISON_SCOPE_UNSUPPORTED")
  const observed = await readReceipt(input.connectionId, input.operationId)
  if (z.object({ status: z.literal("not_found") }).safeParse(observed).success)
    return {
      status: "receipt_unavailable",
      code: "RECEIPT_NOT_FOUND",
      readOnly: true,
      retryAvailable: false,
      snapshot: null
    }
  const receipt = receiptSchema.parse(observed)
  if (
    receipt.operationIdHash !== hash(input.operationId) ||
    receipt.targetKeyHash !== hash(`CONFIG:NRIV:200:${input.objectName}`) ||
    (receipt.sapPreChangeEvidence &&
      receipt.sapPreChangeEvidence.target !== `NRIV:${input.objectName}:200`)
  )
    throw Error("CONFIGURATION_NR_RECEIPT_SCOPE_MISMATCH")
  const base = {
    code: undefined as string | undefined,
    readOnly: true,
    objectName: input.objectName,
    operationId: input.operationId,
    operationReceipt: observed,
    retryAvailable: false,
    automaticRollback: false,
    outcomeMayBeUnknown: receipt.outcomeMayBeUnknown,
    locks: "unverified",
    snapshot: null,
    ...(detailed ? { fieldComparison: null, versionGuard: null, readFlow: null } : {})
  }
  if (receipt.sapInvocationStarted === false)
    return { ...base, status: "not_dispatched", stateComparison: "not_observed" }
  if (detailed && input.expectedReceiptHash && input.expectedReceiptHash !== receipt.receiptHash)
    return { ...base, status: "partial", code: "RECEIPT_CHANGED" }
  const beforeVersion = receipt.sapPreChangeEvidence?.version
  let beforeSnapshot: NumberRangeSnapshot | undefined
  if (detailed) {
    if (!beforeVersion || !versionSchema.safeParse(beforeVersion).success || !readBeforeSnapshot)
      return { ...base, status: "partial", code: "BEFORE_SNAPSHOT_UNAVAILABLE" }
    try {
      const value = await readBeforeSnapshot(input.objectName, beforeVersion)
      if (value === null) return { ...base, status: "partial", code: "BEFORE_SNAPSHOT_UNAVAILABLE" }
      beforeSnapshot = verifiedNumberRangeSnapshot(value, input.objectName)
      if (beforeSnapshot.EV_VERSION !== beforeVersion)
        throw Error("CONFIGURATION_NR_BEFORE_VERSION_MISMATCH")
      if (!beforeSnapshot.ET_INTERVALS.some((row) => row.NRRANGENR === "02"))
        return { ...base, status: "partial", code: "BEFORE_TARGET_UNAVAILABLE" }
    } catch (error) {
      return {
        ...base,
        status: "partial",
        code: "BEFORE_SNAPSHOT_INVALID",
        readErrorHash: hash(String(error))
      }
    }
  }
  let snapshot: NumberRangeSnapshot
  try {
    const value = await readSnapshot(input.objectName)
    snapshot = detailed
      ? verifiedNumberRangeSnapshot(value, input.objectName)
      : configurationNumberRangeSnapshotSchema.parse(value)
    if (detailed) {
      const fingerprint = numberRangeStateFingerprint(snapshot)
      if (
        (input.expectedCurrentVersion && input.expectedCurrentVersion !== snapshot.EV_VERSION) ||
        (input.expectedCurrentFingerprint && input.expectedCurrentFingerprint !== fingerprint)
      )
        return {
          ...base,
          status: "partial",
          code: "CURRENT_VERSION_CHANGED",
          versionGuard: { status: "changed" }
        }
      const confirmation = verifiedNumberRangeSnapshot(
        await readSnapshot(input.objectName),
        input.objectName
      )
      if (
        confirmation.EV_VERSION !== snapshot.EV_VERSION ||
        numberRangeStateFingerprint(confirmation) !== fingerprint
      )
        return { ...base, status: "partial", code: "CURRENT_SNAPSHOT_CHANGED" }
      if (!snapshot.ET_INTERVALS.some((row) => row.NRRANGENR === "02"))
        return { ...base, status: "partial", code: "CURRENT_TARGET_UNAVAILABLE" }
    }
  } catch (error) {
    return {
      ...base,
      status: "partial",
      code: "SNAPSHOT_UNAVAILABLE",
      readErrorHash: hash(String(error))
    }
  }
  if (snapshot.ES_DEFINITION.OBJECT !== input.objectName)
    throw Error("CONFIGURATION_NR_READ_SCOPE_INVALID")
  const confirmation = receiptSchema.parse(await readReceipt(input.connectionId, input.operationId))
  if (confirmation.receiptHash !== receipt.receiptHash)
    return { ...base, status: "partial", code: "RECEIPT_CHANGED" }
  const result = {
    ...base,
    status: "partial",
    snapshot,
    stateComparison: !beforeVersion
      ? "before_version_unavailable"
      : beforeVersion === snapshot.EV_VERSION
        ? "same_as_before"
        : "changed_since_before",
    semantics:
      "Current state comparison does not prove who wrote, committed or restored it. Historical outcome and retry prohibition remain unchanged."
  }
  if (!detailed) return result
  const differences = numberRangeFieldDifferences(beforeSnapshot!, snapshot)
  if (beforeVersion === snapshot.EV_VERSION && differences.length)
    return { ...base, status: "partial", code: "NATIVE_VERSION_CONFLICT" }
  const currentFingerprint = numberRangeStateFingerprint(snapshot)
  return {
    ...result,
    fieldComparison: {
      status: differences.length ? "different_fields" : "equal_fields",
      beforeVersion,
      currentVersion: snapshot.EV_VERSION,
      beforeFingerprint: numberRangeStateFingerprint(beforeSnapshot!),
      currentFingerprint,
      differences,
      scope: "complete_TNRO_and_client_200_NRIV",
      targetInterval: "02",
      usableForWritePrecondition: false
    },
    versionGuard: {
      status: input.expectedCurrentVersion || input.expectedCurrentFingerprint ? "match" : "stable",
      currentVersion: snapshot.EV_VERSION,
      currentFingerprint
    },
    readFlow: {
      comparison: {
        tool: "reconcile_configuration_number_range",
        arguments: {
          connectionId: input.connectionId,
          objectName: input.objectName,
          operationId: input.operationId,
          includeFieldDifferences: true,
          expectedReceiptHash: receipt.receiptHash,
          expectedCurrentVersion: snapshot.EV_VERSION,
          expectedCurrentFingerprint: currentFingerprint
        },
        readOnly: true,
        saveAvailable: false
      }
    }
  }
}
