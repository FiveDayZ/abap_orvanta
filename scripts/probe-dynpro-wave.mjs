import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const endpoint = new URL(process.env.ABAP_MCP_ENDPOINT || "http://127.0.0.1:4847/mcp")
const connectionId = process.env.ABAP_MCP_CONNECTION || "w200"
const writeEnabled = process.env.ABAP_MCP_DYNPRO_WRITE === "1"
const programName = process.env.ABAP_MCP_DYNPRO_PROGRAM || "ZCODEX_MCP_DYNPRO"
const screenNumber = process.env.ABAP_MCP_DYNPRO_SCREEN || "0100"
const transactionCode = process.env.ABAP_MCP_DYNPRO_TRANSACTION || "ZCODEX_MCP_UI"
const transportNumber = process.env.ABAP_MCP_TRANSPORT || "GR2K923421"
const testComponent = (process.env.ABAP_MCP_DYNPRO_TEST_COMPONENT || "BTN_PATCH_021").toUpperCase()
const client = new Client({ name: "w200-dynpro-wave-probe", version: "0.21.0" })

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

async function readScreen() {
  return JSON.parse(await call("read_abap_screen", { programName, screenNumber }))
}

async function readState() {
  const screen = await readScreen()
  const validation = JSON.parse(
    await call("validate_dynpro_application", { programName, screenNumber })
  )
  const transaction = JSON.parse(await call("read_transaction_code", { transactionCode }))
  return { screen, validation, transaction }
}

function fieldName(field) {
  return String(field.FNAM || field.NAME || "").toUpperCase()
}

function semanticScreen(screen) {
  const { fingerprint, moduleReferences, header, ...definition } = screen
  const { DGEN, TGEN, ...stableHeader } = header
  return { ...definition, header: stableHeader }
}

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint))
  const baseline = await readState()

  if (!writeEnabled) {
    console.log(
      JSON.stringify({ endpoint: endpoint.href, connectionId, writeEnabled, ...baseline }, null, 2)
    )
  } else {
    if (baseline.screen.fields.some((field) => fieldName(field) === testComponent)) {
      throw new Error(`Test component already exists; refusing to overwrite it: ${testComponent}`)
    }

    let componentCreated = false
    try {
      const added = JSON.parse(
        await call("patch_abap_screen", {
          programName,
          screenNumber,
          expectedFingerprint: baseline.screen.fingerprint,
          transportNumber,
          componentOperations: [
            {
              operation: "add",
              name: testComponent,
              definition: {
                TYPE: "PUSH",
                TEXT: "Patch",
                LINE: "7",
                COLUMN: "2",
                LENGTH: "12",
                PUSH_FCODE: "CLEAR"
              }
            }
          ]
        })
      )
      componentCreated = true
      const staleFingerprintRejection = await call(
        "patch_abap_screen",
        {
          programName,
          screenNumber,
          expectedFingerprint: baseline.screen.fingerprint,
          transportNumber,
          componentOperations: [{ operation: "remove", name: testComponent }]
        },
        true
      )
      const updated = JSON.parse(
        await call("patch_abap_screen", {
          programName,
          screenNumber,
          expectedFingerprint: added.fingerprint,
          transportNumber,
          componentOperations: [
            {
              operation: "update",
              name: testComponent,
              definition: {
                TYPE: "PUSH",
                TEXT: "Patched",
                LINE: "7",
                COLUMN: "4",
                LENGTH: "12",
                PUSH_FCODE: "CLEAR"
              }
            }
          ]
        })
      )
      const patchedValidation = JSON.parse(
        await call("validate_dynpro_application", { programName, screenNumber })
      )
      if (patchedValidation.status === "invalid") {
        throw new Error(`Patched Dynpro validation failed: ${JSON.stringify(patchedValidation)}`)
      }
      const removed = JSON.parse(
        await call("patch_abap_screen", {
          programName,
          screenNumber,
          expectedFingerprint: updated.fingerprint,
          transportNumber,
          componentOperations: [{ operation: "remove", name: testComponent }]
        })
      )
      componentCreated = false
      const final = await readState()
      if (
        JSON.stringify(semanticScreen(final.screen)) !==
        JSON.stringify(semanticScreen(baseline.screen))
      ) {
        throw new Error("Dynpro cleanup did not restore the original semantic screen definition")
      }

      console.log(
        JSON.stringify(
          {
            endpoint: endpoint.href,
            connectionId,
            writeEnabled,
            baseline,
            added,
            updated,
            patchedValidation,
            staleFingerprintRejection,
            removed,
            final
          },
          null,
          2
        )
      )
    } finally {
      if (componentCreated) {
        const current = await readScreen()
        if (current.fields.some((field) => fieldName(field) === testComponent)) {
          await call("patch_abap_screen", {
            programName,
            screenNumber,
            expectedFingerprint: current.fingerprint,
            transportNumber,
            componentOperations: [{ operation: "remove", name: testComponent }]
          })
        }
      }
    }
  }
} finally {
  await client.close()
}
