import assert from "node:assert/strict"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { DEFAULT_OBJECT_TYPES } from "../src/backend.js"
import { toolContracts } from "../src/contracts.js"
import { InvocationReceiptStore } from "../src/invocation-receipts.js"
import { createMcpServer } from "../src/mcp.js"
import { TOOL_NAMES } from "../src/tool-registry.js"
import { WriteOperationReceiptStore } from "../src/write-operation-receipts.js"
import { MockBackend } from "./mock-backend.js"

test("SPRO type-pool lookup accepts TYPE at the public MCP boundary without widening other tools", async () => {
  const oldProfile = process.env.ABAP_MCP_TOOL_PROFILE
  const oldDeny = process.env.ABAP_MCP_TOOL_DENY
  process.env.ABAP_MCP_TOOL_PROFILE = "full"
  process.env.ABAP_MCP_TOOL_DENY = TOOL_NAMES.filter(
    (name) => !["search_abap_objects", "get_abap_object_info"].includes(name)
  ).join(",")
  const root = fileURLToPath(new URL("../spro-search-test-state/", import.meta.url))
  const backend = new MockBackend()
  const calls: { connectionId: string; pattern: string; types: string[] | undefined }[] = []
  const originalSearch = backend.searchObjects.bind(backend)
  backend.searchObjects = async (connectionId, pattern, types, maximum) => {
    calls.push({ connectionId, pattern, types })
    if (types?.includes("TYPE"))
      return [
        {
          name: "ABAP",
          type: "TYPE",
          description: "Offline type-pool fixture; not SAP route evidence",
          package: "",
          systemType: "STANDARD",
          uri: "/offline/type-pool/abap"
        }
      ]
    return originalSearch(connectionId, pattern, types, maximum)
  }
  const server = createMcpServer(
    backend,
    new InvocationReceiptStore(root),
    new WriteOperationReceiptStore(root),
    undefined,
    root
  )
  const client = new Client({ name: "spro-search-contract", version: "1" })
  const [left, right] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(right)
    await client.connect(left)
    const exposed = (await client.listTools()).tools
    const search = exposed.find((tool) => tool.name === "search_abap_objects")
    assert(search)
    assert.equal(search.annotations?.readOnlyHint, true)
    assert.equal(search.inputSchema.additionalProperties, false)
    const types = search.inputSchema.properties?.types as { items: { enum: string[] } }
    assert(types.items.enum.includes("TYPE"), "TYPE must pass the actual advertised schema")
    const valid = await client.callTool({
      name: search.name,
      arguments: { connectionId: "w200", pattern: "ABAP", types: ["TYPE"], maxResults: 5 }
    })
    assert.notEqual(valid.isError, true)
    assert.match(JSON.stringify(valid.content), /ABAP \(TYPE\)/)
    assert.deepEqual(calls, [{ connectionId: "w200", pattern: "ABAP", types: ["TYPE"] }])

    for (const invalid of [{ types: ["TYPE/UNKNOWN"] }, { types: ["UNKNOWN"] }, { save: true }]) {
      const refused = await client.callTool({
        name: search.name,
        arguments: {
          connectionId: "w200",
          pattern: "ABAP",
          types: ["TYPE"],
          maxResults: 5,
          ...invalid
        }
      })
      assert.equal(refused.isError, true)
    }
    const otherTool = await client.callTool({
      name: "get_abap_object_info",
      arguments: { connectionId: "w200", objectName: "ABAP", objectType: "TYPE" }
    })
    assert.equal(otherTool.isError, true)
    assert.equal(calls.length, 1, "invalid inputs must not reach the backend")

    const alias = await client.callTool({
      name: search.name,
      arguments: { connectionId: "w200", pattern: "ZCL_DEMO", types: ["CLAS/OC"] }
    })
    assert.notEqual(alias.isError, true)
    assert.deepEqual(calls[1], {
      connectionId: "w200",
      pattern: "ZCL_DEMO",
      types: ["CLAS"]
    })
    assert.equal((DEFAULT_OBJECT_TYPES as readonly string[]).includes("TYPE"), false)
    assert.equal(
      toolContracts.get_abap_object_info.inputSchema.objectType.safeParse("TYPE").success,
      false
    )
  } finally {
    await client.close()
    await server.close()
    if (oldProfile === undefined) delete process.env.ABAP_MCP_TOOL_PROFILE
    else process.env.ABAP_MCP_TOOL_PROFILE = oldProfile
    if (oldDeny === undefined) delete process.env.ABAP_MCP_TOOL_DENY
    else process.env.ABAP_MCP_TOOL_DENY = oldDeny
  }
})
