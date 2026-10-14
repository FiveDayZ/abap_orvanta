import { createHash } from "node:crypto"
import { z } from "zod"
import { configurationFiRuleSchema, type readConfigurationFiRule } from "./configuration-fi-rule.js"

export const configurationFiActivationPreviewSchema = z
  .object({
    connectionId: z.string().toLowerCase().pipe(z.literal("w200")),
    ruleName: configurationFiRuleSchema.shape.ruleName,
    companyCode: configurationFiRuleSchema.shape.companyCode,
    applicationArea: z.literal("FI").default("FI"),
    callupPoint: configurationFiRuleSchema.shape.callupPoint,
    expectedReadFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    activationLevel: z.enum(["0", "1", "2"])
  })
  .strict()

type RuleRead = Awaited<ReturnType<typeof readConfigurationFiRule>>
type ReadInput = z.infer<typeof configurationFiRuleSchema>
const levelMeaning = {
  "0": "inactive",
  "1": "active",
  "2": "active_except_batch_input"
} as const

/** Preview one existing assignment; neither stable rows nor this plan admit a write. */
export async function previewConfigurationFiActivation(
  raw: unknown,
  client: string,
  readRule: (input: ReadInput) => Promise<RuleRead>
) {
  const input = configurationFiActivationPreviewSchema.parse(raw)
  if (client !== "200") throw Error("FI_ACTIVATION_SCOPE_UNSUPPORTED")
  const current = await readRule(
    configurationFiRuleSchema.parse({
      connectionId: input.connectionId,
      kind: "fi_validation",
      ruleName: input.ruleName,
      companyCode: input.companyCode,
      applicationArea: input.applicationArea,
      callupPoint: input.callupPoint
    })
  )
  const blockers: string[] = []
  if (
    current.connectionId !== input.connectionId ||
    current.client !== client ||
    current.kind !== "fi_validation" ||
    current.ruleName !== input.ruleName ||
    current.companyCode !== input.companyCode ||
    current.applicationArea !== input.applicationArea ||
    current.callupPoint !== input.callupPoint
  )
    throw Error("FI_ACTIVATION_READ_SCOPE_CHANGED")
  if (current.status !== "partial" || !current.readFingerprint || current.steps.truncated)
    blockers.push("FI_ACTIVATION_READ_UNAVAILABLE_OR_CHANGED")
  else if (current.readFingerprint !== input.expectedReadFingerprint)
    blockers.push("FI_ACTIVATION_READ_STALE")
  const header = current.rule.data,
    assignment = current.activation.data,
    application = current.application.data
  if (
    current.rule.table !== "GB93" ||
    current.rule.status !== "read" ||
    !header ||
    header.MANDT !== client ||
    header.VALID !== input.ruleName ||
    !current.steps.data?.length ||
    current.steps.table !== "GB931"
  )
    blockers.push("FI_ACTIVATION_RULE_NOT_OBSERVED")
  if (
    current.activation.table !== "T001D" ||
    current.activation.status !== "read" ||
    !assignment ||
    assignment.MANDT !== client ||
    assignment.BUKRS !== input.companyCode ||
    assignment.EVENT !== input.callupPoint ||
    assignment.VALID !== input.ruleName ||
    current.activation.assignedToRequestedRule !== true
  )
    blockers.push("FI_ACTIVATION_ASSIGNMENT_NOT_MATCHED")
  if (!assignment || !Object.hasOwn(levelMeaning, assignment.ACTIV!))
    blockers.push("FI_ACTIVATION_CURRENT_LEVEL_UNKNOWN")
  if (
    !application ||
    application.VALUSER !== input.applicationArea ||
    application.VALEVENT !== input.callupPoint ||
    application.RCLASS !== header?.BOOLCLASS ||
    current.application.classMatches !== true
  )
    blockers.push("FI_ACTIVATION_APPLICATION_NOT_MATCHED")

  const previewAvailable = blockers.length === 0,
    before = previewAvailable ? { ...assignment! } : null,
    after = before ? { ...before, ACTIV: input.activationLevel } : null,
    changes =
      before && after
        ? before.ACTIV === after.ACTIV
          ? []
          : [
              {
                table: "T001D",
                key: { MANDT: client, BUKRS: input.companyCode, EVENT: input.callupPoint },
                field: "ACTIV",
                before: before.ACTIV!,
                after: after.ACTIV
              }
            ]
        : null
  const executionBlockers = [
    ...current.executionPreflight.blockers,
    "FI_ACTIVATION_MAINTENANCE_OBJECT_UNVERIFIED"
  ]
  return {
    connectionId: input.connectionId,
    client,
    kind: "fi_validation",
    ruleName: input.ruleName,
    companyCode: input.companyCode,
    applicationArea: input.applicationArea,
    callupPoint: input.callupPoint,
    status: previewAvailable ? "previewed" : "blocked",
    readOnly: true,
    previewAvailable,
    saveAvailable: false,
    blockers,
    expectedReadFingerprint: input.expectedReadFingerprint,
    currentReadFingerprint: current.readFingerprint,
    before,
    after,
    changes,
    levelMeaning: before
      ? {
          before: levelMeaning[before.ACTIV as keyof typeof levelMeaning],
          after: levelMeaning[input.activationLevel]
        }
      : null,
    previewFingerprint: previewAvailable
      ? createHash("sha256").update(JSON.stringify({ input, before, after })).digest("hex")
      : null,
    executionPreflight: {
      status: "blocked",
      writeAvailable: false,
      automaticRetry: false,
      blockers: [...new Set([...blockers, ...executionBlockers])]
    },
    recovery: {
      available: false,
      automaticRetry: false,
      beforeAssignment: before,
      ctsBeforeState: "not_read"
    },
    coverage: {
      complete: false,
      assignmentProjection: previewAvailable ? "read_and_rechecked" : "unavailable",
      formulaSemantics: "not_checked",
      generatedCode: "not_checked",
      maintenanceApi: "not_attested",
      authorityLockCtsLuw: "not_checked",
      ctsKeyEncoding: "not_verified",
      businessTrigger: "not_performed",
      otherOrganizations: "not_read"
    },
    evidence: current.evidence
  }
}
