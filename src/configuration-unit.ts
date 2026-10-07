import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import { configurationImgDetailLanguage } from "./configuration-img-details.js"
import { createReviewedTableReader, type ReviewedReaderSource } from "./reviewed-table-reader.js"
import { transportNumberSchema } from "./transport-delivery.js"

export const configurationUnitSchema = z
  .object({
    connectionId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,100}$/)
      .toLowerCase(),
    // MEINS allows lowercase. This is an exact internal key, not CUNIT external-format input.
    unitKey: z
      .string()
      .refine((v) => !/[\p{Cc}|]/u.test(v))
      .pipe(z.string().trim().min(1).max(3)),
    language: configurationImgDetailLanguage.optional(),
    expectedReadFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
  })
  .strict()

export const configurationUnitLayouts = {
  T006: "f50d5162d3ec4d68c98ac89c4701206ac771cd14d4c2c3303b8e3d7ba280aba7",
  T006A: "4c66cca985d3bb01e38b02ff5085f3e595e9da3e22e50bc75b47878940d9383d",
  T002: "f3d64b69bf9be805d92657ca047f9164f0662bbc4b07e3f8c944f21ff70fc307"
} as const

// Reviewed w300/300: identical field/key definitions; buffering and logging settings differ.
export const configurationUnitComparisonLayouts = {
  w200: configurationUnitLayouts,
  w300: {
    T006: "0c320a95f1cb71ca0eda374bf0561522c02ba3cfa4f56696c8b1f6758d963b06",
    T006A: "44a35a3b0b0994af242b3bf458daba13ffc051ebc3c531f6b05c60d3ee12ff55",
    T002: "6b93805e8c6e93bdc9d54ab2ce5ffb9d01cd5ed6c45ed5138b242e15b244e4d3"
  }
} as const

const textValue = (length: number) =>
  z
    .string()
    .max(length)
    .refine((v) => !/\p{Cc}/u.test(v))
    .pipe(z.string().trim())
const unitTextTransportSchema = z
  .object({ requestNumber: transportNumberSchema, taskNumber: transportNumberSchema })
  .strict()
  .refine((value) => value.requestNumber !== value.taskNumber, "Request and task must differ")
const unitTextPatchSchema = z
  .object({ MSEHT: textValue(10).optional(), MSEHL: textValue(30).optional() })
  .strict()
  .refine((v) => Object.values(v).some((value) => value !== undefined))
// The MCP SDK advertises object schemas; cross-field rules are enforced by the service below.
export const configurationUnitTextPreviewInputSchema = configurationUnitSchema.extend({
  includeMaintenanceBoundary: z.boolean().optional(),
  transport: unitTextTransportSchema.optional(),
  expectedReadFingerprint: configurationUnitSchema.shape.expectedReadFingerprint.unwrap(),
  expectedTextVersion: configurationUnitSchema.shape.expectedReadFingerprint,
  patch: unitTextPatchSchema
})
export const configurationUnitTextPreviewSchema = configurationUnitTextPreviewInputSchema
  .refine(
    (value) => !value.transport || (value.includeMaintenanceBoundary === true && !!value.language),
    "Transport observation requires maintenance boundary and explicit language"
  )
  .refine(
    (value) => !value.expectedTextVersion || !!value.language,
    "Text version comparison requires explicit language"
  )

// These are the observed w200 description fields, not external CUNIT aliases MSEH3/MSEH6.
const textMetadata = [
  [
    "MSEHT",
    "TEXT10",
    10,
    "be7d7dacd8ffb1f467a3d779f41ff85e0411944bf6fc2fb52415feae6b8e5192",
    "522f03d1733e196552d3886c9363f506a967185a66a4b2537a6bb23130db197b"
  ],
  [
    "MSEHL",
    "TEXT30",
    30,
    "13f25ac06159885981c13d9e7265f68080767717040dd5aca8ba560450f6147b",
    "f24751b3b57d9e6eb6e8aa3de2337743ebe6d208267401899a0a3d8849260d91"
  ]
] as const

