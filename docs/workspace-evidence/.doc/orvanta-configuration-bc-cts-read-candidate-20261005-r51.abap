FUNCTION Z_ORVANTA_CFG_BC_CTS.
TYPE-POOLS: trwbo.
DATA: ls_request TYPE trwbo_request,
      ls_header TYPE e070, ls_client TYPE e070c,
      lt_headers TYPE STANDARD TABLE OF e070,
      lt_clients TYPE STANDARD TABLE OF e070c,
      lt_objects TYPE STANDARD TABLE OF e071,
      lt_keys TYPE STANDARD TABLE OF e071k,
      lt_string_keys TYPE STANDARD TABLE OF e071k_str,
      ls_string_key TYPE e071k_str,
      ls_object TYPE e071, ls_key TYPE e071k,
      lv_request TYPE trkorr, lv_parent TYPE trkorr,
      lv_table TYPE tabname, lv_count TYPE i,
      lv_pass TYPE i, lv_root TYPE i,
      lv_buffer TYPE xstring, lv_first TYPE xstring,
      lv_hash TYPE string, lv_base64 TYPE string.
CLEAR: ev_code, ev_system, ev_client, ev_user, ev_request,
       ev_task, ev_cts_version, ev_data_base64, ev_data_bytes,
       ev_object_count, ev_key_count, ev_string_key_count.
IF sy-sysid <> 'GR2' OR sy-mandt <> '200'.
  ev_code = 'SCOPE_UNSUPPORTED'. RETURN.
ENDIF.
IF iv_bc_set <> 'EHS_CUNI_KNM' OR iv_version <> 'N' OR
   iv_request <> 'GR2K923429' OR iv_task <> 'GR2K923430'.
  ev_code = 'INPUT_INVALID'. RETURN.
ENDIF.
" No arbitrary table or transport selector is accepted.
DO 5 TIMES.
  CASE sy-index.
    WHEN 1. lv_table = 'E070'.
    WHEN 2. lv_table = 'E070C'.
    WHEN 3. lv_table = 'E071'.
    WHEN 4. lv_table = 'E071K'.
    WHEN 5. lv_table = 'E071K_STR'.
  ENDCASE.
  AUTHORITY-CHECK OBJECT 'S_TABU_NAM'
    ID 'TABLE' FIELD lv_table ID 'ACTVT' FIELD '03'.
  IF sy-subrc <> 0.
    ev_code = 'AUTHORIZATION_DENIED'. RETURN.
  ENDIF.
ENDDO.
" Re-read both exact roots; no transaction lock or snapshot is claimed.
DO 2 TIMES.
  lv_pass = sy-index.
  REFRESH: lt_headers, lt_clients, lt_objects, lt_keys, lt_string_keys.
  DO 2 TIMES.
    lv_root = sy-index.
    IF lv_root = 1. lv_request = iv_request.
    ELSE. lv_request = iv_task. ENDIF.
    SELECT COUNT( * ) FROM e071 INTO lv_count WHERE trkorr = lv_request.
    IF lv_count > 128.
      ev_code = 'LIMIT_EXCEEDED'. RETURN.
    ENDIF.
    SELECT COUNT( * ) FROM e071k INTO lv_count WHERE trkorr = lv_request.
    IF lv_count > 128.
      ev_code = 'LIMIT_EXCEEDED'. RETURN.
    ENDIF.
    SELECT COUNT( * ) FROM e071k_str INTO lv_count WHERE trkorr = lv_request.
    IF lv_count > 128.
      ev_code = 'LIMIT_EXCEEDED'. RETURN.
    ENDIF.
    CLEAR: ls_request, ls_header, ls_client.
    CALL FUNCTION 'TR_READ_REQUEST'
      EXPORTING iv_read_e070 = 'X' iv_read_e070c = 'X'
        iv_read_objs_keys = 'X' iv_trkorr = lv_request
      CHANGING cs_request = ls_request
      EXCEPTIONS error_occured = 1 no_authorization = 2
        error_message = 3 OTHERS = 4.
    IF sy-subrc <> 0.
      IF sy-subrc = 2. ev_code = 'AUTHORIZATION_DENIED'.
      ELSE. ev_code = 'READ_FAILED'. ENDIF.
      RETURN.
    ENDIF.
