import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  configurationFiFormulaPins as pins,
  readConfigurationFiFormulas
} from "../src/configuration-fi-formula.js"
import {
  configurationFiActivationDomain,
  configurationFiRuleFields,
  configurationFiRuleLayouts,
  readConfigurationFiRule
} from "../src/configuration-fi-rule.js"
import { reviewedTableReaderDefinition } from "../src/reviewed-table-reader.js"
import type { RemoteFunctionResult } from "../src/backend.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"

const condition = "1Z0001##001"
const check = "2Z0001##001"
const steps = [{ VALSEQNR: "001", CONDID: condition, CHECKID: check }]
const metadata = [
  { FIELDNAME: "BOOLID", OFFSET: "000000", LENGTH: "000011", TYPE: "C" },
  { FIELDNAME: "SEQNR", OFFSET: "000011", LENGTH: "000002", TYPE: "C" },
  { FIELDNAME: "BOOLEXP", OFFSET: "000013", LENGTH: "000060", TYPE: "C" },
  { FIELDNAME: "MANDT", OFFSET: "000073", LENGTH: "000003", TYPE: "C" }
]
const wire = (id: string, sequence: string, text: string) => ({
  WA: id.padEnd(11) + sequence + text.padEnd(60) + "200"
})
const header = (BOOLID: string) => ({
  MANDT: "200",
  BOOLID,
  BOOLTYPE: "A",
  CLASSID: "009",
  AUTHGR: "",
  INITEXIT: "",
  MULTILINE: ""
})
const layout = (objectName: string, objectKind: string): Record<string, unknown> => ({
  connectionId: "w200",
  objectName,
  objectKind,
  fingerprint: pins[objectName as keyof typeof pins]
})
function fixture(mutate?: (reply: RemoteFunctionResult, count: number, id: string) => void) {
  let calls = 0
  const readers: Record<
    "table" | "domain" | "structure" | "function" | "dataElement",
    (name: string) => Promise<Record<string, unknown>>
  > = {
    table: async (name: string) => layout(name, "transparentTable"),
    domain: async (name: string) => layout(name, "domain"),
    structure: async (name: string) => layout(name, "structure"),
    dataElement: async (name: string) => layout(name, "dataElement"),
    function: async (name: string) =>
      name === "RFC_READ_TABLE"
        ? {
            functionName: name,
            remoteEnabled: true,
            updateTask: false,
            sourceFingerprint: reviewedTableReaderDefinition.shape.sourceFingerprint.value,
            interfaceFingerprint: reviewedTableReaderDefinition.shape.interfaceFingerprint.value
          }
        : {
            connectionId: "w200",
            functionName: "G_BOOL_GET_BOOLID_IN_TABLE",
            remoteEnabled: false,
            updateTask: false,
            sourceFingerprint: pins.G_BOOL_GET_BOOLID_IN_TABLE.source,
            interfaceFingerprint: pins.G_BOOL_GET_BOOLID_IN_TABLE.interface
          }
  }
  const backend: {
    runQuery(id: string, sql: string): Promise<Record<string, string>[]>
    callRemoteFunction(
      id: string,
      request: Parameters<MockBackend["callRemoteFunction"]>[1]
    ): Promise<RemoteFunctionResult>
  } = {
    runQuery: async (_id: string, sql: string) => {
      const id = /BOOLID = '([^']+)'/.exec(sql)?.[1]
      assert(id)
      assert(
        sql.startsWith(
          "SELECT MANDT, BOOLID, BOOLTYPE, CLASSID, AUTHGR, INITEXIT, MULTILINE FROM GB90"
        )
      )
      return [header(id)]
    },
    callRemoteFunction: async (
      _id: string,
      request: Parameters<MockBackend["callRemoteFunction"]>[1]
    ) => {
      calls++
      assert.equal(request.functionName, "RFC_READ_TABLE")
      assert.equal(request.inputParameters.QUERY_TABLE, "GB901")
      assert.equal(request.inputParameters.DELIMITER, "")
      assert.equal(request.inputParameters.ROWCOUNT, "46")
      assert.equal(request.inputParameters.ROWSKIPS, "0")
      assert.equal(request.inputParameters.NO_DATA, "")
      assert.deepEqual(
        request.inputParameters.FIELDS,
        ["BOOLID", "SEQNR", "BOOLEXP", "MANDT"].map((FIELDNAME) => ({ FIELDNAME }))
      )
      assert.deepEqual(request.outputParameters[0], {
        name: "FIELDS",
        kind: "table",
        fields: ["FIELDNAME", "OFFSET", "LENGTH", "TYPE"]
      })
      const options = request.inputParameters.OPTIONS as { TEXT: string }[]
      assert.equal(options[0]?.TEXT, "MANDT = '200'")
      const id = /^AND BOOLID = '([^']+)'$/.exec(options[1]?.TEXT ?? "")?.[1]
      assert(id)
      const reply: RemoteFunctionResult = {
        outputs: {
          FIELDS: structuredClone(metadata),
          DATA: [wire(id, "02", " ' x | y ' "), wire(id, "01", "BKPF-BUKRS =")]
        }
      }
      mutate?.(reply, calls, id)
      return reply
    }
  }
  const run = () => readConfigurationFiFormulas("w200", "200", "009", steps, backend, readers)
  return { backend, readers, run, calls: () => calls }
}

