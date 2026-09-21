#!/usr/bin/env node
/**
 * Generate (or verify) the ORVANTA tool index from the single source of truth.
 *
 *   node scripts/generate-tool-index.mjs           # write docs/tool-index.md + contracts/tool-index.json
 *   node scripts/generate-tool-index.mjs --check   # verify the committed files match, exit 1 on drift
 *
 * Reads the compiled registry and contracts from `dist/`, so run `npm run build` first.
 * Nothing here touches SAP.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  PROFILE_NAMES,
  TOOL_COUNT,
  TOOL_MATRIX_VERSION,
  TOOL_NAMES,
  TOOL_REGISTRY,
  helperOperationRequirementGaps,
  toolNamesForProfile
} from "../dist/src/tool-registry.js"
import { toolContracts } from "../dist/src/contracts.js"
import { helperCapabilityRoutes } from "../dist/src/capabilities.js"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, "..")
const markdownPath = resolve(projectRoot, "docs", "tool-index.md")
const jsonPath = resolve(projectRoot, "contracts", "tool-index.json")
const check = process.argv.includes("--check")

const RISK_LABEL = (annotations) => {
  if (annotations.readOnlyHint === true) return "只读"
  if (annotations.destructiveHint === true) return "破坏性写"
  return "写"
}

const fail = (message) => {
  console.error(`tool index check failed: ${message}`)
  process.exit(1)
}

// ---- consistency checks (run in both modes) -------------------------------------------

const contractNames = Object.keys(toolContracts)
const registryNames = [...TOOL_NAMES]
const missingInRegistry = contractNames.filter((name) => !registryNames.includes(name))
const missingInContracts = registryNames.filter((name) => !contractNames.includes(name))
if (missingInRegistry.length > 0)
  fail(`contracts without registry entry: ${missingInRegistry.join(", ")}`)
if (missingInContracts.length > 0)
  fail(`registry entries without contract: ${missingInContracts.join(", ")}`)
if (TOOL_COUNT !== registryNames.length)
  fail(`registry count ${TOOL_COUNT} != ${registryNames.length} names`)
if (new Set(registryNames).size !== registryNames.length)
  fail("registry contains duplicate tool names")

const annotationConflicts = []
for (const entry of TOOL_REGISTRY) {
  if (entry.annotations.readOnlyHint === undefined) {
    annotationConflicts.push(`${entry.name}: registry annotation missing readOnlyHint`)
  }
  const declared = toolContracts[entry.name]?.annotations ?? {}
  for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint"]) {
    if (key in declared && declared[key] !== entry.annotations[key]) {
      annotationConflicts.push(
        `${entry.name}: ${key} contract=${String(declared[key])} registry=${String(entry.annotations[key])}`
      )
    }
  }
}
if (annotationConflicts.length > 0) fail(`annotation drift:\n  ${annotationConflicts.join("\n  ")}`)

const readOnlyNames = toolNamesForProfile("readonly")
if (readOnlyNames.length === 0) fail("readonly profile resolved to no tools")
const notReadOnly = readOnlyNames.filter(
  (name) => TOOL_REGISTRY.find((entry) => entry.name === name)?.annotations.readOnlyHint !== true
)
if (notReadOnly.length > 0) fail(`readonly profile contains write tools: ${notReadOnly.join(", ")}`)

// The capability report derives its helper and minimum protocol from this same registry. Resolving
// every helper capability here means a capability that disagrees with the routing fails the check
// instead of shipping as a wrong verdict. This is the gate that would have caught
// `repository-helper-function-source-write` being judged against the repository helper at 2.6
// while the registry already routed `write_function_module_source` to the base helper at 2.7.
try {
  const routes = helperCapabilityRoutes()
  const covered = new Set(routes.flatMap((route) => route.toolNames))
  console.log(
    `helper capabilities consistent: ${routes.length} capabilities over ${covered.size} tools`
  )
} catch (error) {
  fail(`helper capability / registry drift: ${error instanceof Error ? error.message : error}`)
}

// A verdict that compares protocol versions alone cannot catch a helper that self-describes 1.10
// while its operation list lacks the opcode the tool dispatches to; that is how a tool which can
// only fail was advertised as available. The DDIC helper already declares its operation inventory,
// so every tool routed there must declare the codes it sends.
const OPERATION_CHECKED_HELPER = "Z_ORVANTA_MCP_DDIC_API"
const operationGaps = helperOperationRequirementGaps(OPERATION_CHECKED_HELPER)
if (operationGaps.length > 0) {
  fail(
    `tools routed to ${OPERATION_CHECKED_HELPER} without a helper operation requirement: ${operationGaps.join(", ")}`
  )
}
console.log(`helper operation requirements pinned for every ${OPERATION_CHECKED_HELPER} tool`)

// ---- generated content ----------------------------------------------------------------

const groupCounts = new Map()
const profileCounts = new Map()
for (const entry of TOOL_REGISTRY) {
  groupCounts.set(entry.group, (groupCounts.get(entry.group) ?? 0) + 1)
  for (const profile of entry.profiles) {
    profileCounts.set(profile, (profileCounts.get(profile) ?? 0) + 1)
  }
}

const sorted = [...TOOL_REGISTRY].sort((a, b) => a.name.localeCompare(b.name))

const index = {
  matrixVersion: TOOL_MATRIX_VERSION,
  toolCount: TOOL_COUNT,
  readOnlyToolCount: readOnlyNames.length,
  profiles: Object.fromEntries(
    PROFILE_NAMES.map((profile) => [profile, toolNamesForProfile(profile).length])
  ),
  groups: Object.fromEntries([...groupCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
  tools: sorted.map((entry) => ({
    name: entry.name,
    group: entry.group,
    profiles: [...entry.profiles],
    annotations: { ...entry.annotations },
    route: entry.route,
    sapHelper: entry.sapHelper,
    minHelperProtocol: entry.minHelperProtocol,
    ...(entry.note ? { note: entry.note } : {})
  }))
}

const helperLabel = (entry) => {
  if (!entry.sapHelper) return "—"
  return entry.minHelperProtocol
    ? `${entry.sapHelper} (≥${entry.minHelperProtocol})`
    : entry.sapHelper
}

const lines = []
lines.push("# ORVANTA 工具索引（生成文件，请勿手工编辑）")
lines.push("")
lines.push(`- 矩阵版本：${TOOL_MATRIX_VERSION}`)
lines.push(`- 工具总数：${TOOL_COUNT}`)
lines.push(`- 只读工具：${readOnlyNames.length}`)
lines.push("- 数据来源：`src/tool-registry.ts`（单一事实源）+ `src/contracts.ts`")
lines.push("- 重新生成：`npm run matrix:generate`；一致性校验：`npm run matrix:check`")
lines.push("")
lines.push("## 概览")
lines.push("")
lines.push("| 维度 | 值 |")
lines.push("| --- | --- |")
for (const profile of PROFILE_NAMES) {
  lines.push(`| profile: ${profile} | ${toolNamesForProfile(profile).length} |`)
}
for (const [group, count] of [...groupCounts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  lines.push(`| 分组: ${group} | ${count} |`)
}
lines.push("")
lines.push("## 工具清单")
lines.push("")
lines.push("| 工具 | 分组 | profile | 风险 | 路由 | SAP 助手（最低协议） |")
lines.push("| --- | --- | --- | --- | --- | --- |")
for (const entry of sorted) {
  lines.push(
    `| \`${entry.name}\` | ${entry.group} | ${entry.profiles.join(", ")} | ${RISK_LABEL(entry.annotations)} | ${entry.route} | ${helperLabel(entry)} |`
  )
}
const notes = sorted.filter((entry) => entry.note)
if (notes.length > 0) {
  lines.push("")
  lines.push("## 边界说明")
  lines.push("")
  for (const entry of notes) {
    lines.push(`- \`${entry.name}\`：${entry.note}`)
  }
}
lines.push("")

const markdown = lines.join("\n")
const json = `${JSON.stringify(index, null, 2)}\n`

if (check) {
  const current = await Promise.all([
    readFile(markdownPath, "utf8").catch(() => null),
    readFile(jsonPath, "utf8").catch(() => null)
  ])
  if (current[0] !== markdown) fail(`${markdownPath} is out of date; run npm run matrix:generate`)
  if (current[1] !== json) fail(`${jsonPath} is out of date; run npm run matrix:generate`)
  console.log(
    `tool index consistent: ${TOOL_COUNT} tools, ${readOnlyNames.length} read-only, ${groupCounts.size} groups`
  )
} else {
  await mkdir(dirname(markdownPath), { recursive: true })
  await mkdir(dirname(jsonPath), { recursive: true })
  await writeFile(markdownPath, markdown, "utf8")
  await writeFile(jsonPath, json, "utf8")
  console.log(
    `wrote ${markdownPath} and ${jsonPath} (${TOOL_COUNT} tools, ${readOnlyNames.length} read-only)`
  )
}
