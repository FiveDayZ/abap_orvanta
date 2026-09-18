// Deploys the CAPABILITIES body of one locally generated helper (Z_ORVANTA_MAINT_READ or
// Z_ORVANTA_OPS_READ) into w200, under the request and task the generator publishes in
// SOURCE|TRANSPORT.
//
//   node scripts/deploy-helper-capabilities.mjs --target maint [--endpoint <url>]
//   node scripts/deploy-helper-capabilities.mjs --target maint --apply-approved [--endpoint <url>]
//
// Without `--apply-approved` this is a dry run: it reads the live source, assignment and edit
// fingerprint, proves the live body is the recorded pre-CAPABILITIES baseline, and prints the exact
// replacement it would send. Nothing is written, activated or transported in that mode.
//
// With `--apply-approved` it performs exactly one source replacement through
// `replace_string_in_abap_object`, then verifies syntax diagnostics, the interface fingerprint, the
// new body hash, the recomputed SOURCE|HASH digest and the TADIR read-back. It never releases,
// deletes or reassigns anything else, and it stops without retry on the first unexpected fact.

import assert from "node:assert/strict"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { writeFile } from "node:fs/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  assertOpenAssignment,
  bodyLinesHash,
  functionModuleBody,
  helperCapabilityDigests,
  helperCapabilityTargets,
  planReplacement,
  verifyDeployedBody
} from "./helper-capabilities-evidence.mjs"

const argv = process.argv.slice(2)
const apply = argv.includes("--apply-approved")
// The live run happens only when this file is the process entry point: the offline suite imports it
// for its pure helpers, and an import must never connect to SAP, demand a target or reject a command
// line that belongs to the importing process.
const isEntryPoint =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href
const valuedFlags = new Set(["--target", "--endpoint"])
const argumentValue = (flag) => {
  const index = argv.indexOf(flag)
  if (index < 0) return undefined
  const value = argv[index + 1]
  assert.ok(value !== undefined && !value.startsWith("--"), `${flag} requires a value`)
  return value
}
const known = new Set(["--apply-approved", ...valuedFlags])

const connectionId = "w200"
const targetName = argumentValue("--target") ?? "maint"
const endpoint =
  argumentValue("--endpoint") ?? process.env.ABAP_MCP_ENDPOINT ?? "http://127.0.0.1:4847/mcp"
const target = helperCapabilityTargets[targetName] ?? helperCapabilityTargets.maint
const transportNumber = target.transportRequest
const sourceHashDigest = helperCapabilityDigests[targetName] ?? helperCapabilityDigests.maint
const functionGroupUri = `adt://w200/sap/bc/adt/functions/groups/${target.functionGroup.toLowerCase()}`

if (isEntryPoint) {
  for (const [index, arg] of argv.entries()) {
    if (arg.startsWith("--")) {
      assert.ok(known.has(arg), `unsupported argument ${arg}`)
      continue
    }
    const previous = argv[index - 1]
    assert.ok(valuedFlags.has(previous), `unexpected positional argument ${arg}`)
  }
  assert.ok(
    endpoint.startsWith("http://") || endpoint.startsWith("https://"),
    `--endpoint must be an absolute HTTP(S) URL, received ${endpoint || "EMPTY"}`
  )
  assert.ok(
    helperCapabilityTargets[targetName],
    `--target must be one of ${Object.keys(helperCapabilityTargets).join(", ")}, received ${targetName}`
  )
}

const evidence = {
  startedAt: new Date().toISOString(),
  apply,
  mode: apply ? "apply-approved" : "dry-run",
  endpoint,
  connectionId,
  helper: target.helper,
  transportNumber,
  transportTask: target.transportTask,
  writesInvoked: false,
  generator: {
    deployedNowBodyHash: target.deployedNowBodyHash,
    intendedBodyHash: target.intendedBodyHash,
    sourceHashDigest,
    bodyLines: target.generatorBody.length
  },
  steps: []
}
const step = (name, detail) => {
  evidence.steps.push({ name, at: new Date().toISOString(), ...detail })
}

const client = new Client({ name: "orvanta-helper-capabilities-deployment", version: "1" })
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })
  const text = (result.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
  if (result.isError) throw new Error(`${name}: ${text}`)
  return text
}

