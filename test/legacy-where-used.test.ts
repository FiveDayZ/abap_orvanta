import assert from "node:assert/strict"
import test from "node:test"
import type { AdtHTTP, HttpClientResponse, RequestOptions } from "abap-adt-api/build/AdtHTTP.js"
import {
  legacyWhereUsed,
  legacyWhereUsedPaths,
  parseLegacyReferences
} from "../src/legacy-where-used.js"
import { AdtBackend } from "../src/adt-backend.js"
import { collectWhereUsed, formatWhereUsed } from "../src/where-used.js"
import { MockBackend } from "./mock-backend.js"
import type { SapBackend } from "../src/backend.js"

const uri = "/sap/bc/adt/functions/groups/zgroup/fmodules/z_test/source/main"
const source = "FUNCTION Z_TEST.\nENDFUNCTION."
const xml = (body: string): HttpClientResponse =>
  ({
    body,
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/xml; charset=utf-8" }
  }) as HttpClientResponse
const mapping =
  "<ris_data_request><trobjtype>FUGR</trobjtype><subtype></subtype><legacy_type>FF</legacy_type><object_name>Z_TEST</object_name><encl_object_name></encl_object_name><scope_trobjtype></scope_trobjtype><scope_subtype></scope_subtype><scope_legacy_type></scope_legacy_type><scope_object_name></scope_object_name><scope_encl_object_name></scope_encl_object_name><full_name>FUNCTION=Z_TEST</full_name><suppress_selection_dialog>X</suppress_selection_dialog></ris_data_request>"
const metadata =
  "<ris_meta_object_types><ris_meta_object_type><trobjtype>PROG</trobjtype><subtype></subtype><legacy_type>P</legacy_type><description_singular>Program</description_singular></ris_meta_object_type><ris_meta_object_type><trobjtype>CLAS</trobjtype><subtype></subtype><legacy_type>OC</legacy_type></ris_meta_object_type></ris_meta_object_types>"
const reference = (name: string) =>
  `<ris_generic_results><ris_generic_result><enclosing_object_name></enclosing_object_name><object_name>${name}</object_name><description>A &amp; B %3Ctest%3E</description><uri>/sap/bc/adt/programs/programs/${name.toLowerCase()}</uri><code_lines/></ris_generic_result></ris_generic_results>`

function fixture(responses = [mapping, metadata, reference("ZCALLER"), reference("YCALLER")]) {
  const calls: { path: string; options: RequestOptions }[] = []
  const http = {
    async request(path: string, options: RequestOptions = {}) {
      calls.push({ path, options })
      const body = responses.shift()
      assert.notEqual(body, undefined, "unexpected extra request")
      return xml(body!)
    }
  }
  return { http: http as Pick<AdtHTTP, "request">, calls }
}

test("legacy protocol maps source position then queries actual SAP relationship types", async () => {
  const { http, calls } = fixture()
  const result = await legacyWhereUsed(http, uri, 1, 9, source)
  assert.equal(result.engine, "ADT_RIS_WHEREUSED")
  assert.equal(result.references.length, 2)
  assert.deepEqual(
    result.relationshipTypes.map((t) => t.trobjtype),
    ["PROG", "CLAS"]
  )
  assert.deepEqual(
    calls.map((c) => c.path),
    [
      legacyWhereUsedPaths[1],
      legacyWhereUsedPaths[2],
      legacyWhereUsedPaths[0],
      legacyWhereUsedPaths[0]
    ]
  )
  assert.equal(calls[0]!.options.body, source)
  assert.deepEqual(calls[0]!.options.qs, {
    RIS_REQUEST_TYPE: "MAP_URI_TO_RIS_REQUEST",
    uri: `${uri}#start=1,9`
  })
  assert.match(String(calls[2]!.options.body), /<object_type><trobjtype>PROG<\/trobjtype>/)
  assert.match(String(calls[2]!.options.body), /<payload><trobjtype>FUGR<\/trobjtype>/)
  assert.ok(calls.every((c) => c.options.method === "POST"))
  assert.equal(result.references[0]!.objectIdentifier, result.references[0]!.uri)
  assert.equal(result.references[0]!.identifierKind, "ADT_RIS_URI")
  assert.equal(result.references[0]!.description, "A & B <test>")
  assert.equal(result.references[0]!.type, undefined)
})

