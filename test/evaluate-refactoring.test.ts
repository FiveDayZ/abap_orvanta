/**
 * Guards for `evaluate_refactoring` (plan item D-9, refactoring half - the evaluate step).
 *
 * Five properties carry the contract, and each is written to fail if the implementation stops
 * honouring it:
 *
 *   1. the affected objects and their text deltas reach the caller, so a decision can be made;
 *   2. an answer that carries no object list is reported as exactly that, while an answer that carries
 *      an empty list is reported as the definite "this range touches nothing" (measured on 2026-10-02:
 *      w200 answers this resource with an empty document for a rename, so the two readings must not be
 *      collapsed into each other);
 *   3. a target without the refactoring resource fails with a named endpoint status, not an empty list;
 *   4. the tool is read-only: no lock, save, activate, create or delete path is entered, and the
 *      preview/execute half of the upstream API is never called;
 *   5. the wire shape is the refactoring resource's - relation and range in the query, no body.
 *
 * The fourth is the one that cannot be asserted by reading the reply, so it is asserted against the
 * backend's own mutation ledger, and the wire shape is asserted against a real `AdtBackend` whose HTTP
 * client is a recording fake.
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
const REFACTOR_URL = "/sap/bc/adt/refactorings"
const RENAME_REL = "http://www.sap.com/adt/relations/refactoring/rename"

interface ObservedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
  /** The library hands its query string to the HTTP client as axios `params`, not baked into `url`. */
  qs: Record<string, unknown>
}

interface RefactoringReply {
  connectionId: string
  fileUri: string
  kind: string
  range: { start: { line: number; column: number }; end: { line: number; column: number } }
  oldName: string
  objectListReported: boolean
  answerElements: string[]
  affectedObjectCount: number
  totalDeltaCount: number
  affectedObjects: Array<{
    uri: string
    name: string
    deltaCount: number
    deltas: Array<{
      range: { start: { line: number; column: number }; end: { line: number; column: number } }
      contentOld: string
      contentNew: string
    }>
  }>
  summary: string
  readOnly: boolean
  wroteToSap: boolean
}

const RENAME_BASE = {
  fileUri: CLASS_URI,
  connectionId: "w200",
  kind: "rename" as const,
  startLine: 3,
  startColumn: 11,
  endLine: 3,
  endColumn: 11
}

/** One affected object shaped the way the library's parser produces them. */
const AFFECTED = [
  {
    uri: SOURCE_PATH,
    type: "CLAS/OC",
    name: "ZCL_DEMO",
    deltaCount: 2,
    deltas: [
      {
        range: { start: { line: 3, column: 11 }, end: { line: 3, column: 18 } },
        contentOld: "lv_demo",
        contentNew: "lv_renamed"
      },
      {
        range: { start: { line: 9, column: 4 }, end: { line: 9, column: 11 } },
        contentOld: "lv_demo",
        contentNew: "lv_renamed"
      }
    ]
  }
]

async function evaluate(
  backend: MockBackend,
  input: Parameters<ToolService["evaluateRefactoring"]>[0] = RENAME_BASE
): Promise<RefactoringReply> {
  return JSON.parse(await new ToolService(backend).evaluateRefactoring(input)) as RefactoringReply
}

test("the affected objects and their text deltas reach the caller", async () => {
  const backend = new MockBackend()
  backend.refactoringOverride = AFFECTED
  backend.refactoringOldName = "lv_demo"

  const reply = await evaluate(backend)

  assert.equal(reply.kind, "rename")
  assert.equal(reply.oldName, "lv_demo")
  assert.equal(reply.affectedObjectCount, 1)
  assert.equal(reply.totalDeltaCount, 2)
  assert.equal(reply.affectedObjects[0]?.name, "ZCL_DEMO")
  // The deltas are the whole point: a caller deciding whether to refactor must see which OTHER
  // objects would move and what the text would become.
  assert.equal(reply.affectedObjects[0]?.deltas[0]?.contentOld, "lv_demo")
  assert.equal(reply.affectedObjects[0]?.deltas[0]?.contentNew, "lv_renamed")
  assert.equal(reply.affectedObjects[0]?.deltas[1]?.range?.start?.line, 9)
  assert.equal(backend.refactoringCalls, 1)
  // The reply must say nothing was applied, or a caller could believe the refactoring happened.
  assert.match(reply.summary, /NOTHING was changed/)
  assert.match(reply.summary, /preview and execute/)
})

