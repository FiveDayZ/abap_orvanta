import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { z } from "zod"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { toolContracts } from "../src/contracts.js"
import {
  configurationUnitComparisonLayouts,
  configurationUnitLayouts
} from "../src/configuration-unit.js"
import { startHttpServer } from "../src/http.js"
import { ToolService } from "../src/tools.js"
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
      "expectedFromReadFingerprint",
      "expectedToReadFingerprint",
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
      { ...base, expectedFromReadFingerprint: "A".repeat(64) },
      { ...base, expectedToReadFingerprint: "short" },
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
          expectedFromReadFingerprint: "1".repeat(64),
          expectedToReadFingerprint: "2".repeat(64),
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
      assert.equal(body.observations.from.versionGuard.status, "unavailable")
      assert.equal(body.observations.to.versionGuard.status, "unavailable")
      assert.equal(body.observations.from.versionGuard.expectedReadFingerprint, "1".repeat(64))
      assert.equal(body.observations.to.versionGuard.expectedReadFingerprint, "2".repeat(64))
      assert.equal(body.comparisonFingerprint, null)
      assert.equal(body.readFlow, null)
      assert.ok(body.rows.every((row: { status: string }) => row.status === "incomparable"))
      assert.ok(observedConnections.includes("w200"))
      assert.ok(observedConnections.includes("w300"))
    }
  })
})

test("MCP unit comparison guards both live projections and follows its guarded reread inputs", async () => {
  await withClient(async (client, backend) => {
    const original = {
      table: ToolService.prototype.readDdicTransparentTable,
      element: ToolService.prototype.readDdicDataElement,
      domain: ToolService.prototype.readDdicDomain
    }
    let changed = false,
      queries = 0
    const details = backend.connectionDetails.bind(backend)
    backend.connectionDetails = (connectionId) => ({
      ...details("w200"),
      client: connectionId === "w200" ? "200" : "300",
      language: "EN"
    })
    backend.runQuery = async (connectionId, sql) => {
      queries++
      const fields = /^SELECT (.+) FROM (\w+)/.exec(sql)![1]!.split(", ")
      const values: Record<string, string> = {
        MANDT: connectionId === "w200" ? "200" : "300",
        MSEHI: "kg",
        LAISO: "EN",
        SPRAS: "E",
        MSEHT: changed && connectionId === "w300" ? "changed" : "same"
      }
      return [Object.fromEntries(fields.map((field) => [field, values[field] ?? ""]))]
    }
    backend.callRemoteFunction = async () => assert.fail("No native call or write")
    ToolService.prototype.readDdicTransparentTable = async (raw) => {
      const { connectionId, objectName } = raw as {
        connectionId: "w200" | "w300"
        objectName: string
      }
      return JSON.stringify({
        connectionId,
        objectName,
        objectKind: "transparentTable",
        fingerprint:
          configurationUnitComparisonLayouts[connectionId][
            objectName as keyof typeof configurationUnitLayouts
          ]
      })
    }
    ToolService.prototype.readDdicDataElement = async (raw) =>
      JSON.stringify({
        connectionId: (raw as { connectionId: string }).connectionId,
        objectName: "MSEHI",
        objectKind: "dataElement",
        fingerprint: "f0577fd354c1f756fcd69c082c6b7ccafe3970fc736acc3105caf2d2e557e2d2",
        definition: { domainName: "MEINS" }
      })
    ToolService.prototype.readDdicDomain = async (raw) =>
      JSON.stringify({
        connectionId: (raw as { connectionId: string }).connectionId,
        objectName: "MEINS",
        objectKind: "domain",
        fingerprint: "61bf4adf8f8321410beaee2104e8e99102efe3d9ccebade64e49f8d5a1056373",
        definition: { dataType: "UNIT", length: 3, lowercase: true, conversionExit: "CUNIT" }
      })
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args })
      assert.notEqual(response.isError, true, JSON.stringify(response.content))
      return JSON.parse((response.content as { type: string; text: string }[])[0]!.text)
    }
    try {
      const args = { from: "w200", to: "w300", unitKey: "kg", language: "EN" }
      const current = await call("compare_configuration_unit", args)
      assert.equal(current.rows[1].status, "equal_projection")
      assert.match(current.comparisonFingerprint, /^[a-f0-9]{64}$/)
      const queryCount = queries
      const guardedArgs = {
        ...args,
        expectedFromReadFingerprint: current.observations.from.versionGuard.currentReadFingerprint,
        expectedToReadFingerprint: current.observations.to.versionGuard.currentReadFingerprint
      }
      const guarded = await call("compare_configuration_unit", guardedArgs)
      assert.equal(queries, 2 * queryCount, "request links add no hidden reads")
      assert.equal(guarded.comparisonFingerprint, current.comparisonFingerprint)
      for (const side of ["from", "to"]) {
        assert.equal(guarded.observations[side].versionGuard.status, "match")
      }
      assert.equal(guarded.readFlow.to, null, "never advertise an unsupported w300 unit read")
      const comparisonLink = guarded.readFlow.comparison
      const recheckedComparison = await call(comparisonLink.tool, comparisonLink.arguments)
      assert.equal(recheckedComparison.comparisonFingerprint, guarded.comparisonFingerprint)
      const unitLink = guarded.readFlow.from
      assert.equal((await call(unitLink.tool, unitLink.arguments)).comparison, "match")
      changed = true
      const stale = await call("compare_configuration_unit", guardedArgs)
      assert.equal(stale.status, "incomparable")
      assert.equal(stale.observations.to.versionGuard.status, "changed")
      assert.equal(stale.observations.to.result, null)
      assert.equal(stale.comparisonFingerprint, null)
      assert.equal(stale.readFlow, null)
      const changedRecheck = await call(comparisonLink.tool, comparisonLink.arguments)
      assert.equal(changedRecheck.observations.to.versionGuard.status, "changed")
      assert.equal(backend.lastHelperRequest, undefined)
    } finally {
      ToolService.prototype.readDdicTransparentTable = original.table
      ToolService.prototype.readDdicDataElement = original.element
      ToolService.prototype.readDdicDomain = original.domain
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
