# Operations coverage: scenario families, end-to-end rule and the authorization model

This document explains how the operations (`ops`) surface is judged. It deliberately does **not**
restate the family list: the single source is `src/ops-coverage.ts`, and the authoritative, current
value is the `opsCapability` block of `get_capability_report`. A second hand-maintained copy of the
matrix in Markdown is exactly the kind of drift this design removes.

## 1. Why the block exists

A tool list is not a coverage claim. Before `opsCapability`, the capability report could say an ops
tool was `available` while carrying no statement about which operational scenario it closes - and a
scenario that can be _seen_ but not _acted on_ reads like coverage when it is not.

`get_capability_report` therefore publishes, alongside `capabilities` (availability) and
`verification` (what was actually called on SAP), a third, orthogonal dimension under
`opsCapability`:

- every `ops`-group tool carries exactly one **role**;
- every tool is filed into the scenario **families** it serves;
- each family's **state** is _derived_ from the tool registry plus one declared gap - never
  hand-written, so the number moves only when the surface does.

Like `verification`, the block never changes an availability or verification verdict.

## 2. Vocabulary

Per-tool role:

| role               | meaning                                                                   |
| ------------------ | ------------------------------------------------------------------------- |
| `read-only`        | observes SAP; never changes state                                         |
| `action`           | changes SAP state; reaches SAP only through a confirmation gate           |
| `platform-blocked` | the tool exists but this SAP release does not serve the endpoint it needs |

Per-family state:

| state          | meaning                                                                                |
| -------------- | -------------------------------------------------------------------------------------- |
| `absent`       | no tool serves the family at all                                                       |
| `blocked`      | every present tool is stopped by the platform - a different statement from "not built" |
| `partial`      | something exists, but the family's declared gap is still open                          |
| `read-only`    | closed; the family needs no action on SAP                                              |
| `read-and-act` | closed; the read and the action are both present                                       |

Roles are checked against the registry annotations by `opsClassificationProblems()`, and
`opsCapabilityBlock()` refuses to publish a block when that check is non-empty: an ops block that
silently drops a tool or a family looks like an answer without being one. The gate test additionally
falsifies the guard itself (a family that loses a planned tool, a role that contradicts the registry,
an exemption on a family the platform does not block), so the check is known to be able to fail.

## 3. The end-to-end rule

> A family counts as end-to-end only when its declared `gap` is empty. Monitoring reads never
> compensate for a missing action.

Two consequences worth stating explicitly, because both were previously easy to overstate. **Both are now historical illustrations, superseded by later deliveries - kept because they show why the rule bites, not as a statement about today:**

- ~~The **jobs** family does not become `read-and-act` because job details and spool text can be read. Job control is absent, so the family stays `partial` and the gap names the missing control.~~ **Superseded:** the four job-control actions (create/modify/release/cancel) were delivered and verified on 2026-10-01, so `jobs` is `read-and-act` with an empty gap (`docs/ops-acceptance-matrix.md` §`jobs`).
- ~~The **transport** family has both readers and writers (create, add objects, cleanup) and is still `partial`, because release and import - the operations that actually move an object forward - are absent.~~ **Superseded:** `import_transport_queue` is verified, and `release_transport_task` was withdrawn by an operator ruling as a recorded platform boundary rather than an open gap, so `transport` is `read-and-act` with an empty gap.

The rule itself has not changed, and today **no family declares a non-empty gap**; read the live values from `opsCapability`, never from these paragraphs.

### 3.1 Family count, and the one exemption

The assessment's frozen matrix
(`.doc/orvanta-mcp-ops-coverage-assessment-and-next-phase-plan-20260925.md` §3.1) lists **14**
families and allows **one** family to be exempt when the platform - not the plan - makes it
impossible (§6). The block therefore reports **15** families: the matrix's 14 plus the runtime-trace
family, whose only tool (`analyze_abap_traces`) is `platform-blocked` because this release serves no
ADT trace endpoint.

Splitting that family out instead of folding it into another one is deliberate: it keeps the
disappointing number visible and it makes the exemption a checkable claim in the block itself -
`requiredEndToEndFamilyCount` (14), `exemptFamilies` (`["traces"]`) and `outstandingRequiredFamilies`.
The guard accepts an exemption only for a family whose every present tool is `platform-blocked` and
which carries a non-empty written reason, so the target cannot be lowered by declaring families
exempt.

`docs/ops-acceptance-matrix.md` is the plan's OP4-1 deliverable: the same 14 families plus the
exemption, each row carrying the family's purpose, the read and action side it has, its state, the
evidence pointer behind every tool, and **who can remove what is still missing** (`closeRoute`:
`service` / `helper` / `approval` / `authorization` / `landscape` / `platform` / `none`). It is
generated from this module and the registry - `npm run ops:matrix:generate`, checked by
`npm run ops:matrix:check` inside the repository gate - so a state change cannot ship with a stale
acceptance table, and the guard refuses a family that declares a gap without naming a route to
removing it.

**Historical snapshot - superseded, kept for the record.** At product version 0.50.9 the block reported
**2 of 15 families end-to-end (13%)**, which is **2 of the 14 required families (14%)**, with 23 planned
tools still unbuilt and `criterionMet: false`. The earlier assessment put end-to-end closure near 40%;
that figure counted read-side breadth across families, not family purposes. This document's rule is the
stricter one, and it is the one the completion criterion uses. Both readings agreed the 95% target was
far from met at that time.

**Current reading (2026-10-02, version 0.50.23): all 14 required families are closed -
`criterionMet: true`** - so the paragraph above records where this work started, not where it stands.
Read live numbers from `docs/ops-acceptance-matrix.md`, which is generated from `src/ops-coverage.ts`
and guarded by `npm run ops:matrix:check`. Do not read a closure figure out of this prose section: it is
narrative and is not regenerated.

## 4. Reading the evidence dimension

Each family rollup splits its present tools into `verified`, `unverified` and `failing`, joined
against `contracts/verification-registry.json`. The join is evidence, not availability: a tool can
be `available` and `unverified` at the same time, and that is the normal honest state. A packaged
build ships without `contracts/`, so every tool degrades to `unverified` rather than being implied
verified.

## 5. Authorization model

### 5.1 Tiers

1. **Read tier** - the `readonly` profile plus the read-only ops tools. No confirmation string, no
   SAP write, no lock clearing, no update reprocessing, no transport release. Approved through the
   helper families described below.
2. **Action tier** - a tool that changes SAP state must pass a literal confirmation gate that is
   checked _before_ SAP is contacted, and must verify its own effect by reading it back. Current
   gates on the ops surface: `CREATE_TRANSPORT_REQUEST`, `ADD_OBJECTS_TO_TRANSPORT`,
   `RUN_ABAP_PROGRAM`, plus `SAP_STATE_VERIFIED` for a local lock release and
   `acknowledgePotentialSideEffects: true` for customer RFC invocation.
3. **Platform-blocked tier** - reported as `platform-unsupported`/`platform-blocked` with no
   workaround that bypasses the platform. Absence of an endpoint is a finding, not a task for the
   caller to retry differently.

### 5.2 Helper families and the human approval gate

The maintenance, operational-log and application-log families are separately deployed SAP helpers
whose reads are gated by a **local approval file on the machine running the service**:
`maintenance-diagnostic-approvals.json`, `operational-log-approvals.json`,
`application-log-approvals.json`. Deployment, interface-fingerprint approval and the local approval
file are three independent gates. A refusal is returned _before_ any SAP access and carries the
reason code - `APPROVAL_FILE_MISSING`, `CONNECTION_NOT_APPROVED` or `SOURCE_NOT_ENABLED` - together
with the approval-file path the service actually read.

The capability report cannot distinguish "helper not deployed" from "helper deployed but not locally
approved" for these families, because it does not probe them. Trust the tool reply, not an absent
attestation.

### 5.3 Standing prohibitions

- No read tool ever deletes: no lock deletion, no update reprocessing, no spool deletion, no
  transport release or import.
- No automatic retry of a write; a program that writes must not be run twice by accident.
- Local receipts (approval files, request IDs, receipt hashes) prove what _this service_ did. They
  never prove SAP lock ownership or SAP-side state.
- A transport is never released automatically; transport inspection is read-only unless the user
  explicitly authorizes a transport operation.
- Never delete files or SAP objects during diagnosis; report and leave cleanup to the user
  (SE09/SE10 and friends).

### 5.4 Idempotency and retry safety

Retry safety here is not a retry loop, it is an identity. A tool that changes SAP state reserves a
**write-operation receipt** before SAP is contacted and settles it afterwards:

- The reservation identity is `(connectionId, toolName, operationId, targetKey)`; the caller supplies
  the unique `operationId` (1-64 characters of `[A-Za-z0-9._:-]`). Reserving an identity that already
  exists never reaches SAP: the tool answers `duplicate_blocked`, or `request_id_conflict` when the
  same `operationId` arrives with a different input hash, and returns the existing receipt.
- Receipt states are `in_progress`, `completed`, `declared_fault` and `outcome_unknown`, with
  `sapInvocationStarted` and `lockReleased` recorded separately, so "we never sent it" stays
  distinguishable from "we sent it and never learned the outcome". An `outcome_unknown` receipt is
  evidence that an attempt reached SAP - which is exactly why the service never retries a write on
  its own.
- `outcomeMayBeUnknown` is not a synonym for "the tool failed". A failed write that ended with a
  post-change read-back reporting what SAP holds - the source write that saved an inactive draft and
  could not activate it is the case that exists today - answers `outcomeMayBeUnknown: false` and
  carries the read-back as `postChangeObservation` (save, unlock, activation flags, intended, active
  and inactive fingerprints, read-back error). That still means SAP changed: the draft is there, the
  active version is the pre-change one, `automaticRetry` stays `false`, and `manualRecovery` names
  the repair call (`recoverInactiveSource=true` with the reported draft fingerprint as
  `expectedSourceFingerprint`). A partial read-back is stored as evidence but leaves the outcome
  unknown, because a fingerprint that was never read cannot prove anything.
- A per-target lock makes a second concurrent operation on the same object answer `target_busy`
  instead of interleaving. `protection_failed` means the receipt or lock layer itself could not be
  established, and the operation is refused rather than sent unprotected. That receipt carries the
  errno code and the error class of the local failure (`errorCode` and `errorName`, both bounded and
  without the raw message, which would embed the absolute state path), so a refusal by the operating
  system can be told apart from a defect in the guard; the message itself stays out of the receipt
  and only `errorHash` is kept.
- The same state root holds the RFC-level invocation receipts (request-id hash, input hash, output
  hash, interface and definition fingerprints) and the pre-change evidence captured before a write
  (existence, active state, version, fingerprint, package, request and task). A receipt written
  against a different function-module definition is a mismatch, not a cache hit.
- These receipts prove what _this service_ did on _this machine_ (§5.3). They never prove SAP-side
  lock ownership, and they are not a substitute for the post-write read-back the tool performs.

`run_abap_program` (development surface, not an ops tool) carries a confirmation gate whose contract
claims no read-back, because a program's effect is not generally readable. The ops catalogue
therefore states read-back per tool instead of claiming it globally.

### 5.5 Approval files, and what "cross-machine" means

Three gates are independent: helper deployment (SE38 / F8), interface-fingerprint approval, and a
**local approval file on the machine that runs the service**. The files live under the service state
root:

- root: `ABAP_MCP_STATE_DIR` when set, otherwise `%LOCALAPPDATA%\ABAP MCP Standalone\state`, otherwise
  `~/.abap-mcp-standalone/state`;
- one document per gated family: `maintenance-diagnostic-approvals.json`,
  `operational-log-approvals.json`, `application-log-approvals.json`;
- each entry pins URL, client and user plus the helper's source and interface fingerprints, and the
  read tools refuse with `APPROVAL_FILE_MISSING` or `CONNECTION_NOT_APPROVED` _before_ SAP is
  contacted, naming the path they actually read.

The consequence is worth stating plainly: approval is **per machine and per helper fingerprint**.
Moving the service to another machine, or redeploying a helper with a new fingerprint, reopens the
gate. The cross-machine scheme is therefore an explicit configuration source rather than a copied
file - point `ABAP_MCP_STATE_DIR` at wherever the deployment keeps its state (a shared or
orchestrated configuration location) so approvals are managed where the deployment is managed. Until
that variable is set deliberately, the default stays machine-local and a second machine must be
re-approved. The service never writes an approval file itself.

### 5.6 Table and function allowlists are authorization gates, not implementation detail

Two deny-by-default allowlists gate data access and belong to this model:

- **Tables** (`src/table-allowlist.ts`, governing `read_abap_table` and the query dialect): tier A
  metadata, tier B customizing, tier C business and master data, plus a product-required tier and an
  indirect-format-read tier. Tier C is registered **per table after approval**;
  `TABLE_PENDING_APPROVAL` names tables that are evidenced but not yet approved, so a refusal
  distinguishes "waiting for your approval" from "never considered"; `TABLE_NEVER_ALLOWED` names
  tables whose readability would itself be a security incident (password hashes, HR personal data,
  financial document line items) and is used to explain the refusal. A read is bounded to 500 rows and
  30 seconds.
- **Remote functions** (`remoteFunctionAllowlist`, per connection): only remote-enabled customer
  function modules (`Z*` / `Y*`) can be invoked, each one listed explicitly; anything else is refused
  before any SAP access.

This is why a new family of readers is not only an implementation task: registers such as IDoc
control records, qRFC queues and SAPoffice send requests carry interface or business data, so they
have to be classified into a tier and approved table by table before registration. Kernel and
database release are the mirror case on the function side: they come from `RFC_SYSTEM_INFO`, a
standard function module that the customer-function allowlist deliberately does not admit, so that
data needs a deployed helper operation rather than a wider allowlist.

## 6. Completion criterion for the operations programme

The operations programme is complete when, for at least 95% of the **required** families in
`src/ops-coverage.ts` - the 15 minus the ones carrying a written platform exemption (§3.1), i.e. 14 of
14 required families today, because 95% of 14 rounded **up** is 14:

1. the family state is `read-only` or `read-and-act` (declared gap empty);
2. every tool in the family is `verified` in `contracts/verification-registry.json`, with evidence
   recorded from the target system - not `unverified`, `failed`, or `platform-unsupported` unless
   the platform limitation is itself the closed finding;
3. any action the family performs is reachable only through a confirmation gate, verifies its own
   effect by reading back, and is idempotent or retry-safe (§5.4);
4. the family's behaviour is covered by the regression matrix, and the gate (`npm run verify`)
   passes with the new evidence.

The rounding is stated because it is the difference between a criterion and a slogan: 95% of 14 is
13.3 families, a fraction of a family cannot be closed, and rounding down would let the programme
declare success with a required family still open. The block computes exactly this - `criterionMet` is
`closedRequiredFamilies >= ceil(requiredEndToEndFamilyCount * 0.95)` - so the criterion is checked in
code, not in prose.

**Operator ruling, 2026-10-03: 14 of 14 is binding, not 13.** The 2026-09-25 plan's section 8 clause 1
asked for _at least 13_ families _(>= 95%)_, and thirteen of fourteen is 92.9%, so the plan's own two
halves disagreed. The operator ruled this section's stricter reading binding. The plan's _13_ is
therefore superseded as a target, 92.9% is never presented as 95%, and the generated matrix states the
ruling instead of carrying an open conflict (`scripts/generate-ops-matrix.mjs`). The current reading is
14 / 14, so the ruling settles the wording rather than the outcome.

Points 1 and 2 are the same conjunction in the code, not two independent readings: a required family
enters the criterion's numerator (`closedRequiredFamilyCount`) only when its declared gap is empty
**and** every present tool is `verified`. A family whose gap is empty while a tool is `failed`,
`unverified` or `platform-unsupported` is a statement about the plan rather than about the system, so
it is listed in `evidenceUnregisteredFamilies` and stays in `outstandingRequiredFamilies`. The weaker
gap-only reading is still published beside it as `stateClosedRequiredFamilyCount` / `stateCriterionMet`
so the difference is visible instead of being argued about, and `endToEndFamilyCount` remains the
structural count (families whose gap is empty) rather than a completion claim.

When the registry cannot be read at all - a packaged build ships without `contracts/`, so every tool
degrades to `unverified` - the block reports `registryLoaded: false`, a `criterionBasis` that says the
criterion could only be decided on gaps, and a numerator of zero. That is deliberately stricter than
the rest of the verification dimension, which degrades to `unverified` and carries on: the criterion is
the sentence "this is done", and without evidence the only honest answer is "cannot certify".

Point 2 is what separates this document from a progress narrative: a family that reads correctly but
whose tools carry no recorded call is not complete.

## 7. Checking the current state

- Read the block directly: call `get_capability_report` and inspect `opsCapability.families`,
  `opsCapability.summary.stateCounts`, `opsCapability.summary.missingPlannedTools`, and the criterion
  fields `requiredEndToEndFamilyCount`, `endToEndPercentOfRequired`, `outstandingRequiredFamilies`,
  `closedRequiredFamilyCount`, `stateClosedRequiredFamilyCount`, `evidenceUnregisteredFamilies`,
  `registryLoaded`, `criterionBasis` and `criterionMet`.
- Static checks (no test execution): `npm run typecheck`, `npm run matrix:check`.
- The classification guard and the expected family states are asserted in
  `test/ops-coverage.test.ts`; it runs under the repository test gate with the authorisation
  required by `AGENTS.md` section 1.1.

### 7.1 Evidence standing and the OP0-2 worklist (2026-09-25; table at 0.50.11, D1 session at 0.50.15)

> **Historical snapshot - superseded, kept for the record.** Everything below is the 2026-09-25/0.50.11 reading of a **20-tool** `ops` group. That group has since grown to **44** tools and closed out completely (`verified` 41 / `platform-unsupported` 3 / `failed` 0 / `unverified` 0); the OP0-2 worklist it describes was finished. Do not read today's standing from this section - it is narrative and is not regenerated. The live per-tool values are in `contracts/verification-registry.json` and `docs/ops-acceptance-matrix.md`.

Of the 20 `ops` tools _as of that date_, `contracts/verification-registry.json` recorded `verified` 15,
`platform-unsupported` 1 (`analyze_abap_traces`), `failed` 1 (`cleanup_transport_entries`) and
`unverified` 3. The first fourteen verified entries were registered from runtime records this
workspace already held (2026-08-27 to 2026-09-25, versions 0.3.x to 0.50.4) - see
`docs/helper-capabilities-protocol.md` section 4A-0. The fifteenth, `read_background_job_details`,
was closed by the D1 read-only session on 2026-09-25 (0.50.15), recorded in
`.doc/code-update-20260925-221900.md` with its raw output in
`.doc/orvanta-mcp-ops-evidence-20260925.json`; the same session verified `execute_data_query`, a
`data`-group tool exposed in the `ops` profile, against the allowlisted customer table. Point 2 of
section 6 is therefore no longer the binding constraint for the closed families; the table below
states each row's standing, including what that session changed and what it could not:

