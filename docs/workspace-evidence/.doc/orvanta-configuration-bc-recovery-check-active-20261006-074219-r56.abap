FUNCTION Z_ORVANTA_CFG_BC_RCHECK
  IMPORTING
    VALUE(IV_BC_SET) TYPE STRING
    VALUE(IV_VERSION) TYPE STRING
    VALUE(IV_REQUEST) TYPE STRING
    VALUE(IV_TASK) TYPE STRING
    VALUE(IV_SOURCE_VERSION) TYPE STRING
    VALUE(IV_TARGET_VERSION) TYPE STRING
    VALUE(IV_CANDIDATE_VERSION) TYPE STRING
    VALUE(IV_METADATA_VERSION) TYPE STRING
    VALUE(IV_GUARD_VERSION) TYPE STRING
    VALUE(IV_CTS_VERSION) TYPE STRING
    VALUE(IV_STATE_VERSION) TYPE STRING
    VALUE(IV_DATA_BASE64) TYPE STRING
  EXPORTING
    VALUE(EV_CODE) TYPE STRING
    VALUE(EV_SYSTEM) TYPE STRING
    VALUE(EV_CLIENT) TYPE STRING
    VALUE(EV_USER) TYPE STRING
    VALUE(EV_STATE_VERSION) TYPE STRING
    VALUE(EV_LAYOUT_VERSION) TYPE STRING
    VALUE(EV_ROW_COUNTS) TYPE STRING
    VALUE(EV_ROW_PROOFS) TYPE STRING
    VALUE(EV_PROOF_BASE64) TYPE STRING
    VALUE(EV_PROOF_VERSION) TYPE STRING
    VALUE(EV_ROUNDTRIP) TYPE STRING.



TYPE-POOLS scpr.
" 只检查可信原生前态的恢复值转换，不维护记录或传输。
DATA: lv_buffer TYPE xstring, lv_roundtrip TYPE xstring,
      lv_before TYPE xstring, lv_after TYPE xstring,
      lv_proof TYPE xstring, lv_hash TYPE string,
      lv_before_hash TYPE string, lv_after_hash TYPE string,
      lv_base64 TYPE string, lv_rows TYPE string,
      lv_counts TYPE string, lv_text TYPE string,
      lv_tabletext TYPE string,
      lv_names TYPE string, lv_expected TYPE string,
      lv_table TYPE tddat-tabname, lv_group TYPE tddat-cclass,
      lv_index TYPE i, lv_present TYPE c, lv_only_key TYPE c,
      lv_type TYPE c, lv_len TYPE i, lv_fields TYPE i,
      lv_keys TYPE i, lv_keylen TYPE i,
      lv_external TYPE scprvals-value,
      ls_field TYPE scpr_flddescr, lt_fields TYPE scpr_flddescrs,
      ls_value TYPE scprvals, lt_values TYPE scpr_vals_tab,
      lr_row TYPE REF TO data, lr_copy TYPE REF TO data.
FIELD-SYMBOLS: <row> TYPE any, <copy> TYPE any,
               <value> TYPE any.
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
DATA lt_t006 TYPE STANDARD TABLE OF t006.
DATA ls_t006 TYPE t006.
DATA lc_t006 TYPE t006.
DATA lv_t006 TYPE i.
DATA lt_t006a TYPE STANDARD TABLE OF t006a.
DATA ls_t006a TYPE t006a.
DATA lc_t006a TYPE t006a.
DATA lv_t006a TYPE i.
DATA lt_t006b TYPE STANDARD TABLE OF t006b.
DATA ls_t006b TYPE t006b.
DATA lc_t006b TYPE t006b.
DATA lv_t006b TYPE i.
DATA lt_t006c TYPE STANDARD TABLE OF t006c.
DATA ls_t006c TYPE t006c.
DATA lc_t006c TYPE t006c.
DATA lv_t006c TYPE i.
DATA lt_t006d TYPE STANDARD TABLE OF t006d.
DATA ls_t006d TYPE t006d.
DATA lc_t006d TYPE t006d.
DATA lv_t006d TYPE i.
DATA lt_t006i TYPE STANDARD TABLE OF t006i.
DATA ls_t006i TYPE t006i.
DATA lc_t006i TYPE t006i.
DATA lv_t006i TYPE i.
DATA lt_t006j TYPE STANDARD TABLE OF t006j.
DATA ls_t006j TYPE t006j.
DATA lc_t006j TYPE t006j.
DATA lv_t006j TYPE i.
DATA lt_t006t TYPE STANDARD TABLE OF t006t.
DATA ls_t006t TYPE t006t.
DATA lc_t006t TYPE t006t.
DATA lv_t006t TYPE i.
DATA lt_t006_oib TYPE STANDARD TABLE OF t006_oib.
DATA ls_t006_oib TYPE t006_oib.
DATA lc_t006_oib TYPE t006_oib.
DATA lv_t006_oib TYPE i.
CLEAR: ev_code, ev_system, ev_client, ev_user,
  ev_state_version, ev_layout_version, ev_row_counts,
  ev_row_proofs, ev_proof_base64, ev_proof_version, ev_roundtrip.
