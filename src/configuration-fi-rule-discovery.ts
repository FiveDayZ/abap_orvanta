import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import { configurationFiRuleLayouts, configurationFiRuleSchema } from "./configuration-fi-rule.js"
import {
  createReviewedTableReader,
  type ReviewedReaderSource,
  type ReviewedRow
} from "./reviewed-table-reader.js"

export const configurationFiRuleDiscoverySchema = z
  .object({
    connectionId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,100}$/)
      .toLowerCase(),
    maxRules: z.number().int().min(2).max(100).default(20)
  })
  .strict()

export async function findConfigurationFiRules(
  raw: unknown,
  client: string,
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  readTable: (name: string) => Promise<unknown>,
  readFunction: (name: string) => Promise<unknown>
) {
  const input = configurationFiRuleDiscoverySchema.parse(raw)
  if (input.connectionId !== "w200" || client !== "200")
    throw Error("FI_RULE_DISCOVERY_SCOPE_UNSUPPORTED")
  const startedAt = new Date().toISOString()
  const verify = async () => {
    if (
      !z
        .object({
          connectionId: z.literal("w200"),
          objectKind: z.literal("transparentTable"),
          objectName: z.literal("GB93"),
          fingerprint: z.literal(configurationFiRuleLayouts.GB93),
          active: z.literal(true).optional()
        })
        .safeParse(await readTable("GB93")).success
    )
      throw Error("FI_RULE_DISCOVERY_LAYOUT_UNVERIFIED")
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
  const read = () =>
    reader({
      table: "GB93",
      fields: ["MANDT", "VALID", "BOOLCLASS"],
      filters: { MANDT: client },
      maximum: input.maxRules,
      codePrefix: "FI_RULE_DISCOVERY_",
      mapError: (error) =>
        error instanceof Error && /^FI_RULE_DISCOVERY_[A-Z_]+$/.test(error.message)
          ? error.message
          : "FI_RULE_DISCOVERY_QUERY_FAILED",
      validate: (rows) => {
        const keys = new Set<string>()
        for (const row of rows) {
          if (!row.VALID || row.VALID.length > 7 || keys.has(row.VALID))
            throw Error("FI_RULE_DISCOVERY_CANDIDATE_INVALID")
          keys.add(row.VALID)
        }
      }
    })
  const first = await read(),
    confirmation = first === null ? null : await read()
  await verify()
  const canonical = (rows: ReviewedRow[]) => rows.map((row) => JSON.stringify(row)).sort()
  const unavailable = first === null || confirmation === null
  const changed =
    !unavailable && JSON.stringify(canonical(first)) !== JSON.stringify(canonical(confirmation))
  const truncated = sources.some((source) => source.status === "truncated")
  const candidates =
    unavailable || changed
      ? null
      : [...first]
          .sort((a, b) => (a.VALID! < b.VALID! ? -1 : a.VALID! > b.VALID! ? 1 : 0))
          .map((row) => {
            const parsed = configurationFiRuleSchema.shape.ruleName.safeParse(row.VALID)
            return {
              ruleName: row.VALID!,
              booleanClass: row.BOOLCLASS!,
              exactReadSupported: parsed.success && parsed.data === row.VALID,
              exactReadRequired: true
            }
          })
  return {
    ...input,
    client,
    kind: "fi_validation",
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
            .update(JSON.stringify({ input, client, rows: canonical(first) }))
            .digest("hex"),
    coverage: {
      complete: false,
      selectedHeaderProjectionComplete: !unavailable && !changed && !truncated,
      truncated,
      stablePagination: false,
      snapshot: false,
      formulas: "not_read",
      organizationAssignment: "not_read",
      sharedExits: "not_read",
      generatedCode: "not_checked",
      businessTrigger: "not_performed"
    },
    evidence: {
      startedAt,
      finishedAt: new Date().toISOString(),
      sources,
      warnings,
      definitionsRechecked: true
    },
    warnings: [
      "Candidates are bounded GB93 header identities in client 200 only. Read the selected exact rule, organization and callup point separately. Truncated selections have no trusted fingerprint or stable pagination; matching visible prefixes do not attest unseen rows. No text, formula, assignment, generation, configuration/CTS write or business effect is established."
    ]
  }
}
