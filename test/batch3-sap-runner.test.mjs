import assert from "node:assert/strict"
import test from "node:test"
import { selectionFor, checkResult } from "../scripts/run-mvp-batch3-sap.mjs"
import { SCI_E2_HELPER, SCI_E2_FINGERPRINT } from "../dist/src/sci-v2.js"
import {
  CONFIGURATION_TYPES,
  CONFIGURATION_MODE_DOMAIN,
  CONFIGURATION_MODE_FINGERPRINT
} from "../dist/src/configuration-preview.js"
import { createHash } from "node:crypto"

function sciResult(precheck) {
  return {
    connectionId: "w200",
    engine: "SCI",
    nativeAtc: false,
    helper: SCI_E2_HELPER,
    helperFingerprint: SCI_E2_FINGERPRINT,
    qualityGate: "not_evaluated",
    coverage: "limited",
    execution: precheck ? "not_run" : "returned",
    requestedTarget: { objectType: "PROG", objectName: "ZCODEX_MVP3_UNIT" },
    scope: {
      objectType: "PROG",
      objectName: "ZCODEX_MVP3_UNIT",
      programName: "ZCODEX_MVP3_UNIT",
      packageName: "ZABAP"
    },
    profile: "SYNTAX_CRITICAL_SQL_V1",
    selectedRules: [
      ["CL_CI_TEST_SYNTAX_CHECK", "001"],
      ["CL_CI_TEST_CRITICAL_STATEMENTS", "002"],
      ["CL_CI_TEST_SELECT_NESTED", "000"]
    ].map(([name, version]) => ({
      name,
      version,
      applicable: true,
      completion: precheck ? "not_run" : "not_attested"
    })),
    code: precheck ? "PREFLIGHT_ONLY" : "NO_FINDINGS_UNVERIFIED",
    ...(precheck ? {} : { totalFindings: 0 }),
    returnedFindings: 0,
    findings: [],
    truncated: false,
    limitations: ["No per-rule completion proof"]
  }
}

test("SCI precheck and run remain distinct and cannot claim a passed quality gate", () => {
  checkResult("sci-precheck", sciResult(true))
  checkResult("sci-run", sciResult(false))
  assert.equal(selectionFor("sci-precheck").args.action, "precheck")
  assert.equal(selectionFor("sci-run").args.action, "run")
  assert.throws(() => checkResult("sci-run", sciResult(true)))
  assert.throws(() => checkResult("sci-run", { ...sciResult(false), qualityGate: "passed" }))
})

test("SCI rejects wrong targets, helper drift, missing rules and unsupported completion claims", () => {
  const base = sciResult(false)
  for (const patch of [
    { helperFingerprint: "0".repeat(64) },
    { nativeAtc: true },
    { scope: { ...base.scope, objectName: "OTHER" } },
    { selectedRules: base.selectedRules.slice(1) },
    { selectedRules: base.selectedRules.map((rule) => ({ ...rule, completion: "passed" })) }
  ])
    assert.throws(() => checkResult("sci-run", { ...base, ...patch }))
})

test("SCI preserves finding coordinates and text truncation without treating findings as a defect verdict", () => {
  const found = {
    ...sciResult(false),
    code: "FINDINGS_LIMITED",
    totalFindings: 1,
    returnedFindings: 1,
    truncated: true,
    findings: [
      {
        check: "CL_CI_TEST_SYNTAX_CHECK",
        severity: "W",
        code: "001",
        include: "ZCODEX_MVP3_UNIT",
        line: 4,
        column: 1,
        message: "Synthetic warning",
        textTruncated: true
      }
    ]
  }
  checkResult("sci-run", found)
  assert.throws(() => checkResult("sci-run", { ...found, truncated: false }))
  assert.throws(() => checkResult("sci-run", { ...found, returnedFindings: 0 }))
  const invalid = structuredClone(found)
  invalid.findings[0].line = -1
  assert.throws(() => checkResult("sci-run", invalid))
})

