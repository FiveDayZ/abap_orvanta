import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import { transportNumberSchema } from "./transport-delivery.js"
import { createReviewedTableReader, type ReviewedReaderSource } from "./reviewed-table-reader.js"
import { configurationUnitSchema } from "./configuration-unit.js"

// Keep the MCP object shape discoverable and enforce container rules in the service.
export const configurationTransportInputSchema = z
  .object({
    connectionId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,100}$/)
      .toLowerCase(),
    requestNumber: transportNumberSchema,
    taskNumber: transportNumberSchema,
    unitText: z
      .object({
        unitKey: configurationUnitSchema.shape.unitKey,
        language: configurationUnitSchema.shape.language.unwrap()
      })
      .strict()
      .optional()
  })
  .strict()
export const configurationTransportSchema = configurationTransportInputSchema.refine(
  (input) => input.requestNumber !== input.taskNumber,
  "Request and task must differ"
)
export const configurationTransportLayouts = {
  E070: "8a8e77c5943147bdb77fb9d10afc803e0e3a9e8a2a44f8178defca38c48449f1",
  E070C: "e6d5897c0588ee2e1720b7a9bd420c8a75efa6a5b2163266d0fdca864a722632"
} as const
export const configurationUnitTextTransportLayouts = {
  E071: "8e687e14b7e96d70a5dc568e95e06d1c00e8a4ac7bd02bd18d634890df2cf9a1",
  E071K: "f6da6a1556eaea9b3c3df7e4f065eca401cf53381578d2a7a4e1af518a368000"
} as const
export const configurationUnitTextTransportFields = {
  E071: ["TRKORR", "AS4POS", "PGMID", "OBJECT", "OBJ_NAME"],
  E071K: [
    "TRKORR",
    "PGMID",
    "OBJECT",
    "OBJNAME",
    "AS4POS",
    "MASTERTYPE",
    "MASTERNAME",
    "VIEWNAME",
    "TABKEY"
  ]
} as const
export const configurationTransportDomains = {
  TRFUNCTION: "38c8e1ac124bbc78f5dc2e37a2b345e855f5a7a120b2f8e17e8815aa4bb1fad9",
  TRSTATUS: "230cc1d10fa72873ab5daf354990493e0810fb7c45eeeeb512b583c053edc5ec",
  TRCATEG: "a54c9bd2350fb364f8f78e655f736ab422f62510dd9bcd5adffc2317b0589dd6"
} as const
export const configurationTransportFields = {
  E070: [
    "TRKORR",
    "TRFUNCTION",
    "TRSTATUS",
    "TARSYSTEM",
    "KORRDEV",
    "AS4USER",
    "AS4DATE",
    "AS4TIME",
    "STRKORR"
  ],
  E070C: ["TRKORR", "CLIENT", "TARCLIENT", "EXTENDED_STATE", "OVERTAKER"]
} as const

