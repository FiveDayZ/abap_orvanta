import { z } from "zod"

// Local deployment candidate. No tool registration or native call is enabled here.
export const configurationBteLockProofApi = {
  functionName: "Z_ORVANTA_CFG_BTE_LOCKCHECK",
  functionGroup: "ZORVANTA_BTE_CFG",
  remoteEnabled: true,
  updateTask: false,
  globalInterface: false,
  importParameters: [
    { name: "IV_CONFIRM", typeName: "CHAR40", optional: false, passByValue: true }
  ],
  exportParameters: [
    { name: "EV_CODE", typeName: "CHAR40", optional: false, passByValue: true },
    { name: "EV_MESSAGE", typeName: "BAPI_MSG", optional: false, passByValue: true },
    { name: "EV_COUNTS", typeName: "CHAR40", optional: false, passByValue: true },
    { name: "EV_RETAINED", typeName: "XFELD", optional: false, passByValue: true },
    { name: "EV_CLEAN", typeName: "XFELD", optional: false, passByValue: true }
  ],
  changingParameters: [],
  tableParameters: [],
  exceptions: [],
  source: String.raw`
* Fixed temporary-lock diagnostic. Does not save BTE or record CTS.
  DATA: lt_locks TYPE STANDARD TABLE OF seqg3,
        ls_lock TYPE seqg3,
        ls_request TYPE e070,
        ls_task TYPE e070,
        lv_client TYPE e070c-client,
        lv_key TYPE e070-trkorr,
        lv_owner TYPE seqg3-gusr,
        lv_update_owner TYPE seqg3-gusrvb,
        lv_owner_now TYPE seqg3-gusr,
        lv_update_now TYPE seqg3-gusrvb,
        lv_rc TYPE sy-subrc,
        lv_native_rc TYPE sy-subrc,
        lv_number TYPE sy-tabix,
        lv_lines TYPE i,
        lv_target TYPE i,
        lv_step TYPE i,
        lv_acquired TYPE i,
        lv_found TYPE i,
        lv_count TYPE i,
        lv_expected TYPE i,
        lv_failed TYPE xfeld,
        lv_cleanup_failed TYPE xfeld,
        lv_retained TYPE xfeld VALUE 'X',
        lv_counts(6) TYPE c VALUE '------',
        lv_index TYPE i,
        lx_error TYPE REF TO cx_root.
  FIELD-SYMBOLS: <owner_override> TYPE ANY,
                 <update_override> TYPE ANY,
                 <owner_replaced> TYPE ANY,
                 <update_replaced> TYPE ANY,
                 <listener> TYPE ANY.

  CLEAR: ev_code, ev_message, ev_counts, ev_retained, ev_clean.
  ev_code = 'SCOPE_UNSUPPORTED'.
  ev_message =
    'Only the approved GR2/200/WYS temporary lock probe is supported.'.
  IF sy-sysid <> 'GR2' OR sy-mandt <> '200' OR sy-uname <> 'WYS' OR
     iv_confirm <> 'TEMPORARY_LOCK_PROBE_ONLY'.
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
      IF sy-subrc <> 0.
        ev_code = 'AUTHORIZATION_DENIED'.
        ev_message = 'Native BTE display authorization was refused.'.
        RETURN.
      ENDIF.

      SELECT SINGLE trkorr trfunction trstatus korrdev as4user strkorr
        FROM e070 INTO CORRESPONDING FIELDS OF ls_request
        WHERE trkorr = 'GR2K923429'.
      IF sy-subrc <> 0 OR ls_request-trfunction <> 'W' OR
         ls_request-trstatus <> 'D' OR ls_request-korrdev <> 'CUST' OR
         ls_request-strkorr <> space.
        ev_code = 'REQUEST_SCOPE_MISMATCH'.
        RETURN.
      ENDIF.
      SELECT SINGLE trkorr trfunction trstatus korrdev as4user strkorr
        FROM e070 INTO CORRESPONDING FIELDS OF ls_task
        WHERE trkorr = 'GR2K923430'.
      IF sy-subrc <> 0 OR ls_task-trfunction <> 'Q' OR
         ls_task-trstatus <> 'D' OR ls_task-korrdev <> 'CUST' OR
         ls_task-strkorr <> ls_request-trkorr OR
         ls_task-as4user <> sy-uname.
        ev_code = 'TASK_SCOPE_MISMATCH'.
        RETURN.
      ENDIF.
      SELECT SINGLE client FROM e070c INTO lv_client
        WHERE trkorr = ls_request-trkorr.
      IF sy-subrc <> 0 OR lv_client <> sy-mandt.
        ev_code = 'REQUEST_CLIENT_MISMATCH'.
        RETURN.
      ENDIF.
      CLEAR lv_client.
      SELECT SINGLE client FROM e070c INTO lv_client
        WHERE trkorr = ls_task-trkorr.
      IF sy-subrc <> 0 OR lv_client <> sy-mandt.
        ev_code = 'TASK_CLIENT_MISMATCH'.
        RETURN.
      ENDIF.

* Get_C_owner only reads current kernel owners.
* Do not set or export them.
      PERFORM get_c_owner IN PROGRAM saplsena
        CHANGING lv_owner lv_update_owner.
      ASSIGN ('(SAPLSENA)USER_GLOB') TO <owner_override>.
      ASSIGN ('(SAPLSENA)USVB_GLOB') TO <update_override>.
      ASSIGN ('(SAPLSENA)USER_OVERWRITTEN') TO <owner_replaced>.
      ASSIGN ('(SAPLSENA)USVB_OVERWRITTEN') TO <update_replaced>.
      ASSIGN ('(SAPLSENA)GV_KAYAK_ACTIVE') TO <listener>.
      IF <owner_override> IS NOT ASSIGNED OR
         <update_override> IS NOT ASSIGNED OR
         <owner_replaced> IS NOT ASSIGNED OR
         <update_replaced> IS NOT ASSIGNED OR
         <listener> IS NOT ASSIGNED.
        ev_code = 'LOCK_ENVIRONMENT_UNVERIFIED'.
        RETURN.
      ENDIF.
      IF <owner_override> <> space OR <update_override> <> space OR
         <owner_replaced> <> space OR <update_replaced> <> space OR
         <listener> <> space OR lv_owner = space OR
         lv_update_owner = space.
        ev_code = 'LOCK_ENVIRONMENT_UNSUPPORTED'.
        RETURN.
      ENDIF.

* Conservative admission: reject any existing E070 lock,
* including generic ones.
      CALL FUNCTION 'ENQUEUE_READ'
        EXPORTING gclient = space gname = 'E070'
                  guname = space fast = 'X'
        IMPORTING number = lv_number subrc = lv_native_rc
        TABLES enq = lt_locks
        EXCEPTIONS communication_failure = 1 system_failure = 2
                   error_message = 3 OTHERS = 4.
      lv_rc = sy-subrc.
      DESCRIBE TABLE lt_locks LINES lv_lines.
      IF lv_rc <> 0 OR lv_native_rc <> 0 OR lv_number <> lv_lines.
        ev_code = 'LOCK_READ_FAILED'.
        RETURN.
      ENDIF.
      IF lv_lines <> 0.
        ev_code = 'EXISTING_E070_LOCKS'.
        ev_message =
          'Existing E070 locks were observed; no locks were acquired.'.
        RETURN.
      ENDIF.
    CATCH cx_root INTO lx_error.
      ev_code = 'LOCK_PREFLIGHT_FAILED'.
      ev_message = 'Native preflight failed before acquiring locks.'.
      RETURN.
  ENDTRY.

  ev_code = 'PROBE_RUNNING'.
  DO 2 TIMES.
    lv_target = sy-index.
    IF lv_target = 1.
      lv_key = 'GR2K923429'.
    ELSE.
      lv_key = 'GR2K923430'.
    ENDIF.
    CLEAR: lv_acquired, lv_failed.
    TRY.
        DO 3 TIMES.
          lv_step = sy-index.
          IF lv_step <= 2.
            CALL FUNCTION 'ENQUEUE_E_TRKORR'
              EXPORTING mode_e070 = 'E' trkorr = lv_key
                        _scope = '2' _wait = space _collect = space
              EXCEPTIONS foreign_lock = 1 system_failure = 2
                         error_message = 3 OTHERS = 4.
            IF sy-subrc <> 0.
              ev_code = 'LOCK_ACQUIRE_FAILED'.
              lv_failed = 'X'.
              EXIT.
            ENDIF.
            ADD 1 TO lv_acquired.
          ELSE.
            CALL FUNCTION 'DEQUEUE_E_TRKORR'
              EXPORTING mode_e070 = 'E' trkorr = lv_key
                        _scope = '3' _synchron = 'X' _collect = space.
          ENDIF.
          PERFORM get_c_owner IN PROGRAM saplsena
            CHANGING lv_owner_now lv_update_now.
          IF lv_owner_now <> lv_owner OR
             lv_update_now <> lv_update_owner.
            ev_code = 'LOCK_OWNER_CHANGED'.
            lv_failed = 'X'.
            EXIT.
          ENDIF.
          REFRESH lt_locks.
          CALL FUNCTION 'ENQUEUE_READ'
            EXPORTING gclient = space gname = 'E070'
                      guname = space fast = 'X'
            IMPORTING number = lv_number subrc = lv_native_rc
            TABLES enq = lt_locks
            EXCEPTIONS communication_failure = 1 system_failure = 2
                       error_message = 3 OTHERS = 4.
          lv_rc = sy-subrc.
          DESCRIBE TABLE lt_locks LINES lv_lines.
          IF lv_rc <> 0 OR lv_native_rc <> 0 OR lv_number <> lv_lines OR
             lv_lines > 1000.
            ev_code = 'LOCK_READ_FAILED'.
            lv_failed = 'X'.
            EXIT.
          ENDIF.
          CLEAR: lv_found, lv_count.
          LOOP AT lt_locks INTO ls_lock WHERE garg = lv_key.
            ADD 1 TO lv_found.
            IF ls_lock-gname <> 'E070' OR
               ls_lock-guname <> sy-uname OR ls_lock-guse <> 0 OR
               ls_lock-gusrvb <> lv_update_owner.
              ev_code = 'LOCK_OWNER_UNVERIFIED'.
              lv_failed = 'X'.
              EXIT.
            ENDIF.
            lv_count = ls_lock-gusevb.
          ENDLOOP.
          IF lv_failed = 'X'.
            EXIT.
          ENDIF.
          lv_expected = lv_step.
          IF lv_step = 3.
            lv_expected = 1.
          ENDIF.
          IF lv_found > 1 OR lv_count > lv_expected OR
             ( lv_step <= 2 AND
               ( lv_found <> 1 OR lv_count <> lv_step ) ) OR
             ( lv_step = 3 AND lv_found = 1 AND lv_count <> 1 ).
            ev_code = 'LOCK_COUNTS_UNVERIFIED'.
            lv_failed = 'X'.
            EXIT.
          ENDIF.
          lv_index = ( lv_target - 1 ) * 3 + lv_step - 1.
          IF lv_count = 0.
            lv_counts+lv_index(1) = '0'.
            CLEAR lv_retained.
          ELSEIF lv_count = 1.
            lv_counts+lv_index(1) = '1'.
          ELSE.
            lv_counts+lv_index(1) = '2'.
          ENDIF.
        ENDDO.
      CATCH cx_root INTO lx_error.
        ev_code = 'LOCK_NATIVE_FAILED'.
        lv_failed = 'X'.
    ENDTRY.

* Release only references successfully acquired here.
* Never use DEQUEUE_ALL.
    DO lv_acquired TIMES.
      TRY.
          CALL FUNCTION 'DEQUEUE_E_TRKORR'
            EXPORTING mode_e070 = 'E' trkorr = lv_key
                      _scope = '2' _synchron = 'X' _collect = space.
        CATCH cx_root INTO lx_error.
          lv_cleanup_failed = 'X'.
      ENDTRY.
    ENDDO.
    TRY.
        REFRESH lt_locks.
        CALL FUNCTION 'ENQUEUE_READ'
          EXPORTING gclient = space gname = 'E070'
                    guname = space fast = 'X'
          IMPORTING number = lv_number subrc = lv_native_rc
          TABLES enq = lt_locks
          EXCEPTIONS communication_failure = 1 system_failure = 2
                     error_message = 3 OTHERS = 4.
        lv_rc = sy-subrc.
        DESCRIBE TABLE lt_locks LINES lv_lines.
        IF lv_rc <> 0 OR lv_native_rc <> 0 OR lv_number <> lv_lines OR
           lv_lines > 1000.
          lv_cleanup_failed = 'X'.
        ENDIF.
        LOOP AT lt_locks INTO ls_lock WHERE garg = lv_key.
          IF ( ls_lock-guse > 0 AND ls_lock-gusr = lv_owner ) OR
             ( ls_lock-gusevb > 0 AND
               ls_lock-gusrvb = lv_update_owner ).
            lv_cleanup_failed = 'X'.
          ENDIF.
        ENDLOOP.
        PERFORM get_c_owner IN PROGRAM saplsena
          CHANGING lv_owner_now lv_update_now.
        IF lv_owner_now <> lv_owner OR lv_update_now <> lv_update_owner.
          lv_cleanup_failed = 'X'.
        ENDIF.
      CATCH cx_root INTO lx_error.
        lv_cleanup_failed = 'X'.
    ENDTRY.
    IF lv_failed = 'X' OR lv_cleanup_failed = 'X'.
      EXIT.
    ENDIF.
  ENDDO.
  IF lv_cleanup_failed = 'X'.
    ev_code = 'LOCK_CLEANUP_UNVERIFIED'.
    CONCATENATE 'Stop; independently inspect locks.'
                'Do not retry the native probe.'
      INTO ev_message SEPARATED BY space.
    RETURN.
  ENDIF.
  ev_clean = 'X'.
  IF lv_failed = 'X'.
    ev_message =
      'Native probe refused; acquired lock references were cleaned.'.
    RETURN.
  ENDIF.
  CONCATENATE lv_counts+0(1) lv_counts+1(1) lv_counts+2(1)
              lv_counts+3(1) lv_counts+4(1) lv_counts+5(1)
    INTO ev_counts SEPARATED BY ','.
  ev_retained = lv_retained.
  IF lv_retained = 'X'.
    ev_code = 'SCOPE_RETAINED'.
  ELSE.
    ev_code = 'SCOPE_NOT_RETAINED'.
  ENDIF.
  CONCATENATE 'Counts only; no proof of complete CTS'
              'or BTE save transaction safety.'
    INTO ev_message SEPARATED BY space.
`
    .trim()
    .split("\n")
} as const

