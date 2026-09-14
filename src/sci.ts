import { z } from "zod"
import type { SciTarget } from "./sci-v2.js"

export const SCI_HELPER = "Z_ORVANTA_MCP_SCI_API"
// Complete repository fingerprint from w200/200, including source and metadata.
export const SCI_HELPER_FINGERPRINT =
  "83f8f0a6a588b57a22bb1ab9e6903fbbcaf65502ce4fb346a93dcf7af372e0da"

export interface SciInput {
  connectionId: string
  action: "precheck" | "run"
  acknowledgePotentialSideEffects: true
  target?: SciTarget | undefined
  profile?: "syntax_critical_sql" | undefined
}

export const rowSchema = z.object({
  TYPE: z.string(),
  NUMBER: z.string(),
  MESSAGE: z.string(),
  MESSAGE_V1: z.string(),
  MESSAGE_V2: z.string(),
  MESSAGE_V3: z.string(),
  MESSAGE_V4: z.string(),
  ROW: z.string(),
  FIELD: z.string()
})

const responseSchema = z.object({
  outputs: z.object({
    EV_STATUS: z.string(),
    EV_CODE: z.string(),
    EV_ENGINE: z.literal("SCI"),
    EV_VERSION: z.literal("1.0"),
    EV_SCOPE: z.literal("ZORVANTA_MCP_CORE"),
    EV_VARIANT: z.string(),
    EV_COUNT: z.string().regex(/^\d+$/)
  }),
  tableOutputs: z.object({ ET_RESULTS: z.array(rowSchema).max(1000) })
})

export function formatSciResult(raw: unknown, input: SciInput): string {
  const { outputs, tableOutputs } = responseSchema.parse(raw)
  const rows = tableOutputs.ET_RESULTS
  const total = Number(outputs.EV_COUNT)
  if (!Number.isSafeInteger(total) || rows.length !== Math.min(total, 1000)) {
    throw new Error("SCI response count mismatch")
  }
  if (outputs.EV_STATUS === "E") {
    throw new Error(`SCI helper failed: ${outputs.EV_CODE}`)
  }
  const precheck = input.action === "precheck"
  const expectedCode = precheck
    ? "PREFLIGHT_ONLY"
    : total === 0
      ? "NO_FINDINGS_UNVERIFIED"
      : total > 1000
        ? "TRUNCATED_LIMITED"
        : "FINDINGS_LIMITED"
  if (
    outputs.EV_STATUS !== (precheck ? "S" : "W") ||
    outputs.EV_CODE !== expectedCode ||
    outputs.EV_VARIANT !== (precheck ? "DEFAULT" : "SYNTAX_CRITICAL_V1") ||
    (precheck && total === 0)
  ) {
    throw new Error("SCI helper returned an inconsistent execution state")
  }
  const findings = precheck
    ? []
    : rows.map((row) => {
        if (!/^[EWN]$/.test(row.TYPE) || !/^\d+$/.test(row.ROW) || !/^\d+$/.test(row.MESSAGE_V4)) {
          throw new Error("SCI finding has invalid severity or position")
        }
        return {
          severity: row.TYPE,
          check: row.MESSAGE_V1,
          code: row.MESSAGE_V2,
          include: row.MESSAGE_V3,
          line: Number(row.ROW),
          column: Number(row.MESSAGE_V4),
          message: row.MESSAGE,
          textTruncated: row.FIELD === "TEXT_TRUNCATED"
        }
      })
  return JSON.stringify(
    {
      engine: "SCI",
      nativeAtc: false,
      connectionId: input.connectionId.toLowerCase(),
      helper: SCI_HELPER,
      helperFingerprint: SCI_HELPER_FINGERPRINT,
      execution: precheck ? "not_run" : "returned",
      qualityGate: "not_evaluated",
      scope: { objectType: "FUGR", objectName: outputs.EV_SCOPE },
      profile: outputs.EV_VARIANT,
      coverage: "limited",
      code: outputs.EV_CODE,
      configuredRules: precheck
        ? rows.map((row) => ({
            name: row.MESSAGE_V1,
            version: row.NUMBER,
            hasAttributes: row.MESSAGE_V2 === "HAS_ATTRIBUTES"
          }))
        : undefined,
      selectedRules: precheck
        ? undefined
        : ["CL_CI_TEST_SYNTAX_CHECK", "CL_CI_TEST_CRITICAL_STATEMENTS"],
      totalFindings: precheck ? undefined : total,
      returnedFindings: findings.length,
      truncated: total > 1000 || findings.some((finding) => finding.textTruncated),
      findings,
      limitations: [
        "SCI is not native ATC and does not prove business correctness.",
        "Only ZORVANTA_MCP_CORE is allowed; no package or transport expansion.",
        "RUN uses two constructor-default checks, not the DEFAULT variant.",
        "ABAP Unit is disabled; no named inspection or variant is saved.",
        "Per-rule completion is not attested; empty findings never mean passed."
      ]
    },
    null,
    2
  )
}