export async function previewConfigurationUnitText(
  raw: unknown,
  client: string,
  readUnit: (
    input: z.infer<typeof configurationUnitSchema> & { includeApiSnapshot?: true }
  ) => Promise<Awaited<ReturnType<typeof readConfigurationUnit>>>,
  readElement: (name: string) => Promise<unknown>,
  readDomain: (name: string) => Promise<unknown>,
  readDescriptor?: () => Promise<unknown>,
  readTransport?: (input: UnitTextTransportInput) => Promise<unknown>
) {
  const input = configurationUnitTextPreviewSchema.parse(raw)
  if (input.connectionId !== "w200" || client !== "200")
    throw new Error("CONFIGURATION_UNIT_SCOPE_UNSUPPORTED")
  const verify = async () => {
    for (const [field, domain, length, elementFingerprint, domainFingerprint] of textMetadata) {
      if (
        !z
          .object({
            connectionId: z.literal("w200"),
            objectName: z.literal(field),
            objectKind: z.literal("dataElement"),
            active: z.literal(true).optional(),
            fingerprint: z.literal(elementFingerprint),
            definition: z.object({ domainName: z.literal(domain) })
          })
          .safeParse(await readElement(field)).success ||
        !z
          .object({
            connectionId: z.literal("w200"),
            objectName: z.literal(domain),
            objectKind: z.literal("domain"),
            active: z.literal(true).optional(),
            fingerprint: z.literal(domainFingerprint),
            definition: z.object({
              dataType: z.literal("CHAR"),
              length: z.literal(length),
              decimals: z.literal(0),
              lowercase: z.literal(true),
              conversionExit: z.literal(""),
              valueTable: z.literal(""),
              fixedValues: z.array(z.never())
            })
          })
          .safeParse(await readDomain(domain)).success
      )
        throw new Error("CONFIGURATION_UNIT_TEXT_METADATA_UNVERIFIED")
    }
  }
  await verify()
  const {
    patch: requestedPatch,
    includeMaintenanceBoundary,
    transport,
    expectedTextVersion,
    ...readInput
  } = input
  const patch: Record<string, string> = Object.fromEntries(
    Object.entries(requestedPatch).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  )
  let current = await readUnit(readInput)
  await verify()
  let maintenanceBoundary: {
    status: string
    descriptorFingerprint: string | null
    sourceFingerprint: string | null
    route: Record<string, unknown> | null
  } | null = null
  if (includeMaintenanceBoundary) {
    maintenanceBoundary = {
      status: "unavailable",
      descriptorFingerprint: null,
      sourceFingerprint: null,
      route: null
    }
    if (readDescriptor) {
      try {
        const fp = z.string().regex(/^[a-f0-9]{64}$/)
        const parsed = z
          .object({
            connectionId: z.literal("w200"),
            sessionClient: z.literal("200"),
            objectName: z.literal("T006A"),
            definitionFingerprint: z.literal(configurationUnitLayouts.T006A),
            descriptorFingerprint: fp,
            status: z.literal("partial"),
            readOnly: z.literal(true),
            saveAvailable: z.literal(false),
            maintenanceRoute: z
              .object({
                status: z.enum([
                  "source_attested",
                  "unreviewed",
                  "changed",
                  "unavailable",
                  "mapping_unresolved"
                ]),
                executable: z.literal(false),
                sourceFingerprint: fp.nullable(),
                route: z
                  .object({
                    activityId: z.literal("SIMG_CFMENUOLMSOMSC"),
                    transaction: z.literal("CUNI"),
                    program: z.literal("SAPMUNIT"),
                    kind: z.literal("dialog_module_pool")
                  })
                  .nullable(),
                textMaintenanceBoundary: z
                  .object({
                    objectName: z.literal("T006A"),
                    keyFields: z.tuple([
                      z.literal("MANDT"),
                      z.literal("SPRAS"),
                      z.literal("MSEHI")
                    ]),
                    patchFields: z.tuple([z.literal("MSEHT"), z.literal("MSEHL")]),
                    executable: z.literal(false),
                    wholeRowVersionAvailable: z.literal(false),
                    headlessRouteProved: z.literal(false),
                    atomicRollbackProved: z.literal(false)
                  })
                  .passthrough()
                  .nullable()
              })
              .passthrough()
          })
          .safeParse(await readDescriptor())
        if (
          parsed.success &&
          (parsed.data.maintenanceRoute.status !== "source_attested" ||
            (parsed.data.maintenanceRoute.route &&
              parsed.data.maintenanceRoute.textMaintenanceBoundary &&
              parsed.data.maintenanceRoute.sourceFingerprint))
        ) {
          const descriptor = parsed.data
          maintenanceBoundary = {
            status: descriptor.maintenanceRoute.status,
            descriptorFingerprint: descriptor.descriptorFingerprint,
            sourceFingerprint: descriptor.maintenanceRoute.sourceFingerprint,
            route:
              descriptor.maintenanceRoute.status === "source_attested"
                ? descriptor.maintenanceRoute
                : null
          }
        } else maintenanceBoundary.status = "unreviewed"
      } catch {
        maintenanceBoundary.status = "unavailable"
      }
    }
    // Source/IMG inspection adds time; the draft must use a fresh match against the caller's read.
    current = await readUnit(readInput)
    await verify()
  }
  let ready =
    current.comparison === "match" &&
    current.unit.status === "read" &&
    current.text.status === "read" &&
    current.unit.data !== null &&
    current.text.data !== null
  const cts = transport
    ? await observeUnitTextTransport(transport, readInput, current, ready, readTransport)
    : null
  if (cts?.versionMatches === false) ready = false
  let apiPrecondition: ReturnType<typeof compareUnitTextVersion> | null = null
  if (expectedTextVersion) {
    // Observe the native row last, after the optional source and CTS inspections.
    const previouslyReady = ready
    current = await readUnit({ ...readInput, includeApiSnapshot: true })
    await verify()
    ready =
      previouslyReady &&
      current.comparison === "match" &&
      current.unit.status === "read" &&
      current.text.status === "read" &&
      current.unit.data !== null &&
      current.text.data !== null
    apiPrecondition = compareUnitTextVersion(current, expectedTextVersion, input.unitKey, ready)
    if (apiPrecondition.status !== "match") {
      ready = false
      if (current.apiSnapshot)
        current = {
          ...current,
          apiSnapshot: {
            ...current.apiSnapshot,
            status: apiPrecondition.status,
            code: apiPrecondition.code,
            data: null,
            textVersion: null
          }
        }
    }
  }
  const before = ready ? current.text.data : null
  const after = before ? { ...before, ...patch } : null
  const changes =
    before && after
      ? Object.entries(patch)
          .filter(([field, value]) => value !== undefined && value !== before[field])
          .map(([field, value]) => ({ field, before: before[field], after: value }))
      : []
  return {
    connectionId: input.connectionId,
    client,
    unitKey: input.unitKey,
    operation: "update_existing_text",
    status: ready ? (changes.length ? "draft" : "no_changes") : "blocked",
    readOnly: true,
    executable: false,
    saveAvailable: false,
    language: current.text.requestedLanguage,
    sapLanguage: current.text.sapLanguage,
    patch,
    before,
    after,
    changes,
    ...(includeMaintenanceBoundary
      ? {
          maintenanceBoundary,
          manualHandoff:
            ready &&
            changes.length &&
            before!.MANDT === client &&
            before!.MSEHI === input.unitKey &&
            before!.SPRAS === current.text.sapLanguage &&
            maintenanceBoundary?.status === "source_attested" &&
            (!cts || cts.status === "observed")
              ? {
                  status: "manual_only",
                  executable: false,
                  connectionId: input.connectionId,
                  client,
                  objectName: "T006A",
                  operation: "update_existing_text",
                  activityId: "SIMG_CFMENUOLMSOMSC",
                  transaction: "CUNI",
                  key: { MANDT: before!.MANDT, SPRAS: before!.SPRAS, MSEHI: before!.MSEHI },
                  patch,
                  before: { MSEHT: before!.MSEHT, MSEHL: before!.MSEHL },
                  after: { MSEHT: after!.MSEHT, MSEHL: after!.MSEHL },
                  readFingerprint: current.readFingerprint,
                  descriptorFingerprint: maintenanceBoundary.descriptorFingerprint,
                  sourceFingerprint: maintenanceBoundary.sourceFingerprint,
                  instructions: [
                    "Verify the exact internal unit key and SAP language in CUNI before editing.",
                    "Review the proposed description fields; preserve omitted descriptions and external aliases.",
                    "SAP operator must verify permissions, client recording, task/key recording and update-task result; do not call low-level table writers or translation/CTS functions from this draft.",
                    "After manual maintenance, re-read the exact language row and reconcile values and CTS evidence; this draft authorizes no SAP operation."
                  ],
                  ctsPolicy: "not_verified",
                  ...(cts ? { cts } : {})
                }
              : null,
          evidence: {
            descriptorReaderInvocations: readDescriptor ? 1 : 0,
            descriptorReaderInvocationLimit: 1,
            unitReaderInvocations: expectedTextVersion ? 3 : 2,
            unitReaderInvocationLimit: expectedTextVersion ? 3 : 2,
            targetRechecked: true,
            snapshot: false
          }
        }
      : {}),
    ...(cts ? { cts } : {}),
    ...(apiPrecondition ? { apiPrecondition } : {}),
    readFingerprint: current.readFingerprint,
    comparison: current.comparison,
    blockedReason: ready
      ? null
      : cts?.versionMatches === false
        ? "CTS_UNIT_VERSION_CHANGED"
        : apiPrecondition?.status !== "match" && apiPrecondition
          ? apiPrecondition.code
          : current.comparison === "changed"
            ? "READ_VERSION_CHANGED"
            : current.unit.status !== "read"
              ? "UNIT_" + current.unit.status.toUpperCase()
              : "TEXT_" + current.text.status.toUpperCase(),
    validation: {
      characterLengths: "verified",
      metadataRechecked: true,
      businessRules: "unknown",
      maintenanceApi: "unknown",
      ctsPolicy: "unknown"
    },
    writeRefusalReasons: [
      "MAINTENANCE_API_NOT_VERIFIED",
      "BUSINESS_RULES_NOT_VERIFIED",
      "CTS_KEY_RECORDING_NOT_VERIFIED",
      apiPrecondition?.status === "match"
        ? "LOCKED_VERSION_CHECK_NOT_VERIFIED"
        : "FULL_ROW_VERSION_NOT_AVAILABLE"
    ],
    currentRead: current,
    warnings: [
      "Display-only draft for one existing language text row; omitted fields are preserved. Empty strings explicitly propose clearing; no row is created or deleted.",
      "Only MSEHT/MSEHL descriptions are accepted. Internal keys, external unit aliases, numeric settings and other languages cannot be patched.",
      "Values use trimmed SAP text representation. This draft is not business validation, a write precondition, an approval token or an executable preview.",
      ...(apiPrecondition
        ? [
            "SAP full-row version comparison is an unlocked observation. A future writer must compare it again under the compatible SAP lock; no post-patch version is calculated here."
          ]
        : [])
    ]
  }
}

