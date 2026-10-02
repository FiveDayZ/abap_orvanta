/**
 * Guards for `get_quick_fix_proposals` (plan item D-9, quick-fix half).
 *
 * Four properties carry the contract, and each is written to fail if the implementation stops
 * honouring it:
 *
 *   1. the proposals the evaluator returns reach the caller, with the handler URI intact;
 *   2. an empty answer is reported as a definite answer for that position - never as a failure, and
 *      never as a missing endpoint;
 *   3. a target that does not serve the evaluator fails with a named endpoint status rather than
 *      being reported as "no proposals";
 *   4. the tool is read-only: no lock, save, activate, create or delete path is entered at all, and
 *      the edit-producing half of the upstream API is never called.
 *
 * The fourth is the one that cannot be asserted by reading the reply, because a tool that applied the
 * fix and then described itself as read-only would look identical. It is therefore asserted against
 * the backend's own mutation ledger, and the wire shape is asserted against a real `AdtBackend` whose
 * HTTP client is a recording fake - so the URL, method and body are the ones the shipped code sends.
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
const QUICKFIX_URL = "/sap/bc/adt/quickfixes/evaluation"

/** One observed HTTP request, with only the fields this test has an opinion about. */
interface ObservedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
  /** The library hands its query string to the HTTP client as axios `params`, not baked into `url`. */
  qs: Record<string, unknown>
}

interface QuickFixReply {
  connectionId: string
  fileUri: string
  sourceUri: string
  line: number
  column: number
  mediaTypeUsed: string
  acceptUsed: string
  mediaTypeAttempts: Array<{
    contentType: string
    accept: string
    outcome: string
    proposalCount: number | null
  }>
  proposalCount: number
  proposals: Array<{
    type: string
    name: string
    description: string
    handlerUri: string
    userContent: string
  }>
  summary: string
  readOnly: boolean
  wroteToSap: boolean
}

/** One proposal shaped the way the library's `fixProposals` parser produces them. */
const PROPOSAL = {
  type: "add_unimplemented_method",
  name: "add_unimplemented_method",
  description: "Add the missing method implementation",
  handlerUri: "/sap/bc/adt/quickfixes/add_unimplemented_method",
  userContent: "Add method run"
}

async function proposals(
  backend: MockBackend,
  input: { fileUri: string; connectionId: string; line: number; column: number } = {
    fileUri: CLASS_URI,
    connectionId: "w200",
    line: 3,
    column: 10
  }
): Promise<QuickFixReply> {
  return JSON.parse(await new ToolService(backend).quickFixProposals(input)) as QuickFixReply
}

test("the evaluator's proposals reach the caller, handler URI included", async () => {
  const backend = new MockBackend()
  backend.quickFixProposalsOverride = [PROPOSAL]

  const reply = await proposals(backend)

  assert.equal(reply.proposalCount, 1)
  assert.equal(reply.proposals.length, 1)
  assert.equal(reply.proposals[0]?.type, "add_unimplemented_method")
  assert.equal(reply.proposals[0]?.description, "Add the missing method implementation")
  // The handler URI is the whole reason the reply can be acted on by a human without this tool ever
  // calling it, so losing it would leave the capability unusable.
  assert.equal(reply.proposals[0]?.handlerUri, PROPOSAL.handlerUri)
  assert.equal(reply.connectionId, "w200")
  assert.equal(reply.fileUri, CLASS_URI)
  assert.equal(reply.sourceUri, SOURCE_PATH)
  assert.equal(reply.line, 3)
  assert.equal(reply.column, 10)
  assert.equal(backend.quickFixCalls, 1)
  // The reply must say that applying is a separate act, or a caller could believe the fix happened.
  assert.match(reply.summary, /separate/)
  assert.match(reply.summary, /handlerUri/)
})

