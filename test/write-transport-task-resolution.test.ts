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

function backendWith(row: Record<string, unknown> | null, queries: string[] = []): MockBackend {
  const backend = new MockBackend()
  backend.runQuery = async (_connectionId, sql) => {
    queries.push(sql)
    return row ? [row] : []
  }
  return backend
}

const taskRow = { TRKORR: "GR2K923428", TRFUNCTION: "S", STRKORR: "GR2K923427" }
const requestRow = { TRKORR: "GR2K923427", TRFUNCTION: "K", STRKORR: "" }

test("a CTS task number is resolved to the request that owns it", async () => {
  const queries: string[] = []
  const values: Record<string, unknown> = { connectionId: "w200", transportNumber: "gr2k923428" }
  const resolved = await resolveWriteTransportNumber(values, backendWith(taskRow, queries))
  assert.equal(resolved, "GR2K923428", "the caller's own value is reported back")
  assert.equal(values.transportNumber, "GR2K923427", "the payload now names the request")
  assert.equal(queries.length, 1)
  assert.match(queries[0] ?? "", /FROM E070 WHERE TRKORR = 'GR2K923428'/)
})

test("a request number is left exactly as the caller wrote it", async () => {
  const values: Record<string, unknown> = { connectionId: "w200", transportNumber: "GR2K923427" }
  assert.equal(await resolveWriteTransportNumber(values, backendWith(requestRow)), null)
  assert.equal(values.transportNumber, "GR2K923427")
})

test("an unknown number is left alone rather than rewritten on a guess", async () => {
  const values: Record<string, unknown> = { connectionId: "w200", transportNumber: "GR2K999999" }
  assert.equal(await resolveWriteTransportNumber(values, backendWith(null)), null)
  assert.equal(values.transportNumber, "GR2K999999")
})

test("a lookup failure does not block the write", async () => {
  const backend = new MockBackend()
  backend.runQuery = async () => {
    throw new Error("E070 unavailable")
  }
  const values: Record<string, unknown> = { connectionId: "w200", transportNumber: "GR2K923428" }
  assert.equal(await resolveWriteTransportNumber(values, backend), null)
  assert.equal(
    values.transportNumber,
    "GR2K923428",
    "the helper's own rejection stays the backstop"
  )
})

test("an empty transport number never reaches SAP", async () => {
  const queries: string[] = []
  const values: Record<string, unknown> = { connectionId: "w200", transportNumber: "   " }
  assert.equal(await resolveWriteTransportNumber(values, backendWith(taskRow, queries)), null)
  assert.equal(queries.length, 0)
})

test("the pre-change summary records the substitution beside the request it used", () => {
  const context = writeOperationContext(
    "resume_ddic_table_activation",
    { connectionId: "w200", transportNumber: "GR2K923427" },
    new MockBackend(),
    "GR2K923428"
  )
  const summary = JSON.parse(context.preChangeSummary) as Record<string, unknown>
  assert.equal(summary.transportNumber, "GR2K923427")
  assert.equal(summary.requestedTaskNumber, "GR2K923428")
  assert.match(String(summary.transportResolution), /GR2K923428 is a CTS task/)
  assert.match(String(summary.transportResolution), /GR2K923427/)
})

test("no substitution leaves the pre-change summary unchanged", () => {
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
})
