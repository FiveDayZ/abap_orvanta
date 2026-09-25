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

`docs/ops-acceptance-matrix.md` is the plan's OP4-1 deliverable: the same 14 families plus the
exemption, each row carrying the family's purpose, the read and action side it has, its state, the
evidence pointer behind every tool, and **who can remove what is still missing** (`closeRoute`:
`service` / `helper` / `approval` / `authorization` / `landscape` / `platform` / `none`). It is
generated from this module and the registry - `npm run ops:matrix:generate`, checked by
`npm run ops:matrix:check` inside the repository gate - so a state change cannot ship with a stale
acceptance table, and the guard refuses a family that declares a gap without naming a route to
removing it.

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

| Tool                          | Status                 | What closing it needs                                                                                 | Standing after the 2026-09-25 D1 session                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_background_job_details` | `verified`             | closed                                                                                                | `read_background_job_details(jobName=SWWDHEX, jobCount=00001200)` returned `status=ok` with one step (program `RSWWDHEX`, execution user `WF-BATCH`) and a revision, so the detail path is proven on live data rather than only deployed. That job reported spool id `0000000000`, so nothing in this call covers spool content.                                                                                                                                                                                                                                                                        |
| `read_background_job_spool`   | `unverified`           | one approved read with a real `stepNumber`/`spoolId` from a job that produced spool output            | attempted and still blocked by the system rather than by the tool: every step of five `SWWDHEX` job counts (`00001200`, `00031200`, `00061200`, `00121200`, `00151200`) reported spool id `0000000000`, and twelve standard spool-producing job names (`SAP_COLLECTOR_FOR_PERFMONITOR`, `RSBTCDEL2`, `RSPO0041`, `RDDNEWPP`, `SAP_REORG_SPOOL` and others) held no job at all across a three-day window. The approved SM37 window holds only aborted single-step workflow jobs (`SWWDHEX`, `SWWERRE`, `SWWCOND`), so no spool-bearing job exists to read and no sample may be created to close the row. |
| `search_failed_updates`       | `unverified`           | one approved SM13 window (<= 1 hour) with an explicit username that actually contains a failed update | the approved SM13 path is now proven callable - seven approved one-hour windows across `wys`, `WF-BATCH` and `DDIC` each returned `status=ok`, `code=OK`, `returnedCount=0` with `coverage=retained_failed_update_headers_current_client` - which exercises only the empty path. No window contained a real failed update, and fabricating one is forbidden, so the row stays unverified on a missing sample rather than on an unproven call.                                                                                                                                                           |
| `read_failed_update`          | `unverified`           | one approved existing `updateKey` (revision optional)                                                 | the same seven windows were empty, so no `updateKey` exists to read; the detail tool has neither a call nor a sample to cite.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `cleanup_transport_entries`   | `platform-unsupported` | closed by the 2026-09-25 D2 ruling                                                                    | two structurally different payloads were PUT against w200 and neither removed the entry, the native ADT `removeobject` action is absent on this release, and the tool's own post-check refuses to report success. The operator ruled the platform boundary to be the closed finding, so the row moved from `failed` to `platform-unsupported`; the remedy is SE09/SE10.                                                                                                                                                                                                                                 |

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
- **族缺口收窄。** `interfaces` 族由"完全没有工具"变为 `partial`：qRFC/tRFC 与 IDoc 已实现，
  剩余缺口只有**邮件队列**——`SOST` 不在批准的允许清单内，`read_email_queue` 需要单独批准后才能实现。
  两个新工具在重启并完成一次真实 w200 调用前保持 `unverified`（registry 146 条 = 工具数）。
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

### 7.8 OP1-1 - 运行时资源：工作进程与会话（2026-09-25）

**路由取证推翻了计划里的一条假设。** 评估把整个族（族 9：工作进程/会话/性能/DB/文件系统）判为"预计
SAP 助手"通路。2026-09-25 的只读探测（`read_function_module_interface`，证据落在
`.cache/evidence-r16/fm-*.txt`）表明：SAP 侧监视器函数模块本身就是 **remote-enabled 的标准 FM**，而服务
的 `callRemoteFunction` 是把 SOAP 信封直接 POST 到 `http://www.sap.com/<函数名>`（`adt-backend.ts`
L428-434），即"外部 SOAP-RFC 调用"，只要求函数模块 remote-enabled——**不需要助手操作码、不需要载体、
不需要人工 F8**。于是本族的前两个工具走服务侧实现。

