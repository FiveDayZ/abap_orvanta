import { randomUUID } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { hashWriteInput, WriteOperationReceiptStore } from "../dist/src/write-operation-receipts.js"

const endpoint = new URL(process.env.ABAP_MCP_ENDPOINT || "http://127.0.0.1:4847/mcp")
const connectionId = (process.env.ABAP_MCP_CONNECTION || "w200").toLowerCase()
const programName = (process.env.ABAP_MCP_SAFETY_PROGRAM || "ZCMCP_SAFE_0271").toUpperCase()
const packageName = (process.env.ABAP_MCP_PACKAGE || "ZABAP").toUpperCase()
const transportNumber = (process.env.ABAP_MCP_TRANSPORT || "GR2K923421").toUpperCase()
const stateRoot = process.env.ABAP_MCP_STATE_DIR
const client = new Client({ name: "w200-write-safety-validation", version: "0.27.1" })

if (process.env.ABAP_MCP_WRITE_SAFETY_ACCEPTED !== "1") {
  throw new Error("ABAP_MCP_WRITE_SAFETY_ACCEPTED=1 is required")
}
if (!stateRoot) throw new Error("ABAP_MCP_STATE_DIR is required")
if (!/^[ZY][A-Z0-9_]*$/.test(programName)) throw new Error("programName must be Z* or Y*")
if (packageName === "$TMP") throw new Error("A transportable package is required")
if (!/^[A-Z0-9]{10}$/.test(transportNumber)) throw new Error("A valid transport number is required")

const source = [`PROGRAM ${programName.toLowerCase()}.`, "DATA gv_marker TYPE c LENGTH 20."]
const createInput = {
  programName,
  description: "MCP 0.27.1 write safety acceptance",
  packageName,
  transportNumber,
  source
}
const operationIds = {
  create: `safety-0271-create-${randomUUID()}`,
  failed: `safety-0271-failed-${randomUUID()}`,
  delete: `safety-0271-delete-${randomUUID()}`,
  interrupted: `safety-0271-interrupted-${randomUUID()}`,
  blocked: `safety-0271-blocked-${randomUUID()}`
}

function output(result) {
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
  const text = output(result)
  if (result.isError) throw new Error(`${name}: ${text}`)
  return text
}

function parseJson(text) {
  return JSON.parse(text)
}

function receiptFrom(text) {
  const marker = "Operation Receipt\n"
  const index = text.lastIndexOf(marker)
  if (index < 0) throw new Error(`Operation receipt missing: ${text}`)
  return parseJson(text.slice(index + marker.length))
}

function errorStatus(result) {
  const text = output(result)
  if (!result.isError) throw new Error(`Expected MCP error, received success: ${text}`)
  if (text.trimStart().startsWith("{")) return parseJson(text).status
  return receiptFrom(text).status
}

async function operationStatus(operationId) {
  return parseJson(await call("get_write_operation_status", { operationId }))
}

async function objectExists() {
  const result = await callRaw("get_abap_object_info", {
    objectName: programName,
    objectType: "PROG"
  })
  const text = output(result)
  const missing = /not found|could not find|does not exist/i.test(text)
  if (missing) return false
  if (!result.isError) return true
  throw new Error(`Could not determine whether ${programName} exists: ${text}`)
}

async function readAssignment() {
  return parseJson(
    await call("inspect_repository_assignment", {
      objectName: programName,
      objectType: "PROG/P"
    })
  )
}

async function readSource() {
  return call("get_abap_object_lines", {
    objectName: programName,
    objectType: "PROG",
    startLine: 1,
    lineCount: 20
  })
}

