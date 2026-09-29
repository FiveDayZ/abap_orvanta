/**
 * Read-only live-state probe for the operations coverage claim.
 *
 * Why this exists: `docs/ops-acceptance-matrix.md` and the verification registry are built from the
 * *source* tables plus the recorded evidence files, so neither of them can say whether the SAP-side
 * helper a family depends on is deployed right now. The coverage question has two halves - what the
 * surface declares and what the system actually answers - and this probe reads the second half from
 * the running service's own capability report.
 *
 * It is diagnostic, not a test: it calls only read-only tools, writes nothing to SAP, and never
 * mutates the verification registry. Its output is the machine reading the acceptance criteria ask
 * for, so a coverage statement can cite it instead of citing prose.
 *
 * Usage:
 *   node scripts/probe-ops-live-state.mjs [--url=http://127.0.0.1:4848/mcp] [--connection=w200]
 *   [--json=<path>] [--registry]
 *
 * `--registry` also prints, per outstanding required family, which present tools are not yet
 * `verified` in the local verification registry - the evidence gap beside the capability gap.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { OPS_FAMILIES, opsFamilyState } from "../dist/src/ops-coverage.js"
import { registryEntry } from "../dist/src/tool-registry.js"

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
const withRegistry = process.argv.includes("--registry")

const client = new Client({ name: "ops-live-state-probe", version: "1.0.0" })

function textOf(result) {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

async function call(name, args) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })
  const text = textOf(response)
  return { isError: response.isError === true, text }
}

/**
 * Local registry reading. Loaded from the JSON contract directly rather than through the compiled
 * module, so a probe of a stale build still reports the checkout's own evidence state.
 */
async function localRegistry() {
  const raw = await import("../dist/src/verification-registry.js")
  const lookup = raw.loadVerificationRegistry ? await raw.loadVerificationRegistry() : undefined
  return lookup
}

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint))

  const runtime = await call("get_runtime_info", {})
  const connected = await call("get_connected_systems", {})
  const report = await call("get_capability_report", { connectionId })

  let parsed
  let parseError
  try {
    parsed = JSON.parse(report.text.slice(report.text.indexOf("{")))
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error)
  }

  const helpers = parsed?.helpers ?? []
  const ops = parsed?.opsCapability
  const summary = ops?.summary

  const outstanding = (ops?.families ?? [])
    .filter((family) => !family.exempt)
    .filter((family) => {
      const closed = family.state === "read-only" || family.state === "read-and-act"
      return !closed || !family.verification.closed
    })
    .map((family) => ({
      id: family.id,
      state: family.state,
      gap: family.gap ? "declared" : "",
      missingTools: family.missingToolNames,
      unverifiedTools: family.verification.blockingTools,
      routes: family.closeRoutes
    }))

  const output = {
    probe: "ops-live-state",
    readOnly: true,
    endpoint: endpoint.origin,
    connectionId,
    observedAt: new Date().toISOString(),
    runtime: runtime.isError
      ? { error: runtime.text }
      : JSON.parse(runtime.text.slice(runtime.text.indexOf("{"))),
    connected: connected.isError
      ? { error: connected.text }
      : JSON.parse(connected.text.slice(connected.text.indexOf("{"))),
    capabilityReportReadable: parsed !== undefined,
    ...(parseError ? { capabilityReportParseError: parseError } : {}),
    helpers: helpers.map((helper) => ({
      name: helper.name,
      availability: helper.availability,
      protocolVersion: helper.protocolVersion ?? null,
      detail: helper.detail ?? undefined
    })),
    coverageFromReport: summary
      ? {
          familyCount: summary.familyCount,
          stateCounts: summary.stateCounts,
          closedRequiredFamilyCount: summary.closedRequiredFamilyCount,
          requiredEndToEndFamilyCount: summary.requiredEndToEndFamilyCount,
          endToEndPercentOfRequired: summary.endToEndPercentOfRequired,
          criterionMet: summary.criterionMet,
          criterionBasis: summary.criterionBasis,
          evidenceClosedFamilies: summary.evidenceClosedFamilies,
          outstandingRequiredFamilies: summary.outstandingRequiredFamilies,
          missingPlannedTools: summary.missingPlannedTools
        }
      : undefined,
    outstandingDetail: outstanding,
    sourceTables: {
      note: "state derived from this checkout's src/ops-coverage.ts, for cross-checking the report",
      families: OPS_FAMILIES.map((family) => ({ id: family.id, state: opsFamilyState(family) }))
    }
  }

  if (withRegistry) {
    const lookup = await localRegistry()
    const entries = lookup?.entries
    // Three shapes are possible depending on the registry revision: a Map, an array of entries, or a
    // record keyed by tool name. `Object.entries` on an array would hand back the *index* as the key
    // and silently drop every tool name, so each shape is handled explicitly.
    const pairs =
      entries instanceof Map
        ? [...entries.entries()]
        : Array.isArray(entries)
          ? entries.map((entry) => [entry.tool, entry])
          : Object.entries(entries ?? {})
    output.localRegistry = lookup
      ? pairs
          .filter(([, entry]) => entry.status !== "verified")
          .map(([tool, entry]) => ({
            tool,
            status: entry.status,
            evidence: entry.evidence ?? null
          }))
          .filter((entry) => registryEntry(entry.tool)?.group === "ops")
      : { error: "loadVerificationRegistry not exported by this build" }
  }

  const json = JSON.stringify(output, null, 2)
  const path = argument("json")
  if (path) {
    await mkdir(dirname(resolve(path)), { recursive: true })
    await writeFile(resolve(path), json)
  }
  console.log(json)

  const unreadable = !parsed
  const repository = helpers.find((helper) => helper.name === "repository")
  process.exit(unreadable || (repository && repository.availability !== "available") ? 3 : 0)
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exit(1)
} finally {
  await client.close()
}
