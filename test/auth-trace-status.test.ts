import assert from "node:assert/strict"
import test from "node:test"
import {
  AUTH_TRACE_KEY_LIMIT,
  collectAuthTraceRows,
  collectAuthTraceStatus,
  reviewedAuthTraceDataDefinition,
  reviewedAuthTraceKeyDefinition,
  reviewedAuthTraceStatusDefinition
} from "../src/auth-trace-status.js"
import type { RemoteFunctionRequest, SapBackend } from "../src/backend.js"

/**
 * `AUTH_TRACE_GET_STATUS.RC` is the whole contract of this read, and its polarity is the one thing
 * that could silently invert the answer. These tests pin it from both ends:
 *
 *  - the definition must carry BOTH fingerprints, so a replaced function module cannot keep
 *    answering from a body that no longer means what the caller thinks;
 *  - `'X'` must read as trace-active, because that is what SAP's own callers do with it
 *    (`AUTH_TRACE_RESET`, `AUTH_TRACE_INTERN_GET_NAME`: `IF lv_rc <> 'X'. EXIT. ENDIF.` under
 *    "If the trace is not active"). A future edit that flips this to `=== ""` turns the tool into
 *    a plausible-looking falsehood, which is exactly what these cases refuse.
 */

const pinnedDefinition = {
  functionName: "AUTH_TRACE_GET_STATUS",
  remoteEnabled: true,
  updateTask: false,
  sourceFingerprint: "935db5a6ecdef645047308de0702b7adce1fcc52cff50401508651a187dce652",
  interfaceFingerprint: "d603edfe08b0a65b1d23c94b8a9bdc2704c7bd6cdab0d55995ae8ed425990965"
}

function double(
  rc: unknown,
  options: { fault?: { code: string; name: string; message: string } } = {}
) {
  const requests: RemoteFunctionRequest[] = []
  const backend = {
    callRemoteFunction: async (_connection: string, request: RemoteFunctionRequest) => {
      requests.push(request)
      if (options.fault) return { outputs: {}, fault: options.fault }
      return { outputs: { RC: rc } }
    }
  }
  return { backend: backend as unknown as Pick<SapBackend, "callRemoteFunction">, requests }
}

test("AUTH_TRACE_GET_STATUS is called with the pinned interface and no inputs", async () => {
  const { backend, requests } = double("X")
  const result = await collectAuthTraceStatus(backend, "w200", async () => pinnedDefinition)
  assert.equal(result.status, "ok")
  assert.equal(result.traceActive, true)
  assert.equal(result.traceSwitchSource, "AUTH_TRACE_GET_STATUS.RC")
  assert.equal(result.readOnly, true)
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.functionName, "AUTH_TRACE_GET_STATUS")
  // The function module takes no input; sending one would be inventing a contract.
  assert.deepEqual(requests[0]?.inputParameters, {})
  assert.deepEqual(requests[0]?.outputParameters, [{ name: "RC", kind: "scalar" }])
})

test("RC='X' means the trace IS active, and a blank RC means it is not", async () => {
  // 'X' -> active. This is the assertion that would fail if the polarity were inverted.
  const active = await collectAuthTraceStatus(
    double("X").backend,
    "w200",
    async () => pinnedDefinition
  )
  assert.equal(active.traceActive, true)

  // ' ' -> inactive (BOOLE CHAR 1, unset).
  const inactive = await collectAuthTraceStatus(
    double(" ").backend,
    "w200",
    async () => pinnedDefinition
  )
  assert.equal(inactive.status, "ok")
  assert.equal(inactive.traceActive, false)

  // Lower-case x is the same value to the kernel; it must not be reported as unknown.
  const lower = await collectAuthTraceStatus(
    double("x").backend,
    "w200",
    async () => pinnedDefinition
  )
  assert.equal(lower.traceActive, true)
})

