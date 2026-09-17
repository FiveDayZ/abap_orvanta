import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const live = process.argv.slice(2).includes("--live-read-only")
const batch2 = process.argv.slice(2).includes("--batch2")
const batch3 = process.argv.slice(2).includes("--batch3")
if (batch3 && (batch2 || live)) throw new Error("Batch 3 is local-only and cannot be combined")
if (
  process.argv.slice(2).some((arg) => !["--live-read-only", "--batch2", "--batch3"].includes(arg))
) {
  throw new Error(
    "Usage: node scripts/run-mvp-batch1-acceptance.mjs [--live-read-only | --batch2 | --batch3]"
  )
}
if (batch2 && live)
  throw new Error("Use test-mvp-batch2-sap.cmd for separately confirmed SAP read-only checks")
if (Number(process.versions.node.split(".")[0]) < 24)
  throw new Error("Node.js 24 or later required")
if (live && !process.env.ABAP_MCP_URL) {
  throw new Error("Live mode requires ABAP_MCP_URL for an explicitly selected candidate service")
}
const startedAt = new Date().toISOString()
const output = resolve(
  root,
  "../.doc",
  `mvp-batch${batch3 ? 3 : batch2 ? 2 : 1}-user-${startedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
)
mkdirSync(output, { recursive: true })
const report = {
  startedAt,
  scope: batch3
    ? "MVP-04-unit-reporting-and-MVP-07-configuration-preview-with-regression"
    : batch2
      ? "MVP-05-06-with-batch1-regression"
      : "MVP-01-02-03-08",
  version: JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version,
  status: "Partially Verified",
  sapBusinessWrites: false,
  serviceSwitched: false,
  steps: [],
  limitations: [
    "Local tests use mock SAP and isolated state; they do not prove real SAP transactions.",
    ...(batch3
      ? [
          "Configuration preview checks structure and TPMODE fixed domain values only; full business rules, authorization and real SAP reads remain separate evidence. Saving is unavailable.",
          "ABAP Unit assertion fixtures and SCI execution require separate SAP acceptance; local results do not verify the installed package."
        ]
      : []),
    live
      ? "Live mode only reads the selected candidate and the existing approved full-row sample."
      : "This run does not inspect the running service or SAP deployment state.",
    "RFC interface mutation, source writes and actual upgrade/recovery need separate human authorization and evidence.",
    ...(batch2
      ? [
          "SM12/SM13 deployment is not checked by this local runner; local mocks do not prove SAP authorization, ABAP syntax or native sample equivalence."
        ]
      : [])
  ]
}
function run(id, args, layer, env = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: layer === "local-mock" ? 600000 : 240000,
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
    status: result.status === 0 && !result.error ? "Passed" : "Failed",
    log,
    errorCode: result.error?.code ?? null
  }
  report.steps.push(step)
  console.log(`${id}: ${step.status}`)
  return step.status === "Passed"
}
try {
  const built = run("build", ["node_modules/typescript/bin/tsc"], "local")
  if (built) {
    const passed = run("regression", ["--test", "dist/test/*.test.js"], "local-mock")
    if (passed && batch3)
      run("sap-runner-local", ["--test", "test/batch3-sap-runner.test.mjs"], "local-mock")
    if (passed && live) {
      const runtime = run("runtime-baseline", ["scripts/probe-mvp-upgrade.mjs"], "live-read-only", {
        ORVANTA_MVP_UPGRADE_REPORT: resolve(output, "runtime-baseline.json")
      })
      if (runtime)
        run("full-rows", ["scripts/probe-full-row-query.mjs"], "live-read-only", {
          ORVANTA_FULL_ROW_REPORT: resolve(output, "full-rows.json")
        })
    }
  }
  report.status = report.steps.some((step) => step.status === "Failed")
    ? "Failed"
    : "Partially Verified"
  report.selectedChecksPassed = report.steps.every((step) => step.status === "Passed")
} catch (error) {
  report.status = "Failed"
  report.failure = error.message
} finally {
  report.finishedAt = new Date().toISOString()
  const path = resolve(output, "result.json")
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n", { flag: "wx" })
  console.log(`Result: ${report.status}\nReport: ${path}`)
  process.exitCode = report.status === "Failed" ? 1 : 0
}
