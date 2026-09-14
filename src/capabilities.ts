import type {
  DiscoverySnapshotInfo,
  SapBackend,
  SapDdicResult,
  SapHelperResult,
  SapRepositoryResult
} from "./backend.js"
import { PRODUCT_VERSION } from "./version.js"

type Availability = "available" | "unsupported" | "unknown"
type CapabilityRoute = "local" | "native-adt" | "sap-helper-fallback" | "target-specific"

interface CapabilityEvidence {
  source: "local-contract" | "read-probe" | "discovery" | "probe-error" | "version-check"
  detail: string
}

interface CapabilityObservation {
  availability: Availability
  reason: string
  evidence: CapabilityEvidence
}

interface VersionedHelperObservation extends CapabilityObservation {
  name: string
  protocolVersion?: string | undefined
  responseStatus?: string | undefined
  responseCode?: string | undefined
}

interface CapabilitySpec {
  id: string
  implementedLocally: true
  route: CapabilityRoute
  toolNames: string[]
  observation: CapabilityObservation
}

const LOCAL_AVAILABLE: CapabilityObservation = {
  availability: "available",
  reason: "Implemented entirely by the standalone service and requires no SAP endpoint probe.",
  evidence: { source: "local-contract", detail: "Standalone runtime implementation" }
}