test("an unexpected RC value is invalid, never silently 'trace off'", async () => {
  const { backend } = double("Z")
  const result = await collectAuthTraceStatus(backend, "w200", async () => pinnedDefinition)
  assert.equal(result.status, "unavailable")
  assert.equal(result.traceActive, null)
  assert.equal(result.source.status, "invalid")
  assert.equal(result.source.code, "AUTH_TRACE_STATUS_RESPONSE_INVALID")
})

test("a missing RC export is invalid rather than an unavailable feature", async () => {
  const { backend } = double(undefined)
  const result = await collectAuthTraceStatus(backend, "w200", async () => pinnedDefinition)
  assert.equal(result.source.code, "AUTH_TRACE_STATUS_RESPONSE_INVALID")
  assert.equal(result.traceActive, null)
})

test("a definition that does not match the pinned fingerprints is refused", async () => {
  // A replaced function module must not keep answering: change only the source fingerprint.
  const { backend, requests } = double("X")
  const drifted = { ...pinnedDefinition, sourceFingerprint: "0".repeat(64) }
  const result = await collectAuthTraceStatus(backend, "w200", async () => drifted)
  assert.equal(result.status, "unavailable")
  assert.equal(result.traceActive, null)
  assert.equal(result.source.code, "AUTH_TRACE_STATUS_FUNCTION_UNVERIFIED")
  // The refusal happens before SAP is touched at all.
  assert.equal(requests.length, 0)
})

test("an interface drift is refused independently of the source fingerprint", async () => {
  const { backend, requests } = double("X")
  const drifted = { ...pinnedDefinition, interfaceFingerprint: "0".repeat(64) }
  const result = await collectAuthTraceStatus(backend, "w200", async () => drifted)
  assert.equal(result.source.code, "AUTH_TRACE_STATUS_FUNCTION_UNVERIFIED")
  assert.equal(requests.length, 0)
})

test("a not-authorized fault keeps its own code instead of becoming a generic failure", async () => {
  const { backend } = double("X", {
    fault: { code: "1", name: "NOT_AUTHORIZED", message: "no authority" }
  })
  const result = await collectAuthTraceStatus(backend, "w200", async () => pinnedDefinition)
  assert.equal(result.source.code, "AUTH_TRACE_STATUS_NOT_AUTHORIZED")
  assert.equal(result.traceActive, null)
})

test("the pinned definition rejects the three literals it does not verify", async () => {
  // Guards the pin itself: dropping a fingerprint from the schema would make the cases above pass
  // for the wrong reason.
  assert.equal(reviewedAuthTraceStatusDefinition.safeParse(pinnedDefinition).success, true)
  const noSource = { ...pinnedDefinition, sourceFingerprint: undefined }
  assert.equal(reviewedAuthTraceStatusDefinition.safeParse(noSource).success, false)
})

/**
 * The row half. Two things there can produce a plausible-looking falsehood rather than an error, and
 * both are pinned below:
 *
 *  - an EMPTY key list must never reach the data module, because `FOR ALL ENTRIES` over an empty
 *    driver table drops the entire `WHERE` and answers with the whole table, which would read as a
 *    perfectly successful bulk export;
 *  - `FIELDSUSED` is RAW(2) the service deliberately does not decode, so it must arrive verbatim
 *    rather than being interpreted, truncated or dropped.
 */

const pinnedKeyDefinition = {
  functionName: "AUTH_TRACE_GET_AUTHVAL_KEY",
  remoteEnabled: true,
  updateTask: false,
  sourceFingerprint: "74b8e04b500939e7db468a223df9aa3d98ac16650a8c6ea05000c997dbc6392c",
  interfaceFingerprint: "a161259ac6c983af19292556b3f0692e7c1adfe08fe0982671e97a7493b72fb2"
}

const pinnedDataDefinition = {
  functionName: "AUTH_TRACE_GET_AUTHVAL_DATA",
  remoteEnabled: true,
  updateTask: false,
  sourceFingerprint: "2ea7593f3ae6867782d2fe8926ff16d5b8dcf948d1ab270302ca1edd102aba1e",
  interfaceFingerprint: "76c7cc1ff6817726d3a24f144721353c932656b7530d2cd273078ce1edfd1113"
}

