import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import { configurationBcSetSchema, configurationBcSetLayouts } from "./configuration-bc-set.js"
import {
  createReviewedTableReader,
  type ReviewedRow,
  type ReviewedReaderSource
} from "./reviewed-table-reader.js"

const scope = configurationBcSetSchema
  .pick({ connectionId: true, bcSetId: true })
  .extend({ version: z.literal("N") })
export const configurationBcDependenciesSchema = scope
  .extend({
    maxNodes: z.number().int().min(1).max(20).default(10),
    maxDepth: z.number().int().min(0).max(4).default(3),
    maxChildren: z.number().int().min(2).max(16).default(8)
  })
  .strict()
export const configurationBcLogsSchema = scope
  .extend({
    maxReferences: z.number().int().min(2).max(100).default(25),
    maxActivations: z.number().int().min(1).max(10).default(5)
  })
  .strict()
export const configurationBcAuditLayouts = {
  SCPRATTR: configurationBcSetLayouts.SCPRATTR,
  SCPRPPRL: configurationBcSetLayouts.SCPRPPRL,
  SCPRACPM: "149a789510117f3d139bcc843fc81a89d6799e3e6034e58221d850b7cb351663",
  SCPRACPP: "1ff356ca4b41d8a6580902d47965b688296e50b98998914a36c9c4fe0e3b116a"
} as const
export const configurationBcAuditFunctions = {
  SCPR_PRSET_DB_SUBP_GET_DETAIL: [
    "4c8a9e808b40cda69984a538a6c3d19f51b293898a746f09aa3c29fcf5ce1486",
    "bec2b315680140acd7665120a418718c56e6f87c59272ae70f83f3e7a0168a15"
  ],
  SCPR_GET_ACTIVATION_STATUS: [
    "df19b913e5b12cbb17beadb2f99c003179cd64da41b8c64d92097fe3a644fa17",
    "1b7fe110007ea4e6b38fadfa73a95f604ea962a1dae334d2bbbd69edf00e06c3"
  ],
  SCPR_PR_DB_GET_DATA_ACPP: [
    "00c385cc423830460c7c38eb66b47282d0639b2215d242f8d130446523aec145",
    "c65102bdb9a128dc20de2125de235f36051be54121c7ba239d7e689719db73e5"
  ]
} as const
export const configurationBcAuditFields = {
  SCPRATTR: ["ID", "VERSION", "CATEGORY", "TYPE", "MODDATE", "MODTIME"],
  SCPRPPRL: ["ID", "VERSION", "SUBPROFILE", "PROF_POSIT"],
  SCPRACPM: [
    "ACT_ID",
    "LINE_NR",
    "BCSET_ID",
    "PARENT_ID",
    "OBJECTNAME",
    "OBJECTTYPE",
    "MSGID",
    "MSGTY",
    "MSGNO",
    "VAR1",
    "VAR2",
    "VAR3",
    "VAR4",
    "PROTOFLAG"
  ],
  SCPRACPP: [
    "ACT_ID",
    "ACT_DATE",
    "ACT_TIME",
    "SYSID",
    "T_SID",
    "T_MANDT",
    "SIM_TYPE",
    "TRNO_SYST",
    "TRNO_CUST"
  ]
} as const
type Table = keyof typeof configurationBcAuditLayouts
const id = /^[A-Z0-9_/]{1,32}$/
const canonical = (rows: ReviewedRow[]) => JSON.stringify(rows.map((r) => JSON.stringify(r)).sort())

