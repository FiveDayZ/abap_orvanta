#!/usr/bin/env node
/**
 * Generates the in-SAP report that puts the CANONICAL DDIC helper body into SAP: carrier #2 / D6-2B.
 *
 *   node scripts/export-ddic-helper-source.ps1              # canonical body -> .cache JSON (no SAP)
 *   node scripts/generate-ddic-lock-carrier.mjs             # + live pre-flight, then write the report
 *   node scripts/generate-ddic-lock-carrier.mjs --check     # validate only, write nothing
 *   node scripts/generate-ddic-lock-carrier.mjs --offline   # skip the live read (report without baseline)
 *
 * Why this carrier exists: the deployed helper self-describes 24 operation codes, because the 1.10
 * carrier (generate-ddic-enqu-resume-deploy-report.mjs) was assembled from an older body and
 * deliberately left UPSERT_LOCK_OBJECT / DELETE_LOCK_OBJECT out - its own header says so. The
 * bootstrap script has implemented both paths for a while, so the fix is to deploy the body the
 * script installs, not to hand-splice a third delta. `npm run matrix:check` already asserts that
 * this body declares every operation the registry dispatches.
 *
 * Read-only against SAP: the live read only derives the baseline and the pre-flight assertions.
 * This script never writes, activates or transports anything in SAP. The generated report is run by
 * a human with F8 inside SAP, which is the only path that works for OBJECTS in ZORVANTA_MCP_CORE
 * (native ADT write returns HTTP 423; the helper write path is blocked by
 * SELF_FUNCTION_GROUP_FORBIDDEN).
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
const sourceFile = resolve(value("--source", ".cache/ddic-helper-canonical.json"))
const outFile = value(
  "--out",
  "C:/My/Workplace/Coding/vscode-abap/.doc/deploy-ddic-lock-object-r2d.abap"
)

const HELPER = "Z_ORVANTA_MCP_DDIC_API"
const FUNCTION_GROUP = "ZORVANTA_MCP_CORE"
const PROGRAM = "ZORVANTA_MCP_DDIC_LOCK_DEPLOY"
// Content-derived, and reassigned once the canonical body is loaded (see below). It must NOT be a
// fixed string: the emitted report refuses to apply itself when the marker is already present in the
// live include (`IF ls_cur-line CS c_marker`). A fixed marker shared with an earlier carrier makes a
// *later* carrier no-op against a body it never deployed and print "NOTHING TO DO: this carrier is
// already applied" - a silent false success, because that message reads as "nothing needed" when in
// fact the new operations were never installed. Binding the marker to the protocol plus the body
// hash keeps re-running the same carrier idempotent while guaranteeing a changed body gets a new one.
let MARKER = "ORVANTA DDIC CARRIER"
const WRITE_OPERATIONS = ["UPSERT_LOCK_OBJECT", "DELETE_LOCK_OBJECT"]
const REQUIRED_OPERATIONS = ["READ_LOCK_OBJECT", "RESUME_TABLE_ACTIVATION"]
// Operation names this carrier renames. `IV_OPERATION` is BAPIRET2-PARAMETER (CHAR 32), so the
// 35-character RESUME_TRANSPARENT_TABLE_ACTIVATION could never match its `WHEN` arm: SAP truncated
// it and answered OPERATION_NOT_SUPPORTED (2026-09-22 10:56 incident).
const SUPERSEDED_OPERATIONS = { RESUME_TABLE_ACTIVATION: "RESUME_TRANSPARENT_TABLE_ACTIVATION" }

// ------------------------------------------------------------------------------------------------
// Canonical body: the exact source the bootstrap script would install, exported by the PowerShell
// extractor (which is the only thing that knows how the script's own state shapes the body).
// ------------------------------------------------------------------------------------------------
let canonical
try {
  canonical = JSON.parse(await readFile(sourceFile, "utf8"))
} catch (error) {
  console.error(`cannot read the canonical body at ${sourceFile}`)
  console.error("run: pwsh -NoLogo -NoProfile -File scripts/export-ddic-helper-source.ps1")
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
}
// Bind the marker to the protocol and the body hash (see the MARKER declaration). 34 characters,
// inside the emitted `c_marker TYPE c LENGTH 40`.
MARKER = `ORVANTA DDIC CARRIER ${canonical.declaredMaxProtocol} ${canonical.sourceSha256
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
for (const op of WRITE_OPERATIONS) {
  assert.ok(
    body.some((l) => l.includes(`WHEN '${op}'`)),
    `${op} is declared but not dispatched`
  )
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
// The write paths must be implemented, not just advertised.
for (const call of ["DDIF_ENQU_PUT", "DDIF_ENQU_ACTIVATE", "DDIF_OBJECT_DELETE"]) {
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
  const client = new Client({ name: "ddic-lock-carrier-generator", version: "1.0.0" })
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
  await client.close()

  assert.equal(live[0].trim(), `FUNCTION ${HELPER}.`, `unexpected live first line: ${live[0]}`)
  assert.match(String(live.at(-1)).trim(), /^ENDFUNCTION\./i, "unexpected live last line")
  const liveText = live.join("\n")
  // Carrier ordering invariant (.doc/d6-carrier-ordering-invariant.md): a carrier replaces the whole
  // body, so it may only be applied on top of a helper that already contains every predecessor
  // change. The check must therefore accept the protocol the previous carrier deployed: 1.12 became
  // the live protocol on 2026-09-23 (carrier r26, marker 1.12 47A7813A) and 1.13 later the same day
  // (carrier r32, marker 1.13 A815B8A8), which finally deployed the resume-activation dispatch.
  // Listing each deployed protocol here is what lets the next carrier be generated at all; leaving
  // one out makes every subsequent run abort on its own precondition.
  assert.ok(
    ["1.10", "1.11", "1.12", "1.13"].some((protocol) =>
      liveText.includes(`PROTOCOL|MAX|${protocol}`)
    ),
    "the deployed helper is not at protocol 1.10, 1.11, 1.12 or 1.13: apply the previous carrier first"
  )
  for (const op of REQUIRED_OPERATIONS) {
    // The resume operation was renamed in R2D: the deployed helper still carries
    // RESUME_TRANSPARENT_TABLE_ACTIVATION (35 characters), which the CHAR 32 IV_OPERATION
    // parameter truncates so the dispatch arm can never match. Accept the superseded name here so
    // the "did this carrier drop an operation" guard still holds while the rename is deployed.
    const superseded = SUPERSEDED_OPERATIONS[op]
    assert.ok(
      live.some(
        (l) =>
          l.includes(`OPERATION|${op}`) || (superseded && l.includes(`OPERATION|${superseded}`))
      ),
      `the deployed helper lost ${op}`
    )
  }
  // 0.46.13 revision: a carrier whose body already matches SAP is pointless and must not run, but a
  // carrier whose body differs is a revision - exactly what this script is for. The earlier guard
  // keyed on "the write opcodes are not published yet", which only ever held for the first
  // deployment. Compare the installed body region instead; the generator still refuses to build a
  // body that lacks the write operations (asserted above), so a revision cannot regress them.
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
    // a lost live fix: the old name cannot be delivered through the CHAR 32 IV_OPERATION parameter.
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

// A body that declares the same name twice cannot be compiled. Catch it here: the first R2 payload
// shipped `DATA lv_put_subrc_text` twice and GENERATE reported only the later line
// ("LV_PUT_SUBRC_TEXT" already declared), which cost one F8 round trip.
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
// Render the report. R2 splices the BODY into the live include instead of replacing the whole
// include, because the function module's parameter interface is part of that source text
// (`FUNCTION name` + IMPORTING/EXPORTING/TABLES ... `.`). The first carrier wrote
// `FUNCTION name.` + body + `ENDFUNCTION.`, which drops the interface - read-only evidence:
// VALUE(IV_SCREEN), CT_FLOWLOGIC, ET_GUI_ATTRIBUTES and IT_SOURCE LIKE all match in the live base
// source. R2 keeps every line up to the end of the interface and inserts the body after it, which is
// also what the bootstrap installer does.
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
report.push("* GENERATED by scripts/generate-ddic-lock-carrier.mjs -- do not edit by hand.")
report.push(`* ${MARKER}`)
report.push(`* Target   : ${HELPER} (${FUNCTION_GROUP})`)
report.push(
  `* Transport: ${canonical.transport || "(none recorded)"} (recorded; never released by this report)`
)
report.push(
  live
    ? `* Baseline : ${live.length} live lines; this report keeps the interface and replaces the body`
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
report.push("* Apply    : reads the live include, keeps every line up to the end of the parameter")
report.push("*            interface, inserts the body after it, then INSERT REPORT + GENERATE.")
report.push(
  "*            R2 supersedes the first carrier, which replaced the whole include and would"
)
report.push(
  "*            have dropped the interface (FUNCTION ... IMPORTING/EXPORTING/TABLES ... .)."
)
report.push("")
report.push(`CONSTANTS: c_group  TYPE c LENGTH 30 VALUE ${literal(FUNCTION_GROUP)},`)
report.push(`           c_marker TYPE c LENGTH 40 VALUE ${literal(MARKER)},`)
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
report.push("START-OF-SELECTION.")
report.push(`  WRITE: / '${MARKER}'.`)
report.push("  WRITE: / 'Target      :', c_group.")
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
report.push("* Idempotency: refuse to apply this carrier twice.")
report.push("  CLEAR lv_found.")
report.push("  LOOP AT lt_cur INTO ls_cur.")
report.push("    IF ls_cur-line CS c_marker.")
report.push("      lv_found = 'X'. EXIT.")
report.push("    ENDIF.")
report.push("  ENDLOOP.")
report.push("  IF lv_found = 'X'.")
report.push("    WRITE: / 'NOTHING TO DO: this carrier is already applied.'.")
report.push("    RETURN.")
report.push("  ENDIF.")
report.push("")
report.push(
  "* The canonical body declares UPSERT_LOCK_OBJECT / DELETE_LOCK_OBJECT (the generator asserts"
)
report.push(
  "* it before emitting this report), so replacing the body cannot regress them. The marker"
)
report.push("* check above is what stops a second application of this revision.")
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
// The expected row count and protocol come from the canonical body, never from a literal: the r9
// carrier deployed 32 operations while its own closing text still said "26" and "maxProtocol 1.10",
// which reads as a failed deployment to whoever follows the printed instructions.
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
  `  WRITE: / 'maxProtocol ${canonical.declaredMaxProtocol} with UPSERT_LOCK_OBJECT and DELETE_LOCK_OBJECT present.'.`
)
report.push("")

const rendered = report.join("\n") + "\n"
// The report program's own lines may be wide (the 1.10 carrier was applied that way, and SE38 on this
// system accepted it); the widths that matter are the embedded payload lines, asserted on `body`
// above. Keep this as an observation so a future tightening of the SAP line limit is visible.
const widestReportLine = report.reduce((n, l) => Math.max(n, l.length), 0)
console.log(`report widest line: ${widestReportLine} columns (payload body is capped at 72)`)

if (check) {
  console.log("")
  console.log("check only: no report written")
  console.log(`  payload ${payload.length} lines, digest ${payloadDigest}`)
  console.log(`  source hash ${sourceHash}`)
  console.log(`  report would be ${report.length} lines`)
} else {
  await writeFile(outFile, rendered, "utf8")
  console.log("")
  console.log(`wrote ${outFile}`)
  console.log(`  payload ${payload.length} lines, digest ${payloadDigest}`)
  console.log(`  source hash ${sourceHash}`)
  if (!live)
    console.log("  generated WITHOUT the live baseline: re-run without --offline before applying")
  console.log("  NOT deployed: run the report in SAP yourself (SE38, F8).")
}
