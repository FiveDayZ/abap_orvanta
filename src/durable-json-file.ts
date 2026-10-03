import { randomUUID } from "node:crypto"
import { open, rename, unlink } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

/**
 * Durable JSON files that several processes read while one of them rewrites them.
 *
 * Windows refuses to replace or delete a file while another handle holds it open for reading
 * (`EPERM: operation not permitted, rename/unlink ...`). Receipts are read by sibling requests - the
 * duplicate check of a second call reads the very file its owner is updating - so an owner's own
 * update failed inside its pre-change observation: on 2026-10-03 twelve simultaneous duplicate
 * requests produced eleven `duplicate_blocked` results and one owner that never dispatched, and on
 * 2026-09-29 the same test lost its single dispatch. Measured on this platform: 300 of 300 replaces
 * failed while one reader held the target open. Retrying keeps the atomic replace; writing in place
 * would let a reader observe a half-written receipt, which is what the temporary file prevents.
 *
 * Both receipt stores write through this module, so the retry policy cannot drift apart between
 * them. A persistent sharing violation still surfaces as an error after the bounded retries: the
 * caller must fail closed rather than continue without its receipt.
 */
const SHARING_RETRY_ATTEMPTS = 8
const SHARING_RETRY_MS = 5

function isTransientSharingError(error: unknown): boolean {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
  return code === "EPERM" || code === "EACCES" || code === "EBUSY"
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Create a new file exclusively; an existing file is an error, never an overwrite. */
export async function createExclusiveJsonFile(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "wx", 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Replace a file atomically, retrying the transient Windows sharing violation. */
export async function replaceJsonFile(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    await createExclusiveJsonFile(temporary, value)
    for (let attempt = 1; ; attempt += 1) {
      try {
        await rename(temporary, path)
        return
      } catch (error) {
        if (attempt >= SHARING_RETRY_ATTEMPTS || !isTransientSharingError(error)) throw error
        await delay(SHARING_RETRY_MS * attempt)
      }
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

/** The same sharing window applies to deleting a lock a competing request is reading. */
export async function unlinkFileWithRetry(path: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await unlink(path)
      return
    } catch (error) {
      if (attempt >= SHARING_RETRY_ATTEMPTS || !isTransientSharingError(error)) throw error
      await delay(SHARING_RETRY_MS * attempt)
    }
  }
}
