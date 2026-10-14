import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { startHttpServer } from "../src/http.js"
import { MockBackend } from "./mock-backend.js"
import { readConfigurationFiDependencies } from "../src/configuration-fi-dependencies.js"
import {
  analyzeConfigurationFiFormulas,
  configurationFiAnalysisPins,
  parseFiFormulaSubset
} from "../src/configuration-fi-formula-analysis.js"
import type { readConfigurationFiFormulas } from "../src/configuration-fi-formula.js"

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
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
type Content = Awaited<ReturnType<typeof readConfigurationFiFormulas>>
function content(...statements: string[][]): Content {
  const items = statements.map((lines, index) => {
    const formulaId = `TEST${index}`
    return {
      formulaId,
      header: { CLASSID: "009" },
      lines: lines.map((BOOLEXP, seq) => ({
        MANDT: "200",
        BOOLID: formulaId,
        SEQNR: String(seq + 1).padStart(2, "0"),
        BOOLEXP: BOOLEXP.padEnd(60)
      }))
    }
  })
  const references = items.map(({ formulaId }, index) => ({
    step: String(index + 1),
    role: "condition" as const,
    formulaId
  }))
  return {
    status: "raw_content_read",
    references,
    items,
    readFingerprint: hash({ client: "200", booleanClass: "009", references, items }),
    readOnly: true,
    saveAvailable: false,
    blockers: [],
    coverage: {
      storedRowsComplete: true,
      complete: false,
      maximumFormulaIds: 20,
      maximumLinesPerFormula: 45,
      textRepresentation: "gb901_char60_rows",
      rowPaddingPreserved: true,
      statements: "not_reconstructed",
      operatorsAndOperands: "not_parsed",
      dependencies: "not_read",
      initializationAndSharedExits: "not_checked",
      generatedCode: "not_checked",
      businessTrigger: "not_performed",
      snapshot: false
    },
    evidence: {
      startedAt: "",
      finishedAt: "",
      sources: [],
      warnings: [],
      definitionsRechecked: true
    }
  }
}
function readers() {
  const calls: string[] = []
  const definition = async (name: string) => {
    calls.push(name)
    assert.notEqual(name, "BSEG", "Do not retry the observed incompatible descriptor")
    assert(observed.metadata[name])
    return structuredClone(observed.metadata[name])
  }
  return {
    calls,
    async source(uri: string) {
      calls.push(uri)
      const name = uri.split("/").at(-1)!
      assert(observed.sources[name])
      return structuredClone(observed.sources[name]!)
    },
    async function(name: string): Promise<unknown> {
      calls.push(name)
      assert(observed.functions[name])
      return structuredClone(observed.functions[name]!)
    },
    structure: definition,
    table: definition
  }
}

function nativeReaders() {
  const r = readers()
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/configuration-fi-dependencies-w200-r89.json", import.meta.url),
      "utf8"
    )
  ) as {
    metadata: Record<string, unknown>
    fields: Record<string, string>[]
    classification: Record<string, string>[]
  }
  return {
    ...r,
    dependencies: (fields: { table: string; name: string }[], booleanClass: string) =>
      readConfigurationFiDependencies(
        fields,
        booleanClass,
        {
          async runQuery(_id, sql) {
            const filters = [...sql.matchAll(/(\w+) = '([^']*)'/g)].map((m) => [m[1]!, m[2]!])
            const rows = sql.includes("FROM DD02L")
              ? fixture.classification
              : sql.includes("FROM DD03L")
                ? fixture.fields
                : []
            return structuredClone(rows.filter((row) => filters.every(([k, v]) => row[k!] === v)))
          },
          async callRemoteFunction() {
            throw Error("No native or fallback function may execute")
          }
        },
        {
          table: async (name) => structuredClone(fixture.metadata[`transparentTable:${name}`]),
          dataElement: async (name) => structuredClone(fixture.metadata[`dataElement:${name}`]),
          domain: async (name) => structuredClone(fixture.metadata[`domain:${name}`]),
          function: r.function
        }
      )
  }
}

