/**
 * OP0-2 evidence sweep for the read-only ops tools that have no recorded call yet.
 *
 * This script is the mechanism behind the ops plan's OP0-2 acceptance criterion: every ops tool in
 * `contracts/verification-registry.json` either carries a real call record or is explicitly still
 * unverified with a reason. It does not decide anything by itself - it runs the calls, stores the
 * verbatim answers and prints the registry delta a human/model then applies.
 *
 * It refuses to write any evidence unless the service it talks to is the build this checkout
 * produces. The 2026-09-25 DB02 work showed why that gate matters: a running build whose version
 * string matched but whose tool surface did not was read as "the source says X", and one refused
 * table read became a wrong claim about the platform. Version equality alone does not identify a
 * build, so the gate compares the artefact fingerprint of this checkout's dist tree (the same recipe
 * `get_runtime_info` uses) and the served tool surface against the source's TOOL_NAMES.
 *
 * A second gate sits below that one: the read path itself must answer before any tool is called. On
 * 2026-09-26 SAP's public ICF endpoints returned 200 while every authenticated ADT call returned 401,
 * and a sweep taken in that window would have filed eight `failed` tool outcomes that described an
 * authentication outage. Tool outcomes are only evidence about a tool when the path underneath works,
 * so an unavailable path writes `UNREACHABLE-SAP.json` and exits without recording anything.
 *
 * Usage:
 *   node scripts/probe-ops-read-sweep.mjs --self-check
 *   node scripts/probe-ops-read-sweep.mjs --label=ops-r22 [--url=http://127.0.0.1:4848/mcp] \
 *     [--connection=w200] [--dir=/usr/sap/trans]
 *
 * `--self-check` only describes this checkout: it opens no connection and touches no SAP system.
 * Every other mode is a read-only SAP session and needs the operator's authorization like any other
 * runtime test. No write tool is called, and nothing is ever written to SAP.
 */

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { RuntimeIdentity } from "../dist/src/runtime-info.js"
import { TOOL_COUNT, TOOL_NAMES } from "../dist/src/tool-registry.js"

const here = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(here, "..")

function argument(name, fallback = undefined) {
  const prefix = `--${name}=`
  const found = process.argv.find((value) => value.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

/** sha256 of the newline-joined, sorted tool names, first 16 hex characters. */
function surfaceOf(names) {
  const sorted = [...names].sort()
  return {
    count: sorted.length,
    fingerprint: createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 16)
  }
}

const localSurface = surfaceOf(TOOL_NAMES)

/**
 * One entry per tool this sweep must exercise. `args` is everything beyond connectionId; the plan
 * asks for a real, non-empty positive where the system can give one, and an explicit record when the
 * answer is empty or refused instead.
 */
const SWEEP = [
  { tool: "read_work_processes", args: { maxRows: 50 }, source: "TH_WPINFO over SOAP-RFC" },
  { tool: "read_user_sessions", args: { maxRows: 50 }, source: "TH_USER_LIST over SOAP-RFC" },
  { tool: "read_workload_directory", args: { maxRows: 50 }, source: "SWNC_GET_WORKLOAD_DIRECTORY" },
  { tool: "read_system_parameters", args: { maxRows: 50 }, source: "TPFYPROPTY + TPFHT" },
  { tool: "read_qrfc_queues", args: { maxRows: 50 }, source: "TRFCQOUT + TRFCQIN" },
  { tool: "read_idoc_status", args: { maxRows: 50 }, source: "EDIDC + EDIDS" },
  {
    tool: "read_user_authorizations",
    args: { maxRows: 50, includeRoleTransactions: true, includeProfiles: true },
    source: "AGR_USERS + AGR_TCODES + UST04"
  },
  {
    tool: "read_file_system_directory",
    args: { maxRows: 50 },
    source: "EPS2_GET_DIRECTORY_LISTING",
    // directory is required (1..200 characters); without it this one tool is recorded as not run
    // rather than called with an invented path.
    requires: "directory"
  }
]

/** The OP1-7 join dialect, taken verbatim from test/table-join.test.ts (E070/E07T are allowlisted). */
const JOIN_POSITIVE =
  "SELECT A.TRKORR, B.AS4TEXT FROM E070 A INNER JOIN E07T B ON A.TRKORR = B.TRKORR " +
  "WHERE A.TRSTATUS = 'R' ORDER BY B.AS4TEXT DESC"
/** MARA is only pending approval, so this must be refused before SAP is touched. */
const JOIN_NEGATIVE =
  "SELECT A.TRKORR, B.AS4TEXT FROM E070 A INNER JOIN MARA B ON A.TRKORR = B.MATNR"

const identity = new RuntimeIdentity()
const startup = await identity.report()
const expectation = {
  moduleVersion: startup.server.version,
  packageVersion: startup.startupArtifact.packageVersion,
  artifactFingerprint: startup.startupArtifact.artifactFingerprint,
  toolCount: TOOL_COUNT,
  toolSurface: localSurface,
  targets: SWEEP.map((entry) => entry.tool),
  missingFromSource: SWEEP.map((entry) => entry.tool).filter((name) => !TOOL_NAMES.includes(name))
}

if (process.argv.includes("--self-check")) {
  assert.equal(
    expectation.missingFromSource.length,
    0,
    `sweep targets absent from TOOL_NAMES: ${expectation.missingFromSource.join(", ")}`
  )
  console.log(
    JSON.stringify(
      {
        mode: "self-check",
        repositoryRoot,
        note: "local only: no connection, no SAP access",
        expectation
      },
      null,
      2
    )
  )
  process.exit(0)
}

const label = argument("label")
if (!label) throw new Error("--label=<evidence directory name> is required (or use --self-check)")
const connectionId = argument("connection", "w200")
const directory = argument("dir")
const endpoint = new URL(argument("url", process.env.ABAP_MCP_URL ?? "http://127.0.0.1:4848/mcp"))
assert.ok(
  endpoint.protocol === "http:" &&
    (endpoint.hostname === "127.0.0.1" || endpoint.hostname === "::1") &&
    !endpoint.username &&
    !endpoint.password &&
    endpoint.pathname === "/mcp" &&
    !endpoint.search &&
    !endpoint.hash,
  "Only a loopback MCP service is accepted"
)
const outputDirectory = resolve(repositoryRoot, ".cache", `evidence-${label}`)
await mkdir(outputDirectory, { recursive: false })

const client = new Client({ name: `ops-read-sweep-${label}`, version: expectation.moduleVersion })
const startedAt = new Date().toISOString()

async function call(name, args) {
  const began = Date.now()
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })
  const text = response.content.find((part) => part.type === "text")?.text
  return {
    isError: response.isError === true,
    elapsedMs: Date.now() - began,
    text: typeof text === "string" ? text : JSON.stringify(response.content)
  }
}

