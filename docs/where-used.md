# Bounded Native Where-Used Analysis

The existing `find_where_used` tool supports the modern ADT protocol and, starting
with candidate 0.36.22, a restricted legacy RIS adapter. No new SAP helper is required.
The already locked XML parser is declared directly for strict XML validation.

## Request

```json
{
  "connectionId": "w200",
  "objectName": "Z_ORVANTA_MCP_SCI_API",
  "objectUri": "adt://w200/sap/bc/adt/functions/groups/zorvanta_mcp_core/fmodules/z_orvanta_mcp_sci_api",
  "responseFormat": "json",
  "maxResults": 10,
  "includeSnippets": false
}
```

`objectName` remains required. `objectUri` and `responseFormat` are new optional
fields. Default output remains human-readable text, with more precise errors and
coverage warnings; clients must not assume the text is byte-identical to older
versions. Use JSON for machine processing.

Use either `objectUri` or `objectType`, not both:

- URI mode skips discovery, requires the selected connection and matching object
  name, reads source, and verifies the returned source has the same identity.
- Name mode requires a unique exact name and, when supplied, matching type.
  An empty typed result triggers one bounded name search. It never accepts a
  prefix-only result or silently picks the first ambiguous match. FUNC/FF and
  FUGR/FF are treated as function-module type aliases for result matching.
- A search returning 100 candidates is refused as inconclusive. This is a bound on
  accepted candidates, not on SAP search engine work. The existing backend may
  suppress unsupported type-search errors; empty discovery therefore does not
  prove object absence. Supply the exact URI when discovery is inconclusive.

## Source And Position Scope

Supported targets are individual programs, classes, interfaces, function modules and
includes. Packages, transports, whole function groups, DDIC/non-source targets and
namespaced/percent-encoded paths are outside this increment. Names must be exact,
not wildcard searches. These stricter input constraints apply to text and JSON modes.

Line numbers are 1-based; character offsets are 0-based. `character` requires `line`.
Source-read errors, mismatched source identities, out-of-range positions and missing
positions stop before invoking native references.

Without coordinates, a unique object declaration can identify the cursor. When
`searchTerm` is supplied, repeated occurrences are refused rather than picking the
first occurrence. Supply explicit line/character to disambiguate. Text matching only
selects the requested cursor; it is not a semantic ABAP parser and is never used as
a substitute for native reference results.

## Results

JSON includes resolution method, verified target/cursor, failure stage and counts.
Stages: resolve, source, position, references, snippets, complete.

- `status=unavailable`: the backend reported an unsupported endpoint.
- `status=failed`: discovery/source/position failure or a permission/network/parser
  error. Before references return, `references` and counts are null, not empty.
- `status=ok`: native references returned and the supported response was processed.
  `NO_REFERENCES` is used only when the native engine actually returned zero entries.
- `status=partial`: legacy RIS coverage, unsupported identifier kinds were omitted, or snippet retrieval
  failed. Already retrieved references are preserved.

Raw, supported and filtered counts are separate. `UNSUPPORTED_REFERENCE_IDENTIFIERS`,
`FILTERED_EMPTY` and `PAGE_OUT_OF_RANGE` distinguish different empty views. A zero-row
page is not proof that the target has no references.

`maxResults` is 1-100 (default 50); `startIndex` is 0-10000. Paging is local over
the returned native results, not a stable cross-call snapshot and not a bound on
backend retrieval. `hasMore` reports remaining filtered entries.

Optional snippets are restricted to the returned page, at most three excerpts per
entry and 2000 characters per excerpt. Limits are disclosed in warnings. Snippets
and messages are untrusted evidence; redaction is best effort.

## Validation And Remaining Limits

```powershell
npm.cmd run build
node --test dist/test/where-used.test.js
node scripts/probe-where-used.mjs
```

The live probe requires the candidate version before issuing new requests. It
compares explicit-URI and typed-name resolution for the approved existing SCI
helper and tests invalid-input rejection. It writes evidence under the workspace
root `.doc`. Correctly reporting an unsupported endpoint remains partial acceptance,
not a successful native reference search.

On 2026-09-09, 0.36.19/w200 returned no typed discovery match for FUGR/FF while
untyped search found the same function. Untyped where-used then returned native
HTTP 404. This increment addresses the resolution/reporting path locally; it does
not fix the server endpoint. Deployed 0.36.20 acceptance subsequently confirmed both
resolution paths reach the same source/cursor and native HTTP 404; five invalid input
cases were rejected. No full-system source scan, textual-reference fallback or remote
helper installation was performed.

## 0.36.21 Request Correction

