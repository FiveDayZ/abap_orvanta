import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { preflightFixture } from "./configuration-bc-preflight-fixture.js"
import { ctsFixture } from "./configuration-bc-cts-fixture.js"
import {
  configurationBcStateApi as api,
  configurationBcStateTables
} from "../src/configuration-bc-state-api.js"
import { readConfigurationBcBeforeState } from "../src/configuration-bc-state.js"

// Historical preflight replay + synthetic bytes. This is not SAP serialization/runtime proof.
export async function stateFixture() {
  const p = preflightFixture(),
    c = ctsFixture(),
    preflight = await p.invoke(),
    cts = await c.run()
  const input = {
    ...p.input,
    requestNumber: c.input.requestNumber,
    taskNumber: c.input.taskNumber,
    nativeCtsVersion: c.native.EV_CTS_VERSION!
  }
  const bytes = Buffer.from(
    "native-state-test-only\0" + " ".repeat(120) + "中文|F:1.2345678901234567E+308|D:00000000"
  )
  const native: Record<string, string> = {
    EV_CODE: "STATE_READ_OK",
    EV_SYSTEM: "GR2",
    EV_CLIENT: "200",
    EV_USER: "WYS",
    EV_REQUEST: input.requestNumber,
    EV_TASK: input.taskNumber,
    ...Object.fromEntries(
      ["source", "target", "candidate", "metadata", "guard", "cts"].map((name) => [
        `EV_${name.toUpperCase()}_VERSION`,
        input[`native${name[0]!.toUpperCase()}${name.slice(1)}Version` as keyof typeof input]
      ])
    ),
    EV_STATE_VERSION: createHash("sha256").update(bytes).digest("hex"),
    EV_DATA_BASE64: bytes.toString("base64"),
    EV_DATA_BYTES: String(bytes.length),
    EV_ROW_COUNTS: configurationBcStateTables
      .map(
        (name) =>
          `${name}=${preflight.rows.filter((r) => r.tableName === name && r.presence === "present").length};`
      )
      .join(""),
    EV_ROUNDTRIP: "X"
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
  const calls = { native: 0, preflight: 0, cts: 0, definition: 0 }
  const readers = {
    definition: async () => {
      calls.definition++
      return structuredClone(definition)
    },
    preflight: async () => {
      calls.preflight++
      return structuredClone(preflight)
    },
    cts: async () => {
      calls.cts++
      return structuredClone(cts)
    }
  }
  const backend = {
    callRemoteFunction: async (
      connection: string,
      request: Parameters<
        Parameters<typeof readConfigurationBcBeforeState>[3]["callRemoteFunction"]
      >[1]
    ) => {
      calls.native++
      assert.equal(connection, "w200")
      assert.equal(request.functionName, api.functionName)
      assert.deepEqual(
        request.outputParameters,
        api.exportParameters.map((v) => ({ name: v.name, kind: "scalar" }))
      )
      assert.deepEqual(request.inputParameters, {
        IV_BC_SET: input.bcSetId,
        IV_VERSION: input.version,
        IV_REQUEST: input.requestNumber,
        IV_TASK: input.taskNumber,
        ...Object.fromEntries(
          ["source", "target", "candidate", "metadata", "guard", "cts"].map((name) => [
            `IV_${name.toUpperCase()}_VERSION`,
            input[`native${name[0]!.toUpperCase()}${name.slice(1)}Version` as keyof typeof input]
          ])
        )
      })
      return { outputs: structuredClone(native) }
    }
  }
  return {
    input,
    native,
    definition,
    preflight,
    cts,
    calls,
    backend,
    readers,
    invoke: (raw: unknown = input, client = "200", user = "wys") =>
      readConfigurationBcBeforeState(raw, client, user, backend, readers)
  }
}