const types = CONFIGURATION_TYPES.map(([dataElement, dataType, length, domainName]) => ({
  dataElement,
  dataType,
  length,
  decimals: 0,
  domainName
}))
const baseline = {
  typeMetadataValidation: "matched",
  typeMetadata: types,
  typeMetadataFingerprint: createHash("sha256").update(JSON.stringify(types)).digest("hex"),
  connectionId: "w200",
  client: "200",
  tableName: "ZTPMC_TPCFG",
  plant: "809P",
  readOnly: true,
  saveAvailable: false,
  validation: "structural_and_domain",
  domainMetadata: {
    field: "TPMODE",
    domainName: CONFIGURATION_MODE_DOMAIN,
    fingerprint: CONFIGURATION_MODE_FINGERPRINT,
    allowedValues: ["", "E", "S"],
    scope: "fixed_values_only"
  },
  domainValueValidation: {
    field: "TPMODE",
    effectiveValue: "S",
    status: "valid",
    currentValueValid: true
  },
  businessValidation: "not_verified",
  snapshot: false,
  definitionFingerprint: "4c617b912277d9d19b9e0bd8760dbfd53c541adb2129b30a5b040bb6cdd537ed",
  rowFingerprint: selectionFor("preview").args.expectedRowFingerprint,
  status: "preview",
  data: {
    MANDT: "200",
    WERKS: "809P",
    ACTIVE: "X",
    TPMODE: "S",
    DATAB: "20260908",
    DATBI: "20261208",
    CFGVERS: "000001",
    AENAM: "WYS",
    AEDAT: "20260908",
    AEZET: "091630"
  },
  differences: [{ field: "DATBI", from: "20261208", to: "20261209" }]
}

test("human selection fixes object and plant; unknown modes cannot select tools", () => {
  assert.equal(selectionFor("unit").args.objectName, "ZCODEX_MVP3_UNIT")
  assert.equal(selectionFor("stale").args.plant, "809P")
  assert.throws(() => selectionFor("save"))
})

test("preview acceptance requires unchanged complete original data and exactly one difference", () => {
  checkResult("preview", baseline)
  for (const patch of [
    { saveAvailable: true },
    { plant: "OTHER" },
    { differences: [] },
    { data: { ...baseline.data, DATBI: "20261209" } },
    { status: "changed" }
  ])
    assert.throws(() => checkResult("preview", { ...baseline, ...patch }))
})

test("configuration acceptance rejects missing or mismatched type evidence", () => {
  for (const patch of [
    { typeMetadataValidation: undefined },
    { typeMetadata: [] },
    { typeMetadataFingerprint: "0".repeat(64) }
  ])
    assert.throws(() => checkResult("preview", { ...baseline, ...patch }))
})

test("mode acceptance distinguishes a valid proposal from current row and unrelated errors", () => {
  const valid = {
    ...baseline,
    differences: [{ field: "TPMODE", from: "S", to: "E" }],
    domainValueValidation: { ...baseline.domainValueValidation, effectiveValue: "E" }
  }
  checkResult("mode-valid", valid)
  assert.equal(selectionFor("mode-valid").args.changes.TPMODE, "E")
  assert.equal(selectionFor("mode-invalid").args.changes.TPMODE, "?")
  const rejected = {
    isError: true,
    content: [
      {
        type: "text",
        text: "Error invoking preview_configuration: Error: CONFIGURATION_DOMAIN_VALUE_INVALID: TPMODE"
      }
    ]
  }
  checkResult("mode-invalid", rejected)
  assert.throws(() => checkResult("mode-invalid", { ...rejected, isError: false }))
  assert.throws(() =>
    checkResult("mode-invalid", { isError: true, content: [{ type: "text", text: "HTTP 403" }] })
  )
  assert.throws(() => checkResult("mode-valid", { ...valid, domainMetadata: undefined }))
})

test("stale fingerprint acceptance rejects leaked data and false previews", () => {
  const stale = { ...baseline, status: "changed", data: null, differences: null }
  checkResult("stale", stale)
  assert.throws(() => checkResult("stale", baseline))
  assert.throws(() => checkResult("stale", { ...stale, data: baseline.data }))
})

test("Unit acceptance requires a real negative assertion, not a setup or unrelated failure", () => {
  const unit = {
    connectionId: "w200",
    objectName: "ZCODEX_MVP3_UNIT",
    engine: "ABAP Unit",
    activationPerformed: false,
    nativeAtc: false,
    status: "failed",
    total: 2,
    passed: 1,
    failed: 1,
    notExecutedClasses: 0,
    classes: [
      {
        name: "LTC_ASSERTION_CONTROL",
        alerts: [],
        methods: [
          { name: "ADDITION_PASSES", alerts: [] },
          { name: "INTENTIONAL_FAILURE", alerts: [{ kind: "failedAssertion" }] }
        ]
      }
    ]
  }
  checkResult("unit", unit)
  assert.throws(() => checkResult("unit", { ...unit, status: "passed" }))
  const setup = structuredClone(unit)
  setup.classes[0].alerts.push({ kind: "error" })
  assert.throws(() => checkResult("unit", setup))
  const wrongFailure = structuredClone(unit)
  wrongFailure.classes[0].methods[1].alerts[0].kind = "runtimeError"
  assert.throws(() => checkResult("unit", wrongFailure))
})
