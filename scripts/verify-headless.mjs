import { readFile, readdir } from "node:fs/promises"
import { extname, join, resolve } from "node:path"

const sourceOnly = process.argv.includes("--source-only")
const roots = [resolve("src")]
if (!sourceOnly) roots.push(resolve("dist", "src"))
const forbidden = [
  /(?:from\s+|require\()["']vscode["']/,
  /Code\.exe/i,
  /vscode-extension-host/i,
  /child_process/
]
const failures = []

for (const root of roots) {
  for (const file of await filesUnder(root)) {
    if (![".ts", ".js"].includes(extname(file))) continue
    const content = await readFile(file, "utf8")
    for (const pattern of forbidden) {
      if (pattern.test(content)) failures.push(`${file}: forbidden pattern ${pattern}`)
    }
  }
}

const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8"))
if (packageJson.dependencies?.vscode || packageJson.devDependencies?.vscode) {
  failures.push("package.json: vscode dependency is forbidden")
}

if (failures.length) {
  console.error(failures.join("\n"))
  process.exit(1)
}
console.log(`Headless verification PASS (${roots.length} tree(s), no VS Code host dependency)`)

async function filesUnder(root) {
  const result = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) result.push(...(await filesUnder(path)))
    else result.push(path)
  }
  return result
}
