# Operations acceptance matrix (plan OP4-1)

This file is **generated** from `src/ops-coverage.ts` (families, purposes, closure routes, gaps)
and `contracts/verification-registry.json` (per-tool evidence). It is the frozen 14-family
regression matrix the operations plan asks for: one row per family with the criterion that makes
it "completable by the MCP service", the evidence pointers behind that claim, and who can remove
what is still missing.

- Regenerate: `npm run ops:matrix:generate`. Verify: `npm run ops:matrix:check` (also part of `npm run verify`).
- **Rule**: a 95% claim may only be made when this matrix shows **>= 95%** of the required families
  end-to-end. That needs both points on the same family - the declared gap is empty **and** every
  present tool carries recorded evidence. Read-side breadth never compensates for a missing action.
- A family's **declared boundaries** are printed with it and are not a gap: a boundary is a limit
  the platform or the target's own data fixes (no sample to describe, no live state in the table),
  so it neither opens nor keeps open a family. What is still to be built is the gap.
- Tool-level standing is always stated per tool in the registry, never as a family-level score; the
  evidence column below is a pointer, not a re-judgement.

## Summary

| Reading | Value |
| ------- | ----- |
| Families reported | 15 (14 required + 1 documented exemption) |
| State counts | absent 0, blocked 1, partial 7, read-only 6, read-and-act 1 |
| End-to-end by state (all families) | 7 (47%) |
| Required families counted closed | **7 / 14** (50% of required) |
| Criterion (>= 95% of required) | **not met** - gap empty + every tool verified (verification registry loaded) |
| Closed by state but missing evidence | none |
| Outstanding required families | transport, jobs, updates, query, runtime-resources, authorizations, spool-output |
| Waiting on each route | this repository 1, SAP-side helper + F8 3, operator approval 1, write authorisation (OP2) 3, multi-system configuration (OP3) 1, the platform (exempt) 1, - 7 |

## Definition of done (plan section 8)

The operations plan states four conditions before a 95% claim may be made. Clauses 1 and 2 are
computed here, clause 3 reads the action tools that exist today (a platform boundary with a
recorded ruling counts as an exemption, not as an open defect), and clause 4 is enforced by the
classification guard that has to pass before this file can be generated at all.

| Clause | Reading | Met |
| ------ | ------- | --- |
| 1. at least 95% of the 14 scenario families end-to-end | 7 / 14 closed (50%) | **no** |
| 2. every ops tool verified with real w200 evidence | 29 / 40 of the tools the families declare are verified (the `ops` group itself holds 38, of which 27 are verified); not verified: release_transport_task, cleanup_transport_entries, read_background_job_spool, release_background_job, cancel_background_job, analyze_abap_traces, search_failed_updates, read_failed_update, read_work_processes, read_user_sessions, read_file_system_directory | **no** |
| 3. every action tool has a confirmation string, an idempotency key, a post-write re-read and a negative control | 3 / 6 declared action tool(s) carry a verified controlled-write record: create_transport_request, add_objects_to_transport, delete_sap_lock; open: release_transport_task, release_background_job, cancel_background_job. Action capability is still planned but unbuilt in: transport (1), jobs (2), updates (1) | **no** |
| 4. the capability block agrees with reality and platform blocks are explicit | enforced: generation stops when `opsClassificationProblems` is non-empty; 1 platform-blocked tool(s) recorded (analyze_abap_traces) | yes |

**Recorded conflict, needing an operator ruling.** Plan section 8 clause 1 asks for *at least 13*
families *(>= 95%)*. Thirteen of fourteen is 92.9%, so the two halves of that sentence disagree.
This service therefore requires **14 of 14** unless the operator rules that the plan's *13* is the
binding number - and that ruling decides whether a 92.9% reading may be presented as 95%.

## The matrix

