#!/usr/bin/env node
/**
 * Local runtime acceptance for the tool-surface switch (WP A5).
 *
 *   node scripts/probe-tool-profile.mjs            # full profile (default, 126 tools)
 *   node scripts/probe-tool-profile.mjs --readonly # readonly profile (75 tools)
 *
 * Starts the built service on a free loopback port with a throwaway connections.json and
 * state directory, then verifies over the real MCP streamable-HTTP transport that
 *   - tools/list matches the expected profile exactly,
 *   - every listed tool carries an annotations.readOnlyHint,
 *   - a withheld write tool is refused by tools/call instead of being executed,
 *   - get_runtime_info reports the active profile.
 * It never contacts SAP: the dummy connection is only parsed, never used.
 */
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { TOOL_COUNT, toolNamesForProfile } from "../dist/src/tool-registry.js"

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const readonly = process.argv.includes("--readonly")
const profile = readonly ? "readonly" : "full"
const expected = readonly ? toolNamesForProfile("readonly") : toolNamesForProfile("full")
const withheldTool = "create_module_pool"

const failures = []
function check(condition, description, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${description}${detail ? ` — ${detail}` : ""}`)
  if (!condition) failures.push(description)
}

async function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once("error", rejectPort)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`service exited early with code ${child.exitCode}`)
    try {
      const response = await fetch(`${baseUrl}/health`)
      if (response.ok) return
    } catch {
      // not listening yet
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  throw new Error("service did not become healthy within 30s")
}

async function rpc(baseUrl, body, sessionId) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {})
    },
    body: JSON.stringify(body)
  })
  const text = await response.text()
  const session = response.headers.get("mcp-session-id") ?? sessionId
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 400)}`)
  const payload = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
    .pop()
  return { json: JSON.parse(payload ?? text), session }
}

const stateRoot = await mkdtemp(join(tmpdir(), "orvanta-profile-probe-"))
const configPath = join(stateRoot, "connections.json")
await writeFile(
  configPath,
  JSON.stringify({
    connections: [
      {
        id: "w200",
        url: "https://sap.example.invalid",
        client: "200",
        language: "EN",
        username: "PROFILE_PROBE",
        passwordEnv: "UNUSED_PROFILE_PROBE_PASSWORD",
        allowUnauthorized: false,
        remoteFunctionAllowlist: []
      }
    ]
  })
)

const port = await freePort()
const baseUrl = `http://127.0.0.1:${port}`
const child = spawn(process.execPath, [join(projectRoot, "dist", "src", "index.js")], {
  cwd: projectRoot,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    ABAP_MCP_PORT: String(port),
    ABAP_MCP_CONFIG: configPath,
    ABAP_MCP_STATE_DIR: stateRoot,
    ABAP_MCP_TOOL_PROFILE: profile
  }
})
let stderr = ""
child.stderr.on("data", (chunk) => {
  stderr += String(chunk)
})

try {
  await waitForHealth(baseUrl, child)
  const initialized = await rpc(baseUrl, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tool-profile-probe", version: "1.0.0" }
    }
  })
  const session = initialized.session
  const listed = await rpc(baseUrl, { jsonrpc: "2.0", id: 2, method: "tools/list" }, session)
  const tools = listed.json.result.tools
  const names = tools.map((tool) => tool.name).sort()

  check(
    names.length === expected.length,
    `${profile} profile exposes ${expected.length} tools`,
    `observed ${names.length}`
  )
  const missing = expected.filter((name) => !names.includes(name))
  const extra = names.filter((name) => !expected.includes(name))
  check(missing.length === 0, "no expected tool is missing", missing.slice(0, 5).join(", "))
  check(extra.length === 0, "no unexpected tool is exposed", extra.slice(0, 5).join(", "))

  const withoutReadOnlyHint = tools
    .filter((tool) => tool.annotations?.readOnlyHint === undefined)
    .map((tool) => tool.name)
  check(
    withoutReadOnlyHint.length === 0,
    "every listed tool declares annotations.readOnlyHint",
    withoutReadOnlyHint.slice(0, 5).join(", ")
  )
  if (readonly) {
    const writable = tools
      .filter((tool) => tool.annotations?.readOnlyHint !== true)
      .map((tool) => tool.name)
    check(writable.length === 0, "readonly profile exposes no write tool", writable.join(", "))
    check(
      names.length < TOOL_COUNT,
      "readonly profile is narrower than the full surface",
      `${names.length} < ${TOOL_COUNT}`
    )
  }

  if (readonly) {
    const refused = await rpc(
      baseUrl,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: withheldTool, arguments: { connectionId: "w200", name: "ZPROBE" } }
      },
      session
    )
    const message = JSON.stringify(refused.json.result ?? refused.json.error ?? {})
    check(
      refused.json.error !== undefined || refused.json.result?.isError === true,
      `withheld tool ${withheldTool} is refused instead of executed`,
      message.slice(0, 160)
    )
    check(/disabled/i.test(message), "refusal names the disabled tool", message.slice(0, 160))
  }

  const runtime = await rpc(
    baseUrl,
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_runtime_info", arguments: {} }
    },
    session
  )
  const report = JSON.parse(runtime.json.result.content[0].text)
  check(report.toolProfile?.profile === profile, "get_runtime_info reports the active profile")
  check(
    report.toolProfile?.enabledCount === expected.length,
    "get_runtime_info reports the enabled tool count",
    `enabledCount=${report.toolProfile?.enabledCount}`
  )
  check(report.readOnly === true, "runtime report stays read-only")
} catch (error) {
  failures.push(String(error))
  console.log(`FAIL  probe aborted — ${error}`)
  if (stderr.trim())
    console.log(`service stderr:\n${stderr.trim().split("\n").slice(-12).join("\n")}`)
} finally {
  child.kill()
  await rm(stateRoot, { recursive: true, force: true })
}

console.log(
  failures.length === 0
    ? `\ntool profile probe (${profile}): all checks passed`
    : `\ntool profile probe (${profile}): ${failures.length} check(s) failed`
)
process.exit(failures.length === 0 ? 0 : 1)
