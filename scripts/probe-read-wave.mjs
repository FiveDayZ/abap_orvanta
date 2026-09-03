import { createHash } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const endpoint = new URL(process.argv[2] ?? "http://127.0.0.1:4847/mcp")
const client = new Client({ name: "w200-read-wave-probe", version: "0.2.0" })
const cases = [
  {
    name: "get_object_by_uri",
    arguments: {
      uri: "/sap/bc/adt/programs/includes/zwmstctd01_frm",
      startLine: 0,
      lineCount: 5,
      connectionId: "w200"
    },
    expected: /Direct URI Access Successful/
  },
  {
    name: "search_abap_object_lines",
    arguments: {
      objectName: "ZWMSTCTD01_FRM",
      searchTerm: "FORM",
      contextLines: 0,
      connectionId: "w200",
      maxObjects: 1
    },
    expected: /Found \d+ matches/
  },
  {
    name: "get_abap_object_workspace_uri",
    arguments: {
      objectName: "ZWMSTCTD01_FRM",
      objectType: "PROG/I",
      connectionId: "w200"
    },
    expected: /Workspace URI: adt:\/\/w200\/sap\/bc\/adt\//
  },
  {
    name: "get_abap_object_url",
    arguments: {
      objectName: "ZWMSTCTD01_FRM",
      objectType: "PROG/P",
      connectionId: "w200"
    },
    expected: /SAP GUI URL Generated Successfully[\s\S]*Transaction: SE38/
  },
  {
    name: "find_where_used",
    arguments: {
      objectName: "ZCL_CA_HZ",
      objectType: "CLAS/OC",
      connectionId: "w200",
      maxResults: 5,
      filter: { excludeSystemObjects: true }
    },
    expected: /ABAP Where-Used Analysis/
  },
  {
    name: "get_sap_system_info",
    arguments: { connectionId: "w200", includeComponents: false },
    expected: /SAP System: W200[\s\S]*- Type: (ECC|S\/4HANA)/
  },
  {
    name: "get_version_history",
    arguments: {
      objectName: "ZCL_CA_HZ",
      objectType: "CLAS/OC",
      connectionId: "w200",
      action: "list_versions",
      maxVersions: 5
    },
    expected: /Version History for ZCL_CA_HZ/
  }
]

const results = []
let failed = false
try {
  await client.connect(new StreamableHTTPClientTransport(endpoint))
  for (const item of cases) {
    const result = await client.callTool({ name: item.name, arguments: item.arguments })
    const text = result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
    const passed = !result.isError && item.expected.test(text)
    failed ||= !passed
    results.push({
      tool: item.name,
      passed,
      isError: !!result.isError,
      textLength: text.length,
      sha256: createHash("sha256").update(text).digest("hex").toUpperCase(),
      firstLine: text.split("\n")[0],
      ...(passed ? {} : { failureExcerpt: text.slice(0, 500) })
    })
  }
} finally {
  await client.close()
}

console.log(JSON.stringify({ endpoint: endpoint.href, results }, null, 2))
if (failed) throw new Error("One or more live read-wave checks failed")
