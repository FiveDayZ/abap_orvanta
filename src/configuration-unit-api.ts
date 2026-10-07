import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import { configurationUnitFields, configurationUnitLayouts } from "./configuration-unit.js"

// Customer RFC body pinned for guarded deployment and active-source attestation.
export const configurationUnitReadApi = {
  functionName: "Z_ORVANTA_CFG_UNIT_READ",
  remoteEnabled: true,
  importParameters: ["IV_UNIT_KEY", "IV_LANGUAGE"].map((name) => ({
    name,
    typeName: "STRING",
    optional: false,
    passByValue: true
  })),
  exportParameters: ["EV_CODE", "EV_SYSTEM", "EV_CLIENT", "EV_TEXT_VERSION", "ES_TEXT"].map(
    (name) => ({
      name,
      typeName: name === "ES_TEXT" ? "T006A" : "STRING",
      optional: false,
      passByValue: true
    })
  ),
  source: `" ECC 7.31 的 HASHALG 为 CHAR4；SHA2 返回 SHA-256。
CONSTANTS lc_algorithm TYPE hashalg VALUE 'SHA2'.
DATA: lv_unit TYPE t006a-msehi,
      lv_language TYPE t006a-spras,
      lv_group TYPE tddat-cclass,
      lv_table TYPE tddat-tabname,
      lv_length TYPE i,
      lv_data TYPE string,
      lv_hash TYPE string.
" 只返回指定语言的行版本，不承担配置保存或 CTS。
CLEAR: ev_code, ev_system, ev_client, ev_text_version, es_text.
ev_system = sy-sysid.
ev_client = sy-mandt.
IF sy-sysid <> 'GR2' OR sy-mandt <> '200'.
  ev_code = 'SCOPE_UNSUPPORTED'.
  RETURN.
ENDIF.
IF strlen( iv_unit_key ) < 1 OR strlen( iv_unit_key ) > 3
OR strlen( iv_language ) <> 1.
  ev_code = 'INPUT_INVALID'.
  RETURN.
ENDIF.
FIND REGEX '^[A-Za-z0-9]$' IN iv_language.
IF sy-subrc <> 0.
  ev_code = 'INPUT_INVALID'.
  RETURN.
ENDIF.
lv_unit = iv_unit_key.
lv_language = iv_language.
IF iv_unit_key(1) = space OR strlen( lv_unit ) <> strlen( iv_unit_key )
OR iv_unit_key CS '|'.
  ev_code = 'INPUT_INVALID'.
  RETURN.
ENDIF.
FIND REGEX '[[:cntrl:]]' IN iv_unit_key.
IF sy-subrc = 0.
  ev_code = 'INPUT_INVALID'.
  RETURN.
ENDIF.
" 未分配授权组时沿用 CUNI 的 &NC& 规则，逐表校验读取权限。
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
    ID 'ACTVT' FIELD '03' ID 'DICBERCLS' FIELD lv_group.
  IF sy-subrc <> 0.
    ev_code = 'AUTHORIZATION_DENIED'.
    RETURN.
  ENDIF.
ENDDO.
SELECT SINGLE spras INTO lv_language FROM t002
  WHERE spras = lv_language.
IF sy-subrc <> 0.
  ev_code = 'LANGUAGE_NOT_FOUND'.
  RETURN.
ENDIF.
SELECT SINGLE msehi INTO lv_unit FROM t006 WHERE msehi = lv_unit.
IF sy-subrc <> 0.
  ev_code = 'UNIT_NOT_FOUND'.
  RETURN.
ENDIF.
DESCRIBE FIELD es_text LENGTH lv_length IN CHARACTER MODE.
IF lv_length <> 56.
  ev_code = 'LAYOUT_UNSUPPORTED'.
  RETURN.
ENDIF.
SELECT SINGLE mandt spras msehi mseh3 mseh6 mseht msehl
  INTO CORRESPONDING FIELDS OF es_text FROM t006a
  WHERE spras = lv_language AND msehi = lv_unit.
IF sy-subrc <> 0.
  ev_code = 'TEXT_NOT_FOUND'.
  RETURN.
ENDIF.
" 固定七字段并保留填充空格，避免显示值裁剪改变版本。
CONCATENATE 'T006A:v1:' sy-sysid es_text-mandt
  es_text-spras es_text-msehi
  es_text-mseh3 es_text-mseh6 es_text-mseht es_text-msehl
  INTO lv_data RESPECTING BLANKS.
CALL FUNCTION 'CALCULATE_HASH_FOR_CHAR'
  EXPORTING alg = lc_algorithm data = lv_data
  IMPORTING hashstring = lv_hash
  EXCEPTIONS unknown_alg = 1 param_error = 2 internal_error = 3
             error_message = 4 OTHERS = 5.
IF sy-subrc <> 0.
  CLEAR es_text.
  ev_code = 'HASH_UNAVAILABLE'.
  RETURN.
ENDIF.
TRANSLATE lv_hash TO LOWER CASE.
IF strlen( lv_hash ) <> 64 OR lv_hash CN '0123456789abcdef'.
  CLEAR es_text.
  ev_code = 'HASH_UNAVAILABLE'.
  RETURN.
ENDIF.
ev_text_version = lv_hash.
ev_code = 'READ'.`.split("\n")
} as const

