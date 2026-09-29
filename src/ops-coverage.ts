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
  read_authorization_trace: "read-only",
  // Runtime resources (SM50/SM66 and SM04)
  read_work_processes: "read-only",
  read_user_sessions: "read-only",
  read_file_system_directory: "read-only",
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
      "release_transport_task",
      "import_transport_queue"
    ],
    // Withdrawn on 2026-09-28 by the operator's ruling (option A), with the platform evidence in the
    // boundary. It stays listed here so the classification does not lose an ops tool; what changed is
    // that the family no longer waits for a resource this release does not serve.
    withdrawnToolNames: ["cleanup_transport_entries"],
    purpose: "Which request holds this object, what is in it, and is it ready to hand over?",
    closeRoutes: ["authorization", "landscape"],
    actionRequired: true,
    gap: "Import is built as a precheck only (import_transport_queue, helper 2.18) and the precheck was exercised on w200 on 2026-09-29. The 2.17 arm was measured wrong: it translated the callee's exception number into a verdict, and nine calls showed a failed tp start labelled as a refusal and a refusal labelled as a failure, with the same request returning two outcomes minutes apart. The 2.18 arm reports the callee's own exception name and the raw sub-return code on every path, and the four requests re-run against it all answered enqueue_failed under TRANSPORT_IMPORT_CHECKED, with the request echoed and the local E070 status correct. An importable verdict is still unobserved - every request tried was refused - so the positive branch is documented, not demonstrated. Release is built (release_transport_task, helper 2.16) but not yet verified by a real release. DEV->QAS->PRD promotion still happens outside the service.",
    boundary:
      "cleanup_transport_entries was withdrawn from this family on 2026-09-28 by the operator's " +
      "ruling, and the withdrawal is recorded rather than hidden: the tool still exists and still " +
      "refuses to lie. On 2026-09-24 it located the entry, passed its own pre-checks with two " +
      "structurally different payloads, saw the PUT answer 2xx, re-read E071 and found the target " +
      "row still present, and reported CTS_CLEANUP_POSTCHECK_ENTRY_REMAINS instead of success. The " +
      "native ADT removeobject resource that would be needed is missing from this release, which is " +
      "why the entry is registered platform-unsupported (D2 ruling, .doc/code-update-20260925-223946.md, " +
      "forensics in .doc/code-update-20260924-105614.md): a capability the platform cannot deliver, " +
      "not work still to be done. Leaving it declared as a commitment would have kept this family " +
      "open permanently, which is what a boundary exists to prevent."
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
    closeRoutes: ["authorization"],
    actionRequired: true,
    gap:
      "Reported: job search, detail, log and spool text, plus two of the four job-control actions - " +
      "release through release_background_job (BP_JOB_RELEASE inside the repository helper, read " +
      "back from TBTCO) and cancellation through cancel_background_job (BP_JOB_DELETE on the same " +
      "body, proved by the job's absence on read-back). Still absent: create and modify, which need " +
      "their own helper branches and the operator's write authorisation, so a job that does not yet " +
      "exist or needs a different schedule still has to be built in SAP GUI rather than inside the " +
      "service."
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
    label: "Failed updates (SM13): search, detail, reprocess",
    plannedToolNames: ["search_failed_updates", "read_failed_update", "reprocess_failed_update"],
    purpose: "Which update terminated, and what does the failed update contain?",
    closeRoutes: ["authorization"],
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
    closeRoutes: ["service"],
    actionRequired: false,
    gap:
      "The native data preview endpoint is platform-unsupported on this release, so only the " +
      "fallback dialect works: up to 8 disjuncts of up to 8 comparisons joined by AND over =, <>, " +
      "<, <=, >, >=; COUNT/SUM/MIN/MAX with GROUP BY over a complete read; ORDER BY applied only " +
      "over a complete read; and, since 2026-09-26, INNER and LEFT joins over up to three " +
      "allowlisted tables on equality keys, with every column reference qualified. The join " +
      "*implementation* is in place but the positive path has no evidence: every recorded read-only " +
      "attempt of E070 INNER JOIN E07T - the 2026-09-27 sweeps .cache/evidence-ops-n1b and " +
      ".cache/evidence-ops-n1c and the 2026-09-28 sweep .cache/evidence-ops-r23-readonly - ended in " +
      "a transport-layer `socket hang up` rather than a result, so a claim that the join path was " +
      "proven on w200 would contradict every artifact this workspace holds; only the negative " +
      "control is proven (a join on the unapproved MARA is refused with TABLE_NOT_ALLOWED before " +
      "SAP is touched, in all three runs). This paragraph previously asserted the positive path had " +
      "been proven on 2026-09-27; that assertion came from prose rather than from a record and was " +
      "withdrawn on 2026-09-28, with the durable write-up in .doc/code-update-20260928-155820.md. " +
      "Still absent: right, full and cross joins, expressions, subqueries " +
      "and LIMIT, so a statement SAP itself would have to plan cannot be asked. A join read is also " +
      "bounded: an ORDER BY over a read that stops at the row bound is refused with " +
      "TABLE_QUERY_ORDER_BY_INCOMPLETE rather than sorted partially."
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
    closeRoutes: ["helper"],
    actionRequired: false,
    gap:
      "Reported: the work process list (TH_WPINFO) through read_work_processes, the user and " +
      "session list (TH_USER_LIST) through read_user_sessions, the application-server directory " +
      "listing (EPS2_GET_DIRECTORY_LISTING) through read_file_system_directory, and the workload " +
      "collector's own directory of what it holds (SWNC_GET_WORKLOAD_DIRECTORY) through " +
      "read_workload_directory. Still absent: read_performance_snapshot and read_db_activity, and " +
      "the 2026-09-26 probe narrowed why. Every remote-enabled read carrying the workload numbers " +
      "refuses to serialize: SWNC_COLLECTOR_GET_AGGREGATES, SWNC_GET_WORKLOAD_SNAPSHOT, " +
      "SWNC_GET_WORKLOAD_STATISTIC, SWNC_READ_SNAPSHOT and SAPWLN3_AGGREGATE_SNAPSHOT_GET expose " +
      "SWNCGL_T_AGG* rows whose field names or scalar types (SWNCTASKTYPERAW) fail verification, " +
      "and SWNC_STATREC_READ cannot return NORMAL_RECORDS, the record header that gives a " +
      "subrecord its user and response time. SWNC_COLLECTOR_KERNEL_STAT is fully resolvable but " +
      "not remote-enabled, so the workload numbers need the in-SAP helper. DB02 is split by " +
      "database vendor (DB02_ORA_*, DB02_*_DB2, DB6_*), and the platform is readable after all: " +
      "RFC_SYSTEM_INFO returns RFCDBSYS (data element SYDBSYS, the central database system) " +
      "through the fingerprint-pinned reader whose kernel and database values get_sap_system_info " +
      "already publishes as serverFacts - that half has no recorded call yet, but it is a source " +
      "the service owns, not an approval it waits for. The 2026-09-26 claim that the platform was " +
      "unreadable rested on a single TPFYPROPTY read refused with TABLE_NOT_ALLOWED by the " +
      "then-running build, which is a stale allowlist rather than an unavailable source " +
      "(TPFYPROPTY was approved on 2026-09-25). What is actually missing is a vendor module that " +
      "reports activity: the storage and statistics modules that probe reached " +
      "(DB02_ORA_SELECT_SEGMENTS, DB02_ORA_LAST_ANALYZED, DB02_GET_EXTENT_LIST_DB2) are " +
      "remote-enabled but answer for space and analysis - the Oracle pair reads " +
      "dba_tab_columns.last_analyzed/sample_size/num_rows, statistics freshness rather than " +
      "activity - DB02_DB_ACTIVITY was not found by name, and the vendor-neutral DB_AN_DB_KPIS " +
      "requires a CCMS node handle (MT_TOOL_INFO typed ALTLEXDESC) and raises MESSAGE e001(sada) " +
      "when it cannot read one, so an external caller can neither supply its context nor survive " +
      "its failure. read_db_activity therefore needs the helper: the platform is the service's to " +
      "read, but no module it can reach reports database activity rather than space, statistics " +
      "or analysis."
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
    plannedToolNames: ["read_user_authorizations", "read_authorization_trace"],
    purpose: "Why did this user's transaction fail on authorization, and what is assigned to them?",
    closeRoutes: ["helper", "approval"],
    actionRequired: false,
    gap:
      "Reported: the stored role assignments per user (AGR_USERS), the transactions of a " +
      "role (AGR_TCODES) and the profile assignments of a user master record (UST04) through " +
      "read_user_authorizations - assignment master data, never an authorization decision - and " +
      "the kernel's authorization-trace switch through read_authorization_trace " +
      "(AUTH_TRACE_GET_STATUS, remote-enabled, no SAP-side helper needed). " +
      "Still absent: the trace data itself (which authorization check failed), because " +
      "AUTH_TRACE_GET_AUTHVAL_DATA carries the unverifiable type XUBITVEC16 and so needs the " +
      "SAP-side helper, and any role-to-authorization-object resolution **as a tool**: " +
      "AGR_1251/AGR_1252/AGR_PROF, USOBT/USOBT_C/USOBX/USOBX_C and UST10S/UST10C were approved and " +
      "registered on 2026-09-28 (w200-verified), so that resolution no longer waits for an " +
      "approval either - read_user_authorizations still deliberately does not perform it."
  },
  {
    id: "spool-output",
    label: "Spool output formats: text, OTF/PDF, printing, original report execution",
    plannedToolNames: ["read_background_job_spool"],
    purpose:
      "What is actually in a spool request: the rendered text, the OTF/PDF, or the original report's output?",
    closeRoutes: ["helper"],
    actionRequired: false,
    gap:
      "Only rendered text is available: OTF/PDF conversion, printing and original report " +
      "execution are absent."
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
