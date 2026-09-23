import assert from "node:assert/strict"
import test from "node:test"
import type { TransportRequest } from "abap-adt-api"
import { buildTransportCleanupRequest } from "../src/adt-backend.js"
import type { SapBackend, TransportCleanupEntry } from "../src/backend.js"
import { prepareTransportDelivery, transportFingerprint } from "../src/transport-delivery.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"

const object = { pgmid: "R3TR", type: "PROG", name: "ZREPORT" }
const input = { connectionId: "w200", transportNumber: "W20K900001", expectedObjects: [object] }
const row = (o = object) => ({
  "tm:pgmid": o.pgmid,
  "tm:type": o.type,
  "tm:name": o.name,
  "tm:dummy_uri": "",
  "tm:obj_info": ""
})
const header = (number: string) => ({
  "tm:number": number,
  "tm:owner": "USER",
  "tm:status": "D",
  "tm:uri": "",
  "tm:desc": "",
  links: []
})
function fixture() {
  const request = {
    ...header(input.transportNumber),
    objects: [row()],
    tasks: [{ ...header("W20K900002"), objects: [row()] }]
  }
  let calls = 0
  const backend: Pick<SapBackend, "transportDetails"> = {
    async transportDetails(id, number) {
      calls++
      assert.equal(id, "w200")
      assert.equal(number, input.transportNumber)
      return request
    }
  }
  return { backend, request, calls: () => calls }
}

test("delivery compares request and task objects without equating duplicates to defects or release readiness", async () => {
  const f = fixture()
  const result = await prepareTransportDelivery(f.backend, input)
  assert.equal(result.comparison, "exact_key_match")
  assert.equal(result.status, "partial")
  assert.equal(result.readyToRelease, "not_determined")
  assert.equal(result.coverage.inactiveObjects, "not_checked")
  assert.equal(result.duplicateOccurrences.length, 1)
  assert.deepEqual(result.objects[0]!.occurrences, ["W20K900001", "W20K900002"])
  assert.equal(f.calls(), 1)
})

test("delivery does not equate R3TR containers and LIMU subobjects and preserves exact names", async () => {
  const f = fixture()
  f.request.objects = [row({ ...object, pgmid: "LIMU", type: "REPS" })]
  f.request.tasks = []
  const result = await prepareTransportDelivery(f.backend, input)
  assert.equal(result.comparison, "differences")
  assert.deepEqual(result.missingFromObservedList, [object])
  assert.equal(result.unexpectedInObservedList[0]!.pgmid, "LIMU")
  const caseResult = await prepareTransportDelivery(f.backend, {
    ...input,
    expectedObjects: [{ ...object, pgmid: "LIMU", type: "REPS", name: "zreport" }]
  })
  assert.equal(caseResult.comparison, "differences")
})

test("delivery rejects malformed expectations before reading SAP", async () => {
  const f = fixture()
  for (const change of [
    { expectedObjects: [] },
    { expectedObjects: [{ ...object, name: " " }] },
    { transportNumber: "W20K900001/inject" }
  ])
    await assert.rejects(prepareTransportDelivery(f.backend, { ...input, ...change }))
  assert.equal(f.calls(), 0)
})

// E071 legitimately repeats keys - `LIMU TABD <table>` appears once per transported table fragment
// - so a caller who transcribes the expected list from the transport itself sends the same key
// twice. This used to throw TRANSPORT_DELIVERY_DUPLICATE_EXPECTATION and block the comparison
// entirely. Falsification: restore that throw and this test fails on the first assertion below
// while the `expectedObjectDuplicates` assertion never runs.
test("delivery accepts a repeated expectation, compares it once, and still reports the repetition", async () => {
  const f = fixture()
  const limu = { pgmid: "LIMU", type: "TABD", name: "ZORVANTA_T_PROBE" }
  f.request.objects = [row(limu)]
  f.request.tasks = []

  const result = await prepareTransportDelivery(f.backend, {
    ...input,
    expectedObjects: [limu, limu]
  })

  assert.equal(result.comparison, "exact_key_match")
  assert.equal(result.missingFromObservedList.length, 0)
  assert.equal(result.unexpectedInObservedList.length, 0)
  assert.equal(result.expected.length, 1, "the comparison list holds the key once")
  assert.deepEqual(result.expectedObjectDuplicates, [{ ...limu, occurrences: 2 }])
  assert.match(
    result.warnings.join(" "),
    /Duplicate expected keys are compared once/,
    "the repetition must stay visible instead of being silently collapsed"
  )
  assert.equal(f.calls(), 1)
})