IF sy-sysid <> 'GR2' OR sy-mandt <> '200'.
  ev_code = 'SCOPE_UNSUPPORTED'. RETURN.
ENDIF.
IF iv_bc_set <> 'EHS_CUNI_KNM' OR iv_version <> 'N'
OR iv_request <> 'GR2K923429' OR iv_task <> 'GR2K923430'
OR strlen( iv_data_base64 ) < 4
OR strlen( iv_data_base64 ) > 699052.
  ev_code = 'INPUT_INVALID'. RETURN.
ENDIF.
IF strlen( iv_source_version ) <> 64
OR iv_source_version CN '0123456789abcdef'.
  ev_code = 'INPUT_INVALID'. RETURN.
ENDIF.
IF strlen( iv_target_version ) <> 64
OR iv_target_version CN '0123456789abcdef'.
  ev_code = 'INPUT_INVALID'. RETURN.
ENDIF.
IF strlen( iv_candidate_version ) <> 64
OR iv_candidate_version CN '0123456789abcdef'.
  ev_code = 'INPUT_INVALID'. RETURN.
ENDIF.
IF strlen( iv_metadata_version ) <> 64
OR iv_metadata_version CN '0123456789abcdef'.
  ev_code = 'INPUT_INVALID'. RETURN.
ENDIF.
IF strlen( iv_guard_version ) <> 64
OR iv_guard_version CN '0123456789abcdef'.
  ev_code = 'INPUT_INVALID'. RETURN.
ENDIF.
IF strlen( iv_cts_version ) <> 64
OR iv_cts_version CN '0123456789abcdef'.
  ev_code = 'INPUT_INVALID'. RETURN.
ENDIF.
IF strlen( iv_state_version ) <> 64
OR iv_state_version CN '0123456789abcdef'.
  ev_code = 'INPUT_INVALID'. RETURN.
ENDIF.
" 即使缓冲来自本地回执，也重新检查认证用户的九表读权限。
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
      ev_code = 'AUTHORIZATION_DENIED'. RETURN.
    ENDIF.
  ENDIF.
ENDDO.
CALL FUNCTION 'SCMS_BASE64_DECODE_STR'
  EXPORTING input = iv_data_base64 unescape = space
  IMPORTING output = lv_buffer
  EXCEPTIONS failed = 1 error_message = 2 OTHERS = 3.
IF sy-subrc <> 0 OR xstrlen( lv_buffer ) = 0
OR xstrlen( lv_buffer ) > 524288.
  ev_code = 'BUFFER_INVALID'. RETURN.
ENDIF.
CALL FUNCTION 'SCMS_BASE64_ENCODE_STR'
  EXPORTING input = lv_buffer IMPORTING output = lv_base64
  EXCEPTIONS error_message = 1 OTHERS = 2.
IF sy-subrc <> 0 OR lv_base64 <> iv_data_base64.
  ev_code = 'BUFFER_INVALID'. RETURN.
ENDIF.
  CALL FUNCTION 'CALCULATE_HASH_FOR_RAW'
    EXPORTING alg = 'SHA2' data = lv_buffer
    IMPORTING hashstring = lv_hash
    EXCEPTIONS unknown_alg = 1 param_error = 2 internal_error = 3
      error_message = 4 OTHERS = 5.
  IF sy-subrc <> 0.
    ev_code = 'HASH_FAILED'. RETURN.
  ENDIF.
  TRANSLATE lv_hash TO LOWER CASE.
  IF strlen( lv_hash ) <> 64
  OR lv_hash CN '0123456789abcdef'.
    ev_code = 'HASH_FAILED'. RETURN.
  ENDIF.
IF lv_hash <> iv_state_version.
  ev_code = 'BUFFER_INVALID'. RETURN.
ENDIF.
" 按 STATE 同一类型导入并重导出，拒绝错布局或缺失成员。
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
    t006 = lt_t006
    t006a = lt_t006a
    t006b = lt_t006b
    t006c = lt_t006c
    t006d = lt_t006d
    t006i = lt_t006i
    t006j = lt_t006j
    t006t = lt_t006t
    t006_oib = lt_t006_oib
    FROM DATA BUFFER lv_buffer.
  IF sy-subrc <> 0.
    ev_code = 'BUFFER_INVALID'. RETURN.
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
    t006 = lt_t006
    t006a = lt_t006a
    t006b = lt_t006b
    t006c = lt_t006c
    t006d = lt_t006d
    t006i = lt_t006i
    t006j = lt_t006j
    t006t = lt_t006t
    t006_oib = lt_t006_oib
    TO DATA BUFFER lv_roundtrip.
CATCH cx_root.
  ev_code = 'BUFFER_INVALID'. RETURN.
ENDTRY.
IF lv_roundtrip <> lv_buffer.
  ev_code = 'BUFFER_INVALID'. RETURN.
