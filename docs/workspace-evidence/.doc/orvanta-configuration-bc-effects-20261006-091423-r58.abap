FUNCTION z_orvanta_cfg_bc_effects.
*" 本地部署候选；RFC属性与参数必须按审阅JSON建立。
*" IMPORTING
*"   VALUE(IV_BC_SET) TYPE STRING
*"   VALUE(IV_VERSION) TYPE STRING
*"   VALUE(IV_REQUEST) TYPE STRING
*"   VALUE(IV_TASK) TYPE STRING
*"   VALUE(IV_CTS_VERSION) TYPE STRING
*" EXPORTING
*"   VALUE(EV_CODE) TYPE STRING
*"   VALUE(EV_SYSTEM) TYPE STRING
*"   VALUE(EV_CLIENT) TYPE STRING
*"   VALUE(EV_USER) TYPE STRING
*"   VALUE(EV_REQUEST) TYPE STRING
*"   VALUE(EV_TASK) TYPE STRING
*"   VALUE(EV_CTS_VERSION) TYPE STRING
*"   VALUE(EV_SCOPE_VERSION) TYPE STRING
*"   VALUE(EV_EFFECTS_VERSION) TYPE STRING
*"   VALUE(EV_ROW_COUNTS) TYPE STRING
*"   VALUE(EV_PROFILE_COUNT) TYPE STRING
*"   VALUE(EV_DATA_BASE64) TYPE STRING
*"   VALUE(EV_DATA_BYTES) TYPE STRING
*"   VALUE(EV_ROUNDTRIP) TYPE STRING
" 固定十九键的标准激活链接前态；只读，不授予恢复许可。
TYPES: BEGIN OF ty_scope,
  tablename TYPE scpractr-tablename,
  tabkey TYPE scpractr-tabkey, END OF ty_scope.
TYPES: BEGIN OF ty_profile,
  id TYPE scpractr-profid, END OF ty_profile.
DATA: lt_scope TYPE STANDARD TABLE OF ty_scope,
      ls_scope TYPE ty_scope,
      lt_profiles TYPE STANDARD TABLE OF ty_profile,
      ls_profile TYPE ty_profile, ls_record TYPE scpractr,
      ls_full_record TYPE scpractr,
      lt_matched TYPE STANDARD TABLE OF scpractr,
      lt_records TYPE STANDARD TABLE OF scpractr,
      lt_headers TYPE STANDARD TABLE OF scpractp,
      lt_variables TYPE STANDARD TABLE OF scpractx,
      lt_links TYPE STANDARD TABLE OF scpractxl,
      lv_table TYPE tddat-tabname, lv_group TYPE tddat-cclass,
      lv_code TYPE string, lv_system TYPE string,
      lv_client TYPE string, lv_user TYPE string,
      lv_cts TYPE string, lv_scope TYPE string,
      lv_namespace TYPE string, lv_hash TYPE string,
      lv_counts TYPE string, lv_text TYPE string,
      lv_base64 TYPE string, lv_buffer TYPE xstring,
      lv_first TYPE xstring, lv_roundtrip TYPE xstring,
      lv_index TYPE i, lv_pass TYPE i, lv_count TYPE i,
      lv_profiles TYPE i, lv_offset TYPE i, lv_length TYPE i,
      lv_type TYPE c, lv_expected TYPE scpractr-tabkey,
      lr_row TYPE REF TO data.
