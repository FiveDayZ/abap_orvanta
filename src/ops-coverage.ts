/**
 * Operations scenario families and per-tool roles (OP0).
 *
 * Why this exists: the capability report could say an `ops` tool was "available" while carrying no
 * statement about which operational scenario the tool actually closes. A tool list is not a coverage
 * claim, and a family that can see a problem but not act on it is not covered by having a reader.
 * This module makes the claim checkable: every `ops` tool gets exactly one role, every tool is filed
 * into the scenario families it serves, and each family's state is **derived** from those facts plus
 * a declared gap - never hand-written, so the report cannot drift away from the registry.
 *
 * Two vocabularies, kept deliberately separate:
 *  - per-tool role:    `read-only` | `action` | `platform-blocked`
 *  - per-family state: `absent` | `blocked` | `partial` | `read-only` | `read-and-act`
 *
 * A family is end-to-end only when its declared `gap` is empty. Monitoring-only reads never
 * compensate for a missing action: the jobs family does not become `read-and-act` because a reader
 * exists - it stays `partial` and the gap names the missing control.
 *
 * The planned tool names below are taken from the operations track of
 * `.doc/orvanta-mcp-capability-buildout-plan-20260917.md` (D1-D9 / G3-1..G3-10) as re-sequenced by
 * `.doc/orvanta-mcp-ops-coverage-assessment-and-next-phase-plan-20260925.md`. A planned name is a
 * commitment to build that tool, not a claim that it exists; `opsClassificationProblems()` refuses
 * to let a family drop one silently.
 */

import { TOOL_REGISTRY, registryEntry } from "./tool-registry.js"
import type { VerificationStatus } from "./verification-registry.js"

/** What one ops tool can do, independent of whether it currently works on a given system. */
export type OpsToolRole = "read-only" | "action" | "platform-blocked"

/**
 * How far one operational scenario family is closed.
 *
 * `partial` is the honest default for "some of it exists": it is never produced by counting tools,
 * only by the declared gap. `blocked` means every present tool is stopped by the platform (for
 * example an endpoint this SAP release does not serve), which is a different statement from
 * "not implemented yet".
 */
export type OpsFamilyState = "absent" | "blocked" | "partial" | "read-only" | "read-and-act"

export interface OpsFamilyDefinition {
  id: string
  label: string
  /** Service tool names this family needs; absent entries are the gap, present ones are the surface. */
  plannedToolNames: readonly string[]
  /** Whether finishing this family requires an action that changes SAP state. */
  actionRequired: boolean
  /** What is still missing before the family can be finished inside the service; empty when closed. */
  gap: string
  /**
   * Written basis for excluding this family from the end-to-end requirement, when the platform - not
   * the plan - makes the family impossible on this release.
   *
   * An exemption is a claim someone has to defend, so it is only accepted for a family whose every
   * present tool is `platform-blocked`, and the text has to say why the platform is the reason. A
   * family that is merely unbuilt, or built but incomplete, is not exempt: it counts against the
   * target. Without this field the block could not state what "95%" is measured over, and an
   * impossible family would silently eat the whole target.
   */
  exemptReason?: string
}

/**
 * One role per `ops`-group tool. Roles are checked against the registry annotations, so a tool that
 * stops being read-only cannot keep a `read-only` role here without failing the gate.
 */
export const OPS_TOOL_ROLES: Readonly<Record<string, OpsToolRole>> = {
  // Transport
  manage_transport_requests: "read-only",
  create_transport_request: "action",
  add_objects_to_transport: "action",
  cleanup_transport_entries: "action",
  // Background jobs (observability only - see the jobs family gap)
  search_background_jobs: "read-only",
  read_background_job_details: "read-only",
  read_background_job_log: "read-only",
  read_background_job_spool: "read-only",
  // System and application logs
  read_system_logs: "read-only",
  discover_application_logs: "read-only",
  search_application_logs: "read-only",
  read_application_log: "read-only",
  correlate_sap_logs: "read-only",
  // Short dumps and runtime traces
  analyze_abap_dumps: "read-only",
  diagnose_sap_failure: "read-only",
  analyze_abap_traces: "platform-blocked",
  // Locks and failed updates
  search_sap_locks: "read-only",
  search_failed_updates: "read-only",
  read_failed_update: "read-only",
  // System baseline
  get_sap_system_info: "read-only",
  read_system_parameters: "read-only",
  // Interfaces and queues
  read_qrfc_queues: "read-only",
  read_idoc_status: "read-only"
}

