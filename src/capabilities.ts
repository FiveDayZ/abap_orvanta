import type {
  DiscoverySnapshotInfo,
  SapBackend,
  SapDdicResult,
  SapHelperCapabilities,
  SapHelperResult,
  SapRepositoryResult
} from "./backend.js"
import { APPLICATION_LOG_HELPER } from "./application-logs.js"
import { SCI_E2_HELPER, SCI_V2_HELPER } from "./sci-v2.js"
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
  /** Present only when this helper was also probed for a `CAPABILITIES` self-description. */
  attestation?: SapHelperCapabilities | undefined
}

interface CapabilitySpec {
  id: string
  implementedLocally: true
  route: CapabilityRoute
  toolNames: string[]
  /** Present only when the active tool profile withholds part of `toolNames`. */
  disabledToolNames?: string[]
  observation: CapabilityObservation
}

const LOCAL_AVAILABLE: CapabilityObservation = {
  availability: "available",
  reason: "Implemented entirely by the standalone service and requires no SAP endpoint probe.",
  evidence: { source: "local-contract", detail: "Standalone runtime implementation" }
}

/**
 * Helper function modules behind the bounded helper read probes.
 *
 * Each helper is judged from **its own** attestation: the design deliberately keeps helpers
 * independent (mixed old/new deployments must not be collapsed into one verdict), so a
 * `Z_ORVANTA_MCP_EXECUTE` self-description is never projected onto the
 * `Z_ORVANTA_MCP_DYNPRO_API` operations. The repository helper carries the ten
 * `repository-helper-*` capabilities.
 *
 * All eight helpers are probed for `CAPABILITIES`, but they do not share one conclusion:
 * `Z_ORVANTA_MCP_EXECUTE` and `Z_ORVANTA_MCP_DYNPRO_API` implement the opcode in the generated
 * repository body, `Z_ORVANTA_MCP_DDIC_API` in its own body, and `Z_ORVANTA_MAINT_READ` /
 * `Z_ORVANTA_OPS_READ` / `Z_ORVANTA_LOG_READ` / `Z_ORVANTA_MCP_SCI_V2` / `Z_ORVANTA_MCP_SCI_E2`
 * answer it through the `EV_RESULT` JSON `payload` array. An un-upgraded helper keeps the previous
 * operation-scoped conclusion and wording.
 */
const BASE_HELPER_FUNCTION = "Z_ORVANTA_MCP_EXECUTE"
const REPOSITORY_HELPER_FUNCTION = "Z_ORVANTA_MCP_DYNPRO_API"
const DDIC_HELPER_FUNCTION = "Z_ORVANTA_MCP_DDIC_API"
const MAINTENANCE_HELPER_FUNCTION = "Z_ORVANTA_MAINT_READ"
const OPERATIONAL_LOG_HELPER_FUNCTION = "Z_ORVANTA_OPS_READ"
// Imported rather than re-declared: `application-logs.ts` owns the helper identity that the read
// tools call, so the probe, the service and the generator drift test read one constant.
const APPLICATION_LOG_HELPER_FUNCTION = APPLICATION_LOG_HELPER
// Same rule for the two SCI helpers: `sci-v2.ts` owns the identities that `run_sci_analysis`
// pins as `helperFingerprint`, so the probe and the tool cannot drift apart.
const SCI_V2_HELPER_FUNCTION = SCI_V2_HELPER
const SCI_E2_HELPER_FUNCTION = SCI_E2_HELPER