FIELD-SYMBOLS: <row> TYPE any, <value> TYPE any.
DATA ls_t006 TYPE t006.
DATA ls_t006a TYPE t006a.
DATA ls_t006b TYPE t006b.
DATA ls_t006c TYPE t006c.
DATA ls_t006d TYPE t006d.
DATA ls_t006i TYPE t006i.
DATA ls_t006j TYPE t006j.
DATA ls_t006t TYPE t006t.
DATA ls_t006_oib TYPE t006_oib.
DATA lr_namespace TYPE string.
DATA lr_system TYPE string.
DATA lr_client TYPE string.
DATA lr_user TYPE string.
DATA lr_bcset TYPE string.
DATA lr_version TYPE string.
DATA lr_request TYPE string.
DATA lr_task TYPE string.
DATA lr_cts TYPE string.
DATA lr_scope TYPE string.
DATA lr_keys TYPE STANDARD TABLE OF ty_scope.
DATA lr_matched TYPE STANDARD TABLE OF scpractr.
DATA lr_records TYPE STANDARD TABLE OF scpractr.
DATA lr_headers TYPE STANDARD TABLE OF scpractp.
DATA lr_variables TYPE STANDARD TABLE OF scpractx.
DATA lr_links TYPE STANDARD TABLE OF scpractxl.
CLEAR: ev_code, ev_system, ev_client, ev_user, ev_request,
  ev_task, ev_cts_version, ev_scope_version, ev_effects_version,
  ev_row_counts, ev_profile_count, ev_data_base64,
  ev_data_bytes, ev_roundtrip.
IF sy-sysid <> 'GR2' OR sy-mandt <> '200'.
  ev_code = 'SCOPE_UNSUPPORTED'. RETURN.
ENDIF.
IF iv_bc_set <> 'EHS_CUNI_KNM' OR iv_version <> 'N' OR
   iv_request <> 'GR2K923429' OR iv_task <> 'GR2K923430' OR
   strlen( iv_cts_version ) <> 64 OR
   iv_cts_version CN '0123456789abcdef'.
  ev_code = 'INPUT_INVALID'. RETURN.
ENDIF.
DO 4 TIMES.
  CASE sy-index.
    WHEN 1. lv_table = 'SCPRACTR'.
    WHEN 2. lv_table = 'SCPRACTP'.
    WHEN 3. lv_table = 'SCPRACTX'.
    WHEN 4. lv_table = 'SCPRACTXL'.
  ENDCASE.
  CLEAR lv_group.
  SELECT SINGLE cclass FROM tddat INTO lv_group
    WHERE tabname = lv_table.
  IF sy-subrc <> 0 OR lv_group IS INITIAL.
    lv_group = '&NC&'.
  ENDIF.
  AUTHORITY-CHECK OBJECT 'S_TABU_DIS'
    ID 'DICBERCLS' FIELD lv_group ID 'ACTVT' FIELD '03'.
  IF sy-subrc <> 0.
    ev_code = 'AUTHORIZATION_DENIED'. RETURN.
  ENDIF.
