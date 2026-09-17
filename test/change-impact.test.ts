import assert from "node:assert/strict"
import test from "node:test"
import { collectChangeImpact } from "../src/change-impact.js"
import { MockBackend } from "./mock-backend.js"
import type { SapBackend } from "../src/backend.js"

const uri = (name: string) => `adt://w200/sap/bc/adt/programs/programs/${name.toLowerCase()}`
const input = {
  connectionId: "w200",
  objectName: "ZTARGET",
  semanticReferences: false,
  candidateSources: [{ objectName: "ZCALLER", objectUri: uri("ZCALLER") }]
}

test("impact text evidence preserves boundaries, line locations and partial coverage", async () => {
  const backend = new MockBackend()
  backend.readSourceByUri = async (_id, value) => ({
    uriUsed: value,
    source: "REPORT zcaller.\nSUBMIT ztarget.\n* ZTARGET comment\nDATA ztarget_more TYPE i."
  })
  const result = await collectChangeImpact(backend, input)
  assert.equal(result.status, "partial")
  assert.equal(result.safeToChange, "not_determined")
  assert.equal(result.semantic, null)
  assert.deepEqual(
    result.textualEvidence.hits.map((hit) => hit.line),
    [2, 3]
  )
  assert.match(result.textualEvidence.sources[0]!.fingerprint!, /^[a-f0-9]{64}$/)
  assert.equal(result.textualEvidence.scopeComplete, true)
  assert.equal(result.coverage.repositoryComplete, false)
})

test("impact validates all scope URIs before any source or semantic requests", async () => {
  const backend = new MockBackend()
  let calls = 0
  backend.readSourceByUri = async () => {
    calls++
    throw new Error("unexpected")
  }
  backend.searchObjects = async () => {
    calls++
    return []
  }
  await assert.rejects(
    collectChangeImpact(backend, {
      ...input,
      semanticReferences: true,
      candidateSources: [
        ...input.candidateSources,
        { objectName: "ZBAD", objectUri: uri("ZBAD").replace("w200", "other") }
      ]
    }),
    /same-connection/
  )
  assert.equal(calls, 0)
})

test("impact never silently substitutes a different source or reports an empty scan as safe", async () => {
  const backend = new MockBackend()
  backend.readSourceByUri = async () => ({ uriUsed: uri("ZOTHER"), source: "REPORT zother." })
  const result = await collectChangeImpact(backend, input)
  assert.equal(result.status, "unavailable")
  assert.equal(result.textualEvidence.scopeComplete, false)
  assert.equal(result.textualEvidence.sources[0]!.status, "failed")
  assert.equal(result.safeToChange, "not_determined")
})

test("impact retains text evidence when semantic retrieval fails and reports hit truncation", async () => {
  const backend = new MockBackend()
  backend.readSourceByUri = async (_id, value) => ({
    uriUsed: value,
    source: value.includes("ztarget") ? "REPORT ztarget." : "SUBMIT ztarget.\n* ZTARGET"
  })
  backend.usageReferences = async () => {
    throw new Error("capability unsupported-endpoint: 404")
  }
  const result = await collectChangeImpact(backend, {
    ...input,
    semanticReferences: true,
    objectUri: uri("ZTARGET"),
    maxTextHits: 1
  })
  assert.equal(result.semantic!.status, "unavailable")
  assert.equal(result.textualEvidence.matchedLines, 2)
  assert.equal(result.textualEvidence.hits.length, 1)
  assert.equal(result.textualEvidence.truncated, true)
  assert.equal(result.status, "partial")
})

test("impact keeps semantic references separate from textual hints", async () => {
  const backend = new MockBackend()
  backend.readSourceByUri = async (_id, value) => ({ uriUsed: value, source: "REPORT ztarget." })
  backend.usageReferences = async () => [
    {
      name: "ZCALLER",
      uri: uri("ZCALLER"),
      objectIdentifier: "ABAPFullName;ZCALLER"
    }
  ]
  const result = await collectChangeImpact(backend, {
    connectionId: "w200",
    objectName: "ZTARGET",
    objectUri: uri("ZTARGET")
  })
  assert.equal(result.semantic!.references!.length, 1)
  assert.equal(result.textualEvidence.hits.length, 0)
  assert.equal(result.coverage.semanticPageComplete, true)
  assert.equal(result.coverage.repositoryComplete, false)
})

