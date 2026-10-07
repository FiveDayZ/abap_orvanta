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

test("public native metadata tool exposes only fixed readonly inputs and refuses write or object selectors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-bte-meta-"))
  assert(resolve(root).startsWith(resolve(tmpdir()) + sep))
  const backend = new MockBackend(),
    old = ToolService.prototype.inspectConfigurationBteNativeMetadata,
    calls: unknown[] = []
  ToolService.prototype.inspectConfigurationBteNativeMetadata = async (input) => {
    calls.push(input)
    return JSON.stringify({
      readOnly: true,
      fresh: false,
      executable: false,
      writeAvailable: false
    })
  }
  backend.callRemoteFunction = async () => {
    throw Error("No native command in schema test")
  }
  const server = await startHttpServer(backend, 0, root),
    client = new Client({ name: "bte-meta-contract", version: "r74" })
  t.after(async () => {
    ToolService.prototype.inspectConfigurationBteNativeMetadata = old
    await client.close()
    await server.closeIfIdle()
    await rm(root, { recursive: true, force: true })
  })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.mcpUrl)) as Parameters<Client["connect"]>[0]
  )
  const name = "inspect_configuration_bte_native_metadata",
    tool = (await client.listTools()).tools.find((t) => t.name === name)
  assert(tool)
  assert.equal(tool.annotations?.readOnlyHint, true)
  assert.equal(tool.inputSchema.additionalProperties, false)
  assert(toolNamesForProfile("readonly").includes(name))
  assert(toolNamesForProfile("config").includes(name))
  assert.equal(
    (await client.callTool({ name, arguments: { connectionId: "w200" } })).isError,
    undefined
  )
  for (const p of [
    { connectionId: "w300" },
    { tableName: "TBE34" },
    { functionName: "VIEW_MAINTENANCE_NO_DIALOG" },
    { save: true },
    { transportNumber: "GR2K923430" }
  ])
    assert.equal(
      (await client.callTool({ name, arguments: { connectionId: "w200", ...p } })).isError,
      true
    )
  assert.equal(calls.length, 1)
})
