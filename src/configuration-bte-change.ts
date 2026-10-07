import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import {
  configurationBteProductSchema,
  type previewConfigurationBteProduct
} from "./configuration-bte-product.js"
import {
  configurationBteMetadataResponse,
  type inspectConfigurationBteMetadata
} from "./configuration-bte-metadata.js"
import { createReviewedTableReader, type ReviewedReaderSource } from "./reviewed-table-reader.js"
import {
  attestConfigurationBteSaveApis,
  buildConfigurationBteSaveContainers,
  configurationBteSaveSessionRequirements
} from "./configuration-bte-save-plan.js"

export const configurationBteChangeSchema = configurationBteProductSchema
  .omit({ expectedFingerprint: true })
  .extend({
    expectedFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
  })
  .strict()

// Active w200 DDIC definitions read on 2026-10-07. Texts cover every language.
export const configurationBteProtectionLayouts = {
  TBE24T: {
    fingerprint: "4cd1dd171c71c1edc06d8c0417e4646acb8c7d0f6608978029dde574cb03186c",
    fields: ["MANDT", "SPRAS", "PRDKT", "TXT50"],
    keys: ["MANDT", "SPRAS", "PRDKT"]
  },
  TCONT: {
    fingerprint: "d12ade3ef05421e80b36d555226b2e790d4d6c2079d27435de11f73dd0814640",
    fields: ["FRMID", "DATUM", "UZEIT"],
    keys: ["FRMID"]
  }
} as const

const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]])
        )
      : v
  )
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex")
function fail(code: string): never {
  throw Error(`BTE_CHANGE_${code}`)
}
type Preview = Awaited<ReturnType<typeof previewConfigurationBteProduct>>
type Metadata = Awaited<ReturnType<typeof inspectConfigurationBteMetadata>>

