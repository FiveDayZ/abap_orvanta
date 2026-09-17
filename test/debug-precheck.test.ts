import assert from "node:assert/strict"
import test from "node:test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import type { ADTClient } from "abap-adt-api"
import type { AdtHTTP, RequestOptions } from "abap-adt-api/build/AdtHTTP.js"
import { adtDiscovery } from "abap-adt-api/build/api/discovery.js"
import { debuggerListeners } from "abap-adt-api/build/api/debugger.js"
import { debugRequestFailure, inspectDebugger } from "../src/debug-precheck.js"

const paths = [
  "/sap/bc/adt/debugger",
  "/sap/bc/adt/debugger/listeners",
  "/sap/bc/adt/debugger/breakpoints"
]

function fixture(
  options: {
    paths?: string[]
    discoveryError?: Error
    listenerError?: Error
    conflict?: boolean
  } = {}
) {
  const calls: string[] = []
  const client: Parameters<typeof inspectDebugger>[0] = {
    async adtDiscovery() {
      calls.push("discovery")
      if (options.discoveryError) throw options.discoveryError
      return [
        {
          title: "Debugger",
          collection: (options.paths ?? paths).map((href) => ({ href, templateLinks: [] }))
        }
      ]
    },
    async debuggerListeners() {
      calls.push("listeners")
      if (options.listenerError) throw options.listenerError
      return options.conflict ? ({ conflictText: "OTHER SESSION" } as never) : undefined
    }
  }
  return { client, calls }
}

test("debug precheck reads metadata and conflicts without claiming execution", async () => {
  const { client, calls } = fixture()
  const result = await inspectDebugger(client, "DEVELOPER")
  assert.equal(result.status, "metadata_available")
  assert.deepEqual(result.discovery.advertisedEndpoints, paths)
  assert.equal(result.executionValidated, false)
  assert.equal(result.listenerStarted, false)
  assert.deepEqual(calls, ["discovery", "listeners"])
})

test("missing debug advertisement stops before listener GET and is not endpoint absence", async () => {
  const { client, calls } = fixture({ paths: paths.slice(0, 2) })
  const result = await inspectDebugger(client, "DEVELOPER")
  assert.equal(result.status, "not_advertised")
  assert.deepEqual(result.discovery.missingEndpoints, [paths[2]])
  assert.equal(result.listenerCheck.status, "not_attempted")
  assert.deepEqual(calls, ["discovery"])
})

for (const stage of ["discovery", "listener"] as const) {
  for (const status of [401, 403, 404, 500]) {
    test(`debug precheck preserves ${stage} HTTP ${status}`, async () => {
      const error = Object.assign(new Error("Do not disclose this backend message"), { status })
      const { client, calls } = fixture({ [`${stage}Error`]: error })
      const result = await inspectDebugger(client, "DEVELOPER")
      const failure =
        stage === "discovery" ? result.discovery.failure : result.listenerCheck.failure
      assert.equal(failure?.httpStatus, status)
      assert.equal(result.status, stage === "listener" && status === 404 ? "blocked" : "failed")
      assert.equal(result.listenerStarted, false)
      assert.equal(JSON.stringify(result).includes(error.message), false)
      if (stage === "discovery") assert.deepEqual(calls, ["discovery"])
      if (stage === "listener" && status === 404)
        assert.equal(result.listenerCheck.status, "not_found_ambiguous")
    })
  }
}

test("debug precheck leaves other listeners alone and avoids synthetic HTTP statuses", async () => {
  const { client } = fixture({ conflict: true })
  assert.equal((await inspectDebugger(client, "DEVELOPER")).listenerCheck.status, "conflict")
  assert.deepEqual(debugRequestFailure(new Error("socket closed")), {
    category: "request-failed",
    httpStatus: null
  })
  assert.equal(
    debugRequestFailure(new Error("Request failed with status code 404")).httpStatus,
    404
  )
  assert.equal(
    debugRequestFailure(Object.assign(new Error("error 404"), { status: 503 })).httpStatus,
    503
  )
})

test("debug precheck uses actual SDK discovery/listener HTTP GET only", async () => {
  const requests: string[] = []
  const server = createServer((request, response) => {
    const path = new URL(request.url!, "http://127.0.0.1").pathname
    requests.push(`${request.method} ${path}`)
    if (path === "/sap/bc/adt/discovery") {
      response.setHeader("Content-Type", "application/xml")
      response.end(
        `<app:service xmlns:app="http://www.w3.org/2007/app" xmlns:atom="http://www.w3.org/2005/Atom"><app:workspace><atom:title>Debugger</atom:title>${paths.map((href) => `<app:collection href="${href}"/>`).join("")}</app:workspace></app:service>`
      )
    } else {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const http = {
      async request(path: string, options: RequestOptions = {}) {
        const url = new URL(path, base)
        for (const [key, value] of Object.entries(options.qs ?? {}))
          url.searchParams.set(key, String(value))
        const response = await fetch(url, { method: options.method ?? "GET" })
        if (!response.ok)
          throw Object.assign(new Error("HTTP failure"), { status: response.status })
        return { body: await response.text() }
      }
    } as unknown as AdtHTTP
    const client = {
      adtDiscovery: () => adtDiscovery(http),
      debuggerListeners: (...args: Parameters<ADTClient["debuggerListeners"]>) =>
        debuggerListeners(http, ...args)
    }
    const result = await inspectDebugger(client, "DEVELOPER")
    assert.equal(result.status, "blocked")
    assert.equal(result.listenerCheck.status, "not_found_ambiguous")
    assert.deepEqual(requests, ["GET /sap/bc/adt/discovery", "GET /sap/bc/adt/debugger/listeners"])
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})