test("FI native route distinguishes cached GDIF dispatch and GBDD switches from actual class eligibility", async () => {
  const result = await analyzeConfigurationFiFormulas(
    content(["<SYST> $TCODE = 'FB01'"]),
    "009",
    nativeReaders()
  )
  assert.equal(result.status, "subset_parsed")
  assert.equal(result.nativeRoute?.remoteEnabled, false)
  assert.equal(result.nativeRoute?.bridgeRequired, true)
  assert.equal(result.nativeRoute?.nativeEligibility, "not_checked")
  assert.equal(result.nativeRoute?.complete, false)
  assert.equal(result.nativeRoute?.bridgePreparation.status, "blocked_prerequisites")
  assert.equal(result.nativeRoute?.bridgePreparation.candidateFunctionName, null)
  assert.equal(result.nativeRoute?.bridgePreparation.deploymentReady, false)
  assert.equal(
    result.nativeRoute?.bridgePreparation.session.ddicResetClearsBooleanClassCache,
    false
  )
  assert.deepEqual(result.nativeRoute?.bridgePreparation.fields, [{ table: "SYST", name: "TCODE" }])
  assert.deepEqual(result.nativeRoute?.aliasNormalization, {
    input: "SY",
    ddicTable: "SYST",
    sourceAttested: true
  })
  assert.match(result.nativeRoute!.fieldSwitches, /BAdI.*unverified/)
  assert(result.blockers.includes("FI_RULE_FORMULA_ANALYSIS_NATIVE_FIELD_RFC_BRIDGE_REQUIRED"))
  assert(result.blockers.includes("FI_RULE_FORMULA_ANALYSIS_NATIVE_FIELD_SWITCHES_UNVERIFIED"))
  assert.equal(result.coverage.complete, false)
  assert.equal(result.saveAvailable, false)
})

test("FI native literal routes preserve values and distinguish ALPHA, MATN1, CP, empty and no-exit conversions", async () => {
  const raw = content(
    ["<BSEG> $HKONT = '12' AND", "<BSEG> $MATNR <> 'abCd'"],
    ["<BSEG> $HKONT LIKE '12*' AND", "<BSEG> $MATNR LIKE 'ab*'"],
    ["<BSEG> $MATNR = '' AND <BSEG> $MENGE = '1.000'"],
    ["<BSEG> $SGTXT = ' a|B\u00a0'"]
  )
  const result = await analyzeConfigurationFiFormulas(raw, "009", nativeReaders())
  assert.equal(result.status, "subset_parsed")
  const routes = result.items!.flatMap((item) => item.literalEvidence ?? [])
  assert.deepEqual(
    routes.map((row) => [
      row.name,
      row.operator,
      row.literal,
      row.specialFormulaCheck,
      row.generatedComparison
    ]),
    [
      [
        "HKONT",
        "=",
        "12",
        "conditional_route_skips_conversion",
        "CONVERT_DATA_TYPE_requires_G_CONVERT_INPUT"
      ],
      [
        "MATNR",
        "<>",
        "abCd",
        "conditional_route_requires_G_CONVERT_INPUT",
        "CONVERT_DATA_TYPE_requires_G_CONVERT_INPUT"
      ],
      ["HKONT", "LIKE", "12*", "conditional_route_skips_conversion", "CP_skips_CONVERT_DATA_TYPE"],
      [
        "MATNR",
        "LIKE",
        "ab*",
        "conditional_route_requires_G_CONVERT_INPUT",
        "CP_skips_CONVERT_DATA_TYPE"
      ],
      [
        "MATNR",
        "=",
        "",
        "conditional_route_skips_conversion",
        "empty_quoted_literal_skips_conversion"
      ],
      [
        "MENGE",
        "=",
        "1.000",
        "conditional_route_skips_conversion",
        "CONVERT_DATA_TYPE_no_exit_for_observed_CHAR_QUAN"
      ],
      [
        "SGTXT",
        "=",
        " a|B\u00a0",
        "conditional_route_skips_conversion",
        "CONVERT_DATA_TYPE_no_exit_for_observed_CHAR_QUAN"
      ]
    ]
  )
  assert(routes.every((row) => row.convertedValue === null && row.runtimeVerified === false))
  assert.equal(result.nativeRoute?.conversion.lowercaseDefault, "X")
  assert.equal(result.nativeRoute?.conversion.applied, false)
  assert(result.readFingerprint)
  assert.equal(result.contentFingerprint, raw.readFingerprint)
  assert.equal(result.coverage.literalConversions, "attributes_observed_not_applied")
})

