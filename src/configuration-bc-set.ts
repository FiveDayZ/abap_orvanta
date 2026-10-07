import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import {
  createReviewedTableReader,
  type ReviewedReaderSource,
  type ReviewedRow
} from "./reviewed-table-reader.js"

export const configurationBcSetSchema = z
  .object({
    connectionId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,100}$/)
      .toLowerCase(),
    bcSetId: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9_/]{1,32}$/),
    version: z.enum(["C", "O", "N"]),
    objectName: z.enum(["T006", "T006A", "T006B", "T006C", "T006D"]),
    maxRecords: z.number().int().min(2).max(50).default(50),
    maxValues: z.number().int().min(2).max(100).default(100),
    maxDependencies: z.number().int().min(2).max(32).default(32),
    includeRecordInventory: z.boolean().optional()
  })
  .strict()
export const configurationBcSetLayouts = {
  SCPRATTR: "e71cc9c625de174074c7e3713a400495c6fd199abee368406f1ee86b2d2858dd",
  SCPRRECA: "38d95ebbb9da35412026d146cdf5e412b4aeb19574e85aecb4b13931ba846ad5",
  SCPRVALS: "cb9bbce6821a09c25d775ec1bc46c19a87aa77f6455e44f5760b977f0b6979da",
  SCPRVALL: "e87e898cc060fc1d2d3355a57640a592e16640ab318ae49ba0d7427a33e5991d",
  SCPRPPRL: "4288352732b34bf40017f3813126403187769a4b3e4fc81fc069c1beb429ff11"
} as const
export const configurationBcSetFields = {
  SCPRATTR: [
    "ID",
    "VERSION",
    "MODDATE",
    "MODTIME",
    "TYPE",
    "CATEGORY",
    "CLI_DEP",
    "CLI_CAS",
    "REFTYPE",
    "REFNAME",
    "ORGID",
    "COMPONENT",
    "MINRELEASE",
    "MAXRELEASE",
    "STATE",
    "ACT_INFO"
  ],
  SCPRRECA: [
    "ID",
    "VERSION",
    "TABLENAME",
    "RECNUMBER",
    "OBJECTNAME",
    "OBJECTTYPE",
    "ACTIVITY",
    "CLUSTNAME",
    "UNCOMPLETE",
    "DELETEFLAG",
    "GENREF"
  ],
  SCPRVALS: ["ID", "VERSION", "TABLENAME", "RECNUMBER", "FIELDNAME", "FLAG", "VALUE"],
  SCPRVALL: ["ID", "VERSION", "TABLENAME", "RECNUMBER", "FIELDNAME", "LANGU", "FLAG", "VALUE"],
  SCPRPPRL: ["ID", "VERSION", "SUBPROFILE", "PROF_POSIT"]
} as const
export const configurationBcSetDomains = {
  SCPR_VERS: "068a297860abbd9fd3e778aa20852984483305734c7f72adae6d2bee499f006d",
  SCPR_TYPE: "33c39a8f20cc4691c96d786a7e10b07f00e8fabcc0fca634574817e37122a1ff",
  SCPR_FLAG: "d335fb7b834cde75e553d87ce70d3e5f944a0c158488f1f2664a92f3d28ff464",
  SCPR_CTGRY: "c483a6c2c28c6022feeb379618b158372e4d85e88116915000fd85ded9845f07"
}
// Actual CUNI companion definitions on w200/200; source readability does not enable target writes.
export const configurationBcMaintenanceTables = {
  T006B: {
    fingerprint: "ab70255e75a3137279fe7138aecba6dea563ad9886455ecb6d28534a69bbd286",
    keyFields: ["MANDT", "SPRAS", "MSEH3"],
    role: "commercial_unit_alias"
  },
  T006C: {
    fingerprint: "b0b1f805571a82c34ee6ce4c157e6b4a5dacdfe76ed29da5805e8699ac6b8521",
    keyFields: ["MANDT", "SPRAS", "MSEH6"],
    role: "technical_unit_alias"
  },
  T006D: {
    fingerprint: "b8c3a7317ae77355313a75ff37216a2899338b0b45c4753772810b9815e4b95f",
    keyFields: ["MANDT", "DIMID"],
    role: "measurement_dimension"
  }
} as const
const flagMeaning: Record<string, string> = {
  FIX: "fixed_protected",
  USE: "copy_on_activation",
  KEY: "key_required",
  UKY: "copy_key",
  FKY: "fixed_related_key",
  VAR: "value_required"
}

