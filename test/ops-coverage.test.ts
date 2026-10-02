import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import test from "node:test"
import { buildCapabilityReport } from "../src/capabilities.js"
import {
  OPS_FAMILIES,
  OPS_TOOL_ROLES,
  opsCapabilityBlock,
  opsClassificationProblems,
  opsFamilyState,
  splitNotVerifiedByRecordedRuling,
  type OpsFamilyDefinition
} from "../src/ops-coverage.js"
import { TOOL_REGISTRY } from "../src/tool-registry.js"
import { resolveEvidencePath, type VerificationEntry } from "../src/verification-registry.js"
import { MockBackend } from "./mock-backend.js"

/**
 * OP0: the ops block is a coverage claim, so the gate has to be able to fail.
 *
 * These assertions are deliberately explicit rather than derived: a family that quietly loses a
 * planned tool, or a tool that stops being read-only, has to break a test that names the expected
 * value. Deriving the expectation from the same table would assert nothing.
 */

const EXPECTED_FAMILY_STATES: Readonly<Record<string, string>> = {
  // Was "partial" until 2026-10-01, when the operator ruled the request-release export a platform
  // boundary: reading SAP's own source proved the export cannot be skipped for a workbench request
  // that has a target, and the OS-level tp it needs is unreachable on this AIX host. The tool was
  // withdrawn from the plan and is registered platform-unsupported, so the gap is empty and the
  // family no longer waits on a route - the state is derived from that, not set by hand.
  transport: "read-and-act",
  // Was "partial" until 2026-10-01, when both job writes were exercised against the deployed helper
  // on the real machine: create, both modify arms, release and cancel all ran and were read back
  // (11/11, .cache/r100-jobs-acceptance.mjs). The helper arms had been deployed a day earlier; what
  // was missing was exactly the exercise, which is why registering the tools did not move this state.
  jobs: "read-and-act",
  logs: "read-only",
  dumps: "read-only",
  traces: "blocked",
  locks: "read-and-act",
  // Was "partial" until 2026-09-30, when the operator ruled the missing repeat capability a platform
  // boundary rather than a gap: the feasibility investigation of `reprocess_failed_update` measured
  // that no caller-usable interface for it exists on this target (docs/ops-coverage.md 7.19), so the
  // family declares no gap and needs no action.
  updates: "read-only",
  "system-info": "read-only",
  // Was "partial" until 2026-09-30, when the last declared capability of this family - an uncorrelated
  // scalar subquery in a comparison, on top of the projection terms, the WHERE term, the joined term,
  // the `IN (SELECT ...)` set test and the join forms before it - was built, so the declared gap is
  // empty and the route is `none`. Its four earlier slices were read on w200 the same day (22/22
  // assertions in the read-only verify scripts); the scalar slice itself is proven locally and awaits
  // the next restart for a real-machine reading, which its boundary states.
  query: "read-only",
  // Was "partial" until 2026-09-30, when the helper body that carries the family's five 1.1 opcodes
  // reached w200 and `read_user_sessions` - the last one outstanding - was called for real after its
  // USER_LIST branch stopped omitting TH_USER_LIST's mandatory LIST table parameter. All six tools
  // now carry a live w200 reply, so the gap is empty and the route is `none`.
  "runtime-resources": "read-only",
  interfaces: "read-only",
  // Was "partial" until 2026-09-30, when the trace-data half was reached without any SAP-side
  // change: AUTH_TRACE_GET_AUTHVAL_KEY + AUTH_TRACE_GET_AUTHVAL_DATA are both remote-enabled, which
  // made the D5-2 table allowlist - not the XUBITVEC16 type the old gap blamed - the real blocker.
  // The residual limit (the bit vector is returned, never decoded) is recorded as this family's
  // boundary, so the declared gap is empty and the route is `none`.
  authorizations: "read-only",
  "spool-output": "read-only",
  "archive-alerts": "read-only",
  // Was "absent" until 2026-09-29, when OP3 added the connection role and `compare_systems`, and the
  // same day gained the read-only `promote_object` precheck. It closed the same day by the operator's
  // ruling that this family's end-to-end is exactly that read-only loop: performing the promotion is
  // recorded as a boundary rather than a gap, so the state is "read-only" and not "read-and-act".
  landscape: "read-only"
}

/**
 * The plan's outstanding tool commitments; adding one to the plan must update this number.
 *
 * It fell from 10 to 9 on 2026-09-28 when `delete_sap_lock` was built (OP2, the locks family), and
 * to 8 once `release_transport_task` was registered (OP2, the transport family), and to 7 on
 * 2026-09-29 when `compare_systems` was registered (OP3, the landscape family), and to 6 the same
 * day when `promote_object` was registered (OP3's second batch): this counts tools that do not
 * exist yet, not tools that have not been exercised. It fell to 5 later the same day, when
 * `import_transport_queue` was registered as the transport family's import precheck, and to 4 on
 * 2026-09-30, when the operator ruled the updates family's repeat capability a platform boundary:
 * `reprocess_failed_update` left the plan because no caller-usable interface for it exists on this
 * target (docs/ops-coverage.md 7.19), not because it was built. It fell to 2 on 2026-09-30 with the
 * runtime-resources batch, which registered the two metrics readers the plan still listed,
 * `read_db_activity` and `read_performance_snapshot`. It reached 0 on 2026-09-30 with the jobs
 * batch: `create_background_job` and `modify_background_job` were registered, so the plan lists no
 * tool that the registry does not carry. That is a statement about the surface, not about the
 * family's gap - `jobs` still declares one, because neither new tool has been exercised against a
 * helper that carries its arm, and a planned tool that exists is not a planned tool that is done.
 */
