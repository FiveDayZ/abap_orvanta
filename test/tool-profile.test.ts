import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { startHttpServer } from "../src/http.js"
import {
  DEFAULT_TOOL_PROFILE,
  parseToolDenyList,
  resolveToolProfile,
  TOOL_DENY_ENV,
  TOOL_PROFILE_ENV
} from "../src/tool-profile.js"
import { TOOL_COUNT, toolNamesForProfile } from "../src/tool-registry.js"
import { MockBackend } from "./mock-backend.js"

test("tool profile defaults to the full surface", () => {
  const state = resolveToolProfile({})
  assert.equal(state.profile, DEFAULT_TOOL_PROFILE)
  assert.equal(state.profile, "full")
  assert.equal(state.source, "default")
  assert.equal(state.requested, null)
  assert.equal(state.enabled.length, TOOL_COUNT)
  assert.equal(state.disabled.length, 0)
  assert.deepEqual([...state.denied], [])
})

test("readonly profile exposes exactly the read-only tools", () => {
  const state = resolveToolProfile({ [TOOL_PROFILE_ENV]: "readonly" })
  const expected = toolNamesForProfile("readonly")
  assert.equal(state.profile, "readonly")
  assert.equal(state.source, "environment")
  assert.deepEqual([...state.enabled], [...expected])
  assert.ok(state.enabled.length > 0, "readonly profile must not be empty")
  assert.ok(state.enabled.length < TOOL_COUNT, "readonly profile must withhold write tools")
  assert.equal(state.enabled.length + state.disabled.length, TOOL_COUNT)
  for (const name of ["create_module_pool", "delete_ddic_object", "save_smartform"]) {
    assert.ok(state.disabled.includes(name), `${name} must be withheld by the readonly profile`)
  }
})

test("deny list subtracts tools from the selected profile", () => {
  const state = resolveToolProfile({
    [TOOL_DENY_ENV]:
      "search_abap_objects, read_abap_source \n get_abap_object_info;search_abap_objects"
  })
  assert.deepEqual(
    [...state.denied],
    ["get_abap_object_info", "read_abap_source", "search_abap_objects"]
  )
  assert.equal(state.enabled.length, TOOL_COUNT - 3)
  for (const name of state.denied) assert.ok(state.disabled.includes(name))
})

test("invalid profile and unknown deny entries fail loudly", () => {
  assert.throws(
    () => resolveToolProfile({ [TOOL_PROFILE_ENV]: "read-only" }),
    /ABAP_MCP_TOOL_PROFILE must be one of full, readonly, platform, dev, config, ops/
  )
  assert.throws(
    () => resolveToolProfile({ [TOOL_DENY_ENV]: "search_abap_objects, search_abap_object" }),
    /ABAP_MCP_TOOL_DENY contains unknown tool names: search_abap_object/
  )
})

test("deny list parsing ignores separators, blanks and duplicates", () => {
  assert.deepEqual(parseToolDenyList(undefined), [])
  assert.deepEqual(parseToolDenyList("   "), [])
  assert.deepEqual(parseToolDenyList(" a , b,,a;c "), ["a", "b", "c"])
})

test("readonly profile withholds write tools from tools/list and refuses tools/call", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "orvanta-tool-profile-"))
  const previous = process.env[TOOL_PROFILE_ENV]
  process.env[TOOL_PROFILE_ENV] = "readonly"
  const running = await startHttpServer(new MockBackend(), 0, stateRoot)
  const client = new Client({ name: "tool-profile-client", version: "0.1.0" })
  try {
    const transport = new StreamableHTTPClientTransport(new URL(running.mcpUrl))
    await client.connect(transport as Parameters<Client["connect"]>[0])
    const listed = (await client.listTools()).tools
    const expected = toolNamesForProfile("readonly")
    assert.equal(listed.length, expected.length)
    assert.deepEqual(listed.map((tool) => tool.name).sort(), [...expected].sort())
    assert.ok(
      listed.every((tool) => tool.annotations?.readOnlyHint === true),
      "every listed tool must be annotated read-only"
    )
    assert.ok(!listed.some((tool) => tool.name === "create_module_pool"))

    let executed = false
    let message = ""
    try {
      const result = await client.callTool({
        name: "create_module_pool",
        arguments: { connectionId: "w200", name: "ZORVANTA_PROFILE_PROBE" }
      })
      if (result.isError === true) message = JSON.stringify(result.content)
      else executed = true
    } catch (error) {
      message = String((error as Error)?.message ?? error)
    }
    assert.equal(executed, false, "a withheld tool must not execute")
    assert.match(message, /disabled/i)
  } finally {
    await client.close()
    await running.close()
    if (previous === undefined) delete process.env[TOOL_PROFILE_ENV]
    else process.env[TOOL_PROFILE_ENV] = previous
    await rm(stateRoot, { recursive: true, force: true })
  }
})
