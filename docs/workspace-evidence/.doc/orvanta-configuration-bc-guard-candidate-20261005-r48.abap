FUNCTION Z_ORVANTA_CFG_BC_GUARD.
DATA: lt_t006i TYPE STANDARD TABLE OF t006i,
      lt_t006j TYPE STANDARD TABLE OF t006j,
      lt_t006t TYPE STANDARD TABLE OF t006t,
      lt_t006_oib TYPE STANDARD TABLE OF t006_oib,
      lt_objh TYPE STANDARD TABLE OF objh,
      lt_objs TYPE STANDARD TABLE OF objs,
      lt_objm TYPE STANDARD TABLE OF objm,
      lv_table TYPE tddat-tabname, lv_group TYPE tddat-cclass,
      lv_code TYPE string, lv_system TYPE string,
      lv_client TYPE string, lv_user TYPE string,
      lv_source TYPE string, lv_target TYPE string,
      lv_metadata TYPE string, lv_hash TYPE string,
      lv_buffer TYPE xstring, lv_first TYPE xstring,
      lv_pass TYPE i, lv_count TYPE i.
" 固定八个关联键，只读完整行；失败不输出前次调用数据。
CLEAR: ev_code, ev_system, ev_client, ev_user,
  ev_source_version, ev_target_version, ev_metadata_version,
  ev_guard_version.
REFRESH: et_t006i, et_t006j, et_t006t, et_t006_oib.
ev_system = sy-sysid.
ev_client = sy-mandt.
ev_user = sy-uname.
IF sy-sysid <> 'GR2' OR sy-mandt <> '200'.
  ev_code = 'SCOPE_UNSUPPORTED'.
  RETURN.
ENDIF.
IF iv_bc_set <> 'EHS_CUNI_KNM' OR iv_version <> 'N'
OR strlen( iv_source_version ) <> 64
OR iv_source_version CN '0123456789abcdef'
OR strlen( iv_target_version ) <> 64
OR iv_target_version CN '0123456789abcdef'
OR strlen( iv_metadata_version ) <> 64
OR iv_metadata_version CN '0123456789abcdef'.
  ev_code = 'INPUT_INVALID'.
  RETURN.
ENDIF.
IF iv_source_version <>
  '73783f69f1bf9805b058fbc9bab0adb8cc8047f85c837ee16c174a9edd0f512b'.
  ev_code = 'SOURCE_NOT_ATTESTED'.
  RETURN.
ENDIF.
" CLIENT/LANGU 与 MANDT/SPRAS 是不同实际键，不统一猜字段名。
DO 4 TIMES.
  CASE sy-index.
    WHEN 1. lv_table = 'T006I'.
    WHEN 2. lv_table = 'T006J'.
    WHEN 3. lv_table = 'T006T'.
    WHEN 4. lv_table = 'T006_OIB'.
  ENDCASE.
  CLEAR lv_group.
  SELECT SINGLE cclass INTO lv_group FROM tddat
    WHERE tabname = lv_table.
  IF sy-subrc <> 0 OR lv_group IS INITIAL.
    lv_group = '&NC&'.
  ENDIF.
  AUTHORITY-CHECK OBJECT 'S_TABU_DIS'
    ID 'ACTVT' FIELD '03' ID 'DICBERCLS' FIELD lv_group.
  IF sy-subrc <> 0.
    AUTHORITY-CHECK OBJECT 'S_TABU_NAM'
      ID 'ACTVT' FIELD '03' ID 'TABLE' FIELD lv_table.
    IF sy-subrc <> 0.
      ev_code = 'AUTHORIZATION_DENIED'.
      RETURN.
    ENDIF.
  ENDIF.
ENDDO.
" 三次绑定五表和路线，之间双读关联行；仍不是加锁快照。
DO 3 TIMES.
  lv_pass = sy-index.
  CALL FUNCTION 'Z_ORVANTA_CFG_BC_ROUTE'
    EXPORTING iv_bc_set = iv_bc_set iv_version = iv_version
      iv_source_version = iv_source_version
      iv_target_version = iv_target_version
    IMPORTING ev_code = lv_code ev_system = lv_system
      ev_client = lv_client ev_user = lv_user
      ev_source_version = lv_source ev_target_version = lv_target
      ev_metadata_version = lv_metadata
    TABLES et_objh = lt_objh et_objs = lt_objs et_objm = lt_objm
    EXCEPTIONS error_message = 1 OTHERS = 2.
  IF sy-subrc <> 0.
    ev_code = 'ROUTE_READ_FAILED'.
    RETURN.
  ENDIF.
  IF lv_code <> 'ROUTE_READ_OK'.
    ev_code = lv_code.
    RETURN.
  ENDIF.
  IF lv_system <> sy-sysid OR lv_client <> sy-mandt
  OR lv_user <> sy-uname OR lv_source <> iv_source_version
  OR lv_target <> iv_target_version
  OR lv_metadata <> iv_metadata_version.
    ev_code = 'VERSION_CONFLICT'.
    RETURN.
  ENDIF.
  DESCRIBE TABLE lt_objm LINES lv_count.
  IF lv_count <> 0.
    ev_code = 'ROUTE_SCOPE_UNSUPPORTED'.
    RETURN.
  ENDIF.
  DESCRIBE TABLE lt_objs LINES lv_count.
  IF lv_count <> 9.
    ev_code = 'ROUTE_SCOPE_UNSUPPORTED'.
    RETURN.
  ENDIF.
  DO 9 TIMES.
    CASE sy-index.
      WHEN 1. lv_table = 'T006'.
      WHEN 2. lv_table = 'T006A'.
      WHEN 3. lv_table = 'T006B'.
      WHEN 4. lv_table = 'T006C'.
      WHEN 5. lv_table = 'T006D'.
      WHEN 6. lv_table = 'T006I'.
      WHEN 7. lv_table = 'T006J'.
      WHEN 8. lv_table = 'T006T'.
      WHEN 9. lv_table = 'T006_OIB'.
    ENDCASE.
    READ TABLE lt_objs WITH KEY objectname = 'CUNI'
      objecttype = 'T' tabname = lv_table TRANSPORTING NO FIELDS.
    IF sy-subrc <> 0.
      ev_code = 'ROUTE_SCOPE_UNSUPPORTED'.
      RETURN.
    ENDIF.
  ENDDO.
  IF lv_pass = 3.
    EXIT.
  ENDIF.
