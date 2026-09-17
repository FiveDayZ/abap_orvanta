import assert from "node:assert/strict"
import test from "node:test"
import { AtcStageError, executeNativeAtc, inspectNativeAtc } from "../src/native-atc.js"
import { checkFailure } from "../src/quality-checks.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"

const target = "/sap/bc/adt/programs/programs/zdemo/source/main"
function fixture() {
  const calls: unknown[][] = []
  const client: Parameters<typeof executeNativeAtc>[0] = {
    atcCustomizing: async () => {
      calls.push(["customizing"])
      return { properties: [{ name: "systemCheckVariant", value: "DEFAULT" }], excemptions: [] }
    },
    atcCheckVariant: async (variant) => {
      calls.push(["worklist", variant])
      return "WORKLIST_ID_123"
    },
    createAtcRun: async (id, uri, maxResults) => {
      calls.push(["run", id, uri, maxResults])
      return { id: "RUN_RESULT", timestamp: 123, infos: [] }
    },
    atcWorklists: async (id: string, timestamp?: number, usedObjectSet?: string) => {
      calls.push(["findings", id, timestamp, usedObjectSet])
      return {
        id: "WORKLIST_ID_123",
        timestamp: 123,
        usedObjectSet: "all",
        objectSetIsComplete: true,
        objectSets: [],
        objects: []
      }
    }
  }
  return { calls, client }
}

test("native ATC metadata precheck performs only customizing GET, never validates by creating a worklist", async () => {
  const { calls, client } = fixture()
  const result = await inspectNativeAtc(client, "CONFIGURED")
  assert.deepEqual(calls, [["customizing"]])
  assert.equal(result.status, "metadata_available")
  assert.equal(result.selectedVariant, "CONFIGURED")
  assert.equal(result.systemVariant, "DEFAULT")
  assert.equal(result.variantValidated, false)
  assert.equal(result.worklistCreationAttempted, false)
  assert.equal(result.runCreationAttempted, false)
  assert.equal(result.qualityGate, "not_evaluated")
})

test("native ATC starts the run with the returned worklist ID, not the variant name", async () => {
  const { calls, client } = fixture()
  const result = await executeNativeAtc(client, target)
  assert.deepEqual(calls, [
    ["customizing"],
    ["worklist", "DEFAULT"],
    ["run", "WORKLIST_ID_123", target, 100],
    ["findings", "RUN_RESULT", 123, "99999999999999999999999999999999"]
  ])
  assert.equal(result.variant, "DEFAULT")
  assert.deepEqual(result.findings, [])
  assert.deepEqual(result.execution, {
    objectSetIsComplete: true,
    requestedMaximumVerdicts: 100
  })
})

test("native ATC preserves explicit variant behavior and does not require customizing GET", async () => {
  const { calls, client } = fixture()
  await executeNativeAtc(client, target, "CONFIGURED")
  assert.deepEqual(calls[0], ["worklist", "CONFIGURED"])
  assert.deepEqual(calls[1], ["run", "WORKLIST_ID_123", target, 100])
})

test("native ATC retains incomplete object-set evidence even with no findings", async () => {
  const { client } = fixture()
  const readWorklist = client.atcWorklists
  client.atcWorklists = async (id: string) => ({
    ...(await readWorklist(id)),
    objectSetIsComplete: false
  })
  const result = await executeNativeAtc(client, target)
  assert.equal(result.execution?.objectSetIsComplete, false)
  assert.deepEqual(result.findings, [])
})

test("native ATC metadata without a variant is not a validated or runnable configuration", async () => {
  const { calls, client } = fixture()
  client.atcCustomizing = async () => ({ properties: [], excemptions: [] })
  const metadata = await inspectNativeAtc(client)
  assert.equal(metadata.selectedVariant, null)
  assert.equal(metadata.variantSource, "none")
  await assert.rejects(
    executeNativeAtc(client, target),
    (error) =>
      error instanceof AtcStageError &&
      error.stage === "customizing" &&
      !error.worklistCreationAttempted &&
      !error.runCreationAttempted
  )
  assert.deepEqual(calls, [])
})

test("native ATC refuses empty worklist IDs before attempting a run", async () => {
  const { calls, client } = fixture()
  client.atcCheckVariant = async () => " "
  await assert.rejects(
    executeNativeAtc(client, target),
    (error) =>
      error instanceof AtcStageError &&
      error.stage === "create_worklist" &&
      error.worklistCreationAttempted &&
      !error.runCreationAttempted
  )
  assert.deepEqual(calls, [["customizing"]])
})

test("native ATC preserves failure stage and attempted side effects without automatic retries", async () => {
  for (const [method, stage, worklistAttempted, runAttempted] of [
    ["atcCustomizing", "customizing", false, false],
    ["atcCheckVariant", "create_worklist", true, false],
    ["createAtcRun", "create_run", true, true],
    ["atcWorklists", "read_worklist", true, true]
  ] as const) {
    const { client, calls } = fixture()
    let count = 0
    client[method] = async () => {
      count++
      throw new Error("connection lost")
    }
    await assert.rejects(
      executeNativeAtc(client, target),
      (error) =>
        error instanceof AtcStageError &&
        error.stage === stage &&
        error.worklistCreationAttempted === worklistAttempted &&
        error.runCreationAttempted === runAttempted
    )
    assert.equal(count, 1)
    assert.ok(calls.length <= 3)
  }
})

test("native ATC structured failure keeps unsupported distinct from permission and parser failures", () => {
  for (const [category, expected] of [
    ["unsupported-endpoint", "unavailable"],
    ["forbidden-or-not-authorized", "failed"],
    ["parser-or-content-type", "failed"]
  ]) {
    const result = checkFailure(
      new AtcStageError("customizing", new Error(`atc capability ${category}: failed`))
    )
    assert.equal(result.status, expected)
    assert.equal(result.stage, "customizing")
    assert.equal(result.runCreationAttempted, false)
  }
})

test("native ATC precheck action does not execute object analysis and preserves typed failures", async () => {
  const backend = new MockBackend()
  let calls = 0
  backend.runAtc = async () => {
    throw new Error("analysis must not run")
  }
  backend.inspectAtc = async () => {
    calls++
    throw new AtcStageError(
      "customizing",
      new Error("atc capability unsupported-endpoint (HTTP 404): missing")
    )
  }
  const tools = new ToolService(backend)
  const result = JSON.parse(
    await tools.runAtcAnalysis({
      action: "precheck_atc",
      connectionId: "w200"
    })
  )
  assert.equal(result.status, "unavailable")
  assert.equal(result.method, "GET")
  assert.equal(result.runCreationAttempted, false)
  assert.equal(result.stage, "customizing")
  assert.equal(result.qualityGate, "not_evaluated")
  await assert.rejects(
    tools.runAtcAnalysis({
      action: "precheck_atc",
      connectionId: "w200",
      objectUri: target
    })
  )
  assert.equal(calls, 1)
})
