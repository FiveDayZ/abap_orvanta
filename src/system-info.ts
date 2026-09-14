import { z } from "zod"
import type { SapBackend } from "./backend.js"

const tables = {
  T000: ["MANDT", "MTEXT", "CCCATEGORY", "LOGSYS", "CCNOCLIIND"],
  CVERS: ["COMPONENT", "RELEASE", "EXTRELEASE", "COMP_TYPE"],
  TTZCU: ["CLIENT", "TZONESYS", "FLAGACTIVE"],
  TTZZ: ["CLIENT", "TZONE", "ZONERULE", "DSTRULE"],
  TTZR: ["CLIENT", "ZONERULE", "UTCDIFF", "UTCSIGN"],
  TTZZT: ["CLIENT", "LANGU", "TZONE", "DESCRIPT"]
} as const
type Table = keyof typeof tables
type Row = Record<string, string>
type Source = {
  table: Table
  status: "ok" | "empty" | "unavailable" | "truncated" | "invalid"
  method: "adt_query" | "rfc_read_table"
  returnedCount: number
  code?: string
  nativeCode?: string
}

export const reviewedTableReaderDefinition = z.object({
  functionName: z.literal("RFC_READ_TABLE"),
  remoteEnabled: z.literal(true),
  updateTask: z.literal(false),
  sourceFingerprint: z.literal("7b9a603493673d26f75e555616b24d150e407ce03eff57e9c68f0b30b1ba0c2d"),
  interfaceFingerprint: z.literal(
    "d06cc5c1ce05960bde526ecf27e38606134146474cc8da19f93ac2abd3e48074"
  )
})

function queryFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : ""
  if (text.startsWith("SAP_DATA_QUERY_RESPONSE_INVALID:")) return "SAP_DATA_QUERY_RESPONSE_INVALID"
  switch (text) {
    case "SYSTEM_INFO_SCOPE_INVALID":
    case "SYSTEM_INFO_FALLBACK_UNVERIFIED":
    case "SYSTEM_INFO_NOT_AUTHORIZED":
    case "SYSTEM_INFO_RFC_FAILED":
    case "SYSTEM_INFO_RESPONSE_INVALID":
    case "SYSTEM_INFO_RESPONSE_SCOPE_MISMATCH":
    case "SYSTEM_INFO_AMBIGUOUS_RESULT":
    case "SYSTEM_INFO_COMPONENTS_INVALID":
      return text
    default:
      return "SYSTEM_INFO_QUERY_FAILED"
  }
}

