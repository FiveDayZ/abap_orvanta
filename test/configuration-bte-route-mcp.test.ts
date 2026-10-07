import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { startHttpServer } from "../src/http.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"
import { toolNamesForProfile } from "../src/tool-registry.js"

test("public route inspection is strict, read-only and available in config/readonly profiles", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-bte-route-"))
  assert(resolve(root).startsWith(resolve(tmpdir()) + sep))
  const backend = new MockBackend(),
    old = ToolService.prototype.inspectConfigurationBteMaintenanceRoute,
    calls: unknown[] = []
  ToolService.prototype.inspectConfigurationBteMaintenanceRoute = async (input) => {
    calls.push(input)
    return JSON.stringify({ readOnly: true, executable: false, writeAvailable: false })
  }
  backend.callRemoteFunction = async () => {
    throw Error("No native command")
  }
  const server = await startHttpServer(backend, 0, root),
    client = new Client({ name: "bte-route-contract", version: "r73" })
  t.after(async () => {
    ToolService.prototype.inspectConfigurationBteMaintenanceRoute = old
    await client.close()
    await server.closeIfIdle()
    await rm(root, { recursive: true, force: true })
  })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.mcpUrl)) as Parameters<Client["connect"]>[0]
  )
  const name = "inspect_configuration_bte_maintenance_route",
    tool = (await client.listTools()).tools.find((x) => x.name === name)
  assert(tool)
  assert.equal(tool.annotations?.readOnlyHint, true)
  assert.equal(tool.inputSchema.additionalProperties, false)
  assert(toolNamesForProfile("readonly").includes(name))
  assert(toolNamesForProfile("config").includes(name))
  assert.equal(
    (await client.callTool({ name, arguments: { connectionId: "w200" } })).isError,
    undefined
  )
  for (const patch of [
    { connectionId: "w300" },
    { tableName: "TDDAT" },
    { transactionCode: "BF34" },
    { maxProducts: 1 },
    { save: true },
    { acknowledgeConfigurationWrite: true }
  ])
    assert.equal(
      (await client.callTool({ name, arguments: { connectionId: "w200", ...patch } })).isError,
      true
    )
  assert.equal(calls.length, 1)
})