function compareUnitTextVersion(
  current: Awaited<ReturnType<typeof readConfigurationUnit>>,
  expected: string,
  unitKey: string,
  ready: boolean
) {
  const snapshot = current.apiSnapshot
  const parsed = z
    .object({
      status: z.literal("read"),
      code: z.literal("READ"),
      readOnly: z.literal(true),
      executable: z.literal(false),
      saveAvailable: z.literal(false),
      functionName: z.literal("Z_ORVANTA_CFG_UNIT_READ"),
      textVersion: z.string().regex(/^[a-f0-9]{64}$/),
      versionScope: z.literal("SAP_GR2_200_full_T006A_row_v1"),
      versionOrigin: z.literal("sap_sha256_fixed_width_utf8"),
      data: z
        .object(
          Object.fromEntries(
            configurationUnitFields.T006A.map((field, i) => [
              field,
              z
                .string()
                .max([3, 1, 3, 3, 6, 10, 30][i]!)
                .refine((v) => !/\p{Cc}/u.test(v))
            ])
          )
        )
        .strict()
    })
    .safeParse(snapshot)
  let status = "blocked",
    code = "API_SNAPSHOT_UNVERIFIED",
    textVersion: string | null = null
  if (!ready) code = "READ_VERSION_UNVERIFIED"
  else if (parsed.success) {
    const value = parsed.data
    if (
      value.data.MANDT !== "200" ||
      value.data.SPRAS !== current.text.sapLanguage ||
      value.data.MSEHI!.trimEnd() !== unitKey ||
      configurationUnitFields.T006A.some(
        (field) => value.data[field]!.trim() !== current.text.data?.[field]
      )
    )
      code = "API_PROJECTION_CHANGED"
    else if (value.textVersion !== expected) {
      status = "changed"
      code = "TEXT_VERSION_CHANGED"
    } else {
      status = "match"
      code = "TEXT_VERSION_MATCH"
      textVersion = value.textVersion
    }
  } else if (snapshot && snapshot.status !== "read") code = snapshot.code
  return {
    status,
    code,
    textVersion,
    readOnly: true,
    executable: false,
    saveAvailable: false,
    versionScope: "SAP_GR2_200_full_T006A_row_v1",
    versionOrigin: "sap_sha256_fixed_width_utf8",
    lockedComparisonVerified: false,
    snapshot: false
  }
}
export const configurationUnitFields = {
  T006: [
    "MANDT",
    "MSEHI",
    "KZEX3",
    "KZEX6",
    "ANDEC",
    "KZKEH",
    "KZWOB",
    "KZ1EH",
    "KZ2EH",
    "DIMID",
    "ZAEHL",
    "NENNR",
    "EXP10",
    "ADDKO",
    "EXPON",
    "DECAN",
    "ISOCODE",
    "PRIMARY",
    "TEMP_UNIT",
    "FAMUNIT",
    "PRESS_UNIT"
  ],
  T006A: ["MANDT", "SPRAS", "MSEHI", "MSEH3", "MSEH6", "MSEHT", "MSEHL"]
} as const
const omittedFields = ["TEMP_VALUE", "PRESS_VAL"]
const projectionRow = (fields: readonly string[]) =>
  z
    .object(
      Object.fromEntries(
        fields.map((field) => [
          field,
          z
            .string()
            .max(100)
            .refine((v) => v === v.trim() && !/\p{Cc}/u.test(v))
        ])
      )
    )
    .strict()
