import { createHash } from "node:crypto"
import { z } from "zod"
import { configurationUnitFields } from "./configuration-unit.js"
import {
  configurationUnitTextApplyInputSchema,
  configurationUnitTextApplySchema
} from "./configuration-unit-apply.js"
import { configurationUnitReadApiBodyFingerprint } from "./configuration-unit-api.js"
import { hashWriteInput } from "./write-operation-receipts.js"

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const widths = [3, 1, 3, 3, 6, 10, 30] as const
export const configurationUnitTextRowSchema = z
  .object(
    Object.fromEntries(
      configurationUnitFields.T006A.map((field, index) => [
        field,
        z
          .string()
          .max(widths[index]!)
          .refine((v) => !/[\p{Cc}\p{Cs}]/u.test(v))
      ])
    )
  )
  .strict()
export const configurationUnitTextReconcileSchema = z
  .object({
    connectionId: z.literal("w200"),
    operationId: configurationUnitTextApplyInputSchema.shape.operationId,
    originalInput: configurationUnitTextApplyInputSchema.omit({
      connectionId: true,
      operationId: true
    }),
    beforeText: configurationUnitTextRowSchema,
    includeLocks: z.boolean().default(false)
  })
  .strict()

// GR2's attested reader concatenates SY-SYSID (SYSYSID/SYCHAR08) and seven CHAR fields.
// Check every observed version against the same encoding; unsupported layouts fail closed.
export function configurationUnitTextVersion(row: Record<string, string>) {
  const text =
    "T006A:v1:" +
    "GR2".padEnd(8, " ") +
    configurationUnitFields.T006A.map((field, index) =>
      row[field]!.padEnd(widths[index]!, " ")
    ).join("")
  return createHash("sha256").update(text, "utf8").digest("hex")
}
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")
const receiptSchema = z
  .object({
    status: z.enum(["in_progress", "interrupted", "failed", "completed"]),
    connectionId: z.literal("w200"),
    toolName: z.literal("apply_configuration_unit_text"),
    operationIdHash: hash,
    targetKeyHash: hash,
    inputHash: hash,
    receiptHash: hash,
    sapInvocationStarted: z.boolean().nullable(),
    outcomeMayBeUnknown: z.boolean(),
    sapPreChangeEvidence: z
      .object({
        version: hash,
        fingerprint: hash,
        requestNumber: z.string(),
        taskNumber: z.string()
      })
      .passthrough()
  })
  .passthrough()
const currentSchema = z
  .object({
    connectionId: z.literal("w200"),
    client: z.literal("200"),
    unitKey: z.string(),
    readOnly: z.literal(true),
    saveAvailable: z.literal(false),
    text: z
      .object({ requestedLanguage: z.string(), sapLanguage: z.string().regex(/^[A-Za-z0-9]$/) })
      .passthrough(),
    evidence: z
      .object({ valuesRechecked: z.literal(true), snapshot: z.literal(false) })
      .passthrough(),
    apiSnapshot: z
      .object({
        status: z.literal("read"),
        code: z.literal("READ"),
        data: configurationUnitTextRowSchema,
        textVersion: hash,
        bodyFingerprint: z.literal(configurationUnitReadApiBodyFingerprint),
        versionScope: z.literal("SAP_GR2_200_full_T006A_row_v1"),
        versionOrigin: z.literal("sap_sha256_fixed_width_utf8")
      })
      .passthrough()
  })
  .passthrough()
