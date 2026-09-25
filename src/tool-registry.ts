/**
 * ORVANTA tool registry - single source of truth for the MCP tool surface.
 *
 * Purpose
 * - Keep tool name, taxonomy, profile membership, risk annotations and SAP helper
 *   dependency in exactly one place, so the generated index (`docs/tool-index.md`,
 *   `contracts/tool-index.json`) and the runtime registration cannot drift apart.
 *
 * Rules enforced by `npm run matrix:check`
 * - Every registry name must exist in `toolContracts` and vice versa (no gaps, no extras).
 * - Registry annotations must not contradict annotations already declared in contracts.ts.
 *   The runtime merge keeps the contract value when both are present, so existing
 *   explicit annotations are never changed by this file.
 * - `annotations.readOnlyHint === true` is required for every entry reachable from the
 *   `readonly` profile.
 *
 * Profile semantics
 * - `platform`  always enabled, independent of the selected profile
 * - `dev`       ABAP development (source, DDIC, UI, enhancement, forms, quality, debug)
 * - `config`    configuration / customizing work
 * - `ops`       operations, monitoring and diagnostics
 * - `readonly`  derived filter: every tool whose registry annotation is read-only
 * - `full`      every registered tool (default)
 *
 * `sapHelper` records the deployment target the service uses for that tool family
 * (`Z_ORVANTA_MCP_EXECUTE` base helper, `Z_ORVANTA_MCP_DYNPRO_API` repository helper,
 * `Z_ORVANTA_MCP_DDIC_API`, `Z_ORVANTA_QUERY_API`, `Z_ORVANTA_MCP_SCI_*`,
 * `Z_ORVANTA_LOG_READ`, `Z_ORVANTA_OPS_READ`, `Z_ORVANTA_MAINT_READ`,
 * `Z_ORVANTA_SMARTFORM_API`). `minHelperProtocol` is the minimum protocol version the
 * capability report requires; `null` means the tool does not depend on a customer helper.
 *
 * `run_sci_analysis` requires `1.0`: the SCI helper family (`Z_ORVANTA_MCP_SCI_API`, `_V2`, `_E2`)
 * carries its self-description as the `payload` array of one `EV_RESULT` JSON envelope, whose own
 * revision is `1` — design revision R6. That `1.0` is the protocol version of the envelope and is
 * deliberately **not** the helper's `ev_version` (2.0/3.0), which versions the SCI rule profile
 * rather than the CAPABILITIES protocol.
 */

export type ToolGroup =
  | "platform"
  | "source"
  | "ddic"
  | "function"
  | "ui"
  | "message"
  | "enhancement"
  | "form"
  | "quality"
  | "debug"
  | "data"
  | "ops"

export type ToolProfile = "platform" | "dev" | "config" | "ops"

export type ToolRoute = "local" | "native-adt" | "sap-helper-fallback" | "target-specific"

export interface ToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
}

export interface ToolRegistryEntry {
  name: string
  group: ToolGroup
  profiles: readonly ToolProfile[]
  route: ToolRoute
  sapHelper: string | null
  minHelperProtocol: string | null
  /**
   * Helper operation codes this tool dispatches to. Empty means the requirement is not pinned yet,
   * and the capability report must then state that its verdict rests on the protocol version alone.
   */
  requiredHelperOperations: readonly string[]
  annotations: ToolAnnotations
  note?: string
}

/** Annotation codes used in the compact table below. */
type AnnotationCode = "R" | "RI" | "W" | "D"

const ANNOTATIONS: Record<AnnotationCode, ToolAnnotations> = {
  R: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
  RI: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  W: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  D: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
}

const EXECUTE = "Z_ORVANTA_MCP_EXECUTE"
const REPOSITORY = "Z_ORVANTA_MCP_DYNPRO_API"
const DDIC = "Z_ORVANTA_MCP_DDIC_API"
const SCI = "Z_ORVANTA_MCP_SCI_API"
const LOG = "Z_ORVANTA_LOG_READ"
const OPS = "Z_ORVANTA_OPS_READ"
const MAINT = "Z_ORVANTA_MAINT_READ"
const SMARTFORM = "Z_ORVANTA_SMARTFORM_API"

const PL: readonly ToolProfile[] = ["platform"]
const DEV: readonly ToolProfile[] = ["dev"]
const CFG: readonly ToolProfile[] = ["config"]
const OPSP: readonly ToolProfile[] = ["ops"]
const DEV_CFG: readonly ToolProfile[] = ["dev", "config"]
const DEV_OPS: readonly ToolProfile[] = ["dev", "ops"]
const CFG_OPS: readonly ToolProfile[] = ["config", "ops"]
const DEV_CFG_OPS: readonly ToolProfile[] = ["dev", "config", "ops"]

/**
 * name, group, profiles, annotation, route, sapHelper, minimum helper protocol,
 * required helper operation codes.
 *
 * The eighth element is the helper's own operation inventory for that tool. It is what makes an
 * "available" verdict checkable: a helper can self-describe a protocol version while its
 * operation list is missing the very opcode the tool dispatches to, and comparing versions alone
 * then advertises a tool that can only fail. The list is empty for tools whose requirement is not
 * yet pinned; the capability report must then say that its verdict rests on the protocol version
 * alone rather than inventing an operation check.
 */
