import assert from "node:assert/strict"
import test from "node:test"
import {
  createReviewedTableReader,
  type ReviewedReaderSource
} from "../src/reviewed-table-reader.js"
import { parseSapDataQueryResponse } from "../src/data-query.js"
import type { RemoteFunctionRequest, SapBackend } from "../src/backend.js"

/**
 * The shared reviewed reader owns the vocabulary of a refused RFC call.
 *
 * Every caller documents `<PREFIX>NOT_AUTHORIZED` and `<PREFIX>RFC_FAILED`, so the reader has to
 * report the callee's fault under the caller's own prefix. When it reported the bare fault name
 * instead, all seven callers fell through to their generic `<PREFIX>QUERY_FAILED` and the two
 * documented codes were unreachable - a defect no single caller's tests could see.
 */

const readerDefinition = {
  functionName: "RFC_READ_TABLE",
  remoteEnabled: true,
  updateTask: false,
  sourceFingerprint: "7b9a603493673d26f75e555616b24d150e407ce03eff57e9c68f0b30b1ba0c2d",
  interfaceFingerprint: "d06cc5c1ce05960bde526ecf27e38606134146474cc8da19f93ac2abd3e48074"
}

/** The exact empty-HTML answer the platform gives for the native data preview. */
let emptyHtml: unknown
try {
  parseSapDataQueryResponse({ body: "", status: 200, headers: { "content-type": "text/html" } })
} catch (error) {
  emptyHtml = error
}

/** Mirrors the mapper every caller of this reader writes: prefixed codes through, anything else generic. */
function mapError(error: unknown): string {
  const text = error instanceof Error ? error.message : ""
  if (text.startsWith("SAP_DATA_QUERY_RESPONSE_INVALID:")) return "SAP_DATA_QUERY_RESPONSE_INVALID"
  switch (text) {
    case "PROBE_SCOPE_INVALID":
    case "PROBE_FALLBACK_UNVERIFIED":
    case "PROBE_NOT_AUTHORIZED":
    case "PROBE_RFC_FAILED":
    case "PROBE_RESPONSE_INVALID":
    case "PROBE_RESPONSE_SCOPE_MISMATCH":
    case "PROBE_AMBIGUOUS_RESULT":
      return text
    default:
      return "PROBE_QUERY_FAILED"
  }
}

function read(
  answer: (request: RemoteFunctionRequest) => unknown,
  definition: unknown = readerDefinition
) {
  const sources: ReviewedReaderSource[] = []
  const warnings: string[] = []
  const backend = {
    runQuery: async () => {
      throw emptyHtml
    },
    callRemoteFunction: async (_connection: string, request: RemoteFunctionRequest) =>
      answer(request)
  }
  const readTable = createReviewedTableReader(
    backend as unknown as Pick<SapBackend, "runQuery" | "callRemoteFunction">,
    "w200",
    async () => definition,
    sources,
    warnings
  )
  return {
    sources,
    warnings,
    call: () =>
      readTable({
        table: "T006",
        fields: ["MANDT", "MSEHI"],
        filters: { MSEHI: "GC" },
        maximum: 10,
        codePrefix: "PROBE_",
        mapError
      })
  }
}

test("a refused RFC call is reported under the caller's prefix, not as a bare fault name", async () => {
  for (const [fault, expected] of [
    ["NOT_AUTHORIZED", "PROBE_NOT_AUTHORIZED"],
    ["SYSTEM_FAILURE", "PROBE_RFC_FAILED"]
  ] as const) {
    const probe = read(() => ({ fault: { code: "SOAP", name: fault, message: "SECRET" } }))
    const rows = await probe.call()
    assert.equal(rows, null, fault)
    assert.equal(probe.sources[0]!.code, expected, fault)
    assert.equal(probe.sources[0]!.status, "unavailable", fault)
    assert.ok(probe.warnings.includes(`T006: ${expected}`), fault)
    // The fault text itself must not reach the answer.
    assert.doesNotMatch(JSON.stringify({ ...probe.sources[0], ...probe.warnings }), /SECRET/, fault)
  }
})

test("the reader still maps its own codes and refuses an unverified reader", async () => {
  const scope = read(() => ({
    outputs: { FIELDS: [{ FIELDNAME: "MANDT" }, { FIELDNAME: "MSEHI" }], DATA: [{ WA: "200|FA" }] }
  }))
  assert.equal(await scope.call(), null)
  assert.equal(scope.sources[0]!.code, "PROBE_RESPONSE_SCOPE_MISMATCH")

  const unverified = read(() => ({ outputs: {}, fault: { name: "NOT_AUTHORIZED" } }), {
    ...readerDefinition,
    sourceFingerprint: "0".repeat(64)
  })
  assert.equal(await unverified.call(), null)
  assert.equal(unverified.sources[0]!.code, "PROBE_FALLBACK_UNVERIFIED")
})

test("a filtered row that matches is returned with its source status", async () => {
  const probe = read(() => ({
    outputs: { FIELDS: [{ FIELDNAME: "MANDT" }, { FIELDNAME: "MSEHI" }], DATA: [{ WA: "200|GC" }] }
  }))
  assert.deepEqual(await probe.call(), [{ MANDT: "200", MSEHI: "GC" }])
  assert.equal(probe.sources[0]!.code, undefined)
  assert.equal(probe.sources[0]!.status, "ok")
  assert.equal(probe.sources[0]!.method, "rfc_read_table")
  assert.deepEqual(probe.warnings, [])
})
