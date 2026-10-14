import { createHash } from "node:crypto"
import { z } from "zod"

const sha = (value: string) => createHash("sha256").update(value).digest("hex")
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const operation = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/)
function fail(code: string): never {
  throw Error(`BTE_PROTOCOL_${code}`)
}

// Complete r80 responses from w200, observed on 2026-10-08. Re-read before native use.
// The returned source-array hash is separate from SAP's sourceFingerprint representation.
export const configurationBteProtocolSourcePins = {
  definitions: {
    INITIALIZE_PROTOCOL: {
      functionGroup: "SLOG",
      sourceFingerprint: "9fcb79507e5925b1c9f1f85ea04eacd274b0071d18335414c7b10eaff70499c9",
      interfaceFingerprint: "5e22795894cf3c8ad3fce391601797b8426685640b77dd2df8f228693a11c274",
      sourceArrayHash: "007a05ef294b5a462bb2d924a098094dab352a13e3ebb245ac4aa0594ddccbe6",
      interfaceHash: "fe7a77f3c6c0de7b95a34fc31f931bd4fb2eb64fd4576c14bfe25e06330ef82e"
    },
    TR_INITIALIZE_LOG: {
      functionGroup: "SLOG",
      sourceFingerprint: "992a78ebef691137e3b6c66d9d45e764240ac2dae37342d36b69c08e5dd58395",
      interfaceFingerprint: "153388a1567ac792d130b88eaefed4a86b13475d5c57bc2a49aa0c78d536d33a",
      sourceArrayHash: "90296d24f173324a130d68dc4703d3717b793c6b31b2603e03341fd674e8cfc4",
      interfaceHash: "cffedabb389d9fd48cf4b227c02ac15f699ff6d0d0ec2c08230fdec0909c88e9"
    },
    APPEND_PROTOCOL: {
      functionGroup: "SLOG",
      sourceFingerprint: "767668e2bc19f9c9004cf946b2d87d208695fa26461e2719094bbeb33cd2ae3a",
      interfaceFingerprint: "c03923319df8ca5859ffb7494393c6671ac4c007f11468b27c7359c7461bfa15",
      sourceArrayHash: "a38cbdc4b631d99522507829c1de7221844cb5852315ac4b220efb528dab055c",
      interfaceHash: "a8ea90a7580d71cbcd664aa150f3f285d551ba19fb3e730b605d9b8e3d63de59"
    },
    LCT_MESSAGE: {
      functionGroup: "SCTI",
      sourceFingerprint: "a94cc86f2060a0be9dd9e3ecae14725e3064441553bcc4cd57e111af871f01e7",
      interfaceFingerprint: "2518a9016f89cae5846b987df6559091a56e6d46d37678e0054f2a6613c4ff6b",
      sourceArrayHash: "1869589d943ae7f07d90efbc8cf96cd9c13e383ddea7bcd95b9f33beef28a7ca",
      interfaceHash: "e352d7f37b8e16307e02c678b30d355c687b6dc9ca7aa3d0ad004f6a007a7411"
    },
    TR_READ_LOG: {
      functionGroup: "SLOG",
      sourceFingerprint: "9fc226ed70b744b22c969e350548f63e2af9a5aa327f6679058133a47307c5e9",
      interfaceFingerprint: "ae43b7db73e2e3541af9ecb48f488f4c4a8f74cc5c684a704445dd854a9f646f",
      sourceArrayHash: "daa680bf6bfe384e234447f03135bb8fbd7681e5c091475bfcb508407200f7e9",
      interfaceHash: "783015bcb7ad0ab15070731b30976c2db674de0b0c0e846253706b036d6f2c9f"
    }
  },
  includes: {
    LSLOGTOP: {
      sourceUri: "/sap/bc/adt/functions/groups/slog/includes/lslogtop/source/main",
      sourceFingerprint: "732ef2ef92f5d3cf50f5808559e7121126bbcee7ab6afbafe6ee8e3065364ea7",
      lineCount: 131
    },
    LSLOGF03: {
      sourceUri: "/sap/bc/adt/functions/groups/slog/includes/lslogf03/source/main",
      sourceFingerprint: "dc6ce02acfe4497fbfd0d311fe4b6649ac3a19df5748023335d1a349d48126b7",
      lineCount: 485
    },
    LSLOGF05: {
      sourceUri: "/sap/bc/adt/functions/groups/slog/includes/lslogf05/source/main",
      sourceFingerprint: "4e813e8317cdfd4d44093a2068f9ad853d5deb4e88b8012a0aa433d83e3a60b0",
      lineCount: 440
    },
    LSLOGF07: {
      sourceUri: "/sap/bc/adt/functions/groups/slog/includes/lslogf07/source/main",
      sourceFingerprint: "a2165f56eebc9844161785d0807dabde63a8f004f3d93272ec1df4c136b60987",
      lineCount: 205
    },
    LSLOGF15: {
      sourceUri: "/sap/bc/adt/functions/groups/slog/includes/lslogf15/source/main",
      sourceFingerprint: "0b5bfde6034cee5c4fb16205676077043a3196a8ca1d006bc157e35d5e874b61",
      lineCount: 330
    }
  }
} as const
export const configurationBteProtocolSourceVersion = sha(
  JSON.stringify(configurationBteProtocolSourcePins)
)