| Tool                          | Status                 | What closing it needs              | Standing after the latest recorded call (each cell names its own record; last update 2026-09-30)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | ---------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_background_job_details` | `verified`             | closed                             | `read_background_job_details(jobName=SWWDHEX, jobCount=00001200)` returned `status=ok` with one step (program `RSWWDHEX`, execution user `WF-BATCH`) and a revision, so the detail path is proven on live data rather than only deployed. That job reported spool id `0000000000`, so nothing in this call covers spool content.                                                                                                                                                                                                                                                            |
| `read_background_job_spool`   | `verified`             | closed                             | closed on 2026-09-29: the chain TSP01 LIST spool `12717` → TBTCP step 1 of `ZTEST`/`09381400` → TBTCO header with `AUTHCKMAN 200` ended in `status=ok` with `spoolId 12717` and three rendered lines, after the `RSPOID` INT4 normalisation. The blocked attempts recorded in the 2026-09-25 snapshot still explain why no sample could be read before that day. Evidence `.doc/code-update-20260929-192300.md`.                                                                                                                                                                            |
| `search_failed_updates`       | `verified`             | closed                             | closed on 2026-09-30: an allowlisted `VBHDR` read showed client 200 holds exactly one header row (`state 255`, `returnCode 9` - inside this tool's own predicate), and the window `2025-02-11T13:56:40`-`14:56:40` for `HHM` then answered `status=ok`, `code=OK`, `returnedCount=1`, `hasMore=false` with that exact key. The empty-window history stands: the 158 approved windows really held nothing, and an empty window still proves only that window. Not proven: the 100-row bound, `hasMore`, a second user, a state-only failure. Evidence `.doc/code-update-20260930-090003.md`. |
| `read_failed_update`          | `verified`             | closed                             | closed on 2026-09-30 with the key the `VBHDR` read produced: `status=ok`, `code=OK`, one module (`RS_NEW_PROGRAM_INDEX`, mode 1, returnCode 9), one error (messageClass `00`, messageNumber `671`, line 20, `textUnavailable=true`) and revision `b8b6c65e…`; no encoded message parameter and no `VBDATA` came back. Not proven: the `expectedRevision` drift guard and the 200-module/error bounds. Evidence `.doc/code-update-20260930-090003.md`.                                                                                                                                       |
| `cleanup_transport_entries`   | `platform-unsupported` | closed by the 2026-09-25 D2 ruling | two structurally different payloads were PUT against w200 and neither removed the entry, the native ADT `removeobject` action is absent on this release, and the tool's own post-check refuses to report success. The operator ruled the platform boundary to be the closed finding, so the row moved from `failed` to `platform-unsupported`; the remedy is SE09/SE10.                                                                                                                                                                                                                     |

The same session produced two facts about this surface that are not evidence standing at all, both
recorded in the session's `.doc` record:

- `execute_data_query` only reached the finite fallback dialect when `maxRows <= 500`, because
  `src/tools.ts` rethrew the platform's own `SAP_DATA_QUERY_RESPONSE_INVALID` above that, and the
  description did not state the ceiling - so an unqualified call, whose budget defaults to 1000,
  read as a platform failure rather than as a rejected input. Fixed the same day: the dialect read
  is clamped to the allowlist ceiling (`ALLOWLIST_MAX_ROWS`), the description states it, the
  truncation is still reported, and an aggregate over an incomplete read is still refused.

The approval files were a prerequisite of the session rather than a result of it:
`operational-log-approvals.json` did not exist at all, so every operational-log read was refusing
with `APPROVAL_FILE_MISSING`, and `maintenance-diagnostic-approvals.json` approved only `SM12`.
Section 7.3 records how both are re-issued.

One counting note so the numbers above cannot be misread: the twenty tools of the `ops` **group** are
what the table above covers as of 2026-09-25 - the group has since grown to 44 - and the `query` family additionally holds two tools from the `data` group
that are exposed in the `ops` **profile** (`read_abap_table`, verified; `execute_data_query`, verified
by the D1 session). Evidence standing is therefore stated per tool in
`contracts/verification-registry.json`, never as a single family-level score.

### 7.2 Ops runbooks (OP4-2)

`docs/ops-runbooks.md` turns the parts of this surface that already work into repeatable playbooks
(trigger, ordered calls with real parameter names, how to read the result, when to stop, and what the
result cannot prove). Its acceptance criterion - "a runbook can run inside the `ops` profile" - is
code rather than prose: `test/ops-runbooks.test.ts` parses the manifest in that document and asserts
that every tool it names resolves under `ABAP_MCP_TOOL_PROFILE=ops`, that every tool is read-only
(runbooks cannot mutate SAP state), that manifest and prose agree in both directions, and that all
fifteen families are either covered by a runbook or listed with a written reason. Eight runbooks
cover nine families (`jobs`, `spool-output`, `dumps`, `logs`, `locks`, `updates`, `transport`,
`system-info`, `query`); the other six carry reasons that are mostly "the tools do not exist yet",
which is the same gap the table above lists. A runbook is not a coverage claim: it cannot make a
family end-to-end, and it names the tools whose evidence is still missing instead of implying
verification.

### 7.3 Re-issuing the approval files (helper-bound approvals)

Section 5.5 states why these files exist, where they live and what "cross-machine" means; this section
is the procedure. Both families below read the file on every call and refuse the call when it is
missing, when the connection is absent from it, or when the deployed helper's fingerprints no longer
match the ones the file pins:

| File                                    | Family                                                        | Approved sources                                                       | Refusal when not satisfied                                              |
| --------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `operational-log-approvals.json`        | `logs` (SM37/SM21/SP01) + report parameters + runtime metrics | `SM37`, `SM37_DETAILS`, `SM21`, `SP01`, `RUNTIME`, `REPORT_PARAMETERS` | `HELPER_NOT_APPROVED` / `APPROVAL_FILE_MISSING` / `SOURCE_NOT_APPROVED` |
| `maintenance-diagnostic-approvals.json` | `locks`, `updates`                                            | `SM12`, `SM13`                                                         | `HELPER_NOT_APPROVED` / `APPROVAL_FILE_MISSING`                         |

The operational-log file is also the only gate on `read_report_parameters`: that tool has a single route
(`src/mcp.ts:1052-1053` → `OperationalLogService.readReportParameters`), which calls
`Z_ORVANTA_OPS_READ`, so the source must be listed for the connection before the tool can reach SAP at
all. Its per-source refusal is `SOURCE_NOT_APPROVED` with `isError: false`, returned before any SAP
call.

Both files pin `connectionId`, `url`, `client`, `username`, the helper's `sourceFingerprint` and
`interfaceFingerprint`, and the enabled sources. Because the fingerprints describe the **deployed**
helper, re-deploying a helper (SE38 carrier + F8) invalidates every approval for it until the file is
re-issued; the call then fails closed rather than reading through an unreviewed helper build. Both
files are re-read per call, so no service restart is needed after a re-issue.

The maintenance family ships a preparer, and the fingerprints it records come from
`read_function_module_interface` (a read) rather than from any document:

```
node scripts/prepare-maintenance-approval.mjs --sources SM12,SM13 --write --connections <connections.json>
node scripts/prepare-maintenance-approval.mjs --sources SM12,SM13 --verify --connections <connections.json>
```

The operational-log family has no shipped preparer. The equivalent is a small MCP client that reads
`Z_ORVANTA_OPS_READ` through `read_function_module_interface`, checks that `functionGroup` is
`ZORVANTA_LOG`, `remoteEnabled` is true, `updateTask` is false and both fingerprints are sha256, then
merges `{version: 1, connections: [...]}` into the file. Merging matters: replacing the whole document
would withdraw another operator's approval. The D1 session's implementation is recorded in the
session's `.doc` record.

Withdrawal is the operator's act and stays explicit: removing one connection entry (or the file)
revokes those reads, and nothing infers an approval from a missing source list.

### 7.4 Allowlist additions and the platform boundary (2026-09-25 rulings)

Two decisions were taken by the operator on 2026-09-25 and are recorded in
`.doc/code-update-20260925-223946.md`:

- **D2 - the platform boundary is the closed finding.** `cleanup_transport_entries` is registered
  `platform-unsupported`: two structurally different payloads were PUT against w200 and neither
  removed the entry, the native ADT `removeobject` action is absent on this release, and the tool's
  own post-check refuses to report success. The remedy is SE09/SE10.
- **D3 - fourteen tables were approved individually.** Section 5.6 makes the allowlist an
  authorization gate, so these additions are an operator decision rather than an implementation
  detail. Every table was checked against w200's `DD02L`/`DD03L` first (existence, table class,
  field count and keys), and the candidate `ARCH_STAT` was dropped because it is an INTTAB with two
  fields rather than a storage table. The sensitivity of each group is written beside the entry in
  `src/table-allowlist.ts`: system parameters (`TPFYPROPTY`, `TPFHT`, B tier), job and spool
  metadata (`TBTCO`, `TBTCP`, `TSP01`, `TSP02`), interface and queue data (`EDIDC`,
  `EDIDS`, `TRFCQOUT`, `TRFCQIN`, `TRFCQSTATE`) and authorizations (`AGR_USERS`,
  `AGR_TCODES`, `UST04`) - all C tier, per-table approved. `USR02`, `USR01`, `PA0001`,
  `PA0008`, `BSEG` and `CDHRS` remain permanently forbidden, and the archive tables were **not**
  part of this ruling.
- **OP2 stays unauthorized.** The controlled-disposal phase (job control, lock/update/spool disposal,
  transport release and import) is not authorized, so the surface remains read-only.

### 7.5 OP1-4 - 系统基线与系统参数（2026-09-25）

服务侧读路径新增两项能力，均已通过本地静态门禁；**运行期未取证**，因为 4848 上运行的服务仍是旧工具面，
新工具在重启前不可达（重启需用户侧提供 SAP 密码）。

- **`read_system_parameters`（新工具，ops 组，只读）** 读 `TPFYPROPTY`（参数值）与 `TPFHT`（参数文件头），
  两者都在 D3 的十四张批准表内。列语义取自 w200 的 DDIC 数据元素而不是字段名：`OBJ_NAME`←`SOBJ_NAME`
  （对象目录中的对象名称）、`PARANAME`←`PFEPARNAME`（描述文件参数名称）、`STR`←`PFESTR`（特殊参数值的字段）、
  `PFNAME`←`PFEPFNAME`（系统参数化参数文件名）、`VERSNR`←`PFEVERSNR`（版本号）。`STR` 原样返回、不做任何解释，
  并在每行标注 `valueColumn`。过滤为精确、大小写敏感；过滤值上限 55 字符（评审读取器把每条生成条件限在 68 字符内，
  超限在触达 SAP 之前就以 `SYSTEM_PARAMETERS_SCOPE_INVALID` 拒绝）；无过滤时按 `maxRows`（缺省 200、硬上限 500）
  截断，并以 `parametersTruncated`/`profilesTruncated` 明示"这只是前缀"，不冒充完整清单。
- **`get_sap_system_info` 增加内核半边。** 六张固定表都不含内核版本，改为调用内核自身的
  `RFC_SYSTEM_INFO`，并以该函数模块的源码指纹（`5c2431d9…0b33e`）与接口指纹（`cfd8b63d…79896`）为闸门；
  取 `RFCSI.RFCKERNRL`（数据元素 `SYKERNRL`，"内核版本"）与 `RFCSI.RFCDBSYS`（`SYDBSYS`，"中央数据库系统"），
  整个 `RFCSI` 结构原样返回。失败被隔离在 `serverFacts` 里：六表读数不受影响，外层 `status` 降为 `partial`。
- **一个被证据推翻的假设（重要）。** 原计划写的是"内核/数据库版本都取 `RFC_SYSTEM_INFO`"。实测
  `read_ddic_structure(RFCSI)` 显示 `RFCDATABS` 的数据元素是 `SYSYSID`（"SAP 系统名称"），与 `RFCSYSID` 同一个，
  **它不是数据库版本**。因此该字段只在 `rfci` 中原样返回、绝不当作版本号解释；数据库版本成为 system-info 族
  唯一的剩余缺口（要么 SA 侧给一个 Basis 读数来源，要么单独批准一张 DB 版本表），不要用字段名猜。
- 两个新模块共享 `src/reviewed-table-reader.ts`（从 `system-info.ts` 抽出的受护读取器：原生预览失败指纹校验后才走
  `RFC_READ_TABLE`，无通用 SQL 回退），内部校验码按调用方加前缀（`SYSTEM_INFO_` / `SYSTEM_PARAMETERS_`），
  所以原有错误契约逐字未变；`table-query.ts` 仍从 `system-info.ts` 取 `reviewedTableReaderDefinition`（现为再导出）。
- 登记：`read_system_parameters` 以 `unverified` 进 `contracts/verification-registry.json`（144 条 = 工具数，
  四个未验证字段一个都不声明）；`get_sap_system_info` 保留原 citation，并在 notes 中写明 RFC_SYSTEM_INFO 半边
  不在那次验收范围内。族状态仍为 `partial`，`criterionMet=false`（已闭环 2/14）。

### 7.6 OP1-2 - 接口与队列（2026-09-25）

> 编号更正：接口与队列在实施记录 .doc/code-update-20260925-232602.md 中曾被标为 OP1-1；按评估计划 OP1-1 是工作进程/会话/性能/DB/文件系统，队列属 OP1-2（见 §7.8）。原记录保持不可变，此处更正编号。

新增两个只读工具，读的都是 D3 批准的十四张表；与 7.5 一样，**运行期未取证**（4848 上仍是旧工具面，
重启前不可达）。

- **`read_qrfc_queues`** 读 `TRFCQOUT`（出站队列）、`TRFCQIN`（入站队列）、`TRFCQSTATE`（LUW 状态）。
  字段清单来自 w200 的 DD03L 元数据（位置/键标志/数据元素/长度），每张表的字段宽度合计都远低于评审读取器
  512 字符的行上限。`QSTATE`/`ARFCSTATE` 是域代码，**原样返回、不翻译**（域文本在 `DD07L`，`read_abap_table`
  已可读）；TID 既给四个原始字段，也给合成值 `transactionId`。`queueName`/`destination` 为精确、大小写敏感过滤，
  过滤值上限 24 字符（超限在触达 SAP 前以 `QRFC_QUEUE_SCOPE_INVALID` 拒绝）；`TRFCQSTATE` 只在
  `includeLuwStates` 或给出 `destination` 时读取（它是三张表里最宽的一张），答案里明确写出走了哪种情况；
  无过滤时按 `maxRows`（缺省 200、硬上限 500）截断并按表报告 `truncated`。
- **`read_idoc_status`** 读 `EDIDC`（控制记录）与 `EDIDS`（状态记录）。`STATUS`/`DIRECT`/`TEST` 是域代码
  （`EDI_STATUS`/`EDI_DIRECT`/`EDI_TEST`），状态文本就是 `EDIDS` 里存的内容，**都不翻译**；源系统留空的文本
  原样返回空，不补写。过滤 `docnum`（精确，同时作用于 `EDIDS`）、`status`、`messageType`，过滤值上限 30 字符；
  `EDIDS` 只在给出 `docnum` 或显式 `includeStatusRecords` 时读取（评审读取器一次只支持一个条件，未过滤的状态
  记录读取过大）；无过滤时按 `maxRows` 截断并用 `idocsTruncated`/`statusRecordsTruncated` 明示。
- **族缺口收窄。** `interfaces` 族由"完全没有工具"变为 `partial`：qRFC/tRFC 与 IDoc 已实现。
  **【更正，2026-09-28】** 以上原本续写"剩余缺口只有**邮件队列**——`SOST` 不在批准的允许清单内，
  `read_email_queue` 需要单独批准后才能实现"，两句现均已不成立。其一，`SOST` 已于 2026-09-28 经 Q-N6
  批准并登记（见 `src/table-allowlist.ts` 的逐表注释）。其二，同日的语义只读取证证明该表在 w200 上**没有活的
  邮件流量**：全表 `SNDART='INT'`、`DIRECTION='S'`、`STA_ORDER` 恒空，且没有 `ENTRY_DATE` 晚于 `2014-12-01`
  的行（四组 `NE`/越界筛选各 0 行，均有同形 `EQ` 正对照；证据 `.doc/code-update-20260928-093237.md`）。
  因此 `read_email_queue` 经用户裁定**从该族撤下**，族的外延随之收窄为 qRFC/tRFC + IDoc。
  **【收尾，2026-09-28 晚】** 撤下的位置由用户同日裁定的第三条能力补齐：新增 `read_trfc_error_entries`
  （SM58 tRFC 错误队列，读 `ARFCSSTATE`；`ARFCSDATA` 同批批准但因其 RAW-only 布局与 1785 字节行宽**故意不登记**，
  理由写在 `src/table-allowlist.ts` 的逐表注释里）。族 `gap` 随之为空、`closeRoutes` 变为 `["none"]`，
  而"出站邮件是否积压"**不再按缺口计**：`SOST` 在 w200 上没有活的邮件流量（同上的四组筛选取证），
  因此它是这一族**已声明边界**的一部分（写在族 `boundary` 里），不是待补的能力——撤下一个能力不等于补上一个缺口，
  但**补上第三个能力**才使缺口真正归零。两个既有工具于 2026-09-27 的真实 w200 调用后转 `verified`；
  `read_trfc_error_entries` 于 2026-09-28 16:19 取得首次真实调用（实例重启到 16:07:58 构建后，
  `maxRows:500` 返回 `status=ok` / 140 条 / 无告警，带 `functionModule` 过滤的一次返回 1 条）
  并随之转 `verified`，**证据口径与状态口径至此一致**——该族是判据分子里的第 5 个必需族
  （取证 `.doc/code-update-20260928-162050.md`）。
- 读路径与 7.5 完全一致：共用 `src/reviewed-table-reader.ts`，错误码前缀 `QRFC_QUEUE_` / `IDOC_STATUS_`，
  无通用 SQL 回退、无写操作。

### 7.7 OP1-3 - 用户与权限分配（2026-09-25）

新增 `read_user_authorizations`（ops 组、只读、`target-specific`），读 D3 批准的权限分配三表：

- `AGR_USERS`（用户↔角色分配，11 字段 / 93 字符，键 AGR_NAME/UNAME/FROM_DAT/TO_DAT）
- `AGR_TCODES`（角色的菜单与事务，8 字段 / 91 字符，键 AGR_NAME/TCODE/TYPE）
- `UST04`（用户主记录的参数文件分配，3 字段 / 27 字符，键 BNAME/PROFILE）

字段与键序取自 w200 的 DD03L 元数据；三表宽度都远低于评审读取器 512 字符的行上限。**这是分配主数据，
不是权限判定**：工具从不说某用户"有/没有某权限"，也不把角色展开成权限对象——`AGR_1251`/`AGR_1252`/
`AGR_PROF`/`USOB*`/`UST10*` 不在批准允许清单内，真实追踪走 SAP 侧助手的 SU53/ST01 通路
（`read_authorization_trace`，尚未实现）。存储标志 `EXCLUDE`/`ORG_FLAG`/`COL_FLAG`/`DIRECT`/
`INHERITED` 与节点类型 `TYPE` 一律原样返回、不解释；`FROM_DAT`/`TO_DAT` 是 AGR_USERS 里存的
有效期窗口，**由工具判断"今天是否生效"被明确排除**。`UST04` 只有用户名与参数文件名；含口令的
`USR02`/`USR01` 仍永久禁止，从不读取。

过滤 `userName`（UNAME）、`roleName`（AGR_NAME，同时作为 AGR_TCODES 的条件）、`profileName`
（PROFILE），精确、大小写敏感，值上限 30 字符（超限在触达 SAP 前以 `USER_AUTHORIZATIONS_SCOPE_INVALID`
拒绝）。因评审读取器一次只支持一个条件：`AGR_USERS` 优先按 `userName`、否则按 `roleName` 过滤；
`AGR_TCODES` 仅在给出 `roleName` 或 `includeRoleTransactions` 时读取；`UST04` 仅在给出
`userName`/`profileName` 或 `includeProfiles` 时读取——答案的 `notes` 明写走了哪种情况。无过滤时按
`maxRows`（缺省 200、硬上限 500）截断并按表报告 `truncated.*`。

**族缺口收窄。** `authorizations` 族由"完全没有工具"变为 `partial`：角色/事务/参数文件分配已实现，
剩余缺口是 **SU53/ST01 授权追踪**（需 SAP 侧助手）与角色→权限对象展开（表未获批准）。工具在服务重启并
完成一次真实 w200 调用前保持 `unverified`（registry 条目数再次等于工具数）。

（**后续更正（见 7.23，2026-09-30 第六批）**：本段两处已变——`AGR_1251`/`AGR_1252`/`AGR_PROF` 等表已于
2026-09-28 获批准并登记，"角色→权限对象展开"也已由新工具 `read_role_authorizations` 交付；本族剩余缺口**只剩**
授权追踪数据本身（需 SAP 侧助手分支），因此族仍为 `partial`、必需族 11/14。本段保留为第七批当时的读数。）

### 7.8 OP1-1 - 运行时资源：工作进程与会话（2026-09-25）

**路由取证推翻了计划里的一条假设。** 评估把整个族（族 9：工作进程/会话/性能/DB/文件系统）判为"预计
SAP 助手"通路。2026-09-25 的只读探测（`read_function_module_interface`，证据落在
`.cache/evidence-r16/fm-*.txt`）表明：SAP 侧监视器函数模块本身就是 **remote-enabled 的标准 FM**，而服务
的 `callRemoteFunction` 是把 SOAP 信封直接 POST 到 `http://www.sap.com/<函数名>`（`adt-backend.ts`
L428-434），即"外部 SOAP-RFC 调用"，只要求函数模块 remote-enabled——**不需要助手操作码、不需要载体、
不需要人工 F8**。于是本族的前两个工具走服务侧实现。

| 函数模块                                                                                                                                 | remoteEnabled | 输出表（全部字段均可验证）      | 结论                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `TH_WPINFO`                                                                                                                              | 是            | `WPLIST`（`WPINFO`，25 字段）   | 可用；仅 `WITH_CPU`/`WITH_MTX_INFO`/`MAX_ELEMS` 三个**可选导入**无法解析，工具不传它们                                                      |
| `TH_USER_LIST`                                                                                                                           | 是            | `USRLIST`（`USRINFO`，16 字段） | 可用；`LIST`（`UINFO`）是**必填**参数，缺它调用以 `CX_SY_DYN_CALL_PARAM_MISSING` 中止，故一并传入；其输出含无法验证的 `MSHOSTADR`，**不读** |
| `TH_SERVER_LIST`                                                                                                                         | 是            | -                               | 可用（后续可选）                                                                                                                            |
| `SWNC_COLLECTOR_GET_AGGREGATES`                                                                                                          | 是            | -                               | 可用（`read_performance_snapshot` 的候选入口）                                                                                              |
| `EPS2_GET_DIRECTORY_LISTING`                                                                                                             | 是            | -                               | 可用（`read_file_system_directory` 的候选入口）                                                                                             |
| `RSPO_RETURN_SPOOLJOB`                                                                                                                   | **否**        | -                               | 不可直连 ⇒ OP1-5 的 Spool OTF/PDF 确实必须走助手                                                                                            |
| `TH_GET_SERVER_INFO`、`SAPWL_GET_AGGREGATED_DATA`、`CCMS_GET_ALERT_TREE`、`DB02_DB_ACTIVITY`、`DB_GET_DB_RELEASE_INFO`、`GET_DB_RELEASE` | -             | -                               | 按该名字**未找到**（记录为"未命中"，不等于不存在）                                                                                          |

