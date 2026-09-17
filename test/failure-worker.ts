import { appendFile } from "node:fs/promises"
import { join } from "node:path"
import { startHttpServer } from "../src/http.js"
import { MockBackend } from "./mock-backend.js"

const root = process.argv[2]
if (!root) throw new Error("Isolated test state directory is required")
const backend = new MockBackend()
const invoke = backend.callRemoteFunction.bind(backend)
backend.callRemoteFunction = async (connection, request) => {
  const value = request.inputParameters.IV_INPUT
  await appendFile(join(root, "calls.jsonl"), `${JSON.stringify({ pid: process.pid, value })}\n`)
  if (value === "HOLD") {
    process.send?.({ type: "entered" })
    await new Promise<void>((resolve) => process.once("message", () => resolve()))
  }
  if (value === "NETWORK") throw new Error("Injected connection loss after dispatch")
  return invoke(connection, request)
}
const server = await startHttpServer(backend, 0, root)
process.send?.({ type: "ready", url: server.mcpUrl, pid: process.pid })
