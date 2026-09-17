import { randomUUID } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const endpoint = new URL(process.env.ABAP_MCP_ENDPOINT || "http://127.0.0.1:4847/mcp")
const connectionId = required("ABAP_MCP_CONNECTION").toLowerCase()
const packageName = required("ABAP_MCP_PACKAGE")
const transportNumber = required("ABAP_MCP_TRANSPORT")
const functionGroup = "ZCMCP_FG_0350"
const functionName = "ZCMCP_FM_0350"
const failureHandling = process.argv.includes("--failure-handling")
const dailyDevelopment = failureHandling || process.argv.includes("--daily-development")
const client = new Client({ name: "w200-function-interface-patch-validation", version: "0.35.0" })
const evidence = {
  productVersion: "0.35.0",
  phase: failureHandling ? "M3" : dailyDevelopment ? "M2" : "M1",
  endpoint: endpoint.href,
  connectionId,
  target: { functionGroup, functionName, packageName, transportNumber },
  status: "failed",
  cleanupComplete: false,
  businessDataWritten: false,
  transportCreated: false,
  transportReleased: false,
  steps: []
}
let functionGroupCreated = false
let functionModuleCreated = false
let functionGroupCreationAttempted = false
let functionModuleCreationAttempted = false
let observedPatchHelperVersion

if (process.env.ABAP_MCP_FUNCTION_PATCH_ACCEPTED !== "1") {
  throw new Error("ABAP_MCP_FUNCTION_PATCH_ACCEPTED=1 is required")
}

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value.toUpperCase()
}

