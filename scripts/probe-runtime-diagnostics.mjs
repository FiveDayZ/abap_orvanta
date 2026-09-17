import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { buildRuntimeDiagnosticReport } from "../dist/src/runtime-diagnostics.js"
import { PRODUCT_VERSION } from "../dist/src/version.js"

const client = new Client({ name: "runtime-diagnostics-readonly", version: PRODUCT_VERSION })
const connectionId = "w200"
const startedAt = new Date().toISOString()
const evidence = { startedAt, localVersion: PRODUCT_VERSION, readOnly: true, checks: [] }
async function call(name, args) {
  const result = await client.callTool({ name, arguments: { connectionId, ...args } })
  assert.ok(!result.isError, `${name} failed`)
  const text = result.content.find((part) => part.type === "text")?.text
  assert.equal(typeof text, "string")
  return text
}
try {
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:4847/mcp")))
  evidence.server = client.getServerVersion()
  const tools = await client.listTools()
  evidence.toolCount = tools.tools.length
  const list = await call("analyze_abap_dumps", { action: "list_dumps", maxResults: 5 })
  const ids = [...list.matchAll(/Dump ID: (.+)/g)].map((match) => match[1].trim())
  assert.ok(ids.length, "No existing dumps available: real parsing validation is incomplete")
  const dumps = []
  for (const id of ids) {
    const raw = await call("analyze_abap_dumps", {
      action: "analyze_dump",
      dumpId: id,
      includeFullContent: true
    })
    const html = raw.match(/```html\r?\n([\s\S]*?)\r?\n```/)?.[1]
    assert.ok(html, "Legacy response does not contain the expected HTML boundary")
    dumps.push({ id, errorType: "Unknown Error", text: html })
  }
  const report = buildRuntimeDiagnosticReport({ connectionId }, { available: true, dumps })
  assert.equal(report.parseFailures.length, 0)
  assert.equal(report.returnedCount, ids.length)
  assert.ok(report.dumps.every((dump) => dump.callStack.length > 0 && dump.source === undefined))
  assert.equal(report.qualityGate, "not_evaluated")
  evidence.route = "Existing MCP legacy read tool -> live SAP feed subset -> new local parser"
  evidence.report = {
    status: report.status,
    parsedCount: report.parsedCount,
    groupCount: report.groupCount,
    warnings: report.warnings,
    dumps: report.dumps.map(
      ({ fingerprint, errorType, program, systemTime, callStack, warnings }) => ({
        fingerprint,
        errorType,
        program,
        systemTime,
        stackDepth: callStack.length,
        warnings
      })
    )
  }
  evidence.checks.push(
    "Real legacy feed parsed locally; no raw HTML, users or source extracted to evidence"
  )
  if (tools.tools.some(({ name }) => name === "diagnose_sap_failure")) {
    const dedicated = JSON.parse(await call("diagnose_sap_failure", { maxResults: 5 }))
    assert.equal(dedicated.readOnly, true)
    assert.ok(dedicated.parsedCount > 0)
    assert.equal(dedicated.parseFailures.length, 0)
    evidence.checks.push("Dedicated deployed MCP tool returned structured live dumps")
    evidence.dedicatedToolVerified = true
  } else {
    evidence.dedicatedToolVerified = false
  }
  evidence.status = evidence.dedicatedToolVerified ? "Passed" : "Partially Verified"
} finally {
  await client.close()
}
const output = new URL(
  `../../.doc/runtime-diagnostics-${startedAt.replace(/[:.]/g, "-")}.json`,
  import.meta.url
)
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" })
console.log(JSON.stringify({ ...evidence, output: fileURLToPath(output) }, null, 2))
