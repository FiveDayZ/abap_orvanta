// Generates the in-SAP deployment report for D6-0 batch 6: fixes the DD_TABL_ACT type conflict that
// makes every transparent-table creation dump with CALL_FUNCTION_CONFLICT_TYPE.
//
//   node scripts/generate-ddic-tablact-b6-report.mjs [--endpoint <url>] [--out <file>]
//
// Read-only against SAP: reads the live helper through read_function_module_interface, proves the
// defect is present, splices the fix and writes ONE local .abap report for the user to run inside SAP.
// It never writes, activates or transports anything in SAP.
//
// THE DEFECT (reported in .doc/orvanta-ddic-helper-ecc731-dd-tabl-act-type-conflict-20260920.md):
//   The helper declares
//       L119  DATA lv_ddic_name TYPE ddobjname.          " CHAR 30
//   and normalises the caller's name into it at L325. Its import parameter is wider:
//       IV_OBJECT_NAME : TADIR-OBJ_NAME                   " CHAR 40
//   Every DDIC call in the TABL branch passes the normalised lv_ddic_name (CHAR 30) -- except the
//   activation, which passes the raw import parameter:
//       L1669  CALL FUNCTION 'DD_TABL_ACT'
//       L1670    EXPORTING tabname = iv_object_name auth_chk = 'X'
//   DD_TABL_ACT-TABNAME is DD02L-TABNAME (CHAR 30). Passing a CHAR 40 actual to a CHAR 30 formal BY
//   REFERENCE raises CALL_FUNCTION_CONFLICT_TYPE / CX_SY_DYN_CALL_ILLEGAL_TYPE at runtime.
//
//   This is a runtime, not a syntax, failure: ABAP's static check only warns about a length mismatch
//   on a by-reference parameter, which is why the helper activated in the first place and why the dump
//   surfaces as SOAP HTTP 500 with an unknown outcome.
//
// THE FIX is two in-place substitutions (live L1670 and L1680):
//   tabname = iv_object_name  ->  tabname = lv_ddic_name
//   The second one, READ TABLE lt_act_res ... WITH KEY tabname = iv_object_name, is a comparison rather
//   than a parameter pass and therefore does not dump, but it compares a CHAR 40 value against a
//   CHAR 30 column and is inconsistent with every other use of the normalised name. Both are fixed so
//   the branch uses one name variable throughout.
//
// NET LINE CHANGE IS +2 (two explanations), so this carrier could reuse the batch-5 monotonic guard.
// It deliberately does NOT: guarding on the presence of the defect states the precondition directly
// and stays correct even if the comment wording is later revised.
//
// NOT doing: no exception handling around the activation, no transport-contract change, no change to
// SOURCE|HASH (ruling H-1). Those are recorded as follow-ups in the deployment record.
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
const outFile = value(
  "--out",
  "C:/My/Workplace/Coding/vscode-abap/.doc/deploy-ddic-tablact-b6.abap"
)

const HELPER = "Z_ORVANTA_MCP_DDIC_API"
const FUNCTION_GROUP = "ZORVANTA_MCP_CORE"
const PACKAGE = "ZABAP"
const TRANSPORT = "GR2K923472"
const PROGRAM = "ZORVANTA_MCP_TABLACT_B6_DEPLOY"
const MARKER = "ORVANTA D6-0 TABL ACT NORMALIZED NAME"

// The live helper as deployed by batch 5.
const BASELINE_LINES = 1994
const INTERFACE_FINGERPRINT = "06b087639c10f51eee77b89fe4154c70b34fb487b2147c3dab9aa714091ba38b"
// The helper fingerprint the batch-5 record left behind, so the generator states which build it edits.
const SOURCE_FINGERPRINT = "05100f34841289fee45c6d798c14d4220118ec70cdbc03399413a009710afb76"

// The two defective lines, located by pattern rather than by hard-coded whitespace.
const DEFECT_PATTERNS = [
  {
    label: "DD_TABL_ACT activation parameter",
    find: /^(\s*)EXPORTING\s+tabname\s*=\s*iv_object_name\s+auth_chk\s*=\s*'X'\s*$/i
  },
  {
    label: "activation-result READ TABLE key",
    find: /^(\s*)WITH\s+KEY\s+tabname\s*=\s*iv_object_name\s*\.\s*$/i
  }
]
const DEFECT_TEXT = "tabname = iv_object_name"
const FIXED_TEXT = "tabname = lv_ddic_name"