test("an empty answer reads as a definite answer, not as a failure or a missing endpoint", async () => {
  const backend = new MockBackend()
  // No override: the double answers with an empty list, which is what an evaluator that has nothing
  // to offer at this position returns.
  const reply = await proposals(backend)

  assert.equal(reply.proposalCount, 0)
  assert.deepEqual(reply.proposals, [])
  assert.equal(reply.readOnly, true)
  assert.equal(reply.wroteToSap, false)
  // The three readings a caller must be able to tell apart: nothing to fix here / the call failed /
  // the target has no evaluator at all. This is the first.
  assert.match(reply.summary, /no proposal/)
  assert.match(reply.summary, /definite answer/)
  assert.match(reply.summary, /not a failure/)
  assert.match(reply.summary, /unsupported-endpoint/)
})

test("a missing evaluator is surfaced as a named endpoint failure, not an empty list", async () => {
  const backend = new MockBackend()
  backend.quickFixFailure = new Error("quick-fixes capability unsupported-endpoint (HTTP 404)")

  await assert.rejects(
    () => proposals(backend),
    (error: Error) => {
      assert.match(error.message, /404|unsupported-endpoint/)
      // It must not be dressed up as "the evaluator ran and found nothing".
      assert.doesNotMatch(error.message, /no proposal/)
      assert.doesNotMatch(error.message, /definite answer/)
      return true
    }
  )
  assert.deepEqual(backend.mutationCalls, [])
})

test("querying proposals is read-only: no write, lock or activation path is entered", async () => {
  const backend = new MockBackend()
  backend.quickFixProposalsOverride = [PROPOSAL]

  const reply = await proposals(backend)

  assert.equal(reply.proposalCount, 1)
  // The tool's own claim...
  assert.equal(reply.readOnly, true)
  assert.equal(reply.wroteToSap, false)
  // ...and the backend's independent record of what was actually called. Every mutating method the
  // double implements reports itself here, so this is a real observation, not a restatement.
  assert.deepEqual(
    backend.mutationCalls,
    [],
    "get_quick_fix_proposals must not reach any SAP-mutating backend method"
  )
  // The stored source is untouched: a tool that applied the proposal would have written it back.
  const stored = await backend.readSourceByUri("w200", CLASS_URI)
  assert.equal(stored.source.includes("METHOD run."), true)
})

test("the read-only ledger has teeth: a real write is recorded by the same mechanism", async () => {
  // Without this control the assertion above could pass because the ledger is never written to.
  const backend = new MockBackend()
  await backend.replaceSource("w200", CLASS_URI, "WRITE 'HEADLESS'.", "WRITE 'CHANGED'.")
  await backend.activateSource("w200", CLASS_URI)

  assert.deepEqual(backend.mutationCalls, ["replaceSource", "activateSource"])
})

test("the wire shape is the evaluator's: POST to the quick-fix resource with the source as the body", async () => {
  const { backend, requests } = backendWithRecordingHttp({ proposals: [PROPOSAL] })

  await new ToolService(backend).quickFixProposals({
    fileUri: CLASS_URI,
    connectionId: "w200",
    line: 3,
    column: 10
  })

  const call = requests.find((request) => request.url.includes(QUICKFIX_URL))
  assert.ok(call, "the shipped code must POST to the ADT quick-fix evaluation resource")
  assert.equal(call.method, "POST")
  // The position travels as the query parameter `uri=<source-uri>#start=line,column`, which is how
  // the library addresses a source position. The library hands this to the HTTP client as axios
  // `params` rather than appending it to the url, so asserting on `url` alone would silently pass
  // even if line and column had been dropped - hence the assertion on the query object.
  assert.deepEqual(
    call.qs,
    { uri: `${SOURCE_PATH}#start=3,10` },
    "the position must reach the evaluator as line,column on the source URI"
  )
  // The body is the source text itself - not XML, not a JSON envelope. That is the contract taken
  // from the library, and it is the part a hand-rolled request would most easily get wrong.
  assert.equal(call.body, ZCL_DEMO_SOURCE)
  // The media type is the first candidate and NOT the library's `application/*` for both headers:
  // w200 refuses that pair with an ADT error document, while `text/plain` is what this server's two
  // working source-text POSTs (pretty printer, type hierarchy) already send. The accepted type is
  // asserted where it matters - in the reply, below.
  assert.equal(call.headers["Content-Type"], "text/plain")
  assert.equal(call.headers["Accept"], "application/*")
  // The write half of the upstream API must not be reachable from here.
  assert.equal(
    requests.some((request) => request.url.includes("proposalRequest")),
    false,
    "the edit-producing call must never be made by a proposal query"
  )
})

