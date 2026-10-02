/**
 * Guards for `format_abap_source` (plan item D-9, formatting half).
 *
 * Three properties carry the whole contract, and each one is written to fail if the implementation
 * stops honouring it:
 *
 *   1. a source the printer rewrites is reported as changed, with the formatted text returned;
 *   2. a source the printer returns verbatim is reported as *unchanged* - never as a successful
 *      reformat, and never as a failure;
 *   3. the tool is read-only: no lock, save, activate, create or delete path is entered at all.
 *
 * The third is the one that cannot be asserted by reading the reply, because a tool that wrote and
 * then described itself as read-only would look identical. It is therefore asserted against the
 * backend's own mutation ledger.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { AdtBackend } from "../src/adt-backend.js"
import { ToolService } from "../src/tools.js"
import { toolContracts } from "../src/contracts.js"
import { registryEntry } from "../src/tool-registry.js"
import { MockBackend } from "./mock-backend.js"

const CLASS_URI = "adt://w200/sap/bc/adt/oo/classes/zcl_demo"
const SOURCE_PATH = "/sap/bc/adt/oo/classes/zcl_demo/source/main"
const PRETTY_URL = "/sap/bc/adt/abapsource/prettyprinter"

/** One observed HTTP request, with only the fields this test has an opinion about. */
interface ObservedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

/**
 * A real `AdtBackend` whose client is a recording fake.
 *
 * The mock backend above replaces `formatSource` wholesale, so it cannot show which URL, method and
 * headers the service actually sends - and reusing the library's `prettyPrinter` instead of
 * hand-rolling the request is part of the contract. This harness drives the shipped code path down
 * to the HTTP boundary, so the wire shape and the error classification are real.
 */
function backendWithRecordingHttp(
  formatResponse: { body: string } | { status: number; statusText: string }
): { backend: AdtBackend; requests: ObservedRequest[] } {
  const requests: ObservedRequest[] = []
  const backend = new AdtBackend([
    {
      id: "w200",
      url: "https://sap.example.invalid",
      client: "200",
      language: "EN",
      username: "VALIDATION",
      passwordEnv: "UNUSED_TEST_PASSWORD",
      allowUnauthorized: false
    }
  ])
  const client = {
    httpClient: {
      async request(url: string, options: Record<string, unknown> = {}) {
        requests.push({
          url,
          method: String(options.method ?? "GET"),
          headers: (options.headers ?? {}) as Record<string, string>,
          body: options.body as string | undefined
        })
        if (url.includes("prettyprinter")) {
          if ("status" in formatResponse) {
            const error = new Error(
              `Request failed with status code ${formatResponse.status}`
            ) as Error & { status: number; statusText: string }
            error.status = formatResponse.status
            error.statusText = formatResponse.statusText
            throw error
          }
          return { body: formatResponse.body, status: 200, statusText: "OK", headers: {} }
        }
        return { body: FORMATTED_ZCL_DEMO, status: 200, statusText: "OK", headers: {} }
      }
    }
  }
  const state = backend as unknown as {
    clients: Map<string, { client: object; login: Promise<void> }>
  }
  state.clients.set("w200", { client, login: Promise.resolve() })
  return { backend, requests }
}

/** The mock's active source for ZCL_DEMO, reformatted as the pretty printer would return it. */
const FORMATTED_ZCL_DEMO = [
  "CLASS zcl_demo IMPLEMENTATION.",
  "  METHOD run.",
  "    WRITE 'HEADLESS'.",
  "  ENDMETHOD.",
  "ENDCLASS."
].join("\n")

interface FormatReply {
  connectionId: string
  fileUri: string
  sourceUri: string
  changed: boolean
  originalLineCount: number
  formattedLineCount: number
  lineCountDelta: number
  summary: string
  formattedSource: string
  readOnly: boolean
  wroteToSap: boolean
}

async function format(
  backend: MockBackend,
  input: { fileUri: string; connectionId: string } = {
    fileUri: CLASS_URI,
    connectionId: "w200"
  }
): Promise<FormatReply> {
  return JSON.parse(await new ToolService(backend).formatAbapSource(input)) as FormatReply
}

test("a source the pretty printer rewrites is reported as changed", async () => {
  const backend = new MockBackend()
  // Models a real reformat: the printer lower-cases the statement, re-indents the body and drops
  // the blank line an author left behind.
  backend.formatSourceOverride = [
    "class zcl_demo implementation.",
    "  method run.",
    "    write 'HEADLESS'.",
    "  endmethod.",
    "endclass."
  ].join("\n")

  const reply = await format(backend)

  assert.equal(reply.changed, true)
  assert.equal(reply.connectionId, "w200")
  assert.equal(reply.fileUri, CLASS_URI)
  assert.equal(reply.readOnly, true)
  assert.equal(reply.wroteToSap, false)
  // The formatted text is returned to the caller: the tool's whole point is the text, and a
  // "changed: true" with no text would leave the caller unable to apply anything.
  assert.equal(reply.formattedSource, backend.formatSourceOverride)
  assert.match(reply.summary, /different text/)
  // Nothing was written back, so the caller must be told that applying it is a separate act.
  assert.match(reply.summary, /[Nn]othing was written back/)
  assert.equal(backend.formatSourceCalls, 1)
})

