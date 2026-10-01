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
| State counts | absent 0, blocked 1, partial 0, read-only 11, read-and-act 3 |
| End-to-end by state (all families) | 14 (93%) |
| Required families counted closed | **14 / 14** (100% of required) |
| Criterion (>= 95% of required) | met - gap empty + every tool verified (verification registry loaded) |
| Closed by state but missing evidence | none |
| Outstanding required families | none |
| Waiting on each route | the platform (exempt) 1, - 14 |

## Definition of done (plan section 8)

The operations plan states four conditions before a 95% claim may be made. Clauses 1 and 2 are
computed here, clause 3 reads the action tools that exist today (a platform boundary with a
recorded ruling counts as an exemption, not as an open defect), and clause 4 is enforced by the
classification guard that has to pass before this file can be generated at all.

| Clause | Reading | Met |
| ------ | ------- | --- |
| 1. at least 95% of the 14 scenario families end-to-end | 14 / 14 closed (100%) | yes |
| 2. every ops tool verified with real w200 evidence | 43 / 46 of the tools the families declare are verified (the `ops` group itself holds 44, of which 41 are verified); not verified: cleanup_transport_entries, release_transport_task, analyze_abap_traces | **no** |
| 3. every action tool has a confirmation string, an idempotency key, a post-write re-read and a negative control | 7 / 7 declared action tool(s) carry a verified controlled-write record: create_transport_request, add_objects_to_transport, create_background_job, modify_background_job, release_background_job, cancel_background_job, delete_sap_lock | yes (open items: none) |
| 4. the capability block agrees with reality and platform blocks are explicit | enforced: generation stops when `opsClassificationProblems` is non-empty; 1 platform-blocked tool(s) recorded (analyze_abap_traces) | yes |

**Recorded conflict, needing an operator ruling.** Plan section 8 clause 1 asks for *at least 13*
families *(>= 95%)*. Thirteen of fourteen is 92.9%, so the two halves of that sentence disagree.
This service therefore requires **14 of 14** unless the operator rules that the plan's *13* is the
binding number - and that ruling decides whether a 92.9% reading may be presented as 95%.

## The matrix

| # | Family | Purpose | Read side | Action side | State | Evidence (verified/present) | Route |
| - | ------ | ------- | --------- | ----------- | ----- | --------------------------- | ----- |
| 1 | `transport` | Which request holds this object, what is in it, and is it ready to hand over? | 2/4 | 2 | read-and-act | 4/4 verified | - |
| 2 | `jobs` | Did the job run, what did it do, and why is a job stuck or missing? | 4/8 | 4 | read-and-act | 8/8 verified | - |
| 3 | `logs` | What does the system log or an application log say about a reported failure? | 5/5 | - | read-only | 5/5 verified | - |
| 4 | `dumps` | Why did the program dump, and what failed first? | 2/2 | - | read-only | 2/2 verified | - |
| 5 | `traces` *(exempt)* | What did one execution actually do, statement by statement? | 0/1 | - | blocked | 0/1 verified (platform-blocked: analyze_abap_traces) | the platform (exempt) |
| 6 | `locks` | Who holds the lock that is blocking an object or document right now? | 1/2 | 1 | read-and-act | 2/2 verified | - |
| 7 | `updates` | Which update terminated, and what does the failed update contain? | 2/2 | - | read-only | 2/2 verified | - |
| 8 | `system-info` | Which release, kernel, patch level, client settings and profile parameters is this system running? | 2/2 | - | read-only | 2/2 verified | - |
| 9 | `query` | Ask an ad-hoc read-only question across the allowlisted tables without SAP GUI. | 2/2 | - | read-only | 2/2 verified | - |
| 10 | `runtime-resources` | Which work processes and sessions are live, what is on the application server's filesystem, and what performance data exists? | 6/6 | - | read-only | 6/6 verified | - |
| 11 | `interfaces` | Is an outbound or inbound queue stuck, and did the IDoc arrive? | 3/3 | - | read-only | 3/3 verified | - |
| 12 | `authorizations` | Why did this user's transaction fail on authorization, and what is assigned to them? | 3/3 | - | read-only | 3/3 verified | - |
| 13 | `spool-output` | What is actually in a spool request: the rendered text, the OTF/PDF, or the original report's output? | 1/1 | - | read-only | 1/1 verified | - |
| 14 | `archive-alerts` | Did archiving run, and is CCMS reporting alerts? | 2/2 | - | read-only | 2/2 verified | - |
| 15 | `landscape` | How does development compare with test and production, and can an object be promoted? | 2/2 | - | read-only | 2/2 verified | - |