ENDDO.
TRY.
" 标准函数缓存描述器；以本次DDIC结构的字符键再核对其结果。
  DO 19 TIMES.
    lv_index = sy-index. CLEAR: ls_scope, lv_expected.
    lv_offset = 0.
    CASE lv_index.
      WHEN 1.
        ls_scope-tablename = 'T006'.
        CLEAR ls_t006.
        ls_t006-mandt = '200'.
        ls_t006-msehi = 'KNM'.
        GET REFERENCE OF ls_t006 INTO lr_row.
        DESCRIBE FIELD ls_t006-mandt TYPE lv_type.
        DESCRIBE FIELD ls_t006-mandt
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006-mandt.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006-msehi TYPE lv_type.
        DESCRIBE FIELD ls_t006-msehi
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006-msehi.
        ADD lv_length TO lv_offset.
      WHEN 2.
        ls_scope-tablename = 'T006A'.
        CLEAR ls_t006a.
        ls_t006a-mandt = '200'.
        ls_t006a-spras = '1'.
        ls_t006a-msehi = 'KNM'.
        GET REFERENCE OF ls_t006a INTO lr_row.
        DESCRIBE FIELD ls_t006a-mandt TYPE lv_type.
        DESCRIBE FIELD ls_t006a-mandt
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006a-mandt.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006a-spras TYPE lv_type.
        DESCRIBE FIELD ls_t006a-spras
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006a-spras.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006a-msehi TYPE lv_type.
        DESCRIBE FIELD ls_t006a-msehi
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006a-msehi.
        ADD lv_length TO lv_offset.
      WHEN 3.
        ls_scope-tablename = 'T006A'.
        CLEAR ls_t006a.
        ls_t006a-mandt = '200'.
        ls_t006a-spras = 'D'.
        ls_t006a-msehi = 'KNM'.
        GET REFERENCE OF ls_t006a INTO lr_row.
        DESCRIBE FIELD ls_t006a-mandt TYPE lv_type.
        DESCRIBE FIELD ls_t006a-mandt
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006a-mandt.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006a-spras TYPE lv_type.
        DESCRIBE FIELD ls_t006a-spras
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006a-spras.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006a-msehi TYPE lv_type.
        DESCRIBE FIELD ls_t006a-msehi
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006a-msehi.
        ADD lv_length TO lv_offset.
      WHEN 4.
        ls_scope-tablename = 'T006A'.
        CLEAR ls_t006a.
        ls_t006a-mandt = '200'.
        ls_t006a-spras = 'E'.
        ls_t006a-msehi = 'KNM'.
        GET REFERENCE OF ls_t006a INTO lr_row.
        DESCRIBE FIELD ls_t006a-mandt TYPE lv_type.
        DESCRIBE FIELD ls_t006a-mandt
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006a-mandt.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006a-spras TYPE lv_type.
        DESCRIBE FIELD ls_t006a-spras
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006a-spras.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006a-msehi TYPE lv_type.
        DESCRIBE FIELD ls_t006a-msehi
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006a-msehi.
        ADD lv_length TO lv_offset.
      WHEN 5.
        ls_scope-tablename = 'T006B'.
        CLEAR ls_t006b.
        ls_t006b-mandt = '200'.
        ls_t006b-spras = '1'.
        ls_t006b-mseh3 = 'KNM'.
        GET REFERENCE OF ls_t006b INTO lr_row.
        DESCRIBE FIELD ls_t006b-mandt TYPE lv_type.
        DESCRIBE FIELD ls_t006b-mandt
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006b-mandt.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006b-spras TYPE lv_type.
        DESCRIBE FIELD ls_t006b-spras
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006b-spras.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006b-mseh3 TYPE lv_type.
        DESCRIBE FIELD ls_t006b-mseh3
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006b-mseh3.
        ADD lv_length TO lv_offset.
      WHEN 6.
        ls_scope-tablename = 'T006B'.
        CLEAR ls_t006b.
        ls_t006b-mandt = '200'.
        ls_t006b-spras = 'D'.
        ls_t006b-mseh3 = 'KNM'.
        GET REFERENCE OF ls_t006b INTO lr_row.
        DESCRIBE FIELD ls_t006b-mandt TYPE lv_type.
        DESCRIBE FIELD ls_t006b-mandt
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006b-mandt.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006b-spras TYPE lv_type.
        DESCRIBE FIELD ls_t006b-spras
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006b-spras.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006b-mseh3 TYPE lv_type.
        DESCRIBE FIELD ls_t006b-mseh3
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006b-mseh3.
        ADD lv_length TO lv_offset.
      WHEN 7.
        ls_scope-tablename = 'T006B'.
        CLEAR ls_t006b.
        ls_t006b-mandt = '200'.
        ls_t006b-spras = 'E'.
        ls_t006b-mseh3 = 'KNM'.
        GET REFERENCE OF ls_t006b INTO lr_row.
        DESCRIBE FIELD ls_t006b-mandt TYPE lv_type.
        DESCRIBE FIELD ls_t006b-mandt
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006b-mandt.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006b-spras TYPE lv_type.
        DESCRIBE FIELD ls_t006b-spras
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006b-spras.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006b-mseh3 TYPE lv_type.
        DESCRIBE FIELD ls_t006b-mseh3
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006b-mseh3.
        ADD lv_length TO lv_offset.
      WHEN 8.
        ls_scope-tablename = 'T006C'.
        CLEAR ls_t006c.
        ls_t006c-mandt = '200'.
        ls_t006c-spras = '1'.
        ls_t006c-mseh6 = 'kN/m2'.
        GET REFERENCE OF ls_t006c INTO lr_row.
        DESCRIBE FIELD ls_t006c-mandt TYPE lv_type.
        DESCRIBE FIELD ls_t006c-mandt
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006c-mandt.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006c-spras TYPE lv_type.
        DESCRIBE FIELD ls_t006c-spras
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006c-spras.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006c-mseh6 TYPE lv_type.
        DESCRIBE FIELD ls_t006c-mseh6
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006c-mseh6.
        ADD lv_length TO lv_offset.
      WHEN 9.
        ls_scope-tablename = 'T006C'.
        CLEAR ls_t006c.
        ls_t006c-mandt = '200'.
        ls_t006c-spras = 'D'.
        ls_t006c-mseh6 = 'kN/m2'.
        GET REFERENCE OF ls_t006c INTO lr_row.
        DESCRIBE FIELD ls_t006c-mandt TYPE lv_type.
        DESCRIBE FIELD ls_t006c-mandt
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006c-mandt.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006c-spras TYPE lv_type.
        DESCRIBE FIELD ls_t006c-spras
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006c-spras.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006c-mseh6 TYPE lv_type.
        DESCRIBE FIELD ls_t006c-mseh6
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006c-mseh6.
        ADD lv_length TO lv_offset.
      WHEN 10.
        ls_scope-tablename = 'T006C'.
        CLEAR ls_t006c.
        ls_t006c-mandt = '200'.
        ls_t006c-spras = 'E'.
        ls_t006c-mseh6 = 'kN/m2'.
        GET REFERENCE OF ls_t006c INTO lr_row.
        DESCRIBE FIELD ls_t006c-mandt TYPE lv_type.
        DESCRIBE FIELD ls_t006c-mandt
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006c-mandt.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006c-spras TYPE lv_type.
        DESCRIBE FIELD ls_t006c-spras
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006c-spras.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006c-mseh6 TYPE lv_type.
        DESCRIBE FIELD ls_t006c-mseh6
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006c-mseh6.
        ADD lv_length TO lv_offset.
      WHEN 11.
        ls_scope-tablename = 'T006D'.
        CLEAR ls_t006d.
        ls_t006d-mandt = '200'.
        ls_t006d-dimid = 'PRESS'.
        GET REFERENCE OF ls_t006d INTO lr_row.
        DESCRIBE FIELD ls_t006d-mandt TYPE lv_type.
        DESCRIBE FIELD ls_t006d-mandt
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006d-mandt.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006d-dimid TYPE lv_type.
        DESCRIBE FIELD ls_t006d-dimid
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006d-dimid.
        ADD lv_length TO lv_offset.
      WHEN 12.
        ls_scope-tablename = 'T006I'.
        CLEAR ls_t006i.
        ls_t006i-client = '200'.
        ls_t006i-isocode = 'KPA'.
        GET REFERENCE OF ls_t006i INTO lr_row.
        DESCRIBE FIELD ls_t006i-client TYPE lv_type.
        DESCRIBE FIELD ls_t006i-client
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006i-client.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006i-isocode TYPE lv_type.
        DESCRIBE FIELD ls_t006i-isocode
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006i-isocode.
        ADD lv_length TO lv_offset.
      WHEN 13.
        ls_scope-tablename = 'T006J'.
        CLEAR ls_t006j.
        ls_t006j-client = '200'.
        ls_t006j-langu = '1'.
        ls_t006j-isocode = 'KPA'.
        GET REFERENCE OF ls_t006j INTO lr_row.
        DESCRIBE FIELD ls_t006j-client TYPE lv_type.
        DESCRIBE FIELD ls_t006j-client
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006j-client.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006j-langu TYPE lv_type.
        DESCRIBE FIELD ls_t006j-langu
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006j-langu.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006j-isocode TYPE lv_type.
        DESCRIBE FIELD ls_t006j-isocode
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006j-isocode.
        ADD lv_length TO lv_offset.
      WHEN 14.
        ls_scope-tablename = 'T006J'.
        CLEAR ls_t006j.
        ls_t006j-client = '200'.
        ls_t006j-langu = 'D'.
        ls_t006j-isocode = 'KPA'.
        GET REFERENCE OF ls_t006j INTO lr_row.
        DESCRIBE FIELD ls_t006j-client TYPE lv_type.
        DESCRIBE FIELD ls_t006j-client
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006j-client.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006j-langu TYPE lv_type.
        DESCRIBE FIELD ls_t006j-langu
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006j-langu.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006j-isocode TYPE lv_type.
        DESCRIBE FIELD ls_t006j-isocode
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006j-isocode.
        ADD lv_length TO lv_offset.
      WHEN 15.
        ls_scope-tablename = 'T006J'.
        CLEAR ls_t006j.
        ls_t006j-client = '200'.
        ls_t006j-langu = 'E'.
        ls_t006j-isocode = 'KPA'.
        GET REFERENCE OF ls_t006j INTO lr_row.
        DESCRIBE FIELD ls_t006j-client TYPE lv_type.
        DESCRIBE FIELD ls_t006j-client
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006j-client.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006j-langu TYPE lv_type.
        DESCRIBE FIELD ls_t006j-langu
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006j-langu.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006j-isocode TYPE lv_type.
        DESCRIBE FIELD ls_t006j-isocode
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006j-isocode.
        ADD lv_length TO lv_offset.
      WHEN 16.
        ls_scope-tablename = 'T006T'.
        CLEAR ls_t006t.
        ls_t006t-mandt = '200'.
        ls_t006t-spras = '1'.
        ls_t006t-dimid = 'PRESS'.
        GET REFERENCE OF ls_t006t INTO lr_row.
        DESCRIBE FIELD ls_t006t-mandt TYPE lv_type.
        DESCRIBE FIELD ls_t006t-mandt
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006t-mandt.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006t-spras TYPE lv_type.
        DESCRIBE FIELD ls_t006t-spras
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006t-spras.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006t-dimid TYPE lv_type.
        DESCRIBE FIELD ls_t006t-dimid
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006t-dimid.
        ADD lv_length TO lv_offset.
      WHEN 17.
        ls_scope-tablename = 'T006T'.
        CLEAR ls_t006t.
        ls_t006t-mandt = '200'.
        ls_t006t-spras = 'D'.
        ls_t006t-dimid = 'PRESS'.
        GET REFERENCE OF ls_t006t INTO lr_row.
        DESCRIBE FIELD ls_t006t-mandt TYPE lv_type.
        DESCRIBE FIELD ls_t006t-mandt
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006t-mandt.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006t-spras TYPE lv_type.
        DESCRIBE FIELD ls_t006t-spras
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006t-spras.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006t-dimid TYPE lv_type.
        DESCRIBE FIELD ls_t006t-dimid
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006t-dimid.
        ADD lv_length TO lv_offset.
      WHEN 18.
        ls_scope-tablename = 'T006T'.
        CLEAR ls_t006t.
        ls_t006t-mandt = '200'.
        ls_t006t-spras = 'E'.
        ls_t006t-dimid = 'PRESS'.
        GET REFERENCE OF ls_t006t INTO lr_row.
        DESCRIBE FIELD ls_t006t-mandt TYPE lv_type.
        DESCRIBE FIELD ls_t006t-mandt
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006t-mandt.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006t-spras TYPE lv_type.
        DESCRIBE FIELD ls_t006t-spras
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006t-spras.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006t-dimid TYPE lv_type.
        DESCRIBE FIELD ls_t006t-dimid
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006t-dimid.
        ADD lv_length TO lv_offset.
      WHEN 19.
        ls_scope-tablename = 'T006_OIB'.
        CLEAR ls_t006_oib.
        ls_t006_oib-mandt = '200'.
        ls_t006_oib-msehi = 'KNM'.
        GET REFERENCE OF ls_t006_oib INTO lr_row.
        DESCRIBE FIELD ls_t006_oib-mandt TYPE lv_type.
        DESCRIBE FIELD ls_t006_oib-mandt
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006_oib-mandt.
        ADD lv_length TO lv_offset.
        DESCRIBE FIELD ls_t006_oib-msehi TYPE lv_type.
        DESCRIBE FIELD ls_t006_oib-msehi
          LENGTH lv_length IN CHARACTER MODE.
        IF lv_type NA 'CN' OR lv_length <= 0 OR
           lv_offset + lv_length > 255.
          ev_code = 'KEY_SCOPE_FAILED'. RETURN.
        ENDIF.
        lv_expected+lv_offset(lv_length) =
          ls_t006_oib-msehi.
        ADD lv_length TO lv_offset.
    ENDCASE.
    ASSIGN lr_row->* TO <row>.
    CALL FUNCTION 'SCPR_HI_KEY_TO_ACTKEY'
      EXPORTING tablename = ls_scope-tablename key = <row>
      IMPORTING tablekey = ls_scope-tabkey
      EXCEPTIONS wrong_parameters = 1 key_too_large = 2
        fielddescr_error = 3 error_message = 4 OTHERS = 5.
    IF sy-subrc <> 0 OR ls_scope-tabkey <> lv_expected.
      ev_code = 'KEY_SCOPE_FAILED'. RETURN.
    ENDIF.
    APPEND ls_scope TO lt_scope.
  ENDDO.
  SORT lt_scope BY tablename tabkey.
  DELETE ADJACENT DUPLICATES FROM lt_scope COMPARING ALL FIELDS.
  DESCRIBE TABLE lt_scope LINES lv_count.
  IF lv_count <> 19.
    ev_code = 'KEY_SCOPE_FAILED'. RETURN.
  ENDIF.
  lv_namespace = 'ORVANTA_CUNI_EFFECTS_V1'.
  lv_scope = '2b806d55466ce07e05b81f06a6459548'.
  CONCATENATE lv_scope '6137bf291d4e2871840706a84b6bb963'
    INTO lv_scope.
  DO 2 TIMES.
    lv_pass = sy-index.
  CALL FUNCTION 'Z_ORVANTA_CFG_BC_CTS'
    EXPORTING iv_bc_set = iv_bc_set iv_version = iv_version
      iv_request = iv_request iv_task = iv_task
    IMPORTING ev_code = lv_code ev_system = lv_system
      ev_client = lv_client ev_user = lv_user
      ev_cts_version = lv_cts
    EXCEPTIONS error_message = 1 OTHERS = 2.
  IF sy-subrc <> 0 OR lv_code <> 'CTS_READ_OK' OR
     lv_system <> sy-sysid
  OR lv_client <> sy-mandt OR lv_user <> sy-uname.
    ev_code = 'DEPENDENCY_FAILED'. RETURN.
  ENDIF.
  IF lv_cts <> iv_cts_version.
    ev_code = 'VERSION_CONFLICT'. RETURN.
  ENDIF.
