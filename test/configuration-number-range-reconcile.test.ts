import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { reconcileConfigurationNumberRange as reconcile } from "../src/configuration-number-range-reconcile.js"
import { configurationNumberRangeNativeTables as layouts } from "../src/configuration-number-range-native.js"
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

const detailedInput = {
  connectionId: "w200",
  objectName: "ZORVCFGNR",
  operationId: "field-comparison-fixture",
  includeFieldDifferences: true
}
const detailedReceipt = () => ({
  ...receipt(),
  operationIdHash: hash(detailedInput.operationId),
  targetKeyHash: hash("CONFIG:NRIV:200:ZORVCFGNR"),
  sapPreChangeEvidence: { target: "NRIV:ZORVCFGNR:200", version, observationStatus: "complete" }
})
const detailedSnapshot = (currentVersion = version, level = "00000000000000000000") => ({
  ...snapshot(),
  EV_VERSION: currentVersion,
  ES_DEFINITION: {
    ...Object.fromEntries(layouts.TNRO.fields.map((field) => [field, ""])),
    OBJECT: "ZORVCFGNR",
    DOMLEN: "NUMC20"
  },
  ET_INTERVALS: [
    {
      CLIENT: "200",
      OBJECT: "ZORVCFGNR",
      SUBOBJECT: "",
      NRRANGENR: "02",
      TOYEAR: "0000",
      FROMNUMBER: "00000000000000000001",
      TONUMBER: "00000000000000000100",
      NRLEVEL: level,
      EXTERNIND: ""
    }
  ]
})

test("detailed reconciliation reports NRLEVEL changes, repeats current state and binds recheck", async () => {
  const original = detailedReceipt(),
    saved = JSON.stringify(original)
  let reads = 0
  const current = detailedSnapshot("b".repeat(64), "00000000000000000001")
  const first = await reconcile(
    detailedInput,
    "200",
    async () => original,
    async () => {
      reads++
      return current
    },
    async () => detailedSnapshot()
  )
  assert.ok("fieldComparison" in first && first.fieldComparison)
  assert.equal(first.fieldComparison.status, "different_fields")
  assert.deepEqual(
    first.fieldComparison.differences.map((change) => change.field),
    ["NRLEVEL"]
  )
  assert.equal(reads, 2)
  assert.ok("readFlow" in first && first.readFlow)
  const second = await reconcile(
    first.readFlow.comparison.arguments,
    "200",
    async () => original,
    async () => {
      reads++
      return current
    },
    async () => detailedSnapshot()
  )
  assert.ok("versionGuard" in second && second.versionGuard)
  assert.equal(second.versionGuard.status, "match")
  assert.equal(reads, 4)
  assert.equal(JSON.stringify(original), saved)
  assert.ok("outcomeMayBeUnknown" in second && second.outcomeMayBeUnknown)
  assert.equal(second.retryAvailable, false)
  const equal = await reconcile(
    detailedInput,
    "200",
    async () => original,
    async () => detailedSnapshot(),
    async () => detailedSnapshot()
  )
  assert.ok("fieldComparison" in equal && equal.fieldComparison)
  assert.equal(equal.fieldComparison.status, "equal_fields")
  assert.deepEqual(equal.fieldComparison.differences, [])
  const other = detailedSnapshot("c".repeat(64))
  Object.assign(other.ES_DEFINITION, { PERCENTAGE: "12.0" })
  other.ET_INTERVALS.push({ ...other.ET_INTERVALS[0]!, NRRANGENR: "03" })
  const complete = await reconcile(
    detailedInput,
    "200",
    async () => original,
    async () => other,
    async () => detailedSnapshot()
  )
  assert.ok("fieldComparison" in complete && complete.fieldComparison)
  assert.ok(
    complete.fieldComparison.differences.some(
      (change) => change.table === "TNRO" && change.field === "PERCENTAGE"
    )
  )
  assert.ok(
    complete.fieldComparison.differences.some(
      (change) => change.table === "NRIV" && change.key.NRRANGENR === "03" && change.before === null
    )
  )
  assert.equal(JSON.stringify(original), saved)
})