/**
 * The operational scenario families, mirroring the assessment's family matrix.
 *
 * `plannedToolNames` mixes shipped tools with the tools the plan commits to. Keeping both in one
 * list is what makes `state` derivable: the difference between them *is* the gap, and a family that
 * loses a planned name fails `opsClassificationProblems()` unless the gap is stated.
 */
export const OPS_FAMILIES: readonly OpsFamilyDefinition[] = [
  {
    id: "transport",
    label: "Transport: list, detail, delivery precheck, create, add objects",
    plannedToolNames: [
      "manage_transport_requests",
      "create_transport_request",
      "add_objects_to_transport",
      "cleanup_transport_entries",
      "release_transport_task",
      "import_transport_queue"
    ],
    actionRequired: true,
    gap:
      "Release and import are absent: release_transport_task and import_transport_queue. " +
      "DEV->QAS->PRD promotion still happens outside the service."
  },
  {
    id: "jobs",
    label: "Background jobs: list, detail, job log, spool text, control",
    plannedToolNames: [
      "search_background_jobs",
      "read_background_job_details",
      "read_background_job_log",
      "read_background_job_spool",
      "create_background_job",
      "modify_background_job",
      "release_background_job",
      "cancel_background_job"
    ],
    actionRequired: true,
    gap:
      "No job control: create/modify/release/cancel are absent, so a stuck or missing job is " +
      "reported but never corrected inside the service."
  },
  {
    id: "logs",
    label: "System log (SM21), application logs (SLG1), cross-source correlation",
    plannedToolNames: [
      "read_system_logs",
      "discover_application_logs",
      "search_application_logs",
      "read_application_log",
      "correlate_sap_logs"
    ],
    actionRequired: false,
    gap: ""
  },
  {
    id: "dumps",
    label: "Short dumps (ST22): list and structured diagnosis",
    plannedToolNames: ["analyze_abap_dumps", "diagnose_sap_failure"],
    actionRequired: false,
    gap: ""
  },
  {
    id: "traces",
    label: "Runtime traces",
    plannedToolNames: ["analyze_abap_traces"],
    actionRequired: false,
    gap: "",
    // The assessment's family matrix lists 14 families and allows exactly one written exemption for a
    // family the platform makes impossible (.doc/orvanta-mcp-ops-coverage-assessment-and-next-phase-plan-20260925.md
    // §6). This is that exemption: `analyze_abap_traces` is present but `platform-blocked`, because
    // this release serves no ADT runtime-trace endpoint. Keeping it as its own family - rather than
    // folding it into another one to protect a nicer percentage - is what lets the block report 15
    // families, require 14 of them, and still point at one documented exemption.
    exemptReason:
      "This release serves no ADT runtime-trace endpoint (the trace resources answer 404), so the " +
      "family is platform-blocked rather than unbuilt or incomplete."
  },
  {
    id: "locks",
    label: "Enqueue locks (SM12): search and release",
    plannedToolNames: ["search_sap_locks", "delete_sap_lock"],
    actionRequired: true,
    gap: "Locks can be listed but never released; a blocking lock must be cleared in SAP GUI."
  },
  {
    id: "updates",
    label: "Failed updates (SM13): search, detail, reprocess",
    plannedToolNames: ["search_failed_updates", "read_failed_update", "reprocess_failed_update"],
    actionRequired: true,
    gap: "Failed updates can be read but never reprocessed."
  },
  {
    id: "system-info",
    label:
      "System baseline: client role and change protection, release, components, kernel/DB, parameters",
    // `read_patch_level` and `read_client_settings` were dropped from this plan rather than built:
    // `get_sap_system_info` already reports the client's SCC4 role and cross-client change protection,
    // and CVERS.EXTRELEASE is published verbatim per component while being deliberately *not*
    // interpreted as a support-package level (docs/system-info.md). Committing to tools whose data is
    // already reachable, or whose semantics the project declined to fix, would inflate the gap.
    plannedToolNames: ["get_sap_system_info", "read_system_parameters"],
    actionRequired: false,
    gap:
      "Reported: client role and cross-client change protection (SCC4), system type, release, the " +
      "standard-time UTC offset, CVERS.EXTRELEASE per component verbatim, the kernel release and the " +
      "database system from the kernel's own RFC_SYSTEM_INFO answer, and profile parameters and profile " +
      "headers (RZ10/RZ11) through read_system_parameters. Still absent: the database *release* - " +
      "RFC_SYSTEM_INFO.RFCDATABS is typed SYSYSID (SAP system name) on this release, the same data " +
      "element RFCSYSID uses, so it is returned verbatim and never read as a version, and no other " +
      "source this service can reach reports one."
  },
  {
    id: "query",
    label: "Ad-hoc troubleshooting queries over allowlisted tables",
    plannedToolNames: ["read_abap_table", "execute_data_query"],
    actionRequired: false,
    gap:
      "The native data preview endpoint is platform-unsupported on this release, so only the " +
      "single-table fallback path works: up to 8 disjuncts of up to 8 comparisons joined by AND " +
      "over =, <>, <, <=, >, >=; COUNT/SUM/MIN/MAX with GROUP BY over a complete read; and " +
      "ORDER BY applied only over a complete read. No joins, expressions or subqueries, so a " +
      "question that needs two tables at once is not possible."
  },
  {
    id: "runtime-resources",
    label:
      "Work processes (SM50/SM66), sessions (SM04), performance (ST03/STAD), DB (DB02), files (AL11)",
    plannedToolNames: [
      "read_work_processes",
      "read_user_sessions",
      "read_performance_snapshot",
      "read_db_activity",
      "read_file_system_directory"
    ],
    actionRequired: false,
    gap: "No work-process, session, performance, database-activity or file-system tool exists at all."
  },
  {
    id: "interfaces",
    label: "Interface and queue monitoring: qRFC/tRFC, IDoc, email",
    plannedToolNames: ["read_qrfc_queues", "read_idoc_status", "read_email_queue"],
    actionRequired: false,
    gap:
      "Reported: outbound and inbound qRFC/tRFC queue state (TRFCQOUT/TRFCQIN/TRFCQSTATE) " +
      "through read_qrfc_queues, and IDoc control and status records (EDIDC/EDIDS) through " +
      "read_idoc_status. Still absent: the email queue - SOST is not on the approved allowlist, " +
      "so read_email_queue needs a separate approval before it can be implemented."
  },
  {
    id: "authorizations",
    label: "User and authorization troubleshooting (SUIM read, ST01/SU53 trace)",
    plannedToolNames: ["read_user_authorizations", "read_authorization_trace"],
    actionRequired: false,
    gap:
      "No user or authorization tool exists at all, so the most common operations ticket " +
      '("user reports missing authorization") is a blind spot.'
  },
  {
    id: "spool-output",
    label: "Spool output formats: text, OTF/PDF, printing, original report execution",
    plannedToolNames: ["read_background_job_spool"],
    actionRequired: false,
    gap:
      "Only rendered text is available: OTF/PDF conversion, printing and original report " +
      "execution are absent."
  },
  {
    id: "archive-alerts",
    label: "Archive administration (SARA) and CCMS alerts (RZ20)",
    plannedToolNames: ["read_archive_status", "read_ccms_alerts"],
    actionRequired: false,
    gap: "No archive-status or CCMS alert tool exists at all."
  },
  {
    id: "landscape",
    label: "Multi-system landscape: compare systems and promote objects",
    plannedToolNames: ["compare_systems", "promote_object"],
    actionRequired: true,
    gap:
      "One connection is pinned as the validated landscape, with no DEV/QAS/PRD roles, so neither " +
      "system comparison nor promotion exists."
  }
]

