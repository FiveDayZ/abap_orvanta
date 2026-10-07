import { configurationBcNativeLayouts } from "./configuration-bc-native-api.js"
import { configurationBcGuardLayouts } from "./configuration-bc-guard-api.js"
import { createHash } from "node:crypto"

const parameter = (name: string) => ({
  name,
  typeName: "STRING",
  optional: false,
  passByValue: true
})
export const configurationBcStateTables = [
  "T006",
  "T006A",
  "T006B",
  "T006C",
  "T006D",
  "T006I",
  "T006J",
  "T006T",
  "T006_OIB"
] as const
const primary = configurationBcStateTables.slice(0, 5)
const related = configurationBcStateTables.slice(5)
const versions = ["SOURCE", "TARGET", "CANDIDATE", "METADATA", "GUARD", "CTS"] as const
const bindings = [
  "namespace",
  "system",
  "client",
  "user",
  "bcset",
  "version",
  "request",
  "task",
  "layout",
  ...versions.map((v) => v.toLowerCase())
]
export const configurationBcStateLayouts = Object.fromEntries(
  configurationBcStateTables.map((name) => [
    name,
    name in configurationBcGuardLayouts
      ? configurationBcGuardLayouts[name as keyof typeof configurationBcGuardLayouts].fingerprint
      : configurationBcNativeLayouts[name as keyof typeof configurationBcNativeLayouts].fingerprint
  ])
)
export const configurationBcStateLayoutFingerprint = createHash("sha256")
  .update(
    JSON.stringify(
      Object.entries(configurationBcStateLayouts).sort(([a], [b]) => a.localeCompare(b))
    )
  )
  .digest("hex")
const bindExport = (prefix: string, buffer: string) => [
  "  EXPORT",
  ...bindings.map((name) => `    ${name} = ${prefix}${name}`),
  ...configurationBcStateTables.map(
    (name) => `    ${name.toLowerCase()} = ${prefix}${name.toLowerCase()}`
  ),
  `    TO DATA BUFFER ${buffer}.`
]
const checkedCall = (call: string[], ok: string) => [
  ...call,
  "    EXCEPTIONS error_message = 1 OTHERS = 2.",
  "  IF sy-subrc <> 0.",
  "    ev_code = 'DEPENDENCY_FAILED'. RETURN.",
  "  ENDIF.",
  `  IF lv_code <> '${ok}'.`,
  "    ev_code = lv_code. RETURN.",
  "  ENDIF.",
  "  IF lv_system <> sy-sysid OR lv_client <> sy-mandt",
  "  OR lv_user <> sy-uname.",
  "    ev_code = 'BINDING_INVALID'. RETURN.",
  "  ENDIF."
]
const ctsRead = checkedCall(
  [
    "  CALL FUNCTION 'Z_ORVANTA_CFG_BC_CTS'",
    "    EXPORTING iv_bc_set = iv_bc_set iv_version = iv_version",
    "      iv_request = iv_request iv_task = iv_task",
    "    IMPORTING ev_code = lv_code ev_system = lv_system",
    "      ev_client = lv_client ev_user = lv_user",
    "      ev_cts_version = lv_cts"
  ],
  "CTS_READ_OK"
)

