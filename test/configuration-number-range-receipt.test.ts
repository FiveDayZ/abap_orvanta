import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test, { type TestContext } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { protectConfigurationNumberRangeCommand as protect } from "../src/configuration-number-range-receipt.js"
import { WriteOperationReceiptStore, hashWriteInput } from "../src/write-operation-receipts.js"
import type { applyConfigurationNumberRange } from "../src/configuration-number-range-command.js"

const input = () => ({
  connectionId: "w200",
  objectName: "ZTESTNR",
  expectedVersion: "a".repeat(64),
  action: "create",
  intervalNumber: "01",
  fromNumber: "00000000000000000001",
  toNumber: "00000000000000000100",
  external: false,
  operationId: "receipt-number-range",
  acknowledgeConfigurationWrite: true,
  acknowledgeLocalClientOnly: true
})
const result = (
  status: "completed" | "unknown" | "no_changes" | "declined",
  id = input().operationId
): Awaited<ReturnType<typeof applyConfigurationNumberRange>> => ({
  status,
  operationId: id,
  objectName: "ZTESTNR",
  client: "200",
  transportPolicy: "local_client_only_not_recorded",
  sapInvocationStarted: true,
  outcomeMayBeUnknown: status === "unknown",
  native: null,
  readback: null,
  failure: null,
  retryAvailable: false
})
const snapshot = () => ({
  EV_CODE: "READ_OK",
  EV_SYSTEM: "GR2",
  EV_CLIENT: "200",
  EV_VERSION: input().expectedVersion,
  ES_DEFINITION: { OBJECT: "ZTESTNR" },
  ET_INTERVALS: []
})
async function store(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "orvanta-nr-receipt-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  return new WriteOperationReceiptStore(root)
}

test("number range receipt persists invocation before dispatch and blocks same-operation replay", async (t) => {
  const receipts = await store(t)
  let calls = 0
  const execute = async (
    data: ReturnType<typeof input>,
    mark: (id: string, snapshot: unknown) => Promise<void>
  ) => {
    await mark(data.operationId, snapshot())
    assert.equal((await receipts.status("w200", data.operationId)).sapInvocationStarted, true)
    assert.equal(
      (
        (await receipts.status("w200", data.operationId)).sapPreChangeEvidence as {
          version: string
        }
      ).version,
      data.expectedVersion
    )
    calls++
    return result("completed")
  }
  const first = await protect(input(), receipts, execute)
  assert.equal(first.status, "completed")
  assert.equal(first.operationReceipt.status, "completed")
  assert.equal(
    first.operationReceipt.receiptHash,
    (await receipts.status("w200", input().operationId)).receiptHash
  )
  assert.equal((await protect(input(), receipts, execute)).status, "protection_refused")
  assert.equal(calls, 1)
})

test("number range unknown result stays failed in the protected receipt", async (t) => {
  const receipts = await store(t)
  const observed = await protect(input(), receipts, async (data, mark) => {
    await mark(data.operationId, snapshot())
    return result("unknown")
  })
  assert.equal(observed.status, "unknown")
  assert.equal(observed.operationReceipt.status, "failed")
  assert.equal(observed.operationReceipt.outcomeMayBeUnknown, true)
  assert.equal(observed.operationReceipt.automaticRetry, false)
  assert.equal(
    observed.operationReceipt.receiptHash,
    (await receipts.status("w200", input().operationId)).receiptHash
  )
})

test("an unknown number range outcome blocks another operation and interval across store instances", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-nr-cross-instance-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const receipts = new WriteOperationReceiptStore(root)
  const observed = await protect(input(), receipts, async (data, mark) => {
    await mark(data.operationId, snapshot())
    return result("unknown")
  })
  assert.equal(observed.operationReceipt.localLockReleased, false)
  let dispatched = 0
  const next = await protect(
    { ...input(), operationId: "different-operation", intervalNumber: "02" },
    new WriteOperationReceiptStore(root, "restarted-instance"),
    async () => {
      dispatched++
      return result("completed", "different-operation")
    }
  )
  assert.equal(next.status, "protection_refused")
  assert.equal(dispatched, 0)
  assert.equal(
    (await receipts.status("w200", input().operationId)).receiptHash,
    observed.operationReceipt.receiptHash
  )
})

