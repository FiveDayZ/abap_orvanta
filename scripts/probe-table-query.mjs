import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
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
const startedAt = new Date().toISOString()
const evidence = {
  startedAt,
  localVersion: PRODUCT_VERSION,
  connectionId: "w200",
  readOnly: true,
  status: "Partially Verified",
  stage: "connect",
  checks: []
}
const client = new Client({ name: "table-query-readonly-acceptance", version: PRODUCT_VERSION })
const compare = (column, operator, value) => ({ column, operator, value })
async function query(label, args, validate) {
  evidence.stage = label
  const response = await client.callTool(
    {
      name: "read_abap_table",
      arguments: { connectionId: "w200", ...args }
    },
    undefined,
    { timeout: 60000 }
  )
  assert.ok(!response.isError)
  const result = JSON.parse(response.content.find((part) => part.type === "text")?.text ?? "")
  evidence.checks.push({
    label,
    status: result.status,
    method: result.method,
    code: result.code,
    stage: result.stage,
    returnedCount: result.returnedCount,
    truncated: result.truncated,
    definitionFingerprint: result.definitionFingerprint,
    nativeCode: result.nativeCode
  })
  assert.equal(result.status, "ok")
  assert.equal(result.readOnly, true)
  assert.equal(result.order, "unspecified")
  validate(result)
}
try {
  await client.connect(new StreamableHTTPClientTransport(endpoint))
  evidence.server = client.getServerVersion()
  evidence.stage = "version"
  assert.equal(evidence.server?.version, PRODUCT_VERSION)
  await query(
    "client",
    {
      tableName: "T000",
      columns: ["MANDT", "MTEXT"],
      filters: [compare("MANDT", "EQ", "200")],
      maxRows: 2
    },
    (result) => {
      assert.equal(result.returnedCount, 1)
      assert.equal(result.data[0].MANDT, "200")
    }
  )
  await query(
    "basis",
    {
      tableName: "CVERS",
      columns: ["COMPONENT", "RELEASE"],
      filters: [compare("COMPONENT", "EQ", "SAP_BASIS")],
      maxRows: 2
    },
    (result) => {
      assert.equal(result.returnedCount, 1)
      assert.equal(result.data[0].RELEASE, "731")
    }
  )
  await query(
    "empty",
    {
      tableName: "CVERS",
      columns: ["COMPONENT"],
      filters: [compare("COMPONENT", "EQ", "SAP_BASIS"), compare("COMPONENT", "NE", "SAP_BASIS")],
      maxRows: 2
    },
    (result) => {
      assert.deepEqual(result.data, [])
      assert.equal(result.truncated, false)
    }
  )
  await query("truncated", { tableName: "CVERS", columns: ["COMPONENT"], maxRows: 1 }, (result) => {
    assert.equal(result.returnedCount, 1)
    assert.equal(result.truncated, true)
  })
  evidence.stage = "invalid-input"
  const rejected = await client.callTool({
    name: "read_abap_table",
    arguments: {
      connectionId: "w200",
      tableName: "CVERS",
      columns: ["COMPONENT"],
      maxRows: 501
    }
  })
  assert.equal(rejected.isError, true)
  evidence.checks.push({ label: "invalid-input", rejected: true })
  evidence.status = "Passed"
  evidence.stage = "complete"
} catch {
  evidence.failure = "TABLE_QUERY_ACCEPTANCE_NOT_PASSED"
  process.exitCode = 1
} finally {
  await client.close()
  const output = new URL(
    `../../.doc/table-query-acceptance-${startedAt.replace(/[:.]/g, "-")}.json`,
    import.meta.url
  )
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" })
  console.log(JSON.stringify({ ...evidence, output: fileURLToPath(output) }, null, 2))
}