test("a refused media type is retried with the next one, and the reply names the one that worked", async () => {
  // The measured w200 behaviour: the media type the library hard-codes is answered with an ADT error
  // document. The first candidate is refused here and the second accepted, so the retry path and the
  // reported media type are both exercised end to end.
  const { backend, requests } = backendWithRecordingHttp({
    proposals: [PROPOSAL],
    refuseContentTypes: ["text/plain"]
  })

  const reply = (await new ToolService(backend).quickFixProposals({
    fileUri: CLASS_URI,
    connectionId: "w200",
    line: 3,
    column: 10
  })) as unknown as string
  const parsed = JSON.parse(reply) as QuickFixReply

  assert.equal(parsed.proposalCount, 1)
  assert.equal(parsed.proposals[0]?.handlerUri, PROPOSAL.handlerUri)
  assert.equal(parsed.mediaTypeUsed, "text/plain; charset=utf-8")
  // The attempts are the evidence: a caller must be able to see which header SAP refused, because
  // that is what tells a human whether the endpoint or the request contract is at fault.
  assert.deepEqual(
    parsed.mediaTypeAttempts.map((attempt) => [attempt.contentType, attempt.proposalCount]),
    [
      ["text/plain", null],
      ["text/plain; charset=utf-8", 1]
    ]
  )
  assert.match(parsed.mediaTypeAttempts[0]?.outcome ?? "", /content handler/)
  // Two requests reach the evaluator, one per media type, and the source read happens once.
  assert.equal(
    requests.filter((request) => request.url.includes(QUICKFIX_URL)).length,
    2,
    "each media type is tried exactly once"
  )
  assert.match(parsed.summary, /text\/plain; charset=utf-8/)
  assert.match(parsed.summary, /refused type/)
})

test("every refused media type is reported instead of being answered as zero proposals", async () => {
  const { backend } = backendWithRecordingHttp({
    proposals: [PROPOSAL],
    refuseContentTypes: ["text/plain", "text/plain; charset=utf-8", "application/*"]
  })

  await assert.rejects(
    () =>
      new ToolService(backend).quickFixProposals({
        fileUri: CLASS_URI,
        connectionId: "w200",
        line: 3,
        column: 10
      }),
    (error: Error) => {
      // The refusal is the answer, and it must name every header that was refused.
      assert.match(error.message, /quick-fixes capability/)
      assert.match(error.message, /text\/plain/)
      assert.match(error.message, /application\/\*/)
      assert.match(error.message, /content handler/)
      // "No proposals here" is a different statement from "the evaluator refused the request", and a
      // caller reading the second as the first would conclude the code has nothing to fix.
      assert.doesNotMatch(error.message, /definite answer/)
      return true
    }
  )
})

test("an evaluation answer is read wherever the result elements sit and however they are prefixed", async () => {
  // The parser must not depend on the answer's exact nesting: a single `evaluationResult` is an object
  // rather than an array in the parsed tree, and the namespace prefix is not guaranteed. Reading only
  // one shape is what crashed the refactoring call for real on w200.
  const { backend } = backendWithRecordingHttp({
    rawBody: `<?xml version="1.0" encoding="UTF-8"?>
      <qf:evaluationResults xmlns:qf="http://www.sap.com/adt/quickfixes"
        xmlns:adtcore="http://www.sap.com/adt/core">
        <qf:evaluationResult>
          <adtcore:objectReference adtcore:uri="/sap/bc/adt/quickfixes/one"
            adtcore:type="one" adtcore:name="one" adtcore:description="One" />
          <userContent>One fix</userContent>
        </qf:evaluationResult>
      </qf:evaluationResults>`
  })

  const parsed = JSON.parse(
    await new ToolService(backend).quickFixProposals({
      fileUri: CLASS_URI,
      connectionId: "w200",
      line: 3,
      column: 10
    })
  ) as QuickFixReply

  assert.equal(parsed.proposalCount, 1)
  assert.equal(parsed.proposals[0]?.name, "one")
  assert.equal(parsed.proposals[0]?.handlerUri, "/sap/bc/adt/quickfixes/one")
  assert.equal(parsed.proposals[0]?.userContent, "One fix")
})

