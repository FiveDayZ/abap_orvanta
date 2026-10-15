#!/usr/bin/env node
// Ordinary MCP entry: reuse the approved artifact and existing stores, never an acceptance driver.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, realpath, stat } from "node:fs/promises"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { createInterface } from "node:readline"
import { Writable } from "node:stream"
import { fileURLToPath, pathToFileURL } from "node:url"

const json = async (file) => JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""))
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")
const imported = (delivery, name) =>
  import(pathToFileURL(resolve(delivery.candidate, "app/dist/src", name)).href)

async function verifyFiles(directory, hashes) {
  const entries = Object.entries(hashes)
  for (let offset = 0; offset < entries.length; offset += 32)
    await Promise.all(
      entries.slice(offset, offset + 32).map(async ([name, expected]) => {
        const path = resolve(directory, name)
        const within = relative(directory, path)
        assert.ok(!isAbsolute(within) && within !== ".." && !within.startsWith(".." + sep))
        assert.equal(sha(await readFile(path)), expected, `Pinned file changed: ${name}`)
      })
    )
}

export async function inspectDelivery(file) {
  const delivery = await json(file)
  assert.equal(delivery.format, 1)
  assert.ok(Number.isInteger(delivery.port) && delivery.port >= 1024 && delivery.port <= 65535)
  for (const key of ["candidate", "stateRoot", "bcStateRoot", "connectionFile", "toolSurfaceFile"])
    assert.ok(isAbsolute(delivery[key]), `${key} must be absolute`)
  const buildFile = resolve(delivery.candidate, "BUILD-INFO.json")
  assert.equal(sha(await readFile(buildFile)), delivery.buildManifestSha256)
  const build = await json(buildFile)
  assert.equal(build.version, delivery.version)
  assert.equal(build.expectedArtifactFingerprint, delivery.expectedArtifactFingerprint)
  assert.equal(build.profile, "config")
  // The surface is whatever this candidate shipped as its contract. A second copy of the count here
  // rejected every candidate packaged from a wider surface while adding no check the contract does
  // not already make, so the contract stays the single source of truth.
  const contractFile = resolve(delivery.candidate, "SPRO-CORE.json")
  assert.ok(
    await stat(contractFile).then(
      () => true,
      () => false
    ),
    `SPRO-CORE.json is missing from ${delivery.candidate}: repackage the candidate with the current contract`
  )
  const contract = await json(contractFile)
  assert.equal(contract.format, 1)
  assert.deepEqual(
    build.requiredTools,
    contract.requiredTools,
    "BUILD-INFO tool surface differs from the shipped SPRO-CORE.json contract"
  )
  // Both files carry the formal acceptance status as well, and until 2026-10-15 only the tool surface
  // was compared. The packager wrote "pending" into BUILD-INFO while copying the contract verbatim as
  // SPRO-CORE.json, so a candidate whose contract said the service was accepted would still ship a
  // BUILD-INFO saying it was pending - the exact disagreement this function exists to reject, and one
  // that would appear the moment the status in the contract changed. The packager now reads the value
  // from the contract, so this comparison is defence in depth against a hand-edited BUILD-INFO rather
  // than the primary guard.
  assert.equal(
    build.formalServiceAcceptance,
    contract.formalServiceAcceptance,
    "BUILD-INFO acceptance status differs from the shipped SPRO-CORE.json contract"
  )
  assert.equal(new Set(build.requiredTools).size, build.requiredTools.length)
  assert.equal(sha(await readFile(build.nodeExecutable)), build.nodeExecutableSha256)
  assert.equal(await realpath(process.execPath), await realpath(build.nodeExecutable))
  assert.equal(
    await realpath(resolve(delivery.candidate, "app/node_modules")),
    await realpath(build.dependencyRoot)
  )
  assert.equal(
    sha(await readFile(build.externalDependencyManifest)),
    delivery.dependencyManifestSha256
  )
  const dependencies = await json(build.externalDependencyManifest)
  await verifyFiles(delivery.candidate, build.fileSha256)
  await verifyFiles(dirname(build.externalDependencyManifest), dependencies.fileSha256)
  for (const key of ["stateRoot", "bcStateRoot"]) {
    assert.ok((await stat(delivery[key])).isDirectory(), `${key} must already exist`)
    await verifyFiles(delivery[key], delivery.preservedFiles[key])
  }
  assert.notEqual(await realpath(delivery.stateRoot), await realpath(delivery.bcStateRoot))
  assert.equal(sha(await readFile(delivery.connectionFile)), delivery.connectionSha256)
  assert.equal(sha(await readFile(delivery.toolSurfaceFile)), delivery.toolSurfaceSha256)
  const { loadConnections } = await imported(delivery, "config.js")
  const connections = await loadConnections(delivery.connectionFile)
  assert.equal(connections.length, 1)
  const connection = connections[0]
  assert.deepEqual(
    [connection.id, connection.client, connection.username.toUpperCase(), connection.language],
    ["w200", "200", "WYS", "ZH"]
  )
  const { RuntimeIdentity } = await imported(delivery, "runtime-info.js")
  const runtime = await new RuntimeIdentity().report({
    expectedVersion: delivery.version,
    expectedArtifactFingerprint: delivery.expectedArtifactFingerprint
  })
  assert.equal(runtime.status, "observed")
  assert.equal(runtime.restartRequired, false)
  const { isFetchBlockedPort } = await imported(delivery, "http.js")
  assert.equal(isFetchBlockedPort(delivery.port), false)
  const { WriteOperationReceiptStore } = await imported(delivery, "write-operation-receipts.js")
  const receipts = new WriteOperationReceiptStore(delivery.stateRoot)
  for (const proof of delivery.receipts)
    assertReceipt(await receipts.status("w200", proof.operationId), proof)
  const { ConfigurationBcBeforeStateStore } = await imported(
    delivery,
    "configuration-bc-before-state-store.js"
  )
  const before = new ConfigurationBcBeforeStateStore(delivery.bcStateRoot)
  for (const references of delivery.references) {
    await before.read(references.before, delivery.binding)
    const effects = await before.readEffects(references.effects, delivery.binding)
    assert.equal(effects.beforeStateReference, references.before)
  }
  const { ConfigurationBcExecutionStore } = await imported(
    delivery,
    "configuration-bc-execution-store.js"
  )
  const executions = new ConfigurationBcExecutionStore(delivery.bcStateRoot)
  for (const proof of delivery.executions)
    for (const kind of ["intent", "result"])
      await executions.readAuthenticated(proof.operationHash, delivery.binding.user, kind)
  return { delivery, build, connections, runtime }
}

