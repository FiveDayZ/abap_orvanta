// Deploy the runtime-read variant of Z_ORVANTA_OPS_READ into w200.
//
// This is the next single-use step of the same chain as
// scripts/deploy-log-body-repair.mjs (base), scripts/deploy-job-spool.mjs (spool) and
// scripts/deploy-report-parameters.mjs (report + CAPABILITIES):
//
//   operationalLogReportSource  ->  operationalLogRuntimeSource
//                               or  operationalLogMetricsSource
//
// It is the FIRST step of that chain that also changes the interface. Two variants can be deployed:
//
//   --variant=runtime (default)  all five new opcodes (WP_LIST, USER_LIST, DIR_LIST, DB_ACTIVITY,
//                                PERF_SNAPSHOT). Needs four optional imports:
//                                IV_SERVER / IV_DIR / IV_MASK / IV_PERIOD.
//   --variant=metrics            only DB_ACTIVITY and PERF_SNAPSHOT. Of those four imports the
//                                metrics branches READ only IV_PERIOD - IV_SERVER / IV_DIR /
//                                IV_MASK appear in their guards alone and are never read - so this
//                                variant needs exactly ONE import. It carries the same spool and
//                                report features the deployed body already has, so those opcodes
//                                do not regress, and the three kernel reads report as unsupported
//                                (their opcodes are absent) rather than failing the whole family.
//
// Every one of those parameters is a plain STRINGVAL - a domain-less data element on this system
// whose value contract resolves to dataType STRG - so they carry NO length at the interface level;
// the helper branches validate length themselves.
//
// Nothing here is executed by writing this file. Run it with --apply-approved to write; without
// that flag it only performs the read-only preflight and reports what it would do.
//
//   node scripts/deploy-runtime-reads.mjs                                # preflight, runtime
//   node scripts/deploy-runtime-reads.mjs --variant=metrics              # preflight, metrics
//   node scripts/deploy-runtime-reads.mjs --variant=metrics --apply-approved
//
// After a successful apply, three things must change in the SAME batch or the ops tools regress:
// the two test pins printed at the end, and the ops approval file outside the repository.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  operationalLogDeployment,
  operationalLogMetricsSource,
  operationalLogRuntimeSource
} from "./operational-log-source.mjs"

const args = process.argv.slice(2)
assert.ok(
  args.every((arg) => arg === "--apply-approved" || arg.startsWith("--variant=")),
  "the only accepted arguments are --apply-approved and --variant=runtime|metrics"
)
const variantArgs = args.filter((arg) => arg.startsWith("--variant="))
assert.ok(variantArgs.length <= 1, "at most one --variant= argument is accepted")
const variant = variantArgs[0]?.slice("--variant=".length) ?? "runtime"
assert.ok(
  variant === "runtime" || variant === "metrics",
  `unknown variant ${JSON.stringify(variant)}: expected runtime or metrics`
)
const apply = args.includes("--apply-approved")
const connectionId = "w200"
const functionName = "Z_ORVANTA_OPS_READ"
const functionGroup = "ZORVANTA_LOG"
// Read from the generator rather than repeating them here: it is the published single source.
const { packageName, transportRequest: transportNumber, transportTask } = operationalLogDeployment
const endpoint = process.env.ABAP_MCP_ENDPOINT ?? "http://127.0.0.1:4849/mcp"
const targetSource =
  variant === "metrics" ? operationalLogMetricsSource : operationalLogRuntimeSource
const newBody = targetSource.join("\n")
const hash = (text) => createHash("sha256").update(text).digest("hex")
// The body SAP holds is the runtime variant as deployed on 2026-09-30, and the generator has moved
// on since in any case, so the preflight must not derive it by rendering the generator: that would
// compare SAP against a body nobody ever deployed. It pins the hash of what SAP actually holds and
// takes the replacement anchor from the live source instead. Re-pin this only together with a
// deployment, and only to the body the deployment just wrote - otherwise the preflight stops, which
// is exactly what it did when this still named the report variant. The value below is the 2026-10-01
// deployment (make_time reports validity instead of aborting, and an empty job log answers ok), which
// is what SAP holds right now.
const DEPLOYED_REPORT_BODY_HASH = "d75fae87e309971eb2878010855b54365fe4dc393332a573d1e6df9a0f23829a"
// The live values the ops approval file holds for w200, so the preflight can prove it is looking
// at the body and the interface the approval was granted for. These were stale (they still named
// the pre-2026-09-30 interface), which silently disarmed the guard on the interface-patch path;
// they now name what the approval file actually holds. The source fingerprint must be re-pinned in
// the same batch as the approval file, because a body change always moves it.
const EXPECTED_SOURCE_FINGERPRINT =
  "3a8f3b08b013cbe2b526a6cee7a9394cb173ac4db77073dc34f813d4171b8b8e"
