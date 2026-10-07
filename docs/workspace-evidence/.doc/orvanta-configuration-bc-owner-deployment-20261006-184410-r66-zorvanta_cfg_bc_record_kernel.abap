TYPE-POOLS: scpr, scp1.
TYPES ty_orv_bc_values TYPE STANDARD TABLE OF scprvals
  WITH DEFAULT KEY.
TYPES: BEGIN OF ty_orv_bc_record,
  ordinal TYPE i,
  recattr TYPE scprreca,
  descriptor TYPE scpr_record2,
  values TYPE ty_orv_bc_values,
  deleteflag TYPE scprreca-deleteflag,
  full_row TYPE xstring,
  key_row TYPE xstring,
END OF ty_orv_bc_record.
TYPES ty_orv_bc_records TYPE STANDARD TABLE OF ty_orv_bc_record
  WITH DEFAULT KEY.
" 仅供外层完整命令在持锁、fresh 校验后调用；不拥有提交或 CTS。
FORM orv_bc_record_prepare
  USING p_ordinal TYPE i p_attr TYPE scprreca
        p_row TYPE any p_delete TYPE c
  CHANGING p_record TYPE ty_orv_bc_record p_code TYPE string.
DATA: ls_record TYPE ty_orv_bc_record,
      ls_descr TYPE scpr_record2, ls_field TYPE scpr_flddescr,
      ls_value TYPE scprvals, lt_values TYPE ty_orv_bc_values,
      lv_table TYPE scpr_tabl, lv_type TYPE c, lv_len TYPE i,
      lv_fields TYPE i, lv_keys TYPE i, lv_keybytes TYPE i,
      lv_rowbytes TYPE i,
      lv_names TYPE string, lv_expected TYPE string,
      lv_typecode TYPE c, lv_objname TYPE ob_object,
      lv_objtype TYPE ob_typ, lv_external TYPE scprvals-value,
      lv_keyonly TYPE c, lv_full TYPE xstring, lv_copy TYPE xstring,
      lv_key TYPE xstring, lr_copy TYPE REF TO data,
      lr_key TYPE REF TO data.
FIELD-SYMBOLS: <copy> TYPE any, <key> TYPE any,
  <value> TYPE any, <keyvalue> TYPE any.
CLEAR: p_record, p_code.
IF sy-sysid <> 'GR2' OR sy-mandt <> '200'.
  p_code = 'SCOPE_UNSUPPORTED'. RETURN.
ENDIF.
IF p_delete <> space AND p_delete <> 'X'.
  p_code = 'INPUT_INVALID'. RETURN.
ENDIF.
CASE p_ordinal.
  WHEN 1. lv_table = 'T006'.
  WHEN 2. lv_table = 'T006A'.
  WHEN 3. lv_table = 'T006A'.
  WHEN 4. lv_table = 'T006A'.
  WHEN 5. lv_table = 'T006B'.
  WHEN 6. lv_table = 'T006B'.
  WHEN 7. lv_table = 'T006B'.
  WHEN 8. lv_table = 'T006C'.
  WHEN 9. lv_table = 'T006C'.
  WHEN 10. lv_table = 'T006C'.
  WHEN OTHERS. p_code = 'ROW_SCOPE_INVALID'. RETURN.
ENDCASE.
IF p_attr-id <> 'EHS_CUNI_KNM' OR p_attr-version <> 'N'
OR p_attr-tablename <> lv_table OR p_attr-recnumber <> 1
OR p_attr-objectname <> 'CUNI' OR p_attr-objecttype <> 'T'
OR p_attr-activity IS NOT INITIAL
OR p_attr-deleteflag IS NOT INITIAL
OR p_attr-uncomplete IS NOT INITIAL OR p_attr-genref IS NOT INITIAL
OR p_attr-clustname IS NOT INITIAL.
  p_code = 'RECORD_BINDING_INVALID'. RETURN.
