import { writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { RuntimeIdentity } from "../dist/src/runtime-info.js"
import { PRODUCT_VERSION } from "../dist/src/version.js"

const endpoint = new URL(process.env.ABAP_MCP_URL ?? "http://127.0.0.1:4847/mcp")
const docs = resolve(dirname(fileURLToPath(import.meta.url)), "../../.doc")
const output = resolve(
  process.env.ORVANTA_MVP_UPGRADE_REPORT ??
    resolve(docs, `mvp-runtime-baseline-${Date.now()}-${randomUUID().slice(0, 8)}.json`)
)
const relativeOutput = relative(docs, output)
if (!relativeOutput || relativeOutput.startsWith("..") || isAbsolute(relativeOutput)) {
  throw new Error("The report must stay within this SAP workspace's .doc directory")
}
if (
  endpoint.protocol !== "http:" ||
  endpoint.hostname !== "127.0.0.1" ||
  endpoint.pathname !== "/mcp" ||
  endpoint.username ||
  endpoint.password ||
  endpoint.search ||
  endpoint.hash
) {
  throw new Error("Only a loopback MCP endpoint is accepted")
}
const report = {
  startedAt: new Date().toISOString(),
  status: "Failed",
  endpoint: endpoint.href,
  readOnly: true,
  sapBusinessWrites: false,
  automaticSwitch: false,
  automaticRecovery: false
}
const client = new Client({ name: "mvp-runtime-baseline-review", version: PRODUCT_VERSION })
async function call(name, args) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 })
  if (response.isError) throw new Error(`${name} did not return a usable observation`)
  return JSON.parse(
    response.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
  )
}
try {
  const candidate = await new RuntimeIdentity().report()
  if (candidate.status !== "observed" || !candidate.startupArtifact.artifactFingerprint) {
    throw new Error("Local candidate fingerprint is unavailable")
  }
  await client.connect(new StreamableHTTPClientTransport(endpoint))
  report.server = client.getServerVersion()
  report.candidate = candidate.startupArtifact
  report.runtime = await call("get_runtime_info", {
    expectedVersion: PRODUCT_VERSION,
    expectedArtifactFingerprint: candidate.startupArtifact.artifactFingerprint
  })
  if (report.runtime.status !== "observed")
    throw new Error("Running service and candidate do not match")
  report.recovery = await call("list_write_recovery_operations", {
    connectionId: "w200",
    maxResults: 50
  })
  report.manualRecoveryRequired = report.recovery.count > 0 || report.recovery.truncated === true
  report.status = "Passed"
  report.scope = "artifact-identity-and-recovery-inventory-only"
  report.upgradeAuthorized = false
  report.limitations = [
    "Recovery inventory excludes active calls and is not a complete quiescence check.",
    "Keep old and new services from writing to shared state concurrently.",
    "Preserve the complete state directory offline; do not clear receipts to bypass duplicate guards.",
    "Rollback of service binaries does not roll back SAP commits; older receipt compatibility must be checked.",
    "SAP helpers were not probed; use the existing capability report for separately authorized checks."
  ]
} catch (error) {
  report.failure = error.message
  process.exitCode = 1
} finally {
  await client.close()
  report.finishedAt = new Date().toISOString()
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" })
  console.log(JSON.stringify({ status: report.status, output }))
}
