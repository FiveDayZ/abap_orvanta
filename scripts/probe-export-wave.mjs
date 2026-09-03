import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const endpoint = process.env.ABAP_MCP_ENDPOINT || "http://127.0.0.1:4847/mcp"
const connectionId = process.env.ABAP_MCP_CONNECTION || "w200"
const root = await mkdtemp(join(tmpdir(), "abap-mcp-live-export-"))
const target = join(root, "download")
const client = new Client({ name: "w200-export-wave-probe", version: "0.6.0" })

try {
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)))
  const download = await client.callTool({
    name: "abap_download",
    arguments: {
      source: "ZCL_CA_HZ",
      objectType: "CLAS/OC",
      connectionId,
      target
    }
  })
  if (download.isError) throw new Error(JSON.stringify(download.content))
  const downloadedFiles = await recursiveFiles(target)
  if (!downloadedFiles.length) throw new Error("Download produced no files")
  const firstSource = await readFile(downloadedFiles[0], "utf8")
  if (!firstSource.trim()) throw new Error("Downloaded source is empty")

  const discovery = await client.callTool({
    name: "adt_discovery_export",
    arguments: { connectionId }
  })
  if (discovery.isError) throw new Error(JSON.stringify(discovery.content))
  const discoveryText = discovery.content.find((part) => part.type === "text")?.text || ""
  const folder = discoveryText.match(/^ADT discovery exported to folder: (.+)$/m)?.[1]
  if (!folder) throw new Error(discoveryText || "Discovery export returned no folder")
  const discoveryFiles = await readdir(folder)
  for (const expected of [
    "README.md",
    "workspaces.md",
    "core-discovery.md",
    "res-app-classes.md"
  ]) {
    if (!discoveryFiles.includes(expected)) throw new Error(`Missing discovery file: ${expected}`)
  }
  console.log(
    JSON.stringify(
      {
        endpoint,
        connectionId,
        downloadedFiles: downloadedFiles.length,
        firstSourceBytes: Buffer.byteLength(firstSource),
        discoveryFolder: folder,
        discoveryFiles: discoveryFiles.sort()
      },
      null,
      2
    )
  )
} finally {
  await client.close()
  await rm(root, { recursive: true, force: true })
}

async function recursiveFiles(folder) {
  const result = []
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) result.push(...(await recursiveFiles(path)))
    else result.push(path)
  }
  return result
}
