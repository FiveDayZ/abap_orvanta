import assert from "node:assert/strict"
import test from "node:test"
import { formatJobSpoolPage, readJobSpoolSchema } from "../src/job-spool.js"

const input = {
  connectionId: "w200",
  jobName: "ZJOB",
  jobCount: "00000001",
  stepNumber: 1,
  spoolId: "123"
}
const page = () => ({
  action: "JOB_SPOOL" as const,
  job: { jobName: "ZJOB", jobCount: "00000001" },
  stepNumber: 1,
  spoolId: "0000000123",
  page: 1,
  spoolStamp: "created:modified:C",
  lines: ["header", "password=secret", "result"]
})
test("spool text returns rendered-page lines and requires matching revision to continue", () => {
  const first = formatJobSpoolPage({ ...input, maxLines: 1 }, page())
  assert.equal(first.nextAfterLine, 1)
  assert.equal(first.moreSpoolPages, "unknown")
  assert.equal(first.snapshot, false)
  assert.deepEqual(first.lines, [{ renderedLine: 1, text: "header" }])
  assert.throws(
    () => formatJobSpoolPage({ ...input, afterLine: 1 }, page()),
    /require expectedRevision/
  )
  const rest = formatJobSpoolPage(
    { ...input, afterLine: 1, expectedRevision: first.revision },
    page()
  )
  assert.equal(rest.lines[0]!.renderedLine, 2)
  assert.doesNotMatch(rest.lines[0]!.text, /secret/)
  assert.equal(rest.nextAfterLine, null)
})
test("spool revision detects changed text even if header timestamps are unchanged", () => {
  const first = formatJobSpoolPage(input, page())
  assert.throws(
    () =>
      formatJobSpoolPage(
        { ...input, expectedRevision: first.revision },
        { ...page(), lines: ["different"] }
      ),
    /SPOOL_PAGE_CHANGED/
  )
})
test("spool revision cannot be reused for another page", () => {
  const first = formatJobSpoolPage(input, page())
  assert.throws(
    () =>
      formatJobSpoolPage(
        { ...input, page: 2, expectedRevision: first.revision },
        { ...page(), page: 2 }
      ),
    /SPOOL_PAGE_CHANGED/
  )
})
test("spool responses must match exact job step and expected primary spool", () => {
  for (const change of [
    { job: { jobName: "OTHER", jobCount: "00000001" } },
    { stepNumber: 2 },
    { spoolId: "999" },
    { page: 2 },
    { spoolStamp: null }
  ]) {
    assert.throws(() => formatJobSpoolPage(input, { ...page(), ...change }), /SCOPE_MISMATCH/)
  }
})
test("spool schemas reject excessive pages, text, page size and invalid spool IDs", () => {
  for (const change of [{ page: 1001 }, { spoolId: "0" }, { maxLines: 201 }])
    assert.equal(readJobSpoolSchema.safeParse({ ...input, ...change }).success, false)
  assert.throws(() => formatJobSpoolPage(input, { ...page(), lines: ["x".repeat(4097)] }))
  assert.throws(() => formatJobSpoolPage(input, { ...page(), lines: Array(1001).fill("x") }))
})
test("spool rejects invalid offsets instead of returning an unexplained empty page", () => {
  const first = formatJobSpoolPage(input, page())
  assert.throws(
    () => formatJobSpoolPage({ ...input, afterLine: 4, expectedRevision: first.revision }, page()),
    /OFFSET_OUT_OF_RANGE/
  )
  assert.throws(() => formatJobSpoolPage(input, { ...page(), lines: [] }), /SPOOL_EMPTY_RESPONSE/)
})