/** The engine's view of the target, read fresh for every decision. */
async function definition() {
  return JSON.parse(
    await call("read_function_module_interface", { connectionId, functionName: target.helper })
  )
}
async function assignment() {
  return JSON.parse(
    await call("inspect_repository_assignment", {
      connectionId,
      objectName: target.helper,
      objectType: "FUGR/FF"
    })
  )
}
/** The workspace text the editor path will replace within, plus its edit fingerprint. */
async function workspace() {
  const resolved = await call("get_abap_object_workspace_uri", {
    connectionId,
    objectName: target.helper,
    objectType: "FUGR/FF"
  })
  const fileUri = resolved.match(/Workspace URI: (\S+)/)?.[1]
  assert.ok(fileUri, `no workspace URI in: ${resolved}`)
  const text = await call("get_object_by_uri", {
    connectionId,
    uri: fileUri,
    startLine: 0,
    lineCount: 2000
  })
  const source = text.match(/```abap\r?\n([\s\S]*?)\r?\n```/)?.[1].replace(/\r\n/g, "\n")
  assert.ok(source, `no abap block for ${fileUri}`)
  const lines = await call("get_abap_object_lines", {
    connectionId,
    objectName: target.helper,
    objectType: "FUNC",
    startLine: 1,
    lineCount: 8
  })
  const editFingerprint = lines.match(/Full Source SHA-256: ([a-f0-9]{64})/)?.[1]
  assert.ok(editFingerprint, "no full source SHA-256 reported for the edit")
  return { fileUri, source, editFingerprint }
}