export async function buildCapabilityReport(
  backend: SapBackend,
  requestedConnectionId: string
): Promise<string> {
  const connectionId = requestedConnectionId.toLowerCase()
  const connection = backend.connectionDetails(connectionId)
  const observedAt = new Date().toISOString()

  const [
    baseHelper,
    repositoryHelper,
    ddicHelper,
    discovery,
    search,
    query,
    transports,
    dumps,
    traces
  ] = await Promise.all([
    observeHelper("base", () => backend.callSapHelper(connectionId, { operation: "PING" })),
    observeHelper("repository", () =>
      backend.callSapRepository(connectionId, {
        operation: "READ_MESSAGE_CLASS",
        objectName: "00"
      })
    ),
    observeHelper("ddic", () =>
      backend.callSapDdic(connectionId, {
        operation: "READ_DOMAIN",
        objectName: "CHAR1"
      })
    ),
    observeDiscovery(() => backend.discoverySnapshot(connectionId)),
    observeRead("Repository search accepted a bounded no-match query.", () =>
      backend.searchObjects(connectionId, "ZCMCP_CAPABILITY_0310", ["PROG"], 1)
    ),
    observeRead("ADT data preview accepted a one-row read-only query.", () =>
      backend.runQuery(connectionId, "SELECT MANDT FROM T000", 1)
    ),
    observeRead("ADT transport service returned the configured user's transport list.", () =>
      backend.listUserTransports(connectionId, connection.username)
    ),
    observeDumps(() => backend.listDumps(connectionId)),
    observeRead("ADT trace service returned the existing trace list.", () =>
      backend.listTraceRuns(connectionId)
    )
  ])

  const targetSpecific = unknownTargetObservation(
    "Availability requires a real object or execution target; registration and discovery alone are not proof."
  )
  const capabilities: CapabilitySpec[] = [
    capability(
      "local-service",
      "local",
      ["get_connected_systems", "get_capability_report", "get_abap_sql_syntax", "get_runtime_info"],
      LOCAL_AVAILABLE
    ),
    capability(
      "source-change-preflight",
      "target-specific",
      ["preview_source_changes"],
      targetSpecific
    ),
    capability(
      "local-receipts-and-recovery",
      "local",
      [
        "get_customer_function_call_status",
        "get_write_operation_status",
        "list_write_recovery_operations",
        "release_write_operation_lock"
      ],
      LOCAL_AVAILABLE
    ),
    capability("adt-discovery", "native-adt", ["adt_discovery_export"], discovery),
    capability("adt-repository-search", "native-adt", ["search_abap_objects"], search),
    capability(
      "adt-data-preview",
      "native-adt",
      ["get_sap_system_info", "execute_data_query"],
      query
    ),
    capability(
      "structured-table-query",
      "target-specific",
      ["read_abap_table", "preview_configuration"],
      unknownTargetObservation(
        "Requires live table metadata and a successful query; the legacy alternative additionally requires the reviewed RFC reader and a supported full-row layout."
      )
    ),
    capability("adt-transport-read", "native-adt", ["manage_transport_requests"], transports),
    capability(
      "adt-runtime-dumps",
      "native-adt",
      ["analyze_abap_dumps", "diagnose_sap_failure"],
      dumps
    ),
    capability("adt-runtime-traces", "native-adt", ["analyze_abap_traces"], traces),
    capability("sap-base-helper", "sap-helper-fallback", ["sap_helper_status"], baseHelper),
    helperCapability("repository-helper-dynpro-core", repositoryHelper, "1.1", [
      "read_abap_screen",
      "upsert_abap_screen",
      "create_module_pool",
      "delete_module_pool",
      "read_transaction_code",
      "create_transaction_code",
      "delete_transaction_code"
    ]),
    helperCapability("repository-helper-report-transaction", repositoryHelper, "1.2", [
      "create_report_transaction"
    ]),
    helperCapability("repository-helper-function-interface", repositoryHelper, "1.3", [
      "read_function_module_interface",
      "create_function_module_with_interface",
      "inspect_repository_assignment"
    ]),
    helperCapability("repository-helper-screen-patch", repositoryHelper, "1.4", [
      "patch_abap_screen",
      "validate_dynpro_application"
    ]),
    helperCapability("repository-helper-gui-definition", repositoryHelper, "1.5", [
      "read_abap_gui_definition",
      "patch_abap_gui_definition"
    ]),
    helperCapability("repository-helper-ecc-fallbacks", repositoryHelper, "1.7", [
      "read_abap_message_class",
      "create_abap_message_class",
      "manage_text_elements"
    ]),
    helperCapability("repository-helper-message-update", repositoryHelper, "1.8", [
      "update_abap_message_class"
    ]),
    helperCapability("repository-helper-message-delete", repositoryHelper, "1.9", [
      "delete_abap_message_class"
    ]),
    helperCapability("repository-helper-function-interface-patch", repositoryHelper, "2.0", [
      "patch_function_module_interface"
    ]),
    helperCapability("ddic-helper-core", ddicHelper, "1.2", [
      "read_ddic_domain",
      "upsert_ddic_domain",
      "read_ddic_data_element",
      "upsert_ddic_data_element",
      "read_ddic_structure",
      "upsert_ddic_structure",
      "read_ddic_table_type",
      "upsert_ddic_table_type"
    ]),
    helperCapability("ddic-helper-transparent-table", ddicHelper, "1.5", [
      "read_ddic_transparent_table",
      "create_ddic_transparent_table",
      "append_ddic_transparent_table_fields"
    ]),
    helperCapability("ddic-helper-transparent-table-patch", ddicHelper, "1.6", [
      "patch_ddic_transparent_table_fields"
    ]),
    helperCapability("ddic-helper-controlled-delete", ddicHelper, "1.6", ["delete_ddic_object"]),
    capability(
      "adt-object-read",
      "target-specific",
      [
        "get_abap_object_info",
        "get_abap_object_lines",
        "get_batch_lines",
        "get_object_by_uri",
        "search_abap_object_lines",
        "get_abap_object_workspace_uri",
        "get_abap_object_url",
        "get_version_history",
        "get_abap_diagnostics",
        "abap_download"
      ],
      targetSpecific
    ),
    capability("adt-where-used", "target-specific", ["find_where_used"], targetSpecific),
    capability(
      "change-impact",
      "target-specific",
      ["analyze_change_impact"],
      unknownTargetObservation(
        "Native semantic references and explicitly scoped text hints remain separate. No complete dependency graph or safe-to-change guarantee; legacy where-used limitations remain."
      )
    ),
    capability(
      "report-parameters",
      "target-specific",
      ["read_report_parameters"],
      unknownTargetObservation(
        "w200 helper branch deployed with syntax, activation and full source readback evidence; no runtime acceptance. REPORT_PARAMETERS scope is approved but awaits enablement under the new service. Existing compiled SSCR metadata only: no GENERATE, defaults, variant contents, runtime events or source/load consistency proof."
      )
    ),
    capability(
      "report-variant-directory",
      "target-specific",
      ["read_report_variants"],
      unknownTargetObservation(
        "Bounded current-client VARID directory metadata through existing table-read permissions. w200 DDIC inspected; no live directory acceptance. No client-000 merge, parameter values, historical execution snapshot or report execution authorization."
      )
    ),
    capability(
      "adt-quality",
      "target-specific",
      ["run_atc_analysis", "run_unit_tests"],
      targetSpecific
    ),
    capability(
      "application-logs",
      "target-specific",
      ["discover_application_logs", "search_application_logs", "read_application_log"],
      unknownTargetObservation(
        "Requires separately deployed, source/interface-pinned Z_ORVANTA_LOG_READ and local administrator approval; message reads need separate approval. Registration does not prove SLG1 access or read-only SAP behavior."
      )
    ),
    capability(
      "operational-logs",
      "target-specific",
      [
        "search_background_jobs",
        "read_background_job_log",
        "read_background_job_details",
        "read_background_job_spool",
        "read_system_logs",
        "correlate_sap_logs"
      ],
      unknownTargetObservation(
        "SM37 and SM21 require separately approved Z_ORVANTA_OPS_READ in ZORVANTA_LOG. Job details require SM37_DETAILS; spool text requires SP01 and the extended helper interface. The w200 spool branch has source/activation evidence but no runtime acceptance. No OTF/PDF, printing or variant values. Registration is not deployment or runtime proof."
      )
    ),
    capability(
      "maintenance-diagnostics",
      "target-specific",
      ["search_sap_locks", "search_failed_updates", "read_failed_update"],
      unknownTargetObservation(
        "Requires separately deployed Z_ORVANTA_MAINT_READ in ZORVANTA_MAINT, matching source/interface approval and SAP display permissions. Local-only candidate: no helper deployment or live sample acceptance. No SAP unlock or update reprocessing; local receipts never prove SAP lock ownership."
      )
    ),
    capability(
      "scoped-sci-quality",
      "target-specific",
      ["run_sci_analysis"],
      unknownTargetObservation(
        "Requires a pinned SCI helper. Legacy uses Z_ORVANTA_MCP_SCI_API; explicit customer PROG/CLAS/FUGR targets use Z_ORVANTA_MCP_SCI_V2 (two rules). Explicit syntax_critical_sql profile uses Z_ORVANTA_MCP_SCI_E2 (adds nested SELECT only, not FAE). Not native ATC; discovery does not execute or attest helpers."
      )
    ),
    capability(
      "adt-source-lifecycle",
      "target-specific",
      [
        "replace_string_in_abap_object",
        "abap_activate",
        "create_object_programmatically",
        "delete_abap_source_object",
        "create_test_include"
      ],
      targetSpecific
    ),
    capability(
      "smartform-lifecycle",
      "target-specific",
      ["read_smartform", "create_smartform", "save_smartform", "activate_smartform"],
      unknownTargetObservation(
        "Requires ZCL_ORVANTA_SMARTFORM and Z_ORVANTA_SMARTFORM_API on the target connection. Helpers deployed and syntax checked on w200/200 in ZABAP on 2026-09-14; SAP lifecycle acceptance and running MCP service update remain pending. Native SMARTFORM XML full replacement, saved/active versions, locked fingerprint checks; no printing or generated-function execution."
      )
    ),
    capability(
      "adt-debugger",
      "target-specific",
      [
        "abap_debug_session",
        "abap_debug_breakpoint",
        "abap_debug_status",
        "abap_debug_stack",
        "abap_debug_variable",
        "abap_debug_step"
      ],
      targetSpecific
    ),
    capability(
      "customer-rfc-execution",
      "target-specific",
      ["test_remote_function_module", "invoke_customer_function_module"],
      unknownTargetObservation(
        "Availability and safety depend on the exact remote-enabled customer function, active interface fingerprint, allowlist, and explicit side-effect acknowledgement."
      )
    )
  ]

  return JSON.stringify(
    {
      productVersion: PRODUCT_VERSION,
      connection: {
        id: connectionId,
        baseUrl: safeBaseUrl(connection.url),
        client: connection.client,
        language: connection.language,
        username: connection.username
      },
      observedAt,
      readOnly: true,
      safety: {
        sapWritesInvoked: false,
        sapLocksCleared: false,
        automaticWriteRetry: false,
        automaticRollbackClaimed: false
      },
      helpers: [baseHelper, repositoryHelper, ddicHelper],
      discovery: discoverySummary(discovery),
      capabilities,
      summary: {
        toolCount: capabilities.reduce((count, item) => count + item.toolNames.length, 0),
        capabilityCount: capabilities.length,
        ...countAvailability(capabilities)
      }
    },
    null,
    2
  )
}

