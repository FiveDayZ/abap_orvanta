import assert from "node:assert/strict"
import test from "node:test"
import {
  compareConfigurationBcSet,
  configurationBcCompareFields,
  configurationBcCompareFunctions
} from "../src/configuration-bc-compare.js"
import type { readConfigurationBcSet } from "../src/configuration-bc-set.js"
import type { readConfigurationUnit } from "../src/configuration-unit.js"
import { toolContracts } from "../src/contracts.js"
import { toolNamesForProfile } from "../src/tool-registry.js"

// Synthetic observations exercise failure paths; they do not claim SAP configuration or activation.
const input = {
  connectionId: "w200",
  bcSetId: "ZTEST",
  version: "N",
  objectName: "T006A",
  language: "ZH"
}
const fixture = () => {
  let sourceReads = 0,
    targetReads = 0
  const content = {
    status: "partial",
    readFingerprint: "a".repeat(64),
    coverage: { truncated: false },
    evidence: {},
    records: [{ RECNUMBER: "1", UNCOMPLETE: "", DELETEFLAG: "", GENREF: "" }],
    values: [
      { RECNUMBER: "1", FIELDNAME: "MSEHI", FLAG: "UKY", VALUE: "KG" },
      { RECNUMBER: "1", FIELDNAME: "SPRAS", FLAG: "KEY", VALUE: "D" }
    ],
    languageValues: [
      { RECNUMBER: "1", FIELDNAME: "MSEHT", LANGU: "1", FLAG: "FIX", VALUE: "expected" }
    ]
  }
  const options = {
    sourceChanged: false,
    targetChanged: false,
    targetFailed: false,
    missing: false,
    metadataChanged: false
  }
  const fields = configurationBcCompareFields.T006A
  const element = async (objectName: string) => {
    const [, domainName, fingerprint] = fields[objectName as keyof typeof fields]
    return {
      connectionId: "w200",
      objectName,
      objectKind: "dataElement",
      fingerprint,
      definition: { domainName }
    }
  }
  const domain = async (objectName: string) => {
    const [length, , , fingerprint] = Object.values(fields).find((v) => v[1] === objectName)!
    return {
      connectionId: "w200",
      objectName,
      objectKind: "domain",
      fingerprint: options.metadataChanged && sourceReads ? "0".repeat(64) : fingerprint,
      definition: { dataType: "CHAR", length, conversionExit: "" }
    }
  }
  const fn = async (functionName: string) => {
    const [sourceFingerprint, interfaceFingerprint] =
      configurationBcCompareFunctions[functionName as keyof typeof configurationBcCompareFunctions]
    return {
      connectionId: "w200",
      functionName,
      remoteEnabled: false,
      updateTask: false,
      sourceFingerprint,
      interfaceFingerprint
    }
  }
  const run = (raw: unknown = input, client = "200") =>
    compareConfigurationBcSet(
      raw,
      client,
      async () =>
        ({
          ...content,
          readFingerprint:
            options.sourceChanged && sourceReads++ ? "c".repeat(64) : content.readFingerprint
        }) as unknown as Awaited<ReturnType<typeof readConfigurationBcSet>>,
      async (value) => {
        targetReads++
        if (options.targetFailed) throw Error("403")
        return {
          readFingerprint:
            options.targetChanged && targetReads > 1 ? "d".repeat(64) : "b".repeat(64),
          evidence: { valuesRechecked: true },
          unit: {
            status: options.missing ? "not_found" : "read",
            data: options.missing ? null : { MANDT: "200", MSEHI: value.unitKey }
          },
          text: {
            status: options.missing ? "not_found" : "read",
            sapLanguage: "1",
            data: options.missing
              ? null
              : { MANDT: "200", MSEHI: value.unitKey, SPRAS: "1", MSEHT: "current" }
          }
        } as unknown as Awaited<ReturnType<typeof readConfigurationUnit>>
      },
      element,
      domain,
      fn
    )
  return { content, options, run, targetReads: () => targetReads }
}

