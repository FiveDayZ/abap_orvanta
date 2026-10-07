import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import {
  configurationActivitySchema,
  configurationActivityLayouts,
  configurationActivityHeaderFields
} from "./configuration-activity.js"
import {
  configurationImgDetailLanguage,
  configurationImgDetailLayouts
} from "./configuration-img-details.js"
import { createReviewedTableReader, type ReviewedReaderSource } from "./reviewed-table-reader.js"

export const configurationDocumentationSchema = configurationActivitySchema
  .extend({
    maxLines: z.number().int().min(1).max(400).default(200)
  })
  .strict()

export const configurationDocumentationTables = {
  CUS_IMGACH: configurationActivityLayouts.CUS_IMGACH,
  T002: configurationImgDetailLayouts.T002,
  DOKIL: "76e1d0a10afa64367a3532c7978a369ca69cb22056e2c95f5970116f9e8e407a"
} as const
export const configurationDocumentationStructures = {
  TLINE: "e4b4daac4c128c52b60b7d9a03f7c8c677d8b3c3f9609c3b1a26ca4db908cfc7",
  THEAD: "2ab25b4d2d724b80658c31824a50a03bb445926358f0362dde0a0ff6d3a6ebd0"
} as const
export const configurationDocumentationFunctions = {
  DOCU_GET: {
    remoteEnabled: true,
    sourceFingerprint: "8704b1d2e9eb2d46ad6add01ee4e3c820e59b46087d2e7edc7644ed390fac11f",
    interfaceFingerprint: "919ac64a289cd23951f90e2eff5a66b6de93ba3b3aac0ad3c357ee8bc2387d06"
  },
  DOCU_READ: {
    remoteEnabled: false,
    sourceFingerprint: "8856c3e8cbb043bd32c41c7b9e108430e63873b457453eccb6113fa80050b960",
    interfaceFingerprint: "02c7b30944b0bb30e0e5d49d41bfb9b23fc656b2ce93810031182d158e631c1b"
  }
} as const
const indexFields = ["ID", "OBJECT", "LANGU", "TYP", "VERSION", "TXTLINES", "DOKSTATE"]
const codeOf = (error: unknown) =>
  error instanceof Error && /^CONFIGURATION_DOCUMENTATION_[A-Z_]+$/.test(error.message)
    ? error.message
    : error instanceof Error && error.message.includes("SAP_LOGON_REJECTED")
      ? "CONFIGURATION_DOCUMENTATION_LOGIN_REJECTED"
      : "CONFIGURATION_DOCUMENTATION_READ_FAILED"

