import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createServer, request as httpRequest } from "node:http"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { startSettingsServer } from "../src/settings-server.js"
import { AdtBackend } from "../src/adt-backend.js"
import { parseConnections } from "../src/config.js"
import { TOOL_COUNT, TOOL_NAMES } from "../src/tool-registry.js"
import { listenOnUnblockedPort } from "./loopback-port.js"
import { MockBackend } from "./mock-backend.js"
import type { ConnectionConfig } from "../src/config.js"

const connection = {
  id: "w200",
  url: "https://sap.example.invalid",
  client: "200",
  language: "EN",
  username: "VALIDATION",
  passwordEnv: "ABAP_MCP_TEST_UI",
  allowUnauthorized: false,
  remoteFunctionAllowlist: []
}

async function fixture(
  factory: (connections: ConnectionConfig[]) => MockBackend = () => new MockBackend()
) {
  const root = await mkdtemp(join(tmpdir(), "abap-settings-"))
  const configPath = join(root, "connections.json")
  await writeFile(configPath, JSON.stringify({ connections: [connection] }))
  const server = await startSettingsServer({
    configPath,
    assetsPath: resolve("ui"),
    stateRoot: join(root, "state"),
    port: 0,
    backendFactory: factory
  })
  const authorization = `Bearer ${new URL(server.url).hash.slice(1)}`
  const request = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(server.origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: authorization,
        Origin: server.origin,
        "Content-Type": "application/json",
        ...headers
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    return { status: response.status, body: await response.json() }
  }
  return {
    ...server,
    root,
    configPath,
    request,
    cleanup: async () => {
      await server.close()
      await rm(root, { recursive: true, force: true })
    }
  }
}

test("settings protects every API, refuses cross-origin and host spoofing, and serves local assets", async () => {
  const fixtureData = await fixture()
  const { request, origin } = fixtureData
  try {
    assert.equal((await fetch(origin + "/api/state")).status, 401)
    assert.equal(
      (await request("/api/state", undefined, { Origin: "https://untrusted.invalid" })).status,
      403
    )
    const spoofedHostStatus = await new Promise<number | undefined>((done, reject) => {
      const req = httpRequest(
        origin + "/api/state",
        { headers: { Host: "untrusted.invalid" } },
        (response) => {
          response.resume()
          done(response.statusCode)
        }
      )
      req.on("error", reject)
      req.end()
    })
    assert.equal(spoofedHostStatus, 403)
    assert.equal((await request("/api/config", {}, { Origin: "" })).status, 403)
    assert.equal((await request("/api/config", {}, { "Content-Type": "text/plain" })).status, 403)
    const page = await fetch(origin)
    assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/)
    assert.match(await page.text(), /连接配置/)
    assert.equal((await fetch(origin + "/icons/server.svg")).status, 200)
    assert.equal((await fetch(origin + "/icons/LICENSE")).status, 401)
    assert.equal(
      (await request("/api/password", { connectionId: "w200", password: "x".repeat(140_000) }))
        .status,
      413
    )
  } finally {
    await fixtureData.cleanup()
  }
})

test("settings persists config without secrets, rejects stale revisions and invalid inputs, and binds credentials to saved settings", async () => {
  const f = await fixture()
  try {
    const initial = (await f.request("/api/state")).body
    assert.equal(
      (await f.request("/api/password", { connectionId: "w200", password: "secret-test-value" }))
        .status,
      200
    )
    const publicState = (await f.request("/api/state")).body
    assert.deepEqual(publicState.credentials, ["w200"])
    assert.ok(!JSON.stringify(publicState).includes("secret-test-value"))
    assert.ok(!(await readFile(f.configPath, "utf8")).includes("secret-test-value"))
    for (const changed of [
      { ...connection, url: "file:///tmp/sap" },
      { ...connection, url: "https://user:secret@sap.example.invalid" },
      { ...connection, password: "must-not-save" },
      { ...connection, client: "2" },
      { ...connection, remoteFunctionAllowlist: ["RFC_READ_TABLE"] }
    ]) {
      assert.equal(
        (await f.request("/api/config", { revision: initial.revision, connections: [changed] }))
          .status,
        400
      )
    }
    const changed = { ...connection, username: "OTHER" }
    const saved = await f.request("/api/config", {
      revision: initial.revision,
      connections: [changed]
    })
    assert.equal(saved.status, 200)
    assert.deepEqual(saved.body.state.credentials, [])
    assert.equal(
      (await f.request("/api/config", { revision: initial.revision, connections: [] })).status,
      409
    )
    assert.equal(
      (await f.request("/api/password", { connectionId: "w200", password: "second-secret" }))
        .status,
      200
    )
    await writeFile(
      f.configPath,
      JSON.stringify({ connections: [{ ...changed, url: "https://other.invalid" }] })
    )
    assert.deepEqual((await f.request("/api/state")).body.credentials, [])
    assert.equal((await f.request("/api/test", { connectionId: "w200" })).status, 400)
    const current = (await f.request("/api/state")).body
    assert.equal(
      (await f.request("/api/config", { revision: current.revision, connections: [] })).status,
      200
    )
    assert.deepEqual((await f.request("/api/state")).body.connections, [])
    assert.equal((await f.request("/api/start", { port: 14860 })).status, 400)
  } finally {
    await f.cleanup()
  }
})