test("FI native conversion buffer evidence never labels an oversized literal as validated or normalizes it", async () => {
  const result = await analyzeConfigurationFiFormulas(
    content([`<BSEG> $MATNR = '${"a".repeat(81)}'`]),
    "009",
    nativeReaders()
  )
  const row = result.items![0]!.literalEvidence![0]!
  assert.equal(row.literal, "a".repeat(81))
  assert.deepEqual(row.limits, {
    conversionBufferCharacters: 80,
    conversionInputWithinBuffer: false,
    conversionInputValidated: false
  })
  assert.equal(row.convertedValue, null)
  assert.equal(result.coverage.complete, false)
})

test("FI native first and confirmation interface, source and DFIES drift retract all native and literal projections", async () => {
  for (const mode of [
    "remote",
    "interface",
    "post-owner",
    "dfies",
    "post-dfies",
    "reset",
    "post-reset"
  ]) {
    const r = nativeReaders()
    const fn = r.function
    let owners = 0
    let resets = 0
    r.function = async (name) => {
      const result = (await fn(name)) as Record<string, unknown>
      if (name === "GBDD_FIELD_SET") {
        owners++
        if (mode === "remote") result.remoteEnabled = true
        if (mode === "interface") result.interfaceFingerprint = "0".repeat(64)
        if (mode === "post-owner" && owners === 2) result.sourceFingerprint = "0".repeat(64)
      }
      if (name === "GBDD_DDIC_INTERFACE_RESET") {
        resets++
        if (mode === "reset" || (mode === "post-reset" && resets === 2))
          result.sourceFingerprint = "0".repeat(64)
      }
      return result
    }
    const structure = r.structure
    let structures = 0
    r.structure = async (name) => {
      const value = (await structure(name)) as Record<string, unknown>
      if (name === "DFIES") {
        structures++
        if (mode === "dfies" || (mode === "post-dfies" && structures === 2))
          value.fingerprint = "0".repeat(64)
      }
      return value
    }
    const result = await analyzeConfigurationFiFormulas(
      content(["<BSEG> $MATNR = 'abc'"]),
      "009",
      r
    )
    assert.equal(result.status, "unavailable", mode)
    assert.equal(result.items, null, mode)
    assert.equal(result.nativeRoute, null, mode)
    assert.equal(result.fieldEvidence, null, mode)
    assert.equal(result.readFingerprint, null, mode)
    assert.equal(result.coverage.nativeFieldRoute, "not_checked", mode)
  }
})

test("FI analysis preserves quoted pipes, field-like text, case and spaces; LIKE records native CP only", () => {
  const result = parseFiFormulaSubset("<bkpf> $xblnr LIKE ' x | <BSEG> $HKONT and Or * '")
  assert.deepEqual(result.fields, [{ table: "BKPF", name: "XBLNR" }])
  assert.deepEqual(result.tree, {
    kind: "comparison",
    field: { table: "BKPF", name: "XBLNR" },
    operator: "LIKE",
    nativeOperator: "CP",
    literal: " x | <BSEG> $HKONT and Or * "
  })
  assert.equal(parseFiFormulaSubset("<BKPF> $XBLNR <> ''").tree.kind, "comparison")
})

