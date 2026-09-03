import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const endpoint = process.env.ABAP_MCP_ENDPOINT || "http://127.0.0.1:4847/mcp"
const connectionId = process.env.ABAP_MCP_CONNECTION || "w200"
const client = new Client({ name: "w200-transport-wave-probe", version: "0.5.0" })

try {
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)))
  const result = await client.callTool({
    name: "manage_transport_requests",
    arguments: { action: "get_user_transports", connectionId }
  })
  if (result.isError) throw new Error(JSON.stringify(result.content))
  const text = result.content.find((part) => part.type === "text")?.text || ""
  if (!text.includes("Transport Requests for User:")) throw new Error(text || "Empty response")
  console.log(text)
} finally {
  await client.close()
}