/** A complete review bundle, with no executable command or approval grant. */
export async function prepareConfigurationBteProductChange(
  raw: unknown,
  client: string,
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  readers: {
    preview: (input: z.output<typeof configurationBteProductSchema>) => Promise<Preview>
    metadata: () => Promise<Metadata>
    table: (name: string) => Promise<unknown>
    definition: (name: string) => Promise<unknown>
  }
) {
  const input = configurationBteChangeSchema.parse(raw)
  if (client !== "200") fail("SCOPE_UNSUPPORTED")
  const { expectedFingerprint, ...previewInput } = input
  const sources: ReviewedReaderSource[] = [],
    warnings: string[] = []
  const reader = createReviewedTableReader(
    backend,
    "w200",
    () => readers.definition("RFC_READ_TABLE"),
    sources,
    warnings
  )
  async function protection() {
    const result: Record<string, Record<string, string>[]> = {}
    for (const name of ["TBE24T", "TCONT"] as const) {
      const pin = configurationBteProtectionLayouts[name]
      const d = z
        .object({
          connectionId: z.literal("w200"),
          objectKind: z.literal("transparentTable"),
          objectName: z.literal(name),
          fingerprint: z.literal(pin.fingerprint),
          active: z.literal(true).optional(),
          definition: z.object({
            tableClass: z.literal("TRANSP"),
            fields: z.array(z.object({ name: z.string(), key: z.boolean() }))
          })
        })
        .safeParse(await readers.table(name))
      if (
        !d.success ||
        canonical(d.data.definition.fields.map((f) => f.name)) !== canonical(pin.fields) ||
        canonical(d.data.definition.fields.filter((f) => f.key).map((f) => f.name)) !==
          canonical(pin.keys)
      )
        fail("LAYOUT_UNVERIFIED")
      const rows = await reader({
        table: name,
        fields: pin.fields,
        filters:
          name === "TBE24T" ? { MANDT: client, PRDKT: input.productName } : { FRMID: "CP_INFO" },
        maximum: name === "TBE24T" ? 200 : 1,
        codePrefix: "BTE_CHANGE_",
        mapError: () => "BTE_CHANGE_READ_FAILED",
        validate: (records) => {
          if (
            records.some((r) =>
              name === "TBE24T"
                ? r.MANDT !== client || r.PRDKT !== input.productName
                : r.FRMID !== "CP_INFO"
            )
          )
            fail("RESPONSE_SCOPE_MISMATCH")
          const keys = records.map((r) => canonical(pin.keys.map((k) => r[k])))
          if (new Set(keys).size !== keys.length) fail("DUPLICATE_KEY")
          if (
            name === "TBE24T" &&
            records.some(
              (r) =>
                r.SPRAS!.length !== 1 ||
                !r.SPRAS!.trim() ||
                /\p{Cc}/u.test(r.SPRAS!) ||
                r.TXT50!.length > 50 ||
                /\p{Cc}/u.test(r.TXT50!)
            )
          )
            fail("TEXT_INVALID")
          if (
            name === "TCONT" &&
            records.some((r) => !/^\d{8}$/.test(r.DATUM!) || !/^\d{6}$/.test(r.UZEIT!))
          )
            fail("CACHE_STATE_INVALID")
        }
      })
      const status = sources.at(-1)?.status
      if (!rows || !["ok", "empty"].includes(status ?? "")) fail("READ_INCOMPLETE")
      result[name] = rows.sort((a, b) => canonical(a).localeCompare(canonical(b)))
    }
    return result
  }
  const before = await readers.preview(previewInput),
    protectedBefore = await protection()
  const standardApis = await attestConfigurationBteSaveApis(readers.definition)
  const metadata = await readers.metadata()
  if (
    metadata.connectionId !== "w200" ||
    metadata.client !== client ||
    metadata.status !== "native_metadata_read" ||
    metadata.readOnly !== true ||
    metadata.executable !== false ||
    metadata.writeAvailable !== false ||
    metadata.fresh !== false ||
    !configurationBteMetadataResponse.safeParse(metadata.native).success
  )
    fail("METADATA_UNVERIFIED")
  const after = await readers.preview(previewInput),
    protectedAfter = await protection()
  if (
    before.fingerprint !== after.fingerprint ||
    canonical(before.change) !== canonical(after.change) ||
    canonical(before.assignments) !== canonical(after.assignments) ||
    canonical(protectedBefore) !== canonical(protectedAfter)
  )
    fail("READ_CHANGED")
  if (
    !before.coverage.completeWithinBound ||
    !after.coverage.completeWithinBound ||
    before.connectionId !== "w200" ||
    before.client !== client ||
    before.productName !== input.productName ||
    before.executable !== false ||
    before.writeAvailable !== false
  )
    fail("PREVIEW_UNVERIFIED")
  const h = metadata.native.ET_HEADER[0]!
  if (
    h.VIEWNAME !== "TBE24" ||
    h.MAINTVIEW !== "TBE24" ||
    h.AREA !== "BFTM" ||
    h.TEXTTAB !== "TBE24T" ||
    h.FRM_AF_SAV !== "CONTEXT_BUFFER_DELETE_CUS" ||
    !metadata.native.ET_EVENTS.some(
      (e) => e.TABNAME === "TBE24" && e.EVENT === "02" && e.FORMNAME === h.FRM_AF_SAV
    )
  )
    fail("CALLBACK_UNVERIFIED")
  const manifest = {
    scope: { connectionId: "w200", client, productName: input.productName },
    change: before.change,
    preserved: { languageTexts: protectedBefore.TBE24T!, assignments: before.assignments },
    cacheBefore: protectedBefore.TCONT!,
    previewFingerprint: before.fingerprint,
    metadataFingerprint: metadata.fingerprint,
    protectionLayouts: configurationBteProtectionLayouts,
    nativeSavePreparation: {
      standardApis,
      containers: buildConfigurationBteSaveContainers(
        metadata.native,
        before.change.before,
        before.change.after,
        protectedBefore.TBE24T
      ),
      sessionRequirements: configurationBteSaveSessionRequirements
    }
  }
  const fingerprint = hash(manifest)
  if (expectedFingerprint && expectedFingerprint !== fingerprint) fail("VERSION_CONFLICT")
  return {
    ...manifest,
    fingerprint,
    status: "change_review_prepared",
    readOnly: true,
    executable: false,
    writeAvailable: false,
    recovery: {
      tableName: "TBE24",
      key: before.change.key,
      restore: before.change.before,
      requireCurrent: before.change.after,
      changedFields: before.change.changedFields,
      restoreLanguageTexts: false,
      restoreAssignments: false,
      restoreCacheTimestamp: false,
      ctsCleanup: "only separately approved keys proven newly added by the same execution",
      requiresLockedRecheck: true,
      retryAfterUnknownOutcome: false
    },
    expectedEffects: {
      afterSaveCallback: "CONTEXT_BUFFER_DELETE_CUS",
      contextId: "CP_INFO",
      tableName: "TCONT",
      scope: "context timestamp shared across clients and application servers",
      timestampMayChange: !before.change.noOp,
      cacheInvalidationVerified: false,
      handlerInvoked: false
    },
    commandRequirements: {
      authenticatedWriteAuthority: true,
      standardEnqueueBeforeVersionCheck: true,
      exactOpenCustomizingRequestAndTask: true,
      keyLevelCtsEvidence: true,
      preserveAllLanguageTextsAndAssignments: true,
      singleCommitOwnership: true,
      reconcileUnknownWithoutReplay: true,
      separateSaveAndRecover: true
    },
    executionBlockers: [
      "BTE_PRODUCT_WRITE_ADAPTER_PENDING",
      "BTE_STANDARD_CTS_DIALOG_PATH_UNPROVEN",
      "BTE_STANDARD_LUW_AND_CALLBACK_CLOSURE_UNPROVEN"
    ],
    coverage: {
      completeWithinBound: true,
      twoReadAgreement: true,
      atomicSnapshot: false,
      authorizedForWrite: false,
      ctsInspected: false,
      businessRuntimeInspected: false
    },
    sources,
    warnings
  }
}
