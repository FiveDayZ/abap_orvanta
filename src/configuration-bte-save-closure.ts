import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import { createReviewedTableReader, type ReviewedReaderSource } from "./reviewed-table-reader.js"
import {
  configurationTransportFields,
  configurationTransportLayouts
} from "./configuration-transport.js"

// Full active sources read in w200 on 2026-10-07. These are constraints, not LUW proof.
export const configurationBteSaveIncludePins = {
  LSVIMF0U: {
    sourceUri: "/sap/bc/adt/functions/groups/svim/includes/lsvimf0u/source/main",
    sourceFingerprint: "03a0c6acfabb466adcb377803c9b51281db3dc8434b00099f2f009bd34f855fa",
    lineCount: 206
  },
  LSVIXF10: {
    sourceUri: "/sap/bc/adt/functions/groups/svix/includes/lsvixf10/source/main",
    sourceFingerprint: "42116480f36b2b22bba47280405b3c2328732250ada8b1cb3c80c29f6ed699fa",
    lineCount: 340
  },
  LSTRDF50: {
    sourceUri: "/sap/bc/adt/functions/groups/strd/includes/lstrdf50/source/main",
    sourceFingerprint: "1af9a432dd21fa9a71f9819b3a457f741c7e652716221ead833a88f44525cb85",
    lineCount: 3336
  },
  LCTS_WBO_API_IMPLF06: {
    sourceUri:
      "/sap/bc/adt/functions/groups/cts_wbo_api_impl/includes/lcts_wbo_api_implf06/source/main",
    sourceFingerprint: "5b636efdc41343a17f167f504f33189ba69dab03408d1066e00232f6bdec8f85",
    lineCount: 199
  }
} as const

function fail(code: string): never {
  throw Error(`BTE_SAVE_CLOSURE_${code}`)
}

/** Pin the reached include bodies as well as their containing function interfaces. */
export async function attestConfigurationBteSaveIncludes(read: (name: string) => Promise<unknown>) {
  const records = await Promise.allSettled(
    Object.entries(configurationBteSaveIncludePins).map(async ([name, pin]) => {
      const result = z
        .object({
          connectionId: z.literal("w200"),
          objectName: z.literal(name),
          sourceUri: z.literal(pin.sourceUri),
          source: z.string().min(1),
          kind: z.literal("source")
        })
        .safeParse(await read(name))
      if (
        !result.success ||
        createHash("sha256").update(result.data.source).digest("hex") !== pin.sourceFingerprint ||
        result.data.source.split("\n").length !== pin.lineCount
      )
        fail("SOURCE_UNVERIFIED")
      return [name, pin] as const
    })
  )
  if (records.some((r) => r.status === "rejected")) fail("SOURCE_UNVERIFIED")
  return Object.fromEntries(
    records.map((r) => {
      if (r.status !== "fulfilled") fail("SOURCE_UNVERIFIED")
      return r.value
    })
  )
}

/** The API takes a parent request and SELECTs a current-user task without ORDER BY.
 * A requested task is predictable only if it is the sole eligible Q/D task.
 * This unlocked read neither authorizes saving nor proves that creation cannot race it.
 */