test("BC Set comparison selects stored translation cells without resolving a variable activation language", async () => {
  const f = fixture(),
    r = await f.run()
  assert.equal(r.status, "partial")
  assert.deepEqual(r.rows[0]?.key, { MANDT: "200", MSEHI: "KG", SPRAS: "1" })
  assert.deepEqual(r.rows[0]?.fields[0], {
    field: "MSEHT",
    source: "SCPRVALL",
    flag: "FIX",
    protected: true,
    expected: "expected",
    current: "current",
    status: "different"
  })
  assert.equal(r.coverage.activationKeyResolved, false)
  assert.equal(r.coverage.languageOverlayApplied, false)
  assert.equal(r.saveAvailable, false)
  assert.equal(f.targetReads(), 2)
  f.content.languageValues[0]!.VALUE = "current"
  assert.equal((await f.run()).rows[0]?.fields[0]?.status, "equal_trimmed_value")
})
test("actual target absence differs from an unavailable target", async () => {
  const f = fixture()
  f.options.missing = true
  assert.equal((await f.run()).rows[0]?.fields[0]?.status, "target_missing")
  f.options.targetFailed = true
  const unavailable = await f.run()
  assert.equal(unavailable.status, "incomparable")
  assert.deepEqual(unavailable.rows, [])
})
test("variable, wildcard and incomplete keys never select target rows", async () => {
  for (const change of ["variable", "wildcard", "incomplete", "delete", "generic"]) {
    const f = fixture()
    if (change === "variable") f.content.values[0]!.FLAG = "KEY"
    if (change === "wildcard") f.content.values[0]!.VALUE = "K*"
    if (change === "incomplete") f.content.records[0]!.UNCOMPLETE = "X"
    if (change === "delete") f.content.records[0]!.DELETEFLAG = "L"
    if (change === "generic") f.content.records[0]!.GENREF = "2"
    assert.equal((await f.run()).rows[0]?.status, "incomparable")
    assert.equal(f.targetReads(), 0)
  }
})
test("variable values, unknown fields and ambiguous language overlays cannot report equality", async () => {
  for (const change of ["variable", "unknown", "conflict", "wrong_language"]) {
    const f = fixture()
    if (change === "variable") f.content.languageValues[0]!.FLAG = "VAR"
    if (change === "unknown") f.content.languageValues[0]!.FIELDNAME = "TEMP_VALUE"
    if (change === "conflict")
      f.content.values.push({ RECNUMBER: "1", FIELDNAME: "MSEHT", FLAG: "USE", VALUE: "expected" })
    if (change === "wrong_language") f.content.languageValues[0]!.LANGU = "E"
    assert.equal((await f.run()).rows[0]?.fields[0]?.status, "incomparable")
  }
})
test("truncated or orphaned content does not query targets", async () => {
  const f = fixture()
  f.content.coverage.truncated = true
  assert.equal((await f.run()).status, "incomparable")
  f.content.coverage.truncated = false
  f.content.languageValues[0]!.RECNUMBER = "99"
  assert.equal((await f.run()).code, "BC_SET_CONTENT_LINKAGE_UNVERIFIED")
  assert.equal(f.targetReads(), 0)
})
test("source or target drift discards all comparisons, metadata drift refuses the reply", async () => {
  for (const option of ["sourceChanged", "targetChanged"] as const) {
    const f = fixture()
    f.options[option] = true
    const r = await f.run()
    assert.equal(r.status, "changed")
    assert.deepEqual(r.rows, [])
  }
  const f = fixture()
  f.options.sourceChanged = true
  f.options.metadataChanged = true
  await assert.rejects(f.run(), /FIELD_UNVERIFIED/)
})
test("target observation budget is enforced without dropping the unobserved record", async () => {
  const f = fixture()
  f.content.records = Array.from({ length: 11 }, (_, i) => ({
    RECNUMBER: String(i + 1),
    UNCOMPLETE: "",
    DELETEFLAG: "",
    GENREF: ""
  }))
  f.content.values = f.content.records.map((r, i) => ({
    RECNUMBER: r.RECNUMBER,
    FIELDNAME: "MSEHI",
    FLAG: "UKY",
    VALUE: `U${String(i).padStart(2, "0")}`
  }))
  f.content.languageValues = f.content.records.map((r) => ({
    RECNUMBER: r.RECNUMBER,
    FIELDNAME: "MSEHT",
    LANGU: "1",
    FLAG: "USE",
    VALUE: "text"
  }))
  const result = await f.run()
  assert.equal(result.coverage.targetReads, 10)
  assert.equal(result.rows.length, 11)
  assert.equal(result.rows[10]?.code, "BC_SET_TARGET_READ_LIMIT")
  assert.equal(f.targetReads(), 20)
})

test("scope and undeclared inputs fail before reads, tools remain read-only", async () => {
  const f = fixture()
  await assert.rejects(f.run({ ...input, connectionId: "w300" }), /SCOPE_UNSUPPORTED/)
  await assert.rejects(f.run({ ...input, sql: "SELECT" }))
  assert.equal(f.targetReads(), 0)
  for (const name of ["find_configuration_bc_sets", "compare_configuration_bc_set"] as const) {
    assert.equal(toolContracts[name].annotations.readOnlyHint, true)
    assert.ok(toolNamesForProfile("config").includes(name))
    assert.ok(toolNamesForProfile("readonly").includes(name))
  }
})