const PLANNED_GAP_TOOL_COUNT = 0

test("every ops tool has exactly one role and agrees with the registry annotation", () => {
  assert.deepEqual(opsClassificationProblems(), [])

  const opsGroupTools = TOOL_REGISTRY.filter((entry) => entry.group === "ops")
    .map((entry) => entry.name)
    .sort()
  assert.deepEqual(Object.keys(OPS_TOOL_ROLES).sort(), opsGroupTools)
  // 44 from 2026-09-30: `create_background_job` and `modify_background_job` completed the jobs
  // family's four job-control actions, which is also the batch that took the plan's outstanding
  // commitments to zero. 42 was reached the same day when `read_role_authorizations` joined the ops
  // group with the authorizations family's second half. 41 was reached the same day
  // (`read_db_activity` and `read_performance_snapshot` with the runtime-resources batch). 39 was
  // reached on 2026-09-29 (`delete_sap_lock` on 2026-09-28, then `release_transport_task`,
  // `compare_systems`, `promote_object` and `import_transport_queue`). The count is a tripwire, not a
  // goal - it exists so a tool cannot leave or join the classified surface unnoticed.
  assert.equal(opsGroupTools.length, 44)
})

test("family states are derived from the surface, and the plan's gaps stay visible", () => {
  const states = Object.fromEntries(OPS_FAMILIES.map((item) => [item.id, opsFamilyState(item)]))
  assert.deepEqual(states, EXPECTED_FAMILY_STATES)

  // The families that are closed are closed because nothing has to act on SAP on their behalf.
  // `landscape` is in this list on that exact ground: the operator's 2026-09-29 ruling put the
  // promotion action outside the family's end-to-end, and that limit is recorded as a boundary.
  // `runtime-resources` joined on 2026-09-30, when its helper body reached w200 and all six of its
  // tools - all reads - had a real reply behind them. `jobs` joined on 2026-10-01: it is the one
  // family here that acts on SAP and still counts as closed, because its own write tools were
  // exercised for real, which is what "read-and-act" means. `transport` joined on 2026-10-01 by the
  // operator's platform-boundary ruling on its one unverified tool, which left the family with nothing
  // outstanding; it still acts on SAP through create and add.
  const closed = Object.entries(states)
    .filter(([, state]) => state === "read-only" || state === "read-and-act")
    .map(([id]) => id)
    .sort()
  assert.deepEqual(closed, [
    "archive-alerts",
    "authorizations",
    "dumps",
    "interfaces",
    "jobs",
    "landscape",
    "locks",
    "logs",
    "query",
    "runtime-resources",
    "spool-output",
    "system-info",
    "transport",
    "updates"
  ])

  // A family may not lose a planned tool without saying so; the guard has to catch that, not just
  // the real tables that currently happen to be consistent.
  // The probe has to name a tool the registry does not know, because that is what "missing planned
  // tool" means. It used to name `create_background_job`, which stopped being missing on 2026-09-30
  // when the jobs batch registered it - and with it the plan's last outstanding commitment, so no
  // real family can exercise this branch any more. The probe therefore names a tool the plan does not
  // contain: the guard is about the shape of the declaration, not about which commitment happens to
  // be open today.
  const brokenFamily = [
    {
      id: "transport",
      label: "Transport",
      purpose: "Which request holds this object?",
      closeRoutes: ["none"] as const,
      plannedToolNames: ["manage_transport_requests", "no_such_ops_tool"],
      actionRequired: true,
      gap: ""
    }
  ]
  const problems = opsClassificationProblems({ families: brokenFamily })
  assert.ok(
    problems.some((problem) =>
      /missing planned tool no_such_ops_tool but declares no gap/.test(problem)
    ),
    `the guard did not report the silent gap: ${problems.join("; ")}`
  )
  assert.ok(
    problems.some((problem) => /not filed into any scenario family/.test(problem)),
    `the guard did not report unfiled ops tools: ${problems.join("; ")}`
  )

  // A role that contradicts the registry annotation must fail too.
  const wrongRole = { ...OPS_TOOL_ROLES, create_transport_request: "read-only" as const }
  assert.ok(
    opsClassificationProblems({ roles: wrongRole }).some((problem) =>
      /create_transport_request has role read-only but is not readOnlyHint/.test(problem)
    ),
    "the guard did not report a role that contradicts the registry"
  )

  // A platform exemption is a claim, so an exemption on a family the plan simply has not built must
  // fail: otherwise the target could be lowered by declaring families exempt.
  const bogusExemptions = [
    {
      id: "jobs",
      label: "Jobs",
      purpose: "Did the job run?",
      closeRoutes: ["none"] as const,
      plannedToolNames: ["search_background_jobs"],
      actionRequired: false,
      gap: "",
      exemptReason: "looks hard"
    },
    {
      id: "logs",
      label: "Logs",
      purpose: "What does the log say?",
      closeRoutes: ["none"] as const,
      plannedToolNames: ["read_system_logs"],
      actionRequired: false,
      gap: "",
      exemptReason: ""
    }
  ]
  const exemptionProblems = opsClassificationProblems({ families: bogusExemptions })
  assert.ok(
    exemptionProblems.some((problem) =>
      /family jobs claims a platform exemption but its state is read-only/.test(problem)
    ),
    `the guard accepted an exemption on an unbuilt family: ${exemptionProblems.join("; ")}`
  )
  assert.ok(
    exemptionProblems.some((problem) =>
      /family logs claims an exemption with an empty reason/.test(problem)
    ),
    "the guard accepted a blank exemption reason"
  )
})