// Source comment inserted ahead of the call. Without it a maintainer could "simplify" the normalised
// name back to the wider import parameter and silently reintroduce CALL_FUNCTION_CONFLICT_TYPE.
// It is two whole lines, so the carrier stays a plain line-list splice.
const FIX_COMMENT = [
  '          " DD_TABL_ACT-TABNAME is DD02L-TABNAME (CHAR 30) and passed by reference, so handing it',
  '          " the CHAR 40 import parameter raises CALL_FUNCTION_CONFLICT_TYPE. Use the normalised name.'
]

// ------------------------------------------------------------------------------------------------
const client = new Client({ name: "ddic-tablact-b6-generator", version: "1.0.0" })
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
  INTERFACE_FINGERPRINT,
  "interface fingerprint drifted before generating"
)
console.log(`  helper: ${before.length} lines, source fingerprint ${payload.fingerprint}`)
if (payload.fingerprint !== SOURCE_FINGERPRINT)
  console.log(`  NOTE: source fingerprint is not the batch-5 build recorded in the D6-1i record`)

// --- the premise: the defect is present, exactly twice ------------------------------------------
const hits = DEFECT_PATTERNS.map((p) => {
  const matched = before.map((l, i) => (p.find.test(l) ? i + 1 : 0)).filter(Boolean)
  assert.equal(matched.length, 1, `${p.label}: expected exactly 1 match, found ${matched.length}`)
  return { ...p, line: matched[0], text: before[matched[0] - 1] }
})
for (const h of hits)
  console.log(`  defect at live L${h.line} (${h.label}): ${JSON.stringify(h.text)}`)
assert.notEqual(hits[0].line, hits[1].line, "the two defects resolved to the same line")

// The activation must still be the one immediately preceded by DD_TABL_ACT, and it must still be the
// only place a raw import parameter reaches a DDIC call parameter.
assert.ok(
  hits[0].line >= 2 && before[hits[0].line - 2].includes("'DD_TABL_ACT'"),
  `live L${hits[0].line} is not the DD_TABL_ACT activation (previous line: ${JSON.stringify(before[hits[0].line - 2])})`
)
assert.ok(
  before[hits[1].line - 3]?.includes("DD_TABL_ACT") ||
    before.slice(hits[0].line, hits[1].line).length > 0,
  "the READ TABLE key is not inside the DD_TABL_ACT block"
)
// The normalisation that makes lv_ddic_name the right value must exist.
const normaliseLine =
  before.findIndex((l) => /^\s*lv_ddic_name\s*=\s*iv_object_name\s*\.\s*$/.test(l)) + 1
assert.ok(
  normaliseLine > 0,
  "lv_ddic_name = iv_object_name was not found; the fix premise is wrong"
)
assert.ok(
  normaliseLine < hits[0].line,
  `lv_ddic_name is normalised at L${normaliseLine}, after the defect at L${hits[0].line}`
)
const declLine =
  before.findIndex((l) => /^\s*DATA\s+lv_ddic_name\s+TYPE\s+ddobjname\s*\.\s*$/i.test(l)) + 1
assert.ok(declLine > 0, "DATA lv_ddic_name TYPE ddobjname. was not found")
console.log(`  lv_ddic_name declared L${declLine}, normalised L${normaliseLine}`)
// The defective substring is NOT unique: it also appears in twelve unrelated DDIC structure-field
// assignments (for example "ls_dd02v-tabname = iv_object_name.") and in four SQL WHERE conditions.
// Both the generator and the carrier therefore match WHOLE LINES, never the bare substring -- a
// substring splice would silently corrupt twelve innocent lines.
const DEFECT_SUBSTRING_OCCURRENCES = before.filter((l) => l.includes(DEFECT_TEXT)).length
assert.ok(
  DEFECT_SUBSTRING_OCCURRENCES > 2,
  `expected the defective substring to be non-unique (which is why matching is line-based); found ${DEFECT_SUBSTRING_OCCURRENCES}`
)
console.log(
  `  "${DEFECT_TEXT}" occurs on ${DEFECT_SUBSTRING_OCCURRENCES} lines; only the 2 whole-line matches above are defects`
)

