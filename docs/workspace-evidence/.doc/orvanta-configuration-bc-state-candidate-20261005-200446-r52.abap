FUNCTION Z_ORVANTA_CFG_BC_STATE.
DATA: lv_code TYPE string, lv_system TYPE string,
      lv_client TYPE string, lv_user TYPE string,
      lv_source TYPE string, lv_target TYPE string,
      lv_candidate TYPE string, lv_metadata TYPE string,
      lv_guard TYPE string, lv_cts TYPE string,
      lv_namespace TYPE string, lv_bcset TYPE string,
      lv_layout TYPE string,
      lv_version TYPE string, lv_request TYPE string,
      lv_task TYPE string, lv_hash TYPE string,
      lv_base64 TYPE string, lv_counts TYPE string,
      lv_count TYPE i, lv_pass TYPE i, lv_text TYPE string,
      lv_buffer TYPE xstring, lv_first TYPE xstring,
      lv_roundtrip TYPE xstring.
DATA lt_t006 TYPE STANDARD TABLE OF t006.
DATA lt_t006a TYPE STANDARD TABLE OF t006a.
DATA lt_t006b TYPE STANDARD TABLE OF t006b.
DATA lt_t006c TYPE STANDARD TABLE OF t006c.
DATA lt_t006d TYPE STANDARD TABLE OF t006d.
DATA lt_t006i TYPE STANDARD TABLE OF t006i.
DATA lt_t006j TYPE STANDARD TABLE OF t006j.
DATA lt_t006t TYPE STANDARD TABLE OF t006t.
DATA lt_t006_oib TYPE STANDARD TABLE OF t006_oib.
DATA lc_t006 TYPE STANDARD TABLE OF t006.
DATA lc_t006a TYPE STANDARD TABLE OF t006a.
DATA lc_t006b TYPE STANDARD TABLE OF t006b.
DATA lc_t006c TYPE STANDARD TABLE OF t006c.
DATA lc_t006d TYPE STANDARD TABLE OF t006d.
DATA lr_t006 TYPE STANDARD TABLE OF t006.
DATA lr_t006a TYPE STANDARD TABLE OF t006a.
DATA lr_t006b TYPE STANDARD TABLE OF t006b.
DATA lr_t006c TYPE STANDARD TABLE OF t006c.
DATA lr_t006d TYPE STANDARD TABLE OF t006d.
DATA lr_t006i TYPE STANDARD TABLE OF t006i.
DATA lr_t006j TYPE STANDARD TABLE OF t006j.
DATA lr_t006t TYPE STANDARD TABLE OF t006t.
DATA lr_t006_oib TYPE STANDARD TABLE OF t006_oib.
DATA lr_namespace TYPE string.
DATA lr_system TYPE string.
DATA lr_client TYPE string.
DATA lr_user TYPE string.
DATA lr_bcset TYPE string.
DATA lr_version TYPE string.
DATA lr_request TYPE string.
DATA lr_task TYPE string.
DATA lr_layout TYPE string.
DATA lr_source TYPE string.
DATA lr_target TYPE string.
DATA lr_candidate TYPE string.
DATA lr_metadata TYPE string.
DATA lr_guard TYPE string.
DATA lr_cts TYPE string.
CLEAR: ev_code, ev_system, ev_client, ev_user, ev_request,
  ev_task, ev_source_version, ev_target_version,
  ev_candidate_version, ev_metadata_version, ev_guard_version,
  ev_cts_version, ev_state_version, ev_data_base64,
  ev_data_bytes, ev_row_counts, ev_roundtrip.
IF sy-sysid <> 'GR2' OR sy-mandt <> '200'.
  ev_code = 'SCOPE_UNSUPPORTED'. RETURN.
ENDIF.
IF iv_bc_set <> 'EHS_CUNI_KNM' OR iv_version <> 'N' OR
   iv_request <> 'GR2K923429' OR iv_task <> 'GR2K923430'.
  ev_code = 'INPUT_INVALID'. RETURN.
ENDIF.
IF strlen( iv_source_version ) <> 64 OR
   iv_source_version CN '0123456789abcdef'.
  ev_code = 'INPUT_INVALID'. RETURN.
ENDIF.
IF strlen( iv_target_version ) <> 64 OR
   iv_target_version CN '0123456789abcdef'.
  ev_code = 'INPUT_INVALID'. RETURN.
ENDIF.
IF strlen( iv_candidate_version ) <> 64 OR
   iv_candidate_version CN '0123456789abcdef'.
  ev_code = 'INPUT_INVALID'. RETURN.
ENDIF.
IF strlen( iv_metadata_version ) <> 64 OR
   iv_metadata_version CN '0123456789abcdef'.
  ev_code = 'INPUT_INVALID'. RETURN.