test("FI formula reader keeps exact IDs, primary-key ordering, pipes and CHAR60 spaces without claiming semantics", async () => {
  const f = fixture()
  const result = await f.run()
  assert.equal(result.status, "raw_content_read")
  assert.equal(f.calls(), 4)
  assert(result.readFingerprint)
  assert.equal(result.items?.[0]?.formulaId, condition)
  assert.deepEqual(
    result.items?.[0]?.lines.map((row) => row.SEQNR),
    ["01", "02"]
  )
  assert.equal(result.items?.[0]?.lines[1]?.BOOLEXP, " ' x | y ' ".padEnd(60))
  assert.equal(result.coverage.storedRowsComplete, true)
  assert.equal(result.coverage.complete, false)
  assert.equal(result.coverage.operatorsAndOperands, "not_parsed")
  assert.equal(result.coverage.dependencies, "not_read")
  assert.equal(result.saveAvailable, false)
})

test("FI formula client trailer preserves blank, quoted and full-width bodies when SOAP drops trailing TAB512 padding", async () => {
  for (const text of ["", " ' x | y ' ", "X".repeat(60)]) {
    // The previous layout loses formula spaces under this transport behavior.
    const oldWire = ("200" + condition.padEnd(11) + "01" + text.padEnd(60)).padEnd(512)
    if (text.length < 60) assert(oldWire.trimEnd().length < 76)
    const f = fixture((reply, _count, id) => {
      reply.outputs.DATA = [{ WA: wire(id, "01", text).WA.padEnd(512).trimEnd() }]
    })
    const result = await f.run()
    assert.equal(result.status, "raw_content_read")
    assert.equal(result.items?.[0]?.lines[0]?.BOOLEXP, text.padEnd(60))
    assert.equal(result.items?.[0]?.lines[0]?.MANDT, "200")
    assert.equal(result.coverage.rowPaddingPreserved, true)
  }
})

test("FI formula reader distinguishes reversed delivery order from changed exact text", async () => {
  const unchanged = fixture((reply, count) => {
    if (count > 2 && Array.isArray(reply.outputs.DATA)) reply.outputs.DATA.reverse()
  })
  assert.equal((await unchanged.run()).status, "raw_content_read")
  const changed = fixture((reply, count, id) => {
    if (count > 2)
      reply.outputs.DATA = [wire(id, "01", "BKPF-BUKRS ="), wire(id, "02", "'different'")]
  })
  const result = await changed.run()
  assert.equal(result.status, "changed")
  assert.equal(result.items, null)
  assert.equal(result.readFingerprint, null)
})