/** Role of one tool: declared for `ops` tools, annotation-derived for the rest. */
export function opsToolRole(tool: string): OpsToolRole | undefined {
  const declared = OPS_TOOL_ROLES[tool]
  if (declared) return declared
  const annotations = registryEntry(tool)?.annotations
  if (!annotations) return undefined
  return annotations.readOnlyHint === true ? "read-only" : "action"
}

export function opsToolNamesForFamily(definition: OpsFamilyDefinition): string[] {
  return definition.plannedToolNames.filter((tool) => registryEntry(tool) !== undefined)
}

export function missingOpsToolNamesForFamily(definition: OpsFamilyDefinition): string[] {
  return definition.plannedToolNames.filter((tool) => registryEntry(tool) === undefined)
}

/**
 * Derive one family's state.
 *
 * Order matters: "nothing but blocked tools" is a platform statement and outranks a gap, and a
 * declared gap outranks the presence of an action tool, because having a writer is not the same as
 * having the writer this family needs.
 */
export function opsFamilyState(definition: OpsFamilyDefinition): OpsFamilyState {
  const present = opsToolNamesForFamily(definition)
  if (present.length === 0) return "absent"
  if (present.every((tool) => opsToolRole(tool) === "platform-blocked")) return "blocked"
  if (definition.gap.trim() !== "") return "partial"
  return definition.actionRequired ? "read-and-act" : "read-only"
}

