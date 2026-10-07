import { createHash } from "node:crypto"
import { z } from "zod"
import {
  configurationNumberRangeScopeSchema,
  type readConfigurationNumberRange
} from "./configuration-number-range.js"
import { numberRangePreviewFunction } from "./configuration-number-range-preview.js"

export const numberRangeScopeFunctions = {
  NUMBER_RANGE_INTERVAL_LIST: {
    sourceFingerprint: "386f70ac925b210b5c7482d3f78e996855262b35f9d5b41f4711fe8694b09446",
    interfaceFingerprint: "e3a82cbaf19b1cac1b50f94cf70c5e7e6824a71d12458391762ac69ab4376d18"
  },
  NUMBER_RANGE_UPDATE_INIT: {
    sourceFingerprint: "00bf94f36be4746a4c8f302dd3d128fe13a6b74886687ed88fd8239bd1027ad2",
    interfaceFingerprint: "aca1e5ceec2392a0381cd8a614a73295967a21b60d41c77f4a837cf206c95819"
  },
  NUMBER_RANGE_INTERVAL_UPDATE: numberRangePreviewFunction,
  NUMBER_RANGE_UPDATE_CLOSE: {
    sourceFingerprint: "3c9ba76a443a55c34f040c56e1b00c8d900349f781eae629d3ab61a2ba742de3",
    interfaceFingerprint: "648b8d2f7e0817ad510e9d4dd78cf365b9bd586950a63c322b1430413e87bf0f"
  },
  NUMBER_RANGE_ENQUEUE: {
    sourceFingerprint: "0ec0ee7c8fdb99bba06a3c832da5c87502f8ed390ba5ac9f573e1a681c83efce",
    interfaceFingerprint: "cc18e86b79848a19ec23ad72e9f0bec00f4c031ef3cb2f7f974321c7cd83ac1b"
  },
  NUMBER_RANGE_DEQUEUE: {
    sourceFingerprint: "2ba5fa9ab6e39b177b4bba1c84f67602faec6e001c35cbf63c86a4b7ad37c5c9",
    interfaceFingerprint: "aca1e5ceec2392a0381cd8a614a73295967a21b60d41c77f4a837cf206c95819"
  }
} as const
export const numberRangeScopeIncludes = {
  LSNR1F01: "b84ee56a742368caabbe6bb13d1884eca3c5bbce817e8a2f1b4b4f7dd356f534",
  LSNR1F02: "918898b307e45e81c5fc801b98d68d1eb8273c8fa6e0ffd11dab0ee5e7236c2c"
} as const
const identifier = z.string().regex(/^[A-Z][A-Z0-9_]{0,29}$/)
const ddicName = z.string().regex(/^[A-Z0-9_/]{1,30}$/)
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/)
const elementEvidence = (name: string) =>
  z.object({
    connectionId: z.literal("w200"),
    objectName: z.literal(name),
    objectKind: z.literal("dataElement"),
    fingerprint,
    definition: z.object({ domainName: ddicName })
  })
const domainEvidence = (name: string) =>
  z.object({
    connectionId: z.literal("w200"),
    objectName: z.literal(name),
    objectKind: z.literal("domain"),
    fingerprint,
    definition: z.object({
      dataType: z.string(),
      length: z.number().int().min(1),
      conversionExit: z.string(),
      valueTable: z.string()
    })
  })

/** DDIC metadata only: never reads source-table rows or runs the unbounded standard list. */
export async function resolveNumberRangeSubobjectSource(
  domainName: string,
  valueTable: string,
  readTable: (name: string) => Promise<unknown>,
  readElement: (name: string) => Promise<unknown>,
  readDomain: (name: string) => Promise<unknown>
) {
  if (!valueTable) return { status: "no_value_table", table: null }
  if (!ddicName.safeParse(valueTable).success)
    throw Error("NUMBER_RANGE_SUBOBJECT_SOURCE_UNVERIFIED")
  if (!identifier.safeParse(valueTable).success)
    return { status: "unreviewed_value_table", table: null }
  const table = z
    .object({
      connectionId: z.literal("w200"),
      objectName: z.literal(valueTable),
      objectKind: z.literal("transparentTable"),
      fingerprint,
      definition: z.object({
        tableClass: z.literal("TRANSP"),
        fields: z
          .array(
            z.object({
              name: z.string(),
              position: z.number().int().positive(),
              key: z.boolean(),
              dataElement: z.string(),
              componentKind: z.string().optional()
            })
          )
          .min(1)
          .max(512)
      })
    })
    .safeParse(await readTable(valueTable))
  if (!table.success) throw Error("NUMBER_RANGE_SUBOBJECT_SOURCE_UNVERIFIED")
  const keys = table.data.definition.fields
    .filter((f) => f.key)
    .sort((a, b) => a.position - b.position)
  // ponytail: inherited/include and direct-type keys need DFIES evidence before resolving them.
  if (
    keys.some(
      (f) =>
        f.componentKind ||
        !identifier.safeParse(f.name).success ||
        !identifier.safeParse(f.dataElement).success
    ) ||
    new Set(keys.map((f) => f.name)).size !== keys.length ||
    new Set(keys.map((f) => f.position)).size !== keys.length
  )
    return { status: "unreviewed_layout", table: table.data }
  if (keys.length > 16) return { status: "unreviewed_layout", table: table.data }
  const keyMetadata = []
  for (const field of keys) {
    const element = elementEvidence(field.dataElement).parse(await readElement(field.dataElement))
    const domain = domainEvidence(element.definition.domainName).parse(
      await readDomain(element.definition.domainName)
    )
    keyMetadata.push({ field, element, domain })
  }
  const matches = keyMetadata.filter((k) => k.domain.objectName === domainName)
  const clientFields = keyMetadata
    .filter((k) => k.domain.definition.dataType === "CLNT")
    .map((k) => k.field.name)
  return {
    status: matches.length ? "resolved_metadata" : "no_matching_key",
    table: table.data,
    keyMetadata,
    fieldName: matches[0]?.field.name ?? null,
    matchingKeyFields: matches.map((k) => k.field.name),
    clientDependent: clientFields.length > 0,
    clientFields,
    rowUniqueness: "unverified",
    existenceStatus: "unverified",
    semantics:
      "First key field in DDIC position order with the subobject domain. Standard read_subobjects uses implicit-client SELECT * and sorts without deduplication; no table rows read here."
  }
}
type Observation = Awaited<ReturnType<typeof readConfigurationNumberRange>>

