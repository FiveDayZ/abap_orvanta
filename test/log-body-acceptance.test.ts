import assert from "node:assert/strict"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"

const { assertExpectedRejection, assertLocalSystemCoverage } = await import(
  pathToFileURL(resolve("scripts/probe-log-body-acceptance.mjs")).href
)

test("M5 negative acceptance requires the expected error, not transport or approval failures", () => {
  const expected =
    /^Error invoking read_background_job_log: Error: Subsequent job-log pages require expectedRevision$/
  const text =
    "Error invoking read_background_job_log: Error: Subsequent job-log pages require expectedRevision"
  const response = (value: string, isError = true) => ({
    isError,
    content: [{ type: "text", text: value }]
  })
  assert.equal(assertExpectedRejection(response(text), expected).rejected, true)
  for (const wrong of [
    response(text, false),
    response("fetch failed"),
    response("HELPER_NOT_APPROVED"),
    response("Error invoking read_background_job_log: OPS_LOG_HELPER_FINGERPRINT_MISMATCH"),
    response("MCP error -32602: unrelated validation failure"),
    { isError: true, content: [] }
  ])
    assert.throws(() => assertExpectedRejection(wrong, expected))
})

test("M5 coverage acceptance rejects missing metadata and false completeness", () => {
  const source = {
    status: "ok",
    coverage: "local_instance_bounded_tail",
    server: "instance1",
    scannedRecords: 2000,
    returnedCount: 5,
    truncated: true
  }
  assert.doesNotThrow(() => assertLocalSystemCoverage(source))
  assert.doesNotThrow(() =>
    assertLocalSystemCoverage({ ...source, scannedRecords: 0, returnedCount: 0 })
  )
  assert.throws(() => assertLocalSystemCoverage(undefined))
  for (const change of [
    { status: "unavailable" },
    { coverage: undefined },
    { coverage: "all_instances" },
    { server: "" },
    { truncated: false },
    { scannedRecords: 2001 },
    { scannedRecords: 1.5 },
    { returnedCount: 2001 },
    { returnedCount: -1 }
  ])
    assert.throws(() => assertLocalSystemCoverage({ ...source, ...change }))
})