ENDIF.
IF lr_namespace <> 'ORVANTA_CUNI_STATE_V1'
OR lr_system <> sy-sysid OR lr_client <> sy-mandt
OR lr_user <> sy-uname OR lr_bcset <> iv_bc_set
OR lr_version <> iv_version OR lr_request <> iv_request
OR lr_task <> iv_task OR lr_layout <>
  'da348eaef777b1a459779cb49688d39169ebfc8516af05a3baaf8a492b3f77c5'.
  ev_code = 'BINDING_INVALID'. RETURN.
ENDIF.
IF lr_source <> iv_source_version.
  ev_code = 'BINDING_INVALID'. RETURN.
ENDIF.
IF lr_target <> iv_target_version.
  ev_code = 'BINDING_INVALID'. RETURN.
ENDIF.
IF lr_candidate <> iv_candidate_version.
  ev_code = 'BINDING_INVALID'. RETURN.
ENDIF.
IF lr_metadata <> iv_metadata_version.
  ev_code = 'BINDING_INVALID'. RETURN.
ENDIF.
IF lr_guard <> iv_guard_version.
  ev_code = 'BINDING_INVALID'. RETURN.
ENDIF.
IF lr_cts <> iv_cts_version.
  ev_code = 'BINDING_INVALID'. RETURN.
ENDIF.
DESCRIBE TABLE lt_t006 LINES lv_len.
IF lv_len > 1.
  ev_code = 'ROW_SCOPE_INVALID'. RETURN.
ENDIF.
DESCRIBE TABLE lt_t006a LINES lv_len.
IF lv_len > 3.
  ev_code = 'ROW_SCOPE_INVALID'. RETURN.
ENDIF.
DESCRIBE TABLE lt_t006b LINES lv_len.
IF lv_len > 3.
  ev_code = 'ROW_SCOPE_INVALID'. RETURN.
ENDIF.
DESCRIBE TABLE lt_t006c LINES lv_len.
IF lv_len > 3.
  ev_code = 'ROW_SCOPE_INVALID'. RETURN.
ENDIF.
DESCRIBE TABLE lt_t006d LINES lv_len.
IF lv_len > 1.
  ev_code = 'ROW_SCOPE_INVALID'. RETURN.
ENDIF.
DESCRIBE TABLE lt_t006i LINES lv_len.
IF lv_len > 1.
  ev_code = 'ROW_SCOPE_INVALID'. RETURN.
ENDIF.
DESCRIBE TABLE lt_t006j LINES lv_len.
IF lv_len > 3.
  ev_code = 'ROW_SCOPE_INVALID'. RETURN.
ENDIF.
DESCRIBE TABLE lt_t006t LINES lv_len.
IF lv_len > 3.
  ev_code = 'ROW_SCOPE_INVALID'. RETURN.
ENDIF.
DESCRIBE TABLE lt_t006_oib LINES lv_len.
IF lv_len > 1.
  ev_code = 'ROW_SCOPE_INVALID'. RETURN.