| # | Family | Purpose | Read side | Action side | State | Evidence (verified/present) | Route |
| - | ------ | ------- | --------- | ----------- | ----- | --------------------------- | ----- |
| 1 | `transport` | Which request holds this object, what is in it, and is it ready to hand over? | 1/4 | 3 | partial | 3/4 verified (pending: release_transport_task) | write authorisation (OP2) + multi-system configuration (OP3) |
| 2 | `jobs` | Did the job run, what did it do, and why is a job stuck or missing? | 4/6 | 2 | partial | 3/6 verified (pending: read_background_job_spool, release_background_job, cancel_background_job) | write authorisation (OP2) |
| 3 | `logs` | What does the system log or an application log say about a reported failure? | 5/5 | - | read-only | 5/5 verified | - |
| 4 | `dumps` | Why did the program dump, and what failed first? | 2/2 | - | read-only | 2/2 verified | - |
| 5 | `traces` *(exempt)* | What did one execution actually do, statement by statement? | 0/1 | - | blocked | 0/1 verified (platform-blocked: analyze_abap_traces) | the platform (exempt) |
| 6 | `locks` | Who holds the lock that is blocking an object or document right now? | 1/2 | 1 | read-and-act | 2/2 verified | - |
| 7 | `updates` | Which update terminated, and what does the failed update contain? | 2/2 | - | partial | 0/2 verified (pending: search_failed_updates, read_failed_update) | write authorisation (OP2) |
| 8 | `system-info` | Which release, kernel, patch level, client settings and profile parameters is this system running? | 2/2 | - | read-only | 2/2 verified | - |
| 9 | `query` | Ask an ad-hoc read-only question across the allowlisted tables without SAP GUI. | 2/2 | - | partial | 2/2 verified | this repository |
| 10 | `runtime-resources` | Which work processes and sessions are live, what is on the application server's filesystem, and what performance data exists? | 4/4 | - | partial | 1/4 verified (pending: read_work_processes, read_user_sessions, read_file_system_directory) | SAP-side helper + F8 |
| 11 | `interfaces` | Is an outbound or inbound queue stuck, and did the IDoc arrive? | 3/3 | - | read-only | 3/3 verified | - |
| 12 | `authorizations` | Why did this user's transaction fail on authorization, and what is assigned to them? | 2/2 | - | partial | 2/2 verified | SAP-side helper + F8 + operator approval |
| 13 | `spool-output` | What is actually in a spool request: the rendered text, the OTF/PDF, or the original report's output? | 1/1 | - | partial | 0/1 verified (pending: read_background_job_spool) | SAP-side helper + F8 |
| 14 | `archive-alerts` | Did archiving run, and is CCMS reporting alerts? | 2/2 | - | read-only | 2/2 verified | - |
| 15 | `landscape` | How does development compare with test and production, and can an object be promoted? | 2/2 | - | read-only | 2/2 verified | - |

## What each open family is waiting for

### this repository

- **`query`** (partial) - The native data preview endpoint is platform-unsupported on this release, so only the fallback dialect works: up to 8 disjuncts of up to 8 comparisons joined by AND over =, <>, <, <=, >, >=; COUNT/SUM/MIN/MAX with GROUP BY over a complete read; ORDER BY applied only over a complete read; and, since 2026-09-26, INNER and LEFT joins over up to three allowlisted tables on equality keys, with every column reference qualified. The join *implementation* is in place but the positive path has no evidence: every recorded read-only attempt of E070 INNER JOIN E07T - the 2026-09-27 sweeps .cache/evidence-ops-n1b and .cache/evidence-ops-n1c and the 2026-09-28 sweep .cache/evidence-ops-r23-readonly - ended in a transport-layer `socket hang up` rather than a result, so a claim that the join path was proven on w200 would contradict every artifact this workspace holds; only the negative control is proven (a join on the unapproved MARA is refused with TABLE_NOT_ALLOWED before SAP is touched, in all three runs). This paragraph previously asserted the positive path had been proven on 2026-09-27; that assertion came from prose rather than from a record and was withdrawn on 2026-09-28, with the durable write-up in .doc/code-update-20260928-155820.md. Still absent: right, full and cross joins, expressions, subqueries and LIMIT, so a statement SAP itself would have to plan cannot be asked. A join read is also bounded: an ORDER BY over a read that stops at the row bound is refused with TABLE_QUERY_ORDER_BY_INCOMPLETE rather than sorted partially.

