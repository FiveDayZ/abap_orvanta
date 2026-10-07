import { createHash } from "node:crypto"
import { z } from "zod"
import { configurationUnitApiBody } from "./configuration-unit-api.js"

// Local deployment candidate only. Active SAP source must match before dispatch.
export const configurationUnitApplyApi = {
  functionName: "Z_ORVANTA_CFG_UNIT_APPLY",
  remoteEnabled: true,
  importParameters: [
    "IV_UNIT_KEY",
    "IV_LANGUAGE",
    "IV_EXPECTED_VERSION",
    "IV_SET_MSEHT",
    "IV_MSEHT",
    "IV_SET_MSEHL",
    "IV_MSEHL",
    "IV_REQUEST",
    "IV_TASK"
  ].map((name) => ({ name, typeName: "STRING", optional: false, passByValue: true })),
  exportParameters: [
    "EV_CODE",
    "EV_SYSTEM",
    "EV_CLIENT",
    "EV_USER",
    "EV_COMMITTED",
    "EV_BEFORE_VERSION",
    "EV_TEXT_VERSION",
    "EV_TASK",
    "EV_TABKEY",
    "EV_MSGID",
    "EV_MSGNO",
    "ES_TEXT"
  ].map((name) => ({
    name,
    typeName: name === "ES_TEXT" ? "T006A" : "STRING",
    optional: false,
    passByValue: true
  })),
  source: `" 此 RFC 自己拥有 LUW；仅限现有 T006A 描述，不创建单位或语言行。
DATA: lv_unit TYPE t006a-msehi,
      lv_language TYPE t006a-spras,
      lv_table TYPE tddat-tabname,
      lv_group TYPE tddat-cclass,
      lv_request TYPE e070-trkorr,
      lv_task TYPE e070-trkorr,
      lv_policy TYPE t000-cccoractiv,
      ls_parent TYPE trwbo_request_header,
      ls_header TYPE trwbo_request_header,
      ls_object TYPE e071,
      ls_checked_object TYPE e071,
      ls_key TYPE e071k,
      ls_checked_key TYPE e071k,
      lt_objects TYPE STANDARD TABLE OF e071,
      lt_keys TYPE STANDARD TABLE OF e071k,
      lv_not_lockable TYPE trpari-s_locktype,
      lv_locktype TYPE trpari-s_locktype,
      ls_before TYPE t006a,
      ls_after TYPE t006a,
      ls_readback TYPE t006a,
      lt_text TYPE STANDARD TABLE OF t006a,
      lv_read_code TYPE string,
      lv_read_system TYPE string,
      lv_read_client TYPE string,
      lv_version TYPE string,
      lv_after_version TYPE string,
      lv_unit_locked TYPE c,
      lv_request_locked TYPE c,
      lv_task_locked TYPE c,
      lv_commit_started TYPE c,
      lv_rc TYPE sy-subrc,
      lv_matches TYPE i,
      lv_hash_data TYPE string,
      lv_algorithm TYPE hashalg VALUE 'SHA2'.
CLEAR: ev_code, ev_system, ev_client, ev_user, ev_committed,
       ev_before_version,
       ev_text_version, ev_task, ev_tabkey, ev_msgid, ev_msgno, es_text.
ev_system = sy-sysid.
ev_client = sy-mandt.
ev_user = sy-uname.
IF sy-sysid <> 'GR2' OR sy-mandt <> '200'.
  ev_code = 'SCOPE_UNSUPPORTED'.
  RETURN.
ENDIF.
IF strlen( iv_unit_key ) < 1 OR strlen( iv_unit_key ) > 3
OR strlen( iv_language ) <> 1 OR strlen( iv_expected_version ) <> 64
OR iv_expected_version CN '0123456789abcdef'
OR strlen( iv_request ) <> 10 OR strlen( iv_task ) <> 10
OR iv_request = iv_task.
  ev_code = 'INPUT_INVALID'.
  RETURN.
ENDIF.
FIND REGEX '^[A-Za-z0-9]$' IN iv_language.
IF sy-subrc <> 0.
  ev_code = 'INPUT_INVALID'.
  RETURN.
ENDIF.
FIND REGEX '^GR2K[0-9]{6}$' IN iv_request.
IF sy-subrc <> 0.
  ev_code = 'INPUT_INVALID'.
  RETURN.
ENDIF.
FIND REGEX '^GR2K[0-9]{6}$' IN iv_task.
IF sy-subrc <> 0.
  ev_code = 'INPUT_INVALID'.
  RETURN.
ENDIF.
lv_unit = iv_unit_key.
lv_language = iv_language.
lv_request = iv_request.
lv_task = iv_task.
IF iv_unit_key(1) = space OR strlen( lv_unit ) <> strlen( iv_unit_key )
OR iv_unit_key CA '*|'.
  ev_code = 'INPUT_INVALID'.
  RETURN.
ENDIF.
FIND REGEX '[[:cntrl:]]' IN iv_unit_key.
IF sy-subrc = 0.
  ev_code = 'INPUT_INVALID'.
  RETURN.
ENDIF.
IF ( iv_set_mseht <> space AND iv_set_mseht <> 'X' )
OR ( iv_set_msehl <> space AND iv_set_msehl <> 'X' )
OR ( iv_set_mseht = space AND iv_set_msehl = space )
OR ( iv_set_mseht = space AND iv_mseht <> space )
OR ( iv_set_msehl = space AND iv_msehl <> space ).
  ev_code = 'INPUT_INVALID'.
  RETURN.
ENDIF.
" 空值清除仍需独立业务验收，本版仅允许非空描述。
IF ( iv_set_mseht = 'X' AND
     ( strlen( iv_mseht ) < 1 OR strlen( iv_mseht ) > 10
       OR iv_mseht CO space OR iv_mseht CP ' *' ) )
OR ( iv_set_msehl = 'X' AND
     ( strlen( iv_msehl ) < 1 OR strlen( iv_msehl ) > 30
       OR iv_msehl CO space OR iv_msehl CP ' *' ) ).
  ev_code = 'INPUT_INVALID'.
  RETURN.
ENDIF.
FIND REGEX '[[:cntrl:]]' IN iv_mseht.
IF sy-subrc = 0.
  ev_code = 'INPUT_INVALID'.
  RETURN.
ENDIF.
FIND REGEX '[[:cntrl:]]' IN iv_msehl.
IF sy-subrc = 0.
  ev_code = 'INPUT_INVALID'.
  RETURN.
ENDIF.
DO 2 TIMES.
  IF sy-index = 1.
    lv_table = 'T006'.
  ELSE.
    lv_table = 'T006A'.
  ENDIF.
  CLEAR lv_group.
  SELECT SINGLE cclass INTO lv_group FROM tddat
    WHERE tabname = lv_table.
  IF sy-subrc <> 0 OR lv_group IS INITIAL.
    lv_group = '&NC&'.
  ENDIF.
  AUTHORITY-CHECK OBJECT 'S_TABU_DIS'
    ID 'ACTVT' FIELD '02' ID 'DICBERCLS' FIELD lv_group.
  IF sy-subrc <> 0.
    ev_code = 'AUTHORIZATION_DENIED'.
    RETURN.
  ENDIF.
ENDDO.
" E_TABLE 的初始 VARKEY 在已读生成函数中变为 *，覆盖 CUNI 的维度锁。
" 不等待；该全表锁会短暂阻止其他客户端/单位的 CUNI 维护。
CALL FUNCTION 'ENQUEUE_E_TABLE'
  EXPORTING tabname = 'T006' varkey = space _scope = '1' _wait = space
  EXCEPTIONS foreign_lock = 1 system_failure = 2 OTHERS = 3.
IF sy-subrc <> 0.
  ev_code = 'UNIT_LOCK_FAILED'.
  ev_msgid = sy-msgid. ev_msgno = sy-msgno.
  RETURN.
ENDIF.
lv_unit_locked = 'X'.
TRY.
  DO 1 TIMES.
    " 仅锁指定父请求和任务；TRINT_LOCK_REQUEST 自带 COMMIT，不能复用。
    CALL FUNCTION 'ENQUEUE_E_TRKORR'
      EXPORTING trkorr = lv_request _scope = '1' _wait = space
      EXCEPTIONS foreign_lock = 1 system_failure = 2 OTHERS = 3.
    IF sy-subrc <> 0.
      ev_code = 'CTS_LOCK_FAILED'.
      ev_msgid = sy-msgid. ev_msgno = sy-msgno.
      EXIT.
    ENDIF.
    lv_request_locked = 'X'.
    CALL FUNCTION 'ENQUEUE_E_TRKORR'
      EXPORTING trkorr = lv_task _scope = '1' _wait = space
      EXCEPTIONS foreign_lock = 1 system_failure = 2 OTHERS = 3.
    IF sy-subrc <> 0.
      ev_code = 'CTS_LOCK_FAILED'.
      ev_msgid = sy-msgid. ev_msgno = sy-msgno.
      EXIT.
    ENDIF.
    lv_task_locked = 'X'.
    SELECT SINGLE cccoractiv INTO lv_policy FROM t000 BYPASSING BUFFER
      WHERE mandt = sy-mandt.
    IF sy-subrc <> 0 OR lv_policy NA '01'.
      ev_code = 'CLIENT_POLICY_UNSUPPORTED'.
      EXIT.
    ENDIF.
    " ALE_EDIT_CHECK_2 含无条件 MESSAGE I；有 CUNI 分布式规则就拒绝。
    SELECT COUNT( * ) INTO lv_matches FROM tbd72 BYPASSING BUFFER
      WHERE objekttyp = 'T' AND objektname = 'CUNI'.
    IF lv_matches > 0.
      ev_code = 'ALE_POLICY_UNSUPPORTED'.
      EXIT.
    ENDIF.
    " 标准模型读取会缓存/过滤规则；本版拒绝所有 CONDAT 记录，保守限缩范围。
    SELECT COUNT( * ) INTO lv_matches FROM tbd05 BYPASSING BUFFER
      WHERE mestyp = 'CONDAT'.
    IF lv_matches > 0.
      ev_code = 'ALE_POLICY_UNSUPPORTED'.
      EXIT.
    ENDIF.
    ls_parent-trkorr = lv_request.
    CALL FUNCTION 'TRINT_READ_REQUEST_HEADER'
      EXPORTING iv_read_e070 = 'X' iv_read_e070c = 'X'
      CHANGING cs_request = ls_parent
      EXCEPTIONS OTHERS = 1.
    IF sy-subrc <> 0 OR ls_parent-trfunction <> 'W'
    OR ls_parent-trstatus <> 'D' OR ls_parent-strkorr <> space
    OR ls_parent-client <> sy-mandt OR ls_parent-tarsystem = space.
      IF sy-subrc <> 0.
        ev_msgid = sy-msgid. ev_msgno = sy-msgno.
      ENDIF.
      ev_code = 'CTS_CONTAINER_INVALID'.
      EXIT.
    ENDIF.
    ls_header-trkorr = lv_task.
    CALL FUNCTION 'TRINT_READ_REQUEST_HEADER'
      EXPORTING iv_read_e070 = 'X' iv_read_e070c = 'X'
      CHANGING cs_request = ls_header
      EXCEPTIONS OTHERS = 1.
    IF sy-subrc <> 0 OR ls_header-trfunction <> 'Q'
    OR ls_header-trstatus <> 'D' OR ls_header-strkorr <> lv_request
    OR ls_header-as4user <> sy-uname OR ls_header-client <> sy-mandt.
      IF sy-subrc <> 0.
        ev_msgid = sy-msgid. ev_msgno = sy-msgno.
      ENDIF.
      ev_code = 'CTS_CONTAINER_INVALID'.
      EXIT.
    ENDIF.
    " 锁内调用同一个只读 API，版本包含键、别名和两个描述的完整行。
    CALL FUNCTION 'Z_ORVANTA_CFG_UNIT_READ'
      EXPORTING iv_unit_key = iv_unit_key iv_language = iv_language
      IMPORTING ev_code = lv_read_code ev_system = lv_read_system
        ev_client = lv_read_client ev_text_version = lv_version
        es_text = ls_before
      EXCEPTIONS error_message = 1 OTHERS = 2.
    IF sy-subrc <> 0 OR lv_read_code <> 'READ'
    OR lv_read_system <> 'GR2' OR lv_read_client <> '200'.
      IF sy-subrc <> 0.
        ev_msgid = sy-msgid. ev_msgno = sy-msgno.
      ENDIF.
      ev_code = 'READ_PRECONDITION_FAILED'.
      EXIT.
    ENDIF.
    IF lv_version <> iv_expected_version.
      ev_code = 'TEXT_VERSION_CHANGED'.
      EXIT.
    ENDIF.
    " 表缓冲读不作为锁内新鲜度证据，必须与数据库完整行一致。
    SELECT SINGLE mandt spras msehi mseh3 mseh6 mseht msehl
      INTO CORRESPONDING FIELDS OF ls_readback
      FROM t006a BYPASSING BUFFER
      WHERE spras = lv_language AND msehi = lv_unit.
    IF sy-subrc <> 0 OR ls_readback <> ls_before.
      ev_code = 'TEXT_VERSION_CHANGED'.
      EXIT.
    ENDIF.
    ls_after = ls_before.
    IF iv_set_mseht = 'X'. ls_after-mseht = iv_mseht. ENDIF.
    IF iv_set_msehl = 'X'. ls_after-msehl = iv_msehl. ENDIF.
    IF ls_after = ls_before.
      ev_code = 'NO_CHANGES'.
      ev_before_version = lv_version.
      ev_text_version = lv_version.
      es_text = ls_before.
      EXIT.
    ENDIF.
    ls_object-pgmid = 'R3TR'.
    ls_object-object = 'TDAT'.
    ls_object-obj_name = 'CUNI'.
    ls_object-objfunc = 'K'.
    CALL FUNCTION 'TR_REQ_CHECK_OBJECT'
      EXPORTING is_object = ls_object is_request_header = ls_header
        iv_check_lockability = 'X' iv_dialog = space
        iv_release_checks = space
      IMPORTING es_object = ls_checked_object
        ev_object_not_lockable = lv_not_lockable
        ev_locktype = lv_locktype
      EXCEPTIONS error_message = 1 OTHERS = 2.
    IF sy-subrc <> 0.
      ev_code = 'CTS_OBJECT_CHECK_FAILED'.
      ev_msgid = sy-msgid. ev_msgno = sy-msgno.
      EXIT.
    ENDIF.
    " 拒绝需要版本管理/TLOCK/修复分支的对象，保持本版单一 DB LUW。
    IF lv_not_lockable <> 'X' OR lv_locktype <> space
    OR ls_checked_object-pgmid <> 'R3TR'
    OR ls_checked_object-object <> 'TDAT'
    OR ls_checked_object-obj_name <> 'CUNI'
    OR ls_checked_object-objfunc <> 'K'.
      ev_code = 'CTS_LOCKABLE_OBJECT_UNSUPPORTED'.
      EXIT.
    ENDIF.
    ls_key-pgmid = 'R3TR'.
    ls_key-object = 'TABU'.
    ls_key-objname = 'T006A'.
    ls_key-mastertype = 'TDAT'.
    ls_key-mastername = 'CUNI'.
    CONCATENATE ls_before-mandt ls_before-spras ls_before-msehi
      INTO ls_key-tabkey RESPECTING BLANKS.
    CALL FUNCTION 'TR_REQ_CHECK_KEY'
      EXPORTING is_key = ls_key is_request_header = ls_header
      IMPORTING es_key = ls_checked_key
      EXCEPTIONS error_message = 1 OTHERS = 2.
    IF sy-subrc <> 0 OR ls_checked_key-tabkey <> ls_key-tabkey
    OR ls_checked_key-pgmid <> 'R3TR' OR ls_checked_key-object <> 'TABU'
    OR ls_checked_key-objname <> 'T006A'
    OR ls_checked_key-mastertype <> 'TDAT'
    OR ls_checked_key-mastername <> 'CUNI'.
      IF sy-subrc <> 0.
        ev_msgid = sy-msgid. ev_msgno = sy-msgno.
      ENDIF.
      ev_code = 'CTS_KEY_CHECK_FAILED'.
      EXIT.
    ENDIF.
    APPEND ls_object TO lt_objects.
    APPEND ls_key TO lt_keys.
    " 继续运行标准所有权/对象/语言键校验，所有跳过检查标志均保持默认。
    CALL FUNCTION 'TRINT_APPEND_TO_COMM_ARRAYS'
      EXPORTING wi_trkorr = lv_task iv_dialog = space
      TABLES wt_e071 = lt_objects wt_e071k = lt_keys
      EXCEPTIONS error_message = 1 OTHERS = 2.
    IF sy-subrc <> 0.
      ev_code = 'CTS_APPEND_FAILED'.
      ev_msgid = sy-msgid. ev_msgno = sy-msgno.
      EXIT.
    ENDIF.
    SELECT COUNT( * ) INTO lv_matches FROM e071
      WHERE trkorr = lv_task AND pgmid = 'R3TR' AND object = 'TDAT'
        AND obj_name = 'CUNI' AND objfunc = 'K'.
    IF lv_matches < 1.
      ev_code = 'CTS_RECORDING_NOT_OBSERVED'.
      EXIT.
    ENDIF.
    SELECT COUNT( * ) INTO lv_matches FROM e071k
      WHERE trkorr = lv_task AND pgmid = 'R3TR' AND object = 'TABU'
        AND objname = 'T006A' AND mastertype = 'TDAT'
        AND mastername = 'CUNI'
        AND tabkey = ls_key-tabkey.
    IF lv_matches < 1.
      ev_code = 'CTS_RECORDING_NOT_OBSERVED'.
      EXIT.
    ENDIF.
    " 同步调用标准 UPDATE_T006A，避免 CTS 先提交而 V1 更新后失败。
    APPEND ls_after TO lt_text.
    CALL FUNCTION 'UPDATE_T006A'
      TABLES t006a_tab = lt_text
      EXCEPTIONS error_message = 1 OTHERS = 2.
    IF sy-subrc <> 0.
      ev_code = 'TEXT_UPDATE_FAILED'.
      ev_msgid = sy-msgid. ev_msgno = sy-msgno.
      EXIT.
    ENDIF.
    CLEAR ls_readback.
    SELECT SINGLE mandt spras msehi mseh3 mseh6 mseht msehl
      INTO CORRESPONDING FIELDS OF ls_readback
      FROM t006a BYPASSING BUFFER
      WHERE spras = lv_language AND msehi = lv_unit.
    IF sy-subrc <> 0 OR ls_readback <> ls_after.
      ev_code = 'TEXT_READBACK_FAILED'.
      EXIT.
    ENDIF.
    " 仍在 SAP 中按只读 API 的固定宽度 v1 格式计算真实数据库行版本。
    CONCATENATE 'T006A:v1:' sy-sysid ls_readback-mandt ls_readback-spras
      ls_readback-msehi ls_readback-mseh3 ls_readback-mseh6
      ls_readback-mseht ls_readback-msehl
      INTO lv_hash_data RESPECTING BLANKS.
    CALL FUNCTION 'CALCULATE_HASH_FOR_CHAR'
      EXPORTING alg = lv_algorithm data = lv_hash_data
      IMPORTING hashstring = lv_after_version
      EXCEPTIONS unknown_alg = 1 param_error = 2 internal_error = 3
        error_message = 4 OTHERS = 5.
    lv_rc = sy-subrc.
    IF lv_rc <> 0.
      ev_msgid = sy-msgid. ev_msgno = sy-msgno.
    ENDIF.
    TRANSLATE lv_after_version TO LOWER CASE.
    IF lv_rc <> 0 OR strlen( lv_after_version ) <> 64
    OR lv_after_version CN '0123456789abcdef'
    OR lv_after_version = lv_version.
      ev_code = 'TEXT_READBACK_FAILED'.
      EXIT.
    ENDIF.
    lv_commit_started = 'X'.
    COMMIT WORK AND WAIT.
    IF sy-subrc <> 0.
      ev_code = 'COMMIT_UNCERTAIN'.
      EXIT.
    ENDIF.
    ev_code = 'APPLIED'.
    ev_committed = 'X'.
    ev_before_version = lv_version.
    ev_text_version = lv_after_version.
    ev_task = lv_task.
    CONCATENATE ls_before-mandt ls_before-spras ls_before-msehi
      INTO ev_tabkey RESPECTING BLANKS.
    es_text = ls_readback.
  ENDDO.
CATCH cx_root.
  IF lv_commit_started = 'X'.
    ev_code = 'COMMIT_UNCERTAIN'.
  ELSE.
    ev_code = 'EXECUTION_FAILED'.
  ENDIF.
ENDTRY.
IF ev_code <> 'APPLIED' AND ev_code <> 'NO_CHANGES'.
  CLEAR: ev_before_version, ev_text_version, ev_task, ev_tabkey,
         es_text.
ENDIF.
IF lv_commit_started <> 'X'.
  ROLLBACK WORK.
ENDIF.
" 仅释放本次拥有的锁，不执行 DEQUEUE_ALL。
IF lv_task_locked = 'X'.
  CALL FUNCTION 'DEQUEUE_E_TRKORR'
    EXPORTING trkorr = lv_task _scope = '1'.
ENDIF.
IF lv_request_locked = 'X'.
  CALL FUNCTION 'DEQUEUE_E_TRKORR'
    EXPORTING trkorr = lv_request _scope = '1'.
ENDIF.
IF lv_unit_locked = 'X'.
  CALL FUNCTION 'DEQUEUE_E_TABLE'
    EXPORTING tabname = 'T006' varkey = space _scope = '1'.
ENDIF.`.split("\n")
} as const

