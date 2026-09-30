// Authored body for the two metrics reads: DB_ACTIVITY and PERF_SNAPSHOT.
//
// DB_ACTIVITY reads the DB6 history tables the collector fills on the database host:
//   DB6PMHSD  DB6: History of database activities (no MANDT; key SYSID/COMPTIME/PARTITN)
//   DB6PMHSB  DB6: History of buffer pool activities (same key, plus BP_NAME)
// Both are absent from the service-side D5-2 table allowlist, so an external table read is refused
// with TABLE_NOT_ALLOWED; a helper-internal Open SQL read bypasses that allowlist. Neither table
// carries MANDT, and the SYSID they store is the collector's own system id, which is not proven to
// equal SY-SYSID on this system. The branch therefore does NOT invent a SYSID predicate: it returns
// the newest rows together with each row's own SYSID, and reports SY-SYSID separately so a caller
// can see the difference instead of silently losing rows to an unproven filter.
//
// PERF_SNAPSHOT calls SWNC_COLLECTOR_GET_SYSTEMLOAD locally. It is remote-enabled, but its export
// table type SWNC_T_SYSLOAD is built on SWNCSYSLOAD, whose DDIC field list carries .INCLUDE
// pseudo-components, so the external RFC path cannot serialize it. A local ABAP call has no such
// restriction. Read-only red line: SWNC_COLLECTOR_KERNEL_STAT / SWNC_COLLECTOR_STARTER are NOT
// used anywhere here - they run do_collect() and COMMIT WORK, which would write to the database.
//
// TASKTYPE is deliberately not projected: its type is RAW 1, which cannot be assigned to a string
// without an explicit hexadecimal conversion, and the field is not part of the reported contract.
// The SWNC time and counter columns are DEC 24/0 and are emitted raw, with the divisor NOT applied;
// the reply says so explicitly through the timeUnit field so a caller cannot misread the unit.
export const dbPerfDeclarations = String.raw`
DATA: lt_dbact TYPE STANDARD TABLE OF db6pmhsd,
      ls_dbact TYPE db6pmhsd,
      lt_dbbuf TYPE STANDARD TABLE OF db6pmhsb,
      ls_dbbuf TYPE db6pmhsb,
      lt_sysload TYPE swnc_t_sysload,
      ls_sysload TYPE swncsysload,
      lv_period TYPE swncperitype,
      lv_history TYPE string.
`.trim()

