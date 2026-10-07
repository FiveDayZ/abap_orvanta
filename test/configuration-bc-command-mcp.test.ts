import assert from "node:assert/strict"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { startHttpServer } from "../src/http.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"
import { bcCommandFixture } from "./configuration-bc-command-fixture.js"
import { configurationBcRecordKernel } from "../src/configuration-bc-record-kernel.js"
import {
  configurationBcApplyApi,
  configurationBcRecoverApi
} from "../src/configuration-bc-owner-api.js"

test("SDK HTTP -> public strict schema -> real ToolService -> protected native dispatch/recovery; no generic fallback", async (t) => {
  const f = await bcCommandFixture(t),
    backend = new MockBackend()
  const old = {
    definition: ToolService.prototype.readFunctionModuleInterface,
    table: ToolService.prototype.readDdicTransparentTable,
    structure: ToolService.prototype.readDdicStructure,
    uri: ToolService.prototype.getWorkspaceUri,
    root: process.env.ABAP_MCP_EXPORT_ROOT
  }
  ToolService.prototype.readFunctionModuleInterface = async (input) =>
    JSON.stringify(await f.env.readers.definition(input.functionName))
  ToolService.prototype.readDdicTransparentTable = async (input) =>
    JSON.stringify(await f.env.readers.table(input.objectName))
  ToolService.prototype.readDdicStructure = ToolService.prototype.readDdicTransparentTable
  ToolService.prototype.getWorkspaceUri = async (input) => {
    assert.equal(
      input.objectType,
      input.objectName === configurationBcRecordKernel.includeName ? "PROG/I" : "FUGR/I"
    )
    return `ADT URI: /sap/bc/adt/${input.objectType === "PROG/I" ? "programs/programs" : "functions/groups/zorvanta_bc_cfg/includes"}/${input.objectName.toLowerCase()}`
  }
  const details = backend.connectionDetails.bind(backend)
  backend.connectionDetails = (id) => ({ ...details(id), client: "200", username: "wys" })
  backend.readSourceByUri = async (_id, uri) => {
    assert.ok(
      uri.endsWith("/source/main"),
      "match the real ADT source endpoint, not its metadata URI"
    )
    return {
      uriUsed: uri,
      source: (
        await f.env.readers.include(
          uri
            .replace(/\/source\/main$/, "")
            .split("/")
            .at(-1)!
            .toUpperCase()
        )
      ).join("\r\n")
    }
  }
  backend.callRemoteFunction = f.env.backend.callRemoteFunction
  backend.runQuery = async () => {
    throw Error("No arbitrary SQL fallback")
  }
  backend.callSapHelper = async () => {
    throw Error("No generic helper fallback")
  }
  process.env.ABAP_MCP_EXPORT_ROOT = f.root
  const server = await startHttpServer(backend, 0, f.root),
    client = new Client({ name: "bc-command-r65", version: "r65" })
  t.after(async () => {
    ToolService.prototype.readFunctionModuleInterface = old.definition
    ToolService.prototype.readDdicTransparentTable = old.table
    ToolService.prototype.readDdicStructure = old.structure
    ToolService.prototype.getWorkspaceUri = old.uri
    if (old.root === undefined) delete process.env.ABAP_MCP_EXPORT_ROOT
    else process.env.ABAP_MCP_EXPORT_ROOT = old.root
    await client.close()
    await server.closeIfIdle()
  })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.mcpUrl)) as Parameters<Client["connect"]>[0]
  )
  const list = (await client.listTools()).tools
  for (const [name, readOnly, destructive] of [
    ["apply_configuration_bc_set", false, false],
    ["recover_configuration_bc_set", false, true],
    ["reconcile_configuration_bc_execution", true, false]
  ] as const) {
    const tool = list.find((tool) => tool.name === name)
    assert.ok(tool)
    assert.equal(tool.inputSchema.additionalProperties, false)
    assert.equal(tool.annotations?.readOnlyHint, readOnly)
    assert.equal(tool.annotations?.destructiveHint, destructive)
  }
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args })
  const decode = (r: Awaited<ReturnType<typeof call>>) =>
    JSON.parse((r.content as { text: string }[])[0]!.text)
  for (const patch of [
    { connectionId: "w300" },
    { restoreBytes: "AAAA" },
    { acknowledgeCtsRecording: false }
  ])
    assert.equal(
      (await call("apply_configuration_bc_set", { ...f.request, ...patch })).isError,
      true
    )
  assert.equal(f.calls.length, 0)
  const applied = await call("apply_configuration_bc_set", f.request)
  assert.equal(applied.isError, false)
  assert.equal(decode(applied).status, "applied")
  assert.equal((await call("apply_configuration_bc_set", f.request)).isError, true)
  const receipt = await f.env.receipts.status("w200", f.request.operationId)
  const observation = Object.fromEntries(
    [
      "connectionId",
      "bcSetId",
      "version",
      "requestNumber",
      "taskNumber",
      "operationId",
      "beforeStateReference",
      "effectsReference"
    ].map((name) => [name, f.request[name as keyof typeof f.request]])
  )
  const reconcileInput = {
    ...observation,
    command: "apply",
    expectedReceiptHash: receipt.receiptHash
  }
  assert.equal(
    (
      await call("reconcile_configuration_bc_execution", {
        ...reconcileInput,
        expectedReceiptHash: "f".repeat(64)
      })
    ).isError,
    true
  )
  assert.equal(f.calls.length, 1)
  const observed = await call("reconcile_configuration_bc_execution", reconcileInput)
  assert.equal(observed.isError, undefined)
  assert.equal(decode(observed).status, "native_commit_observed")
  assert.deepEqual(await f.env.receipts.status("w200", f.request.operationId), receipt)
  const { acknowledgeCtsRecording: _, ...scope } = f.request
  const recovery = {
    ...scope,
    operationId: "r65-recover-0001",
    applyOperationId: f.request.operationId,
    applyReceiptHash: receipt.receiptHash,
    acknowledgeCtsKeyCleanup: true
  }
  const restored = await call("recover_configuration_bc_set", recovery)
  assert.equal(restored.isError, false)
  assert.equal(decode(restored).status, "recovered")
  assert.deepEqual(f.calls, [
    configurationBcApplyApi.functionName,
    "Z_ORVANTA_CFG_BC_RECONCILE",
    configurationBcRecoverApi.functionName
  ])
  assert.equal(JSON.stringify(restored).includes("FRAME_BASE64"), false)
})