function text(result) {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

async function callRaw(name, args) {
  const arguments_ = { connectionId, ...args }
  const startedAt = new Date().toISOString()
  try {
    const result = await client.callTool({ name, arguments: arguments_ })
    if (dailyDevelopment) {
      evidence.calls ??= []
      evidence.calls.push({ name, arguments: arguments_, startedAt, result })
    }
    return result
  } catch (error) {
    if (dailyDevelopment) {
      evidence.calls ??= []
      evidence.calls.push({ name, arguments: arguments_, startedAt, error: String(error) })
    }
    throw error
  }
}

async function call(name, args, expectError = false) {
  const result = await callRaw(name, args)
  const body = text(result)
  if (Boolean(result.isError) !== expectError) throw new Error(`${name}: ${body}`)
  return body
}

function parse(value) {
  return JSON.parse(value.split("\nOperation Receipt\n", 1)[0].trim())
}

function operationId(action) {
  return `f350-${action}-${randomUUID()}`
}

function fullSourceFingerprint(value) {
  const fingerprint = value.match(/^Full Source SHA-256: ([a-f0-9]{64})$/im)?.[1]
  if (!fingerprint) throw new Error(`Full source fingerprint missing: ${value}`)
  return fingerprint.toLowerCase()
}

async function sourceExists(objectName, objectType) {
  const result = await callRaw("search_abap_objects", {
    pattern: objectName,
    types: [objectType],
    maxResults: 5
  })
  const body = text(result)
  if (result.isError) throw new Error(`search_abap_objects: ${body}`)
  if (/^No ABAP objects found/im.test(body)) return false
  if (new RegExp(`\\b${objectName}\\b`, "i").test(body)) return true
  throw new Error(`Object existence could not be established: ${body}`)
}

async function readFunction() {
  return parse(
    await call("read_function_module_interface", {
      functionName,
      includeExecutionSupport: false
    })
  )
}

function assertReceipt(result, step) {
  if (result.operationReceipt?.status !== "completed") {
    throw new Error(`${step} did not return a completed operation receipt`)
  }
}

function assertPatchHelperVersion(result, step) {
  if (result.helperVersion !== "2.0") {
    throw new Error(
      `${step} requires repository helper 2.0; observed ${result.helperVersion || "none"}`
    )
  }
  observedPatchHelperVersion = result.helperVersion
}

function assertPreserved(result, previous, step) {
  if (
    result.functionGroup !== previous.functionGroup ||
    result.shortText !== previous.shortText ||
    result.remoteMode !== previous.remoteMode ||
    result.updateTaskMode !== previous.updateTaskMode ||
    result.globalInterface !== previous.globalInterface ||
    result.sourceFingerprint !== previous.sourceFingerprint
  ) {
    throw new Error(`${step} changed function attributes or implementation source`)
  }
  if (result.interfaceFingerprint === previous.interfaceFingerprint) {
    throw new Error(`${step} did not advance the interface fingerprint`)
  }
}

async function patch(previous, step, parameterOperations) {
  if (dailyDevelopment) {
    await call("get_object_by_uri", {
      uri: `/sap/bc/adt/functions/groups/${functionGroup.toLowerCase()}/fmodules/${functionName.toLowerCase()}/source/main`,
      startLine: 0,
      lineCount: 100
    })
  }
  const result = parse(
    await call("patch_function_module_interface", {
      operationId: operationId(step),
      functionName,
      functionGroup,
      expectedInterfaceFingerprint: previous.interfaceFingerprint,
      expectedSourceFingerprint: previous.sourceFingerprint,
      parameterOperations,
      exceptionOperations: [],
      packageName,
      transportNumber,
      ...(parameterOperations.some((item) => item.operation !== "add")
        ? { confirmation: "DESTRUCTIVE_INTERFACE_CHANGE" }
        : {})
    })
  )
  assertPatchHelperVersion(result, step)
  assertReceipt(result, step)
  assertPreserved(result, previous, step)
  const readback = await readFunction()
  if (
    readback.interfaceFingerprint !== result.interfaceFingerprint ||
    readback.sourceFingerprint !== previous.sourceFingerprint
  ) {
    throw new Error(`${step} readback does not match the completed patch`)
  }
  evidence.steps.push({
    step,
    beforeInterfaceFingerprint: previous.interfaceFingerprint,
    afterInterfaceFingerprint: readback.interfaceFingerprint,
    sourceFingerprint: readback.sourceFingerprint,
    receipt: result.operationReceipt
  })
  return readback
}

async function deleteSource(objectType, objectName, searchType, parentName) {
  const source = await call("get_abap_object_lines", {
    objectName,
    objectType: searchType,
    startLine: 1,
    lineCount: 5000
  })
  const deleted = parse(
    await call("delete_abap_source_object", {
      operationId: operationId(`cleanup-${searchType.toLowerCase()}`),
      objectType,
      objectName,
      ...(parentName ? { parentName } : {}),
      expectedFingerprint: fullSourceFingerprint(source),
      packageName,
      transportNumber,
      confirmation: "PERMANENT_DELETE"
    })
  )
  if (!deleted.absenceVerified || deleted.operationReceipt?.status !== "completed") {
    throw new Error(`${objectName} deletion was not verified`)
  }
  if (await sourceExists(objectName, searchType)) {
    throw new Error(`${objectName} still exists after deletion`)
  }
  return deleted.operationReceipt
}

async function cleanup() {
  const results = []
  if (functionModuleCreationAttempted) {
    try {
      if (functionModuleCreated || (await sourceExists(functionName, "FUNC"))) {
        const receipt = await deleteSource("FUGR/FF", functionName, "FUNC", functionGroup)
        functionModuleCreated = false
        results.push({ target: functionName, status: "deleted", receipt })
      }
    } catch (error) {
      results.push({ target: functionName, status: "failed", error: String(error) })
    }
  }
  if (functionGroupCreationAttempted) {
    try {
      if (functionGroupCreated || (await sourceExists(functionGroup, "FUGR"))) {
        const receipt = await deleteSource("FUGR/F", functionGroup, "FUGR")
        functionGroupCreated = false
        results.push({ target: functionGroup, status: "deleted", receipt })
      }
    } catch (error) {
      results.push({ target: functionGroup, status: "failed", error: String(error) })
    }
  }
  return results
}

async function validateDailyDevelopment(baseline) {
  const uriResult = await call("get_abap_object_workspace_uri", {
    objectName: functionName,
    objectType: "FUGR/FF"
  })
  const fileUri = uriResult.match(/^Workspace URI: (adt:\/\/\S+)$/m)?.[1]
  if (!fileUri) throw new Error(`Workspace URI missing: ${uriResult}`)
  const before = await readFunction()
  const oldString = [
    "  IF iv_input IS INITIAL.",
    "    RAISE invalid_input.",
    "  ENDIF.",
    "  ev_output = iv_input."
  ].join("\n")
  const newString = `${oldString}\n  TRANSLATE ev_output TO UPPER CASE.`
  const source = before.source.join("\n")
  if (source.split(oldString).length !== 2) {
    throw new Error("Approved implementation block must occur exactly once")
  }
  const modified = await call("replace_string_in_abap_object", {
    fileUri,
    oldString,
    newString,
    transportNumber,
    operationId: operationId("daily-source")
  })
  const receiptText = modified.split("\nOperation Receipt\n")[1]
  const receipt = receiptText ? JSON.parse(receiptText) : undefined
  assertReceipt({ operationReceipt: receipt }, "daily-source")
  if (!/Saved, unlocked, and activated/.test(modified)) {
    throw new Error("Source maintenance did not confirm activation")
  }
  const diagnostics = await call("get_abap_diagnostics", { fileUri })
  if (!/^No diagnostics found/.test(diagnostics)) {
    throw new Error(`Source diagnostics are not clean: ${diagnostics}`)
  }
  const after = await readFunction()
  if (
    after.source.join("\n") !== source.replace(oldString, newString) ||
    after.sourceFingerprint === before.sourceFingerprint ||
    after.interfaceFingerprint !== baseline.interfaceFingerprint
  ) {
    throw new Error("Active source or preserved interface differs from the intended edit")
  }
  const metadata = parse(
    await call("read_function_module_interface", { functionName, includeExecutionSupport: true })
  )
  if (!metadata.executionSupport?.supported) {
    throw new Error("The active function does not support execution")
  }
  const runs = []
  for (const scenario of [
    {
      name: "normal",
      inputParameters: { IV_INPUT: "m2-valid" },
      expectedOutputs: { EV_OUTPUT: "M2-VALID" }
    },
    {
      name: "boundary",
      inputParameters: { IV_INPUT: "abcdefghijklmnopqrst" },
      expectedOutputs: { EV_OUTPUT: "ABCDEFGHIJKLMNOPQRST" }
    },
    {
      name: "fault",
      inputParameters: { IV_INPUT: "" },
      expectedException: "INVALID_INPUT"
    }
  ]) {
    const { name, ...inputs } = scenario
    const id = operationId(`daily-${name}`)
    const result = parse(
      await call("test_remote_function_module", {
        functionName,
        ...inputs,
        expectedInterfaceFingerprint: metadata.fingerprint,
        acknowledgePotentialSideEffects: true,
        operationId: id
      })
    )
    assertReceipt(result, name)
    if (result.status !== "passed") throw new Error(`${name} assertion failed`)
    const persisted = parse(await call("get_write_operation_status", { operationId: id }))
    if (
      persisted.status !== "completed" ||
      persisted.resultHash !== result.operationReceipt.resultHash
    ) {
      throw new Error(`${name} persisted receipt differs from the invocation`)
    }
    runs.push({ name, result, persisted })
  }
  const invalid = await call(
    "test_remote_function_module",
    {
      functionName,
      inputParameters: { IV_INPUT: "x".repeat(21) },
      expectedOutputs: { EV_OUTPUT: "INVALID" },
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true,
      operationId: operationId("daily-overlength")
    },
    true
  )
  if (
    !/IV_INPUT.*(length|characters|exceed)|(?:length|characters|exceed).*IV_INPUT/i.test(invalid)
  ) {
    throw new Error(`Overlength input was not rejected for the expected reason: ${invalid}`)
  }
  if (failureHandling) {
    const rejectedReceipt = JSON.parse(invalid.split("\nOperation Receipt\n")[1])
    if (
      rejectedReceipt.sapInvocationStarted !== false ||
      rejectedReceipt.outcomeMayBeUnknown !== false
    ) {
      throw new Error("Rejected test input was incorrectly marked as invoked or unknown")
    }
    await validateFailureHandling(metadata)
  }
  const final = await readFunction()
  if (
    final.sourceFingerprint !== after.sourceFingerprint ||
    final.interfaceFingerprint !== after.interfaceFingerprint
  ) {
    throw new Error("RFC scenarios changed active source or interface")
  }
  evidence.dailyDevelopment = {
    status: "passed",
    fileUri,
    sourceReceipt: receipt,
    diagnostics,
    beforeSourceFingerprint: before.sourceFingerprint,
    afterSourceFingerprint: after.sourceFingerprint,
    interfaceFingerprint: after.interfaceFingerprint,
    runs,
    overlengthRejected: true,
    finalReadback: final
  }
}

async function validateFailureHandling(metadata) {
  const requestId = operationId("request")
  const args = {
    functionName,
    requestId,
    operationId: operationId("invoke"),
    inputParameters: { IV_INPUT: "m3-live" },
    expectedInterfaceFingerprint: metadata.fingerprint,
    acknowledgePotentialSideEffects: true
  }
  const completed = parse(await call("invoke_customer_function_module", args))
  if (completed.status !== "completed" || completed.outputs?.EV_OUTPUT !== "M3-LIVE") {
    throw new Error(`Unexpected customer RFC result: ${JSON.stringify(completed)}`)
  }
  assertReceipt(completed, "M3 invoke")
  const duplicateOperation = parse(await call("invoke_customer_function_module", args, true))
  if (duplicateOperation.status !== "duplicate_blocked")
    throw new Error("Operation replay was not blocked")
  const duplicateRequest = parse(
    await call("invoke_customer_function_module", {
      ...args,
      operationId: operationId("replay")
    })
  )
  if (
    duplicateRequest.status !== "duplicate_blocked" ||
    duplicateRequest.sapInvoked !== false ||
    duplicateRequest.operationReceipt?.sapInvocationStarted !== false
  ) {
    throw new Error("Request replay was not blocked before invocation")
  }
  const conflict = parse(
    await call("invoke_customer_function_module", {
      ...args,
      operationId: operationId("conflict"),
      inputParameters: { IV_INPUT: "changed" }
    })
  )
  if (conflict.status !== "request_id_conflict" || conflict.sapInvoked !== false) {
    throw new Error("Conflicting request was not blocked")
  }
  const invalidRequestId = operationId("invalid-request")
  const invalid = await call(
    "invoke_customer_function_module",
    {
      ...args,
      operationId: operationId("invalid"),
      requestId: invalidRequestId,
      inputParameters: { IV_INPUT: "x".repeat(21) }
    },
    true
  )
  const invalidReceipt = JSON.parse(invalid.split("\nOperation Receipt\n")[1])
  if (
    !/IV_INPUT exceeds 20 characters/.test(invalid) ||
    invalidReceipt.sapInvocationStarted !== false ||
    invalidReceipt.outcomeMayBeUnknown !== false
  ) {
    throw new Error("Invalid customer input was not rejected before dispatch")
  }
  const absentRequest = parse(
    await call("get_customer_function_call_status", { requestId: invalidRequestId })
  )
  if (absentRequest.status !== "not_found")
    throw new Error("Invalid input reserved an RFC invocation")
  const faultRequestId = operationId("fault-request")
  const fault = parse(
    await call("invoke_customer_function_module", {
      ...args,
      operationId: operationId("fault"),
      requestId: faultRequestId,
      inputParameters: { IV_INPUT: "" }
    })
  )
  if (fault.status !== "fault" || fault.fault?.name !== "INVALID_INPUT")
    throw new Error("Declared fault missing")
  const completedStatus = parse(await call("get_customer_function_call_status", { requestId }))
  const faultStatus = parse(
    await call("get_customer_function_call_status", { requestId: faultRequestId })
  )
  if (completedStatus.status !== "completed" || faultStatus.status !== "declared_fault") {
    throw new Error("Persistent RFC outcome differs from the actual response")
  }
  evidence.failureHandling = {
    status: "passed",
    completed,
    duplicateOperation,
    duplicateRequest,
    conflict,
    invalidReceipt,
    absentRequest,
    fault,
    completedStatus,
    faultStatus
  }
}

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint))
  if (dailyDevelopment) {
    await call("get_connected_systems", {})
    await call("get_abap_object_info", { objectName: "CHAR20", objectType: "DTEL" })
  }
  const capability = JSON.parse(await call("get_capability_report", {}))
  const repositoryHelper = capability.helpers?.find((helper) => helper.name === "repository")
  if (repositoryHelper?.availability !== "available") {
    throw new Error(
      `Repository helper must be reachable; observed ${repositoryHelper?.availability || "missing"}`
    )
  }
  const patchCapability = capability.capabilities?.find(
    (item) => item.id === "repository-helper-function-interface-patch"
  )
  if (!patchCapability || patchCapability.observation?.availability === "unsupported") {
    throw new Error("Function-interface patch capability is not registered")
  }
  evidence.preflight = {
    repositoryReadProtocol: repositoryHelper.protocolVersion,
    patchCapabilityAvailability: patchCapability.observation?.availability
  }
  if (await sourceExists(functionGroup, "FUGR")) {
    throw new Error(`${functionGroup} already exists; refusing to overwrite or delete it`)
  }
  if (await sourceExists(functionName, "FUNC")) {
    throw new Error(`${functionName} already exists; refusing to overwrite or delete it`)
  }

  functionGroupCreationAttempted = true
  await call("create_object_programmatically", {
    objectType: "FUGR/F",
    name: functionGroup,
    description: "MCP 0.35 interface patch",
    packageName,
    additionalOptions: {
      transportRequest: { type: "existing", number: transportNumber }
    },
    operationId: operationId("create-group")
  })
  functionGroupCreated = true

  functionModuleCreationAttempted = true
  const created = parse(
    await call("create_function_module_with_interface", {
      functionName,
      functionGroup,
      description: "MCP 0.35 interface patch",
      remoteEnabled: true,
      importParameters: [
        {
          name: "IV_INPUT",
          typeName: "CHAR20",
          passByValue: true,
          description: "Input value"
        }
      ],
      exportParameters: [
        {
          name: "EV_OUTPUT",
          typeName: "CHAR20",
          passByValue: true,
          description: "Output value"
        }
      ],
      changingParameters: [],
      tableParameters: [],
      exceptions: dailyDevelopment
        ? [{ name: "INVALID_INPUT", description: "Input is required" }]
        : [],
      source: dailyDevelopment
        ? [
            "  IF iv_input IS INITIAL.",
            "    RAISE invalid_input.",
            "  ENDIF.",
            "  ev_output = iv_input."
          ]
        : ["  ev_output = iv_input."],
      packageName,
      transportNumber,
      operationId: operationId("create-function")
    })
  )
  functionModuleCreated = true
  assertReceipt(created, "create")

  const assignment = parse(
    await call("inspect_repository_assignment", {
      objectName: functionName,
      objectType: "FUGR/FF"
    })
  )
  if (
    assignment.parentObject !== functionGroup ||
    assignment.packageName !== packageName ||
    ![assignment.requestNumber, assignment.taskNumber].includes(transportNumber)
  ) {
    throw new Error("Function module repository assignment does not match the approved scope")
  }

  const baseline = await readFunction()
  let current = await patch(baseline, "add", [
    {
      operation: "add",
      direction: "import",
      name: "IV_ADDED",
      typeName: "CHAR20",
      optional: true,
      passByValue: true,
      description: "Added value"
    }
  ])
  const added = current.importParameters.find((item) => item.name === "IV_ADDED")
  if (!added || !added.optional || !added.passByValue || added.description !== "Added value") {
    throw new Error("Added parameter attributes were not read back")
  }

  const stale = await call(
    "patch_function_module_interface",
    {
      operationId: operationId("stale"),
      functionName,
      functionGroup,
      expectedInterfaceFingerprint: baseline.interfaceFingerprint,
      expectedSourceFingerprint: baseline.sourceFingerprint,
      parameterOperations: [
        {
          operation: "rename",
          direction: "import",
          name: "IV_ADDED",
          newName: "IV_RENAMED"
        }
      ],
      exceptionOperations: [],
      packageName,
      transportNumber,
      confirmation: "DESTRUCTIVE_INTERFACE_CHANGE"
    },
    true
  )
  if (!/interface fingerprint changed/i.test(stale)) {
    throw new Error("Stale function-interface fingerprint was not rejected")
  }

  current = await patch(current, "rename", [
    {
      operation: "rename",
      direction: "import",
      name: "IV_ADDED",
      newName: "IV_RENAMED"
    }
  ])
  if (
    current.importParameters.some((item) => item.name === "IV_ADDED") ||
    !current.importParameters.some((item) => item.name === "IV_RENAMED")
  ) {
    throw new Error("Parameter rename readback is incorrect")
  }

  const referenceRejected = await call(
    "patch_function_module_interface",
    {
      operationId: operationId("reject-reference"),
      functionName,
      functionGroup,
      expectedInterfaceFingerprint: current.interfaceFingerprint,
      expectedSourceFingerprint: current.sourceFingerprint,
      parameterOperations: [
        { operation: "update", direction: "import", name: "IV_RENAMED", passByValue: false }
      ],
      exceptionOperations: [],
      packageName,
      transportNumber,
      confirmation: "DESTRUCTIVE_INTERFACE_CHANGE"
    },
    true
  )
  if (!/Reference parameters are not allowed with RFC/.test(referenceRejected)) {
    throw new Error("RFC reference parameter was not rejected")
  }
  const afterRejection = await readFunction()
  if (
    afterRejection.interfaceFingerprint !== current.interfaceFingerprint ||
    afterRejection.sourceFingerprint !== current.sourceFingerprint
  ) {
    throw new Error("Rejected RFC reference parameter changed the active function")
  }
  evidence.referenceParameterGuard = "passed"

  current = await patch(current, "update", [
    {
      operation: "update",
      direction: "import",
      name: "IV_RENAMED",
      typeName: "CHAR40",
      optional: false,
      passByValue: true,
      description: "Updated value"
    }
  ])
  const updated = current.importParameters.find((item) => item.name === "IV_RENAMED")
  if (
    !updated ||
    updated.typeName !== "CHAR40" ||
    updated.optional ||
    !updated.passByValue ||
    updated.description !== "Updated value"
  ) {
    throw new Error("Parameter attribute update readback is incorrect")
  }

  current = await patch(current, "remove", [
    { operation: "remove", direction: "import", name: "IV_RENAMED" }
  ])
  if (current.importParameters.some((item) => item.name === "IV_RENAMED")) {
    throw new Error("Removed parameter is still present")
  }
  if (
    current.interfaceFingerprint !== baseline.interfaceFingerprint ||
    current.sourceFingerprint !== baseline.sourceFingerprint
  ) {
    throw new Error("Final interface or implementation does not match the initial definition")
  }

  if (dailyDevelopment) await validateDailyDevelopment(baseline)
  evidence.status = "passed"
  evidence.helperVersion = observedPatchHelperVersion
  evidence.assignment = assignment
  evidence.baseline = {
    interfaceFingerprint: baseline.interfaceFingerprint,
    sourceFingerprint: baseline.sourceFingerprint
  }
  evidence.final = {
    interfaceFingerprint: current.interfaceFingerprint,
    sourceFingerprint: current.sourceFingerprint,
    importParameters: current.importParameters,
    exportParameters: current.exportParameters
  }
  evidence.staleGuard = "passed"
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  evidence.cleanup = await cleanup()
  evidence.cleanupComplete =
    !functionGroupCreated &&
    !functionModuleCreated &&
    evidence.cleanup.every((item) => item.status === "deleted")
  if (!evidence.cleanupComplete) {
    evidence.status = "failed"
    process.exitCode = 1
  }
  await client.close().catch(() => undefined)
  console.log(JSON.stringify(evidence, null, 2))
}
