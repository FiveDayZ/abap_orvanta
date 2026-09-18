// Read-only verifier for the CAPABILITIES upgrade of Z_ORVANTA_MAINT_READ / Z_ORVANTA_OPS_READ.
//
// docs/helper-capabilities-protocol.md 3.3 requires a deployment to call CAPABILITIES before and
// after the change and to record `SOURCE|HASH` as deployment evidence. This script performs no
// write of any kind - no repository write, no activation, no transport release - so it needs no
// `--apply-approved` gate; it reads SAP through read-only MCP tools only and writes a local
// evidence JSON file.
//
//   node scripts/verify-helper-deployment.mjs [--target maint|ops] [--endpoint <url>]
//       Pre-deployment half: the live body must still be the pre-CAPABILITIES generator output
//       ("stop without retry" guard) and the helper must not be self-described yet.
//
//   node scripts/verify-helper-deployment.mjs --target ops --expect-deployed-capabilities
//       Post-deployment half: the live body must be the intended generator output and the
//       helper's attestation must match the generator (protocol range, operation rows, package,
//       transport and the generator-injected SOURCE|HASH digest).
//
// `--endpoint` (or `ABAP_MCP_ENDPOINT`) selects the MCP endpoint and defaults to
// http://127.0.0.1:4847/mcp. Point it at the build that is actually being upgraded: a report from
// a build that predates the five-entry attestation list cannot be evidence about this upgrade.
//
// The self-description is read through `get_capability_report`, the service's own read-only
// report: it probes the helper and returns the parsed verdict as `helperAttestation`, with
// `safety.sapWritesInvoked === false`. Calling the helper's `CAPABILITIES` action directly through
// `test_remote_function_module` is not viable - that tool demands an exact output expectation
// (src/tools.ts `assertExpectedRemoteOutputs`), and a CAPABILITIES reply carries the helper's
// host, time and self-referential digest, so no exact expectation can exist.
//
// The digest comparison is calibrated by construction: the four ORVANTAHASHSLOT1..4 placeholders
// make SOURCE|HASH self-referential, so `capabilityBodyDigest` restores them and re-hashes
// exactly like scripts/*-source.mjs did while generating, which reproduces the injected digest.
// That digest is NOT the body hash recorded below: the injected digest is part of the rendered
// body, so the two values necessarily differ. test/helper-capabilities-evidence.test.ts asserts
// this calibration against the digest each generator embedded in its own rendered body.
import assert from "node:assert/strict"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  bodyLinesHash,
  capabilityBodyDigest,
  compareHelperAttestation,
  functionModuleBody,
  functionModuleBodyHash,
  helperCapabilityDigests,
  helperCapabilityTargets,
  readHelperAttestation,
  renderedCapabilityRows,
  verifyDeployedBody,
  writeCapabilitiesEvidence
} from "./helper-capabilities-evidence.mjs"

const argv = process.argv.slice(2)
const expectDeployedCapabilities = argv.includes("--expect-deployed-capabilities")
const argumentValue = (flag) => {
  const index = argv.indexOf(flag)
  return index >= 0 ? (argv[index + 1] ?? "") : null
}
const targetName = argumentValue("--target") ?? "maint"
// The endpoint must be selectable: another build may answer on another port, and a report from a
// build that predates the five-entry attestation list is not evidence about this upgrade.
const endpoint =
  argumentValue("--endpoint") ?? process.env.ABAP_MCP_ENDPOINT ?? "http://127.0.0.1:4847/mcp"
const valuedFlags = new Set(["--target", "--endpoint"])
const flagFlags = new Set(["--expect-deployed-capabilities"])
assert.ok(
  argv.every(
    (arg, index) =>
      flagFlags.has(arg) || valuedFlags.has(arg) || (index > 0 && valuedFlags.has(argv[index - 1]))
  ),
  `Unsupported argument: ${argv.filter((arg) => arg.startsWith("--") && !flagFlags.has(arg) && !valuedFlags.has(arg)).join(", ")}`
)
assert.ok(
  endpoint.startsWith("http://") || endpoint.startsWith("https://"),
  `--endpoint must be an absolute HTTP(S) URL, received ${endpoint || "EMPTY"}`
)
const target = helperCapabilityTargets[targetName]
assert.ok(target, `--target must be maint or ops, received ${targetName || "EMPTY"}`)
const generatorDigest = helperCapabilityDigests[targetName]
assert.ok(generatorDigest, `${targetName}: generator digest is unavailable`)
// The generator exports are body-only (they carry no `ENDFUNCTION.` wrapper), so they are hashed
// directly; only a live function module source may go through `functionModuleBodyHash`.
assert.equal(
  bodyLinesHash(target.generatorBody),
  target.intendedBodyHash,
  `${target.helper}: the local generator no longer renders the intended body; recalibrate before verifying SAP`
)
// The authority for the post-deployment comparison: the rows the generator itself renders.
const renderedRows = renderedCapabilityRows(target.generatorBody)
const comparisonTarget = {
  helper: target.helper,
  expectedProtocol: target.expectedProtocol,
  expectedOperations: target.expectedOperations,
  packageName: target.packageName,
  transportRequest: target.transportRequest,
  transportTask: target.transportTask,
  sourceHashDigest: generatorDigest
}