export async function buildCapabilityReport(
  backend: SapBackend,
  requestedConnectionId: string,
  disabledToolNames: readonly string[] = []
): Promise<string> {
  const connectionId = requestedConnectionId.toLowerCase()
  const connection = backend.connectionDetails(connectionId)
  const observedAt = new Date().toISOString()

  const [
    baseHelperRead,
    repositoryHelperRead,
    ddicHelper,
    baseAttestation,
    repositoryAttestation,
    ddicAttestation,
    maintenanceAttestation,
    operationalLogAttestation,
    applicationLogAttestation,
    sciV2Attestation,
    sciE2Attestation,
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
    observeHelperAttestation(BASE_HELPER_FUNCTION, () =>
      backend.probeHelperCapabilities(connectionId, BASE_HELPER_FUNCTION)
    ),
    observeHelperAttestation(REPOSITORY_HELPER_FUNCTION, () =>
      backend.probeHelperCapabilities(connectionId, REPOSITORY_HELPER_FUNCTION)
    ),
    observeHelperAttestation(DDIC_HELPER_FUNCTION, () =>
      backend.probeHelperCapabilities(connectionId, DDIC_HELPER_FUNCTION)
    ),
    observeHelperAttestation(MAINTENANCE_HELPER_FUNCTION, () =>
      backend.probeHelperCapabilities(connectionId, MAINTENANCE_HELPER_FUNCTION)
    ),
    observeHelperAttestation(OPERATIONAL_LOG_HELPER_FUNCTION, () =>
      backend.probeHelperCapabilities(connectionId, OPERATIONAL_LOG_HELPER_FUNCTION)
    ),
    observeHelperAttestation(APPLICATION_LOG_HELPER_FUNCTION, () =>
      backend.probeHelperCapabilities(connectionId, APPLICATION_LOG_HELPER_FUNCTION)
    ),
    observeHelperAttestation(SCI_V2_HELPER_FUNCTION, () =>
      backend.probeHelperCapabilities(connectionId, SCI_V2_HELPER_FUNCTION)
    ),
    observeHelperAttestation(SCI_E2_HELPER_FUNCTION, () =>
      backend.probeHelperCapabilities(connectionId, SCI_E2_HELPER_FUNCTION)
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

  const baseSelfDescription = reconcileAttestation(
    baseAttestation,
    baseHelperRead,
    BASE_HELPER_FUNCTION
  )
  const repositorySelfDescription = reconcileAttestation(
    repositoryAttestation,
    repositoryHelperRead,
    REPOSITORY_HELPER_FUNCTION
  )
  const ddicSelfDescription = reconcileAttestation(
    ddicAttestation,
    ddicHelper,
    DDIC_HELPER_FUNCTION
  )
  // Only the repository helper carries capability verdicts that depend on a self-description
  // (the ten `repository-helper-*` capabilities). The base helper's attestation is reported in
  // `helperAttestation` only, so every existing probe observation keeps its exact shape and
  // wording when the helpers are not upgraded yet.
  const repositoryHelper = attachAttestation(repositoryHelperRead, repositorySelfDescription)
  // The DDIC helper is probed for the same reason as the repository helper: a capability
  // verdict must follow the highest protocol the helper implements. Until the DDIC body is
  // regenerated it answers OPERATION_NOT_SUPPORTED, the probe stays operation-scoped, and the
  // read-probe verdicts below are unchanged.
  const ddicApiHelper = attachAttestation(ddicHelper, ddicSelfDescription)
  // The maintenance and operational-log helpers are probed as well, but their attestations are
  // reported only: their read tools are gated behind a local approval file, so the capability
  // report never performs the business read that a protocol verdict would need. The two
  // capability specifications below therefore keep their unchanged `unknownTargetObservation`,
  // and no attestation is attached to an observation that does not exist. Reconciliation still
  // runs for both, because a helper that answers under another identity must never become
  // evidence for this one.
  const maintenanceSelfDescription = reconcileAttestation(
    maintenanceAttestation,
    unprobedHelperObservation("maintenance"),
    MAINTENANCE_HELPER_FUNCTION
  )
  const operationalLogSelfDescription = reconcileAttestation(
    operationalLogAttestation,
    unprobedHelperObservation("operational-log"),
    OPERATIONAL_LOG_HELPER_FUNCTION
  )
  // The application-log helper answers through the same JSON envelope and its reads are
  // approval-gated as well, so its self-description alone carries the capability verdict below.
  const applicationLogSelfDescription = reconcileAttestation(
    applicationLogAttestation,
    unprobedHelperObservation("application-log"),
    APPLICATION_LOG_HELPER_FUNCTION
  )
  // The two SCI helpers are probed for the same reason and reported the same way: their operations
  // are target-specific SCI inspections that need an explicit customer target and rule profile, so
  // the capability report performs no inspection of its own. Neither helper has a capability
  // specification that follows its self-description yet, so the attestation stays report-only and
  // `scoped-sci-quality` keeps its unchanged `unknownTargetObservation`.
  const sciV2SelfDescription = reconcileAttestation(
    sciV2Attestation,
    unprobedSciHelperObservation("sci-v2"),
    SCI_V2_HELPER_FUNCTION
  )
  const sciE2SelfDescription = reconcileAttestation(
    sciE2Attestation,
    unprobedSciHelperObservation("sci-e2"),
    SCI_E2_HELPER_FUNCTION
  )

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
      ["read_abap_table", "preview_configuration", "read_ddic_table_conversion_status"],
      unknownTargetObservation(
        "Requires live table metadata and a successful query; the legacy alternative additionally requires the reviewed RFC reader and a supported full-row layout."
      )
    ),
    capability("adt-transport-read", "native-adt", ["manage_transport_requests"], transports),
    capability(
      "adt-transport-entry-cleanup",
      "target-specific",
      ["cleanup_transport_entries"],
      unknownTargetObservation(
        "Requires one exact modifiable CTS task, complete object position metadata, and successful native ADT removeobject support on the target system."
      )
    ),
    capability(
      "adt-runtime-dumps",
      "native-adt",
      ["analyze_abap_dumps", "diagnose_sap_failure"],
      dumps
    ),
    capability("adt-runtime-traces", "native-adt", ["analyze_abap_traces"], traces),
    capability("sap-base-helper", "sap-helper-fallback", ["sap_helper_status"], baseHelperRead),
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
    helperCapability("repository-helper-enhancement-lifecycle", repositoryHelper, "2.6", [
      "read_enhancement_implementation",
      "create_enhancement_hook_implementation",
      "create_new_badi_implementation",
      "update_enhancement_hook_implementation",
      "update_new_badi_implementation",
      "manage_enhancement_implementation_state",
      "delete_enhancement_implementation",
      "manage_classic_badi_implementation"
    ]),
    helperCapability("repository-helper-function-source-write", repositoryHelper, "2.7", [
      "write_function_module_source"
    ]),
    helperCapability("ddic-helper-core", ddicApiHelper, "1.2", [
      "read_ddic_domain",
      "upsert_ddic_domain",
      "read_ddic_data_element",
      "upsert_ddic_data_element",
      "read_ddic_structure",
      "upsert_ddic_structure",
      "read_ddic_table_type",
      "upsert_ddic_table_type"
    ]),
    helperCapability("ddic-helper-transparent-table", ddicApiHelper, "1.5", [
      "read_ddic_transparent_table",
      "create_ddic_transparent_table"
    ]),
    helperCapability("ddic-helper-transparent-table-complex", ddicApiHelper, "1.7", [
      "append_ddic_transparent_table_fields",
      "patch_ddic_transparent_table_fields",
      "patch_ddic_transparent_table_settings",
      "recover_ddic_table_conversion"
    ]),
    helperCapability("ddic-helper-controlled-delete", ddicApiHelper, "1.6", ["delete_ddic_object"]),
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
    capability(
      "enhancement-source-inspection",
      "target-specific",
      ["inspect_source_enhancements"],
      unknownTargetObservation(
        "Reads active ADT enhancement implementation elements for one source object, preserving implementation, element, position, replacement, and enhanced-object metadata alongside exact source markers. It does not attest New BAdI definitions, filters, switches, runtime execution, SMOD/CMOD projects, BTE products, or FI validation/substitution configuration."
      )
    ),
    capability(
      "enhancement-repository-search",
      "target-specific",
      ["search_enhancement_objects"],
      unknownTargetObservation(
        "Searches ENHC, ENHS, ENHO, BADI, and BADII independently and preserves per-type failures. Raw repository search does not determine Classic versus New BAdI or prove activation, filters, switches, configuration, or runtime use."
      )
    ),
    capability(
      "customer-exit-repository-search",
      "target-specific",
      ["search_customer_exit_objects"],
      unknownTargetObservation(
        "Searches SMOD enhancement definitions and CMOD enhancement projects independently and preserves per-type failures. Repository search does not inspect components, assignments, activation state, screens, menus, or implementation includes."
      )
    ),
    capability(
      "customer-exit-definition-read",
      "target-specific",
      ["read_customer_exit_definition"],
      unknownTargetObservation(
        "Reads one exact SMOD enhancement definition and its MODSAP components through the SAP repository helper. It preserves raw component types and does not prove CMOD assignment, activation, implementation, or runtime execution."
      )
    ),
    capability(
      "customer-exit-project-read",
      "target-specific",
      ["read_customer_exit_project"],
      unknownTargetObservation(
        "Reads one exact CMOD project, its raw MODATTR status, and MODACT enhancement assignments through the SAP repository helper. It does not interpret release-specific status values or prove implementation and runtime execution."
      )
    ),
    capability(
      "customer-function-exit-inspection",
      "target-specific",
      ["inspect_customer_function_exits"],
      unknownTargetObservation(
        "Correlates static CALL CUSTOMER-FUNCTION statements in one active main program and its bounded include graph with exact EXIT_<program>_<number> function modules and readable ZX implementation includes. It does not inspect SMOD component metadata, CMOD assignment or activation, screen exits, menu exits, or runtime execution."
      )
    ),
    capability(
      "customer-screen-menu-exit-inspection",
      "target-specific",
      ["inspect_customer_screen_menu_exits"],
      unknownTargetObservation(
        "Reads explicitly requested active screen flow logic for CALL CUSTOMER-SUBSCREEN hooks and optionally reads active GUI definitions for plus-prefixed menu function codes. It does not prove SMOD component membership, CMOD assignment or activation, customer implementations, menu text activation, or runtime execution."
      )
    ),
    capability(
      "bte-dispatcher-search",
      "target-specific",
      ["search_bte_dispatchers"],
      unknownTargetObservation(
        "Searches standard OPEN_FI_PERFORM event and process dispatcher function modules independently. It does not inspect FIBF products, handler assignments, activation, order, or runtime execution."
      )
    ),
    capability(
      "bte-configuration-read",
      "target-specific",
      ["read_bte_configuration"],
      unknownTargetObservation(
        "Reads one exact BTE Event or Process definition, SAP-application handlers, customer-product handlers, and raw activation flags through the SAP repository helper. It does not invoke handlers, determine runtime execution order, or modify FIBF configuration."
      )
    ),
    capability(
      "enhancement-configuration-controlled-workflow",
      "target-specific",
      ["prepare_enhancement_configuration_workflow"],
      unknownTargetObservation(
        "Prepares transaction-specific CMOD, FIBF, GGB0/GGB1, and OB28/OBBH human workflows from available exact read evidence. It identifies missing inputs, transport controls, confirmation points, stop conditions, readback, and runtime acceptance without opening SAP GUI or changing configuration."
      )
    ),
    capability(
      "badi-repository-subtype-search",
      "target-specific",
      ["search_badi_objects"],
      unknownTargetObservation(
        "Searches exact Classic BAdI definition and implementation subtypes, New BAdI implementation subtype, and Enhancement Spot containers independently. It does not inspect New BAdI definitions inside spots, interfaces, filters, Multiple Use, switches, activation, or runtime execution."
      )
    ),
    capability(
      "classic-badi-definition-read",
      "target-specific",
      ["read_classic_badi_definition"],
      unknownTargetObservation(
        "Reads one exact Classic BAdI definition, interfaces, filter and Multiple Use attributes, implementation assignments, implementation classes, filter values, and raw activation flags through the SAP repository helper. It does not inspect New BAdIs, switches, or runtime execution."
      )
    ),
    capability(
      "enhancement-framework-source-inspection",
      "target-specific",
      ["inspect_enhancement_framework"],
      unknownTargetObservation(
        "Reads explicit Enhancement Point and Section declarations and derives implicit candidates from active source boundaries. Candidate positions require SAP enhancement-editor confirmation and do not prove activation, switch state, or runtime execution."
      )
    ),
    capability(
      "fico-rule-exit-source-inspection",
      "target-specific",
      ["inspect_fico_rule_exit_program"],
      unknownTargetObservation(
        "Correlates GET_EXIT_TITLES catalog declarations with FORM implementations in one active FI validation or substitution exit program. It does not read GGB0/GGB1 rules, OB28/OBBH activation, call-up points, prerequisites, sets, or runtime execution."
      )
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
      applicationLogObservation(applicationLogSelfDescription)
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

  // The tool profile disclosure only appears when a profile or deny list actually withholds
  // tools, so the default `full` configuration keeps the previous tool-profile shape.
  const withheld = new Set(disabledToolNames)
  const disclosed = capabilities.map((item) => discloseToolProfile(item, withheld))

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
      ...(withheld.size > 0
        ? {
            toolProfile: {
              disabledToolCount: withheld.size,
              note: "ABAP_MCP_TOOL_PROFILE / ABAP_MCP_TOOL_DENY withhold these tools from tools/list and reject tools/call; they are removed from toolNames and listed under disabledToolNames."
            }
          }
        : {}),
      helpers: [baseHelperRead, repositoryHelperRead, ddicHelper],
      // Stable order, and the only place a helper order is defined: base, repository, DDIC,
      // maintenance, operational-log, application-log, SCI V2, SCI E2. Appending the two SCI
      // helpers keeps every earlier index stable for callers that address the array positionally.
      helperAttestation: [
        baseSelfDescription,
        repositorySelfDescription,
        ddicSelfDescription,
        maintenanceSelfDescription,
        operationalLogSelfDescription,
        applicationLogSelfDescription,
        sciV2SelfDescription,
        sciE2SelfDescription
      ],
      discovery: discoverySummary(discovery),
      capabilities: disclosed,
      summary: {
        toolCount: disclosed.reduce((count, item) => count + item.toolNames.length, 0),
        ...(withheld.size > 0
          ? {
              disabledToolCount: disclosed.reduce(
                (count, item) => count + (item.disabledToolNames?.length ?? 0),
                0
              )
            }
          : {}),
        capabilityCount: disclosed.length,
        ...countAvailability(disclosed)
      }
    },
    null,
    2
  )
}

