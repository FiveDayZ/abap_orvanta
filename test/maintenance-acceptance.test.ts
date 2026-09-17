import assert from "node:assert/strict"
import test from "node:test"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const { prepareSelection, parseEndpoint, checkObservation, observe } = await import(
  pathToFileURL(resolve("scripts/run-mvp-batch2-sap.mjs")).href
)
const scope = { connectionId: "w200", username: "WYS" }
const identity = { version: "0.36.32", fingerprint: "a".repeat(64) }
const runtime = {
  status: "observed",
  server: { version: identity.version },
  checks: {
    expectedVersion: "match",
    expectedArtifact: "match",
    diskSinceStartup: "match",
    moduleAndPackageVersion: "match"
  }
}
const empty = {
  connectionId: "w200",
  client: "200",
  source: "SM12",
  readOnly: true,
  status: "ok",
  code: "OK",
  entries: [],
  returnedCount: 0,
  hasMore: false
}
const response = (value: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(value) }]
})

test("maintenance acceptance rejects unknown actions and other connections", () => {
  assert.throws(() => prepareSelection("unlock", scope, "empty"), /Select/)
  assert.throws(() => prepareSelection("constructor", scope, "empty"), /Select/)
  assert.throws(
    () => prepareSelection("locks", { ...scope, connectionId: "other" }, "empty"),
    /w200 only/
  )
})

test("maintenance acceptance permits only a clean loopback MCP endpoint", () => {
  assert.equal(parseEndpoint("http://127.0.0.1:4847/mcp").port, "4847")
  for (const value of [
    "http://example.com/mcp",
    "https://127.0.0.1/mcp",
    "http://user:password@127.0.0.1/mcp",
    "http://127.0.0.1/mcp?token=secret",
    "http://127.0.0.1/other"
  ])
    assert.throws(() => parseEndpoint(value), /loopback/)
})

test("maintenance acceptance validates scope before any client exists", () => {
  const input = {
    ...scope,
    fromSystemTime: "2026-09-10T08:00:00",
    toSystemTime: "2026-09-10T09:00:00"
  }
  assert.equal(prepareSelection("updates", input, "empty").name, "search_failed_updates")
  assert.throws(() =>
    prepareSelection("updates", { ...input, toSystemTime: "2026-09-10T09:00:01" }, "empty")
  )
  assert.throws(() =>
    prepareSelection("updates", { ...input, toSystemTime: "2026-02-30T09:00:00" }, "empty")
  )
  assert.throws(() => prepareSelection("locks", { ...scope, maxResults: 101 }, "empty"))
  assert.throws(() => prepareSelection("detail", { ...scope, updateKey: "A" }, "empty"))
  assert.equal(
    prepareSelection("locks", { ...scope, argument: "A*+ " }, "empty").args.argument,
    "A*+ "
  )
})

test("maintenance acceptance does not turn unavailable or missing entries into empty success", () => {
  const selection = prepareSelection("locks", scope, "empty")
  assert.equal(checkObservation(selection, empty).outcome, "empty")
  for (const changed of [
    { entries: null },
    { status: "unavailable", code: "HELPER_NOT_APPROVED", entries: null },
    { status: "unsupported", code: "READ_FAILED", entries: null },
    { returnedCount: 1 },
    { hasMore: true },
    { client: "100" },
    { source: "SM13" },
    { readOnly: false }
  ])
    assert.throws(() => checkObservation(selection, { ...empty, ...changed }))
  assert.throws(() => checkObservation(prepareSelection("locks", scope, "nonempty"), empty))
})

test("maintenance acceptance rejects another user's rows", () => {
  assert.throws(() =>
    checkObservation(prepareSelection("locks", scope, "nonempty"), {
      ...empty,
      entries: [{ client: "200", username: "OTHER" }],
      returnedCount: 1
    })
  )
})

test("maintenance acceptance requires the explicitly expected forbidden outcome without data", () => {
  const denied = { ...empty, status: "forbidden", code: "NO_AUTHORITY", entries: null }
  assert.equal(
    checkObservation(prepareSelection("locks", scope, "forbidden"), denied).outcome,
    "forbidden"
  )
  assert.throws(() => checkObservation(prepareSelection("locks", scope, "empty"), denied))
  assert.throws(() =>
    checkObservation(prepareSelection("locks", scope, "forbidden"), { ...denied, entries: [] })
  )
})

test("maintenance acceptance detail must match the selected update key", () => {
  const selection = prepareSelection("detail", { ...scope, updateKey: "A" }, "nonempty")
  const result = {
    ...empty,
    source: "SM13",
    data: {
      header: { client: "200", username: "WYS", updateKey: "A" },
      modules: [],
      errors: []
    }
  }
  assert.equal(checkObservation(selection, result).moduleCount, 0)
  result.data.header.updateKey = "B"
  assert.throws(() => checkObservation(selection, result))
})

test("maintenance acceptance checks candidate identity before any SAP query", async () => {
  const calls: string[] = []
  const client = {
    async callTool(input: { name: string }) {
      calls.push(input.name)
      return response({ ...runtime, checks: { ...runtime.checks, expectedArtifact: "mismatch" } })
    }
  }
  await assert.rejects(
    observe(client, prepareSelection("locks", scope, "empty"), identity, { steps: [] }),
    /does not match/
  )
  assert.deepEqual(calls, ["get_runtime_info"])
})

test("maintenance acceptance invokes exactly one selected query and never follows rows", async () => {
  const calls: string[] = []
  const result = {
    ...empty,
    source: "SM13",
    entries: [{ client: "200", username: "WYS", updateKey: "A" }],
    returnedCount: 1
  }
  const client = {
    async callTool(input: { name: string }) {
      calls.push(input.name)
      return response(input.name === "get_runtime_info" ? runtime : result)
    }
  }
  const selection = prepareSelection(
    "updates",
    { ...scope, fromSystemTime: "2026-09-10T08:00:00", toSystemTime: "2026-09-10T08:30:00" },
    "nonempty"
  )
  const report = { steps: [], selectedChecksPassed: false, status: "Partially Verified" }
  await observe(client, selection, identity, report)
  assert.deepEqual(calls, ["get_runtime_info", "search_failed_updates"])
  assert.equal(report.selectedChecksPassed, true)
  assert.equal(report.status, "Partially Verified")
})

test("maintenance acceptance preserves tool failures without retrying", async () => {
  const calls: string[] = []
  const failure = { isError: true, content: [{ type: "text", text: "original SAP failure" }] }
  const client = {
    async callTool(input: { name: string }) {
      calls.push(input.name)
      return input.name === "get_runtime_info" ? response(runtime) : failure
    }
  }
  const report: { steps: Array<{ response: unknown }> } = { steps: [] }
  await assert.rejects(
    observe(client, prepareSelection("locks", scope, "empty"), identity, report),
    /isError/
  )
  assert.deepEqual(calls, ["get_runtime_info", "search_sap_locks"])
  assert.deepEqual(report.steps[1]?.response, failure)
})
