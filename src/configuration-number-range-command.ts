import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import {
  configurationNumberRangeApplyApi,
  configurationNumberRangeReadApi
} from "./configuration-number-range-api.js"
import { configurationUnitApiBody } from "./configuration-unit-api.js"
import {
  numberRangeScopeFunctions,
  numberRangeScopeIncludes
} from "./configuration-number-range-scope.js"

const version = z.string().regex(/^[a-f0-9]{64}$/)
export function configurationNumberRangeFailure(
  stage: "native_call" | "native_reply" | "native_result" | "readback" | "verification" | "receipt",
  code: string,
  evidence: unknown
) {
  // Raw transport/fault text may contain credentials; retain only its digest.
  return {
    stage,
    code,
    evidenceHash: createHash("sha256")
      .update(
        evidence instanceof Error
          ? String(evidence)
          : (JSON.stringify(evidence) ?? String(evidence))
      )
      .digest("hex")
  }
}
export const configurationNumberRangeCommandInputSchema = z
  .object({
    connectionId: z.literal("w200"),
    objectName: z.string().regex(/^[ZY][A-Z0-9_]{0,9}$/),
    expectedVersion: version,
    action: z.enum(["create", "update"]),
    intervalNumber: z.string().regex(/^[A-Z0-9]{2}$/),
    fromNumber: z.string().regex(/^[0-9]{20}$/),
    toNumber: z.string().regex(/^[0-9]{20}$/),
    external: z.boolean(),
    operationId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
    acknowledgeConfigurationWrite: z.literal(true),
    acknowledgeLocalClientOnly: z.literal(true)
  })
  .strict()
export const configurationNumberRangeCommandSchema =
  configurationNumberRangeCommandInputSchema.refine(
    (input) => input.fromNumber < input.toNumber,
    "Lower bound must be less than upper bound"
  )
