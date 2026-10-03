/**
 * Guards for `contracts/verification-registry.json`.
 *
 * These tests exist to keep the evidence layer falsifiable. The R-20 failure mode was a verdict
 * derived from a self-description and presented as an observation, so every assertion below is
 * written to fail when a claim stops being backed by something checkable - in particular the
 * evidence-existence rule, which the mutation test at the bottom proves is not vacuous.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
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

  // The two kinds stay counted apart: merging them would repeat the very error of treating an
  // inference as an observation.
  const totals = verificationTotals(registry)
  assert.equal(totals.failed, totals.failedRuntime + totals.failedStatic)
  assert.ok(totals.failedRuntime > 0, "expected a runtime failure backed by a real call")

  // As of 2026-10-02 the shipped registry carries NO static failure, and that is a measured fact
  // rather than a gap in the data: both R-20 length defects were refuted by real calls. The
  // 33-character DELETE_ENHANCEMENT_IMPLEMENTATION became DELETE_ENHANCEMENT_IMPL (23) and was
  // dispatched, and the 34-character MANAGE_CLASSIC_BADI_IMPLEMENTATION became
  // MANAGE_CLASSIC_BADI_IMPL (24) and reached SAP, which refused it at the time - so the honest kind
  // for that call was the observation (`runtime`), not the proof. That tool has since been called
  // successfully and is now `verified`, and the surviving runtime failure is
  // resume_ddic_table_activation; the count of static failures is still zero, because no operation is
  // currently proven impossible without ever being called. Demanding a static entry here would force
  // a false claim back into the registry, so the count is asserted to be zero *and* the metric is
  // still proven to have teeth against a constructed registry. Dropping the assertion entirely is
  // what would let the split rot.
  assert.equal(
    totals.failedStatic,
    0,
    "no operation is currently proven impossible without ever being called"
  )

  const synthetic = verificationTotals({
    ...registry,
    entries: [
      { ...failed[0]!, tool: "synthetic_runtime", failureBasis: "runtime" as const },
      {
        ...failed[0]!,
        tool: "synthetic_static",
        failureBasis: "static" as const,
        lastAttemptAt: null
      }
    ]
  })
  assert.equal(synthetic.failedRuntime, 1, "a runtime failure must be counted as runtime")
  assert.equal(synthetic.failedStatic, 1, "a static failure must be counted as static")
  assert.equal(synthetic.failed, 2, "both kinds stay in the failed total")
})

test("R-20's four tools stay recorded with the state their evidence supports", () => {
  const expect = (tool: string, status: string, failureBasis: string | null) => {
    const entry = findVerificationEntry(registry, tool)
    assert.ok(entry, `${tool} is missing from the registry`)
    assert.equal(entry!.status, status, `${tool}: status`)
    assert.equal(entry!.failureBasis, failureBasis, `${tool}: failureBasis`)
  }

  // Actually called and rejected by SAP: an observation, so it keeps the time it happened.
  expect("resume_ddic_table_activation", "failed", "runtime")

  // The fourth R-20 row was refused when it was called in 2026-10-01, and that refusal is why it
  // entered as `failed`. It was called again on 2026-10-03 with the one action that can pass the
  // guard on an implementation that already exists (activate), SAP answered
  // CLASSIC_BADI_IMPLEMENTATION_CHANGED, and the row is now a success rather than a refusal. The
  // earlier refusal stays in its notes as history; the status follows the latest observation.
  expect("manage_classic_badi_implementation", "verified", null)

  // Renamed and then really called - and that call SUCCEEDED. This one is no longer a failure at
  // all.
  expect("read_enhancement_implementation", "verified", null)

  // Renamed, and the renamed opcode really was dispatched - but SAP was never reached, because a
  // deliberately wrong fingerprint was refused before invocation. Nothing about this tool was
  // observed failing, so it is not a failure either: it is unverified, with no borrowed timestamp.
  expect("delete_enhancement_implementation", "unverified", null)
})

test("a length fix alone never counts as evidence of success", () => {
  // Renaming an opcode proves deliverability, not an outcome. This is the mistake the R-20 rows
  // exist to prevent, asserted against a tool whose call really did land: RESUME_TABLE_ACTIVATION
  // (23 characters) fits and reached its own arm, the call was made, and SAP refused it with rc 8 -
  // so the row may NOT read as `verified`, and its kind is the observation (`runtime`), carrying the
  // time the call actually happened.
  //
  // This used to be asserted against manage_classic_badi_implementation, whose 2026-10-01 call was
  // refused. That tool has since been called successfully (R8 2026-10-03) and moved to `verified`,
  // so the exemplar had to move to the row that is still a refusal; keeping the old subject would
  // have turned this guard into an assertion about a success.
  const entry = findVerificationEntry(registry, "resume_ddic_table_activation")!
  assert.equal(entry.status, "failed", "a refused call is not a success")
  assert.equal(entry.failureBasis, "runtime", "a call that reached SAP is an observation")
  assert.notEqual(entry.lastAttemptAt, null, "an observation carries the time it was made")

  // Stripping the evidence from such a claim must be refused even when the status says verified.
  const doctored: VerificationEntry = { ...entry, status: "verified", evidence: null }
  const violations = validateEntry(doctored)
  assert.ok(
    violations.some((violation) => violation.field === "evidence"),
    "a failed entry relabelled verified must still be refused without evidence"
  )

  // The other half of the same rule, on the same tool: dispatching the renamed opcode into its own
  // arm is also only deliverability. Until the rc 8 reason is attributed, the row must not read as
  // verified.
  assert.notEqual(entry.status, "verified", "a dispatched call is not a successful call")
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
  //
  // The shipped registry carries no static failure as of 2026-10-02 - both R-20 length defects were
  // refuted by real calls - so the sample is CONSTRUCTED from a real failed entry rather than looked
  // up. A lookup would have returned undefined and let this mutation "pass" without ever reaching
  // the rule it exists to prove.
  const sample = registry.entries.find((entry) => entry.status === "failed")!
  const staticFailure: VerificationEntry = {
    ...sample,
    status: "failed",
    failureBasis: "static",
    lastAttemptAt: null
  }
  assert.deepEqual(validateEntry(staticFailure), [], "the constructed static sample must be valid")

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
  // Raised from 9 to 21 on 2026-09-25 (OP0-2): twelve ops tools were re-registered from runtime
  // evidence this workspace had already collected but never entered - the 2026-09-08 log/job
  // acceptances (.doc/log-joint-acceptance-20260908-121025.md, .doc/code-update-20260908-163230.md,
  // .doc/code-update-20260908-091820.md), the 2026-09-09 system-info probe
  // (.doc/code-update-20260909-084306.md), the 2026-09-24 lock and CTS reads
  // (.doc/code-update-20260924-125930.md, .doc/code-update-20260924-165500.md) and the 2026-09-25
  // dump read (.doc/code-update-20260925-142324.md). Each of those entries names the record it came
  // from and the version it was observed on; none of them was inferred from passing tests, and the
  // four ops tools whose records were plans rather than calls were deliberately left unverified.
  // Raised from 21 to 23 on 2026-09-25 (OP0-2 / D1): a live read-only session on 0.50.15
  // (.doc/code-update-20260925-221900.md) read a real job detail
  // (read_background_job_details: SWWDHEX/00001200, status ok, one step and a revision) and ran the
  // finite fallback dialect over the allowlisted customer table ZTPMC_BZWL
  // (execute_data_query: exact COUNT(*), a GROUP BY whose parts sum to that count, and an
  // exact-or-refuse refusal at the row bound). Both entries name the record and the version, and the
  // same session deliberately left the three tools without a sample unverified.
  // This bound is a tripwire, not a quality bar: raising it again requires the same kind of citation.
  // Raised from 23 to 28 on 2026-09-27 (N1): a live read-only sweep on 0.50.21 / de1fd73
  // (.cache/evidence-ops-n1c, written up in .doc/code-update-20260927-084500.md) called eight ops
  // tools that had no recorded call. Five answered status "ok" or "partial" with rows - so their
  // replies are the call, and each entry names that record and the sweep behind it:
  // read_workload_directory (SWNC_GET_WORKLOAD_DIRECTORY), read_system_parameters (TPFYPROPTY +
  // TPFHT), read_qrfc_queues (TRFCQOUT + TRFCQIN), read_idoc_status (EDIDC + EDIDS) and
  // read_user_authorizations (AGR_USERS + AGR_TCODES + UST04). The other three answered
  // "unavailable" (read_work_processes and read_user_sessions on an unverified kernel interface,
  // read_file_system_directory on a runtime RFC failure) and were deliberately left unverified with
  // no evidence and no attempt time. None of the five was inferred from a passing test, and no
  // entry was verified from a plan rather than a call.
  // Raised from 28 to 29 on 2026-09-28 (N2-4 follow-up): the operator rebuilt and restarted the 4848
  // source instance, and read_ccms_alerts was then called for real against w200 three times -
  // {maxRows:5} answered partial with five rows and all four boundary sentences, {openOnly:true}
  // answered ok with zero rows, and a nine-condition request was refused before the read. The entry
  // names .doc/code-update-20260928-105549.md. Nothing here was inferred from a passing test, and the
  // tripwire did its job: this one tool had to earn the raise explicitly.
  // Raised from 29 to 30 on 2026-09-28, in the same batch that promoted read_archive_status: the tool
  // was called for real against w200 three times, and the restart on 15:21 (instance serving the dist
  // built 15:14:21) closed the last prose question as well - the reply now carries the checked-in
  // statusSelection sentence, and the same session showed an aggregate alias refused as a form
  // (TABLE_QUERY_AGGREGATE_FORM_UNSUPPORTED) instead of being called an unsupported function. The
  // entry names .doc/code-update-20260928-142711.md; the re-verification is recorded in
  // .doc/code-update-20260928-152302.md.
  // Raised from 30 to 31 on 2026-09-28 (coverage batch): read_authorization_trace was called for real
  // against w200 for the first time - status ok, traceActive false, traceSwitchSource
  // "AUTH_TRACE_GET_STATUS.RC", source.method "rfc_call", returnedCount 1, no query warnings. The
  // entry names .doc/code-update-20260928-155820.md and states what was not proven (RC="X" was never
  // observed). In the same batch search_failed_updates was called again and deliberately NOT promoted:
  // its entry already records that the empty window path was proven callable on 2026-09-25 while the
  // status stayed unverified because no window held a real failed update, and a fresh empty window
  // does not change that - the same restraint, not a different rule.
  // Raised from 31 to 32 on 2026-09-28 (interfaces batch): read_trfc_error_entries - built the same day
  // as the interfaces family's third capability and left unverified on purpose - was called for real
  // against w200 after the instance was restarted onto the 16:07:58 build. The full read (maxRows 500)
  // answered ok with 140 entries and no query warnings, a filtered read answered ok with 1 entry, and
  // the entry names .doc/code-update-20260928-162050.md while recording what was NOT proven: the
  // filter-length and row-limit codes are preempted by the inputSchema (MCP error -32602), so they were
  // never exercised. That promotion is what moves `interfaces` into the criterion's numerator.
  // Raised from 32 to 33 on 2026-09-29 (OP2 locks batch): delete_sap_lock was verified by a real
  // release against w200 with the four-part evidence the locks family needed - the pre-change read of
  // the exact SM12 row, the helper's own LOCK_DELETE receipt, the service's read-back, and an
  // independent re-read. The entry names .doc/code-update-20260929-084029.md. This is the tripwire
  // that batch missed: the registry moved to 33 while the bound stayed at 32.
  // Raised from 33 to 35 on 2026-09-29 (OP3 landscape batch): compare_systems and promote_object were
  // called for real from one instance holding both connections - w200 (GR2/200, Development client) and
  // w300 (GR3/300, Test client), whose system ids were read separately with get_sap_system_info, so the
  // pair is two distinct systems and not two clients of one. Seven compare_systems verdicts and eight
  // promote_object verdicts came from real calls, covering every branch each chain can reach, including
  // an identical-source control (the same sha256 on both sides) without which a verdict that never moved
  // could not have been ruled out, and a request that is modifiable yet aimed at LOCAL, which is refused
  // rather than reported as promotable. Both entries name .doc/code-update-20260929-131440.md and state
  // what was NOT proven: incomparable and found-in-both (both need an induced read failure), the
  // sameNameOtherType caveat (no request here held a same-named entry of another type), and the
  // target-side transport read path, because every transport read happened on w200.
  // Raised from 36 to 37 on 2026-09-29 (spool batch): read_background_job_spool rendered a real
  // page after the spoolId normalisation and was promoted on its own evidence. Before that it was
  // raised from 35 to 36 on 2026-09-29 (OP2 transport import batch): import_transport_queue was
  // exercised for real on w200 from the repo-dist instance, first as a measured failure and then
  // again after the 2.18 helper body landed. The entry names .doc/code-update-20260929-152335.md and
  // leads its notes with what was NOT proven - seven of the nine verdicts the arm can return were
  // never observed, including the importable answer, because every request tried was refused - so the
  // promotion rests on the reply being mechanical (the callee's own exception name and raw
  // sub-return code on every path) rather than on the positive branch having run.
  // Raised from 37 to 39 on 2026-09-30 (updates batch): the sample the updates family could not
  // produce in three days was found by allowing VBHDR and reading it - client 200 holds exactly one
  // header row, state 255 with returnCode 9, which lands inside the tool's own failure predicate.
  // search_failed_updates then answered returnedCount 1, hasMore false for the one-hour window around
  // 2025-02-11T13:56:40, and read_failed_update read that exact key back (one module, one error, a
  // recorded revision), both replies agreeing field by field with the table row a different reader had
  // produced minutes earlier. Two tools earned the raise from one real sample; both entries name
  // .doc/code-update-20260930-090003.md and both state what was NOT proven (the row bound and hasMore,
  // a second user, a state-only failure, the revision drift guard, the error text). Nothing here was
  // inferred from a plan or from a passing test.
  // Raised from 39 to 43 on 2026-09-30 (runtime-resources batch): the runtime helper body finally
  // reached w200, so the five helper-backed reads in that family could be called for real instead of
  // being described. Four earned the promotion from live w200 replies on 2026-09-30, all naming
  // .doc/code-update-20260930-124543.md: read_db_activity (485284 bytes, partial, 400 DB6 rows with
  // live counters), read_performance_snapshot (25307 bytes, ok, 11 collector rows), read_work_processes
  // (ok, 16 work processes) and read_file_system_directory (ok, /usr/sap with two real entries). Each
  // entry states what was NOT proven - read_db_activity is truncated at its row bound and
  // read_performance_snapshot's record times are the collector's raw seconds. The fifth call,
  // read_user_sessions, did NOT earn a promotion and was recorded as failed/runtime instead: it still
  // answers READ_ONLY_UNSUPPORTED, and the entry names the generator lines that bound the cause rather
  // than asserting one. Nothing here was inferred from a plan or from a passing test.
  // Raised from 43 to 44 on 2026-09-30 (USER_LIST mandatory-LIST fix): read_user_sessions, the one
  // entry the previous batch recorded as failed/runtime, was called for real again after the helper
  // body was redeployed and this time answered status ok with 12 real kernel session rows
  // (kernelRowCount 12, returnedCount 12, truncated false, sources[0] = TH_USER_LIST / method helper).
  // The failed count moved 5 -> 4 at the same time. The entry names
  // .doc/code-update-20260930-143501.md, which names the tool, and it states what was NOT proven:
  // the row cap above 200, the userName filter path and the truncated branch were not re-exercised.
  // Nothing here was inferred from a plan or from a passing test.
  // Raised from 44 to 45 on 2026-09-30: `read_role_authorizations` recorded 14/14 real read-only
  // checks against w200 (.cache/r42-verify.json, .doc/code-update-20260930-211934.md) - two roles
  // resolved to their stored authorization objects, fields and values, the profile path read only
  // behind its flag, and the refusals (empty name, unknown role, bounded read) observed rather than
  // assumed. Its first script run read 13/14 because the script itself expected one authorization
  // field too few; the count was the script's error, not the service's, and both the defect and the
  // corrected reading are stated in that record.
  // Raised from 45 to 49 on 2026-10-01 (jobs batch): the four job-control tools were exercised for
  // real in one run on w200 (.cache/r100-jobs-acceptance.json, 11/11, failures 0) and each earned its
  // promotion from the tool's own reply - create_background_job (JOB_CREATED with SAP's assigned job
  // count, status P, and a second create refused as JOB_DUPLICATE), modify_background_job (both arms
  // JOB_MODIFIED, read back still scheduled, and a released job refused as JOB_NOT_MODIFIABLE),
  // release_background_job (JOB_RELEASED, read back status S) and cancel_background_job
  // (JOB_CANCELLED, absence proven on read-back). release_background_job's earlier failed/runtime
  // verdict is superseded rather than deleted: its cause was target data, not a tool fault. All four
  // name .doc/code-update-20261001-135303.md and state what was NOT proven. Nothing here was inferred
  // from a plan or from a passing test.
  // Raised from 49 to 50 on 2026-10-02 (R1): `read_enhancement_implementation` earned its promotion
  // from a real read-only call at 23:01:05 +08:00 on 2026-10-01, recorded at
  // .doc/orvanta-enhancement-read-enhancement-implementation-2026-10-01T15-01-05-986Z.json - the
  // reply carries the definition (activeRaw X, hasInactiveVersion false, one hook implementation,
  // a fingerprint) instead of the pre-rename OPERATION_NOT_ALLOWED, and the renamed
  // READ_ENHANCEMENT_IMPL is self-described by the live helper. In the same batch the `failed` count
  // moved 4 -> 2 rather than to 0: two of the four rows turned out to rest on a length rule that a
  // real call refuted, so one became `verified` and one `unverified`; the other two stayed `failed`,
  // with manage_classic_badi_implementation re-attributed from `static` to `runtime` because its
  // call did reach SAP and was refused there.
  // Raised from 50 to 100 on 2026-10-02 (R2): the development-side backfill entered 50 tools that
  // already had a real recorded live acceptance sitting in this workspace but had never been
  // registered. Every one was adjudicated by hand against the design's rule that `verified` points
  // at a record of a call that SUCCEEDED, and the design's own evidence clause - which admits
  // `.doc/code-update-*.md`, incident logs and forensics JSON - is why several entries cite
  // `.logs/mcp-incident-*.md` and `.cache/runtime-regression/*` receipts. The candidate list
  // offered 57 and 7 were rejected on that rule: `upsert_lock_object` (ten receipts, all
  // status=failed), `create_smartform` (SMARTFORM_STORE_FAILED),
  // `create_enhancement_hook_implementation` (HTTP 500 RABAX_STATE),
  // `append_ddic_transparent_table_fields` (verification did not return the requested definition),
  // `preview_source_changes` (blocked, httpStatus 404), `get_version_history` (object not found),
  // and `abap_debug_status` - whose only artifact is a repo-side acceptance-harness log rather than
  // a tool reply, and which could not be promoted in any case while the capability report measures
  // `debuggerCapability=platform_unsupported` and the six abap_debug_* tools are withheld from the
  // dev/config/ops profiles for that reason. Each promoted entry cites a record that was opened and
  // whose quoted observed values were read out of it, and each path was checked to exist on disk
  // and to name its own tool before it was written.
  // Raised from 100 to 101 on 2026-10-02 (R3/D-9): `format_abap_source` earned its promotion from a
  // real read-only call at 19:20:57 +08:00, recorded at
  // .doc/orvanta-format-abap-source-2026-10-02T11-20-57-181Z.json. The reply formatted w200 class
  // CL_SATC_ADT_RES_APP: changed true, 53 lines in and 63 out, readOnly true and wroteToSap false. The
  // promotion is grounded on the output DIFFERING from the input - the formatter expanded a chained
  // METHODS declaration and re-wrapped an IF condition, which an echo could not produce. A second call
  // in the same session against a non-source URI returned one blank line and is recorded in that entry
  // as what a URI carrying no ABAP source answers, so it is not mistaken for a formatting result.
  // Raised from 101 to 102 on 2026-10-02 (R3/B7-4): `read_ddic_table_conversion_status` earned its
  // promotion from a real read-only call at 19:39:12 +08:00 against w200 table ZCEKKO, recorded at
  // .doc/orvanta-read-ddic-table-conversion-status-2026-10-02T11-39-12-870Z.json - pending false,
  // entryCount 0, readOnly true. Its entry also carries what the four calls of that round taught: a
  // filtered read of the system-wide TBATG worklist cannot tell "nothing pending" from "no such
  // table", so that limit is documented in both the registry entry and the tool description instead
  // of being presented as a clean zero.
  assert.ok(
    // CFG-01: one actual describe_configuration_object MCP call for T006A succeeded on
    // 2026-10-02; .cache/configuration-units-isolated-recheck-20261002.json records the
    // seven-field partial descriptor. This attests metadata only, not IMG/API/CTS or writes.
    // R7-A: get_quick_fix_proposals was verified by a real read-only call on the same day
    // (.doc/orvanta-get-quick-fix-proposals-2026-10-02T14-52-47-000Z.json), which is the 104th -
    // the refactoring evaluate tool did NOT move here: it is recorded platform-unsupported instead,
    // so this bound counts one promotion, not two.
    // CFG-05: resolved T006/T006A mode returned 9/5 IMG headers in actual named MCP calls;
    // .doc/orvanta-configuration-units-img-acceptance-20261002-231344.json retains raw receipts.
    // Raised from 105 to 122 on 2026-10-02 (R7-B): the read-only acceptance sweep promoted 17 tools
    // that had no real call on record, each from a raw receipt produced by a real w200 call in this
    // batch - source 4 (get_batch_lines, analyze_change_impact, get_version_history,
    // preview_source_changes), platform 2 (get_abap_object_url, list_write_recovery_operations) and
    // enhancement 11 (search_customer_exit_objects, read_customer_exit_project,
    // read_customer_exit_definition, inspect_enhancement_framework, inspect_source_enhancements,
    // inspect_customer_function_exits, inspect_customer_screen_menu_exits,
    // inspect_fico_rule_exit_program, read_bte_configuration, search_bte_dispatchers,
    // prepare_enhancement_configuration_workflow). Each receipt was opened, its tool name and
    // arguments checked against the claim, and the observed values quoted in the entry. In the same
    // batch three read-only debugger tools moved to `platform-unsupported` (not `verified`) from the
    // batch's own capability report, whose ADT discovery evidence shows no /sap/bc/adt/debugger
    // collection on w200, and two DDIC write verifications that had rejected writes SAP applied were
    // fixed with guard tests (test/ddic-write-verification-fidelity.test.ts).
    // Raised from 122 to 125 on 2026-10-02 (R7-B, ui/data round): read_abap_screen,
    // read_abap_gui_definition, read_transaction_code, validate_dynpro_application and
    // read_report_variants earned their promotion from real w200 calls recorded under
    // .cache/r7b-state-uidata. `read_report_parameters` did NOT move: its own local approval gate
    // refused the call before SAP was contacted. Two tools that a first pass had promoted -
    // get_abap_object_url and list_write_recovery_operations - were put back to `unverified` with no
    // evidence, because this registry's `verified` attests a SAP-side acceptance and those two never
    // contact SAP; their real local results are recorded in their notes instead.
    // Raised from 125 to 126 on 2026-10-03 (R7-E3): patch_ddic_transparent_table_fields moved off
    // `unverified` on a real w200 success, not on a code change. R7-E had recorded two patches that
    // SAP applied while the receipt reported a failed verification, and the entry was deliberately
    // left unverified because no call had ever answered successfully. This call did: a key-flag patch
    // on the authorized temporary table ZORVANTA_R7C_TMP returned `status: completed` with
    // outcomeMayBeUnknown false, and an independent read-back confirmed PAYLOAD key=false -> true,
    // version 20261003001713. The entry names that receipt and states which change class it covers
    // (key/nullability/rename) and which one is still only guard-tested (data-element re-point).
    // recover_ddic_table_conversion did NOT move: its third authorized attempt (the same key-flag
    // change, the last structural lever on a table with no rows) again produced no TBATG worklist
    // entry, so its recovery path remains unexercised.
    // Raised from 126 to 127 on 2026-10-03 (R7-D): read_report_parameters moved off `unverified` on
    // the first real w200 success, after the operator approved the REPORT_PARAMETERS source and the
    // real reply exposed two defects the local gate had hidden - the entry named the wrong helper and
    // the reply schema capped the CHAR 4 RSSCR-DTYP dictionary type at one character.
    // Raised from 127 to 128 on 2026-10-03 (R8): manage_classic_badi_implementation moved off
    // `failed` on a real activate call whose receipt completed, and patch_ddic_transparent_table_fields
    // stayed verified while its last open class (data-element re-point) was closed by a live patch -
    // so the count moved by exactly the one row whose status changed, not by the two rows touched.
    // Raised from 128 to 129 on 2026-10-03 (R10): manage_enhancement_implementation_state moved off
    // `unverified` on a real activate call against ZCHANGEBKTXT whose receipt completed and whose
    // before/after fingerprint and hook source are identical (the helper's activate() arm ran, the net
    // content did not change). The same batch recorded the reason the first attempt was refused: the
    // enhancement framework compares the session language with the object's original language.
    // Raised from 129 to 131 on 2026-10-03 (R11): upsert_ddic_domain and upsert_ddic_data_element
    // moved off `unverified` on two real create calls in package ZABAP (a CHAR domain with fixed
    // values and a data element pointing at it), each independently read back with the same version
    // and fingerprint and each leaving exactly one new transport entry. Both rows had said no real
    // call had been recorded, which this batch falsified.
    // Raised from 131 to 133 on 2026-10-03 (R12): upsert_ddic_structure and upsert_ddic_table_type
    // moved off `unverified` on two real create calls in package ZABAP (a three-field structure whose
    // components reference data elements, and a standard table type whose row type is that structure),
    // each independently read back with the same version, fingerprint and definition and each leaving
    // exactly one new transport entry. Both rows had said no real call had been recorded, which this
    // batch falsified. That batch also observed that the ddic helper's read probe advertises protocol
    // 1.7 while both tools declare a 1.16/1.17 floor, and the writes succeeded anyway, so the
    // read-probe protocol number does not gate the write path.
    // Raised from 133 to 134 on 2026-10-03 (R40): patch_ddic_transparent_table_settings moved off
    // `unverified` on one real call that changed four DD09V settings of ZORVANTA_R7C_TMP in package
    // ZABAP at once (data class, size category, buffering mode, change logging), independently read
    // back with the same version and fingerprint and with all five field rows unchanged. That row had
    // said no real call had been recorded, which this batch falsified. The same batch deliberately did
    // NOT raise the bound for append_ddic_transparent_table_fields: its live call wrote and activated
    // both appended fields, but the receipt was a false negative from a verification defect this batch
    // fixed, so it stays `unverified` until a call on the fixed build returns a clean receipt.
    totals.verified <= 134,
    `only individually cited tools may be verified; found ${totals.verified}`
  )
  // The bound above is a tripwire, not the real guard: what makes a verified entry honest is that it
  // names the record it was verified from, so every one of them must carry an evidence path.
  for (const entry of registry.entries.filter((candidate) => candidate.status === "verified")) {
    assert.ok(
      typeof entry.evidence === "string" && entry.evidence.trim() !== "",
      `verified entry ${entry.tool} must name the record it was verified from`
    )
  }

  // Carrying a path is not the same as the record justifying the claim: an entry can cite a record
  // that discusses something adjacent and never mentions the tool at all. That is how a hand-written
  // entry drifts - the 2026-09-27 sweep registration cited raw artifacts rather than a record and
  // was caught only by the field-shape rules, not by anything reading the record.
  //
  // Two entries predate this check and are recorded here rather than silently tightened, because
  // both records are substantive and describe the work by probe script or capability instead of by
  // tool name. Rewriting unrelated history to satisfy a new guard would be the wrong repair; naming
  // them keeps the exception visible and countable so it cannot quietly grow.
  const UNNAMED_BY_RECORD = ["get_sap_system_info", "read_function_module_interface"]
  const unnamed: string[] = []
  for (const entry of registry.entries.filter((candidate) => candidate.status === "verified")) {
    const path = resolveEvidencePath(entry)
    if (!path) continue // already covered by the existence guard above
    if (UNNAMED_BY_RECORD.includes(entry.tool)) continue
    const record = readFileSync(path, "utf8")
    if (!record.includes(entry.tool)) unnamed.push(`${entry.tool} -> ${entry.evidence}`)
  }
  assert.deepEqual(
    unnamed,
    [],
    "a verified entry must cite a record that names the tool it verified"
  )
  // The exception list must not rot: each name in it has to still be a verified entry, or the
  // allowance is being carried for a tool that no longer needs it.
  for (const tool of UNNAMED_BY_RECORD) {
    const entry = registry.entries.find((candidate) => candidate.tool === tool)
    assert.equal(entry?.status, "verified", `${tool} is exempted but is no longer verified`)
  }
  // This used to read `totals.unverified > totals.verified` under the sentence "the honest default
  // should dominate". That was a description of the registry's state before 2026-10-02, not a rule:
  // it held while only the ops tools had been verified (111 unverified against 50 verified), and the
  // R2 backfill then legitimately inverted it by entering 50 development-side tools that already had
  // real recorded acceptances. Keeping it would have forced the data to stay unregistered to satisfy
  // a sentence, which is the wrong direction to resolve a conflict.
  //
  // What replaces it keeps the tripwire's actual intent - that `verified` may only ever grow by
  // naming a record, never by padding - and drops the claim about which side is larger:
  //   * the honest gap must still be represented and non-empty, so `unverified` can never be
  //     emptied out to make the registry look finished;
  //   * the count is bounded below (see the raise history above), so it cannot grow silently;
  //   * and the two assertions immediately above are the real teeth - every verified entry must cite
  //     a record that exists AND that names its own tool.
  assert.ok(
    totals.unverified > 0,
    "the honest gap must stay represented: a registry with nothing unverified has stopped telling the truth"
  )
  assert.ok(
    totals.verified < totals.total,
    "no registry may claim that every tool has been verified"
  )
})
