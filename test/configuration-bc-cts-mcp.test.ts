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
import { ctsFixture } from "./configuration-bc-cts-fixture.js"

test("public CTS MCP contract binds full opaque output and refuses invalid scope and native failures", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-bc-cts-mcp-")),
    f = ctsFixture(),
    backend = new MockBackend()
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  const original = {
    definition: ToolService.prototype.readFunctionModuleInterface,
    table: ToolService.prototype.readDdicTransparentTable
  }
  ToolService.prototype.readFunctionModuleInterface = async (input) =>
    JSON.stringify(await f.readers.definition(input.functionName))
  ToolService.prototype.readDdicTransparentTable = async (input) =>
    JSON.stringify(await f.readers.table(input.objectName))
  const details = backend.connectionDetails.bind(backend)
  backend.connectionDetails = (id) => ({ ...details(id), client: "200", username: "wys" })
  backend.callRemoteFunction = f.backend.callRemoteFunction
  backend.runQuery = async () => {
    throw Error("No generic query fallback")
  }
  backend.callSapHelper = async () => {
    throw Error("No generic helper fallback")
  }
  const server = await startHttpServer(backend, 0, root),
    client = new Client({ name: "cts-public-contract", version: "r51" })
  t.after(async () => {
    ToolService.prototype.readFunctionModuleInterface = original.definition
    ToolService.prototype.readDdicTransparentTable = original.table
    await client.close()
    await server.closeIfIdle()
    await rm(root, { recursive: true, force: true })
  })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.mcpUrl)) as Parameters<Client["connect"]>[0]
  )
  const tool = (await client.listTools()).tools.find(
    (t) => t.name === "read_configuration_bc_cts_snapshot"
  )
  assert.ok(tool)
  assert.equal(tool.inputSchema.additionalProperties, false)
  assert.deepEqual([...(tool.inputSchema.required ?? [])].sort(), Object.keys(f.input).sort())
  assert.equal(tool.annotations?.readOnlyHint, true)
  assert.equal(tool.annotations?.destructiveHint, false)
  const call = (arguments_: Record<string, unknown>) =>
    client.callTool({ name: tool.name, arguments: arguments_ })
  const positive = await call(f.input)
  assert.equal(positive.isError, undefined)
  const result = JSON.parse((positive.content as { text: string }[])[0]!.text)
  assert.equal(result.buffer.data, f.native.EV_DATA_BASE64)
  assert.equal(result.ctsVersion, f.native.EV_CTS_VERSION)
  assert.equal(result.recoveryAvailable, false)
  assert.equal(result.snapshot, false)
  assert.deepEqual(f.calls, { native: 2, definition: 14, table: 10 })
  const before = { ...f.calls }
  for (const invalid of [
    { connectionId: "w300" },
    { taskNumber: "GR2K923429" },
    { save: true },
    { version: "A" }
  ])
    assert.equal((await call({ ...f.input, ...invalid })).isError, true)
  assert.deepEqual(f.calls, before)
  f.native.EV_CODE = "AUTHORIZATION_DENIED"
  const rejected = await call(f.input)
  assert.equal(rejected.isError, true)
  const text = (rejected.content as { text: string }[])[0]!.text
  assert.match(text, /AUTHORIZATION_DENIED/)
  assert.ok(!text.includes('"buffer"'))
  f.native.EV_CODE = "CTS_READ_OK"
  f.native.EV_DATA_BYTES = "1"
  const corrupt = await call(f.input)
  assert.equal(corrupt.isError, true)
  assert.match((corrupt.content as { text: string }[])[0]!.text, /BUFFER_INVALID/)
})
