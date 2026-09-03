import assert from "node:assert/strict"
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { writeOperationTarget } from "../src/mcp.js"
import { hashWriteInput, WriteOperationReceiptStore } from "../src/write-operation-receipts.js"

const identity = {
  connectionId: "w200",
  toolName: "patch_abap_screen",
  operationId: "write-receipt-1",
  targetKey: "PROG:ZMODULE_POOL",
  inputHash: hashWriteInput({ programName: "ZMODULE_POOL", source: "SECRET SOURCE" }),
  preChangeSummary: '{"target":"program ZMODULE_POOL","concurrencyGuard":"fingerprint abc"}',
  recoveryGuide: "Read back program ZMODULE_POOL before retrying."
}

test("write receipts serialize one target, retain hashes, and release the lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "abap-mcp-write-receipts-"))
  try {
    const store = new WriteOperationReceiptStore(root, "write-instance")
    const first = await store.reserve(identity)
    assert.equal(first.status, "reserved")
    if (first.status !== "reserved") throw new Error("Missing reservation")

    const concurrent = await store.reserve({ ...identity, operationId: "write-receipt-2" })
    assert.equal(concurrent.status, "target_busy")
    if (concurrent.status !== "target_busy") throw new Error("Expected target conflict")
    assert.equal(concurrent.receipt.blockingState, "in_progress")

    const completed = await store.complete(first.reservation, "saved and verified", 25)
    assert.equal(completed.status, "completed")
    assert.match(String(completed.resultHash), /^[a-f0-9]{64}$/)
    assert.equal(completed.automaticRollback, false)
    assert.equal(completed.localLockReleased, true)

    const next = await store.reserve({ ...identity, operationId: "write-receipt-3" })
    assert.equal(next.status, "reserved")
    if (next.status !== "reserved") throw new Error("Missing next reservation")
    await store.fail(next.reservation, new Error("SAP rejected the write"), 5)
    const failed = await store.status("w200", "write-receipt-3")
    assert.equal(failed.status, "failed")
    assert.equal(failed.outcomeMayBeUnknown, true)

    const files = await receiptFiles(root)
    const raw = (await Promise.all(files.map((path) => readFile(path, "utf8")))).join("\n")
    assert.doesNotMatch(raw, /SECRET SOURCE/)
    assert.doesNotMatch(raw, /write-receipt-[123]/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("write target keys align transaction operations and distinguish DDIC namespaces", () => {
  const createTransaction = writeOperationTarget(
    "create_transaction_code",
    { transactionCode: "zsafe_027", programName: "zprogram" },
    ""
  )
  const deleteTransaction = writeOperationTarget(
    "delete_transaction_code",
    { transactionCode: "ZSAFE_027", expectedProgramName: "ZPROGRAM" },
    ""
  )
  assert.equal(createTransaction.key, deleteTransaction.key)
  assert.equal(
    writeOperationTarget("upsert_ddic_structure", { objectName: "ZSAFE_027" }, "").key,
    "TABL:ZSAFE_027"
  )
  assert.equal(
    writeOperationTarget("create_ddic_transparent_table", { objectName: "ZSAFE_027" }, "").key,
    "TABL:ZSAFE_027"
  )
  assert.notEqual(
    writeOperationTarget("upsert_ddic_domain", { objectName: "ZSAFE_027" }, "").key,
    writeOperationTarget("upsert_ddic_data_element", { objectName: "ZSAFE_027" }, "").key
  )
})

test("a completed action remains completed when local lock cleanup needs recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "abap-mcp-write-lock-cleanup-"))
  try {
    const store = new WriteOperationReceiptStore(root, "cleanup-instance")
    const reserved = await store.reserve({ ...identity, operationId: "lock-cleanup" })
    assert.equal(reserved.status, "reserved")
    if (reserved.status !== "reserved") throw new Error("Missing reservation")
    const lock = JSON.parse(await readFile(reserved.reservation.lockPath, "utf8")) as Record<
      string,
      unknown
    >
    lock.serviceInstanceId = "another-instance"
    await writeFile(reserved.reservation.lockPath, `${JSON.stringify(lock)}\n`, "utf8")

    const completed = await store.complete(reserved.reservation, "saved and verified", 2)
    assert.equal(completed.status, "completed")
    assert.equal(completed.outcomeMayBeUnknown, false)
    assert.equal(completed.localLockReleased, false)
    assert.match(String(completed.lockReleaseErrorHash), /^[a-f0-9]{64}$/)
    assert.match(String(completed.manualRecovery), /Remove it only after a human confirms/)

    const status = await store.status("w200", "lock-cleanup")
    assert.equal(status.status, "completed")
    assert.equal(status.localLockReleased, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("write receipt operation IDs are idempotent and conflicting reuse fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "abap-mcp-write-duplicate-"))
  try {
    const store = new WriteOperationReceiptStore(root, "duplicate-instance")
    const reserved = await store.reserve(identity)
    assert.equal(reserved.status, "reserved")
    if (reserved.status !== "reserved") throw new Error("Missing reservation")
    await store.complete(reserved.reservation, "done", 1)

    const duplicate = await store.reserve(identity)
    assert.equal(duplicate.status, "duplicate")
    if (duplicate.status !== "duplicate") throw new Error("Expected duplicate")
    assert.equal(duplicate.conflict, false)

    const conflict = await store.reserve({ ...identity, inputHash: "f".repeat(64) })
    assert.equal(conflict.status, "duplicate")
    if (conflict.status !== "duplicate") throw new Error("Expected conflict")
    assert.equal(conflict.conflict, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("service restart reports interrupted writes and preserves the target lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "abap-mcp-write-interrupted-"))
  try {
    const first = new WriteOperationReceiptStore(root, "first-instance")
    assert.equal((await first.reserve(identity)).status, "reserved")

    const restarted = new WriteOperationReceiptStore(root, "second-instance")
    const interrupted = await restarted.status(identity.connectionId, identity.operationId)
    assert.equal(interrupted.status, "interrupted")
    assert.equal(interrupted.outcomeMayBeUnknown, true)
    assert.match(String(interrupted.manualRecovery), /Read back/)
    const lockPath = /Local operation lock: (.+)\. Remove it/.exec(
      String(interrupted.manualRecovery)
    )?.[1]
    assert.ok(lockPath)
    await access(lockPath)

    const retry = await restarted.reserve({ ...identity, operationId: "after-interruption" })
    assert.equal(retry.status, "target_busy")
    if (retry.status !== "target_busy") throw new Error("Expected stale lock conflict")
    assert.equal(retry.receipt.blockingState, "interrupted")
    assert.match(String(retry.receipt.manualRecovery), /remove the reported lock file/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function receiptFiles(root: string): Promise<string[]> {
  const receiptRoot = join(root, "write-receipts")
  const connectionDirectories = await readdir(receiptRoot)
  const result: string[] = []
  for (const directory of connectionDirectories) {
    const parent = join(receiptRoot, directory)
    for (const name of await readdir(parent)) {
      if (name.endsWith(".json")) result.push(join(parent, name))
    }
  }
  return result
}
