import { createHash } from "node:crypto"
import { z } from "zod"
import {
  configurationBcDependenciesSchema,
  type readConfigurationBcDependencies
} from "./configuration-bc-audit.js"
import { configurationBcSetSchema, type readConfigurationBcSet } from "./configuration-bc-set.js"
import {
  configurationBcSetCompareSchema,
  type compareConfigurationBcSet
} from "./configuration-bc-compare.js"
import { configurationUnitSchema } from "./configuration-unit.js"

export const configurationBcImpactSchema = configurationBcDependenciesSchema
  .extend({
    maxNodes: z.number().int().min(1).max(5).default(2),
    maxDepth: z.number().int().min(0).max(3).default(2),
    maxChildren: z.number().int().min(2).max(8).default(8),
    language: configurationUnitSchema.shape.language.unwrap(),
    maxRecords: z.number().int().min(2).max(10).default(10),
    maxValues: z.number().int().min(2).max(100).default(100),
    maxTargetReads: z.number().int().min(0).max(40).default(20),
    includeActivationBoundary: z.boolean().optional(),
    includeRecordInventory: z.boolean().optional()
  })
  .strict()
type Graph = Awaited<ReturnType<typeof readConfigurationBcDependencies>>
type Content = Awaited<ReturnType<typeof readConfigurationBcSet>>
type Comparison = Awaited<ReturnType<typeof compareConfigurationBcSet>>
const graphProjection = (graph: Graph) =>
  JSON.stringify({
    status: graph.status,
    nodes: graph.nodes,
    edges: graph.edges,
    cycles: graph.cycles,
    frontier: graph.frontier,
    coverage: graph.coverage
  })
const usable = (content: Content | null) =>
  content !== null &&
  content.status === "partial" &&
  content.readFingerprint !== null &&
  !content.coverage.truncated &&
  content.records !== null &&
  content.values !== null &&
  content.languageValues !== null