test("an empty evaluation reads as a definite answer, not as a failure or a missing endpoint", async () => {
  const backend = new MockBackend()
  const reply = await evaluate(backend)

  assert.equal(reply.affectedObjectCount, 0)
  assert.deepEqual(reply.affectedObjects, [])
  assert.equal(reply.totalDeltaCount, 0)
  assert.equal(reply.readOnly, true)
  assert.equal(reply.wroteToSap, false)
  // The three readings a caller must tell apart: nothing to refactor here / the call failed / the
  // target has no refactoring service. This is the first, and it is the service's own empty list.
  assert.equal(reply.objectListReported, true)
  assert.match(reply.summary, /EMPTY affected-object list/)
  assert.match(reply.summary, /definite/)
  assert.match(reply.summary, /not a failure/)
  assert.match(reply.summary, /unsupported-endpoint/)
})

test("a missing refactoring resource is surfaced as a named endpoint failure, not an empty list", async () => {
  const backend = new MockBackend()
  backend.refactoringFailure = new Error("refactorings capability unsupported-endpoint (HTTP 404)")

  await assert.rejects(
    () => evaluate(backend),
    (error: Error) => {
      assert.match(error.message, /404|unsupported-endpoint/)
      assert.doesNotMatch(error.message, /no affected object/)
      return true
    }
  )
  assert.deepEqual(backend.mutationCalls, [])
})

test("evaluating a refactoring is read-only: no write, lock or activation path is entered", async () => {
  const backend = new MockBackend()
  backend.refactoringOverride = AFFECTED

  const reply = await evaluate(backend)

  assert.equal(reply.affectedObjectCount, 1)
  assert.equal(reply.readOnly, true)
  assert.equal(reply.wroteToSap, false)
  assert.deepEqual(
    backend.mutationCalls,
    [],
    "evaluate_refactoring must not reach any SAP-mutating backend method"
  )
  // The stored source is untouched: the execute step would have rewritten it.
  const stored = await backend.readSourceByUri("w200", CLASS_URI)
  assert.equal(stored.source.includes("METHOD run."), true)
})

test("the read-only ledger has teeth: a real write is recorded by the same mechanism", async () => {
  const backend = new MockBackend()
  await backend.replaceSource("w200", CLASS_URI, "WRITE 'HEADLESS'.", "WRITE 'CHANGED'.")
  await backend.activateSource("w200", CLASS_URI)

  assert.deepEqual(backend.mutationCalls, ["replaceSource", "activateSource"])
})

test("the wire shape is the refactoring resource's: relation and range in the query, no body", async () => {
  const { backend, requests } = backendWithRecordingHttp({ relation: RENAME_REL })

  await new ToolService(backend).evaluateRefactoring(RENAME_BASE)

  const call = requests.find((request) => request.url.includes(REFACTOR_URL))
  assert.ok(call, "the shipped code must POST to the ADT refactoring resource")
  assert.equal(call.method, "POST")
  // The relation chooses WHICH refactoring, and the range says where. Both travel as query
  // parameters, which the library hands to the HTTP client as axios `params` rather than appending
  // to the url - so asserting on `url` alone would pass even if the range had been dropped.
  assert.equal(call.qs.rel, RENAME_REL)
  assert.equal(call.qs.step, "evaluate")
  assert.equal(call.qs.uri, `${SOURCE_PATH}#start=3,11;end=3,11`)
  // The evaluate step sends no body; a body here would be the preview/execute shape.
  assert.equal(call.body, undefined)
  assert.match(String(call.headers["Content-Type"] ?? ""), /application/)
})

test("extract-method asks for its own relation over the full range", async () => {
  const { backend, requests } = backendWithRecordingHttp({ relation: "extractmethod" })

  const reply = (await new ToolService(backend).evaluateRefactoring({
    fileUri: CLASS_URI,
    connectionId: "w200",
    kind: "extract-method",
    startLine: 3,
    startColumn: 4,
    endLine: 7,
    endColumn: 12
  })) as string
  const parsed = JSON.parse(reply) as RefactoringReply

  const call = requests.find((request) => request.url.includes(REFACTOR_URL))
  assert.ok(call)
  // A multi-line range must survive intact: collapsing it to one line would refactor the wrong text.
  assert.equal(call.qs.uri, `${SOURCE_PATH}#start=3,4;end=7,12`)
  assert.match(String(call.qs.rel), /extractmethod/)
  assert.equal(call.body, undefined)
  // The deltas must arrive for THIS relation too. Asserting only the wire shape let a real defect
  // through once: the two relations carry `affectedObjects` at different depths, and reading only the
  // top level made every extract-method answer look like "nothing affected".
  assert.equal(parsed.kind, "extract-method")
  assert.equal(parsed.affectedObjectCount, 1)
  assert.equal(parsed.totalDeltaCount, 1)
  assert.equal(parsed.affectedObjects[0]?.deltas[0]?.contentNew, "lv_renamed")
})

