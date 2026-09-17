# M6.3 Quality Check Coverage

Version 0.36.18 extends `run_atc_analysis` with `action=check_quality`. Existing
`run_analysis` and `get_documentation` actions retain their output formats.
No additional tool, dependency or SAP helper deployment is required.

Version 0.36.19 adds `precheck_atc`, a GET-only metadata probe, and fixes native
execution to use the returned worklist ID when creating the ATC run.

## Native ATC Precheck

```json
{
  "action": "precheck_atc",
  "connectionId": "w200"
}
```

This calls only `GET /sap/bc/adt/atc/customizing`. It does not call the SDK's
misleadingly named `atcCheckVariant`: that method POSTs a new worklist and returns
its ID. Neither worklists nor ATC runs are created by precheck.

`metadata_available` means configuration metadata was parsed, not that a variant
was validated or an analysis can complete. `selectedVariant=null` means no default
or configured variant was found. A configured variant remains unvalidated.
GET failure does not prove that all native ATC functionality is absent.

Native execution retains the variant for display but passes the returned worklist
ID to `createAtcRun`. Failures in `check_quality` now identify `customizing`,
`create_worklist`, `create_run`, or `read_worklist`. Attempt flags record whether
creation was attempted, not whether it succeeded. A transport error after a POST
can leave an uncertain server-side outcome; there is no automatic retry or cleanup.

On 2026-09-09, the running 0.36.18 service returned native ATC HTTP 404 for both
w200 fixtures. Syntax checks still completed. CVERS reported SAP_BASIS 731 /
EXTRELEASE 0004. These observations do not prove whether an administrator can
enable the endpoint or whether a system upgrade is necessary. The TSTC probe was
unavailable due to the bounded query tool's legacy layout guard, not an empty
transaction list. No server enablement, system upgrade or SCI expansion was performed.

## Request

```json
{
  "action": "check_quality",
  "connectionId": "w200",
  "fileUris": [
    "adt://w200/sap/bc/adt/functions/groups/zorvanta_mcp_core/fmodules/z_orvanta_mcp_sci_api",
    "adt://w200/sap/bc/adt/programs/programs/zcodex_fs_sync_0807"
  ],
  "includeAtc": false,
  "maxFindings": 100
}
```

Obtain exact URIs from SAP object search or workspace-URI lookup. A batch contains
1-10 unique source targets belonging to the selected connection. Supported targets:
programs, classes, interfaces, individual function modules and includes. A whole
function group, package or transport is not a source target. No automatic name
resolution, caller/include expansion, editor selection or cross-system routing occurs.
Namespaced percent-encoded URIs are not supported in this first increment.

All inputs are validated before the first SAP request. Duplicate targets, including
an object and its `/source/main` alias, are refused. `maxFindings` is an integer
between 1 and 200 per engine per target, default 100. This bounds returned finding
counts, not SAP execution cost or the complete backend worklist retrieval.

Syntax diagnostics execute by default. Native ATC is opt-in using `includeAtc=true`
and `acknowledgePotentialSideEffects=true`: configured native variants may execute
test code. This acknowledgement does not authorize business-data writes. Select
only approved objects/variants. The standalone Unit tool and the SCI helper are
never called by this action.

## Evidence

Each target has independent `syntax` and `atc` results:

- `completed`: the engine returned, with findings and an explicit truncation flag.
- `partial`: ATC returned an explicitly incomplete object set.
- `unavailable`: the existing backend identified an unsupported endpoint.
- `failed`: authorization, transport, parser or other request failure, not empty findings.
- `not_requested`: native ATC was not selected.

A failed target/engine does not suppress later targets or the other selected engine.
`status=completed` means all requested calls returned, even if they found errors.
`status=partial` means at least one requested engine failed, was unavailable, or
returned an explicitly incomplete ATC object set.
`qualityGate` is always `not_evaluated`.

ATC retains its reported variant, priorities and finding-documentation URIs. Use
`get_documentation` before interpreting a finding. No automatic fixes, severity
reinterpretation, baseline approval, suppression or quality gate is applied.
Per-rule completion is not independently verified.

ATC `coverage.objectSet` preserves the server's complete/incomplete flag; backends
without this evidence report `unknown`. Object-set completeness does not prove
complete findings or rule execution. The native adapter explicitly preserves its
existing request limit of 100 verdicts as `requestedMaximumVerdicts`, independently
of the client output limit (up to 200). `findingCount` counts retrieved findings;
`truncated` only describes local output slicing. `serverTruncation=unknown` must
not be interpreted as an untruncated server result, including for zero findings.
The legacy `run_analysis` text format is unchanged.

Syntax coverage is only the requested source, not proof of a complete function-group,
include or caller graph. Empty findings do not establish business correctness.
Fixed-scope `run_sci_analysis` remains separate and cannot cover arbitrary targets.
Expanding that helper's object/rule scope requires separately approved SAP changes.

## Acceptance

```powershell
npm.cmd run build
node --test dist/test/quality-checks.test.js
node scripts/probe-quality-checks.mjs
```

The real-system probe checks the running version before invoking the new action and
stores evidence under the workspace root `.doc`. Its default scope is syntax plus
boundary rejection on the two explicit w200 fixtures above. After specific native
ATC test authorization, `--approve-atc` adds ATC; unsupported ATC remains partial.
This script does not switch services or install helpers.

The deployed 0.36.18 syntax/boundary path passed its scoped acceptance on 2026-09-09.
The 0.36.19 precheck and native execution repair must be separately switched and
exercised before claiming deployed acceptance. Local/mock tests, endpoint failures
and package tests are different evidence layers. General SCI expansion and
per-rule execution proof are not delivered by this increment.
