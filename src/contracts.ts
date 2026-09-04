import { z } from "zod"
import { DEFAULT_OBJECT_TYPES } from "./backend.js"

const objectType = z.enum(DEFAULT_OBJECT_TYPES)
const ddicFixedValue = z.object({
  low: z.string(),
  high: z.string().optional(),
  description: z.string()
})
const ddicStructureField = z.object({ name: z.string(), dataElement: z.string() })
const ddicTableField = z.object({
  name: z.string(),
  dataElement: z.string(),
  key: z.boolean().optional()
})
const ddicAppendedTableField = z.object({
  name: z.string(),
  dataElement: z.string()
})
const ddicTableFieldChange = z.discriminatedUnion("action", [
  z.object({ action: z.literal("remove"), fieldName: z.string() }),
  z.object({ action: z.literal("rename"), fieldName: z.string(), newName: z.string() }),
  z.object({
    action: z.literal("update"),
    fieldName: z.string(),
    dataElement: z.string().optional(),
    key: z.boolean().optional(),
    notNull: z.boolean().optional()
  })
])
const functionParameter = z.object({
  name: z.string(),
  typeName: z.string(),
  optional: z.boolean().optional(),
  passByValue: z.boolean().optional()
})
const functionException = z.object({
  name: z.string(),
  description: z.string().optional()
})
const scalarParameters = z.record(z.string())
const structureParameters = z.record(z.record(z.string()))
const tableParameters = z.record(z.array(z.record(z.string())))
const writeOperationInput = {
  operationId: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,64}$/)
    .describe(
      "Caller-generated write operation ID. Reuse is blocked; keep this ID to query recovery status. If omitted, the service generates one for backward compatibility."
    )
    .optional()
}
const screenComponentOperation = z.object({
  operation: z.enum(["add", "update", "remove"]),
  name: z.string(),
  definition: z.record(z.string()).optional()
})
const screenHeaderPatch = z
  .object({
    NOLI: z
      .string()
      .regex(/^[1-9]\d*$/)
      .optional(),
    NOCO: z
      .string()
      .regex(/^[1-9]\d*$/)
      .optional()
  })
  .strict()
const guiSection = z.enum([
  "statuses",
  "functions",
  "menus",
  "menuTexts",
  "activeFunctions",
  "buttons",
  "pfKeys",
  "statusFunctions",
  "documentation",
  "titles",
  "buttonAssignments"
])
const guiRowOperation = z.object({
  section: guiSection,
  operation: z.enum(["add", "update", "remove"]),
  key: z.record(z.string()),
  definition: z.record(z.string()).optional()
})
const guiAdminPatch = z
  .object({
    ACTCODE: z.string().optional(),
    MENCODE: z.string().optional(),
    PFKCODE: z.string().optional(),
    DEFAULTACT: z.string().optional(),
    DEFAULTPFK: z.string().optional(),
    MOD_LANGU: z.string().optional()
  })
  .strict()