**新增工具。** 两个工具都以"接口指纹闸门 + 直接 SOAP-RFC 调用 + 强制行数上限"实现，字段清单来自 w200
的 DD03L 元数据（`.cache/evidence-r16/dd03l-{USRINFO,WPINFO}.txt`）：

- `read_work_processes` · `TH_WPINFO.WPLIST`：`serverName`（`SRVNAME`，`MSXXLIST-NAME`，40 字符）原样下传，
  缺省时由内核返回它自己的默认列表（答案里明写）。固定指纹 source
  `cf3be4d651ae9af6f156fde4d8cf6ea3fd932102df575ae1d4908eae23e2ed16` / interface
  `e5d7078c36abdbbe48cb23c47071e101f82320ec1723dbc7f93b7a4c8edc2f70`。`maxRows` 缺省 200、硬上限 500；
  内核返回行数超过上限时报 `partial` + `truncated`，绝不声称完整。
- `read_user_sessions` · `TH_USER_LIST.USRLIST`：**只读取 `USRLIST`**；`LIST`（`UINFO`）是必填参数，
  因此也一并传入（与标准程序 `RSDSUSER` 同一调用形态，缺它调用以 `CX_SY_DYN_CALL_PARAM_MISSING` 中止），
  但其输出不读，因为含服务无法验证的类型；内核在两者都传入时填 `USRLIST`。答案 `notes` 明写这一点。`userName`（12 字符）在服务侧过滤（FM 没有用户导入参数），因此空结果的含义是
  "该用户在此快照中没有会话"而不是"用户不存在"，`kernelRowCount`/`matchedCount` 让过滤保持可见。固定指纹
  source `1cc2a482e5e08b3edbe5ce921d8fe4c5ae4065b7088da7154d5aeadd006716dc` / interface
  `8d88542a7b1793f646033e41bb96ffb59b27b4fb73d58190b4a9fc103e429a01`。

**诚实边界。** 两个工具**不翻译任何值**：`type`/`status`/`state`/`sessionType` 等是内核自己的代码与文本，
域定值（DD07L）没有被读取，所以不做"忙/闲"这类标签映射，`counts.*` 是对**原始值**的忠实计数。每条记录同时
带 `raw`（未翻译的整行）与 `interpretedFields`（每个名字来自哪个 SAP 字段）。读数均为快照、不留历史；都
不能重启/停止/调试工作进程，也不能终止会话或改变会话状态。

**族缺口收窄。** `runtime-resources` 族由 `absent` 变为 `partial`：工作进程与会话已实现，剩余缺口是
`read_performance_snapshot`（ST03/STAD）、`read_db_activity`（DB02，源随数据库厂商而变）与
`read_file_system_directory`（AL11）。两个新工具在服务重启并完成一次真实 w200 调用前保持 `unverified`；
registry 条目数再次等于工具数（149）。

### 7.9 OP1-1 第二批 - 应用服务器目录列表（2026-09-26）

**第二个"无需助手"的运行时资源落地，同时否掉一个候选。** 2026-09-26 的只读探测（证据在
`.cache/evidence-r17/`）给出两条结论：

| 函数模块                        | remoteEnabled | 可序列化性                               | 结论                            |
| ------------------------------- | ------------- | ---------------------------------------- | ------------------------------- |
| `EPS2_GET_DIRECTORY_LISTING`    | 是            | 整模块 `supported=true`（无任何 reason） | **采用**                        |
| `EPS_GET_DIRECTORY_LISTING`     | 是            | 整模块 `supported=true`                  | 备用（旧版，行类型只有 3 字段） |
| `SWNC_COLLECTOR_GET_AGGREGATES` | 是            | `supported=false`：**主表全部不可用**    | **不采用**（见下）              |
| `EPS_GET_FILE_ATTR`             | -             | 按该名字不存在                           | 记录为未命中                    |

**新增工具 `read_file_system_directory`（AL11 式目录列表）。** 走与 §7.8 完全相同的通路：接口指纹闸门 +
直接 SOAP-RFC 调用 `EPS2_GET_DIRECTORY_LISTING`，固定指纹 source
`50a403b6ad5276063ac101178f612c19650e92f9a5610dfe9b8b19784fd7bde6` / interface
`3951eb2659cf3bf01fd74769262050bec5ffd84c83517b84d23f0725a0c3ebeb`。

- 输入 `directory` 原样下传 `IV_DIR_NAME`（`EPS2FILNAM`，`CHAR200`），`fileMask` 原样下传 `FILE_MASK`
  （`EPSF-EPSFILNAM`，`CHAR40`）。缺省掩码时由内核自己选择，答案 `notes` 明写。
- **宽严取舍**：不做"绝对路径"这类会误伤合法用法的形状校验——路径原样交给内核，答案回传内核自己的
  `DIR_NAME` 回显（`directoryReported`），调用方能看出**实际被列的是哪个路径**；但拒绝空路径、`..`
  段、超长（>200 / >40）与控制字符，在触达 SAP 前以 `RUNTIME_RESOURCES_SCOPE_INVALID` 失败。
- 行字段来自 `EPS2FILI`（w200 DD03L）：`name`←`NAME`(`EPS2FILNAM`)、`size`←`SIZE`(`EPS2FILSIZ`)、
  `modifiedAt`←`MTIM`(`EPS2TIMESTEMP`)、`owner`←`OWNER`(`EPSFILOWN`)、`returnCode`←`RC`(`EPSFTPRC`，域
  `EPSRC`)。**不翻译任何值**：`returnCode` 原样返回，域定值未读，`counts.byReturnCode` 是对原始值的忠实
  计数，绝不充当"成功/失败"判定。
- **只列不读**：从不读取文件内容，也不能创建/移动/改名/删除。可见性取决于实例运行的操作系统用户与内核自身
  的权限检查，本工具不放大任何一侧。空目录是**正常答案**（`status=ok`），不是"目录不存在"的证据——这是与
  工作进程/会话两个工具刻意不同的一点（后两者空表按 `RESPONSE_EMPTY` 报失败）。
- 内核自己的 `FILE_COUNTER`/`ERROR_COUNTER` 原样进 `kernelCounters`；`FILE_COUNTER` 与 `DIR_LIST` 实际
  行数不一致、或 `ERROR_COUNTER>0` 时给出 `queryWarnings`，**不平账、不掩盖**。
- `maxRows` 缺省 200、硬上限 500，超出报 `partial` + `truncated`。

**`SWNC_COLLECTOR_GET_AGGREGATES` 不可用于本服务**（计划修正）：函数模块本身 remote-enabled，但
`executionSupport.supported=false`，26 张聚合表里 workload 主集（`TASKTYPE`、`TASKTIMES`、`TIMES`、
`USERTCODE`、`USERWORKLOAD`、`TABLEREC`、`MEMORY`、`VMC`、`DBPROCS`、`DBCON`…）要么字段名不满足校验
（`structure … field name must contain 1-30 letters, digits, or underscores`），要么含无法验证的标量类型
（`SWNCTASKTYPERAW`）。仅 `FRONTEND`、`SPOOLACT`、`COMP_HIERARCHY`、`ORG_UNITS` 四张可用——用它们拼出的
"性能快照"既不覆盖工作负载也不覆盖响应时间，**不构成 `read_performance_snapshot`**，因此不实现：宁可缺口
留着，也不用一张显示不了工作负载的表冒充性能快照。该族的性能项与 DB02 项仍需助手通路或另找入口。

**族缺口收窄。** `runtime-resources` 由 3/5 变为 **4/5**：工作进程、会话、目录列表已实现；剩余
`read_performance_snapshot`（上述结论）与 `read_db_activity`（DB02，源随数据库厂商而变）。工具面
**150 工具 / 89 只读**，ops 组 27，registry **150 条 = 工具数**（verified 23 / unverified 120）。
新工具在服务重启并完成一次真实 w200 调用前保持 `unverified`。

**旁证修正**：`tableRows` 原先把"非字符串单元格"一律判为非法。`EPS2FILI` 的 `SIZE` 是 `DEC15`、`RC` 是
`NUMC4`，`EPSFILI.SIZE` 是 `INT4` ⇒ 数值单元格是**正常答案**。现在数值被保留为读取器自己的呈现文本
（不解析、不重算精度），仅对象/数组/布尔仍判非法；并补了一条断言固定这个行为。

### 7.10 OP1-1 第三批 - 负载目录与性能通路的取证结论（2026-09-26）

**本批两件事：把运行期家族最后一个可读项落地，并把剩下两项从"待找入口"变成"有结论"。** 2026-09-26
的只读探测（证据 `.cache/evidence-r18/`）覆盖 SWNC/SAPWL 全族与 DB02 各厂商模块。

**新增 `read_workload_directory`（负载采集器的目录）。** 走同一通路：指纹闸门 + 直接 SOAP-RFC 调用
`SWNC_GET_WORKLOAD_DIRECTORY`（固定指纹 source `80c9c534…71af` / interface `cbf0f41e…9c4c`）。该函数
模块**无任何导入参数**，只导出一张表 `WORKLOAD_DIRECTORY`（10 字段，逐字段均可验证），因此它成为本族唯一
既能被本服务序列化、又确实携带"性能数据是否存在"答案的读。

| 字段                                          | 含义（内核原值）                  | 本服务是否翻译             |
| --------------------------------------------- | --------------------------------- | -------------------------- |
| `COMPONENT` / `LONG_COMPONENT` / `ASSIGNDSYS` | 采集组件 / 长名 / 归属系统        | 否，原样                   |
| `PERIODTYPE` / `PERIODSTRT`                   | 周期类型码 / 周期起始日           | 否，域定值未读，计数按原码 |
| `FIRSTRECDY/TI`、`LASTRECDY/TI`               | 数据覆盖窗口首末记录（DATS/TIMS） | 否，原样回传，不做时区换算 |
| `AGR_TZONE`                                   | 采集器的聚合时区                  | 否，原样                   |

- **它明确不是性能快照**：工具名与描述都写明"这是数据目录，不是负载本身"，`notes` 第一条即声明本服务
  读不到聚合数字。
- **空目录就是空目录**（`status=ok` + 空 `entries`）：表示采集器没有任何周期的数据（采集器重启后或从未
  采集），**不是**"性能正常"的证据。接口自己声明的 `NO_DATA_FOUND` 异常同样映射为空目录而非失败
  （`collectorReportedEmpty=true`，`sources[0].code="NO_DATA_FOUND"`），其余故障（`NOT_AUTHORIZED`、
  `UNKNOWN_ERROR`）仍显式失败——"空"与"读不到"在这里被分开。
- 行数上限沿用 200/500，超出报 `partial`；每条仍带 `raw` 与 `interpretedFields`。

**性能（ST03/STAD）通路的结论：服务侧不可达，需助手。** 逐候选取证（`remoteEnabled` 与整模块/逐参数
`supported`）：

| 函数模块                                                                               | remoteEnabled | 可序列化      | 结论                                                                                                  |
| -------------------------------------------------------------------------------------- | ------------- | ------------- | ----------------------------------------------------------------------------------------------------- |
| `SWNC_COLLECTOR_GET_AGGREGATES`                                                        | 是            | 否            | 26 张聚合表主集全拒                                                                                   |
| `SWNC_GET_WORKLOAD_SNAPSHOT`                                                           | 是            | 否            | 导出 `SWNCGL_T_AGG*` 全拒（`SWNCTASKTYPERAW` 等无法验证）                                             |
| `SWNC_GET_WORKLOAD_STATISTIC`                                                          | 是            | 否            | 同上（字段名不满足 1-30 校验）                                                                        |
| `SWNC_READ_SNAPSHOT`                                                                   | 是            | 否            | 同上                                                                                                  |
| `SAPWL_AS_WORKL_GET_STATISTIC` / `SAPWLN3_AGGREGATE_SNAPSHOT_GET`                      | 是            | 否            | 同上                                                                                                  |
| `SWNC_STATREC_READ`（STAD 单记录）                                                     | 是            | 否            | **`NORMAL_RECORDS` 被拒**——那是给出子记录所属用户/事务/响应时间的记录头；可用的只有上下文缺失的子记录 |
| `SWNC_COLLECTOR_GET_SYSTEMLOAD` / `SWNC_COLLECTOR_GET_DIRECTORY`                       | 是            | 否            | 关键表被拒（后者仅 3 张目录表可用）                                                                   |
| `SWNC_FETCH_AGGR_*` / `SWNC_STAD_READ_STATRECS_RFC` / `SWNC_STATREC_READ_INSTANCE_RFC` | **否**        | —（无需再判） | 名字像外部入口，实则非 remote-enabled                                                                 |
| `SWNC_COLLECTOR_KERNEL_STAT`                                                           | **否**        | 是            | 唯一"整模块可验证"的性能源，偏偏不可远程调用 ⇒ **须走助手**                                           |

**判断**：本服务能读到的性能数据只有"数据目录"这一层；响应时间、DB/CPU 时间、用户与事务负载这一整层，
服务侧没有任何可序列化的入口。因此**不实现空壳 `read_performance_snapshot`**，缺口保留并写明需要助手
（通路 C）。

**DB02（`read_db_activity`）的结论：厂商切分 + 平台读不到。** `DB02_ORA_SELECT_SEGMENTS`、
`DB02_ORA_LAST_ANALYZED`（Oracle）与 `DB02_GET_EXTENT_LIST_DB2`（DB2）均 `remoteEnabled=true` 且整模块
可验证，但**都必须先知道数据库平台**才能选对模块；而平台在已批准的服务侧来源里读不到——本轮尝试读
`TPFYPROPTY` 得到 `TABLE_NOT_ALLOWED`，原因是**在跑的 4848 仍是 D3 授权之前的构建**（不仅是工具面，
**表白名单也是编译期常量**）。因此 `read_db_activity` 要么等重启后经新白名单取证平台、要么走助手。

**族状态**：`runtime-resources` 声明集合由 5 项变为 **6 项**（新增的 `read_workload_directory` 已同时
实现），**缺口集合不变**（仍是 `read_performance_snapshot` 与 `read_db_activity`），族仍为 `partial`。
工具面 **151 工具 / 90 只读**，ops 组 **28**，registry **151 条 = 工具数**（verified 23 / unverified 121）。
新工具在服务重启并完成一次真实 w200 调用前保持 `unverified`。
（**后续更新**：该读数已被 §7.20 取代 —— N3 后为 **152 工具 / 91 只读**，ops 组 **29**，registry **152 条**。
本行保留为当时快照。）

**更正（2026-09-26，本轮复核）：「平台读不到」不成立。** 上面那句结论只依据**一次** `TPFYPROPTY`
读取被拒（`TABLE_NOT_ALLOWED`）——而被拒的原因是**当时在跑的构建**的表白名单早于 2026-09-25 的
逐表批准，属于**构建陈旧，不是来源不可得**；该表在源码里已经放行。更要紧的是，平台的常规来源一直
在服务自己手里：`RFC_SYSTEM_INFO` 的 `RFCDBSYS`（数据元素 `SYDBSYS`，中央数据库系统）由**已部署、
指纹钉死**的读取器返回，`get_sap_system_info` 已把它作为 `serverFacts.databaseSystem` 发布
（`src/server-facts.ts` 与 `src/tools.ts`，见 §7.7）。该半段**尚无真实调用记录**——这一点必须保留，
但它意味着"等一个平台来源的批准"，而不是"平台不可读"。

因此 `runtime-resources` 的真实缺口收窄为一件事：**没有任何已取证的厂商模块报告"活动"**。同一次探测
到达的存储/统计模块（`DB02_ORA_SELECT_SEGMENTS`、`DB02_ORA_LAST_ANALYZED`、`DB02_GET_EXTENT_LIST_DB2`）
确实 `remoteEnabled=true`（三者连同 `DB6_BUFFERPOOL_SNAPSHOT` 的 source/interface 指纹已随定义留证于
`.cache/evidence-r18/fm-*.txt`，若日后要在服务侧钉死它们无需再探测），但它们回答的是空间与分析，不是
活动——Oracle 那一对读的是 `dba_tab_columns.last_analyzed`/`sample_size`/`num_rows`，即**统计新鲜度**；
`DB02_DB_ACTIVITY` 按名未找到；厂商中立的 `DB_AN_DB_KPIS` 虽可远程调用，却要求调用方给出 CCMS 节点句柄
（`MT_TOOL_INFO` 类型 `ALTLEXDESC`），读不到节点时直接 `MESSAGE e001(sada)`——外部调用方既无法提供该
上下文，也无法承受该消息，已在 `.cache/evidence-r18/fm-DB_AN_DB_KPIS.txt` 留证。名字空间已按
`DB02*`/`DB*`/`DB6*`/`SDB*`/`SAPDBA*`/`STAT*` 穷举过，因此结论是**须走助手**：平台是服务自己读得到的，
但服务够得着的模块里没有"数据库活动"这一类答案。族的闭环路线相应由 `helper + approval` 改为 **`helper`**
——平台不再是"待批准项"（这是一个被错误归因的等待），两个缺口（工作负载数字、DB 活动）都等助手。

### 7.11 OP1-7 收口 - 受控只读查询的联接支持（2026-09-26）

**背景**：O-7 的剩余缺口是"排障问题常常要两张表一起看，而本服务只能查一张"。`execute_data_query`
的第一条通路（原生数据预览）在 w200 被判 `platform_unsupported`，因此实际生效的是受限方言回退；本批给
该方言语义加上了**有界联接**，全部规则在**触碰 SAP 之前**判定。

**语法（v1）**

```sql
SELECT A.TRKORR, B.AS4TEXT
  FROM E070 A INNER JOIN E07T B ON A.TRKORR = B.TRKORR
 WHERE A.TRSTATUS = 'R'
 ORDER BY B.AS4TEXT DESC
```

- 最多 **3 张**表，每张都必须在 D5-2 白名单内（`assertQueryTablesAllowed` 早已静态枚举 `JOIN` 目标，
  本批沿用，未新增旁路）；表可用别名，也可直接用表名作限定符。
- `ON` 只接受**等值**：`列 = 列`（联接键）与 `列 = 字面量`（残余条件）。两者都会被下推到该表的那一次
  读取，因此**比较仍是 SAP 自己的比较**，本服务不做第二套类型语义。
- `WHERE` 每个合取项是"一个限定列 比较 一个字面量"，按表下推；每个 `OR` 分支要各读一次表，所以联接
  语句**只收合取（AND）**，`OR` 显式拒绝并提示拆成两条语句。
- **外联接的语义被刻意收窄**：`LEFT`/`RIGHT`/`FULL` 必须是最后一个联接（外联接之后再接内联接会把空扩展
  行又删掉，两种读法含义不同，本服务不猜）；`WHERE` **不得**触碰外联接未保留的那一侧（SQL 里那是在过滤
  联接结果，而下推只能过滤那一侧的读取），拒绝并提示把条件移入该联接的 `ON`。2026-09-30 补齐
  `RIGHT`/`FULL`/`CROSS` 后，这条规则按"哪一侧被保留"重述：`LEFT` 的可选侧是本次引入的表，`RIGHT` 是它
  之前的表，`FULL` 两侧都算（见 7.13）。
- 发布列名一律为 `别名.列名`（联接里每条列引用都必须限定；不限定即拒，因为"比较放在哪一侧"决定答案）。
  未匹配的可选侧读作空值（与读取器自己的"初始字段=空串"一致）。联接键按**读取器文本**比较，与方言既有
  的排序口径一致（不是 SAP 的类型感知比较）。

**诚实性规则（与单表路径同一套）**

| 情形                           | 行为                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| 任一表读取触到行数上限（≤500） | `truncated=true` + `querySource.join.incompleteAliases`；**不静默联接**                         |
| 聚合 / `GROUP BY` 遇到任何样本 | 拒绝（`TABLE_QUERY_AGGREGATE_INCOMPLETE`），不报"样本的计数"                                    |
| `ORDER BY` 遇到任何样本        | 拒绝（`TABLE_QUERY_ORDER_BY_INCOMPLETE`），不报"不是榜首的榜单"                                 |
| `ORDER BY` 列不在投影里        | 拒绝（`TABLE_QUERY_ORDER_BY_COLUMN_NOT_SELECTED`），且**零次 SAP 访问**                         |
| 投影里的算术项                 | 服务端按官方计算规则求值（见 7.14）；算不出来即按名拒绝                                         |
| `WHERE` 里的算术项             | 服务端判定，比较走精确十进制；该分支必须读完（见 7.15），普通比较仍下推                         |
| 联接投影里限定列上的算术项     | 服务端求值，类型按别名各自表解析（见 7.20）；外联接未匹配行的项按名拒绝                         |
| 集合测试 `IN (SELECT ...)`     | 服务端判定，两侧都必须读完（见 7.21）；类别不同/浮点/非精确十进制一律按名拒绝；相关子查询属边界 |