test("missing, wrong-version and duplicate before state cannot fabricate equality or query SAP", async () => {
  let reads = 0
  for (const before of [
    null,
    detailedSnapshot("c".repeat(64)),
    {
      ...detailedSnapshot(),
      ET_INTERVALS: [...detailedSnapshot().ET_INTERVALS, ...detailedSnapshot().ET_INTERVALS]
    }
  ]) {
    const result = await reconcile(
      detailedInput,
      "200",
      async () => detailedReceipt(),
      async () => {
        reads++
        return detailedSnapshot()
      },
      async () => before
    )
    assert.ok("fieldComparison" in result)
    assert.equal(result.fieldComparison, null)
    assert.equal(result.snapshot, null)
    assert.ok(["BEFORE_SNAPSHOT_UNAVAILABLE", "BEFORE_SNAPSHOT_INVALID"].includes(result.code!))
  }
  assert.equal(reads, 0)
})

test("same-version content drift between current reads withdraws the detailed result", async () => {
  let reads = 0
  const result = await reconcile(
    detailedInput,
    "200",
    async () => detailedReceipt(),
    async () =>
      detailedSnapshot(version, ++reads === 1 ? "00000000000000000000" : "00000000000000000001"),
    async () => detailedSnapshot()
  )
  assert.equal(result.code, "CURRENT_SNAPSHOT_CHANGED")
  assert.equal(result.snapshot, null)
  assert.ok("readFlow" in result && result.readFlow === null)
})

test("expected receipt and current fingerprints reject changes without a comparison", async () => {
  let reads = 0
  const staleReceipt = await reconcile(
    { ...detailedInput, expectedReceiptHash: "c".repeat(64) },
    "200",
    async () => detailedReceipt(),
    async () => {
      reads++
      return detailedSnapshot()
    },
    async () => detailedSnapshot()
  )
  assert.equal(staleReceipt.code, "RECEIPT_CHANGED")
  assert.equal(reads, 0)
  const staleState = await reconcile(
    { ...detailedInput, expectedCurrentFingerprint: "c".repeat(64) },
    "200",
    async () => detailedReceipt(),
    async () => {
      reads++
      return detailedSnapshot()
    },
    async () => detailedSnapshot()
  )
  assert.equal(staleState.code, "CURRENT_VERSION_CHANGED")
  assert.equal(reads, 1)
  assert.equal(staleState.snapshot, null)
})

test("changed receipt, missing target and native version conflicts remain unresolved", async () => {
  let receipts = 0
  const changed = await reconcile(
    detailedInput,
    "200",
    async () => ({
      ...detailedReceipt(),
      receiptHash: ++receipts === 1 ? version : "b".repeat(64)
    }),
    async () => detailedSnapshot(),
    async () => detailedSnapshot()
  )
  assert.equal(changed.code, "RECEIPT_CHANGED")
  assert.equal(changed.snapshot, null)
  const missing = await reconcile(
    detailedInput,
    "200",
    async () => detailedReceipt(),
    async () => ({ ...detailedSnapshot(), ET_INTERVALS: [] }),
    async () => detailedSnapshot()
  )
  assert.equal(missing.code, "CURRENT_TARGET_UNAVAILABLE")
  const conflict = await reconcile(
    detailedInput,
    "200",
    async () => detailedReceipt(),
    async () => detailedSnapshot(version, "00000000000000000001"),
    async () => detailedSnapshot()
  )
  assert.equal(conflict.code, "NATIVE_VERSION_CONFLICT")
  assert.equal(conflict.snapshot, null)
})

test("new flags cannot broaden objects, import paths or add reads to default reconciliation", async () => {
  let calls = 0
  for (const raw of [
    { ...input, includeFieldDifferences: true },
    { ...input, expectedCurrentVersion: version },
    { ...detailedInput, beforeStatePath: "../credentials.json" },
    { ...detailedInput, captureState: true }
  ])
    await assert.rejects(
      reconcile(
        raw,
        "200",
        async () => {
          calls++
          return receipt()
        },
        async () => snapshot(),
        async () => detailedSnapshot()
      )
    )
  assert.equal(calls, 0)
  const legacy = await reconcile(
    input,
    "200",
    async () => receipt(),
    async () => {
      calls++
      return snapshot()
    }
  )
  assert.equal(calls, 1)
  assert.equal("fieldComparison" in legacy, false)
})