test("a source the printer returns verbatim is reported as unchanged, not as a reformat", async () => {
  const backend = new MockBackend()
  // No override: the double answers with the active source unchanged, which is what a printer that
  // finds nothing to do returns.
  const reply = await format(backend)

  assert.equal(reply.changed, false)
  assert.equal(reply.formattedSource, FORMATTED_ZCL_DEMO)
  assert.equal(reply.originalLineCount, reply.formattedLineCount)
  assert.equal(reply.lineCountDelta, 0)
  // The critical distinction: an unchanged result must not read as a successful reformat, or a
  // caller cannot tell "already well formatted" from "the formatter did work".
  assert.match(reply.summary, /unchanged/)
  assert.doesNotMatch(reply.summary, /different text/)
  // ...and it must not read as a failure either, which would invite a pointless retry.
  assert.match(reply.summary, /not a failure/)
})

test("CRLF versus LF alone is not reported as a change", async () => {
  const backend = new MockBackend()
  // SAP stores CRLF while the printer echoes the separators it was handed. Counting that as a
  // reformat would report a change for text that is character-for-character identical.
  backend.formatSourceOverride = FORMATTED_ZCL_DEMO.replaceAll("\n", "\r\n")

  const reply = await format(backend)

  assert.equal(reply.changed, false)
  assert.match(reply.summary, /unchanged/)
})

test("line counts describe both sides and the delta between them", async () => {
  const backend = new MockBackend()
  backend.formatSourceOverride = ["CLASS zcl_demo IMPLEMENTATION.", "ENDCLASS."].join("\n")

  const reply = await format(backend)

  assert.equal(reply.originalLineCount, 5)
  assert.equal(reply.formattedLineCount, 2)
  assert.equal(reply.lineCountDelta, -3)
  // The summary must carry the real numbers, not just the verdict.
  assert.match(reply.summary, /5 line\(s\) in, 2 line\(s\) out/)
})

test("formatting is read-only: no write, lock, activation or creation path is entered", async () => {
  const backend = new MockBackend()
  backend.formatSourceOverride = ["REPORT zcl_demo.", "WRITE 'X'."].join("\n")

  const reply = await format(backend)

  assert.equal(reply.changed, true)
  // The tool's own claim...
  assert.equal(reply.readOnly, true)
  assert.equal(reply.wroteToSap, false)
  // ...and the backend's independent record of what was actually called. Every mutating method the
  // double implements reports itself here, so this is a real observation rather than a restatement.
  assert.deepEqual(
    backend.mutationCalls,
    [],
    "format_abap_source must not reach any SAP-mutating backend method"
  )
  // The source the double holds is untouched as well: a formatter that quietly saved its output
  // would leave the stored text equal to the formatted text.
  const stored = await backend.readSourceByUri("w200", CLASS_URI)
  assert.equal(stored.source, FORMATTED_ZCL_DEMO)
})

test("the read-only ledger has teeth: a real write is recorded by the same mechanism", async () => {
  // Without this control the assertion above could pass because the ledger is never written to.
  const backend = new MockBackend()
  await backend.replaceSource("w200", CLASS_URI, "WRITE 'HEADLESS'.", "WRITE 'CHANGED'.")
  await backend.activateSource("w200", CLASS_URI)

  assert.deepEqual(backend.mutationCalls, ["replaceSource", "activateSource"])
})

test("a formatter failure is surfaced instead of returning the input as formatted", async () => {
  const backend = new MockBackend()
  // The double raises what the library raises when the resource is absent. Whatever the wording, the
  // tool must not absorb it and answer "unchanged": that would report a transformation that never
  // happened.
  backend.formatSourceFailure = new Error("Request failed with status code 404")

  await assert.rejects(
    () => format(backend),
    (error: Error) => {
      assert.match(error.message, /404/)
      // Not dressed up as a successful no-op...
      assert.doesNotMatch(error.message, /unchanged/)
      assert.doesNotMatch(error.message, /already in the formatter/)
      return true
    }
  )
  assert.deepEqual(backend.mutationCalls, [])
})

test("the missing endpoint is classified as an endpoint failure, not an object failure", async () => {
  // The mock above replaces the formatter whole, so it cannot show how a real ADT refusal is
  // attributed. This drives the shipped path to the HTTP boundary: a target without the resource
  // answers 404, and the caller must be told the endpoint is missing rather than left to suspect the
  // object, the source or their own request.
  const { backend, requests } = backendWithRecordingHttp({ status: 404, statusText: "Not Found" })

  await assert.rejects(
    () => backend.formatSource("w200", CLASS_URI),
    (error: Error) => {
      assert.match(error.message, /pretty-printer capability/)
      assert.match(error.message, /unsupported-endpoint/)
      assert.match(error.message, /404/)
      return true
    }
  )
  // The source read happened first, and the formatter was reached exactly once.
  assert.equal(requests.filter((request) => request.url.includes("prettyprinter")).length, 1)
})

