// Authored body. Reuses IV_LIMIT/IV_SERVER/IV_DIR/IV_MASK and the base reply helpers
// (lv_base, lv_tail, json_field, fail_reply). Importing this module deploys nothing.
//
// Row structures are the kernel's own table parameter types, read from w200 on 2026-09-30:
// TH_WPINFO -> WPLIST type WPINFO. TH_USER_LIST has TWO table parameters: LIST (type UINFO) is
// mandatory, USRLIST (type USRINFO) is optional. The kernel refreshes USRLIST when it is
// supplied and fills LIST otherwise, so both are passed - the same call shape the standard
// program RSDSUSER uses - and only USRLIST is read; passing USRLIST alone aborts the call with
// CX_SY_DYN_CALL_PARAM_MISSING on the missing LIST, which is what an earlier round measured.
// EPS2_GET_DIRECTORY_LISTING -> DIR_LIST type EPS2FILI. Field technical types were
// read from DD03L the same day: INT1/INT4/DEC columns must be CONDENSEd NO-GAPS before they are
// concatenated, because assigning a numeric field to a string right-aligns it with leading blanks.
// Character-like columns (CHAR/CLNT/NUMC) keep the kernel's own text and lose only the trailing
// blanks a fixed-length field carries when it is assigned to a string.
export const runtimeReadDeclarations = String.raw`
DATA: lt_wp TYPE STANDARD TABLE OF wpinfo,
      ls_wp TYPE wpinfo,
      lt_usr TYPE STANDARD TABLE OF usrinfo,
      ls_usr TYPE usrinfo,
* TH_USER_LIST's mandatory LIST parameter. Passed but never read: one of
* its components (MSHOSTADR) has a type this service cannot verify.
* USRLIST - the table the kernel fills when both are given - is read.
      lt_uin TYPE STANDARD TABLE OF uinfo,
      lt_dir TYPE STANDARD TABLE OF eps2fili,
      ls_dir TYPE eps2fili,
      lv_wp_server TYPE msxxlist-name,
      lv_dir_name TYPE eps2filnam,
      lv_dir_mask TYPE epsf-epsfilnam,
      lv_dir_echo TYPE epsf-epsdirnam,
      lv_dir_files TYPE epsf-epsfilsiz,
      lv_dir_errors TYPE epsf-epsfilsiz,
* The user-list arm names the exception it catches.
      lv_exref TYPE REF TO cx_root,
      lv_class TYPE string.
`.trim()

