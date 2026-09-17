import type { ADTClient } from "abap-adt-api"
import type { AtcResultInfo } from "./backend.js"

export type AtcStage = "customizing" | "create_worklist" | "create_run" | "read_worklist"

export class AtcStageError extends Error {
  readonly worklistCreationAttempted: boolean
  readonly runCreationAttempted: boolean

  constructor(
    readonly stage: AtcStage,
    cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = "AtcStageError"
    this.worklistCreationAttempted = stage !== "customizing"
    this.runCreationAttempted = stage === "create_run" || stage === "read_worklist"
  }
}

type MetadataClient = Pick<ADTClient, "atcCustomizing">
type ExecutionClient = Pick<
  ADTClient,
  "atcCustomizing" | "atcCheckVariant" | "createAtcRun" | "atcWorklists"
>

export async function inspectNativeAtc(client: MetadataClient, configuredVariant?: string) {
  try {
    const customizing = await client.atcCustomizing()
    const value = customizing.properties.find(
      (property) => property.name === "systemCheckVariant"
    )?.value
    const systemVariant = typeof value === "string" && value.trim() ? value : null
    return {
      status: "metadata_available" as const,
      stage: "customizing" as const,
      engine: "ATC" as const,
      endpoint: "/sap/bc/adt/atc/customizing",
      method: "GET" as const,
      systemVariant,
      selectedVariant: configuredVariant ?? systemVariant,
      variantSource: configuredVariant ? "configured" : systemVariant ? "system" : "none",
      variantValidated: false,
      worklistCreationAttempted: false,
      runCreationAttempted: false,
      qualityGate: "not_evaluated"
    }
  } catch (error) {
    throw new AtcStageError("customizing", error)
  }
}

export async function executeNativeAtc(
  client: ExecutionClient,
  targetUri: string,
  configuredVariant?: string
): Promise<AtcResultInfo> {
  let stage: AtcStage = "customizing"
  try {
    const variant = configuredVariant ?? (await inspectNativeAtc(client)).selectedVariant
    if (!variant) throw new Error("SAP did not provide a system ATC check variant")
    stage = "create_worklist"
    // Despite its name, this SDK method POSTs a worklist and returns its ID.
    const worklistId = await client.atcCheckVariant(variant)
    if (typeof worklistId !== "string" || !worklistId.trim()) {
      throw new Error("SAP did not return an ATC worklist ID")
    }
    stage = "create_run"
    const requestedMaximumVerdicts = 100
    const run = await client.createAtcRun(worklistId, targetUri, requestedMaximumVerdicts)
    stage = "read_worklist"
    const worklist = await client.atcWorklists(
      run.id,
      run.timestamp,
      "99999999999999999999999999999999"
    )
    return {
      variant,
      execution: {
        objectSetIsComplete: worklist.objectSetIsComplete,
        requestedMaximumVerdicts
      },
      findings: worklist.objects.flatMap((object) =>
        object.findings.map((finding) => ({
          objectName: object.name,
          objectType: object.type,
          messageTitle: finding.messageTitle,
          checkTitle: finding.checkTitle,
          checkId: finding.checkId,
          priority: finding.priority,
          uri: finding.location.uri,
          line: finding.location.range.start.line,
          character: finding.location.range.start.column,
          exemptionApproval: finding.exemptionApproval,
          docUri: finding.link?.href ?? ""
        }))
      )
    }
  } catch (error) {
    if (error instanceof AtcStageError) throw error
    throw new AtcStageError(stage, error)
  }
}

export type AtcPrecheckInfo = Awaited<ReturnType<typeof inspectNativeAtc>>
