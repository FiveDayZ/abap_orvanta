import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { operationalLogSpoolSource, operationalLogReportSource } from "./operational-log-source.mjs"

assert.ok(process.argv.slice(2).every((arg) => arg === "--apply-approved"))
const apply = process.argv.includes("--apply-approved")
const connectionId = "w200",
  functionName = "Z_ORVANTA_OPS_READ"
const transportNumber = "GR2K923421"
const oldBody = operationalLogSpoolSource.join("\n")
const newBody = operationalLogReportSource.join("\n")
const hash = (text) => createHash("sha256").update(text).digest("hex")
assert.equal(hash(oldBody), "adbeaa50a15254939b285f1349527b8fa692227b74588b89f2b4c78f8bd02ae3")
assert.equal(hash(newBody), "6cd998bf1e80e61e5d3c20ea416997a3310cc20611919134fe779149b95210ea")
const evidence = { startedAt: new Date().toISOString(), apply, calls: [] }
const c = new Client({ name: "approved-report-parameter-deployment", version: "1" })
async function call(name, args) {
  const entry = { name, arguments: args }
  evidence.calls.push(entry)
  const result = await c.callTool({ name, arguments: args }, undefined, { timeout: 120000 })
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
function body(source) {
  const start = source.indexOf("DATA: lt_jobs TYPE STANDARD TABLE OF tbtco,")
  const end = source.indexOf("\n\nENDFUNCTION.", start)
  assert.ok(start > 0 && end > start)
  return source.slice(start, end)
}
async function workspace(uri, expected) {
  const text = await call("get_object_by_uri", { connectionId, uri, startLine: 0, lineCount: 1200 })
  const source = text.match(/```abap\r?\n([\s\S]*?)\r?\n```/)?.[1].replace(/\r\n/g, "\n")
  assert.ok(source)
  assert.equal(body(source), expected)
  return source
}
async function assignment() {
  const result = JSON.parse(
    await call("inspect_repository_assignment", {
      connectionId,
      objectName: functionName,
      objectType: "FUGR/FF"
    })
  )
  assert.equal(result.parentObject, "ZORVANTA_LOG")
  assert.equal(result.packageName, "ZABAP")
  assert.equal(result.requestNumber, transportNumber)
  assert.equal(result.taskNumber, "GR2K923422")
  assert.equal(result.transportStatus, "D")
  assert.equal(result.active, true)
  return result
}
try {
  await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:4847/mcp")), {
    timeout: 10000
  })
  const before = await definition()
  assert.equal(
    before.sourceFingerprint,
    "a0cd27a3f28ff716a34050fcdb3d75704e959c6161c3f06794839d0064bb4060"
  )
  assert.equal(
    before.interfaceFingerprint,
    "4a51c0d45820ef54b3bc98cfbb9b2aea6aed8c4f77977932a762a49063f81cf0"
  )
  assert.equal(before.functionGroup, "ZORVANTA_LOG")
  assert.equal(before.remoteEnabled, true)
  assert.equal(before.updateTask, false)
  assert.equal(body(before.source.join("\n")), oldBody)
  evidence.beforeAssignment = await assignment()
  const resolved = await call("get_abap_object_workspace_uri", {
    connectionId,
    objectName: functionName,
    objectType: "FUGR/FF"
  })
  const fileUri = resolved.match(/Workspace URI: (\S+)/)?.[1]
  assert.ok(fileUri)
  const source = await workspace(fileUri, oldBody)
  const rawSourceInfo = await call("get_abap_object_lines", {
    connectionId,
    objectName: functionName,
    objectType: "FUNC",
    startLine: 1,
    lineCount: 8
  })
  const editFingerprint = rawSourceInfo.match(/Full Source SHA-256: ([a-f0-9]{64})/)?.[1]
  assert.equal(editFingerprint, "8ab0e33728f58162247bfe13124f448b6dbfeb16052a66f841add387c56bfd86")
  evidence.editFingerprint = editFingerprint
  const a = oldBody.split("\n"),
    b = newBody.split("\n")
  let prefix = 0,
    suffix = 0
  while (prefix < a.length && a[prefix] === b[prefix]) prefix++
  while (suffix < a.length - prefix && a.at(-suffix - 1) === b.at(-suffix - 1)) suffix++
  const begin = Math.max(0, prefix - 4),
    tail = Math.max(0, suffix - 4)
  const oldString = a.slice(begin, a.length - tail).join("\n")
  const newString = b.slice(begin, b.length - tail).join("\n")
  assert.equal(source.split(oldString).length, 2)
  if (apply) {
    evidence.operationId = `mvp4-report-parameters-${Date.now()}`
    await call("replace_string_in_abap_object", {
      fileUri,
      transportNumber,
      operationId: evidence.operationId,
      expectedSourceFingerprint: editFingerprint,
      oldString,
      newString
    })
    for (const uri of [fileUri, "adt://w200/sap/bc/adt/functions/groups/zorvanta_log"]) {
      const diagnostics = await call("get_abap_diagnostics", { fileUri: uri })
      assert.match(diagnostics, /No diagnostics found.*no syntax errors or warnings/is)
    }
    const after = await definition()
    assert.equal(after.interfaceFingerprint, before.interfaceFingerprint)
    assert.equal(body(after.source.join("\n")), newBody)
    await workspace(fileUri, newBody)
    evidence.afterAssignment = await assignment()
    evidence.after = {
      sourceFingerprint: after.sourceFingerprint,
      interfaceFingerprint: after.interfaceFingerprint,
      lineCount: after.source.length
    }
    evidence.status = "deployed_source_verified_not_runtime_tested"
  } else evidence.status = "preflight_only"
} catch (error) {
  evidence.status = "stopped"
  evidence.error = error.message
  process.exitCode = 1
} finally {
  await c.close()
  evidence.finishedAt = new Date().toISOString()
  const path = resolve("../.doc", `mvp4-report-parameters-deploy-${Date.now()}.json`)
  await writeFile(path, JSON.stringify(evidence, null, 2), { flag: "wx" })
  console.log(
    JSON.stringify(
      {
        status: evidence.status,
        error: evidence.error,
        operationId: evidence.operationId,
        after: evidence.after,
        path
      },
      null,
      2
    )
  )
}