The backend previously passed a workspace `adt://w200/...` URI directly into the
native SDK. SDK 8.4.3 also drops the cursor when its column argument is zero.
The adapter now uses the existing URI normalizer and supplies a complete relative
`/sap/bc/adt/...#start=line,column` URI to the SDK, retaining its request and response
implementation. A regression test inspects the actual SDK request, including column
zero and a nonzero column. These are confirmed local request defects, not proof of
the cause of W200's HTTP 404. The candidate still requires deployed SAP acceptance;
at that increment, the running 0.36.20 service had not been replaced.

## 0.36.22 Legacy RIS Adapter

W200 discovery and active SAP implementation inspection confirmed the legacy
`whereused`, `fullnamemapping` and `metadata` collections. The adapter selects them
only when all three exact paths are advertised and the modern `usageReferences`
collection is absent. Authorization or request failure never triggers a second
protocol attempt. Discovery failures also stop the request.

Legacy support is restricted to the exact function name position on a `FUNCTION`
declaration. It sends the source and cursor to SAP full-name mapping, refuses
missing full-name evidence, mismatched names and scoped mappings, then requests
`WUL_TYPES_COMPLETE` relationship types. Each discovered type gets a separate
`WHERE_USED` request. No hard-coded relationship type substitutes for SAP metadata.
Empty metadata is inconclusive because the SAP implementation can suppress errors.

`engine=ADT_RIS_WHEREUSED` results always have `status=partial`. Generic results do
not supply reliable reference types, packages or snippets. `identifierKind=ADT_RIS_URI`
identifies the actual returned URI; it is not a fabricated `ABAPFullName` identifier.
Type filtering is refused. Name filtering and paging remain available. Requested
snippets produce an explicit warning without invoking the modern snippet endpoint.
An empty generic result is `LEGACY_NO_REFERENCES_UNVERIFIED`, not complete no-reference
proof. Missing/invalid bodies are failures, not empty results.

Safety limits: 32 relationship entries, 10000 accumulated references, 8 MiB XML per
response; exceeding a limit fails rather than silently truncating. These client-side
limits do not bound SAP internal work. DTD/entity declarations, malformed XML and
unexpected roots are rejected. Percent-encoded result URIs are outside this increment.

Regression tests use synthetic values in the observed SAP XML structure; they are
not captured SAP query results. Candidate 0.36.22 still requires a separately approved
service switch and real W200 reference acceptance. No SAP code, ICF configuration,
business data or transport release is part of this adapter.

## 0.36.23 Function Header Correction

Real W200 acceptance of 0.36.22 stopped before legacy mapping: ADT renders a function
name on its own line and places interface parameters on subsequent lines, whereas
the adapter required a period on the first line. Candidate 0.36.23 accepts either
the classic period or the end of the declaration line after the exact function
name. Name and cursor checks remain unchanged, and the source sent to mapping is
not rewritten. Regression tests cover the observed CRLF/multiline shape, case and
indentation, suffix mismatches, comments and invalid trailing tokens.

The acceptance script now reports `Failed` and `behaviorVerified=false` when an
attempted query or assertion fails. Connection/version prerequisites remain
`Partially Verified`. An isolated MCP failure-response test verifies that distinction.
This correction does not establish successful W200 mapping or reference retrieval;
the new candidate still needs a service switch and real known-caller acceptance.

## 0.36.24 Request Timing And Timeouts

Deployed 0.36.23 passed source reads and five invalid-input checks, but the live
SCI-helper query and known `RS_NAVIGATION_PREPARE_NEW` reference query timed out
at the MCP caller. The exact SAP stage was not observable; reading the known
caller source is not a successful semantic-reference search.

The where-used adapter now uses a per-call HTTP facade with the existing SDK
discovery and modern-reference parsers. It leaves the shared client and unrelated
tools unchanged. Each discovery, mapping, metadata or reference HTTP request has
at most 15 seconds of transport timeout. A 45-second elapsed budget is checked
before each request and reduces the remaining request timeout. Later requests
are not sent when this budget is exhausted. This is not a hard end-to-end limit:
source resolution, login/automatic reauthentication, parsing, and SAP internal
work are outside the transport guarantee.

Legacy success and protocol failures include `requestTrace`: stage, elapsed
milliseconds, configured timeout and outcome; responses also include HTTP status
and byte count. The trace excludes bodies, headers, query strings, credentials
and tokens. Repeated `references` entries retain their execution order.
Timeouts remain failed with unknown counts, never zero-reference success.
They do not receive a fabricated HTTP 500 and do not trigger a protocol fallback.
Original errors are retained as internal causes; traces do not serialize them.

Local regression includes a real SDK request to a stalled loopback HTTP server
and checks that the transport closes its local connection after timeout.
This does not prove that SAP work has been cancelled. Candidate 0.36.24 still
requires deployment and a known-caller query to identify the live stalled stage.