## What each open family is waiting for

### the platform (exempt)

- **`traces`** (blocked) - evidence only

## Evidence pointers per family

### `transport` - read-and-act

Purpose: Which request holds this object, what is in it, and is it ready to hand over?

Criterion to close: gap empty and every tool verified

Declared boundaries: cleanup_transport_entries was withdrawn from this family on 2026-09-28 by the operator's ruling, and the withdrawal is recorded rather than hidden: the tool still exists and still refuses to lie. On 2026-09-24 it located the entry, passed its own pre-checks with two structurally different payloads, saw the PUT answer 2xx, re-read E071 and found the target row still present, and reported CTS_CLEANUP_POSTCHECK_ENTRY_REMAINS instead of success. The native ADT removeobject resource that would be needed is missing from this release, which is why the entry is registered platform-unsupported (D2 ruling, .doc/code-update-20260925-223946.md, forensics in .doc/code-update-20260924-105614.md): a capability the platform cannot deliver, not work still to be done. Leaving it declared as a commitment would have kept this family open permanently, which is what a boundary exists to prevent. release_transport_task was withdrawn from this family on 2026-10-01 by the operator's ruling, and the withdrawal is recorded rather than hidden. Four of the five tools the family declared are verified and keep serving the scenario; what is ruled out of reach is one link in the fifth, established by reading the source of SAP itself rather than by inference. A release of the requests this service creates cannot avoid a physical export: TRINT_RELEASE_REQUEST (137 lines, sha256 931d02ad...) branches only on trfunction and on whether a target system is present, so a workbench request WITH a target always falls into the ELSE branch that calls TRINT_TRANSPORT_REQUEST, which calls TRINT_EXPORT_ON_OS_LEVEL unconditionally, and that function accepts no input that suppresses the export. An earlier belief of this project, that the SE09 dialog reaches a released status through a branch that skips the export, is wrong and has been withdrawn: the dialog runs the same export. That export runs the OS-level transport control program tp, which is an operating-system program rather than a SAP object, and tp is out of reach in this environment. It exists as an AIX executable at /usr/sap/GR2/SYS/exe/run/tp belonging to an intact 2014-05-12 kernel set, and the TMS domain configuration is present, but no transport log has been written since 2014-02-02, and a genuine release performed by the operator on 2026-10-01 moved GR2K923527 to TRSTATUS = R without writing any SLOG/ALOG and without producing any R*/K* file, so E070 status alone never proved that tp ran. Repairing this needs root or gr2adm on the AIX application server and S_CTS_ADMI in STMS, and the operator is not a Basis administrator and has no operating-system access. The tool is registered platform-unsupported with the full reasoning and its evidence in contracts/verification-registry.json: a capability this environment cannot deliver, not work still to be done. It is kept and still refuses honestly, answering an already-released request with TRANSPORT_NOT_MODIFIABLE and otherwise reporting the callee's own TRANSPORT_EXPORT_FAILED; the entry is re-promoted if the tp environment is ever repaired. What the family does deliver and has proven on the machine is unchanged: the task-level arm releases for real (task GR2K923528 reached TRSTATUS = R) and add_objects_to_transport writes for real (insertedCount = 1).