// Both audits use the existing guarded reader, and repeat every selected slice, including empty reads.
async function auditReader(
  connectionId: string,
  client: string,
  tables: Table[],
  functions: (keyof typeof configurationBcAuditFunctions)[],
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  readTable: (name: string) => Promise<unknown>,
  readFunction: (name: string) => Promise<unknown>
) {
  if (connectionId !== "w200" || client !== "200") throw Error("BC_AUDIT_SCOPE_UNSUPPORTED")
  const startedAt = new Date().toISOString(),
    sources: ReviewedReaderSource[] = [],
    warnings: string[] = []
  const verify = async () => {
    for (const table of tables)
      if (
        !z
          .object({
            connectionId: z.literal("w200"),
            objectName: z.literal(table),
            objectKind: z.literal("transparentTable"),
            fingerprint: z.literal(configurationBcAuditLayouts[table])
          })
          .safeParse(await readTable(table)).success
      )
        throw Error("BC_AUDIT_LAYOUT_UNVERIFIED")
    for (const name of functions) {
      const [sourceFingerprint, interfaceFingerprint] = configurationBcAuditFunctions[name]
      if (
        !z
          .object({
            functionName: z.literal(name),
            remoteEnabled: z.literal(false),
            updateTask: z.literal(false),
            sourceFingerprint: z.literal(sourceFingerprint),
            interfaceFingerprint: z.literal(interfaceFingerprint)
          })
          .safeParse(await readFunction(name)).success
      )
        throw Error("BC_AUDIT_SOURCE_UNVERIFIED")
    }
  }
  await verify()
  const reader = createReviewedTableReader(
    backend,
    connectionId,
    () => readFunction("RFC_READ_TABLE"),
    sources,
    warnings
  )
  const reads: { table: Table; filters: ReviewedRow; maximum: number; rows: ReviewedRow[] }[] = []
  const read = async (table: Table, filters: ReviewedRow, maximum: number) => {
    const rows = await reader({
      table,
      fields: configurationBcAuditFields[table],
      filters,
      maximum,
      filterLengthLimit: 32,
      codePrefix: "BC_AUDIT_",
      mapError: () => "BC_AUDIT_QUERY_FAILED",
      validate: (rows) => {
        const keys = new Set<string>()
        for (const r of rows) {
          const key =
            table === "SCPRACPM"
              ? JSON.stringify([r.ACT_ID, r.LINE_NR])
              : table === "SCPRPPRL"
                ? r.SUBPROFILE!
                : table === "SCPRATTR"
                  ? r.ID!
                  : r.ACT_ID!
          if (keys.has(key)) throw Error("BC_AUDIT_DUPLICATE_KEY")
          keys.add(key)
          if (table === "SCPRATTR" && !id.test(r.ID!)) throw Error("BC_AUDIT_ROW_INVALID")
          if (
            table === "SCPRPPRL" &&
            (!id.test(r.SUBPROFILE!) || !/^\d{1,10}$/.test(r.PROF_POSIT!))
          )
            throw Error("BC_AUDIT_ROW_INVALID")
          if ((table === "SCPRACPM" || table === "SCPRACPP") && !/^[A-F0-9]{32}$/.test(r.ACT_ID!))
            throw Error("BC_AUDIT_ROW_INVALID")
          if (
            table === "SCPRACPM" &&
            (!/^\d{1,10}$/.test(r.LINE_NR!) ||
              (r.BCSET_ID && !id.test(r.BCSET_ID)) ||
              (r.PARENT_ID && !id.test(r.PARENT_ID)))
          )
            throw Error("BC_AUDIT_ROW_INVALID")
        }
      }
    })
    if (rows !== null) reads.push({ table, filters, maximum, rows })
    return rows
  }
  return {
    read,
    finish: async () => {
      let changed = false,
        unavailable = sources.some((s) => ["unavailable", "invalid"].includes(s.status))
      for (const item of reads) {
        const repeated = await reader({
          table: item.table,
          fields: configurationBcAuditFields[item.table],
          filters: item.filters,
          maximum: item.maximum,
          filterLengthLimit: 32,
          codePrefix: "BC_AUDIT_",
          mapError: () => "BC_AUDIT_QUERY_FAILED"
        })
        if (repeated === null) unavailable = true
        else if (canonical(repeated) !== canonical(item.rows)) changed = true
      }
      await verify()
      const truncated = sources.some((s) => s.status === "truncated")
      return {
        changed,
        unavailable,
        truncated,
        fingerprint:
          changed || unavailable || truncated
            ? null
            : createHash("sha256")
                .update(JSON.stringify(reads.map((r) => ({ ...r, rows: canonical(r.rows) }))))
                .digest("hex"),
        evidence: {
          startedAt,
          finishedAt: new Date().toISOString(),
          sources,
          warnings,
          definitionsRechecked: true,
          valuesRechecked: true,
          snapshot: false
        }
      }
    }
  }
}

