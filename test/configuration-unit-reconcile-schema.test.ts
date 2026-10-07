import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { startHttpServer } from "../src/http.js"
import { MockBackend } from "./mock-backend.js"

test("MCP advertises read-only reconciliation and refuses missing context or hidden writes before SAP", async () => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-unit-reconcile-schema-"))
  const backend = new MockBackend()
  backend.runQuery = async () => assert.fail("rejected reconciliation must not query SAP")
  backend.callRemoteFunction = async () =>
    assert.fail("rejected reconciliation must not call a native writer or reader")
  const server = await startHttpServer(backend, 0, root)
  const client = new Client({ name: "unit-reconcile-schema", version: "1" })
  try {
    const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl))
    await client.connect(transport as Parameters<Client["connect"]>[0])
    const tool = (await client.listTools()).tools.find(
      (t) => t.name === "reconcile_configuration_unit_text"
    )!
    assert.ok(tool)
    assert.equal(tool.annotations!.readOnlyHint, true)
    assert.equal(tool.annotations!.destructiveHint, false)
    assert.equal(tool.inputSchema.additionalProperties, false)
    for (const name of [
      "connectionId",
      "operationId",
      "originalInput",
      "beforeText",
      "includeLocks"
    ])
      assert.ok(tool.inputSchema.properties![name])
    for (const input of [
      { connectionId: "w200", operationId: "missing" },
      { connectionId: "w300", operationId: "missing", originalInput: {}, beforeText: {} },
      {
        connectionId: "w200",
        operationId: "missing",
        originalInput: {},
        beforeText: {},
        execute: true
      }
    ])
      assert.equal((await client.callTool({ name: tool.name, arguments: input })).isError, true)
  } finally {
    await client.close()
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})
