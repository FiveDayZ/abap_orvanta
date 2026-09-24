import assert from "node:assert/strict"
import test from "node:test"
import { createServer, type IncomingMessage } from "node:http"
import { AdtBackend } from "../src/adt-backend.js"
import type { TransportTableReader } from "../src/backend.js"
import { ToolService } from "../src/tools.js"
import { listenOnUnblockedPort } from "./loopback-port.js"

/** Every CTS read the fallback performed, so a test can prove the projection and filter it asked for. */
const readerCalls: {
  tableName: string
  columns: string[]
  filters: { column: string; operator: string; value: string }[]
  maxRows: number
}[] = []

// D-5/D-7: `get_user_transports` answered "0 transport requests" for a user who demonstrably had
// several, because the ADT transport-organizer list document this client parses
// (tm:root/tm:workbench/tm:target) is not what the target system returns. These tests pin both
// branches: the primary document when it does carry requests, and the CTS-table fallback that the
// empty document must trigger.

const column = (name: string, type: string, values: string[]) =>
  `<p:columns><p:metadata p:name="${name}" p:type="${type}"/><p:dataSet>${values
    .map((value) => `<p:data>${value}</p:data>`)
    .join("")}</p:dataSet></p:columns>`
const table = (columns: string) =>
  `<p:tableData xmlns:p="http://www.sap.com/adt/dataPreview">${columns}</p:tableData>`

const e070Rows = [
  ["GR2K900001", "K", "D", "W20", "TEST", "20260924", "100000"],
  ["GR2K900002", "W", "D", "W20", "TEST", "20260924", "100001"],
  ["GR2K900003", "K", "L", "W20", "TEST", "20260924", "100002"]
]
const e07tRows = [
  ["GR2K900001", "E", "First workbench request"],
  ["GR2K900003", "E", "Released request"]
]

const e070Response = table(
  column(
    "TRKORR",
    "C",
    e070Rows.map((row) => row[0]!)
  ) +
    column(
      "TRFUNCTION",
      "C",
      e070Rows.map((row) => row[1]!)
    ) +
    column(
      "TRSTATUS",
      "C",
      e070Rows.map((row) => row[2]!)
    ) +
    column(
      "TARSYSTEM",
      "C",
      e070Rows.map((row) => row[3]!)
    ) +
    column(
      "AS4USER",
      "C",
      e070Rows.map((row) => row[4]!)
    ) +
    column(
      "AS4DATE",
      "C",
      e070Rows.map((row) => row[5]!)
    ) +
    column(
      "AS4TIME",
      "C",
      e070Rows.map((row) => row[6]!)
    )
)
const e07tResponse = table(
  column(
    "TRKORR",
    "C",
    e07tRows.map((row) => row[0]!)
  ) +
    column(
      "LANGU",
      "C",
      e07tRows.map((row) => row[1]!)
    ) +
    column(
      "AS4TEXT",
      "C",
      e07tRows.map((row) => row[2]!)
    )
)

const emptyOrganizerDocument =
  '<tm:root xmlns:tm="http://www.sap.com/cts/transportorganizer"><tm:workbench/><tm:customizing/></tm:root>'

const populatedOrganizerDocument = `<tm:root xmlns:tm="http://www.sap.com/cts/transportorganizer">
  <tm:workbench>
    <tm:target tm:name="W20" tm:desc="Development">
      <tm:modifiable>
        <tm:request tm:number="W20K900001" tm:owner="TEST" tm:desc="demo" tm:status="D">
          <tm:task tm:number="W20K900002" tm:owner="TEST" tm:desc="demo" tm:status="D"/>
        </tm:request>
      </tm:modifiable>
      <tm:released/>
    </tm:target>
  </tm:workbench>
  <tm:customizing/>
</tm:root>`

async function body(request: IncomingMessage): Promise<string> {
  let text = ""
  for await (const chunk of request) text += chunk.toString()
  return text
}

/**
 * Serve the two documents the backend can ask for and record every path it actually requested, so a
 * test can prove the fallback did - or did not - run.
 */
/**
 * Stand-in for the reviewed table reader the CTS fallback is handed in production.
 *
 * The fallback must not use `SapBackend.runQuery` on its own: that path answers HTML on the target
 * system, which is why the transport list could never be read there. The production reader is
 * `read_abap_table` (allowlist, DDIC check, `rfc_read_table` fallback); here the same projection and
 * the same EQ filter are served from memory, and both are asserted so the request cannot drift.
 */
const readCtsTable: TransportTableReader = async (
  _connectionId,
  tableName,
  columns,
  filters,
  maxRows
) => {
  const texts = tableName === "E07T"
  readerCalls.push({ tableName, columns: [...columns], filters: [...filters], maxRows })
  const projection = texts
    ? ["TRKORR", "LANGU", "AS4TEXT"]
    : ["TRKORR", "TRFUNCTION", "TRSTATUS", "TARSYSTEM", "AS4USER", "AS4DATE", "AS4TIME"]
  assert.deepEqual(columns, projection, `${tableName} projection must not drift`)
  assert.equal(maxRows, 500, "the CTS read keeps its 500-row bound")
  const source = texts ? e07tRows : e070Rows
  return source
    .filter((row) =>
      filters.every((filter) => row[projection.indexOf(filter.column)] === filter.value)
    )
    .map((row) => Object.fromEntries(projection.map((name, index) => [name, row[index]!])))
}