test("every family states a purpose and a route, and the two cannot contradict the gap", () => {
  // The real tables first: a purpose is what makes a gap actionable, and the route says who can
  // remove it, so neither may be blank on a family that still counts against the target.
  for (const family of OPS_FAMILIES) {
    assert.notEqual(family.purpose.trim(), "", `family ${family.id} has no purpose`)
    assert.ok(family.closeRoutes.length > 0, `family ${family.id} has no closure route`)
  }
  const block = opsCapabilityBlock()
  const byId = Object.fromEntries(block.families.map((family) => [family.id, family]))
  assert.equal(byId.logs!.closeRoutes[0], "none")
  // `query` joined the "none" route on 2026-09-30 once its last declared capability was built.
  assert.deepEqual(byId.query!.closeRoutes, ["none"])
  // The DB02 half is answered through the helper rather than through a vendor-neutral activity
  // module, and on 2026-09-30 the family closed: the body reached w200 and all six tools answered.
  assert.deepEqual(byId["runtime-resources"]!.closeRoutes, ["none"])
  // Recounted on 2026-09-30 from the real table. `locks` and `spool-output` moved to the "none" route
  // on 2026-09-29, `landscape` followed the same day by the operator's ruling, and `updates` joined on
  // 2026-09-30 by the same kind of ruling (its repeat capability is a platform boundary, so it stops
  // `jobs` closed on 2026-10-01 (eighth batch) once both job writes were exercised on the real
  // machine, so its `authorization` route - the operator's standing authorization for those writes -
  // left with it: `authorization` fell 2 -> 1 and `none` rose 12 -> 13. A family with an empty gap may
  // not keep a closure route at all, which is what moved the count rather than trimming the route out
  // of the text. The only family still waiting on the landscape route is `transport`, whose own gap is
  // about importing and is untouched by the landscape ruling.
  // `transport` was the last family still waiting on the landscape route, and on 2026-10-01 the
  // operator ruled its one unverified tool a platform boundary: the request-release export cannot be
  // skipped (proven from SAP's own source) and the OS-level tp it needs is out of reach on this AIX
  // host, so the tool was withdrawn from the plan and the family stopped waiting. That took the
  // `authorization` route to 0 and the `landscape` route to 0, and `none` rose 13 -> 14. A family with
  // an empty gap may not keep a closure route at all, which is what moved the count rather than
  // trimming the route out of the text.
  assert.equal(block.summary.closeRouteCounts.none, 14)
  assert.equal(block.summary.closeRouteCounts.platform, 1)
  assert.equal(block.summary.closeRouteCounts.service, 0)
  assert.equal(block.summary.closeRouteCounts.approval, 0)
  assert.equal(block.summary.closeRouteCounts.helper, 0)
  assert.equal(block.summary.closeRouteCounts.authorization, 0)
  assert.equal(block.summary.closeRouteCounts.landscape, 0)
  // Closing the family must move the correction into the boundary, not delete it: a claim of
  // unavailability may not survive once its source is proven to be ours, and the family still has to
  // state what it deliberately does not answer.
  assert.equal(byId["runtime-resources"]!.gap, "")
  const runtimeBoundary = byId["runtime-resources"]!.boundary!
  assert.match(runtimeBoundary, /RFCDBSYS/)
  assert.doesNotMatch(runtimeBoundary, /platform is not readable/)
  assert.doesNotMatch(runtimeBoundary, /newly approved source for the platform/)

  // Then the guard, on families that lie about their own state. A gap with no owner is a wish.
  const withProblem = (problems: string[], pattern: RegExp) =>
    problems.some((problem) => pattern.test(problem))
  const base = {
    label: "Probe",
    purpose: "Does the guard read the route?",
    plannedToolNames: ["search_background_jobs"],
    actionRequired: false
  }
  const cases: Array<[Partial<OpsFamilyDefinition>, RegExp]> = [
    [{ gap: "still missing", closeRoutes: ["none"] }, /declares a gap and the "none" route/],
    [{ gap: "", closeRoutes: ["service"] }, /declares no gap but a closure route/],
    [{ gap: "", closeRoutes: ["service", "service"] }, /repeats a closure route/],
    [{ gap: "", closeRoutes: [] }, /states no route to closure/],
    [{ gap: "", purpose: " ", closeRoutes: ["none"] }, /states no purpose/],
    [{ gap: "still missing", closeRoutes: ["platform"] }, /names the platform as its route/],
    [
      {
        gap: "still missing",
        closeRoutes: ["authorization"],
        exemptReason: "the platform stops it"
      },
      /claims a platform exemption without naming the platform route/
    ]
  ]
  for (const [overrides, pattern] of cases) {
    const problems = opsClassificationProblems({
      families: [{ id: "probe", ...base, closeRoutes: ["none"], gap: "", ...overrides }]
    })
    assert.ok(
      withProblem(problems, pattern),
      `the guard missed ${String(pattern)}: ${problems.join("; ")}`
    )
  }
  // The matching combinations stay silent, so the guard is not simply rejecting everything. An
  // override list always leaves other ops tools unfiled, so only route and purpose problems are read.
  const clean = opsClassificationProblems({
    families: [
      { id: "probe", ...base, gap: "still missing", closeRoutes: ["helper"] },
      { id: "probe-clean", ...base, gap: "", closeRoutes: ["none"] }
    ]
  })
  assert.ok(
    !clean.some((problem) =>
      /closure route|route to closure|states no purpose|platform/.test(problem)
    ),
    `a consistent pair was rejected: ${clean.join("; ")}`
  )
})

