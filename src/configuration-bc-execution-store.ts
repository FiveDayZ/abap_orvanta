import { mkdir, link, readFile, unlink, stat } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { resolve, join } from "node:path"
import { z } from "zod"
import { createExclusiveJsonFile } from "./durable-json-file.js"
import { hashWriteInput } from "./write-operation-receipts.js"

const hex = z.string().regex(/^[a-f0-9]{64}$/)
const identity = z
  .object({
    connectionId: z.literal("w200"),
    system: z.literal("GR2"),
    client: z.literal("200"),
    user: z.string().regex(/^[A-Z0-9_]{1,12}$/),
    operationHash: hex,
    beforeStateReference: hex,
    effectsReference: hex,
    command: z.enum(["apply", "recover"]),
    inputHash: hex
  })
  .strict()
export type ConfigurationBcExecutionIdentity = z.infer<typeof identity>
const envelope = z
  .object({ format: z.literal(1), identity, value: z.record(z.unknown()), hash: hex })
  .strict()

/** Immutable intent and native result. Raw SAP buffers never enter the public request/response. */
export class ConfigurationBcExecutionStore {
  private readonly roots: string[]
  private readonly directory: string
  constructor(root: string | readonly string[]) {
    this.roots = [
      ...new Set(
        (typeof root === "string" ? [root] : root).map((item) =>
          resolve(item, "configuration-bc-executions")
        )
      )
    ]
    // The first root is the canonical home for new records; the remaining ones are searched only,
    // so a record published before the service was restarted from another working directory still
    // resolves instead of turning into a not-found refusal (2026-10-14, same rule as the ADT
    // lock/save state in `adt-backend.ts`).
    this.directory = this.roots[0]!
  }
  private path(operationHash: string, kind: "intent" | "result") {
    hex.parse(operationHash)
    return join(this.directory, `${operationHash}.${kind}.json`)
  }
  private missing(kind: "intent" | "result", operationHash: string) {
    return Error(
      `CONFIGURATION_BC_EXECUTION_NOT_FOUND: ${operationHash}.${kind} is not under ${this.roots.join(" or ")}`
    )
  }
  /**
   * A record is addressed by its content hash, so an earlier reference must still be found after a
   * restart from another working directory: search every root in order and only then refuse.
   */
  private async load(
    operationHash: string,
    kind: "intent" | "result"
  ): Promise<z.infer<typeof envelope>> {
    hex.parse(operationHash)
    for (const directory of this.roots) {
      let stored: z.infer<typeof envelope>
      try {
        const path = join(directory, `${operationHash}.${kind}.json`)
        if ((await stat(path)).size > 3000000) throw Error("CONFIGURATION_BC_EXECUTION_LIMIT")
        stored = envelope.parse(JSON.parse(await readFile(path, "utf8")))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
        // A stored record that will not parse is corrupt, not a caller mistake: name it like the
        // sibling evidence stores instead of leaking a JSON or schema error.
        if (error instanceof SyntaxError || error instanceof z.ZodError)
          throw Error("CONFIGURATION_BC_EXECUTION_CORRUPT")
        throw error
      }
      return stored
    }
    throw this.missing(kind, operationHash)
  }
  async publish(
    binding: ConfigurationBcExecutionIdentity,
    kind: "intent" | "result",
    value: Record<string, unknown>
  ) {
    const checked = identity.parse(binding)
    const payload = { format: 1 as const, identity: checked, value: structuredClone(value) }
    const data = { ...payload, hash: hashWriteInput(payload) }
    if (Buffer.byteLength(JSON.stringify(data)) > 3000000)
      throw Error("CONFIGURATION_BC_EXECUTION_LIMIT")
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const destination = this.path(checked.operationHash, kind)
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      await createExclusiveJsonFile(temporary, data)
      try {
        await link(temporary, destination)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        const prior = await this.read(checked, kind)
        if (hashWriteInput(prior) !== hashWriteInput(value))
          throw Error("CONFIGURATION_BC_EXECUTION_CONFLICT")
      }
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
      })
    }
    return data.hash
  }
  async read(
    binding: ConfigurationBcExecutionIdentity,
    kind: "intent" | "result"
  ): Promise<Record<string, unknown>> {
    const checked = identity.parse(binding)
    const stored = await this.load(checked.operationHash, kind)
    const { hash, ...payload } = stored
    if (
      hashWriteInput(payload) !== hash ||
      hashWriteInput(stored.identity) !== hashWriteInput(checked)
    )
      throw Error("CONFIGURATION_BC_EXECUTION_BINDING_INVALID")
    return structuredClone(stored.value)
  }
  async readAuthenticated(operationHash: string, user: string, kind: "intent" | "result") {
    const stored = await this.load(operationHash, kind)
    const { hash, ...payload } = stored
    if (
      hashWriteInput(payload) !== hash ||
      stored.identity.operationHash !== operationHash ||
      stored.identity.user !== user
    )
      throw Error("CONFIGURATION_BC_EXECUTION_BINDING_INVALID")
    return structuredClone(stored)
  }
}

/**
 * "No record" is a question, not a failure: reconcile asks whether a prior native result exists, so
 * the named refusal is decoded in one place instead of by reading a filesystem error code there.
 */
export function isConfigurationBcExecutionNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("CONFIGURATION_BC_EXECUTION_NOT_FOUND:")
}
