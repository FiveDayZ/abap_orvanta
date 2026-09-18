import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"
import { APPLICATION_LOG_HELPER } from "../src/application-logs.js"

// Offline drift test for the CAPABILITIES self-description of scripts/application-log-source.mjs
// (Z_ORVANTA_LOG_READ). Kept apart from test/helper-capabilities-generators.test.ts because that
// suite reads CASE dispatchers with `APPEND ... TO lt_capability.` rows, while this helper is an
// IF/ELSE chain that assembles its answer with CONCATENATE.
//
// Only generator text is parsed and bodies are rendered in memory. No PowerShell, no deploy script
// and no SAP system is executed or contacted.
//
// What is frozen here and why:
//   - the archived body line count and bodyLinesHash: they are the pre-migration baseline that the
//     deployed object was proven equal to (read-only read of w200, 2026-09-18) and must never drift;
//   - the rendered body is exactly archive + branch, and the SOURCE|HASH row is the digest of the
//     body with its four slots still in place (self-referential, as in the other helpers).
// This helper answers through a single EV_RESULT JSON envelope with no it_source table, so revision
// R3 puts the protocol rows inside that envelope's own `payload` array, and R4 makes every `since`
// equal to the envelope's `"version":"1"` -> 1.0.

const helperFile = "scripts/application-log-source.mjs"
const evidenceFile = "scripts/helper-capabilities-evidence.mjs"
const APPLICATION_LOG_BODY_LINES = 634
const APPLICATION_LOG_BODY_HASH = "d27df9310107d4ca21cba61f0bf5426879573c4cad19dcacda101f88ba9bbd6c"
const INSERTION_ANCHOR = "CLEAR ev_result."

const source = await readFile(helperFile, "utf8")
const module_ = await import(pathToFileURL(resolve(helperFile)).href)
const evidence = await import(pathToFileURL(resolve(evidenceFile)).href)

const definition = module_.applicationLogHelperDefinition as {
  functionName: string
  functionGroup: string
  remoteEnabled: boolean
  importParameters: { name: string; typeName: string }[]
  exportParameters: { name: string; typeName: string }[]
}
const operations = module_.applicationLogOperations as {
  opcode: string
  since: string
  mode: "R" | "W"
}[]
const deployment = module_.applicationLogDeployment as {
  helper: string
  packageName: string
  transport: string
  transportTask: string
}
const archived = module_.applicationLogArchivedBody as string[]
const rendered = module_.applicationLogSource as string[]
const branch = module_.buildApplicationLogCapabilityBranch() as string[]
const injectCapabilityHash = module_.injectCapabilityHash as (lines: string[]) => string[]
const bodyLinesHash = evidence.bodyLinesHash as (lines: string[]) => string

const operationRows = operations.map(
  (entry) => `OPERATION|${entry.opcode}|${entry.since}|${entry.mode}`
)

test("the generator declares the live helper object", () => {
  assert.equal(definition.functionName, APPLICATION_LOG_HELPER)
  assert.equal(deployment.helper, APPLICATION_LOG_HELPER)
  assert.equal(definition.functionGroup, "ZORVANTA_LOG")
  assert.equal(definition.remoteEnabled, true)
  // The interface is pinned: 12 IV_* STRINGVAL imports and the single EV_RESULT export, no tables.
  assert.equal(definition.importParameters.length, 12)
  for (const parameter of definition.importParameters) {
    assert.match(parameter.name, /^IV_[A-Z_]+$/)
    assert.equal(parameter.typeName, "STRINGVAL")
  }
  assert.deepEqual(
    definition.exportParameters.map((parameter) => parameter.name),
    ["EV_RESULT"]
  )
  assert.equal(deployment.packageName, "ZABAP")
  assert.equal(deployment.transport, "GR2K923472")
  assert.equal(deployment.transportTask, "GR2K923473")
})

test("the archived body is the frozen pre-migration baseline", () => {
  assert.equal(archived.length, APPLICATION_LOG_BODY_LINES)
  assert.equal(bodyLinesHash(archived), APPLICATION_LOG_BODY_HASH)
  assert.match(archived[0] ?? "", /^DATA:/)
  assert.equal(archived[archived.length - 1], "ENDFUNCTION.")
  // The archive must stay unedited: the CAPABILITIES branch may not have leaked into it.
  assert.ok(!archived.some((line) => line.includes("CAPABILITIES")))
})

test("the rendered body is exactly the archive plus one insertion", () => {
  const insertion = archived.indexOf(INSERTION_ANCHOR)
  assert.ok(insertion >= 0, "insertion anchor missing from the archived body")
  const spliced = [...archived.slice(0, insertion), ...branch, ...archived.slice(insertion)]
  assert.equal(spliced.length, archived.length + branch.length)
  assert.equal(rendered.length, APPLICATION_LOG_BODY_LINES + branch.length)
  // injectCapabilityHash only rewrites the SOURCE|HASH slots, so the two must agree exactly.
  assert.deepEqual(rendered, injectCapabilityHash(spliced))
  // Everything outside the insertion is byte-identical to the archive.
  const withoutBranch = [
    ...rendered.slice(0, insertion),
    ...rendered.slice(insertion + branch.length)
  ]
  assert.equal(withoutBranch.length, archived.length)
  for (let index = 0; index < archived.length; index += 1) {
    const expected = archived[index]
    if (expected !== undefined && expected.includes("ORVANTAHASHSLOT")) continue
    assert.equal(withoutBranch[index], expected, `body drifted at line ${index + 1}`)
  }
})

