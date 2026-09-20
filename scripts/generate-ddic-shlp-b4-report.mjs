// Generates the in-SAP deployment report for D6-1 batch 4: removes the duplicate `WHEN 'SHLP'.`
// branch that made the batch-3 `S1`/`S2`/`S3` response emitter unreachable dead code.
//
//   node scripts/generate-ddic-shlp-b4-report.mjs [--endpoint <url>] [--out <file>]
//
// Read-only against SAP: it reads the live helper through read_function_module_interface, proves
// every anchor and the baseline length, splices the fix and writes ONE local .abap report for the
// user to run inside SAP. It never writes, activates or transports anything in SAP.
//
// WHY THIS EXISTS (gap A root cause -- see .doc/d6-1-gap-a-root-cause-and-batch4-spec.md):
//   The batch-3 carrier inserted its response block as a NEW "WHEN 'SHLP'." branch anchored BEFORE
//   "WHEN 'DTEL'.", i.e. immediately AFTER the batch-2 "WHEN 'SHLP'." branch that emits the 12
//   DD30V header rows. That produced two "WHEN 'SHLP'." branches inside one CASE. ABAP accepts it
//   (so GENERATE and activation both succeeded), but the first matching branch wins and the CASE
//   exits, so the batch-3 emitter -- and therefore every S1/S2/S3 row -- never ran.
//   Observed live: read_search_help on the COLLECTIVE search help ZCCD_H returned
//   selectionMethods/parameters/fieldAssignments all empty.
//
// THE FIX is a one-line structural correction: the duplicate branch header is replaced by two
// comment lines, so the three LOOPs become part of the existing "WHEN 'SHLP'." branch.
// Net growth is +1 line (1992 -> 1993). The growth MUST be positive: the carrier's monotonic size
// guard refuses to apply a replacement that is not strictly larger than the live include, so a
// net -1 line fix (1991) would be silently refused with "replacement is not larger".
//
// SOURCE|HASH is deliberately left byte-identical (ruling H-1): its original hash basis predates the
// current placeholder convention, cannot be reproduced from the live source, and the service does
// not validate it. Changing it would substitute an unverifiable claim.
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
const outFile = value("--out", "C:/My/Workplace/Coding/vscode-abap/.doc/deploy-ddic-shlp-b4.abap")

const HELPER = "Z_ORVANTA_MCP_DDIC_API"
const FUNCTION_GROUP = "ZORVANTA_MCP_CORE"
const PACKAGE = "ZABAP"
const TRANSPORT = "GR2K923472"
const PROGRAM = "ZORVANTA_MCP_SHLP_B4_DEPLOY"
const MARKER = "ORVANTA D6-1d SHLP S-ROW BRANCH FIX"

// The live helper as deployed by batch 3.
const BASELINE_LINES = 1992

const SHLP_WHEN = "    WHEN 'SHLP'."
// read_function_module_interface normalises the source to 6-space indentation for the branch body,
// so these must match that exactly (verified against live lines 1863/1865).
const AS4TIME_ROW = "      add_payload 'H' '1' 'AS4TIME' ls_dd30v-as4time."
const DD31V_LOOP = "      LOOP AT lt_dd31v INTO ls_dd31v."

// Two comment lines, containing no lt_/ls_/lv_/c_ identifiers so the carrier self-check below
// cannot mistake them for code. They carry the marker scanned for idempotency.
const REPLACEMENT = [
  `      " ${MARKER}: S1/S2/S3 rows belong to this branch.`,
  `      " A second WHEN 'SHLP' here would be unreachable dead code.`
]

