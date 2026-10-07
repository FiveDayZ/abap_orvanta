import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { startHttpServer } from "../src/http.js"
import { ToolService } from "../src/tools.js"
import { PreSapValidationError } from "../src/pre-sap-validation.js"
import { MockBackend } from "./mock-backend.js"

const input = (language: string) => ({
  connectionId: "w200",
  objectName: "ZTESTNR",
  description: "number range language guard",
  packageName: "ZABAP",
  transportNumber: "W20K900001",
  properties: { DOMLEN: "NUMC20", BUFFER: "" },
  texts: [{ language, text: "计量验收", shortText: "验收" }]
})

test("number range object preserves numeric Chinese SAP language and refuses invalid keys before backend", async () => {
  const backend = new MockBackend(),
    original = backend.callSapDdic.bind(backend)
  const sent: Parameters<typeof backend.callSapDdic>[1][] = []
  backend.callSapDdic = async (connectionId, request) => {
    sent.push(request)
    return original(connectionId, request)
  }
  const tools = new ToolService(backend)
  for (const language of ["1", " e "]) {
    const current = JSON.parse(
      await tools.readNumberRangeObject({ connectionId: "w200", objectName: "ZTESTNR" })
    )
    await tools.upsertNumberRangeObject({ ...input(language), expectedVersion: current.version })
    assert.equal(sent.at(-1)!.numberRangeTexts![0]!.LANGU, language.trim().toUpperCase())
  }
  sent.length = 0
  for (const language of ["ZH", "", ":", "中"]) {
    await assert.rejects(tools.upsertNumberRangeObject(input(language)), PreSapValidationError)
  }
  assert.deepEqual(sent, [])
})

test("public local number range language rejection never claims SAP dispatch or unknown write", async () => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-nrob-language-")),
    backend = new MockBackend(),
    original = backend.callSapDdic.bind(backend)
  const writes: string[] = []
  backend.callSapDdic = async (connection, request) => {
    if (request.operation.startsWith("UPSERT_")) writes.push(request.operation)
    return original(connection, request)
  }
  const running = await startHttpServer(backend, 0, root),
    client = new Client({ name: "number-range-language-receipt", version: "r41" })
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(running.mcpUrl)) as Parameters<Client["connect"]>[0]
    )
    const operationId = "nrob-invalid-language",
      rejected = await client.callTool({
        name: "upsert_number_range_object",
        arguments: { ...input("ZH"), operationId }
      })
    assert.equal(rejected.isError, true)
    const observed = await client.callTool({
      name: "get_write_operation_status",
      arguments: { connectionId: "w200", operationId }
    })
    assert.ok(Array.isArray(observed.content))
    const receipt = JSON.parse((observed.content as { text: string }[])[0]!.text)
    assert.equal(receipt.status, "failed")
    assert.equal(receipt.sapInvocationStarted, false)
    assert.equal(receipt.outcomeMayBeUnknown, false)
    assert.deepEqual(writes, [])
  } finally {
    await client.close()
    await running.close()
    await rm(root, { recursive: true, force: true })
  }
})