export const toolContracts = {
  get_connected_systems: {
    description:
      "List SAP connection IDs configured in this standalone service. Call first if connectionId unknown. No params.",
    inputSchema: {}
  },
  get_capability_report: {
    description:
      "Build a read-only capability report for one configured SAP connection. It separates local implementation, verified native ADT access, SAP helper fallback, unsupported endpoints, and unknown target-specific capabilities. Probes never invoke SAP writes, clear locks, retry writes, or claim RFC rollback.",
    inputSchema: {
      connectionId: z.string()
    }
  },
  abap_debug_session: {
    description:
      "Start, stop, or inspect one headless ABAP user-debugging session. The standalone debugger accepts only the configured SAP user and does not support terminal mode.",
    inputSchema: {
      connectionId: z.string(),
      action: z.enum(["start", "stop", "status"]).default("start").optional(),
      debugUser: z.string().optional(),
      terminalMode: z.boolean().default(false).optional()
    }
  },
  abap_debug_breakpoint: {
    description:
      "Set or remove ABAP breakpoints. filePath must be a full adt:// workspace URI from get_abap_object_workspace_uri. Only Z* or Y* customer-owned source is accepted.",
    inputSchema: {
      connectionId: z.string(),
      filePath: z.string(),
      lineNumbers: z.array(z.number().int().positive()).min(1).max(100),
      condition: z.string().optional(),
      action: z.enum(["set", "remove"]).default("set").optional()
    }
  },
  abap_debug_status: {
    description: "Check the current headless ABAP debug session and execution state.",
    inputSchema: { connectionId: z.string() }
  },
  abap_debug_stack: {
    description:
      "Get the paused ABAP call stack. Returned frameId values are required by abap_debug_variable.",
    inputSchema: {
      connectionId: z.string(),
      threadId: z.number().int().positive().default(1).optional()
    }
  },
  abap_debug_variable: {
    description:
      "Inspect read-only ABAP variables in a paused session. Call abap_debug_stack first and pass its frameId. Variable and table output is bounded.",
    inputSchema: {
      connectionId: z.string(),
      threadId: z.number().int().positive().default(1).optional(),
      frameId: z.number().int(),
      variableName: z.string().optional(),
      expression: z.string().optional(),
      rowStart: z.number().int().nonnegative().default(0).optional(),
      rowCount: z.number().int().positive().max(200).default(50).optional(),
      filter: z.string().optional(),
      scopeName: z.string().optional(),
      maxVariables: z.number().int().positive().max(500).default(100).optional(),
      filterPattern: z.string().optional(),
      expandStructures: z.boolean().default(false).optional(),
      expandTables: z.boolean().default(false).optional()
    }
  },
  abap_debug_step: {
    description:
      "Continue or step a paused ABAP debuggee. jumpToLine remains in the compatibility contract but is rejected because it changes control flow.",
    inputSchema: {
      connectionId: z.string(),
      stepType: z.enum(["continue", "stepInto", "stepOver", "stepReturn", "jumpToLine"]),
      threadId: z.number().int().positive().default(1).optional(),
      targetLine: z.number().int().positive().optional()
    }
  },
  sap_helper_status: {
    description:
      "Call the installed Z_CODEX_MCP_EXECUTE SAP helper through SOAP/RFC. PING reports helper readiness and version. VALIDATE_TARGET checks the SAP-side Z*/Y* namespace, object-type allowlist, and S_DEVELOP display authorization without changing SAP data.",
    inputSchema: {
      action: z.enum(["ping", "validate_target"]),
      objectType: z.string().optional(),
      objectName: z.string().optional(),
      connectionId: z.string()
    }
  },
  read_abap_screen: {
    description:
      "Read a classic Dynpro screen from a Z* or Y* program through the installed SAP helper. Returns the native D020S header, D021S fields, D022S flow logic, D023S parameters, deterministic SHA-256 fingerprint, and referenced PBO/PAI modules without modifying SAP.",
    inputSchema: {
      programName: z.string(),
      screenNumber: z.string(),
      connectionId: z.string()
    }
  },
  upsert_abap_screen: {
    description:
      "Create or replace one classic Dynpro screen for an existing Z* or Y* program. Accepts public RPY_DYFATC field rows, RPY_DYFLOW flow-logic lines, and optional D020S sizing/RPY_DYPARA values. Requires an explicit existing transport and re-reads the saved screen in native D020S/D021S/D022S/D023S form. It never releases transports.",
    inputSchema: {
      ...writeOperationInput,
      programName: z.string(),
      screenNumber: z.string(),
      description: z.string(),
      transportNumber: z.string(),
      header: z.record(z.string()).optional(),
      fields: z.array(z.record(z.string())).min(1),
      flowLogic: z.array(z.string()).min(1),
      params: z.array(z.record(z.string())).optional(),
      connectionId: z.string()
    }
  },
  patch_abap_screen: {
    description:
      "Apply explicit add, update, or remove operations to components of one existing Z* or Y* classic Dynpro screen while preserving untouched public RPY_DYFATC fields. Component coordinates are moved through update definitions. Requires the current fingerprint returned by read_abap_screen, an existing transport, and SAP repository helper 1.4. Optional header, flowLogic, params, and description values replace only the supplied sections. The tool re-reads the native screen and never releases transports.",
    inputSchema: {
      ...writeOperationInput,
      programName: z.string(),
      screenNumber: z.string(),
      expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
      transportNumber: z.string(),
      componentOperations: z.array(screenComponentOperation).max(100).default([]).optional(),
      description: z.string().optional(),
      header: screenHeaderPatch.optional(),
      flowLogic: z.array(z.string()).min(1).optional(),
      params: z.array(z.record(z.string())).optional(),
      connectionId: z.string()
    }
  },
  validate_dynpro_application: {
    description:
      "Read and validate one Z* or Y* classic Dynpro screen together with its recursively retrieved module-pool source and active Menu Painter definition. Reports duplicate components, invalid coordinates, PBO/PAI module references, source definitions, bounded include coverage, missing static PF-STATUS or Titlebar references, and conventional program-field references without modifying SAP.",
    inputSchema: {
      programName: z.string(),
      screenNumber: z.string(),
      connectionId: z.string()
    }
  },
  read_abap_gui_definition: {
    description:
      "Read the complete active Menu Painter definition for one Z* or Y* program. Returns GUI statuses, function texts, menus, toolbar and key assignments, titlebars, administration data, a SAP version token, and a deterministic SHA-256 fingerprint without modifying SAP.",
    inputSchema: {
      programName: z.string(),
      connectionId: z.string()
    }
  },
  patch_abap_gui_definition: {
    description:
      "Apply explicit add, update, or remove operations to the native Menu Painter rows of one Z* or Y* program while preserving untouched rows. Requires the current fingerprint, an existing transport, and repository helper 1.5. The SAP helper rechecks its own version token before writing and re-reads the active definition after the write. It never releases transports.",
    inputSchema: {
      ...writeOperationInput,
      programName: z.string(),
      expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
      transportNumber: z.string(),
      operations: z.array(guiRowOperation).min(1).max(100),
      adminPatch: guiAdminPatch.optional(),
      connectionId: z.string()
    }
  },
  create_module_pool: {
    description:
      "Create a transportable Z* or Y* module-pool program with ECC 7.31-compatible source through the SAP repository helper. Requires a non-local package and an explicit existing transport. It does not create or release transports.",
    inputSchema: {
      ...writeOperationInput,
      programName: z.string(),
      description: z.string(),
      packageName: z.string(),
      transportNumber: z.string(),
      source: z.array(z.string()).min(1),
      connectionId: z.string()
    }
  },
  delete_module_pool: {
    description:
      "Permanently delete one Z* or Y* module-pool program together with its Dynpro screens, GUI CUA, includes, text pool, documentation, and variants. The exact package and an existing transport are required; all dialog transactions must be deleted first. Never releases transports.",
    inputSchema: {
      ...writeOperationInput,
      programName: z.string(),
      packageName: z.string(),
      transportNumber: z.string(),
      connectionId: z.string()
    }
  },
  read_transaction_code: {
    description:
      "Read one Z* or Y* SAP transaction definition and GUI attributes through the installed SAP helper without modifying SAP.",
    inputSchema: {
      transactionCode: z.string(),
      connectionId: z.string()
    }
  },
  create_transaction_code: {
    description:
      "Create a dialog transaction for an existing Z* or Y* module pool and Dynpro. Requires a non-local package and explicit existing transport, verifies the created definition, and never releases transports.",
    inputSchema: {
      ...writeOperationInput,
      transactionCode: z.string(),
      programName: z.string(),
      screenNumber: z.string(),
      description: z.string(),
      packageName: z.string(),
      transportNumber: z.string(),
      connectionId: z.string()
    }
  },
  delete_transaction_code: {
    description:
      "Permanently delete one Z* or Y* dialog or report transaction after verifying its current fingerprint, target Z* or Y* program, and exact package. Requires an existing transport and never releases transports.",
    inputSchema: {
      ...writeOperationInput,
      transactionCode: z.string(),
      expectedProgramName: z.string(),
      expectedFingerprint: z
        .string()
        .regex(/^[a-f0-9]{64}$/i)
        .optional(),
      packageName: z.string(),
      transportNumber: z.string(),
      connectionId: z.string()
    }
  },
  create_report_transaction: {
    description:
      "Create one new Z* or Y* report transaction for an existing executable Z* or Y* program. An optional existing variant can be assigned. Requires a transportable package and existing transport, verifies the created transaction, and never replaces transactions or releases transports.",
    inputSchema: {
      ...writeOperationInput,
      transactionCode: z.string(),
      programName: z.string(),
      variant: z.string().optional(),
      description: z.string(),
      packageName: z.string(),
      transportNumber: z.string(),
      connectionId: z.string()
    }
  },
  read_function_module_interface: {
    description:
      "Read one active function module interface and source through the SAP repository helper. Read-only and allowed for customer or standard function modules. Returns a deterministic SHA-256 fingerprint; includeExecutionSupport additionally resolves scalar, flat-structure, and table parameter shapes through DDIC.",
    inputSchema: {
      functionName: z.string(),
      includeExecutionSupport: z.boolean().default(false).optional(),
      connectionId: z.string()
    }
  },
  test_remote_function_module: {
    description:
      "Invoke one remote-enabled Z* or Y* function module through SOAP/RFC and verify exact scalar, flat-structure, and bounded table outputs or one declared exception. The tool reads the active interface and DDIC shapes first, rejects unsupported deep types and update-task modules, requires an interface fingerprint for complex payloads, and requires explicit acknowledgement that customer RFC code may change SAP business data.",
    inputSchema: {
      ...writeOperationInput,
      functionName: z.string(),
      inputParameters: scalarParameters,
      structureInputs: structureParameters.optional(),
      tableInputs: tableParameters.optional(),
      expectedOutputs: scalarParameters.optional(),
      expectedStructureOutputs: structureParameters.optional(),
      expectedTableOutputs: tableParameters.optional(),
      expectedException: z.string().optional(),
      expectedInterfaceFingerprint: z
        .string()
        .regex(/^[a-f0-9]{64}$/i)
        .optional(),
      acknowledgePotentialSideEffects: z.literal(true),
      connectionId: z.string()
    }
  },
  invoke_customer_function_module: {
    description:
      "Invoke one explicitly allowlisted remote-enabled Z* or Y* function module through SOAP/RFC and return its actual bounded scalar, flat-structure, and table results. Every call requires the active interface fingerprint, a one-time caller requestId, and explicit side-effect acknowledgement. A persistent receipt blocks duplicate or conflicting request IDs across concurrent calls and service restarts. Declared SAP exceptions are returned as structured faults. Calls are never retried automatically.",
    inputSchema: {
      ...writeOperationInput,
      functionName: z.string(),
      requestId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
      inputParameters: scalarParameters.default({}).optional(),
      structureInputs: structureParameters.optional(),
      tableInputs: tableParameters.optional(),
      expectedInterfaceFingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
      acknowledgePotentialSideEffects: z.literal(true),
      connectionId: z.string()
    }
  },
  get_customer_function_call_status: {
    description:
      "Read the persistent execution receipt for one customer RFC requestId without invoking SAP. Returns not_found, in_progress, completed, declared_fault, or outcome_unknown and never exposes the original input or output payload.",
    inputSchema: {
      requestId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
      connectionId: z.string()
    }
  },
  get_write_operation_status: {
    description:
      "Read a persistent receipt for one repository or RFC write operation without invoking SAP. Returns not_found, in_progress, completed, failed, or interrupted plus hashes, the pre-change summary, and manual recovery guidance. It never retries or rolls back an operation.",
    inputSchema: {
      operationId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
      connectionId: z.string()
    }
  },
  list_write_recovery_operations: {
    description:
      "List interrupted write operations and completed or failed operations whose local target lock remains, without invoking SAP or changing any lock. Results are newest-first and bounded.",
    inputSchema: {
      connectionId: z.string(),
      maxResults: z.number().int().positive().max(100).default(50).optional()
    }
  },
  release_write_operation_lock: {
    description:
      "Release only the local target lock for one interrupted or stale write receipt after a human has inspected SAP. Requires the latest receipt hash, the exact SAP_STATE_VERIFIED confirmation, and a reason. It never clears SAP locks, retries an operation, invokes SAP, or rolls back an RFC.",
    inputSchema: {
      operationId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
      expectedReceiptHash: z.string().regex(/^[a-f0-9]{64}$/),
      confirmation: z.literal("SAP_STATE_VERIFIED"),
      reason: z.string().trim().min(1).max(500),
      connectionId: z.string()
    }
  },
  create_function_module_with_interface: {
    description:
      "Create one new Z* or Y* function module with an explicit interface and ECC 7.31-compatible source in an existing Z* or Y* function group. Requires a transportable package and existing transport. Existing functions are rejected; transports are never created or released.",
    inputSchema: {
      ...writeOperationInput,
      functionName: z.string(),
      functionGroup: z.string(),
      description: z.string(),
      remoteEnabled: z.boolean(),
      importParameters: z.array(functionParameter),
      exportParameters: z.array(functionParameter),
      changingParameters: z.array(functionParameter),
      tableParameters: z.array(functionParameter),
      exceptions: z.array(functionException),
      source: z.array(z.string()).min(1),
      packageName: z.string(),
      transportNumber: z.string(),
      connectionId: z.string()
    }
  },
  inspect_repository_assignment: {
    description:
      "Inspect package, parent object, open request/task assignment, active/generated state, and original system for a class, interface, function group, function module, program, include, or transaction. Read-only.",
    inputSchema: {
      objectName: z.string(),
      objectType: z.enum(["CLAS/OC", "INTF/OI", "FUGR/F", "FUGR/FF", "PROG/P", "PROG/I", "TRAN"]),
      connectionId: z.string()
    }
  },
  read_abap_message_class: {
    description:
      "Read one active SAP message class in the connection language, including package, version, description, and all message numbers and texts. Read-only and allowed for customer or standard message classes.",
    inputSchema: {
      messageClass: z.string(),
      connectionId: z.string()
    }
  },
  create_abap_message_class: {
    description:
      "Create one new Z* or Y* message class with its initial messages. Existing message classes are rejected because ECC 7.31 exposes no safe headless merge API. Requires a transportable package and existing transport, verifies the created definition, and never releases transports.",
    inputSchema: {
      ...writeOperationInput,
      messageClass: z.string(),
      description: z.string(),
      messages: z
        .array(
          z.object({
            number: z.string().regex(/^\d{3}$/),
            text: z.string().min(1).max(73)
          })
        )
        .min(1),
      packageName: z.string(),
      transportNumber: z.string(),
      connectionId: z.string()
    }
  },
  update_abap_message_class: {
    description:
      "Apply versioned add, update, and remove operations to one existing Z* or Y* message class. Unmentioned messages are preserved. Requires the current version, exact transportable package, and an existing transport; verifies the complete active definition and never releases transports.",
    inputSchema: {
      ...writeOperationInput,
      messageClass: z.string(),
      expectedVersion: z.string().min(1),
      operations: z
        .array(
          z.object({
            operation: z.enum(["add", "update", "remove"]),
            number: z.string().regex(/^\d{3}$/),
            text: z.string().min(1).max(73).optional()
          })
        )
        .min(1)
        .max(100),
      packageName: z.string(),
      transportNumber: z.string(),
      connectionId: z.string()
    }
  },
  delete_abap_message_class: {
    description:
      "Permanently delete one Z* or Y* message class after verifying its current version and exact package. Requires an existing transport and explicit permanent-delete confirmation; verifies absence and never releases transports.",
    inputSchema: {
      ...writeOperationInput,
      messageClass: z.string(),
      expectedVersion: z.string().min(1),
      packageName: z.string(),
      transportNumber: z.string(),
      confirmation: z.literal("PERMANENT_DELETE"),
      connectionId: z.string()
    }
  },
  read_ddic_domain: {
    description:
      "Read one active SAP Dictionary domain, including fixed values, package, concurrency version, and SHA-256 definition fingerprint. Read-only and allowed for customer or standard objects.",
    inputSchema: { objectName: z.string(), connectionId: z.string() }
  },
  upsert_ddic_domain: {
    description:
      "Create or fully replace one Z* or Y* domain through the installed DDIC helper. Existing objects require the version returned by read_ddic_domain. Requires an existing transportable package and transport; never releases transports.",
    inputSchema: {
      ...writeOperationInput,
      objectName: z.string(),
      description: z.string(),
      packageName: z.string(),
      transportNumber: z.string(),
      expectedVersion: z.string().optional(),
      dataType: z.enum(["CHAR", "NUMC", "DEC", "DATS", "TIMS"]),
      length: z.number().int(),
      decimals: z.number().int().optional(),
      lowercase: z.boolean().optional(),
      signFlag: z.boolean().optional(),
      valueTable: z.string().optional(),
      conversionExit: z.string().optional(),
      fixedValues: z.array(ddicFixedValue).optional(),
      connectionId: z.string()
    }
  },
  read_ddic_data_element: {
    description:
      "Read one active SAP Dictionary data element, including labels, package, concurrency version, and SHA-256 definition fingerprint. Read-only and allowed for customer or standard objects.",
    inputSchema: { objectName: z.string(), connectionId: z.string() }
  },
  upsert_ddic_data_element: {
    description:
      "Create or fully replace one Z* or Y* domain-based data element. Existing objects require the version returned by read_ddic_data_element. Requires an existing package and transport; never releases transports.",
    inputSchema: {
      ...writeOperationInput,
      objectName: z.string(),
      description: z.string(),
      domainName: z.string(),
      heading: z.string(),
      short: z.string(),
      medium: z.string(),
      long: z.string(),
      packageName: z.string(),
      transportNumber: z.string(),
      expectedVersion: z.string().optional(),
      connectionId: z.string()
    }
  },
  read_ddic_structure: {
    description:
      "Read one active SAP Dictionary structure, including component data elements, package, concurrency version, and SHA-256 definition fingerprint. Read-only and allowed for customer or standard objects.",
    inputSchema: { objectName: z.string(), connectionId: z.string() }
  },
  upsert_ddic_structure: {
    description:
      "Create or fully replace one Z* or Y* flat structure whose fields reference data elements. Existing objects require the version returned by read_ddic_structure. Field omission means removal. Requires an existing package and transport.",
    inputSchema: {
      ...writeOperationInput,
      objectName: z.string(),
      description: z.string(),
      fields: z.array(ddicStructureField).min(1),
      packageName: z.string(),
      transportNumber: z.string(),
      expectedVersion: z.string().optional(),
      connectionId: z.string()
    }
  },
  read_ddic_transparent_table: {
    description:
      "Read one active SAP Dictionary transparent table, including keys, delivery class, technical settings, package, concurrency version, and SHA-256 definition fingerprint. Read-only and allowed for customer or standard objects.",
    inputSchema: { objectName: z.string(), connectionId: z.string() }
  },
  create_ddic_transparent_table: {
    description:
      "Create one new Z* or Y* transparent table whose fields reference active data elements. Existing tables are rejected to avoid destructive database conversion. Key fields must be contiguous at the beginning. Requires an existing transportable package and transport; never releases transports.",
    inputSchema: {
      ...writeOperationInput,
      objectName: z.string(),
      description: z.string(),
      deliveryClass: z.enum(["A", "C", "L", "G", "E", "S", "W"]),
      dataClass: z.enum(["APPL0", "APPL1", "APPL2"]),
      dataBrowserMaintenance: z.enum(["allowed", "restricted", "notAllowed"]),
      sizeCategory: z.number().int().min(0).max(4).default(0).optional(),
      fields: z.array(ddicTableField).min(1),
      packageName: z.string(),
      transportNumber: z.string(),
      connectionId: z.string()
    }
  },
  append_ddic_transparent_table_fields: {
    description:
      "Append nullable, non-key fields to one existing Z* or Y* transparent table with direct data-element fields while preserving every existing field and all table settings. Tables with Include or Append structures are rejected. Requires the current version and SHA-256 fingerprint from read_ddic_transparent_table, the exact package, an existing transport, and active data elements. Field removal, rename, type/key/nullability changes, technical-setting changes, automatic retries, and transport release are not supported.",
    inputSchema: {
      ...writeOperationInput,
      objectName: z.string(),
      expectedVersion: z.string(),
      expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
      fields: z.array(ddicAppendedTableField).min(1).max(32),
      packageName: z.string(),
      transportNumber: z.string(),
      connectionId: z.string()
    }
  },
  patch_ddic_transparent_table_fields: {
    description:
      "Apply explicit remove, rename, or data-element/key/nullability updates to direct fields of one existing Z* or Y* transparent table. The complete active table definition and technical settings are preserved outside the requested changes. Requires the current version and SHA-256 fingerprint, exact package, existing transport, destructive-schema confirmation, and data-loss acknowledgement. MANDT, Include/Append layouts, technical settings, automatic retry/rollback, SAP lock clearing, and transport release are not supported.",
    inputSchema: {
      ...writeOperationInput,
      objectName: z.string(),
      expectedVersion: z.string(),
      expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
      changes: z.array(ddicTableFieldChange).min(1).max(32),
      packageName: z.string(),
      transportNumber: z.string(),
      confirmation: z.literal("DESTRUCTIVE_SCHEMA_CHANGE"),
      acknowledgeDataLoss: z.literal(true),
      connectionId: z.string()
    }
  },
  read_ddic_table_type: {
    description:
      "Read one active SAP Dictionary table type, including line type, table/key settings, package, concurrency version, and SHA-256 definition fingerprint. Read-only and allowed for customer or standard objects.",
    inputSchema: { objectName: z.string(), connectionId: z.string() }
  },
  upsert_ddic_table_type: {
    description:
      "Create or fully replace one Z* or Y* STANDARD table type with a structure row type and default key. Existing objects require the version returned by read_ddic_table_type. Requires an existing package and transport.",
    inputSchema: {
      ...writeOperationInput,
      objectName: z.string(),
      description: z.string(),
      rowType: z.string(),
      packageName: z.string(),
      transportNumber: z.string(),
      expectedVersion: z.string().optional(),
      connectionId: z.string()
    }
  },
  delete_ddic_object: {
    description:
      "Permanently delete one existing Z* or Y* domain, data element, structure, table type, or transparent table after SAP dependency checking. Requires the current version, exact transportable package, an existing transport, and explicit confirmation. Transparent-table deletion additionally requires data-loss acknowledgement. SAP references block deletion; automatic retry/rollback, SAP lock clearing, and transport release are not supported.",
    inputSchema: {
      ...writeOperationInput,
      objectType: z.enum(["DOMA", "DTEL", "STRU", "TTYP", "TABL"]),
      objectName: z.string(),
      expectedVersion: z.string(),
      packageName: z.string(),
      transportNumber: z.string(),
      confirmation: z.literal("PERMANENT_DELETE"),
      acknowledgeDataLoss: z.boolean().optional(),
      connectionId: z.string()
    }
  },
  search_abap_objects: {
    description:
      "Search ABAP objects by name pattern. Wildcards: * ?. Custom code: prefix Z* or Y* (Z*ARTICLE*, not *ARTICLE*). Standard SAP: BAPI_*, CL_*, /SAP/*. MANDATORY before code generation: training data outdated - ALWAYS verify objects exist first, read signatures with get_abap_object_lines, then generate. Unverified code WILL fail at runtime.",
    inputSchema: {
      pattern: z.string(),
      types: z.array(objectType),
      maxResults: z.number().default(20).optional(),
      connectionId: z.string()
    }
  },
  get_abap_object_info: {
    description:
      "Get ABAP object metadata: type, total lines, cache status. Use before retrieving content to understand what kind of object you're dealing with.",
    inputSchema: {
      objectName: z.string(),
      objectType: objectType.optional(),
      connectionId: z.string()
    }
  },
  get_abap_object_lines: {
    description:
      "Read active ABAP source and return the SHA-256 fingerprint of the complete untrimmed source. objectType disambiguates same-named objects. methodName extracts one method body from a class while retaining the complete-source fingerprint.",
    inputSchema: {
      objectName: z.string(),
      objectType: objectType.optional(),
      methodName: z.string().optional(),
      startLine: z.number().default(1).optional(),
      lineCount: z.number().default(50).optional(),
      connectionId: z.string()
    }
  },
  get_batch_lines: {
    description: "Read lines from multiple ABAP objects in one call.",
    inputSchema: {
      requests: z.array(
        z.object({
          objectName: z.string(),
          startLine: z.number().default(0).optional(),
          lineCount: z.number().default(10).optional()
        })
      ),
      connectionId: z.string()
    }
  },
  get_object_by_uri: {
    description:
      "Read ABAP object by direct ADT URI. Use when URI already known from search results — skips name resolution.",
    inputSchema: {
      uri: z.string(),
      startLine: z.number().default(0).optional(),
      lineCount: z.number().default(50).optional(),
      connectionId: z.string()
    }
  },
  search_abap_object_lines: {
    description:
      "Search text inside ABAP source. Literal or regex (isRegexp=true). objectName wildcards scan multiple objects (max 10). Searches active committed SAP source.",
    inputSchema: {
      objectName: z.string(),
      searchTerm: z.string(),
      contextLines: z.number().default(3).optional(),
      connectionId: z.string(),
      isRegexp: z.boolean().default(false).optional(),
      maxObjects: z.number().min(1).max(10).default(1).optional()
    }
  },
  get_abap_object_workspace_uri: {
    description:
      "Get a deterministic standalone adt:// URI for an exact ABAP object. All params are mandatory. Function modules are supported with type FUGR/FF.",
    inputSchema: {
      objectName: z.string(),
      objectType: z.string(),
      connectionId: z.string()
    }
  },
  get_abap_object_url: {
    description:
      "Return SAP GUI WebGUI URL for an ABAP object (SE38 reports, SE24 classes, SE37 function modules).",
    inputSchema: {
      objectName: z.string(),
      objectType: z.string().default("PROG/P").optional(),
      connectionId: z.string()
    }
  },
  find_where_used: {
    description:
      "Where-used analysis for ABAP objects, methods, variables, and symbols, with filtering and pagination.",
    inputSchema: {
      objectName: z.string(),
      objectType: z.string().optional(),
      searchTerm: z.string().optional(),
      line: z.number().optional(),
      character: z.number().optional(),
      connectionId: z.string(),
      maxResults: z.number().optional(),
      includeSnippets: z.boolean().optional(),
      startIndex: z.number().optional(),
      filter: z
        .object({
          objectNamePattern: z.string().optional(),
          objectTypes: z.array(z.string()).optional(),
          excludeSystemObjects: z.boolean().optional()
        })
        .optional()
    }
  },
  get_sap_system_info: {
    description:
      "Get SAP system info: client, system type, release, timezone, and optional software components.",
    inputSchema: {
      connectionId: z.string(),
      includeComponents: z.boolean().default(false).optional()
    }
  },
  get_version_history: {
    description:
      "ABAP object version history. Actions: list_versions, get_version_source, compare_versions. Version 1 is most recent.",
    inputSchema: {
      objectName: z.string(),
      objectType: z.string().optional(),
      connectionId: z.string(),
      action: z
        .enum(["list_versions", "get_version_source", "compare_versions"])
        .default("list_versions")
        .optional(),
      versionNumber: z.number().optional(),
      version1: z.number().optional(),
      version2: z.number().optional(),
      maxVersions: z.number().default(20).optional()
    }
  },
  replace_string_in_abap_object: {
    description:
      "Edit a Z* or Y* customer source by exact unique string replacement. Supported targets: classes, interfaces, programs, includes, function groups, function modules, function-group includes, DDL sources, and DCL sources. Standard owners and children are rejected before locking. The service rejects pre-existing inactive source, locks, saves with an explicit or existing transport, unlocks, and activates. It never creates or releases transports.",
    inputSchema: {
      ...writeOperationInput,
      fileUri: z.string(),
      oldString: z.string(),
      newString: z.string(),
      transportNumber: z.string().optional()
    }
  },
  abap_activate: {
    description:
      "Activate an explicit Z* or Y* ABAP object URI. Returns activation errors and leaves transport release to the user.",
    inputSchema: {
      ...writeOperationInput,
      url: z.string()
    }
  },
  create_object_programmatically: {
    description:
      "Create and activate a new Z* or Y* customer source object without VS Code. Supported types: classes, interfaces, programs, includes, function groups, function modules, function-group includes, DDL sources, and DCL sources. Function children require a Z* or Y* parentName. $TMP is local; non-local packages require an existing transport. The service never creates or releases transports.",
    inputSchema: {
      ...writeOperationInput,
      objectType: z.string(),
      name: z.string(),
      description: z.string(),
      packageName: z.string().default("$TMP").optional(),
      parentName: z.string().optional(),
      connectionId: z.string(),
      additionalOptions: z
        .object({
          serviceDefinition: z.string().optional(),
          bindingType: z.string().optional(),
          bindingCategory: z.string().optional(),
          softwareComponent: z.string().optional(),
          packageType: z.string().optional(),
          transportLayer: z.string().optional(),
          transportRequest: z
            .object({
              type: z.enum(["new", "existing"]),
              number: z.string().optional(),
              description: z.string().optional()
            })
            .optional()
        })
        .optional()
    }
  },
  delete_abap_source_object: {
    description:
      "Permanently delete one existing Z* or Y* class, interface, program, Include, function group, function-group Include, or function module. For FUGR/I, objectName may be the three-character Include suffix or its full technical name; the Z* or Y* parentName and exact ADT ownership must match. Requires the exact object type, current SHA-256 source fingerprint, package, existing transport, explicit confirmation, SAP locking, and post-delete absence verification; transports are never released.",
    inputSchema: {
      ...writeOperationInput,
      objectType: z.enum(["CLAS/OC", "INTF/OI", "PROG/P", "PROG/I", "FUGR/F", "FUGR/I", "FUGR/FF"]),
      objectName: z.string(),
      parentName: z.string().optional(),
      expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
      packageName: z.string(),
      transportNumber: z.string(),
      confirmation: z.literal("PERMANENT_DELETE"),
      connectionId: z.string()
    }
  },
  create_test_include: {
    description:
      "Create and activate the ABAP Unit test include for an existing Z* or Y* class. Rejects classes that already have a test include and uses the class's existing transport assignment or local-object status.",
    inputSchema: {
      ...writeOperationInput,
      className: z.string(),
      connectionId: z.string()
    }
  },
  manage_text_elements: {
    description:
      "Read, create, or update text symbols in Z* or Y* programs, classes, and function groups. Writes use the installed ECC repository helper when ADT text locking is unavailable, merge with existing symbols, preserve unrelated entries, reuse the object's existing transport assignment, and verify the saved text pool. The service never creates or releases transports.",
    inputSchema: {
      ...writeOperationInput,
      objectName: z.string(),
      objectType: z.enum(["PROGRAM", "CLASS", "FUNCTION_GROUP"]),
      action: z.enum(["read", "create", "update"]),
      textElements: z
        .array(
          z.object({
            id: z.string().regex(/^[A-Z0-9_]{1,8}$/),
            text: z.string().max(255),
            maxLength: z.number().min(1).max(255).optional()
          })
        )
        .min(1)
        .optional(),
      connectionId: z.string()
    }
  },
  get_abap_diagnostics: {
    description:
      "Run the SAP ADT syntax check for an ABAP source URI. This checks active server source and does not edit or activate the object.",
    inputSchema: {
      fileUri: z.string()
    }
  },
  get_abap_sql_syntax: {
    description:
      "MANDATORY before execute_data_query: return the standalone ABAP SQL safety and syntax guide. No params.",
    inputSchema: {}
  },
  execute_data_query: {
    description:
      "Run a read-only ABAP SQL SELECT through SAP ADT and return bounded JSON text. Standalone mode supports displayMode=internal only; rowRange is mandatory and at most 1000 rows. UI, files, webviews, direct data, and mutations are rejected.",
    inputSchema: {
      sql: z.string().optional(),
      data: z
        .object({
          columns: z
            .array(
              z.object({
                name: z.string(),
                type: z.string(),
                description: z.string().optional()
              })
            )
            .min(1),
          values: z.array(z.record(z.string(), z.unknown()))
        })
        .optional(),
      displayMode: z.enum(["internal", "ui", "download_to_file"]),
      webviewId: z.string().optional(),
      connectionId: z.string(),
      title: z.string().optional(),
      maxRows: z.number().min(1).max(50000).optional(),
      rowRange: z
        .object({
          start: z.number().min(0),
          end: z.number().min(1)
        })
        .optional(),
      sortColumns: z
        .array(
          z.object({
            column: z.string(),
            direction: z.enum(["asc", "desc"])
          })
        )
        .optional(),
      filters: z
        .array(
          z.object({
            column: z.string(),
            value: z.string()
          })
        )
        .optional(),
      resetSorting: z.boolean().optional(),
      resetFilters: z.boolean().optional(),
      filePath: z.string().optional(),
      fileType: z.enum(["xlsx", "csv"]).optional()
    }
  },
  run_atc_analysis: {
    description:
      "Run read-only ATC analysis on an explicit SAP object or fetch finding documentation. No active-editor fallback and no automatic fixes.",
    inputSchema: {
      action: z.enum(["run_analysis", "get_documentation"]).default("run_analysis").optional(),
      objectName: z.string().optional(),
      objectType: z.string().optional(),
      objectUri: z.string().optional(),
      connectionId: z.string().optional(),
      useActiveFile: z.boolean().default(false).optional(),
      scope: z.enum(["object", "package", "transport"]).optional(),
      docUri: z.string().optional()
    }
  },
  run_unit_tests: {
    description:
      "Run existing short, harmless ABAP Unit tests for an object without saving or activating it. Test code may have side effects; obtain authorization before live execution.",
    inputSchema: {
      objectName: z.string(),
      connectionId: z.string()
    }
  },
  analyze_abap_dumps: {
    description:
      "Read ABAP runtime dumps through SAP ADT. Actions: list_dumps or analyze_dump. This tool does not create or delete dumps.",
    inputSchema: {
      action: z.enum(["list_dumps", "analyze_dump"]),
      connectionId: z.string(),
      dumpId: z.string().optional(),
      maxResults: z.number().optional(),
      includeFullContent: z.boolean().optional()
    }
  },
  analyze_abap_traces: {
    description:
      "Read existing ABAP performance trace runs and configurations. This tool never starts, changes, or deletes traces.",
    inputSchema: {
      action: z.enum([
        "list_runs",
        "list_configurations",
        "analyze_run",
        "get_statements",
        "get_hitlist"
      ]),
      connectionId: z.string(),
      traceId: z.string().optional(),
      maxResults: z.number().optional(),
      includeDetails: z.boolean().optional()
    }
  },
  manage_transport_requests: {
    description:
      "Read SAP transport requests. Actions: get_user_transports, get_transport_details, get_transport_objects, compare_transports. Standalone mode never creates, changes, deletes, or releases transports.",
    inputSchema: {
      action: z.enum([
        "get_user_transports",
        "get_transport_details",
        "get_transport_objects",
        "compare_transports"
      ]),
      connectionId: z.string(),
      transportNumber: z.string().optional(),
      transportNumbers: z.array(z.string()).optional(),
      user: z.string().optional()
    }
  },
  abap_download: {
    description:
      "Download an ABAP resource (package, program, class, function group, folder, or single file) to a local folder. Recursive for folders/packages. Preferred source: full adt:// workspace URI (from get_abap_object_workspace_uri). Also accepts ADT paths (/sap/bc/adt/...) or bare object names with connectionId (+ optional objectType for disambiguation). NOTE: downloading a program does NOT automatically download its includes - includes are separate objects; download them explicitly (or download the parent package to get everything).",
    inputSchema: {
      source: z.string(),
      target: z.string(),
      connectionId: z.string().optional(),
      objectType: z.string().optional(),
      overwrite: z.boolean().optional()
    }
  },
  adt_discovery_export: {
    description:
      "Export full ADT discovery tree (workspaces, collections, RES_APP classes from SEOMETAREL) to markdown files.",
    inputSchema: {
      connectionId: z.string()
    }
  }
} as const

export type ToolName = keyof typeof toolContracts
