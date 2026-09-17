import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { PRODUCT_VERSION } from "../dist/src/version.js"

const endpoint = new URL(process.env.ABAP_MCP_URL ?? "http://127.0.0.1:4847/mcp")
assert.ok(
  endpoint.protocol === "http:" &&
    endpoint.hostname === "127.0.0.1" &&
    endpoint.pathname === "/mcp" &&
    !endpoint.username &&
    !endpoint.password &&
    !endpoint.search &&
    !endpoint.hash,
  "Only a local MCP endpoint is accepted"
)
const flags = process.argv.slice(2)
assert.ok(
  flags.every((flag) => flag === "--approve-atc"),
  "Unknown argument"
)
const includeAtc = flags.includes("--approve-atc")
const startedAt = new Date().toISOString()
const evidence = {
  startedAt,
  localVersion: PRODUCT_VERSION,
  connectionId: "w200",
  includeAtc,
  status: "Partially Verified",
  stage: "connect",
  checks: []
}
const client = new Client({ name: "quality-check-acceptance", version: PRODUCT_VERSION })
const fileUris = [
  "adt://w200/sap/bc/adt/functions/groups/zorvanta_mcp_core/fmodules/z_orvanta_mcp_sci_api",
  "adt://w200/sap/bc/adt/programs/programs/zcodex_fs_sync_0807"
]
try {
  await client.connect(new StreamableHTTPClientTransport(endpoint))
  evidence.server = client.getServerVersion()
  evidence.stage = "version"
  assert.equal(evidence.server?.version, PRODUCT_VERSION)
  evidence.stage = "native-atc-precheck"
  const precheckResponse = await client.callTool({
    name: "run_atc_analysis",
    arguments: { action: "precheck_atc", connectionId: "w200" }
  })
  assert.ok(!precheckResponse.isError)
  evidence.nativeAtcPrecheck = JSON.parse(
    precheckResponse.content.find((part) => part.type === "text")?.text ?? ""
  )
  assert.equal(evidence.nativeAtcPrecheck.method, "GET")
  assert.equal(evidence.nativeAtcPrecheck.worklistCreationAttempted, false)
  assert.equal(evidence.nativeAtcPrecheck.runCreationAttempted, false)
  assert.equal(evidence.nativeAtcPrecheck.qualityGate, "not_evaluated")
  evidence.stage = "quality"
  const response = await client.callTool(
    {
      name: "run_atc_analysis",
      arguments: {
        action: "check_quality",
        connectionId: "w200",
        fileUris,
        includeAtc,
        ...(includeAtc ? { acknowledgePotentialSideEffects: true } : {})
      }
    },
    undefined,
    { timeout: 180000 }
  )
  assert.ok(!response.isError)
  const report = JSON.parse(response.content.find((part) => part.type === "text")?.text ?? "")
  evidence.report = report
  assert.equal(report.schemaVersion, 1)
  assert.equal(report.connectionId, "w200")
  assert.equal(report.qualityGate, "not_evaluated")
  assert.equal(report.sci.status, "not_executed")
  assert.deepEqual(
    report.results.map((result) => result.fileUri),
    fileUris
  )
  for (const result of report.results) {
    assert.equal(result.syntax.status, "completed")
    assert.equal(result.syntax.coverage, "requested_source_only")
    assert.ok(Array.isArray(result.syntax.findings))
    if (!includeAtc) assert.equal(result.atc.status, "not_requested")
  }
  evidence.stage = "invalid-input"
  for (const [label, args] of [
    ["wrong-connection", { fileUris: [fileUris[0].replace("w200", "w201")] }],
    ["duplicate", { fileUris: [fileUris[0], `${fileUris[0]}/source/main`] }],
    ["over-limit", { fileUris: Array(11).fill(fileUris[0]) }],
    ["atc-without-acknowledgement", { fileUris, includeAtc: true }]
  ]) {
    const result = await client.callTool({
      name: "run_atc_analysis",
      arguments: { action: "check_quality", connectionId: "w200", ...args }
    })
    evidence.checks.push({ label, rejected: result.isError === true })
    assert.equal(result.isError, true, label)
  }
  evidence.stage = "complete"
  evidence.status = report.status === "completed" ? "Passed" : "Partially Verified"
  evidence.scope = "Requested checks and boundary rejection only; not a passed SAP quality gate"
  if (evidence.status !== "Passed") process.exitCode = 2
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  await client.close()
  const directory = new URL("../../.doc/", import.meta.url)
  await mkdir(directory, { recursive: true })
  const path = fileURLToPath(
    new URL(`quality-check-acceptance-${startedAt.replaceAll(":", "-")}.json`, directory)
  )
  await writeFile(path, JSON.stringify(evidence, null, 2), { flag: "wx" })
  console.log(JSON.stringify({ status: evidence.status, stage: evidence.stage, path }))
}