ENDIF.
TRY.
  CASE lv_table.
    WHEN 'T006'.
      CONCATENATE
        'MANDT'
        ',MSEHI'
        ',KZEX3'
        ',KZEX6'
        ',ANDEC'
        ',KZKEH'
        ',KZWOB'
        ',KZ1EH'
        ',KZ2EH'
        ',DIMID'
        ',ZAEHL'
        ',NENNR'
        ',EXP10'
        ',ADDKO'
        ',EXPON'
        ',DECAN'
        ',ISOCODE'
        ',PRIMARY'
        ',TEMP_VALUE'
        ',TEMP_UNIT'
        ',FAMUNIT'
        ',PRESS_VAL'
        ',PRESS_UNIT'
        INTO lv_expected.
      CREATE DATA lr_copy TYPE t006.
    WHEN 'T006A'.
      CONCATENATE
        'MANDT'
        ',SPRAS'
        ',MSEHI'
        ',MSEH3'
        ',MSEH6'
        ',MSEHT'
        ',MSEHL'
        INTO lv_expected.
      CREATE DATA lr_copy TYPE t006a.
    WHEN 'T006B'.
      CONCATENATE
        'MANDT'
        ',SPRAS'
        ',MSEH3'
        ',MSEHI'
        INTO lv_expected.
      CREATE DATA lr_copy TYPE t006b.
    WHEN 'T006C'.
      CONCATENATE
        'MANDT'
        ',SPRAS'
        ',MSEH6'
        ',MSEHI'
        INTO lv_expected.
      CREATE DATA lr_copy TYPE t006c.
  ENDCASE.
  ASSIGN lr_copy->* TO <copy>.
  CREATE DATA lr_key LIKE <copy>.
  ASSIGN lr_key->* TO <key>.
  CASE p_ordinal.
    WHEN 1.
      ASSIGN COMPONENT 'MANDT' OF STRUCTURE p_row TO <value>.
      IF sy-subrc <> 0.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF <value> <> '200'.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      ASSIGN COMPONENT 'MSEHI' OF STRUCTURE p_row TO <value>.
      IF sy-subrc <> 0.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF <value> <> 'KNM'.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
    WHEN 2.
      ASSIGN COMPONENT 'MANDT' OF STRUCTURE p_row TO <value>.
      IF sy-subrc <> 0.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF <value> <> '200'.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      ASSIGN COMPONENT 'SPRAS' OF STRUCTURE p_row TO <value>.
      IF sy-subrc <> 0.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF <value> <> '1'.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      ASSIGN COMPONENT 'MSEHI' OF STRUCTURE p_row TO <value>.
      IF sy-subrc <> 0.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF <value> <> 'KNM'.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
    WHEN 3.
      ASSIGN COMPONENT 'MANDT' OF STRUCTURE p_row TO <value>.
      IF sy-subrc <> 0.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF <value> <> '200'.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      ASSIGN COMPONENT 'SPRAS' OF STRUCTURE p_row TO <value>.
      IF sy-subrc <> 0.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF <value> <> 'D'.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      ASSIGN COMPONENT 'MSEHI' OF STRUCTURE p_row TO <value>.
      IF sy-subrc <> 0.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF <value> <> 'KNM'.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
    WHEN 4.
      ASSIGN COMPONENT 'MANDT' OF STRUCTURE p_row TO <value>.
      IF sy-subrc <> 0.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF <value> <> '200'.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      ASSIGN COMPONENT 'SPRAS' OF STRUCTURE p_row TO <value>.
      IF sy-subrc <> 0.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF <value> <> 'E'.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      ASSIGN COMPONENT 'MSEHI' OF STRUCTURE p_row TO <value>.
      IF sy-subrc <> 0.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF <value> <> 'KNM'.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
    WHEN 5.
      ASSIGN COMPONENT 'MANDT' OF STRUCTURE p_row TO <value>.
      IF sy-subrc <> 0.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF <value> <> '200'.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      ASSIGN COMPONENT 'SPRAS' OF STRUCTURE p_row TO <value>.
      IF sy-subrc <> 0.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF <value> <> '1'.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      ASSIGN COMPONENT 'MSEH3' OF STRUCTURE p_row TO <value>.
      IF sy-subrc <> 0.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF <value> <> 'KNM'.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
    WHEN 6.
      ASSIGN COMPONENT 'MANDT' OF STRUCTURE p_row TO <value>.
      IF sy-subrc <> 0.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF <value> <> '200'.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      ASSIGN COMPONENT 'SPRAS' OF STRUCTURE p_row TO <value>.
      IF sy-subrc <> 0.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF <value> <> 'D'.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      ASSIGN COMPONENT 'MSEH3' OF STRUCTURE p_row TO <value>.
      IF sy-subrc <> 0.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF <value> <> 'KNM'.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
    WHEN 7.
      ASSIGN COMPONENT 'MANDT' OF STRUCTURE p_row TO <value>.
      IF sy-subrc <> 0.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF <value> <> '200'.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      ASSIGN COMPONENT 'SPRAS' OF STRUCTURE p_row TO <value>.
      IF sy-subrc <> 0.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF <value> <> 'E'.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      ASSIGN COMPONENT 'MSEH3' OF STRUCTURE p_row TO <value>.
      IF sy-subrc <> 0.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF <value> <> 'KNM'.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
    WHEN 8.
      ASSIGN COMPONENT 'MANDT' OF STRUCTURE p_row TO <value>.
      IF sy-subrc <> 0.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF <value> <> '200'.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      ASSIGN COMPONENT 'SPRAS' OF STRUCTURE p_row TO <value>.
      IF sy-subrc <> 0.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF <value> <> '1'.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      ASSIGN COMPONENT 'MSEH6' OF STRUCTURE p_row TO <value>.
      IF sy-subrc <> 0.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF <value> <> 'kN/m2'.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
    WHEN 9.
      ASSIGN COMPONENT 'MANDT' OF STRUCTURE p_row TO <value>.
      IF sy-subrc <> 0.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF <value> <> '200'.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      ASSIGN COMPONENT 'SPRAS' OF STRUCTURE p_row TO <value>.
      IF sy-subrc <> 0.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF <value> <> 'D'.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      ASSIGN COMPONENT 'MSEH6' OF STRUCTURE p_row TO <value>.
      IF sy-subrc <> 0.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF <value> <> 'kN/m2'.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
    WHEN 10.
      ASSIGN COMPONENT 'MANDT' OF STRUCTURE p_row TO <value>.
      IF sy-subrc <> 0.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF <value> <> '200'.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      ASSIGN COMPONENT 'SPRAS' OF STRUCTURE p_row TO <value>.
      IF sy-subrc <> 0.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF <value> <> 'E'.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      ASSIGN COMPONENT 'MSEH6' OF STRUCTURE p_row TO <value>.
      IF sy-subrc <> 0.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
      IF <value> <> 'kN/m2'.
        p_code = 'ROW_SCOPE_INVALID'. RETURN.
      ENDIF.
  ENDCASE.
  CALL FUNCTION 'SCPR_DB_TABLE_TYPE_GET'
    EXPORTING tabname = lv_table objname = p_attr-objectname
      objtype = p_attr-objecttype
    IMPORTING tabtype = lv_typecode new_objname = lv_objname
      new_objtype = lv_objtype
    EXCEPTIONS error_message = 1 OTHERS = 2.
  IF sy-subrc <> 0 OR lv_typecode <> 'T'
  OR lv_objname <> 'CUNI' OR lv_objtype <> 'T'.
    p_code = 'DESCRIPTOR_IDENTITY_INVALID'. RETURN.
  ENDIF.
