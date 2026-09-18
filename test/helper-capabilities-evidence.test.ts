import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"

// Drift and unit tests for the CAPABILITIES deployment evidence. Everything here runs offline:
// the helper attestations are the real report shapes, no MCP client is created, and no SAP system
// or endpoint is contacted.
//
// The calibration test is what makes the verifier's digest comparison meaningful: recomputing the
// digest of a rendered body by restoring the four ORVANTAHASHSLOT placeholders must reproduce the
// digest the generator embedded in that same body. Without it a verifier could compare the wrong
// value and still pass.

const evidenceFile = "scripts/helper-capabilities-evidence.mjs"
const verifierFile = "scripts/verify-helper-deployment.mjs"
const maintFile = "scripts/maintenance-diagnostic-source.mjs"
const opsFile = "scripts/operational-log-source.mjs"

const evidenceModule = await import(pathToFileURL(resolve(evidenceFile)).href)
// The verifier module is imported for its exported offline surface only; importing it never
// connects anywhere (the suite passes no argv, so its top-level run is a no-op).
const verifierModule = await import(pathToFileURL(resolve(verifierFile)).href)
const maintModule = await import(pathToFileURL(resolve(maintFile)).href)
const opsModule = await import(pathToFileURL(resolve(opsFile)).href)

// The modules are imported dynamically so the suite can also assert that the evidence module
// never reaches into src/ or dist/; the surface it uses is declared here for the type checker.
const targets: Record<string, any> = evidenceModule.helperCapabilityTargets
const digests: Record<string, string> = evidenceModule.helperCapabilityDigests

const {
  bodyLinesHash,
  capabilityBodyDigest,
  capabilityHashSlotGroups,
  compareHelperAttestation,
  compareProtocolVersions,
  functionModuleBodyHash,
  planReplacement,
  readHelperAttestation,
  renderedCapabilityRows,
  writeCapabilitiesEvidence
} = evidenceModule
const { verifyDeployedBody } = evidenceModule

/**
 * A LIVE-shaped function module source: the interface heading, the generator body, a trailing
 * blank line and the `ENDFUNCTION.` wrapper - the shape `read_function_module_interface` returns.
 * This is deliberately different from the generator export, which is body-only.
 */
const liveSourceFor = (target: any) => [
  '*"----------------------------------------------------------------------',
  '*"*"Local Interface:',
  '*"  IMPORTING',
  '*"     VALUE(IV_ACTION) TYPE STRING OPTIONAL',
  '*"  EXPORTING',
  '*"     VALUE(EV_RESULT) TYPE STRING',
  '*"----------------------------------------------------------------------',
  `FUNCTION ${target.helper}.`,
  ...target.generatorBody,
  "",
  "ENDFUNCTION."
]

const operationRows = (target: any) =>
  renderedCapabilityRows(target.generatorBody).filter((row: string) => row.startsWith("OPERATION|"))

/**
 * The report entry a correctly upgraded helper must produce. The real shape (verified live) has
 * NO `transportTask` key: `transport` carries the rendered SOURCE|TRANSPORT row's request field
 * alone.
 */
const selfDescribed = (target: any) => ({
  helper: target.helper,
  minProtocol: target.expectedProtocol.min,
  maxProtocol: target.expectedProtocol.max,
  operations: operationRows(target).map((row: string) => {
    const [, opcode, since, mode] = row.split("|")
    return { opcode, since, write: mode === "W" }
  }),
  scopes: [],
  sourceHash: digests[target.target],
  packageName: target.packageName,
  transport: target.transportRequest,
  host: "w200/200",
  observedAt: "2026-09-18T12:00:00.000Z",
  attestation: "self-described"
})

const comparisonTarget = (target: any) => ({
  helper: target.helper,
  expectedProtocol: target.expectedProtocol,
  expectedOperations: target.expectedOperations,
  packageName: target.packageName,
  transportRequest: target.transportRequest,
  transportTask: target.transportTask,
  sourceHashDigest: digests[target.target]
})

/**
 * The two report shapes observed live on 2026-09-18 (read-only), used as fixtures: a populated
 * self-description, and the null-payload `operation-scoped` pre-state of the two helpers that
 * still answer without a self-description.
 */