const connectionId = "w200"
const evidencePath = resolve("../.doc/helper-capabilities-evidence")
const evidence = {
  startedAt: new Date().toISOString(),
  mode: expectDeployedCapabilities
    ? "expect-deployed-capabilities"
    : "expect-pre-deployment-baseline",
  target: targetName,
  helper: target.helper,
  connectionId,
  writesInvoked: false,
  generator: {
    intendedBodyHash: target.intendedBodyHash,
    deployedNowBodyHash: target.deployedNowBodyHash,
    sourceHashDigest: generatorDigest,
    expectedProtocol: target.expectedProtocol,
    expectedOperations: target.expectedOperations,
    renderedRows
  },
  // The generator renders its own provenance into SOURCE|TRANSPORT, and for these two targets that
  // row names the request and task the upgrade itself travels under, so the live TADIR read-back
  // must agree with it. Both facts are recorded; the agreement is asserted in the post-deployment
  // mode.
  deploymentProvenance: {
    renderedByGenerator: {
      packageName: target.packageName,
      transportRequest: target.transportRequest,
      transportTask: target.transportTask
    },
    liveTadirAssignment: null,
    // The capability report exposes a single transport value (the rendered row's request field)
    // and no task field, so only the rendered request is compared with the self-description.
    compared: "renderedByGenerator.transportRequest"
  },
  steps: []
}
const client = new Client({ name: "orvanta-helper-capabilities-verifier", version: "1" })

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })
  const text = (result.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
  if (result.isError) throw new Error(`${name}: ${text}`)
  return text
}

const definitionOf = async () =>
  JSON.parse(
    await call("read_function_module_interface", {
      connectionId,
      functionName: target.helper,
      includeExecutionSupport: false
    })
  )

async function capabilityReport() {
  const report = JSON.parse(await call("get_capability_report", { connectionId }))
  assert.equal(report?.readOnly, true, "the capability report must be marked read-only")
  assert.equal(
    report?.safety?.sapWritesInvoked,
    false,
    "the capability report must not have invoked an SAP write"
  )
  const safety = report.safety ?? {}
  for (const key of ["sapLocksCleared", "automaticWriteRetry", "automaticRollbackClaimed"])
    assert.equal(safety[key], false, `capability report safety.${key} must be false`)
  return report
}

// The live body is the same slice the deploy scripts pin: the DATA declarations through the last
// body statement, hashed after joining with "\n" (never with a trailing newline).
const bodyHashOf = (source) => functionModuleBodyHash(source.join("\n"))

async function verifyDefinition() {
  const definition = await definitionOf()
  assert.equal(
    definition.functionName,
    target.helper,
    `read_function_module_interface returned ${definition.functionName}`
  )
  assert.equal(
    definition.functionGroup,
    target.functionGroup,
    `${target.helper} must stay in function group ${target.functionGroup}`
  )
  assert.equal(definition.remoteEnabled, true, `${target.helper} must stay remote-enabled`)
  assert.equal(definition.updateTask, false, `${target.helper} must not be an update-task module`)
  const bodyHash = bodyHashOf(definition.source)
  const assignment = JSON.parse(
    await call("inspect_repository_assignment", {
      connectionId,
      objectName: target.helper,
      objectType: "FUGR/FF"
    })
  )
  assert.equal(
    assignment.parentObject,
    target.functionGroup,
    `${target.helper} must be assigned to ${target.functionGroup}`
  )
  assert.equal(
    assignment.packageName,
    target.packageName,
    `${target.helper} must be assigned to package ${target.packageName}`
  )
  // The live TADIR assignment is recorded here; the post-deployment mode asserts it against the
  // generator's rendered provenance, because for these two targets the published request and task
  // ARE the pair the upgrade travels under. The pre-deployment baseline asserts nothing about it:
  // those objects currently carry no open request at all.
  evidence.deploymentProvenance.liveTadirAssignment = {
    requestNumber: assignment.requestNumber,
    taskNumber: assignment.taskNumber,
    transportStatus: assignment.transportStatus,
    divergesFromRenderedRow:
      `${assignment.requestNumber}|${assignment.taskNumber}` !==
      `${target.transportRequest}|${target.transportTask}`
  }
  assert.equal(assignment.active, true, `${target.helper} must be active`)
  evidence.definition = {
    functionGroup: definition.functionGroup,
    remoteEnabled: definition.remoteEnabled,
    updateTask: definition.updateTask,
    sourceFingerprint: definition.sourceFingerprint,
    interfaceFingerprint: definition.interfaceFingerprint,
    lineCount: definition.source.length,
    bodyHash,
    bodyLines: functionModuleBody(definition.source.join("\n")).length
  }
  evidence.assignment = assignment
  return { definition, bodyHash }
}