// Advertise the object shape; the service retains the cross-field rules below.
export const configurationUnitReadInputSchema = configurationUnitSchema.extend({
  includeApiSnapshot: z.boolean().optional(),
  transport: unitTextTransportSchema.optional(),
  textReconciliation: z
    .object({
      baselineReadFingerprint: configurationUnitSchema.shape.expectedReadFingerprint.unwrap(),
      baselineUnit: projectionRow(configurationUnitFields.T006),
      baselineText: projectionRow(configurationUnitFields.T006A),
      patch: unitTextPatchSchema
    })
    .strict()
    .optional()
})
export const configurationUnitReadSchema = configurationUnitReadInputSchema
  .refine(
    (value) => !value.transport || (!!value.textReconciliation && !!value.language),
    "Transport observation requires text reconciliation and explicit language"
  )
  .refine(
    (value) => !value.includeApiSnapshot || !!value.language,
    "API snapshot requires explicit language"
  )

type UnitTextTransportInput = {
  connectionId: string
  requestNumber: string
  taskNumber: string
  unitText: { unitKey: string; language: string }
}

async function observeUnitTextTransport(
  transport: z.infer<typeof unitTextTransportSchema>,
  input: z.infer<typeof configurationUnitSchema>,
  current: Awaited<ReturnType<typeof readConfigurationUnitProjection>>,
  ready: boolean,
  readTransport?: (input: UnitTextTransportInput) => Promise<unknown>
) {
  let status = ready ? "unavailable" : "not_performed",
    code: string | null = null,
    inspection: unknown = null,
    versionMatches: boolean | null = null,
    invocations = 0
  if (ready && readTransport) {
    try {
      invocations++
      const response = await readTransport({
        connectionId: input.connectionId,
        ...transport,
        unitText: { unitKey: input.unitKey, language: input.language! }
      })
      const parsed = z
        .object({
          connectionId: z.literal("w200"),
          client: z.literal("200"),
          requestNumber: z.literal(transport.requestNumber),
          taskNumber: z.literal(transport.taskNumber),
          status: z.enum(["metadata_matches", "unavailable", "changed", "rejected", "unknown"]),
          readOnly: z.literal(true),
          saveAvailable: z.literal(false),
          writeAdmission: z.literal("blocked"),
          keyRecording: z.object({
            status: z.enum([
              "table_entries_observed",
              "no_table_entries",
              "master_mismatch",
              "master_unresolved",
              "blocked",
              "unavailable",
              "changed",
              "truncated"
            ]),
            code: z.string().nullable(),
            officialEncoding: z.literal("not_verified"),
            exactRowRecording: z.literal("not_verified"),
            importStatus: z.literal("not_checked"),
            target: z.object({
              client: z.literal("200"),
              unitKey: z.literal(input.unitKey),
              language: z.literal(input.language!),
              sapLanguage: z.string().nullable()
            }),
            unitReadFingerprint: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .nullable(),
            readFingerprint: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .nullable(),
            observed: z.record(z.array(z.record(z.string()))).nullable()
          })
        })
        .safeParse(response)
      if (!parsed.success) throw Error("CONFIGURATION_UNIT_CTS_RESPONSE_INVALID")
      const result = parsed.data,
        keys = result.keyRecording
      if (
        [
          "table_entries_observed",
          "no_table_entries",
          "master_mismatch",
          "master_unresolved"
        ].includes(keys.status) &&
        (!keys.observed || !keys.readFingerprint || !keys.unitReadFingerprint)
      )
        throw Error("CONFIGURATION_UNIT_CTS_RESPONSE_INVALID")
      versionMatches =
        keys.unitReadFingerprint === null
          ? null
          : keys.unitReadFingerprint === current.readFingerprint &&
            keys.target.sapLanguage === current.text.sapLanguage
      if (keys.code === "CONFIGURATION_CTS_UNIT_CHANGED") versionMatches = false
      status =
        versionMatches === false
          ? "changed"
          : result.status !== "metadata_matches"
            ? "blocked"
            : [
                  "table_entries_observed",
                  "no_table_entries",
                  "master_mismatch",
                  "master_unresolved"
                ].includes(keys.status) && versionMatches === true
              ? "observed"
              : keys.status
      code = keys.code
      // Never combine evidence from two different unit versions.
      if (versionMatches !== false) inspection = response
    } catch (error) {
      code =
        error instanceof Error && error.message === "CONFIGURATION_UNIT_CTS_RESPONSE_INVALID"
          ? error.message
          : "CONFIGURATION_UNIT_CTS_UNAVAILABLE"
    }
  }
  return {
    status,
    code,
    readOnly: true,
    executable: false,
    complete: false,
    exactRowRecording: "not_verified",
    importStatus: "not_checked",
    versionMatches,
    inspection,
    evidence: {
      transportReaderInvocations: invocations,
      transportReaderInvocationLimit: 1,
      snapshot: false
    }
  }
}

