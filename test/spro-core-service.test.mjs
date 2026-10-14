import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { resolve } from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"
import {
  assertPortAvailable,
  inspectDelivery,
  startService
} from "../scripts/spro-core-service.mjs"

const manifestFile = resolve(process.env.SPRO_CORE_SERVICE_DELIVERY ?? "")
assert.ok(process.env.SPRO_CORE_SERVICE_DELIVERY, "Set SPRO_CORE_SERVICE_DELIVERY")
const pinned = JSON.parse((await readFile(manifestFile, "utf8")).replace(/^\uFEFF/, ""))
const evidence = resolve(".cache/spro-core-m1-service-tests", randomUUID())
await mkdir(evidence, { recursive: true })
const jsonFile = async (name, value) => {
  const file = resolve(evidence, name)
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" })
  return file
}
async function reservePort() {
  const socket = createServer()
  await new Promise((done, reject) => {
    socket.once("error", reject)
    socket.listen(0, "127.0.0.1", done)
  })
  return socket
}
const closePort = (socket) => new Promise((done) => socket.close(done))
const invokeCli = (file, mode) =>
  new Promise((done, reject) => {
    const child = spawn(process.execPath, ["scripts/spro-core-service.mjs", file, mode], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    })
    let output = ""
    child.stdout.on("data", (part) => {
      output += part
    })
    child.stderr.on("data", (part) => {
      output += part
    })
    child.once("error", reject)
    child.once("exit", (code) => done({ code, output }))
  })

