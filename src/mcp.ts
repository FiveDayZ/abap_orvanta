import { randomUUID } from "node:crypto"
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
  const tools = new ToolService(backend, undefined, invocationReceipts)
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

  server.registerTool("read_smartform", toolContracts.read_smartform, async (input) =>
    invoke("read_smartform", async () => JSON.stringify(await smartforms.read(input)))
  )
  server.registerTool("create_smartform", toolContracts.create_smartform, async (input) =>
    invokeWrite("create_smartform", input, backend, writeReceipts, async (beforeInvoke) =>
      JSON.stringify(await smartforms.write("CREATE", input, beforeInvoke))
    )
  )
  server.registerTool("save_smartform", toolContracts.save_smartform, async (input) =>
    invokeWrite("save_smartform", input, backend, writeReceipts, async (beforeInvoke) =>
      JSON.stringify(await smartforms.write("SAVE", input, beforeInvoke))
    )
  )
  server.registerTool("activate_smartform", toolContracts.activate_smartform, async (input) =>
    invokeWrite("activate_smartform", input, backend, writeReceipts, async (beforeInvoke) =>
      JSON.stringify(await smartforms.write("ACTIVATE", input, beforeInvoke))
    )
  )

  server.registerTool("get_connected_systems", toolContracts.get_connected_systems, async () =>
    textResult(tools.getConnectedSystems())
  )
  server.registerTool("get_capability_report", toolContracts.get_capability_report, async (input) =>
    invoke("get_capability_report", () => tools.getCapabilityReport(input))
  )
  server.registerTool("get_runtime_info", toolContracts.get_runtime_info, async (input) =>
    invoke("get_runtime_info", async () =>
      JSON.stringify(await runtimeIdentity.report(input), null, 2)
    )
  )
  server.registerTool("search_sap_locks", toolContracts.search_sap_locks, async (input) =>
    invoke("search_sap_locks", () => maintenance.searchLocks(input))
  )
  server.registerTool("search_failed_updates", toolContracts.search_failed_updates, async (input) =>
    invoke("search_failed_updates", () => maintenance.searchUpdates(input))
  )
  server.registerTool("read_failed_update", toolContracts.read_failed_update, async (input) =>
    invoke("read_failed_update", () => maintenance.readUpdate(input))
  )
  server.registerTool(
    "preview_source_changes",
    toolContracts.preview_source_changes,
    async (input) => invoke("preview_source_changes", () => tools.previewSourceChanges(input))
  )
  server.registerTool("abap_debug_session", toolContracts.abap_debug_session, async (input) =>
    invoke("abap_debug_session", () => tools.debugSession(input))
  )
  server.registerTool("abap_debug_breakpoint", toolContracts.abap_debug_breakpoint, async (input) =>
    invoke("abap_debug_breakpoint", () => tools.debugBreakpoint(input))
  )
  server.registerTool("abap_debug_status", toolContracts.abap_debug_status, async (input) =>
    textResult(tools.debugStatus(input))
  )
  server.registerTool("abap_debug_stack", toolContracts.abap_debug_stack, async (input) =>
    invoke("abap_debug_stack", () => tools.debugStack(input))
  )
  server.registerTool("abap_debug_variable", toolContracts.abap_debug_variable, async (input) =>
    invoke("abap_debug_variable", () => tools.debugVariable(input))
  )
  server.registerTool("abap_debug_step", toolContracts.abap_debug_step, async (input) =>
    invoke("abap_debug_step", () => tools.debugStep(input))
  )
  server.registerTool("sap_helper_status", toolContracts.sap_helper_status, async (input) =>
    invoke("sap_helper_status", () => tools.sapHelperStatus(input))
  )
  server.registerTool("read_abap_screen", toolContracts.read_abap_screen, async (input) =>
    invoke("read_abap_screen", () => tools.readAbapScreen(input))
  )
  server.registerTool("upsert_abap_screen", toolContracts.upsert_abap_screen, async (input) =>
    invokeWrite("upsert_abap_screen", input, backend, writeReceipts, () =>
      tools.upsertAbapScreen(input)
    )
  )
  server.registerTool("patch_abap_screen", toolContracts.patch_abap_screen, async (input) =>
    invokeWrite("patch_abap_screen", input, backend, writeReceipts, () =>
      tools.patchAbapScreen(input)
    )
  )
  server.registerTool(
    "validate_dynpro_application",
    toolContracts.validate_dynpro_application,
    async (input) =>
      invoke("validate_dynpro_application", () => tools.validateDynproApplication(input))
  )
  server.registerTool(
    "read_abap_gui_definition",
    toolContracts.read_abap_gui_definition,
    async (input) => invoke("read_abap_gui_definition", () => tools.readAbapGuiDefinition(input))
  )
  server.registerTool(
    "patch_abap_gui_definition",
    toolContracts.patch_abap_gui_definition,
    async (input) =>
      invokeWrite("patch_abap_gui_definition", input, backend, writeReceipts, () =>
        tools.patchAbapGuiDefinition(input)
      )
  )
  server.registerTool("create_module_pool", toolContracts.create_module_pool, async (input) =>
    invokeWrite("create_module_pool", input, backend, writeReceipts, () =>
      tools.createModulePool(input)
    )
  )
  server.registerTool("delete_module_pool", toolContracts.delete_module_pool, async (input) =>
    invokeWrite("delete_module_pool", input, backend, writeReceipts, () =>
      tools.deleteModulePool(input)
    )
  )
  server.registerTool("read_transaction_code", toolContracts.read_transaction_code, async (input) =>
    invoke("read_transaction_code", () => tools.readTransactionCode(input))
  )
  server.registerTool(
    "create_transaction_code",
    toolContracts.create_transaction_code,
    async (input) =>
      invokeWrite("create_transaction_code", input, backend, writeReceipts, () =>
        tools.createTransactionCode(input)
      )
  )
  server.registerTool(
    "delete_transaction_code",
    toolContracts.delete_transaction_code,
    async (input) =>
      invokeWrite("delete_transaction_code", input, backend, writeReceipts, () =>
        tools.deleteTransactionCode(input)
      )
  )
  server.registerTool(
    "create_report_transaction",
    toolContracts.create_report_transaction,
    async (input) =>
      invokeWrite("create_report_transaction", input, backend, writeReceipts, () =>
        tools.createReportTransaction(input)
      )
  )
  server.registerTool(
    "read_function_module_interface",
    toolContracts.read_function_module_interface,
    async (input) =>
      invoke("read_function_module_interface", () => tools.readFunctionModuleInterface(input))
  )
  server.registerTool(
    "test_remote_function_module",
    toolContracts.test_remote_function_module,
    async (input) =>
      invokeWrite("test_remote_function_module", input, backend, writeReceipts, (beforeInvoke) =>
        tools.testRemoteFunctionModule(input, beforeInvoke)
      )
  )
  server.registerTool(
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
  server.registerTool(
    "get_customer_function_call_status",
    toolContracts.get_customer_function_call_status,
    async (input) =>
      invoke("get_customer_function_call_status", () => tools.getCustomerFunctionCallStatus(input))
  )
  server.registerTool(
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
  server.registerTool(
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
  server.registerTool(
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
  server.registerTool(
    "create_function_module_with_interface",
    toolContracts.create_function_module_with_interface,
    async (input) =>
      invokeWrite("create_function_module_with_interface", input, backend, writeReceipts, () =>
        tools.createFunctionModuleWithInterface(input)
      )
  )
  server.registerTool(
    "patch_function_module_interface",
    toolContracts.patch_function_module_interface,
    async (input) =>
      invokeWrite("patch_function_module_interface", input, backend, writeReceipts, () =>
        tools.patchFunctionModuleInterface(input)
      )
  )
  server.registerTool(
    "inspect_repository_assignment",
    toolContracts.inspect_repository_assignment,
    async (input) =>
      invoke("inspect_repository_assignment", () => tools.inspectRepositoryAssignment(input))
  )
  server.registerTool(
    "read_abap_message_class",
    toolContracts.read_abap_message_class,
    async (input) => invoke("read_abap_message_class", () => tools.readAbapMessageClass(input))
  )
  server.registerTool(
    "create_abap_message_class",
    toolContracts.create_abap_message_class,
    async (input) =>
      invokeWrite("create_abap_message_class", input, backend, writeReceipts, () =>
        tools.createAbapMessageClass(input)
      )
  )
  server.registerTool(
    "update_abap_message_class",
    toolContracts.update_abap_message_class,
    async (input) =>
      invokeWrite("update_abap_message_class", input, backend, writeReceipts, () =>
        tools.updateAbapMessageClass(input)
      )
  )
  server.registerTool(
    "delete_abap_message_class",
    toolContracts.delete_abap_message_class,
    async (input) =>
      invokeWrite("delete_abap_message_class", input, backend, writeReceipts, () =>
        tools.deleteAbapMessageClass(input)
      )
  )
  server.registerTool("read_ddic_domain", toolContracts.read_ddic_domain, async (input) =>
    invoke("read_ddic_domain", () => tools.readDdicDomain(input))
  )
  server.registerTool("upsert_ddic_domain", toolContracts.upsert_ddic_domain, async (input) =>
    invokeWrite("upsert_ddic_domain", input, backend, writeReceipts, () =>
      tools.upsertDdicDomain(input)
    )
  )
  server.registerTool(
    "read_ddic_data_element",
    toolContracts.read_ddic_data_element,
    async (input) => invoke("read_ddic_data_element", () => tools.readDdicDataElement(input))
  )
  server.registerTool(
    "upsert_ddic_data_element",
    toolContracts.upsert_ddic_data_element,
    async (input) =>
      invokeWrite("upsert_ddic_data_element", input, backend, writeReceipts, () =>
        tools.upsertDdicDataElement(input)
      )
  )
  server.registerTool("read_ddic_structure", toolContracts.read_ddic_structure, async (input) =>
    invoke("read_ddic_structure", () => tools.readDdicStructure(input))
  )
  server.registerTool("upsert_ddic_structure", toolContracts.upsert_ddic_structure, async (input) =>
    invokeWrite("upsert_ddic_structure", input, backend, writeReceipts, () =>
      tools.upsertDdicStructure(input)
    )
  )
  server.registerTool(
    "read_ddic_transparent_table",
    toolContracts.read_ddic_transparent_table,
    async (input) =>
      invoke("read_ddic_transparent_table", () => tools.readDdicTransparentTable(input))
  )
  server.registerTool(
    "create_ddic_transparent_table",
    toolContracts.create_ddic_transparent_table,
    async (input) =>
      invokeWrite("create_ddic_transparent_table", input, backend, writeReceipts, () =>
        tools.createDdicTransparentTable(input)
      )
  )
  server.registerTool(
    "append_ddic_transparent_table_fields",
    toolContracts.append_ddic_transparent_table_fields,
    async (input) =>
      invokeWrite("append_ddic_transparent_table_fields", input, backend, writeReceipts, () =>
        tools.appendDdicTransparentTableFields(input)
      )
  )
  server.registerTool(
    "patch_ddic_transparent_table_fields",
    toolContracts.patch_ddic_transparent_table_fields,
    async (input) =>
      invokeWrite("patch_ddic_transparent_table_fields", input, backend, writeReceipts, () =>
        tools.patchDdicTransparentTableFields(input)
      )
  )
  server.registerTool(
    "patch_ddic_transparent_table_settings",
    toolContracts.patch_ddic_transparent_table_settings,
    async (input) =>
      invokeWrite("patch_ddic_transparent_table_settings", input, backend, writeReceipts, () =>
        tools.patchDdicTransparentTableSettings(input)
      )
  )
  server.registerTool(
    "read_ddic_table_conversion_status",
    toolContracts.read_ddic_table_conversion_status,
    async (input) =>
      invoke("read_ddic_table_conversion_status", () => tools.readDdicTableConversionStatus(input))
  )
  server.registerTool(
    "recover_ddic_table_conversion",
    toolContracts.recover_ddic_table_conversion,
    async (input) =>
      invokeWrite("recover_ddic_table_conversion", input, backend, writeReceipts, () =>
        tools.recoverDdicTableConversion(input)
      )
  )
  server.registerTool("read_ddic_table_type", toolContracts.read_ddic_table_type, async (input) =>
    invoke("read_ddic_table_type", () => tools.readDdicTableType(input))
  )
  server.registerTool(
    "upsert_ddic_table_type",
    toolContracts.upsert_ddic_table_type,
    async (input) =>
      invokeWrite("upsert_ddic_table_type", input, backend, writeReceipts, () =>
        tools.upsertDdicTableType(input)
      )
  )
  server.registerTool("delete_ddic_object", toolContracts.delete_ddic_object, async (input) =>
    invokeWrite("delete_ddic_object", input, backend, writeReceipts, () =>
      tools.deleteDdicObject(input)
    )
  )
  server.registerTool("search_abap_objects", toolContracts.search_abap_objects, async (input) =>
    invoke("search_abap_objects", () => tools.searchObjects(input))
  )
  server.registerTool("get_abap_object_info", toolContracts.get_abap_object_info, async (input) =>
    invoke("get_abap_object_info", () => tools.getObjectInfo(input))
  )
  server.registerTool("get_abap_object_lines", toolContracts.get_abap_object_lines, async (input) =>
    invoke("get_abap_object_lines", () => tools.getObjectLines(input))
  )
  server.registerTool("get_batch_lines", toolContracts.get_batch_lines, async (input) =>
    invoke("get_batch_lines", () => tools.getBatchLines(input))
  )
  server.registerTool("get_object_by_uri", toolContracts.get_object_by_uri, async (input) =>
    invoke("get_object_by_uri", () => tools.getObjectByUri(input))
  )
  server.registerTool(
    "search_abap_object_lines",
    toolContracts.search_abap_object_lines,
    async (input) => invoke("search_abap_object_lines", () => tools.searchObjectLines(input))
  )
  server.registerTool(
    "get_abap_object_workspace_uri",
    toolContracts.get_abap_object_workspace_uri,
    async (input) => invoke("get_abap_object_workspace_uri", () => tools.getWorkspaceUri(input))
  )
  server.registerTool("get_abap_object_url", toolContracts.get_abap_object_url, async (input) =>
    invoke("get_abap_object_url", async () => tools.getObjectUrl(input))
  )
  server.registerTool("find_where_used", toolContracts.find_where_used, async (input) =>
    invoke("find_where_used", () => tools.findWhereUsed(input))
  )
  server.registerTool("analyze_change_impact", toolContracts.analyze_change_impact, async (input) =>
    invoke("analyze_change_impact", async () =>
      JSON.stringify(await collectChangeImpact(backend, input))
    )
  )
  server.registerTool("get_sap_system_info", toolContracts.get_sap_system_info, async (input) =>
    invoke("get_sap_system_info", () => tools.getSapSystemInfo(input))
  )
  server.registerTool("get_version_history", toolContracts.get_version_history, async (input) =>
    invoke("get_version_history", () => tools.getVersionHistory(input))
  )
  server.registerTool(
    "replace_string_in_abap_object",
    toolContracts.replace_string_in_abap_object,
    async (input) =>
      invokeWrite("replace_string_in_abap_object", input, backend, writeReceipts, () =>
        tools.replaceStringInObject(input)
      )
  )
  server.registerTool("abap_activate", toolContracts.abap_activate, async (input) =>
    invokeWrite("abap_activate", input, backend, writeReceipts, () => tools.activateObject(input))
  )
  server.registerTool(
    "create_object_programmatically",
    toolContracts.create_object_programmatically,
    async (input) =>
      invokeWrite("create_object_programmatically", input, backend, writeReceipts, () =>
        tools.createObject(input)
      )
  )
  server.registerTool(
    "delete_abap_source_object",
    toolContracts.delete_abap_source_object,
    async (input) =>
      invokeWrite("delete_abap_source_object", input, backend, writeReceipts, () =>
        tools.deleteSourceObject(input)
      )
  )
  server.registerTool("create_test_include", toolContracts.create_test_include, async (input) =>
    invokeWrite("create_test_include", input, backend, writeReceipts, () =>
      tools.createTestInclude(input)
    )
  )
  server.registerTool("manage_text_elements", toolContracts.manage_text_elements, async (input) =>
    input.action === "read"
      ? invoke("manage_text_elements", () => tools.manageTextElements(input))
      : invokeWrite("manage_text_elements", input, backend, writeReceipts, () =>
          tools.manageTextElements(input)
        )
  )
  server.registerTool("get_abap_diagnostics", toolContracts.get_abap_diagnostics, async (input) =>
    invoke("get_abap_diagnostics", () => tools.getDiagnostics(input))
  )
  server.registerTool("get_abap_sql_syntax", toolContracts.get_abap_sql_syntax, async () =>
    textResult(tools.getAbapSqlSyntax())
  )
  server.registerTool("execute_data_query", toolContracts.execute_data_query, async (input) =>
    invoke("execute_data_query", () => tools.executeDataQuery(input))
  )
  server.registerTool(
    "read_report_parameters",
    toolContracts.read_report_parameters,
    async (input) =>
      invoke("read_report_parameters", () => operationalLogs.readReportParameters(input))
  )
  server.registerTool("read_report_variants", toolContracts.read_report_variants, async (input) =>
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
  server.registerTool("read_abap_table", toolContracts.read_abap_table, async (input) =>
    invoke("read_abap_table", () => tools.readAbapTable(input))
  )
  server.registerTool("run_atc_analysis", toolContracts.run_atc_analysis, async (input) =>
    invoke("run_atc_analysis", () => tools.runAtcAnalysis(input))
  )
  server.registerTool("run_sci_analysis", toolContracts.run_sci_analysis, async (input) =>
    invoke("run_sci_analysis", () => tools.runSciAnalysis(input))
  )
  server.registerTool("run_unit_tests", toolContracts.run_unit_tests, async (input) =>
    invoke("run_unit_tests", () => tools.runUnitTests(input))
  )
  server.registerTool("preview_configuration", toolContracts.preview_configuration, async (input) =>
    invoke("preview_configuration", () => tools.previewConfiguration(input))
  )
  server.registerTool(
    "search_background_jobs",
    toolContracts.search_background_jobs,
    async (input) => invoke("search_background_jobs", () => operationalLogs.searchJobs(input))
  )
  server.registerTool(
    "read_background_job_details",
    toolContracts.read_background_job_details,
    async (input) =>
      invoke("read_background_job_details", () => operationalLogs.readJobDetails(input))
  )
  server.registerTool(
    "read_background_job_spool",
    toolContracts.read_background_job_spool,
    async (input) => invoke("read_background_job_spool", () => operationalLogs.readJobSpool(input))
  )
  server.registerTool(
    "read_background_job_log",
    toolContracts.read_background_job_log,
    async (input) => invoke("read_background_job_log", () => operationalLogs.readJobLog(input))
  )
  server.registerTool("read_system_logs", toolContracts.read_system_logs, async (input) =>
    invoke("read_system_logs", () => operationalLogs.readSystem(input))
  )
  server.registerTool("correlate_sap_logs", toolContracts.correlate_sap_logs, async (input) =>
    invoke("correlate_sap_logs", () => logCorrelation.correlate(input))
  )
  server.registerTool(
    "discover_application_logs",
    toolContracts.discover_application_logs,
    async (input) => invoke("discover_application_logs", () => applicationLogs.discover(input))
  )
  server.registerTool(
    "search_application_logs",
    toolContracts.search_application_logs,
    async (input) => invoke("search_application_logs", () => applicationLogs.search(input))
  )
  server.registerTool("read_application_log", toolContracts.read_application_log, async (input) =>
    invoke("read_application_log", () => applicationLogs.read(input))
  )
  server.registerTool("diagnose_sap_failure", toolContracts.diagnose_sap_failure, async (input) =>
    invoke("diagnose_sap_failure", async () =>
      tools.diagnoseSapFailure(
        input,
        input.operationId
          ? await writeReceipts.status(input.connectionId.toLowerCase(), input.operationId)
          : undefined
      )
    )
  )
  server.registerTool("analyze_abap_dumps", toolContracts.analyze_abap_dumps, async (input) =>
    invoke("analyze_abap_dumps", () => tools.analyzeDumps(input))
  )
  server.registerTool("analyze_abap_traces", toolContracts.analyze_abap_traces, async (input) =>
    invoke("analyze_abap_traces", () => tools.analyzeTraces(input))
  )
  server.registerTool(
    "manage_transport_requests",
    toolContracts.manage_transport_requests,
    async (input) => invoke("manage_transport_requests", () => tools.manageTransportRequests(input))
  )
  server.registerTool("abap_download", toolContracts.abap_download, async (input) =>
    invoke("abap_download", () => tools.downloadResource(input))
  )
  server.registerTool("adt_discovery_export", toolContracts.adt_discovery_export, async (input) =>
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

function writeOperationContext(
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
  const guard = input.expectedInterfaceFingerprint
    ? `interface fingerprint ${String(input.expectedInterfaceFingerprint)} and source fingerprint ${String(input.expectedSourceFingerprint)}`
    : input.expectedSourceFingerprint
      ? `active source fingerprint ${String(input.expectedSourceFingerprint)} and exact source match ${hashWriteInput(input.oldString)}`
      : input.expectedFingerprint
        ? `fingerprint ${String(input.expectedFingerprint)}`
        : input.expectedVersion
          ? `version ${String(input.expectedVersion)}`
          : input.oldString !== undefined
            ? `exact source match ${hashWriteInput(input.oldString)}`
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
  if (["create_smartform", "save_smartform", "activate_smartform"].includes(name)) {
    const form = String(input.formName).toUpperCase()
    return { key: `SSFO:${form}`, summary: `Smart Form ${form}` }
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
          upsert_ddic_table_type: "TTYP"
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
