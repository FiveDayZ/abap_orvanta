import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const [endpoint, stage = "first"] = process.argv.slice(2)
if (!endpoint || !["first", "restart"].includes(stage)) {
  throw new Error("Usage: node probe-rfc-receipt-validation.mjs <endpoint> <first|restart>")
}

const connectionId = "w200"
const functionName = "ZCMCP_FM_1901"
const validRequestId = "w200-2001-valid"
const faultRequestId = "w200-2001-fault"
const client = new Client({ name: "w200-rfc-receipt-validation", version: "0.20.0" })
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)))

async function call(name, args) {
  const result = await client.callTool({ name, arguments: { ...args, connectionId } })
  const text = result.content.find((part) => part.type === "text")?.text ?? ""
  if (result.isError) throw new Error(`${name}: ${text}`)
  return JSON.parse(text)
}

try {
  const metadata = await call("read_function_module_interface", {
    functionName,
    includeExecutionSupport: true
  })
  if (!metadata.executionSupport?.supported) {
    throw new Error(
      `Function execution is unsupported: ${JSON.stringify(metadata.executionSupport)}`
    )
  }

  if (stage === "first") {
    const input = { IT_ITEMS: [{ TYPE: "S", MESSAGE: "RECEIPT" }] }
    const validCall = await call("invoke_customer_function_module", {
      functionName,
      requestId: validRequestId,
      tableInputs: input,
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true
    })
    if (
      validCall.status !== "completed" ||
      validCall.tableOutputs?.ET_ITEMS?.[0]?.MESSAGE !== "RECEIPT" ||
      validCall.callReceipt?.persistentState !== "completed"
    ) {
      throw new Error(`Unexpected valid result: ${JSON.stringify(validCall)}`)
    }

    const duplicate = await call("invoke_customer_function_module", {
      functionName,
      requestId: validRequestId,
      tableInputs: input,
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true
    })
    if (duplicate.status !== "duplicate_blocked" || duplicate.sapInvoked !== false) {
      throw new Error(`Duplicate request was not blocked: ${JSON.stringify(duplicate)}`)
    }

    const conflict = await call("invoke_customer_function_module", {
      functionName,
      requestId: validRequestId,
      tableInputs: { IT_ITEMS: [{ TYPE: "S", MESSAGE: "CHANGED" }] },
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true
    })
    if (conflict.status !== "request_id_conflict" || conflict.sapInvoked !== false) {
      throw new Error(`Conflicting request was not blocked: ${JSON.stringify(conflict)}`)
    }

    const validStatus = await call("get_customer_function_call_status", {
      requestId: validRequestId
    })
    if (validStatus.status !== "completed") {
      throw new Error(`Completed receipt was not found: ${JSON.stringify(validStatus)}`)
    }

    const faultCall = await call("invoke_customer_function_module", {
      functionName,
      requestId: faultRequestId,
      tableInputs: { IT_ITEMS: [] },
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true
    })
    if (faultCall.status !== "fault" || faultCall.fault?.name !== "INVALID_INPUT") {
      throw new Error(`Declared fault was not returned: ${JSON.stringify(faultCall)}`)
    }
    const faultStatus = await call("get_customer_function_call_status", {
      requestId: faultRequestId
    })
    if (faultStatus.status !== "declared_fault") {
      throw new Error(`Declared fault receipt was not found: ${JSON.stringify(faultStatus)}`)
    }

    console.log(
      JSON.stringify({
        stage,
        connectionId,
        functionName,
        interfaceFingerprint: metadata.fingerprint,
        validCall,
        duplicate,
        conflict,
        validStatus,
        faultCall,
        faultStatus
      })
    )
  } else {
    const completedAfterRestart = await call("get_customer_function_call_status", {
      requestId: validRequestId
    })
    const duplicateAfterRestart = await call("invoke_customer_function_module", {
      functionName,
      requestId: validRequestId,
      tableInputs: { IT_ITEMS: [{ TYPE: "S", MESSAGE: "RECEIPT" }] },
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true
    })
    const faultAfterRestart = await call("get_customer_function_call_status", {
      requestId: faultRequestId
    })
    const missing = await call("get_customer_function_call_status", {
      requestId: "w200-2001-missing"
    })
    if (
      completedAfterRestart.status !== "completed" ||
      duplicateAfterRestart.status !== "duplicate_blocked" ||
      duplicateAfterRestart.sapInvoked !== false ||
      faultAfterRestart.status !== "declared_fault" ||
      missing.status !== "not_found"
    ) {
      throw new Error("Persistent receipt validation failed after restart")
    }
    console.log(
      JSON.stringify({
        stage,
        connectionId,
        functionName,
        interfaceFingerprint: metadata.fingerprint,
        completedAfterRestart,
        duplicateAfterRestart,
        faultAfterRestart,
        missing
      })
    )
  }
} finally {
  await client.close()
}