" 直接检查 FIELDDEF 异常，避免集合工厂隐藏 TABLE_UNSUITABLE。
  CALL FUNCTION 'SCPR_DB_TABLE_FIELDDEF_GET'
    EXPORTING tabname = lv_table tabtype = lv_typecode
      flddescr_reduc = space entities_variable = space
    IMPORTING tablen = ls_descr-tablen keylen = ls_descr-keylen
      ckeylen = ls_descr-ckeylen
      flddescr_reduced = ls_descr-descr_reduced
      client_field = ls_descr-clnt_fld
      delivery_class = ls_descr-deliverycl
    TABLES sellist = ls_descr-sellist header = ls_descr-header
      namtab = ls_descr-namtab fielddescr = ls_descr-descr
    EXCEPTIONS no_table_name = 1 no_tvdir_entry = 2
      table_not_found = 3 table_to_large = 4
      ddif_internal_error = 5 table_unsuitable = 6
      error_message = 7 OTHERS = 8.
  IF sy-subrc <> 0 OR ls_descr-descr IS INITIAL
  OR ls_descr-descr_reduced IS NOT INITIAL
  OR ls_descr-clnt_fld <> 'MANDT'
  OR ls_descr-tablen <= 0 OR ls_descr-tablen > scpr_maxdatalen
  OR ls_descr-keylen <= 0 OR ls_descr-keylen > scpr_maxkeylen
  OR ls_descr-ckeylen <> ls_descr-keylen.
    p_code = 'DESCRIPTOR_FAILED'. RETURN.
  ENDIF.