ENDIF.
DO 19 TIMES.
  lv_index = sy-index.
  CLEAR: lv_present, lv_only_key.
  CASE lv_index.
    WHEN 1.
      lv_table = 'T006'.
      CONCATENATE
        'MANDT,MSEHI,KZEX3,KZEX6,ANDEC,KZKEH,KZWO'
        'B,KZ1EH,KZ2EH,DIMID,ZAEHL,NENNR,EXP10,AD'
        'DKO,EXPON,DECAN,ISOCODE,PRIMARY,TEMP_VAL'
        'UE,TEMP_UNIT,FAMUNIT,PRESS_VAL,PRESS_UNI'
        'T'
        INTO lv_expected.
      CLEAR: ls_t006, lc_t006.
      READ TABLE lt_t006 INTO ls_t006 WITH KEY
        mandt = '200'
        msehi = 'KNM'
        .
      IF sy-subrc = 0.
        ADD 1 TO lv_t006. lv_present = 'X'.
      ELSE.
        ls_t006-mandt = '200'.
        ls_t006-msehi = 'KNM'.
      ENDIF.
      GET REFERENCE OF ls_t006 INTO lr_row.
      GET REFERENCE OF lc_t006 INTO lr_copy.
    WHEN 2.
      lv_table = 'T006A'.
      CONCATENATE
        'MANDT,SPRAS,MSEHI,MSEH3,MSEH6,MSEHT,MSEH'
        'L'
        INTO lv_expected.
      CLEAR: ls_t006a, lc_t006a.
      READ TABLE lt_t006a INTO ls_t006a WITH KEY
        mandt = '200'
        spras = '1'
        msehi = 'KNM'
        .
      IF sy-subrc = 0.
        ADD 1 TO lv_t006a. lv_present = 'X'.
      ELSE.
        ls_t006a-mandt = '200'.
        ls_t006a-spras = '1'.
        ls_t006a-msehi = 'KNM'.
      ENDIF.
      GET REFERENCE OF ls_t006a INTO lr_row.
      GET REFERENCE OF lc_t006a INTO lr_copy.
    WHEN 3.
      lv_table = 'T006A'.
      CONCATENATE
        'MANDT,SPRAS,MSEHI,MSEH3,MSEH6,MSEHT,MSEH'
        'L'
        INTO lv_expected.
      CLEAR: ls_t006a, lc_t006a.
      READ TABLE lt_t006a INTO ls_t006a WITH KEY
        mandt = '200'
        spras = 'D'
        msehi = 'KNM'
        .
      IF sy-subrc = 0.
        ADD 1 TO lv_t006a. lv_present = 'X'.
      ELSE.
        ls_t006a-mandt = '200'.
        ls_t006a-spras = 'D'.
        ls_t006a-msehi = 'KNM'.
      ENDIF.
      GET REFERENCE OF ls_t006a INTO lr_row.
      GET REFERENCE OF lc_t006a INTO lr_copy.
    WHEN 4.
      lv_table = 'T006A'.
      CONCATENATE
        'MANDT,SPRAS,MSEHI,MSEH3,MSEH6,MSEHT,MSEH'
        'L'
        INTO lv_expected.
      CLEAR: ls_t006a, lc_t006a.
      READ TABLE lt_t006a INTO ls_t006a WITH KEY
        mandt = '200'
        spras = 'E'
        msehi = 'KNM'
        .
      IF sy-subrc = 0.
        ADD 1 TO lv_t006a. lv_present = 'X'.
      ELSE.
        ls_t006a-mandt = '200'.
        ls_t006a-spras = 'E'.
        ls_t006a-msehi = 'KNM'.
      ENDIF.
      GET REFERENCE OF ls_t006a INTO lr_row.
      GET REFERENCE OF lc_t006a INTO lr_copy.
    WHEN 5.
      lv_table = 'T006B'.
      CONCATENATE
        'MANDT,SPRAS,MSEH3,MSEHI'
        INTO lv_expected.
      CLEAR: ls_t006b, lc_t006b.
      READ TABLE lt_t006b INTO ls_t006b WITH KEY
        mandt = '200'
        spras = '1'
        mseh3 = 'KNM'
        .
      IF sy-subrc = 0.
        ADD 1 TO lv_t006b. lv_present = 'X'.
      ELSE.
        ls_t006b-mandt = '200'.
        ls_t006b-spras = '1'.
        ls_t006b-mseh3 = 'KNM'.
      ENDIF.
      GET REFERENCE OF ls_t006b INTO lr_row.
      GET REFERENCE OF lc_t006b INTO lr_copy.
    WHEN 6.
      lv_table = 'T006B'.
      CONCATENATE
        'MANDT,SPRAS,MSEH3,MSEHI'
        INTO lv_expected.
      CLEAR: ls_t006b, lc_t006b.
      READ TABLE lt_t006b INTO ls_t006b WITH KEY
        mandt = '200'
        spras = 'D'
        mseh3 = 'KNM'
        .
      IF sy-subrc = 0.
        ADD 1 TO lv_t006b. lv_present = 'X'.
      ELSE.
        ls_t006b-mandt = '200'.
        ls_t006b-spras = 'D'.
        ls_t006b-mseh3 = 'KNM'.
      ENDIF.
      GET REFERENCE OF ls_t006b INTO lr_row.
      GET REFERENCE OF lc_t006b INTO lr_copy.
    WHEN 7.
      lv_table = 'T006B'.
      CONCATENATE
        'MANDT,SPRAS,MSEH3,MSEHI'
        INTO lv_expected.
      CLEAR: ls_t006b, lc_t006b.
      READ TABLE lt_t006b INTO ls_t006b WITH KEY
        mandt = '200'
        spras = 'E'
        mseh3 = 'KNM'
        .
      IF sy-subrc = 0.
        ADD 1 TO lv_t006b. lv_present = 'X'.
      ELSE.
        ls_t006b-mandt = '200'.
        ls_t006b-spras = 'E'.
        ls_t006b-mseh3 = 'KNM'.
      ENDIF.
      GET REFERENCE OF ls_t006b INTO lr_row.
      GET REFERENCE OF lc_t006b INTO lr_copy.
    WHEN 8.
      lv_table = 'T006C'.
      CONCATENATE
        'MANDT,SPRAS,MSEH6,MSEHI'
        INTO lv_expected.
      CLEAR: ls_t006c, lc_t006c.
      READ TABLE lt_t006c INTO ls_t006c WITH KEY
        mandt = '200'
        spras = '1'
        mseh6 = 'kN/m2'
        .
      IF sy-subrc = 0.
        ADD 1 TO lv_t006c. lv_present = 'X'.
      ELSE.
        ls_t006c-mandt = '200'.
        ls_t006c-spras = '1'.
        ls_t006c-mseh6 = 'kN/m2'.
      ENDIF.
      GET REFERENCE OF ls_t006c INTO lr_row.
      GET REFERENCE OF lc_t006c INTO lr_copy.
    WHEN 9.
      lv_table = 'T006C'.
      CONCATENATE
        'MANDT,SPRAS,MSEH6,MSEHI'
        INTO lv_expected.
      CLEAR: ls_t006c, lc_t006c.
      READ TABLE lt_t006c INTO ls_t006c WITH KEY
        mandt = '200'
        spras = 'D'
        mseh6 = 'kN/m2'
        .
      IF sy-subrc = 0.
        ADD 1 TO lv_t006c. lv_present = 'X'.
      ELSE.
        ls_t006c-mandt = '200'.
        ls_t006c-spras = 'D'.
        ls_t006c-mseh6 = 'kN/m2'.
      ENDIF.
      GET REFERENCE OF ls_t006c INTO lr_row.
      GET REFERENCE OF lc_t006c INTO lr_copy.
    WHEN 10.
      lv_table = 'T006C'.
      CONCATENATE
        'MANDT,SPRAS,MSEH6,MSEHI'
        INTO lv_expected.
      CLEAR: ls_t006c, lc_t006c.
      READ TABLE lt_t006c INTO ls_t006c WITH KEY
        mandt = '200'
        spras = 'E'
        mseh6 = 'kN/m2'
        .
      IF sy-subrc = 0.
        ADD 1 TO lv_t006c. lv_present = 'X'.
      ELSE.
        ls_t006c-mandt = '200'.
        ls_t006c-spras = 'E'.
        ls_t006c-mseh6 = 'kN/m2'.
      ENDIF.
      GET REFERENCE OF ls_t006c INTO lr_row.
      GET REFERENCE OF lc_t006c INTO lr_copy.
    WHEN 11.
      lv_table = 'T006D'.
      CONCATENATE
        'MANDT,DIMID,LENG,MASS,TIMEX,ECURR,TEMP,M'
        'OLQU,LIGHT,MSSIE,TEMP_DEP,PRESS_DEP'
        INTO lv_expected.
      CLEAR: ls_t006d, lc_t006d.
      READ TABLE lt_t006d INTO ls_t006d WITH KEY
        mandt = '200'
        dimid = 'PRESS'
        .
      IF sy-subrc = 0.
        ADD 1 TO lv_t006d. lv_present = 'X'.
      ELSE.
        ls_t006d-mandt = '200'.
        ls_t006d-dimid = 'PRESS'.
      ENDIF.
      GET REFERENCE OF ls_t006d INTO lr_row.
      GET REFERENCE OF lc_t006d INTO lr_copy.
    WHEN 12.
      lv_table = 'T006I'.
      CONCATENATE
        'CLIENT,ISOCODE'
        INTO lv_expected.
      CLEAR: ls_t006i, lc_t006i.
      READ TABLE lt_t006i INTO ls_t006i WITH KEY
        client = '200'
        isocode = 'KPA'
        .
      IF sy-subrc = 0.
        ADD 1 TO lv_t006i. lv_present = 'X'.
      ELSE.
        ls_t006i-client = '200'.
        ls_t006i-isocode = 'KPA'.
      ENDIF.
      GET REFERENCE OF ls_t006i INTO lr_row.
      GET REFERENCE OF lc_t006i INTO lr_copy.
    WHEN 13.
      lv_table = 'T006J'.
      CONCATENATE
        'CLIENT,LANGU,ISOCODE,ISOTXT'
        INTO lv_expected.
      CLEAR: ls_t006j, lc_t006j.
      READ TABLE lt_t006j INTO ls_t006j WITH KEY
        client = '200'
        langu = '1'
        isocode = 'KPA'
        .
      IF sy-subrc = 0.
        ADD 1 TO lv_t006j. lv_present = 'X'.
      ELSE.
        ls_t006j-client = '200'.
        ls_t006j-langu = '1'.
        ls_t006j-isocode = 'KPA'.
      ENDIF.
      GET REFERENCE OF ls_t006j INTO lr_row.
      GET REFERENCE OF lc_t006j INTO lr_copy.
    WHEN 14.
      lv_table = 'T006J'.
      CONCATENATE
        'CLIENT,LANGU,ISOCODE,ISOTXT'
        INTO lv_expected.
      CLEAR: ls_t006j, lc_t006j.
      READ TABLE lt_t006j INTO ls_t006j WITH KEY
        client = '200'
        langu = 'D'
        isocode = 'KPA'
        .
      IF sy-subrc = 0.
        ADD 1 TO lv_t006j. lv_present = 'X'.
      ELSE.
        ls_t006j-client = '200'.
        ls_t006j-langu = 'D'.
        ls_t006j-isocode = 'KPA'.
      ENDIF.
      GET REFERENCE OF ls_t006j INTO lr_row.
      GET REFERENCE OF lc_t006j INTO lr_copy.
    WHEN 15.
      lv_table = 'T006J'.
      CONCATENATE
        'CLIENT,LANGU,ISOCODE,ISOTXT'
        INTO lv_expected.
      CLEAR: ls_t006j, lc_t006j.
      READ TABLE lt_t006j INTO ls_t006j WITH KEY
        client = '200'
        langu = 'E'
        isocode = 'KPA'
        .
      IF sy-subrc = 0.
        ADD 1 TO lv_t006j. lv_present = 'X'.
      ELSE.
        ls_t006j-client = '200'.
        ls_t006j-langu = 'E'.
        ls_t006j-isocode = 'KPA'.
      ENDIF.
      GET REFERENCE OF ls_t006j INTO lr_row.
      GET REFERENCE OF lc_t006j INTO lr_copy.
    WHEN 16.
      lv_table = 'T006T'.
      CONCATENATE
        'MANDT,SPRAS,DIMID,TXDIM'
        INTO lv_expected.
      CLEAR: ls_t006t, lc_t006t.
      READ TABLE lt_t006t INTO ls_t006t WITH KEY
        mandt = '200'
        spras = '1'
        dimid = 'PRESS'
        .
      IF sy-subrc = 0.
        ADD 1 TO lv_t006t. lv_present = 'X'.
      ELSE.
        ls_t006t-mandt = '200'.
        ls_t006t-spras = '1'.
        ls_t006t-dimid = 'PRESS'.
      ENDIF.
      GET REFERENCE OF ls_t006t INTO lr_row.
      GET REFERENCE OF lc_t006t INTO lr_copy.
    WHEN 17.
      lv_table = 'T006T'.
      CONCATENATE
        'MANDT,SPRAS,DIMID,TXDIM'
        INTO lv_expected.
      CLEAR: ls_t006t, lc_t006t.
      READ TABLE lt_t006t INTO ls_t006t WITH KEY
        mandt = '200'
        spras = 'D'
        dimid = 'PRESS'
        .
      IF sy-subrc = 0.
        ADD 1 TO lv_t006t. lv_present = 'X'.
      ELSE.
        ls_t006t-mandt = '200'.
        ls_t006t-spras = 'D'.
        ls_t006t-dimid = 'PRESS'.
      ENDIF.
      GET REFERENCE OF ls_t006t INTO lr_row.
      GET REFERENCE OF lc_t006t INTO lr_copy.
    WHEN 18.
      lv_table = 'T006T'.
      CONCATENATE
        'MANDT,SPRAS,DIMID,TXDIM'
        INTO lv_expected.
      CLEAR: ls_t006t, lc_t006t.
      READ TABLE lt_t006t INTO ls_t006t WITH KEY
        mandt = '200'
        spras = 'E'
        dimid = 'PRESS'
        .
      IF sy-subrc = 0.
        ADD 1 TO lv_t006t. lv_present = 'X'.
      ELSE.
        ls_t006t-mandt = '200'.
        ls_t006t-spras = 'E'.
        ls_t006t-dimid = 'PRESS'.
      ENDIF.
      GET REFERENCE OF ls_t006t INTO lr_row.
      GET REFERENCE OF lc_t006t INTO lr_copy.
    WHEN 19.
      lv_table = 'T006_OIB'.
      CONCATENATE
        'MANDT,MSEHI,PRES_VALUE,PRES_UNIT,COMB_PR'
        'ES,COMB_PRES_UNIT,COMB_TEMP,COMB_TEMP_UN'
        'IT,HVALUE_CLASS'
        INTO lv_expected.
      CLEAR: ls_t006_oib, lc_t006_oib.
      READ TABLE lt_t006_oib INTO ls_t006_oib WITH KEY
        mandt = '200'
        msehi = 'KNM'
        .
      IF sy-subrc = 0.
        ADD 1 TO lv_t006_oib. lv_present = 'X'.
      ELSE.
        ls_t006_oib-mandt = '200'.
        ls_t006_oib-msehi = 'KNM'.
      ENDIF.
      GET REFERENCE OF ls_t006_oib INTO lr_row.
      GET REFERENCE OF lc_t006_oib INTO lr_copy.
  ENDCASE.
  ASSIGN lr_row->* TO <row>.
  ASSIGN lr_copy->* TO <copy>.
  IF lv_present IS INITIAL. lv_only_key = 'X'. ENDIF.
