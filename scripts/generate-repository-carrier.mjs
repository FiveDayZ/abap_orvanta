#!/usr/bin/env node
/**
 * Generates the in-SAP report that puts the CANONICAL repository helper body into SAP.
 *
 *   pwsh -NoLogo -NoProfile -File scripts/export-repository-helper-source.ps1 -FunctionName Z_ORVANTA_MCP_EXECUTE
 *   node scripts/generate-repository-carrier.mjs --function-name Z_ORVANTA_MCP_EXECUTE
 *   node scripts/generate-repository-carrier.mjs --function-name Z_ORVANTA_MCP_EXECUTE --check
 *   node scripts/generate-repository-carrier.mjs --function-name Z_ORVANTA_MCP_EXECUTE --offline
 *
 * Why this carrier exists: the repository family (Z_ORVANTA_MCP_EXECUTE / Z_ORVANTA_MCP_DYNPRO_API)
 * lives in ZORVANTA_MCP_CORE, which is self-write protected - the MCP service must not rewrite its own
 * helper, because one bad write would cost the service the ability to repair itself. Native ADT write
 * answers HTTP 423 and the helper's own write path answers SELF_FUNCTION_GROUP_FORBIDDEN, so the only
 * path that works is a report program a human runs with F8 (docs/release-process.md section 7.2 lists
 * the repository family as "independent carrier", exactly like the DDIC family).
 *
 * The body it deploys carries protocol 2.8: the D7 form reads (SAPscript / SmartStyles / Adobe) and
 * the D9 transport self-service (CREATE_TRANSPORT_REQUEST, ADD_OBJECTS_TO_TRANSPORT). The generator
 * asserts those write paths are implemented, not merely declared, so a full-body replacement cannot
 * silently regress them.
 *
 * The two repository function modules share one body source parameterised by the function module name
 * in its CAPABILITIES rows, so each needs its own carrier and its own F8 round. Deploy them one at a
 * time: a carrier is generated against the live include and refuses to apply itself on top of a
 * different baseline.
 *
 * Read-only against SAP: the live read only derives the baseline and the pre-flight assertions. This
 * script never writes, activates or transports anything in SAP. The generated report is run by a human
 * with F8 inside SAP.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const argv = process.argv.slice(2)
const value = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i < 0 ? fallback : argv[i + 1]
}
const check = argv.includes("--check")
const offline = argv.includes("--offline")
const endpoint = value("--endpoint", process.env.ABAP_MCP_ENDPOINT ?? "http://127.0.0.1:4848/mcp")

const FUNCTION_GROUP = "ZORVANTA_MCP_CORE"
// One carrier program per target: the two repository helpers need two bodies (each self-describes
// with its own function module name), and a single carrier per target keeps the baseline guard and
// the idempotency marker as simple as the DDIC carrier's. ABAP program names are capped at 30.
const TARGETS = {
  Z_ORVANTA_MCP_EXECUTE: { program: "ZORVANTA_MCP_EXEC_DEPLOY", tag: "EXEC", slug: "exec" },
  Z_ORVANTA_MCP_DYNPRO_API: { program: "ZORVANTA_MCP_DYNPRO_DEPLOY", tag: "DYNPR", slug: "dynpro" }
}
const HELPER = value("--function-name", "Z_ORVANTA_MCP_EXECUTE")
const target = TARGETS[HELPER]
if (!target) {
  console.error(`unknown repository helper: ${HELPER}`)
  console.error(`known: ${Object.keys(TARGETS).join(", ")}`)
  process.exit(2)
}
const PROGRAM = target.program
const sourceFile = resolve(
  value("--source", `.cache/repository-${HELPER.toLowerCase()}-canonical.json`)
)
const outFile = value(
  "--out",
  `C:/My/Workplace/Coding/vscode-abap/.doc/deploy-repository-${target.slug}-2.8-r07.abap`
)

// Content-derived, and reassigned once the canonical body is loaded (see below). It must NOT be a
// fixed string: the emitted report refuses to apply itself when the marker is already present in the
// live include (`IF ls_cur-line CS c_marker`). A fixed marker shared with an earlier carrier makes a
// *later* carrier no-op against a body it never deployed and print "NOTHING TO DO: this carrier is
// already applied" - a silent false success, because that message reads as "nothing needed" when in
// fact the new operations were never installed. Binding the marker to the target, the protocol and
// the body hash keeps re-running the same carrier idempotent while guaranteeing a changed body gets
// a new one.
let MARKER = "ORVANTA REPO CARRIER"
// The write paths this carrier exists to deliver: D9-1 transport creation and D9-2 object inclusion.
const WRITE_OPERATIONS = ["CREATE_TRANSPORT_REQUEST", "ADD_OBJECTS_TO_TRANSPORT"]
// Operations that must not disappear from the deployed helper: the D7 form reads and the D9 writes.
const REQUIRED_OPERATIONS = [
  "READ_SAPSCRIPT_FORM",
  "READ_SMARTSTYLE",
  "READ_ADOBE_FORM",
  "CREATE_TRANSPORT_REQUEST",
  "ADD_OBJECTS_TO_TRANSPORT"
]
// Operation names this carrier renames. The repository CASE serves several operations through shared
// clauses (`WHEN 'A' OR 'B'.` or a WHEN continued on the next line), which a single-opcode scan
// misses; the dispatch assertions below therefore accept a WHEN or an OR clause naming the opcode.
//
// IV_OPERATION is RS38L-NAME (CHAR 30) for this helper family, so three operation names longer than
// 30 characters can never match their `WHEN` arm: SAP truncates the parameter and the helper answers
// OPERATION_NOT_ALLOWED. The canonical body already carries the shortened names and the live 2.7
// helper still carries the long ones (.doc/code-update-20260922-112941.md records the mapping), so
// replacing the body *is* the fix - the three live lines below are intentional replacements, not lost
// live fixes. Same defect class as RESUME_TRANSPARENT_TABLE_ACTIVATION in the DDIC family.
const SUPERSEDED_OPERATIONS = {
  READ_ENHANCEMENT_IMPL: "READ_ENHANCEMENT_IMPLEMENTATION", // 31 chars -> truncated
  DELETE_ENHANCEMENT_IMPL: "DELETE_ENHANCEMENT_IMPLEMENTATION", // 33 chars -> truncated
  MANAGE_CLASSIC_BADI_IMPL: "MANAGE_CLASSIC_BADI_IMPLEMENTATION" // 34 chars -> truncated
}

// ------------------------------------------------------------------------------------------------
// Canonical body: the exact source the bootstrap script would install, exported by the PowerShell
// extractor (which is the only thing that knows how the script's own state shapes the body).
// ------------------------------------------------------------------------------------------------
let canonical
try {
  canonical = JSON.parse(await readFile(sourceFile, "utf8"))
} catch (error) {
  console.error(`cannot read the canonical body at ${sourceFile}`)
  console.error(
    `run: pwsh -NoLogo -NoProfile -File scripts/export-repository-helper-source.ps1 -FunctionName ${HELPER}`
  )
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
}
// Bind the marker to the target, the protocol and the body hash. 33 characters at most, inside the
// emitted `c_marker TYPE c LENGTH 40`.
MARKER = `ORVANTA REPO ${target.tag} ${canonical.declaredMaxProtocol} ${canonical.sourceSha256
  .slice(0, 8)
  .toUpperCase()}`
if (MARKER.length > 40) throw new Error(`marker exceeds c LENGTH 40: ${MARKER.length}`)

assert.equal(canonical.helper, HELPER, "canonical body is for a different helper")
assert.equal(canonical.functionGroup, FUNCTION_GROUP, "canonical body targets a different group")
const body = canonical.lines
assert.ok(Array.isArray(body) && body.length > 100, "canonical body is empty or truncated")
const declaredOperations = canonical.declaredOperations ?? []
const missingWrite = WRITE_OPERATIONS.filter((op) => !declaredOperations.includes(op))
assert.deepEqual(missingWrite, [], `canonical body does not declare: ${missingWrite.join(", ")}`)
const dispatched = (op) => body.some((l) => new RegExp(`(WHEN|OR)\\s+'${op}'`).test(l))
for (const op of WRITE_OPERATIONS) {
  assert.ok(dispatched(op), `${op} is declared but not dispatched`)
  assert.ok(
    body.some((l) => l.includes(`OPERATION|${op}`)),
    `${op} has no capability row`
  )
}
for (const op of REQUIRED_OPERATIONS) {
  assert.ok(
    body.some((l) => l.includes(`OPERATION|${op}`)),
    `${op} disappeared from the capability table: this carrier would regress the deployed helper`
  )
}
assert.ok(
  body.some((l) => l.includes(`PROTOCOL|MAX|${canonical.declaredMaxProtocol}`)),
  `the body does not publish PROTOCOL|MAX|${canonical.declaredMaxProtocol}`
)
assert.ok(
  body.some((l) => l.includes(`HELPER|${HELPER}`)),
  `the body does not self-describe as HELPER|${HELPER}`
)
// The write paths must be implemented, not just advertised.
for (const call of ["TR_INSERT_REQUEST_WITH_TASKS", "TRINT_OBJECTS_CHECK_AND_INSERT"]) {
  assert.ok(
    body.some((l) => l.includes(`'${call}'`)),
    `${call} is missing from the body`
  )
}
// Width and the installer's chunker rule. The carrier path itself only needs <= 255 columns, but the
// same body is what `New-InstallProgram` chunks, so a body that violates the installer's rules is a
// body the bootstrap path cannot deploy either.
const overlong = body.filter((l) => l.length > 72)
assert.deepEqual(overlong, [], `body has lines wider than 72 columns: ${overlong[0]}`)
assert.ok(
  !body.some((l) => /^\s{20,}/.test(l) || /\s{20,}/.test(l)),
  "body contains a 20-column whitespace run that the installer's chunker cannot carry"
)
const forbidden = body.filter((l) =>
  /\b(?:VALUE|NEW|COND|SWITCH|REDUCE|FILTER)\s*\(|\bDATA\(/.test(l)
)
assert.deepEqual(forbidden, [], `body uses ABAP 7.40+ constructor syntax: ${forbidden[0]}`)

// ------------------------------------------------------------------------------------------------
// Canonical parameter interface. The 2.8 body uses parameters the deployed 2.7 interface does not
// declare, so a body-only carrier aborts with `GENERATE failed: field "IV_TEXT_STATUS" is unknown`.
// The interface therefore travels with the carrier as the installer's own parameter statements, and
// the report merges them into the live interface before it touches the body.
// ------------------------------------------------------------------------------------------------
const interfaceLines = canonical.interfaceLines ?? {}
const importStatements = interfaceLines.import ?? []
const exportStatements = interfaceLines.export ?? []
const tableStatements = interfaceLines.tables ?? []
assert.ok(
  importStatements.length + exportStatements.length + tableStatements.length > 0,
  "the canonical JSON has no interfaceLines: re-run scripts/export-repository-helper-source.ps1"
)

// One canonical parameter per block: CLEAR ls_x. / ls_x-<field> = '..'. / APPEND ls_x TO lt_x.
const interfaceRows = []
const collectInterfaceRows = (statements, kind, table, row) => {
  let current = null
  // The canonical blocks may open or close with a bare `CLEAR ls_x.` reset, which declares nothing and
  // is therefore dropped instead of being treated as an unclosed block.
  const isReset = (block) => block !== null && !block.name && block.fields.length === 0
  for (const statement of statements) {
    if (/^CLEAR ls_\w+\.$/.test(statement)) {
      assert.ok(
        current === null || isReset(current),
        `interface statement block is not closed: ${statement}`
      )
      current = { kind, table, row, name: null, fields: [] }
      continue
    }
    assert.ok(current, `interface statement outside a parameter block: ${statement}`)
    if (/^APPEND ls_\w+ TO lt_\w+\.$/.test(statement)) {
      assert.ok(current.name, `interface block appends an unnamed parameter: ${statement}`)
      interfaceRows.push(current)
      current = null
      continue
    }
    const field = /^ls_\w+-([a-z]+) = '([^']*)'\.$/.exec(statement)
    assert.ok(field, `unexpected interface statement: ${statement}`)
    if (field[1] === "parameter") {
      assert.equal(current.name, null, `interface block declares two parameters: ${statement}`)
      current.name = field[2]
    }
    current.fields.push({ field: field[1], value: field[2] })
  }
  assert.ok(
    current === null || isReset(current),
    "the last interface statement block is not closed"
  )
}
collectInterfaceRows(importStatements, "I", "lt_fm_import", "ls_fm_import")
collectInterfaceRows(exportStatements, "E", "lt_fm_export", "ls_fm_export")
collectInterfaceRows(tableStatements, "T", "lt_fm_tables", "ls_fm_tables")
const interfaceParameters = interfaceRows.map((row) => row.name)
assert.equal(
  new Set(interfaceParameters).size,
  interfaceParameters.length,
  "the canonical interface declares a parameter twice"
)
// The body may only reference parameters the canonical interface declares; anything else has to be a
// local declaration. This is the offline form of the GENERATE error the first carrier revision hit.
const localDeclarations = new Set()
let declaring = false
for (const line of body) {
  const trimmed = line.trim()
  if (/^(?:DATA|CONSTANTS|STATICS|TYPES|FIELD-SYMBOLS|CLASS-DATA)\b/.test(trimmed)) declaring = true
  if (declaring) {
    for (const token of trimmed.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
      localDeclarations.add(token[1].toUpperCase())
    }
    if (trimmed.endsWith(".")) declaring = false
  }
}
const declaredParameters = new Set(interfaceParameters)
const referencedParameters = new Set()
for (const line of body) {
  for (const match of line.matchAll(/\b((?:IV|EV|ES|ET|CT|IT|IS|CV|CS)_[A-Z0-9_]+)\b/g)) {
    referencedParameters.add(match[1])
  }
}
// Every parameter the body references must be declared somewhere: the canonical interface, the live
// interface, or a local declaration in the body. The live interface is only known after the live read
// below, so the final decision happens there.
const referencedCandidates = [...referencedParameters].filter(
  (name) => !declaredParameters.has(name) && !localDeclarations.has(name)
)

// ------------------------------------------------------------------------------------------------
// SOURCE|HASH: the installer hashes the body while its four 16-character placeholders are still in
// place and then writes the digest into them (no length change), so reproduce that exactly or the
// deployed helper would publish the literal placeholders.
// ------------------------------------------------------------------------------------------------
const HASH_SLOTS = ["ORVANTAHASHSLOT1", "ORVANTAHASHSLOT2", "ORVANTAHASHSLOT3", "ORVANTAHASHSLOT4"]
const withPlaceholders = body.join("\n")
assert.ok(
  withPlaceholders.includes(HASH_SLOTS[0]),
  "the canonical body has no SOURCE|HASH placeholders; the hash would be missing from the payload"
)
const sourceHash = createHash("sha256").update(withPlaceholders, "utf8").digest("hex")
const hashedBody = body.map((line) =>
  HASH_SLOTS.reduce(
    (acc, slot, index) => acc.replace(slot, sourceHash.slice(index * 16, index * 16 + 16)),
    line
  )
)
assert.ok(
  !hashedBody.join("\n").includes("ORVANTAHASHSLOT"),
  "a hash placeholder survived substitution"
)
assert.equal(
  hashedBody.join("\n").length,
  withPlaceholders.length,
  "hash substitution changed the body length"
)

// ------------------------------------------------------------------------------------------------
// Live pre-flight: the report must be generated against the helper that is actually deployed.
// ------------------------------------------------------------------------------------------------
let live = null
if (!offline) {
  const client = new Client({ name: "repository-carrier-generator", version: "1.0.0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)))
  const read = await client.callTool(
    {
      name: "read_function_module_interface",
      arguments: { connectionId: "w200", functionName: HELPER }
    },
    undefined,
    { timeout: 300000 }
  )
  assert.equal(read.isError ?? false, false, "reading the live helper failed")
  const payload = JSON.parse((read.content ?? []).map((c) => c.text ?? "").join(""))
  live = payload.source ?? []
  // The save API is called dynamically, so ABAP type-checks every actual parameter against the
  // formal parameter's DDIC type at runtime and terminates with CALL_FUNCTION_CONFLICT_TYPE on a
  // mismatch - that is how `CORRNUM TYPE C LENGTH 10` failed its F8 run. Compare the declared types
  // of the carrier's own variables against SAP's interface here.
  const passedTypes = {
    FUNCTION_SAVE: [["P_RS38L", "ls_rs38l", "rs38l"]]
  }
  for (const [api, expectations] of Object.entries(passedTypes)) {
    const apiRead = await client.callTool(
      {
        name: "read_function_module_interface",
        arguments: { connectionId: "w200", functionName: api }
      },
      undefined,
      { timeout: 300000 }
    )
    assert.equal(apiRead.isError ?? false, false, `reading ${api} failed`)
    const apiInterface = JSON.parse((apiRead.content ?? []).map((c) => c.text ?? "").join(""))
    const apiTypes = new Map(
      (apiInterface.importParameters ?? []).map((p) => [p.name, String(p.typeName).toLowerCase()])
    )
    for (const [formal, actual, declared] of expectations) {
      // An empty type name means SAP did not report one (SHORT_TEXT is like that), so only what the
      // live interface actually states can be asserted; the rest stays a runtime risk.
      if (!apiTypes.get(formal)) continue
      assert.equal(
        apiTypes.get(formal),
        declared,
        `${api} ${formal} is ${apiTypes.get(formal)} in SAP but the carrier passes ${actual} TYPE ${declared}`
      )
    }
  }
  await client.close()

  assert.equal(live[0].trim(), `FUNCTION ${HELPER}.`, `unexpected live first line: ${live[0]}`)
  assert.match(String(live.at(-1)).trim(), /^ENDFUNCTION\./i, "unexpected live last line")
  const liveText = live.join("\n")
  // The deployed interface is authoritative for the parameters the carrier does not extend, so the
  // body may reference anything the live helper already names. A name that appears nowhere is a real
  // gap: the deployed body would fail to generate exactly like the first carrier revision did.
  const liveNames = new Set()
  for (const match of liveText.matchAll(/\b((?:IV|EV|ES|ET|CT|IT|IS|CV|CS)_[A-Z0-9_]+)\b/g)) {
    liveNames.add(match[1])
  }
  const undeclared = referencedCandidates.filter((name) => !liveNames.has(name))
  assert.deepEqual(
    undeclared,
    [],
    `the body references parameter(s) that neither the live interface nor this carrier declares: ${undeclared
      .slice(0, 6)
      .join(", ")}`
  )
  // Carrier ordering invariant (.doc/d6-carrier-ordering-invariant.md): a carrier replaces the whole
  // body, so it may only be applied on top of a helper that already contains every predecessor
  // change. The repository family deployed 2.7 as its highest protocol (2026-09-23); every protocol
  // that a predecessor carrier may have left behind is listed here, because leaving one out makes
  // every subsequent run abort on its own precondition.
  assert.ok(
    ["2.5", "2.6", "2.7", "2.8"].some((protocol) => liveText.includes(`PROTOCOL|MAX|${protocol}`)),
    "the deployed helper is not at protocol 2.5, 2.6, 2.7 or 2.8: apply the previous carrier first"
  )
  // Operations already deployed must survive the replacement; operations this carrier introduces
  // cannot exist yet, so requiring them live would make the carrier ungeneratable. The capability
  // table's own sinceVersion decides which is which, instead of a hand-maintained exemption list.
  const versionRank = (v) =>
    String(v)
      .split(".")
      .map(Number)
      .reduce((a, b) => a * 1000 + b, 0)
  const introduced = (canonical.declaredOperationRows ?? [])
    .filter((row) => versionRank(row.version) >= versionRank(canonical.declaredMaxProtocol))
    .map((row) => row.opcode)
  for (const op of REQUIRED_OPERATIONS) {
    if (introduced.includes(op)) continue
    assert.ok(
      live.some((l) => l.includes(`OPERATION|${op}`)),
      `the deployed helper lost ${op}: this carrier would regress it`
    )
  }
  console.log(`introduced by this carrier: ${introduced.join(", ") || "(nothing new)"}`)
  // A carrier whose body already matches SAP is pointless and must not run, but a carrier whose body
  // differs is a revision - exactly what this script is for. Compare the installed body region
  // instead; the generator still refuses to build a body that lacks the write operations (asserted
  // above), so a revision cannot regress them.
  const normalizeBodyLine = (line) => String(line).replace(/\s+$/, "")
  const installedBody = live.slice(live.length - 1 - hashedBody.length, live.length - 1)
  const differentLines = hashedBody.filter(
    (line, index) => normalizeBodyLine(installedBody[index]) !== normalizeBodyLine(line)
  ).length
  assert.ok(
    installedBody.length !== hashedBody.length || differentLines > 0,
    "the deployed helper body already matches this canonical body: nothing to do, do not re-apply"
  )
  console.log(
    `body revision: ${differentLines} of ${hashedBody.length} body lines differ from the installed body`
  )
  const selfDescription = (lines) =>
    lines.filter((l) => /'(?:HELPER|PROTOCOL|SOURCE)\|/.test(l)).map((l) => l.trim())
  const liveRows = selfDescription(live)
  const canonicalRows = selfDescription(hashedBody)
  const identityKeys = ["HELPER|", "PROTOCOL|MIN|", "PROTOCOL|MAX|", "PACKAGE|", "TRANSPORT|"]
  console.log("self-description rows (canonical vs live) - review before F8:")
  for (const key of identityKeys) {
    const canonicalRow = canonicalRows
      .find((row) => row.includes(key))
      ?.replace(/^ls_source-line = /, "")
    const liveRow = liveRows.find((row) => row.includes(key))?.replace(/^ls_source-line = /, "")
    const state = canonicalRow === liveRow ? "same" : "CHANGED"
    console.log(`  ${state.padEnd(7)} ${key.padEnd(15)} canonical=${canonicalRow} live=${liveRow}`)
  }
  console.log(
    `live helper: ${live.length} lines, baseline digest ${createHash("sha256")
      .update(live.join("\n"), "utf8")
      .digest("hex")
      .slice(0, 16)}`
  )
  console.log(`payload    : ${hashedBody.length} body lines + wrapper`)

  // A full-body rebuild must never silently drop SAP-side code. Compare at token level: a live-only
  // line whose distinctive tokens all exist in the canonical body differs only in statement shape or
  // wrapping, while absent tokens mean content the script does not have - i.e. a fix that was applied
  // in SAP through a carrier and never back-ported. Refuse to generate in that case.
  const isCommentOrBlank = (line) => {
    const text = line.trim()
    return text === "" || text.startsWith("*") || text.startsWith('"')
  }
  const codeOf = (lines) => lines.filter((l) => !isCommentOrBlank(l)).map((l) => l.trim())
  const normalize = (line) => line.replace(/\s+/g, " ").trim()
  const canonicalCode = codeOf(hashedBody)
  const canonicalNormalized = new Set(canonicalCode.map(normalize))
  const canonicalText = canonicalCode.join("\n")
  const keylessTokens = new Set([
    "CONCATENATE",
    "INTO",
    "EXPORTING",
    "IMPORTING",
    "TABLES",
    "ASSIGNING",
    "LOOP",
    "ENDLOOP",
    "WITH",
    "KEY",
    "SEPARATED",
    "IS",
    "INITIAL",
    "AND",
    "OR",
    "IF",
    "ENDIF",
    "ADD_PAYLOAD",
    "TABNAME",
    "FIELDNAME",
    "ENDFUNCTION",
    "CLEAR",
    "APPEND",
    "READ",
    "TABLE",
    "INDEX",
    "MODIFY",
    "SELECT"
  ])
  const tokens = (line) => [
    ...new Set(
      (line.match(/[A-Za-z_<>\-][A-Za-z0-9_<>\-]{3,}/g) ?? []).filter(
        (t) => !keylessTokens.has(t.toUpperCase())
      )
    )
  ]
  const benign = (line) =>
    line.startsWith("FUNCTION ") ||
    line.includes("'SOURCE|HASH|'") ||
    /^'[0-9a-f]{16}'/.test(line) ||
    line.includes("'OPERATION|")
  const regressions = []
  const reviewedRenames = []
  for (const line of new Set(codeOf(live).map(normalize))) {
    if (canonicalNormalized.has(line) || benign(line)) continue
    // A line that carries an operation name this carrier renames is an intentional replacement, not
    // a lost live fix.
    const rename = Object.entries(SUPERSEDED_OPERATIONS).find(([, old]) => line.includes(old))
    if (rename) {
      reviewedRenames.push(`  ${line}  [renamed: ${rename[1]} -> ${rename[0]}]`)
      continue
    }
    const missing = tokens(line).filter((t) => !canonicalText.includes(t))
    if (missing.length > 0) regressions.push(`${line}  [absent: ${missing.join(", ")}]`)
  }
  if (reviewedRenames.length > 0) {
    console.log(`reviewed operation renames (${reviewedRenames.length} live line(s) replaced):`)
    for (const line of reviewedRenames) console.log(line)
  }
  if (regressions.length > 0) {
    console.error("")
    console.error(
      `REFUSING TO GENERATE: the canonical body would drop ${regressions.length} live line(s).`
    )
    for (const line of regressions.slice(0, 20)) console.error(`  ${line}`)
    if (regressions.length > 20) console.error(`  ... ${regressions.length - 20} more`)
    console.error("")
    console.error("These are fixes that exist in SAP but not in scripts/bootstrap-sap-helper.ps1.")
    console.error("Back-port them, then regenerate. --accept-live-differences overrides this only")
    console.error("after a human review.")
    if (!argv.includes("--accept-live-differences")) process.exit(5)
    console.error("--accept-live-differences given: continuing with the differences above.")
  } else {
    console.log("regression guard: no live code line is absent from the canonical body")
  }
}

// A body that declares the same name twice cannot be compiled. Catch it here instead of spending a
// human F8 round on a GENERATE error.
{
  const declared = new Map()
  let duplicate = false
  for (const [index, line] of hashedBody.entries()) {
    const match =
      /^\s*(DATA|TYPES|CONSTANTS|STATICS|FIELD-SYMBOLS)\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(line)
    if (!match) continue
    const key = match[2].toUpperCase()
    if (declared.has(key)) {
      console.error("")
      console.error(`REFUSING TO GENERATE: ${key} is declared twice in the canonical body.`)
      console.error(`  line ${declared.get(key) + 1}: ${hashedBody[declared.get(key)].trim()}`)
      console.error(`  line ${index + 1}: ${line.trim()}`)
      duplicate = true
      continue
    }
    declared.set(key, index)
  }
  if (duplicate) {
    console.error("")
    process.exit(6)
  }
  console.log(`declaration guard: ${declared.size} declarations, no duplicate names`)
}

// ------------------------------------------------------------------------------------------------
// Render the report. The carrier deploys in two phases, because the 2.8 body needs both a new
// parameter interface and a new body:
//
//   phase A (interface) - RPY_FUNCTIONMODULE_READ the live interface, append every canonical parameter
//     that is missing, write it back with RPY_FUNCTIONMODULE_INSERT (the same API the helper's
//     CREATE_FUNCTION_MODULE branch uses) while passing the source back unchanged, then re-read and
//     verify. A classic function module keeps its parameters in the function module's parameter
//     tables, not in the include text, so this is the only way to extend the interface.
//   phase B (body) - re-read the include, keep every line up to the end of the parameter interface and
//     splice the canonical body after it (INSERT REPORT + GENERATE), exactly as the earlier revision
//     did. Replacing the whole include would drop the interface comment block: the DDIC carrier
//     learned that the expensive way.
// ------------------------------------------------------------------------------------------------
const payload = [`FUNCTION ${HELPER}.`, ...hashedBody, "ENDFUNCTION."]
const bodyLines = hashedBody
const payloadDigest = createHash("sha256")
  .update(payload.join("\n"), "utf8")
  .digest("hex")
  .slice(0, 16)
const literal = (s) => `'${String(s).replace(/'/g, "''")}'`

const report = []
report.push(`REPORT ${PROGRAM.toLowerCase()}.`)
report.push("")
report.push("* GENERATED by scripts/generate-repository-carrier.mjs -- do not edit by hand.")
report.push(`* ${MARKER}`)
report.push(`* Target   : ${HELPER} (${FUNCTION_GROUP})`)
report.push(
  `* Transport: ${canonical.transport || "(none recorded)"} (recorded; never released by this report)`
)
report.push(
  live
    ? `* Baseline : ${live.length} live lines; this report pins that count, then extends the interface`
    : "* Baseline : NOT READ (generated with --offline); the report does not pin the current line count"
)
report.push(
  `* Deploys  : the CANONICAL body - protocol up to ${canonical.declaredMaxProtocol}, ${canonical.declaredOperations.length} operations.`
)
report.push(
  "*            This is a full-body carrier, not a feature-specific patch: whatever the canonical"
)
report.push(
  "*            body currently declares is what SAP ends up with. The generator asserts the write"
)
report.push("*            paths below are present, so replacing the body cannot regress them:")
report.push(`*              ${WRITE_OPERATIONS.join(", ")}`)
report.push(`*            required (must not disappear): ${REQUIRED_OPERATIONS.join(", ")}`)
report.push(
  `*            ${body.length} lines from scripts/bootstrap-sap-helper.ps1 (${canonical.sourceSha256.slice(0, 16)})`
)
report.push(`* Hash     : SOURCE|HASH recomputed as the installer does -> ${sourceHash}`)
report.push(`* Digest   : payload sha256 -> ${payloadDigest}`)
report.push(
  "* Apply    : A) extend the live interface with the canonical parameters below and verify by"
)
report.push(
  "*            re-reading it; B) re-read the include, keep every line up to the end of the"
)
report.push(
  "*            parameter interface, splice the body after it, then INSERT REPORT + GENERATE."
)
report.push(
  `* Params   : ${interfaceParameters.length} canonical parameter(s) travel with this carrier.`
)
report.push("")
report.push(`CONSTANTS: c_group  TYPE c LENGTH 30 VALUE ${literal(FUNCTION_GROUP)},`)
report.push(`           c_marker TYPE c LENGTH 40 VALUE ${literal(MARKER)},`)
report.push(`           c_func   TYPE c LENGTH 30 VALUE ${literal(HELPER)},`)
report.push(`           c_request TYPE e071-trkorr VALUE ${literal(canonical.transport ?? "")},`)
report.push(`           c_hash   TYPE c LENGTH 16 VALUE '${sourceHash.slice(0, 16)}',`)
report.push(`           c_digest TYPE c LENGTH 16 VALUE '${payloadDigest}'${live ? "," : "."}`)
if (live) report.push(`           c_lines  TYPE i VALUE ${live.length}.`)
report.push("")
report.push("DATA: lt_new TYPE TABLE OF abaptxt255,")
report.push("      lt_body TYPE TABLE OF abaptxt255,")
report.push("      lt_cur TYPE TABLE OF abaptxt255,")
report.push("      ls_new TYPE abaptxt255,")
report.push("      ls_cur TYPE abaptxt255,")
report.push("      lv_name TYPE c LENGTH 30,")
report.push("      lv_head TYPE c LENGTH 20,")
report.push("      lv_found TYPE c LENGTH 1,")
report.push("      lv_count TYPE i,")
report.push("      lv_keep TYPE i,")
report.push("      lv_in_interface TYPE c LENGTH 1,")
report.push("      lv_line TYPE string,")
report.push("      lv_suffix TYPE tfdir-include,")
report.push("      lv_msg TYPE string,")
report.push("      lv_msg_line TYPE i,")
report.push("      lv_msg_word TYPE string.")
report.push("")
report.push(
  "* The canonical parameter interface: one row per parameter the 2.8 body needs. I = IMPORTING,"
)
report.push(
  "* E = EXPORTING, T = TABLES; dbfield/optional/dbstruct mirror the installer's own rows."
)
report.push("TYPES: BEGIN OF ty_canonical,")
report.push("         kind TYPE c LENGTH 1,")
report.push("         name TYPE rsimp-parameter,")
report.push("         dbfield TYPE rsimp-dbfield,")
report.push("         optional TYPE rsimp-optional,")
report.push("         dbstruct TYPE rstbl-dbstruct,")
report.push("       END OF ty_canonical.")
report.push("")
report.push("DATA: lt_canonical TYPE TABLE OF ty_canonical,")
report.push("      ls_canonical TYPE ty_canonical,")
report.push("      lt_fm_import TYPE TABLE OF rsimp,")
report.push("      ls_fm_import TYPE rsimp,")
report.push("      lt_fm_export TYPE TABLE OF rsexp,")
report.push("      ls_fm_export TYPE rsexp,")
report.push("      lt_fm_tables TYPE TABLE OF rstbl,")
report.push("      ls_fm_tables TYPE rstbl,")
report.push("      lt_fm_change TYPE TABLE OF rscha,")
report.push("      lt_fm_except TYPE TABLE OF rsexc,")
report.push("      lt_fm_docu TYPE TABLE OF rsfdo,")
report.push("      lt_fm_source TYPE TABLE OF rssource,")
report.push("      lv_func TYPE rs38l-name,")
report.push("      lv_pool TYPE rs38l-area,")
report.push("      lv_remote TYPE rs38l-remote,")
report.push("      lv_short TYPE tftit-stext,")
report.push("      lv_global TYPE rs38l-global,")
report.push("      lv_update TYPE rs38l-utask,")
report.push("      lv_present TYPE c LENGTH 1,")
report.push("      lv_missing TYPE i,")
report.push("      lv_missing_new TYPE i,")
report.push("      ls_rs38l TYPE rs38l,")
report.push("      ls_tfdir TYPE tfdir,")
report.push("      lv_fm_include TYPE rs38l-include,")
report.push("      lv_fm_lock_mode TYPE enqmode VALUE 'X',")
report.push("      lv_save_rc TYPE i,")
report.push("      lv_save_msgid TYPE sy-msgid,")
report.push("      lv_save_msgno TYPE sy-msgno,")
report.push("      lv_save_v1 TYPE sy-msgv1,")
report.push("      lv_save_v2 TYPE sy-msgv2,")
report.push("      lv_wa_object TYPE e071-object,")
report.push("      lv_wa_name TYPE e071-obj_name,")
report.push("      lv_wa_type TYPE sabap_objtype,")
report.push("      lv_wa_abname TYPE sabap_objname,")
report.push("      lv_wa_length TYPE i,")
report.push("      lv_added TYPE i.")
report.push("")
report.push("START-OF-SELECTION.")
report.push(`  WRITE: / '${MARKER}'.`)
report.push("  WRITE: / 'Target      :', c_group.")
report.push(`  WRITE: / 'Helper      :' , '${HELPER}'.`)
report.push(`  WRITE: / 'Body        :', ${bodyLines.length}, 'lines; digest', c_digest.`)
report.push("  SKIP 1.")
report.push("")
report.push("  REFRESH lt_body.")
for (const line of bodyLines)
  report.push(`  CLEAR ls_new. ls_new-line = ${literal(line)}. APPEND ls_new TO lt_body.`)
report.push("")
report.push("  DESCRIBE TABLE lt_body LINES lv_count.")
report.push(`  IF lv_count <> ${bodyLines.length}.`)
report.push("    WRITE: / 'ERROR: body line count mismatch:', lv_count.")
report.push("    RETURN.")
report.push("  ENDIF.")
report.push("")
report.push(`  SELECT SINGLE include FROM tfdir INTO lv_suffix WHERE funcname = '${HELPER}'.`)
report.push("  IF sy-subrc <> 0 OR lv_suffix IS INITIAL.")
report.push(`    WRITE: / 'ERROR: function module ${HELPER} not found in TFDIR'.`)
report.push("    RETURN.")
report.push("  ENDIF.")
report.push("  CONCATENATE 'L' c_group 'U' lv_suffix INTO lv_name.")
report.push("  REFRESH lt_cur.")
report.push("  READ REPORT lv_name INTO lt_cur.")
report.push("  IF sy-subrc <> 0 OR lt_cur IS INITIAL.")
report.push("    WRITE: / 'ERROR: cannot read function group include', lv_name.")
report.push("    RETURN.")
report.push("  ENDIF.")
report.push("  DESCRIBE TABLE lt_cur LINES lv_count.")
report.push("")
report.push(
  "* Idempotency: refuse to apply this carrier twice. The marker only exists in this report's"
)
report.push("* header, so the deployed body is recognised by the SOURCE|HASH it publishes as well.")
report.push("  CLEAR lv_found.")
report.push("  LOOP AT lt_cur INTO ls_cur.")
report.push("    IF ls_cur-line CS c_marker OR ls_cur-line CS c_hash.")
report.push("      lv_found = 'X'. EXIT.")
report.push("    ENDIF.")
report.push("  ENDLOOP.")
report.push("  IF lv_found = 'X'.")
report.push("    WRITE: / 'NOTHING TO DO: this carrier is already applied.'.")
report.push("    RETURN.")
report.push("  ENDIF.")
report.push("")
if (live) {
  report.push("* Baseline guard: the body was generated against this exact live include.")
  report.push(`  IF lv_count <> c_lines.`)
  report.push(
    "    WRITE: / 'ERROR: deployed include is not the reviewed baseline:', lv_count, c_lines."
  )
  report.push("    WRITE: / 'Regenerate the carrier against the live source before applying.'.")
  report.push("    RETURN.")
  report.push("  ENDIF.")
  report.push("")
}
// ---- phase A: extend the parameter interface ----------------------------------------------------
report.push(
  "* ---- A) canonical parameter interface ------------------------------------------------"
)
report.push("  REFRESH: lt_canonical, lt_fm_import, lt_fm_export, lt_fm_tables,")
report.push("    lt_fm_change, lt_fm_except, lt_fm_docu, lt_fm_source.")
for (const row of interfaceRows) {
  report.push(`  CLEAR ls_canonical. ls_canonical-kind = '${row.kind}'.`)
  report.push(`  ls_canonical-name = ${literal(row.name)}.`)
  for (const field of row.fields) {
    if (field.field === "parameter") continue
    report.push(`  ls_canonical-${field.field} = ${literal(field.value)}.`)
  }
  report.push("  APPEND ls_canonical TO lt_canonical.")
}
report.push("")
report.push("  lv_func = c_func.")
report.push("  CLEAR: lv_pool, lv_remote, lv_short, lv_global, lv_update.")
report.push("  CALL FUNCTION 'RPY_FUNCTIONMODULE_READ'")
report.push("    EXPORTING")
report.push("      functionname = lv_func")
report.push("    IMPORTING")
report.push("      global_flag = lv_global")
report.push("      remote_call = lv_remote")
report.push("      update_task = lv_update")
report.push("      short_text = lv_short")
report.push("      function_pool = lv_pool")
report.push("    TABLES")
report.push("      import_parameter = lt_fm_import")
report.push("      changing_parameter = lt_fm_change")
report.push("      export_parameter = lt_fm_export")
report.push("      tables_parameter = lt_fm_tables")
report.push("      exception_list = lt_fm_except")
report.push("      documentation = lt_fm_docu")
report.push("      source = lt_fm_source")
report.push("    EXCEPTIONS")
report.push("      OTHERS = 1.")
report.push("  IF sy-subrc <> 0.")
report.push("    WRITE: / 'ERROR: cannot read the function module interface', sy-subrc.")
report.push("    RETURN.")
report.push("  ENDIF.")
report.push("  IF lv_pool IS INITIAL. lv_pool = c_group. ENDIF.")
report.push("  IF lv_remote IS INITIAL. lv_remote = 'R'. ENDIF.")
report.push("  IF lv_short IS INITIAL. lv_short = 'ORVANTA MCP controlled entry point'. ENDIF.")
report.push("")
report.push(
  "* Append only what is missing: the live interface stays the base, so no parameter can be lost."
)
report.push("  CLEAR lv_added.")
report.push("  LOOP AT lt_canonical INTO ls_canonical.")
report.push("    CLEAR lv_present.")
report.push("    CASE ls_canonical-kind.")
report.push("      WHEN 'I'.")
report.push("        LOOP AT lt_fm_import TRANSPORTING NO FIELDS")
report.push("          WHERE parameter = ls_canonical-name.")
report.push("          lv_present = 'X'. EXIT.")
report.push("        ENDLOOP.")
report.push("      WHEN 'E'.")
report.push("        LOOP AT lt_fm_export TRANSPORTING NO FIELDS")
report.push("          WHERE parameter = ls_canonical-name.")
report.push("          lv_present = 'X'. EXIT.")
report.push("        ENDLOOP.")
report.push("      WHEN 'T'.")
report.push("        LOOP AT lt_fm_tables TRANSPORTING NO FIELDS")
report.push("          WHERE parameter = ls_canonical-name.")
report.push("          lv_present = 'X'. EXIT.")
report.push("        ENDLOOP.")
report.push("    ENDCASE.")
report.push("    IF lv_present IS INITIAL.")
report.push("      CASE ls_canonical-kind.")
report.push("        WHEN 'I'.")
report.push("          CLEAR ls_fm_import.")
report.push("          ls_fm_import-parameter = ls_canonical-name.")
report.push("          ls_fm_import-dbfield = ls_canonical-dbfield.")
report.push("          ls_fm_import-optional = ls_canonical-optional.")
report.push("          APPEND ls_fm_import TO lt_fm_import.")
report.push("        WHEN 'E'.")
report.push("          CLEAR ls_fm_export.")
report.push("          ls_fm_export-parameter = ls_canonical-name.")
report.push("          ls_fm_export-dbfield = ls_canonical-dbfield.")
report.push("          APPEND ls_fm_export TO lt_fm_export.")
report.push("        WHEN 'T'.")
report.push("          CLEAR ls_fm_tables.")
report.push("          ls_fm_tables-parameter = ls_canonical-name.")
report.push("          ls_fm_tables-dbstruct = ls_canonical-dbstruct.")
report.push("          APPEND ls_fm_tables TO lt_fm_tables.")
report.push("      ENDCASE.")
report.push("      lv_added = lv_added + 1.")
report.push("      WRITE: / 'Interface + :', ls_canonical-name.")
report.push("    ENDIF.")
report.push("  ENDLOOP.")
report.push("")
report.push("  IF lv_added > 0.")
report.push(
  "* RPY_FUNCTIONMODULE_INSERT and FUNCTION_CREATE are both create-only - the first stops with"
)
report.push(
  "* FL 050 '& already exists', the second raises FUNCTION_ALREADY_EXISTS (FL 800) - so the existing"
)
report.push(
  "* function module is updated through FUNCTION_SAVE. That call is SE37's save path - a 28 line"
)
report.push(
  "* wrapper around PERFORM FU_SAVE_FUNCTION_EXT(SAPMS38L) - and it reports FL 230 ('& is being"
)
report.push(
  "* edited by user &') while the module is in an editing state. Try the plain save first, exactly"
)
report.push(
  "* as SE37 does it, then repeat it after registering the module in the workbench working area"
)
report.push("* the same way FUNCTION_CREATE does before its own save.")
report.push("    CALL FUNCTION 'DEQUEUE_ESFUNCTION'")
report.push("      EXPORTING")
report.push("        funcname = lv_func.")
report.push("    CLEAR ls_tfdir.")
report.push("    SELECT SINGLE * FROM tfdir INTO ls_tfdir")
report.push("      WHERE funcname = lv_func.")
report.push("    IF sy-subrc <> 0.")
report.push("      WRITE: / 'ERROR: TFDIR has no entry for', lv_func.")
report.push("      RETURN.")
report.push("    ENDIF.")
report.push(
  "* TFDIR-INCLUDE holds the two digit include suffix; RS38L-INCLUDE and the workbench entries"
)
report.push(
  "* use the three character form U<nn>, whose first character is the V / $ variant switch."
)
report.push("    CONCATENATE 'U' lv_suffix INTO lv_fm_include.")
report.push("    CLEAR ls_rs38l.")
report.push("    ls_rs38l-name = lv_func.")
report.push("    ls_rs38l-area = lv_pool.")
report.push("    ls_rs38l-global = lv_global.")
report.push("    ls_rs38l-remote = lv_remote.")
report.push("    ls_rs38l-utask = lv_update.")
report.push("    ls_rs38l-include = lv_fm_include.")
report.push("    ls_rs38l-active = 'A'.")
report.push("    ls_rs38l-generated = 'X'.")
report.push("    SET PARAMETER ID 'EUA' FIELD c_request.")
report.push("    PERFORM save_interface.")
report.push("    IF lv_save_rc <> 0.")
report.push(
  "      WRITE: / 'Attempt 1   : plain save failed', lv_save_rc, lv_save_msgid, lv_save_msgno,"
)
report.push("        'v1', lv_save_v1, 'v2', lv_save_v2.")
report.push("      PERFORM register_working_area.")
report.push("      PERFORM save_interface.")
report.push("    ENDIF.")
report.push("    IF lv_save_rc <> 0.")
report.push(
  "      WRITE: / 'ERROR: the interface extension failed', lv_save_rc, lv_save_msgid, lv_save_msgno,"
)
report.push("        'v1', lv_save_v1, 'v2', lv_save_v2.")
report.push("      CALL FUNCTION 'DEQUEUE_ESFUNCTION' EXPORTING funcname = lv_func.")
report.push("      ROLLBACK WORK.")
report.push("      RETURN.")
report.push("    ENDIF.")
report.push("    CALL FUNCTION 'DEQUEUE_ESFUNCTION'")
report.push("      EXPORTING")
report.push("        funcname = lv_func.")
report.push("    COMMIT WORK AND WAIT.")
report.push("    WRITE: / 'Interface   : +', lv_added, 'canonical parameter(s) written.'.")
report.push("  ELSE.")
report.push("    WRITE: / 'Interface   : all canonical parameters already present.'.")
report.push("  ENDIF.")
report.push("")
report.push("* Verify the interface from SAP, not from the in-memory tables.")
report.push("  REFRESH: lt_fm_import, lt_fm_export, lt_fm_tables.")
report.push("  CALL FUNCTION 'RPY_FUNCTIONMODULE_READ'")
report.push("    EXPORTING")
report.push("      functionname = lv_func")
report.push("    IMPORTING")
report.push("      global_flag = lv_global")
report.push("      remote_call = lv_remote")
report.push("      update_task = lv_update")
report.push("      short_text = lv_short")
report.push("      function_pool = lv_pool")
report.push("    TABLES")
report.push("      import_parameter = lt_fm_import")
report.push("      changing_parameter = lt_fm_change")
report.push("      export_parameter = lt_fm_export")
report.push("      tables_parameter = lt_fm_tables")
report.push("      exception_list = lt_fm_except")
report.push("      documentation = lt_fm_docu")
report.push("      source = lt_fm_source")
report.push("    EXCEPTIONS")
report.push("      OTHERS = 1.")
report.push("  IF sy-subrc <> 0.")
report.push("    WRITE: / 'ERROR: cannot re-read the function module interface', sy-subrc.")
report.push("    RETURN.")
report.push("  ENDIF.")
report.push("  CLEAR lv_missing.")
report.push("  LOOP AT lt_canonical INTO ls_canonical.")
report.push("    CLEAR lv_present.")
report.push("    CASE ls_canonical-kind.")
report.push("      WHEN 'I'.")
report.push("        LOOP AT lt_fm_import TRANSPORTING NO FIELDS")
report.push("          WHERE parameter = ls_canonical-name.")
report.push("          lv_present = 'X'. EXIT.")
report.push("        ENDLOOP.")
report.push("      WHEN 'E'.")
report.push("        LOOP AT lt_fm_export TRANSPORTING NO FIELDS")
report.push("          WHERE parameter = ls_canonical-name.")
report.push("          lv_present = 'X'. EXIT.")
report.push("        ENDLOOP.")
report.push("      WHEN 'T'.")
report.push("        LOOP AT lt_fm_tables TRANSPORTING NO FIELDS")
report.push("          WHERE parameter = ls_canonical-name.")
report.push("          lv_present = 'X'. EXIT.")
report.push("        ENDLOOP.")
report.push("    ENDCASE.")
report.push("    IF lv_present IS INITIAL.")
report.push("      lv_missing = lv_missing + 1.")
report.push(
  "      WRITE: / 'ERROR: interface parameter missing after the update:', ls_canonical-name."
)
report.push("    ENDIF.")
report.push("  ENDLOOP.")
report.push(
  "* Report the INACTIVE version too: it separates 'the write never landed' from 'the write landed"
)
report.push(
  "* but was not activated', which is the difference the first interface revision ran into."
)
report.push("  REFRESH: lt_fm_import, lt_fm_export, lt_fm_tables.")
report.push("  CALL FUNCTION 'RPY_FUNCTIONMODULE_READ_NEW'")
report.push("    EXPORTING")
report.push("      functionname = lv_func")
report.push("    IMPORTING")
report.push("      global_flag = lv_global")
report.push("      remote_call = lv_remote")
report.push("      update_task = lv_update")
report.push("      short_text = lv_short")
report.push("      function_pool = lv_pool")
report.push("    TABLES")
report.push("      import_parameter = lt_fm_import")
report.push("      changing_parameter = lt_fm_change")
report.push("      export_parameter = lt_fm_export")
report.push("      tables_parameter = lt_fm_tables")
report.push("      exception_list = lt_fm_except")
report.push("      documentation = lt_fm_docu")
report.push("      source = lt_fm_source")
report.push("    EXCEPTIONS")
report.push("      OTHERS = 1.")
report.push("  IF sy-subrc = 0.")
report.push("    CLEAR lv_missing_new.")
report.push("    LOOP AT lt_canonical INTO ls_canonical.")
report.push("      CLEAR lv_present.")
report.push("      CASE ls_canonical-kind.")
report.push("        WHEN 'I'.")
report.push("          LOOP AT lt_fm_import TRANSPORTING NO FIELDS")
report.push("            WHERE parameter = ls_canonical-name.")
report.push("            lv_present = 'X'. EXIT.")
report.push("          ENDLOOP.")
report.push("        WHEN 'E'.")
report.push("          LOOP AT lt_fm_export TRANSPORTING NO FIELDS")
report.push("            WHERE parameter = ls_canonical-name.")
report.push("            lv_present = 'X'. EXIT.")
report.push("          ENDLOOP.")
report.push("        WHEN 'T'.")
report.push("          LOOP AT lt_fm_tables TRANSPORTING NO FIELDS")
report.push("            WHERE parameter = ls_canonical-name.")
report.push("            lv_present = 'X'. EXIT.")
report.push("          ENDLOOP.")
report.push("      ENDCASE.")
report.push("      IF lv_present IS INITIAL.")
report.push("        lv_missing_new = lv_missing_new + 1.")
report.push("      ENDIF.")
report.push("    ENDLOOP.")
report.push(
  "    WRITE: / 'Interface   : inactive version lacks', lv_missing_new, 'canonical parameter(s).'."
)
report.push("  ELSE.")
report.push("    WRITE: / 'Interface   : no inactive version readable', sy-subrc.")
report.push("  ENDIF.")
report.push("  IF lv_missing > 0.")
report.push(
  "    WRITE: / 'ERROR: the interface still lacks', lv_missing, 'canonical parameter(s).'."
)
report.push("    WRITE: / '  the body was not touched; fix the interface before re-running.'.")
report.push("    RETURN.")
report.push("  ENDIF.")
report.push(
  "  DESCRIBE TABLE lt_canonical LINES lv_count.",
  "  WRITE: / 'Interface   : verified', lv_count, 'canonical parameter(s) in SAP.'."
)
report.push("")
report.push(
  "* ---- B) canonical body ---------------------------------------------------------------"
)
report.push(
  "* Re-read the include: phase A rewrites the interface while keeping the source unchanged."
)
report.push("  REFRESH lt_cur.")
report.push("  READ REPORT lv_name INTO lt_cur.")
report.push("  IF sy-subrc <> 0 OR lt_cur IS INITIAL.")
report.push("    WRITE: / 'ERROR: cannot re-read the function group include', lv_name.")
report.push("    RETURN.")
report.push("  ENDIF.")
report.push("  DESCRIBE TABLE lt_cur LINES lv_count.")
report.push("  WRITE: / 'Body phase  : include has', lv_count, 'lines after the interface phase.'.")
report.push("")
report.push("  READ TABLE lt_cur INTO ls_cur INDEX 1.")
report.push("  lv_head = ls_cur-line.")
report.push("  TRANSLATE lv_head TO UPPER CASE.")
report.push("  IF lv_head(8) <> 'FUNCTION'.")
report.push("    WRITE: / 'ERROR: existing include does not start with FUNCTION'.")
report.push("    RETURN.")
report.push("  ENDIF.")
report.push("")
report.push("* Locate the end of the parameter interface: keep it, replace only the body after it.")
report.push(
  "* A source-based interface opens with IMPORTING/EXPORTING/CHANGING/TABLES and closes with"
)
report.push("* the first period; a classic interface closes with its own separator line.")
report.push("  CLEAR: lv_keep, lv_in_interface.")
report.push("  LOOP AT lt_cur INTO ls_cur.")
report.push("    lv_line = ls_cur-line.")
report.push("    CONDENSE lv_line.")
report.push("    IF lv_in_interface = 'X'.")
report.push("      IF lv_line CP '*.'.")
report.push("        lv_keep = sy-tabix. EXIT.")
report.push("      ENDIF.")
report.push("    ELSEIF lv_line CS '\"-----------------------------------------'")
report.push("       AND sy-tabix <> 2.")
report.push("      lv_keep = sy-tabix. EXIT.")
report.push("    ELSEIF lv_line CP 'IMPORTING*' OR lv_line CP 'EXPORTING*'")
report.push("       OR lv_line CP 'CHANGING*' OR lv_line CP 'TABLES*'.")
report.push("      lv_in_interface = 'X'.")
report.push("    ENDIF.")
report.push("  ENDLOOP.")
report.push("  IF lv_keep IS INITIAL.")
report.push("    WRITE: / 'ERROR: cannot locate the parameter interface. Refusing to replace the'.")
report.push("    WRITE: / 'include, because that would drop the function module parameters.'.")
report.push("    RETURN.")
report.push("  ENDIF.")
report.push("  WRITE: / 'Interface   : kept through line', lv_keep, 'of', lv_count.")
report.push("")
report.push("  REFRESH lt_new.")
report.push("  LOOP AT lt_cur INTO ls_cur.")
report.push("    IF sy-tabix > lv_keep. EXIT. ENDIF.")
report.push("    APPEND ls_cur TO lt_new.")
report.push("  ENDLOOP.")
report.push("  CLEAR ls_new. APPEND ls_new TO lt_new.")
report.push("  APPEND LINES OF lt_body TO lt_new.")
report.push("  CLEAR ls_new. ls_new-line = 'ENDFUNCTION.'. APPEND ls_new TO lt_new.")
report.push("")
report.push("  INSERT REPORT lv_name FROM lt_new.")
report.push("  IF sy-subrc <> 0.")
report.push("    WRITE: / 'ERROR: INSERT REPORT failed', sy-subrc.")
report.push("    ROLLBACK WORK.")
report.push("    RETURN.")
report.push("  ENDIF.")
report.push("")
report.push(`  GENERATE REPORT 'SAPL${FUNCTION_GROUP}' MESSAGE lv_msg`)
report.push("    LINE lv_msg_line WORD lv_msg_word.")
report.push("  IF sy-subrc <> 0.")
report.push("    WRITE: / 'ERROR: GENERATE failed:', lv_msg.")
report.push("    WRITE: / '  body line:', lv_msg_line, 'word:', lv_msg_word.")
report.push("    WRITE: / '  the active version is unchanged; nothing was activated.'.")
report.push("    ROLLBACK WORK.")
report.push("    RETURN.")
report.push("  ENDIF.")
report.push(`  UPDATE enlfdir SET generated = 'X' WHERE funcname = '${HELPER}'.`)
report.push("  IF sy-subrc <> 0.")
report.push("    WRITE: / 'ERROR: generated flag update failed', sy-subrc.")
report.push("    ROLLBACK WORK.")
report.push("    RETURN.")
report.push("  ENDIF.")
report.push("  COMMIT WORK AND WAIT.")
report.push("")
// The expected row count and protocol come from the canonical body, never from a literal: a carrier
// that prints a stale count reads as a failed deployment to whoever follows the printed instructions.
const expectedOperations = canonical.declaredOperations.length
report.push(
  `* Post-condition: the include must still carry the interface and all ${expectedOperations} operation codes.`
)
report.push("  REFRESH lt_cur.")
report.push("  READ REPORT lv_name INTO lt_cur.")
report.push("  CLEAR: lv_count, lv_found.")
report.push("  LOOP AT lt_cur INTO ls_cur.")
report.push("    IF ls_cur-line CS 'OPERATION|'.")
report.push("      lv_count = lv_count + 1.")
report.push("    ENDIF.")
report.push("    IF ls_cur-line CS 'VALUE(IV_OPERATION)'.")
report.push("      lv_found = 'X'.")
report.push("    ENDIF.")
report.push("  ENDLOOP.")
report.push("  IF lv_found = 'X'.")
report.push("    WRITE: / 'Interface   : parameter interface preserved in the deployed include.'.")
report.push("  ELSE.")
report.push(
  "    WRITE: / 'ERROR: the deployed include no longer declares the parameter interface.'."
)
report.push("  ENDIF.")
report.push("  WRITE: / 'DONE: helper regenerated;', lv_count, 'capability rows written.'.")
report.push(`  IF lv_count < ${expectedOperations}.`)
report.push(
  `    WRITE: / 'WARNING: expected ${expectedOperations} capability rows; check the payload before use.'.`
)
report.push("  ENDIF.")
report.push("  WRITE: / 'Next: sap_helper_status ping, then get_capability_report and confirm'.")
report.push(
  `  WRITE: / 'maxProtocol ${canonical.declaredMaxProtocol} with ${WRITE_OPERATIONS.join(" and ")} present.'.`
)
report.push("")
report.push(
  "* ---- local forms -----------------------------------------------------------------------"
)
report.push(
  "* FUNCTION_SAVE is a dynamic call as well, so keep it in one place and capture the message"
)
report.push(
  "* variables: they name the user whose editing state blocks the save (FL 230 / FL 231)."
)
report.push("FORM save_interface.")
report.push("  CALL FUNCTION 'FUNCTION_SAVE'")
report.push("    EXPORTING")
report.push("      short_text = lv_short")
report.push("      p_rs38l = ls_rs38l")
report.push("    TABLES")
report.push("      import_parameter = lt_fm_import")
report.push("      changing_parameter = lt_fm_change")
report.push("      export_parameter = lt_fm_export")
report.push("      tables_parameter = lt_fm_tables")
report.push("      exception_list = lt_fm_except")
report.push("      parameter_docu = lt_fm_docu")
report.push("    EXCEPTIONS")
report.push("      error_message = 1")
report.push("      OTHERS = 2.")
report.push("  lv_save_rc = sy-subrc.")
report.push("  lv_save_msgid = sy-msgid.")
report.push("  lv_save_msgno = sy-msgno.")
report.push("  lv_save_v1 = sy-msgv1.")
report.push("  lv_save_v2 = sy-msgv2.")
report.push("ENDFORM.")
report.push("")
report.push(
  "* Register the module in the workbench working area, mirroring the calls FUNCTION_CREATE"
)
report.push("* makes before its own save (the V and $ variants cover remote enabled modules).")
report.push("FORM register_working_area.")
report.push("  CALL FUNCTION 'RS_WORKING_AREA_ACTIVE_CHECK'")
report.push("    EXCEPTIONS")
report.push("      nok = 1")
report.push("      OTHERS = 2.")
report.push("  IF sy-subrc <> 0.")
report.push("    RETURN.")
report.push("  ENDIF.")
report.push("  lv_wa_object = 'FUNC'.")
report.push("  lv_wa_name = lv_func.")
report.push("  lv_wa_type = 'REPS'.")
report.push("  lv_wa_abname = lv_fm_include.")
report.push("  CALL FUNCTION 'RS_INSERT_INTO_WORKING_AREA'")
report.push("    EXPORTING")
report.push("      object = lv_wa_object")
report.push("      obj_name = lv_wa_name")
report.push("      objtype_ab = lv_wa_type")
report.push("      objname_ab = lv_wa_abname")
report.push("    EXCEPTIONS")
report.push("      OTHERS = 1.")
report.push("  lv_wa_object = 'REPS'.")
report.push("  lv_wa_name = lv_fm_include.")
report.push("  CALL FUNCTION 'RS_INSERT_INTO_WORKING_AREA'")
report.push("    EXPORTING")
report.push("      object = lv_wa_object")
report.push("      obj_name = lv_wa_name")
report.push("    EXCEPTIONS")
report.push("      OTHERS = 1.")
report.push("  lv_wa_length = strlen( lv_fm_include ) - 3.")
report.push("  IF lv_wa_length < 0.")
report.push("    lv_wa_length = 0.")
report.push("  ENDIF.")
report.push("  IF NOT lv_remote IS INITIAL OR NOT lv_update IS INITIAL.")
report.push("    lv_wa_name = lv_fm_include.")
report.push("    lv_wa_name+lv_wa_length(1) = 'V'.")
report.push("    CALL FUNCTION 'RS_INSERT_INTO_WORKING_AREA'")
report.push("      EXPORTING")
report.push("        object = lv_wa_object")
report.push("        obj_name = lv_wa_name")
report.push("      EXCEPTIONS")
report.push("        OTHERS = 1.")
report.push("  ENDIF.")
report.push("  lv_wa_name = lv_fm_include.")
report.push("  lv_wa_name+lv_wa_length(1) = '$'.")
report.push("  CALL FUNCTION 'RS_INSERT_INTO_WORKING_AREA'")
report.push("    EXPORTING")
report.push("      object = lv_wa_object")
report.push("      obj_name = lv_wa_name")
report.push("    EXCEPTIONS")
report.push("      OTHERS = 1.")
report.push("ENDFORM.")
report.push("")

const rendered = report.join("\n") + "\n"
// The report program's own lines may be wide (SE38 on this system accepted that for the DDIC
// carriers); the widths that matter are the embedded payload lines, asserted on `body` above.
const widestReportLine = report.reduce((n, l) => Math.max(n, l.length), 0)
console.log(`report widest line: ${widestReportLine} columns (payload body is capped at 72)`)

if (check) {
  console.log("")
  console.log("check only: no report written")
  console.log(`  helper  ${HELPER} -> ${PROGRAM}`)
  console.log(`  payload ${payload.length} lines, digest ${payloadDigest}`)
  console.log(`  source hash ${sourceHash}`)
  console.log(`  report would be ${report.length} lines`)
} else {
  await writeFile(outFile, rendered, "utf8")
  console.log("")
  console.log(`wrote ${outFile}`)
  console.log(`  helper  ${HELPER} -> ${PROGRAM}`)
  console.log(`  payload ${payload.length} lines, digest ${payloadDigest}`)
  console.log(`  source hash ${sourceHash}`)
  if (!live)
    console.log("  generated WITHOUT the live baseline: re-run without --offline before applying")
  console.log("  NOT deployed: run the report in SAP yourself (SE38, F8).")
}