function assertProtocolAndOperations(attestation) {
  const prefix = (row, fields) => row.startsWith(`${fields}|`)
  const single = (fields) => {
    const matches = renderedRows.filter((row) => prefix(row, fields))
    assert.equal(matches.length, 1, `${target.helper}: generator must render one ${fields} row`)
    return matches[0]
  }
  const protocolMin = single("PROTOCOL|MIN")
  const protocolMax = single("PROTOCOL|MAX")
  assert.equal(
    protocolMin,
    `PROTOCOL|MIN|${target.expectedProtocol.min}`,
    `${target.helper}: generator PROTOCOL|MIN row`
  )
  assert.equal(
    protocolMax,
    `PROTOCOL|MAX|${target.expectedProtocol.max}`,
    `${target.helper}: generator PROTOCOL|MAX row`
  )
  assert.equal(
    attestation.minProtocol,
    target.expectedProtocol.min,
    `${target.helper} PROTOCOL|MIN must be ${target.expectedProtocol.min}`
  )
  assert.equal(
    attestation.maxProtocol,
    target.expectedProtocol.max,
    `${target.helper} PROTOCOL|MAX must be ${target.expectedProtocol.max}`
  )
  const renderedOperations = renderedRows.filter((row) => prefix(row, "OPERATION")).sort()
  const reportedOperations = (attestation.operations ?? [])
    .map(
      (operation) =>
        `OPERATION|${operation.opcode}|${operation.since}|${operation.write ? "W" : "R"}`
    )
    .sort()
  assert.deepEqual(
    reportedOperations,
    renderedOperations,
    `${target.helper} OPERATION rows must match the generator table`
  )
  const packageName = single("SOURCE|PACKAGE").split("|")[2]
  const transport = single("SOURCE|TRANSPORT").split("|").slice(2).join("|")
  assert.equal(
    attestation.packageName,
    packageName,
    `${target.helper} SOURCE|PACKAGE must be ${packageName}`
  )
  assert.equal(
    attestation.transport,
    target.transportRequest,
    `${target.helper} SOURCE|TRANSPORT must report the rendered request ${target.transportRequest}`
  )
  // Provenance: the rendered row is what was compared above; the live TADIR assignment is
  // recorded separately and may legitimately differ.
  assert.equal(transport, `${target.transportRequest}|${target.transportTask}`)
  evidence.provenanceComparison = {
    renderedPackage: packageName,
    renderedTransport: transport,
    reportedPackage: attestation.packageName,
    reportedTransport: attestation.transport,
    liveTadirRequest: evidence.deploymentProvenance.liveTadirAssignment?.requestNumber ?? null,
    upgradeRequest: target.transportUpgradeRequest
  }
}