" 仅替换空VIEWNAME的表级链接；相关profile须包含全部既有链接。
    SELECT * FROM scpractr UP TO 513 ROWS
      INTO TABLE lt_matched FOR ALL ENTRIES IN lt_scope
      WHERE tablename = lt_scope-tablename
        AND tabkey = lt_scope-tabkey AND viewname = space.
    IF sy-subrc <> 0 AND sy-subrc <> 4.
      ev_code = 'READ_FAILED'. RETURN.
    ENDIF.
    DESCRIBE TABLE lt_matched LINES lv_count.
    IF lv_count > 512.
      ev_code = 'LIMIT_EXCEEDED'. RETURN.
    ENDIF.
    REFRESH lt_profiles. CLEAR ls_profile.
    ls_profile-id = iv_bc_set. APPEND ls_profile TO lt_profiles.
    LOOP AT lt_matched INTO ls_record.
      IF ls_record-profid IS INITIAL.
        ev_code = 'READ_FAILED'. RETURN.
      ENDIF.
      ls_profile-id = ls_record-profid.
      APPEND ls_profile TO lt_profiles.
    ENDLOOP.
    SORT lt_profiles BY id.
    DELETE ADJACENT DUPLICATES FROM lt_profiles COMPARING id.
    DESCRIBE TABLE lt_profiles LINES lv_profiles.
    IF lv_profiles = 0 OR lv_profiles > 32.
      ev_code = 'LIMIT_EXCEEDED'. RETURN.
    ENDIF.
    SELECT * FROM scpractr UP TO 513 ROWS
      INTO TABLE lt_records FOR ALL ENTRIES IN lt_profiles
      WHERE profid = lt_profiles-id.
    IF sy-subrc <> 0 AND sy-subrc <> 4.
      ev_code = 'READ_FAILED'. RETURN.
    ENDIF.
    DESCRIBE TABLE lt_records LINES lv_count.
    IF lv_count > 512.
      ev_code = 'LIMIT_EXCEEDED'. RETURN.
    ENDIF.
    SELECT * FROM scpractp UP TO 513 ROWS
      INTO TABLE lt_headers FOR ALL ENTRIES IN lt_profiles
      WHERE profid = lt_profiles-id.
    IF sy-subrc <> 0 AND sy-subrc <> 4.
      ev_code = 'READ_FAILED'. RETURN.
    ENDIF.
    DESCRIBE TABLE lt_headers LINES lv_count.
    IF lv_count > 512.
      ev_code = 'LIMIT_EXCEEDED'. RETURN.
    ENDIF.
    SELECT * FROM scpractx UP TO 513 ROWS
      INTO TABLE lt_variables FOR ALL ENTRIES IN lt_profiles
      WHERE profid = lt_profiles-id.
    IF sy-subrc <> 0 AND sy-subrc <> 4.
      ev_code = 'READ_FAILED'. RETURN.
    ENDIF.
    DESCRIBE TABLE lt_variables LINES lv_count.
    IF lv_count > 512.
      ev_code = 'LIMIT_EXCEEDED'. RETURN.
    ENDIF.
    SELECT * FROM scpractxl UP TO 513 ROWS
      INTO TABLE lt_links FOR ALL ENTRIES IN lt_profiles
      WHERE bcset = lt_profiles-id.
    IF sy-subrc <> 0 AND sy-subrc <> 4.
      ev_code = 'READ_FAILED'. RETURN.
    ENDIF.
    DESCRIBE TABLE lt_links LINES lv_count.
    IF lv_count > 512.
      ev_code = 'LIMIT_EXCEEDED'. RETURN.
    ENDIF.
    SORT lt_matched BY client tablename tabrecnumb.
    SORT lt_records BY client tablename tabrecnumb.
    SORT lt_headers BY client profid modifier.
    SORT lt_variables BY client profid moddate modtime
      dataelem oldvalue.
    SORT lt_links BY client bcset moddate modtime tablename
      recnumber fieldname langu.
    LOOP AT lt_matched INTO ls_record.
      READ TABLE lt_records INTO ls_full_record
        WITH KEY client = ls_record-client
        tablename = ls_record-tablename
        tabrecnumb = ls_record-tabrecnumb BINARY SEARCH.
      IF sy-subrc <> 0 OR ls_full_record <> ls_record.
        ev_code = 'READ_CHANGED'. RETURN.
      ENDIF.
    ENDLOOP.
  CALL FUNCTION 'Z_ORVANTA_CFG_BC_CTS'
    EXPORTING iv_bc_set = iv_bc_set iv_version = iv_version
      iv_request = iv_request iv_task = iv_task
    IMPORTING ev_code = lv_code ev_system = lv_system
      ev_client = lv_client ev_user = lv_user
      ev_cts_version = lv_cts
    EXCEPTIONS error_message = 1 OTHERS = 2.
  IF sy-subrc <> 0 OR lv_code <> 'CTS_READ_OK' OR
     lv_system <> sy-sysid
  OR lv_client <> sy-mandt OR lv_user <> sy-uname.
    ev_code = 'DEPENDENCY_FAILED'. RETURN.
  ENDIF.
  IF lv_cts <> iv_cts_version.
    ev_code = 'VERSION_CONFLICT'. RETURN.
  ENDIF.
    EXPORT namespace = lv_namespace system = lv_system
      client = lv_client user = lv_user bcset = iv_bc_set
      version = iv_version request = iv_request task = iv_task
      cts = lv_cts scope = lv_scope keys = lt_scope
      matched = lt_matched records = lt_records
      headers = lt_headers variables = lt_variables
      links = lt_links TO DATA BUFFER lv_buffer.
    IF xstrlen( lv_buffer ) = 0 OR
       xstrlen( lv_buffer ) > 524288.
      ev_code = 'LIMIT_EXCEEDED'. RETURN.
    ENDIF.
    IF lv_pass = 1. lv_first = lv_buffer.
    ELSEIF lv_first <> lv_buffer.
      ev_code = 'READ_CHANGED'. RETURN.
    ENDIF.
  ENDDO.