test("an empty evaluator answer is a definite answer, not a parse failure", async () => {
  const { backend } = backendWithRecordingHttp({ rawBody: "" })

  const parsed = JSON.parse(
    await new ToolService(backend).quickFixProposals({
      fileUri: CLASS_URI,
      connectionId: "w200",
      line: 3,
      column: 10
    })
  ) as QuickFixReply

  assert.equal(parsed.proposalCount, 0)
  assert.deepEqual(parsed.proposals, [])
  assert.equal(parsed.mediaTypeUsed, "text/plain")
  assert.match(parsed.summary, /no proposal/)
})

test("a position the evaluator cannot address is refused before any SAP access", async () => {
  const backend = new MockBackend()
  // A 0 or negative line is not a position ADT can address; refusing locally keeps a nonsense request
  // from being sent and, more importantly, keeps "no proposals" from meaning "we asked wrongly".
  await assert.rejects(
    () => proposals(backend, { fileUri: CLASS_URI, connectionId: "w200", line: 0, column: 0 }),
    /line must be a positive integer/
  )
  await assert.rejects(
    () => proposals(backend, { fileUri: CLASS_URI, connectionId: "w200", line: 1, column: -1 }),
    /column must be a non-negative integer/
  )
  assert.equal(backend.quickFixCalls, 0, "an invalid position must not reach the backend")
})

test("a connection that disagrees with the URI host is refused before any SAP access", async () => {
  const backend = new MockBackend()
  // Reading one system's source under another system's name is the failure this prevents.
  await assert.rejects(
    () => proposals(backend, { fileUri: CLASS_URI, connectionId: "w300", line: 1, column: 0 }),
    /does not match the adt:\/\/ URI host/
  )
  assert.equal(backend.quickFixCalls, 0)
  assert.deepEqual(backend.mutationCalls, [])
})

test("a malformed URI is refused before any SAP access", async () => {
  const backend = new MockBackend()
  await assert.rejects(
    () => proposals(backend, { fileUri: "not-a-uri", connectionId: "w200", line: 1, column: 0 }),
    /Invalid fileUri/
  )
  await assert.rejects(
    () =>
      proposals(backend, {
        fileUri: "https://example.invalid/x",
        connectionId: "w200",
        line: 1,
        column: 0
      }),
    /Invalid fileUri/
  )
  assert.equal(backend.quickFixCalls, 0)
})

test("the tool is registered read-only in both the registry and the contract", async () => {
  // A read-only tool is only read-only if it is advertised as such AND routed through the read path.
  // The registry carries the profile and annotations the server publishes; the contract carries the
  // annotations a client reads. They must agree, and they must not describe a write.
  const entry = registryEntry("get_quick_fix_proposals")
  assert.ok(entry, "get_quick_fix_proposals must be registered")
  assert.equal(entry.name, "get_quick_fix_proposals")
  assert.equal(entry.group, "source")
  assert.deepEqual(entry.profiles, ["dev"])
  // The route is the native ADT resource, not a SAP-side helper: no helper operation can be required
  // for a tool that never calls one.
  assert.equal(entry.route, "native-adt")
  assert.equal(entry.sapHelper, null)
  assert.deepEqual(entry.requiredHelperOperations, [])
  // The registry's own annotations...
  assert.deepEqual(entry.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true
  })
  // ...must be the same three values the contract publishes, or a client would be told something
  // different from what the server advertises.
  assert.deepEqual(toolContracts.get_quick_fix_proposals.annotations, entry.annotations)
  const schema = toolContracts.get_quick_fix_proposals.inputSchema
  assert.ok(schema.fileUri, "fileUri is required")
  assert.ok(schema.connectionId, "connectionId is required")
  assert.ok(schema.line, "line is required")
  assert.ok(schema.column, "column is required")
  // No field turns this into a write; if one were added, this fails.
  assert.deepEqual(
    Object.keys(schema).sort(),
    ["column", "connectionId", "fileUri", "line"],
    "the query takes a position and nothing that could apply a fix"
  )
  // The description must state the read-only guarantee, because that is what a client shows a user
  // before they decide whether to run it.
  const description = toolContracts.get_quick_fix_proposals.description
  assert.match(description, /Read-only/)
  assert.match(description, /does NOT apply a fix/i)
  assert.match(description, /handlerUri/)
})

