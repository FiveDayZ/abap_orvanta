import { createHash } from "node:crypto"
import { z } from "zod"
import { configurationBcPreflightKeys } from "./configuration-bc-preflight.js"
import { configurationBcNativeLayouts } from "./configuration-bc-native-api.js"

const hex = z.string().regex(/^[a-f0-9]{64}$/)
const binding = z
  .object({
    connectionId: z.literal("w200"),
    system: z.literal("GR2"),
    client: z.literal("200"),
    user: z
      .string()
      .min(1)
      .max(12)
      .refine((value) => value.trim().length > 0),
    bcSetId: z.literal("EHS_CUNI_KNM"),
    version: z.literal("N"),
    requestNumber: z.literal("GR2K923429"),
    taskNumber: z.literal("GR2K923430"),
    beforeStateReference: hex,
    sourceVersion: hex,
    candidateVersion: hex,
    metadataVersion: hex
  })
  .strict()
const rowProof = z
  .object({
    tableName: z.string(),
    key: z.record(z.string()),
    present: z.boolean(),
    rawRowVersion: hex.nullable()
  })
  .strict()
const evidence = z
  .object({
    binding,
    before: z.array(rowProof).length(19),
    candidate: z.array(rowProof).length(19)
  })
  .strict()
type RowProof = z.infer<typeof rowProof>
const identity = (row: { tableName: string; key: Record<string, string> }) =>
  JSON.stringify([
    row.tableName,
    Object.entries(row.key).sort(([a], [b]) => a.localeCompare(b, "en"))
  ])
const normalize = (rows: RowProof[]) => {
  const found = new Map<string, RowProof>()
  const allowed = new Set(configurationBcPreflightKeys.map(identity))
  for (const row of rows) {
    const id = identity(row)
    if (!allowed.has(id) || found.has(id) || row.present !== (row.rawRowVersion !== null))
      throw Error("CONFIGURATION_BC_RECORD_SCOPE_INVALID")
    found.set(id, row)
  }
  return configurationBcPreflightKeys.map((key) => ({
    ...found.get(identity(key))!,
    tableName: key.tableName,
    key: { ...key.key }
  }))
}

/** Internal native-proof planner. Neither JS field values nor external restoration bytes are accepted. */
export function prepareConfigurationBcRecordPlan(expectedBinding: unknown, raw: unknown) {
  const expected = binding.parse(expectedBinding)
  const input = evidence.parse(raw)
  if (JSON.stringify(input.binding) !== JSON.stringify(expected))
    throw Error("CONFIGURATION_BC_RECORD_BINDING_INVALID")
  const before = normalize(input.before)
  const candidate = normalize(input.candidate)
  const save: Array<{
    ordinal: number
    tableName: string
    key: Record<string, string>
    beforeRowVersion: null
    candidateRowVersion: string
  }> = []
  const protectedRows: RowProof[] = []
  for (let i = 0; i < before.length; i++) {
    const old = before[i]!
    const next = candidate[i]!
    if (i < 10) {
      if (old.present || !next.present)
        throw Error("CONFIGURATION_BC_RECORD_PILOT_PRECONDITION_FAILED")
      save.push({
        ordinal: i + 1,
        tableName: next.tableName,
        key: { ...next.key },
        beforeRowVersion: null,
        candidateRowVersion: next.rawRowVersion!
      })
    } else {
      if (
        (i === 10 && !old.present) ||
        old.present !== next.present ||
        old.rawRowVersion !== next.rawRowVersion
      )
        throw Error("CONFIGURATION_BC_RECORD_PROTECTION_CHANGED")
      protectedRows.push({ ...old, key: { ...old.key } })
    }
  }
  const plan = {
    binding: expected,
    save,
    recover: [...save].reverse().map((row) => ({ ...row, key: { ...row.key } })),
    protectedRows
  }
  return {
    ...plan,
    planVersion: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
    executable: false as const,
    recoveryAvailable: false as const,
    commitOwner: "native_command" as const,
    effectsOwner: "native_command" as const
  }
}

