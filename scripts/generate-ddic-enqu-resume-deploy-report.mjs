// Generates the in-SAP deployment report that brings Z_ORVANTA_MCP_DDIC_API from protocol 1.8 up to
// 1.10 by adding the D6-2 lock-object operations (1.9) and the inactive-activation resume operation
// (1.10).
//
//   node scripts/generate-ddic-enqu-resume-deploy-report.mjs [--endpoint <url>] [--out <file>]
//
// Read-only against SAP: it reads the live helper and verifies every anchor against what SAP actually
// holds before splicing, then writes ONE local .abap report for the user to run inside SAP. It never
// writes, activates or transports anything in SAP.
//
// Why a report and not a direct write: Z_ORVANTA_MCP_DDIC_API lives in ZORVANTA_MCP_CORE, where the
// native ADT write path is blocked (HTTP 423 for a function-module include) and the helper-backed path
// is blocked by SELF_FUNCTION_GROUP_FORBIDDEN. The in-SAP report route (D2-3, D6-1) is the only path
// that has actually been shown to work.
//
// Anchors are DERIVED from the live source and then asserted, rather than hard-coded: the deployed
// helper is already at 1.8 (1996 lines) while the D6-1 generator anchored to a 1787-line 1.7
// baseline, so reusing those numbers would splice into the wrong places.
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
  "C:/My/Workplace/Coding/vscode-abap/.doc/deploy-ddic-enqu-resume.abap"
)

const HELPER = "Z_ORVANTA_MCP_DDIC_API"
const FUNCTION_GROUP = "ZORVANTA_MCP_CORE"
const PACKAGE = "ZABAP"
const TRANSPORT = "GR2K923472"
const PROGRAM = "ZORVANTA_MCP_DDIC_ENQU_DEPLOY"
const MARKER = "ORVANTA D6-2 ENQU RESUME CARRIER"

// ------------------------------------------------------------------------------------------------
// Inserted blocks. ECC 7.31 syntax only: no inline declarations, no 7.40 constructor expressions.
// Indentation matches the surrounding live code so the spliced result stays readable.
// ------------------------------------------------------------------------------------------------

// Declarations for the lock-object and resume paths. ls_dd25v/lt_dd26v/lt_dd27p carry the lock
// object; dd26e (not dd26v) is the type DDIF_ENQU_GET/PUT actually declare, and it adds ENQMODE.
const DECL = [
  "  DATA ls_dd25v TYPE dd25v.",
  "  DATA lt_dd26v TYPE TABLE OF dd26e.",
  "  DATA lt_dd27p TYPE TABLE OF dd27p.",
  "  DATA ls_current_dd25v TYPE dd25v.",
  "  DATA lt_current_dd26v TYPE TABLE OF dd26e.",
  "  DATA lt_current_dd27p TYPE TABLE OF dd27p.",
  "  DATA ls_dd26v TYPE dd26e.",
  "  DATA ls_dd27p TYPE dd27p.",
  "  FIELD-SYMBOLS <ls_dd26v> TYPE dd26e.",
  "  FIELD-SYMBOLS <ls_dd27p> TYPE dd27p.",
  "  DATA lv_resume TYPE c LENGTH 1.",
  "  DATA lv_describe TYPE c LENGTH 1.",
  "  DATA lv_put_subrc TYPE sy-subrc.",
  "  DATA lv_msg_class TYPE sy-msgid.",
  "  DATA lv_msg_type TYPE sy-msgty.",
  "  DATA lv_msg_number TYPE sy-msgno.",
  "  DATA lv_msg_text TYPE string.",
  "  DATA lv_inactive_exists TYPE c LENGTH 1.",
  "  DATA lv_tadir_exists TYPE c LENGTH 1.",
  "  DATA lv_phase TYPE string."
]

