import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SCI_V2_HELPER, SCI_V2_FINGERPRINT } from "../dist/src/sci-v2.js"
import { SCI_HELPER_FINGERPRINT } from "../dist/src/sci.js"
import { PRODUCT_VERSION } from "../dist/src/version.js"

if (!process.argv.includes("--approve-run")) {
  throw new Error("Requires SCI-E1 approval for the three existing customer test objects")
}
const targets = [
  { objectType: "PROG", objectName: "ZCODEX_MCP_DYNPRO" },
  { objectType: "CLAS", objectName: "ZCL_ORVANTA_MCP_CORE" },
  { objectType: "FUGR", objectName: "ZORVANTA_MCP_CORE" }
]
const suffix = new Date().toISOString().replace(/[:.]/g, "-")
const report = { startedAt: new Date().toISOString(), checks: [], status: "Failed" }
const client = new Client({ name: "sci-e1-acceptance", version: "1" })
async function call(name, args, expectedError) {
  const result = await client.callTool(
    { name, arguments: { connectionId: "w200", ...args } },
    undefined,
    { timeout: 120000 }
  )
  report.checks.push({ name, args, result })
  if (expectedError) {
    assert.equal(result.isError, true, `${name} unexpectedly succeeded`)
    assert.ok(
      JSON.stringify(result.content).includes(expectedError),
      JSON.stringify(result.content)
    )
    return
  }
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`)
  const text = result.content.find((part) => part.type === "text")?.text
  assert.equal(typeof text, "string")
  return text
}
async function invoke(action, target, expectedError) {
  const text = await call(
    "run_sci_analysis",
    { action, target, acknowledgePotentialSideEffects: true },
    expectedError
  )
  if (expectedError) return
  const result = JSON.parse(text)
  assert.equal(result.helper, SCI_V2_HELPER)
  assert.equal(result.helperFingerprint, SCI_V2_FINGERPRINT)
  assert.equal(result.nativeAtc, false)
  assert.equal(result.qualityGate, "not_evaluated")
  assert.deepEqual(result.requestedTarget, target)
  assert.equal(result.scope.objectType, target.objectType)
  assert.equal(result.scope.objectName, target.objectName)
  assert.equal(result.scope.packageName, "ZABAP")
  assert.equal(result.execution, action === "precheck" ? "not_run" : "returned")
  assert.deepEqual(
    result.selectedRules.map(({ name, version }) => ({ name, version })),
    [
      { name: "CL_CI_TEST_SYNTAX_CHECK", version: "001" },
      { name: "CL_CI_TEST_CRITICAL_STATEMENTS", version: "002" }
    ]
  )
  if (action === "precheck") {
    assert.equal(result.code, "PREFLIGHT_ONLY")
    assert.equal(result.totalFindings, undefined)
    assert.deepEqual(result.findings, [])
  } else {
    assert.ok(Number.isSafeInteger(result.totalFindings) && result.totalFindings >= 0)
    assert.equal(result.returnedFindings, Math.min(result.totalFindings, 1000))
    assert.equal(result.findings.length, result.returnedFindings)
    assert.equal(
      result.code,
      result.totalFindings === 0
        ? "NO_FINDINGS_UNVERIFIED"
        : result.totalFindings > 1000
          ? "TRUNCATED_LIMITED"
          : "FINDINGS_LIMITED"
    )
  }
  console.log(JSON.stringify({ action, target, code: result.code, count: result.totalFindings }))
}
try {
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:4847/mcp")))
  report.server = client.getServerVersion()
  assert.equal(report.server.name, "orvanta")
  assert.equal(report.server.version, PRODUCT_VERSION, "Service must match the built candidate")
  const tools = await client.listTools()
  report.contract = tools.tools.find(({ name }) => name === "run_sci_analysis")
  assert.ok(
    report.contract?.inputSchema.properties?.target,
    "Dedicated V2 target is not registered"
  )
  report.route = "Online dedicated run_sci_analysis with explicit target; no generic RFC fallback"
  for (const [functionName, fingerprint] of [
    [SCI_V2_HELPER, SCI_V2_FINGERPRINT],
    ["Z_ORVANTA_MCP_SCI_API", SCI_HELPER_FINGERPRINT]
  ]) {
    const definition = JSON.parse(await call("read_function_module_interface", { functionName }))
    assert.equal(definition.fingerprint, fingerprint)
  }
  report.dumpsBefore = await call("analyze_abap_dumps", { action: "list_dumps", maxResults: 10 })
  const sources = []
  for (const target of targets) {
    const source = await call("get_abap_object_lines", {
      ...target,
      startLine: 1,
      lineCount: 500
    })
    assert.ok(source.startsWith("Source from "), "Source lookup did not return source")
    assert.match(source, /Full Source SHA-256: [a-f0-9]{64}/)
    sources.push(source)
  }
  for (const target of targets) {
    await invoke("precheck", target)
    await invoke("run", target)
  }
  for (const [target, code] of [
    [{ objectType: "PROG", objectName: "SAPMSSY0" }, "invalid_string"],
    [{ objectType: "PROG", objectName: "Z*" }, "invalid_string"],
    [{ objectType: "FUNC", objectName: "Z_ORVANTA_MCP_SCI_API" }, "invalid_enum_value"],
    [{ objectType: "DEVC", objectName: "ZABAP" }, "invalid_enum_value"],
    [{ objectType: "PROG", objectName: "ZE1_NONEXISTENT_20260909" }, "OBJECT_NOT_FOUND"],
    [{ objectType: "PROG", objectName: "ZCODEX_MCP_I_0828" }, "NOT_MAIN_PROGRAM"]
  ])
    await invoke("run", target, code)
  await invoke("invalid", targets[0], "invalid_enum_value")
  await call(
    "run_sci_analysis",
    {
      action: "run",
      target: targets[0],
      acknowledgePotentialSideEffects: false
    },
    "invalid_literal"
  )
  for (let i = 0; i < targets.length; i++) {
    const after = await call("get_abap_object_lines", {
      ...targets[i],
      startLine: 1,
      lineCount: 500
    })
    assert.equal(after, sources[i], `Source changed for ${targets[i].objectName}`)
  }
  const legacy = JSON.parse(
    await call("read_function_module_interface", { functionName: "Z_ORVANTA_MCP_SCI_API" })
  )
  assert.equal(legacy.fingerprint, SCI_HELPER_FINGERPRINT)
  report.legacyPrecheck = JSON.parse(
    await call("run_sci_analysis", { action: "precheck", acknowledgePotentialSideEffects: true })
  )
  report.legacyRun = JSON.parse(
    await call("run_sci_analysis", { action: "run", acknowledgePotentialSideEffects: true })
  )
  assert.equal(report.legacyPrecheck.execution, "not_run")
  assert.equal(report.legacyPrecheck.helper, "Z_ORVANTA_MCP_SCI_API")
  assert.equal(report.legacyRun.helper, "Z_ORVANTA_MCP_SCI_API")
  assert.equal(report.legacyRun.execution, "returned")
  assert.equal(report.legacyRun.qualityGate, "not_evaluated")
  report.dumpsAfter = await call("analyze_abap_dumps", { action: "list_dumps", maxResults: 10 })
  assert.equal(report.dumpsAfter, report.dumpsBefore, "Dump inventory changed; review required")
  report.dedicatedRouteAcceptance = "Passed"
  report.status = "Partially Verified"
  report.limitations = [
    "Source snapshots cover the three returned source units, not every include in a function group.",
    "No faulty source fixture, low-privilege account, 1001-finding fixture or timeout was induced.",
    "Named SCI persistence and background job inventories require separate comparison."
  ]
} catch (error) {
  report.error = String(error)
  process.exitCode = 1
} finally {
  await client.close()
  report.finishedAt = new Date().toISOString()
  const path = new URL(`../../.doc/sci-e1-acceptance-${suffix}.json`, import.meta.url)
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" })
  console.log(
    JSON.stringify({ status: report.status, error: report.error, evidence: path.pathname })
  )
}