/** Actual w200 source/interface reads, not assumptions about APIs available in other systems. */
export const configurationBcRecordStandardPins = {
  SCPR_DB_TABLE_TYPE_GET: {
    source: "ca9126c0f3a3ba2d9d7c5709baf1d3c4f6161a2b03ab7610f47d871548c742cb",
    interface: "9c3034b039d8076b88f80d81743e49f1e64086fa948a500b55107582a81c8adf"
  },
  SCPR_DB_TABLE_FIELDDEF_GET: {
    source: "1149814756b0fa079c9da76e899ff6ca4ab2065e023cc24ef0f8348601c976db",
    interface: "62ce109ea23ec89e6cd3e19b2972a9bec907e7b1470ffbd25ea7e270ea6bf27d"
  },
  SCPR_PRSET_CT_ONE_TABLE_LOAD: {
    source: "a7d73a3bcb86ad66ede551553568139222f45c29bfa1767e9d257a1d8e11cacb",
    interface: "1a7fffc46553344866b70356f44c8e788c071419431c2198bb98fc642448bef4"
  },
  SCPR_DB_TABLE_RECORDS_GET: {
    source: "c5eaea2b89708b4cc4d5980b1b9a880984405d9112bb1bd19553f1a7463b7cdd",
    interface: "6c14adf1b11a0455f9281eb3330b83b00add6f3f67b38c9d7663664e3e1a2547"
  },
  SCPR_DB_TABLE_TABFLDDEF_GET: {
    source: "032368671c7e8816fa3a97710a5795ababa9811c416d70425b1f0c4db7af5ba0",
    interface: "dca5f484468d333a60c097a44ead101729b065fd2891f608dbb8bcbafa6f14d4"
  },
  SCPR_CTRL_PREDEFINE_FLAGS: {
    source: "4f280905e9bbe79c2be79442513089b80763976ab5ca83f6d59a7144071030c5",
    interface: "d7ca0917509c302bc472d66b8bb4949bd260b5decae587af9498a2692d6708b6"
  },
  SCPR_CT_VALUE_CONVERT_INT_EXT: {
    source: "db76d20610890412f3caa9df80316689d3cad88170097087a068e2cb935be8c0",
    interface: "7a61d6cf41159fe5810f10b9ca73daca75ead478e6e578cdb11c8dfe505a5ddf"
  },
  SCPR_CPROF_CT_PROFDATA_CONVERT: {
    source: "58e7119821a8ec1fb3b94f756f2ea6f8705d391d671e92d8951b689981b29123",
    interface: "678844a691d83ea076f1c72c74d62daa7b68846bfe20300c57c7af597f00dfdc"
  },
  SCPR_HI_SET_GLOBAL_ACTOPTS: {
    source: "2e276a8451c13c733145bfe058e2d0f59446dc3992b01b0136de404734023616",
    interface: "30b0fd4e4cab7d4af920a0ec5133a52478614499f902399830ee955a999c3881"
  },
  SCPR_HIST_CT_REMEMBER_TIME: {
    source: "27a7667cabebbac6e8c88246f29fbdae8d1e3e5ca8dc43d216d255449e1ba79e",
    interface: "98309435bd303f8f1e1a38819080c1d14190e028e4d4f5f6dcb8e2feacd626c8"
  }
} as const

/** The native owner must obtain these definitions through its trusted backend before staging. */
export function attestConfigurationBcRecordStandardApis(raw: unknown) {
  const definition = z.object({
    connectionId: z.literal("w200"),
    functionName: z.string(),
    remoteEnabled: z.literal(false),
    updateTask: z.literal(false),
    sourceFingerprint: hex,
    interfaceFingerprint: hex
  })
  const values = z
    .array(definition)
    .length(Object.keys(configurationBcRecordStandardPins).length)
    .parse(raw)
  const seen = new Set<string>()
  for (const value of values) {
    const pin =
      configurationBcRecordStandardPins[
        value.functionName as keyof typeof configurationBcRecordStandardPins
      ]
    if (
      !pin ||
      seen.has(value.functionName) ||
      value.sourceFingerprint !== pin.source ||
      value.interfaceFingerprint !== pin.interface
    )
      throw Error("CONFIGURATION_BC_RECORD_STANDARD_CHANGED")
    seen.add(value.functionName)
  }
  return { attested: true as const, functions: [...seen].sort(), executable: false as const }
}

const mutableKeys = configurationBcPreflightKeys.slice(0, 10)
const tableCases = [...new Set(mutableKeys.map((key) => key.tableName))].flatMap((name) => {
  const fields =
    configurationBcNativeLayouts[name as keyof typeof configurationBcNativeLayouts].fields
  return [
    `    WHEN '${name}'.`,
    "      CONCATENATE",
    ...fields.map((field, i) => `        '${i ? "," : ""}${field}'`),
    "        INTO lv_expected.",
    `      CREATE DATA lr_copy TYPE ${name.toLowerCase()}.`
  ]
})

/**
 * Private function-group Include candidate. The enclosing command must own the full-scope locks,
 * budget, source/effect attestations, link globals, CTS and LUW. This is not a remote entry point
 * or a standalone BC Set activation/recovery implementation.
 */
