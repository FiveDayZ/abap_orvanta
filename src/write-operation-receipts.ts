import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { z } from "zod"

const HASH_PATTERN = /^[a-f0-9]{64}$/
const SERVICE_INSTANCE_ID = randomUUID()

const sapPreChangeEvidenceSchema = z
  .object({
    observedAt: z.string().datetime(),
    target: z.string().min(1).max(500),
    exists: z.boolean().nullable(),
    active: z.boolean().nullable(),
    version: z.string().nullable(),
    fingerprint: z.string().regex(HASH_PATTERN).nullable(),
    packageName: z.string().nullable(),
    requestNumber: z.string().nullable(),
    taskNumber: z.string().nullable(),
    observationStatus: z.enum(["complete", "partial"]),
    sources: z.array(z.string().min(1).max(100)).max(20),
    warnings: z.array(z.string().min(1).max(1000)).max(20)
  })
  .strict()

const receiptSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    state: z.enum(["in_progress", "completed", "failed"]),
    connectionId: z.string().min(1),
    toolName: z.string().regex(/^[a-z][a-z0-9_]+$/),
    operationIdHash: z.string().regex(HASH_PATTERN),
    targetKeyHash: z.string().regex(HASH_PATTERN),
    inputHash: z.string().regex(HASH_PATTERN),
    preChangeSummary: z.string().min(1).max(2000),
    recoveryGuide: z.string().min(1).max(2000),
    sapPreChangeEvidence: sapPreChangeEvidenceSchema.optional(),
    sapInvocationStarted: z.boolean().optional(),
    resultHash: z.string().regex(HASH_PATTERN).optional(),
    errorHash: z.string().regex(HASH_PATTERN).optional(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    lockReleased: z.boolean().optional(),
    manualLockReleaseAt: z.string().datetime().optional(),
    manualLockReleaseReasonHash: z.string().regex(HASH_PATTERN).optional(),
    serviceInstanceId: z.string().min(1)
  })
  .strict()

const lockSchema = z
  .object({
    version: z.literal(1),
    operationIdHash: z.string().regex(HASH_PATTERN),
    serviceInstanceId: z.string().min(1),
    receiptPath: z.string().min(1),
    startedAt: z.string().datetime()
  })
  .strict()

export type WriteOperationReceipt = z.infer<typeof receiptSchema>
export type SapPreChangeEvidence = z.infer<typeof sapPreChangeEvidenceSchema>

export interface WriteOperationIdentity {
  connectionId: string
  toolName: string
  operationId: string
  targetKey: string
  inputHash: string
  preChangeSummary: string
  recoveryGuide: string
}

export interface WriteOperationReservation {
  receiptPath: string
  lockPath: string
  receipt: WriteOperationReceipt
}

export type WriteOperationReservationResult =
  | { status: "reserved"; reservation: WriteOperationReservation }
  | { status: "duplicate"; conflict: boolean; receipt: Record<string, unknown> }
  | { status: "protection_failed"; receipt: Record<string, unknown> }
  | { status: "target_busy"; receipt: Record<string, unknown> }

export class WriteOperationReceiptStore {
  private readonly receiptRoot: string
  private readonly lockRoot: string
  private readonly activeReceipts = new Set<string>()

  constructor(
    root: string,
    private readonly serviceInstanceId: string = SERVICE_INSTANCE_ID
  ) {
    this.receiptRoot = resolve(root, "write-receipts")
    this.lockRoot = resolve(root, "write-locks")
  }

