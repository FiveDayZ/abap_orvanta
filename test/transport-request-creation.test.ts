import assert from "node:assert/strict"
import test from "node:test"
import type { SapBackend, SapRepositoryResult, SapStructureRow } from "../src/backend.js"
import { ToolService } from "../src/tools.js"

// F2: the helper answers a duplicate with the matched request number and the match basis only, so
// `create_transport_request` used to return an empty status, owner, target and task list for a
// request that plainly had all four. The service now reads them back from E070, which carries one
// row per request and one per task (`TRFUNCTION = 'S'` with `STRKORR` naming its request).
//
// These tests pin the read-back, its scope (the matched path only), and the rule that a read-back
// which fails throws instead of being reported as a request with no owner and no tasks.

const matchedReply = (): SapRepositoryResult => ({
  status: "S",
  code: "TRANSPORT_REQUEST_EXISTS",
  message: "A modifiable request with the same owner and text exists",
  version: "2.8",
  header: {},
  dynproText: "",
  fields: [],
  flowLogic: [],
  params: [],
  transactions: [],
  guiAttributes: [],
  source: ["M|1|TRKORR|GR2K923472", "M|1|CREATED|", "M|1|MATCHED_BY|OWNER_TYPE_TEXT"]
})

const createdReply = (): SapRepositoryResult => ({
  ...matchedReply(),
  code: "TRANSPORT_REQUEST_CREATED",
  message: "Transport request created",
  source: [
    "M|1|TRKORR|GR2K923500",
    "M|1|CREATED|X",
    "M|1|TRFUNCTION|K",
    "M|1|TRSTATUS|D",
    "M|1|AS4USER|WYS",
    "M|1|TARSYSTEM|GR3",
    "T|1|TRKORR|GR2K923501"
  ]
})

/** One CTS read the service asked for, so a test can prove which tables and filters it used. */
interface ReaderCall {
  tableName: string
  columns: string[]
  filters: { column: string; operator: string; value: string }[]
  maxRows: number
}

function serviceWith(reply: SapRepositoryResult) {
  const calls: unknown[] = []
  const backend = {
    connectionIds: () => ["w200"],
    callSapRepository: async (connectionId: string, request: unknown) => {
      calls.push({ connectionId, request })
      return reply
    }
  } as unknown as SapBackend
  return { tools: new ToolService(backend), calls }
}

/**
 * Stand-in for the CTS reader, answering the two reads the read-back performs.
 *
 * The header read is recognised by its projection: only it asks for TRSTATUS. Both are asserted so
 * the projection and the filter cannot drift away from what E070 needs to answer.
 */
function ctsReader(reads: ReaderCall[]): NonNullable<ToolService["readTransportTableRows"]> {
  return async (_connectionId, tableName, columns, filters, maxRows) => {
    reads.push({ tableName, columns: [...columns], filters: [...filters], maxRows })
    assert.equal(tableName, "E070")
    if (columns.includes("TRSTATUS")) {
      assert.deepEqual(filters, [{ column: "TRKORR", operator: "EQ", value: "GR2K923472" }])
      const header: SapStructureRow = {
        TRKORR: "GR2K923472",
        TRFUNCTION: "K",
        TRSTATUS: "D",
        TARSYSTEM: "GR3",
        AS4USER: "WYS"
      }
      return [header]
    }
    assert.deepEqual(filters, [
      { column: "STRKORR", operator: "EQ", value: "GR2K923472" },
      { column: "TRFUNCTION", operator: "EQ", value: "S" }
    ])
    return [{ TRKORR: "GR2K923492" }]
  }
}

const request = {
  connectionId: "w200",
  requestType: "K",
  description: "ORVANTA MCP D9 acceptance 20260924",
  confirmation: "CREATE_TRANSPORT_REQUEST"
}

test("F2: a matched request is completed from E070 instead of reported empty", async () => {
  const { tools } = serviceWith(matchedReply())
  const reads: ReaderCall[] = []
  tools.readTransportTableRows = ctsReader(reads)

  const output = JSON.parse(await tools.createTransportRequest(request)) as Record<string, unknown>

  assert.equal(output.created, false)
  assert.equal(output.matchedBy, "OWNER_TYPE_TEXT")
  assert.equal(output.requestNumber, "GR2K923472")
  assert.equal(output.status, "D")
  assert.equal(output.owner, "WYS")
  assert.equal(output.target, "GR3")
  assert.deepEqual(output.taskNumbers, ["GR2K923492"])
  assert.equal(reads.length, 2, "one read for the header and one for the tasks")
  // The helper reports no description for a match either, so the caller's own text is what a
  // matched request keeps reporting.
  assert.equal(output.description, request.description)
})

test("F2: a created request is returned as the helper reported it, without a read-back", async () => {
  const { tools } = serviceWith(createdReply())
  const reads: ReaderCall[] = []
  tools.readTransportTableRows = ctsReader(reads)

  const output = JSON.parse(await tools.createTransportRequest(request)) as Record<string, unknown>

  assert.equal(output.created, true)
  assert.equal(output.requestNumber, "GR2K923500")
  assert.equal(output.status, "D")
  assert.equal(output.owner, "WYS")
  assert.equal(output.target, "GR3")
  assert.deepEqual(output.taskNumbers, ["GR2K923501"])
  assert.equal(output.matchedBy, undefined, "a created request carries no match basis")
  assert.equal(reads.length, 0, "the CTS tables are not read when the helper already answered")
})

test("F2: a failed read-back throws instead of reporting a request with no owner or tasks", async () => {
  const { tools } = serviceWith(matchedReply())
  tools.readTransportTableRows = async () => {
    throw new Error(
      "TRANSPORT_LIST_TABLE_READ_FAILED: TABLE_QUERY_UNAVAILABLE; stage=rfc_read_table"
    )
  }

  await assert.rejects(tools.createTransportRequest(request), /TRANSPORT_LIST_TABLE_READ_FAILED/)
})

test("F2: the confirmation is checked before SAP is contacted", async () => {
  const { tools, calls } = serviceWith(matchedReply())
  tools.readTransportTableRows = ctsReader([])

  await assert.rejects(
    tools.createTransportRequest({ ...request, confirmation: "CREATE_TRANSPORT_REQUEST " }),
    /confirmation must be CREATE_TRANSPORT_REQUEST/
  )
  assert.equal(calls.length, 0, "an unconfirmed call must not reach the helper")
})
