import { mkdir, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  searchSapLocksSchema,
  searchFailedUpdatesSchema,
  readFailedUpdateSchema
} from "../dist/src/maintenance-diagnostics.js"
import { validateDiagnosticInterval } from "../dist/src/operational-logs.js"
import { redactDiagnosticText } from "../dist/src/runtime-diagnostics.js"
import { RuntimeIdentity } from "../dist/src/runtime-info.js"
import { PRODUCT_VERSION } from "../dist/src/version.js"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const choices = {
  locks: { name: "search_sap_locks", schema: searchSapLocksSchema },
  updates: { name: "search_failed_updates", schema: searchFailedUpdatesSchema },
  detail: { name: "read_failed_update", schema: readFailedUpdateSchema }
}

export function prepareSelection(mode, input, expected) {
  const choice = Object.hasOwn(choices, mode) ? choices[mode] : undefined
  if (!choice) throw new Error("Select locks, updates or detail")
  const args = choice.schema.parse(input)
  if (args.connectionId !== "w200") throw new Error("This acceptance scope is w200 only")
  const expectations =
    mode === "detail" ? ["nonempty", "not_found", "forbidden"] : ["nonempty", "empty", "forbidden"]
  if (!expectations.includes(expected)) throw new Error("Invalid expected outcome for this tool")
  if (mode === "updates") validateDiagnosticInterval(args.fromSystemTime, args.toSystemTime, 3600)
  return { mode, name: choice.name, args, expected }
}

export function parseEndpoint(value) {
  const url = new URL(value)
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/mcp" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Only an explicit loopback HTTP /mcp endpoint is accepted")
  return url
}

export function checkObservation(selection, result) {
  if (
    !result ||
    result.readOnly !== true ||
    result.connectionId !== "w200" ||
    result.client !== "200" ||
    result.source !== (selection.mode === "locks" ? "SM12" : "SM13")
  )
    throw new Error("Response is outside the selected read-only scope")
  if (selection.expected === "forbidden" || selection.expected === "not_found") {
    const code = selection.expected === "forbidden" ? "NO_AUTHORITY" : "NOT_FOUND"
    const data = selection.mode === "detail" ? result.data : result.entries
    if (result.status !== selection.expected || result.code !== code || data !== null)
      throw new Error(`Expected ${selection.expected}/${code} without data`)
    return { outcome: selection.expected, returnedCount: null }
  }
  if (result.status !== "ok" || result.code !== "OK")
    throw new Error(`Expected ok/OK, received ${result.status}/${result.code}`)
  if (selection.mode === "detail") {
    if (
      !result.data?.header ||
      result.data.header.updateKey !== selection.args.updateKey ||
      result.data.header.client !== "200" ||
      result.data.header.username?.toUpperCase() !== selection.args.username.toUpperCase() ||
      !Array.isArray(result.data.modules) ||
      !Array.isArray(result.data.errors)
    )
      throw new Error("Expected detail for the selected key, client and user")
    return {
      outcome: "nonempty",
      moduleCount: result.data.modules.length,
      errorCount: result.data.errors.length
    }
  }
  if (
    !Array.isArray(result.entries) ||
    result.returnedCount !== result.entries.length ||
    result.entries.length > selection.args.maxResults ||
    typeof result.hasMore !== "boolean" ||
    (result.hasMore && result.entries.length !== selection.args.maxResults) ||
    result.entries.some(
      (row) =>
        row.client !== "200" ||
        row.username?.toUpperCase() !== selection.args.username.toUpperCase()
    )
  )
    throw new Error("Invalid result count, pagination or user/client scope")
  const outcome = result.entries.length ? "nonempty" : "empty"
  if (outcome !== selection.expected)
    throw new Error(`Expected ${selection.expected}, got ${outcome}`)
  return { outcome, returnedCount: result.entries.length, hasMore: result.hasMore }
}

// This runner never follows a returned key or retries a failed query.
export async function observe(client, selection, identity, report) {
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 })
    report.steps.push({ name, response })
    if (response.isError) throw new Error(`${name}: MCP tool returned isError`)
    const text = response.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
    return JSON.parse(text)
  }
  if (!identity.version || !/^[a-f0-9]{64}$/.test(identity.fingerprint ?? ""))
    throw new Error("Candidate identity is unavailable")
  const runtime = await call("get_runtime_info", {
    expectedVersion: identity.version,
    expectedArtifactFingerprint: identity.fingerprint
  })
  if (
    runtime.status !== "observed" ||
    runtime.server?.version !== identity.version ||
    runtime.checks?.expectedVersion !== "match" ||
    runtime.checks?.expectedArtifact !== "match" ||
    runtime.checks?.diskSinceStartup !== "match" ||
    runtime.checks?.moduleAndPackageVersion !== "match"
  )
    throw new Error("Running service does not match the local compiled candidate")
  const result = await call(selection.name, selection.args)
  report.observation = checkObservation(selection, result)
  report.selectedChecksPassed = true
}

