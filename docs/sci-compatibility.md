# SCI Compatibility

Version 0.36.6 adds `run_sci_analysis` as a separate tool. Existing
The existing `run_atc_analysis` actions are unchanged. Version 0.36.18 adds an
independent `check_quality` action; see [quality checks](quality-checks.md).
SCI is not native ATC and is never substituted for arbitrary quality-check targets.

## Namespace Migration (2026-09-14)

Current source targets `Z_ORVANTA_MCP_SCI_API`, `Z_ORVANTA_MCP_SCI_V2` and
`Z_ORVANTA_MCP_SCI_E2` in `ZORVANTA_MCP_CORE`. Existing CODEX objects and
published packages are retained; the current client does not fall back to them.
Historical evidence below still names the objects actually checked at that time.
Those results do not attest the renamed helpers or a newly built service.

The pinned values come from `read_function_module_interface.fingerprint` on
w200/client 200 after reviewing the new helpers. That complete fingerprint is
not interchangeable with `interfaceFingerprint`, `sourceFingerprint`, or an
ADT source hash. Re-read and review it after any helper source or metadata
change; never disable the comparison to complete a namespace migration.
Local and SAP regression execution remains subject to human-first approval.
Building source alone does not replace or restart an existing release process.

## Deployment

The SAP helper must already exist as remote-enabled `Z_ORVANTA_MCP_SCI_API` in
function group `ZORVANTA_MCP_CORE`. The tool pins the complete helper fingerprint,
including its source, and refuses to invoke an unverified replacement. This
helper is not installed by the generic bootstrap script.

The reviewed w200 deployment uses package `ZABAP` and transport `GR2K923421`.
The transport has not been released. Never deploy standard SAP object changes
to work around ATC registration or permission gates.

## Contract

### Legacy Requests

Inputs: `connectionId`, `action` (`precheck` or `run`), and explicit
`acknowledgePotentialSideEffects: true`.

- `precheck`: reads the saved global DEFAULT variant without executing it.
  Automatic variant import is disabled. `configuredRules` is not coverage.
- `run`: checks only FUGR `ZORVANTA_MCP_CORE`, using an anonymous
  `SYNTAX_CRITICAL_V1` profile. This is a profile label, not a saved SAP variant.
  It selects `CL_CI_TEST_SYNTAX_CHECK` version 001 and
  `CL_CI_TEST_CRITICAL_STATEMENTS` version 002 with constructor defaults.
- Anonymous object set, check variant, and direct inspection are used.
  ABAP Unit is disabled and suppression is disabled. No named inspection is
  saved, no inspected source is changed, and no background job is scheduled.
- Requires `S_DEVELOP` display authorization for the fixed function group/package.
  The caller cannot select arbitrary objects, variants, packages, or transports.
- At most 1000 findings are returned. Total count and text/row truncation are
  explicit. Message text is limited by BAPIRET2 to 220 characters.
- Native finding kind E/W/N, test class, code, include, line, and column are
  retained. N means an SCI note, not a confirmed defect.

Outputs always state `engine: SCI`, `nativeAtc: false`,
`coverage: limited`, and `qualityGate: not_evaluated`. Per-rule completion is not
attested by this legacy SCI API. Empty findings never mean a passed quality
gate. Helper failures and inconsistent responses become MCP errors.

## Evidence And Limits

On September 7, 2026, SOAP execution in w200/client 200 returned 12 configured
DEFAULT rules in precheck and 28 findings from the two-rule execution:
3 warnings and 25 notes. These are check results, not 28 confirmed defects.

The existing 0.36.5 service can invoke the helper through
`test_remote_function_module`; listing the new dedicated tool requires
starting 0.36.6. Packaging does not replace a running service.

This scope does not cover arbitrary daily-development objects, full DEFAULT
checks, ATC exemptions/worklists, SQL performance coverage, or business runtime
validation. Broader rule and object coverage requires separate review and
authorization. A different helper source requires a fresh source review,
runtime verification, and an updated pinned fingerprint.

## SCI-E1 Explicit Single Object (0.36.26)

Adding `target` explicitly selects the separate `Z_ORVANTA_MCP_SCI_V2` helper.
Omitting it preserves the legacy request, helper fingerprint and response.
No automatic migration or fallback to a different target is performed.

```json
{
  "connectionId": "w200",
  "action": "precheck",
  "target": {
    "objectType": "CLAS",
    "objectName": "ZCL_ORVANTA_MCP_CORE"
  },
  "acknowledgePotentialSideEffects": true
}
```

- Accepted types: `PROG`, `CLAS`, `FUGR`; one exact uppercase Z/Y name.
  Programs have at most 40 characters, classes/function groups at most 30.
  PROG is restricted to executable, module or subroutine pools, not includes,
  class pools or function pools addressed as a program.
- SAP validates the active repository identity, actual package, display
  authorization, program category, exact resolved object and nonempty program.
  Local validation alone is not the security boundary.
