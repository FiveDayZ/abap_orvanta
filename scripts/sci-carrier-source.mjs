// CAPABILITIES carrier for the two SCI helpers (docs/helper-capabilities-protocol.md revision R6).
// Importing this module never connects to or writes SAP.
//
// Z_ORVANTA_MCP_SCI_V2 and Z_ORVANTA_MCP_SCI_E2 answer through EV_* scalars plus the ET_RESULTS
// table, so they own neither an IT_SOURCE row table nor an EV_RESULT JSON string. The approved
// carrier is therefore a SINGLE new exporting scalar EV_RESULT of type STRINGVAL - the same R3
// envelope Z_ORVANTA_LOG_READ already answers with - and NOT a new export table. Adding that
// parameter is an interface change: the live w200 interface of both helpers (read with
// read_function_module_interface on 2026-09-18, interface fingerprints 32d861d6032761951eb684d54737011e46f0dab9f0f3fc36333fc7013e0d3e31 for _V2 and
// 1868256b8eea22458026ebe1775db3a8bebbae1e9aed0cd82a5556ee8e42d614 for _E2) has no EV_RESULT, so this generator is a DEPLOYMENT CANDIDATE and not a
// description of the installed state.
//
// The two frozen baselines below are the deployed bodies exactly as read from w200 on 2026-09-18.
// They are body-only: they start at the DATA declarations and end at ENDTRY., carry no ENDFUNCTION.
// and no trailing blank line, which is the form scripts/sci-v2-source.mjs and
// scripts/sci-e2-source.mjs already publish. Their pinned hashes are therefore the SHA-256 of the
// live body window with no trailing-blank caveat:
//   _V2  234 lines  dbf10817bf3a228281e11c9d39555423d38d75685ad16fdeec12fecccfd2c29e
//   _E2  284 lines  2f2b1380470a23d1b2add6e21bb87dd545dbb5c4d69e956ec7bb626ab4a89bda
//
// _E2 keeps its existing repository relationship: scripts/sci-e2-source.mjs derives it from _V2 by
// exact text substitution, and the derived body is byte-identical to the live object. This module
// nevertheless archives BOTH bodies literally, for two reasons. (1) The carrier makes each helper's
// own body the unit of attestation, because SOURCE|HASH digests that helper's exact text, so each
// helper needs its own immutable baseline instead of a baseline with a derivation step in front of
// it. (2) The bootstrap-era plan in section 3.3 of the protocol document tells implementers to add a
// CAPABILITIES branch to scripts/*-source.mjs directly; a baseline imported from there could be
// edited in place and would silently move the pinned value, while a literal archive cannot. The
// derivation is not abandoned: a test re-asserts that both literal archives still equal the bodies
// derived by scripts/sci-v2-source.mjs / scripts/sci-e2-source.mjs, so the relationship stays
// checked rather than assumed.
//
// The CAPABILITIES branch is spliced into each helper separately, because its HELPER identity row
// carries that helper's own function name; deriving _E2 from an already-branched _V2 would publish
// _V2's name.
import { createHash } from "node:crypto"

export const sciV2HelperName = "Z_ORVANTA_MCP_SCI_V2"
export const sciE2HelperName = "Z_ORVANTA_MCP_SCI_E2"

// The live interface of both helpers, read with read_function_module_interface on 2026-09-18. The
// two differ only in EV_NESTED, which _E2 adds for its third SCI rule. EV_RESULT is the R6 carrier
// and is the ONLY interface delta this generator assumes: it must be added as an EXPORTING scalar
// of type STRINGVAL before either carrier body is deployed. STRINGVAL is verified on this system -
// the deployed Z_ORVANTA_LOG_READ exports EV_RESULT of exactly that type.
export const sciHelperDefinitions = {
  [sciV2HelperName]: {
    functionName: sciV2HelperName,
    engineVersion: "2.0",
    functionGroup: "ZORVANTA_MCP_CORE",
    remoteEnabled: true,
    importParameters: [
      { name: "IV_ACTION", typeName: "CHAR50" },
      { name: "IV_OBJECT_TYPE", typeName: "TROBJTYPE" },
      { name: "IV_OBJECT_NAME", typeName: "SOBJ_NAME" }
    ],
    exportParameters: [
      { name: "EV_STATUS", typeName: "CHAR50" },
      { name: "EV_CODE", typeName: "CHAR50" },
      { name: "EV_ENGINE", typeName: "CHAR50" },
      { name: "EV_VERSION", typeName: "CHAR50" },
      { name: "EV_VARIANT", typeName: "CHAR50" },
      { name: "EV_COUNT", typeName: "INT4" },
      { name: "EV_OBJTYPE", typeName: "TROBJTYPE" },
      { name: "EV_OBJNAME", typeName: "SOBJ_NAME" },
      { name: "EV_PROGRAM", typeName: "PROGRAMM" },
      { name: "EV_PACKAGE", typeName: "DEVCLASS" },
      { name: "EV_SYNTAX", typeName: "CHAR50" },
      { name: "EV_CRITICAL", typeName: "CHAR50" },
      { name: "EV_RESULT", typeName: "STRINGVAL" }
    ],
    tableParameters: [{ name: "ET_RESULTS", typeName: "BAPIRET2" }]
  },
  [sciE2HelperName]: {
    functionName: sciE2HelperName,
    engineVersion: "3.0",
    functionGroup: "ZORVANTA_MCP_CORE",
    remoteEnabled: true,
    importParameters: [
      { name: "IV_ACTION", typeName: "CHAR50" },
      { name: "IV_OBJECT_TYPE", typeName: "TROBJTYPE" },
      { name: "IV_OBJECT_NAME", typeName: "SOBJ_NAME" }
    ],
    exportParameters: [
      { name: "EV_STATUS", typeName: "CHAR50" },
      { name: "EV_CODE", typeName: "CHAR50" },
      { name: "EV_ENGINE", typeName: "CHAR50" },
      { name: "EV_VERSION", typeName: "CHAR50" },
      { name: "EV_VARIANT", typeName: "CHAR50" },
      { name: "EV_COUNT", typeName: "INT4" },
      { name: "EV_OBJTYPE", typeName: "TROBJTYPE" },
      { name: "EV_OBJNAME", typeName: "SOBJ_NAME" },
      { name: "EV_PROGRAM", typeName: "PROGRAMM" },
      { name: "EV_PACKAGE", typeName: "DEVCLASS" },
      { name: "EV_SYNTAX", typeName: "CHAR50" },
      { name: "EV_CRITICAL", typeName: "CHAR50" },
      { name: "EV_NESTED", typeName: "CHAR50" },
      { name: "EV_RESULT", typeName: "STRINGVAL" }
    ],
    tableParameters: [{ name: "ET_RESULTS", typeName: "BAPIRET2" }]
  }
}

