import { randomUUID } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const endpoint = new URL(process.env.ABAP_MCP_ENDPOINT || "http://127.0.0.1:4847/mcp")
const connectionId = (process.env.ABAP_MCP_CONNECTION || "w200").toLowerCase()
const packageName = process.env.ABAP_MCP_PACKAGE || "ZABAP"
const transportNumber = process.env.ABAP_MCP_TRANSPORT || "GR2K923421"
const functionGroup = "ZCMCP_FG_0320"
const functionName = "ZCMCP_FM_0320"
const programName = "ZCMCP_PRG_0320"
const transactionCode = "ZCMCP_RPT_0320"
const messageClass = "ZCMCP_MSG_0320"
const client = new Client({ name: "w200-repository-lifecycle-validation", version: "0.32.0" })
const created = {
  functionGroup: false,
  functionModule: false,
  program: false,
  transaction: false,
  messageClass: false
}
const evidence = {
  productVersion: "0.32.0",
  endpoint: endpoint.href,
  connectionId,
  packageName,
  transportNumber,
  targets: { functionGroup, functionName, programName, transactionCode, messageClass },
  status: "failed",
  functionInterface: {},
  transaction: {},
  messageClass: {},
  cleanup: []
}

if (process.env.ABAP_MCP_REPOSITORY_LIFECYCLE_ACCEPTED !== "1") {
  throw new Error("ABAP_MCP_REPOSITORY_LIFECYCLE_ACCEPTED=1 is required")
}

function textOutput(result) {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

async function callRaw(name, args) {
  return client.callTool({ name, arguments: { connectionId, ...args } })
}

async function call(name, args) {
  const result = await callRaw(name, args)
  const text = textOutput(result)
  if (result.isError) throw new Error(`${name}: ${text}`)
  return text
}

function operationId(action) {
  const bounded = action.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 20)
  return `l320-${bounded}-${randomUUID()}`
}

function businessText(text) {
  return text.split("\nOperation Receipt\n", 1)[0].trim()
}

function parseJson(text) {
  return JSON.parse(businessText(text))
}

function fullSourceFingerprint(text) {
  const fingerprint = text.match(/^Full Source SHA-256: ([a-f0-9]{64})$/im)?.[1]
  if (!fingerprint) throw new Error(`Full source fingerprint missing: ${text}`)
  return fingerprint.toLowerCase()
}

async function sourceExists(objectName, objectType) {
  const result = await callRaw("search_abap_objects", {
    pattern: objectName,
    types: [objectType],
    maxResults: 5
  })
  const text = textOutput(result)
  if (result.isError) throw new Error(`search_abap_objects: ${text}`)
  if (/^No ABAP objects found/im.test(text)) return false
  return new RegExp(`\\b${objectName}\\b`, "i").test(text)
}

async function sourceFingerprint(objectName, objectType) {
  return fullSourceFingerprint(
    await call("get_abap_object_lines", {
      objectName,
      objectType,
      startLine: 1,
      lineCount: 5000
    })
  )
}

async function transactionDefinition() {
  return parseJson(await call("read_transaction_code", { transactionCode }))
}

async function messageDefinition() {
  return parseJson(await call("read_abap_message_class", { messageClass }))
}

async function requireTargetsAbsent() {
  for (const [name, type] of [
    [functionGroup, "FUGR"],
    [functionName, "FUNC"],
    [programName, "PROG"]
  ]) {
    if (await sourceExists(name, type))
      throw new Error(`${name} already exists; refusing to overwrite`)
  }
  const transaction = await callRaw("read_transaction_code", { transactionCode })
  if (!transaction.isError)
    throw new Error(`${transactionCode} already exists; refusing to overwrite`)
  const message = await callRaw("read_abap_message_class", { messageClass })
  if (!message.isError) throw new Error(`${messageClass} already exists; refusing to overwrite`)
}

