import { createHash } from "node:crypto"

// Authored deployment candidate. Importing this module never connects to or writes SAP.
export const maintenanceHelperDefinition = {
  functionName: "Z_ORVANTA_MAINT_READ",
  functionGroup: "ZORVANTA_MAINT",
  remoteEnabled: true,
  importParameters: [
    "IV_ACTION",
    "IV_USER",
    "IV_TABLE",
    "IV_OBJECT",
    "IV_ARGUMENT",
    "IV_FROM",
    "IV_TO",
    "IV_KEY",
    "IV_LIMIT"
  ].map((name) => ({ name, typeName: "STRING", optional: true, passByValue: true })),
  exportParameters: [{ name: "EV_RESULT", typeName: "STRING", passByValue: true }]
}

// CAPABILITIES self-description (docs/helper-capabilities-protocol.md 3.1/3.2/3.3).
//
// `since` is the protocol revision of the reply envelope that the opcode's own CASE branch
// answers with: every branch reaches the `fail_reply` macro, whose lv_base carries
// '"version":"1"'. It is written as x.y so PROTOCOL|MIN / PROTOCOL|MAX stay comparable with
// the other helpers. This table is the ONLY opcode list for Z_ORVANTA_MAINT_READ: the
// OPERATION rows, PROTOCOL|MIN and PROTOCOL|MAX are derived from it and never written a
// second time. Parsed offline by test/helper-capabilities-generators.test.ts.
// >>> ORVANTA-CAPABILITY-TABLE
export const maintenanceDiagnosticOperations = [
  { opcode: "LOCK_SEARCH", since: "1.0", mode: "R" },
  { opcode: "UPDATE_SEARCH", since: "1.0", mode: "R" },
  { opcode: "UPDATE_DETAIL", since: "1.0", mode: "R" }
]
// <<< ORVANTA-CAPABILITY-TABLE
if (maintenanceDiagnosticOperations.length === 0) {
  throw new Error("maintenanceDiagnosticOperations must not be empty")
}
const compareProtocolVersions = (left, right) => {
  const [leftMajor = 0, leftMinor = 0] = left.split(".").map(Number)
  const [rightMajor = 0, rightMinor = 0] = right.split(".").map(Number)
  return leftMajor - rightMajor || leftMinor - rightMinor
}
const maintenanceDiagnosticVersions = maintenanceDiagnosticOperations
  .map((operation) => operation.since)
  .sort(compareProtocolVersions)
const maintenanceDiagnosticMinProtocol = maintenanceDiagnosticVersions[0]
const maintenanceDiagnosticMaxProtocol = maintenanceDiagnosticVersions.at(-1)

// Deployment facts published as SOURCE|PACKAGE and SOURCE|TRANSPORT. Z_ORVANTA_MAINT_READ is
// deployed in w200 as FUGR/FF in ZORVANTA_MAINT, package ZABAP. The original request GR2K923421
// (task GR2K923422) was released, which left the object with no open assignment, so the
// CAPABILITIES version is recorded in request GR2K923472 / task GR2K923473. That task list was read
// from w200 on 2026-09-18 before these values were published: GR2K923472 is status D, owner WYS,
// and holds exactly one task, GR2K923473 (status D, 0 objects). The read-back after deployment
// asserts the same pair.
export const maintenanceDiagnosticDeployment = {
  packageName: "ZABAP",
  transportRequest: "GR2K923472",
  transportTask: "GR2K923473"
}

// Four 16-character placeholders make SOURCE|HASH self-referential: the generator hashes the
// finished body while the placeholders are still in it, then writes that SHA-256 into the same
// slots in order (no length change), so regenerating the same body reproduces the same hash.
// Same slot names and algorithm as scripts/bootstrap-sap-helper.ps1.
const maintenanceCapabilityHashSlots = [
  "ORVANTAHASHSLOT1",
  "ORVANTAHASHSLOT2",
  "ORVANTAHASHSLOT3",
  "ORVANTAHASHSLOT4"
]
// A payload value must not be able to inject a row separator or an escape sequence.
const escapeCapabilityField = (value) => value.replaceAll("%", "%25").replaceAll("|", "%7C")
const injectCapabilityHash = (lines) => {
  const digest = createHash("sha256").update(lines.join("\n"), "utf8").digest("hex")
  return lines.map((line) =>
    maintenanceCapabilityHashSlots.reduce(
      (text, slot, index) => text.replaceAll(slot, digest.slice(index * 16, index * 16 + 16)),
      line
    )
  )
}

