import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, "..")
const sourcePackage = resolve(
  process.argv[2] ?? resolve(projectRoot, "..", "vscode_abap_remote_fs", "package.json")
)
const output = resolve(projectRoot, "contracts", "source-baseline.json")
const fullOutput = resolve(projectRoot, "contracts", "full-tool-baseline.json")
const names = new Set([
  "get_connected_systems",
  "search_abap_objects",
  "get_abap_object_info",
  "get_abap_object_lines",
  "get_batch_lines"
])

const manifest = JSON.parse(await readFile(sourcePackage, "utf8"))
const languageModelTools = manifest.contributes.languageModelTools.map((tool) => ({
  name: tool.name,
  description: tool.modelDescription,
  inputSchema: tool.inputSchema,
  tags: tool.tags,
  origin: "languageModelTool"
}))
const mcpOnlyTools = [
  {
    name: "replace_string_in_abap_object",
    description:
      "Edit ABAP source by exact unique string replacement, then save, activate, unlock, and synchronize to SAP.",
    inputSchema: {
      type: "object",
      properties: {
        fileUri: { type: "string" },
        oldString: { type: "string" },
        newString: { type: "string" },
        transportNumber: { type: "string" }
      },
      required: ["fileUri", "oldString", "newString"]
    },
    tags: ["abap-fs"],
    origin: "mcpOnly"
  },
  {
    name: "get_abap_diagnostics",
    description: "Get syntax errors, warnings, and diagnostics for an ABAP source URI.",
    inputSchema: {
      type: "object",
      properties: { fileUri: { type: "string" } },
      required: ["fileUri"]
    },
    tags: ["abap-fs"],
    origin: "mcpOnly"
  }
]
const fullTools = [...languageModelTools, ...mcpOnlyTools]
  .map((tool) => ({ ...tool, classification: classify(tool.name) }))
  .sort((left, right) => left.name.localeCompare(right.name))
const tools = languageModelTools
  .filter((tool) => names.has(tool.name))
  .map(({ origin: _origin, ...tool }) => tool)
  .sort((left, right) => left.name.localeCompare(right.name))

if (tools.length !== names.size) {
  throw new Error(`Expected ${names.size} tools, found ${tools.length}`)
}

await mkdir(dirname(output), { recursive: true })
await writeFile(
  output,
  `${JSON.stringify(
    {
      sourcePackage,
      sourceVersion: manifest.version,
      extractedAt: new Date().toISOString(),
      tools
    },
    null,
    2
  )}\n`,
  "utf8"
)
await writeFile(
  fullOutput,
  `${JSON.stringify(
    {
      sourcePackage,
      sourceVersion: manifest.version,
      sourceCommit: "0466e8ceea4e201335d74a7420ac894384f4a0e2",
      extractedAt: new Date().toISOString(),
      toolCount: fullTools.length,
      tools: fullTools
    },
    null,
    2
  )}\n`,
  "utf8"
)
console.log(`Extracted ${tools.length} implemented and ${fullTools.length} full tool contracts`)

function classify(name) {
  const readWave = new Set([
    "get_connected_systems",
    "search_abap_objects",
    "get_abap_object_info",
    "get_abap_object_lines",
    "get_batch_lines",
    "get_object_by_uri",
    "search_abap_object_lines",
    "get_abap_object_workspace_uri",
    "get_abap_object_url",
    "find_where_used",
    "get_sap_system_info",
    "get_version_history"
  ])
  const diagnosticsWave = new Set([
    "execute_data_query",
    "get_abap_sql_syntax",
    "run_atc_analysis",
    "run_unit_tests",
    "analyze_abap_dumps",
    "analyze_abap_traces",
    "adt_discovery_export",
    "abap_download",
    "get_abap_diagnostics"
  ])
  const writeWave = new Set([
    "create_object_programmatically",
    "manage_text_elements",
    "create_test_include",
    "manage_transport_requests",
    "abap_activate",
    "replace_string_in_abap_object"
  ])
  const executionWave = new Set([
    "abap_execute_command",
    "abap_debug_session",
    "abap_debug_breakpoint",
    "abap_debug_step",
    "abap_debug_variable",
    "abap_debug_stack",
    "abap_debug_status"
  ])
  const editorOnly = new Set(["get_atc_decorations", "open_object"])
  const localOnly = new Set([
    "get_test_folder",
    "get_sap_webgui_url",
    "build_test_index",
    "build_test_index_docx",
    "split_test_cases",
    "verify_test_data_usage",
    "check_test_data",
    "build_evidence_report",
    "playwright_test",
    "create_mermaid_diagram",
    "validate_mermaid_syntax",
    "get_mermaid_documentation",
    "detect_mermaid_diagram_type",
    "create_test_documentation",
    "manage_subagents",
    "abap_fs_documentation",
    "manage_heartbeat",
    "analyze_anst_enhancements"
  ])
  if (readWave.has(name)) return { scope: "sap-core", effect: "read-only", wave: "read" }
  if (diagnosticsWave.has(name)) {
    return { scope: "sap-core", effect: "diagnostic-or-export", wave: "diagnostics" }
  }
  if (writeWave.has(name)) return { scope: "sap-core", effect: "state-changing", wave: "write" }
  if (executionWave.has(name)) {
    return { scope: "sap-core", effect: "runtime-execution", wave: "execution-debug" }
  }
  if (editorOnly.has(name)) return { scope: "editor-only", effect: "local", wave: "excluded" }
  if (localOnly.has(name)) return { scope: "local-tooling", effect: "local", wave: "excluded" }
  throw new Error(`Tool classification missing: ${name}`)
}
