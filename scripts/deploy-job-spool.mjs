import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { operationalLogSource, operationalLogSpoolSource } from "./operational-log-source.mjs"

assert.ok(process.argv.slice(2).every((arg) => arg === "--apply-approved"))
const apply = process.argv.includes("--apply-approved")
const connectionId = "w200"
const functionName = "Z_ORVANTA_OPS_READ"
const functionGroup = "ZORVANTA_LOG"
const packageName = "ZABAP"
const transportNumber = "GR2K923421"
const parameters = ["IV_STEP", "IV_SPOOLID", "IV_PAGE"]
const oldBody = operationalLogSource.join("\n")
const newBody = operationalLogSpoolSource.join("\n")
const hash = (text) => createHash("sha256").update(text).digest("hex")
// Historical single-use step. These two pins describe the base and spool bodies as they were
// before the CAPABILITIES branch existed, and that progression has already been applied (the
// report variant is what is deployed now), so they no longer match the current generators by
// design. A CAPABILITIES upgrade is evidenced by scripts/verify-helper-deployment.mjs instead
// (see docs/helper-capabilities-protocol.md 3.3 and 3.5) and must re-pin these values if it
// reuses this step.
assert.equal(hash(oldBody), "ae149347a38cf9083c57c8cce22363e714d13a6ffeb434c5e599bbee4e575624")
assert.equal(hash(newBody), "adbeaa50a15254939b285f1349527b8fa692227b74588b89f2b4c78f8bd02ae3")
const evidence = { startedAt: new Date().toISOString(), apply, steps: [] }
const c = new Client({ name: "approved-job-spool-deployment", version: "1" })
async function call(name, args) {
  const result = await c.callTool({ name, arguments: args }, undefined, { timeout: 120000 })
  const text = result.content
    ?.filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n")
  if (result.isError) throw new Error(`${name}: ${text}`)
  return text
}
const definition = async () =>
  JSON.parse(await call("read_function_module_interface", { connectionId, functionName }))