test("the block counts only families with an empty gap as end-to-end", () => {
  const block = opsCapabilityBlock()

  assert.equal(block.summary.familyCount, Object.keys(EXPECTED_FAMILY_STATES).length)
  assert.deepEqual(block.summary.stateCounts, {
    absent: 0,
    blocked: 1,
    // `updates` moved from partial to read-only on 2026-09-30 by the operator's ruling that the
    // missing repeat capability is a platform boundary, `runtime-resources` followed the same day
    // once its helper body reached w200 and every one of its six tools had answered, and `query`
    // followed once its last declared capability was built, and `authorizations` followed once the
    // trace-data half was reached through the remote-enabled pair. `jobs` was the last to move: it
    // stayed partial on 2026-09-30 even though it had gained both of the tools it was missing,
    // because neither write had been exercised against a helper that carries its arm - registering a
    // tool is not the same claim as proving one. It closed on 2026-10-01 once both writes ran on the
    // real machine (11/11 acceptance). `transport` was the last family to leave this bucket the same
    // day, by the operator's platform-boundary ruling on its one unverified tool: with the tool
    // withdrawn from the plan the family is structurally complete, so no family declares a gap.
    partial: 0,
    "read-only": 11,
    "read-and-act": 3
  })
  // `locks` joined the closed families on 2026-09-29, and `landscape` followed the same day by the
  // operator's ruling that its read-only loop is the family's end-to-end, and `spool-output` closed
  // the same day once its only planned tool rendered a page. `updates` followed on 2026-09-30 by the
  // same kind of ruling - its repeat capability is a platform boundary, not a gap - and
  // `runtime-resources` closed the same day once its helper was deployed and verified, and `query`
  // closed once its last declared capability was built, and `authorizations` closed once its trace-data
  // half was reached, and `jobs` closed on 2026-10-01 once both job writes were exercised on the real
  // machine, and `transport` closed the same day by the operator's ruling that its one unverified tool
  // is a platform boundary (the request-release export cannot be skipped and the OS-level tp it needs
  // is unreachable here), so the gap-only reading is 14 of 15.
  assert.deepEqual(block.summary.endToEndFamilies, [
    "transport",
    "jobs",
    "logs",
    "dumps",
    "locks",
    "updates",
    "system-info",
    "query",
    "runtime-resources",
    "interfaces",
    "authorizations",
    "spool-output",
    "archive-alerts",
    "landscape"
  ])
  assert.equal(block.summary.endToEndFamilyCount, 14)
  assert.equal(block.summary.endToEndPercent, 93)
  assert.ok(
    block.summary.endToEndPercent < 95,
    "the ops surface must not be reported as a 95% coverage milestone while the plan is open"
  )
  // 44 from 2026-09-30: `create_background_job` and `modify_background_job` joined with the jobs
  // batch, which is also what took the plan's outstanding commitments to zero. 42 was reached the
  // same day: `read_role_authorizations` joined the ops group with the authorizations family's second
  // half. 41 was reached the same day: `compare_systems`, `promote_object` and
  // `import_transport_queue` joined with OP3's two batches and OP2's transport import precheck, and
  // the runtime-resources batch added `read_db_activity` and `read_performance_snapshot`.
  assert.equal(block.summary.classifiedToolCount, 44)
  // Nine action tools from 2026-09-30: `delete_sap_lock` is a destructive write and
  // `release_transport_task` releases a transport task, so both are classified as actions like the
  // two transport writes and the two job writes before them - and the jobs batch added the family's
  // other two writes, `create_background_job` and `modify_background_job`, which change what the
  // scheduler holds without destroying anything.
  assert.equal(block.summary.actionToolCount, 9)
  assert.equal(block.summary.platformBlockedToolCount, 1)
  assert.equal(block.summary.missingPlannedToolCount, PLANNED_GAP_TOOL_COUNT)
  assert.equal(block.summary.missingPlannedToolCount, block.summary.missingPlannedTools.length)

  // The criterion is stated in the block, not left to the reader: the assessment's matrix has 14
  // families, the surface carries 15 because the platform-blocked trace family is its own family,
  // and that family is the one documented exemption. So 14 families have to close - the number the
  // objective names - and the percentage below is over those 14, not over 15.
  assert.deepEqual(block.summary.exemptFamilies, ["traces"])
  assert.equal(block.summary.requiredEndToEndFamilyCount, 14)
  assert.equal(block.summary.requiredEndToEndPercent, 95)
  assert.equal(block.summary.endToEndPercentOfRequired, 0)

  // This call passes no registry, which is the packaged-build case: the structurally closed families
  // cannot be certified as verified, so the criterion's numerator is zero and the block says why
  // instead of quietly falling back to the gap-only reading.
  assert.equal(block.summary.registryLoaded, false)
  assert.match(block.summary.criterionBasis, /registry unavailable/)
  assert.equal(block.summary.stateClosedRequiredFamilyCount, 14)
  assert.equal(block.summary.closedRequiredFamilyCount, 0)
  assert.deepEqual(block.summary.evidenceUnregisteredFamilies, [
    "transport",
    "jobs",
    "logs",
    "dumps",
    "locks",
    "updates",
    "system-info",
    "query",
    "runtime-resources",
    "interfaces",
    "authorizations",
    "spool-output",
    "archive-alerts",
    "landscape"
  ])
  // The worklist is the evidence-aware one, so with no registry every required family is outstanding
  // even though all fourteen are structurally closed - the count does not follow the state count.
  assert.equal(block.summary.remainingRequiredFamilyCount, 14)
  assert.equal(block.summary.criterionMet, false)
  // The gap-only reading is met here while the evidence-aware one is not, which is exactly the
  // separation this case is meant to expose: without the registry the block refuses to certify
  // anything rather than silently falling back to the structural reading.
  assert.equal(block.summary.stateCriterionMet, true)
  assert.equal(
    block.summary.outstandingRequiredFamilies.length,
    block.summary.requiredEndToEndFamilyCount - block.summary.closedRequiredFamilyCount
  )
  assert.ok(
    !block.summary.outstandingRequiredFamilies.includes("traces"),
    "the worklist must never name the exempt family"
  )

  // A monitor-only family never becomes end-to-end just because a reader exists, but a family that
  // gained writers and had them exercised does: jobs carries all four job-control actions and closed
  // on 2026-10-01, when create and both modify arms ran against the deployed helper on the real
  // machine alongside release and cancel (11/11). Its state is derived from the empty gap, so this
  // asserts the derivation rather than a label someone set.
  const jobs = block.families.find((family) => family.id === "jobs")
  assert.ok(jobs)
  assert.equal(jobs.state, "read-and-act")
  assert.equal(jobs.actionRequired, true)
  assert.deepEqual(jobs.actionTools, [
    "create_background_job",
    "modify_background_job",
    "release_background_job",
    "cancel_background_job"
  ])
  // Nothing the plan promised this family is missing from the registry, and the gap that used to
  // record the two unexercised writes is empty because they were exercised - not because it was
  // cleared.
  assert.deepEqual(jobs.missingToolNames, [])
  assert.equal(jobs.gap, "")

  // A platform-stopped family is reported as blocked, which is a different claim from "not built".
  const traces = block.families.find((family) => family.id === "traces")
  assert.ok(traces)
  assert.equal(traces.state, "blocked")
  assert.deepEqual(traces.platformBlockedTools, ["analyze_abap_traces"])
  assert.equal(traces.exempt, true)
  assert.match(traces.exemptReason, /platform-blocked/)
  // Only the platform-blocked family may carry an exemption.
  assert.deepEqual(
    block.families.filter((family) => family.exempt).map((family) => family.id),
    ["traces"]
  )

  // The system baseline keeps only the commitment that is still real: the client role, its change
  // protection and CVERS.EXTRELEASE verbatim are already reported by get_sap_system_info, so
  // treating them as separate future tools would inflate the gap. `read_system_parameters` landed on
  // 2026-09-25, so nothing planned is missing here any more, and on 2026-09-28 the operator ruled the
  // last remaining absence - the database *release* - a boundary rather than a gap, because both
  // declared tools are verified and no reachable source on this target reports that datum.
  const systemInfo = block.families.find((family) => family.id === "system-info")
  assert.ok(systemInfo)
  assert.deepEqual(systemInfo.toolNames, ["get_sap_system_info", "read_system_parameters"])
  assert.deepEqual(systemInfo.missingToolNames, [])
  assert.equal(systemInfo.gap, "")
  assert.equal(systemInfo.state, "read-only")
  assert.match(systemInfo.boundary, /the database \*release\*/i)
  assert.match(systemInfo.boundary, /RFCDATABS is typed SYSYSID/)

  // `interfaces` was refilled rather than left open: the third capability is the SM58 tRFC error
  // queue, and the mail question it replaced is declared as a boundary instead of a silent drop.
  const interfaces = block.families.find((family) => family.id === "interfaces")
  assert.ok(interfaces)
  assert.deepEqual(interfaces.toolNames, [
    "read_qrfc_queues",
    "read_idoc_status",
    "read_trfc_error_entries"
  ])
  assert.deepEqual(interfaces.missingToolNames, [])
  assert.equal(interfaces.gap, "")
  assert.match(interfaces.boundary, /outbound-mail question/)
  assert.match(interfaces.boundary, /read_trfc_error_entries/)

  // `transport` gave up the two tools the platform cannot deliver, and both withdrawals are visible in
  // the block instead of the tools quietly leaving it. `release_transport_task` joined
  // `cleanup_transport_entries` on 2026-10-01: the request-release export cannot be skipped and the
  // OS-level tp it needs is out of reach on this AIX host, so the family stopped waiting for it.
  const transport = block.families.find((family) => family.id === "transport")
  assert.ok(transport)
  assert.deepEqual(transport.withdrawnToolNames, [
    "cleanup_transport_entries",
    "release_transport_task"
  ])
  assert.ok(!transport.toolNames.includes("cleanup_transport_entries"))
  assert.ok(!transport.toolNames.includes("release_transport_task"))
  assert.ok(!transport.verification.blockingTools.includes("cleanup_transport_entries"))
  assert.ok(!transport.verification.blockingTools.includes("release_transport_task"))
  assert.match(transport.boundary, /withdrawn/)
  assert.match(transport.boundary, /CTS_CLEANUP_POSTCHECK_ENTRY_REMAINS/)
  assert.match(transport.boundary, /release_transport_task was withdrawn/)
  assert.match(transport.boundary, /TRINT_TRANSPORT_REQUEST/)
})