### SAP-side helper + F8

- **`runtime-resources`** (partial) - Reported: the work process list (TH_WPINFO) through read_work_processes, the user and session list (TH_USER_LIST) through read_user_sessions, the application-server directory listing (EPS2_GET_DIRECTORY_LISTING) through read_file_system_directory, and the workload collector's own directory of what it holds (SWNC_GET_WORKLOAD_DIRECTORY) through read_workload_directory. Still absent: read_performance_snapshot and read_db_activity, and the 2026-09-26 probe narrowed why. Every remote-enabled read carrying the workload numbers refuses to serialize: SWNC_COLLECTOR_GET_AGGREGATES, SWNC_GET_WORKLOAD_SNAPSHOT, SWNC_GET_WORKLOAD_STATISTIC, SWNC_READ_SNAPSHOT and SAPWLN3_AGGREGATE_SNAPSHOT_GET expose SWNCGL_T_AGG* rows whose field names or scalar types (SWNCTASKTYPERAW) fail verification, and SWNC_STATREC_READ cannot return NORMAL_RECORDS, the record header that gives a subrecord its user and response time. SWNC_COLLECTOR_KERNEL_STAT is fully resolvable but not remote-enabled, so the workload numbers need the in-SAP helper. DB02 is split by database vendor (DB02_ORA_*, DB02_*_DB2, DB6_*), and the platform is readable after all: RFC_SYSTEM_INFO returns RFCDBSYS (data element SYDBSYS, the central database system) through the fingerprint-pinned reader whose kernel and database values get_sap_system_info already publishes as serverFacts - that half has no recorded call yet, but it is a source the service owns, not an approval it waits for. The 2026-09-26 claim that the platform was unreadable rested on a single TPFYPROPTY read refused with TABLE_NOT_ALLOWED by the then-running build, which is a stale allowlist rather than an unavailable source (TPFYPROPTY was approved on 2026-09-25). What is actually missing is a vendor module that reports activity: the storage and statistics modules that probe reached (DB02_ORA_SELECT_SEGMENTS, DB02_ORA_LAST_ANALYZED, DB02_GET_EXTENT_LIST_DB2) are remote-enabled but answer for space and analysis - the Oracle pair reads dba_tab_columns.last_analyzed/sample_size/num_rows, statistics freshness rather than activity - DB02_DB_ACTIVITY was not found by name, and the vendor-neutral DB_AN_DB_KPIS requires a CCMS node handle (MT_TOOL_INFO typed ALTLEXDESC) and raises MESSAGE e001(sada) when it cannot read one, so an external caller can neither supply its context nor survive its failure. read_db_activity therefore needs the helper: the platform is the service's to read, but no module it can reach reports database activity rather than space, statistics or analysis.
- **`authorizations`** (partial) - Reported: the stored role assignments per user (AGR_USERS), the transactions of a role (AGR_TCODES) and the profile assignments of a user master record (UST04) through read_user_authorizations - assignment master data, never an authorization decision - and the kernel's authorization-trace switch through read_authorization_trace (AUTH_TRACE_GET_STATUS, remote-enabled, no SAP-side helper needed). Still absent: the trace data itself (which authorization check failed), because AUTH_TRACE_GET_AUTHVAL_DATA carries the unverifiable type XUBITVEC16 and so needs the SAP-side helper, and any role-to-authorization-object resolution **as a tool**: AGR_1251/AGR_1252/AGR_PROF, USOBT/USOBT_C/USOBX/USOBX_C and UST10S/UST10C were approved and registered on 2026-09-28 (w200-verified), so that resolution no longer waits for an approval either - read_user_authorizations still deliberately does not perform it.
- **`spool-output`** (partial) - Only rendered text is available: OTF/PDF conversion, printing and original report execution are absent.

