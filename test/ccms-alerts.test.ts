import assert from "node:assert/strict"
import test from "node:test"
import {
  CCMS_ALERTS_DEFAULT_ROWS,
  CCMS_ALERT_COLUMNS,
  alertCleared,
  collectCcmsAlerts,
  type CcmsAlertReadResult,
  type CcmsAlertTableReader
} from "../src/ccms-alerts.js"

/**
 * Guards for `read_ccms_alerts`.
 *
 * The tool's whole risk is that an alert reader is mistaken for a health check, so the assertions
 * below are about what the answer *claims*, not only about what it builds: the filter list, the
 * refusal of requests whose failure would be indistinguishable from an empty result, the pass-through
 * of the reader's own refusal code, and the boundaries repeated in the notes.
 */

type Recorded = {
  tableName: string
  columns: string[]
  filters: { column: string; operator: string; value: string }[]
  maxRows: number
}

/** A reader that records the query and answers with whatever the test wants. */
function stubReader(result: CcmsAlertReadResult) {
  const calls: Recorded[] = []
  const read: CcmsAlertTableReader = async (query) => {
    calls.push({
      tableName: query.tableName,
      columns: query.columns,
      filters: query.filters.map((filter) => ({ ...filter })),
      maxRows: query.maxRows
    })
    return result
  }
  return { read, calls }
}

const oneRow = {
  ALSYSID: "GR2",
  MSEGNAME: "SAP_CCMS_GRAPP2_GR2_00",
  ALUNIQNUM: "0024021342",
  ALINDEX: "0000000994",
  ALERTDATE: "20250603",
  ALERTTIME: "224816",
  MTSYSID: "GR2",
  MTMCNAME: "GRAPP2_GR2_00",
  MTCLASS: "102",
  MTINDEX: "0000000364",
  VALUE: "3",
  SEVERITY: "50",
  STATUS: "205",
  OBJECTNAME: "Background",
  FIELDNAME: "AbortedJobs",
  GONEDATE: "20250617",
  GONETIME: "003320",
  REPORTEDBY: "BP RT system",
  STATCHGDAT: "20250617",
  STATCHGTIM: "003320",
  STATCHGBY: "SAPSYS",
  MSGID: "00 594",
  MSGCLASS: "SAP-T100",
  MANDT: "200",
  USERID: "WF-BATCH",
  MSCGLID: ""
}

test("the read is scoped to ALALERTDB with the documented projection", async () => {
  const { read, calls } = stubReader({ status: "ok", data: [oneRow], truncated: false })
  const answer = await collectCcmsAlerts(read, "w200", {})

  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.tableName, "ALALERTDB")
  assert.deepEqual(calls[0]!.filters, [], "no option means no condition")
  assert.equal(calls[0]!.maxRows, CCMS_ALERTS_DEFAULT_ROWS)
  // The two 128-byte-heavy message-text families are what pushed the read over its data-call
  // budget on w200, so their absence is a designed property and not an oversight. This loop must
  // stay above the projection assertion below: that assertion narrows the recorded column list to
  // the literal tuple type, after which `includes` would reject a plain string.
  for (const excluded of ["MSGTEXT", "MSGARG1", "MSGARG2", "MSGARG3", "MSGARG4"]) {
    assert.ok(
      !calls[0]!.columns.includes(excluded),
      `${excluded} must not be selected: it costs more data calls than the row budget allows`
    )
  }
  assert.deepEqual(calls[0]!.columns, [...CCMS_ALERT_COLUMNS])
  assert.equal(answer.status, "ok")
  assert.equal(answer.truncated, false)
})