test("a withdrawal is refused unless it is registered and explained", () => {
  // The guard exists so a name cannot leave the report silently. Falsified on the real tables: a
  // family that withdraws a registered tool without a boundary must be rejected, and so must one
  // that withdraws a name no registry knows.
  const base = {
    id: "probe",
    label: "Probe",
    purpose: "Does the guard fire?",
    closeRoutes: ["none"] as const,
    plannedToolNames: ["manage_transport_requests"],
    actionRequired: false,
    gap: ""
  }
  const silent = opsClassificationProblems({
    families: [
      {
        ...base,
        withdrawnToolNames: ["cleanup_transport_entries"]
      } as OpsFamilyDefinition
    ]
  })
  assert.ok(
    silent.some((problem) => /without stating why in its boundary/.test(problem)),
    `a boundary-free withdrawal was accepted: ${silent.join("; ")}`
  )

  const unknown = opsClassificationProblems({
    families: [
      {
        ...base,
        withdrawnToolNames: ["not_a_registered_tool"],
        boundary: "checks the unknown-name branch"
      } as OpsFamilyDefinition
    ]
  })
  assert.ok(
    unknown.some((problem) => /withdraws unregistered tool/.test(problem)),
    `an unregistered withdrawal was accepted: ${unknown.join("; ")}`
  )

  const both = opsClassificationProblems({
    families: [
      {
        ...base,
        plannedToolNames: ["manage_transport_requests", "cleanup_transport_entries"],
        withdrawnToolNames: ["cleanup_transport_entries"],
        boundary: "checks the both-planned-and-withdrawn branch"
      } as OpsFamilyDefinition
    ]
  })
  assert.ok(
    both.some((problem) => /both plans and withdraws/.test(problem)),
    `a family that both plans and withdraws a tool was accepted: ${both.join("; ")}`
  )
})