答案里新增 `querySource.join`：每张表的 `alias`/`tableName`/`joinType`/`onKeys`/`pushedFilters`、
`incompleteAliases`、`joinedRows` 与每次读取自身的证据（方法、原生码、指纹、字段元数据按表分列）。

**验收对照（计划 OP1-7 判据）**：① "`SELECT ... GROUP BY` 类排障查询在白名单表上成功" —— 单表聚合早已
具备，本批补齐其上的两表版本（联接后再分组聚合，见测试）；② "越界语句在触碰 SAP 前被拒" —— 全部规则由
解析器判定，测试断言越界语句的读取次数为 **0**。

**覆盖口径**：本批（7.11）交付时 `query` 族**仍是 `partial`**——当时的缺口写明"右/全/交叉联接、表达式、
子查询、`LIMIT` 仍不翻译"，且**联接路径尚无运行期证据**（在跑的服务仍是本方言之前的构建）。两个工具
（`read_abap_table`、`execute_data_query`）在登记表里保持 `verified`，但**不**用它来宣告族闭环：新增能力
未在真实系统上跑过，闭环主张就不成立。其中"联接路径无运行期证据"一条已于 2026-09-30 12:15 由真机正向
证据解除；"右/全/交叉联接与 `LIMIT` 不翻译"一条已于同日由 7.13 解除。

### 7.12 右/全/交叉联接与 `LIMIT` 落地（2026-09-30）

**本批只做"能被精确表达"的那一半。** 缺口句原本列了五项（右联接、全联接、交叉联接、表达式、子查询、
`LIMIT`）。其中右/全/交叉联接与 `LIMIT` 可以在**不引入第二套类型语义**的前提下精确实现：联接依旧是
"每表一次有界读取 + 服务端按读取器文本做等值探测"，`LIMIT` 只是对已排好序的结果切片，两者都不需要服务端
重新解释 SAP 的取值。表达式与子查询**故意没做**：它们要服务端自己算 SAP 的 NUMC/DATS/PACKED 语义，那正是
这个方言存在要避免的事（见 7.11 的诚实性规则）。

**语义决定（都写进了拒绝文案与文档）**：① `RIGHT JOIN` 保留**本次引入**的表，`FULL JOIN` 两侧都保留，
未匹配的一侧写读取器的空串；② `CROSS JOIN` 不接受 `ON`——写了 `ON` 是自相矛盾而非漏写，按名拒绝
（`TABLE_QUERY_JOIN_CROSS_ON`）；③ `WHERE` 不得触碰外联接**未保留**的那一侧，规则由"`LEFT` 的可选侧"推广为
"按哪一侧被保留"（`LEFT` 本次引入的表、`RIGHT` 之前的表、`FULL` 两侧），拒绝码不变；④ `LIMIT` 必须是最后
一个子句、只收一个整数，切片发生在 `ORDER BY` **之后**；⑤ `LIMIT` **不能**把不完整的读取变成完整的——
聚合与 `ORDER BY` 的完整性判据仍在切片之前、针对整个匹配集判定。

**一处实现缺陷由新测试当场抓住**：初版把 `LIMIT` 放在 `ORDER BY` **之前**切片，于是
`ORDER BY JOBNUM DESC LIMIT 2` 返回的是"先读到的两行再排序"，而不是"排序后的前两行"——这正是
`LIMIT` 唯一容易写错的地方，测试断言 `["0011","0010"]` 直接抓到（实际返回 `["0011","0009"]`），已改为
先排序再切片。

**覆盖口径**：本批**不宣告 `query` 闭环**。缺口仍非空，只剩下**表达式与子查询**两项，且它们不是"还没做"
而是"用什么方式做"尚未裁定的需求：要么实现一个能精确复刻 SAP 类型语义的表达式层，要么把它们认定为
**平台边界**（原生数据预览端点在本版本不可用、`RFC_READ_TABLE` 无法 plan、服务端自算会与 SAP 语义分叉）
写进 `boundary` 而不再是缺口。这需要用户裁定，不得由本批自行清空缺口凑闭环。**该裁定已于同日作出：用户选
"实现表达式层"（路线 A）：投影算术项见 7.14，`WHERE` 中的算术项见 7.15，联接投影里限定列上的算术项见 7.20；
集合测试 `IN (SELECT ...)` 见 7.21；仍缺的只剩**非相关标量子查询**（`X = (SELECT COUNT(*) ...)`，同一方法的
下一项），相关子查询与非有限文法里的 Open SQL 已按边界写明（见 7.21）。缺口因此仍非空（一项）。**

**真机验证（w200，只读，新构建重启后）**：`RIGHT JOIN`、`FULL JOIN`、`CROSS JOIN ... LIMIT 4` 均被接受并
按类型回报（`querySource.join.tables[].joinType` = `right`/`full`/`cross`，`limit=4`），`CROSS` 的 100 行是
"每行配每行"的有界一页。`LIMIT` 的判决性对照取自 `T000`（客户端表，5 行、读取完整）：无限版
`ORDER BY MANDT DESC` 返回 `[200,100,066,001,…]`，`LIMIT 1` **恰为首行**；同一语句在 `TBTCO`（行数超过
500 行上界）**即使带 `LIMIT` 也照样被拒**（`TABLE_QUERY_ORDER_BY_INCOMPLETE`）——这一对照同时钉住了
"切片在排序之后"与"`LIMIT` 不能豁免完整性判据"两条规则。

**保留语义的计数恒等式（判决性）**：外联接"保留未匹配行"不能靠肉眼看数据来断言，改用**四种联接的计数必须
满足的等式**：`INNER = M`、`LEFT = M + A独有`、`RIGHT = M + B独有`、`FULL = M + A独有 + B独有`。在两张
**读取都能读完**（`incompleteAliases` 为空）的小表上跑 `COUNT(*)`：

| 联接键                     | INNER | LEFT | RIGHT | FULL | A 独有 | B 独有 | 等式           |
| -------------------------- | ----- | ---- | ----- | ---- | ------ | ------ | -------------- |
| `T001.BUKRS = T001W.WERKS` | 12    | 19   | 45    | 52   | 7      | 33     | 12+7+33=52 ✓   |
| `T002.SPRAS = T005.LAND1`  | 0     | 41   | 245   | 286  | 41     | 245    | 0+41+245=286 ✓ |

第二组尤其干净：两组键域**完全没有交集**（`INNER=0`），于是 `LEFT` 必须等于左表全部 41 行、`RIGHT` 必须等于
右表全部 245 行、`FULL` 必须恰好是 286 行——三种保留语义同时被钉死，没有任何"看起来合理"的空间。

**`ON` 规则的真机确认**：`SELECT ... FROM E070 A RIGHT JOIN E07T B ON A.TRKORR = B.TRKORR AND
A.TRKORR = '<不存在的键>' WHERE B.TRKORR = '<存在的键>'` 返回**恰好 1 行**且 `A.TRKORR=""`、两次读取均
完整（`incompleteAliases` 为空）——字面量条件确实只落在这次联接丢得起的**之前**那一侧，而被保留侧改用
`WHERE`。相对应的三条拒绝也在真机成立：`RIGHT` 的字面量写成本次引入的表 ⇒ `TABLE_QUERY_JOIN_ON_ALIAS`；
`FULL` 的字面量写任一侧 ⇒ 同码；`FULL` 的 `WHERE` ⇒ `TABLE_QUERY_JOIN_WHERE_OUTER_COLUMN`，且文案确实
带上了改后的"`FULL` 两侧都保留，因此没有 `ON` 子句能承载它"这句建议（不再是那条指向 `ON` 的死路）。

**真机验证当场暴露的第二处缺陷（比第一处严重，属"静默回答另一个问题"类）**：`ON` 里"列 = 字面量"的残余条件
原先被无条件下推到**本次联接引入的那张表**的读取。这在 `LEFT` 上成立（那是可选侧），但在 `RIGHT` 上恰好
相反——`RIGHT JOIN` 要保留的正是这张表，下推过去会删掉联接本该保留的行，而且**不会报错**。原规则对
`FULL` 同样会把谓词加到被保留的一侧。已改为按"这次联接丢得起哪一侧的行"判定：`INNER`/`LEFT` → 本次引入的
表；`RIGHT` → 它之前的表（写成本次引入的表则按名拒绝，并指向 `WHERE`，因为保留侧在 `WHERE` 里过滤是合法的）；
`FULL` → 两侧都不可下推，且 `WHERE` 也表达不了，只能按名拒绝。下推目标同步由"本次引入的表"改为"该条件自己
写明的那张表"（在旧规则的每一种合法写法下二者相同，故不含行为回归）。拒绝文案里的建议也按联接类型分叉：
指向 `ON` 的旧建议对 `FULL` 是死路，改为"在 `ON` 里比较两列，或者交给 SAP"。

### 7.13 投影算术项：按官方计算规则在服务端复刻（2026-09-30，路线 A）

**裁定**：7.13 末尾把"表达式与子查询怎么处理"交回用户，用户 2026-09-30 裁定**路线 A**——不把表达式认定为
平台边界，而是**在服务端实现一个能精确复刻 SAP 类型语义的层**。理由链是：平台确实没有求值通道（原生数据预览
端点在本版本不可用、本方言只下推 `FIELDS+OPTIONS`、读取器按标识符取列、helper 正文改动未获授权），但"没有
通道"能推出的是"**没有别人能替你算**"，不是"可以随便算"。既然要自己算，计算规则就必须来自 SAP 官方文档
（`arith_exp - Calculation Type and Calculation Rules`）而不是服务端的直觉，且**算不出来时必须按名拒绝**。

**本批只做投影里的算术项。** `WHERE` 里的算术项会改变**过滤**语义（服务端比较 vs SAP 比较，NUMC/DATS/PACKED
各不相同），子查询同理，二者留给后续批次；联接投影里限定列（`别名.列`）上的算术项留给联接方言，单表方言在
解析阶段就让开（限定名一旦出现即不认领），不抢占也不误算。

**计算类型的来源是字典，不是读取器。** 读取器返回的字段元数据只有单字符 `TYPE` 与长度，没有 `DATATYPE`、没有
`DECIMALS`；而单字符类型**不够用**——`DD03L` 里 `INT4` 字段的 `INTTYPE` 是 `X`，与字节字段无法区分（真机读数，
见 7.15 记录）。因此操作数类型一律取自 `DD03L.DATATYPE`（按表名 + `AS4LOCAL='A'` 读取，进程内按连接+表缓存），
这条路径与既有 `readRemoteDataElementHeader` 用 `DD04L` 取标量类型是同一种做法。

**规则要点**（都进了拒绝文案与 `docs/table-query.md`）：优先级 `decfloat16/34 → decfloat34`、`f` 或 `**` → `f`、
`p` → `p`、`int8` → `int8`、`i/b/s` → `i`；非数字操作数中 `d`/`t` 按 `i`、`c`/`n`/`string` 按 `p`、`x`/`xstring`
按 `i`；`i`/`int8` 为整数运算且"每个非整数小计商业舍入"（`7/2=4`、`5/2=3`）；`p` 为定点、内部精度 **31 位**、
多余小数位商业舍入；`p` 的 `/` **按名拒绝**（`SELECT` 列表里没有目标字段，结果小数位无从确定——这一条正是
"宁可拒绝也不猜"的样本）；`f` 与 `decfloat` 按名拒绝（二进制/十进制浮点的小计会引入舍入误差，不是精确答案）。

**三处缺陷都在本批内当场抓住并修掉**：
①（上一轮）求值器在**类型收集阶段**就解析字面值，于是 FLTP 字段被报成 `NOT_NUMERIC` 而不是 `FLOAT`——先定类型
再取值；
②**常量判据写错**：初版把"没有普通列被选中"当成"这个项不读列"，于是 `SELECT ZAEHL * 2 FROM T006` 被误判为
常量项拒绝。新测试当场抓到，判据改为"**项里引用的列集合为空**"才算常量；
③**把读取失败说成关于字段的事实**：字典读取未完成时（`status != ok`）初版直接返回空类型表，调用方于是收到
"字典里没有这个字段的类型"——而那次读取**根本没读成**。已改为按名拒绝
`TABLE_QUERY_EXPRESSION_DICTIONARY_UNAVAILABLE` 并带上底层 `code`/`stage`。这一条属于本项目的老毛病族
（用自己的失败去陈述被查对象的事实），与 7.12 的"构建陈旧必须先被拦下"同源。

**输出保真**：算术项需要读它引用的列，但这些列不一定被选中，因此求值后**只为算术而读的列会从行里删掉**——
`SELECT MSEHI, ZAEHL / 2` 的答案里只有 `MSEHI` 与 `EXPR_1`，不多带一列。派生列名按投影位置命名为
`EXPR_1`、`EXPR_2`…，映射由 `querySource.expressionColumns` 给出，`ORDER BY EXPR_n` 可用（求值发生在排序之前，
也发生在 `LIMIT` 切片之前）。项与聚合或 `GROUP BY` 同时出现时按名拒绝（`TABLE_QUERY_EXPRESSION_GROUPED`：
那里没有任何**一行**能定义这个项）；聚合之内/之外的算术仍按形式拒绝
（`TABLE_QUERY_AGGREGATE_FORM_UNSUPPORTED`，文案已从"算术不被支持"改成"项只翻译在列上，不翻译在聚合上或聚合里"）。

**验收对照**：本地 `npm test` **1201 项全绿**（本批新增 `table-expression.test.ts` 28 项、
`table-expression-projection.test.ts` 20 项、`table-expression-wiring.test.ts` 6 项），格式/静态/类型/两个矩阵
闸门退出码零；`.cache/r27-falsify.mjs` 对新接线做 6 处退回（不求值、不发布派生列、无类型也计算、不读字典、
字典读取失败被误报成"字典没这个字段"、只为算术读的列被带进答案）**全部 FALSIFIED**，复原后绿。其中"不读字典"
一处最初**没有**被证伪——因为单测直接调 `readGroupedRows` 并把类型表递给它，`tools.ts` 里那段接线当时**没有任何
用例覆盖**；补了经 `execute_data_query` 的端到端用例（假数据里让读取器的单字符类型与 `DD03L` 故意不一致：
读取器说 `C`、字典说 `INT4`，于是 `7/2` 只有在**用了字典**时才会得 `4`，用读取器类型则会变成打包除法被拒）
之后才被证伪。这正是"证伪暴露测试盲区"的样本。

**覆盖口径：本批不宣告 `query` 闭环。** 缺口当时仍非空（`WHERE` 中的算术项、联接投影上的算术项、子查询），族状态
仍 `partial`，必需族闭环仍 **10/14**、`criterionMet` 仍 `false`。本能力**目前只有本地证据**：`127.0.0.1:4849`
上运行的是旧构建，服务端改动需重启才生效，因此投影算术项在 w200 上**尚无任何读数**；重启后按
`.cache/r29-verify.mjs` 取真机只读证据（断言 `SELECT MSEHI, ZAEHL / 2 FROM T006` 经 `rfc_read_table` 返回
`EXPR_1` 且整型除法按商业舍入、`querySource.expressionColumns` 有映射、字典读取确为 `DD03L`、以及不带算术项的
语句**不**读字典）。

### 7.14 WHERE 里的算术项：同一层，判定在服务端（2026-09-30 第二批）

**7.14 把 `WHERE` 中的算术项明确留给了后续批次**，理由写得也对：它会改变**过滤**语义，而本方言的立身之本
恰恰是"普通比较一律下推给 SAP，不在服务端重写 SAP 的类型语义"。第二批的做法不是推翻这条理由，而是把它
**缩小到能守住的地方**：

- **普通字段比较仍然下推**（`MSEHI = 'KG'` 交给读取器），服务端一行都不重写。只有左侧**确实是一个算术项**
  （`ZAEHL / 2 = 3`）时才由服务端判定——因为这种条件在读取器那里**没有字段名可给**，它的结构化筛选是
  "一个字段名 + 运算符 + 字面量"，推不下去；而它本身也不存在"SAP 的比较结果"可以沿用。
- **比较走精确十进制**：求出来的值与字面量都是十进制文本，比较时按最长小数位放大成整数再比（`compareDecimals`），
  而不是把它们变成二进制浮点（那正是这一层存在的意义所在），也不是字符串相等——`= 3.0` 与 `= 3` 是同一个数。
- **术语与投影共用同一套类型来源与拒绝码**：类型仍取自 `DD03L.DATATYPE`，算不出来仍按名拒绝
  （`_NOT_NUMERIC`/`_FLOAT`/`_DIVISION_SCALE`/`_TYPE_UNKNOWN`/`_TYPE_UNAVAILABLE`/`_DICTIONARY_UNAVAILABLE`…）。
  新增两条只属于这个位置的拒绝：与数字以外的值比较（`TABLE_QUERY_WHERE_EXPRESSION_LITERAL`）、以及
  **该分支没读完**（见下）。

**一条新纪律，与 `ORDER BY` 同源**：带算术项的分支**必须读完**。`ORDER BY` 是对完整匹配集的断言，所以截断即拒绝；
`WHERE` 里的算术项是对**每一行**的判定，截断意味着"匹配集"只覆盖读到的那一页——**样本的匹配集不是语句的匹配集**。
因此任一携带该项的分支被行上界截断即整体拒绝（`TABLE_QUERY_WHERE_EXPRESSION_INCOMPLETE`，附分支序号与上界），
且这条判定排在聚合/排序的完整性拒绝**之前**（本地过滤先让读取失去意义，先报根因）。可以推下去的普通条件则用来
收窄读取，这是让语句读完的正道。

**顺序也照 SQL**：`WHERE` 先于 `GROUP BY`，因此 `SELECT COUNT(*) FROM T006 WHERE ZAEHL / 2 = 3` 数的是匹配的行
（单测钉住：三行里两行匹配即 `COUNT=2`）。只为谓词而读的列同样在算完后从行里删掉，答案里的列**恰好**是语句选中的列。

**本批当场抓住并修掉的一处缺陷（回归）**：把术语路径接上解析器后，`WHERE A = '<41 字符>'` 这类**普通**比较
（读取器字面量上界 40 字符，本来应当"不翻译、把原生 ADT 错误交回调用方"）被术语路径抢走，改报
`TABLE_QUERY_WHERE_EXPRESSION_LITERAL`——一个**没有发生过的事实**。修法：左值解析成"裸字段"时术语路径一律让开
（`node.kind === "column"` 即返回 `undefined`），裸字段归普通路径所有；附带效果是 `WHERE (A) = 1` 这种带括号的
裸字段也不认领。既有测试当场抓到，无需新测试。

**验收对照**：本地 `npm test` **1223 项全绿**（本批新增 `test/table-query-where-expression.test.ts` 19 项、
`test/table-expression-wiring.test.ts` +3 项），格式/静态/类型/两个矩阵闸门退出码零；`.cache/r30-falsify.mjs`
对 8 处判断做退回（把项当普通字段下推、截断仍过滤、比较退化成字符串相等、算不出来就丢行而不是拒绝语句、
只为算术而读的列被带进答案、不发布 `whereExpressions`、项的操作数不加入读取、工具层只看投影决定是否读字典）
**全部 FALSIFIED**，复原后绿。

**覆盖口径：本批仍不宣告 `query` 闭环。** 缺口按实际交付收窄为**两项**：联接投影里限定列上的算术项、子查询。
（后一项已于同日由 7.20 解除，缺口现为**一项**：子查询。）族状态仍 `partial`，必需族闭环仍 **10/14**、
`criterionMet` 仍 `false`。与 7.14 相同，本能力**目前只有本地证据**：
`127.0.0.1:4849` 上运行的是旧构建，服务端改动需重启才生效，因此三个切片在 w200 上**都没有读数**；重启后按
`.cache/r29-verify.mjs`（投影）与 `.cache/r31-verify.mjs`（`WHERE`：断言"普通条件下算术项判定出该行且不发布操作数、
`querySource.whereExpressions` 有映射"、"项匹配不到就返回零行"、"**没有可下推条件时按行上界截断即拒绝**"、
"普通比较仍照旧工作且不报任何服务端判定的项"）取真机只读证据；联接投影项的真机脚本尚待补。