function redacted(value) {
  return JSON.stringify(
    value,
    (_key, item) => (typeof item === "string" ? redactDiagnosticText(item) : item),
    2
  )
}

async function main() {
  if (process.argv.length > 2) throw new Error("Run without arguments; select scope interactively")
  if (!stdin.isTTY)
    throw new Error("Interactive terminal required; unattended execution is disabled")
  const rl = createInterface({ input: stdin, output: stdout })
  let selection
  let endpoint
  try {
    console.log("Real SAP read-only acceptance. One selected query, no retries or business writes.")
    endpoint = parseEndpoint(
      (await rl.question("MCP URL [http://127.0.0.1:4847/mcp]: ")).trim() ||
        "http://127.0.0.1:4847/mcp"
    )
    const mode = (await rl.question("Mode (locks / updates / detail): ")).trim()
    const input = {
      connectionId: "w200",
      username: (await rl.question("Exact SAP sample owner username: ")).trim()
    }
    if (mode === "locks") {
      for (const field of ["tableName", "lockObject", "argument"]) {
        const value = await rl.question(`${field} (optional, blank omits filter): `)
        if (value !== "") input[field] = value
      }
    }
    if (mode === "updates") {
      input.fromSystemTime = (
        await rl.question("From SAP local time (YYYY-MM-DDTHH:mm:ss): ")
      ).trim()
      input.toSystemTime = (await rl.question("To SAP local time (max one hour): ")).trim()
    }
    if (mode === "detail") {
      input.updateKey = (await rl.question("Exact existing updateKey: ")).trim()
      const revision = (await rl.question("Expected revision (optional): ")).trim()
      if (revision) input.expectedRevision = revision
    } else {
      const limit = (await rl.question("Max results [20], range 1-100: ")).trim()
      input.maxResults = limit ? Number(limit) : 20
    }
    const expected = (
      await rl.question(
        `Expected outcome (${mode === "detail" ? "nonempty / not_found" : "nonempty / empty"} / forbidden): `
      )
    ).trim()
    selection = prepareSelection(mode, input, expected)
    console.log(redacted({ endpoint: endpoint.href, ...selection }))
    console.log("Input and returned metadata will be saved in the workspace .doc folder.")
    console.log(
      "Do not enter credentials. Reports may contain business keys; redact before sharing."
    )
    if (
      (await rl.question("Type READ to approve this exact query, anything else cancels: ")) !==
      "READ"
    ) {
      console.log("Cancelled. No MCP or SAP call was made.")
      return
    }
  } finally {
    rl.close()
  }
  const startedAt = new Date().toISOString()
  const output = resolve(
    root,
    "../.doc",
    `mvp-batch2-sap-user-${startedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
  )
  await mkdir(output, { recursive: true })
  const report = {
    startedAt,
    scope: "MVP-05-06-single-human-selected-read",
    endpoint: endpoint.href,
    selection,
    status: "Partially Verified",
    selectedChecksPassed: false,
    sapBusinessWrites: false,
    serviceSwitched: false,
    automaticRetry: false,
    nativeComparison: "not_performed_by_runner",
    steps: [],
    limitations: [
      "Only the selected outcome is checked; no full SM12/SM13 acceptance is claimed.",
      "Empty results do not prove nonempty samples; forbidden does not prove authorized access.",
      "Native comparison, other identities and data-change scenarios remain manual gates.",
      "The runner does not deploy helpers, edit approvals, create samples or repair failures."
    ]
  }
  const client = new Client({ name: "mvp-batch2-human-read", version: PRODUCT_VERSION })
  try {
    const local = await new RuntimeIdentity().report()
    if (local.status !== "observed")
      throw new Error("Local compiled candidate identity is unavailable")
    await client.connect(new StreamableHTTPClientTransport(endpoint), { timeout: 15000 })
    report.server = client.getServerVersion()
    await observe(
      client,
      selection,
      { version: PRODUCT_VERSION, fingerprint: local.startupArtifact.artifactFingerprint },
      report
    )
  } catch (error) {
    report.status = "Failed"
    report.failure = String(error.message ?? error)
    process.exitCode = 1
  } finally {
    try {
      await client.close()
    } catch (error) {
      report.status = "Failed"
      report.closeFailure = String(error.message ?? error)
      process.exitCode = 1
    }
    report.finishedAt = new Date().toISOString()
    const path = resolve(output, "result.json")
    await writeFile(path, redacted(report) + "\n", { flag: "wx" })
    console.log(`Result: ${report.status}\nReport: ${path}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(redactDiagnosticText(String(error.message ?? error)))
    process.exitCode = 1
  })
}
