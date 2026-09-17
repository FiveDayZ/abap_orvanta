import assert from "node:assert/strict"
import test from "node:test"
import { createServer } from "node:http"
import { AdtBackend } from "../src/adt-backend.js"
import { ToolService } from "../src/tools.js"
import { parseSapDataQueryResponse } from "../src/data-query.js"
import { runScopedQueryFallback } from "../src/scoped-query.js"
import type { RemoteFunctionResult } from "../src/backend.js"

const sql = "SELECT WERKS, ZPOSNR FROM ZTPMC_BZWL WHERE WERKS = '809P'"
let nativeError: unknown
try {
  parseSapDataQueryResponse({ body: "", status: 200, headers: { "content-type": "text/html" } })
} catch (error) {
  nativeError = error
}
const row = {
  MANDT: "200",
  WERKS: "809P",
  ZPOSNR: "000001",
  ZPKGMATNR: "000000000000500000",
  ZPKGTYPE: "D001",
  ZPKGDESC: "sample"
}
const success = (): RemoteFunctionResult => ({
  outputs: {
    EV_STATUS: "S",
    EV_CODE: "QUERY_OK",
    EV_VERSION: "1.0",
    EV_COUNT: "1",
    ET_ROWS: [{ ...row }]
  }
})

test("scoped query preserves identifiers and uses a fixed bounded RFC request", async () => {
  const rows = await runScopedQueryFallback(sql, 2, "200", nativeError, async (request) => {
    assert.equal(request.functionName, "Z_ORVANTA_MCP_QUERY_API")
    assert.deepEqual(request.inputParameters, { IV_WERKS: "809P", IV_LIMIT: "2", ET_ROWS: [] })
    return success()
  })
  assert.deepEqual(rows, [{ WERKS: "809P", ZPOSNR: "000001" }])
  const all = await runScopedQueryFallback(
    sql.replace("WERKS, ZPOSNR", "*"),
    2,
    "200",
    nativeError,
    async () => success()
  )
  assert.deepEqual(all, [row])
})

test("scoped query refuses SQL outside the approved grammar before invoking SAP", async () => {
  for (const query of [
    sql.replace("809P", "808P"),
    sql.replace("809P", "809p"),
    sql.replace("ZTPMC_BZWL", "T000"),
    sql.replace("WERKS, ZPOSNR", "COUNT(*)"),
    sql.replace("WERKS, ZPOSNR", "WERKS, WERKS"),
    sql.replace("WERKS, ZPOSNR", "UNKNOWN"),
    `${sql} OR WERKS = '808P'`,
    `${sql};`,
    `${sql} --comment`,
    `${sql} ORDER BY ZPOSNR`,
    "SELECT * FROM ZTPMC_BZWL"
  ]) {
    await assert.rejects(
      runScopedQueryFallback(query, 2, "200", nativeError, async () => {
        assert.fail("out-of-scope query invoked SAP")
      }),
      (error) => error === nativeError
    )
  }
  for (const limit of [0, -1, 1002, 1.5, NaN]) {
    await assert.rejects(
      runScopedQueryFallback(sql, limit, "200", nativeError, async () => {
        assert.fail("invalid limit invoked SAP")
      }),
      (error) => error === nativeError
    )
  }
})

test("scoped query does not mask authorization errors or other native query failures", async () => {
  for (const error of [new Error("HTTP 403"), new Error("SQL invalid"), new Error("HTTP 404")]) {
    await assert.rejects(
      runScopedQueryFallback(sql, 2, "200", error, async () => {
        assert.fail("unexpected fallback")
      }),
      (actual) => actual === error
    )
  }
})

