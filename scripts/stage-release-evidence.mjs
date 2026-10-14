import { createHash } from "node:crypto"
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

export function stageReleaseEvidence(sourceRoot, appRoot) {
  const root = resolve(sourceRoot)
  const output = resolve(appRoot)
  const contractsRoot = join(output, "contracts")
  const evidenceRoot = join(output, "docs", "workspace-evidence")
  if (existsSync(contractsRoot) || existsSync(evidenceRoot)) {
    throw new Error("Release verification output already exists; refusing to overwrite it.")
  }
  const registryPath = join(root, "contracts", "verification-registry.json")
  const indexPath = join(root, "contracts", "tool-index.json")
  const registry = JSON.parse(readFileSync(registryPath, "utf8"))
  const index = JSON.parse(readFileSync(indexPath, "utf8"))
  if (!Array.isArray(registry.entries) || !Array.isArray(index.tools)) {
    throw new Error("Release verification registry and tool index must contain arrays.")
  }
  const registered = registry.entries.map((entry) => entry.tool).sort()
  const indexed = index.tools.map((entry) => entry.name).sort()
  if (
    registered.some((name) => typeof name !== "string" || name.length === 0) ||
    new Set(registered).size !== registered.length ||
    new Set(indexed).size !== indexed.length ||
    JSON.stringify(registered) !== JSON.stringify(indexed)
  ) {
    throw new Error("Release verification registry and tool index do not cover the same tools.")
  }
  const required = registry.entries.filter((entry) =>
    ["verified", "failed", "platform-unsupported"].includes(entry.status)
  )
  if (required.some((entry) => typeof entry.evidence !== "string" || !entry.evidence.trim())) {
    throw new Error("A release verification claim has no evidence reference.")
  }
  const references = [...new Set(required.map((entry) => entry.evidence))].sort()
  const roots = [root, dirname(root), join(root, "docs", "workspace-evidence")]
  const files = [
    { source: registryPath, path: "contracts/verification-registry.json" },
    { source: indexPath, path: "contracts/tool-index.json" }
  ]
  for (const reference of references) {
    const path = reference.replaceAll("\\", "/")
    const segments = path.split("/")
    if (
      isAbsolute(reference) ||
      ![".doc", ".logs", ".cache", "docs"].includes(segments[0]) ||
      segments.some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw new Error("Release evidence reference must remain inside an evidence directory.")
    }
    const source = roots.map((base) => join(base, path)).find((file) => existsSync(file))
    if (!source || !statSync(source).isFile()) {
      throw new Error(`Release verification evidence is missing: ${path}`)
    }
    files.push({ source, path: `docs/workspace-evidence/${path}` })
  }

  // Resolve and hash every source before writing any package verification file.
  const planned = files.map((file) => {
    const bytes = readFileSync(file.source)
    return {
      ...file,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    }
  })
  for (const file of planned) {
    const destination = join(output, file.path)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(file.source, destination, constants.COPYFILE_EXCL)
    const copiedHash = createHash("sha256").update(readFileSync(destination)).digest("hex")
    if (copiedHash !== file.sha256) {
      throw new Error(`Release verification source changed while staging: ${file.path}`)
    }
  }
  const manifestPath = join(contractsRoot, "verification-evidence-manifest.json")
  const manifest = {
    version: 1,
    entryCount: registered.length,
    evidenceCount: references.length,
    files: planned.map(({ path, size, sha256 }) => ({ path, size, sha256 }))
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" })
  return { ...manifest, manifestPath: relative(output, manifestPath).replaceAll("\\", "/") }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    throw new Error("Usage: node scripts/stage-release-evidence.mjs <new-package-app-root>")
  }
  const { files, ...summary } = stageReleaseEvidence(projectRoot, process.argv[2])
  console.log(JSON.stringify({ ...summary, fileCount: files.length }, null, 2))
}
