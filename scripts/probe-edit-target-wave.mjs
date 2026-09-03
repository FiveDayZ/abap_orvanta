import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const endpoint = process.env.ABAP_MCP_ENDPOINT || "http://127.0.0.1:4847/mcp"
const connectionId = process.env.ABAP_MCP_CONNECTION || "w200"
const client = new Client({ name: "w200-edit-target-wave-probe", version: "0.10.0" })
const targets = [
  { objectName: "ZCL_CA_HZ", objectType: "CLAS/OC" },
  { objectName: "Z001", objectType: "PROG/P" },
  { objectName: "Z009_I01", objectType: "PROG/I" },
  { objectName: "ZCA_FM_005_HZ_CX", objectType: "FUGR/FF" },
  { objectName: "ZIF_CCJF", objectType: "INTF/OI" }
]

try {
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)))
  const results = []
  for (const target of targets) {
    const resolved = await client.callTool({
      name: "get_abap_object_workspace_uri",
      arguments: { connectionId, ...target }
    })
    if (resolved.isError) throw new Error(JSON.stringify(resolved.content))
    const resolutionText = resolved.content.find((part) => part.type === "text")?.text || ""
    const uri = resolutionText.match(/^Workspace URI: (.+)$/m)?.[1]
    if (!uri) throw new Error(resolutionText || `No URI returned for ${target.objectName}`)

    const source = await client.callTool({
      name: "get_object_by_uri",
      arguments: { connectionId, uri, startLine: 0, lineCount: 1 }
    })
    if (source.isError) throw new Error(JSON.stringify(source.content))
    const sourceText = source.content.find((part) => part.type === "text")?.text || ""
    if (!sourceText.trim()) throw new Error(`Empty source response for ${target.objectName}`)
    results.push({ ...target, uri, firstLineResponseBytes: Buffer.byteLength(sourceText) })
  }
  console.log(JSON.stringify({ endpoint, connectionId, targets: results }, null, 2))
} finally {
  await client.close()
}
