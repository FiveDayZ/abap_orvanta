// Generates the in-SAP deployment report for D6-1 batch 5: widens the request-payload row-kind
// variable from one character to two so the already-present S1/S2/S3 branches become reachable.
//
//   node scripts/generate-ddic-shlp-b5-report.mjs [--endpoint <url>] [--out <file>]
//
// Read-only against SAP: reads the live helper through read_function_module_interface, proves every
// anchor and the baseline length, splices the fix and writes ONE local .abap report for the user to
// run inside SAP. It never writes, activates or transports anything in SAP.
//
// WHY THIS EXISTS (gap D -- see .doc/code-update-20260920-140623.md section 3):
//   Z_ORVANTA_MCP_DDIC_API declares
//       L89   DATA lv_kind TYPE c LENGTH 1.
//   and splits each request payload row with
//       L353  SPLIT ls_source-line AT '|' INTO lv_kind lv_index_text lv_property lv_value.
//   Batch 3 DID implement the three two-character row kinds correctly:
//       L581  WHEN 'S1'.   L596  WHEN 'S2'.   L611  WHEN 'S3'.
//   inside the outer 'CASE lv_kind.' at L371 (which closes at L722; the nested CASE lv_object_type.
//   at L378 closes earlier at L564). But 'S1' cannot fit in a one-character field, so SPLIT silently
//   truncates it to 'S', no WHEN matches, and control falls to
//       L718  WHEN OTHERS -> PAYLOAD_INVALID 'Unknown DDIC payload row type'.
//   Live effect: upsert_search_help rejects every request that carries child rows, i.e. every
//   collective search help and every elementary search help that has DD32P parameter rows.
//
// THE FIX is a one-line widening plus one comment line. Net growth is +1 and MUST be positive: the
// carrier's monotonic guard refuses a replacement that is not strictly larger than the live include,
// so a net-zero change would be silently refused with "replacement is not larger".
//
// NOT doing: no new WHEN branches (they exist), no change to the read or write semantics, no change
// to SOURCE|HASH (ruling H-1).
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const argv = process.argv.slice(2)
const value = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i < 0 ? fallback : argv[i + 1]
}
const endpoint = value("--endpoint", process.env.ABAP_MCP_ENDPOINT ?? "http://127.0.0.1:4848/mcp")
const outFile = value("--out", "C:/My/Workplace/Coding/vscode-abap/.doc/deploy-ddic-shlp-b5.abap")

const HELPER = "Z_ORVANTA_MCP_DDIC_API"
const FUNCTION_GROUP = "ZORVANTA_MCP_CORE"
const PACKAGE = "ZABAP"
const TRANSPORT = "GR2K923472"
const PROGRAM = "ZORVANTA_MCP_SHLP_B5_DEPLOY"
const MARKER = "ORVANTA D6-1f SHLP S-ROW KIND WIDTH"

// The live helper as deployed by batch 4.
const BASELINE_LINES = 1993

const KIND_DECL_BEFORE = "  DATA lv_kind TYPE c LENGTH 1."
const KIND_DECL_AFTER = "  DATA lv_kind TYPE c LENGTH 2."
// This comment lands INSIDE the helper payload, so it carries the idempotency marker the carrier's
// guard scans for. It must contain no lt_/ls_/lv_/c_ identifier so the carrier self-check cannot
// mistake it for code, and it must stay well inside ABAPTXT255.
const KIND_COMMENT = `  " ${MARKER}: S1/S2/S3 need two characters; one truncates to S.`
const OTHERS_MSG_BEFORE = "          ev_message = 'Unknown DDIC payload row type'."
const OTHERS_MSG_AFTER =
  "          CONCATENATE 'Unknown DDIC payload row type' lv_kind INTO ev_message SEPARATED BY ' '."

// The three branches batch 3 already installed. Asserted present so a future regression that removes
// them cannot be mis-reported as "batch 5 fixed it".
const TWO_CHAR_KINDS = ["WHEN 'S1'.", "WHEN 'S2'.", "WHEN 'S3'."]

