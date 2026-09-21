#!/usr/bin/env node
/**
 * Creates the local approval file the maintenance diagnostic family reads before it touches SAP, so
 * `search_sap_locks` / `search_update_records` / `get_update_record_detail` can return data instead of
 * `HELPER_NOT_APPROVED`.
 *
 *   node scripts/prepare-maintenance-approval.mjs                 # dry run: print what would be written
 *   node scripts/prepare-maintenance-approval.mjs --write         # write it into the service state root
 *   node scripts/prepare-maintenance-approval.mjs --verify        # re-run search_sap_locks and report
 *
 * Why this is needed: src/maintenance-diagnostics.ts refuses every call until
 * <stateRoot>/maintenance-diagnostic-approvals.json names the connection with the deployed helper's
 * exact source and interface fingerprints. That gate is deliberate (SM12/SM13 reads expose other
 * users' lock and update records), so the file is an approval an operator has to issue - this script
 * only collects the facts it must contain and never bypasses the check. It is read on every call, so
 * no service restart is required after writing.
 *
 * Read-only against SAP: the fingerprints come from read_function_module_interface.
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const argv = process.argv.slice(2)
const value = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i < 0 ? fallback : argv[i + 1]
}
const write = argv.includes("--write")
const verify = argv.includes("--verify")
const endpoint = value("--endpoint", process.env.ABAP_MCP_ENDPOINT ?? "http://127.0.0.1:4848/mcp")
const connectionId = value("--connection", "w200")
const sources = (value("--sources", "SM12") ?? "SM12")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean)
const HELPER = "Z_ORVANTA_MAINT_READ"
const HELPER_GROUP = "ZORVANTA_MAINT"
const APPROVAL_FILE = "maintenance-diagnostic-approvals.json"

for (const source of sources) {
  if (source !== "SM12" && source !== "SM13") {
    console.error(`--sources accepts SM12 and SM13 only, got ${source}`)
    process.exit(2)
  }
}

/** Connection identity the gate compares against, so it has to come from the service's own config. */
function candidateConfigs() {
  const repo = resolve(".")
  const candidates = []
  if (process.env.ABAP_MCP_CONFIG) candidates.push(resolve(process.env.ABAP_MCP_CONFIG))
  candidates.push(join(repo, "connections.json"))
  candidates.push(
    join(
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "ABAP MCP Standalone",
      "connections.json"
    )
  )
  candidates.push(
    join(
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      "ABAP MCP Standalone",
      "connections.json"
    )
  )
  return candidates
}

/** Unpacked packages under release/ carry a live connection too; newest first. */
function releaseConfigs(repo) {
  const dir = join(repo, "release")
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => /^orvanta-mcp-\d+\.\d+\.\d+-win-x64$/.test(name))
    .sort((a, b) => {
      const va = a
        .match(/(\d+)\.(\d+)\.(\d+)/)
        .slice(1)
        .map(Number)
      const vb = b
        .match(/(\d+)\.(\d+)\.(\d+)/)
        .slice(1)
        .map(Number)
      return vb[0] - va[0] || vb[1] - va[1] || vb[2] - va[2]
    })
    .map((name) => join(dir, name, "connections.json"))
}

function identityFor(file, id) {
  if (!existsSync(file)) return null
  let document
  try {
    document = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
  const entry = (document.connections ?? []).find(
    (c) => String(c.id ?? "").toLowerCase() === id.toLowerCase()
  )
  if (!entry) return null
  if (String(entry.url ?? "").includes("sap.example.invalid")) return null
  return {
    file,
    url: String(entry.url),
    client: String(entry.client),
    username: String(entry.username)
  }
}

let identity = null
const explicit = value("--connections", null)
const files = explicit
  ? [resolve(explicit)]
  : [...candidateConfigs().filter(existsSync), ...releaseConfigs(resolve("."))]
for (const file of files) {
  const found = identityFor(file, connectionId)
  if (found) {
    identity = found
    break
  }
}
if (!identity) {
  console.error(
    `no connections file declares ${connectionId} with a real url; pass --connections <file>`
  )
  process.exit(2)
}

const stateRoot = resolve(
  value("--state-root", process.env.ABAP_MCP_STATE_DIR) ??
    join(
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "ABAP MCP Standalone",
      "state"
    )
)

// ---- facts from the deployed helper (read-only) -------------------------------------------------
const client = new Client({ name: "prepare-maintenance-approval", version: "1.0.0" })
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)))
const read = await client.callTool(
  { name: "read_function_module_interface", arguments: { connectionId, functionName: HELPER } },
  undefined,
  { timeout: 300000 }
)
if (read.isError) {
  console.error(`reading ${HELPER} failed: ${(read.content ?? []).map((c) => c.text).join("")}`)
  process.exit(3)
}
const helper = JSON.parse((read.content ?? []).map((c) => c.text ?? "").join(""))
const failures = []
if (helper.functionGroup !== HELPER_GROUP) failures.push(`functionGroup is ${helper.functionGroup}`)
if (helper.remoteEnabled !== true) failures.push("the helper is not remote-enabled")
if (helper.updateTask === true) failures.push("the helper is an update-task module")
for (const field of ["sourceFingerprint", "interfaceFingerprint"]) {
  if (!/^[0-9a-f]{64}$/.test(String(helper[field] ?? ""))) failures.push(`${field} is not a sha256`)
}
if (failures.length > 0) {
  console.error(`the deployed helper cannot back a maintenance approval: ${failures.join("; ")}`)
  process.exit(4)
}

