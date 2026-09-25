import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { collectWhereUsed, formatWhereUsed, sourceUri } from "../src/where-used.js"
import { startHttpServer } from "../src/http.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"
import type { AbapObjectInfo, SapBackend, UsageReferenceInfo } from "../src/backend.js"

const uri =
  "adt://w200/sap/bc/adt/functions/groups/zorvanta_mcp_core/fmodules/z_orvanta_mcp_sci_api"
const name = "Z_ORVANTA_MCP_SCI_API"

test("program include URI support preserves object, connection and path validation", () => {
  const path = "/sap/bc/adt/programs/includes/zinclude/source/main"
  assert.equal(sourceUri(path, "w200", "ZINCLUDE"), `adt://w200${path}`)
  for (const value of [
    `adt://other${path}`,
    path.replace("zinclude", "zother"),
    `${path}?version=inactive`,
    path.replace("zinclude", "%7ainclude")
  ])
    assert.throws(() => sourceUri(value, "w200", "ZINCLUDE"))
})
const base = { connectionId: "w200", objectName: name }
const object: AbapObjectInfo = {
  name,
  type: "FUGR/FF",
  description: "",
  package: "",
  systemType: "CUSTOM",
  uri: uri.replace("adt://w200", "")
}
const reference = (name: string, id = `ABAPFullName;${name}`): UsageReferenceInfo => ({
  name,
  objectIdentifier: id,
  uri: `/sap/bc/adt/programs/programs/${name.toLowerCase()}`,
  type: "PROG/P"
})
function fixture() {
  const backend: SapBackend = new MockBackend()
  const calls: unknown[][] = []
  backend.searchObjects = async (_connection, _pattern, types) => {
    calls.push(["search", types])
    return [object]
  }
  backend.readSourceByUri = async (_connection, value) => {
    calls.push(["source", value])
    return { source: `FUNCTION ${name}.\nENDFUNCTION.`, uriUsed: `${object.uri}/source/main` }
  }
  backend.usageReferences = async (_connection, value, line, character) => {
    calls.push(["references", value, line, character])
    return [reference("ZCALLER")]
  }
  return { backend, calls }
}

test("where-used exact URI bypasses discovery and uses the verified declaration position", async () => {
  const { backend, calls } = fixture()
  const result = await collectWhereUsed(backend, { ...base, objectUri: uri })
  assert.equal(result.status, "ok")
  assert.equal(result.resolution, "explicit_uri")
  assert.equal(calls.filter((call) => call[0] === "search").length, 0)
  assert.deepEqual(result.target, { uri: `${uri}/source/main`, line: 1, character: 9 })
  assert.equal(result.references?.[0]?.name, "ZCALLER")
})

test("where-used typed discovery miss uses one bounded exact-name fallback and preserves type checks", async () => {
  const { backend, calls } = fixture()
  backend.searchObjects = async (_connection, pattern, types, max) => {
    calls.push(["search", types])
    assert.equal(pattern, name)
    assert.equal(max, 100)
    return types?.length ? [] : [{ ...object, name: `${name}_OTHER` }, object]
  }
  const result = await collectWhereUsed(backend, { ...base, objectType: "FUGR/FF" })
  assert.equal(result.resolution, "bounded_name_search")
  assert.equal(result.status, "ok")
  assert.equal(calls.filter((call) => call[0] === "search").length, 2)
  assert.equal(
    (await collectWhereUsed(backend, { ...base, objectType: "CLAS/OC" })).stage,
    "resolve"
  )
})

test("where-used typed exact match does not trigger a broader second search", async () => {
  const { backend, calls } = fixture()
  assert.equal(
    (await collectWhereUsed(backend, { ...base, objectType: "FUNC/FF" })).resolution,
    "typed_search"
  )
  assert.equal(calls.filter((call) => call[0] === "search").length, 1)
})