type ToolRow = readonly [
  string,
  ToolGroup,
  readonly ToolProfile[],
  AnnotationCode,
  ToolRoute,
  string | null,
  string | null,
  (readonly string[])?
]

const ROWS: readonly ToolRow[] = [
  ["read_smartform", "form", DEV, "R", "sap-helper-fallback", SMARTFORM, null],
  ["create_smartform", "form", DEV, "D", "sap-helper-fallback", SMARTFORM, null],
  ["save_smartform", "form", DEV, "D", "sap-helper-fallback", SMARTFORM, null],
  ["activate_smartform", "form", DEV, "D", "sap-helper-fallback", SMARTFORM, null],
  [
    "read_sapscript_form",
    "form",
    DEV,
    "R",
    "sap-helper-fallback",
    REPOSITORY,
    "2.8",
    ["READ_SAPSCRIPT_FORM"]
  ],
  [
    "read_smartstyle",
    "form",
    DEV,
    "R",
    "sap-helper-fallback",
    REPOSITORY,
    "2.8",
    ["READ_SMARTSTYLE"]
  ],
  [
    "read_adobe_form",
    "form",
    DEV,
    "R",
    "sap-helper-fallback",
    REPOSITORY,
    "2.8",
    ["READ_ADOBE_FORM"]
  ],
  ["get_connected_systems", "platform", PL, "R", "local", null, null],
  ["get_capability_report", "platform", PL, "R", "target-specific", null, null],
  ["abap_debug_session", "debug", DEV, "W", "native-adt", null, null],
  ["abap_debug_breakpoint", "debug", DEV, "W", "native-adt", null, null],
  ["abap_debug_status", "debug", DEV, "R", "native-adt", null, null],
  ["abap_debug_stack", "debug", DEV, "R", "native-adt", null, null],
  ["abap_debug_variable", "debug", DEV, "R", "native-adt", null, null],
  ["abap_debug_step", "debug", DEV, "W", "native-adt", null, null],
  ["sap_helper_status", "platform", PL, "R", "sap-helper-fallback", EXECUTE, "1.0"],
  ["read_abap_screen", "ui", DEV, "R", "sap-helper-fallback", REPOSITORY, "1.1"],
  ["upsert_abap_screen", "ui", DEV, "W", "sap-helper-fallback", REPOSITORY, "1.1"],
  ["patch_abap_screen", "ui", DEV, "W", "sap-helper-fallback", REPOSITORY, "1.4"],
  ["validate_dynpro_application", "ui", DEV, "R", "sap-helper-fallback", REPOSITORY, "1.4"],
  ["read_abap_gui_definition", "ui", DEV, "R", "sap-helper-fallback", REPOSITORY, "1.5"],
  ["patch_abap_gui_definition", "ui", DEV, "W", "sap-helper-fallback", REPOSITORY, "1.5"],
  ["create_module_pool", "ui", DEV, "W", "sap-helper-fallback", REPOSITORY, "1.1"],
  ["delete_module_pool", "ui", DEV, "D", "sap-helper-fallback", REPOSITORY, "1.1"],
  ["read_transaction_code", "ui", DEV, "R", "sap-helper-fallback", REPOSITORY, "1.1"],
  ["create_transaction_code", "ui", DEV, "W", "sap-helper-fallback", REPOSITORY, "1.1"],
  ["delete_transaction_code", "ui", DEV, "D", "sap-helper-fallback", REPOSITORY, "1.1"],
  ["create_report_transaction", "ui", DEV, "W", "sap-helper-fallback", REPOSITORY, "1.2"],
  [
    "read_function_module_interface",
    "function",
    DEV,
    "R",
    "sap-helper-fallback",
    REPOSITORY,
    "1.3"
  ],
  ["test_remote_function_module", "function", DEV, "W", "target-specific", null, null],
  ["invoke_customer_function_module", "function", DEV, "W", "target-specific", null, null],
  ["run_abap_program", "function", DEV, "D", "target-specific", null, null],
  ["get_customer_function_call_status", "platform", PL, "R", "local", null, null],
  ["get_write_operation_status", "platform", PL, "R", "local", null, null],
  ["list_write_recovery_operations", "platform", PL, "R", "local", null, null],
  ["release_write_operation_lock", "platform", PL, "W", "local", null, null],
  [
    "create_function_module_with_interface",
    "function",
    DEV,
    "W",
    "sap-helper-fallback",
    REPOSITORY,
    "1.3"
  ],
  [
    "patch_function_module_interface",
    "function",
    DEV,
    "W",
    "sap-helper-fallback",
    // The patch runs inside SAP through the shared repository opcode PATCH_FUNCTION_INTERFACE
    // (since protocol 2.0). The native ADT lock/save path is what fails on w200 with HTTP 423
    // "invalid lock handle", so the service sends this opcode to the base helper
    // Z_ORVANTA_MCP_EXECUTE, exactly like write_function_module_source below.
    EXECUTE,
    "2.0"
  ],
  [
    "write_function_module_source",
    "function",
    DEV,
    "W",
    "sap-helper-fallback",
    // The opcode is part of the shared repository body, which both helper function modules
    // receive; the service sends it to the base helper Z_ORVANTA_MCP_EXECUTE.
    // Revision 2.11 accepts both include layouts: the interface skeleton form and the form that
    // keeps the interface in the function module parameter tables. In the second layout the body
    // starts after the FUNCTION statement itself, and that anchor has to be the line the service
    // resolves: revision 2.9 searched for the first statement terminator but skipped the FUNCTION
    // line, so it treated a leading declaration block as interface and started the body further
    // down. A helper that only knows the skeleton form refuses the second layout with
    // SOURCE_MARKER_ERROR, so the minimum has to move with the opcode revision.
    EXECUTE,
    "2.11"
  ],
  [
    "inspect_repository_assignment",
    "function",
    DEV_CFG,
    "R",
    "sap-helper-fallback",
    REPOSITORY,
    "1.3"
  ],
  ["read_abap_message_class", "message", DEV, "R", "sap-helper-fallback", REPOSITORY, "1.7"],
  ["create_abap_message_class", "message", DEV, "W", "sap-helper-fallback", REPOSITORY, "1.7"],
  ["update_abap_message_class", "message", DEV, "W", "sap-helper-fallback", REPOSITORY, "1.8"],
  ["delete_abap_message_class", "message", DEV, "D", "sap-helper-fallback", REPOSITORY, "1.9"],
  // DDIC rows carry the helper operation inventory they dispatch to, so the capability report
  // checks the helper's own operation list and not only its protocol version. delete_ddic_object
  // selects its opcode from objectType, so it declares every opcode it can send.
  //
  // 2026-09-25 (1.16) - every DDIC row that saves and activates a definition is floored at 1.16.
  // A helper below 1.16 verified a write by reading the *active* version with state = 'A', which
  // succeeds whenever the object was already active, and it never evaluated the DDIF_*_ACTIVATE
  // return code outside the TABL conversion check. A refused activation was therefore reported as a
  // completed write (live w200 evidence: .logs/mcp-incident-20260925-001201-upsert-lock-object-false-success,
  // where EZPMCTPRP kept its old active version and gained a leftover inactive one). 1.16 adds the
  // missing post-condition - no inactive version may remain (DDIF_*_GET state = 'M' must report
  // gotstate = 'A') - and answers DDIC_ACTIVATION_INCOMPLETE otherwise. Rows that only read, or that
  // delete without activating, keep their existing minimums: raising those would report a working
  // read as unsupported.
  ["read_ddic_domain", "ddic", DEV, "R", "sap-helper-fallback", DDIC, "1.2", ["READ_DOMAIN"]],
  ["upsert_ddic_domain", "ddic", DEV, "W", "sap-helper-fallback", DDIC, "1.16", ["UPSERT_DOMAIN"]],
  [
    "read_ddic_data_element",
    "ddic",
    DEV,
    "R",
    "sap-helper-fallback",
    DDIC,
    "1.2",
    ["READ_DATA_ELEMENT"]
  ],
  [
    "upsert_ddic_data_element",
    "ddic",
    DEV,
    "W",
    "sap-helper-fallback",
    DDIC,
    "1.16",
    ["UPSERT_DATA_ELEMENT"]
  ],
  ["read_ddic_structure", "ddic", DEV, "R", "sap-helper-fallback", DDIC, "1.2", ["READ_STRUCTURE"]],
  [
    "upsert_ddic_structure",
    "ddic",
    DEV,
    "W",
    "sap-helper-fallback",
    DDIC,
    // 1.17: structure field rows may carry REFTABLE/REFFIELD, the same pair a transparent table field
    // takes since 1.15. A helper below 1.17 answers PROPERTY_NOT_ALLOWED for both properties on the
    // structure path, so offering this tool's reference inputs against it would be a capability claim
    // it cannot honour; a quantity or currency component without them cannot activate at all.
    // UPSERT_STRUCTURE itself exists since 1.16, which is why the floor follows the contract (the two
    // new properties) rather than the operation name.
    "1.17",
    ["UPSERT_STRUCTURE"]
  ],
  [
    "read_ddic_transparent_table",
    "ddic",
    DEV,
    "R",
    "sap-helper-fallback",
    DDIC,
    "1.5",
    ["READ_TRANSPARENT_TABLE"]
  ],
  [
    "create_ddic_transparent_table",
    "ddic",
    DEV,
    "W",
    "sap-helper-fallback",
    DDIC,
    // 1.15: table field rows may carry REFTABLE/REFFIELD. A helper below 1.15 rejects those two
    // properties with PROPERTY_NOT_ALLOWED, so offering this tool's reference-field inputs against
    // it would be a capability claim the helper cannot honour. A quantity or currency field without
    // them cannot activate at all, which is why the minimum rises with the contract, not with the
    // operation name (CREATE_TRANSPARENT_TABLE itself exists since 1.5). 1.16 raises it again for
    // the post-write activation post-condition described above, and 1.17 once more because the
    // verification now asserts the pair the caller supplied: that assertion can only be made by a
    // helper whose DDIC reads publish REFTABLE/REFFIELD, and on an older one it would be a false
    // failure rather than a false success.
    "1.17",
    ["CREATE_TRANSPARENT_TABLE"]
  ],
  [
    "append_ddic_transparent_table_fields",
    "ddic",
    DEV,
    "W",
    "sap-helper-fallback",
    DDIC,
    // 1.17: the expected definition a write is verified against now carries the pair the caller
    // supplied, and only a helper whose DDIC reads publish REFTABLE/REFFIELD can be checked against
    // it - on a 1.16 helper the read-back would omit them and the verification would report a
    // mismatch the caller cannot fix. The helper merges the appended rows into its own read of the
    // table, so preservation itself does not depend on the server-side read.
    "1.17",
    ["APPEND_TRANSPARENT_TABLE_FIELDS"]
  ],
  [
    "patch_ddic_transparent_table_fields",
    "ddic",
    DEV,
    "D",
    "sap-helper-fallback",
    DDIC,
    // 1.17 for the same reason as the append above, and more sharply: a patch names only the fields it
    // changes and spreads every other row unchanged into the write, so the reference of an untouched
    // field survives only when the read published it.
    "1.17",
    ["PATCH_TRANSPARENT_TABLE_FIELDS"]
  ],
  [
    "patch_ddic_transparent_table_settings",
    "ddic",
    DEV,
    "W",
    "sap-helper-fallback",
    DDIC,
    "1.16",
    ["PATCH_TRANSPARENT_TABLE_SETTINGS"]
  ],
  ["read_ddic_table_conversion_status", "ddic", DEV_OPS, "R", "target-specific", null, null],
  [
    "recover_ddic_table_conversion",
    "ddic",
    DEV,
    "D",
    "sap-helper-fallback",
    DDIC,
    "1.7",
    ["RECOVER_TABLE_CONVERSION"]
  ],
  [
    "resume_ddic_table_activation",
    "ddic",
    DEV,
    "D",
    "sap-helper-fallback",
    DDIC,
    // R-20: the required operation is RESUME_TABLE_ACTIVATION, which no released helper delivers -
    // the 1.10 carrier shipped the 35-character RESUME_TRANSPARENT_TABLE_ACTIVATION, truncated by
    // the helper's CHAR 32 IV_OPERATION before its dispatch arm could match. The renamed operation
    // is introduced by the same body change, so the contract minimum is 1.11 and not 1.10; claiming
    // 1.10 here would assert that a 1.10 helper can serve the tool.
    //
    // 2026-09-23 (1.13): 1.11 and 1.12 could dispatch the name but could never resume anything. The
    // dispatch arm also set lv_recover, so the operation entered the TBATG conversion-recovery block,
    // which requires a worklist (WORKLIST_REQUIRED - the observed incident) and otherwise runs
    // DD_DB_CONVERTER and RETURN, leaving the lv_resume activation branch (DD_TABL_ACT) dead code.
    // A minimum of 1.11 therefore advertised the capability as available against a helper that could
    // not perform it.
    //
    // 2026-09-24 (1.14): 1.13 reached that branch but still resumed nothing. It called DD_TABL_ACT
    // directly, so DEVICE defaulted to 'F' and PRID to 0; mass_act_tabl had no protocol channel,
    // never overwrote ACT_RESULT, and every call returned the line-121 initial value 8 with an empty
    // ACT_RES_TAB while the target stayed inactive (live run: ACT_RC=8 / ACT_SUBRC=0 / ACT_ROWS=0).
    // The same defect sat in the TABL arm's normal create path, so no transparent table created by
    // a 1.13 helper ever became active. Both sites now call DDIF_TABL_ACTIVATE, which opens the
    // protocol first (START_PROTOCOL, DEVICE ' ', PRID GR_PRID). The first helper that actually
    // resumes is 1.14, so the contract moves with it.
    //
    // 2026-09-25 (1.16): resuming is also an activation, and 1.14/1.15 confirmed it by reading the
    // active version only - the same blind spot as the normal write path. The contract therefore
    // moves to the first helper that proves no inactive version is left behind.
    "1.16",
    ["RESUME_TABLE_ACTIVATION"]
  ],
  [
    "read_ddic_table_type",
    "ddic",
    DEV,
    "R",
    "sap-helper-fallback",
    DDIC,
    "1.2",
    ["READ_TABLE_TYPE"]
  ],
  [
    "upsert_ddic_table_type",
    "ddic",
    DEV,
    "W",
    "sap-helper-fallback",
    DDIC,
    "1.16",
    ["UPSERT_TABLE_TYPE"]
  ],
  [
    "delete_ddic_object",
    "ddic",
    DEV,
    "D",
    "sap-helper-fallback",
    DDIC,
    "1.6",
    [
      "DELETE_DOMAIN",
      "DELETE_DATA_ELEMENT",
      "DELETE_STRUCTURE",
      "DELETE_TRANSPARENT_TABLE",
      "DELETE_TABLE_TYPE",
      "DELETE_SEARCH_HELP",
      "DELETE_LOCK_OBJECT",
      "DELETE_NUMBER_RANGE_OBJECT",
      "DELETE_MAINTENANCE_VIEW"
    ]
  ],
  ["read_search_help", "ddic", DEV, "R", "sap-helper-fallback", DDIC, "1.8", ["READ_SEARCH_HELP"]],
  [
    "upsert_search_help",
    "ddic",
    DEV,
    "W",
    "sap-helper-fallback",
    DDIC,
    "1.16",
    ["UPSERT_SEARCH_HELP"]
  ],
  ["read_lock_object", "ddic", DEV, "R", "sap-helper-fallback", DDIC, "1.9", ["READ_LOCK_OBJECT"]],
  [
    "upsert_lock_object",
    "ddic",
    DEV,
    "W",
    "sap-helper-fallback",
    DDIC,
    "1.16",
    ["UPSERT_LOCK_OBJECT"]
  ],
  [
    "read_number_range_object",
    "ddic",
    DEV,
    "R",
    "sap-helper-fallback",
    DDIC,
    "1.11",
    ["READ_NUMBER_RANGE_OBJECT"]
  ],
  [
    "upsert_number_range_object",
    "ddic",
    DEV,
    "W",
    "sap-helper-fallback",
    DDIC,
    "1.16",
    ["UPSERT_NUMBER_RANGE_OBJECT"]
  ],
  [
    "read_maintenance_view",
    "ddic",
    DEV,
    "R",
    "sap-helper-fallback",
    DDIC,
    "1.11",
    ["READ_MAINTENANCE_VIEW"]
  ],
  [
    "upsert_maintenance_view",
    "ddic",
    DEV,
    "W",
    "sap-helper-fallback",
    DDIC,
    "1.16",
    ["UPSERT_MAINTENANCE_VIEW"]
  ],
  [
    "upsert_append_structure_fields",
    "ddic",
    DEV,
    "W",
    "sap-helper-fallback",
    DDIC,
    "1.16",
    ["UPSERT_APPEND_STRUCTURE_FIELDS"]
  ],
  ["search_abap_objects", "source", DEV, "R", "native-adt", null, null],
  ["get_abap_object_info", "source", DEV, "R", "target-specific", null, null],
  ["get_abap_object_lines", "source", DEV, "R", "target-specific", null, null],
  ["get_batch_lines", "source", DEV, "R", "target-specific", null, null],
  ["get_object_by_uri", "source", DEV, "R", "target-specific", null, null],
  ["search_abap_object_lines", "source", DEV, "R", "native-adt", null, null],
  ["inspect_source_enhancements", "enhancement", DEV, "R", "target-specific", null, null],
  ["search_enhancement_objects", "enhancement", DEV, "R", "native-adt", null, null],
  ["search_customer_exit_objects", "enhancement", DEV_CFG, "R", "native-adt", null, null],
  [
    "read_customer_exit_definition",
    "enhancement",
    DEV_CFG,
    "R",
    "sap-helper-fallback",
    REPOSITORY,
    "2.2"
  ],
  [
    "read_customer_exit_project",
    "enhancement",
    DEV_CFG,
    "R",
    "sap-helper-fallback",
    REPOSITORY,
    "2.2"
  ],
  ["inspect_customer_function_exits", "enhancement", DEV, "R", "target-specific", null, null],
  ["inspect_customer_screen_menu_exits", "enhancement", DEV, "R", "target-specific", null, null],
  ["search_bte_dispatchers", "enhancement", DEV_CFG, "R", "native-adt", null, null],
  ["read_bte_configuration", "enhancement", DEV_CFG, "R", "sap-helper-fallback", REPOSITORY, "2.3"],
  [
    "prepare_enhancement_configuration_workflow",
    "enhancement",
    CFG,
    "R",
    "target-specific",
    null,
    null
  ],
  ["search_badi_objects", "enhancement", DEV, "R", "native-adt", null, null],
  [
    "read_classic_badi_definition",
    "enhancement",
    DEV_CFG,
    "R",
    "sap-helper-fallback",
    REPOSITORY,
    "2.4"
  ],
  [
    "manage_classic_badi_implementation",
    "enhancement",
    DEV,
    "D",
    "sap-helper-fallback",
    REPOSITORY,
    "2.6",
    ["MANAGE_CLASSIC_BADI_IMPL"]
  ],
  [
    "read_enhancement_implementation",
    "enhancement",
    DEV,
    "R",
    "sap-helper-fallback",
    REPOSITORY,
    "2.6",
    ["READ_ENHANCEMENT_IMPL"]
  ],
  [
    "create_enhancement_hook_implementation",
    "enhancement",
    DEV,
    "D",
    "sap-helper-fallback",
    REPOSITORY,
    "2.6",
    ["CREATE_HOOK_ENHANCEMENT"]
  ],
  [
    "create_new_badi_implementation",
    "enhancement",
    DEV,
    "D",
    "sap-helper-fallback",
    REPOSITORY,
    "2.6",
    ["CREATE_BADI_ENHANCEMENT"]
  ],
  [
    "update_enhancement_hook_implementation",
    "enhancement",
    DEV,
    "D",
    "sap-helper-fallback",
    REPOSITORY,
    "2.6",
    ["UPDATE_HOOK_ENHANCEMENT"]
  ],
  [
    "update_new_badi_implementation",
    "enhancement",
    DEV,
    "D",
    "sap-helper-fallback",
    REPOSITORY,
    "2.6",
    ["UPDATE_BADI_ENHANCEMENT"]
  ],
  [
    "manage_enhancement_implementation_state",
    "enhancement",
    DEV,
    "D",
    "sap-helper-fallback",
    REPOSITORY,
    "2.6",
    ["MANAGE_ENHANCEMENT_STATE"]
  ],
  [
    "delete_enhancement_implementation",
    "enhancement",
    DEV,
    "D",
    "sap-helper-fallback",
    REPOSITORY,
    "2.6",
    ["DELETE_ENHANCEMENT_IMPL"]
  ],
  ["inspect_enhancement_framework", "enhancement", DEV, "R", "target-specific", null, null],
  ["inspect_fico_rule_exit_program", "enhancement", DEV_CFG, "R", "target-specific", null, null],
  ["get_abap_object_workspace_uri", "platform", PL, "R", "local", null, null],
  ["get_abap_object_url", "platform", PL, "R", "local", null, null],
  ["find_where_used", "source", DEV, "R", "target-specific", null, null],
  ["analyze_change_impact", "source", DEV, "R", "target-specific", null, null],
  ["get_sap_system_info", "ops", DEV_CFG_OPS, "R", "target-specific", null, null],
  ["read_system_parameters", "ops", DEV_CFG_OPS, "R", "target-specific", null, null],
  ["read_qrfc_queues", "ops", DEV_CFG_OPS, "R", "target-specific", null, null],
  ["read_idoc_status", "ops", DEV_CFG_OPS, "R", "target-specific", null, null],
  ["read_user_authorizations", "ops", DEV_CFG_OPS, "R", "target-specific", null, null],
  ["read_work_processes", "ops", DEV_CFG_OPS, "R", "target-specific", null, null],
  ["read_user_sessions", "ops", DEV_CFG_OPS, "R", "target-specific", null, null],
  ["read_file_system_directory", "ops", DEV_CFG_OPS, "R", "target-specific", null, null],
  ["get_version_history", "source", DEV, "R", "target-specific", null, null],
  ["preview_source_changes", "source", DEV, "R", "target-specific", null, null],
  ["get_runtime_info", "platform", PL, "R", "local", null, null],
  ["replace_string_in_abap_object", "source", DEV, "W", "native-adt", null, null],
  ["abap_activate", "source", DEV, "W", "native-adt", null, null],
  ["create_object_programmatically", "source", DEV, "W", "target-specific", null, null],
  ["delete_abap_source_object", "source", DEV, "D", "native-adt", null, null],
  ["create_test_include", "source", DEV, "W", "native-adt", null, null],
  // 2.12: the payload carries the entry kind (`TYPE`), the helper writes text symbols to pool row
  // `I` and selection texts to row `S`, and a read publishes both kinds. A helper below 2.12 either
  // rejects the property or addresses every entry as a 3-character symbol, so a selection screen
  // label could not be written at all - the same "the contract the criteria rely on moved" rule as
  // the DD03P reference pair above. It is 2.12 and not a 1.x value because the repository helper's
  // protocol is one monotone revision and PROTOCOL|MAX is what the capability gate compares: a
  // mid-life contract change takes the next value above the helper's current maximum (2.11), while a
  // number below it would leave the gate unable to tell this body from the one before it.
  [
    "manage_text_elements",
    "source",
    DEV,
    "W",
    "sap-helper-fallback",
    REPOSITORY,
    "2.12",
    ["READ_TEXT_ELEMENTS", "MERGE_TEXT_ELEMENTS"]
  ],
  ["get_abap_diagnostics", "quality", DEV, "R", "native-adt", null, null],
  ["get_abap_sql_syntax", "platform", PL, "R", "local", null, null],
  ["execute_data_query", "data", DEV_CFG_OPS, "R", "target-specific", null, null],
  ["read_abap_table", "data", DEV_CFG_OPS, "R", "target-specific", null, null],
  ["run_atc_analysis", "quality", DEV, "W", "target-specific", null, null],
  ["run_sci_analysis", "quality", DEV, "W", "sap-helper-fallback", SCI, "1.0"],
  ["preview_configuration", "data", CFG, "R", "target-specific", null, null],
  ["run_unit_tests", "quality", DEV, "W", "native-adt", null, null],
  ["search_background_jobs", "ops", OPSP, "R", "sap-helper-fallback", OPS, null],
  ["search_sap_locks", "ops", OPSP, "R", "sap-helper-fallback", MAINT, null],
  ["search_failed_updates", "ops", OPSP, "R", "sap-helper-fallback", MAINT, null],
  ["read_failed_update", "ops", OPSP, "R", "sap-helper-fallback", MAINT, null],
  ["read_report_parameters", "data", DEV_CFG_OPS, "R", "sap-helper-fallback", REPOSITORY, null],
  ["read_report_variants", "data", DEV_CFG_OPS, "R", "target-specific", null, null],
  ["read_background_job_details", "ops", OPSP, "R", "sap-helper-fallback", OPS, null],
  ["read_background_job_spool", "ops", OPSP, "R", "sap-helper-fallback", OPS, null],
  ["read_background_job_log", "ops", OPSP, "R", "sap-helper-fallback", OPS, null],
  ["read_system_logs", "ops", OPSP, "R", "sap-helper-fallback", OPS, null],
  ["correlate_sap_logs", "ops", OPSP, "R", "target-specific", null, null],
  ["discover_application_logs", "ops", OPSP, "R", "sap-helper-fallback", LOG, null],
  ["search_application_logs", "ops", OPSP, "R", "sap-helper-fallback", LOG, null],
  ["read_application_log", "ops", OPSP, "R", "sap-helper-fallback", LOG, null],
  ["diagnose_sap_failure", "ops", DEV_OPS, "RI", "native-adt", null, null],
  ["analyze_abap_dumps", "ops", DEV_OPS, "R", "native-adt", null, null],
  ["analyze_abap_traces", "ops", OPSP, "R", "native-adt", null, null],
  ["manage_transport_requests", "ops", DEV_CFG_OPS, "R", "target-specific", null, null],
  ["cleanup_transport_entries", "ops", OPSP, "D", "native-adt", null, null],
  // D9-1. A write: the shared repository body creates a CTS request and commits it. The tool is
  // ops-only and stays off the default surface; the helper protocol it needs is named here.
  [
    "create_transport_request",
    "ops",
    OPSP,
    "W",
    "sap-helper-fallback",
    REPOSITORY,
    "2.8",
    ["CREATE_TRANSPORT_REQUEST"]
  ],
  // D9-2. Also a write on the same repository body, and also ops-only. It is deliberately a
  // separate tool from create_transport_request: attaching objects has its own preconditions and
  // its own E071 read-back, so it must not be folded behind a mode flag.
  [
    "add_objects_to_transport",
    "ops",
    OPSP,
    "W",
    "sap-helper-fallback",
    REPOSITORY,
    "2.8",
    ["ADD_OBJECTS_TO_TRANSPORT"]
  ],
  ["abap_download", "source", DEV, "W", "target-specific", null, null],
  ["adt_discovery_export", "platform", PL, "W", "native-adt", null, null]
]