" 用标准描述器及转换函数检查恢复值；缺行只重建删除键。
  REFRESH: lt_fields, lt_values.
  CALL FUNCTION 'SCPR_DB_TABLE_TABFLDDEF_GET'
    EXPORTING tabname = lv_table
    IMPORTING keylen = lv_keylen
    TABLES fielddescr = lt_fields
    EXCEPTIONS table_not_found = 1 ddif_internal_error = 2
      error_message = 3 OTHERS = 4.
  IF sy-subrc <> 0 OR lt_fields IS INITIAL
  OR lv_keylen <= 0.
    ev_code = 'DESCRIPTOR_FAILED'. RETURN.
  ENDIF.
  lv_fields = 0. lv_keys = 0. CLEAR lv_names.
  TRY.
    LOOP AT lt_fields INTO ls_field.
      ADD 1 TO lv_fields.
      IF lv_names IS INITIAL. lv_names = ls_field-fieldname.
      ELSE.
        CONCATENATE lv_names ls_field-fieldname
          INTO lv_names SEPARATED BY ','.
      ENDIF.
      IF ls_field-keyflag = 'X'. ADD 1 TO lv_keys. ENDIF.
      ASSIGN COMPONENT ls_field-fieldname OF STRUCTURE <row>
        TO <value>.
      IF sy-subrc <> 0.
        ev_code = 'DESCRIPTOR_FAILED'. RETURN.
      ENDIF.
      DESCRIBE FIELD <value> TYPE lv_type.
      DESCRIBE FIELD <value> LENGTH lv_len IN BYTE MODE.
      IF lv_type <> ls_field-vtype OR lv_len <> ls_field-intlen
      OR lv_type NA 'CNDTIPF' OR ls_field-maxbcslen > 255
      OR ls_field-datatype = 'CURR'
      OR ls_field-datatype = 'QUAN'
      OR ls_field-readonly = 'R'.
        ev_code = 'DESCRIPTOR_UNSUPPORTED'. RETURN.
      ENDIF.
      IF lv_only_key = 'X' AND ls_field-keyflag IS INITIAL.
        CONTINUE.
      ENDIF.
      CLEAR lv_external.
      CALL FUNCTION 'SCPR_CT_VALUE_CONVERT_INT_EXT'
        EXPORTING fielddescr = ls_field value_intern = <value>
          with_convexit = space
        IMPORTING value_extern = lv_external
        EXCEPTIONS error_message = 1 OTHERS = 2.
      IF sy-subrc <> 0.
        ev_code = 'CONVERSION_FAILED'. RETURN.
      ENDIF.
      CLEAR ls_value.
      ls_value-id = iv_bc_set. ls_value-version = iv_version.
      ls_value-tablename = lv_table. ls_value-recnumber = 1.
      ls_value-fieldname = ls_field-fieldname.
      ls_value-flag = ls_field-flag.
      ls_value-value = lv_external.
      APPEND ls_value TO lt_values.
    ENDLOOP.
    IF lv_names <> lv_expected OR lv_fields = 0 OR lv_keys = 0
    OR lt_values IS INITIAL.
      ev_code = 'DESCRIPTOR_FAILED'. RETURN.
    ENDIF.
    CALL FUNCTION 'SCPR_CPROF_CT_PROFDATA_CONVERT'
      EXPORTING tabname = lv_table only_key = lv_only_key
        recnumber = ls_value-recnumber keylen = lv_keylen
        values_in_int_format = space
      IMPORTING line = <copy>
      TABLES profvalues = lt_values tabledescr = lt_fields
      EXCEPTIONS error_message = 1 OTHERS = 2.
    IF sy-subrc <> 0.
      ev_code = 'CONVERSION_FAILED'. RETURN.
    ENDIF.
