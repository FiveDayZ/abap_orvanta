#!/usr/bin/env node
// Observe one explicitly named runtime. No SAP tool, credential or write command is invoked.
import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const [endpoint, manifestPath, evidencePath, ...extra] = process.argv.slice(2)
assert.ok(
  endpoint && manifestPath && evidencePath && extra.length === 0,
  "Usage: node check-spro-core.mjs <loopback-mcp-url> <BUILD-INFO.json> <new-evidence.json>"
)
const url = new URL(endpoint)
assert.ok(
  url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
    url.pathname === "/mcp" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash,
  "Only a credential-free loopback MCP endpoint is accepted"
)
const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
assert.match(manifest.expectedArtifactFingerprint, /^[a-f0-9]{64}$/)
assert.ok(Array.isArray(manifest.requiredTools) && manifest.requiredTools.length > 0)
const client = new Client({ name: "spro-core-delivery-readonly-check", version: "1" })
const evidence = { startedAt: new Date().toISOString(), endpoint, sapCalls: 0, writeCalls: 0 }
try {
  await client.connect(new StreamableHTTPClientTransport(url), { timeout: 10000 })
  const exposed = []
  let cursor
  do {
    const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 10000 })
    exposed.push(...page.tools)
    cursor = page.nextCursor
  } while (cursor)
  evidence.tools = exposed.map((tool) => tool.name).sort()
  assert.deepEqual(
    evidence.tools,
    [...manifest.requiredTools].sort(),
    "Core tool surface differs from delivery manifest"
  )
  for (const tool of exposed) {
    assert.equal(
      tool.inputSchema.additionalProperties,
      false,
      `${tool.name}: schema must reject extra inputs`
    )
    assert.equal(
      typeof tool.annotations?.readOnlyHint,
      "boolean",
      `${tool.name}: missing read/write annotation`
    )
  }
  const result = await client.callTool(
    {
      name: "get_runtime_info",
      arguments: {
        expectedVersion: manifest.version,
        expectedArtifactFingerprint: manifest.expectedArtifactFingerprint
      }
    },
    undefined,
    { timeout: 10000 }
  )
  assert.notEqual(result.isError, true)
  const text = result.content.find((part) => part.type === "text")?.text
  assert.equal(typeof text, "string")
  const runtime = JSON.parse(text)
  evidence.runtime = runtime
  assert.equal(runtime.status, "observed")
  for (const check of [
    "expectedVersion",
    "expectedArtifact",
    "diskSinceStartup",
    "moduleAndPackageVersion"
  ])
    assert.equal(runtime.checks[check], "match", `${check} must match`)
  assert.equal(runtime.restartRequired, false)
  assert.equal(runtime.toolProfile.profile, manifest.profile)
  assert.equal(runtime.toolProfile.enabledCount, manifest.requiredTools.length)
  evidence.status = "Passed"
  evidence.limitations = [
    "Local HTTP runtime identity/tool surface only; SAP and formal-service business acceptance are not established."
  ]
} catch (error) {
  evidence.status = "Failed"
  // Do not copy transport diagnostics or configuration into public evidence.
  evidence.failure =
    error instanceof assert.AssertionError ? error.message : "MCP_RUNTIME_CHECK_FAILED"
  process.exitCode = 1
} finally {
  await client.close()
  evidence.finishedAt = new Date().toISOString()
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" })
}
console.log(
  JSON.stringify({
    status: evidence.status,
    tools: evidence.tools?.length,
    sapCalls: 0,
    evidence: evidencePath
  })
)