// ------------------------------------------------------------------------------------------------
// Structural detectors.
// ------------------------------------------------------------------------------------------------
function stripCode(raw) {
  return raw.replace(/^\s*\*.*$/, "").replace(/".*$/, "")
}

/** Duplicate WHEN literals inside one CASE -- the defect class that made batch 3 dead code. */
function duplicateWhenLiterals(source) {
  const stack = []
  const findings = []
  source.forEach((raw, index) => {
    const code = stripCode(raw)
    if (!code.trim()) return
    const bare = code.trim()
    if (/^CASE\b/i.test(bare)) {
      stack.push({ line: index + 1, whens: new Map() })
      return
    }
    if (/^ENDCASE\b/i.test(bare)) {
      stack.pop()
      return
    }
    const when = bare.match(/^WHEN\s+(.+?)\.?$/i)
    if (when && stack.length) {
      const top = stack[stack.length - 1]
      const literal = when[1].replace(/\s+/g, " ").replace(/\.$/, "").toUpperCase()
      if (top.whens.has(literal))
        findings.push({ literal, first: top.whens.get(literal), duplicate: index + 1 })
      else top.whens.set(literal, index + 1)
    }
  })
  return { findings, unclosed: stack.length }
}

/**
 * Return the branches of the OUTERMOST CASE whose operand matches `operandText`, tracking nesting
 * so a nested CASE's ENDCASE cannot truncate the scan. This is the detector whose absence caused the
 * wrong first diagnosis of gap D: the naive "first ENDCASE after the CASE" hit the nested
 * CASE lv_object_type. at L378/L564 and hid the real S1/S2/S3 branches at L581-624.
 */
function outerCaseBranches(source, operandText) {
  const start = source.findIndex((l) =>
    new RegExp(`^\\s*CASE\\s+${operandText}\\s*\\.\\s*$`, "i").test(stripCode(l))
  )
  if (start < 0) return null
  const branches = []
  let depth = 0
  for (let i = start; i < source.length; i++) {
    const bare = stripCode(source[i]).trim()
    if (!bare) continue
    if (/^CASE\b/i.test(bare)) {
      depth++
      continue
    }
    if (/^ENDCASE\b/i.test(bare)) {
      depth--
      if (depth === 0) return { startLine: start + 1, endLine: i + 1, branches }
      continue
    }
    if (depth === 1 && /^WHEN\b/i.test(bare)) branches.push({ line: i + 1, text: bare })
  }
  return { startLine: start + 1, endLine: null, branches, unterminated: true }
}

// ------------------------------------------------------------------------------------------------
const client = new Client({ name: "ddic-shlp-b5-generator", version: "1.0.0" })
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)))
const read = await client.callTool(
  {
    name: "read_function_module_interface",
    arguments: { connectionId: "w200", functionName: HELPER }
  },
  undefined,
  { timeout: 300000 }
)
assert.equal(read.isError ?? false, false, "reading the helper failed")
const payload = JSON.parse((read.content ?? []).map((c) => c.text ?? "").join(""))
const before = payload.source ?? []
await client.close()

// --- baseline -----------------------------------------------------------------------------------
assert.equal(
  before.length,
  BASELINE_LINES,
  `baseline moved: ${before.length} lines, expected ${BASELINE_LINES}`
)
assert.equal(before[0].trim(), `FUNCTION ${HELPER}.`, "unexpected first line")
assert.equal(
  payload.interfaceFingerprint,
  "06b087639c10f51eee77b89fe4154c70b34fb487b2147c3dab9aa714091ba38b",
  "interface fingerprint drifted before generating"
)

// --- the premise: the S branches EXIST and only the variable width blocks them -------------------
const outer = outerCaseBranches(before, "lv_kind")
assert.ok(outer, "could not locate 'CASE lv_kind.'")
assert.equal(outer.unterminated ?? false, false, "CASE lv_kind. is not terminated")
console.log(
  `  CASE lv_kind. spans L${outer.startLine}-L${outer.endLine} with branches: ` +
    outer.branches.map((b) => `L${b.line} ${b.text}`).join(", ")
)
const branchTexts = outer.branches.map((b) => b.text)
for (const kind of TWO_CHAR_KINDS)
  assert.ok(
    branchTexts.includes(kind),
    `premise failed: ${kind} is NOT present in CASE lv_kind. -- the batch-5 diagnosis is wrong`
  )