function assertReceipt(actual, proof) {
  for (const key of ["status", "receiptHash", "outcomeMayBeUnknown", "localLockReleased"])
    assert.equal(actual[key], proof[key], `${proof.operationId}: ${key} changed`)
  assert.equal(actual.automaticRetry, false)
  assert.equal(actual.automaticRollback, false)
}

// Check before prompting; the real listen also rejects a race without touching the current owner.
export async function assertPortAvailable(port) {
  const listener = createServer()
  await new Promise((done, reject) => {
    listener.once("error", reject)
    listener.listen(port, "127.0.0.1", done)
  })
  await new Promise((done, reject) => listener.close((error) => (error ? reject(error) : done())))
}

export async function observeService(inspection, endpoint) {
  const { delivery, build } = inspection
  assert.equal(endpoint, `http://127.0.0.1:${delivery.port}/mcp`)
  const require = createRequire(resolve(delivery.candidate, "app/package.json"))
  const { Client } = await import(
    pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js"))
  )
  const { StreamableHTTPClientTransport } = await import(
    pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"))
  )
  const client = new Client({ name: "spro-core-service-local-identity", version: "1" })
  const call = async (name, arguments_) => {
    const result = await client.callTool({ name, arguments: arguments_ }, undefined, {
      timeout: 10000
    })
    assert.notEqual(result.isError, true, `Local observation failed: ${name}`)
    return JSON.parse(result.content.find((part) => part.type === "text").text)
  }
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)), { timeout: 10000 })
    const tools = []
    let cursor
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 10000 })
      tools.push(...page.tools)
      cursor = page.nextCursor
    } while (cursor)
    const ordered = (items) => [...items].sort((a, b) => a.name.localeCompare(b.name))
    assert.deepEqual(ordered(tools), ordered(await json(delivery.toolSurfaceFile)))
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [...build.requiredTools].sort())
    for (const tool of tools) {
      assert.equal(tool.inputSchema.additionalProperties, false)
      assert.equal(typeof tool.annotations?.readOnlyHint, "boolean")
    }
    const runtime = await call("get_runtime_info", {
      expectedVersion: delivery.version,
      expectedArtifactFingerprint: delivery.expectedArtifactFingerprint
    })
    assert.equal(runtime.status, "observed")
    for (const key of [
      "expectedVersion",
      "expectedArtifact",
      "diskSinceStartup",
      "moduleAndPackageVersion"
    ])
      assert.equal(runtime.checks[key], "match")
    assert.equal(runtime.restartRequired, false)
    assert.equal(runtime.toolProfile.profile, build.profile)
    assert.equal(runtime.toolProfile.enabledCount, 32)
    const receipts = []
    for (const proof of delivery.receipts) {
      const result = await call("get_write_operation_status", {
        connectionId: "w200",
        operationId: proof.operationId
      })
      assertReceipt(result, proof)
      receipts.push({ operationId: proof.operationId, ...proof })
    }
    return { runtime, toolCount: tools.length, receipts, sapCalls: 0, writeCalls: 0 }
  } finally {
    await client.close()
  }
}