export const configurationBcSetSearchSchema = configurationBcSetSchema
  .pick({ connectionId: true, version: true, objectName: true, maxRecords: true })
  .strict()

/** Candidates from the approved table projection, not an existence or activation verdict. */
export async function findConfigurationBcSets(
  raw: unknown,
  client: string,
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  readTable: (name: string) => Promise<unknown>,
  readFunction: (name: string) => Promise<unknown>
) {
  const input = configurationBcSetSearchSchema.parse(raw)
  if (input.connectionId !== "w200" || client !== "200") throw Error("BC_SET_SCOPE_UNSUPPORTED")
  const startedAt = new Date().toISOString(),
    sources: ReviewedReaderSource[] = [],
    warnings: string[] = []
  const verify = async () => {
    if (
      !z
        .object({
          connectionId: z.literal("w200"),
          objectName: z.literal("SCPRRECA"),
          objectKind: z.literal("transparentTable"),
          fingerprint: z.literal(configurationBcSetLayouts.SCPRRECA)
        })
        .safeParse(await readTable("SCPRRECA")).success
    )
      throw Error("BC_SET_LAYOUT_UNVERIFIED")
  }
  await verify()
  const reader = createReviewedTableReader(
    backend,
    input.connectionId,
    () => readFunction("RFC_READ_TABLE"),
    sources,
    warnings
  )
  const read = () =>
    reader({
      table: "SCPRRECA",
      fields: ["ID", "VERSION", "TABLENAME", "RECNUMBER"],
      filters: { VERSION: input.version, TABLENAME: input.objectName },
      maximum: input.maxRecords,
      codePrefix: "BC_SET_",
      mapError: () => "BC_SET_QUERY_FAILED",
      validate: (rows) => {
        const keys = new Set<string>()
        for (const row of rows) {
          const key = JSON.stringify([row.ID, row.RECNUMBER])
          if (!/^[A-Z0-9_/]{1,32}$/.test(row.ID!) || !row.RECNUMBER || keys.has(key))
            throw Error("BC_SET_CANDIDATE_INVALID")
          keys.add(key)
        }
      }
    })
  const first = await read(),
    confirmation = first === null ? null : await read()
  await verify()
  const canonical = (rows: ReviewedRow[]) => rows.map((r) => JSON.stringify(r)).sort()
  const truncated = sources.some((s) => s.status === "truncated")
  const unavailable = first === null || confirmation === null
  const changed =
    !unavailable && JSON.stringify(canonical(first)) !== JSON.stringify(canonical(confirmation))
  const candidates =
    unavailable || changed ? null : [...new Set(first.map((row) => row.ID!))].sort()
  return {
    ...input,
    client,
    status: unavailable
      ? "unavailable"
      : changed
        ? "changed"
        : truncated
          ? "partial"
          : candidates?.length
            ? "candidates"
            : "no_selected_records",
    candidates,
    readOnly: true,
    saveAvailable: false,
    activationAvailable: false,
    readFingerprint:
      unavailable || changed || truncated
        ? null
        : createHash("sha256")
            .update(JSON.stringify({ input, rows: canonical(first) }))
            .digest("hex"),
    coverage: {
      complete: false,
      selectedTableOnly: true,
      storage: "classic_SCPRRECA",
      truncated,
      headersVerified: false,
      activationVerified: false,
      stablePagination: false
    },
    evidence: {
      startedAt,
      finishedAt: new Date().toISOString(),
      sources,
      warnings,
      definitionsRechecked: true,
      snapshot: false
    },
    warnings: [
      "IDs are candidates from bounded classic record metadata only. Read each exact BC Set header/content separately; no switch storage, recursive dependencies, key reconstruction or activation is covered. Empty results concern this table/version only."
    ]
  }
}