async function validateFunctionInterfaceLifecycle() {
  const transportRequest = { type: "existing", number: transportNumber }
  await call("create_object_programmatically", {
    objectType: "FUGR/F",
    name: functionGroup,
    description: "MCP 0.32 function lifecycle",
    packageName,
    additionalOptions: { transportRequest },
    operationId: operationId("create-function-group")
  })
  created.functionGroup = true

  const createdFunction = parseJson(
    await call("create_function_module_with_interface", {
      functionName,
      functionGroup,
      description: "MCP 0.32 function interface",
      remoteEnabled: true,
      importParameters: [{ name: "IV_INPUT", typeName: "CHAR20", passByValue: true }],
      exportParameters: [{ name: "EV_OUTPUT", typeName: "CHAR20", passByValue: true }],
      changingParameters: [],
      tableParameters: [],
      exceptions: [{ name: "INVALID_INPUT", description: "Input is required" }],
      source: [
        "  IF iv_input IS INITIAL.",
        "    RAISE invalid_input.",
        "  ENDIF.",
        "  ev_output = iv_input."
      ],
      packageName,
      transportNumber,
      operationId: operationId("create-function-module")
    })
  )
  created.functionModule = true
  const current = parseJson(
    await call("read_function_module_interface", { functionName, includeExecutionSupport: true })
  )
  if (current.functionGroup !== functionGroup || current.remoteEnabled !== true) {
    throw new Error("Function interface readback did not preserve group or remote-enabled state")
  }
  if (current.importParameters?.[0]?.name !== "IV_INPUT") {
    throw new Error("Function interface import parameter was not read back")
  }
  if (current.exportParameters?.[0]?.name !== "EV_OUTPUT") {
    throw new Error("Function interface export parameter was not read back")
  }
  if (!current.exceptions?.some((item) => item.name === "INVALID_INPUT")) {
    throw new Error("Function interface exception was not read back")
  }
  if (!current.executionSupport?.supported || !/^[a-f0-9]{64}$/.test(current.fingerprint)) {
    throw new Error("Function interface execution contract or fingerprint is invalid")
  }
  const assignment = parseJson(
    await call("inspect_repository_assignment", {
      objectName: functionName,
      objectType: "FUGR/FF"
    })
  )
  if (assignment.parentObject !== functionGroup || assignment.packageName !== packageName) {
    throw new Error("Function module repository assignment does not match the approved target")
  }
  evidence.functionInterface = {
    createdFingerprint: createdFunction.fingerprint,
    readFingerprint: current.fingerprint,
    executionSupport: current.executionSupport,
    assignment
  }
}

async function validateTransactionLifecycle() {
  await call("create_object_programmatically", {
    objectType: "PROG/P",
    name: programName,
    description: "MCP 0.32 report transaction",
    packageName,
    additionalOptions: { transportRequest: { type: "existing", number: transportNumber } },
    operationId: operationId("create-report")
  })
  created.program = true
  await call("create_report_transaction", {
    transactionCode,
    programName,
    description: "MCP 0.32 report transaction",
    packageName,
    transportNumber,
    operationId: operationId("create-report-transaction")
  })
  created.transaction = true

  const current = await transactionDefinition()
  const row = current.transactions?.find((item) => item.TCODE === transactionCode)
  if (!row || row.PGMNA !== programName || current.packageName !== packageName) {
    throw new Error("Report transaction readback does not match program and package")
  }
  if (!/^[a-f0-9]{64}$/.test(current.fingerprint)) {
    throw new Error("Report transaction fingerprint is missing")
  }
  const stale = await callRaw("delete_transaction_code", {
    transactionCode,
    expectedProgramName: programName,
    expectedFingerprint: "f".repeat(64),
    packageName,
    transportNumber,
    operationId: operationId("reject-stale-transaction")
  })
  const staleText = textOutput(stale)
  if (!stale.isError || !/TRANSACTION_FINGERPRINT_CONFLICT/.test(staleText)) {
    throw new Error(`Stale transaction fingerprint was not rejected: ${staleText}`)
  }
  const deleted = await call("delete_transaction_code", {
    transactionCode,
    expectedProgramName: programName,
    expectedFingerprint: current.fingerprint,
    packageName,
    transportNumber,
    operationId: operationId("delete-report-transaction")
  })
  created.transaction = false
  const absent = await callRaw("read_transaction_code", { transactionCode })
  if (!absent.isError) throw new Error("Report transaction still exists after deletion")
  evidence.transaction = {
    definition: current,
    staleFingerprintRejected: true,
    deletion: businessText(deleted),
    absenceVerified: true
  }
}