test("impact bounds source size and rejects duplicate candidate URIs", async () => {
  const backend = new MockBackend()
  backend.readSourceByUri = async (_id, value) => ({
    uriUsed: value,
    source: "x".repeat(1024 * 1024 + 1)
  })
  const result = await collectChangeImpact(backend, input)
  assert.equal(result.textualEvidence.sources[0]!.status, "limit_exceeded")
  assert.equal(result.textualEvidence.scopeComplete, false)
  await assert.rejects(
    collectChangeImpact(backend, {
      ...input,
      candidateSources: [...input.candidateSources, ...input.candidateSources]
    }),
    /Duplicate/
  )
})

test("impact searches the selected field in an exact program include instead of the owner name", async () => {
  const backend = new MockBackend()
  const includeUri = "adt://w200/sap/bc/adt/programs/includes/zcaller_scr/source/main"
  backend.readSourceByUri = async (_id, value) => ({
    uriUsed: value,
    source: "PARAMETERS p_werks TYPE c.\n* P_WERKS\nDATA p_werks_other TYPE c."
  })
  const result = await collectChangeImpact(backend, {
    ...input,
    searchTerm: "p_werks",
    candidateSources: [{ objectName: "ZCALLER_SCR", objectUri: includeUri }]
  })
  assert.equal(result.textualEvidence.searchTerm, "P_WERKS")
  assert.deepEqual(
    result.textualEvidence.hits.map((hit) => hit.line),
    [1, 2]
  )
  assert.equal(result.textualEvidence.scopeComplete, true)
  assert.equal(result.semantic, null)
})

test("impact explicit text term is literal and independent from the semantic cursor term", async () => {
  const backend = new MockBackend()
  backend.readSourceByUri = async (_id, value) => ({
    uriUsed: value,
    source: "* LS_ROW-FIELD+\n* LS_ROW-FIELDD\n* OTHER"
  })
  const result = await collectChangeImpact(backend, {
    ...input,
    searchTerm: "OTHER",
    textSearchTerm: "LS_ROW-FIELD+"
  })
  assert.deepEqual(
    result.textualEvidence.hits.map((hit) => hit.line),
    [1]
  )
  await assert.rejects(collectChangeImpact(backend, { ...input, textSearchTerm: " " }))
})

test("impact forwards native paging filters and snippets without certifying the full selection", async () => {
  const backend: SapBackend = new MockBackend()
  backend.readSourceByUri = async (_id, value) => ({
    uriUsed: value,
    source: "REPORT ztarget."
  })
  backend.usageReferences = async () =>
    ["ZFIRST", "ZSECOND", "SAP_OTHER"].map((name) => ({
      name,
      uri: uri(name),
      objectIdentifier: `ABAPFullName;${name}`
    }))
  let snippetCalls = 0
  backend.usageReferenceSnippets = async (_id, refs) => {
    snippetCalls++
    assert.deepEqual(
      refs.map((ref) => ref.name),
      ["ZSECOND"]
    )
    return [
      {
        objectIdentifier: refs[0]!.objectIdentifier,
        snippets: [{ line: 12, content: "SUBMIT ztarget." }]
      }
    ]
  }
  const result = await collectChangeImpact(backend, {
    connectionId: "w200",
    objectName: "ZTARGET",
    objectUri: uri("ZTARGET"),
    startIndex: 1,
    maxResults: 1,
    includeSnippets: true,
    filter: { excludeSystemObjects: true }
  })
  assert.equal(snippetCalls, 1)
  assert.equal(result.semantic!.filteredCount, 2)
  assert.equal(result.semantic!.references![0]!.name, "ZSECOND")
  assert.equal(result.semantic!.snippets[0]!.snippets[0]!.line, 12)
  assert.equal(result.coverage.semanticSelectionComplete, false)
  assert.match(result.semantic!.sourceFingerprint!, /^[a-f0-9]{64}$/)
})

test("impact rejects invalid paging before making remote requests", async () => {
  const backend = new MockBackend()
  let calls = 0
  backend.searchObjects = async () => {
    calls++
    return []
  }
  backend.readSourceByUri = async () => {
    calls++
    throw new Error("unexpected")
  }
  for (const extra of [{ startIndex: -1 }, { maxResults: 101 }]) {
    await assert.rejects(collectChangeImpact(backend, { ...input, ...extra }))
  }
  assert.equal(calls, 0)
})