test("the block joins with the evidence dimension without changing it", () => {
  const block = opsCapabilityBlock({
    entries: new Map([
      ["create_transport_request", { status: "verified" as const }],
      ["manage_transport_requests", { status: "unverified" as const }],
      ["add_objects_to_transport", { status: "failed" as const }]
    ])
  })

  const transport = block.families.find((family) => family.id === "transport")
  assert.ok(transport)
  assert.deepEqual(transport.verification.verified, ["create_transport_request"])
  // `add_objects_to_transport` is present in the family and carries a fabricated failure, so it is
  // the tool the evidence point keeps out of the numerator; a withdrawn name is not present at all
  // and therefore cannot appear in either list, which is exactly why the withdrawal is declared
  // separately rather than by deletion. `release_transport_task` left the present set on 2026-10-01
  // with the platform-boundary ruling, so it no longer appears here either - it is asserted as
  // withdrawn below instead.
  assert.deepEqual(transport.verification.unverified, [
    "manage_transport_requests",
    "import_transport_queue"
  ])
  assert.deepEqual(transport.verification.failing, ["add_objects_to_transport"])
  assert.deepEqual(transport.withdrawnToolNames, [
    "cleanup_transport_entries",
    "release_transport_task"
  ])
  assert.ok(!transport.verification.blockingTools.includes("cleanup_transport_entries"))
  assert.ok(!transport.verification.blockingTools.includes("release_transport_task"))

  // No lookup at all is the packaged-build case: everything is unverified, nothing is implied.
  const withoutRegistry = opsCapabilityBlock()
  const logs = withoutRegistry.families.find((family) => family.id === "logs")
  assert.ok(logs)
  assert.deepEqual(logs.verification.verified, [])
  assert.equal(logs.verification.unverified.length, logs.toolNames.length)
})