" FIELDDEF 不填记录身份，必须从已核实的固定 RECATTR 赋值。
  ls_descr-tabname = p_attr-tablename. ls_descr-tabtype = lv_typecode.
  ls_descr-objname = p_attr-objectname.
  ls_descr-objtype = p_attr-objecttype.
  ls_descr-activity = p_attr-activity.
  DESCRIBE FIELD <copy> LENGTH lv_rowbytes IN BYTE MODE.
  IF lv_rowbytes <> ls_descr-tablen.
    p_code = 'DESCRIPTOR_FAILED'. RETURN.
  ENDIF.
  LOOP AT ls_descr-descr INTO ls_field.
    ADD 1 TO lv_fields.
    IF lv_names IS INITIAL. lv_names = ls_field-fieldname.
    ELSE.
      CONCATENATE lv_names ls_field-fieldname INTO lv_names
        SEPARATED BY ','.
    ENDIF.
    ASSIGN COMPONENT ls_field-fieldname OF STRUCTURE p_row TO <value>.
    IF sy-subrc <> 0.
      p_code = 'DESCRIPTOR_FAILED'. RETURN.
    ENDIF.
    DESCRIBE FIELD <value> TYPE lv_type.
    DESCRIBE FIELD <value> LENGTH lv_len IN BYTE MODE.
    IF lv_type <> ls_field-vtype OR lv_len <> ls_field-intlen
    OR lv_type NA 'CNDTIPFs' OR ls_field-maxbcslen > 255
    OR ls_field-readonly = 'R'
    OR ls_field-datatype = 'CURR' OR ls_field-datatype = 'QUAN'
    OR ( lv_type = 's' AND
      ( ls_field-datatype <> 'INT2' OR lv_len <> 2 ) ).
      p_code = 'DESCRIPTOR_UNSUPPORTED'. RETURN.
    ENDIF.
    IF ls_field-keyflag = 'X'.
      IF lv_type NA 'CNDT' OR ls_field-position <> lv_keybytes
      OR ls_field-flag <> 'FKY'.
        p_code = 'DESCRIPTOR_FAILED'. RETURN.
      ENDIF.
      ADD 1 TO lv_keys. ADD lv_len TO lv_keybytes.
      ASSIGN COMPONENT ls_field-fieldname OF STRUCTURE <key>
        TO <keyvalue>.
      IF sy-subrc <> 0.
        p_code = 'DESCRIPTOR_FAILED'. RETURN.
      ENDIF.
      <keyvalue> = <value>.
    ELSE.
      IF ls_field-flag <> 'USE'.
        p_code = 'DESCRIPTOR_UNSUPPORTED'. RETURN.
      ENDIF.
      IF p_delete = 'X'. CONTINUE. ENDIF.
    ENDIF.
    CLEAR lv_external.
    CALL FUNCTION 'SCPR_CT_VALUE_CONVERT_INT_EXT'
      EXPORTING fielddescr = ls_field value_intern = <value>
        with_convexit = space
      IMPORTING value_extern = lv_external
      EXCEPTIONS error_message = 1 OTHERS = 2.
    IF sy-subrc <> 0.
      p_code = 'CONVERSION_FAILED'. RETURN.
    ENDIF.
    CLEAR ls_value.
    ls_value-id = p_attr-id. ls_value-version = p_attr-version.
    ls_value-tablename = p_attr-tablename.
    ls_value-recnumber = p_attr-recnumber.
    ls_value-fieldname = ls_field-fieldname.
    ls_value-flag = ls_field-flag.
    ls_value-value = lv_external. APPEND ls_value TO lt_values.
  ENDLOOP.
  IF lv_names <> lv_expected OR lv_fields = 0 OR lv_keys = 0
  OR lv_keybytes <> ls_descr-keylen OR lt_values IS INITIAL.
    p_code = 'DESCRIPTOR_FAILED'. RETURN.
  ENDIF.
  CLEAR lv_keyonly.
  IF p_delete = 'X'. lv_keyonly = 'X'. ENDIF.
  CALL FUNCTION 'SCPR_CPROF_CT_PROFDATA_CONVERT'
    EXPORTING tabname = lv_table only_key = lv_keyonly
      recnumber = p_attr-recnumber keylen = ls_descr-keylen
      values_in_int_format = space
    IMPORTING line = <copy>
    TABLES profvalues = lt_values tabledescr = ls_descr-descr
    EXCEPTIONS error_message = 1 OTHERS = 2.
  IF sy-subrc <> 0.
    p_code = 'CONVERSION_FAILED'. RETURN.
  ENDIF.
  EXPORT row = p_row TO DATA BUFFER lv_full.
  EXPORT row = <key> TO DATA BUFFER lv_key.
  EXPORT row = <copy> TO DATA BUFFER lv_copy.
  IF ( p_delete IS INITIAL AND lv_copy <> lv_full )
  OR ( p_delete = 'X' AND lv_copy <> lv_key ).
    p_code = 'ROUNDTRIP_LOSSY'. RETURN.
  ENDIF.