test("FI analysis supports explicit mixed groups but refuses to invent mixed chain precedence", () => {
  const atom = "<BKPF> $BUKRS = 'DEMO'"
  assert.equal(parseFiFormulaSubset(`(${atom} OR ${atom}) AND ${atom}`).tree.kind, "boolean")
  assert.throws(() => parseFiFormulaSubset(`${atom} OR ${atom} AND ${atom}`), /MIXED_BOOLEAN_CHAIN/)
})

test("FI analysis rejects unsupported syntax, escape conventions, comments and dependency families", () => {
  for (const [statement, reason] of [
    ["<BKPF> $BUKRS IN SET", "SETS_UNSUPPORTED"],
    ["&RULE", "SUBRULES_UNSUPPORTED"],
    ["=U001", "EXITS_UNSUPPORTED"],
    ["\"comment\" <BKPF> $BUKRS = 'DEMO'", "COMMENTS_UNSUPPORTED"],
    [`<BKPF> $XBLNR = 'a"comment"b'`, "COMMENTS_UNSUPPORTED"],
    ["<BKPF> $XBLNR = 'MaThS(1)'", "MATHS_PREPROCESSING_UNSUPPORTED"],
    ["<BKPF> $XBLNR = 'MATHS'", "MATHS_PREPROCESSING_UNSUPPORTED"],
    ["<T001> $BUKRS = 'DEMO'", "FIELD_SCOPE_UNSUPPORTED"],
    ["<BKPF> $XBLNR = 'a''b'", "SYNTAX_SCOPE_UNSUPPORTED"],
    ["<BKPF> $BUKRS = 123", "SYNTAX_SCOPE_UNSUPPORTED"],
    ["<BKPF> $BUKRS = 'DEMO' junk", "SYNTAX_SCOPE_UNSUPPORTED"],
    ["NOT <BKPF> $BUKRS = 'DEMO'", "SYNTAX_SCOPE_UNSUPPORTED"],
    ["(<BKPF> $BUKRS = 'DEMO'", "SYNTAX_SCOPE_UNSUPPORTED"],
    ["", "TEXT_SCOPE_UNSUPPORTED"],
    ["<BKPF>\t$BUKRS = 'DEMO'", "TEXT_SCOPE_UNSUPPORTED"],
    ["<BKPF> $BUKRS = '\u0001'", "TEXT_SCOPE_UNSUPPORTED"]
  ])
    assert.throws(() => parseFiFormulaSubset(statement!), new RegExp(reason!))
})

test("FI analysis enforces statement, token and recursion bounds", () => {
  assert.throws(() => parseFiFormulaSubset("X".repeat(2701)), /TEXT_SCOPE_UNSUPPORTED/)
  assert.throws(
    () => parseFiFormulaSubset(Array(65).fill("<BKPF>$BUKRS=''").join("OR ")),
    /TOKEN_LIMIT/
  )
  assert.throws(
    () => parseFiFormulaSubset("(".repeat(25) + "<BKPF>$BUKRS=''" + ")".repeat(25)),
    /NESTING_LIMIT/
  )
})

test("FI analysis binds exact rows and twice-read actual source/field definitions without authorizing semantics", async () => {
  const r = readers()
  const raw = content(["<BKPF> $BUKRS = 'DEMO' AND", "<SYST> $TCODE = 'FB01'"])
  const result = await analyzeConfigurationFiFormulas(raw, "009", r)
  assert.equal(result.status, "subset_parsed")
  assert.deepEqual(
    result.dependencies?.map((d) => [d.table, d.name, d.status]),
    [
      ["BKPF", "BUKRS", "ddic_field_observed"],
      ["SYST", "TCODE", "ddic_field_observed"]
    ]
  )
  assert(result.readFingerprint)
  assert.equal(result.contentFingerprint, raw.readFingerprint)
  assert.equal(r.calls.length, 58)
  assert.equal(result.evidence.definitionsRechecked, true)
  assert.equal(result.coverage.complete, false)
  assert.equal(result.coverage.nativeEvaluation, "not_performed")
  assert.equal(result.saveAvailable, false)
  assert(result.blockers.includes("FI_RULE_FORMULA_ANALYSIS_CLASS_PERMISSION_UNVERIFIED"))
  assert(result.blockers.includes("FI_RULE_FORMULA_ANALYSIS_LITERAL_CONVERSIONS_UNVERIFIED"))
})