const dynproAttestation = {
  helper: "Z_ORVANTA_MCP_DYNPRO_API",
  minProtocol: "1.1",
  maxProtocol: "2.6",
  operations: [
    { opcode: "READ_ENHANCEMENT_IMPLEMENTATION", since: "2.6", write: false },
    { opcode: "PATCH_ABAP_SCREEN", since: "1.1", write: true }
  ],
  scopes: [{ scope: "SM37_DETAILS", enabled: true }],
  sourceHash: "ab".repeat(32),
  packageName: "ZABAP",
  transport: "GR2K923472",
  host: "w200/200",
  observedAt: "2026-09-18T12:00:00.000Z",
  attestation: "self-described"
}
const operationScoped = (helper: string) => ({
  helper,
  minProtocol: null,
  maxProtocol: null,
  operations: [],
  scopes: [],
  sourceHash: null,
  packageName: null,
  transport: null,
  host: null,
  observedAt: "2026-09-18T12:00:00.000Z",
  attestation: "operation-scoped"
})
const reportWith = (helperAttestation: unknown[]) => ({
  readOnly: true,
  safety: {
    sapWritesInvoked: false,
    sapLocksCleared: false,
    automaticWriteRetry: false,
    automaticRollbackClaimed: false
  },
  helperAttestation
})

test("readHelperAttestation finds the entry and never throws on a foreign report", () => {
  const report = reportWith([
    dynproAttestation,
    operationScoped("Z_ORVANTA_MAINT_READ"),
    operationScoped("Z_ORVANTA_OPS_READ")
  ])
  assert.equal(
    readHelperAttestation(report, "Z_ORVANTA_MAINT_READ")?.attestation,
    "operation-scoped"
  )
  assert.equal(readHelperAttestation(report, "z_orvanta_ops_read")?.helper, "Z_ORVANTA_OPS_READ")
  assert.equal(readHelperAttestation(report, "Z_ORVANTA_MCP_DYNPRO_API")?.maxProtocol, "2.6")
  // Every degraded shape yields null instead of throwing.
  assert.equal(readHelperAttestation(report, "Z_ORVANTA_UNKNOWN"), null)
  assert.equal(readHelperAttestation(reportWith([]), "Z_ORVANTA_MAINT_READ"), null)
  assert.equal(readHelperAttestation({}, "Z_ORVANTA_MAINT_READ"), null)
  assert.equal(readHelperAttestation(null, "Z_ORVANTA_MAINT_READ"), null)
  assert.equal(readHelperAttestation(undefined, "Z_ORVANTA_MAINT_READ"), null)
  assert.equal(readHelperAttestation({ helperAttestation: "renamed" }, "X"), null)
  assert.equal(readHelperAttestation(reportWith([null, 7, "x"]), "X"), null)
})

test("readHelperAttestation matches the helper name, never a foreign identity", () => {
  const report = reportWith([dynproAttestation, operationScoped("Z_ORVANTA_OPS_READ")])
  assert.equal(readHelperAttestation(report, "Z_ORVANTA_MAINT_READ"), null)
  const renamed = reportWith([
    { ...operationScoped("Z_ORVANTA_OPS_READ"), helper: "Z_ORVANTA_OTHER" }
  ])
  assert.equal(readHelperAttestation(renamed, "Z_ORVANTA_OPS_READ"), null)
  assert.equal(readHelperAttestation(renamed, "Z_ORVANTA_OTHER")?.helper, "Z_ORVANTA_OTHER")
  const noName = reportWith([{ ...operationScoped("Z_ORVANTA_OPS_READ"), helper: undefined }])
  assert.equal(readHelperAttestation(noName, "Z_ORVANTA_OPS_READ"), null)
})

