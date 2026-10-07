import assert from "node:assert/strict"
import test from "node:test"
import type { RemoteFunctionResult } from "../src/backend.js"
import { configurationBcPreviewApi as api } from "../src/configuration-bc-preview-api.js"
import { configurationBcNativeLayouts as layouts } from "../src/configuration-bc-native-api.js"
import {
  configurationBcPreviewFunctions as functions,
  configurationBcPreviewIncludes as includes,
  configurationBcPreviewStructures as structures
} from "../src/configuration-bc-preview-pins.js"
import {
  previewConfigurationBcNative as preview,
  configurationBcPreviewSourceVersion as source
} from "../src/configuration-bc-preview.js"
import type { readConfigurationBcNative } from "../src/configuration-bc-native.js"
const version = "a".repeat(64),
  input = {
    connectionId: "w200",
    bcSetId: "EHS_CUNI_KNM",
    version: "N",
    nativeSourceVersion: source,
    nativeTargetVersion: version
  }
type Snapshot = Awaited<ReturnType<typeof readConfigurationBcNative>>
const names = ["T006", "T006A", "T006B", "T006C", "T006D"] as const
test("native preview closes control blocks in nesting order", () => {
  const check = (source: readonly string[]) => {
    const stack: string[] = []
    const closes: Record<string, string> = {
      ENDCASE: "CASE",
      ENDDO: "DO",
      ENDLOOP: "LOOP",
      ENDIF: "IF",
      ENDTRY: "TRY"
    }
    for (const line of source) {
      const token = line
        .trim()
        .match(/^(CASE|DO|LOOP|IF|TRY|ENDCASE|ENDDO|ENDLOOP|ENDIF|ENDTRY)\b/)?.[1]
      if (!token) continue
      if (closes[token]) assert.equal(stack.pop(), closes[token], line)
      else stack.push(token)
    }
    assert.deepEqual(stack, [])
  }
  check(api.source)
  const lastCase = api.source.lastIndexOf("    ENDCASE.")
  assert.ok(lastCase >= 0)
  assert.throws(() => check(api.source.filter((_, i) => i !== lastCase)))
})
function fixture() {
  const counts = { api: 0, snapshots: 0 },
    row = (n: (typeof names)[number], lang?: string) => ({
      ...Object.fromEntries(layouts[n].fields.map((f) => [f, ""])),
      MANDT: "200",
      ...(n === "T006D"
        ? { DIMID: "PRESS", LENG: "-1", MASS: "1", TIMEX: "-2" }
        : { MSEHI: "KNM" }),
      ...(lang ? { SPRAS: lang } : {}),
      ...(n === "T006B" ? { MSEH3: "KNM" } : {}),
      ...(n === "T006C" ? { MSEH6: "kN/m2" } : {})
    })
  const native = {
    EV_CODE: "READ_OK",
    EV_SYSTEM: "GR2",
    EV_CLIENT: "200",
    EV_USER: "WYS",
    EV_SOURCE_VERSION: source,
    EV_TARGET_VERSION: version,
    ...Object.fromEntries(names.map((n) => [`ET_${n}`, n === "T006D" ? [row(n)] : []]))
  }
  const out: Record<string, unknown> = {
    EV_CODE: "PREVIEW_OK",
    EV_SYSTEM: "GR2",
    EV_CLIENT: "200",
    EV_USER: "WYS",
    EV_SOURCE_VERSION: source,
    EV_TARGET_VERSION: version,
    EV_CANDIDATE_VERSION: version,
    EV_ERROR_FIELD: "",
    ...Object.fromEntries(
      names.map((n) => [
        `ET_${n}`,
        ["T006A", "T006B", "T006C"].includes(n) ? ["1", "D", "E"].map((l) => row(n, l)) : [row(n)]
      ])
    )
  }
  out.EV_DIFFERENCES = names
    .flatMap((n) =>
      (out[`ET_${n}`] as Record<string, string>[]).flatMap((_, i) =>
        layouts[n].fields.map((f) => `${n}:${i + 1}:${f}:${n === "T006D" ? "EQL" : "NEW"};`)
      )
    )
    .join("")
  const states = names.flatMap((n) =>
    (["T006A", "T006B", "T006C"].includes(n) ? ["1", "D", "E"] : [undefined]).map((lang) => ({
      tableName: n,
      key: {
        MANDT: "200",
        ...(lang ? { SPRAS: lang } : {}),
        ...(n === "T006D"
          ? { DIMID: "PRESS" }
          : n === "T006B"
            ? { MSEH3: "KNM" }
            : n === "T006C"
              ? { MSEH6: "kN/m2" }
              : { MSEHI: "KNM" })
      },
      status: n === "T006D" ? "present" : "missing",
      mappingConflict: false
    }))
  )
  const state = {
    out,
    native,
    states,
    counts,
    changedDefinition: false,
    changedInclude: false,
    changedStructure: false,
    fault: false,
    mutation: () => {},
    definition: async (n: string) =>
      n === api.functionName
        ? {
            connectionId: "w200",
            functionName: n,
            functionGroup: api.functionGroup,
            remoteEnabled: true,
            updateTask: false,
            updateTaskMode: "",
            sourceFingerprint: version,
            interfaceFingerprint: version,
            source: [
              `FUNCTION ${n}.`,
              ...api.source,
              ...(state.changedDefinition ? ["COMMIT WORK."] : []),
              "ENDFUNCTION."
            ],
            importParameters: api.importParameters,
            exportParameters: api.exportParameters,
            tableParameters: api.tableParameters,
            changingParameters: [],
            exceptions: []
          }
        : {
            connectionId: "w200",
            functionName: n,
            updateTask: false,
            ...functions[n as keyof typeof functions],
            source: Array(functions[n as keyof typeof functions].lineCount).fill("")
          },
    structure: async (n: string) => ({
      connectionId: "w200",
      objectName: n,
      objectKind: "structure",
      fingerprint: state.changedStructure ? version : structures[n as keyof typeof structures]
    }),
    include: async (n: keyof typeof includes) => ({
      connectionId: "w200",
      objectName: n,
      ...includes[n],
      ...(state.changedInclude ? { sourceFingerprint: version } : {})
    }),
    snapshot: async () => {
      counts.snapshots++
      return structuredClone({
        native: state.native,
        states: state.states,
        evidence: {}
      }) as unknown as Snapshot
    },
    backend: {
      callRemoteFunction: async (
        c: string,
        r: { functionName: string; inputParameters: Record<string, unknown> }
      ) => {
        counts.api++
        assert.equal(c, "w200")
        assert.equal(r.functionName, api.functionName)
        assert.equal(r.inputParameters.IV_SOURCE_VERSION, source)
        assert.equal(r.inputParameters.IV_TARGET_VERSION, version)
        for (const p of api.tableParameters) assert.deepEqual(r.inputParameters[p.name], [])
        state.mutation()
        return {
          outputs: structuredClone(state.out),
          ...(state.fault ? { fault: { code: "FAILED", name: "FAILED", message: "FAILED" } } : {})
        } as RemoteFunctionResult
      }
    }
  }
  return {
    state,
    run: (arg: unknown = input) =>
      preview(
        arg,
        "200",
        state.backend,
        state.snapshot,
        state.definition,
        state.structure,
        state.include
      )
  }
}
test("five-table preview returns ten creates and preserved shared PRESS fields with native equality", async () => {
  const f = fixture(),
    r = await f.run()
  assert.equal(r.rows.length, 11)
  assert.equal(r.rows.filter((r) => r.status === "create").length, 10)
  assert.equal(r.rows[10]!.status, "unchanged")
  assert.equal(r.rows[10]!.sharedDimension, true)
  assert.equal(r.rows[10]!.after.PRESS_DEP, "")
  assert.deepEqual(r.omittedFields.T006, ["PRESS_VAL", "PRESS_UNIT"])
  assert.equal(r.rows[0]!.differences.length, 23)
  assert.equal(r.executable, false)
  assert.equal(r.simulation, false)
  assert.equal(r.activationAvailable, false)
  assert.equal(r.saveAvailable, false)
  assert.equal(r.languagePolicy.approvedForActivation, false)
  assert.deepEqual(f.state.counts, { api: 2, snapshots: 2 })
})
test("native field comparison remains authoritative when display strings hide numeric changes", async () => {
  const f = fixture()
  f.state.out.EV_DIFFERENCES = String(f.state.out.EV_DIFFERENCES).replace(
    "T006D:1:LENG:EQL;",
    "T006D:1:LENG:CHG;"
  )
  const r = await f.run()
  assert.equal(r.rows[10]!.status, "change")
  assert.equal(r.rows[10]!.differences[2]!.before, r.rows[10]!.differences[2]!.after)
})
for (const mode of [
  "scope",
  "unknownSource",
  "staleTarget",
  "alias",
  "definition",
  "include",
  "structure"
] as const)
  test(`preview refuses ${mode} before conversion`, async () => {
    const f = fixture()
    let arg: unknown = input
    if (mode === "scope") arg = { ...input, unitKey: "KG" }
    if (mode === "unknownSource") arg = { ...input, nativeSourceVersion: version }
    if (mode === "staleTarget") f.state.native.EV_TARGET_VERSION = "b".repeat(64)
    if (mode === "alias") f.state.states[0]!.mappingConflict = true
    if (mode === "definition") f.state.changedDefinition = true
    if (mode === "include") f.state.changedInclude = true
    if (mode === "structure") f.state.changedStructure = true
    await assert.rejects(f.run(arg))
    assert.equal(f.state.counts.api, 0)
  })
