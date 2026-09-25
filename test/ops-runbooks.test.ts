/**
 * Guards for `docs/ops-runbooks.md` (OP4-2).
 *
 * The plan's acceptance criterion for OP4-2 is "the runbooks can run inside the `ops` profile".
 * That is only a claim until something checks it, so this test parses the manifest in the document
 * and asserts it against the live tool registry:
 *
 *   1. every tool a runbook uses resolves inside `ABAP_MCP_TOOL_PROFILE=ops` (resolved through the
 *      real profile resolver, not by reading the table twice);
 *   2. every tool is read-only, so no runbook can mutate SAP state;
 *   3. the manifest and the prose agree in both directions - a tool named in a runbook but missing
 *      from its manifest entry, or listed but never used, fails;
 *   4. all fifteen ops families are either covered by a runbook or listed with a written reason,
 *      and the two sets partition the family list exactly.
 *
 * The expectations are deliberately explicit (tool count, profile name, family partition): deriving
 * them from the same document would assert nothing.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { OPS_FAMILIES } from "../src/ops-coverage.js"
import { TOOL_NAMES, registryAnnotations, toolNamesForProfile } from "../src/tool-registry.js"
import { resolveToolProfile } from "../src/tool-profile.js"

const DOCUMENT = "docs/ops-runbooks.md"
const MANIFEST_START = "<!-- ops-runbooks:manifest:start -->"
const MANIFEST_END = "<!-- ops-runbooks:manifest:end -->"

interface RunbookEntry {
  id: string
  families: string[]
  tools: string[]
}

interface RunbookManifest {
  profile: string
  runbooks: RunbookEntry[]
  uncoveredFamilies: { id: string; reason: string }[]
}

const text = readFileSync(DOCUMENT, "utf8")

function manifest(): RunbookManifest {
  const start = text.indexOf(MANIFEST_START)
  const end = text.indexOf(MANIFEST_END)
  assert.ok(start >= 0 && end > start, "the runbook manifest markers must both be present")
  const block = text.slice(start + MANIFEST_START.length, end)
  const fenced = /```json\s*([\s\S]*?)```/.exec(block)
  assert.ok(fenced, "the manifest must be a fenced json block")
  return JSON.parse(fenced[1] ?? "") as RunbookManifest
}

/** The body of one runbook, from its heading to the next heading at the same or a higher level. */
function section(id: string): string {
  const start = text.indexOf(`### ${id}`)
  assert.ok(start >= 0, `runbook ${id} must have a "### ${id}" section`)
  const rest = text.slice(start)
  // Stop at the next `### ` runbook *or* the next `## ` section: without the second case the last
  // runbook would swallow the closing sections and inherit tool names that belong to them.
  const cuts = ["\n## ", "\n### "]
    .map((marker) => rest.indexOf(marker, 1))
    .filter((index) => index >= 0)
  const next = cuts.length ? Math.min(...cuts) : -1
  return next < 0 ? rest : rest.slice(0, next)
}

/** Tool names this document actually names, in backticks, inside the given runbook section. */
function toolsNamedIn(body: string): string[] {
  const named = new Set<string>()
  for (const match of body.matchAll(/`([a-z][a-z0-9_]{3,})`/g)) {
    const token = match[1]
    if (token && TOOL_NAMES.includes(token)) named.add(token)
  }
  return [...named].sort()
}

const parsed = manifest()

test("the runbook manifest describes the ops profile and only real runbooks", () => {
  assert.equal(parsed.profile, "ops")
  assert.ok(
    parsed.runbooks.length >= 6,
    `expected the main ops scenarios, found ${parsed.runbooks.length}`
  )
  const ids = parsed.runbooks.map((entry) => entry.id)
  assert.equal(new Set(ids).size, ids.length, "runbook ids must be unique")
  const familyIds = OPS_FAMILIES.map((family) => family.id)
  for (const entry of parsed.runbooks) {
    assert.ok(entry.families.length > 0, `${entry.id} must name the families it covers`)
    assert.ok(entry.tools.length > 0, `${entry.id} must name the tools it uses`)
    for (const family of entry.families) {
      assert.ok(familyIds.includes(family), `${entry.id} names unknown family ${family}`)
    }
  }
})