test("a closed gap does not certify a family whose tools were never exercised", () => {
  // `logs`, `dumps`, `system-info`, `interfaces` and `archive-alerts` are the families whose declared
  // gap is empty, so all five are structurally closed. Here every logs tool is verified except one,
  // which is marked failed: the family state must not move, but the criterion's numerator must drop
  // it - otherwise "closed" would be a statement about the plan rather than about the system. The
  // fabricated lookup deliberately says nothing about the other four, so they stay uncertified.
  const logsTools = [
    "read_system_logs",
    "discover_application_logs",
    "search_application_logs",
    "read_application_log",
    "correlate_sap_logs"
  ]
  const entries = new Map(
    logsTools.map((tool) => [
      tool,
      { status: (tool === "read_application_log" ? "failed" : "verified") as "failed" | "verified" }
    ])
  )
  entries.set("analyze_abap_dumps", { status: "verified" })
  entries.set("diagnose_sap_failure", { status: "verified" })
  const block = opsCapabilityBlock({ entries })

  const logs = block.families.find((family) => family.id === "logs")
  assert.ok(logs)
  assert.equal(logs.state, "read-only", "the structural state must not depend on evidence")
  assert.equal(logs.verification.closed, false)
  assert.deepEqual(logs.verification.blockingTools, ["read_application_log"])

  const dumps = block.families.find((family) => family.id === "dumps")
  assert.ok(dumps)
  assert.equal(dumps.verification.closed, true)
  assert.deepEqual(dumps.verification.blockingTools, [])

  assert.equal(block.summary.registryLoaded, true)
  // Fourteen required families are structurally closed as of 2026-10-01, when `transport` was ruled a
  // platform boundary. The evidence-aware numerator is still 1 here, because the fabricated map
  // certifies only `dumps` - that gap is the point of this test.
  assert.equal(block.summary.stateClosedRequiredFamilyCount, 14)
  assert.equal(block.summary.closedRequiredFamilyCount, 1)
  assert.deepEqual(block.summary.evidenceClosedFamilies, ["dumps"])
  // `landscape` and `runtime-resources` are in this list for a different reason than the rest: they
  // are structurally closed, and the fabricated map simply does not carry their tools, so nothing
  // certifies them here. That is the point of the list - a closed gap is not evidence, and the family
  // has to be named rather than quietly counted. `jobs` and `transport` are the newest members for
  // that same reason.
  assert.deepEqual(block.summary.evidenceUnregisteredFamilies, [
    "transport",
    "jobs",
    "logs",
    "locks",
    "updates",
    "system-info",
    "query",
    "runtime-resources",
    "interfaces",
    "authorizations",
    "spool-output",
    "archive-alerts",
    "landscape"
  ])
  assert.ok(block.summary.outstandingRequiredFamilies.includes("logs"))
  // Only `dumps` is certified by the fabricated map, so thirteen of the fourteen required families
  // are still on the worklist even though all fourteen are structurally closed.
  assert.equal(block.summary.remainingRequiredFamilyCount, 13)
  // The two readings are deliberately both visible, and this is the case that separates them: on the
  // gap-only reading all fourteen required families are closed, so `stateCriterionMet` is true, while
  // the evidence-aware criterion is still false because the fabricated map certifies only `dumps`.
  // That divergence is the whole point of the test - a closed gap is not evidence, so the two verdicts
  // must not be allowed to collapse into one.
  assert.equal(block.summary.criterionMet, false)
  assert.equal(block.summary.stateCriterionMet, true)
  assert.equal(block.summary.endToEndFamilyCount, 14)
  assert.equal(block.summary.endToEndPercentOfRequired, 7)
})

test("the capability report carries the ops block", async () => {
  const report = JSON.parse(await buildCapabilityReport(new MockBackend(), "w200")) as {
    opsCapability?: {
      families: Array<{ id: string; state: string }>
      summary: {
        familyCount: number
        endToEndPercent: number
        registryLoaded: boolean
        criterionBasis: string
        closedRequiredFamilyCount: number
        evidenceUnregisteredFamilies: string[]
        outstandingRequiredFamilies: string[]
        remainingRequiredFamilyCount: number
        endToEndPercentOfRequired: number
        criterionMet: boolean
      }
      vocabulary: { endToEndRule: string; criterionRule: string }
      note: string
    }
  }

  assert.ok(report.opsCapability, "the report has no opsCapability block")
  assert.equal(report.opsCapability.summary.familyCount, Object.keys(EXPECTED_FAMILY_STATES).length)
  assert.equal(report.opsCapability.summary.endToEndPercent, 93)
  assert.match(
    report.opsCapability.vocabulary.endToEndRule,
    /never\s+compensate for a missing action/
  )
  assert.match(report.opsCapability.vocabulary.criterionRule, /every tool in it is `verified`/)
  assert.match(report.opsCapability.note, /never changes an availability or verification verdict/)
  assert.deepEqual(
    Object.fromEntries(report.opsCapability.families.map((family) => [family.id, family.state])),
    EXPECTED_FAMILY_STATES
  )

  // The deployed service reads the real registry, so here - and only here - the criterion's
  // numerator is the families whose gap is empty and whose tools all carry evidence. `runtime-resources`
  // joined that numerator on 2026-09-30: its helper body reached w200, all six of its tools answered
  // for real, and its gap became empty; `query` joined it the same day once its last declared
  // capability was built and its gap was emptied as the result of that work; `authorizations` joined it
  // the same day once its trace-data half was reached through the already-remote-enabled pair and its
  // gap was emptied as the result of that work; `jobs` joined it on 2026-10-01 once both job writes
  // were exercised on the real machine and every one of its eight tools carried evidence, so thirteen
  // of the fourteen required families were certified and one was outstanding. `transport` joined on
  // 2026-10-01 by the operator's platform-boundary ruling on its one unverified tool, so all fourteen
  // required families are certified, nothing is outstanding, and both readings of the criterion are
  // met. This is the assertion that would have caught a family being closed without evidence.
  const summary = report.opsCapability.summary
  assert.equal(summary.registryLoaded, true)
  assert.match(summary.criterionBasis, /verification registry loaded/)
  assert.equal(summary.closedRequiredFamilyCount, 14)
  assert.deepEqual(summary.evidenceUnregisteredFamilies, [])
  assert.equal(summary.remainingRequiredFamilyCount, 0)
  assert.equal(summary.endToEndPercentOfRequired, 100)
  assert.equal(summary.criterionMet, true)
  // The worklist is empty, which is the strongest form of "names neither the exempt family nor an
  // evidence-closed one": at 14/14 there is nothing left to name. Asserted element-wise rather than as
  // a deep-equal against [] because that empty-literal form narrows the array type to never[] and the
  // per-family checks below would then stop compiling against the real candidate names.
  assert.equal(summary.outstandingRequiredFamilies.length, 0)
  assert.ok(
    !summary.outstandingRequiredFamilies.includes("logs") &&
      !summary.outstandingRequiredFamilies.includes("dumps") &&
      !summary.outstandingRequiredFamilies.includes("system-info") &&
      !summary.outstandingRequiredFamilies.includes("interfaces") &&
      !summary.outstandingRequiredFamilies.includes("archive-alerts") &&
      !summary.outstandingRequiredFamilies.includes("traces"),
    "the worklist must name neither the exempt family nor an evidence-closed one"
  )
  // `interfaces` was the last family held out of the numerator by exactly one tool: the SM58 tRFC read
  // whose first real call had not been recorded when this assertion was written. The call landed on
  // 2026-09-28 16:19 (status ok, 140 entries, evidence .doc/code-update-20260928-162050.md), so the
  // family is now closed on both readings and this line becomes the tripwire against a silent
  // regression that would put it back on the worklist.
  assert.deepEqual(summary.outstandingRequiredFamilies.includes("interfaces"), false)
})

