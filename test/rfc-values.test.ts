import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { rfcValueContract, validateRfcValue } from "../src/rfc-values.js"
import { ToolService } from "../src/tools.js"
import { InvocationReceiptStore } from "../src/invocation-receipts.js"
import { MockBackend } from "./mock-backend.js"

test("DDIC decimal input validation uses text without rounding or loss of leading zeros", () => {
  const contract = rfcValueContract({ DATATYPE: "DEC", LENG: "23", DECIMALS: "3" }, "ZDEC")
  for (const value of ["99999999999999999999.123", "-0001.2300", ".125", "0", ""]) {
    validateRfcValue(contract, value, "amount")
  }
  for (const value of ["100000000000000000000", "1.0001", "1e3", "1,000.00"]) {
    assert.throws(() => validateRfcValue(contract, value, "amount"), /amount/)
  }
  assert.throws(() => rfcValueContract({ DATATYPE: "DEC", LENG: "23" }, "ZDEC"), /precision/)
})

test("integer range, CHAR and NUMC boundaries are preserved", () => {
  const int = rfcValueContract({ DATATYPE: "INT4" }, "INT4")
  validateRfcValue(int, "-2147483648", "count")
  validateRfcValue(int, "2147483647", "count")
  for (const value of ["2147483648", "-2147483649", "1.1"]) {
    assert.throws(() => validateRfcValue(int, value, "count"))
  }
  const numc = rfcValueContract({ DATATYPE: "NUMC", LENG: "4" }, "ZNUM")
  validateRfcValue(numc, "0001", "id")
  validateRfcValue(numc, "", "id")
  assert.throws(() => validateRfcValue(numc, "A001", "id"), /digits/)
  assert.throws(() => validateRfcValue(numc, "00001", "id"), /exceeds/)
  validateRfcValue({ dataType: "CHAR", length: 4 }, "A001", "text")
})

const base = {
  connectionId: "w200",
  functionName: "ZCMCP_FM_1801",
  acknowledgePotentialSideEffects: true as const
}
function fixture() {
  const backend = new MockBackend()
  const ddic = backend.callSapDdic.bind(backend)
  backend.callSapDdic = async (id, request) => {
    const result = await ddic(id, request)
    if (request.operation === "READ_STRUCTURE" && request.objectName === "BAPIRET2") {
      result.fields.push({
        FIELDNAME: "AMOUNT",
        ROLLNAME: "ZAMOUNT",
        COMPTYPE: "E",
        DATATYPE: "DEC",
        LENG: "13",
        DECIMALS: "3"
      })
    }
    return result
  }
  return backend
}

test("both RFC entry points reject invalid nested values before dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-rfc-values-"))
  try {
    for (const formal of [false, true]) {
      const backend = fixture()
      const tools = new ToolService(backend, undefined, new InvocationReceiptStore(root, "values"))
      const metadata = JSON.parse(await tools.readFunctionModuleInterface(base))
      for (const structureInputs of [
        { IS_REQUEST: { MESSAGE: "X".repeat(221) } },
        { IS_REQUEST: { AMOUNT: "1.0001" } }
      ]) {
        const args = {
          ...base,
          inputParameters: {},
          structureInputs,
          expectedInterfaceFingerprint: metadata.fingerprint
        }
        await assert.rejects(
          formal
            ? tools.invokeCustomerFunctionModule({ ...args, requestId: "never-dispatched" })
            : tools.testRemoteFunctionModule({
                ...args,
                expectedStructureOutputs: { ES_RESPONSE: {} }
              }),
          /exceeds/
        )
      }
      assert.equal(backend.remoteFunctionCalls, 0)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a decimal field row without a usable precision resolves through its data element", async () => {
  const backend = new MockBackend()
  const ddic = backend.callSapDdic.bind(backend)
  backend.callSapDdic = async (id, request) => {
    const result = await ddic(id, request)
    if (request.operation === "READ_STRUCTURE" && request.objectName === "BAPIRET2") {
      // The field list names a decimal type and length but carries no usable precision. BAPI_MTYPE
      // resolves to domain CHAR1, so that element contract is the one that has to be applied
      // instead of the whole interface being refused.
      result.fields.push({
        FIELDNAME: "AMOUNT",
        ROLLNAME: "BAPI_MTYPE",
        COMPTYPE: "E",
        DATATYPE: "QUAN",
        LENG: "13"
      })
    }
    return result
  }
  const tools = new ToolService(backend)
  const metadata = JSON.parse(await tools.readFunctionModuleInterface(base))
  await assert.rejects(
    tools.testRemoteFunctionModule({
      ...base,
      inputParameters: {},
      structureInputs: { IS_REQUEST: { AMOUNT: "12" } },
      expectedStructureOutputs: { ES_RESPONSE: {} },
      expectedInterfaceFingerprint: metadata.fingerprint
    }),
    /exceeds 1 characters/
  )
  assert.equal(backend.remoteFunctionCalls, 0)
})

test("TABLES values share field contracts and unknown fields remain rejected", async () => {
  const backend = fixture()
  const tools = new ToolService(backend)
  const metadata = JSON.parse(await tools.readFunctionModuleInterface(base))
  for (const row of [{ AMOUNT: "1.0001" }, { UNKNOWN: "x" }]) {
    await assert.rejects(
      tools.testRemoteFunctionModule({
        ...base,
        inputParameters: {},
        structureInputs: { IS_REQUEST: { MESSAGE: "TEST" } },
        tableInputs: { CT_ITEMS: [row] },
        expectedTableOutputs: { CT_ITEMS: [] },
        expectedInterfaceFingerprint: metadata.fingerprint
      })
    )
  }
  assert.equal(backend.remoteFunctionCalls, 0)
})

test("an exception name containing the expected name is not a passing assertion", async () => {
  const backend = new MockBackend()
  backend.callRemoteFunction = async () => ({
    outputs: {},
    fault: { name: "NOT_INVALID_INPUT", code: "Server", message: "INVALID_INPUT mentioned in text" }
  })
  await assert.rejects(
    new ToolService(backend).testRemoteFunctionModule({
      connectionId: "w200",
      functionName: "ZCMCP_FM_1501",
      inputParameters: { IV_INPUT: "" },
      expectedException: "INVALID_INPUT",
      acknowledgePotentialSideEffects: true
    }),
    /SAP SOAP fault/
  )
})

test("scalar output length is checked and an uncertain formal result remains outcome_unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-rfc-output-"))
  try {
    const backend = new MockBackend()
    backend.callRemoteFunction = async () => ({ outputs: { EV_OUTPUT: "X".repeat(41) } })
    const tools = new ToolService(backend, undefined, new InvocationReceiptStore(root, "output"))
    const metadata = JSON.parse(
      await tools.readFunctionModuleInterface({
        connectionId: "w200",
        functionName: "ZCMCP_FM_1501"
      })
    )
    await assert.rejects(
      tools.invokeCustomerFunctionModule({
        connectionId: "w200",
        functionName: "ZCMCP_FM_1501",
        inputParameters: { IV_INPUT: "TEST" },
        requestId: "long-output",
        expectedInterfaceFingerprint: metadata.fingerprint,
        acknowledgePotentialSideEffects: true
      }),
      /exceeds 40/
    )
    assert.equal(
      JSON.parse(
        await tools.getCustomerFunctionCallStatus({
          connectionId: "w200",
          requestId: "long-output"
        })
      ).status,
      "outcome_unknown"
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
