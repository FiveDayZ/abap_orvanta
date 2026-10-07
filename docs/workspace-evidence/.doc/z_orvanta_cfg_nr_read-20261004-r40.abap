DATA: lv_object TYPE tnro-object,
      ls_confirmation TYPE tnro,
      lt_confirmation TYPE STANDARD TABLE OF nriv,
      lv_count TYPE i,
      lv_blob TYPE xstring,
      lv_hash TYPE string.
CLEAR: ev_code, ev_system, ev_client, ev_version, es_definition.
REFRESH et_intervals.
ev_system = sy-sysid.
ev_client = sy-mandt.
IF sy-sysid <> 'GR2' OR sy-mandt <> '200'.
  ev_code = 'SCOPE_UNSUPPORTED'.
  RETURN.
ENDIF.
FIND REGEX '^[ZY][A-Z0-9_]{0,9}$' IN iv_object.
IF sy-subrc <> 0.
  ev_code = 'INPUT_INVALID'.
  RETURN.
ENDIF.
lv_object = iv_object.
AUTHORITY-CHECK OBJECT 'S_NUMBER'
  ID 'NROBJ' FIELD lv_object ID 'ACTVT' FIELD '03'.
IF sy-subrc <> 0.
  ev_code = 'AUTHORIZATION_DENIED'.
  RETURN.
ENDIF.
SELECT SINGLE * INTO es_definition FROM tnro WHERE object = lv_object.
IF sy-subrc <> 0.
  ev_code = 'OBJECT_NOT_FOUND'.
  RETURN.
ENDIF.
SELECT * FROM nriv INTO TABLE et_intervals UP TO 101 ROWS
  WHERE object = lv_object.
DESCRIBE TABLE et_intervals LINES lv_count.
IF lv_count > 100.
  CLEAR es_definition.
  REFRESH et_intervals.
  ev_code = 'INTERVAL_LIMIT_EXCEEDED'.
  RETURN.
ENDIF.
SORT et_intervals BY client object subobject nrrangenr toyear.
SELECT SINGLE * INTO ls_confirmation FROM tnro WHERE object = lv_object.
IF sy-subrc <> 0 OR ls_confirmation <> es_definition.
  ev_code = 'READ_CHANGED'.
ELSE.
  SELECT * FROM nriv INTO TABLE lt_confirmation UP TO 101 ROWS
    WHERE object = lv_object.
  SORT lt_confirmation BY client object subobject nrrangenr toyear.
  IF lt_confirmation[] <> et_intervals[].
    ev_code = 'READ_CHANGED'.
  ENDIF.
ENDIF.
IF ev_code IS NOT INITIAL.
  CLEAR es_definition.
  REFRESH et_intervals.
  RETURN.
ENDIF.
" Version covers the complete definition and all current-client rows.
EXPORT system = sy-sysid client = sy-mandt definition = es_definition
       intervals = et_intervals[] TO DATA BUFFER lv_blob.
CALL FUNCTION 'CALCULATE_HASH_FOR_RAW'
  EXPORTING alg = 'SHA2' data = lv_blob
  IMPORTING hashstring = lv_hash
  EXCEPTIONS unknown_alg = 1 param_error = 2 internal_error = 3
             error_message = 4 OTHERS = 5.
IF sy-subrc <> 0 OR strlen( lv_hash ) <> 64.
  CLEAR es_definition.
  REFRESH et_intervals.
  ev_code = 'HASH_FAILED'.
  RETURN.
ENDIF.
TRANSLATE lv_hash TO LOWER CASE.
IF lv_hash CN '0123456789abcdef'.
  CLEAR es_definition.
  REFRESH et_intervals.
  ev_code = 'HASH_FAILED'.
  RETURN.
ENDIF.
ev_version = lv_hash.
ev_code = 'READ_OK'.
