import type { AdtHTTP } from "abap-adt-api/build/AdtHTTP.js"

export interface WhereUsedRequestTrace {
  stage: "discovery" | "mapping" | "metadata" | "references" | "modern_references"
  elapsedMs: number
  timeoutMs: number
  outcome: "response" | "timeout" | "request-failed" | "budget-exhausted"
  httpStatus?: number
  responseBytes?: number
}

export class WhereUsedRequestError extends Error {
  constructor(
    message: string,
    readonly requests: WhereUsedRequestTrace[],
    readonly engine: "ADT_WHERE_USED" | "ADT_RIS_WHEREUSED",
    cause: unknown
  ) {
    super(message, { cause })
  }
}

const stages = new Map<string, WhereUsedRequestTrace["stage"]>([
  ["/sap/bc/adt/discovery", "discovery"],
  ["/sap/bc/adt/repository/informationsystem/fullnamemapping", "mapping"],
  ["/sap/bc/adt/repository/informationsystem/metadata", "metadata"],
  ["/sap/bc/adt/repository/informationsystem/whereused", "references"],
  ["/sap/bc/adt/repository/informationsystem/usageReferences", "modern_references"]
])

export function whereUsedHttp(http: AdtHTTP) {
  const requests: WhereUsedRequestTrace[] = []
  const started = performance.now()
  // A per-query facade leaves the shared SAP client and other tools unchanged.
  const scoped = Object.create(http) as AdtHTTP
  scoped.request = async (path, options) => {
    const stage = stages.get(path)
    if (!stage) throw new Error("Unexpected where-used request endpoint")
    const remaining = Math.floor(45000 - (performance.now() - started))
    const entry: WhereUsedRequestTrace = {
      stage,
      elapsedMs: 0,
      timeoutMs: Math.max(0, Math.min(15000, remaining)),
      outcome: "budget-exhausted"
    }
    requests.push(entry)
    if (remaining <= 0) throw new Error(`Where-used request budget exhausted before ${stage}`)
    const began = performance.now()
    try {
      const response = await http.request(path, { ...options, timeout: entry.timeoutMs })
      entry.outcome = "response"
      entry.httpStatus = response.status
      entry.responseBytes = Buffer.byteLength(response.body, "utf8")
      return response
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      entry.outcome = /timeout|timed out|ECONNABORTED|ETIMEDOUT/i.test(message)
        ? "timeout"
        : "request-failed"
      throw error
    } finally {
      entry.elapsedMs = Math.round(performance.now() - began)
    }
  }
  return { http: scoped, requests }
}