// CAPABILITIES self-description. R3 applies: the rows ride inside the EV_RESULT JSON envelope's own
// "payload" array, because the approved carrier is that single scalar and not a new export table.
//
// R4 fixes the meaning of `since` per helper contract and R6 rules that for these two helpers it is
// the JSON envelope's own revision ("version":"1" -> 1.0). It must NOT be taken from ev_version:
// that field is this helper's SCI rule-profile version (2.0 for _V2, 3.0 for _E2), i.e. exactly the
// helper-version versus protocol-version confusion that caused the original capability problem.
// Both operations therefore start at 1.0, which is also the revision that introduces this carrier.
// This table is the ONLY opcode list for the SCI carriers: PROTOCOL|MIN, PROTOCOL|MAX and every
// OPERATION row are derived from it and never written a second time. Both operations are read-only:
// PRECHECK stops after rule applicability, and RUN executes an anonymous SCI inspection that saves
// no variant, object set or result.
// >>> ORVANTA-CAPABILITY-TABLE
export const sciCapabilityOperations = [
  { opcode: "PRECHECK", since: "1.0", mode: "R" },
  { opcode: "RUN", since: "1.0", mode: "R" }
]
// <<< ORVANTA-CAPABILITY-TABLE
if (sciCapabilityOperations.length === 0) {
  throw new Error("sciCapabilityOperations must not be empty")
}

const compareProtocolVersions = (left, right) => {
  const [leftMajor = 0, leftMinor = 0] = String(left).split(".").map(Number)
  const [rightMajor = 0, rightMinor = 0] = String(right).split(".").map(Number)
  return leftMajor - rightMajor || leftMinor - rightMinor
}
const sciCapabilityVersions = sciCapabilityOperations
  .map((operation) => operation.since)
  .sort(compareProtocolVersions)
export const sciCapabilityMinProtocol = sciCapabilityVersions[0]
export const sciCapabilityMaxProtocol = sciCapabilityVersions.at(-1)

// Deployment provenance published as SOURCE|PACKAGE and SOURCE|TRANSPORT. Both helpers are FUGR/FF
// members of function group ZORVANTA_MCP_CORE in package ZABAP and are assigned to request
// GR2K923472 (read-only inspect_repository_assignment, 2026-09-18: requestNumber GR2K923472,
// taskNumber empty, transportStatus D, active, originalSystem GR2). The request must never be
// released, and the empty task field is the normal shape this system reports for these objects -
// the deployed repository helper publishes the same pair as "GR2K923472|".
export const sciCapabilityDeployment = {
  packageName: "ZABAP",
  transportRequest: "GR2K923472",
  transportTask: ""
}

export const sciCapabilityHashSlots = [
  "ORVANTAHASHSLOT1",
  "ORVANTAHASHSLOT2",
  "ORVANTAHASHSLOT3",
  "ORVANTAHASHSLOT4"
]

// Four 16-character placeholders make SOURCE|HASH self-referential: the generator hashes the
// finished body while the placeholders are still in it and then writes that SHA-256 into the same
// four slots in order (no length change), so regenerating the same body reproduces the same digest.
// Same slot names and algorithm as scripts/bootstrap-sap-helper.ps1 and
// helper-capabilities-evidence.mjs capabilityBodyDigest.
export const injectCapabilityHash = (lines) => {
  const digest = createHash("sha256").update(lines.join("\n"), "utf8").digest("hex")
  const filled = lines.map((line) =>
    sciCapabilityHashSlots.reduce(
      (text, slot, index) => text.split(slot).join(digest.slice(index * 16, index * 16 + 16)),
      line
    )
  )
  if (filled.join("\n").includes("ORVANTAHASHSLOT")) {
    throw new Error("a hash slot was left unfilled")
  }
  return filled
}

// The ABAP source format allows at most 72 characters per line; a longer line is re-chunked or
// rejected by the upload. scripts/bootstrap-sap-helper.ps1 throws on the same condition, and both
// frozen SCI baselines are already within the limit (their longest line is 71
// characters), so there is no legacy exception list here.
export const assertGeneratedLineWidth = (lines, limit = 72) => {
  for (const line of lines) {
    if (line.length > limit) {
      throw new Error(`Generated function source exceeds ${limit} characters: ${line}`)
    }
  }
}

