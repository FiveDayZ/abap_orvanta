import { createHash } from "node:crypto"
import { configurationUnitApiBody } from "./configuration-unit-api.js"

const strings = (names: readonly string[]) =>
  names.map((name) => ({ name, typeName: "STRING", optional: false, passByValue: true }))

// Candidate only: no tool registration, deployment or configuration mutation is enabled.
export const configurationBteStateApi = {
  functionName: "Z_ORVANTA_CFG_BTE_STATE",
  functionGroup: "ZORVANTA_BTE_CFG",
  remoteEnabled: true,
  updateTask: false,
  globalInterface: false,
  importParameters: strings(["IV_PRODUCT"]),
  exportParameters: strings([
    "EV_CODE",
    "EV_SYSTEM",
    "EV_CLIENT",
    "EV_USER",
    "EV_PRODUCT",
    "EV_ACTIVE",
    "EV_FRAME",
    "EV_VERSION",
    "EV_PROTECTED_VERSION",
    "EV_CTS_VERSION",
    "EV_ROUTE_VERSION",
    "EV_CACHE_VERSION"
  ]),
  changingParameters: [],
  tableParameters: [],
  exceptions: [],
  source: [
    "  PERFORM orv_bte_read_state USING iv_product",
    "    CHANGING ev_code ev_system ev_client ev_user ev_product",
    "    ev_active ev_frame ev_version ev_protected_version",
    "    ev_cts_version ev_route_version ev_cache_version."
  ]
} as const

// The former unreviewed draft must not masquerade as deployable SAVE/RECOVER code.
// These are command names, not stub implementations. Source is withheld until the
// native message, transaction, synchronizer and cleanup path is closed.
export const configurationBteCommandAvailability = {
  saveFunction: "Z_ORVANTA_CFG_BTE_SAVE",
  recoverFunction: "Z_ORVANTA_CFG_BTE_RECOVER",
  nativeCommandSourceAvailable: false,
  deployed: false,
  writeAvailable: false,
  automaticRetry: false,
  blockers: [
    "native_message_protocol_not_closed",
    "cts_error_rollback_and_lock_continuity_not_accepted",
    "synchronizer_static_state_cleanup_not_closed",
    "native_frame_and_cp_info_update_cleanup_not_accepted"
  ]
} as const