const traceRow = (overrides: Record<string, string> = {}) => ({
  NAME: "S_TCODE",
  TYPE: "TR",
  OBJECT: "S_TCODE",
  HASH: "0".repeat(40),
  ABAPPROG: "SAPLS001",
  ABAPLINE: "42",
  FIELDSUSED: "0300",
  FIELD1: "SE38",
  FIELD2: "",
  FIELD3: "",
  FIELD4: "",
  FIELD5: "",
  FIELD6: "",
  FIELD7: "",
  FIELD8: "",
  FIELD9: "",
  FIELD0: "",
  ...overrides
})

function traceDouble(
  options: {
    keys?: Array<Record<string, string>>
    rows?: Array<Record<string, string>>
    keyFault?: { code: string; name: string; message: string }
    dataFault?: { code: string; name: string; message: string }
  } = {}
) {
  const requests: RemoteFunctionRequest[] = []
  const backend = {
    callRemoteFunction: async (_connection: string, request: RemoteFunctionRequest) => {
      requests.push(request)
      if (request.functionName === "AUTH_TRACE_GET_AUTHVAL_KEY") {
        if (options.keyFault) return { outputs: {}, fault: options.keyFault }
        return { outputs: { P_AUTHVALTRC_KEY: options.keys ?? [] } }
      }
      if (options.dataFault) return { outputs: {}, fault: options.dataFault }
      const rows = options.rows ?? []
      return { outputs: { P_AUTHVALTRC_DATA: rows, P_DBCNT: String(rows.length) } }
    }
  }
  const readDefinition = async (functionName: string) =>
    functionName === "AUTH_TRACE_GET_AUTHVAL_KEY" ? pinnedKeyDefinition : pinnedDataDefinition
  return {
    backend: backend as unknown as Pick<SapBackend, "callRemoteFunction">,
    requests,
    readDefinition
  }
}

test("the keys are read first and handed to the data read as NAME/TYPE only", async () => {
  const { backend, requests, readDefinition } = traceDouble({
    keys: [
      { NAME: "S_TCODE", TYPE: "TR" },
      { NAME: "S_TABU_DIS", TYPE: "TR" }
    ],
    rows: [traceRow(), traceRow({ NAME: "S_TABU_DIS" })]
  })
  const result = await collectAuthTraceRows(backend, "w200", readDefinition, { maxRows: 200 })
  assert.equal(result.traceRowSource.status, "ok")
  assert.equal(result.traceRowSource.keysAvailable, 2)
  assert.equal(result.traceRowSource.keysUsed, 2)
  assert.equal(result.traceRows.length, 2)
  assert.equal(result.traceRowSource.sapCount, 2)
  assert.deepEqual(
    requests.map((request) => request.functionName),
    ["AUTH_TRACE_GET_AUTHVAL_KEY", "AUTH_TRACE_GET_AUTHVAL_DATA"]
  )
  // The callee's WHERE only reads name and type, so only those are sent. OBJECT/HASH are not
  // invented - sending them would silently filter on values the caller never supplied.
  assert.deepEqual(requests[1]?.inputParameters, {
    P_AUTHVALTRC_KEY: [
      { NAME: "S_TCODE", TYPE: "TR" },
      { NAME: "S_TABU_DIS", TYPE: "TR" }
    ]
  })
})

test("an empty key list never reaches the data module", async () => {
  // This is the FAE trap: the callee's `for all entries in p_authvaltrc_key` with an EMPTY driver
  // table drops the whole WHERE and answers with the entire USOB_AUTHVALTRC. A read that must stay
  // targeted therefore has to stop before the call, not after it.
  const { backend, requests, readDefinition } = traceDouble({ keys: [], rows: [traceRow()] })
  const result = await collectAuthTraceRows(backend, "w200", readDefinition, { maxRows: 200 })
  assert.equal(result.traceRowSource.status, "empty")
  assert.equal(result.traceRows.length, 0)
  assert.deepEqual(
    requests.map((request) => request.functionName),
    ["AUTH_TRACE_GET_AUTHVAL_KEY"]
  )
})