> **【已被取代 · 2026-10-04 标注】勿据本段判断现状。** 本段两处现在时结论——「族状态仍 `partial`、必需族闭环仍
> **10/14**、`criterionMet` 仍 `false`」与「联接投影项的真机脚本尚待补」——是**当时（2026-09-30 第二批）**的读数，
> 均已被**同日后续批次**取代：§7.15 落地联接投影项、§7.25 落地集合测试、§7.26 落地标量子查询并**清空 `query` 族
> 缺口**（`gap` 置空、`closeRoutes` 改为 `["none"]`）；五切片真机只读读数合计 **35/35**
> （`.cache/r29|r31|r33|r35|r38-verify.json`，2026-09-30 19:24–20:34，用户重启 4849 之后取得）。
> 原文保留不改，依「不可变历史记录」与「不删除」两条约定。现状以 `docs/ops-acceptance-matrix.md` 与
> `get_capability_report` 的 `opsCapability` 块为准。

### 7.15 联接投影里的算术项：同一层，类型按别名各自表解析（2026-09-30 第三批）

**前两批都把这一项点名留给后续**（7.14 与 7.15 的"仍不翻译"里都写着"联接投影里限定列上的算术项"），本批把它做掉，
做法与单表路径**同源**而非重写：表达式引擎、计算类型规则、拒绝码全集、`EXPR_n` 命名与 `expressionColumns` 映射全部复用。

- **解析**：联接投影里一个条目若解析成算术项且**不是裸限定列**（`node.kind !== "column"`），即成为项；裸限定列
  （`A.ZAEHL`）仍旧是普通选中列——这条判据与单表路径逐字一致，因此"`SELECT A.X` 不被当成项"在两处都是同一个理由。
- **项的每个列引用都走联接既有的限定与别名校验**：`A.ZAEHL * 2` 里的 `A.ZAEHL` 与投影里任何一个列引用受同样的检查
  （未限定 `TABLE_QUERY_JOIN_COLUMN_UNQUALIFIED`、别名不存在 `TABLE_QUERY_JOIN_ALIAS_UNKNOWN`），不因为它在项里就
  放宽。`_CONSTANT`（项不读任何列且没选别的列）与 `_GROUPED`（项与聚合/`GROUP BY` 同时出现）两条判定也照搬。
- **类型来源按别名分表，且只解析项真正读到的别名**：`A.ZAEHL` 的类型来自 `A` 所指表的 `DD03L`，`B.MANDT` 的来自 `B`；
  `A` 上的项**不会**因为无关的 `B` 字典读取失败而不可用，也不会向 `B` 多问一次字典（假后端计数两处都钉住了）。
- **求值位置**：在联接**之后**、以联接行为输入，且排在完整性拒绝之后（与单表路径同序：读不完整就先报读不完整，
  不先报算术碰到的第一个问题）；联接行本身就是以 `别名.列` 为键的，所以项的操作数直接从行上取，不需要任何名字改写。
- **发布面与单表路径一致**：操作数列被读入但**不发布**（联接输出本来就只拷贝选中的列 + 派生列），派生列
  `EXPR_1`…按投影顺序命名，`querySource.expressionColumns` 给出映射；派生名不带限定符，而选中的列全部带，
  两个命名空间**不可能**相撞，因此这里不需要单表路径那种"派生名遮蔽选中列"的检查。
- **两条只属于这个位置的语义**：① 外联接未匹配的一侧按读取器口径是空串，项读到它即按 `_NOT_NUMERIC` **指名拒绝**
  ——把空串读成 `0` 会给出表里从未有过的数字；② 联接方言的 `ORDER BY` 每个键都必须限定，因此**不能**用 `EXPR_n`
  排序，该语句**不被认领**并落回平台原生错误（不会被静默换成另一种排序）。
- **截断的一页**带项是允许的：每行自己的值是精确的，`truncated` 已说明这不是整个匹配集。这与 `WHERE` 项必须读完
  并不矛盾，而是同一条纪律的两面——**决定成员资格才需要完整，逐行取值不需要**。

**验收对照**：本地 `npm test` **1238 项全绿**（本批新增 `test/table-join-expression.test.ts` 13 项、
`test/table-expression-wiring.test.ts` +2 项；`table-join.test.ts` 的全量 `deepEqual` 同批补上新的 `expressions: []`），
格式/静态/类型/两个矩阵闸门退出码零；`.cache/r32-falsify.mjs` 对 9 处判断做退回（操作数不加入读取、不求值、
不发布派生列、把裸限定列当成项、项的引用不校验别名、项与聚合/GROUP BY 同放行、不回报 `expressionColumns`、
工具层不给联接项取类型、给无关别名也读字典）**全部 FALSIFIED**，复原后绿。证伪脚本的锚点**先打印再使用**
（`.cache/r32-anchors.mjs`、`.cache/r32-exact.mjs`）：初版 9 处里有 4 处因编译后的缩进与源码不同而 **SKIPPED**——
"锚点没命中"会被算作失败而不是静默通过，这是 7.14 那次"STILL GREEN 其实是打偏了"教训的固化做法。

**覆盖口径：本批仍不宣告 `query` 闭环。** 缺口按实际交付收窄为**一项**：子查询（`IN (SELECT ...)`）。族状态仍
`partial`，必需族闭环仍 **10/14**、`criterionMet` 仍 `false`。与前两批相同，本能力**目前只有本地证据**：
`127.0.0.1:4849` 上运行的是旧构建（服务端改动需重启才生效），因此三个切片在 w200 上**都没有读数**。

### 7.16 OP0-2 取证扫描器 - 构建陈旧必须先被拦下（2026-09-26）

**为什么要有这个闸门**：2026-09-25 那次 DB02 结论出错，根因不是判断力，而是**证据的来源没有被标识**：
在跑的构建与源码**版本号相同、工具面不同**（143 vs 151），而当时的探针只比对了版本号，于是"旧构建的一次
拒绝"被当成了"源码的事实"。所以任何取证动作都必须先回答一个问题：**我正对着的这棵树，是不是我本地这棵树？**

**扫描器**：`scripts/probe-ops-read-sweep.mjs`（只读，无任何写工具）。

```powershell
# 本地描述这棵树：不连服务、不碰 SAP
node scripts/probe-ops-read-sweep.mjs --self-check
# 取证（需用户授权的只读会话；输出目录必须不存在，绝不覆盖既有记录）
node scripts/probe-ops-read-sweep.mjs --label=ops-r22 --url=http://127.0.0.1:4848/mcp --dir=/usr/sap/trans
```

**闸门（写任何证据之前）**：① `get_runtime_info` 传入本机 `dist` 树的
`expectedArtifactFingerprint`（与 `RuntimeIdentity` 同一套算法，不复制配方）与模块版本，要求
`checks.expectedArtifact === "match"`——**"unknown" 同样拒绝**，因为无法指纹自证不等于当前；② `tools/list`
的名集合必须覆盖本扫描器的 8 个目标工具，且工具数与本地 `TOOL_NAMES`（151）一致；③ 服务的工具面指纹
（排序名集合的 sha256 前 16 位）与本地比对。任一不满足 ⇒ 写 `STALE-BUILD.json`、**退出码 2、不写任何证据**，
并给出补救命令（`npm run build` + 从本仓库 `dist` 启动；单纯重启已安装的 release 不会增加工具——工具面与
表白名单都是**编译期常量**）。

**第二道闸门：读路径必须先应答（2026-09-26 补）**。构建一致只证明"对着的是这棵树"，不证明这棵树现在读得到
SAP。2026-09-26 10:27–10:40 期间，SAP 的公开 ICF 端点照常应答，而每一条已认证的 ADT 调用都回 `401`
（SOAP/RFC 通道同样 `401`，错误代码 `ICF-LE-http-c`，即登录数据被拒）；此时扫一遍会把 8 条结论写成 `failed`，
而它们描述的是登录失效，不是工具——正是本闸门要防的归因错误。所以调用任何工具之前先跑一次
`get_sap_system_info`：只要 `status` 不是 `"ok"`，就写 `UNREACHABLE-SAP.json`（含失败来源、`queryWarnings`、
观察时间与补救步骤）、**退出码 4、不写任何证据**。工具结论只有在底层通路可用时才称得上是关于该工具的证据。

**取证内容**：8 个尚无真实调用记录的只读 ops 工具各一次（`read_work_processes`、`read_user_sessions`、
`read_workload_directory`、`read_system_parameters`、`read_qrfc_queues`、`read_idoc_status`、
`read_user_authorizations`、`read_file_system_directory`；最后一个需要 `--dir`，未给则该工具记为 `not-run`
而不是编一个路径），加 OP1-7 的联接正例（`E070`/`E07T`，两条都在白名单内）与负例（联接 `MARA`，只待批准，
必须在触碰 SAP 前被拒）。原始答复逐工具落盘为 `<tool>.txt`。

**诚实性约定**：每个工具只记 4 种结论之一——`answered` / `empty` / `refused` / `failed`；**空结果记为空结果**，
绝不当作正例；`refused`/`failed` **不进** `registry-delta.json` 的 `verified` 提议，只作为 finding 列出。扫描器
**不改** `contracts/verification-registry.json`——它只产出 `summary.json`、`registry-delta.json` 与逐工具原始
证据，登记动作由读过证据的人/模型来落。

**静态自检（本轮已执行，未连服务、未碰 SAP）**：`--self-check` 报 151 工具、底面指纹
`87cda976496896b6`、`dist` 树指纹 `ba573b3733bcdf8847f42ee389e4ff45a72e2353185b4cba9345a36ea3726549`；
联接正例被 `parseJoinedTableSelect` 解析为 `E070, E07T` 且两者 `isTableAllowed=true`；负例语法合法但
`MARA` 被判 `TABLE_NOT_ALLOWED`（`assertTableAllowed` 抛出）。

### 7.17 验收口径的两处硬读法（2026-09-26）

验收矩阵新增 **DoD 读数块**（计划 §8 四条逐条计算，见 `docs/ops-acceptance-matrix.md` 的
"Definition of done"）。两处必须写死的读法：

1. **门槛是 14/14，不是 13。** 计划 §8 第 1 条写作"至少 **13** 族（≥95%）"，而 13/14 = **92.9%**，
   句子前后半自相矛盾。本服务按 95% 的字面口径取 `ceil(14 × 0.95) = 14`，即**必需族全闭环**才算达标；
   若要按"13 族"验收，等于把 92.9% 称作 95%，需要操作方明确裁定（该冲突已写进矩阵，等裁定）。
2. **第 3 条按"存在的处置工具"计，平台边界算豁免而不是欠账。** 现存的 3 个处置工具中
   `create_transport_request`、`add_objects_to_transport` 有 `verified` 的受控写记录；
   `cleanup_transport_entries` 是**有裁定记录的平台边界**（ECC 7.31 SP04 无原生 `removeobject`，两次结构
   不同的载荷都没能移除条目，工具自身写后复检拒绝报成功 ⇒ 失败是安全的，补救在 SE09/SE10），因此计为
   豁免。第 3 条的"未完成"因此不是欠账，而是**尚未实现的处置能力**：`transport (2)`、`jobs (4)`、
   `locks (1)`、`updates (1)`、`landscape (2)` 共 10 个计划中的处置工具还不存在（对应计划 Q-O1 的裁定）。

### 7.18 三个 runtime-resources 读的失败定性（2026-09-27）

`read_work_processes`、`read_user_sessions`、`read_file_system_directory` 在 2026-09-27 的实机取证
（`.cache/evidence-ops-n1c/`）中均回 `status: "unavailable"`，**保留 `unverified`**。三者根因**不同**，
不得合并成一句"平台不支持"：