// The CAPABILITIES branch emitted as the first WHEN of CASE iv_action. One ABAP line per
// payload row: the rows below are the only place where the opcode list, the protocol range,
// the deployment facts and the hash slots are written into ABAP. The reply reuses this
// helper's only response channel (the EV_RESULT JSON string) and carries the rows as the
// "payload" array, so the existing JSON contract of this helper stays intact.
// Only character-like fields (C/N/D/T/STRING) may be CONCATENATE operands and WRITE ... TO
// rejects STRING targets: the numeric sy-tzone offset is assigned to a STRING work field
// first (GENERATE_ERROR 943/944 otherwise), and the branch never uses WRITE.
// >>> ORVANTA-CAPABILITIES-SOURCE
function buildMaintenanceCapabilityBranch() {
  const rows = [
    `HELPER|${maintenanceHelperDefinition.functionName}`,
    `PROTOCOL|MIN|${maintenanceDiagnosticMinProtocol}`,
    `PROTOCOL|MAX|${maintenanceDiagnosticMaxProtocol}`,
    ...maintenanceDiagnosticOperations.map(
      (operation) => `OPERATION|${operation.opcode}|${operation.since}|${operation.mode}`
    ),
    `SOURCE|HASH|${maintenanceCapabilityHashSlots.join("")}`,
    `SOURCE|PACKAGE|${escapeCapabilityField(maintenanceDiagnosticDeployment.packageName)}`,
    `SOURCE|TRANSPORT|${escapeCapabilityField(
      maintenanceDiagnosticDeployment.transportRequest
    )}|${escapeCapabilityField(maintenanceDiagnosticDeployment.transportTask)}`
  ]
  const lines = ["  WHEN 'CAPABILITIES'.", "    CLEAR lt_capability."]
  for (const row of rows) {
    if (row.startsWith("SOURCE|HASH|")) {
      lines.push(
        `    CONCATENATE 'SOURCE|HASH|' '${maintenanceCapabilityHashSlots[0]}'`,
        `      '${maintenanceCapabilityHashSlots[1]}' '${maintenanceCapabilityHashSlots[2]}'`,
        `      '${maintenanceCapabilityHashSlots[3]}' INTO lv_capability.`,
        "    APPEND lv_capability TO lt_capability."
      )
      continue
    }
    lines.push(`    APPEND '${row}' TO lt_capability.`)
  }
  lines.push(
    // sy-sysid, sy-mandt, sy-datum and sy-uzeit are character-like, so they are legal
    // CONCATENATE operands; sy-tzone is numeric and must be converted by assignment.
    "    CONCATENATE sy-sysid sy-mandt INTO lv_capability_value",
    "      SEPARATED BY '/'.",
    "    REPLACE ALL OCCURRENCES OF '%' IN lv_capability_value WITH '%25'.",
    "    REPLACE ALL OCCURRENCES OF '|' IN lv_capability_value WITH '%7C'.",
    "    CONCATENATE 'RUNTIME|HOST|' lv_capability_value",
    "      INTO lv_capability.",
    "    APPEND lv_capability TO lt_capability.",
    "    CONCATENATE sy-datum sy-uzeit INTO lv_capability_value.",
    "    REPLACE ALL OCCURRENCES OF '%' IN lv_capability_value WITH '%25'.",
    "    REPLACE ALL OCCURRENCES OF '|' IN lv_capability_value WITH '%7C'.",
    "    lv_capability = sy-tzone.",
    "    CONDENSE lv_capability NO-GAPS.",
    "    CONCATENATE 'RUNTIME|TIME|' lv_capability_value '|' lv_capability",
    "      INTO lv_capabilities.",
    "    APPEND lv_capabilities TO lt_capability.",
    "    CLEAR lv_capabilities.",
    "    LOOP AT lt_capability INTO lv_capability.",
    "      IF sy-tabix > 1.",
    "        CONCATENATE lv_capabilities ',' INTO lv_capabilities.",
    "      ENDIF.",
    "      CONCATENATE lv_capabilities '\"' lv_capability '\"'",
    "        INTO lv_capabilities.",
    "    ENDLOOP.",
    '    CONCATENATE \'{"version":"1","status":"S",\'',
    '      \'"code":"CAPABILITIES",\'',
    '      \'"message":"ORVANTA helper capabilities",\'',
    '      \'"readOnly":true,"payload":[\' INTO lv_capability.',
    "    CONCATENATE lv_capability lv_capabilities ']}' INTO ev_result.",
    "    RETURN."
  )
  return lines
}
// <<< ORVANTA-CAPABILITIES-SOURCE