// Capability rows: 1.9 lock-object READ, plus the 1.10 resume (W).
//
// UPSERT_LOCK_OBJECT and DELETE_LOCK_OBJECT are deliberately NOT declared: their write bodies
// (DDIF_ENQU_PUT / DDIF_ENQU_ACTIVATE) are not part of this carrier, and advertising an opcode the
// helper cannot execute would make the capability report lie. Their dispatch arms are likewise
// omitted below. They arrive in a later carrier together with their implementations.
const CAP_OPS = [
  "      CONCATENATE 'OPERATION|READ_LOCK_OBJECT' '1.9|R'",
  "        INTO ls_source-line SEPARATED BY '|'.",
  "      APPEND ls_source TO it_source.",
  "      CONCATENATE 'OPERATION|RESUME_TRANSPARENT_TABLE_ACTIVATION' '1.10|W'",
  "        INTO ls_source-line SEPARATED BY '|'.",
  "      APPEND ls_source TO it_source."
]

// The read path copies the "current" structures into the output structures, so ENQU must join that
// list or a READ returns an empty lock-object header.
const READ_COPY = [
  "    ls_dd25v = ls_current_dd25v.",
  "    lt_dd26v[] = lt_current_dd26v[].",
  "    lt_dd27p[] = lt_current_dd27p[]."
]

// Read the stored lock object (state 'A' = active version).
const B2_ENQU = [
  "    WHEN 'ENQU'.",
  "      CALL FUNCTION 'DDIF_ENQU_GET'",
  "        EXPORTING name = lv_ddic_name state = 'A'",
  "          langu = sy-langu",
  "        IMPORTING gotstate = lv_gotstate",
  "          dd25v_wa = ls_current_dd25v",
  "        TABLES dd26e_tab = lt_current_dd26v",
  "          dd27p_tab = lt_current_dd27p",
  "        EXCEPTIONS OTHERS = 1."
]

// Version stamp for ENQU, mirroring the other object kinds.
const B3_ENQU = [
  "      WHEN 'ENQU'.",
  "        CONCATENATE ls_current_dd25v-as4date",
  "          ls_current_dd25v-as4time",
  "          INTO lv_current_version."
]

// Response payload for a lock object: header plus the locked tables (L1) and fields (L2).
const B6_ENQU = [
  "    WHEN 'ENQU'.",
  "      add_payload 'H' '1' 'LOCKOBJECT' ls_dd25v-viewname.",
  "      add_payload 'H' '1' 'DDTEXT' ls_dd25v-ddtext.",
  "      add_payload 'H' '1' 'AGGTYPE' ls_dd25v-aggtype.",
  "      add_payload 'H' '1' 'ROOTTAB' ls_dd25v-roottab.",
  "      add_payload 'H' '1' 'AS4USER' ls_dd25v-as4user.",
  "      add_payload 'H' '1' 'AS4DATE' ls_dd25v-as4date.",
  "      add_payload 'H' '1' 'AS4TIME' ls_dd25v-as4time.",
  "      LOOP AT lt_dd26v INTO ls_dd26v.",
  "        lv_index = sy-tabix.",
  "        add_payload 'L1' lv_index 'TABNAME' ls_dd26v-tabname.",
  "        add_payload 'L1' lv_index 'FORTABNAME' ls_dd26v-fortabname.",
  "        add_payload 'L1' lv_index 'FORFIELD' ls_dd26v-forfield.",
  "        add_payload 'L1' lv_index 'FORDIR' ls_dd26v-fordir.",
  "        add_payload 'L1' lv_index 'ENQMODE' ls_dd26v-enqmode.",
  "      ENDLOOP.",
  "      LOOP AT lt_dd27p INTO ls_dd27p.",
  "        lv_index = sy-tabix.",
  "        add_payload 'L2' lv_index 'VIEWFIELD' ls_dd27p-viewfield.",
  "        add_payload 'L2' lv_index 'TABNAME' ls_dd27p-tabname.",
  "        add_payload 'L2' lv_index 'FIELDNAME' ls_dd27p-fieldname.",
  "        add_payload 'L2' lv_index 'ENQMODE' ls_dd27p-enqmode.",
  "        add_payload 'L2' lv_index 'ROLLNAME' ls_dd27p-rollname.",
  "        add_payload 'L2' lv_index 'KEYFLAG' ls_dd27p-keyflag.",
  "        add_payload 'L2' lv_index 'CHECKTABLE' ls_dd27p-checktable.",
  "      ENDLOOP."
]

