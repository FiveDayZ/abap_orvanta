// Generate the operations acceptance matrix (plan OP4-1) from the code and the evidence registry.
//
// The matrix is a view, never a source: family state, tools, gaps, purposes and closure routes come
// from `src/ops-coverage.ts`, and per-tool evidence comes from `contracts/verification-registry.json`.
// `--check` fails when the committed document no longer matches, so a state change cannot be shipped
// with a stale acceptance table.
//
// Usage: node scripts/generate-ops-matrix.mjs [--check]
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const target = "docs/ops-acceptance-matrix.md"
const check = process.argv.includes("--check")

const { opsCapabilityBlock } = await import(new URL("../dist/src/ops-coverage.js", import.meta.url))

const registryPath = resolve(root, "contracts/verification-registry.json")
let registry
try {
  registry = JSON.parse(readFileSync(registryPath, "utf8"))
} catch {
  console.error(`cannot read ${registryPath}: the matrix needs the evidence registry`)
  process.exit(1)
}
const entries = new Map(registry.entries.map((entry) => [entry.tool, entry]))
const block = opsCapabilityBlock({ entries })

const ROUTE_ORDER = [
  "service",
  "helper",
  "approval",
  "authorization",
  "landscape",
  "platform",
  "none"
]
const ROUTE_LABEL = {
  service: "this repository",
  helper: "SAP-side helper + F8",
  approval: "operator approval",
  authorization: "write authorisation (OP2)",
  landscape: "multi-system configuration (OP3)",
  platform: "the platform (exempt)",
  none: "-"
}

const cell = (value) => String(value).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim()
const evidenceOf = (tool) => {
  const entry = entries.get(tool)
  if (!entry) return "unregistered"
  if (entry.status === "verified") return entry.evidence ? `\`${entry.evidence}\`` : "verified"
  const when = entry.lastAttemptAt ? ` (last attempt ${entry.lastAttemptAt})` : ""
  return `${entry.status}${when}`
}

const lines = []
lines.push("# Operations acceptance matrix (plan OP4-1)")
lines.push("")
lines.push(
  "This file is **generated** from `src/ops-coverage.ts` (families, purposes, closure routes, gaps)"
)
lines.push(
  "and `contracts/verification-registry.json` (per-tool evidence). It is the frozen 14-family"
)
lines.push(
  "regression matrix the operations plan asks for: one row per family with the criterion that makes"
)
lines.push(
  'it "completable by the MCP service", the evidence pointers behind that claim, and who can remove'
)
lines.push("what is still missing.")
lines.push("")
lines.push(
  "- Regenerate: `npm run ops:matrix:generate`. Verify: `npm run ops:matrix:check` (also part of `npm run verify`)."
)
lines.push(
  "- **Rule**: a 95% claim may only be made when this matrix shows **>= 95%** of the required families"
)
lines.push(
  "  end-to-end. That needs both points on the same family - the declared gap is empty **and** every"
)
lines.push(
  "  present tool carries recorded evidence. Read-side breadth never compensates for a missing action."
)
lines.push(
  "- Tool-level standing is always stated per tool in the registry, never as a family-level score; the"
)
lines.push("  evidence column below is a pointer, not a re-judgement.")
lines.push("")

const summary = block.summary
lines.push("## Summary")
lines.push("")
lines.push("| Reading | Value |")
lines.push("| ------- | ----- |")
lines.push(
  `| Families reported | ${summary.familyCount} (14 required + ${summary.exemptFamilies.length} documented exemption) |`
)
lines.push(
  `| State counts | ${Object.entries(summary.stateCounts)
    .map(([state, count]) => `${state} ${count}`)
    .join(", ")} |`
)
lines.push(
  `| End-to-end by state (all families) | ${summary.endToEndFamilyCount} (${summary.endToEndPercent}%) |`
)
lines.push(
  `| Required families counted closed | **${summary.closedRequiredFamilyCount} / ${summary.requiredEndToEndFamilyCount}** (${summary.endToEndPercentOfRequired}% of required) |`
)
lines.push(
  `| Criterion (>= 95% of required) | ${summary.criterionMet ? "met" : "**not met**"} - ${summary.criterionBasis} |`
)
lines.push(
  `| Closed by state but missing evidence | ${summary.evidenceUnregisteredFamilies.join(", ") || "none"} |`
)
lines.push(
  `| Outstanding required families | ${summary.outstandingRequiredFamilies.join(", ") || "none"} |`
)
lines.push(
  `| Waiting on each route | ${ROUTE_ORDER.filter((route) => summary.closeRouteCounts[route] > 0)
    .map((route) => `${ROUTE_LABEL[route]} ${summary.closeRouteCounts[route]}`)
    .join(", ")} |`
)
lines.push("")

