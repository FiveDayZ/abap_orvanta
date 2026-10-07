import assert from "node:assert/strict"
import test from "node:test"
import type { RemoteFunctionValue } from "../src/backend.js"
import {
  configurationBcGuardApi as api,
  configurationBcGuardLayouts as layouts
} from "../src/configuration-bc-guard-api.js"
import {
  readConfigurationBcGuard as read,
  configurationBcGuardKeys as keys
} from "../src/configuration-bc-guard.js"
import { configurationBcPreviewSourceVersion as source } from "../src/configuration-bc-preview.js"

const version = "a".repeat(64),
  different = "b".repeat(64)
const input = {
  connectionId: "w200",
  bcSetId: "EHS_CUNI_KNM",
  version: "N",
  nativeSourceVersion: source,
  nativeTargetVersion: version,
  nativeMetadataVersion: version
}
function fixture() {
  const route = {
    ...input,
    client: "200",
    readOnly: true,
    executable: false,
    activationAvailable: false,
    methodExecutionAvailable: false,
    snapshot: false,
    metadataVersion: version,
    object: { name: "CUNI", type: "T", transportType: "TDAT" },
    members: ["T006", "T006A", "T006B", "T006C", "T006D", ...Object.keys(layouts)].map(
      (TABNAME) => ({ OBJECTNAME: "CUNI", OBJECTTYPE: "T", TABNAME })
    ),
    methods: [],
    methodSources: [],
    native: {
      EV_SYSTEM: "GR2",
      EV_CLIENT: "200",
      EV_USER: "WYS",
      EV_SOURCE_VERSION: source,
      EV_TARGET_VERSION: version,
      EV_METADATA_VERSION: version,
      ET_OBJH: [{ CLIDEP: "X", LANGDEP: "X" }]
    }
  }
  const output: Record<string, RemoteFunctionValue> = {
    EV_CODE: "GUARD_READ_OK",
    EV_SYSTEM: "GR2",
    EV_CLIENT: "200",
    EV_USER: "WYS",
    EV_SOURCE_VERSION: source,
    EV_TARGET_VERSION: version,
    EV_METADATA_VERSION: version,
    EV_GUARD_VERSION: version
  }
  for (const name of Object.keys(layouts) as (keyof typeof layouts)[])
    output[`ET_${name}`] = keys
      .filter((k) => k.tableName === name)
      .map((k) => ({
        ...Object.fromEntries(layouts[name].fields.map((f) => [f, ""])),
        ...k.key
      }))
  ;(output.ET_T006_OIB as Record<string, string>[])[0]!.PRES_VALUE = "0"
  const state = {
    calls: 0,
    routes: 0,
    metadata: 0,
    badBody: false,
    badLayout: false,
    wrongFields: false,
    lateLayout: false,
    lateApi: false,
    drift: false,
    changedValue: false,
    routeDrift: false,
    fault: false
  }
  const invoke = (raw: unknown = input, client = "200") =>
    read(
      raw,
      client,
      {
        callRemoteFunction: async (connection, request) => {
          assert.equal(connection, "w200")
          assert.equal(request.functionName, api.functionName)
          state.calls++
          for (const p of api.tableParameters) {
            assert.deepEqual(request.inputParameters[p.name], [])
            assert.deepEqual(request.outputParameters.find((o) => o.name === p.name)?.fields, [
              ...layouts[p.typeName].fields
            ])
          }
          assert.equal(request.inputParameters.IV_METADATA_VERSION, input.nativeMetadataVersion)
          if (state.fault)
            return { outputs: {}, fault: { code: "FIXTURE", name: "FAULT", message: "fixture" } }
          const value = structuredClone(output)
          if (state.calls === 2) {
            if (state.drift) value.EV_GUARD_VERSION = different
            if (state.changedValue)
              (value.ET_T006_OIB as Record<string, string>[])[0]!.PRES_VALUE = "1"
          }
          return { outputs: value }
        }
      },
      async () => {
        state.routes++
        const value = structuredClone(route)
        if (state.routeDrift && state.routes === 2) value.native.EV_USER = "OTHER"
        return value
      },
      async () => ({
        ...api,
        connectionId: "w200",
        updateTask: false,
        updateTaskMode: "",
        changingParameters: [],
        exceptions: [],
        sourceFingerprint: state.lateApi && state.metadata > 5 ? different : version,
        interfaceFingerprint: version,
        source: [
          `FUNCTION ${api.functionName}.`,
          ...(state.badBody ? ["RETURN."] : api.source),
          "ENDFUNCTION."
        ]
      }),
      async (name) => {
        state.metadata++
        return {
          connectionId: "w200",
          objectKind: "transparentTable",
          objectName: name,
          fingerprint:
            state.badLayout || (state.lateLayout && state.metadata > 4)
              ? version
              : layouts[name].fingerprint,
          definition: {
            fields: layouts[name].fields.map((f) => ({
              name: f,
              key: (layouts[name].keys as readonly string[]).includes(f) && !state.wrongFields
            }))
          }
        }
      }
    )
  return { route, output, state, invoke }
}