export async function readConfigurationBcDependencies(
  raw: unknown,
  client: string,
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  readTable: (name: string) => Promise<unknown>,
  readFunction: (name: string) => Promise<unknown>
) {
  const input = configurationBcDependenciesSchema.parse(raw)
  const audit = await auditReader(
    input.connectionId,
    client,
    ["SCPRATTR", "SCPRPPRL"],
    ["SCPR_PRSET_DB_SUBP_GET_DETAIL"],
    backend,
    readTable,
    readFunction
  )
  const nodes: { id: string; depth: number; status: string; header: ReviewedRow | null }[] = []
  const edges: { parent: string; child: string; position: string }[] = [],
    frontier: { id: string; reason: string }[] = []
  const queue = [{ id: input.bcSetId, depth: 0 }],
    discovered = new Set([input.bcSetId])
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i]!,
      filters = { ID: item.id, VERSION: input.version }
    const header = await audit.read("SCPRATTR", filters, 1)
    const status =
      header === null
        ? "unavailable"
        : !header.length
          ? "missing_selected_version"
          : header[0]!.CATEGORY !== ""
            ? "unsupported_category"
            : "read"
    nodes.push({ ...item, status, header: header?.[0] ?? null })
    if (status !== "read") continue
    const children = await audit.read("SCPRPPRL", filters, input.maxChildren)
    if (children === null) {
      frontier.push({ id: item.id, reason: "dependencies_unavailable" })
      continue
    }
    children.sort((a, b) =>
      BigInt(a.PROF_POSIT!) < BigInt(b.PROF_POSIT!)
        ? -1
        : BigInt(a.PROF_POSIT!) > BigInt(b.PROF_POSIT!)
          ? 1
          : a.SUBPROFILE!.localeCompare(b.SUBPROFILE!)
    )
    for (const row of children) {
      edges.push({ parent: item.id, child: row.SUBPROFILE!, position: row.PROF_POSIT! })
      if (discovered.has(row.SUBPROFILE!)) continue
      if (item.depth >= input.maxDepth || queue.length >= input.maxNodes) {
        frontier.push({
          id: row.SUBPROFILE!,
          reason: item.depth >= input.maxDepth ? "depth_limit" : "node_limit"
        })
        continue
      }
      discovered.add(row.SUBPROFILE!)
      queue.push({ id: row.SUBPROFILE!, depth: item.depth + 1 })
    }
  }
  // Detect cycles in the observed graph, including edges between previously visited branches.
  const cycles: string[][] = [],
    visited = new Set<string>()
  const walk = (node: string, path: string[]) => {
    const at = path.indexOf(node)
    if (at >= 0) {
      cycles.push([...path.slice(at), node])
      return
    }
    if (visited.has(node)) return
    visited.add(node)
    for (const edge of edges.filter((e) => e.parent === node)) walk(edge.child, [...path, node])
  }
  walk(input.bcSetId, [])
  const checked = await audit.finish(),
    rejected = checked.changed || checked.unavailable
  const graphComplete =
    !rejected && !checked.truncated && !frontier.length && nodes.every((n) => n.status === "read")
  return {
    ...input,
    client,
    status: checked.unavailable
      ? "unavailable"
      : checked.changed
        ? "changed"
        : nodes[0]?.status === "missing_selected_version"
          ? "not_found"
          : "partial",
    readOnly: true,
    activationAvailable: false,
    saveAvailable: false,
    nodes: rejected ? null : nodes,
    edges: rejected ? null : edges,
    cycles: rejected ? null : cycles,
    frontier: rejected ? null : frontier,
    readFingerprint: graphComplete ? checked.fingerprint : null,
    coverage: {
      complete: false,
      observedGraphComplete: graphComplete,
      version: "N_only",
      truncated: checked.truncated,
      missingSelectedVersion: rejected
        ? null
        : nodes.filter((n) => n.status === "missing_selected_version").map((n) => n.id),
      activationOrderResolved: false,
      targetTableImpact: "not_read",
      reverseDependencies: "not_read"
    },
    evidence: checked.evidence,
    warnings: [
      "Stored N-version child references only. PROF_POSIT is preserved; the graph is not a resolved activation order or target-table impact plan. Missing selected-version headers are not proof that every version is absent. Switch categories are not traversed; node/depth/row limits and cycles remain explicit."
    ]
  }
}