test("the CAPABILITIES branch runs before the default envelope and returns", () => {
  assert.equal(branch[0], "  IF iv_action = 'CAPABILITIES'.")
  assert.equal(branch[1], "    CLEAR: ev_result, lv_json.")
  assert.equal(branch[branch.length - 2], "    RETURN.")
  assert.equal(branch[branch.length - 1], "  ENDIF.")
  // It must precede both `CLEAR ev_result.` and the default envelope, or the default overwrites it.
  const anchor = branch.findIndex((line) => line.trim() === INSERTION_ANCHOR)
  assert.equal(anchor, -1, "the branch must not clear ev_result itself")
  const branchStart = rendered.indexOf(branch[0] ?? "")
  assert.ok(branchStart >= 0, "the CAPABILITIES branch is not in the rendered body")
  assert.ok(rendered.indexOf(INSERTION_ANCHOR) > branchStart)
  // The default envelope carries READ_ONLY_UNSUPPORTED; it must sit after the branch, never before.
  assert.ok(
    rendered.join("\n").indexOf("READ_ONLY_UNSUPPORTED") > branchStart,
    "the default envelope must follow the branch"
  )
})

test("the branch carries the marked opcode table, the protocol range and the provenance rows", () => {
  const joined = branch.join("\n")
  for (const row of operationRows) {
    assert.ok(joined.includes(`'"${row}",'`), `branch is missing the row ${row}`)
  }
  assert.ok(joined.includes("'\"HELPER|Z_ORVANTA_LOG_READ\",'"))
  assert.ok(joined.includes("'\"PROTOCOL|MIN|1.0\",'"))
  assert.ok(joined.includes("'\"PROTOCOL|MAX|1.0\",'"))
  assert.ok(joined.includes("'\"SOURCE|PACKAGE|ZABAP\",'"))
  assert.ok(joined.includes("'\"SOURCE|TRANSPORT|GR2K923472|GR2K923473\",'"))
  // R3: the rows live in the envelope's own payload array, and the envelope stays version 1 / read-only.
  assert.ok(joined.includes("'\"payload\":['"))
  assert.ok(joined.includes('\'{"version":"1","status":"S","code":"CAPABILITIES",\''))
  assert.ok(joined.includes('\'"message":"ORVANTA helper capabilities","readOnly":true,\''))
  assert.ok(!joined.includes("it_source"))
})

test("every operation is table-listed and read-only at protocol 1.0", () => {
  assert.equal(operations.length, 5)
  assert.deepEqual(
    operations.map((entry) => entry.opcode),
    ["SEARCH", "DISCOVER", "READ", "READ_DIAGNOSTIC", "READ_BODY_CHECK"]
  )
  for (const entry of operations) {
    assert.equal(entry.mode, "R", `${entry.opcode} must be read-only`)
    assert.equal(entry.since, "1.0", `${entry.opcode} must match the envelope version`)
  }
  assert.equal(new Set(operations.map((entry) => entry.opcode)).size, operations.length)
  // The single opcode table lives in the marked block and nowhere else.
  assert.ok(source.includes("// >>> ORVANTA-CAPABILITY-TABLE"))
  assert.ok(source.includes("// <<< ORVANTA-CAPABILITY-TABLE"))
  assert.ok(source.includes("// >>> ORVANTA-CAPABILITIES-SOURCE"))
  assert.ok(source.includes("// <<< ORVANTA-CAPABILITIES-SOURCE"))
})

test("the SOURCE|HASH row is filled and self-consistent", () => {
  const joined = rendered.join("\n")
  assert.ok(!joined.includes("ORVANTAHASHSLOT"), "a hash slot was left unfilled")
  const groups = [...joined.matchAll(/'([0-9a-f]{16})'/g)].map((match) => String(match[1]))
  assert.ok(groups.length >= 4, "expected four hash groups in the SOURCE|HASH row")
  const written = groups.join("").slice(0, 64)
  const insertion = archived.indexOf(INSERTION_ANCHOR)
  const slotBearing = [...archived.slice(0, insertion), ...branch, ...archived.slice(insertion)]
  assert.equal(written, createHash("sha256").update(slotBearing.join("\n")).digest("hex"))
  // The row is assembled from four 16-character literals, so the digest never appears contiguous.
  assert.ok(joined.includes("'\"SOURCE|HASH|' '"))
  assert.ok(joined.includes("'ORVANTAHASHSLOT") === false)
})

test("the generated branch stays inside the ECC 7.31 source limits", () => {
  // No new line may exceed the ABAP 72-character source limit beyond what the archive already has.
  const archivedLong = new Set(archived.filter((line) => line.length > 72))
  for (const line of branch) {
    assert.ok(line.length <= 72, `generated branch line exceeds 72 characters: ${line}`)
  }
  const renderedLong = rendered.filter((line) => line.length > 72)
  for (const line of renderedLong) {
    assert.ok(archivedLong.has(line), `a new over-length line appeared: ${line}`)
  }
  // No 7.40+ constructs and no state-changing or blocking statements in a self-description.
  const joined = branch.join("\n")
  for (const forbidden of ["@", "VALUE(", "DATA(", "COND ", "SWITCH ", "REDUCE ", "FILTER "]) {
    assert.ok(!joined.includes(forbidden), `forbidden 7.40+ construct in the branch: ${forbidden}`)
  }
  for (const forbidden of [
    "COMMIT WORK",
    "CALL FUNCTION",
    "INSERT ",
    "UPDATE ",
    "DELETE ",
    "MODIFY "
  ]) {
    assert.ok(!joined.includes(forbidden), `branch must stay read-only: ${forbidden}`)
  }
})