test("guard returns complete fields and explicit eight-key presence without enabling writes", async () => {
  const f = fixture(),
    r = await f.invoke()
  assert.equal(f.state.calls, 2)
  assert.equal(f.state.routes, 2)
  assert.equal(r.states.length, 8)
  assert.ok(r.states.every((s) => s.status === "present"))
  assert.equal(r.states.find((s) => s.tableName === "T006_OIB")!.values!.PRES_VALUE, "0")
  assert.deepEqual(r.states[0]!.key, { CLIENT: "200", ISOCODE: "KPA" })
  assert.deepEqual(r.states[1]!.key, { CLIENT: "200", LANGU: "1", ISOCODE: "KPA" })
  assert.equal(r.guardVersion, version)
  assert.equal(r.scope.allCuniKeys, false)
  for (const flag of [
    "executable",
    "activationAvailable",
    "methodExecutionAvailable",
    "snapshot"
  ] as const)
    assert.equal(r[flag], false)
  assert.deepEqual(r.evidence, {
    apiInvocations: 2,
    apiInvocationLimit: 2,
    metadataReads: 10,
    metadataReadLimit: 10,
    routeReads: 2,
    routeReadLimit: 2
  })
})
test("empty native tables mean eight named missing states, never a missing response", async () => {
  const f = fixture()
  for (const n of Object.keys(layouts)) f.output[`ET_${n}`] = []
  const r = await f.invoke()
  assert.equal(r.states.length, 8)
  assert.ok(r.states.every((s) => s.status === "missing" && s.values === null))
  assert.equal(r.executable, false)
})
test("guard preserves a partial language presence and full raw decimal text", async () => {
  const f = fixture()
  f.output.ET_T006J = (f.output.ET_T006J as Record<string, string>[]).filter((r) => r.LANGU === "D")
  ;(f.output.ET_T006_OIB as Record<string, string>[])[0]!.PRES_VALUE = "1,2500"
  const r = await f.invoke()
  assert.deepEqual(
    r.states.filter((s) => s.tableName === "T006J").map((s) => s.status),
    ["missing", "present", "missing"]
  )
  assert.equal(r.native.ET_T006_OIB[0]!.PRES_VALUE, "1,2500")
})
for (const [label, raw, client] of [
  ["unattested source", { ...input, nativeSourceVersion: different }, "200"],
  ["other client", input, "300"],
  ["other connection", { ...input, connectionId: "w300" }, "200"],
  ["key injection", { ...input, key: "KG" }, "200"]
] as const)
  test(`guard refuses ${label} before any route or native read`, async () => {
    const f = fixture()
    await assert.rejects(f.invoke(raw, client))
    assert.equal(f.state.routes, 0)
    assert.equal(f.state.calls, 0)
  })
for (const field of ["EV_SOURCE_VERSION", "EV_TARGET_VERSION", "EV_METADATA_VERSION"] as const)
  test(`guard rejects stale route ${field} before native read`, async () => {
    const f = fixture()
    f.route.native[field] = different
    await assert.rejects(f.invoke(), /VERSION_CONFLICT/)
    assert.equal(f.state.calls, 0)
  })
for (const flag of ["badBody", "badLayout", "wrongFields"] as const)
  test(`guard rejects ${flag} before native read`, async () => {
    const f = fixture()
    f.state[flag] = true
    await assert.rejects(f.invoke())
    assert.equal(f.state.calls, 0)
  })
