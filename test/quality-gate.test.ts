import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import {
  QUALITY_GATE_NOT_EVALUATED,
  QUALITY_GATE_REASON_NOT_A_QUALITY_GATE,
  QUALITY_GATE_REASON_NOT_NATIVE_ATC,
  QUALITY_GATE_REASON_NOT_RUN,
  QUALITY_GATE_REASON_NO_GATE_VERDICT,
  qualityGateNotEvaluated,
  type QualityGateReason
} from "../src/quality-gate.js"

// Repository-relative, matching the other source-scanning tests in this suite: `npm test` runs from
// the package root. Resolving this against `import.meta.url` would land in `dist/`, which holds no
// TypeScript sources, and the scan would silently pass over nothing.
const SOURCE_DIRECTORY = "src"
const GATE_MODULE = "quality-gate.ts"

const sourceFiles = readdirSync(SOURCE_DIRECTORY)
  .filter((name) => name.endsWith(".ts"))
  .map((name) => ({ name, text: readFileSync(join(SOURCE_DIRECTORY, name), "utf8") }))

test("a gate value is never emitted without its reason", () => {
  // The whole point of the pair: `not_evaluated` on its own reads as a pass to a caller that does
  // not know why it is unevaluated, so the two fields travel together.
  const paired = qualityGateNotEvaluated(QUALITY_GATE_REASON_NOT_RUN)
  assert.deepEqual(paired, { qualityGate: "not_evaluated", gateReason: "not_run" })
  assert.equal(QUALITY_GATE_NOT_EVALUATED, "not_evaluated")

  const vocabulary: QualityGateReason[] = [
    QUALITY_GATE_REASON_NOT_RUN,
    QUALITY_GATE_REASON_NOT_NATIVE_ATC,
    QUALITY_GATE_REASON_NO_GATE_VERDICT,
    QUALITY_GATE_REASON_NOT_A_QUALITY_GATE
  ]
  assert.deepEqual(vocabulary, [
    "not_run",
    "not_native_atc",
    "no_gate_verdict",
    "not_a_quality_gate"
  ])
  for (const reason of vocabulary) {
    assert.equal(qualityGateNotEvaluated(reason).gateReason, reason)
  }
})

test("every quality gate in the service carries an explicit reason", () => {
  const offenders: string[] = []
  let unpairedSites = 0
  let pairedSites = 0
  for (const { name, text } of sourceFiles) {
    if (name === GATE_MODULE) continue
    const lines = text.split("\n")
    lines.forEach((line, index) => {
      // The spread form carries both fields by construction and needs no adjacency check.
      if (line.includes("...qualityGateNotEvaluated(")) {
        pairedSites++
        return
      }
      if (!line.includes("qualityGate:")) return
      unpairedSites++
      // The reason must be part of the same object literal, either on this line or within the next
      // three, which covers the multi-line `qualityGate:` / `gateReason:` pairings.
      const window = lines.slice(index, index + 4).join("\n")
      if (!window.includes("gateReason")) offenders.push(`${name}:${index + 1}`)
    })
  }
  assert.deepEqual(offenders, [], "qualityGate without a nearby gateReason")
  // Guard the guard: a refactor that renames the field must not silently empty this check. Both
  // forms are counted, so a site converted from one to the other cannot hide behind the minimum.
  assert.ok(
    unpairedSites + pairedSites >= 9,
    `expected at least 9 quality gate sites, found ${unpairedSites + pairedSites}`
  )
  assert.ok(pairedSites >= 2, `expected the SCI spread form at least twice, found ${pairedSites}`)
})

test("the not_evaluated literal lives only in the shared gate module", () => {
  // Call sites must go through the typed helpers, so the vocabulary cannot drift one literal at a
  // time. Scoped to `qualityGate` on purpose: `executionAuthorized` has its own unrelated literal.
  const offenders = sourceFiles
    .filter(({ name }) => name !== GATE_MODULE)
    .filter(({ text }) => /qualityGate:\s*"not_evaluated"/.test(text))
    .map(({ name }) => name)
  assert.deepEqual(offenders, [])
})