test("compareHelperAttestation accepts the intended post-deployment state", () => {
  for (const target of [targets.maint, targets.ops] as any[]) {
    const result = compareHelperAttestation(selfDescribed(target), comparisonTarget(target))
    assert.deepEqual(result, { ok: true, mismatches: [] }, `${target.helper}: ${result.mismatches}`)
  }
  // The operation comparison is order-insensitive: the helper may report its own order.
  const reversed = selfDescribed(targets.maint)
  reversed.operations = [...reversed.operations].reverse()
  assert.equal(
    compareHelperAttestation(reversed, comparisonTarget(targets.maint)).ok,
    true,
    "operation order must not matter"
  )
})

test("compareHelperAttestation refuses the pre-upgrade operation-scoped shape", () => {
  for (const target of [targets.maint, targets.ops] as any[]) {
    const result = compareHelperAttestation(
      operationScoped(target.helper),
      comparisonTarget(target)
    )
    assert.equal(result.ok, false)
    assert.deepEqual(result.mismatches.map((line: string) => line.split(":")[0]).sort(), [
      "attestation",
      "maxProtocol",
      "minProtocol",
      "operations",
      "packageName",
      "sourceHash",
      "transport"
    ])
    for (const line of result.mismatches) assert.match(line, /: expected .* reported /)
  }
})

test("compareHelperAttestation names every mismatched field without throwing", () => {
  const target = targets.maint
  const expected = comparisonTarget(target)
  const cases: Array<[string, any, RegExp]> = [
    ["missing entry", null, /helperAttestation: no entry for Z_ORVANTA_MAINT_READ/],
    [
      "wrong helper name",
      { ...selfDescribed(target), helper: "Z_ORVANTA_OPS_READ" },
      /helper: expected "Z_ORVANTA_MAINT_READ", reported "Z_ORVANTA_OPS_READ"/
    ],
    [
      "self-described with a null sourceHash",
      { ...selfDescribed(target), sourceHash: null },
      /sourceHash: expected "[0-9a-f]{64}", reported null/
    ],
    [
      "operation list mismatch",
      {
        ...selfDescribed(target),
        operations: [{ opcode: "LOCK_SEARCH", since: "1.0", write: false }]
      },
      /operations: expected .*UPDATE_DETAIL/
    ],
    [
      "operation mode mismatch",
      {
        ...selfDescribed(target),
        operations: selfDescribed(target).operations.map((operation: any) =>
          operation.opcode === "UPDATE_DETAIL" ? { ...operation, write: true } : operation
        )
      },
      /operations: expected/
    ],
    [
      "protocol range mismatch (MIN)",
      { ...selfDescribed(target), minProtocol: "0.9" },
      /minProtocol: expected "1.0", reported "0.9"/
    ],
    [
      "protocol range mismatch (MAX)",
      { ...selfDescribed(target), maxProtocol: "2.0" },
      /maxProtocol: expected "1.0", reported "2.0"/
    ],
    [
      "hash mismatch",
      { ...selfDescribed(target), sourceHash: "0".repeat(64) },
      /sourceHash: expected "[0-9a-f]{64}", reported "0{64}"/
    ],
    [
      "package mismatch",
      { ...selfDescribed(target), packageName: "ZOTHER" },
      /packageName: expected "ZABAP", reported "ZOTHER"/
    ],
    [
      "transport mismatch (the combined rendered row)",
      { ...selfDescribed(target), transport: "GR2K923472|GR2K923473" },
      /transport: expected "GR2K923472", reported "GR2K923472\|GR2K923473"/
    ],
    [
      "transport mismatch (a foreign request)",
      { ...selfDescribed(target), transport: "GR2K999999" },
      /transport: expected "GR2K923472", reported "GR2K999999"/
    ],
    [
      "transport absent",
      { ...selfDescribed(target), transport: null },
      /transport: expected "GR2K923472", reported null/
    ],
    [
      "foreign identity",
      dynproAttestation,
      /helper: expected "Z_ORVANTA_MAINT_READ", reported "Z_ORVANTA_MCP_DYNPRO_API"/
    ]
  ]
  for (const [label, attestation, pattern] of cases) {
    const result = compareHelperAttestation(attestation, expected)
    assert.equal(result.ok, false, `${label}: must not be accepted`)
    assert.ok(
      result.mismatches.some((line: string) => pattern.test(line)),
      `${label}: expected a mismatch matching ${pattern}, got ${JSON.stringify(result.mismatches)}`
    )
  }
  // The report exposes no transport task field at all, so its absence must never be a mismatch -
  // and a fabricated one must not be compared against the task either.
  assert.equal(
    compareHelperAttestation({ ...selfDescribed(target), transportTask: "GR2K999999" }, expected)
      .ok,
    true
  )
})