test("delivery refuses wrong requests, duplicate containers, oversized and incomplete responses", async () => {
  for (const change of [
    { "tm:number": "W20K999999" },
    { tasks: [{ ...header(input.transportNumber), objects: [] }] },
    { objects: undefined },
    { objects: Array.from({ length: 5001 }, () => row()) }
  ]) {
    const f = fixture()
    Object.assign(f.request, change)
    await assert.rejects(prepareTransportDelivery(f.backend, input))
    assert.equal(f.calls(), 1)
  }
})

test("delivery fingerprint ignores response order but changes with object assignment", async () => {
  const f = fixture()
  f.request.objects.push(row({ ...object, name: "ZOTHER" }))
  const a = await prepareTransportDelivery(f.backend, input)
  f.request.objects.reverse()
  assert.equal((await prepareTransportDelivery(f.backend, input)).fingerprint, a.fingerprint)
  f.request.tasks[0]!.objects = []
  assert.notEqual((await prepareTransportDelivery(f.backend, input)).fingerprint, a.fingerprint)
})

test("delivery read failures do not retry or produce an empty successful checklist", async () => {
  let calls = 0
  await assert.rejects(
    prepareTransportDelivery(
      {
        async transportDetails() {
          calls++
          throw new Error("unavailable")
        }
      },
      input
    ),
    /unavailable/
  )
  assert.equal(calls, 1)
})

test("existing transport tool dispatches delivery action with structured results", async () => {
  const service = new ToolService(new MockBackend())
  const result = JSON.parse(
    await service.manageTransportRequests({
      ...input,
      action: "prepare_delivery",
      expectedObjects: [{ pgmid: "R3TR", type: "CLAS", name: "ZCL_DEMO" }]
    })
  )
  assert.equal(result.comparison, "exact_key_match")
  assert.equal(result.readOnly, true)
  await assert.rejects(
    service.manageTransportRequests({
      action: "prepare_delivery",
      connectionId: "w200",
      transportNumber: input.transportNumber
    }),
    /requires/
  )
})

const inactiveTarget = {
  objectName: "ZREPORT",
  objectUri: "adt://w200/sap/bc/adt/programs/programs/zreport/source/main"
}
test("delivery matches inactive observations by URI and never interprets absence as active", async () => {
  const f = fixture()
  let calls = 0
  const backend = {
    ...f.backend,
    async inactiveObjectInventory() {
      calls++
      return {
        entries: [
          {
            uri: "/sap/bc/adt/programs/programs/zreport",
            name: "ZREPORT",
            type: "PROG/P",
            user: "USER",
            deleted: false
          }
        ],
        transportOnlyRecords: 0
      }
    }
  }
  const result = await prepareTransportDelivery(backend, {
    ...input,
    inactiveTargets: [
      inactiveTarget,
      {
        objectName: "ZOTHER",
        objectUri: "adt://w200/sap/bc/adt/programs/programs/zother"
      }
    ]
  })
  assert.equal(calls, 1)
  assert.deepEqual(
    result.inactiveCheck.targets.map((t) => t.status),
    ["inactive_observed", "not_in_returned_list"]
  )
  assert.equal(result.readyToRelease, "not_determined")
})