const expectedBody = configurationUnitApiBody(configurationUnitApplyApi.source)
export const configurationUnitApplyApiBodyFingerprint = createHash("sha256")
  .update(expectedBody)
  .digest("hex")
const parameter = z.object({
  name: z.string(),
  typeName: z.string(),
  optional: z.boolean(),
  passByValue: z.boolean()
})
const definitionSchema = z.object({
  connectionId: z.literal("w200"),
  functionName: z.literal(configurationUnitApplyApi.functionName),
  remoteEnabled: z.literal(true),
  updateTask: z.literal(false),
  updateTaskMode: z.literal(""),
  importParameters: z.array(parameter),
  exportParameters: z.array(parameter),
  changingParameters: z.array(z.never()),
  tableParameters: z.array(z.never()),
  exceptions: z.array(z.never()),
  source: z.array(z.string()),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  interfaceFingerprint: z.string().regex(/^[a-f0-9]{64}$/)
})
export function attestConfigurationUnitApplyApi(raw: unknown) {
  const parsed = definitionSchema.safeParse(raw)
  if (!parsed.success) throw Error("CONFIGURATION_UNIT_APPLY_API_NOT_ATTESTED")
  const value = parsed.data
  const sorted = (entries: unknown[]) =>
    JSON.stringify([...entries].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
  const headers = value.source.filter((line) => /^\s*FUNCTION\s+/i.test(line))
  if (
    headers.length !== 1 ||
    headers[0]!.trim().toUpperCase() !== `FUNCTION ${configurationUnitApplyApi.functionName}.` ||
    sorted(value.importParameters) !== sorted([...configurationUnitApplyApi.importParameters]) ||
    sorted(value.exportParameters) !== sorted([...configurationUnitApplyApi.exportParameters]) ||
    configurationUnitApiBody(value.source) !== expectedBody
  )
    throw Error("CONFIGURATION_UNIT_APPLY_API_NOT_ATTESTED")
  return value
}
