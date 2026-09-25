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
- Tool-level standing is always stated per tool in the registry, never as a family-level score; the
  evidence column below is a pointer, not a re-judgement.

## Summary

| Reading | Value |
| ------- | ----- |
| Families reported | 15 (14 required + 1 documented exemption) |
| State counts | absent 2, blocked 1, partial 10, read-only 2, read-and-act 0 |
| End-to-end by state (all families) | 2 (13%) |
| Required families counted closed | **2 / 14** (14% of required) |
| Criterion (>= 95% of required) | **not met** - gap empty + every tool verified (verification registry loaded) |
| Closed by state but missing evidence | none |
| Outstanding required families | transport, jobs, locks, updates, system-info, query, runtime-resources, interfaces, authorizations, spool-output, archive-alerts, landscape |
| Waiting on each route | this repository 1, SAP-side helper + F8 6, operator approval 2, write authorisation (OP2) 4, multi-system configuration (OP3) 2, the platform (exempt) 1, - 2 |

## The matrix

| # | Family | Purpose | Read side | Action side | State | Evidence (verified/present) | Route |
| - | ------ | ------- | --------- | ----------- | ----- | --------------------------- | ----- |
| 1 | `transport` | Which request holds this object, what is in it, and is it ready to hand over? | 1/4 | 3 | partial | 3/4 verified (pending: cleanup_transport_entries) | write authorisation (OP2) + multi-system configuration (OP3) |
| 2 | `jobs` | Did the job run, what did it do, and why is a job stuck or missing? | 4/4 | - | partial | 3/4 verified (pending: read_background_job_spool) | write authorisation (OP2) |
| 3 | `logs` | What does the system log or an application log say about a reported failure? | 5/5 | - | read-only | 5/5 verified | - |
| 4 | `dumps` | Why did the program dump, and what failed first? | 2/2 | - | read-only | 2/2 verified | - |
| 5 | `traces` *(exempt)* | What did one execution actually do, statement by statement? | 0/1 | - | blocked | 0/1 verified (platform-blocked: analyze_abap_traces) | the platform (exempt) |
| 6 | `locks` | Who holds the lock that is blocking an object or document right now? | 1/1 | - | partial | 1/1 verified | write authorisation (OP2) |
| 7 | `updates` | Which update terminated, and what does the failed update contain? | 2/2 | - | partial | 0/2 verified (pending: search_failed_updates, read_failed_update) | write authorisation (OP2) |
| 8 | `system-info` | Which release, kernel, patch level, client settings and profile parameters is this system running? | 2/2 | - | partial | 1/2 verified (pending: read_system_parameters) | SAP-side helper + F8 |
| 9 | `query` | Ask an ad-hoc read-only question across the allowlisted tables without SAP GUI. | 2/2 | - | partial | 2/2 verified | this repository |
| 10 | `runtime-resources` | Which work processes and sessions are live, what is on the application server's filesystem, and what performance data exists? | 4/4 | - | partial | 0/4 verified (pending: read_work_processes, read_user_sessions, read_file_system_directory, read_workload_directory) | SAP-side helper + F8 |
| 11 | `interfaces` | Is an outbound or inbound queue stuck, did the IDoc arrive, and is mail piling up? | 2/2 | - | partial | 0/2 verified (pending: read_qrfc_queues, read_idoc_status) | SAP-side helper + F8 + operator approval |
| 12 | `authorizations` | Why did this user's transaction fail on authorization, and what is assigned to them? | 1/1 | - | partial | 0/1 verified (pending: read_user_authorizations) | SAP-side helper + F8 + operator approval |
| 13 | `spool-output` | What is actually in a spool request: the rendered text, the OTF/PDF, or the original report's output? | 1/1 | - | partial | 0/1 verified (pending: read_background_job_spool) | SAP-side helper + F8 |
| 14 | `archive-alerts` | Did archiving run, and is CCMS reporting alerts? | 0/0 | - | absent | no tool exists | SAP-side helper + F8 |
| 15 | `landscape` | How does development compare with test and production, and can an object be promoted? | 0/0 | - | absent | no tool exists | multi-system configuration (OP3) |

## What each open family is waiting for

### this repository

