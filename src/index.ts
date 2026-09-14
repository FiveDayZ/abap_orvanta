import { resolve } from "node:path"
import { AdtBackend } from "./adt-backend.js"
import { loadConnections } from "./config.js"
import { startHttpServer } from "./http.js"

const configPath = resolve(process.env.ABAP_MCP_CONFIG ?? "connections.json")
const port = Number.parseInt(process.env.ABAP_MCP_PORT ?? "4847", 10)
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error(`Invalid ABAP_MCP_PORT: ${process.env.ABAP_MCP_PORT}`)
}

const backend = new AdtBackend(await loadConnections(configPath))
const server = await startHttpServer(backend, port)
console.log(`ORVANTA listening at ${server.mcpUrl}`)

let closing = false
async function shutdown() {
  if (closing) return
  closing = true
  await server.close()
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)))
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)))