CATCH cx_root.
  p_code = 'CONVERSION_FAILED'. RETURN.
ENDTRY.
ls_record-ordinal = p_ordinal. ls_record-recattr = p_attr.
ls_record-descriptor = ls_descr. ls_record-values = lt_values.
ls_record-full_row = lv_full. ls_record-key_row = lv_key.
IF p_delete = 'X'. ls_record-deleteflag = 'L'. ENDIF.
p_record = ls_record. p_code = 'RECORD_PREPARED'.
ENDFORM.

FORM orv_bc_record_error USING p_table TYPE scpr_tabl
  CHANGING p_errors TYPE scp1_general_errors.
DATA ls_error TYPE scp1_general_error.
IF p_errors IS NOT INITIAL OR sy-msgid IS INITIAL. RETURN. ENDIF.
ls_error-tablename = p_table. ls_error-tabletype = 'T'.
ls_error-msgid = sy-msgid. ls_error-msgty = sy-msgty.
ls_error-msgno = sy-msgno.
ls_error-msgv1 = sy-msgv1. ls_error-msgv2 = sy-msgv2.
ls_error-msgv3 = sy-msgv3. ls_error-msgv4 = sy-msgv4.
APPEND ls_error TO p_errors.
ENDFORM.

" 外层必须先准备全部十行，校验十九键并持锁，再进入此标准维护步骤。
" 任一失败可能已产生未提交改值/关联全局数据；由外层回滚及重读。
FORM orv_bc_record_stage
  USING p_record TYPE ty_orv_bc_record p_opts TYPE scpractopt
  CHANGING p_code TYPE string p_errors TYPE scp1_general_errors.
DATA: ls_checked TYPE ty_orv_bc_record,
      lr_row TYPE REF TO data, lr_key TYPE REF TO data,
      lr_rows TYPE REF TO data, lv_count TYPE i,
      lv_subrc TYPE sy-subrc, lv_buffer TYPE xstring, lv_delete TYPE c,
      lv_group TYPE tddat-cclass.
FIELD-SYMBOLS: <row> TYPE any, <key> TYPE any,
  <actual> TYPE any, <rows> TYPE STANDARD TABLE.
CLEAR p_code. REFRESH p_errors.
IF p_opts-act_id IS INITIAL OR p_opts-act_user <> sy-uname
OR p_opts-act_system <> sy-sysid OR p_opts-act_client <> sy-mandt
OR p_opts-dialog <> 'N' OR p_opts-simulat_on <> 'N'
OR p_opts-no_standrd <> 'N' OR p_opts-actlinks <> 'W'
OR p_opts-no_commit <> 'X'.
  p_code = 'OWNER_OPTIONS_INVALID'. RETURN.
ENDIF.
IF p_record-deleteflag <> space AND p_record-deleteflag <> 'L'.
  p_code = 'INPUT_INVALID'. RETURN.