test("settings leaves malformed configuration untouched and reports a recovery message", async () => {
  const f = await fixture()
  try {
    await writeFile(f.configPath, "{invalid")
    const result = await f.request("/api/state")
    assert.equal(result.status, 200)
    assert.match(result.body.configIssue, /原文件未修改/)
    assert.equal((await f.request("/api/config", { revision: "", connections: [] })).status, 500)
    assert.equal(await readFile(f.configPath, "utf8"), "{invalid")
  } finally {
    await f.cleanup()
  }
})

test("settings starts only selected connections and allows deleting an unused connection while running", async () => {
  let received: ConnectionConfig[] = []
  const f = await fixture((connections) => {
    received = connections
    return new MockBackend()
  })
  const listener = createServer()
  await listenOnUnblockedPort(listener)
  const address = listener.address()
  assert.ok(address && typeof address !== "string")
  const port = address.port
  await new Promise<void>((done) => listener.close(() => done()))
  try {
    const connections = [connection, { ...connection, id: "w300" }, { ...connection, id: "w800" }]
    await writeFile(f.configPath, JSON.stringify({ connections }))
    await f.request("/api/password", { connectionId: "w200", password: "only-w200" })
    for (const ids of [[], ["missing"], ["w200", "w200"], ["w200", "w300"]]) {
      assert.equal((await f.request("/api/start", { port, connectionIds: ids })).status, 400)
    }
    const started = await f.request("/api/start", { port, connectionIds: ["w200"] })
    assert.equal(started.status, 200)
    assert.deepEqual(
      received.map((item) => item.id),
      ["w200"]
    )
    assert.deepEqual(started.body.state.service.connectionIds, ["w200"])
    const deleted = await f.request("/api/config", {
      revision: started.body.state.revision,
      connections: [connection, connections[2]]
    })
    assert.equal(deleted.status, 200)
    assert.deepEqual(
      deleted.body.state.connections.map((item: ConnectionConfig) => item.id),
      ["w200", "w800"]
    )
    assert.deepEqual(deleted.body.state.credentials, ["w200"])
    assert.equal(deleted.body.state.service.running, true)
    assert.equal(
      (
        await f.request("/api/config", {
          revision: deleted.body.state.revision,
          connections: [connections[2]]
        })
      ).status,
      409
    )
    assert.equal((await f.request("/api/stop", {})).status, 200)
    assert.deepEqual((await f.request("/api/state")).body.service.connectionIds, [])
  } finally {
    await f.cleanup()
  }
})

test("settings legacy start includes only credential-ready connections; deleting the last connection clears credentials", async () => {
  let received: ConnectionConfig[] = []
  const f = await fixture((connections) => {
    received = connections
    return new MockBackend()
  })
  const listener = createServer()
  await listenOnUnblockedPort(listener)
  const address = listener.address()
  assert.ok(address && typeof address !== "string")
  await new Promise<void>((done) => listener.close(() => done()))
  try {
    await writeFile(
      f.configPath,
      JSON.stringify({ connections: [connection, { ...connection, id: "w300" }] })
    )
    await f.request("/api/password", { connectionId: "w200", password: "only-w200" })
    const started = await f.request("/api/start", { port: address.port })
    assert.equal(started.status, 200)
    assert.deepEqual(
      received.map((item) => item.id),
      ["w200"]
    )
    await f.request("/api/stop", {})
    const current = (await f.request("/api/state")).body
    const deleted = await f.request("/api/config", { revision: current.revision, connections: [] })
    assert.equal(deleted.status, 200)
    assert.deepEqual(deleted.body.state.credentials, [])
    assert.deepEqual(deleted.body.state.connections, [])
    assert.equal(
      (await f.request("/api/password", { connectionId: "w200", password: "unused" })).status,
      404
    )
  } finally {
    await f.cleanup()
  }
})

test("settings separates ADT login failure from a missing helper without exposing backend errors", async () => {
  const backend = new MockBackend()
  backend.discoverySnapshot = async () => {
    throw new Error("internal-memory-secret")
  }
  const f = await fixture(() => backend)
  try {
    await f.request("/api/password", { connectionId: "w200", password: "test-only" })
    const result = await f.request("/api/test", { connectionId: "w200" })
    assert.equal(result.status, 200)
    assert.deepEqual(result.body.result, { adt: false, helper: true })
    assert.ok(!JSON.stringify(result.body).includes("internal-memory-secret"))
  } finally {
    await f.cleanup()
  }
})

