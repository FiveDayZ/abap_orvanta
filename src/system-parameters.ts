import { z } from "zod"
import type { SapBackend } from "./backend.js"
import {
  createReviewedTableReader,
  type ReviewedReaderSource,
  type ReviewedRow
} from "./reviewed-table-reader.js"

/**
 * Profile parameters and profile headers, read from the two tables the operator approved on
 * 2026-09-25 for this purpose (`TPFYPROPTY`, `TPFHT`).
 *
 * Column meanings are taken from the DDIC data elements of w200, not from the field names:
 *   TPFYPROPTY.OBJ_NAME  <- SOBJ_NAME   "对象目录中的对象名称"   (the row's key)
 *   TPFYPROPTY.PARANAME  <- PFEPARNAME  "描述文件参数名称"        (the profile parameter name)
 *   TPFYPROPTY.STR       <- PFESTR      "特殊参数值的字段"        (the stored value text)
 *   TPFHT.PFNAME         <- PFEPFNAME   "系统参数化参数文件名"    (the profile name)
 *   TPFHT.VERSNR         <- PFEVERSNR   "版本号"                 (the profile version)
 * `STR` is reported exactly as stored and is never interpreted: the data element describes it as the
 * field for special parameter values, so the tool publishes the text and its column, nothing more.
 *
 * Read path: the same reviewed reader the system-information tool uses - native data preview first,
 * then the fingerprint-checked `RFC_READ_TABLE` implementation, and no generic SQL fallback.
 */

export const SYSTEM_PARAMETERS_DEFAULT_ROWS = 200
/** The approved allowlist ceiling. A caller may ask for less, never for more. */
export const SYSTEM_PARAMETERS_MAX_ROWS = 500
/**
 * Longest filter value that still fits the reviewed reader: it caps each generated condition at
 * 68 characters, so `PARANAME = '<value>'` leaves 55 characters for the value itself.
 */
export const SYSTEM_PARAMETERS_FILTER_LIMIT = 55

const tables = {
  TPFYPROPTY: [
    "OBJ_NAME",
    "PARANAME",
    "STR",
    "TYPE",
    "GRP",
    "DESCR",
    "DYNAMIC",
    "OPSYS",
    "MUSR",
    "MDATE",
    "MTIME"
  ],
  TPFHT: [
    "PFNAME",
    "VERSNR",
    "PFFILE",
    "TXT",
    "OPSYS",
    "TYPE",
    "STATE",
    "CREFPF",
    "MUSR",
    "MDATE",
    "MTIME"
  ]
} as const
type Table = keyof typeof tables

function parameterFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : ""
  if (text.startsWith("SAP_DATA_QUERY_RESPONSE_INVALID:")) return "SAP_DATA_QUERY_RESPONSE_INVALID"
  switch (text) {
    case "SYSTEM_PARAMETERS_SCOPE_INVALID":
    case "SYSTEM_PARAMETERS_FALLBACK_UNVERIFIED":
    case "SYSTEM_PARAMETERS_NOT_AUTHORIZED":
    case "SYSTEM_PARAMETERS_RFC_FAILED":
    case "SYSTEM_PARAMETERS_RESPONSE_INVALID":
    case "SYSTEM_PARAMETERS_RESPONSE_SCOPE_MISMATCH":
    case "SYSTEM_PARAMETERS_AMBIGUOUS_RESULT":
      return text
    default:
      return "SYSTEM_PARAMETERS_QUERY_FAILED"
  }
}

export type SystemParametersOptions = {
  parameterName?: string | undefined
  objectName?: string | undefined
  profileName?: string | undefined
  maxRows?: number | undefined
}