test("FI formula reader refuses missing headers, missing body and class mismatch as incomplete definitions", async () => {
  for (const mode of ["no-header", "no-body", "other-class"]) {
    const f = fixture((reply) => {
      if (mode === "no-body") reply.outputs.DATA = []
    })
    if (mode === "no-header") f.backend.runQuery = async () => []
    if (mode === "other-class")
      f.backend.runQuery = async (_id, sql) => [
        {
          ...header(/BOOLID = '([^']+)'/.exec(sql)![1]!),
          CLASSID: "001"
        }
      ]
    const result = await f.run()
    assert.equal(result.status, "partial")
    assert.equal(result.items, null)
    assert.equal(result.coverage.storedRowsComplete, false)
    assert.equal(result.readFingerprint, null)
  }
})

test("FI formula reader retracts output on duplicate sequence, another client/key, controls or shortened text", async () => {
  for (const WA of [
    wire(condition, "01", "BKPF-BUKRS =").WA,
    wire(condition, "02", "bad").WA.replace(/200$/, "300"),
    wire("OTHER", "02", "bad").WA,
    wire(condition, "02", "\n").WA,
    wire(condition, "02", "x").WA.slice(0, 75)
  ]) {
    const f = fixture((reply) => {
      reply.outputs.DATA = [wire(condition, "01", "BKPF-BUKRS ="), { WA }]
    })
    const result = await f.run()
    assert.equal(result.status, "unavailable")
    assert.equal(result.items, null)
    assert.equal(result.readFingerprint, null)
  }
})

test("FI formula reader rejects altered field order/offset/length/type and explicit row overflow", async () => {
  for (const field of [
    { ...metadata[3]!, OFFSET: "15" },
    { ...metadata[3]!, LENGTH: "59" },
    { ...metadata[3]!, TYPE: "N" },
    { ...metadata[3]!, FIELDNAME: "PASSWORD" }
  ]) {
    const f = fixture((reply) => {
      reply.outputs.FIELDS = [...metadata.slice(0, 3), field]
    })
    assert.equal((await f.run()).items, null)
  }
  const overflow = fixture((reply, _count, id) => {
    reply.outputs.DATA = Array.from({ length: 46 }, (_, index) =>
      wire(id, String(index).padStart(2, "0"), "X")
    )
  })
  const result = await overflow.run()
  assert.equal(result.items, null)
  assert(result.blockers.includes("FI_RULE_FORMULA_READ_TRUNCATED"))
})

test("FI formula reader refuses layout, reader and storage-source drift including post-read drift", async () => {
  for (const mode of ["layout", "reader", "storage", "post-read"]) {
    const f = fixture()
    let definitions = 0
    const original = f.readers.function
    f.readers.function = async (name) => {
      const value = await original(name)
      if (
        (mode === "reader" && name === "RFC_READ_TABLE") ||
        (mode === "storage" && name === "G_BOOL_GET_BOOLID_IN_TABLE") ||
        (mode === "post-read" && name === "G_BOOL_GET_BOOLID_IN_TABLE" && ++definitions === 2)
      )
        return { ...value, sourceFingerprint: "changed" }
      return value
    }
    if (mode === "layout")
      f.readers.domain = async (name) => ({ ...layout(name, "domain"), fingerprint: "changed" })
    const result = await f.run()
    assert.equal(result.items, null)
    assert.equal(result.readFingerprint, null)
    if (mode !== "post-read") assert.equal(f.calls(), 0)
    else assert.equal(f.calls(), 4)
  }
})

test("FI formula reader keeps authentication failures distinct from missing body and performs no retry", async () => {
  const f = fixture()
  f.backend.callRemoteFunction = async () => {
    throw Error("HTTP 401")
  }
  const result = await f.run()
  assert.equal(result.status, "unavailable")
  assert.equal(result.items, null)
  assert.deepEqual(result.blockers, ["FI_RULE_FORMULA_AUTHENTICATION_REJECTED"])
  assert.equal(result.evidence.sources.filter((source) => source.table === "GB901").length, 1)
})