test("legacy response parser distinguishes empty results from malformed or unsafe content", () => {
  assert.deepEqual(parseLegacyReferences(xml("<ris_generic_results/>")), [])
  assert.deepEqual(parseLegacyReferences(xml("<ris_generic_results />")), [])
  assert.equal(parseLegacyReferences(xml(reference("ZCALLER"))).length, 1)
  for (const body of [
    "",
    "<html/>",
    "<ris_generic_results><ris_generic_result></ris_generic_results>",
    "<ris_generic_results><unexpected/></ris_generic_results>",
    "<ris_generic_results><ris_generic_result/></ris_generic_results>",
    reference("ZCALLER").replace("/sap/bc/adt/programs/programs/zcaller", "https://evil.invalid"),
    reference("ZCALLER").replace("/sap/bc/adt/programs/programs/zcaller", "/sap/bc/adt/../admin"),
    reference("ZCALLER").replace(
      "/sap/bc/adt/programs/programs/zcaller",
      "/sap/bc/adt/%2e%2e/admin"
    ),
    "<!DOCTYPE a [<!ENTITY secret 'x'>]><ris_generic_results/>"
  ])
    assert.throws(() => parseLegacyReferences(xml(body)), /parser-or-content-type/)
  assert.throws(
    () =>
      parseLegacyReferences({
        ...xml(reference("ZCALLER")),
        headers: { "content-type": "text/html" }
      }),
    /expected XML/
  )
  assert.throws(() => parseLegacyReferences({ ...xml(""), status: 403 }), /status code 403/)
})

test("legacy mapping fails closed on fallback, wrong identity, scope and empty metadata", async () => {
  for (const bad of [
    mapping.replace("<full_name>FUNCTION=Z_TEST</full_name>", "<full_name/>"),
    mapping.replace("<object_name>Z_TEST</object_name>", "<object_name>OTHER</object_name>"),
    mapping.replace(
      "<scope_object_name></scope_object_name>",
      "<scope_object_name>OTHER</scope_object_name>"
    ),
    "<ris_data_request/>"
  ]) {
    const { http, calls } = fixture([bad])
    await assert.rejects(legacyWhereUsed(http, uri, 1, 9, source), /mapping/)
    assert.equal(calls.length, 1)
  }
  const { http, calls } = fixture([mapping, "<ris_meta_object_types/>"])
  await assert.rejects(legacyWhereUsed(http, uri, 1, 9, source), /inconclusive/)
  assert.equal(calls.length, 2)
})

test("legacy adapter accepts the observed multiline ADT function header unchanged", async () => {
  for (const header of ["FUNCTION Z_TEST", "  function z_test  "]) {
    const { http, calls } = fixture()
    // W200 places the interface on following lines, without a period on the header.
    const adtSource = `${header}\r\n  IMPORTING\r\n    VALUE(IV_ACTION) TYPE CHAR50.\r\nENDFUNCTION.`
    const column = header.toUpperCase().indexOf("Z_TEST")
    const result = await legacyWhereUsed(http, uri, 1, column, adtSource)
    assert.equal(result.references.length, 2)
    assert.equal(calls[0]!.options.body, adtSource)
    assert.equal(calls[0]!.options.qs?.uri, `${uri}#start=1,${column}`)
  }
})

test("legacy declaration recognition retains exact name and line boundaries", async () => {
  const { http, calls } = fixture()
  for (const header of [
    "FUNCTION Z_TEST_OTHER",
    "FUNCTION Z_TEST garbage",
    "* FUNCTION Z_TEST",
    '" FUNCTION Z_TEST',
    "FUNCTION Z_TEST-MEMBER",
    "FUNCTION Z_TEST=>METHOD"
  ]) {
    await assert.rejects(
      legacyWhereUsed(http, uri, 1, header.indexOf("Z_TEST"), `${header}\nENDFUNCTION.`),
      /function declaration/
    )
  }
  assert.equal(calls.length, 0)
})