function discloseToolProfile(spec: CapabilitySpec, withheld: Set<string>): CapabilitySpec {
  if (withheld.size === 0) return spec
  const disabled = spec.toolNames.filter((name) => withheld.has(name))
  if (disabled.length === 0) return spec
  return {
    ...spec,
    toolNames: spec.toolNames.filter((name) => !withheld.has(name)),
    disabledToolNames: disabled
  }
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
  // A helper self-description is authoritative when it exists: the helper reports the highest
  // protocol version it implements, not the version of the operation that happened to run.
  const attestation = helper.attestation
  if (attestation?.attestation === "self-described" && attestation.maxProtocol) {
    const satisfied = compareVersions(attestation.maxProtocol, minimumVersion) >= 0
    return capability(id, "sap-helper-fallback", toolNames, {
      availability: satisfied ? "available" : "unsupported",
      reason: satisfied
        ? `The ${attestation.helper} helper self-described protocol ${attestation.maxProtocol}, which satisfies minimum ${minimumVersion}.`
        : `The ${attestation.helper} helper self-described protocol ${attestation.maxProtocol}, which is below the required capability version ${minimumVersion}.`,
      evidence: {
        source: "version-check",
        detail: `${attestation.helper} self-described protocol ${attestation.maxProtocol} (lowest compatible ${attestation.minProtocol ?? "unknown"}); capability minimum ${minimumVersion}`
      }
    })
  }
  const available = compareVersions(helper.protocolVersion, minimumVersion) >= 0
  return capability(id, "sap-helper-fallback", toolNames, {
    availability: available ? "available" : "unknown",
    reason: available
      ? `The observed ${helper.name} read protocol ${helper.protocolVersion} satisfies minimum ${minimumVersion}.`
      : `The read probe observed ${helper.name} operation protocol ${helper.protocolVersion}; it does not prove whether capability version ${minimumVersion} is installed.`,
    evidence: {
      source: "version-check",
      detail: `${helper.name} observed operation protocol ${helper.protocolVersion}; capability minimum ${minimumVersion}${attestationMismatchNote(attestation)}`
    }
  })
}