assert.equal(
  branchTexts.filter((t) => /^WHEN\s+'S\d'/i.test(t)).length,
  3,
  "expected exactly three two-character S branches"
)
assert.ok(
  branchTexts.includes("WHEN OTHERS."),
  "WHEN OTHERS fallback is missing; the truncation would not produce PAYLOAD_INVALID"
)

// The variable really is one character wide, and is the one fed by the SPLIT.
const declLine = before.indexOf(KIND_DECL_BEFORE) + 1
assert.ok(
  declLine > 0,
  `could not find the declaration verbatim: ${JSON.stringify(KIND_DECL_BEFORE)}`
)
const splitLine =
  before.findIndex((l) => /SPLIT\s+ls_source-line\s+AT\s+'\|'\s+INTO\s+lv_kind\b/i.test(l)) + 1
assert.ok(splitLine > 0, "could not find the SPLIT that populates lv_kind")
assert.ok(
  before.filter((l) => l === KIND_DECL_BEFORE).length === 1,
  "the declaration text is not unique"
)
console.log(`  lv_kind declared L${declLine}, populated by the SPLIT at L${splitLine}`)
assert.ok(splitLine > declLine, "the SPLIT precedes the declaration; unexpected source layout")

// Only these two lines are touched.
const msgLine = before.indexOf(OTHERS_MSG_BEFORE) + 1
assert.ok(msgLine > 0, "could not find the WHEN OTHERS message verbatim")
assert.equal(before.filter((l) => l === OTHERS_MSG_BEFORE).length, 1, "the message is not unique")

const defectBefore = duplicateWhenLiterals(before)
assert.equal(defectBefore.unclosed, 0, "CASE/ENDCASE unbalanced in the live source")
assert.deepEqual(defectBefore.findings, [], "the live source already has a duplicate WHEN")
const hashRowBefore = before.filter((l) => l.includes("SOURCE|HASH|")).join("\n")

// --- splice -------------------------------------------------------------------------------------
const anchors = [
  { at: declLine, text: KIND_DECL_BEFORE, kind: "replace", name: "DECL", lines: [KIND_DECL_AFTER] },
  { at: declLine, text: KIND_DECL_BEFORE, kind: "after", name: "COMMENT", lines: [KIND_COMMENT] },
  { at: msgLine, text: OTHERS_MSG_BEFORE, kind: "replace", name: "MSG", lines: [OTHERS_MSG_AFTER] }
]
for (const a of anchors)
  assert.equal(before[a.at - 1], a.text, `anchor ${a.name} drifted at line ${a.at}`)
// The two declaration anchors share a line; apply the insert first so indices stay valid.
assert.equal(anchors.filter((a) => a.at === declLine).length, 2, "expected two anchors on the decl")

let after = [...before]
for (const a of [...anchors].sort((x, y) => y.at - x.at || (x.kind === "after" ? -1 : 1))) {
  if (a.kind === "before")
    after = [...after.slice(0, a.at - 1), ...a.lines, ...after.slice(a.at - 1)]
  else if (a.kind === "after") after = [...after.slice(0, a.at), ...a.lines, ...after.slice(a.at)]
  else after = [...after.slice(0, a.at - 1), ...a.lines, ...after.slice(a.at)]
}

const expectedGrowth = anchors.reduce(
  (n, a) => n + (a.kind === "replace" ? a.lines.length - 1 : a.lines.length),
  0
)
assert.equal(after.length, before.length + expectedGrowth, "splice arithmetic is wrong")
assert.equal(expectedGrowth, 1, `net growth must be exactly +1, got ${expectedGrowth}`)
assert.equal(after.length, 1994, `result must be 1994 lines, got ${after.length}`)
assert.ok(after.length > before.length, "growth must be positive or the monotonic guard refuses it")

