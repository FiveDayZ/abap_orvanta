import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
if (Number(process.versions.node.split(".")[0]) < 24) {
  console.error("Node.js 24 or later is required.")
  process.exit(2)
}
const offline = process.argv.slice(2).includes("--offline")
if (process.argv.slice(2).some((arg) => arg !== "--offline")) {
  console.error("Usage: node scripts/run-m7-standalone-acceptance.mjs [--offline]")
  process.exit(2)
}
const endpoint = new URL(process.env.ABAP_MCP_URL ?? "http://127.0.0.1:4853/mcp")
if (
  endpoint.protocol !== "http:" ||
  endpoint.hostname !== "127.0.0.1" ||
  endpoint.pathname !== "/mcp" ||
  endpoint.username ||
  endpoint.password ||
  endpoint.search ||
  endpoint.hash
) {
  console.error("Only http://127.0.0.1:<port>/mcp is accepted.")
  process.exit(2)
}
const startedAt = new Date().toISOString()
const output = resolve(
  root,
  "../.doc",
  `m7-standalone-user-${startedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
)
mkdirSync(output, { recursive: true })
const report = {
  startedAt,
  status: "Partially Verified",
  scope: "standalone-targeted-integration",
  endpoint: endpoint.href,
  offline,
  localVersion: JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version,
  sapBusinessWrites: false,
  serviceRestarted: false,
  limitations: [
    "Live probes read only w200/200 system metadata; no business document or WebGUI access.",
    "Reliability tests use isolated local state and mock SAP, not real SAP transaction failures.",
    "Matching version strings do not prove local source and running artifact hashes match.",
    "No native ATC, reference analysis, live debugger, packaging, or Agent-client acceptance."
  ],
  steps: []
}

function run(id, args, layer, timeout, structured = false) {
  console.log(`[${id}] Running...`)
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ABAP_MCP_URL: endpoint.href },
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  })
  const log = resolve(output, `${id}.log`)
  writeFileSync(log, `${result.stdout ?? ""}\n${result.stderr ?? ""}`, { flag: "wx" })
  const step = {
    id,
    layer,
    command: [process.execPath, ...args],
    exitCode: result.status,
    signal: result.signal,
    status: result.status === 0 && !result.error ? "Passed" : "Failed",
    errorCode: result.error?.code ?? null,
    log
  }
  if (structured && step.status === "Passed") {
    try {
      const evidence = JSON.parse(result.stdout)
      step.probeStatus = evidence.status
      step.evidencePath = evidence.output
      if (evidence.status !== "Passed") step.status = "Failed"
    } catch {
      step.status = "Failed"
      step.errorCode = "PROBE_RESULT_INVALID"
    }
  }
  report.steps.push(step)
  console.log(`[${id}] ${step.status}`)
  return step.status === "Passed"
}

try {
  const built = run("build", ["node_modules/typescript/bin/tsc"], "local", 120000)
  if (built) {
    run(
      "protocol-and-reliability",
      [
        "--test",
        "dist/test/protocol.test.js",
        "dist/test/invocation-receipts.test.js",
        "dist/test/write-operation-receipts.test.js",
        "dist/test/failure-process.test.js"
      ],
      "local-mock",
      180000
    )
    if (!offline) {
      run("system-info", ["scripts/probe-system-info.mjs"], "live-read-only", 180000, true)
      run("table-query", ["scripts/probe-table-query.mjs"], "live-read-only", 180000, true)
    }
  }
  if (!built || offline) {
    report.steps.push({
      id: "live-read-only",
      status: "Skipped",
      reason: built ? "Offline mode requested; no SAP calls." : "Build failed; live probes not run."
    })
  }
  report.status = report.steps.some((step) => step.status === "Failed")
    ? "Failed"
    : offline
      ? "Partially Verified"
      : "Passed"
} catch {
  report.status = "Failed"
  report.failure = "RUNNER_INTERRUPTED_OR_LOCAL_IO_FAILED"
} finally {
  report.finishedAt = new Date().toISOString()
  const path = resolve(output, "result.json")
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" })
  console.log(`\nResult: ${report.status}\nReport: ${path}`)
  process.exitCode = report.status === "Failed" ? 1 : 0
}