  async reserve(identity: WriteOperationIdentity): Promise<WriteOperationReservationResult> {
    const operationIdHash = sha256(identity.operationId)
    const targetKeyHash = sha256(identity.targetKey)
    const receiptPath = this.receiptPath(identity.connectionId, operationIdHash)
    const lockPath = this.lockPath(identity.connectionId, targetKeyHash)
    await mkdir(dirname(receiptPath), { recursive: true, mode: 0o700 })
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
    const receipt: WriteOperationReceipt = {
      version: 2,
      state: "in_progress",
      connectionId: identity.connectionId,
      toolName: identity.toolName,
      operationIdHash,
      targetKeyHash,
      inputHash: identity.inputHash,
      preChangeSummary: identity.preChangeSummary,
      recoveryGuide: identity.recoveryGuide,
      sapInvocationStarted: false,
      startedAt: new Date().toISOString(),
      lockReleased: false,
      serviceInstanceId: this.serviceInstanceId
    }

    try {
      await createExclusiveJson(receiptPath, receipt)
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error
      const existing = await this.readReceiptRequired(receiptPath)
      return {
        status: "duplicate",
        conflict:
          existing.toolName !== identity.toolName ||
          existing.targetKeyHash !== targetKeyHash ||
          existing.inputHash !== identity.inputHash,
        receipt: this.toPublic(existing, receiptPath)
      }
    }

    try {
      await createExclusiveJson(lockPath, {
        version: 1,
        operationIdHash,
        serviceInstanceId: this.serviceInstanceId,
        receiptPath,
        startedAt: receipt.startedAt
      })
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        const failed = await this.finishReceipt(receiptPath, {
          ...receipt,
          state: "failed",
          errorHash: sha256(String(error)),
          finishedAt: new Date().toISOString(),
          durationMs: 0,
          lockReleased: true
        })
        return { status: "protection_failed", receipt: this.toPublic(failed, receiptPath) }
      }
      const blocking = await this.readLockRequired(lockPath)
      const failed = await this.finishReceipt(receiptPath, {
        ...receipt,
        state: "failed",
        errorHash: sha256("target concurrency conflict"),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        lockReleased: true
      })
      return {
        status: "target_busy",
        receipt: {
          ...this.toPublic(failed, receiptPath),
          blockingOperationIdHash: blocking.operationIdHash,
          blockingState:
            blocking.serviceInstanceId === this.serviceInstanceId ? "in_progress" : "interrupted",
          manualRecovery:
            "Do not retry automatically. Query the blocking operation and inspect the SAP target. After a human confirms the SAP state, use release_write_operation_lock with the original operationId and latest receiptHash."
        }
      }
    }