// The exact first business statement of both archived bodies. The CAPABILITIES branch is spliced
// in AHEAD of it, so no business preset, RESET or input gate can run first: the archived bodies
// preset ev_status = 'E' / ev_code = 'INVALID_ACTION' and then reject every action other than
// PRECHECK and RUN, which would otherwise answer an unknown action before the self-description.
export const sciCapabilityInsertionAnchor =
  "  CLEAR: ev_status, ev_code, ev_count, ev_objtype, ev_objname,"

// The CAPABILITIES branch, answered through the single channel R6 approves - the EV_RESULT JSON
// envelope - as the very first statement of the body. It clears that field itself, so it may sit in
// front of the archive's own CLEAR block, which is what keeps it ahead of the INVALID_ACTION gate.
// The rows are derived from sciCapabilityOperations and sciCapabilityDeployment and are never
// written a second time; rows too long for one CONCATENATE are split over two lines.
// >>> ORVANTA-CAPABILITIES-SOURCE
export const buildSciCapabilityBranch = (functionName) => {
  const helper = sciHelperDefinitions[functionName]
  if (!helper) {
    throw new Error(`Unknown SCI helper: ${functionName}`)
  }
  const rows = [
    `HELPER|${helper.functionName}`,
    `PROTOCOL|MIN|${sciCapabilityMinProtocol}`,
    `PROTOCOL|MAX|${sciCapabilityMaxProtocol}`,
    ...sciCapabilityOperations.map(
      (operation) => `OPERATION|${operation.opcode}|${operation.since}|${operation.mode}`
    ),
    `SOURCE|PACKAGE|${sciCapabilityDeployment.packageName}`,
    `SOURCE|TRANSPORT|${sciCapabilityDeployment.transportRequest}|${sciCapabilityDeployment.transportTask}`
  ]
  const lines = [
    "  IF iv_action = 'CAPABILITIES'.",
    "    CLEAR ev_result.",
    '    CONCATENATE \'{"version":"1","status":"S","code":"CAPABILITIES",\'',
    '      \'"message":"ORVANTA helper capabilities","readOnly":true,\'',
    "      '\"payload\":[' INTO ev_result.",
    ...rows.flatMap((row) => {
      const single = `    CONCATENATE ev_result '"${row}",' INTO ev_result.`
      return single.length <= 72
        ? [single]
        : [`    CONCATENATE ev_result '"${row}",'`, "      INTO ev_result."]
    }),
    "    CONCATENATE ev_result '\"RUNTIME|HOST|' sy-sysid '/' sy-mandt '\",'",
    "      INTO ev_result.",
    "    CONCATENATE ev_result '\"SOURCE|HASH|' 'ORVANTAHASHSLOT1'",
    "      INTO ev_result.",
    "    CONCATENATE ev_result 'ORVANTAHASHSLOT2' 'ORVANTAHASHSLOT3'",
    "      'ORVANTAHASHSLOT4' '\"' INTO ev_result.",
    "    CONCATENATE ev_result ']}' INTO ev_result.",
    "    RETURN.",
    "  ENDIF."
  ]
  assertGeneratedLineWidth(lines)
  return lines
}
// <<< ORVANTA-CAPABILITIES-SOURCE

const spliceCapabilityBranch = (archive, functionName) => {
  const index = archive.indexOf(sciCapabilityInsertionAnchor)
  if (index < 0) {
    throw new Error(`${functionName}: the CAPABILITIES insertion anchor is missing`)
  }
  if (archive.indexOf(sciCapabilityInsertionAnchor, index + 1) >= 0) {
    throw new Error(`${functionName}: the CAPABILITIES insertion anchor is not unique`)
  }
  return injectCapabilityHash([
    ...archive.slice(0, index),
    ...buildSciCapabilityBranch(functionName),
    ...archive.slice(index)
  ])
}