export async function collectSystemInfo(
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  connectionId: string,
  client: string,
  readDefinition: () => Promise<unknown>
) {
  if (!/^\d{3}$/.test(client)) throw new Error("SYSTEM_INFO_CLIENT_INVALID")
  const sources: Source[] = []
  const queryWarnings: string[] = []
  let reviewed: Promise<unknown> | undefined
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
  const read = async (table: Table, filters: Row, maximum = 1): Promise<Row[] | null> => {
    const fields = tables[table]
    const source: Source = { table, status: "unavailable", method: "adt_query", returnedCount: 0 }
    sources.push(source)
    try {
      const conditions = Object.entries(filters).map(([name, value]) => {
        if (!(fields as readonly string[]).includes(name) || value.length > 30)
          throw new Error("SYSTEM_INFO_SCOPE_INVALID")
        const condition = `${name} = ${literal(value)}`
        if (condition.length > 68) throw new Error("SYSTEM_INFO_SCOPE_INVALID")
        return condition
      })
      let rows: Record<string, unknown>[]
      try {
        rows = await backend.runQuery(
          connectionId,
          `SELECT ${fields.join(", ")} FROM ${table}${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""}`,
          maximum + 1
        )
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !==
            "SAP_DATA_QUERY_RESPONSE_INVALID: expected XML data preview; HTTP 200; mediaType=text/html; root=unparsed; bytes=0. No empty result was inferred."
        )
          throw error
        source.nativeCode = "SAP_DATA_QUERY_RESPONSE_INVALID"
        source.method = "rfc_read_table"
        // Only the reviewed legacy read implementation is allowed; no generic SQL fallback.
        reviewed ??= readDefinition().then((definition) => {
          if (!reviewedTableReaderDefinition.safeParse(definition).success)
            throw new Error("SYSTEM_INFO_FALLBACK_UNVERIFIED")
        })
        await reviewed
        const result = await backend.callRemoteFunction(connectionId, {
          functionName: "RFC_READ_TABLE",
          inputParameters: {
            QUERY_TABLE: table,
            DELIMITER: "|",
            NO_DATA: "",
            ROWSKIPS: "0",
            ROWCOUNT: String(maximum + 1),
            OPTIONS: conditions.map((condition, index) => ({
              TEXT: `${index ? "AND " : ""}${condition}`
            })),
            FIELDS: fields.map((FIELDNAME) => ({ FIELDNAME })),
            DATA: []
          },
          outputParameters: [
            { name: "FIELDS", kind: "table", fields: ["FIELDNAME"] },
            { name: "DATA", kind: "table", fields: ["WA"] }
          ]
        })
        if (result.fault) {
          throw new Error(
            result.fault.name === "NOT_AUTHORIZED"
              ? "SYSTEM_INFO_NOT_AUTHORIZED"
              : "SYSTEM_INFO_RFC_FAILED"
          )
        }
        const metadata = result.outputs.FIELDS
        const data = result.outputs.DATA
        if (
          !Array.isArray(metadata) ||
          !Array.isArray(data) ||
          metadata.length !== fields.length ||
          metadata.some((field, index) => field.FIELDNAME !== fields[index]) ||
          data.length > maximum + 1
        )
          throw new Error("SYSTEM_INFO_RESPONSE_INVALID")
        rows = data.map((row) => {
          if (typeof row.WA !== "string" || row.WA.length > 512)
            throw new Error("SYSTEM_INFO_RESPONSE_INVALID")
          const values = row.WA.split("|")
          if (values.length !== fields.length) throw new Error("SYSTEM_INFO_RESPONSE_INVALID")
          return Object.fromEntries(fields.map((field, index) => [field, values[index]!.trim()]))
        })
      }
      if (!Array.isArray(rows) || rows.length > maximum + 1)
        throw new Error("SYSTEM_INFO_RESPONSE_INVALID")
      const schema = z.object(
        Object.fromEntries(fields.map((field) => [field, z.string().max(512)]))
      )
      const parsed = rows.map((row) => {
        const value = schema.safeParse(row)
        if (!value.success) throw new Error("SYSTEM_INFO_RESPONSE_INVALID")
        const record = Object.fromEntries(
          Object.entries(value.data).map(([key, cell]) => [key, cell.trim()])
        )
        if (Object.entries(filters).some(([key, expected]) => record[key] !== expected))
          throw new Error("SYSTEM_INFO_RESPONSE_SCOPE_MISMATCH")
        return record
      })
      if (maximum === 1 && parsed.length > 1) throw new Error("SYSTEM_INFO_AMBIGUOUS_RESULT")
      if (table === "CVERS") {
        const names = parsed.map((row) => row.COMPONENT)
        if (names.some((name) => !name) || new Set(names).size !== names.length)
          throw new Error("SYSTEM_INFO_COMPONENTS_INVALID")
      }
      source.returnedCount = Math.min(parsed.length, maximum)
      source.status = parsed.length > maximum ? "truncated" : parsed.length ? "ok" : "empty"
      if (source.status !== "ok") queryWarnings.push(`${table}: ${source.status}`)
      return parsed.slice(0, maximum)
    } catch (error) {
      source.code = queryFailure(error)
      queryWarnings.push(`${table}: ${source.code}`)
      return null
    }
  }

  const clientRows = await read("T000", { MANDT: client })
  const current = clientRows?.[0]
  const currentClient = current
    ? {
        clientNumber: current.MANDT!,
        clientName: current.MTEXT!,
        category: current.CCCATEGORY!,
        logicalSystem: current.LOGSYS!,
        changeProtection: current.CCNOCLIIND!
      }
    : null
  const componentRows = await read("CVERS", {}, 500)
  const softwareComponents = (componentRows ?? [])
    .map((row) => ({
      component: row.COMPONENT!,
      release: row.RELEASE!,
      extRelease: row.EXTRELEASE!,
      componentType: row.COMP_TYPE!
    }))
    .sort((a, b) => a.component.localeCompare(b.component))
  const componentsComplete = sources.find((source) => source.table === "CVERS")?.status === "ok"
  const has = (name: string) => softwareComponents.some((item) => item.component === name)
  const systemType =
    has("S4CORE") || has("S4COREOP")
      ? "S/4HANA"
      : componentsComplete && has("SAP_APPL")
        ? "ECC"
        : "Unknown"
  const sapRelease =
    softwareComponents.find((item) => item.component === "SAP_BASIS")?.release ?? ""
  if (!sapRelease) queryWarnings.push("SAP_BASIS: release unavailable")

  let timezone: null | {
    timezone: string
    description: string
    utcOffset: string
    dstRule: string
    rawOffset: string
    offsetKind: "standard_time"
  } = null
  const config = (await read("TTZCU", { CLIENT: client, FLAGACTIVE: "X" }))?.[0]
  if (config?.TZONESYS) {
    const zone = (await read("TTZZ", { CLIENT: client, TZONE: config.TZONESYS }))?.[0]
    if (zone?.ZONERULE) {
      const rule = (await read("TTZR", { CLIENT: client, ZONERULE: zone.ZONERULE }))?.[0]
      if (rule) {
        if (
          !/^[+-]$/.test(rule.UTCSIGN!) ||
          !/^(?:[01]\d|2[0-3])[0-5]\d[0-5]\d$/.test(rule.UTCDIFF!)
        ) {
          const source = sources.find((item) => item.table === "TTZR")!
          source.status = "invalid"
          source.code = "SYSTEM_INFO_OFFSET_INVALID"
          queryWarnings.push("TTZR: SYSTEM_INFO_OFFSET_INVALID")
        } else {
          const text = (
            await read("TTZZT", { CLIENT: client, LANGU: "E", TZONE: config.TZONESYS })
          )?.[0]
          const hours = Number(rule.UTCDIFF!.slice(0, 2))
          const minutes = rule.UTCDIFF!.slice(2, 4)
          const seconds = rule.UTCDIFF!.slice(4, 6)
          timezone = {
            timezone: config.TZONESYS,
            description: text?.DESCRIPT ?? "",
            utcOffset: `UTC${rule.UTCSIGN}${hours}${minutes !== "00" || seconds !== "00" ? `:${minutes}` : ""}${seconds !== "00" ? `:${seconds}` : ""}`,
            dstRule: zone.DSTRULE!,
            rawOffset: zone.ZONERULE,
            offsetKind: "standard_time"
          }
        }
      }
    }
  }
  return {
    status:
      !currentClient && !softwareComponents.length && !timezone
        ? "unavailable"
        : sources.every((source) => source.status === "ok") &&
            sapRelease &&
            timezone &&
            !queryWarnings.length
          ? "ok"
          : "partial",
    connectionId,
    configuredClient: client,
    readOnly: true,
    sapRelease,
    releaseSource: sapRelease ? "CVERS.SAP_BASIS.RELEASE" : null,
    systemType,
    currentClient,
    softwareComponents,
    componentsComplete,
    timezone,
    sources,
    queryTimestamp: new Date().toISOString(),
    queryWarnings
  }
}