test("every option becomes one named condition and nothing else", async () => {
  const { read, calls } = stubReader({ status: "ok", data: [], truncated: false })
  const answer = await collectCcmsAlerts(read, "w200", {
    alertDateFrom: "20250101",
    alertDateTo: "20251231",
    clearedFrom: "20250201",
    clearedTo: "20251231",
    alertSystem: "GR2",
    monitorSet: "SAP_CCMS_GRAPP2_GR2_00",
    objectName: "Background",
    fieldName: "AbortedJobs"
  })

  assert.deepEqual(calls[0]!.filters, [
    { column: "ALERTDATE", operator: "GE", value: "20250101" },
    { column: "ALERTDATE", operator: "LE", value: "20251231" },
    { column: "GONEDATE", operator: "GE", value: "20250201" },
    { column: "GONEDATE", operator: "LE", value: "20251231" },
    { column: "ALSYSID", operator: "EQ", value: "GR2" },
    { column: "MSEGNAME", operator: "EQ", value: "SAP_CCMS_GRAPP2_GR2_00" },
    { column: "OBJECTNAME", operator: "EQ", value: "Background" },
    { column: "FIELDNAME", operator: "EQ", value: "AbortedJobs" }
  ])
  assert.equal(answer.status, "ok")
})

test("the client is an explicit opt-in filter, and its absence is reported", async () => {
  const withoutClient = stubReader({ status: "ok", data: [], truncated: false })
  const unfiltered = await collectCcmsAlerts(withoutClient.read, "w200", {})
  assert.deepEqual(withoutClient.calls[0]!.filters, [])
  assert.equal(unfiltered.status === "ok" && unfiltered.clientFilterApplied, false)

  const withClient = stubReader({ status: "ok", data: [], truncated: false })
  const filtered = await collectCcmsAlerts(withClient.read, "w200", { client: "200" })
  assert.deepEqual(withClient.calls[0]!.filters, [
    { column: "MANDT", operator: "EQ", value: "200" }
  ])
  assert.equal(filtered.status === "ok" && filtered.clientFilterApplied, true)
})

test("openOnly selects rows without a clear date and excludes a cleared window", async () => {
  const open = stubReader({ status: "ok", data: [], truncated: false })
  await collectCcmsAlerts(open.read, "w200", { openOnly: true })
  assert.deepEqual(open.calls[0]!.filters, [{ column: "GONEDATE", operator: "EQ", value: "" }])

  // Both at once would answer whichever question the caller did not ask, so it is refused rather
  // than resolved by precedence.
  for (const cleared of [{ clearedFrom: "20250101" }, { clearedTo: "20251231" }]) {
    const { read, calls } = stubReader({ status: "ok", data: [], truncated: false })
    await assert.rejects(
      () => collectCcmsAlerts(read, "w200", { openOnly: true, ...cleared }),
      /CCMS_ALERTS_SCOPE_INVALID/,
      "openOnly with a cleared window must be refused"
    )
    assert.equal(calls.length, 0, "a refused request must not reach SAP")
  }
})

test("malformed, reversed and over-long input is refused before SAP is touched", async () => {
  const cases: Array<Record<string, unknown>> = [
    { alertDateFrom: "2025-01-01" },
    { clearedTo: "2025121" },
    { alertDateFrom: "20251231", alertDateTo: "20250101" },
    { clearedFrom: "20251231", clearedTo: "20250101" },
    { alertSystem: "X".repeat(41) },
    { client: "2000" },
    {
      alertDateFrom: "20250101",
      alertDateTo: "20251231",
      clearedFrom: "20250101",
      clearedTo: "20251231",
      alertSystem: "GR2",
      monitorSet: "M",
      objectName: "O",
      fieldName: "F",
      client: "200"
    }
  ]
  for (const options of cases) {
    const { read, calls } = stubReader({ status: "ok", data: [], truncated: false })
    await assert.rejects(
      () => collectCcmsAlerts(read, "w200", options),
      /CCMS_ALERTS_SCOPE_INVALID/,
      `${JSON.stringify(options)} must be refused`
    )
    assert.equal(calls.length, 0, "a refused request must not reach SAP")
  }
})

test("the row limit is bounded and the clamp is reported", async () => {
  const zero = stubReader({ status: "ok", data: [], truncated: false })
  await assert.rejects(
    () => collectCcmsAlerts(zero.read, "w200", { maxRows: 0 }),
    /CCMS_ALERTS_ROW_LIMIT_INVALID/
  )
  assert.equal(zero.calls.length, 0)

  const over = stubReader({ status: "ok", data: [], truncated: false })
  const clamped = await collectCcmsAlerts(over.read, "w200", { maxRows: 900 })
  assert.equal(over.calls[0]!.maxRows, 500)
  assert.equal(clamped.status === "ok" && clamped.rowLimit, 500)
  assert.equal(clamped.status === "ok" && clamped.rowLimitApplied, true)
})