test("authorizationObject filters the keys exactly and keeps the data read skipped when nothing matches", async () => {
  const { backend, requests, readDefinition } = traceDouble({
    keys: [
      { NAME: "S_TCODE", TYPE: "TR" },
      { NAME: "S_TABU_DIS", TYPE: "TR" }
    ],
    rows: [traceRow()]
  })
  const mismatch = await collectAuthTraceRows(backend, "w200", readDefinition, {
    authorizationObject: "s_tcode",
    maxRows: 200
  })
  // Case-sensitive on purpose: SAP stores the object name upper-cased, and a filter this module
  // normalised would hide the caller's typo instead of answering "no trace row for that name".
  assert.equal(mismatch.traceRowSource.keysSelected, 0)
  assert.equal(mismatch.traceRowSource.status, "empty")
  assert.equal(mismatch.authorizationObjectFilter, "s_tcode")
  assert.deepEqual(
    requests.map((request) => request.functionName),
    ["AUTH_TRACE_GET_AUTHVAL_KEY"]
  )

  const {
    backend: exactBackend,
    requests: exactRequests,
    readDefinition: exactRead
  } = traceDouble({
    keys: [
      { NAME: "S_TCODE", TYPE: "TR" },
      { NAME: "S_TABU_DIS", TYPE: "TR" }
    ],
    rows: [traceRow()]
  })
  const matched = await collectAuthTraceRows(exactBackend, "w200", exactRead, {
    authorizationObject: "S_TABU_DIS",
    maxRows: 200
  })
  assert.equal(matched.traceRowSource.keysSelected, 1)
  assert.equal(matched.traceRowSource.keysUsed, 1)
  assert.deepEqual(exactRequests[1]?.inputParameters, {
    P_AUTHVALTRC_KEY: [{ NAME: "S_TABU_DIS", TYPE: "TR" }]
  })
})

test("FIELDSUSED arrives verbatim and is never decoded", async () => {
  const { backend, readDefinition } = traceDouble({
    keys: [{ NAME: "S_TCODE", TYPE: "TR" }],
    rows: [traceRow({ FIELDSUSED: "0300" })]
  })
  const result = await collectAuthTraceRows(backend, "w200", readDefinition, { maxRows: 200 })
  assert.equal(result.traceRows[0]?.FIELDSUSED, "0300")
  assert.equal(result.traceRows[0]?.FIELD1, "SE38")
  // Whatever the transport delivered is what the caller sees: the bit-to-slot mapping is applied on
  // a path this service cannot read, so it must not be guessed into a field list.
  assert.ok(result.notes.some((note) => note.includes("FIELDSUSED is returned verbatim")))
})

test("more keys than the ceiling are truncated, and the truncation is reported", async () => {
  const keys = Array.from({ length: AUTH_TRACE_KEY_LIMIT + 5 }, (_, index) => ({
    NAME: `Z_OBJ_${String(index).padStart(4, "0")}`,
    TYPE: "TR"
  }))
  const { backend, requests, readDefinition } = traceDouble({ keys, rows: [] })
  const result = await collectAuthTraceRows(backend, "w200", readDefinition, { maxRows: 200 })
  assert.equal(result.traceRowSource.keysAvailable, AUTH_TRACE_KEY_LIMIT + 5)
  assert.equal(result.traceRowSource.keysUsed, AUTH_TRACE_KEY_LIMIT)
  assert.equal(result.traceRowSource.keysTruncated, true)
  const sent = requests[1]?.inputParameters?.P_AUTHVALTRC_KEY as unknown[]
  assert.equal(sent.length, AUTH_TRACE_KEY_LIMIT)
})

test("rows beyond maxRows are cut client-side and reported, never silently dropped", async () => {
  const { backend, readDefinition } = traceDouble({
    keys: [{ NAME: "S_TCODE", TYPE: "TR" }],
    rows: [traceRow(), traceRow({ FIELD1: "SE80" }), traceRow({ FIELD1: "SE16" })]
  })
  const result = await collectAuthTraceRows(backend, "w200", readDefinition, { maxRows: 2 })
  assert.equal(result.traceRows.length, 2)
  assert.equal(result.traceRowsTruncated, true)
  assert.equal(result.traceRowSource.returnedCount, 3)
})