test("where-used resolves a class whose reported type is the ADT path, not the search code", async () => {
  // Live w200 2026-09-25T14:49: the repository search answered `CLAS/OC` for
  // ZCL_PMC_TP_REPACK_PLAN while the caller passed `CLAS`; comparing the raw tokens dropped the
  // only exact match and the tool reported RESOLUTION_INCONCLUSIVE for an existing class.
  const { backend, calls } = fixture()
  const classObject: AbapObjectInfo = {
    name: "ZCL_PMC_TP_REPACK_PLAN",
    type: "CLAS/OC",
    description: "",
    package: "",
    systemType: "CUSTOM",
    uri: "/sap/bc/adt/oo/classes/zcl_pmc_tp_repack_plan"
  }
  backend.searchObjects = async (_connection, _pattern, types) => {
    calls.push(["search", types])
    return types?.length ? [classObject] : []
  }
  backend.readSourceByUri = async () => ({
    source: "CLASS zcl_pmc_tp_repack_plan DEFINITION PUBLIC FINAL CREATE PUBLIC.\nENDCLASS.",
    uriUsed: `${classObject.uri}/source/main`
  })
  const input = { connectionId: "w200", objectName: classObject.name, objectType: "CLAS" }
  const result = await collectWhereUsed(backend, input)
  assert.equal(result.status, "ok")
  assert.equal(result.resolution, "typed_search")
  assert.deepEqual(result.target, {
    uri: `adt://w200${classObject.uri}/source/main`,
    line: 1,
    character: 6
  })
  assert.equal(calls.filter((call) => call[0] === "search").length, 1)
  // The search code is what the repository search accepts, so an ADT path from this service's own
  // output is translated instead of searched verbatim and answered with an empty result.
  const typed = await collectWhereUsed(backend, { ...input, objectType: "CLAS/OC" })
  assert.equal(typed.status, "ok")
  assert.deepEqual(
    calls.filter((call) => call[0] === "search").map((call) => call[1]),
    [["CLAS"], ["CLAS"]]
  )
})

test("where-used accepts objectUri together with objectType and reports the ignored type", async () => {
  const { backend, calls } = fixture()
  const result = await collectWhereUsed(backend, {
    ...base,
    objectUri: uri,
    objectType: "FUGR/FF"
  })
  assert.equal(result.status, "ok")
  assert.equal(result.resolution, "explicit_uri")
  assert.equal(calls.filter((call) => call[0] === "search").length, 0)
  assert.match(result.warnings.join(" "), /objectType "FUGR\/FF" was ignored/)
})

test("where-used discovery ambiguity, limits, prefix matches and failure never imply absence", async () => {
  for (const results of [
    [],
    [{ ...object, name: `${name}_OTHER` }],
    [object, { ...object, uri: `/sap/bc/adt/programs/programs/${name.toLowerCase()}` }],
    Array(100).fill(object)
  ]) {
    const { backend, calls } = fixture()
    backend.searchObjects = async () => results
    const result = await collectWhereUsed(backend, base)
    assert.equal(result.status, "failed")
    assert.equal(result.stage, "resolve")
    assert.equal(result.references, null)
    assert.equal(calls.length, 0)
    assert.doesNotMatch(formatWhereUsed(result), /No references found/)
  }
  const { backend, calls } = fixture()
  backend.searchObjects = async () => {
    throw new Error("forbidden")
  }
  assert.equal((await collectWhereUsed(backend, base)).stage, "resolve")
  assert.equal(calls.length, 0)
})

test("where-used validates URI identity and numeric bounds before any SAP request", async () => {
  const { backend, calls } = fixture()
  for (const extra of [
    { objectUri: uri.replace("w200", "w201") },
    { objectUri: `${uri}?version=inactive` },
    { objectUri: `${uri}#main` },
    { objectUri: uri.replace(name.toLowerCase(), "zother") },
    { objectUri: uri.replace(name.toLowerCase(), "%2e%2e") },
    { objectUri: uri.replace("w200", "user:password@w200") },
    { objectUri: uri.replace("w200", "w200:8000") },
    { objectUri: "adt://w200/sap/bc/adt/packages/zabap" },
    { maxResults: 0 },
    { maxResults: 101 },
    { maxResults: 1.5 },
    { line: 0 },
    { character: 1 },
    { startIndex: -1 },
    { startIndex: 10001 },
    { objectName: "Z*" }
  ])
    await assert.rejects(collectWhereUsed(backend, { ...base, ...extra }))
  assert.equal(calls.length, 0)
})

