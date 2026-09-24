import assert from "node:assert/strict"
import test from "node:test"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"
import type { SapRepositoryRequest, SapRepositoryResult } from "../src/backend.js"

// D-4: `add_objects_to_transport` reported success while SAP recorded the objects in a container
// other than the requested one. TRINT_OBJECTS_CHECK_AND_INSERT refuses to move an object that
// already belongs to another open transport and returns the order and task it used instead, so the
// callee's numbers can differ from the request. The tool used to echo only those numbers, which
// made a different container look like the requested one.

const payload = (request: string, task: string, inserted: number): string[] => [
  `M|1|REQUEST|${request}`,
  `M|1|TASK|${task}`,
  "M|1|OBJECT_COUNT|1",
  `M|1|INSERTED_COUNT|${inserted}`,
  "T|1|PGMID|R3TR",
  "T|1|OBJECT|PROG",
  "T|1|OBJ_NAME|ZORVANTA_TEST_OBJECT"
]

const result = (source: string[]): SapRepositoryResult => ({
  status: "S",
  code: "TRANSPORT_OBJECTS_ADDED",
  message: "Objects were added",
  version: "2.8",
  header: {},
  dynproText: "",
  fields: [],
  flowLogic: [],
  params: [],
  transactions: [],
  guiAttributes: [],
  source
})

async function addTo(source: string[], requestNumber: string) {
  const backend = new MockBackend()
  let seen: SapRepositoryRequest | undefined
  backend.callSapRepository = async (_connectionId, request) => {
    seen = request
    return result(source)
  }
  const output = await new ToolService(backend).addObjectsToTransport({
    connectionId: "w200",
    requestNumber,
    confirmation: "ADD_OBJECTS_TO_TRANSPORT",
    objects: [{ pgmid: "R3TR", object: "PROG", objName: "ZORVANTA_TEST_OBJECT" }]
  })
  return { parsed: JSON.parse(output) as Record<string, unknown>, seen }
}

test("D-4: the requested container is echoed when SAP recorded into it", async () => {
  const { parsed, seen } = await addTo(payload("GR2K923472", "GR2K923473", 1), "GR2K923472")
  assert.equal(seen?.addRequest, "GR2K923472")
  assert.equal(parsed.requestNumber, "GR2K923472")
  assert.equal(parsed.taskNumber, "GR2K923473")
  assert.equal(parsed.requestedRequestNumber, "GR2K923472")
  assert.equal(parsed.recordedInRequestedContainer, true)
  assert.equal(parsed.containerMismatch, null)
})

test("D-4: a different container is reported instead of being passed off as the request", async () => {
  const { parsed } = await addTo(payload("GR2K923499", "GR2K923498", 1), "GR2K923472")
  assert.equal(parsed.requestedRequestNumber, "GR2K923472")
  assert.equal(parsed.requestNumber, "GR2K923499", "the callee's container is the real one")
  assert.equal(parsed.recordedInRequestedContainer, false)
  const mismatch = parsed.containerMismatch as Record<string, string> | null
  assert.ok(mismatch, "a mismatch must never be reported as null")
  assert.equal(mismatch.requested, "GR2K923472")
  assert.equal(mismatch.recordedIn, "GR2K923499")
  assert.equal(mismatch.task, "GR2K923498")
  assert.match(mismatch.reason ?? "", /different transport container/)
})

test("D-4: an unconfirmed container is a mismatch, not a success", async () => {
  const { parsed } = await addTo(payload("", "", 1), "GR2K923472")
  assert.equal(parsed.recordedInRequestedContainer, false)
  const mismatch = parsed.containerMismatch as Record<string, string> | null
  assert.ok(mismatch)
  assert.equal(mismatch.recordedIn, "")
  assert.match(mismatch.reason ?? "", /unconfirmed/)
})

test("D-4: the inserted count still has to match what SAP reported", async () => {
  await assert.rejects(
    () => addTo(payload("GR2K923472", "GR2K923473", 0), "GR2K923472"),
    /TRANSPORT_OBJECT_NOT_PERSISTED|inserted|not every object/i
  )
})
