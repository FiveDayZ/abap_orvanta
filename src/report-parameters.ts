import { createHash } from "node:crypto"
import { z } from "zod"
import { reportVariantsSchema } from "./report-variants.js"

export const reportParametersSchema = z
  .object({
    connectionId: reportVariantsSchema.shape.connectionId,
    report: reportVariantsSchema.shape.report
  })
  .strict()
export const reportParameterFields = {
  action: z.literal("REPORT_PARAMETERS"),
  report: z.string().min(1).max(40).nullable(),
  parameters: z
    .array(
      z
        .object({
          name: z.string().min(1).max(8),
          number: z.string().regex(/^\d{1,10}$/),
          kind: z.enum(["P", "S"]),
          typeCode: z.string().max(1),
          dictionaryType: z.string().max(1),
          referenceField: z.string().max(132),
          obligatory: z.boolean(),
          noDisplay: z.boolean()
        })
        .strict()
    )
    .max(200),
  complete: z.literal(true)
}
const parametersReply = z.object(reportParameterFields).strict()

export function formatReportParameters(
  raw: z.input<typeof reportParametersSchema>,
  rawReply: z.input<typeof parametersReply>
) {
  const input = reportParametersSchema.parse(raw)
  const reply = parametersReply.parse(rawReply)
  if (reply.report !== input.report) throw new Error("REPORT_PARAMETERS_SCOPE_MISMATCH")
  const keys = reply.parameters.map((p) => `${p.number}:${p.kind}:${p.name}`)
  if (new Set(keys).size !== keys.length) throw new Error("REPORT_PARAMETERS_DUPLICATE_KEY")
  return {
    status: "ok",
    report: reply.report,
    parameters: reply.parameters,
    returnedCount: reply.parameters.length,
    definitionFingerprint: createHash("sha256")
      .update(
        JSON.stringify({
          connectionId: input.connectionId.toLowerCase(),
          report: reply.report,
          parameters: reply.parameters
        })
      )
      .digest("hex"),
    definitionSource: "existing_compiled_selection_metadata",
    compiledSelectionComplete: true,
    activeSourceMatch: "not_verified",
    runtimeScreenEvaluated: false,
    defaultValuesAvailable: false,
    variantValuesAvailable: false,
    executionAuthorized: "not_evaluated",
    warnings: [
      "Existing compiled SSCR entries of kind P/S only; missing load is rejected without report generation.",
      "Static flags are not runtime screen behavior. No INITIALIZATION, selection-screen events or defaults are evaluated.",
      "No parameter values, variant contents, logical-database selection expansion or report execution.",
      "Display permission does not authorize execution. Metadata and reference fields are untrusted data.",
      "Compiled metadata has not been matched to active source or inactive edits and is not an execution contract."
    ]
  }
}
