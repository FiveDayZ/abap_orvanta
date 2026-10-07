import assert from "node:assert/strict"
import test from "node:test"
import {
  configurationBcNativeReadApi as api,
  configurationBcNativeLayouts as layouts
} from "../src/configuration-bc-native-api.js"
import { configurationBcNativeTypes } from "../src/configuration-bc-native-types.js"
import {
  readConfigurationBcNative as read,
  configurationBcNativeSourcePins as pins
} from "../src/configuration-bc-native.js"
import type { RemoteFunctionResult } from "../src/backend.js"

const input = { connectionId: "w200", bcSetId: "EHS_CUNI_KNM", version: "N" }
const version = "a".repeat(64)
function fixture() {
  const counts = { api: 0, source: 0, metadata: 0 }
  const row = (name: keyof typeof layouts, extra: Record<string, string>) => ({
    ...Object.fromEntries(layouts[name].fields.map((n) => [n, ""])),
    MANDT: "200",
    ...extra
  })
  const output: Record<string, unknown> = {
    EV_CODE: "READ_OK",
    EV_SYSTEM: "GR2",
    EV_CLIENT: "200",
    EV_USER: "WYS",
    EV_SOURCE_VERSION: version,
    EV_TARGET_VERSION: version,
    ET_T006: [],
    ET_T006A: [],
    ET_T006B: [row("T006B", { SPRAS: "D", MSEH3: "KNM", MSEHI: "KPA" })],
    ET_T006C: [],
    ET_T006D: [row("T006D", { DIMID: "PRESS", LENG: "-1", MASS: "1", TIMEX: "-2" })]
  }
  const state = {
    counts,
    output,
    row,
    sourceChanged: false,
    layoutChanged: false,
    typeChanged: false,
    bodyChanged: false,
    afterTypeChanged: false,
    afterBodyChanged: false,
    mutation: (call: number) => {},
    fault: false,
    definition: async (name: string) => {
      counts.metadata++
      if (name === "CALCULATE_HASH_FOR_RAW")
        return {
          connectionId: "w200",
          functionName: name,
          remoteEnabled: false,
          updateTask: false,
          sourceFingerprint: "874f8e777eda4b72aecd34ab11153af0fe291ca777b8023c96c13c1119bfd458",
          interfaceFingerprint: "9d0e795153f6118bb966e18c6d4bdbca7e66f927c75bfe8e9fcf22d4fb153779"
        }
      return {
        connectionId: "w200",
        functionName: api.functionName,
        functionGroup: api.functionGroup,
        remoteEnabled: true,
        updateTask: false,
        updateTaskMode: "",
        importParameters: api.importParameters,
        exportParameters: api.exportParameters,
        tableParameters: api.tableParameters,
        changingParameters: [],
        exceptions: [],
        sourceFingerprint: version,
        interfaceFingerprint: version,
        source: [
          `FUNCTION ${api.functionName}.`,
          ...api.source,
          ...(state.bodyChanged || (state.afterBodyChanged && counts.api > 0)
            ? ["COMMIT WORK."]
            : []),
          "ENDFUNCTION."
        ]
      }
    },
    table: async (name: string) => {
      counts.metadata++
      const d = layouts[name as keyof typeof layouts]
      return {
        connectionId: "w200",
        objectName: name,
        objectKind: "transparentTable",
        fingerprint: state.layoutChanged ? version : d.fingerprint,
        definition: { fields: d.fields.map((name) => ({ name })) }
      }
    },
    type: async (kind: "dataElement" | "domain", name: string) => {
      counts.metadata++
      const d = Object.values(configurationBcNativeTypes).find(
        (x) => x.name === name && x.kind === kind
      )!
      return {
        connectionId: "w200",
        objectName: name,
        objectKind: kind,
        fingerprint:
          state.typeChanged || (state.afterTypeChanged && counts.api > 0) ? version : d.fingerprint
      }
    },
    source: async (name: keyof typeof pins) => {
      counts.source++
      return {
        ...input,
        client: "200",
        objectName: name,
        readOnly: true,
        readFingerprint: state.sourceChanged ? version : pins[name],
        recordInventory: {
          complete: true,
          fingerprint: "d9653312beab7ac191387dbd41ae7ee5e87e010a14d7b4c2432c08565c3aecce"
        },
        coverage: { truncated: false },
        dependencies: []
      }
    },
    backend: {
      callRemoteFunction: async (
        connection: string,
        request: { functionName: string; inputParameters: unknown }
      ) => {
        counts.api++
        assert.equal(connection, "w200")
        assert.equal(request.functionName, api.functionName)
        assert.deepEqual(request.inputParameters, {
          IV_BC_SET: input.bcSetId,
          IV_VERSION: "N",
          ...Object.fromEntries(api.tableParameters.map((p) => [p.name, []]))
        })
        state.mutation(counts.api)
        return {
          outputs: structuredClone(output),
          ...(state.fault ? { fault: { code: "FAULT", name: "FAIL", message: "FAIL" } } : {})
        } as RemoteFunctionResult
      }
    }
  }
  return {
    ...state,
    run: () =>
      read(input, "200", state.backend, state.definition, state.table, state.type, state.source),
    state
  }
}
test("native five-table reader preserves conflicting alias and explicit missing languages", async () => {
  const f = fixture(),
    r = await f.run()
  assert.equal(r.states.length, 11)
  assert.deepEqual(
    r.states.filter((x) => x.mappingConflict).map((x) => x.key),
    [{ MANDT: "200", SPRAS: "D", MSEH3: "KNM" }]
  )
  assert.equal(r.states.filter((x) => x.status === "missing").length, 9)
  assert.equal(r.native.ET_T006D[0]!.LENG, "-1")
  assert.equal(r.native.EV_TARGET_VERSION, version)
  assert.equal(r.snapshot, false)
  assert.equal(r.activationAvailable, false)
  assert.equal(r.saveAvailable, false)
  assert.deepEqual(f.counts, { api: 2, source: 10, metadata: 248 })
})
test("native unit response retains every field including both float display strings", async () => {
  const f = fixture()
  f.output.ET_T006 = [
    f.row("T006", {
      MSEHI: "KNM",
      TEMP_VALUE: "1.2345678901234567E+030",
      PRESS_VAL: "9.8765432101234567E-030",
      TEMP_UNIT: "K  "
    })
  ]
  const r = await f.run()
  assert.equal(r.native.ET_T006[0]!.PRESS_VAL, "9.8765432101234567E-030")
  assert.equal(r.native.ET_T006[0]!.TEMP_UNIT, "K  ")
})
test("invalid input and client cannot invoke metadata or native API", async () => {
  for (const raw of [
    { ...input, connectionId: "w300" },
    { ...input, bcSetId: "OTHER" },
    { ...input, version: "C" },
    { ...input, unitKey: "KG" }
  ]) {
    const f = fixture()
    await assert.rejects(read(raw, "200", f.backend, f.definition, f.table, f.type, f.source))
    assert.deepEqual(f.counts, { api: 0, source: 0, metadata: 0 })
  }
  const f = fixture()
  await assert.rejects(read(input, "300", f.backend, f.definition, f.table, f.type, f.source))
  assert.equal(f.counts.api, 0)
})
for (const flag of ["sourceChanged", "layoutChanged", "typeChanged", "bodyChanged"] as const)
  test(`unattested ${flag} stops before native invocation`, async () => {
    const f = fixture()
    f.state[flag] = true
    await assert.rejects(f.run())
    assert.equal(f.counts.api, 0)
  })
