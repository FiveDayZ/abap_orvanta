import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import test from "node:test"
import { AdtHTTP, type RequestOptions } from "abap-adt-api/build/AdtHTTP.js"
import { whereUsedHttp } from "../src/where-used-request.js"
import { AdtBackend } from "../src/adt-backend.js"
import { collectWhereUsed } from "../src/where-used.js"
import { legacyWhereUsedPaths } from "../src/legacy-where-used.js"
import { listenOnUnblockedPort } from "./loopback-port.js"

const discovery = "/sap/bc/adt/discovery"
const uri = "/sap/bc/adt/functions/groups/zgroup/fmodules/z_test/source/main"
const response = (body: string) => ({
  body,
  status: 200,
  statusText: "OK",
  headers: { "content-type": "application/xml" }
})
const discoveryXml = `<app:service><app:workspace>${legacyWhereUsedPaths.map((href) => `<app:collection href="${href}"/>`).join("")}</app:workspace></app:service>`
const mappingXml =
  "<ris_data_request><trobjtype>FUGR</trobjtype><subtype/><legacy_type>FF</legacy_type><object_name>Z_TEST</object_name><encl_object_name/><scope_trobjtype/><scope_subtype/><scope_legacy_type/><scope_object_name/><scope_encl_object_name/><full_name>FUNCTION=Z_TEST</full_name><suppress_selection_dialog>X</suppress_selection_dialog></ris_data_request>"
const metadataXml =
  "<ris_meta_object_types><ris_meta_object_type><trobjtype>CLAS</trobjtype><subtype/><legacy_type>OC</legacy_type></ris_meta_object_type></ris_meta_object_types>"

test("where-used HTTP trace has bounded timeouts and excludes request/response secrets", async () => {
  const optionsSeen: RequestOptions[] = []
  const original = async (_path: string, options: RequestOptions) => {
    optionsSeen.push(options)
    return response("private response")
  }
  const originalHttp = { request: original } as unknown as AdtHTTP
  const traced = whereUsedHttp(originalHttp)
  await traced.http.request(discovery, {
    headers: { Authorization: "private credential" },
    body: "private source"
  })
  assert.equal(originalHttp.request, original)
  assert.ok(optionsSeen[0]!.timeout! > 0 && optionsSeen[0]!.timeout! <= 15000)
  assert.deepEqual(Object.keys(traced.requests[0]!).sort(), [
    "elapsedMs",
    "httpStatus",
    "outcome",
    "responseBytes",
    "stage",
    "timeoutMs"
  ])
  assert.equal(traced.requests[0]!.httpStatus, 200)
  assert.equal(traced.requests[0]!.responseBytes, Buffer.byteLength("private response"))
  assert.doesNotMatch(JSON.stringify(traced.requests), /private|Authorization|body/)
})

test("where-used total budget prevents further requests and bounds the last request", async (t) => {
  let now = 0
  t.mock.method(performance, "now", () => now)
  let calls = 0
  const http = {
    async request(_path: string, options: RequestOptions) {
      calls++
      if (calls === 2) assert.equal(options.timeout, 5000)
      now = calls === 1 ? 40000 : 45000
      return response("")
    }
  } as unknown as AdtHTTP
  const traced = whereUsedHttp(http)
  await traced.http.request(discovery)
  await traced.http.request(legacyWhereUsedPaths[1])
  await assert.rejects(
    traced.http.request(legacyWhereUsedPaths[2]),
    /budget exhausted before metadata/
  )
  assert.equal(calls, 2)
  assert.equal(traced.requests[2]!.outcome, "budget-exhausted")
})

test("where-used distinguishes failing protocol stages without retry or false HTTP 500", async () => {
  const sequence = [
    [discovery, "discovery", discoveryXml],
    [legacyWhereUsedPaths[1], "mapping", mappingXml],
    [legacyWhereUsedPaths[2], "metadata", metadataXml],
    [legacyWhereUsedPaths[0], "references", "<ris_generic_results/>"]
  ] as const
  for (const [index, [failingPath, failingStage]] of sequence.entries()) {
    const calls: string[] = []
    const backend = new AdtBackend([])
    Object.assign(backend, {
      getClient: async () => ({
        statelessClone: {
          httpClient: {
            async request(path: string) {
              calls.push(path)
              if (path === failingPath) throw new Error("timeout of 15000ms exceeded")
              const step = sequence.find(([expected]) => expected === path)
              assert.ok(step)
              return response(step[2])
            }
          }
        }
      }),
      readSourceByUri: async () => ({ source: "FUNCTION Z_TEST\nENDFUNCTION.", uriUsed: uri })
    })
    const report = await collectWhereUsed(backend, {
      connectionId: "w200",
      objectName: "Z_TEST",
      objectUri: uri
    })
    assert.equal(report.status, "failed")
    assert.equal(report.references, null)
    assert.equal(report.rawCount, null)
    assert.equal(report.requestTrace?.at(-1)?.outcome, "timeout")
    assert.equal(report.requestTrace?.at(-1)?.stage, failingStage)
    assert.equal(report.engine, failingPath === discovery ? "ADT_WHERE_USED" : "ADT_RIS_WHEREUSED")
    assert.match(report.error!.message, /SAP cancellation is unconfirmed/)
    assert.doesNotMatch(report.error!.message, /HTTP 500/)
    assert.equal(calls.length, index + 1)
    assert.deepEqual(
      report.requestTrace?.map((entry) => entry.stage),
      sequence.slice(0, index + 1).map((entry) => entry[1])
    )
  }
})

test(
  "real SDK HTTP timeout closes a stalled local connection and returns a stage trace",
  { timeout: 25000 },
  async () => {
    let queryClosed: Promise<unknown> | undefined
    const server = createServer((request, reply) => {
      if (request.url?.startsWith("/sap/bc/adt/compatibility/graph")) {
        reply.setHeader("x-csrf-token", "Synthetic")
        reply.end("<graph/>")
      } else {
        queryClosed = once(request.socket, "close")
        // Deliberately no response: exercise the actual SDK transport, not a rejected mock.
      }
    })
    await listenOnUnblockedPort(server)
    try {
      const address = server.address()
      assert.ok(address && typeof address !== "string")
      const http = new AdtHTTP(
        `http://127.0.0.1:${address.port}`,
        "Synthetic",
        "Synthetic",
        "200",
        "EN"
      )
      await http.login()
      const traced = whereUsedHttp(http)
      await assert.rejects(traced.http.request(discovery), /timeout|timed out/i)
      assert.equal(traced.requests[0]!.stage, "discovery")
      assert.equal(traced.requests[0]!.outcome, "timeout")
      assert.ok(traced.requests[0]!.elapsedMs >= 14000)
      assert.ok(queryClosed)
      await queryClosed
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }
)
