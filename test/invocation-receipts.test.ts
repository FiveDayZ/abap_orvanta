import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { InvocationReceiptStore } from "../src/invocation-receipts.js"

const identity = {
  connectionId: "w200",
  functionName: "ZCMCP_FM_1901",
  requestId: "receipt-concurrency",
  interfaceFingerprint: "a".repeat(64),
  inputHash: "b".repeat(64)
}

test("persistent RFC receipts reserve one concurrent call and retain only hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "abap-mcp-receipts-"))
  try {
    const store = new InvocationReceiptStore(root, "concurrent-instance")
    assert.equal((await store.status("w200", "receipt-missing")).status, "not_found")
    const attempts = await Promise.all(Array.from({ length: 20 }, () => store.reserve(identity)))
    const reserved = attempts.filter(({ status }) => status === "reserved")
    const duplicates = attempts.filter(({ status }) => status === "duplicate")
    assert.equal(reserved.length, 1)
    assert.equal(duplicates.length, 19)
    assert.ok(duplicates.every((result) => result.status === "duplicate" && !result.conflict))

    const reservation = reserved[0]
    assert.equal(reservation?.status, "reserved")
    if (!reservation || reservation.status !== "reserved") throw new Error("Missing reservation")
    const completed = await store.complete(reservation.reservation, {
      state: "completed",
      outputHash: "c".repeat(64),
      durationMs: 25
    })
    assert.equal(completed.status, "completed")

    const status = await store.status(identity.connectionId, identity.requestId)
    assert.equal(status.status, "completed")
    assert.equal(status.outputHash, "c".repeat(64))
    const receiptPath = await onlyReceiptPath(root)
    const raw = await readFile(receiptPath, "utf8")
    assert.doesNotMatch(raw, /receipt-concurrency/)
    assert.doesNotMatch(raw, /FIRST|SECOND|PASSWORD/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("service restart classifies an unfinished receipt as outcome unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "abap-mcp-receipts-restart-"))
  try {
    const first = new InvocationReceiptStore(root, "first-instance")
    const reserved = await first.reserve({ ...identity, requestId: "receipt-restart" })
    assert.equal(reserved.status, "reserved")

    const restarted = new InvocationReceiptStore(root, "second-instance")
    const status = await restarted.status(identity.connectionId, "receipt-restart")
    assert.equal(status.status, "outcome_unknown")
    const duplicate = await restarted.reserve({ ...identity, requestId: "receipt-restart" })
    assert.equal(duplicate.status, "duplicate")
    if (duplicate.status !== "duplicate") throw new Error("Expected duplicate")
    assert.equal(duplicate.receipt.status, "outcome_unknown")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("corrupt receipt data fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "abap-mcp-receipts-corrupt-"))
  try {
    const store = new InvocationReceiptStore(root, "corrupt-instance")
    const requestId = "receipt-corrupt"
    assert.equal((await store.reserve({ ...identity, requestId })).status, "reserved")
    await writeFile(await onlyReceiptPath(root), "not-json", "utf8")
    await assert.rejects(
      store.status(identity.connectionId, requestId),
      /duplicate protection remains fail closed/
    )
    await assert.rejects(
      store.reserve({ ...identity, requestId }),
      /duplicate protection remains fail closed/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function onlyReceiptPath(root: string): Promise<string> {
  const receiptRoot = join(root, "rfc-receipts")
  const connectionDirectories = await readdir(receiptRoot)
  assert.equal(connectionDirectories.length, 1)
  const connectionRoot = join(receiptRoot, connectionDirectories[0] ?? "")
  const receipts = (await readdir(connectionRoot)).filter((name) => name.endsWith(".json"))
  assert.equal(receipts.length, 1)
  return join(connectionRoot, receipts[0] ?? "")
}
