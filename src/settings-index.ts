import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { startSettingsServer } from "./settings-server.js"
import { defaultInvocationStateRoot } from "./invocation-receipts.js"

const port = Number(process.env.ABAP_MCP_SETTINGS_PORT ?? "4851")
if (!Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535)))
  throw new Error("Invalid settings port")
const server = await startSettingsServer({
  configPath: resolve(process.env.ABAP_MCP_CONFIG ?? "connections.json"),
  assetsPath: fileURLToPath(new URL("../../ui/", import.meta.url)),
  stateRoot: defaultInvocationStateRoot(),
  port
})
console.log(JSON.stringify({ url: server.url }))
let closing = false
async function shutdown() {
  if (closing) return
  closing = true
  try {
    await server.close()
    process.exit(0)
  } catch {
    closing = false
    console.error("MCP operation in progress; shutdown refused.")
  }
}
process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())
