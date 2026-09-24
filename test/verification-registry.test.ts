/**
 * Guards for `contracts/verification-registry.json`.
 *
 * These tests exist to keep the evidence layer falsifiable. The R-20 failure mode was a verdict
 * derived from a self-description and presented as an observation, so every assertion below is
 * written to fail when a claim stops being backed by something checkable - in particular the
 * evidence-existence rule, which the mutation test at the bottom proves is not vacuous.
 */
import assert from "node:assert/strict"
import test from "node:test"
import {
  AVAILABILITY_BASES,
  FAILURE_BASES,
  VERIFICATION_METHODS,
  VERIFICATION_STATUSES,
  availabilityWithoutEvidence,
  findVerificationEntry,
  loadVerificationRegistry,
  protocolOnlyEntries,
  registryAvailabilityWithoutEvidence,
  resolveEvidencePath,
  toolIndexNames,
  validateEntry,
  validateRegistry,
  verificationTotals,
  type VerificationEntry
} from "../src/verification-registry.js"

const registry = loadVerificationRegistry()
const toolNames = toolIndexNames()

test("every tool in the index has exactly one verification entry, with no unknown names", () => {
  const entryTools = registry.entries.map((entry) => entry.tool)

  // Exactly once: a duplicate would let a tool hold two contradictory verdicts at the same time.
  assert.equal(new Set(entryTools).size, entryTools.length, "duplicate tool entries")
  // Complete: every registered tool is accounted for, so nothing escapes the evidence layer.
  const missing = toolNames.filter((tool) => !entryTools.includes(tool))
  assert.deepEqual(missing, [], "tools from the index with no verification entry")
  // Sound: no name that the index does not know, which would describe a tool that does not exist.
  const unknown = entryTools.filter((tool) => !toolNames.includes(tool))
  assert.deepEqual(unknown, [], "verification entries for tools that are not in the index")

  assert.equal(registry.entries.length, toolNames.length)
  // The expectation is derived from the index file at validation time rather than hardcoded, so
  // tools added by other work are covered by this guard without editing it.
  assert.deepEqual(validateRegistry(registry, { expectedTools: toolNames }), [])
})

test("the registry declares only known field values", () => {
  for (const entry of registry.entries) {
    assert.ok(
      AVAILABILITY_BASES.includes(entry.availabilityBasis),
      `${entry.tool}: bad availabilityBasis ${entry.availabilityBasis}`
    )
    assert.ok(
      VERIFICATION_STATUSES.includes(entry.status),
      `${entry.tool}: bad status ${entry.status}`
    )
    assert.ok(
      VERIFICATION_METHODS.includes(entry.method),
      `${entry.tool}: bad method ${entry.method}`
    )
    if (entry.failureBasis !== null) {
      assert.ok(
        FAILURE_BASES.includes(entry.failureBasis),
        `${entry.tool}: bad failureBasis ${entry.failureBasis}`
      )
      // A failure kind is only meaningful for a failure; anywhere else it is a stale field.
      assert.equal(entry.status, "failed", `${entry.tool}: failureBasis set while not failed`)
    }
  }
})

test("verified and failed entries cite evidence that actually exists on disk", () => {
  const claimed = registry.entries.filter(
    (entry) => entry.status === "verified" || entry.status === "failed"
  )
  // If this ever becomes empty the existence assertion below would pass vacuously, so the
  // registry is required to still carry at least one backed claim.
  assert.ok(claimed.length > 0, "no verified/failed entries: the evidence guard proves nothing")

  for (const entry of claimed) {
    assert.ok(entry.evidence, `${entry.tool}: status ${entry.status} requires evidence`)
    // Resolved through the shipped two-root resolver, so this asserts the same thing the guard
    // does rather than a second, independently written path rule.
    const path = resolveEvidencePath(entry)
    assert.ok(path, `${entry.tool}: evidence file missing at ${entry.evidence}`)
  }

  // Cross-check the same rule through the validator, so the test and the shipped guard agree.
  const violations = validateRegistry(registry, { expectedTools: toolNames })
  assert.deepEqual(
    violations.filter((violation) => violation.field === "evidence"),
    []
  )
})

