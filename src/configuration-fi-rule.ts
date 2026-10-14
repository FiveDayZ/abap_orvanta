import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import { createReviewedTableReader, type ReviewedReaderSource } from "./reviewed-table-reader.js"
import { readConfigurationFiFormulas } from "./configuration-fi-formula.js"
import { analyzeConfigurationFiFormulas } from "./configuration-fi-formula-analysis.js"
import { readConfigurationFiDependencies } from "./configuration-fi-dependencies.js"

export const configurationFiRuleSchema = z
  .object({
    connectionId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,100}$/)
      .toLowerCase(),
    kind: z.enum(["fi_validation", "fi_substitution"]),
    ruleName: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9_/$-]{1,7}$/),
    companyCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{4}$/),
    applicationArea: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{2}$/),
    callupPoint: z.string().regex(/^\d{4}$/),
    maxSteps: z.number().int().min(2).max(50).default(50),
    includeFormulaContent: z.boolean().default(false),
    includeFormulaAnalysis: z.boolean().default(false)
  })
  .strict()
export const configurationFiRuleLayouts = {
  GB93: "1a996d9f5eb8e174353529f11fcb6ff5c7ec5aad8c27cc1e5fe1dbcbf3dc0bdb",
  GB92: "fc14afc32827187795ba71bf4be2bd8e04a5f4092ca14e4be9af3a4aa9297906",
  GB931: "214bb8ff0d1074063c0b92466f07467627ef9d933dd2068f46a8858328e97f69",
  GB921: "a57fc5451c8032252dea3a1256e8ffa1454901b2e8ec542832212679706cd04d",
  T001D: "6f3b4be80b6985b6692cebee7dcafe4fd708807b4d77cafc4a0e3a4661145188",
  T001Q: "168d65a092fa01370feffcb6b53f51eab2635e405c8fc1e56265d809cb702cba",
  GB31: "15df948d4ec0906c81289e118908ad94494b18aab57c9e8434de662ee7a2176e"
} as const
export const configurationFiRuleFields = {
  GB93: ["MANDT", "VALID", "BOOLCLASS", "MSGID", "AUTHGR", "INITEXIT", "MULTILINE"],
  GB92: ["MANDT", "SUBSTID", "BOOLCLASS", "SUBSCLASS", "EXIT", "AUTHGR", "INITEXIT", "MULTILINE"],
  GB931: ["MANDT", "VALID", "VALSEQNR", "CONDID", "CHECKID", "VALSEVERE", "VALMSG", "WORKFLOW"],
  GB921: ["MANDT", "SUBSTID", "SUBSEQNR", "CONDID"],
  T001D: ["MANDT", "BUKRS", "EVENT", "VALID", "ACTIV"],
  T001Q: ["MANDT", "BUKRS", "EVENT", "SUBST", "ACTIV"],
  GB31: ["VALUSER", "VALEVENT", "RCLASS", "WCLASS", "GBVALUSE", "GBSUBSTUSE"]
} as const
export const configurationFiActivationDomain =
  "6214b686f1e4bd716554ac3932e2b24450a706936d0fa9a7fc89113778b9a19a"