test("the recomputed digest equals the digest both generators embedded", () => {
  for (const target of Object.values(targets) as any[]) {
    const body = target.generatorBody
    assert.equal(
      capabilityBodyDigest(body),
      digests[target.target],
      `${target.helper}: recomputed digest`
    )
    // The digest is written into the four slots of the rendered body itself.
    assert.equal(
      capabilityHashSlotGroups(body).join(""),
      digests[target.target],
      `${target.helper}: embedded SOURCE|HASH`
    )
    // And it is deliberately not the body hash the deploy scripts pin.
    assert.notEqual(
      digests[target.target],
      target.intendedBodyHash,
      `${target.helper}: the restored digest cannot equal the rendered body hash`
    )
  }
  assert.equal(digests.maint, "69f20bb0907f0a508b14efc3609695d959d8c6c4f9f89026f22586733fc2a066")
  assert.equal(digests.ops, "0781c11ded0de139c633066b1e4774f15e9b782053162aad984b78f0b7877ce1")
})

test("both generators are pinned to their verified pre- and post-deployment bodies", () => {
  const maint: any = targets.maint
  const ops: any = targets.ops
  assert.equal(maint.helper, maintModule.maintenanceHelperDefinition.functionName)
  assert.equal(ops.helper, opsModule.operationalLogFunctionName)
  assert.equal(maint.functionGroup, maintModule.maintenanceHelperDefinition.functionGroup)
  assert.equal(maint.packageName, maintModule.maintenanceDiagnosticDeployment.packageName)
  assert.equal(maint.transportRequest, maintModule.maintenanceDiagnosticDeployment.transportRequest)
  assert.equal(maint.transportTask, maintModule.maintenanceDiagnosticDeployment.transportTask)
  assert.equal(ops.packageName, opsModule.operationalLogDeployment.packageName)
  assert.equal(ops.transportRequest, opsModule.operationalLogDeployment.transportRequest)
  assert.equal(ops.transportTask, opsModule.operationalLogDeployment.transportTask)
  // The generator exports are body-only: they must be hashed directly, never through
  // functionModuleBody, which requires the live `ENDFUNCTION.` wrapper.
  assert.equal(bodyLinesHash(maint.generatorBody), maint.intendedBodyHash)
  assert.equal(bodyLinesHash(ops.generatorBody), ops.intendedBodyHash)
  // The same digest must come out of a LIVE-shaped source: interface heading, the generator body,
  // a trailing blank line and `ENDFUNCTION.`. This pair is what makes the live comparison in
  // scripts/verify-helper-deployment.mjs trustworthy.
  for (const target of [maint, ops]) {
    assert.equal(
      functionModuleBodyHash(liveSourceFor(target).join("\n")),
      target.intendedBodyHash,
      `${target.helper}: live-shaped source must hash to the intended body hash`
    )
  }
  assert.equal(
    maint.deployedNowBodyHash,
    "f2a1580c9ab7560d882af51d6c9152933248c0d51026ac56024417d540b763be"
  )
  assert.equal(
    maint.intendedBodyHash,
    "4f373280253d2287193cec1b9a16def6e7f41fdc21c95b3e4790f274533c7a0a"
  )
  assert.equal(
    ops.deployedNowBodyHash,
    "6cd998bf1e80e61e5d3c20ea416997a3310cc20611919134fe779149b95210ea"
  )
  assert.equal(
    ops.intendedBodyHash,
    "dd6975b1bdbe5cad935d0490fef21966919604c7435cf00da8639efd36bcaf6c"
  )
  // The verifier's expectation must equal the table the generator exports, including the
  // feature-gated REPORT_PARAMETERS row that only the report variant compiles in.
  assert.deepEqual(maint.expectedOperations, [
    "OPERATION|LOCK_SEARCH|1.0|R",
    "OPERATION|UPDATE_SEARCH|1.0|R",
    "OPERATION|UPDATE_DETAIL|1.0|R"
  ])
  assert.deepEqual(ops.expectedOperations, [
    "OPERATION|JOB_SPOOL|1.0|R",
    "OPERATION|JOB_DETAILS|1.0|R",
    "OPERATION|JOB_LOG|1.0|R",
    "OPERATION|JOB_SEARCH|1.0|R",
    "OPERATION|SYSTEM_READ|1.0|R",
    "OPERATION|REPORT_PARAMETERS|1.0|R"
  ])
  for (const target of [maint, ops]) {
    assert.equal(target.expectedProtocol.min, "1.0")
    assert.equal(target.expectedProtocol.max, "1.0")
  }
})