/** Non-obvious boundaries that callers must know before trusting a tool result. */
const NOTES: Record<string, string> = {
  replace_string_in_abap_object:
    "函数模块改由仓库助手写入（SAP_BASIS 7.31 上 ADT 源码 PUT 一律 HTTP 423，2026-09-18 追踪 12/12），因此该目标额外依赖助手操作码 WRITE_FUNCTION_SOURCE（仓库助手协议 ≥2.9：该修订同时接受「接口骨架」与「接口留在函数模块参数表、正文紧随 FUNCTION 语句」两种 include 布局，旧助手对第二种报 SOURCE_MARKER_ERROR）；程序、类、接口等仍是原生 ADT。函数模块只能替换实现正文，接口段改动被拒绝并指向 patch_function_module_interface 或 SE37。",
  analyze_abap_traces:
    "w200 上 ADT trace 端点返回 HTTP 404（能力报告判定 unsupported）；注册不等于可用。",
  preview_configuration:
    "仅服务 w200/200 的 ZTPMC_TPCFG 工厂行预览，属客户项目对象固化在通用服务中的待整改项。",
  read_report_parameters:
    "依赖仓库助手的 REPORT_PARAMETERS scope；仅读取已编译 SSCR 元数据，不生成、不读变式内容。",
  read_report_variants:
    "通过受限单表读取当前 client 的 VARID 目录元数据；不读参数值，不合并 client 000。",
  read_background_job_details:
    "需要单独批准的 SM37_DETAILS scope；返回步骤元数据，不含变式值与 Spool 正文。",
  read_background_job_spool:
    "需要单独批准的 SP01 scope；仅文本，无 OTF/PDF 与打印，分页非原子快照。",
  discover_application_logs: "需要管理员批准的只读助手；返回有界样本，不是完整日志清单。",
  search_application_logs: "需要管理员批准的只读助手；未批准时返回不可用，不代表日志为空。",
  read_application_log: "日志正文属不可信证据；分页需要 revision，变更后拒绝拼接。",
  search_sap_locks: "只读；不提供 SAP 解锁。本地凭证不能证明 SAP 锁归属。",
  search_failed_updates: "只读；不执行更新重处理，本地候选助手尚未部署验证。",
  read_failed_update: "只读；不提供参数载荷或完整错误正文。",
  correlate_sap_logs: "固定来源的有界关联，不证明因果；各来源失败分别报告。",
  diagnose_sap_failure: "只读 ST22 解析；时间关联是候选证据，不认定根因。",
  find_where_used:
    "w200 上原生引用映射曾超时并伴随 RIS 故障；失败不得解释为零引用。ECC 7.31 无 usageReferences 端点，只走 legacy RIS 通路，该通路覆盖函数模块、类、接口、程序的声明位置（0.50.5 起），不含片段检索。",
  execute_data_query:
    "w200 原生数据预览端点返回非 XML 响应；当前依赖受限只读后备。原生与后备两条路径都过 D5-2 白名单（默认拒绝），表名无法静态枚举即拒绝。",
  read_abap_table: "最多 500 行、仅字符比较、无联接/聚合/排序；宽表按主键分块并二次复核。",
  run_atc_analysis: "w200 原生 ATC 端点不可用，当前退化为语法报告；不得作为质量门禁通过依据。",
  run_sci_analysis: "非原生 ATC，规则范围固定且依赖指纹匹配的 SCI 助手；timeout 不等于取消。",
  run_unit_tests: "执行现有 ABAP Unit，测试代码可能有副作用；需先取得授权。",
  cleanup_transport_entries: "移除 CTS 任务条目，不删除、不释放传输；w200 写端点尚未验证。",
  manage_transport_requests: "只读：不创建、不释放、不导入传输。",
  release_write_operation_lock: "仅解除本地目标锁，不触碰 SAP 锁；需人工确认与最新凭证哈希。",
  abap_download: "写入本地文件系统；程序不自动包含其 Include，需显式下载。",
  adt_discovery_export:
    "写入本地 Markdown 文件；w200 Discovery 未返回 template link / core entry。",
  test_remote_function_module: "执行客户 RFC，可能产生业务副作用；白名单与显式确认必需。",
  invoke_customer_function_module: "正式白名单调用，非只读；需一次性请求凭证与副作用确认。",
  run_abap_program:
    "执行既有 Z/Y 程序本体，可能产生业务副作用；仅回 SUBMIT 返回码，列表输出不返回。",
  abap_debug_session: "w200 调试端点曾返回 404；仅 Mock 验证，真实会话未验收。",
  abap_debug_breakpoint: "仅允许 Z/Y 源码断点；真实调试链路未验收。",
  abap_debug_step: "单步/继续会驱动被调试程序执行，可能存在业务副作用。"
}

