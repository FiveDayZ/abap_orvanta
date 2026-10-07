import { z } from "zod"
import { configurationBcSetSchema, type readConfigurationBcSet } from "./configuration-bc-set.js"
import { configurationUnitSchema, type readConfigurationUnit } from "./configuration-unit.js"
import type { ReviewedRow } from "./reviewed-table-reader.js"

export const configurationBcSetCompareSchema = configurationBcSetSchema
  .extend({
    objectName: z.enum(["T006", "T006A"]),
    language: configurationUnitSchema.shape.language.unwrap()
  })
  .strict()

// Actual w200 CHAR domains and conversion sources. Numeric, binary and generic keys stay incomparable.
export const configurationBcCompareFields = {
  T006: {
    DIMID: [
      6,
      "DIMID",
      "e92c8f1d68b3f705931204c2590aff578cb5cef0eafd8b770542cb1e4f6c753f",
      "96ff3ecc3847f275842a48e5a96f2acb3ebeb528e237dee5cf52db4e4f66499d"
    ],
    ISOCODE: [
      3,
      "ISOCD_UNIT",
      "87aef4e4f56a89a88f7a25ca3ea685c77d5bd041e93df47f5003fbb31a38a5f6",
      "7b96af017c67df63ee261b7335737bffb201713321968f045eb3b60a317c13d1"
    ]
  },
  T006A: {
    MSEHT: [
      10,
      "TEXT10",
      "be7d7dacd8ffb1f467a3d779f41ff85e0411944bf6fc2fb52415feae6b8e5192",
      "522f03d1733e196552d3886c9363f506a967185a66a4b2537a6bb23130db197b"
    ],
    MSEHL: [
      30,
      "TEXT30",
      "13f25ac06159885981c13d9e7265f68080767717040dd5aca8ba560450f6147b",
      "f24751b3b57d9e6eb6e8aa3de2337743ebe6d208267401899a0a3d8849260d91"
    ],
    MSEH3: [
      3,
      "MSEH3",
      "2a5c3cc924d3822f62a59de36f311e000b33d9a6834b02919853f6b5f0dd0004",
      "a1eb9db58ba1c2f87940b973705f5fd762f6d4d1db80e9ea170621541dd4c5bc"
    ],
    MSEH6: [
      6,
      "MSEH6",
      "c4dbacd597cf8ab78ce5c46c90f99525200bfa6b946220fadb5264fa9a62d9c5",
      "a6418da81aacf886e9e707b65a916b848f850a61460ac09742d8af478aee09ec"
    ]
  }
} as const
export const configurationBcCompareFunctions = {
  SCPR_CPROF_CT_PROFDATA_CONVERT: [
    "58e7119821a8ec1fb3b94f756f2ea6f8705d391d671e92d8951b689981b29123",
    "678844a691d83ea076f1c72c74d62daa7b68846bfe20300c57c7af597f00dfdc"
  ],
  SCPR_CT_VALUE_CONVERT_EXT_INT: [
    "a3a7b851a91d65a8981d7b8e09ce28833f5cc9a9688fbac74e3a2756b65ad525",
    "65db1f2ae9679c8ca4eef66162ba9652f801e5f6963f6957f3d3c0922b88596b"
  ],
  SCPR_CT_VALUE_CONVERT_INT_EXT: [
    "db76d20610890412f3caa9df80316689d3cad88170097087a068e2cb935be8c0",
    "7a61d6cf41159fe5810f10b9ca73daca75ead478e6e578cdb11c8dfe505a5ddf"
  ]
} as const

