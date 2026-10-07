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
  private readonly directory: string
  constructor(root: string) {
    this.directory = resolve(root, "configuration-bc-executions")
  }
  private path(operationHash: string, kind: "intent" | "result") {
    hex.parse(operationHash)
    return join(this.directory, `${operationHash}.${kind}.json`)
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
    const checked = identity.parse(binding),
      path = this.path(checked.operationHash, kind)
    if ((await stat(path)).size > 3000000) throw Error("CONFIGURATION_BC_EXECUTION_LIMIT")
    const stored = envelope.parse(JSON.parse(await readFile(path, "utf8")))
    const { hash, ...payload } = stored
    if (
      hashWriteInput(payload) !== hash ||
      hashWriteInput(stored.identity) !== hashWriteInput(checked)
    )
      throw Error("CONFIGURATION_BC_EXECUTION_BINDING_INVALID")
    return structuredClone(stored.value)
  }
  async readAuthenticated(operationHash: string, user: string, kind: "intent" | "result") {
    const path = this.path(operationHash, kind)
    if ((await stat(path)).size > 3000000) throw Error("CONFIGURATION_BC_EXECUTION_LIMIT")
    const stored = envelope.parse(JSON.parse(await readFile(path, "utf8")))
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
