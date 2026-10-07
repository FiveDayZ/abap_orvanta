import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  configurationBcCtsApi as api,
  configurationBcCtsDependencies as dependencies,
  configurationBcCtsLayouts as layouts
} from "../src/configuration-bc-cts-api.js"
import { readConfigurationBcCts } from "../src/configuration-bc-cts.js"

// Synthetic byte payload exercises the adapter, not SAP EXPORT serialization or CTS runtime.
export function ctsFixture() {
  const input = {
    connectionId: "w200",
    bcSetId: "EHS_CUNI_KNM",
    version: "N",
    requestNumber: "GR2K923429",
    taskNumber: "GR2K923430"
  }
  const bytes = Buffer.from("2001KG" + " ".repeat(114) + "\0string key | 中文  "),
    calls = { native: 0, definition: 0, table: 0 }
  const native: Record<string, string> = {
    EV_CODE: "CTS_READ_OK",
    EV_SYSTEM: "GR2",
    EV_CLIENT: "200",
    EV_USER: "WYS",
    EV_REQUEST: input.requestNumber,
    EV_TASK: input.taskNumber,
    EV_CTS_VERSION: createHash("sha256").update(bytes).digest("hex"),
    EV_DATA_BASE64: bytes.toString("base64"),
    EV_DATA_BYTES: String(bytes.length),
    EV_OBJECT_COUNT: "2",
    EV_KEY_COUNT: "1",
    EV_STRING_KEY_COUNT: "1"
  }
  const definition = {
    ...api,
    connectionId: "w200",
    updateTask: false,
    updateTaskMode: "",
    changingParameters: [],
    exceptions: [],
    sourceFingerprint: "a".repeat(64),
    interfaceFingerprint: "b".repeat(64),
    source: [`FUNCTION ${api.functionName}.`, ...api.source, "ENDFUNCTION."]
  }
  const readers = {
    definition: async (name: string) => {
      calls.definition++
      if (name === api.functionName) return structuredClone(definition)
      const pin = dependencies[name as keyof typeof dependencies]
      return {
        connectionId: "w200",
        functionName: name,
        remoteEnabled: pin.remoteEnabled,
        updateTask: false,
        sourceFingerprint: String(pin.source),
        interfaceFingerprint: String(pin.interface)
      }
    },
    table: async (name: string) => {
      calls.table++
      return {
        connectionId: "w200",
        objectName: name,
        objectKind: "transparentTable",
        fingerprint: String(layouts[name as keyof typeof layouts])
      }
    }
  }
  const backend = {
    callRemoteFunction: async (
      connection: string,
      request: Parameters<Parameters<typeof readConfigurationBcCts>[3]["callRemoteFunction"]>[1]
    ) => {
      calls.native++
      assert.equal(connection, "w200")
      assert.equal(request.functionName, api.functionName)
      assert.deepEqual(request.inputParameters, {
        IV_BC_SET: input.bcSetId,
        IV_VERSION: input.version,
        IV_REQUEST: input.requestNumber,
        IV_TASK: input.taskNumber
      })
      return { outputs: structuredClone(native) }
    }
  }
  return {
    input,
    native,
    definition,
    readers,
    backend,
    calls,
    run: () => readConfigurationBcCts(input, "200", "wys", backend, readers)
  }
}
