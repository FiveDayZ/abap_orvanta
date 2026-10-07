import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import { createReviewedTableReader, type ReviewedReaderSource } from "./reviewed-table-reader.js"

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
    maxSteps: z.number().int().min(2).max(50).default(50)
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
  readFunction: (name: string) => Promise<unknown>
) {
  const input = configurationFiRuleSchema.parse(raw)
  if (input.connectionId !== "w200" || client !== "200")
    throw new Error("FI_RULE_SCOPE_UNSUPPORTED")
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
  const unavailable =
    first.some((part) => part === null) || second?.some((part) => part === null) === true
  const changed =
    !unavailable && second !== null && JSON.stringify(first) !== JSON.stringify(second)
  const truncated = sources.some((s) => s.status === "truncated")
  const usable = !unavailable && !changed
  const header = usable ? (first[0]?.[0] ?? null) : null,
    activation = usable ? (first[2]?.[0] ?? null) : null,
    application = usable ? (first[3]?.[0] ?? null) : null
  const activationMeaning: Record<string, string> = {
    "0": "inactive",
    "1": "active",
    "2": "active_except_batch_input"
  }
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
    readFingerprint:
      usable && !truncated
        ? createHash("sha256").update(JSON.stringify({ input, first })).digest("hex")
        : null,
    coverage: {
      complete: false,
      formulas: "references_only",
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