test("where-used source failures and changed source targets stop before reference queries", async () => {
  const { backend, calls } = fixture()
  backend.readSourceByUri = async () => {
    throw new Error("read failed")
  }
  assert.equal((await collectWhereUsed(backend, { ...base, objectUri: uri })).stage, "source")
  backend.readSourceByUri = async () => ({
    source: `FUNCTION ${name}.`,
    uriUsed: "/sap/bc/adt/programs/programs/zother"
  })
  assert.equal((await collectWhereUsed(backend, { ...base, objectUri: uri })).stage, "source")
  assert.equal(calls.length, 0)
})

test("where-used repeated terms require explicit disambiguation and validates supplied coordinates", async () => {
  const { backend, calls } = fixture()
  backend.readSourceByUri = async () => ({
    source: `FUNCTION ${name}.\nWRITE '${name}'.\nENDFUNCTION.`,
    uriUsed: object.uri
  })
  const ambiguous = await collectWhereUsed(backend, { ...base, objectUri: uri, searchTerm: name })
  assert.equal(ambiguous.stage, "position")
  assert.equal(ambiguous.references, null)
  assert.equal(calls.length, 0)
  const explicit = await collectWhereUsed(backend, {
    ...base,
    objectUri: uri,
    searchTerm: name,
    line: 1,
    character: 9
  })
  assert.equal(explicit.status, "ok")
  for (const extra of [
    { line: 100 },
    { line: 1, character: 999 },
    { line: 1, character: 0, searchTerm: name }
  ]) {
    assert.equal(
      (await collectWhereUsed(backend, { ...base, objectUri: uri, ...extra })).stage,
      "position"
    )
  }
})

test("where-used missing declarations do not silently select line one", async () => {
  const { backend, calls } = fixture()
  backend.readSourceByUri = async () => ({ source: "* Only a comment", uriUsed: object.uri })
  const result = await collectWhereUsed(backend, { ...base, objectUri: uri })
  assert.equal(result.stage, "position")
  assert.equal(calls.length, 0)
})

test("where-used endpoint failures retain unavailable versus failed with unknown counts", async () => {
  for (const [category, expected] of [
    ["unsupported-endpoint", "unavailable"],
    ["forbidden-or-not-authorized", "failed"],
    ["parser-or-content-type", "failed"]
  ]) {
    const { backend } = fixture()
    backend.usageReferences = async () => {
      throw new Error(`where-used capability ${category}: password=secret123`)
    }
    const result = await collectWhereUsed(backend, { ...base, objectUri: uri })
    assert.equal(result.status, expected)
    assert.equal(result.stage, "references")
    assert.equal(result.rawCount, null)
    assert.equal(result.references, null)
    assert.doesNotMatch(result.error?.message ?? "", /secret123/)
  }
})

test("where-used genuine empty, unsupported identifiers, filters and paging remain distinct", async () => {
  const { backend } = fixture()
  backend.usageReferences = async () => []
  const empty = await collectWhereUsed(backend, base)
  assert.equal(empty.code, "NO_REFERENCES")
  assert.equal(empty.status, "ok")
  backend.usageReferences = async () => [reference("ZCALLER", "Other;ZCALLER")]
  const unsupported = await collectWhereUsed(backend, base)
  assert.equal(unsupported.status, "partial")
  assert.equal(unsupported.rawCount, 1)
  assert.equal(unsupported.supportedCount, 0)
  assert.equal(unsupported.code, "UNSUPPORTED_REFERENCE_IDENTIFIERS")
  assert.doesNotMatch(formatWhereUsed(unsupported), /No references found/)
  backend.usageReferences = async () => [
    reference("SAPCALLER"),
    reference("ZCALLER"),
    reference("YCALLER")
  ]
  const page = await collectWhereUsed(backend, {
    ...base,
    maxResults: 1,
    filter: { excludeSystemObjects: true }
  })
  assert.equal(page.rawCount, 3)
  assert.equal(page.filteredCount, 2)
  assert.equal(page.references?.length, 1)
  assert.equal(page.hasMore, true)
  const filtered = await collectWhereUsed(backend, {
    ...base,
    filter: { objectNamePattern: "NO*" }
  })
  assert.equal(filtered.code, "FILTERED_EMPTY")
  assert.equal(filtered.rawCount, 3)
  const outside = await collectWhereUsed(backend, { ...base, startIndex: 10 })
  assert.equal(outside.rawCount, 3)
  assert.equal(outside.references?.length, 0)
  assert.equal(outside.code, "PAGE_OUT_OF_RANGE")
})

