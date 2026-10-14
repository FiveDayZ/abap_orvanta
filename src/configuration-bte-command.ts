import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { z } from "zod"
import { createExclusiveJsonFile } from "./durable-json-file.js"
import { WriteOperationReceiptStore, hashWriteInput } from "./write-operation-receipts.js"
import {
  configurationBteProtocolSourceVersion,
  inspectConfigurationBteProtocol
} from "./configuration-bte-protocol.js"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const operation = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/)
const active = z.enum(["", "X"])
const scope = z.object({
  connectionId: z.literal("w200"),
  system: z.literal("GR2"),
  client: z.literal("200"),
  username: z.literal("WYS"),
  product: z.string().regex(/^[ZY][A-Z0-9_]{0,7}$/),
  request: z.literal("GR2K923429"),
  task: z.literal("GR2K923430")
})
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
function fail(code: string): never {
  throw Error(`BTE_COMMAND_${code}`)
}

// The opaque frame is an SAP EXPORT buffer. Validate its bytes, never trim or reinterpret them.
export const configurationBteCommandStateSchema = scope
  .extend({
    active,
    frame: z
      .string()
      .min(4)
      .max(699052)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    version: digest,
    protectedVersion: digest,
    ctsVersion: digest,
    routeVersion: digest,
    cacheVersion: digest
  })
  .strict()
  .superRefine((value, ctx) => {
    const bytes = Buffer.from(value.frame, "base64")
    if (
      bytes.length > 524288 ||
      bytes.toString("base64") !== value.frame ||
      sha(bytes) !== value.version
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid native frame" })
  })
type State = z.output<typeof configurationBteCommandStateSchema>

const pinsSchema = z.record(digest).refine((pins) => {
  const names = Object.keys(pins)
  return names.length >= 4 && names.length <= 128 && names.every((n) => /^[A-Z0-9_]{1,80}$/.test(n))
})
const intentSchema = z
  .object({
    version: z.literal(1),
    command: z.enum(["SAVE", "RECOVER"]),
    operationId: operation,
    requestId: digest,
    before: configurationBteCommandStateSchema,
    desiredActive: active,
    pins: pinsSchema,
    approvalHash: digest,
    recoveryFrom: operation.nullable(),
    preparedAt: z.string().datetime()
  })
  .strict()
type Intent = z.output<typeof intentSchema>
const savedSchema = z
  .object({
    intentHash: digest,
    after: configurationBteCommandStateSchema,
    committedAt: z.string().datetime()
  })
  .strict()
const inputSchema = z
  .object({
    operationId: operation,
    expectedVersion: digest,
    desiredActive: active,
    product: scope.shape.product,
    acknowledgeConfigurationWrite: z.literal(true),
    approvalHash: digest,
    recoveryFrom: operation.optional()
  })
  .strict()

/**
 * A trusted host supplies these capabilities only after version-bound SAP acceptance.
 * They are absent from public input. r79's lock probe cannot satisfy any of these proofs.
 */
export interface ConfigurationBteCommandPort {
  pins(): Promise<Record<string, string>>
  state(product: string): Promise<unknown>
  invoke(intent: Intent): Promise<unknown>
  readonly acceptance?: {
    pins: Record<string, string>
    atomicSave: boolean
    fullCtsReadback: boolean
    frameCleanup: boolean
    cacheUpdate: boolean
    recovery: boolean
    nativeMessageProtocol: boolean
    approvedIntentHashes: readonly string[]
  }
}
const replySchema = z
  .object({
    code: z.literal("COMMAND_COMMITTED"),
    operationId: operation,
    requestId: digest,
    command: z.enum(["SAVE", "RECOVER"]),
    committed: z.literal(true),
    protectedState: z.literal("preserved"),
    cts: z.literal("recorded"),
    locks: z.literal("released"),
    session: z.literal("clean"),
    cache: z.literal("verified"),
    protocol: z.unknown(),
    after: configurationBteCommandStateSchema
  })
  .strict()
const same = (left: unknown, right: unknown) => hashWriteInput(left) === hashWriteInput(right)

/**
 * Internal coordinator; no public tool is registered. Durable intent precedes the sole write.
 * Unknown outcomes retain the shared BTE target guard, even after restart or a new operation ID.
 * The target is the fixed request/task, rather than one product: all commands share native state.
 */
export class ConfigurationBteCommandCoordinator {
  private readonly directory: string
  private readonly receipts: WriteOperationReceiptStore
  private pending: Promise<void> = Promise.resolve()

  constructor(
    root: string,
    private readonly port: ConfigurationBteCommandPort
  ) {
    this.directory = resolve(root, "bte-command-evidence")
    this.receipts = new WriteOperationReceiptStore(root)
  }

  private path(id: string, kind: "intent" | "saved" | "protocol") {
    return resolve(this.directory, `${sha(id)}-${kind}.json`)
  }

  private async intent(id: string) {
    const value = intentSchema.parse(JSON.parse(await readFile(this.path(id, "intent"), "utf8")))
    if (
      value.operationId !== id ||
      value.requestId !== sha(id) ||
      value.before.active === value.desiredActive ||
      (value.command === "SAVE") !== (value.recoveryFrom === null)
    )
      fail("INTENT_ID_MISMATCH")
    return value
  }

  private async saved(id: string, intent: Intent) {
    const value = savedSchema.parse(JSON.parse(await readFile(this.path(id, "saved"), "utf8")))
    if (
      value.intentHash !== hashWriteInput(intent) ||
      value.after.product !== intent.before.product ||
      value.after.active !== intent.desiredActive ||
      value.after.protectedVersion !== intent.before.protectedVersion ||
      value.after.routeVersion !== intent.before.routeVersion
    )
      fail("SAVED_BINDING_MISMATCH")
    return value
  }

  /** Preparation is read-only in SAP; the private durable frame contains full before-state. */
  async prepare(raw: unknown) {
    const input = inputSchema.parse(raw)
    const pins = pinsSchema.parse(await this.port.pins())
    const before = configurationBteCommandStateSchema.parse(await this.port.state(input.product))
    if (before.product !== input.product || before.version !== input.expectedVersion)
      fail("STATE_CHANGED")
    if (before.active === input.desiredActive) fail("NO_CHANGES")
    if (input.recoveryFrom) {
      const original = await this.intent(input.recoveryFrom)
      const saved = await this.saved(input.recoveryFrom, original)
      const receipt = await this.receipts.status("w200", input.recoveryFrom)
      if (
        original.command !== "SAVE" ||
        original.before.product !== input.product ||
        original.before.active !== input.desiredActive ||
        receipt.status !== "completed" ||
        receipt.inputHash !== hashWriteInput(original) ||
        !same(original.pins, pins) ||
        !same(saved.after, before)
      )
        fail("RECOVERY_BINDING_MISMATCH")
    }
    if (!same(pins, pinsSchema.parse(await this.port.pins()))) fail("API_CHANGED")
    const intent: Intent = {
      version: 1,
      command: input.recoveryFrom ? "RECOVER" : "SAVE",
      operationId: input.operationId,
      requestId: sha(input.operationId),
      before,
      desiredActive: input.desiredActive,
      pins,
      approvalHash: input.approvalHash,
      recoveryFrom: input.recoveryFrom ?? null,
      preparedAt: new Date().toISOString()
    }
    // One operation ID permanently identifies one review; a second preparation cannot replace it.
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await createExclusiveJsonFile(this.path(input.operationId, "intent"), intent)
    return {
      status: "prepared" as const,
      operationId: intent.operationId,
      intentHash: hashWriteInput(intent),
      writeAvailable: false,
      executable: false,
      automaticRetry: false
    }
  }

  /** A caller's approval does not replace the trusted, version-bound native acceptance gate. */
  async execute(operationId: string, expectedIntentHash: string) {
    // One local native frame/request owner at a time. Durable guards still protect other processes.
    const previous = this.pending
    let release!: () => void
    this.pending = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await this.executeOne(operationId, expectedIntentHash)
    } finally {
      release()
    }
  }

  private async executeOne(operationId: string, expectedIntentHash: string) {
    operation.parse(operationId)
    digest.parse(expectedIntentHash)
    const intent = await this.intent(operationId)
    if (hashWriteInput(intent) !== expectedIntentHash) fail("INTENT_CHANGED")
    const accepted = this.port.acceptance
    if (
      !accepted ||
      !accepted.atomicSave ||
      !accepted.fullCtsReadback ||
      !accepted.frameCleanup ||
      !accepted.cacheUpdate ||
      !accepted.nativeMessageProtocol ||
      intent.pins.BTE_PROTOCOL !== configurationBteProtocolSourceVersion ||
      (intent.command === "RECOVER" && !accepted.recovery) ||
      !same(accepted.pins, intent.pins)
    )
      fail("NATIVE_ACCEPTANCE_REQUIRED")
    if (!accepted.approvedIntentHashes.includes(expectedIntentHash))
      fail("BUSINESS_APPROVAL_REQUIRED")
    const reservation = await this.receipts.reserve({
      connectionId: "w200",
      toolName: "execute_configuration_bte_command",
      operationId,
      targetKey: "BTE:GR2:200:GR2K923429:GR2K923430",
      inputHash: expectedIntentHash,
      preChangeSummary: `BTE ${intent.before.product}; native frame ${intent.before.version}`,
      recoveryGuide:
        "Read the original operation and SAP state. Never replay an uncertain command.",
      protectUnknownTarget: true
    })
    if (reservation.status !== "reserved") return reservation
    const start = Date.now()
    let invoked = false
    let protocol: ReturnType<typeof inspectConfigurationBteProtocol> | undefined
    try {
      const freshPins = pinsSchema.parse(await this.port.pins())
      if (!same(intent.pins, freshPins)) fail("API_CHANGED")
      const before = configurationBteCommandStateSchema.parse(
        await this.port.state(intent.before.product)
      )
      if (!same(before, intent.before)) fail("STATE_CHANGED")
      if (intent.command === "RECOVER") {
        const original = await this.intent(intent.recoveryFrom!)
        const saved = await this.saved(original.operationId, original)
        if (
          original.command !== "SAVE" ||
          original.before.product !== before.product ||
          original.before.active !== intent.desiredActive ||
          !same(original.pins, intent.pins) ||
          !same(saved.after, before) ||
          !(
            (await this.receipts.status("w200", original.operationId)).status === "completed" &&
            (await this.receipts.status("w200", original.operationId)).inputHash ===
              hashWriteInput(original)
          )
        )
          fail("RECOVERY_BINDING_MISMATCH")
      }
      if (!same(intent.pins, pinsSchema.parse(await this.port.pins()))) fail("API_CHANGED")
      await this.receipts.markSapInvocationStarted(reservation.reservation)
      invoked = true
      const rawReply = await this.port.invoke(intent)
      protocol = inspectConfigurationBteProtocol(
        z.object({ protocol: z.unknown() }).parse(rawReply).protocol,
        {
          operationId,
          requestId: intent.requestId,
          command: intent.command
        }
      )
      // Preserve the complete message history before any later read or rejection can fail.
      await createExclusiveJsonFile(this.path(operationId, "protocol"), {
        intentHash: expectedIntentHash,
        ...protocol
      })
      if (protocol.status !== "complete_without_errors") fail("PROTOCOL_UNVERIFIED")
      const reply = replySchema.parse(rawReply)
      const after = reply.after
      if (
        reply.operationId !== operationId ||
        reply.requestId !== intent.requestId ||
        reply.command !== intent.command ||
        after.product !== before.product ||
        after.active !== intent.desiredActive ||
        after.version === before.version ||
        after.protectedVersion !== before.protectedVersion ||
        after.routeVersion !== before.routeVersion
      )
        throw Error("BTE_COMMAND_REPLY_UNVERIFIED")
      // Persist the returned post-state before any fallible final read, preserving unknown recovery.
      await createExclusiveJsonFile(this.path(operationId, "saved"), {
        intentHash: expectedIntentHash,
        after,
        committedAt: new Date().toISOString()
      })
      if (
        !same(
          after,
          configurationBteCommandStateSchema.parse(await this.port.state(before.product))
        ) ||
        !same(intent.pins, pinsSchema.parse(await this.port.pins()))
      )
        throw Error("BTE_COMMAND_POST_READ_UNVERIFIED")
      const receipt = await this.receipts.complete(
        reservation.reservation,
        hashWriteInput(reply),
        Date.now() - start
      )
      return {
        status: "committed" as const,
        operationId,
        command: intent.command,
        afterVersion: after.version,
        receipt,
        ctsCleanupPerformed: false,
        transportReleased: false,
        automaticRetry: false
      }
    } catch (error) {
      const receipt = await this.receipts.fail(
        reservation.reservation,
        invoked ? Error("BTE command outcome unknown; reconcile without replay") : error,
        Date.now() - start
      )
      return {
        status: invoked ? ("unknown" as const) : ("rejected" as const),
        operationId,
        receipt,
        ...(protocol
          ? {
              protocolStatus: protocol.status,
              protocolBlockers: protocol.blockers,
              firstError: protocol.firstError
            }
          : {}),
        automaticRetry: false
      }
    }
  }

  /** Observation never rewrites historical outcome, releases protection, or invokes a command. */
  async reconcile(operationId: string) {
    operation.parse(operationId)
    const intent = await this.intent(operationId)
    const pins = pinsSchema.parse(await this.port.pins())
    if (!same(intent.pins, pins)) fail("API_CHANGED")
    const current = configurationBteCommandStateSchema.parse(
      await this.port.state(intent.before.product)
    )
    if (current.product !== intent.before.product) fail("STATE_SCOPE_MISMATCH")
    let saved: z.output<typeof savedSchema> | undefined
    try {
      saved = await this.saved(operationId, intent)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    const classification = same(current, intent.before)
      ? "observed_before"
      : saved && same(current, saved.after)
        ? "observed_after"
        : "drift_or_unattributed"
    if (!same(intent.pins, pinsSchema.parse(await this.port.pins()))) fail("API_CHANGED")
    const observation = {
      version: 1,
      operationId,
      intentHash: hashWriteInput(intent),
      currentVersion: current.version,
      classification,
      observedAt: new Date().toISOString(),
      receipt: await this.receipts.status("w200", operationId),
      historicalOutcomeChanged: false,
      protectionReleased: false,
      automaticRetry: false
    }
    await createExclusiveJsonFile(
      resolve(this.directory, `${sha(operationId)}-observation-${randomUUID()}.json`),
      observation
    )
    return observation
  }

  async status(operationId: string) {
    operation.parse(operationId)
    return this.receipts.status("w200", operationId)
  }
}