/** Complete read-only ECC 7.31 candidate. Deployment and native roundtrip remain unverified. */
export const configurationBcStateApi = {
  functionName: "Z_ORVANTA_CFG_BC_STATE",
  functionGroup: "ZORVANTA_BC_CFG",
  remoteEnabled: true,
  importParameters: [
    "IV_BC_SET",
    "IV_VERSION",
    "IV_REQUEST",
    "IV_TASK",
    ...versions.map((v) => `IV_${v}_VERSION`)
  ].map(parameter),
  exportParameters: [
    "EV_CODE",
    "EV_SYSTEM",
    "EV_CLIENT",
    "EV_USER",
    "EV_REQUEST",
    "EV_TASK",
    ...versions.map((v) => `EV_${v}_VERSION`),
    "EV_STATE_VERSION",
    "EV_DATA_BASE64",
    "EV_DATA_BYTES",
    "EV_ROW_COUNTS",
    "EV_ROUNDTRIP"
  ].map(parameter),
  tableParameters: [],
  source: [
    "DATA: lv_code TYPE string, lv_system TYPE string,",
    "      lv_client TYPE string, lv_user TYPE string,",
    "      lv_source TYPE string, lv_target TYPE string,",
    "      lv_candidate TYPE string, lv_metadata TYPE string,",
    "      lv_guard TYPE string, lv_cts TYPE string,",
    "      lv_namespace TYPE string, lv_bcset TYPE string,",
    "      lv_layout TYPE string,",
    "      lv_version TYPE string, lv_request TYPE string,",
    "      lv_task TYPE string, lv_hash TYPE string,",
    "      lv_base64 TYPE string, lv_counts TYPE string,",
    "      lv_count TYPE i, lv_pass TYPE i, lv_text TYPE string,",
    "      lv_buffer TYPE xstring, lv_first TYPE xstring,",
    "      lv_roundtrip TYPE xstring.",
    ...configurationBcStateTables.map(
      (name) => `DATA lt_${name.toLowerCase()} TYPE STANDARD TABLE OF ${name.toLowerCase()}.`
    ),
    ...primary.map(
      (name) => `DATA lc_${name.toLowerCase()} TYPE STANDARD TABLE OF ${name.toLowerCase()}.`
    ),
    ...configurationBcStateTables.map(
      (name) => `DATA lr_${name.toLowerCase()} TYPE STANDARD TABLE OF ${name.toLowerCase()}.`
    ),
    ...bindings.map((name) => `DATA lr_${name} TYPE string.`),
    "CLEAR: ev_code, ev_system, ev_client, ev_user, ev_request,",
    "  ev_task, ev_source_version, ev_target_version,",
    "  ev_candidate_version, ev_metadata_version, ev_guard_version,",
    "  ev_cts_version, ev_state_version, ev_data_base64,",
    "  ev_data_bytes, ev_row_counts, ev_roundtrip.",
    "IF sy-sysid <> 'GR2' OR sy-mandt <> '200'.",
    "  ev_code = 'SCOPE_UNSUPPORTED'. RETURN.",
    "ENDIF.",
    "IF iv_bc_set <> 'EHS_CUNI_KNM' OR iv_version <> 'N' OR",
    "   iv_request <> 'GR2K923429' OR iv_task <> 'GR2K923430'.",
    "  ev_code = 'INPUT_INVALID'. RETURN.",
    "ENDIF.",
    ...versions.flatMap((v) => [
      `IF strlen( iv_${v.toLowerCase()}_version ) <> 64 OR`,
      `   iv_${v.toLowerCase()}_version CN '0123456789abcdef'.`,
      "  ev_code = 'INPUT_INVALID'. RETURN.",
      "ENDIF."
    ]),
    '" 依赖各自核对读权限与准确键；不接收恢复字节或任意表名。',
    "DO 2 TIMES.",
    "  lv_pass = sy-index.",
    ...ctsRead,
    "  IF lv_cts <> iv_cts_version.",
    "    ev_code = 'VERSION_CONFLICT'. RETURN.",
    "  ENDIF.",
    ...checkedCall(
      [
        "  CALL FUNCTION 'Z_ORVANTA_CFG_BC_READ'",
        "    EXPORTING iv_bc_set = iv_bc_set iv_version = iv_version",
        "    IMPORTING ev_code = lv_code ev_system = lv_system",
        "      ev_client = lv_client ev_user = lv_user",
        "      ev_source_version = lv_source ev_target_version = lv_target",
        "    TABLES",
        ...primary.map((name) => `      et_${name.toLowerCase()} = lt_${name.toLowerCase()}`)
      ],
      "READ_OK"
    ),
    "  IF lv_source <> iv_source_version OR",
    "     lv_target <> iv_target_version.",
    "    ev_code = 'VERSION_CONFLICT'. RETURN.",
    "  ENDIF.",
    ...checkedCall(
      [
        "  CALL FUNCTION 'Z_ORVANTA_CFG_BC_PREVIEW'",
        "    EXPORTING iv_bc_set = iv_bc_set iv_version = iv_version",
        "      iv_source_version = iv_source_version",
        "      iv_target_version = iv_target_version",
        "    IMPORTING ev_code = lv_code ev_system = lv_system",
        "      ev_client = lv_client ev_user = lv_user",
        "      ev_source_version = lv_source ev_target_version = lv_target",
        "      ev_candidate_version = lv_candidate",
        "    TABLES",
        ...primary.map((name) => `      et_${name.toLowerCase()} = lc_${name.toLowerCase()}`)
      ],
      "PREVIEW_OK"
    ),
    "  IF lv_source <> iv_source_version OR",
    "     lv_target <> iv_target_version OR",
    "     lv_candidate <> iv_candidate_version.",
    "    ev_code = 'VERSION_CONFLICT'. RETURN.",
    "  ENDIF.",
    ...checkedCall(
      [
        "  CALL FUNCTION 'Z_ORVANTA_CFG_BC_GUARD'",
        "    EXPORTING iv_bc_set = iv_bc_set iv_version = iv_version",
        "      iv_source_version = iv_source_version",
        "      iv_target_version = iv_target_version",
        "      iv_metadata_version = iv_metadata_version",
        "    IMPORTING ev_code = lv_code ev_system = lv_system",
        "      ev_client = lv_client ev_user = lv_user",
        "      ev_source_version = lv_source ev_target_version = lv_target",
        "      ev_metadata_version = lv_metadata ev_guard_version = lv_guard",
        "    TABLES",
        ...related.map((name) => `      et_${name.toLowerCase()} = lt_${name.toLowerCase()}`)
      ],
      "GUARD_READ_OK"
    ),
    "  IF lv_source <> iv_source_version OR",
    "     lv_target <> iv_target_version OR",
    "     lv_metadata <> iv_metadata_version OR",
    "     lv_guard <> iv_guard_version.",
    "    ev_code = 'VERSION_CONFLICT'. RETURN.",
    "  ENDIF.",
    ...ctsRead,
    "  IF lv_cts <> iv_cts_version.",
    "    ev_code = 'VERSION_CONFLICT'. RETURN.",
    "  ENDIF.",
    "  CLEAR lv_counts.",
    ...configurationBcStateTables.flatMap((name) => [
      `  DESCRIBE TABLE lt_${name.toLowerCase()} LINES lv_count.`,
      `  IF lv_count > ${["T006A", "T006B", "T006C", "T006J", "T006T"].includes(name) ? 3 : 1}.`,
      "    ev_code = 'LIMIT_EXCEEDED'. RETURN.",
      "  ENDIF.",
      "  lv_text = lv_count. CONDENSE lv_text NO-GAPS.",
      `  CONCATENATE lv_counts '${name}=' lv_text ';' INTO lv_counts.`
    ]),
    "  lv_namespace = 'ORVANTA_CUNI_STATE_V1'.",
    "  lv_layout =",
    `    '${configurationBcStateLayoutFingerprint}'.`,
    "  lv_system = sy-sysid. lv_client = sy-mandt. lv_user = sy-uname.",
    "  lv_bcset = iv_bc_set. lv_version = iv_version.",
    "  lv_request = iv_request. lv_task = iv_task.",
    ...versions.map((v) => `  lv_${v.toLowerCase()} = iv_${v.toLowerCase()}_version.`),
    ...bindExport("lv_", "lv_buffer").map((line) =>
      configurationBcStateTables.reduce(
        (s, name) => s.replace(`= lv_${name.toLowerCase()}`, `= lt_${name.toLowerCase()}`),
        line
      )
    ),
    "  IF xstrlen( lv_buffer ) = 0 OR xstrlen( lv_buffer ) > 524288.",
    "    ev_code = 'LIMIT_EXCEEDED'. RETURN.",
    "  ENDIF.",
    '" 内部 IMPORT 后重 EXPORT 比较原字节，保留 F、日期及空行语义。',
    "  TRY.",
    "    IMPORT",
    ...bindings.map((name) => `      ${name} = lr_${name}`),
    ...configurationBcStateTables.map(
      (name) => `      ${name.toLowerCase()} = lr_${name.toLowerCase()}`
    ),
    "      FROM DATA BUFFER lv_buffer.",
    "    IF sy-subrc <> 0.",
    "      ev_code = 'ROUNDTRIP_FAILED'. RETURN.",
    "    ENDIF.",
    ...bindExport("lr_", "lv_roundtrip").map((line) => `  ${line}`),
    "  CATCH cx_root.",
    "    ev_code = 'ROUNDTRIP_FAILED'. RETURN.",
    "  ENDTRY.",
    "  IF lv_roundtrip <> lv_buffer.",
    "    ev_code = 'ROUNDTRIP_FAILED'. RETURN.",
    "  ENDIF.",
    "  IF lv_pass = 1.",
    "    lv_first = lv_buffer.",
    "  ELSEIF lv_buffer <> lv_first.",
    "    ev_code = 'READ_CHANGED'. RETURN.",
    "  ENDIF.",
    "ENDDO.",
    "CALL FUNCTION 'CALCULATE_HASH_FOR_RAW'",
    "  EXPORTING alg = 'SHA2' data = lv_buffer",
    "  IMPORTING hashstring = lv_hash",
    "  EXCEPTIONS unknown_alg = 1 param_error = 2 internal_error = 3",
    "    error_message = 4 OTHERS = 5.",
    "IF sy-subrc <> 0.",
    "  ev_code = 'HASH_FAILED'. RETURN.",
    "ENDIF.",
    "TRANSLATE lv_hash TO LOWER CASE.",
    "IF strlen( lv_hash ) <> 64 OR lv_hash CN '0123456789abcdef'.",
    "  ev_code = 'HASH_FAILED'. RETURN.",
    "ENDIF.",
    "CALL FUNCTION 'SCMS_BASE64_ENCODE_STR'",
    "  EXPORTING input = lv_buffer IMPORTING output = lv_base64",
    "  EXCEPTIONS error_message = 1 OTHERS = 2.",
    "IF sy-subrc <> 0 OR lv_base64 IS INITIAL.",
    "  ev_code = 'ENCODING_FAILED'. RETURN.",
    "ENDIF.",
    '" 所有输出只在成功后填充；不加锁、不提交、不改配置或传输。',
    "ev_system = sy-sysid. ev_client = sy-mandt. ev_user = sy-uname.",
    "ev_request = iv_request. ev_task = iv_task.",
    ...versions.map((v) => `ev_${v.toLowerCase()}_version = iv_${v.toLowerCase()}_version.`),
    "ev_data_bytes = xstrlen( lv_buffer ).",
    "CONDENSE ev_data_bytes NO-GAPS.",
    "ev_data_base64 = lv_base64. ev_state_version = lv_hash.",
    "ev_row_counts = lv_counts. ev_roundtrip = 'X'.",
    "ev_code = 'STATE_READ_OK'."
  ]
} as const
