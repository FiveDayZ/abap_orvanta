import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"
import { AdtBackend, parseRemoteFunctionResponse } from "../src/adt-backend.js"
import { parseConnections } from "../src/config.js"

test("unit CTS key retains wire padding through the actual SOAP backend route", async (t) => {
  const server = createServer((request, response) => {
    request.resume()
    response.writeHead(200, { "Content-Type": "text/xml" })
    response.end("<r><EV_CODE> APPLIED </EV_CODE><EV_TABKEY>2001KG </EV_TABKEY></r>")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const passwordEnv = "ORVANTA_UNIT_KEY_TEST_DUMMY_PASSWORD"
  const previous = process.env[passwordEnv]
  process.env[passwordEnv] = "unit-test-placeholder"
  t.after(() => {
    if (previous === undefined) delete process.env[passwordEnv]
    else process.env[passwordEnv] = previous
  })
  const backend = new AdtBackend(
    parseConnections({
      connections: [
        {
          id: "mock",
          url: `http://127.0.0.1:${address.port}`,
          client: "200",
          username: "test",
          passwordEnv
        }
      ]
    })
  )
  const outputs = [
    { name: "EV_CODE", kind: "scalar" as const },
    { name: "EV_TABKEY", kind: "scalar" as const }
  ]
  const unit = await backend.callRemoteFunction("mock", {
    functionName: "Z_ORVANTA_CFG_UNIT_APPLY",
    inputParameters: {},
    outputParameters: outputs
  })
  assert.deepEqual(unit.outputs, { EV_CODE: "APPLIED", EV_TABKEY: "2001KG " })
  const other = await backend.callRemoteFunction("mock", {
    functionName: "Z_OTHER_API",
    inputParameters: {},
    outputParameters: outputs
  })
  assert.deepEqual(other.outputs, { EV_CODE: "APPLIED", EV_TABKEY: "2001KG" })
})

test("scalar padding preservation stays selective and preserves encoded blanks and key case", () => {
  const result = parseRemoteFunctionResponse(
    "<r><EV_TABKEY>2001kg&#32;</EV_TABKEY><EV_CODE> APPLIED </EV_CODE></r>",
    [
      { name: "EV_TABKEY", kind: "scalar" },
      { name: "EV_CODE", kind: "scalar" }
    ],
    false,
    [],
    ["EV_TABKEY"]
  )
  assert.deepEqual(result.outputs, { EV_TABKEY: "2001kg ", EV_CODE: "APPLIED" })
})

test("preserving one scalar does not turn a SOAP fault into output success", () => {
  const result = parseRemoteFunctionResponse(
    "<Fault><faultcode> Server </faultcode><faultstring> Refused </faultstring></Fault>",
    [{ name: "EV_TABKEY", kind: "scalar" }],
    false,
    [],
    ["EV_TABKEY"]
  )
  assert.deepEqual(result.outputs, {})
  assert.equal(result.fault?.code, "Server")
  assert.equal(result.fault?.message, "Refused")
})
