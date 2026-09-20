import { z } from "zod"
import { rowSchema, type SciInput } from "./sci.js"

export const SCI_V2_HELPER = "Z_ORVANTA_MCP_SCI_V2"
// Use read_function_module_interface.fingerprint, not its interface-only hash.
// Re-pinned 2026-09-20 from a live read-only read_function_module_interface(w200): the previous
// values (4d38c098… / 9f0c1e64…) had gone stale, so testRemoteFunctionModule refused every
// run_sci_analysis call with an explicit target or the syntax_critical_sql profile before it ever
// reached SAP. The drift came from adding EV_RESULT to both SCI interfaces for the CAPABILITIES
// carrier. Deploying that carrier's *body* changes the fingerprint again, so this must be re-pinned
// once more after that deployment.
export const SCI_V2_FINGERPRINT = "0f534e3fcca3355a1c9d38483dc3991210d4f8c573cdf07dbd9375facefb7270"
export const SCI_E2_HELPER = "Z_ORVANTA_MCP_SCI_E2"
export const SCI_E2_FINGERPRINT = "48bf0016d50e36b2d2f500b0cb2abe0abcb2f6a46f99be16661625605b60b626"

export const sciTargetSchema = z
  .object({
    objectType: z.enum(["PROG", "CLAS", "FUGR"]),
    objectName: z.string().regex(/^[ZY][A-Z0-9_]{0,39}$/)
  })
  .strict()
  .refine((target) => target.objectType === "PROG" || target.objectName.length <= 30, {
    message: "SCI class and function-group names must not exceed 30 characters"
  })

export type SciTarget = z.infer<typeof sciTargetSchema>

const baseRules = [
  { name: "CL_CI_TEST_SYNTAX_CHECK", version: "001" },
  { name: "CL_CI_TEST_CRITICAL_STATEMENTS", version: "002" }
]
const nestedKinds: Record<string, string> = { "0001": "N", "0002": "W", "0003": "N" }
const responseSchema = z.object({
  outputs: z.object({
    EV_STATUS: z.enum(["S", "W", "E"]),
    EV_CODE: z.string(),
    EV_ENGINE: z.literal("SCI"),
    EV_VERSION: z.string(),
    EV_VARIANT: z.string(),
    EV_COUNT: z.string().regex(/^\d+$/),
    EV_OBJTYPE: z.string(),
    EV_OBJNAME: z.string(),
    EV_PROGRAM: z.string(),
    EV_PACKAGE: z.string(),
    EV_SYNTAX: z.string(),
    EV_CRITICAL: z.string(),
    EV_NESTED: z.string().optional()
  }),
  tableOutputs: z.object({ ET_RESULTS: z.array(rowSchema).max(1000) })
})

export function formatSciV2Result(raw: unknown, input: SciInput): string {
  return formatScopedSciResult(raw, input, false)
}

export function formatSciE2Result(raw: unknown, input: SciInput): string {
  return formatScopedSciResult(raw, input, true)
}