" 标准转换吞错或舍入时，原生结构比较必须失败。
    EXPORT row = <row> TO DATA BUFFER lv_before.
    EXPORT row = <copy> TO DATA BUFFER lv_after.
  CATCH cx_root.
    ev_code = 'CONVERSION_FAILED'. RETURN.
  ENDTRY.
  IF lv_before <> lv_after.
    ev_code = 'ROUNDTRIP_LOSSY'. RETURN.
  ENDIF.
  CALL FUNCTION 'CALCULATE_HASH_FOR_RAW'
    EXPORTING alg = 'SHA2' data = lv_before
    IMPORTING hashstring = lv_before_hash
    EXCEPTIONS unknown_alg = 1 param_error = 2 internal_error = 3
      error_message = 4 OTHERS = 5.
  IF sy-subrc <> 0.
    ev_code = 'HASH_FAILED'. RETURN.
  ENDIF.
  TRANSLATE lv_before_hash TO LOWER CASE.
  IF strlen( lv_before_hash ) <> 64
  OR lv_before_hash CN '0123456789abcdef'.
    ev_code = 'HASH_FAILED'. RETURN.
  ENDIF.
  CALL FUNCTION 'CALCULATE_HASH_FOR_RAW'
    EXPORTING alg = 'SHA2' data = lv_after
    IMPORTING hashstring = lv_after_hash
    EXCEPTIONS unknown_alg = 1 param_error = 2 internal_error = 3
      error_message = 4 OTHERS = 5.
  IF sy-subrc <> 0.
    ev_code = 'HASH_FAILED'. RETURN.
  ENDIF.
  TRANSLATE lv_after_hash TO LOWER CASE.
  IF strlen( lv_after_hash ) <> 64
  OR lv_after_hash CN '0123456789abcdef'.
    ev_code = 'HASH_FAILED'. RETURN.
  ENDIF.
  lv_text = lv_index. CONDENSE lv_text NO-GAPS.
  lv_tabletext = lv_table. CONDENSE lv_tabletext NO-GAPS.
  IF lv_present IS INITIAL. lv_present = ' '. ENDIF.
  CONCATENATE lv_text '|' lv_tabletext '|' lv_present '|'
    lv_before_hash '|' lv_after_hash
    INTO lv_text RESPECTING BLANKS.
  IF lv_rows IS INITIAL. lv_rows = lv_text.
  ELSE.
    CONCATENATE lv_rows lv_text INTO lv_rows
      SEPARATED BY cl_abap_char_utilities=>newline.
  ENDIF.