test("FI formula reader admits only bounded observed references in w200/200", async () => {
  const f = fixture()
  for (const [connectionId, client] of [
    ["w300", "200"],
    ["w200", "300"]
  ])
    await assert.rejects(
      readConfigurationFiFormulas(connectionId!, client!, "009", steps, f.backend, f.readers),
      /SCOPE_UNSUPPORTED/
    )
  for (const selected of [
    [],
    [{ ...steps[0]!, CHECKID: "" }],
    Array.from({ length: 11 }, (_, i) => ({
      VALSEQNR: String(i),
      CONDID: `C${i}`,
      CHECKID: `K${i}`
    }))
  ]) {
    const result = await readConfigurationFiFormulas(
      "w200",
      "200",
      "009",
      selected,
      f.backend,
      f.readers
    )
    assert.equal(result.items, null)
  }
  assert.equal(f.calls(), 0)
})

const input = {
  connectionId: "w200",
  kind: "fi_validation",
  ruleName: "Z0001",
  companyCode: "6010",
  applicationArea: "FI",
  callupPoint: "0002"
}
function parentFixture() {
  const f = fixture()
  const query = f.backend.runQuery
  let parentReads = 0
  f.backend.runQuery = async (id, sql) => {
    if (sql.includes("FROM GB90 ")) return query(id, sql)
    const table = / FROM (\w+)/.exec(sql)![1]! as keyof typeof configurationFiRuleFields
    parentReads++
    return [
      {
        ...Object.fromEntries(configurationFiRuleFields[table].map((field) => [field, ""])),
        MANDT: "200",
        VALID: "Z0001",
        BOOLCLASS: "009",
        VALSEQNR: "001",
        CONDID: condition,
        CHECKID: check,
        BUKRS: "6010",
        EVENT: "0002",
        ACTIV: "1",
        VALUSER: "FI",
        VALEVENT: "0002",
        RCLASS: "009"
      }
    ]
  }
  const table = f.readers.table
  const domain = f.readers.domain
  f.readers.table = async (name) =>
    name in configurationFiRuleLayouts
      ? {
          ...layout(name, "transparentTable"),
          fingerprint: configurationFiRuleLayouts[name as keyof typeof configurationFiRuleLayouts]
        }
      : table(name)
  f.readers.domain = async (name) =>
    name === "GVSACTIV"
      ? { ...layout(name, "domain"), fingerprint: configurationFiActivationDomain }
      : domain(name)
  const run = (
    includeFormulaContent = false,
    includeFormulaAnalysis = false,
    source?: (uri: string) => Promise<{ source: string; uriUsed: string }>
  ) =>
    readConfigurationFiRule(
      { ...input, includeFormulaContent, includeFormulaAnalysis },
      "200",
      f.backend,
      f.readers.table,
      f.readers.domain,
      f.readers.function,
      f.readers.structure,
      source,
      f.readers.dataElement
    )
  return { ...f, run, parentReads: () => parentReads }
}

test("FI exact-rule default performs no formula reads; opt-in joins raw content but retains semantic/write blockers", async () => {
  const f = parentFixture()
  const referenceOnly = await f.run()
  assert.equal(f.calls(), 0)
  assert.equal(f.parentReads(), 8)
  assert.equal("formulaContent" in referenceOnly, false)
  const expanded = await f.run(true)
  assert.equal(expanded.formulaContent?.status, "raw_content_read")
  assert.equal(expanded.coverage.formulas, "raw_stored_rows_semantics_unverified")
  assert.equal(expanded.executionPreflight.writeAvailable, false)
  assert(expanded.executionPreflight.blockers.includes("FI_RULE_FORMULA_SEMANTICS_UNVERIFIED"))
  assert(expanded.executionPreflight.blockers.includes("FI_RULE_FORMULA_DEPENDENCIES_UNVERIFIED"))
  assert(expanded.executionPreflight.blockers.includes("FI_RULE_SHARED_EXITS_UNVERIFIED"))
  await assert.rejects(
    readConfigurationFiRule(
      { ...input, kind: "fi_substitution", includeFormulaContent: true },
      "200",
      f.backend,
      f.readers.table,
      f.readers.domain,
      f.readers.function
    ),
    /FORMULA_SCOPE_UNSUPPORTED/
  )
})