test("scoped query validates version, count, client, scope and primary-key ordering", async () => {
  for (const patch of [
    { EV_STATUS: "E" },
    { EV_VERSION: "2.0" },
    { EV_CODE: "" },
    { EV_COUNT: "" },
    { EV_COUNT: "2" },
    { ET_ROWS: [] },
    { ET_ROWS: [{ ...row, WERKS: "808P" }] },
    { ET_ROWS: [{ ...row, MANDT: "100" }] },
    { ET_ROWS: [{ ...row, ZPOSNR: "1" }] },
    { EV_COUNT: "2", ET_ROWS: [row, row] },
    { EV_COUNT: "2", ET_ROWS: [{ ...row, ZPOSNR: "000002" }, row] }
  ]) {
    await assert.rejects(
      runScopedQueryFallback(sql, 2, "200", nativeError, async () => ({
        outputs: { ...success().outputs, ...patch }
      })),
      /SAP_SCOPED_QUERY_FAILED/
    )
  }
  await assert.rejects(
    runScopedQueryFallback(sql, 1, "200", nativeError, async () => ({
      outputs: { ...success().outputs, EV_COUNT: "2", ET_ROWS: [row, { ...row, ZPOSNR: "000002" }] }
    })),
    /SAP_SCOPED_QUERY_FAILED/
  )
})

test("scoped query accepts a genuine empty result but never leaks helper faults", async () => {
  assert.deepEqual(
    await runScopedQueryFallback(sql, 2, "200", nativeError, async () => ({
      outputs: { ...success().outputs, EV_COUNT: "0", ET_ROWS: [] }
    })),
    []
  )
  for (const invoke of [
    async () => {
      throw new Error("PRIVATE_SECRET")
    },
    async () => ({ ...success(), fault: { code: "X", name: "X", message: "PRIVATE_SECRET" } })
  ]) {
    await assert.rejects(
      runScopedQueryFallback(sql, 2, "200", nativeError, invoke),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /SAP_SCOPED_QUERY_FAILED/)
        assert.doesNotMatch(error.message, /PRIVATE_SECRET/)
        return true
      }
    )
  }
})

test("real HTTP backend falls back through SOAP and public query pagination", async (t) => {
  let soapCalls = 0
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost")
    if (url.pathname === "/sap/bc/adt/datapreview/freestyle") {
      response.writeHead(200, { "Content-Type": "text/html" })
      response.end("")
    } else if (url.pathname === "/sap/bc/soap/rfc") {
      soapCalls++
      let body = ""
      for await (const chunk of request) body += chunk.toString()
      assert.match(body, /<IV_LIMIT>2<\/IV_LIMIT>/)
      assert.match(body, /<IV_WERKS>809P<\/IV_WERKS>/)
      const items = [row, { ...row, ZPOSNR: "000002" }]
        .map(
          (item) =>
            `<item>${Object.entries(item)
              .map(([key, value]) => `<${key}>${value}</${key}>`)
              .join("")}</item>`
        )
        .join("")
      response.writeHead(200, { "Content-Type": "text/xml" })
      response.end(
        `<Envelope><Body><Z_ORVANTA_MCP_QUERY_API.Response><EV_STATUS>S</EV_STATUS><EV_CODE>QUERY_OK</EV_CODE><EV_VERSION>1.0</EV_VERSION><EV_COUNT>2</EV_COUNT><ET_ROWS>${items}</ET_ROWS></Z_ORVANTA_MCP_QUERY_API.Response></Body></Envelope>`
      )
    } else {
      response.writeHead(200, { "Content-Type": "application/xml", "x-csrf-token": "test-token" })
      response.end("<graph/>")
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
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
  t.after(async () => {
    await backend.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  })
  const result = JSON.parse(
    await new ToolService(backend).executeDataQuery({
      connectionId: "w200",
      sql,
      displayMode: "internal",
      maxRows: 1,
      rowRange: { start: 0, end: 1 }
    })
  )
  assert.equal(result.truncated, true)
  assert.deepEqual(result.data, [{ WERKS: "809P", ZPOSNR: "000001" }])
  assert.equal(soapCalls, 1)
  await assert.rejects(
    backend.runQuery("w200", sql, 2, { allowScopedFallback: false }),
    /SAP_DATA_QUERY_RESPONSE_INVALID/
  )
  assert.equal(soapCalls, 1, "native-only query must not invoke the scoped helper")
  await assert.rejects(
    backend.runQuery("w200", "SELECT MANDT FROM T000", 2),
    /SAP_DATA_QUERY_RESPONSE_INVALID/
  )
  assert.equal(soapCalls, 1)
})