/**
 * Consistency problems between this module, the registry and the declared gaps.
 *
 * Empty array means the classification is trustworthy. The gate test calls this, and
 * {@link opsCapabilityBlock} refuses to publish a block when it is non-empty: an ops block that
 * silently drops a tool or a family is worse than no block, because it looks like an answer.
 *
 * The optional overrides exist so the guard itself can be falsified: a test that only ever runs the
 * real tables cannot show that a broken family would be caught.
 */
export function opsClassificationProblems(
  overrides: {
    families?: readonly OpsFamilyDefinition[]
    roles?: Readonly<Record<string, OpsToolRole>>
  } = {}
): string[] {
  const families = overrides.families ?? OPS_FAMILIES
  const roles = overrides.roles ?? OPS_TOOL_ROLES
  const problems: string[] = []
  const opsGroupTools = TOOL_REGISTRY.filter((entry) => entry.group === "ops").map(
    (entry) => entry.name
  )

  for (const tool of opsGroupTools) {
    if (!(tool in roles)) {
      problems.push(`ops tool ${tool} has no role in OPS_TOOL_ROLES`)
    }
  }

  for (const [tool, role] of Object.entries(roles)) {
    const entry = registryEntry(tool)
    if (!entry) {
      problems.push(`OPS_TOOL_ROLES names unregistered tool ${tool}`)
      continue
    }
    if (entry.group !== "ops") {
      problems.push(`${tool} is classified as an ops tool but its registry group is ${entry.group}`)
    }
    if (role === "read-only" && entry.annotations.readOnlyHint !== true) {
      problems.push(`${tool} has role read-only but is not readOnlyHint in the registry`)
    }
    if (role === "action" && entry.annotations.readOnlyHint === true) {
      problems.push(`${tool} has role action but is readOnlyHint in the registry`)
    }
  }

  const familyIds = new Set<string>()
  const filed = new Set<string>()
  for (const definition of families) {
    if (familyIds.has(definition.id)) problems.push(`duplicate ops family id ${definition.id}`)
    familyIds.add(definition.id)

    for (const tool of definition.plannedToolNames) {
      filed.add(tool)
      const registered = registryEntry(tool) !== undefined
      if (registered) {
        if (opsToolRole(tool) === undefined) {
          problems.push(`family ${definition.id} names ${tool}, which has no derivable role`)
        }
      } else if (definition.gap.trim() === "") {
        problems.push(`family ${definition.id} is missing planned tool ${tool} but declares no gap`)
      }
    }

    const state = opsFamilyState(definition)
    if (definition.exemptReason !== undefined) {
      if (definition.exemptReason.trim() === "") {
        problems.push(`family ${definition.id} claims an exemption with an empty reason`)
      }
      if (state !== "blocked") {
        problems.push(
          `family ${definition.id} claims a platform exemption but its state is ${state}: only a ` +
            "family whose every present tool is platform-blocked can be exempt from the target"
        )
      }
    }
    if (
      state === "read-and-act" &&
      !definition.plannedToolNames.some(
        (tool) => registryEntry(tool) !== undefined && opsToolRole(tool) === "action"
      )
    ) {
      problems.push(`family ${definition.id} is read-and-act without any action tool present`)
    }
    if (state === "absent" && definition.gap.trim() === "") {
      problems.push(`family ${definition.id} has no tool and declares no gap`)
    }
  }

  for (const tool of opsGroupTools) {
    if (!filed.has(tool)) problems.push(`ops tool ${tool} is not filed into any scenario family`)
  }

  return problems
}