test("FI analysis keeps known BSEG descriptor refusal explicit, deduplicates fields and withholds aggregate fingerprint", async () => {
  const r = readers()
  const result = await analyzeConfigurationFiFormulas(
    content(["<BSEG> $HKONT LIKE '100*' OR <BSEG> $HKONT = 'DEMO'"]),
    "009",
    r
  )
  assert.equal(result.status, "subset_parsed")
  assert.equal(result.coverage.syntaxSubsetComplete, true)
  assert.equal(result.coverage.fieldDefinitionsComplete, false)
  assert.equal(result.readFingerprint, null)
  assert.deepEqual(result.dependencies, [
    { table: "BSEG", name: "HKONT", status: "metadata_unsupported", dataElement: null }
  ])
  assert(!r.calls.includes("BSEG"))
})

test("FI analysis rejects missing/forged content before reading any standard definition", async () => {
  for (const raw of [
    null,
    { ...content(["<BKPF> $BUKRS = 'DEMO'"]), readFingerprint: "changed" }
  ]) {
    const r = readers()
    const result = await analyzeConfigurationFiFormulas(raw, "009", r)
    assert.equal(result.status, "unavailable")
    assert.equal(result.items, null)
    assert.equal(r.calls.length, 0)
  }
})

test("FI analysis refuses cross-row literals and preserves literal non-ASCII trailing characters", async () => {
  const result = await analyzeConfigurationFiFormulas(
    content(["<BKPF> $XBLNR = 'abc", "def'"], ["<BKPF> $XBLNR = 'x\u00a0'"]),
    "009",
    readers()
  )
  assert.equal(result.status, "partial")
  assert.equal(result.items?.[0]?.code, "FI_RULE_FORMULA_ANALYSIS_CROSS_ROW_LITERAL_UNSUPPORTED")
  assert.equal(result.items?.[1]?.tree?.kind, "comparison")
  if (result.items?.[1]?.tree?.kind === "comparison")
    assert.equal(result.items[1].tree.literal, "x\u00a0")
  assert.equal(result.readFingerprint, null)
})

test("FI analysis reports unknown fields without turning DDIC existence into a permission claim", async () => {
  const result = await analyzeConfigurationFiFormulas(
    content(["<BKPF> $UNKNOWN = ''"]),
    "009",
    readers()
  )
  assert.equal(result.dependencies?.[0]?.status, "field_not_found")
  assert.equal(result.coverage.fieldDefinitionsComplete, false)
  assert.equal(result.coverage.classPermissions, "not_checked")
  assert.equal(result.readFingerprint, null)
})

test("FI analysis retracts AST and dependencies for first/confirmation source, interface, structure or metadata drift", async () => {
  for (const mode of [
    "source",
    "interface",
    "structure",
    "definition",
    "post-source",
    "post-definition",
    "inactive"
  ]) {
    const r = readers()
    const originalSource = r.source
    let sources = 0
    r.source = async (uri) => {
      const result = await originalSource(uri)
      if (
        mode === "source" ||
        (mode === "post-source" &&
          ++sources > Object.keys(configurationFiAnalysisPins.sources).length)
      )
        result.source += "changed"
      return result
    }
    const originalFunction = r.function
    r.function = async (name) => {
      const result = (await originalFunction(name)) as Record<string, unknown>
      if (mode === "interface") result.interfaceFingerprint = "changed"
      return result
    }
    const originalStructure = r.structure
    r.structure = async (name) => {
      const result = (await originalStructure(name)) as Record<string, unknown>
      if (mode === "structure") result.fingerprint = "changed"
      return result
    }
    const originalTable = r.table
    let tables = 0
    r.table = async (name) => {
      const result = (await originalTable(name)) as Record<string, unknown>
      if (mode === "definition" || (mode === "post-definition" && ++tables > 1))
        (result.definition as { fields: unknown[] }).fields = []
      if (mode === "inactive") result.active = false
      return result
    }
    const result = await analyzeConfigurationFiFormulas(content(["<BKPF> $BUKRS = ''"]), "009", r)
    assert.equal(result.status, "unavailable", mode)
    assert.equal(result.items, null, mode)
    assert.equal(result.dependencies, null, mode)
    assert.equal(result.nativeRoute, null, mode)
    assert.equal(result.readFingerprint, null, mode)
  }
})