// Keep code and literals intact; only generated interface comments and outer line spacing differ.
export function configurationUnitApiBody(source: readonly string[]) {
  return source
    .filter((line) => !line.trim().startsWith('*"'))
    .filter((line) => !/^\s*(FUNCTION\b|ENDFUNCTION\.)/i.test(line))
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
}
const expectedBody = configurationUnitApiBody(configurationUnitReadApi.source)
export const configurationUnitReadApiBodyFingerprint = createHash("sha256")
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
  functionName: z.literal(configurationUnitReadApi.functionName),
  remoteEnabled: z.literal(true),
  updateTask: z.literal(false),
  updateTaskMode: z.literal(""),
  importParameters: z.array(parameter),
  exportParameters: z.array(parameter),
  changingParameters: z.array(z.never()),
  tableParameters: z.array(z.never()),
  exceptions: z.array(z.never()),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  interfaceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.array(z.string()).min(configurationUnitReadApi.source.length)
})
function attested(raw: unknown) {
  const parsed = definitionSchema.safeParse(raw)
  if (!parsed.success) return null
  const value = parsed.data,
    sorted = (v: unknown[]) =>
      JSON.stringify([...v].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
  const headers = value.source.filter((line) => /^\s*FUNCTION\s+/i.test(line))
  if (
    headers.length !== 1 ||
    headers[0]!.trim().toUpperCase() !== `FUNCTION ${configurationUnitReadApi.functionName}.`
  )
    return null
  if (
    sorted(value.importParameters) !== sorted([...configurationUnitReadApi.importParameters]) ||
    sorted(value.exportParameters) !== sorted([...configurationUnitReadApi.exportParameters]) ||
    configurationUnitApiBody(value.source) !== expectedBody
  )
    return null
  return value
}

/** Full-row version originates in SAP; it is never rebuilt from trimmed display values. */
export async function readConfigurationUnitApiSnapshot(
  connectionId: string,
  client: string,
  unitKey: string,
  sapLanguage: string,
  backend: Pick<SapBackend, "callRemoteFunction">,
  readDefinition: () => Promise<unknown>,
  readTable: () => Promise<unknown>
) {
  if (connectionId !== "w200" || client !== "200" || !/^[A-Za-z0-9]$/.test(sapLanguage))
    throw Error("CONFIGURATION_UNIT_API_SCOPE_UNSUPPORTED")
  if (
    unitKey.length < 1 ||
    unitKey.length > 3 ||
    unitKey !== unitKey.trim() ||
    /[|\p{Cc}]/u.test(unitKey)
  )
    throw Error("CONFIGURATION_UNIT_API_INPUT_INVALID")
  let calls = 0,
    reads = 0
  const result = (
    status: string,
    code: string,
    data: Record<string, string> | null = null,
    version: string | null = null
  ) => ({
    status,
    code,
    readOnly: true,
    executable: false,
    saveAvailable: false,
    functionName: configurationUnitReadApi.functionName,
    data,
    textVersion: version,
    versionScope: "SAP_GR2_200_full_T006A_row_v1",
    versionOrigin: "sap_sha256_fixed_width_utf8",
    bodyFingerprint: configurationUnitReadApiBodyFingerprint,
    evidence: {
      functionReaderInvocations: reads,
      functionReaderInvocationLimit: 2,
      apiInvocations: calls,
      apiInvocationLimit: 1
    },
    warning:
      "Text version is separate from the legacy readFingerprint; it neither authorizes writes nor proves CTS, locks or maintenance success."
  })
  const table = async () =>
    z
      .object({
        connectionId: z.literal("w200"),
        objectName: z.literal("T006A"),
        objectKind: z.literal("transparentTable"),
        fingerprint: z.literal(configurationUnitLayouts.T006A),
        active: z.literal(true).optional(),
        status: z.literal("ok").optional()
      })
      .safeParse(await readTable()).success
  if (!(await table())) return result("blocked", "DDIC_UNVERIFIED")
  reads++
  const first = attested(await readDefinition())
  if (!first) return result("blocked", "API_NOT_ATTESTED")
  calls++
  const response = await backend.callRemoteFunction(connectionId, {
    functionName: configurationUnitReadApi.functionName,
    inputParameters: { IV_UNIT_KEY: unitKey, IV_LANGUAGE: sapLanguage },
    outputParameters: configurationUnitReadApi.exportParameters.map((p) => ({
      name: p.name,
      kind: p.name === "ES_TEXT" ? "structure" : "scalar",
      ...(p.name === "ES_TEXT" ? { fields: [...configurationUnitFields.T006A] } : {})
    }))
  })
  reads++
  const second = attested(await readDefinition())
  if (
    !second ||
    second.sourceFingerprint !== first.sourceFingerprint ||
    second.interfaceFingerprint !== first.interfaceFingerprint ||
    !(await table())
  )
    return result("changed", "API_OR_DDIC_CHANGED")
  if (response.fault) return result("unavailable", "API_DECLARED_FAULT")
  const output = z
    .object({
      EV_CODE: z.string(),
      EV_SYSTEM: z.literal("GR2"),
      EV_CLIENT: z.literal("200"),
      EV_TEXT_VERSION: z.string(),
      ES_TEXT: z
        .object(
          Object.fromEntries(
            configurationUnitFields.T006A.map((name, i) => [
              name,
              z
                .string()
                .max([3, 1, 3, 3, 6, 10, 30][i]!)
                .refine((v) => !/\p{Cc}/u.test(v))
            ])
          )
        )
        .strict()
    })
    .strict()
    .safeParse(response.outputs)
  if (!output.success) return result("blocked", "API_RESPONSE_INVALID")
  const value = output.data
  if (value.EV_CODE !== "READ") {
    const codes = [
      "SCOPE_UNSUPPORTED",
      "INPUT_INVALID",
      "AUTHORIZATION_DENIED",
      "LANGUAGE_NOT_FOUND",
      "UNIT_NOT_FOUND",
      "LAYOUT_UNSUPPORTED",
      "TEXT_NOT_FOUND",
      "HASH_UNAVAILABLE"
    ]
    return result("blocked", codes.includes(value.EV_CODE) ? value.EV_CODE : "API_RESPONSE_INVALID")
  }
  if (
    !/^[a-f0-9]{64}$/.test(value.EV_TEXT_VERSION) ||
    value.ES_TEXT.MANDT !== client ||
    value.ES_TEXT.SPRAS !== sapLanguage ||
    value.ES_TEXT.MSEHI!.trimEnd() !== unitKey
  )
    return result("blocked", "API_RESPONSE_INVALID")
  return result("read", "READ", value.ES_TEXT, value.EV_TEXT_VERSION)
}