ENDDO.
" 命中数量必须等于导入行数，拒绝重复或越出十九键的行。
DESCRIBE TABLE lt_t006 LINES lv_len.
IF lv_len <> lv_t006.
  ev_code = 'ROW_SCOPE_INVALID'. RETURN.
ENDIF.
lv_text = lv_len. CONDENSE lv_text NO-GAPS.
CONCATENATE lv_counts 'T006=' lv_text ';'
  INTO lv_counts.
DESCRIBE TABLE lt_t006a LINES lv_len.
IF lv_len <> lv_t006a.
  ev_code = 'ROW_SCOPE_INVALID'. RETURN.
ENDIF.
lv_text = lv_len. CONDENSE lv_text NO-GAPS.
CONCATENATE lv_counts 'T006A=' lv_text ';'
  INTO lv_counts.
DESCRIBE TABLE lt_t006b LINES lv_len.
IF lv_len <> lv_t006b.
  ev_code = 'ROW_SCOPE_INVALID'. RETURN.
ENDIF.
lv_text = lv_len. CONDENSE lv_text NO-GAPS.
CONCATENATE lv_counts 'T006B=' lv_text ';'
  INTO lv_counts.
DESCRIBE TABLE lt_t006c LINES lv_len.
IF lv_len <> lv_t006c.
  ev_code = 'ROW_SCOPE_INVALID'. RETURN.
