import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
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
    const evidence = {
      observedAt: "2026-09-03T03:00:00.000Z",
      target: "program ZMODULE_POOL",
      exists: true,
      active: true,
      version: "20260903030000",
      fingerprint: "a".repeat(64),
      packageName: "ZABAP",
      requestNumber: "GR2K923421",
      taskNumber: "GR2K923422",
      observationStatus: "complete" as const,
      sources: ["repository_assignment", "active_source"],
      warnings: []
    }
    await store.recordPreChangeEvidence(first.reservation, evidence)
    await store.markSapInvocationStarted(first.reservation)

    const concurrent = await store.reserve({ ...identity, operationId: "write-receipt-2" })
    assert.equal(concurrent.status, "target_busy")
    if (concurrent.status !== "target_busy") throw new Error("Expected target conflict")
    assert.equal(concurrent.receipt.blockingState, "in_progress")

    const completed = await store.complete(first.reservation, "saved and verified", 25)
    assert.equal(completed.version, 2)
    assert.equal(completed.status, "completed")
    assert.match(String(completed.resultHash), /^[a-f0-9]{64}$/)
    assert.equal(completed.automaticRollback, false)
    assert.equal(completed.localLockReleased, true)
    assert.equal(completed.sapInvocationStarted, true)
    assert.deepEqual(completed.sapPreChangeEvidence, evidence)

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
    assert.match(String(completed.manualRecovery), /release_write_operation_lock/)

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
    const firstReservation = await first.reserve(identity)
    assert.equal(firstReservation.status, "reserved")
    if (firstReservation.status !== "reserved") throw new Error("Missing reservation")

    const restarted = new WriteOperationReceiptStore(root, "second-instance")
    const interrupted = await restarted.status(identity.connectionId, identity.operationId)
    assert.equal(interrupted.status, "interrupted")
    assert.equal(interrupted.outcomeMayBeUnknown, true)
    assert.match(String(interrupted.manualRecovery), /Read back/)
    const lockPath = firstReservation.reservation.lockPath
    await access(lockPath)

    await assert.rejects(
      () =>
        first.releaseLocalLock(
          identity.connectionId,
          identity.operationId,
          String(interrupted.receiptHash),
          "SAP state checked"
        ),
      /still active/
    )

    const listed = await restarted.listRecoveryOperations(identity.connectionId, 1)
    assert.equal(listed.count, 1)
    assert.equal(listed.truncated, false)
    const listedOperations = listed.operations as Array<Record<string, unknown>>
    assert.equal(listedOperations[0]?.recoveryState, "interrupted")

    await assert.rejects(
      () =>
        restarted.releaseLocalLock(
          identity.connectionId,
          identity.operationId,
          "f".repeat(64),
          "SAP state checked"
        ),
      /Receipt hash changed/
    )

    const released = await restarted.releaseLocalLock(
      identity.connectionId,
      identity.operationId,
      String(interrupted.receiptHash),
      "SAP object, lock, package, request, and task were checked by the operator"
    )
    assert.equal(released.status, "local_lock_released")
    assert.equal(released.localLockReleased, true)
    assert.equal(released.sapLockChanged, false)
    assert.equal(released.recoveryActionSapInvocationStarted, false)
    assert.equal(released.automaticRetry, false)
    assert.equal(released.automaticRollback, false)
    assert.match(String(released.manualLockReleaseReasonHash), /^[a-f0-9]{64}$/)
    const rawReceipts = (
      await Promise.all((await receiptFiles(root)).map((path) => readFile(path, "utf8")))
    ).join("\n")
    assert.doesNotMatch(rawReceipts, /object, lock, package, request, and task/)
    assert.equal((await restarted.listRecoveryOperations(identity.connectionId, 10)).count, 0)
    await assert.rejects(() => access(lockPath))

    const retry = await restarted.reserve({ ...identity, operationId: "after-interruption" })
    assert.equal(retry.status, "reserved")
    if (retry.status !== "reserved") throw new Error("Expected released target")
    await restarted.fail(retry.reservation, new Error("test cleanup"), 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("recovery listing is bounded and includes stale completed locks", async () => {
  const root = await mkdtemp(join(tmpdir(), "abap-mcp-write-recovery-list-"))
  try {
    const first = new WriteOperationReceiptStore(root, "first-instance")
    const interrupted = await first.reserve({ ...identity, operationId: "interrupted-list" })
    assert.equal(interrupted.status, "reserved")
    const stale = await first.reserve({
      ...identity,
      operationId: "stale-list",
      targetKey: "PROG:ZSECOND"
    })
    assert.equal(stale.status, "reserved")
    if (stale.status !== "reserved") throw new Error("Missing stale reservation")
    const lock = JSON.parse(await readFile(stale.reservation.lockPath, "utf8")) as Record<
      string,
      unknown
    >
    lock.serviceInstanceId = "other-instance"
    await writeFile(stale.reservation.lockPath, `${JSON.stringify(lock)}\n`, "utf8")
    const completed = await first.complete(stale.reservation, "done", 1)
    assert.equal(completed.localLockReleased, false)

    const restarted = new WriteOperationReceiptStore(root, "restarted-instance")
    const all = await restarted.listRecoveryOperations(identity.connectionId, 10)
    assert.equal(all.count, 2)
    assert.equal(all.truncated, false)
    assert.deepEqual(
      new Set(
        (all.operations as Array<Record<string, unknown>>).map(
          (operation) => operation.recoveryState
        )
      ),
      new Set(["interrupted", "stale_lock"])
    )
    const bounded = await restarted.listRecoveryOperations(identity.connectionId, 1)
    assert.equal(bounded.count, 1)
    assert.equal(bounded.truncated, true)
    assert.equal((bounded.operations as unknown[]).length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("version 1 write receipts remain readable", async () => {
  const root = await mkdtemp(join(tmpdir(), "abap-mcp-write-v1-"))
  try {
    const operationId = "legacy-receipt"
    const connectionHash = sha256(identity.connectionId)
    const operationHash = sha256(operationId)
    const directory = join(root, "write-receipts", connectionHash)
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, `${operationHash}.json`),
      `${JSON.stringify({
        version: 1,
        state: "completed",
        connectionId: identity.connectionId,
        toolName: identity.toolName,
        operationIdHash: operationHash,
        targetKeyHash: sha256(identity.targetKey),
        inputHash: identity.inputHash,
        preChangeSummary: identity.preChangeSummary,
        recoveryGuide: identity.recoveryGuide,
        resultHash: "b".repeat(64),
        startedAt: "2026-09-03T02:00:00.000Z",
        finishedAt: "2026-09-03T02:00:01.000Z",
        durationMs: 1000,
        lockReleased: true,
        serviceInstanceId: "legacy-instance"
      })}\n`,
      "utf8"
    )

    const status = await new WriteOperationReceiptStore(root).status(
      identity.connectionId,
      operationId
    )
    assert.equal(status.version, 1)
    assert.equal(status.status, "completed")
    assert.equal(status.sapInvocationStarted, null)
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}