/**
 * An answer is evidence only when the service answered. A refusal is a finding about authority or
 * about the platform, and an empty answer is a real observation that must not be dressed up as a
 * positive sample.
 */
function classify(callResult) {
  if (callResult.isError) return "refused"
  const text = callResult.text
  if (/_NOT_AUTHORIZED|NOT_AUTHORIZED/.test(text)) return "refused"
  if (/_FUNCTION_UNVERIFIED|_RFC_FAILED|_RESPONSE_INVALID|_CALL_FAILED|_QUERY_FAILED/.test(text)) {
    return "failed"
  }
  if (/_RESPONSE_EMPTY|"status"\s*:\s*"empty"/.test(text)) return "empty"
  if (/TABLE_NOT_ALLOWED|TABLE_ALLOWLIST_UNVERIFIABLE/.test(text)) return "refused"
  return "answered"
}

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint))
  const served = await client.listTools()
  const servedNames = served.tools.map((tool) => tool.name)
  const servedSurface = surfaceOf(servedNames)
  const absent = expectation.targets.filter((name) => !servedNames.includes(name))
  const extra = servedNames.filter((name) => !TOOL_NAMES.includes(name))

  const runtimeCall = await call("get_runtime_info", {
    expectedVersion: expectation.moduleVersion,
    expectedArtifactFingerprint: expectation.artifactFingerprint
  })
  const runtime = JSON.parse(runtimeCall.text.slice(runtimeCall.text.indexOf("{")))

  const gate = {
    servedSurface,
    localSurface,
    servedToolCount: servedNames.length,
    runtimeChecks: runtime.checks,
    absentTargets: absent,
    toolsServedButNotInSource: extra
  }
  // An artefact check that came back anything but "match" is not a verified build: "unknown" means
  // the service could not fingerprint its own tree, which is not the same as "current".
  const artifactVerified = runtime.checks?.expectedArtifact === "match"
  const stale =
    absent.length > 0 ||
    runtime.checks?.expectedVersion === "mismatch" ||
    !artifactVerified ||
    servedSurface.count !== localSurface.count

  if (stale) {
    await writeFile(
      resolve(outputDirectory, "STALE-BUILD.json"),
      JSON.stringify(
        {
          verdict: "STALE BUILD - no evidence written",
          why: [
            absent.length > 0
              ? `${absent.length} sweep target(s) are not served: ${absent.join(", ")}`
              : undefined,
            runtime.checks?.expectedVersion === "mismatch"
              ? `running module version ${runtime.server?.version} != expected ${expectation.moduleVersion}`
              : undefined,
            !artifactVerified
              ? `artefact check is "${runtime.checks?.expectedArtifact ?? "absent"}", not "match": the running build is not this checkout's dist tree`
              : undefined,
            servedSurface.count !== localSurface.count
              ? `served ${servedSurface.count} tools, this checkout registers ${localSurface.count}`
              : undefined
          ].filter(Boolean),
          remedy:
            "npm run build, then start the service from this checkout (ABAP_MCP_PORT=<free port> " +
            "node dist/src/index.js) and rerun. Restarting an installed release build does not add " +
            "tools: tools and the table allowlist are compile-time constants.",
          gate,
          localExpectation: expectation,
          startedAt
        },
        null,
        2
      )
    )
    console.error("STALE BUILD - no evidence written")
    console.error(JSON.stringify(gate, null, 2))
    process.exit(2)
  }

  // Second gate, one layer below the build check: the sweep is only meaningful when the service can
  // actually read SAP *right now*. Observed live on 2026-09-26 - SAP's public ICF endpoints answered
  // 200 while every authenticated ADT call returned 401 and RFC failed, so a sweep taken then would
  // have written eight `failed` tool outcomes that described an authentication outage rather than the
  // tools. That is the same attribution error this script exists to prevent, so the read path is
  // proven before any tool is called, and an unavailable path writes no evidence at all.
  const reachability = await call("get_sap_system_info", { connectionId })
  let reachable = {}
  try {
    reachable = JSON.parse(reachability.text.slice(reachability.text.indexOf("{")))
  } catch {
    reachable = { status: "unparsable" }
  }
  if (reachable.status !== "ok") {
    await writeFile(
      resolve(outputDirectory, "UNREACHABLE-SAP.json"),
      JSON.stringify(
        {
          verdict: "SAP READ PATH UNAVAILABLE - no evidence written",
          why:
            `get_sap_system_info reported status "${reachable.status}" for connection ` +
            `"${connectionId}"; tool outcomes only mean something once the read path answers`,
          sources: reachable.sources,
          queryWarnings: reachable.queryWarnings,
          observedAt: reachable.queryTimestamp,
          remedy:
            "restore the connection (credentials/authorization/ICF), confirm get_sap_system_info " +
            'returns status "ok", then rerun. Do not record tool failures from an outage.',
          gate
        },
        null,
        2
      )
    )
    console.error("SAP READ PATH UNAVAILABLE - no evidence written")
    console.error(JSON.stringify(reachable.queryWarnings ?? [], null, 2))
    process.exit(4)
  }

  const results = []
  for (const entry of SWEEP) {
    const args = { connectionId, ...entry.args }
    if (entry.requires === "directory") {
      if (!directory) {
        results.push({ ...entry, outcome: "not-run", reason: "--dir was not supplied" })
        continue
      }
      args.directory = directory
    }
    const result = await call(entry.tool, args)
    await writeFile(resolve(outputDirectory, `${entry.tool}.txt`), result.text)
    results.push({
      tool: entry.tool,
      source: entry.source,
      args,
      outcome: classify(result),
      elapsedMs: result.elapsedMs,
      characters: result.text.length,
      evidenceFile: `${entry.tool}.txt`
    })
  }

  const joinPositive = await call("execute_data_query", {
    connectionId,
    displayMode: "internal",
    sql: JOIN_POSITIVE,
    rowRange: { start: 0, end: 50 }
  })
  await writeFile(resolve(outputDirectory, "join-positive.txt"), joinPositive.text)
  const joinNegative = await call("execute_data_query", {
    connectionId,
    displayMode: "internal",
    sql: JOIN_NEGATIVE,
    rowRange: { start: 0, end: 50 }
  })
  await writeFile(resolve(outputDirectory, "join-negative.txt"), joinNegative.text)

  const joins = {
    positive: {
      sql: JOIN_POSITIVE,
      outcome: classify(joinPositive),
      evidenceFile: "join-positive.txt"
    },
    negative: {
      sql: JOIN_NEGATIVE,
      expectation: "refused before any SAP access",
      refusedBeforeSap: /TABLE_NOT_ALLOWED|TABLE_ALLOWLIST_UNVERIFIABLE/.test(joinNegative.text),
      evidenceFile: "join-negative.txt"
    }
  }

  const summary = {
    label,
    startedAt,
    finishedAt: new Date().toISOString(),
    readOnly: true,
    status: "Partially Verified",
    endpoint: endpoint.origin,
    connectionId,
    sapReadPath: { status: reachable.status, sapRelease: reachable.sapRelease ?? null },
    directoryListed: directory ?? null,
    gate,
    results,
    joins
  }
  await writeFile(resolve(outputDirectory, "summary.json"), JSON.stringify(summary, null, 2))

  // The registry delta is a proposal: verification status is applied after the evidence is read.
  const delta = results
    .filter((entry) => entry.outcome === "answered" || entry.outcome === "empty")
    .map((entry) => ({
      tool: entry.tool,
      status: "verified",
      availabilityBasis: "runtime-observed",
      evidence: `.cache/evidence-${label}/${entry.evidenceFile}`,
      note:
        entry.outcome === "empty"
          ? "read-only call succeeded; the system held nothing to return"
          : "read-only call succeeded with rows"
    }))
  const findings = results
    .filter((entry) => entry.outcome !== "answered" && entry.outcome !== "empty")
    .map((entry) => ({ tool: entry.tool, outcome: entry.outcome, evidence: entry.evidenceFile }))
  await writeFile(
    resolve(outputDirectory, "registry-delta.json"),
    JSON.stringify({ label, proposedVerified: delta, notVerifiable: findings, joins }, null, 2)
  )

  console.log(JSON.stringify({ summary, registryDelta: delta, findings }, null, 2))
  process.exit(findings.length ? 3 : 0)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
