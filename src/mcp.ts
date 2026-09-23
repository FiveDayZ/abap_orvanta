import { randomUUID } from "node:crypto"
import { z } from "zod"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { SapBackend } from "./backend.js"
import { toolContracts } from "./contracts.js"
import type { InvocationReceiptStore } from "./invocation-receipts.js"
import { ToolService } from "./tools.js"
import { observeWritePreChange } from "./write-prechange-evidence.js"
import { hashWriteInput, type WriteOperationReceiptStore } from "./write-operation-receipts.js"
import { PRODUCT_VERSION } from "./version.js"
import { ApplicationLogService } from "./application-logs.js"
import { OperationalLogService } from "./operational-logs.js"
import { LogCorrelationService } from "./log-correlation.js"
import { defaultInvocationStateRoot } from "./invocation-receipts.js"
import { RuntimeIdentity } from "./runtime-info.js"
import { MaintenanceDiagnosticService } from "./maintenance-diagnostics.js"
import { collectChangeImpact } from "./change-impact.js"
import { readReportVariants } from "./report-variants.js"
import { SmartformService } from "./smartforms.js"
import { resolveToolProfile, toolProfileSummary } from "./tool-profile.js"

export function createMcpServer(
  backend: SapBackend,
  invocationReceipts: InvocationReceiptStore,
  writeReceipts: WriteOperationReceiptStore,
  beginOperation?: () => () => void,
  stateRoot = defaultInvocationStateRoot(),
  runtimeIdentity = new RuntimeIdentity()
): McpServer {
  const server = new McpServer({
    name: "orvanta",
    version: PRODUCT_VERSION
  })
  // Tool surface gate (`ABAP_MCP_TOOL_PROFILE` / `ABAP_MCP_TOOL_DENY`). Every tool is still
  // registered with its own contract and handler; tools outside the selected profile are
  // disabled, so both `tools/list` and `tools/call` stop exposing them. The default profile
  // is `full`, which keeps the previous behaviour of exposing all tools.
  const toolProfile = resolveToolProfile()
  const enabledToolNames = new Set(toolProfile.enabled)
  type RegisterTool = typeof server.registerTool
  const registerUnfiltered = server.registerTool.bind(server) as RegisterTool
  /**
   * Reject arguments the contract does not declare, instead of discarding them.
   *
   * Zod strips unknown keys by default, and the SDK validates before the handler runs, so an
   * undeclared argument is already gone by the time any handler could notice it. That is how a
   * caller can pass selectionMethod to upsert_search_help, get no error, and end up with a search
   * help that has no selection method at all: the mistake surfaces later as a wrong object rather
   * than as a rejected request. It cost a real misdiagnosis here, because the same silent strip
   * made a correct verification look like two product defects.
   *
   * Every contract supplies a raw Zod shape, so wrapping it in a strict object is a single place
   * that covers the whole tool surface. A contract that already supplies a built schema is left
   * exactly as it is.
   */
  const strictInputSchema = (schema: unknown): unknown => {
    if (!schema || typeof schema !== "object" || "parse" in schema) return schema
    return z.object(schema as z.ZodRawShape).strict()
  }
  const registerTool = ((name: string, config: unknown, callback: unknown) => {
    const contract = config as { inputSchema?: unknown } | null
    const strictConfig =
      contract && typeof contract === "object"
        ? { ...contract, inputSchema: strictInputSchema(contract.inputSchema) }
        : config
    const registered = registerUnfiltered(name as never, strictConfig as never, callback as never)
    if (!enabledToolNames.has(name)) registered.disable()
    return registered
  }) as unknown as RegisterTool
  const tools = new ToolService(backend, undefined, invocationReceipts, toolProfile.disabled)
  const smartforms = new SmartformService(backend, stateRoot)
  const applicationLogs = new ApplicationLogService(
    backend,
    stateRoot,
    async (connectionId, functionName) =>
      JSON.parse(await tools.readFunctionModuleInterface({ connectionId, functionName }))
  )
  const operationalLogs = new OperationalLogService(
    backend,
    stateRoot,
    async (connectionId, functionName) =>
      JSON.parse(await tools.readFunctionModuleInterface({ connectionId, functionName }))
  )
  const maintenance = new MaintenanceDiagnosticService(
    backend,
    stateRoot,
    async (connectionId, functionName) =>
      JSON.parse(await tools.readFunctionModuleInterface({ connectionId, functionName })),
    (connectionId, operationId) => writeReceipts.status(connectionId, operationId)
  )
  const logCorrelation = new LogCorrelationService(
    applicationLogs,
    operationalLogs,
    (input) => tools.diagnoseSapFailure(input),
    (id) => backend.connectionDetails(id).client,
    maintenance
  )
  async function tracked<T>(action: () => Promise<T>): Promise<T> {
    const finish = beginOperation?.()
    try {
      return await action()
    } finally {
      finish?.()
    }
  }
  const invoke = (...args: Parameters<typeof invokeTool>) => tracked(() => invokeTool(...args))
  const invokeWrite = <T extends object>(...args: Parameters<typeof invokeWriteTool<T>>) =>
    tracked(() => invokeWriteTool(...args))

  registerTool("read_smartform", toolContracts.read_smartform, async (input) =>
    invoke("read_smartform", async () => JSON.stringify(await smartforms.read(input)))
  )
  registerTool("create_smartform", toolContracts.create_smartform, async (input) =>
    invokeWrite("create_smartform", input, backend, writeReceipts, async (beforeInvoke) =>
      JSON.stringify(await smartforms.write("CREATE", input, beforeInvoke))
    )
  )
  registerTool("save_smartform", toolContracts.save_smartform, async (input) =>
    invokeWrite("save_smartform", input, backend, writeReceipts, async (beforeInvoke) =>
      JSON.stringify(await smartforms.write("SAVE", input, beforeInvoke))
    )
  )
  registerTool("activate_smartform", toolContracts.activate_smartform, async (input) =>
    invokeWrite("activate_smartform", input, backend, writeReceipts, async (beforeInvoke) =>
      JSON.stringify(await smartforms.write("ACTIVATE", input, beforeInvoke))
    )
  )

  registerTool("get_connected_systems", toolContracts.get_connected_systems, async () =>
    textResult(tools.getConnectedSystems())
  )
  registerTool("get_capability_report", toolContracts.get_capability_report, async (input) =>
    invoke("get_capability_report", () => tools.getCapabilityReport(input))
  )
  registerTool("get_runtime_info", toolContracts.get_runtime_info, async (input) =>
    invoke("get_runtime_info", async () =>
      JSON.stringify(
        { ...(await runtimeIdentity.report(input)), toolProfile: toolProfileSummary(toolProfile) },
        null,
        2
      )
    )
  )
  registerTool("search_sap_locks", toolContracts.search_sap_locks, async (input) =>
    invoke("search_sap_locks", () => maintenance.searchLocks(input))
  )
  registerTool("search_failed_updates", toolContracts.search_failed_updates, async (input) =>
    invoke("search_failed_updates", () => maintenance.searchUpdates(input))
  )
  registerTool("read_failed_update", toolContracts.read_failed_update, async (input) =>
    invoke("read_failed_update", () => maintenance.readUpdate(input))
  )
  registerTool("preview_source_changes", toolContracts.preview_source_changes, async (input) =>
    invoke("preview_source_changes", () => tools.previewSourceChanges(input))
  )
  registerTool("abap_debug_session", toolContracts.abap_debug_session, async (input) =>
    invoke("abap_debug_session", () => tools.debugSession(input))
  )
  registerTool("abap_debug_breakpoint", toolContracts.abap_debug_breakpoint, async (input) =>
    invoke("abap_debug_breakpoint", () => tools.debugBreakpoint(input))
  )
  registerTool("abap_debug_status", toolContracts.abap_debug_status, async (input) =>
    textResult(tools.debugStatus(input))
  )
  registerTool("abap_debug_stack", toolContracts.abap_debug_stack, async (input) =>
    invoke("abap_debug_stack", () => tools.debugStack(input))
  )
  registerTool("abap_debug_variable", toolContracts.abap_debug_variable, async (input) =>
    invoke("abap_debug_variable", () => tools.debugVariable(input))
  )
  registerTool("abap_debug_step", toolContracts.abap_debug_step, async (input) =>
    invoke("abap_debug_step", () => tools.debugStep(input))
  )
  registerTool("sap_helper_status", toolContracts.sap_helper_status, async (input) =>
    invoke("sap_helper_status", () => tools.sapHelperStatus(input))
  )
  registerTool("read_sapscript_form", toolContracts.read_sapscript_form, async (input) =>
    invoke("read_sapscript_form", () => tools.readSapscriptForm(input))
  )
  registerTool("read_smartstyle", toolContracts.read_smartstyle, async (input) =>
    invoke("read_smartstyle", () => tools.readSmartstyle(input))
  )
  registerTool("read_adobe_form", toolContracts.read_adobe_form, async (input) =>
    invoke("read_adobe_form", () => tools.readAdobeForm(input))
  )
  registerTool("create_transport_request", toolContracts.create_transport_request, async (input) =>
    invokeWrite("create_transport_request", input, backend, writeReceipts, () =>
      tools.createTransportRequest(input)
    )
  )
  registerTool("read_abap_screen", toolContracts.read_abap_screen, async (input) =>
    invoke("read_abap_screen", () => tools.readAbapScreen(input))
  )
  registerTool("upsert_abap_screen", toolContracts.upsert_abap_screen, async (input) =>
    invokeWrite("upsert_abap_screen", input, backend, writeReceipts, () =>
      tools.upsertAbapScreen(input)
    )
  )
  registerTool("patch_abap_screen", toolContracts.patch_abap_screen, async (input) =>
    invokeWrite("patch_abap_screen", input, backend, writeReceipts, () =>
      tools.patchAbapScreen(input)
    )
  )
  registerTool(
    "validate_dynpro_application",
    toolContracts.validate_dynpro_application,
    async (input) =>
      invoke("validate_dynpro_application", () => tools.validateDynproApplication(input))
  )
  registerTool("read_abap_gui_definition", toolContracts.read_abap_gui_definition, async (input) =>
    invoke("read_abap_gui_definition", () => tools.readAbapGuiDefinition(input))
  )
  registerTool(
    "patch_abap_gui_definition",
    toolContracts.patch_abap_gui_definition,
    async (input) =>
      invokeWrite("patch_abap_gui_definition", input, backend, writeReceipts, () =>
        tools.patchAbapGuiDefinition(input)
      )
  )
  registerTool("create_module_pool", toolContracts.create_module_pool, async (input) =>
    invokeWrite("create_module_pool", input, backend, writeReceipts, () =>
      tools.createModulePool(input)
    )
  )
  registerTool("delete_module_pool", toolContracts.delete_module_pool, async (input) =>
    invokeWrite("delete_module_pool", input, backend, writeReceipts, () =>
      tools.deleteModulePool(input)
    )
  )
  registerTool("read_transaction_code", toolContracts.read_transaction_code, async (input) =>
    invoke("read_transaction_code", () => tools.readTransactionCode(input))
  )
  registerTool("create_transaction_code", toolContracts.create_transaction_code, async (input) =>
    invokeWrite("create_transaction_code", input, backend, writeReceipts, () =>
      tools.createTransactionCode(input)
    )
  )
  registerTool("delete_transaction_code", toolContracts.delete_transaction_code, async (input) =>
    invokeWrite("delete_transaction_code", input, backend, writeReceipts, () =>
      tools.deleteTransactionCode(input)
    )
  )
  registerTool(
    "create_report_transaction",
    toolContracts.create_report_transaction,
    async (input) =>
      invokeWrite("create_report_transaction", input, backend, writeReceipts, () =>
        tools.createReportTransaction(input)
      )
  )
  registerTool(
    "read_function_module_interface",
    toolContracts.read_function_module_interface,
    async (input) =>
      invoke("read_function_module_interface", () => tools.readFunctionModuleInterface(input))
  )
  registerTool(
    "test_remote_function_module",
    toolContracts.test_remote_function_module,
    async (input) =>
      invokeWrite("test_remote_function_module", input, backend, writeReceipts, (beforeInvoke) =>
        tools.testRemoteFunctionModule(input, beforeInvoke)
      )
  )
  registerTool(
    "invoke_customer_function_module",
    toolContracts.invoke_customer_function_module,
    async (input) =>
      invokeWrite(
        "invoke_customer_function_module",
        input,
        backend,
        writeReceipts,
        (beforeInvoke) => tools.invokeCustomerFunctionModule(input, beforeInvoke)
      )
  )
  registerTool(
    "get_customer_function_call_status",
    toolContracts.get_customer_function_call_status,
    async (input) =>
      invoke("get_customer_function_call_status", () => tools.getCustomerFunctionCallStatus(input))
  )
  registerTool(
    "get_write_operation_status",
    toolContracts.get_write_operation_status,
    async (input) =>
      invoke("get_write_operation_status", async () =>
        JSON.stringify(
          {
            operationId: input.operationId,
            ...(await writeReceipts.status(input.connectionId.toLowerCase(), input.operationId))
          },
          null,
          2
        )
      )
  )
  registerTool(
    "list_write_recovery_operations",
    toolContracts.list_write_recovery_operations,
    async (input) =>
      invoke("list_write_recovery_operations", async () =>
        JSON.stringify(
          await writeReceipts.listRecoveryOperations(
            input.connectionId.toLowerCase(),
            input.maxResults ?? 50
          ),
          null,
          2
        )
      )
  )
  registerTool(
    "release_write_operation_lock",
    toolContracts.release_write_operation_lock,
    async (input) =>
      invoke("release_write_operation_lock", async () =>
        JSON.stringify(
          {
            operationId: input.operationId,
            ...(await writeReceipts.releaseLocalLock(
              input.connectionId.toLowerCase(),
              input.operationId,
              input.expectedReceiptHash,
              input.reason
            ))
          },
          null,
          2
        )
      )
  )
  registerTool(
    "create_function_module_with_interface",
    toolContracts.create_function_module_with_interface,
    async (input) =>
      invokeWrite("create_function_module_with_interface", input, backend, writeReceipts, () =>
        tools.createFunctionModuleWithInterface(input)
      )
  )
  registerTool(
    "patch_function_module_interface",
    toolContracts.patch_function_module_interface,
    async (input) =>
      invokeWrite("patch_function_module_interface", input, backend, writeReceipts, () =>
        tools.patchFunctionModuleInterface(input)
      )
  )
  registerTool(
    "write_function_module_source",
    toolContracts.write_function_module_source,
    async (input) =>
      invokeWrite("write_function_module_source", input, backend, writeReceipts, () =>
        tools.writeFunctionModuleSource(input)
      )
  )
  registerTool(
    "inspect_repository_assignment",
    toolContracts.inspect_repository_assignment,
    async (input) =>
      invoke("inspect_repository_assignment", () => tools.inspectRepositoryAssignment(input))
  )
  registerTool("read_abap_message_class", toolContracts.read_abap_message_class, async (input) =>
    invoke("read_abap_message_class", () => tools.readAbapMessageClass(input))
  )
  registerTool(
    "create_abap_message_class",
    toolContracts.create_abap_message_class,
    async (input) =>
      invokeWrite("create_abap_message_class", input, backend, writeReceipts, () =>
        tools.createAbapMessageClass(input)
      )
  )
  registerTool(
    "update_abap_message_class",
    toolContracts.update_abap_message_class,
    async (input) =>
      invokeWrite("update_abap_message_class", input, backend, writeReceipts, () =>
        tools.updateAbapMessageClass(input)
      )
  )
  registerTool(
    "delete_abap_message_class",
    toolContracts.delete_abap_message_class,
    async (input) =>
      invokeWrite("delete_abap_message_class", input, backend, writeReceipts, () =>
        tools.deleteAbapMessageClass(input)
      )
  )
  registerTool("read_ddic_domain", toolContracts.read_ddic_domain, async (input) =>
    invoke("read_ddic_domain", () => tools.readDdicDomain(input))
  )
  registerTool("upsert_ddic_domain", toolContracts.upsert_ddic_domain, async (input) =>
    invokeWrite("upsert_ddic_domain", input, backend, writeReceipts, () =>
      tools.upsertDdicDomain(input)
    )
  )
  registerTool("read_search_help", toolContracts.read_search_help, async (input) =>
    invoke("read_search_help", () => tools.readSearchHelp(input))
  )
  registerTool("upsert_search_help", toolContracts.upsert_search_help, async (input) =>
    invokeWrite("upsert_search_help", input, backend, writeReceipts, () =>
      tools.upsertSearchHelp(input)
    )
  )
  registerTool("read_lock_object", toolContracts.read_lock_object, async (input) =>
    invoke("read_lock_object", () => tools.readLockObject(input))
  )
  registerTool("upsert_lock_object", toolContracts.upsert_lock_object, async (input) =>
    invokeWrite("upsert_lock_object", input, backend, writeReceipts, () =>
      tools.upsertLockObject(input)
    )
  )
  registerTool("read_number_range_object", toolContracts.read_number_range_object, async (input) =>
    invoke("read_number_range_object", () => tools.readNumberRangeObject(input))
  )
  registerTool(
    "upsert_number_range_object",
    toolContracts.upsert_number_range_object,
    async (input) =>
      invokeWrite("upsert_number_range_object", input, backend, writeReceipts, () =>
        tools.upsertNumberRangeObject(input)
      )
  )
  registerTool("read_maintenance_view", toolContracts.read_maintenance_view, async (input) =>
    invoke("read_maintenance_view", () => tools.readMaintenanceView(input))
  )
  registerTool("upsert_maintenance_view", toolContracts.upsert_maintenance_view, async (input) =>
    invokeWrite("upsert_maintenance_view", input, backend, writeReceipts, () =>
      tools.upsertMaintenanceView(input)
    )
  )
  registerTool(
    "upsert_append_structure_fields",
    toolContracts.upsert_append_structure_fields,
    async (input) =>
      invokeWrite("upsert_append_structure_fields", input, backend, writeReceipts, () =>
        tools.upsertAppendStructureFields(input)
      )
  )
  registerTool("read_ddic_data_element", toolContracts.read_ddic_data_element, async (input) =>
    invoke("read_ddic_data_element", () => tools.readDdicDataElement(input))
  )
  registerTool("upsert_ddic_data_element", toolContracts.upsert_ddic_data_element, async (input) =>
    invokeWrite("upsert_ddic_data_element", input, backend, writeReceipts, () =>
      tools.upsertDdicDataElement(input)
    )
  )
  registerTool("read_ddic_structure", toolContracts.read_ddic_structure, async (input) =>
    invoke("read_ddic_structure", () => tools.readDdicStructure(input))
  )
  registerTool("upsert_ddic_structure", toolContracts.upsert_ddic_structure, async (input) =>
    invokeWrite("upsert_ddic_structure", input, backend, writeReceipts, () =>
      tools.upsertDdicStructure(input)
    )
  )
  registerTool(
    "read_ddic_transparent_table",
    toolContracts.read_ddic_transparent_table,
    async (input) =>
      invoke("read_ddic_transparent_table", () => tools.readDdicTransparentTable(input))
  )
  registerTool(
    "create_ddic_transparent_table",
    toolContracts.create_ddic_transparent_table,
    async (input) =>
      invokeWrite("create_ddic_transparent_table", input, backend, writeReceipts, () =>
        tools.createDdicTransparentTable(input)
      )
  )
  registerTool(
    "append_ddic_transparent_table_fields",
    toolContracts.append_ddic_transparent_table_fields,
    async (input) =>
      invokeWrite("append_ddic_transparent_table_fields", input, backend, writeReceipts, () =>
        tools.appendDdicTransparentTableFields(input)
      )
  )
  registerTool(
    "patch_ddic_transparent_table_fields",
    toolContracts.patch_ddic_transparent_table_fields,
    async (input) =>
      invokeWrite("patch_ddic_transparent_table_fields", input, backend, writeReceipts, () =>
        tools.patchDdicTransparentTableFields(input)
      )
  )
  registerTool(
    "patch_ddic_transparent_table_settings",
    toolContracts.patch_ddic_transparent_table_settings,
    async (input) =>
      invokeWrite("patch_ddic_transparent_table_settings", input, backend, writeReceipts, () =>
        tools.patchDdicTransparentTableSettings(input)
      )
  )
  registerTool(
    "read_ddic_table_conversion_status",
    toolContracts.read_ddic_table_conversion_status,
    async (input) =>
      invoke("read_ddic_table_conversion_status", () => tools.readDdicTableConversionStatus(input))
  )
  registerTool(
    "recover_ddic_table_conversion",
    toolContracts.recover_ddic_table_conversion,
    async (input) =>
      invokeWrite("recover_ddic_table_conversion", input, backend, writeReceipts, () =>
        tools.recoverDdicTableConversion(input)
      )
  )
  registerTool(
    "resume_ddic_table_activation",
    toolContracts.resume_ddic_table_activation,
    async (input) =>
      invokeWrite("resume_ddic_table_activation", input, backend, writeReceipts, () =>
        tools.resumeDdicTableActivation(input)
      )
  )
  registerTool("read_ddic_table_type", toolContracts.read_ddic_table_type, async (input) =>
    invoke("read_ddic_table_type", () => tools.readDdicTableType(input))
  )
  registerTool("upsert_ddic_table_type", toolContracts.upsert_ddic_table_type, async (input) =>
    invokeWrite("upsert_ddic_table_type", input, backend, writeReceipts, () =>
      tools.upsertDdicTableType(input)
    )
  )
  registerTool("delete_ddic_object", toolContracts.delete_ddic_object, async (input) =>
    invokeWrite("delete_ddic_object", input, backend, writeReceipts, () =>
      tools.deleteDdicObject(input)
    )
  )
  registerTool("search_abap_objects", toolContracts.search_abap_objects, async (input) =>
    invoke("search_abap_objects", () => tools.searchObjects(input))
  )
  registerTool("get_abap_object_info", toolContracts.get_abap_object_info, async (input) =>
    invoke("get_abap_object_info", () => tools.getObjectInfo(input))
  )
  registerTool("get_abap_object_lines", toolContracts.get_abap_object_lines, async (input) =>
    invoke("get_abap_object_lines", () => tools.getObjectLines(input))
  )
  registerTool("get_batch_lines", toolContracts.get_batch_lines, async (input) =>
    invoke("get_batch_lines", () => tools.getBatchLines(input))
  )
  registerTool("get_object_by_uri", toolContracts.get_object_by_uri, async (input) =>
    invoke("get_object_by_uri", () => tools.getObjectByUri(input))
  )
  registerTool("search_abap_object_lines", toolContracts.search_abap_object_lines, async (input) =>
    invoke("search_abap_object_lines", () => tools.searchObjectLines(input))
  )
  registerTool(
    "inspect_source_enhancements",
    toolContracts.inspect_source_enhancements,
    async (input) =>
      invoke("inspect_source_enhancements", () => tools.inspectSourceEnhancements(input))
  )
  registerTool(
    "search_enhancement_objects",
    toolContracts.search_enhancement_objects,
    async (input) =>
      invoke("search_enhancement_objects", () => tools.searchEnhancementObjects(input))
  )
  registerTool(
    "search_customer_exit_objects",
    toolContracts.search_customer_exit_objects,
    async (input) =>
      invoke("search_customer_exit_objects", () => tools.searchCustomerExitObjects(input))
  )
  registerTool(
    "read_customer_exit_definition",
    toolContracts.read_customer_exit_definition,
    async (input) =>
      invoke("read_customer_exit_definition", () => tools.readCustomerExitDefinition(input))
  )
  registerTool(
    "read_customer_exit_project",
    toolContracts.read_customer_exit_project,
    async (input) =>
      invoke("read_customer_exit_project", () => tools.readCustomerExitProject(input))
  )
  registerTool(
    "inspect_customer_function_exits",
    toolContracts.inspect_customer_function_exits,
    async (input) =>
      invoke("inspect_customer_function_exits", () => tools.inspectCustomerFunctionExits(input))
  )
  registerTool(
    "inspect_customer_screen_menu_exits",
    toolContracts.inspect_customer_screen_menu_exits,
    async (input) =>
      invoke("inspect_customer_screen_menu_exits", () =>
        tools.inspectCustomerScreenMenuExits(input)
      )
  )
  registerTool("search_bte_dispatchers", toolContracts.search_bte_dispatchers, async (input) =>
    invoke("search_bte_dispatchers", () => tools.searchBteDispatchers(input))
  )
  registerTool("read_bte_configuration", toolContracts.read_bte_configuration, async (input) =>
    invoke("read_bte_configuration", () => tools.readBteConfiguration(input))
  )
  registerTool(
    "prepare_enhancement_configuration_workflow",
    toolContracts.prepare_enhancement_configuration_workflow,
    async (input) =>
      invoke("prepare_enhancement_configuration_workflow", () =>
        tools.prepareEnhancementConfigurationWorkflow(input)
      )
  )
  registerTool("search_badi_objects", toolContracts.search_badi_objects, async (input) =>
    invoke("search_badi_objects", () => tools.searchBadiObjects(input))
  )
  registerTool(
    "read_classic_badi_definition",
    toolContracts.read_classic_badi_definition,
    async (input) =>
      invoke("read_classic_badi_definition", () => tools.readClassicBadiDefinition(input))
  )
  registerTool(
    "manage_classic_badi_implementation",
    toolContracts.manage_classic_badi_implementation,
    async (input) =>
      invokeWrite("manage_classic_badi_implementation", input, backend, writeReceipts, () =>
        tools.manageClassicBadiImplementation(input)
      )
  )
  registerTool(
    "read_enhancement_implementation",
    toolContracts.read_enhancement_implementation,
    async (input) =>
      invoke("read_enhancement_implementation", () => tools.readEnhancementImplementation(input))
  )
  registerTool(
    "create_enhancement_hook_implementation",
    toolContracts.create_enhancement_hook_implementation,
    async (input) =>
      invokeWrite("create_enhancement_hook_implementation", input, backend, writeReceipts, () =>
        tools.createEnhancementHookImplementation(input)
      )
  )
  registerTool(
    "create_new_badi_implementation",
    toolContracts.create_new_badi_implementation,
    async (input) =>
      invokeWrite("create_new_badi_implementation", input, backend, writeReceipts, () =>
        tools.createNewBadiImplementation(input)
      )
  )
  registerTool(
    "update_enhancement_hook_implementation",
    toolContracts.update_enhancement_hook_implementation,
    async (input) =>
      invokeWrite("update_enhancement_hook_implementation", input, backend, writeReceipts, () =>
        tools.updateEnhancementHookImplementation(input)
      )
  )
  registerTool(
    "update_new_badi_implementation",
    toolContracts.update_new_badi_implementation,
    async (input) =>
      invokeWrite("update_new_badi_implementation", input, backend, writeReceipts, () =>
        tools.updateNewBadiImplementation(input)
      )
  )
  registerTool(
    "manage_enhancement_implementation_state",
    toolContracts.manage_enhancement_implementation_state,
    async (input) =>
      invokeWrite("manage_enhancement_implementation_state", input, backend, writeReceipts, () =>
        tools.manageEnhancementImplementationState(input)
      )
  )
  registerTool(
    "delete_enhancement_implementation",
    toolContracts.delete_enhancement_implementation,
    async (input) =>
      invokeWrite("delete_enhancement_implementation", input, backend, writeReceipts, () =>
        tools.deleteEnhancementImplementation(input)
      )
  )
  registerTool(
    "inspect_enhancement_framework",
    toolContracts.inspect_enhancement_framework,
    async (input) =>
      invoke("inspect_enhancement_framework", () => tools.inspectEnhancementFramework(input))
  )
  registerTool(
    "inspect_fico_rule_exit_program",
    toolContracts.inspect_fico_rule_exit_program,
    async (input) =>
      invoke("inspect_fico_rule_exit_program", () => tools.inspectFicoRuleExitProgram(input))
  )
  registerTool(
    "get_abap_object_workspace_uri",
    toolContracts.get_abap_object_workspace_uri,
    async (input) => invoke("get_abap_object_workspace_uri", () => tools.getWorkspaceUri(input))
  )
  registerTool("get_abap_object_url", toolContracts.get_abap_object_url, async (input) =>
    invoke("get_abap_object_url", async () => tools.getObjectUrl(input))
  )
  registerTool("find_where_used", toolContracts.find_where_used, async (input) =>
    invoke("find_where_used", () => tools.findWhereUsed(input))
  )
  registerTool("analyze_change_impact", toolContracts.analyze_change_impact, async (input) =>
    invoke("analyze_change_impact", async () =>
      JSON.stringify(await collectChangeImpact(backend, input))
    )
  )
  registerTool("get_sap_system_info", toolContracts.get_sap_system_info, async (input) =>
    invoke("get_sap_system_info", () => tools.getSapSystemInfo(input))
  )
  registerTool("get_version_history", toolContracts.get_version_history, async (input) =>
    invoke("get_version_history", () => tools.getVersionHistory(input))
  )
  registerTool(
    "replace_string_in_abap_object",
    toolContracts.replace_string_in_abap_object,
    async (input) =>
      invokeWrite("replace_string_in_abap_object", input, backend, writeReceipts, () =>
        tools.replaceStringInObject(input)
      )
  )
  registerTool("abap_activate", toolContracts.abap_activate, async (input) =>
    invokeWrite("abap_activate", input, backend, writeReceipts, () => tools.activateObject(input))
  )
  registerTool(
    "create_object_programmatically",
    toolContracts.create_object_programmatically,
    async (input) =>
      invokeWrite("create_object_programmatically", input, backend, writeReceipts, () =>
        tools.createObject(input)
      )
  )
  registerTool(
    "delete_abap_source_object",
    toolContracts.delete_abap_source_object,
    async (input) =>
      invokeWrite("delete_abap_source_object", input, backend, writeReceipts, () =>
        tools.deleteSourceObject(input)
      )
  )
  registerTool("create_test_include", toolContracts.create_test_include, async (input) =>
    invokeWrite("create_test_include", input, backend, writeReceipts, () =>
      tools.createTestInclude(input)
    )
  )
  registerTool("manage_text_elements", toolContracts.manage_text_elements, async (input) =>
    input.action === "read"
      ? invoke("manage_text_elements", () => tools.manageTextElements(input))
      : invokeWrite("manage_text_elements", input, backend, writeReceipts, () =>
          tools.manageTextElements(input)
        )
  )
  registerTool("get_abap_diagnostics", toolContracts.get_abap_diagnostics, async (input) =>
    invoke("get_abap_diagnostics", () => tools.getDiagnostics(input))
  )
  registerTool("get_abap_sql_syntax", toolContracts.get_abap_sql_syntax, async () =>
    textResult(tools.getAbapSqlSyntax())
  )
  registerTool("execute_data_query", toolContracts.execute_data_query, async (input) =>
    invoke("execute_data_query", () => tools.executeDataQuery(input))
  )
  registerTool("read_report_parameters", toolContracts.read_report_parameters, async (input) =>
    invoke("read_report_parameters", () => operationalLogs.readReportParameters(input))
  )
  registerTool("read_report_variants", toolContracts.read_report_variants, async (input) =>
    invoke("read_report_variants", async () =>
      JSON.stringify(
        await readReportVariants(
          input,
          backend.connectionDetails(input.connectionId.toLowerCase()).client,
          async (query) => JSON.parse(await tools.readAbapTable(query))
        ),
        null,
        2
      )
    )
  )
  registerTool("read_abap_table", toolContracts.read_abap_table, async (input) =>
    invoke("read_abap_table", () => tools.readAbapTable(input))
  )
  registerTool("run_atc_analysis", toolContracts.run_atc_analysis, async (input) =>
    invoke("run_atc_analysis", () => tools.runAtcAnalysis(input))
  )
  registerTool("run_sci_analysis", toolContracts.run_sci_analysis, async (input) =>
    invoke("run_sci_analysis", () => tools.runSciAnalysis(input))
  )
  registerTool("run_unit_tests", toolContracts.run_unit_tests, async (input) =>
    invoke("run_unit_tests", () => tools.runUnitTests(input))
  )
  registerTool("preview_configuration", toolContracts.preview_configuration, async (input) =>
    invoke("preview_configuration", () => tools.previewConfiguration(input))
  )
  registerTool("search_background_jobs", toolContracts.search_background_jobs, async (input) =>
    invoke("search_background_jobs", () => operationalLogs.searchJobs(input))
  )
  registerTool(
    "read_background_job_details",
    toolContracts.read_background_job_details,
    async (input) =>
      invoke("read_background_job_details", () => operationalLogs.readJobDetails(input))
  )
  registerTool(
    "read_background_job_spool",
    toolContracts.read_background_job_spool,
    async (input) => invoke("read_background_job_spool", () => operationalLogs.readJobSpool(input))
  )
  registerTool("read_background_job_log", toolContracts.read_background_job_log, async (input) =>
    invoke("read_background_job_log", () => operationalLogs.readJobLog(input))
  )
  registerTool("read_system_logs", toolContracts.read_system_logs, async (input) =>
    invoke("read_system_logs", () => operationalLogs.readSystem(input))
  )
  registerTool("correlate_sap_logs", toolContracts.correlate_sap_logs, async (input) =>
    invoke("correlate_sap_logs", () => logCorrelation.correlate(input))
  )
  registerTool(
    "discover_application_logs",
    toolContracts.discover_application_logs,
    async (input) => invoke("discover_application_logs", () => applicationLogs.discover(input))
  )
  registerTool("search_application_logs", toolContracts.search_application_logs, async (input) =>
    invoke("search_application_logs", () => applicationLogs.search(input))
  )
  registerTool("read_application_log", toolContracts.read_application_log, async (input) =>
    invoke("read_application_log", () => applicationLogs.read(input))
  )
  registerTool("diagnose_sap_failure", toolContracts.diagnose_sap_failure, async (input) =>
    invoke("diagnose_sap_failure", async () =>
      tools.diagnoseSapFailure(
        input,
        input.operationId
          ? await writeReceipts.status(input.connectionId.toLowerCase(), input.operationId)
          : undefined
      )
    )
  )
  registerTool("analyze_abap_dumps", toolContracts.analyze_abap_dumps, async (input) =>
    invoke("analyze_abap_dumps", () => tools.analyzeDumps(input))
  )
  registerTool("analyze_abap_traces", toolContracts.analyze_abap_traces, async (input) =>
    invoke("analyze_abap_traces", () => tools.analyzeTraces(input))
  )
  registerTool(
    "manage_transport_requests",
    toolContracts.manage_transport_requests,
    async (input) => invoke("manage_transport_requests", () => tools.manageTransportRequests(input))
  )
  registerTool(
    "cleanup_transport_entries",
    toolContracts.cleanup_transport_entries,
    async (input) =>
      invokeWrite("cleanup_transport_entries", input, backend, writeReceipts, () =>
        tools.cleanupTransportEntries(input)
      )
  )
  registerTool("abap_download", toolContracts.abap_download, async (input) =>
    invoke("abap_download", () => tools.downloadResource(input))
  )
  registerTool("adt_discovery_export", toolContracts.adt_discovery_export, async (input) =>
    invoke("adt_discovery_export", () => tools.exportAdtDiscovery(input))
  )

  return server
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] }
}

