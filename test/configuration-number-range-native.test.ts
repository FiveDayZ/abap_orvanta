import assert from "node:assert/strict"
import test from "node:test"
import { configurationNumberRangeReadApi as api } from "../src/configuration-number-range-api.js"
import { configurationNumberRangeCommandDependencies } from "../src/configuration-number-range-command.js"
import {
  configurationNumberRangeNativeTables as layouts,
  readConfigurationNumberRangeApi as read
} from "../src/configuration-number-range-native.js"
const version = "a".repeat(64)
const input = { connectionId: "w200", objectName: "ZTESTNR" }
function fixture() {
  let calls = 0,
    reads = 0
  const output = {
    EV_CODE: "READ_OK",
    EV_SYSTEM: "GR2",
    EV_CLIENT: "200",
    EV_VERSION: version,
    ES_DEFINITION: Object.fromEntries(
      layouts.TNRO.fields.map((f) => [f, f === "OBJECT" ? "ZTESTNR" : ""])
    ),
    ET_INTERVALS: [] as Record<string, string>[]
  }
  const state = {
    output,
    layoutDrift: false,
    sourceDrift: false,
    missing: false,
    fault: false,
    backend: {
      callRemoteFunction: async (
        _connection: string,
        request: { functionName: string; inputParameters: unknown; outputParameters: unknown }
      ) => {
        calls++
        assert.equal(request.functionName, api.functionName)
        assert.deepEqual(request.inputParameters, { IV_OBJECT: "ZTESTNR", ET_INTERVALS: [] })
        return {
          outputs: state.output,
          ...(state.fault
            ? { fault: { code: "fixture", name: "fixture", message: "fixture" } }
            : {})
        }
      }
    },
    readDefinition: async (name: string) => {
      reads++
      if (state.missing) throw Error("FUNCTION_READ_FAILED")
      if (name === "CALCULATE_HASH_FOR_RAW")
        return {
          functionName: name,
          remoteEnabled: false,
          updateTask: false,
          ...configurationNumberRangeCommandDependencies.CALCULATE_HASH_FOR_RAW
        }
      return {
        ...api,
        connectionId: "w200",
        updateTask: false,
        updateTaskMode: "",
        changingParameters: [],
        exceptions: [],
        sourceFingerprint: state.sourceDrift && reads > 2 ? "b".repeat(64) : version,
        interfaceFingerprint: version,
        source: [`FUNCTION ${api.functionName}.`, ...api.source.split("\n"), "ENDFUNCTION."]
      }
    },
    readTable: async (name: string) => {
      const l = layouts[name as keyof typeof layouts]
      return {
        connectionId: "w200",
        objectName: name,
        objectKind: "transparentTable",
        fingerprint: state.layoutDrift ? version : l.fingerprint,
        definition: { fields: l.fields.map((name) => ({ name })) }
      }
    },
    calls: () => calls,
    run: (raw: unknown = input, client = "200") =>
      read(raw, client, state.backend, state.readDefinition, state.readTable)
  }
  return state
}
test("native number range read exposes complete version only after full layout and source checks", async () => {
  const f = fixture(),
    observed = await f.run()
  assert.equal(observed.snapshot.EV_VERSION, version)
  assert.equal(observed.versionScope, "complete_TNRO_and_current_client_NRIV")
  assert.equal(observed.readOnly, true)
  assert.equal(f.calls(), 1)
})
test("native number range read refuses malformed scope before remote invocation", async () => {
  for (const raw of [
    { ...input, connectionId: "w300" },
    { ...input, objectName: "NRTEST" },
    { ...input, execute: true }
  ]) {
    const f = fixture()
    await assert.rejects(f.run(raw))
    assert.equal(f.calls(), 0)
  }
  const f = fixture()
  await assert.rejects(f.run(input, "300"), /SCOPE_UNSUPPORTED/)
  assert.equal(f.calls(), 0)
})
test("missing API and changed DDIC layout cannot dispatch even the native reader", async () => {
  for (const property of ["missing", "layoutDrift"] as const) {
    const f = fixture()
    f[property] = true
    await assert.rejects(f.run())
    assert.equal(f.calls(), 0)
  }
})
test("wrong object, incomplete definition or other-client rows never provide a native version", async () => {
  const object = fixture()
  object.output.ES_DEFINITION.OBJECT = "ZOTHER"
  await assert.rejects(object.run(), /SCOPE_INVALID/)
  const incomplete = fixture()
  delete incomplete.output.ES_DEFINITION.RFCDEST
  await assert.rejects(incomplete.run(), /SCOPE_INVALID/)
  const wrongClient = fixture()
  wrongClient.output.ET_INTERVALS = [
    Object.fromEntries(
      layouts.NRIV.fields.map((name) => [
        name,
        name === "CLIENT" ? "300" : name === "OBJECT" ? "ZTESTNR" : ""
      ])
    )
  ]
  await assert.rejects(wrongClient.run(), /SCOPE_INVALID/)
})
test("native read refusal and transport fault retain a stable rejection without a version", async () => {
  for (const code of ["AUTHORIZATION_DENIED", "OBJECT_NOT_FOUND", "READ_CHANGED"]) {
    const f = fixture()
    f.output.EV_CODE = code
    await assert.rejects(f.run(), new RegExp(`READ_${code}`))
  }
  const f = fixture()
  f.fault = true
  await assert.rejects(f.run(), /READ_FAULT/)
})
test("source changes during native reading discard its otherwise valid snapshot", async () => {
  const f = fixture()
  f.sourceDrift = true
  await assert.rejects(f.run(), /SOURCE_CHANGED/)
  assert.equal(f.calls(), 1)
})