test("PROTOCOL|MIN/MAX and the operation list match the generator tables", async () => {
  const sliceBetween = (source: string, start: string, end: string) => {
    const from = source.indexOf(start)
    assert.ok(from >= 0, `missing anchor: ${start}`)
    const to = source.indexOf(end, from + start.length)
    assert.ok(to > from, `missing anchor: ${end}`)
    return source.slice(from + start.length, to)
  }
  const readTable = (source: string) =>
    [
      ...sliceBetween(
        source,
        "// >>> ORVANTA-CAPABILITY-TABLE",
        "// <<< ORVANTA-CAPABILITY-TABLE"
      ).matchAll(
        /opcode: "([A-Z0-9_]+)",\s*since: "(\d+\.\d+)",\s*mode: "([RW])"(?:,\s*requires: "([a-z]+)")?/g
      )
    ].map((match) => ({
      opcode: String(match[1]),
      since: String(match[2]),
      mode: String(match[3])
    }))
  const maintTable = readTable(await readFile(maintFile, "utf8"))
  const opsTable = readTable(await readFile(opsFile, "utf8"))
  const expectedRows = (table: Array<{ opcode: string; since: string; mode: string }>) =>
    table.map((entry) => `OPERATION|${entry.opcode}|${entry.since}|${entry.mode}`)
  assert.deepEqual(targets.maint.expectedOperations, expectedRows(maintTable))
  assert.deepEqual(targets.ops.expectedOperations, expectedRows(opsTable))
  for (const [table, expected] of [
    [maintTable, targets.maint.expectedProtocol],
    [opsTable, targets.ops.expectedProtocol]
  ] as Array<[Array<{ since: string }>, { min: string; max: string }]>) {
    const versions = table.map((entry) => entry.since).sort(compareProtocolVersions)
    assert.equal(expected.min, versions[0])
    assert.equal(expected.max, versions.at(-1))
  }
  // The generator's exported table is the same list the evidence table publishes, so a new opcode
  // cannot reach SAP while the verifier keeps checking a stale list.
  assert.deepEqual(
    maintModule.maintenanceDiagnosticOperations.map((entry: any) => entry.opcode),
    targets.maint.expectedOperations.map((row: string) => row.split("|")[1])
  )
  assert.deepEqual(
    opsModule.operationalLogOperations.map((entry: any) => entry.opcode),
    targets.ops.expectedOperations.map((row: string) => row.split("|")[1])
  )
})

test("the verifier compares the generator's rendered rows, not the live TADIR assignment", () => {
  for (const target of [targets.maint, targets.ops] as any[]) {
    const rows = renderedCapabilityRows(target.generatorBody)
    assert.deepEqual(rows[0], `HELPER|${target.helper}`)
    assert.deepEqual(
      rows.filter((row: string) => row.startsWith("PROTOCOL|")),
      [`PROTOCOL|MIN|${target.expectedProtocol.min}`, `PROTOCOL|MAX|${target.expectedProtocol.max}`]
    )
    assert.deepEqual(
      rows.filter((row: string) => row.startsWith("OPERATION|")),
      target.expectedOperations
    )
    assert.deepEqual(
      rows.filter((row: string) => row.startsWith("SOURCE|PACKAGE|")),
      [`SOURCE|PACKAGE|${target.packageName}`]
    )
    assert.deepEqual(
      rows.filter((row: string) => row.startsWith("SOURCE|TRANSPORT|")),
      [`SOURCE|TRANSPORT|${target.transportRequest}|${target.transportTask}`]
    )
    // The published provenance IS the request the upgrade travels under: the old request was
    // released, so keeping its number in the row would name a request that does not carry this
    // version. The verifier asserts the same pair against the live TADIR read-back.
    assert.equal(target.transportRequest, "GR2K923472")
    assert.equal(target.transportTask, "GR2K923473")
  }
})