ENDIF.
IF xstrlen( p_record-full_row ) = 0
OR xstrlen( p_record-full_row ) > 65536
OR xstrlen( p_record-key_row ) = 0
OR xstrlen( p_record-key_row ) > 65536.
  p_code = 'BUFFER_INVALID'. RETURN.
ENDIF.
SELECT SINGLE cclass INTO lv_group FROM tddat
  WHERE tabname = p_record-recattr-tablename.
IF sy-subrc <> 0 OR lv_group IS INITIAL. lv_group = '&NC&'. ENDIF.
AUTHORITY-CHECK OBJECT 'S_TABU_DIS'
  ID 'ACTVT' FIELD '02' ID 'DICBERCLS' FIELD lv_group.
IF sy-subrc <> 0.
  AUTHORITY-CHECK OBJECT 'S_TABU_NAM'
    ID 'ACTVT' FIELD '02' ID 'TABLE' FIELD p_record-recattr-tablename.
  IF sy-subrc <> 0. p_code = 'AUTHORIZATION_DENIED'. RETURN. ENDIF.
ENDIF.
TRY.
  CASE p_record-recattr-tablename.
    WHEN 'T006'. CREATE DATA lr_row TYPE t006.
    WHEN 'T006A'. CREATE DATA lr_row TYPE t006a.
    WHEN 'T006B'. CREATE DATA lr_row TYPE t006b.
    WHEN 'T006C'. CREATE DATA lr_row TYPE t006c.
    WHEN OTHERS. p_code = 'ROW_SCOPE_INVALID'. RETURN.
  ENDCASE.
  ASSIGN lr_row->* TO <row>.
  CREATE DATA lr_key LIKE <row>. ASSIGN lr_key->* TO <key>.
  CREATE DATA lr_rows TYPE STANDARD TABLE OF (p_record-recattr-tablename).
  ASSIGN lr_rows->* TO <rows>.
  IMPORT row = <row> FROM DATA BUFFER p_record-full_row.
  IF sy-subrc <> 0. p_code = 'BUFFER_INVALID'. RETURN. ENDIF.
  EXPORT row = <row> TO DATA BUFFER lv_buffer.
  IF lv_buffer <> p_record-full_row.
    p_code = 'BUFFER_INVALID'. RETURN.
  ENDIF.
  CLEAR lv_delete.
  IF p_record-deleteflag = 'L'. lv_delete = 'X'. ENDIF.
  PERFORM orv_bc_record_prepare
    USING p_record-ordinal p_record-recattr <row> lv_delete
    CHANGING ls_checked p_code.
  IF p_code <> 'RECORD_PREPARED'. RETURN. ENDIF.
  IF ls_checked <> p_record.
    p_code = 'RECORD_CHANGED'. RETURN.
  ENDIF.
  IMPORT row = <key> FROM DATA BUFFER ls_checked-key_row.
  IF sy-subrc <> 0. p_code = 'BUFFER_INVALID'. RETURN. ENDIF.
  CLEAR: sy-msgid, sy-msgty, sy-msgno, sy-msgv1, sy-msgv2, sy-msgv3, sy-msgv4.
  CALL FUNCTION 'SCPR_DB_TABLE_RECORDS_GET'
    EXPORTING tabname = ls_checked-recattr-tablename
      key = <key> keylng = ls_checked-descriptor-keylen
    TABLES records = <rows>
    EXCEPTIONS db_error = 1 not_found = 2 wrong_param = 3
      error_message = 4 OTHERS = 5.
  lv_subrc = sy-subrc. DESCRIBE TABLE <rows> LINES lv_count.
  IF lv_subrc <> 0 AND lv_subrc <> 2.
    PERFORM orv_bc_record_error USING ls_checked-recattr-tablename
      CHANGING p_errors.
    p_code = 'STANDARD_READ_FAILED'. RETURN.
  ENDIF.
  IF lv_delete IS INITIAL.
    IF lv_subrc <> 2 OR lv_count <> 0.
      p_code = 'BEFORE_ROW_CHANGED'. RETURN.
    ENDIF.
  ELSE.
    IF lv_subrc <> 0 OR lv_count <> 1.
      p_code = 'BEFORE_ROW_CHANGED'. RETURN.
    ENDIF.
    READ TABLE <rows> INDEX 1 ASSIGNING <actual>.
    IF sy-subrc <> 0. p_code = 'READBACK_FAILED'. RETURN. ENDIF.
    EXPORT row = <actual> TO DATA BUFFER lv_buffer.
    IF lv_buffer <> ls_checked-full_row.
      p_code = 'BEFORE_ROW_CHANGED'. RETURN.
    ENDIF.
  ENDIF.
  CLEAR: sy-msgid, sy-msgty, sy-msgno, sy-msgv1, sy-msgv2, sy-msgv3, sy-msgv4.
  CALL FUNCTION 'SCPR_PRSET_CT_ONE_TABLE_LOAD'
    EXPORTING tablename = ls_checked-recattr-tablename
      objectname = ls_checked-recattr-objectname
      deleteflag = ls_checked-deleteflag actopts = p_opts
      tabledescr = ls_checked-descriptor values = ls_checked-values
      values_in_int_format = space
    IMPORTING errors = p_errors
    EXCEPTIONS error_message = 1 OTHERS = 2.
  IF sy-subrc <> 0 OR p_errors IS NOT INITIAL.
    PERFORM orv_bc_record_error USING ls_checked-recattr-tablename
      CHANGING p_errors.
    p_code = 'STANDARD_MAINTENANCE_FAILED'. RETURN.
  ENDIF.
  REFRESH <rows>.
  CLEAR: sy-msgid, sy-msgty, sy-msgno, sy-msgv1, sy-msgv2, sy-msgv3, sy-msgv4.
  CALL FUNCTION 'SCPR_DB_TABLE_RECORDS_GET'
    EXPORTING tabname = ls_checked-recattr-tablename
      key = <key> keylng = ls_checked-descriptor-keylen
    TABLES records = <rows>
    EXCEPTIONS db_error = 1 not_found = 2 wrong_param = 3
      error_message = 4 OTHERS = 5.
  lv_subrc = sy-subrc. DESCRIBE TABLE <rows> LINES lv_count.
  IF lv_subrc <> 0 AND lv_subrc <> 2.
    PERFORM orv_bc_record_error USING ls_checked-recattr-tablename
      CHANGING p_errors.
    p_code = 'STANDARD_READ_FAILED'. RETURN.
  ENDIF.
  IF lv_delete = 'X'.
    IF lv_subrc <> 2 OR lv_count <> 0.
      p_code = 'READBACK_FAILED'. RETURN.
    ENDIF.
  ELSE.
    IF lv_subrc <> 0 OR lv_count <> 1.
      p_code = 'READBACK_FAILED'. RETURN.
    ENDIF.
    READ TABLE <rows> INDEX 1 ASSIGNING <actual>.
    IF sy-subrc <> 0. p_code = 'READBACK_FAILED'. RETURN. ENDIF.
    EXPORT row = <actual> TO DATA BUFFER lv_buffer.
    IF lv_buffer <> ls_checked-full_row.
      p_code = 'READBACK_FAILED'. RETURN.
    ENDIF.
  ENDIF.
