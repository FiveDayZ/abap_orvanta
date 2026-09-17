import assert from "node:assert/strict"
import test from "node:test"
import { readReportVariants } from "../src/report-variants.js"

const input = { connectionId: "W200", report: "zreport" }
const row = {
  MANDT: "200",
  REPORT: "ZREPORT",
  VARIANT: "DAILY",
  FLAG1: "",
  FLAG2: "",
  TRANSPORT: "",
  ENVIRONMNT: "B",
  PROTECTED: "X",
  SECU: "",
  VERSION: "123",
  ENAME: "AUTHOR",
  EDAT: "20260101",
  ETIME: "010203",
  AENAME: "",
  AEDAT: "00000000",
  AETIME: "000000",
  MLANGU: "E"
}
function response(data = [row], truncated = false) {
  return {
    connectionId: "w200",
    tableName: "VARID",
    readOnly: true,
    status: "ok",
    method: "rfc_read_table",
    representation: "sap_text_trimmed",
    definitionFingerprint: "a".repeat(64),
    returnedCount: data.length,
    truncated,
    data
  }
}

test("variant directory composes bounded exact current-client query and preserves attributes", async () => {
  const result = await readReportVariants(input, "200", async (query) => {
    assert.equal(query.tableName, "VARID")
    assert.equal(query.connectionId, "w200")
    assert.equal(query.maxRows, 100)
    assert.deepEqual(query.filters, [
      { column: "MANDT", operator: "EQ", value: "200" },
      { column: "REPORT", operator: "EQ", value: "ZREPORT" },
      { column: "FLAG1", operator: "EQ", value: "" },
      { column: "FLAG2", operator: "EQ", value: "" }
    ])
    assert.ok(query.columns.includes("VERSION"))
    return response()
  })
  assert.equal(result.status, "ok")
  assert.equal(result.variants[0]!.rawAttributes.version, "123")
  assert.equal(result.parameterValuesAvailable, false)
  assert.equal(result.executionAuthorized, "not_evaluated")
  assert.equal(result.snapshot, false)
})

test("exact variant lookup uses one-row bound and no wildcard search", async () => {
  const result = await readReportVariants({ ...input, variant: "sap&1" }, "200", async (query) => {
    assert.equal(query.maxRows, 1)
    assert.deepEqual(query.filters?.at(-1), { column: "VARIANT", operator: "EQ", value: "SAP&1" })
    return response([{ ...row, VARIANT: "SAP&1" }])
  })
  assert.equal(result.variant, "SAP&1")
})

test("invalid inputs cannot cause any table reads", async () => {
  let calls = 0
  const read = async () => {
    calls++
    return response()
  }
  for (const change of [
    { report: "Z%' OR '1'='1" },
    { report: "*" },
    { variant: "*" },
    { maxResults: 201 },
    { maxResults: 0 },
    { connectionId: "other/connection" },
    { report: "A".repeat(41) }
  ])
    await assert.rejects(() => readReportVariants({ ...input, ...change }, "200", read))
  await assert.rejects(() => readReportVariants(input, "0000", read))
  assert.equal(calls, 0)
})

test("unavailable or malformed table responses never become empty directories", async () => {
  await assert.rejects(
    () =>
      readReportVariants(input, "200", async () => ({
        status: "unavailable",
        code: "TABLE_QUERY_NOT_AUTHORIZED"
      })),
    /REPORT_VARIANTS_UNAVAILABLE: TABLE_QUERY_NOT_AUTHORIZED/
  )
  for (const invalid of [
    null,
    {},
    { ...response(), data: null },
    { ...response(), readOnly: false }
  ]) {
    await assert.rejects(
      () => readReportVariants(input, "200", async () => invalid),
      /REPORT_VARIANTS_RESPONSE_INVALID/
    )
  }
})

test("scope, duplicate keys and count mismatches fail closed", async () => {
  for (const invalid of [
    response([{ ...row, MANDT: "000" }]),
    response([{ ...row, REPORT: "OTHER" }]),
    response([row, row]),
    { ...response(), connectionId: "other" },
    { ...response(), returnedCount: 0 },
    response([], true)
  ]) {
    await assert.rejects(
      () => readReportVariants(input, "200", async () => invalid),
      /REPORT_VARIANTS_SCOPE_OR_COUNT_MISMATCH/
    )
  }
  await assert.rejects(
    () => readReportVariants({ ...input, variant: "OTHER" }, "200", async () => response()),
    /REPORT_VARIANTS_SCOPE_OR_COUNT_MISMATCH/
  )
  await assert.rejects(
    () => readReportVariants(input, "200", async () => response([{ ...row, FLAG1: "X" }])),
    /REPORT_VARIANTS_RESPONSE_INVALID/
  )
})

test("empty and truncated directory selections have distinct explicit coverage", async () => {
  const empty = await readReportVariants(input, "200", async () => response([]))
  assert.equal(empty.status, "empty")
  assert.equal(empty.selectionComplete, true)
  const limited = await readReportVariants({ ...input, maxResults: 1 }, "200", async () =>
    response([row], true)
  )
  assert.equal(limited.status, "limited")
  assert.equal(limited.selectionComplete, false)
  assert.equal(limited.order, "returned_subset_sorted_by_variant")
})

test("directory fingerprints are stable across order but detect attribute changes", async () => {
  const other = { ...row, VARIANT: "SECOND" }
  const a = await readReportVariants(input, "200", async () => response([row, other]))
  const b = await readReportVariants(input, "200", async () => response([other, row]))
  const changed = await readReportVariants(input, "200", async () =>
    response([{ ...row, PROTECTED: "" }, other])
  )
  assert.deepEqual(
    a.variants.map((v) => v.name),
    ["DAILY", "SECOND"]
  )
  assert.equal(a.selectionFingerprint, b.selectionFingerprint)
  assert.notEqual(a.selectionFingerprint, changed.selectionFingerprint)
})

test("native numeric version and padded blank key flags are accepted without interpreting flags", async () => {
  const result = await readReportVariants(input, "200", async () => ({
    ...response(),
    method: "adt_query",
    representation: "adt_decoded",
    data: [
      { ...row, REPORT: "ZREPORT ", VARIANT: "DAILY ", VERSION: 2147483647, FLAG1: " ", FLAG2: " " }
    ]
  }))
  assert.equal(result.variants[0]!.rawAttributes.version, "2147483647")
  await assert.rejects(
    () =>
      readReportVariants(input, "200", async () => ({
        ...response(),
        data: [{ ...row, VERSION: 2147483648 }]
      })),
    /REPORT_VARIANTS_RESPONSE_INVALID/
  )
})