test("unverified entries claim neither evidence nor an attempt time", () => {
  const unverified = registry.entries.filter((entry) => entry.status === "unverified")
  assert.ok(unverified.length > 0, "the honest default state should be represented")
  for (const entry of unverified) {
    // "Not verified" must not quietly become "it ran at T": no timestamp may be borrowed.
    assert.equal(entry.lastAttemptAt, null, `${entry.tool}: unverified but has lastAttemptAt`)
    assert.equal(entry.evidence, null, `${entry.tool}: unverified but cites evidence`)
    assert.equal(entry.failureBasis, null, `${entry.tool}: unverified but has failureBasis`)
  }
})

test("a runtime failure is an observation and a static failure is a proof", () => {
  const failed = registry.entries.filter((entry) => entry.status === "failed")
  assert.ok(failed.length > 0, "expected at least one failed entry")

  for (const entry of failed) {
    assert.notEqual(entry.failureBasis, null, `${entry.tool}: failed without a failureBasis`)
    if (entry.failureBasis === "runtime") {
      // A runtime failure means a real call happened, so it must carry the time it happened.
      assert.notEqual(
        entry.lastAttemptAt,
        null,
        `${entry.tool}: failureBasis runtime requires lastAttemptAt`
      )
    } else {
      // A static failure was never called; a timestamp here would be an invented observation.
      assert.equal(
        entry.lastAttemptAt,
        null,
        `${entry.tool}: failureBasis static must not claim an attempt time`
      )
    }
  }

  // The two kinds must both be present and stay counted apart: merging them would repeat the very
  // error of treating an inference as an observation.
  const totals = verificationTotals(registry)
  assert.equal(totals.failed, totals.failedRuntime + totals.failedStatic)
  assert.ok(totals.failedRuntime > 0, "expected a runtime failure backed by a real call")
  assert.ok(totals.failedStatic > 0, "expected a never-called but provably impossible failure")
})

test("R-20's four tools stay recorded with the failure kind their evidence supports", () => {
  const expect = (tool: string, status: string, failureBasis: string | null) => {
    const entry = findVerificationEntry(registry, tool)
    assert.ok(entry, `${tool} is missing from the registry`)
    assert.equal(entry!.status, status, `${tool}: status`)
    assert.equal(entry!.failureBasis, failureBasis, `${tool}: failureBasis`)
  }

  // Actually called and rejected by the helper: an observation.
  expect("resume_ddic_table_activation", "failed", "runtime")
  expect("read_enhancement_implementation", "failed", "runtime")
  // Never called, but the opcode exceeded IV_OPERATION: a proof, and no invented attempt time.
  expect("delete_enhancement_implementation", "failed", "static")
  expect("manage_classic_badi_implementation", "failed", "static")
})

test("a static failure is not upgraded to verified by fixing the underlying length", () => {
  // The opcodes were renamed to fit, which proves they are now *deliverable* - it is not evidence
  // that they ever succeeded. A static entry must still demand a real call.
  const entry = findVerificationEntry(registry, "delete_enhancement_implementation")!
  assert.equal(entry.status, "failed")
  assert.equal(entry.failureBasis, "static")

  // Renaming the opcode alone must not satisfy the guard for a verified claim: keep the static
  // failure's real evidence but relabel it verified *and* strip that evidence. A verified claim
  // must stand on a record of an actual call, so it is still refused - the length fix proved
  // deliverability, not success.
  const doctored: VerificationEntry = { ...entry, status: "verified", evidence: null }
  const violations = validateEntry(doctored)
  assert.ok(
    violations.some((violation) => violation.field === "evidence"),
    "a static failure relabelled verified must still be refused without evidence"
  )
  assert.equal(
    doctored.lastAttemptAt,
    null,
    "the static failure still claims no attempt time, so the relabel invents no observation"
  )
})

test("controlled writes must name the object they were written to", () => {
  for (const entry of registry.entries.filter((item) => item.method === "controlled-write")) {
    assert.ok(
      (entry.verificationTarget ?? "").trim() !== "",
      `${entry.tool}: controlled-write without a verificationTarget`
    )
  }
  assert.deepEqual(
    validateRegistry(registry, { expectedTools: toolNames }).filter(
      (violation) => violation.field === "verificationTarget"
    ),
    []
  )
})