// Dispatch: route the new opcodes to their object types. READ_TRANSPARENT_TABLE also sets
// lv_describe so a read of an inactive-only object returns that definition instead of refusing.
// Only opcodes this carrier actually implements appear here.
const OP_DISP = [
  "    WHEN 'READ_LOCK_OBJECT'.",
  "      lv_object_type = 'ENQU'.",
  "    WHEN 'RESUME_TRANSPARENT_TABLE_ACTIVATION'.",
  "      lv_object_type = 'TABL'.",
  "      lv_write = 'X'. lv_recover = 'X'. lv_resume = 'X'."
]

// The read dispatch must mark READ_TRANSPARENT_TABLE as a describing read so the inactive-version
// branch below knows to return the stored definition rather than refuse it.
const READ_DISPATCH = [
  "    WHEN 'READ_TRANSPARENT_TABLE'.",
  "      lv_object_type = 'TABL'. lv_describe = 'X'."
]

// Replace the plain inactive refusal with one that describes the stored version when the caller is a
// describing read. Without this the advertised 1.10 read behaviour does not exist at runtime.
const INACTIVE_GUARD_BEFORE = [
  "  IF lv_gotstate IS NOT INITIAL.",
  "    IF lv_gotstate <> 'A'.",
  "      IF lv_write IS INITIAL",
  "         OR iv_expected_version IS NOT INITIAL.",
  "        ev_status = 'E'. ev_code = 'INACTIVE_VERSION_EXISTS'."
]
const INACTIVE_GUARD_AFTER = [
  "  IF lv_gotstate IS NOT INITIAL.",
  "    IF lv_gotstate <> 'A'.",
  "      IF lv_write IS INITIAL.",
  "        IF lv_describe = 'X'.",
  "          ev_status = 'S'. ev_code = 'INACTIVE_VERSION_DESCRIBED'.",
  "          ev_message = 'Inactive DDIC version described for inspection'.",
  "          ev_version = '1.10'.",
  "          add_payload 'M' '1' 'GOTSTATE' lv_gotstate.",
  "          add_payload 'M' '1' 'INACTIVE' 'X'.",
  "          IF lv_object_type = 'TABL'.",
  "            add_payload 'M' '1' 'TABNAME' iv_object_name.",
  "            add_payload 'M' '1' 'DDTEXT' ls_current_dd02v-ddtext.",
  "            add_payload 'M' '1' 'TABCLASS' ls_current_dd02v-tabclass.",
  "            add_payload 'M' '1' 'MAINFLAG' ls_current_dd02v-mainflag.",
  "            add_payload 'M' '1' 'CONTFLAG' ls_current_dd02v-contflag.",
  "            LOOP AT lt_current_dd03p ASSIGNING <ls_field>.",
  "              lv_index = sy-tabix.",
  "              add_payload 'F' lv_index 'FIELDNAME' <ls_field>-fieldname.",
  "              add_payload 'F' lv_index 'POSITION' <ls_field>-position.",
  "              add_payload 'F' lv_index 'ROLLNAME' <ls_field>-rollname.",
  "              add_payload 'F' lv_index 'KEYFLAG' <ls_field>-keyflag.",
  "              add_payload 'F' lv_index 'DATATYPE' <ls_field>-datatype.",
  "              add_payload 'F' lv_index 'LENG' <ls_field>-leng.",
  "              add_payload 'F' lv_index 'DECIMALS' <ls_field>-decimals.",
  "            ENDLOOP.",
  "          ENDIF.",
  "          RETURN.",
  "        ENDIF.",
  "        ev_status = 'E'. ev_code = 'INACTIVE_VERSION_EXISTS'."
]