// --- splice: whole-line replacement plus two comment lines ----------------------------------------
const after1 = hits[0].text.replace(DEFECT_TEXT, FIXED_TEXT)
const after2 = hits[1].text.replace(DEFECT_TEXT, FIXED_TEXT)
const after = [
  ...before.slice(0, hits[0].line - 1),
  ...FIX_COMMENT,
  after1,
  ...before.slice(hits[0].line, hits[1].line - 1),
  after2,
  ...before.slice(hits[1].line)
]
assert.notEqual(after1, hits[0].text, "the first substitution did nothing")
assert.notEqual(after2, hits[1].text, "the second substitution did nothing")
assert.equal(
  after.length,
  before.length + FIX_COMMENT.length,
  `expected exactly ${FIX_COMMENT.length} inserted comment lines`
)
// The two defective WHOLE LINES must be gone; the bare substring legitimately survives on the twelve
// unrelated DDIC field assignments, so absence is asserted line-wise, not substring-wise.
assert.ok(!after.includes(hits[0].text), "the first defective line survived the splice")
assert.ok(!after.includes(hits[1].text), "the second defective line survived the splice")
assert.equal(
  after.filter((l) => l === after1).length,
  1,
  "the first fixed line is not present exactly once"
)
assert.equal(
  after.filter((l) => l === after2).length,
  1,
  "the second fixed line is not present exactly once"
)
// Independent completeness check: removing the fix from the payload must reproduce the baseline
// exactly. This is stronger than re-deriving the payload, and it proves no other line was touched.
{
  const shift = FIX_COMMENT.length
  const rebuilt = [
    ...after.slice(0, hits[0].line - 1),
    hits[0].text,
    ...after.slice(hits[0].line - 1 + shift + 1, hits[1].line - 1 + shift),
    hits[1].text,
    ...after.slice(hits[1].line - 1 + shift + 1)
  ]
  assert.deepEqual(
    rebuilt,
    before,
    "removing the fix from the payload does not reproduce the live baseline"
  )
}
console.log(
  `  splice: 2 lines replaced, ${FIX_COMMENT.length} comment lines inserted` +
    ` -> ${after.length} lines (net +${after.length - before.length})`
)

// --- render the in-SAP report -------------------------------------------------------------------
const literal = (s) => `'${String(s).replace(/'/g, "''")}'`
const payloadDigest = createHash("sha256")
  .update(after.join("\n"), "utf8")
  .digest("hex")
  .slice(0, 16)
assert.match(payloadDigest, /^[0-9a-f]{16}$/)