/**
 * A real `AdtBackend` whose client is a recording fake.
 *
 * The mock backend replaces `quickFixProposals` wholesale, so it cannot show which URL, method and
 * body the service actually sends - and reusing the library's `fixProposals` instead of hand-rolling
 * the request is part of the contract. This harness drives the shipped code down to the HTTP
 * boundary, so the wire shape and the error classification are real.
 */
/**
 * How the recording fake answers the quick-fix evaluation, which is the only call under test.
 *
 * `refuseContentTypes` reproduces the measured w200 behaviour: SAP answers that media type with an ADT
 * error document whose message is "No content handler found for content type '<type>'", which the
 * library surfaces as a thrown error. Naming the refused types per test is what makes the negotiation
 * assertions real rather than a restatement of the candidate list.
 */
interface RecordingHttpSpec {
  proposals?: Array<Record<string, string>>
  refuseContentTypes?: string[]
  /** Answer with this raw body instead of a generated evaluation document. */
  rawBody?: string
}

function backendWithRecordingHttp(spec: RecordingHttpSpec): {
  backend: AdtBackend
  requests: ObservedRequest[]
} {
  const requests: ObservedRequest[] = []
  const refused = new Set(spec.refuseContentTypes ?? [])
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
        const headers = (options.headers ?? {}) as Record<string, string>
        requests.push({
          url,
          method: String(options.method ?? "GET"),
          headers,
          body: options.body as string | undefined,
          qs: (options.qs ?? {}) as Record<string, unknown>
        })
        if (url.includes("quickfixes/evaluation")) {
          const contentType = String(headers["Content-Type"] ?? "")
          if (refused.has(contentType)) {
            // The ADT error document's own text, as `errorText` sees it through the library.
            throw new Error(`No content handler found for content type '${contentType}'`)
          }
          return {
            body: spec.rawBody ?? quickFixResponseXml(spec.proposals ?? []),
            status: 200,
            statusText: "OK",
            headers: {}
          }
        }
        // Everything else is the source read that precedes the evaluation.
        return { body: ZCL_DEMO_SOURCE, status: 200, statusText: "OK", headers: {} }
      }
    }
  }
  const state = backend as unknown as {
    clients: Map<string, { client: object; login: Promise<void> }>
  }
  state.clients.set("w200", { client, login: Promise.resolve() })
  return { backend, requests }
}

/** The evaluator's own XML answer, so the reply parser is exercised rather than bypassed. */
function quickFixResponseXml(proposals: Array<Record<string, string>>): string {
  const results = proposals
    .map(
      (proposal) => `<evaluationResult>
        <adtcore:objectReference adtcore:uri="${proposal.handlerUri}"
          adtcore:type="${proposal.type}" adtcore:name="${proposal.name}"
          adtcore:description="${proposal.description}" />
        <userContent>${proposal.userContent}</userContent>
      </evaluationResult>`
    )
    .join("")
  return `<?xml version="1.0" encoding="UTF-8"?>
    <qf:evaluationResults xmlns:qf="http://www.sap.com/adt/quickfixes"
      xmlns:adtcore="http://www.sap.com/adt/core">${results}</qf:evaluationResults>`
}

/** The mock's active source for ZCL_DEMO, which is what the evaluator is handed. */
const ZCL_DEMO_SOURCE = [
  "CLASS zcl_demo IMPLEMENTATION.",
  "  METHOD run.",
  "    WRITE 'HEADLESS'.",
  "  ENDMETHOD.",
  "ENDCLASS."
].join("\n")
