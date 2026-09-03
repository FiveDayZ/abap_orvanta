import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const endpoint = new URL(process.env.ABAP_MCP_ENDPOINT || "http://127.0.0.1:4847/mcp")
const connectionId = process.env.ABAP_MCP_CONNECTION || "w200"
const writeEnabled = process.env.ABAP_MCP_REPORT_WRITE === "1"
const reportName = process.env.ABAP_MCP_REPORT_NAME || "ZCMCP_RPT_0831"
const messageClass = process.env.ABAP_MCP_MESSAGE_CLASS || "ZCMCP_MSG_0831"
const transactionCode = process.env.ABAP_MCP_REPORT_TRANSACTION || "ZCMCP_R14"
const packageName = process.env.ABAP_MCP_PACKAGE || "ZABAP"
const transportNumber = process.env.ABAP_MCP_TRANSPORT || "GR2K923421"
const client = new Client({ name: "w200-report-wave-probe", version: "0.14.0" })

function output(result) {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

async function call(name, args, expectError = false) {
  const result = await client.callTool({ name, arguments: { connectionId, ...args } })
  const text = output(result)
  if (expectError) {
    if (!result.isError) throw new Error(`${name} unexpectedly succeeded`)
    return text
  }
  if (result.isError) throw new Error(`${name}: ${text}`)
  return text
}

async function optionalCall(name, args) {
  try {
    return await call(name, args)
  } catch {
    return undefined
  }
}

async function capabilityCall(name, args) {
  try {
    return { status: "supported", output: await call(name, args) }
  } catch (error) {
    return {
      status: "unsupported",
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint))
  const readOnly = {
    standardProgramTexts: await call("manage_text_elements", {
      objectName: "SAPMSSY0",
      objectType: "PROGRAM",
      action: "read"
    }),
    standardMessageClass: await capabilityCall("read_abap_message_class", { messageClass: "00" })
  }

  if (!writeEnabled) {
    console.log(
      JSON.stringify({ endpoint: endpoint.href, connectionId, writeEnabled, readOnly }, null, 2)
    )
    process.exitCode = 0
  } else {
    const messageClassSupported = readOnly.standardMessageClass.status === "supported"
    const existingMessages = messageClassSupported
      ? await optionalCall("read_abap_message_class", { messageClass })
      : undefined
    const messageWrite = !messageClassSupported
      ? "Skipped: SAP does not expose the ADT message-class endpoint"
      : existingMessages
        ? "Existing message class retained"
        : await call("create_abap_message_class", {
            messageClass,
            description: "Codex MCP report messages",
            messages: [
              { number: "001", text: "Report &1 executed" },
              { number: "002", text: "Invalid selection: &1" }
            ],
            packageName,
            transportNumber
          })

    const existingTexts = await call("manage_text_elements", {
      objectName: reportName,
      objectType: "PROGRAM",
      action: "read"
    })
    const textAction = existingTexts.includes('R14: "Standalone report title"')
      ? "update"
      : "create"
    const textWrite = await call("manage_text_elements", {
      objectName: reportName,
      objectType: "PROGRAM",
      action: textAction,
      textElements: [{ id: "R14", text: "Standalone report title", maxLength: 40 }]
    })

    const existingTransaction = await optionalCall("read_transaction_code", { transactionCode })
    const transactionWrite = existingTransaction
      ? "Existing report transaction retained"
      : await call("create_report_transaction", {
          transactionCode,
          programName: reportName,
          description: "Codex MCP report verification",
          packageName,
          transportNumber
        })

    const verified = {
      messageClass: messageClassSupported
        ? JSON.parse(await call("read_abap_message_class", { messageClass }))
        : readOnly.standardMessageClass,
      textElements: await call("manage_text_elements", {
        objectName: reportName,
        objectType: "PROGRAM",
        action: "read"
      }),
      transaction: JSON.parse(await call("read_transaction_code", { transactionCode }))
    }
    const rejected = {
      standardMessageWrite: await call(
        "create_abap_message_class",
        {
          messageClass: "00",
          description: "Forbidden",
          messages: [{ number: "001", text: "Forbidden" }],
          packageName,
          transportNumber
        },
        true
      ),
      duplicateMessageNumber: await call(
        "create_abap_message_class",
        {
          messageClass: "ZCMCP_DUP_0831",
          description: "Duplicate",
          messages: [
            { number: "001", text: "First" },
            { number: "001", text: "Second" }
          ],
          packageName,
          transportNumber
        },
        true
      ),
      existingMessageClass: existingMessages
        ? await call(
            "create_abap_message_class",
            {
              messageClass,
              description: "Existing",
              messages: [{ number: "001", text: "Existing" }],
              packageName,
              transportNumber
            },
            true
          )
        : "Skipped: no verified existing message class",
      invalidVariant: await call(
        "create_report_transaction",
        {
          transactionCode: "ZCMCP_R14_BAD",
          programName: reportName,
          variant: "INVALID VARIANT",
          description: "Invalid variant",
          packageName,
          transportNumber
        },
        true
      )
    }
    console.log(
      JSON.stringify(
        {
          endpoint: endpoint.href,
          connectionId,
          writeEnabled,
          targets: { reportName, messageClass, transactionCode, packageName, transportNumber },
          readOnly,
          writes: { messageWrite, textWrite, transactionWrite },
          verified,
          rejected
        },
        null,
        2
      )
    )
  }
} finally {
  await client.close()
}