async function backendAgainst(organizerDocument: string) {
  const requested: string[] = []
  const queries: string[] = []
  readerCalls.length = 0
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    requested.push(url.pathname + url.search)
    if (url.pathname === "/sap/bc/adt/cts/transportrequests") {
      response.writeHead(200, {
        "Content-Type": "application/vnd.sap.adt.transportorganizer.v1+xml"
      })
      response.end(organizerDocument)
      return
    }
    if (url.pathname === "/sap/bc/adt/datapreview/freestyle") {
      const sql = await body(request)
      queries.push(sql)
      response.writeHead(200, { "Content-Type": "application/xml" })
      response.end(sql.includes("FROM E07T") ? e07tResponse : e070Response)
      return
    }
    response.writeHead(200, { "Content-Type": "application/xml", "x-csrf-token": "test-token" })
    response.end("<graph/>")
  })
  await listenOnUnblockedPort(server)
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const backend = new AdtBackend(
    [
      {
        id: "w200",
        url: `http://127.0.0.1:${address.port}`,
        client: "200",
        language: "EN",
        username: "test",
        passwordEnv: "TEST_UNUSED",
        allowUnauthorized: false
      }
    ],
    () => "test-only"
  )
  return {
    backend,
    requested,
    queries,
    close: async () => {
      await backend.close()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }
}

test("D-5: an empty organizer document falls back to the CTS tables and names that source", async (t) => {
  const fixture = await backendAgainst(emptyOrganizerDocument)
  t.after(fixture.close)
  const listing = await fixture.backend.listUserTransports("w200", "test", readCtsTable)
  assert.equal(listing.source, "cts-tables")
  // The user filter is the whole point of the read: an unfiltered E070 scan would report every
  // user's requests as this user's. The projection and the 500-row bound are pinned by the reader.
  assert.deepEqual(readerCalls[0]?.filters, [{ column: "AS4USER", operator: "EQ", value: "TEST" }])
  assert.equal(readerCalls.length, 2, "one read for the requests and one for their texts")
  // The fallback must not go back to `runQuery`: its native data-preview path answers HTML on the
  // target system, so that read reports a failure as an empty list.
  assert.equal(fixture.queries.length, 0, "the native query path must not be used")
  const workbench = listing.workbench.flatMap((target) => [
    ...target.modifiable.map((request) => request["tm:number"]),
    ...target.released.map((request) => request["tm:number"])
  ])
  const customizing = listing.customizing.flatMap((target) => [
    ...target.modifiable.map((request) => request["tm:number"]),
    ...target.released.map((request) => request["tm:number"])
  ])
  assert.deepEqual(workbench, ["GR2K900001", "GR2K900003"])
  assert.deepEqual(customizing, ["GR2K900002"])
  const target = listing.workbench[0]
  assert.equal(target?.["tm:name"], "W20")
  assert.equal(target?.modifiable[0]?.["tm:desc"], "First workbench request")
  assert.equal(target?.modifiable[0]?.["tm:owner"], "TEST")
  assert.deepEqual(
    target?.released.map((request) => request["tm:number"]),
    ["GR2K900003"]
  )
  assert.deepEqual(target?.released[0]?.objects, [], "a table listing carries no object rows")
})

test("D-5: a populated organizer document is used as-is and never triggers the fallback", async (t) => {
  const fixture = await backendAgainst(populatedOrganizerDocument)
  t.after(fixture.close)
  const listing = await fixture.backend.listUserTransports("w200", "test", readCtsTable)
  assert.equal(listing.source, "adt-transport-organizer")
  assert.equal(listing.workbench[0]?.modifiable[0]?.["tm:number"], "W20K900001")
  assert.equal(readerCalls.length, 0, "the CTS tables must not be read when ADT answered")
  assert.equal(fixture.queries.length, 0, "the CTS tables must not be read when ADT answered")
})

test("D-5: the tool reports which source answered", async (t) => {
  const fixture = await backendAgainst(emptyOrganizerDocument)
  t.after(fixture.close)
  const tools = new ToolService(fixture.backend)
  tools.readTransportTableRows = readCtsTable
  const output = await tools.manageTransportRequests({
    connectionId: "w200",
    action: "get_user_transports",
    user: "TEST"
  })
  assert.match(output, /Source: cts-tables/)
  assert.match(output, /Summary: 3 transport requests for user TEST \(source: cts-tables\)/)
  assert.match(output, /GR2K900001/)
})

test("D-5: a failing CTS read is reported, never passed off as an empty list", async (t) => {
  const fixture = await backendAgainst(emptyOrganizerDocument)
  t.after(fixture.close)
  const tools = new ToolService(fixture.backend)
  tools.readTransportTableRows = async () => {
    throw new Error(
      "TRANSPORT_LIST_TABLE_READ_FAILED: TABLE_QUERY_UNAVAILABLE; stage=rfc_read_table"
    )
  }
  await assert.rejects(
    tools.manageTransportRequests({
      connectionId: "w200",
      action: "get_user_transports",
      user: "TEST"
    }),
    /transport-list/
  )
})
