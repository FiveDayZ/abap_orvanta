import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const endpoint = new URL(process.env.ABAP_MCP_ENDPOINT || "http://127.0.0.1:4847/mcp")
const connectionId = process.env.ABAP_MCP_CONNECTION || "w200"
const writeEnabled = process.env.ABAP_MCP_GUI_WRITE === "1"
const programName = process.env.ABAP_MCP_GUI_PROGRAM || "ZCODEX_MCP_DYNPRO"
const transportNumber = process.env.ABAP_MCP_TRANSPORT || "GR2K923421"
const testTitle = (process.env.ABAP_MCP_GUI_TEST_TITLE || "TITLE_MCP_022").toUpperCase()
const client = new Client({ name: "w200-gui-wave-probe", version: "0.22.0" })

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
  return JSON.parse(text)
}

async function readGui() {
  return call("read_abap_gui_definition", { programName })
}

function semanticGui(gui) {
  return { admin: gui.admin, sections: gui.sections }
}

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint))
  const baseline = await readGui()
  if (!writeEnabled) {
    console.log(
      JSON.stringify({ endpoint: endpoint.href, connectionId, writeEnabled, baseline }, null, 2)
    )
  } else {
    if (baseline.sections.titles.some((row) => row.CODE === testTitle)) {
      throw new Error(`Test title already exists; refusing to overwrite it: ${testTitle}`)
    }
    let titleCreated = false
    try {
      const added = await call("patch_abap_gui_definition", {
        programName,
        expectedFingerprint: baseline.fingerprint,
        transportNumber,
        operations: [
          {
            section: "titles",
            operation: "add",
            key: { CODE: testTitle },
            definition: { TEXT: "MCP GUI validation" }
          }
        ]
      })
      titleCreated = true
      const staleFingerprintRejection = await call(
        "patch_abap_gui_definition",
        {
          programName,
          expectedFingerprint: baseline.fingerprint,
          transportNumber,
          operations: [{ section: "titles", operation: "remove", key: { CODE: testTitle } }]
        },
        true
      )
      const updated = await call("patch_abap_gui_definition", {
        programName,
        expectedFingerprint: added.fingerprint,
        transportNumber,
        operations: [
          {
            section: "titles",
            operation: "update",
            key: { CODE: testTitle },
            definition: { TEXT: "MCP GUI validated" }
          }
        ]
      })
      const removed = await call("patch_abap_gui_definition", {
        programName,
        expectedFingerprint: updated.fingerprint,
        transportNumber,
        operations: [{ section: "titles", operation: "remove", key: { CODE: testTitle } }]
      })
      titleCreated = false
      const final = await readGui()
      if (JSON.stringify(semanticGui(final)) !== JSON.stringify(semanticGui(baseline))) {
        throw new Error("GUI cleanup did not restore the original semantic definition")
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
            staleFingerprintRejection,
            removed,
            final
          },
          null,
          2
        )
      )
    } finally {
      if (titleCreated) {
        const current = await readGui()
        if (current.sections.titles.some((row) => row.CODE === testTitle)) {
          await call("patch_abap_gui_definition", {
            programName,
            expectedFingerprint: current.fingerprint,
            transportNumber,
            operations: [{ section: "titles", operation: "remove", key: { CODE: testTitle } }]
          })
        }
      }
    }
  }
} finally {
  await client.close()
}