/**
 * Only an identity mismatch changes the fallback wording: the helper answered another name, so
 * its self-description was discarded instead of being used as evidence for this helper.
 */
function attestationMismatchNote(attestation: SapHelperCapabilities | undefined): string {
  if (attestation?.attestation !== "operation-scoped" || !attestation.detail) return ""
  return `; ${attestation.detail}`
}

/**
 * The read probe already proved that the helper answers a structured protocol response, so a
 * failed `CAPABILITIES` probe on that helper cannot mean "not deployed": it means the opcode is
 * missing. Reporting `absent` there would describe a deployed helper as missing.
 *
 * A self-description that names a different helper is never evidence for this helper, so it is
 * downgraded here - the report and the capability verdict must agree on the same conclusion.
 */
function reconcileAttestation(
  attestation: SapHelperCapabilities,
  observation: VersionedHelperObservation,
  expectedHelperFunction: string
): SapHelperCapabilities {
  if (
    attestation.attestation === "self-described" &&
    attestation.helper.trim().toUpperCase() !== expectedHelperFunction
  ) {
    return {
      ...attestation,
      attestation: "operation-scoped",
      detail: `Self-description declared helper ${attestation.helper} instead of ${expectedHelperFunction}; ignored`
    }
  }
  if (attestation.attestation !== "absent") return attestation
  if (observation.availability !== "available") return attestation
  return { ...attestation, attestation: "operation-scoped" }
}

