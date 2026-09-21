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
import { registryEntry } from "./tool-registry.js"
import { PRODUCT_VERSION } from "./version.js"

type Availability = "available" | "unsupported" | "platform_unsupported" | "unknown"
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

/**
 * The helper-backed capability specifications, as `id -> covered tools`.
 *
 * Deliberately **without** a helper name or a minimum protocol: both are read from the tool
 * registry, so this table cannot disagree with the routing it describes. Capability ids stay
 * spelled out because they are a user-visible contract, not a derived label.
 */
export const HELPER_CAPABILITY_TOOLS: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    "repository-helper-dynpro-core",
    [
      "read_abap_screen",
      "upsert_abap_screen",
      "create_module_pool",
      "delete_module_pool",
      "read_transaction_code",
      "create_transaction_code",
      "delete_transaction_code"
    ]
  ],
  ["repository-helper-report-transaction", ["create_report_transaction"]],
  [
    "repository-helper-function-interface",
    [
      "read_function_module_interface",
      "create_function_module_with_interface",
      "inspect_repository_assignment"
    ]
  ],
  ["repository-helper-screen-patch", ["patch_abap_screen", "validate_dynpro_application"]],
  ["repository-helper-gui-definition", ["read_abap_gui_definition", "patch_abap_gui_definition"]],
  [
    "repository-helper-ecc-fallbacks",
    ["read_abap_message_class", "create_abap_message_class", "manage_text_elements"]
  ],
  ["repository-helper-message-update", ["update_abap_message_class"]],
  ["repository-helper-message-delete", ["delete_abap_message_class"]],
  ["repository-helper-function-interface-patch", ["patch_function_module_interface"]],
  [
    "repository-helper-enhancement-lifecycle",
    [
      "read_enhancement_implementation",
      "create_enhancement_hook_implementation",
      "create_new_badi_implementation",
      "update_enhancement_hook_implementation",
      "update_new_badi_implementation",
      "manage_enhancement_implementation_state",
      "delete_enhancement_implementation",
      "manage_classic_badi_implementation"
    ]
  ],
  ["repository-helper-function-source-write", ["write_function_module_source"]],
  [
    "ddic-helper-core",
    [
      "read_ddic_domain",
      "upsert_ddic_domain",
      "read_ddic_data_element",
      "upsert_ddic_data_element",
      "read_ddic_structure",
      "upsert_ddic_structure",
      "read_ddic_table_type",
      "upsert_ddic_table_type"
    ]
  ],
  [
    "ddic-helper-transparent-table",
    ["read_ddic_transparent_table", "create_ddic_transparent_table"]
  ],
  [
    "ddic-helper-transparent-table-complex",
    [
      "append_ddic_transparent_table_fields",
      "patch_ddic_transparent_table_fields",
      "patch_ddic_transparent_table_settings",
      "recover_ddic_table_conversion"
    ]
  ],
  // Resuming an activation is a distinct recovery route: it needs the newer
  // RESUME_TRANSPARENT_TABLE_ACTIVATION opcode, so it cannot share the 1.7 table-complex group.
  ["ddic-helper-table-activation-resume", ["resume_ddic_table_activation"]],
  ["ddic-helper-controlled-delete", ["delete_ddic_object"]],
  // Search help is its own DDIC object kind with its own helper operations (READ_SEARCH_HELP /
  // UPSERT_SEARCH_HELP / DELETE_SEARCH_HELP), so it gets its own capability rather than being folded
  // into ddic-helper-core. Without this entry the coverage assertion in tools.test.ts fails: those
  // two tools are routable but belonged to no capability, which is exactly the drift the assertion
  // exists to catch.
  ["ddic-helper-search-help", ["read_search_help", "upsert_search_help"]],
  // Lock objects are a third DDIC object kind with their own helper operations (READ_LOCK_OBJECT /
  // UPSERT_LOCK_OBJECT / DELETE_LOCK_OBJECT), so they get their own capability rather than being
  // folded into ddic-helper-core. Deletion goes through delete_ddic_object, so only the read and
  // upsert tools are listed here.
  ["ddic-helper-lock-object", ["read_lock_object", "upsert_lock_object"]]
]

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
  // The base helper carries versioned capability verdicts too: the registry routes
  // `write_function_module_source` (2.7) and `patch_function_module_interface` (2.0) through
  // `Z_ORVANTA_MCP_EXECUTE`, because the shared repository body implements those opcodes and the
  // native ADT lock/save path is what fails on w200. Its observation therefore needs the same
  // self-description treatment as the repository and DDIC helpers.
  const baseHelper = attachAttestation(baseHelperRead, baseSelfDescription)
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
  // Helper and minimum protocol come from the registry, so the capability specifications below
  // cannot drift away from the tool routing. Only the observation is supplied here.
  const helperObservations: HelperObservations = {
    [BASE_HELPER_FUNCTION]: baseHelper,
    [REPOSITORY_HELPER_FUNCTION]: repositoryHelper,
    [DDIC_HELPER_FUNCTION]: ddicApiHelper
  }
  // Measured platform boundary, shared by the debugger entry and the `quality` block so the two
  // can never disagree about what the target advertised.
  const platformFacts = advertisedEndpoints(discovery)
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
    // The native free-query service and the system-info tool do not share a verdict. The probe
    // fails with an empty HTML page rather than a 404, which `errorObservation` alone can only call
    // `unknown`; combined with the discovery measurement it is a platform boundary. `system-info`
    // is not judged by that probe because it falls back to the scoped query helper.
    capability(
      "adt-data-preview",
      "native-adt",
      ["execute_data_query"],
      probeFailureObservation(
        query,
        platformFacts.advertised.dataPreview,
        "the ADT data preview service",
        PLATFORM_ENDPOINTS.dataPreview
      )
    ),
    capability(
      "system-info",
      "native-adt",
      ["get_sap_system_info"],
      unknownTargetObservation(
        "get_sap_system_info falls back to the scoped query helper when the native data preview service is absent, so its availability is decided by that helper and the caller's authorization rather than by the native endpoint probe. See adt-data-preview for the native verdict."
      )
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
    ...helperCapabilityRoutes().map((route) => {
      const helper = helperObservations[route.helper]
      if (!helper) {
        throw new Error(
          `Capability ${route.id} routes through ${route.helper}, which has no capability observation`
        )
      }
      return helperCapability(route.id, helper, route.minimumVersion, route.toolNames)
    }),
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
    // Native ATC and ABAP Unit have different platform realities on this target - the Test Cockpit
    // publishes no collections while the ABAP Unit service is advertised - so they must not share
    // one verdict. Bundling them is exactly how `run_atc_analysis` stayed `unknown`, which is
    // unreadable as "platform boundary" and therefore hid a permanent limitation. `adt-quality`
    // keeps its id and its ATC meaning; the ABAP Unit tool moves out from under it.
    capability(
      "adt-quality",
      "target-specific",
      ["run_atc_analysis"],
      platformBoundaryObservation(
        platformFacts.advertised.atc,
        "ABAP Test Cockpit",
        PLATFORM_ENDPOINTS.atc,
        "This verdict covers native ATC only. An SCI result is reported under scoped-sci-quality and is never ATC; see quality.atcCapability."
      )
    ),
    capability(
      "adt-abap-unit",
      "target-specific",
      ["run_unit_tests"],
      platformBoundaryObservation(
        platformFacts.advertised.abapUnit,
        "ABAP Unit",
        PLATFORM_ENDPOINTS.abapUnit,
        "Availability additionally depends on a testable object and an authorized run; registration alone is not proof."
      )
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
      platformBoundaryObservation(
        platformFacts.advertised.debugger,
        "debugger",
        PLATFORM_ENDPOINTS.debugger,
        "Availability depends on the debugger endpoint and on an explicitly authorized debug session; registration alone is not proof."
      )
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
      quality: qualityBlock(discovery, traces),
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

/**
 * Helper observations keyed by the SAP function module the tool registry routes to.
 *
 * The registry - not this file - decides which helper a tool calls and which minimum protocol
 * that tool needs. This map only says how each helper was observed. Keeping the two apart is
 * what makes drift impossible to ship: a capability can no longer name a helper or a minimum
 * version that contradicts the registry, which is exactly how
 * `repository-helper-function-source-write` once reported a deployed capability as
 * `unsupported` (judged against the repository helper at 2.6 while the registry had already
 * moved the tool to the base helper at 2.7).
 *
 * Only the three helpers with versioned capability specifications appear here. The maintenance,
 * operational-log, application-log and SCI helpers are reported through `helperAttestation` but
 * have no capability spec that follows a protocol version, so they have nothing to key.
 */
type HelperObservations = Record<string, VersionedHelperObservation | undefined>

/** One resolved capability route: which helper the registry sends these tools to, at which minimum. */
export interface HelperCapabilityRoute {
  id: string
  helper: string
  minimumVersion: string
  toolNames: string[]
}

/**
 * Resolve a helper capability against the tool registry.
 *
 * Throws instead of guessing: an unregistered tool, a tool the registry does not route through a
 * versioned helper, or a capability whose tools disagree about helper or minimum protocol are all
 * programming errors, and a capability report that silently papers over them is precisely the
 * failure this replaced.
 */
export function resolveHelperCapabilityRoute(
  id: string,
  toolNames: readonly string[]
): HelperCapabilityRoute {
  const routed = toolNames.map((name) => {
    const entry = registryEntry(name)
    if (!entry) throw new Error(`Capability ${id} names unregistered tool ${name}`)
    if (!entry.sapHelper || !entry.minHelperProtocol) {
      throw new Error(
        `Capability ${id} names tool ${name}, which the registry does not route through a versioned SAP helper`
      )
    }
    return { name, helper: entry.sapHelper, minimum: entry.minHelperProtocol }
  })
  const [first] = routed
  if (!first) throw new Error(`Capability ${id} names no tools`)
  for (const item of routed) {
    if (item.helper !== first.helper || item.minimum !== first.minimum) {
      throw new Error(
        `Capability ${id} mixes helper routes: ${item.name} needs ${item.helper} ${item.minimum} ` +
          `while ${first.name} needs ${first.helper} ${first.minimum}`
      )
    }
  }
  return {
    id,
    helper: first.helper,
    minimumVersion: first.minimum,
    toolNames: [...toolNames]
  }
}

/**
 * Every helper capability resolved against the registry.
 *
 * This is the whole drift gate, and it is pure: no backend, no observation, no SAP access. `npm
 * run matrix:check` calls it, so a capability that disagrees with the registry fails the build
 * check instead of surfacing as a wrong verdict in a live report.
 */
export function helperCapabilityRoutes(): HelperCapabilityRoute[] {
  return HELPER_CAPABILITY_TOOLS.map(([id, toolNames]) =>
    resolveHelperCapabilityRoute(id, toolNames)
  )
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

/**
 * ADT collection prefixes that decide the platform-boundary verdicts.
 *
 * A 7.31 system advertises far fewer services than a modern one, and the difference has to be
 * *measured* rather than assumed: this map is matched against the collections the target actually
 * advertised, so `quality` below reports what the platform exposes instead of restating a
 * constant. The distinction that matters is "the platform publishes no collections for this
 * service" versus "this round did not probe it" - the two used to look identical, which is how
 * tools stayed registered while being permanently unusable with no explanation.
 */
/**
 * A rejection that proves the endpoint exists: it was reached and answered with an authorization
 * verdict. Discovery silence must not be allowed to overrule that into "not exposed".
 */
const AUTHORIZATION_REJECTION = /(?:status code|HTTP)\s*40[13]\b|forbidden|not authorized/i

const PLATFORM_ENDPOINTS = {
  abapUnit: "/sap/bc/adt/abapunit",
  atc: "/sap/bc/adt/atc",
  debugger: "/sap/bc/adt/debugger",
  runtimeTraces: "/sap/bc/adt/runtime/traces",
  cds: "/sap/bc/adt/ddic/ddl",
  dcl: "/sap/bc/adt/acm/dcl",
  // Both the freestyle and the ddic data-preview requests live under this prefix.
  dataPreview: "/sap/bc/adt/datapreview"
} as const

interface AdvertisedEndpoints {
  /** True when the target advertised at least one collection under this prefix. */
  advertised: Record<keyof typeof PLATFORM_ENDPOINTS, boolean>
  /** Workspace titles that carried no collections, e.g. a service the platform knows but hides. */
  emptyWorkspaces: string[]
  collectionCount: number
}

function advertisedEndpoints(
  observation: CapabilityObservation & { snapshot?: DiscoverySnapshotInfo | undefined }
): AdvertisedEndpoints {
  const workspaces = observation.snapshot?.workspaces ?? []
  const collectionCount = workspaces.reduce(
    (count, workspace) => count + workspace.collections.length,
    0
  )
  const hrefs = workspaces.flatMap((workspace) =>
    workspace.collections.map((collection) => collection.href)
  )
  const advertised = {} as Record<keyof typeof PLATFORM_ENDPOINTS, boolean>
  for (const [name, prefix] of Object.entries(PLATFORM_ENDPOINTS)) {
    advertised[name as keyof typeof PLATFORM_ENDPOINTS] = hrefs.some((href) =>
      href.startsWith(prefix)
    )
  }
  return {
    advertised,
    emptyWorkspaces: workspaces
      .filter((workspace) => workspace.collections.length === 0)
      .map((workspace) => workspace.title),
    collectionCount
  }
}

/**
 * The measured quality verdicts.
 *
 * Every value is derived from the discovery advertising observed on this connection, so a caller
 * can tell "this platform does not expose native ATC" from "nobody has checked yet". `sci_only`
 * means native ATC is not advertised while the service still implements the SCI route locally; the
 * SCI helper's own runtime state is deliberately *not* claimed here - it is reported separately by
 * `scoped-sci-quality`, because discovery does not execute or attest helpers.
 */
function qualityBlock(
  discovery: CapabilityObservation & { snapshot?: DiscoverySnapshotInfo | undefined },
  traces: CapabilityObservation
): Record<string, unknown> {
  const facts = advertisedEndpoints(discovery)
  const unreachable = (endpoint: keyof typeof PLATFORM_ENDPOINTS, label: string) =>
    facts.advertised[endpoint]
      ? `${label} is advertised by ADT discovery on this connection.`
      : `The platform did not advertise any ${label} collection in ADT discovery (${facts.collectionCount} collections over ${facts.emptyWorkspaces.length} empty workspace title(s)${facts.emptyWorkspaces.length > 0 ? `: ${facts.emptyWorkspaces.join(", ")}` : ""}). Native ${label} is therefore unavailable here; this is a platform boundary on the target, not an unprobed state.`
  const entry = (value: string, reason: string) => ({ value, reason })

  return {
    basis: "ADT discovery advertising observed on this connection",
    advertisedCollectionCount: facts.collectionCount,
    emptyWorkspaceTitles: facts.emptyWorkspaces,
    atcCapability: facts.advertised.atc
      ? entry("native", unreachable("atc", "ABAP Test Cockpit"))
      : entry(
          "sci_only",
          `${unreachable("atc", "ABAP Test Cockpit")} The service implements the SCI route locally, but run_sci_analysis must not be read as native ATC; the SCI helper's own state is reported by scoped-sci-quality.`
        ),
    traceCapability: entry(
      facts.advertised.runtimeTraces ? "supported" : "unsupported",
      `${unreachable("runtimeTraces", "runtime trace")} Trace probe evidence: ${traces.reason}`
    ),
    debuggerCapability: entry(
      facts.advertised.debugger ? "supported" : "platform_unsupported",
      unreachable("debugger", "debugger")
    ),
    cdsDclCapability: entry(
      facts.advertised.cds || facts.advertised.dcl ? "supported" : "platform_unsupported",
      `${unreachable("cds", "CDS/DDLS")} ${unreachable("dcl", "DCL")} The service still understands DDLS/DF and DCLS/DL source URIs locally, so such an object is addressable but cannot be read from this target.`
    )
  }
}

/**
 * A read probe that failed without the endpoint ever being advertised.
 *
 * `errorObservation` sees only the error, so an endpoint that answers with an empty HTML page
 * instead of a 404 looks like an unproven gap and stays `unknown` indefinitely. When discovery
 * shows the endpoint is not advertised either, the two measurements together do establish absence,
 * and `unknown` would understate what is actually known.
 *
 * A 401/403 is deliberately excluded: it proves the endpoint was reached and answered, so absence
 * is not the better explanation and the observation keeps its `unknown` verdict. Likewise an
 * available probe, an explicit rejection carrying a status, and an advertised endpoint all stand
 * as measured.
 */
function probeFailureObservation(
  observation: CapabilityObservation,
  advertised: boolean,
  label: string,
  endpoint: string
): CapabilityObservation {
  if (advertised || observation.availability !== "unknown") return observation
  if (AUTHORIZATION_REJECTION.test(observation.evidence.detail)) return observation
  return {
    availability: "platform_unsupported",
    reason: `The target did not advertise ${endpoint} in ADT discovery, and the read-only probe failed without a usable result, so this service is not exposed here. ${observation.reason}`,
    evidence: {
      source: "discovery",
      detail: `${label} absent from the ADT discovery response; ${observation.evidence.detail}`
    }
  }
}

function unknownTargetObservation(reason: string): CapabilityObservation {
  return {
    availability: "unknown",
    reason,
    evidence: { source: "local-contract", detail: "No target-specific operation was invoked" }
  }
}

/**
 * A verdict for tools the platform cannot serve, as opposed to tools nobody has exercised yet.
 *
 * `unknown` is the honest answer when availability depends on an object or target that was not
 * supplied. It is the wrong answer when the measured discovery advertising already proves the
 * endpoint does not exist here: a tool that is registered but permanently unusable must say so,
 * otherwise the caller cannot tell a platform boundary from missing verification work.
 */
function platformBoundaryObservation(
  advertised: boolean,
  label: string,
  endpoint: string,
  detail: string
): CapabilityObservation {
  if (advertised) return unknownTargetObservation(detail)
  return {
    availability: "platform_unsupported",
    reason: `The target did not advertise ${endpoint} in ADT discovery, so this service is not exposed here. ${detail}`,
    evidence: {
      source: "discovery",
      detail: `${label} absent from the ADT discovery response`
    }
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
    { available: 0, unsupported: 0, platform_unsupported: 0, unknown: 0 }
  )
}
