// Authored deployment input, not a downloaded SAP source mirror.
import { createHash } from "node:crypto"
import { jobSpoolBranch, jobSpoolDeclarations } from "./job-spool-source.mjs"
import { reportParameterBranch, reportParameterDeclarations } from "./report-parameters-source.mjs"

// Function module every variant of this body is generated for: Z_ORVANTA_OPS_READ in function
// group ZORVANTA_LOG (src/operational-logs.ts OPERATIONAL_LOG_HELPER, scripts/deploy-job-spool.mjs
// and scripts/deploy-report-parameters.mjs). The generator itself never named it before.
export const operationalLogFunctionName = "Z_ORVANTA_OPS_READ"

// CAPABILITIES self-description (docs/helper-capabilities-protocol.md 3.1/3.2/3.3).
//
// `since` is the protocol revision of the reply envelope that the opcode's own branch answers
// with: every branch reaches the `fail_reply` macro, whose lv_base carries '"version":"1"'.
// It is written as x.y so PROTOCOL|MIN / PROTOCOL|MAX stay comparable with the other helpers.
// This table is the ONLY opcode list for Z_ORVANTA_OPS_READ: the OPERATION rows, PROTOCOL|MIN
// and PROTOCOL|MAX are derived from it and never written a second time. `requires` gates an
// opcode on the optional generator feature that compiles its branch in; the internal
// JOB_BODY_CHECK / SYSTEM_BODY_CHECK / JOB_LOG_DIAGNOSTIC alignment aliases are request
// redirects, not operations, and are deliberately not listed. Parsed offline by
// test/helper-capabilities-generators.test.ts.
// >>> ORVANTA-CAPABILITY-TABLE
export const operationalLogOperations = [
  { opcode: "JOB_SPOOL", since: "1.0", mode: "R", requires: "spool" },
  { opcode: "JOB_DETAILS", since: "1.0", mode: "R" },
  { opcode: "JOB_LOG", since: "1.0", mode: "R" },
  { opcode: "JOB_SEARCH", since: "1.0", mode: "R" },
  { opcode: "SYSTEM_READ", since: "1.0", mode: "R" },
  { opcode: "REPORT_PARAMETERS", since: "1.0", mode: "R", requires: "parameters" }
]
// <<< ORVANTA-CAPABILITY-TABLE
const compareProtocolVersions = (left, right) => {
  const [leftMajor = 0, leftMinor = 0] = left.split(".").map(Number)
  const [rightMajor = 0, rightMinor = 0] = right.split(".").map(Number)
  return leftMajor - rightMajor || leftMinor - rightMinor
}

// Deployment facts published as SOURCE|PACKAGE and SOURCE|TRANSPORT. Z_ORVANTA_OPS_READ is
// deployed in package ZABAP. Its original request GR2K923421 (task GR2K923422) carried the
// historical progression described in scripts/deploy-job-spool.mjs,
// scripts/deploy-report-parameters.mjs and docs/diagnostic-suite.md, and has since been released,
// leaving the object with no open assignment. The CAPABILITIES version is therefore recorded in
// request GR2K923472 / task GR2K923473, whose live task list was read from w200 on 2026-09-18
// before these values were published (one task, GR2K923473, status D, 0 objects).
export const operationalLogDeployment = {
  packageName: "ZABAP",
  transportRequest: "GR2K923472",
  transportTask: "GR2K923473"
}

// Four 16-character placeholders make SOURCE|HASH self-referential: the generator hashes the
// finished body while the placeholders are still in it, then writes that SHA-256 into the same
// slots in order (no length change), so regenerating the same body reproduces the same hash.
// Same slot names and algorithm as scripts/bootstrap-sap-helper.ps1.
const operationalCapabilityHashSlots = [
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
    operationalCapabilityHashSlots.reduce(
      (text, slot, index) => text.replaceAll(slot, digest.slice(index * 16, index * 16 + 16)),
      line
    )
  )
}