/**
 * The 2026-10-02 operator ruling (work package A1) made clause 2 read a not-verified tool the way
 * clause 3 already did: a recorded platform boundary is an exemption, not an open defect. An
 * exemption is the one verdict here whose failure mode is inflating a number, so the negative half
 * of this test is the point of it - every shape that is *not* a recorded boundary has to stay open,
 * including the tempting one (a record that is named but cannot be opened).
 */
test("clause 2 exempts only a platform boundary whose record resolves", () => {
  const tools = [
    "recorded_boundary",
    "named_but_unreadable",
    "still_unverified",
    "failed_runtime",
    "boundary_without_record",
    "unregistered_tool"
  ]
  const entries = new Map([
    [
      "recorded_boundary",
      { status: "platform-unsupported" as const, failureBasis: null, evidence: ".doc/recorded.md" }
    ],
    [
      "named_but_unreadable",
      { status: "platform-unsupported" as const, failureBasis: null, evidence: ".doc/missing.md" }
    ],
    ["still_unverified", { status: "unverified" as const, failureBasis: null, evidence: null }],
    [
      "failed_runtime",
      { status: "failed" as const, failureBasis: "runtime" as const, evidence: ".doc/recorded.md" }
    ],
    [
      "boundary_without_record",
      { status: "platform-unsupported" as const, failureBasis: null, evidence: null }
    ]
  ])
  const split = splitNotVerifiedByRecordedRuling(tools, {
    entries,
    evidenceResolvable: (tool) => entries.get(tool)?.evidence === ".doc/recorded.md"
  })

  assert.deepEqual(split.exempt, ["recorded_boundary"])
  assert.deepEqual(split.open, [
    "named_but_unreadable",
    "still_unverified",
    "failed_runtime",
    "boundary_without_record",
    "unregistered_tool"
  ])

  // Without a resolver the caller cannot tell a cited record from an openable one, so the rule falls
  // back to "a path was cited" - which is why the generator supplies the resolver.
  const withoutResolver = splitNotVerifiedByRecordedRuling(tools, { entries })
  assert.deepEqual(withoutResolver.exempt, ["recorded_boundary", "named_but_unreadable"])

  // The registry the matrix is generated from must satisfy the strict form: every exemption the real
  // document prints names a record this checkout can open.
  const registry = JSON.parse(
    readFileSync(resolve("contracts", "verification-registry.json"), "utf8")
  ) as { entries: VerificationEntry[] }
  const realEntries = new Map(registry.entries.map((entry) => [entry.tool, entry]))
  const realSplit = splitNotVerifiedByRecordedRuling(
    registry.entries.filter((entry) => entry.status !== "verified").map((entry) => entry.tool),
    {
      entries: realEntries,
      evidenceResolvable: (tool) => {
        const entry = realEntries.get(tool)
        return entry !== undefined && resolveEvidencePath(entry) !== undefined
      }
    }
  )
  assert.ok(realSplit.exempt.length > 0, "the document exempts tools, so this loop must run")
  for (const tool of realSplit.exempt) {
    const entry = realEntries.get(tool)
    assert.equal(entry?.status, "platform-unsupported")
    assert.equal(entry?.failureBasis, null)
    assert.notEqual(entry?.evidence, null)
    assert.ok(
      entry !== undefined && resolveEvidencePath(entry),
      `${tool} is exempted but its record cannot be opened`
    )
    assert.ok(!realSplit.open.includes(tool), `${tool} must be exempt or open, never both`)
  }
})
