import assert from "node:assert/strict"
import test from "node:test"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "../src/mcp.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"
import { toolNamesForProfile } from "../src/tool-registry.js"
import { InvocationReceiptStore } from "../src/invocation-receipts.js"
import { WriteOperationReceiptStore } from "../src/write-operation-receipts.js"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { readFileSync } from "node:fs"
import { configurationBteProtectionLayouts } from "../src/configuration-bte-change.js"

test("public BTE change preparation stays strict and readonly, rejecting command and transport selectors", async (t) => {
  const original = ToolService.prototype.prepareConfigurationBteProductChange,
    calls: unknown[] = []
  ToolService.prototype.prepareConfigurationBteProductChange = async (input) => {
    calls.push(input)
    return JSON.stringify({ readOnly: true, executable: false, writeAvailable: false })
  }
  const backend = new MockBackend()
  backend.callRemoteFunction = async () => {
    throw Error("No SAP call in schema test")
  }
  const root = await mkdtemp(join(tmpdir(), "orvanta-bte-change-"))
  assert(resolve(root).startsWith(resolve(tmpdir()) + sep))
  const server = createMcpServer(
      backend,
      new InvocationReceiptStore(root),
      new WriteOperationReceiptStore(root),
      undefined,
      root
    ),
    client = new Client({ name: "bte-change-schema", version: "r75" })
  const [c, s] = InMemoryTransport.createLinkedPair()
  t.after(async () => {
    ToolService.prototype.prepareConfigurationBteProductChange = original
    await client.close()
    await server.close()
    await rm(root, { recursive: true, force: true })
  })
  await server.connect(s)
  await client.connect(c)
  const name = "prepare_configuration_bte_product_change",
    tool = (await client.listTools()).tools.find((t) => t.name === name)
  assert(tool)
  assert.equal(tool.annotations?.readOnlyHint, true)
  assert.equal(tool.inputSchema.additionalProperties, false)
  assert(toolNamesForProfile("readonly").includes(name))
  assert(toolNamesForProfile("config").includes(name))
  const input = { connectionId: "w200", productName: "ZDEMO", active: false }
  assert.equal((await client.callTool({ name, arguments: input })).isError, undefined)
  for (const patch of [
    { save: true },
    { client: "300" },
    { connectionId: "w300" },
    { tableName: "TBE34" },
    { transportNumber: "GR2K923430" },
    { expectedFingerprint: "bad" }
  ])
    assert.equal((await client.callTool({ name, arguments: { ...input, ...patch } })).isError, true)
  assert.equal(calls.length, 1)
})

test("public SDK returns actual-layout container preparation and propagates a native-layout refusal", async (t) => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/configuration-bte-vim-w200-r76.json", import.meta.url), "utf8")
  )
  const original = {
    preview: ToolService.prototype.previewConfigurationBteProduct,
    metadata: ToolService.prototype.inspectConfigurationBteNativeMetadata,
    table: ToolService.prototype.readDdicTransparentTable,
    definition: ToolService.prototype.readFunctionModuleInterface
  }
  let metadataCalls = 0
  // Only SAP-facing reads are stubbed. The public tool, ToolService and preparation are real.
  ToolService.prototype.previewConfigurationBteProduct = async () =>
    JSON.stringify({
      connectionId: "w200",
      client: "200",
      productName: "ZFICHK",
      executable: false,
      writeAvailable: false,
      fingerprint: "1".repeat(64),
      coverage: { completeWithinBound: true },
      change: {
        key: { MANDT: "200", PRDKT: "ZFICHK" },
        before: fixture.before,
        after: { ...fixture.before, AKTIV: "" },
        changedFields: ["AKTIV"],
        noOp: false
      },
      assignments: { events: [], processes: [] }
    })
  ToolService.prototype.inspectConfigurationBteNativeMetadata = async () => {
    metadataCalls++
    return JSON.stringify({
      connectionId: "w200",
      client: "200",
      status: "native_metadata_read",
      readOnly: true,
      executable: false,
      writeAvailable: false,
      fresh: false,
      fingerprint: "2".repeat(64),
      native: fixture.metadata
    })
  }
  ToolService.prototype.readDdicTransparentTable = async ({ objectName }) => {
    const pin =
      configurationBteProtectionLayouts[
        objectName as keyof typeof configurationBteProtectionLayouts
      ]
    return JSON.stringify({
      connectionId: "w200",
      objectKind: "transparentTable",
      objectName,
      fingerprint: pin.fingerprint,
      definition: {
        tableClass: "TRANSP",
        fields: pin.fields.map((name) => ({
          name,
          key: (pin.keys as readonly string[]).includes(name)
        }))
      }
    })
  }
  ToolService.prototype.readFunctionModuleInterface = async ({ functionName }) =>
    JSON.stringify(fixture.definitions[functionName])
  const backend = new MockBackend()
  backend.runQuery = async (_id, query) => {
    const name = /FROM (TBE24T|TCONT) WHERE/.exec(query)![1]!
    return name === "TBE24T" ? structuredClone(fixture.texts) : []
  }
  backend.callRemoteFunction = async () => {
    throw Error("No configuration/native call allowed")
  }
  const root = await mkdtemp(join(tmpdir(), "orvanta-bte-containers-"))
  assert(resolve(root).startsWith(resolve(tmpdir()) + sep))
  const server = createMcpServer(
    backend,
    new InvocationReceiptStore(root),
    new WriteOperationReceiptStore(root),
    undefined,
    root
  )
  const client = new Client({ name: "bte-containers", version: "r76" })
  const [c, s] = InMemoryTransport.createLinkedPair()
  t.after(async () => {
    ToolService.prototype.previewConfigurationBteProduct = original.preview
    ToolService.prototype.inspectConfigurationBteNativeMetadata = original.metadata
    ToolService.prototype.readDdicTransparentTable = original.table
    ToolService.prototype.readFunctionModuleInterface = original.definition
    await client.close()
    await server.close()
    await rm(root, { recursive: true, force: true })
  })
  await server.connect(s)
  await client.connect(c)
  const input = {
    name: "prepare_configuration_bte_product_change",
    arguments: {
      connectionId: "w200",
      productName: "ZFICHK",
      active: false
    }
  }
  const result = await client.callTool(input)
  assert.equal(result.isError, undefined)
  const output = JSON.parse(
    (result.content as { type: string; text: string }[]).find((c) => c.type === "text")!.text
  )
  assert.equal(output.status, "change_review_prepared")
  assert.equal(
    output.nativeSavePreparation.containers.languageCandidates[0].save.total[0].length,
    109
  )
  assert.equal(
    output.nativeSavePreparation.containers.languageCandidates[0].recover.total[0][43],
    "X"
  )
  assert.equal(output.executable, false)
  assert.equal(output.writeAvailable, false)
  assert.equal(metadataCalls, 1)
  fixture.metadata.ET_NAMTAB[0].FLENGTH = "3"
  const rejected = await client.callTool(input)
  assert.equal(rejected.isError, true)
  assert.match(JSON.stringify(rejected.content), /BTE_SAVE_PLAN_LAYOUT_UNSUPPORTED/)
  assert.equal(metadataCalls, 2)
})