    this.activeReceipts.add(receiptPath)
    return { status: "reserved", reservation: { receiptPath, lockPath, receipt } }
  }

  async complete(
    reservation: WriteOperationReservation,
    result: string,
    durationMs: number
  ): Promise<Record<string, unknown>> {
    return this.finishOwned(reservation, {
      state: "completed",
      resultHash: sha256(result),
      finishedAt: new Date().toISOString(),
      durationMs
    })
  }

  async recordPreChangeEvidence(
    reservation: WriteOperationReservation,
    evidence: SapPreChangeEvidence
  ): Promise<void> {
    const current = await this.readOwnedInProgress(reservation)
    await this.finishReceipt(reservation.receiptPath, {
      ...current,
      sapPreChangeEvidence: sapPreChangeEvidenceSchema.parse(evidence)
    })
  }

  async markSapInvocationStarted(reservation: WriteOperationReservation): Promise<void> {
    const current = await this.readOwnedInProgress(reservation)
    await this.finishReceipt(reservation.receiptPath, {
      ...current,
      sapInvocationStarted: true
    })
  }

  async fail(
    reservation: WriteOperationReservation,
    error: unknown,
    durationMs: number
  ): Promise<Record<string, unknown>> {
    return this.finishOwned(reservation, {
      state: "failed",
      errorHash: sha256(String(error)),
      finishedAt: new Date().toISOString(),
      durationMs
    })
  }

  async status(connectionId: string, operationId: string): Promise<Record<string, unknown>> {
    const path = this.receiptPath(connectionId, sha256(operationId))
    const receipt = await this.readReceipt(path)
    if (!receipt) {
      return {
        status: "not_found",
        connectionId,
        operationIdHash: sha256(operationId),
        automaticRetry: false,
        automaticRollback: false
      }
    }
    return this.toPublic(receipt, path)
  }

  async listRecoveryOperations(
    connectionId: string,
    maxResults: number
  ): Promise<Record<string, unknown>> {
    const directory = join(this.receiptRoot, sha256(connectionId))
    let names: string[]
    try {
      names = (await readdir(directory)).filter((name) => name.endsWith(".json"))
    } catch (error) {
      if (isNodeError(error, "ENOENT")) names = []
      else throw error
    }
    const operations: Array<Record<string, unknown> & { startedAt: string }> = []
    for (const name of names) {
      const path = join(directory, name)
      const receipt = await this.readReceiptRequired(path)
      if (this.activeReceipts.has(path) || receipt.lockReleased === true) continue
      const status = this.toPublic(receipt, path)
      operations.push({
        ...status,
        recoveryState: status.status === "interrupted" ? "interrupted" : "stale_lock",
        startedAt: receipt.startedAt
      })
    }
    operations.sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    return {
      connectionId,
      count: Math.min(operations.length, maxResults),
      truncated: operations.length > maxResults,
      automaticCleanup: false,
      operations: operations.slice(0, maxResults)
    }
  }

  async releaseLocalLock(
    connectionId: string,
    operationId: string,
    expectedReceiptHash: string,
    reason: string
  ): Promise<Record<string, unknown>> {
    const normalizedReason = reason.trim()
    if (!normalizedReason) throw new Error("A human recovery reason is required")
    const path = this.receiptPath(connectionId, sha256(operationId))
    const receipt = await this.readReceiptRequired(path)
    if (this.activeReceipts.has(path)) {
      throw new Error("The write operation is still active in this service instance")
    }
    const publicReceipt = this.toPublic(receipt, path)
    if (publicReceipt.receiptHash !== expectedReceiptHash) {
      throw new Error("Receipt hash changed; refresh recovery status before releasing the lock")
    }
    if (receipt.lockReleased === true) throw new Error("The local write lock is already released")
    if (publicReceipt.status !== "interrupted" && receipt.state === "in_progress") {
      throw new Error("The write operation is still in progress")
    }
    const lockPath = this.lockPath(connectionId, receipt.targetKeyHash)
    const lock = await this.readLockRequired(lockPath)
    if (lock.operationIdHash !== receipt.operationIdHash || resolve(lock.receiptPath) !== path) {
      throw new Error("The local lock does not belong to the confirmed operation")
    }
    await unlink(lockPath)
    const released = await this.finishReceipt(path, {
      ...receipt,
      lockReleased: true,
      manualLockReleaseAt: new Date().toISOString(),
      manualLockReleaseReasonHash: sha256(normalizedReason)
    })
    return {
      ...this.toPublic(released, path),
      status: "local_lock_released",
      localLockReleased: true,
      sapLockChanged: false,
      recoveryActionSapInvocationStarted: false,
      automaticRetry: false,
      automaticRollback: false
    }
  }

  private async finishOwned(
    reservation: WriteOperationReservation,
    update: Pick<WriteOperationReceipt, "state" | "finishedAt" | "durationMs"> &
      Partial<Pick<WriteOperationReceipt, "resultHash" | "errorHash">>
  ): Promise<Record<string, unknown>> {
    const current = await this.readOwnedInProgress(reservation)
    try {
      const receipt = await this.finishReceipt(reservation.receiptPath, {
        ...current,
        ...update,
        lockReleased: false
      })
      try {
        await this.removeOwnedLock(reservation.lockPath, current.operationIdHash)
      } catch (error) {
        return {
          ...this.toPublic(receipt, reservation.receiptPath),
          localLockReleased: false,
          lockPath: reservation.lockPath,
          lockReleaseErrorHash: sha256(String(error))
        }
      }

      const released = { ...receipt, lockReleased: true }
      try {
        await this.finishReceipt(reservation.receiptPath, released)
        return this.toPublic(released, reservation.receiptPath)
      } catch (error) {
        return {
          ...this.toPublic(receipt, reservation.receiptPath),
          localLockReleased: true,
          receiptPersistenceWarningHash: sha256(String(error))
        }
      }
    } finally {
      this.activeReceipts.delete(reservation.receiptPath)
    }
  }

  private async readOwnedInProgress(
    reservation: WriteOperationReservation
  ): Promise<WriteOperationReceipt> {
    const current = await this.readReceiptRequired(reservation.receiptPath)
    if (
      current.state !== "in_progress" ||
      current.serviceInstanceId !== this.serviceInstanceId ||
      !this.activeReceipts.has(reservation.receiptPath)
    ) {
      throw new Error("Write receipt ownership changed; inspect the SAP target before retrying")
    }
    return current
  }

  private async finishReceipt(
    path: string,
    receipt: WriteOperationReceipt
  ): Promise<WriteOperationReceipt> {
    await replaceJson(path, receipt)
    return receipt
  }

  private async removeOwnedLock(path: string, operationIdHash: string): Promise<void> {
    const lock = await this.readLockRequired(path)
    if (
      lock.operationIdHash !== operationIdHash ||
      lock.serviceInstanceId !== this.serviceInstanceId
    ) {
      throw new Error("Write target lock ownership changed; inspect the SAP target manually")
    }
    await unlink(path)
  }

  private receiptPath(connectionId: string, operationIdHash: string): string {
    return join(this.receiptRoot, sha256(connectionId), `${operationIdHash}.json`)
  }

  private lockPath(connectionId: string, targetKeyHash: string): string {
    return join(this.lockRoot, sha256(connectionId), `${targetKeyHash}.json`)
  }

  private async readReceipt(path: string): Promise<WriteOperationReceipt | undefined> {
    try {
      return receiptSchema.parse(JSON.parse(await readFile(path, "utf8")))
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined
      throw new Error(`Write receipt is invalid; operation protection remains fail closed: ${path}`)
    }
  }

  private async readReceiptRequired(path: string): Promise<WriteOperationReceipt> {
    const receipt = await this.readReceipt(path)
    if (!receipt)
      throw new Error("Write receipt disappeared; operation protection remains fail closed")
    return receipt
  }

  private async readLockRequired(path: string): Promise<z.infer<typeof lockSchema>> {
    try {
      return lockSchema.parse(JSON.parse(await readFile(path, "utf8")))
    } catch {
      throw new Error(
        `Write target lock is invalid; concurrency protection remains fail closed: ${path}`
      )
    }
  }

  private toPublic(receipt: WriteOperationReceipt, path: string): Record<string, unknown> {
    const interrupted =
      receipt.state === "in_progress" &&
      (receipt.serviceInstanceId !== this.serviceInstanceId || !this.activeReceipts.has(path))
    const lockReleased = receipt.lockReleased === true
    const recoveryRequired = interrupted || !lockReleased
    const manualRecovery = recoveryRequired
      ? `${receipt.recoveryGuide} The local target lock is retained. After a human confirms the SAP state, use release_write_operation_lock with the original operationId and latest receiptHash.`
      : receipt.recoveryGuide
    return {
      status: interrupted ? "interrupted" : receipt.state,
      connectionId: receipt.connectionId,
      toolName: receipt.toolName,
      operationIdHash: receipt.operationIdHash,
      targetKeyHash: receipt.targetKeyHash,
      inputHash: receipt.inputHash,
      preChangeSummary: receipt.preChangeSummary,
      ...(receipt.sapPreChangeEvidence
        ? { sapPreChangeEvidence: receipt.sapPreChangeEvidence }
        : {}),
      sapInvocationStarted: receipt.sapInvocationStarted ?? null,
      ...(receipt.resultHash ? { resultHash: receipt.resultHash } : {}),
      ...(receipt.errorHash ? { errorHash: receipt.errorHash } : {}),
      startedAt: receipt.startedAt,
      ...(receipt.finishedAt ? { finishedAt: receipt.finishedAt } : {}),
      ...(receipt.durationMs !== undefined ? { durationMs: receipt.durationMs } : {}),
      receiptHash: sha256(JSON.stringify(receipt)),
      automaticRetry: false,
      automaticRollback: false,
      outcomeMayBeUnknown: interrupted || receipt.state === "failed",
      localLockReleased: lockReleased,
      ...(receipt.manualLockReleaseAt
        ? {
            manualLockReleaseAt: receipt.manualLockReleaseAt,
            manualLockReleaseReasonHash: receipt.manualLockReleaseReasonHash
          }
        : {}),
      manualRecovery
    }
  }
}

export function hashWriteInput(value: unknown): string {
  return sha256(JSON.stringify(sortValue(value)))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "operationId")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortValue(entry)])
    )
  }
  return value
}

async function createExclusiveJson(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "wx", 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function replaceJson(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    await createExclusiveJson(temporary, value)
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code
}
