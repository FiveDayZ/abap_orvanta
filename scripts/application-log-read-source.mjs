// Deployment input only; SAP remains the authoritative source workspace.
export const applicationLogReadBranch = String.raw`
IF iv_action = 'READ' OR iv_action = 'READ_DIAGNOSTIC'
   OR iv_action = 'READ_BODY_CHECK'.
  INCLUDE sbaltype.
  DATA: lt_read_data TYPE baldat_t,
        ls_read_data TYPE baldat,
        ls_read_check TYPE balhdr,
        ls_read_ldat TYPE bal_s_ldat,
        ls_read_block TYPE bal_s_msgs,
        ls_read_mhdr TYPE bal_s_mhdr,
        ls_read_msg TYPE bal_s_msg,
        lv_read_block TYPE baldat-block,
        lv_read_prev TYPE baldat-srtf2,
        lv_read_name TYPE c LENGTH 6,
        lv_read_count TYPE i,
        lv_read_after TYPE i,
        lv_read_total TYPE i,
        lv_read_text TYPE c LENGTH 4096,
        lv_read_missing TYPE string,
        lv_read_all TYPE string,
        lv_read_page TYPE string,
        lv_read_header TYPE string,
        lv_read_hash TYPE string,
        lv_read_t100 TYPE t100-text,
        lv_read_langu TYPE sy-langu.
  FIELD-SYMBOLS: <read_table> TYPE ANY TABLE,
                 <read_row> TYPE any.
  DEFINE read_stage.
    IF iv_action = 'READ_BODY_CHECK'. ev_result = &1. ENDIF.
    IF iv_action = 'READ_DIAGNOSTIC'.
      CONCATENATE lv_base
        '"status":"unsupported","code":"READ_ONLY_UNSUPPORTED",'
        '"reason":"' &1 '","headers":[],"messages":[],'
        '"hasMore":false}' INTO ev_result.
    ENDIF.
  END-OF-DEFINITION.
  read_stage 'INPUT_VALIDATION'.
  IF strlen( iv_lognumber ) <> 20
     OR iv_lognumber CN '0123456789'
     OR iv_object IS NOT INITIAL OR iv_subobject IS NOT INITIAL
     OR iv_external IS NOT INITIAL OR iv_user IS NOT INITIAL
     OR iv_from IS NOT INITIAL OR iv_to IS NOT INITIAL
     OR iv_after_log IS NOT INITIAL.
    RETURN.
  ENDIF.
  lv_limit = 100.
  IF iv_limit IS NOT INITIAL.
    IF strlen( iv_limit ) > 3 OR iv_limit CN '0123456789'.
      RETURN.
    ENDIF.
    lv_limit = iv_limit.
  ENDIF.
  IF lv_limit < 1 OR lv_limit > 200.
    RETURN.
  ENDIF.
  IF iv_after_msg IS NOT INITIAL.
    IF strlen( iv_after_msg ) > 6 OR iv_after_msg CN '0123456789'.
      RETURN.
    ENDIF.
    lv_read_after = iv_after_msg.
  ENDIF.
  IF lv_read_after > 0 AND iv_revision IS INITIAL.
    RETURN.
  ENDIF.
  IF iv_revision IS NOT INITIAL.
    IF strlen( iv_revision ) <> 64
       OR iv_revision CN '0123456789abcdef'.
      RETURN.
    ENDIF.
  ENDIF.
  TRY.
    SELECT SINGLE * FROM balhdr INTO ls_head
      WHERE lognumber = iv_lognumber.
    IF sy-subrc <> 0.
      CONCATENATE lv_base
        '"status":"not_found","code":"NOT_FOUND",'
        '"headers":[],"messages":[],"hasMore":false}' INTO ev_result.
      RETURN.
    ENDIF.
    AUTHORITY-CHECK OBJECT 'S_APPL_LOG'
      ID 'ALG_OBJECT' FIELD ls_head-object
      ID 'ALG_SUBOBJ' FIELD ls_head-subobject
      ID 'ACTVT' FIELD '03'.
    IF sy-subrc <> 0.
      CONCATENATE lv_base
        '"status":"forbidden","code":"NO_AUTHORITY",'
        '"headers":[],"messages":[],"hasMore":false}' INTO ev_result.
      RETURN.
    ENDIF.
    read_stage 'AUTHORITY_EXTENSION'.
    SELECT SINGLE default_class FROM badi_main INTO lv_default
      WHERE badi_name = 'SBAL_AUTHORITY_RESTRICTION'.
    IF sy-subrc <> 0 OR lv_default IS NOT INITIAL.
      RETURN.
    ENDIF.
    SELECT badi_name FROM badi_impl INTO lv_impl UP TO 1 ROWS
      WHERE badi_name = 'SBAL_AUTHORITY_RESTRICTION'.
    ENDSELECT.
    IF sy-subrc <> 4.
      RETURN.
    ENDIF.
* Only the reviewed current, native-character-size format is decoded.
    read_stage 'DATABASE_VERSION'.
    IF ls_head-db_version <> '0001'.
      RETURN.
    ENDIF.
    read_stage 'CHARACTER_SIZE'.
    IF ls_head-char_size <> cl_abap_char_utilities=>charsize.
      RETURN.
    ENDIF.
    read_stage 'MESSAGE_BUDGET'.
    IF ls_head-last_msgnr > 1000 OR ls_head-msg_cnt_al > 1000.
      RETURN.
    ENDIF.
    read_stage 'BLOCK_BUDGET'.
    SELECT * FROM baldat INTO TABLE lt_read_data UP TO 513 ROWS
      WHERE relid = 'AL' AND log_handle = ls_head-log_handle
        AND block <> '000000'
      ORDER BY PRIMARY KEY.
    DESCRIBE TABLE lt_read_data LINES lv_rows.
    IF lv_rows > 512.
      RETURN.
    ENDIF.
    SORT lt_read_data BY mandant relid log_handle block srtf2.
    ls_read_ldat-log_handle = ls_head-log_handle.
    ls_read_ldat-admin-client = sy-mandt.
    ls_read_ldat-admin-char_size = ls_head-char_size.
    lv_read_all = '['.
    lv_read_page = '['.
    lv_more = 'false'.
    read_stage 'BLOCK_LAYOUT'.
    LOOP AT lt_read_data INTO ls_read_data.
      IF ls_read_data-clustr < 1 OR ls_read_data-clustr > 512.
        RETURN.
      ENDIF.
      IF ls_read_data-block <> lv_read_block.
        lv_read_block = ls_read_data-block.
        lv_read_prev = ls_read_data-srtf2.
        IF lv_read_prev <> 0.
          RETURN.
        ENDIF.
      ELSE.
        ADD 1 TO lv_read_prev.
        IF ls_read_data-srtf2 <> lv_read_prev.
          RETURN.
        ENDIF.
      ENDIF.
    ENDLOOP.
    CLEAR lv_read_block.
    LOOP AT lt_read_data INTO ls_read_data.
      IF ls_read_data-block = lv_read_block.
        CONTINUE.
      ENDIF.
      lv_read_block = ls_read_data-block.
      CLEAR ls_read_block.
      read_stage 'BLOCK_DECOMPRESSION'.
* This routine only imports the supplied memory table, never loads,
* converts, saves or calls log callbacks. Do not use BAL_DB_LOAD here.
      PERFORM log_block_decompress IN PROGRAM ('SAPLSBAL_DB')
        USING ls_read_ldat lv_read_block lt_read_data
        CHANGING ls_read_block.
      DESCRIBE TABLE ls_read_block-t_mhdr LINES lv_rows.
      IF lv_rows > 150.
        RETURN.
      ENDIF.
      LOOP AT ls_read_block-t_mhdr INTO ls_read_mhdr.
        read_stage 'MESSAGE_LAYOUT'.
        IF ls_read_mhdr-msgnumber <= lv_read_total
           OR ls_read_mhdr-msgnumber > 1000.
          RETURN.
        ENDIF.
        lv_read_total = ls_read_mhdr-msgnumber.
        CONCATENATE 'T_' ls_read_mhdr-category-var
          ls_read_mhdr-category-con ls_read_mhdr-category-src
          ls_read_mhdr-category-par INTO lv_read_name.
        UNASSIGN: <read_table>, <read_row>.
        ASSIGN COMPONENT lv_read_name OF STRUCTURE ls_read_block
          TO <read_table>.
        IF sy-subrc <> 0.
          RETURN.
        ENDIF.
        READ TABLE <read_table> ASSIGNING <read_row>
          WITH KEY ('MSGNUMBER') = ls_read_mhdr-msgnumber.
        IF sy-subrc <> 0.
          RETURN.
        ENDIF.
        CLEAR ls_read_msg.
        MOVE-CORRESPONDING <read_row> TO ls_read_msg.
        IF ls_read_msg-msgty NA 'AEWISX'
           OR ls_read_msg-msgty IS INITIAL.
          RETURN.
        ENDIF.
        read_stage 'MESSAGE_RENDERING'.
        CLEAR: lv_read_text, lv_read_t100.
        lv_read_langu = sy-langu.
        lv_read_missing = 'false'.
        SELECT SINGLE text FROM t100 INTO lv_read_t100
          WHERE sprsl = lv_read_langu AND arbgb = ls_read_msg-msgid
            AND msgnr = ls_read_msg-msgno.
        IF sy-subrc <> 0.
          SELECT SINGLE masterlang FROM t100a INTO lv_read_langu
            WHERE arbgb = ls_read_msg-msgid.
          IF sy-subrc = 0.
            SELECT SINGLE text FROM t100 INTO lv_read_t100
              WHERE sprsl = lv_read_langu AND arbgb = ls_read_msg-msgid
                AND msgnr = ls_read_msg-msgno.
          ENDIF.
        ENDIF.
        IF sy-subrc = 0.
          CALL FUNCTION 'BAL_DSP_TXT_MSG_READ'
            EXPORTING
              i_langu = lv_read_langu i_msgid = ls_read_msg-msgid
              i_msgno = ls_read_msg-msgno
              i_msgv1 = ls_read_msg-msgv1 i_msgv2 = ls_read_msg-msgv2
              i_msgv3 = ls_read_msg-msgv3 i_msgv4 = ls_read_msg-msgv4
            IMPORTING e_message_text = lv_read_text.
        ELSE.
          lv_read_missing = 'true'.
        ENDIF.
* Self-check distinguishes missing definitions from unsupported languages.
        IF iv_action = 'READ_BODY_CHECK' AND lv_read_missing = 'true'.
          SELECT sprsl FROM t100 INTO lv_read_langu UP TO 1 ROWS
            WHERE arbgb = ls_read_msg-msgid
              AND msgnr = ls_read_msg-msgno.
          ENDSELECT.
          IF sy-subrc = 4.
            ev_result = 'MESSAGE_DEFINITION_ABSENT'.
          ELSEIF sy-subrc = 0.
            ev_result = 'MESSAGE_LANGUAGE_UNAVAILABLE'.
          ELSE.
            ev_result = 'MESSAGE_DEFINITION_CHECK_FAILED'.
          ENDIF.
          RETURN.
        ENDIF.
* Convert NUMC through the validated integer before JSON serialization.
        lv_num = lv_read_total.
        CONDENSE lv_num NO-GAPS.
        CONCATENATE '{"number":' lv_num INTO lv_json.
        append_json_field ',"type":"' ls_read_msg-msgty.
        append_json_field ',"messageClass":"' ls_read_msg-msgid.
        append_json_field ',"messageNumber":"' ls_read_msg-msgno.
        append_json_field ',"text":"' lv_read_text.
        CONCATENATE lv_json ',"textTruncated":false,'
          '"textUnavailable":' lv_read_missing
          ',"systemTime":null}' INTO lv_json.
        IF lv_read_count > 0.
          CONCATENATE lv_read_all ',' INTO lv_read_all.
        ENDIF.
        CONCATENATE lv_read_all lv_json INTO lv_read_all.
        ADD 1 TO lv_read_count.
        IF ls_read_mhdr-msgnumber > lv_read_after.
          IF lv_idx < lv_limit.
            IF lv_idx > 0.
              CONCATENATE lv_read_page ',' INTO lv_read_page.
            ENDIF.
            CONCATENATE lv_read_page lv_json INTO lv_read_page.
            ADD 1 TO lv_idx.
          ELSE.
            lv_more = 'true'.
          ENDIF.
        ENDIF.
      ENDLOOP.
    ENDLOOP.
    read_stage 'MESSAGE_COUNT'.
    IF lv_read_count <> ls_head-msg_cnt_al.
      RETURN.
    ENDIF.
* Detect a concurrent log update before returning any messages.
    SELECT SINGLE * FROM balhdr INTO ls_read_check
      WHERE lognumber = iv_lognumber.
    IF sy-subrc <> 0 OR ls_read_check <> ls_head.
      CONCATENATE lv_base
        '"status":"unsupported","code":"LOG_CHANGED",'
        '"headers":[],"messages":[],"hasMore":false}' INTO ev_result.
      RETURN.
    ENDIF.
    IF iv_action = 'READ_BODY_CHECK'. ev_result = 'OK'. RETURN. ENDIF.
    CONCATENATE ls_head-aldate(4) '-' ls_head-aldate+4(2) '-'
      ls_head-aldate+6(2) 'T' ls_head-altime(2) ':'
      ls_head-altime+2(2) ':' ls_head-altime+4(2) INTO lv_time.
    lv_json = '['.
    append_json_field '{"logNumber":"' ls_head-lognumber.
    append_json_field ',"object":"' ls_head-object.
    append_json_field ',"subobject":"' ls_head-subobject.
    append_json_field ',"externalNumber":"' ls_head-extnumber.
    append_json_field ',"username":"' ls_head-aluser.
    append_json_field ',"program":"' ls_head-alprog.
    append_json_field ',"transaction":"' ls_head-altcode.
    append_json_field ',"systemTime":"' lv_time.
    lv_num = lv_read_count.
    CONDENSE lv_num NO-GAPS.
    CONCATENATE lv_json ',"messageCount":' lv_num '}]'
      INTO lv_read_header.
    CONCATENATE lv_read_all ']' lv_read_header sy-mandt sy-langu
      INTO lv_read_all.
    read_stage 'REVISION_HASH'.
    CALL METHOD cl_abap_message_digest=>calculate_hash_for_char
      EXPORTING if_algorithm = 'SHA256' if_data = lv_read_all
      IMPORTING ef_hashstring = lv_read_hash.
    IF strlen( lv_read_hash ) <> 64.
      RETURN.
    ENDIF.
    TRANSLATE lv_read_hash TO LOWER CASE.
    IF iv_revision IS NOT INITIAL AND iv_revision <> lv_read_hash.
      CONCATENATE lv_base
        '"status":"unsupported","code":"LOG_CHANGED",'
        '"headers":[],"messages":[],"hasMore":false}' INTO ev_result.
      RETURN.
    ENDIF.
    CONCATENATE lv_read_page ']' INTO lv_read_page.
    CONCATENATE lv_base '"status":"ok","code":"OK","headers":'
      lv_read_header ',"messages":' lv_read_page ',"hasMore":'
      lv_more ',"revision":"' lv_read_hash '"}' INTO ev_result.
    CATCH cx_root.
      RETURN.
  ENDTRY.
  RETURN.
ENDIF.
`.trim()
