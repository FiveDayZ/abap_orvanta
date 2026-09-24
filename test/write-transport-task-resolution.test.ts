import assert from "node:assert/strict"
import test from "node:test"
import { resolveWriteTransportNumber, writeOperationContext } from "../src/mcp.js"
import { MockBackend } from "./mock-backend.js"

// 2026-09-24 incident: `resume_ddic_table_activation` for ZTPMC_TPRPI was refused with
// `TRANSPORT_RECORD_FAILED: 请求类型不允许 [ TK / 886 ]` because the caller passed the CTS *task*
// GR2K923428 where a *request* is required. E070 proves the relationship: GR2K923427 is
// `TRFUNCTION = 'K'` with an empty STRKORR, GR2K923428 is `'S'` with `STRKORR = 'GR2K923427'`.
//
// The helper sets `use_korrnum_immediatedly = 'X'`, so RS_CORR_INSERT takes its ELSE branch and
// passes the number as `iv_request` to TR_RECORD_OBJ_CHANGE_TO_REQ ->
// TRINT_OBJECTS_CHECK_AND_INSERT( iv_order = ... ), whose companion outputs are ev_order/ev_task:
// the task is derived from the request, never supplied as one.
//
// The first cut of this check read E070 through `SapBackend.runQuery`, whose native ADT data
// preview answers SAP_DATA_QUERY_RESPONSE_INVALID on this system, so the check failed on every
// call and the `catch` hid it - the release reproduced TK/886 exactly. The read is therefore
// injected, and a failure is reported rather than swallowed.

const taskRow = { TRKORR: "GR2K923428", TRFUNCTION: "S", STRKORR: "GR2K923427" }
const requestRow = { TRKORR: "GR2K923427", TRFUNCTION: "K", STRKORR: "" }

function reader(rows: Record<string, unknown>[], seen: string[] = []) {
  return async (_connectionId: string, container: string) => {
    seen.push(container)
    return rows
  }
}

test("a CTS task number is resolved to the request that owns it", async () => {
  const seen: string[] = []
  const values: Record<string, unknown> = { connectionId: "w200", transportNumber: "gr2k923428" }
  const resolution = await resolveWriteTransportNumber(
    values,
    new MockBackend(),
    reader([taskRow], seen)
  )
  assert.equal(resolution.requestedTaskNumber, "GR2K923428", "the caller's own value is reported")
  assert.equal(resolution.unresolvedReason, null)
  assert.equal(values.transportNumber, "GR2K923427", "the payload now names the request")
  assert.deepEqual(seen, ["GR2K923428"], "the container is upper-cased before it reaches SAP")
})

test("a request number is left exactly as the caller wrote it", async () => {
  const values: Record<string, unknown> = { connectionId: "w200", transportNumber: "GR2K923427" }
  const resolution = await resolveWriteTransportNumber(
    values,
    new MockBackend(),
    reader([requestRow])
  )
  assert.equal(resolution.requestedTaskNumber, null)
  assert.equal(resolution.unresolvedReason, null)
  assert.equal(values.transportNumber, "GR2K923427")
})

test("a container SAP does not know is reported, not silently passed on", async () => {
  const values: Record<string, unknown> = { connectionId: "w200", transportNumber: "GR2K999999" }
  const resolution = await resolveWriteTransportNumber(values, new MockBackend(), reader([]))
  assert.equal(resolution.requestedTaskNumber, null)
  assert.match(String(resolution.unresolvedReason), /no row for GR2K999999/)
  assert.equal(values.transportNumber, "GR2K999999", "it is never rewritten on a guess")
})

test("a failed lookup is reported instead of being swallowed", async () => {
  const values: Record<string, unknown> = { connectionId: "w200", transportNumber: "GR2K923428" }
  const resolution = await resolveWriteTransportNumber(values, new MockBackend(), async () => {
    throw new Error("SAP_DATA_QUERY_RESPONSE_INVALID: expected XML data preview")
  })
  assert.equal(resolution.requestedTaskNumber, null)
  assert.match(String(resolution.unresolvedReason), /E070 could not be read for GR2K923428/)
  assert.match(String(resolution.unresolvedReason), /SAP_DATA_QUERY_RESPONSE_INVALID/)
  assert.equal(
    values.transportNumber,
    "GR2K923428",
    "the helper's own rejection stays the backstop"
  )
})

test("an empty transport number never reaches SAP", async () => {
  const seen: string[] = []
  const values: Record<string, unknown> = { connectionId: "w200", transportNumber: "   " }
  const resolution = await resolveWriteTransportNumber(
    values,
    new MockBackend(),
    reader([taskRow], seen)
  )
  assert.equal(resolution.requestedTaskNumber, null)
  assert.equal(seen.length, 0)
})

test("the pre-change summary records the substitution beside the request it used", () => {
  const context = writeOperationContext(
    "resume_ddic_table_activation",
    { connectionId: "w200", transportNumber: "GR2K923427" },
    new MockBackend(),
    { requestedTaskNumber: "GR2K923428", unresolvedReason: null }
  )
  const summary = JSON.parse(context.preChangeSummary) as Record<string, unknown>
  assert.equal(summary.transportNumber, "GR2K923427")
  assert.equal(summary.requestedTaskNumber, "GR2K923428")
  assert.match(String(summary.transportResolution), /GR2K923428 is a CTS task/)
  assert.match(String(summary.transportResolution), /GR2K923427/)
  assert.equal("transportCheckWarning" in summary, false)
})

test("an unclassified container is recorded as a warning", () => {
  const context = writeOperationContext(
    "resume_ddic_table_activation",
    { connectionId: "w200", transportNumber: "GR2K923428" },
    new MockBackend(),
    { requestedTaskNumber: null, unresolvedReason: "connection refused" }
  )
  const summary = JSON.parse(context.preChangeSummary) as Record<string, unknown>
  assert.equal(summary.transportNumber, "GR2K923428", "the value is never rewritten on a guess")
  assert.match(String(summary.transportCheckWarning), /connection refused/)
  assert.equal("requestedTaskNumber" in summary, false)
})

test("no resolution leaves the pre-change summary unchanged", () => {
  const context = writeOperationContext(
    "resume_ddic_table_activation",
    { connectionId: "w200", transportNumber: "GR2K923427" },
    new MockBackend(),
    null
  )
  const summary = JSON.parse(context.preChangeSummary) as Record<string, unknown>
  assert.equal(summary.transportNumber, "GR2K923427")
  assert.equal("requestedTaskNumber" in summary, false)
  assert.equal("transportResolution" in summary, false)
  assert.equal("transportCheckWarning" in summary, false)
})