ENDIF.
IF strlen( iv_guard_version ) <> 64 OR
   iv_guard_version CN '0123456789abcdef'.
  ev_code = 'INPUT_INVALID'. RETURN.
ENDIF.
IF strlen( iv_cts_version ) <> 64 OR
   iv_cts_version CN '0123456789abcdef'.
  ev_code = 'INPUT_INVALID'. RETURN.
ENDIF.
" 依赖各自核对读权限与准确键；不接收恢复字节或任意表名。
DO 2 TIMES.
  lv_pass = sy-index.
  CALL FUNCTION 'Z_ORVANTA_CFG_BC_CTS'
    EXPORTING iv_bc_set = iv_bc_set iv_version = iv_version
      iv_request = iv_request iv_task = iv_task
    IMPORTING ev_code = lv_code ev_system = lv_system
      ev_client = lv_client ev_user = lv_user
      ev_cts_version = lv_cts
    EXCEPTIONS error_message = 1 OTHERS = 2.
  IF sy-subrc <> 0.
    ev_code = 'DEPENDENCY_FAILED'. RETURN.
  ENDIF.
  IF lv_code <> 'CTS_READ_OK'.
    ev_code = lv_code. RETURN.
  ENDIF.
  IF lv_system <> sy-sysid OR lv_client <> sy-mandt
  OR lv_user <> sy-uname.
    ev_code = 'BINDING_INVALID'. RETURN.
  ENDIF.
  IF lv_cts <> iv_cts_version.
    ev_code = 'VERSION_CONFLICT'. RETURN.
  ENDIF.
  CALL FUNCTION 'Z_ORVANTA_CFG_BC_READ'
    EXPORTING iv_bc_set = iv_bc_set iv_version = iv_version
    IMPORTING ev_code = lv_code ev_system = lv_system
      ev_client = lv_client ev_user = lv_user
      ev_source_version = lv_source ev_target_version = lv_target
    TABLES
      et_t006 = lt_t006
      et_t006a = lt_t006a
      et_t006b = lt_t006b
      et_t006c = lt_t006c
      et_t006d = lt_t006d
    EXCEPTIONS error_message = 1 OTHERS = 2.
  IF sy-subrc <> 0.
    ev_code = 'DEPENDENCY_FAILED'. RETURN.
  ENDIF.
  IF lv_code <> 'READ_OK'.
    ev_code = lv_code. RETURN.
  ENDIF.
  IF lv_system <> sy-sysid OR lv_client <> sy-mandt
  OR lv_user <> sy-uname.
    ev_code = 'BINDING_INVALID'. RETURN.
  ENDIF.
  IF lv_source <> iv_source_version OR
     lv_target <> iv_target_version.
    ev_code = 'VERSION_CONFLICT'. RETURN.
  ENDIF.
  CALL FUNCTION 'Z_ORVANTA_CFG_BC_PREVIEW'
    EXPORTING iv_bc_set = iv_bc_set iv_version = iv_version
      iv_source_version = iv_source_version
      iv_target_version = iv_target_version
    IMPORTING ev_code = lv_code ev_system = lv_system
      ev_client = lv_client ev_user = lv_user
      ev_source_version = lv_source ev_target_version = lv_target
      ev_candidate_version = lv_candidate
    TABLES
      et_t006 = lc_t006
      et_t006a = lc_t006a
      et_t006b = lc_t006b
      et_t006c = lc_t006c
      et_t006d = lc_t006d
    EXCEPTIONS error_message = 1 OTHERS = 2.
  IF sy-subrc <> 0.
    ev_code = 'DEPENDENCY_FAILED'. RETURN.
  ENDIF.
  IF lv_code <> 'PREVIEW_OK'.
    ev_code = lv_code. RETURN.
  ENDIF.
  IF lv_system <> sy-sysid OR lv_client <> sy-mandt
  OR lv_user <> sy-uname.
    ev_code = 'BINDING_INVALID'. RETURN.
  ENDIF.
  IF lv_source <> iv_source_version OR
     lv_target <> iv_target_version OR
     lv_candidate <> iv_candidate_version.
    ev_code = 'VERSION_CONFLICT'. RETURN.
  ENDIF.
  CALL FUNCTION 'Z_ORVANTA_CFG_BC_GUARD'
    EXPORTING iv_bc_set = iv_bc_set iv_version = iv_version
      iv_source_version = iv_source_version
      iv_target_version = iv_target_version
      iv_metadata_version = iv_metadata_version
    IMPORTING ev_code = lv_code ev_system = lv_system
      ev_client = lv_client ev_user = lv_user
      ev_source_version = lv_source ev_target_version = lv_target
      ev_metadata_version = lv_metadata ev_guard_version = lv_guard
    TABLES
      et_t006i = lt_t006i
      et_t006j = lt_t006j
      et_t006t = lt_t006t
      et_t006_oib = lt_t006_oib
    EXCEPTIONS error_message = 1 OTHERS = 2.
  IF sy-subrc <> 0.
    ev_code = 'DEPENDENCY_FAILED'. RETURN.
  ENDIF.
  IF lv_code <> 'GUARD_READ_OK'.
    ev_code = lv_code. RETURN.
  ENDIF.
  IF lv_system <> sy-sysid OR lv_client <> sy-mandt
  OR lv_user <> sy-uname.
    ev_code = 'BINDING_INVALID'. RETURN.
  ENDIF.
  IF lv_source <> iv_source_version OR
     lv_target <> iv_target_version OR
     lv_metadata <> iv_metadata_version OR
     lv_guard <> iv_guard_version.
    ev_code = 'VERSION_CONFLICT'. RETURN.
  ENDIF.
  CALL FUNCTION 'Z_ORVANTA_CFG_BC_CTS'
    EXPORTING iv_bc_set = iv_bc_set iv_version = iv_version
      iv_request = iv_request iv_task = iv_task
    IMPORTING ev_code = lv_code ev_system = lv_system
      ev_client = lv_client ev_user = lv_user
      ev_cts_version = lv_cts
    EXCEPTIONS error_message = 1 OTHERS = 2.
  IF sy-subrc <> 0.
    ev_code = 'DEPENDENCY_FAILED'. RETURN.
  ENDIF.
  IF lv_code <> 'CTS_READ_OK'.
    ev_code = lv_code. RETURN.
  ENDIF.
  IF lv_system <> sy-sysid OR lv_client <> sy-mandt
  OR lv_user <> sy-uname.
    ev_code = 'BINDING_INVALID'. RETURN.
  ENDIF.
  IF lv_cts <> iv_cts_version.
    ev_code = 'VERSION_CONFLICT'. RETURN.
  ENDIF.
  CLEAR lv_counts.
  DESCRIBE TABLE lt_t006 LINES lv_count.
  IF lv_count > 1.
    ev_code = 'LIMIT_EXCEEDED'. RETURN.
  ENDIF.
  lv_text = lv_count. CONDENSE lv_text NO-GAPS.
  CONCATENATE lv_counts 'T006=' lv_text ';' INTO lv_counts.
  DESCRIBE TABLE lt_t006a LINES lv_count.
  IF lv_count > 3.
    ev_code = 'LIMIT_EXCEEDED'. RETURN.
  ENDIF.
  lv_text = lv_count. CONDENSE lv_text NO-GAPS.
  CONCATENATE lv_counts 'T006A=' lv_text ';' INTO lv_counts.
  DESCRIBE TABLE lt_t006b LINES lv_count.
  IF lv_count > 3.
    ev_code = 'LIMIT_EXCEEDED'. RETURN.
  ENDIF.
  lv_text = lv_count. CONDENSE lv_text NO-GAPS.
  CONCATENATE lv_counts 'T006B=' lv_text ';' INTO lv_counts.
  DESCRIBE TABLE lt_t006c LINES lv_count.
  IF lv_count > 3.
    ev_code = 'LIMIT_EXCEEDED'. RETURN.
  ENDIF.
  lv_text = lv_count. CONDENSE lv_text NO-GAPS.
  CONCATENATE lv_counts 'T006C=' lv_text ';' INTO lv_counts.
  DESCRIBE TABLE lt_t006d LINES lv_count.
  IF lv_count > 1.
    ev_code = 'LIMIT_EXCEEDED'. RETURN.
  ENDIF.
  lv_text = lv_count. CONDENSE lv_text NO-GAPS.
  CONCATENATE lv_counts 'T006D=' lv_text ';' INTO lv_counts.
  DESCRIBE TABLE lt_t006i LINES lv_count.
  IF lv_count > 1.
    ev_code = 'LIMIT_EXCEEDED'. RETURN.
  ENDIF.
  lv_text = lv_count. CONDENSE lv_text NO-GAPS.
  CONCATENATE lv_counts 'T006I=' lv_text ';' INTO lv_counts.
  DESCRIBE TABLE lt_t006j LINES lv_count.
  IF lv_count > 3.
    ev_code = 'LIMIT_EXCEEDED'. RETURN.
  ENDIF.
  lv_text = lv_count. CONDENSE lv_text NO-GAPS.
  CONCATENATE lv_counts 'T006J=' lv_text ';' INTO lv_counts.
  DESCRIBE TABLE lt_t006t LINES lv_count.
  IF lv_count > 3.
    ev_code = 'LIMIT_EXCEEDED'. RETURN.
  ENDIF.
  lv_text = lv_count. CONDENSE lv_text NO-GAPS.
  CONCATENATE lv_counts 'T006T=' lv_text ';' INTO lv_counts.
  DESCRIBE TABLE lt_t006_oib LINES lv_count.
  IF lv_count > 1.
    ev_code = 'LIMIT_EXCEEDED'. RETURN.
  ENDIF.
  lv_text = lv_count. CONDENSE lv_text NO-GAPS.
  CONCATENATE lv_counts 'T006_OIB=' lv_text ';' INTO lv_counts.
  lv_namespace = 'ORVANTA_CUNI_STATE_V1'.
  lv_layout =
    'da348eaef777b1a459779cb49688d39169ebfc8516af05a3baaf8a492b3f77c5'.
  lv_system = sy-sysid. lv_client = sy-mandt. lv_user = sy-uname.
  lv_bcset = iv_bc_set. lv_version = iv_version.
  lv_request = iv_request. lv_task = iv_task.
  lv_source = iv_source_version.
  lv_target = iv_target_version.
  lv_candidate = iv_candidate_version.
  lv_metadata = iv_metadata_version.
  lv_guard = iv_guard_version.
  lv_cts = iv_cts_version.
  EXPORT
    namespace = lv_namespace
    system = lv_system
    client = lv_client
    user = lv_user
    bcset = lv_bcset
    version = lv_version
    request = lv_request
    task = lv_task
    layout = lv_layout
    source = lv_source
    target = lv_target
    candidate = lv_candidate
    metadata = lv_metadata
    guard = lv_guard
    cts = lv_cts
    t006 = lt_t006
    t006a = lt_t006a
    t006b = lt_t006b
    t006c = lt_t006c
    t006d = lt_t006d
    t006i = lt_t006i
    t006j = lt_t006j
    t006t = lt_t006t
    t006_oib = lt_t006_oib
    TO DATA BUFFER lv_buffer.
  IF xstrlen( lv_buffer ) = 0 OR xstrlen( lv_buffer ) > 524288.
    ev_code = 'LIMIT_EXCEEDED'. RETURN.
  ENDIF.