function attachAttestation(
  observation: VersionedHelperObservation,
  attestation: SapHelperCapabilities
): VersionedHelperObservation {
  if (attestation.attestation === "absent") return observation
  return { ...observation, attestation }
}

/**
 * Placeholder observation for a helper the capability report does not read.
 *
 * `reconcileAttestation` needs the read-probe conclusion to decide whether an `absent`
 * attestation actually means "not deployed". The maintenance and operational-log reads are
 * gated behind a local approval file, so probing them here would either fail the report or
 * perform an unapproved SAP read; this observation states that no read happened, which keeps
 * `absent` an `absent` and leaves only the identity guard active.
 */
function unprobedHelperObservation(name: string): VersionedHelperObservation {
  return {
    name,
    availability: "unknown",
    reason: `No bounded read probe is performed for the ${name} helper; its reads are approval-gated.`,
    evidence: {
      source: "local-contract",
      detail: "Approval-gated helper; the capability report only asks for its self-description"
    }
  }
}

/**
 * Placeholder observation for an SCI helper the capability report never runs.
 *
 * Same purpose as `unprobedHelperObservation`, but the reason differs: the SCI helpers are not
 * approval-gated. Their operations are target-specific SCI inspections that need an explicit
 * customer PROG/CLAS/FUGR target and a rule profile, so no self-description-dependent capability
 * verdict may be derived from a probe that ran nothing. Only the identity guard and the
 * `absent`-stays-`absent` rule need this observation.
 */