test("a drifted key or data definition is refused before the call it guards", async () => {
  const drifted = traceDouble({ keys: [{ NAME: "S_TCODE", TYPE: "TR" }], rows: [traceRow()] })
  const badKey = await collectAuthTraceRows(
    drifted.backend,
    "w200",
    async () => ({ ...pinnedKeyDefinition, sourceFingerprint: "0".repeat(64) }),
    { maxRows: 200 }
  )
  assert.equal(badKey.traceRowSource.code, "AUTH_TRACE_KEY_FUNCTION_UNVERIFIED")
  assert.equal(drifted.requests.length, 0)

  const keyOk = traceDouble({ keys: [{ NAME: "S_TCODE", TYPE: "TR" }], rows: [traceRow()] })
  const badData = await collectAuthTraceRows(
    keyOk.backend,
    "w200",
    async (functionName: string) =>
      functionName === "AUTH_TRACE_GET_AUTHVAL_KEY"
        ? pinnedKeyDefinition
        : { ...pinnedDataDefinition, interfaceFingerprint: "0".repeat(64) },
    { maxRows: 200 }
  )
  assert.equal(badData.traceRowSource.code, "AUTH_TRACE_DATA_FUNCTION_UNVERIFIED")
  // The key read already happened; the data read must not.
  assert.deepEqual(
    keyOk.requests.map((request) => request.functionName),
    ["AUTH_TRACE_GET_AUTHVAL_KEY"]
  )
})

test("a fault names the half that failed instead of collapsing into one code", async () => {
  const keyFailure = traceDouble({
    keyFault: { code: "1", name: "NOT_AUTHORIZED", message: "no authority" }
  })
  const keyResult = await collectAuthTraceRows(
    keyFailure.backend,
    "w200",
    keyFailure.readDefinition,
    { maxRows: 200 }
  )
  assert.equal(keyResult.traceRowSource.code, "AUTH_TRACE_KEY_NOT_AUTHORIZED")
  assert.equal(keyResult.status, "unavailable")

  const dataFailure = traceDouble({
    keys: [{ NAME: "S_TCODE", TYPE: "TR" }],
    dataFault: { code: "1", name: "NOT_AUTHORIZED", message: "no authority" }
  })
  const dataResult = await collectAuthTraceRows(
    dataFailure.backend,
    "w200",
    dataFailure.readDefinition,
    { maxRows: 200 }
  )
  assert.equal(dataResult.traceRowSource.code, "AUTH_TRACE_DATA_NOT_AUTHORIZED")
  assert.equal(dataResult.traceRows.length, 0)
})

test("a row that is not the projected shape is an invalid response, not an empty one", async () => {
  const { backend, readDefinition } = traceDouble({
    keys: [{ NAME: "S_TCODE", TYPE: "TR" }],
    rows: [{ ...traceRow(), ABAPLINE: 42 as unknown as string }]
  })
  const result = await collectAuthTraceRows(backend, "w200", readDefinition, { maxRows: 200 })
  assert.equal(result.traceRowSource.status, "invalid")
  assert.equal(result.traceRowSource.code, "AUTH_TRACE_DATA_RESPONSE_INVALID")
})

test("the two row-half pins reject the literals they do not verify", () => {
  assert.equal(reviewedAuthTraceKeyDefinition.safeParse(pinnedKeyDefinition).success, true)
  assert.equal(reviewedAuthTraceDataDefinition.safeParse(pinnedDataDefinition).success, true)
  assert.equal(
    reviewedAuthTraceKeyDefinition.safeParse({ ...pinnedKeyDefinition, remoteEnabled: false })
      .success,
    false
  )
  assert.equal(
    reviewedAuthTraceDataDefinition.safeParse({ ...pinnedDataDefinition, updateTask: true })
      .success,
    false
  )
})
