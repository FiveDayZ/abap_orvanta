import { mkdir, writeFile } from "node:fs/promises"
import { pathToFileURL, fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  nativeUnitStaleInputSchema,
  prepareNativeUnitStale
} from "../dist/src/configuration-unit-native-safety.js"

export function validateUnitSafetyEndpoint(raw) {
  const endpoint = new URL(raw)
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/mcp"
  )
    throw Error("NATIVE_SAFETY_ENDPOINT_INVALID")
  return endpoint
}

/** Only MCP reads. Native execution is a separate explicitly approved isolated-driver call. */
export async function prepareUnitStaleViaMcp(client, raw) {
  const input = nativeUnitStaleInputSchema.parse(raw)
  const tools = (await client.listTools()).tools
  for (const name of [
    "read_function_module_interface",
    "read_configuration_unit",
    "inspect_configuration_transport"
  ])
    if (!tools.some((tool) => tool.name === name && tool.annotations?.readOnlyHint === true))
      throw Error("NATIVE_SAFETY_READ_TOOL_UNAVAILABLE")
  const unit = tools.find((tool) => tool.name === "read_configuration_unit")
  if (!unit.inputSchema.properties?.includeApiSnapshot)
    throw Error("NATIVE_SAFETY_NATIVE_READER_SCHEMA_UNAVAILABLE")
  const call = async (name, args) => {
    const response = await client.callTool(
      { name, arguments: { connectionId: "w200", ...args } },
      undefined,
      { timeout: 120_000 }
    )
    if (response.isError) throw Error("NATIVE_SAFETY_MCP_READ_FAILED")
    return JSON.parse(
      response.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
    )
  }
  return prepareNativeUnitStale(input, {
    readDefinition: () =>
      call("read_function_module_interface", { functionName: "Z_ORVANTA_CFG_UNIT_APPLY" }),
    readUnit: () =>
      call("read_configuration_unit", { unitKey: "KG", language: "ZH", includeApiSnapshot: true }),
    inspectTransport: () =>
      call("inspect_configuration_transport", {
        requestNumber: "GR2K923429",
        taskNumber: "GR2K923430",
        unitText: { unitKey: "KG", language: "ZH" }
      }),
    ...(tools.some(
      (tool) => tool.name === "search_sap_locks" && tool.annotations?.readOnlyHint === true
    )
      ? {
          readLocks: (argument) =>
            call("search_sap_locks", { username: "WYS", argument, maxResults: 100 })
        }
      : {})
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2)
    throw Error("Preparation takes no CLI flags; native execution is not available here")
  const endpoint = validateUnitSafetyEndpoint(
    process.env.ABAP_MCP_ENDPOINT || "http://127.0.0.1:4849/mcp"
  )
  const client = new Client({
    name: "orvanta-unit-native-stale-readonly-preparation",
    version: "r36"
  })
  const report = {
    startedAt: new Date().toISOString(),
    mode: "read_only_preparation",
    nativeInvoked: false,
    nativeWriterCalls: 0,
    status: "Partially Verified"
  }
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint))
    report.plan = await prepareUnitStaleViaMcp(client, {
      connectionId: "w200",
      unitKey: "KG",
      language: "ZH",
      requestNumber: "GR2K923429",
      taskNumber: "GR2K923430",
      operationId: "unit-native-stale-" + report.startedAt.replace(/[^0-9]/g, "")
    })
    report.status = "prepared_native_execution_pending"
  } catch (error) {
    report.blocker =
      error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "NATIVE_SAFETY_PREPARATION_FAILED"
    process.exitCode = 2
  } finally {
    await client.close()
    report.finishedAt = new Date().toISOString()
    const root = new URL("../../.doc/", import.meta.url)
    await mkdir(root, { recursive: true })
    const path = new URL(
      `orvanta-unit-native-safety-preparation-${report.startedAt.replace(/[:.]/g, "-")}.json`,
      root
    )
    await writeFile(path, JSON.stringify(report, null, 2) + "\n", { flag: "wx" })
    console.log(
      JSON.stringify({
        status: report.status,
        blocker: report.blocker ?? null,
        nativeWriterCalls: 0,
        evidence: fileURLToPath(path)
      })
    )
  }
}