// --- the fix is present and correctly formed ------------------------------------------------------
assert.equal(after[declLine - 1], KIND_DECL_AFTER, "the declaration was not widened")
assert.equal(after[declLine], KIND_COMMENT, "the explanatory comment is not directly after it")
assert.equal(after.filter((l) => l === KIND_DECL_AFTER).length, 1, "widened declaration not unique")
assert.ok(!after.some((l) => l === KIND_DECL_BEFORE), "the one-character declaration survived")
assert.ok(after.includes(OTHERS_MSG_AFTER), "the WHEN OTHERS message was not made self-diagnosing")
assert.ok(!after.includes(OTHERS_MSG_BEFORE), "the old WHEN OTHERS message survived")

// The three branches must be untouched, and still inside the same CASE.
const outerAfter = outerCaseBranches(after, "lv_kind")
assert.ok(
  outerAfter && !(outerAfter.unterminated ?? false),
  "CASE lv_kind. broke during the splice"
)
const branchTextsAfter = outerAfter.branches.map((b) => b.text)
for (const kind of TWO_CHAR_KINDS)
  assert.ok(branchTextsAfter.includes(kind), `${kind} disappeared during the splice`)
assert.deepEqual(branchTextsAfter, branchTexts, "the branch list of CASE lv_kind. changed")

// Semicolon-free structural invariants.
assert.match(after[0], /^FUNCTION\b/i, "result no longer starts with FUNCTION")
assert.match(
  String(after.at(-1)).trim(),
  /^ENDFUNCTION\./i,
  "result no longer ends with ENDFUNCTION."
)
assert.equal(duplicateWhenLiterals(after).unclosed, 0, "CASE/ENDCASE unbalanced after the fix")
assert.deepEqual(duplicateWhenLiterals(after).findings, [], "the fix introduced a duplicate WHEN")
assert.equal(
  after.filter((l) => l.includes("SOURCE|HASH|")).join("\n"),
  hashRowBefore,
  "SOURCE|HASH changed (H-1 violated)"
)
const counts = { S1: 0, S2: 0, S3: 0 }
for (const line of after) {
  const m = line.match(/add_payload '(S1|S2|S3)'/)
  if (m) counts[m[1]]++
}
assert.deepEqual(
  counts,
  { S1: 3, S2: 26, S3: 6 },
  `S-row emitters changed: ${JSON.stringify(counts)}`
)
assert.ok(
  after.some((l) => l.includes(MARKER)),
  "the idempotency marker is missing from the payload"
)
for (const op of ["READ_DOMAIN", "UPSERT_DOMAIN", "DELETE_TABLE_TYPE", "RECOVER_TABLE_CONVERSION"])
  assert.ok(
    after.some((l) => l.includes(`'OPERATION|${op}'`)),
    `capability row for ${op} disappeared`
  )

// ------------------------------------------------------------------------------------------------
// Render the in-SAP report.
// ------------------------------------------------------------------------------------------------
const literal = (s) => `'${String(s).replace(/'/g, "''")}'`
const payloadDigest = createHash("sha256")
  .update(after.join("\n"), "utf8")
  .digest("hex")
  .slice(0, 16)
assert.match(payloadDigest, /^[0-9a-f]{16}$/)

