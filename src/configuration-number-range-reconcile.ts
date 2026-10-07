import { createHash } from "node:crypto"
import { z } from "zod"
import { configurationNumberRangeApiReadInputSchema } from "./configuration-number-range-native.js"
import { configurationNumberRangeSnapshotSchema } from "./configuration-number-range-command.js"
export const configurationNumberRangeReconcileInputSchema =
  configurationNumberRangeApiReadInputSchema
    .extend({ operationId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/) })
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
  readSnapshot: (objectName: string) => Promise<unknown>
) {
  const input = configurationNumberRangeReconcileInputSchema.parse(raw)
  if (client !== "200") throw Error("CONFIGURATION_NR_SCOPE_UNSUPPORTED")
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
    readOnly: true,
    objectName: input.objectName,
    operationId: input.operationId,
    operationReceipt: observed,
    retryAvailable: false,
    automaticRollback: false,
    outcomeMayBeUnknown: receipt.outcomeMayBeUnknown,
    locks: "unverified",
    snapshot: null
  }
  if (receipt.sapInvocationStarted === false)
    return { ...base, status: "not_dispatched", stateComparison: "not_observed" }
  let snapshot: z.infer<typeof configurationNumberRangeSnapshotSchema>
  try {
    snapshot = configurationNumberRangeSnapshotSchema.parse(await readSnapshot(input.objectName))
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
  const before = receipt.sapPreChangeEvidence?.version
  return {
    ...base,
    status: "partial",
    snapshot,
    stateComparison: !before
      ? "before_version_unavailable"
      : before === snapshot.EV_VERSION
        ? "same_as_before"
        : "changed_since_before",
    semantics:
      "Current state comparison does not prove who wrote, committed or restored it. Historical outcome and retry prohibition remain unchanged."
  }
}