export const runtimeReadBranch = String.raw`
IF iv_action = 'WP_LIST'.
  lv_json = '{"version":"1"'.
  json_field ',"action":"' iv_action.
  json_field ',"client":"' sy-mandt.
  json_field ',"authenticatedUser":"' sy-uname.
  CONCATENATE lv_json ',"readOnly":true,' INTO lv_base.
  lv_tail = '"server":"","rows":[],"truncated":false}'.
  fail_reply 'unsupported' 'READ_ONLY_UNSUPPORTED'.
  IF strlen( iv_server ) > 20 OR iv_dir IS NOT INITIAL
     OR iv_mask IS NOT INITIAL
     OR iv_jobname IS NOT INITIAL OR iv_jobcount IS NOT INITIAL
     OR iv_user IS NOT INITIAL OR iv_program IS NOT INITIAL
     OR iv_from IS NOT INITIAL OR iv_to IS NOT INITIAL
     OR iv_status IS NOT INITIAL OR iv_after_job IS NOT INITIAL
     OR iv_step IS NOT INITIAL OR iv_spoolid IS NOT INITIAL
     OR iv_page IS NOT INITIAL.
    RETURN.
  ENDIF.
  IF iv_limit IS INITIAL OR strlen( iv_limit ) > 3
     OR iv_limit CN '0123456789'.
    RETURN.
  ENDIF.
  lv_limit = iv_limit.
  IF lv_limit < 1 OR lv_limit > 200. RETURN. ENDIF.
  lv_value = iv_server.
  TRANSLATE lv_value TO UPPER CASE.
  IF lv_value IS NOT INITIAL.
    FIND REGEX '^[A-Z0-9_]+$' IN lv_value.
    IF sy-subrc <> 0. RETURN. ENDIF.
    lv_wp_server = lv_value.
  ENDIF.
  TRY.
    CLEAR lt_wp.
    IF lv_wp_server IS INITIAL.
      CALL FUNCTION 'TH_WPINFO'
        TABLES wplist = lt_wp
        EXCEPTIONS send_error = 1 OTHERS = 2.
    ELSE.
      CALL FUNCTION 'TH_WPINFO'
        EXPORTING srvname = lv_wp_server
        TABLES wplist = lt_wp
        EXCEPTIONS send_error = 1 OTHERS = 2.
    ENDIF.
    IF sy-subrc <> 0.
      lv_value = sy-subrc.
      CONDENSE lv_value NO-GAPS.
      CONCATENATE '"server":"","rows":[],"truncated":false,'
        '"calleeSubrc":"' lv_value '",'
        '"calleeException":"TH_WPINFO/SEND_ERROR"}' INTO lv_tail.
      fail_reply 'unsupported' 'READ_ONLY_UNSUPPORTED'. RETURN.
    ENDIF.
    DESCRIBE TABLE lt_wp LINES lv_rows.
    lv_more = 'false'.
    IF lv_rows > lv_limit. lv_more = 'true'. ENDIF.
    CLEAR: lv_items, lv_index.
    LOOP AT lt_wp INTO ls_wp.
      ADD 1 TO lv_index.
      IF lv_index > lv_limit. EXIT. ENDIF.
      CLEAR lv_json.
      json_field '{"WP_NO":"' ls_wp-wp_no.
      rt_num ls_wp-wp_itype ',"WP_ITYPE":"'.
      json_field ',"WP_TYP":"' ls_wp-wp_typ.
      json_field ',"WP_PID":"' ls_wp-wp_pid.
      rt_num ls_wp-wp_istatus ',"WP_ISTATUS":"'.
      json_field ',"WP_STATUS":"' ls_wp-wp_status.
      json_field ',"WP_BNAME":"' ls_wp-wp_bname.
      json_field ',"WP_MANDT":"' ls_wp-wp_mandt.
      json_field ',"WP_REPORT":"' ls_wp-wp_report.
      rt_num ls_wp-wp_iaction ',"WP_IACTION":"'.
      json_field ',"WP_ACTION":"' ls_wp-wp_action.
      json_field ',"WP_TABLE":"' ls_wp-wp_table.
      json_field ',"WP_SERVER":"' ls_wp-wp_server.
      json_field ',"WP_CPU":"' ls_wp-wp_cpu.
      json_field ',"WP_ELTIME":"' ls_wp-wp_eltime.
      json_field ',"WP_WAITTIM":"' ls_wp-wp_waittim.
      json_field ',"WP_WAITINF":"' ls_wp-wp_waitinf.
      json_field ',"WP_SEM":"' ls_wp-wp_sem.
      rt_num ls_wp-wp_semstat ',"WP_SEMSTAT":"'.
      json_field ',"WP_RESTART":"' ls_wp-wp_restart.
      json_field ',"WP_DUMPS":"' ls_wp-wp_dumps.
      rt_num ls_wp-wp_index ',"WP_INDEX":"'.
      rt_num ls_wp-wp_irestrt ',"WP_IRESTRT":"'.
      rt_num ls_wp-wp_iwait ',"WP_IWAIT":"'.
      json_field ',"WP_WAITING":"' ls_wp-wp_waiting.
      CONCATENATE lv_json '}' INTO lv_json.
      IF lv_index > 1. CONCATENATE lv_items ',' INTO lv_items. ENDIF.
      CONCATENATE lv_items lv_json INTO lv_items.
    ENDLOOP.
    CLEAR lv_json.
    json_field '"server":"' lv_wp_server.
    CONCATENATE lv_json ',"rows":[' lv_items
      '],"truncated":' lv_more '}' INTO lv_tail.
    fail_reply 'ok' 'OK'.
  CATCH cx_root.
    lv_tail = '"server":"","rows":[],"truncated":false}'.
    fail_reply 'unsupported' 'READ_ONLY_UNSUPPORTED'.
  ENDTRY.
  RETURN.
ENDIF.
IF iv_action = 'USER_LIST'.
  lv_json = '{"version":"1"'.
  json_field ',"action":"' iv_action.
  json_field ',"client":"' sy-mandt.
  json_field ',"authenticatedUser":"' sy-uname.
  CONCATENATE lv_json ',"readOnly":true,' INTO lv_base.
  lv_tail = '"kernelRowCount":"0","rows":[],"truncated":false}'.
  fail_reply 'unsupported' 'READ_ONLY_UNSUPPORTED'.
  job_stage 'USER_LIST_SCOPE'.
  IF iv_server IS NOT INITIAL OR iv_dir IS NOT INITIAL
     OR iv_mask IS NOT INITIAL
     OR iv_jobname IS NOT INITIAL OR iv_jobcount IS NOT INITIAL
     OR iv_user IS NOT INITIAL OR iv_program IS NOT INITIAL
     OR iv_from IS NOT INITIAL OR iv_to IS NOT INITIAL
     OR iv_status IS NOT INITIAL OR iv_after_job IS NOT INITIAL
     OR iv_step IS NOT INITIAL OR iv_spoolid IS NOT INITIAL
     OR iv_page IS NOT INITIAL.
    RETURN.
  ENDIF.
  job_stage 'USER_LIST_LIMIT'.
  IF iv_limit IS INITIAL OR strlen( iv_limit ) > 3
     OR iv_limit CN '0123456789'.
    RETURN.
  ENDIF.
  lv_limit = iv_limit.
  IF lv_limit < 1 OR lv_limit > 200. RETURN. ENDIF.
  job_stage 'USER_LIST_CALLEE'.
  TRY.
    CLEAR: lt_usr, lt_uin.
    CALL FUNCTION 'TH_USER_LIST'
      TABLES
        list = lt_uin
        usrlist = lt_usr
      EXCEPTIONS
        auth_misssing = 1
        OTHERS = 2.
    IF sy-subrc = 1.
      lv_value = sy-subrc.
      CONDENSE lv_value NO-GAPS.
      CONCATENATE '"kernelRowCount":"0","rows":[],'
        '"truncated":false,"calleeSubrc":"' lv_value '",'
        '"calleeException":"TH_USER_LIST/AUTH_MISSSING"'
        INTO lv_tail.
      job_stage 'USER_LIST_AUTHORITY'.
      fail_reply 'forbidden' 'NO_AUTHORITY'. RETURN.
    ENDIF.
    IF sy-subrc <> 0.
      lv_value = sy-subrc.
      CONDENSE lv_value NO-GAPS.
      CONCATENATE '"kernelRowCount":"0","rows":[],'
        '"truncated":false,"calleeSubrc":"' lv_value '",'
        '"calleeException":"TH_USER_LIST"'
        INTO lv_tail.
      job_stage 'USER_LIST_SUBRC'.
      fail_reply 'unsupported' 'READ_ONLY_UNSUPPORTED'. RETURN.
    ENDIF.
    DESCRIBE TABLE lt_usr LINES lv_rows.
    lv_more = 'false'.
    IF lv_rows > lv_limit. lv_more = 'true'. ENDIF.
    job_stage 'USER_LIST_ROWS'.
    CLEAR: lv_items, lv_index.
    LOOP AT lt_usr INTO ls_usr.
      ADD 1 TO lv_index.
      IF lv_index > lv_limit. EXIT. ENDIF.
      CLEAR lv_json.
      rt_num ls_usr-tid '{"TID":"'.
      json_field ',"MANDT":"' ls_usr-mandt.
      json_field ',"BNAME":"' ls_usr-bname.
      json_field ',"TCODE":"' ls_usr-tcode.
      json_field ',"TERM":"' ls_usr-term.
      json_field ',"ZEIT":"' ls_usr-zeit.
      json_field ',"MASTER":"' ls_usr-master.
      rt_num ls_usr-trace ',"TRACE":"'.
      rt_num ls_usr-extmodi ',"EXTMODI":"'.
      rt_num ls_usr-intmodi ',"INTMODI":"'.
      rt_num ls_usr-type ',"TYPE":"'.
      rt_num ls_usr-stat ',"STAT":"'.
      rt_num ls_usr-protocol ',"PROTOCOL":"'.
      json_field ',"GUIVERSION":"' ls_usr-guiversion.
      json_field ',"RFC_TYPE":"' ls_usr-rfc_type.
      json_field ',"HOSTADDR":"' ls_usr-hostaddr.
      CONCATENATE lv_json '}' INTO lv_json.
      IF lv_index > 1. CONCATENATE lv_items ',' INTO lv_items. ENDIF.
      CONCATENATE lv_items lv_json INTO lv_items.
    ENDLOOP.
    CLEAR lv_json.
    rt_num lv_rows '"kernelRowCount":"'.
    CONCATENATE lv_json ',"rows":[' lv_items
      '],"truncated":' lv_more '}' INTO lv_tail.
    fail_reply 'ok' 'OK'.
  CATCH cx_root INTO lv_exref.
* This handler used to answer with the bare default reply that
* every guard RETURN also produces, so a kernel exception looked
* like a refused capability and the cause was lost. It is reached
* whenever the row cap passes the limit guard. Name the stage,
* carry the class name, and write unconditionally: job_stage alone
* is a no-op in normal mode and would still leave a blank answer.
    lv_tail = '"kernelRowCount":"0","rows":[],"truncated":false}'.
    CLEAR lv_class.
    TRY.
        lv_class = cl_abap_classdescr=>get_class_name(
          p_object = lv_exref ).
      CATCH cx_root.
        CLEAR lv_class.
    ENDTRY.
    IF strlen( lv_class ) > 60. lv_class = lv_class(60). ENDIF.
    CLEAR lv_json.
    json_field ',"calleeException":"' lv_class.
    CONCATENATE lv_json '}' INTO lv_json.
    CONCATENATE '"kernelRowCount":"0","rows":[],"truncated":false'
      lv_json INTO lv_tail.
    job_stage 'USER_LIST_EXCEPTION'.
    CONCATENATE lv_base
      '"status":"unsupported","code":"READ_ONLY_UNSUPPORTED",'
      '"reason":"USER_LIST_EXCEPTION",' lv_tail INTO ev_result.
  ENDTRY.
  RETURN.
ENDIF.
IF iv_action = 'DIR_LIST'.
  lv_json = '{"version":"1"'.
  json_field ',"action":"' iv_action.
  json_field ',"client":"' sy-mandt.
  json_field ',"authenticatedUser":"' sy-uname.
  CONCATENATE lv_json ',"readOnly":true,' INTO lv_base.
  CONCATENATE '"directory":"","fileCounter":"0","errorCounter":"0",'
    '"rows":[],"truncated":false}' INTO lv_tail.
  fail_reply 'unsupported' 'READ_ONLY_UNSUPPORTED'.
  IF iv_dir IS INITIAL OR strlen( iv_dir ) > 200
     OR strlen( iv_mask ) > 40 OR iv_server IS NOT INITIAL
     OR iv_jobname IS NOT INITIAL OR iv_jobcount IS NOT INITIAL
     OR iv_user IS NOT INITIAL OR iv_program IS NOT INITIAL
     OR iv_from IS NOT INITIAL OR iv_to IS NOT INITIAL
     OR iv_status IS NOT INITIAL OR iv_after_job IS NOT INITIAL
     OR iv_step IS NOT INITIAL OR iv_spoolid IS NOT INITIAL
     OR iv_page IS NOT INITIAL.
    RETURN.
  ENDIF.
  IF iv_limit IS INITIAL OR strlen( iv_limit ) > 3
     OR iv_limit CN '0123456789'.
    RETURN.
  ENDIF.
  lv_limit = iv_limit.
  IF lv_limit < 1 OR lv_limit > 200. RETURN. ENDIF.
  lv_value = iv_dir.
  IF lv_value(1) <> '/' OR lv_value CS '..'.
    RETURN.
  ENDIF.
  FIND REGEX '^/[A-Za-z0-9_./-]+$' IN lv_value.
  IF sy-subrc <> 0. RETURN. ENDIF.
  IF iv_mask IS NOT INITIAL.
    lv_value = iv_mask.
    FIND REGEX '^[A-Za-z0-9_.*?-]+$' IN lv_value.
    IF sy-subrc <> 0. RETURN. ENDIF.
  ENDIF.
  lv_dir_name = iv_dir.
  lv_dir_mask = iv_mask.
  TRY.
    CLEAR: lt_dir, lv_dir_echo, lv_dir_files, lv_dir_errors.
    IF iv_mask IS INITIAL.
      CALL FUNCTION 'EPS2_GET_DIRECTORY_LISTING'
        EXPORTING iv_dir_name = lv_dir_name
        IMPORTING dir_name = lv_dir_echo
                  file_counter = lv_dir_files
                  error_counter = lv_dir_errors
        TABLES dir_list = lt_dir
        EXCEPTIONS no_authorization = 1
                   empty_directory_list = 2
                   others = 3.
    ELSE.
      CALL FUNCTION 'EPS2_GET_DIRECTORY_LISTING'
        EXPORTING iv_dir_name = lv_dir_name
                  file_mask = lv_dir_mask
        IMPORTING dir_name = lv_dir_echo
                  file_counter = lv_dir_files
                  error_counter = lv_dir_errors
        TABLES dir_list = lt_dir
        EXCEPTIONS no_authorization = 1
                   empty_directory_list = 2
                   others = 3.
    ENDIF.
    IF sy-subrc = 1.
      lv_value = sy-subrc.
      CONDENSE lv_value NO-GAPS.
      CONCATENATE '"directory":"","fileCounter":"0",'
        '"errorCounter":"0","rows":[],"truncated":false,'
        '"calleeSubrc":"' lv_value '",'
        '"calleeException":"EPS2_GET_DIRECTORY_LISTING/'
        'NO_AUTHORIZATION"' INTO lv_tail.
      fail_reply 'forbidden' 'NO_AUTHORITY'. RETURN.
    ENDIF.
    IF sy-subrc <> 0 AND sy-subrc <> 2.
      lv_value = sy-subrc.
      CONDENSE lv_value NO-GAPS.
      CONCATENATE '"directory":"","fileCounter":"0",'
        '"errorCounter":"0","rows":[],"truncated":false,'
        '"calleeSubrc":"' lv_value '",'
        '"calleeException":"EPS2_GET_DIRECTORY_LISTING"'
        INTO lv_tail.
      fail_reply 'unsupported' 'READ_ONLY_UNSUPPORTED'. RETURN.
    ENDIF.
    IF sy-subrc = 2. CLEAR lt_dir. ENDIF.
    DESCRIBE TABLE lt_dir LINES lv_rows.
    lv_more = 'false'.
    IF lv_rows > lv_limit. lv_more = 'true'. ENDIF.
    CLEAR: lv_items, lv_index.
    LOOP AT lt_dir INTO ls_dir.
      ADD 1 TO lv_index.
      IF lv_index > lv_limit. EXIT. ENDIF.
      CLEAR lv_json.
      json_field '{"NAME":"' ls_dir-name.
      rt_num ls_dir-size ',"SIZE":"'.
      json_field ',"MTIM":"' ls_dir-mtim.
      json_field ',"OWNER":"' ls_dir-owner.
      json_field ',"RC":"' ls_dir-rc.
      CONCATENATE lv_json '}' INTO lv_json.
      IF lv_index > 1. CONCATENATE lv_items ',' INTO lv_items. ENDIF.
      CONCATENATE lv_items lv_json INTO lv_items.
    ENDLOOP.
    CLEAR lv_json.
    json_field '"directory":"' lv_dir_echo.
    rt_num lv_dir_files ',"fileCounter":"'.
    rt_num lv_dir_errors ',"errorCounter":"'.
    CONCATENATE lv_json ',"rows":[' lv_items
      '],"truncated":' lv_more '}' INTO lv_tail.
    fail_reply 'ok' 'OK'.
  CATCH cx_root.
    CONCATENATE '"directory":"","fileCounter":"0","errorCounter":"0",'
      '"rows":[],"truncated":false}' INTO lv_tail.
    fail_reply 'unsupported' 'READ_ONLY_UNSUPPORTED'.
  ENDTRY.
  RETURN.
ENDIF.
`.trim()