test("delivery inactive failures preserve object comparison and disclose requested scope", async () => {
  const f = fixture()
  const result = await prepareTransportDelivery(
    {
      ...f.backend,
      async inactiveObjectInventory() {
        throw new Error("password=secret")
      }
    },
    { ...input, inactiveTargets: [inactiveTarget] }
  )
  assert.equal(result.comparison, "exact_key_match")
  assert.equal(result.inactiveCheck.status, "unavailable")
  assert.equal(result.inactiveCheck.requestedTargets.length, 1)
  assert.doesNotMatch(JSON.stringify(result), /secret/)
  assert.equal(
    (await prepareTransportDelivery(f.backend, input)).inactiveCheck.status,
    "not_requested"
  )
})

test("delivery validates inactive source scope before any transport query", async () => {
  const f = fixture()
  for (const inactiveTargets of [
    [inactiveTarget, inactiveTarget],
    [{ ...inactiveTarget, objectUri: inactiveTarget.objectUri.replace("w200", "other") }]
  ])
    await assert.rejects(prepareTransportDelivery(f.backend, { ...input, inactiveTargets }))
  assert.equal(f.calls(), 0)
})

const cleanupEntry = {
  pgmid: "R3TR",
  type: "PROG",
  name: "ZREPORT",
  position: "000001",
  wbType: "PROG/P"
}

type PositionedTransportObject = TransportRequest["objects"][number] & {
  "tm:position"?: string
  "tm:wbtype"?: string
}
type PositionedTransportRequest = Omit<TransportRequest, "objects" | "tasks"> & {
  objects: PositionedTransportObject[]
  tasks: Array<
    Omit<TransportRequest, "objects" | "tasks"> & { objects: PositionedTransportObject[] }
  >
}

function cleanupRequest(): PositionedTransportRequest {
  return {
    ...header("W20K900001"),
    objects: [],
    tasks: [
      {
        ...header("W20K900002"),
        objects: [
          {
            ...row(),
            "tm:position": cleanupEntry.position,
            "tm:wbtype": cleanupEntry.wbType
          },
          {
            ...row({ ...object, name: "ZOTHER" }),
            "tm:position": "000002",
            "tm:wbtype": "PROG/P"
          }
        ]
      }
    ]
  }
}

class CleanupBackend extends MockBackend {
  request = cleanupRequest()
  cleanupCalls = 0
  afterCleanup?: ((request: PositionedTransportRequest) => void) | undefined

  override async transportDetails(_connectionId: string, _number: string) {
    return structuredClone(this.request)
  }

  override async cleanupTransportEntries(
    connectionId: string,
    taskNumber: string,
    parentTransportNumber: string,
    entries: TransportCleanupEntry[]
  ) {
    this.cleanupCalls++
    assert.equal(connectionId, "w200")
    assert.equal(taskNumber, "W20K900002")
    assert.equal(parentTransportNumber, "W20K900001")
    assert.deepEqual(entries, [cleanupEntry])
    const task = this.request.tasks[0]!
    task.objects = task.objects.filter(
      (entry) =>
        !entries.some(
          (selected) =>
            entry["tm:pgmid"] === selected.pgmid &&
            entry["tm:type"] === selected.type &&
            entry["tm:name"] === selected.name &&
            entry["tm:position"] === selected.position
        )
    )
    this.afterCleanup?.(this.request)
  }
}

const cleanupInput = (backend: CleanupBackend) => ({
  connectionId: "w200",
  parentTransportNumber: "W20K900001",
  taskNumber: "W20K900002",
  entries: [cleanupEntry],
  expectedFingerprint: transportFingerprint(backend.request),
  confirmation: "REMOVE_CTS_ENTRIES" as const
})

