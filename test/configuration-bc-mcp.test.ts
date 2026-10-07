import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { startHttpServer } from "../src/http.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"
import {
  configurationBcSetLayouts,
  configurationBcSetDomains,
  configurationBcSetFields,
  configurationBcMaintenanceTables
} from "../src/configuration-bc-set.js"

test("public MCP exposes bounded BC metadata inventory and rejects invalid scope before SAP reads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-bc-mcp-")),
    backend = new MockBackend()
  const original = {
    table: ToolService.prototype.readDdicTransparentTable,
    domain: ToolService.prototype.readDdicDomain
  }
  let reads = 0
  ToolService.prototype.readDdicTransparentTable = async ({ objectName }) => {
    reads++
    assert.ok(
      objectName in configurationBcSetLayouts || objectName in configurationBcMaintenanceTables
    )
    const companion =
      configurationBcMaintenanceTables[objectName as keyof typeof configurationBcMaintenanceTables]
    return JSON.stringify({
      connectionId: "w200",
      objectName,
      objectKind: "transparentTable",
      fingerprint:
        companion?.fingerprint ??
        configurationBcSetLayouts[objectName as keyof typeof configurationBcSetLayouts],
      ...(companion
        ? { definition: { fields: companion.keyFields.map((name) => ({ name, key: true })) } }
        : {})
    })
  }
  ToolService.prototype.readDdicDomain = async ({ objectName }) => {
    reads++
    assert.ok(objectName in configurationBcSetDomains)
    return JSON.stringify({
      connectionId: "w200",
      objectName,
      objectKind: "domain",
      fingerprint: configurationBcSetDomains[objectName as keyof typeof configurationBcSetDomains]
    })
  }
  const queries: string[] = []
  const row = (
    name: keyof typeof configurationBcSetFields,
    extra: Record<string, string> = {}
  ) => ({
    ...Object.fromEntries(configurationBcSetFields[name].map((field) => [field, ""])),
    ID: "ZTEST",
    VERSION: "N",
    ...extra
  })
  backend.runQuery = async (_connection, sql) => {
    queries.push(sql)
    if (sql.includes("FROM SCPRATTR")) return [row("SCPRATTR")]
    if (sql.includes("FROM SCPRRECA")) {
      const selected = row("SCPRRECA", {
        TABLENAME: sql.match(/TABLENAME = '([^']+)'/)?.[1] ?? "T006A",
        RECNUMBER: "1",
        OBJECTNAME: "CUNI",
        OBJECTTYPE: "T"
      })
      return sql.includes("TABLENAME =")
        ? [selected]
        : [
            selected,
            row("SCPRRECA", {
              TABLENAME: "ZTOTHER",
              RECNUMBER: "1",
              OBJECTNAME: "ZOTHER",
              OBJECTTYPE: "V"
            })
          ]
    }
    assert.ok(
      sql.includes("FROM SCPRVALS") ||
        sql.includes("FROM SCPRVALL") ||
        sql.includes("FROM SCPRPPRL")
    )
    return []
  }
  backend.callRemoteFunction = async () => assert.fail("No RFC write or fallback expected")
  const running = await startHttpServer(backend, 0, root),
    client = new Client({ name: "bc-scope-contract", version: "1" })
  t.after(async () => {
    await client.close()
    await running.closeIfIdle()
    ToolService.prototype.readDdicTransparentTable = original.table
    ToolService.prototype.readDdicDomain = original.domain
    await rm(root, { recursive: true, force: true })
  })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(running.mcpUrl)) as Parameters<Client["connect"]>[0]
  )
  const listed = await client.listTools(),
    schema = listed.tools.find((tool) => tool.name === "read_configuration_bc_set")?.inputSchema
  assert.equal((schema?.properties?.includeRecordInventory as { type: string }).type, "boolean")
  const input = {
    connectionId: "w200",
    bcSetId: "ZTEST",
    version: "N",
    objectName: "T006A",
    includeRecordInventory: true
  }
  const reply = await client.callTool({ name: "read_configuration_bc_set", arguments: input })
  assert.ok(!reply.isError)
  const content = reply.content as { type: string; text: string }[],
    result = JSON.parse(content[0]!.text)
  assert.equal(result.recordInventory.complete, true)
  assert.deepEqual(result.recordInventory.unsupportedTableNames, ["ZTOTHER"])
  assert.equal(result.activationAvailable, false)
  assert.ok(queries.every((sql) => !sql.includes("FROM ZTOTHER")))
  for (const objectName of ["T006B", "T006C", "T006D"] as const) {
    const r = await client.callTool({
      name: "read_configuration_bc_set",
      arguments: { ...input, objectName, includeRecordInventory: false }
    })
    assert.ok(!r.isError)
    const data = JSON.parse((r.content as { text: string }[])[0]!.text)
    assert.equal(data.status, "partial")
    assert.deepEqual(
      data.maintenanceTable.keyFields,
      configurationBcMaintenanceTables[objectName].keyFields
    )
    assert.equal(data.maintenanceTable.targetWriteAvailable, false)
    assert.ok(queries.every((sql) => !sql.includes(`FROM ${objectName} `)))
  }
  const beforeReads = reads,
    beforeQueries = queries.length
  for (const invalid of [
    { ...input, objectName: "USR02" },
    { ...input, includeRecordInventory: "true" }
  ]) {
    const rejected = await client.callTool({
      name: "read_configuration_bc_set",
      arguments: invalid
    })
    assert.equal(rejected.isError, true)
  }
  assert.equal(reads, beforeReads)
  assert.equal(queries.length, beforeQueries)
  const nativeSchema = listed.tools.find(
    (tool) => tool.name === "read_configuration_bc_native_snapshot"
  )?.inputSchema
  assert.ok(nativeSchema)
  assert.equal((nativeSchema.properties?.bcSetId as { const: string }).const, "EHS_CUNI_KNM")
  for (const invalid of [
    { connectionId: "w300", bcSetId: "EHS_CUNI_KNM", version: "N" },
    { connectionId: "w200", bcSetId: "OTHER", version: "N" },
    { connectionId: "w200", bcSetId: "EHS_CUNI_KNM", version: "C" },
    { connectionId: "w200", bcSetId: "EHS_CUNI_KNM", version: "N", unitKey: "KG" }
  ]) {
    const r = await client.callTool({
      name: "read_configuration_bc_native_snapshot",
      arguments: invalid
    })
    assert.equal(r.isError, true)
  }
  assert.equal(reads, beforeReads)
  assert.equal(queries.length, beforeQueries)
  const previewSchema = listed.tools.find(
    (tool) => tool.name === "preview_configuration_bc_native"
  )?.inputSchema
  assert.ok(previewSchema)
  assert.deepEqual(previewSchema.required?.slice().sort(), [
    "bcSetId",
    "connectionId",
    "nativeSourceVersion",
    "nativeTargetVersion",
    "version"
  ])
  const previewInput = {
    connectionId: "w200",
    bcSetId: "EHS_CUNI_KNM",
    version: "N",
    nativeSourceVersion: "a".repeat(64),
    nativeTargetVersion: "b".repeat(64)
  }
  for (const invalid of [
    { ...previewInput, connectionId: "w300" },
    { ...previewInput, bcSetId: "OTHER" },
    { ...previewInput, nativeTargetVersion: "short" },
    { ...previewInput, activate: true }
  ]) {
    const result = await client.callTool({
      name: "preview_configuration_bc_native",
      arguments: invalid
    })
    assert.equal(result.isError, true)
  }
  assert.equal(reads, beforeReads)
  assert.equal(queries.length, beforeQueries)
  const routeSchema = listed.tools.find(
    (tool) => tool.name === "inspect_configuration_bc_route"
  )?.inputSchema
  assert.ok(routeSchema)
  assert.deepEqual(routeSchema.required?.slice().sort(), previewSchema.required?.slice().sort())
  for (const invalid of [
    { ...previewInput, connectionId: "w300" },
    { ...previewInput, objectName: "OTHER" },
    { ...previewInput, nativeSourceVersion: "short" },
    { ...previewInput, executeMethod: true }
  ]) {
    const result = await client.callTool({
      name: "inspect_configuration_bc_route",
      arguments: invalid
    })
    assert.equal(result.isError, true)
  }
  assert.equal(reads, beforeReads)
  assert.equal(queries.length, beforeQueries)
  const guardSchema = listed.tools.find(
    (tool) => tool.name === "read_configuration_bc_guard"
  )?.inputSchema
  assert.ok(guardSchema)
  assert.deepEqual(
    guardSchema.required?.slice().sort(),
    [...previewSchema.required!, "nativeMetadataVersion"].sort()
  )
  for (const invalid of [
    { ...previewInput, nativeMetadataVersion: "short" },
    { ...previewInput, nativeMetadataVersion: "c".repeat(64), connectionId: "w300" },
    { ...previewInput, nativeMetadataVersion: "c".repeat(64), unitKey: "KG" },
    { ...previewInput, nativeMetadataVersion: "c".repeat(64), activate: true }
  ]) {
    const result = await client.callTool({
      name: "read_configuration_bc_guard",
      arguments: invalid
    })
    assert.equal(result.isError, true)
  }
  assert.equal(reads, beforeReads)
  assert.equal(queries.length, beforeQueries)
  for (const objectName of ["T006B", "T006C", "T006D"]) {
    const r = await client.callTool({
      name: "compare_configuration_bc_set",
      arguments: { ...input, objectName, language: "ZH" }
    })
    assert.equal(r.isError, true)
  }
  assert.equal(reads, beforeReads)
  assert.equal(queries.length, beforeQueries)
})
