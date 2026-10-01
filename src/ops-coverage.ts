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

/**
 * Who has to act before a family can close.
 *
 * A family's `gap` says what is missing; this says who can remove it, which is the difference
 * between work this service can still do on its own and work that needs an operator decision. It is
 * a closed vocabulary rather than prose so the acceptance matrix can group families by route - "four
 * families are waiting on the SAP-side helper, three on a write authorisation" - and so the guard can
 * refuse a family that declares a gap and no route to removing it.
 */
export type OpsCloseRoute =
  | "none"
  | "service"
  | "helper"
  | "approval"
  | "authorization"
  | "landscape"
  | "platform"

export interface OpsFamilyDefinition {
  id: string
  label: string
  /**
   * The operational question this family answers, in one line. Without it the matrix can only say
   * "jobs is partial", which is not a statement anyone can act on: the purpose is what makes a
   * missing capability legible as a missing answer rather than a missing tool.
   */
  purpose: string
  /**
   * Who can remove the declared gap. Empty gaps close with `none`; an exempt family names the
   * platform. Several routes may apply to one family, and listing them keeps the matrix honest about
   * the fact that, for example, releasing a transport needs a write authorisation while importing
   * one additionally needs a second system to exist.
   */
  closeRoutes: readonly OpsCloseRoute[]
  /** Service tool names this family needs; absent entries are the gap, present ones are the surface. */
  plannedToolNames: readonly string[]
  /**
   * Names this family once declared and deliberately gave up, with the reason in {@link boundary}.
   *
   * A withdrawal has to stay visible: dropping a name from {@link plannedToolNames} alone would take
   * the tool out of the ops block entirely, and the block refuses to publish a classification that
   * silently loses a tool. A withdrawn name therefore still counts as filed - it keeps the guard's
   * "every ops tool serves a scenario" invariant true - while it stops being a commitment, so a tool
   * the platform will never satisfy cannot keep its family open forever. It is not a way to empty a
   * gap: a family may only withdraw a name it has stopped claiming, and the boundary has to say why.
   */
  withdrawnToolNames?: readonly string[]
  /** Whether finishing this family requires an action that changes SAP state. */
  actionRequired: boolean
  /** What is still missing before the family can be finished inside the service; empty when closed. */
  gap: string
  /**
   * What this family deliberately does not answer, because the platform or the target's own data
   * makes it impossible rather than unbuilt - a live CCMS state ALALERTDB does not hold, a file
   * detail with no sample left to describe.
   *
   * Boundaries belong here and never in {@link gap}: a gap is capability still to be built and counts
   * against the target, while a boundary is a limit that will not move and would otherwise keep a
   * finished family open forever. The two are different claims, so they are different fields, and the
   * matrix prints the boundaries beside the family whether or not it is closed. Empty when the family
   * declares none.
   */
  boundary?: string
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
  // N3 / OP2. The first action tool this family has ever had.
  release_background_job: "action",
  // N3 / OP2. The destructive half of job control: the helper proves the outcome by re-reading TBTCO
  // and finding nothing, so a cancellation that leaves the row behind is a failure.
  cancel_background_job: "action",
  // N3 / OP2. Creating a job changes the batch scheduler: it adds a row SAP will later execute, which
  // is a state change even though it destroys nothing.
  create_background_job: "action",
  // N3 / OP2. Modification rewrites the schedule, the target user or the step list of a scheduled job,
  // so it changes SAP state without being destructive - which is why it is `W` and not `D` in the
  // registry.
  modify_background_job: "action",
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
  // OP2 / locks. Built 2026-09-28 with the SM12 release arm and verified 2026-09-29 by a real
  // release on w200 (LOCK_DELETED, absence read back twice), so the family states no gap.
  delete_sap_lock: "action",
  // OP2 / transport. Release is a state-changing CTS operation and irrational to repeat, so it is
  // an action.
  release_transport_task: "action",
  // OP2 / transport. The import precheck asks SAP's own checks for a label and establishes nothing
  // about the callee's mode: the helper passes SAP's simulate mode, and the first real calls on w200
  // (2026-09-29) came back with the callee's own messages about starting tp and about a request's
  // import having already run, so "returns before tp" is SAP's documented behaviour rather than
  // something observed here. It stays read-only because it creates, changes and applies nothing.
  import_transport_queue: "read-only",
  search_failed_updates: "read-only",
  read_failed_update: "read-only",
  // Archive administration (SARA) and CCMS alerts (RZ20)
  read_archive_status: "read-only",
  read_ccms_alerts: "read-only",
  // System baseline
  get_sap_system_info: "read-only",
  read_system_parameters: "read-only",
  // Interfaces and queues
  read_qrfc_queues: "read-only",
  read_idoc_status: "read-only",
  // The capability that refilled the interfaces slot on 2026-09-28 (SM58 tRFC error queue).
  read_trfc_error_entries: "read-only",
  // Users and authorizations
  read_user_authorizations: "read-only",
  // The role side of the same family: AGR_1251/AGR_1252/AGR_PROF (+ the UST10S/UST10C profile path
  // behind a flag), which is what makes "what is assigned to them" answerable from the role.
  read_role_authorizations: "read-only",
  read_authorization_trace: "read-only",
  // Runtime resources: the work process, session and filesystem reads (SM50/SM66, SM04, AL11), the
  // two metrics reads (DB02, ST03) and the workload-collector directory.
  read_work_processes: "read-only",
  read_user_sessions: "read-only",
  read_file_system_directory: "read-only",
  read_db_activity: "read-only",
  read_performance_snapshot: "read-only",
  read_workload_directory: "read-only",
  // OP3 / landscape. Comparison and the promotion precheck are built, read-only and verified against
  // two real systems; by the operator's ruling of 2026-09-29 this read-only loop is the family's
  // end-to-end, so the deliberately absent promotion action is a boundary rather than a gap.
  compare_systems: "read-only",
  promote_object: "read-only"
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
    label: "Transport: list, detail, delivery precheck, create, add objects, release",
    plannedToolNames: [
      "manage_transport_requests",
      "create_transport_request",
      "add_objects_to_transport",
      "import_transport_queue"
    ],
    // Withdrawn on 2026-09-28 by the operator's ruling (option A), with the platform evidence in the
    // boundary. It stays listed here so the classification does not lose an ops tool; what changed is
    // that the family no longer waits for a resource this release does not serve.
    withdrawnToolNames: ["cleanup_transport_entries", "release_transport_task"],
    purpose: "Which request holds this object, what is in it, and is it ready to hand over?",
    // No closure route is declared because nothing in this family is still waiting: the two tools
    // that are not verified were both withdrawn by an operator ruling, and their boundaries are
    // stated below rather than parked behind a route. OP2/OP3 were the routes that would have
    // carried the remaining work; with the work ruled a platform boundary, they have nobody left to
    // wait for, which the classification guard enforces.
    closeRoutes: ["none"],
    actionRequired: true,
    // Empty only because the family is structurally complete: both tools that are not verified have
    // left plannedToolNames by an operator ruling and are explained in `boundary` below. Neither is a
    // silent drop, and neither claims a verification that did not happen - release_transport_task
    // keeps refusing honestly and stays registered platform-unsupported in the verification registry.
    gap: "",
    boundary:
      "cleanup_transport_entries was withdrawn from this family on 2026-09-28 by the operator's ruling, and the withdrawal is recorded rather than hidden: the tool still exists and still refuses to lie. On 2026-09-24 it located the entry, passed its own pre-checks with two structurally different payloads, saw the PUT answer 2xx, re-read E071 and found the target row still present, and reported CTS_CLEANUP_POSTCHECK_ENTRY_REMAINS instead of success. The native ADT removeobject resource that would be needed is missing from this release, which is why the entry is registered platform-unsupported (D2 ruling, .doc/code-update-20260925-223946.md, forensics in .doc/code-update-20260924-105614.md): a capability the platform cannot deliver, not work still to be done. Leaving it declared as a commitment would have kept this family open permanently, which is what a boundary exists to prevent. release_transport_task was withdrawn from this family on 2026-10-01 by the operator's ruling, and the withdrawal is recorded rather than hidden. Four of the five tools the family declared are verified and keep serving the scenario; what is ruled out of reach is one link in the fifth, established by reading the source of SAP itself rather than by inference. A release of the requests this service creates cannot avoid a physical export: TRINT_RELEASE_REQUEST (137 lines, sha256 931d02ad...) branches only on trfunction and on whether a target system is present, so a workbench request WITH a target always falls into the ELSE branch that calls TRINT_TRANSPORT_REQUEST, which calls TRINT_EXPORT_ON_OS_LEVEL unconditionally, and that function accepts no input that suppresses the export. An earlier belief of this project, that the SE09 dialog reaches a released status through a branch that skips the export, is wrong and has been withdrawn: the dialog runs the same export. That export runs the OS-level transport control program tp, which is an operating-system program rather than a SAP object, and tp is out of reach in this environment. It exists as an AIX executable at /usr/sap/GR2/SYS/exe/run/tp belonging to an intact 2014-05-12 kernel set, and the TMS domain configuration is present, but no transport log has been written since 2014-02-02, and a genuine release performed by the operator on 2026-10-01 moved GR2K923527 to TRSTATUS = R without writing any SLOG/ALOG and without producing any R*/K* file, so E070 status alone never proved that tp ran. Repairing this needs root or gr2adm on the AIX application server and S_CTS_ADMI in STMS, and the operator is not a Basis administrator and has no operating-system access. The tool is registered platform-unsupported with the full reasoning and its evidence in contracts/verification-registry.json: a capability this environment cannot deliver, not work still to be done. It is kept and still refuses honestly, answering an already-released request with TRANSPORT_NOT_MODIFIABLE and otherwise reporting the callee's own TRANSPORT_EXPORT_FAILED; the entry is re-promoted if the tp environment is ever repaired. What the family does deliver and has proven on the machine is unchanged: the task-level arm releases for real (task GR2K923528 reached TRSTATUS = R) and add_objects_to_transport writes for real (insertedCount = 1)."
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
    purpose: "Did the job run, what did it do, and why is a job stuck or missing?",
    // Nothing is outstanding, so there is no route left to wait on: the "authorization" route this
    // family used to declare was the operator's standing authorization for the two job writes, and it
    // was granted and exercised. The validator enforces exactly that - an empty gap may not keep a
    // closure route, because a family with nothing missing has nobody left to wait for.
    closeRoutes: ["none"],
    actionRequired: true,
    // Closed 2026-10-01 by the eighth batch. The gap that stood here listed two commitments - the
    // helper arms were not deployed and the write gate had no branch for create or modify - and both
    // are settled rather than removed from the text: the arms are live (Z_ORVANTA_MCP_DYNPRO_API
    // self-describes 2.21 with JOB_CREATE/JOB_MODIFY_HEADER/JOB_MODIFY_STEP in its capability table,
    // and its sourceHash matches the exported body), the write gate covers create and modify
    // (src/write-prechange-evidence.ts), and the eight tools in this family are all verified against
    // one real-machine run: create, both modify arms, release and cancel through
    // .cache/r100-jobs-acceptance.mjs (11/11, failures 0), and the four reads. Two defects in the
    // operational helper had to be fixed first and were fixed in the same batch: make_time aborted
    // the whole function module from inside a macro, which made every job that had not finished
    // unreadable, and the JOB_LOG arm answered an empty job log with the same unsupported default. A
    // gap that is empty is the result of that work, not a claim made in its place: the evidence is
    // .doc/code-update-20261001-135303.md and docs/ops-coverage.md section 7.25.
    gap: ""
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
    purpose: "What does the system log or an application log say about a reported failure?",
    closeRoutes: ["none"],
    actionRequired: false,
    gap: ""
  },
  {
    id: "dumps",
    label: "Short dumps (ST22): list and structured diagnosis",
    plannedToolNames: ["analyze_abap_dumps", "diagnose_sap_failure"],
    purpose: "Why did the program dump, and what failed first?",
    closeRoutes: ["none"],
    actionRequired: false,
    gap: ""
  },
  {
    id: "traces",
    label: "Runtime traces",
    plannedToolNames: ["analyze_abap_traces"],
    purpose: "What did one execution actually do, statement by statement?",
    closeRoutes: ["platform"],
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
    purpose: "Who holds the lock that is blocking an object or document right now?",
    closeRoutes: ["none"],
    actionRequired: true,
    gap: ""
  },
  {
    id: "updates",
    label: "Failed updates (SM13): search and detail",
    plannedToolNames: ["search_failed_updates", "read_failed_update"],
    purpose: "Which update terminated, and what does the failed update contain?",
    closeRoutes: ["none"],
    actionRequired: false,
    gap: "",
    // Reclassified from gap to boundary on 2026-09-30 by the operator's ruling, on the strength of a
    // feasibility investigation of `reprocess_failed_update` (docs/ops-coverage.md 7.19, record
    // .doc/code-update-20260930-091414.md). The investigation measured that the capability has no
    // caller-usable interface on this target at all, which is a property of the platform rather than
    // a commitment still to be built - so it belongs in the boundary, where the project keeps fixed
    // limits. Nothing was removed to make a number move: the missing capability is unchanged and is
    // stated in full below, and the withdrawn tool name is not claimed as built anywhere.
    boundary:
      "Repeating (reprocessing) a failed update is not offered, because on this target no source this " +
      "service can reach exposes it to a caller without a SAP GUI. SM13's own restart logic is dialog " +
      "code inside the module pool RSM13000 (the FORMs behind 'V1-und V2-Nachverbuchung anstarten' and " +
      "'Einzelne V2-Nachverbuchung anstarten', the latter read at RSM13000:2735), and it runs on the " +
      "kernel call CALL 'ThVBCall' (opcodes SELECT_VB_SERVER and START_VB) plus a direct " +
      "`UPDATE VBHDR SET VBRC = VB_RUN_V2 VBNAME = ...` with `commit work`; those FORMs also terminate " +
      "on dialog messages, including the type-A message MESSAGE A210 at RSM13000:6645, which aborts an " +
      "RFC session instead of returning. The only remote-enabled entry point named for a parameterized " +
      "SM13 call, UPD_CALL_SM13 (function group FBUP, remoteMode R), ends in " +
      "`CALL TRANSACTION 'SM13'`, and an RFC session cannot run a dialog transaction. TH_START_V2 " +
      "(function group THFB) is not remote-enabled and starts V2 collectively from selection ranges " +
      "rather than repeating one request, and TH_REORG_VB deletes old requests rather than repeating " +
      "them. Name searches for a single-request repeat found nothing in FUNC/FUGR/PROG " +
      "(*VB*REPEAT*, *UPDATE*RESTART*, *RESTART_VB*, *VB*RESTART*, *NACHVERBUCH*, *UPDATE*REQUEST*, " +
      "*REPROCESS*, TH_*V2*). Everything the family's purpose names - which update terminated, and " +
      "what the failed update contains - is served by search_failed_updates and read_failed_update, " +
      "both verified on 2026-09-30 against the one real failed update on client 200."
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
    purpose:
      "Which release, kernel, patch level, client settings and profile parameters is this system running?",
    closeRoutes: ["none"],
    actionRequired: false,
    gap: "",
    // Reclassified from gap to boundary on 2026-09-28 by the operator's ruling: both declared tools
    // are verified, and what remained was a fixed property of the target rather than capability still
    // to be built. Nothing here was removed to make a number move - the missing datum is unchanged
    // and is stated in full.
    boundary:
      "The database *release* is not reported, and no source this service can reach on this target " +
      "supplies it: RFC_SYSTEM_INFO.RFCDATABS is typed SYSYSID (SAP system name) on this release, " +
      "the same data element RFCSYSID uses, so it is published verbatim as the database system and " +
      "never read as a version. Everything else the family's purpose names - client role and " +
      "cross-client change protection (SCC4), system type, release, the standard-time UTC offset, " +
      "CVERS.EXTRELEASE per component verbatim, the kernel release, the database system from the " +
      "kernel's own RFC_SYSTEM_INFO answer, and profile parameters and headers (RZ10/RZ11) through " +
      "read_system_parameters - is answered today."
  },
  {
    id: "query",
    label: "Ad-hoc troubleshooting queries over allowlisted tables",
    plannedToolNames: ["read_abap_table", "execute_data_query"],
    purpose: "Ask an ad-hoc read-only question across the allowlisted tables without SAP GUI.",
    closeRoutes: ["none"],
    actionRequired: false,
    // The last declared capability of this family - an uncorrelated scalar subquery in a comparison -
    // was built on 2026-09-30, so the family declares no gap. Emptying it is the *result* of that work
    // and not a way of reaching the criterion: the five capabilities before it (projection terms, a
    // term on either side of a `WHERE` comparison, a term over a joined projection, the
    // `IN (SELECT ...)` set test and the joins themselves) were built first, and the four earlier
    // slices were then read on w200 through read-only verify scripts. What the dialect still does not
    // answer is stated as a boundary below, together with the evidence behind what it does answer.
    gap: "",
    boundary:
      "The native data preview endpoint is platform-unsupported on this release, so only the " +
      "fallback dialect works: up to 8 disjuncts of up to 8 comparisons joined by AND over =, <>, " +
      "<, <=, >, >=; COUNT/SUM/MIN/MAX with GROUP BY over a complete read; ORDER BY applied only " +
      "over a complete read; an optional LIMIT, which must be the last clause and bounds the answer " +
      "after the order rather than the read; and, since 2026-09-26 and extended on 2026-09-30, " +
      "INNER, LEFT, RIGHT, FULL and CROSS joins over up to three " +
      "allowlisted tables on equality keys, with every column reference qualified. The positive " +
      "join path is proven on w200 as of 2026-09-30: SELECT A.TRKORR, B.AS4TEXT FROM E070 A INNER " +
      "JOIN E07T B ON A.TRKORR = B.TRKORR WHERE A.TRSTATUS = 'R' answered one joined row " +
      "(GR2K900199 / WF_20121016_workflow function group 03) over the fallback dialect " +
      "(rfc_read_table, join.joinedRows 1, onKeys B.TRKORR = A.TRKORR), recorded in " +
      ".cache/join-positive-ok.json and .doc/code-update-20260930-121500.md. The three earlier " +
      "read-only attempts of the same statement - the 2026-09-27 sweeps .cache/evidence-ops-n1b and " +
      ".cache/evidence-ops-n1c and the 2026-09-28 sweep .cache/evidence-ops-r23-readonly - ended in " +
      "a transport-layer `socket hang up`; that failure was an artifact of a long-running MCP " +
      "instance and did not reproduce after the 4849 restart at 2026-09-30 12:00:55. The negative " +
      "control remains proven too (a join on the unapproved MARA is refused with TABLE_NOT_ALLOWED " +
      "before SAP is touched, in all runs). An earlier version of this paragraph asserted the " +
      "positive path had been proven on 2026-09-27; that assertion came from prose rather than from " +
      "a record and was withdrawn on 2026-09-28 (.doc/code-update-20260928-155820.md), and it is " +
      "not the basis of the claim made here. " +
      "Right, full and cross joins and LIMIT were added on 2026-09-30 (record " +
      ".doc/code-update-20260930-154027.md): a right join preserves the side it introduces, a full " +
      "join preserves both, a cross join takes no ON clause at all, and LIMIT is applied after " +
      "ORDER BY so the order decides which rows it bounds. An outer join must still be the last " +
      "join, and a WHERE predicate is refused on whichever side that join does not preserve, " +
      "because every predicate is pushed into the read of the table it names; a literal in ON is " +
      "confined to a side the join is free to drop for the same reason (the table it introduces " +
      "for INNER and LEFT, a table joined before it for RIGHT, neither side for FULL). " +
      "An arithmetic term in the projection was then taken up under the user's 2026-09-30 ruling " +
      "(route A: the term is implemented in the service, not reclassified as a platform boundary, " +
      "because this release offers no channel that evaluates one). A term is + - * / with " +
      "parentheses and a unary minus, over the table's own columns and integer or packed literals; " +
      "the operand types are read from DD03L, so the calculation rule is the documented SAP one " +
      "rather than a guess from the reader's one-character field type; the term publishes a derived " +
      "column EXPR_1, EXPR_2 ... in projection order, which querySource.expressionColumns lists; and " +
      "a term that cannot be computed exactly is refused by name instead of approximated " +
      "(TABLE_QUERY_EXPRESSION_NOT_NUMERIC, _FLOAT, _DECFLOAT, _DIVISION_SCALE, _DIVISION_BY_ZERO, " +
      "_OVERFLOW, _NOT_INTEGER, _TYPE_UNKNOWN, _TYPE_UNAVAILABLE, _DICTIONARY_UNAVAILABLE, " +
      "_CONSTANT, _GROUPED). A term on the left side of a WHERE comparison was added next, in the " +
      "same session: the reader's structured filter takes one column name, so such a comparison " +
      "cannot be pushed and is decided in the service over the rows of its own disjunct, with the " +
      "same dictionary-derived types and the same exact-or-refuse rule, compared as exact decimals " +
      "(TABLE_QUERY_WHERE_EXPRESSION_LITERAL refuses a term compared with something that is not a " +
      "number); a disjunct that carries one must have been read completely, because the matches of a " +
      "sample are not the matches of the statement, and a truncated one is refused with " +
      "TABLE_QUERY_WHERE_EXPRESSION_INCOMPLETE rather than filtered, while a plain comparison stays " +
      "pushed down so SAP's own comparison remains authoritative. Which disjunct carried which term " +
      "is published as querySource.whereExpressions. A term over a qualified column in a joined " +
      "projection was taken up last, in the same session: the term is evaluated on the joined row, " +
      "each operand is typed from the dictionary of the table its alias names (only the aliases a term " +
      "actually reads are resolved), the operand columns are read but not published, the derived " +
      "column joins the published set beside the projected qualified columns, and a term over the " +
      "optional side of an outer join refuses the unmatched row instead of reading its empty value as " +
      "a zero. A term is still refused together with an aggregate or a GROUP BY, and ORDER BY cannot " +
      "name a derived column in the joined dialect because every ordering key there is qualified. All " +
      "three parts were proven locally first - the suite grew to 1256 tests and thirty-eight mutations " +
      "of the three wirings and of the set test were falsified - and the four slices behind them were " +
      "then read on w200 in the same session, after the user restarted 127.0.0.1:4849 onto the build " +
      "that carries them: the four read-only verify scripts hold 6 + 5 + 5 + 6 = 22 assertions and all " +
      "22 pass (.cache/r29-verify.json, r31, r33, r35, record " +
      ".doc/code-update-20260930-193631.md). An earlier run of the same four scripts read 16 of 22 and " +
      "the six failures turned out to be defects of the acceptance harness, not of the service - an " +
      "assertion that demanded a JSON payload from a refusal that is text, a sampled value that was " +
      "legitimately an exact decimal, and an outer row bound below the table's own row count - and both " +
      "readings are preserved (record .doc/code-update-20260930-192647.md, probe .cache/r36-probe.json) " +
      "rather than the later one being reported alone. A set test was taken up last, in the same " +
      "session: " +
      "<column> IN (SELECT <column> FROM <table> [WHERE ...]) is read as its own statement by this same " +
      "grammar, its values form the set, and the outer row matches when its own value is in that set - " +
      "NOT IN is the complement. The reader's structured filter has no set operator, so the test is " +
      "decided in the service, over a read that completed (TABLE_QUERY_WHERE_SUBQUERY_INCOMPLETE " +
      "otherwise) and over a set that completed (TABLE_QUERY_SUBQUERY_INCOMPLETE): a row whose value is " +
      "outside a sample is not a row whose value is outside the set. The two sides are compared as " +
      "values rather than as text - the dictionary type of both decides the class, character fields " +
      "compare with trailing blanks ignored and numeric fields as exact decimals - and a pair this " +
      "layer cannot compare (a floating-point field, a mixed pair, a type in neither class, an empty " +
      "numeric value) is refused by name (TABLE_QUERY_SUBQUERY_TYPE, _FLOAT, _VALUE, _TYPE_UNKNOWN, " +
      "_TYPE_UNAVAILABLE) instead of being compared as printed text, and an inner statement that is not " +
      "one plain column is refused with TABLE_QUERY_SUBQUERY_PROJECTION (a limited or ordered page is " +
      "not a set). Which disjunct carried which test, on which column, with how many values, is " +
      "published as querySource.whereSubqueries; the tested column is read but not published when the " +
      "statement does not select it. A scalar subquery was taken up last, in the same session: " +
      "<column> <operator> (SELECT ...) is read as its own statement by this same grammar and the outer " +
      "row matches when the comparison with the one value it answers holds. The inner statement must " +
      "answer exactly one row - one aggregate over no groups, or one plain column whose read returned " +
      "one row - and everything else is refused by name rather than answered: several rows " +
      "(TABLE_QUERY_SCALAR_ROWS; this layer will not pick one of them and answer a different question), " +
      'no row (the same code: SQL reads that as NULL and answers "unknown", a three-valued rule this ' +
      "layer does not reproduce), a projection that is neither one aggregate nor one plain column " +
      "(TABLE_QUERY_SCALAR_PROJECTION), and an ordered or limited page (TABLE_QUERY_SCALAR_PAGE; a page " +
      "is not a value, and a LIMIT 1 would hide the several rows this layer refuses to choose between). " +
      "The comparison is the same one the set test makes and follows the same discipline: the class " +
      "comes from the dictionary type of both sides, character fields compare with trailing blanks " +
      "ignored and numeric fields as exact decimals, and a pair this layer cannot compare is refused by " +
      "name (TABLE_QUERY_SCALAR_TYPE, _FLOAT, _VALUE, _TYPE_UNKNOWN, _TYPE_UNAVAILABLE) instead of being " +
      "compared as printed text; ordering a character value is refused as well " +
      "(TABLE_QUERY_SCALAR_ORDER), because SAP orders character fields by a collation this layer cannot " +
      "state, so only = and <> are decided there. The inner statement is typed from its own table's " +
      "dictionary - COUNT answers the INT4 this layer computes, SUM/MIN/MAX answer the type of the " +
      "column they aggregate - and the value the inner statement answered is published as " +
      "querySource.whereScalars: unlike a set, which the mapping counts rather than repeats because it " +
      "can be arbitrarily large, a scalar is one value. A scalar comparison decided over an outer read " +
      "that stopped at the row bound is refused with TABLE_QUERY_WHERE_SCALAR_INCOMPLETE rather than " +
      "filtered, the same rule the term and the set test follow. The slice was then read on w200 too, " +
      "after the user restarted 127.0.0.1:4849 onto the build that carries it: .cache/r38-verify.mjs " +
      "holds 13 assertions and all 13 pass (output .cache/r38-verify.json), so every declared " +
      "capability of this family now has a real-machine reading. That reading settled two facts this " +
      "text states: an aggregate answers a value without naming a column, so querySource.whereScalars " +
      "reports valueColumn null for ZAEHL = (SELECT COUNT(*) ...) where a single-column inner " +
      "statement names the column it read; and a whole-row read of T006 - which is what an unfiltered " +
      "aggregate over that table performs - is refused by the decode guard with " +
      "TABLE_QUERY_NUMERIC_OVERFLOW. A read-only follow-up of that refusal " +
      "(.cache/r39-probe1|3|4|6|7.mjs, 2026-09-30) located its cause in the data and in the field's " +
      "text width rather than in a guard drawn too narrow: of T006's 276 rows 274 decode (273 carry " +
      "ADDKO 0.000000 and one 9.000000, every text 8 characters) and exactly two do not - MSEHI GC " +
      "and FA, the two rows whose DIMID is TEMP, whose ZAEHL/NENNR are 1/1 and 5/9 and whose EXP10, " +
      "EXPON, DECAN and TEMP_VALUE are all zero, so the additive conversion constant they carry can " +
      "only live in ADDKO. ADDKO is DEC 9/6 and the reader's own field metadata gives it a " +
      "9-character text box, while the Celsius and Fahrenheit constants those rows carry need ten " +
      "characters, so the text cannot be a plain decimal; the guard refuses it by name, and since it " +
      "accepts every digit-led decimal of that width (the 274 rows read back prove it), a silently " +
      "truncated decimal would have been published rather than refused. The refusal is therefore " +
      "correct and stays: a caller who needs the rest of the table excludes those two keys with a " +
      "pushed character comparison, while a whole-row read - SELECT * or an unfiltered aggregate - " +
      "necessarily includes them. Since 2026-09-30 that refusal also carries the evidence needed to " +
      "locate it: TABLE_QUERY_NUMERIC_OVERFLOW names the column that could not be decoded, the " +
      "untrimmed text the reader took out of that column's box, and the row's primary key as far as " +
      "the projection carries the table's key columns (a projection that carries none leaves the key " +
      "absent rather than inventing one). The untrimmed text is the point: the guard fires on the " +
      "trimmed value, so which of its two clauses named the refusal - replacement text carrying an " +
      "asterisk, or a form it does not accept as a plain decimal - is readable from the evidence " +
      "itself, and a whole-row read of T006 GC and FA is the one reading left that still needs a real " +
      "call to settle it. What no reading changes is the outcome: the width argument already shows " +
      "that the value those two rows carry cannot be printed in that field's box at all, so no " +
      "decoded numeric value is withheld - there is none to withhold. That is also why this family's " +
      "verify scripts project one " +
      "column or filter to a small match set instead of reading that table whole. A join read is also " +
      "bounded: an ORDER BY over a read that stops at the row bound is refused with " +
      "TABLE_QUERY_ORDER_BY_INCOMPLETE rather than sorted partially, and LIMIT does not excuse that " +
      "refusal - completeness is judged over the whole match set before the limit is applied. " +
      "A correlated subquery - one whose inner statement refers to the outer row - is outside this " +
      "layer's method rather than a task still to be done: the method establishes one set (or one " +
      "value) with one complete read, while a correlated inner statement has to be planned and " +
      "evaluated per outer row by the database, and this release offers no channel that evaluates one " +
      "(the native preview endpoint is unsupported, and the reader takes one column, one operator and " +
      "one literal). Open SQL beyond the finite grammar is bounded for the same reason - HAVING, " +
      "UNION, DISTINCT, CASE, functions other than COUNT/SUM/MIN/MAX, non-equality join keys, more " +
      "than three joined tables: the layer reproduces only what the documented rules let it state " +
      "exactly, and guessing the rest would answer a different question than the one that was written. " +
      "Such a statement is left to the platform's own error, which on this release is the empty-HTML " +
      "answer."
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
      "read_file_system_directory",
      "read_workload_directory"
    ],
    purpose:
      "Which work processes and sessions are live, what is on the application server's filesystem, and what performance data exists?",
    // Closed on 2026-09-30. The helper body that carries the five 1.1 opcodes (WP_LIST, USER_LIST,
    // DIR_LIST, DB_ACTIVITY, PERF_SNAPSHOT) reached w200 and all six tools have since been called for
    // real, so the gap that used to name the undeployed body is empty and the route is `none`.
    // `read_user_sessions` was the last one to move: its branch had been calling TH_USER_LIST with
    // only the optional USRLIST table, while the module's ACTIVE interface declares LIST (UINFO) as a
    // NON-optional table parameter, so the dynamic call died with CX_SY_DYN_CALL_PARAM_MISSING
    // (record .doc/code-update-20260930-143501.md). Nothing was removed to make a number move: the
    // body really is deployed, verified by its own fingerprint, and each of the six tools has a real
    // w200 reply behind its registry entry.
    //
    // The route rationale is kept here as a comment rather than as a gap, because it is why the
    // helper exists rather than capability still to be built. Five of the six tools are helper-backed
    // through the separately approved RUNTIME scope of Z_ORVANTA_OPS_READ. The two metrics reads have
    // no direct path at all: the DB6 tables are outside the service-side table allowlist, and the
    // system-load row type cannot be serialized to an external RFC caller. The three kernel reads
    // were moved onto the same helper on 2026-09-30, after all three were measured answering zero
    // rows through their direct SOAP-RFC path on w200 (.doc/runtime-resources-helper-plan.md
    // section 1.1, evidence .cache/evidence-ops-runtime-20260930/). Every remote-enabled read
    // carrying the workload numbers refuses to serialize: SWNC_COLLECTOR_GET_AGGREGATES,
    // SWNC_GET_WORKLOAD_SNAPSHOT, SWNC_GET_WORKLOAD_STATISTIC, SWNC_READ_SNAPSHOT and
    // SAPWLN3_AGGREGATE_SNAPSHOT_GET expose SWNCGL_T_AGG* rows whose field names or scalar types
    // (SWNCTASKTYPERAW) fail verification, and SWNC_STATREC_READ cannot return NORMAL_RECORDS, the
    // record header that gives a subrecord its user and response time. SWNC_COLLECTOR_KERNEL_STAT is
    // locally callable but not remote-enabled, and it must not be used in any case because it runs a
    // collection and commits; the helper branch calls SWNC_COLLECTOR_GET_SYSTEMLOAD instead.
    // read_workload_directory is the exception: it still calls its function module directly and
    // answers today.
    closeRoutes: ["none"],
    actionRequired: false,
    gap: "",
    // What this family deliberately does not answer, as opposed to what was left unbuilt. The
    // RFCDBSYS sentence is kept because an earlier gap wrongly claimed the platform was unreadable;
    // the correction stays visible here rather than in a gap that no longer exists.
    boundary:
      "The DB02 half of this family is answered from a vendor-specific source rather than from a " +
      "vendor-neutral activity module. The platform is readable: RFC_SYSTEM_INFO returns RFCDBSYS " +
      "(data element SYDBSYS, the central database system) through the fingerprint-pinned reader " +
      "whose kernel and database values get_sap_system_info already publishes as serverFacts, so " +
      "nothing here waits on an approval the service cannot grant itself. What is missing is a module " +
      "that reports activity: the storage and statistics modules that probing reached " +
      "(DB02_ORA_SELECT_SEGMENTS, DB02_ORA_LAST_ANALYZED, DB02_GET_EXTENT_LIST_DB2) are remote-enabled " +
      "but answer for space and analysis - the Oracle pair reads " +
      "dba_tab_columns.last_analyzed/sample_size/num_rows, statistics freshness rather than activity - " +
      "DB02_DB_ACTIVITY was not found by name, and the vendor-neutral DB_AN_DB_KPIS requires a CCMS " +
      "node handle (MT_TOOL_INFO typed ALTLEXDESC) and raises MESSAGE e001(sada) when it cannot read " +
      "one, so an external caller can neither supply its context nor survive its failure. DB02 is " +
      "split by database vendor (DB02_ORA_*, DB02_*_DB2, DB6_*), so read_db_activity reads the DB6 " +
      "history tables and this family is answered on a DB6 target. Two further limits are fixed: " +
      "every helper-backed read here is bounded by the helper's own row cap (200 rows for the " +
      "work-process, session and directory reads), so a longer result is reported as partial with " +
      "truncated set rather than returned in full; and read_workload_directory answers with the " +
      "collector's own index of the aggregates it holds, not with the workload numbers inside them."
  },
  {
    id: "interfaces",
    label: "Interface and queue monitoring: qRFC/tRFC, IDoc",
    plannedToolNames: ["read_qrfc_queues", "read_idoc_status", "read_trfc_error_entries"],
    purpose: "Is an outbound or inbound queue stuck, and did the IDoc arrive?",
    closeRoutes: ["none"],
    actionRequired: false,
    gap: "",
    // Two operator rulings on 2026-09-28, recorded rather than hidden: the mail-queue claim was
    // withdrawn because the only source can mislead, and the vacant slot was then refilled with a
    // capability the approved tables genuinely did not already answer. Adding a tool that duplicated
    // read_qrfc_queues (which already returns TRFCQSTATE per-LUW detail) or read_idoc_status (EDIDC
    // plus EDIDS) was refused as counting, not coverage.
    boundary:
      "The outbound-mail question - is mail piling up here - is not answered, and no tool claims to. " +
      "read_email_queue was withdrawn from this family on 2026-09-28 by the operator's ruling, " +
      "because SOST *was* approved and registered and its read path does work: the same date's " +
      "read-only forensics (.doc/code-update-20260928-093237.md) show the table carries no live " +
      "traffic on w200 - every row is SNDART='INT' and DIRECTION='S', STA_ORDER is empty " +
      "throughout, and no row is dated later than 2014-12-01 - so a tool reading it would have " +
      "reported a frozen 2013-2014 internal SAPoffice send log as the present, which is the " +
      "misleading-tool failure this project forbids. The slot was refilled in the same ruling-set " +
      "not by removing the claim but by naming a capability the approved tables did not already " +
      "answer: the SM58 tRFC error queue through read_trfc_error_entries, which reads ARFCSSTATE " +
      "and answers whether an outgoing tRFC LUW is stuck in error. ARFCSSTATE was registered on " +
      "2026-09-28; its sibling payload table ARFCSDATA was approved in the same ruling and then " +
      "deliberately NOT registered, because ARFCBLCNT (RAW 4) plus ARFCDATA01..07 (RAW 255 each) " +
      "have no character column at all and the joined row is far past the 512-character limit this " +
      "read path accepts - the tRFC payload is therefore a declared boundary of the read path, not " +
      "a silently missing row of the allowlist. " +
      "qRFC/tRFC queue state (TRFCQOUT/TRFCQIN/TRFCQSTATE) through read_qrfc_queues and IDoc control " +
      "and status records (EDIDC/EDIDS) through read_idoc_status were already covered."
  },
  {
    id: "authorizations",
    label: "User and authorization troubleshooting (SUIM read, ST01/SU53 trace)",
    plannedToolNames: [
      "read_user_authorizations",
      "read_role_authorizations",
      "read_authorization_trace"
    ],
    purpose: "Why did this user's transaction fail on authorization, and what is assigned to them?",
    closeRoutes: ["none"],
    actionRequired: false,
    gap: "",
    boundary:
      "Reported: the stored role assignments per user (AGR_USERS), the transactions of a " +
      "role (AGR_TCODES) and the profile assignments of a user master record (UST04) through " +
      "read_user_authorizations - assignment master data, never an authorization decision - " +
      "the role itself resolved into the authorization objects, fields and values it stores " +
      "(AGR_1251/AGR_1252, the profiles it generates from AGR_PROF and the UST10S/UST10C profile " +
      "path behind a flag) through read_role_authorizations, and the kernel's authorization trace " +
      "through read_authorization_trace: both the switch (AUTH_TRACE_GET_STATUS.RC) and SAP's own " +
      "trace-result rows from USOB_AUTHVALTRC, reached through the remote-enabled pair " +
      "AUTH_TRACE_GET_AUTHVAL_KEY / AUTH_TRACE_GET_AUTHVAL_DATA in the same SAUTHTRACE function " +
      "group. No SAP-side helper and no operator allowlist entry is involved in any of the three: " +
      "the trace table itself is outside the D5-2 table allowlist, so the two function modules are " +
      "the route, the same way read_workload_directory reaches its data. Declared limits, none of " +
      "them a missing tool. (1) The 16-bit FIELDSUSED vector of a trace row (XUBITVEC16, RAW 2) is " +
      "returned verbatim and is deliberately not decoded into a list of used fields: the " +
      "bit-to-slot mapping is applied on a path this service cannot read, and SAUTHTRACE contains " +
      "no decoder - its only two readers select the row and pass it on, and the group's generated " +
      "RFC wrappers only declare the parameters. The checked values themselves are in FIELD1..FIELD9 " +
      "and FIELD0 and are returned as stored. (2) A trace that was never switched on leaves the " +
      "table empty, and w200's switch reads 'not active'; an empty answer therefore means no trace " +
      "record was stored, never that the capability is missing. (3) Nothing here starts, stops, " +
      "clears or activates a trace, and no row of the trace is written, changed or deleted - the " +
      "whole family is read-only, and no tool in it states that a user is or is not authorized."
  },
  {
    id: "spool-output",
    label: "Spool output formats: text, OTF/PDF, printing, original report execution",
    plannedToolNames: ["read_background_job_spool"],
    purpose:
      "What is actually in a spool request: the rendered text, the OTF/PDF, or the original report's output?",
    closeRoutes: ["none"],
    actionRequired: false,
    gap: "",
    boundary:
      "Declared limits, none of them a missing tool. (1) Rendered text is the only format this " +
      "family ever planned, and since 2026-09-29 it works: read_background_job_spool returns the " +
      "primary job-step spool as text - spool 12717 of ZTEST/09381400 rendered three lines " +
      "(.doc/code-update-20260929-192300.md) - and is verified. (2) OTF/PDF conversion, printing " +
      "and original report execution stay absent and will not be added: each needs SAP GUI print " +
      "or report-execution machinery outside the read-only loop, which this service deliberately " +
      "does not drive, so a caller that needs the formatted page prints it in SAP GUI."
  },
  {
    id: "archive-alerts",
    label: "Archive administration (SARA) and CCMS alerts (RZ20)",
    plannedToolNames: ["read_archive_status", "read_ccms_alerts"],
    purpose: "Did archiving run, and is CCMS reporting alerts?",
    closeRoutes: ["none"],
    actionRequired: false,
    gap: "",
    boundary:
      "Declared limits, none of them a missing tool. (1) No archive-file detail beyond the " +
      "per-session fileCount: w200 holds no ADMI_FILES row at all (an allowlisted read returned 0 " +
      "rows on 2026-09-28), so a detail tool would have a read path and no sample to describe or " +
      "verify against. (2) No answer to whether CCMS is reporting something right now: ALALERTDB " +
      "stores recorded alerts and their clear dates, while RZ20's monitor reads the in-memory MTE " +
      "tree, which this table does not contain - w200 holds 0 rows with an initial GONEDATE " +
      "(.doc/code-update-20260928-093237.md), so the tool is named and described to say so rather " +
      "than to imply health from an empty result. (3) read_archive_status answered with an empty " +
      "list on every 2026-09-28 call because this target has no archiving history, so its " +
      "row-decoding path is exercised nowhere yet; the empty replies are a property of the target, " +
      "corroborated by the same session's 0-row ADMI_FILES read, and the session read comes from " +
      "the transparent table ADMI_RUN because the ADK selector's ARCH_T_RUNS export carries " +
      "ARCH_RUN, which no work area can be typed with on this release " +
      "(.doc/code-update-20260928-135359.md)."
  },
  {
    id: "landscape",
    label: "Multi-system landscape: compare systems and promote objects",
    plannedToolNames: ["compare_systems", "promote_object"],
    purpose:
      "How does development compare with test and production, and can an object be promoted?",
    closeRoutes: ["none"],
    actionRequired: false,
    gap: "",
    boundary:
      "By the operator's ruling of 2026-09-29 this family's end-to-end is the read-only loop: " +
      "compare_systems answers how the two systems differ, and promote_object answers whether an " +
      "object is recorded in a request that is really aimed at the target system. Performing the " +
      "promotion is deliberately not part of that loop and is therefore not a gap: nothing in this " +
      "service puts an object into a transport, releases one or imports one, so a favourable verdict " +
      "is a readiness answer and the promotion itself still happens in SAP GUI. That limit will not " +
      "move until an operator authorises a cross-system write, and it is recorded here rather than " +
      "left as an open gap so that the read side is counted for what it actually is. The read side " +
      "was verified on two real systems on 2026-09-29 - w200 (GR2, client 200, Development client) " +
      "and w300 (GR3, client 300, Test client), whose system ids were read separately - producing " +
      "seven comparison verdicts and eight precheck verdicts, covering every branch each chain can " +
      "reach, including an identical-source control that shows the comparison moves with content " +
      "(.doc/code-update-20260929-131440.md)."
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

    // A withdrawn name is still filed: the tool keeps serving this scenario, it just stopped being a
    // commitment. Without this the guard below would fire and the block would refuse to publish,
    // which is the correct answer to "a tool disappeared from the report".
    for (const tool of definition.withdrawnToolNames ?? []) {
      filed.add(tool)
      if (definition.plannedToolNames.includes(tool)) {
        problems.push(`family ${definition.id} both plans and withdraws ${tool}`)
      }
      if (registryEntry(tool) === undefined) {
        problems.push(`family ${definition.id} withdraws unregistered tool ${tool}`)
      }
      if ((definition.boundary ?? "").trim() === "") {
        problems.push(
          `family ${definition.id} withdraws ${tool} without stating why in its boundary: a ` +
            "withdrawal is a recorded decision, not a silent drop"
        )
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

    // The route is part of the honest state, so a family that contradicts itself is refused: a gap
    // with no owner is a wish, and a closed family that still claims a route is a stale note.
    if (definition.purpose.trim() === "") {
      problems.push(`family ${definition.id} states no purpose`)
    }
    if (definition.closeRoutes.length === 0) {
      problems.push(`family ${definition.id} states no route to closure`)
    }
    if (new Set(definition.closeRoutes).size !== definition.closeRoutes.length) {
      problems.push(`family ${definition.id} repeats a closure route`)
    }
    const gapDeclared = definition.gap.trim() !== ""
    const claimsPlatform = definition.closeRoutes.includes("platform")
    // A family with nothing missing waits for nobody: `none`. An exempt family is the one exception,
    // because it is closed on paper and impossible in practice, and the exemption says which it is.
    const closedRoute = definition.exemptReason !== undefined ? "platform" : "none"
    if (!gapDeclared && definition.closeRoutes.some((route) => route !== closedRoute)) {
      problems.push(
        `family ${definition.id} declares no gap but a closure route: a family with nothing missing ` +
          "has nobody left to wait for"
      )
    }
    if (gapDeclared && definition.closeRoutes.includes("none")) {
      problems.push(`family ${definition.id} declares a gap and the "none" route`)
    }
    if (definition.exemptReason !== undefined && !claimsPlatform) {
      problems.push(
        `family ${definition.id} claims a platform exemption without naming the platform route`
      )
    }
    if (definition.exemptReason === undefined && claimsPlatform) {
      problems.push(
        `family ${definition.id} names the platform as its route without a written exemption reason`
      )
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
  purpose: string
  closeRoutes: readonly OpsCloseRoute[]
  state: OpsFamilyState
  actionRequired: boolean
  /** True when the platform, not the plan, makes this family impossible on this release. */
  exempt: boolean
  exemptReason: string
  toolNames: string[]
  /** Declared capabilities this family gave up, kept visible so a withdrawal is never a silent drop. */
  withdrawnToolNames: string[]
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
  /** Declared limits of this family, in the family's own words; never a reason to stay open. */
  boundary: string
}

export interface OpsCapabilityBlock {
  vocabulary: {
    toolRole: string
    familyState: string
    closeRoute: string
    endToEndRule: string
    criterionRule: string
    exemptionRule: string
  }
  families: OpsFamilyRollup[]
  summary: {
    familyCount: number
    stateCounts: Record<OpsFamilyState, number>
    /** How many families each route has to unblock before the target can be met. */
    closeRouteCounts: Record<OpsCloseRoute, number>
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
      purpose: definition.purpose,
      closeRoutes: definition.closeRoutes,
      state: opsFamilyState(definition),
      actionRequired: definition.actionRequired,
      exempt: definition.exemptReason !== undefined,
      exemptReason: definition.exemptReason ?? "",
      toolNames: present,
      withdrawnToolNames: [...(definition.withdrawnToolNames ?? [])],
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
      gap: definition.gap,
      boundary: definition.boundary ?? ""
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

  const closeRouteCounts: Record<OpsCloseRoute, number> = {
    none: 0,
    service: 0,
    helper: 0,
    approval: 0,
    authorization: 0,
    landscape: 0,
    platform: 0
  }
  for (const family of families) {
    for (const route of family.closeRoutes) closeRouteCounts[route]++
  }

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
      closeRoute:
        "Who removes the gap: service (this repository can still do it) | helper (an SAP-side helper " +
        "operation, its carrier and a manual F8) | approval (an operator allowlist or approval " +
        "decision) | authorization (a written authorisation for a state-changing operation) | " +
        "landscape (a multi-system configuration decision) | platform (this release cannot do it at " +
        "all, which requires the written exemption) | none (nothing is missing). A family may carry " +
        "several routes, because two different things can stand between the plan and one answer.",
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
      closeRouteCounts,
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