const EXPECTED_INTERFACE_FINGERPRINT =
  "621a136206d005634363036e6beb7a73da3e9dc21ee9fd6fe9e5a8d64d33d784"
// Only the imports this variant's branches actually reference. IV_PERIOD is read by both variants
// (it is the SWNC period type); the other three exist for the kernel reads, and the metrics
// branches name them in a guard alone, so the metrics variant does not need them at all.
const NEW_IMPORTS =
  variant === "metrics" ? ["IV_PERIOD"] : ["IV_SERVER", "IV_DIR", "IV_MASK", "IV_PERIOD"]
// The widest variant is 1701 lines, so the default page size of the older steps would truncate it
// and make the body-equality gate fail for the wrong reason.
const WORKSPACE_LINE_COUNT = 2400
const evidence = {
  startedAt: new Date().toISOString(),
  endpoint,
  apply,
  variant,
  newImports: NEW_IMPORTS,
  calls: []
}
const c = new Client({ name: "approved-runtime-read-deployment", version: "1" })

async function call(name, args) {
  const entry = { name, arguments: args }
  evidence.calls.push(entry)
  const result = await c.callTool({ name, arguments: args }, undefined, { timeout: 180000 })
  entry.result = result
  const text = result.content
    ?.filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n")
  if (result.isError) throw new Error(`${name}: ${text}`)
  return text
}

const definition = async () =>
  JSON.parse(await call("read_function_module_interface", { connectionId, functionName }))

// The generated body is everything from the first DATA line to ENDFUNCTION. Every variant of this
// generator starts with that exact line - buildOperationalLogSource() injects the optional
// declarations after the base DATA block - so this slice is the whole body for the runtime variant
// too, and comparing it against the generator output compares the entire body.
function body(source) {
  const start = source.indexOf("DATA: lt_jobs TYPE STANDARD TABLE OF tbtco,")
  const marker = source.indexOf("ENDFUNCTION.", start)
  assert.ok(
    start > 0 && marker > start,
    "could not slice the generated body out of the live source"
  )
  // SAP's own source ends the body with a single newline before ENDFUNCTION, while the older steps
  // in this chain expected a blank line. Strip trailing newlines instead of pinning either shape.
  return source.slice(start, marker).replace(/\n+$/, "")
}

async function workspace(uri, expected) {
  const text = await call("get_object_by_uri", {
    connectionId,
    uri,
    startLine: 0,
    lineCount: WORKSPACE_LINE_COUNT
  })
  const source = text.match(/```abap\r?\n([\s\S]*?)\r?\n```/)?.[1].replace(/\r\n/g, "\n")
  assert.ok(source, `no abap fence in the workspace read of ${uri}`)
  assert.equal(body(source), expected)
  return source
}

async function diagnostics(uri) {
  const text = await call("get_abap_diagnostics", { fileUri: uri })
  assert.match(text, /No diagnostics found.*no syntax errors or warnings/is)
  return text
}

async function assignment() {
  const result = JSON.parse(
    await call("inspect_repository_assignment", {
      connectionId,
      objectName: functionName,
      objectType: "FUGR/FF"
    })
  )
  assert.equal(result.parentObject, functionGroup)
  assert.equal(result.packageName, packageName)
  assert.equal(result.requestNumber, transportNumber)
  // The task is a sub-unit of the request, and SAP reassigns it whenever the object is saved in
  // SE37: adding the four imports produced GR2K923492 under the same request, while the published
  // task list still names GR2K923473. Pinning one task number therefore stops the deployment for a
  // reason that has nothing to do with the body, so the request number above is the scope gate and
  // the task is recorded against the published value instead of asserted.
  evidence.transportTask = { published: transportTask, observed: result.taskNumber }
  assert.equal(result.transportStatus, "D")
  assert.equal(result.active, true)
  return result
}

// The one helperAttestation entry of the capability report that belongs to this helper. Read-only.
async function attestation() {
  let report
  try {
    report = JSON.parse(await call("get_capability_report", { connectionId }))
  } catch (error) {
    return { error: error.message }
  }
  const entries = Array.isArray(report?.helperAttestation) ? report.helperAttestation : []
  return (
    entries.find((entry) => entry?.helper === functionName) ?? {
      helperNames: entries.map((entry) => entry?.helper ?? null),
      note: `no helperAttestation entry for ${functionName}`
    }
  )
}

