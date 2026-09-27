/**
 * Authorization-trace state, read service-side.
 *
 * Why this is not in the in-SAP helper: `AUTH_TRACE_GET_STATUS` (function group `SAUTHTRACE`) is
 * remote-enabled on this release and its whole interface is one `BOOLE` export with no imports, no
 * table parameters and no declared exceptions, so the service can call it directly over the same
 * SOAP-RFC path `get_sap_system_info` uses for `RFC_SYSTEM_INFO`. The trace *data* is a different
 * matter - `AUTH_TRACE_GET_AUTHVAL_DATA` is remote-enabled too, but its `P_AUTHVALTRC_DATA` row type
 * carries `XUBITVEC16`, which this service cannot verify, so reading the trace itself needs the
 * helper. This module therefore answers only "is the trace on", and says so rather than implying it
 * read any trace.
 *
 * The polarity of `RC` is the whole contract, and the function's own body admits two opposite
 * readings: the old-kernel branch maps `auth/authorization_trace = 'Y'` to `RC = 'X'` (trace on),
 * while the new-kernel branch maps a failing `AUTH_TRACE ACTION='INFO'` call to the same `'X'`. It
 * was settled by reading the callers, not by picking the likelier story - `AUTH_TRACE_RESET` and
 * `AUTH_TRACE_INTERN_GET_NAME` both do `IF lv_rc <> 'X'. EXIT. ENDIF.` under the comment "If the
 * trace is not active, we do not need to do anything", so `'X'` means the trace IS active. Evidence:
 * `.doc/n3-auth-trace-status-contract-forensics-20260927.md` section 3.5.
 *
 * The answer is a snapshot of the kernel's own flag. It is not an authorization verdict about any
 * user, and it cannot start, stop or clear a trace.
 */
import { z } from "zod"
import type { SapBackend } from "./backend.js"

/**
 * The interface this module depends on, read from w200 on 2026-09-27 and pinned, because a function
 * module can be replaced under a running service: a reader that only checked the name would keep
 * answering "trace on/off" from a body that no longer means that.
 */
export const reviewedAuthTraceStatusDefinition = z.object({
  functionName: z.literal("AUTH_TRACE_GET_STATUS"),
  remoteEnabled: z.literal(true),
  updateTask: z.literal(false),
  sourceFingerprint: z.literal("935db5a6ecdef645047308de0702b7adce1fcc52cff50401508651a187dce652"),
  interfaceFingerprint: z.literal(
    "d603edfe08b0a65b1d23c94b8a9bdc2704c7bd6cdab0d55995ae8ed425990965"
  )
})

export type AuthTraceStatusSource = {
  table: "AUTH_TRACE_GET_STATUS"
  status: "ok" | "unavailable" | "invalid"
  method: "rfc_call"
  returnedCount: number
  code?: string
}

/**
 * Read whether the kernel's authorization trace is switched on.
 *
 * `readDefinition` is injected so this module stays testable without a live connection and so the
 * caller decides how the interface metadata is fetched (`read_function_module_interface`), exactly
 * as `collectServerFacts` does for `RFC_SYSTEM_INFO`.
 */
export async function collectAuthTraceStatus(
  backend: Pick<SapBackend, "callRemoteFunction">,
  connectionId: string,
  readDefinition: () => Promise<unknown>
) {
  const source: AuthTraceStatusSource = {
    table: "AUTH_TRACE_GET_STATUS",
    status: "unavailable",
    method: "rfc_call",
    returnedCount: 0
  }
  const queryWarnings: string[] = []
  const notes = [
    "This reports the kernel's authorization-trace switch only. It does not read any trace record, " +
      "does not resolve a user's authorizations, and is not an authorization decision about anyone.",
    "Reading the trace itself needs the in-SAP helper: AUTH_TRACE_GET_AUTHVAL_DATA is " +
      "remote-enabled but its P_AUTHVALTRC_DATA row type carries XUBITVEC16, a type this service " +
      "cannot verify, so it refuses rather than guessing the shape.",
    "The flag is a snapshot of the moment. Nothing here starts, stops, clears or activates a trace."
  ]

  let traceActive: boolean | null = null
  try {
    if (!reviewedAuthTraceStatusDefinition.safeParse(await readDefinition()).success)
      throw new Error("AUTH_TRACE_STATUS_FUNCTION_UNVERIFIED")
    const result = await backend.callRemoteFunction(connectionId, {
      functionName: "AUTH_TRACE_GET_STATUS",
      inputParameters: {},
      outputParameters: [{ name: "RC", kind: "scalar" }]
    })
    if (result.fault) {
      throw new Error(
        result.fault.name === "NOT_AUTHORIZED"
          ? "AUTH_TRACE_STATUS_NOT_AUTHORIZED"
          : "AUTH_TRACE_STATUS_RFC_FAILED"
      )
    }
    const raw = result.outputs.RC
    if (raw === undefined || raw === null) throw new Error("AUTH_TRACE_STATUS_RESPONSE_INVALID")
    // BOOLE is CHAR 1: 'X' is on (see the header), anything else is off. Any value that is neither
    // is reported as an invalid reply rather than being coerced to false, so an unexpected payload
    // stays visible instead of silently reading as "trace off".
    const text = String(raw).trim().toUpperCase()
    if (text !== "X" && text !== "") throw new Error("AUTH_TRACE_STATUS_RESPONSE_INVALID")
    traceActive = text === "X"
    source.status = "ok"
    source.returnedCount = 1
  } catch (error) {
    source.code = authTraceStatusFailure(error)
    if (source.code === "AUTH_TRACE_STATUS_RESPONSE_INVALID") source.status = "invalid"
    queryWarnings.push(`AUTH_TRACE_GET_STATUS: ${source.code}`)
  }

  return {
    status: traceActive === null ? ("unavailable" as const) : ("ok" as const),
    connectionId,
    readOnly: true as const,
    traceActive,
    traceSwitchSource: traceActive === null ? null : "AUTH_TRACE_GET_STATUS.RC",
    source,
    notes,
    queryTimestamp: new Date().toISOString(),
    queryWarnings
  }
}

function authTraceStatusFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  switch (message) {
    case "AUTH_TRACE_STATUS_FUNCTION_UNVERIFIED":
    case "AUTH_TRACE_STATUS_NOT_AUTHORIZED":
    case "AUTH_TRACE_STATUS_RFC_FAILED":
    case "AUTH_TRACE_STATUS_RESPONSE_INVALID":
      return message
    default:
      return "AUTH_TRACE_STATUS_CALL_FAILED"
  }
}