// ------------------------------------------------------------------------------------------------
// Duplicate-WHEN detector. This is the self-check batch 1-3 lacked and the one that would have
// caught this defect at generation time. An ABAP CASE block may not contain two identical WHEN
// literals: the second is unreachable.
// ------------------------------------------------------------------------------------------------
function duplicateWhenLiterals(source) {
  const stack = []
  const findings = []
  source.forEach((raw, index) => {
    const code = raw.replace(/^\s*\*.*$/, "").replace(/".*$/, "")
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
        findings.push({
          caseLine: top.line,
          literal,
          first: top.whens.get(literal),
          duplicate: index + 1
        })
      else top.whens.set(literal, index + 1)
    }
  })
  return { findings, unclosed: stack.length }
}

// ------------------------------------------------------------------------------------------------
const client = new Client({ name: "ddic-shlp-generator", version: "1.0.0" })
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

// --- baseline assertions -------------------------------------------------------------------------
assert.equal(
  before.length,
  BASELINE_LINES,
  `baseline moved: ${before.length} lines, expected ${BASELINE_LINES}`
)
assert.equal(before[0].trim(), `FUNCTION ${HELPER}.`, "unexpected first line")

// --- locate the duplicate branch via the detector, never by a global occurrence count -------------
// WHEN 'SHLP'. legitimately appears more than once in the helper (different CASE blocks), so a
// global count is meaningless. Only a duplicate WITHIN one CASE is a defect.
const defectBefore = duplicateWhenLiterals(before)
assert.equal(defectBefore.unclosed, 0, "CASE/ENDCASE is not balanced in the live source")
assert.equal(
  defectBefore.findings.length,
  1,
  `expected exactly 1 duplicate WHEN in the live source, found ${defectBefore.findings.length}`
)
const onlyDefect = defectBefore.findings[0]
assert.equal(onlyDefect.literal, "'SHLP'", "the live duplicate is not the SHLP branch")
const firstWhen = onlyDefect.first
const duplicateAt = onlyDefect.duplicate
assert.equal(
  before[duplicateAt - 2],
  AS4TIME_ROW,
  "the duplicate WHEN does not immediately follow the AS4TIME header row"
)
assert.equal(
  before[duplicateAt],
  DD31V_LOOP,
  "the duplicate WHEN is not followed by the DD31V loop"
)
// The winning branch must be the header-only one: nothing between them may emit an S row.
const between = before.slice(firstWhen, duplicateAt - 1)
assert.ok(
  !between.some((l) => /add_payload '(S1|S2|S3)'/.test(l)),
  "an S row is emitted by the winning branch; the premise of this fix is wrong"
)
const shlpWhenTotal = before.filter((l) => l === SHLP_WHEN).length
assert.ok(shlpWhenTotal >= 2, `expected at least 2 ${JSON.stringify(SHLP_WHEN)} lines`)

const anchors = [
  { at: duplicateAt, text: SHLP_WHEN, kind: "replace", name: "COMMENT", lines: REPLACEMENT }
]
for (const a of anchors)
  assert.equal(before[a.at - 1], a.text, `anchor ${a.name} drifted at line ${a.at}`)

const hashRowBefore = before.filter((l) => l.includes("SOURCE|HASH|")).join("\n")

