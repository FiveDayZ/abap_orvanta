import assert from "node:assert/strict"
import test from "node:test"
import { formatReportParameters } from "../src/report-parameters.js"

const input = { connectionId: "w200", report: "ZREPORT" }
const parameter = {
  name: "P_WERKS",
  number: "1000001",
  kind: "P" as const,
  typeCode: "C",
  dictionaryType: "C",
  referenceField: "T001W-WERKS",
  obligatory: true,
  noDisplay: false
}
const reply = {
  action: "REPORT_PARAMETERS" as const,
  report: "ZREPORT",
  parameters: [parameter],
  complete: true as const
}

test("parameter metadata does not claim defaults, runtime behavior or active-source consistency", () => {
  const result = formatReportParameters({ ...input, report: "zreport" }, reply)
  assert.equal(result.parameters[0]!.obligatory, true)
  assert.equal(result.parameters[0]!.referenceField, "T001W-WERKS")
  assert.equal(result.defaultValuesAvailable, false)
  assert.equal(result.variantValuesAvailable, false)
  assert.equal(result.runtimeScreenEvaluated, false)
  assert.equal(result.activeSourceMatch, "not_verified")
  assert.equal(result.executionAuthorized, "not_evaluated")
})

test("parameter formatter rejects wrong report, incomplete, oversized and duplicate metadata", () => {
  assert.throws(
    () => formatReportParameters(input, { ...reply, report: "OTHER" }),
    /SCOPE_MISMATCH/
  )
  assert.throws(() => formatReportParameters(input, { ...reply, report: null }), /SCOPE_MISMATCH/)
  assert.throws(
    () =>
      formatReportParameters(input, {
        ...reply,
        parameters: [parameter, parameter]
      }),
    /DUPLICATE_KEY/
  )
  assert.throws(() =>
    formatReportParameters(input, {
      ...reply,
      parameters: Array.from({ length: 201 }, (_, i) => ({ ...parameter, number: String(i) }))
    })
  )
  const incomplete = { ...reply, complete: false }
  assert.throws(() => formatReportParameters(input, incomplete as typeof reply))
})

test("parameters on different generated positions stay distinct and fingerprints track flag changes", () => {
  const repeated = { ...reply, parameters: [parameter, { ...parameter, number: "2000001" }] }
  assert.equal(formatReportParameters(input, repeated).returnedCount, 2)
  const initial = formatReportParameters(input, reply)
  const changed = formatReportParameters(input, {
    ...reply,
    parameters: [{ ...parameter, noDisplay: true }]
  })
  assert.notEqual(initial.definitionFingerprint, changed.definitionFingerprint)
  const otherConnection = formatReportParameters({ ...input, connectionId: "other" }, reply)
  assert.notEqual(initial.definitionFingerprint, otherConnection.definitionFingerprint)
})

test("an existing empty selection load remains distinct from unreadable metadata", () => {
  assert.equal(formatReportParameters(input, { ...reply, parameters: [] }).returnedCount, 0)
  assert.throws(() => formatReportParameters(input, { ...reply, report: null, parameters: [] }))
})
