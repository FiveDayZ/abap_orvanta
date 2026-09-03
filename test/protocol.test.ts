import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { startHttpServer } from "../src/http.js"
import { hashWriteInput, WriteOperationReceiptStore } from "../src/write-operation-receipts.js"
import { MockBackend } from "./mock-backend.js"

test("streamable HTTP exposes the implemented standalone tool waves", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "abap-mcp-protocol-state-"))
  const running = await startHttpServer(new MockBackend(), 0, stateRoot)
  const client = new Client({ name: "validation-client", version: "0.1.0" })
  try {
    const transport = new StreamableHTTPClientTransport(new URL(running.mcpUrl))
    await client.connect(transport as Parameters<Client["connect"]>[0])
    const list = await client.listTools()
    assert.deepEqual(list.tools.map((tool) => tool.name).sort(), [
      "abap_activate",
      "abap_debug_breakpoint",
      "abap_debug_session",
      "abap_debug_stack",
      "abap_debug_status",
      "abap_debug_step",
      "abap_debug_variable",
      "abap_download",
      "adt_discovery_export",
      "analyze_abap_dumps",
      "analyze_abap_traces",
      "create_abap_message_class",
      "create_ddic_transparent_table",
      "create_function_module_with_interface",
      "create_module_pool",
      "create_object_programmatically",
      "create_report_transaction",
      "create_test_include",
      "create_transaction_code",
      "delete_abap_source_object",
      "delete_ddic_object",
      "delete_module_pool",
      "delete_transaction_code",
      "execute_data_query",
      "find_where_used",
      "get_abap_diagnostics",
      "get_abap_object_info",
      "get_abap_object_lines",
      "get_abap_object_url",
      "get_abap_object_workspace_uri",
      "get_abap_sql_syntax",
      "get_batch_lines",
      "get_connected_systems",
      "get_customer_function_call_status",
      "get_object_by_uri",
      "get_sap_system_info",
      "get_version_history",
      "get_write_operation_status",
      "inspect_repository_assignment",
      "invoke_customer_function_module",
      "list_write_recovery_operations",
      "manage_text_elements",
      "manage_transport_requests",
      "patch_abap_gui_definition",
      "patch_abap_screen",
      "read_abap_gui_definition",
      "read_abap_message_class",
      "read_abap_screen",
      "read_ddic_data_element",
      "read_ddic_domain",
      "read_ddic_structure",
      "read_ddic_table_type",
      "read_ddic_transparent_table",
      "read_function_module_interface",
      "read_transaction_code",
      "release_write_operation_lock",
      "replace_string_in_abap_object",
      "run_atc_analysis",
      "run_unit_tests",
      "sap_helper_status",
      "search_abap_object_lines",
      "search_abap_objects",
      "test_remote_function_module",
      "update_abap_message_class",
      "upsert_abap_screen",
      "upsert_ddic_data_element",
      "upsert_ddic_domain",
      "upsert_ddic_structure",
      "upsert_ddic_table_type",
      "validate_dynpro_application"
    ])

    const screenRead = await client.callTool({
      name: "read_abap_screen",
      arguments: { programName: "ZMODULE_POOL", screenNumber: "0100", connectionId: "w200" }
    })
    assert.equal(screenRead.isError, undefined)
    const screenContent = screenRead.content as Array<{ type: string; text?: string }>
    const screen = JSON.parse(screenContent[0]?.text ?? "{}") as { fingerprint: string }
    assert.match(screen.fingerprint, /^[a-f0-9]{64}$/)

    const guiRead = await client.callTool({
      name: "read_abap_gui_definition",
      arguments: { programName: "ZMODULE_POOL", connectionId: "w200" }
    })
    assert.equal(guiRead.isError, undefined)
    const guiContent = guiRead.content as Array<{ type: string; text?: string }>
    const gui = JSON.parse(guiContent[0]?.text ?? "{}") as {
      fingerprint: string
      versionToken: string
    }
    assert.match(gui.fingerprint, /^[a-f0-9]{64}$/)

    const guiPatch = await client.callTool({
      name: "patch_abap_gui_definition",
      arguments: {
        programName: "ZMODULE_POOL",
        operationId: "protocol-gui-patch",
        expectedFingerprint: gui.fingerprint,
        transportNumber: "W20K900001",
        operations: [
          {
            section: "titles",
            operation: "add",
            key: { CODE: "TITLE_DETAIL" },
            definition: { TEXT: "Detail" }
          }
        ],
        connectionId: "w200"
      }
    })
    assert.equal(guiPatch.isError, undefined)
    const guiPatchContent = guiPatch.content as Array<{ type: string; text?: string }>
    assert.match(guiPatchContent[0]?.text ?? "", /"operationId": "protocol-gui-patch"/)
    const guiPatchResult = JSON.parse(guiPatchContent[0]?.text ?? "{}") as {
      operationReceipt?: { sapPreChangeEvidence?: Record<string, unknown> }
    }
    assert.deepEqual(guiPatchResult.operationReceipt?.sapPreChangeEvidence, {
      observedAt: guiPatchResult.operationReceipt?.sapPreChangeEvidence?.observedAt,
      target: "program ZMODULE_POOL",
      exists: true,
      active: true,
      version: gui.versionToken,
      fingerprint: gui.fingerprint,
      packageName: "ZABAP",
      requestNumber: "GR2K923421",
      taskNumber: "GR2K923422",
      observationStatus: "complete",
      sources: ["read_abap_gui_definition", "repository_assignment"],
      warnings: []
    })

    const duplicateGuiPatch = await client.callTool({
      name: "patch_abap_gui_definition",
      arguments: {
        programName: "ZMODULE_POOL",
        operationId: "protocol-gui-patch",
        expectedFingerprint: gui.fingerprint,
        transportNumber: "W20K900001",
        operations: [
          {
            section: "titles",
            operation: "add",
            key: { CODE: "TITLE_DETAIL" },
            definition: { TEXT: "Detail" }
          }
        ],
        connectionId: "w200"
      }
    })
    assert.equal(duplicateGuiPatch.isError, true)
    const duplicateContent = duplicateGuiPatch.content as Array<{ type: string; text?: string }>
    assert.match(duplicateContent[0]?.text ?? "", /"status": "duplicate_blocked"/)

    const writeStatus = await client.callTool({
      name: "get_write_operation_status",
      arguments: { operationId: "protocol-gui-patch", connectionId: "w200" }
    })
    assert.equal(writeStatus.isError, undefined)
    const writeStatusContent = writeStatus.content as Array<{ type: string; text?: string }>
    assert.match(writeStatusContent[0]?.text ?? "", /"status": "completed"/)
    assert.match(writeStatusContent[0]?.text ?? "", /"automaticRollback": false/)

    const seededStore = new WriteOperationReceiptStore(stateRoot, "seeded-old-instance")
    const seeded = await seededStore.reserve({
      connectionId: "w200",
      toolName: "patch_abap_screen",
      operationId: "protocol-interrupted-write",
      targetKey: "PROG:ZRECOVERY_CENTER",
      inputHash: hashWriteInput({ target: "ZRECOVERY_CENTER" }),
      preChangeSummary: '{"target":"program ZRECOVERY_CENTER"}',
      recoveryGuide: "Inspect program ZRECOVERY_CENTER in SAP before recovery."
    })
    assert.equal(seeded.status, "reserved")

    const recoveryList = await client.callTool({
      name: "list_write_recovery_operations",
      arguments: { connectionId: "w200", maxResults: 10 }
    })
    assert.equal(recoveryList.isError, undefined)
    const recoveryListContent = recoveryList.content as Array<{ type: string; text?: string }>
    const recovery = JSON.parse(recoveryListContent[0]?.text ?? "{}") as {
      operations: Array<{ receiptHash: string; recoveryState: string }>
    }
    assert.equal(recovery.operations.length, 1)
    assert.equal(recovery.operations[0]?.recoveryState, "interrupted")

    const rejectedRelease = await client.callTool({
      name: "release_write_operation_lock",
      arguments: {
        connectionId: "w200",
        operationId: "protocol-interrupted-write",
        expectedReceiptHash: recovery.operations[0]!.receiptHash,
        confirmation: "NOT_VERIFIED",
        reason: "Operator has not completed SAP verification"
      }
    })
    assert.equal(rejectedRelease.isError, true)

    const lockRelease = await client.callTool({
      name: "release_write_operation_lock",
      arguments: {
        connectionId: "w200",
        operationId: "protocol-interrupted-write",
        expectedReceiptHash: recovery.operations[0]!.receiptHash,
        confirmation: "SAP_STATE_VERIFIED",
        reason: "Operator verified the current SAP object and lock state"
      }
    })
    assert.equal(lockRelease.isError, undefined)
    const lockReleaseContent = lockRelease.content as Array<{ type: string; text?: string }>
    assert.match(lockReleaseContent[0]?.text ?? "", /"status": "local_lock_released"/)
    assert.match(lockReleaseContent[0]?.text ?? "", /"sapLockChanged": false/)
    assert.match(lockReleaseContent[0]?.text ?? "", /"recoveryActionSapInvocationStarted": false/)

    const screenPatch = await client.callTool({
      name: "patch_abap_screen",
      arguments: {
        programName: "ZMODULE_POOL",
        screenNumber: "0100",
        expectedFingerprint: screen.fingerprint,
        transportNumber: "W20K900001",
        componentOperations: [
          {
            operation: "add",
            name: "GV_PROTOCOL",
            definition: { TYPE: "CHECK", LINE: "6", COLUMN: "10", LENGTH: "1" }
          }
        ],
        connectionId: "w200"
      }
    })
    assert.equal(screenPatch.isError, undefined)

    const dynproValidation = await client.callTool({
      name: "validate_dynpro_application",
      arguments: { programName: "ZMODULE_POOL", screenNumber: "0100", connectionId: "w200" }
    })
    assert.equal(dynproValidation.isError, undefined)
    const validationContent = dynproValidation.content as Array<{ type: string; text?: string }>
    assert.match(validationContent[0]?.text ?? "", /"status": "valid_with_warnings"/)

    const baseline = JSON.parse(await readFile("contracts/source-baseline.json", "utf8")) as {
      tools: Array<{
        name: string
        inputSchema: { properties?: Record<string, unknown>; required?: string[] }
      }>
    }
    for (const expected of baseline.tools) {
      const actual = list.tools.find((tool) => tool.name === expected.name)
      assert.ok(actual, `missing tool ${expected.name}`)
      const actualProperties = Object.keys(actual.inputSchema.properties ?? {}).filter(
        (name) => name !== "operationId"
      )
      assert.deepEqual(
        actualProperties.sort(),
        Object.keys(expected.inputSchema.properties ?? {}).sort(),
        `${expected.name} property names changed`
      )
      assert.deepEqual(
        [...(actual.inputSchema.required ?? [])].sort(),
        [...(expected.inputSchema.required ?? [])].sort(),
        `${expected.name} required fields changed`
      )
    }

    const fullBaseline = JSON.parse(
      await readFile("contracts/full-tool-baseline.json", "utf8")
    ) as {
      tools: Array<{
        name: string
        inputSchema: { properties?: Record<string, unknown>; required?: string[] }
      }>
    }
    const migratedTools = new Set([
      "abap_activate",
      "abap_debug_breakpoint",
      "abap_debug_session",
      "abap_debug_stack",
      "abap_debug_status",
      "abap_debug_step",
      "abap_debug_variable",
      "abap_download",
      "adt_discovery_export",
      "analyze_abap_dumps",
      "analyze_abap_traces",
      "create_object_programmatically",
      "create_test_include",
      "execute_data_query",
      "get_abap_diagnostics",
      "get_abap_sql_syntax",
      "manage_text_elements",
      "manage_transport_requests",
      "run_atc_analysis",
      "run_unit_tests",
      "replace_string_in_abap_object"
    ])
    for (const expected of fullBaseline.tools.filter((tool) => migratedTools.has(tool.name))) {
      const actual = list.tools.find((tool) => tool.name === expected.name)
      assert.ok(actual, `missing migrated tool ${expected.name}`)
      const actualProperties = Object.keys(actual.inputSchema.properties ?? {}).filter(
        (name) => name !== "operationId"
      )
      assert.deepEqual(
        actualProperties.sort(),
        Object.keys(expected.inputSchema.properties ?? {}).sort(),
        `${expected.name} property names changed`
      )
      assert.deepEqual(
        [...(actual.inputSchema.required ?? [])].sort(),
        [...(expected.inputSchema.required ?? [])].sort(),
        `${expected.name} required fields changed`
      )
    }

    const result = await client.callTool({
      name: "get_connected_systems",
      arguments: {}
    })
    assert.equal(result.isError, undefined)
    assert.deepEqual(result.content, [{ type: "text", text: "Connected SAP systems: w200" }])

    const helper = await client.callTool({
      name: "sap_helper_status",
      arguments: { action: "ping", connectionId: "w200" }
    })
    assert.equal(helper.isError, undefined)
    const helperContent = helper.content as Array<{ type: string; text?: string }>
    assert.match(helperContent.find((part) => part.type === "text")?.text ?? "", /Code: READY/)

    const debugStatus = await client.callTool({
      name: "abap_debug_status",
      arguments: { connectionId: "w200" }
    })
    assert.equal(debugStatus.isError, undefined)
    const debugContent = debugStatus.content as Array<{ type: string; text?: string }>
    assert.match(debugContent[0]?.text ?? "", /"state": "idle"/)

    const remoteFunction = await client.callTool({
      name: "test_remote_function_module",
      arguments: {
        functionName: "ZCMCP_FM_1501",
        inputParameters: { IV_INPUT: "VALIDATION" },
        expectedOutputs: { EV_OUTPUT: "MCP:VALIDATION" },
        acknowledgePotentialSideEffects: true,
        connectionId: "w200"
      }
    })
    assert.equal(remoteFunction.isError, undefined)
    const remoteContent = remoteFunction.content as Array<{ type: string; text?: string }>
    assert.match(remoteContent[0]?.text ?? "", /"status": "passed"/)

    const tableTypeInterface = await client.callTool({
      name: "read_function_module_interface",
      arguments: {
        functionName: "ZCMCP_FM_1901",
        includeExecutionSupport: true,
        connectionId: "w200"
      }
    })
    assert.equal(tableTypeInterface.isError, undefined)
    const tableTypeContent = tableTypeInterface.content as Array<{ type: string; text?: string }>
    const tableTypeMetadata = JSON.parse(tableTypeContent[0]?.text ?? "{}") as {
      fingerprint: string
    }
    const invocation = await client.callTool({
      name: "invoke_customer_function_module",
      arguments: {
        functionName: "ZCMCP_FM_1901",
        requestId: "protocol-1901",
        tableInputs: { IT_ITEMS: [{ TYPE: "S", MESSAGE: "PROTOCOL" }] },
        expectedInterfaceFingerprint: tableTypeMetadata.fingerprint,
        acknowledgePotentialSideEffects: true,
        connectionId: "w200"
      }
    })
    assert.equal(invocation.isError, undefined)
    const invocationContent = invocation.content as Array<{ type: string; text?: string }>
    assert.match(invocationContent[0]?.text ?? "", /"status": "completed"/)

    const invocationStatus = await client.callTool({
      name: "get_customer_function_call_status",
      arguments: { requestId: "protocol-1901", connectionId: "w200" }
    })
    assert.equal(invocationStatus.isError, undefined)
    const statusContent = invocationStatus.content as Array<{ type: string; text?: string }>
    assert.match(statusContent[0]?.text ?? "", /"status": "completed"/)

    const invalid = await client.callTool({
      name: "get_abap_object_info",
      arguments: { objectName: "ZTEST" }
    })
    assert.equal(invalid.isError, true)
  } finally {
    await client.close()
    await running.close()
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("full source baseline freezes and classifies every original tool contract", async () => {
  const baseline = JSON.parse(await readFile("contracts/full-tool-baseline.json", "utf8")) as {
    sourceVersion: string
    sourceCommit: string
    toolCount: number
    tools: Array<{ name: string; classification?: unknown }>
  }
  assert.equal(baseline.sourceVersion, "2.7.0")
  assert.equal(baseline.sourceCommit, "0466e8ceea4e201335d74a7420ac894384f4a0e2")
  assert.equal(baseline.toolCount, 54)
  assert.equal(new Set(baseline.tools.map((tool) => tool.name)).size, 54)
  assert.ok(baseline.tools.every((tool) => tool.classification))
})

test("0.30 lifecycle writes return version 2 operation receipts", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "abap-mcp-lifecycle-receipts-"))
  const running = await startHttpServer(new MockBackend(), 0, stateRoot)
  const client = new Client({ name: "lifecycle-receipt-client", version: "0.1.0" })
  try {
    const transport = new StreamableHTTPClientTransport(new URL(running.mcpUrl))
    await client.connect(transport as Parameters<Client["connect"]>[0])

    const createdMessage = await client.callTool({
      name: "create_abap_message_class",
      arguments: {
        operationId: "protocol-create-message-0300",
        messageClass: "ZCMCP_MSG_0300",
        description: "Lifecycle receipt",
        messages: [{ number: "001", text: "Before" }],
        packageName: "ZABAP",
        transportNumber: "GR2K923421",
        connectionId: "w200"
      }
    })
    assert.equal(createdMessage.isError, undefined)

    const updatedMessage = await client.callTool({
      name: "update_abap_message_class",
      arguments: {
        operationId: "protocol-update-message-0300",
        messageClass: "ZCMCP_MSG_0300",
        expectedVersion: "20260831140000",
        operations: [{ operation: "update", number: "001", text: "After" }],
        packageName: "ZABAP",
        transportNumber: "GR2K923421",
        connectionId: "w200"
      }
    })
    assert.equal(updatedMessage.isError, undefined)

    const createdDomain = await client.callTool({
      name: "upsert_ddic_domain",
      arguments: {
        operationId: "protocol-create-domain-0300",
        objectName: "ZCMCP_DOM_0300",
        description: "Lifecycle receipt",
        dataType: "CHAR",
        length: 10,
        packageName: "ZABAP",
        transportNumber: "GR2K923421",
        connectionId: "w200"
      }
    })
    assert.equal(createdDomain.isError, undefined)
    const createdDomainBody = JSON.parse(
      (createdDomain.content as Array<{ type: string; text?: string }>)[0]?.text ?? "{}"
    ) as { version: string }

    const deletedDdic = await client.callTool({
      name: "delete_ddic_object",
      arguments: {
        operationId: "protocol-delete-domain-0300",
        objectType: "DOMA",
        objectName: "ZCMCP_DOM_0300",
        expectedVersion: createdDomainBody.version,
        packageName: "ZABAP",
        transportNumber: "GR2K923421",
        confirmation: "PERMANENT_DELETE",
        connectionId: "w200"
      }
    })
    assert.equal(deletedDdic.isError, undefined)

    const deletedSource = await client.callTool({
      name: "delete_abap_source_object",
      arguments: {
        operationId: "protocol-delete-source-0300",
        objectType: "CLAS/OC",
        objectName: "ZCL_DEMO",
        packageName: "ZVALIDATION",
        transportNumber: "GR2K923421",
        confirmation: "PERMANENT_DELETE",
        connectionId: "w200"
      }
    })
    assert.equal(deletedSource.isError, undefined)

    for (const result of [updatedMessage, deletedDdic, deletedSource]) {
      const body = JSON.parse(
        (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "{}"
      ) as {
        operationReceipt?: {
          version?: number
          status?: string
          sapInvocationStarted?: boolean
          sapPreChangeEvidence?: { exists?: boolean }
        }
      }
      assert.equal(body.operationReceipt?.version, 2)
      assert.equal(body.operationReceipt?.status, "completed")
      assert.equal(body.operationReceipt?.sapInvocationStarted, true)
      assert.equal(body.operationReceipt?.sapPreChangeEvidence?.exists, true)
    }
  } finally {
    await client.close()
    await running.close()
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("failed SAP pre-change observation prevents the write action", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "abap-mcp-observation-failure-"))
  const backend = new MockBackend()
  let writeInvoked = false
  backend.readSourceByUri = async () => {
    throw new Error("SAP readback unavailable")
  }
  const replaceSource = backend.replaceSource.bind(backend)
  backend.replaceSource = async (...args: Parameters<MockBackend["replaceSource"]>) => {
    writeInvoked = true
    return replaceSource(...args)
  }
  const running = await startHttpServer(backend, 0, stateRoot)
  const client = new Client({ name: "observation-failure-client", version: "0.1.0" })
  try {
    const transport = new StreamableHTTPClientTransport(new URL(running.mcpUrl))
    await client.connect(transport as Parameters<Client["connect"]>[0])
    const result = await client.callTool({
      name: "replace_string_in_abap_object",
      arguments: {
        fileUri: "adt://w200/sap/bc/adt/programs/programs/zmodule_pool/source/main",
        oldString: "PROGRAM zmodule_pool.",
        newString: "PROGRAM zmodule_pool.\n* blocked write",
        operationId: "observation-failure",
        transportNumber: "GR2K923421"
      }
    })
    assert.equal(result.isError, true)
    assert.equal(writeInvoked, false)
    const content = result.content as Array<{ type: string; text?: string }>
    assert.match(content[0]?.text ?? "", /SAP pre-change observation failed/)
    assert.match(content[0]?.text ?? "", /"sapInvocationStarted": false/)

    const status = await client.callTool({
      name: "get_write_operation_status",
      arguments: { operationId: "observation-failure", connectionId: "w200" }
    })
    assert.equal(status.isError, undefined)
    const statusContent = status.content as Array<{ type: string; text?: string }>
    assert.match(statusContent[0]?.text ?? "", /"status": "failed"/)
    assert.match(statusContent[0]?.text ?? "", /"sapInvocationStarted": false/)
  } finally {
    await client.close()
    await running.close()
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("health endpoint responds without an MCP session", async () => {
  const running = await startHttpServer(new MockBackend(), 0)
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/health`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      status: "ok",
      server: "abap-mcp-standalone"
    })
  } finally {
    await running.close()
  }
})