/** Composition of existing guarded observations, never an activation or execution plan. */
export async function inspectConfigurationBcImpact(
  raw: unknown,
  client: string,
  readGraph: (
    input: z.infer<typeof configurationBcDependenciesSchema>
  ) => ReturnType<typeof readConfigurationBcDependencies>,
  readContent: (
    input: z.infer<typeof configurationBcSetSchema>
  ) => ReturnType<typeof readConfigurationBcSet>,
  compare: (
    input: z.infer<typeof configurationBcSetCompareSchema>,
    beforeUnitRead: () => void
  ) => ReturnType<typeof compareConfigurationBcSet>,
  readFunction?: (functionName: string) => Promise<unknown>,
  readInclude?: (objectName: string) => Promise<unknown>
) {
  const input = configurationBcImpactSchema.parse(raw)
  if (input.connectionId !== "w200" || client !== "200") throw Error("BC_IMPACT_SCOPE_UNSUPPORTED")
  const startedAt = new Date().toISOString(),
    graphInput = {
      connectionId: input.connectionId,
      bcSetId: input.bcSetId,
      version: input.version,
      maxNodes: input.maxNodes,
      maxDepth: input.maxDepth,
      maxChildren: input.maxChildren
    }
  const graph = await readGraph(graphInput)
  const items: {
    bcSetId: string
    objectName: "T006" | "T006A"
    status: string
    code: string | null
    contentFingerprint: string | null
    recordCount: number | null
    storedUnitKeyCells: { recordNumber: string; flag: string; value: string }[] | null
    comparison: Comparison | null
    evidence: Content["evidence"] | null
  }[] = []
  const recordInventories: { bcSetId: string; inventory: Content["recordInventory"] }[] = []
  let targetReads = 0,
    deniedTargetReads = 0,
    changed = false,
    unavailable = false
  const beforeUnitRead = () => {
    if (targetReads >= input.maxTargetReads) {
      deniedTargetReads++
      throw Error("BC_IMPACT_TARGET_READ_LIMIT")
    }
    targetReads++
  }
  const contentReads: {
    input: z.infer<typeof configurationBcSetSchema>
    fingerprint: string
    inventoryFingerprint: string | null
  }[] = []
  const graphAvailable = graph.nodes !== null && !["changed", "unavailable"].includes(graph.status)
  if (graphAvailable)
    for (const node of graph.nodes!) {
      if (node.status !== "read") continue
      for (const objectName of ["T006", "T006A"] as const) {
        const selected = configurationBcSetSchema.parse({
          connectionId: input.connectionId,
          bcSetId: node.id,
          version: input.version,
          objectName,
          maxRecords: input.maxRecords,
          maxValues: input.maxValues,
          maxDependencies: input.maxChildren,
          ...(input.includeRecordInventory && objectName === "T006"
            ? { includeRecordInventory: true }
            : {})
        })
        let content: Content | null = null,
          comparison: Comparison | null = null,
          code: string | null = null
        try {
          content = await readContent(selected)
        } catch {
          code = "BC_IMPACT_CONTENT_UNAVAILABLE"
          unavailable = true
        }
        if (selected.includeRecordInventory) {
          recordInventories.push({ bcSetId: node.id, inventory: content?.recordInventory ?? null })
          if (!content?.recordInventory || content.recordInventory.status.startsWith("unavailable"))
            unavailable = true
          else if (content.recordInventory.status === "changed") changed = true
        }
        if (content && !usable(content)) {
          code = "BC_IMPACT_CONTENT_INCOMPARABLE"
          if (["changed", "not_found", "unsupported_category"].includes(content.status))
            changed = true
        }
        if (content && usable(content)) {
          contentReads.push({
            input: selected,
            fingerprint: content.readFingerprint!,
            inventoryFingerprint: content.recordInventory?.fingerprint ?? null
          })
          const nodeHeader = node.header
          if (
            !content.header ||
            !nodeHeader ||
            ["ID", "VERSION", "CATEGORY", "TYPE", "MODDATE", "MODTIME"].some(
              (field) => content!.header![field] !== nodeHeader[field]
            )
          ) {
            changed = true
            code = "BC_IMPACT_HEADER_CHANGED"
          } else if (targetReads >= input.maxTargetReads && content.records?.length)
            code = "BC_IMPACT_TARGET_READ_LIMIT"
          else {
            try {
              comparison = await compare(
                configurationBcSetCompareSchema.parse({ ...selected, language: input.language }),
                beforeUnitRead
              )
            } catch {
              code = "BC_IMPACT_COMPARISON_UNAVAILABLE"
              unavailable = true
            }
            if (comparison) {
              if (
                comparison.coverage.sourceFingerprint !== content.readFingerprint ||
                comparison.status === "changed"
              )
                changed = true
              if (comparison.code !== null || !comparison.evidence.valuesRechecked)
                code = comparison.code ?? "BC_IMPACT_COMPARISON_INCOMPARABLE"
            }
          }
        }
        items.push({
          bcSetId: node.id,
          objectName,
          status: code ? "incomparable" : (comparison?.status ?? "incomparable"),
          code,
          contentFingerprint: content?.readFingerprint ?? null,
          recordCount: content?.records?.length ?? null,
          storedUnitKeyCells: usable(content)
            ? content!
                .values!.filter((v) => v.FIELDNAME === "MSEHI")
                .map((v) => ({ recordNumber: v.RECNUMBER!, flag: v.FLAG!, value: v.VALUE! }))
            : null,
          comparison,
          evidence: content?.evidence ?? null
        })
      }
    }
  // A report spans multiple adapter calls. Recheck its graph and content linkage across those calls.
  let graphRechecked = false,
    contentsRechecked = false
  if (graphAvailable) {
    for (const observation of contentReads) {
      try {
        const confirmation = await readContent(observation.input)
        if (!usable(confirmation)) unavailable = true
        else if (confirmation.readFingerprint !== observation.fingerprint) changed = true
        else if (
          observation.input.includeRecordInventory &&
          (!confirmation.recordInventory ||
            confirmation.recordInventory.status.startsWith("unavailable"))
        )
          unavailable = true
        else if (
          observation.input.includeRecordInventory &&
          (confirmation.recordInventory?.fingerprint ?? null) !== observation.inventoryFingerprint
        )
          changed = true
      } catch {
        unavailable = true
      }
    }
    contentsRechecked = !unavailable
    try {
      const confirmation = await readGraph(graphInput)
      if (confirmation.nodes === null || ["unavailable", "changed"].includes(confirmation.status))
        unavailable = true
      else if (graphProjection(confirmation) !== graphProjection(graph)) changed = true
      graphRechecked = !unavailable
    } catch {
      unavailable = true
    }
  }
  const rejected = changed || unavailable || !graphAvailable
  const counts: Record<string, number> = {
    equal_trimmed_value: 0,
    different: 0,
    target_missing: 0,
    incomparable: 0
  }
  if (!rejected)
    for (const item of items)
      for (const row of item.comparison?.rows ?? [])
        for (const field of row.fields) counts[field.status] = (counts[field.status] ?? 0) + 1
  const recordInventoryComplete =
    !!input.includeRecordInventory &&
    !rejected &&
    graph.coverage.observedGraphComplete &&
    !graph.cycles?.length &&
    recordInventories.length > 0 &&
    recordInventories.length === graph.nodes?.length &&
    recordInventories.every((item) => item.inventory?.complete && item.inventory.fingerprint)
  const selectedObservationsRechecked =
    !rejected &&
    graph.coverage.observedGraphComplete &&
    !graph.cycles?.length &&
    items.every((item) => item.code === null && item.comparison?.evidence.valuesRechecked) &&
    (!input.includeRecordInventory || recordInventoryComplete)
  return {
    ...input,
    client,
    status: rejected
      ? changed || graph.status === "changed"
        ? "changed"
        : "unavailable"
      : graph.status === "not_found"
        ? "not_found"
        : "partial",
    readOnly: true,
    saveAvailable: false,
    activationAvailable: false,
    activationBoundary: input.includeActivationBoundary
      ? await inspectBcActivationSources(readFunction, readInclude)
      : null,
    graph: rejected ? null : graph,
    recordInventories: input.includeRecordInventory && !rejected ? recordInventories : null,
    items: rejected ? null : items,
    fieldCounts: rejected ? null : counts,
    readFingerprint: selectedObservationsRechecked
      ? createHash("sha256")
          .update(
            JSON.stringify({
              input,
              graph: graphProjection(graph),
              observations: items.map((item) => ({
                bcSetId: item.bcSetId,
                objectName: item.objectName,
                fingerprint: item.contentFingerprint,
                rows: item.comparison!.rows
              })),
              ...(input.includeRecordInventory
                ? {
                    recordInventories: recordInventories.map((item) => ({
                      bcSetId: item.bcSetId,
                      fingerprint: item.inventory!.fingerprint
                    }))
                  }
                : {})
            })
          )
          .digest("hex")
      : null,
    coverage: {
      complete: false,
      selectedObservationsRechecked,
      unresolvedRecordCount: rejected
        ? null
        : items.reduce(
            (count, item) =>
              count +
              (item.comparison?.rows.filter(
                (row) => row.key === null || row.status === "incomparable"
              ).length ?? 0),
            0
          ),
      incomparableItemCount: rejected ? null : items.filter((item) => item.code !== null).length,
      selectedTables: ["T006", "T006A"],
      wholeSetRecordInventory: input.includeRecordInventory
        ? recordInventoryComplete
          ? "read_rechecked"
          : "incomplete"
        : "not_requested",
      unsupportedInventoryTables:
        input.includeRecordInventory && !rejected
          ? [
              ...new Set(
                recordInventories.flatMap((item) => item.inventory?.unsupportedTableNames ?? [])
              )
            ].sort()
          : null,
      nodeLimit: input.maxNodes,
      unitReaderInvocations: targetReads,
      deniedTargetReads,
      unitReaderInvocationLimit: input.maxTargetReads,
      targetBudgetExhausted:
        deniedTargetReads > 0 || items.some((item) => item.code === "BC_IMPACT_TARGET_READ_LIMIT"),
      activationKeyResolved: false,
      activationOrderResolved: false,
      numericConversion: false,
      languageOverlayApplied: false,
      otherTables: "not_read",
      activationLogs: "not_read"
    },
    evidence: {
      startedAt,
      finishedAt: new Date().toISOString(),
      graphRechecked,
      contentsRechecked,
      snapshot: false
    },
    warnings: [
      "Partial read-only impact observations, not an activation plan, complete BC Set, execution order or whole-row equality. Stored unit key cells are evidence, not resolved activation keys; use comparison row keys only within its documented scope.",
      "The global budget counts every unit-reader invocation, including confirmations, across all nodes/tables. A denied read cannot report equality. Graph/content changes discard the report; sequential checks are not an atomic SAP snapshot. Target observations were rechecked inside each comparison, not across a final whole-report target snapshot.",
      "Only T006/T006A and explicitly selected language are covered. Unvisited, missing, unsupported and cyclic references, variable keys, numeric fields and other tables remain unresolved. No activation, configuration write, CTS or business operation is performed.",
      "Optional inventories cover record metadata across every visited set, limited by maxRecords per set; their separate fingerprints are rechecked across report composition. Unsupported tables remain metadata references only. Complete inventories do not resolve value completeness, variable keys, language policy, numeric conversion, after-import methods or activation transaction boundaries."
    ]
  }
}