function unitProjectionFingerprint(
  input: z.infer<typeof configurationUnitSchema>,
  client: string,
  language: string,
  sapLanguage: string | undefined,
  layouts: typeof configurationUnitLayouts | typeof configurationUnitComparisonLayouts.w300,
  unit: Record<string, string>[],
  text: Record<string, string>[]
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        connectionId: input.connectionId,
        client,
        unitKey: input.unitKey,
        language,
        sapLanguage,
        layouts,
        fields: configurationUnitFields,
        representation: "sap_text_trimmed",
        unit: unit.map((row) =>
          Object.fromEntries(configurationUnitFields.T006.map((field) => [field, row[field]]))
        ),
        text: text.map((row) =>
          Object.fromEntries(configurationUnitFields.T006A.map((field) => [field, row[field]]))
        )
      })
    )
    .digest("hex")
}

function reconcileUnitText(
  baseline: NonNullable<z.infer<typeof configurationUnitReadSchema>["textReconciliation"]>,
  current: Awaited<ReturnType<typeof readConfigurationUnitProjection>>
) {
  const scopeMatches = current.text.sapLanguage === baseline.baselineText.SPRAS,
    available =
      scopeMatches &&
      current.unit.status === "read" &&
      current.text.status === "read" &&
      current.evidence.valuesRechecked &&
      current.readFingerprint !== null
  const changes = available
    ? Object.entries(configurationUnitFields).flatMap(([table, fields]) => {
        const before = table === "T006" ? baseline.baselineUnit : baseline.baselineText,
          actual = table === "T006" ? current.unit.data! : current.text.data!
        return fields
          .map((field) => {
            const proposed =
                table === "T006A"
                  ? baseline.patch[field as keyof typeof baseline.patch]
                  : undefined,
              expected = proposed ?? before[field]!,
              value = actual[field]!,
              original = before[field]!
            return {
              table,
              field,
              before: original,
              expected,
              actual: value,
              result:
                value === expected
                  ? expected === original
                    ? "unchanged"
                    : "matches_proposal"
                  : value === original && expected !== original
                    ? "pending"
                    : "unexpected"
            }
          })
          .filter((field) => field.expected !== field.before || field.actual !== field.before)
      })
    : null
  const unexpected = changes?.filter((field) => field.result === "unexpected") ?? [],
    pending = changes?.filter((field) => field.result === "pending") ?? [],
    intended = changes?.filter((field) => field.expected !== field.before) ?? []
  return {
    status: !available
      ? current.status === "changed"
        ? "changed_during_read"
        : current.unit.status === "unavailable" || current.text.status === "unavailable"
          ? "unavailable"
          : !scopeMatches
            ? "target_mismatch"
            : "not_found"
      : unexpected.length
        ? "unexpected_changes"
        : !intended.length
          ? "no_changes"
          : pending.length === intended.length
            ? "unchanged"
            : pending.length
              ? "partial"
              : "values_match",
    readOnly: true,
    executable: false,
    complete: false,
    maintenanceSucceeded: "not_attested",
    baselineOrigin: "caller_supplied_untrusted",
    baselineFingerprintConsistency: true,
    baselineReadFingerprint: baseline.baselineReadFingerprint,
    currentReadFingerprint: current.readFingerprint,
    changes,
    coverage: {
      includedFields: configurationUnitFields,
      omittedFields: { T006: omittedFields, T006A: [] },
      otherLanguages: "not_read",
      snapshot: false
    },
    cts: {
      status: "not_verified",
      exactRowRecording: "not_verified",
      importStatus: "not_checked",
      metadataTool: "inspect_configuration_transport"
    },
    warnings: [
      "Caller baseline is checked for fingerprint consistency, not historical SAP provenance or approval. Values match only this trimmed projection and one language; FLTP fields, other languages, business effects, permissions and locks remain unverified.",
      "Request/task metadata alone does not establish this row's key recording or target import; no caller CTS claim is accepted and no transport operation is performed."
    ]
  }
}
const codeOf = (error: unknown) =>
  error instanceof Error && /^CONFIGURATION_UNIT_[A-Z_]+$/.test(error.message)
    ? error.message
    : "CONFIGURATION_UNIT_QUERY_FAILED"

