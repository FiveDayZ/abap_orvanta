import { mkdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"
import { createExclusiveJsonFile } from "./durable-json-file.js"
import { hashWriteInput } from "./write-operation-receipts.js"
import { configurationNumberRangeSnapshotSchema } from "./configuration-number-range-command.js"
import { configurationNumberRangeNativeTables } from "./configuration-number-range-native.js"

export type NumberRangeSnapshot = z.infer<typeof configurationNumberRangeSnapshotSchema>
const versionSchema = z.string().regex(/^[a-f0-9]{64}$/)
const objectSchema = z.literal("ZORVCFGNR")
const keys = ["CLIENT", "OBJECT", "SUBOBJECT", "NRRANGENR", "TOYEAR"] as const

export function verifiedNumberRangeSnapshot(raw: unknown, objectName: string): NumberRangeSnapshot {
  objectSchema.parse(objectName)
  const snapshot = configurationNumberRangeSnapshotSchema.strict().parse(raw)
  if (
    snapshot.ES_DEFINITION.OBJECT !== objectName ||
    Object.keys(snapshot.ES_DEFINITION).sort().join(",") !==
      [...configurationNumberRangeNativeTables.TNRO.fields].sort().join(",") ||
    Object.values(snapshot.ES_DEFINITION).some((value) => value.length > 128)
  )
    throw Error("CONFIGURATION_NR_STATE_DEFINITION_INVALID")
  const seen = new Set<string>()
  for (const row of snapshot.ET_INTERVALS) {
    if (
      row.CLIENT !== "200" ||
      row.OBJECT !== objectName ||
      row.SUBOBJECT !== "" ||
      row.TOYEAR !== "0000" ||
      !/^[A-Z0-9]{2}$/.test(row.NRRANGENR!) ||
      ["FROMNUMBER", "TONUMBER", "NRLEVEL"].some((field) => !/^\d{20}$/.test(row[field]!)) ||
      !["", "X"].includes(row.EXTERNIND!) ||
      seen.has(row.NRRANGENR!)
    )
      throw Error("CONFIGURATION_NR_STATE_INTERVAL_INVALID")
    seen.add(row.NRRANGENR!)
  }
  return snapshot
}

export const numberRangeStateFingerprint = (snapshot: NumberRangeSnapshot) =>
  hashWriteInput({
    ...snapshot,
    ET_INTERVALS: [...snapshot.ET_INTERVALS].sort((a, b) =>
      a.NRRANGENR!.localeCompare(b.NRRANGENR!)
    )
  })

export function numberRangeFieldDifferences(
  before: NumberRangeSnapshot,
  current: NumberRangeSnapshot
) {
  const changes: {
    table: "TNRO" | "NRIV"
    key: Record<string, string>
    field: string
    before: string | null
    current: string | null
  }[] = []
  const add = (
    table: "TNRO" | "NRIV",
    key: Record<string, string>,
    field: string,
    left: string | undefined,
    right: string | undefined
  ) => {
    if (left !== right)
      changes.push({ table, key, field, before: left ?? null, current: right ?? null })
  }
  for (const field of configurationNumberRangeNativeTables.TNRO.fields)
    add(
      "TNRO",
      { OBJECT: "ZORVCFGNR" },
      field,
      before.ES_DEFINITION[field],
      current.ES_DEFINITION[field]
    )
  const left = new Map(before.ET_INTERVALS.map((row) => [row.NRRANGENR!, row])),
    right = new Map(current.ET_INTERVALS.map((row) => [row.NRRANGENR!, row]))
  for (const intervalNumber of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const a = left.get(intervalNumber),
      b = right.get(intervalNumber)
    const key = Object.fromEntries(keys.map((field) => [field, (a ?? b)![field]!]))
    for (const field of configurationNumberRangeNativeTables.NRIV.fields)
      add("NRIV", key, field, a?.[field], b?.[field])
  }
  return changes
}

/** Server-owned immutable read evidence; no public file or snapshot import. */
export class ConfigurationNumberRangeStateStore {
  private readonly root: string
  constructor(serverStateRoot: string) {
    this.root = resolve(serverStateRoot, "configuration-number-range-state")
  }

  private reference(objectName: string, version: string) {
    objectSchema.parse(objectName)
    versionSchema.parse(version)
    return hashWriteInput({ connectionId: "w200", objectName, client: "200", version })
  }

  async capture(objectName: string, raw: unknown) {
    const snapshot = verifiedNumberRangeSnapshot(raw, objectName)
    const reference = this.reference(objectName, snapshot.EV_VERSION)
    const bodyFingerprint = numberRangeStateFingerprint(snapshot)
    await mkdir(this.root, { recursive: true })
    try {
      await createExclusiveJsonFile(join(this.root, `${reference}.json`), {
        format: 1,
        reference,
        capturedAt: new Date().toISOString(),
        bodyFingerprint,
        snapshot
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const existing = await this.read(objectName, snapshot.EV_VERSION)
      if (!existing || numberRangeStateFingerprint(existing) !== bodyFingerprint)
        throw Error("CONFIGURATION_NR_STATE_VERSION_CONFLICT")
    }
    return {
      reference,
      stateVersion: snapshot.EV_VERSION,
      bodyFingerprint,
      readOnly: true,
      executable: false,
      usableForWritePrecondition: false
    }
  }

  async read(objectName: string, version: string): Promise<NumberRangeSnapshot | null> {
    const reference = this.reference(objectName, version)
    let text: string
    try {
      text = await readFile(join(this.root, `${reference}.json`), "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
    if (Buffer.byteLength(text) > 262144) throw Error("CONFIGURATION_NR_STATE_LIMIT")
    const envelope = z
      .object({
        format: z.literal(1),
        reference: versionSchema,
        capturedAt: z.string().datetime(),
        bodyFingerprint: versionSchema,
        snapshot: z.unknown()
      })
      .strict()
      .parse(JSON.parse(text))
    const snapshot = verifiedNumberRangeSnapshot(envelope.snapshot, objectName)
    if (
      envelope.reference !== reference ||
      snapshot.EV_VERSION !== version ||
      numberRangeStateFingerprint(snapshot) !== envelope.bodyFingerprint
    )
      throw Error("CONFIGURATION_NR_STATE_CORRUPT")
    return snapshot
  }
}