| 函数模块                                                                                                                                 | remoteEnabled | 输出表（全部字段均可验证）      | 结论                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------- | -------------------------------------------------------------------------------------- |
| `TH_WPINFO`                                                                                                                              | 是            | `WPLIST`（`WPINFO`，25 字段）   | 可用；仅 `WITH_CPU`/`WITH_MTX_INFO`/`MAX_ELEMS` 三个**可选导入**无法解析，工具不传它们 |
| `TH_USER_LIST`                                                                                                                           | 是            | `USRLIST`（`USRINFO`，16 字段） | 可用；`LIST`（`UINFO`）含无法验证的 `MSHOSTADR`，**故意不请求**                        |
| `TH_SERVER_LIST`                                                                                                                         | 是            | -                               | 可用（后续可选）                                                                       |
| `SWNC_COLLECTOR_GET_AGGREGATES`                                                                                                          | 是            | -                               | 可用（`read_performance_snapshot` 的候选入口）                                         |
| `EPS2_GET_DIRECTORY_LISTING`                                                                                                             | 是            | -                               | 可用（`read_file_system_directory` 的候选入口）                                        |
| `RSPO_RETURN_SPOOLJOB`                                                                                                                   | **否**        | -                               | 不可直连 ⇒ OP1-5 的 Spool OTF/PDF 确实必须走助手                                       |
| `TH_GET_SERVER_INFO`、`SAPWL_GET_AGGREGATED_DATA`、`CCMS_GET_ALERT_TREE`、`DB02_DB_ACTIVITY`、`DB_GET_DB_RELEASE_INFO`、`GET_DB_RELEASE` | -             | -                               | 按该名字**未找到**（记录为"未命中"，不等于不存在）                                     |

**新增工具。** 两个工具都以"接口指纹闸门 + 直接 SOAP-RFC 调用 + 强制行数上限"实现，字段清单来自 w200
的 DD03L 元数据（`.cache/evidence-r16/dd03l-{USRINFO,WPINFO}.txt`）：

- `read_work_processes` · `TH_WPINFO.WPLIST`：`serverName`（`SRVNAME`，`MSXXLIST-NAME`，40 字符）原样下传，
  缺省时由内核返回它自己的默认列表（答案里明写）。固定指纹 source
  `cf3be4d651ae9af6f156fde4d8cf6ea3fd932102df575ae1d4908eae23e2ed16` / interface
  `e5d7078c36abdbbe48cb23c47071e101f82320ec1723dbc7f93b7a4c8edc2f70`。`maxRows` 缺省 200、硬上限 500；
  内核返回行数超过上限时报 `partial` + `truncated`，绝不声称完整。
- `read_user_sessions` · `TH_USER_LIST.USRLIST`：**只请求 `USRLIST`**，`LIST` 因含服务无法验证的类型而不读，
  答案 `notes` 明写这一点。`userName`（12 字符）在服务侧过滤（FM 没有用户导入参数），因此空结果的含义是
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
- **左侧/外联接的语义被刻意收窄**：`LEFT JOIN` 必须是最后一个联接（外联接之后再接内联接会把空扩展行
  又删掉，两种读法含义不同，本服务不猜）；`WHERE` **不得**触碰可选侧（SQL 里那是在过滤联接结果，而下推
  只能过滤可选侧的读取），拒绝并提示把条件移入该联接的 `ON`。
- 发布列名一律为 `别名.列名`（联接里每条列引用都必须限定；不限定即拒，因为"比较放在哪一侧"决定答案）。
  未匹配的可选侧读作空值（与读取器自己的"初始字段=空串"一致）。联接键按**读取器文本**比较，与方言既有
  的排序口径一致（不是 SAP 的类型感知比较）。

**诚实性规则（与单表路径同一套）**

| 情形                                    | 行为                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------- |
| 任一表读取触到行数上限（≤500）          | `truncated=true` + `querySource.join.incompleteAliases`；**不静默联接** |
| 聚合 / `GROUP BY` 遇到任何样本          | 拒绝（`TABLE_QUERY_AGGREGATE_INCOMPLETE`），不报"样本的计数"            |
| `ORDER BY` 遇到任何样本                 | 拒绝（`TABLE_QUERY_ORDER_BY_INCOMPLETE`），不报"不是榜首的榜单"         |
| `ORDER BY` 列不在投影里                 | 拒绝（`TABLE_QUERY_ORDER_BY_COLUMN_NOT_SELECTED`），且**零次 SAP 访问** |
| 右/全/交叉联接、表达式、子查询、`LIMIT` | 不翻译（`TABLE_QUERY_JOIN_TYPE_UNSUPPORTED` 等）                        |

答案里新增 `querySource.join`：每张表的 `alias`/`tableName`/`joinType`/`onKeys`/`pushedFilters`、
`incompleteAliases`、`joinedRows` 与每次读取自身的证据（方法、原生码、指纹、字段元数据按表分列）。

**验收对照（计划 OP1-7 判据）**：① "`SELECT ... GROUP BY` 类排障查询在白名单表上成功" —— 单表聚合早已
具备，本批补齐其上的两表版本（联接后再分组聚合，见测试）；② "越界语句在触碰 SAP 前被拒" —— 全部规则由
解析器判定，测试断言越界语句的读取次数为 **0**。

**覆盖口径**：`query` 族因此**仍是 `partial`**——缺口写明"右/全/交叉联接、表达式、子查询、`LIMIT` 仍不
翻译"，并注明**联接路径尚无运行期证据**（在跑的服务仍是本方言之前的构建）。两个工具
（`read_abap_table`、`execute_data_query`）在登记表里保持 `verified`，但**不**用它来宣告族闭环：新增能力
未在真实系统上跑过，闭环主张就不成立。

### 7.12 OP0-2 取证扫描器 - 构建陈旧必须先被拦下（2026-09-26）

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
