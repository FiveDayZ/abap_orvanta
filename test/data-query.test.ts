import assert from "node:assert/strict"
import test from "node:test"
import { createServer } from "node:http"
import { parseQueryResponse } from "abap-adt-api/build/api/tablecontents.js"
import { parseSapDataQueryResponse, runSapDataQuery } from "../src/data-query.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"
import type { SapBackend } from "../src/backend.js"

const column = (name: string, type: string, values: string[]) =>
  `<p:columns><p:metadata p:name="${name}" p:type="${type}"/><p:dataSet>${values.map((value) => `<p:data>${value}</p:data>`).join("")}</p:dataSet></p:columns>`
const table = (columns: string) =>
  `<p:tableData xmlns:p="http://www.sap.com/adt/dataPreview">${columns}</p:tableData>`
const response = (body: string) => ({
  body,
  status: 200,
  headers: { "content-type": "application/xml; charset=utf-8" }
})

test("upstream parser turns an unexpected response into an empty result", () => {
  assert.deepEqual(parseQueryResponse("<error><message>SQL failed</message></error>"), {
    columns: [],
    values: []
  })
})

test("valid data preview preserves identifiers and existing numeric decoding", () => {
  assert.deepEqual(
    parseSapDataQueryResponse(
      response(
        table(
          column("WERKS", "C", ["809P", "809P"]) +
            column("KUNNR", "C", ["0001100059", "0001100059"]) +
            column("QUANTITY", "P", ["1.500", "0.000"])
        )
      )
    ),
    [
      { WERKS: "809P", KUNNR: "0001100059", QUANTITY: 1.5 },
      { WERKS: "809P", KUNNR: "0001100059", QUANTITY: 0 }
    ]
  )
})

test("a genuine zero-row result must still have column metadata", () => {
  assert.deepEqual(parseSapDataQueryResponse(response(table(column("WERKS", "C", [])))), [])
})

for (const [label, body] of [
  ["HTML", "<html><body>PRIVATE_PASSWORD</body></html>"],
  ["SQL error", "<error><message>PRIVATE_SQL_TEXT</message></error>"],
  ["unknown envelope", "<unexpected/>"],
  ["empty body", ""],
  ["missing columns", table("")],
  ["invalid metadata", table("<p:columns><p:dataSet/></p:columns>")],
  ["duplicate columns", table(column("A", "C", []) + column("A", "C", []))],
  ["unequal rows", table(column("A", "C", ["a", "b"]) + column("B", "C", ["c"]))],
  ["embedded error", table("<p:error>PRIVATE_ERROR</p:error>" + column("A", "C", []))]
] as const) {
  test(`rejects ${label} instead of reporting empty data`, () => {
    assert.throws(
      () => parseSapDataQueryResponse(response(body)),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /SAP_DATA_QUERY_RESPONSE_INVALID/)
        assert.doesNotMatch(error.message, /PRIVATE_/)
        return true
      }
    )
  })
}

test("HTTP error and non-XML content types cannot become successful results", () => {
  const valid = response(table(column("A", "C", [])))
  assert.throws(() => parseSapDataQueryResponse({ ...valid, status: 403 }), /HTTP 403/)
  assert.throws(
    () =>
      parseSapDataQueryResponse({
        ...valid,
        headers: { "Content-Type": "text/html" }
      }),
    /expected XML/
  )
})

test("query uses the existing authenticated transport without retries", async () => {
  let requests = 0
  const rows = await runSapDataQuery(
    {
      async request(url, options) {
        requests++
        assert.equal(url, "/sap/bc/adt/datapreview/freestyle")
        assert.equal(options?.method, "POST")
        assert.equal(options?.body, "SELECT WERKS FROM ZTPMC_BZWL")
        assert.equal(options?.qs?.rowNumber, 11)
        return { ...response(table(column("WERKS", "C", ["809P"]))), statusText: "OK" }
      }
    },
    "SELECT WERKS FROM ZTPMC_BZWL",
    11
  )
  assert.equal(requests, 1)
  assert.deepEqual(rows, [{ WERKS: "809P" }])
})

test("public query flow rejects HTTP-200 error pages and retains row limits", async (t) => {
  let mode = "valid"
  const requests: string[] = []
  const server = createServer(async (request, reply) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push(Buffer.concat(chunks).toString())
    assert.equal(request.method, "POST")
    assert.equal(request.url, "/sap/bc/adt/datapreview/freestyle?rowNumber=2")
    reply.writeHead(200, { "Content-Type": "application/xml" })
    reply.end(mode === "valid" ? table(column("WERKS", "C", ["809P", "809P"])) : "<error/>")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  })
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const backend: SapBackend = new MockBackend()
  backend.runQuery = async (_id, sql, cap) =>
    runSapDataQuery(
      {
        async request(path, options) {
          const result = await fetch(
            `http://127.0.0.1:${address.port}${path}?rowNumber=${options?.qs?.rowNumber}`,
            {
              method: options?.method ?? "GET",
              body: options?.body ?? "",
              headers: options?.headers ?? {}
            }
          )
          return {
            body: await result.text(),
            status: result.status,
            statusText: result.statusText,
            headers: Object.fromEntries(result.headers)
          }
        }
      },
      sql,
      cap
    )
  const tools = new ToolService(backend)
  const input = {
    connectionId: "w200",
    sql: "SELECT WERKS FROM ZTPMC_BZWL",
    displayMode: "internal" as const,
    rowRange: { start: 0, end: 1 },
    maxRows: 1
  }
  const valid = JSON.parse(await tools.executeDataQuery(input))
  assert.equal(valid.truncated, true)
  assert.deepEqual(valid.data, [{ WERKS: "809P" }])
  mode = "error"
  await assert.rejects(tools.executeDataQuery(input), /SAP_DATA_QUERY_RESPONSE_INVALID/)
  assert.equal(requests.length, 2)
})
