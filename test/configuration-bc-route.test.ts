import assert from "node:assert/strict"
import test from "node:test"
import type { RemoteFunctionResult, RemoteFunctionValue } from "../src/backend.js"
import type { readConfigurationBcNative } from "../src/configuration-bc-native.js"
import {
  configurationBcRouteApi as api,
  configurationBcRouteLayouts as layouts
} from "../src/configuration-bc-route-api.js"
import {
  inspectConfigurationBcRoute as inspect,
  configurationBcRouteIncludes as includes
} from "../src/configuration-bc-route.js"
import { configurationBcPreviewSourceVersion as source } from "../src/configuration-bc-preview.js"
const version = "a".repeat(64),
  different = "b".repeat(64)
const input = {
  connectionId: "w200",
  bcSetId: "EHS_CUNI_KNM",
  version: "N",
  nativeSourceVersion: source,
  nativeTargetVersion: version
}
function fixture() {
  const row = (name: keyof typeof layouts, fields: Record<string, string>) => ({
    ...Object.fromEntries(layouts[name].fields.map((f) => [f, ""])),
    OBJECTNAME: "CUNI",
    OBJECTTYPE: "T",
    ...fields
  })
  const output: Record<string, RemoteFunctionValue> = {
    EV_CODE: "ROUTE_READ_OK",
    EV_SYSTEM: "GR2",
    EV_CLIENT: "200",
    EV_USER: "WYS",
    EV_SOURCE_VERSION: source,
    EV_TARGET_VERSION: version,
    EV_METADATA_VERSION: version,
    ET_OBJH: [row("OBJH", { IMPORTABLE: "3", OBJTRANSP: "2", LDATE: "00000000" })],
    ET_OBJS: [
      row("OBJS", { TABNAME: "T006", PRIM_TABLE: "X" }),
      row("OBJS", { TABNAME: "T006_OIB" })
    ],
    ET_OBJM: [row("OBJM", { METHOD: "AFTER_IMP", METHODNAME: "ZTEST_ROUTE_METHOD" })]
  }
  const state = {
    output,
    calls: [] as string[],
    snapshots: 0,
    definitionReads: 0,
    tables: 0,
    badBody: false,
    badTable: false,
    badInclude: false,
    changedAfter: false,
    changedMethod: false,
    changedTableAfter: false,
    fault: false,
    drift: false
  }
  const snapshot = {
    native: { EV_SOURCE_VERSION: source, EV_TARGET_VERSION: version, EV_USER: "WYS", ET_T006: [] },
    evidence: { apiInvocations: 2 }
  }
  const invoke = () =>
    inspect(
      input,
      "200",
      {
        callRemoteFunction: async (_connection, request): Promise<RemoteFunctionResult> => {
          state.calls.push(request.functionName)
          assert.equal(request.functionName, api.functionName)
          for (const p of api.tableParameters) assert.deepEqual(request.inputParameters[p.name], [])
          if (state.fault)
            return {
              fault: { code: "FIXTURE_FAULT", name: "FAULT", message: "fixture fault" },
              outputs: {}
            }
          const out = structuredClone(state.output)
          if (state.drift && state.calls.length === 2) out.EV_METADATA_VERSION = different
          return { outputs: out }
        }
      },
      async () => {
        state.snapshots++
        const current = structuredClone(snapshot)
        if (state.changedAfter && state.snapshots === 2) current.native.EV_USER = "OTHER"
        return current as unknown as Awaited<ReturnType<typeof readConfigurationBcNative>>
      },
      async (name) => {
        state.definitionReads++
        if (name === api.functionName)
          return {
            ...api,
            connectionId: "w200",
            updateTask: false,
            updateTaskMode: "",
            changingParameters: [],
            exceptions: [],
            sourceFingerprint: version,
            interfaceFingerprint: version,
            source: [
              `FUNCTION ${api.functionName}.`,
              ...(state.badBody ? ["RETURN."] : api.source),
              "ENDFUNCTION."
            ]
          }
        assert.equal(name, "ZTEST_ROUTE_METHOD")
        return {
          connectionId: "w200",
          functionName: name,
          remoteEnabled: false,
          updateTask: false,
          sourceFingerprint:
            state.changedMethod && state.definitionReads >= 4 ? different : version,
          interfaceFingerprint: version,
          source: [`FUNCTION ${name}.`, "ENDFUNCTION."]
        }
      },
      async (name) => {
        state.tables++
        return {
          connectionId: "w200",
          objectName: name,
          objectKind: "transparentTable",
          fingerprint:
            state.badTable || (state.changedTableAfter && state.tables > 3)
              ? version
              : layouts[name].fingerprint
        }
      },
      async (name) => ({
        connectionId: "w200",
        objectName: name,
        ...includes[name],
        sourceFingerprint: state.badInclude ? version : includes[name].sourceFingerprint
      })
    )
  return { state, snapshot, invoke }
}
test("CUNI route exposes actual metadata and method identities while leaving execution blocked", async () => {
  const f = fixture(),
    result = await f.invoke()
  assert.deepEqual(f.state.calls, [api.functionName, api.functionName])
  assert.equal(f.state.snapshots, 2)
  assert.equal(result.importHandling, "automatic")
  assert.equal(result.transportHandling, "automatic")
  assert.deepEqual(result.otherMemberTables, ["T006_OIB"])
  assert.equal(result.methodSources[0]!.functionName, "ZTEST_ROUTE_METHOD")
  assert.equal(result.executable, false)
  assert.equal(result.activationAvailable, false)
  assert.equal(result.methodExecutionAvailable, false)
  assert.equal(result.snapshot, false)
  assert.equal(result.evidence.metadataReads, 14)
  assert.equal(result.unresolved.length, 3)
})
for (const date of ["", "00000000", "0000-00-00"])
  test(`route preserves an initial DATS representation ${JSON.stringify(date)}`, async () => {
    const f = fixture()
    ;(f.state.output.ET_OBJH as Record<string, string>[])[0]!.LDATE = date
    const result = await f.invoke()
    assert.equal(result.native.ET_OBJH[0]!.LUSER, "")
    assert.equal(result.native.ET_OBJH[0]!.LDATE, date)
    assert.equal(result.executable, false)
  })
