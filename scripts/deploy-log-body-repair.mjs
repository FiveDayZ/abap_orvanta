import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { applicationLogReadBranch } from "./application-log-read-source.mjs"
import { operationalLogSource } from "./operational-log-source.mjs"

const apply = process.argv.includes("--apply-approved")
const followup = process.argv.includes("--followup-validated-baseline")
const nativeCompatibility = process.argv.includes("--native-compatibility-baseline")
const messageLanguage = process.argv.includes("--message-language-baseline")
const bodyCheck = process.argv.includes("--body-check-baseline")
const nativeParameters = process.argv.includes("--native-parameters-baseline")
const recoverReviewedInactive = process.argv.includes("--recover-reviewed-inactive")
const applicationBodyCheck = process.argv.includes("--application-body-check-baseline")
const jobDetails = process.argv.includes("--job-details-approved-baseline")
if (jobDetails)
  assert.ok(
    !followup &&
      !nativeCompatibility &&
      !messageLanguage &&
      !bodyCheck &&
      !nativeParameters &&
      !recoverReviewedInactive &&
      !applicationBodyCheck,
    "Job-details deployment cannot be combined with another repair scope"
  )
assert.ok(!recoverReviewedInactive || nativeParameters)
const evidence = { startedAt: new Date().toISOString(), apply, steps: [] }
const c = new Client({ name: "m5-log-body-repair", version: "1" })
const connectionId = "w200"
const transportNumber = "GR2K923421"
const targets = [
  {
    name: "Z_ORVANTA_LOG_READ",
    fingerprint: applicationBodyCheck
      ? "01e27d4b28182ff5a69cbb613b34b667337ec395460afb465e44a324748c2c3d"
      : messageLanguage
        ? "8ac669194409aa6b357c40980bf801b2e30581b855ae6c9fe73ac0f58e1f078a"
        : followup
          ? "647bc60c3f5720924b62aa32814919b34bdfe926783761df4dc3da7f822a350d"
          : "2a0bcb0ec2ba85a32014394cfc779ee6455f09def718688a440426ab1560814d",
    newBody: applicationLogReadBranch,
    start: "IF iv_action = 'READ' OR iv_action = 'READ_DIAGNOSTIC'",
    end: "\nIF iv_action <> 'SEARCH'."
  },
  {
    name: "Z_ORVANTA_OPS_READ",
    fingerprint: jobDetails
      ? "371bbcd37ec1d761d563d7f2773a5e43b639fa3e7e0e21b1b7c0d288c1b01005"
      : nativeParameters
        ? "b42450f8d69790a695bcfd1712eeaa30931641a187d57d221bde9aae8844f6c7"
        : bodyCheck
          ? "7dfa85629727c267b6b09c071e32e351323bac889a9e7e8d09ae2818b5d1213f"
          : nativeCompatibility
            ? "83c6056aca1e956777bad01d4ae49aad8a59df3571f4f8f3aebe12e48ec1407f"
            : followup
              ? "8ba29d17d21816ae38ab025f8e7d3b2c18902055ae1603625bbc401e74a1ff67"
              : "89109d111ddfbad2fa43da087fe90f887b1883c774a09f084609d1e2084a1ddc",
    newBody: operationalLogSource.join("\n"),
    start: "DATA: lt_jobs TYPE STANDARD TABLE OF tbtco,",
    end: "\n\nENDFUNCTION."
  }
]
async function call(name, args) {
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 120000 })
  const text = r.content
    ?.filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n")
  if (r.isError) throw new Error(`${name}: ${text}`)
  return text
}
async function definition(name) {
  return JSON.parse(
    await call("read_function_module_interface", { connectionId, functionName: name })
  )
}
function bodyOf(source, target) {
  const start = source.indexOf(target.start)
  assert.ok(start >= 0 && source.indexOf(target.start, start + 1) === -1)
  const end = source.indexOf(target.end, start)
  assert.ok(end > start)
  return source.slice(start, end)
}
function normalizeGeneratedInterfaceHeading(source, target) {
  const start = source.indexOf(target.start)
  assert.ok(start > 0)
  const header = source.slice(0, start).replace(/^\*"\*"本地接口：$/m, '*"*"Local Interface:')
  return header + source.slice(start)
}
try {
  await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:4847/mcp")))
  for (const target of targets) {
    if (jobDetails && target.name !== "Z_ORVANTA_OPS_READ") continue
    if (applicationBodyCheck && target.name !== "Z_ORVANTA_LOG_READ") continue
    if (nativeParameters && target.name !== "Z_ORVANTA_OPS_READ") continue
    if (bodyCheck && target.name !== "Z_ORVANTA_OPS_READ") continue
    if (nativeCompatibility && target.name !== "Z_ORVANTA_OPS_READ") continue
    if (messageLanguage && target.name !== "Z_ORVANTA_LOG_READ") continue
    const before = await definition(target.name)
    assert.equal(
      before.sourceFingerprint,
      target.fingerprint,
      "Active baseline changed; do not rerun"
    )
    if (jobDetails)
      assert.equal(
        before.interfaceFingerprint,
        "bf2aebedb44d7e78f4c9810cca150601f603776426c44c6859482edc3f0d023b",
        "Approved interface baseline changed"
      )
    const assignment = JSON.parse(
      await call("inspect_repository_assignment", {
        connectionId,
        objectName: target.name,
        objectType: "FUGR/FF"
      })
    )
    assert.equal(assignment.packageName, "ZABAP")
    assert.equal(assignment.requestNumber, transportNumber)
    assert.equal(assignment.transportStatus, "D")
    assert.equal(assignment.parentObject, "ZORVANTA_LOG")
    const uriText = await call("get_abap_object_workspace_uri", {
      connectionId,
      objectName: target.name,
      objectType: "FUGR/FF"
    })
    const fileUri = uriText.match(/Workspace URI: (\S+)/)?.[1]
    assert.ok(fileUri)
    const workspace = await call("get_object_by_uri", {
      connectionId,
      uri: fileUri,
      startLine: 0,
      lineCount: 900
    })
    const workspaceSource = workspace
      .match(/```abap\r?\n([\s\S]*?)\r?\n```/)?.[1]
      .replace(/\r\n/g, "\n")
    assert.ok(workspaceSource, "Exact workspace source unavailable")
    const source = before.source.join("\n")
    const oldBody = bodyOf(source, target)
    if (recoverReviewedInactive) {
      assert.equal(target.name, "Z_ORVANTA_OPS_READ")
      const failedBody = target.newBody.replace(
        "CONCATENATE lv_word <job_param>+0(lv_job_length)",
        "CONCATENATE <job_param>+0(lv_job_length)"
      )
      assert.notEqual(failedBody, target.newBody)
      assert.ok(workspaceSource.includes(failedBody), "Unrecognized inactive version")
    } else {
      assert.ok(workspaceSource.includes(oldBody), "Workspace and active body differ")
    }
    const oldLines = oldBody.split("\n")
    const newLines = target.newBody.split("\n")
    let prefix = 0
    while (oldLines[prefix] === newLines[prefix] && prefix < oldLines.length) prefix++
    let suffix = 0
    while (
      suffix < oldLines.length - prefix &&
      oldLines.at(-suffix - 1) === newLines.at(-suffix - 1)
    )
      suffix++
    assert.ok(prefix < oldLines.length, "No change")
    const begin = Math.max(0, prefix - 4)
    const tail = Math.max(0, suffix - 4)
    const oldString = oldLines.slice(begin, oldLines.length - tail).join("\n")
    const newString = newLines.slice(begin, newLines.length - tail).join("\n")
    assert.equal(source.split(oldString).length, 2)
    const step = {
      object: target.name,
      fileUri,
      assignment,
      beforeFingerprint: before.sourceFingerprint,
      interfaceFingerprint: before.interfaceFingerprint,
      oldLines: oldString.split("\n").length,
      newLines: newString.split("\n").length
    }
    evidence.steps.push(step)
    if (!apply) continue
    const operationId = `${jobDetails ? "mvp4-details" : "m5-body"}-${target.name === targets[0].name ? "slg1" : "ops"}-${Date.now()}`
    step.operationId = operationId
    step.writeResult = await call("replace_string_in_abap_object", {
      fileUri,
      transportNumber,
      operationId,
      oldString,
      newString
    })
    console.log(step.writeResult)
    step.diagnostics = await call("get_abap_diagnostics", { fileUri })
    console.log(step.diagnostics)
    const after = await definition(target.name)
    assert.equal(after.interfaceFingerprint, before.interfaceFingerprint)
    const expectedSource = source.replace(oldString, () => newString)
    if (jobDetails)
      assert.equal(
        normalizeGeneratedInterfaceHeading(after.source.join("\n"), target),
        normalizeGeneratedInterfaceHeading(expectedSource, target)
      )
    else assert.equal(after.source.join("\n"), expectedSource)
    step.afterFingerprint = after.sourceFingerprint
    step.lineCount = after.source.length
    step.exactReadback = true
    const postWorkspace = await call("get_object_by_uri", {
      connectionId,
      uri: fileUri,
      startLine: 0,
      lineCount: 900
    })
    assert.ok(postWorkspace.replace(/\r\n/g, "\n").includes(target.newBody))
    step.workspaceReadback = true
    if (!/No.*(errors|issues)|no.*(errors|issues)|没有|无语法/i.test(step.diagnostics))
      throw new Error("Inspect diagnostics before continuing to the next object")
  }
  if (apply)
    evidence.groupDiagnostics = await call("get_abap_diagnostics", {
      fileUri: "adt://w200/sap/bc/adt/functions/groups/zorvanta_log"
    })
  evidence.status = apply ? "deployed_readback_verified" : "preflight_only"
} catch (error) {
  evidence.status = "failed"
  evidence.error = error.message
  process.exitCode = 1
} finally {
  await c.close()
  evidence.finishedAt = new Date().toISOString()
  const path = resolve(
    "../.doc",
    `${jobDetails ? "mvp4-job-details" : "m5-log-body"}-deploy-${Date.now()}.json`
  )
  await writeFile(path, JSON.stringify(evidence, null, 2), { flag: "wx" })
  console.log(JSON.stringify({ ...evidence, path }, null, 2))
}