let after = [...before]
for (const a of [...anchors].sort((x, y) => y.at - x.at)) {
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
assert.equal(after.length, 1993, `result must be 1993 lines, got ${after.length}`)
assert.ok(
  after.length > before.length,
  "result must be strictly larger or the carrier's monotonic guard refuses it"
)
assert.match(after[0], /^FUNCTION\b/i, "result no longer starts with FUNCTION")
assert.match(
  String(after.at(-1)).trim(),
  /^ENDFUNCTION\./i,
  "result no longer ends with ENDFUNCTION."
)
assert.equal(
  after.filter((l) => l.includes("SOURCE|HASH|")).join("\n"),
  hashRowBefore,
  "SOURCE|HASH changed (H-1 violated)"
)

// --- THE fix must actually fix it -----------------------------------------------------------------
const defectAfter = duplicateWhenLiterals(after)
assert.deepEqual(defectAfter.findings, [], "duplicate WHEN survived the fix")
assert.equal(defectAfter.unclosed, 0, "CASE/ENDCASE is not balanced after the fix")

// The duplicate is gone, one legitimately-placed WHEN 'SHLP'. remains elsewhere, and the S rows
// are still present and now belong to the surviving SHLP branch in the response CASE.
assert.equal(
  after.filter((l) => l === SHLP_WHEN).length,
  shlpWhenTotal - 1,
  `expected ${shlpWhenTotal - 1} WHEN 'SHLP'. lines after the fix`
)
// Prove the three LOOPs are now physically adjacent to the winning header rows, i.e. inside the
// surviving response-CASE SHLP branch, not merely "somewhere later in the file".
assert.equal(after[duplicateAt - 2], AS4TIME_ROW, "the AS4TIME header row moved")
assert.deepEqual(
  after.slice(duplicateAt - 1, duplicateAt + 1),
  REPLACEMENT,
  "the duplicate WHEN was not replaced by the two comment lines"
)
assert.equal(after[duplicateAt + 1], DD31V_LOOP, "the DD31V loop is not immediately after the fix")
// Nothing between the branch header and the loops may re-open a WHEN.
assert.ok(
  !after.slice(firstWhen, duplicateAt - 1).some((l) => /^\s*WHEN\b/i.test(l)),
  "a WHEN re-opens between the SHLP header rows and the S rows"
)
const counts = { S1: 0, S2: 0, S3: 0 }
for (const line of after) {
  const m = line.match(/add_payload '(S1|S2|S3)'/)
  if (m) counts[m[1]]++
}
assert.deepEqual(
  counts,
  { S1: 3, S2: 26, S3: 6 },
  `S-row payload lines changed: ${JSON.stringify(counts)}`
)
assert.ok(
  after.some((l) => l.includes(MARKER)),
  "the idempotency marker is missing from the payload"
)

// Deployment must not silently drop the pre-existing operations.
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
report.push(`* GENERATED by scripts/generate-ddic-shlp-b4-report.mjs -- do not edit by hand.`)
report.push(`* ${MARKER}`)
report.push(`* Target   : ${HELPER} (${FUNCTION_GROUP}, package ${PACKAGE})`)
report.push(`* Transport: ${TRANSPORT} (recorded; never released by this report)`)
report.push(`* Baseline : ${before.length} lines -> ${after.length} lines`)
report.push(`* Fixes    : gap A. The batch-3 S1/S2/S3 response emitter was inserted as a SECOND`)
report.push(`*            "WHEN 'SHLP'." branch in the same CASE, so it was unreachable dead code`)
report.push(`*            and READ_SEARCH_HELP returned the 12 header rows and no children.`)
report.push(
  `*            The duplicate branch header (line ${duplicateAt}) is replaced by comments,`
)
report.push(`*            folding the three LOOPs into the existing branch.`)
report.push(`* SOURCE|HASH is intentionally unchanged (ruling H-1).`)
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
// L<group>U<suffix> -- NOT the bare function group name. The suffix comes from TFDIR.INCLUDE for
// this exact function module. This mirrors the proven SCI carrier, the only variant that has run.
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
// The ENLFDIR "generated" flag is deliberately NOT set here: ENLFDIR's fields are
// AREA/FUNCNAME/GENERATED and this helper's row already carries GENERATED='X'. D2-3 deployed
// successfully regardless.
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
console.log(`  baseline        : ${before.length} lines`)
console.log(`  result          : ${after.length} lines (+${expectedGrowth})`)
console.log(`  duplicate WHEN  : removed at live line ${duplicateAt}`)
console.log(`  S-row payloads  : S1=3 S2=26 S3=6`)
console.log(`  payload digest  : ${payloadDigest}`)
console.log(`  SOURCE|HASH     : unchanged (H-1)`)
console.log(`  report written  : ${outFile} (${text.split("\n").length - 1} lines)`)