for (const date of ["20261005", "2026-10-05", "0000-00-01", "0000000", " "])
  test(`route refuses non-initial or malformed audit DATS ${JSON.stringify(date)}`, async () => {
    const f = fixture()
    ;(f.state.output.ET_OBJH as Record<string, string>[])[0]!.LDATE = date
    await assert.rejects(f.invoke(), /AUDIT_FIELDS_UNEXPECTED/)
  })
test("source and target version checks run before route calls", async () => {
  const f = fixture()
  f.snapshot.native.EV_TARGET_VERSION = different
  await assert.rejects(f.invoke(), /VERSION_CONFLICT/)
  assert.deepEqual(f.state.calls, [])
})
for (const flag of ["badBody", "badTable", "badInclude"] as const)
  test(`route refuses ${flag} before native invocation`, async () => {
    const f = fixture()
    f.state[flag] = true
    await assert.rejects(f.invoke())
    assert.deepEqual(f.state.calls, [])
  })
const corruptions: Record<string, (out: Record<string, unknown>) => void> = {
  authorization: (o) => {
    o.EV_CODE = "AUTHORIZATION_DENIED"
  },
  missingObject: (o) => {
    o.EV_CODE = "OBJECT_NOT_DEFINED"
  },
  partial: (o) => {
    delete o.ET_OBJS
  },
  binding: (o) => {
    o.EV_TARGET_VERSION = different
  },
  foreign: (o) => {
    ;(o.ET_OBJS as Record<string, string>[])[0]!.OBJECTNAME = "OTHER"
  },
  duplicate: (o) => {
    ;(o.ET_OBJS as Record<string, string>[]).push((o.ET_OBJS as Record<string, string>[])[0]!)
  },
  memberLimit: (o) => {
    o.ET_OBJS = Array(21).fill((o.ET_OBJS as unknown[])[0])
  },
  methodLimit: (o) => {
    o.ET_OBJM = Array(11).fill((o.ET_OBJM as unknown[])[0])
  },
  methodWildcard: (o) => {
    ;(o.ET_OBJM as Record<string, string>[])[0]!.METHODNAME = "*"
  },
  unknownMethod: (o) => {
    ;(o.ET_OBJM as Record<string, string>[])[0]!.METHOD = "RUN"
  },
  unexpectedAudit: (o) => {
    ;(o.ET_OBJH as Record<string, string>[])[0]!.LUSER = "OTHER"
  }
}
for (const [name, change] of Object.entries(corruptions))
  test(`route discards ${name} without usable metadata`, async () => {
    const f = fixture()
    change(f.state.output)
    await assert.rejects(f.invoke())
  })
for (const flag of [
  "fault",
  "drift",
  "changedAfter",
  "changedMethod",
  "changedTableAfter"
] as const)
  test(`route discards ${flag} without usable metadata`, async () => {
    const f = fixture()
    f.state[flag] = true
    await assert.rejects(f.invoke())
  })
test("dialog import metadata never enables execution", async () => {
  const f = fixture()
  ;(f.state.output.ET_OBJH as Record<string, string>[])[0]!.IMPORTABLE = "2"
  const result = await f.invoke()
  assert.equal(result.importHandling, "dialog")
  assert.equal(result.executable, false)
})
test("native route control structures are balanced and contain no mutating command", () => {
  const stack: string[] = [],
    closes: Record<string, string> = { ENDCASE: "CASE", ENDDO: "DO", ENDIF: "IF" }
  for (const line of api.source) {
    assert.ok(line.length <= 72)
    const token = line.trim().match(/^(CASE|DO|IF|ENDCASE|ENDDO|ENDIF)\b/)?.[1]
    if (!token) continue
    if (closes[token]) assert.equal(stack.pop(), closes[token], line)
    else stack.push(token)
  }
  assert.deepEqual(stack, [])
  assert.ok(
    !api.source.some((line) =>
      /^\s*(COMMIT|ROLLBACK|UPDATE|DELETE|INSERT|MODIFY|SUBMIT)\b/.test(line)
    )
  )
  assert.ok(api.source.includes("  lv_pass = sy-index."))
})