for (const field of ["EV_SOURCE_VERSION", "EV_TARGET_VERSION", "EV_USER"] as const)
  test(`changed ${field} retracts complete snapshot`, async () => {
    const f = fixture()
    f.state.mutation = (n) => {
      if (n === 2) f.output[field] = field === "EV_USER" ? "OTHER" : "b".repeat(64)
    }
    await assert.rejects(f.run(), /READ_CHANGED/)
    assert.equal(f.counts.api, 2)
  })
test("changed field with reused native version is still rejected", async () => {
  const f = fixture()
  f.state.mutation = (n) => {
    if (n === 2) (f.output.ET_T006D as Record<string, string>[])[0]!.MSSIE = "OTHER"
  }
  await assert.rejects(f.run(), /READ_CHANGED/)
})
for (const flag of ["afterTypeChanged", "afterBodyChanged"] as const)
  test(`post-call ${flag} retracts snapshot`, async () => {
    const f = fixture()
    f.state[flag] = true
    await assert.rejects(f.run())
    assert.equal(f.counts.api, 2)
  })
test("source drift after native calls rejects snapshot", async () => {
  const f = fixture()
  f.state.mutation = (n) => {
    if (n === 2) f.state.sourceChanged = true
  }
  await assert.rejects(f.run(), /SOURCE_NOT_ATTESTED/)
})
for (const code of [
  "AUTHORIZATION_DENIED",
  "SOURCE_LIMIT_EXCEEDED",
  "READ_CHANGED",
  "HASH_FAILED",
  "UNREVIEWED"
])
  test(`native ${code} returns no successful partial rows`, async () => {
    const f = fixture()
    f.output.EV_CODE = code
    await assert.rejects(f.run(), new RegExp(code === "UNREVIEWED" ? "INVALID_RESPONSE" : code))
    assert.equal(f.counts.api, 1)
  })
test("native declared fault fails without retry", async () => {
  const f = fixture()
  f.state.fault = true
  await assert.rejects(f.run(), /READ_FAULT/)
  assert.equal(f.counts.api, 1)
})
test("wrong alias key, duplicate language, missing field, wrong client and incomplete output fail closed", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      ;(f.output.ET_T006B as Record<string, string>[])[0]!.MSEH3 = "OTHER"
    },
    (f: ReturnType<typeof fixture>) => {
      const rows = f.output.ET_T006B as Record<string, string>[]
      rows.push({ ...rows[0]! })
    },
    (f: ReturnType<typeof fixture>) => {
      delete (f.output.ET_T006D as Record<string, string>[])[0]!.PRESS_DEP
    },
    (f: ReturnType<typeof fixture>) => {
      f.output.EV_CLIENT = "300"
    },
    (f: ReturnType<typeof fixture>) => {
      delete f.output.ET_T006C
    }
  ]) {
    const f = fixture()
    mutate(f)
    await assert.rejects(f.run())
    assert.equal(f.counts.api, 1)
  }
})