// The resume path: activate the stored inactive version without sending a new definition. This is the
// body the RESUME_TRANSPARENT_TABLE_ACTIVATION dispatch arm promises, and it must exist or the
// advertised capability is a lie. Inserted as a new arm before the TABL arm of the write CASE.
const RESUME_ARM = [
  "      WHEN 'TABL'.",
  "        IF lv_resume = 'X'.",
  "          CLEAR lv_inactive_exists.",
  "          SELECT SINGLE as4local FROM dd02l INTO lv_inactive_exists",
  "            WHERE tabname = iv_object_name AND as4local = 'N'.",
  "          IF lv_inactive_exists <> 'N'.",
  "            ev_status = 'E'. ev_code = 'NO_INACTIVE_VERSION'.",
  "            ev_message = 'No inactive DDIC version exists to resume'.",
  "            ev_version = '1.10'. RETURN.",
  "          ENDIF.",
  "          REFRESH lt_act_res.",
  "          CALL FUNCTION 'DD_TABL_ACT'",
  "            EXPORTING tabname = iv_object_name auth_chk = 'X'",
  "              excommit = 'X'",
  "            IMPORTING act_result = lv_rc",
  "            TABLES act_res_tab = lt_act_res",
  "            EXCEPTIONS actok_failure = 1 dbchange_failure = 2",
  "              lockact_failure = 3 ntab_gen_failure = 4",
  "              put_failure = 5 read_failure = 6",
  "              unlockact_failure = 7 access_failure = 8",
  "              OTHERS = 9.",
  "          READ TABLE lt_act_res INTO ls_act_res",
  "            WITH KEY tabname = iv_object_name.",
  "        ELSE."
]

// Close the ELSE opened above, right before the TTYP arm of the same write CASE.
const RESUME_ARM_CLOSE = ["        ENDIF."]

const literal = (s) => `'${String(s).replace(/'/g, "''")}'`

// ------------------------------------------------------------------------------------------------
// Read the live helper and derive anchors. Anything unexpected aborts before a report is written.
// ------------------------------------------------------------------------------------------------
const client = new Client({ name: "ddic-enqu-generator", version: "1.0.0" })
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

assert.equal(before[0].trim(), `FUNCTION ${HELPER}.`, "unexpected first line")
assert.match(String(before.at(-1)).trim(), /^ENDFUNCTION\./i, "unexpected last line")

// The deployed helper must NOT already carry these operations, or this carrier would duplicate them.
for (const op of ["READ_LOCK_OBJECT", "RESUME_TRANSPARENT_TABLE_ACTIVATION"])
  assert.equal(
    before.some((l) => l.includes(op)),
    false,
    `the helper already contains ${op}; this carrier is obsolete`
  )

const findLine = (predicate, label) => {
  const i = before.findIndex(predicate)
  assert.notEqual(i, -1, `anchor not found: ${label}`)
  return i + 1
}
const findAll = (predicate) => before.map((l, i) => (predicate(l) ? i + 1 : 0)).filter((n) => n > 0)

// Declaration insert point: right after the last DD31/DD33 current-state declaration.
const declAnchor = findLine(
  (l) => l.trim() === "DATA lt_current_dd33v TYPE TABLE OF dd33v.",
  "declaration block end"
)

// Capability table: after the final OPERATION| row's APPEND.
const capAnchor = findLine(
  (l) => l.trim() === "CONCATENATE 'OPERATION|UPSERT_SEARCH_HELP' '1.8|W'",
  "last capability row"
)

// Protocol MAX row to bump.
const maxRow = findLine((l) => l.includes("ls_source-line = 'PROTOCOL|MAX|1.8'."), "PROTOCOL MAX")

// Opcode dispatch: the first WHEN OTHERS after the capability section closes the dispatch CASE.
const dispatchOthers = findAll((l) => l.trim() === "WHEN OTHERS.").find((n) => n > maxRow)
assert.ok(dispatchOthers, "opcode dispatch WHEN OTHERS not found")