test("the formatter is called as a POST of the source text to the library's endpoint", async () => {
  const { backend, requests } = backendWithRecordingHttp({ body: "FORMATTED BY SAP" })

  const result = await backend.formatSource("w200", CLASS_URI)

  const call = requests.find((request) => request.url.includes("prettyprinter"))
  assert.ok(call, "the pretty-printer endpoint was never called")
  assert.equal(call.url, PRETTY_URL)
  assert.equal(call.method, "POST")
  assert.equal(call.headers["Content-Type"], "text/plain")
  assert.equal(call.headers.Accept, "text/plain")
  // The body is the source itself, which is what makes this a pure function on the service side.
  assert.equal(call.body, FORMATTED_ZCL_DEMO)
  // Only the source read and the formatter were called - no other endpoint was touched.
  assert.deepEqual(
    [...new Set(requests.map((request) => request.url))].sort(),
    [PRETTY_URL, SOURCE_PATH].sort()
  )
  assert.equal(result.formattedSource, "FORMATTED BY SAP")
  assert.equal(result.originalSource, FORMATTED_ZCL_DEMO)
  assert.equal(result.sourceUri, SOURCE_PATH)
})

test("the real backend path reaches no lock, save or activate endpoint", async () => {
  const { backend, requests } = backendWithRecordingHttp({ body: "FORMATTED BY SAP" })

  await backend.formatSource("w200", CLASS_URI)

  // A read-only guarantee is only meaningful if the write resources were never contacted. Every
  // mutating ADT call this service makes is a PUT/DELETE to a source URL or a lock action, so the
  // observable is the absence of any of those.
  const writeCalls = (observed: ObservedRequest[]) =>
    observed.filter(
      (request) =>
        request.method === "PUT" ||
        request.method === "DELETE" ||
        /_action=LOCK|activation|lock/i.test(request.url) ||
        /_action=|lockHandle/.test(JSON.stringify(request))
    )
  // The list must be populated, or the assertion below would hold for a path that never ran.
  assert.equal(requests.length, 2, "expected exactly the source read and the formatter call")
  assert.deepEqual(writeCalls(requests), [])

  // Control: the predicate does catch a write, so the empty result above is an observation rather
  // than a filter that matches nothing by construction.
  const write: ObservedRequest = {
    url: SOURCE_PATH,
    method: "PUT",
    headers: { "content-type": "text/plain" },
    body: "CLASS zcl_demo IMPLEMENTATION."
  }
  assert.equal(writeCalls([write]).length, 1)
  const lockCall: ObservedRequest = {
    url: `${SOURCE_PATH}?_action=LOCK&accessMode=MODIFY`,
    method: "POST",
    headers: {},
    body: undefined
  }
  assert.equal(writeCalls([lockCall]).length, 1)
})

test("the declared connection must match the URI host", async () => {
  const backend = new MockBackend()
  // The two travel in one request, so a mismatch would otherwise read one system's source and label
  // it with another connection's id.
  await assert.rejects(
    () => format(backend, { fileUri: CLASS_URI, connectionId: "w300" }),
    /does not match the adt:\/\/ URI host w200/
  )
  // Refused before any SAP access at all.
  assert.equal(backend.formatSourceCalls, 0)
})

test("a malformed or non-adt fileUri is refused before any SAP access", async () => {
  const backend = new MockBackend()
  for (const fileUri of ["not a uri", "https://w200/sap/bc/adt/oo/classes/zcl_demo", "adt://"]) {
    await assert.rejects(
      () => format(backend, { fileUri, connectionId: "w200" }),
      /Invalid fileUri/
    )
  }
  assert.equal(backend.formatSourceCalls, 0)
})

test("the tool is registered as read-only and idempotent in both sources of truth", () => {
  const contract = toolContracts.format_abap_source
  assert.ok(contract, "format_abap_source has no contract")
  // The contract is what a client sees, so the guarantees must be declared there...
  assert.deepEqual(contract.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true
  })

  // ...and the registry must agree, because the profile and index gates read the registry.
  const entry = registryEntry("format_abap_source")
  assert.ok(entry, "format_abap_source is not in the tool registry")
  assert.equal(entry.group, "source")
  assert.equal(entry.route, "native-adt")
  assert.equal(entry.sapHelper, null)
  assert.equal(entry.minHelperProtocol, null)
  assert.deepEqual([...entry.profiles], ["dev"])
  assert.deepEqual(entry.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true
  })
})

test("the contract says it never writes back, in the text a caller actually reads", () => {
  const description = toolContracts.format_abap_source.description
  // A read-only tool whose description omits the guarantee leaves the caller to assume the opposite.
  assert.match(description, /Read-only/)
  assert.match(description, /NEVER writes the result back/)
  assert.match(description, /does not lock, save, activate/)
  // The unchanged-result wording is part of the contract, not just the implementation.
  assert.match(description, /unchanged/)
  // The endpoint-unavailable behaviour is promised here too.
  assert.match(description, /pretty-printer resource/)
})
