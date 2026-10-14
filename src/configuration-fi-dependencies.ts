import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import { createReviewedTableReader, type ReviewedReaderSource } from "./reviewed-table-reader.js"

export const configurationFiDependencyPins = {
  DD02L: "6f01e8576a5500d0343256d44c3aafdeaff1912eefff03f72db50ac9c770d8cf",
  DD03L: "20be52cf738bc6079c898cf3505f72705030a1ed07bf694a6ce6adfe96cea965",
  GB01: "4de40b9dce1a11ca4c10914f15145dcf4d8f34f95b312606af60024f9cf9bc5e",
  GB01C: "c98df87c13e5ecd0e902547631aeef9ae9cf81cb55b89ce5bc7be15c37a1e832"
} as const
const fieldColumns = [
  "TABNAME",
  "FIELDNAME",
  "AS4LOCAL",
  "AS4VERS",
  "POSITION",
  "ROLLNAME",
  "INTTYPE",
  "INTLEN",
  "DATATYPE",
  "LENG",
  "DECIMALS",
  "DOMNAME",
  "CONROUT",
  "REFTABLE",
  "REFFIELD"
]
const policyColumns = ["BOOLCLASS", "CLASSTYPE", "BCLTAB", "BCLFIELD", "BEXCLUDE"]
export const configurationFiDependencyFields = [
  "BKPF-BUKRS",
  "BKPF-XBLNR",
  "SYST-TCODE",
  "BSEG-HKONT",
  "BSEG-MATNR",
  "BSEG-MENGE",
  "BSEG-PRCTR",
  "BSEG-SGTXT",
  "BSEG-VBEWA"
] as const
const supportedFields = new Set<string>(configurationFiDependencyFields)
const name = z.string().regex(/^[A-Z][A-Z0-9_]{0,29}$/)
const number = z.string().regex(/^\d{1,6}$/)
const fieldSchema = z.object({
  TABNAME: name,
  FIELDNAME: name,
  AS4LOCAL: z.literal("A"),
  AS4VERS: z.literal("0000"),
  POSITION: number,
  ROLLNAME: name,
  INTTYPE: z.enum(["C", "P"]),
  INTLEN: number,
  DATATYPE: z.enum(["CHAR", "QUAN"]),
  LENG: number,
  DECIMALS: number,
  DOMNAME: name,
  CONROUT: z.string().max(10),
  REFTABLE: z.string().max(30),
  REFFIELD: z.string().max(30)
})
const policySchema = z.object({
  BOOLCLASS: z.literal("009"),
  CLASSTYPE: z.enum(["A", "B", "S"]),
  BCLTAB: name,
  BCLFIELD: z.union([name, z.literal("*")]),
  BEXCLUDE: z.enum(["", "X"])
})
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
function fail(suffix: string): never {
  throw Error(`FI_RULE_FORMULA_ANALYSIS_${suffix}`)
}
const codeOf = (error: unknown) =>
  error instanceof Error && /HTTP 401|logon.*failed/i.test(error.message)
    ? "FI_RULE_FORMULA_ANALYSIS_AUTHENTICATION_REJECTED"
    : error instanceof Error && /^FI_RULE_FORMULA_ANALYSIS_[A-Z_]+$/.test(error.message)
      ? error.message
      : "FI_RULE_FORMULA_ANALYSIS_DEPENDENCY_READ_FAILED"