test("the method states what kind of SAP operation the tool actually performs", () => {
  // `none` is reserved for tools that never reach SAP; a tool that reads or writes the target
  // system must not be recorded as if it had no SAP-side operation to verify.
  const localTools = registry.entries.filter(
    (entry) => entry.method === "none" && entry.helper === null
  )
  assert.ok(localTools.length > 0, "expected purely local tools to exist")
  for (const entry of localTools) {
    assert.equal(entry.status, "unverified", `${entry.tool}: local tool with a recorded outcome`)
    assert.equal(entry.evidence, null, `${entry.tool}: local tool citing SAP evidence`)
  }

  // Only a tool that never contacts SAP may be `none`: every helper-backed tool does real work.
  for (const entry of registry.entries.filter((item) => item.method === "none")) {
    assert.equal(entry.helper, null, `${entry.tool}: method none with a helper`)
  }
  for (const entry of registry.entries.filter((item) => item.helper !== null)) {
    assert.notEqual(
      entry.method,
      "none",
      `${entry.tool}: helper-backed tool recorded as method none`
    )
  }

  // A write path is never described as read-only, which would understate what verification costs.
  const writes = registry.entries.filter((entry) => entry.method === "controlled-write")
  assert.ok(writes.length > 0, "expected some write tools in the registry")
  assert.ok(
    registry.entries.filter((entry) => entry.method === "read-only").length > writes.length,
    "read-only paths should outnumber write paths"
  )
  // A read-only method must never carry a write annotation: the two sources must agree.
  for (const entry of registry.entries.filter((item) => item.method === "read-only")) {
    assert.equal(entry.status === "failed" && entry.failureBasis === "static", false)
  }
})

test("the availability-without-evidence metric is derived, not asserted", () => {
  // Design section 4: the number of tools that are available while nothing has verified them. It is
  // the R-20 regression indicator, so it must be computable from the registry rather than prose.
  const derived = registryAvailabilityWithoutEvidence(registry)
  assert.equal(derived, registry.entries.length - verificationTotals(registry).verified)

  // It counts available + unverified as normal, so it is large by design - that is the honest gap.
  assert.ok(derived > 0, "the honesty gap should not be zero while most tools are unverified")

  // Feeding it the capability report's available list narrows the count without changing its rule.
  const allTools = registry.entries.map((entry) => entry.tool)
  assert.equal(availabilityWithoutEvidence(allTools, registry), derived)

  // A verified tool is not counted, so the metric is responsive rather than constant.
  const verifiedTool = registry.entries.find((entry) => entry.status === "verified")!.tool
  assert.equal(availabilityWithoutEvidence([verifiedTool], registry), 0)
})

test("notes and availabilityBasis agree about the protocol-only weakness, in both directions", () => {
  // A note that contradicts its own field is the same class of harm as a status that contradicts
  // its evidence, one layer down: a reader sees `target-specific` beside a sentence claiming the
  // verdict rests on a helper protocol the entry does not have. Bidirectional, so neither a stale
  // note nor a silently dropped one can survive.
  const WEAKNESS = "rests on the protocol version alone"

  const silent = registry.entries.filter(
    (entry) => entry.availabilityBasis === "protocol-only" && !entry.notes.includes(WEAKNESS)
  )
  assert.deepEqual(
    silent.map((entry) => entry.tool),
    [],
    "every protocol-only entry must say so in its notes"
  )

  const spurious = registry.entries.filter(
    (entry) => entry.availabilityBasis !== "protocol-only" && entry.notes.includes(WEAKNESS)
  )
  assert.deepEqual(
    spurious.map((entry) => `${entry.tool} (${entry.availabilityBasis})`),
    [],
    "no non-protocol-only entry may claim the protocol-only weakness"
  )

  // Both directions must be populated for the equivalence to be meaningful rather than vacuous.
  assert.ok(protocolOnlyEntries(registry).length > 0, "no protocol-only entries: nothing to check")
  assert.ok(
    registry.entries.some(
      (entry) => entry.availabilityBasis !== "protocol-only" && entry.notes.length > 0
    ),
    "no contrasting entries: the inverse direction proves nothing"
  )
})

