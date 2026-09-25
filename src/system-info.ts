import {
  createReviewedTableReader,
  reviewedTableReaderDefinition,
  type ReviewedReaderSource
} from "./reviewed-table-reader.js"
import type { SapBackend } from "./backend.js"

export { reviewedTableReaderDefinition }

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
type Source = ReviewedReaderSource

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
  const readTable = createReviewedTableReader(
    backend,
    connectionId,
    readDefinition,
    sources,
    queryWarnings
  )
  // The shape of the old closure is kept so every call site below stays unchanged; the CVERS
  // component-name rule is the only table-specific check and now travels as the validator.
  const read = (table: Table, filters: Row, maximum = 1): Promise<Row[] | null> =>
    readTable({
      table,
      fields: tables[table],
      filters,
      maximum,
      codePrefix: "SYSTEM_INFO_",
      mapError: queryFailure,
      validate: (rows) => {
        if (table !== "CVERS") return
        const names = rows.map((row) => row.COMPONENT)
        if (names.some((name) => !name) || new Set(names).size !== names.length)
          throw new Error("SYSTEM_INFO_COMPONENTS_INVALID")
      }
    })

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
