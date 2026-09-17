import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { PRODUCT_VERSION } from "../dist/src/version.js"
import { RuntimeIdentity } from "../dist/src/runtime-info.js"

const endpoint = new URL(process.env.ABAP_MCP_URL ?? "http://127.0.0.1:4854/mcp")
assert.ok(
  endpoint.protocol === "http:" &&
    endpoint.hostname === "127.0.0.1" &&
    endpoint.pathname === "/mcp" &&
    !endpoint.username &&
    !endpoint.password &&
    !endpoint.search &&
    !endpoint.hash
)
const output = resolve(
  process.env.ORVANTA_FULL_ROW_REPORT ?? `../.doc/full-row-query-${Date.now()}.json`
)
const report = {
  startedAt: new Date().toISOString(),
  status: "Failed",
  endpoint: endpoint.href,
  version: PRODUCT_VERSION,
  scope: "five-complete-110-field-rows",
  readOnly: true
}
const client = new Client({ name: "full-row-query-acceptance", version: PRODUCT_VERSION })
async function call(name, args) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 })
  const text = response.content
    .filter((x) => x.type === "text")
    .map((x) => x.text)
    .join("\n")
  if (response.isError) {
    report.toolFailure = { name, text }
    throw new Error("MCP tool returned an error")
  }
  return text
}
try {
  await client.connect(new StreamableHTTPClientTransport(endpoint))
  report.server = client.getServerVersion()
  assert.equal(report.server?.version, PRODUCT_VERSION)
  const candidate = await new RuntimeIdentity().report()
  assert.equal(candidate.status, "observed", "Candidate artifact identity is unavailable")
  report.runtime = JSON.parse(
    await call("get_runtime_info", {
      expectedVersion: PRODUCT_VERSION,
      expectedArtifactFingerprint: candidate.startupArtifact.artifactFingerprint
    })
  )
  assert.equal(
    report.runtime.status,
    "observed",
    "Running artifact differs from the reviewed candidate"
  )
  const definition = JSON.parse(
    await call("read_ddic_transparent_table", {
      connectionId: "w200",
      objectName: "ZTPMC_RKH"
    })
  )
  const fields = definition.definition.fields.filter((x) => !x.name.startsWith("."))
  report.definitionFingerprint = definition.fingerprint
  report.fieldNames = fields.map((x) => x.name)
  report.keyNames = fields.filter((x) => x.key).map((x) => x.name)
  assert.equal(
    fields.length,
    110,
    "The approved 110-field baseline changed; review before accepting."
  )
  assert.deepEqual(report.keyNames, ["MANDT", "WERKS", "ZRKJHH"])
  await call("get_abap_sql_syntax", {})
  report.request = {
    connectionId: "w200",
    displayMode: "internal",
    sql: "SELECT * FROM ZTPMC_RKH WHERE KUNNR = '0001100059'",
    maxRows: 5,
    rowRange: { start: 0, end: 5 }
  }
  report.result = JSON.parse(await call("execute_data_query", report.request))
  const rows = report.result.data
  assert.equal(rows.length, 5)
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), [...report.fieldNames].sort())
    assert.equal(row.KUNNR, "0001100059")
    assert.equal(row.MANDT, "200")
    assert.ok(report.keyNames.every((key) => typeof row[key] === "string" && row[key]))
    assert.ok(Object.values(row).every((value) => typeof value === "string"))
  }
  assert.equal(report.result.querySource.snapshot, false)
  assert.ok(["rfc_read_table", "bbp_rfc_read_table"].includes(report.result.querySource.method))
  assert.equal(
    new Set(rows.map((row) => JSON.stringify(report.keyNames.map((key) => row[key])))).size,
    5
  )
  report.completeRows = 5
  report.valuesReturned = 550
  report.status = "Passed"
} catch (error) {
  report.failure = error.message
  process.exitCode = 1
} finally {
  await client.close()
  report.finishedAt = new Date().toISOString()
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" })
  console.log(
    JSON.stringify(
      {
        status: report.status,
        completeRows: report.completeRows,
        valuesReturned: report.valuesReturned,
        output
      },
      null,
      2
    )
  )
}