test("every runbook tool resolves inside the ops profile", () => {
  // The criterion is about the *resolved* surface, so resolve it the way the service does. A tool
  // that is ops-profile today but denied by configuration would still run, so only the profile is
  // asserted here; `ABAP_MCP_TOOL_DENY` is an operator overlay, not a property of the runbook.
  const state = resolveToolProfile({ ABAP_MCP_TOOL_PROFILE: "ops" })
  const opsTools = toolNamesForProfile("ops")
  for (const entry of parsed.runbooks) {
    for (const tool of entry.tools) {
      assert.ok(
        state.enabled.includes(tool),
        `${entry.id}: ${tool} is not enabled by the ops profile`
      )
      assert.ok(opsTools.includes(tool), `${entry.id}: ${tool} is not declared in the ops profile`)
    }
  }
})

test("every runbook tool is read-only", () => {
  for (const entry of parsed.runbooks) {
    for (const tool of entry.tools) {
      assert.ok(TOOL_NAMES.includes(tool), `${entry.id}: ${tool} is not a registered tool`)
      const annotations = registryAnnotations(tool)
      assert.equal(
        annotations.readOnlyHint,
        true,
        `${entry.id}: ${tool} is not read-only, but runbooks must not mutate SAP state`
      )
    }
  }
})

test("the two rules above can actually fail", () => {
  // Without this, both assertions would pass even if they were checking the wrong thing: the ops
  // profile really does contain write tools, and the tool registry really does contain tools outside
  // it, so "read-only" and "inside the ops profile" are filters with teeth rather than tautologies.
  const opsTools = toolNamesForProfile("ops")
  const writeTools = opsTools.filter((name) => registryAnnotations(name).readOnlyHint !== true)
  assert.ok(
    writeTools.length > 0,
    "the ops profile no longer exposes any write tool; the read-only rule has become vacuous"
  )
  assert.ok(
    opsTools.length < TOOL_NAMES.length,
    "every tool is in the ops profile; membership is vacuous"
  )
})

test("the manifest and the runbook prose name the same tools, in both directions", () => {
  for (const entry of parsed.runbooks) {
    const listed = [...entry.tools].sort()
    const named = toolsNamedIn(section(entry.id))
    assert.deepEqual(
      named,
      listed,
      `${entry.id}: tools named in prose and listed in the manifest disagree ` +
        `(prose-only: ${named.filter((x) => !listed.includes(x))}, manifest-only: ${listed.filter((x) => !named.includes(x))})`
    )
  }
})

test("the runbooks stay small enough to be read and re-run", () => {
  const distinct = new Set(parsed.runbooks.flatMap((entry) => entry.tools))
  // A tripwire, not a quality bar: growing this set means the runbooks cover more of the surface,
  // and that should be a deliberate edit rather than a side effect of adding steps somewhere.
  assert.ok(
    distinct.size <= 18,
    `runbooks name ${distinct.size} distinct tools; raise this bound deliberately`
  )
  for (const entry of parsed.runbooks) {
    const body = section(entry.id)
    assert.match(body, /\*\*停止条件\*\*/, `${entry.id} must state when to stop`)
    assert.match(body, /\*\*结论边界\*\*/, `${entry.id} must state what its result cannot prove`)
  }
})

test("all fifteen ops families are either covered or explicitly uncovered", () => {
  const familyIds = OPS_FAMILIES.map((family) => family.id)
  const covered = new Set(parsed.runbooks.flatMap((entry) => entry.families))
  const uncovered = new Set(parsed.uncoveredFamilies.map((entry) => entry.id))
  const overlap = [...covered].filter((family) => uncovered.has(family))
  assert.deepEqual(
    overlap,
    [],
    `families cannot be both covered and uncovered: ${overlap.join(", ")}`
  )
  const missing = familyIds.filter((family) => !covered.has(family) && !uncovered.has(family))
  assert.deepEqual(missing, [], `families neither covered nor justified: ${missing.join(", ")}`)
  assert.equal(covered.size + uncovered.size, familyIds.length)
  for (const entry of parsed.uncoveredFamilies) {
    assert.ok(familyIds.includes(entry.id), `uncovered entry ${entry.id} is not a family`)
    assert.ok(entry.reason.trim().length > 40, `uncovered family ${entry.id} needs a real reason`)
  }
})
