import { createHash } from "node:crypto"
import { z } from "zod"
import {
  configurationNumberRangeSchema,
  type readConfigurationNumberRange
} from "./configuration-number-range.js"

export const configurationNumberRangePreviewSchema = configurationNumberRangeSchema
  .omit({ intervalNumber: true })
  .extend({
    year: z
      .string()
      .regex(/^\d{4}$/)
      .optional(),
    yearScope: z.literal("all").optional(),
    changes: z
      .array(
        z
          .object({
            action: z.enum(["create", "update"]),
            intervalNumber: z.string().regex(/^[A-Z0-9]{2}$/),
            year: z
              .string()
              .regex(/^\d{4}$/)
              .optional(),
            fromNumber: z.string().regex(/^\d{1,20}$/),
            toNumber: z.string().regex(/^\d{1,20}$/),
            external: z.boolean()
          })
          .strict()
      )
      .min(1)
      .max(20)
  })
  .strict()

export const numberRangePreviewDomains = {
  CHAR4: {
    fingerprint: "44852674cde08d5687a21edfa8e2240cbb8bfd8a3a7ccf7201bce4eb3f962dff",
    dataType: "CHAR",
    length: 4
  },
  CHAR20: {
    fingerprint: "c519e280a5435dfc73245e438c946c45dcf92472d923056c55025ab1a12aa846",
    dataType: "CHAR",
    length: 20
  },
  NUMC20: {
    fingerprint: "ede35c77ca5120310e371bbaa1c122ad4fc55e73326a987b31a55cb9841ce405",
    dataType: "NUMC",
    length: 20
  }
} as const
export const numberRangePreviewFunction = {
  functionName: "NUMBER_RANGE_INTERVAL_UPDATE",
  remoteEnabled: false,
  updateTask: false,
  sourceFingerprint: "e8e8b7acdf0a59001b8690cc2352024fd1c67964cf77d1de225c998f7ff1a9b6",
  interfaceFingerprint: "9d8b4aceb3a4c1e2f1ec62f9b95ef3207ebd37c13e3703c24a8f732e7000074e"
} as const
type Observation = Awaited<ReturnType<typeof readConfigurationNumberRange>>
type Finding = {
  severity: "error" | "risk"
  code: string
  intervalNumber: string
  relatedIntervalNumber?: string
  year?: string
  relatedYear?: string
}