export const TOOL_MATRIX_VERSION = "2026-09-17"
export const PROFILE_NAMES = ["readonly", "platform", "dev", "config", "ops", "full"] as const
export type ProfileName = (typeof PROFILE_NAMES)[number]

export const TOOL_REGISTRY: readonly ToolRegistryEntry[] = ROWS.map(
  ([
    name,
    group,
    profiles,
    annotation,
    route,
    sapHelper,
    minHelperProtocol,
    requiredOperations
  ]) => ({
    name,
    group,
    profiles,
    route,
    sapHelper,
    minHelperProtocol,
    requiredHelperOperations: requiredOperations ?? [],
    annotations: { ...ANNOTATIONS[annotation] },
    ...(NOTES[name] ? { note: NOTES[name] } : {})
  })
)

/**
 * Tools routed to `helper` whose required operation inventory is still empty.
 *
 * An empty inventory is not a failure by itself, but it is the difference between a verdict that
 * was checked against the helper's own operation list and one that only compared protocol
 * versions. The matrix gate calls this for the helpers that already declare their operations, so a
 * new tool routed there cannot quietly skip the check.
 */
export function helperOperationRequirementGaps(helper: string): readonly string[] {
  return ROWS.filter((row) => row[5] === helper && !row[7]?.length).map((row) => row[0])
}

