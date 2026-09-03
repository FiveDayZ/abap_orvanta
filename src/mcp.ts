import { randomUUID } from "node:crypto"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { SapBackend } from "./backend.js"
import { toolContracts } from "./contracts.js"
import type { InvocationReceiptStore } from "./invocation-receipts.js"
import { ToolService } from "./tools.js"
import { hashWriteInput, type WriteOperationReceiptStore } from "./write-operation-receipts.js"

export function createMcpServer(
  backend: SapBackend,
  invocationReceipts: InvocationReceiptStore,
  writeReceipts: WriteOperationReceiptStore
): McpServer {
  const server = new McpServer({
    name: "abap-mcp-standalone",
    version: "0.27.1"
  })
  const tools = new ToolService(backend, undefined, invocationReceipts)

  server.registerTool("get_connected_systems", toolContracts.get_connected_systems, async () =>
    textResult(tools.getConnectedSystems())
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
      invokeWrite("test_remote_function_module", input, backend, writeReceipts, () =>
        tools.testRemoteFunctionModule(input)
      )
  )
  server.registerTool(
    "invoke_customer_function_module",
    toolContracts.invoke_customer_function_module,
    async (input) =>
      invokeWrite("invoke_customer_function_module", input, backend, writeReceipts, () =>
        tools.invokeCustomerFunctionModule(input)
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
    "create_function_module_with_interface",
    toolContracts.create_function_module_with_interface,
    async (input) =>
      invokeWrite("create_function_module_with_interface", input, backend, writeReceipts, () =>
        tools.createFunctionModuleWithInterface(input)
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
  server.registerTool("run_atc_analysis", toolContracts.run_atc_analysis, async (input) =>
    invoke("run_atc_analysis", () => tools.runAtcAnalysis(input))
  )
  server.registerTool("run_unit_tests", toolContracts.run_unit_tests, async (input) =>
    invoke("run_unit_tests", () => tools.runUnitTests(input))
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

async function invoke(name: string, action: () => Promise<string>) {
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

async function invokeWrite<T extends object>(
  name: string,
  input: T,
  backend: SapBackend,
  receipts: WriteOperationReceiptStore,
  action: () => Promise<string>
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
  let result: string
  try {
    result = await action()
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
  const guard = input.expectedFingerprint
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
  if (
    name === "create_transaction_code" ||
    name === "delete_transaction_code" ||
    name === "create_report_transaction"
  ) {
    const transaction = String(input.transactionCode).toUpperCase()
    return { key: `TRAN:${transaction}`, summary: `transaction ${transaction}` }
  }
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