export async function compareConfigurationBcSet(
  raw: unknown,
  client: string,
  readBcSet: (
    input: z.infer<typeof configurationBcSetSchema>
  ) => ReturnType<typeof readConfigurationBcSet>,
  readUnit: (
    input: z.infer<typeof configurationUnitSchema>
  ) => ReturnType<typeof readConfigurationUnit>,
  readElement: (name: string) => Promise<unknown>,
  readDomain: (name: string) => Promise<unknown>,
  readFunction: (name: string) => Promise<unknown>
) {
  const input = configurationBcSetCompareSchema.parse(raw)
  if (input.connectionId !== "w200" || client !== "200") throw Error("BC_SET_SCOPE_UNSUPPORTED")
  const { language, ...contentInput } = input,
    startedAt = new Date().toISOString()
  const fields = configurationBcCompareFields[input.objectName]
  const verify = async () => {
    for (const [field, [length, domain, elementFingerprint, domainFingerprint]] of Object.entries(
      fields
    )) {
      if (
        !z
          .object({
            connectionId: z.literal("w200"),
            objectName: z.literal(field === "ISOCODE" ? "ISOCD_UNIT" : field),
            objectKind: z.literal("dataElement"),
            fingerprint: z.literal(elementFingerprint),
            definition: z.object({ domainName: z.literal(domain) })
          })
          .safeParse(await readElement(field === "ISOCODE" ? "ISOCD_UNIT" : field)).success ||
        !z
          .object({
            connectionId: z.literal("w200"),
            objectName: z.literal(domain),
            objectKind: z.literal("domain"),
            fingerprint: z.literal(domainFingerprint),
            definition: z.object({
              dataType: z.literal("CHAR"),
              length: z.literal(length),
              conversionExit: z.literal("")
            })
          })
          .safeParse(await readDomain(domain)).success
      )
        throw Error("BC_SET_COMPARISON_FIELD_UNVERIFIED")
    }
    for (const [functionName, [sourceFingerprint, interfaceFingerprint]] of Object.entries(
      configurationBcCompareFunctions
    ))
      if (
        !z
          .object({
            connectionId: z.literal("w200"),
            functionName: z.literal(functionName),
            remoteEnabled: z.literal(false),
            updateTask: z.literal(false),
            sourceFingerprint: z.literal(sourceFingerprint),
            interfaceFingerprint: z.literal(interfaceFingerprint)
          })
          .safeParse(await readFunction(functionName)).success
      )
        throw Error("BC_SET_COMPARISON_CONVERSION_UNVERIFIED")
  }
  await verify()
  type Content = Awaited<ReturnType<typeof readConfigurationBcSet>>
  type Unit = Awaited<ReturnType<typeof readConfigurationUnit>>
  const content = await readBcSet(contentInput)
  const usable = (value: Content) =>
    value.status === "partial" &&
    value.readFingerprint !== null &&
    !value.coverage.truncated &&
    value.records !== null &&
    value.values !== null &&
    value.languageValues !== null
  const rows: {
    recordNumber: string
    key: ReviewedRow | null
    status: string
    code?: string
    fields: {
      field: string
      source: string
      flag: string
      protected: boolean
      expected: string | null
      current: string | null
      status: string
    }[]
  }[] = []
  const observations = new Map<string, Unit | null>()
  const observe = async (unitKey: string) => {
    try {
      return await readUnit({ connectionId: "w200", unitKey, language })
    } catch {
      return null
    }
  }
  const trusted = (value: Unit | null) =>
    value !== null &&
    value.readFingerprint !== null &&
    value.evidence.valuesRechecked &&
    ["read", "not_found"].includes(value.unit.status) &&
    ["read", "not_found"].includes(value.text.status)
  let code: string | null = usable(content) ? null : "BC_SET_CONTENT_INCOMPARABLE"
  if (code === null) {
    const ids = new Set(content.records!.map((r) => r.RECNUMBER))
    if ([...content.values!, ...content.languageValues!].some((v) => !ids.has(v.RECNUMBER)))
      code = "BC_SET_CONTENT_LINKAGE_UNVERIFIED"
  }
  if (code === null)
    for (const record of content.records!) {
      const values = content.values!.filter((v) => v.RECNUMBER === record.RECNUMBER)
      const languageValues = content.languageValues!.filter((v) => v.RECNUMBER === record.RECNUMBER)
      const unit = values.find((v) => v.FIELDNAME === "MSEHI")
      const key =
        unit?.FLAG === "UKY" && !/[*+]/.test(unit.VALUE!)
          ? configurationUnitSchema.shape.unitKey.safeParse(unit.VALUE)
          : null
      if (
        record.UNCOMPLETE ||
        record.DELETEFLAG ||
        record.GENREF ||
        !key?.success ||
        (input.objectName === "T006" && languageValues.length)
      ) {
        rows.push({
          recordNumber: record.RECNUMBER!,
          key: null,
          status: "incomparable",
          code: "BC_SET_RECORD_KEY_UNRESOLVED",
          fields: []
        })
        continue
      }
      if (!observations.has(key.data)) {
        if (observations.size >= 10) {
          rows.push({
            recordNumber: record.RECNUMBER!,
            key: null,
            status: "incomparable",
            code: "BC_SET_TARGET_READ_LIMIT",
            fields: []
          })
          continue
        }
        observations.set(key.data, await observe(key.data))
      }
      const target = observations.get(key.data)!
      if (!trusted(target)) {
        rows.push({
          recordNumber: record.RECNUMBER!,
          key: { MSEHI: key.data },
          status: "incomparable",
          code: "BC_SET_TARGET_UNAVAILABLE",
          fields: []
        })
        continue
      }
      const part = input.objectName === "T006" ? target!.unit : target!.text
      const result: (typeof rows)[number] = {
        recordNumber: record.RECNUMBER!,
        key:
          input.objectName === "T006"
            ? { MANDT: client, MSEHI: key.data }
            : { MANDT: client, MSEHI: key.data, SPRAS: target!.text.sapLanguage! },
        status: "partial",
        fields: []
      }
      const plain = values.filter((v) => !["MANDT", "MSEHI", "SPRAS"].includes(v.FIELDNAME!))
      const selected = languageValues.filter((v) => v.LANGU === target!.text.sapLanguage)
      const names = new Set([...plain, ...languageValues].map((v) => v.FIELDNAME!))
      for (const field of [...names].sort()) {
        const a = plain.find((v) => v.FIELDNAME === field),
          b = selected.find((v) => v.FIELDNAME === field)
        const value = b ?? a
        const pin = (fields as Record<string, readonly [number, string, string, string]>)[field]
        const storedLanguage = values.find((v) => v.FIELDNAME === "SPRAS")
        const languageMatches =
          input.objectName === "T006" ||
          (b !== undefined && a === undefined) ||
          (languageValues.every((v) => v.FIELDNAME !== field) &&
            storedLanguage?.FLAG === "UKY" &&
            storedLanguage.VALUE === target!.text.sapLanguage)
        const comparable =
          value !== undefined &&
          pin !== undefined &&
          ["USE", "FIX"].includes(value.FLAG!) &&
          value.VALUE!.length <= pin[0] &&
          !/\p{Cc}/u.test(value.VALUE!) &&
          languageMatches &&
          !(a && b)
        const current = comparable && part.status === "read" ? (part.data?.[field] ?? null) : null
        result.fields.push({
          field,
          source: b ? "SCPRVALL" : "SCPRVALS",
          flag: value?.FLAG ?? "",
          protected: value?.FLAG === "FIX",
          expected: comparable ? value.VALUE! : null,
          current,
          status: !comparable
            ? "incomparable"
            : part.status === "not_found"
              ? "target_missing"
              : current === null
                ? "incomparable"
                : current === value.VALUE
                  ? "equal_trimmed_value"
                  : "different"
        })
      }
      if (!result.fields.length) result.status = "no_comparable_values"
      rows.push(result)
    }
  let changed = false,
    recheckUnavailable = false
  if (code === null) {
    const confirmation = await readBcSet(contentInput)
    if (!usable(confirmation)) recheckUnavailable = true
    else changed = confirmation.readFingerprint !== content.readFingerprint
    for (const [unitKey, original] of observations) {
      const confirmation = await observe(unitKey)
      if (!trusted(original) || !trusted(confirmation)) recheckUnavailable = true
      else if (confirmation!.readFingerprint !== original!.readFingerprint) changed = true
    }
  }
  await verify()
  if (changed || recheckUnavailable) {
    rows.length = 0
    code = recheckUnavailable
      ? "BC_SET_COMPARISON_RECHECK_UNAVAILABLE"
      : "BC_SET_COMPARISON_CHANGED"
  }
  return {
    connectionId: input.connectionId,
    client,
    bcSetId: input.bcSetId,
    version: input.version,
    objectName: input.objectName,
    language,
    status:
      code !== null
        ? changed && !recheckUnavailable
          ? "changed"
          : "incomparable"
        : content.records!.length
          ? "partial"
          : "no_selected_content",
    code,
    readOnly: true,
    saveAvailable: false,
    activationAvailable: false,
    rows,
    coverage: {
      complete: false,
      selectedTableOnly: true,
      mode: "stored_field_observations_not_activation_projection",
      activationKeyResolved: false,
      languageOverlayApplied: false,
      numericConversion: false,
      targetReads: observations.size,
      targetReadLimit: 10,
      sourceFingerprint: content.readFingerprint
    },
    evidence: {
      startedAt,
      finishedAt: new Date().toISOString(),
      content: content.evidence,
      targets: [...observations].map(([unitKey, result]) => ({
        unitKey,
        readFingerprint: result?.readFingerprint ?? null,
        evidence: result?.evidence ?? null
      })),
      definitionsRechecked: true,
      valuesRechecked: code === null,
      snapshot: false
    },
    warnings: [
      "Only UKY internal MSEHI keys on complete non-delete, non-generic records can select targets. Client 200 is the observation scope, not the stored BC Set client. Variable unit keys remain unresolved.",
      "SCPRVALL LANGU selects stored translation cells for the explicit ISO language; it does not resolve a variable SPRAS activation key. Conflicting ordinary/language values are incomparable; no C/N overlay or activation outcome is inferred.",
      "Only pinned CHAR fields are compared as trimmed SAP text. Numeric/binary values, unknown fields/flags and required variable values stay incomparable. Sequential content/target rechecks are not a transaction snapshot; no activation, write or CTS operation is performed."
    ]
  }
}
