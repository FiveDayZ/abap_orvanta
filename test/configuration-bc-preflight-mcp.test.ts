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
import { preflightFixture } from "./configuration-bc-preflight-fixture.js"

test("public MCP preflight validates eight version/scope fields and dispatches readonly composition", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-bc-preflight-mcp-")),
    fixture = preflightFixture(),
    backend = new MockBackend()
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  const original = {
    snapshot: ToolService.prototype.readConfigurationBcNativeSnapshot,
    preview: ToolService.prototype.previewConfigurationBcNative,
    route: ToolService.prototype.inspectConfigurationBcRoute,
    guard: ToolService.prototype.readConfigurationBcGuard,
    definition: ToolService.prototype.readFunctionModuleInterface
  }
  const {
    nativeCandidateVersion: _candidate,
    nativeGuardVersion: _guard,
    ...guardInput
  } = fixture.input
  const { nativeMetadataVersion: _metadata, ...previewInput } = guardInput
  const {
    nativeSourceVersion: _source,
    nativeTargetVersion: _target,
    ...snapshotInput
  } = previewInput
  let deny = false
  ToolService.prototype.readConfigurationBcNativeSnapshot = async (raw) => {
    assert.deepEqual(raw, snapshotInput)
    return JSON.stringify(await fixture.readers.snapshot())
  }
  ToolService.prototype.previewConfigurationBcNative = async (raw) => {
    assert.deepEqual(raw, previewInput)
    return JSON.stringify(await fixture.readers.preview())
  }
  ToolService.prototype.inspectConfigurationBcRoute = async (raw) => {
    assert.deepEqual(raw, previewInput)
    return JSON.stringify(await fixture.readers.route())
  }
  ToolService.prototype.readConfigurationBcGuard = async (raw) => {
    assert.deepEqual(raw, guardInput)
    if (deny) throw Error("AUTHORIZATION_DENIED")
    return JSON.stringify(await fixture.readers.guard())
  }
  ToolService.prototype.readFunctionModuleInterface = async function (raw) {
    assert.equal(raw.connectionId, "w200")
    // Exercise the scoped backend beneath composition rather than bypassing its closing check.
    await this.readDdicDomain({ connectionId: "w200", objectName: "CHAR10" })
    return JSON.stringify(await fixture.readers.definition(raw.functionName))
  }
  backend.callRemoteFunction = async () => {
    throw Error("No generic RPC or write fallback")
  }
  backend.runQuery = async () => {
    throw Error("No generic query fallback")
  }
  const server = await startHttpServer(backend, 0, root),
    client = new Client({ name: "preflight-public-contract", version: "r50" })
  t.after(async () => {
    ToolService.prototype.readConfigurationBcNativeSnapshot = original.snapshot
    ToolService.prototype.previewConfigurationBcNative = original.preview
    ToolService.prototype.inspectConfigurationBcRoute = original.route
    ToolService.prototype.readConfigurationBcGuard = original.guard
    ToolService.prototype.readFunctionModuleInterface = original.definition
    await client.close()
    await server.closeIfIdle()
    await rm(root, { recursive: true, force: true })
  })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.mcpUrl)) as Parameters<Client["connect"]>[0]
  )
  const listed = await client.listTools(),
    tool = listed.tools.find((t) => t.name === "preflight_configuration_bc_activation")
  assert.ok(tool)
  assert.equal(tool.inputSchema.additionalProperties, false)
  assert.deepEqual([...(tool.inputSchema.required ?? [])].sort(), Object.keys(fixture.input).sort())
  assert.equal(tool.annotations?.readOnlyHint, true)
  assert.equal(tool.annotations?.destructiveHint, false)
  const result = await client.callTool({ name: tool.name, arguments: fixture.input })
  assert.equal(result.isError, undefined)
  const positive = JSON.parse((result.content as { text: string }[])[0]!.text)
  assert.equal(positive.rows.length, 19)
  assert.equal(positive.activationAvailable, false)
  assert.equal(positive.evidence.metadataReuse.uniqueReads, 1)
  assert.equal(positive.evidence.metadataReuse.freshRechecks, 1)
  assert.equal(positive.evidence.metadataReuse.completeFreshRecheck, true)
  const beforeRefusals = { ...fixture.counts }
  for (const invalid of [
    { connectionId: "w300" },
    { nativeCandidateVersion: "" },
    { activate: true },
    { transportRequest: "GR2K923429" }
  ]) {
    const response = await client.callTool({
      name: tool.name,
      arguments: { ...fixture.input, ...invalid }
    })
    assert.equal(response.isError, true)
  }
  assert.deepEqual(fixture.counts, beforeRefusals)
  deny = true
  const negative = await client.callTool({ name: tool.name, arguments: fixture.input })
  assert.equal(negative.isError, true)
  const text = (negative.content as { text: string }[])[0]!.text
  assert.match(text, /AUTHORIZATION_DENIED/)
  assert.ok(!text.includes('"rows"'), "failed call must not publish partial data")
  deny = false
  const ddicRead = backend.callSapDdic.bind(backend)
  let domainCalls = 0
  backend.callSapDdic = async (connection, request) => {
    const response = await ddicRead(connection, request)
    if (++domainCalls === 2) response.header.DOMNAME = "changed only at closing read"
    return response
  }
  const drift = await client.callTool({ name: tool.name, arguments: fixture.input })
  assert.equal(drift.isError, true)
  const driftText = (drift.content as { text: string }[])[0]!.text
  assert.match(driftText, /METADATA_CHANGED/)
  assert.ok(!driftText.includes('"rows"'))
  assert.equal(domainCalls, 2)
})