// The deployed bodies, line for line, exactly as read from w200 on 2026-09-18. Never edit these
// arrays: they are the baselines the deployment proof compares against.
export const sciV2ArchivedBody = [
  "DATA lo_variant TYPE REF TO cl_ci_checkvariant.",
  "  DATA lo_objects TYPE REF TO cl_ci_objectset.",
  "  DATA lo_inspect TYPE REF TO cl_ci_inspection.",
  "  DATA lo_tests TYPE REF TO cl_ci_tests.",
  "  DATA lo_syntax TYPE REF TO cl_ci_test_syntax_check.",
  "  DATA lo_critical TYPE REF TO cl_ci_test_critical_statements.",
  "  DATA lo_test TYPE REF TO cl_ci_test_root.",
  "  DATA lt_variant TYPE sci_tstvar.",
  "  DATA lt_tests TYPE sci_tabtest.",
  "  DATA lt_objects TYPE scit_objs.",
  "  DATA ls_object TYPE scir_objs.",
  "  DATA ls_finding TYPE scir_rest.",
  "  DATA ls_rule TYPE sci_tstval.",
  "  DATA ls_message TYPE bapiret2.",
  "  DATA lv_text TYPE string.",
  "  DATA lv_count TYPE i.",
  "  DATA lv_package TYPE tadir-devclass.",
  "  DATA lv_subc TYPE trdir-subc.",
  "  CLEAR: ev_status, ev_code, ev_count, ev_objtype, ev_objname,",
  "    ev_program, ev_package, ev_syntax, ev_critical.",
  "  REFRESH et_results.",
  "  ev_engine = 'SCI'.",
  "  ev_version = '2.0'.",
  "  ev_variant = 'SYNTAX_CRITICAL_V1'.",
  "  ev_status = 'E'.",
  "  ev_code = 'INVALID_ACTION'.",
  "  IF iv_action <> 'PRECHECK' AND iv_action <> 'RUN'.",
  "    RETURN.",
  "  ENDIF.",
  "  ev_code = 'INVALID_TARGET'.",
  "  IF iv_object_type <> 'PROG' AND iv_object_type <> 'CLAS'",
  "     AND iv_object_type <> 'FUGR'.",
  "    RETURN.",
  "  ENDIF.",
  "  IF iv_object_name IS INITIAL OR",
  "     ( iv_object_name(1) <> 'Z' AND iv_object_name(1) <> 'Y' ).",
  "    RETURN.",
  "  ENDIF.",
  "  lv_text = iv_object_name.",
  "  IF lv_text CN 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.",
  "    RETURN.",
  "  ENDIF.",
  "  IF iv_object_type <> 'PROG' AND strlen( lv_text ) > 30.",
  "    RETURN.",
  "  ENDIF.",
  "  ev_code = 'OBJECT_NOT_FOUND'.",
  "  SELECT SINGLE devclass INTO lv_package FROM tadir",
  "    WHERE pgmid = 'R3TR' AND object = iv_object_type",
  "      AND obj_name = iv_object_name AND delflag = space.",
  "  IF sy-subrc <> 0 OR lv_package IS INITIAL.",
  "    RETURN.",
  "  ENDIF.",
  "  AUTHORITY-CHECK OBJECT 'S_DEVELOP'",
  "    ID 'DEVCLASS' FIELD lv_package",
  "    ID 'OBJTYPE' FIELD iv_object_type",
  "    ID 'OBJNAME' FIELD iv_object_name",
  "    ID 'P_GROUP' DUMMY",
  "    ID 'ACTVT' FIELD '03'.",
  "  IF sy-subrc <> 0.",
  "    ev_code = 'NOT_AUTHORIZED'.",
  "    RETURN.",
  "  ENDIF.",
  "  IF iv_object_type = 'PROG'.",
  "    ev_code = 'NOT_MAIN_PROGRAM'.",
  "    SELECT SINGLE subc INTO lv_subc FROM trdir",
  "      WHERE name = iv_object_name.",
  "    IF sy-subrc <> 0 OR",
  "       ( lv_subc <> '1' AND lv_subc <> 'M' AND lv_subc <> 'S' ).",
  "      RETURN.",
  "    ENDIF.",
  "  ENDIF.",
  "  TRY.",
  "      ls_object-objtype = iv_object_type.",
  "      ls_object-objname = iv_object_name.",
  "      APPEND ls_object TO lt_objects.",
  "      ev_code = 'OBJECTSET_FAILED'.",
  "      CALL METHOD cl_ci_objectset=>save_from_list",
  "        EXPORTING p_user = sy-uname p_objects = lt_objects",
  "          p_name = space",
  "        RECEIVING p_ref = lo_objects",
  "        EXCEPTIONS OTHERS = 1.",
  "      IF sy-subrc <> 0 OR lo_objects IS INITIAL.",
  "        RETURN.",
  "      ENDIF.",
  "      ev_code = 'OBJECTSET_NOT_EXACT'.",
  "      DESCRIBE TABLE lo_objects->iobjlst-objects LINES lv_count.",
  "      IF lv_count <> 1.",
  "        RETURN.",
  "      ENDIF.",
  "      READ TABLE lo_objects->iobjlst-objects INDEX 1 INTO ls_object.",
  "      IF sy-subrc <> 0 OR ls_object-objtype <> iv_object_type",
  "         OR ls_object-objname <> iv_object_name",
  "         OR ls_object-devclass <> lv_package",
  "         OR ls_object-prgname IS INITIAL.",
  "        RETURN.",
  "      ENDIF.",
  "      IF iv_object_type = 'PROG' AND",
  "         ls_object-prgname <> iv_object_name.",
  "        RETURN.",
  "      ENDIF.",
  "      ev_objtype = ls_object-objtype.",
  "      ev_objname = ls_object-objname.",
  "      ev_program = ls_object-prgname.",
  "      ev_package = ls_object-devclass.",
  "      ev_code = 'RULE_VERSION_MISMATCH'.",
  "      CREATE OBJECT lo_syntax.",
  "      CREATE OBJECT lo_critical.",
  "      ev_syntax = lo_syntax->version.",
  "      ev_critical = lo_critical->version.",
  "      IF ev_syntax <> '001' OR ev_critical <> '002'.",
  "        RETURN.",
  "      ENDIF.",
  "      ls_rule-testname = 'CL_CI_TEST_SYNTAX_CHECK'.",
  "      ls_rule-version = lo_syntax->version.",
  "      INSERT ls_rule INTO TABLE lt_variant.",
  "      ls_rule-testname = 'CL_CI_TEST_CRITICAL_STATEMENTS'.",
  "      ls_rule-version = lo_critical->version.",
  "      INSERT ls_rule INTO TABLE lt_variant.",
  "      ev_code = 'RULE_LOAD_FAILED'.",
  "      CALL METHOD cl_ci_tests=>get_list",
  "        EXPORTING p_variant = lt_variant",
  "        RECEIVING p_result = lo_tests",
  "        EXCEPTIONS OTHERS = 1.",
  "      IF sy-subrc <> 0 OR lo_tests IS INITIAL.",
  "        RETURN.",
  "      ENDIF.",
  "      lt_tests = lo_tests->give_list( ).",
  "      DESCRIBE TABLE lt_tests LINES lv_count.",
  "      IF lv_count <> 2.",
  "        RETURN.",
  "      ENDIF.",
  "      LOOP AT lt_tests INTO lo_test.",
  "        IF '1PRG' NOT IN lo_test->typelist AND",
  "           iv_object_type NOT IN lo_test->typelist.",
  "          ev_code = 'RULE_NOT_APPLICABLE'.",
  "          RETURN.",
  "        ENDIF.",
  "      ENDLOOP.",
  "      IF iv_action = 'PRECHECK'.",
  "        ev_status = 'S'.",
  "        ev_code = 'PREFLIGHT_ONLY'.",
  "        RETURN.",
  "      ENDIF.",
  "      ev_code = 'VARIANT_CREATE_FAILED'.",
  "      CALL METHOD cl_ci_checkvariant=>create",
  "        EXPORTING p_user = sy-uname p_name = space",
  "        RECEIVING p_ref = lo_variant",
  "        EXCEPTIONS OTHERS = 1.",
  "      IF sy-subrc <> 0 OR lo_variant IS INITIAL.",
  "        RETURN.",
  "      ENDIF.",
  "      CALL METHOD lo_variant->set_variant",
  "        EXPORTING p_variant = lt_variant",
  "        EXCEPTIONS OTHERS = 1.",
  "      IF sy-subrc <> 0.",
  "        RETURN.",
  "      ENDIF.",
  "      ev_code = 'INSPECTION_CREATE_FAILED'.",
  "      CALL METHOD cl_ci_inspection=>create",
  "        EXPORTING p_user = sy-uname p_name = space",
  "        RECEIVING p_ref = lo_inspect",
  "        EXCEPTIONS OTHERS = 1.",
  "      IF sy-subrc <> 0 OR lo_inspect IS INITIAL.",
  "        RETURN.",
  "      ENDIF.",
  "      ev_code = 'INSPECTION_SET_FAILED'.",
  "      CALL METHOD lo_inspect->set",
  "        EXPORTING p_chkv = lo_variant p_objs = lo_objects",
  "          p_noaunit = 'X' p_nosuppress = 'X'",
  "        EXCEPTIONS OTHERS = 1.",
  "      IF sy-subrc <> 0.",
  "        RETURN.",
  "      ENDIF.",
  "      ev_code = 'SCI_RUN_FAILED'.",
  "      CALL METHOD lo_inspect->run",
  "        EXPORTING p_howtorun = 'D'",
  "        EXCEPTIONS OTHERS = 1.",
  "      IF sy-subrc <> 0.",
  "        RETURN.",
  "      ENDIF.",
  "      DESCRIBE TABLE lo_inspect->sciresthd LINES lv_count.",
  "      IF lv_count <> 1.",
  "        ev_code = 'RESULT_COVERAGE_UNKNOWN'.",
  "        RETURN.",
  "      ENDIF.",
  "      DESCRIBE TABLE lo_inspect->scirestps LINES ev_count.",
  "      LOOP AT lo_inspect->scirestps INTO ls_finding FROM 1 TO 1000.",
  "        IF ls_finding-objtype <> iv_object_type OR",
  "           ls_finding-objname <> iv_object_name.",
  "          ev_code = 'RESULT_OBJECT_MISMATCH'.",
  "          CLEAR ev_count.",
  "          REFRESH et_results.",
  "          RETURN.",
  "        ENDIF.",
  "        CLEAR: ls_message, lv_text.",
  "        ls_message-type = ls_finding-kind.",
  "        ls_message-message_v1 = ls_finding-test.",
  "        ls_message-message_v2 = ls_finding-code.",
  "        ls_message-message_v3 = ls_finding-sobjname.",
  "        ls_message-message_v4 = ls_finding-col.",
  "        CONDENSE ls_message-message_v4.",
  "        ls_message-row = ls_finding-line.",
  "        IF ls_finding-test = 'CL_CI_TEST_SYNTAX_CHECK'.",
  "          lv_text = ls_finding-param1.",
  "        ELSEIF ls_finding-test = 'CL_CI_TEST_CRITICAL_STATEMENTS'.",
  "          CALL METHOD lo_critical->get_message_text",
  "            EXPORTING p_test = ls_finding-test p_code = ls_finding-code",
  "            IMPORTING p_text = lv_text.",
  "          REPLACE ALL OCCURRENCES OF '&1' IN lv_text",
  "            WITH ls_finding-param1.",
  "        ELSE.",
  "          ev_code = 'RESULT_RULE_MISMATCH'.",
  "          CLEAR ev_count.",
  "          REFRESH et_results.",
  "          RETURN.",
  "        ENDIF.",
  "        ls_message-message = lv_text.",
  "        IF strlen( lv_text ) > 220.",
  "          ls_message-field = 'TEXT_TRUNCATED'.",
  "        ENDIF.",
  "        APPEND ls_message TO et_results.",
  "      ENDLOOP.",
  "      ev_status = 'W'.",
  "      ev_code = 'FINDINGS_LIMITED'.",
  "      IF ev_count = 0.",
  "        ev_code = 'NO_FINDINGS_UNVERIFIED'.",
  "      ELSEIF ev_count > 1000.",
  "        ev_code = 'TRUNCATED_LIMITED'.",
  "      ENDIF.",
  "    CATCH cx_root.",
  "      ev_status = 'E'.",
  "      CLEAR ev_count.",
  "      REFRESH et_results.",
  "  ENDTRY."
]

