import { z } from "zod"
import type { SapBackend } from "./backend.js"

/**
 * The kernel's own system information, read through `RFC_SYSTEM_INFO`.
 *
 * Why this exists: `get_sap_system_info` reads six fixed tables, and none of them carries the kernel
 * release. The RFC structure `RFCSI` does, and it is the only standard, database-agnostic source the
 * service can reach on this release (there is no native ADT endpoint for it).
 *
 * What is interpreted, and what is not: only four fields are lifted out of the structure, and each
 * one is backed by the DDIC data element of the field itself, read from w200 rather than assumed:
 *   RFCKERNRL <- SYKERNRL  "内核版本"          (kernel release)
 *   RFCSAPRL  <- SYSAPRL   "SAP 系统的版本状态"  (SAP release)
 *   RFCDBSYS  <- SYDBSYS   "中央数据库系统"      (central database system)
 *   RFCSYSID  <- SYSYSID   "SAP 系统名称"        (SAP system name)
 * **`RFCDATABS` is deliberately *not* interpreted as the database release.** Its data element on this
 * release is `SYSYSID` - the same one `RFCSYSID` uses, i.e. "SAP system name" - so the metadata does
 * not support the reading its name suggests. The whole structure is returned verbatim in `rfci`, and
 * the database *release* stays an open item rather than a guessed label.
 */

const RFCI_FIELDS = [
  "RFCPROTO",
  "RFCCHARTYP",
  "RFCINTTYP",
  "RFCFLOTYP",
  "RFCDEST",
  "RFCHOST",
  "RFCSYSID",
  "RFCDATABS",
  "RFCDBHOST",
  "RFCDBSYS",
  "RFCSAPRL",
  "RFCMACH",
  "RFCOPSYS",
  "RFCTZONE",
  "RFCDAYST",
  "RFCIPADDR",
  "RFCKERNRL",
  "RFCHOST2",
  "RFCSI_RESV",
  "RFCIPV6ADDR"
] as const

/** Fingerprints of the deployed reader, taken from w200 on 2026-09-25. */
export const reviewedServerInfoDefinition = z.object({
  functionName: z.literal("RFC_SYSTEM_INFO"),
  remoteEnabled: z.literal(true),
  updateTask: z.literal(false),
  sourceFingerprint: z.literal("5c2431d92d424a243fd5d283b3dd592ab7b5c00384cf65977e8eb0bd0410b33e"),
  interfaceFingerprint: z.literal(
    "cfd8b63dbdb6fa990a83153590dc8195f05dad49f2a6b9fabd68106955579896"
  )
})

export type ServerFactsSource = {
  table: "RFC_SYSTEM_INFO"
  status: "ok" | "unavailable" | "invalid"
  method: "rfc_call"
  returnedCount: number
  code?: string
}

/** Fields whose meaning the DDIC data elements support, exposed as named properties. */
const INTERPRETED = {
  kernelRelease: "RFCKERNRL",
  sapRelease: "RFCSAPRL",
  databaseSystem: "RFCDBSYS",
  systemId: "RFCSYSID",
  applicationServer: "RFCHOST2",
  operatingSystem: "RFCOPSYS",
  timeZone: "RFCTZONE"
} as const

function serverFactsFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : ""
  switch (text) {
    case "SERVER_FACTS_FALLBACK_UNVERIFIED":
    case "SERVER_FACTS_NOT_AUTHORIZED":
    case "SERVER_FACTS_RFC_FAILED":
    case "SERVER_FACTS_RESPONSE_INVALID":
    case "SERVER_FACTS_RESPONSE_EMPTY":
      return text
    default:
      return "SERVER_FACTS_CALL_FAILED"
  }
}

export async function collectServerFacts(
  backend: Pick<SapBackend, "callRemoteFunction">,
  connectionId: string,
  readDefinition: () => Promise<unknown>
) {
  const source: ServerFactsSource = {
    table: "RFC_SYSTEM_INFO",
    status: "unavailable",
    method: "rfc_call",
    returnedCount: 0
  }
  const queryWarnings: string[] = []
  const notes = [
    "RFCDATABS is returned verbatim only: its data element on this release is SYSYSID, the same one " +
      "RFCSYSID uses, so it is not read as a database release."
  ]
  let rfci: Record<string, string> | null = null
  try {
    if (!reviewedServerInfoDefinition.safeParse(await readDefinition()).success)
      throw new Error("SERVER_FACTS_FALLBACK_UNVERIFIED")
    const result = await backend.callRemoteFunction(connectionId, {
      functionName: "RFC_SYSTEM_INFO",
      inputParameters: {},
      outputParameters: [{ name: "RFCSI_EXPORT", kind: "structure", fields: [...RFCI_FIELDS] }]
    })
    if (result.fault) {
      throw new Error(
        result.fault.name === "NOT_AUTHORIZED"
          ? "SERVER_FACTS_NOT_AUTHORIZED"
          : "SERVER_FACTS_RFC_FAILED"
      )
    }
    const raw = result.outputs.RFCSI_EXPORT
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("SERVER_FACTS_RESPONSE_INVALID")
    const schema = z.object(
      Object.fromEntries(RFCI_FIELDS.map((field) => [field, z.string().max(128).optional()]))
    )
    const parsed = schema.safeParse(raw)
    if (!parsed.success) throw new Error("SERVER_FACTS_RESPONSE_INVALID")
    const record = Object.fromEntries(
      RFCI_FIELDS.map((field) => [field, (parsed.data[field] ?? "").trim()])
    )
    if (!record.RFCSYSID && !record.RFCSAPRL) throw new Error("SERVER_FACTS_RESPONSE_EMPTY")
    rfci = record
    source.status = "ok"
    source.returnedCount = Object.values(record).filter(Boolean).length
  } catch (error) {
    source.code = serverFactsFailure(error)
    if (source.code === "SERVER_FACTS_RESPONSE_INVALID") source.status = "invalid"
    queryWarnings.push(`RFC_SYSTEM_INFO: ${source.code}`)
  }
  const read = (field: (typeof INTERPRETED)[keyof typeof INTERPRETED]) => rfci?.[field] ?? ""
  return {
    status: rfci ? ("ok" as const) : ("unavailable" as const),
    connectionId,
    readOnly: true,
    rfciSource: rfci ? "RFC_SYSTEM_INFO.RFCSI_EXPORT" : null,
    kernelRelease: read(INTERPRETED.kernelRelease),
    sapRelease: read(INTERPRETED.sapRelease),
    databaseSystem: read(INTERPRETED.databaseSystem),
    systemId: read(INTERPRETED.systemId),
    applicationServer: read(INTERPRETED.applicationServer),
    operatingSystem: read(INTERPRETED.operatingSystem),
    timeZone: read(INTERPRETED.timeZone),
    interpretedFields: { ...INTERPRETED },
    rfci,
    notes,
    sources: [source],
    queryTimestamp: new Date().toISOString(),
    queryWarnings
  }
}