" 原生IMPORT/EXPORT比较保留空格、日期时间、缺行与全部字段。
  IMPORT namespace = lr_namespace system = lr_system
    client = lr_client user = lr_user bcset = lr_bcset
    version = lr_version request = lr_request task = lr_task
    cts = lr_cts scope = lr_scope keys = lr_keys
    matched = lr_matched records = lr_records
    headers = lr_headers variables = lr_variables
    links = lr_links FROM DATA BUFFER lv_buffer.
  IF sy-subrc <> 0.
    ev_code = 'ROUNDTRIP_FAILED'. RETURN.
  ENDIF.
  EXPORT namespace = lr_namespace system = lr_system
    client = lr_client user = lr_user bcset = lr_bcset
    version = lr_version request = lr_request task = lr_task
    cts = lr_cts scope = lr_scope keys = lr_keys
    matched = lr_matched records = lr_records
    headers = lr_headers variables = lr_variables
    links = lr_links TO DATA BUFFER lv_roundtrip.
  IF lv_roundtrip <> lv_buffer.
    ev_code = 'ROUNDTRIP_FAILED'. RETURN.
  ENDIF.
CATCH cx_root.
  ev_code = 'READ_FAILED'. RETURN.
ENDTRY.
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
CLEAR lv_counts.
DESCRIBE TABLE lt_matched LINES lv_count.
lv_text = lv_count. CONDENSE lv_text NO-GAPS.
CONCATENATE lv_counts 'matched=' lv_text ';' INTO lv_counts.
DESCRIBE TABLE lt_records LINES lv_count.
lv_text = lv_count. CONDENSE lv_text NO-GAPS.
CONCATENATE lv_counts 'records=' lv_text ';' INTO lv_counts.
DESCRIBE TABLE lt_headers LINES lv_count.
lv_text = lv_count. CONDENSE lv_text NO-GAPS.
CONCATENATE lv_counts 'headers=' lv_text ';' INTO lv_counts.
DESCRIBE TABLE lt_variables LINES lv_count.
lv_text = lv_count. CONDENSE lv_text NO-GAPS.
CONCATENATE lv_counts 'variables=' lv_text ';' INTO lv_counts.
DESCRIBE TABLE lt_links LINES lv_count.
lv_text = lv_count. CONDENSE lv_text NO-GAPS.
CONCATENATE lv_counts 'links=' lv_text ';' INTO lv_counts.
ev_system = sy-sysid. ev_client = sy-mandt. ev_user = sy-uname.
ev_request = iv_request. ev_task = iv_task.
ev_cts_version = lv_cts. ev_scope_version = lv_scope.
ev_effects_version = lv_hash. ev_row_counts = lv_counts.
ev_profile_count = lv_profiles. CONDENSE ev_profile_count NO-GAPS.
ev_data_bytes = xstrlen( lv_buffer ).
CONDENSE ev_data_bytes NO-GAPS.
ev_data_base64 = lv_base64. ev_roundtrip = 'X'.
ev_code = 'EFFECTS_READ_OK'.
ENDFUNCTION.