test("FI exact-rule rechecks the parent after formula reads and withdraws changed steps and formula content", async () => {
  const f = parentFixture()
  const query = f.backend.runQuery
  f.backend.runQuery = async (id, sql) => {
    const rows = await query(id, sql)
    if (f.calls() > 0 && sql.includes("FROM GB931 ")) rows[0]!.CHECKID = "CHANGED"
    return rows
  }
  const result = await f.run(true)
  assert.equal(result.status, "changed")
  assert.equal(result.steps.data, null)
  assert.equal(result.formulaContent?.items, null)
  assert.deepEqual(result.formulaContent?.references, [])
  assert.equal(result.formulaContent?.readFingerprint, null)
  assert.equal(result.coverage.formulas, "references_only")
})

test("FI exact-rule stops parent rechecks after formula authentication rejection and retracts all values", async () => {
  const f = parentFixture()
  f.backend.callRemoteFunction = async () => {
    throw Error("HTTP 401")
  }
  const result = await f.run(true)
  assert.equal(f.parentReads(), 8)
  assert.equal(result.status, "unavailable")
  assert.equal(result.steps.data, null)
  assert.equal(result.readFingerprint, null)
  assert.deepEqual(result.formulaContent?.references, [])
  assert(result.executionPreflight.blockers.includes("FI_RULE_FORMULA_AUTHENTICATION_REJECTED"))
})

test("ToolService wires formula structure reads only for the explicit opt-in", async () => {
  const f = parentFixture()
  const backend = new MockBackend()
  backend.runQuery = f.backend.runQuery
  backend.callRemoteFunction = f.backend.callRemoteFunction
  const service = new ToolService(backend)
  service.readDdicTransparentTable = async ({ objectName }) =>
    JSON.stringify(await f.readers.table(objectName))
  service.readDdicDomain = async ({ objectName }) =>
    JSON.stringify(await f.readers.domain(objectName))
  service.readDdicStructure = async ({ objectName }) =>
    JSON.stringify(await f.readers.structure(objectName))
  service.readFunctionModuleInterface = async ({ functionName }) =>
    JSON.stringify(await f.readers.function(functionName))
  const result = JSON.parse(
    await service.readConfigurationFiRule({ ...input, includeFormulaContent: true })
  )
  assert.equal(result.formulaContent.status, "raw_content_read")
  assert.equal(result.saveAvailable, false)
})

function analysisFixture() {
  const observed = JSON.parse(
    readFileSync(
      new URL("./fixtures/configuration-fi-formula-analysis-w200-r91.json", import.meta.url),
      "utf8"
    )
  ) as {
    sources: Record<string, { source: string; uriUsed: string }>
    functions: Record<string, Record<string, unknown>>
    metadata: Record<string, Record<string, unknown>>
  }
  const dependencies = JSON.parse(
    readFileSync(
      new URL("./fixtures/configuration-fi-dependencies-w200-r89.json", import.meta.url),
      "utf8"
    )
  ) as {
    metadata: Record<string, Record<string, unknown>>
    fields: Record<string, string>[]
    classification: Record<string, string>[]
  }
  const f = parentFixture()
  const table = f.readers.table,
    structure = f.readers.structure,
    func = f.readers.function
  f.readers.table = async (name) =>
    dependencies.metadata[`transparentTable:${name}`] ?? observed.metadata[name] ?? table(name)
  const domain = f.readers.domain
  f.readers.domain = async (name) => dependencies.metadata[`domain:${name}`] ?? domain(name)
  f.readers.dataElement = async (name) => dependencies.metadata[`dataElement:${name}`]!
  f.readers.structure = async (name) => observed.metadata[name] ?? structure(name)
  f.readers.function = async (name) => observed.functions[name] ?? func(name)
  const query = f.backend.runQuery
  f.backend.runQuery = async (id, sql) => {
    if (sql.includes("FROM DD02L")) return structuredClone(dependencies.classification)
    if (sql.includes("FROM DD03L")) {
      const filters = [...sql.matchAll(/(\w+) = '([^']*)'/g)].map((m) => [m[1]!, m[2]!])
      return structuredClone(
        dependencies.fields.filter((r) => filters.every(([k, v]) => r[k!] === v))
      )
    }
    if (sql.includes("FROM GB01C")) return []
    if (sql.includes("FROM GB01 ")) {
      const filters = [...sql.matchAll(/(\w+) = '([^']*)'/g)].map((m) => [m[1]!, m[2]!])
      const row: Record<string, string> = {
        BOOLCLASS: "009",
        CLASSTYPE: "A",
        BCLTAB: "BKPF",
        BCLFIELD: "*",
        BEXCLUDE: ""
      }
      return filters.every(([k, v]) => row[k!] === v) ? [row] : []
    }
    return query(id, sql)
  }
  const remote = f.backend.callRemoteFunction
  f.backend.callRemoteFunction = async (id, request) => {
    const result = await remote(id, request)
    const options = request.inputParameters.OPTIONS as { TEXT: string }[]
    const formulaId = /^AND BOOLID = '([^']+)'$/.exec(options[1]!.TEXT)![1]!
    result.outputs.DATA = [wire(formulaId, "01", "<BKPF> $BUKRS = 'DEMO'")]
    return result
  }
  let sourceReads = 0
  const source = async (uri: string) => {
    sourceReads++
    return structuredClone(observed.sources[uri.split("/").at(-1)!]!)
  }
  return { ...f, source, sourceReads: () => sourceReads }
}

