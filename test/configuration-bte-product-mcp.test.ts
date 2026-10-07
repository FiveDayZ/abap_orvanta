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

test("public product preview validates scope and never turns a plan into execution", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-bte-preview-"))
  assert(resolve(root).startsWith(resolve(tmpdir()) + sep))
  const backend = new MockBackend(),
    old = ToolService.prototype.previewConfigurationBteProduct
  const calls: unknown[] = []
  ToolService.prototype.previewConfigurationBteProduct = async (input) => {
    calls.push(input)
    return JSON.stringify({
      readOnly: true,
      executable: false,
      writeAvailable: false,
      executionBlocker: "BTE_PRODUCT_WRITE_ADAPTER_PENDING"
    })
  }
  backend.callRemoteFunction = async () => {
    throw Error("No native command")
  }
  const server = await startHttpServer(backend, 0, root),
    client = new Client({ name: "bte-public-preview-test", version: "r72" })
  t.after(async () => {
    ToolService.prototype.previewConfigurationBteProduct = old
    await client.close()
    await server.closeIfIdle()
    await rm(root, { recursive: true, force: true })
  })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.mcpUrl)) as Parameters<Client["connect"]>[0]
  )
  const name = "preview_configuration_bte_product",
    tool = (await client.listTools()).tools.find((x) => x.name === name)
  assert(tool)
  assert.equal(tool.annotations?.readOnlyHint, true)
  assert.equal(tool.annotations?.destructiveHint, false)
  assert.equal(tool.inputSchema.additionalProperties, false)
  assert(toolNamesForProfile("readonly").includes(name))
  assert(toolNamesForProfile("config").includes(name))
  const input = { connectionId: "w200", productName: "ZDEMO", active: true }
  const value = await client.callTool({ name, arguments: input })
  assert.equal(value.isError, undefined)
  assert.equal(JSON.parse((value.content as { text: string }[])[0]!.text).writeAvailable, false)
  for (const patch of [
    { save: true },
    { acknowledgeConfigurationWrite: true },
    { connectionId: "w300" },
    { productName: "SAP" },
    { active: "X" },
    { maxAssignmentsPerKind: 1 },
    { expectedFingerprint: "stale" }
  ])
    assert.equal((await client.callTool({ name, arguments: { ...input, ...patch } })).isError, true)
  assert.equal(calls.length, 1)
})
