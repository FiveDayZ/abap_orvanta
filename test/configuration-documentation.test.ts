import assert from "node:assert/strict"
import test from "node:test"
import {
  readConfigurationDocumentation,
  configurationDocumentationSchema,
  configurationDocumentationTables as tables,
  configurationDocumentationStructures as structures,
  configurationDocumentationFunctions as functions
} from "../src/configuration-documentation.js"
import { parseRemoteFunctionResponse } from "../src/adt-backend.js"
import type { RemoteFunctionResult } from "../src/backend.js"
import { toolContracts } from "../src/contracts.js"
import { toolNamesForProfile } from "../src/tool-registry.js"

// Synthetic metadata/text only; these identifiers are not claims about a SAP document.
const input = { connectionId: "w200", activityId: "TEST_IMG", language: "ZH" }
const fixture = () => {
  const data: Record<string, Record<string, string>[]> = {
    CUS_IMGACH: [
      { ACTIVITY: "TEST_IMG", DOCU_ID: "SIMGTEST_DOC", ATTRIBUTES: "", C_ACTIVITY: "", TCODE: "" }
    ],
    T002: [{ LAISO: "ZH", SPRAS: "1" }],
    DOKIL: [
      {
        ID: "HY",
        OBJECT: "SIMGTEST_DOC",
        LANGU: "1",
        TYP: "E",
        VERSION: "0002",
        TXTLINES: "00001",
        DOKSTATE: "A"
      }
    ]
  }
  let apiCalls = 0
  const options = {
    drift: false,
    bodyDrift: false,
    metadataDrift: false,
    queryFailure: false,
    headMismatch: false,
    headVersion: "00002",
    bodyCount: 1,
    fault: null as string | null
  }
  const readMetadata = async (objectName: string) => ({
    connectionId: "w200",
    objectName,
    objectKind: objectName in tables ? "transparentTable" : "structure",
    fingerprint: options.metadataDrift
      ? "0".repeat(64)
      : ({ ...tables, ...structures } as Record<string, string>)[objectName]
  })
  const fn = async (functionName: string) => ({
    connectionId: "w200",
    functionName,
    updateTask: false,
    ...functions[functionName as keyof typeof functions]
  })
  const run = (raw: unknown = input, client = "200", metadata = readMetadata) =>
    readConfigurationDocumentation(
      raw,
      client,
      "EN",
      {
        runQuery: async (_id, sql) => {
          if (options.queryFailure) throw Error("not allowed")
          const match = /^SELECT (.+) FROM (\w+) WHERE (.+)$/.exec(sql)!
          const fields = match[1]!.split(", "),
            filters = [...match[3]!.matchAll(/(\w+) = '((?:''|[^'])*)'/g)]
          const rows = (data[match[2]!] ?? []).filter((r) =>
            filters.every((f) => r[f[1]!] === f[2]!.replaceAll("''", "'"))
          )
          if (options.drift && apiCalls && match[2] === "DOKIL")
            return rows.map((r) => ({ ...r, VERSION: "0003" }))
          return rows.map((r) => Object.fromEntries(fields.map((f) => [f, r[f]!])))
        },
        callRemoteFunction: async (_id, request): Promise<RemoteFunctionResult> => {
          apiCalls++
          assert.equal(request.functionName, "DOCU_GET")
          assert.deepEqual(request.inputParameters, {
            ID: "HY",
            OBJECT: "SIMGTEST_DOC",
            LANGU: "1",
            TYP: "E",
            VERSION: "0002",
            VERSION_ACTIVE_OR_LAST: "L",
            EXTEND_EXCEPT: "",
            PRINT_PARAM_GET: "",
            LINE: []
          })
          if (options.fault)
            return {
              outputs: {},
              fault: { code: "SOAP", name: options.fault, message: "first API failure" }
            }
          return {
            outputs: {
              HEAD: {
                TDOBJECT: "DSYS",
                TDNAME: options.headMismatch ? "OTHER" : "SIMGTEST_DOC",
                TDID: "HY",
                TDSPRAS: "1",
                TDVERSION: options.headVersion
              },
              DOKTYP: "E",
              LINE: Array.from({ length: options.bodyCount }, () => ({
                TDFORMAT: "  ",
                TDLINE: options.bodyDrift && apiCalls === 2 ? "changed" : "  text <GL:link>  "
              }))
            }
          }
        }
      },
      metadata,
      metadata,
      fn
    )
  return { data, options, run, apiCalls: () => apiCalls }
}

test("exact indexed version and ISO language, preserved raw lines and double observation", async () => {
  const f = fixture(),
    r = await f.run()
  assert.equal(r.status, "read")
  assert.equal(r.evidence.apiReads, 2)
  assert.deepEqual(r.lines, [{ TDFORMAT: "  ", TDLINE: "  text <GL:link>  " }])
  assert.match(r.contentFingerprint!, /^[a-f0-9]{64}$/)
  assert.equal(r.coverage.languageFallback, false)
  assert.equal(r.coverage.linksResolved, false)
  assert.equal(r.saveAvailable, false)
})
test("five-digit head version must equal the exact four-digit indexed version", async () => {
  const f = fixture()
  for (const version of ["00003", "0002", "2", "0002x"]) {
    f.options.headVersion = version
    const r = await f.run()
    assert.equal(r.code, "CONFIGURATION_DOCUMENTATION_RESPONSE_SCOPE_MISMATCH")
    assert.equal(r.lines, null)
    assert.equal(r.contentFingerprint, null)
  }
})

