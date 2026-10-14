import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const candidate = resolve(process.env.SPRO_CORE_CANDIDATE ?? "")
assert.ok(process.env.SPRO_CORE_CANDIDATE, "Set SPRO_CORE_CANDIDATE to a prepared candidate")
const project = process.cwd()
const manifestPath = join(candidate, "BUILD-INFO.json")
const manifestBytes = await readFile(manifestPath)
const manifest = JSON.parse(manifestBytes)
const evidence = join(project, ".cache", "spro-core-delivery-tests", randomUUID())
await mkdir(evidence, { recursive: true })
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")
async function run(executable, args, cwd = project) {
  return await new Promise((done, reject) => {
    const child = spawn(executable, args, {
      cwd,
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
}
async function freePort() {
  const socket = createServer()
  await new Promise((done, reject) => {
    socket.once("error", reject)
    socket.listen(0, "127.0.0.1", done)
  })
  const port = socket.address().port
  await new Promise((done) => socket.close(done))
  return port
}

test("prepared SPRO candidate serves its pinned core over HTTP without SAP or shared runtime changes", async (t) => {
  const { TOOL_NAMES } = await import(
    pathToFileURL(join(candidate, "app/dist/src/tool-registry.js"))
  )
  const port = await freePort()
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith("ABAP_MCP_")) delete env[key]
  Object.assign(env, {
    ABAP_MCP_CONFIG: join(candidate, "connections.json"),
    ABAP_MCP_STATE_DIR: join(evidence, "state"),
    ABAP_MCP_EXPORT_ROOT: join(evidence, "exports"),
    ABAP_MCP_PORT: String(port),
    ABAP_MCP_TOOL_PROFILE: manifest.profile,
    ABAP_MCP_TOOL_DENY: TOOL_NAMES.filter((name) => !manifest.requiredTools.includes(name)).join(
      ","
    )
  })
  const service = spawn(
    join(candidate, "runtime/node.exe"),
    [join(candidate, "app/dist/src/index.js")],
    {
      cwd: candidate,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    }
  )
  let log = ""
  service.stdout.on("data", (part) => {
    log += part
  })
  service.stderr.on("data", (part) => {
    log += part
  })
  const exited = new Promise((done) => service.once("exit", done))
  const client = new Client({ name: "spro-core-candidate-contract-test", version: "1" })
  const endpoint = `http://127.0.0.1:${port}/mcp`
  const checker = join(candidate, "app/scripts/check-spro-core.mjs")
  try {
    const deadline = Date.now() + 30000
    let ready = false
    while (!ready && Date.now() < deadline) {
      assert.equal(service.exitCode, null, log)
      try {
        ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok
      } catch {}
      if (!ready) await new Promise((done) => setTimeout(done, 100))
    }
    assert.ok(ready, "Candidate did not listen")
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)))
    await writeFile(
      join(evidence, "public-tools.json"),
      JSON.stringify((await client.listTools()).tools, null, 2),
      { flag: "wx" }
    )
    await t.test(
      "pinned identity, exact 32-tool surface, strict schemas and annotations",
      async () => {
        const result = await run(process.execPath, [
          checker,
          endpoint,
          manifestPath,
          join(evidence, "runtime.json")
        ])
        assert.equal(result.code, 0, result.output)
        const report = JSON.parse(await readFile(join(evidence, "runtime.json"), "utf8"))
        assert.equal(report.status, "Passed")
        assert.equal(report.runtime.sapStatus, "not_probed")
        assert.equal(report.sapCalls, 0)
        assert.equal(report.tools.length, 32)
      }
    )
    await t.test(
      "incomplete writes, wrong scopes and extra parameters are rejected at the public boundary",
      async () => {
        const bc = {
          connectionId: "w200",
          bcSetId: "EHS_CUNI_KNM",
          version: "N",
          requestNumber: "GR2K923429",
          taskNumber: "GR2K923430",
          operationId: "core-contract-only",
          beforeStateReference: "a".repeat(64),
          effectsReference: "b".repeat(64),
          acknowledgeIndependentProtocol: true,
          acknowledgeLocalActivationLinks: true
        }
        const commands = {
          apply_configuration_unit_text: {
            connectionId: "w200",
            unitKey: "KG",
            language: "ZH",
            expectedReadFingerprint: "a".repeat(64),
            expectedTextVersion: "b".repeat(64),
            patch: { MSEHL: "contract only" },
            requestNumber: "GR2K923429",
            taskNumber: "GR2K923430",
            operationId: "core-contract-only"
          },
          apply_configuration_number_range: {
            connectionId: "w200",
            objectName: "ZORVCFGNR",
            expectedVersion: "a".repeat(64),
            action: "create",
            intervalNumber: "02",
            fromNumber: "00000000000000000201",
            toNumber: "00000000000000000300",
            external: false,
            operationId: "core-contract-only",
            acknowledgeLocalClientOnly: true
          },
          apply_configuration_bc_set: { ...bc, acknowledgeCtsRecording: true },
          recover_configuration_bc_set: {
            ...bc,
            applyOperationId: "original-contract-only",
            applyReceiptHash: "c".repeat(64),
            acknowledgeCtsKeyCleanup: true
          }
        }
        for (const [name, input] of Object.entries(commands)) {
          const omitted = await client.callTool({ name, arguments: input })
          assert.equal(omitted.isError, true, name)
          assert.match(JSON.stringify(omitted.content), /acknowledgeConfigurationWrite/)
          const extra = await client.callTool({
            name,
            arguments: { ...input, acknowledgeConfigurationWrite: true, save: true }
          })
          assert.equal(extra.isError, true, name)
          assert.match(JSON.stringify(extra.content), /save/)
          const wrongScope = await client.callTool({
            name,
            arguments: { ...input, acknowledgeConfigurationWrite: true, connectionId: "w300" }
          })
          assert.equal(wrongScope.isError, true, name)
          assert.match(JSON.stringify(wrongScope.content), /connectionId/)
        }
        const invalidRuntime = await client.callTool({
          name: "get_runtime_info",
          arguments: { save: true }
        })
        assert.equal(invalidRuntime.isError, true)
      }
    )
    await t.test(
      "generic RFC, CTS cleanup, transport release and protection release are withheld",
      async () => {
        const names = (await client.listTools()).tools.map((tool) => tool.name)
        for (const name of [
          "call_customer_function",
          "cleanup_transport_entries",
          "release_transport_task",
          "release_write_operation_lock"
        ])
          assert.ok(!names.includes(name), name)
      }
    )
    await t.test(
      "a different runtime fingerprint fails instead of accepting a matching version",
      async () => {
        const wrong = join(evidence, "wrong-artifact.json")
        await writeFile(
          wrong,
          JSON.stringify({ ...manifest, expectedArtifactFingerprint: "0".repeat(64) }),
          { flag: "wx" }
        )
        const result = await run(process.execPath, [
          checker,
          endpoint,
          wrong,
          join(evidence, "wrong-artifact-result.json")
        ])
        assert.equal(result.code, 1)
        const report = JSON.parse(
          await readFile(join(evidence, "wrong-artifact-result.json"), "utf8")
        )
        assert.equal(report.status, "Failed")
        assert.equal(report.runtime.checks.expectedArtifact, "mismatch")
      }
    )
    await t.test("missing or extra tools cannot pass the delivery check", async () => {
      const wrong = join(evidence, "wrong-surface.json")
      await writeFile(
        wrong,
        JSON.stringify({ ...manifest, requiredTools: manifest.requiredTools.slice(1) }),
        { flag: "wx" }
      )
      const result = await run(process.execPath, [
        checker,
        endpoint,
        wrong,
        join(evidence, "wrong-surface-result.json")
      ])
      assert.equal(result.code, 1)
    })
    await t.test("packaging refuses an existing candidate and preserves its manifest", async () => {
      const result = await run(process.execPath, [
        "scripts/package-spro-core.mjs",
        candidate,
        join(candidate, "runtime"),
        join(evidence, "state"),
        "4861"
      ])
      assert.equal(result.code, 1)
      assert.match(result.output, /EEXIST/)
      assert.equal(sha(await readFile(manifestPath)), sha(manifestBytes))
    })
    await t.test(
      "persistent recovery state inside the candidate is refused before output creation",
      async () => {
        const invalid = join(evidence, "invalid")
        const result = await run(process.execPath, [
          "scripts/package-spro-core.mjs",
          invalid,
          join(candidate, "runtime"),
          join(invalid, "state"),
          "4861"
        ])
        assert.equal(result.code, 1)
        assert.match(result.output, /State must live outside/)
      }
    )
    assert.equal(
      sha(await readFile(join(candidate, "connections.json"))),
      manifest.fileSha256["connections.json"]
    )
  } finally {
    await client.close()
    service.kill()
    await exited
    await writeFile(join(evidence, "service.log"), log, { flag: "wx" })
    await writeFile(
      join(evidence, "summary.json"),
      JSON.stringify(
        {
          endpoint,
          processId: service.pid,
          candidate,
          sapTarget: "reserved .invalid placeholder; no password provided",
          sapBusinessAcceptance: "not_run",
          serviceStopped: true,
          artifactsPreserved: true
        },
        null,
        2
      ),
      { flag: "wx" }
    )
  }
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`))
  console.log(`SPRO_CORE_EVIDENCE=${evidence}`)
})