test("the answer is read wherever the affected objects sit, prefixed or not", async () => {
  // The measured w200 answer for a rename does NOT nest the objects under `genericRefactoring`, and
  // upstream's parser destructures that element unconditionally - which crashed the live call with
  // "Cannot destructure property 'ignoreSyntaxErrorsAllowed' of 'generic' as it is undefined". This
  // fixture is that answer's shape (objects directly on the relation root, namespace-prefixed), so the
  // guard fails if the parser ever assumes the wrapper again.
  const { backend } = backendWithRecordingHttp({ relation: RENAME_REL, shape: "w200" })

  const reply = (await new ToolService(backend).evaluateRefactoring(
    RENAME_BASE
  )) as unknown as string
  const parsed = JSON.parse(reply) as RefactoringReply

  assert.equal(parsed.oldName, "lv_demo")
  assert.equal(parsed.affectedObjectCount, 1)
  assert.equal(parsed.totalDeltaCount, 1)
  assert.equal(parsed.affectedObjects[0]?.name, "ZCL_DEMO")
  assert.equal(parsed.affectedObjects[0]?.deltas[0]?.contentOld, "lv_demo")
  assert.equal(parsed.affectedObjects[0]?.deltas[0]?.contentNew, "lv_renamed")
})

test("an answer with no refactoring element fails with its own excerpt, not as 'nothing affected'", async () => {
  // A 200 answer this code cannot read is NOT the same statement as "the refactoring would touch
  // nothing". Reporting zero affected objects here would tell a caller the refactoring is safe when
  // nothing is known about it, so the answer's own text is carried into the failure instead.
  const { backend } = backendWithRecordingHttp({
    relation: RENAME_REL,
    rawBody: "<html><body><h1>Service not available</h1></body></html>"
  })

  await assert.rejects(
    () => new ToolService(backend).evaluateRefactoring(RENAME_BASE),
    (error: Error) => {
      assert.match(error.message, /refactorings capability/)
      assert.match(error.message, /Service not available/)
      assert.match(error.message, /rename refactoring element/)
      assert.doesNotMatch(error.message, /no affected object/)
      return true
    }
  )
})

test("an empty answer body is reported as 'no object list', never as 'nothing would change'", async () => {
  // A body with no relation element at all tells this code nothing about what the refactoring would
  // touch. Reporting it as "0 affected objects, a definite answer" would assert something the service
  // never said, so the reply states what it actually knows: the answer carried no object list.
  const { backend } = backendWithRecordingHttp({ relation: RENAME_REL, rawBody: "" })

  const parsed = JSON.parse(
    (await new ToolService(backend).evaluateRefactoring(RENAME_BASE)) as unknown as string
  ) as RefactoringReply

  assert.equal(parsed.affectedObjectCount, 0)
  assert.deepEqual(parsed.affectedObjects, [])
  assert.equal(parsed.objectListReported, false)
  assert.match(parsed.summary, /WITHOUT an affected-object list/)
  assert.match(
    parsed.summary,
    /does\s+NOT say that nothing would change|NOT say that nothing would change/
  )
  assert.doesNotMatch(parsed.summary, /definite answer/)
})

test("an explicit empty object list IS a definite 'nothing affected'", async () => {
  // The other half of the distinction: when the service sends `<affectedObjects/>`, it is saying "the
  // list is empty", and that is a definite answer this reply must report as one.
  const { backend } = backendWithRecordingHttp({ relation: RENAME_REL, shape: "empty-list" })

  const parsed = JSON.parse(
    (await new ToolService(backend).evaluateRefactoring(RENAME_BASE)) as unknown as string
  ) as RefactoringReply

  assert.equal(parsed.affectedObjectCount, 0)
  assert.equal(parsed.objectListReported, true)
  assert.match(parsed.summary, /EMPTY affected-object list/)
  assert.match(parsed.summary, /definite/)
})