Withdrawn from the plan, still registered and still failing safely: `cleanup_transport_entries`, `release_transport_task`
  (registry status: platform-unsupported, platform-unsupported)

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `manage_transport_requests` | read-only | verified | `.doc/code-update-20260924-165500.md` |
| `create_transport_request` | action | verified | `.doc/d7-d9-acceptance-20260924.json` |
| `add_objects_to_transport` | action | verified | `.doc/d7-d9-acceptance-20260924.json` |
| `import_transport_queue` | read-only | verified | `.doc/code-update-20260929-152335.md` |

### `jobs` - read-and-act

Purpose: Did the job run, what did it do, and why is a job stuck or missing?

Criterion to close: gap empty and every tool verified

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `search_background_jobs` | read-only | verified | `.doc/log-joint-acceptance-20260908-121025.md` |
| `read_background_job_details` | read-only | verified | `.doc/code-update-20260925-221900.md` |
| `read_background_job_log` | read-only | verified | `.doc/code-update-20260908-163230.md` |
| `read_background_job_spool` | read-only | verified | `.doc/code-update-20260929-192300.md` |
| `create_background_job` | action | verified | `.doc/code-update-20261001-135303.md` |
| `modify_background_job` | action | verified | `.doc/code-update-20261001-135303.md` |
| `release_background_job` | action | verified | `.doc/code-update-20261001-135303.md` |
| `cancel_background_job` | action | verified | `.doc/code-update-20261001-135303.md` |

### `logs` - read-only

Purpose: What does the system log or an application log say about a reported failure?

Criterion to close: gap empty and every tool verified

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `read_system_logs` | read-only | verified | `.doc/code-update-20260930-133604.md` |
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

### `updates` - read-only

Purpose: Which update terminated, and what does the failed update contain?

Criterion to close: gap empty and every tool verified

Declared boundaries: Repeating (reprocessing) a failed update is not offered, because on this target no source this service can reach exposes it to a caller without a SAP GUI. SM13's own restart logic is dialog code inside the module pool RSM13000 (the FORMs behind 'V1-und V2-Nachverbuchung anstarten' and 'Einzelne V2-Nachverbuchung anstarten', the latter read at RSM13000:2735), and it runs on the kernel call CALL 'ThVBCall' (opcodes SELECT_VB_SERVER and START_VB) plus a direct `UPDATE VBHDR SET VBRC = VB_RUN_V2 VBNAME = ...` with `commit work`; those FORMs also terminate on dialog messages, including the type-A message MESSAGE A210 at RSM13000:6645, which aborts an RFC session instead of returning. The only remote-enabled entry point named for a parameterized SM13 call, UPD_CALL_SM13 (function group FBUP, remoteMode R), ends in `CALL TRANSACTION 'SM13'`, and an RFC session cannot run a dialog transaction. TH_START_V2 (function group THFB) is not remote-enabled and starts V2 collectively from selection ranges rather than repeating one request, and TH_REORG_VB deletes old requests rather than repeating them. Name searches for a single-request repeat found nothing in FUNC/FUGR/PROG (*VB*REPEAT*, *UPDATE*RESTART*, *RESTART_VB*, *VB*RESTART*, *NACHVERBUCH*, *UPDATE*REQUEST*, *REPROCESS*, TH_*V2*). Everything the family's purpose names - which update terminated, and what the failed update contains - is served by search_failed_updates and read_failed_update, both verified on 2026-09-30 against the one real failed update on client 200.

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `search_failed_updates` | read-only | verified | `.doc/code-update-20260930-090003.md` |
| `read_failed_update` | read-only | verified | `.doc/code-update-20260930-090003.md` |

### `system-info` - read-only

Purpose: Which release, kernel, patch level, client settings and profile parameters is this system running?

Criterion to close: gap empty and every tool verified

Declared boundaries: The database *release* is not reported, and no source this service can reach on this target supplies it: RFC_SYSTEM_INFO.RFCDATABS is typed SYSYSID (SAP system name) on this release, the same data element RFCSYSID uses, so it is published verbatim as the database system and never read as a version. Everything else the family's purpose names - client role and cross-client change protection (SCC4), system type, release, the standard-time UTC offset, CVERS.EXTRELEASE per component verbatim, the kernel release, the database system from the kernel's own RFC_SYSTEM_INFO answer, and profile parameters and headers (RZ10/RZ11) through read_system_parameters - is answered today.

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `get_sap_system_info` | read-only | verified | `.doc/code-update-20260909-084306.md` |
| `read_system_parameters` | read-only | verified | `.doc/code-update-20260927-084500.md` |

