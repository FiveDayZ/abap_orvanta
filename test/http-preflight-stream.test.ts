import assert from "node:assert/strict"
import { createServer, type ServerResponse } from "node:http"
import { once } from "node:events"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { keepSseStreamAlive, startHttpServer } from "../src/http.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"
import { stateFixture } from "./configuration-bc-state-fixture.js"

for (const mode of ["sse", "json", "delayed-headers"] as const)
  test(`preflight keepalive preserves ${mode} response content and headers`, async (t) => {
    let outgoing: ServerResponse | undefined
    const payload = mode === "sse" ? 'data: {"result":"complete"}\n\n' : '{"result":"complete"}'
    const server = createServer((_request, response) => {
      outgoing = response
      keepSseStreamAlive(response, 10)
      if (mode !== "delayed-headers") {
        response.writeHead(200, {
          "content-type": mode === "sse" ? "text/event-stream" : "application/json"
        })
        response.flushHeaders()
      }
      setTimeout(() => {
        if (mode === "delayed-headers")
          response.writeHead(200, { "content-type": "application/json" })
        response.end(payload)
      }, 80)
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    t.after(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const address = server.address()
    assert.ok(address && typeof address !== "string")
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`)
    assert.equal(response.status, 200)
    const body = await response.text()
    if (mode === "sse") {
      assert.match(body, /: keep-alive\n\n/)
      assert.equal(body.replaceAll(": keep-alive\n\n", ""), payload)
    } else assert.equal(body, payload)
    assert.ok(outgoing)
    assert.equal(
      outgoing.listeners("finish").some((listener) => listener.name === "stop"),
      false
    )
    assert.equal(
      outgoing.listeners("close").some((listener) => listener.name === "stop"),
      false
    )
  })

test("preflight stream cancellation removes both timer cleanup listeners", async (t) => {
  let outgoing: ServerResponse | undefined
  const server = createServer((_request, response) => {
    outgoing = response
    keepSseStreamAlive(response, 10)
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.flushHeaders()
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const response = await fetch(`http://127.0.0.1:${address.port}/mcp`)
  assert.ok(response.body && outgoing)
  const closed = once(outgoing, "close")
  await response.body.cancel()
  await closed
  assert.equal(
    outgoing.listeners("finish").some((listener) => listener.name === "stop"),
    false
  )
  assert.equal(
    outgoing.listeners("close").some((listener) => listener.name === "stop"),
    false
  )
})

test(
  "public native before-state long read keeps SSE alive and returns its complete RPC payload",
  { timeout: 30_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "orvanta-bc-state-stream-"))
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    const f = await stateFixture(),
      old = ToolService.prototype.readConfigurationBcBeforeState
    const payload = { readOnly: true, marker: "complete native before-state result" }
    ToolService.prototype.readConfigurationBcBeforeState = async () => {
      await new Promise((resolve) => setTimeout(resolve, 16_500))
      return JSON.stringify(payload)
    }
    const server = await startHttpServer(new MockBackend(), 0, root),
      client = new Client({ name: "bc-state-long-stream", version: "r54" }),
      captured: Promise<string>[] = []
    t.after(async () => {
      await client.close()
      await server.closeIfIdle()
      ToolService.prototype.readConfigurationBcBeforeState = old
      await rm(root, { recursive: true, force: true })
    })
    const observe: typeof fetch = async (input, init) => {
      const response = await fetch(input, init)
      if (
        typeof init?.body === "string" &&
        init.body.includes('"read_configuration_bc_before_state"')
      )
        captured.push(response.clone().text())
      return response
    }
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.mcpUrl), { fetch: observe }) as Parameters<
        Client["connect"]
      >[0]
    )
    const result = await client.callTool(
      { name: "read_configuration_bc_before_state", arguments: f.input },
      undefined,
      { timeout: 25_000 }
    )
    assert.equal(!!result.isError, false)
    const content = result.content
    assert.ok(Array.isArray(content))
    assert.equal(content[0]?.type, "text")
    assert.deepEqual(JSON.parse((content[0] as { text: string }).text), payload)
    assert.equal(captured.length, 1)
    const wire = await captured[0]!
    assert.match(wire, /: keep-alive\n\n/)
    assert.match(wire, /complete native before-state result/)
  }
)