for (const mode of [
  "fault",
  "conversion",
  "scope",
  "partialRows",
  "duplicateLanguage",
  "badDifference",
  "badStatus",
  "extraDifference",
  "version",
  "changedCandidate",
  "changedBefore",
  "changedIncludeAfter"
] as const)
  test(`preview discards ${mode} without a usable candidate`, async () => {
    const f = fixture()
    if (mode === "fault") f.state.fault = true
    if (mode === "conversion") f.state.out.EV_CODE = "CONVERSION_FAILED"
    if (mode === "scope") (f.state.out.ET_T006 as Record<string, string>[])[0]!.MANDT = "300"
    if (mode === "partialRows") f.state.out.ET_T006A = []
    if (mode === "duplicateLanguage")
      (f.state.out.ET_T006A as Record<string, string>[])[1]!.SPRAS = "1"
    if (mode === "badDifference")
      f.state.out.EV_DIFFERENCES = String(f.state.out.EV_DIFFERENCES).replace(
        "T006:1:MANDT:",
        "T006:2:MANDT:"
      )
    if (mode === "badStatus")
      f.state.out.EV_DIFFERENCES = String(f.state.out.EV_DIFFERENCES).replace(
        "T006D:1:LENG:EQL;",
        "T006D:1:LENG:NEW;"
      )
    if (mode === "extraDifference") f.state.out.EV_DIFFERENCES += "T006:1:MANDT:NEW;"
    if (mode === "version") f.state.out.EV_TARGET_VERSION = "b".repeat(64)
    if (mode === "changedCandidate")
      f.state.mutation = () => {
        if (f.state.counts.api === 2) f.state.out.EV_CANDIDATE_VERSION = "b".repeat(64)
      }
    if (mode === "changedBefore")
      f.state.mutation = () => {
        if (f.state.counts.api === 2) f.state.native.EV_USER = "OTHER"
      }
    if (mode === "changedIncludeAfter")
      f.state.mutation = () => {
        if (f.state.counts.api === 2) f.state.changedInclude = true
      }
    await assert.rejects(f.run())
    assert.ok(f.state.counts.api <= 2)
  })
