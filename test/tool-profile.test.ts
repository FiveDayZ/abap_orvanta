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
import {
  PROFILE_NAMES,
  TOOL_COUNT,
  TOOL_REGISTRY,
  toolNamesForProfile
} from "../src/tool-registry.js"
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
      "search_abap_objects, read_abap_table \n get_abap_object_lines;search_abap_objects"
  })
  assert.deepEqual(
    [...state.denied],
    ["get_abap_object_lines", "read_abap_table", "search_abap_objects"]
  )
  assert.equal(state.enabled.length, TOOL_COUNT - 3)
  for (const name of state.denied) assert.ok(state.disabled.includes(name))
})

test("invalid profile and unknown deny entries fail loudly", () => {
  assert.throws(
    () => resolveToolProfile({ [TOOL_PROFILE_ENV]: "read-only" }),
    (error: Error) =>
      error.message.includes(`ABAP_MCP_TOOL_PROFILE must be one of`) &&
      PROFILE_NAMES.every((name) => error.message.includes(name))
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

test("a tool withheld by a platform boundary is out of every non-full profile and names why", () => {
  // G1-7: the ADT debugger endpoint is not advertised on this target, so the six abap_debug_* tools
  // are registered but withheld. All three halves matter. Keeping the profiles while the capability
  // report says `platform_unsupported` would advertise six tools that cannot succeed; dropping the
  // reason would turn the empty profile column into a silent hole that reads as an oversight; and
  // removing the tools entirely would erase the fact that the boundary is the PLATFORM's, not a
  // missing implementation.
  const withheld = TOOL_REGISTRY.filter((entry) => entry.withheldReason)
  assert.ok(withheld.length > 0, "expected at least one platform-withheld tool")

  for (const entry of withheld) {
    assert.equal(entry.profiles.length, 0, `${entry.name}: a withheld tool must be in no profile`)
    for (const profile of ["dev", "config", "ops"] as const) {
      assert.ok(
        !toolNamesForProfile(profile).includes(entry.name),
        `${entry.name} must be withheld from the ${profile} profile`
      )
    }
    // `full` still reaches it, so "withheld by default" does not quietly mean "deleted".
    assert.ok(
      toolNamesForProfile("full").includes(entry.name),
      `${entry.name} must stay reachable through the full profile`
    )
    // The reason has to name the MEASURED boundary, not merely say the tool is unavailable.
    assert.match(entry.withheldReason!, /platform_unsupported/)
  }

  // The family this rule was written for, named explicitly so that silently dropping the reason
  // fails here rather than passing as "no withheld tools".
  for (const name of [
    "abap_debug_breakpoint",
    "abap_debug_session",
    "abap_debug_stack",
    "abap_debug_status",
    "abap_debug_step",
    "abap_debug_variable"
  ]) {
    const entry = TOOL_REGISTRY.find((item) => item.name === name)
    assert.ok(entry, `${name} is missing from the registry`)
    assert.ok(entry!.withheldReason, `${name} must carry its withholding reason`)
    assert.ok(!entry!.profiles.includes("dev"), `${name} must not be in the dev profile`)
  }

  // A withheld tool keeps its own risk annotation: the boundary removes an endpoint, it does not
  // change what the tool would do if the endpoint existed. `abap_debug_status`, `abap_debug_stack`
  // and `abap_debug_variable` are read-only yet still withheld, which is the case that shows the
  // rule is about reachability and not about risk.
  const readOnlyWithheld = withheld.filter((entry) => entry.annotations.readOnlyHint === true)
  assert.ok(
    readOnlyWithheld.length > 0,
    "a read-only tool can be unreachable too: the debugger family mixes reads and writes"
  )
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
