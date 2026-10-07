import { mkdir, readFile, link, unlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"
import { createHash, randomUUID } from "node:crypto"
import { createExclusiveJsonFile } from "./durable-json-file.js"
import { hashWriteInput } from "./write-operation-receipts.js"
import {
  assertConfigurationBcEffectsEvidence,
  type ConfigurationBcEffectsEvidence
} from "./configuration-bc-effects.js"
import {
  configurationBcStateBodyFingerprint,
  type readConfigurationBcBeforeState
} from "./configuration-bc-state.js"
import {
  configurationBcStateTables,
  configurationBcStateLayouts,
  configurationBcStateLayoutFingerprint
} from "./configuration-bc-state-api.js"

type State = Awaited<ReturnType<typeof readConfigurationBcBeforeState>>
const hex = z.string().regex(/^[a-f0-9]{64}$/)
const bindingSchema = z.object({
  connectionId: z.literal("w200"),
  system: z.literal("GR2"),
  client: z.literal("200"),
  user: z.string().regex(/^[A-Z0-9_]{1,12}$/),
  bcSetId: z.literal("EHS_CUNI_KNM"),
  version: z.literal("N"),
  requestNumber: z.literal("GR2K923429"),
  taskNumber: z.literal("GR2K923430")
})
export type ConfigurationBcStateBinding = z.infer<typeof bindingSchema>
export function assertConfigurationBcBeforeState(state: State) {
  bindingSchema.parse(state)
  if (
    state.readOnly !== true ||
    state.executable !== false ||
    state.activationAvailable !== false ||
    state.snapshot !== false ||
    state.recoveryAvailable !== false ||
    state.buffer.nativeRoundtrip !== true ||
    state.buffer.clientSideImportAvailable !== false ||
    state.buffer.recoveryPermit !== false ||
    state.bodyFingerprint !== configurationBcStateBodyFingerprint ||
    state.layoutFingerprint !== configurationBcStateLayoutFingerprint ||
    hashWriteInput(state.layouts) !== hashWriteInput(configurationBcStateLayouts)
  )
    throw Error("CONFIGURATION_BC_BEFORE_STATE_INVALID")
  if (
    Object.keys(state.versions).sort().join(",") !==
    "candidate,cts,guard,metadata,source,state,target"
  )
    throw Error("CONFIGURATION_BC_BEFORE_STATE_VERSIONS_INVALID")
  for (const [name, value] of Object.entries(state.versions)) {
    hex.parse(value)
    if (
      name !== "state" &&
      state[`native${name[0]!.toUpperCase()}${name.slice(1)}Version` as keyof State] !== value
    )
      throw Error("CONFIGURATION_BC_BEFORE_STATE_VERSIONS_INVALID")
  }
  const data = Buffer.from(state.buffer.data, "base64")
  if (
    !data.length ||
    data.length > 524288 ||
    data.length !== state.buffer.bytes ||
    data.toString("base64") !== state.buffer.data ||
    createHash("sha256").update(data).digest("hex") !== state.versions.state
  )
    throw Error("CONFIGURATION_BC_BEFORE_STATE_BUFFER_INVALID")
  if (
    JSON.stringify(Object.keys(state.counts)) !== JSON.stringify(configurationBcStateTables) ||
    Object.entries(state.counts).some(
      ([name, v]) =>
        !Number.isInteger(v) ||
        v < 0 ||
        v > (["T006A", "T006B", "T006C", "T006J", "T006T"].includes(name) ? 3 : 1)
    ) ||
    Object.values(state.counts).reduce((a, b) => a + b, 0) > 19
  )
    throw Error("CONFIGURATION_BC_BEFORE_STATE_COUNTS_INVALID")
  if (
    hashWriteInput(bindingSchema.parse(state.cts)) !== hashWriteInput(bindingSchema.parse(state)) ||
    state.cts.ctsVersion !== state.versions.cts ||
    state.cts.buffer.recoveryPermit !== false ||
    state.cts.recoveryAvailable !== false
  )
    throw Error("CONFIGURATION_BC_BEFORE_STATE_CTS_INVALID")
  const ctsData = Buffer.from(state.cts.buffer.data, "base64")
  if (
    !ctsData.length ||
    ctsData.length > 524288 ||
    ctsData.length !== state.cts.buffer.bytes ||
    ctsData.toString("base64") !== state.cts.buffer.data ||
    createHash("sha256").update(ctsData).digest("hex") !== state.versions.cts
  )
    throw Error("CONFIGURATION_BC_BEFORE_STATE_CTS_INVALID")
}

/** Immutable local evidence only. Command reservations remain owned by WriteOperationReceiptStore. */
export class ConfigurationBcBeforeStateStore {
  private readonly root: string
  constructor(serverStateRoot: string) {
    this.root = resolve(serverStateRoot, "configuration-bc-before-state")
  }

  async capture(reader: () => Promise<State>) {
    // The reader is server-owned; there is no public import/caller-supplied buffer entry point.
    const state = structuredClone(await reader())
    assertConfigurationBcBeforeState(state)
    const id = hashWriteInput(state)
    await mkdir(this.root, { recursive: true })
    const temporary = join(this.root, `.${id}.${randomUUID()}.tmp`)
    try {
      await createExclusiveJsonFile(temporary, {
        format: 1,
        id,
        capturedAt: new Date().toISOString(),
        state
      })
      // Publish only the fsynced complete file; concurrent same-state captures cannot see half JSON.
      await link(temporary, join(this.root, `${id}.json`))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      await this.read(id, bindingSchema.parse(state))
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
      })
    }
    return {
      reference: id,
      binding: bindingSchema.parse(state),
      stateVersion: state.versions.state,
      ctsVersion: state.versions.cts,
      recoveryPermit: false as const,
      executable: false as const
    }
  }

  async read(reference: string, authenticatedBinding: ConfigurationBcStateBinding): Promise<State> {
    hex.parse(reference)
    const expected = bindingSchema.parse(authenticatedBinding)
    const text = await readFile(join(this.root, `${reference}.json`), "utf8")
    if (Buffer.byteLength(text) > 1500000) throw Error("CONFIGURATION_BC_BEFORE_STATE_LIMIT")
    const envelope = z
      .object({
        format: z.literal(1),
        id: hex,
        capturedAt: z.string().datetime(),
        state: z.record(z.unknown())
      })
      .strict()
      .parse(JSON.parse(text))
    if (envelope.id !== reference || hashWriteInput(envelope.state) !== reference)
      throw Error("CONFIGURATION_BC_BEFORE_STATE_CORRUPT")
    const state = envelope.state as State
    assertConfigurationBcBeforeState(state)
    if (hashWriteInput(bindingSchema.parse(state)) !== hashWriteInput(expected))
      throw Error("CONFIGURATION_BC_BEFORE_STATE_BINDING_INVALID")
    return structuredClone(state)
  }

  async captureEffects(
    beforeStateReference: string,
    authenticatedBinding: ConfigurationBcStateBinding,
    reader: () => Promise<ConfigurationBcEffectsEvidence>
  ) {
    const state = await this.read(beforeStateReference, authenticatedBinding)
    const effects = structuredClone(await reader())
    assertConfigurationBcEffectsEvidence(effects, state, beforeStateReference)
    const value = { beforeStateReference, effects },
      id = hashWriteInput(value)
    const temporary = join(this.root, `.${id}.${randomUUID()}.tmp`)
    try {
      await createExclusiveJsonFile(temporary, {
        format: 2,
        id,
        capturedAt: new Date().toISOString(),
        ...value
      })
      await link(temporary, join(this.root, `${id}.json`))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      await this.readEffects(id, authenticatedBinding)
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
      })
    }
    return {
      reference: id,
      beforeStateReference,
      effectsVersion: effects.effectsVersion,
      recoveryPermit: false as const,
      executable: false as const,
      snapshot: false as const
    }
  }

  async readEffects(reference: string, authenticatedBinding: ConfigurationBcStateBinding) {
    hex.parse(reference)
    const text = await readFile(join(this.root, `${reference}.json`), "utf8")
    if (Buffer.byteLength(text) > 900000) throw Error("CONFIGURATION_BC_EFFECTS_LIMIT")
    const envelope = z
      .object({
        format: z.literal(2),
        id: hex,
        capturedAt: z.string().datetime(),
        beforeStateReference: hex,
        effects: z.record(z.unknown())
      })
      .strict()
      .parse(JSON.parse(text))
    const value = { beforeStateReference: envelope.beforeStateReference, effects: envelope.effects }
    if (envelope.id !== reference || hashWriteInput(value) !== reference)
      throw Error("CONFIGURATION_BC_EFFECTS_CORRUPT")
    // Format 1 remains the sole configuration-state format; format 2 cannot chain or replace it.
    const state = await this.read(envelope.beforeStateReference, authenticatedBinding)
    const effects = envelope.effects as ConfigurationBcEffectsEvidence
    assertConfigurationBcEffectsEvidence(effects, state, envelope.beforeStateReference)
    return {
      beforeStateReference: envelope.beforeStateReference,
      state,
      effects: structuredClone(effects)
    }
  }
}
