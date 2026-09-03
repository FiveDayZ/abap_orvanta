import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const endpoint = new URL(process.env.ABAP_MCP_ENDPOINT || "http://127.0.0.1:4847/mcp")
const connectionId = process.env.ABAP_MCP_CONNECTION || "w200"
const functionName = "ZCMCP_FM_1501"
const client = new Client({ name: "w200-rfc-validation", version: "0.17.0" })

function text(result) {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

async function call(arguments_) {
  const result = await client.callTool({
    name: "test_remote_function_module",
    arguments: { connectionId, functionName, acknowledgePotentialSideEffects: true, ...arguments_ }
  })
  const value = text(result)
  if (result.isError) throw new Error(value)
  return JSON.parse(value)
}

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint))
  const valid = await call({
    inputParameters: { IV_INPUT: "VALIDATION" },
    expectedOutputs: { EV_OUTPUT: "MCP:VALIDATION" }
  })
  const invalid = await call({
    inputParameters: { IV_INPUT: "" },
    expectedException: "INVALID_INPUT"
  })
  console.log(
    JSON.stringify(
      {
        endpoint: endpoint.href,
        connectionId,
        functionName,
        status: valid.status === "passed" && invalid.status === "passed" ? "passed" : "failed",
        validCall: valid,
        invalidCall: invalid
      },
      null,
      2
    )
  )
} finally {
  await client.close()
}
