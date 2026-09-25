import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { z } from "zod"

const HASH_PATTERN = /^[a-f0-9]{64}$/
const SERVICE_INSTANCE_ID = randomUUID()
const activeReceipts = new Map<string, string>()

const receiptSchema = z
  .object({
    version: z.literal(1),
    state: z.enum(["in_progress", "completed", "declared_fault", "outcome_unknown"]),
    connectionId: z.string().min(1),
    functionName: z.string().regex(/^[ZY][A-Z0-9_]{0,29}$/),
    requestIdHash: z.string().regex(HASH_PATTERN),
    // Interface-only fingerprint of the called function module, under the name and meaning
    // `read_function_module_interface` gives it. Receipts written before the fingerprints were
    // split stored the whole-definition hash in this field, which is what `definitionFingerprint`
    // distinguishes: its absence marks such a legacy receipt.
    interfaceFingerprint: z.string().regex(HASH_PATTERN),
    // Whole-definition fingerprint (interface plus implementation). Absent in receipts written
    // before the split, whose `interfaceFingerprint` held exactly this value.
    definitionFingerprint: z.string().regex(HASH_PATTERN).optional(),
    inputHash: z.string().regex(HASH_PATTERN),
    outputHash: z.string().regex(HASH_PATTERN).optional(),
    faultName: z.string().max(30).optional(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    serviceInstanceId: z.string().min(1)
  })
  .strict()

export type InvocationReceipt = z.infer<typeof receiptSchema>
export type InvocationPublicState = InvocationReceipt["state"] | "not_found"

export interface InvocationIdentity {
  connectionId: string
  functionName: string
  requestId: string
  /** Interface-only fingerprint, as `read_function_module_interface` returns it. */
  interfaceFingerprint: string
  /** Whole-definition fingerprint, as `read_function_module_interface` returns it. */
  definitionFingerprint: string
  inputHash: string
}

export interface InvocationReservation {
  path: string
  receipt: InvocationReceipt
}

export type InvocationReservationResult =
  | { status: "reserved"; reservation: InvocationReservation }
  | {
      status: "duplicate"
      conflict: boolean
      receipt: Record<string, unknown>
    }

export function defaultInvocationStateRoot(): string {
  const configured = process.env.ABAP_MCP_STATE_DIR?.trim()
  if (configured) return resolve(configured)
  const localAppData = process.env.LOCALAPPDATA?.trim()
  return localAppData
    ? join(localAppData, "ABAP MCP Standalone", "state")
    : join(homedir(), ".abap-mcp-standalone", "state")
}

export class InvocationReceiptStore {
  private readonly root: string

  constructor(
    root = defaultInvocationStateRoot(),
    private readonly serviceInstanceId: string = SERVICE_INSTANCE_ID
  ) {
    this.root = resolve(root, "rfc-receipts")
  }

  async reserve(identity: InvocationIdentity): Promise<InvocationReservationResult> {
    const path = this.receiptPath(identity.connectionId, identity.requestId)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const receipt: InvocationReceipt = {
      version: 1,
      state: "in_progress",
      connectionId: identity.connectionId,
      functionName: identity.functionName,
      requestIdHash: sha256(identity.requestId),
      interfaceFingerprint: identity.interfaceFingerprint,
      definitionFingerprint: identity.definitionFingerprint,
      inputHash: identity.inputHash,
      startedAt: new Date().toISOString(),
      serviceInstanceId: this.serviceInstanceId
    }

    try {
      await createExclusiveReceipt(path, receipt)
      activeReceipts.set(path, this.serviceInstanceId)
      return { status: "reserved", reservation: { path, receipt } }
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error
      const existing = await this.readRequired(path)
      const conflict =
        existing.functionName !== identity.functionName ||
        !sameInterfaceFingerprint(existing, identity) ||
        existing.inputHash !== identity.inputHash
      return {
        status: "duplicate",
        conflict,
        receipt: this.toPublic(existing, path)
      }
    }
  }

  async complete(
    reservation: InvocationReservation,
    result: {
      state: "completed" | "declared_fault"
      outputHash: string
      durationMs: number
      faultName?: string | undefined
    }
  ): Promise<Record<string, unknown>> {
    const current = await this.readRequired(reservation.path)
    if (
      current.state !== "in_progress" ||
      current.serviceInstanceId !== this.serviceInstanceId ||
      activeReceipts.get(reservation.path) !== this.serviceInstanceId
    ) {
      throw new Error("Invocation receipt ownership changed; SAP outcome must be verified manually")
    }
    const receipt: InvocationReceipt = {
      ...current,
      state: result.state,
      outputHash: result.outputHash,
      ...(result.faultName ? { faultName: result.faultName } : {}),
      finishedAt: new Date().toISOString(),
      durationMs: result.durationMs
    }
    try {
      await replaceReceipt(reservation.path, receipt)
      return this.toPublic(receipt, reservation.path)
    } finally {
      activeReceipts.delete(reservation.path)
    }
  }

  async markOutcomeUnknown(reservation: InvocationReservation, durationMs: number): Promise<void> {
    const current = await this.readRequired(reservation.path)
    const receipt: InvocationReceipt = {
      ...current,
      state: "outcome_unknown",
      finishedAt: new Date().toISOString(),
      durationMs
    }
    try {
      await replaceReceipt(reservation.path, receipt)
    } finally {
      activeReceipts.delete(reservation.path)
    }
  }

  async status(connectionId: string, requestId: string): Promise<Record<string, unknown>> {
    const path = this.receiptPath(connectionId, requestId)
    const receipt = await this.read(path)
    if (!receipt) {
      return {
        status: "not_found",
        connectionId,
        requestIdHash: sha256(requestId),
        automaticRetry: false
      }
    }
    return this.toPublic(receipt, path)
  }

  private receiptPath(connectionId: string, requestId: string): string {
    return join(this.root, sha256(connectionId), `${sha256(requestId)}.json`)
  }

  private async read(path: string): Promise<InvocationReceipt | undefined> {
    try {
      return receiptSchema.parse(JSON.parse(await readFile(path, "utf8")))
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined
      throw new Error(
        `Invocation receipt is invalid; duplicate protection remains fail closed: ${path}`
      )
    }
  }

  private async readRequired(path: string): Promise<InvocationReceipt> {
    const receipt = await this.read(path)
    if (!receipt) {
      throw new Error("Invocation receipt disappeared; duplicate protection remains fail closed")
    }
    return receipt
  }

  private toPublic(receipt: InvocationReceipt, path: string): Record<string, unknown> {
    const state: InvocationPublicState =
      receipt.state === "in_progress" &&
      (receipt.serviceInstanceId !== this.serviceInstanceId ||
        activeReceipts.get(path) !== this.serviceInstanceId)
        ? "outcome_unknown"
        : receipt.state
    return {
      status: state,
      connectionId: receipt.connectionId,
      functionName: receipt.functionName,
      requestIdHash: receipt.requestIdHash,
      interfaceFingerprint: receipt.interfaceFingerprint,
      ...(receipt.definitionFingerprint
        ? { definitionFingerprint: receipt.definitionFingerprint }
        : {}),
      inputHash: receipt.inputHash,
      ...(receipt.outputHash ? { outputHash: receipt.outputHash } : {}),
      ...(receipt.faultName ? { faultName: receipt.faultName } : {}),
      startedAt: receipt.startedAt,
      ...(receipt.finishedAt ? { finishedAt: receipt.finishedAt } : {}),
      ...(receipt.durationMs !== undefined ? { durationMs: receipt.durationMs } : {}),
      automaticRetry: false
    }
  }
}

/**
 * The duplicate guard compares the identity the payload was built from. Receipts written before the
 * fingerprints were split stored the whole-definition hash under `interfaceFingerprint`, so such a
 * legacy receipt is compared against the definition fingerprint; everything written since compares
 * interface fingerprints, which is what a call payload actually depends on. A body-only change
 * therefore no longer turns an exact retry into a conflict.
 */
function sameInterfaceFingerprint(
  existing: InvocationReceipt,
  identity: InvocationIdentity
): boolean {
  return existing.definitionFingerprint
    ? existing.interfaceFingerprint === identity.interfaceFingerprint
    : existing.interfaceFingerprint === identity.definitionFingerprint
}

async function createExclusiveReceipt(path: string, receipt: InvocationReceipt): Promise<void> {
  const handle = await open(path, "wx", 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(receipt)}\n`, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function replaceReceipt(path: string, receipt: InvocationReceipt): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    await createExclusiveReceipt(temporary, receipt)
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