/** Fixed current-rule metadata/policy scope. Never reads BSEG business rows or executes class initialization. */
export async function readConfigurationFiDependencies(
  fields: { table: string; name: string }[],
  booleanClass: string,
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  readers: {
    table(name: string): Promise<unknown>
    dataElement(name: string): Promise<unknown>
    domain(name: string): Promise<unknown>
    function(name: string): Promise<unknown>
  }
) {
  if (
    booleanClass !== "009" ||
    !fields.length ||
    fields.length > 9 ||
    new Set(fields.map((f) => `${f.table}-${f.name}`)).size !== fields.length ||
    fields.some((f) => !supportedFields.has(`${f.table}-${f.name}`))
  )
    fail("DEPENDENCY_SCOPE_UNSUPPORTED")
  const policySelectors = new Map<string, { BCLTAB: string; BCLFIELD: string }>()
  for (const field of fields)
    for (const BCLTAB of field.table === "SYST" ? ["SYST", "SY"] : [field.table])
      for (const BCLFIELD of [field.name, "*"])
        policySelectors.set(`${BCLTAB}-${BCLFIELD}`, { BCLTAB, BCLFIELD })
  const sources: ReviewedReaderSource[] = [],
    warnings: string[] = []
  const definitions = new Map<string, unknown>()
  const attest = async (
    kind: "transparentTable" | "dataElement" | "domain",
    objectName: string
  ) => {
    const reader =
      kind === "transparentTable"
        ? readers.table
        : kind === "dataElement"
          ? readers.dataElement
          : readers.domain
    const result = z
      .object({
        connectionId: z.literal("w200"),
        objectKind: z.literal(kind),
        objectName: z.literal(objectName),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        version: z.string().min(1),
        active: z.literal(true).optional(),
        definition: z.record(z.unknown())
      })
      .safeParse(await reader(objectName))
    if (!result.success || hash(result.data.definition) !== result.data.fingerprint)
      fail("DEPENDENCY_METADATA_CHANGED")
    if (
      kind === "transparentTable" &&
      result.data.fingerprint !==
        configurationFiDependencyPins[objectName as keyof typeof configurationFiDependencyPins]
    )
      fail("DEPENDENCY_METADATA_CHANGED")
    const key = `${kind}:${objectName}`
    if (
      definitions.has(key) &&
      JSON.stringify(definitions.get(key)) !== JSON.stringify(result.data)
    )
      fail("DEPENDENCY_METADATA_CHANGED")
    definitions.set(key, result.data)
    return result.data
  }
  for (const table of Object.keys(configurationFiDependencyPins))
    await attest("transparentTable", table)
  const reader = createReviewedTableReader(
    backend,
    "w200",
    () => readers.function("RFC_READ_TABLE"),
    sources,
    warnings
  )
  const read = async (
    table: string,
    columns: string[],
    filters: Record<string, string>,
    maximum: number
  ) => {
    const rows = await reader({
      table,
      fields: columns,
      filters,
      maximum,
      codePrefix: "FI_RULE_FORMULA_ANALYSIS_",
      mapError: codeOf
    })
    const last = sources.at(-1)!
    if (!rows || last.status === "truncated")
      fail(last.code?.replace("FI_RULE_FORMULA_ANALYSIS_", "") ?? "DEPENDENCY_READ_TRUNCATED")
    return rows
  }
  const observe = async () => {
    const classification = await read(
      "DD02L",
      ["TABNAME", "AS4LOCAL", "AS4VERS", "TABCLASS", "SQLTAB"],
      { TABNAME: "BSEG", AS4LOCAL: "A", AS4VERS: "0000" },
      1
    )
    if (
      classification.length !== 1 ||
      classification[0]!.TABCLASS !== "CLUSTER" ||
      classification[0]!.SQLTAB !== "RFBLG"
    )
      fail("BSEG_CLASSIFICATION_CHANGED")
    const metadata = []
    for (const field of fields) {
      const rows = await read(
        "DD03L",
        fieldColumns,
        {
          TABNAME: field.table,
          FIELDNAME: field.name,
          AS4LOCAL: "A",
          AS4VERS: "0000"
        },
        1
      )
      const parsed = rows.length === 1 ? fieldSchema.safeParse(rows[0]) : null
      if (!parsed?.success) fail("FIELD_METADATA_UNSUPPORTED")
      metadata.push(parsed.data)
    }
    const policies = []
    for (const table of ["GB01", "GB01C"]) {
      const rows: Record<string, string>[] = []
      for (const selector of policySelectors.values())
        rows.push(
          ...(await read(
            table,
            table === "GB01C" ? ["MANDT", ...policyColumns] : policyColumns,
            table === "GB01C"
              ? { MANDT: "200", BOOLCLASS: "009", ...selector }
              : { BOOLCLASS: "009", ...selector },
            3
          ))
        )
      const parsed = z.array(policySchema).safeParse(rows)
      if (!parsed.success) fail("CLASS_POLICY_UNSUPPORTED")
      const keys = parsed.data.map((row) =>
        hash([row.BOOLCLASS, row.CLASSTYPE, row.BCLTAB, row.BCLFIELD])
      )
      if (new Set(keys).size !== keys.length) fail("CLASS_POLICY_AMBIGUOUS")
      policies.push({
        table,
        rows: parsed.data.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      })
    }
    return { classification, metadata, policies }
  }
  const first = await observe()
  const fieldDefinitions = []
  for (const row of first.metadata) {
    const elementKey = `dataElement:${row.ROLLNAME}`,
      domainKey = `domain:${row.DOMNAME}`
    const element = (definitions.get(elementKey) ??
      (await attest("dataElement", row.ROLLNAME))) as { definition: Record<string, unknown> }
    if (element.definition.domainName !== row.DOMNAME) fail("FIELD_TYPE_RELATION_CHANGED")
    const domain = (definitions.get(domainKey) ?? (await attest("domain", row.DOMNAME))) as {
      definition: Record<string, unknown>
    }
    const attributes = z
      .object({
        dataType: z.enum(["CHAR", "QUAN"]),
        length: z.number().int().positive(),
        decimals: z.number().int().nonnegative(),
        conversionExit: z.string().max(10),
        lowercase: z.boolean()
      })
      .safeParse(domain.definition)
    if (
      !attributes.success ||
      attributes.data.dataType !== row.DATATYPE ||
      attributes.data.length !== Number(row.LENG) ||
      attributes.data.decimals !== Number(row.DECIMALS) ||
      Number(row.POSITION) < 1 ||
      Number(row.INTLEN) < 1 ||
      (row.DATATYPE === "CHAR" ? row.INTTYPE !== "C" : row.INTTYPE !== "P") ||
      (row.CONROUT && row.CONROUT !== attributes.data.conversionExit)
    )
      fail("FIELD_TYPE_RELATION_CHANGED")
    fieldDefinitions.push({
      table: row.TABNAME,
      name: row.FIELDNAME,
      status: "ddic_field_observed",
      dataElement: row.ROLLNAME,
      domain: row.DOMNAME,
      ...attributes.data,
      referenceTable: row.REFTABLE,
      referenceField: row.REFFIELD,
      metadataMethod: "active_dd03l_data_element_domain"
    })
  }
  const second = await observe()
  if (hash(first) !== hash(second)) fail("DEPENDENCY_VALUES_CHANGED")
  for (const key of [...definitions.keys()]) {
    const [kind, objectName] = key.split(":") as [
      "transparentTable" | "dataElement" | "domain",
      string
    ]
    await attest(kind, objectName)
  }
  const policies = first.policies.flatMap((p) => p.rows.map((row) => ({ source: p.table, ...row })))
  const classPolicy = fields.map((field) => {
    // G_FIELD_SET/READ eligibility is deliberately not inferred from DD03L or a wildcard row.
    const matches = policies.filter(
      (row) =>
        ["A", "B"].includes(row.CLASSTYPE) &&
        (row.BCLTAB === field.table || (field.table === "SYST" && row.BCLTAB === "SY")) &&
        [field.name, "*"].includes(row.BCLFIELD)
    )
    const alias = matches.some((row) => row.BCLTAB === "SY")
    return {
      ...field,
      classType: "B",
      nativeEligibility: "not_checked",
      status: alias
        ? "alias_resolution_unverified"
        : matches.some((row) => row.BEXCLUDE === "X")
          ? "policy_excluded"
          : matches.length
            ? "policy_included_native_eligibility_unverified"
            : "policy_not_included",
      matches
    }
  })
  return {
    status: "metadata_and_policy_observed",
    readOnly: true,
    saveAvailable: false,
    fieldDefinitions,
    classPolicy,
    policies,
    readFingerprint: hash({
      booleanClass,
      client: "200",
      first,
      definitions: [...definitions],
      classPolicy
    }),
    blockers: [
      "FI_RULE_FORMULA_ANALYSIS_NATIVE_FIELD_ELIGIBILITY_UNVERIFIED",
      "FI_RULE_FORMULA_ANALYSIS_LITERAL_CONVERSIONS_UNVERIFIED",
      ...(classPolicy.some((p) => p.status === "policy_excluded")
        ? ["FI_RULE_FORMULA_ANALYSIS_CLASS_POLICY_EXCLUDED"]
        : []),
      ...(classPolicy.some((p) => p.status === "policy_not_included")
        ? ["FI_RULE_FORMULA_ANALYSIS_CLASS_POLICY_NOT_INCLUDED"]
        : []),
      ...(classPolicy.some((p) => p.status === "alias_resolution_unverified")
        ? ["FI_RULE_FORMULA_ANALYSIS_CLASS_ALIAS_UNVERIFIED"]
        : [])
    ],
    coverage: {
      fieldDefinitionsComplete: true,
      classPolicyRowsComplete: true,
      classPolicyScope: "referenced_fields_and_table_wildcards_including_SY_alias",
      maximumPolicyRowsPerSelector: 3,
      definitionsRechecked: true,
      nativeClassCheck: "not_performed",
      substitutionWritePermission: "not_checked",
      literalConversions: "attributes_observed_not_applied",
      complete: false,
      snapshot: false
    },
    evidence: { sources, warnings }
  }
}
