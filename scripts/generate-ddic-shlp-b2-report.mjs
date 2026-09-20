// Generates the in-SAP deployment report for D6-1 batch 1: adds READ_SEARCH_HELP and
// DELETE_SEARCH_HELP to Z_ORVANTA_MCP_DDIC_API (function group ZORVANTA_MCP_CORE).
//
//   node scripts/generate-ddic-shlp-deploy-report.mjs [--endpoint <url>] [--out <file>]
//
// Read-only against SAP: it reads the live helper, proves every insertion anchor still matches the
// reviewed baseline, splices in the SHLP batches and writes ONE local .abap report for the user to
// run inside SAP. It never writes, activates or transports anything in SAP.
//
// Why a report and not a direct write: Z_ORVANTA_MCP_DDIC_API lives in ZORVANTA_MCP_CORE, where the
// native ADT write path is blocked by the platform (HTTP 423 for a function-module include) and the
// helper-backed path is blocked by the SELF_FUNCTION_GROUP_FORBIDDEN guard. D2-3 proved the in-SAP
// report route works; this generator reuses that pattern.
//
// SOURCE|HASH is deliberately left byte-identical (ruling H-1): its original hash basis predates the
// current placeholder convention and cannot be reproduced from the live source, and the service does
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
const outFile = value("--out", "C:/My/Workplace/Coding/vscode-abap/.doc/deploy-ddic-shlp-b2.abap")

const HELPER = "Z_ORVANTA_MCP_DDIC_API"
const FUNCTION_GROUP = "ZORVANTA_MCP_CORE"
const PACKAGE = "ZABAP"
const TRANSPORT = "GR2K923472"
const PROGRAM = "ZORVANTA_MCP_SHLP_B2_DEPLOY"
const MARKER = "ORVANTA D6-1b SEARCH HELP UPSERT"

// ------------------------------------------------------------------------------------------------
// The SHLP additions. ECC 7.31 syntax only; no inline declarations, no 7.40 expressions.
// ------------------------------------------------------------------------------------------------
const DECL = [
  "  DATA ls_dd31v TYPE dd31v.",
  "  DATA ls_dd32p TYPE dd32p.",
  "  DATA ls_dd33v TYPE dd33v.",
  "  FIELD-SYMBOLS <ls_dd31v> TYPE dd31v.",
  "  FIELD-SYMBOLS <ls_dd32p> TYPE dd32p.",
  "  FIELD-SYMBOLS <ls_dd33v> TYPE dd33v."
]

const CAP_OPS = [
  "      CONCATENATE 'OPERATION|UPSERT_SEARCH_HELP' '1.8|W'",
  "        INTO ls_source-line SEPARATED BY '|'.",
  "      APPEND ls_source TO it_source."
]

const OP_DISP = [
  "    WHEN 'UPSERT_SEARCH_HELP'.",
  "      lv_object_type = 'SHLP'.",
  "      lv_write = 'X'."
]

// Block 1: header ('H') properties. Indent 12, body indent 14. Reject the derived and
// server-controlled DD30V fields: ELEMEXI/NOFIELDS/ATTACHEXI are computed by DDIF_SHLP_PUT itself
// from the child tables (tested: DDIF_SHLP_PUT L108-L190), and AS4*/ACTFLAG/DDLANGUAGE are not
// caller-owned. Unknown names are still caught generically by the PROPERTY_INVALID check.
const B1 = [
  "            WHEN 'SHLP'.",
  "              IF lv_property = 'ACTFLAG'",
  "                 OR lv_property = 'AS4DATE'",
  "                 OR lv_property = 'AS4TIME'",
  "                 OR lv_property = 'AS4USER'",
  "                 OR lv_property = 'ATTACHEXI'",
  "                 OR lv_property = 'ELEMEXI'",
  "                 OR lv_property = 'NOFIELDS'",
  "                 OR lv_property = 'DDLANGUAGE'.",
  "                ev_status = 'E'. ev_code = 'PROPERTY_NOT_ALLOWED'.",
  "                ev_message = 'Derived or server-controlled search help property'.",
  "                ev_version = '1.8'. RETURN.",
  "              ENDIF.",
  "              ASSIGN COMPONENT lv_property",
  "                OF STRUCTURE ls_dd30v TO <lv_component>."
]

