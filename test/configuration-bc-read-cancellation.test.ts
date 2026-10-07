import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { configurationBcReadBackend } from "../src/configuration-bc-read-cancellation.js"
import { createMcpServer } from "../src/mcp.js"
import { InvocationReceiptStore } from "../src/invocation-receipts.js"
import { WriteOperationReceiptStore } from "../src/write-operation-receipts.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"
import { stateFixture } from "./configuration-bc-state-fixture.js"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

test("cancelled BC read refuses every later backend dispatch, including a previously captured method", async () => {
  const backend = new MockBackend(),
    controller = new AbortController()
  let calls = 0
  backend.callRemoteFunction = async () => {
    calls++
    return { outputs: {} }
  }
  const scoped = configurationBcReadBackend(backend, controller.signal)
  const captured = scoped.callRemoteFunction
  controller.abort()
  await assert.rejects(
    async () =>
      captured("w200", { functionName: "Z_READ", inputParameters: {}, outputParameters: [] }),
    /BC_READ_CANCELLED/
  )
  assert.throws(() => scoped.connectionDetails("w200"), /BC_READ_CANCELLED/)
  assert.equal(calls, 0)
})

test("in-flight read settles but cancellation retracts its result and blocks the next call", async () => {
  const backend = new MockBackend(),
    controller = new AbortController(),
    gate = deferred()
  let calls = 0
  backend.callRemoteFunction = async () => {
    calls++
    await gate.promise
    return { outputs: { EV_CODE: "SUCCESS" } }
  }
  const scoped = configurationBcReadBackend(backend, controller.signal)
  const pending = scoped.callRemoteFunction("w200", {
    functionName: "Z_READ",
    inputParameters: {},
    outputParameters: []
  })
  controller.abort()
  gate.resolve()
  await assert.rejects(pending, /BC_READ_CANCELLED/)
  await assert.rejects(
    async () =>
      scoped.callRemoteFunction("w200", {
        functionName: "Z_READ",
        inputParameters: {},
        outputParameters: []
      }),
    /BC_READ_CANCELLED/
  )
  assert.equal(calls, 1)
})

test("a read without cancellation preserves SAP errors and does not affect another request", async () => {
  const backend = new MockBackend(),
    a = new AbortController(),
    b = new AbortController()
  backend.readSourceByUri = async (_id, uri) => ({ source: "source", uriUsed: uri })
  backend.callRemoteFunction = async () => {
    throw Error("SAP unavailable")
  }
  const first = configurationBcReadBackend(backend, a.signal),
    second = configurationBcReadBackend(backend, b.signal)
  a.abort()
  await assert.rejects(async () => first.readSourceByUri("w200", "/source"), /BC_READ_CANCELLED/)
  assert.equal((await second.readSourceByUri("w200", "/source")).source, "source")
  await assert.rejects(
    second.callRemoteFunction("w200", {
      functionName: "Z_READ",
      inputParameters: {},
      outputParameters: []
    }),
    /SAP unavailable/
  )
})

test(
  "SDK cancellation of public STATE stops the second native call and publishes no before-state",
  { timeout: 5000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "orvanta-bc-read-cancel-")),
      f = await stateFixture(),
      backend = new MockBackend()
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    const old = {
      definition: ToolService.prototype.readFunctionModuleInterface,
      preflight: ToolService.prototype.preflightConfigurationBcActivation,
      cts: ToolService.prototype.readConfigurationBcCtsSnapshot,
      exportRoot: process.env.ABAP_MCP_EXPORT_ROOT
    }
    process.env.ABAP_MCP_EXPORT_ROOT = root
    ToolService.prototype.readFunctionModuleInterface = async () =>
      JSON.stringify(await f.readers.definition())
    ToolService.prototype.preflightConfigurationBcActivation = async () =>
      JSON.stringify(await f.readers.preflight())
    ToolService.prototype.readConfigurationBcCtsSnapshot = async () =>
      JSON.stringify(await f.readers.cts())
    const details = backend.connectionDetails.bind(backend)
    backend.connectionDetails = (id) => ({ ...details(id), client: "200", username: "wys" })
    const started = deferred(),
      release = deferred(),
      finished = deferred()
    let dispatches = 0
    backend.callRemoteFunction = async (id, request) => {
      dispatches++
      started.resolve()
      await release.promise
      return f.backend.callRemoteFunction(id, request)
    }
    const server = createMcpServer(
      backend,
      new InvocationReceiptStore(root),
      new WriteOperationReceiptStore(root),
      () => () => finished.resolve(),
      root
    )
    const client = new Client({ name: "bc-sdk-cancellation", version: "r68" })
    const [local, remote] = InMemoryTransport.createLinkedPair()
    t.after(async () => {
      release.resolve()
      ToolService.prototype.readFunctionModuleInterface = old.definition
      ToolService.prototype.preflightConfigurationBcActivation = old.preflight
      ToolService.prototype.readConfigurationBcCtsSnapshot = old.cts
      if (old.exportRoot === undefined) delete process.env.ABAP_MCP_EXPORT_ROOT
      else process.env.ABAP_MCP_EXPORT_ROOT = old.exportRoot
      await client.close()
      await server.close()
      await rm(root, { recursive: true, force: true })
    })
    await server.connect(remote)
    await client.connect(local)
    const controller = new AbortController()
    const pending = client.callTool(
      { name: "read_configuration_bc_before_state", arguments: f.input },
      undefined,
      { signal: controller.signal }
    )
    await started.promise
    controller.abort()
    await assert.rejects(pending, /abort/i)
    // The cancellation notification is handled before the held native response is released.
    await new Promise<void>((r) => setImmediate(r))
    release.resolve()
    await finished.promise
    assert.equal(dispatches, 1)
    assert.equal(f.calls.native, 1)
    assert.equal(f.calls.preflight, 1)
    await assert.rejects(readdir(join(root, "configuration-bc-before-state")), { code: "ENOENT" })
  }
)