/** Read-only attestation of the observed sources, not proof of the whole native logger. */
export async function attestConfigurationBteProtocolSources(readers: {
  definition(name: string): Promise<unknown>
  include(name: string): Promise<unknown>
}) {
  const definitions = Object.entries(configurationBteProtocolSourcePins.definitions).map(
    async ([name, pin]) => {
      const result = z
        .object({
          connectionId: z.literal("w200"),
          functionName: z.literal(name),
          functionGroup: z.literal(pin.functionGroup),
          sourceFingerprint: z.literal(pin.sourceFingerprint),
          interfaceFingerprint: z.literal(pin.interfaceFingerprint),
          remoteEnabled: z.literal(false),
          updateTask: z.literal(false),
          updateTaskMode: z.literal(""),
          globalInterface: z.literal(false),
          source: z.array(z.string()).min(1).max(1000),
          importParameters: z.array(z.unknown()),
          exportParameters: z.array(z.unknown()),
          changingParameters: z.array(z.unknown()),
          tableParameters: z.array(z.unknown()),
          exceptions: z.array(z.unknown())
        })
        .safeParse(await readers.definition(name))
      if (!result.success) fail("SOURCE_UNVERIFIED")
      const value = result.data
      const abi = Object.fromEntries(
        [
          "importParameters",
          "exportParameters",
          "changingParameters",
          "tableParameters",
          "exceptions"
        ].map((key) => [key, value[key as keyof typeof value]])
      )
      if (
        sha(JSON.stringify(value.source)) !== pin.sourceArrayHash ||
        sha(JSON.stringify(abi)) !== pin.interfaceHash
      )
        fail("SOURCE_UNVERIFIED")
    }
  )
  const includes = Object.entries(configurationBteProtocolSourcePins.includes).map(
    async ([name, pin]) => {
      const result = z
        .object({
          connectionId: z.literal("w200"),
          objectName: z.literal(name),
          sourceUri: z.literal(pin.sourceUri),
          source: z.string().min(1)
        })
        .safeParse(await readers.include(name))
      if (
        !result.success ||
        sha(result.data.source) !== pin.sourceFingerprint ||
        result.data.source.split("\n").length !== pin.lineCount
      )
        fail("SOURCE_UNVERIFIED")
    }
  )
  const results = await Promise.allSettled([...definitions, ...includes])
  if (results.some((result) => result.status === "rejected")) fail("SOURCE_UNVERIFIED")
  return {
    status: "source_evidence_matches" as const,
    sourceVersion: configurationBteProtocolSourceVersion,
    nativeExecutionVerified: false,
    writeAvailable: false,
    unresolvedDependencies: [
      "STRF_SETNAME_TEMPPROT",
      "TRINT_READ_LOG",
      "TRINT_GET_LOGFILE_ATTRIBUTES",
      "TRLOG_DDIC_AND_TYPE_POOL",
      "NATIVE_APPEND_FAILURE_COVERAGE",
      "SLOG_GLOBAL_AND_ABAP_MEMORY_CLEANUP"
    ]
  }
}