test("FI rule analysis opt-in preserves default cost and parent fingerprint while adding separately bound dependencies", async () => {
  const f = analysisFixture()
  const defaultResult = await f.run()
  assert.equal(f.sourceReads(), 0)
  assert.equal("formulaAnalysis" in defaultResult, false)
  const analyzed = await f.run(true, true, f.source)
  assert.equal(analyzed.formulaAnalysis?.status, "subset_parsed")
  assert.equal(
    analyzed.formulaAnalysis?.contentFingerprint,
    analyzed.formulaContent?.readFingerprint
  )
  assert(analyzed.formulaAnalysis?.readFingerprint)
  assert.equal(analyzed.readFingerprint, defaultResult.readFingerprint)
  assert.equal(analyzed.coverage.formulas, "parsed_subset_semantics_unverified")
  assert.equal(f.sourceReads(), 26)
  assert.equal(analyzed.formulaAnalysis?.nativeRoute?.nativeEligibility, "not_checked")
  assert.equal(analyzed.formulaAnalysis?.nativeRoute?.bridgeRequired, true)
  assert.equal(analyzed.formulaAnalysis?.nativeRoute?.bridgePreparation.deploymentReady, false)
  assert.equal(
    analyzed.formulaAnalysis?.nativeRoute?.bridgePreparation.nativeExecutionAvailable,
    false
  )
  assert.equal(
    analyzed.formulaAnalysis?.coverage.nativeFieldRoute,
    "source_attested_execution_unverified"
  )
  assert.equal(analyzed.formulaAnalysis?.fieldEvidence?.coverage.classPolicyRowsComplete, true)
  assert.equal(analyzed.executionPreflight.writeAvailable, false)
  const count = f.parentReads()
  await assert.rejects(f.run(false, true, f.source), /ANALYSIS_REQUIRES_CONTENT/)
  assert.equal(f.parentReads(), count)
})

test("FI rule parent drift retracts both raw rows and new syntax/dependency projections", async () => {
  const f = analysisFixture()
  const query = f.backend.runQuery
  f.backend.runQuery = async (id, sql) => {
    const result = await query(id, sql)
    if (f.sourceReads() && sql.includes("FROM GB931 ")) result[0]!.CHECKID = "CHANGED"
    return result
  }
  const result = await f.run(true, true, f.source)
  assert.equal(result.status, "changed")
  assert.equal(result.formulaAnalysis?.items, null)
  assert.equal(result.formulaAnalysis?.dependencies, null)
  assert.equal(result.formulaAnalysis?.fieldEvidence, null)
  assert.equal(result.formulaAnalysis?.nativeRoute, null)
  assert.equal(result.formulaAnalysis?.coverage.nativeFieldRoute, "not_checked")
  assert.equal(result.formulaAnalysis?.coverage.classPermissions, "not_checked")
  assert.equal(result.formulaAnalysis?.contentFingerprint, null)
  assert.equal(result.formulaAnalysis?.readFingerprint, null)
  assert.equal(result.coverage.formulas, "references_only")
})

