import assert from "node:assert/strict"
import test from "node:test"
import { isFetchBlockedPort, startHttpServer } from "../src/http.js"
import { MockBackend } from "./mock-backend.js"

test("MCP rejects fetch-blocked explicit ports before listening, including newly observed omissions", async () => {
  for (const port of [
    1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
    6679, 6697, 10080
  ]) {
    assert.equal(isFetchBlockedPort(port), true)
    await assert.rejects(startHttpServer(new MockBackend(), port), /MCP_PORT_BLOCKED/)
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`), (error: unknown) => {
      assert.ok(error instanceof Error && error.cause instanceof Error)
      assert.equal(error.cause.message, "bad port")
      return true
    })
  }
  for (const port of [0, 80, 4847, 4848, 4849, 4850, 4852, 30000]) {
    assert.equal(isFetchBlockedPort(port), false)
  }
})

test("MCP reports an expired session as not found so clients can reinitialize", async () => {
  const running = await startHttpServer(new MockBackend(), 0)
  try {
    const response = await fetch(running.mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-session-id": "expired-after-server-restart"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    })
    assert.equal(response.status, 404)
    assert.match(await response.text(), /initialize a new session/)
  } finally {
    await running.close()
  }
})
