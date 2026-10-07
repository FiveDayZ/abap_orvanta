import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { startHttpServer } from "../src/http.js"
import { MockBackend } from "./mock-backend.js"

test("MCP advertises unit reader and CTS inputs without dropping service cross-field rules", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "orvanta-unit-read-schema-"))
  const backend = new MockBackend()
  let sapCalls = 0
  const unexpectedSap = async () => {
    sapCalls++
    assert.fail("invalid read/CTS inputs must not reach SAP")
  }
  backend.runQuery = unexpectedSap
  backend.callSapDdic = unexpectedSap
  backend.callSapRepository = unexpectedSap
  backend.callRemoteFunction = unexpectedSap
  const running = await startHttpServer(backend, 0, stateRoot)
  const client = new Client({ name: "unit-read-schema-test", version: "1" })
  try {
    const transport = new StreamableHTTPClientTransport(new URL(running.mcpUrl))
    await client.connect(transport as Parameters<Client["connect"]>[0])
    const list = (await client.listTools()).tools
    for (const [name, fields, required] of [
      [
        "read_configuration_unit",
        [
          "connectionId",
          "unitKey",
          "language",
          "expectedReadFingerprint",
          "includeApiSnapshot",
          "transport",
          "textReconciliation"
        ],
        ["connectionId", "unitKey"]
      ],
      [
        "inspect_configuration_transport",
        ["connectionId", "requestNumber", "taskNumber", "unitText"],
        ["connectionId", "requestNumber", "taskNumber"]
      ]
    ] as const) {
      const tool = list.find((entry) => entry.name === name)!
      for (const field of fields)
        assert.ok(tool.inputSchema.properties?.[field], `${name}.${field} must be discoverable`)
      for (const field of required) assert.ok(tool.inputSchema.required?.includes(field))
      assert.equal(tool.inputSchema.additionalProperties, false)
      assert.equal(tool.annotations?.readOnlyHint, true)
    }
    for (const args of [
      { connectionId: "w200", unitKey: "KG", includeApiSnapshot: true },
      { connectionId: "w200", unitKey: "KG", language: "ZH", execute: true },
      {
        connectionId: "w200",
        unitKey: "KG",
        language: "ZH",
        transport: { requestNumber: "GR2K923429", taskNumber: "GR2K923430" }
      },
      { connectionId: "w200", language: "ZH", includeApiSnapshot: true }
    ])
      assert.equal(
        (await client.callTool({ name: "read_configuration_unit", arguments: args })).isError,
        true
      )
    for (const args of [
      { connectionId: "w200", requestNumber: "GR2K923429", taskNumber: "GR2K923429" },
      {
        connectionId: "w200",
        requestNumber: "GR2K923429",
        taskNumber: "GR2K923430",
        execute: true
      },
      {
        connectionId: "w200",
        requestNumber: "GR2K923429",
        taskNumber: "GR2K923430",
        unitText: { unitKey: "KG" }
      }
    ])
      assert.equal(
        (await client.callTool({ name: "inspect_configuration_transport", arguments: args }))
          .isError,
        true
      )
    assert.equal(sapCalls, 0)
  } finally {
    await client.close()
    await running.close()
    assert.equal(dirname(stateRoot), resolve(tmpdir()))
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("MCP advertises unit text preview fields and still enforces cross-field and strict input rules", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "orvanta-unit-preview-schema-"))
  const backend = new MockBackend()
  let queries = 0
  backend.runQuery = async () => {
    queries++
    assert.fail("invalid preview must not query SAP")
  }
  const running = await startHttpServer(backend, 0, stateRoot)
  const client = new Client({ name: "unit-preview-schema-test", version: "1" })
  try {
    const transport = new StreamableHTTPClientTransport(new URL(running.mcpUrl))
    await client.connect(transport as Parameters<Client["connect"]>[0])
    const tool = (await client.listTools()).tools.find(
      (entry) => entry.name === "preview_configuration_unit_text"
    )!
    const fields = tool.inputSchema.properties!
    for (const name of [
      "connectionId",
      "unitKey",
      "language",
      "expectedReadFingerprint",
      "expectedTextVersion",
      "patch",
      "includeMaintenanceBoundary",
      "transport"
    ])
      assert.ok(fields[name], `${name} must be discoverable`)
    assert.equal(tool.inputSchema.additionalProperties, false)
    assert.equal(tool.annotations!.readOnlyHint, true)
    assert.ok(tool.inputSchema.required!.includes("expectedReadFingerprint"))
    assert.ok(!tool.inputSchema.required!.includes("expectedTextVersion"))
    const base = {
      connectionId: "w200",
      unitKey: "KG",
      expectedReadFingerprint: "a".repeat(64),
      patch: { MSEHL: "test" }
    }
    for (const input of [
      { ...base, expectedTextVersion: "b".repeat(64) },
      { ...base, language: "ZH", expectedTextVersion: "invalid" },
      { ...base, transport: { requestNumber: "GR2K917102", taskNumber: "GR2K917103" } },
      { ...base, language: "ZH", execute: true },
      { ...base, patch: { MSEH3: "alias" } }
    ]) {
      const reply = await client.callTool({ name: tool.name, arguments: input })
      assert.equal(reply.isError, true)
    }
    assert.equal(queries, 0)
  } finally {
    await client.close()
    await running.close()
    assert.equal(dirname(stateRoot), resolve(tmpdir()))
    await rm(stateRoot, { recursive: true, force: true })
  }
})