test("FI analysis rejects a wrong URI even if the returned source bytes are pinned", async () => {
  const r = readers()
  const source = r.source
  r.source = async (uri) => ({ ...(await source(uri)), uriUsed: uri })
  const result = await analyzeConfigurationFiFormulas(content(["<BKPF> $BUKRS = ''"]), "009", r)
  assert.equal(result.status, "unavailable")
  assert(result.blockers.includes("FI_RULE_FORMULA_ANALYSIS_STANDARD_SOURCE_CHANGED"))
})

test("FI analysis stops all subsequent reads after authentication rejection", async () => {
  const r = readers()
  r.table = async (name) => {
    r.calls.push(name)
    throw Error("SAP SOAP request returned HTTP 401")
  }
  const result = await analyzeConfigurationFiFormulas(content(["<BKPF> $BUKRS = ''"]), "009", r)
  assert.equal(r.calls.length, 28)
  assert.equal(result.status, "unavailable")
  assert.equal(result.dependencies, null)
  assert.equal(result.nativeRoute, null)
  assert.equal(result.evidence.definitionsRechecked, false)
  assert(result.blockers.includes("FI_RULE_FORMULA_ANALYSIS_AUTHENTICATION_REJECTED"))
})

test("FI source fixture hashes remain the observed w200 bytes", () => {
  for (const [name, pin] of Object.entries(configurationFiAnalysisPins.sources))
    assert.equal(createHash("sha256").update(observed.sources[name]!.source).digest("hex"), pin)
})

test("public MCP schema exposes the opt-in and rejects analysis without raw content before any SAP read", async () => {
  const backend = new MockBackend()
  let queries = 0
  backend.runQuery = async () => {
    queries++
    return []
  }
  const state = mkdtempSync(join(tmpdir(), "orvanta-r88-schema-"))
  const running = await startHttpServer(backend, 0, state)
  const client = new Client({ name: "r88-schema", version: "1" })
  try {
    const transport = new StreamableHTTPClientTransport(new URL(running.mcpUrl))
    await client.connect(transport as Parameters<Client["connect"]>[0])
    const tools = await client.listTools()
    const tool = tools.tools.find((item) => item.name === "read_configuration_fi_rule")
    assert(tool)
    const option = tool.inputSchema.properties?.includeFormulaAnalysis as {
      type: string
      default: boolean
    }
    assert.deepEqual(option, { type: "boolean", default: false })
    assert.equal(tool.annotations?.readOnlyHint, true)
    const response = await client.callTool({
      name: "read_configuration_fi_rule",
      arguments: {
        connectionId: "w200",
        kind: "fi_validation",
        ruleName: "DEMO",
        companyCode: "DEMO",
        applicationArea: "FI",
        callupPoint: "0002",
        includeFormulaAnalysis: true
      }
    })
    assert.equal(response.isError, true)
    assert.match(JSON.stringify(response.content), /FI_RULE_FORMULA_ANALYSIS_REQUIRES_CONTENT/)
    assert.equal(queries, 0)
  } finally {
    await client.close()
    await running.close()
  }
  // Retain the isolated receipt directory as execution evidence.
})