test("guard refuses a duplicate member in the otherwise nine-row route", async () => {
  const f = fixture()
  f.route.members[8] = f.route.members[0]!
  await assert.rejects(f.invoke(), /ROUTE_SCOPE/)
  assert.equal(f.state.calls, 0)
})
test("guard refuses newly registered methods before related-value read", async () => {
  const f = fixture()
  ;(f.route.methods as unknown[]).push({ METHOD: "AFTER_IMP", METHODNAME: "ZMETHOD" })
  await assert.rejects(f.invoke())
  assert.equal(f.state.calls, 0)
})
const corruptions: Record<string, (o: Record<string, RemoteFunctionValue>) => void> = {
  permission: (o) => {
    o.EV_CODE = "AUTHORIZATION_DENIED"
  },
  identity: (o) => {
    o.EV_USER = "OTHER"
  },
  target: (o) => {
    o.EV_TARGET_VERSION = different
  },
  metadata: (o) => {
    o.EV_METADATA_VERSION = different
  },
  noVersion: (o) => {
    o.EV_GUARD_VERSION = ""
  },
  noTable: (o) => {
    delete o.ET_T006I
  },
  noField: (o) => {
    delete (o.ET_T006_OIB as Record<string, string>[])[0]!.COMB_TEMP_UNIT
  },
  otherClient: (o) => {
    ;(o.ET_T006I as Record<string, string>[])[0]!.CLIENT = "300"
  },
  otherIso: (o) => {
    ;(o.ET_T006J as Record<string, string>[])[0]!.ISOCODE = "KG"
  },
  otherLanguage: (o) => {
    ;(o.ET_T006J as Record<string, string>[])[0]!.LANGU = "F"
  },
  otherDimension: (o) => {
    ;(o.ET_T006T as Record<string, string>[])[0]!.DIMID = "MASS"
  },
  duplicate: (o) => {
    ;(o.ET_T006J as Record<string, string>[])[2] = (o.ET_T006J as Record<string, string>[])[0]!
  },
  alias: (o) => {
    const r = (o.ET_T006I as Record<string, string>[])[0]!
    r.MANDT = r.CLIENT!
    delete r.CLIENT
  },
  extraField: (o) => {
    ;(o.ET_T006I as Record<string, string>[])[0]!.EXTRA = "x"
  },
  overLimit: (o) => {
    ;(o.ET_T006I as Record<string, string>[]).push((o.ET_T006I as Record<string, string>[])[0]!)
  },
  control: (o) => {
    ;(o.ET_T006J as Record<string, string>[])[0]!.ISOTXT = "bad\u0000text"
  }
}
for (const [name, change] of Object.entries(corruptions))
  test(`guard discards ${name} without usable protection values`, async () => {
    const f = fixture()
    change(f.output)
    await assert.rejects(f.invoke())
    assert.equal(f.state.calls, 1)
  })
for (const flag of [
  "fault",
  "drift",
  "changedValue",
  "routeDrift",
  "lateLayout",
  "lateApi"
] as const)
  test(`guard discards ${flag} even when the other observations agree`, async () => {
    const f = fixture()
    f.state[flag] = true
    await assert.rejects(f.invoke())
  })
test("native guard queries keep ECC implicit client handling for all four related tables", () => {
  const source = api.source.filter((line) => !line.trim().startsWith('"')).join("\n")
  const queries = [...source.matchAll(/SELECT \* FROM (t006i|t006j|t006t|t006_oib)\b[\s\S]*?\./g)]
  assert.equal(queries.length, 4)
  assert.deepEqual(
    queries.map((query) => query[1]),
    ["t006i", "t006j", "t006t", "t006_oib"]
  )
  for (const query of queries) {
    assert.doesNotMatch(query[0], /\bCLIENT SPECIFIED\b/i)
    const where = query[0].split(/\bWHERE\b/i)[1]
    assert.ok(where, query[0])
    assert.doesNotMatch(where, /\b(client|mandt)\b/i, query[0])
  }
  assert.ok(source.includes("IF sy-sysid <> 'GR2' OR sy-mandt <> '200'."))
})

test("native guard source is bounded, balanced and contains only approved readonly calls", () => {
  const stack: string[] = [],
    closes: Record<string, string> = { ENDIF: "IF", ENDDO: "DO", ENDCASE: "CASE", ENDTRY: "TRY" }
  for (const line of api.source) {
    assert.ok(line.length <= 72, line)
    const token = line.trim().match(/^(IF|DO|CASE|TRY|ENDIF|ENDDO|ENDCASE|ENDTRY)\b/)?.[1]
    if (token) {
      if (closes[token]) assert.equal(stack.pop(), closes[token], line)
      else stack.push(token)
    }
    assert.ok(
      !/^\s*(COMMIT|ROLLBACK|UPDATE|INSERT|DELETE|MODIFY|SUBMIT|CALL TRANSACTION)\b/.test(line)
    )
    if (line.includes("CALL FUNCTION"))
      assert.match(line, /'(Z_ORVANTA_CFG_BC_ROUTE|CALCULATE_HASH_FOR_RAW)'/)
  }
  assert.deepEqual(stack, [])
  assert.ok(api.source.includes("  lv_pass = sy-index."))
  assert.ok(api.source.includes("      WHERE isocode = 'KPA'."))
  assert.ok(api.source.includes("      WHERE msehi = 'KNM'."))
  assert.ok(api.source.includes("      AND ( langu = '1' OR langu = 'D' OR langu = 'E' )."))
  assert.ok(api.source.includes("      AND ( spras = '1' OR spras = 'D' OR spras = 'E' )."))
  assert.ok(api.source.indexOf("et_t006i[] = lt_t006i[].") > api.source.lastIndexOf("ENDDO."))
})