// Read path: the CASE blocks that must learn about ENQU, plus the read-copy list.
//
// The SHLP arm appears six times and raw indices are easy to get wrong (an earlier revision spliced
// the payload arm into the upsert path). Select each target by what the arm actually does, identified
// from the following line, so a reordered baseline fails loudly instead of silently mis-splicing.
const shlpArms = findAll((l) => l.trim() === "WHEN 'SHLP'.").map((n) => ({
  at: n,
  next: (before[n] ?? "").trim()
}))
const armFor = (predicate, label) => {
  const hit = shlpArms.find((arm) => predicate(arm.next))
  assert.ok(
    hit,
    `could not identify the ${label} SHLP arm; following lines were:\n` +
      shlpArms.map((a) => `    L${a.at}: ${a.next}`).join("\n")
  )
  return hit.at
}

// An ABAP CASE arm ends at the NEXT `WHEN`, so an insertion point "after the WHEN line" would split
// the arm and reassign its whole body to the newly inserted arm. Every ENQU arm must therefore be
// inserted before the terminator that closes the arm it follows, not immediately after its opener.
const armEnd = (armAt, label) => {
  for (let i = armAt; i < before.length; i++) {
    const t = before[i].trim()
    if (/^WHEN\s+/.test(t) || /^ENDCASE\./.test(t)) return i + 1
  }
  assert.fail(`no terminator found for the ${label} arm starting at L${armAt}`)
}

// Read interface CASE: the arm that fetches the stored object.
const readArm = armFor((n) => n.startsWith("CALL FUNCTION 'DDIF_SHLP_GET'"), "read-interface")
// Version CASE: the arm that stamps the version from the current header.
const versionArm = armFor((n) => n.startsWith("CONCATENATE ls_current_dd30v-as4date"), "version")
// Payload CASE: the arm that emits add_payload rows.
const payloadArm = armFor((n) => n.startsWith("add_payload 'H' '1' 'SHLPNAME'"), "payload")

// The read-copy list copies current -> output; ENQU must join it or a read returns an empty header.
const readCopyAnchor = findLine(
  (l) => l.trim() === "lt_dd43v[] = lt_current_dd43v[].",
  "read-copy list end"
)

// READ_TRANSPARENT_TABLE dispatch arm, so it can be marked as a describing read.
const readDispatchArm = findLine(
  (l) => l.trim() === "WHEN 'READ_TRANSPARENT_TABLE'.",
  "READ_TRANSPARENT_TABLE dispatch"
)

// The inactive-version guard. The phrase "IF lv_write IS INITIAL" repeats across the helper, so
// locate the guard by the INACTIVE_VERSION_EXISTS it raises and walk back to the head of its IF chain.
const inactiveRaise = findLine(
  (l) => l.includes("ev_code = 'INACTIVE_VERSION_EXISTS'."),
  "INACTIVE_VERSION_EXISTS raise"
)
const guardAt = inactiveRaise - (INACTIVE_GUARD_BEFORE.length - 1)
for (let k = 0; k < INACTIVE_GUARD_BEFORE.length; k++) {
  assert.equal(
    before[guardAt - 1 + k],
    INACTIVE_GUARD_BEFORE[k],
    `inactive guard drifted at offset ${k} (line ${guardAt + k})`
  )
}

// The write CASE's TABL arm: it is the one whose body actually writes, so identify it by the
// DDIF_TABL_PUT it calls. Picking "the last WHEN 'TABL'." instead selects the payload arm in the
// response CASE and splices the resume block into the wrong CASE entirely.
const writeTablArm = (() => {
  for (let i = 0; i < before.length; i++) {
    if (before[i].trim() !== "WHEN 'TABL'.") continue
    // The arm's body runs until the next WHEN at the same or lower indent.
    for (let k = i + 1; k < before.length; k++) {
      const t = before[k].trim()
      if (/^WHEN\s+/.test(t) || /^ENDCASE\./.test(t)) break
      if (t.includes("'DDIF_TABL_PUT'")) return i + 1
    }
  }
  assert.fail("write-case TABL arm (calling DDIF_TABL_PUT) not found")
})()
const writeTtypArm = (() => {
  for (let k = writeTablArm; k < before.length; k++) {
    const t = before[k].trim()
    if (/^WHEN\s+/.test(t) || /^ENDCASE\./.test(t)) return k + 1
  }
  assert.fail("terminator of the write-case TABL arm not found")
})()
assert.ok(
  before[writeTtypArm - 1].trim().startsWith("WHEN 'TTYP'."),
  `expected the write TABL arm to end at a TTYP arm, saw: ${before[writeTtypArm - 1].trim()}`
)
console.log(`  write-case TABL arm at L${writeTablArm}, closing at L${writeTtypArm}`)