test("a legacy released unknown receipt still blocks a new number range command", async (t) => {
  const receipts = await store(t)
  const old = await receipts.reserve({
    connectionId: "w200",
    toolName: "apply_configuration_number_range",
    operationId: "legacy-unknown",
    targetKey: "CONFIG:NRIV:200:ZTESTNR",
    inputHash: hashWriteInput(input()),
    preChangeSummary: "Old number range command",
    recoveryGuide: "Never retry"
  })
  assert.equal(old.status, "reserved")
  if (old.status !== "reserved") return
  await receipts.markSapInvocationStarted(old.reservation)
  const prior = await receipts.fail(old.reservation, Error("old interrupted call"), 1)
  assert.equal(prior.localLockReleased, true)
  const priorHash = (await receipts.status("w200", "legacy-unknown")).receiptHash
  const observed = await protect(input(), receipts, async () => {
    assert.fail("legacy unknown must prevent dispatch")
  })
  assert.equal(observed.status, "protection_refused")
  assert.equal(observed.operationReceipt.blockingState, "unknown")
  assert.equal((await receipts.status("w200", "legacy-unknown")).receiptHash, priorHash)
})

test("an unknown object does not block an independent object", async (t) => {
  const receipts = await store(t)
  await protect(input(), receipts, async (data, mark) => {
    await mark(data.operationId, snapshot())
    return result("unknown")
  })
  const observed = await protect(
    { ...input(), objectName: "ZOTHER", operationId: "independent" },
    receipts,
    async (data, mark) => {
      await mark(data.operationId, { ...snapshot(), ES_DEFINITION: { OBJECT: "ZOTHER" } })
      return { ...result("completed", data.operationId), objectName: "ZOTHER" }
    }
  )
  assert.equal(observed.status, "completed")
})

test("foreign persisted receipt identity cannot attest a completed command", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-nr-foreign-receipt-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  class ForeignStatus extends WriteOperationReceiptStore {
    override async status(connection: string, operation: string) {
      return { ...(await super.status(connection, operation)), targetKeyHash: "c".repeat(64) }
    }
  }
  const observed = await protect(input(), new ForeignStatus(root), async (data, mark) => {
    await mark(data.operationId, snapshot())
    return result("completed")
  })
  assert.equal(observed.status, "unknown")
  assert.equal(observed.failure?.stage, "receipt")
})

test("receipt persistence failure keeps the earlier native root cause", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-nr-first-cause-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  class CannotFinish extends WriteOperationReceiptStore {
    override async fail(): Promise<Record<string, unknown>> {
      throw Error("disk failed with secret-path")
    }
  }
  const failure = {
    stage: "native_call" as const,
    code: "CONFIGURATION_NR_TRANSPORT_FAILED",
    evidenceHash: "d".repeat(64)
  }
  const observed = await protect(input(), new CannotFinish(root), async (data, mark) => {
    await mark(data.operationId, snapshot())
    return { ...result("unknown"), failure }
  })
  assert.equal(observed.status, "unknown")
  assert.deepEqual(observed.failure, failure)
  assert.doesNotMatch(JSON.stringify(observed), /secret-path/)
})

test("protected unknown receipt retains the native cause code and hash without raw credentials", async (t) => {
  const receipts = await store(t)
  const failure = {
    stage: "native_call" as const,
    code: "CONFIGURATION_NR_SOAP_FAULT",
    evidenceHash: "e".repeat(64)
  }
  const observed = await protect(input(), receipts, async (data, mark) => {
    await mark(data.operationId, snapshot())
    return { ...result("unknown"), failure }
  })
  const durable = await receipts.status("w200", input().operationId)
  assert.equal(durable.errorCode, failure.code)
  assert.equal(
    durable.errorHash,
    createHash("sha256").update(`Error: ${failure.code}:${failure.evidenceHash}`).digest("hex")
  )
  assert.ok("failure" in observed)
  assert.deepEqual(observed.failure, failure)
})