### `query` - read-only

Purpose: Ask an ad-hoc read-only question across the allowlisted tables without SAP GUI.

Criterion to close: gap empty and every tool verified

Declared boundaries: The native data preview endpoint is platform-unsupported on this release, so only the fallback dialect works: up to 8 disjuncts of up to 8 comparisons joined by AND over =, <>, <, <=, >, >=; COUNT/SUM/MIN/MAX with GROUP BY over a complete read; ORDER BY applied only over a complete read; an optional LIMIT, which must be the last clause and bounds the answer after the order rather than the read; and, since 2026-09-26 and extended on 2026-09-30, INNER, LEFT, RIGHT, FULL and CROSS joins over up to three allowlisted tables on equality keys, with every column reference qualified. The positive join path is proven on w200 as of 2026-09-30: SELECT A.TRKORR, B.AS4TEXT FROM E070 A INNER JOIN E07T B ON A.TRKORR = B.TRKORR WHERE A.TRSTATUS = 'R' answered one joined row (GR2K900199 / WF_20121016_workflow function group 03) over the fallback dialect (rfc_read_table, join.joinedRows 1, onKeys B.TRKORR = A.TRKORR), recorded in .cache/join-positive-ok.json and .doc/code-update-20260930-121500.md. The three earlier read-only attempts of the same statement - the 2026-09-27 sweeps .cache/evidence-ops-n1b and .cache/evidence-ops-n1c and the 2026-09-28 sweep .cache/evidence-ops-r23-readonly - ended in a transport-layer `socket hang up`; that failure was an artifact of a long-running MCP instance and did not reproduce after the 4849 restart at 2026-09-30 12:00:55. The negative control remains proven too (a join on the unapproved MARA is refused with TABLE_NOT_ALLOWED before SAP is touched, in all runs). An earlier version of this paragraph asserted the positive path had been proven on 2026-09-27; that assertion came from prose rather than from a record and was withdrawn on 2026-09-28 (.doc/code-update-20260928-155820.md), and it is not the basis of the claim made here. Right, full and cross joins and LIMIT were added on 2026-09-30 (record .doc/code-update-20260930-154027.md): a right join preserves the side it introduces, a full join preserves both, a cross join takes no ON clause at all, and LIMIT is applied after ORDER BY so the order decides which rows it bounds. An outer join must still be the last join, and a WHERE predicate is refused on whichever side that join does not preserve, because every predicate is pushed into the read of the table it names; a literal in ON is confined to a side the join is free to drop for the same reason (the table it introduces for INNER and LEFT, a table joined before it for RIGHT, neither side for FULL). An arithmetic term in the projection was then taken up under the user's 2026-09-30 ruling (route A: the term is implemented in the service, not reclassified as a platform boundary, because this release offers no channel that evaluates one). A term is + - * / with parentheses and a unary minus, over the table's own columns and integer or packed literals; the operand types are read from DD03L, so the calculation rule is the documented SAP one rather than a guess from the reader's one-character field type; the term publishes a derived column EXPR_1, EXPR_2 ... in projection order, which querySource.expressionColumns lists; and a term that cannot be computed exactly is refused by name instead of approximated (TABLE_QUERY_EXPRESSION_NOT_NUMERIC, _FLOAT, _DECFLOAT, _DIVISION_SCALE, _DIVISION_BY_ZERO, _OVERFLOW, _NOT_INTEGER, _TYPE_UNKNOWN, _TYPE_UNAVAILABLE, _DICTIONARY_UNAVAILABLE, _CONSTANT, _GROUPED). A term on the left side of a WHERE comparison was added next, in the same session: the reader's structured filter takes one column name, so such a comparison cannot be pushed and is decided in the service over the rows of its own disjunct, with the same dictionary-derived types and the same exact-or-refuse rule, compared as exact decimals (TABLE_QUERY_WHERE_EXPRESSION_LITERAL refuses a term compared with something that is not a number); a disjunct that carries one must have been read completely, because the matches of a sample are not the matches of the statement, and a truncated one is refused with TABLE_QUERY_WHERE_EXPRESSION_INCOMPLETE rather than filtered, while a plain comparison stays pushed down so SAP's own comparison remains authoritative. Which disjunct carried which term is published as querySource.whereExpressions. A term over a qualified column in a joined projection was taken up last, in the same session: the term is evaluated on the joined row, each operand is typed from the dictionary of the table its alias names (only the aliases a term actually reads are resolved), the operand columns are read but not published, the derived column joins the published set beside the projected qualified columns, and a term over the optional side of an outer join refuses the unmatched row instead of reading its empty value as a zero. A term is still refused together with an aggregate or a GROUP BY, and ORDER BY cannot name a derived column in the joined dialect because every ordering key there is qualified. All three parts were proven locally first - the suite grew to 1256 tests and thirty-eight mutations of the three wirings and of the set test were falsified - and the four slices behind them were then read on w200 in the same session, after the user restarted 127.0.0.1:4849 onto the build that carries them: the four read-only verify scripts hold 6 + 5 + 5 + 6 = 22 assertions and all 22 pass (.cache/r29-verify.json, r31, r33, r35, record .doc/code-update-20260930-193631.md). An earlier run of the same four scripts read 16 of 22 and the six failures turned out to be defects of the acceptance harness, not of the service - an assertion that demanded a JSON payload from a refusal that is text, a sampled value that was legitimately an exact decimal, and an outer row bound below the table's own row count - and both readings are preserved (record .doc/code-update-20260930-192647.md, probe .cache/r36-probe.json) rather than the later one being reported alone. A set test was taken up last, in the same session: <column> IN (SELECT <column> FROM <table> [WHERE ...]) is read as its own statement by this same grammar, its values form the set, and the outer row matches when its own value is in that set - NOT IN is the complement. The reader's structured filter has no set operator, so the test is decided in the service, over a read that completed (TABLE_QUERY_WHERE_SUBQUERY_INCOMPLETE otherwise) and over a set that completed (TABLE_QUERY_SUBQUERY_INCOMPLETE): a row whose value is outside a sample is not a row whose value is outside the set. The two sides are compared as values rather than as text - the dictionary type of both decides the class, character fields compare with trailing blanks ignored and numeric fields as exact decimals - and a pair this layer cannot compare (a floating-point field, a mixed pair, a type in neither class, an empty numeric value) is refused by name (TABLE_QUERY_SUBQUERY_TYPE, _FLOAT, _VALUE, _TYPE_UNKNOWN, _TYPE_UNAVAILABLE) instead of being compared as printed text, and an inner statement that is not one plain column is refused with TABLE_QUERY_SUBQUERY_PROJECTION (a limited or ordered page is not a set). Which disjunct carried which test, on which column, with how many values, is published as querySource.whereSubqueries; the tested column is read but not published when the statement does not select it. A scalar subquery was taken up last, in the same session: <column> <operator> (SELECT ...) is read as its own statement by this same grammar and the outer row matches when the comparison with the one value it answers holds. The inner statement must answer exactly one row - one aggregate over no groups, or one plain column whose read returned one row - and everything else is refused by name rather than answered: several rows (TABLE_QUERY_SCALAR_ROWS; this layer will not pick one of them and answer a different question), no row (the same code: SQL reads that as NULL and answers "unknown", a three-valued rule this layer does not reproduce), a projection that is neither one aggregate nor one plain column (TABLE_QUERY_SCALAR_PROJECTION), and an ordered or limited page (TABLE_QUERY_SCALAR_PAGE; a page is not a value, and a LIMIT 1 would hide the several rows this layer refuses to choose between). The comparison is the same one the set test makes and follows the same discipline: the class comes from the dictionary type of both sides, character fields compare with trailing blanks ignored and numeric fields as exact decimals, and a pair this layer cannot compare is refused by name (TABLE_QUERY_SCALAR_TYPE, _FLOAT, _VALUE, _TYPE_UNKNOWN, _TYPE_UNAVAILABLE) instead of being compared as printed text; ordering a character value is refused as well (TABLE_QUERY_SCALAR_ORDER), because SAP orders character fields by a collation this layer cannot state, so only = and <> are decided there. The inner statement is typed from its own table's dictionary - COUNT answers the INT4 this layer computes, SUM/MIN/MAX answer the type of the column they aggregate - and the value the inner statement answered is published as querySource.whereScalars: unlike a set, which the mapping counts rather than repeats because it can be arbitrarily large, a scalar is one value. A scalar comparison decided over an outer read that stopped at the row bound is refused with TABLE_QUERY_WHERE_SCALAR_INCOMPLETE rather than filtered, the same rule the term and the set test follow. The slice was then read on w200 too, after the user restarted 127.0.0.1:4849 onto the build that carries it: .cache/r38-verify.mjs holds 13 assertions and all 13 pass (output .cache/r38-verify.json), so every declared capability of this family now has a real-machine reading. That reading settled two facts this text states: an aggregate answers a value without naming a column, so querySource.whereScalars reports valueColumn null for ZAEHL = (SELECT COUNT(*) ...) where a single-column inner statement names the column it read; and a whole-row read of T006 - which is what an unfiltered aggregate over that table performs - is refused by the decode guard with TABLE_QUERY_NUMERIC_OVERFLOW. A read-only follow-up of that refusal (.cache/r39-probe1\|3\|4\|6\|7.mjs, 2026-09-30) located its cause in the data and in the field's text width rather than in a guard drawn too narrow: of T006's 276 rows 274 decode (273 carry ADDKO 0.000000 and one 9.000000, every text 8 characters) and exactly two do not - MSEHI GC and FA, the two rows whose DIMID is TEMP, whose ZAEHL/NENNR are 1/1 and 5/9 and whose EXP10, EXPON, DECAN and TEMP_VALUE are all zero, so the additive conversion constant they carry can only live in ADDKO. ADDKO is DEC 9/6 and the reader's own field metadata gives it a 9-character text box, while the Celsius and Fahrenheit constants those rows carry need ten characters, so the text cannot be a plain decimal; the guard refuses it by name, and since it accepts every digit-led decimal of that width (the 274 rows read back prove it), a silently truncated decimal would have been published rather than refused. The refusal is therefore correct and stays: a caller who needs the rest of the table excludes those two keys with a pushed character comparison, while a whole-row read - SELECT * or an unfiltered aggregate - necessarily includes them. Since 2026-09-30 that refusal also carries the evidence needed to locate it: TABLE_QUERY_NUMERIC_OVERFLOW names the column that could not be decoded, the untrimmed text the reader took out of that column's box, and the row's primary key as far as the projection carries the table's key columns (a projection that carries none leaves the key absent rather than inventing one). The untrimmed text is the point: the guard fires on the trimmed value, so which of its two clauses named the refusal - replacement text carrying an asterisk, or a form it does not accept as a plain decimal - is readable from the evidence itself, and a whole-row read of T006 GC and FA is the one reading left that still needs a real call to settle it. What no reading changes is the outcome: the width argument already shows that the value those two rows carry cannot be printed in that field's box at all, so no decoded numeric value is withheld - there is none to withhold. That is also why this family's verify scripts project one column or filter to a small match set instead of reading that table whole. A join read is also bounded: an ORDER BY over a read that stops at the row bound is refused with TABLE_QUERY_ORDER_BY_INCOMPLETE rather than sorted partially, and LIMIT does not excuse that refusal - completeness is judged over the whole match set before the limit is applied. A correlated subquery - one whose inner statement refers to the outer row - is outside this layer's method rather than a task still to be done: the method establishes one set (or one value) with one complete read, while a correlated inner statement has to be planned and evaluated per outer row by the database, and this release offers no channel that evaluates one (the native preview endpoint is unsupported, and the reader takes one column, one operator and one literal). Open SQL beyond the finite grammar is bounded for the same reason - HAVING, UNION, DISTINCT, CASE, functions other than COUNT/SUM/MIN/MAX, non-equality join keys, more than three joined tables: the layer reproduces only what the documented rules let it state exactly, and guessing the rest would answer a different question than the one that was written. Such a statement is left to the platform's own error, which on this release is the empty-HTML answer.

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `read_abap_table` | read-only | verified | `.doc/d9-0-transport-forensics-20260922.json` |
| `execute_data_query` | read-only | verified | `.doc/code-update-20260925-221900.md` |