const entry = {
  connectionId,
  url: identity.url,
  client: identity.client,
  username: identity.username,
  sourceFingerprint: helper.sourceFingerprint,
  interfaceFingerprint: helper.interfaceFingerprint,
  enabledSources: sources
}

// Merge, so approving one connection does not drop another operator's approval.
let document = { version: 1, connections: [entry] }
const approvalFile = join(stateRoot, APPROVAL_FILE)
if (existsSync(approvalFile)) {
  const existing = JSON.parse(await readFile(approvalFile, "utf8"))
  const others = (existing.connections ?? []).filter(
    (c) => String(c.connectionId).toLowerCase() !== connectionId.toLowerCase()
  )
  document = { version: 1, connections: [...others, entry] }
}

console.log(`service endpoint : ${endpoint}`)
console.log(
  `connection       : ${connectionId} (${identity.url} client ${identity.client} user ${identity.username})`
)
console.log(`identity source  : ${identity.file}`)
console.log(
  `helper           : ${HELPER} in ${helper.functionGroup}, remote=${helper.remoteEnabled}, updateTask=${helper.updateTask}`
)
console.log(`sourceFingerprint: ${entry.sourceFingerprint}`)
console.log(`interfaceFingerprint: ${entry.interfaceFingerprint}`)
console.log(`enabledSources   : ${entry.enabledSources.join(", ")}`)
console.log(`state root       : ${stateRoot}`)
console.log(
  `approval file    : ${approvalFile}${existsSync(approvalFile) ? " (exists; other connections preserved)" : " (does not exist yet)"}`
)
console.log("")
console.log(JSON.stringify(document, null, 2))

if (write) {
  await mkdir(dirname(approvalFile), { recursive: true })
  await writeFile(approvalFile, JSON.stringify(document, null, 2) + "\n", "utf8")
  console.log("")
  console.log(`WROTE ${approvalFile}`)
  console.log("The gate re-reads this file on every call, so no service restart is needed.")
  console.log(`Revoke by deleting it, or by removing ${connectionId} from connections[].`)
  const digest = createHash("sha256").update(JSON.stringify(document)).digest("hex").slice(0, 16)
  console.log(`document digest: ${digest}`)
} else if (!verify) {
  console.log("")
  console.log("dry run: nothing was written. Re-run with --write to install this approval.")
}

if (verify || write) {
  const probe = await client.callTool(
    {
      name: "search_sap_locks",
      arguments: {
        connectionId,
        username: value("--username", identity.username),
        tableName: value("--table", "DD02L"),
        maxResults: Number(value("--max-results", "100"))
      }
    },
    undefined,
    { timeout: 300000 }
  )
  const text = (probe.content ?? []).map((c) => c.text ?? "").join("")
  console.log("")
  console.log(`search_sap_locks(${value("--table", "DD02L")}) ->`)
  console.log(text)
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    /* the tool may wrap prose around the payload */
  }
  // Success is status=ok with an entries ARRAY (possibly empty); the unavailable vocabulary is
  // status=unavailable with entries=null. An empty array means "no matching lock", not "unknown".
  if (parsed?.status === "ok" && Array.isArray(parsed.entries)) {
    console.log(
      `VERIFIED: status=ok, entries=[${parsed.entries.length} entr(ies)], returnedCount=${parsed.returnedCount ?? "-"}`
    )
  } else if (parsed) {
    console.log(
      `NOT VERIFIED: status=${parsed.status} code=${parsed.code ?? "-"} reason=${parsed.reason ?? "-"}`
    )
  } else {
    console.log("NOT VERIFIED: reply was not a JSON payload")
  }
}
await client.close()
