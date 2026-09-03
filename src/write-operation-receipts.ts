import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { z } from "zod"

const HASH_PATTERN = /^[a-f0-9]{64}$/
const SERVICE_INSTANCE_ID = randomUUID()

const receiptSchema = z
  .object({
    version: z.literal(1),
    state: z.enum(["in_progress", "completed", "failed"]),
    connectionId: z.string().min(1),
    toolName: z.string().regex(/^[a-z][a-z0-9_]+$/),
    operationIdHash: z.string().regex(HASH_PATTERN),
    targetKeyHash: z.string().regex(HASH_PATTERN),
    inputHash: z.string().regex(HASH_PATTERN),
    preChangeSummary: z.string().min(1).max(2000),
    recoveryGuide: z.string().min(1).max(2000),
    resultHash: z.string().regex(HASH_PATTERN).optional(),
    errorHash: z.string().regex(HASH_PATTERN).optional(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    lockReleased: z.boolean().optional(),
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
      version: 1,
      state: "in_progress",
      connectionId: identity.connectionId,
      toolName: identity.toolName,
      operationIdHash,
      targetKeyHash,
      inputHash: identity.inputHash,
      preChangeSummary: identity.preChangeSummary,
      recoveryGuide: identity.recoveryGuide,
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
          lockPath,
          manualRecovery:
            "Do not retry automatically. Query the blocking operation, inspect the SAP target, and remove the reported lock file only after a human confirms the SAP state."
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

  private async finishOwned(
    reservation: WriteOperationReservation,
    update: Pick<WriteOperationReceipt, "state" | "finishedAt" | "durationMs"> &
      Partial<Pick<WriteOperationReceipt, "resultHash" | "errorHash">>
  ): Promise<Record<string, unknown>> {
    const current = await this.readReceiptRequired(reservation.receiptPath)
    if (
      current.state !== "in_progress" ||
      current.serviceInstanceId !== this.serviceInstanceId ||
      !this.activeReceipts.has(reservation.receiptPath)
    ) {
      throw new Error("Write receipt ownership changed; inspect the SAP target before retrying")
    }
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
      ? `${receipt.recoveryGuide} Local operation lock: ${this.lockPath(
          receipt.connectionId,
          receipt.targetKeyHash
        )}. Remove it only after a human confirms the SAP state.`
      : receipt.recoveryGuide
    return {
      status: interrupted ? "interrupted" : receipt.state,
      connectionId: receipt.connectionId,
      toolName: receipt.toolName,
      operationIdHash: receipt.operationIdHash,
      targetKeyHash: receipt.targetKeyHash,
      inputHash: receipt.inputHash,
      preChangeSummary: receipt.preChangeSummary,
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