// Reviewed on w200/200. These are source observations, never executable API approvals.
export const configurationBcActivationFunctions = {
  TRINT_CALL_AFTER_IMP_METHOD: {
    sourceFingerprint: "1c8a2950f63c740eef42d8e2ca09d71bd8ea7cb4527f09473bd5b4ce05d38f89",
    interfaceFingerprint: "487d0c30d30179faa2db1bd92b5a0910eb5f6630cb569eb8af2f2cdc0a459c10",
    remoteEnabled: false,
    lineCount: 116
  },
  SCPR_ACTIVATE_BCSETS_REMOTE: {
    sourceFingerprint: "76c279ae758eb9a5d2cbc14a889585505c0d984c07da2a4636f1628ba4ac9ac1",
    interfaceFingerprint: "49c7a1c2594870c1fd60703322687b13bbc3ce90b78c0b77d5687b081b402387",
    remoteEnabled: false,
    lineCount: 941
  },
  SCPR_ACTIV_MN_REMOTE_SUB: {
    sourceFingerprint: "3748e8a8e23bd9ec1b2927b8e7d08db4f13f62ff9b732272eb75fa8cac147a27",
    interfaceFingerprint: "c4b92fe382a8f19152424f627a44b1870b0175ef18ed1525872cc9b6990e8e58",
    remoteEnabled: true,
    lineCount: 297
  },
  SCPR_ACTIV_MN_ACTIVATE: {
    sourceFingerprint: "450a15aee97fa02e6b3ecceda218d41b60a8c89b05d8e9a74d9f160cf74d03f7",
    interfaceFingerprint: "3f82e96a34e8a244ac8e7febc372e6c58923c0d053dc5ffd5c4639826c4af340",
    remoteEnabled: false,
    lineCount: 2674
  },
  SCPR_ACTIV_MN_TRANSP_HANDLE: {
    sourceFingerprint: "5cc1b7c48cb9e4f9d5b8f6de4bef92af97d182dc47e8aa0f375e060fe25605c4",
    interfaceFingerprint: "e2243404cb2cd13b707b465759c952695e2b3f0b104595753deb219e68c8eb7c",
    remoteEnabled: false,
    lineCount: 479
  },
  SCPR_AUTHORITY_CHECK: {
    sourceFingerprint: "11eaa6006acfa9933f3bbb614b088587899ed2d67260da8238b15308085e2170",
    interfaceFingerprint: "b6db12d125987322207fc075bd6df6ae465fe82a21d37fd622df69b6dbbe542d",
    remoteEnabled: false,
    lineCount: 316
  },
  SCPR_PRSET_CT_IMPORT_INDUSTRY: {
    sourceFingerprint: "add1c596768b06381f8d5023e4e6dc8c895ea76dc8b02b6c221de465e05406dd",
    interfaceFingerprint: "ae071f65d6a2ab73f69de60d0d2dc6c58281bcd1c991b1e52768633b1c6cb7bf",
    remoteEnabled: false,
    lineCount: 1205
  },
  SCPR_ACTIV_PROTOCOL_WRITE: {
    sourceFingerprint: "71be29a573260efa559d3fc42f150e12f56187ae44e8569d7eeddb55656f52f7",
    interfaceFingerprint: "d1bb8eaf7372ef2b71727bfa2389c752218313602607a7f2457f7bcd96c59e3a",
    remoteEnabled: false,
    lineCount: 134
  },
  VIEW_BCSET_IMPORT: {
    sourceFingerprint: "208d0e5b2129d2d476ce6ae328187b23586e037f913a9844dd9b500a52d6f610",
    interfaceFingerprint: "1782c7ce2f7503f8273a94d8659d271e6be1d1fe488063f6f722b340c6b121ed",
    remoteEnabled: false,
    lineCount: 634
  },
  VIEWCLUSTER_BCSET_IMPORT: {
    sourceFingerprint: "00452816ecf814230e3d7b359edf3cdf2b32efa5dfba8f6eab37da3afd257706",
    interfaceFingerprint: "a546e17f37c7adea2aee89749b859f0b7247f9fdbcf7a1867945e87b1a3306a8",
    remoteEnabled: false,
    lineCount: 81
  },
  VIEW_BCSET_IMPORT_UNCHECKED2: {
    sourceFingerprint: "0921f44d2708e9be33a3eb80023b0d982d4ffcc840fe1917be0102b0a171c6e3",
    interfaceFingerprint: "9ad3773460c155f34529f5e521c228a132bec953f4a6c73481f80abc5d7ecdb2",
    remoteEnabled: false,
    lineCount: 618
  },
  VIEWCLUSTER_BCSET_IMPORT_UC2: {
    sourceFingerprint: "a458778b5c7ec24a75c44e57f6d9b940f66db2feeacd0db76f8405a41d12067d",
    interfaceFingerprint: "a546e17f37c7adea2aee89749b859f0b7247f9fdbcf7a1867945e87b1a3306a8",
    remoteEnabled: false,
    lineCount: 80
  },
  SCPR_PRSET_CT_ONE_TABLE_LOAD: {
    sourceFingerprint: "a7d73a3bcb86ad66ede551553568139222f45c29bfa1767e9d257a1d8e11cacb",
    interfaceFingerprint: "1a7fffc46553344866b70356f44c8e788c071419431c2198bb98fc642448bef4",
    remoteEnabled: false,
    lineCount: 591
  },
  SCPR_ACTIV_RUN_AFTER_IMP: {
    sourceFingerprint: "90adadde8791259b02f27e7971c08c895fd5c2cf280ec0a01f4b6955f2a45fbb",
    interfaceFingerprint: "081408cfd32b4f870d4d7d89c07bae9c410fc87b4f46f5858587a32f87dc06ae",
    remoteEnabled: false,
    lineCount: 128
  },
  SCPR_PR_DB_DATA_WRITE: {
    sourceFingerprint: "c2d52d126c00c68f2f11ac0e995d5f02ea373b8df13b94bd2020d5e402291fa7",
    interfaceFingerprint: "c93d0964601e49912538739a7b1a6d5089e8efda441027aecd15d97953ce27d1",
    remoteEnabled: false,
    lineCount: 79
  },
  SCPR_PR_DB_PROTOCOL_END: {
    sourceFingerprint: "f4990d2470c37ec40efd27388728753b791a8a5d8e27c19d967d23771ab80ba7",
    interfaceFingerprint: "c163a86e7cc0ec5a1efbe76648482e91ea07be99a9ad38bc713d7ec488de3e5f",
    remoteEnabled: false,
    lineCount: 67
  },
  VIEW_MAINTENANCE_NO_DIALOG: {
    sourceFingerprint: "aef8ff0659768c8c723583f7d084449063afc5980060f4c45b3c5641a499b861",
    interfaceFingerprint: "096a143263b04e39e651e1f42a8038df2193fca019eaf41b7e34d1829d72816b",
    remoteEnabled: false,
    lineCount: 288
  },
  VIEW_MAINTENANCE_LOW_LEVEL: {
    sourceFingerprint: "1aeb5c3d4610373e63188749eb9b77604a8fd8028945e5d405327e6f311be0a0",
    interfaceFingerprint: "d7d7728f3a9d34a5296c194b5dc07307164789146d61bb9d2f66f833af9c3d57",
    remoteEnabled: false,
    lineCount: 251
  },
  VIEWCLUSTER_BCSET_IMPORT_INT: {
    sourceFingerprint: "17ce795fcd60b86045fd40395cf591633d1d6136ecd51acf89e649e2b4093154",
    interfaceFingerprint: "bf7a78b3686e2a9bfde89c9c69f413c1f36819be1e0e0b17d514c84a17fa7f07",
    remoteEnabled: false,
    lineCount: 702
  },
  VIEWCLUSTER_BCSET_IMPORT_UC2_I: {
    sourceFingerprint: "ac625398f9b1449f3fa209cdf718be9f40e49d4e439fd9e7735bf22f3a22573f",
    interfaceFingerprint: "bf7a78b3686e2a9bfde89c9c69f413c1f36819be1e0e0b17d514c84a17fa7f07",
    remoteEnabled: false,
    lineCount: 756
  },
  TR_CALL_AFTER_IMP_METHOD: {
    sourceFingerprint: "4608fd47477621e22c65111fee08557921603d8bbbfb5bfcc8451994e9c7c89a",
    interfaceFingerprint: "eb71cf3018e7f501ee4305838e7cea53f85b0d189ef593a1355d83eec7f782d6",
    remoteEnabled: false,
    lineCount: 35
  }
} as const

