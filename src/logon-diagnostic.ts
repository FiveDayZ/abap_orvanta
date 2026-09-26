/**
 * Telling a rejected logon apart from an object-level authorization refusal.
 *
 * SAP answers both with a 4xx, but they call for opposite responses. A 403 means the session is
 * valid and this user may not touch this object: the request should change, not the credentials. A
 * 401 means SAP refused the logon itself, so *every* call fails the same way and nothing about the
 * target explains it.
 *
 * The incident of 2026-09-26 10:40 is the case in point: an object creation, an ADT source read and
 * a SOAP ping all answered "Request failed with status code 401", and the caller had to work out
 * from a separate `sap_helper_status` call that the SAP user's logon data was wrong. The status was
 * never the missing information - the *meaning* was, and the service already had it.
 *
 * This module is the single translation point for that meaning: one marker test, one wording, one
 * stable code, used by every place that classifies or reports a SAP failure.
 */

/** Stable code for a rejected logon, so a caller branches on a code instead of an English sentence. */
export const LOGON_REJECTED = "SAP_LOGON_REJECTED"

/** The capability category a rejected logon is reported under, kept distinct from a 403. */
export const LOGON_REJECTION_CATEGORY = "logon-rejected"

/**
 * Markers that can only come from a failed logon.
 *
 * `ICF-LE-http` is the ICF logon error code SAP prints, and "Logon Error"/"登录失败"/"logon data"
 * are its wording; the ADT and SOAP-RFC channels both name the status in their text. "Unauthorized"
 * alone is deliberately *not* accepted: it appears in ordinary authorization text, and a 403 must
 * never be reported as a logon failure. A bare `status` property is not evidence either - the
 * library defaults unknown failures to HTTP 500, which once made a local parse crash look like a
 * server fault - so only SAP's own words count here, and the numeric path stays guarded by
 * `reportedHttpStatus` in `adt-backend.ts`.
 */
const LOGON_MARKER = /ICF-LE-http|logon error|logon data|登录失败|status code 401|HTTP 401\b/i

/** True when the text can only have come from SAP refusing the logon. */
export function describesLogonRejection(text: string): boolean {
  return LOGON_MARKER.test(text)
}

/**
 * True when this failure is a rejected logon.
 *
 * `status` must already be evidence-backed by the caller (see `reportedHttpStatus`); this function
 * never reads a status off an arbitrary error object.
 */
export function isLogonRejection(status: number, message: string): boolean {
  return status === 401 || describesLogonRejection(message)
}

/** The actionable explanation for a failure the caller could not otherwise act on. */
export function logonDiagnostic(connectionId?: string): string {
  const connection = connectionId ? ` for connection "${connectionId}"` : ""
  return (
    `${LOGON_REJECTED}: SAP refused the logon itself (HTTP 401)${connection}, so this failed before ` +
    "the request reached the object - a wrong object name, package or authorization cannot explain " +
    "it, and every other SAP call fails the same way. Check, in this order: the password held by the " +
    "connection's `passwordEnv` variable (an expired or rotated SAP password is the usual cause), " +
    "whether the SAP user is locked, and the client number. The service reads the password when it " +
    "builds the SAP client, so correct the credential and restart the service; a retry against the " +
    "same running process reuses the rejected logon."
  )
}

/** Append the logon diagnosis to a failure text that describes a rejected logon; otherwise return it. */
export function annotateLogonRejection(text: string, connectionId?: string): string {
  if (!describesLogonRejection(text)) return text
  return `${text}\n\n${logonDiagnostic(connectionId)}`
}
