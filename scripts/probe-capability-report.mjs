import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const endpoint = new URL(process.env.ABAP_MCP_ENDPOINT || "http://127.0.0.1:4847/mcp")
const connectionId = (process.env.ABAP_MCP_CONNECTION || "w200").toLowerCase()
const client = new Client({ name: "w200-capability-report-validation", version: "0.35.0" })
let report

function output(result) {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint))
  const listed = await client.listTools()
  const result = await client.callTool({
    name: "get_capability_report",
    arguments: { connectionId }
  })
  const text = output(result)
  if (result.isError) throw new Error(text)
  report = JSON.parse(text)
  const reportedTools = report.capabilities.flatMap((capability) => capability.toolNames)
  const helper = (name) => report.helpers.find((item) => item.name === name)
  const capability = (id) => report.capabilities.find((item) => item.id === id)

  if (report.productVersion !== "0.35.0") throw new Error("Unexpected product version")
  if (report.connection.id !== connectionId) throw new Error("Unexpected connection ID")
  if (!report.readOnly || report.safety.sapWritesInvoked)
    throw new Error("Read-only guarantee missing")
  if (listed.tools.length !== 74 || new Set(reportedTools).size !== 74) {
    throw new Error("Capability report must cover each of the 74 registered tools exactly once")
  }
  for (const [name, minimumObservedVersion] of [
    ["base", "1.0"],
    ["repository", "1.1"],
    ["ddic", "1.2"]
  ]) {
    const observation = helper(name)
    if (
      observation?.availability !== "available" ||
      !observation.protocolVersion ||
      Number.parseFloat(observation.protocolVersion) < Number.parseFloat(minimumObservedVersion)
    ) {
      throw new Error(
        `${name} helper read protocol ${minimumObservedVersion}+ was not observed as available`
      )
    }
  }
  for (const id of [
    "adt-discovery",
    "adt-repository-search",
    "adt-data-preview",
    "adt-transport-read",
    "adt-runtime-dumps"
  ]) {
    if (capability(id)?.observation.availability !== "available") {
      throw new Error(`${id} was not observed as available`)
    }
  }
  if (capability("adt-runtime-traces")?.observation.availability === "unknown") {
    throw new Error("Trace probe did not produce a definite available or unsupported result")
  }

  console.log(
    JSON.stringify(
      {
        endpoint: endpoint.href,
        connectionId,
        status: "passed",
        productVersion: report.productVersion,
        observedAt: report.observedAt,
        helperVersions: Object.fromEntries(
          report.helpers.map((item) => [item.name, item.protocolVersion ?? null])
        ),
        summary: report.summary,
        discovery: report.discovery,
        capabilityAvailability: Object.fromEntries(
          report.capabilities.map((item) => [item.id, item.observation.availability])
        ),
        safety: report.safety,
        registeredToolCount: listed.tools.length,
        reportedToolCount: reportedTools.length
      },
      null,
      2
    )
  )
} catch (error) {
  console.log(
    JSON.stringify(
      {
        endpoint: endpoint.href,
        connectionId,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        ...(report
          ? {
              observedAt: report.observedAt,
              helpers: report.helpers,
              summary: report.summary,
              safety: report.safety
            }
          : {})
      },
      null,
      2
    )
  )
  throw error
} finally {
  await client.close()
}
