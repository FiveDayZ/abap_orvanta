import { createHash } from "node:crypto"
import { z } from "zod"
import type { tableQuerySchema } from "./table-query.js"

export const reportVariantsSchema = z
  .object({
    connectionId: z.string().regex(/^[a-z0-9_-]{1,100}$/i),
    report: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z][A-Z0-9_]{0,39}$|^\/[A-Z0-9_]+\/[A-Z][A-Z0-9_]*$/)
      .max(40),
    variant: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9_/$&.-]{1,14}$/)
      .optional(),
    maxResults: z.number().int().min(1).max(200).default(100)
  })
  .strict()

const text = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[^\u0000-\u001f\u007f]*$/)
const blank = z
  .string()
  .max(1)
  .regex(/^ ?$/)
  .transform(() => "")
const version = z
  .union([
    z.number().int().min(-2147483648).max(2147483647),
    z
      .string()
      .regex(/^-?\d{1,10}$/)
      .refine((v) => Number(v) >= -2147483648 && Number(v) <= 2147483647)
  ])
  .transform(String)
const rowSchema = z
  .object({
    MANDT: z.string().regex(/^\d{3}$/),
    REPORT: text(40)
      .transform((v) => v.trimEnd())
      .pipe(z.string().min(1)),
    VARIANT: text(14)
      .transform((v) => v.trimEnd())
      .pipe(z.string().min(1)),
    FLAG1: blank,
    FLAG2: blank,
    TRANSPORT: text(1),
    ENVIRONMNT: text(1),
    PROTECTED: text(1),
    SECU: text(8),
    VERSION: version,
    ENAME: text(12),
    EDAT: text(40),
    ETIME: text(40),
    AENAME: text(12),
    AEDAT: text(40),
    AETIME: text(40),
    MLANGU: text(1)
  })
  .strict()
const responseSchema = z.object({
  connectionId: z.string(),
  tableName: z.literal("VARID"),
  readOnly: z.literal(true),
  status: z.literal("ok"),
  method: z.enum(["adt_query", "rfc_read_table", "bbp_rfc_read_table"]),
  representation: z.enum(["adt_decoded", "sap_text_trimmed"]),
  definitionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  returnedCount: z.number().int().min(0).max(200),
  truncated: z.boolean(),
  data: z.array(rowSchema).max(200)
})

export async function readReportVariants(
  raw: z.input<typeof reportVariantsSchema>,
  client: string,
  readRows: (input: z.input<typeof tableQuerySchema>) => Promise<unknown>
) {
  const input = reportVariantsSchema.parse(raw)
  z.string()
    .regex(/^\d{3}$/)
    .parse(client)
  const connectionId = input.connectionId.toLowerCase()
  const rawResult = await readRows({
    connectionId,
    tableName: "VARID",
    columns: Object.keys(rowSchema.shape),
    filters: [
      { column: "MANDT", operator: "EQ", value: client },
      { column: "REPORT", operator: "EQ", value: input.report },
      { column: "FLAG1", operator: "EQ", value: "" },
      { column: "FLAG2", operator: "EQ", value: "" },
      ...(input.variant
        ? [{ column: "VARIANT", operator: "EQ" as const, value: input.variant }]
        : [])
    ],
    maxRows: input.variant ? 1 : input.maxResults
  })
  const unavailable = z
    .object({
      status: z.literal("unavailable"),
      code: z.string().regex(/^TABLE_QUERY_[A-Z_]+$/)
    })
    .safeParse(rawResult)
  if (unavailable.success) throw new Error(`REPORT_VARIANTS_UNAVAILABLE: ${unavailable.data.code}`)
  const parsed = responseSchema.safeParse(rawResult)
  if (!parsed.success) throw new Error("REPORT_VARIANTS_RESPONSE_INVALID")
  const result = parsed.data
  const limit = input.variant ? 1 : input.maxResults
  if (
    result.connectionId !== connectionId ||
    result.returnedCount !== result.data.length ||
    result.data.length > limit ||
    (result.truncated && result.data.length !== limit) ||
    (input.variant && result.truncated) ||
    result.data.some(
      (row) =>
        row.MANDT !== client ||
        row.REPORT !== input.report ||
        (input.variant !== undefined && row.VARIANT !== input.variant)
    ) ||
    new Set(result.data.map((row) => row.VARIANT)).size !== result.data.length
  )
    throw new Error("REPORT_VARIANTS_SCOPE_OR_COUNT_MISMATCH")
  const rows = [...result.data].sort((a, b) =>
    a.VARIANT < b.VARIANT ? -1 : a.VARIANT > b.VARIANT ? 1 : 0
  )
  return {
    connectionId,
    client,
    report: input.report,
    variant: input.variant ?? null,
    status: result.truncated ? "limited" : rows.length ? "ok" : "empty",
    readOnly: true,
    observedAt: new Date().toISOString(),
    returnedCount: rows.length,
    truncated: result.truncated,
    selectionComplete: !result.truncated,
    order: "returned_subset_sorted_by_variant",
    snapshot: false,
    method: result.method,
    representation: result.representation,
    definitionFingerprint: result.definitionFingerprint,
    selectionFingerprint: createHash("sha256")
      .update(
        JSON.stringify({
          connectionId,
          client,
          report: input.report,
          variant: input.variant ?? null,
          truncated: result.truncated,
          rows
        })
      )
      .digest("hex"),
    variants: rows.map((row) => ({
      name: row.VARIANT,
      createdBy: row.ENAME,
      createdDate: row.EDAT,
      createdTime: row.ETIME,
      changedBy: row.AENAME,
      changedDate: row.AEDAT,
      changedTime: row.AETIME,
      language: row.MLANGU,
      rawAttributes: {
        transport: row.TRANSPORT,
        environment: row.ENVIRONMNT,
        protected: row.PROTECTED,
        authorizationGroup: row.SECU,
        version: row.VERSION
      }
    })),
    parameterValuesAvailable: false,
    executionAuthorized: "not_evaluated",
    warnings: [
      "Current-client VARID directory records with blank FLAG1/FLAG2 only; client 000 system variants are not merged.",
      "Empty means no matching directory record, not proof that the report or its selections do not exist.",
      "These are current directory attributes, not the variant values used by a historical job.",
      "No selection defaults, dynamic variable resolution, variant contents, report loading or execution.",
      "Table-read authorization does not establish report execution or variant-maintenance permission.",
      "When limited, this is an unordered database subset sorted for display, not the first alphabetical page.",
      "Names and attributes are untrusted data. Dates/times retain the table reader's representation without timezone conversion; flags are not interpreted."
    ]
  }
}