test("the post-deployment body check accepts the generator body for both targets", () => {
  for (const target of [targets.maint, targets.ops] as any[]) {
    const expected = {
      helper: target.helper,
      generatorBody: target.generatorBody,
      sourceHashDigest: digests[target.target]
    }
    const check = verifyDeployedBody(liveSourceFor(target), expected)
    assert.equal(check.liveBodyDigest, digests[target.target])
    assert.equal(check.liveBodyHash, target.intendedBodyHash)
    assert.equal(check.injectedDigestIsNotTheBodyHash, true)
  }
})

test("the post-deployment body check rejects a drifted live body", () => {
  const target = targets.maint
  const expected = {
    helper: target.helper,
    generatorBody: target.generatorBody,
    sourceHashDigest: digests.maint
  }
  const drifted = liveSourceFor(target)
  drifted.splice(drifted.indexOf("ENDFUNCTION."), 0, "  APPEND 'DRIFT' TO lt_capability.")
  assert.throws(
    () => verifyDeployedBody(drifted, expected),
    /line count differs from the generator|live body differs from the generator/
  )
  // Tampering with an injected hash group changes the rendered body itself, so the identity
  // comparison rejects it first; the digest comparison behind it is the extra guard for a body
  // that is still line-identical but no longer reproduces the generator-injected SOURCE|HASH
  // (for example after a placeholder-scheme change).
  const tamperedHash = liveSourceFor(target).map((line: string) =>
    line.includes("'SOURCE|HASH|'") ? line.replace(/'[0-9a-f]{16}'/, `'${"f".repeat(16)}'`) : line
  )
  assert.throws(
    () => verifyDeployedBody(tamperedHash, expected),
    /live body lines are not the generator body|live body differs from the generator|does not match the generator digest/
  )
})

test("the evidence file is created under a new timestamped name and never overwritten", async () => {
  const { mkdtemp, readFile: read } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const directory = await mkdtemp(join(tmpdir(), "orvanta-capabilities-"))
  const path = join(directory, "nested", "helper-capabilities-evidence")
  const first = await writeCapabilitiesEvidence(path, { helper: "Z_ORVANTA_MAINT_READ", n: 1 })
  const second = await writeCapabilitiesEvidence(path, { helper: "Z_ORVANTA_MAINT_READ", n: 2 })
  assert.notEqual(first, second, "a second record must get a new file name")
  assert.deepEqual(JSON.parse(await read(first, "utf8")).records, [
    { helper: "Z_ORVANTA_MAINT_READ", n: 1 }
  ])
  assert.deepEqual(JSON.parse(await read(second, "utf8")).records, [
    { helper: "Z_ORVANTA_MAINT_READ", n: 2 }
  ])
  await writeCapabilitiesEvidence(path, { helper: "Z_ORVANTA_MAINT_READ", n: 3 })
  assert.deepEqual(JSON.parse(await read(first, "utf8")).records, [
    { helper: "Z_ORVANTA_MAINT_READ", n: 1 }
  ])
})