async function validateMessageClassLifecycle() {
  const createdMessage = parseJson(
    await call("create_abap_message_class", {
      messageClass,
      description: "MCP 0.32 message lifecycle",
      messages: [
        { number: "001", text: "Before &1" },
        { number: "002", text: "Remove me" }
      ],
      packageName,
      transportNumber,
      operationId: operationId("create-message-class")
    })
  )
  created.messageClass = true
  await new Promise((resolve) => setTimeout(resolve, 1100))
  const updatedMessage = parseJson(
    await call("update_abap_message_class", {
      messageClass,
      expectedVersion: createdMessage.version,
      operations: [
        { operation: "update", number: "001", text: "After &1" },
        { operation: "remove", number: "002" },
        { operation: "add", number: "003", text: "Added &1" }
      ],
      packageName,
      transportNumber,
      operationId: operationId("update-message-class")
    })
  )
  const current = await messageDefinition()
  const expectedMessages = [
    { number: "001", text: "After &1" },
    { number: "003", text: "Added &1" }
  ]
  if (current.packageName !== packageName) throw new Error("Message class package mismatch")
  if (JSON.stringify(current.definition?.messages) !== JSON.stringify(expectedMessages)) {
    throw new Error("Message class incremental update readback mismatch")
  }
  if (current.version === createdMessage.version || current.version !== updatedMessage.version) {
    throw new Error("Message class version did not advance after update")
  }
  const stale = await callRaw("delete_abap_message_class", {
    messageClass,
    expectedVersion: createdMessage.version,
    packageName,
    transportNumber,
    confirmation: "PERMANENT_DELETE",
    operationId: operationId("reject-stale-message")
  })
  const staleText = textOutput(stale)
  if (!stale.isError || !/VERSION_CONFLICT/.test(staleText)) {
    throw new Error(`Stale message-class version was not rejected: ${staleText}`)
  }
  const deleted = parseJson(
    await call("delete_abap_message_class", {
      messageClass,
      expectedVersion: current.version,
      packageName,
      transportNumber,
      confirmation: "PERMANENT_DELETE",
      operationId: operationId("delete-message-class")
    })
  )
  created.messageClass = false
  const absent = await callRaw("read_abap_message_class", { messageClass })
  if (!absent.isError) throw new Error("Message class still exists after deletion")
  evidence.messageClass = {
    createdVersion: createdMessage.version,
    updatedVersion: current.version,
    definition: current.definition,
    staleVersionRejected: true,
    deletion: deleted,
    absenceVerified: true
  }
}

async function deleteSource(objectType, objectName, searchType, parentName) {
  const fingerprint = await sourceFingerprint(objectName, searchType)
  const deleted = parseJson(
    await call("delete_abap_source_object", {
      objectType,
      objectName,
      ...(parentName ? { parentName } : {}),
      expectedFingerprint: fingerprint,
      packageName,
      transportNumber,
      confirmation: "PERMANENT_DELETE",
      operationId: operationId(`cleanup-${objectName}`)
    })
  )
  if (!deleted.absenceVerified) throw new Error(`${objectName} deletion was not verified`)
  evidence.cleanup.push({ target: objectName, status: "deleted" })
}

async function cleanupResiduals() {
  if (created.messageClass) {
    try {
      const current = await messageDefinition()
      await call("delete_abap_message_class", {
        messageClass,
        expectedVersion: current.version,
        packageName,
        transportNumber,
        confirmation: "PERMANENT_DELETE",
        operationId: operationId("cleanup-message-class")
      })
      evidence.cleanup.push({ target: messageClass, status: "deleted" })
      created.messageClass = false
    } catch (error) {
      evidence.cleanup.push({ target: messageClass, status: "failed", error: String(error) })
    }
  }
  if (created.transaction) {
    try {
      const current = await transactionDefinition()
      await call("delete_transaction_code", {
        transactionCode,
        expectedProgramName: programName,
        expectedFingerprint: current.fingerprint,
        packageName,
        transportNumber,
        operationId: operationId("cleanup-transaction")
      })
      evidence.cleanup.push({ target: transactionCode, status: "deleted" })
      created.transaction = false
    } catch (error) {
      evidence.cleanup.push({ target: transactionCode, status: "failed", error: String(error) })
    }
  }
  for (const target of [
    {
      flag: "functionModule",
      objectType: "FUGR/FF",
      objectName: functionName,
      searchType: "FUNC",
      parentName: functionGroup
    },
    { flag: "program", objectType: "PROG/P", objectName: programName, searchType: "PROG" },
    { flag: "functionGroup", objectType: "FUGR/F", objectName: functionGroup, searchType: "FUGR" }
  ]) {
    if (!created[target.flag]) continue
    try {
      await deleteSource(target.objectType, target.objectName, target.searchType, target.parentName)
      created[target.flag] = false
    } catch (error) {
      evidence.cleanup.push({ target: target.objectName, status: "failed", error: String(error) })
    }
  }
}

let primaryError
try {
  await client.connect(new StreamableHTTPClientTransport(endpoint))
  await requireTargetsAbsent()
  await validateFunctionInterfaceLifecycle()
  await validateTransactionLifecycle()
  await validateMessageClassLifecycle()
  evidence.status = "passed"
} catch (error) {
  primaryError = error
  evidence.error = String(error)
} finally {
  await cleanupResiduals()
  evidence.cleanupComplete = evidence.cleanup.every((item) => item.status === "deleted")
  await client.close()
}

console.log(JSON.stringify(evidence, null, 2))
if (primaryError || !evidence.cleanupComplete) process.exitCode = 1
