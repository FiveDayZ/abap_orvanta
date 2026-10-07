import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { reconcileConfigurationNumberRange as reconcile } from "../src/configuration-number-range-reconcile.js"
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const version = "a".repeat(64)
const input = { connectionId: "w200", objectName: "ZTESTNR", operationId: "reconcile-fixture" }
const receipt = () => ({
  connectionId: "w200",
  toolName: "apply_configuration_number_range",
  operationIdHash: hash(input.operationId),
  targetKeyHash: hash("CONFIG:NRIV:200:ZTESTNR"),
  receiptHash: version,
  sapInvocationStarted: true,
  outcomeMayBeUnknown: true,
  status: "failed",
  sapPreChangeEvidence: { target: "NRIV:ZTESTNR:200", version, observationStatus: "complete" }
})
const snapshot = () => ({
  EV_CODE: "READ_OK",
  EV_SYSTEM: "GR2",
  EV_CLIENT: "200",
  EV_VERSION: version,
  ES_DEFINITION: { OBJECT: "ZTESTNR" },
  ET_INTERVALS: []
})
test("missing and not-dispatched number range receipts skip native reading", async () => {
  let calls = 0
  for (const observed of [
    { status: "not_found" },
    { ...receipt(), sapInvocationStarted: false, outcomeMayBeUnknown: false }
  ]) {
    const r = await reconcile(
      input,
      "200",
      async () => observed,
      async () => {
        calls++
        return snapshot()
      }
    )
    assert.ok(["receipt_unavailable", "not_dispatched"].includes(r.status))
    assert.equal(r.retryAvailable, false)
  }
  assert.equal(calls, 0)
})
test("number range same or changed current values never resolve the historical unknown receipt", async () => {
  const original = receipt(),
    before = JSON.stringify(original)
  for (const current of [version, "b".repeat(64)]) {
    const r = await reconcile(
      input,
      "200",
      async () => original,
      async () => ({ ...snapshot(), EV_VERSION: current })
    )
    assert.equal(r.status, "partial")
    assert.ok("outcomeMayBeUnknown" in r && "stateComparison" in r)
    assert.equal(r.outcomeMayBeUnknown, true)
    assert.equal(r.stateComparison, current === version ? "same_as_before" : "changed_since_before")
    assert.equal(r.retryAvailable, false)
    assert.equal(JSON.stringify(original), before)
  }
})
test("number range receipt identity mismatch cannot query SAP or attribute another operation", async () => {
  let calls = 0
  for (const invalid of [
    { ...receipt(), operationIdHash: version },
    { ...receipt(), targetKeyHash: version },
    { ...receipt(), toolName: "apply_configuration_unit_text" },
    {
      ...receipt(),
      sapPreChangeEvidence: { ...receipt().sapPreChangeEvidence, target: "NRIV:ZOTHER:200" }
    }
  ])
    await assert.rejects(
      reconcile(
        input,
        "200",
        async () => invalid,
        async () => {
          calls++
          return snapshot()
        }
      )
    )
  assert.equal(calls, 0)
})
test("number range reader failure and concurrently changed receipt withhold current snapshot", async () => {
  const failed = await reconcile(
    input,
    "200",
    async () => receipt(),
    async () => {
      throw Error("READ_CHANGED")
    }
  )
  assert.equal(failed.code, "SNAPSHOT_UNAVAILABLE")
  assert.equal(failed.snapshot, null)
  let reads = 0
  const changed = await reconcile(
    input,
    "200",
    async () => ({ ...receipt(), receiptHash: ++reads === 1 ? version : "b".repeat(64) }),
    async () => snapshot()
  )
  assert.equal(changed.code, "RECEIPT_CHANGED")
  assert.equal(changed.snapshot, null)
})
test("invalid reconciliation scope refuses before receipt access", async () => {
  let calls = 0
  for (const raw of [
    { ...input, execute: true },
    { ...input, connectionId: "w300" },
    { ...input, objectName: "TESTNR" }
  ])
    await assert.rejects(
      reconcile(
        raw,
        "200",
        async () => {
          calls++
          return receipt()
        },
        async () => snapshot()
      )
    )
  await assert.rejects(
    reconcile(
      input,
      "300",
      async () => {
        calls++
        return receipt()
      },
      async () => snapshot()
    )
  )
  assert.equal(calls, 0)
})