const approvalFile = "%LOCALAPPDATA%\\ABAP MCP Standalone\\state\\operational-log-approvals.json"

try {
  await c.connect(new StreamableHTTPClientTransport(new URL(endpoint)), { timeout: 10000 })
  evidence.assignment = await assignment()
  let before = await definition()
  evidence.before = {
    sourceFingerprint: before.sourceFingerprint,
    interfaceFingerprint: before.interfaceFingerprint,
    importParameters: before.importParameters.map((item) => item.name)
  }
  // Read live, not rendered: the live body is both the staleness gate and the replacement anchor.
  const liveBody = body(before.source.join("\n"))
  evidence.bodyFingerprints = {
    live: hash(liveBody),
    frozen: DEPLOYED_REPORT_BODY_HASH,
    intended: hash(newBody)
  }
  assert.equal(
    hash(liveBody),
    DEPLOYED_REPORT_BODY_HASH,
    "SAP does not hold the frozen report variant this deployment was designed against"
  )

  // Whether the interface still needs the four imports. Re-running the script must not duplicate
  // them, so the patch is skipped when all four are already present.
  const present = new Set(before.importParameters.map((item) => item.name))
  const missingImports = NEW_IMPORTS.filter((name) => !present.has(name))
  const needsInterfacePatch = missingImports.length > 0
  evidence.interface = {
    needsPatch: needsInterfacePatch,
    missing: missingImports,
    alreadyPresent: NEW_IMPORTS.filter((name) => present.has(name))
  }
  if (needsInterfacePatch) {
    // Only meaningful while the interface is untouched: that is the state the approval describes.
    assert.equal(before.sourceFingerprint, EXPECTED_SOURCE_FINGERPRINT)
    assert.equal(before.interfaceFingerprint, EXPECTED_INTERFACE_FINGERPRINT)
    // The interface cannot be changed from here on this release. patch_function_module_interface's
    // own contract states the platform limit: on SAP_BASIS 7.31 the helper opcode
    // PATCH_FUNCTION_INTERFACE has no interface-parameter write path - RPY_FUNCTIONMODULE_UPDATE
    // does not exist on this release, and the wide-line alternatives expose RSFB_SOURCE, a
    // function-group-local type no external caller can declare - so the helper only writes
    // parameter documentation and "interface parameters reported as changed must be applied
    // manually in SE37". A measured call on 2026-09-30 returned
    // FUNCTION_READ_FAILED: Locked function could not be read and left SAP byte-identical
    // (.doc/runtime-reads-deploy-1790737794359.json). These imports are therefore a manual SE37
    // step, and the body must not be written before them: its branches reference them, so the
    // function would not activate.
    evidence.manualInterfaceStep = {
      platformLimit: "SAP_BASIS 7.31 exposes no interface-parameter write path",
      variant,
      parameters: NEW_IMPORTS.map((name) => ({
        name,
        typeName: "STRINGVAL",
        optional: true,
        passByValue: true
      })),
      se37Steps: [
        `Open ${functionName} in SE37 (function group ${functionGroup}) in change mode`,
        "Open the Import tab",
        `Add ${NEW_IMPORTS.length} parameter(s), each type STRINGVAL, Optional, Pass by value: ` +
          NEW_IMPORTS.join(", "),
        `Save into the existing request ${transportNumber}`,
        `Re-run this script with --variant=${variant} (without --apply-approved) to confirm they ` +
          "are present"
      ]
    }
    if (apply)
      throw new Error(
        `${functionName} is missing ${missingImports.join(", ")} for variant ${variant}. On ` +
          "SAP_BASIS 7.31 the interface cannot be changed through this service; add " +
          `${NEW_IMPORTS.length} STRINGVAL import(s) in SE37 first, then re-run. The parameters ` +
          "to add are in evidence.manualInterfaceStep."
      )
  }

  const resolved = await call("get_abap_object_workspace_uri", {
    connectionId,
    objectName: functionName,
    objectType: "FUGR/FF"
  })
  const fileUri = resolved.match(/Workspace URI: (\S+)/)?.[1]
  assert.ok(fileUri, "no workspace URI returned")
  evidence.fileUri = fileUri
  await workspace(fileUri, liveBody)

  // Read live rather than pinning: this hash belongs to whatever body SAP holds right now, and the
  // exact body-equality assertion above is the real staleness gate.
  const rawSourceInfo = await call("get_abap_object_lines", {
    connectionId,
    objectName: functionName,
    objectType: "FUNC",
    startLine: 1,
    lineCount: 8
  })
  const editFingerprint = rawSourceInfo.match(/Full Source SHA-256: ([a-f0-9]{64})/)?.[1]
  assert.ok(editFingerprint, "no Full Source SHA-256 in the get_abap_object_lines reply")
  evidence.editFingerprint = editFingerprint

  if (apply) {
    const a = liveBody.split("\n"),
      b = newBody.split("\n")
    let prefix = 0,
      suffix = 0
    while (prefix < a.length && a[prefix] === b[prefix]) prefix++
    while (suffix < a.length - prefix && a.at(-suffix - 1) === b.at(-suffix - 1)) suffix++
    const begin = Math.max(0, prefix - 4),
      tail = Math.max(0, suffix - 4)
    const oldString = a.slice(begin, a.length - tail).join("\n")
    const newString = b.slice(begin, b.length - tail).join("\n")
    const source = await workspace(fileUri, liveBody)
    assert.equal(source.split(oldString).length, 2, "the replacement anchor is not unique")
    evidence.diff = { prefix, suffix, oldLines: oldString.split("\n").length }
    const step = { stage: "body", operationId: `runtime-reads-body-${Date.now()}` }
    ;(evidence.steps ??= []).push(step)
    step.result = await call("replace_string_in_abap_object", {
      fileUri,
      transportNumber,
      operationId: step.operationId,
      expectedSourceFingerprint: editFingerprint,
      oldString,
      newString
    })
    for (const uri of [fileUri, "adt://w200/sap/bc/adt/functions/groups/zorvanta_log"])
      step.diagnostics = await diagnostics(uri)
    const after = await definition()
    assert.equal(body(after.source.join("\n")), newBody, "SAP does not hold the runtime variant")
    await workspace(fileUri, newBody)
    for (const p of before.importParameters)
      assert.deepEqual(
        after.importParameters.find((item) => item.name === p.name),
        p,
        "the body replacement changed an import parameter"
      )
    assert.equal(after.importParameters.length, before.importParameters.length)
    evidence.afterAssignment = await assignment()
    evidence.after = {
      sourceFingerprint: after.sourceFingerprint,
      interfaceFingerprint: after.interfaceFingerprint,
      lineCount: after.source.length,
      bodyHash: hash(newBody)
    }
    evidence.helperAttestation = await attestation()
    evidence.status = "deployed_source_verified_not_runtime_tested"
  } else {
    evidence.helperAttestationBefore = await attestation()
    evidence.status = "preflight_only"
  }
} catch (error) {
  evidence.status = "stopped"
  evidence.error = error.message
  process.exitCode = 1
} finally {
  await c.close()
  evidence.finishedAt = new Date().toISOString()
  const path = resolve("../.doc", `runtime-reads-deploy-${Date.now()}.json`)
  await writeFile(path, JSON.stringify(evidence, null, 2), { flag: "wx" })
  const deployed = evidence.after?.bodyHash ?? null
  console.log(
    JSON.stringify(
      {
        status: evidence.status,
        error: evidence.error,
        endpoint,
        variant,
        newImports: NEW_IMPORTS,
        fileUri: evidence.fileUri,
        interfacePatch: evidence.interface,
        before: evidence.before,
        after: evidence.after,
        helperAttestation: evidence.helperAttestation ?? evidence.helperAttestationBefore,
        evidencePath: path,
        // Same-batch work a successful apply makes mandatory.
        rePin: deployed
          ? {
              "test/helper-capabilities-evidence.test.ts": {
                deployedNowBodyHash: deployed,
                intendedBodyHash: deployed
              },
              "scripts/helper-capabilities-evidence.mjs": {
                deployedNowBodyHash: deployed,
                intendedBodyHash: deployed,
                note: `the variant whose body SAP holds is now the ${variant} variant`
              },
              approvalFile: {
                connectionId,
                sourceFingerprint: evidence.after.sourceFingerprint,
                interfaceFingerprint: evidence.after.interfaceFingerprint,
                enabledSources: ["SM37", "SM37_DETAILS", "SP01", "RUNTIME"]
              },
              followUp: [
                "restart the 4849 instance so the service-side changes take effect",
                "node scripts/verify-helper-deployment.mjs",
                "npm run matrix:generate && npm run ops:matrix:generate",
                "npm run format:check && npm run lint && npm run typecheck && npm run matrix:check && npm run ops:matrix:check && npm test"
              ]
            }
          : null
      },
      null,
      2
    )
  )
}