test("settings controls its own MCP service, refuses occupied ports and protects in-flight MCP requests", async () => {
  let releaseDiscovery: (() => void) | undefined
  let enteredDiscovery: (() => void) | undefined
  const entered = new Promise<void>((done) => {
    enteredDiscovery = done
  })
  const backend = new MockBackend()
  const originalDiscovery = backend.discoverySnapshot.bind(backend)
  backend.discoverySnapshot = async (id) => {
    enteredDiscovery!()
    await new Promise<void>((done) => {
      releaseDiscovery = done
    })
    return originalDiscovery(id)
  }
  const f = await fixture(() => backend)
  const blocker = createServer((_, response) => response.end("unrelated"))
  await listenOnUnblockedPort(blocker)
  const address = blocker.address()
  assert.ok(address && typeof address !== "string")
  const port = address.port
  const client = new Client({ name: "settings-test", version: "1" })
  try {
    assert.equal((await f.request("/api/start", { port })).status, 400)
    await f.request("/api/password", { connectionId: "w200", password: "test-only" })
    for (const blocked of [1719, 2049, 4190, 6566, 6679]) {
      assert.equal((await f.request("/api/start", { port: blocked })).status, 400)
    }
    assert.equal((await f.request("/api/start", { port })).status, 409)
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), "unrelated")
    await new Promise<void>((done) => blocker.close(() => done()))
    const started = await f.request("/api/start", { port })
    assert.equal(started.status, 200)
    await client.connect(
      new StreamableHTTPClientTransport(new URL(started.body.state.service.url)) as Parameters<
        Client["connect"]
      >[0]
    )
    const listedTools = (await client.listTools()).tools
    assert.equal(listedTools.length, TOOL_COUNT)
    assert.deepEqual(listedTools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort())
    const withoutReadOnlyHint = listedTools
      .filter((tool) => tool.annotations?.readOnlyHint === undefined)
      .map((tool) => tool.name)
    assert.deepEqual(
      withoutReadOnlyHint,
      [],
      `tools registered without a registry annotation: ${withoutReadOnlyHint.join(", ")}`
    )
    assert.equal(
      (await f.request("/api/config", { revision: started.body.state.revision, connections: [] }))
        .status,
      409
    )
    assert.equal(
      (await f.request("/api/password", { connectionId: "w200", password: "changed" })).status,
      409
    )
    const pending = client
      .callTool({
        name: "get_capability_report",
        arguments: { connectionId: "w200" }
      })
      .then(
        () => "completed",
        () => "disconnected"
      )
    await entered
    assert.equal((await f.request("/api/stop", {})).status, 409)
    await client.close()
    assert.equal(await pending, "disconnected")
    assert.equal((await f.request("/api/stop", {})).status, 409)
    releaseDiscovery!()
    await f.request("/api/state")
    assert.equal((await f.request("/api/stop", {})).status, 200)
    assert.equal((await f.request("/api/state")).body.service.running, false)
  } finally {
    releaseDiscovery?.()
    await client.close()
    blocker.close()
    await f.cleanup()
  }
})

test("the settings password resolver is used by real SOAP HTTP requests without changing process environment", async () => {
  let authorization = ""
  const soap = createServer((request, response) => {
    authorization = String(request.headers.authorization)
    response.setHeader("Content-Type", "text/xml")
    response.end(
      "<Envelope><Body><EV_STATUS>S</EV_STATUS><EV_CODE>OK</EV_CODE><EV_MESSAGE>Ready</EV_MESSAGE><EV_VERSION>1.0</EV_VERSION></Body></Envelope>"
    )
  })
  await listenOnUnblockedPort(soap)
  const address = soap.address()
  assert.ok(address && typeof address !== "string")
  const config = parseConnections({
    connections: [{ ...connection, url: `http://127.0.0.1:${address.port}` }]
  })
  const old = process.env.ABAP_MCP_TEST_UI
  const backend = new AdtBackend(config, () => "memory-secret")
  try {
    assert.equal((await backend.callSapHelper("w200", { operation: "PING" })).status, "S")
    assert.equal(
      authorization,
      `Basic ${Buffer.from("VALIDATION:memory-secret").toString("base64")}`
    )
    assert.equal(process.env.ABAP_MCP_TEST_UI, old)
    const withoutPassword = new AdtBackend(config, () => undefined)
    await assert.rejects(
      withoutPassword.callSapHelper("w200", { operation: "PING" }),
      /Password environment variable/
    )
    await withoutPassword.close()
  } finally {
    await backend.close()
    await new Promise<void>((done) => soap.close(() => done()))
  }
})
