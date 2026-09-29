/**
 * Read-channel layer diagnostic (read-only).
 *
 * Why this exists: when several tools fail at once, the failure text alone cannot distinguish
 * "the tool is broken" from "the channel underneath it is broken". The 2026-09-29 incident made that
 * concrete - the repository helper `Z_ORVANTA_MCP_DYNPRO_API` was left as an interface-only shell by
 * a failed carrier run, and every tool routed through it answered with an incomplete SOAP response
 * while the base helper still reported READY. Recording those answers as tool failures would have
 * attributed a SAP-side defect to the tools.
 *
 * So this probe separates the layers, one representative tool per channel:
 *
 *   base helper      `sap_helper_status`            - is SAP reachable at all
 *   ADT + server facts `get_sap_system_info`        - is the authenticated ADT/RFC read path up
 *   service-side RFC  `read_work_processes`          - TH_WPINFO, no helper involved
 *   MAINT helper      `search_failed_updates`        - Z_ORVANTA_MAINT_READ
 *   OPS helper        `read_background_job_spool`    - Z_ORVANTA_OPS_READ
 *   repository helper `manage_transport_requests`    - Z_ORVANTA_MCP_DYNPRO_API
 *
 * It calls read-only tools only, writes nothing to SAP, and records nothing in the verification
 * registry. A layer that answers "unavailable" describes the channel, not the tool, and the report
 * says so rather than filing a tool failure.
 *
 * Usage: node scripts/probe-read-channel.mjs [--url=http://127.0.0.1:4848/mcp] [--connection=w200]
 */

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

/**
 * One representative read per channel layer.
 *
 * The tools that need an exact business key (`search_failed_updates` wants a user plus a SAP-local
 * window, `read_failed_update` a V1 key, `read_background_job_spool` a job/step/spool id) are
 * deliberately absent: calling them with an invented key would produce an input rejection that says
 * nothing about the channel. Their layers are represented by a tool on the same channel that needs no
 * key - `read_archive_status` and `read_ccms_alerts` also read inside the MAINT helper.
 */
const LAYERS = [
  { layer: "base-helper", tool: "sap_helper_status", args: { action: "ping" }, helper: null },
  { layer: "adt-server-facts", tool: "get_sap_system_info", args: {}, helper: null },
  { layer: "maint-helper", tool: "read_archive_status", args: {}, helper: "Z_ORVANTA_MAINT_READ" },
  {
    layer: "repository-helper",
    tool: "manage_transport_requests",
    args: { action: "get_user_transports" },
    helper: "Z_ORVANTA_MCP_DYNPRO_API"
  },
  {
    layer: "repository-helper",
    tool: "read_function_module_interface",
    args: { functionName: "Z_ORVANTA_MCP_DYNPRO_API" },
    helper: "Z_ORVANTA_MCP_DYNPRO_API"
  },
  { layer: "service-side-rfc", tool: "read_work_processes", args: { maxRows: 5 }, helper: null },
  { layer: "service-side-rfc", tool: "read_user_sessions", args: { maxRows: 5 }, helper: null },
  {
    layer: "service-side-rfc",
    tool: "read_file_system_directory",
    args: { directory: "/usr/sap/trans", maxRows: 5 },
    helper: null
  },
  { layer: "service-side-rfc", tool: "read_workload_directory", args: { maxRows: 5 }, helper: null }
]

const client = new Client({ name: "read-channel-probe", version: "1.0.0" })

/** Classify one answer by channel health, never by the tool's subject matter. */
function classify(text, isError) {
  if (/Input validation error/i.test(text)) return "probe-input-error"
  if (
    /incomplete SOAP response|SOAP response could not be|xmlParseEntityRef|not well-formed/i.test(
      text
    )
  ) {
    return "channel-broken"
  }
  if (/_FUNCTION_UNVERIFIED|_FINGERPRINT_MISMATCH/.test(text)) return "helper-not-deployed"
  if (/_NOT_AUTHORIZED/.test(text)) return "not-authorized"
  if (/socket hang up|ECONNRESET|ETIMEDOUT|_CALL_FAILED|TCP/.test(text)) return "sap-call-failed"
  if (
    /_RFC_FAILED|_QUERY_FAILED|_RESPONSE_INVALID|_RESPONSE_EMPTY|SERVER_FACTS_CALL_FAILED/.test(
      text
    )
  ) {
    return "sap-side-failure"
  }
  const status = /"status"\s*:\s*"([a-z-]+)"/.exec(text)?.[1]
  if (status === "ok") return "answered"
  if (status === "partial") return "answered-partial"
  if (status === "empty") return "answered-empty"
  if (status === "unavailable") return "unavailable"
  if (isError) return "refused"
  return status ? `status:${status}` : "unclassified"
}

const rows = []
try {
  await client.connect(new StreamableHTTPClientTransport(endpoint))
  for (const entry of LAYERS) {
    const began = Date.now()
    let text = ""
    let isError = false
    try {
      const response = await client.callTool(
        { name: entry.tool, arguments: { connectionId, ...entry.args } },
        undefined,
        { timeout: 90000 }
      )
      text = response.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
      isError = response.isError === true
    } catch (error) {
      text = error instanceof Error ? error.message : String(error)
      isError = true
    }
    const warnings = [...text.matchAll(/"([A-Z0-9_]{6,})"/g)]
      .map((match) => match[1])
      .filter((code) => /_(FAILED|INVALID|UNVERIFIED|EMPTY|MISMATCH)$/.test(code))
    rows.push({
      layer: entry.layer,
      tool: entry.tool,
      helper: entry.helper,
      verdict: classify(text, isError),
      status: /"status"\s*:\s*"([a-z-]+)"/.exec(text)?.[1] ?? null,
      errorCodes: [...new Set(warnings)].slice(0, 6),
      elapsedMs: Date.now() - began,
      bytes: text.length,
      head: text.replace(/\s+/g, " ").slice(0, 200)
    })
  }

  const byLayer = {}
  for (const row of rows) {
    byLayer[row.layer] = byLayer[row.layer] ?? { tools: 0, answered: 0, verdicts: {} }
    byLayer[row.layer].tools++
    byLayer[row.layer].verdicts[row.verdict] = (byLayer[row.layer].verdicts[row.verdict] ?? 0) + 1
    if (
      row.verdict === "answered" ||
      row.verdict === "answered-partial" ||
      row.verdict === "answered-empty"
    ) {
      byLayer[row.layer].answered++
    }
  }

  console.log(
    JSON.stringify(
      {
        probe: "read-channel",
        readOnly: true,
        registryUntouched: true,
        endpoint: endpoint.origin,
        connectionId,
        observedAt: new Date().toISOString(),
        byLayer,
        rows
      },
      null,
      2
    )
  )
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exit(1)
} finally {
  await client.close()
}