| 工具                         | 接口执行支持 | 失败码                             | 根因                                                                                                                                                          |
| ---------------------------- | ------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_work_processes`        | **false**    | `RUNTIME_RESOURCES_RESPONSE_EMPTY` | `TH_WPINFO` 的三个导入参数无法验证：`WITH_CPU` 的数据元素不是已验证的基本类型，`WITH_MTX_INFO` / `MAX_ELEMS` 的 DDIC 对象不存在 ⇒ 调用前即被 fail-closed 拦下 |
| `read_user_sessions`         | **false**    | `RUNTIME_RESOURCES_RESPONSE_EMPTY` | `TH_USER_LIST` 的 `LIST` 输出含 `MSHOSTADR`，类型未验证                                                                                                       |
| `read_file_system_directory` | **true**     | `RUNTIME_RESOURCES_RFC_FAILED`     | 接口与类型均通过验证，故障发生在**运行时 RFC 调用**（内核拒绝），与上两者不同类                                                                               |

复现方式（只读）：

```powershell
node .cache/mcp-call.mjs read_function_module_interface '{"connectionId":"w200","functionName":"TH_WPINFO","includeExecutionSupport":true}'
```

**注意**：`read_function_module_interface(includeExecutionSupport=true)` 给出的是**服务端类型验证**结论，
与工具自身定义守卫（`reviewedWorkProcessDefinition`：`remoteEnabled` + `updateTask` + 双指纹）**不是同一道门**。
2026-09-27 实测 `TH_WPINFO` 的双指纹与代码中钉死值逐位相同（`cf3be4d6…` / `e5d7078c…`），故工具守卫**通过**，
失败发生在之后的实际调用——因此**不能**据 `executionSupported=false` 断言"工具定义已过期"。

**零行 ≠ 空答案（设计使然）**：`collectWorkProcesses` / `collectUserSessions` 在 `!rows.length` 时抛
`_RESPONSE_EMPTY` 并把状态置 `unavailable`，因为运行中的系统**不可能**真的没有工作进程或会话 ⇒ 零行说明
读取未真正生效，而非"健康但为空"。与此相对，`SWNC_GET_WORKLOAD_DIRECTORY` 允许空目录（采集器目录本可为空），
故同样 `returnedCount: 0` 时它报 `status: "ok"`。**这一差异是有意的，不是不一致。**

**另需注意的分类器陷阱（已修，见 7.15）**：三者的答复同时含 `queryWarnings` 与（对前两者）
`_RESPONSE_EMPTY` 字样；按子串判定会把它们误判成"空但健康"，从而把**未发生的读取**提议登记为 `verified`。

### 7.19 取证扫描器按答复自身状态判定（2026-09-27 修复）

`scripts/probe-ops-read-sweep.mjs` 的 `classify()` 原按**错误码子串**判定，两个方向都曾判错：

1. **把成功判成失败**：本 release 的原生数据预览端点必然失败，每次成功读取仍会带上该次失败尝试的
   `nativeCode: "SAP_DATA_QUERY_RESPONSE_INVALID"`（随后回退 `rfc_read_table` 并正常作答）。子串规则命中了
   **已恢复的中间步骤**，把 `status:"ok"` / `"partial"` 的答复判为 `failed` —— 首轮 `ops-n1b` 中 4 个工具被误判。
2. **把未发生判成空答案**（更危险）：`status:"unavailable"` 且带 `RUNTIME_RESOURCES_RESPONSE_EMPTY` 的答复，
   会被当成"空但健康"，进而提议登记为 `verified`。

**修法**：以答复自身的 `status` 为准 —— `ok`/`partial` → `answered`（`partial` 仅表示行数被截断）、
`empty` → `empty`、`unavailable` → `failed`；仅当答复**读不到 status** 时才回退错误码，且回退前先剔除
良性原生码。`isError` 与 `*_NOT_AUTHORIZED` / `TABLE_NOT_ALLOWED` 仍优先判 `refused`。

**验证**：对 `ops-n1b` 已捕获的 8 份原始答复重跑新分类器，8/8 与各自 `status` 一致（旧规则 5/8 错）。

### 7.20 N3 第一批 - `read_authorization_trace`（2026-09-27）

N3 方案 A 共 13 项（12 个助手分支 + 1 个服务侧工具）。**本轮只落地服务侧那一项**，并纠正计划中的两处错误前提。

**已实现：`read_authorization_trace`（状态半）**。`AUTH_TRACE_GET_STATUS`（FG `SAUTHTRACE`）`remoteEnabled=true`、
无导入、无表参数、无异常、执行契约 `supported=true`，是本批**唯一不需要 SAP 侧助手部署**的项。工具面
**151 → 152 工具 / 91 只读**，ops 组 **28 → 29**，registry **152 条 = 工具数**；计划内缺口 **16 → 15**
（`missingPlannedTools` 相应少一项）。**必需族仍 2/14、`criterionMet=false`** —— `authorizations` 族仍为
`partial`：还缺追踪**数据**（`AUTH_TRACE_GET_AUTHVAL_DATA` 的 `P_AUTHVALTRC_DATA` 含不可验证类型
`XUBITVEC16`，需助手）与"角色→权限对象"解析（`AGR_1251/1252/PROF`、`USOB*`、`UST10*` 未获白名单批准）。

（**后续更正（见 7.23，2026-09-30 第六批）**：括号里的第二项已不成立——那批表已于 2026-09-28 获批准并登记，
"角色→权限对象"解析已由 `read_role_authorizations` 交付；本族剩余缺口只有追踪数据。本段保留为 N3 当时的读数。）

**契约：`RC` 的极性由 SAP 调用方确证，非推断。** `AUTH_TRACE_GET_STATUS` 自己的函数体对 `RC` **支持两种
相反读法**（旧内核分支把 `auth/authorization_trace='Y'` 映射为 `'X'`；新内核分支把 `AUTH_TRACE ACTION='INFO'`
调用失败也映射为 `'X'`）。定论来自**调用方**：`AUTH_TRACE_RESET` 与 `AUTH_TRACE_INTERN_GET_NAME` 都写
`IF lv_rc <> 'X'. EXIT. ENDIF.`，后者注释为 _"If the trace is not active, we do not need to do anything"_。
⇒ **`'X'` = 追踪已激活**。因此本工具**不消费同类工具惯用的 `read_function_module_interface` 返回文本**，
而是直接把 `RC` 解释为开关，并对非 `'X'`/非空值回 `AUTH_TRACE_STATUS_RESPONSE_INVALID`（**不静默当作关闭**）。
两个指纹均已钉死（`sourceFingerprint 935db5a6…`、`interfaceFingerprint d603edfe…`）；指纹不符时**在触碰 SAP
之前**即拒绝。证据：`.doc/n3-auth-trace-status-contract-forensics-20260927.md` §1/§3.5。

**纠正计划的两处错误前提（重要，直接影响后续工期与安全）**：

1. ~~**"所有助手改动都要载体 + 人工 F8"是过度概括。**~~ —— **【本条结论已于同日撤回，见 §7.21】**
   自写保护守卫只对 `ZORVANTA_MCP_CORE` 生效这一**事实**成立，但由它推出"F8 瓶颈大部分不成立"是**错的**：
   `Z_ORVANTA_OPS_READ` / `Z_ORVANTA_MAINT_READ` 虽然是可直写的（不在 CORE），但**契约上只读**
   （`readOnly = true` 无条件写入响应信封，且服务侧 `z.literal(true)` 硬校验），**不能承载任何处置分支**；
   而写类 ops 工具（`create_transport_request` / `add_objects_to_transport`）实测路由到
   `Z_ORVANTA_MCP_DYNPRO_API`，该 FM **在** `ZORVANTA_MCP_CORE` ⇒ **写分支仍然必须走载体 + F8**。
   精确结论见 §7.21。
2. **`delete_sap_lock` 不能建在 `DEQUEUE_ALL` 上。** 该函数导入参数只有 `_SYNCHRON`，**不含任何锁键**，
   语义是"释放全系统所有锁"，无法表达"删除指定的一把锁"，用它实现该工具**语义错误且极其危险**。
   精确路径存在：SAP 为每个锁对象生成 `DEQUEUE_<锁对象名>`（实测枚举到该族；抽查 `DEQUEUE_E_TABLE` 为
   `remoteEnabled=false`）⇒ 仍走助手，但须**按锁对象动态派发**。**待裁定**（Q-N11，见取证 §5.1）。
   **【本条路径判断已于 2026-09-28 更正】**：真正被 SM12 使用的入口是 **`ENQUE_DELETE`**（FG `SENT`，
   `remoteEnabled=false`，键是整行 `SEQG3`），不是按锁对象派发 `DEQUEUE_<obj>`；依据是 SM12 程序
   `RSENQRR2` 的 `FORM enqdelete_marked`。精确结论、权限检查与部署状态见 **§7.23**。

**未做**：12 个助手分支的实现与部署、操作码表登记、载体生成、指纹重钉。**未执行任何测试**。

### 7.21 N3 范围更正 - 写分支仍须载体 + F8（2026-09-27）

§7.20 第 1 条对本批成本模型的判断**是错的**，此处撤回并给出实测依据。正确的划分是：

| 半边        | 分支                                                                                                       | 落入哪个助手                                           | 受自写守卫                    | 部署方式                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------- | ---------------------------------------- |
| **写 6 项** | `create/modify/release/cancel_background_job`、`delete_sap_lock`、`release_transport_task`                 | **仓库 body**（`Z_ORVANTA_MCP_EXECUTE`/`_DYNPRO_API`） | ⛔ **在 `ZORVANTA_MCP_CORE`** | **载体 + 用户 SE38/F8 必须**             |
| **读 4 项** | `read_authorization_trace`(数据半)、`read_archive_status`、`read_performance_snapshot`、`read_db_activity` | `Z_ORVANTA_OPS_READ` / `Z_ORVANTA_MAINT_READ`          | ✅ 不在 CORE                  | 可经 `write_function_module_source` 直写 |

**【更正，2026-09-28】** 本表原列 6 项读工具，含 `read_email_queue` 与 `read_ccms_alerts`，两项现都已移出：
前者经用户裁定从 `interfaces` 族**撤下**（理由见 §7.6 的更正：`SOST` 在 w200 上没有活的邮件流量）；
后者**已实现，且完全不需要助手**——它走服务端已验证的读表通路直接读 `ALALERTDB`（registry 里 `helper: null`、
`availabilityBasis: target-specific`，与 `read_qrfc_queues` 同形），因此既不属本表的"读助手"清单，也不落在
`ZORVANTA_MCP_CORE` 的自写守卫范围内，其部署只是重建+重启本仓库本身。本表剩余 4 项。

**三条实测依据**（不是推断）：

1. **写类 ops 工具的目标助手在 CORE**：`src/tool-registry.ts:90` `REPOSITORY = "Z_ORVANTA_MCP_DYNPRO_API"`，
   而 `create_transport_request` / `add_objects_to_transport` 都路由到 `REPOSITORY`；
   `read_function_module_interface` 实测该 FM 的 `functionGroup = ZORVANTA_MCP_CORE`（`Z_ORVANTA_MCP_EXECUTE` 同）。
2. **两个可直写助手契约只读**：`scripts/operational-log-source.mjs:321` 与
   `scripts/maintenance-diagnostic-source.mjs:258` 都在 `CASE iv_action` **之前**无条件
   `CONCATENATE ... ',"readOnly":true,'`；服务侧 `src/operational-logs.ts:146` 与
   `src/maintenance-diagnostics.ts:139` 用 `readOnly: z.literal(true)` 硬校验。把处置分支塞进这两个
   助手会让它们**同时违反 ABAP 侧与 TypeScript 侧两处契约**。
3. **计划 §4 指定的登记表属于仓库 body**：`.doc/n3-implementation-plan-20260927.md:86` 要求新操作码进
   `$helperCapabilityOperations`，而该表（`bootstrap-sap-helper.ps1:66-69` 注释 + `:6224` 消费点）是
   `$repositoryFunctionSource` 的 CAPABILITIES 表，该 body 部署到 EXECUTE/DYNPRO 两者。

**对工期的影响**：写半边（6 项）**仍必须**载体 + F8；好消息是可按 `docs/release-process.md §7.2` 既有范式
**合并到 2 个载体**（EXEC 与 DYNPRO 各一），而非 6 次往返。读半边（6 项）确实不需要 F8。
**故 §7.20 的"瓶颈大部分不成立"应改为"瓶颈只对读半边消失"。**

**教训（写入纪律）**：守卫的适用范围（`SELF_FUNCTION_GROUP_FORBIDDEN` 只认 CORE）与**该助手能不能承载写**
是两个独立约束。前者是"工具会不会被拒"，后者是"契约允不允许"。由前者为真推出后者为真，属于把
"技术上可写"当成"设计上该写" —— 与项目反复出现的"把不受支持说成不存在"是同一类**越界外推**。

> **2026-10-02 追记**：该守卫已由硬拒绝改为**标记门控** —— 提交正文含 `ORVANTA_SELF_WRITE_APPROVED` 时放行，
> 否则仍回 `SELF_FUNCTION_GROUP_FORBIDDEN`。载具 `cf0df7d68d77962e`（source hash `a23c4781…f1c6`）待用户 SE38+F8。
> 上面「只认 CORE」的适用范围与整段结论**仍然成立**；变化的是 CORE 组多了一条**需显式批准**的 MCP 自助写入
> 路径，且该路径**尚未实测**（未部署、未调用）。

### 7.22 `archive-alerts` 闭环与 COUNT 聚合误诊（2026-09-28）

**`archive-alerts` 进入闭环（必需族 2/14 → 3/14，21%）**。两个声明工具都已 `verified`
（`read_ccms_alerts` 10:55、`read_archive_status` 14:24:58，部署见 `.doc/code-update-20260928-142711.md`），
但该族仍被判 `partial`：闭环判据是「`gap` 为空 ∧ 无阻断工具」，而 `gap` 里写着两句"仍缺"，同一段文字
自己声明这两项是**边界**。字段自身文档已写「gap = 闭环前仍缺什么」，故边界陈述属错位。经用户裁定新增
`OpsFamilyDefinition.boundary`（可选，汇总为 `OpsFamilyRollup.boundary`），把边界移出 `gap` 并置
`closeRoutes: ["none"]`（无 gap 的族不得声明等待方，由一致性守卫强制）。**判据本身未改**：仍是「gap 为空 ∧
全体工具 verified」；改变的是把"不会移动的限制"与"仍缺的能力"分开。矩阵为每个族渲染 `Declared boundaries:`。

**`execute_data_query` 的 COUNT 误诊（已修）**。w200 实测：`SELECT COUNT(*) AS CNT FROM ADMI_RUN` 报
`TABLE_QUERY_AGGREGATE_UNSUPPORTED: COUNT is not translated. Supported aggregates are COUNT, SUM, MIN, MAX` ——
一句话同时说 COUNT 不受支持、又把 COUNT 列为受支持。根因在 `src/table-query.ts` 的
`projectionItemPattern` **不认 `AS 别名`**，带别名的聚合落到 `projectionFunctionPattern` 后按"函数不受支持"
抛出。COUNT 本身可用（`SELECT COUNT(FIELDNAME) FROM DD03L WHERE TABNAME = 'DD03L'` → `[{"COUNT_FIELDNAME":30}]`）。
修法是只改诊断：受支持聚合的形式问题抛新码 `TABLE_QUERY_AGGREGATE_FORM_UNSUPPORTED` 并列出可写形式，
四者之外的名字保持原码；两处调用点（单表与联接路径）同批修正。

**教训**：同一句错误文案在"名字不在受支持集合"与"形式不被翻译"两种情形下被复用，就会产出自我矛盾的
结论；错误码的分类维度应是**调用方要改什么**，不是抛出点在代码里的位置。

### 7.23 OP2 locks - `delete_sap_lock` 的助手分支与服务侧（2026-09-28）

**已实现（服务侧 + 助手分支），未部署、未调用**：`delete_sap_lock` 端到端成形——`src/lock-delete.ts`
（输入 schema、确认串 `DELETE_SAP_LOCK`、码表白名单、结果构造）、`src/tools.ts` 的 `deleteSapLock`、
contracts / tool-registry（`D` / `2.15` / `["LOCK_DELETE"]`）/ mcp / capabilities（新能力组
`repository-helper-lock-delete`）/ backend 联合与字段 / adt-backend 选择性发参；助手侧在共享 body 加
`LOCK_DELETE|2.15|W` + 五个 `IV_LOCK_*` 入参（类型全部取自 SEQG3 字段，长度随 DDIC 不漂移）+ `WHEN 'LOCK_DELETE'.`
分支。工具面 157 → **158 工具 / 94 只读**，ops 组 34 → **35**，能力组 32 → **33**，registry **158 条 = 工具数**
（verified 仍 32）；计划缺口 10 → **9**；**必需族仍 5/14（36%）**、`criterionMet=false`。

**纠正 §7.20 第 2 条的路径判断：SM12 的删除入口是 `ENQUE_DELETE`，不是按锁对象派发 `DEQUEUE_<obj>`。**
`ENQUE_DELETE`（FG `SENT`，99 行，`remoteEnabled=false`）：导入 `CHECK_UPD_REQUESTS`（默认 0）、
`SUPPRESS_SYSLOG_ENTRY`（默认 space），导出 `SUBRC`，`TABLES ENQ LIKE SEQG3`；正文对每一行用该行自己的
`GNAME/GMODE/GARG/GUSR/GUSRVB` 调内核（`CALL 'C_ENQUEUE' ID 'OPCODE' FIELD 'R'`）。**调用方证据**在 SM12 自身
程序 **`RSENQRR2`**（2703 行）：`FORM enqdelete_marked` 调 `ENQUE_DELETE`（`check_upd_requests = 1`，
`TABLES enq = del`），随后 `REFRESH del`。按锁对象派发既需要为每个锁对象各生成一个载体，又会让键由调用方
重建（丢掉 `GUSR/GUSRVB`）——与"用读到的行原文删"相比是更差的表达。

**该 FM 自己不做权限检查，所以分支必须补上 SM12 的检查。** `RSENQRR2` 的 `FORM auth_check_all` /
`auth_check_dlou` / `auth_check_dlfu` 用对象 `S_ENQUE`、字段 `S_ENQ_ACT`：`DLOU` = 删自己的锁、`DLFU` = 删他人
的锁、`DPFU`/`DPFC` = 显示他人/他客户端、`ALL` = 全权。分支按"键里的 owner 是否等于 `sy-uname`"选 `DLOU`/`DLFU`，
两者都不通过时再试 `ALL`，全部失败回 `LOCK_NO_AUTHORITY`。`DPFU` 故意不查：本分支不显示也不返回他人锁的
细节（回显的是调用方自己给的键）。**跨客户端不提供**：读与删都固定 `gclient = sy-mandt`。

**键 = 读到的整行，而不是调用方给的键。** 分支先用 `ENQUEUE_READ`（`gclient = sy-mandt`、`guname`、`gname`、
`garg`、`gargnowc = 'X'`）重读，再按 client/owner/table/argument/mode（`lockObject` 给了就再加）逐项计数：
0 命中 → `LOCK_NOT_FOUND`，>1 → `LOCK_KEY_AMBIGUOUS`（要求调用方用 `lockObject` 收窄，分支不替它猜），恰好 1 →
把**那一行**交给 `ENQUE_DELETE`。`GARG` 域 `EQDARG`（CHAR 150，lowercase）⇒ 参数**不做大写转换**（大小写敏感），
owner/table/mode/object 才转换。

**无 `COMMIT WORK`；成功由"读回不存在"证明。** 锁表在内核共享内存而非数据库事务，没有可提交的东西，也就不
声称提交；`SUPPRESS_SYSLOG_ENTRY` 留默认 space，内核仍写 SM12/GEO 审计条目。`ENQUE_DELETE` 导出 `SUBRC` 但
正文**从不赋值**（同一次源码读取确认）⇒ 分支保留对该值的防御性检查（调用方必须检查被调 FM 的返回码），但
**证据是删除后再读一次要求 0 命中**，否则 `LOCK_STILL_PRESENT`。

**部署状态（关键）**：两个载体已按线上基线生成——
`.doc/deploy-repository-dynpro-2.11-r13.abap`（目标 `ZORVANTA_MCP_DYNPRO_DEPLOY`，payload 7953 行，
源 hash `ca5b36c1…`，基线 `cd5e341f…`）与 `.doc/deploy-repository-exec-2.11-r13.abap`（目标
`ZORVANTA_MCP_EXEC_DEPLOY`，源 hash `7f8d25ca…`，基线 `3b12ef54…`）；两者都通过"正文引用的参数都在接口里
声明""无重名声明""线上代码行全部包含在正文中"三项守卫。**线上 `PROTOCOL|MAX` 实测为 DYNPRO = 2.12、
EXECUTE = 2.11** ⇒ 2.15 的 `LOCK_DELETE` 分支**尚未部署**，工具**从未被调用**（registry 条目 `unverified`、
`evidence: null`）。服务侧实际路由到 `Z_ORVANTA_MCP_DYNPRO_API`（`callSapRepository`）⇒ 生效载体是 **DYNPRO 那个**；
同一个载体还会把此前从未部署的 `JOB_RELEASE`(2.13)/`JOB_CANCEL`(2.14) 分支一并带上去，`F8` 前须按生成的
"self-description rows" 逐行复核。

**未做**：载体未运行、SAP 侧未改动、工具未被调用（因此 `locks` 族仍 `partial`，gap 文本保留——工具已建不等于
有真实调用证据）。**未执行任何测试**（人工优先门）。

### 7.24 OP2 updates - `reprocess_failed_update` 立项结论（2026-09-30，用户授权单独立项）

**立项范围**：只做可行性与设计判定——不写 SAP、不改服务端代码、不新增工具、不动族定义。

**结论（先给结果）**：**在受支持的 SAP 接口范围内，`reprocess_failed_update` 无法实现**。`updates` 族剩余的
缺口因此不是「一个还没建的工具」，而是「平台不向无 GUI 调用方暴露的能力」。按本项目既有的分列原则（族 `gap`
只放闭环前仍缺的**能力**，平台或目标固定的限制写进 `boundary`），该族可以以只读口径闭环——但这是需要用户
裁定的结论，本记录**不自行改动族定义**。

**六条实测事实**（全部只读，w200；产物在 `.cache/evidence-updates-project-20260930/`）：

1. SM13 主程序 `RSM13000`（6979 行，完整源 SHA-256 `04882addede10162440d9794cac5fe776ba20e175d019b62e8c139c86c695917`）
   把重启逻辑写成**对话框 FORM**：`VB_V2_RESTART_SINGLE_START`（2735 起）、`VB_V2_RESTART_START_START`（2228/2364 调用）、
   单个 V1/V2 重启（2528/2602/2807）、删除 VB 请求（2184）、Reorg（3024）、Collector 单启（6665）。
2. 真实机制是**内核 C 调用**：`VB_V2_RESTART_SINGLE_START` 先 `CALL 'ThVBCall' OPCODE=SELECT_VB_SERVER` 选更新服务器，
   再 `UPDATE VBHDR SET VBRC = VB_RUN_V2 VBNAME = SELECTED_SERVER WHERE VBKEY = ...` + `commit work`，最后
   `CALL 'ThVBCall' OPCODE=START_VB ID 'VBPARAM' FIELD VBPARAM ID 'VBSERVER' ...`。`ThVBCall` 是内核调用而非已发布 FM，
   Z 助手用不了。
3. FORM 里混着**对话框专属构造**：`MESSAGE S205/S221/S225`，以及 `MESSAGE A210`（3934、6645）——A 类消息是**异常终止**，
   在 RFC 会话里会中断或转储。
4. 唯一 remote-enabled、且自述为「Call SM13 (for parameterized call of SM13, first screen in background)」的是
   `UPD_CALL_SM13`（FG `FBUP`，`remoteMode=R`，`CALL_MODE` + `VBKEYS`），但**其末句是 `CALL TRANSACTION 'SM13'`**
   ⇒ 对话框事务；RFC 会话无 dynpro，不可用。
5. `TH_START_V2`（FG `THFB`）**非 remote-enabled**，入参是集合式选择范围（`DATANF/ZEITANF/DATEND/ZEITEND/USR/CLIENT/FUNC/MAXFBS/SELALL`）
   ⇒ 是「集合式 V2 启动」，不是单请求重复。
6. 命名检索在 `FUNC/FUGR/PROG` 上均无单请求重复的受支持入口：`*VB*REPEAT*`、`*UPDATE*RESTART*`、`*RESTART_VB*`、
   `*VB*RESTART*`、`*NACHVERBUCH*`、`*VB*START*`（仅两条无关命中）、`*UPDATE*REQUEST*`（仅业务模块）、`*REPROCESS*`（仅业务模块）、
   `TH_*V2*`（仅 `TH_START_V2`）。`TH_REORG_VB` 是 Reorg（删除旧请求），不是重复。

**三条被否决的路线**：

- **A 调用 `RSM13000` 的 FORM**：模块池 + 屏幕状态 + `MESSAGE A210`，且必须改标准对象。**否决**——把模块池 FORM 原样搬进
  RFC 正是项目明令禁止的做法。
- **B 走 `UPD_CALL_SM13`**：末句 `CALL TRANSACTION 'SM13'`，对话框事务。**否决**。
- **C 助手自行复刻状态迁移**（写 `VBHDR`/`VBMOD`/`VBLOG` 再启动分发器）：要么依赖内核 `ThVBCall`（不可用），要么直接改
  更新系统的内部状态——未发布接口，且有破坏更新队列的风险。**否决**（即便单独授权，也不是受支持的实现）。

**待裁定（两项，互斥）**：

- **选项 1**：把「无 GUI 调用方无法重复失败更新」记为**平台边界**（写 `boundary`），`updates` 族以只读口径闭环，
  `plannedToolNames` 去掉 `reprocess_failed_update`。影响：必需族 8/14 → **9/14**，计划缺口 5 → 4。
- **选项 2**：保留 `gap` 与计划工具，承认该族在当前平台不可闭环，95% 需另找路径。

**未做**：未改任何 SAP 对象、未写 SAP、未改服务端代码与族定义、未部署、未调用任何写工具、未执行任何测试
（人工优先门）。证据：`.cache/evidence-updates-project-20260930/`（只读产物：3 份检索清单、2 份 FM 接口、4 份源码行范围）。

**裁定与实施（2026-09-30 同日，紧随立项；记录 `.doc/code-update-20260930-092547.md`）**：用户选定**选项 1**。立项轮本身未改任何代码；裁定后才实施：
`src/ops-coverage.ts` 的 `updates` 族 `plannedToolNames` 去掉 `reprocess_failed_update`、`gap` 置空、
`closeRoutes` 由 `["authorization"]` 改为 `["none"]`、`actionRequired` 改为 `false`、`label` 去掉 "reprocess"，
并把上面六条实测事实写进该族 `boundary`。同批修正依赖面：`test/ops-coverage.test.ts`（族状态 `partial`→`read-only`、
`PLANNED_GAP_TOOL_COUNT` 5→4、状态计数、闭环列表、判据分子与百分比）、`docs/ops-runbooks.md` 的 updates 剧本结论边界；
`docs/ops-acceptance-matrix.md` 由生成器重出（`15 families, 9/14 required closed`）。

**读数变化（全部取自生成器与 block 输出）**：必需族 **8/14 → 9/14（57% → 64%）**；计划缺口 **5 → 4**
（余 `create_background_job`、`modify_background_job`、`read_db_activity`、`read_performance_snapshot`）；
全族端到端 8/15 → **9/15（53% → 60%）**；状态计数 partial 6 → 5、read-only 7 → 8；判据 3 的"计划但未建的动作能力"
只剩 jobs (2)。**未做**：未改任何 SAP 对象、未写 SAP、未部署、未调用任何写工具、未执行任何测试（人工优先门）。

### 7.25 集合测试 `IN (SELECT ...)`：同一层，比较的是值而不是文本（2026-09-30 第四批）

**本批交付**：`WHERE <列> IN (SELECT <列> FROM <表> [WHERE ...])` 与 `NOT IN`。内层语句由**同一套文法**
解析（恰好一列、可选 `WHERE`），读取时走**同一个读取器与同一读取上界**；内层是聚合、算术项、`*`、`GROUP BY`、
`ORDER BY` 或 `LIMIT` 时按 `TABLE_QUERY_SUBQUERY_PROJECTION` 拒绝——**一页不是集合**；内层语句本身不被本方言
翻译时按 `TABLE_QUERY_SUBQUERY_UNSUPPORTED` 拒绝（不静默改写成别的东西）；嵌套深度上限 3（`_SUBQUERY_DEPTH`）。

**为什么在服务端判定**：读取器的结构化筛选只收「一个字段名 + 运算符 + 字面量」，**没有集合运算符**，下推通道
物理上表达不了。这与 7.15 的 `WHERE` 算术项同源，因此沿用同一套纪律：**决定成员资格就必须完整**——内层集合
被截断即整体拒绝（`TABLE_QUERY_SUBQUERY_INCOMPLETE`，且**在读外表之前**拒绝，一行都还没被过滤），带该测试的
外层分支被截断同样拒绝（`TABLE_QUERY_WHERE_SUBQUERY_INCOMPLETE`）。「样本之外的样本」不等于「集合之外」。

**类型语义（本批的核心，也是唯一可能悄悄错的地方）**：比较的**类别**由两侧字段各自的 `DD03L` 类型决定，而不是
由读取器打印出来的文本决定：

- 字符类（`CHAR`/`NUMC`/`DATS`/`TIMS`/`LCHR`/`STRG`/`SSTRING`/`VARC`/`CLNT`/`UNIT`/`CUKY`/`LANG`）按
  **忽略尾随空格**比较——同一值从两个声明长度不同的字段读出来（读取器按各自长度补空格）仍然相等；
- 数值类（`INT1/2/4/8`、`DEC`、`CURR`、`QUAN`、`ACCP`、`PREC`）按**精确十进制**比较——`007.50` 与 `7.5`
  是同一个值，`7.5` 与 `7.05` 不是，`1E+01` 这种非十进制写法不是可比较的值。

**算不出来就按名拒绝，绝不退化成文本比较**：两侧类别不同（`TABLE_QUERY_SUBQUERY_TYPE`——SAP 会先把两侧转成
公共类型再比，本层不复刻这个转换，也不猜）、类型不在两类之内（同码，文案指明"无法说明 SAP 如何比较"）、浮点
字段（`_SUBQUERY_FLOAT`）、值不是精确十进制（`_SUBQUERY_VALUE`，**空串数值字段属于此列**：初值在本层没有可
放置的值）、类型未取到（`_TYPE_UNKNOWN`/`_TYPE_UNAVAILABLE`）、内层集合无法读取（`_SUBQUERY_UNAVAILABLE`）。

**接线与发布面**：只为该测试而读的字段在读入后、出答案前删掉（输出仍**恰好**是语句选中的列）；
`querySource.whereSubqueries` 给出每处「分支序号 / 列 / 是否取反 / 集合值个数 / 条件原文」（集合本身即内层语句的
答案，不重复发布）；内层 `LIMIT` 在切分时按括号深度归属内层，**不会**被当成外层语句的 `LIMIT`；**联接方言不认领
集合测试**（该语句落回平台原生错误，不被误读）。

**边界（写进 `query` 族 `boundary`，不是缺口）**：**相关子查询**（内层引用外层的行）不在本层方法内——本层用
**一次完整读取**确立一个集合（或一个值），而相关内层语句要由数据库**逐外层行**计划与求值，本版本没有任何渠道
能做这件事（原生预览端点不可用、读取器只按标识符取列）。有限文法之外的 Open SQL（`HAVING`、`UNION`、
`DISTINCT`、`CASE`、`COUNT/SUM/MIN/MAX` 以外的函数、非等值联接键、超过三张表的联接）同理：本层只复刻
**文档规则允许它精确陈述**的部分，猜剩下的部分等于回答另一个问题。这类语句一律留给平台自身报错。

**缺口变化**：原缺口句里"子查询"一项按**实际交付**收窄为**非相关标量子查询**（`X = (SELECT COUNT(*) ...)`，
同一方法可达、尚未翻译）。**族状态因此仍为 `partial`、必需族仍 10/14、`criterionMet` 仍 false**——不因本批
把缺口写成空而凑闭环。（**后续更正（见 7.22，同日第五批）**：标量子查询已落地，缺口按实际交付清空，族状态
`read-only`、必需族 **11/14**、`criterionMet` 仍 false；本段是第四批当时的读数，保留为历史。）

**验证与证据**：`npm test` **1256 项全绿**（新增 `test/table-subquery.test.ts` 18 项）；`npm run verify` 退出码
**0**（format/lint/typecheck/matrix:check 164 工具 99 只读 12 组/ops:matrix:check 15 族 current/bootstrap/
installer/setup/headless 2 trees 全过）；证伪 `.cache/r34-falsify.mjs` **15/15 FALSIFIED**（本轮首跑 2 处 STILL
GREEN——类别不识别仍比较、被测列不读——已补断言后转红，这正是证伪脚本的用处），`r30` 首跑因本批改动了
`pushableFilters` 谓词而 **SKIPPED 1 处**（锚点失配按失败计），锚点已按当前代码修正并复跑 **8/8**；`r27` 6/6、
`r32` 9/9，复原后全绿。**真机证据仍缺**：4849 上运行的是本切片之前的构建，服务端改动需重启才生效；
`.cache/r35-verify.mjs` 已就绪，旧构建基线 **0/6**（2026-09-30 18:0x 实测：旧构建把 `IN (SELECT ...)` 落回
`SAP_DATA_QUERY_RESPONSE_INVALID`，`whereSubqueries` 尚不存在），与 `r29`（1/6）、`r31`（0/5）、`r33`（1/5）
共用一次由用户执行的 4849 重启。

**未做**：未改任何 SAP 对象、未写 SAP、未创建或释放传输（`GR2K923472` 仍 `D`）、未删除任何文件、未执行任何
真实系统写入；工作树未提交未推送。记录 `.doc/code-update-20260930-181505.md`。

### 7.26 标量子查询落地与 `query` 族缺口清空（2026-09-30 第五批）

**本批交付**：`WHERE <列> <运算符> (SELECT ...)`，六种比较运算符都收，内层语句由**同一套方言**解析。内层必须
**恰好答出一行**：无 `GROUP BY` 的单个聚合（`COUNT`/`SUM`/`MIN`/`MAX`），或单个普通列而其读取恰好返回一行。
除此之外一律按名拒绝而不猜：多行 `TABLE_QUERY_SCALAR_ROWS`（**绝不挑其中一行**——挑一行就是回答另一个问题）、
零行用同一个码（SQL 里那是 NULL、判定为"未知"，三值逻辑本层不复刻）、投影既非单聚合也非单列
`TABLE_QUERY_SCALAR_PROJECTION`（`SELECT *` 亦在此列）、内层带 `ORDER BY`/`LIMIT` `TABLE_QUERY_SCALAR_PAGE`
（一页不是值，`LIMIT 1` 会把本层拒绝挑选的那几行藏起来）、内层语句不被翻译 `TABLE_QUERY_SCALAR_UNSUPPORTED`、
嵌套超过 3 层 `TABLE_QUERY_SCALAR_DEPTH`（与集合测试共用深度上限）。

**完整性与类型语义沿用同一套纪律**：内层读取被行上界截断即整体拒绝（`TABLE_QUERY_SCALAR_INCOMPLETE`，**在读
外表之前**拒绝）；带该比较的外层分支被截断同样拒绝（`TABLE_QUERY_WHERE_SCALAR_INCOMPLETE`）。比较仍是**值的
比较**：类别由两侧字段的 `DD03L` 类型决定，字符类忽略尾随空格、数值类精确十进制；浮点 `_SCALAR_FLOAT`、
类别不同或类型不在两类之内 `_SCALAR_TYPE`、值不是精确十进制 `_SCALAR_VALUE`（空数值属于此列）、类型未取到
`_TYPE_UNKNOWN`/`_TYPE_UNAVAILABLE` 一律按名拒绝；**字符值的大小比较另按名拒绝**（`TABLE_QUERY_SCALAR_ORDER`：
SAP 字符字段的排序规则本层说不清，只判定 `=` 与 `<>`）。内层值的类型：`COUNT` 是本层算出的 `INT4`
（`countOperandType`），`SUM`/`MIN`/`MAX` 取被聚合列的字典类型——`COUNT` 若按字符处理，`ZAEHL = (SELECT
COUNT(*) ...)` 这类最常见的写法会立刻因类别不同被拒绝，因此这个合成类型是契约的一部分。**发布面**：
`querySource.whereScalars` 给出每处「分支序号 / 列 / 运算符 / 内层答出的值 / 内层取值列」——集合不重复发布
（可能很大），标量**发布这一个值**（它是调用方问的那一半）；只为比较而读的字段在读入后、出答案前删掉。

**共享解析器的一处必要改动**：`WHERE` 尾部原先由一条正则切分 `WHERE ... [GROUP BY ...] [ORDER BY ...]`，而
`= (SELECT ... ORDER BY ...)` 里的 `ORDER BY` 会**切在括号内部**，使内层 `ORDER BY` 未被认领、`_SCALAR_PAGE`
拒绝来不及触发（旧行为下该语句是"不被本方言认领"而不是"按名拒绝"）。改为按括号深度扫描的 `splitWhereTail`。
两处刻意**保持旧行为**：不跳过字符串字面量（`WHERE TEXT = 'X ORDER BY Y'` 仍按旧规则处理并由既有测试守着）、
括号不平衡不返回 `undefined`（深度饱和于 0），因此既有全部测试未改。

**为什么可以清空缺口**：族声明的五项能力（投影算术项、`WHERE` 项、联接投影项、集合测试、标量子查询）全部落地；
族内两个工具（`read_abap_table`、`execute_data_query`）在 `contracts/verification-registry.json` 中均为
`status: "verified"`；五项能力各有 w200 只读读数——前四项 22/22，标量切片由 `.cache/r38-verify.mjs` 13/13
（2026-09-30 20:34，用户重启 4849 至当前构建后取得，输出 `.cache/r38-verify.json`），**合计 35/35**。于是
`src/ops-coverage.ts` 的 `query` 族 **`gap` 置空、`closeRoutes` 改为 `["none"]`**，原缺口叙述整体移入
`boundary`（能力叙事 + 边界），并按收口族的既有约定在族定义处写明「清空是建成的**结果**，不是凑闭环的手段」。
（**同批更正**：本节初稿写的"标量切片真机读数待下一次重启"已由该读数取代，`boundary`、本文、`docs/table-query.md`
与 registry 备注四处同批改写，未留下已变假的静态声明——按当时事实，那一句原本是与清空同时给出的限定条件。）

**机器读数（本批闸门）**：`npm run ops:matrix:check` 退出码 **0** → 15 族 current、**必需族闭环 11/14 = 79%**
（上一批 10/14），`criterionMet` 仍 **false**，未闭环为 `transport`/`jobs`/`authorizations`；
`npm run matrix:check` 退出码 **0** → **164 工具 / 99 只读 / 12 组**，helper 能力 35 覆盖 65 工具、bootstrap
DDIC 33 派发对 33 声明（两项读数与上一批一致，因为本批只改服务端查询层）。

**验证与证据**：`npm test` **1275 项全绿**（新增 `test/table-scalar.test.ts` 19 项）；证伪
`.cache/r37-falsify.mjs` 对标量切片 **22/22 FALSIFIED**（首跑 7 处未过：2 处断言不足、1 处锚点在共享代码里
不唯一、3 处锚点因本批改动失配、1 处变异在标量路径上不可观测——补齐断言与锚点后全红，锚点失配按失败计而
不是跳过）；既有脚本复跑 `r24` 6/6、`r25`、`r25b`、`r26`、`r27` 6/6、`r30` **8/8**、`r32` 9/9、`r34` **15/15**
（`r30` 1 处、`r34` 6 处锚点因本批改动的共享谓词与新增守卫而失配，已按当前代码改成带错误码的唯一锚点后全部
复红），复原后全绿。`npm run verify` 见 7.22 收尾读数（本段与记录同批）。

**真机读数（w200，2026-09-30 19:24-19:36 与 20:34，用户重启 4849 之后）**：`r29` 6/6、`r31` 5/5、`r33` 5/5、
`r35` 6/6 = **22/22**（旧构建基线分别为 1/6、0/5、1/5、0/6），四份读数落在 `.cache/r29|r31|r33|r35-verify.json`；
此前那轮 16/22 的六处未过全部定位为**验收脚手架缺陷而不是服务缺陷**，诊断记录 `.doc/code-update-20260930-192647.md`、
探针输出 `.cache/r36-probe.json`，处置记录 `.doc/code-update-20260930-193631.md`。**第五切片同批补上读数**：
`.cache/r38-verify.mjs` **13/13**（输出 `.cache/r38-verify.json`），五切片合计 **35/35**，`query` 族声明的五项
能力至此各有一份真机读数。

**该读数顺带确认的两件事**：① 内层是聚合时 `querySource.whereScalars[].valueColumn` 为 `null`（聚合答的是值、
不命名列），内层是单列时该字段命名单列——契约与 `docs/table-query.md` 已按此措辞；② **`T006` 的整行读会被
解码守卫按名拒绝**（`SAP_TABLE_QUERY_FAILED: TABLE_QUERY_NUMERIC_OVERFLOW`，`stage=rfc_query`）：只读探针
`.cache/r38-probe2.mjs` 显示 `SELECT ADDKO FROM T006`（全表）与 `SELECT MSEHI, ZAEHL, ADDKO FROM T006`（全表）
均失败，而 `SELECT MSEHI FROM T006` / `SELECT ZAEHL FROM T006`（全表 276 行）成功。**成因同批查清**（只读探针
`.cache/r39-probe1|3|4|6|7.mjs`，输出 `.cache/r39-probe1|2|3|4|5|6|7.json`）：276 行中 274 行可解码（273 行
`ADDKO=0.000000`、1 行 `9.000000`，文本宽度全为 8 字符），不能解码的**恰好两行** `MSEHI='GC'` 与 `'FA'`；两行
`DIMID='TEMP'`（摄氏/华氏），`ZAEHL/NENNR` 为 1/1 与 5/9（华氏的 5/9 换算因子），`EXP10`/`EXPON`/`DECAN`/
`TEMP_VALUE` 全为 0 ⇒ 加法换算常数只能落在 `ADDKO`；该字段在 `DD03L` 是 `DEC 9/6`、读取器自报的字符宽度是
**9**，而摄氏 273.15 / 华氏 255.372222 的十进制文本需要 **10** 个字符 ⇒ 文本不可能是纯十进制数，守卫按名拒绝
（守卫在 `src/table-query.ts:768-772`，凡打印文本不是以数字开头的十进制或含 `*` 即拒）。**判定：这是数据与宽度
条件，不是守卫过窄** —— 守卫接受该宽度下任何以数字开头的十进制文本（274 行读数即为证），因此"静默截断成合法
数字"这条路径不存在（那会是读数成功而非报错）；**守卫保留不改**，调用方按字符列过滤这两个键即可读该表其余
部分，整行读（`SELECT *`、无过滤聚合）必然包含它们、按名拒绝属预期行为。**2026-09-30 第七批补足证据面**：该
拒绝不再是无从定位的字符串——`TABLE_QUERY_NUMERIC_OVERFLOW` 现在同批携带 `overflowColumn`（无法解码的列名）、
`overflowRawValue`（读取器从该字段字符位取出的**未 trim** 原文）与 `overflowRowKey`（该行的主键，取投影中出现的
键列；投影不含任何键列时该字段缺省而不臆造）。未 trim 是刻意的：守卫判定的是 trim 后的值，带星号的替代文本与
"不认作纯十进制的形状"这两条子句究竟哪条命中，只能从读取器真正解出的缓冲区判断。因此**上文的"原始文本不可观测"
已作废**；仍未闭合的只剩"对 `T006` GC/FA 两行打一次整行读、直接看回执里的原文"这一次真机调用。判定结论不变：
宽度论证已说明这两行的值印不进该字段字符位，所以没有"被隐藏的数值"——本来就不存在可解的数值。
（守卫在 `src/table-query.ts`，凡打印文本不是以数字开头的十进制或含 `*` 即拒。）

**未做**：未改任何 SAP 对象、未写 SAP、未创建或释放传输（`GR2K923472` 仍 `D`）、未删除任何文件；工作树未提交
未推送。记录 `.doc/code-update-20260930-200604.md`、`.doc/code-update-20260930-203830.md` 与本次记录。

### 7.27 `authorizations` 族后半：角色→权限对象解析（2026-09-30 第六批）

**本批交付**：新工具 `read_role_authorizations`（ops 组、只读、`target-specific`、无助手依赖），把一个角色解析为它
**存储**的权限对象/字段/取值，全部走共享评审读取器：

- `AGR_1251`——角色授予的权限对象与其取值，**14 个真实字段 / 165 字符**（DD03L 另报两个 `.INCLUDE` 标记，无数据）
- `AGR_1252`——角色的组织级别取值，键是变量名 `VARBL`，7 字段 / 159 字符
- `AGR_PROF`——角色生成的参数文件名，每语言一行，5 字段 / 106 字符
- `includeProfileObjects`（缺省 `false`）再按**每个不同参数文件**（**不是每个语言行**）各一对读展开 `UST10S`
  （参数文件→权限对象与授权名，5 字段 / 38 字符）与 `UST10C`（参数文件→子参数文件，4 字段 / 28 字符）

字段与键序取自 w200 的 DD03L 实测（2026-09-28 首次、2026-09-30 复读 `.cache/r41-probe.mjs` / `r41-probe.json`），
五张表**没有任何字段被裁掉**——最宽的一行仍远低于评审读取器 512 字符的行上限。答案把 `AGR_1251` 归并为
`authorizationObjects[].fields[].values[]`，`LOW`/`HIGH`/`COUNTER`/`AUTH`/`VARIANT`/`NODE` 与存储标志
`DELETED`/`MODIFIED`/`COPIED`/`NEU` **原样返回**（`*` 仍是通配符，不解释）；`AGR_1252` 成为 `organizationLevels[]`，
`AGR_PROF` 成为 `profiles[]`。**仍是存储主数据、不是权限判定**：从不说某用户"有/没有某权限"，也不套用
`AGR_USERS` 的有效期窗口（那是 `read_user_authorizations` 的职责，两工具各管族的一半，要两半就都读）。

**两条明写的边界**（进 `notes` 与契约，不留给读者猜）：① `USOBT`/`USOBT_C`、`USOBX`/`USOBX_C` **刻意不读**——其
`NAME` 装的是**事务名**（w200 实测样本：`/ASU/MAINTAIN`、`/ASU/SSM`）而非角色，按角色解析等于"每个事务一次读"，
那是事务取向的问题而不是角色解析；② 本工具**不能证明角色是否存在**——`AGR_DEFINE` 未登记读，故空答案只说"该名字
没有存储取值"，不说"角色不存在"。过滤只有 `roleName`，精确、大小写敏感，空名或超 30 字符在触达 SAP 前以
`ROLE_AUTHORIZATIONS_SCOPE_INVALID` 拒绝；读取按 `maxRows`（缺省 200、硬上限 500）截断并**逐表报告**
`truncated.*`。

**族缺口收窄（仍 `partial`）**：原缺口两句里的"角色→权限对象解析 **as a tool**"已交付，**剩余缺口只有授权追踪数据
本身**（`AUTH_TRACE_GET_AUTHVAL_DATA` 的 `XUBITVEC16` 需 SAP 侧助手新分支 + 部署，属 SAP 侧改动，本批不含）。
因此 `authorizations` 族**仍非闭环**、必需族仍 **11/14 = 79%**、`criterionMet` 仍 **false**——按"缺口清空是
**结果**不是手段"的既有纪律，不把这条剩余缺口改写掉。

**机器读数（本批闸门）**：`npm run matrix:check` 退出码 **0** → **165 工具 / 100 只读 / 12 组**（+1 只读），
helper 能力 35 覆盖 65 工具、bootstrap DDIC 33 派发对 33 声明；`npm run ops:matrix:check` 退出码 **0** → 15 族
current、**必需族闭环 11/14 = 79%**、`criterionMet` 仍 **false**（未闭环 `transport`/`jobs`/`authorizations`）；
`npm run verify` 退出码 **0**（format/lint/typecheck/两个矩阵闸门/测试 **1283 项全绿**/bootstrap/installer/setup/
headless 2 trees）。同批因新增工具而更新的**依赖测试与文案**（不同批就会留下假声明）：`test/ops-coverage.test.ts`
的 ops 组计数 41→42（两处）、`test/protocol.test.ts` 的暴露工具冻结清单、`test/tools.test.ts` 依赖的
`src/capabilities.ts` 的 `authorization-assignments` 能力工具表与观察文本、`src/user-authorizations.ts` 的头注释与
答案 `notes`、`src/contracts.ts` 的 `read_user_authorizations` 描述（三处从"解析是另一个工具的事/未获批准"改为
**点名 `read_role_authorizations`**）、`src/ops-coverage.ts` 的族定义（`plannedToolNames` + `gap` + `OPS_TOOL_ROLES`）、
`docs/ops-coverage.md` 7.7 与 7.20 两处历史段落的**更正指针**，以及两个矩阵产物（`docs/tool-index.md` /
`contracts/tool-index.json` / `docs/ops-acceptance-matrix.md`）。

**证伪**：`.cache/r43-falsify.mjs` **5/5 FALSIFIED**，复原后全绿——① 参数文件通路按**语言行**而不是按参数文件重复
展开；② 空名/超长角色名不拒而照发（`AGR_NAME = ''`）；③ 无视 flag 总读参数文件通路；④ 归并只留字段的最后一个
取值；⑤ 被截断的权限值读数报成完整。锚点全部要求在编译产物中唯一，失配按失败计。

**真机读数（w200，2026-09-30 21:19 用户重启 4849 之后）**：`tools/list` 由 164 → **165**，`.cache/r42-verify.mjs`
**14/14**（输出 `.cache/r42-verify.json`，`.cache/r44-restart-check.mjs` 先确认了新工具已暴露）。读数内容：
`Z_WMS_FHTZS_02_8050` → `S_TCODE/TCD` `["ZW60","ZW65"]` + `ZDOC/ZDOCTYPE 11`、`ZDOC/ZWERKS1 8050`、
`ZDOC/ZWERKS2 *`（2 对象 / 5 字段 / 6 取值 / 1 参数文件 `T-G2802611` / 0 组织级别，`MODIFIED='G'`、`NEU='O'`、
counter `000005` 原样）；`ZMODCB_HMD` → `ZMODCB`/`ZTCCMF` + 组织级别 `$WERKS`；不给 flag 时 `sources` 恰为
`[AGR_1251, AGR_1252, AGR_PROF]`（参数文件通路**完全不读**），给 flag 时经 `UST10S`/`UST10C` 展开并带存储的
`AKTPS`；未知角色答空且带"不能证明不存在"的说明；小写名取值为 0；`maxRows: 2` 报 `partial` 并按源报告截断；
空名在触达 SAP 前以 `ROLE_AUTHORIZATIONS_SCOPE_INVALID` 拒绝。每源记 `method` 与 `status`，本例三源为
`rfc_read_table` + `nativeCode SAP_DATA_QUERY_RESPONSE_INVALID`（w200 上评审读取器**回落通路**的既有形状，
不是失败）。据此 registry 条目已由 `unverified` 改为 **`verified`**（`lastAttemptAt 2026-09-30T21:19:19+08:00`，
evidence 指向 `.doc/code-update-20260930-211934.md`）。**首跑 13/14 是脚手架缺陷**：脚本自己预期
`authorizationFields 4`，而该角色 6 个存储取值落在 **5 个对象/字段对**上（脚本少算一个），服务是对的——已改脚本
期望值并复跑，与 2026-09-30 那轮 16/22 同属"验收脚手架断言写错"那一类，记录在案。

**族仍 `partial`、必需族仍 11/14**：本工具已验证**不改变**闭环数——族缺口里还剩授权追踪数据本身
（需 SAP 侧助手新分支 + 部署）。

**未做**：未改任何 SAP 对象、未写 SAP、未创建或释放传输（`GR2K923472` 仍 `D`）、未删除任何文件（本批新增的
`.cache/r41-probe.mjs`/`r42-probe.mjs`/`r42-verify.mjs`/`r43-falsify.mjs`/`r44-restart-check.mjs` 与三份 `.json` 全部
保留）；工作树未提交未推送。本批记录：`.doc/code-update-20260930-211417.md`（实现）与
`.doc/code-update-20260930-211934.md`（真机读数）。

### 7.28 授权追踪**行半边**真机落地、溢出拒绝带证据、transport 真机阻塞点（2026-09-30 第七批）

**A. `read_authorization_trace` 行半边的真机根因与修法**。首跑（`.cache/r75-key-shape.json`）以
`AUTH_TRACE_DATA_CALL_FAILED` 收场，助手捕获到的传输层原文是 **`SAP SOAP response exceeded 10 MiB`**——
170 个键一次交给 `AUTH_TRACE_GET_AUTHVAL_DATA` 的答复超过 `src/adt-backend.ts` 的 10 MiB 上限，被 `postSapSoap`
主动中断。这是**传输层上限**，不是 SAP 侧权限或类型问题。

修法（`src/auth-trace-status.ts`）：键按 **32 个一页**递交；某页失败且该页多于 1 个键、且失败码是
`AUTH_TRACE_DATA_CALL_FAILED` 时**对半重试**（深度上限 5），直到放得下或确认单键也读不出。行半边源新增
`pages`/`failedKeys`/`failureMessage`，状态机据此分出 `partial`：`failedKeys === 0` 时按行数给 `ok`/`empty`；
有失败键时**已读出任何一页**给 `partial`，**一页都没读出**且码以 `_RESPONSE_INVALID` 结尾才给 `invalid`，否则
`unavailable`。`keysTruncated` 同时覆盖"键表被 200 上限截断"与"行数已达 `maxRows`"两种情况，`sapCount` 是各页
`P_DBCNT` 之和。单测 `test/auth-trace-status.test.ts` **22 项**（分页 32/32/1、对半重试的尝试序列
`[8,4,2,2,4,2,2]`、单键也读不出时报 `partial` 并保留原文、定义读不出时报 `unavailable`）。

**真机读数（用户重启 4849 后，`.cache/r90-batch-verify.json`）**：`read_authorization_trace`（无过滤、
`maxRows: 50`）返回 **`status: "ok"`**，`keysAvailable 170`、`keysSelected 170`、`keysUsed 32`、`pages 1`、
`failedKeys 0`、`returnedCount 203`、`sapCount 203`、`traceRowsTruncated true`、**零警告**——行半边真的读出了
`USOB_AUTHVALTRC` 的行。据此 registry 条目把"行半边尚无真机调用"的旧话改写为本次读数，并把
`lastAttemptAt` 推到 `2026-09-30T17:00:34+08:00`。

**B. 数值溢出拒绝在"抛出"路径上也带证据（裁定 ⑤）**。`execute_data_query` 的拒绝是以异常抛给客户端的，
`src/tools.ts` 两处抛出点原先只拼了码与阶段，`src/table-query.ts` 新算出的 `overflowColumn` /
`overflowRawValue` / `overflowRowIndex` / `overflowRowKey` 全被丢掉。现由 `tableQueryEvidence(result)` 统一
渲染（JSON 编码每个在场字段，`; ` 连接）。真机读数：`execute_data_query SELECT ADDKO FROM T006` →
`TABLE_QUERY_NUMERIC_OVERFLOW; stage=rfc_query; overflowColumn="ADDKO"; overflowRawValue="*5.372222";
overflowRowIndex=53`（投影无主键列，故**不**报 `overflowRowKey`）；同一读法经 `read_abap_table` 走结果对象
路径时带 `overflowRowKey {"MANDT":"200","MSEHI":"FA"}`；对照 `SELECT MSEHI FROM T006` 正常返回 276 行。
`test/table-query-full-rows.test.ts` 21 项钉住这两条形状。

**C. `release_transport_task` 真机阻塞点（已查实，未闭环）**。用户授权的一次真实释放对专用测试请求
`GR2K923484` 发起，SAP 侧短转储：`CALL_FUNCTION_PARM_UNKNOWN` / `CX_SY_DYN_CALL_PARAM_NOT_FOUND`，
助手程序 `SAPLZORVANTA_MCP_CORE`（含 `LZORVANTA_MCP_COREU03`）**第 6631 行**的 `CALL FUNCTION
'TRINT_RELEASE_REQUEST'`，报 `Function parameter "ET_MESSAGES" is unknown`。**请求毫发无损**：释放前后 E070 均
`TRSTATUS='D'`，任务 `GR2K923485` 仍 `D`，对象仍 `ZORVANTA_SHLP_T01`。

四份只读取证互相矛盾，且都不支持"我们写错了段"：①被调方**自身源码头行**声明 `EXPORTING ET_MESSAGES TYPE
CTSGERRMSGS`（`.cache/r85-callee-header.txt`）；②ADT 接口文档同样列出它；③助手正文第 **6643** 行确实把它写在
`EXPORTING` 段下（`search_abap_object_lines`，全文仅 1 处命中）；④被调方 `get_version_history` 只有
**1 个版本（2012-12-01，SAP）**，即从未改过接口。运行期却说该参数不存在。据此判定为**应用服务器上加载的接口
与仓库不一致**（旧加载把该参数放在 `TABLES` 下，正是 2026-09-29 那次 F8 报的错），并据此按裁定执行了
**内容保持的再激活**（`abap_activate` 成功，`sourceFingerprint` 前后均为 `a8f50761…`）后**重试释放，仍以同一
转储失败**。故该阻塞点不在本服务可控范围内：需要 SAP 侧刷新该函数组的加载/缓冲区，属标准对象操作，未获授权、
也不在本服务能力内。另：`GR2K923484` 至今状态 `D`，**没有**发生任何不可逆效果。

**D. `import_transport_queue` 的正分支在当前系统不可观测**。释放前预检（`.cache/r77-precheck-GR2K923484.json`）
给出 `code TRANSPORT_IMPORT_CHECKED`、`verdict import_not_allowed`、`calleeSubrc 2`、`simulateMode "L"`、
`localE070Status "D"`、`helperMessage "无法启动传输控制程序 tp"`、`importable false`——SAP 自己的 `TMS_TP_IMPORT`
在本系统**起不了 tp**（环境/TMS 边界），与请求是否已释放无关。释放成功也改变不了这一点，故
`importable true` 这一支在本系统上无法取得真机证据。

**E. CI 触发收窄（裁定 ④ 选项①）**：`.github/workflows/verify.yml` 的 `on:` 由 `push` + `pull_request` +
`workflow_dispatch` 收窄为**仅 `workflow_dispatch`**，文件头写明裁定来源与"要有一次派发运行通过后才恢复 push
触发"的条件。配置一律不手改产物、不删旧记录。

**族与闸门**：A 使 `authorizations` 族**真闭环**（行半边有真机证据）——`npm run ops:matrix:generate` 输出
**15 族、必需族闭环 12/14**、`criterionMet` 仍 **false**（未闭环：`jobs`、`transport`）。
`npm run matrix:generate` → **165 工具 / 100 只读**。（**该读数已被 §7.29 取代**：jobs 族于 2026-10-01 真机闭环，
此后为 **13/14**、`criterionMet` 仍 false，未闭环只剩 `transport`。）

**未做**：未改任何 SAP 标准对象；未创建任何传输；`GR2K923472` 仍 `D`；未删除任何文件（本批 `.cache/r84`–`r93`
全部保留，含两次失败的释放取证）。本批记录：`.doc/code-update-20261001-012029.md`（在工作区根 `.doc`）。

### 7.29 jobs 族写侧真机闭环与运维助手两处同族缺陷（2026-10-01 第八批）

本批把 jobs 族从"已实现、未调用"推到**真机 11/11 全绿**，并在过程中修掉运维助手里两处**同类**缺陷。三处
改动分属两个助手，一次收口。

**A. 缺陷六：`modify_background_job` 把已排定作业改成已释放（仓库助手
`Z_ORVANTA_MCP_DYNPRO_API`，载体 `ZORVANTA_MCP_DYN227`）**。真机读数：`create` 后 `STATUS='P'`，一次 header
modify 把它变成 `'S'`，随后 `release` 回 `JOB_RELEASE_FAILED`（SAP `subrc 4`）。根因读 SAP 标准源码定案，
不是推断：`BP_JOB_MODIFY` 在 `dont_release='X'` 之下先置 `release_privilege_given = btc_no`（第 408 行），但
`dialog='N'` 的 opcode-16 分支走 `BP_JOB_EDITOR`（`job_editor_opcode = btc_check_only`，第 538 行），后者第
179 行调 `PERFORM check_release_privilege`（FORM 在 `LBTCHF12:707`，重查 `S_BTCH_JOB/JOBACTION='RELE'`），把
该全局改回 `btc_yes`，于是第 647 行 `new_status = btc_released`，由 `update_modified_jobdata`
（`LBTCHF13:356+`）落库。**`dont_release` 对该路径结构性无效**——这修正了 2026-09-30 未闭环时对
`dont_release` 的期望。修法：两个分支在读回 `TBTCO` 之后，若改动前为 `'P'`/`'Z'` 而读回为 `'S'`，显式再调
`BP_JOB_MODIFY`、`opcode = 18`（`btc_derelease_job`）改回 `btc_scheduled`；SAP 拒绝或以 `'S'` 收场则回
`JOB_DERELEASE_FAILED` 并附 `subrc`，**不当作成功**。同时把闸门由 `<> 'P' AND <> 'S' AND <> 'Z'` 收紧为
`<> 'P' AND <> 'Z'`：已释放作业一律 `JOB_NOT_MODIFIABLE`。依据：从未运行的作业不可能持有 `'S'`；且
`reset_release_info_in_db`（`LBTCHFXX:2063`）只删 `TBTCS`/`BTCEVTJOB` 的开始条件行、**不触碰 `TBTCO`**，
`SDLSTRTDT/SDLSTRTTM` 会留存，允许改已释放作业就需要一次静默再释放。opcode 18 路径的可行性逐点读过线上源：
`check_job_modify_privilege`（`LBTCHF13:144`）接受 `{btc_scheduled, btc_released, btc_put_active}` 且其非法
状态过滤只作用于 `opcode EQ btc_modify_whole_job`；`BP_JOB_MODIFY:450-454` 对 opcode 18 直接赋
`new_status = btc_scheduled` 而不重算权限。部署经人工 SE38+F8（仓库族通道），回执
`DONE: helper regenerated; 50 capability rows written`，`get_capability_report` 复核
`sourceHash = 74cc22fe…`，与导出正文 sha256 逐位一致。

**B. 缺陷七：`make_time` 宏内的 `RETURN` 中止整个函数模块（运维助手 `Z_ORVANTA_OPS_READ`）**。现象：
`read_background_job_details` 对一切**尚未跑完**的作业只回裸 `READ_ONLY_UNSUPPORTED`。根因由 **25 行真值表
取样**定案（`.cache/r273-truth-table.json`）：唯一判据是 `TBTCO-ENDDATE` 是否为空——`STATUS='S'` 的
`ZWMS_8050/14141600` 其 `SDLSTRTDT=20261001` 合法却同样中止，排除了"时间不可表示"这一解释。机制：`make_job`
宏对空的 `STRTDATE`/`ENDDATE` 仍调用 `make_time`，而 **ABAP 宏体内的 `RETURN` 退出的是外层处理块，即整个函数
模块**，于是请求在构造作业头时中止，`ev_result` 停在分派前无条件写入的兜底值。为什么此前无法归因：只有
`JOB_LOG` 走 `JOB_LOG_DIAGNOSTIC` 别名置诊断位，`JOB_DETAILS` 是裸动作，而 `job_stage` 在正常模式下是空操作，
所以详情路径连阶段名都拿不到；用 `read_background_job_log` 取得助手自报 `reason: "JOB_TIMESTAMP"` 才定位。
修法按用户裁定 ①（只改生成器 `scripts/operational-log-source.mjs`）：`make_time` **不再含任何
`RETURN`/`CHECK`/`EXIT`**，改为纯正向条件把有效性写入新变量 `lv_time_valid`；时间判空用 `CO '0123456789'`
而非 `IS INITIAL`（`TYPE T` 的午夜 `'000000'` 的 `IS INITIAL` 为真，正是 DYN224 的老坑）。`make_job` 三个
调用点各自判该标志：无效则渲染 `null`。窗口校验与 TemSe 消息记录两处**保留拒绝**，但改为在调用点显式
`RETURN`；系统日志循环改为跳过该单条记录。服务端同批适配：`backgroundJobSchema.scheduledSystemTime` 由非空改为
`.nullable()`，`JOB_SEARCH` 窗口比对把 `null` 作为具名不一致拒绝。
**教训（本批最重要的操作结论）**：首版修法去掉了 `job_stage` 但**保留了 `RETURN`**，真机回执于是从
`JOB_TIMESTAMP` 变成 `JOB_PROT_AUTHORITY`——中止点只是后移了一层。**宏内必须彻底无早退；`RETURN` 本身才是
缺陷。**

**C. 缺陷八：`read_background_job_log` 对无日志作业回兜底码（同族，用户当场授权顺手修）**。`TBTCO-JOBLOG`
是 CHAR 20，未跑完的作业为**空白**、跑完的为 `JOBLGX…`（全状态取样见 `.cache/r281-joblog-values.json`）。原守卫
`IF ls_job-joblog(6) <> 'JOBLGX' … RETURN` 直接落到兜底码，调用方会误读成"本系统不支持读作业日志"。修法：
`JOBLOG` 为空时回 `ok` + 作业头 + 空消息列表（作业存在、能力存在，只是尚无日志），`JOBLGX` 路径不变。

**D. 真机验收与回归**。`.cache/r100-jobs-acceptance.mjs` **11/11 全部 PASS、`failures: 0`**：create
（`JOB_CREATED`，SAP 分配 `jobCount`，`status=P`）→ 重复 create（`JOB_DUPLICATE`）→ 读存在 → modify header
（`JOB_MODIFIED`，`status=P`）→ SAP 显示新计划 → modify steps（`JOB_MODIFIED`，`stepCount=1`）→ release
（`JOB_RELEASED`，`status=S`）→ 对已释放作业 modify（`JOB_NOT_MODIFIABLE`）→ cancel（`JOB_CANCELLED`）→
读回消失（`NOT_FOUND`）。修复后形态复核（`.cache/r283`）：`S`/`Y`/新建 `P` 的详情与日志全 `ok`（日志
`totalMessages 0`），`F` 回归对照仍 `ok` 且 6 条消息。正文一致性：`.cache/verify-ops-read-body.mjs
--variant=runtime` 回 `deployed_source_verified`，接口指纹 `621a1362…` 三次部署**始终未动**，只重钉批准文件的
`sourceFingerprint`（`56176ac6…` → `527bbaa2…` → `3a8f3b08…`）且 `enabledSources` 逐项保留。

**族与闸门**：jobs 族八个工具**全部 `verified`**，族 `gap` 清空 → `npm run ops:matrix:generate` 输出
**15 族、必需族闭环 13/14**、`criterionMet` 仍 **false**（未闭环：`transport`）。
`npm run matrix:generate` → **167 工具 / 100 只读**。

**未做**：未改任何 SAP 标准对象；未创建传输；`GR2K923472` 保持 E070 状态 `D` **未释放**；未删除任何文件或
SAP 对象（载体 `ZORVANTA_MCP_DYN222`–`DYN227` 全部保留）。本批记录：`.doc/code-update-20261001-135303.md`。

### 7.30 Section renumbering map (2026-10-03)

This document's §7.x subsections had accumulated duplicate numbers (two §7.13, two §7.14, two
§7.15 and two §7.17, with §7.12 sitting after §7.20), so a citation such as "§7.13" was ambiguous.
The subsections were renumbered **sequentially in physical order** on 2026-10-03. Nothing was
deleted, merged or reordered - only the numbers changed.

Records under `.doc/code-update-*.md` are immutable historical documents: they keep citing the
numbers as they stood when they were written, and this table is how those citations are resolved.
Citations inside this document and in the repository's live documents were updated in the same
change.

| Old  | New  | Subsection                                                                                     |
| ---- | ---- | ---------------------------------------------------------------------------------------------- |
| 7.1  | 7.1  | Evidence standing and the OP0-2 worklist (2026-09-25; table at 0.50.11, D1 session at 0.50.15) |
| 7.2  | 7.2  | Ops runbooks (OP4-2)                                                                           |
| 7.3  | 7.3  | Re-issuing the approval files (helper-bound approvals)                                         |
| 7.4  | 7.4  | Allowlist additions and the platform boundary (2026-09-25 rulings)                             |
| 7.5  | 7.5  | OP1-4 - 系统基线与系统参数（2026-09-25）                                                       |
| 7.6  | 7.6  | OP1-2 - 接口与队列（2026-09-25）                                                               |
| 7.7  | 7.7  | OP1-3 - 用户与权限分配（2026-09-25）                                                           |
| 7.8  | 7.8  | OP1-1 - 运行时资源：工作进程与会话（2026-09-25）                                               |
| 7.9  | 7.9  | OP1-1 第二批 - 应用服务器目录列表（2026-09-26）                                                |
| 7.10 | 7.10 | OP1-1 第三批 - 负载目录与性能通路的取证结论（2026-09-26）                                      |
| 7.11 | 7.11 | OP1-7 收口 - 受控只读查询的联接支持（2026-09-26）                                              |
| 7.13 | 7.12 | 右/全/交叉联接与 `LIMIT` 落地（2026-09-30）                                                    |
| 7.14 | 7.13 | 投影算术项：按官方计算规则在服务端复刻（2026-09-30，路线 A）                                   |
| 7.15 | 7.14 | WHERE 里的算术项：同一层，判定在服务端（2026-09-30 第二批）                                    |
| 7.20 | 7.15 | 联接投影里的算术项：同一层，类型按别名各自表解析（2026-09-30 第三批）                          |
| 7.12 | 7.16 | OP0-2 取证扫描器 - 构建陈旧必须先被拦下（2026-09-26）                                          |
| 7.13 | 7.17 | 验收口径的两处硬读法（2026-09-26）                                                             |
| 7.14 | 7.18 | 三个 runtime-resources 读的失败定性（2026-09-27）                                              |
| 7.15 | 7.19 | 取证扫描器按答复自身状态判定（2026-09-27 修复）                                                |
| 7.16 | 7.20 | N3 第一批 - `read_authorization_trace`（2026-09-27）                                           |
| 7.17 | 7.21 | N3 范围更正 - 写分支仍须载体 + F8（2026-09-27）                                                |
| 7.17 | 7.22 | `archive-alerts` 闭环与 COUNT 聚合误诊（2026-09-28）                                           |
| 7.18 | 7.23 | OP2 locks - `delete_sap_lock` 的助手分支与服务侧（2026-09-28）                                 |
| 7.19 | 7.24 | OP2 updates - `reprocess_failed_update` 立项结论（2026-09-30，用户授权单独立项）               |
| 7.21 | 7.25 | 集合测试 `IN (SELECT ...)`：同一层，比较的是值而不是文本（2026-09-30 第四批）                  |
| 7.22 | 7.26 | 标量子查询落地与 `query` 族缺口清空（2026-09-30 第五批）                                       |
| 7.23 | 7.27 | `authorizations` 族后半：角色→权限对象解析（2026-09-30 第六批）                                |
| 7.24 | 7.28 | 授权追踪**行半边**真机落地、溢出拒绝带证据、transport 真机阻塞点（2026-09-30 第七批）          |
| 7.25 | 7.29 | jobs 族写侧真机闭环与运维助手两处同族缺陷（2026-10-01 第八批）                                 |
