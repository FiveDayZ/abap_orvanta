import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { PRODUCT_VERSION } from "../dist/src/version.js"

/**
 * A real acceptance run archives its evidence into the workspace `.doc`
 * directory next to this script. The regression test that drives this probe
 * against a mock service must not add synthetic records to that archive, so it
 * redirects the destination through `ABAP_MCP_EVIDENCE_DIR`.
 */
const evidenceDirectory = () =>
  process.env.ABAP_MCP_EVIDENCE_DIR?.trim() ||
  fileURLToPath(new URL("../../.doc/", import.meta.url))

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
const evidence = {
  startedAt: new Date().toISOString(),
  localVersion: PRODUCT_VERSION,
  readOnly: true,
  status: "Partially Verified",
  stage: "connect",
  checks: []
}
const objectUri =
  "adt://w200/sap/bc/adt/functions/groups/zorvanta_mcp_core/fmodules/z_orvanta_mcp_sci_api"
const common = {
  objectName: "Z_ORVANTA_MCP_SCI_API",
  connectionId: "w200",
  responseFormat: "json",
  maxResults: 10,
  includeSnippets: false
}
const client = new Client({ name: "where-used-acceptance", version: PRODUCT_VERSION })
async function query(label, extra) {
  evidence.stage = label
  const response = await client.callTool(
    { name: "find_where_used", arguments: { ...common, ...extra } },
    undefined,
    { timeout: 120000 }
  )
  assert.ok(!response.isError)
  const report = JSON.parse(response.content.find((part) => part.type === "text")?.text ?? "")
  evidence.checks.push({ label, report })
  assert.equal(report.schemaVersion, 1)
  assert.ok(["ADT_WHERE_USED", "ADT_RIS_WHEREUSED"].includes(report.engine))
  assert.equal(report.readOnly, true)
  assert.equal(report.connectionId, "w200")
  assert.equal(report.objectName, common.objectName)
  assert.ok(report.target?.uri)
  assert.ok(["references", "complete"].includes(report.stage))
  if (report.status === "unavailable") {
    assert.equal(report.stage, "references")
    assert.equal(report.references, null)
    assert.equal(report.rawCount, null)
    assert.equal(report.error.category, "unsupported-endpoint")
  } else {
    assert.ok(["ok", "partial"].includes(report.status))
    assert.ok(Array.isArray(report.references))
    assert.ok(Number.isInteger(report.rawCount))
    if (report.engine === "ADT_RIS_WHEREUSED") {
      assert.equal(report.status, "partial")
      assert.ok(report.references.every((entry) => entry.identifierKind === "ADT_RIS_URI"))
      assert.ok(report.references.every((entry) => entry.objectIdentifier === entry.uri))
      assert.equal(report.snippets.length, 0)
      if (report.rawCount === 0) assert.equal(report.code, "LEGACY_NO_REFERENCES_UNVERIFIED")
    }
  }
  return report
}
try {
  await client.connect(new StreamableHTTPClientTransport(endpoint))
  evidence.server = client.getServerVersion()
  evidence.stage = "version"
  assert.equal(evidence.server?.version, PRODUCT_VERSION)
  const direct = await query("explicit-uri", { objectUri })
  assert.equal(direct.resolution, "explicit_uri")
  const typed = await query("typed-name", { objectType: "FUGR/FF" })
  assert.ok(["typed_search", "bounded_name_search"].includes(typed.resolution))
  assert.equal(typed.target.uri, direct.target.uri)
  evidence.stage = "invalid-input"
  for (const [label, extra, pattern] of [
    ["cross-connection", { objectUri: objectUri.replace("w200", "w201") }, /same-connection/],
    [
      "mismatched-name",
      { objectUri: objectUri.replace("z_orvanta_mcp_sci_api", "zother") },
      /supplied objectName/
    ],
    ["over-limit", { objectUri, maxResults: 101 }, /100|too_big/],
    ["missing-line", { objectUri, character: 1 }, /character requires line/],
    ["conflicting-resolution", { objectUri, objectType: "FUGR/FF" }, /not both/]
  ]) {
    const response = await client.callTool({
      name: "find_where_used",
      arguments: { ...common, ...extra }
    })
    const text = response.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
    evidence.checks.push({ label, rejected: response.isError === true, message: text })
    assert.equal(response.isError, true, label)
    assert.match(text, pattern, label)
  }
  evidence.stage = "complete"
  evidence.behaviorVerified = true
  evidence.status =
    direct.status === "ok" && typed.status === "ok" ? "Passed" : "Partially Verified"
  if (evidence.status !== "Passed") process.exitCode = 2
} catch (error) {
  evidence.behaviorVerified = false
  evidence.status = ["connect", "version"].includes(evidence.stage)
    ? "Partially Verified"
    : "Failed"
  evidence.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  await client.close()
  const directory = evidenceDirectory()
  await mkdir(directory, { recursive: true })
  const path = join(
    directory,
    `where-used-acceptance-${evidence.startedAt.replaceAll(":", "-")}.json`
  )
  await writeFile(path, JSON.stringify(evidence, null, 2), { flag: "wx" })
  console.log(JSON.stringify({ status: evidence.status, stage: evidence.stage, path }))
}
