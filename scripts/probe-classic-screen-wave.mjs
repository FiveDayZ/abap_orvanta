import { access, writeFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const endpoint = new URL(process.env.ABAP_MCP_ENDPOINT || "http://127.0.0.1:4847/mcp")
const connectionId = process.env.ABAP_MCP_CONNECTION || "w200"
const programName = (process.env.ABAP_MCP_CLASSIC_PROGRAM || "ZCMCP_DYN_0250").toUpperCase()
const screenNumber = process.env.ABAP_MCP_CLASSIC_SCREEN || "0100"
const transactionCode = (process.env.ABAP_MCP_CLASSIC_TRANSACTION || "ZCMCP_0250").toUpperCase()
const packageName = (process.env.ABAP_MCP_PACKAGE || "ZABAP").toUpperCase()
const transportNumber = (process.env.ABAP_MCP_TRANSPORT || "GR2K923421").toUpperCase()
const readyPath = process.env.ABAP_MCP_CLASSIC_READY_PATH
const cleanupSignalPath = process.env.ABAP_MCP_CLASSIC_CLEANUP_SIGNAL
const client = new Client({ name: "w200-classic-screen-wave", version: "0.25.0" })

if (process.env.ABAP_MCP_CLASSIC_SCREEN_WRITE !== "1") {
  throw new Error("ABAP_MCP_CLASSIC_SCREEN_WRITE=1 is required")
}
if (!readyPath || !cleanupSignalPath) {
  throw new Error("Ready and cleanup signal paths are required")
}

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

async function recover(name, args, absentCodes) {
  const result = await client.callTool({ name, arguments: { connectionId, ...args } })
  const text = output(result)
  if (!result.isError) return text
  if (absentCodes.some((code) => text.includes(code))) return `No residual object: ${text}`
  throw new Error(`${name}: ${text}`)
}

async function waitForCleanupSignal() {
  for (let attempt = 0; attempt < 5_400; attempt += 1) {
    try {
      await access(cleanupSignalPath)
      return
    } catch (error) {
      if (error?.code === "ENOENT") {
        await delay(1_000)
        continue
      }
      throw error
    }
  }
  throw new Error("Timed out waiting for the classic-screen cleanup signal")
}

const source = [
  `PROGRAM ${programName.toLowerCase()}.`,
  "DATA gv_input TYPE c LENGTH 30.",
  "DATA gv_message TYPE c LENGTH 60.",
  "DATA gv_counter TYPE i.",
  "DATA gv_counter_text TYPE c LENGTH 10.",
  "MODULE status_0100 OUTPUT.",
  "  SET PF-STATUS 'STATUS_025'.",
  "  SET TITLEBAR 'TITLE_025'.",
  "ENDMODULE.",
  "MODULE exit_command_0100 INPUT.",
  "  CASE sy-ucomm.",
  "    WHEN 'BACK' OR 'EXIT' OR 'CANC'.",
  "      LEAVE PROGRAM.",
  "  ENDCASE.",
  "ENDMODULE.",
  "MODULE user_command_0100 INPUT.",
  "  CASE sy-ucomm.",
  "    WHEN 'HELLO'.",
  "      ADD 1 TO gv_counter.",
  "      WRITE gv_counter TO gv_counter_text.",
  "      CONDENSE gv_counter_text NO-GAPS.",
  "      CONCATENATE 'HELLO' gv_input gv_counter_text",
  "        INTO gv_message SEPARATED BY ':'.",
  "    WHEN 'CLEAR'.",
  "      CLEAR: gv_input, gv_message.",
  "  ENDCASE.",
  "  CLEAR sy-ucomm.",
  "ENDMODULE."
]

const fields = [
  { NAME: "LBL_INPUT", TYPE: "TEXT", TEXT: "Input", LINE: "3", COLUMN: "2", LENGTH: "10" },
  {
    NAME: "GV_INPUT",
    TYPE: "TEMPLATE",
    FORMAT: "CHAR",
    TEXT: "______________________________",
    LINE: "3",
    COLUMN: "14",
    LENGTH: "30"
  },
  {
    NAME: "LBL_MESSAGE",
    TYPE: "TEXT",
    TEXT: "Message",
    LINE: "5",
    COLUMN: "2",
    LENGTH: "10"
  },
  {
    NAME: "GV_MESSAGE",
    TYPE: "TEMPLATE",
    FORMAT: "CHAR",
    TEXT: "____________________________________________________________",
    LINE: "5",
    COLUMN: "14",
    LENGTH: "60"
  },
  {
    NAME: "BTN_HELLO",
    TYPE: "PUSH",
    TEXT: "Hello",
    LINE: "8",
    COLUMN: "2",
    LENGTH: "12",
    PUSH_FCODE: "HELLO"
  },
  {
    NAME: "BTN_CLEAR",
    TYPE: "PUSH",
    TEXT: "Clear",
    LINE: "8",
    COLUMN: "16",
    LENGTH: "12",
    PUSH_FCODE: "CLEAR"
  },
  {
    NAME: "BTN_BACK",
    TYPE: "PUSH",
    TEXT: "Back",
    LINE: "8",
    COLUMN: "30",
    LENGTH: "12",
    PUSH_FCODE: "BACK"
  },
  {
    NAME: "BTN_EXIT",
    TYPE: "PUSH",
    TEXT: "Exit",
    LINE: "8",
    COLUMN: "44",
    LENGTH: "12",
    PUSH_FCODE: "EXIT"
  },
  {
    NAME: "BTN_CANC",
    TYPE: "PUSH",
    TEXT: "Cancel",
    LINE: "8",
    COLUMN: "58",
    LENGTH: "12",
    PUSH_FCODE: "CANC"
  }
]

const functionRows = [
  { code: "HELLO", text: "Hello", type: "" },
  { code: "CLEAR", text: "Clear", type: "" },
  { code: "BACK", text: "Back", type: "E" },
  { code: "EXIT", text: "Exit", type: "E" },
  { code: "CANC", text: "Cancel", type: "E" }
]

let transactionCreated = false
let programCreated = false
let primaryFailure
let cleanupFailure
const evidence = {
  productVersion: "0.25.0",
  endpoint: endpoint.href,
  connectionId,
  targets: { programName, screenNumber, transactionCode, packageName, transportNumber },
  preparation: {},
  cleanup: {}
}

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint))
  evidence.preparation.recoveredTransaction = await recover(
    "delete_transaction_code",
    {
      transactionCode,
      expectedProgramName: programName,
      packageName,
      transportNumber
    },
    ["TRANSACTION_READ_FAILED", "TRANSACTION_ASSIGNMENT_MISMATCH"]
  )
  evidence.preparation.recoveredModulePool = await recover(
    "delete_module_pool",
    {
      programName,
      packageName,
      transportNumber
    },
    ["MODULE_POOL_ASSIGNMENT_MISMATCH"]
  )

  evidence.preparation.modulePool = await call("create_module_pool", {
    programName,
    description: "MCP 0.25 classic screen validation",
    packageName,
    transportNumber,
    source
  })
  programCreated = true

  evidence.preparation.screen = await call("upsert_abap_screen", {
    programName,
    screenNumber,
    description: "MCP 0.25 classic interaction",
    transportNumber,
    header: { NOLI: "16", NOCO: "90" },
    fields,
    flowLogic: [
      "PROCESS BEFORE OUTPUT.",
      "  MODULE status_0100.",
      "PROCESS AFTER INPUT.",
      "  MODULE exit_command_0100 AT EXIT-COMMAND.",
      "  MODULE user_command_0100."
    ]
  })

  const baselineGui = JSON.parse(await call("read_abap_gui_definition", { programName }))
  const operations = [
    {
      section: "statuses",
      operation: "add",
      key: { CODE: "STATUS_025" },
      definition: {
        MODAL: "P",
        ACTCODE: "0001",
        PFKCODE: "0001",
        BUTCODE: "0001",
        INT_NOTE: "MCP 0.25 validation"
      }
    },
    ...functionRows.map(({ code, text, type }) => ({
      section: "functions",
      operation: "add",
      key: { CODE: code, TEXTNO: "01" },
      definition: { TYPE: type, TEXT_TYPE: "S", FUN_TEXT: text, INFO_TEXT: text }
    })),
    {
      section: "menuTexts",
      operation: "add",
      key: { CODE: "0001" },
      definition: { TEXT_TYPE: "S", TEXT: "Actions", PATH: "A" }
    },
    ...functionRows.map(({ code }, index) => ({
      section: "menus",
      operation: "add",
      key: { CODE: "0001", NO: String(index + 1).padStart(2, "0") },
      definition: { REF_TYPE: "F", REF_CODE: code, REF_NO: "01" }
    })),
    {
      section: "activeFunctions",
      operation: "add",
      key: { CODE: "0001", NO: "01" },
      definition: { MENUCODE: "0001" }
    },
    ...[
      ["01", "08"],
      ["02", "05"],
      ["03", "03"],
      ["04", "15"]
    ].map(([no, pfno]) => ({
      section: "buttons",
      operation: "add",
      key: { PFK_CODE: "0001", CODE: "0001", NO: no },
      definition: { PFNO: pfno }
    })),
    ...[
      ["03", "BACK"],
      ["05", "CLEAR"],
      ["08", "HELLO"],
      ["12", "CANC"],
      ["15", "EXIT"]
    ].map(([pfno, funcode]) => ({
      section: "pfKeys",
      operation: "add",
      key: { CODE: "0001", PFNO: pfno },
      definition: { FUNCODE: funcode, FUNNO: "01" }
    })),
    ...functionRows.map(({ code }) => ({
      section: "statusFunctions",
      operation: "add",
      key: { STATUS: "STATUS_025", FUNCTION: code }
    })),
    {
      section: "titles",
      operation: "add",
      key: { CODE: "TITLE_025" },
      definition: { TEXT: "MCP 0.25 Classic Screen" }
    }
  ]
  evidence.preparation.guiDefinition = JSON.parse(
    await call("patch_abap_gui_definition", {
      programName,
      expectedFingerprint: baselineGui.fingerprint,
      transportNumber,
      adminPatch: {
        ACTCODE: "000001",
        MENCODE: "000001",
        PFKCODE: "000001",
        DEFAULTACT: "0001",
        DEFAULTPFK: "0001",
        MOD_LANGU: "E"
      },
      operations
    })
  )

  evidence.preparation.transaction = await call("create_transaction_code", {
    transactionCode,
    programName,
    screenNumber,
    description: "MCP 0.25 classic screen",
    packageName,
    transportNumber
  })
  transactionCreated = true

  evidence.preparation.screenReadback = JSON.parse(
    await call("read_abap_screen", { programName, screenNumber })
  )
  evidence.preparation.guiReadback = JSON.parse(
    await call("read_abap_gui_definition", { programName })
  )
  evidence.preparation.transactionReadback = JSON.parse(
    await call("read_transaction_code", { transactionCode })
  )
  evidence.preparation.validation = JSON.parse(
    await call("validate_dynpro_application", { programName, screenNumber })
  )
  if (evidence.preparation.validation.status !== "valid") {
    throw new Error(`Dynpro validation failed: ${JSON.stringify(evidence.preparation.validation)}`)
  }

  const uriResult = await call("get_abap_object_workspace_uri", {
    objectName: programName,
    objectType: "PROG/P"
  })
  const workspaceUri = uriResult.match(/^Workspace URI: (.+)$/m)?.[1]
  if (!workspaceUri) throw new Error(`Could not resolve workspace URI: ${uriResult}`)
  evidence.preparation.workspaceUri = workspaceUri
  evidence.preparation.diagnostics = await call("get_abap_diagnostics", { fileUri: workspaceUri })

  await writeFile(
    readyPath,
    JSON.stringify(
      {
        status: "ready-for-gui-validation",
        transactionCode,
        programName,
        screenNumber,
        expectedTitle: "MCP 0.25 Classic Screen",
        requiredActions: ["screen-button", "menu", "toolbar", "pf-key", "back-exit-cancel"]
      },
      null,
      2
    )
  )
  await waitForCleanupSignal()
} catch (error) {
  primaryFailure = error
  evidence.failure = { error: String(error) }
} finally {
  if (transactionCreated) {
    try {
      evidence.cleanup.transaction = await call("delete_transaction_code", {
        transactionCode,
        expectedProgramName: programName,
        packageName,
        transportNumber
      })
      transactionCreated = false
    } catch (error) {
      evidence.cleanup.transaction = { error: String(error) }
      cleanupFailure = error
    }
  }
  if (programCreated) {
    try {
      evidence.cleanup.modulePool = await call("delete_module_pool", {
        programName,
        packageName,
        transportNumber
      })
      programCreated = false
    } catch (error) {
      evidence.cleanup.modulePool = { error: String(error) }
      cleanupFailure ||= error
    }
  }
  evidence.cleanup.transactionAbsence = await call(
    "read_transaction_code",
    { transactionCode },
    true
  ).catch((error) => String(error))
  evidence.cleanup.programAbsence = await call(
    "get_abap_object_info",
    { objectName: programName, objectType: "PROG" },
    true
  ).catch((error) => String(error))
  await client.close().catch(() => undefined)
}
if (primaryFailure || cleanupFailure) {
  const failures = []
  if (primaryFailure) failures.push(`Preparation: ${String(primaryFailure)}`)
  if (cleanupFailure) failures.push(`Cleanup: ${String(cleanupFailure)}`)
  throw new Error(failures.join("\n"))
}
console.log(JSON.stringify(evidence, null, 2))