lines.push("## The matrix")
lines.push("")
lines.push(
  "| # | Family | Purpose | Read side | Action side | State | Evidence (verified/present) | Route |"
)
lines.push(
  "| - | ------ | ------- | --------- | ----------- | ----- | --------------------------- | ----- |"
)
block.families.forEach((family, index) => {
  const readMatch = `${family.readTools.length}/${family.toolNames.length}`
  const actionMatch = family.actionTools.length === 0 ? "-" : `${family.actionTools.length}`
  const pending = family.verification.blockingTools
  // A platform-blocked tool is not "pending evidence": it is a documented verdict, and calling it
  // pending would invite a reader to wait for a call that can never succeed.
  const pendingLabel = pending.every((tool) => family.platformBlockedTools.includes(tool))
    ? "platform-blocked"
    : "pending"
  const evidence =
    family.toolNames.length === 0
      ? "no tool exists"
      : `${family.verification.verified.length}/${family.toolNames.length} verified` +
        (pending.length > 0 ? ` (${pendingLabel}: ${pending.join(", ")})` : "")
  const routes = ROUTE_ORDER.filter((route) => family.closeRoutes.includes(route))
    .map((route) => ROUTE_LABEL[route])
    .join(" + ")
  lines.push(
    `| ${index + 1} | \`${family.id}\`${family.exempt ? " *(exempt)*" : ""} | ${cell(family.purpose)} | ${readMatch} | ${actionMatch} | ${family.state} | ${cell(evidence)} | ${routes} |`
  )
})
lines.push("")

lines.push("## What each open family is waiting for")
lines.push("")
const open = block.families.filter(
  (family) => family.gap.trim() !== "" || family.verification.blockingTools.length > 0
)
for (const route of ROUTE_ORDER) {
  const waiting = open.filter((family) => family.closeRoutes.includes(route))
  if (waiting.length === 0) continue
  lines.push(`### ${ROUTE_LABEL[route]}`)
  lines.push("")
  for (const family of waiting) {
    lines.push(`- **\`${family.id}\`** (${family.state}) - ${cell(family.gap) || "evidence only"}`)
  }
  lines.push("")
}

lines.push("## Evidence pointers per family")
lines.push("")
for (const family of block.families) {
  lines.push(`### \`${family.id}\` - ${family.state}`)
  lines.push("")
  lines.push(`Purpose: ${cell(family.purpose)}`)
  lines.push("")
  lines.push(`Criterion to close: ${cell(family.gap) || "gap empty and every tool verified"}`)
  lines.push("")
  if (family.toolNames.length === 0) {
    lines.push(
      `Planned but unbuilt: ${family.missingToolNames.map((tool) => `\`${tool}\``).join(", ")}`
    )
    lines.push("")
    continue
  }
  lines.push("| Tool | Role | Status | Evidence |")
  lines.push("| ---- | ---- | ------ | -------- |")
  for (const tool of family.toolNames) {
    const entry = entries.get(tool)
    const role = family.actionTools.includes(tool)
      ? "action"
      : family.platformBlockedTools.includes(tool)
        ? "platform-blocked"
        : "read-only"
    lines.push(
      `| \`${tool}\` | ${role} | ${entry?.status ?? "unregistered"} | ${cell(evidenceOf(tool))} |`
    )
  }
  if (family.missingToolNames.length > 0) {
    lines.push("")
    lines.push(`Not built yet: ${family.missingToolNames.map((tool) => `\`${tool}\``).join(", ")}`)
  }
  lines.push("")
}

lines.push("## What this matrix cannot prove")
lines.push("")
lines.push(
  "- It cannot distinguish *helper not deployed* from *helper deployed but the tool was never called*:"
)
lines.push(
  "  both read as an unverified row. Deployment state lives in `docs/helper-capabilities-protocol.md`."
)
lines.push(
  "- A packaged build ships without `contracts/`, so every tool degrades to `unverified` there and"
)
lines.push(
  "  `registryLoaded` is false; the criterion then certifies nothing rather than guessing."
)
lines.push(
  "- `verified` means one real call succeeded and was recorded. It is a statement about evidence, not"
)
lines.push(
  "  about breadth: a verified tool may still be wrong beyond the case that was exercised."
)
lines.push("")

const markdown = `${lines.join("\n").replace(/\n+$/g, "")}\n`
const absolute = resolve(root, target)
const previous = (() => {
  try {
    return readFileSync(absolute, "utf8")
  } catch {
    return undefined
  }
})()

if (check) {
  if (previous === undefined) {
    console.error(`${target} is missing; run npm run ops:matrix:generate`)
    process.exit(1)
  }
  if (previous !== markdown) {
    console.error(`${target} is stale; run npm run ops:matrix:generate`)
    process.exit(1)
  }
  console.log(`${target} is current (${block.families.length} families)`)
} else {
  writeFileSync(absolute, markdown, "utf8")
  console.log(
    `wrote ${target}: ${block.families.length} families, ${summary.closedRequiredFamilyCount}/${summary.requiredEndToEndFamilyCount} required closed`
  )
}
