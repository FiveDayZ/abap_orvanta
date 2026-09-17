// Authored body. Requires three optional STRINGVAL imports:
// IV_STEP, IV_SPOOLID, IV_PAGE. No deployment or execution occurs on import.
export const jobSpoolDeclarations = String.raw`
DATA: ls_spool TYPE tsp01, ls_spool_after TYPE tsp01,
      ls_spool_step TYPE tbtcp, ls_spool_step_after TYPE tbtcp,
      lv_spool_id TYPE tsp01-rqident,
      lv_spool_step TYPE tbtcp-stepcount,
      lv_spool_page TYPE i, lv_spool_rc TYPE sy-subrc,
      lv_spool_auth TYPE tspoptions-value,
      lt_spool_text TYPE STANDARD TABLE OF string,
      lv_spool_text TYPE string, lv_spool_stamp TYPE string.
`.trim()

export const jobSpoolBranch = String.raw`
IF iv_action = 'JOB_SPOOL'.
  IF iv_jobname IS INITIAL OR strlen( iv_jobname ) > 32
     OR iv_jobname CA '*+%?'
     OR strlen( iv_jobcount ) <> 8 OR iv_jobcount CN '0123456789'
     OR iv_from IS NOT INITIAL OR iv_to IS NOT INITIAL
     OR iv_user IS NOT INITIAL OR iv_program IS NOT INITIAL
     OR iv_status IS NOT INITIAL OR iv_after_job IS NOT INITIAL
     OR iv_limit <> '1000'.
    RETURN.
  ENDIF.
  IF iv_step IS INITIAL OR strlen( iv_step ) > 10
     OR iv_step CN '0123456789'
     OR iv_spoolid IS INITIAL OR strlen( iv_spoolid ) > 10
     OR iv_spoolid CN '0123456789'
     OR iv_page IS INITIAL OR strlen( iv_page ) > 4
     OR iv_page CN '0123456789'.
    RETURN.
  ENDIF.
  IF strlen( iv_step ) = 10 AND iv_step > '2147483647'.
    RETURN.
  ENDIF.
  lv_spool_step = iv_step.
  lv_spool_id = iv_spoolid.
  lv_spool_page = iv_page.
  IF lv_spool_step < 1 OR lv_spool_id IS INITIAL
     OR lv_spool_page < 1 OR lv_spool_page > 1000.
    RETURN.
  ENDIF.
  SELECT SINGLE * FROM tbtco INTO ls_job
    WHERE jobname = iv_jobname AND jobcount = iv_jobcount
      AND authckman = sy-mandt.
  IF sy-subrc <> 0.
    fail_reply 'not_found' 'NOT_FOUND'. RETURN.
  ENDIF.
  AUTHORITY-CHECK OBJECT 'S_BTCH_JOB'
    ID 'JOBGROUP' FIELD ls_job-jobgroup ID 'JOBACTION' FIELD 'SHOW'.
  IF sy-subrc <> 0.
    fail_reply 'forbidden' 'NO_AUTHORITY'. RETURN.
  ENDIF.
  AUTHORITY-CHECK OBJECT 'S_BTCH_JOB'
    ID 'JOBGROUP' FIELD ls_job-jobgroup ID 'JOBACTION' FIELD 'PROT'.
  IF sy-subrc <> 0.
    fail_reply 'forbidden' 'NO_AUTHORITY'. RETURN.
  ENDIF.
  SELECT SINGLE * FROM tbtcp INTO ls_spool_step
    WHERE jobname = iv_jobname AND jobcount = iv_jobcount
      AND stepcount = lv_spool_step.
  IF sy-subrc <> 0.
    fail_reply 'not_found' 'NOT_FOUND'. RETURN.
  ENDIF.
  IF ls_spool_step-listident <> lv_spool_id.
    fail_reply 'unsupported' 'LOG_CHANGED'. RETURN.
  ENDIF.
  SELECT SINGLE * FROM tsp01 INTO ls_spool
    WHERE rqident = lv_spool_id AND rqclient = sy-mandt.
  IF sy-subrc <> 0.
    fail_reply 'not_found' 'NOT_FOUND'. RETURN.
  ENDIF.
* Reject configured alternate authorization modes before any customer exit.
  lv_diagnostic = 'X'.
  job_stage 'SPOOL_AUTH_MODE'.
  CALL FUNCTION 'RSPO_OPTION_GET'
    EXPORTING name = 'AUTHORIZATION'
    IMPORTING value = lv_spool_auth
    EXCEPTIONS OTHERS = 1.
  IF sy-subrc <> 0 OR lv_spool_auth IS NOT INITIAL. RETURN. ENDIF.
* Use the SAP spool permission path; job display is not spool authorization.
  CALL FUNCTION 'RSPO_CHECK_JOB_ID_PERMISSION'
    EXPORTING rqident = lv_spool_id access = 'DISP'
    EXCEPTIONS no_such_job = 1 no_permission = 2 OTHERS = 3.
  CASE sy-subrc.
    WHEN 1. fail_reply 'not_found' 'NOT_FOUND'. RETURN.
    WHEN 2. fail_reply 'forbidden' 'NO_AUTHORITY'. RETURN.
    WHEN 3. RETURN.
  ENDCASE.
  job_stage 'SPOOL_TYPE'.
  IF ls_spool-rqdoctype <> 'LIST'. RETURN. ENDIF.
* Clear saved list memory before rendering, including reused RFC sessions.
  job_stage 'SPOOL_READ'.
  CALL FUNCTION 'LIST_FREE_MEMORY' EXCEPTIONS OTHERS = 1.
  IF sy-subrc <> 0. RETURN. ENDIF.
  TRY.
  CALL FUNCTION 'RSPO_RETURN_ABAP_SPOOLJOB'
    EXPORTING rqident = lv_spool_id
      first_line = lv_spool_page last_line = lv_spool_page pages = 'X'
    TABLES buffer = lt_spool_text
    EXCEPTIONS no_such_job = 1 not_abap_list = 2
      job_contains_no_data = 3 selection_empty = 4
      no_permission = 5 can_not_access = 6 read_error = 7 OTHERS = 8.
  lv_spool_rc = sy-subrc.
  CATCH cx_root.
    CALL FUNCTION 'LIST_FREE_MEMORY' EXCEPTIONS OTHERS = 1.
    RETURN.
  ENDTRY.
  CALL FUNCTION 'LIST_FREE_MEMORY' EXCEPTIONS OTHERS = 1.
  IF sy-subrc <> 0. RETURN. ENDIF.
  CASE lv_spool_rc.
    WHEN 1. fail_reply 'not_found' 'NOT_FOUND'. RETURN.
    WHEN 2. job_stage 'SPOOL_TYPE'. RETURN.
    WHEN 3. job_stage 'SPOOL_EMPTY'. RETURN.
    WHEN 4. job_stage 'SPOOL_PAGE_EMPTY'. RETURN.
    WHEN 5. fail_reply 'forbidden' 'NO_AUTHORITY'. RETURN.
    WHEN 6 OR 7 OR 8. RETURN.
  ENDCASE.
  DESCRIBE TABLE lt_spool_text LINES lv_rows.
  IF lv_rows = 0. job_stage 'SPOOL_PAGE_EMPTY'. RETURN. ENDIF.
  IF lv_rows > 1000.
    fail_reply 'unsupported' 'LIMIT_EXCEEDED'. RETURN.
  ENDIF.
  SELECT SINGLE * FROM tbtco INTO ls_job_check
    WHERE jobname = iv_jobname AND jobcount = iv_jobcount
      AND authckman = sy-mandt.
  IF sy-subrc <> 0 OR ls_job_check <> ls_job.
    fail_reply 'unsupported' 'LOG_CHANGED'. RETURN.
  ENDIF.
  SELECT SINGLE * FROM tbtcp INTO ls_spool_step_after
    WHERE jobname = iv_jobname AND jobcount = iv_jobcount
      AND stepcount = lv_spool_step.
  IF sy-subrc <> 0 OR ls_spool_step_after <> ls_spool_step.
    fail_reply 'unsupported' 'LOG_CHANGED'. RETURN.
  ENDIF.
  SELECT SINGLE * FROM tsp01 INTO ls_spool_after
    WHERE rqident = lv_spool_id AND rqclient = sy-mandt.
  IF sy-subrc <> 0 OR ls_spool_after <> ls_spool.
    fail_reply 'unsupported' 'LOG_CHANGED'. RETURN.
  ENDIF.
  lv_items = '['.
  LOOP AT lt_spool_text INTO lv_spool_text.
    IF strlen( lv_spool_text ) > 4096.
      fail_reply 'unsupported' 'LIMIT_EXCEEDED'. RETURN.
    ENDIF.
    IF sy-tabix > 1. CONCATENATE lv_items ',' INTO lv_items. ENDIF.
    lv_json = ''.
    json_field '"' lv_spool_text.
    CONCATENATE lv_items lv_json INTO lv_items.
    IF strlen( lv_items ) > 200000.
      fail_reply 'unsupported' 'LIMIT_EXCEEDED'. RETURN.
    ENDIF.
  ENDLOOP.
  CONCATENATE lv_items ']' INTO lv_items.
  lv_json = ''.
  json_field '"job":{"jobName":"' ls_job-jobname.
  json_field ',"jobCount":"' ls_job-jobcount.
  lv_number = lv_spool_step. CONDENSE lv_number NO-GAPS.
  CONCATENATE lv_json '},"stepNumber":' lv_number INTO lv_json.
  json_field ',"spoolId":"' ls_spool-rqident.
  lv_number = lv_spool_page. CONDENSE lv_number NO-GAPS.
  CONCATENATE lv_json ',"page":' lv_number INTO lv_json.
  lv_spool_stamp = ls_spool-rqcretime.
  lv_value = ls_spool-rqmodtime.
  CONCATENATE lv_spool_stamp lv_value ls_spool-rqfinal
    INTO lv_spool_stamp SEPARATED BY ':'.
  json_field ',"spoolStamp":"' lv_spool_stamp.
  CONCATENATE lv_json ',"lines":' lv_items '}' INTO lv_tail.
  fail_reply 'ok' 'OK'.
  RETURN.
ENDIF.
`.trim()