function capability(
  id: string,
  route: CapabilityRoute,
  toolNames: string[],
  observation: CapabilityObservation
): CapabilitySpec {
  return { id, implementedLocally: true, route, toolNames, observation }
}

function helperCapability(
  id: string,
  helper: VersionedHelperObservation,
  minimumVersion: string,
  toolNames: string[]
): CapabilitySpec {
  if (helper.availability !== "available" || !helper.protocolVersion) {
    return capability(id, "sap-helper-fallback", toolNames, helper)
  }
  const available = compareVersions(helper.protocolVersion, minimumVersion) >= 0
  return capability(id, "sap-helper-fallback", toolNames, {
    availability: available ? "available" : "unknown",
    reason: available
      ? `The observed ${helper.name} read protocol ${helper.protocolVersion} satisfies minimum ${minimumVersion}.`
      : `The read probe observed ${helper.name} operation protocol ${helper.protocolVersion}; it does not prove whether capability version ${minimumVersion} is installed.`,
    evidence: {
      source: "version-check",
      detail: `${helper.name} observed operation protocol ${helper.protocolVersion}; capability minimum ${minimumVersion}`
    }
  })
}

async function observeHelper(
  name: string,
  action: () => Promise<SapHelperResult | SapRepositoryResult | SapDdicResult>
): Promise<VersionedHelperObservation> {
  try {
    const result = await action()
    const responseStatus = result.status.trim().toUpperCase()
    const responseCode = result.code.trim()
    const unsupported = /UNSUPPORTED|NOT_SUPPORTED|UNKNOWN_OPERATION/i.test(responseCode)
    const availability: Availability = unsupported
      ? "unsupported"
      : name === "base" && responseStatus !== "S"
        ? "unknown"
        : "available"
    return {
      name,
      availability,
      protocolVersion: result.version,
      responseStatus: result.status,
      responseCode: result.code,
      reason:
        availability === "available"
          ? responseStatus === "S"
            ? `Received a successful structured ${name} helper response.`
            : `Received a structured ${name} helper protocol response; the read target returned status ${responseStatus || "EMPTY"}.`
          : availability === "unsupported"
            ? `The ${name} helper returned unsupported operation code ${responseCode}.`
            : `The ${name} helper endpoint responded, but status ${responseStatus || "EMPTY"} did not prove readiness.`,
      evidence: {
        source: "read-probe",
        detail: `${result.code || "NO_CODE"}; protocol ${result.version || "unknown"}`
      }
    }
  } catch (error) {
    return { name, ...errorObservation(error) }
  }
}

