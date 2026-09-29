/**
 * Read-only acceptance check for a `Z_ORVANTA_MCP_DYNPRO_API` (repository helper) deployment.
 *
 * Why this exists: `verify-helper-deployment.mjs` covers the CAPABILITIES upgrade of
 * `Z_ORVANTA_MAINT_READ` / `Z_ORVANTA_OPS_READ`, but nothing checked the repository helper, which is
 * the one whose repair carrier a human runs in SE38. After the 2026-09-28 and 2026-09-29 runs both
 * left it as an interface-only shell, "the carrier printed DONE" was the only signal available, and
 * a carrier reports its own success even when the body write did not survive. The carrier's own
 * closing line names the check that is actually decisive:
 *
 *   maxProtocol 2.16 with CREATE_TRANSPORT_REQUEST and ADD_OBJECTS_TO_TRANSPORT present
 *
 * The decisive part is `attestation: "self-described"`: those rows are emitted by the generated
 * *body* through its CAPABILITIES action, so a module that still holds only an interface cannot
 * produce them. `report.helpers[].protocolVersion` is not a substitute - that is the negotiated
 * helper protocol on the service side (1.2), not the helper's own declared capability ceiling.
 *
 * It calls read-only MCP tools, never writes to SAP and never touches the verification registry.
 *
 * Usage:
 *   node scripts/verify-repository-helper-deployment.mjs [--url=http://127.0.0.1:4848/mcp]
 *   [--connection=w200] [--json=<path>] [--dump]
 *
 * Exit codes: 0 all checks passed, 3 helper unavailable, 4 helper answered but a check failed,
 * 5 report unreadable.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

function argument(name, fallback = undefined) {
  const prefix = `--${name}=`
  const found = process.argv.find((value) => value.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

const endpoint = new URL(argument("url", process.env.ABAP_MCP_URL ?? "http://127.0.0.1:4848/mcp"))
if (
  endpoint.protocol !== "http:" ||
  (endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "::1")
) {
  throw new Error("Only a loopback MCP service is accepted")
}
const connectionId = argument("connection", "w200").toLowerCase()
const jsonPath = argument("json")
const dump = process.argv.includes("--dump")

const EXPECTED_HELPER = "Z_ORVANTA_MCP_DYNPRO_API"
const EXPECTED_MIN_PROTOCOL = "1.1"
const EXPECTED_MAX_PROTOCOL = "2.16"
const EXPECTED_OPERATION_COUNT = 46
const EXPECTED_OPERATIONS = ["CREATE_TRANSPORT_REQUEST", "ADD_OBJECTS_TO_TRANSPORT"]

const client = new Client({ name: "repository-helper-deployment-check", version: "1.0.0" })

function textOf(result) {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

async function call(name, args) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })
  return { isError: response.isError === true, text: textOf(response) }
}

const transport = new StreamableHTTPClientTransport(endpoint)
await client.connect(transport)

const problems = []
const notes = []
let report

try {
  const response = await call("get_capability_report", { connectionId })
  if (response.isError) throw new Error(response.text.slice(0, 400))
  report = JSON.parse(response.text)
} catch (error) {
  console.error(`capability report unreadable: ${error.message}`)
  await client.close()
  process.exit(5)
}

if (dump) {
  console.log(JSON.stringify(report.helperAttestation ?? null, null, 2))
  await client.close()
  process.exit(0)
}

const attestations = Array.isArray(report?.helperAttestation) ? report.helperAttestation : []
const entry = attestations.find((candidate) => candidate.helper === EXPECTED_HELPER)

if (!entry) {
  console.error(
    `${EXPECTED_HELPER} has no attestation entry; the report lists ` +
      `${attestations.map((candidate) => candidate.helper).join(", ") || "none"}`
  )
  await client.close()
  process.exit(3)
}

const operations = Array.isArray(entry.operations) ? entry.operations : []
const opcodes = operations.map((operation) => operation.opcode)

if (entry.attestation !== "self-described") {
  problems.push(
    `attestation is ${JSON.stringify(entry.attestation)}, not "self-described" - the body did not write its self-description`
  )
} else {
  notes.push('attestation is "self-described" (body-emitted, so the interface-only shell is gone)')
}

if (entry.minProtocol !== EXPECTED_MIN_PROTOCOL) {
  problems.push(`minProtocol is ${entry.minProtocol}, expected ${EXPECTED_MIN_PROTOCOL}`)
} else {
  notes.push(`minProtocol ${EXPECTED_MIN_PROTOCOL}`)
}

if (entry.maxProtocol !== EXPECTED_MAX_PROTOCOL) {
  problems.push(`maxProtocol is ${entry.maxProtocol}, expected ${EXPECTED_MAX_PROTOCOL}`)
} else {
  notes.push(`maxProtocol ${EXPECTED_MAX_PROTOCOL}`)
}

for (const operation of EXPECTED_OPERATIONS) {
  if (!opcodes.includes(operation)) problems.push(`operation ${operation} is absent`)
  else notes.push(`operation ${operation} present`)
}

if (operations.length !== EXPECTED_OPERATION_COUNT) {
  // The carrier reports "46 capability rows written". A different count is worth a human look but
  // is not by itself proof of a bad deployment, so it is reported distinctly from the hard checks.
  notes.push(
    `operation count is ${operations.length}, carrier reported ${EXPECTED_OPERATION_COUNT} - review`
  )
} else {
  notes.push(`operation count ${EXPECTED_OPERATION_COUNT}`)
}

const writeOps = operations.filter((operation) => operation.write === true).map((o) => o.opcode)

const result = {
  probe: "repository-helper-deployment-check",
  readOnly: true,
  endpoint: endpoint.origin,
  connectionId,
  observedAt: new Date().toISOString(),
  helper: EXPECTED_HELPER,
  attestation: entry.attestation ?? null,
  minProtocol: entry.minProtocol ?? null,
  maxProtocol: entry.maxProtocol ?? null,
  operationCount: operations.length,
  writeOperationCount: writeOps.length,
  checks: { passed: notes, failed: problems },
  verdict: problems.length === 0 ? "Passed" : "Failed"
}

if (jsonPath) {
  await mkdir(dirname(jsonPath), { recursive: true })
  await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8")
  console.log(`wrote ${jsonPath}`)
}

console.log(
  `${EXPECTED_HELPER}: attestation=${result.attestation} protocol=${result.minProtocol}..${result.maxProtocol} ` +
    `operations=${operations.length} (write=${writeOps.length})`
)
for (const note of notes) console.log(`  ok   ${note}`)
for (const problem of problems) console.log(`  FAIL ${problem}`)
console.log(`verdict: ${result.verdict}`)

await client.close()
process.exit(problems.length === 0 ? 0 : 4)