test("a position-only answer is not reported as an empty list", async () => {
  // The measured w200 answer for a rename on a program: the relation element arrives, no object list
  // does. This is the case that would otherwise be rendered as "the refactoring touches nothing".
  const { backend } = backendWithRecordingHttp({ relation: RENAME_REL, shape: "position-only" })

  const parsed = JSON.parse(
    (await new ToolService(backend).evaluateRefactoring(RENAME_BASE)) as unknown as string
  ) as RefactoringReply

  assert.equal(parsed.objectListReported, false)
  assert.equal(parsed.affectedObjectCount, 0)
  assert.equal(parsed.oldName, "lv_demo")
  // The answer's own element census is what makes the empty result attributable to the answer.
  assert.ok(parsed.answerElements.includes("renameRefactoring"))
  assert.match(parsed.summary, /WITHOUT an affected-object list/)
  assert.match(parsed.summary, /preview step/)
})

test("an unaddressable range is refused before any SAP access", async () => {
  const backend = new MockBackend()
  const bad = [
    { ...RENAME_BASE, startLine: 0 },
    { ...RENAME_BASE, startColumn: -1 },
    { ...RENAME_BASE, endLine: 0 },
    { ...RENAME_BASE, endColumn: -1 },
    { ...RENAME_BASE, startLine: 5, endLine: 3 },
    { ...RENAME_BASE, startColumn: 20, endColumn: 5 }
  ]
  for (const input of bad) {
    await assert.rejects(
      () => evaluate(backend, input),
      /must be an integer >=|must not precede/,
      `range ${JSON.stringify(input)} must be refused`
    )
  }
  assert.equal(backend.refactoringCalls, 0, "an invalid range must not reach the backend")
})

test("a connection that disagrees with the URI host is refused before any SAP access", async () => {
  const backend = new MockBackend()
  await assert.rejects(
    () => evaluate(backend, { ...RENAME_BASE, connectionId: "w300" }),
    /does not match the adt:\/\/ URI host/
  )
  assert.equal(backend.refactoringCalls, 0)
  assert.deepEqual(backend.mutationCalls, [])
})

test("a malformed URI is refused before any SAP access", async () => {
  const backend = new MockBackend()
  await assert.rejects(
    () => evaluate(backend, { ...RENAME_BASE, fileUri: "not-a-uri" }),
    /Invalid fileUri/
  )
  assert.equal(backend.refactoringCalls, 0)
})

test("the tool is registered read-only in both the registry and the contract", async () => {
  const entry = registryEntry("evaluate_refactoring")
  assert.ok(entry, "evaluate_refactoring must be registered")
  assert.equal(entry.group, "source")
  assert.deepEqual(entry.profiles, ["dev"])
  assert.equal(entry.route, "native-adt")
  assert.equal(entry.sapHelper, null)
  assert.deepEqual(entry.requiredHelperOperations, [])
  assert.deepEqual(entry.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true
  })
  assert.deepEqual(toolContracts.evaluate_refactoring.annotations, entry.annotations)
  const schema = toolContracts.evaluate_refactoring.inputSchema
  // The two relations are the only accepted kinds; there is no "execute" kind and no transport field,
  // which is what keeps the write half unreachable through this tool.
  assert.deepEqual(Object.keys(schema).sort(), [
    "connectionId",
    "endColumn",
    "endLine",
    "fileUri",
    "kind",
    "startColumn",
    "startLine"
  ])
  assert.equal(schema.kind._def.values ? true : true, true)
  const description = toolContracts.evaluate_refactoring.description
  assert.match(description, /Read-only/)
  assert.match(description, /WOULD change/)
  assert.match(description, /does NOT refactor/)
})

/**
 * A real `AdtBackend` whose client is a recording fake, so the URL, method, query and absence of a
 * body are the ones the shipped code sends rather than the ones a stub would accept.
 */
/**
 * How the recording fake answers the refactoring resource - the only call under test.
 *
 * `shape: "w200"` reproduces the answer measured on w200 (objects directly on the relation root,
 * namespace-prefixed, no `genericRefactoring` wrapper); the default is the shape upstream's own parser
 * expects. `rawBody` answers with arbitrary text, which is how "an unreadable answer" is tested.
 */
interface RefactoringHttpSpec {
  relation: string
  shape?: "upstream" | "w200" | "position-only" | "empty-list"
  rawBody?: string
}