test("legacy adapter rejects unsupported cursor positions before any SAP request", async () => {
  const { http, calls } = fixture()
  for (const args of [
    [uri, 1, 0, source],
    [uri, 2, 0, source],
    [uri.replace("z_test/source", "other/source"), 1, 9, source],
    ["/sap/bc/adt/programs/programs/z_test/source/main", 1, 9, source]
  ] as const)
    await assert.rejects(
      legacyWhereUsed(http, args[0], args[1], args[2], args[3]),
      /function declaration/
    )
  assert.equal(calls.length, 0)
})

test("legacy report never labels partial or empty coverage as a complete success", async () => {
  const backend: SapBackend = new MockBackend()
  backend.readSourceByUri = async () => ({ source, uriUsed: uri })
  const { http } = fixture()
  const result = await legacyWhereUsed(http, uri, 1, 9, source)
  backend.usageReferences = async () => result
  backend.usageReferenceSnippets = async () => {
    throw new Error("must not use modern snippets")
  }
  const input = {
    connectionId: "w200",
    objectName: "Z_TEST",
    objectUri: uri,
    includeSnippets: true
  }
  const report = await collectWhereUsed(backend, { ...input, filter: { objectNamePattern: "Z*" } })
  assert.equal(report.status, "partial")
  assert.equal(report.engine, "ADT_RIS_WHEREUSED")
  assert.equal(report.references?.length, 1)
  assert.equal(report.snippets.length, 0)
  assert.match(report.warnings.join(" "), /not implemented/)
  assert.equal(
    (await collectWhereUsed(backend, { ...input, filter: { objectTypes: ["PROG/P"] } })).status,
    "failed"
  )
  backend.usageReferences = async () => ({ ...result, references: [] })
  const empty = await collectWhereUsed(backend, input)
  assert.equal(empty.status, "partial")
  assert.equal(empty.code, "LEGACY_NO_REFERENCES_UNVERIFIED")
  assert.doesNotMatch(formatWhereUsed(empty), /No references found/)
})

test("ADT backend uses discovery for legacy selection and never retries authorization failures", async () => {
  const backend = new AdtBackend([])
  const { http, calls } = fixture()
  let modern = 0
  let paths: readonly string[] = legacyWhereUsedPaths
  const client = {
    statelessClone: {
      httpClient: {
        request: async (path: string, options: RequestOptions) => {
          if (path === "/sap/bc/adt/discovery")
            return xml(
              `<app:service><app:workspace>${paths.map((href) => `<app:collection href="${href}"/>`).join("")}</app:workspace></app:service>`
            )
          if (path !== "/sap/bc/adt/repository/informationsystem/usageReferences")
            return http.request(path, options)
          modern++
          throw Object.assign(new Error("status code 403"), { status: 403 })
        }
      }
    }
  }
  Object.assign(backend, { getClient: async () => client })
  const result = await backend.usageReferences("w200", uri, 1, 9, source)
  assert.ok(!Array.isArray(result))
  if (!Array.isArray(result)) {
    assert.deepEqual(
      result.requestTrace?.map((entry) => entry.stage),
      ["discovery", "mapping", "metadata", "references", "references"]
    )
  }
  assert.equal(modern, 0)
  paths = [...legacyWhereUsedPaths, "/sap/bc/adt/repository/informationsystem/usageReferences"]
  await assert.rejects(
    backend.usageReferences("w200", uri, 1, 9, source),
    /forbidden-or-not-authorized/
  )
  assert.equal(calls.length, 4)
  // A partially advertised legacy route means neither engine is usable. Falling through to the
  // modern endpoint here would report a 404 for an endpoint the platform never claimed to have,
  // which reads as "no where-used on this system" and conceals the missing RIS endpoints.
  paths = legacyWhereUsedPaths.slice(0, 2)
  await assert.rejects(backend.usageReferences("w200", uri, 1, 9, source), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    assert.match(message, /where-used capability unsupported-endpoint/)
    assert.match(
      message,
      /missing legacy endpoint\(s\): \/sap\/bc\/adt\/repository\/informationsystem\/metadata/
    )
    return true
  })
  assert.equal(modern, 1)
  assert.equal(calls.length, 4)
})