### `runtime-resources` - read-only

Purpose: Which work processes and sessions are live, what is on the application server's filesystem, and what performance data exists?

Criterion to close: gap empty and every tool verified

Declared boundaries: The DB02 half of this family is answered from a vendor-specific source rather than from a vendor-neutral activity module. The platform is readable: RFC_SYSTEM_INFO returns RFCDBSYS (data element SYDBSYS, the central database system) through the fingerprint-pinned reader whose kernel and database values get_sap_system_info already publishes as serverFacts, so nothing here waits on an approval the service cannot grant itself. What is missing is a module that reports activity: the storage and statistics modules that probing reached (DB02_ORA_SELECT_SEGMENTS, DB02_ORA_LAST_ANALYZED, DB02_GET_EXTENT_LIST_DB2) are remote-enabled but answer for space and analysis - the Oracle pair reads dba_tab_columns.last_analyzed/sample_size/num_rows, statistics freshness rather than activity - DB02_DB_ACTIVITY was not found by name, and the vendor-neutral DB_AN_DB_KPIS requires a CCMS node handle (MT_TOOL_INFO typed ALTLEXDESC) and raises MESSAGE e001(sada) when it cannot read one, so an external caller can neither supply its context nor survive its failure. DB02 is split by database vendor (DB02_ORA_*, DB02_*_DB2, DB6_*), so read_db_activity reads the DB6 history tables and this family is answered on a DB6 target. Two further limits are fixed: every helper-backed read here is bounded by the helper's own row cap (200 rows for the work-process, session and directory reads), so a longer result is reported as partial with truncated set rather than returned in full; and read_workload_directory answers with the collector's own index of the aggregates it holds, not with the workload numbers inside them.

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `read_work_processes` | read-only | verified | `.doc/code-update-20260930-130913.md` |
| `read_user_sessions` | read-only | verified | `.doc/code-update-20260930-143501.md` |
| `read_performance_snapshot` | read-only | verified | `.doc/code-update-20260930-125503.md` |
| `read_db_activity` | read-only | verified | `.doc/code-update-20260930-125503.md` |
| `read_file_system_directory` | read-only | verified | `.doc/code-update-20260930-125503.md` |
| `read_workload_directory` | read-only | verified | `.doc/code-update-20260927-084500.md` |

