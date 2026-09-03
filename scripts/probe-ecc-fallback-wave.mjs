import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const endpoint = new URL(process.env.ABAP_MCP_ENDPOINT || "http://127.0.0.1:4847/mcp")
const connectionId = process.env.ABAP_MCP_CONNECTION || "w200"
const packageName = "ZABAP"
const transportNumber = "GR2K923421"
const messageClass = "ZCMCP_MSG_0260"
const className = "ZCL_CMCP_0260"
const functionGroup = "ZCMCP_FG_0260"
const functionInclude = "F01"
const client = new Client({ name: "w200-ecc-fallback-wave", version: "0.26.0" })

function text(result) {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

async function call(name, args, expectError = false) {
  const result = await client.callTool({ name, arguments: { connectionId, ...args } })
  const output = text(result)
  if (expectError) {
    if (!result.isError) throw new Error(`${name} unexpectedly succeeded`)
    return output
  }
  if (result.isError) throw new Error(`${name}: ${output}`)
  return output
}

async function optionalCall(name, args) {
  try {
    return await call(name, args)
  } catch {
    return undefined
  }
}

async function ensureObject(objectType, name, description, parentName) {
  const existing = await optionalCall("get_abap_object_workspace_uri", {
    objectName: parentName ? `L${parentName}${name}` : name,
    objectType
  })
  if (existing) return `Existing object retained\n${existing}`
  return call("create_object_programmatically", {
    objectType,
    name,
    description,
    packageName,
    ...(parentName ? { parentName } : {}),
    additionalOptions: {
      transportRequest: { type: "existing", number: transportNumber }
    }
  })
}

async function upsertText(objectName, objectType, value) {
  const before = await call("manage_text_elements", { objectName, objectType, action: "read" })
  const action = /026:\s*"/i.test(before) ? "update" : "create"
  const write = await call("manage_text_elements", {
    objectName,
    objectType,
    action,
    textElements: [{ id: "026", text: value, maxLength: 40 }]
  })
  const after = await call("manage_text_elements", { objectName, objectType, action: "read" })
  if (!after.includes(`026: "${value}"`)) {
    throw new Error(`${objectType} text verification failed: ${after}`)
  }
  return { action, write, after }
}

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint))

  const standardMessageRead = await call("read_abap_message_class", { messageClass: "00" })
  const standardMessage = JSON.parse(standardMessageRead)
  const standardMessages = standardMessage.definition?.messages ?? []
  if (!standardMessages.length || !standardMessages[0]?.text?.includes("&1")) {
    throw new Error("Standard message entity decoding verification failed")
  }
  const classCreate = await ensureObject("CLAS/OC", className, "MCP 0.26 ECC fallback class")
  const functionGroupCreate = await ensureObject(
    "FUGR/F",
    functionGroup,
    "MCP 0.26 ECC fallback function group"
  )

  const existingMessage = await optionalCall("read_abap_message_class", { messageClass })
  const messageCreate = existingMessage
    ? "Existing message class retained"
    : await call("create_abap_message_class", {
        messageClass,
        description: "MCP 0.26 ECC fallback messages",
        messages: [{ number: "026", text: "ECC fallback &1" }],
        packageName,
        transportNumber
      })

  const classText = await upsertText(className, "CLASS", "MCP class fallback")
  const functionGroupText = await upsertText(
    functionGroup,
    "FUNCTION_GROUP",
    "MCP function group fallback"
  )
  const includeCreate = await ensureObject(
    "FUGR/I",
    functionInclude,
    "MCP 0.26 ECC fallback Include",
    functionGroup
  )
  const includeName = `L${functionGroup}${functionInclude}`
  const includeRead = await call("get_abap_object_lines", {
    objectName: includeName,
    objectType: "PROG",
    startLine: 1,
    lineCount: 20
  })
  const messageRead = await call("read_abap_message_class", { messageClass })
  const messageDefinition = JSON.parse(messageRead)
  const message026 = messageDefinition.definition?.messages?.find(
    (message) => message.number === "026"
  )
  if (message026?.text !== "ECC fallback &1") {
    throw new Error(
      `Customer message entity decoding verification failed: ${message026?.text ?? "missing"}`
    )
  }
  const transportDetails = await call("manage_transport_requests", {
    action: "get_transport_details",
    transportNumber
  })
  const transportObjects = await call("manage_transport_requests", {
    action: "get_transport_objects",
    transportNumber
  })
  if (/\n  -  -/.test(transportDetails)) {
    throw new Error("Transport details contain an empty task row")
  }
  const taskCount = Number.parseInt(transportDetails.match(/Tasks \((\d+)\):/)?.[1] ?? "0", 10)
  const objectCount = Number.parseInt(transportDetails.match(/Objects: (\d+)/)?.[1] ?? "0", 10)
  if (!transportDetails.includes("GR2K923422") || taskCount < 1) {
    throw new Error(`Transport task verification failed: ${transportDetails}`)
  }

  const rejected = {
    standardMessageClass: await call(
      "create_abap_message_class",
      {
        messageClass: "00",
        description: "Forbidden",
        messages: [{ number: "026", text: "Forbidden" }],
        packageName,
        transportNumber
      },
      true
    ),
    standardClassText: await call(
      "manage_text_elements",
      {
        objectName: "CL_ABAP_CHAR_UTILITIES",
        objectType: "CLASS",
        action: "create",
        textElements: [{ id: "026", text: "Forbidden", maxLength: 20 }]
      },
      true
    ),
    standardFunctionGroupInclude: await call(
      "create_object_programmatically",
      {
        objectType: "FUGR/I",
        name: "F01",
        parentName: "SYST",
        description: "Forbidden",
        packageName,
        additionalOptions: {
          transportRequest: { type: "existing", number: transportNumber }
        }
      },
      true
    )
  }

  console.log(
    JSON.stringify(
      {
        productVersion: "0.26.0",
        endpoint: endpoint.href,
        connectionId,
        targets: {
          messageClass,
          className,
          functionGroup,
          functionInclude: includeName,
          packageName,
          transportNumber
        },
        reads: {
          standardMessage: {
            messageClass: standardMessage.messageClass,
            packageName: standardMessage.packageName,
            messageCount: standardMessages.length,
            representativeMessage: standardMessages[0]
          },
          messageRead,
          includeRead,
          transport: {
            request: transportNumber,
            taskCount,
            objectCount,
            containsExpectedTask: true,
            details: transportDetails,
            objects: transportObjects
          }
        },
        writes: {
          classCreate,
          functionGroupCreate,
          messageCreate,
          classText,
          functionGroupText,
          includeCreate
        },
        rejected,
        transportReleased: false,
        status: "passed"
      },
      null,
      2
    )
  )
} finally {
  await client.close()
}