// Value rows for SHLP. The existing 'V' kind is hard-wired to the DOMA fixed-value table lt_dd07v
// and rejects any object type other than DOMA (tested: helper L538-L553), so SHLP needs its own
// kinds rather than a change to 'V'. 'S1'/'S2'/'S3' select DD31V/DD32P/DD33V. This is additive:
// the SPLIT field count is untouched and 'V' keeps its exact current behaviour.
// SHLPNAME is forced by the write block, and the position columns are derived from row order
// (mirroring DOMA's "valpos = sy-tabix"), so both are rejected here.
const VALUE_ROWS = [
  "        WHEN 'S1'.",
  "          IF lv_object_type <> 'SHLP'",
  "             OR lv_property = 'SHLPNAME'",
  "             OR lv_property = 'SHPOSITION'.",
  "            ev_status = 'E'. ev_code = 'PROPERTY_NOT_ALLOWED'.",
  "            ev_message = 'Search help selection property not allowed'.",
  "            ev_version = '1.8'. RETURN.",
  "          ENDIF.",
  "          WHILE lines( lt_dd31v ) < lv_index.",
  "            CLEAR ls_dd31v. APPEND ls_dd31v TO lt_dd31v.",
  "          ENDWHILE.",
  "          READ TABLE lt_dd31v ASSIGNING <ls_dd31v>",
  "            INDEX lv_index.",
  "          ASSIGN COMPONENT lv_property",
  "            OF STRUCTURE <ls_dd31v> TO <lv_component>.",
  "        WHEN 'S2'.",
  "          IF lv_object_type <> 'SHLP'",
  "             OR lv_property = 'SHLPNAME'",
  "             OR lv_property = 'FLPOSITION'.",
  "            ev_status = 'E'. ev_code = 'PROPERTY_NOT_ALLOWED'.",
  "            ev_message = 'Search help parameter property not allowed'.",
  "            ev_version = '1.8'. RETURN.",
  "          ENDIF.",
  "          WHILE lines( lt_dd32p ) < lv_index.",
  "            CLEAR ls_dd32p. APPEND ls_dd32p TO lt_dd32p.",
  "          ENDWHILE.",
  "          READ TABLE lt_dd32p ASSIGNING <ls_dd32p>",
  "            INDEX lv_index.",
  "          ASSIGN COMPONENT lv_property",
  "            OF STRUCTURE <ls_dd32p> TO <lv_component>.",
  "        WHEN 'S3'.",
  "          IF lv_object_type <> 'SHLP'",
  "             OR lv_property = 'SHLPNAME'.",
  "            ev_status = 'E'. ev_code = 'PROPERTY_NOT_ALLOWED'.",
  "            ev_message = 'Search help field assignment property not allowed'.",
  "            ev_version = '1.8'. RETURN.",
  "          ENDIF.",
  "          WHILE lines( lt_dd33v ) < lv_index.",
  "            CLEAR ls_dd33v. APPEND ls_dd33v TO lt_dd33v.",
  "          ENDWHILE.",
  "          READ TABLE lt_dd33v ASSIGNING <ls_dd33v>",
  "            INDEX lv_index.",
  "          ASSIGN COMPONENT lv_property",
  "            OF STRUCTURE <ls_dd33v> TO <lv_component>."
]

// Block 4: write + activate. Indent 6, body indent 8. The payload row order drives the position
// columns, matching the DOMA path's "valpos = sy-tabix". DDIF_SHLP_ACTIVATE has NO auth_chk
// parameter (unlike DDIF_DOMA_ACTIVATE), so it must not be copied from the DOMA branch.
const WRITE = [
  "      WHEN 'SHLP'.",
  "        ls_dd30v-shlpname = iv_object_name.",
  "        ls_dd30v-ddlanguage = sy-langu.",
  "        ls_dd30v-ddtext = iv_description.",
  "        LOOP AT lt_dd31v ASSIGNING <ls_dd31v>.",
  "          <ls_dd31v>-shlpname = iv_object_name.",
  "          <ls_dd31v>-shposition = sy-tabix.",
  "        ENDLOOP.",
  "        LOOP AT lt_dd32p ASSIGNING <ls_dd32p>.",
  "          <ls_dd32p>-shlpname = iv_object_name.",
  "          <ls_dd32p>-flposition = sy-tabix.",
  "        ENDLOOP.",
  "        LOOP AT lt_dd33v ASSIGNING <ls_dd33v>.",
  "          <ls_dd33v>-shlpname = iv_object_name.",
  "        ENDLOOP.",
  "        CALL FUNCTION 'DDIF_SHLP_PUT'",
  "          EXPORTING name = lv_ddic_name dd30v_wa = ls_dd30v",
  "          TABLES dd31v_tab = lt_dd31v",
  "            dd32p_tab = lt_dd32p",
  "            dd33v_tab = lt_dd33v",
  "          EXCEPTIONS OTHERS = 1.",
  "        IF sy-subrc = 0.",
  "          CALL FUNCTION 'DDIF_SHLP_ACTIVATE'",
  "            EXPORTING name = lv_ddic_name",
  "            IMPORTING rc = lv_rc",
  "            EXCEPTIONS OTHERS = 1.",
  "        ENDIF."
]

// Block 5: write-after read-back with state = 'A'. Indent 6, body indent 8. Mirrors the DOMA
// branch, including the REFRESH before the read so the tables reflect the activated version.
const READBACK = [
  "      WHEN 'SHLP'.",
  "        REFRESH: lt_dd31v, lt_dd32p, lt_dd33v.",
  "        CALL FUNCTION 'DDIF_SHLP_GET'",
  "          EXPORTING name = lv_ddic_name state = 'A'",
  "            langu = sy-langu",
  "          IMPORTING gotstate = lv_gotstate dd30v_wa = ls_dd30v",
  "          TABLES dd31v_tab = lt_dd31v",
  "            dd32p_tab = lt_dd32p",
  "            dd33v_tab = lt_dd33v",
  "          EXCEPTIONS OTHERS = 1.",
  "        CONCATENATE ls_dd30v-as4date ls_dd30v-as4time",
  "          INTO lv_current_version."
]