CATCH cx_root.
  p_code = 'STANDARD_MAINTENANCE_FAILED'. RETURN.
ENDTRY.
p_code = 'RECORD_STAGED'.
ENDFORM.

" 两遍处理：全部行先准备，第二遍标准维护；不把暂存当作已提交。
FORM orv_bc_records_stage
  USING p_records TYPE ty_orv_bc_records p_delete TYPE c
  CHANGING p_opts TYPE scpractopt p_code TYPE string
    p_errors TYPE scp1_general_errors p_staged TYPE i p_failed TYPE i.
DATA: lt_records TYPE ty_orv_bc_records, ls_record TYPE ty_orv_bc_record,
      ls_checked TYPE ty_orv_bc_record, lr_row TYPE REF TO data,
      lv_count TYPE i, lv_ordinal TYPE i, lv_deleteflag TYPE c.
FIELD-SYMBOLS <row> TYPE any.
CLEAR: p_code, p_staged, p_failed. REFRESH p_errors.
IF p_delete <> space AND p_delete <> 'X'.
  p_code = 'INPUT_INVALID'. RETURN.
ENDIF.
DESCRIBE TABLE p_records LINES lv_count.
IF lv_count <> 10. p_code = 'BATCH_SCOPE_INVALID'. RETURN. ENDIF.
IF p_opts-act_id IS INITIAL OR p_opts-act_user <> sy-uname
OR p_opts-act_system <> sy-sysid OR p_opts-act_client <> sy-mandt
OR p_opts-dialog <> 'N' OR p_opts-simulat_on <> 'N'
OR p_opts-no_standrd <> 'N' OR p_opts-actlinks <> 'W'
OR p_opts-no_commit <> 'X'.
  p_code = 'OWNER_OPTIONS_INVALID'. RETURN.