" 缺失允许，但数量、键和完整字段必须有界且保留原生值。
  TRY.
    SELECT * FROM t006i INTO TABLE lt_t006i UP TO 2 ROWS
      WHERE client = sy-mandt AND isocode = 'KPA'.
    IF sy-subrc <> 0 AND sy-subrc <> 4.
      ev_code = 'READ_FAILED'.
      RETURN.
    ENDIF.
    SELECT * FROM t006j INTO TABLE lt_t006j UP TO 4 ROWS
      WHERE client = sy-mandt AND isocode = 'KPA'
      AND ( langu = '1' OR langu = 'D' OR langu = 'E' ).
    IF sy-subrc <> 0 AND sy-subrc <> 4.
      ev_code = 'READ_FAILED'.
      RETURN.
    ENDIF.
    SELECT * FROM t006t INTO TABLE lt_t006t UP TO 4 ROWS
      WHERE mandt = sy-mandt AND dimid = 'PRESS'
      AND ( spras = '1' OR spras = 'D' OR spras = 'E' ).
    IF sy-subrc <> 0 AND sy-subrc <> 4.
      ev_code = 'READ_FAILED'.
      RETURN.
    ENDIF.
    SELECT * FROM t006_oib INTO TABLE lt_t006_oib UP TO 2 ROWS
      WHERE mandt = sy-mandt AND msehi = 'KNM'.
    IF sy-subrc <> 0 AND sy-subrc <> 4.
      ev_code = 'READ_FAILED'.
      RETURN.
    ENDIF.
  CATCH cx_sy_open_sql_db.
    ev_code = 'READ_FAILED'.
    RETURN.
  ENDTRY.
  DESCRIBE TABLE lt_t006i LINES lv_count.
  IF lv_count > 1.
    ev_code = 'PROTECTION_LIMIT'.
    RETURN.
  ENDIF.
  DESCRIBE TABLE lt_t006j LINES lv_count.
  IF lv_count > 3.
    ev_code = 'PROTECTION_LIMIT'.
    RETURN.
  ENDIF.
  DESCRIBE TABLE lt_t006t LINES lv_count.
  IF lv_count > 3.
    ev_code = 'PROTECTION_LIMIT'.
    RETURN.
  ENDIF.
  DESCRIBE TABLE lt_t006_oib LINES lv_count.
  IF lv_count > 1.
    ev_code = 'PROTECTION_LIMIT'.
    RETURN.
  ENDIF.
  SORT lt_t006i BY client isocode.
  SORT lt_t006j BY client langu isocode.
  SORT lt_t006t BY mandt spras dimid.
  SORT lt_t006_oib BY mandt msehi.
  EXPORT namespace = 'ORVANTA_CUNI_GUARD_V1'
    system = sy-sysid client = sy-mandt user = sy-uname
    bcset = iv_bc_set version = iv_version
    source = lv_source target = lv_target metadata = lv_metadata
    iso = lt_t006i isotext = lt_t006j
    dimtext = lt_t006t industry = lt_t006_oib
    TO DATA BUFFER lv_buffer.
  IF lv_pass = 1.
    lv_first = lv_buffer.
  ELSEIF lv_buffer <> lv_first.
    ev_code = 'PROTECTION_CHANGED'.
    RETURN.
  ENDIF.
ENDDO.
" 全部拒绝和重复观察完成后才填充输出，空表代表已核对缺失。
CALL FUNCTION 'CALCULATE_HASH_FOR_RAW'
  EXPORTING alg = 'SHA2' data = lv_buffer
  IMPORTING hashstring = lv_hash
  EXCEPTIONS unknown_alg = 1 param_error = 2 internal_error = 3
    error_message = 4 OTHERS = 5.
IF sy-subrc <> 0.
  ev_code = 'HASH_FAILED'.
  RETURN.
ENDIF.
TRANSLATE lv_hash TO LOWER CASE.
IF strlen( lv_hash ) <> 64 OR lv_hash CN '0123456789abcdef'.
  ev_code = 'HASH_FAILED'.
  RETURN.
ENDIF.
et_t006i[] = lt_t006i[].
et_t006j[] = lt_t006j[].
et_t006t[] = lt_t006t[].
et_t006_oib[] = lt_t006_oib[].
ev_source_version = lv_source.
ev_target_version = lv_target.
ev_metadata_version = lv_metadata.
ev_guard_version = lv_hash.
ev_code = 'GUARD_READ_OK'.
ENDFUNCTION.