export async function readConfigurationFiRule(
  raw: unknown,
  client: string,
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  readTable: (name: string) => Promise<unknown>,
  readDomain: (name: string) => Promise<unknown>,
  readFunction: (name: string) => Promise<unknown>,
  readStructure?: (name: string) => Promise<unknown>,
  readSource?: (uri: string) => Promise<{ source: string; uriUsed: string }>,
  readDataElement?: (name: string) => Promise<unknown>
) {
  const input = configurationFiRuleSchema.parse(raw)
  if (input.connectionId !== "w200" || client !== "200")
    throw new Error("FI_RULE_SCOPE_UNSUPPORTED")
  if (input.includeFormulaContent && input.kind !== "fi_validation")
    throw new Error("FI_RULE_FORMULA_SCOPE_UNSUPPORTED")
  if (input.includeFormulaAnalysis && !input.includeFormulaContent)
    throw Error("FI_RULE_FORMULA_ANALYSIS_REQUIRES_CONTENT")
  const { includeFormulaContent, includeFormulaAnalysis, ...referenceInput } = input
  const startedAt = new Date().toISOString()
  const validation = input.kind === "fi_validation"
  const headerTable = validation ? "GB93" : "GB92",
    stepTable = validation ? "GB931" : "GB921",
    activationTable = validation ? "T001D" : "T001Q"
  const nameField = validation ? "VALID" : "SUBSTID",
    stepField = validation ? "VALSEQNR" : "SUBSEQNR"
  const tables = [headerTable, stepTable, activationTable, "GB31"] as const
  const verify = async () => {
    for (const name of tables)
      if (
        !z
          .object({
            connectionId: z.literal("w200"),
            objectKind: z.literal("transparentTable"),
            objectName: z.literal(name),
            fingerprint: z.literal(configurationFiRuleLayouts[name]),
            active: z.literal(true).optional()
          })
          .safeParse(await readTable(name)).success
      )
        throw new Error("FI_RULE_LAYOUT_UNVERIFIED")
    if (
      !z
        .object({
          connectionId: z.literal("w200"),
          objectKind: z.literal("domain"),
          objectName: z.literal("GVSACTIV"),
          fingerprint: z.literal(configurationFiActivationDomain),
          active: z.literal(true).optional()
        })
        .safeParse(await readDomain("GVSACTIV")).success
    )
      throw new Error("FI_RULE_DOMAIN_UNVERIFIED")
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
  const selected = [
    [headerTable, { MANDT: client, [nameField]: input.ruleName }, 1],
    [stepTable, { MANDT: client, [nameField]: input.ruleName }, input.maxSteps],
    [activationTable, { MANDT: client, BUKRS: input.companyCode, EVENT: input.callupPoint }, 1],
    ["GB31", { VALUSER: input.applicationArea, VALEVENT: input.callupPoint }, 1]
  ] as const
  const read = async () => {
    const parts = []
    for (const [table, filters, maximum] of selected)
      parts.push(
        await reader({
          table,
          fields: configurationFiRuleFields[table],
          filters,
          maximum,
          codePrefix: "FI_RULE_",
          mapError: (error) =>
            error instanceof Error && /^FI_RULE_[A-Z_]+$/.test(error.message)
              ? error.message
              : "FI_RULE_QUERY_FAILED",
          validate: (rows) => {
            if (
              table === stepTable &&
              new Set(rows.map((row) => row[stepField])).size !== rows.length
            )
              throw new Error("FI_RULE_DUPLICATE_STEP")
          }
        })
      )
    if (parts[1])
      parts[1].sort((a, b) =>
        a[stepField]! < b[stepField]! ? -1 : a[stepField]! > b[stepField]! ? 1 : 0
      )
    return parts
  }
  const first = await read(),
    firstTruncated = sources.some((s) => s.status === "truncated")
  const second = firstTruncated ? null : await read()
  await verify()
  let unavailable =
    first.some((part) => part === null) || second?.some((part) => part === null) === true
  let changed = !unavailable && second !== null && JSON.stringify(first) !== JSON.stringify(second)
  let truncated = sources.some((s) => s.status === "truncated")
  let usable = !unavailable && !changed && !truncated
  let formulaContent: Awaited<ReturnType<typeof readConfigurationFiFormulas>> | null = null
  let formulaAnalysis: Awaited<ReturnType<typeof analyzeConfigurationFiFormulas>> | null = null
  if (input.includeFormulaContent && usable && first[0]?.[0] && first[1]?.length) {
    if (!readStructure) throw Error("FI_RULE_FORMULA_STRUCTURE_READER_REQUIRED")
    formulaContent = await readConfigurationFiFormulas(
      input.connectionId,
      client,
      first[0][0].BOOLCLASS!,
      first[1],
      backend,
      { table: readTable, domain: readDomain, function: readFunction, structure: readStructure }
    )
    if (
      input.includeFormulaAnalysis &&
      !formulaContent.blockers.includes("FI_RULE_FORMULA_AUTHENTICATION_REJECTED")
    ) {
      if (!readSource) throw Error("FI_RULE_FORMULA_ANALYSIS_SOURCE_READER_REQUIRED")
      if (!readDataElement) throw Error("FI_RULE_FORMULA_ANALYSIS_DATA_ELEMENT_READER_REQUIRED")
      formulaAnalysis = await analyzeConfigurationFiFormulas(
        formulaContent,
        first[0][0].BOOLCLASS!,
        {
          source: readSource,
          function: readFunction,
          table: readTable,
          structure: readStructure,
          dependencies: (fields, booleanClass) =>
            readConfigurationFiDependencies(fields, booleanClass, backend, {
              table: readTable,
              domain: readDomain,
              dataElement: readDataElement,
              function: readFunction
            })
        }
      )
    }
    if (
      formulaContent.blockers.includes("FI_RULE_FORMULA_AUTHENTICATION_REJECTED") ||
      formulaAnalysis?.blockers.includes("FI_RULE_FORMULA_ANALYSIS_AUTHENTICATION_REJECTED")
    )
      unavailable = true
    else {
      const final = await read()
      await verify()
      unavailable ||= final.some((part) => part === null)
      changed ||= !unavailable && JSON.stringify(first) !== JSON.stringify(final)
      truncated ||= sources.some((s) => s.status === "truncated")
    }
    usable = !unavailable && !changed && !truncated
    if (!usable) {
      formulaContent = {
        ...formulaContent,
        status: "unavailable",
        references: [],
        items: null,
        readFingerprint: null,
        blockers: [...formulaContent.blockers, "FI_RULE_FORMULA_PARENT_CHANGED_OR_UNAVAILABLE"],
        coverage: {
          ...formulaContent.coverage,
          storedRowsComplete: false,
          rowPaddingPreserved: false
        }
      }
      if (formulaAnalysis)
        formulaAnalysis = {
          ...formulaAnalysis,
          status: "unavailable",
          items: null,
          dependencies: null,
          fieldEvidence: null,
          nativeRoute: null,
          contentFingerprint: null,
          readFingerprint: null,
          blockers: [
            ...formulaAnalysis.blockers,
            "FI_RULE_FORMULA_ANALYSIS_PARENT_CHANGED_OR_UNAVAILABLE"
          ],
          coverage: {
            ...formulaAnalysis.coverage,
            syntaxSubsetComplete: false,
            fieldDefinitionsComplete: false,
            classPermissions: "not_checked",
            literalConversions: "not_checked",
            nativeFieldRoute: "not_checked"
          }
        }
    }
  }
  const header = usable ? (first[0]?.[0] ?? null) : null,
    activation = usable ? (first[2]?.[0] ?? null) : null,
    application = usable ? (first[3]?.[0] ?? null) : null
  const activationMeaning: Record<string, string> = {
    "0": "inactive",
    "1": "active",
    "2": "active_except_batch_input"
  }
  const blockers: string[] = []
  if (unavailable) blockers.push("FI_RULE_READ_UNAVAILABLE")
  if (changed) blockers.push("FI_RULE_READ_CHANGED")
  if (truncated) blockers.push("FI_RULE_READ_TRUNCATED")
  if (usable) {
    if (!header) blockers.push("FI_RULE_DEFINITION_MISSING")
    if (!first[1]?.length) blockers.push("FI_RULE_STEPS_NOT_OBSERVED")
    if (!activation) blockers.push("FI_RULE_ASSIGNMENT_MISSING")
    else {
      if (activation[validation ? "VALID" : "SUBST"] !== input.ruleName)
        blockers.push("FI_RULE_ASSIGNED_TO_OTHER_RULE")
      if (!Object.hasOwn(activationMeaning, activation.ACTIV!))
        blockers.push("FI_RULE_ACTIVATION_LEVEL_UNKNOWN")
    }
    if (!application) blockers.push("FI_RULE_APPLICATION_NOT_OBSERVED")
    if (header && application && header.BOOLCLASS !== application.RCLASS)
      blockers.push("FI_RULE_CLASS_PROJECTION_MISMATCH")
  }
  if (formulaContent?.coverage.storedRowsComplete) {
    blockers.push("FI_RULE_FORMULA_SEMANTICS_UNVERIFIED", "FI_RULE_FORMULA_DEPENDENCIES_UNVERIFIED")
  } else blockers.push("FI_RULE_FORMULA_CONTENT_UNVERIFIED")
  if (formulaContent) blockers.push(...formulaContent.blockers)
  if (formulaAnalysis) blockers.push(...formulaAnalysis.blockers)
  if (!validation) blockers.push("FI_RULE_SUBSTITUTION_ACTIONS_UNVERIFIED")
  blockers.push(
    "FI_RULE_SHARED_EXITS_UNVERIFIED",
    "FI_RULE_GENERATED_CODE_UNVERIFIED",
    "FI_RULE_MAINTENANCE_API_UNVERIFIED",
    "FI_RULE_AUTHORITY_LOCK_CTS_LUW_UNVERIFIED"
  )
  return {
    connectionId: input.connectionId,
    client,
    kind: input.kind,
    ruleName: input.ruleName,
    companyCode: input.companyCode,
    applicationArea: input.applicationArea,
    callupPoint: input.callupPoint,
    status: unavailable ? "unavailable" : changed ? "changed" : "partial",
    readOnly: true,
    saveAvailable: false,
    executionPreflight: {
      status: "blocked",
      writeAvailable: false,
      automaticRetry: false,
      blockers
    },
    rule: {
      table: headerTable,
      status: !usable ? "unavailable" : header ? "read" : "not_found",
      data: header
    },
    steps: { table: stepTable, data: usable ? first[1] : null, truncated },
    activation: {
      table: activationTable,
      status: !usable ? "unavailable" : activation ? "read" : "not_found",
      data: activation,
      assignedToRequestedRule: activation
        ? activation[validation ? "VALID" : "SUBST"] === input.ruleName
        : null,
      levelMeaning: activation ? (activationMeaning[activation.ACTIV!] ?? "unknown") : null
    },
    application: {
      data: application,
      classMatches: header && application ? header.BOOLCLASS === application.RCLASS : null
    },
    ...(input.includeFormulaContent ? { formulaContent } : {}),
    ...(input.includeFormulaAnalysis ? { formulaAnalysis } : {}),
    readFingerprint:
      usable && !truncated
        ? createHash("sha256")
            .update(JSON.stringify({ input: referenceInput, first }))
            .digest("hex")
        : null,
    coverage: {
      complete: false,
      formulas: formulaAnalysis?.coverage.syntaxSubsetComplete
        ? "parsed_subset_semantics_unverified"
        : formulaContent?.coverage.storedRowsComplete
          ? "raw_stored_rows_semantics_unverified"
          : "references_only",
      substitutionActions: "not_read",
      generatedCode: "not_checked",
      businessTrigger: "not_performed",
      otherOrganizations: "not_read"
    },
    manualWorkflow: {
      transactions: validation ? ["GGB0", "OB28"] : ["GGB1", "OBBH"],
      steps: [
        "Review rule, prerequisite/check or substitution actions and shared exits.",
        "Review the exact company code, callup point, activation level and class; level 2 excludes batch input.",
        "After approved manual maintenance, repeat this read and compare CTS/E071K evidence.",
        "Have the business owner perform an approved document trigger; configuration existence or activation is not business success."
      ]
    },
    evidence: {
      startedAt,
      finishedAt: new Date().toISOString(),
      sources,
      warnings,
      definitionsRechecked: true,
      snapshot: false
    }
  }
}