/** Minimal read-only view of the evidence dimension; {@link VerificationLookup} satisfies it. */
export interface OpsVerificationLookup {
  entries: ReadonlyMap<string, { status: VerificationStatus }>
}

export interface OpsFamilyRollup {
  id: string
  label: string
  state: OpsFamilyState
  actionRequired: boolean
  /** True when the platform, not the plan, makes this family impossible on this release. */
  exempt: boolean
  exemptReason: string
  toolNames: string[]
  missingToolNames: string[]
  readTools: string[]
  actionTools: string[]
  platformBlockedTools: string[]
  verification: {
    verified: string[]
    unverified: string[]
    failing: string[]
    /**
     * True when every present tool carries recorded evidence. An empty family is never closed:
     * `[].every(...)` is true, but "no tool exists" is the opposite of a closed family.
     */
    closed: boolean
    /** Present tools that keep this family from being evidence-closed (empty when closed). */
    blockingTools: string[]
  }
  gap: string
}

export interface OpsCapabilityBlock {
  vocabulary: {
    toolRole: string
    familyState: string
    endToEndRule: string
    criterionRule: string
    exemptionRule: string
  }
  families: OpsFamilyRollup[]
  summary: {
    familyCount: number
    stateCounts: Record<OpsFamilyState, number>
    /** The state dimension: families whose declared gap is empty. */
    endToEndFamilyCount: number
    endToEndPercent: number
    endToEndFamilies: string[]
    /**
     * The families the completion criterion is measured over: the assessment's matrix minus the
     * documented exemptions. With one exemption this is 14 of 15, which is where the objective's
     * "14 families at 95%" comes from.
     */
    requiredEndToEndFamilyCount: number
    requiredEndToEndPercent: number
    /** End-to-end progress against the required families, not against all families. */
    endToEndPercentOfRequired: number
    /** How many more required families have to close before the criterion is met. */
    remainingRequiredFamilyCount: number
    /** The required families that are still open - the worklist the criterion is waiting on. */
    outstandingRequiredFamilies: string[]
    exemptFamilies: string[]
    /**
     * Whether the evidence dimension was available while building the block. A packaged build ships
     * without `contracts/`, so this is false there and nothing can be certified closed.
     */
    registryLoaded: boolean
    /** What the criterion was decided on; states out loud when evidence could not be consulted. */
    criterionBasis: string
    /** Families that are structurally closed and whose every present tool carries evidence. */
    evidenceClosedFamilyCount: number
    evidenceClosedFamilies: string[]
    /** Required families closed on the gap alone, ignoring evidence - the weaker reading. */
    stateClosedRequiredFamilyCount: number
    /** The criterion's numerator: required families closed on the gap *and* on evidence. */
    closedRequiredFamilyCount: number
    /**
     * Structurally closed families that the evidence point keeps out of the numerator. This list is
     * the difference between "the tools exist" and "the tools were shown to work", and it is empty
     * whenever the open families are still open for structural reasons anyway.
     */
    evidenceUnregisteredFamilies: string[]
    /** The same floor test the criterion applies, but over the state dimension alone. */
    stateCriterionMet: boolean
    criterionMet: boolean
    actionToolCount: number
    platformBlockedToolCount: number
    classifiedToolCount: number
    missingPlannedToolCount: number
    missingPlannedTools: string[]
  }
  note: string
}