test("FI analysis authentication rejection prevents parent confirmation reads and retracts all projections", async () => {
  const f = analysisFixture()
  const result = await f.run(true, true, async () => {
    throw Error("HTTP 401")
  })
  assert.equal(f.parentReads(), 8)
  assert.equal(result.status, "unavailable")
  assert.equal(result.steps.data, null)
  assert.equal(result.formulaContent?.items, null)
  assert.equal(result.formulaAnalysis?.items, null)
  assert.equal(result.readFingerprint, null)
  assert(
    result.executionPreflight.blockers.includes("FI_RULE_FORMULA_ANALYSIS_AUTHENTICATION_REJECTED")
  )
})

test("FI dependency authentication rejection retracts AST, metadata and policy without further parent reads", async () => {
  const f = analysisFixture()
  const query = f.backend.runQuery
  let rejected = false
  f.backend.runQuery = async (id, sql) => {
    assert.equal(rejected, false, "No query after dependency authentication rejection")
    if (sql.includes("FROM GB01 ")) {
      rejected = true
      throw Error("SAP SOAP request returned HTTP 401")
    }
    return query(id, sql)
  }
  const result = await f.run(true, true, f.source)
  assert.equal(f.parentReads(), 8)
  assert.equal(result.formulaAnalysis?.items, null)
  assert.equal(result.formulaAnalysis?.dependencies, null)
  assert.equal(result.formulaAnalysis?.fieldEvidence, null)
  assert.equal(result.formulaAnalysis?.nativeRoute, null)
  assert.equal(result.formulaAnalysis?.coverage.fieldDefinitionsComplete, false)
  assert(
    result.formulaAnalysis?.blockers.includes("FI_RULE_FORMULA_ANALYSIS_AUTHENTICATION_REJECTED")
  )
})

test("ToolService connects analysis to the source backend without executing stateful standard parser functions", async () => {
  const f = analysisFixture()
  const backend = new MockBackend()
  backend.runQuery = f.backend.runQuery
  backend.callRemoteFunction = f.backend.callRemoteFunction
  backend.readSourceByUri = async (connectionId, uri) => {
    assert.equal(connectionId, "w200")
    return f.source(uri)
  }
  const service = new ToolService(backend)
  service.readDdicTransparentTable = async ({ objectName }) =>
    JSON.stringify(await f.readers.table(objectName))
  service.readDdicDomain = async ({ objectName }) =>
    JSON.stringify(await f.readers.domain(objectName))
  service.readDdicDataElement = async ({ objectName }) =>
    JSON.stringify(await f.readers.dataElement(objectName))
  service.readDdicStructure = async ({ objectName }) =>
    JSON.stringify(await f.readers.structure(objectName))
  service.readFunctionModuleInterface = async ({ functionName }) =>
    JSON.stringify(await f.readers.function(functionName))
  const result = JSON.parse(
    await service.readConfigurationFiRule({
      ...input,
      includeFormulaContent: true,
      includeFormulaAnalysis: true
    })
  )
  assert.equal(result.formulaAnalysis.status, "subset_parsed")
  assert.equal(f.sourceReads(), 26)
  assert.equal(result.formulaAnalysis.nativeRoute.nativeEligibility, "not_checked")
  assert.equal(result.formulaAnalysis.nativeRoute.bridgeRequired, true)
  assert.equal(result.formulaAnalysis.saveAvailable, false)
  assert.equal(result.executionPreflight.writeAvailable, false)
  assert.equal(backend.lastHelperRequest, undefined)
})