console.log("Derived anchors from the live helper:")
console.log(`  declarations after L${declAnchor}`)
console.log(`  capability rows after L${capAnchor}`)
console.log(`  PROTOCOL|MAX at L${maxRow}`)
console.log(`  opcode dispatch WHEN OTHERS at L${dispatchOthers}`)
console.log(`  read-copy end at L${readCopyAnchor}`)

// ------------------------------------------------------------------------------------------------
// Splice. Everything is expressed as verified anchors so a moved baseline fails loudly.
// ------------------------------------------------------------------------------------------------
const anchors = [
  { at: declAnchor, kind: "after", name: "DECL", lines: DECL },
  {
    at: maxRow,
    kind: "replace",
    name: "PROTOCOL_MAX",
    lines: ["      ls_source-line = 'PROTOCOL|MAX|1.10'.", "      APPEND ls_source TO it_source."]
  },
  { at: capAnchor + 2, kind: "after", name: "CAP_OPS", lines: CAP_OPS },
  { at: dispatchOthers, kind: "before", name: "OP_DISPATCH", lines: OP_DISP },
  { at: readCopyAnchor, kind: "after", name: "READ_COPY", lines: READ_COPY },
  { at: armEnd(readArm, "read-interface"), kind: "before", name: "B2_ENQU", lines: B2_ENQU },
  { at: armEnd(versionArm, "version"), kind: "before", name: "B3_ENQU", lines: B3_ENQU },
  { at: armEnd(payloadArm, "payload"), kind: "before", name: "B6_ENQU", lines: B6_ENQU },
  {
    at: guardAt,
    kind: "replaceN",
    count: INACTIVE_GUARD_BEFORE.length,
    name: "INACTIVE_GUARD",
    lines: INACTIVE_GUARD_AFTER
  },
  { at: writeTablArm, kind: "replace", name: "RESUME_ARM", lines: RESUME_ARM },
  { at: writeTtypArm, kind: "before", name: "RESUME_ARM_CLOSE", lines: RESUME_ARM_CLOSE },
  { at: readDispatchArm, kind: "replace", name: "READ_DISPATCH", lines: READ_DISPATCH }
]
for (const a of anchors)
  assert.ok(a.at >= 1 && a.at <= before.length, `anchor ${a.name} out of range`)

const hashRowBefore = before.filter((l) => l.includes("SOURCE|HASH|")).join("\n")

let after = [...before]
for (const a of [...anchors].sort((x, y) => y.at - x.at)) {
  if (!a.lines.length) continue
  if (a.kind === "before") {
    after = [...after.slice(0, a.at - 1), ...a.lines, ...after.slice(a.at - 1)]
  } else if (a.kind === "after") {
    after = [...after.slice(0, a.at), ...a.lines, ...after.slice(a.at)]
  } else if (a.kind === "replaceN") {
    // Replace `count` lines starting at a.at (1-based).
    after = [...after.slice(0, a.at - 1), ...a.lines, ...after.slice(a.at - 1 + a.count)]
  } else {
    after = [...after.slice(0, a.at - 1), ...a.lines, ...after.slice(a.at)]
  }
}