export const sciE2ArchivedBody = [
  "DATA lo_variant TYPE REF TO cl_ci_checkvariant.",
  "  DATA lo_objects TYPE REF TO cl_ci_objectset.",
  "  DATA lo_inspect TYPE REF TO cl_ci_inspection.",
  "  DATA lo_tests TYPE REF TO cl_ci_tests.",
  "  DATA lo_syntax TYPE REF TO cl_ci_test_syntax_check.",
  "  DATA lo_critical TYPE REF TO cl_ci_test_critical_statements.",
  "  DATA lo_nested TYPE REF TO cl_ci_test_select_nested.",
  "  DATA lo_test TYPE REF TO cl_ci_test_root.",
  "  DATA lt_variant TYPE sci_tstvar.",
  "  DATA lt_tests TYPE sci_tabtest.",
  "  DATA lt_objects TYPE scit_objs.",
  "  DATA ls_object TYPE scir_objs.",
  "  DATA ls_finding TYPE scir_rest.",
  "  DATA ls_rule TYPE sci_tstval.",
  "  DATA ls_message TYPE bapiret2.",
  "  DATA lv_text TYPE string.",
  "  DATA lv_count TYPE i.",
  "  DATA lv_package TYPE tadir-devclass.",
  "  DATA lv_subc TYPE trdir-subc.",
  "  CLEAR: ev_status, ev_code, ev_count, ev_objtype, ev_objname,",
  "    ev_program, ev_package, ev_syntax, ev_critical, ev_nested.",
  "  REFRESH et_results.",
  "  ev_engine = 'SCI'.",
  "  ev_version = '3.0'.",
  "  ev_variant = 'SYNTAX_CRITICAL_SQL_V1'.",
  "  ev_status = 'E'.",
  "  ev_code = 'INVALID_ACTION'.",
  "  IF iv_action <> 'PRECHECK' AND iv_action <> 'RUN'.",
  "    RETURN.",
  "  ENDIF.",
  "  ev_code = 'INVALID_TARGET'.",
  "  IF iv_object_type <> 'PROG' AND iv_object_type <> 'CLAS'",
  "     AND iv_object_type <> 'FUGR'.",
  "    RETURN.",
  "  ENDIF.",
  "  IF iv_object_name IS INITIAL OR",
  "     ( iv_object_name(1) <> 'Z' AND iv_object_name(1) <> 'Y' ).",
  "    RETURN.",
  "  ENDIF.",
  "  lv_text = iv_object_name.",
  "  IF lv_text CN 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.",
  "    RETURN.",
  "  ENDIF.",
  "  IF iv_object_type <> 'PROG' AND strlen( lv_text ) > 30.",
  "    RETURN.",
  "  ENDIF.",
  "  ev_code = 'OBJECT_NOT_FOUND'.",
  "  SELECT SINGLE devclass INTO lv_package FROM tadir",
  "    WHERE pgmid = 'R3TR' AND object = iv_object_type",
  "      AND obj_name = iv_object_name AND delflag = space.",
  "  IF sy-subrc <> 0 OR lv_package IS INITIAL.",
  "    RETURN.",
  "  ENDIF.",
  "  AUTHORITY-CHECK OBJECT 'S_DEVELOP'",
  "    ID 'DEVCLASS' FIELD lv_package",
  "    ID 'OBJTYPE' FIELD iv_object_type",
  "    ID 'OBJNAME' FIELD iv_object_name",
  "    ID 'P_GROUP' DUMMY",
  "    ID 'ACTVT' FIELD '03'.",
  "  IF sy-subrc <> 0.",
  "    ev_code = 'NOT_AUTHORIZED'.",
  "    RETURN.",
  "  ENDIF.",
  "  IF iv_object_type = 'PROG'.",
  "    ev_code = 'NOT_MAIN_PROGRAM'.",
  "    SELECT SINGLE subc INTO lv_subc FROM trdir",
  "      WHERE name = iv_object_name.",
  "    IF sy-subrc <> 0 OR",
  "       ( lv_subc <> '1' AND lv_subc <> 'M' AND lv_subc <> 'S' ).",
  "      RETURN.",
  "    ENDIF.",
  "  ENDIF.",
  "  TRY.",
  "      ls_object-objtype = iv_object_type.",
  "      ls_object-objname = iv_object_name.",
  "      APPEND ls_object TO lt_objects.",
  "      ev_code = 'OBJECTSET_FAILED'.",
  "      CALL METHOD cl_ci_objectset=>save_from_list",
  "        EXPORTING p_user = sy-uname p_objects = lt_objects",
  "          p_name = space",
  "        RECEIVING p_ref = lo_objects",
  "        EXCEPTIONS OTHERS = 1.",
  "      IF sy-subrc <> 0 OR lo_objects IS INITIAL.",
  "        RETURN.",
  "      ENDIF.",
  "      ev_code = 'OBJECTSET_NOT_EXACT'.",
  "      DESCRIBE TABLE lo_objects->iobjlst-objects LINES lv_count.",
  "      IF lv_count <> 1.",
  "        RETURN.",
  "      ENDIF.",
  "      READ TABLE lo_objects->iobjlst-objects INDEX 1 INTO ls_object.",
  "      IF sy-subrc <> 0 OR ls_object-objtype <> iv_object_type",
  "         OR ls_object-objname <> iv_object_name",
  "         OR ls_object-devclass <> lv_package",
  "         OR ls_object-prgname IS INITIAL.",
  "        RETURN.",
  "      ENDIF.",
  "      IF iv_object_type = 'PROG' AND",
  "         ls_object-prgname <> iv_object_name.",
  "        RETURN.",
  "      ENDIF.",
  "      ev_objtype = ls_object-objtype.",
  "      ev_objname = ls_object-objname.",
  "      ev_program = ls_object-prgname.",
  "      ev_package = ls_object-devclass.",
  "      ev_code = 'RULE_VERSION_MISMATCH'.",
  "      CREATE OBJECT lo_syntax.",
  "      CREATE OBJECT lo_critical.",
  "      CREATE OBJECT lo_nested.",
  "      ev_syntax = lo_syntax->version.",
  "      ev_critical = lo_critical->version.",
  "      ev_nested = lo_nested->version.",
  "      IF ev_syntax <> '001' OR ev_critical <> '002'",
  "         OR ev_nested <> '000'.",
  "        RETURN.",
  "      ENDIF.",
  "      ls_rule-testname = 'CL_CI_TEST_SYNTAX_CHECK'.",
  "      ls_rule-version = lo_syntax->version.",
  "      INSERT ls_rule INTO TABLE lt_variant.",
  "      ls_rule-testname = 'CL_CI_TEST_CRITICAL_STATEMENTS'.",
  "      ls_rule-version = lo_critical->version.",
  "      INSERT ls_rule INTO TABLE lt_variant.",
  "      ls_rule-testname = 'CL_CI_TEST_SELECT_NESTED'.",
  "      ls_rule-version = lo_nested->version.",
  "      INSERT ls_rule INTO TABLE lt_variant.",
  "      ev_code = 'RULE_LOAD_FAILED'.",
  "      CALL METHOD cl_ci_tests=>get_list",
  "        EXPORTING p_variant = lt_variant",
  "        RECEIVING p_result = lo_tests",
  "        EXCEPTIONS OTHERS = 1.",
  "      IF sy-subrc <> 0 OR lo_tests IS INITIAL.",
  "        RETURN.",
  "      ENDIF.",
  "      lt_tests = lo_tests->give_list( ).",
  "      DESCRIBE TABLE lt_tests LINES lv_count.",
  "      IF lv_count <> 3.",
  "        RETURN.",
  "      ENDIF.",
  "      LOOP AT lt_tests INTO lo_test.",
  "        IF '1PRG' NOT IN lo_test->typelist AND",
  "           iv_object_type NOT IN lo_test->typelist.",
  "          ev_code = 'RULE_NOT_APPLICABLE'.",
  "          RETURN.",
  "        ENDIF.",
  "      ENDLOOP.",
  "      IF iv_action = 'PRECHECK'.",
  "        ev_status = 'S'.",
  "        ev_code = 'PREFLIGHT_ONLY'.",
  "        RETURN.",
  "      ENDIF.",
  "      ev_code = 'VARIANT_CREATE_FAILED'.",
  "      CALL METHOD cl_ci_checkvariant=>create",
  "        EXPORTING p_user = sy-uname p_name = space",
  "        RECEIVING p_ref = lo_variant",
  "        EXCEPTIONS OTHERS = 1.",
  "      IF sy-subrc <> 0 OR lo_variant IS INITIAL.",
  "        RETURN.",
  "      ENDIF.",
  "      CALL METHOD lo_variant->set_variant",
  "        EXPORTING p_variant = lt_variant",
  "        EXCEPTIONS OTHERS = 1.",
  "      IF sy-subrc <> 0.",
  "        RETURN.",
  "      ENDIF.",
  "      ev_code = 'INSPECTION_CREATE_FAILED'.",
  "      CALL METHOD cl_ci_inspection=>create",
  "        EXPORTING p_user = sy-uname p_name = space",
  "        RECEIVING p_ref = lo_inspect",
  "        EXCEPTIONS OTHERS = 1.",
  "      IF sy-subrc <> 0 OR lo_inspect IS INITIAL.",
  "        RETURN.",
  "      ENDIF.",
  "      ev_code = 'INSPECTION_SET_FAILED'.",
  "      CALL METHOD lo_inspect->set",
  "        EXPORTING p_chkv = lo_variant p_objs = lo_objects",
  "          p_noaunit = 'X' p_nosuppress = 'X'",
  "        EXCEPTIONS OTHERS = 1.",
  "      IF sy-subrc <> 0.",
  "        RETURN.",
  "      ENDIF.",
  "      ev_code = 'SCI_RUN_FAILED'.",
  "      CALL METHOD lo_inspect->run",
  "        EXPORTING p_howtorun = 'D'",
  "        EXCEPTIONS OTHERS = 1.",
  "      IF sy-subrc <> 0.",
  "        RETURN.",
  "      ENDIF.",
  "      DESCRIBE TABLE lo_inspect->sciresthd LINES lv_count.",
  "      IF lv_count <> 1.",
  "        ev_code = 'RESULT_COVERAGE_UNKNOWN'.",
  "        RETURN.",
  "      ENDIF.",
  '      " Inspect all results before applying the return-row cap.',
  "      LOOP AT lo_inspect->scirestps INTO ls_finding.",
  "        IF ls_finding-test = 'CL_CI_TEST_SCAN'.",
  "          ev_code = 'SCAN_FAILED'.",
  "          IF ls_finding-code = '0011'.",
  "            ev_code = 'SCAN_INCLUDE_MISSING'.",
  "          ENDIF.",
  "          RETURN.",
  "        ENDIF.",
  "        IF ls_finding-objtype <> iv_object_type OR",
  "           ls_finding-objname <> iv_object_name.",
  "          ev_code = 'RESULT_OBJECT_MISMATCH'.",
  "          RETURN.",
  "        ENDIF.",
  "        IF ls_finding-test <> 'CL_CI_TEST_SYNTAX_CHECK' AND",
  "           ls_finding-test <> 'CL_CI_TEST_CRITICAL_STATEMENTS' AND",
  "           ls_finding-test <> 'CL_CI_TEST_SELECT_NESTED'.",
  "          ev_code = 'RESULT_RULE_MISMATCH'.",
  "          RETURN.",
  "        ENDIF.",
  "        IF ls_finding-test = 'CL_CI_TEST_SELECT_NESTED'.",
  "          IF ( ls_finding-code = '0002' AND ls_finding-kind = 'W' )",
  "             OR ( ( ls_finding-code = '0001' OR",
  "                    ls_finding-code = '0003' )",
  "                  AND ls_finding-kind = 'N' ).",
  "            CONTINUE.",
  "          ENDIF.",
  "          ev_code = 'RESULT_RULE_MISMATCH'.",
  "          RETURN.",
  "        ENDIF.",
  "      ENDLOOP.",
  "      DESCRIBE TABLE lo_inspect->scirestps LINES ev_count.",
  "      LOOP AT lo_inspect->scirestps INTO ls_finding FROM 1 TO 1000.",
  "        IF ls_finding-objtype <> iv_object_type OR",
  "           ls_finding-objname <> iv_object_name.",
  "          ev_code = 'RESULT_OBJECT_MISMATCH'.",
  "          CLEAR ev_count.",
  "          REFRESH et_results.",
  "          RETURN.",
  "        ENDIF.",
  "        CLEAR: ls_message, lv_text.",
  "        ls_message-type = ls_finding-kind.",
  "        ls_message-message_v1 = ls_finding-test.",
  "        ls_message-message_v2 = ls_finding-code.",
  "        ls_message-message_v3 = ls_finding-sobjname.",
  "        ls_message-message_v4 = ls_finding-col.",
  "        CONDENSE ls_message-message_v4.",
  "        ls_message-row = ls_finding-line.",
  "        IF ls_finding-test = 'CL_CI_TEST_SYNTAX_CHECK'.",
  "          lv_text = ls_finding-param1.",
  "        ELSEIF ls_finding-test = 'CL_CI_TEST_CRITICAL_STATEMENTS'.",
  "          CALL METHOD lo_critical->get_message_text",
  "            EXPORTING p_test = ls_finding-test p_code = ls_finding-code",
  "            IMPORTING p_text = lv_text.",
  "          REPLACE ALL OCCURRENCES OF '&1' IN lv_text",
  "            WITH ls_finding-param1.",
  "        ELSEIF ls_finding-test = 'CL_CI_TEST_SELECT_NESTED'.",
  "          CALL METHOD lo_nested->get_message_text",
  "            EXPORTING p_test = ls_finding-test p_code = ls_finding-code",
  "            IMPORTING p_text = lv_text.",
  "          REPLACE ALL OCCURRENCES OF '&1' IN lv_text",
  "            WITH ls_finding-param1.",
  "          IF lv_text IS INITIAL.",
  "            ev_code = 'RESULT_MESSAGE_MISSING'.",
  "            CLEAR ev_count.",
  "            REFRESH et_results.",
  "            RETURN.",
  "          ENDIF.",
  "        ELSE.",
  "          ev_code = 'RESULT_RULE_MISMATCH'.",
  "          CLEAR ev_count.",
  "          REFRESH et_results.",
  "          RETURN.",
  "        ENDIF.",
  "        ls_message-message = lv_text.",
  "        IF strlen( lv_text ) > 220.",
  "          ls_message-field = 'TEXT_TRUNCATED'.",
  "        ENDIF.",
  "        APPEND ls_message TO et_results.",
  "      ENDLOOP.",
  "      ev_status = 'W'.",
  "      ev_code = 'FINDINGS_LIMITED'.",
  "      IF ev_count = 0.",
  "        ev_code = 'NO_FINDINGS_UNVERIFIED'.",
  "      ELSEIF ev_count > 1000.",
  "        ev_code = 'TRUNCATED_LIMITED'.",
  "      ENDIF.",
  "    CATCH cx_root.",
  "      ev_status = 'E'.",
  "      CLEAR ev_count.",
  "      REFRESH et_results.",
  "  ENDTRY."
]

export const sciV2CarrierSource = spliceCapabilityBranch(sciV2ArchivedBody, sciV2HelperName)
export const sciE2CarrierSource = spliceCapabilityBranch(sciE2ArchivedBody, sciE2HelperName)

assertGeneratedLineWidth(sciV2CarrierSource)
assertGeneratedLineWidth(sciE2CarrierSource)