const entry = z.record(z.string().max(120))
const ctsSchema = z
  .object({
    connectionId: z.literal("w200"),
    client: z.literal("200"),
    requestNumber: z.string(),
    taskNumber: z.string(),
    status: z.literal("metadata_matches"),
    readOnly: z.literal(true),
    saveAvailable: z.literal(false),
    checks: z
      .object(
        Object.fromEntries(
          [
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
          ].map((name) => [name, z.literal(true)])
        )
      )
      .strict(),
    keyRecording: z
      .object({
        status: z.enum(["table_entries_observed", "no_table_entries"]),
        representation: z.literal("sap_text_trimmed"),
        E071KReadback: z.literal("bounded_trimmed_projection"),
        target: z.object({
          client: z.literal("200"),
          unitKey: z.string(),
          language: z.string(),
          sapLanguage: z.string()
        }),
        observed: z.object({
          requestE071: z.array(entry).max(32),
          requestE071K: z.array(entry).max(32),
          taskE071: z.array(entry).max(32),
          taskE071K: z.array(entry).max(32)
        }),
        readerLimits: z.object({ maximumRowsPerProjection: z.literal(32) }).passthrough()
      })
      .passthrough()
  })
  .passthrough()
const lockSchema = z
  .object({
    connectionId: z.literal("w200"),
    client: z.literal("200"),
    status: z.literal("ok"),
    hasMore: z.literal(false),
    entries: z
      .array(z.object({ client: z.literal("200"), username: z.string() }).passthrough())
      .max(100)
  })
  .passthrough()
const errorCode = (error: unknown) =>
  error instanceof Error && /^[A-Z][A-Z0-9_]{0,100}$/.test(error.message)
    ? error.message
    : "READER_UNAVAILABLE"

