import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  SCI_E2_HELPER,
  SCI_E2_FINGERPRINT,
  SCI_V2_FINGERPRINT,
  formatSciE2Result
} from "../dist/src/sci-v2.js"
import { SCI_HELPER_FINGERPRINT } from "../dist/src/sci.js"
import { PRODUCT_VERSION } from "../dist/src/version.js"

if (!process.argv.includes("--approve-run")) throw new Error("SCI-E2 approval is required")
const dedicated = process.argv.includes("--dedicated")
const targets = [
  { objectType: "FUGR", objectName: "ZORVANTA_MCP_CORE" },
  { objectType: "CLAS", objectName: "ZCL_ORVANTA_MCP_CORE" },
  { objectType: "PROG", objectName: "ZCODEX_MCP_DYNPRO" }
]
const startedAt = new Date().toISOString()
const suffix = startedAt.replace(/[:.]/g, "-")
const report = {
  startedAt,
  route: dedicated ? "dedicated E2 profile" : "guarded live RFC plus candidate formatter",
  checks: [],
  status: "Failed"
}
const client = new Client({ name: "sci-e2-acceptance", version: PRODUCT_VERSION })
async function call(name, args) {
  const r = await client.callTool(
    { name, arguments: { connectionId: "w200", ...args } },
    undefined,
    { timeout: 120000 }
  )
  report.checks.push({ name, args, result: r })
  if (r.isError) throw new Error(JSON.stringify(r.content))
  return r.content.find((part) => part.type === "text").text
}
async function invoke(target, action) {
  const input = {
    connectionId: "w200",
    target,
    action,
    profile: "syntax_critical_sql",
    acknowledgePotentialSideEffects: true
  }
  const result = dedicated
    ? JSON.parse(await call("run_sci_analysis", input))
    : JSON.parse(
        formatSciE2Result(
          JSON.parse(
            await call("test_remote_function_module", {
              operationId: `e2-${report.checks.length}-${suffix}`,
              functionName: SCI_E2_HELPER,
              inputParameters: {
                IV_ACTION: action.toUpperCase(),
                IV_OBJECT_TYPE: target.objectType,
                IV_OBJECT_NAME: target.objectName
              },
              expectedOutputs: { EV_ENGINE: "SCI", EV_VERSION: "3.0" },
              expectedInterfaceFingerprint: SCI_E2_FINGERPRINT,
              acknowledgePotentialSideEffects: true
            })
          ),
          input
        )
      )
  assert.equal(result.helper, SCI_E2_HELPER)
  assert.equal(result.helperFingerprint, SCI_E2_FINGERPRINT)
  assert.deepEqual(result.requestedTarget, target)
  assert.equal(result.scope.objectName, target.objectName)
  assert.equal(result.scope.objectType, target.objectType)
  assert.equal(result.scope.packageName, "ZABAP")
  assert.equal(result.profile, "SYNTAX_CRITICAL_SQL_V1")
  assert.equal(result.qualityGate, "not_evaluated")
  assert.equal(result.nativeAtc, false)
  assert.equal(result.execution, action === "precheck" ? "not_run" : "returned")
  assert.deepEqual(
    result.selectedRules.map((rule) => [rule.name, rule.version]),
    [
      ["CL_CI_TEST_SYNTAX_CHECK", "001"],
      ["CL_CI_TEST_CRITICAL_STATEMENTS", "002"],
      ["CL_CI_TEST_SELECT_NESTED", "000"]
    ]
  )
  const nested = result.findings.filter((finding) => finding.check === "CL_CI_TEST_SELECT_NESTED")
  report.checks.at(-1).formatted = result
  if (action === "run") {
    if (target.objectType === "FUGR")
      assert.ok(nested.length > 0, "Existing group did not produce a nested-query positive sample")
    else
      assert.equal(
        result.totalFindings,
        0,
        "Previously clean test source changed or cached results leaked"
      )
  }
  console.log(
    JSON.stringify({
      target,
      action,
      code: result.code,
      count: result.totalFindings,
      nested: nested.length
    })
  )
  return result
}
try {
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:4847/mcp")))
  report.server = client.getServerVersion()
  if (dedicated) {
    assert.equal(report.server.version, PRODUCT_VERSION)
    const tool = (await client.listTools()).tools.find((tool) => tool.name === "run_sci_analysis")
    assert.ok(tool?.inputSchema.properties?.profile, "E2 profile not registered")
  }
  for (const [functionName, fingerprint] of [
    [SCI_E2_HELPER, SCI_E2_FINGERPRINT],
    ["Z_ORVANTA_MCP_SCI_V2", SCI_V2_FINGERPRINT],
    ["Z_ORVANTA_MCP_SCI_API", SCI_HELPER_FINGERPRINT]
  ]) {
    const d = JSON.parse(await call("read_function_module_interface", { functionName }))
    assert.equal(d.fingerprint, fingerprint)
  }
  const before = []
  for (const target of targets) {
    const text = await call("get_abap_object_lines", { ...target, startLine: 1, lineCount: 500 })
    assert.ok(text.startsWith("Source from "))
    assert.match(text, /Full Source SHA-256: [a-f0-9]{64}/)
    before.push(text)
  }
  report.dumpsBefore = await call("analyze_abap_dumps", { action: "list_dumps", maxResults: 10 })
  for (const target of targets) {
    await invoke(target, "precheck")
    await invoke(target, "run")
  }
  report.repeatGroup = await invoke(targets[0], "run")
  for (let i = 0; i < targets.length; i++) {
    assert.equal(
      await call("get_abap_object_lines", { ...targets[i], startLine: 1, lineCount: 500 }),
      before[i]
    )
  }
  for (const target of [undefined, targets[0]]) {
    const result = JSON.parse(
      await call("run_sci_analysis", {
        action: "run",
        ...(target ? { target } : {}),
        acknowledgePotentialSideEffects: true
      })
    )
    assert.equal(result.helper, target ? "Z_ORVANTA_MCP_SCI_V2" : "Z_ORVANTA_MCP_SCI_API")
    assert.equal(result.selectedRules.length, 2)
    assert.equal(result.qualityGate, "not_evaluated")
  }
  report.dumpsAfter = await call("analyze_abap_dumps", { action: "list_dumps", maxResults: 10 })
  assert.equal(report.dumpsAfter, report.dumpsBefore)
  report.runtimeMatrix = "Passed"
  report.status = "Partially Verified"
  report.limitations = [
    ...(dedicated ? [] : ["Candidate profile routing is not yet deployed to the online service."]),
    "Sequential requests do not prove forced reuse of a single stateful RFC session.",
    "Source snapshots omit function-group child includes; no complete persistence/resource inventory.",
    "No synthetic scanning failure, 1001-result fixture or low-privilege account was used.",
    "No FAE rule or native ATC was run."
  ]
} catch (error) {
  report.error = String(error)
  process.exitCode = 1
} finally {
  await client.close()
  report.finishedAt = new Date().toISOString()
  const path = new URL(`../../.doc/sci-e2-acceptance-${suffix}.json`, import.meta.url)
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" })
  console.log(
    JSON.stringify({ status: report.status, error: report.error, evidence: path.pathname })
  )
}
