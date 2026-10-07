import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { startHttpServer } from "../src/http.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"
import {
  configurationBcGuardApi as api,
  configurationBcGuardLayouts as layouts
} from "../src/configuration-bc-guard-api.js"
import { configurationBcGuardKeys as keys } from "../src/configuration-bc-guard.js"
import { configurationBcPreviewSourceVersion as source } from "../src/configuration-bc-preview.js"
import type { RemoteFunctionValue } from "../src/backend.js"

test("public guard MCP dispatches valid readonly calls and rejects invalid scope before reads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-bc-guard-mcp-")),
    backend = new MockBackend(),
    version = "a".repeat(64)
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  const input = {
    connectionId: "w200",
    bcSetId: "EHS_CUNI_KNM",
    version: "N",
    nativeSourceVersion: source,
    nativeTargetVersion: version,
    nativeMetadataVersion: version
  }
  const output: Record<string, RemoteFunctionValue> = {
    EV_CODE: "GUARD_READ_OK",
    EV_SYSTEM: "GR2",
    EV_CLIENT: "200",
    EV_USER: "WYS",
    EV_SOURCE_VERSION: source,
    EV_TARGET_VERSION: version,
    EV_METADATA_VERSION: version,
    EV_GUARD_VERSION: version
  }
  for (const name of Object.keys(layouts) as (keyof typeof layouts)[])
    output[`ET_${name}`] = keys
      .filter((k) => k.tableName === name)
      .map((k) => ({
        ...Object.fromEntries(layouts[name].fields.map((f) => [f, ""])),
        ...k.key
      }))
  const originals = {
    route: ToolService.prototype.inspectConfigurationBcRoute,
    table: ToolService.prototype.readDdicTransparentTable,
    definition: ToolService.prototype.readFunctionModuleInterface
  }
  let reads = 0,
    calls = 0,
    deny = false
  ToolService.prototype.inspectConfigurationBcRoute = async (raw) => {
    reads++
    assert.deepEqual(raw, {
      connectionId: input.connectionId,
      bcSetId: input.bcSetId,
      version: input.version,
      nativeSourceVersion: source,
      nativeTargetVersion: version
    })
    return JSON.stringify({
      ...input,
      client: "200",
      readOnly: true,
      executable: false,
      activationAvailable: false,
      methodExecutionAvailable: false,
      snapshot: false,
      metadataVersion: version,
      object: { name: "CUNI", type: "T", transportType: "TDAT" },
      members: ["T006", "T006A", "T006B", "T006C", "T006D", ...Object.keys(layouts)].map(
        (TABNAME) => ({ OBJECTNAME: "CUNI", OBJECTTYPE: "T", TABNAME })
      ),
      methods: [],
      methodSources: [],
      native: {
        EV_SYSTEM: "GR2",
        EV_CLIENT: "200",
        EV_USER: "WYS",
        EV_SOURCE_VERSION: source,
        EV_TARGET_VERSION: version,
        EV_METADATA_VERSION: version,
        ET_OBJH: [{ CLIDEP: "X", LANGDEP: "X" }]
      }
    })
  }
  ToolService.prototype.readDdicTransparentTable = async ({ objectName }) => {
    reads++
    assert.ok(objectName in layouts)
    const layout = layouts[objectName as keyof typeof layouts]
    return JSON.stringify({
      connectionId: "w200",
      objectKind: "transparentTable",
      objectName,
      fingerprint: layout.fingerprint,
      definition: {
        fields: layout.fields.map((name) => ({
          name,
          key: (layout.keys as readonly string[]).includes(name)
        }))
      }
    })
  }
  ToolService.prototype.readFunctionModuleInterface = async ({ functionName }) => {
    reads++
    assert.equal(functionName, api.functionName)
    return JSON.stringify({
      ...api,
      connectionId: "w200",
      updateTask: false,
      updateTaskMode: "",
      sourceFingerprint: version,
      interfaceFingerprint: version,
      changingParameters: [],
      exceptions: [],
      source: [`FUNCTION ${api.functionName}.`, ...api.source, "ENDFUNCTION."]
    })
  }
  backend.callRemoteFunction = async (connection, request) => {
    calls++
    assert.equal(connection, "w200")
    assert.equal(request.functionName, api.functionName)
    for (const p of api.tableParameters) assert.deepEqual(request.inputParameters[p.name], [])
    return {
      outputs: {
        ...structuredClone(output),
        EV_CODE: deny ? "AUTHORIZATION_DENIED" : "GUARD_READ_OK"
      }
    }
  }
  backend.runQuery = async () => {
    throw Error("No generic query fallback allowed")
  }
  const server = await startHttpServer(backend, 0, root),
    client = new Client({ name: "guard-public-schema", version: "1" })
  t.after(async () => {
    ToolService.prototype.inspectConfigurationBcRoute = originals.route
    ToolService.prototype.readDdicTransparentTable = originals.table
    ToolService.prototype.readFunctionModuleInterface = originals.definition
    await client.close()
    await server.closeIfIdle()
    await rm(root, { recursive: true, force: true })
  })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.mcpUrl)) as Parameters<Client["connect"]>[0]
  )
  const listed = await client.listTools(),
    tool = listed.tools.find((t) => t.name === "read_configuration_bc_guard")
  assert.ok(tool)
  assert.equal(tool.annotations?.readOnlyHint, true)
  assert.equal(tool.inputSchema.additionalProperties, false)
  const positive = await client.callTool({ name: tool.name, arguments: input })
  assert.equal(positive.isError, undefined)
  const result = JSON.parse((positive.content as { text: string }[])[0]!.text)
  assert.equal(result.states.length, 8)
  assert.ok(result.states.every((s: { status: string }) => s.status === "present"))
  assert.equal(result.guardVersion, version)
  assert.equal(result.executable, false)
  assert.equal(result.scope.allCuniKeys, false)
  assert.equal(calls, 2)
  assert.equal(reads, 12)
  for (const invalid of [
    { ...input, connectionId: "w300" },
    { ...input, nativeMetadataVersion: "short" },
    { ...input, unitKey: "KG" },
    { ...input, activate: true }
  ]) {
    const r = await client.callTool({ name: tool.name, arguments: invalid })
    assert.equal(r.isError, true)
  }
  assert.equal(calls, 2)
  assert.equal(reads, 12)
  deny = true
  const rejection = await client.callTool({ name: tool.name, arguments: input })
  assert.equal(rejection.isError, true)
  const error = (rejection.content as { text: string }[])[0]!.text
  assert.match(error, /AUTHORIZATION_DENIED/)
  assert.ok(!error.includes('"states"'))
  assert.equal(calls, 3)
})
