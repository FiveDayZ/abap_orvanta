import assert from "node:assert/strict"
import test from "node:test"
import {
  decodeConfigurationFiFieldBridgeObservation,
  prepareConfigurationFiFieldBridge
} from "../src/configuration-fi-field-bridge.js"

const requested = [
  { table: "BKPF", name: "BUKRS" },
  { table: "BSEG", name: "MATNR" }
]
const prepare = () => prepareConfigurationFiFieldBridge(requested, "009")
const response = () => ({
  ...prepare().scope,
  requestFingerprint: prepare().requestFingerprint,
  fields: requested.map((field, index) => ({
    TABNAME: field.table,
    FIELDNAME: field.name,
    BALLOWED: index ? "F" : "T",
    DFIES: {
      TABNAME: field.table,
      FIELDNAME: field.name,
      DATATYPE: "CHAR",
      INTTYPE: "C",
      LENG: index ? "000018" : "000004",
      INTLEN: index ? "000036" : "000008",
      OUTPUTLEN: index ? "000018" : "000004",
      DECIMALS: "000000",
      CONVEXIT: index ? "MATN1" : "",
      LOWERCASE: "",
      REFTABLE: "",
      REFFIELD: ""
    }
  }))
})

test("FI bridge preparation binds only class 009 and current unique fields, without permitting native execution", () => {
  const request = prepare()
  assert.equal(
    request.requestFingerprint,
    prepareConfigurationFiFieldBridge([...requested].reverse(), "009").requestFingerprint
  )
  assert.equal(request.session.ddicResetClearsBooleanClassCache, false)
  assert.equal(request.session.isolationRequired, "fresh_internal_session")
  assert.equal(request.session.crossCallCursorReuse, false)
  assert.equal(request.candidateFunctionName, null)
  assert.equal(request.deploymentReady, false)
  assert.equal(request.nativeExecutionAvailable, false)
  for (const fields of [
    [],
    [requested[0]!, requested[0]!],
    [{ table: "BSEG", name: "BELNR" }],
    [{ table: "SY", name: "TCODE" }],
    [{ table: "bkpf", name: "BUKRS" }]
  ])
    assert.throws(() => prepareConfigurationFiFieldBridge(fields, "009"), /SCOPE_INVALID/)
  assert.throws(() => prepareConfigurationFiFieldBridge(requested, "010"), /SCOPE_INVALID/)
})

test("FI bridge draft decoding preserves raw DFIES and T/F, without asserting native eligibility or conversion", () => {
  const observed = response()
  const result = decodeConfigurationFiFieldBridgeObservation(prepare(), observed)
  assert.deepEqual(result.fields, observed.fields)
  assert.equal(result.fields[0]!.DFIES.OUTPUTLEN, "000004")
  assert.equal(result.fields[1]!.BALLOWED, "F")
  assert.equal(result.nativeEligibility, "not_attested")
  assert.equal(result.runtimeVerified, false)
  assert.equal(result.saveAvailable, false)
  assert.equal(result.conversionsPerformed, false)
})

test("FI bridge rejects truthy substitutes for T/F, stale scope, extra rows, duplicate rows and omitted fields", () => {
  for (const value of ["X", "", "true", "1"]) {
    const observed = response()
    observed.fields[0]!.BALLOWED = value
    assert.throws(
      () => decodeConfigurationFiFieldBridgeObservation(prepare(), observed),
      /RESPONSE_INVALID/
    )
  }
  for (const mutate of [
    (value: ReturnType<typeof response>) => {
      value.client = "300" as "200"
    },
    (value: ReturnType<typeof response>) => {
      value.requestFingerprint = "0".repeat(64)
    },
    (value: ReturnType<typeof response>) => {
      value.fields.pop()
    },
    (value: ReturnType<typeof response>) => {
      value.fields[1] = value.fields[0]!
    },
    (value: ReturnType<typeof response>) => {
      value.fields[1]!.FIELDNAME = "BELNR"
    }
  ]) {
    const observed = response()
    mutate(observed)
    assert.throws(
      () => decodeConfigurationFiFieldBridgeObservation(prepare(), observed),
      /RESPONSE_INVALID|FIELD_SET_CHANGED/
    )
  }
})

test("FI bridge rejects mismatched DFIES identities, zero output length and inconsistent CHAR attributes", () => {
  for (const mutate of [
    (value: ReturnType<typeof response>) => {
      value.fields[0]!.DFIES.FIELDNAME = "MATNR"
    },
    (value: ReturnType<typeof response>) => {
      value.fields[0]!.DFIES.OUTPUTLEN = "000000"
    },
    (value: ReturnType<typeof response>) => {
      value.fields[0]!.DFIES.INTTYPE = "P"
    },
    (value: ReturnType<typeof response>) => {
      value.fields[0]!.DFIES.DECIMALS = "000001"
    }
  ]) {
    const observed = response()
    mutate(observed)
    assert.throws(
      () => decodeConfigurationFiFieldBridgeObservation(prepare(), observed),
      /ATTRIBUTES_INVALID/
    )
  }
})

test("FI bridge request scope cannot mutate shared constants or authorize another client", () => {
  const request = prepare()
  ;(request.scope as { client: string }).client = "300"
  assert.equal(prepare().scope.client, "200")
  assert.throws(
    () => decodeConfigurationFiFieldBridgeObservation(request, response()),
    /REQUEST_CHANGED/
  )
})
