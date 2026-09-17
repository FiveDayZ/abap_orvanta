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
    !endpoint.username &&
    !endpoint.password &&
    endpoint.pathname === "/mcp" &&
    !endpoint.search &&
    !endpoint.hash,
  "Only the local MCP service is accepted"
)
const startedAt = new Date().toISOString()
const evidence = {
  startedAt,
  localVersion: PRODUCT_VERSION,
  readOnly: true,
  connectionId: "w200",
  status: "Partially Verified",
  checks: []
}
const client = new Client({ name: "system-info-readonly-acceptance", version: PRODUCT_VERSION })
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 })
  assert.ok(!response.isError, `${name} returned an error`)
  const text = response.content.find((part) => part.type === "text")?.text
  assert.equal(typeof text, "string", `${name} returned no text`)
  return text
}
try {
  await client.connect(new StreamableHTTPClientTransport(endpoint))
  evidence.server = client.getServerVersion()
  assert.equal(
    evidence.server?.version,
    PRODUCT_VERSION,
    "Service version differs from local build"
  )
  await call("get_abap_sql_syntax")
  for (const includeComponents of [true, false]) {
    const text = await call("get_sap_system_info", { connectionId: "w200", includeComponents })
    const result = JSON.parse(text.slice(text.indexOf("{")))
    evidence.checks.push({
      includeComponents,
      status: result.status,
      currentClient: result.currentClient?.clientNumber,
      configuredClient: result.configuredClient,
      systemType: result.systemType,
      sapRelease: result.sapRelease,
      releaseSource: result.releaseSource,
      componentsComplete: result.componentsComplete,
      componentsIncluded: result.componentsIncluded,
      returnedComponents: result.softwareComponents?.length,
      timezone: result.timezone,
      sources: result.sources,
      queryWarnings: result.queryWarnings
    })
    assert.equal(result.status, "ok", "System information is not fully available")
    assert.equal(result.readOnly, true)
    assert.equal(result.currentClient?.clientNumber, "200")
    assert.equal(result.systemType, "ECC")
    assert.equal(result.sapRelease, "731")
    assert.equal(result.releaseSource, "CVERS.SAP_BASIS.RELEASE")
    assert.equal(result.componentsComplete, true)
    assert.equal(result.componentsIncluded, includeComponents)
    assert.equal(result.timezone?.offsetKind, "standard_time")
    assert.match(result.timezone?.utcOffset ?? "", /^UTC[+-]\d+(?::\d{2}){0,2}$/)
    assert.equal(result.sources.length, 6)
    assert.ok(
      result.sources.every(
        (source) =>
          source.status === "ok" && ["adt_query", "rfc_read_table"].includes(source.method)
      )
    )
    if (includeComponents) {
      assert.ok(
        result.softwareComponents.some(
          (component) => component.component === "SAP_BASIS" && component.release === "731"
        )
      )
    } else {
      assert.deepEqual(result.softwareComponents, [])
    }
  }
  evidence.status = "Passed"
} catch {
  // Never persist transport errors, response bodies or credentials.
  evidence.failure = "SYSTEM_INFO_ACCEPTANCE_NOT_PASSED"
  process.exitCode = 1
} finally {
  await client.close()
  const output = new URL(
    `../../.doc/system-info-acceptance-${startedAt.replace(/[:.]/g, "-")}.json`,
    import.meta.url
  )
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" })
  console.log(JSON.stringify({ ...evidence, output: fileURLToPath(output) }, null, 2))
}