function unprobedSciHelperObservation(name: string): VersionedHelperObservation {
  return {
    name,
    availability: "unknown",
    reason: `No SCI inspection is run for the ${name} helper; its operations need an explicit customer target and rule profile.`,
    evidence: {
      source: "local-contract",
      detail: "Target-specific SCI helper; the capability report only asks for its self-description"
    }
  }
}

/**
 * Bounded `CAPABILITIES` probe. `SapBackend.probeHelperCapabilities` is documented never to
 * throw, but a report must not fail because an implementation or a transport did: a thrown
 * probe degrades to `absent`, exactly like an unreachable helper.
 */
async function observeHelperAttestation(
  helper: string,
  action: () => Promise<SapHelperCapabilities>
): Promise<SapHelperCapabilities> {
  try {
    return await action()
  } catch (error) {
    return {
      helper,
      minProtocol: null,
      maxProtocol: null,
      operations: [],
      scopes: [],
      sourceHash: null,
      packageName: null,
      transport: null,
      host: null,
      observedAt: new Date().toISOString(),
      attestation: "absent",
      detail: scrubSensitiveText(error instanceof Error ? error.message : String(error))
    }
  }
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

// Unchanged wording for every application-log outcome that is not a matching self-description.
const APPLICATION_LOG_UNKNOWN_REASON =
  "Requires separately deployed, source/interface-pinned Z_ORVANTA_LOG_READ and local administrator approval; message reads need separate approval. Registration does not prove SLG1 access or read-only SAP behavior."

/**
 * The application-log helper answers `CAPABILITIES` through the `EV_RESULT` JSON envelope and its
 * read tools are approval-gated, so no read observation exists on this connection. A matching
 * self-description is therefore the only fact that can move the verdict off `unknown`; a helper
 * that answered any envelope is deployed, so a failed `CAPABILITIES` probe never reads as missing.
 */
function applicationLogObservation(attestation: SapHelperCapabilities): CapabilityObservation {
  if (
    attestation.attestation === "self-described" &&
    attestation.maxProtocol &&
    attestation.helper.trim().toUpperCase() === APPLICATION_LOG_HELPER_FUNCTION
  ) {
    return {
      availability: "available",
      reason: `The ${attestation.helper} helper self-described protocol ${attestation.maxProtocol}; the tools additionally still require local administrator approval, and message reads need separate approval.`,
      evidence: {
        source: "version-check",
        detail: `${attestation.helper} self-described protocol ${attestation.maxProtocol} (lowest compatible ${attestation.minProtocol ?? "unknown"}); no approval-gated read probe was performed`
      }
    }
  }
  return unknownTargetObservation(APPLICATION_LOG_UNKNOWN_REASON)
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
