// 把登记表引用的验收记录暂存进发布物的 app/docs/workspace-evidence/，并写下清单。
//
// 运行期只用「记录存在」这一个事实（src/verification-registry.ts 的 resolveEvidencePath 走
// existsSync），从不解析记录正文；正文是给人看的审计留痕。正因为如此，出厂副本可以改写
// 标识符而不改变任何能力状态——但改写必须如实写进清单：包内副本与原记录不再逐字节相同，
// 任何据此推断「逐字节一致」的结论都是错的，清单里的 sourceSha256 保留原记录的哈希供核对。
//
// 改写只覆盖下面这组已声明模式，属**受控替换而非脱敏保证**：仍可能有其它未枚举的标识符留在
// 出厂副本里（客户名、工单号、主机别名等）。守卫用比改写更宽的网（任一 IPv4、任何
// Windows 用户目录）复扫落盘后的字节，把「改写规则没覆盖到」的情况挡在打包期。
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const REDACTED_IPV4 = "[redacted-ipv4]"
const REDACTED_USER = "[redacted-user]"

/** 出厂副本里要被改写的标识符。新增一条即在清单里多声明一条。 */
const REDACTIONS = [
  {
    name: "private-ipv4",
    pattern: /\b(?:10|172|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    replacement: REDACTED_IPV4
  },
  {
    name: "windows-user-profile",
    pattern: /([A-Za-z]:\\+Users\\+)[^\\/\s"']+/g,
    replacement: `$1${REDACTED_USER}`
  },
  {
    // 手工维护的字面量清单：SAP 用户名这类标识符无法用通用模式识别。
    name: "declared-identifiers",
    pattern: /\bwys\b/gi,
    replacement: REDACTED_USER
  }
]

/** 守卫：比 REDACTIONS 更宽，且只在落盘后的字节上跑。 */
const RESIDUAL_IPV4 = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g
const ALLOWED_ADDRESSES = new Set(["127.0.0.1", "0.0.0.0"])
// 捕获用户段再比对，不用「后面不是占位符」的负向断言：`\\+` 会回溯到较短的反斜杠序列，
// 断言随即在错误的位置成立，把已经改写好的路径误报成残留（2026-10-14 实测踩到）。
const RESIDUAL_USER_PROFILE = /[A-Za-z]:\\+Users\\+([^\\/\s"']+)/g

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

/** 合法 UTF-8 才做文本改写；二进制原样复制，避免改写破坏字节。 */
function asText(bytes) {
  const text = bytes.toString("utf8")
  return Buffer.from(text, "utf8").equals(bytes) ? text : undefined
}

function redact(bytes) {
  const text = asText(bytes)
  if (text === undefined) return { bytes, applied: [], replacements: 0 }
  let output = text
  const applied = []
  let replacements = 0
  for (const rule of REDACTIONS) {
    const hits = output.match(rule.pattern)?.length ?? 0
    if (hits === 0) continue
    applied.push(rule.name)
    replacements += hits
    output = output.replace(rule.pattern, rule.replacement)
  }
  if (replacements === 0) return { bytes, applied, replacements }
  return { bytes: Buffer.from(output, "utf8"), applied, replacements }
}

/** 从落盘文件重新读取并复扫——与改写函数的返回值不同源。 */
function findResidualIdentifiers(stagedPath) {
  const text = asText(readFileSync(stagedPath))
  if (text === undefined) return []
  const found = []
  for (const match of text.matchAll(RESIDUAL_IPV4)) {
    if (!ALLOWED_ADDRESSES.has(match[0])) found.push(`ipv4 ${match[0]}`)
  }
  for (const match of text.matchAll(RESIDUAL_USER_PROFILE)) {
    if (match[1] !== REDACTED_USER) found.push(`windows user profile ${match[1]}`)
  }
  return found
}

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

  // 解析、改写并哈希每一个来源，全部算完再落盘，避免半途失败留下不完整产物。
  const planned = files.map((file) => {
    const sourceBytes = readFileSync(file.source)
    const { bytes, applied, replacements } = redact(sourceBytes)
    return {
      ...file,
      bytes,
      size: bytes.length,
      sha256: sha256(bytes),
      sourceSha256: sha256(sourceBytes),
      redacted: replacements > 0,
      redactionPatterns: applied,
      redactionCount: replacements
    }
  })
  for (const file of planned) {
    const destination = join(output, file.path)
    mkdirSync(dirname(destination), { recursive: true })
    // flag "wx" 即「不存在才创建」：既不覆盖既有产物，也保持与源文件的排他语义。
    writeFileSync(destination, file.bytes, { flag: "wx" })
    const copiedHash = sha256(readFileSync(destination))
    if (copiedHash !== file.sha256) {
      throw new Error(`Release verification source changed while staging: ${file.path}`)
    }
  }

  // 打包期闸门：改写规则漏掉的标识符在这里让构建失败，而不是随包出厂。
  const residuals = []
  for (const file of planned) {
    const found = findResidualIdentifiers(join(output, file.path))
    if (found.length > 0) residuals.push(`${file.path}: ${[...new Set(found)].join(", ")}`)
  }
  if (residuals.length > 0) {
    throw new Error(
      `Staged verification evidence still carries identifiers: ${residuals.join("; ")}. ` +
        "Extend REDACTIONS in scripts/stage-release-evidence.mjs, or stop shipping this record."
    )
  }

  const manifestPath = join(contractsRoot, "verification-evidence-manifest.json")
  const manifest = {
    version: 2,
    entryCount: registered.length,
    evidenceCount: references.length,
    // 出厂副本经过受控改写：sha256 是包内副本的哈希，sourceSha256 是原记录的哈希。
    redaction: {
      applied: planned.some((file) => file.redacted),
      patterns: REDACTIONS.map((rule) => rule.name),
      fileCount: planned.filter((file) => file.redacted).length,
      replacementCount: planned.reduce((total, file) => total + file.redactionCount, 0),
      note:
        "Packaged records are redacted copies, not byte-identical mirrors of the workspace records. " +
        "Redaction is a declared pattern set, not a guarantee of complete de-identification."
    },
    files: planned.map(({ path, size, sha256, sourceSha256, redacted, redactionPatterns }) => ({
      path,
      size,
      sha256,
      sourceSha256,
      redacted,
      redactionPatterns
    }))
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