test("ordinary core entry preserves the artifact, roots and history without SAP", async (t) => {
  const inspection = await inspectDelivery(manifestFile)
  let mockCalls = 0,
    closeCalls = 0
  let entered, unblock
  const started = new Promise((done) => {
    entered = done
  })
  const gate = new Promise((done) => {
    unblock = done
  })
  const mock = new Proxy(
    {
      connectionIds: () => ["w200"],
      connectionDetails: () => inspection.connections[0],
      close: async () => {
        closeCalls++
      }
    },
    {
      get(target, name) {
        if (name in target) return target[name]
        return async () => {
          mockCalls++
          entered()
          await gate
          throw Error("OFFLINE_BACKEND_REJECTED")
        }
      }
    }
  )
  let service, client
  try {
    await t.test(
      "checks all frozen files and completed/unknown history before opening a service",
      async () => {
        assert.equal(inspection.runtime.status, "observed")
        assert.equal(inspection.delivery.receipts.length, 3)
        assert.equal(inspection.delivery.receipts.at(-1).status, "failed")
        assert.equal(inspection.delivery.receipts.at(-1).outcomeMayBeUnknown, true)
        const result = await invokeCli(manifestFile, "--check")
        assert.equal(result.code, 0, result.output)
        assert.equal(JSON.parse(result.output).serviceStarted, false)
      }
    )
    await t.test("an empty replacement receipt root or BC root cannot bypass history", async () => {
      const empty = resolve(evidence, "empty-state")
      await mkdir(empty)
      for (const key of ["stateRoot", "bcStateRoot"]) {
        const file = await jsonFile(`wrong-${key}.json`, { ...pinned, [key]: empty })
        await assert.rejects(inspectDelivery(file), { code: "ENOENT" })
      }
    })
    await t.test(
      "fingerprint and reference pins fail closed without editing any historical file",
      async () => {
        for (const [name, change] of [
          ["fingerprint", { expectedArtifactFingerprint: "0".repeat(64) }],
          ["reference", { references: [{ ...pinned.references[0], before: "0".repeat(64) }] }]
        ]) {
          const file = await jsonFile(`wrong-${name}.json`, { ...pinned, ...change })
          await assert.rejects(inspectDelivery(file))
        }
      }
    )
    await t.test(
      "an occupied port rejects both the precheck and real listen, preserving its owner",
      async () => {
        const owner = await reservePort()
        const port = owner.address().port
        try {
          await assert.rejects(assertPortAvailable(port), { code: "EADDRINUSE" })
          await assert.rejects(
            startService(
              {
                ...inspection,
                delivery: { ...pinned, port }
              },
              mock
            ),
            { code: "EADDRINUSE" }
          )
          assert.equal(owner.listening, true)
        } finally {
          await closePort(owner)
        }
      }
    )
    await t.test("redirected startup refuses a password prompt without opening MCP", async () => {
      const reservation = await reservePort()
      const port = reservation.address().port
      await closePort(reservation)
      const file = await jsonFile("no-terminal.json", { ...pinned, port })
      const result = await invokeCli(file, "--serve")
      assert.equal(result.code, 1, result.output)
      assert.match(result.output, /SPRO_CORE_ENTRY_REJECTED/)
      await assertPortAvailable(port)
    })
    await t.test(
      "the public endpoint has exact frozen schemas and the original three receipts",
      async () => {
        const reservation = await reservePort()
        const port = reservation.address().port
        await closePort(reservation)
        service = await startService({ ...inspection, delivery: { ...pinned, port } }, mock)
        assert.equal(service.observation.toolCount, 32)
        assert.equal(service.observation.sapCalls, 0)
        assert.equal(mockCalls, 0, "Ordinary startup must not probe SAP")
        assert.equal(process.env.ABAP_MCP_STATE_DIR, pinned.stateRoot)
        assert.equal(process.env.ABAP_MCP_EXPORT_ROOT, pinned.bcStateRoot)
        assert.deepEqual(service.observation.receipts, pinned.receipts)
        const require = createRequire(resolve(pinned.candidate, "app/package.json"))
        const { Client } = await import(
          pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js"))
        )
        const { StreamableHTTPClientTransport } = await import(
          pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"))
        )
        client = new Client({ name: "ordinary-core-entry-offline-test", version: "1" })
        await client.connect(new StreamableHTTPClientTransport(new URL(service.mcpUrl)))
        await jsonFile("public-local-observation.json", service.observation)
      }
    )
    await t.test("public invalid writes are rejected before backend dispatch", async () => {
      for (const name of [
        "apply_configuration_unit_text",
        "apply_configuration_number_range",
        "apply_configuration_bc_set",
        "recover_configuration_bc_set"
      ]) {
        const result = await client.callTool({ name, arguments: { connectionId: "w200" } })
        assert.equal(result.isError, true)
      }
      assert.equal(mockCalls, 0)
      const withheld = await client.callTool({
        name: "release_write_operation_lock",
        arguments: { connectionId: "w200" }
      })
      assert.equal(withheld.isError, true)
      assert.equal(mockCalls, 0)
    })
    await t.test(
      "stop refuses an active command, keeps serving and closes only after completion",
      async () => {
        const pending = client.callTool({
          name: "read_configuration_unit",
          arguments: { connectionId: "w200", unitKey: "KG", language: "ZH" }
        })
        await Promise.race([
          started,
          new Promise((_done, reject) => {
            const timer = setTimeout(() => reject(Error("Mock dispatch never started")), 10000)
            timer.unref()
          })
        ])
        const before = closeCalls
        await assert.rejects(service.closeIfIdle(), /MCP_BUSY/)
        assert.equal(closeCalls, before)
        const runtime = await client.callTool({
          name: "get_runtime_info",
          arguments: { expectedVersion: pinned.version }
        })
        assert.notEqual(runtime.isError, true)
        unblock()
        assert.equal((await pending).isError, true)
        await client.close()
        client = undefined
        const endpoint = service.mcpUrl
        await service.closeIfIdle()
        service = undefined
        assert.equal(closeCalls, before + 1)
        await assert.rejects(fetch(endpoint.replace("/mcp", "/health")))
      }
    )
    await inspectDelivery(manifestFile)
    await jsonFile("summary.json", {
      status: "Passed",
      sapCalls: 0,
      mockDispatches: mockCalls,
      writeCalls: 0,
      formalServiceStarted: false,
      sharedServiceChanged: false,
      pinnedHistoricalFilesPreserved: true,
      stoppedWithCloseIfIdle: true
    })
  } finally {
    unblock()
    await client?.close()
    await service?.closeIfIdle()
  }
  console.log(`SPRO_CORE_SERVICE_EVIDENCE=${evidence}`)
})
