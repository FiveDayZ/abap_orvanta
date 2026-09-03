import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const endpoint = new URL(process.env.ABAP_MCP_ENDPOINT || "http://127.0.0.1:4847/mcp")
const connectionId = process.env.ABAP_MCP_CONNECTION || "w200"
const functionName = "ZCMCP_FM_1901"
const functionGroup = "ZCMCP_FG_1501"
const tableTypeName = "BAPIRET2_T"
const client = new Client({ name: "w200-controlled-rfc-validation", version: "0.19.0" })
const source = [
  "  IF it_items[] IS INITIAL.",
  "    RAISE invalid_input.",
  "  ENDIF.",
  "  et_items[] = it_items[]."
]

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

async function expectRejected(name, args, pattern) {
  const result = await rawCall(name, args)
  if (!result.isError || !pattern.test(result.text)) {
    throw new Error(`${name} did not reject the request as expected: ${result.text}`)
  }
  return result.text
}

function assertInterface(metadata) {
  const expected = {
    imports: [["IT_ITEMS", tableTypeName]],
    exports: [["ET_ITEMS", tableTypeName]],
    exceptions: ["INVALID_INPUT"]
  }
  const actual = {
    imports: metadata.importParameters.map(({ name, typeName }) => [name, typeName]),
    exports: metadata.exportParameters.map(({ name, typeName }) => [name, typeName]),
    exceptions: metadata.exceptions.map(({ name }) => name)
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Existing ${functionName} interface is not the approved contract`)
  }
  if (
    metadata.changingParameters.length ||
    metadata.tableParameters.length ||
    !metadata.remoteEnabled ||
    metadata.updateTask
  ) {
    throw new Error(`Existing ${functionName} execution mode is not the approved contract`)
  }
  for (const line of source) {
    if (!metadata.source.includes(line)) {
      throw new Error(`Existing ${functionName} source differs: ${line}`)
    }
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
  const tableType = JSON.parse(await call("read_ddic_table_type", { objectName: tableTypeName }))
  if (tableType.definition?.rowType !== "BAPIRET2") {
    throw new Error(`${tableTypeName} is not an active flat BAPIRET2 table type`)
  }
  const rowType = JSON.parse(await call("read_ddic_structure", { objectName: "BAPIRET2" }))
  const rowFields = new Set(rowType.definition.fields.map(({ name }) => name))
  if (!rowFields.has("TYPE") || !rowFields.has("MESSAGE")) {
    throw new Error("BAPIRET2 does not expose TYPE and MESSAGE")
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
      description: "MCP 0.19 allowlisted RFC validation",
      remoteEnabled: true,
      importParameters: [{ name: "IT_ITEMS", typeName: tableTypeName, passByValue: true }],
      exportParameters: [{ name: "ET_ITEMS", typeName: tableTypeName, passByValue: true }],
      changingParameters: [],
      tableParameters: [],
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
    throw new Error(`Table-type execution is unsupported: ${metadata.executionSupport?.reasons}`)
  }
  const shapes = metadata.executionSupport.parameters.map(({ name, direction, kind }) => ({
    name,
    direction,
    kind
  }))
  if (
    JSON.stringify(shapes) !==
    JSON.stringify([
      { name: "IT_ITEMS", direction: "import", kind: "table" },
      { name: "ET_ITEMS", direction: "export", kind: "table" }
    ])
  ) {
    throw new Error(`Unexpected execution shapes: ${JSON.stringify(shapes)}`)
  }

  const validCall = JSON.parse(
    await call("invoke_customer_function_module", {
      functionName,
      requestId: "w200-1901-valid",
      tableInputs: {
        IT_ITEMS: [
          { TYPE: "S", MESSAGE: "FIRST" },
          { TYPE: "W", MESSAGE: "SECOND" }
        ]
      },
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true
    })
  )
  if (
    validCall.status !== "completed" ||
    validCall.tableOutputs?.ET_ITEMS?.length !== 2 ||
    validCall.tableOutputs.ET_ITEMS[0]?.MESSAGE !== "FIRST" ||
    validCall.tableOutputs.ET_ITEMS[1]?.MESSAGE !== "SECOND" ||
    validCall.automaticRetry !== false
  ) {
    throw new Error(`Valid allowlisted invocation returned unexpected output`)
  }

  const invalidCall = JSON.parse(
    await call("invoke_customer_function_module", {
      functionName,
      requestId: "w200-1901-invalid",
      tableInputs: { IT_ITEMS: [] },
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true
    })
  )
  if (invalidCall.status !== "fault" || invalidCall.fault?.name !== "INVALID_INPUT") {
    throw new Error("Declared INVALID_INPUT exception was not returned as a structured fault")
  }

  const localGuards = {
    allowlist: await expectRejected(
      "invoke_customer_function_module",
      {
        functionName: "ZCMCP_FM_1801",
        requestId: "w200-1901-denied",
        tableInputs: {},
        expectedInterfaceFingerprint: "0".repeat(64),
        acknowledgePotentialSideEffects: true
      },
      /not listed in remoteFunctionAllowlist/
    ),
    fingerprint: await expectRejected(
      "invoke_customer_function_module",
      {
        functionName,
        requestId: "w200-1901-fingerprint",
        tableInputs: { IT_ITEMS: [{ TYPE: "S", MESSAGE: "FIRST" }] },
        expectedInterfaceFingerprint: "0".repeat(64),
        acknowledgePotentialSideEffects: true
      },
      /Function interface fingerprint changed/
    ),
    unknownField: await expectRejected(
      "invoke_customer_function_module",
      {
        functionName,
        requestId: "w200-1901-field",
        tableInputs: { IT_ITEMS: [{ UNKNOWN: "X" }] },
        expectedInterfaceFingerprint: metadata.fingerprint,
        acknowledgePotentialSideEffects: true
      },
      /Unknown field IT_ITEMS\.UNKNOWN/
    ),
    rowLimit: await expectRejected(
      "invoke_customer_function_module",
      {
        functionName,
        requestId: "w200-1901-rows",
        tableInputs: { IT_ITEMS: Array.from({ length: 201 }, () => ({})) },
        expectedInterfaceFingerprint: metadata.fingerprint,
        acknowledgePotentialSideEffects: true
      },
      /exceeds 200 rows/
    )
  }

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
        tableTypeName,
        created,
        status: "passed",
        interfaceFingerprint: metadata.fingerprint,
        executionSupport: metadata.executionSupport,
        validCall,
        invalidCall,
        localGuards: Object.fromEntries(
          Object.entries(localGuards).map(([name]) => [name, "passed"])
        ),
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
