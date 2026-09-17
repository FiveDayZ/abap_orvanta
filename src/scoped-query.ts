import type { RemoteFunctionRequest, RemoteFunctionResult } from "./backend.js"

const fields = ["MANDT", "WERKS", "ZPOSNR", "ZPKGMATNR", "ZPKGTYPE", "ZPKGDESC"]

export async function runScopedQueryFallback(
  sql: string,
  maxRows: number,
  client: string,
  nativeError: unknown,
  invoke: (request: RemoteFunctionRequest) => Promise<RemoteFunctionResult>
): Promise<Record<string, unknown>[]> {
  // Only the observed empty HTML response permits this scoped alternative.
  if (
    !(nativeError instanceof Error) ||
    !nativeError.message.startsWith(
      "SAP_DATA_QUERY_RESPONSE_INVALID: expected XML data preview; HTTP 200; mediaType=text/html; root=unparsed; bytes=0."
    )
  ) {
    throw nativeError
  }
  // This is a finite query grammar, not an arbitrary SQL-to-RFC translator.
  const match = sql.match(
    /^\s*SELECT\s+(\*|[A-Z_]+(?:(?:\s*,\s*|\s+)[A-Z_]+)*)\s+FROM\s+ZTPMC_BZWL\s+WHERE\s+WERKS\s*=\s*'([^']*)'\s*$/i
  )
  if (
    !match ||
    match[2] !== "809P" ||
    !Number.isInteger(maxRows) ||
    maxRows < 1 ||
    maxRows > 1001
  ) {
    throw nativeError
  }
  const columns = match[1] === "*" ? fields : match[1]!.toUpperCase().split(/[\s,]+/)
  if (
    new Set(columns).size !== columns.length ||
    columns.some((column) => !fields.includes(column))
  ) {
    throw nativeError
  }
  let result: RemoteFunctionResult
  try {
    result = await invoke({
      functionName: "Z_ORVANTA_MCP_QUERY_API",
      inputParameters: { IV_WERKS: "809P", IV_LIMIT: String(maxRows), ET_ROWS: [] },
      outputParameters: [
        ...["EV_STATUS", "EV_CODE", "EV_VERSION", "EV_COUNT"].map((name) => ({
          name,
          kind: "scalar" as const
        })),
        { name: "ET_ROWS", kind: "table", fields }
      ]
    })
  } catch {
    throw new Error("SAP_SCOPED_QUERY_FAILED: helper transport failed", { cause: nativeError })
  }
  const { EV_STATUS, EV_CODE, EV_VERSION, EV_COUNT, ET_ROWS } = result.outputs
  const reject = (): never => {
    // Do not echo helper faults or free-form response fields.
    throw new Error("SAP_SCOPED_QUERY_FAILED: helper rejected request or returned invalid data", {
      cause: nativeError
    })
  }
  if (
    result.fault ||
    EV_STATUS !== "S" ||
    EV_CODE !== "QUERY_OK" ||
    EV_VERSION !== "1.0" ||
    typeof EV_COUNT !== "string" ||
    !/^\d+$/.test(EV_COUNT) ||
    !Array.isArray(ET_ROWS) ||
    Number(EV_COUNT) !== ET_ROWS.length ||
    ET_ROWS.length > maxRows
  ) {
    return reject()
  }
  let lastKey = ""
  for (const row of ET_ROWS) {
    if (
      fields.some((field) => typeof row[field] !== "string") ||
      row.MANDT !== client ||
      row.WERKS !== "809P" ||
      !/^\d{6}$/.test(row.ZPOSNR ?? "") ||
      row.ZPOSNR! <= lastKey
    ) {
      return reject()
    }
    lastKey = row.ZPOSNR!
  }
  return ET_ROWS.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])))
}