export async function inspectConfigurationTransport(
  raw: unknown,
  client: string,
  username: string,
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  readTable: (name: string) => Promise<unknown>,
  readDomain: (name: string) => Promise<unknown>,
  readFunction: (name: string) => Promise<unknown>,
  readUnit?: (input: z.infer<typeof configurationUnitSchema>) => Promise<unknown>
) {
  const input = configurationTransportSchema.parse(raw)
  if (input.connectionId !== "w200" || client !== "200")
    throw new Error("CONFIGURATION_CTS_SCOPE_UNSUPPORTED")
  const startedAt = new Date().toISOString()
  const verify = async () => {
    for (const [kind, entries, read] of [
      [
        "transparentTable",
        input.unitText
          ? { ...configurationTransportLayouts, ...configurationUnitTextTransportLayouts }
          : configurationTransportLayouts,
        readTable
      ],
      ["domain", configurationTransportDomains, readDomain]
    ] as const)
      for (const [name, fingerprint] of Object.entries(entries)) {
        if (
          !z
            .object({
              connectionId: z.literal("w200"),
              objectKind: z.literal(kind),
              objectName: z.literal(name),
              fingerprint: z.literal(fingerprint),
              active: z.literal(true).optional()
            })
            .safeParse(await read(name)).success
        )
          throw new Error("CONFIGURATION_CTS_METADATA_UNVERIFIED")
      }
  }
  await verify()
  const sources: ReviewedReaderSource[] = [],
    warnings: string[] = []
  const reader = createReviewedTableReader(
    backend,
    input.connectionId,
    () => readFunction("RFC_READ_TABLE"),
    sources,
    warnings
  )
  const read = (table: keyof typeof configurationTransportFields, number: string) =>
    reader({
      table,
      fields: configurationTransportFields[table],
      filters: { TRKORR: number },
      maximum: 1,
      codePrefix: "CONFIGURATION_CTS_",
      mapError: (error) =>
        error instanceof Error && /^CONFIGURATION_CTS_[A-Z_]+$/.test(error.message)
          ? error.message
          : "CONFIGURATION_CTS_QUERY_FAILED"
    })
  const observe = async () => ({
    request: await read("E070", input.requestNumber),
    requestClient: await read("E070C", input.requestNumber),
    task: await read("E070", input.taskNumber),
    taskClient: await read("E070C", input.taskNumber)
  })
  const first = await observe()
  const checkPair = (headers: typeof first) => {
    const request = headers.request?.[0],
      task = headers.task?.[0]
    return (
      request?.TRFUNCTION === "W" &&
      request.TRSTATUS === "D" &&
      request.STRKORR === "" &&
      request.KORRDEV === "CUST" &&
      request.TARSYSTEM !== "" &&
      task?.TRFUNCTION === "Q" &&
      task.TRSTATUS === "D" &&
      task.STRKORR === input.requestNumber &&
      task.KORRDEV === "CUST" &&
      !!username &&
      task.AS4USER === username.toUpperCase() &&
      headers.requestClient?.[0]?.CLIENT === client &&
      headers.taskClient?.[0]?.CLIENT === client
    )
  }
  let keyStatus = "blocked",
    keyCode: string | null = null,
    keyObservation: unknown = null,
    unitFingerprint: string | null = null,
    sapLanguage: string | null = null,
    unitReads = 0,
    entryReads = 0
  if (input.unitText && checkPair(first)) {
    try {
      if (!readUnit) throw Error("CONFIGURATION_CTS_UNIT_READER_UNAVAILABLE")
      const unitInput = { connectionId: input.connectionId, ...input.unitText }
      const unitShape = z.object({
        connectionId: z.literal("w200"),
        client: z.literal(client),
        unitKey: z.literal(input.unitText.unitKey),
        readOnly: z.literal(true),
        saveAvailable: z.literal(false),
        readFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        unit: z.object({
          status: z.literal("read"),
          data: z.object({ MANDT: z.literal(client), MSEHI: z.literal(input.unitText.unitKey) })
        }),
        text: z.object({
          status: z.literal("read"),
          requestedLanguage: z.literal(input.unitText.language),
          sapLanguage: z.string().regex(/^[A-Za-z0-9]$/),
          data: z.object({
            MANDT: z.literal(client),
            MSEHI: z.literal(input.unitText.unitKey),
            SPRAS: z.string().regex(/^[A-Za-z0-9]$/)
          })
        }),
        evidence: z.object({ valuesRechecked: z.literal(true), snapshot: z.literal(false) })
      })
      unitReads++
      const unit = unitShape.safeParse(await readUnit(unitInput))
      if (!unit.success || unit.data.text.sapLanguage !== unit.data.text.data.SPRAS)
        throw Error("CONFIGURATION_CTS_UNIT_UNAVAILABLE")
      const entries = async () => {
        const result: Record<string, Record<string, string>[]> = {}
        for (const [container, number] of [
          ["request", input.requestNumber],
          ["task", input.taskNumber]
        ] as const) {
          for (const table of ["E071", "E071K"] as const) {
            const before = sources.length
            entryReads++
            const rows = await reader({
              table,
              fields: configurationUnitTextTransportFields[table],
              filters:
                table === "E071"
                  ? { TRKORR: number, PGMID: "R3TR", OBJECT: "TDAT", OBJ_NAME: "CUNI" }
                  : { TRKORR: number, PGMID: "R3TR", OBJECT: "TABU", OBJNAME: "T006A" },
              maximum: 32,
              codePrefix: "CONFIGURATION_CTS_",
              mapError: (error) =>
                error instanceof Error && /^CONFIGURATION_CTS_[A-Z_]+$/.test(error.message)
                  ? error.message
                  : "CONFIGURATION_CTS_KEY_QUERY_FAILED",
              validate: (values) => {
                if (new Set(values.map((row) => row.AS4POS)).size !== values.length)
                  throw Error("CONFIGURATION_CTS_KEY_DUPLICATE_POSITION")
              }
            })
            if (rows === null) throw Error(sources[before]!.code!)
            if (sources[before]!.status === "truncated")
              throw Error("CONFIGURATION_CTS_KEYS_TRUNCATED")
            result[container + table] = [...rows].sort((a, b) =>
              JSON.stringify(a).localeCompare(JSON.stringify(b))
            )
          }
        }
        return result
      }
      const initial = await entries(),
        confirmation = await entries()
      if (JSON.stringify(initial) !== JSON.stringify(confirmation))
        throw Error("CONFIGURATION_CTS_KEYS_CHANGED")
      unitReads++
      const finalUnit = unitShape.safeParse(
        await readUnit({ ...unitInput, expectedReadFingerprint: unit.data.readFingerprint })
      )
      if (
        !finalUnit.success ||
        finalUnit.data.readFingerprint !== unit.data.readFingerprint ||
        finalUnit.data.text.sapLanguage !== unit.data.text.sapLanguage ||
        finalUnit.data.text.sapLanguage !== finalUnit.data.text.data.SPRAS
      )
        throw Error("CONFIGURATION_CTS_UNIT_CHANGED")
      unitFingerprint = unit.data.readFingerprint
      sapLanguage = unit.data.text.sapLanguage
      const keys = [...initial.requestE071K!, ...initial.taskE071K!]
      keyStatus = !keys.length
        ? "no_table_entries"
        : keys.some((row) => row.MASTERTYPE !== "TDAT" || row.MASTERNAME !== "CUNI")
          ? "master_mismatch"
          : (!initial.requestE071!.length && initial.requestE071K!.length) ||
              (!initial.taskE071!.length && initial.taskE071K!.length)
            ? "master_unresolved"
            : "table_entries_observed"
      keyObservation = initial
    } catch (error) {
      keyCode =
        error instanceof Error && /^CONFIGURATION_CTS_[A-Z_]+$/.test(error.message)
          ? error.message
          : "CONFIGURATION_CTS_KEYS_UNAVAILABLE"
      keyStatus = keyCode.endsWith("_CHANGED")
        ? "changed"
        : keyCode.endsWith("_TRUNCATED")
          ? "truncated"
          : "unavailable"
    }
  }
  const second = await observe()
  await verify()
  const unavailable =
    Object.values(first).some((rows) => rows === null) ||
    Object.values(second).some((rows) => rows === null)
  const changed = !unavailable && JSON.stringify(first) !== JSON.stringify(second)
  const observed = unavailable || changed ? null : first
  const request = observed?.request?.[0],
    task = observed?.task?.[0]
  const requestClient = observed?.requestClient?.[0],
    taskClient = observed?.taskClient?.[0]
  const checks = {
    requestType: request ? request.TRFUNCTION === "W" : null,
    taskType: task ? task.TRFUNCTION === "Q" : null,
    requestOpen: request ? request.TRSTATUS === "D" : null,
    taskOpen: task ? task.TRSTATUS === "D" : null,
    requestIsRoot: request ? request.STRKORR === "" : null,
    taskParent: task ? task.STRKORR === input.requestNumber : null,
    taskOwnerMatchesConfiguredUser:
      task && username ? task.AS4USER === username.toUpperCase() : null,
    requestClient: requestClient ? requestClient.CLIENT === client : null,
    taskClient: taskClient ? taskClient.CLIENT === client : null,
    requestCategory: request ? request.KORRDEV === "CUST" : null,
    taskCategory: task ? task.KORRDEV === "CUST" : null,
    transportTarget: request ? request.TARSYSTEM !== "" : null
  }
  return {
    connectionId: input.connectionId,
    client,
    requestNumber: input.requestNumber,
    taskNumber: input.taskNumber,
    status: unavailable
      ? "unavailable"
      : changed
        ? "changed"
        : Object.values(checks).some((v) => v === false)
          ? "rejected"
          : Object.values(checks).some((v) => v === null)
            ? "unknown"
            : "metadata_matches",
    readOnly: true,
    saveAvailable: false,
    observed,
    checks,
    readFingerprint: observed
      ? createHash("sha256").update(JSON.stringify({ client, observed })).digest("hex")
      : null,
    keyRecording: input.unitText
      ? {
          status: unavailable
            ? "unavailable"
            : changed
              ? "changed"
              : !checkPair(second)
                ? "blocked"
                : keyStatus,
          code: keyCode,
          officialEncoding: "not_verified",
          exactRowRecording: "not_verified",
          importStatus: "not_checked",
          target: { client, ...input.unitText, sapLanguage: observed ? sapLanguage : null },
          E071KReadback:
            observed && checkPair(second) && keyObservation
              ? "bounded_trimmed_projection"
              : sources.some((source) => source.table === "E071K")
                ? "attempted_bounded_trimmed_projection"
                : "not_performed",
          representation: "sap_text_trimmed",
          observed: observed && checkPair(second) ? keyObservation : null,
          readFingerprint:
            observed && checkPair(second) && keyObservation
              ? createHash("sha256")
                  .update(JSON.stringify({ unitFingerprint, keyObservation }))
                  .digest("hex")
              : null,
          unitReadFingerprint: observed ? unitFingerprint : null,
          readerLimits: {
            entryReaderInvocations: entryReads,
            entryReaderInvocationLimit: 8,
            maximumRowsPerProjection: 32,
            unitReaderInvocations: unitReads,
            unitReaderInvocationLimit: 2
          },
          manualChecks: [
            "Compare original untrimmed E071K TABKEY in the SAP transport organizer with the exact client/SAP language/internal unit key; no key encoder or decoder is attested.",
            "Verify E071 R3TR/TDAT/CUNI and E071K TABU/T006A master linkage, wildcard/generalized keys and update-task result. A trimmed key or table-level entry is not exact-row recording proof.",
            "Verify actual import and target values separately; request/task or key entry existence does not prove target configuration took effect."
          ]
        }
      : {
          status: "unknown",
          officialEncoding: "not_verified",
          E071KReadback: "not_performed"
        },
    authorization: "not_attested",
    maintenanceApi: "not_verified",
    writeAdmission: "blocked",
    evidence: {
      startedAt,
      finishedAt: new Date().toISOString(),
      sources,
      warnings,
      definitionsRechecked: true,
      snapshot: false
    },
    warnings: [
      "W is a Customizing request, Q is a Customizing task; K is Workbench. Protected/releasing/released, local-target and other types are not admitted.",
      "Only exact request/task metadata is compared twice. Missing client records remain unknown; no inheritance is guessed. Owner match is against configured user, not an authority check.",
      "Metadata matches do not attest object recording, E071K encoding, locks, business validation or an executable maintenance API. No request/task creation, release or recording."
    ]
  }
}