function backendWithRecordingHttp(spec: RefactoringHttpSpec): {
  backend: AdtBackend
  requests: ObservedRequest[]
} {
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
          body: options.body as string | undefined,
          qs: (options.qs ?? {}) as Record<string, unknown>
        })
        if (url.includes("refactorings")) {
          const body =
            spec.rawBody ??
            (spec.shape === "w200"
              ? w200RefactoringResponseXml()
              : spec.shape === "position-only"
                ? positionOnlyRefactoringResponseXml()
                : spec.shape === "empty-list"
                  ? `${upstreamRoot(spec.relation, "<affectedObjects/>")}`
                  : refactoringResponseXml(spec.relation))
          return { body, status: 200, statusText: "OK", headers: {} }
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

/**
 * The answer w200 actually sends, as far as it could be read: the relation element is namespace
 * prefixed, `oldName` sits beside it, and the affected objects hang off the relation element with no
 * `genericRefactoring` wrapper around them (measured 2026-10-02 - the wrapped shape is what upstream's
 * parser assumes, and the live call crashed on the difference).
 */
function w200RefactoringResponseXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <ns:renameRefactoring xmlns:ns="http://www.sap.com/adt/refactorings"
      xmlns:adtcore="http://www.sap.com/adt/core">
      <ns:oldName>lv_demo</ns:oldName>
      <ns:newName>lv_renamed</ns:newName>
      <ns:affectedObjects>
        <ns:affectedObject adtcore:uri="${SOURCE_PATH}" adtcore:type="CLAS/OC"
          adtcore:name="ZCL_DEMO">
          <ns:textReplaceDeltas>
            <ns:textReplaceDelta>
              <ns:rangeFragment>${SOURCE_PATH}#start=3,11;end=3,18</ns:rangeFragment>
              <ns:contentOld>lv_demo</ns:contentOld>
              <ns:contentNew>lv_renamed</ns:contentNew>
            </ns:textReplaceDelta>
          </ns:textReplaceDeltas>
        </ns:affectedObject>
      </ns:affectedObjects>
    </ns:renameRefactoring>`
}

/**
 * The refactoring service's own XML answer, shaped the way upstream's parsers expect it.
 *
 * Two details were read out of `abap-adt-api/src/api/refactor.ts` rather than assumed:
 *   - the parsers call `fullParse(body, { removeNSPrefix: true })`, so the element is `renameRefactoring`
 *     / `extractMethodRefactoring` with attribute names bare (`uri`, not `adtcore:uri`);
 *   - `rangeFragment` is a URI STRING parsed by `parseUri` (`#start=l,c;end=l,c`), not a pair of
 *     `<start/>`/`<end/>` child elements.
 * It is kept as the shape upstream EXPECTS, so the tests that use it still fail if the wrapper reading
 * breaks; the answer w200 really sends is the separate `w200` shape above.
 */
function refactoringResponseXml(relation: string): string {
  const affectedObjects = `<affectedObjects>
      <affectedObject uri="${SOURCE_PATH}" type="CLAS/OC" name="ZCL_DEMO">
        <textReplaceDeltas>
          <textReplaceDelta>
            <rangeFragment>${SOURCE_PATH}#start=3,11;end=3,18</rangeFragment>
            <contentOld>lv_demo</contentOld>
            <contentNew>lv_renamed</contentNew>
          </textReplaceDelta>
        </textReplaceDeltas>
      </affectedObject>
    </affectedObjects>`
  return upstreamRoot(relation, affectedObjects)
}

/**
 * A `renameRefactoring` answer that carries NO object list - the shape w200 measured on 2026-10-02.
 *
 * The service answered about the position (it accepted the relation and the range) but listed no
 * affected objects at all, so the reply must not read as "nothing would change": on this release the
 * object list comes from the `preview` step, which this read-only tool does not call.
 */
function positionOnlyRefactoringResponseXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <renameRefactoring>
      <oldName>lv_demo</oldName>
      <ignoreSyntaxErrorsAllowed>true</ignoreSyntaxErrorsAllowed>
    </renameRefactoring>`
}

/** One of the two relation roots, with `affectedObjects` supplied by the caller. */
function upstreamRoot(relation: string, affectedObjects: string): string {
  if (relation.includes("extractmethod")) {
    return `<?xml version="1.0" encoding="UTF-8"?>
      <extractMethodRefactoring>
        <name>extracted_method</name>
        <className>ZCL_DEMO</className>
        <genericRefactoring>${affectedObjects}</genericRefactoring>
      </extractMethodRefactoring>`
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
    <renameRefactoring>
      <oldName>lv_demo</oldName>
      <newName>lv_renamed</newName>
      <genericRefactoring>${affectedObjects}</genericRefactoring>
    </renameRefactoring>`
}

/** The mock's active source for ZCL_DEMO. */
const ZCL_DEMO_SOURCE = [
  "CLASS zcl_demo IMPLEMENTATION.",
  "  METHOD run.",
  "    WRITE 'HEADLESS'.",
  "  ENDMETHOD.",
  "ENDCLASS."
].join("\n")
