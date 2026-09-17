import assert from "node:assert/strict"
import test from "node:test"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"
import type { UnitTestClassInfo } from "../src/backend.js"

const input = { connectionId: "w200", objectName: "ZCL_DEMO" }
const alert = { kind: "failedAssertion", title: "Expected 2", details: ["Actual 3"] }
const method = { name: "CHECK", executionTime: 0, alerts: [] }
for (const duration of [undefined, null, NaN, Infinity, -1]) {
  test(`Unit reports unknown timing without losing assertions: ${String(duration)}`, async () => {
    const backend = new MockBackend()
    backend.runUnitTests = async () => [
      {
        name: "LTC",
        alerts: [],
        methods: [
          { name: "POSITIVE", executionTime: 0, alerts: [] },
          {
            name: "NEGATIVE",
            ...(duration === undefined ? {} : { executionTime: duration }),
            alerts: [alert]
          }
        ]
      }
    ]
    const service = new ToolService(backend)
    const result = JSON.parse(await service.runUnitTests({ ...input, outputFormat: "json" }))
    assert.equal(result.status, "failed")
    assert.equal(result.total, 2)
    assert.equal(result.passed, 1)
    assert.equal(result.failed, 1)
    assert.equal(result.executionTime, null)
    assert.equal(result.classes[0].methods[1].executionTime, null)
    assert.deepEqual(result.classes[0].methods[1].alerts, [alert])
    const text = await service.runUnitTests(input)
    assert.match(text, /Time: unknown/)
    assert.match(text, /\[FAIL\] NEGATIVE \(unknown\)/)
    assert.doesNotMatch(text, /NaN|Infinity/)
  })
}

test("Unit preserves finite zero and positive durations", async () => {
  const backend = new MockBackend()
  backend.runUnitTests = async () => [
    {
      name: "LTC",
      alerts: [],
      methods: [method, { ...method, name: "SECOND", executionTime: 1.25 }]
    }
  ]
  const result = JSON.parse(
    await new ToolService(backend).runUnitTests({ ...input, outputFormat: "json" })
  )
  assert.equal(result.status, "passed")
  assert.equal(result.executionTime, 1.25)
  assert.equal(result.classes[0].methods[0].executionTime, 0)
})
for (const [label, classes, status] of [
  ["empty", [], "no_tests"],
  ["no methods", [{ name: "LTC", alerts: [], methods: [] }], "not_executed"],
  ["setup failure", [{ name: "LTC", alerts: [alert], methods: [] }], "failed"],
  [
    "assertion failure",
    [{ name: "LTC", alerts: [], methods: [{ ...method, alerts: [alert] }] }],
    "failed"
  ],
  ["returned method", [{ name: "LTC", alerts: [], methods: [method] }], "passed"]
] as Array<[string, UnitTestClassInfo[], string]>) {
  test(`Unit reporting distinguishes ${label}`, async () => {
    const backend = new MockBackend()
    backend.runUnitTests = async () => classes
    const report = JSON.parse(
      await new ToolService(backend).runUnitTests({ ...input, outputFormat: "json" })
    )
    assert.equal(report.status, status)
    assert.equal(report.activationPerformed, false)
    assert.equal(report.nativeAtc, false)
  })
}

test("Unit text class heading agrees with method failure", async () => {
  const backend = new MockBackend()
  backend.runUnitTests = async () => [
    { name: "LTC", alerts: [], methods: [{ ...method, alerts: [alert] }] }
  ]
  const result = await new ToolService(backend).runUnitTests(input)
  assert.match(result, /\[FAIL\] LTC/)
  assert.doesNotMatch(result, /\[PASS\] LTC/)
  assert.match(result, /SOME TESTS FAILED/)
})

test("Unit transport failure is not reported as no tests", async () => {
  const backend = new MockBackend()
  backend.runUnitTests = async () => {
    throw new Error("HTTP 403")
  }
  await assert.rejects(
    new ToolService(backend).runUnitTests({ ...input, outputFormat: "json" }),
    /HTTP 403/
  )
})