/** Only observations: no writer, lock acquisition, receipt update, retry or recovery callback. */
export async function reconcileConfigurationUnitText(
  raw: unknown,
  client: string,
  username: string,
  readReceipt: (connectionId: string, operationId: string) => Promise<unknown>,
  readUnit: (input: unknown) => Promise<unknown>,
  inspectTransport: (input: unknown) => Promise<unknown>,
  readLocks?: (argument: string) => Promise<unknown>
) {
  const input = configurationUnitTextReconcileSchema.parse(raw)
  const request = configurationUnitTextApplySchema.parse({
    connectionId: input.connectionId,
    operationId: input.operationId,
    ...input.originalInput
  })
  if (client !== "200") throw Error("CONFIGURATION_UNIT_RECONCILE_SCOPE_UNSUPPORTED")
  const firstReceipt = receiptSchema.safeParse(
    await readReceipt(input.connectionId, input.operationId)
  )
  if (!firstReceipt.success) throw Error("CONFIGURATION_UNIT_RECONCILE_RECEIPT_UNVERIFIED")
  const receipt = firstReceipt.data
  if (
    receipt.operationIdHash !== sha(input.operationId) ||
    receipt.targetKeyHash !== sha(`CONFIG:T006A:200:${request.unitKey}`) ||
    receipt.inputHash !== hashWriteInput(request) ||
    receipt.sapPreChangeEvidence.version !== request.expectedTextVersion ||
    receipt.sapPreChangeEvidence.fingerprint !== request.expectedReadFingerprint ||
    receipt.sapPreChangeEvidence.requestNumber !== request.requestNumber ||
    receipt.sapPreChangeEvidence.taskNumber !== request.taskNumber
  )
    throw Error("CONFIGURATION_UNIT_RECONCILE_CONTEXT_MISMATCH")
  const before = input.beforeText
  if (
    before.MANDT !== client ||
    before.MSEHI!.trimEnd() !== request.unitKey ||
    !/^[A-Za-z0-9]$/.test(before.SPRAS!) ||
    configurationUnitTextVersion(before) !== request.expectedTextVersion
  )
    throw Error("CONFIGURATION_UNIT_RECONCILE_BEFORE_MISMATCH")
  const desired = { ...before }
  for (const [field, value] of Object.entries(request.patch))
    if (value !== undefined) desired[field] = value
  const desiredVersion = configurationUnitTextVersion(desired)
  const startedAt = new Date().toISOString()
  const observations: {
    reader: string
    startedAt: string
    finishedAt: string
    status: string
    code: string | null
  }[] = []
  const observe = async (reader: string, read: () => Promise<unknown>) => {
    const start = new Date().toISOString()
    try {
      const value = await read()
      observations.push({
        reader,
        startedAt: start,
        finishedAt: new Date().toISOString(),
        status: "returned",
        code: null
      })
      return value
    } catch (error) {
      observations.push({
        reader,
        startedAt: start,
        finishedAt: new Date().toISOString(),
        status: "unavailable",
        code: errorCode(error)
      })
      return null
    }
  }
  const unitInput = {
    connectionId: input.connectionId,
    unitKey: request.unitKey,
    language: request.language,
    includeApiSnapshot: true
  }
  const first = currentSchema.safeParse(await observe("unit_before", () => readUnit(unitInput)))
  const transport = await observe("cts", () =>
    inspectTransport({
      connectionId: input.connectionId,
      requestNumber: request.requestNumber,
      taskNumber: request.taskNumber,
      unitText: { unitKey: request.unitKey, language: request.language }
    })
  )
  const lockObservations: { argument: string; status: string; observation: unknown }[] = []
  if (input.includeLocks) {
    for (const argument of ["*T006*", `*${request.requestNumber}*`, `*${request.taskNumber}*`]) {
      const value = readLocks ? await observe("locks:" + argument, () => readLocks(argument)) : null
      const parsed = lockSchema.safeParse(value)
      const valid =
        parsed.success &&
        /^[A-Za-z0-9_.-]{1,12}$/.test(username) &&
        parsed.data.entries.every((e) => e.username.toUpperCase() === username.toUpperCase())
      lockObservations.push({
        argument,
        status: valid
          ? parsed.data.entries.length
            ? "locks_observed"
            : "no_observed_locks"
          : "unavailable",
        observation: valid ? parsed.data : value
      })
    }
  }
  const second = currentSchema.safeParse(await observe("unit_after", () => readUnit(unitInput)))
  const finalReceipt = receiptSchema.safeParse(
    await observe("receipt_after", () => readReceipt(input.connectionId, input.operationId))
  )
  const receiptStable =
    finalReceipt.success &&
    finalReceipt.data.receiptHash === receipt.receiptHash &&
    finalReceipt.data.status === receipt.status &&
    finalReceipt.data.outcomeMayBeUnknown === receipt.outcomeMayBeUnknown
  const isCurrent = (v: z.infer<typeof currentSchema>) =>
    v.unitKey === request.unitKey &&
    v.text.requestedLanguage === request.language &&
    v.text.sapLanguage === before.SPRAS &&
    v.apiSnapshot.data.MANDT === client &&
    v.apiSnapshot.data.MSEHI!.trimEnd() === request.unitKey &&
    v.apiSnapshot.data.SPRAS === before.SPRAS &&
    configurationUnitTextVersion(v.apiSnapshot.data) === v.apiSnapshot.textVersion
  const valuesStable =
    first.success &&
    second.success &&
    isCurrent(first.data) &&
    isCurrent(second.data) &&
    first.data.apiSnapshot.textVersion === second.data.apiSnapshot.textVersion
  const current = valuesStable ? second.data.apiSnapshot : null
  const valueStatus =
    !current || !receiptStable
      ? "unknown"
      : current.textVersion === request.expectedTextVersion
        ? "observed_original"
        : current.textVersion === desiredVersion
          ? "observed_requested"
          : "observed_conflicting"
  const parsedCts = ctsSchema.safeParse(transport)
  let ctsStatus = "unknown",
    taskMatches = 0,
    requestMatches = 0
  if (parsedCts.success) {
    const c = parsedCts.data,
      target = c.keyRecording.target
    const scoped =
      c.requestNumber === request.requestNumber &&
      c.taskNumber === request.taskNumber &&
      target.unitKey === request.unitKey &&
      target.language === request.language &&
      target.sapLanguage === before.SPRAS &&
      target.client === client
    const rows = c.keyRecording.observed
    const correctContainers =
      rows.requestE071.every((r) => r.TRKORR === request.requestNumber) &&
      rows.requestE071K.every((r) => r.TRKORR === request.requestNumber) &&
      rows.taskE071.every((r) => r.TRKORR === request.taskNumber) &&
      rows.taskE071K.every((r) => r.TRKORR === request.taskNumber)
    if (scoped && correctContainers) {
      const matches = (r: Record<string, string>) =>
        r.PGMID === "R3TR" &&
        r.OBJECT === "TABU" &&
        r.OBJNAME === "T006A" &&
        r.MASTERTYPE === "TDAT" &&
        r.MASTERNAME === "CUNI" &&
        r.VIEWNAME === "" &&
        r.TABKEY === `${client}${before.SPRAS}${request.unitKey.padEnd(3, " ")}`.trimEnd()
      taskMatches = rows.taskE071K.filter(matches).length
      requestMatches = rows.requestE071K.filter(matches).length
      const master = rows.taskE071.some(
        (r) => r.PGMID === "R3TR" && r.OBJECT === "TDAT" && r.OBJ_NAME === "CUNI"
      )
      ctsStatus =
        taskMatches > 1 || requestMatches > 0
          ? "ambiguous_or_outside_task"
          : taskMatches === 1
            ? master
              ? "target_projection_observed"
              : "unknown"
            : "target_projection_not_observed"
    }
  }
  const locksAvailable =
    !input.includeLocks || lockObservations.every((v) => v.status !== "unavailable")
  return {
    connectionId: input.connectionId,
    client,
    operationId: input.operationId,
    unitKey: request.unitKey,
    language: request.language,
    status:
      ctsStatus === "unknown" || ctsStatus === "ambiguous_or_outside_task" || !locksAvailable
        ? "unknown"
        : valueStatus,
    readOnly: true,
    saveAvailable: false,
    automaticRetry: false,
    automaticRollback: false,
    receiptModified: false,
    originalReceipt: receipt,
    historicalOutcome: {
      status:
        receipt.sapInvocationStarted === false
          ? "not_invoked"
          : receipt.status === "completed"
            ? "receipt_completed"
            : "unresolved",
      outcomeMayBeUnknown: receipt.outcomeMayBeUnknown,
      warning:
        "Current original/requested values cannot prove whether this operation committed earlier or a later operation restored/changed them. The original receipt remains authoritative and unchanged."
    },
    value: {
      status: valueStatus,
      comparisonScope: "full_T006A_row",
      beforeVersion: request.expectedTextVersion,
      requestedVersion: desiredVersion,
      current: current ? { data: current.data, textVersion: current.textVersion } : null,
      valuesRechecked: Boolean(valuesStable),
      snapshot: false
    },
    cts: {
      status: ctsStatus,
      taskMatches,
      requestMatches,
      requestNumber: request.requestNumber,
      taskNumber: request.taskNumber,
      representation: "bounded_trimmed_projection",
      exactRowRecording: "not_verified",
      importStatus: "not_checked",
      observation: transport
    },
    locks: {
      status: input.includeLocks ? (locksAvailable ? "observed" : "unavailable") : "not_requested",
      configuredUsername: username,
      scope: "configured_user_current_client_three_argument_filters",
      observations: lockObservations,
      warning:
        "These optional observations do not prove system-wide contention absence and do not acquire or release locks."
    },
    evidence: {
      startedAt,
      finishedAt: new Date().toISOString(),
      receiptRechecked: Boolean(receiptStable),
      unitReaderInvocations: 2,
      ctsReaderInvocations: 1,
      lockReaderInvocations: input.includeLocks && readLocks ? 3 : 0,
      observations
    },
    warnings: [
      "Rechecked observations are not an atomic SAP snapshot or commit/rollback proof.",
      "CTS projection absence does not exclude generalized/wildcard keys or prove that no historical recording occurred.",
      "No retry, restoration, CTS append/removal/release or receipt update was performed."
    ]
  }
}
