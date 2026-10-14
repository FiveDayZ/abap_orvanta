import { createHash } from "node:crypto"
import { z } from "zod"
import { configurationUnitApiBody } from "./configuration-unit-api.js"

// Deployment candidate only. No SAP call or new native-test budget is granted here.
const strings = (names: readonly string[]) =>
  names.map((name) => ({ name, typeName: "STRING", optional: false, passByValue: true }))
export const configurationBteContextProofApi = {
  functionName: "Z_ORVANTA_CFG_BTE_CTXCHECK",
  functionGroup: "ZORVANTA_BTE_CFG",
  remoteEnabled: true,
  updateTask: false,
  globalInterface: false,
  importParameters: strings(["IV_REQUEST", "IV_CONFIRM"]),
  exportParameters: strings([
    "EV_CODE",
    "EV_SYSTEM",
    "EV_CLIENT",
    "EV_USER",
    "EV_REQUEST",
    "EV_PREVIOUS",
    "EV_COUNT"
  ]),
  changingParameters: [],
  tableParameters: [],
  exceptions: [],
  source: String.raw`
* Fixed memory-only probe. Never reads or changes business/CTS data.
  STATICS: lv_previous TYPE string, lv_count TYPE i.
  CLEAR: ev_code, ev_system, ev_client, ev_user,
         ev_request, ev_previous, ev_count.
  ev_system = sy-sysid. ev_client = sy-mandt. ev_user = sy-uname.
  ev_code = 'SCOPE_UNSUPPORTED'.
  IF sy-sysid <> 'GR2' OR sy-mandt <> '200' OR sy-uname <> 'WYS'.
    RETURN.
  ENDIF.
  IF iv_confirm <> 'MEMORY_CONTEXT_PROBE_ONLY' OR
     strlen( iv_request ) <> 64 OR
     iv_request CN '0123456789abcdef'.
    ev_code = 'INPUT_INVALID'. RETURN.
  ENDIF.
  IF iv_request = lv_previous.
    ev_code = 'REPEATED_MARKER'. RETURN.
  ENDIF.
  IF lv_count >= 2.
    ev_code = 'CONTEXT_PROBE_LIMIT'. RETURN.
  ENDIF.
  ev_previous = lv_previous. ev_request = iv_request.
  ADD 1 TO lv_count. lv_previous = iv_request.
  IF lv_count = 1.
    ev_count = '1'. ev_code = 'CONTEXT_NEW'.
  ELSE.
    ev_count = '2'. ev_code = 'CONTEXT_REUSED'.
  ENDIF.
`
    .trim()
    .split("\n")
} as const

export const configurationBteContextProofBodyFingerprint = createHash("sha256")
  .update(configurationUnitApiBody(configurationBteContextProofApi.source))
  .digest("hex")

const marker = z.string().regex(/^[a-f0-9]{64}$/)
const reply = z
  .object({
    EV_CODE: z.enum(["CONTEXT_NEW", "CONTEXT_REUSED"]),
    EV_SYSTEM: z.literal("GR2"),
    EV_CLIENT: z.literal("200"),
    EV_USER: z.literal("WYS"),
    EV_REQUEST: marker,
    EV_PREVIOUS: z.union([z.literal(""), marker]),
    EV_COUNT: z.enum(["1", "2"])
  })
  .strict()

/** Two distinct calls are needed. A positive observation still grants no SAVE/RECOVER permission. */
export function inspectConfigurationBteContextProof(
  requestMarkers: readonly string[],
  rawReplies: unknown
) {
  const requests = z.array(marker).length(2).parse(requestMarkers)
  if (requests[0] === requests[1]) throw Error("BTE_CONTEXT_MARKERS_NOT_UNIQUE")
  const replies = z.array(reply).length(2).parse(rawReplies)
  for (const [index, value] of replies.entries()) {
    if (
      value.EV_REQUEST !== requests[index] ||
      (value.EV_CODE === "CONTEXT_NEW" && (value.EV_COUNT !== "1" || value.EV_PREVIOUS !== "")) ||
      (value.EV_CODE === "CONTEXT_REUSED" && (value.EV_COUNT !== "2" || value.EV_PREVIOUS === ""))
    )
      throw Error("BTE_CONTEXT_RESPONSE_UNVERIFIED")
  }
  return {
    status: "context_observed" as const,
    freshNativeContextObserved: replies.every((r) => r.EV_CODE === "CONTEXT_NEW"),
    observations: replies,
    observationCount: 2,
    requiredNativeCallBudget: 2,
    transactionVerified: false,
    sessionCleanupVerified: false,
    writeAvailable: false,
    automaticRetry: false
  }
}