/** Read-only numeric projection. The standard checking API also mutates session state. */
export async function previewConfigurationNumberRange(
  raw: unknown,
  client: string,
  read: (
    input: z.infer<typeof configurationNumberRangeSchema>,
    allYears?: boolean
  ) => Promise<Observation>,
  readDomain: (name: string) => Promise<unknown>,
  readFunction: (name: string) => Promise<unknown>
) {
  const input = configurationNumberRangePreviewSchema.parse(raw)
  if (input.connectionId !== "w200" || client !== "200")
    throw Error("NUMBER_RANGE_PREFLIGHT_SCOPE_UNSUPPORTED")
  const allYears = input.yearScope === "all"
  if (
    allYears
      ? input.year !== undefined || input.changes.some((c) => !c.year || c.year <= "1900")
      : input.year === undefined || input.changes.some((c) => c.year !== undefined)
  )
    throw Error("NUMBER_RANGE_PREFLIGHT_YEAR_SCOPE_INVALID")
  const key = (number: string, year?: string) =>
    allYears ? JSON.stringify([number, year]) : number
  if (
    new Set(input.changes.map((c) => key(c.intervalNumber, c.year))).size !== input.changes.length
  )
    throw Error("NUMBER_RANGE_PREFLIGHT_DUPLICATE_CHANGE")
  const startedAt = new Date().toISOString()
  const { changes, yearScope: _yearScope, ...selection } = input
  const readInput = { ...selection, year: selection.year ?? "0000" }
  const first = await read(readInput, allYears)
  if (allYears && first.year !== null) throw Error("NUMBER_RANGE_PREFLIGHT_YEAR_FILTERED")
  const properties = first.definition?.properties
  const domainName = properties?.DOMLEN ?? ""
  const reviewed = Object.hasOwn(numberRangePreviewDomains, domainName)
    ? numberRangePreviewDomains[domainName as keyof typeof numberRangePreviewDomains]
    : undefined
  const unsupported: string[] = []
  if (properties) {
    if (allYears && properties.YEARIND !== "X") unsupported.push("ANNUAL_OBJECT_REQUIRED")
    if (!allYears && (properties.YEARIND !== "" || input.year !== "0000"))
      unsupported.push("ANNUAL_INTERVALS_UNREVIEWED")
    if (properties.DTELSOBJ !== "" || input.subobject !== "")
      unsupported.push("SUBOBJECT_SEMANTICS_UNREVIEWED")
    if (properties.BUFFER !== "" || !/^0+$/.test(properties.NOIVBUFFER ?? ""))
      unsupported.push("BUFFER_STATE_UNREVIEWED")
    if (
      [
        "NRTAB",
        "NRINTFLD",
        "NREXTFLD",
        "NRFLD",
        "NRSOBJFLD",
        "NRELEFLD",
        "RFCDEST",
        "NRCHECKASCII"
      ].some((k) => properties[k] !== "")
    )
      unsupported.push("GROUP_REMOTE_OR_ASCII_SEMANTICS_UNREVIEWED")
    if (!reviewed) unsupported.push("DOMAIN_UNREVIEWED")
  }
  const usable = (value: Observation) =>
    value.complete && value.readFingerprint !== null && value.intervals !== null
  const verify = async () => {
    if (!reviewed) return
    const domain = z.object({
      connectionId: z.literal("w200"),
      objectKind: z.literal("domain"),
      objectName: z.literal(domainName),
      fingerprint: z.literal(reviewed.fingerprint),
      definition: z.object({
        dataType: z.literal(reviewed.dataType),
        length: z.literal(reviewed.length),
        decimals: z.literal(0),
        conversionExit: z.literal("")
      })
    })
    if (
      !domain.safeParse(await readDomain(domainName)).success ||
      !z
        .object({
          functionName: z.literal(numberRangePreviewFunction.functionName),
          remoteEnabled: z.literal(false),
          updateTask: z.literal(false),
          sourceFingerprint: z.literal(numberRangePreviewFunction.sourceFingerprint),
          interfaceFingerprint: z.literal(numberRangePreviewFunction.interfaceFingerprint)
        })
        .safeParse(await readFunction(numberRangePreviewFunction.functionName)).success
    )
      throw Error("NUMBER_RANGE_PREFLIGHT_METADATA_UNVERIFIED")
  }
  let status =
    first.status === "changed"
      ? "changed"
      : first.definition === null && first.status === "not_found"
        ? "not_found"
        : "unavailable"
  let findings: Finding[] | null = null
  let projected:
    | {
        intervalNumber: string
        fromNumber: string
        toNumber: string
        currentLevel: string
        external: boolean
        year?: string
        effectiveFromYear?: string
        effectiveToYear?: string
      }[]
    | null = null
  let confirmation: Observation | null = null
  let fingerprint: string | null = null
  if (usable(first)) {
    await verify()
    const rows = first.intervals!
    if (
      reviewed &&
      rows.some(
        (r) =>
          !new RegExp(`^\\d{${reviewed.length}}$`).test(r.FROMNUMBER!) ||
          !new RegExp(`^\\d{${reviewed.length}}$`).test(r.TONUMBER!)
      )
    )
      unsupported.push("EXISTING_ENDPOINT_FORMAT_UNREVIEWED")
    if (!unsupported.length) {
      findings = []
      const add = (
        severity: Finding["severity"],
        code: string,
        intervalNumber: string,
        relatedIntervalNumber?: string,
        year?: string,
        relatedYear?: string
      ) =>
        findings!.push({
          severity,
          code,
          intervalNumber,
          ...(relatedIntervalNumber === undefined ? {} : { relatedIntervalNumber }),
          ...(year === undefined ? {} : { year }),
          ...(relatedYear === undefined ? {} : { relatedYear })
        })
      const intervals = new Map(
        rows.map((r) => [
          key(r.NRRANGENR!, r.TOYEAR),
          {
            intervalNumber: r.NRRANGENR!,
            ...(allYears ? { year: r.TOYEAR! } : {}),
            fromNumber: r.FROMNUMBER!,
            toNumber: r.TONUMBER!,
            currentLevel: r.NRLEVEL!,
            external: r.EXTERNIND === "X"
          }
        ])
      )
      for (const change of changes) {
        const old = intervals.get(key(change.intervalNumber, change.year))
        const issue = (severity: Finding["severity"], code: string) =>
          add(severity, code, change.intervalNumber, undefined, change.year)
        if (change.action === "create" && old) {
          issue("error", "INTERVAL_ALREADY_EXISTS")
          continue
        }
        if (change.action === "update" && !old) {
          issue("error", "INTERVAL_NOT_FOUND")
          continue
        }
        if (
          change.fromNumber.length !== reviewed!.length ||
          change.toNumber.length !== reviewed!.length
        ) {
          issue("error", "DOMAIN_LENGTH_MISMATCH")
          continue
        }
        const lower = BigInt(change.fromNumber),
          upper = BigInt(change.toNumber),
          level = BigInt(old?.currentLevel ?? "0")
        if (lower >= upper) issue("error", "LOWER_NOT_LESS_THAN_UPPER")
        if (!change.external && lower === 0n) issue("error", "INTERNAL_LOWER_MUST_BE_POSITIVE")
        if (old && old.fromNumber !== change.fromNumber && level !== 0n)
          issue("error", "LOWER_BOUND_IN_USE")
        if (!change.external && level !== 0n && (level < lower || level > upper))
          issue("error", "CURRENT_LEVEL_OUTSIDE_PROPOSED_INTERVAL")
        if (change.external && level !== 0n) issue("error", "EXTERNAL_REQUIRES_INITIAL_LEVEL")
        if (old && old.external !== change.external) issue("risk", "INTERNAL_EXTERNAL_SWITCH")
        if (old && upper < BigInt(old.toNumber))
          issue(allYears ? "error" : "risk", "UPPER_BOUND_SHRINK")
        intervals.set(key(change.intervalNumber, change.year), {
          intervalNumber: change.intervalNumber,
          ...(allYears ? { year: change.year! } : {}),
          fromNumber: change.fromNumber,
          toNumber: change.toNumber,
          external: change.external,
          currentLevel: old?.currentLevel ?? "00000000000000000000"
        })
      }
      projected = [...intervals.values()].sort(
        (a, b) =>
          a.intervalNumber.localeCompare(b.intervalNumber) ||
          (a.year ?? "").localeCompare(b.year ?? "")
      )
      if (allYears) {
        const previous = new Map<string, number>(),
          oldPrevious = new Map<string, number>(),
          oldStarts = new Map<string, string>()
        for (const row of rows) {
          oldStarts.set(
            key(row.NRRANGENR!, row.TOYEAR),
            String(oldPrevious.get(row.NRRANGENR!) ?? 0).padStart(4, "0")
          )
          oldPrevious.set(row.NRRANGENR!, Number(row.TOYEAR) + 1)
        }
        for (const interval of projected) {
          interval.effectiveFromYear = String(previous.get(interval.intervalNumber) ?? 0).padStart(
            4,
            "0"
          )
          interval.effectiveToYear = interval.year!
          previous.set(interval.intervalNumber, Number(interval.year) + 1)
          const oldStart = oldStarts.get(key(interval.intervalNumber, interval.year))
          if (oldStart !== undefined && oldStart !== interval.effectiveFromYear)
            add(
              BigInt(interval.currentLevel) === 0n ? "risk" : "error",
              "YEAR_COVERAGE_CHANGED",
              interval.intervalNumber,
              undefined,
              interval.year
            )
        }
      }
      for (let i = 0; i < projected.length; i++)
        for (let j = i + 1; j < projected.length; j++) {
          const a = projected[i]!,
            b = projected[j]!
          if (
            (!allYears ||
              (a.intervalNumber !== b.intervalNumber &&
                a.effectiveFromYear! <= b.effectiveToYear! &&
                b.effectiveFromYear! <= a.effectiveToYear!)) &&
            BigInt(a.fromNumber) <= BigInt(b.toNumber) &&
            BigInt(b.fromNumber) <= BigInt(a.toNumber)
          )
            add("error", "INTERVAL_OVERLAP", a.intervalNumber, b.intervalNumber, a.year, b.year)
        }
      status = findings.some((f) => f.severity === "error") ? "blocked" : "partial"
    } else status = "unsupported"
    confirmation = await read(readInput, allYears)
    if (allYears && confirmation.year !== null) throw Error("NUMBER_RANGE_PREFLIGHT_YEAR_FILTERED")
    await verify()
    if (!usable(confirmation) || confirmation.readFingerprint !== first.readFingerprint) {
      status = usable(confirmation) || confirmation.status === "changed" ? "changed" : "unavailable"
      findings = null
      projected = null
    } else if (findings !== null)
      fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            input,
            readFingerprint: first.readFingerprint,
            domainFingerprint: reviewed!.fingerprint,
            source: numberRangePreviewFunction,
            findings,
            projected
          })
        )
        .digest("hex")
  }
  return {
    connectionId: input.connectionId,
    client,
    objectName: input.objectName,
    subobject: input.subobject,
    year: allYears ? null : input.year,
    ...(allYears ? { yearScope: "all" } : {}),
    status,
    readOnly: true,
    saveAvailable: false,
    usableForWritePrecondition: false,
    changes,
    findings,
    projectedIntervals: projected,
    preflightFingerprint: fingerprint,
    readFingerprint: fingerprint === null ? null : first.readFingerprint,
    coverage: {
      complete: false,
      checksComplete: fingerprint !== null,
      domainName,
      domainLength: reviewed?.length ?? null,
      unsupported,
      included: [
        "numeric bounds",
        allYears
          ? "inclusive overlap where effective years intersect"
          : "inclusive overlap across all observed intervals",
        "persisted current level",
        "mode switch risk"
      ],
      omitted: [
        "business usage",
        "locks and atomic snapshot",
        "buffered allocation state",
        allYears
          ? "group/subobject and complete SAP annual-maintenance semantics"
          : "group/subobject and annual semantics",
        "alphanumeric ranges",
        "SAP maintenance authorization and CTS"
      ]
    },
    evidence: {
      startedAt,
      finishedAt: new Date().toISOString(),
      initial: first.evidence,
      confirmation: confirmation?.evidence ?? null,
      definitionsRechecked: fingerprint !== null,
      valuesRechecked: fingerprint !== null,
      snapshot: false
    },
    warnings: [
      "No allocation, maintenance, current-level reset or transport operation. Standard NUMBER_RANGE_INTERVAL_UPDATE source is read only; even its checking path can mutate SAP session state.",
      allYears
        ? "Digit-only, exact domain-width projection for reviewed annual, unbuffered objects without subobjects/groups. Effective years start at 0000 then previous TOYEAR+1 for each interval number. Inserting a year can change an existing range's coverage; nonzero levels block that change. No business-number Number conversion, padding or write authorization."
        : "Digit-only, exact domain-width projection for reviewed nonannual, unbuffered objects without subobjects/groups. No padding or Number conversion. Fingerprints do not attest business safety or authorize writes."
    ]
  }
}