test("where-used failed snippets preserve references and successful snippets are limited to the selected page", async () => {
  const { backend } = fixture()
  backend.usageReferenceSnippets = async () => {
    throw new Error("snippet endpoint failed")
  }
  const partial = await collectWhereUsed(backend, { ...base, includeSnippets: true })
  assert.equal(partial.status, "partial")
  assert.equal(partial.stage, "snippets")
  assert.equal(partial.references?.length, 1)
  backend.usageReferenceSnippets = async () => [
    { objectIdentifier: "ABAPFullName;OTHER", snippets: [{ line: 1, content: "unrelated" }] },
    {
      objectIdentifier: "ABAPFullName;ZCALLER",
      snippets: Array(5).fill({ line: 2, content: "x".repeat(3000) })
    }
  ]
  const result = await collectWhereUsed(backend, { ...base, includeSnippets: true })
  assert.equal(result.snippets.length, 1)
  assert.equal(result.snippets[0]?.snippets.length, 3)
  assert.equal(result.snippets[0]?.snippets[0]?.content.length, 2000)
})

test("where-used JSON is exposed through MCP while default output remains text", async () => {
  const { backend } = fixture()
  const state = await mkdtemp(join(tmpdir(), "where-used-test-"))
  const running = await startHttpServer(backend, 0, state)
  const client = new Client({ name: "where-used-test", version: "1" })
  try {
    const transport = new StreamableHTTPClientTransport(new URL(running.mcpUrl))
    await client.connect(transport as Parameters<Client["connect"]>[0])
    const result = await client.callTool({
      name: "find_where_used",
      arguments: { ...base, objectUri: uri, responseFormat: "json" }
    })
    assert.equal(result.isError, undefined)
    const report = JSON.parse((result.content as { text: string }[])[0]!.text)
    assert.equal(report.resolution, "explicit_uri")
    assert.equal(report.status, "ok")
    const invalid = await client.callTool({
      name: "find_where_used",
      arguments: { ...base, maxResults: 101 }
    })
    assert.equal(invalid.isError, true)
    assert.match(await new ToolService(backend).findWhereUsed(base), /ABAP Where-Used Analysis/)
  } finally {
    await client.close()
    await running.close()
    await rm(state, { recursive: true, force: true })
  }
})

test("acceptance probe marks a real MCP failure response as Failed, not partial verification", async () => {
  const { backend } = fixture()
  backend.usageReferences = async () => {
    throw new Error("Synthetic declaration rejection for acceptance status regression")
  }
  const state = await mkdtemp(join(tmpdir(), "where-used-probe-test-"))
  // This case drives the real acceptance probe against a mock service. Its
  // evidence must not join the `.doc` acceptance archive, so it is redirected
  // to a scratch directory that this case owns.
  const evidenceDir = await mkdtemp(join(tmpdir(), "where-used-probe-evidence-"))
  const running = await startHttpServer(backend, 0, state)
  try {
    const output = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["scripts/probe-where-used.mjs"], {
        env: {
          ...process.env,
          ABAP_MCP_URL: running.mcpUrl,
          ABAP_MCP_EVIDENCE_DIR: evidenceDir
        },
        windowsHide: true,
        timeout: 20000
      })
      let stdout = ""
      child.stdout.on("data", (chunk) => {
        stdout += chunk
      })
      child.on("error", reject)
      child.on("close", (code) => resolve({ code, stdout }))
    })
    assert.equal(output.code, 1)
    const summary = JSON.parse(output.stdout.trim())
    assert.equal(summary.status, "Failed")
    assert.equal(summary.stage, "explicit-uri")
    assert.ok(
      summary.path.startsWith(evidenceDir),
      `synthetic evidence must stay out of the .doc archive: ${summary.path}`
    )
    const evidence = JSON.parse(await readFile(summary.path, "utf8"))
    assert.equal(evidence.behaviorVerified, false)
    assert.equal(evidence.checks[0].report.status, "failed")
    assert.match(evidence.checks[0].report.error.message, /Synthetic declaration rejection/)
  } finally {
    await running.close()
    await rm(state, { recursive: true, force: true })
    await rm(evidenceDir, { recursive: true, force: true })
  }
})
