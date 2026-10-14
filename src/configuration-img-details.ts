import { z } from "zod"
import type { SapBackend } from "./backend.js"
import { createReviewedTableReader, type ReviewedReaderSource } from "./reviewed-table-reader.js"

export const configurationImgDetailLanguage = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/)

// Active w200/200 definitions reviewed through MCP. No caller-supplied metadata tables.
export const configurationImgDetailLayouts = {
  T002: "f3d64b69bf9be805d92657ca047f9164f0662bbc4b07e3f8c944f21ff70fc307",
  CUS_IMGACT: "9fbed24c4644afff2efc8d92af85b59209a7daa41681212602c0eef0e50acbb7",
  TTREE: "9a86b9499d68262a93cd2913f8b7d5e1b6add9c3327662e180adb696ba8b805e",
  TTREETYPE: "417f0f5244b7db64d033d49eb17e52de472ae45524e5549a7c2ad1bac765886c",
  TNODE01: "d7e44ec0359f15faf0062bc4f600bebdae40aa03faba2dc0d98cfed09a317823",
  TNODE01R: "cd2a6de23aa6ed8c1c13aed1a7dd037dc4a2a05a5377a4bb63699dddb62ebe77",
  TNODE01T: "dfa380e7213fed5d493eff7399ce2e5b0d7c5994ea398aecba6aa8b405b3be97",
  TNODE02: "5002c37c94e915019fbe2031c829857e957cb4d5d4f312a85206659e06ecf4ec",
  TNODE02R: "84dbd827823cf428e3eb81363e91ccd40dd1331a0216318ef2c52ebe2e509297",
  TNODE02T: "5364d96400e38fb0c4efa1f2c3374da4c5814654224e3884c7f74ad5c40323d1",
  TNODEIMG: "11039c8a02997d7d57e34f559efdcdb72b203151e41ff4ab73cb4f71b714f383",
  TNODEIMGR: "1f3b3cfc5d010268ec11e72a88d3563c43d5e9d7a6ffa2d01d447f5ead52c8d0",
  TNODEIMGT: "165d2f37c1c6aeeb44cf4f419e5df9f8900340f0a3005c1d11742700c5ecbf3e"
} as const

const codeOf = (error: unknown) =>
  error instanceof Error && /^CONFIGURATION_IMG_DETAIL_[A-Z_]+$/.test(error.message)
    ? error.message
    : "CONFIGURATION_IMG_DETAIL_QUERY_FAILED"
const unavailable = (error: unknown) => ({ status: "unavailable", code: codeOf(error) })
const key = z.string().regex(/^[A-Za-z0-9_]{1,32}$/)
const physicalNodeTables = ["TNODEIMG", "TNODE01", "TNODE02"] as const
type PhysicalNodeTable = (typeof physicalNodeTables)[number]
const treeFields = ["ID", "EXT_KEY", "EXTENSION", "TYPE", "NODE_ID"]
const nodeFields = [
  "TREE_ID",
  "EXT_KEY",
  "EXTENSION",
  "NODE_ID",
  "PARENT_ID",
  "REFNODE_ID",
  "REFTREE_ID",
  "W_SUBNODES"
]

/** Preserve the approved table-domain entry point used by configuration descriptors. */
export async function readConfigurationImgDetails(
  connectionId: string,
  objectName: string,
  client: string,
  requestedLanguage: string,
  headers: { ACTIVITY: string; DOCU_ID: string }[],
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  readTable: (name: string) => Promise<unknown>,
  readFunction: (name: string) => Promise<unknown>
) {
  if (connectionId !== "w200" || client !== "200" || !["T006", "T006A"].includes(objectName))
    throw new Error("CONFIGURATION_IMG_DETAIL_SCOPE_UNSUPPORTED")
  return readConfigurationImgActivityDetails(
    connectionId,
    client,
    requestedLanguage,
    headers,
    backend,
    readTable,
    readFunction
  )
}