let connection = null
if (isEntryPoint) {
  try {
    connection = new StreamableHTTPClientTransport(new URL(endpoint), { timeout: 10000 })
    await client.connect(connection)
    const tools = await client.listTools()
    const toolNames = new Set(tools.tools.map((tool) => tool.name))
    for (const required of [
      "read_function_module_interface",
      "inspect_repository_assignment",
      "replace_string_in_abap_object"
    ]) {
      assert.ok(toolNames.has(required), `${endpoint} does not offer ${required}`)
    }
    step("tools", { endpointTools: tools.tools.length, writeToolAvailable: true })

    const before = await definition()
    assert.equal(
      before.functionGroup,
      target.functionGroup,
      `${target.helper} must be in ${target.functionGroup}`
    )
    assert.equal(before.remoteEnabled, true, `${target.helper} must stay remote-enabled`)
    const liveBody = functionModuleBody(before.source.join("\n"))
    const liveBodyHash = bodyLinesHash(liveBody)
    assert.equal(
      liveBodyHash,
      target.deployedNowBodyHash,
      `${target.helper} live body ${liveBodyHash} is not the recorded pre-CAPABILITIES baseline ${target.deployedNowBodyHash}; stop without retry`
    )
    assert.notEqual(
      liveBodyHash,
      target.intendedBodyHash,
      `${target.helper} already carries the CAPABILITIES body; nothing to deploy`
    )
    const beforeAssignment = await assignment()
    assert.equal(beforeAssignment.parentObject, target.functionGroup)
    assert.equal(beforeAssignment.packageName, target.packageName)
    assert.equal(beforeAssignment.active, true, `${target.helper} must be active before the change`)
    step("baseline", {
      sourceFingerprint: before.sourceFingerprint,
      interfaceFingerprint: before.interfaceFingerprint,
      liveBodyHash,
      liveBodyLines: liveBody.length,
      functionGroup: before.functionGroup,
      packageName: beforeAssignment.packageName,
      requestNumberBefore: beforeAssignment.requestNumber,
      taskNumberBefore: beforeAssignment.taskNumber,
      transportStatusBefore: beforeAssignment.transportStatus
    })
    evidence.before = {
      sourceFingerprint: before.sourceFingerprint,
      interfaceFingerprint: before.interfaceFingerprint,
      liveBodyHash,
      liveBodyLines: liveBody.length,
      assignment: beforeAssignment
    }

    const { fileUri, source, editFingerprint } = await workspace()
    const oldBody = liveBody.join("\n")
    const newBody = target.generatorBody.join("\n")
    assert.equal(
      functionModuleBody(source).join("\n"),
      oldBody,
      "the workspace text and the engine source disagree about the current body; stop"
    )
    const plan = planReplacement(oldBody, newBody)
    assert.equal(
      source.split(plan.oldString).length,
      2,
      "the replacement context is not unique in the workspace source; stop without writing"
    )
    step("plan", {
      fileUri,
      editFingerprint,
      replacedLines: plan.replacedLines,
      contextLines: plan.contextLines,
      oldStringLines: plan.oldString.split("\n").length,
      newStringLines: plan.newString.split("\n").length
    })
    evidence.plan = { fileUri, editFingerprint, replacedLines: plan.replacedLines }

    // SAP validates the ADT edit lock against the object's own open transport assignment, so an object
    // that carries none is refused as "not locked" only after the lock call has already returned a
    // handle. Checking here keeps a doomed run from capturing a rollback pre-image, reaching SAP, or
    // reporting a dry run as ready; the message names the request/task the object must be assigned to.
    let binding = null
    let bindingProblem = null
    try {
      binding = assertOpenAssignment(beforeAssignment, target)
    } catch (error) {
      bindingProblem = error.message
    }
    evidence.transportBinding = bindingProblem
      ? { ok: false, problem: bindingProblem }
      : { ok: true, request: binding.request, task: binding.task }
    step("transport-binding", evidence.transportBinding)
    if (bindingProblem) {
      evidence.status = apply ? "stopped" : "dry_run_blocked"
      throw new Error(bindingProblem)
    }

    // The pre-CAPABILITIES body exists nowhere else: the generator module was edited in place, so this
    // read-back is the only copy of the text that is about to be replaced. Capture it before writing
    // so the change can be reverted from the evidence directory alone.
    if (apply) {
      const preImagePath = resolve(
        "../.doc/helper-capabilities-evidence",
        `rollback-${new Date().toISOString().replace(/[:.]/g, "-")}-${targetName}-pre-source.txt`
      )
      const header = [
        `# rollback pre-image: ${target.helper}`,
        `capturedAt: ${new Date().toISOString()}`,
        `fileUri: ${fileUri}`,
        `editFingerprint: ${editFingerprint}`,
        `sourceFingerprint: ${before.sourceFingerprint}`,
        `interfaceFingerprint: ${before.interfaceFingerprint}`,
        `bodyHash: ${liveBodyHash}`,
        `transportNumber: ${transportNumber}`,
        `replacement: ${plan.replacedLines} lines with context begin=${plan.contextLines.begin} tail=${plan.contextLines.tail}`,
        "--- source ---",
        ""
      ].join("\n")
      await writeFile(preImagePath, `${header}${source}\n`, { flag: "wx" })
      evidence.rollbackPreImage = preImagePath
      step("rollback-pre-image", { path: preImagePath, bytes: header.length + source.length + 1 })
    }

    if (!apply) {
      evidence.status = "dry_run_ready"
    } else {
      const operationId = `capabilities-${targetName}-${Date.now()}`
      evidence.operationId = operationId
      evidence.writesInvoked = true
      const writeResult = await call("replace_string_in_abap_object", {
        fileUri,
        transportNumber,
        operationId,
        expectedSourceFingerprint: editFingerprint,
        oldString: plan.oldString,
        newString: plan.newString
      })
      step("write", { operationId, transportNumber, result: writeResult.slice(0, 2000) })

      for (const uri of [fileUri, functionGroupUri]) {
        const diagnostics = await call("get_abap_diagnostics", { fileUri: uri })
        assert.match(
          diagnostics,
          /No diagnostics found.*no syntax errors or warnings/is,
          `${uri} reports diagnostics after the write: ${diagnostics}`
        )
        step("diagnostics", { uri, clean: true })
      }

      const after = await definition()
      assert.equal(
        after.interfaceFingerprint,
        before.interfaceFingerprint,
        `${target.helper} interface fingerprint changed; the published interface must not move`
      )
      const afterBodyHash = bodyLinesHash(functionModuleBody(after.source.join("\n")))
      assert.equal(
        afterBodyHash,
        target.intendedBodyHash,
        `${target.helper} live body ${afterBodyHash} is not the intended ${target.intendedBodyHash}`
      )
      evidence.sourceHashCheck = verifyDeployedBody(after.source, {
        helper: target.helper,
        generatorBody: target.generatorBody,
        sourceHashDigest
      })
      evidence.after = {
        sourceFingerprint: after.sourceFingerprint,
        interfaceFingerprint: after.interfaceFingerprint,
        bodyHash: afterBodyHash,
        bodyLines: functionModuleBody(after.source.join("\n")).length
      }
      const afterAssignment = await assignment()
      assert.equal(
        afterAssignment.requestNumber,
        transportNumber,
        `${target.helper} landed in request ${afterAssignment.requestNumber}, not ${transportNumber}`
      )
      assert.equal(
        afterAssignment.taskNumber,
        target.transportTask,
        `${target.helper} landed in task ${afterAssignment.taskNumber}, not the published ${target.transportTask}`
      )
      assert.equal(afterAssignment.transportStatus, "D", `${transportNumber} must stay modifiable`)
      assert.equal(afterAssignment.active, true, `${target.helper} must be active after the write`)
      evidence.after.assignment = afterAssignment
      step("assignment", { after: afterAssignment })
      evidence.status = "deployed_source_verified_not_runtime_tested"
    }
  } catch (error) {
    evidence.status = "stopped"
    evidence.error = error.message
    process.exitCode = 1
  } finally {
    await client.close().catch(() => {})
    evidence.finishedAt = new Date().toISOString()
    try {
      const path = resolve(
        "../.doc/helper-capabilities-evidence",
        `deploy-${new Date().toISOString().replace(/[:.]/g, "-")}-${targetName}.json`
      )
      await writeFile(path, JSON.stringify(evidence, null, 2), { flag: "wx" })
      evidence.path = path
    } catch (error) {
      evidence.evidenceError = error.message
      process.exitCode = 1
    }
    console.log(
      JSON.stringify(
        {
          status: evidence.status,
          mode: evidence.mode,
          helper: target.helper,
          endpoint,
          transportNumber,
          transportTask: target.transportTask,
          error: evidence.error,
          before: evidence.before && {
            liveBodyHash: evidence.before.liveBodyHash,
            liveBodyLines: evidence.before.liveBodyLines,
            requestBefore: evidence.before.assignment.requestNumber,
            taskBefore: evidence.before.assignment.taskNumber
          },
          after: evidence.after,
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