ENDIF.
lt_records = p_records. SORT lt_records BY ordinal.
IF p_delete = 'X'. lv_deleteflag = 'L'. ENDIF.
LOOP AT lt_records INTO ls_record.
  p_failed = sy-tabix.
  IF ls_record-ordinal <> p_failed
  OR ls_record-deleteflag <> lv_deleteflag
  OR xstrlen( ls_record-full_row ) = 0
  OR xstrlen( ls_record-full_row ) > 65536.
    p_code = 'BATCH_SCOPE_INVALID'. RETURN.
  ENDIF.
  TRY.
    CASE ls_record-recattr-tablename.
      WHEN 'T006'. CREATE DATA lr_row TYPE t006.
      WHEN 'T006A'. CREATE DATA lr_row TYPE t006a.
      WHEN 'T006B'. CREATE DATA lr_row TYPE t006b.
      WHEN 'T006C'. CREATE DATA lr_row TYPE t006c.
      WHEN OTHERS. p_code = 'ROW_SCOPE_INVALID'. RETURN.
    ENDCASE.
    ASSIGN lr_row->* TO <row>.
    IMPORT row = <row> FROM DATA BUFFER ls_record-full_row.
    IF sy-subrc <> 0. p_code = 'BUFFER_INVALID'. RETURN. ENDIF.
    PERFORM orv_bc_record_prepare
      USING ls_record-ordinal ls_record-recattr <row> p_delete
      CHANGING ls_checked p_code.
    IF p_code <> 'RECORD_PREPARED'. RETURN. ENDIF.
    IF ls_checked <> ls_record. p_code = 'RECORD_CHANGED'. RETURN. ENDIF.
  CATCH cx_root.
    p_code = 'BUFFER_INVALID'. RETURN.
  ENDTRY.
ENDLOOP.
" 正式关联的临时集合每批次初始化一次，不能逐行重置。
p_opts-act_date = sy-datum. p_opts-act_time = sy-uzeit.
CALL FUNCTION 'SCPR_HI_SET_GLOBAL_ACTOPTS'
  EXPORTING actlinks = p_opts-actlinks no_standrd = p_opts-no_standrd
  EXCEPTIONS error_message = 1 OTHERS = 2.
IF sy-subrc <> 0. p_code = 'LINK_INITIALIZATION_FAILED'. RETURN. ENDIF.
CALL FUNCTION 'SCPR_HIST_CT_REMEMBER_TIME'
  EXPORTING moddate = p_opts-act_date modtime = p_opts-act_time
  EXCEPTIONS error_message = 1 OTHERS = 2.
IF sy-subrc <> 0. p_code = 'LINK_INITIALIZATION_FAILED'. RETURN. ENDIF.
DO 10 TIMES.
  lv_ordinal = sy-index.
  IF p_delete = 'X'. lv_ordinal = 11 - lv_ordinal. ENDIF.
  READ TABLE lt_records INDEX lv_ordinal INTO ls_record.
  p_failed = lv_ordinal.
  IF sy-subrc <> 0. p_code = 'BATCH_SCOPE_INVALID'. RETURN. ENDIF.
  PERFORM orv_bc_record_stage USING ls_record p_opts
    CHANGING p_code p_errors.
  IF p_code <> 'RECORD_STAGED'. RETURN. ENDIF.
  ADD 1 TO p_staged.
ENDDO.
CLEAR p_failed. p_code = 'BATCH_STAGED'.
ENDFORM.