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
const outFile = value("--out", "C:/My/Workplace/Coding/vscode-abap/.doc/deploy-ddic-shlp-b3.abap")

const HELPER = "Z_ORVANTA_MCP_DDIC_API"
const FUNCTION_GROUP = "ZORVANTA_MCP_CORE"
const PACKAGE = "ZABAP"
const TRANSPORT = "GR2K923472"
const PROGRAM = "ZORVANTA_MCP_SHLP_B3_DEPLOY"
const MARKER = "ORVANTA D6-1c SHLP RESPONSE ROWS"

// ------------------------------------------------------------------------------------------------
// The SHLP response child rows. ECC 7.31 syntax only; no inline declarations, no 7.40 expressions.
//
// WHY THIS EXISTS (gap A — see .doc/d6-1-gap-analysis-and-batch3-spec.md section 2):
//   The read path already fills lt_dd31v / lt_dd32p / lt_dd33v via DDIF_SHLP_GET state='M', and the
//   response CASE emits the 12 DD30V header rows, but for 'SHLP' it emits NO child rows at all --
//   unlike the DOMA branch (LOOP AT lt_dd07v -> 'V' rows) and the STRU branch (LOOP AT lt_dd03p ->
//   'F' rows). Batch 2 added 'S1'/'S2'/'S3' INPUT parsing only and never added response emission.
//   Without this block a READ_SEARCH_HELP caller gets a successful reply that SILENTLY lacks the
//   DD31V selection methods, the DD32P parameters and the DD33V field assignments.
//
// The three LOOP targets must be the response-side tables, and ls_dd31v / ls_dd32p / ls_dd33v are
// the declarations the batch-2 carrier added -- this block depends on them.
//
// Key fields are deliberately NOT emitted: SHLPNAME is already a header property, and SHPOSITION /
// FLPOSITION are reproduced from row order, symmetric with the write path.
// ------------------------------------------------------------------------------------------------
const RESP_ROWS = [
  "    WHEN 'SHLP'.",
  "      LOOP AT lt_dd31v INTO ls_dd31v.",
  "        lv_index = sy-tabix.",
  "        add_payload 'S1' lv_index 'SUBSHLP' ls_dd31v-subshlp.",
  "        add_payload 'S1' lv_index 'VIASHLP' ls_dd31v-viashlp.",
  "        add_payload 'S1' lv_index 'HIDEFLAG' ls_dd31v-hideflag.",
  "      ENDLOOP.",
  "      LOOP AT lt_dd32p INTO ls_dd32p.",
  "        lv_index = sy-tabix.",
  "        add_payload 'S2' lv_index 'FIELDNAME' ls_dd32p-fieldname.",
  "        add_payload 'S2' lv_index 'ROLLNAME' ls_dd32p-rollname.",
  "        add_payload 'S2' lv_index 'DOMNAME' ls_dd32p-domname.",
  "        add_payload 'S2' lv_index 'DATATYPE' ls_dd32p-datatype.",
  "        add_payload 'S2' lv_index 'LENG' ls_dd32p-leng.",
  "        add_payload 'S2' lv_index 'DECIMALS' ls_dd32p-decimals.",
  "        add_payload 'S2' lv_index 'HEADLEN' ls_dd32p-headlen.",
  "        add_payload 'S2' lv_index 'SCRLEN1' ls_dd32p-scrlen1.",
  "        add_payload 'S2' lv_index 'SCRLEN2' ls_dd32p-scrlen2.",
  "        add_payload 'S2' lv_index 'SCRLEN3' ls_dd32p-scrlen3.",
  "        add_payload 'S2' lv_index 'OUTPUTLEN' ls_dd32p-outputlen.",
  "        add_payload 'S2' lv_index 'CONVEXIT' ls_dd32p-convexit.",
  "        add_payload 'S2' lv_index 'LOWERCASE' ls_dd32p-lowercase.",
  "        add_payload 'S2' lv_index 'SIGNFLAG' ls_dd32p-signflag.",
  "        add_payload 'S2' lv_index 'DEFAULTTYP' ls_dd32p-defaulttyp.",
  "        add_payload 'S2' lv_index 'DEFAULTVAL' ls_dd32p-defaultval.",
  "        add_payload 'S2' lv_index 'SHLPINPUT' ls_dd32p-shlpinput.",
  "        add_payload 'S2' lv_index 'SHLPOUTPUT' ls_dd32p-shlpoutput.",
  "        add_payload 'S2' lv_index 'SHLPSELDIS' ls_dd32p-shlpseldis.",
  "        add_payload 'S2' lv_index 'SHLPSELPOS' ls_dd32p-shlpselpos.",
  "        add_payload 'S2' lv_index 'SHLPLISPOS' ls_dd32p-shlplispos.",
  "        add_payload 'S2' lv_index 'SHLPUPPER' ls_dd32p-shlpupper.",
  "        add_payload 'S2' lv_index 'PROXYTYPE' ls_dd32p-proxytype.",
  "        add_payload 'S2' lv_index 'ROLLCHANGE' ls_dd32p-rollchange.",
  "        add_payload 'S2' lv_index 'INDEXNAME' ls_dd32p-indexname.",
  "        add_payload 'S2' lv_index 'SQLTAB' ls_dd32p-sqltab.",
  "      ENDLOOP.",
  "      LOOP AT lt_dd33v INTO ls_dd33v.",
  "        lv_index = sy-tabix.",
  "        add_payload 'S3' lv_index 'FIELDNAME' ls_dd33v-fieldname.",
  "        add_payload 'S3' lv_index 'SUBFIELD' ls_dd33v-subfield.",
  "        add_payload 'S3' lv_index 'SUBSHLP' ls_dd33v-subshlp.",
  "        add_payload 'S3' lv_index 'DEFAULTTYP' ls_dd33v-defaulttyp.",
  "        add_payload 'S3' lv_index 'DEFAULTVAL' ls_dd33v-defaultval.",
  "        add_payload 'S3' lv_index 'VALUEDIREC' ls_dd33v-valuedirec.",
  "      ENDLOOP."
]

// ------------------------------------------------------------------------------------------------
// Baseline and anchors. The baseline MUST be the helper as it exists AFTER the batch-2 carrier was
// executed (1947 lines, fingerprint c2a6cf7f...), because the batch-2 carrier is already deployed
// and verified. Every anchor is asserted against the live source before any splice, so a drifted
// baseline fails loudly instead of producing a wrong carrier.
// ------------------------------------------------------------------------------------------------
const BASELINE_LINES = 1947
const anchors = [
  { at: 1864, text: "    WHEN 'DTEL'.", kind: "before", name: "RESP_ROWS", lines: RESP_ROWS }
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
report.push(`* GENERATED by scripts/generate-ddic-shlp-b3-report.mjs -- do not edit by hand.`)
report.push(`* ${MARKER}`)
report.push(`* Target   : ${HELPER} (${FUNCTION_GROUP}, package ${PACKAGE})`)
report.push(`* Transport: ${TRANSPORT} (recorded; never released by this report)`)
report.push(`* Baseline : ${before.length} lines -> ${after.length} lines`)
report.push(`* Adds     : 'SHLP' RESPONSE child rows -- 'S1' for DD31V, 'S2' for DD32P and`)
report.push(`*            'S3' for DD33V -- after the existing 12 DD30V header rows.`)
report.push(`*            Closes gap A: READ_SEARCH_HELP previously returned the header only.`)
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
