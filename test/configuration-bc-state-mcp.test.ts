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
import { stateFixture } from "./configuration-bc-state-fixture.js"

test("public native before-state MCP routes fixed read-only input and retracts failures without fallback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-bc-state-mcp-")),
    f = await stateFixture(),
    backend = new MockBackend()
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  const old = {
    definition: ToolService.prototype.readFunctionModuleInterface,
    preflight: ToolService.prototype.preflightConfigurationBcActivation,
    cts: ToolService.prototype.readConfigurationBcCtsSnapshot
  }
  ToolService.prototype.readFunctionModuleInterface = async () =>
    JSON.stringify(await f.readers.definition())
  ToolService.prototype.preflightConfigurationBcActivation = async () =>
    JSON.stringify(await f.readers.preflight())
  ToolService.prototype.readConfigurationBcCtsSnapshot = async () =>
    JSON.stringify(await f.readers.cts())
  const details = backend.connectionDetails.bind(backend)
  backend.connectionDetails = (id) => ({ ...details(id), client: "200", username: "wys" })
  backend.callRemoteFunction = f.backend.callRemoteFunction
  backend.runQuery = async () => {
    throw Error("No arbitrary SQL fallback")
  }
  backend.callSapHelper = async () => {
    throw Error("No generic helper fallback")
  }
  const server = await startHttpServer(backend, 0, root),
    client = new Client({ name: "bc-state-public-contract", version: "r52" })
  t.after(async () => {
    ToolService.prototype.readFunctionModuleInterface = old.definition
    ToolService.prototype.preflightConfigurationBcActivation = old.preflight
    ToolService.prototype.readConfigurationBcCtsSnapshot = old.cts
    await client.close()
    await server.closeIfIdle()
    await rm(root, { recursive: true, force: true })
  })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.mcpUrl)) as Parameters<Client["connect"]>[0]
  )
  const tool = (await client.listTools()).tools.find(
    (v) => v.name === "read_configuration_bc_before_state"
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
  assert.equal(result.recoveryAvailable, false)
  assert.equal(result.buffer.recoveryPermit, false)
  assert.match(result.beforeStateReference, /^[a-f0-9]{64}$/)
  assert.deepEqual(result.beforeStatePersistence, {
    immutable: true,
    recoveryPermit: false,
    executable: false
  })
  const before = { ...f.calls }
  for (const patch of [
    { connectionId: "w300" },
    { version: "A" },
    { restoreBytes: "AAAA" },
    { save: true },
    { nativeCtsVersion: undefined }
  ])
    assert.equal((await call({ ...f.input, ...patch })).isError, true)
  assert.deepEqual(f.calls, before)
  f.readers.definition = async () => {
    throw Error("FUNCTION_NOT_FOUND")
  }
  const missing = await call(f.input)
  assert.equal(missing.isError, true)
  assert.match((missing.content as { text: string }[])[0]!.text, /FUNCTION_NOT_FOUND/)
  assert.equal(f.calls.native, before.native)
  f.readers.definition = async () => structuredClone(f.definition)
  f.native.EV_CODE = "ROUNDTRIP_FAILED"
  const bad = await call(f.input)
  assert.equal(bad.isError, true)
  assert.match((bad.content as { text: string }[])[0]!.text, /ROUNDTRIP_FAILED/)
  assert.ok(!(bad.content as { text: string }[])[0]!.text.includes('"buffer"'))
})