/** Interpret this diagnostic only. A clean lock observation never grants a save permit. */
export function inspectConfigurationBteLockProof(raw: unknown) {
  const response = z
    .object({
      EV_CODE: z.enum(["SCOPE_RETAINED", "SCOPE_NOT_RETAINED"]),
      EV_MESSAGE: z.string().max(220),
      EV_COUNTS: z.string().regex(/^1,2,[01],1,2,[01]$/),
      EV_RETAINED: z.enum(["", "X"]),
      EV_CLEAN: z.literal("X")
    })
    .strict()
    .safeParse(raw)
  if (!response.success) throw Error("BTE_LOCK_PROOF_UNVERIFIED")
  const result = response.data
  const counts = result.EV_COUNTS.split(",").map(Number)
  const retained = counts[2] === 1 && counts[5] === 1
  if (
    (result.EV_RETAINED === "X") !== retained ||
    (result.EV_CODE === "SCOPE_RETAINED") !== retained
  )
    throw Error("BTE_LOCK_PROOF_INCONSISTENT")
  return {
    status: "lock_counts_observed" as const,
    requestNumber: "GR2K923429",
    taskNumber: "GR2K923430",
    requestCounts: counts.slice(0, 3),
    taskCounts: counts.slice(3, 6),
    callerReferenceRetainedAfterOneNativeDequeue: retained,
    cleanupObserved: true,
    ctsTransactionVerified: false,
    sessionCleanupVerified: false,
    writeAvailable: false
  }
}