test("unknown header, empty reference and absent indexed type do not call content API", async () => {
  for (const missing of ["header", "reference", "index"]) {
    const f = fixture()
    if (missing === "header") f.data.CUS_IMGACH = []
    else if (missing === "reference") f.data.CUS_IMGACH![0]!.DOCU_ID = ""
    else f.data.DOKIL = []
    assert.equal(
      (await f.run()).status,
      {
        header: "header_not_found",
        reference: "no_document_reference",
        index: "indexed_document_not_found"
      }[missing]
    )
    assert.equal(f.apiCalls(), 0)
  }
})
test("line limit is enforced before whole-document call and after unexpected growth", async () => {
  const f = fixture()
  f.data.DOKIL![0]!.TXTLINES = "00401"
  assert.equal((await f.run({ ...input, maxLines: 400 })).status, "limit_exceeded")
  assert.equal(f.apiCalls(), 0)
  f.data.DOKIL![0]!.TXTLINES = "00001"
  f.options.bodyCount = 3
  const r = await f.run({ ...input, maxLines: 2 })
  assert.equal(r.status, "limit_exceeded")
  assert.equal(r.lines, null)
  assert.equal(r.contentFingerprint, null)
})
test("API failure remains unavailable with its fault name, even if index also changes", async () => {
  const f = fixture()
  f.options.fault = "RET_CODE"
  f.options.drift = true
  const r = await f.run()
  assert.equal(r.status, "unavailable")
  assert.equal(r.code, "CONFIGURATION_DOCUMENTATION_API_FAILED")
  assert.equal(r.apiFaultName, "RET_CODE")
  assert.equal(r.lines, null)
})
test("changed body or index and wrong document identity discard content", async () => {
  for (const option of ["bodyDrift", "drift", "headMismatch"] as const) {
    const f = fixture()
    f.options[option] = true
    const r = await f.run()
    assert.equal(r.status, option === "headMismatch" ? "unavailable" : "changed")
    assert.equal(r.lines, null)
    assert.equal(r.contentFingerprint, null)
  }
})
test("query failure, metadata drift and ambiguity cannot become absence", async () => {
  const f = fixture()
  f.options.queryFailure = true
  await assert.rejects(f.run(), /READ_FAILED/)
  f.options.queryFailure = false
  f.options.metadataDrift = true
  await assert.rejects(f.run(), /METADATA_UNVERIFIED/)
  f.options.metadataDrift = false
  f.data.DOKIL!.push({ ...f.data.DOKIL![0]! })
  const r = await f.run()
  assert.equal(r.status, "unavailable")
  assert.equal(r.code, "CONFIGURATION_DOCUMENTATION_AMBIGUOUS_RESULT")
  assert.equal(f.apiCalls(), 0)
})
test("scope, unknown fields and invalid limits fail before metadata access", async () => {
  const f = fixture(),
    never = async () => assert.fail("metadata must not be read")
  await assert.rejects(f.run({ ...input, connectionId: "w300" }, "300", never), /SCOPE_UNSUPPORTED/)
  await assert.rejects(f.run(input, "100", never), /SCOPE_UNSUPPORTED/)
  for (const patch of [{ documentId: "OTHER" }, { maxLines: 401 }, { activityId: "BAD'" }])
    assert.equal(configurationDocumentationSchema.safeParse({ ...input, ...patch }).success, false)
})
test("SOAP preserves document LINE whitespace without changing other table defaults", () => {
  const xml =
    "<Envelope><Body><Result><LINE><item><TDFORMAT>  </TDFORMAT><TDLINE>  indented text  </TDLINE></item></LINE><OTHER><item><VALUE> padded </VALUE></item></OTHER></Result></Body></Envelope>"
  const r = parseRemoteFunctionResponse(
    xml,
    [
      { name: "LINE", kind: "table", fields: ["TDFORMAT", "TDLINE"] },
      { name: "OTHER", kind: "table", fields: ["VALUE"] }
    ],
    false,
    ["LINE"]
  )
  assert.deepEqual(r.outputs.LINE, [{ TDFORMAT: "  ", TDLINE: "  indented text  " }])
  assert.deepEqual(r.outputs.OTHER, [{ VALUE: "padded" }])
})
test("documentation tool is read-only in config, readonly and full profiles", () => {
  for (const profile of ["config", "readonly", "full"] as const)
    assert.ok(toolNamesForProfile(profile).includes("read_configuration_documentation"))
  assert.equal(toolContracts.read_configuration_documentation.annotations.readOnlyHint, true)
})