export const configurationBcActivationIncludes = {
  LSCPRACF01: {
    sourceUri: "/sap/bc/adt/functions/groups/scprac/includes/lscpracf01/source/main",
    sourceFingerprint: "96da3cfb66db7edabdb8cda11e7d2e30e06b38886651c17243949ea14c232cdb",
    lineCount: 1145
  },
  SCPRCONST: {
    sourceUri: "/sap/bc/adt/programs/includes/scprconst/source/main",
    sourceFingerprint: "714f24278a7e45d62c6661d96d9207179820cd79f7b82e7d8b6c3f7e2e47b8b6",
    lineCount: 18
  },
  SCPREXTCONST: {
    sourceUri: "/sap/bc/adt/programs/includes/scprextconst/source/main",
    sourceFingerprint: "81a337673bdcb7a8c83a604e5e9c195277aab24cf07386c49c239f957048547b",
    lineCount: 64
  },
  SCPRINTCONST: {
    sourceUri: "/sap/bc/adt/programs/includes/scprintconst/source/main",
    sourceFingerprint: "d49b6f8124d44350d6df4eb02f91b5f4b38ede56105629a120491cbb0f511cfd",
    lineCount: 623
  }
} as const

async function inspectBcActivationSources(
  readFunction?: (name: string) => Promise<unknown>,
  readInclude?: (name: string) => Promise<unknown>
) {
  const startedAt = new Date().toISOString()
  let status: "source_attested" | "unreviewed" | "changed" | "unavailable" = "source_attested"
  let failedFunction: string | null = null,
    failedInclude: string | null = null
  let functionReads = 0,
    includeReads = 0
  const includes: {
    objectName: string
    sourceUri: string
    sourceFingerprint: string
    lineCount: number
  }[] = []
  const sources: {
    functionName: string
    sourceFingerprint: string
    interfaceFingerprint: string
    remoteEnabled: boolean
    lineCount: number
  }[] = []
  if (!readFunction || !readInclude) status = "unavailable"
  else {
    for (const pass of [0, 1]) {
      for (const [functionName, pin] of Object.entries(configurationBcActivationFunctions)) {
        try {
          functionReads++
          const parsed = z
            .object({
              connectionId: z.literal("w200"),
              functionName: z.literal(functionName),
              remoteEnabled: z.literal(pin.remoteEnabled),
              updateTask: z.literal(false),
              sourceFingerprint: z.literal(pin.sourceFingerprint),
              interfaceFingerprint: z.literal(pin.interfaceFingerprint),
              source: z.array(z.string()).length(pin.lineCount)
            })
            .safeParse(await readFunction(functionName))
          if (!parsed.success) {
            status = pass === 0 ? "unreviewed" : "changed"
            failedFunction = functionName
            break
          }
          if (pass === 0) sources.push({ functionName, ...pin })
        } catch {
          status = "unavailable"
          failedFunction = functionName
          break
        }
      }
      if (status !== "source_attested") break
      for (const [objectName, pin] of Object.entries(configurationBcActivationIncludes)) {
        try {
          includeReads++
          if (
            !z
              .object({
                connectionId: z.literal("w200"),
                objectName: z.literal(objectName),
                sourceUri: z.literal(pin.sourceUri),
                sourceFingerprint: z.literal(pin.sourceFingerprint),
                lineCount: z.literal(pin.lineCount)
              })
              .safeParse(await readInclude(objectName)).success
          ) {
            status = pass === 0 ? "unreviewed" : "changed"
            failedInclude = objectName
            break
          }
          if (pass === 0) includes.push({ objectName, ...pin })
        } catch {
          status = "unavailable"
          failedInclude = objectName
          break
        }
      }
      if (status !== "source_attested") break
    }
  }
  const attested = status === "source_attested"
  return {
    status,
    failedFunction,
    failedInclude,
    readOnly: true,
    activationAvailable: false,
    sources: attested ? sources : null,
    includes: attested ? includes : null,
    authorityDefinition: attested
      ? {
          transaction: "SCPR20",
          objectName: "S_BCSETS",
          enabled: true,
          activateActivity: "07",
          uncheckedActivity: "63",
          currentUserAuthorized: null
        }
      : null,
    optionDefinition: attested
      ? {
          activationType: { "0": { dialog: "Y" }, "1": { dialog: "N" } },
          completeOnly: { "1": { unchecked: "N" }, "2": { unchecked: "Y" } },
          simulation: "initial maps to N; any noninitial value maps to Y",
          noStandardDefault: "N",
          noCommit: "copied without normalization",
          transportOff: {
            Y: { cusStatus: "1", sysStatus: "1" },
            N: { cusStatus: "0", sysStatus: "0" }
          },
          safety: "copied without normalization; no atomicity guarantee"
        }
      : null,
    directTableUpdatePolicy: attested
      ? {
          scope: "existing_record_direct_table_update_branch",
          excludedKeyFlags: ["KEY", "UKY", "FKY"],
          skipReadOnly: "R",
          valueFlagsByNoStandard: {
            N: ["USE", "VAR", "FIX"],
            F: ["FIX"],
            V: ["VAR"],
            Y: ["VAR", "FIX"]
          },
          deleteFlags: ["L", "G"],
          insertionPolicyResolved: false,
          otherRoutesResolved: false
        }
      : null,
    sourceFingerprint: attested
      ? createHash("sha256").update(JSON.stringify({ sources, includes })).digest("hex")
      : null,
    observations: attested
      ? [
          {
            functionName: "SCPR_ACTIV_MN_REMOTE_SUB",
            lines: [5, 25, 128, 151, 215, 228, 256],
            finding:
              "Remote-enabled candidate exposes NO_COMMIT; requires activation type 0/1, complete_only 1/2, classic category and BC Set IDs. Calls ACTIVATE authority and conditionally ACTUNCHKT; options bind to sy-mandt. This does not establish a safe headless invocation."
          },
          {
            functionName: "SCPR_ACTIVATE_BCSETS_REMOTE",
            lines: [106, 220, 284, 304, 414, 855],
            finding:
              "Outer wrapper is not remote-enabled here. It has local/RFC/asynchronous/background branches, creates a protocol UUID and checks RFC authority on the remote path. SYSTEM/MANDANT parameters do not prove current connection target identity."
          },
          {
            functionName: "SCPR_AUTHORITY_CHECK",
            lines: [22, 40],
            finding:
              "ACTIVATE and ACTUNCHKT check S_TCODE=SCPR20 and conditionally a global authorization object with ACTVT 07/63. Pinned SCPRCONST enables S_BCSETS; required activities are 07/63. Current-user permissions and line/object authorization have not been checked."
          },
          {
            functionName: "SCPR_ACTIV_MN_ACTIVATE",
            lines: [734, 1891, 2011, 2031, 2051, 2194, 2216, 2579, 2622],
            finding:
              "Calls BC Set enqueue, foreign-key dependency processing, standard import and after-import methods. Conditional COMMIT WORK occurs before import, after main import and at end when NO_COMMIT is initial; NO_COMMIT registers commit/rollback handlers. Complete call-chain atomicity and compensation remain unproved."
          },
          {
            functionName: "SCPR_PRSET_CT_IMPORT_INDUSTRY",
            lines: [165, 480, 493, 539, 552, 604, 657, 701, 1077, 1141, 1154],
            finding:
              "Enqueues tables, calls view/viewcluster loaders; T/L/U maintenance objects use the direct-table loader, including its language-specific branch. Transports data and conditionally commits per import part. Remaining records generate error messages. Complete rollback, overwrite/protected-field semantics and dependency order require further target-specific evidence."
          },
          {
            functionName: "TRINT_CALL_AFTER_IMP_METHOD",
            lines: [57, 68, 72, 80, 93, 114],
            finding:
              "Resolves after-import method calls through CTO_ORDER_GET_METHOD_CALLS, orders special methods and dispatches function-group FORMs with IV_NO_COMMIT_WORK. Selected object methods, dependent FORM behavior and their transaction boundaries remain unresolved. Source attestation does not permit invoking after-import methods."
          },
          {
            functionName: "SCPR_ACTIV_MN_TRANSP_HANDLE",
            lines: [45, 101, 132, 288, 319],
            finding:
              "Branches on dialog/distribution options; validates transport requests and calls task-choice APIs. A supplied request or returned task number alone does not establish no-dialog behavior, no task creation, lock cleanup or successful CTS recording."
          },
          {
            functionName: "SCPR_ACTIV_PROTOCOL_WRITE",
            lines: [39, 43, 48, 113, 126, 132],
            finding:
              "Writes SCPRACPP/SCPRACPM/SCPRACPR using connection R/3* and commits that connection. Rollback flag R clears ACT_END. Log durability is separate from target-data success and caller LUW rollback."
          },
          {
            objectName: "LSCPRACF01",
            lines: [239, 286, 300, 306, 318, 326, 347, 366],
            finding:
              "FILL_ACTIVATION_OPTIONS clears options, maps activation type 0 to dialog Y and other values to N, complete_only 2 to unchecked Y, initial simulation to N and noninitial to Y. Copies NO_COMMIT and safety without normalization; transport_off sets transport status. A background flag alone does not prove the complete route has no dialog."
          },
          {
            objectName: "SCPRCONST",
            lines: [9, 13, 17],
            finding:
              "Authorization check is enabled by constant X and uses S_BCSETS. Includes external/internal constants; this is a source definition, not a grant for the current user."
          },
          {
            objectName: "SCPREXTCONST",
            lines: [35, 38, 39, 40, 42],
            finding:
              "Stored key flags are UKY/FKY/KEY; ordinary/fixed/variable value flags are USE/FIX/VAR. LOC is a distinct excluded-field flag; no whole-row/protected-field policy is inferred for every route."
          },
          {
            objectName: "SCPRINTCONST",
            lines: [279, 283, 331],
            finding:
              "Answer constants are N/Y; no-standard modes are N(all), F(fixed), V(variable), Y(fixed and variable). Delete flags are L/G. These source constants are not new accepted execution parameters."
          },
          {
            functionName: "VIEW_BCSET_IMPORT",
            lines: [57, 130, 163, 310, 496, 538, 624],
            finding:
              "Checked view import sets no-dialog globals, conditionally checks view update authorization, enqueues the view, uses dynamic generated function-pool globals and calls VIEW_MAINTENANCE_NO_DIALOG for changes and SAVE. Generated events, per-row authorization, CTS and commit behavior remain unresolved."
          },
          {
            functionName: "VIEW_BCSET_IMPORT_UNCHECKED2",
            lines: [45, 137, 145, 179, 318, 465, 480, 492, 585],
            finding:
              "Unchecked import clears selection/subset constraints and readonly flags, still conditionally calls VIEW_AUTHORITY_CHECK, uses generated dynamic UPD/DEL routines and saves through low-level maintenance. It must not be substituted as a compatibility fallback for checked import."
          },
          {
            functionName: "VIEWCLUSTER_BCSET_IMPORT",
            lines: [22, 53, 63],
            finding:
              "Checked cluster wrapper delegates to VIEWCLUSTER_BCSET_IMPORT_INT and maps exceptions to error/fatal return codes and protocol messages; pinned internal source delegates to generated routines and cluster_save; complete ordering and save behavior remain unproved."
          },
          {
            functionName: "VIEWCLUSTER_BCSET_IMPORT_UC2",
            lines: [22, 53, 65],
            finding:
              "Unchecked cluster wrapper delegates to VIEWCLUSTER_BCSET_IMPORT_UC2_I; pinned internal source removes view events/maintenance flags and uses generated edits and cluster_save; wrapper success cannot prove complete persistence or rollback."
          },
          {
            functionName: "VIEW_MAINTENANCE_NO_DIALOG",
            lines: [162, 189, 213, 215],
            finding:
              "EDIT maps change indices into generated global state; SAVE dynamically invokes x_call_viewmaintenance in the function pool supplied by X_HEADER. The name does not establish a self-contained or target-bound headless API; generated events/CTS/commit ownership remain unproved."
          },
          {
            functionName: "VIEW_MAINTENANCE_LOW_LEVEL",
            lines: [55, 76, 145, 165],
            finding:
              "Builds VIEWPROC_ or TABLEPROC_ dynamically from X_HEADER, checks TFDIR and invokes that generated function. Propagates missing correction/subset/save errors, exchanges function-pool globals and may read text tables. No generated function was executed or bound to T006/T006A."
          },
          {
            functionName: "VIEWCLUSTER_BCSET_IMPORT_INT",
            lines: [160, 171, 179, 188, 552, 616, 661, 666],
            finding:
              "Checked cluster import invokes dynamic initialization/end exits, authority and enqueue helpers, derives import order and uses no-dialog edit then cluster_save. Dependent FORMs, actual cluster structure/generated events, partial saves and cleanup remain unreviewed."
          },
          {
            functionName: "VIEWCLUSTER_BCSET_IMPORT_UC2_I",
            lines: [181, 182, 194, 203, 220, 597, 611, 668, 713],
            finding:
              "Unchecked cluster import deletes view events and skips maintenance flags, uses generated edit_view_entry UPD/DEL and cluster_save. It must never replace the checked path as a fallback; whole-chain safety and target binding remain unproved."
          },
          {
            functionName: "TR_CALL_AFTER_IMP_METHOD",
            lines: [16, 24, 31],
            finding:
              "Wraps the current sy-mandt in a client list and forwards iv_no_commit_work to TRINT_CALL_AFTER_IMP_METHOD. The downstream dispatch and actual after-import methods remain unresolved; forwarding does not guarantee atomic caller rollback."
          },
          {
            functionName: "SCPR_PRSET_CT_ONE_TABLE_LOAD",
            lines: [206, 242, 276, 297, 341, 347, 348, 364, 382, 433, 481, 528],
            finding:
              "Existing-row direct-table update excludes key flags and readonly R, selects USE/FIX/VAR fields by no-standard mode. Absent rows use a separate converter; L/G can delete, and dynamic MODIFY can insert/update. Activation links and persistence errors are handled separately; this is not an allowed generic table writer."
          },
          {
            functionName: "SCPR_ACTIV_RUN_AFTER_IMP",
            lines: [31, 43, 68, 75, 81],
            finding:
              "Imports NO_COMMIT from TRANSACTION_MODE memory and forwards it to TR_CALL_AFTER_IMP_METHOD.iv_no_commit_work; initializes and reads CTS logs. Actual after-import methods and transaction safety are unresolved."
          },
          {
            functionName: "SCPR_PR_DB_DATA_WRITE",
            lines: [18, 21, 31, 65],
            finding:
              "Normal protocol flush delegates to independently committed SCPR_ACTIV_PROTOCOL_WRITE; transport-protocol branch uses TR_APPEND_LOG. It is a write operation even without an explicit COMMIT WORK in this wrapper."
          },
          {
            functionName: "SCPR_PR_DB_PROTOCOL_END",
            lines: [22, 26, 45, 63],
            finding:
              "May delete a previous end marker, then writes a new end message and flushes protocol. An end marker or task number does not establish configuration/CTS success."
          }
        ]
      : null,
    coverage: {
      completeCallChain: false,
      runtimeExecuted: false,
      simulationExecuted: false,
      currentUserAuthorization: "not_checked",
      targetClientSettings: "not_checked",
      headlessRouteProved: false,
      atomicRollbackProved: false,
      activationOrderResolved: false,
      overwriteSemanticsResolved: false,
      ctsOutcome: "not_checked",
      logsRead: false
    },
    blockers: [
      "Review remaining generated maintenance events, cluster internals, converters and actual after-import methods; source option/auth definitions do not prove runtime permissions or complete commit propagation.",
      "Bind a permitted headless route to exact target/client, keys, version, overwrite policy and CTS task; simulation is not authorized as a read-only operation.",
      "Define receipts and manual reconciliation for timeout, partial commits, log/CTS mismatch and repeated requests before enabling activation."
    ],
    evidence: {
      startedAt,
      finishedAt: new Date().toISOString(),
      sourcesRechecked: attested,
      functionReaderInvocations: functionReads,
      includeReaderInvocations: includeReads,
      readerInvocationLimit:
        2 *
        (Object.keys(configurationBcActivationFunctions).length +
          Object.keys(configurationBcActivationIncludes).length),
      snapshot: false
    },
    warning:
      "Source fingerprint covers only the named reviewed definitions, independently of BC Set/target observations. It is not a preflight approval or execution token. No standard activation, simulation, authorization, enqueue, CTS or log-write function is invoked."
  }
}