export const configurationBcRecordKernel = {
  includeName: "ZORVANTA_CFG_BC_RECORD_KERNEL",
  remoteEnabled: false,
  deploymentReady: false,
  mutableCount: 10,
  protectedCount: 9,
  source: [
    "TYPE-POOLS: scpr, scp1.",
    "TYPES ty_orv_bc_values TYPE STANDARD TABLE OF scprvals",
    "  WITH DEFAULT KEY.",
    "TYPES: BEGIN OF ty_orv_bc_record,",
    "  ordinal TYPE i,",
    "  recattr TYPE scprreca,",
    "  descriptor TYPE scpr_record2,",
    "  values TYPE ty_orv_bc_values,",
    "  deleteflag TYPE scprreca-deleteflag,",
    "  full_row TYPE xstring,",
    "  key_row TYPE xstring,",
    "END OF ty_orv_bc_record.",
    "TYPES ty_orv_bc_records TYPE STANDARD TABLE OF ty_orv_bc_record",
    "  WITH DEFAULT KEY.",
    '" 仅供外层完整命令在持锁、fresh 校验后调用；不拥有提交或 CTS。',
    "FORM orv_bc_record_prepare",
    "  USING p_ordinal TYPE i p_attr TYPE scprreca",
    "        p_row TYPE any p_delete TYPE c",
    "  CHANGING p_record TYPE ty_orv_bc_record p_code TYPE string.",
    "DATA: ls_record TYPE ty_orv_bc_record,",
    "      ls_descr TYPE scpr_record2, ls_field TYPE scpr_flddescr,",
    "      ls_value TYPE scprvals, lt_values TYPE ty_orv_bc_values,",
    "      lv_table TYPE scpr_tabl, lv_type TYPE c, lv_len TYPE i,",
    "      lv_fields TYPE i, lv_keys TYPE i, lv_keybytes TYPE i,",
    "      lv_rowbytes TYPE i,",
    "      lv_names TYPE string, lv_expected TYPE string,",
    "      lv_typecode TYPE c, lv_objname TYPE ob_object,",
    "      lv_objtype TYPE ob_typ, lv_external TYPE scprvals-value,",
    "      lv_keyonly TYPE c, lv_full TYPE xstring, lv_copy TYPE xstring,",
    "      lv_key TYPE xstring, lr_copy TYPE REF TO data,",
    "      lr_key TYPE REF TO data.",
    "FIELD-SYMBOLS: <copy> TYPE any, <key> TYPE any,",
    "  <value> TYPE any, <keyvalue> TYPE any.",
    "CLEAR: p_record, p_code.",
    "IF sy-sysid <> 'GR2' OR sy-mandt <> '200'.",
    "  p_code = 'SCOPE_UNSUPPORTED'. RETURN.",
    "ENDIF.",
    "IF p_delete <> space AND p_delete <> 'X'.",
    "  p_code = 'INPUT_INVALID'. RETURN.",
    "ENDIF.",
    "CASE p_ordinal.",
    ...mutableKeys.map(({ tableName }, i) => `  WHEN ${i + 1}. lv_table = '${tableName}'.`),
    "  WHEN OTHERS. p_code = 'ROW_SCOPE_INVALID'. RETURN.",
    "ENDCASE.",
    "IF p_attr-id <> 'EHS_CUNI_KNM' OR p_attr-version <> 'N'",
    "OR p_attr-tablename <> lv_table OR p_attr-recnumber <> 1",
    "OR p_attr-objectname <> 'CUNI' OR p_attr-objecttype <> 'T'",
    "OR p_attr-activity IS NOT INITIAL",
    "OR p_attr-deleteflag IS NOT INITIAL",
    "OR p_attr-uncomplete IS NOT INITIAL OR p_attr-genref IS NOT INITIAL",
    "OR p_attr-clustname IS NOT INITIAL.",
    "  p_code = 'RECORD_BINDING_INVALID'. RETURN.",
    "ENDIF.",
    "TRY.",
    "  CASE lv_table.",
    ...tableCases,
    "  ENDCASE.",
    "  ASSIGN lr_copy->* TO <copy>.",
    "  CREATE DATA lr_key LIKE <copy>.",
    "  ASSIGN lr_key->* TO <key>.",
    "  CASE p_ordinal.",
    ...mutableKeys.flatMap(({ key }, i) => [
      `    WHEN ${i + 1}.`,
      ...Object.entries(key).flatMap(([field, value]) => [
        `      ASSIGN COMPONENT '${field}' OF STRUCTURE p_row TO <value>.`,
        `      IF sy-subrc <> 0.`,
        "        p_code = 'ROW_SCOPE_INVALID'. RETURN.",
        "      ENDIF.",
        `      IF <value> <> '${value}'.`,
        "        p_code = 'ROW_SCOPE_INVALID'. RETURN.",
        "      ENDIF."
      ])
    ]),
    "  ENDCASE.",
    "  CALL FUNCTION 'SCPR_DB_TABLE_TYPE_GET'",
    "    EXPORTING tabname = lv_table objname = p_attr-objectname",
    "      objtype = p_attr-objecttype",
    "    IMPORTING tabtype = lv_typecode new_objname = lv_objname",
    "      new_objtype = lv_objtype",
    "    EXCEPTIONS error_message = 1 OTHERS = 2.",
    "  IF sy-subrc <> 0 OR lv_typecode <> 'T'",
    "  OR lv_objname <> 'CUNI' OR lv_objtype <> 'T'.",
    "    p_code = 'DESCRIPTOR_IDENTITY_INVALID'. RETURN.",
    "  ENDIF.",
    '" 直接检查 FIELDDEF 异常，避免集合工厂隐藏 TABLE_UNSUITABLE。',
    "  CALL FUNCTION 'SCPR_DB_TABLE_FIELDDEF_GET'",
    "    EXPORTING tabname = lv_table tabtype = lv_typecode",
    "      flddescr_reduc = space entities_variable = space",
    "    IMPORTING tablen = ls_descr-tablen keylen = ls_descr-keylen",
    "      ckeylen = ls_descr-ckeylen",
    "      flddescr_reduced = ls_descr-descr_reduced",
    "      client_field = ls_descr-clnt_fld",
    "      delivery_class = ls_descr-deliverycl",
    "    TABLES sellist = ls_descr-sellist header = ls_descr-header",
    "      namtab = ls_descr-namtab fielddescr = ls_descr-descr",
    "    EXCEPTIONS no_table_name = 1 no_tvdir_entry = 2",
    "      table_not_found = 3 table_to_large = 4",
    "      ddif_internal_error = 5 table_unsuitable = 6",
    "      error_message = 7 OTHERS = 8.",
    "  IF sy-subrc <> 0 OR ls_descr-descr IS INITIAL",
    "  OR ls_descr-descr_reduced IS NOT INITIAL",
    "  OR ls_descr-clnt_fld <> 'MANDT'",
    "  OR ls_descr-tablen <= 0 OR ls_descr-tablen > scpr_maxdatalen",
    "  OR ls_descr-keylen <= 0 OR ls_descr-keylen > scpr_maxkeylen",
    "  OR ls_descr-ckeylen <> ls_descr-keylen.",
    "    p_code = 'DESCRIPTOR_FAILED'. RETURN.",
    "  ENDIF.",
    '" FIELDDEF 不填记录身份，必须从已核实的固定 RECATTR 赋值。',
    "  ls_descr-tabname = p_attr-tablename. ls_descr-tabtype = lv_typecode.",
    "  ls_descr-objname = p_attr-objectname.",
    "  ls_descr-objtype = p_attr-objecttype.",
    "  ls_descr-activity = p_attr-activity.",
    "  DESCRIBE FIELD <copy> LENGTH lv_rowbytes IN BYTE MODE.",
    "  IF lv_rowbytes <> ls_descr-tablen.",
    "    p_code = 'DESCRIPTOR_FAILED'. RETURN.",
    "  ENDIF.",
    "  LOOP AT ls_descr-descr INTO ls_field.",
    "    ADD 1 TO lv_fields.",
    "    IF lv_names IS INITIAL. lv_names = ls_field-fieldname.",
    "    ELSE.",
    "      CONCATENATE lv_names ls_field-fieldname INTO lv_names",
    "        SEPARATED BY ','.",
    "    ENDIF.",
    "    ASSIGN COMPONENT ls_field-fieldname OF STRUCTURE p_row TO <value>.",
    "    IF sy-subrc <> 0.",
    "      p_code = 'DESCRIPTOR_FAILED'. RETURN.",
    "    ENDIF.",
    "    DESCRIBE FIELD <value> TYPE lv_type.",
    "    DESCRIBE FIELD <value> LENGTH lv_len IN BYTE MODE.",
    "    IF lv_type <> ls_field-vtype OR lv_len <> ls_field-intlen",
    "    OR lv_type NA 'CNDTIPFs' OR ls_field-maxbcslen > 255",
    "    OR ls_field-readonly = 'R'",
    "    OR ls_field-datatype = 'CURR' OR ls_field-datatype = 'QUAN'",
    "    OR ( lv_type = 's' AND",
    "      ( ls_field-datatype <> 'INT2' OR lv_len <> 2 ) ).",
    "      p_code = 'DESCRIPTOR_UNSUPPORTED'. RETURN.",
    "    ENDIF.",
    "    IF ls_field-keyflag = 'X'.",
    "      IF lv_type NA 'CNDT' OR ls_field-position <> lv_keybytes",
    "      OR ls_field-flag <> 'FKY'.",
    "        p_code = 'DESCRIPTOR_FAILED'. RETURN.",
    "      ENDIF.",
    "      ADD 1 TO lv_keys. ADD lv_len TO lv_keybytes.",
    "      ASSIGN COMPONENT ls_field-fieldname OF STRUCTURE <key>",
    "        TO <keyvalue>.",
    "      IF sy-subrc <> 0.",
    "        p_code = 'DESCRIPTOR_FAILED'. RETURN.",
    "      ENDIF.",
    "      <keyvalue> = <value>.",
    "    ELSE.",
    "      IF ls_field-flag <> 'USE'.",
    "        p_code = 'DESCRIPTOR_UNSUPPORTED'. RETURN.",
    "      ENDIF.",
    "      IF p_delete = 'X'. CONTINUE. ENDIF.",
    "    ENDIF.",
    "    CLEAR lv_external.",
    "    CALL FUNCTION 'SCPR_CT_VALUE_CONVERT_INT_EXT'",
    "      EXPORTING fielddescr = ls_field value_intern = <value>",
    "        with_convexit = space",
    "      IMPORTING value_extern = lv_external",
    "      EXCEPTIONS error_message = 1 OTHERS = 2.",
    "    IF sy-subrc <> 0.",
    "      p_code = 'CONVERSION_FAILED'. RETURN.",
    "    ENDIF.",
    "    CLEAR ls_value.",
    "    ls_value-id = p_attr-id. ls_value-version = p_attr-version.",
    "    ls_value-tablename = p_attr-tablename.",
    "    ls_value-recnumber = p_attr-recnumber.",
    "    ls_value-fieldname = ls_field-fieldname.",
    "    ls_value-flag = ls_field-flag.",
    "    ls_value-value = lv_external. APPEND ls_value TO lt_values.",
    "  ENDLOOP.",
    "  IF lv_names <> lv_expected OR lv_fields = 0 OR lv_keys = 0",
    "  OR lv_keybytes <> ls_descr-keylen OR lt_values IS INITIAL.",
    "    p_code = 'DESCRIPTOR_FAILED'. RETURN.",
    "  ENDIF.",
    "  CLEAR lv_keyonly.",
    "  IF p_delete = 'X'. lv_keyonly = 'X'. ENDIF.",
    "  CALL FUNCTION 'SCPR_CPROF_CT_PROFDATA_CONVERT'",
    "    EXPORTING tabname = lv_table only_key = lv_keyonly",
    "      recnumber = p_attr-recnumber keylen = ls_descr-keylen",
    "      values_in_int_format = space",
    "    IMPORTING line = <copy>",
    "    TABLES profvalues = lt_values tabledescr = ls_descr-descr",
    "    EXCEPTIONS error_message = 1 OTHERS = 2.",
    "  IF sy-subrc <> 0.",
    "    p_code = 'CONVERSION_FAILED'. RETURN.",
    "  ENDIF.",
    "  EXPORT row = p_row TO DATA BUFFER lv_full.",
    "  EXPORT row = <key> TO DATA BUFFER lv_key.",
    "  EXPORT row = <copy> TO DATA BUFFER lv_copy.",
    "  IF ( p_delete IS INITIAL AND lv_copy <> lv_full )",
    "  OR ( p_delete = 'X' AND lv_copy <> lv_key ).",
    "    p_code = 'ROUNDTRIP_LOSSY'. RETURN.",
    "  ENDIF.",
    "CATCH cx_root.",
    "  p_code = 'CONVERSION_FAILED'. RETURN.",
    "ENDTRY.",
    "ls_record-ordinal = p_ordinal. ls_record-recattr = p_attr.",
    "ls_record-descriptor = ls_descr. ls_record-values = lt_values.",
    "ls_record-full_row = lv_full. ls_record-key_row = lv_key.",
    "IF p_delete = 'X'. ls_record-deleteflag = 'L'. ENDIF.",
    "p_record = ls_record. p_code = 'RECORD_PREPARED'.",
    "ENDFORM.",
    "",
    "FORM orv_bc_record_error USING p_table TYPE scpr_tabl",
    "  CHANGING p_errors TYPE scp1_general_errors.",
    "DATA ls_error TYPE scp1_general_error.",
    "IF p_errors IS NOT INITIAL OR sy-msgid IS INITIAL. RETURN. ENDIF.",
    "ls_error-tablename = p_table. ls_error-tabletype = 'T'.",
    "ls_error-msgid = sy-msgid. ls_error-msgty = sy-msgty.",
    "ls_error-msgno = sy-msgno.",
    "ls_error-msgv1 = sy-msgv1. ls_error-msgv2 = sy-msgv2.",
    "ls_error-msgv3 = sy-msgv3. ls_error-msgv4 = sy-msgv4.",
    "APPEND ls_error TO p_errors.",
    "ENDFORM.",
    "",
    '" 外层必须先准备全部十行，校验十九键并持锁，再进入此标准维护步骤。',
    '" 任一失败可能已产生未提交改值/关联全局数据；由外层回滚及重读。',
    "FORM orv_bc_record_stage",
    "  USING p_record TYPE ty_orv_bc_record p_opts TYPE scpractopt",
    "  CHANGING p_code TYPE string p_errors TYPE scp1_general_errors.",
    "DATA: ls_checked TYPE ty_orv_bc_record,",
    "      lr_row TYPE REF TO data, lr_key TYPE REF TO data,",
    "      lr_rows TYPE REF TO data, lv_count TYPE i,",
    "      lv_subrc TYPE sy-subrc, lv_buffer TYPE xstring, lv_delete TYPE c,",
    "      lv_group TYPE tddat-cclass.",
    "FIELD-SYMBOLS: <row> TYPE any, <key> TYPE any,",
    "  <actual> TYPE any, <rows> TYPE STANDARD TABLE.",
    "CLEAR p_code. REFRESH p_errors.",
    "IF p_opts-act_id IS INITIAL OR p_opts-act_user <> sy-uname",
    "OR p_opts-act_system <> sy-sysid OR p_opts-act_client <> sy-mandt",
    "OR p_opts-dialog <> 'N' OR p_opts-simulat_on <> 'N'",
    "OR p_opts-no_standrd <> 'N' OR p_opts-actlinks <> 'W'",
    "OR p_opts-no_commit <> 'X'.",
    "  p_code = 'OWNER_OPTIONS_INVALID'. RETURN.",
    "ENDIF.",
    "IF p_record-deleteflag <> space AND p_record-deleteflag <> 'L'.",
    "  p_code = 'INPUT_INVALID'. RETURN.",
    "ENDIF.",
    "IF xstrlen( p_record-full_row ) = 0",
    "OR xstrlen( p_record-full_row ) > 65536",
    "OR xstrlen( p_record-key_row ) = 0",
    "OR xstrlen( p_record-key_row ) > 65536.",
    "  p_code = 'BUFFER_INVALID'. RETURN.",
    "ENDIF.",
    "SELECT SINGLE cclass INTO lv_group FROM tddat",
    "  WHERE tabname = p_record-recattr-tablename.",
    "IF sy-subrc <> 0 OR lv_group IS INITIAL. lv_group = '&NC&'. ENDIF.",
    "AUTHORITY-CHECK OBJECT 'S_TABU_DIS'",
    "  ID 'ACTVT' FIELD '02' ID 'DICBERCLS' FIELD lv_group.",
    "IF sy-subrc <> 0.",
    "  AUTHORITY-CHECK OBJECT 'S_TABU_NAM'",
    "    ID 'ACTVT' FIELD '02' ID 'TABLE' FIELD p_record-recattr-tablename.",
    "  IF sy-subrc <> 0. p_code = 'AUTHORIZATION_DENIED'. RETURN. ENDIF.",
    "ENDIF.",
    "TRY.",
    "  CASE p_record-recattr-tablename.",
    ...[...new Set(mutableKeys.map((key) => key.tableName))].map(
      (name) => `    WHEN '${name}'. CREATE DATA lr_row TYPE ${name.toLowerCase()}.`
    ),
    "    WHEN OTHERS. p_code = 'ROW_SCOPE_INVALID'. RETURN.",
    "  ENDCASE.",
    "  ASSIGN lr_row->* TO <row>.",
    "  CREATE DATA lr_key LIKE <row>. ASSIGN lr_key->* TO <key>.",
    "  CREATE DATA lr_rows TYPE STANDARD TABLE OF (p_record-recattr-tablename).",
    "  ASSIGN lr_rows->* TO <rows>.",
    "  IMPORT row = <row> FROM DATA BUFFER p_record-full_row.",
    "  IF sy-subrc <> 0. p_code = 'BUFFER_INVALID'. RETURN. ENDIF.",
    "  EXPORT row = <row> TO DATA BUFFER lv_buffer.",
    "  IF lv_buffer <> p_record-full_row.",
    "    p_code = 'BUFFER_INVALID'. RETURN.",
    "  ENDIF.",
    "  CLEAR lv_delete.",
    "  IF p_record-deleteflag = 'L'. lv_delete = 'X'. ENDIF.",
    "  PERFORM orv_bc_record_prepare",
    "    USING p_record-ordinal p_record-recattr <row> lv_delete",
    "    CHANGING ls_checked p_code.",
    "  IF p_code <> 'RECORD_PREPARED'. RETURN. ENDIF.",
    "  IF ls_checked <> p_record.",
    "    p_code = 'RECORD_CHANGED'. RETURN.",
    "  ENDIF.",
    "  IMPORT row = <key> FROM DATA BUFFER ls_checked-key_row.",
    "  IF sy-subrc <> 0. p_code = 'BUFFER_INVALID'. RETURN. ENDIF.",
    "  CLEAR: sy-msgid, sy-msgty, sy-msgno, sy-msgv1, sy-msgv2, sy-msgv3, sy-msgv4.",
    "  CALL FUNCTION 'SCPR_DB_TABLE_RECORDS_GET'",
    "    EXPORTING tabname = ls_checked-recattr-tablename",
    "      key = <key> keylng = ls_checked-descriptor-keylen",
    "    TABLES records = <rows>",
    "    EXCEPTIONS db_error = 1 not_found = 2 wrong_param = 3",
    "      error_message = 4 OTHERS = 5.",
    "  lv_subrc = sy-subrc. DESCRIBE TABLE <rows> LINES lv_count.",
    "  IF lv_subrc <> 0 AND lv_subrc <> 2.",
    "    PERFORM orv_bc_record_error USING ls_checked-recattr-tablename",
    "      CHANGING p_errors.",
    "    p_code = 'STANDARD_READ_FAILED'. RETURN.",
    "  ENDIF.",
    "  IF lv_delete IS INITIAL.",
    "    IF lv_subrc <> 2 OR lv_count <> 0.",
    "      p_code = 'BEFORE_ROW_CHANGED'. RETURN.",
    "    ENDIF.",
    "  ELSE.",
    "    IF lv_subrc <> 0 OR lv_count <> 1.",
    "      p_code = 'BEFORE_ROW_CHANGED'. RETURN.",
    "    ENDIF.",
    "    READ TABLE <rows> INDEX 1 ASSIGNING <actual>.",
    "    IF sy-subrc <> 0. p_code = 'READBACK_FAILED'. RETURN. ENDIF.",
    "    EXPORT row = <actual> TO DATA BUFFER lv_buffer.",
    "    IF lv_buffer <> ls_checked-full_row.",
    "      p_code = 'BEFORE_ROW_CHANGED'. RETURN.",
    "    ENDIF.",
    "  ENDIF.",
    "  CLEAR: sy-msgid, sy-msgty, sy-msgno, sy-msgv1, sy-msgv2, sy-msgv3, sy-msgv4.",
    "  CALL FUNCTION 'SCPR_PRSET_CT_ONE_TABLE_LOAD'",
    "    EXPORTING tablename = ls_checked-recattr-tablename",
    "      objectname = ls_checked-recattr-objectname",
    "      deleteflag = ls_checked-deleteflag actopts = p_opts",
    "      tabledescr = ls_checked-descriptor values = ls_checked-values",
    "      values_in_int_format = space",
    "    IMPORTING errors = p_errors",
    "    EXCEPTIONS error_message = 1 OTHERS = 2.",
    "  IF sy-subrc <> 0 OR p_errors IS NOT INITIAL.",
    "    PERFORM orv_bc_record_error USING ls_checked-recattr-tablename",
    "      CHANGING p_errors.",
    "    p_code = 'STANDARD_MAINTENANCE_FAILED'. RETURN.",
    "  ENDIF.",
    "  REFRESH <rows>.",
    "  CLEAR: sy-msgid, sy-msgty, sy-msgno, sy-msgv1, sy-msgv2, sy-msgv3, sy-msgv4.",
    "  CALL FUNCTION 'SCPR_DB_TABLE_RECORDS_GET'",
    "    EXPORTING tabname = ls_checked-recattr-tablename",
    "      key = <key> keylng = ls_checked-descriptor-keylen",
    "    TABLES records = <rows>",
    "    EXCEPTIONS db_error = 1 not_found = 2 wrong_param = 3",
    "      error_message = 4 OTHERS = 5.",
    "  lv_subrc = sy-subrc. DESCRIBE TABLE <rows> LINES lv_count.",
    "  IF lv_subrc <> 0 AND lv_subrc <> 2.",
    "    PERFORM orv_bc_record_error USING ls_checked-recattr-tablename",
    "      CHANGING p_errors.",
    "    p_code = 'STANDARD_READ_FAILED'. RETURN.",
    "  ENDIF.",
    "  IF lv_delete = 'X'.",
    "    IF lv_subrc <> 2 OR lv_count <> 0.",
    "      p_code = 'READBACK_FAILED'. RETURN.",
    "    ENDIF.",
    "  ELSE.",
    "    IF lv_subrc <> 0 OR lv_count <> 1.",
    "      p_code = 'READBACK_FAILED'. RETURN.",
    "    ENDIF.",
    "    READ TABLE <rows> INDEX 1 ASSIGNING <actual>.",
    "    IF sy-subrc <> 0. p_code = 'READBACK_FAILED'. RETURN. ENDIF.",
    "    EXPORT row = <actual> TO DATA BUFFER lv_buffer.",
    "    IF lv_buffer <> ls_checked-full_row.",
    "      p_code = 'READBACK_FAILED'. RETURN.",
    "    ENDIF.",
    "  ENDIF.",
    "CATCH cx_root.",
    "  p_code = 'STANDARD_MAINTENANCE_FAILED'. RETURN.",
    "ENDTRY.",
    "p_code = 'RECORD_STAGED'.",
    "ENDFORM.",
    "",
    '" 两遍处理：全部行先准备，第二遍标准维护；不把暂存当作已提交。',
    "FORM orv_bc_records_stage",
    "  USING p_records TYPE ty_orv_bc_records p_delete TYPE c",
    "  CHANGING p_opts TYPE scpractopt p_code TYPE string",
    "    p_errors TYPE scp1_general_errors p_staged TYPE i p_failed TYPE i.",
    "DATA: lt_records TYPE ty_orv_bc_records, ls_record TYPE ty_orv_bc_record,",
    "      ls_checked TYPE ty_orv_bc_record, lr_row TYPE REF TO data,",
    "      lv_count TYPE i, lv_ordinal TYPE i, lv_deleteflag TYPE c.",
    "FIELD-SYMBOLS <row> TYPE any.",
    "CLEAR: p_code, p_staged, p_failed. REFRESH p_errors.",
    "IF p_delete <> space AND p_delete <> 'X'.",
    "  p_code = 'INPUT_INVALID'. RETURN.",
    "ENDIF.",
    "DESCRIBE TABLE p_records LINES lv_count.",
    "IF lv_count <> 10. p_code = 'BATCH_SCOPE_INVALID'. RETURN. ENDIF.",
    "IF p_opts-act_id IS INITIAL OR p_opts-act_user <> sy-uname",
    "OR p_opts-act_system <> sy-sysid OR p_opts-act_client <> sy-mandt",
    "OR p_opts-dialog <> 'N' OR p_opts-simulat_on <> 'N'",
    "OR p_opts-no_standrd <> 'N' OR p_opts-actlinks <> 'W'",
    "OR p_opts-no_commit <> 'X'.",
    "  p_code = 'OWNER_OPTIONS_INVALID'. RETURN.",
    "ENDIF.",
    "lt_records = p_records. SORT lt_records BY ordinal.",
    "IF p_delete = 'X'. lv_deleteflag = 'L'. ENDIF.",
    "LOOP AT lt_records INTO ls_record.",
    "  p_failed = sy-tabix.",
    "  IF ls_record-ordinal <> p_failed",
    "  OR ls_record-deleteflag <> lv_deleteflag",
    "  OR xstrlen( ls_record-full_row ) = 0",
    "  OR xstrlen( ls_record-full_row ) > 65536.",
    "    p_code = 'BATCH_SCOPE_INVALID'. RETURN.",
    "  ENDIF.",
    "  TRY.",
    "    CASE ls_record-recattr-tablename.",
    ...[...new Set(mutableKeys.map((key) => key.tableName))].map(
      (name) => `      WHEN '${name}'. CREATE DATA lr_row TYPE ${name.toLowerCase()}.`
    ),
    "      WHEN OTHERS. p_code = 'ROW_SCOPE_INVALID'. RETURN.",
    "    ENDCASE.",
    "    ASSIGN lr_row->* TO <row>.",
    "    IMPORT row = <row> FROM DATA BUFFER ls_record-full_row.",
    "    IF sy-subrc <> 0. p_code = 'BUFFER_INVALID'. RETURN. ENDIF.",
    "    PERFORM orv_bc_record_prepare",
    "      USING ls_record-ordinal ls_record-recattr <row> p_delete",
    "      CHANGING ls_checked p_code.",
    "    IF p_code <> 'RECORD_PREPARED'. RETURN. ENDIF.",
    "    IF ls_checked <> ls_record. p_code = 'RECORD_CHANGED'. RETURN. ENDIF.",
    "  CATCH cx_root.",
    "    p_code = 'BUFFER_INVALID'. RETURN.",
    "  ENDTRY.",
    "ENDLOOP.",
    '" 正式关联的临时集合每批次初始化一次，不能逐行重置。',
    "p_opts-act_date = sy-datum. p_opts-act_time = sy-uzeit.",
    "CALL FUNCTION 'SCPR_HI_SET_GLOBAL_ACTOPTS'",
    "  EXPORTING actlinks = p_opts-actlinks no_standrd = p_opts-no_standrd",
    "  EXCEPTIONS error_message = 1 OTHERS = 2.",
    "IF sy-subrc <> 0. p_code = 'LINK_INITIALIZATION_FAILED'. RETURN. ENDIF.",
    "CALL FUNCTION 'SCPR_HIST_CT_REMEMBER_TIME'",
    "  EXPORTING moddate = p_opts-act_date modtime = p_opts-act_time",
    "  EXCEPTIONS error_message = 1 OTHERS = 2.",
    "IF sy-subrc <> 0. p_code = 'LINK_INITIALIZATION_FAILED'. RETURN. ENDIF.",
    "DO 10 TIMES.",
    "  lv_ordinal = sy-index.",
    "  IF p_delete = 'X'. lv_ordinal = 11 - lv_ordinal. ENDIF.",
    "  READ TABLE lt_records INDEX lv_ordinal INTO ls_record.",
    "  p_failed = lv_ordinal.",
    "  IF sy-subrc <> 0. p_code = 'BATCH_SCOPE_INVALID'. RETURN. ENDIF.",
    "  PERFORM orv_bc_record_stage USING ls_record p_opts",
    "    CHANGING p_code p_errors.",
    "  IF p_code <> 'RECORD_STAGED'. RETURN. ENDIF.",
    "  ADD 1 TO p_staged.",
    "ENDDO.",
    "CLEAR p_failed. p_code = 'BATCH_STAGED'.",
    "ENDFORM."
  ]
} as const

export const configurationBcRecordKernelSourceVersion = createHash("sha256")
  .update(configurationBcRecordKernel.source.join("\r\n"))
  .digest("hex")