// Internal normalized report, not the DDIC layout or a publicly accepted RFC input.
// The future native wrapper must derive boundaries and completeness from the actual log.
const bindingSchema = z
  .object({
    operationId: operation,
    requestId: digest,
    command: z.enum(["SAVE", "RECOVER"])
  })
  .strict()
const messageSchema = z
  .object({
    sequence: z.number().int().min(1).max(1000),
    severity: z.enum([" ", "I", "S", "W", "E", "A", "P"]),
    level: z.number().int().min(1).max(9),
    messageClass: z.string().min(1).max(256),
    messageNumber: z.string().regex(/^\d{3}$/),
    language: z.string().length(1),
    text: z.string().max(4096)
  })
  .strict()
const reportSchema = bindingSchema
  .extend({
    version: z.literal(1),
    system: z.literal("GR2"),
    client: z.literal("200"),
    username: z.literal("WYS"),
    sourceVersion: digest,
    storage: z.literal("FILE"),
    initialize: z.enum(["ok", "not_initialized", "failed"]),
    append: z.enum(["ok", "failed", "unverified"]),
    read: z.enum(["ok", "failed"]),
    cleanup: z.enum(["ok", "failed", "unverified"]),
    entryCount: z.number().int().min(0),
    beginMarker: digest.nullable(),
    endMarker: digest.nullable(),
    sizeVerified: z.boolean(),
    fileBytes: z.number().int().min(0).max(50000000),
    conversionVerified: z.boolean(),
    compacted: z.boolean(),
    truncated: z.boolean(),
    reportedCount: z.number().int().min(0).max(1000),
    messages: z.array(messageSchema).max(1000)
  })
  .strict()

/** All messages matter; a later S/I/blank message cannot cancel an earlier E/A/P.
 * LCT_MESSAGE swallows APPEND_PROTOCOL failures. A normal return cannot prove append=ok.
 * Even complete_without_errors is only a necessary condition, never permission to commit.
 */
export function inspectConfigurationBteProtocol(raw: unknown, binding: unknown) {
  const parsed = reportSchema.safeParse(raw)
  const expected = bindingSchema.safeParse(binding)
  if (!parsed.success || !expected.success) fail("RESPONSE_UNVERIFIED")
  const report = parsed.data
  if (
    report.operationId !== expected.data.operationId ||
    report.requestId !== expected.data.requestId ||
    report.command !== expected.data.command
  )
    fail("BINDING_MISMATCH")
  if (report.sourceVersion !== configurationBteProtocolSourceVersion) fail("SOURCE_CHANGED")
  const checks = {
    INITIALIZATION_FAILED: report.initialize === "ok",
    STALE_LOG: report.entryCount === 0,
    BOUNDARY_UNVERIFIED:
      report.beginMarker === report.requestId && report.endMarker === report.requestId,
    APPEND_UNVERIFIED: report.append === "ok",
    READ_FAILED: report.read === "ok",
    CLEANUP_UNVERIFIED: report.cleanup === "ok",
    SIZE_UNVERIFIED: report.sizeVerified && report.fileBytes > 0,
    CONVERSION_UNVERIFIED: report.conversionVerified,
    TRUNCATED: !report.compacted && !report.truncated,
    COUNT_MISMATCH: report.reportedCount === report.messages.length,
    EMPTY_LOG: report.messages.length > 0,
    ORDER_UNVERIFIED: report.messages.every((message, i) => message.sequence === i + 1),
    MESSAGE_UNPARSED: report.messages.every(
      (message) => message.messageClass.trim().length > 0 && message.language.trim().length > 0
    )
  }
  const blockers = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([code]) => code)
  const errors = report.messages.filter((message) => ["E", "A", "P"].includes(message.severity))
  return {
    status: blockers.length
      ? ("incomplete" as const)
      : errors.length
        ? ("errors_observed" as const)
        : ("complete_without_errors" as const),
    report,
    blockers,
    errors,
    firstError: errors[0] ?? null,
    writeAvailable: false,
    transactionVerified: false,
    automaticRetry: false
  }
}