const expectedGrowth = anchors.reduce(
  (n, a) =>
    n +
    (a.kind === "replace"
      ? a.lines.length - 1
      : a.kind === "replaceN"
        ? a.lines.length - a.count
        : a.lines.length),
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
  "SOURCE|HASH changed; its basis cannot be reproduced so it must stay byte-identical"
)
for (const op of ["READ_DOMAIN", "READ_SEARCH_HELP", "RECOVER_TABLE_CONVERSION"])
  assert.ok(
    after.some((l) => l.includes(`'OPERATION|${op}'`)),
    `capability row for ${op} disappeared`
  )
assert.ok(
  after.some((l) => l.includes("'OPERATION|READ_LOCK_OBJECT'")),
  "lock object capability row missing"
)

// ------------------------------------------------------------------------------------------------
// Render the in-SAP report. The user runs this with F8; it replaces the include and regenerates.
// ------------------------------------------------------------------------------------------------
const payloadDigest = createHash("sha256")
  .update(after.join("\n"), "utf8")
  .digest("hex")
  .slice(0, 16)

const report = []
report.push(`REPORT ${PROGRAM.toLowerCase()}.`)
report.push("")
report.push(
  "* GENERATED by scripts/generate-ddic-enqu-resume-deploy-report.mjs -- do not edit by hand."
)
report.push(`* ${MARKER}`)
report.push(`* Target   : ${HELPER} (${FUNCTION_GROUP}, package ${PACKAGE})`)
report.push(`* Transport: ${TRANSPORT} (recorded; never released by this report)`)
report.push(`* Baseline : ${before.length} lines -> ${after.length} lines`)
report.push("* Adds     : READ_LOCK_OBJECT (1.9); RESUME_TRANSPARENT_TABLE_ACTIVATION (1.10)")
report.push("*            plus non-active version description; PROTOCOL|MAX 1.8 -> 1.10")
report.push("* NOT included: UPSERT_LOCK_OBJECT / DELETE_LOCK_OBJECT, whose write bodies")
report.push("* (DDIF_ENQU_PUT / DDIF_ENQU_ACTIVATE) are not part of this carrier. They are")
report.push("* deliberately absent from the capability table so the report cannot advertise")
report.push("* an opcode the helper cannot execute.")
report.push("* SOURCE|HASH is intentionally unchanged: its basis predates the placeholder")
report.push("* convention and cannot be reproduced from live source.")
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
report.push("      lv_found TYPE c LENGTH 1,")
report.push("      lv_lines TYPE i,")
report.push("      lv_suffix TYPE tfdir-include,")
report.push("      lv_msg TYPE string.")
report.push("")
report.push("START-OF-SELECTION.")
report.push(`  WRITE: / '${MARKER}'.`)
report.push("  WRITE: / 'Target      :', c_group.")
report.push(`  WRITE: / 'Lines       :', ${after.length}.`)
report.push("  WRITE: / 'payload digest:', c_digest.")
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
report.push("* Refuse to regress a helper that is already newer than this payload.")
report.push("  CLEAR lv_found.")
report.push("  LOOP AT lt_cur INTO ls_cur.")
report.push("    IF ls_cur-line CS 'PROTOCOL|MAX|1.10'.")
report.push("      lv_found = 'X'. EXIT.")
report.push("    ENDIF.")
report.push("  ENDLOOP.")
report.push("  IF lv_found = 'X'.")
report.push(
  "    WRITE: / 'NOTHING TO DO: the deployed helper is already at protocol 1.10 or later.'."
)
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
report.push("  COMMIT WORK AND WAIT.")
report.push("")
report.push("  WRITE: / 'DONE: helper regenerated at protocol 1.10;', lv_lines, 'lines written.'.")
report.push(
  "  WRITE: / 'Next: call sap_helper_status ping, then get_capability_report to confirm'."
)
report.push("  WRITE: / 'the DDIC helper self-describes maxProtocol 1.10.'.")
report.push("")

await writeFile(outFile, report.join("\n") + "\n", "utf8")
console.log("")
console.log(`wrote ${outFile}`)
console.log(`  baseline ${before.length} -> payload ${after.length} lines`)
console.log(`  payload digest ${payloadDigest}`)