export async function collectSystemParameters(
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  connectionId: string,
  options: SystemParametersOptions,
  readDefinition: () => Promise<unknown>
) {
  const requested = Math.floor(options.maxRows ?? SYSTEM_PARAMETERS_DEFAULT_ROWS)
  if (!Number.isFinite(requested) || requested < 1)
    throw new Error("SYSTEM_PARAMETERS_ROW_LIMIT_INVALID")
  const maximum = Math.min(requested, SYSTEM_PARAMETERS_MAX_ROWS)
  const sources: ReviewedReaderSource[] = []
  const queryWarnings: string[] = []
  const readTable = createReviewedTableReader(
    backend,
    connectionId,
    readDefinition,
    sources,
    queryWarnings
  )
  const read = (table: Table, filters: ReviewedRow) => {
    for (const value of Object.values(filters)) {
      if (value.length > SYSTEM_PARAMETERS_FILTER_LIMIT)
        throw new Error("SYSTEM_PARAMETERS_SCOPE_INVALID")
    }
    return readTable({
      table,
      fields: tables[table],
      filters,
      maximum,
      filterLengthLimit: SYSTEM_PARAMETERS_FILTER_LIMIT,
      codePrefix: "SYSTEM_PARAMETERS_",
      mapError: parameterFailure
    })
  }

  const parameterFilters: ReviewedRow = {}
  if (options.parameterName) parameterFilters.PARANAME = options.parameterName
  if (options.objectName) parameterFilters.OBJ_NAME = options.objectName
  const parameterRows = await read("TPFYPROPTY", parameterFilters)
  const parameters = (parameterRows ?? []).map((row) => ({
    objectName: row.OBJ_NAME!,
    parameterName: row.PARANAME!,
    value: row.STR!,
    valueColumn: "STR" as const,
    type: row.TYPE!,
    group: row.GRP!,
    description: row.DESCR!,
    dynamic: row.DYNAMIC!,
    operatingSystem: row.OPSYS!,
    changedBy: row.MUSR!,
    changedOn: row.MDATE!,
    changedAt: row.MTIME!
  }))

  const profileFilters: ReviewedRow = options.profileName ? { PFNAME: options.profileName } : {}
  const profileRows = await read("TPFHT", profileFilters)
  const profiles = (profileRows ?? []).map((row) => ({
    profileName: row.PFNAME!,
    version: row.VERSNR!,
    fileName: row.PFFILE!,
    text: row.TXT!,
    operatingSystem: row.OPSYS!,
    type: row.TYPE!,
    state: row.STATE!,
    createdFrom: row.CREFPF!,
    changedBy: row.MUSR!,
    changedOn: row.MDATE!,
    changedAt: row.MTIME!
  }))

  const sourceOf = (table: Table) => sources.find((item) => item.table === table)
  const failed = sources.filter(
    (item) => item.status === "unavailable" || item.status === "invalid"
  )
  const truncated = sources.filter((item) => item.status === "truncated")
  const status =
    failed.length === sources.length
      ? "unavailable"
      : failed.length || truncated.length
        ? "partial"
        : "ok"
  return {
    status,
    connectionId,
    readOnly: true,
    filters: {
      parameterName: options.parameterName ?? null,
      objectName: options.objectName ?? null,
      profileName: options.profileName ?? null
    },
    rowLimit: maximum,
    rowLimitRequested: requested,
    rowLimitApplied: requested > SYSTEM_PARAMETERS_MAX_ROWS,
    filterValueLimit: SYSTEM_PARAMETERS_FILTER_LIMIT,
    parameterCount: parameters.length,
    parametersTruncated: sourceOf("TPFYPROPTY")?.status === "truncated",
    profilesTruncated: sourceOf("TPFHT")?.status === "truncated",
    parameters,
    profiles,
    profileCount: profiles.length,
    notes: [
      "Values are reported as stored in TPFYPROPTY.STR and are never interpreted.",
      "A filtered read is exact and case-sensitive; the value must not exceed " +
        `${SYSTEM_PARAMETERS_FILTER_LIMIT} characters.`,
      "Without a filter the read is bounded by rowLimit, so a truncated answer lists a prefix only."
    ],
    sources,
    queryTimestamp: new Date().toISOString(),
    queryWarnings
  }
}

/** Shape guard reused by the tests: every row of a parameters answer carries these fields. */
export const systemParametersRow = z.object({
  objectName: z.string(),
  parameterName: z.string(),
  value: z.string(),
  valueColumn: z.literal("STR")
})