// The ABAP source format allows at most 72 characters per line; a longer line is re-chunked or
// rejected by the upload. scripts/bootstrap-sap-helper.ps1 throws on the same condition, and this
// body has no legacy over-length line, so there is no exception list here.
const assertGeneratedLineWidth = (lines) => {
  for (const line of lines) {
    if (line.length > 72) {
      throw new Error(`Generated function source exceeds 72 characters: ${line}`)
    }
  }
}

export const maintenanceDiagnosticSource = injectCapabilityHash(
  String.raw`DATA: lt_locks TYPE STANDARD TABLE OF seqg3,
      ls_lock TYPE seqg3,
      lt_headers TYPE STANDARD TABLE OF vbhdr,
      ls_header TYPE vbhdr, ls_after TYPE vbhdr,
      lt_modules TYPE STANDARD TABLE OF vbmod,
      lt_modules_after TYPE STANDARD TABLE OF vbmod,
      ls_module TYPE vbmod,
      lt_errors TYPE STANDARD TABLE OF vberror,
      lt_errors_after TYPE STANDARD TABLE OF vberror,
      ls_error TYPE vberror,
      lv_user TYPE syuname, lv_table TYPE seqg3-gname,
      lv_arg TYPE seqg3-garg, lv_key TYPE vbhdr-vbkey,
      lv_from TYPE vbhdr-vbdate, lv_to TYPE vbhdr-vbdate,
      lv_date TYPE d, lv_clock TYPE t, lv_time TYPE string,
      lv_from_date TYPE d, lv_to_date TYPE d,
      lv_from_time TYPE t, lv_to_time TYPE t,
      lv_span TYPE i, lv_limit TYPE i, lv_fetch TYPE i,
      lv_count TYPE i, lv_rows TYPE i, lv_rc TYPE sy-subrc,
      lv_number TYPE string, lv_value TYPE string,
      lv_base TYPE string, lv_tail TYPE string,
      lv_json TYPE string, lv_items TYPE string,
      lv_header_json TYPE string, lv_modules_json TYPE string,
      lv_errors_json TYPE string, lv_more TYPE string,
      lt_capability TYPE STANDARD TABLE OF string,
      lv_capability TYPE string, lv_capabilities TYPE string,
      lv_capability_value TYPE string.
DEFINE json_field.
  lv_value = &2.
  lv_value = escape( val = lv_value
    format = cl_abap_format=>e_json_string ).
  CONCATENATE lv_json &1 lv_value '"' INTO lv_json.
END-OF-DEFINITION.
DEFINE json_number.
  lv_number = &2.
  CONDENSE lv_number NO-GAPS.
  CONCATENATE lv_json &1 lv_number INTO lv_json.
END-OF-DEFINITION.
DEFINE fail_reply.
  CONCATENATE lv_base '"status":"' &1 '","code":"' &2
    '","hasMore":false,' lv_tail INTO ev_result.
END-OF-DEFINITION.
DEFINE append_item.
  IF lv_items IS NOT INITIAL.
    CONCATENATE lv_items ',' INTO lv_items.
  ENDIF.
  CONCATENATE lv_items lv_json INTO lv_items.
END-OF-DEFINITION.
DEFINE make_time.
  lv_date = &1. lv_clock = &2.
  CALL FUNCTION 'DATE_CHECK_PLAUSIBILITY'
    EXPORTING date = lv_date EXCEPTIONS OTHERS = 1.
  IF sy-subrc <> 0 OR lv_date(4) = '0000'
     OR lv_clock(2) > '23' OR lv_clock+2(2) > '59'
     OR lv_clock+4(2) > '59'.
    fail_reply 'unsupported' 'READ_FAILED'. RETURN.
  ENDIF.
  CONCATENATE lv_date(4) '-' lv_date+4(2) '-' lv_date+6(2)
    'T' lv_clock(2) ':' lv_clock+2(2) ':' lv_clock+4(2)
    INTO lv_time.
END-OF-DEFINITION.
DEFINE make_header.
  CLEAR lv_json.
  json_field '{"updateKey":"' ls_header-vbkey.
  json_field ',"client":"' ls_header-vbmandt.
  json_field ',"username":"' ls_header-vbusr.
  make_time ls_header-vbdate(8) ls_header-vbdate+8(6).
  json_field ',"systemTime":"' lv_time.
  json_field ',"program":"' ls_header-vbreport.
  json_field ',"transaction":"' ls_header-vbtcode.
  json_field ',"server":"' ls_header-vbname.
  json_number ',"state":' ls_header-vbstate.
  json_number ',"returnCode":' ls_header-vbrc.
  CONCATENATE lv_json '}' INTO lv_json.
END-OF-DEFINITION.
CLEAR ev_result.
* CAPABILITIES is this helper's read-only self-description: it needs
* no caller input, no business permission and none of the request
* validation below, so the input gate is skipped and the opcode is
* answered by the first WHEN of the CASE. The business branches still
* run behind the unchanged gate.
IF iv_action <> 'CAPABILITIES'.
  IF iv_action <> 'LOCK_SEARCH' AND iv_action <> 'UPDATE_SEARCH'
     AND iv_action <> 'UPDATE_DETAIL'. RETURN. ENDIF.
  lv_json = '{"version":"1"'.
  json_field ',"action":"' iv_action.
  json_field ',"client":"' sy-mandt.
  json_field ',"authenticatedUser":"' sy-uname.
  CONCATENATE lv_json ',"readOnly":true,' INTO lv_base.
  IF iv_action = 'UPDATE_DETAIL'.
    lv_tail = '"header":null,"modules":[],"errors":[]}'.
  ELSE.
    lv_tail = '"entries":[]}'.
  ENDIF.
  fail_reply 'unsupported' 'INVALID_INPUT'.
  IF iv_user IS INITIAL OR strlen( iv_user ) > 12.
    RETURN.
  ENDIF.
  FIND REGEX '[^A-Za-z0-9_.-]' IN iv_user.
  IF sy-subrc = 0. RETURN. ENDIF.
  lv_user = iv_user. TRANSLATE lv_user TO UPPER CASE.
  IF iv_action = 'LOCK_SEARCH'.
    IF lv_user <> sy-uname.
      AUTHORITY-CHECK OBJECT 'S_ENQUE'
        ID 'S_ENQ_ACT' FIELD 'DPFU'.
      IF sy-subrc <> 0.
        fail_reply 'forbidden' 'NO_AUTHORITY'. RETURN.
      ENDIF.
    ENDIF.
  ELSE.
* Deliberately require administration permission even for own updates.
    AUTHORITY-CHECK OBJECT 'S_ADMI_FCD'
      ID 'S_ADMI_FCD' FIELD 'UADM'.
    IF sy-subrc <> 0.
      fail_reply 'forbidden' 'NO_AUTHORITY'. RETURN.
    ENDIF.
  ENDIF.
  IF iv_action <> 'UPDATE_DETAIL'.
    IF iv_limit IS INITIAL OR strlen( iv_limit ) > 3
       OR iv_limit CN '0123456789'. RETURN. ENDIF.
    lv_limit = iv_limit.
    IF lv_limit < 1 OR lv_limit > 100. RETURN. ENDIF.
  ENDIF.
  lv_more = 'false'.
ENDIF.
TRY.
CASE iv_action.
${buildMaintenanceCapabilityBranch().join("\n")}
  WHEN 'LOCK_SEARCH'.
    IF strlen( iv_table ) > 30 OR strlen( iv_object ) > 16
       OR strlen( iv_argument ) > 150.
      RETURN.
    ENDIF.
    FIND REGEX '[[:cntrl:]]' IN iv_argument.
    IF sy-subrc = 0. RETURN. ENDIF.
    FIND REGEX '[^A-Za-z0-9_/]' IN iv_table.
    IF sy-subrc = 0. RETURN. ENDIF.
    FIND REGEX '[^A-Za-z0-9_/]' IN iv_object.
    IF sy-subrc = 0. RETURN. ENDIF.
    lv_table = iv_table. TRANSLATE lv_table TO UPPER CASE.
    lv_arg = iv_argument.
* No deletion call, local-instance fallback, or wildcard argument.
* Native ENQUEUE_READ has no server-side row-limit argument.
    CALL FUNCTION 'ENQUEUE_READ'
      EXPORTING gclient = sy-mandt guname = lv_user
        gname = lv_table garg = lv_arg gargnowc = 'X'
        local = space fast = space
      IMPORTING number = lv_count subrc = lv_rc
      TABLES enq = lt_locks
      EXCEPTIONS communication_failure = 1 system_failure = 2
        OTHERS = 3.
    IF sy-subrc <> 0 OR lv_rc <> 0.
      fail_reply 'unsupported' 'READ_FAILED'. RETURN.
    ENDIF.
    DESCRIBE TABLE lt_locks LINES lv_rows.
    IF lv_rows > 2000 OR lv_count > 2000.
      fail_reply 'unsupported' 'LIMIT_EXCEEDED'. RETURN.
    ENDIF.
    IF lv_count <> lv_rows.
      fail_reply 'unsupported' 'READ_FAILED'. RETURN.
    ENDIF.
    SORT lt_locks BY gname garg guname gobj gmode.
    CLEAR: lv_count, lv_items.
    LOOP AT lt_locks INTO ls_lock.
      IF ls_lock-gclient <> sy-mandt OR ls_lock-guname <> lv_user.
        fail_reply 'unsupported' 'READ_FAILED'. RETURN.
      ENDIF.
      IF lv_table IS NOT INITIAL AND ls_lock-gname <> lv_table.
        fail_reply 'unsupported' 'READ_FAILED'. RETURN.
      ENDIF.
      IF iv_object IS NOT INITIAL AND ls_lock-gobj <> iv_object.
        CONTINUE.
      ENDIF.
      IF iv_argument IS NOT INITIAL AND ls_lock-garg <> lv_arg.
        CONTINUE.
      ENDIF.
      ADD 1 TO lv_count.
      IF lv_count > lv_limit. lv_more = 'true'. EXIT. ENDIF.
      CLEAR lv_json.
      json_field '{"client":"' ls_lock-gclient.
      json_field ',"username":"' ls_lock-guname.
      json_field ',"tableName":"' ls_lock-gname.
      json_field ',"lockObject":"' ls_lock-gobj.
      json_field ',"argument":"' ls_lock-garg.
      json_field ',"mode":"' ls_lock-gmode.
      json_field ',"host":"' ls_lock-gthost.
      json_field ',"transaction":"' ls_lock-gtcode.
      IF ls_lock-gtdate IS INITIAL.
        CONCATENATE lv_json ',"ownerSystemTime":null' INTO lv_json.
      ELSE.
        make_time ls_lock-gtdate ls_lock-gttime.
        json_field ',"ownerSystemTime":"' lv_time.
      ENDIF.
      CONCATENATE lv_json '}' INTO lv_json.
      append_item.
    ENDLOOP.
  WHEN 'UPDATE_SEARCH'.
    IF strlen( iv_from ) <> 19 OR strlen( iv_to ) <> 19.
      RETURN.
    ENDIF.
    CONCATENATE iv_from(4) iv_from+5(2) iv_from+8(2)
      iv_from+11(2) iv_from+14(2) iv_from+17(2) INTO lv_from.
    CONCATENATE iv_to(4) iv_to+5(2) iv_to+8(2)
      iv_to+11(2) iv_to+14(2) iv_to+17(2) INTO lv_to.
    IF lv_from CN '0123456789' OR lv_to CN '0123456789'.
      RETURN.
    ENDIF.
    make_time lv_from(8) lv_from+8(6).
    IF lv_time <> iv_from. RETURN. ENDIF.
    make_time lv_to(8) lv_to+8(6).
    IF lv_time <> iv_to. RETURN. ENDIF.
    lv_from_date = lv_from(8). lv_to_date = lv_to(8).
    lv_from_time = lv_from+8(6). lv_to_time = lv_to+8(6).
    lv_span = lv_to_date - lv_from_date.
    IF lv_span < 0 OR lv_span > 1. RETURN. ENDIF.
    lv_span = lv_span * 86400
      + lv_to_time - lv_from_time.
    IF lv_span < 0 OR lv_span > 3600. RETURN. ENDIF.
    lv_fetch = lv_limit + 1.
* No VBDATA and no SM13 dialog FORMs (some of them update requests).
    SELECT * FROM vbhdr INTO TABLE lt_headers UP TO lv_fetch ROWS
      WHERE vbmandt = sy-mandt AND vbusr = lv_user
        AND vbdate >= lv_from AND vbdate <= lv_to
        AND ( vbstate = 253 OR ( vbrc >= 2 AND vbrc <= 201 ) )
      ORDER BY vbdate DESCENDING vbkey ASCENDING.
    CLEAR: lv_items, lv_count.
    LOOP AT lt_headers INTO ls_header.
      ADD 1 TO lv_count.
      IF lv_count > lv_limit. lv_more = 'true'. EXIT. ENDIF.
      make_header.
      append_item.
    ENDLOOP.
  WHEN 'UPDATE_DETAIL'.
    IF iv_key IS INITIAL OR strlen( iv_key ) > 32
       OR iv_key CN 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.
      RETURN.
    ENDIF.
    lv_key = iv_key.
    SELECT SINGLE * FROM vbhdr INTO ls_header
      WHERE vbkey = lv_key AND vbmandt = sy-mandt
        AND vbusr = lv_user.
    IF sy-subrc <> 0.
      fail_reply 'not_found' 'NOT_FOUND'. RETURN.
    ENDIF.
    IF ls_header-vbstate <> 253 AND
       ( ls_header-vbrc < 2 OR ls_header-vbrc > 201 ).
      fail_reply 'unsupported' 'DATA_CHANGED'. RETURN.
    ENDIF.
    SELECT * FROM vbmod INTO TABLE lt_modules UP TO 201 ROWS
      WHERE vbkey = lv_key ORDER BY PRIMARY KEY.
    SELECT * FROM vberror INTO TABLE lt_errors UP TO 201 ROWS
      WHERE vbkey = lv_key ORDER BY PRIMARY KEY.
    DESCRIBE TABLE lt_modules LINES lv_count.
    DESCRIBE TABLE lt_errors LINES lv_rows.
    IF lv_count > 200 OR lv_rows > 200.
      fail_reply 'unsupported' 'LIMIT_EXCEEDED'. RETURN.
    ENDIF.
* Repeat bounded detail reads; not a transaction snapshot.
    SELECT * FROM vbmod INTO TABLE lt_modules_after UP TO 201 ROWS
      WHERE vbkey = lv_key ORDER BY PRIMARY KEY.
    SELECT * FROM vberror INTO TABLE lt_errors_after UP TO 201 ROWS
      WHERE vbkey = lv_key ORDER BY PRIMARY KEY.
    SELECT SINGLE * FROM vbhdr INTO ls_after WHERE vbkey = lv_key
      AND vbmandt = sy-mandt AND vbusr = lv_user.
    IF sy-subrc <> 0 OR ls_header <> ls_after
       OR lt_modules[] <> lt_modules_after[]
       OR lt_errors[] <> lt_errors_after[].
      fail_reply 'unsupported' 'DATA_CHANGED'. RETURN.
    ENDIF.
    make_header.
    lv_header_json = lv_json.
    CLEAR lv_items.
    LOOP AT lt_modules INTO ls_module.
      lv_json = '{'.
      json_number '"number":' ls_module-vbmodcnt.
      json_field ',"functionName":"' ls_module-vbfunc.
      json_field ',"mode":"' ls_module-vbmode.
      json_number ',"returnCode":' ls_module-vbrc.
      CONCATENATE lv_json '}' INTO lv_json.
      append_item.
    ENDLOOP.
    lv_modules_json = lv_items.
    CLEAR lv_items.
    LOOP AT lt_errors INTO ls_error.
      READ TABLE lt_modules INTO ls_module
        WITH KEY vbmodcnt = ls_error-vbmodcnt.
      IF sy-subrc <> 0 OR
         ( ls_error-vbfunc IS NOT INITIAL AND
           ls_error-vbfunc <> ls_module-vbfunc ).
        fail_reply 'unsupported' 'DATA_CHANGED'. RETURN.
      ENDIF.
      lv_json = '{'.
      json_number '"number":' ls_error-vbmodcnt.
      json_field ',"functionName":"' ls_error-vbfunc.
      json_field ',"program":"' ls_error-vbreport.
      json_number ',"line":' ls_error-vbline.
      json_field ',"messageClass":"' ls_error-arbgb.
      json_field ',"messageNumber":"' ls_error-msgnr.
* Encoded VARMSGVAL is not copied or guessed as plain text.
      CONCATENATE lv_json ',"textUnavailable":true}' INTO lv_json.
      append_item.
    ENDLOOP.
    lv_errors_json = lv_items.
ENDCASE.
IF iv_action = 'UPDATE_DETAIL'.
  CONCATENATE lv_base '"status":"ok","code":"OK",'
    '"hasMore":false,"header":' lv_header_json ',"modules":['
    lv_modules_json '],"errors":[' lv_errors_json ']}' INTO ev_result.
ELSE.
  CONCATENATE lv_base '"status":"ok","code":"OK","hasMore":'
    lv_more ',"entries":[' lv_items ']}' INTO ev_result.
ENDIF.
CATCH cx_sy_open_sql_db.
  fail_reply 'unsupported' 'READ_FAILED'.
ENDTRY.
`
    .trim()
    .split("\n")
)
assertGeneratedLineWidth(maintenanceDiagnosticSource)