test(
  "public native guard long read keeps SSE alive and returns its complete RPC payload",
  { timeout: 30_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "orvanta-bc-guard-stream-"))
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    const f = await stateFixture()
    const old = ToolService.prototype.readConfigurationBcGuard
    const payload = { readOnly: true, marker: "complete native guard result" }
    const {
      connectionId,
      bcSetId,
      version,
      nativeSourceVersion,
      nativeTargetVersion,
      nativeMetadataVersion
    } = f.input
    const input = {
      connectionId,
      bcSetId,
      version,
      nativeSourceVersion,
      nativeTargetVersion,
      nativeMetadataVersion
    }
    ToolService.prototype.readConfigurationBcGuard = async () => {
      await new Promise((resolve) => setTimeout(resolve, 16_500))
      return JSON.stringify(payload)
    }
    const server = await startHttpServer(new MockBackend(), 0, root)
    const client = new Client({ name: "bc-guard-long-stream", version: "m1" })
    const captured: Promise<string>[] = []
    t.after(async () => {
      await client.close()
      await server.closeIfIdle()
      ToolService.prototype.readConfigurationBcGuard = old
      await rm(root, { recursive: true, force: true })
    })
    const observe: typeof fetch = async (url, init) => {
      const response = await fetch(url, init)
      if (typeof init?.body === "string" && init.body.includes('"read_configuration_bc_guard"'))
        captured.push(response.clone().text())
      return response
    }
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.mcpUrl), { fetch: observe }) as Parameters<
        Client["connect"]
      >[0]
    )
    const result = await client.callTool(
      { name: "read_configuration_bc_guard", arguments: input },
      undefined,
      { timeout: 25_000 }
    )
    assert.equal(!!result.isError, false)
    assert.ok(Array.isArray(result.content))
    assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), payload)
    assert.equal(captured.length, 1)
    const wire = await captured[0]!
    assert.match(wire, /: keep-alive\n\n/)
    assert.match(wire, /complete native guard result/)
  }
)

test(
  "public BC apply, recover and reconcile keep SSE alive and return complete RPC payloads",
  { timeout: 30_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "orvanta-bc-command-stream-"))
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    const prototype = ToolService.prototype
    const oldApply = prototype.applyConfigurationBcSet
    const oldRecover = prototype.recoverConfigurationBcSet
    const oldReconcile = prototype.reconcileConfigurationBcExecution
    const delayed = (command: string) => async () => {
      await new Promise((resolve) => setTimeout(resolve, 16_500))
      return JSON.stringify({ marker: `complete ${command} RPC result` })
    }
    prototype.applyConfigurationBcSet = delayed("apply")
    prototype.recoverConfigurationBcSet = delayed("recover")
    prototype.reconcileConfigurationBcExecution = delayed("reconcile")
    const server = await startHttpServer(new MockBackend(), 0, root)
    const client = new Client({ name: "bc-command-long-stream", version: "m1" })
    const captured: Promise<string>[] = []
    t.after(async () => {
      await client.close()
      await server.closeIfIdle()
      prototype.applyConfigurationBcSet = oldApply
      prototype.recoverConfigurationBcSet = oldRecover
      prototype.reconcileConfigurationBcExecution = oldReconcile
      await rm(root, { recursive: true, force: true })
    })
    const observe: typeof fetch = async (url, init) => {
      const response = await fetch(url, init)
      if (typeof init?.body === "string" && init.body.includes('"method":"tools/call"'))
        captured.push(response.clone().text())
      return response
    }
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.mcpUrl), { fetch: observe }) as Parameters<
        Client["connect"]
      >[0]
    )
    const input = {
      connectionId: "w200",
      bcSetId: "EHS_CUNI_KNM",
      version: "N",
      requestNumber: "GR2K923429",
      taskNumber: "GR2K923430",
      operationId: "bc-stream-0001",
      beforeStateReference: "a".repeat(64),
      effectsReference: "b".repeat(64)
    }
    const acknowledgements = {
      acknowledgeConfigurationWrite: true,
      acknowledgeIndependentProtocol: true,
      acknowledgeLocalActivationLinks: true
    }
    const calls = [
      {
        name: "apply_configuration_bc_set",
        arguments: { ...input, ...acknowledgements, acknowledgeCtsRecording: true }
      },
      {
        name: "recover_configuration_bc_set",
        arguments: {
          ...input,
          ...acknowledgements,
          applyOperationId: "bc-stream-apply-0001",
          applyReceiptHash: "c".repeat(64),
          acknowledgeCtsKeyCleanup: true
        }
      },
      {
        name: "reconcile_configuration_bc_execution",
        arguments: { ...input, command: "apply", expectedReceiptHash: "c".repeat(64) }
      }
    ]
    const results = await Promise.all(
      calls.map((call) => client.callTool(call, undefined, { timeout: 25_000 }))
    )
    for (const [index, command] of ["apply", "recover", "reconcile"].entries()) {
      const result = results[index]!
      assert.equal(!!result.isError, false)
      assert.ok(Array.isArray(result.content))
      assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), {
        marker: `complete ${command} RPC result`
      })
    }
    assert.equal(captured.length, 3)
    for (const wire of await Promise.all(captured)) {
      assert.match(wire, /: keep-alive\n\n/)
      assert.match(wire, /complete (apply|recover|reconcile) RPC result/)
    }
  }
)