### `interfaces` - read-only

Purpose: Is an outbound or inbound queue stuck, and did the IDoc arrive?

Criterion to close: gap empty and every tool verified

Declared boundaries: The outbound-mail question - is mail piling up here - is not answered, and no tool claims to. read_email_queue was withdrawn from this family on 2026-09-28 by the operator's ruling, because SOST *was* approved and registered and its read path does work: the same date's read-only forensics (.doc/code-update-20260928-093237.md) show the table carries no live traffic on w200 - every row is SNDART='INT' and DIRECTION='S', STA_ORDER is empty throughout, and no row is dated later than 2014-12-01 - so a tool reading it would have reported a frozen 2013-2014 internal SAPoffice send log as the present, which is the misleading-tool failure this project forbids. The slot was refilled in the same ruling-set not by removing the claim but by naming a capability the approved tables did not already answer: the SM58 tRFC error queue through read_trfc_error_entries, which reads ARFCSSTATE and answers whether an outgoing tRFC LUW is stuck in error. ARFCSSTATE was registered on 2026-09-28; its sibling payload table ARFCSDATA was approved in the same ruling and then deliberately NOT registered, because ARFCBLCNT (RAW 4) plus ARFCDATA01..07 (RAW 255 each) have no character column at all and the joined row is far past the 512-character limit this read path accepts - the tRFC payload is therefore a declared boundary of the read path, not a silently missing row of the allowlist. qRFC/tRFC queue state (TRFCQOUT/TRFCQIN/TRFCQSTATE) through read_qrfc_queues and IDoc control and status records (EDIDC/EDIDS) through read_idoc_status were already covered.

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `read_qrfc_queues` | read-only | verified | `.doc/code-update-20260927-084500.md` |
| `read_idoc_status` | read-only | verified | `.doc/code-update-20260927-084500.md` |
| `read_trfc_error_entries` | read-only | verified | `.doc/code-update-20260928-162050.md` |