function body(source) {
  const start = source.indexOf("DATA: lt_jobs TYPE STANDARD TABLE OF tbtco,")
  const end = source.indexOf("\n\nENDFUNCTION.", start)
  assert.ok(start > 0 && end > start)
  return source.slice(start, end)
}
async function workspace(fileUri, expectedBody) {
  const text = await call("get_object_by_uri", {
    connectionId,
    uri: fileUri,
    startLine: 0,
    lineCount: 1200
  })
  const source = text.match(/```abap\r?\n([\s\S]*?)\r?\n```/)?.[1].replace(/\r\n/g, "\n")
  assert.ok(source)
  assert.equal(body(source), expectedBody, "Workspace body differs; stop without retry")
  return source
}
async function diagnostics(fileUri) {
  const text = await call("get_abap_diagnostics", { fileUri })
  assert.match(text, /No diagnostics found.*no syntax errors or warnings/is)
  return text
}
try {
  await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:4847/mcp")), {
    timeout: 10000
  })
  let before = await definition()
  assert.equal(
    before.sourceFingerprint,
    "6978e8f14d01511f90527a6680cdee544e784b299f12dce4933958f4de196f02"
  )
  assert.equal(
    before.interfaceFingerprint,
    "bf2aebedb44d7e78f4c9810cca150601f603776426c44c6859482edc3f0d023b"
  )
  assert.equal(before.functionGroup, functionGroup)
  assert.equal(before.remoteEnabled, true)
  assert.equal(before.updateTask, false)
  assert.equal(body(before.source.join("\n")), oldBody)
  assert.ok(parameters.every((name) => !before.importParameters.some((p) => p.name === name)))
  const assignment = JSON.parse(
    await call("inspect_repository_assignment", {
      connectionId,
      objectName: functionName,
      objectType: "FUGR/FF"
    })
  )
  assert.equal(assignment.parentObject, functionGroup)
  assert.equal(assignment.packageName, packageName)
  assert.equal(assignment.requestNumber, transportNumber)
  assert.equal(assignment.transportStatus, "D")
  assert.equal(assignment.active, true)
  const resolved = await call("get_abap_object_workspace_uri", {
    connectionId,
    objectName: functionName,
    objectType: "FUGR/FF"
  })
  const fileUri = resolved.match(/Workspace URI: (\S+)/)?.[1]
  assert.ok(fileUri)
  await workspace(fileUri, oldBody)
  evidence.assignment = assignment
  evidence.before = {
    sourceFingerprint: before.sourceFingerprint,
    interfaceFingerprint: before.interfaceFingerprint
  }
  evidence.bodyFingerprints = { old: hash(oldBody), intended: hash(newBody) }
  evidence.newOptionalParameters = parameters
  if (apply) {
    const longComment =
      "* No direct RFC table bypass: exact current-client job and SHOW checked above."
    const shortComment =
      "* Exact current-client job and SHOW permission checked above.\n* No direct RFC table bypass."
    const baselineBody = oldBody.replace(longComment, shortComment)
    const lines = oldBody.split("\n")
    const commentLine = lines.indexOf(longComment)
    assert.ok(commentLine > 4)
    assert.equal(lines.filter((line) => line.length > 72).length, 1)
    const oldCommentContext = lines.slice(commentLine - 4, commentLine + 5).join("\n")
    const prep = { stage: "comment-width", operationId: `mvp4-spool-comment-${Date.now()}` }
    evidence.steps.push(prep)
    prep.result = await call("replace_string_in_abap_object", {
      fileUri,
      transportNumber,
      operationId: prep.operationId,
      oldString: oldCommentContext,
      newString: oldCommentContext.replace(longComment, shortComment)
    })
    prep.diagnostics = await diagnostics(fileUri)
    const prepared = await definition()
    assert.equal(prepared.interfaceFingerprint, before.interfaceFingerprint)
    assert.equal(body(prepared.source.join("\n")), baselineBody)
    await workspace(fileUri, baselineBody)
    prep.sourceFingerprint = prepared.sourceFingerprint
    before = prepared
    const interfaceStep = { stage: "interface", operationId: `mvp4-spool-interface-${Date.now()}` }
    evidence.steps.push(interfaceStep)
    interfaceStep.result = await call("patch_function_module_interface", {
      connectionId,
      functionName,
      functionGroup,
      packageName,
      transportNumber,
      operationId: interfaceStep.operationId,
      expectedInterfaceFingerprint: before.interfaceFingerprint,
      expectedSourceFingerprint: before.sourceFingerprint,
      parameterOperations: parameters.map((name) => ({
        operation: "add",
        direction: "import",
        name,
        typeName: "STRINGVAL",
        optional: true,
        passByValue: true
      })),
      exceptionOperations: []
    })
    console.log(
      `Interface write returned for ${interfaceStep.operationId}; full result retained in evidence.`
    )
    interfaceStep.diagnostics = await diagnostics(fileUri)
    const afterInterface = await definition()
    assert.equal(body(afterInterface.source.join("\n")), baselineBody)
    for (const p of before.importParameters)
      assert.deepEqual(
        afterInterface.importParameters.find((item) => item.name === p.name),
        p
      )
    assert.equal(afterInterface.importParameters.length, before.importParameters.length + 3)
    for (const name of parameters) {
      const p = afterInterface.importParameters.find((item) => item.name === name)
      assert.ok(p?.optional && p.passByValue && p.typeName === "STRINGVAL")
    }
    for (const key of [
      "exportParameters",
      "changingParameters",
      "tableParameters",
      "exceptions",
      "remoteEnabled",
      "updateTask"
    ])
      assert.deepEqual(afterInterface[key], before[key])
    interfaceStep.interfaceFingerprint = afterInterface.interfaceFingerprint
    interfaceStep.sourceFingerprint = afterInterface.sourceFingerprint
    interfaceStep.bodyPreserved = true
    const exactSource = await workspace(fileUri, baselineBody)
    const a = baselineBody.split("\n"),
      b = newBody.split("\n")
    let prefix = 0,
      suffix = 0
    while (prefix < a.length && a[prefix] === b[prefix]) prefix++
    while (suffix < a.length - prefix && a.at(-suffix - 1) === b.at(-suffix - 1)) suffix++
    const begin = Math.max(0, prefix - 4),
      tail = Math.max(0, suffix - 4)
    const oldString = a.slice(begin, a.length - tail).join("\n")
    const newString = b.slice(begin, b.length - tail).join("\n")
    assert.equal(exactSource.split(oldString).length, 2)
    const sourceStep = { stage: "source", operationId: `mvp4-spool-source-${Date.now()}` }
    evidence.steps.push(sourceStep)
    sourceStep.result = await call("replace_string_in_abap_object", {
      fileUri,
      transportNumber,
      operationId: sourceStep.operationId,
      oldString,
      newString
    })
    console.log(
      `Source write returned for ${sourceStep.operationId}; full result retained in evidence.`
    )
    sourceStep.diagnostics = await diagnostics(fileUri)
    const after = await definition()
    assert.equal(after.interfaceFingerprint, afterInterface.interfaceFingerprint)
    assert.equal(body(after.source.join("\n")), newBody)
    await workspace(fileUri, newBody)
    evidence.after = {
      sourceFingerprint: after.sourceFingerprint,
      interfaceFingerprint: after.interfaceFingerprint,
      lineCount: after.source.length
    }
    evidence.groupDiagnostics = await diagnostics(
      "adt://w200/sap/bc/adt/functions/groups/zorvanta_log"
    )
    evidence.status = "deployed_source_verified_not_runtime_tested"
  } else evidence.status = "preflight_only"
} catch (error) {
  evidence.status = "stopped"
  evidence.error = error.message
  process.exitCode = 1
} finally {
  await c.close()
  evidence.finishedAt = new Date().toISOString()
  const path = resolve("../.doc", `mvp4-spool-deploy-${Date.now()}.json`)
  await writeFile(path, JSON.stringify(evidence, null, 2), { flag: "wx" })
  console.log(
    JSON.stringify(
      {
        status: evidence.status,
        error: evidence.error,
        after: evidence.after,
        steps: evidence.steps.map(({ stage, operationId }) => ({ stage, operationId })),
        path
      },
      null,
      2
    )
  )
}