" 内部 IMPORT 后重 EXPORT 比较原字节，保留 F、日期及空行语义。
  TRY.
    IMPORT
      namespace = lr_namespace
      system = lr_system
      client = lr_client
      user = lr_user
      bcset = lr_bcset
      version = lr_version
      request = lr_request
      task = lr_task
      layout = lr_layout
      source = lr_source
      target = lr_target
      candidate = lr_candidate
      metadata = lr_metadata
      guard = lr_guard
      cts = lr_cts
      t006 = lr_t006
      t006a = lr_t006a
      t006b = lr_t006b
      t006c = lr_t006c
      t006d = lr_t006d
      t006i = lr_t006i
      t006j = lr_t006j
      t006t = lr_t006t
      t006_oib = lr_t006_oib
      FROM DATA BUFFER lv_buffer.
    IF sy-subrc <> 0.
      ev_code = 'ROUNDTRIP_FAILED'. RETURN.
    ENDIF.
    EXPORT
      namespace = lr_namespace
      system = lr_system
      client = lr_client
      user = lr_user
      bcset = lr_bcset
      version = lr_version
      request = lr_request
      task = lr_task
      layout = lr_layout
      source = lr_source
      target = lr_target
      candidate = lr_candidate
      metadata = lr_metadata
      guard = lr_guard
      cts = lr_cts
      t006 = lr_t006
      t006a = lr_t006a
      t006b = lr_t006b
      t006c = lr_t006c
      t006d = lr_t006d
      t006i = lr_t006i
      t006j = lr_t006j
      t006t = lr_t006t
      t006_oib = lr_t006_oib
      TO DATA BUFFER lv_roundtrip.
  CATCH cx_root.
    ev_code = 'ROUNDTRIP_FAILED'. RETURN.
  ENDTRY.
  IF lv_roundtrip <> lv_buffer.
    ev_code = 'ROUNDTRIP_FAILED'. RETURN.
  ENDIF.
  IF lv_pass = 1.
    lv_first = lv_buffer.
  ELSEIF lv_buffer <> lv_first.
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
" 所有输出只在成功后填充；不加锁、不提交、不改配置或传输。
ev_system = sy-sysid. ev_client = sy-mandt. ev_user = sy-uname.
ev_request = iv_request. ev_task = iv_task.
ev_source_version = iv_source_version.
ev_target_version = iv_target_version.
ev_candidate_version = iv_candidate_version.
ev_metadata_version = iv_metadata_version.
ev_guard_version = iv_guard_version.
ev_cts_version = iv_cts_version.
ev_data_bytes = xstrlen( lv_buffer ).
CONDENSE ev_data_bytes NO-GAPS.
ev_data_base64 = lv_base64. ev_state_version = lv_hash.
ev_row_counts = lv_counts. ev_roundtrip = 'X'.
ev_code = 'STATE_READ_OK'.
ENDFUNCTION.