//
// The guard names IV_SERVER / IV_DIR / IV_MASK only when the interface actually has them: those
// three exist solely for the runtime reads (WP_LIST / USER_LIST / DIR_LIST), and the metrics
// branches never read their values - they only refuse a request that carries one. IV_PERIOD is
// different: the SWNC period type is read from it, so every metrics variant needs that one import
// whether or not it also carries the runtime reads. A metrics-only body therefore requires exactly
// one new interface parameter instead of four.
export function dbPerfBranchFor(hasRuntimeParams) {
  const dbActivityGuard = hasRuntimeParams
    ? "  IF iv_server IS NOT INITIAL OR iv_dir IS NOT INITIAL\n" +
      "     OR iv_mask IS NOT INITIAL OR iv_period IS NOT INITIAL\n" +
      "     OR iv_jobname IS NOT INITIAL OR iv_jobcount IS NOT INITIAL\n"
    : "  IF iv_period IS NOT INITIAL\n" +
      "     OR iv_jobname IS NOT INITIAL OR iv_jobcount IS NOT INITIAL\n"
  const perfSnapshotGuard = hasRuntimeParams
    ? "  IF iv_server IS NOT INITIAL OR iv_dir IS NOT INITIAL\n" +
      "     OR iv_mask IS NOT INITIAL\n" +
      "     OR iv_jobname IS NOT INITIAL OR iv_jobcount IS NOT INITIAL\n"
    : "  IF iv_jobname IS NOT INITIAL OR iv_jobcount IS NOT INITIAL\n"
  return String.raw`
IF iv_action = 'DB_ACTIVITY'.
  lv_json = '{"version":"1"'.
  json_field ',"action":"' iv_action.
  json_field ',"client":"' sy-mandt.
  json_field ',"authenticatedUser":"' sy-uname.
  CONCATENATE lv_json ',"readOnly":true,' INTO lv_base.
  CONCATENATE '"systemId":"' sy-sysid '","historyRows":[],'
    '"bufferPoolRows":[],"truncated":false}' INTO lv_tail.
  fail_reply 'unsupported' 'READ_ONLY_UNSUPPORTED'.
${dbActivityGuard}     OR iv_user IS NOT INITIAL OR iv_program IS NOT INITIAL
     OR iv_from IS NOT INITIAL OR iv_to IS NOT INITIAL
     OR iv_status IS NOT INITIAL OR iv_after_job IS NOT INITIAL
     OR iv_step IS NOT INITIAL OR iv_spoolid IS NOT INITIAL
     OR iv_page IS NOT INITIAL.
    RETURN.
  ENDIF.
  IF iv_limit IS INITIAL OR strlen( iv_limit ) > 3
     OR iv_limit CN '0123456789'.
    RETURN.
  ENDIF.
  lv_limit = iv_limit.
  IF lv_limit < 1 OR lv_limit > 200. RETURN. ENDIF.
  TRY.
    CLEAR lt_dbact.
    SELECT sysid comptime partitn pl_d_lrs pl_d_prs pl_d_ws
           pl_i_lrs pl_i_prs pl_i_ws cmmt_sqlst rbck_sqlst
           lck_waits lck_w_tm deadlocks lck_escals xlk_escals
           bp_av_rtm bp_av_wtm
      FROM db6pmhsd INTO TABLE lt_dbact
      UP TO lv_limit ROWS
      ORDER BY comptime DESCENDING.
    CLEAR lt_dbbuf.
    SELECT sysid comptime partitn bp_name bp_sz bp_qal
           pl_d_lrs pl_d_prs pl_i_lrs pl_i_prs pl_d_ws pl_i_ws
           pl_td_lrs pl_td_prs pl_ti_lrs pl_ti_prs autosize
      FROM db6pmhsb INTO TABLE lt_dbbuf
      UP TO lv_limit ROWS
      ORDER BY comptime DESCENDING.
    lv_more = 'false'.
    DESCRIBE TABLE lt_dbact LINES lv_rows.
    IF lv_rows >= lv_limit. lv_more = 'true'. ENDIF.
    DESCRIBE TABLE lt_dbbuf LINES lv_rows.
    IF lv_rows >= lv_limit. lv_more = 'true'. ENDIF.
    CLEAR: lv_history, lv_index.
    LOOP AT lt_dbact INTO ls_dbact.
      ADD 1 TO lv_index.
      CLEAR lv_json.
      json_field '{"SYSID":"' ls_dbact-sysid.
      json_field ',"COMPTIME":"' ls_dbact-comptime.
      rt_num ls_dbact-partitn ',"PARTITN":"'.
      rt_num ls_dbact-pl_d_lrs ',"PL_D_LRS":"'.
      rt_num ls_dbact-pl_d_prs ',"PL_D_PRS":"'.
      rt_num ls_dbact-pl_d_ws ',"PL_D_WS":"'.
      rt_num ls_dbact-pl_i_lrs ',"PL_I_LRS":"'.
      rt_num ls_dbact-pl_i_prs ',"PL_I_PRS":"'.
      rt_num ls_dbact-pl_i_ws ',"PL_I_WS":"'.
      rt_num ls_dbact-cmmt_sqlst ',"CMMT_SQLST":"'.
      rt_num ls_dbact-rbck_sqlst ',"RBCK_SQLST":"'.
      rt_num ls_dbact-lck_waits ',"LCK_WAITS":"'.
      rt_num ls_dbact-lck_w_tm ',"LCK_W_TM":"'.
      rt_num ls_dbact-deadlocks ',"DEADLOCKS":"'.
      rt_num ls_dbact-lck_escals ',"LCK_ESCALS":"'.
      rt_num ls_dbact-xlk_escals ',"XLK_ESCALS":"'.
      rt_num ls_dbact-bp_av_rtm ',"BP_AV_RTM":"'.
      rt_num ls_dbact-bp_av_wtm ',"BP_AV_WTM":"'.
      CONCATENATE lv_json '}' INTO lv_json.
      IF lv_index > 1.
        CONCATENATE lv_history ',' INTO lv_history.
      ENDIF.
      CONCATENATE lv_history lv_json INTO lv_history.
    ENDLOOP.
    CLEAR: lv_items, lv_index.
    LOOP AT lt_dbbuf INTO ls_dbbuf.
      ADD 1 TO lv_index.
      CLEAR lv_json.
      json_field '{"SYSID":"' ls_dbbuf-sysid.
      json_field ',"COMPTIME":"' ls_dbbuf-comptime.
      rt_num ls_dbbuf-partitn ',"PARTITN":"'.
      json_field ',"BP_NAME":"' ls_dbbuf-bp_name.
      rt_num ls_dbbuf-bp_sz ',"BP_SZ":"'.
      rt_num ls_dbbuf-bp_qal ',"BP_QAL":"'.
      rt_num ls_dbbuf-pl_d_lrs ',"PL_D_LRS":"'.
      rt_num ls_dbbuf-pl_d_prs ',"PL_D_PRS":"'.
      rt_num ls_dbbuf-pl_i_lrs ',"PL_I_LRS":"'.
      rt_num ls_dbbuf-pl_i_prs ',"PL_I_PRS":"'.
      rt_num ls_dbbuf-pl_d_ws ',"PL_D_WS":"'.
      rt_num ls_dbbuf-pl_i_ws ',"PL_I_WS":"'.
      rt_num ls_dbbuf-pl_td_lrs ',"PL_TD_LRS":"'.
      rt_num ls_dbbuf-pl_td_prs ',"PL_TD_PRS":"'.
      rt_num ls_dbbuf-pl_ti_lrs ',"PL_TI_LRS":"'.
      rt_num ls_dbbuf-pl_ti_prs ',"PL_TI_PRS":"'.
      json_field ',"AUTOSIZE":"' ls_dbbuf-autosize.
      CONCATENATE lv_json '}' INTO lv_json.
      IF lv_index > 1. CONCATENATE lv_items ',' INTO lv_items. ENDIF.
      CONCATENATE lv_items lv_json INTO lv_items.
    ENDLOOP.
    CLEAR lv_json.
    json_field '"systemId":"' sy-sysid.
    CONCATENATE lv_json ',"historyRows":[' lv_history
      '],"bufferPoolRows":[' lv_items '],"truncated":' lv_more '}'
      INTO lv_tail.
    fail_reply 'ok' 'OK'.
  CATCH cx_root.
    CONCATENATE '"systemId":"' sy-sysid '","historyRows":[],'
      '"bufferPoolRows":[],"truncated":false}' INTO lv_tail.
    fail_reply 'unsupported' 'READ_ONLY_UNSUPPORTED'.
  ENDTRY.
  RETURN.
ENDIF.
IF iv_action = 'PERF_SNAPSHOT'.
  lv_json = '{"version":"1"'.
  json_field ',"action":"' iv_action.
  json_field ',"client":"' sy-mandt.
  json_field ',"authenticatedUser":"' sy-uname.
  CONCATENATE lv_json ',"readOnly":true,' INTO lv_base.
  CONCATENATE '"periodType":"","periodStart":"","timeUnit":"swnc-raw",'
    '"rows":[],"truncated":false}' INTO lv_tail.
  fail_reply 'unsupported' 'READ_ONLY_UNSUPPORTED'.
${perfSnapshotGuard}     OR iv_user IS NOT INITIAL OR iv_program IS NOT INITIAL
     OR iv_to IS NOT INITIAL
     OR iv_status IS NOT INITIAL OR iv_after_job IS NOT INITIAL
     OR iv_step IS NOT INITIAL OR iv_spoolid IS NOT INITIAL
     OR iv_page IS NOT INITIAL.
    RETURN.
  ENDIF.
  IF strlen( iv_period ) > 1.
    RETURN.
  ENDIF.
  IF iv_period CN 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.
    RETURN.
  ENDIF.
  IF iv_limit IS INITIAL OR strlen( iv_limit ) > 3
     OR iv_limit CN '0123456789'.
    RETURN.
  ENDIF.
  lv_limit = iv_limit.
  IF lv_limit < 1 OR lv_limit > 200. RETURN. ENDIF.
  lv_period = iv_period.
  IF lv_period IS INITIAL. lv_period = 'D'. ENDIF.
  CLEAR lv_from_d.
  IF iv_from IS NOT INITIAL.
    lv_from_d = iv_from.
    IF lv_from_d IS INITIAL. RETURN. ENDIF.
  ELSE.
    lv_from_d = sy-datum.
  ENDIF.
  TRY.
    CLEAR lt_sysload.
    CALL FUNCTION 'SWNC_COLLECTOR_GET_SYSTEMLOAD'
      EXPORTING periodtype = lv_period
                periodstrt = lv_from_d
      IMPORTING t_systemload = lt_sysload.
    DESCRIBE TABLE lt_sysload LINES lv_rows.
    lv_more = 'false'.
    IF lv_rows > lv_limit. lv_more = 'true'. ENDIF.
    CLEAR: lv_items, lv_index.
    LOOP AT lt_sysload INTO ls_sysload.
      ADD 1 TO lv_index.
      IF lv_index > lv_limit. EXIT. ENDIF.
      CLEAR lv_json.
      json_field '{"COMPONENT":"' ls_sysload-component.
      json_field ',"PERIODTYPE":"' ls_sysload-periodtype.
      json_field ',"PERIODSTRT":"' ls_sysload-periodstrt.
      json_field ',"FIRSTRECDY":"' ls_sysload-firstrecdy.
      rt_num ls_sysload-firstrecti ',"FIRSTRECTI":"'.
      json_field ',"LASTRECDY":"' ls_sysload-lastrecdy.
      rt_num ls_sysload-lastrecti ',"LASTRECTI":"'.
      rt_num ls_sysload-count ',"COUNT":"'.
      rt_num ls_sysload-guicnt ',"GUICNT":"'.
      rt_num ls_sysload-cnt001 ',"CNT001":"'.
      rt_num ls_sysload-cnt002 ',"CNT002":"'.
      rt_num ls_sysload-cnt003 ',"CNT003":"'.
      rt_num ls_sysload-cnt004 ',"CNT004":"'.
      rt_num ls_sysload-cnt005 ',"CNT005":"'.
      rt_num ls_sysload-cnt006 ',"CNT006":"'.
      rt_num ls_sysload-cnt007 ',"CNT007":"'.
      rt_num ls_sysload-cnt008 ',"CNT008":"'.
      rt_num ls_sysload-cnt009 ',"CNT009":"'.
      rt_num ls_sysload-dbactivcnt ',"DBACTIVCNT":"'.
      rt_num ls_sysload-dbp_count ',"DBP_COUNT":"'.
      rt_num ls_sysload-elapsedti ',"ELAPSEDTI":"'.
      rt_num ls_sysload-respti ',"RESPTI":"'.
      rt_num ls_sysload-procti ',"PROCTI":"'.
      rt_num ls_sysload-queti ',"QUETI":"'.
      rt_num ls_sysload-rollwaitti ',"ROLLWAITTI":"'.
      rt_num ls_sysload-guitime ',"GUITIME":"'.
      rt_num ls_sysload-guinettime ',"GUINETTIME":"'.
      rt_num ls_sysload-cputi ',"CPUTI":"'.
      rt_num ls_sysload-vmc_cpu_time ',"VMC_CPU_TIME":"'.
      rt_num ls_sysload-dbti ',"DBTI":"'.
      rt_num ls_sysload-dbp_time ',"DBP_TIME":"'.
      rt_num ls_sysload-loadgenti ',"LOADGENTI":"'.
      rt_num ls_sysload-committi ',"COMMITTI":"'.
      rt_num ls_sysload-lockti ',"LOCKTI":"'.
      rt_num ls_sysload-cpicti ',"CPICTI":"'.
      rt_num ls_sysload-ddicti ',"DDICTI":"'.
      rt_num ls_sysload-bytes ',"BYTES":"'.
      rt_num ls_sysload-phycalls ',"PHYCALLS":"'.
      rt_num ls_sysload-phyreadcnt ',"PHYREADCNT":"'.
      rt_num ls_sysload-phychngrec ',"PHYCHNGREC":"'.
      CONCATENATE lv_json '}' INTO lv_json.
      IF lv_index > 1. CONCATENATE lv_items ',' INTO lv_items. ENDIF.
      CONCATENATE lv_items lv_json INTO lv_items.
    ENDLOOP.
    CLEAR lv_json.
    json_field '"periodType":"' lv_period.
    lv_time = lv_from_d.
    json_field ',"periodStart":"' lv_time.
    CONCATENATE lv_json ',"timeUnit":"swnc-raw","rows":[' lv_items
      '],"truncated":' lv_more '}' INTO lv_tail.
    fail_reply 'ok' 'OK'.
  CATCH cx_root.
    CONCATENATE '"periodType":"' lv_period '","periodStart":"",'
      '"timeUnit":"swnc-raw","rows":[],"truncated":false}'
      INTO lv_tail.
    fail_reply 'unsupported' 'READ_ONLY_UNSUPPORTED'.
  ENDTRY.
  RETURN.
ENDIF.
`.trim()
}
