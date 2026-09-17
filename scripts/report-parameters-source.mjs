// Authored body. Reuses IV_PROGRAM/IV_LIMIT and EV_RESULT; importing does not deploy.
export const reportParameterDeclarations = String.raw`
DATA: lt_report_sscr TYPE STANDARD TABLE OF rsscr,
      ls_report_sscr TYPE rsscr,
      lv_report_name TYPE trdir-name,
      lv_report_type TYPE trdir-subc,
      lv_report_package TYPE tadir-devclass.
CONSTANTS: lc_report_obligatory TYPE x VALUE '40',
           lc_report_no_display TYPE x VALUE '20'.
`.trim()

export const reportParameterBranch = String.raw`
IF iv_action = 'REPORT_PARAMETERS'.
  lv_json = '{"version":"1"'.
  json_field ',"action":"' iv_action.
  json_field ',"client":"' sy-mandt.
  json_field ',"authenticatedUser":"' sy-uname.
  CONCATENATE lv_json ',"readOnly":true,' INTO lv_base.
  lv_tail = '"report":null,"parameters":[],"complete":true}'.
  fail_reply 'unsupported' 'READ_ONLY_UNSUPPORTED'.
  IF iv_program IS INITIAL OR strlen( iv_program ) > 40
     OR iv_limit <> '200' OR iv_from IS NOT INITIAL
     OR iv_to IS NOT INITIAL OR iv_jobname IS NOT INITIAL
     OR iv_jobcount IS NOT INITIAL OR iv_user IS NOT INITIAL
     OR iv_status IS NOT INITIAL OR iv_after_job IS NOT INITIAL
     OR iv_step IS NOT INITIAL OR iv_spoolid IS NOT INITIAL
     OR iv_page IS NOT INITIAL.
    RETURN.
  ENDIF.
  FIND REGEX
    '^([A-Z][A-Z0-9_]*|/[A-Z0-9_]+/[A-Z][A-Z0-9_]*)$'
    IN iv_program.
  IF sy-subrc <> 0. RETURN. ENDIF.
  lv_report_name = iv_program.
  TRY.
    SELECT SINGLE devclass FROM tadir INTO lv_report_package
      WHERE pgmid = 'R3TR' AND object = 'PROG'
        AND obj_name = lv_report_name.
    IF sy-subrc <> 0.
      fail_reply 'not_found' 'NOT_FOUND'. RETURN.
    ENDIF.
    AUTHORITY-CHECK OBJECT 'S_DEVELOP'
      ID 'DEVCLASS' FIELD lv_report_package
      ID 'OBJTYPE' FIELD 'PROG'
      ID 'OBJNAME' FIELD lv_report_name
      ID 'P_GROUP' DUMMY ID 'ACTVT' FIELD '03'.
    IF sy-subrc <> 0.
      fail_reply 'forbidden' 'NO_AUTHORITY'. RETURN.
    ENDIF.
    SELECT SINGLE subc FROM trdir INTO lv_report_type
      WHERE name = lv_report_name.
    IF sy-subrc <> 0.
      fail_reply 'not_found' 'NOT_FOUND'. RETURN.
    ENDIF.
    IF lv_report_type <> '1'. RETURN. ENDIF.
* Read an existing load only. Never generate a missing report load.
    LOAD REPORT lv_report_name PART 'SSCR' INTO lt_report_sscr.
    IF sy-subrc <> 0. RETURN. ENDIF.
    DESCRIBE TABLE lt_report_sscr LINES lv_rows.
    IF lv_rows > 2000.
      fail_reply 'unsupported' 'LIMIT_EXCEEDED'. RETURN.
    ENDIF.
    SORT lt_report_sscr BY numb kind name.
    CLEAR: lv_items, lv_index.
    LOOP AT lt_report_sscr INTO ls_report_sscr
      WHERE kind = 'P' OR kind = 'S'.
      ADD 1 TO lv_index.
      IF lv_index > 200.
        fail_reply 'unsupported' 'LIMIT_EXCEEDED'. RETURN.
      ENDIF.
      lv_json = ''.
      json_field '{"name":"' ls_report_sscr-name.
      lv_number = ls_report_sscr-numb.
      CONDENSE lv_number NO-GAPS.
      json_field ',"number":"' lv_number.
      json_field ',"kind":"' ls_report_sscr-kind.
      json_field ',"typeCode":"' ls_report_sscr-type.
      json_field ',"dictionaryType":"' ls_report_sscr-dtyp.
      json_field ',"referenceField":"' ls_report_sscr-dbfield.
      lv_more = 'false'.
      IF ls_report_sscr-flag1 O lc_report_obligatory.
        lv_more = 'true'.
      ENDIF.
      CONCATENATE lv_json ',"obligatory":' lv_more INTO lv_json.
      lv_more = 'false'.
      IF ls_report_sscr-flag1 O lc_report_no_display.
        lv_more = 'true'.
      ENDIF.
      CONCATENATE lv_json ',"noDisplay":' lv_more '}' INTO lv_json.
      IF lv_index > 1.
        CONCATENATE lv_items ',' INTO lv_items.
      ENDIF.
      CONCATENATE lv_items lv_json INTO lv_items.
    ENDLOOP.
    lv_json = ''.
    json_field '"report":"' lv_report_name.
    CONCATENATE lv_json ',"parameters":[' lv_items
      '],"complete":true}' INTO lv_tail.
    fail_reply 'ok' 'OK'.
  CATCH cx_root.
    lv_tail = '"report":null,"parameters":[],"complete":true}'.
    fail_reply 'unsupported' 'READ_ONLY_UNSUPPORTED'.
  ENDTRY.
  RETURN.
ENDIF.
`.trim()