export async function readConfigurationUnit(
  raw: unknown,
  client: string,
  defaultLanguage: string,
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  readTable: (name: string) => Promise<unknown>,
  readElement: (name: string) => Promise<unknown>,
  readDomain: (name: string) => Promise<unknown>,
  readFunction: (name: string) => Promise<unknown>,
  readTransport?: (input: UnitTextTransportInput) => Promise<unknown>,
  readApiSnapshot?: (input: {
    unitKey: string
    sapLanguage: string
  }) => Promise<
    Awaited<
      ReturnType<typeof import("./configuration-unit-api.js").readConfigurationUnitApiSnapshot>
    >
  >
) {
  const { textReconciliation, transport, includeApiSnapshot, ...input } =
    configurationUnitReadSchema.parse(raw)
  if (input.connectionId !== "w200" || client !== "200")
    throw new Error("CONFIGURATION_UNIT_SCOPE_UNSUPPORTED")
  if (textReconciliation) {
    if (
      !input.language ||
      input.expectedReadFingerprint !== undefined ||
      textReconciliation.baselineUnit.MANDT !== client ||
      textReconciliation.baselineText.MANDT !== client ||
      textReconciliation.baselineUnit.MSEHI !== input.unitKey ||
      textReconciliation.baselineText.MSEHI !== input.unitKey ||
      !/^[A-Za-z0-9]$/.test(textReconciliation.baselineText.SPRAS!) ||
      unitProjectionFingerprint(
        input,
        client,
        input.language,
        textReconciliation.baselineText.SPRAS,
        configurationUnitLayouts,
        [textReconciliation.baselineUnit],
        [textReconciliation.baselineText]
      ) !== textReconciliation.baselineReadFingerprint
    )
      throw new Error("CONFIGURATION_UNIT_RECONCILIATION_BASELINE_INVALID")
  }
  const current = await readConfigurationUnitProjection(
    input,
    client,
    defaultLanguage,
    backend,
    readTable,
    readElement,
    readDomain,
    readFunction
  )
  const reconciliation = textReconciliation ? reconcileUnitText(textReconciliation, current) : null
  const apiSnapshot = includeApiSnapshot
    ? current.unit.status === "read" &&
      current.text.status === "read" &&
      current.text.sapLanguage &&
      readApiSnapshot
      ? await readApiSnapshot({ unitKey: input.unitKey, sapLanguage: current.text.sapLanguage })
      : {
          status: "blocked",
          code: "API_SNAPSHOT_PREREQUISITE_MISSING",
          readOnly: true,
          executable: false,
          saveAvailable: false,
          data: null,
          textVersion: null
        }
    : null
  if (
    apiSnapshot?.status === "read" &&
    (!apiSnapshot.data ||
      configurationUnitFields.T006A.some(
        (field) => apiSnapshot.data![field]?.trim() !== current.text.data?.[field]
      ))
  ) {
    apiSnapshot.status = "changed"
    apiSnapshot.code = "API_PROJECTION_CHANGED"
    apiSnapshot.data = null
    apiSnapshot.textVersion = null
  }
  if (transport && reconciliation) {
    const cts = await observeUnitTextTransport(
      transport,
      input,
      current,
      reconciliation.changes !== null,
      readTransport
    )
    if (cts.versionMatches === false) {
      reconciliation.status = "changed_during_read"
      reconciliation.changes = null
      if (apiSnapshot) {
        apiSnapshot.status = "changed"
        apiSnapshot.code = "API_PROJECTION_CHANGED"
        apiSnapshot.data = null
        apiSnapshot.textVersion = null
      }
    }
    return {
      ...current,
      ...(includeApiSnapshot ? { apiSnapshot } : {}),
      textReconciliation: { ...reconciliation, cts }
    }
  }
  return {
    ...current,
    ...(includeApiSnapshot ? { apiSnapshot } : {}),
    ...(textReconciliation
      ? { textReconciliation: reconcileUnitText(textReconciliation, current) }
      : {})
  }
}