async function invokeTool(name: string, action: () => Promise<string>) {
  try {
    return textResult(await action())
  } catch (error) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error invoking ${name}: ${String(error)}`
        }
      ],
      isError: true
    }
  }
}

async function invokeWriteTool<T extends object>(
  name: string,
  input: T,
  backend: SapBackend,
  receipts: WriteOperationReceiptStore,
  action: (beforeInvoke: () => Promise<void>) => Promise<string>
) {
  const values = input as Record<string, unknown>
  const operationId =
    typeof values.operationId === "string" && values.operationId ? values.operationId : randomUUID()
  const context = writeOperationContext(name, values, backend)
  const recoveryGuide =
    `Read back ${context.targetSummary} from SAP and compare it with the pre-change summary and requested change. ` +
    "Do not retry automatically. If the state is interrupted or uncertain, resolve locks and transport assignment in SAP before using a new operationId."
  let reservation: Awaited<ReturnType<WriteOperationReceiptStore["reserve"]>>
  try {
    reservation = await receipts.reserve({
      connectionId: context.connectionId,
      toolName: name,
      operationId,
      targetKey: context.targetKey,
      inputHash: hashWriteInput(values),
      preChangeSummary: context.preChangeSummary,
      recoveryGuide
    })
  } catch (error) {
    return {
      ...textResult(
        `Error invoking ${name}: write protection could not be established\n\nOperation Receipt\n${JSON.stringify(
          {
            operationId,
            status: "protection_failed",
            preChangeSummary: context.preChangeSummary,
            automaticRetry: false,
            automaticRollback: false,
            sapInvocationStarted: false,
            manualRecovery: `${recoveryGuide} Local protection error: ${String(error)}`
          },
          null,
          2
        )}`
      ),
      isError: true
    }
  }
  if (reservation.status !== "reserved") {
    return {
      ...textResult(
        JSON.stringify(
          {
            status:
              reservation.status === "duplicate"
                ? reservation.conflict
                  ? "operation_id_conflict"
                  : "duplicate_blocked"
                : reservation.status === "target_busy"
                  ? "target_concurrency_conflict"
                  : "protection_failed",
            operationId,
            operationReceipt: reservation.receipt
          },
          null,
          2
        )
      ),
      isError: true
    }
  }

  const started = Date.now()
  try {
    const evidence = await observeWritePreChange(
      name,
      values,
      context.connectionId,
      context.targetSummary,
      backend,
      new ToolService(backend)
    )
    await receipts.recordPreChangeEvidence(reservation.reservation, evidence)
    if (
      ![
        "test_remote_function_module",
        "invoke_customer_function_module",
        "create_smartform",
        "save_smartform",
        "activate_smartform"
      ].includes(name)
    ) {
      await receipts.markSapInvocationStarted(reservation.reservation)
    }
  } catch (error) {
    let receipt: Record<string, unknown>
    try {
      receipt = await receipts.fail(reservation.reservation, error, Date.now() - started)
    } catch (receiptError) {
      receipt = {
        status: "interrupted",
        sapInvocationStarted: false,
        automaticRetry: false,
        automaticRollback: false,
        manualRecovery: `${recoveryGuide} Receipt finalization also failed: ${String(receiptError)}`
      }
    }
    return {
      ...textResult(
        `Error invoking ${name}: SAP pre-change observation failed; the write was not invoked: ${String(error)}\n\nOperation Receipt\n${JSON.stringify(
          { operationId, ...receipt, sapInvocationStarted: false },
          null,
          2
        )}`
      ),
      isError: true
    }
  }

  let result: string
  try {
    result = await action(() => receipts.markSapInvocationStarted(reservation.reservation))
  } catch (error) {
    let receipt: Record<string, unknown>
    try {
      receipt = await receipts.fail(reservation.reservation, error, Date.now() - started)
    } catch (receiptError) {
      receipt = {
        status: "interrupted",
        automaticRetry: false,
        automaticRollback: false,
        manualRecovery: `${recoveryGuide} Receipt finalization also failed: ${String(receiptError)}`
      }
    }
    return {
      ...textResult(
        `Error invoking ${name}: ${String(error)}\n\nOperation Receipt\n${JSON.stringify(
          { operationId, ...receipt },
          null,
          2
        )}`
      ),
      isError: true
    }
  }

  try {
    const receipt = await receipts.complete(reservation.reservation, result, Date.now() - started)
    return textResult(withOperationReceipt(result, operationId, receipt))
  } catch (error) {
    return {
      ...textResult(
        `Error invoking ${name}: SAP action returned, but the result receipt could not be finalized\n\nOperation Receipt\n${JSON.stringify(
          {
            operationId,
            status: "interrupted",
            resultHash: hashWriteInput(result),
            preChangeSummary: context.preChangeSummary,
            automaticRetry: false,
            automaticRollback: false,
            sapInvocationStarted: true,
            manualRecovery: `${recoveryGuide} Receipt finalization error: ${String(error)}`
          },
          null,
          2
        )}`
      ),
      isError: true
    }
  }
}

function withOperationReceipt(
  result: string,
  operationId: string,
  receipt: Record<string, unknown>
): string {
  const operationReceipt = { operationId, ...receipt }
  try {
    const parsed = JSON.parse(result) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify({ ...parsed, operationReceipt }, null, 2)
    }
  } catch {
    // Text results keep their original body and receive a receipt footer.
  }
  return `${result}\n\nOperation Receipt\n${JSON.stringify(operationReceipt, null, 2)}`
}

export function writeOperationContext(
  name: string,
  input: Record<string, unknown>,
  backend: SapBackend
): {
  connectionId: string
  targetKey: string
  targetSummary: string
  preChangeSummary: string
} {
  const uri = String(input.fileUri ?? input.url ?? "")
  const uriConnection = /^adt:\/\/([^/]+)/i.exec(uri)?.[1]
  const connectionId = String(
    input.connectionId ?? uriConnection ?? backend.connectionIds()[0] ?? "unknown"
  ).toLowerCase()
  const target = writeOperationTarget(name, input, uri)
  const replacementSource = Array.isArray(input.source) ? input.source.join("\n") : ""
  const guard = input.expectedInterfaceFingerprint
    ? `interface fingerprint ${String(input.expectedInterfaceFingerprint)} and source fingerprint ${String(input.expectedSourceFingerprint)}`
    : input.expectedSourceFingerprint
      ? input.oldString !== undefined
        ? `${input.recoverInactiveSource === true ? "inactive" : "active"} source fingerprint ${String(input.expectedSourceFingerprint)} and exact source match ${hashWriteInput(input.oldString)}`
        : `source fingerprint ${String(input.expectedSourceFingerprint)} and complete replacement of ${Array.isArray(input.source) ? input.source.length : 0} lines hashed ${hashWriteInput(replacementSource)}`
      : input.expectedFingerprint
        ? `fingerprint ${String(input.expectedFingerprint)}`
        : input.expectedVersion
          ? `version ${String(input.expectedVersion)}`
          : input.oldString !== undefined
            ? `exact source match ${hashWriteInput(input.oldString)}`
            : name === "create_transport_request"
              ? "no modifiable request with the same owner, type and description may already exist"
              : name.startsWith("create_")
                ? "target must not already exist"
                : name.startsWith("delete_")
                  ? "target identity and repository assignment must match"
                  : "tool-specific SAP readback and lock checks"
  return {
    connectionId,
    targetKey: target.key,
    targetSummary: target.summary,
    preChangeSummary: JSON.stringify({
      target: target.summary,
      requestedOperation: name,
      concurrencyGuard: guard,
      transportNumber: input.transportNumber ?? "existing assignment",
      automaticRollback: false
    })
  }
}

export function writeOperationTarget(
  name: string,
  input: Record<string, unknown>,
  uri: string
): { key: string; summary: string } {
  if (name === "cleanup_transport_entries") {
    const task = String(input.taskNumber).toUpperCase()
    const parent = String(input.parentTransportNumber).toUpperCase()
    return { key: `CTS:${task}`, summary: `CTS task ${task} in request ${parent}` }
  }
  if (["create_smartform", "save_smartform", "activate_smartform"].includes(name)) {
    const form = String(input.formName).toUpperCase()
    return { key: `SSFO:${form}`, summary: `Smart Form ${form}` }
  }
  if (
    [
      "create_enhancement_hook_implementation",
      "create_new_badi_implementation",
      "update_enhancement_hook_implementation",
      "update_new_badi_implementation",
      "manage_enhancement_implementation_state",
      "delete_enhancement_implementation"
    ].includes(name)
  ) {
    const enhancement = String(input.enhancementName).toUpperCase()
    return { key: `ENHO:${enhancement}`, summary: `enhancement implementation ${enhancement}` }
  }
  if (name === "create_transport_request") {
    const type = String(input.requestType).toUpperCase()
    const owner = String(input.owner ?? "").toUpperCase()
    const description = String(input.description)
    return {
      key: `CTS-NEW:${type}:${owner}:${description}`,
      summary: `new CTS request of type ${type} for ${owner === "" ? "the calling user" : owner} described "${description}"`
    }
  }
  if (name === "manage_classic_badi_implementation") {
    const implementation = String(input.implementationName).toUpperCase()
    return {
      key: `SXCI:${implementation}`,
      summary: `Classic BAdI implementation ${implementation}`
    }
  }
  if (
    name === "create_transaction_code" ||
    name === "delete_transaction_code" ||
    name === "create_report_transaction"
  ) {
    const transaction = String(input.transactionCode).toUpperCase()
    return { key: `TRAN:${transaction}`, summary: `transaction ${transaction}` }
  }
  const sourceTarget = sourceWriteOperationTarget(name, input, uri)
  if (sourceTarget) return sourceTarget
  if (input.programName) {
    const program = String(input.programName).toUpperCase()
    return { key: `PROG:${program}`, summary: `program ${program}` }
  }
  if (input.transactionCode) {
    const transaction = String(input.transactionCode).toUpperCase()
    return { key: `TRAN:${transaction}`, summary: `transaction ${transaction}` }
  }
  if (input.functionName) {
    const fn = String(input.functionName).toUpperCase()
    const parent = input.functionGroup ? ` in ${String(input.functionGroup).toUpperCase()}` : ""
    return {
      key: input.functionGroup ? `FUGR:${String(input.functionGroup).toUpperCase()}` : `FUNC:${fn}`,
      summary: `function ${fn}${parent}`
    }
  }
  if (input.messageClass) {
    const messageClass = String(input.messageClass).toUpperCase()
    return { key: `MSAG:${messageClass}`, summary: `message class ${messageClass}` }
  }
  if (input.className) {
    const className = String(input.className).toUpperCase()
    return { key: `CLAS:${className}`, summary: `class ${className}` }
  }
  if (input.objectName) {
    const objectName = String(input.objectName).toUpperCase()
    const objectType = String(
      input.objectType ??
        {
          upsert_ddic_domain: "DOMA",
          upsert_ddic_data_element: "DTEL",
          upsert_ddic_structure: "TABL",
          create_ddic_transparent_table: "TABL",
          append_ddic_transparent_table_fields: "TABL",
          patch_ddic_transparent_table_fields: "TABL",
          patch_ddic_transparent_table_settings: "TABL",
          recover_ddic_table_conversion: "TABL",
          resume_ddic_table_activation: "TABL",
          upsert_ddic_table_type: "TTYP",
          upsert_search_help: "SHLP"
        }[name] ??
        "OBJECT"
    ).toUpperCase()
    return {
      key: `${objectType}:${objectName}`,
      summary: `${objectType.toLowerCase()} object ${objectName}`
    }
  }
  if (input.name) {
    const parent = input.parentName ? String(input.parentName).toUpperCase() : ""
    const object = String(input.name).toUpperCase()
    return {
      key: parent ? `PARENT:${parent}` : `OBJECT:${object}`,
      summary: parent ? `object ${object} in ${parent}` : `object ${object}`
    }
  }
  const normalizedUri = uri.trim().toLowerCase()
  return { key: `URI:${normalizedUri}`, summary: `ADT target ${normalizedUri}` }
}

function sourceWriteOperationTarget(
  name: string,
  input: Record<string, unknown>,
  uri: string
): { key: string; summary: string } | undefined {
  if (
    name === "create_module_pool" ||
    name === "delete_module_pool" ||
    name === "upsert_abap_screen" ||
    name === "patch_abap_screen" ||
    name === "patch_abap_gui_definition"
  ) {
    return sourceIdentity("PROG/P", input.programName)
  }
  if (name === "create_function_module_with_interface") {
    return sourceIdentity("FUGR/FF", input.functionName, input.functionGroup)
  }
  if (name === "patch_function_module_interface") {
    return sourceIdentity("FUGR/FF", input.functionName, input.functionGroup)
  }
  if (name === "write_function_module_source") {
    return sourceIdentity("FUGR/FF", input.functionName, input.functionGroup)
  }
  if (name === "create_test_include") {
    return sourceIdentity("CLAS/OC", input.className)
  }
  if (name === "create_object_programmatically") {
    return sourceIdentity(input.objectType, input.name, input.parentName)
  }
  if (name === "delete_abap_source_object") {
    return sourceIdentity(input.objectType, input.objectName, input.parentName)
  }
  if (name === "manage_text_elements") {
    const type = {
      PROGRAM: "PROG/P",
      CLASS: "CLAS/OC",
      FUNCTION_GROUP: "FUGR/F"
    }[String(input.objectType).toUpperCase()]
    return type ? sourceIdentity(type, input.objectName) : undefined
  }
  if (name === "replace_string_in_abap_object" || name === "abap_activate") {
    return sourceIdentityFromUri(uri)
  }
  return undefined
}

function sourceIdentity(
  objectType: unknown,
  objectName: unknown,
  parentName?: unknown
): { key: string; summary: string } {
  const type = String(objectType).toUpperCase()
  const name = String(objectName).toUpperCase()
  const parent = parentName ? String(parentName).toUpperCase() : ""
  const kind = type.startsWith("CLAS")
    ? "CLAS"
    : type.startsWith("INTF")
      ? "INTF"
      : type.startsWith("FUGR")
        ? "FUGR"
        : type.startsWith("DDLS")
          ? "DDLS"
          : type.startsWith("DCLS")
            ? "DCLS"
            : "PROG"
  const owner = kind === "FUGR" && parent ? parent : name
  const label = {
    CLAS: "class",
    INTF: "interface",
    FUGR: "function group",
    DDLS: "DDL source",
    DCLS: "DCL source",
    PROG: "program"
  }[kind]
  return {
    key: `SOURCE:${kind}:${owner}`,
    summary: parent ? `${type.toLowerCase()} ${name} in ${parent}` : `${label} ${name}`
  }
}

function sourceIdentityFromUri(uri: string): { key: string; summary: string } | undefined {
  const path = uri.replace(/^adt:\/\/[^/]+/i, "")
  const patterns: Array<[RegExp, string]> = [
    [/\/functions\/groups\/([^/]+)/i, "FUGR"],
    [/\/oo\/classes\/([^/]+)/i, "CLAS"],
    [/\/oo\/interfaces\/([^/]+)/i, "INTF"],
    [/\/programs\/(?:programs|includes)\/([^/]+)/i, "PROG"]
  ]
  for (const [pattern, kind] of patterns) {
    const match = pattern.exec(path)
    if (!match?.[1]) continue
    const name = decodeURIComponent(match[1]).toUpperCase()
    return { key: `SOURCE:${kind}:${name}`, summary: `${kind.toLowerCase()} ${name}` }
  }
  return undefined
}