test("wrong client, object or operation prechange identity prevents dispatch", async (t) => {
  const receipts = await store(t)
  let dispatched = 0
  for (const [index, wrong] of [
    { ...snapshot(), EV_CLIENT: "300" },
    { ...snapshot(), ES_DEFINITION: { OBJECT: "ZOTHER" } },
    { ...snapshot(), EV_VERSION: "b".repeat(64) }
  ].entries()) {
    const command = { ...input(), operationId: `wrong-scope-${index}` }
    const observed = await protect(command, receipts, async (data, mark) => {
      await mark(data.operationId, wrong)
      dispatched++
      return result("completed", data.operationId)
    })
    assert.equal(observed.status, "declined")
    assert.equal(observed.sapInvocationStarted, false)
  }
  assert.equal(dispatched, 0)
})

test("all intervals of a client object share one receipt lock", async (t) => {
  const receipts = await store(t)
  let unblock!: () => void, entered!: () => void
  const waiting = new Promise<void>((resolve) => {
    unblock = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let secondCalls = 0
  const first = protect(input(), receipts, async (data, mark) => {
    await mark(data.operationId, snapshot())
    entered()
    await waiting
    return result("completed")
  })
  await started
  try {
    const other = await protect(
      { ...input(), operationId: "other-interval", intervalNumber: "02" },
      receipts,
      async () => {
        secondCalls++
        return result("completed", "other-interval")
      }
    )
    assert.equal(other.status, "protection_refused")
    assert.equal(secondCalls, 0)
  } finally {
    unblock()
    await first
  }
})

test("invalid input and failures before invocation never report an unknown SAP write", async (t) => {
  const receipts = await store(t)
  let calls = 0
  await assert.rejects(
    protect({ ...input(), toNumber: input().fromNumber }, receipts, async () => {
      calls++
      return result("completed")
    })
  )
  assert.equal(calls, 0)
  const failed = await protect(input(), receipts, async () => {
    throw Error("metadata unavailable")
  })
  assert.equal(failed.status, "declined")
  assert.equal(failed.operationReceipt.sapInvocationStarted, false)
  assert.equal(failed.operationReceipt.outcomeMayBeUnknown, false)
})

test("receipt marking failure prevents dispatch; finalization failure preserves unknown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-nr-receipt-errors-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  class FailMarker extends WriteOperationReceiptStore {
    override async markSapInvocationStarted(): Promise<void> {
      throw Error("disk failure")
    }
  }
  let dispatched = 0
  const refused = await protect(
    input(),
    new FailMarker(join(root, "marker")),
    async (data, mark) => {
      await mark(data.operationId, snapshot())
      dispatched++
      return result("completed")
    }
  )
  assert.equal(dispatched, 0)
  assert.equal(refused.status, "declined")
  class FailFinalization extends WriteOperationReceiptStore {
    override async complete(): Promise<Record<string, unknown>> {
      throw Error("disk failure")
    }
  }
  const unknown = await protect(
    input(),
    new FailFinalization(join(root, "final")),
    async (data, mark) => {
      await mark(data.operationId, snapshot())
      dispatched++
      return result("completed")
    }
  )
  assert.equal(unknown.status, "unknown")
  assert.equal(unknown.operationReceipt.outcomeMayBeUnknown, true)
  assert.equal(dispatched, 1)
})

test("unreadable persisted number range receipt withholds success without another SAP dispatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-nr-receipt-read-error-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  class UnreadableStatus extends WriteOperationReceiptStore {
    override async status(): Promise<Record<string, unknown>> {
      throw Error("receipt read failure")
    }
  }
  const receipts = new UnreadableStatus(root)
  let dispatched = 0
  const execute = async (
    data: ReturnType<typeof input>,
    mark: (id: string, snapshot: unknown) => Promise<void>
  ) => {
    await mark(data.operationId, snapshot())
    dispatched++
    return result("completed")
  }
  const observed = await protect(input(), receipts, execute)
  assert.equal(observed.status, "unknown")
  assert.equal(observed.operationReceipt.outcomeMayBeUnknown, true)
  const durable = await new WriteOperationReceiptStore(root).status("w200", input().operationId)
  assert.equal(durable.status, "completed")
  assert.equal((await protect(input(), receipts, execute)).status, "protection_refused")
  assert.equal(dispatched, 1)
})