/** Exact activity headers/identifiers only; callers cannot choose metadata tables or predicates. */
export async function readConfigurationImgActivityDetails(
  connectionId: string,
  client: string,
  requestedLanguage: string,
  headers: { ACTIVITY: string; DOCU_ID: string }[],
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  readTable: (name: string) => Promise<unknown>,
  readFunction: (name: string) => Promise<unknown>
) {
  if (connectionId !== "w200" || client !== "200")
    throw new Error("CONFIGURATION_IMG_DETAIL_SCOPE_UNSUPPORTED")
  const language = configurationImgDetailLanguage.parse(requestedLanguage)
  z.array(z.object({ ACTIVITY: z.string().min(1).max(20), DOCU_ID: z.string() }))
    .max(100)
    .parse(headers)
  const sources: ReviewedReaderSource[] = []
  const warnings: string[] = []
  const layouts = new Map<string, Promise<void>>()
  const verifiedLayouts = new Set<keyof typeof configurationImgDetailLayouts>()
  const verify = async (name: keyof typeof configurationImgDetailLayouts) => {
    const result = await readTable(name)
    if (
      !z
        .object({
          connectionId: z.literal(connectionId),
          objectName: z.literal(name),
          objectKind: z.literal("transparentTable"),
          active: z.literal(true).optional(),
          fingerprint: z.literal(configurationImgDetailLayouts[name])
        })
        .safeParse(result).success
    )
      throw new Error("CONFIGURATION_IMG_DETAIL_LAYOUT_UNVERIFIED")
  }
  const reader = createReviewedTableReader(
    backend,
    connectionId,
    () => readFunction("RFC_READ_TABLE"),
    sources,
    warnings
  )
  const cache = new Map<string, Promise<Record<string, string>[]>>()
  const read = async (
    table: keyof typeof configurationImgDetailLayouts,
    fields: string[],
    filters: Record<string, string>,
    maximum: number
  ) => {
    const query = JSON.stringify([table, fields, filters, maximum])
    if (!cache.has(query)) {
      // ponytail: 96 exact reads per request; raise only with measured cost and a revised budget.
      if (cache.size >= 96) throw new Error("CONFIGURATION_IMG_DETAIL_READ_BUDGET_EXCEEDED")
      cache.set(
        query,
        (async () => {
          if (!layouts.has(table))
            layouts.set(
              table,
              verify(table).then(() => {
                verifiedLayouts.add(table)
              })
            )
          await layouts.get(table)
          const rows = await reader({
            table,
            fields,
            filters,
            maximum,
            filterLengthLimit: 64,
            codePrefix: "CONFIGURATION_IMG_DETAIL_",
            mapError: codeOf
          })
          const source = sources[sources.length - 1]!
          if (rows === null) throw new Error(source.code ?? "CONFIGURATION_IMG_DETAIL_UNAVAILABLE")
          if (source.status === "truncated")
            throw new Error("CONFIGURATION_IMG_DETAIL_LIMIT_EXCEEDED")
          return rows
        })()
      )
    }
    return cache.get(query)!
  }
  let sapLanguage: string
  try {
    const rows = await read("T002", ["SPRAS", "LAISO"], { LAISO: language }, 1)
    if (rows.length !== 1 || !/^[A-Za-z0-9]$/.test(rows[0]!.SPRAS!))
      throw new Error("CONFIGURATION_IMG_DETAIL_LANGUAGE_NOT_FOUND")
    sapLanguage = rows[0]!.SPRAS!
  } catch (error) {
    return { ...unavailable(error), requestedLanguage: language, activities: [], sources, warnings }
  }
  const title = async (
    table: "CUS_IMGACT" | "TNODE01T" | "TNODE02T" | "TNODEIMGT",
    filters: Record<string, string>
  ) => {
    try {
      const fields =
        table === "CUS_IMGACT"
          ? ["SPRAS", "ACTIVITY", "TEXT"]
          : ["SPRAS", "TREE_ID", "EXT_KEY", "EXTENSION", "NODE_ID", "TEXT"]
      const rows = await read(table, fields, { ...filters, SPRAS: sapLanguage }, 1)
      return rows.length
        ? {
            status: rows[0]!.TEXT ? "read" : "empty_text",
            text: rows[0]!.TEXT,
            requestedLanguage: language,
            actualLanguage: language,
            sapLanguage,
            fallbackUsed: false,
            table
          }
        : {
            status: "not_found",
            requestedLanguage: language,
            actualLanguage: null,
            sapLanguage,
            fallbackUsed: false,
            table
          }
    } catch (error) {
      return { ...unavailable(error), requestedLanguage: language }
    }
  }
  const resolveReference = async (
    sourceTable: PhysicalNodeTable,
    sourceNode: Record<string, string>,
    sourceTree: Record<string, string>
  ) => {
    const result = {
      status: "read",
      reason: null as string | null,
      scope: "physical_reference_targets_only",
      readOnly: true,
      executable: false,
      targets: [] as Record<string, unknown>[]
    }
    const identity = (table: string, node: Record<string, string>) =>
      JSON.stringify([table, node.TREE_ID, node.EXT_KEY, node.EXTENSION, node.NODE_ID])
    const seen = new Set([identity(sourceTable, sourceNode)])
    const fail = (suffix: string) => new Error(`CONFIGURATION_IMG_DETAIL_REFERENCE_${suffix}`)
    let node = sourceNode
    let tree = sourceTree
    try {
      for (let depth = 0; node.REFNODE_ID || node.REFTREE_ID; depth++) {
        if (depth >= 32) throw fail("DEPTH_LIMIT_EXCEEDED")
        if (
          !key.safeParse(node.REFTREE_ID).success ||
          (node.REFNODE_ID ? !key.safeParse(node.REFNODE_ID).success : !node.W_SUBNODES)
        )
          throw fail("IDENTITY_INCOMPLETE")
        if (node.EXTENSION || tree.EXTENSION) throw fail("EXTENSION_UNSUPPORTED")
        const trees = await read("TTREE", treeFields, { ID: node.REFTREE_ID! }, 1)
        if (trees.length !== 1) throw fail("TREE_NOT_FOUND")
        const targetTree = trees[0]!
        // GENER reads with the source EXT_KEY; cross-extension merging is not proven here.
        if (targetTree.EXT_KEY !== node.EXT_KEY) throw fail("EXT_KEY_MISMATCH")
        if (targetTree.EXTENSION) throw fail("EXTENSION_UNSUPPORTED")
        const types = await read(
          "TTREETYPE",
          ["TREE_TYPE", "ACTIVE", "DB_IDENT", "DB_TABLE"],
          { TREE_TYPE: targetTree.TYPE! },
          1
        )
        if (
          types.length !== 1 ||
          types[0]!.ACTIVE !== "X" ||
          types[0]!.DB_IDENT !== "GENER" ||
          !physicalNodeTables.some((table) => table === types[0]!.DB_TABLE)
        )
          throw fail("STRUCTURE_UNSUPPORTED")
        const targetTable = types[0]!.DB_TABLE as PhysicalNodeTable
        // STREE_READ_NODE_GENER derives a tree reference's node from its declared root.
        const nodeId = node.REFNODE_ID || targetTree.NODE_ID!
        if (!key.safeParse(nodeId).success) throw fail("NODE_ID_INVALID")
        const filters = {
          TREE_ID: targetTree.ID!,
          EXT_KEY: node.EXT_KEY!,
          EXTENSION: "",
          NODE_ID: nodeId
        }
        const targetIdentity = identity(targetTable, filters)
        if (seen.has(targetIdentity)) throw fail("CYCLE_DETECTED")
        seen.add(targetIdentity)
        const rows = await read(targetTable, nodeFields, filters, 1)
        if (rows.length !== 1) throw fail("NODE_NOT_FOUND")
        const target = rows[0]!
        result.targets.push({
          structureId: targetTree.ID,
          table: targetTable,
          extKey: target.EXT_KEY,
          extension: target.EXTENSION,
          nodeId: target.NODE_ID,
          parentId: target.PARENT_ID,
          nodeSelection: node.REFNODE_ID ? "explicit_node" : "declared_root",
          title: await title(`${targetTable}T`, filters),
          referenceNodeId: target.REFNODE_ID,
          referenceTreeId: target.REFTREE_ID
        })
        node = target
        tree = targetTree
      }
    } catch (error) {
      result.status = "partial"
      result.reason = codeOf(error)
    }
    return result
  }
  const paths = async (activity: string) => {
    type Variant = {
      structureId: string
      table: string
      extKey: string
      extension: string
      status: string
      reason: string | null
      nodes: Record<string, unknown>[]
    }
    const variants: Variant[] = []
    const references: {
      variant: Variant
      node: Record<string, unknown>
      source: Record<string, string>
      tree: Record<string, string>
      table: PhysicalNodeTable
    }[] = []
    const issues: { code: string; table: string; nodeId?: string }[] = []
    for (const table of physicalNodeTables) {
      try {
        // STREE_EXIT_TO_OBJECT_IMGD reads COBJ as the IMG activity; GENER uses table + R/T.
        const refs = await read(
          `${table}R`,
          ["NODE_ID", "EXT_KEY", "EXTENSION", "REF_TYPE", "REF_OBJECT"],
          { REF_TYPE: "COBJ", REF_OBJECT: activity },
          16
        )
        const unique = new Map(
          refs.map((row) => [JSON.stringify([row.NODE_ID, row.EXT_KEY, row.EXTENSION]), row])
        )
        for (const ref of unique.values()) {
          try {
            key.parse(ref.NODE_ID)
            z.string().max(32).parse(ref.EXT_KEY)
            const leaf = await read(
              table,
              nodeFields,
              { NODE_ID: ref.NODE_ID!, EXT_KEY: ref.EXT_KEY!, EXTENSION: ref.EXTENSION! },
              1
            )
            if (leaf.length !== 1) throw new Error("CONFIGURATION_IMG_DETAIL_NODE_NOT_FOUND")
            const structureId = key.parse(leaf[0]!.TREE_ID)
            const trees = await read("TTREE", treeFields, { ID: structureId }, 1)
            if (trees.length !== 1 || trees[0]!.EXT_KEY !== ref.EXT_KEY)
              throw new Error("CONFIGURATION_IMG_DETAIL_STRUCTURE_MISMATCH")
            const tree = trees[0]!
            const types = await read(
              "TTREETYPE",
              ["TREE_TYPE", "ACTIVE", "DB_IDENT", "DB_TABLE"],
              { TREE_TYPE: tree.TYPE! },
              1
            )
            if (
              types.length !== 1 ||
              types[0]!.ACTIVE !== "X" ||
              types[0]!.DB_IDENT !== "GENER" ||
              types[0]!.DB_TABLE !== table
            )
              throw new Error("CONFIGURATION_IMG_DETAIL_STRUCTURE_UNSUPPORTED")
            const nodes: Record<string, unknown>[] = []
            const pending: { node: Record<string, unknown>; source: Record<string, string> }[] = []
            const seen = new Set<string>()
            let current = ref.NODE_ID!
            let reason: string | null = null
            for (let depth = 0; ; depth++) {
              if (depth >= 32) {
                reason = "DEPTH_LIMIT_EXCEEDED"
                break
              }
              if (seen.has(current)) {
                reason = "CYCLE_DETECTED"
                break
              }
              seen.add(current)
              const rows = await read(
                table,
                nodeFields,
                {
                  TREE_ID: structureId,
                  EXT_KEY: ref.EXT_KEY!,
                  EXTENSION: ref.EXTENSION!,
                  NODE_ID: key.parse(current)
                },
                1
              )
              if (rows.length !== 1) {
                reason = "PARENT_NOT_FOUND"
                break
              }
              const node = rows[0]!
              const descriptor = {
                nodeId: node.NODE_ID,
                parentId: node.PARENT_ID,
                title: await title(`${table}T`, {
                  TREE_ID: structureId,
                  EXT_KEY: ref.EXT_KEY!,
                  EXTENSION: ref.EXTENSION!,
                  NODE_ID: node.NODE_ID!
                }),
                referenceNodeId: node.REFNODE_ID,
                referenceTreeId: node.REFTREE_ID
              }
              nodes.unshift(descriptor)
              if (node.REFNODE_ID || node.REFTREE_ID)
                pending.push({ node: descriptor, source: node })
              if (node.NODE_ID === tree.NODE_ID) break
              if (!node.PARENT_ID) {
                reason = "DECLARED_ROOT_NOT_REACHED"
                break
              }
              current = node.PARENT_ID
            }
            const variant: Variant = {
              structureId,
              table,
              extKey: ref.EXT_KEY!,
              extension: ref.EXTENSION!,
              status: reason ? "partial" : "read",
              reason,
              nodes
            }
            variants.push(variant)
            for (const entry of pending) references.push({ ...entry, variant, table, tree })
          } catch (error) {
            issues.push({ code: codeOf(error), table, nodeId: ref.NODE_ID! })
          }
        }
      } catch (error) {
        issues.push({ code: codeOf(error), table })
      }
    }
    // Finish source parent chains/variants before references consume the shared read budget.
    for (const { variant, node, source, tree, table } of references) {
      const reference = await resolveReference(table, source, tree)
      node.physicalReference = reference
      if (reference.reason) {
        variant.status = "partial"
        variant.reason ??= reference.reason
      }
    }
    return {
      status: "partial",
      scope: "physical_structures_only",
      complete: false,
      variants,
      issues,
      reason:
        "Containing structures, extension visibility and SAP node activation rules are not resolved; these are not complete SPRO paths."
    }
  }
  // Read activity titles before deeper paths can exhaust the shared request budget.
  const titles = []
  for (const header of headers)
    titles.push(await title("CUS_IMGACT", { ACTIVITY: header.ACTIVITY }))
  const activities = []
  for (const [index, header] of headers.entries())
    activities.push({
      activityId: header.ACTIVITY,
      title: titles[index]!,
      path: await paths(header.ACTIVITY),
      documentation: {
        status: "reference_only",
        reference: header.DOCU_ID,
        requestedLanguage: language,
        readability: "unknown",
        content: {
          status: "unknown",
          reason: "Documentation content was not read; nextRead describes a separate bounded read."
        },
        nextRead:
          /^[A-Z0-9_/]{1,20}$/.test(header.ACTIVITY) &&
          /^SIMG[A-Z0-9_/]{1,56}$/.test(header.DOCU_ID)
            ? {
                tool: "read_configuration_documentation",
                arguments: {
                  connectionId,
                  activityId: header.ACTIVITY,
                  language,
                  maxLines: 200
                },
                readOnly: true
              }
            : null
      }
    })
  try {
    for (const table of verifiedLayouts) await verify(table)
  } catch (error) {
    // No detail from a changed layout is usable; the caller retains only its earlier IMG headers.
    return { ...unavailable(error), requestedLanguage: language, activities: [], sources, warnings }
  }
  return {
    status: "partial",
    requestedLanguage: language,
    sapLanguage,
    activities,
    sources,
    warnings,
    definitionsRechecked: true,
    snapshot: false,
    readBudget: 96,
    depthLimit: 32
  }
}