ENDIF.
lv_text = lv_len. CONDENSE lv_text NO-GAPS.
CONCATENATE lv_counts 'T006C=' lv_text ';'
  INTO lv_counts.
DESCRIBE TABLE lt_t006d LINES lv_len.
IF lv_len <> lv_t006d.
  ev_code = 'ROW_SCOPE_INVALID'. RETURN.
ENDIF.
lv_text = lv_len. CONDENSE lv_text NO-GAPS.
CONCATENATE lv_counts 'T006D=' lv_text ';'
  INTO lv_counts.
DESCRIBE TABLE lt_t006i LINES lv_len.
IF lv_len <> lv_t006i.
  ev_code = 'ROW_SCOPE_INVALID'. RETURN.
ENDIF.
lv_text = lv_len. CONDENSE lv_text NO-GAPS.
CONCATENATE lv_counts 'T006I=' lv_text ';'
  INTO lv_counts.
DESCRIBE TABLE lt_t006j LINES lv_len.
IF lv_len <> lv_t006j.
  ev_code = 'ROW_SCOPE_INVALID'. RETURN.
ENDIF.
lv_text = lv_len. CONDENSE lv_text NO-GAPS.
CONCATENATE lv_counts 'T006J=' lv_text ';'
  INTO lv_counts.
DESCRIBE TABLE lt_t006t LINES lv_len.
IF lv_len <> lv_t006t.
  ev_code = 'ROW_SCOPE_INVALID'. RETURN.
ENDIF.
lv_text = lv_len. CONDENSE lv_text NO-GAPS.
CONCATENATE lv_counts 'T006T=' lv_text ';'
  INTO lv_counts.
DESCRIBE TABLE lt_t006_oib LINES lv_len.
IF lv_len <> lv_t006_oib.
  ev_code = 'ROW_SCOPE_INVALID'. RETURN.
ENDIF.
lv_text = lv_len. CONDENSE lv_text NO-GAPS.
CONCATENATE lv_counts 'T006_OIB=' lv_text ';'
  INTO lv_counts.
EXPORT state = iv_state_version layout = lr_layout
  system = lr_system client = lr_client user = lr_user
  rows = lv_rows counts = lv_counts TO DATA BUFFER lv_proof.
  CALL FUNCTION 'CALCULATE_HASH_FOR_RAW'
    EXPORTING alg = 'SHA2' data = lv_proof
    IMPORTING hashstring = lv_hash
    EXCEPTIONS unknown_alg = 1 param_error = 2 internal_error = 3
      error_message = 4 OTHERS = 5.
  IF sy-subrc <> 0.
    ev_code = 'HASH_FAILED'. RETURN.
  ENDIF.
  TRANSLATE lv_hash TO LOWER CASE.
  IF strlen( lv_hash ) <> 64
  OR lv_hash CN '0123456789abcdef'.
    ev_code = 'HASH_FAILED'. RETURN.
  ENDIF.
CALL FUNCTION 'SCMS_BASE64_ENCODE_STR'
  EXPORTING input = lv_proof IMPORTING output = lv_base64
  EXCEPTIONS error_message = 1 OTHERS = 2.
IF sy-subrc <> 0 OR lv_base64 IS INITIAL.
  ev_code = 'ENCODING_FAILED'. RETURN.
ENDIF.
" 成功只证明本次转换，未建立锁内快照或写入/恢复许可。
ev_system = sy-sysid. ev_client = sy-mandt. ev_user = sy-uname.
ev_state_version = iv_state_version. ev_layout_version = lr_layout.
ev_row_counts = lv_counts. ev_row_proofs = lv_rows.
ev_proof_base64 = lv_base64. ev_proof_version = lv_hash.
ev_roundtrip = 'X'. ev_code = 'RECOVERY_CHECK_OK'.





ENDFUNCTION.