import assert from "node:assert/strict"
import test from "node:test"
import {
  TRANSPORT_IMPORT_VERDICTS,
  type ImportHelperReply,
  transportImportResult,
  transportImportVerdict
} from "../src/transport-import.js"

/**
 * The 2.18 reply is the correction of a measured defect, so what is pinned here is exactly what the
 * 2.17 arm got wrong on w200 on 2026-09-29:
 *
 *  - it turned the callee's exception number into a meaning (`no-authority`, `not-allowed`), and a
 *    real call showed a failed tp start arriving under one of those numbers;
 *  - it dropped every payload row when it reported a failure, so that reply named no request;
 *  - the same request returned two different outcomes minutes apart.
 *
 * The properties below make the reply mechanical instead: the verdict is the callee's own exception
 * name, the raw sub-return code travels beside it, and every path carries the request and the local
 * E070 status.
 */

function reply(overrides: Partial<ImportHelperReply> = {}): ImportHelperReply {
  return {
    status: "S",
    code: "TRANSPORT_IMPORT_CHECKED",
    message: "Import check answered without importing",
    metadata: {
      TRKORR: "GR2K918001",
      SIMULATE_MODE: "L",
      CALLEE_SUBRC: "3",
      IMPORTABLE: "",
      VERDICT: "enqueue_failed",
      LOCAL_E070_STATUS: "R",
      MESSAGE: "the import for request GR2K918001 has already run"
    },
    messages: [],
    ...overrides
  }
}

test("a declared exception is an answer carrying the callee's own name and number", () => {
  const result = transportImportResult("w200", reply())
  assert.equal(result.status, "ok")
  assert.equal(result.code, "TRANSPORT_IMPORT_CHECKED")
  assert.equal(result.verdict, "enqueue_failed")
  assert.equal(result.calleeSubrc, 3)
  assert.equal(result.importable, false)
  // the three fields the 2.17 failure path used to blank out
  assert.equal(result.transportNumber, "GR2K918001")
  assert.equal(result.simulateMode, "L")
  assert.equal(result.localE070Status, "R")
  assert.equal(result.helperMessage, "the import for request GR2K918001 has already run")
})

test("an undeclared exception is the one failure, and it is still attributable", () => {
  const result = transportImportResult(
    "w200",
    reply({
      status: "E",
      code: "TRANSPORT_IMPORT_CHECK_FAILED",
      message: "Undeclared exception from the callee",
      metadata: { ...reply().metadata, CALLEE_SUBRC: "99", VERDICT: "unknown", IMPORTABLE: "" }
    })
  )
  assert.equal(result.status, "failed")
  assert.equal(result.code, "TRANSPORT_IMPORT_CHECK_FAILED")
  assert.equal(result.verdict, "unknown")
  assert.equal(result.calleeSubrc, 99)
  assert.equal(result.transportNumber, "GR2K918001")
  assert.equal(result.localE070Status, "R")
})

test("the importable answer is the only one that reports importable", () => {
  const result = transportImportResult(
    "w200",
    reply({
      message: "Import check passed without importing",
      metadata: { ...reply().metadata, CALLEE_SUBRC: "0", IMPORTABLE: "X", VERDICT: "importable" }
    })
  )
  assert.equal(result.status, "ok")
  assert.equal(result.importable, true)
  assert.equal(result.verdict, "importable")
  assert.equal(result.calleeSubrc, 0)
})

test("a verdict outside the closed vocabulary is replaced, never passed through", () => {
  // an ad-hoc helper string must not look like part of this contract
  assert.equal(transportImportVerdict("not-allowed"), "unknown")
  assert.equal(transportImportVerdict("no-authority"), "unknown")
  assert.equal(transportImportVerdict(" ENQUEUE_FAILED "), "enqueue_failed")
  for (const verdict of TRANSPORT_IMPORT_VERDICTS) {
    assert.equal(transportImportVerdict(verdict), verdict)
  }
  const result = transportImportResult(
    "w200",
    reply({ metadata: { ...reply().metadata, VERDICT: "not-allowed" } })
  )
  assert.equal(result.verdict, "unknown")
})

test("a success reply without the sub-return code is invalid, not a precheck without evidence", () => {
  const metadata = { ...reply().metadata }
  delete (metadata as Record<string, string>)["CALLEE_SUBRC"]
  assert.throws(
    () => transportImportResult("w200", reply({ metadata })),
    /TRANSPORT_RESPONSE_INVALID/
  )
})

test("an input refusal keeps its own code and carries no verdict", () => {
  const result = transportImportResult("w200", {
    status: "E",
    code: "TRANSPORT_NUMBER_INVALID",
    message: "A transport number is exactly 10 characters",
    metadata: {},
    messages: []
  })
  assert.equal(result.status, "failed")
  assert.equal(result.code, "TRANSPORT_NUMBER_INVALID")
  assert.equal(result.calleeSubrc, null)
  assert.equal(result.verdict, "unknown")
})

test("the reply never claims the tool did not touch tp", () => {
  const warnings = transportImportResult("w200", reply()).warnings.join(" ")
  assert.match(warnings, /makes no claim that no tp process was started/)
  assert.match(warnings, /does not interpret it/)
})
