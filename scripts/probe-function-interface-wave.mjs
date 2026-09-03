import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const endpoint = new URL(process.env.ABAP_MCP_ENDPOINT || "http://127.0.0.1:4847/mcp")
const connectionId = process.env.ABAP_MCP_CONNECTION || "w200"
const writeEnabled = process.env.ABAP_MCP_FUNCTION_WRITE === "1"
const functionGroup = process.env.ABAP_MCP_FUNCTION_GROUP || "ZCMCP_FG_1501"
const functionName = process.env.ABAP_MCP_FUNCTION_NAME || "ZCMCP_FM_1501"
const packageName = process.env.ABAP_MCP_PACKAGE || "ZABAP"
const transportNumber = process.env.ABAP_MCP_TRANSPORT || "GR2K923421"
const client = new Client({ name: "w200-function-interface-wave", version: "0.15.0" })

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

const createInput = {
  functionName,
  functionGroup,
  description: "MCP 0.15 RFC validation",
  remoteEnabled: true,
  importParameters: [{ name: "IV_INPUT", typeName: "CHAR20", passByValue: true }],
  exportParameters: [{ name: "EV_OUTPUT", typeName: "CHAR40", passByValue: true }],
  changingParameters: [],
  tableParameters: [],
  exceptions: [{ name: "INVALID_INPUT", description: "Input is invalid" }],
  source: [
    "  IF iv_input IS INITIAL.",
    "    RAISE invalid_input.",
    "  ENDIF.",
    "  CONCATENATE 'MCP:' iv_input INTO ev_output."
  ],
  packageName,
  transportNumber
}

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint))
  const standard = JSON.parse(
    await call("read_function_module_interface", { functionName: "RFC_READ_TABLE" })
  )
  if (!writeEnabled) {
    console.log(
      JSON.stringify({ endpoint: endpoint.href, connectionId, writeEnabled, standard }, null, 2)
    )
  } else {
    const group = await optionalCall("inspect_repository_assignment", {
      objectName: functionGroup,
      objectType: "FUGR/F"
    })
    const groupWrite = group
      ? "Existing function group retained"
      : await call("create_object_programmatically", {
          objectType: "FUGR/F",
          name: functionGroup,
          description: "MCP 0.15 function validation",
          packageName,
          additionalOptions: {
            transportRequest: { type: "existing", number: transportNumber }
          }
        })
    const existing = await optionalCall("read_function_module_interface", { functionName })
    const write = existing
      ? "Existing function module retained"
      : await call("create_function_module_with_interface", createInput)
    const verified = {
      functionModule: JSON.parse(await call("read_function_module_interface", { functionName })),
      functionAssignment: JSON.parse(
        await call("inspect_repository_assignment", {
          objectName: functionName,
          objectType: "FUGR/FF"
        })
      ),
      groupAssignment: JSON.parse(
        await call("inspect_repository_assignment", {
          objectName: functionGroup,
          objectType: "FUGR/F"
        })
      )
    }
    const rejected = {
      standardFunction: await call(
        "create_function_module_with_interface",
        { ...createInput, functionName: "RFC_READ_TABLE" },
        true
      ),
      standardGroup: await call(
        "create_function_module_with_interface",
        { ...createInput, functionName: "ZCMCP_FM_STD", functionGroup: "SDTX" },
        true
      ),
      missingTransport: await call(
        "create_function_module_with_interface",
        { ...createInput, functionName: "ZCMCP_FM_NOTR", transportNumber: "" },
        true
      ),
      duplicateParameter: await call(
        "create_function_module_with_interface",
        {
          ...createInput,
          functionName: "ZCMCP_FM_DUP",
          exportParameters: [{ name: "IV_INPUT", typeName: "CHAR40" }]
        },
        true
      ),
      invalidType: await call(
        "create_function_module_with_interface",
        {
          ...createInput,
          functionName: "ZCMCP_FM_TYPE",
          importParameters: [{ name: "IV_INPUT", typeName: "TYPE STRING" }]
        },
        true
      ),
      existingFunction: await call("create_function_module_with_interface", createInput, true)
    }
    console.log(
      JSON.stringify(
        {
          endpoint: endpoint.href,
          connectionId,
          writeEnabled,
          targets: { functionGroup, functionName, packageName, transportNumber },
          standard,
          writes: { groupWrite, write },
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
