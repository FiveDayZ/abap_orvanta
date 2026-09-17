import { randomUUID } from "node:crypto"
import type { ADTClient } from "abap-adt-api"

const requiredEndpoints = [
  "/sap/bc/adt/debugger",
  "/sap/bc/adt/debugger/listeners",
  "/sap/bc/adt/debugger/breakpoints"
]

export interface DebugPrecheck {
  status: "metadata_available" | "not_advertised" | "blocked" | "failed"
  readOnly: true
  listenerStarted: false
  executionValidated: false
  discovery: {
    status: "returned" | "failed"
    advertisedEndpoints: string[]
    missingEndpoints: string[]
    failure?: DebugRequestFailure
  }
  listenerCheck: {
    status: "not_attempted" | "returned" | "conflict" | "not_found_ambiguous" | "failed"
    failure?: DebugRequestFailure
  }
}

interface DebugRequestFailure {
  category: "not-found-ambiguous" | "forbidden-or-not-authorized" | "request-failed"
  httpStatus: number | null
}

export function debugRequestFailure(error: unknown): DebugRequestFailure {
  const value = error as {
    status?: unknown
    err?: unknown
    response?: { status?: unknown }
    message?: unknown
  } | null
  const reported = [value?.response?.status, value?.status, value?.err].find(
    (status): status is number =>
      typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
  )
  const message = typeof value?.message === "string" ? value.message : ""
  const parsed = Number(message.match(/(?:status code|error)\s+([1-5]\d{2})\b/i)?.[1] ?? 0)
  const status = reported || parsed
  return {
    category:
      status === 404
        ? "not-found-ambiguous"
        : status === 401 || status === 403
          ? "forbidden-or-not-authorized"
          : "request-failed",
    httpStatus: status || null
  }
}

export async function inspectDebugger(
  client: Pick<ADTClient, "adtDiscovery" | "debuggerListeners">,
  debugUser: string
): Promise<DebugPrecheck> {
  const result: DebugPrecheck = {
    status: "failed",
    readOnly: true,
    listenerStarted: false,
    executionValidated: false,
    discovery: {
      status: "failed",
      advertisedEndpoints: [],
      missingEndpoints: [...requiredEndpoints]
    },
    listenerCheck: { status: "not_attempted" }
  }
  try {
    const workspaces = await client.adtDiscovery()
    const advertised = new Set(workspaces.flatMap((w) => w.collection.map((c) => c.href)))
    result.discovery = {
      status: "returned",
      advertisedEndpoints: requiredEndpoints.filter((path) => advertised.has(path)),
      missingEndpoints: requiredEndpoints.filter((path) => !advertised.has(path))
    }
  } catch (error) {
    result.discovery.failure = debugRequestFailure(error)
    return result
  }
  if (result.discovery.missingEndpoints.length) {
    // Missing advertisement is not proof that a route or all SAP debugging is absent.
    result.status = "not_advertised"
    return result
  }
  try {
    const id = () => randomUUID().replaceAll("-", "").toUpperCase()
    const conflict = await client.debuggerListeners("user", id(), id(), debugUser, true)
    result.listenerCheck.status = conflict ? "conflict" : "returned"
    result.status = conflict ? "blocked" : "metadata_available"
  } catch (error) {
    const failure = debugRequestFailure(error)
    result.listenerCheck = {
      status: failure.httpStatus === 404 ? "not_found_ambiguous" : "failed",
      failure
    }
    result.status = failure.httpStatus === 404 ? "blocked" : "failed"
  }
  return result
}