test("rows are published under readable names with cleared and open derived from GONEDATE", async () => {
  const { read } = stubReader({
    status: "ok",
    data: [oneRow, { ...oneRow, GONEDATE: "", GONETIME: "" }, { ...oneRow, GONEDATE: "00000000" }],
    truncated: false
  })
  const answer = await collectCcmsAlerts(read, "w200", {})
  assert.equal(answer.status, "ok")
  if (answer.status !== "ok") return

  const [cleared, empty, zeroes] = answer.alerts
  assert.equal(cleared!.alertSystem, "GR2")
  assert.equal(cleared!.objectName, "Background")
  assert.equal(cleared!.fieldName, "AbortedJobs")
  assert.equal(cleared!.severity, "50", "severity is returned verbatim, never translated")
  assert.equal(cleared!.status, "205")
  assert.equal(cleared!.client, "200")
  assert.equal(cleared!.clearedDate, "20250617")
  assert.equal(cleared!.cleared, true)
  assert.equal(cleared!.open, false)
  // An all-zero date is the initial value, not a clear time: treating it as "cleared" would report
  // an open alert as resolved.
  assert.equal(empty!.cleared, false)
  assert.equal(empty!.open, true)
  assert.equal(zeroes!.cleared, false)
  assert.equal(zeroes!.open, true)
  assert.deepEqual(answer.counts.clearedOpenState, { cleared: 1, open: 2 })
})

test("a truncated read is partial, and a refused read keeps the reader's own code", async () => {
  const partial = stubReader({ status: "ok", data: [oneRow], truncated: true })
  const truncated = await collectCcmsAlerts(partial.read, "w200", {})
  assert.equal(truncated.status, "partial")

  // The distinction this test exists for: a refusal must never arrive as "no alerts".
  for (const code of [
    "TABLE_QUERY_REQUEST_BUDGET_EXCEEDED",
    "TABLE_QUERY_LEGACY_LAYOUT_UNSUPPORTED"
  ]) {
    const { read } = stubReader({
      status: "unavailable",
      code,
      stage: code === "TABLE_QUERY_LEGACY_LAYOUT_UNSUPPORTED" ? "layout_preflight" : "rfc_query",
      returnedCount: 0,
      truncated: null,
      data: null
    })
    const answer = await collectCcmsAlerts(read, "w200", {})
    assert.equal(answer.status, "unavailable")
    if (answer.status !== "unavailable") continue
    assert.equal(answer.code, code, "the reader's own code is reported, not a translated one")
    assert.equal(answer.data, null)
    assert.equal(answer.truncated, null)
    assert.equal(answer.returnedCount, 0)
  }
})

test("the answer states the boundaries that keep it from being read as a health check", async () => {
  const { read } = stubReader({ status: "ok", data: [], truncated: false })
  const answer = await collectCcmsAlerts(read, "w200", {})
  const notes = answer.notes.join(" ")
  assert.ok(notes.length > 0)
  assert.match(notes, /not the RZ20 live monitor/, "must say it is not the live monitor")
  assert.match(
    notes,
    /not a statement that\s+the system is healthy/,
    "must deny the health reading"
  )
  assert.match(notes, /Row order is unspecified/, "must deny freshness")
  assert.match(notes, /integer fields/, "must say severity/status cannot be filtered")
  assert.match(notes, /not client-isolated/, "must state the client boundary")
  assert.match(notes, /never a total/, "must deny completeness")
  // The same boundaries must survive a refusal, because that reply is the one most likely to be
  // read as "nothing is wrong".
  const refused = stubReader({ status: "unavailable", code: "X", stage: "y", data: null })
  const refusedAnswer = await collectCcmsAlerts(refused.read, "w200", {})
  assert.deepEqual(refusedAnswer.notes, answer.notes)
})

test("alertCleared accepts only a real eight-digit date", () => {
  assert.equal(alertCleared("20250617"), true)
  assert.equal(alertCleared(""), false)
  assert.equal(alertCleared("00000000"), false)
  assert.equal(alertCleared("2025-06-17"), false)
})