let createdByValidation = false
let primaryError
const evidence = {
  endpoint: endpoint.href,
  connectionId,
  target: { programName, packageName, transportNumber },
  status: "failed"
}

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint))
  const helperStatus = await call("sap_helper_status", { action: "ping" })
  if (
    !/\nStatus: S\r?\n/.test(`\n${helperStatus}\n`) ||
    !/\nCode: READY\r?\n/.test(`\n${helperStatus}\n`)
  ) {
    throw new Error(`SAP helper preflight is not ready: ${helperStatus}`)
  }
  evidence.preflight = { helperStatus }
  if (await objectExists()) {
    if (process.env.ABAP_MCP_SAFETY_RECOVER_RESIDUAL !== "1") {
      throw new Error(`${programName} already exists; refusing to overwrite or delete it`)
    }
    const residualAssignment = await readAssignment()
    const residualSource = await readSource()
    if (
      residualAssignment.packageName !== packageName ||
      residualAssignment.requestNumber !== transportNumber ||
      !residualSource.toUpperCase().includes(`PROGRAM ${programName}.`) ||
      !residualSource.includes("DATA gv_marker TYPE c LENGTH 20.")
    ) {
      throw new Error(`${programName} residual state does not match the approved validation object`)
    }
    const recoveryId = `s271-recover-${randomUUID()}`
    const recoveryText = await call("delete_module_pool", {
      programName,
      packageName,
      transportNumber,
      operationId: recoveryId
    })
    evidence.residualRecovery = {
      operationId: recoveryId,
      receipt: receiptFrom(recoveryText),
      helperAbsenceVerified: true
    }
  }

  const createText = await call("create_module_pool", {
    ...createInput,
    operationId: operationIds.create
  })
  const createReceipt = receiptFrom(createText)
  if (createReceipt.status !== "completed") throw new Error("Create receipt is not completed")
  createdByValidation = true

  const createStatus = await operationStatus(operationIds.create)
  if (createStatus.status !== "completed") throw new Error("Create status query is not completed")

  const duplicate = await callRaw("create_module_pool", {
    ...createInput,
    operationId: operationIds.create
  })
  if (errorStatus(duplicate) !== "duplicate_blocked") {
    throw new Error("Duplicate operation ID was not blocked")
  }

  const conflict = await callRaw("create_module_pool", {
    ...createInput,
    description: `${createInput.description} conflict`,
    operationId: operationIds.create
  })
  if (errorStatus(conflict) !== "operation_id_conflict") {
    throw new Error("Conflicting operation ID reuse was not blocked")
  }

  const failed = await callRaw("create_module_pool", {
    ...createInput,
    operationId: operationIds.failed
  })
  if (!failed.isError) throw new Error("Creating the existing module pool unexpectedly succeeded")
  const failedReceipt = receiptFrom(output(failed))
  const failedStatus = await operationStatus(operationIds.failed)
  if (failedReceipt.status !== "failed" || failedStatus.status !== "failed") {
    throw new Error("Failed SAP operation was not recorded as failed")
  }

  const assignment = await readAssignment()
  if (assignment.packageName !== packageName || assignment.requestNumber !== transportNumber) {
    throw new Error("SAP repository assignment does not match the approved package and transport")
  }

  const sourceReadback = await readSource()
  if (!sourceReadback.toUpperCase().includes(`PROGRAM ${programName}.`)) {
    throw new Error("SAP source readback does not contain the expected module-pool declaration")
  }

  const deleteText = await call("delete_module_pool", {
    programName,
    packageName,
    transportNumber,
    operationId: operationIds.delete
  })
  const deleteReceipt = receiptFrom(deleteText)
  const deleteStatus = await operationStatus(operationIds.delete)
  if (deleteReceipt.status !== "completed" || deleteStatus.status !== "completed") {
    throw new Error("Delete operation was not recorded as completed")
  }
  createdByValidation = false

  const interruptedStore = new WriteOperationReceiptStore(
    stateRoot,
    `terminated-validation-instance-${randomUUID()}`
  )
  const interruptedInput = { ...createInput, operationId: operationIds.interrupted }
  const interruption = await interruptedStore.reserve({
    connectionId,
    toolName: "create_module_pool",
    operationId: operationIds.interrupted,
    targetKey: `PROG:${programName}`,
    inputHash: hashWriteInput(interruptedInput),
    preChangeSummary: JSON.stringify({
      target: `program ${programName}`,
      requestedOperation: "create_module_pool",
      concurrencyGuard: "target must not already exist",
      transportNumber,
      automaticRollback: false
    }),
    recoveryGuide: `Read back program ${programName} from SAP before retrying.`
  })
  if (interruption.status !== "reserved") throw new Error("Could not seed interrupted receipt")

  const interruptedStatus = await operationStatus(operationIds.interrupted)
  if (interruptedStatus.status !== "interrupted") {
    throw new Error("Restarted service did not classify the seeded receipt as interrupted")
  }

  const blocked = await callRaw("create_module_pool", {
    ...createInput,
    operationId: operationIds.blocked
  })
  if (errorStatus(blocked) !== "target_concurrency_conflict") {
    throw new Error("Interrupted target lock did not block a new operation")
  }

  evidence.status = "passed"
  evidence.operations = {
    create: createStatus,
    duplicate: parseJson(output(duplicate)),
    conflict: parseJson(output(conflict)),
    failed: failedStatus,
    delete: deleteStatus,
    interrupted: interruptedStatus,
    blocked: parseJson(output(blocked))
  }
  evidence.sapReadback = {
    assignment,
    sourceVerified: true,
    cleanupVerifiedByHelper: true,
    independentCleanupVerificationRequired: true
  }
} catch (error) {
  primaryError = error
  evidence.error = error instanceof Error ? error.message : String(error)
} finally {
  if (createdByValidation) {
    try {
      const cleanupId = `s271-emergency-${randomUUID()}`
      const cleanup = await call("delete_module_pool", {
        programName,
        packageName,
        transportNumber,
        operationId: cleanupId
      })
      evidence.emergencyCleanup = {
        operationId: cleanupId,
        receipt: receiptFrom(cleanup),
        helperAbsenceVerified: true
      }
      createdByValidation = false
    } catch (cleanupError) {
      evidence.emergencyCleanup = {
        status: "failed",
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      }
    }
  }
  await client.close()
}

console.log(JSON.stringify(evidence, null, 2))
if (primaryError || createdByValidation || evidence.emergencyCleanup?.status === "failed") {
  process.exitCode = 1
}
