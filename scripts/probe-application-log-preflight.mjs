import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const client = new Client({ name: "application-log-readonly-preflight", version: "1" })
const startedAt = new Date().toISOString()
const evidence = { startedAt, readOnly: true, functionExecutions: 0, functions: [], scope: [] }
async function call(name, args) {
  const result = await client.callTool({ name, arguments: { connectionId: "w200", ...args } })
  assert.ok(!result.isError, `${name} failed`)
  return result.content.find((part) => part.type === "text")?.text ?? ""
}
try {
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:4847/mcp")))
  evidence.server = client.getServerVersion()
  evidence.connected = await call("get_connected_systems", {})
  for (const functionName of [
    "BAL_DB_SEARCH",
    "BAL_DB_LOAD",
    "BAL_DB_SAVE_OLD_VERSIONS",
    "BAL_LOG_MSG_READ",
    "BAL_LOG_REFRESH",
    "BAL_GLB_AUTHORIZATION_GET"
  ]) {
    const definition = JSON.parse(await call("read_function_module_interface", { functionName }))
    evidence.functions.push({
      functionName,
      remoteEnabled: definition.remoteEnabled,
      sourceFingerprint: definition.sourceFingerprint,
      interfaceFingerprint: definition.interfaceFingerprint,
      lineCount: definition.source.length,
      relevantLines: definition.source
        .map((text, index) => ({ line: index + 1, text }))
        .filter(({ text }) =>
          /g_convert_old_logs|BAL_DB_SAVE|BAL_DB_ENQUEUE|BAL_DB_DEQUEUE|AUTHORITY-CHECK|call_ecatt_delete/.test(
            text
          )
        )
    })
  }
  for (const [pattern, types] of [
    ["Z_ORVANTA_LOG_READ", ["FUNC"]],
    ["ZORVANTA_LOG", ["FUGR"]],
    ["ZABAP", ["DEVC"]],
    ["S_APPL_LOG", ["SUSO"]]
  ]) {
    evidence.scope.push({
      pattern,
      result: await call("search_abap_objects", { pattern, types, maxResults: 5 })
    })
  }
  evidence.transport = await call("manage_transport_requests", {
    action: "get_transport_details",
    transportNumber: "GR2K923421"
  })
  evidence.status = "Partially Verified"
  evidence.conclusion =
    "Local client protocol only. No SAP helper deployed. BAL_DB_LOAD may save converted logs; message-read authorization remains closed."
} finally {
  await client.close()
}
const output = new URL(
  `../../.doc/application-log-preflight-${startedAt.replace(/[:.]/g, "-")}.json`,
  import.meta.url
)
await writeFile(output, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" })
console.log(
  JSON.stringify(
    {
      output: fileURLToPath(output),
      server: evidence.server,
      status: evidence.status,
      functions: evidence.functions.map(({ functionName, lineCount, relevantLines }) => ({
        functionName,
        lineCount,
        relevantLines
      })),
      functionExecutions: evidence.functionExecutions
    },
    null,
    2
  )
)