export async function inspectConfigurationBteTaskSelection(
  input: { requestNumber: string; taskNumber: string },
  username: string,
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  readers: {
    transport: () => Promise<unknown>
    table: (name: string) => Promise<unknown>
    definition: (name: string) => Promise<unknown>
  }
) {
  const user = username.toUpperCase()
  if (!/^[A-Z0-9_]{1,12}$/.test(user)) fail("USER_UNVERIFIED")
  if (
    !/^GR2K\d{6}$/.test(input.requestNumber) ||
    !/^GR2K\d{6}$/.test(input.taskNumber) ||
    input.requestNumber === input.taskNumber
  )
    fail("TRANSPORT_SCOPE_UNSUPPORTED")
  const result = z
    .object({
      connectionId: z.literal("w200"),
      client: z.literal("200"),
      requestNumber: z.literal(input.requestNumber),
      taskNumber: z.literal(input.taskNumber),
      status: z.literal("metadata_matches"),
      readOnly: z.literal(true),
      saveAvailable: z.literal(false),
      readFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      observed: z.object({ task: z.array(z.object({ AS4USER: z.literal(user) })).length(1) }),
      checks: z.record(z.boolean())
    })
    .safeParse(await readers.transport())
  const requiredChecks = [
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
  ]
  if (!result.success || requiredChecks.some((key) => result.data.checks[key] !== true))
    fail("TRANSPORT_UNVERIFIED")
  const layout = z
    .object({
      connectionId: z.literal("w200"),
      objectKind: z.literal("transparentTable"),
      objectName: z.literal("E070"),
      fingerprint: z.literal(configurationTransportLayouts.E070),
      active: z.literal(true).optional()
    })
    .safeParse(await readers.table("E070"))
  if (!layout.success) fail("CTS_LAYOUT_UNVERIFIED")
  const sources: ReviewedReaderSource[] = [],
    warnings: string[] = []
  const reader = createReviewedTableReader(
    backend,
    "w200",
    () => readers.definition("RFC_READ_TABLE"),
    sources,
    warnings
  )
  const tasks = await reader({
    table: "E070",
    fields: configurationTransportFields.E070,
    filters: { STRKORR: input.requestNumber, AS4USER: user, TRFUNCTION: "Q", TRSTATUS: "D" },
    maximum: 200,
    codePrefix: "BTE_SAVE_CLOSURE_",
    mapError: (error) =>
      error instanceof Error && /^BTE_SAVE_CLOSURE_[A-Z_]+$/.test(error.message)
        ? error.message
        : "BTE_SAVE_CLOSURE_TASK_READ_FAILED",
    validate: (rows) => {
      if (
        rows.some(
          (row) =>
            row.STRKORR !== input.requestNumber ||
            row.AS4USER !== user ||
            row.TRFUNCTION !== "Q" ||
            row.TRSTATUS !== "D" ||
            !/^GR2K\d{6}$/.test(row.TRKORR ?? "")
        )
      )
        fail("TASK_RESPONSE_SCOPE_MISMATCH")
      if (new Set(rows.map((r) => r.TRKORR)).size !== rows.length) fail("TASK_DUPLICATE")
    }
  })
  if (!tasks) throw Error(sources.at(-1)?.code ?? "BTE_SAVE_CLOSURE_TASK_READ_INCOMPLETE")
  if (!["ok", "empty"].includes(sources.at(-1)?.status ?? "")) fail("TASK_READ_INCOMPLETE")
  if (!tasks.length) fail("TASK_NOT_FOUND")
  if (tasks.length !== 1) fail("TASK_SELECTION_AMBIGUOUS")
  if (tasks[0]!.TRKORR !== input.taskNumber || tasks[0]!.KORRDEV !== "CUST")
    fail("TASK_SELECTION_MISMATCH")
  return {
    status: "unique_existing_task_observed" as const,
    requestNumber: input.requestNumber,
    taskNumber: input.taskNumber,
    configuredUser: user,
    transportFingerprint: result.data.readFingerprint,
    eligibleTasks: tasks,
    standardRequestArgument: input.requestNumber,
    authenticatedUserVerified: false,
    atomicSnapshot: false,
    creationRaceExcluded: false,
    retainLocksThroughCommitVerified: false,
    writeAvailable: false,
    sources,
    warnings
  }
}

export const configurationBteSavePathConstraints = {
  cts: {
    requestArgument: "parent_request",
    taskSelection: "current_user_Q_D_task_without_order_by",
    requireUniqueExistingTask: true,
    noExplicitDbcommitSuppressesOnlyFinalCommit: true,
    creationPathsMustBeExcludedUnderLock: true,
    standardReleasesRequestAndTaskLocksBeforeReturn: true,
    retainLocksThroughCallerCommitVerified: false,
    enabledExternalSynchronizer: "reject_until_verified"
  },
  maintenance: {
    saveMayLogErrorWithoutRaisingException: true,
    requireNativeMessagesAndFullReadback: true,
    localStateRestoreCoversOnlyFourImportFlags: true,
    requireAllExitCleanupProof: true,
    defaultTableLockScope: "2",
    defaultTableUnlockScope: "3",
    requireEntityAndAllLanguageTextLocks: true
  },
  nativeExecutionVerified: false,
  executionBlockers: [
    "BTE_CTS_CREATION_AND_TASK_SELECTION_LOCK_CLOSURE_UNPROVEN",
    "BTE_CTS_LOCK_RELEASE_BEFORE_CALLER_COMMIT_UNPROVEN",
    "BTE_SAVE_MESSAGE_AND_SESSION_CLEANUP_UNPROVEN"
  ]
} as const
