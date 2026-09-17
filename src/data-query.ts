import type { AdtHTTP, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js"
import { decodeQueryResult, parseQueryResponse } from "abap-adt-api/build/api/tablecontents.js"
import { parse } from "abap-adt-api/build/utilities.js"

export async function runSapDataQuery(
  http: Pick<AdtHTTP, "request">,
  sql: string,
  maxRows: number
): Promise<Record<string, unknown>[]> {
  const response = await http.request("/sap/bc/adt/datapreview/freestyle", {
    qs: { rowNumber: maxRows },
    headers: { Accept: "application/*", "Content-Type": "text/plain" },
    method: "POST",
    body: sql
  })
  return parseSapDataQueryResponse(response)
}

export function parseSapDataQueryResponse(
  response: Pick<HttpClientResponse, "body" | "status" | "headers">
): Record<string, unknown>[] {
  const { body, status } = response
  const contentType = Object.entries(response.headers).find(
    ([name]) => name.toLowerCase() === "content-type"
  )?.[1]
  const mediaType =
    String(contentType ?? "")
      .split(";", 1)[0]
      ?.trim()
      .toLowerCase() ?? ""
  let root = "unparsed"
  const reject = (reason: string): never => {
    // Never expose response text, SQL, cookies, or authentication headers.
    const safeMediaType = /^[a-z0-9.+/-]{1,100}$/.test(mediaType) ? mediaType : "unknown"
    throw new Error(
      `SAP_DATA_QUERY_RESPONSE_INVALID: ${reason}; HTTP ${status}; mediaType=${safeMediaType}; root=${root}; bytes=${Buffer.byteLength(body)}. No empty result was inferred.`
    )
  }
  if (status < 200 || status >= 300) reject("unsuccessful status")
  if (
    mediaType &&
    mediaType !== "application/xml" &&
    mediaType !== "text/xml" &&
    !mediaType.endsWith("+xml")
  ) {
    reject("expected XML data preview")
  }
  let document: Record<string, unknown>
  try {
    document = parse(body, { removeNSPrefix: true, parseTagValue: false })
  } catch {
    return reject("XML parsing failed")
  }
  if (!document || typeof document !== "object") return reject("missing XML document")
  const roots = Object.keys(document).filter((name) => !name.startsWith("?"))
  const name = roots[0] ?? "empty"
  root = /^[A-Za-z_][A-Za-z0-9_.-]{0,59}$/.test(name) ? name : "unknown"
  if (roots.length !== 1 || root !== "tableData") return reject("unsupported response envelope")
  const table = document.tableData
  if (!table || typeof table !== "object") return reject("missing table metadata")
  if (["error", "errors", "exception", "fault"].some((key) => Object.hasOwn(table, key))) {
    return reject("data preview reported an error")
  }
  let result: ReturnType<typeof parseQueryResponse>
  try {
    result = parseQueryResponse(body)
  } catch {
    return reject("invalid column layout")
  }
  if (!result.columns.length) return reject("missing column metadata")
  const names = result.columns.map((column) => column.name)
  if (names.some((column) => !column) || new Set(names).size !== names.length) {
    return reject("missing or duplicate column names")
  }
  if (result.columns.some((column) => !column.type)) return reject("missing column types")
  if (
    result.values.some((row: Record<string, unknown>) =>
      names.some((column) => row[column] === undefined || typeof row[column] === "object")
    )
  ) {
    return reject("incomplete or non-scalar column data")
  }
  return decodeQueryResult(result).values as Record<string, unknown>[]
}