- **`query`** (partial) - The native data preview endpoint is platform-unsupported on this release, so only the fallback dialect works: up to 8 disjuncts of up to 8 comparisons joined by AND over =, <>, <, <=, >, >=; COUNT/SUM/MIN/MAX with GROUP BY over a complete read; ORDER BY applied only over a complete read; and, since 2026-09-26, INNER and LEFT joins over up to three allowlisted tables on equality keys, with every column reference qualified. Still absent: right, full and cross joins, expressions, subqueries and LIMIT, so a statement SAP itself would have to plan cannot be asked. The join path also has no runtime evidence yet: the connected service still serves a build from before it.

### SAP-side helper + F8

- **`system-info`** (partial) - Reported: client role and cross-client change protection (SCC4), system type, release, the standard-time UTC offset, CVERS.EXTRELEASE per component verbatim, the kernel release and the database system from the kernel's own RFC_SYSTEM_INFO answer, and profile parameters and profile headers (RZ10/RZ11) through read_system_parameters. Still absent: the database *release* - RFC_SYSTEM_INFO.RFCDATABS is typed SYSYSID (SAP system name) on this release, the same data element RFCSYSID uses, so it is returned verbatim and never read as a version, and no other source this service can reach reports one.
- **`runtime-resources`** (partial) - Reported: the work process list (TH_WPINFO) through read_work_processes, the user and session list (TH_USER_LIST) through read_user_sessions, the application-server directory listing (EPS2_GET_DIRECTORY_LISTING) through read_file_system_directory, and the workload collector's own directory of what it holds (SWNC_GET_WORKLOAD_DIRECTORY) through read_workload_directory. Still absent: read_performance_snapshot and read_db_activity, and the 2026-09-26 probe narrowed why. Every remote-enabled read carrying the workload numbers refuses to serialize: SWNC_COLLECTOR_GET_AGGREGATES, SWNC_GET_WORKLOAD_SNAPSHOT, SWNC_GET_WORKLOAD_STATISTIC, SWNC_READ_SNAPSHOT and SAPWLN3_AGGREGATE_SNAPSHOT_GET expose SWNCGL_T_AGG* rows whose field names or scalar types (SWNCTASKTYPERAW) fail verification, and SWNC_STATREC_READ cannot return NORMAL_RECORDS, the record header that gives a subrecord its user and response time. SWNC_COLLECTOR_KERNEL_STAT is fully resolvable but not remote-enabled, so the workload numbers need the in-SAP helper. DB02 is split by database vendor (DB02_ORA_*, DB02_*_DB2, DB6_*), and the platform is readable after all: RFC_SYSTEM_INFO returns RFCDBSYS (data element SYDBSYS, the central database system) through the fingerprint-pinned reader whose kernel and database values get_sap_system_info already publishes as serverFacts - that half has no recorded call yet, but it is a source the service owns, not an approval it waits for. The 2026-09-26 claim that the platform was unreadable rested on a single TPFYPROPTY read refused with TABLE_NOT_ALLOWED by the then-running build, which is a stale allowlist rather than an unavailable source (TPFYPROPTY was approved on 2026-09-25). What is actually missing is a vendor module that reports activity: the storage and statistics modules that probe reached (DB02_ORA_SELECT_SEGMENTS, DB02_ORA_LAST_ANALYZED, DB02_GET_EXTENT_LIST_DB2) are remote-enabled but answer for space and analysis - the Oracle pair reads dba_tab_columns.last_analyzed/sample_size/num_rows, statistics freshness rather than activity - DB02_DB_ACTIVITY was not found by name, and the vendor-neutral DB_AN_DB_KPIS requires a CCMS node handle (MT_TOOL_INFO typed ALTLEXDESC) and raises MESSAGE e001(sada) when it cannot read one, so an external caller can neither supply its context nor survive its failure. read_db_activity therefore needs the helper: the platform is the service's to read, but no module it can reach reports database activity rather than space, statistics or analysis.
- **`interfaces`** (partial) - Reported: outbound and inbound qRFC/tRFC queue state (TRFCQOUT/TRFCQIN/TRFCQSTATE) through read_qrfc_queues, and IDoc control and status records (EDIDC/EDIDS) through read_idoc_status. Still absent: the email queue - SOST is not on the approved allowlist, so read_email_queue needs a separate approval before it can be implemented.
- **`authorizations`** (partial) - Reported: the stored role assignments per user (AGR_USERS), the transactions of a role (AGR_TCODES) and the profile assignments of a user master record (UST04) through read_user_authorizations - assignment master data, never an authorization decision. Still absent: the SU53/ST01 authorization trace (read_authorization_trace), which needs the SAP-side helper, and any role-to-authorization-object resolution, because AGR_1251/AGR_1252/AGR_PROF/USOB*/UST10* are not on the approved allowlist.
- **`spool-output`** (partial) - Only rendered text is available: OTF/PDF conversion, printing and original report execution are absent.
- **`archive-alerts`** (absent) - No archive-status or CCMS alert tool exists at all.

