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
      ["get_connected_systems", "get_capability_report", "get_abap_sql_syntax"],
      LOCAL_AVAILABLE
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
    capability("adt-transport-read", "native-adt", ["manage_transport_requests"], transports),
    capability("adt-runtime-dumps", "native-adt", ["analyze_abap_dumps"], dumps),
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
      "adt-quality",
      "target-specific",
      ["run_atc_analysis", "run_unit_tests"],
      targetSpecific
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
