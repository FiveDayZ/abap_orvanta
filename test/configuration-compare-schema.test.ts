import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { z } from "zod"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { toolContracts } from "../src/contracts.js"
import { startHttpServer } from "../src/http.js"
import { MockBackend } from "./mock-backend.js"

async function withClient(run: (client: Client, backend: MockBackend) => Promise<void>) {
  const stateRoot = await mkdtemp(join(tmpdir(), "orvanta-compare-schema-"))
  const backend = new MockBackend()
  const running = await startHttpServer(backend, 0, stateRoot)
  const client = new Client({ name: "configuration-compare-schema-test", version: "1" })
  try {
    const transport = new StreamableHTTPClientTransport(new URL(running.mcpUrl))
    await client.connect(transport as Parameters<Client["connect"]>[0])
    await run(client, backend)
  } finally {
    await client.close()
    await running.close()
    assert.equal(dirname(stateRoot), resolve(tmpdir()))
    await rm(stateRoot, { recursive: true, force: true })
  }
}

test("MCP advertises comparison inputs and rejects invalid comparisons before SAP", async () => {
  await withClient(async (client, backend) => {
    let sapCalls = 0
    const unexpectedSap = async () => {
      sapCalls++
      assert.fail("invalid comparison must not reach SAP")
    }
    backend.runQuery = unexpectedSap
    backend.callSapDdic = unexpectedSap
    backend.callSapRepository = unexpectedSap
    backend.callRemoteFunction = unexpectedSap
    const tool = (await client.listTools()).tools.find(
      (entry) => entry.name === "compare_configuration_unit"
    )!
    assert.deepEqual(Object.keys(tool.inputSchema.properties!).sort(), [
      "from",
      "ignoreFields",
      "language",
      "to",
      "unitKey"
    ])
    assert.deepEqual([...tool.inputSchema.required!].sort(), ["from", "language", "to", "unitKey"])
    assert.equal(tool.inputSchema.additionalProperties, false)
    assert.equal(tool.annotations?.readOnlyHint, true)
    const base = { from: "w200", to: "w300", unitKey: "KG", language: "ZH" }
    for (const args of [
      { ...base, to: "w200" },
      { ...base, ignoreFields: ["T006.MANDT"] },
      { ...base, ignoreFields: ["T006A.SPRAS"] },
      { ...base, ignoreFields: ["T006A.UNKNOWN"] },
      { ...base, language: undefined },
      { ...base, execute: true },
      { ...base, patch: { MSEHL: "test" } },
      { ...base, ignoreFields: Array(1000).fill("T006A.MSEHL") }
    ])
      assert.equal((await client.callTool({ name: tool.name, arguments: args })).isError, true)
    assert.equal(sapCalls, 0)
  })
})

test("MCP preserves valid comparison parameters and reports an unavailable side as incomparable", async () => {
  await withClient(async (client, backend) => {
    const observedConnections: string[] = []
    const originalDetails = backend.connectionDetails.bind(backend)
    backend.connectionDetails = (connectionId) => {
      observedConnections.push(connectionId)
      return {
        ...originalDetails("w200"),
        client: connectionId === "w200" ? "200" : "300"
      }
    }
    backend.callSapDdic = async () => {
      throw new Error("fixture deliberately unavailable")
    }
    for (const ignoreFields of [undefined, ["T006A.MSEHL"]]) {
      observedConnections.length = 0
      const result = await client.callTool({
        name: "compare_configuration_unit",
        arguments: {
          from: "w300",
          to: "w200",
          unitKey: "kg",
          language: "EN",
          ...(ignoreFields ? { ignoreFields } : {})
        }
      })
      assert.notEqual(result.isError, true)
      const blocks = result.content as { type: string; text?: string }[]
      const body = JSON.parse(
        blocks
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("")
      )
      assert.equal(body.from, "w300")
      assert.equal(body.to, "w200")
      assert.equal(body.unitKey, "kg")
      assert.equal(body.language, "EN")
      assert.deepEqual(body.rules.ignoredFields, ignoreFields ?? [])
      assert.equal(body.readOnly, true)
      assert.equal(body.saveAvailable, false)
      assert.equal(body.status, "incomparable")
      assert.ok(body.rows.every((row: { status: string }) => row.status === "incomparable"))
      assert.ok(observedConnections.includes("w200"))
      assert.ok(observedConnections.includes("w300"))
    }
  })
})

test("all configuration tool fields remain discoverable through the public MCP schema", async () => {
  await withClient(async (client) => {
    const listed = (await client.listTools()).tools
    const configuration = Object.entries(toolContracts).filter(([name]) =>
      /configuration|^read_bte_/.test(name)
    )
    assert.ok(configuration.some(([name]) => name === "read_configuration_bc_native_snapshot"))
    assert.deepEqual(
      listed
        .filter(({ name }) => /configuration|^read_bte_/.test(name))
        .map(({ name }) => name)
        .sort(),
      configuration.map(([name]) => name).sort()
    )
    for (const [name, contract] of configuration) {
      let schema = contract.inputSchema
      while (schema instanceof z.ZodEffects) schema = schema.innerType()
      const shape = schema instanceof z.ZodObject ? schema.shape : schema
      const fields = Object.keys(shape).sort()
      assert.ok(fields.length > 0, `${name} has declared fields`)
      const publicTool = listed.find((entry) => entry.name === name)!
      assert.ok(publicTool, `${name} is exposed`)
      assert.deepEqual(Object.keys(publicTool.inputSchema.properties!).sort(), fields, name)
    }
  })
})