/** One IMG-linked standard end-user document. No arbitrary document ID, template or language fallback. */
export async function readConfigurationDocumentation(
  raw: unknown,
  client: string,
  defaultLanguage: string,
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  readTable: (name: string) => Promise<unknown>,
  readStructure: (name: string) => Promise<unknown>,
  readFunction: (name: string) => Promise<unknown>
) {
  const input = configurationDocumentationSchema.parse(raw)
  if (input.connectionId !== "w200" || client !== "200")
    throw Error("CONFIGURATION_DOCUMENTATION_SCOPE_UNSUPPORTED")
  const language = configurationImgDetailLanguage.parse(input.language ?? defaultLanguage)
  const startedAt = new Date().toISOString(),
    sources: ReviewedReaderSource[] = [],
    warnings: string[] = []
  const fail = (suffix: string) => Error(`CONFIGURATION_DOCUMENTATION_${suffix}`)
  const verify = async () => {
    for (const [kind, pins, read] of [
      ["transparentTable", configurationDocumentationTables, readTable],
      ["structure", configurationDocumentationStructures, readStructure]
    ] as const)
      for (const [objectName, fingerprint] of Object.entries(pins)) {
        if (
          !z
            .object({
              connectionId: z.literal("w200"),
              objectKind: z.literal(kind),
              objectName: z.literal(objectName),
              fingerprint: z.literal(fingerprint)
            })
            .safeParse(await read(objectName)).success
        )
          throw fail("METADATA_UNVERIFIED")
      }
    for (const [functionName, pins] of Object.entries(configurationDocumentationFunctions))
      if (
        !z
          .object({
            connectionId: z.literal("w200"),
            functionName: z.literal(functionName),
            remoteEnabled: z.literal(pins.remoteEnabled),
            updateTask: z.literal(false),
            sourceFingerprint: z.literal(pins.sourceFingerprint),
            interfaceFingerprint: z.literal(pins.interfaceFingerprint)
          })
          .safeParse(await readFunction(functionName)).success
      )
        throw fail("API_UNVERIFIED")
  }
  await verify()
  const reader = createReviewedTableReader(
    backend,
    input.connectionId,
    () => readFunction("RFC_READ_TABLE"),
    sources,
    warnings
  )
  const read = async (table: string, fields: string[], filters: Record<string, string>) => {
    const rows = await reader({
      table,
      fields,
      filters,
      maximum: 1,
      filterLengthLimit: 60,
      codePrefix: "CONFIGURATION_DOCUMENTATION_",
      mapError: codeOf
    })
    if (rows === null)
      throw Error(sources.at(-1)?.code ?? "CONFIGURATION_DOCUMENTATION_READ_FAILED")
    if (sources.at(-1)?.status === "truncated") throw fail("AMBIGUOUS_METADATA")
    return rows
  }
  const headerFilter = { ACTIVITY: input.activityId }
  const headers = await read("CUS_IMGACH", configurationActivityHeaderFields, headerFilter)
  const reference = headers[0]?.DOCU_ID ?? null
  let status = "unavailable",
    code: string | null = null,
    sapLanguage: string | null = null
  let index: Record<string, string> | null = null,
    lines: { TDFORMAT: string; TDLINE: string }[] | null = null
  let documentHead: Record<string, string> | null = null,
    contentFingerprint: string | null = null
  let apiReads = 0,
    changed = false,
    metadataRechecked = false
  let apiFaultName: string | null = null
  const checks: {
    table: string
    fields: string[]
    filters: Record<string, string>
    rows: Record<string, string>[]
  }[] = [
    {
      table: "CUS_IMGACH",
      fields: configurationActivityHeaderFields,
      filters: headerFilter,
      rows: headers
    }
  ]
  try {
    if (!headers.length) status = "header_not_found"
    else if (!reference) status = "no_document_reference"
    else if (!/^SIMG[A-Z0-9_/]{1,56}$/.test(reference)) {
      status = "unsupported_reference"
      code = "CONFIGURATION_DOCUMENTATION_REFERENCE_UNSUPPORTED"
    } else {
      const mappingFilter = { LAISO: language },
        mapping = await read("T002", ["LAISO", "SPRAS"], mappingFilter)
      checks.push({
        table: "T002",
        fields: ["LAISO", "SPRAS"],
        filters: mappingFilter,
        rows: mapping
      })
      sapLanguage = mapping[0]?.SPRAS ?? null
      if (!sapLanguage || !/^[A-Za-z0-9]$/.test(sapLanguage)) throw fail("LANGUAGE_UNAVAILABLE")
      // DOCU_GET with explicit nonzero VERSION avoids its HY include/default-version branch.
      const indexFilter = { ID: "HY", OBJECT: reference, LANGU: sapLanguage, TYP: "E" }
      const indexes = await read("DOKIL", indexFields, indexFilter)
      checks.push({ table: "DOKIL", fields: indexFields, filters: indexFilter, rows: indexes })
      index = indexes[0] ?? null
      if (!index) status = "indexed_document_not_found"
      else {
        if (
          !/^\d{4}$/.test(index.VERSION!) ||
          Number(index.VERSION) === 0 ||
          !/^\d{1,5}$/.test(index.TXTLINES!)
        )
          throw fail("INDEX_INVALID")
        if (Number(index.TXTLINES) > input.maxLines) {
          status = "limit_exceeded"
          code = "CONFIGURATION_DOCUMENTATION_LINE_LIMIT"
        } else {
          const fetch = async () => {
            apiReads++
            const result = await backend.callRemoteFunction("w200", {
              functionName: "DOCU_GET",
              inputParameters: {
                ID: "HY",
                OBJECT: reference,
                LANGU: sapLanguage!,
                TYP: "E",
                VERSION: index!.VERSION!,
                VERSION_ACTIVE_OR_LAST: "L",
                EXTEND_EXCEPT: "",
                PRINT_PARAM_GET: "",
                LINE: []
              },
              outputParameters: [
                {
                  name: "HEAD",
                  kind: "structure",
                  fields: ["TDOBJECT", "TDNAME", "TDID", "TDSPRAS", "TDVERSION"]
                },
                { name: "DOKTYP", kind: "scalar" },
                { name: "LINE", kind: "table", fields: ["TDFORMAT", "TDLINE"] }
              ]
            })
            // An API fault is not proof of absence; the preceding index may be stale or unreadable.
            if (result.fault) {
              apiFaultName = /^[A-Z0-9_]{1,64}$/.test(result.fault.name)
                ? result.fault.name
                : "SOAP_FAULT"
              throw fail(result.fault.name === "NOT_AUTHORIZED" ? "NOT_AUTHORIZED" : "API_FAILED")
            }
            const head = z.record(z.string()).parse(result.outputs.HEAD)
            if (
              head.TDNAME?.trim() !== reference ||
              head.TDID?.trim() !== "HY" ||
              head.TDOBJECT?.trim() !== "DSYS" ||
              head.TDSPRAS?.trim() !== sapLanguage ||
              // DOKIL-VERSION is NUMC(4); THEAD-TDVERSION is NUMC(5).
              head.TDVERSION?.trim() !== index!.VERSION!.padStart(5, "0") ||
              result.outputs.DOKTYP !== "E"
            )
              throw fail("RESPONSE_SCOPE_MISMATCH")
            if (!Array.isArray(result.outputs.LINE) || result.outputs.LINE.length > input.maxLines)
              throw fail("LINE_LIMIT")
            const body = z
              .array(
                z.object({ TDFORMAT: z.string().max(2), TDLINE: z.string().max(132) }).strict()
              )
              .parse(result.outputs.LINE)
            return { head, body }
          }
          const first = await fetch(),
            second = await fetch()
          changed = JSON.stringify(first) !== JSON.stringify(second)
          if (!changed) {
            documentHead = first.head
            lines = first.body
            status = lines.length ? "read" : "empty"
          }
        }
      }
    }
  } catch (error) {
    code = codeOf(error)
    status = code.endsWith("LINE_LIMIT") ? "limit_exceeded" : "unavailable"
  }
  try {
    for (const check of checks)
      if (
        JSON.stringify(await read(check.table, check.fields, check.filters)) !==
        JSON.stringify(check.rows)
      )
        changed = true
    await verify()
    metadataRechecked = true
  } catch (error) {
    status = "unavailable"
    warnings.push("Metadata recheck failed: " + codeOf(error))
    code ??= codeOf(error)
    lines = null
    documentHead = null
  }
  if (changed) {
    status = code === null ? "changed" : "unavailable"
    code ??= "CONFIGURATION_DOCUMENTATION_CHANGED"
    lines = null
    documentHead = null
  }
  if (lines !== null)
    contentFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          activityId: input.activityId,
          reference,
          language,
          sapLanguage,
          index,
          documentHead,
          lines
        })
      )
      .digest("hex")
  return {
    connectionId: "w200",
    client,
    activityId: input.activityId,
    language,
    sapLanguage,
    status,
    code,
    apiFaultName,
    readOnly: true,
    saveAvailable: false,
    reference,
    index,
    documentHead,
    lines,
    contentFingerprint,
    coverage: {
      complete: false,
      documentClass: "HY",
      documentType: "E",
      versionSelection: "exact_DOKIL_indexed_version_not_active_version_attestation",
      languageFallback: false,
      linksResolved: false,
      rendered: false,
      contentTrust: "untrusted_documentation_data",
      maxLines: input.maxLines
    },
    evidence: {
      startedAt,
      finishedAt: new Date().toISOString(),
      sources,
      warnings,
      apiReads,
      valuesRechecked: lines !== null,
      metadataRechecked,
      snapshot: false
    },
    warnings: [
      "Only the IMG-linked SIMG standard end-user document is read. Other types, linked documents, images and dependency semantics are not resolved.",
      "DOCU_GET has no native pagination: indexed line count is checked before a whole-document call and returned size is checked afterwards; concurrent changes can exceed the preflight estimate. Sequential observations are not an atomic snapshot."
    ]
  }
}