// The CAPABILITIES branch emitted as the first WHEN of CASE iv_action. One ABAP line per
// payload row: the rows below are the only place where the opcode list, the protocol range,
// the deployment facts and the hash slots are written into ABAP. The reply reuses this
// helper's only response channel (the EV_RESULT JSON string) and carries the rows as the
// "payload" array, so the existing JSON contract of this helper stays intact. The branch
// returns immediately and never reaches the read logic that follows the CASE.
// Only character-like fields (C/N/D/T/STRING) may be CONCATENATE operands and WRITE ... TO
// rejects STRING targets: the numeric sy-tzone offset is assigned to a STRING work field
// first (GENERATE_ERROR 943/944 otherwise), and the branch never uses WRITE.
// >>> ORVANTA-CAPABILITIES-SOURCE
function buildOperationalCapabilityBranch(operations) {
  if (operations.length === 0) throw new Error("operationalLogOperations is empty")
  const versions = operations.map((operation) => operation.since).sort(compareProtocolVersions)
  const rows = [
    `HELPER|${operationalLogFunctionName}`,
    `PROTOCOL|MIN|${versions[0]}`,
    `PROTOCOL|MAX|${versions.at(-1)}`,
    ...operations.map(
      (operation) => `OPERATION|${operation.opcode}|${operation.since}|${operation.mode}`
    ),
    `SOURCE|HASH|${operationalCapabilityHashSlots.join("")}`,
    `SOURCE|PACKAGE|${escapeCapabilityField(operationalLogDeployment.packageName)}`,
    `SOURCE|TRANSPORT|${escapeCapabilityField(
      operationalLogDeployment.transportRequest
    )}|${escapeCapabilityField(operationalLogDeployment.transportTask)}`
  ]
  const lines = ["  WHEN 'CAPABILITIES'.", "    CLEAR lt_capability."]
  for (const row of rows) {
    if (row.startsWith("SOURCE|HASH|")) {
      lines.push(
        `    CONCATENATE 'SOURCE|HASH|' '${operationalCapabilityHashSlots[0]}'`,
        `      '${operationalCapabilityHashSlots[1]}' '${operationalCapabilityHashSlots[2]}'`,
        `      '${operationalCapabilityHashSlots[3]}' INTO lv_capability.`,
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

// Generated lines that were already longer than the 72-character ABAP source limit before the
// CAPABILITIES branch existed: three comments contributed by the job-spool include and the base
// variant's own comment, which scripts/deploy-job-spool.mjs repairs at deploy time. They are
// listed explicitly so any new over-length line - especially a generated statement - fails here
// instead of reaching SAP. Exported for test/helper-capabilities-generators.test.ts.
export const operationalOverLengthComments = [
  "* No direct RFC table bypass: exact current-client job and SHOW checked above.",
  "* Reject configured alternate authorization modes before any customer exit.",
  "* Use the SAP spool permission path; job display is not spool authorization.",
  "* Clear saved list memory before rendering, including reused RFC sessions."
]
// scripts/bootstrap-sap-helper.ps1 throws on the same condition.
const assertGeneratedLineWidth = (lines) => {
  for (const line of lines) {
    if (line.length <= 72 || operationalOverLengthComments.includes(line)) continue
    throw new Error(`Generated function source exceeds 72 characters: ${line}`)
  }
}

function buildOperationalLogSource(includeSpool, includeParameters = false) {
  const operations = operationalLogOperations.filter(
    (operation) =>
      (operation.requires !== "spool" || includeSpool) &&
      (operation.requires !== "parameters" || includeParameters)
  )
  const lines = injectCapabilityHash(
    String.raw`
DATA: lt_jobs TYPE STANDARD TABLE OF tbtco,
      ls_job TYPE tbtco, ls_job_check TYPE tbtco,
      lt_steps TYPE STANDARD TABLE OF tbtcp,
      lt_steps_check TYPE STANDARD TABLE OF tbtcp,
      ls_step TYPE tbtcp,
      ls_temse TYPE tst01,
      ls_file TYPE rslgfinfo, ls_file_after TYPE rslgfinfo,
      ls_entry TYPE rslgentr_new, ls_type TYPE rslgetyp,
      lt_param_entries TYPE STANDARD TABLE OF rslgentr_new,
      ls_param_entry TYPE rslgentr_new,
      lv_param_array TYPE c LENGTH 620,
      lv_param_data TYPE string, lv_params_ready TYPE c,
      lv_param_valid TYPE c, lv_param_offset TYPE i,
      lv_param_date TYPE d, lv_param_time TYPE t,
      lv_param_age TYPE i,
      ls_plain TYPE tbtc0, ls_decoded TYPE btctl1,
      ls_parameters TYPE btctlp,
      lv_bad TYPE btcchar1, lv_diagnostic TYPE c,
      lv_body_check TYPE c, lv_body_stage TYPE string,
      lv_param_matches TYPE i,
      lt_job_params TYPE STANDARD TABLE OF string,
      lv_job_component TYPE string, lv_job_slot TYPE n LENGTH 1,
      lv_job_length TYPE i, lv_job_next TYPE i,
      lv_job_marker TYPE c,
      lv_base TYPE string, lv_json TYPE string,
      lv_tail TYPE string, lv_items TYPE string,
      lv_header TYPE string, lv_value TYPE string,
      lv_time TYPE string, lv_more TYPE string,
      lv_date TYPE d, lv_clock TYPE t,
      lv_from_d TYPE d, lv_from_t TYPE t,
      lv_to_d TYPE d, lv_to_t TYPE t,
      lv_limit TYPE i, lv_fetch TYPE i, lv_rows TYPE i,
      lv_days TYPE i, lv_span TYPE i, lv_max_span TYPE i,
      lv_index TYPE i, lv_number TYPE c LENGTH 20,
      lv_server TYPE c LENGTH 64,
      lv_path TYPE c LENGTH 198, lv_root TYPE rsts_path,
      lv_part TYPE n LENGTH 4,
      lv_size TYPE p LENGTH 5, lv_size_after TYPE p LENGTH 5,
      lv_errno TYPE c LENGTH 5, lv_error TYPE c LENGTH 100,
      lv_position TYPE i, lv_bytes TYPE i, lv_chars TYPE i,
      lv_rc TYPE i, lv_scanned TYPE i, lv_end TYPE i,
      lv_codepage TYPE tst01-dcharcod,
      lv_buffer TYPE c LENGTH 30000,
      lv_raw TYPE string, lv_line TYPE string,
      lt_lines TYPE STANDARD TABLE OF string,
      lv_text TYPE c LENGTH 4096,
      lv_t100 TYPE t100-text,
      lv_template TYPE tsl1t-txt,
      lv_rendered TYPE string, lv_word TYPE string,
      lt_words TYPE STANDARD TABLE OF string,
      lv_missing TYPE string, lv_token TYPE c,
      lv_offset TYPE i, lv_data_offset TYPE i,
      lv_length TYPE i, lv_take TYPE i, lv_word_index TYPE i,
      lv_dollars TYPE c,
      lv_message_id TYPE c LENGTH 3,
      lt_capability TYPE STANDARD TABLE OF string,
      lv_capability TYPE string, lv_capabilities TYPE string,
      lv_capability_value TYPE string.
${includeParameters ? reportParameterDeclarations + "\n" : ""}${includeSpool ? jobSpoolDeclarations + "\n" : ""}RANGES: lr_user FOR ls_job-sdluname,
        lr_status FOR ls_job-status.
FIELD-SYMBOLS: <job_param> TYPE btcltext,
               <job_length> TYPE btcint4.
DEFINE json_field.
  lv_value = &2.
  lv_value = escape( val = lv_value
    format = cl_abap_format=>e_json_string ).
  CONCATENATE lv_json &1 lv_value '"' INTO lv_json.
END-OF-DEFINITION.
DEFINE make_time.
  lv_date = &1. lv_clock = &2.
  CALL FUNCTION 'DATE_CHECK_PLAUSIBILITY'
    EXPORTING date = lv_date EXCEPTIONS OTHERS = 1.
  IF sy-subrc <> 0 OR lv_date(4) = '0000'
     OR lv_clock(2) > '23' OR lv_clock+2(2) > '59'
     OR lv_clock+4(2) > '59'.
    RETURN.
  ENDIF.
  CONCATENATE lv_date(4) '-' lv_date+4(2) '-' lv_date+6(2)
    'T' lv_clock(2) ':' lv_clock+2(2) ':' lv_clock+4(2)
    INTO lv_time.
END-OF-DEFINITION.
DEFINE make_job.
  lv_json = ''.
  json_field '{"jobName":"' ls_job-jobname.
  json_field ',"jobCount":"' ls_job-jobcount.
  json_field ',"status":"' ls_job-status.
  json_field ',"username":"' ls_job-sdluname.
  json_field ',"executionUser":"' ls_job-authcknam.
  json_field ',"server":"' ls_job-execserver.
  make_time ls_job-sdlstrtdt ls_job-sdlstrttm.
  json_field ',"scheduledSystemTime":"' lv_time.
  IF ls_job-strtdate IS INITIAL.
    CONCATENATE lv_json ',"startSystemTime":null' INTO lv_json.
  ELSE.
    make_time ls_job-strtdate ls_job-strttime.
    json_field ',"startSystemTime":"' lv_time.
  ENDIF.
  IF ls_job-enddate IS INITIAL.
    CONCATENATE lv_json ',"endSystemTime":null' INTO lv_json.
  ELSE.
    make_time ls_job-enddate ls_job-endtime.
    json_field ',"endSystemTime":"' lv_time.
  ENDIF.
  CONCATENATE lv_json '}' INTO lv_json.
END-OF-DEFINITION.
DEFINE fail_reply.
  IF lv_body_check = 'X'.
    ev_result = &2.
  ELSE.
    CONCATENATE lv_base '"status":"' &1 '","code":"' &2
      '",' lv_tail INTO ev_result.
  ENDIF.
END-OF-DEFINITION.
DEFINE job_stage.
  IF lv_body_check = 'X'. ev_result = &1. ENDIF.
  IF lv_diagnostic = 'X'.
    CONCATENATE lv_base
      '"status":"unsupported","code":"READ_ONLY_UNSUPPORTED",'
      '"reason":"' &1 '",' lv_tail INTO ev_result.
  ENDIF.
END-OF-DEFINITION.
CLEAR ev_result.
${includeParameters ? reportParameterBranch + "\n" : ""}IF iv_action = 'JOB_BODY_CHECK'.
  lv_body_check = 'X'.
  iv_action = 'JOB_LOG'.
ELSEIF iv_action = 'SYSTEM_BODY_CHECK'.
  lv_body_check = 'X'.
  iv_action = 'SYSTEM_READ'.
ENDIF.
IF iv_action = 'JOB_LOG_DIAGNOSTIC'.
  lv_diagnostic = 'X'.
  iv_action = 'JOB_LOG'.
ENDIF.
* CAPABILITIES answers before the read validation: the first WHEN of
* the CASE below returns the self-description, not business logic.
IF iv_action <> 'CAPABILITIES'
   AND iv_action <> 'JOB_SEARCH' AND iv_action <> 'JOB_LOG'
   AND iv_action <> 'JOB_DETAILS'
${includeSpool ? "   AND iv_action <> 'JOB_SPOOL'\n" : ""}   AND iv_action <> 'SYSTEM_READ'.
  RETURN.
ENDIF.
lv_json = '{"version":"1"'.
json_field ',"action":"' iv_action.
json_field ',"client":"' sy-mandt.
json_field ',"authenticatedUser":"' sy-uname.
CONCATENATE lv_json ',"readOnly":true,' INTO lv_base.
lv_server = sy-host.
CALL 'C_SAPGPARAM' ID 'NAME' FIELD 'rdisp/myname'
  ID 'VALUE' FIELD lv_server.
IF sy-subrc <> 0 OR lv_server IS INITIAL. RETURN. ENDIF.
lv_json = ''.
CASE iv_action.
${buildOperationalCapabilityBranch(operations).join("\n")}
${
  includeSpool
    ? String.raw`  WHEN 'JOB_SPOOL'.
    lv_tail = '"job":null,"stepNumber":null,"spoolId":null,'.
    CONCATENATE lv_tail '"page":null,"spoolStamp":null,"lines":[]}'
      INTO lv_tail.
`
    : ""
}  WHEN 'JOB_DETAILS'.
    lv_tail = '"job":null,"steps":[],"complete":true}'.
  WHEN 'JOB_LOG'.
    lv_tail = '"job":null,"messages":[],"complete":true}'.
  WHEN 'JOB_SEARCH'.
    json_field '"fromSystemTime":"' iv_from.
    json_field ',"toSystemTime":"' iv_to.
    CONCATENATE lv_json ',"jobs":[],"hasMore":false}' INTO lv_tail.
  WHEN 'SYSTEM_READ'.
    json_field '"fromSystemTime":"' iv_from.
    json_field ',"toSystemTime":"' iv_to.
    json_field ',"server":"' lv_server.
    CONCATENATE lv_json ',"entries":[],'
      '"coverage":"local_instance_bounded_tail",'
      '"scannedRecords":0,"truncated":true}' INTO lv_tail.
ENDCASE.
fail_reply 'unsupported' 'READ_ONLY_UNSUPPORTED'.
job_stage 'INPUT_VALIDATION'.
IF strlen( iv_user ) > 12 OR iv_user CA '*+%?'
   OR strlen( iv_program ) > 40 OR iv_program CA '*+%?'.
  RETURN.
ENDIF.
IF iv_action <> 'JOB_LOG' AND iv_action <> 'JOB_DETAILS'${includeSpool ? "\n   AND iv_action <> 'JOB_SPOOL'" : ""}.
  FIND REGEX
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$'
    IN iv_from.
  IF sy-subrc <> 0. RETURN. ENDIF.
  FIND REGEX
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$'
    IN iv_to.
  IF sy-subrc <> 0. RETURN. ENDIF.
  CONCATENATE iv_from(4) iv_from+5(2) iv_from+8(2) INTO lv_from_d.
  CONCATENATE iv_from+11(2) iv_from+14(2) iv_from+17(2)
    INTO lv_from_t.
  CONCATENATE iv_to(4) iv_to+5(2) iv_to+8(2) INTO lv_to_d.
  CONCATENATE iv_to+11(2) iv_to+14(2) iv_to+17(2) INTO lv_to_t.
  make_time lv_from_d lv_from_t.
  make_time lv_to_d lv_to_t.
  lv_days = lv_to_d - lv_from_d.
  IF lv_days < 0 OR lv_days > 1. RETURN. ENDIF.
  lv_span = lv_days * 86400 + lv_to_t - lv_from_t.
  lv_max_span = 86400.
  IF iv_action = 'SYSTEM_READ'. lv_max_span = 3600. ENDIF.
  IF lv_span < 0 OR lv_span > lv_max_span. RETURN. ENDIF.
  IF iv_limit IS INITIAL OR strlen( iv_limit ) > 3
     OR iv_limit CN '0123456789'.
    RETURN.
  ENDIF.
  lv_limit = iv_limit.
  IF lv_limit < 1 OR lv_limit > 200. RETURN. ENDIF.
ENDIF.
TRY.
${includeSpool ? jobSpoolBranch + "\n" : ""}IF iv_action = 'JOB_SEARCH' OR iv_action = 'JOB_LOG'
   OR iv_action = 'JOB_DETAILS'.
  IF iv_jobname IS INITIAL OR strlen( iv_jobname ) > 32
     OR iv_jobname CA '*+%?' OR iv_program IS NOT INITIAL.
    RETURN.
  ENDIF.
  IF iv_action = 'JOB_SEARCH'.
    IF lv_limit > 50 OR iv_jobcount IS NOT INITIAL
       OR strlen( iv_status ) > 1.
      RETURN.
    ENDIF.
    IF iv_status IS NOT INITIAL
       AND iv_status CN 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.
      RETURN.
    ENDIF.
    IF iv_after_job IS NOT INITIAL.
      IF strlen( iv_after_job ) <> 8 OR iv_after_job CN '0123456789'.
        RETURN.
      ENDIF.
    ENDIF.
    IF iv_user IS NOT INITIAL.
      lr_user-sign = 'I'. lr_user-option = 'EQ'.
      lr_user-low = iv_user. APPEND lr_user.
    ENDIF.
    IF iv_status IS NOT INITIAL.
      lr_status-sign = 'I'. lr_status-option = 'EQ'.
      lr_status-low = iv_status. APPEND lr_status.
    ENDIF.
    lv_fetch = lv_limit + 1.
* TBTCO has no implicit client key.
    SELECT jobname jobcount status sdluname authcknam authckman
      jobgroup execserver sdlstrtdt sdlstrttm strtdate strttime
      enddate endtime
      FROM tbtco INTO CORRESPONDING FIELDS OF TABLE lt_jobs
      UP TO lv_fetch ROWS
      WHERE authckman = sy-mandt AND jobname = iv_jobname
        AND jobcount > iv_after_job AND sdluname IN lr_user
        AND status IN lr_status
        AND ( sdlstrtdt > lv_from_d OR
          ( sdlstrtdt = lv_from_d AND sdlstrttm >= lv_from_t ) )
        AND ( sdlstrtdt < lv_to_d OR
          ( sdlstrtdt = lv_to_d AND sdlstrttm <= lv_to_t ) )
      ORDER BY jobcount.
  ELSE.
    IF strlen( iv_jobcount ) <> 8 OR iv_jobcount CN '0123456789'
       OR iv_from IS NOT INITIAL OR iv_to IS NOT INITIAL
       OR iv_user IS NOT INITIAL OR iv_status IS NOT INITIAL
       OR iv_after_job IS NOT INITIAL.
      RETURN.
    ENDIF.
    IF ( iv_action = 'JOB_LOG' AND iv_limit <> '1000' )
       OR ( iv_action = 'JOB_DETAILS' AND iv_limit <> '100' ).
      RETURN.
    ENDIF.
    SELECT SINGLE * FROM tbtco INTO ls_job
      WHERE jobname = iv_jobname AND jobcount = iv_jobcount
        AND authckman = sy-mandt.
    IF sy-subrc <> 0.
      fail_reply 'not_found' 'NOT_FOUND'.
      RETURN.
    ENDIF.
    APPEND ls_job TO lt_jobs.
  ENDIF.
  LOOP AT lt_jobs INTO ls_job.
    AUTHORITY-CHECK OBJECT 'S_BTCH_JOB'
      ID 'JOBGROUP' FIELD ls_job-jobgroup ID 'JOBACTION' FIELD 'SHOW'.
    IF sy-subrc <> 0.
      fail_reply 'forbidden' 'NO_AUTHORITY'. RETURN.
    ENDIF.
  ENDLOOP.
  IF iv_action = 'JOB_SEARCH'.
    DESCRIBE TABLE lt_jobs LINES lv_rows.
    lv_more = 'false'.
    IF lv_rows > lv_limit.
      lv_more = 'true'. DELETE lt_jobs INDEX lv_fetch.
    ENDIF.
    lv_items = '['.
    LOOP AT lt_jobs INTO ls_job.
      IF sy-tabix > 1.
        CONCATENATE lv_items ',' INTO lv_items.
      ENDIF.
      make_job.
      CONCATENATE lv_items lv_json INTO lv_items.
    ENDLOOP.
    CONCATENATE lv_items ']' INTO lv_items.
    lv_json = ''.
    json_field '"fromSystemTime":"' iv_from.
    json_field ',"toSystemTime":"' iv_to.
    CONCATENATE lv_json ',"jobs":' lv_items ',"hasMore":' lv_more
      '}' INTO lv_tail.
    fail_reply 'ok' 'OK'.
    RETURN.
  ENDIF.
  IF iv_action = 'JOB_DETAILS'.
${includeSpool ? "* Exact current-client job and SHOW permission checked above.\n* No direct RFC table bypass." : "* No direct RFC table bypass: exact current-client job and SHOW checked above."}
    SELECT stepcount progname variant authcknam listident xpgflag
      FROM tbtcp INTO CORRESPONDING FIELDS OF TABLE lt_steps
      UP TO 101 ROWS
      WHERE jobname = iv_jobname AND jobcount = iv_jobcount
      ORDER BY stepcount.
    DESCRIBE TABLE lt_steps LINES lv_rows.
    IF lv_rows > 100.
      fail_reply 'unsupported' 'LIMIT_EXCEEDED'. RETURN.
    ENDIF.
    SELECT SINGLE * FROM tbtco INTO ls_job_check
      WHERE jobname = iv_jobname AND jobcount = iv_jobcount
        AND authckman = sy-mandt.
    IF sy-subrc <> 0 OR ls_job_check <> ls_job.
      fail_reply 'unsupported' 'LOG_CHANGED'. RETURN.
    ENDIF.
    SELECT stepcount progname variant authcknam listident xpgflag
      FROM tbtcp INTO CORRESPONDING FIELDS OF TABLE lt_steps_check
      UP TO 101 ROWS
      WHERE jobname = iv_jobname AND jobcount = iv_jobcount
      ORDER BY stepcount.
    IF lt_steps <> lt_steps_check.
      fail_reply 'unsupported' 'LOG_CHANGED'. RETURN.
    ENDIF.
    make_job.
    lv_header = lv_json.
    lv_items = '['.
    LOOP AT lt_steps INTO ls_step.
      IF sy-tabix > 1.
        CONCATENATE lv_items ',' INTO lv_items.
      ENDIF.
      lv_number = ls_step-stepcount.
      SHIFT lv_number LEFT DELETING LEADING space.
      CONCATENATE '{"stepNumber":' lv_number INTO lv_json.
      json_field ',"program":"' ls_step-progname.
      json_field ',"variant":"' ls_step-variant.
      json_field ',"executionUser":"' ls_step-authcknam.
      json_field ',"spoolId":"' ls_step-listident.
      json_field ',"stepTypeCode":"' ls_step-xpgflag.
      CONCATENATE lv_items lv_json '}' INTO lv_items.
    ENDLOOP.
    CONCATENATE '"job":' lv_header ',"steps":' lv_items
      '],"complete":true}' INTO lv_tail.
    fail_reply 'ok' 'OK'.
    RETURN.
  ENDIF.
* Require log-display permission even for another user's job.
  AUTHORITY-CHECK OBJECT 'S_BTCH_JOB'
    ID 'JOBGROUP' FIELD ls_job-jobgroup ID 'JOBACTION' FIELD 'PROT'.
  IF sy-subrc <> 0.
    fail_reply 'forbidden' 'NO_AUTHORITY'. RETURN.
  ENDIF.
  make_job.
  lv_header = lv_json.
  job_stage 'TEMSE_NAME'.
  IF ls_job-joblog(6) <> 'JOBLGX'
     OR ls_job-joblog CN 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.
    RETURN.
  ENDIF.
  job_stage 'TEMSE_STORAGE'.
  SELECT SINGLE * FROM tst01 CLIENT SPECIFIED INTO ls_temse
    WHERE dclient = sy-mandt AND dname = ls_job-joblog.
  IF sy-subrc <> 0 OR ls_temse-dstotyp <> 'F'. RETURN. ENDIF.
  job_stage 'TEMSE_CODEPAGE'.
  CALL FUNCTION 'SCP_GET_CODEPAGE_NUMBER'
    IMPORTING appl_codepage = lv_codepage EXCEPTIONS OTHERS = 1.
  IF sy-subrc <> 0 OR ls_temse-dcharcod <> lv_codepage. RETURN. ENDIF.
* Derive the TemSe path from the authorized job, never caller input.
  job_stage 'TEMSE_PATH'.
  CALL 'C_SAPGPARAM' ID 'NAME' FIELD 'DIR_GLOBAL'
    ID 'VALUE' FIELD lv_root.
  IF sy-subrc <> 0 OR lv_root IS INITIAL. RETURN. ENDIF.
  lv_part = ls_temse-dpart.
  CONCATENATE lv_root '/' sy-mandt ls_job-joblog(5) '/'
    lv_part ls_job-joblog+5(15) INTO lv_path.
  job_stage 'TEMSE_FILE_ATTRIBUTES'.
  CALL 'C_FILE_ATTRIBUTES' ID 'NAME' FIELD lv_path
    ID 'LEN' FIELD lv_size
    ID 'ERRNO' FIELD lv_errno ID 'ERRMSG' FIELD lv_error.
  IF sy-subrc <> 0. RETURN. ENDIF.
  IF lv_size > 30000 * cl_abap_char_utilities=>charsize.
    fail_reply 'unsupported' 'LIMIT_EXCEEDED'. RETURN.
  ENDIF.
  job_stage 'TEMSE_FILE_SIZE'.
  IF lv_size <= 0. RETURN. ENDIF.
  IF lv_size MOD cl_abap_char_utilities=>charsize <> 0. RETURN. ENDIF.
  lv_bytes = lv_size.
  lv_chars = lv_bytes / cl_abap_char_utilities=>charsize.
  lv_position = 0.
  job_stage 'TEMSE_FILE_READ'.
  CALL 'C_RSTRB_READ_BUFFERED' ID 'BUFF' FIELD lv_buffer
    ID 'POSI' FIELD lv_position ID 'NAME' FIELD lv_path
    ID 'SIZE' FIELD lv_bytes.
  lv_rc = sy-subrc.
  CALL 'C_RSTRB_READ_BUFFERED' ID 'BUFF' FIELD lv_buffer
    ID 'CLOS' FIELD 'X'.
* RSTS_READ_OBJECT_DIRECT also accepts 4: data followed by end-of-file.
  IF lv_rc <> 0 AND lv_rc <> 4. RETURN. ENDIF.
  job_stage 'TEMSE_RECORD_LAYOUT'.
  lv_raw = lv_buffer(lv_chars).
  lv_index = strlen( lv_raw ) - 1.
  IF lv_index < 0. RETURN. ENDIF.
  IF lv_raw+lv_index(1) <> cl_abap_char_utilities=>newline.
    RETURN.
  ENDIF.
  SPLIT lv_raw AT cl_abap_char_utilities=>newline INTO TABLE lt_lines.
  DESCRIBE TABLE lt_lines LINES lv_rows.
  IF lv_rows > 1001.
    fail_reply 'unsupported' 'LIMIT_EXCEEDED'. RETURN.
  ENDIF.
  lv_items = '['.
  CLEAR lv_index.
  LOOP AT lt_lines INTO lv_line.
    IF sy-tabix = lv_rows AND lv_line IS INITIAL. CONTINUE. ENDIF.
    job_stage 'TEMSE_RECORD_LAYOUT'.
    IF strlen( lv_line ) < 16 OR strlen( lv_line ) > 232. RETURN. ENDIF.
    CLEAR: ls_plain, ls_decoded, ls_parameters, lv_bad.
    ls_plain = lv_line.
    job_stage 'TEMSE_RECORD_FORMAT'.
    IF ls_plain-format <> 'F'. RETURN. ENDIF.
    job_stage 'TEMSE_PARAMETERS'.
    IF lv_body_check = 'X'. ev_result = 'JOB_DECODE_EXCEPTION'. ENDIF.
    PERFORM assign_flex_entry IN PROGRAM ('SAPLSTLG')
      USING ls_plain CHANGING ls_decoded ls_parameters lv_bad.
    IF lv_body_check = 'X'. ev_result = 'JOB_DECODE_INVALID'. ENDIF.
    IF lv_bad IS NOT INITIAL. RETURN. ENDIF.
    IF lv_body_check = 'X'. ev_result = 'JOB_PARAMETER_COUNT'. ENDIF.
    IF ls_decoded-numpar > 8. RETURN. ENDIF.
    IF lv_body_check = 'X'. ev_result = 'JOB_PARAMETER_LENGTH'. ENDIF.
    REFRESH lt_job_params.
* BTCTLP has eight CHAR128 slots; reject native truncation, not padding.
    DO 8 TIMES.
      lv_job_slot = sy-index.
      CONCATENATE 'MSGPAR' lv_job_slot INTO lv_job_component.
      ASSIGN COMPONENT lv_job_component OF STRUCTURE ls_parameters
        TO <job_param>.
      IF sy-subrc <> 0. RETURN. ENDIF.
      CONCATENATE lv_job_component 'LEN' INTO lv_job_component.
      ASSIGN COMPONENT lv_job_component OF STRUCTURE ls_parameters
        TO <job_length>.
      IF sy-subrc <> 0. RETURN. ENDIF.
      lv_job_length = <job_length>.
      IF lv_job_length < 0 OR lv_job_length > 128. RETURN. ENDIF.
      CLEAR lv_word.
      IF lv_job_length > 0.
        CONCATENATE lv_word <job_param>+0(lv_job_length) INTO lv_word
          RESPECTING BLANKS.
      ENDIF.
      APPEND lv_word TO lt_job_params.
    ENDDO.
    job_stage 'MESSAGE_RENDERING'.
    SELECT SINGLE text FROM t100 INTO lv_t100
      WHERE sprsl = sy-langu AND arbgb = ls_decoded-arbgb
        AND msgnr = ls_decoded-msgnr.
    IF sy-subrc <> 0. RETURN. ENDIF.
* Follow DECODE_T100_MSG's eight-slot syntax without SAPLSTLG globals.
    CLEAR: lv_rendered, lv_offset, lv_job_next.
    lv_length = strlen( lv_t100 ).
    WHILE lv_offset < lv_length.
      lv_token = lv_t100+lv_offset(1).
      ADD 1 TO lv_offset.
      IF lv_token = '&' OR lv_token = '$'.
        lv_job_marker = lv_token.
        CLEAR lv_token.
        IF lv_offset < lv_length.
          lv_token = lv_t100+lv_offset(1).
        ENDIF.
        IF lv_token = '&' OR lv_token = '$'.
          CONCATENATE lv_rendered lv_job_marker INTO lv_rendered
            RESPECTING BLANKS.
          ADD 1 TO lv_offset.
        ELSE.
          ADD 1 TO lv_job_next.
          lv_word_index = lv_job_next.
          IF lv_token CO '12345678' AND lv_token IS NOT INITIAL.
            lv_word_index = lv_token.
            ADD 1 TO lv_offset.
          ENDIF.
          IF lv_job_next <= ls_decoded-numpar.
            READ TABLE lt_job_params INTO lv_word INDEX lv_word_index.
            IF sy-subrc <> 0. RETURN. ENDIF.
            CONCATENATE lv_rendered lv_word INTO lv_rendered
              RESPECTING BLANKS.
          ENDIF.
        ENDIF.
      ELSE.
        CONCATENATE lv_rendered lv_token INTO lv_rendered
          RESPECTING BLANKS.
      ENDIF.
      IF strlen( lv_rendered ) > 4096. RETURN. ENDIF.
    ENDWHILE.
    lv_text = lv_rendered.
    make_time ls_plain-enterdate ls_plain-entertime.
    ADD 1 TO lv_index.
    lv_number = lv_index. CONDENSE lv_number NO-GAPS.
    CONCATENATE '{"number":' lv_number INTO lv_json.
    json_field ',"systemTime":"' lv_time.
    json_field ',"type":"' ls_decoded-msgtype.
    json_field ',"messageClass":"' ls_decoded-arbgb.
    json_field ',"messageNumber":"' ls_decoded-msgnr.
    json_field ',"text":"' lv_text.
    CONCATENATE lv_json ',"textTruncated":false}' INTO lv_json.
    IF lv_index > 1. CONCATENATE lv_items ',' INTO lv_items. ENDIF.
    CONCATENATE lv_items lv_json INTO lv_items.
  ENDLOOP.
  CALL 'C_FILE_ATTRIBUTES' ID 'NAME' FIELD lv_path
    ID 'LEN' FIELD lv_size_after ID 'ERRNO' FIELD lv_errno
    ID 'ERRMSG' FIELD lv_error.
  IF sy-subrc <> 0 OR lv_size_after <> lv_size.
    fail_reply 'unsupported' 'LOG_CHANGED'. RETURN.
  ENDIF.
  SELECT SINGLE * FROM tbtco INTO ls_job_check
    WHERE jobname = iv_jobname AND jobcount = iv_jobcount
      AND authckman = sy-mandt.
  IF sy-subrc <> 0 OR ls_job_check <> ls_job.
    fail_reply 'unsupported' 'LOG_CHANGED'. RETURN.
  ENDIF.
  IF lv_body_check = 'X'. ev_result = 'OK'. RETURN. ENDIF.
  CONCATENATE '"job":' lv_header ',"messages":' lv_items
    '],"complete":true}' INTO lv_tail.
  fail_reply 'ok' 'OK'.
  RETURN.
ENDIF.
IF iv_jobname IS NOT INITIAL OR iv_jobcount IS NOT INITIAL
   OR iv_status IS NOT INITIAL OR iv_after_job IS NOT INITIAL.
  RETURN.
ENDIF.
AUTHORITY-CHECK OBJECT 'S_ADMI_FCD' ID 'S_ADMI_FCD' FIELD 'SM21'.
IF sy-subrc <> 0.
  fail_reply 'forbidden' 'NO_AUTHORITY'. RETURN.
ENDIF.
CALL FUNCTION 'RSLG_FILEINFO_INIT_ALV'
  EXPORTING whichlog = 'L' info_before = ls_file
  IMPORTING info_after = ls_file.
lv_bytes = 320 * cl_abap_char_utilities=>charsize.
IF ls_file-recordsize <> lv_bytes OR ls_file-actfilenam IS INITIAL
   OR ls_file-pos < 0 OR ls_file-pos > 2147483647.
  RETURN.
ENDIF.
lv_end = ls_file-pos.
IF lv_end MOD lv_bytes <> 0. RETURN. ENDIF.
lv_position = lv_end - 2000 * lv_bytes.
IF lv_position < 0. lv_position = 0. ENDIF.
lv_items = '['.
lv_more = 'true'.
DO 2000 TIMES.
  IF lv_position >= lv_end. EXIT. ENDIF.
  CLEAR ls_entry.
  CALL 'C_RSTRB_READ_BUFFERED' ID 'BUFF' FIELD ls_entry
    ID 'POSI' FIELD lv_position ID 'NAME' FIELD ls_file-actfilenam
    ID 'SIZE' FIELD lv_bytes.
  lv_rc = sy-subrc.
  CALL 'C_RSTRB_READ_BUFFERED' ID 'BUFF' FIELD ls_entry
    ID 'CLOS' FIELD 'X'.
  IF lv_rc <> 0. RETURN. ENDIF.
  ADD 1 TO lv_scanned.
  ADD lv_bytes TO lv_position.
  IF ls_entry-slgmand <> sy-mandt. CONTINUE. ENDIF.
  ls_type = ls_entry-slgtype.
* Keep bounded local input, never emit parameter records as messages.
  IF ls_type-slgftyp = 'p'.
    APPEND ls_entry TO lt_param_entries.
    CONTINUE.
  ENDIF.
  IF iv_user IS NOT INITIAL AND ls_entry-slguser <> iv_user.
    CONTINUE.
  ENDIF.
  IF iv_program IS NOT INITIAL AND ls_entry-slgrepna <> iv_program.
    CONTINUE.
  ENDIF.
  IF ls_entry-slgdattim CN '0123456789'. CONTINUE. ENDIF.
  lv_date = ls_entry-slgdattim(8).
  lv_clock = ls_entry-slgdattim+8(6).
  make_time lv_date lv_clock.
  IF lv_time < iv_from OR lv_time > iv_to. CONTINUE. ENDIF.
  IF lv_index >= lv_limit. CONTINUE. ENDIF.
  CONCATENATE ls_type-area ls_type-subid INTO lv_message_id.
  IF lv_message_id CN 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 '.
    CONTINUE.
  ENDIF.
  CLEAR: lv_template, lv_rendered, lv_offset, lv_data_offset,
         lv_dollars, lv_params_ready, lv_param_array.
  lv_missing = 'false'.
  SELECT SINGLE txt FROM tsl1t INTO lv_template
    WHERE spras = sy-langu AND area = ls_type-area
      AND subid = ls_type-subid.
  IF sy-subrc <> 0.
    SELECT SINGLE txt FROM tsl1t INTO lv_template
      WHERE spras = 'E' AND area = ls_type-area
        AND subid = ls_type-subid.
  ENDIF.
  IF lv_template IS INITIAL.
    lv_missing = 'true'.
  ENDIF.
  lv_body_stage = 'SYSTEM_TEMPLATE'.
  IF lv_template NA '&' AND lv_template CA '$'.
    lv_dollars = 'X'.
  ENDIF.
  SPLIT ls_entry-slgdata AT '&' INTO TABLE lt_words.
  lv_length = strlen( lv_template ).
* Lowercase references use reviewed native in-memory parameter decoding.
  WHILE lv_offset < lv_length.
    lv_token = lv_template+lv_offset(1).
    ADD 1 TO lv_offset.
    IF lv_token = '&' AND lv_dollars IS INITIAL.
      IF lv_offset >= lv_length.
        lv_missing = 'true'. EXIT.
      ENDIF.
      lv_token = lv_template+lv_offset(1).
      ADD 1 TO lv_offset.
      IF lv_token = '>'.
        lv_take = lv_offset + 1.
        IF lv_take >= lv_length.
          lv_missing = 'true'. EXIT.
        ENDIF.
        IF lv_template+lv_offset(1) NA 'EM'.
          lv_missing = 'true'. EXIT.
        ENDIF.
        ADD 1 TO lv_offset.
        lv_token = lv_template+lv_offset(1).
        ADD 1 TO lv_offset.
      ENDIF.
      CLEAR lv_word.
      IF 'ABCDEFGHIJKLMNOP' CA lv_token.
        lv_word_index = sy-fdpos + 1.
        READ TABLE lt_words INTO lv_word INDEX lv_word_index.
        IF sy-subrc <> 0.
          lv_missing = 'true'. EXIT.
        ENDIF.
      ELSEIF 'abcdefghij' CA lv_token.
        lv_param_offset = sy-fdpos * 62.
        lv_body_stage = 'SYSTEM_PARAMETER_EMPTY'.
        IF lv_params_ready IS INITIAL.
          CALL FUNCTION 'RSLG_INIT_PARAM_STORE_ALV'.
          lv_param_valid = 'X'.
          CLEAR lv_param_matches.
          lv_body_stage = 'SYSTEM_PARAMETER_IDENTITY'.
          TRY.
            LOOP AT lt_param_entries INTO ls_param_entry
              WHERE slgmand = ls_entry-slgmand
                AND slguser = ls_entry-slguser
                AND slgrepna = ls_entry-slgrepna
                AND slgproc = ls_entry-slgproc
                AND slgltrm = ls_entry-slgltrm
                AND slgmode = ls_entry-slgmode.
              ADD 1 TO lv_param_matches.
              lv_body_stage = 'SYSTEM_PARAMETER_TIME'.
* Native ALV normalizes nonnumeric modes; exact raw mode matched above.
              IF ls_param_entry-slgdattim CN '0123456789'.
                CLEAR lv_param_valid. EXIT.
              ENDIF.
              lv_param_date = ls_param_entry-slgdattim(8).
              lv_param_time = ls_param_entry-slgdattim+8(6).
              lv_param_age = lv_date - lv_param_date.
              lv_param_age = lv_param_age * 86400
                + lv_clock - lv_param_time.
              IF lv_param_age < 0 OR lv_param_age >= 300.
                CONTINUE.
              ENDIF.
              lv_param_data = ls_param_entry-slgdata.
              lv_body_stage = 'SYSTEM_PARAMETER_FORMAT'.
* Reject malformed records before the legacy decoder's offset access.
              FIND REGEX '^(&[a-j][^&]{1,62})+$' IN lv_param_data.
              IF sy-subrc <> 0.
                CLEAR lv_param_valid. EXIT.
              ENDIF.
              lv_body_stage = 'SYSTEM_PARAMETER_STORE'.
              CALL FUNCTION 'RSLG_STORE_PARAM_ALV'
                EXPORTING date_time = ls_param_entry-slgdattim
                  extern_mode = ls_param_entry-slgmode
                  terminal = ls_param_entry-slgltrm
                  slgdata = ls_param_entry-slgdata.
            ENDLOOP.
            IF lv_param_valid = 'X'.
              IF lv_param_matches > 0.
                lv_body_stage = 'SYSTEM_PARAMETER_CACHE'.
              ENDIF.
              CALL FUNCTION 'RSLG_FIND_PARAMS_ALV'
                EXPORTING date_time = ls_entry-slgdattim
                  extern_mode = ls_entry-slgmode
                  terminal = ls_entry-slgltrm
                IMPORTING param_array = lv_param_array
                EXCEPTIONS OTHERS = 1.
              IF sy-subrc <> 0. CLEAR lv_param_valid. ENDIF.
            ENDIF.
            CATCH cx_root.
              CLEAR lv_param_valid.
          ENDTRY.
* Do not retain standard function-group state across messages or RFCs.
          CALL FUNCTION 'RSLG_INIT_PARAM_STORE_ALV'.
          lv_params_ready = 'X'.
          IF lv_param_valid IS INITIAL OR lv_param_array IS INITIAL.
            CLEAR lv_param_array.
            lv_missing = 'true'. EXIT.
          ENDIF.
        ENDIF.
        lv_word = lv_param_array+lv_param_offset(62).
* A valid native parameter set can contain empty trailing slots.
      ELSEIF lv_token CO '123456789'.
        lv_take = lv_token.
        IF lv_data_offset + lv_take > 64.
          lv_missing = 'true'. EXIT.
        ENDIF.
        lv_word = ls_entry-slgdata+lv_data_offset(lv_take).
        ADD lv_take TO lv_data_offset.
      ELSE.
        lv_missing = 'true'. EXIT.
      ENDIF.
      CONCATENATE lv_rendered lv_word INTO lv_rendered
        RESPECTING BLANKS.
    ELSEIF lv_token = '$' AND lv_dollars = 'X'.
      IF lv_data_offset >= 64.
        lv_missing = 'true'. EXIT.
      ENDIF.
      CONCATENATE lv_rendered ls_entry-slgdata+lv_data_offset(1)
        INTO lv_rendered RESPECTING BLANKS.
      ADD 1 TO lv_data_offset.
    ELSE.
      CONCATENATE lv_rendered lv_token INTO lv_rendered
        RESPECTING BLANKS.
    ENDIF.
    IF strlen( lv_rendered ) > 4096.
      lv_missing = 'true'. EXIT.
    ENDIF.
  ENDWHILE.
  IF lv_missing = 'true'.
    IF lv_body_check = 'X'. ev_result = lv_body_stage. RETURN. ENDIF.
    CLEAR lv_rendered.
  ELSE.
    CONDENSE lv_rendered.
  ENDIF.
  lv_json = ''.
  lv_number = lv_position - lv_bytes. CONDENSE lv_number NO-GAPS.
  lv_value = ls_file-wrapcount.
  CONDENSE lv_value NO-GAPS.
  CONCATENATE lv_value ':' lv_number INTO lv_value.
  json_field '{"id":"' lv_value.
  json_field ',"client":"' sy-mandt.
  json_field ',"server":"' lv_server.
  json_field ',"systemTime":"' lv_time.
  json_field ',"username":"' ls_entry-slguser.
  json_field ',"program":"' ls_entry-slgrepna.
  json_field ',"transaction":"' ls_entry-slgtc.
  json_field ',"messageId":"' lv_message_id.
  json_field ',"type":"' ls_type-slgftyp.
  json_field ',"text":"' lv_rendered.
* Raw variables/passports are never returned as substitute message text.
  CONCATENATE lv_json ',"textUnavailable":' lv_missing ','
    '"textTruncated":false}' INTO lv_json.
  IF lv_index < lv_limit.
    IF lv_index > 0. CONCATENATE lv_items ',' INTO lv_items. ENDIF.
    CONCATENATE lv_items lv_json INTO lv_items.
    ADD 1 TO lv_index.
  ENDIF.
ENDDO.
CALL FUNCTION 'RSLG_FILEINFO_INIT_ALV'
  EXPORTING whichlog = 'L' info_before = ls_file_after
  IMPORTING info_after = ls_file_after.
IF ls_file_after-wrapcount <> ls_file-wrapcount
   OR ls_file_after-actfilenam <> ls_file-actfilenam
   OR ls_file_after-pos < ls_file-pos.
  fail_reply 'unsupported' 'LOG_CHANGED'. RETURN.
ENDIF.
IF lv_body_check = 'X'.
  IF lv_index = 0.
    ev_result = 'NO_MATCHING_ENTRIES'.
  ELSE.
    ev_result = 'OK'.
  ENDIF.
  RETURN.
ENDIF.
lv_json = ''.
json_field '"fromSystemTime":"' iv_from.
json_field ',"toSystemTime":"' iv_to.
json_field ',"server":"' lv_server.
lv_number = lv_scanned. CONDENSE lv_number NO-GAPS.
CONCATENATE lv_json ',"entries":' lv_items
  '],"coverage":"local_instance_bounded_tail","scannedRecords":'
  lv_number ',"truncated":true}' INTO lv_tail.
fail_reply 'ok' 'OK'.
CATCH cx_root.
  RETURN.
ENDTRY.
`
      .trim()
      .split("\n")
  )
  assertGeneratedLineWidth(lines)
  return lines
}

export const operationalLogSource = buildOperationalLogSource(false)
export const operationalLogSpoolSource = buildOperationalLogSource(true)
export const operationalLogReportSource = buildOperationalLogSource(true, true)