- V2 `precheck` resolves the object and two constructor-default rule versions
  (001/002) and applicability, without creating/running an inspection.
  It does not read the saved DEFAULT variant.
- `run` uses that same anonymous two-rule profile, direct mode, no ABAP Unit.
  Class/function-group internal includes are within the main-object scope;
  there is no single-method or single-FM isolation.
- Response includes `requestedTarget`, resolved `scope`, program/package,
  rule versions/applicability, count and truncation. Applicability and returned
  object results do not attest individual rule completion.
- The 1000-row return cap does not limit SAP internal scan time/memory.
  Network timeout does not cancel SAP; do not retry automatically.
- Unknown helper fingerprints, rule versions, target mappings, or malformed
  results fail closed. No quality-gate or native-ATC success is inferred.

W200/client 200 on September 9, 2026: V2 was created and activated in
`ZCODEX_MCP_CORE`, package `ZABAP`, request `GR2K923421` (not released).
Real guarded RFC execution plus the candidate formatter returned zero findings
for `ZCODEX_MCP_DYNPRO` and `ZCL_CODEX_MCP_CORE`, and 28 findings for
`ZCODEX_MCP_CORE`. Zero findings remain `NO_FINDINGS_UNVERIFIED`.
The online service was switched to 0.36.26 on September 9, 2026. The dedicated
`run_sci_analysis` target route returned the same three-object outcomes; input
rejection and the legacy route were also verified.
These results do not prove full ATC coverage or production/business acceptance.

## Repeatable Online Regression

From the standalone project, after authorizing SCI execution for the three
existing customer test objects:

```powershell
node scripts/probe-sci-e1.mjs --approve-run
```

The probe requires the running service to match the built product version and
advertise the target contract. It invokes the dedicated tool only, validates
the two pinned helpers, resolved identities and rule versions, checks
negative-input error categories, exercises the legacy route, and compares
returned source snapshots and the recent dump list. It never uses generic RFC
execution as a substitute for the dedicated route.

A nonzero exit means a gate failed. A zero exit with `dedicatedRouteAcceptance:
Passed` covers that route only: the overall report remains `Partially Verified`
because complete object-set persistence, all includes and resource side effects
are not covered. The probe does not enable SCI-E2 rules, deploy a helper or
write test fixtures. Its latest local changes are not retroactively included in
the already-built 0.36.26 archive.

## SCI-E2.1 Loop Query Profile (0.36.27 Candidate)

An explicit `profile: "syntax_critical_sql"` together with `target` selects
`Z_ORVANTA_MCP_SCI_E2`. Profile without target is rejected; omitting profile
preserves V1/V2 behavior and their helper fingerprints.

```json
{
  "connectionId": "w200",
  "action": "precheck",
  "target": {
    "objectType": "FUGR",
    "objectName": "ZORVANTA_MCP_CORE"
  },
  "profile": "syntax_critical_sql",
  "acknowledgePotentialSideEffects": true
}
```

The `SYNTAX_CRITICAL_SQL_V1` profile keeps the syntax/critical rules and adds
only `CL_CI_TEST_SELECT_NESTED` version 000. It is not a saved SAP variant and
does not enable FAE or arbitrary checks. Helper interface version is 3.0;
`EV_NESTED` reports the additional pinned rule version.

The nested rule reports 0001 (DO/WHILE/PROVIDE, note), 0002 (LOOP, warning),
and 0003 (SELECT loop, note). Templates and the loop parameter are resolved by
SAP. Different enclosing loops can produce findings at the same source line;
the client does not deduplicate them by line. Native SQL and unexpanded macros
are outside this rule's coverage. Findings identify static risks, not measured
performance defects, and do not change `qualityGate: not_evaluated`.

E2 validates all returned internal findings before applying its 1000-row cap.
Scan errors and missing includes fail the operation instead of masquerading
as normal findings; unknown rules, nested-rule codes and severity drift also
fail closed. The row cap still does not bound SAP's scan time or memory.

On September 9, 2026, the helper was created and activated in `ZCODEX_MCP_CORE`,
package `ZABAP`, request `GR2K923421` (not released). Live guarded RFC calls plus
the candidate formatter returned 30 findings for that group, including two
0002 warnings at `LZCODEX_MCP_COREU02` lines 3045 and 3057. Source readback
confirmed queries inside the existing transport-task loop; those queries were
not modified. The existing class/program test objects returned zero findings.
Sequential group/class/program/group calls did not show result contamination,
but they do not prove forced reuse of one stateful RFC session.

```powershell
node scripts/probe-sci-e2.mjs --approve-run
# Only after switching the online service to the candidate:
node scripts/probe-sci-e2.mjs --approve-run --dedicated
```

The online service is still 0.36.26. The new profile's dedicated online
registration/runtime acceptance remains separate from helper deployment and
local protocol tests. Full persistence/resource inventories and artificial
scan-failure/truncation fixtures remain outside the completed live matrix.