test("transport cleanup removes only the exact task entry and verifies the remaining snapshot", async () => {
  const backend = new CleanupBackend()
  const result = JSON.parse(
    await new ToolService(backend).cleanupTransportEntries(cleanupInput(backend))
  )
  assert.equal(backend.cleanupCalls, 1)
  assert.equal(result.exactRemovalVerified, true)
  assert.equal(result.unrelatedEntriesUnchanged, true)
  assert.deepEqual(
    backend.request.tasks[0]!.objects.map((entry) => entry["tm:name"]),
    ["ZOTHER"]
  )
})

test("transport cleanup rejects stale fingerprints and non-modifiable containers before writing", async () => {
  const stale = new CleanupBackend()
  await assert.rejects(
    new ToolService(stale).cleanupTransportEntries({
      ...cleanupInput(stale),
      expectedFingerprint: "0".repeat(64)
    }),
    /CTS_CLEANUP_STALE_FINGERPRINT/
  )
  assert.equal(stale.cleanupCalls, 0)

  for (const target of ["parent", "task"] as const) {
    const backend = new CleanupBackend()
    if (target === "parent") backend.request["tm:status"] = "L"
    else backend.request.tasks[0]!["tm:status"] = "L"
    await assert.rejects(
      new ToolService(backend).cleanupTransportEntries(cleanupInput(backend)),
      new RegExp(`CTS_CLEANUP_${target.toUpperCase()}_NOT_MODIFIABLE`)
    )
    assert.equal(backend.cleanupCalls, 0)
  }
})

test("transport cleanup requires exact position and source-backed workbench metadata", async () => {
  for (const change of [
    { sourcePosition: "", input: {} },
    { sourcePosition: "000001", input: { position: "000009" } },
    { sourcePosition: "000001", sourceWbType: "", input: { wbType: "PROG/P" } }
  ]) {
    const backend = new CleanupBackend()
    backend.request.tasks[0]!.objects[0]!["tm:position"] = change.sourcePosition
    if (change.sourceWbType !== undefined) {
      backend.request.tasks[0]!.objects[0]!["tm:wbtype"] = change.sourceWbType
    }
    await assert.rejects(
      new ToolService(backend).cleanupTransportEntries({
        ...cleanupInput(backend),
        entries: [{ ...cleanupEntry, ...change.input }]
      }),
      /CTS_CLEANUP_(POSITION_UNAVAILABLE|POSITION_MISMATCH|WBTYPE_MISMATCH)/
    )
    assert.equal(backend.cleanupCalls, 0)
  }
})

test("transport cleanup rejects any non-target change observed after the write", async () => {
  const backend = new CleanupBackend()
  backend.afterCleanup = (request) => {
    request.tasks[0]!.objects = []
  }
  await assert.rejects(
    new ToolService(backend).cleanupTransportEntries(cleanupInput(backend)),
    /CTS_CLEANUP_POSTCHECK_UNEXPECTED_CHANGE/
  )
  assert.equal(backend.cleanupCalls, 1)
})

test("transport cleanup rejects request or task header drift observed after the write", async () => {
  const backend = new CleanupBackend()
  backend.afterCleanup = (request) => {
    request.tasks[0]!["tm:status"] = "L"
  }
  await assert.rejects(
    new ToolService(backend).cleanupTransportEntries(cleanupInput(backend)),
    /CTS_CLEANUP_POSTCHECK_UNEXPECTED_CHANGE/
  )
  assert.equal(backend.cleanupCalls, 1)
})

test("native transport cleanup payload uses the task endpoint contract and escapes attributes", () => {
  const body = buildTransportCleanupRequest("W20K900002", "W20K900001", [
    { ...cleanupEntry, name: "Z&A", wbType: undefined }
  ])
  assert.match(body, /tm:useraction="removeobject" tm:number="W20K900002"/)
  assert.match(body, /<tm:request tm:number="W20K900001">/)
  assert.match(body, /tm:name="Z&amp;A"/)
  assert.match(body, /tm:position="000001"/)
  assert.doesNotMatch(body, /tm:wbtype=/)
})