export async function startService(inspection, backend) {
  const { delivery, build } = inspection
  const { TOOL_NAMES } = await imported(delivery, "tool-registry.js")
  const environment = {
    ABAP_MCP_STATE_DIR: delivery.stateRoot,
    ABAP_MCP_EXPORT_ROOT: delivery.bcStateRoot,
    ABAP_MCP_TOOL_PROFILE: build.profile,
    ABAP_MCP_TOOL_DENY: TOOL_NAMES.filter((name) => !build.requiredTools.includes(name)).join(",")
  }
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]])
  )
  const restore = () => {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
  }
  Object.assign(process.env, environment)
  let server
  try {
    const { startHttpServer } = await imported(delivery, "http.js")
    server = await startHttpServer(backend, delivery.port, delivery.stateRoot)
    const observation = await observeService(inspection, server.mcpUrl)
    return {
      mcpUrl: server.mcpUrl,
      observation,
      async closeIfIdle() {
        await server.closeIfIdle()
        restore()
      }
    }
  } catch (error) {
    try {
      if (server) {
        // A caller may have reached this new listener before its startup observation failed.
        // Keep credentials and the owner alive until the command ends; never terminate a write.
        for (;;) {
          try {
            await server.closeIfIdle()
            break
          } catch (closeError) {
            if (closeError.message !== "MCP_BUSY") throw closeError
            console.error("MCP_BUSY: startup rejected; awaiting the active command before closing.")
            await new Promise((done) => setTimeout(done, 1000))
          }
        }
      } else await backend.close()
    } finally {
      restore()
    }
    throw error
  }
}

async function promptPassword() {
  assert.ok(process.stdin.isTTY && process.stdout.isTTY, "An interactive terminal is required")
  const silent = new Writable({
    write(_chunk, _encoding, done) {
      done()
    }
  })
  const prompt = createInterface({
    input: process.stdin,
    output: silent,
    terminal: true,
    historySize: 0
  })
  process.stdout.write("SAP password for WYS@w200/200 (process memory only): ")
  try {
    const password = await new Promise((done, reject) => {
      prompt.once("SIGINT", () => reject(Error("LOGIN_CANCELLED")))
      prompt.once("close", () => reject(Error("LOGIN_CANCELLED")))
      prompt.question("", done)
    })
    assert.ok(password.length > 0, "Password cannot be empty")
    return password
  } finally {
    prompt.close()
    process.stdout.write("\n")
  }
}

async function main() {
  const [file, mode, ...extra] = process.argv.slice(2)
  assert.ok(
    file && ["--check", "--serve", "--observe"].includes(mode) && !extra.length,
    "Usage: spro-core-service.mjs <delivery.json> <--check|--serve|--observe>"
  )
  const inspection = await inspectDelivery(file)
  if (mode === "--check") {
    console.log(
      JSON.stringify({ status: "Passed", mode, tools: 32, sapCalls: 0, serviceStarted: false })
    )
    return
  }
  if (mode === "--observe") {
    console.log(
      JSON.stringify(
        await observeService(inspection, `http://127.0.0.1:${inspection.delivery.port}/mcp`),
        null,
        2
      )
    )
    return
  }
  await assertPortAvailable(inspection.delivery.port)
  let password = await promptPassword()
  const { AdtBackend } = await imported(inspection.delivery, "adt-backend.js")
  let service
  try {
    service = await startService(inspection, new AdtBackend(inspection.connections, () => password))
  } catch (error) {
    password = undefined
    throw error
  }
  const pinnedTools = inspection.build.requiredTools.length
  console.log(
    `ORVANTA core: ${service.mcpUrl}; ${pinnedTools} pinned tools. Enter stop to close when idle.`
  )
  console.log("KG historical failed/unknown protection retained; no SAP call has run at startup.")
  const consoleInput = createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 0
  })
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    try {
      await service.closeIfIdle()
      password = undefined
      consoleInput.close()
      process.off("SIGTERM", stop)
      process.off("SIGINT", stop)
      console.log("Service closed; temporary password cleared.")
      // closeIfIdle already proved command completion and closed the backend.
      // End this owner process too, so cached ADT credentials cannot outlive the service.
      process.exit(0)
    } catch (error) {
      stopping = false
      console.error(
        error.message === "MCP_BUSY"
          ? "MCP_BUSY: operation still running; service retained. Reconcile before retrying stop."
          : "SERVICE_CLOSE_FAILED: service retained; inspect before retrying stop."
      )
    }
  }
  consoleInput.on("line", (line) => {
    if (line.trim().toLowerCase() === "stop") void stop()
  })
  consoleInput.on("SIGINT", () => void stop())
  consoleInput.on("close", () => {
    if (!stopping) void stop()
  })
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main().catch((error) => {
    // Never print raw configuration, transport diagnostics, or a caller's password.
    const code = ["EADDRINUSE", "ENOENT", "LOGIN_CANCELLED"].includes(error.code ?? error.message)
      ? (error.code ?? error.message)
      : "PIN_OR_ENTRY_CHECK_FAILED"
    console.error(
      `SPRO_CORE_ENTRY_REJECTED (${code}): inspect pinned files, state roots and port; no retry performed.`
    )
    process.exitCode = 1
  })
