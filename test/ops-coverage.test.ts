import assert from "node:assert/strict"
import test from "node:test"
import { buildCapabilityReport } from "../src/capabilities.js"
import {
  OPS_FAMILIES,
  OPS_TOOL_ROLES,
  opsCapabilityBlock,
  opsClassificationProblems,
  opsFamilyState
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
  locks: "partial",
  updates: "partial",
  "system-info": "partial",
  query: "partial",
  "runtime-resources": "absent",
  interfaces: "absent",
  authorizations: "absent",
  "spool-output": "partial",
  "archive-alerts": "absent",
  landscape: "absent"
}

/** The plan's outstanding tool commitments; adding one to the plan must update this number. */
const PLANNED_GAP_TOOL_COUNT = 23

test("every ops tool has exactly one role and agrees with the registry annotation", () => {
  assert.deepEqual(opsClassificationProblems(), [])

  const opsGroupTools = TOOL_REGISTRY.filter((entry) => entry.group === "ops")
    .map((entry) => entry.name)
    .sort()
  assert.deepEqual(Object.keys(OPS_TOOL_ROLES).sort(), opsGroupTools)
  assert.equal(opsGroupTools.length, 20)
})

test("family states are derived from the surface, and the plan's gaps stay visible", () => {
  const states = Object.fromEntries(OPS_FAMILIES.map((item) => [item.id, opsFamilyState(item)]))
  assert.deepEqual(states, EXPECTED_FAMILY_STATES)

  // The two families that are closed are closed because nothing has to act on SAP on their behalf.
  const closed = Object.entries(states)
    .filter(([, state]) => state === "read-only" || state === "read-and-act")
    .map(([id]) => id)
    .sort()
  assert.deepEqual(closed, ["dumps", "logs"])

  // A family may not lose a planned tool without saying so; the guard has to catch that, not just
  // the real tables that currently happen to be consistent.
  const brokenFamily = [
    {
      id: "transport",
      label: "Transport",
      plannedToolNames: ["manage_transport_requests", "release_transport_task"],
      actionRequired: true,
      gap: ""
    }
  ]
  const problems = opsClassificationProblems({ families: brokenFamily })
  assert.ok(
    problems.some((problem) =>
      /missing planned tool release_transport_task but declares no gap/.test(problem)
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
      plannedToolNames: ["search_background_jobs"],
      actionRequired: false,
      gap: "",
      exemptReason: "looks hard"
    },
    {
      id: "logs",
      label: "Logs",
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

test("the block counts only families with an empty gap as end-to-end", () => {
  const block = opsCapabilityBlock()

  assert.equal(block.summary.familyCount, Object.keys(EXPECTED_FAMILY_STATES).length)
  assert.deepEqual(block.summary.stateCounts, {
    absent: 5,
    blocked: 1,
    partial: 7,
    "read-only": 2,
    "read-and-act": 0
  })
  assert.deepEqual(block.summary.endToEndFamilies, ["logs", "dumps"])
  assert.equal(block.summary.endToEndFamilyCount, 2)
  assert.equal(block.summary.endToEndPercent, 13)
  assert.ok(
    block.summary.endToEndPercent < 95,
    "the ops surface must not be reported as a 95% coverage milestone while the plan is open"
  )

  assert.equal(block.summary.classifiedToolCount, 20)
  assert.equal(block.summary.actionToolCount, 3)
  assert.equal(block.summary.platformBlockedToolCount, 1)
  assert.equal(block.summary.missingPlannedToolCount, PLANNED_GAP_TOOL_COUNT)
  assert.equal(block.summary.missingPlannedToolCount, block.summary.missingPlannedTools.length)

  // The criterion is stated in the block, not left to the reader: the assessment's matrix has 14
  // families, the surface carries 15 because the platform-blocked trace family is its own family,
  // and that family is the one documented exemption. So 14 families have to close - the number the
  // objective names - and 2 of 14 is 14%, not the 13% that dividing by 15 would give.
  assert.deepEqual(block.summary.exemptFamilies, ["traces"])
  assert.equal(block.summary.requiredEndToEndFamilyCount, 14)
  assert.equal(block.summary.requiredEndToEndPercent, 95)
  assert.equal(block.summary.endToEndPercentOfRequired, 0)

  // This call passes no registry, which is the packaged-build case: the two structurally closed
  // families cannot be certified, so the criterion's numerator is zero and the block says why
  // instead of quietly falling back to the gap-only reading.
  assert.equal(block.summary.registryLoaded, false)
  assert.match(block.summary.criterionBasis, /registry unavailable/)
  assert.equal(block.summary.stateClosedRequiredFamilyCount, 2)
  assert.equal(block.summary.closedRequiredFamilyCount, 0)
  assert.deepEqual(block.summary.evidenceUnregisteredFamilies, ["logs", "dumps"])
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

  // A monitor-only family never becomes end-to-end just because a reader exists.
  const jobs = block.families.find((family) => family.id === "jobs")
  assert.ok(jobs)
  assert.equal(jobs.state, "partial")
  assert.equal(jobs.actionRequired, true)
  assert.deepEqual(jobs.actionTools, [])
  assert.deepEqual(jobs.missingToolNames, [
    "create_background_job",
    "modify_background_job",
    "release_background_job",
    "cancel_background_job"
  ])

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
  // treating them as separate future tools would inflate the gap.
  const systemInfo = block.families.find((family) => family.id === "system-info")
  assert.ok(systemInfo)
  assert.deepEqual(systemInfo.toolNames, ["get_sap_system_info"])
  assert.deepEqual(systemInfo.missingToolNames, ["read_system_parameters"])
  assert.match(systemInfo.gap, /kernel and database release/)
  assert.match(systemInfo.gap, /never RFC_SYSTEM_INFO/)
})

test("the block joins with the evidence dimension without changing it", () => {
  const block = opsCapabilityBlock({
    entries: new Map([
      ["create_transport_request", { status: "verified" as const }],
      ["manage_transport_requests", { status: "unverified" as const }],
      ["cleanup_transport_entries", { status: "failed" as const }]
    ])
  })

  const transport = block.families.find((family) => family.id === "transport")
  assert.ok(transport)
  assert.deepEqual(transport.verification.verified, ["create_transport_request"])
  // `add_objects_to_transport` is present in the family but absent from the fabricated lookup, so it
  // is unverified - the default, not an accusation.
  assert.deepEqual(transport.verification.unverified, [
    "manage_transport_requests",
    "add_objects_to_transport"
  ])
  assert.deepEqual(transport.verification.failing, ["cleanup_transport_entries"])

  // No lookup at all is the packaged-build case: everything is unverified, nothing is implied.
  const withoutRegistry = opsCapabilityBlock()
  const logs = withoutRegistry.families.find((family) => family.id === "logs")
  assert.ok(logs)
  assert.deepEqual(logs.verification.verified, [])
  assert.equal(logs.verification.unverified.length, logs.toolNames.length)
})

test("a closed gap does not certify a family whose tools were never exercised", () => {
  // `logs` and `dumps` are the two families whose declared gap is empty, so both are structurally
  // closed. Here every logs tool is verified except one, which is marked failed: the family state
  // must not move, but the criterion's numerator must drop it - otherwise "closed" would be a
  // statement about the plan rather than about the system.
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
  assert.equal(block.summary.stateClosedRequiredFamilyCount, 2)
  assert.equal(block.summary.closedRequiredFamilyCount, 1)
  assert.deepEqual(block.summary.evidenceClosedFamilies, ["dumps"])
  assert.deepEqual(block.summary.evidenceUnregisteredFamilies, ["logs"])
  assert.ok(block.summary.outstandingRequiredFamilies.includes("logs"))
  assert.equal(block.summary.remainingRequiredFamilyCount, 13)
  assert.equal(block.summary.criterionMet, false)
  assert.equal(block.summary.stateCriterionMet, false)
  // The two readings are deliberately both visible: a gap-only criterion would have said 2.
  assert.equal(block.summary.endToEndFamilyCount, 2)
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
  assert.equal(report.opsCapability.summary.endToEndPercent, 13)
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
  // numerator is the two families whose gap is empty and whose tools all carry evidence.
  const summary = report.opsCapability.summary
  assert.equal(summary.registryLoaded, true)
  assert.match(summary.criterionBasis, /verification registry loaded/)
  assert.equal(summary.closedRequiredFamilyCount, 2)
  assert.deepEqual(summary.evidenceUnregisteredFamilies, [])
  assert.equal(summary.remainingRequiredFamilyCount, 12)
  assert.equal(summary.endToEndPercentOfRequired, 14)
  assert.ok(
    !summary.outstandingRequiredFamilies.includes("logs") &&
      !summary.outstandingRequiredFamilies.includes("dumps") &&
      !summary.outstandingRequiredFamilies.includes("traces"),
    "the worklist must name neither the exempt family nor an evidence-closed one"
  )
})