function formatScopedSciResult(raw: unknown, input: SciInput, extended: boolean): string {
  const target = sciTargetSchema.parse(input.target)
  const { outputs: out, tableOutputs } = responseSchema.parse(raw)
  const label = extended ? "SCI E2" : "SCI V2"
  if (
    out.EV_VERSION !== (extended ? "3.0" : "2.0") ||
    out.EV_VARIANT !== (extended ? "SYNTAX_CRITICAL_SQL_V1" : "SYNTAX_CRITICAL_V1")
  )
    throw new Error(`${label} helper version/profile mismatch`)
  if (out.EV_STATUS === "E") throw new Error(`${label} helper failed: ${out.EV_CODE}`)
  const rules = extended
    ? [...baseRules, { name: "CL_CI_TEST_SELECT_NESTED", version: "000" }]
    : baseRules
  const precheck = input.action === "precheck"
  const count = Number(out.EV_COUNT)
  const rows = tableOutputs.ET_RESULTS
  if (
    !Number.isSafeInteger(count) ||
    rows.length !== Math.min(count, 1000) ||
    (precheck && count !== 0)
  ) {
    throw new Error(`${label} response count mismatch`)
  }
  if (
    out.EV_OBJTYPE !== target.objectType ||
    out.EV_OBJNAME !== target.objectName ||
    !out.EV_PROGRAM.trim() ||
    !out.EV_PACKAGE.trim() ||
    (target.objectType === "PROG" && out.EV_PROGRAM !== target.objectName)
  ) {
    throw new Error(`${label} response target mismatch`)
  }
  if (
    out.EV_SYNTAX !== "001" ||
    out.EV_CRITICAL !== "002" ||
    (extended && out.EV_NESTED !== "000")
  ) {
    throw new Error(`${label} rule version mismatch`)
  }
  const code = precheck
    ? "PREFLIGHT_ONLY"
    : count === 0
      ? "NO_FINDINGS_UNVERIFIED"
      : count > 1000
        ? "TRUNCATED_LIMITED"
        : "FINDINGS_LIMITED"
  if (out.EV_STATUS !== (precheck ? "S" : "W") || out.EV_CODE !== code) {
    throw new Error(`${label} helper returned an inconsistent execution state`)
  }
  const findings = rows.map((row) => {
    if (
      !/^[EWN]$/.test(row.TYPE) ||
      !/^\d+$/.test(row.ROW) ||
      !/^\d+$/.test(row.MESSAGE_V4) ||
      !Number.isSafeInteger(Number(row.ROW)) ||
      !Number.isSafeInteger(Number(row.MESSAGE_V4)) ||
      !rules.some((rule) => rule.name === row.MESSAGE_V1) ||
      !["", "TEXT_TRUNCATED"].includes(row.FIELD)
    ) {
      throw new Error(`${label} finding has invalid rule, severity, position or truncation marker`)
    }
    if (row.MESSAGE_V1 === "CL_CI_TEST_SELECT_NESTED") {
      const expected = nestedKinds[row.MESSAGE_V2]
      if (!expected || row.TYPE !== expected || !row.MESSAGE.trim()) {
        throw new Error("SCI E2 nested SELECT finding has invalid code, severity or message")
      }
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
      helper: extended ? SCI_E2_HELPER : SCI_V2_HELPER,
      helperFingerprint: extended ? SCI_E2_FINGERPRINT : SCI_V2_FINGERPRINT,
      execution: precheck ? "not_run" : "returned",
      qualityGate: "not_evaluated",
      requestedTarget: target,
      scope: {
        objectType: out.EV_OBJTYPE,
        objectName: out.EV_OBJNAME,
        programName: out.EV_PROGRAM,
        packageName: out.EV_PACKAGE
      },
      profile: out.EV_VARIANT,
      selectedRules: rules.map((rule) => ({
        ...rule,
        applicable: true,
        completion: precheck ? "not_run" : "not_attested"
      })),
      coverage: "limited",
      code,
      totalFindings: precheck ? undefined : count,
      returnedFindings: findings.length,
      truncated: count > 1000 || findings.some((finding) => finding.textTruncated),
      findings,
      limitations: [
        "SCI is not native ATC and does not prove business correctness.",
        "One explicit customer main object; includes within its pool may be checked.",
        extended
          ? "Three constructor-default rules only, no ABAP Unit; loop-query findings are risk signals, not proven defects."
          : "Two constructor-default rules only; no saved DEFAULT variant or ABAP Unit.",
        ...(extended
          ? [
              "Native SQL and unexpanded macros are not covered by the loop-query rule; no FAE check."
            ]
          : []),
        "Anonymous direct execution; no named inspection, variant or object set is saved.",
        "Applicability does not attest per-rule completion; empty findings never mean passed.",
        "The 1000-row output limit does not bound SAP scan time or memory.",
        "Timeout does not cancel SAP execution; never retry automatically."
      ]
    },
    null,
    2
  )
}