### `authorizations` - read-only

Purpose: Why did this user's transaction fail on authorization, and what is assigned to them?

Criterion to close: gap empty and every tool verified

Declared boundaries: Reported: the stored role assignments per user (AGR_USERS), the transactions of a role (AGR_TCODES) and the profile assignments of a user master record (UST04) through read_user_authorizations - assignment master data, never an authorization decision - the role itself resolved into the authorization objects, fields and values it stores (AGR_1251/AGR_1252, the profiles it generates from AGR_PROF and the UST10S/UST10C profile path behind a flag) through read_role_authorizations, and the kernel's authorization trace through read_authorization_trace: both the switch (AUTH_TRACE_GET_STATUS.RC) and SAP's own trace-result rows from USOB_AUTHVALTRC, reached through the remote-enabled pair AUTH_TRACE_GET_AUTHVAL_KEY / AUTH_TRACE_GET_AUTHVAL_DATA in the same SAUTHTRACE function group. No SAP-side helper and no operator allowlist entry is involved in any of the three: the trace table itself is outside the D5-2 table allowlist, so the two function modules are the route, the same way read_workload_directory reaches its data. Declared limits, none of them a missing tool. (1) The 16-bit FIELDSUSED vector of a trace row (XUBITVEC16, RAW 2) is returned verbatim and is deliberately not decoded into a list of used fields: the bit-to-slot mapping is applied on a path this service cannot read, and SAUTHTRACE contains no decoder - its only two readers select the row and pass it on, and the group's generated RFC wrappers only declare the parameters. The checked values themselves are in FIELD1..FIELD9 and FIELD0 and are returned as stored. (2) A trace that was never switched on leaves the table empty, and w200's switch reads 'not active'; an empty answer therefore means no trace record was stored, never that the capability is missing. (3) Nothing here starts, stops, clears or activates a trace, and no row of the trace is written, changed or deleted - the whole family is read-only, and no tool in it states that a user is or is not authorized.

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `read_user_authorizations` | read-only | verified | `.doc/code-update-20260927-084500.md` |
| `read_role_authorizations` | read-only | verified | `.doc/code-update-20260930-211934.md` |
| `read_authorization_trace` | read-only | verified | `.doc/code-update-20260928-155820.md` |

### `spool-output` - read-only

Purpose: What is actually in a spool request: the rendered text, the OTF/PDF, or the original report's output?

Criterion to close: gap empty and every tool verified

Declared boundaries: Declared limits, none of them a missing tool. (1) Rendered text is the only format this family ever planned, and since 2026-09-29 it works: read_background_job_spool returns the primary job-step spool as text - spool 12717 of ZTEST/09381400 rendered three lines (.doc/code-update-20260929-192300.md) - and is verified. (2) OTF/PDF conversion, printing and original report execution stay absent and will not be added: each needs SAP GUI print or report-execution machinery outside the read-only loop, which this service deliberately does not drive, so a caller that needs the formatted page prints it in SAP GUI.

| Tool | Role | Status | Evidence |
| ---- | ---- | ------ | -------- |
| `read_background_job_spool` | read-only | verified | `.doc/code-update-20260929-192300.md` |

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