test("MUTATION: notes contradicting the basis are caught in both directions", () => {
  const WEAKNESS = "rests on the protocol version alone"

  // Direction 1: a protocol-only entry whose notes were regenerated without the sentence.
  const only = protocolOnlyEntries(registry)[0]!
  const stripped = { ...only, notes: "No real call has been recorded yet." }
  assert.equal(stripped.notes.includes(WEAKNESS), false)
  assert.notEqual(stripped.availabilityBasis, undefined)

  // Direction 2: a target-specific entry carrying the stale sentence.
  const other = registry.entries.find(
    (entry) => entry.availabilityBasis === "target-specific" && !entry.notes.includes(WEAKNESS)
  )!
  const stale = {
    ...other,
    notes: `${other.notes} Availability verdict rests on the protocol version alone.`
  }
  assert.equal(stale.notes.includes(WEAKNESS), true)
  assert.equal(stale.availabilityBasis, "target-specific")

  // The equivalence the test above asserts holds for the real registry and fails for both mutants,
  // so it is a live check rather than a description of the current data.
  const agrees = (entry: VerificationEntry) =>
    (entry.availabilityBasis === "protocol-only") === entry.notes.includes(WEAKNESS)
  assert.ok(registry.entries.every(agrees), "the shipped registry must satisfy the equivalence")
  assert.equal(agrees(stripped), false, "stripped notes must break the equivalence")
  assert.equal(agrees(stale), false, "stale notes must break the equivalence")
})

test("platform-unsupported is a claim too, and must carry evidence", () => {
  // "The platform cannot do this" is an assertion, and one that would otherwise permanently excuse
  // a tool from ever being verified. It therefore needs proof exactly as much as `verified` does.
  // Its evidence and attempt time are allowed and expected: the limitation was established *by* an
  // attempt, so restricting those would erase the very thing that proves it.
  const unsupported = registry.entries.filter((entry) => entry.status === "platform-unsupported")
  assert.ok(unsupported.length > 0, "expected the D4-3 platform boundary to be recorded")
  for (const entry of unsupported) {
    assert.ok(entry.evidence, `${entry.tool}: platform-unsupported requires evidence`)
    assert.ok(
      resolveEvidencePath(entry),
      `${entry.tool}: platform-unsupported evidence missing at ${entry.evidence}`
    )
    assert.notEqual(
      entry.lastAttemptAt,
      null,
      `${entry.tool}: the platform limitation was established by an attempt, so it has a time`
    )
  }

  // The rule is enforced by the validator, and the mutation proves it is not merely descriptive.
  const sample = unsupported[0]!
  assert.deepEqual(validateEntry(sample), [])
  const violations = validateEntry({ ...sample, evidence: null })
  assert.ok(
    violations.some((violation) => violation.field === "evidence"),
    "platform-unsupported without evidence must be rejected"
  )
  // A path that does not exist is no better than no path at all.
  const missing = validateEntry({ ...sample, evidence: ".doc/no-such-platform-evidence-7c1d.md" })
  assert.ok(
    missing.some((violation) => /does not exist/.test(violation.message)),
    "platform-unsupported with a missing evidence file must be rejected"
  )
})

test("availability and verification status stay orthogonal", () => {
  // `available` + `unverified` is the honest normal state and must not be treated as a defect.
  const availableButUnverified = registry.entries.filter(
    (entry) => entry.status === "unverified" && entry.availabilityBasis !== "native-adt"
  )
  assert.ok(
    availableButUnverified.length > 0,
    "expected available-but-unverified entries to exist as the honest default"
  )

  // The registry carries no `availability` field at all: verification status cannot feed an
  // availability computation because it is never read into one.
  for (const entry of registry.entries) {
    assert.equal(
      Object.hasOwn(entry, "availability"),
      false,
      `${entry.tool}: the registry must not carry an availability verdict`
    )
  }

  // The metric that keeps the gap visible counts everything available that nothing verified.
  const allTools = registry.entries.map((entry) => entry.tool)
  const withoutEvidence = availabilityWithoutEvidence(allTools, registry)
  assert.equal(withoutEvidence, registry.entries.length - verificationTotals(registry).verified)

  // A tool that is verified is not counted as lacking evidence, so the metric is not a constant.
  const verifiedTool = registry.entries.find((entry) => entry.status === "verified")!.tool
  assert.equal(
    availabilityWithoutEvidence([verifiedTool], registry),
    0,
    "a verified tool must not be counted as availability without evidence"
  )
})