export const configurationBteStateInclude = {
  includeName: "LZORVANTA_BTE_CFGF80",
  source: String.raw`
* Read-only before-state candidate. No lock, SAVE, CTS write or commit.
TYPES: ty_orv_texts TYPE STANDARD TABLE OF tbe24t,
       ty_orv_events TYPE STANDARD TABLE OF tbe34,
       ty_orv_processes TYPE STANDARD TABLE OF tps34,
       ty_orv_objects TYPE STANDARD TABLE OF e071,
       ty_orv_keys TYPE STANDARD TABLE OF e071k,
       ty_orv_string_keys TYPE STANDARD TABLE OF e071k_str,
       ty_orv_headers TYPE STANDARD TABLE OF vimdesc,
       ty_orv_namtab TYPE STANDARD TABLE OF vimnamtab,
       ty_orv_controls TYPE STANDARD TABLE OF tvimf.
TYPES: BEGIN OF ty_orv_bte_state,
         system TYPE syst-sysid,
         client TYPE syst-mandt,
         username TYPE syst-uname,
         language TYPE syst-langu,
         product TYPE tbe24,
         texts TYPE ty_orv_texts,
         events TYPE ty_orv_events,
         processes TYPE ty_orv_processes,
         request TYPE e070,
         task TYPE e070,
         request_client TYPE e070c,
         task_client TYPE e070c,
         objects TYPE ty_orv_objects,
         keys TYPE ty_orv_keys,
         string_keys TYPE ty_orv_string_keys,
         cache TYPE tcont,
         directory TYPE tvdir,
         controls TYPE ty_orv_controls,
         headers TYPE ty_orv_headers,
         namtab TYPE ty_orv_namtab,
       END OF ty_orv_bte_state.

FORM orv_bte_hash USING p_raw TYPE xstring
                 CHANGING p_hash TYPE string p_code TYPE string.
  CLEAR p_hash.
  CALL FUNCTION 'CALCULATE_HASH_FOR_RAW'
    EXPORTING alg = 'SHA2' data = p_raw
    IMPORTING hashstring = p_hash
    EXCEPTIONS unknown_alg = 1 param_error = 2 internal_error = 3
               error_message = 4 OTHERS = 5.
  IF sy-subrc <> 0. p_code = 'HASH_FAILED'. RETURN. ENDIF.
  TRANSLATE p_hash TO LOWER CASE.
  IF strlen( p_hash ) <> 64 OR p_hash CN '0123456789abcdef'.
    p_code = 'HASH_FAILED'.
  ENDIF.
ENDFORM.

FORM orv_bte_read_state USING p_product TYPE string
  CHANGING r_code TYPE string r_system TYPE string
    r_client TYPE string r_user TYPE string r_product TYPE string
    r_active TYPE string r_frame TYPE string r_version TYPE string
    r_protected TYPE string r_cts TYPE string r_route TYPE string
    r_cache TYPE string.
  DATA: s TYPE ty_orv_bte_state,
        ls_protected TYPE tbe24,
        lv_product TYPE tbe24-prdkt,
        lv_raw TYPE xstring,
        lv_table TYPE tabname,
        lv_code TYPE string,
        lx_error TYPE REF TO cx_root.
  CLEAR: r_code, r_product, r_active, r_frame, r_version,
         r_protected, r_cts, r_route, r_cache.
  r_system = sy-sysid. r_client = sy-mandt. r_user = sy-uname.
  r_code = 'SCOPE_UNSUPPORTED'.
  IF sy-sysid <> 'GR2' OR sy-mandt <> '200' OR sy-uname <> 'WYS'.
    RETURN.
  ENDIF.
  IF strlen( p_product ) < 1 OR strlen( p_product ) > 8 OR
     p_product+0(1) NA 'ZY' OR
     p_product CN 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.
    r_code = 'INPUT_INVALID'. RETURN.
  ENDIF.
  lv_product = p_product.
  TRY.
      CALL FUNCTION 'VIEW_AUTHORITY_CHECK'
        EXPORTING view_action = 'S' view_name = 'TBE24'
                  no_warning_for_clientindep = 'X'
        EXCEPTIONS invalid_action = 1 no_authority = 2
          no_clientindependent_authority = 3 table_not_found = 4
          no_linedependent_authority = 5 error_message = 6 OTHERS = 7.
      IF sy-subrc <> 0. r_code = 'AUTHORIZATION_DENIED'. RETURN.
      ENDIF.
* Native view authority does not authorize arbitrary CTS/cache reads.
      DO 10 TIMES.
        CASE sy-index.
          WHEN 1. lv_table = 'TBE24'.
          WHEN 2. lv_table = 'TBE24T'.
          WHEN 3. lv_table = 'TBE34'.
          WHEN 4. lv_table = 'TPS34'.
          WHEN 5. lv_table = 'E070'.
          WHEN 6. lv_table = 'E070C'.
          WHEN 7. lv_table = 'E071'.
          WHEN 8. lv_table = 'E071K'.
          WHEN 9. lv_table = 'E071K_STR'.
          WHEN 10. lv_table = 'TCONT'.
        ENDCASE.
        AUTHORITY-CHECK OBJECT 'S_TABU_NAM'
          ID 'TABLE' FIELD lv_table ID 'ACTVT' FIELD '03'.
        IF sy-subrc <> 0.
          r_code = 'AUTHORIZATION_DENIED'. RETURN.
        ENDIF.
      ENDDO.
      s-system = sy-sysid. s-client = sy-mandt.
      s-username = sy-uname. s-language = sy-langu.
      SELECT SINGLE * FROM tbe24 INTO s-product
        WHERE prdkt = lv_product.
      IF sy-subrc <> 0. r_code = 'PRODUCT_NOT_FOUND'. RETURN.
      ENDIF.
      SELECT * FROM tbe24t INTO TABLE s-texts UP TO 201 ROWS
        WHERE prdkt = lv_product.
      SELECT * FROM tbe34 INTO TABLE s-events UP TO 201 ROWS
        WHERE prdkt = lv_product.
      SELECT * FROM tps34 INTO TABLE s-processes UP TO 201 ROWS
        WHERE prdkt = lv_product.
      IF lines( s-texts ) > 200 OR lines( s-events ) > 200 OR
         lines( s-processes ) > 200.
        r_code = 'STATE_LIMIT'. RETURN.
      ENDIF.
      SORT s-texts BY mandt spras prdkt.
      SORT s-events BY mandt event prdkt land applk.
      SORT s-processes BY mandt procs land applk.
      SELECT SINGLE * FROM e070 INTO s-request
        WHERE trkorr = 'GR2K923429'.
      IF sy-subrc <> 0. r_code = 'REQUEST_NOT_FOUND'. RETURN.
      ENDIF.
      SELECT SINGLE * FROM e070 INTO s-task
        WHERE trkorr = 'GR2K923430'.
      IF sy-subrc <> 0. r_code = 'TASK_NOT_FOUND'. RETURN. ENDIF.
      SELECT SINGLE * FROM e070c INTO s-request_client
        WHERE trkorr = 'GR2K923429'.
      IF sy-subrc <> 0. r_code = 'REQUEST_CLIENT_NOT_FOUND'. RETURN.
      ENDIF.
      SELECT SINGLE * FROM e070c INTO s-task_client
        WHERE trkorr = 'GR2K923430'.
      IF sy-subrc <> 0. r_code = 'TASK_CLIENT_NOT_FOUND'. RETURN.
      ENDIF.
* Include parent AND task. Preserve every native key character.
      SELECT * FROM e071 INTO TABLE s-objects UP TO 1001 ROWS
        WHERE trkorr = 'GR2K923429' OR trkorr = 'GR2K923430'.
      SELECT * FROM e071k INTO TABLE s-keys UP TO 1001 ROWS
        WHERE trkorr = 'GR2K923429' OR trkorr = 'GR2K923430'.
      SELECT * FROM e071k_str INTO TABLE s-string_keys UP TO 1001 ROWS
        WHERE trkorr = 'GR2K923429' OR trkorr = 'GR2K923430'.
      IF lines( s-objects ) > 1000 OR lines( s-keys ) > 1000 OR
         lines( s-string_keys ) > 1000.
        r_code = 'CTS_LIMIT'. RETURN.
      ENDIF.
      SORT s-objects BY trkorr as4pos.
      SORT s-keys BY trkorr pgmid object objname as4pos
        mastertype mastername viewname tabkey objfunc activity lang.
      SORT s-string_keys.
      SELECT SINGLE * FROM tcont INTO s-cache
        WHERE frmid = 'CP_INFO'.
      IF sy-subrc <> 0. r_code = 'CACHE_NOT_FOUND'. RETURN. ENDIF.
      SELECT SINGLE * FROM tvdir INTO s-directory
        WHERE tabname = 'TBE24'.
      IF sy-subrc <> 0. r_code = 'ROUTE_NOT_FOUND'. RETURN. ENDIF.
      SELECT * FROM tvimf INTO TABLE s-controls UP TO 65 ROWS
        WHERE tabname = 'TBE24'.
      IF lines( s-controls ) > 64.
        r_code = 'ROUTE_LIMIT'. RETURN.
      ENDIF.
      SORT s-controls BY tabname event.
      CALL FUNCTION 'VIEW_GET_DDIC_INFO'
        EXPORTING viewname = 'TBE24'
        TABLES x_header = s-headers x_namtab = s-namtab
        EXCEPTIONS no_tvdir_entry = 1 table_not_found = 2
                   error_message = 3 OTHERS = 4.
      IF sy-subrc <> 0. r_code = 'METADATA_FAILED'. RETURN. ENDIF.
      IF lines( s-headers ) <> 1 OR lines( s-namtab ) <> 8.
        r_code = 'METADATA_UNSUPPORTED'. RETURN.
      ENDIF.
* Full native serialization retains spaces, all languages and row bytes.
      EXPORT state = s TO DATA BUFFER lv_raw.
      IF xstrlen( lv_raw ) > 524288.
        r_code = 'FRAME_LIMIT'. RETURN.
      ENDIF.
      PERFORM orv_bte_hash USING lv_raw
        CHANGING r_version lv_code.
      IF lv_code <> space. r_code = lv_code. RETURN. ENDIF.
      CALL FUNCTION 'SCMS_BASE64_ENCODE_STR'
        EXPORTING input = lv_raw IMPORTING output = r_frame
        EXCEPTIONS error_message = 1 OTHERS = 2.
      IF sy-subrc <> 0. r_code = 'FRAME_FAILED'. RETURN. ENDIF.
* Protection excludes ONLY AKTIV; do not drop RFCDS or any language.
      ls_protected = s-product. CLEAR ls_protected-aktiv.
      EXPORT product = ls_protected texts = s-texts
        events = s-events processes = s-processes
        TO DATA BUFFER lv_raw.
      PERFORM orv_bte_hash USING lv_raw
        CHANGING r_protected lv_code.
      IF lv_code <> space. r_code = lv_code. RETURN. ENDIF.
      EXPORT request = s-request task = s-task
        request_client = s-request_client task_client = s-task_client
        objects = s-objects keys = s-keys string_keys = s-string_keys
        TO DATA BUFFER lv_raw.
      PERFORM orv_bte_hash USING lv_raw CHANGING r_cts lv_code.
      IF lv_code <> space. r_code = lv_code. RETURN. ENDIF.
      EXPORT directory = s-directory controls = s-controls
        headers = s-headers namtab = s-namtab TO DATA BUFFER lv_raw.
      PERFORM orv_bte_hash USING lv_raw CHANGING r_route lv_code.
      IF lv_code <> space. r_code = lv_code. RETURN. ENDIF.
      EXPORT cache = s-cache TO DATA BUFFER lv_raw.
      PERFORM orv_bte_hash USING lv_raw CHANGING r_cache lv_code.
      IF lv_code <> space. r_code = lv_code. RETURN. ENDIF.
      r_product = s-product-prdkt. r_active = s-product-aktiv.
      r_code = 'STATE_READ'.
    CATCH cx_root INTO lx_error.
      r_code = 'STATE_READ_FAILED'.
  ENDTRY.
  IF r_code <> 'STATE_READ'.
    CLEAR: r_frame, r_version, r_protected, r_cts, r_route, r_cache.
  ENDIF.
ENDFORM.
`
    .trim()
    .split("\n")
} as const

export const configurationBteStateApiFingerprint = createHash("sha256")
  .update(configurationUnitApiBody(configurationBteStateApi.source))
  .digest("hex")
export const configurationBteStateIncludeFingerprint = createHash("sha256")
  .update(configurationBteStateInclude.source.join("\n"))
  .digest("hex")