const report = []
report.push(`REPORT ${PROGRAM.toLowerCase()}.`)
report.push("")
report.push(`* GENERATED by scripts/generate-ddic-tablact-b6-report.mjs -- do not edit by hand.`)
report.push(`* ${MARKER}`)
report.push(`* Target   : ${HELPER} (${FUNCTION_GROUP}, package ${PACKAGE})`)
report.push(`* Transport: ${TRANSPORT} (recorded; never released by this report)`)
report.push(
  `* Baseline : ${before.length} lines -> ${after.length} lines (net +${after.length - before.length})`
)
report.push(`* Fixes    : DD_TABL_ACT was called with the raw import parameter iv_object_name`)
report.push(`*            (TADIR-OBJ_NAME, CHAR 40) while DD_TABL_ACT-TABNAME is DD02L-TABNAME`)
report.push(`*            (CHAR 30). A by-reference length mismatch raises`)
report.push(`*            CALL_FUNCTION_CONFLICT_TYPE / CX_SY_DYN_CALL_ILLEGAL_TYPE, so every`)
report.push(
  `*            transparent-table creation dumped with SOAP HTTP 500. Live L${hits[0].line}`
)
report.push(`*            and L${hits[1].line} now use lv_ddic_name, like every other call in the`)
report.push(`*            branch. SOURCE|HASH intentionally unchanged (H-1).`)
report.push("")
report.push("CONSTANTS: c_group   TYPE c LENGTH 30 VALUE " + literal(FUNCTION_GROUP) + ",")
report.push("           c_marker  TYPE c LENGTH 40 VALUE " + literal(MARKER) + ",")
report.push(`           c_digest  TYPE c LENGTH 16 VALUE '${payloadDigest}',`)
report.push(`           c_before1 TYPE string VALUE ${literal(hits[0].text)},`)
report.push(`           c_after1  TYPE string VALUE ${literal(after1)},`)
report.push(`           c_before2 TYPE string VALUE ${literal(hits[1].text)},`)
report.push(`           c_after2  TYPE string VALUE ${literal(after2)}.`)
report.push("")
report.push("DATA: lt_new TYPE TABLE OF abaptxt255,")
report.push("      lt_cur TYPE TABLE OF abaptxt255,")
report.push("      ls_new TYPE abaptxt255,")
report.push("      ls_cur TYPE abaptxt255,")
report.push("      lv_name TYPE c LENGTH 30,")
report.push("      lv_head TYPE c LENGTH 20,")
report.push("      lv_abort TYPE c LENGTH 1,")
report.push("      lv_found TYPE c LENGTH 1,")
report.push("      lv_hits TYPE i,")
report.push("      lv_lines TYPE i,")
report.push("      lv_pos TYPE i,")
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
// The function module source lives in the function group's generated include L<group>U<suffix>.
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
report.push(
  "* Idempotency by CONTENT: reuse of this carrier is refused when the defect is already gone,"
)
report.push("* independently of the payload size.")
report.push("  lv_hits = 0.")
report.push("  LOOP AT lt_cur INTO ls_cur.")
report.push("    IF ls_cur-line CS c_before1 OR ls_cur-line CS c_before2.")
report.push("      lv_hits = lv_hits + 1.")
report.push("    ENDIF.")
report.push("  ENDLOOP.")
report.push("  IF lv_hits = 0.")
report.push("    WRITE: / 'NOTHING TO DO: the DD_TABL_ACT defect is not present.'.")
report.push("    RETURN.")
report.push("  ENDIF.")
report.push(`  IF lv_hits <> 2.`)
report.push("    WRITE: / 'ERROR: expected 2 defective lines in the live include, found', lv_hits.")
report.push("    RETURN.")
report.push("  ENDIF.")
report.push("  WRITE: / 'defective lines found:', lv_hits.")
report.push("")
// The marker must NOT be needed here: the marker lives in the carrier header comment only, and the
// helper payload does not carry it, so content detection is the only correct guard.
report.push("  READ TABLE lt_cur INTO ls_cur INDEX 1.")
report.push("  lv_head = ls_cur-line.")
report.push("  TRANSLATE lv_head TO UPPER CASE.")
report.push("  IF lv_head(8) <> 'FUNCTION'.")
report.push("    WRITE: / 'ERROR: existing include does not start with FUNCTION'.")
report.push("    RETURN.")
report.push("  ENDIF.")
report.push("")
report.push("  DESCRIBE TABLE lt_cur LINES lv_lines.")
report.push(`  IF lv_lines <> ${before.length}.`)
report.push("    WRITE: / 'ERROR: unexpected live line count:', lv_lines.")
report.push("    RETURN.")
report.push("  ENDIF.")
report.push("")
// The payload embedded above is ALREADY the final source, so there is deliberately NO substitution
// loop. An earlier draft substituted c_before* inside lt_new, which can never match -- the payload
// holds the fixed lines -- and would have aborted with "substitutions applied: 0" without writing
// anything. The live source is validated by content above; the payload is then installed directly.
report.push(
  "* Post-splice self-check inside SAP. It compares WHOLE LINES, never the bare substring"
)
report.push(
  "* 'tabname = iv_object_name': that substring legitimately survives on twelve unrelated"
)
report.push("* DDIC field assignments, so a substring count would abort a correct payload.")
report.push("  lv_hits = 0.")
report.push("  lv_pos = 0.")
report.push("  LOOP AT lt_new INTO ls_new.")
report.push("    IF ls_new-line = c_before1 OR ls_new-line = c_before2.")
report.push("      lv_hits = lv_hits + 1.")
report.push("    ENDIF.")
report.push("    IF ls_new-line = c_after1.")
report.push("      lv_pos = lv_pos + 1.")
report.push("    ENDIF.")
report.push("    IF ls_new-line = c_after2.")
report.push("      lv_pos = lv_pos + 1.")
report.push("    ENDIF.")
report.push("  ENDLOOP.")
report.push("  IF lv_hits <> 0.")
report.push("    WRITE: / 'ERROR: the payload still contains a defective line:', lv_hits.")
report.push("    RETURN.")
report.push("  ENDIF.")
report.push("  IF lv_pos <> 2.")
report.push("    WRITE: / 'ERROR: expected 2 fixed lines in the payload, found', lv_pos.")
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
console.log(`  result            : ${after.length} lines (net ${after.length - before.length})`)
console.log(`  fixed live L${hits[0].line} : ${JSON.stringify(after1)}`)
console.log(`  fixed live L${hits[1].line} : ${JSON.stringify(after2)}`)
console.log(`  guard             : content-based (refuses when the defect is absent)`)
console.log(`  payload digest    : ${payloadDigest}`)
console.log(`  SOURCE|HASH       : unchanged (H-1)`)
console.log(`  report written    : ${outFile} (${text.split("\n").length - 1} lines)`)