" Standard header omits some E070C attributes; retain complete DDIC rows.
    SELECT SINGLE * FROM e070 INTO ls_header WHERE trkorr = lv_request.
    IF sy-subrc <> 0.
      ev_code = 'HEADER_MISSING'. RETURN.
    ENDIF.
    SELECT SINGLE * FROM e070c INTO ls_client WHERE trkorr = lv_request.
    IF sy-subrc <> 0.
      ev_code = 'CLIENT_MISSING'. RETURN.
    ENDIF.
    IF ls_header-trstatus <> 'D' OR ls_header-as4user <> sy-uname OR
       ls_header-korrdev <> 'CUST' OR ls_client-client <> sy-mandt OR
       ls_client-tarclient <> space OR ls_client-extended_state <> space OR
       ls_client-overtaker <> space OR ls_request-h-trkorr <> lv_request OR
       ls_request-h-trstatus <> ls_header-trstatus OR
       ls_request-h-as4user <> ls_header-as4user OR
       ls_request-h-trfunction <> ls_header-trfunction OR
       ls_request-h-strkorr <> ls_header-strkorr OR
       ls_request-h-client <> ls_client-client.
      ev_code = 'HEADER_SCOPE_INVALID'. RETURN.
    ENDIF.
    IF lv_root = 1.
      IF ls_header-trfunction <> 'W' OR ls_header-strkorr <> space OR
         ls_header-tarsystem <> 'GR3'.
        ev_code = 'HEADER_SCOPE_INVALID'. RETURN.
      ENDIF.
      lv_parent = ls_header-trkorr.
    ELSE.
      IF ls_header-trfunction <> 'Q' OR ls_header-strkorr <> lv_parent OR
         ls_header-tarsystem <> space.
        ev_code = 'HEADER_SCOPE_INVALID'. RETURN.
      ENDIF.
    ENDIF.
    IF lines( ls_request-objects ) > 128 OR lines( ls_request-keys ) > 128 OR
       lines( ls_request-keys_str ) > 128.
      ev_code = 'LIMIT_EXCEEDED'. RETURN.
    ENDIF.
    LOOP AT ls_request-objects INTO ls_object.
      IF ls_object-trkorr <> lv_request.
        ev_code = 'ENTRY_SCOPE_INVALID'. RETURN.
      ENDIF.
    ENDLOOP.
    LOOP AT ls_request-keys INTO ls_key.
      IF ls_key-trkorr <> lv_request.
        ev_code = 'ENTRY_SCOPE_INVALID'. RETURN.
      ENDIF.
    ENDLOOP.
    LOOP AT ls_request-keys_str INTO ls_string_key.
      IF ls_string_key-trkorr <> lv_request.
        ev_code = 'ENTRY_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF strlen( ls_string_key-tabkey ) > 4096 OR
         strlen( ls_string_key-key_lens ) > 4096.
        ev_code = 'LIMIT_EXCEEDED'. RETURN.
      ENDIF.
    ENDLOOP.
    APPEND ls_header TO lt_headers.
    APPEND ls_client TO lt_clients.
    APPEND LINES OF ls_request-objects TO lt_objects.
    APPEND LINES OF ls_request-keys TO lt_keys.
    APPEND LINES OF ls_request-keys_str TO lt_string_keys.
  ENDDO.
  EXPORT system = sy-sysid client = sy-mandt user = sy-uname
    bc_set = iv_bc_set version = iv_version request = iv_request task = iv_task
    headers = lt_headers clients = lt_clients objects = lt_objects
    keys = lt_keys string_keys = lt_string_keys TO DATA BUFFER lv_buffer.
  IF xstrlen( lv_buffer ) = 0 OR xstrlen( lv_buffer ) > 524288.
    ev_code = 'LIMIT_EXCEEDED'. RETURN.
  ENDIF.
  IF lv_pass = 1. lv_first = lv_buffer.
  ELSEIF lv_first <> lv_buffer.
    ev_code = 'READ_CHANGED'. RETURN.
  ENDIF.
ENDDO.
CALL FUNCTION 'CALCULATE_HASH_FOR_RAW'
  EXPORTING alg = 'SHA2' data = lv_buffer
  IMPORTING hashstring = lv_hash
  EXCEPTIONS unknown_alg = 1 param_error = 2 internal_error = 3
    error_message = 4 OTHERS = 5.
IF sy-subrc <> 0.
  ev_code = 'HASH_FAILED'. RETURN.
ENDIF.
TRANSLATE lv_hash TO LOWER CASE.
IF strlen( lv_hash ) <> 64 OR lv_hash CN '0123456789abcdef'.
  ev_code = 'HASH_FAILED'. RETURN.
ENDIF.
CALL FUNCTION 'SCMS_BASE64_ENCODE_STR'
  EXPORTING input = lv_buffer IMPORTING output = lv_base64
  EXCEPTIONS error_message = 1 OTHERS = 2.
IF sy-subrc <> 0 OR lv_base64 IS INITIAL.
  ev_code = 'ENCODING_FAILED'. RETURN.
ENDIF.
" Only fully checked results leave the function; no commit, lock or CTS mutation.
ev_data_bytes = xstrlen( lv_buffer ). CONDENSE ev_data_bytes NO-GAPS.
ev_object_count = lines( lt_objects ). CONDENSE ev_object_count NO-GAPS.
ev_key_count = lines( lt_keys ). CONDENSE ev_key_count NO-GAPS.
ev_string_key_count = lines( lt_string_keys ).
CONDENSE ev_string_key_count NO-GAPS.
ev_system = sy-sysid. ev_client = sy-mandt. ev_user = sy-uname.
ev_request = iv_request. ev_task = iv_task.
ev_cts_version = lv_hash. ev_data_base64 = lv_base64.
ev_code = 'CTS_READ_OK'.
ENDFUNCTION.