### operator approval

- **`interfaces`** (partial) - Reported: outbound and inbound qRFC/tRFC queue state (TRFCQOUT/TRFCQIN/TRFCQSTATE) through read_qrfc_queues, and IDoc control and status records (EDIDC/EDIDS) through read_idoc_status. Still absent: the email queue - SOST is not on the approved allowlist, so read_email_queue needs a separate approval before it can be implemented.
- **`authorizations`** (partial) - Reported: the stored role assignments per user (AGR_USERS), the transactions of a role (AGR_TCODES) and the profile assignments of a user master record (UST04) through read_user_authorizations - assignment master data, never an authorization decision. Still absent: the SU53/ST01 authorization trace (read_authorization_trace), which needs the SAP-side helper, and any role-to-authorization-object resolution, because AGR_1251/AGR_1252/AGR_PROF/USOB*/UST10* are not on the approved allowlist.

### write authorisation (OP2)

- **`transport`** (partial) - Release and import are absent: release_transport_task and import_transport_queue. DEV->QAS->PRD promotion still happens outside the service.
- **`jobs`** (partial) - No job control: create/modify/release/cancel are absent, so a stuck or missing job is reported but never corrected inside the service.
- **`locks`** (partial) - Locks can be listed but never released; a blocking lock must be cleared in SAP GUI.
- **`updates`** (partial) - Failed updates can be read but never reprocessed.

### multi-system configuration (OP3)

- **`transport`** (partial) - Release and import are absent: release_transport_task and import_transport_queue. DEV->QAS->PRD promotion still happens outside the service.
- **`landscape`** (absent) - One connection is pinned as the validated landscape, with no DEV/QAS/PRD roles, so neither system comparison nor promotion exists.

### the platform (exempt)

- **`traces`** (blocked) - evidence only

## Evidence pointers per family

### `transport` - partial

Purpose: Which request holds this object, what is in it, and is it ready to hand over?

Criterion to close: Release and import are absent: release_transport_task and import_transport_queue. DEV->QAS->PRD promotion still happens outside the service.

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `manage_transport_requests` | read-only | verified | `.doc/code-update-20260924-165500.md` |
| `create_transport_request` | action | verified | `.doc/d7-d9-acceptance-20260924.json` |
| `add_objects_to_transport` | action | verified | `.doc/d7-d9-acceptance-20260924.json` |
| `cleanup_transport_entries` | action | platform-unsupported | platform-unsupported (last attempt 2026-09-24) |

Not built yet: `release_transport_task`, `import_transport_queue`

### `jobs` - partial

Purpose: Did the job run, what did it do, and why is a job stuck or missing?

Criterion to close: No job control: create/modify/release/cancel are absent, so a stuck or missing job is reported but never corrected inside the service.

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `search_background_jobs` | read-only | verified | `.doc/log-joint-acceptance-20260908-121025.md` |
| `read_background_job_details` | read-only | verified | `.doc/code-update-20260925-221900.md` |
| `read_background_job_log` | read-only | verified | `.doc/code-update-20260908-163230.md` |
| `read_background_job_spool` | read-only | unverified | unverified |

Not built yet: `create_background_job`, `modify_background_job`, `release_background_job`, `cancel_background_job`

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

### `locks` - partial

Purpose: Who holds the lock that is blocking an object or document right now?

Criterion to close: Locks can be listed but never released; a blocking lock must be cleared in SAP GUI.

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `search_sap_locks` | read-only | verified | `.doc/code-update-20260924-125930.md` |

Not built yet: `delete_sap_lock`

### `updates` - partial

Purpose: Which update terminated, and what does the failed update contain?

Criterion to close: Failed updates can be read but never reprocessed.

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `search_failed_updates` | read-only | unverified | unverified |
| `read_failed_update` | read-only | unverified | unverified |

Not built yet: `reprocess_failed_update`

### `system-info` - partial