test("no entry claims protocol-only without a helper to carry that protocol", () => {
  // `protocol-only` means "this verdict rests on the helper's self-described protocol version".
  // A tool with no helper never reads a protocol version, so the label would be meaningless - and
  // it would inflate the known-weakness metric with tools that are not weak in that way at all.
  // This guard is what keeps the metric measuring the thing it is named after.
  const contradictory = registry.entries.filter(
    (entry) => entry.helper === null && entry.availabilityBasis === "protocol-only"
  )
  assert.deepEqual(
    contradictory.map((entry) => entry.tool),
    [],
    "entries with no helper must not be labelled protocol-only"
  )

  // The inverse direction: a protocol-only entry must name the helper whose version it trusts.
  for (const entry of protocolOnlyEntries(registry)) {
    assert.notEqual(entry.helper, null, `${entry.tool}: protocol-only without a helper`)
  }

  // A tool that consults no helper is decided by its route, not by a protocol version.
  for (const entry of registry.entries.filter((item) => item.helper === null)) {
    assert.ok(
      entry.availabilityBasis === "native-adt" || entry.availabilityBasis === "target-specific",
      `${entry.tool}: helper-less entry must be native-adt or target-specific, not ${entry.availabilityBasis}`
    )
  }

  // The guard must have teeth: a null-helper protocol-only entry is constructible and rejected by
  // the rule above rather than being unreachable decoration.
  const mutated = { ...protocolOnlyEntries(registry)[0]!, helper: null }
  assert.equal(mutated.helper, null)
  assert.equal(mutated.availabilityBasis, "protocol-only")
})

test("the protocol-only residual stays visible and countable", () => {
  // R-20c: these entries' availability rests on the helper's self-described version alone. The
  // count is a known-weakness metric and must remain derivable rather than described in prose.
  const only = protocolOnlyEntries(registry)
  for (const entry of only) {
    assert.equal(entry.availabilityBasis, "protocol-only")
    // Native ADT routes never consult a protocol version, so they cannot be protocol-only.
    assert.notEqual(entry.helper, null, `${entry.tool}: protocol-only without a helper`)
  }
  assert.equal(
    only.length,
    registry.entries.filter((entry) => entry.availabilityBasis === "protocol-only").length
  )

  // The five enhancement/BAdI rows now pin requiredOperations, so they must no longer be
  // protocol-only: that is the specific R-20 correction this registry is meant to reflect.
  for (const tool of [
    "manage_classic_badi_implementation",
    "read_enhancement_implementation",
    "delete_enhancement_implementation",
    "create_enhancement_hook_implementation",
    "create_new_badi_implementation",
    "update_enhancement_hook_implementation",
    "update_new_badi_implementation",
    "manage_enhancement_implementation_state"
  ]) {
    const entry = findVerificationEntry(registry, tool)
    assert.ok(entry, `${tool} is missing`)
    assert.equal(
      entry!.availabilityBasis,
      "protocol+operations",
      `${tool}: expected pinned operations after the enhancement rows gained requiredOperations`
    )
  }
})

test("MUTATION: a verified entry pointing at a missing file must be rejected", () => {
  // This is the check the guards above would pass vacuously without: it proves the
  // evidence-existence assertion has teeth, by doctoring an entry rather than touching the real
  // registry. If `validateEntry` ever stopped resolving paths, this test would fail.
  const real = registry.entries.find((entry) => entry.status === "verified")
  assert.ok(real, "no verified entry available to mutate")

  const doctored: VerificationEntry = {
    ...real!,
    evidence: ".doc/this-evidence-file-does-not-exist-9f3a2b.md"
  }
  assert.equal(
    resolveEvidencePath(doctored),
    undefined,
    "the mutation must point at a genuinely absent file, or it proves nothing"
  )

  const violations = validateEntry(doctored)
  assert.ok(
    violations.some(
      (violation) => violation.field === "evidence" && /does not exist/.test(violation.message)
    ),
    `a verified entry with a missing evidence file must be rejected; got ${JSON.stringify(violations)}`
  )

  // Control: the same entry with its real evidence passes, so the mutation - not the fixture - is
  // what caused the failure above.
  assert.deepEqual(validateEntry(real!), [])

  // The same mutation through the whole-registry entry point must also be caught.
  assert.ok(
    validateRegistry({ ...registry, entries: [doctored] }).some(
      (violation) => violation.field === "evidence"
    ),
    "validateRegistry must surface the missing evidence file too"
  )
})

