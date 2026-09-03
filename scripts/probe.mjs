import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const url = new URL(process.argv[2] ?? "http://127.0.0.1:4847/mcp")
const client = new Client({ name: "abap-mcp-probe", version: "0.1.0" })

try {
  await client.connect(new StreamableHTTPClientTransport(url))
  const tools = await client.listTools()
  const connected = await client.callTool({ name: "get_connected_systems", arguments: {} })
  console.log(
    JSON.stringify(
      {
        tools: tools.tools.map((tool) => tool.name).sort(),
        connected: connected.content
      },
      null,
      2
    )
  )
} finally {
  await client.close()
}
