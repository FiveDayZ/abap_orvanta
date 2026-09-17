import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { formatSciResult, SCI_HELPER, SCI_HELPER_FINGERPRINT } from "../dist/src/sci.js"

if (!process.argv.includes("--approve-run")) {
  throw new Error("Pass --approve-run only after approval to check ZORVANTA_MCP_CORE")
}
const startedAt = new Date().toISOString()
const suffix = startedAt.replace(/[:.]/g, "-")
const output = new URL(`../../.doc/sci-acceptance-${suffix}.json`, import.meta.url)
const client = new Client({ name: "sci-acceptance", version: "0.36.6" })
const report = { startedAt, checks: [], status: "Failed" }
async function call(name, args) {
  const result = await client.callTool({ name, arguments: { connectionId: "w200", ...args } })
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`)
  const text = result.content.find((part) => part.type === "text")?.text
  assert.equal(typeof text, "string")
  return text
}
async function invoke(action, expectedOutputs) {
  return JSON.parse(
    await call("test_remote_function_module", {
      functionName: SCI_HELPER,
      inputParameters: { IV_ACTION: action },
      expectedOutputs,
      expectedInterfaceFingerprint: SCI_HELPER_FINGERPRINT,
      acknowledgePotentialSideEffects: true,
      operationId: `sci-${action.toLowerCase()}-${suffix}`
    })
  )
}
try {
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:4847/mcp")))
  report.server = client.getServerVersion()
  const tools = await client.listTools()
  report.dedicatedToolAvailable = tools.tools.some(({ name }) => name === "run_sci_analysis")
  report.route = "live generic RFC tool plus local SCI formatter"
  const definition = JSON.parse(
    await call("read_function_module_interface", { functionName: SCI_HELPER })
  )
  assert.equal(definition.fingerprint, SCI_HELPER_FINGERPRINT)
  report.definition = {
    fingerprint: definition.fingerprint,
    sourceFingerprint: definition.sourceFingerprint,
    interfaceFingerprint: definition.interfaceFingerprint,
    remoteEnabled: definition.remoteEnabled
  }
  report.dumpsBefore = await call("analyze_abap_dumps", {
    action: "list_dumps",
    maxResults: 10
  })
  for (const action of ["PRECHECK", "RUN"]) {
    const raw = await invoke(action, {
      EV_ENGINE: "SCI",
      EV_STATUS: action === "RUN" ? "W" : "S",
      EV_CODE: action === "RUN" ? "FINDINGS_LIMITED" : "PREFLIGHT_ONLY",
      EV_SCOPE: "ZORVANTA_MCP_CORE"
    })
    const formatted = JSON.parse(
      formatSciResult(raw, {
        connectionId: "w200",
        action: action.toLowerCase(),
        acknowledgePotentialSideEffects: true
      })
    )
    assert.equal(formatted.qualityGate, "not_evaluated")
    report.checks.push({ action, raw, formatted })
  }
  const invalid = await invoke("INVALID", {
    EV_STATUS: "E",
    EV_CODE: "INVALID_ACTION",
    EV_COUNT: "0"
  })
  assert.deepEqual(invalid.tableOutputs.ET_RESULTS, [])
  report.checks.push({ action: "INVALID", raw: invalid })
  report.diagnostics = await call("get_abap_diagnostics", {
    fileUri:
      "adt://w200/sap/bc/adt/functions/groups/zorvanta_mcp_core/fmodules/z_orvanta_mcp_sci_api"
  })
  report.assignment = await call("inspect_repository_assignment", {
    objectName: SCI_HELPER,
    objectType: "FUGR/FF"
  })
  report.dumpsAfter = await call("analyze_abap_dumps", {
    action: "list_dumps",
    maxResults: 10
  })
  report.status = "Partially Verified"
  report.limitations = [
    "Live helper execution and local formatting verified; this probe does not execute the dedicated MCP tool.",
    "Only the pinned two-rule profile and fixed helper function group were checked.",
    "No negative authorization account or live 1001-finding fixture was used."
  ]
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  await client.close()
  report.finishedAt = new Date().toISOString()
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" })
  console.log(JSON.stringify({ status: report.status, evidence: fileURLToPath(output) }))
}