const parameter = z.object({
  name: z.string(),
  typeName: z.string(),
  optional: z.boolean(),
  passByValue: z.boolean()
})
const definitionSchema = z.object({
  connectionId: z.literal("w200"),
  functionName: z.string(),
  remoteEnabled: z.literal(true),
  updateTask: z.literal(false),
  updateTaskMode: z.literal(""),
  importParameters: z.array(parameter),
  exportParameters: z.array(parameter),
  tableParameters: z.array(parameter),
  changingParameters: z.array(z.never()),
  exceptions: z.array(z.never()),
  sourceFingerprint: version,
  interfaceFingerprint: version,
  source: z.array(z.string())
})
export function attestConfigurationNumberRangeApi(raw: unknown, kind: "read" | "apply") {
  const api = kind === "read" ? configurationNumberRangeReadApi : configurationNumberRangeApplyApi
  const parsed = definitionSchema.safeParse(raw)
  if (!parsed.success) throw Error("CONFIGURATION_NR_API_NOT_ATTESTED")
  const actual = parsed.data
  const ordered = (entries: readonly unknown[]) =>
    JSON.stringify([...entries].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
  if (
    actual.functionName !== api.functionName ||
    actual.source.filter((line) => /^\s*FUNCTION\s+/i.test(line)).length !== 1 ||
    !actual.source.some((line) => line.trim().toUpperCase() === `FUNCTION ${api.functionName}.`) ||
    !actual.source.some((line) => line.trim().toUpperCase() === "ENDFUNCTION.") ||
    configurationUnitApiBody(actual.source) !== configurationUnitApiBody(api.source.split("\n")) ||
    (["importParameters", "exportParameters", "tableParameters"] as const).some(
      (name) => ordered(actual[name]) !== ordered(api[name])
    )
  )
    throw Error("CONFIGURATION_NR_API_NOT_ATTESTED")
  return actual
}

export const configurationNumberRangeCommandDependencies = {
  ...numberRangeScopeFunctions,
  CALCULATE_HASH_FOR_RAW: {
    sourceFingerprint: "874f8e777eda4b72aecd34ab11153af0fe291ca777b8023c96c13c1119bfd458",
    interfaceFingerprint: "9d0e795153f6118bb966e18c6d4bdbca7e66f927c75bfe8e9fcf22d4fb153779"
  },
  NUMBER_RANGE_API_THNOCALL: {
    sourceFingerprint: "9918551c5b3ffc23d74987cbed511fa80f9e6e49666af2d7d0fb77d8bbf357bf",
    interfaceFingerprint: "2750867f733eecedd4a40d9cac29a666ff12b22153c8bf03d3174fcb291e3e07"
  },
  SWE_REQUESTER_TO_UPDATE: {
    sourceFingerprint: "02a2aa6b08406d0a337cc4d81166b79a790d6a135848f5531db8f0dddb04a5f4",
    interfaceFingerprint: "fd667432000c3ca5f7170ead62e07126fa2ecc8adb1a59673d065957246facaa"
  },
  NRINTERVAL_WRITE_DOCUMENT: {
    updateTask: true,
    sourceFingerprint: "0379d962902a1fc2e8c8a82151d94aaf18db125db75c99a71e6bbb26abbf36b2",
    interfaceFingerprint: "75ca7fd15c3acebe80db1e8df4659153bda593df2d7667e4c3a421edcf9924a1"
  },
  CHANGEDOCUMENT_CLOSE: {
    sourceFingerprint: "e1a3c8b4482f7743c16f3b9d87f01e54684deaf99c34afbe295c0905ca81c483",
    interfaceFingerprint: "87cd3b42ca0d15fbbbbeed1675d22af78a8167d68821a31400edfb0e209ede8d"
  }
} as const
export const configurationNumberRangeCommandIncludes = {
  ...numberRangeScopeIncludes,
  LSNR1F99: "b83dc310fbd17583edfa87b4b0fa01f1668bd2be6639f0622340231490a80bfd",
  FSNR1CDC: "b960fd138a503d22f1d81b5978b250579920b5a52d95ae6114fde17628dc5219"
} as const

const fields = [
  "CLIENT",
  "OBJECT",
  "SUBOBJECT",
  "NRRANGENR",
  "TOYEAR",
  "FROMNUMBER",
  "TONUMBER",
  "NRLEVEL",
  "EXTERNIND"
] as const
const interval = z
  .object(Object.fromEntries(fields.map((name) => [name, z.string().max(20)])))
  .strict()
export const configurationNumberRangeSnapshotSchema = z.object({
  EV_CODE: z.literal("READ_OK"),
  EV_SYSTEM: z.literal("GR2"),
  EV_CLIENT: z.literal("200"),
  EV_VERSION: version,
  ES_DEFINITION: z.record(z.string()),
  ET_INTERVALS: z.array(interval).max(100)
})
const replySchema = z
  .object({
    EV_CODE: z.string(),
    EV_SYSTEM: z.literal("GR2"),
    EV_CLIENT: z.literal("200"),
    EV_USER: z.string().min(1).max(12),
    EV_COMMITTED: z.enum(["", "X", "?"]),
    EV_BEFORE_VERSION: z.string(),
    EV_VERSION: z.string(),
    EV_SESSION_RESET: z.enum(["", "X", "not_required"]),
    EV_UNLOCKED: z.enum(["", "X", "not_required"]),
    EV_MSGID: z.string().max(20),
    EV_MSGNO: z.string().max(3),
    ES_ERROR: z.record(z.string()),
    ET_INTERVALS: z.array(interval).max(100)
  })
  .strict()
const equalRows = (left: z.infer<typeof interval>[], right: z.infer<typeof interval>[]) =>
  JSON.stringify([...left].sort((a, b) => a.NRRANGENR!.localeCompare(b.NRRANGENR!))) ===
  JSON.stringify([...right].sort((a, b) => a.NRRANGENR!.localeCompare(b.NRRANGENR!)))
const cleanRows = (rows: z.infer<typeof interval>[]) =>
  rows.map((row) =>
    Object.fromEntries(
      fields.map((field) => {
        const value = row[field]!.trimEnd()
        return [field, field === "NRLEVEL" && /^(?:0{1,20})?$/.test(value) ? "0" : value]
      })
    )
  )

/** Internal adapter only: deployment, protected receipt and tool registration are separate gates. */
export async function applyConfigurationNumberRange(
  raw: unknown,
  client: string,
  backend: Pick<SapBackend, "callRemoteFunction">,
  readDefinition: (name: string) => Promise<unknown>,
  readSnapshot: (objectName: string) => Promise<unknown>,
  beforeInvoke: (operationId: string, snapshot: unknown) => Promise<void>,
  readInclude: (name: string) => Promise<string>
) {
  const input = configurationNumberRangeCommandSchema.parse(raw)
  if (client !== "200") throw Error("CONFIGURATION_NR_SCOPE_UNSUPPORTED")
  const attest = async () => {
    const reader = attestConfigurationNumberRangeApi(
      await readDefinition(configurationNumberRangeReadApi.functionName),
      "read"
    )
    const writer = attestConfigurationNumberRangeApi(
      await readDefinition(configurationNumberRangeApplyApi.functionName),
      "apply"
    )
    for (const [name, pins] of Object.entries(configurationNumberRangeCommandDependencies)) {
      const observed = z
        .object({
          functionName: z.literal(name),
          remoteEnabled: z.literal(false),
          updateTask: z.literal("updateTask" in pins && pins.updateTask),
          sourceFingerprint: z.literal(pins.sourceFingerprint),
          interfaceFingerprint: z.literal(pins.interfaceFingerprint)
        })
        .safeParse(await readDefinition(name))
      if (!observed.success) throw Error("CONFIGURATION_NR_DEPENDENCY_NOT_ATTESTED")
    }
    for (const [name, pin] of Object.entries(configurationNumberRangeCommandIncludes)) {
      const source = await readInclude(name)
      // FSNR1CDC is a program Include on w200; the LSNR1* Includes belong to SNR1.
      const sourcePath =
        name === "FSNR1CDC"
          ? "/programs/includes/fsnr1cdc/source"
          : `/functions/groups/snr1/includes/${name.toLowerCase()}/source`
      const header = source.match(
        /^Source from ([A-Z0-9_]+) \(lines 1-(\d+) of (\d+), (\d+) lines retrieved\):/
      )
      if (
        !header ||
        header[1] !== name ||
        header[2] !== header[3] ||
        header[2] !== header[4] ||
        source.match(/Full Source SHA-256: ([a-f0-9]{64})/)?.[1] !== pin ||
        !source.includes(sourcePath)
      )
        throw Error("CONFIGURATION_NR_INCLUDE_NOT_ATTESTED")
    }
    return {
      read: reader.sourceFingerprint,
      readInterface: reader.interfaceFingerprint,
      apply: writer.sourceFingerprint,
      applyInterface: writer.interfaceFingerprint
    }
  }
  const initialDefinition = await attest()
  const before = configurationNumberRangeSnapshotSchema.parse(await readSnapshot(input.objectName))
  if (
    before.EV_VERSION !== input.expectedVersion ||
    before.ES_DEFINITION.OBJECT !== input.objectName
  )
    throw Error("CONFIGURATION_NR_VERSION_CHANGED")
  if (
    before.ES_DEFINITION.DOMLEN !== "NUMC20" ||
    ["YEARIND", "BUFFER", "DTELSOBJ", "NRTAB", "TEXTIND", "RFCDEST", "NRCHECKASCII"].some(
      (name) => before.ES_DEFINITION[name]?.trim() !== ""
    )
  )
    throw Error("CONFIGURATION_NR_DEFINITION_UNSUPPORTED")
  const rows = cleanRows(before.ET_INTERVALS)
  const numbers = new Set<string>()
  for (const row of rows) {
    if (
      row.CLIENT !== "200" ||
      row.OBJECT !== input.objectName ||
      row.SUBOBJECT !== "" ||
      row.TOYEAR !== "0000" ||
      !/^[A-Z0-9]{2}$/.test(row.NRRANGENR!) ||
      !/^\d{20}$/.test(row.FROMNUMBER!) ||
      !/^\d{20}$/.test(row.TONUMBER!) ||
      row.FROMNUMBER! >= row.TONUMBER! ||
      !/^(?:0{1,20})?$/.test(row.NRLEVEL!) ||
      !["", "X"].includes(row.EXTERNIND!) ||
      numbers.has(row.NRRANGENR!)
    )
      throw Error("CONFIGURATION_NR_IN_USE_OR_STATE_INVALID")
    numbers.add(row.NRRANGENR!)
  }
  const previous = rows.find((row) => row.NRRANGENR === input.intervalNumber)
  if ((input.action === "create") === !!previous)
    throw Error("CONFIGURATION_NR_INTERVAL_ACTION_MISMATCH")
  if (previous && previous.EXTERNIND !== (input.external ? "X" : ""))
    throw Error("CONFIGURATION_NR_MODE_SWITCH_UNSUPPORTED")
  if (
    rows.some(
      (row) =>
        row.NRRANGENR !== input.intervalNumber &&
        input.fromNumber <= row.TONUMBER! &&
        row.FROMNUMBER! <= input.toNumber
    )
  )
    throw Error("CONFIGURATION_NR_OVERLAP")
  if (JSON.stringify(await attest()) !== JSON.stringify(initialDefinition))
    throw Error("CONFIGURATION_NR_SOURCE_CHANGED")
  await beforeInvoke(input.operationId, before)
  let decoded: z.infer<typeof replySchema> | null = null
  let failure: ReturnType<typeof configurationNumberRangeFailure> | null = null
  try {
    const response = await backend.callRemoteFunction("w200", {
      functionName: configurationNumberRangeApplyApi.functionName,
      inputParameters: {
        IV_OBJECT: input.objectName,
        IV_EXPECTED_VERSION: input.expectedVersion,
        IV_ACTION: input.action === "create" ? "I" : "U",
        IV_INTERVAL: input.intervalNumber,
        IV_FROM_NUMBER: input.fromNumber,
        IV_TO_NUMBER: input.toNumber,
        IV_EXTERNAL: input.external ? "X" : "",
        IV_ACK_LOCAL_ONLY: "X",
        // Bind TABLES explicitly so the committed interval rows return over SOAP.
        ET_INTERVALS: []
      },
      outputParameters: [
        ...configurationNumberRangeApplyApi.exportParameters.map((p) =>
          p.name === "ES_ERROR"
            ? {
                name: p.name,
                kind: "structure" as const,
                fields: ["MSGNR", "TABLENAME", "FIELDNAME", "TABIX"]
              }
            : { name: p.name, kind: "scalar" as const }
        ),
        { name: "ET_INTERVALS", kind: "table", fields: [...fields] }
      ]
    })
    if (response.fault)
      failure = configurationNumberRangeFailure(
        "native_call",
        "CONFIGURATION_NR_SOAP_FAULT",
        response.fault
      )
    else {
      const parsed = replySchema.safeParse(response.outputs)
      if (!parsed.success)
        failure = configurationNumberRangeFailure(
          "native_reply",
          "CONFIGURATION_NR_REPLY_INVALID",
          parsed.error.issues
        )
      else {
        decoded = parsed.data
        if (!["SAVED_LOCAL_CLIENT", "NO_CHANGES"].includes(decoded.EV_CODE))
          failure = configurationNumberRangeFailure(
            "native_result",
            "CONFIGURATION_NR_NATIVE_REFUSED",
            decoded
          )
        else if (
          decoded.EV_UNLOCKED !== "X" ||
          !["X", "not_required"].includes(decoded.EV_SESSION_RESET) ||
          (decoded.EV_CODE === "SAVED_LOCAL_CLIENT" && decoded.EV_SESSION_RESET !== "X")
        )
          failure = configurationNumberRangeFailure(
            "native_result",
            "CONFIGURATION_NR_CLEANUP_UNCONFIRMED",
            decoded
          )
      }
    }
  } catch (error) {
    failure = configurationNumberRangeFailure(
      "native_call",
      "CONFIGURATION_NR_TRANSPORT_FAILED",
      error
    )
  }
  let after: z.infer<typeof configurationNumberRangeSnapshotSchema> | null = null
  try {
    const parsed = configurationNumberRangeSnapshotSchema.safeParse(
      await readSnapshot(input.objectName)
    )
    if (parsed.success) after = parsed.data
    else
      failure ??= configurationNumberRangeFailure(
        "readback",
        "CONFIGURATION_NR_READBACK_INVALID",
        parsed.error.issues
      )
  } catch (error) {
    failure ??= configurationNumberRangeFailure(
      "readback",
      "CONFIGURATION_NR_READBACK_FAILED",
      error
    )
  }
  const expected = previous
    ? rows.map((row) =>
        row === previous ? { ...row, FROMNUMBER: input.fromNumber, TONUMBER: input.toNumber } : row
      )
    : [
        ...rows,
        {
          CLIENT: "200",
          OBJECT: input.objectName,
          SUBOBJECT: "",
          NRRANGENR: input.intervalNumber,
          TOYEAR: "0000",
          FROMNUMBER: input.fromNumber,
          TONUMBER: input.toNumber,
          NRLEVEL: "0",
          EXTERNIND: input.external ? "X" : ""
        }
      ]
  let status: "completed" | "no_changes" | "declined" | "unknown" = "unknown"
  if (decoded && after && after.ES_DEFINITION.OBJECT === input.objectName) {
    const definitionMatches =
      JSON.stringify(Object.entries(after.ES_DEFINITION).sort()) ===
      JSON.stringify(Object.entries(before.ES_DEFINITION).sort())
    const cleaned =
      ["X", "not_required"].includes(decoded.EV_SESSION_RESET) && decoded.EV_UNLOCKED === "X"
    if (
      decoded.EV_CODE === "SAVED_LOCAL_CLIENT" &&
      decoded.EV_COMMITTED === "X" &&
      decoded.EV_BEFORE_VERSION === input.expectedVersion &&
      decoded.EV_VERSION !== input.expectedVersion &&
      decoded.EV_SESSION_RESET === "X" &&
      decoded.EV_UNLOCKED === "X" &&
      definitionMatches &&
      after.EV_VERSION === decoded.EV_VERSION &&
      equalRows(cleanRows(decoded.ET_INTERVALS), expected) &&
      equalRows(cleanRows(after.ET_INTERVALS), expected)
    )
      status = "completed"
    else if (
      decoded.EV_CODE === "NO_CHANGES" &&
      decoded.EV_COMMITTED === "" &&
      cleaned &&
      definitionMatches &&
      decoded.EV_BEFORE_VERSION === input.expectedVersion &&
      decoded.EV_VERSION === input.expectedVersion &&
      after.EV_VERSION === input.expectedVersion &&
      equalRows(cleanRows(decoded.ET_INTERVALS), rows) &&
      equalRows(cleanRows(after.ET_INTERVALS), rows)
    )
      status = "no_changes"
    else if (
      [
        "VERSION_CHANGED",
        "DEFINITION_UNSUPPORTED",
        "IN_USE_OR_SCOPE_UNSUPPORTED",
        "INTERVAL_ALREADY_EXISTS",
        "INTERVAL_NOT_FOUND",
        "MODE_SWITCH_UNSUPPORTED",
        "INTERVAL_VALIDATION_FAILED"
      ].includes(decoded.EV_CODE) &&
      decoded.EV_COMMITTED === "" &&
      cleaned
    )
      status = "declined"
    else if (
      ["INPUT_INVALID", "AUTHORIZATION_DENIED", "LOCK_FAILED"].includes(decoded.EV_CODE) &&
      decoded.EV_COMMITTED === "" &&
      decoded.EV_SESSION_RESET === "not_required" &&
      decoded.EV_UNLOCKED === "not_required" &&
      decoded.ET_INTERVALS.length === 0 &&
      decoded.EV_BEFORE_VERSION === "" &&
      decoded.EV_VERSION === ""
    )
      status = "declined"
  }
  if (status === "unknown")
    failure ??= configurationNumberRangeFailure(
      "verification",
      "CONFIGURATION_NR_RESULT_MISMATCH",
      { decoded, after }
    )
  return {
    status,
    operationId: input.operationId,
    objectName: input.objectName,
    client: "200",
    transportPolicy: "local_client_only_not_recorded",
    sapInvocationStarted: true,
    outcomeMayBeUnknown: status === "unknown",
    native: decoded,
    readback: after,
    failure,
    retryAvailable: false
  }
}
