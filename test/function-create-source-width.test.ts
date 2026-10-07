import assert from "node:assert/strict"
import test from "node:test"

import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"

test("function creation rejects truncated RSSOURCE input before calling SAP", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)
  const input = {
    functionName: "ZCMCP_FM_WIDTH",
    functionGroup: "ZCMCP_FG_1501",
    description: "Source width boundary",
    remoteEnabled: false,
    importParameters: [],
    exportParameters: [],
    changingParameters: [],
    tableParameters: [],
    exceptions: [],
    source: ["*" + "x".repeat(71)],
    packageName: "ZABAP",
    transportNumber: "GR2K923421",
    connectionId: "w200"
  }
  let calls = 0
  const repositoryCall = backend.callSapRepository.bind(backend)
  backend.callSapRepository = async (...args) => {
    calls++
    return repositoryCall(...args)
  }
  for (const line of ["*" + "x".repeat(72), "*" + "计".repeat(72)]) {
    await assert.rejects(
      tools.createFunctionModuleWithInterface({ ...input, source: [line] }),
      /72 characters \(RSSOURCE\)/
    )
    assert.equal(calls, 0)
  }
  const saved = JSON.parse(await tools.createFunctionModuleWithInterface(input))
  assert.equal(calls, 1)
  assert.ok(saved.source.includes(input.source[0]))
})
