import { access, mkdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, resolve, sep } from "node:path"
import type { DiscoverySnapshotInfo, ExportResourceInfo } from "./backend.js"

export async function writeResourceExport(
  result: ExportResourceInfo,
  target: string,
  overwrite = false
): Promise<string> {
  if (!isAbsolute(target)) throw new Error("target must be an absolute local folder path")
  const root = resolve(target)
  if (!overwrite && (await exists(root))) {
    throw new Error(`Target already exists: ${root}. Set overwrite=true to replace matching files.`)
  }
  await mkdir(root, { recursive: true })
  for (const file of result.files) {
    const destination = resolve(root, file.relativePath)
    if (!destination.startsWith(`${root}${sep}`)) {
      throw new Error(`Unsafe export path: ${file.relativePath}`)
    }
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, file.content, "utf8")
  }
  return (
    `Downloaded ${result.source} to ${root}\n` +
    `Files: ${result.files.length}, Folders: ${countFolders(result.files.map((file) => file.relativePath))}, Skipped: 0, Failed: ${result.failures.length}` +
    (result.failures.length ? `\nFailures:\n  ${result.failures.slice(0, 50).join("\n  ")}` : "")
  )
}

export async function writeDiscoveryExport(
  connectionId: string,
  snapshot: DiscoverySnapshotInfo,
  exportRoot: string
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:T]/g, "-").replace(/\..+/, "")
  const root = resolve(exportRoot)
  await mkdir(root, { recursive: true })
  const folder = resolve(root, `adt-discovery_${safeSegment(connectionId)}_${timestamp}`)
  await mkdir(folder, { recursive: false })
  const files = {
    "README.md": buildDiscoveryIndex(connectionId, snapshot),
    "workspaces.md": buildWorkspaces(snapshot),
    "core-discovery.md": buildCoreDiscovery(snapshot),
    "res-app-classes.md": buildResAppClasses(snapshot)
  }
  await Promise.all(
    Object.entries(files).map(([name, content]) =>
      writeFile(resolve(folder, name), content, "utf8")
    )
  )
  const collectionCount = snapshot.workspaces.reduce(
    (sum, workspace) => sum + workspace.collections.length,
    0
  )
  const linkCount = snapshot.workspaces.reduce(
    (sum, workspace) =>
      sum +
      workspace.collections.reduce(
        (inner, collection) => inner + collection.templateLinks.length,
        0
      ),
    0
  )
  return (
    `ADT discovery exported to folder: ${folder}\n\n` +
    `Files created:\n` +
    `- README.md - Overview and stats\n` +
    `- workspaces.md - All ${snapshot.workspaces.length} discovery workspaces with ${collectionCount} collections and ${linkCount} template links\n` +
    `- core-discovery.md - ${snapshot.coreEntries.length} core discovery entries\n` +
    `- res-app-classes.md - ${snapshot.resAppClasses.length} RES_APP classes` +
    (snapshot.queryWarning ? `\nWarning: ${snapshot.queryWarning}` : "")
  )
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function countFolders(paths: string[]): number {
  const folders = new Set<string>()
  for (const path of paths) {
    const parts = path.split(/[\\/]/).slice(0, -1)
    for (let index = 1; index <= parts.length; index++) folders.add(parts.slice(0, index).join("/"))
  }
  return folders.size
}

function safeSegment(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
}

function markdown(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\r?\n/g, " ")
}

function buildDiscoveryIndex(connectionId: string, snapshot: DiscoverySnapshotInfo): string {
  const collections = snapshot.workspaces.reduce(
    (sum, workspace) => sum + workspace.collections.length,
    0
  )
  const links = snapshot.workspaces.reduce(
    (sum, workspace) =>
      sum +
      workspace.collections.reduce(
        (inner, collection) => inner + collection.templateLinks.length,
        0
      ),
    0
  )
  return `# ADT Discovery - ${connectionId.toUpperCase()}

> Exported ${new Date().toISOString()}

## Stats

| Metric | Count |
| --- | ---: |
| Discovery workspaces | ${snapshot.workspaces.length} |
| Collections | ${collections} |
| Template links | ${links} |
| Core discovery entries | ${snapshot.coreEntries.length} |
| RES_APP classes | ${snapshot.resAppClasses.length} |

## Files

- [workspaces.md](workspaces.md)
- [core-discovery.md](core-discovery.md)
- [res-app-classes.md](res-app-classes.md)
`
}

function buildWorkspaces(snapshot: DiscoverySnapshotInfo): string {
  const lines = ["# ADT Discovery Workspaces", ""]
  for (const workspace of snapshot.workspaces) {
    lines.push(`## ${markdown(workspace.title)}`, "")
    for (const collection of workspace.collections) {
      lines.push(
        `### ${markdown(collection.title || "(untitled)")}`,
        "",
        `- href: \`${collection.href}\``,
        ""
      )
      if (collection.templateLinks.length) {
        lines.push("| Template | Relation | Type | Title |", "| --- | --- | --- | --- |")
        for (const link of collection.templateLinks) {
          lines.push(
            `| \`${markdown(link.template)}\` | ${markdown(link.rel)} | ${markdown(link.type || "")} | ${markdown(link.title || "")} |`
          )
        }
        lines.push("")
      }
    }
  }
  return `${lines.join("\n")}\n`
}

function buildCoreDiscovery(snapshot: DiscoverySnapshotInfo): string {
  const lines = [
    "# ADT Core Discovery",
    "",
    "| Workspace | Collection | href | Category |",
    "| --- | --- | --- | --- |"
  ]
  for (const entry of snapshot.coreEntries) {
    lines.push(
      `| ${markdown(entry.title)} | ${markdown(entry.collectionTitle)} | \`${markdown(entry.href)}\` | ${markdown(entry.category)} |`
    )
  }
  return `${lines.join("\n")}\n`
}

function buildResAppClasses(snapshot: DiscoverySnapshotInfo): string {
  const lines = ["# RES_APP Classes", "", "| Class Name | Description |", "| --- | --- |"]
  for (const item of [...snapshot.resAppClasses].sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    lines.push(`| \`${markdown(item.name)}\` | ${markdown(item.description)} |`)
  }
  if (snapshot.queryWarning) lines.push("", `> Warning: ${snapshot.queryWarning}`)
  return `${lines.join("\n")}\n`
}