### operator approval

- **`authorizations`** (partial) - Reported: the stored role assignments per user (AGR_USERS), the transactions of a role (AGR_TCODES) and the profile assignments of a user master record (UST04) through read_user_authorizations - assignment master data, never an authorization decision - and the kernel's authorization-trace switch through read_authorization_trace (AUTH_TRACE_GET_STATUS, remote-enabled, no SAP-side helper needed). Still absent: the trace data itself (which authorization check failed), because AUTH_TRACE_GET_AUTHVAL_DATA carries the unverifiable type XUBITVEC16 and so needs the SAP-side helper, and any role-to-authorization-object resolution **as a tool**: AGR_1251/AGR_1252/AGR_PROF, USOBT/USOBT_C/USOBX/USOBX_C and UST10S/UST10C were approved and registered on 2026-09-28 (w200-verified), so that resolution no longer waits for an approval either - read_user_authorizations still deliberately does not perform it.

### write authorisation (OP2)

- **`transport`** (partial) - Import is absent: import_transport_queue. Release is built (release_transport_task, helper 2.16) but not yet verified by a real release. DEV->QAS->PRD promotion still happens outside the service.
- **`jobs`** (partial) - Reported: job search, detail, log and spool text, plus two of the four job-control actions - release through release_background_job (BP_JOB_RELEASE inside the repository helper, read back from TBTCO) and cancellation through cancel_background_job (BP_JOB_DELETE on the same body, proved by the job's absence on read-back). Still absent: create and modify, which need their own helper branches and the operator's write authorisation, so a job that does not yet exist or needs a different schedule still has to be built in SAP GUI rather than inside the service.
- **`updates`** (partial) - Failed updates can be read but never reprocessed.

### multi-system configuration (OP3)

- **`transport`** (partial) - Import is absent: import_transport_queue. Release is built (release_transport_task, helper 2.16) but not yet verified by a real release. DEV->QAS->PRD promotion still happens outside the service.

### the platform (exempt)

- **`traces`** (blocked) - evidence only

## Evidence pointers per family

### `transport` - partial

Purpose: Which request holds this object, what is in it, and is it ready to hand over?

Criterion to close: Import is absent: import_transport_queue. Release is built (release_transport_task, helper 2.16) but not yet verified by a real release. DEV->QAS->PRD promotion still happens outside the service.

Declared boundaries: cleanup_transport_entries was withdrawn from this family on 2026-09-28 by the operator's ruling, and the withdrawal is recorded rather than hidden: the tool still exists and still refuses to lie. On 2026-09-24 it located the entry, passed its own pre-checks with two structurally different payloads, saw the PUT answer 2xx, re-read E071 and found the target row still present, and reported CTS_CLEANUP_POSTCHECK_ENTRY_REMAINS instead of success. The native ADT removeobject resource that would be needed is missing from this release, which is why the entry is registered platform-unsupported (D2 ruling, .doc/code-update-20260925-223946.md, forensics in .doc/code-update-20260924-105614.md): a capability the platform cannot deliver, not work still to be done. Leaving it declared as a commitment would have kept this family open permanently, which is what a boundary exists to prevent.

Withdrawn from the plan, still registered and still failing safely: `cleanup_transport_entries`
  (registry status: platform-unsupported)

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `manage_transport_requests` | read-only | verified | `.doc/code-update-20260924-165500.md` |
| `create_transport_request` | action | verified | `.doc/d7-d9-acceptance-20260924.json` |
| `add_objects_to_transport` | action | verified | `.doc/d7-d9-acceptance-20260924.json` |
| `release_transport_task` | action | unverified | unverified |

Not built yet: `import_transport_queue`

### `jobs` - partial

Purpose: Did the job run, what did it do, and why is a job stuck or missing?

Criterion to close: Reported: job search, detail, log and spool text, plus two of the four job-control actions - release through release_background_job (BP_JOB_RELEASE inside the repository helper, read back from TBTCO) and cancellation through cancel_background_job (BP_JOB_DELETE on the same body, proved by the job's absence on read-back). Still absent: create and modify, which need their own helper branches and the operator's write authorisation, so a job that does not yet exist or needs a different schedule still has to be built in SAP GUI rather than inside the service.

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `search_background_jobs` | read-only | verified | `.doc/log-joint-acceptance-20260908-121025.md` |
| `read_background_job_details` | read-only | verified | `.doc/code-update-20260925-221900.md` |
| `read_background_job_log` | read-only | verified | `.doc/code-update-20260908-163230.md` |
| `read_background_job_spool` | read-only | unverified | unverified |
| `release_background_job` | action | unverified | unverified |
| `cancel_background_job` | action | unverified | unverified |

Not built yet: `create_background_job`, `modify_background_job`

### `logs` - read-only

Purpose: What does the system log or an application log say about a reported failure?

Criterion to close: gap empty and every tool verified

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `read_system_logs` | read-only | verified | `.doc/code-update-20260908-163230.md` |
| `discover_application_logs` | read-only | verified | `.doc/code-update-20260908-163230.md` |
| `search_application_logs` | read-only | verified | `.doc/log-joint-acceptance-20260908-121025.md` |
| `read_application_log` | read-only | verified | `.doc/code-update-20260908-163230.md` |
| `correlate_sap_logs` | read-only | verified | `.doc/code-update-20260908-163230.md` |

### `dumps` - read-only

Purpose: Why did the program dump, and what failed first?

Criterion to close: gap empty and every tool verified

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `analyze_abap_dumps` | read-only | verified | `.doc/code-update-20260925-142324.md` |
| `diagnose_sap_failure` | read-only | verified | `.doc/code-update-20260908-091820.md` |

### `traces` - blocked

Purpose: What did one execution actually do, statement by statement?

Criterion to close: gap empty and every tool verified

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `analyze_abap_traces` | platform-blocked | platform-unsupported | platform-unsupported (last attempt 2026-08-27T17:38:38+08:00) |

### `locks` - read-and-act

Purpose: Who holds the lock that is blocking an object or document right now?

Criterion to close: gap empty and every tool verified

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `search_sap_locks` | read-only | verified | `.doc/code-update-20260924-125930.md` |
| `delete_sap_lock` | action | verified | `.doc/code-update-20260929-084029.md` |

### `updates` - partial

Purpose: Which update terminated, and what does the failed update contain?

Criterion to close: Failed updates can be read but never reprocessed.

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `search_failed_updates` | read-only | unverified | unverified |
| `read_failed_update` | read-only | unverified | unverified |

Not built yet: `reprocess_failed_update`

### `system-info` - read-only

Purpose: Which release, kernel, patch level, client settings and profile parameters is this system running?

Criterion to close: gap empty and every tool verified

Declared boundaries: The database *release* is not reported, and no source this service can reach on this target supplies it: RFC_SYSTEM_INFO.RFCDATABS is typed SYSYSID (SAP system name) on this release, the same data element RFCSYSID uses, so it is published verbatim as the database system and never read as a version. Everything else the family's purpose names - client role and cross-client change protection (SCC4), system type, release, the standard-time UTC offset, CVERS.EXTRELEASE per component verbatim, the kernel release, the database system from the kernel's own RFC_SYSTEM_INFO answer, and profile parameters and headers (RZ10/RZ11) through read_system_parameters - is answered today.

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `get_sap_system_info` | read-only | verified | `.doc/code-update-20260909-084306.md` |
| `read_system_parameters` | read-only | verified | `.doc/code-update-20260927-084500.md` |

### `query` - partial

Purpose: Ask an ad-hoc read-only question across the allowlisted tables without SAP GUI.

Criterion to close: The native data preview endpoint is platform-unsupported on this release, so only the fallback dialect works: up to 8 disjuncts of up to 8 comparisons joined by AND over =, <>, <, <=, >, >=; COUNT/SUM/MIN/MAX with GROUP BY over a complete read; ORDER BY applied only over a complete read; and, since 2026-09-26, INNER and LEFT joins over up to three allowlisted tables on equality keys, with every column reference qualified. The join *implementation* is in place but the positive path has no evidence: every recorded read-only attempt of E070 INNER JOIN E07T - the 2026-09-27 sweeps .cache/evidence-ops-n1b and .cache/evidence-ops-n1c and the 2026-09-28 sweep .cache/evidence-ops-r23-readonly - ended in a transport-layer `socket hang up` rather than a result, so a claim that the join path was proven on w200 would contradict every artifact this workspace holds; only the negative control is proven (a join on the unapproved MARA is refused with TABLE_NOT_ALLOWED before SAP is touched, in all three runs). This paragraph previously asserted the positive path had been proven on 2026-09-27; that assertion came from prose rather than from a record and was withdrawn on 2026-09-28, with the durable write-up in .doc/code-update-20260928-155820.md. Still absent: right, full and cross joins, expressions, subqueries and LIMIT, so a statement SAP itself would have to plan cannot be asked. A join read is also bounded: an ORDER BY over a read that stops at the row bound is refused with TABLE_QUERY_ORDER_BY_INCOMPLETE rather than sorted partially.

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `read_abap_table` | read-only | verified | `.doc/d9-0-transport-forensics-20260922.json` |
| `execute_data_query` | read-only | verified | `.doc/code-update-20260925-221900.md` |

### `runtime-resources` - partial

Purpose: Which work processes and sessions are live, what is on the application server's filesystem, and what performance data exists?

Criterion to close: Reported: the work process list (TH_WPINFO) through read_work_processes, the user and session list (TH_USER_LIST) through read_user_sessions, the application-server directory listing (EPS2_GET_DIRECTORY_LISTING) through read_file_system_directory, and the workload collector's own directory of what it holds (SWNC_GET_WORKLOAD_DIRECTORY) through read_workload_directory. Still absent: read_performance_snapshot and read_db_activity, and the 2026-09-26 probe narrowed why. Every remote-enabled read carrying the workload numbers refuses to serialize: SWNC_COLLECTOR_GET_AGGREGATES, SWNC_GET_WORKLOAD_SNAPSHOT, SWNC_GET_WORKLOAD_STATISTIC, SWNC_READ_SNAPSHOT and SAPWLN3_AGGREGATE_SNAPSHOT_GET expose SWNCGL_T_AGG* rows whose field names or scalar types (SWNCTASKTYPERAW) fail verification, and SWNC_STATREC_READ cannot return NORMAL_RECORDS, the record header that gives a subrecord its user and response time. SWNC_COLLECTOR_KERNEL_STAT is fully resolvable but not remote-enabled, so the workload numbers need the in-SAP helper. DB02 is split by database vendor (DB02_ORA_*, DB02_*_DB2, DB6_*), and the platform is readable after all: RFC_SYSTEM_INFO returns RFCDBSYS (data element SYDBSYS, the central database system) through the fingerprint-pinned reader whose kernel and database values get_sap_system_info already publishes as serverFacts - that half has no recorded call yet, but it is a source the service owns, not an approval it waits for. The 2026-09-26 claim that the platform was unreadable rested on a single TPFYPROPTY read refused with TABLE_NOT_ALLOWED by the then-running build, which is a stale allowlist rather than an unavailable source (TPFYPROPTY was approved on 2026-09-25). What is actually missing is a vendor module that reports activity: the storage and statistics modules that probe reached (DB02_ORA_SELECT_SEGMENTS, DB02_ORA_LAST_ANALYZED, DB02_GET_EXTENT_LIST_DB2) are remote-enabled but answer for space and analysis - the Oracle pair reads dba_tab_columns.last_analyzed/sample_size/num_rows, statistics freshness rather than activity - DB02_DB_ACTIVITY was not found by name, and the vendor-neutral DB_AN_DB_KPIS requires a CCMS node handle (MT_TOOL_INFO typed ALTLEXDESC) and raises MESSAGE e001(sada) when it cannot read one, so an external caller can neither supply its context nor survive its failure. read_db_activity therefore needs the helper: the platform is the service's to read, but no module it can reach reports database activity rather than space, statistics or analysis.

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `read_work_processes` | read-only | unverified | unverified |
| `read_user_sessions` | read-only | unverified | unverified |
| `read_file_system_directory` | read-only | unverified | unverified |
| `read_workload_directory` | read-only | verified | `.doc/code-update-20260927-084500.md` |

Not built yet: `read_performance_snapshot`, `read_db_activity`

### `interfaces` - read-only

Purpose: Is an outbound or inbound queue stuck, and did the IDoc arrive?

Criterion to close: gap empty and every tool verified

Declared boundaries: The outbound-mail question - is mail piling up here - is not answered, and no tool claims to. read_email_queue was withdrawn from this family on 2026-09-28 by the operator's ruling, because SOST *was* approved and registered and its read path does work: the same date's read-only forensics (.doc/code-update-20260928-093237.md) show the table carries no live traffic on w200 - every row is SNDART='INT' and DIRECTION='S', STA_ORDER is empty throughout, and no row is dated later than 2014-12-01 - so a tool reading it would have reported a frozen 2013-2014 internal SAPoffice send log as the present, which is the misleading-tool failure this project forbids. The slot was refilled in the same ruling-set not by removing the claim but by naming a capability the approved tables did not already answer: the SM58 tRFC error queue through read_trfc_error_entries, which reads ARFCSSTATE and answers whether an outgoing tRFC LUW is stuck in error. ARFCSSTATE was registered on 2026-09-28; its sibling payload table ARFCSDATA was approved in the same ruling and then deliberately NOT registered, because ARFCBLCNT (RAW 4) plus ARFCDATA01..07 (RAW 255 each) have no character column at all and the joined row is far past the 512-character limit this read path accepts - the tRFC payload is therefore a declared boundary of the read path, not a silently missing row of the allowlist. qRFC/tRFC queue state (TRFCQOUT/TRFCQIN/TRFCQSTATE) through read_qrfc_queues and IDoc control and status records (EDIDC/EDIDS) through read_idoc_status were already covered.

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `read_qrfc_queues` | read-only | verified | `.doc/code-update-20260927-084500.md` |
| `read_idoc_status` | read-only | verified | `.doc/code-update-20260927-084500.md` |
| `read_trfc_error_entries` | read-only | verified | `.doc/code-update-20260928-162050.md` |

### `authorizations` - partial

Purpose: Why did this user's transaction fail on authorization, and what is assigned to them?

Criterion to close: Reported: the stored role assignments per user (AGR_USERS), the transactions of a role (AGR_TCODES) and the profile assignments of a user master record (UST04) through read_user_authorizations - assignment master data, never an authorization decision - and the kernel's authorization-trace switch through read_authorization_trace (AUTH_TRACE_GET_STATUS, remote-enabled, no SAP-side helper needed). Still absent: the trace data itself (which authorization check failed), because AUTH_TRACE_GET_AUTHVAL_DATA carries the unverifiable type XUBITVEC16 and so needs the SAP-side helper, and any role-to-authorization-object resolution **as a tool**: AGR_1251/AGR_1252/AGR_PROF, USOBT/USOBT_C/USOBX/USOBX_C and UST10S/UST10C were approved and registered on 2026-09-28 (w200-verified), so that resolution no longer waits for an approval either - read_user_authorizations still deliberately does not perform it.

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `read_user_authorizations` | read-only | verified | `.doc/code-update-20260927-084500.md` |
| `read_authorization_trace` | read-only | verified | `.doc/code-update-20260928-155820.md` |

### `spool-output` - partial

Purpose: What is actually in a spool request: the rendered text, the OTF/PDF, or the original report's output?

Criterion to close: Only rendered text is available: OTF/PDF conversion, printing and original report execution are absent.

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `read_background_job_spool` | read-only | unverified | unverified |

### `archive-alerts` - read-only

Purpose: Did archiving run, and is CCMS reporting alerts?

Criterion to close: gap empty and every tool verified

Declared boundaries: Declared limits, none of them a missing tool. (1) No archive-file detail beyond the per-session fileCount: w200 holds no ADMI_FILES row at all (an allowlisted read returned 0 rows on 2026-09-28), so a detail tool would have a read path and no sample to describe or verify against. (2) No answer to whether CCMS is reporting something right now: ALALERTDB stores recorded alerts and their clear dates, while RZ20's monitor reads the in-memory MTE tree, which this table does not contain - w200 holds 0 rows with an initial GONEDATE (.doc/code-update-20260928-093237.md), so the tool is named and described to say so rather than to imply health from an empty result. (3) read_archive_status answered with an empty list on every 2026-09-28 call because this target has no archiving history, so its row-decoding path is exercised nowhere yet; the empty replies are a property of the target, corroborated by the same session's 0-row ADMI_FILES read, and the session read comes from the transparent table ADMI_RUN because the ADK selector's ARCH_T_RUNS export carries ARCH_RUN, which no work area can be typed with on this release (.doc/code-update-20260928-135359.md).

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `read_archive_status` | read-only | verified | `.doc/code-update-20260928-142711.md` |
| `read_ccms_alerts` | read-only | verified | `.doc/code-update-20260928-105549.md` |

### `landscape` - read-only

Purpose: How does development compare with test and production, and can an object be promoted?

Criterion to close: gap empty and every tool verified

Declared boundaries: By the operator's ruling of 2026-09-29 this family's end-to-end is the read-only loop: compare_systems answers how the two systems differ, and promote_object answers whether an object is recorded in a request that is really aimed at the target system. Performing the promotion is deliberately not part of that loop and is therefore not a gap: nothing in this service puts an object into a transport, releases one or imports one, so a favourable verdict is a readiness answer and the promotion itself still happens in SAP GUI. That limit will not move until an operator authorises a cross-system write, and it is recorded here rather than left as an open gap so that the read side is counted for what it actually is. The read side was verified on two real systems on 2026-09-29 - w200 (GR2, client 200, Development client) and w300 (GR3, client 300, Test client), whose system ids were read separately - producing seven comparison verdicts and eight precheck verdicts, covering every branch each chain can reach, including an identical-source control that shows the comparison moves with content (.doc/code-update-20260929-131440.md).

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `compare_systems` | read-only | verified | `.doc/code-update-20260929-131440.md` |
| `promote_object` | read-only | verified | `.doc/code-update-20260929-131440.md` |

## What this matrix cannot prove

- It cannot distinguish *helper not deployed* from *helper deployed but the tool was never called*:
  both read as an unverified row. Deployment state lives in `docs/helper-capabilities-protocol.md`.
- A packaged build ships without `contracts/`, so every tool degrades to `unverified` there and
  `registryLoaded` is false; the criterion then certifies nothing rather than guessing.
- `verified` means one real call succeeded and was recorded. It is a statement about evidence, not
  about breadth: a verified tool may still be wrong beyond the case that was exercised.
