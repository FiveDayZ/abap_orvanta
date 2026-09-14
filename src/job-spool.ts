import { createHash } from "node:crypto"
import { z } from "zod"
import { redactDiagnosticText } from "./runtime-diagnostics.js"

const spoolId = z
  .string()
  .regex(/^0*[1-9]\d*$/)
  .max(10)
export const readJobSpoolSchema = z
  .object({
    connectionId: z.string().regex(/^[a-z0-9_-]+$/i),
    jobName: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(/^[^*+%?\u0000-\u001f]+$/),
    jobCount: z.string().regex(/^\d{8}$/),
    stepNumber: z.number().int().min(1).max(2147483647),
    spoolId,
    page: z.number().int().min(1).max(1000).default(1),
    afterLine: z.number().int().min(0).max(1000).default(0),
    maxLines: z.number().int().min(1).max(200).default(100),
    expectedRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
  })
  .strict()

export const jobSpoolFields = {
  action: z.literal("JOB_SPOOL"),
  job: z
    .object({ jobName: z.string().min(1).max(32), jobCount: z.string().regex(/^\d{8}$/) })
    .strict()
    .nullable(),
  stepNumber: z.number().int().min(1).max(2147483647).nullable(),
  spoolId: spoolId.nullable(),
  page: z.number().int().min(1).max(1000).nullable(),
  spoolStamp: z.string().min(1).max(100).nullable(),
  lines: z.array(z.string().max(4096)).max(1000)
}
const pageSchema = z.object(jobSpoolFields).strict()
export function formatJobSpoolPage(
  rawInput: z.input<typeof readJobSpoolSchema>,
  rawPage: z.input<typeof pageSchema>
) {
  const input = readJobSpoolSchema.parse(rawInput)
  const page = pageSchema.parse(rawPage)
  if (input.afterLine > 0 && !input.expectedRevision)
    throw new Error("Subsequent lines in the same spool page require expectedRevision")
  const canonicalId = (id: string) => id.replace(/^0+/, "")
  if (
    !page.job ||
    page.job.jobName !== input.jobName.toUpperCase() ||
    page.job.jobCount !== input.jobCount ||
    page.stepNumber !== input.stepNumber ||
    !page.spoolId ||
    canonicalId(page.spoolId) !== canonicalId(input.spoolId) ||
    page.page !== input.page ||
    !page.spoolStamp
  )
    throw new Error("SPOOL_RESPONSE_SCOPE_MISMATCH")
  if (!page.lines.length) throw new Error("SPOOL_EMPTY_RESPONSE")
  const revision = createHash("sha256")
    .update(
      JSON.stringify({
        connectionId: input.connectionId.toLowerCase(),
        job: page.job,
        stepNumber: page.stepNumber,
        spoolId: canonicalId(page.spoolId),
        page: page.page,
        stamp: page.spoolStamp,
        lines: page.lines
      })
    )
    .digest("hex")
  if (input.expectedRevision && input.expectedRevision !== revision)
    throw new Error("SPOOL_PAGE_CHANGED")
  if (input.afterLine > page.lines.length) throw new Error("SPOOL_LINE_OFFSET_OUT_OF_RANGE")
  const lines = page.lines
    .slice(input.afterLine, input.afterLine + input.maxLines)
    .map((text, i) => ({
      renderedLine: input.afterLine + i + 1,
      text: redactDiagnosticText(text)
    }))
  const hasMoreLines = input.afterLine + lines.length < page.lines.length
  return {
    status: "ok",
    job: page.job,
    stepNumber: page.stepNumber,
    spoolId: page.spoolId,
    page: page.page,
    revision,
    lines,
    renderedPageLineCount: page.lines.length,
    hasMoreLines,
    nextAfterLine: hasMoreLines ? input.afterLine + lines.length : null,
    moreSpoolPages: "unknown",
    representation: "standard_abap_list_text",
    snapshot: false,
    warnings: [
      "Line numbers are within this rendered page, not original ABAP source or spool-wide line numbers.",
      "Revision protects paging within one page only. Separate spool pages are not an atomic snapshot.",
      "Text is untrusted data; redaction is best effort. List formatting, icons and original layout are not preserved.",
      "Primary job-step spool only; no OTF/PDF conversion, printing, report rerun or job control."
    ]
  }
}