const report = []
report.push(`REPORT ${PROGRAM.toLowerCase()}.`)
report.push("")
report.push(`* GENERATED by scripts/generate-ddic-shlp-b5-report.mjs -- do not edit by hand.`)
report.push(`* ${MARKER}`)
report.push(`* Target   : ${HELPER} (${FUNCTION_GROUP}, package ${PACKAGE})`)
report.push(`* Transport: ${TRANSPORT} (recorded; never released by this report)`)
report.push(`* Baseline : ${before.length} lines -> ${after.length} lines`)
report.push(`* Fixes    : gap D. The request-payload row-kind variable was one character wide, so`)
report.push(
  `*            SPLIT truncated S1/S2/S3 to S and the three correctly implemented branches`
)
report.push(
  `*            (live L581/L596/L611) were unreachable dead code. Widened at line ${declLine}.`
)
report.push(
  `*            No branch was added or removed. SOURCE|HASH intentionally unchanged (H-1).`
)
report.push("")
report.push("CONSTANTS: c_group  TYPE c LENGTH 30 VALUE " + literal(FUNCTION_GROUP) + ",")
report.push("           c_marker TYPE c LENGTH 40 VALUE " + literal(MARKER) + ",")
report.push(`           c_digest TYPE c LENGTH 16 VALUE '${payloadDigest}'.`)
report.push("")
report.push("DATA: lt_new TYPE TABLE OF abaptxt255,")
report.push("      lt_cur TYPE TABLE OF abaptxt255,")
report.push("      ls_new TYPE abaptxt255,")
report.push("      ls_cur TYPE abaptxt255,")
report.push("      lv_name TYPE c LENGTH 30,")
report.push("      lv_head TYPE c LENGTH 20,")
report.push("      lv_abort TYPE c LENGTH 1,")
report.push("      lv_found TYPE c LENGTH 1,")
report.push("      lv_lines TYPE i,")
report.push("      lv_suffix TYPE tfdir-include,")
report.push("      lv_msg TYPE string.")
report.push("")
report.push("START-OF-SELECTION.")
report.push(`  WRITE: / '${MARKER}'.`)
report.push(`  WRITE: / 'Target      :', c_group.`)
report.push(`  WRITE: / 'Lines       :', ${after.length}.`)
report.push(`  WRITE: / 'payload digest:', c_digest.`)
report.push("  SKIP 1.")
report.push("")
report.push("  REFRESH lt_new.")
for (const line of after)
  report.push(`  CLEAR ls_new. ls_new-line = ${literal(line)}. APPEND ls_new TO lt_new.`)
report.push("")
report.push("  DESCRIBE TABLE lt_new LINES lv_lines.")
report.push(`  IF lv_lines <> ${after.length}.`)
report.push("    WRITE: / 'ERROR: payload line count mismatch:', lv_lines.")
report.push("    RETURN.")
report.push("  ENDIF.")
report.push("")
// The function module's source lives in the function group's generated include, whose name is
// L<group>U<suffix> -- NOT the bare function group name. The suffix comes from TFDIR.INCLUDE.
report.push(`  SELECT SINGLE include FROM tfdir INTO lv_suffix WHERE funcname = '${HELPER}'.`)
report.push("  IF sy-subrc <> 0 OR lv_suffix IS INITIAL.")
report.push(`    WRITE: / 'ERROR: function module ${HELPER} not found in TFDIR.'.`)
report.push("    RETURN.")
report.push("  ENDIF.")
report.push("  CONCATENATE 'L' c_group 'U' lv_suffix INTO lv_name.")
report.push("")
report.push("  REFRESH lt_cur.")
report.push("  READ REPORT lv_name INTO lt_cur.")
report.push("  IF sy-subrc <> 0 OR lt_cur IS INITIAL.")
report.push("    WRITE: / 'ERROR: cannot read function group include', lv_name.")
report.push("    RETURN.")
report.push("  ENDIF.")
report.push("")
report.push("* Idempotency: refuse to apply the same carrier twice.")
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
report.push("  READ TABLE lt_cur INTO ls_cur INDEX 1.")
report.push("  lv_head = ls_cur-line.")
report.push("  TRANSLATE lv_head TO UPPER CASE.")
report.push("  IF lv_head(8) <> 'FUNCTION'.")
report.push("    WRITE: / 'ERROR: existing include does not start with FUNCTION'.")
report.push("    RETURN.")
report.push("  ENDIF.")
report.push("")
report.push("  DESCRIBE TABLE lt_cur LINES lv_lines.")
report.push(`  IF lv_lines >= ${after.length}.`)
report.push("    WRITE: / 'ERROR: replacement is not larger than the current include', lv_lines.")
report.push("    RETURN.")
report.push("  ENDIF.")
report.push("")
report.push("  lv_abort = 'X'.")
report.push("  INSERT REPORT lv_name FROM lt_new.")
report.push("  IF sy-subrc <> 0.")
report.push("    WRITE: / 'ERROR: INSERT REPORT failed', sy-subrc.")
report.push("    ROLLBACK WORK.")
report.push("    RETURN.")
report.push("  ENDIF.")
report.push("")
report.push(`  GENERATE REPORT 'SAPL${FUNCTION_GROUP}' MESSAGE lv_msg.`)
report.push("  IF sy-subrc <> 0.")
report.push("    WRITE: / 'ERROR: GENERATE failed:', lv_msg.")
report.push("    ROLLBACK WORK.")
report.push("    RETURN.")
report.push("  ENDIF.")
report.push("")
// The ENLFDIR "generated" flag is deliberately NOT set: its fields are AREA/FUNCNAME/GENERATED and
// this helper's row already carries GENERATED='X'. D2-3 deployed successfully regardless.
report.push("  COMMIT WORK.")
report.push("  CLEAR lv_abort.")
report.push("")
report.push("  IF lv_abort IS INITIAL.")
report.push("    WRITE: / 'OK: generated and activated.'.")
report.push("  ELSE.")
report.push("    WRITE: / 'ABORTED.'.")
report.push("  ENDIF.")
report.push("")
report.push(
  `  WRITE: / 'DONE. Re-read ${HELPER} and confirm the interface fingerprint is unchanged.'.`
)

