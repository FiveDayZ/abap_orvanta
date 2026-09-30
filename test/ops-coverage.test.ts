import assert from "node:assert/strict"
import test from "node:test"
import { buildCapabilityReport } from "../src/capabilities.js"
import {
  OPS_FAMILIES,
  OPS_TOOL_ROLES,
  opsCapabilityBlock,
  opsClassificationProblems,
  opsFamilyState,
  type OpsFamilyDefinition
} from "../src/ops-coverage.js"
import { TOOL_REGISTRY } from "../src/tool-registry.js"
import { MockBackend } from "./mock-backend.js"

/**
 * OP0: the ops block is a coverage claim, so the gate has to be able to fail.
 *
 * These assertions are deliberately explicit rather than derived: a family that quietly loses a
 * planned tool, or a tool that stops being read-only, has to break a test that names the expected
 * value. Deriving the expectation from the same table would assert nothing.
 */

const EXPECTED_FAMILY_STATES: Readonly<Record<string, string>> = {
  transport: "partial",
  jobs: "partial",
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
  query: "partial",
  "runtime-resources": "partial",
  interfaces: "read-only",
  authorizations: "partial",
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
 * target (docs/ops-coverage.md 7.19), not because it was built. The four that remain are
 * `create_background_job`, `modify_background_job`, `read_db_activity` and
 * `read_performance_snapshot`.
 */
const PLANNED_GAP_TOOL_COUNT = 4

test("every ops tool has exactly one role and agrees with the registry annotation", () => {
  assert.deepEqual(opsClassificationProblems(), [])

  const opsGroupTools = TOOL_REGISTRY.filter((entry) => entry.group === "ops")
    .map((entry) => entry.name)
    .sort()
  assert.deepEqual(Object.keys(OPS_TOOL_ROLES).sort(), opsGroupTools)
  // 39 from 2026-09-29: `delete_sap_lock` joined the ops group on 2026-09-28, `release_transport_task`
  // joined it on 2026-09-29, and `compare_systems`, `promote_object` and `import_transport_queue`
  // followed the same day in OP3's two batches and OP2's transport import precheck. The count is a
  // tripwire, not a goal - it exists so a tool cannot leave or join the classified surface unnoticed.
  assert.equal(opsGroupTools.length, 39)
})

test("family states are derived from the surface, and the plan's gaps stay visible", () => {
  const states = Object.fromEntries(OPS_FAMILIES.map((item) => [item.id, opsFamilyState(item)]))
  assert.deepEqual(states, EXPECTED_FAMILY_STATES)

  // The families that are closed are closed because nothing has to act on SAP on their behalf.
  // `landscape` is in this list on that exact ground: the operator's 2026-09-29 ruling put the
  // promotion action outside the family's end-to-end, and that limit is recorded as a boundary.
  const closed = Object.entries(states)
    .filter(([, state]) => state === "read-only" || state === "read-and-act")
    .map(([id]) => id)
    .sort()
  assert.deepEqual(closed, [
    "archive-alerts",
    "dumps",
    "interfaces",
    "landscape",
    "locks",
    "logs",
    "spool-output",
    "system-info",
    "updates"
  ])

  // A family may not lose a planned tool without saying so; the guard has to catch that, not just
  // the real tables that currently happen to be consistent.
  // The probe has to name a tool the registry does not know, because that is what "missing planned
  // tool" means. It used to name `release_transport_task`, which stopped being missing on
  // 2026-09-29 - once the tool exists the family is not silently dropping anything, so the guard
  // correctly says nothing and the probe would assert the opposite of the truth. `create_background_job`
  // is still only a plan entry, so the branch stays exercised.
  const brokenFamily = [
    {
      id: "transport",
      label: "Transport",
      purpose: "Which request holds this object?",
      closeRoutes: ["none"] as const,
      plannedToolNames: ["manage_transport_requests", "create_background_job"],
      actionRequired: true,
      gap: ""
    }
  ]
  const problems = opsClassificationProblems({ families: brokenFamily })
  assert.ok(
    problems.some((problem) =>
      /missing planned tool create_background_job but declares no gap/.test(problem)
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
  assert.deepEqual(byId.query!.closeRoutes, ["service"])
  // The DB02 half waits on the helper like the workload half: the platform is the service's to read
  // (RFC_SYSTEM_INFO.RFCDBSYS), but no module it can reach reports activity rather than space.
  assert.deepEqual(byId["runtime-resources"]!.closeRoutes, ["helper"])
  // Recounted on 2026-09-30 from the real table. `locks` and `spool-output` moved to the "none" route
  // on 2026-09-29, `landscape` followed the same day by the operator's ruling, and `updates` joined on
  // 2026-09-30 by the same kind of ruling (its repeat capability is a platform boundary, so it stops
  // waiting on `authorization`): `none` is 9, `authorization` fell 3 -> 2 (the two writers still
  // waiting on a written authorisation are `transport` and `jobs`), and `helper`/`approval`/
  // `landscape`/`platform`/`service` are unchanged. The only family still waiting on the landscape
  // route is `transport`, whose own gap is about importing and is untouched by the landscape ruling.
  assert.equal(block.summary.closeRouteCounts.none, 9)
  assert.equal(block.summary.closeRouteCounts.platform, 1)
  assert.equal(block.summary.closeRouteCounts.service, 1)
  assert.equal(block.summary.closeRouteCounts.approval, 1)
  assert.equal(block.summary.closeRouteCounts.helper, 2)
  assert.equal(block.summary.closeRouteCounts.authorization, 2)
  assert.equal(block.summary.closeRouteCounts.landscape, 1)
  // A claim of unavailability may not survive in the gap text once its source is proven to be ours.
  const runtimeGap = byId["runtime-resources"]!.gap
  assert.match(runtimeGap, /RFCDBSYS/)
  assert.doesNotMatch(runtimeGap, /platform is not readable/)
  assert.doesNotMatch(runtimeGap, /newly approved source for the platform/)

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
    // missing repeat capability is a platform boundary, so the two counts move together.
    partial: 5,
    "read-only": 8,
    "read-and-act": 1
  })
  // `locks` joined the closed families on 2026-09-29, and `landscape` followed the same day by the
  // operator's ruling that its read-only loop is the family's end-to-end, and `spool-output` closed
  // the same day once its only planned tool rendered a page. `updates` followed on 2026-09-30 by the
  // same kind of ruling - its repeat capability is a platform boundary, not a gap - so the gap-only
  // reading is 9 of 15.
  assert.deepEqual(block.summary.endToEndFamilies, [
    "logs",
    "dumps",
    "locks",
    "updates",
    "system-info",
    "interfaces",
    "spool-output",
    "archive-alerts",
    "landscape"
  ])
  assert.equal(block.summary.endToEndFamilyCount, 9)
  assert.equal(block.summary.endToEndPercent, 60)
  assert.ok(
    block.summary.endToEndPercent < 95,
    "the ops surface must not be reported as a 95% coverage milestone while the plan is open"
  )

  // 39 from 2026-09-29: `compare_systems`, `promote_object` and `import_transport_queue` joined the
  // ops group with OP3's two batches and OP2's transport import precheck. All three are readers, so
  // the action and platform-blocked counts below do not move.
  assert.equal(block.summary.classifiedToolCount, 39)
  // Seven action tools from 2026-09-29: `delete_sap_lock` is a destructive write and
  // `release_transport_task` releases a transport task, so both are classified as actions like the
  // two transport writes and the two job writes before them.
  assert.equal(block.summary.actionToolCount, 7)
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
  assert.equal(block.summary.stateClosedRequiredFamilyCount, 9)
  assert.equal(block.summary.closedRequiredFamilyCount, 0)
  assert.deepEqual(block.summary.evidenceUnregisteredFamilies, [
    "logs",
    "dumps",
    "locks",
    "updates",
    "system-info",
    "interfaces",
    "spool-output",
    "archive-alerts",
    "landscape"
  ])
  // The worklist is the evidence-aware one, so with no registry every required family is outstanding
  // even though nine of them are structurally closed - the count does not follow the state count.
  assert.equal(block.summary.remainingRequiredFamilyCount, 14)
  assert.equal(block.summary.criterionMet, false)
  assert.equal(block.summary.stateCriterionMet, false)
  assert.equal(
    block.summary.outstandingRequiredFamilies.length,
    block.summary.requiredEndToEndFamilyCount - block.summary.closedRequiredFamilyCount
  )
  assert.ok(
    !block.summary.outstandingRequiredFamilies.includes("traces"),
    "the worklist must never name the exempt family"
  )

  // A monitor-only family never becomes end-to-end just because a reader exists, and a family that
  // gained writers is still not closed while its own gap stands: jobs reports release and cancel and
  // stays partial because create and modify are still missing.
  const jobs = block.families.find((family) => family.id === "jobs")
  assert.ok(jobs)
  assert.equal(jobs.state, "partial")
  assert.equal(jobs.actionRequired, true)
  assert.deepEqual(jobs.actionTools, ["release_background_job", "cancel_background_job"])
  assert.deepEqual(jobs.missingToolNames, ["create_background_job", "modify_background_job"])

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

  // `transport` gave up the one tool the platform cannot deliver, and the withdrawal is visible in
  // the block instead of the tool quietly leaving it - the family's remaining commitments are what
  // it now waits for.
  const transport = block.families.find((family) => family.id === "transport")
  assert.ok(transport)
  assert.deepEqual(transport.withdrawnToolNames, ["cleanup_transport_entries"])
  assert.ok(!transport.toolNames.includes("cleanup_transport_entries"))
  assert.ok(!transport.verification.blockingTools.includes("cleanup_transport_entries"))
  assert.match(transport.boundary, /withdrawn/)
  assert.match(transport.boundary, /CTS_CLEANUP_POSTCHECK_ENTRY_REMAINS/)
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
  // separately rather than by deletion.
  assert.deepEqual(transport.verification.unverified, [
    "manage_transport_requests",
    "release_transport_task",
    "import_transport_queue"
  ])
  assert.deepEqual(transport.verification.failing, ["add_objects_to_transport"])
  assert.deepEqual(transport.withdrawnToolNames, ["cleanup_transport_entries"])
  assert.ok(!transport.verification.blockingTools.includes("cleanup_transport_entries"))

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
  assert.equal(block.summary.stateClosedRequiredFamilyCount, 9)
  assert.equal(block.summary.closedRequiredFamilyCount, 1)
  assert.deepEqual(block.summary.evidenceClosedFamilies, ["dumps"])
  // `landscape` is in this list for a different reason than the rest: it is structurally closed, and
  // the fabricated map simply does not carry its two tools, so nothing certifies it here. That is the
  // point of the list - a closed gap is not evidence, and the family has to be named rather than
  // quietly counted.
  assert.deepEqual(block.summary.evidenceUnregisteredFamilies, [
    "logs",
    "locks",
    "updates",
    "system-info",
    "interfaces",
    "spool-output",
    "archive-alerts",
    "landscape"
  ])
  assert.ok(block.summary.outstandingRequiredFamilies.includes("logs"))
  // Only `dumps` is certified by the fabricated map, so thirteen of the fourteen required families
  // are still on the worklist even though nine are structurally closed.
  assert.equal(block.summary.remainingRequiredFamilyCount, 13)
  assert.equal(block.summary.criterionMet, false)
  assert.equal(block.summary.stateCriterionMet, false)
  // The two readings are deliberately both visible: a gap-only criterion would have said 8. This is
  // the evidence-aware one, and it is the whole point of the test - only `dumps` survives the
  // fabricated map, so one of the fourteen required families is certified, not eight. Rewriting this
  // to 50 would assert the gap-only number and delete what the test exists to prove.
  assert.equal(block.summary.endToEndFamilyCount, 9)
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
      }
      vocabulary: { endToEndRule: string; criterionRule: string }
      note: string
    }
  }

  assert.ok(report.opsCapability, "the report has no opsCapability block")
  assert.equal(report.opsCapability.summary.familyCount, Object.keys(EXPECTED_FAMILY_STATES).length)
  assert.equal(report.opsCapability.summary.endToEndPercent, 60)
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
  // numerator is the families whose gap is empty and whose tools all carry evidence. `updates`
  // joined that numerator on 2026-09-30: its gap became empty by the operator's boundary ruling and
  // both of its read tools are verified, so nine of the fourteen required families are certified.
  const summary = report.opsCapability.summary
  assert.equal(summary.registryLoaded, true)
  assert.match(summary.criterionBasis, /verification registry loaded/)
  assert.equal(summary.closedRequiredFamilyCount, 9)
  assert.deepEqual(summary.evidenceUnregisteredFamilies, [])
  assert.equal(summary.remainingRequiredFamilyCount, 5)
  assert.equal(summary.endToEndPercentOfRequired, 64)
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
