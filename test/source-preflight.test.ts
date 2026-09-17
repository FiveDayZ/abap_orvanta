import assert from "node:assert/strict"
import test from "node:test"
import { ToolService } from "../src/tools.js"
import { hashSource, sourceDiff } from "../src/source-preflight.js"
import { inspectSourceWithClient, replaceSourceWithClient } from "../src/adt-backend.js"
import { InactiveInventoryError } from "../src/inactive-inventory.js"
import { inactiveHttp } from "./inactive-http.js"
import { MockBackend } from "./mock-backend.js"

const uri = "adt://w200/sap/bc/adt/oo/classes/zcl_demo"
async function fixture() {
  const backend = new MockBackend()
  const source = await backend.inspectSource("w200", uri)
  return {
    backend,
    tools: new ToolService(backend),
    change: {
      fileUri: uri,
      oldString: source.activeSource,
      newString: source.activeSource + "\n* reviewed change",
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      expectedSourceFingerprint: hashSource(source.activeSource)
    }
  }
}

test("source change preflight produces guarded diff without writes or activation", async () => {
  const { backend, tools, change } = await fixture()
  backend.replaceSource = async () => {
    throw new Error("Unexpected write")
  }
  backend.activateSource = async () => {
    throw new Error("Unexpected activation")
  }
  const result = JSON.parse(await tools.previewSourceChanges({ changes: [change] }))
  assert.equal(result.status, "ready_for_review")
  assert.equal(result.executionAuthorized, false)
  assert.equal(result.sapLocksAcquired, false)
  assert.equal(result.objects[0].diff.addedLineCount, 1)
  assert.equal(
    result.objects[0].writePrecondition.expectedSourceFingerprint,
    change.expectedSourceFingerprint
  )
  assert.equal((await backend.inspectSource("w200", uri)).activeSource, change.oldString)
})

test("preflight retains per-object blockers for source, inactive version, package and transport", async () => {
  const { backend, tools, change } = await fixture()
  const inspect = backend.inspectSource.bind(backend)
  backend.inspectSource = async (...args) => ({
    ...(await inspect(...args)),
    inactiveSource: change.oldString + "\n* another editor"
  })
  const result = JSON.parse(
    await tools.previewSourceChanges({
      changes: [
        {
          ...change,
          packageName: "ZOTHER",
          transportNumber: "GR2K000001",
          expectedSourceFingerprint: "0".repeat(64),
          oldString: "not in source"
        }
      ]
    })
  )
  assert.equal(result.status, "blocked")
  assert.deepEqual(result.objects[0].blockers, [
    "INACTIVE_SOURCE_EXISTS",
    "PACKAGE_CONFLICT",
    "SOURCE_FINGERPRINT_CONFLICT",
    "OPEN_TRANSPORT_ASSIGNMENT_NOT_CONFIRMED",
    "EXACT_REPLACEMENT_REJECTED"
  ])
  assert.match(result.objects[0].inactiveDiff.after, /another editor/)
})

test("read failure is unavailable rather than absent; duplicate aliases are rejected", async () => {
  const { backend, tools, change } = await fixture()
  await assert.rejects(
    tools.previewSourceChanges({
      changes: [{ ...change, fileUri: "/sap/bc/adt/oo/classes/zcl_demo/source/main" }]
    }),
    /exact adt:\/\/ workspace URI/
  )
  await assert.rejects(
    tools.previewSourceChanges({ changes: [change, { ...change, fileUri: uri + "/source/main" }] }),
    /Duplicate/
  )
  for (const fileUri of [uri + "?x=1", uri.replace("zcl_demo", "cl_standard")]) {
    await assert.rejects(tools.previewSourceChanges({ changes: [{ ...change, fileUri }] }))
  }
  backend.inspectSource = async () => {
    throw new Error("private SAP failure")
  }
  const result = JSON.parse(await tools.previewSourceChanges({ changes: [change] }))
  assert.equal(result.objects[0].status, "unavailable")
  assert.ok(!JSON.stringify(result).includes("private SAP"))
})

test("preflight exposes bounded inactive-inventory diagnostics without raw XML", async () => {
  const { backend, tools, change } = await fixture()
  backend.inspectSource = async () => {
    throw new InactiveInventoryError("INACTIVE_INVENTORY_ROOT_INVALID", "root_parse", {
      rootName: "alt:inactiveObjects",
      targetUri: "/sap/bc/adt/programs/includes/ztest_pai",
      mainProgramUri: "/sap/bc/adt/programs/programs/ztest"
    })
  }
  const result = JSON.parse(await tools.previewSourceChanges({ changes: [change] }))
  assert.equal(result.objects[0].stage, "inactive_inventory")
  assert.deepEqual(result.objects[0].blockers, [
    "SOURCE_OR_ASSIGNMENT_READ_FAILED",
    "INACTIVE_INVENTORY_UNAVAILABLE"
  ])
  assert.deepEqual(result.objects[0].inactiveInventory, {
    code: "INACTIVE_INVENTORY_ROOT_INVALID",
    stage: "root_parse",
    endpoint: "/sap/bc/adt/activation/inactiveobjects",
    rootName: "alt:inactiveObjects",
    targetUri: "/sap/bc/adt/programs/includes/ztest_pai",
    mainProgramUri: "/sap/bc/adt/programs/programs/ztest"
  })
  assert.equal(result.objects[0].httpStatus, null)
})

test("source inspection uses active/inactive GETs only", async () => {
  const versions: string[] = []
  const result = await inspectSourceWithClient(
    {
      async getObjectSource(_uri: string, options: { version: string }) {
        versions.push(options.version)
        return options.version
      },
      httpClient: inactiveHttp()
    } as never,
    "w200",
    uri
  )
  assert.deepEqual(versions, ["active", "inactive"])
  assert.equal(result.inactiveSource, "inactive")
})

test("native lock protects full-source fingerprint even when the exact replacement still matches", async () => {
  const calls: string[] = []
  await assert.rejects(
    replaceSourceWithClient(
      {
        stateful: "stateful",
        async lock() {
          calls.push("lock")
          return { LOCK_HANDLE: "private", IS_LOCAL: "X", CORRNR: "" }
        },
        httpClient: inactiveHttp(),
        async getObjectSource() {
          calls.push("read")
          return "REPORT zdemo.\n* concurrent edit"
        },
        async setObjectSource() {
          calls.push("write")
        },
        async unLock() {
          calls.push("unlock")
        },
        async activate() {
          calls.push("activate")
        }
      } as never,
      "w200",
      "adt://w200/sap/bc/adt/programs/programs/zdemo",
      "REPORT zdemo.",
      "REPORT zdemo.\n* desired",
      undefined,
      hashSource("REPORT zdemo.")
    ),
    /SOURCE_FINGERPRINT_CONFLICT/
  )
  assert.deepEqual(calls, ["lock", "read", "read", "unlock"])
})

test("diffs show truncation and line-ending-only changes explicitly", () => {
  assert.equal(sourceDiff("A\r\nB", "A\nB").lineEndingsOnly, true)
  const diff = sourceDiff("old", Array.from({ length: 150 }, (_, i) => String(i)).join("\n"))
  assert.equal(diff.truncated, true)
  assert.equal(diff.addedLineCount, 150)
  assert.equal(diff.after.split("\n").length, 100)
})