/** Internal comparison route; each target must match all reviewed metadata before any value read. */
export async function readConfigurationUnitProjection(
  raw: unknown,
  client: string,
  defaultLanguage: string,
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  readTable: (name: string) => Promise<unknown>,
  readElement: (name: string) => Promise<unknown>,
  readDomain: (name: string) => Promise<unknown>,
  readFunction: (name: string) => Promise<unknown>
) {
  const input = configurationUnitSchema.parse(raw)
  if (
    !(
      (input.connectionId === "w200" && client === "200") ||
      (input.connectionId === "w300" && client === "300")
    )
  )
    throw new Error("CONFIGURATION_UNIT_SCOPE_UNSUPPORTED")
  const language = configurationImgDetailLanguage.parse(input.language ?? defaultLanguage)
  const startedAt = new Date().toISOString()
  const layouts = configurationUnitComparisonLayouts[input.connectionId as "w200" | "w300"]
  const verify = async () => {
    for (const [name, fingerprint] of Object.entries(layouts))
      if (
        !z
          .object({
            connectionId: z.literal(input.connectionId),
            objectName: z.literal(name),
            objectKind: z.literal("transparentTable"),
            active: z.literal(true).optional(),
            fingerprint: z.literal(fingerprint)
          })
          .safeParse(await readTable(name)).success
      )
        throw new Error("CONFIGURATION_UNIT_LAYOUT_UNVERIFIED")
    if (
      !z
        .object({
          connectionId: z.literal(input.connectionId),
          objectName: z.literal("MSEHI"),
          objectKind: z.literal("dataElement"),
          active: z.literal(true).optional(),
          fingerprint: z.literal(
            "f0577fd354c1f756fcd69c082c6b7ccafe3970fc736acc3105caf2d2e557e2d2"
          ),
          definition: z.object({ domainName: z.literal("MEINS") })
        })
        .safeParse(await readElement("MSEHI")).success ||
      !z
        .object({
          connectionId: z.literal(input.connectionId),
          objectName: z.literal("MEINS"),
          objectKind: z.literal("domain"),
          active: z.literal(true).optional(),
          fingerprint: z.literal(
            "61bf4adf8f8321410beaee2104e8e99102efe3d9ccebade64e49f8d5a1056373"
          ),
          definition: z.object({
            dataType: z.literal("UNIT"),
            length: z.literal(3),
            lowercase: z.literal(true),
            conversionExit: z.literal("CUNIT")
          })
        })
        .safeParse(await readDomain("MEINS")).success
    )
      throw new Error("CONFIGURATION_UNIT_KEY_METADATA_UNVERIFIED")
  }
  await verify()
  const sources: ReviewedReaderSource[] = [],
    warnings: string[] = []
  const reader = createReviewedTableReader(
    backend,
    input.connectionId,
    () => readFunction("RFC_READ_TABLE"),
    sources,
    warnings
  )
  const read = async (
    table: keyof typeof configurationUnitLayouts,
    fields: readonly string[],
    filters: Record<string, string>
  ) => {
    const rows = await reader({
      table,
      fields,
      filters,
      maximum: 1,
      codePrefix: "CONFIGURATION_UNIT_",
      mapError: codeOf
    })
    return { rows, code: rows === null ? sources.at(-1)!.code! : null }
  }
  const unitFilters = { MANDT: client, MSEHI: input.unitKey }
  const unit = await read("T006", configurationUnitFields.T006, unitFilters)
  const mapping = await read("T002", ["SPRAS", "LAISO"], { LAISO: language })
  const sapLanguage = mapping.rows?.[0]?.SPRAS
  const languageValid = sapLanguage !== undefined && /^[A-Za-z0-9]$/.test(sapLanguage)
  const textFilters = { ...unitFilters, SPRAS: sapLanguage ?? "" }
  const text = languageValid
    ? await read("T006A", configurationUnitFields.T006A, textFilters)
    : { rows: null, code: mapping.code ?? "CONFIGURATION_UNIT_LANGUAGE_NOT_FOUND" }
  // ponytail: two bounded observations, not a database snapshot or a lock; no automatic retry.
  let changed = false,
    recheckUnavailable = false
  for (const [table, fields, filters, original] of [
    ["T006", configurationUnitFields.T006, unitFilters, unit],
    ["T002", ["SPRAS", "LAISO"], { LAISO: language }, mapping],
    ["T006A", configurationUnitFields.T006A, textFilters, text]
  ] as const) {
    if (original.rows === null) continue
    const confirmation = await read(table, fields, filters)
    if (confirmation.rows === null) recheckUnavailable = true
    else if (JSON.stringify(confirmation.rows) !== JSON.stringify(original.rows)) changed = true
  }
  await verify()
  const completeReads = unit.rows !== null && text.rows !== null && !recheckUnavailable && !changed
  const readFingerprint = completeReads
    ? unitProjectionFingerprint(
        input,
        client,
        language,
        sapLanguage,
        layouts,
        unit.rows!,
        text.rows!
      )
    : null
  const stale =
    input.expectedReadFingerprint !== undefined &&
    readFingerprint !== null &&
    input.expectedReadFingerprint !== readFingerprint
  const rejected = changed || recheckUnavailable || stale
  return {
    connectionId: input.connectionId,
    client,
    unitKey: input.unitKey,
    keyFormat: "internal_MSEHI",
    status: recheckUnavailable
      ? "unavailable"
      : rejected
        ? "changed"
        : unit.rows === null
          ? "unavailable"
          : unit.rows.length
            ? "partial"
            : "not_found",
    readOnly: true,
    saveAvailable: false,
    unit: {
      table: "T006",
      status: rejected
        ? "unavailable"
        : unit.rows === null
          ? "unavailable"
          : unit.rows.length
            ? "read"
            : "not_found",
      code: rejected
        ? recheckUnavailable
          ? "CONFIGURATION_UNIT_RECHECK_UNAVAILABLE"
          : "CONFIGURATION_UNIT_CHANGED"
        : unit.code,
      data: rejected ? null : (unit.rows?.[0] ?? null)
    },
    text: {
      table: "T006A",
      status: rejected
        ? "unavailable"
        : text.rows === null
          ? "unavailable"
          : text.rows.length
            ? "read"
            : "not_found",
      code: rejected
        ? recheckUnavailable
          ? "CONFIGURATION_UNIT_RECHECK_UNAVAILABLE"
          : "CONFIGURATION_UNIT_CHANGED"
        : text.code,
      data: rejected ? null : (text.rows?.[0] ?? null),
      requestedLanguage: language,
      sapLanguage: sapLanguage ?? null,
      fallbackUsed: false
    },
    readFingerprint: rejected ? null : readFingerprint,
    comparison:
      input.expectedReadFingerprint === undefined
        ? "not_requested"
        : recheckUnavailable
          ? "unavailable"
          : rejected
            ? "changed"
            : readFingerprint === null
              ? "unavailable"
              : "match",
    coverage: {
      complete: false,
      includedFields: configurationUnitFields,
      omittedFields: { T006: omittedFields, T006A: [] },
      reason:
        "FLTP value decoding is not verified; no binary/numeric lossless snapshot is attested."
    },
    representation: "sap_text_trimmed",
    usableForWritePrecondition: false,
    evidence: {
      startedAt,
      finishedAt: new Date().toISOString(),
      sources,
      warnings,
      definitionFingerprints: layouts,
      definitionsRechecked: true,
      valuesRechecked: completeReads,
      snapshot: false
    },
    warnings: [
      "Internal case-sensitive unit key only; external display units and ISO codes are not converted through CUNIT.",
      `Both value tables are constrained to client ${client}. Missing translation does not mean missing unit; read failures do not mean absence.`,
      "Read fingerprint covers returned text projections and one language only, including observed absence. It is not a complete row version, business validation or CTS/write authorization."
    ]
  }
}