export async function readConfigurationBcSet(
  raw: unknown,
  client: string,
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  readTable: (name: string) => Promise<unknown>,
  readDomain: (name: string) => Promise<unknown>,
  readFunction: (name: string) => Promise<unknown>
) {
  const input = configurationBcSetSchema.parse(raw)
  if (input.connectionId !== "w200" || client !== "200") throw new Error("BC_SET_SCOPE_UNSUPPORTED")
  const startedAt = new Date().toISOString()
  const maintenanceTable =
    input.objectName in configurationBcMaintenanceTables
      ? configurationBcMaintenanceTables[
          input.objectName as keyof typeof configurationBcMaintenanceTables
        ]
      : null
  const verify = async () => {
    if (maintenanceTable) {
      const parsed = z
        .object({
          connectionId: z.literal("w200"),
          objectName: z.literal(input.objectName),
          objectKind: z.literal("transparentTable"),
          fingerprint: z.literal(maintenanceTable.fingerprint),
          definition: z.object({
            fields: z.array(z.object({ name: z.string(), key: z.boolean() }))
          })
        })
        .safeParse(await readTable(input.objectName))
      if (
        !parsed.success ||
        JSON.stringify(parsed.data.definition.fields.filter((f) => f.key).map((f) => f.name)) !==
          JSON.stringify(maintenanceTable.keyFields)
      )
        throw Error("BC_SET_MAINTENANCE_LAYOUT_UNVERIFIED")
    }
    for (const [name, fingerprint] of Object.entries(configurationBcSetLayouts)) {
      if (
        !z
          .object({
            connectionId: z.literal("w200"),
            objectName: z.literal(name),
            objectKind: z.literal("transparentTable"),
            fingerprint: z.literal(fingerprint),
            active: z.literal(true).optional()
          })
          .safeParse(await readTable(name)).success
      )
        throw new Error("BC_SET_LAYOUT_UNVERIFIED")
    }
    for (const [name, fingerprint] of Object.entries(configurationBcSetDomains)) {
      if (
        !z
          .object({
            connectionId: z.literal("w200"),
            objectName: z.literal(name),
            objectKind: z.literal("domain"),
            fingerprint: z.literal(fingerprint),
            active: z.literal(true).optional()
          })
          .safeParse(await readDomain(name)).success
      )
        throw new Error("BC_SET_DOMAIN_UNVERIFIED")
    }
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
  const base = { ID: input.bcSetId, VERSION: input.version }
  const scope = { ...base, TABLENAME: input.objectName }
  const read = (
    table: keyof typeof configurationBcSetLayouts,
    filters: Record<string, string>,
    maximum: number
  ) =>
    reader({
      table,
      fields: configurationBcSetFields[table],
      filters,
      maximum,
      filterLengthLimit: 32,
      codePrefix: "BC_SET_",
      mapError: (error) =>
        error instanceof Error && /^BC_SET_[A-Z_]+$/.test(error.message)
          ? error.message
          : "BC_SET_QUERY_FAILED",
      validate: (rows) => {
        const keys = new Set<string>()
        for (const row of rows) {
          const key =
            table === "SCPRATTR"
              ? row.ID!
              : table === "SCPRPPRL"
                ? row.SUBPROFILE!
                : table === "SCPRRECA"
                  ? JSON.stringify([row.TABLENAME, row.RECNUMBER])
                  : JSON.stringify([row.RECNUMBER, row.FIELDNAME, row.LANGU ?? ""])
          if (keys.has(key)) throw new Error("BC_SET_DUPLICATE_KEY")
          keys.add(key)
        }
      }
    })
  const header = await read("SCPRATTR", base, 1)
  // Switch BC Sets use SCPRS* storage; never classify an empty classic-table read as their content.
  const classic = header?.[0]?.CATEGORY === ""
  const records = classic ? await read("SCPRRECA", scope, input.maxRecords) : null
  // Whole-set record metadata identifies maintenance scope without reading other tables' values.
  const inventory =
    classic && input.includeRecordInventory ? await read("SCPRRECA", base, input.maxRecords) : null
  const values = classic ? await read("SCPRVALS", scope, input.maxValues) : null
  const languageValues = classic ? await read("SCPRVALL", scope, input.maxValues) : null
  const dependencies = header?.length ? await read("SCPRPPRL", base, input.maxDependencies) : null
  const initiallyTruncated = sources.some((s) => s.status === "truncated")
  const canonical = (rows: ReviewedRow[]) =>
    rows.sort((a, b) => {
      const x = JSON.stringify(a),
        y = JSON.stringify(b)
      return x < y ? -1 : x > y ? 1 : 0
    })
  let changed = false,
    recheckUnavailable = false
  for (const [table, filters, maximum, rows] of [
    ["SCPRATTR", base, 1, header],
    ["SCPRRECA", scope, input.maxRecords, records],
    ["SCPRRECA", base, input.maxRecords, inventory],
    ["SCPRVALS", scope, input.maxValues, values],
    ["SCPRVALL", scope, input.maxValues, languageValues],
    ["SCPRPPRL", base, input.maxDependencies, dependencies]
  ] as const) {
    if (rows === null || initiallyTruncated) continue
    const confirmation = await read(table, filters, maximum)
    if (confirmation === null) recheckUnavailable = true
    else if (JSON.stringify(canonical(rows)) !== JSON.stringify(canonical(confirmation)))
      changed = true
  }
  await verify()
  const truncated = sources.some((s) => s.status === "truncated")
  if (input.includeRecordInventory && classic && inventory === null) recheckUnavailable = true
  if (inventory !== null && records !== null && !truncated) {
    if (
      inventory.some((row) => !row.TABLENAME || !row.RECNUMBER) ||
      JSON.stringify(canonical(inventory.filter((row) => row.TABLENAME === input.objectName))) !==
        JSON.stringify(canonical(records))
    )
      changed = true
  }
  const rejected = changed || recheckUnavailable
  const inventoryComplete = inventory !== null && !rejected && !truncated
  const inventoryFingerprint = inventoryComplete
    ? createHash("sha256")
        .update(JSON.stringify({ base, header, records: canonical(inventory) }))
        .digest("hex")
    : null
  const projectedValues =
    rejected || values === null
      ? null
      : values.map<ReviewedRow>((value) => ({
          ...value,
          flagMeaning: flagMeaning[value.FLAG!] ?? "unknown"
        }))
  const projectedLanguageValues =
    rejected || languageValues === null
      ? null
      : languageValues.map<ReviewedRow>((value) => ({
          ...value,
          flagMeaning: flagMeaning[value.FLAG!] ?? "unknown"
        }))
  return {
    connectionId: input.connectionId,
    client,
    bcSetId: input.bcSetId,
    version: input.version,
    objectName: input.objectName,
    maintenanceTable: maintenanceTable
      ? {
          tableName: input.objectName,
          ...maintenanceTable,
          targetReadAvailable: false,
          targetWriteAvailable: false,
          keyReconstruction: "not_performed"
        }
      : null,
    status:
      recheckUnavailable || header === null
        ? "unavailable"
        : changed
          ? "changed"
          : header.length === 0
            ? "not_found"
            : !classic
              ? "unsupported_category"
              : "partial",
    readOnly: true,
    activationAvailable: false,
    saveAvailable: false,
    header: rejected ? null : (header?.[0] ?? null),
    records: rejected ? null : records,
    values: projectedValues,
    languageValues: projectedLanguageValues,
    dependencies: rejected ? null : dependencies,
    recordInventory: input.includeRecordInventory
      ? {
          status: rejected
            ? changed
              ? "changed"
              : "unavailable"
            : inventory === null
              ? "unavailable_or_not_applicable"
              : truncated
                ? "partial"
                : "read",
          complete: inventoryComplete,
          fingerprint: inventoryFingerprint,
          records: rejected ? null : inventory,
          tableNames:
            rejected || inventory === null
              ? null
              : [...new Set(inventory.map((row) => row.TABLENAME!))].sort(),
          unsupportedTableNames:
            rejected || inventory === null
              ? null
              : [...new Set(inventory.map((row) => row.TABLENAME!))]
                  .filter((name) => name !== "T006" && name !== "T006A")
                  .sort(),
          maintenanceObjects:
            rejected || inventory === null
              ? null
              : [
                  ...new Set(
                    inventory.map((row) =>
                      JSON.stringify([row.OBJECTNAME, row.OBJECTTYPE, row.ACTIVITY, row.CLUSTNAME])
                    )
                  )
                ]
                  .sort()
                  .map((key) => {
                    const [objectName, objectType, activity, clusterName] = JSON.parse(
                      key
                    ) as string[]
                    return { objectName, objectType, activity, clusterName }
                  }),
          valueCoverage: "selected_table_only",
          snapshot: false
        }
      : null,
    readFingerprint:
      !rejected &&
      !truncated &&
      header !== null &&
      records !== null &&
      values !== null &&
      languageValues !== null &&
      dependencies !== null
        ? createHash("sha256")
            .update(
              JSON.stringify({
                input: Object.fromEntries(
                  Object.entries(input).filter(([key]) => key !== "includeRecordInventory")
                ),
                header,
                records: canonical(records),
                values: canonical(values),
                languageValues: canonical(languageValues),
                dependencies: canonical(dependencies)
              })
            )
            .digest("hex")
        : null,
    coverage: {
      complete: false,
      selectedTableOnly: true,
      wholeSetRecordInventory: input.includeRecordInventory
        ? inventoryComplete
          ? "read_rechecked"
          : "incomplete"
        : "not_requested",
      truncated,
      records: records === null ? "unavailable_or_not_requested" : "read",
      values: values === null ? "unavailable_or_not_requested" : "read",
      languageValues:
        languageValues === null ? "unavailable_or_not_requested" : "read_all_stored_languages",
      languageOverlayApplied: false,
      recordNumberIsBusinessKey: false,
      keyReconstruction: "not_performed",
      valueEncoding: "BC_Set_field_text_not_a_DDIC_internal_row",
      category: classic ? "classic" : "unsupported_or_absent",
      dependencies:
        dependencies === null ? "unavailable_or_not_requested" : "direct_references_only",
      activationLogs: "not_read",
      targetValueComparison: "not_performed",
      unknownFlags: projectedValues?.filter((v) => v.flagMeaning === "unknown").length ?? null,
      unknownLanguageFlags:
        projectedLanguageValues?.filter((v) => v.flagMeaning === "unknown").length ?? null
    },
    evidence: {
      startedAt,
      finishedAt: new Date().toISOString(),
      sources,
      warnings,
      definitionsRechecked: true,
      snapshot: false
    },
    warnings: [
      "Only the exact BC Set/version and selected T006/T006A/T006B/T006C/T006D source projection are read. Companion definitions and keys are pinned, not reconstructed into activation keys. Their target configuration values are not queried. Direct SCPRPPRL child references are bounded; transitive children, other tables, generated content and activation logs are not covered.",
      "Optional record inventory reads bounded SCPRRECA metadata for all tables in this exact classic set/version, limited by maxRecords across the whole set. It is rechecked and fingerprinted separately. Complete record metadata does not imply complete values, resolved keys, child-set coverage, maintenance APIs or activation approval; other tables' configuration values are never queried.",
      "FLAGS are described from reviewed DDIC, not applied. Version C/O/N is explicit; no assumption about a GUI activation state. Values are trimmed source text, not a complete/lossless target snapshot.",
      "SCPRVALL language rows are separate evidence, not merged over SCPRVALS. RECNUMBER groups BC Set fields; it is not the target business key. Generic/delete records, value conversion, language overlay/version rules and target-value comparison are not interpreted. Switch BC Set storage is unsupported.",
      "No activation API, arbitrary target-table query, configuration write, CTS recording or number allocation is called."
    ]
  }
}
