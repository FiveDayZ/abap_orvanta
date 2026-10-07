FUNCTION Z_ORVANTA_CFG_BTE_META.
*"--------------------------------------------------------------------
*"*"局部接口：
*"  EXPORTING
*"     VALUE(EV_CODE) TYPE  CHAR40
*"     VALUE(EV_MESSAGE) TYPE  BAPI_MSG
*"     VALUE(EV_READ_ONLY) TYPE  XFELD
*"     VALUE(EV_FRESH) TYPE  XFELD
*"  TABLES
*"      ET_HEADER STRUCTURE  VIMDESC
*"      ET_NAMTAB STRUCTURE  VIMNAMTAB
*"      ET_EVENTS STRUCTURE  TVIMF
*"--------------------------------------------------------------------
* 固定只读元数据；不调用产品维护、锁、CTS、提交或业务函数。
  DATA: lt_header TYPE STANDARD TABLE OF vimdesc,
        lt_namtab TYPE STANDARD TABLE OF vimnamtab,
        lt_sellist TYPE STANDARD TABLE OF vimsellist,
        lt_events TYPE STANDARD TABLE OF tvimf,
        lt_events_after TYPE STANDARD TABLE OF tvimf,
        ls_header TYPE vimdesc,
        ls_directory TYPE tvdir,
        ls_directory_after TYPE tvdir,
        lv_rc TYPE sy-subrc,
        lv_count TYPE i,
        lx_error TYPE REF TO cx_root.

  CLEAR: ev_code, ev_message, ev_read_only, ev_fresh.
  REFRESH: et_header, et_namtab, et_events.
  ev_read_only = 'X'.
* SVIX 有原生缓存；返回观察值，不签发新鲜/锁内/可写许可。
  ev_code = 'SCOPE_UNSUPPORTED'.
  IF sy-sysid <> 'GR2' OR sy-mandt <> '200'.
    ev_message = 'Only GR2 client 200 is supported.'.
    RETURN.
  ENDIF.

  TRY.
      CALL FUNCTION 'VIEW_AUTHORITY_CHECK'
        EXPORTING
          view_action = 'S'
          view_name = 'TBE24'
          no_warning_for_clientindep = 'X'
        EXCEPTIONS
          invalid_action = 1
          no_authority = 2
          no_clientindependent_authority = 3
          table_not_found = 4
          no_linedependent_authority = 5
          error_message = 6
          OTHERS = 7.
      lv_rc = sy-subrc.
      IF lv_rc <> 0.
        IF lv_rc = 2 OR lv_rc = 3 OR lv_rc = 5.
          ev_code = 'AUTHORIZATION_DENIED'.
          ev_message = 'Standard TBE24 display authorization refused.'.
        ELSEIF lv_rc = 4.
          ev_code = 'ROUTE_UNSUPPORTED'.
          ev_message =
            'Standard authorization check did not find TBE24.'.
        ELSE.
          ev_code = 'NATIVE_METADATA_FAILED'.
          ev_message = 'Standard display authorization check failed.'.
        ENDIF.
        IF lv_rc <> 0 AND sy-msgid IS NOT INITIAL.
* INTO 仅构造返回文本，不弹出标准权限错误对话。
          MESSAGE ID sy-msgid TYPE 'S' NUMBER sy-msgno
            WITH sy-msgv1 sy-msgv2 sy-msgv3 sy-msgv4 INTO ev_message.
        ENDIF.
        RETURN.
      ENDIF.

      SELECT SINGLE * FROM tvdir INTO ls_directory
        WHERE tabname = 'TBE24'.
      IF sy-subrc <> 0 OR ls_directory-area <> 'BFTM'
         OR ls_directory-liste <> '0090'
         OR ls_directory-bastab <> 'X'
         OR ls_directory-newgener <> space.
        ev_code = 'ROUTE_UNSUPPORTED'.
        ev_message =
          'Registered TBE24 product route changed or is missing.'.
        RETURN.
      ENDIF.
      SELECT * FROM tvimf INTO TABLE lt_events
        WHERE tabname = 'TBE24'.
      DESCRIBE TABLE lt_events LINES lv_count.
      IF lv_count > 64.
        ev_code = 'METADATA_LIMIT_EXCEEDED'.
        ev_message =
          'Maintenance event metadata exceeds the fixed bound.'.
        RETURN.
      ENDIF.
      SORT lt_events BY tabname event.

      CALL FUNCTION 'VIEW_GET_DDIC_INFO'
        EXPORTING viewname = 'TBE24'
        TABLES
          sellist = lt_sellist
          x_header = lt_header
          x_namtab = lt_namtab
        EXCEPTIONS
          no_tvdir_entry = 1
          table_not_found = 2
          error_message = 3
          OTHERS = 4.
      IF sy-subrc <> 0.
        ev_code = 'NATIVE_METADATA_FAILED'.
        ev_message = 'Standard TBE24 control-block read failed.'.
        IF sy-msgid IS NOT INITIAL.
          MESSAGE ID sy-msgid TYPE 'S' NUMBER sy-msgno
            WITH sy-msgv1 sy-msgv2 sy-msgv3 sy-msgv4 INTO ev_message.
        ENDIF.
        RETURN.
      ENDIF.
      DESCRIBE TABLE lt_header LINES lv_count.
      IF lv_count <> 1.
        ev_code = 'METADATA_INVALID'.
        ev_message =
          'Native metadata did not return exactly one header.'.
        RETURN.
      ENDIF.
      READ TABLE lt_header INTO ls_header INDEX 1.
      IF sy-subrc <> 0 OR ls_header-viewname <> 'TBE24'
         OR ls_header-maintview <> 'TBE24'
         OR ls_header-area <> ls_directory-area
         OR ls_header-liste <> ls_directory-liste
         OR ls_header-gendate <> ls_directory-gendate
         OR ls_header-gentime <> ls_directory-gentime
         OR ls_header-bastab <> 'X'
         OR ls_header-texttab <> 'TBE24T'
         OR ls_header-texttbexst <> 'X'.
        ev_code = 'METADATA_INVALID'.
        ev_message =
          'Native header does not match the fixed product route.'.
        RETURN.
      ENDIF.
      DESCRIBE TABLE lt_namtab LINES lv_count.
      IF lv_count < 1 OR lv_count > 200.
        ev_code = 'METADATA_LIMIT_EXCEEDED'.
        ev_message =
          'Native field control blocks are empty or over limit.'.
        RETURN.
      ENDIF.

      SELECT SINGLE * FROM tvdir INTO ls_directory_after
        WHERE tabname = 'TBE24'.
      IF sy-subrc <> 0 OR ls_directory_after <> ls_directory.
        ev_code = 'METADATA_CHANGED'.
        ev_message = 'Maintenance directory changed during the read.'.
        RETURN.
      ENDIF.
      SELECT * FROM tvimf INTO TABLE lt_events_after
        WHERE tabname = 'TBE24'.
      SORT lt_events_after BY tabname event.
      IF lt_events_after <> lt_events.
        ev_code = 'METADATA_CHANGED'.
        ev_message = 'Maintenance events changed during the read.'.
        RETURN.
      ENDIF.
      et_header[] = lt_header[].
      et_namtab[] = lt_namtab[].
      et_events[] = lt_events[].
      ev_code = 'METADATA_READ_OK'.
      ev_message =
        'Read-only native metadata; cached values, not a write permit.'.
    CATCH cx_root INTO lx_error.
      REFRESH: et_header, et_namtab, et_events.
      ev_code = 'NATIVE_METADATA_FAILED'.
      ev_message = lx_error->get_text( ).
  ENDTRY.
ENDFUNCTION.