export const TOOL_NAMES: readonly string[] = TOOL_REGISTRY.map((entry) => entry.name)
export const TOOL_COUNT = TOOL_REGISTRY.length

const BY_NAME = new Map(TOOL_REGISTRY.map((entry) => [entry.name, entry]))

export function registryEntry(name: string): ToolRegistryEntry | undefined {
  return BY_NAME.get(name)
}

/** Annotations for one tool; empty object when the tool is not registered. */
export function registryAnnotations(name: string): ToolAnnotations {
  return BY_NAME.get(name)?.annotations ?? {}
}

/**
 * Tool names enabled by a profile.
 * `readonly` is derived from the registry annotations, never listed per tool.
 */
export function toolNamesForProfile(profile: ProfileName): string[] {
  if (profile === "full") return [...TOOL_NAMES]
  if (profile === "readonly") {
    return TOOL_REGISTRY.filter((entry) => entry.annotations.readOnlyHint === true).map(
      (entry) => entry.name
    )
  }
  return TOOL_REGISTRY.filter(
    (entry) => entry.profiles.includes("platform") || entry.profiles.includes(profile)
  ).map((entry) => entry.name)
}

/**
 * Merge registry annotations into a contract map, preserving every other field.
 *
 * Contract-level annotations win over registry annotations so that explicitly
 * declared values in `contracts.ts` are never changed. Unknown contract keys are
 * rejected loudly: a tool registered without a registry entry would otherwise be
 * invisible to the profile, index and capability checks.
 */
export function withRegistryAnnotations<T extends Record<string, object>>(contracts: T): T {
  const merged: Record<string, unknown> = {}
  const unknown: string[] = []
  for (const [name, contract] of Object.entries(contracts)) {
    const entry = BY_NAME.get(name)
    if (!entry) {
      unknown.push(name)
      continue
    }
    const declared = (contract as { annotations?: object }).annotations
    merged[name] = {
      ...contract,
      annotations: { ...entry.annotations, ...declared }
    }
  }
  if (unknown.length > 0) {
    throw new Error(
      `Tool contract has no registry entry in src/tool-registry.ts: ${unknown.join(", ")}`
    )
  }
  const missing = TOOL_NAMES.filter((name) => !(name in contracts))
  if (missing.length > 0) {
    throw new Error(
      `Registry entry has no tool contract in src/contracts.ts: ${missing.join(", ")}`
    )
  }
  return merged as T
}
