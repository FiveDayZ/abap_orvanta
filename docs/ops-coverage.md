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

Two consequences worth stating explicitly, because both were previously easy to overstate:

- The **jobs** family does not become `read-and-act` because job details and spool text can be read.
  Job control is absent, so the family stays `partial` and the gap names the missing control.
- The **transport** family has both readers and writers (create, add objects, cleanup) and is still
  `partial`, because release and import - the operations that actually move an object forward - are
  absent.

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

At product version 0.50.9 the block reports **2 of 15 families end-to-end (13%)**, which is **2 of the
14 required families (14%)**, with 23 planned tools still unbuilt and `criterionMet: false`. The
earlier assessment put end-to-end closure near 40%; that figure counted read-side breadth across
families, not family purposes. This document's rule is the stricter one, and it is the one the
completion criterion uses. Both readings agree the 95% target is far from met.

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
- A per-target lock makes a second concurrent operation on the same object answer `target_busy`
  instead of interleaving. `protection_failed` means the receipt or lock layer itself could not be
  established, and the operation is refused rather than sent unprotected.
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

Of the 20 `ops` tools, `contracts/verification-registry.json` now records `verified` 15,
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

| Tool                          | Status             | What closing it needs                                                                                                           | Standing after the 2026-09-25 D1 session                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_background_job_details` | `verified`         | closed                                                                                                                          | `read_background_job_details(jobName=SWWDHEX, jobCount=00001200)` returned `status=ok` with one step (program `RSWWDHEX`, execution user `WF-BATCH`) and a revision, so the detail path is proven on live data rather than only deployed. That job reported spool id `0000000000`, so nothing in this call covers spool content.                                                                                                                                                                                                                                                                        |
| `read_background_job_spool`   | `unverified`       | one approved read with a real `stepNumber`/`spoolId` from a job that produced spool output                                      | attempted and still blocked by the system rather than by the tool: every step of five `SWWDHEX` job counts (`00001200`, `00031200`, `00061200`, `00121200`, `00151200`) reported spool id `0000000000`, and twelve standard spool-producing job names (`SAP_COLLECTOR_FOR_PERFMONITOR`, `RSBTCDEL2`, `RSPO0041`, `RDDNEWPP`, `SAP_REORG_SPOOL` and others) held no job at all across a three-day window. The approved SM37 window holds only aborted single-step workflow jobs (`SWWDHEX`, `SWWERRE`, `SWWCOND`), so no spool-bearing job exists to read and no sample may be created to close the row. |
| `search_failed_updates`       | `unverified`       | one approved SM13 window (<= 1 hour) with an explicit username that actually contains a failed update                           | the approved SM13 path is now proven callable - seven approved one-hour windows across `wys`, `WF-BATCH` and `DDIC` each returned `status=ok`, `code=OK`, `returnedCount=0` with `coverage=retained_failed_update_headers_current_client` - which exercises only the empty path. No window contained a real failed update, and fabricating one is forbidden, so the row stays unverified on a missing sample rather than on an unproven call.                                                                                                                                                           |
| `read_failed_update`          | `unverified`       | one approved existing `updateKey` (revision optional)                                                                           | the same seven windows were empty, so no `updateKey` exists to read; the detail tool has neither a call nor a sample to cite.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `cleanup_transport_entries`   | `failed` (runtime) | either Basis-level native ADT `removeobject` support on this release, or an explicit decision to accept the platform limitation | unchanged by this session: two structurally different payloads were tried against w200, the entry survived both, and the tool fails safe by refusing to report success. Per section 6 point 2 this may count as "the platform limitation is itself the closed finding" only if that decision is taken deliberately, which is a user call, not a code change.                                                                                                                                                                                                                                            |

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
what the table above covers, and the `query` family additionally holds two tools from the `data` group
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

| File                                    | Family                  | Approved sources               | Refusal when not satisfied                      |
| --------------------------------------- | ----------------------- | ------------------------------ | ----------------------------------------------- |
| `operational-log-approvals.json`        | `logs` (SM37/SM21/SP01) | `SM37`, `SM37_DETAILS`, `SP01` | `HELPER_NOT_APPROVED` / `APPROVAL_FILE_MISSING` |
| `maintenance-diagnostic-approvals.json` | `locks`, `updates`      | `SM12`, `SM13`                 | `HELPER_NOT_APPROVED` / `APPROVAL_FILE_MISSING` |

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