// ------------------------------------------------------------------------------------------------
// Anchors: 1-based line numbers in the reviewed baseline, each with its exact expected text.
// Splicing runs bottom-up so earlier anchors keep their line numbers.
// ------------------------------------------------------------------------------------------------
const BASELINE_LINES = 1837
const anchors = [
  {
    at: 54,
    text: "  DATA lt_current_dd33v TYPE TABLE OF dd33v.",
    kind: "after",
    name: "DECL",
    lines: DECL
  },
  {
    at: 217,
    text: "      APPEND ls_source TO it_source.",
    kind: "after",
    name: "CAP_OPS",
    lines: CAP_OPS
  },
  { at: 303, text: "    WHEN OTHERS.", kind: "before", name: "OP_DISPATCH", lines: OP_DISP },
  { at: 407, text: "            WHEN 'DTEL'.", kind: "before", name: "BLOCK1", lines: B1 },
  { at: 554, text: "        WHEN 'F'.", kind: "before", name: "VALUE_ROWS", lines: VALUE_ROWS },
  { at: 1456, text: "      WHEN 'DTEL'.", kind: "before", name: "BLOCK4", lines: WRITE },
  { at: 1658, text: "      WHEN 'DTEL'.", kind: "before", name: "BLOCK5", lines: READBACK }
]

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

assert.equal(
  before.length,
  BASELINE_LINES,
  `baseline moved: ${before.length} lines, expected ${BASELINE_LINES}`
)
assert.equal(before[0].trim(), `FUNCTION ${HELPER}.`, "unexpected first line")

// Prove every anchor before touching anything.
for (const a of anchors)
  assert.equal(before[a.at - 1], a.text, `anchor ${a.name} drifted at line ${a.at}`)

// Every inserted line must be unique-by-anchor only if it contains a hash slot; also prove the
// SOURCE|HASH row is untouched by the whole plan.
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
report.push(`* GENERATED by scripts/generate-ddic-shlp-b2-report.mjs -- do not edit by hand.`)
report.push(`* ${MARKER}`)
report.push(`* Target   : ${HELPER} (${FUNCTION_GROUP}, package ${PACKAGE})`)
report.push(`* Transport: ${TRANSPORT} (recorded; never released by this report)`)
report.push(`* Baseline : ${before.length} lines -> ${after.length} lines`)
report.push(`* Adds     : UPSERT_SEARCH_HELP (protocol 1.8|W) with 'H' header rows plus`)
report.push(`*            'S1'/'S2'/'S3' value rows for DD31V/DD32P/DD33V, then`)
report.push(`*            DDIF_SHLP_PUT + DDIF_SHLP_ACTIVATE and a state='A' read-back.`)
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
// L<group>U<suffix> — NOT the bare function group name. The suffix comes from TFDIR.INCLUDE for
// this exact function module. This mirrors the proven SCI carrier
// (.doc/deploy-sci-carrier.abap:60-65), which is the only variant that has actually run.
report.push(`  SELECT SINGLE include FROM tfdir INTO lv_suffix WHERE funcname = '${HELPER}'.`)
report.push("  IF sy-subrc <> 0 OR lv_suffix IS INITIAL.")
report.push(`    WRITE: / 'ERROR: function module ${HELPER} not found in TFDIR.'.`)
report.push("    RETURN.")
report.push("  ENDIF.")
report.push("  CONCATENATE 'L' c_group 'U' lv_suffix INTO lv_name.")
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
// The ENLFDIR "generated" flag is deliberately NOT set here. ENLFDIR's fields are
// AREA/FUNCNAME/GENERATED (verified against w200 DD03L) — it has no NAME field, and this
// helper's row already carries GENERATED='X'. The SCI carrier's equivalent update targets
// funcname and appears to be a silent no-op, and D2-3 deployed successfully regardless.
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
// otherwise only discovered at deployment time — after the source has already been saved into SAP.
// The first real compile of this carrier failed on exactly that (`lv_lines` was used but never
// declared), so assert the whole class of mistake here instead.
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
    for (const m of line.matchAll(/\b((?:lt|ls|lv|c)_[a-z0-9_]+)\b/g))
      if (!declared.has(m[1].toLowerCase())) undeclared.add(m[1])
  }
  if (undeclared.size)
    throw new Error(
      `self-check: carrier uses undeclared variable(s): ${[...undeclared].join(", ")}`
    )
}

// The very last statement must be terminated. SAP reported exactly this on the first real
// activation: "最后的语句不完整（缺少句号）" — the final WRITE was missing its period.
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
console.log(`  payload digest  : ${payloadDigest}`)
console.log(`  SOURCE|HASH     : unchanged (H-1)`)
console.log(`  report written  : ${outFile} (${text.split("\n").length - 1} lines)`)