// The offline suite imports this module for its exported helpers, so the live run must happen only
// when this file is the process entry point. Without the guard an import connects to SAP, writes an
// evidence file and sets a failing exit code for the importing process.
const isEntryPoint =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntryPoint) {
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { timeout: 10000 }))
    evidence.endpoint = endpoint
    const live = await verifyDefinition()
    const report = await capabilityReport()
    const attestation = readHelperAttestation(report, target.helper)
    evidence.capabilityReport = {
      observedAt: report.observedAt ?? null,
      productVersion: report.productVersion ?? null,
      helperAttestationCount: Array.isArray(report.helperAttestation)
        ? report.helperAttestation.length
        : null,
      helperNames: Array.isArray(report.helperAttestation)
        ? report.helperAttestation.map((entry) => entry?.helper ?? null)
        : null,
      readOnly: report.readOnly ?? null,
      safety: report.safety ?? null
    }
    evidence.attestation = attestation
    // A report without an entry for this helper is not evidence about this upgrade: the endpoint
    // may run a build that predates the attestation list, so this must be reported as itself.
    assert.ok(
      attestation,
      `${target.helper} has no helperAttestation entry in the report from ${endpoint}; helperAttestation lists ${JSON.stringify(evidence.capabilityReport.helperNames)}`
    )

    if (expectDeployedCapabilities) {
      assert.equal(
        live.bodyHash,
        target.intendedBodyHash,
        `${target.helper} live body ${live.bodyHash} is not the intended CAPABILITIES body ${target.intendedBodyHash}; stop without retry`
      )
      const comparison = compareHelperAttestation(attestation, comparisonTarget)
      evidence.attestationComparison = comparison
      assert.equal(
        comparison.ok,
        true,
        `${target.helper} attestation does not match the generator: ${comparison.mismatches.join("; ")}`
      )
      assertProtocolAndOperations(attestation)
      // The published provenance must be the live assignment: this is the only place the rendered
      // request/task pair is checked against TADIR instead of against itself.
      assert.equal(
        evidence.deploymentProvenance.liveTadirAssignment.divergesFromRenderedRow,
        false,
        `${target.helper} live TADIR assignment ${evidence.assignment.requestNumber}|${evidence.assignment.taskNumber} is not the published ${target.transportRequest}|${target.transportTask}`
      )
      assert.equal(
        evidence.assignment.transportStatus,
        "D",
        `${target.helper} must stay in a modifiable request, not ${evidence.assignment.transportStatus}`
      )
      // The body half: line-for-line identity with the generator and the generator-injected digest
      // recomputed from the delivered body.
      evidence.sourceHashCheck = verifyDeployedBody(live.definition.source, {
        helper: target.helper,
        generatorBody: target.generatorBody,
        sourceHashDigest: generatorDigest
      })
      evidence.status = "deployed_capabilities_verified_not_runtime_tested"
    } else {
      assert.equal(
        live.bodyHash,
        target.deployedNowBodyHash,
        `${target.helper} live body ${live.bodyHash} is no longer the pre-CAPABILITIES baseline ${target.deployedNowBodyHash}; stop without retry`
      )
      assert.notEqual(
        live.bodyHash,
        target.intendedBodyHash,
        `${target.helper} live body already is the intended CAPABILITIES body; rerun with --expect-deployed-capabilities`
      )
      assert.equal(
        attestation.attestation,
        "operation-scoped",
        `${target.helper} was expected to be un-upgraded, but the report says ${attestation.attestation}`
      )
      assert.equal(
        attestation.sourceHash,
        null,
        `${target.helper} must not report a SOURCE|HASH before the upgrade`
      )
      assert.deepEqual(
        attestation.operations,
        [],
        `${target.helper} must not advertise operations before the upgrade`
      )
      assert.equal(attestation.minProtocol, null)
      assert.equal(attestation.maxProtocol, null)
      evidence.preDeploymentAttestation = {
        attestation: attestation.attestation,
        sourceHash: attestation.sourceHash,
        operations: attestation.operations,
        minProtocol: attestation.minProtocol,
        maxProtocol: attestation.maxProtocol,
        detail: attestation.detail ?? null
      }
      evidence.status = "pre_deployment_baseline_verified"
    }
  } catch (error) {
    evidence.status = "stopped"
    evidence.error = error.message
    process.exitCode = 1
  } finally {
    await client.close().catch(() => {})
    evidence.finishedAt = new Date().toISOString()
    try {
      evidence.path = await writeCapabilitiesEvidence(evidencePath, evidence)
      evidence.evidenceWritten = true
    } catch (error) {
      evidence.evidenceWritten = false
      evidence.evidenceError = error.message
      process.exitCode = 1
    }
    console.log(
      JSON.stringify(
        {
          status: evidence.status,
          mode: evidence.mode,
          helper: evidence.helper,
          endpoint: evidence.endpoint,
          error: evidence.error,
          bodyHash: evidence.definition?.bodyHash,
          attestation: evidence.attestation?.attestation,
          attestationComparison: evidence.attestationComparison,
          sourceHashCheck: evidence.sourceHashCheck,
          writesInvoked: evidence.writesInvoked,
          path: evidence.path,
          evidenceError: evidence.evidenceError
        },
        null,
        2
      )
    )
  }
}