const FAILING_STATUSES: readonly VerificationStatus[] = [
  "failed",
  "blocked",
  "platform-unsupported"
]

/**
 * Build the report block.
 *
 * Throws on an inconsistent classification instead of publishing a partly-true block: the data is
 * static, so an inconsistency is a programming error, not a runtime condition.
 */
export function opsCapabilityBlock(lookup?: OpsVerificationLookup): OpsCapabilityBlock {
  const problems = opsClassificationProblems()
  if (problems.length > 0) {
    throw new Error(`Operations coverage classification is inconsistent: ${problems.join("; ")}`)
  }

  const statusOf = (tool: string): VerificationStatus =>
    lookup?.entries.get(tool)?.status ?? "unverified"

  const families: OpsFamilyRollup[] = OPS_FAMILIES.map((definition) => {
    const present = opsToolNamesForFamily(definition)
    const roles = new Map(present.map((tool) => [tool, opsToolRole(tool)]))
    const verified = present.filter((tool) => statusOf(tool) === "verified")
    const blockingTools = present.filter((tool) => statusOf(tool) !== "verified")
    return {
      id: definition.id,
      label: definition.label,
      state: opsFamilyState(definition),
      actionRequired: definition.actionRequired,
      exempt: definition.exemptReason !== undefined,
      exemptReason: definition.exemptReason ?? "",
      toolNames: present,
      missingToolNames: missingOpsToolNamesForFamily(definition),
      readTools: present.filter((tool) => roles.get(tool) === "read-only"),
      actionTools: present.filter((tool) => roles.get(tool) === "action"),
      platformBlockedTools: present.filter((tool) => roles.get(tool) === "platform-blocked"),
      verification: {
        verified,
        unverified: present.filter((tool) => statusOf(tool) === "unverified"),
        failing: present.filter((tool) => FAILING_STATUSES.includes(statusOf(tool))),
        // A family with no tools at all is not closed: absence is the opposite of coverage, and an
        // `every` over an empty list would otherwise report it as satisfied.
        closed: present.length > 0 && blockingTools.length === 0,
        blockingTools
      },
      gap: definition.gap
    }
  })

  const stateCounts: Record<OpsFamilyState, number> = {
    absent: 0,
    blocked: 0,
    partial: 0,
    "read-only": 0,
    "read-and-act": 0
  }
  for (const family of families) stateCounts[family.state]++

  const isStateClosed = (family: OpsFamilyRollup): boolean =>
    family.state === "read-only" || family.state === "read-and-act"
  const endToEndFamilies = families.filter(isStateClosed).map((family) => family.id)
  const exemptFamilies = families.filter((family) => family.exempt).map((family) => family.id)
  const requiredFamilies = families.filter((family) => !family.exempt)
  // The plan's criterion has two points: the family's declared gap is empty, and every tool in it
  // carries evidence of a real call. Counting the first alone would let a family be declared closed
  // on the strength of tools that were never exercised - the exact claim this block exists to
  // prevent - so the criterion's numerator requires both, and the state-only reading is kept beside
  // it as `stateClosedRequiredFamilyCount`/`stateCriterionMet` rather than being conflated with it.
  const stateClosedRequiredFamilyCount = requiredFamilies.filter(isStateClosed).length
  const evidenceUnregisteredFamilies = requiredFamilies
    .filter((family) => isStateClosed(family) && !family.verification.closed)
    .map((family) => family.id)
  const closedRequiredFamilyCount =
    stateClosedRequiredFamilyCount - evidenceUnregisteredFamilies.length
  const outstandingRequiredFamilies = requiredFamilies
    .filter((family) => !isStateClosed(family) || !family.verification.closed)
    .map((family) => family.id)
  // 95% of the required families, rounded up: a fraction of a family cannot be closed, so the
  // criterion never rounds in the service's favour.
  const requiredEndToEndFamilyCount = requiredFamilies.length
  const criterionFloor = Math.ceil(requiredEndToEndFamilyCount * 0.95)
  const evidenceClosedFamilies = families
    .filter((family) => isStateClosed(family) && family.verification.closed)
    .map((family) => family.id)
  const registryLoaded = lookup !== undefined
  const missingPlannedTools = [
    ...new Set(families.flatMap((family) => family.missingToolNames))
  ].sort()
  const roles = Object.values(OPS_TOOL_ROLES)

  return {
    vocabulary: {
      toolRole:
        "read-only (observes) | action (changes SAP state) | platform-blocked (this release does not serve it)",
      familyState:
        "absent (no tool) | blocked (every present tool is stopped by the platform) | " +
        "partial (a declared gap remains) | read-only (closed, no action needed) | " +
        "read-and-act (closed, read and action both present)",
      endToEndRule:
        "A family counts as end-to-end only when its declared gap is empty. Monitoring reads never " +
        "compensate for a missing action, so a family that can see a problem but not act on it " +
        "stays partial.",
      criterionRule:
        "The completion criterion needs both points on the same required family: the declared gap " +
        "is empty *and* every tool in it is `verified` in the verification registry. A closed gap " +
        "with unexercised tools does not count, because that is a statement about the plan rather " +
        "than about the system. When the registry cannot be read - a packaged build ships without " +
        "`contracts/` - nothing is certified closed and the block says so in `criterionBasis` " +
        "instead of guessing.",
      exemptionRule:
        "The completion criterion is measured over the families the plan can actually close: a " +
        "family is exempt only when every one of its tools is platform-blocked *and* it carries a " +
        "written reason why the platform is the obstacle. An unbuilt or incomplete family is never " +
        "exempt, and the block refuses to publish an exemption without a blocked state."
    },
    families,
    summary: {
      familyCount: families.length,
      stateCounts,
      endToEndFamilyCount: endToEndFamilies.length,
      endToEndPercent: Math.round((endToEndFamilies.length / families.length) * 100),
      endToEndFamilies,
      requiredEndToEndFamilyCount,
      requiredEndToEndPercent: 95,
      endToEndPercentOfRequired: Math.round(
        (closedRequiredFamilyCount / requiredEndToEndFamilyCount) * 100
      ),
      remainingRequiredFamilyCount: outstandingRequiredFamilies.length,
      outstandingRequiredFamilies,
      exemptFamilies,
      registryLoaded,
      criterionBasis: registryLoaded
        ? "gap empty + every tool verified (verification registry loaded)"
        : "gap only: verification registry unavailable, so no family can be certified closed",
      evidenceClosedFamilyCount: evidenceClosedFamilies.length,
      evidenceClosedFamilies,
      stateClosedRequiredFamilyCount,
      closedRequiredFamilyCount,
      evidenceUnregisteredFamilies,
      stateCriterionMet: stateClosedRequiredFamilyCount >= criterionFloor,
      criterionMet: closedRequiredFamilyCount >= criterionFloor,
      actionToolCount: roles.filter((role) => role === "action").length,
      platformBlockedToolCount: roles.filter((role) => role === "platform-blocked").length,
      classifiedToolCount: roles.length,
      missingPlannedToolCount: missingPlannedTools.length,
      missingPlannedTools
    },
    note:
      "This block states what the operations surface can close, not whether a helper is deployed: " +
      "it never changes an availability or verification verdict. Family state is derived from the " +
      "tool registry plus the declared gap; the criterion's numerator additionally requires " +
      "recorded evidence for every tool in the family, so the numbers move only when the surface " +
      "does and the evidence is registered. `endToEndPercent` is over all families; " +
      "`endToEndPercentOfRequired` and `criterionMet` are over the required ones, which is the " +
      "reading the assessment's 95% criterion uses."
  }
}