export async function readConfigurationBcLogs(
  raw: unknown,
  client: string,
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  readTable: (name: string) => Promise<unknown>,
  readFunction: (name: string) => Promise<unknown>
) {
  const input = configurationBcLogsSchema.parse(raw)
  const audit = await auditReader(
    input.connectionId,
    client,
    ["SCPRATTR", "SCPRACPM", "SCPRACPP"],
    ["SCPR_GET_ACTIVATION_STATUS", "SCPR_PR_DB_GET_DATA_ACPP"],
    backend,
    readTable,
    readFunction
  )
  const header = await audit.read("SCPRATTR", { ID: input.bcSetId, VERSION: input.version }, 1)
  const classic = header?.[0]?.CATEGORY === ""
  const direct = classic
    ? await audit.read("SCPRACPM", { BCSET_ID: input.bcSetId }, input.maxReferences)
    : null
  const parent = classic
    ? await audit.read("SCPRACPM", { PARENT_ID: input.bcSetId }, input.maxReferences)
    : null
  const selected = new Map<string, ReviewedRow>(),
    conflicts: string[] = []
  for (const row of [...(direct ?? []), ...(parent ?? [])]) {
    const key = JSON.stringify([row.ACT_ID, row.LINE_NR])
    if (selected.has(key) && canonical([selected.get(key)!]) !== canonical([row]))
      conflicts.push(key)
    selected.set(key, row)
  }
  const ids = [...new Set([...selected.values()].map((r) => r.ACT_ID!))].sort()
  const activations: {
    activationId: string
    status: string
    header: ReviewedRow | null
    messages: ReviewedRow[] | null
  }[] = []
  for (const activationId of ids.slice(0, input.maxActivations)) {
    // These tables have no client key. An explicit recorded target client filter is mandatory.
    const headers = await audit.read("SCPRACPP", { ACT_ID: activationId, T_MANDT: client }, 1)
    activations.push({
      activationId,
      status:
        headers === null
          ? "unavailable"
          : !headers.length
            ? "no_header_for_recorded_target_client"
            : "historical_reference",
      header: headers?.[0] ?? null,
      messages: headers?.length
        ? [...selected.values()]
            .filter((r) => r.ACT_ID === activationId)
            .sort((a, b) =>
              BigInt(a.LINE_NR!) < BigInt(b.LINE_NR!)
                ? -1
                : BigInt(a.LINE_NR!) > BigInt(b.LINE_NR!)
                  ? 1
                  : 0
            )
        : null
    })
  }
  const checked = await audit.finish(),
    rejected = checked.changed || checked.unavailable || conflicts.length > 0
  const truncated = checked.truncated || ids.length > input.maxActivations
  return {
    ...input,
    client,
    status: rejected
      ? checked.changed || conflicts.length
        ? "changed"
        : "unavailable"
      : header?.length === 0
        ? "not_found"
        : !classic
          ? "unsupported_category"
          : truncated
            ? "partial"
            : !ids.length
              ? "no_selected_references"
              : "partial",
    readOnly: true,
    activationAvailable: false,
    saveAvailable: false,
    activations: rejected ? null : activations,
    unexpandedActivationIds: rejected ? null : ids.slice(input.maxActivations),
    readFingerprint: rejected || truncated || !classic ? null : checked.fingerprint,
    coverage: {
      complete: false,
      truncated,
      currentHeaderVersion: "N",
      historicalVersionResolved: false,
      recordedTargetClient: client,
      targetSystemVerified: false,
      selectedMessagesOnly: true,
      allProcessMessagesRead: false,
      completionStatusDerived: false,
      latestActivationProven: false,
      renderedMessageText: false,
      switchStorage: "not_read"
    },
    evidence: checked.evidence,
    warnings: [
      "Historical classic SCPRACPM references selected by BCSET_ID or PARENT_ID, not activation success or current configuration. No history version field is available here. Only headers recording target client 200 expose selected messages; absent headers may be another client or missing. Limits are not stable pagination or latest-activation proof. Message IDs/variables and simulation flags are raw evidence; no end-marker/status, message rendering, CTS result, or target-system identity is inferred."
    ]
  }
}
