import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const endpoint = new URL(process.env.ABAP_MCP_ENDPOINT || "http://127.0.0.1:4847/mcp")
const connectionId = process.env.ABAP_MCP_CONNECTION || "w200"
const functionName = "ZCMCP_FM_1801"
const functionGroup = "ZCMCP_FG_1501"
const client = new Client({ name: "w200-structured-rfc-validation", version: "0.18.0" })
const source = [
  "  DATA ls_item TYPE bapiret2.",
  "  IF is_request-message IS INITIAL.",
  "    RAISE invalid_input.",
  "  ENDIF.",
  "  es_response = is_request.",
  "  CONCATENATE 'MCP:' is_request-message INTO es_response-message.",
  "  LOOP AT ct_items INTO ls_item.",
  "    CONCATENATE 'ROW:' ls_item-message INTO ls_item-message.",
  "    MODIFY ct_items FROM ls_item INDEX sy-tabix.",
  "  ENDLOOP."
]

function expectedBapiRet2(type, message) {
  return {
    TYPE: type,
    ID: "",
    NUMBER: "000",
    MESSAGE: message,
    LOG_NO: "",
    LOG_MSG_NO: "000000",
    MESSAGE_V1: "",
    MESSAGE_V2: "",
    MESSAGE_V3: "",
    MESSAGE_V4: "",
    PARAMETER: "",
    ROW: "0",
    FIELD: "",
    SYSTEM: ""
  }
}

function output(result) {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

async function rawCall(name, args) {
  const result = await client.callTool({ name, arguments: { connectionId, ...args } })
  return { isError: result.isError === true, text: output(result) }
}

async function call(name, args) {
  const result = await rawCall(name, args)
  if (result.isError) throw new Error(`${name}: ${result.text}`)
  return result.text
}

function assertInterface(metadata) {
  const expected = {
    imports: [["IS_REQUEST", "BAPIRET2"]],
    exports: [["ES_RESPONSE", "BAPIRET2"]],
    tables: [["CT_ITEMS", "BAPIRET2"]],
    exceptions: ["INVALID_INPUT"]
  }
  const actual = {
    imports: metadata.importParameters.map(({ name, typeName }) => [name, typeName]),
    exports: metadata.exportParameters.map(({ name, typeName }) => [name, typeName]),
    tables: metadata.tableParameters.map(({ name, typeName }) => [name, typeName]),
    exceptions: metadata.exceptions.map(({ name }) => name)
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Existing ${functionName} interface is not the approved contract`)
  }
  if (metadata.changingParameters.length || !metadata.remoteEnabled || metadata.updateTask) {
    throw new Error(`Existing ${functionName} execution mode is not the approved contract`)
  }
  for (const line of source) {
    if (!metadata.source.includes(line))
      throw new Error(`Existing ${functionName} source differs: ${line}`)
  }
}

async function workspaceUri() {
  let lastError = ""
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await rawCall("get_abap_object_workspace_uri", {
      objectName: functionName,
      objectType: "FUGR/FF"
    })
    if (!result.isError) {
      const uri = result.text.match(/^Workspace URI: (adt:\/\/\S+)$/m)?.[1]
      if (uri) return uri
      lastError = result.text
    } else {
      lastError = result.text
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Could not resolve ${functionName} workspace URI: ${lastError}`)
}

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint))
  const ddic = JSON.parse(await call("read_ddic_structure", { objectName: "BAPIRET2" }))
  const ddicFields = new Set(ddic.definition.fields.map(({ name }) => name))
  if (!ddicFields.has("TYPE") || !ddicFields.has("MESSAGE")) {
    throw new Error("BAPIRET2 does not expose the required TYPE and MESSAGE fields")
  }
  const groupAssignment = JSON.parse(
    await call("inspect_repository_assignment", {
      objectName: functionGroup,
      objectType: "FUGR/F"
    })
  )
  if (groupAssignment.packageName !== "ZABAP" || groupAssignment.requestNumber !== "GR2K923421") {
    throw new Error(`${functionGroup} is not assigned to the approved package and request`)
  }

  let created = false
  const existing = await rawCall("read_function_module_interface", { functionName })
  if (existing.isError) {
    if (!/FUNCTION_NOT_FOUND|does not exist/i.test(existing.text)) {
      throw new Error(`Could not inspect ${functionName}: ${existing.text}`)
    }
    await call("create_function_module_with_interface", {
      functionName,
      functionGroup,
      description: "MCP 0.18 structured RFC validation",
      remoteEnabled: true,
      importParameters: [{ name: "IS_REQUEST", typeName: "BAPIRET2", passByValue: true }],
      exportParameters: [{ name: "ES_RESPONSE", typeName: "BAPIRET2", passByValue: true }],
      changingParameters: [],
      tableParameters: [{ name: "CT_ITEMS", typeName: "BAPIRET2" }],
      exceptions: [{ name: "INVALID_INPUT", description: "Input is invalid" }],
      source,
      packageName: "ZABAP",
      transportNumber: "GR2K923421"
    })
    created = true
  }

  const metadata = JSON.parse(
    await call("read_function_module_interface", {
      functionName,
      includeExecutionSupport: true
    })
  )
  assertInterface(metadata)
  if (!metadata.executionSupport?.supported) {
    throw new Error(`Structured execution is unsupported: ${metadata.executionSupport?.reasons}`)
  }

  const validCall = JSON.parse(
    await call("test_remote_function_module", {
      functionName,
      inputParameters: {},
      structureInputs: { IS_REQUEST: { TYPE: "S", MESSAGE: "VALIDATION" } },
      tableInputs: {
        CT_ITEMS: [
          { TYPE: "S", MESSAGE: "FIRST" },
          { TYPE: "W", MESSAGE: "SECOND" }
        ]
      },
      expectedStructureOutputs: {
        ES_RESPONSE: expectedBapiRet2("S", "MCP:VALIDATION")
      },
      expectedTableOutputs: {
        CT_ITEMS: [expectedBapiRet2("S", "ROW:FIRST"), expectedBapiRet2("W", "ROW:SECOND")]
      },
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true
    })
  )
  const invalidCall = JSON.parse(
    await call("test_remote_function_module", {
      functionName,
      inputParameters: {},
      structureInputs: { IS_REQUEST: { TYPE: "E", MESSAGE: "" } },
      tableInputs: { CT_ITEMS: [] },
      expectedException: "INVALID_INPUT",
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true
    })
  )

  const uri = await workspaceUri()
  const diagnostics = await call("get_abap_diagnostics", { fileUri: uri })
  const assignment = JSON.parse(
    await call("inspect_repository_assignment", {
      objectName: functionName,
      objectType: "FUGR/FF"
    })
  )
  console.log(
    JSON.stringify(
      {
        endpoint: endpoint.href,
        connectionId,
        functionName,
        created,
        status:
          validCall.status === "passed" && invalidCall.status === "passed" ? "passed" : "failed",
        interfaceFingerprint: metadata.fingerprint,
        executionSupport: metadata.executionSupport,
        validCall,
        invalidCall,
        workspaceUri: uri,
        diagnostics,
        assignment
      },
      null,
      2
    )
  )
} finally {
  await client.close()
}
