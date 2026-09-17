// Deployment body for the separately approved SCI-E1 customer helper.
export const sciV2Source = `
  DATA lo_variant TYPE REF TO cl_ci_checkvariant.
  DATA lo_objects TYPE REF TO cl_ci_objectset.
  DATA lo_inspect TYPE REF TO cl_ci_inspection.
  DATA lo_tests TYPE REF TO cl_ci_tests.
  DATA lo_syntax TYPE REF TO cl_ci_test_syntax_check.
  DATA lo_critical TYPE REF TO cl_ci_test_critical_statements.
  DATA lo_test TYPE REF TO cl_ci_test_root.
  DATA lt_variant TYPE sci_tstvar.
  DATA lt_tests TYPE sci_tabtest.
  DATA lt_objects TYPE scit_objs.
  DATA ls_object TYPE scir_objs.
  DATA ls_finding TYPE scir_rest.
  DATA ls_rule TYPE sci_tstval.
  DATA ls_message TYPE bapiret2.
  DATA lv_text TYPE string.
  DATA lv_count TYPE i.
  DATA lv_package TYPE tadir-devclass.
  DATA lv_subc TYPE trdir-subc.
  CLEAR: ev_status, ev_code, ev_count, ev_objtype, ev_objname,
    ev_program, ev_package, ev_syntax, ev_critical.
  REFRESH et_results.
  ev_engine = 'SCI'.
  ev_version = '2.0'.
  ev_variant = 'SYNTAX_CRITICAL_V1'.
  ev_status = 'E'.
  ev_code = 'INVALID_ACTION'.
  IF iv_action <> 'PRECHECK' AND iv_action <> 'RUN'.
    RETURN.
  ENDIF.
  ev_code = 'INVALID_TARGET'.
  IF iv_object_type <> 'PROG' AND iv_object_type <> 'CLAS'
     AND iv_object_type <> 'FUGR'.
    RETURN.
  ENDIF.
  IF iv_object_name IS INITIAL OR
     ( iv_object_name(1) <> 'Z' AND iv_object_name(1) <> 'Y' ).
    RETURN.
  ENDIF.
  lv_text = iv_object_name.
  IF lv_text CN 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.
    RETURN.
  ENDIF.
  IF iv_object_type <> 'PROG' AND strlen( lv_text ) > 30.
    RETURN.
  ENDIF.
  ev_code = 'OBJECT_NOT_FOUND'.
  SELECT SINGLE devclass INTO lv_package FROM tadir
    WHERE pgmid = 'R3TR' AND object = iv_object_type
      AND obj_name = iv_object_name AND delflag = space.
  IF sy-subrc <> 0 OR lv_package IS INITIAL.
    RETURN.
  ENDIF.
  AUTHORITY-CHECK OBJECT 'S_DEVELOP'
    ID 'DEVCLASS' FIELD lv_package
    ID 'OBJTYPE' FIELD iv_object_type
    ID 'OBJNAME' FIELD iv_object_name
    ID 'P_GROUP' DUMMY
    ID 'ACTVT' FIELD '03'.
  IF sy-subrc <> 0.
    ev_code = 'NOT_AUTHORIZED'.
    RETURN.
  ENDIF.
  IF iv_object_type = 'PROG'.
    ev_code = 'NOT_MAIN_PROGRAM'.
    SELECT SINGLE subc INTO lv_subc FROM trdir
      WHERE name = iv_object_name.
    IF sy-subrc <> 0 OR
       ( lv_subc <> '1' AND lv_subc <> 'M' AND lv_subc <> 'S' ).
      RETURN.
    ENDIF.
  ENDIF.
  TRY.
      ls_object-objtype = iv_object_type.
      ls_object-objname = iv_object_name.
      APPEND ls_object TO lt_objects.
      ev_code = 'OBJECTSET_FAILED'.
      CALL METHOD cl_ci_objectset=>save_from_list
        EXPORTING p_user = sy-uname p_objects = lt_objects
          p_name = space
        RECEIVING p_ref = lo_objects
        EXCEPTIONS OTHERS = 1.
      IF sy-subrc <> 0 OR lo_objects IS INITIAL.
        RETURN.
      ENDIF.
      ev_code = 'OBJECTSET_NOT_EXACT'.
      DESCRIBE TABLE lo_objects->iobjlst-objects LINES lv_count.
      IF lv_count <> 1.
        RETURN.
      ENDIF.
      READ TABLE lo_objects->iobjlst-objects INDEX 1 INTO ls_object.
      IF sy-subrc <> 0 OR ls_object-objtype <> iv_object_type
         OR ls_object-objname <> iv_object_name
         OR ls_object-devclass <> lv_package
         OR ls_object-prgname IS INITIAL.
        RETURN.
      ENDIF.
      IF iv_object_type = 'PROG' AND
         ls_object-prgname <> iv_object_name.
        RETURN.
      ENDIF.
      ev_objtype = ls_object-objtype.
      ev_objname = ls_object-objname.
      ev_program = ls_object-prgname.
      ev_package = ls_object-devclass.
      ev_code = 'RULE_VERSION_MISMATCH'.
      CREATE OBJECT lo_syntax.
      CREATE OBJECT lo_critical.
      ev_syntax = lo_syntax->version.
      ev_critical = lo_critical->version.
      IF ev_syntax <> '001' OR ev_critical <> '002'.
        RETURN.
      ENDIF.
      ls_rule-testname = 'CL_CI_TEST_SYNTAX_CHECK'.
      ls_rule-version = lo_syntax->version.
      INSERT ls_rule INTO TABLE lt_variant.
      ls_rule-testname = 'CL_CI_TEST_CRITICAL_STATEMENTS'.
      ls_rule-version = lo_critical->version.
      INSERT ls_rule INTO TABLE lt_variant.
      ev_code = 'RULE_LOAD_FAILED'.
      CALL METHOD cl_ci_tests=>get_list
        EXPORTING p_variant = lt_variant
        RECEIVING p_result = lo_tests
        EXCEPTIONS OTHERS = 1.
      IF sy-subrc <> 0 OR lo_tests IS INITIAL.
        RETURN.
      ENDIF.
      lt_tests = lo_tests->give_list( ).
      DESCRIBE TABLE lt_tests LINES lv_count.
      IF lv_count <> 2.
        RETURN.
      ENDIF.
      LOOP AT lt_tests INTO lo_test.
        IF '1PRG' NOT IN lo_test->typelist AND
           iv_object_type NOT IN lo_test->typelist.
          ev_code = 'RULE_NOT_APPLICABLE'.
          RETURN.
        ENDIF.
      ENDLOOP.
      IF iv_action = 'PRECHECK'.
        ev_status = 'S'.
        ev_code = 'PREFLIGHT_ONLY'.
        RETURN.
      ENDIF.
      ev_code = 'VARIANT_CREATE_FAILED'.
      CALL METHOD cl_ci_checkvariant=>create
        EXPORTING p_user = sy-uname p_name = space
        RECEIVING p_ref = lo_variant
        EXCEPTIONS OTHERS = 1.
      IF sy-subrc <> 0 OR lo_variant IS INITIAL.
        RETURN.
      ENDIF.
      CALL METHOD lo_variant->set_variant
        EXPORTING p_variant = lt_variant
        EXCEPTIONS OTHERS = 1.
      IF sy-subrc <> 0.
        RETURN.
      ENDIF.
      ev_code = 'INSPECTION_CREATE_FAILED'.
      CALL METHOD cl_ci_inspection=>create
        EXPORTING p_user = sy-uname p_name = space
        RECEIVING p_ref = lo_inspect
        EXCEPTIONS OTHERS = 1.
      IF sy-subrc <> 0 OR lo_inspect IS INITIAL.
        RETURN.
      ENDIF.
      ev_code = 'INSPECTION_SET_FAILED'.
      CALL METHOD lo_inspect->set
        EXPORTING p_chkv = lo_variant p_objs = lo_objects
          p_noaunit = 'X' p_nosuppress = 'X'
        EXCEPTIONS OTHERS = 1.
      IF sy-subrc <> 0.
        RETURN.
      ENDIF.
      ev_code = 'SCI_RUN_FAILED'.
      CALL METHOD lo_inspect->run
        EXPORTING p_howtorun = 'D'
        EXCEPTIONS OTHERS = 1.
      IF sy-subrc <> 0.
        RETURN.
      ENDIF.
      DESCRIBE TABLE lo_inspect->sciresthd LINES lv_count.
      IF lv_count <> 1.
        ev_code = 'RESULT_COVERAGE_UNKNOWN'.
        RETURN.
      ENDIF.
      DESCRIBE TABLE lo_inspect->scirestps LINES ev_count.
      LOOP AT lo_inspect->scirestps INTO ls_finding FROM 1 TO 1000.
        IF ls_finding-objtype <> iv_object_type OR
           ls_finding-objname <> iv_object_name.
          ev_code = 'RESULT_OBJECT_MISMATCH'.
          CLEAR ev_count.
          REFRESH et_results.
          RETURN.
        ENDIF.
        CLEAR: ls_message, lv_text.
        ls_message-type = ls_finding-kind.
        ls_message-message_v1 = ls_finding-test.
        ls_message-message_v2 = ls_finding-code.
        ls_message-message_v3 = ls_finding-sobjname.
        ls_message-message_v4 = ls_finding-col.
        CONDENSE ls_message-message_v4.
        ls_message-row = ls_finding-line.
        IF ls_finding-test = 'CL_CI_TEST_SYNTAX_CHECK'.
          lv_text = ls_finding-param1.
        ELSEIF ls_finding-test = 'CL_CI_TEST_CRITICAL_STATEMENTS'.
          CALL METHOD lo_critical->get_message_text
            EXPORTING p_test = ls_finding-test p_code = ls_finding-code
            IMPORTING p_text = lv_text.
          REPLACE ALL OCCURRENCES OF '&1' IN lv_text
            WITH ls_finding-param1.
        ELSE.
          ev_code = 'RESULT_RULE_MISMATCH'.
          CLEAR ev_count.
          REFRESH et_results.
          RETURN.
        ENDIF.
        ls_message-message = lv_text.
        IF strlen( lv_text ) > 220.
          ls_message-field = 'TEXT_TRUNCATED'.
        ENDIF.
        APPEND ls_message TO et_results.
      ENDLOOP.
      ev_status = 'W'.
      ev_code = 'FINDINGS_LIMITED'.
      IF ev_count = 0.
        ev_code = 'NO_FINDINGS_UNVERIFIED'.
      ELSEIF ev_count > 1000.
        ev_code = 'TRUNCATED_LIMITED'.
      ENDIF.
    CATCH cx_root.
      ev_status = 'E'.
      CLEAR ev_count.
      REFRESH et_results.
  ENDTRY.
`
  .trim()
  .split("\n")