Purpose: Which release, kernel, patch level, client settings and profile parameters is this system running?

Criterion to close: Reported: client role and cross-client change protection (SCC4), system type, release, the standard-time UTC offset, CVERS.EXTRELEASE per component verbatim, the kernel release and the database system from the kernel's own RFC_SYSTEM_INFO answer, and profile parameters and profile headers (RZ10/RZ11) through read_system_parameters. Still absent: the database *release* - RFC_SYSTEM_INFO.RFCDATABS is typed SYSYSID (SAP system name) on this release, the same data element RFCSYSID uses, so it is returned verbatim and never read as a version, and no other source this service can reach reports one.

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `get_sap_system_info` | read-only | verified | `.doc/code-update-20260909-084306.md` |
| `read_system_parameters` | read-only | unverified | unverified |

### `query` - partial

Purpose: Ask an ad-hoc read-only question across the allowlisted tables without SAP GUI.

Criterion to close: The native data preview endpoint is platform-unsupported on this release, so only the fallback dialect works: up to 8 disjuncts of up to 8 comparisons joined by AND over =, <>, <, <=, >, >=; COUNT/SUM/MIN/MAX with GROUP BY over a complete read; ORDER BY applied only over a complete read; and, since 2026-09-26, INNER and LEFT joins over up to three allowlisted tables on equality keys, with every column reference qualified. Still absent: right, full and cross joins, expressions, subqueries and LIMIT, so a statement SAP itself would have to plan cannot be asked. The join path also has no runtime evidence yet: the connected service still serves a build from before it.

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
| `read_workload_directory` | read-only | unverified | unverified |

Not built yet: `read_performance_snapshot`, `read_db_activity`

### `interfaces` - partial

Purpose: Is an outbound or inbound queue stuck, did the IDoc arrive, and is mail piling up?

Criterion to close: Reported: outbound and inbound qRFC/tRFC queue state (TRFCQOUT/TRFCQIN/TRFCQSTATE) through read_qrfc_queues, and IDoc control and status records (EDIDC/EDIDS) through read_idoc_status. Still absent: the email queue - SOST is not on the approved allowlist, so read_email_queue needs a separate approval before it can be implemented.

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `read_qrfc_queues` | read-only | unverified | unverified |
| `read_idoc_status` | read-only | unverified | unverified |

Not built yet: `read_email_queue`

### `authorizations` - partial

Purpose: Why did this user's transaction fail on authorization, and what is assigned to them?

Criterion to close: Reported: the stored role assignments per user (AGR_USERS), the transactions of a role (AGR_TCODES) and the profile assignments of a user master record (UST04) through read_user_authorizations - assignment master data, never an authorization decision. Still absent: the SU53/ST01 authorization trace (read_authorization_trace), which needs the SAP-side helper, and any role-to-authorization-object resolution, because AGR_1251/AGR_1252/AGR_PROF/USOB*/UST10* are not on the approved allowlist.

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `read_user_authorizations` | read-only | unverified | unverified |

Not built yet: `read_authorization_trace`

### `spool-output` - partial

Purpose: What is actually in a spool request: the rendered text, the OTF/PDF, or the original report's output?

Criterion to close: Only rendered text is available: OTF/PDF conversion, printing and original report execution are absent.

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `read_background_job_spool` | read-only | unverified | unverified |

### `archive-alerts` - absent

Purpose: Did archiving run, and is CCMS reporting alerts?

Criterion to close: No archive-status or CCMS alert tool exists at all.

Planned but unbuilt: `read_archive_status`, `read_ccms_alerts`

### `landscape` - absent

Purpose: How does development compare with test and production, and can an object be promoted?

Criterion to close: One connection is pinned as the validated landscape, with no DEV/QAS/PRD roles, so neither system comparison nor promotion exists.

Planned but unbuilt: `compare_systems`, `promote_object`

## What this matrix cannot prove

- It cannot distinguish *helper not deployed* from *helper deployed but the tool was never called*:
  both read as an unverified row. Deployment state lives in `docs/helper-capabilities-protocol.md`.
- A packaged build ships without `contracts/`, so every tool degrades to `unverified` there and
  `registryLoaded` is false; the criterion then certifies nothing rather than guessing.
- `verified` means one real call succeeded and was recorded. It is a statement about evidence, not
  about breadth: a verified tool may still be wrong beyond the case that was exercised.