async function observeRead(
  detail: string,
  action: () => Promise<unknown>
): Promise<CapabilityObservation> {
  try {
    await action()
    return {
      availability: "available",
      reason: detail,
      evidence: { source: "read-probe", detail }
    }
  } catch (error) {
    return errorObservation(error)
  }
}

async function observeDumps(
  action: () => ReturnType<SapBackend["listDumps"]>
): Promise<CapabilityObservation> {
  try {
    const result = await action()
    if (!result.available) {
      return {
        availability: "unsupported",
        reason: "The SAP feed response did not advertise the ABAP runtime dump endpoint.",
        evidence: { source: "read-probe", detail: "Runtime dump feed absent" }
      }
    }
    return {
      availability: "available",
      reason: "ADT runtime dump service returned an existing-dump list.",
      evidence: { source: "read-probe", detail: "Runtime dump endpoint available" }
    }
  } catch (error) {
    return errorObservation(error)
  }
}

async function observeDiscovery(
  action: () => Promise<DiscoverySnapshotInfo>
): Promise<CapabilityObservation & { snapshot?: DiscoverySnapshotInfo | undefined }> {
  try {
    const snapshot = await action()
    return {
      availability: "available",
      reason: `ADT discovery returned ${snapshot.workspaces.length} workspaces and ${snapshot.coreEntries.length} core entries.`,
      evidence: { source: "discovery", detail: "ADT discovery response received" },
      snapshot
    }
  } catch (error) {
    return errorObservation(error)
  }
}