// Self-check: SAP compiles this report, never this machine, so an undeclared carrier variable is
// otherwise only discovered at deployment time -- after the source has already been saved into SAP.
{
  const declStart = report.findIndex((l) => /^\s*(?:CONSTANTS|DATA)\b/i.test(l))
  const declEnd = report.findIndex((l) => l.startsWith("START-OF-SELECTION."))
  if (declStart < 0 || declEnd <= declStart)
    throw new Error("self-check: could not locate the carrier declaration block")
  const declared = new Set(
    [
      ...report
        .slice(declStart, declEnd)
        .join("\n")
        .matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)
    ].map((m) => m[1].toLowerCase())
  )
  const undeclared = new Set()
  for (const line of report) {
    if (line.includes("ls_new-line = ")) continue // embedded helper payload, not carrier code
    if (line.trimStart().startsWith("*")) continue // comment
    if (/^\s*"/.test(line)) continue // ABAP inline comment
    for (const m of line.matchAll(/\b((?:lt|ls|lv|c)_[a-z0-9_]+)\b/g))
      if (!declared.has(m[1].toLowerCase())) undeclared.add(m[1])
  }
  if (undeclared.size)
    throw new Error(
      `self-check: carrier uses undeclared variable(s): ${[...undeclared].join(", ")}`
    )
}

// The very last statement must be terminated.
{
  const last = [...report].reverse().find((l) => l.trim() !== "")
  if (!last.trimEnd().endsWith("."))
    throw new Error(`self-check: the final statement is not terminated: ${last}`)
}

const text = report.join("\n") + "\n"
await writeFile(outFile, text, "utf8")
console.log(`${MARKER}`)
console.log(`  baseline          : ${before.length} lines`)
console.log(`  result            : ${after.length} lines (+${expectedGrowth})`)
console.log(`  widened           : live L${declLine} -> ${KIND_DECL_AFTER.trim()}`)
console.log(`  self-diagnosing   : live L${msgLine} WHEN OTHERS message`)
console.log(`  S branches kept   : ${TWO_CHAR_KINDS.join(" ")} (live L581/L596/L611)`)
console.log(`  S-row emitters    : S1=3 S2=26 S3=6`)
console.log(`  payload digest    : ${payloadDigest}`)
console.log(`  SOURCE|HASH       : unchanged (H-1)`)
console.log(`  report written    : ${outFile} (${text.split("\n").length - 1} lines)`)