/** Exact literal subobject, all years. Standard list/init/check functions are never executed. */
export async function readConfigurationNumberRangeScope(
  raw: unknown,
  client: string,
  read: (input: z.infer<typeof configurationNumberRangeScopeSchema>) => Promise<Observation>,
  readElement: (name: string) => Promise<unknown>,
  readDomain: (name: string) => Promise<unknown>,
  readFunction: (name: string) => Promise<unknown>,
  readInclude: (name: string) => Promise<string>,
  readTable: (name: string) => Promise<unknown>
) {
  const input = configurationNumberRangeScopeSchema.parse(raw)
  if (input.connectionId !== "w200" || client !== "200")
    throw Error("NUMBER_RANGE_SCOPE_UNSUPPORTED")
  const startedAt = new Date().toISOString()
  const verifySources = async () => {
    for (const [functionName, pins] of Object.entries(numberRangeScopeFunctions))
      if (
        !z
          .object({
            functionName: z.literal(functionName),
            remoteEnabled: z.literal(false),
            updateTask: z.literal(false),
            sourceFingerprint: z.literal(pins.sourceFingerprint),
            interfaceFingerprint: z.literal(pins.interfaceFingerprint)
          })
          .safeParse(await readFunction(functionName)).success
      )
        throw Error("NUMBER_RANGE_SCOPE_SOURCE_UNVERIFIED")
    for (const [name, pin] of Object.entries(numberRangeScopeIncludes)) {
      const source = await readInclude(name)
      const header = source.match(
        /^Source from ([A-Z0-9_]+) \(lines 1-(\d+) of (\d+), (\d+) lines retrieved\):/
      )
      if (
        !header ||
        header[1] !== name ||
        header[2] !== header[3] ||
        header[2] !== header[4] ||
        source.match(/Full Source SHA-256: ([a-f0-9]{64})/)?.[1] !== pin ||
        !source.includes(`/functions/groups/snr1/includes/${name.toLowerCase()}/source`)
      )
        throw Error("NUMBER_RANGE_SCOPE_SOURCE_UNVERIFIED")
    }
  }
  await verifySources()
  const first = await read(input)
  if (first.year !== null) throw Error("NUMBER_RANGE_SCOPE_YEAR_FILTERED")
  const elementName = first.definition?.properties.DTELSOBJ ?? ""
  const metadata = async () => {
    if (!elementName) return null
    const element = elementEvidence(elementName).safeParse(await readElement(elementName))
    if (!element.success) throw Error("NUMBER_RANGE_SUBOBJECT_METADATA_UNVERIFIED")
    const domainName = element.data.definition.domainName
    const domain = domainEvidence(domainName).safeParse(await readDomain(domainName))
    if (!domain.success) throw Error("NUMBER_RANGE_SUBOBJECT_METADATA_UNVERIFIED")
    const source = await resolveNumberRangeSubobjectSource(
      domainName,
      domain.data.definition.valueTable,
      readTable,
      readElement,
      readDomain
    )
    return { element: element.data, domain: domain.data, source }
  }
  const initialMetadata = await metadata()
  const usable = (value: Observation) =>
    value.complete && value.intervals !== null && value.readFingerprint !== null
  const confirmation = usable(first) ? await read(input) : null
  if (confirmation !== null && confirmation.year !== null)
    throw Error("NUMBER_RANGE_SCOPE_YEAR_FILTERED")
  const finalMetadata = await metadata()
  await verifySources()
  const metadataChanged = JSON.stringify(initialMetadata) !== JSON.stringify(finalMetadata)
  const changed =
    metadataChanged ||
    first.status === "changed" ||
    confirmation?.status === "changed" ||
    (usable(first) &&
      confirmation !== null &&
      usable(confirmation) &&
      first.readFingerprint !== confirmation.readFingerprint)
  const complete = !changed && usable(first) && confirmation !== null && usable(confirmation)
  const definitionAbsent = first.definition === null && first.status === "not_found"
  const status = changed
    ? "changed"
    : definitionAbsent
      ? "not_found"
      : !complete
        ? "unavailable"
        : first.intervals!.length
          ? "read"
          : "empty"
  const rows = complete ? first.intervals : null
  const annual = first.definition?.properties.YEARIND === "X"
  const previousYear = new Map<string, number>()
  const effectiveIntervals =
    rows?.map((row): Record<string, string> => {
      const from = annual ? (previousYear.get(row.NRRANGENR!) ?? 0) : 0
      previousYear.set(row.NRRANGENR!, Number(row.TOYEAR) + 1)
      return {
        ...row,
        effectiveFromYear: String(from).padStart(4, "0"),
        effectiveToYear: row.TOYEAR!
      }
    }) ?? null
  const subobject = {
    literal: input.subobject,
    requiredByDefinition: elementName !== "",
    metadata: metadataChanged ? null : initialMetadata,
    formatStatus: metadataChanged
      ? "changed"
      : initialMetadata === null
        ? "not_applicable"
        : initialMetadata.domain.definition.length <= 6 &&
            input.subobject.length <= initialMetadata.domain.definition.length &&
            ["CHAR", "NUMC"].includes(initialMetadata.domain.definition.dataType) &&
            initialMetadata.domain.definition.conversionExit === ""
          ? "literal_length_only"
          : "unreviewed",
    existenceStatus: "unverified",
    reason:
      "Pinned get_elemfield/read_subobjects sources resolve the domain value table and first matching key from active DDIC metadata. No source-table rows or conversion exits are executed; metadata resolution does not prove subobject existence."
  }
  const fingerprint = complete
    ? createHash("sha256")
        .update(
          JSON.stringify({
            input,
            readFingerprint: first.readFingerprint,
            metadata: initialMetadata,
            sources: numberRangeScopeFunctions,
            includes: numberRangeScopeIncludes,
            effectiveIntervals
          })
        )
        .digest("hex")
    : null
  return {
    connectionId: input.connectionId,
    client,
    objectName: input.objectName,
    yearScope: "all",
    subobject,
    status,
    readOnly: true,
    saveAvailable: false,
    usableForWritePrecondition: false,
    maintenanceBoundary: {
      status: "blocked",
      saveAvailable: false,
      reviewed: [
        "separate NUMBER_RANGE_ENQUEUE/DEQUEUE wrappers",
        "UPDATE_CLOSE writes NRIV/NRIV_LOKAL/TNRGT and group elements",
        "UPDATE_CLOSE resets/deactivates buffers",
        "caller owns the commit"
      ],
      unverified: [
        "caller authorization",
        "held runtime lock",
        "full dialog/change-document call chain",
        "enhancement metadata (source reader reports unsupported)",
        "CTS recording/transport policy",
        "business usage",
        "atomic failure/rollback and buffer behavior"
      ],
      reason:
        "Non-RFC standard functions use function-group state. Source inspection establishes neither a safe remote maintenance adapter nor permission to execute it."
    },
    annual,
    intervals: rows,
    effectiveIntervals,
    readFingerprint: fingerprint,
    coverage: {
      complete: false,
      intervalProjectionComplete: complete,
      truncated: first.truncated || confirmation?.truncated === true,
      included: [
        "all years for exact literal subobject",
        "persisted NRIV current levels",
        "standard effective year ranges",
        "subobject element/domain/source-key metadata",
        "standard maintenance source boundaries"
      ],
      omitted: [
        "other subobjects",
        "subobject source-table rows/existence validation",
        "buffered numbers",
        "business usage",
        "proposed maintenance",
        "locks and CTS"
      ]
    },
    evidence: {
      startedAt,
      finishedAt: new Date().toISOString(),
      initial: first.evidence,
      confirmation: confirmation?.evidence ?? null,
      sourceFingerprints: numberRangeScopeFunctions,
      includeFingerprints: numberRangeScopeIncludes,
      metadataRechecked: !metadataChanged,
      valuesRechecked: complete,
      snapshot: false
    },
    warnings: [
      "No list/init/update/allocation API execution; empty literal subobject never selects all subobjects. Effective years use previous TOYEAR + 1 within each interval number, with the first range starting at 0000; this is not a number-allocation or maintenance safety verdict.",
      "Incomplete or changing observations discard all interval/year projections. Subobject source resolution reads DDIC metadata only; no generalized table allowlist or maintenance authorization."
    ]
  }
}
