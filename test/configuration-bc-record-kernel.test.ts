import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  attestConfigurationBcRecordStandardApis,
  configurationBcRecordKernel,
  prepareConfigurationBcRecordPlan
} from "../src/configuration-bc-record-kernel.js"
import { configurationBcPreflightKeys } from "../src/configuration-bc-preflight.js"
import { configurationBcCommandContract } from "../src/configuration-bc-command-contract.js"

const binding = {
  connectionId: "w200",
  system: "GR2",
  client: "200",
  user: "WYS",
  bcSetId: "EHS_CUNI_KNM",
  version: "N",
  requestNumber: "GR2K923429",
  taskNumber: "GR2K923430",
  beforeStateReference: "a".repeat(64),
  sourceVersion: "b".repeat(64),
  candidateVersion: "c".repeat(64),
  metadataVersion: "d".repeat(64)
}
function sample() {
  const before = configurationBcPreflightKeys.map((key, i) => ({
    ...key,
    tableName: key.tableName as string,
    key: { ...key.key },
    present: i >= 10 && i !== 18,
    rawRowVersion: i >= 10 && i !== 18 ? (i + 1).toString(16).padStart(64, "0") : null
  }))
  const candidate = before.map((row, i) => ({
    ...row,
    key: { ...row.key },
    present: i < 10 ? true : row.present,
    rawRowVersion: i < 10 ? (i + 100).toString(16).padStart(64, "0") : row.rawRowVersion
  }))
  return { binding: { ...binding }, before, candidate }
}
test("the 8-existing/11-missing pilot produces ten inserts and exact reversed deletes; PRESS is protected", () => {
  const input = sample()
  assert.equal(input.before.filter((row) => row.present).length, 8)
  const plan = prepareConfigurationBcRecordPlan(binding, input)
  assert.equal(plan.save.length, 10)
  assert.equal(plan.protectedRows.length, 9)
  assert.equal(plan.protectedRows[0]!.key.DIMID, "PRESS")
  assert.equal(plan.protectedRows[8]!.tableName, "T006_OIB")
  assert.equal(plan.protectedRows[8]!.present, false)
  assert.deepEqual(
    plan.recover.map((row) => row.ordinal),
    [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]
  )
  assert.ok(plan.save.every((row) => row.beforeRowVersion === null))
  assert.equal(plan.executable, false)
  assert.equal(plan.recoveryAvailable, false)
  assert.match(plan.planVersion, /^[a-f0-9]{64}$/)
})
test("input row and key order do not change the native maintenance plan or digest", () => {
  const original = sample()
  const reordered = structuredClone(original)
  for (const rows of [reordered.before, reordered.candidate]) {
    rows.reverse()
    for (const row of rows) row.key = Object.fromEntries(Object.entries(row.key).reverse())
  }
  assert.deepEqual(
    prepareConfigurationBcRecordPlan(binding, reordered),
    prepareConfigurationBcRecordPlan(binding, original)
  )
})
test("all nineteen protected identity/presence/hash combinations are checked, including absent OIB", () => {
  for (let i = 10; i < 19; i++) {
    const changed = sample()
    changed.candidate[i]!.present = true
    changed.candidate[i]!.rawRowVersion = "f".repeat(64)
    assert.throws(
      () => prepareConfigurationBcRecordPlan(binding, changed),
      /PROTECTION_CHANGED/,
      `protection ${i + 1}`
    )
    if (i !== 18) {
      const deleted = sample()
      deleted.candidate[i]!.present = false
      deleted.candidate[i]!.rawRowVersion = null
      assert.throws(() => prepareConfigurationBcRecordPlan(binding, deleted), /PROTECTION_CHANGED/)
    }
  }
  const noPressure = sample()
  for (const rows of [noPressure.before, noPressure.candidate]) {
    rows[10]!.present = false
    rows[10]!.rawRowVersion = null
  }
  assert.throws(() => prepareConfigurationBcRecordPlan(binding, noPressure), /PROTECTION_CHANGED/)
})
test("an existing KNM row or a missing desired row stops preparation before any mutation", () => {
  for (let i = 0; i < 10; i++) {
    const existing = sample()
    existing.before[i]!.present = true
    existing.before[i]!.rawRowVersion = "e".repeat(64)
    assert.throws(() => prepareConfigurationBcRecordPlan(binding, existing), /PRECONDITION_FAILED/)
    const missing = sample()
    missing.candidate[i]!.present = false
    missing.candidate[i]!.rawRowVersion = null
    assert.throws(() => prepareConfigurationBcRecordPlan(binding, missing), /PRECONDITION_FAILED/)
  }
})
test("wrong/extra/case-changed keys and duplicates cannot masquerade as nineteen valid proofs", () => {
  const patches = [
    (v: ReturnType<typeof sample>) => {
      v.before[0] = v.before[1]!
    },
    (v: ReturnType<typeof sample>) => {
      v.candidate[7]!.key.MSEH6 = "KN/M2"
    },
    (v: ReturnType<typeof sample>) => {
      v.before[1]!.key.SPRAS = "ZH"
    },
    (v: ReturnType<typeof sample>) => {
      v.candidate[0]!.key.unexpected = "value"
    },
    (v: ReturnType<typeof sample>) => {
      v.before[0]!.tableName = "T000"
    },
    (v: ReturnType<typeof sample>) => {
      v.before[0]!.rawRowVersion = "e".repeat(64)
    },
    (v: ReturnType<typeof sample>) => {
      v.candidate[0]!.rawRowVersion = null
    }
  ]
  for (const patch of patches) {
    const input = sample()
    patch(input)
    assert.throws(() => prepareConfigurationBcRecordPlan(binding, input), /SCOPE_INVALID/)
  }
  assert.throws(() => prepareConfigurationBcRecordPlan(binding, { ...sample(), before: [] }))
  assert.throws(() =>
    prepareConfigurationBcRecordPlan(binding, { ...sample(), restoreBytes: "AAAA" })
  )
})
test("server user and all version references must match the immutable owner binding", () => {
  for (const key of [
    "user",
    "sourceVersion",
    "candidateVersion",
    "metadataVersion",
    "beforeStateReference"
  ] as const) {
    const input = sample()
    input.binding[key] = key === "user" ? "OTHER" : "f".repeat(64)
    assert.throws(() => prepareConfigurationBcRecordPlan(binding, input), /BINDING_INVALID/)
  }
  for (const patch of [{ client: "300" }, { system: "GR3" }, { taskNumber: "GR2K923492" }])
    assert.throws(() =>
      prepareConfigurationBcRecordPlan(binding, { ...sample(), binding: { ...binding, ...patch } })
    )
})