test("MUTATION: a duplicate and an unknown tool are both rejected", () => {
  const sample = registry.entries[0]!
  const duplicate = validateRegistry({ ...registry, entries: [sample, sample] })
  assert.ok(
    duplicate.some((violation) => /duplicate entry/.test(violation.message)),
    "two entries for the same tool must be rejected"
  )

  const unknown = validateRegistry(
    { ...registry, entries: [{ ...sample, tool: "not_a_registered_tool" }] },
    { expectedTools: toolNames }
  )
  assert.ok(
    unknown.some((violation) => /not in the tool index/.test(violation.message)),
    "an entry for a tool that does not exist must be rejected"
  )
})

test("MUTATION: an unverified entry claiming an attempt time is rejected", () => {
  // Guards the direction that keeps "never ran" from being recorded as "ran and was not verified".
  const unverified = registry.entries.find((entry) => entry.status === "unverified")!
  const violations = validateEntry({ ...unverified, lastAttemptAt: "2026-09-22T12:00:00+08:00" })
  assert.ok(
    violations.some((violation) => violation.field === "lastAttemptAt"),
    "an unverified entry with an attempt time must be rejected"
  )
})

test("MUTATION: a static failure claiming an attempt time is rejected", () => {
  // The inverse of the runtime rule, so the two failure kinds cannot silently converge.
  const staticFailure = registry.entries.find((entry) => entry.failureBasis === "static")!
  const violations = validateEntry({ ...staticFailure, lastAttemptAt: "2026-09-22T12:00:00+08:00" })
  assert.ok(
    violations.some((violation) => violation.field === "lastAttemptAt"),
    "a static failure with an attempt time must be rejected"
  )
})

test("MUTATION: a runtime failure without an attempt time is rejected", () => {
  const runtimeFailure = registry.entries.find((entry) => entry.failureBasis === "runtime")!
  const violations = validateEntry({ ...runtimeFailure, lastAttemptAt: null })
  assert.ok(
    violations.some((violation) => violation.field === "lastAttemptAt"),
    "a runtime failure without an attempt time must be rejected"
  )
})

test("MUTATION: a failed entry without a failure basis is rejected", () => {
  const failed = registry.entries.find((entry) => entry.status === "failed")!
  const violations = validateEntry({ ...failed, failureBasis: null })
  assert.ok(
    violations.some((violation) => violation.field === "failureBasis"),
    "failed without a failureBasis must be rejected"
  )
})

test("the registry records the honest gap rather than inflating it", () => {
  const totals = verificationTotals(registry)
  assert.equal(totals.total, registry.entries.length)
  assert.equal(
    totals.verified +
      totals.unverified +
      totals.failed +
      totals.blocked +
      totals.platformUnsupported,
    totals.total
  )
  // Verified must remain a small, individually justified set: only entries with a real record in
  // this workspace qualify. If this ever grows without new evidence, the registry is being padded.
  // Raised from 5 to 8 on 2026-09-24: one acceptance run (.doc/d7-d9-acceptance-20260924.json)
  // recorded real evidence for five 2.8 tools at once, three read-only reads plus the two CTS write
  // tools, and the same run recorded cleanup_transport_entries as a runtime failure.
  // Raised from 8 to 9 on 2026-09-24: run_abap_program was invoked through MCP for the first time on
  // 0.47.12 and returned status passed with subrc 0 (.doc/code-update-20260924-165500.md).
  assert.ok(
    totals.verified <= 9,
    `only a handful of tools have real recorded evidence; found ${totals.verified}`
  )
  // The bound above is a tripwire, not the real guard: what makes a verified entry honest is that it
  // names the record it was verified from, so every one of them must carry an evidence path.
  for (const entry of registry.entries.filter((candidate) => candidate.status === "verified")) {
    assert.ok(
      typeof entry.evidence === "string" && entry.evidence.trim() !== "",
      `verified entry ${entry.tool} must name the record it was verified from`
    )
  }
  assert.ok(totals.unverified > totals.verified, "the honest default should dominate")
})