test("the evidence module stays a standalone deployment-side module", async () => {
  const source = await readFile(evidenceFile, "utf8")
  assert.doesNotMatch(source, /from "\.\.\/(?:src|dist)\//, "must not import from src/ or dist/")
  assert.match(source, /from "\.\/maintenance-diagnostic-source\.mjs"/)
  assert.match(source, /from "\.\/operational-log-source\.mjs"/)
  // The service owns the payload parser; this module must not grow a second one, and it must not
  // probe SAP itself. The docstring may name the service parser it defers to, but no import,
  // call or HTTP client may appear here.
  assert.doesNotMatch(source, /import[\s\S]{0,200}parseHelperCapabilitiesPayload/)
  assert.doesNotMatch(source, /import[\s\S]{0,200}decodeJsonHelperCapabilitiesReply/)
  assert.doesNotMatch(source, /callTool|new Client|StreamableHTTPClientTransport/)
  assert.doesNotMatch(source, /export (async )?function collectHelperCapabilities/)
})

test("the verifier reads the self-description from the read-only capability report", async () => {
  const source = await readFile(verifierFile, "utf8")
  // Only read-only tools may be called: no repository write, activation or transport call.
  const called = [...source.matchAll(/call\("([a-z_]+)"/g)].map((match: any) => String(match[1]))
  const allowed = new Set([
    "get_capability_report",
    "inspect_repository_assignment",
    "read_function_module_interface"
  ])
  assert.deepEqual(
    [...new Set(called)].filter((name) => !allowed.has(name)),
    [],
    "the verifier may only call read-only tools"
  )
  for (const tool of allowed) assert.ok(called.includes(tool), `${tool} must be called`)
  assert.doesNotMatch(source, /replace_string_in_abap_object|patch_function_module_interface/)
  assert.doesNotMatch(source, /abap_activate|release_transport/)
  // The probe that cannot express the reply contract must not come back as a call.
  assert.doesNotMatch(source, /"test_remote_function_module"/)
  assert.doesNotMatch(source, /collectHelperCapabilities\(/)
  assert.match(source, /sapWritesInvoked/)
  // The endpoint is selectable, defaulting to the historical local port.
  assert.match(source, /--endpoint/)
  assert.match(source, /ABAP_MCP_ENDPOINT/)
  assert.match(source, /http:\/\/127\.0\.0\.1:4847\/mcp/)
})

test("planReplacement sends the smallest text that turns the live body into the generated body", () => {
  const body = targets.maint.generatorBody as string[]
  // A synthetic live body: the generated body with exactly one line replaced, so the bounded window
  // and the four lines of context either side are both exercised.
  const live = [...body]
  live[10] = '  "a statement that only the previous deployment has"'
  const source = ["FUNCTION Z_X.", ...live, "", "ENDFUNCTION."].join("\n")
  const plan = planReplacement(live.join("\n"), body.join("\n"))

  assert.equal(
    source.split(plan.oldString).length - 1,
    1,
    "the replacement must occur exactly once in the source it is applied to"
  )
  assert.equal(
    source.replace(plan.oldString, plan.newString),
    ["FUNCTION Z_X.", ...body, "", "ENDFUNCTION."].join("\n"),
    "applying the plan must reproduce the generated body exactly"
  )
  // One changed line. The window is that line plus context, never the whole body.
  assert.equal(plan.replacedLines, 9)
  assert.equal(plan.contextLines.begin, 6)
  assert.ok(
    plan.oldString.split("\n").length < body.length,
    "a one-line change must not degrade into a whole-body replacement"
  )
})

test("an unchanged body plans a no-op, so the baseline check must be the gate that stops a write", () => {
  const body = targets.ops.generatorBody.join("\n")
  const plan = planReplacement(body, body)
  assert.equal(plan.oldString, plan.newString)
  assert.equal(plan.replacedLines, 4)
})

test("importing the live scripts never runs them against someone else's command line", async () => {
  // The regression this guards: the deployment step imported the verifier, whose argument
  // validation ran at import time and rejected the deploying process's own flags. Both modules must
  // therefore import cleanly while the importing process carries a foreign command line, and the
  // cache-busting query forces a fresh instantiation rather than a cached one.
  const savedArgv = process.argv
  const savedExitCode = process.exitCode
  process.argv = [...savedArgv, "--apply-approved", "--target", "ops", "stray-positional"]
  try {
    const deployFile = "scripts/deploy-helper-capabilities.mjs"
    const stamp = String(Date.now())
    const deploy = await import(`${pathToFileURL(resolve(deployFile)).href}?probe=${stamp}`)
    const verifier = await import(`${pathToFileURL(resolve(verifierFile)).href}?probe=${stamp}`)
    assert.equal(typeof deploy, "object")
    assert.equal(typeof verifier, "object")
    assert.equal(
      process.exitCode,
      savedExitCode,
      "importing a live script must not set an exit code"
    )
  } finally {
    process.argv = savedArgv
  }
})

test("the deployment step performs no write of its own before the single approved replacement", async () => {
  const source = await readFile(resolve("scripts/deploy-helper-capabilities.mjs"), "utf8")
  // Exactly one mutating call, and it is the narrow source replacement.
  const writes =
    source.match(
      /replace_string_in_abap_object|patch_[a-z_]*|abap_activate|create_object[a-z_]*/g
    ) ?? []
  assert.deepEqual([...new Set(writes)], ["replace_string_in_abap_object"])
  // No release, delete or transport mutation may appear at all.
  assert.doesNotMatch(source, /release_transport|delete_object|release_task/i)
  // The reads that establish the target before the write must be present.
  for (const tool of [
    "read_function_module_interface",
    "inspect_repository_assignment",
    "get_abap_object_lines"
  ]) {
    assert.match(
      source,
      new RegExp(`"${tool}"`),
      `${tool} must be part of the read-before-write path`
    )
  }
})

test("an object with no open transport assignment is refused before any write", () => {
  const target = evidenceModule.helperCapabilityTargets.maint
  const refusal = (assignment: unknown) => {
    try {
      evidenceModule.assertOpenAssignment(assignment, target)
      return null
    } catch (error) {
      return (error as Error).message
    }
  }

  // SAP validates the edit lock against the object's own open assignment, so an unassigned object is
  // refused as "not locked" only after the lock call has already returned a handle. The message has to
  // name the object, the request/task and where to do it, and link back to that failure.
  const unassigned = refusal({
    objectName: target.helper,
    parentObject: "ZORVANTA_MAINT",
    requestNumber: "",
    taskNumber: ""
  })
  assert.ok(unassigned, "an unassigned object must be refused")
  assert.match(unassigned, /Z_ORVANTA_MAINT_READ/)
  assert.match(unassigned, /FUGR ZORVANTA_MAINT/, "must name the object to assign")
  assert.match(unassigned, /GR2K923472/, "must name the request")
  assert.match(unassigned, /GR2K923473/, "must name the task")
  assert.match(unassigned, /SE01\/SE09/, "must name where to make the assignment")
  assert.match(unassigned, /423/, "must link to the failure it prevents")
  assert.doesNotMatch(unassigned, /undefined/, "no field may be interpolated as undefined")

  assert.deepEqual(
    evidenceModule.assertOpenAssignment({ requestNumber: "GR2K923472", taskNumber: "" }, target),
    { request: "GR2K923472", task: "" },
    "an assignment naming only the request is enough"
  )
  assert.deepEqual(
    evidenceModule.assertOpenAssignment({ requestNumber: "", taskNumber: "GR2K923473" }, target),
    { request: "", task: "GR2K923473" },
    "an assignment naming only the task is enough"
  )

  const missing = refusal(undefined)
  assert.equal(typeof missing, "string", "a failed read-back must be refused")
  assert.match(String(missing), /no repository assignment was read back/)
  assert.doesNotMatch(
    String(missing),
    /FUGR/,
    "a failed read-back is not the same as an unassigned object"
  )
})

test("the deploy script consults the assignment before it writes or captures a pre-image", async () => {
  const source = await readFile(resolve("scripts/deploy-helper-capabilities.mjs"), "utf8")
  const guard = source.indexOf("assertOpenAssignment(beforeAssignment, target)")
  const preImage = source.indexOf("rollback-${new Date()")
  // The invocation, not the availability probe near the top of the file.
  const write = source.indexOf('call("replace_string_in_abap_object"')
  assert.match(source, /assertOpenAssignment,/, "the guard must be imported")
  assert.ok(guard > 0, "the deploy script must consult the assignment")
  assert.ok(preImage > 0, "the pre-image capture must still be present")
  assert.ok(write > 0, "the write call must still be present")
  assert.ok(guard < preImage, "the assignment must be checked before a pre-image is captured")
  assert.ok(guard < write, "the assignment must be checked before the write")
})