type Definition = {
  connectionId: string
  functionName: string
  remoteEnabled: boolean
  updateTask: boolean
  sourceFingerprint: string
  interfaceFingerprint: string
  importParameters: { name: string; typeName: string; optional: boolean }[]
  exportParameters: { name: string; typeName: string }[]
  tableParameters: { name: string; typeName: string }[]
  exceptions: { name: string }[]
}
// Fixture path starts at the repository, including when test JS is compiled into a private cache.
const metadata = JSON.parse(
  readFileSync("test/fixtures/configuration-bc-record-w200-r64.json", "utf8")
) as { functions: { definition: Definition }[]; scprTypeEvidence: { lines: string[] } }
const definitions = metadata.functions.map((row) => row.definition)
test("actual ten-function ABI pins reject source/interface drift, duplicate functions and remote/update modes", () => {
  assert.equal(attestConfigurationBcRecordStandardApis(definitions).attested, true)
  for (const definition of definitions) {
    for (const patch of [
      { sourceFingerprint: "0".repeat(64) },
      { interfaceFingerprint: "0".repeat(64) },
      { remoteEnabled: true },
      { updateTask: true }
    ]) {
      const changed = definitions.map((d) => (d === definition ? { ...d, ...patch } : d))
      assert.throws(() => attestConfigurationBcRecordStandardApis(changed))
    }
  }
  assert.throws(() =>
    attestConfigurationBcRecordStandardApis([...definitions.slice(1), definitions[1]])
  )
  assert.throws(() => attestConfigurationBcRecordStandardApis(definitions.slice(1)))
})
test("each generated standard call has the actual import/export/table names and required parameters", () => {
  const source = configurationBcRecordKernel.source.join("\n")
  const calls = [...source.matchAll(/CALL FUNCTION '([^']+)'([\s\S]*?)\./g)]
  assert.equal(calls.length, 9)
  for (const [, name, body] of calls) {
    const abi = definitions.find((row) => row.functionName === name)!
    assert.ok(abi, name)
    const supplied = new Set<string>()
    const groups = [
      ...body!.matchAll(
        /\b(EXPORTING|IMPORTING|TABLES|EXCEPTIONS)\b([\s\S]*?)(?=\b(?:EXPORTING|IMPORTING|TABLES|EXCEPTIONS)\b|$)/g
      )
    ]
    for (const [, group, values] of groups) {
      if (group === "EXCEPTIONS") {
        const allowed = new Set([...abi.exceptions.map((v) => v.name), "ERROR_MESSAGE", "OTHERS"])
        for (const [, parameter] of values!.matchAll(/\b([a-z_][a-z0-9_]*)\s*=/gi))
          assert.ok(allowed.has(parameter!.toUpperCase()), `${name}/EXCEPTIONS/${parameter}`)
        continue
      }
      const allowed = new Set(
        (group === "EXPORTING"
          ? abi.importParameters
          : group === "IMPORTING"
            ? abi.exportParameters
            : abi.tableParameters
        ).map((p) => p.name)
      )
      for (const [, parameter] of values!.matchAll(/\b([a-z_][a-z0-9_]*)\s*=/gi)) {
        assert.ok(allowed.has(parameter!.toUpperCase()), `${name}/${group}/${parameter}`)
        if (group === "EXPORTING") supplied.add(parameter!.toUpperCase())
      }
    }
    for (const parameter of abi.importParameters.filter((p) => !p.optional))
      assert.ok(supplied.has(parameter.name), `${name} missing ${parameter.name}`)
  }
  const leaf = definitions.find((row) => row.functionName === "SCPR_PRSET_CT_ONE_TABLE_LOAD")!
  assert.equal(
    leaf.importParameters.find((row) => row.name === "TABLEDESCR")!.typeName,
    "SCPR_RECORD2"
  )
  assert.equal(
    leaf.importParameters.find((row) => row.name === "VALUES")!.typeName,
    "SCPR_VALS_TAB"
  )
})
test("the private native kernel cannot mutate protected tables, commit, release locks or dispatch distribution", () => {
  const source = configurationBcRecordKernel.source.join("\n")
  assert.equal(configurationBcRecordKernel.remoteEnabled, false)
  assert.equal(configurationBcRecordKernel.deploymentReady, false)
  assert.doesNotMatch(
    source,
    /\b(?:COMMIT WORK|COMMIT CONNECTION|ROLLBACK WORK|DEQUEUE_ALL|SCDC_DISTRIBUTE|TRINT_APPEND)\b/i
  )
  assert.doesNotMatch(source, /^\s*(?:INSERT|UPDATE|DELETE|MODIFY)\s/m)
  assert.doesNotMatch(source, /WHEN '(?:T006D|T006I|T006J|T006T|T006_OIB)'/)
  assert.equal((source.match(/CALL FUNCTION 'SCPR_PRSET_CT_ONE_TABLE_LOAD'/g) ?? []).length, 1)
  assert.match(source, /table_unsuitable = 6/)
  assert.match(source, /lv_copy <> lv_full/)
  assert.match(source, /lv_copy <> lv_key/)
  assert.match(source, /ls_checked <> p_record/)
  assert.match(source, /p_errors IS NOT INITIAL/)
  assert.ok(
    source.indexOf("'BEFORE_ROW_CHANGED'") <
      source.indexOf("CALL FUNCTION 'SCPR_PRSET_CT_ONE_TABLE_LOAD'")
  )
  assert.ok(
    source.lastIndexOf("'READBACK_FAILED'") >
      source.indexOf("CALL FUNCTION 'SCPR_PRSET_CT_ONE_TABLE_LOAD'")
  )
})
test("constructed SCPR_RECORD2 members come from the actually read type pool, including its deep subtables", () => {
  const declaration = metadata.scprTypeEvidence.lines.join("\n")
  const body = declaration.split(/BEGIN OF scpr_record2/i)[1]!.split(/END OF scpr_record2/i)[0]!
  const fields = new Set(
    body
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("*"))
      .map((line) => /^\s*(\w+)(?:\(\d+\))?\s+TYPE\b/i.exec(line)?.[1]?.toUpperCase())
      .filter(Boolean)
  )
  const source = configurationBcRecordKernel.source.join("\n")
  for (const [, field] of source.matchAll(/ls_descr-([a-z_]+)/gi))
    assert.ok(fields.has(field!.toUpperCase()), `SCPR_RECORD2/${field}`)
  for (const name of ["DESCR", "SELLIST", "HEADER", "NAMTAB"]) assert.ok(fields.has(name))
  assert.match(declaration, /scpr_flddescr TYPE scpr_descr/i)
})
test("public preparation continues to require complete command ownership and separately protects PRESS", () => {
  const contract = configurationBcCommandContract({
    connectionId: binding.connectionId,
    bcSetId: binding.bcSetId,
    version: binding.version,
    requestNumber: binding.requestNumber,
    taskNumber: binding.taskNumber,
    operationId: "r64-contract-01",
    beforeStateReference: binding.beforeStateReference
  })
  assert.equal(contract.executable, false)
  assert.equal(contract.recoveryAvailable, false)
  assert.ok(contract.requiredNativeChecks.includes("lossless_standard_record_preparation"))
  assert.ok(contract.successProof.includes("shared_PRESS_dimension_unchanged"))
})
test("the batch validates ten unique ordered records before global initialization and mutation, and reports staged counts", () => {
  const source = configurationBcRecordKernel.source.join("\n")
  const batch = source.slice(source.indexOf("FORM orv_bc_records_stage"))
  const initialization = batch.indexOf("CALL FUNCTION 'SCPR_HI_SET_GLOBAL_ACTOPTS'")
  const preparation = batch.indexOf("PERFORM orv_bc_record_prepare")
  const staging = batch.indexOf("PERFORM orv_bc_record_stage USING")
  assert.ok(preparation >= 0 && preparation < initialization && initialization < staging)
  assert.ok(batch.indexOf("'OWNER_OPTIONS_INVALID'") < initialization)
  assert.match(batch, /lv_count <> 10/)
  assert.match(batch, /ls_record-ordinal <> p_failed/)
  assert.match(batch, /ls_record-deleteflag <> lv_deleteflag/)
  assert.match(batch, /lv_ordinal = 11 - lv_ordinal/)
  assert.ok(
    batch.indexOf("IF p_code <> 'RECORD_STAGED'. RETURN.") < batch.indexOf("ADD 1 TO p_staged")
  )
  assert.match(batch, /p_code = 'BATCH_STAGED'/)
  assert.doesNotMatch(batch, /p_code = '(?:APPLIED|RECOVERED|COMMITTED)'/)
})
