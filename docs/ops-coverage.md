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
falsifies the guard itself (a family that loses a planned tool, a role that contradicts the
registry), so the check is known to be able to fail.

## 3. The end-to-end rule

> A family counts as end-to-end only when its declared `gap` is empty. Monitoring reads never
> compensate for a missing action.

Two consequences worth stating explicitly, because both were previously easy to overstate:

- The **jobs** family does not become `read-and-act` because job details and spool text can be read.
  Job control is absent, so the family stays `partial` and the gap names the missing control.
- The **transport** family has both readers and writers (create, add objects, cleanup) and is still
  `partial`, because release and import - the operations that actually move an object forward - are
  absent.

At product version 0.50.8 the block reports **2 of 15 families end-to-end (13%)**: `logs` and
`dumps`, with 23 planned tools still unbuilt. The earlier assessment
(`.doc/orvanta-mcp-ops-coverage-assessment-and-next-phase-plan-20260925.md`) put end-to-end closure
near 40%; that figure counted read-side breadth across families, not family purposes. This document's
rule is the stricter one, and it is the one the completion criterion uses. Both readings agree the
95% target is far from met.

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

## 6. Completion criterion for the operations programme

The operations programme is complete when, for at least 95% of the families in
`src/ops-coverage.ts`:

1. the family state is `read-only` or `read-and-act` (declared gap empty);
2. every tool in the family is `verified` in `contracts/verification-registry.json`, with evidence
   recorded from the target system - not `unverified`, `failed`, or `platform-unsupported` unless
   the platform limitation is itself the closed finding;
3. any action the family performs is reachable only through a confirmation gate, verifies its own
   effect by reading back, and is idempotent or retry-safe;
4. the family's behaviour is covered by the regression matrix, and the gate (`npm run verify`)
   passes with the new evidence.

Point 2 is what separates this document from a progress narrative: a family that reads correctly but
whose tools carry no recorded call is not complete.

## 7. Checking the current state

- Read the block directly: call `get_capability_report` and inspect `opsCapability.families`,
  `opsCapability.summary.stateCounts`, `opsCapability.summary.missingPlannedTools`.
- Static checks (no test execution): `npm run typecheck`, `npm run matrix:check`.
- The classification guard and the expected family states are asserted in
  `test/ops-coverage.test.ts`; it runs under the repository test gate with the authorisation
  required by `AGENTS.md` section 1.1.