function discoverySummary(
  observation: CapabilityObservation & { snapshot?: DiscoverySnapshotInfo | undefined }
) {
  const snapshot = observation.snapshot
  return {
    availability: observation.availability,
    reason: observation.reason,
    workspaceCount: snapshot?.workspaces.length ?? 0,
    collectionCount:
      snapshot?.workspaces.reduce((count, workspace) => count + workspace.collections.length, 0) ??
      0,
    coreEntryCount: snapshot?.coreEntries.length ?? 0,
    resourceApplicationClassCount: snapshot?.resAppClasses.length ?? 0,
    ...(snapshot?.queryWarning ? { queryWarning: scrubSensitiveText(snapshot.queryWarning) } : {})
  }
}

function unknownTargetObservation(reason: string): CapabilityObservation {
  return {
    availability: "unknown",
    reason,
    evidence: { source: "local-contract", detail: "No target-specific operation was invoked" }
  }
}

function errorObservation(error: unknown): CapabilityObservation {
  const message = scrubSensitiveText(error instanceof Error ? error.message : String(error))
  const unsupported =
    /unsupported-endpoint(?: \(HTTP (?:404|405|501)\))?/i.test(message) ||
    /status code (?:404|405|501)\b/i.test(message) ||
    /HTTP (?:404|405|501)\b/i.test(message)
  return {
    availability: unsupported ? "unsupported" : "unknown",
    reason: unsupported
      ? `The connected SAP system rejected or does not expose this endpoint: ${message}`
      : `Read-only probe failed without proving endpoint absence: ${message}`,
    evidence: { source: "probe-error", detail: message }
  }
}

function safeBaseUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString().replace(/\/$/, "")
  } catch {
    return "invalid-configured-url"
  }
}

function scrubSensitiveText(value: string): string {
  return value
    .replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, "$1[REDACTED]@")
    .replace(/\b(password|token|cookie|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 1000)
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10) || 0)
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference) return difference
  }
  return 0
}

function countAvailability(capabilities: CapabilitySpec[]): Record<Availability, number> {
  return capabilities.reduce<Record<Availability, number>>(
    (summary, capabilityEntry) => {
      summary[capabilityEntry.observation.availability]++
      return summary
    },
    { available: 0, unsupported: 0, unknown: 0 }
  )
}
