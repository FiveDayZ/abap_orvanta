import assert from "node:assert/strict"
import test from "node:test"
import {
  configurationUnitFields,
  configurationUnitLayouts,
  configurationUnitComparisonLayouts,
  readConfigurationUnitProjection,
  readConfigurationUnit,
  previewConfigurationUnitText,
  configurationUnitTextPreviewSchema
} from "../src/configuration-unit.js"
import {
  NATIVE_PREVIEW_EMPTY_HTML,
  reviewedTableReaderDefinition
} from "../src/reviewed-table-reader.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"
import { toolContracts } from "../src/contracts.js"
import { toolNamesForProfile } from "../src/tool-registry.js"
import { configurationUnitReadApi } from "../src/configuration-unit-api.js"

// Synthetic configuration. Lowercase/internal keys deliberately differ; no assertion about SAP values.
const dataset = () => {
  const unit = (MSEHI: string, MANDT = "200") => ({
    ...Object.fromEntries(configurationUnitFields.T006.map((f) => [f, ""])),
    MANDT,
    MSEHI,
    ISOCODE: "TEST",
    ANDEC: "3",
    ADDKO: "0.000000"
  })
  return {
    T006: [unit("kg"), unit("KG"), unit("kg", "100")],
    T002: [
      { LAISO: "ZH", SPRAS: "1" },
      { LAISO: "EN", SPRAS: "E" }
    ],
    T006A: [
      {
        MANDT: "200",
        MSEHI: "kg",
        SPRAS: "1",
        MSEH3: "kg",
        MSEH6: "kg",
        MSEHT: "短标题",
        MSEHL: "中文长标题"
      },
      {
        MANDT: "200",
        MSEHI: "kg",
        SPRAS: "E",
        MSEH3: "kg",
        MSEH6: "kg",
        MSEHT: "Unit",
        MSEHL: "Test unit"
      },
      {
        MANDT: "100",
        MSEHI: "kg",
        SPRAS: "1",
        MSEH3: "other",
        MSEH6: "other",
        MSEHT: "other",
        MSEHL: "other client must not leak"
      }
    ]
  }
}
const select = (rows: Record<string, Record<string, string>[]>, sql: string, limit: number) => {
  const match = /^SELECT (.+) FROM (\w+) WHERE (.+)$/.exec(sql)!
  const fields = match[1]!.split(", ")
  const filters = [...match[3]!.matchAll(/(\w+) = '((?:''|[^'])*)'/g)]
  return (rows[match[2]!] ?? [])
    .filter((row) => filters.every((f) => row[f[1]!] === f[2]!.replaceAll("''", "'")))
    .slice(0, limit)
    .map((row) => Object.fromEntries(fields.map((f) => [f, row[f] ?? ""])))
}
const table = async (objectName: string) => ({
  connectionId: "w200",
  objectKind: "transparentTable",
  active: true,
  objectName,
  fingerprint: configurationUnitLayouts[objectName as keyof typeof configurationUnitLayouts]
})
const element = async () => ({
  connectionId: "w200",
  objectKind: "dataElement",
  objectName: "MSEHI",
  fingerprint: "f0577fd354c1f756fcd69c082c6b7ccafe3970fc736acc3105caf2d2e557e2d2",
  definition: { domainName: "MEINS" }
})
const domain = async () => ({
  connectionId: "w200",
  objectKind: "domain",
  objectName: "MEINS",
  fingerprint: "61bf4adf8f8321410beaee2104e8e99102efe3d9ccebade64e49f8d5a1056373",
  definition: { dataType: "UNIT", length: 3, lowercase: true, conversionExit: "CUNIT" }
})
const input = { connectionId: "w200", unitKey: "kg" }

test("text reconciliation distinguishes proposed, partial, absent and unexpected changes without claiming CTS success", async () => {
  const baseline = await run(),
    request = {
      ...input,
      language: "ZH",
      textReconciliation: {
        baselineReadFingerprint: baseline.readFingerprint,
        baselineUnit: baseline.unit.data,
        baselineText: baseline.text.data,
        patch: { MSEHT: "改短", MSEHL: "改长" }
      }
    }
  for (const [expected, edit] of [
    ["unchanged", (_rows: ReturnType<typeof dataset>) => {}],
    [
      "values_match",
      (rows: ReturnType<typeof dataset>) => {
        rows.T006A[0]!.MSEHT = "改短"
        rows.T006A[0]!.MSEHL = "改长"
      }
    ],
    [
      "partial",
      (rows: ReturnType<typeof dataset>) => {
        rows.T006A[0]!.MSEHL = "改长"
      }
    ],
    [
      "unexpected_changes",
      (rows: ReturnType<typeof dataset>) => {
        rows.T006A[0]!.MSEH6 = "别名改动"
      }
    ],
    [
      "unexpected_changes",
      (rows: ReturnType<typeof dataset>) => {
        rows.T006[0]!.ANDEC = "1"
      }
    ],
    [
      "unexpected_changes",
      (rows: ReturnType<typeof dataset>) => {
        rows.T006A[0]!.MSEHL = "其他文本"
      }
    ],
    [
      "not_found",
      (rows: ReturnType<typeof dataset>) => {
        rows.T006A = []
      }
    ],
    [
      "not_found",
      (rows: ReturnType<typeof dataset>) => {
        rows.T006 = []
      }
    ],
    [
      "target_mismatch",
      (rows: ReturnType<typeof dataset>) => {
        rows.T002[0]!.SPRAS = "E"
      }
    ]
  ] as const) {
    const rows = dataset()
    edit(rows)
    const result = await run(request, rows),
      audit = result.textReconciliation!
    assert.equal(audit.status, expected)
    assert.equal(audit.complete, false)
    assert.equal(audit.executable, false)
    assert.equal(audit.maintenanceSucceeded, "not_attested")
    assert.equal(audit.cts.exactRowRecording, "not_verified")
    assert.equal(audit.baselineOrigin, "caller_supplied_untrusted")
    assert.equal(result.evidence.sources.length, baseline.evidence.sources.length)
    if (["not_found", "target_mismatch"].includes(expected)) assert.equal(audit.changes, null)
  }
  const noChanges = await run({
    ...request,
    textReconciliation: {
      ...request.textReconciliation,
      patch: { MSEHL: baseline.text.data!.MSEHL }
    }
  })
  assert.equal(noChanges.textReconciliation!.status, "no_changes")
  const omittedChanged = dataset()
  omittedChanged.T006A[0]!.MSEHT = "意外短名"
  assert.equal(
    (
      await run(
        {
          ...request,
          textReconciliation: { ...request.textReconciliation, patch: { MSEHL: "改长" } }
        },
        omittedChanged
      )
    ).textReconciliation!.status,
    "unexpected_changes"
  )
})

test("text reconciliation rejects malformed and cross-scope baselines before reads and discards unstable observations", async () => {
  const baseline = await run(),
    reconciliation = {
      baselineReadFingerprint: baseline.readFingerprint,
      baselineUnit: baseline.unit.data!,
      baselineText: baseline.text.data!,
      patch: { MSEHL: "改长" }
    },
    request = { ...input, language: "ZH", textReconciliation: reconciliation }
  for (const raw of [
    { ...request, language: undefined },
    { ...request, language: "EN" },
    { ...request, unitKey: "KG" },
    { ...request, connectionId: "w300" },
    { ...request, expectedReadFingerprint: baseline.readFingerprint },
    {
      ...request,
      textReconciliation: { ...reconciliation, baselineReadFingerprint: "0".repeat(64) }
    },
    {
      ...request,
      textReconciliation: {
        ...reconciliation,
        baselineText: { ...reconciliation.baselineText, MANDT: "300" }
      }
    },
    {
      ...request,
      textReconciliation: {
        ...reconciliation,
        baselineUnit: { ...reconciliation.baselineUnit, ANDEC: "1" }
      }
    },
    { ...request, textReconciliation: { ...reconciliation, baselineUnit: {} } },
    {
      ...request,
      textReconciliation: {
        ...reconciliation,
        baselineText: { ...reconciliation.baselineText, MSEHL: " padding " }
      }
    },
    { ...request, textReconciliation: { ...reconciliation, patch: { MSEH3: "alias" } } },
    { ...request, textReconciliation: { ...reconciliation, patch: { MSEHL: "x".repeat(31) } } },
    { ...request, textReconciliation: { ...reconciliation, ctsVerified: true } },
    { ...request, execute: true }
  ])
    await assert.rejects(
      run(
        raw,
        undefined,
        async () => assert.fail("invalid input must not read"),
        "200",
        async () => assert.fail("invalid baseline must not read metadata")
      )
    )
  let calls = 0
  const unstable = await run(request, undefined, async (sql, limit) => {
    calls++
    const rows = dataset()
    if (calls > 3) rows.T006A[0]!.MSEHL = "并发变化"
    return select(rows, sql, limit)
  })
  assert.equal(unstable.textReconciliation!.status, "changed_during_read")
  assert.equal(unstable.textReconciliation!.changes, null)
  assert.equal(unstable.textReconciliation!.currentReadFingerprint, null)
  const unavailable = await run(request, undefined, async () => {
    throw Error("permission failure")
  })
  assert.equal(unavailable.textReconciliation!.status, "unavailable")
  assert.equal(unavailable.textReconciliation!.changes, null)
  const absentAndDenied = dataset()
  absentAndDenied.T006 = []
  const incomplete = await run(request, absentAndDenied, async (sql, limit) => {
    if (sql.includes("FROM T006A ")) throw Error("text permission denied")
    return select(absentAndDenied, sql, limit)
  })
  assert.equal(incomplete.unit.status, "not_found")
  assert.equal(incomplete.text.status, "unavailable")
  assert.equal(incomplete.textReconciliation!.status, "unavailable")
  let mappingReads = 0
  const mappingChanged = await run(request, undefined, async (sql, limit) => {
    const rows = dataset()
    if (sql.includes("FROM T002 ") && ++mappingReads === 1) rows.T002[0]!.SPRAS = "E"
    return select(rows, sql, limit)
  })
  assert.equal(mappingChanged.status, "changed")
  assert.equal(mappingChanged.textReconciliation!.status, "changed_during_read")
  const original = await run()
  assert.equal("textReconciliation" in original, false)
})

test("comparison uses reviewed target metadata and refuses w200 pins or later target drift", async () => {
  const layouts = configurationUnitComparisonLayouts.w300
  const rows = dataset()
  for (const tableRows of [rows.T006, rows.T006A])
    for (const row of tableRows) if (row.MANDT === "200") row.MANDT = "300"
  let reads = 0
  let metadataReads = 0
  const runTarget = (pins: typeof layouts | typeof configurationUnitLayouts, drift = false) =>
    readConfigurationUnitProjection(
      { ...input, connectionId: "w300", language: "ZH" },
      "300",
      "ZH",
      {
        runQuery: async (_id, sql, limit) => {
          reads++
          return select(rows, sql, limit)
        },
        callRemoteFunction: async () => {
          throw Error("unexpected fallback")
        }
      },
      async (name) => ({
        ...(await table(name)),
        connectionId: "w300",
        fingerprint: drift && ++metadataReads > 3 ? "0".repeat(64) : pins[name as keyof typeof pins]
      }),
      async () => ({ ...(await element()), connectionId: "w300" }),
      async () => ({ ...(await domain()), connectionId: "w300" }),
      async () => reviewedTableReaderDefinition.parse({})
    )
  await assert.rejects(runTarget(configurationUnitLayouts), /LAYOUT_UNVERIFIED/)
  assert.equal(reads, 0)
  const result = await runTarget(layouts)
  assert.equal(result.unit.status, "read")
  assert.equal(result.text.status, "read")
  assert.equal(result.unit.data?.MANDT, "300")
  assert.deepEqual(result.evidence.definitionFingerprints, layouts)
  await assert.rejects(runTarget(layouts, true), /LAYOUT_UNVERIFIED/)
})
const run = (
  raw: unknown = input,
  rows = dataset(),
  query = async (sql: string, limit: number) => select(rows, sql, limit),
  client = "200",
  readTable: (name: string) => Promise<unknown> = table,
  readDomain: (name: string) => Promise<unknown> = domain
) =>
  readConfigurationUnit(
    raw,
    client,
    "ZH",
    {
      runQuery: async (_id, sql, limit) => query(sql, limit!),
      callRemoteFunction: async () => assert.fail("native success or permissions must not call RFC")
    },
    readTable,
    element,
    readDomain,
    async () => assert.fail("native success needs no RFC definition")
  )

test("unit read keeps internal key case, client and language, omits floats and rechecks exact values", async () => {
  const result = await run()
  assert.equal(result.unitKey, "kg")
  assert.equal(result.unit.data!.MANDT, "200")
  assert.equal(result.unit.data!.ADDKO, "0.000000")
  assert.equal(result.text.data!.MSEHL, "中文长标题")
  assert.deepEqual(result.coverage.omittedFields.T006, ["TEMP_VALUE", "PRESS_VAL"])
  assert.equal(result.coverage.complete, false)
  assert.equal(result.evidence.sources.length, 6)
  assert.equal(result.evidence.valuesRechecked, true)
  assert.equal(result.usableForWritePrecondition, false)
  assert.equal(result.saveAvailable, false)
  assert.ok(!JSON.stringify(result).includes("other client must not leak"))
  assert.match(result.readFingerprint!, /^[a-f0-9]{64}$/)
  assert.equal(
    (await run({ ...input, expectedReadFingerprint: result.readFingerprint })).comparison,
    "match"
  )
  const en = await run({ ...input, language: " en " })
  assert.equal(en.text.data!.MSEHL, "Test unit")
  assert.notEqual(en.readFingerprint, result.readFingerprint)
  assert.equal((await run({ ...input, unitKey: "KG" })).text.status, "not_found")
})

test("missing translation differs from missing unit or unavailable language; no fallback", async () => {
  const rows = dataset()
  rows.T006A = []
  const missingText = await run(input, rows)
  assert.equal(missingText.unit.status, "read")
  assert.equal(missingText.text.status, "not_found")
  assert.equal(missingText.text.fallbackUsed, false)
  assert.ok(missingText.readFingerprint)
  const missingUnit = await run({ ...input, unitKey: "---" })
  assert.equal(missingUnit.status, "not_found")
  assert.equal(missingUnit.unit.data, null)
  const unknownLanguage = await run({ ...input, language: "ZZ" })
  assert.equal(unknownLanguage.unit.status, "read")
  assert.equal(unknownLanguage.text.status, "unavailable")
  assert.equal(unknownLanguage.text.code, "CONFIGURATION_UNIT_LANGUAGE_NOT_FOUND")
  assert.equal(unknownLanguage.readFingerprint, null)
})

test("other systems/clients, arbitrary fields and invalid keys are rejected before SAP", async () => {
  for (const raw of [
    { ...input, connectionId: "other" },
    { ...input, unitKey: "AAAA" },
    { ...input, unitKey: "a\n" },
    { ...input, unitKey: "a|b" },
    { ...input, tableName: "USR02" },
    { ...input, client: "100" },
    { ...input, expectedReadFingerprint: "wrong" }
  ]) {
    let metadataCalls = 0
    await assert.rejects(
      run(
        raw,
        undefined,
        async () => assert.fail("no query"),
        "200",
        async () => {
          metadataCalls++
          return table("T006")
        }
      )
    )
    assert.equal(metadataCalls, 0)
  }
  await assert.rejects(
    run(input, undefined, undefined, "100", async () => assert.fail("no metadata")),
    /SCOPE_UNSUPPORTED/
  )
})

test("quotes in a short internal key are escaped, not interpolated into SQL", async () => {
  const result = await run({ ...input, unitKey: "a'b" }, undefined, async (sql, limit) => {
    if (sql.includes("FROM T006")) assert.ok(sql.includes("MSEHI = 'a''b'"))
    return select(dataset(), sql, limit)
  })
  assert.equal(result.status, "not_found")
})

test("stale expected fingerprint and changing base/text/language discard returned values", async () => {
  const stale = await run({ ...input, expectedReadFingerprint: "a".repeat(64) })
  assert.equal(stale.comparison, "changed")
  assert.equal(stale.unit.data, null)
  for (const target of ["T006", "T006A", "T002"]) {
    let calls = 0
    const result = await run(input, undefined, async (sql, limit) => {
      const found = select(dataset(), sql, limit)
      if (sql.includes(`FROM ${target} WHERE`) && ++calls === 2)
        found[0]![target === "T002" ? "SPRAS" : target === "T006A" ? "MSEHL" : "ANDEC"] = "changed"
      return found
    })
    assert.equal(result.status, "changed")
    assert.equal(result.unit.data, null)
    assert.equal(result.text.data, null)
    assert.equal(result.readFingerprint, null)
  }
})

test("recheck or permission failure is unavailable, never absence or an invented change", async () => {
  let calls = 0
  const result = await run(input, undefined, async (sql, limit) => {
    if (sql.includes("FROM T006 WHERE") && ++calls === 2) throw new Error("HTTP 403")
    return select(dataset(), sql, limit)
  })
  assert.equal(result.status, "unavailable")
  assert.equal(result.unit.code, "CONFIGURATION_UNIT_RECHECK_UNAVAILABLE")
  assert.equal(result.text.code, "CONFIGURATION_UNIT_RECHECK_UNAVAILABLE")
  assert.equal(result.unit.data, null)
  const refused = await run(input, undefined, async () => {
    throw new Error("HTTP 403")
  })
  assert.equal(refused.status, "unavailable")
  assert.equal(refused.unit.status, "unavailable")
  assert.equal(refused.readFingerprint, null)
})

test("duplicate rows, out-of-scope rows and key/layout drift are refused", async () => {
  const rows = dataset()
  rows.T006.push({ ...rows.T006[0]! })
  const duplicate = await run(input, rows)
  assert.equal(duplicate.unit.code, "CONFIGURATION_UNIT_AMBIGUOUS_RESULT")
  const scope = await run(input, undefined, async (sql, limit) => {
    const found = select(dataset(), sql, limit)
    if (sql.includes("FROM T006 WHERE")) found[0]!.MANDT = "100"
    return found
  })
  assert.equal(scope.unit.code, "CONFIGURATION_UNIT_RESPONSE_SCOPE_MISMATCH")
  let definitions = 0
  await assert.rejects(
    run(input, undefined, undefined, "200", async (name) => ({
      ...(await table(name)),
      fingerprint:
        name === "T006" && ++definitions === 2
          ? "a".repeat(64)
          : configurationUnitLayouts[name as keyof typeof configurationUnitLayouts]
    })),
    /LAYOUT_UNVERIFIED/
  )
  await assert.rejects(
    run(input, undefined, undefined, "200", undefined, async () => ({
      ...(await domain()),
      definition: { ...(await domain().then((v) => v.definition)), lowercase: false }
    })),
    /KEY_METADATA_UNVERIFIED/
  )
})

test("reviewed RFC fallback requests only fixed projections and exact client/key predicates", async () => {
  let calls = 0
  const result = await readConfigurationUnit(
    input,
    "200",
    "ZH",
    {
      runQuery: async () => {
        throw new Error(NATIVE_PREVIEW_EMPTY_HTML)
      },
      callRemoteFunction: async (_id, request) => {
        calls++
        assert.equal(request.functionName, "RFC_READ_TABLE")
        const p = request.inputParameters
        const fields = (p.FIELDS as { FIELDNAME: string }[]).map((f) => f.FIELDNAME)
        assert.ok(!fields.includes("TEMP_VALUE") && !fields.includes("PRESS_VAL"))
        assert.equal(p.ROWCOUNT, "2")
        const where = (p.OPTIONS as { TEXT: string }[]).map((o) => o.TEXT).join(" ")
        if (p.QUERY_TABLE !== "T002") assert.ok(where.includes("MANDT = '200'"))
        const found = select(
          dataset(),
          `SELECT ${fields.join(", ")} FROM ${p.QUERY_TABLE} WHERE ${where}`,
          2
        )
        return {
          outputs: {
            FIELDS: fields.map((FIELDNAME) => ({ FIELDNAME })),
            DATA: found.map((row) => ({ WA: fields.map((f) => row[f]).join("|") }))
          }
        }
      }
    },
    table,
    element,
    domain,
    async () => ({
      functionName: "RFC_READ_TABLE",
      remoteEnabled: true,
      updateTask: false,
      sourceFingerprint: reviewedTableReaderDefinition.shape.sourceFingerprint.value,
      interfaceFingerprint: reviewedTableReaderDefinition.shape.interfaceFingerprint.value
    })
  )
  assert.equal(calls, 6)
  assert.equal(result.text.data!.MSEHL, "中文长标题")
})

test("unit service and config/full/readonly tool profiles expose read-only contract", async () => {
  const backend = new MockBackend()
  const connection = backend.connectionDetails.bind(backend)
  backend.connectionDetails = (id) => ({ ...connection(id), client: "200", language: "ZH" })
  backend.runQuery = async (_id: string, sql: string, limit?: number) =>
    select(dataset(), sql, limit ?? 2)
  const service = new ToolService(backend)
  service.readDdicTransparentTable = async ({ objectName }) =>
    JSON.stringify(await table(objectName))
  service.readDdicDataElement = async () => JSON.stringify(await element())
  service.readDdicDomain = async () => JSON.stringify(await domain())
  const result = JSON.parse(await service.readConfigurationUnit(input))
  assert.equal(result.text.data.MSEHL, "中文长标题")
  const request = {
    ...input,
    language: "ZH",
    textReconciliation: {
      baselineReadFingerprint: result.readFingerprint,
      baselineUnit: result.unit.data,
      baselineText: result.text.data,
      patch: { MSEHL: "对账标题" }
    }
  }
  assert.ok(toolContracts.read_configuration_unit.inputSchema.safeParse(request).success)
  const audit = JSON.parse(await service.readConfigurationUnit(request))
  assert.equal(audit.textReconciliation.status, "unchanged")
  assert.equal(audit.readFingerprint, result.readFingerprint)
  assert.equal(audit.textReconciliation.cts.status, "not_verified")
  assert.equal(toolContracts.read_configuration_unit.annotations.readOnlyHint, true)
  for (const profile of ["config", "full", "readonly"] as const)
    assert.ok(toolNamesForProfile(profile).includes("read_configuration_unit"))
})

test("unit service opts into native API once and retracts a mismatched projection", async () => {
  const backend = new MockBackend(),
    connection = backend.connectionDetails.bind(backend)
  backend.connectionDetails = (id) => ({ ...connection(id), client: "200", language: "ZH" })
  backend.runQuery = async (_id: string, sql: string, limit?: number) =>
    select(dataset(), sql, limit ?? 2)
  const service = new ToolService(backend)
  service.readDdicTransparentTable = async ({ objectName }) =>
    JSON.stringify(await table(objectName))
  service.readDdicDataElement = async () => JSON.stringify(await element())
  service.readDdicDomain = async () => JSON.stringify(await domain())
  let reads = 0,
    calls = 0,
    mismatch = false
  service.readFunctionModuleInterface = async ({ functionName }) => {
    assert.equal(functionName, configurationUnitReadApi.functionName)
    reads++
    return JSON.stringify({
      connectionId: "w200",
      functionName,
      remoteEnabled: true,
      updateTask: false,
      updateTaskMode: "",
      importParameters: configurationUnitReadApi.importParameters,
      exportParameters: configurationUnitReadApi.exportParameters,
      changingParameters: [],
      tableParameters: [],
      exceptions: [],
      sourceFingerprint: "a".repeat(64),
      interfaceFingerprint: "b".repeat(64),
      source: [`FUNCTION ${functionName}.`, ...configurationUnitReadApi.source, "ENDFUNCTION."]
    })
  }
  backend.callRemoteFunction = async (_id, request) => {
    calls++
    assert.deepEqual(request.inputParameters, { IV_UNIT_KEY: "kg", IV_LANGUAGE: "1" })
    return {
      outputs: {
        EV_CODE: "READ",
        EV_SYSTEM: "GR2",
        EV_CLIENT: "200",
        EV_TEXT_VERSION: "c".repeat(64),
        ES_TEXT: {
          ...dataset().T006A[0]!,
          MSEHI: "kg ",
          MSEHL: mismatch ? "changed" : "中文长标题"
        }
      }
    }
  }
  const legacy = JSON.parse(await service.readConfigurationUnit(input))
  assert.equal(reads, 0)
  assert.equal(calls, 0)
  assert.ok(!("apiSnapshot" in legacy))
  await assert.rejects(
    service.readConfigurationUnit({ ...input, includeApiSnapshot: true }),
    /explicit language/
  )
  assert.equal(reads, 0)
  assert.equal(calls, 0)
  const result = JSON.parse(
    await service.readConfigurationUnit({ ...input, language: "ZH", includeApiSnapshot: true })
  )
  assert.equal(result.apiSnapshot.status, "read")
  assert.equal(result.apiSnapshot.textVersion, "c".repeat(64))
  assert.equal(result.readFingerprint, legacy.readFingerprint)
  assert.equal(result.usableForWritePrecondition, false)
  assert.equal(reads, 2)
  assert.equal(calls, 1)
  mismatch = true
  const changed = JSON.parse(
    await service.readConfigurationUnit({ ...input, language: "ZH", includeApiSnapshot: true })
  )
  assert.equal(changed.apiSnapshot.code, "API_PROJECTION_CHANGED")
  assert.equal(changed.apiSnapshot.data, null)
  assert.equal(changed.apiSnapshot.textVersion, null)
  mismatch = false
  const reference = await run()
  service.inspectConfigurationTransport = async () => {
    const nested = JSON.parse(await service.readConfigurationUnit({ ...input, language: "ZH" }))
    assert.equal(nested.apiSnapshot, undefined)
    const receipt = unitCtsReceipt(reference)
    receipt.keyRecording.unitReadFingerprint = "f".repeat(64)
    return JSON.stringify(receipt)
  }
  const duringCts = JSON.parse(
    await service.readConfigurationUnit({
      ...input,
      language: "ZH",
      includeApiSnapshot: true,
      transport: unitTransport,
      textReconciliation: {
        baselineReadFingerprint: reference.readFingerprint,
        baselineUnit: reference.unit.data,
        baselineText: reference.text.data,
        patch: { MSEHL: "新标题" }
      }
    })
  )
  assert.equal(duringCts.textReconciliation.status, "changed_during_read")
  assert.equal(duringCts.apiSnapshot.code, "API_PROJECTION_CHANGED")
  assert.equal(duringCts.apiSnapshot.textVersion, null)
  assert.equal(duringCts.apiSnapshot.data, null)
  backend.runQuery = async (_id: string, sql: string, limit?: number) =>
    select({ ...dataset(), T006A: [] }, sql, limit ?? 2)
  const missing = JSON.parse(
    await service.readConfigurationUnit({ ...input, language: "ZH", includeApiSnapshot: true })
  )
  assert.equal(missing.apiSnapshot.code, "API_SNAPSHOT_PREREQUISITE_MISSING")
  assert.equal(calls, 3)
})

// Metadata captured by the actual T006A descriptor; values above remain synthetic.
const descriptionMetadata = {
  MSEHT: {
    domain: "TEXT10",
    length: 10,
    element: "be7d7dacd8ffb1f467a3d779f41ff85e0411944bf6fc2fb52415feae6b8e5192",
    fingerprint: "522f03d1733e196552d3886c9363f506a967185a66a4b2537a6bb23130db197b"
  },
  MSEHL: {
    domain: "TEXT30",
    length: 30,
    element: "13f25ac06159885981c13d9e7265f68080767717040dd5aca8ba560450f6147b",
    fingerprint: "f24751b3b57d9e6eb6e8aa3de2337743ebe6d208267401899a0a3d8849260d91"
  }
}
const descriptionElement = async (objectName: string) => ({
  connectionId: "w200",
  objectName,
  objectKind: "dataElement",
  fingerprint: descriptionMetadata[objectName as keyof typeof descriptionMetadata].element,
  definition: {
    domainName: descriptionMetadata[objectName as keyof typeof descriptionMetadata].domain
  }
})
const descriptionDomain = async (objectName: string) => {
  const m = Object.values(descriptionMetadata).find((v) => v.domain === objectName)!
  return {
    connectionId: "w200",
    objectName,
    objectKind: "domain",
    fingerprint: m.fingerprint,
    definition: {
      dataType: "CHAR",
      length: m.length,
      decimals: 0,
      lowercase: true,
      conversionExit: "",
      valueTable: "",
      fixedValues: []
    }
  }
}
const draft = (raw: unknown, rows = dataset()) =>
  previewConfigurationUnitText(
    raw,
    "200",
    (request) => run(request, rows),
    descriptionElement,
    descriptionDomain
  )

const unitTransport = { requestNumber: "GR2K917102", taskNumber: "GR2K917103" }
// Synthetic opaque SAP versions; tests deliberately do not reconstruct hashes from display text.
const nativeTextSnapshot = (data: Record<string, string>) => ({
  status: "read",
  code: "READ",
  readOnly: true,
  executable: false,
  saveAvailable: false,
  functionName: "Z_ORVANTA_CFG_UNIT_READ" as const,
  data: { ...data, MSEHI: data.MSEHI!.padEnd(3), MSEHL: data.MSEHL!.padEnd(30) },
  textVersion: "c".repeat(64),
  versionScope: "SAP_GR2_200_full_T006A_row_v1",
  versionOrigin: "sap_sha256_fixed_width_utf8",
  bodyFingerprint: "d".repeat(64),
  evidence: {
    functionReaderInvocations: 2,
    functionReaderInvocationLimit: 2,
    apiInvocations: 1,
    apiInvocationLimit: 1
  },
  warning: "Synthetic fixture"
})

test("native text-version preview is opt-in, bounded and preserves omitted fields and explicit clearing", async () => {
  const baseline = await run(),
    base = {
      ...input,
      language: "ZH",
      expectedReadFingerprint: baseline.readFingerprint,
      patch: { MSEHL: "新标题" }
    }
  for (const patch of [{ MSEHL: "新标题" }, { MSEHL: "" }, { MSEHL: baseline.text.data!.MSEHL! }]) {
    const requests: unknown[] = []
    const result = await previewConfigurationUnitText(
      { ...base, patch, expectedTextVersion: "c".repeat(64) },
      "200",
      async ({ includeApiSnapshot, ...request }) => {
        requests.push({ ...request, ...(includeApiSnapshot ? { includeApiSnapshot } : {}) })
        const current = await run(request)
        return {
          ...current,
          ...(includeApiSnapshot ? { apiSnapshot: nativeTextSnapshot(current.text.data!) } : {})
        }
      },
      descriptionElement,
      descriptionDomain
    )
    assert.equal(requests.length, 2)
    assert.deepEqual(requests[0], {
      ...input,
      language: "ZH",
      expectedReadFingerprint: baseline.readFingerprint
    })
    assert.deepEqual(requests[1], { ...(requests[0] as object), includeApiSnapshot: true })
    assert.equal(result.status, patch.MSEHL === baseline.text.data!.MSEHL ? "no_changes" : "draft")
    assert.equal(result.apiPrecondition!.status, "match")
    assert.equal(result.apiPrecondition!.textVersion, "c".repeat(64))
    assert.equal(result.apiPrecondition!.lockedComparisonVerified, false)
    assert.equal(result.apiPrecondition!.snapshot, false)
    assert.equal(result.after!.MSEHL, patch.MSEHL)
    for (const field of ["MANDT", "SPRAS", "MSEHI", "MSEH3", "MSEH6", "MSEHT"])
      assert.equal(result.after![field], baseline.text.data![field])
    assert.equal(result.executable, false)
    assert.equal(result.saveAvailable, false)
    assert.ok(result.writeRefusalReasons.includes("LOCKED_VERSION_CHECK_NOT_VERIFIED"))
    assert.ok(!result.writeRefusalReasons.includes("FULL_ROW_VERSION_NOT_AVAILABLE"))
  }
  let legacyReads = 0
  const legacy = await previewConfigurationUnitText(
    base,
    "200",
    async (request) => {
      legacyReads++
      assert.ok(!("includeApiSnapshot" in request))
      return run(request)
    },
    descriptionElement,
    descriptionDomain
  )
  assert.equal(legacyReads, 1)
  assert.ok(!("apiPrecondition" in legacy))
  assert.ok(legacy.writeRefusalReasons.includes("FULL_ROW_VERSION_NOT_AVAILABLE"))
})

test("stale opaque text version retracts draft and nested native token even when display values match", async () => {
  const baseline = await run()
  const result = await previewConfigurationUnitText(
    {
      ...input,
      language: "ZH",
      expectedReadFingerprint: baseline.readFingerprint,
      expectedTextVersion: "b".repeat(64),
      patch: { MSEHL: "新标题" },
      includeMaintenanceBoundary: true
    },
    "200",
    async ({ includeApiSnapshot, ...request }) => {
      const current = await run(request)
      return {
        ...current,
        ...(includeApiSnapshot ? { apiSnapshot: nativeTextSnapshot(current.text.data!) } : {})
      }
    },
    descriptionElement,
    descriptionDomain,
    async () => maintenanceDescriptor()
  )
  assert.equal(result.status, "blocked")
  assert.equal(result.blockedReason, "TEXT_VERSION_CHANGED")
  assert.equal(result.apiPrecondition!.textVersion, null)
  assert.equal(result.before, null)
  assert.equal(result.after, null)
  assert.deepEqual(result.changes, [])
  assert.equal(result.manualHandoff, null)
  assert.equal(result.currentRead.apiSnapshot!.textVersion, null)
  assert.equal(result.currentRead.apiSnapshot!.data, null)
  assert.equal(result.evidence!.unitReaderInvocations, 3)
})

test("native preview rejects untrusted scope, keys, flags, incomplete rows and unavailable API observations", async () => {
  const baseline = await run(),
    request = {
      ...input,
      language: "ZH",
      expectedReadFingerprint: baseline.readFingerprint,
      expectedTextVersion: "c".repeat(64),
      patch: { MSEHL: "新标题" }
    }
  const good = nativeTextSnapshot(baseline.text.data!)
  for (const edit of [
    { versionScope: "SAP_GR3_300_full_T006A_row_v1" },
    { versionOrigin: "client_sha256" },
    { executable: true },
    { saveAvailable: true },
    { readOnly: false },
    { functionName: "UPDATE_T006A" },
    { textVersion: "invalid" },
    { data: { ...good.data, MANDT: "300" } },
    { data: { ...good.data, SPRAS: "E" } },
    { data: { ...good.data, MSEHI: "KG" } },
    { data: { ...good.data, MSEH3: "XXX" } },
    { data: { ...good.data, MSEHL: "other" } },
    { data: { ...good.data, MSEHT: "x".repeat(11) } },
    { data: { MANDT: "200", SPRAS: "1", MSEHI: "kg" } },
    { status: "changed", code: "API_OR_DDIC_CHANGED", data: null, textVersion: null },
    { status: "blocked", code: "API_NOT_ATTESTED", data: null, textVersion: null }
  ]) {
    const result = await previewConfigurationUnitText(
      request,
      "200",
      async ({ includeApiSnapshot, ...raw }) => ({
        ...(await run(raw)),
        ...(includeApiSnapshot
          ? { apiSnapshot: { ...good, ...edit } as ReturnType<typeof nativeTextSnapshot> }
          : {})
      }),
      descriptionElement,
      descriptionDomain
    )
    assert.equal(result.status, "blocked")
    assert.equal(result.before, null)
    assert.equal(result.after, null)
    assert.equal(result.apiPrecondition!.textVersion, null)
    assert.equal(result.currentRead.apiSnapshot!.textVersion, null)
    assert.equal(result.currentRead.apiSnapshot!.data, null)
    if (edit.code) assert.equal(result.blockedReason, edit.code)
  }
  const missing = await previewConfigurationUnitText(
    request,
    "200",
    async ({ includeApiSnapshot: _opt, ...raw }) => run(raw),
    descriptionElement,
    descriptionDomain
  )
  assert.equal(missing.blockedReason, "API_SNAPSHOT_UNVERIFIED")
  await assert.rejects(
    previewConfigurationUnitText(
      request,
      "200",
      async ({ includeApiSnapshot, ...raw }) => {
        if (includeApiSnapshot) throw Error("API connection failed")
        return run(raw)
      },
      descriptionElement,
      descriptionDomain
    ),
    /API connection failed/
  )
})

test("native version inputs fail before reads and final metadata or legacy drift cannot be rescued by a matching token", async () => {
  const baseline = await run(),
    request = {
      ...input,
      language: "ZH",
      expectedReadFingerprint: baseline.readFingerprint,
      expectedTextVersion: "c".repeat(64),
      patch: { MSEHL: "新标题" }
    }
  for (const bad of [
    { ...request, language: undefined },
    { ...request, expectedTextVersion: "C".repeat(64) },
    { ...request, expectedTextVersion: "" },
    { ...request, apiSnapshot: nativeTextSnapshot(baseline.text.data!) }
  ]) {
    assert.equal(configurationUnitTextPreviewSchema.safeParse(bad).success, false)
    const fail = async () => assert.fail("invalid request must not read")
    await assert.rejects(previewConfigurationUnitText(bad, "200", fail, fail, fail))
  }
  let finalRead = false
  await assert.rejects(
    previewConfigurationUnitText(
      request,
      "200",
      async ({ includeApiSnapshot, ...raw }) => {
        const current = await run(raw)
        finalRead = !!includeApiSnapshot
        return {
          ...current,
          ...(includeApiSnapshot ? { apiSnapshot: nativeTextSnapshot(current.text.data!) } : {})
        }
      },
      async (name) => ({
        ...(await descriptionElement(name)),
        ...(finalRead ? { fingerprint: "0".repeat(64) } : {})
      }),
      descriptionDomain
    ),
    /METADATA_UNVERIFIED/
  )
  const rows = dataset()
  const drift = await previewConfigurationUnitText(
    request,
    "200",
    async ({ includeApiSnapshot, ...raw }) => {
      if (includeApiSnapshot) rows.T006[0]!.ANDEC = "1"
      const current = await run(raw, rows)
      return {
        ...current,
        ...(includeApiSnapshot ? { apiSnapshot: nativeTextSnapshot(baseline.text.data!) } : {})
      }
    },
    descriptionElement,
    descriptionDomain
  )
  assert.equal(drift.status, "blocked")
  assert.equal(drift.currentRead.comparison, "changed")
  assert.equal(drift.apiPrecondition!.textVersion, null)
  assert.equal(drift.before, null)
})

test("native preview performs its final API read after CTS and preserves earlier rejection", async () => {
  const baseline = await run(),
    request = {
      ...input,
      language: "ZH",
      expectedReadFingerprint: baseline.readFingerprint,
      expectedTextVersion: "c".repeat(64),
      patch: { MSEHL: "新标题" },
      includeMaintenanceBoundary: true,
      transport: unitTransport
    }
  for (const stale of [false, true]) {
    const steps: string[] = []
    const result = await previewConfigurationUnitText(
      request,
      "200",
      async ({ includeApiSnapshot, ...raw }) => {
        steps.push(includeApiSnapshot ? "api" : "projection")
        assert.ok(!("transport" in raw))
        const current = await run(raw)
        return {
          ...current,
          ...(includeApiSnapshot ? { apiSnapshot: nativeTextSnapshot(current.text.data!) } : {})
        }
      },
      descriptionElement,
      descriptionDomain,
      async () => {
        steps.push("descriptor")
        return maintenanceDescriptor()
      },
      async () => {
        steps.push("cts")
        const receipt = unitCtsReceipt(baseline)
        if (stale) receipt.keyRecording.unitReadFingerprint = "f".repeat(64)
        return receipt
      }
    )
    assert.deepEqual(steps, ["projection", "descriptor", "projection", "cts", "api"])
    assert.equal(result.status, stale ? "blocked" : "draft")
    assert.equal(result.apiPrecondition!.textVersion, stale ? null : "c".repeat(64))
    if (stale) {
      assert.equal(result.blockedReason, "CTS_UNIT_VERSION_CHANGED")
      assert.equal(result.manualHandoff, null)
    }
  }
})

test("ToolService preview routes the optional version through the attested readonly native API", async () => {
  const backend = new MockBackend(),
    connection = backend.connectionDetails.bind(backend)
  backend.connectionDetails = (id) => ({ ...connection(id), client: "200", language: "ZH" })
  backend.runQuery = async (_id: string, sql: string, limit?: number) =>
    select(dataset(), sql, limit ?? 2)
  const service = new ToolService(backend)
  service.readDdicTransparentTable = async ({ objectName }) =>
    JSON.stringify(await table(objectName))
  service.readDdicDataElement = async ({ objectName }) =>
    JSON.stringify(await (objectName === "MSEHI" ? element() : descriptionElement(objectName)))
  service.readDdicDomain = async ({ objectName }) =>
    JSON.stringify(await (objectName === "MEINS" ? domain() : descriptionDomain(objectName)))
  let calls = 0,
    definitions = 0
  service.readFunctionModuleInterface = async ({ functionName }) => {
    assert.equal(functionName, configurationUnitReadApi.functionName)
    definitions++
    return JSON.stringify({
      connectionId: "w200",
      functionName,
      remoteEnabled: true,
      updateTask: false,
      updateTaskMode: "",
      importParameters: configurationUnitReadApi.importParameters,
      exportParameters: configurationUnitReadApi.exportParameters,
      changingParameters: [],
      tableParameters: [],
      exceptions: [],
      sourceFingerprint: "a".repeat(64),
      interfaceFingerprint: "b".repeat(64),
      source: [`FUNCTION ${functionName}.`, ...configurationUnitReadApi.source, "ENDFUNCTION."]
    })
  }
  backend.callRemoteFunction = async (_id, request) => {
    calls++
    assert.equal(request.functionName, configurationUnitReadApi.functionName)
    assert.deepEqual(request.inputParameters, { IV_UNIT_KEY: "kg", IV_LANGUAGE: "1" })
    return {
      outputs: {
        EV_CODE: "READ",
        EV_SYSTEM: "GR2",
        EV_CLIENT: "200",
        EV_TEXT_VERSION: "c".repeat(64),
        ES_TEXT: nativeTextSnapshot(dataset().T006A[0]!).data
      }
    }
  }
  const reference = JSON.parse(await service.readConfigurationUnit({ ...input, language: "ZH" }))
  const request = {
    ...input,
    language: "ZH",
    expectedReadFingerprint: reference.readFingerprint,
    expectedTextVersion: "c".repeat(64),
    patch: { MSEHL: "新标题" }
  }
  assert.equal(
    toolContracts.preview_configuration_unit_text.inputSchema.safeParse(request).success,
    true
  )
  const result = JSON.parse(await service.previewConfigurationUnitText(request))
  assert.equal(result.status, "draft")
  assert.equal(result.apiPrecondition.status, "match")
  assert.equal(result.saveAvailable, false)
  assert.equal(calls, 1)
  assert.equal(definitions, 2)
})
const unitCtsReceipt = (reference: Awaited<ReturnType<typeof run>>) => ({
  connectionId: "w200",
  client: "200",
  ...unitTransport,
  status: "metadata_matches",
  readOnly: true,
  saveAvailable: false,
  writeAdmission: "blocked",
  keyRecording: {
    status: "no_table_entries",
    code: null as string | null,
    officialEncoding: "not_verified",
    exactRowRecording: "not_verified",
    importStatus: "not_checked",
    target: { client: "200", unitKey: input.unitKey, language: "ZH", sapLanguage: "1" },
    unitReadFingerprint: reference.readFingerprint,
    readFingerprint: "a".repeat(64) as string | null,
    observed: { requestE071: [], requestE071K: [], taskE071: [], taskE071K: [] } as Record<
      string,
      Record<string, string>[]
    > | null
  }
})

test("unit text handoff combines CTS once and retracts incompatible versions or task admission", async () => {
  const reference = await run(),
    base = {
      ...input,
      language: "ZH",
      expectedReadFingerprint: reference.readFingerprint,
      patch: { MSEHL: "新标题" },
      includeMaintenanceBoundary: true,
      transport: unitTransport
    }
  for (const mode of [
    "empty",
    "populated",
    "master_mismatch",
    "blocked",
    "denied",
    "truncated",
    "header_changed",
    "unit_changed",
    "fingerprint_changed",
    "language_changed",
    "wrong_target",
    "invalid_success",
    "throw"
  ]) {
    let calls = 0,
      reads = 0
    const reply = unitCtsReceipt(reference)
    if (mode === "populated") {
      reply.keyRecording.status = "table_entries_observed"
      reply.keyRecording.observed!.taskE071K = [{ TABKEY: "*" }]
    }
    if (mode === "master_mismatch") reply.keyRecording.status = "master_mismatch"
    if (mode === "blocked") {
      reply.status = "rejected"
      reply.keyRecording.status = "blocked"
      reply.keyRecording.unitReadFingerprint = null
      reply.keyRecording.observed = null
      reply.keyRecording.readFingerprint = null
    }
    if (
      mode === "denied" ||
      mode === "truncated" ||
      mode === "header_changed" ||
      mode === "unit_changed"
    ) {
      reply.keyRecording.status =
        mode === "truncated" ? "truncated" : mode === "denied" ? "unavailable" : "changed"
      reply.keyRecording.code =
        mode === "unit_changed"
          ? "CONFIGURATION_CTS_UNIT_CHANGED"
          : "CONFIGURATION_CTS_KEYS_UNAVAILABLE"
      reply.keyRecording.unitReadFingerprint = null
      reply.keyRecording.observed = null
      reply.keyRecording.readFingerprint = null
      if (mode === "header_changed") reply.status = "changed"
    }
    if (mode === "fingerprint_changed") reply.keyRecording.unitReadFingerprint = "f".repeat(64)
    if (mode === "language_changed") reply.keyRecording.target.sapLanguage = "E"
    if (mode === "wrong_target") reply.keyRecording.target.unitKey = "KG"
    if (mode === "invalid_success") reply.keyRecording.observed = null
    const result = await previewConfigurationUnitText(
      base,
      "200",
      async (request) => {
        reads++
        assert.ok(!("transport" in request))
        return run(request)
      },
      descriptionElement,
      descriptionDomain,
      async () => maintenanceDescriptor(),
      async (request) => {
        calls++
        assert.deepEqual(request, {
          connectionId: "w200",
          ...unitTransport,
          unitText: { unitKey: input.unitKey, language: "ZH" }
        })
        if (mode === "throw") throw Error("HTTP 403")
        return reply
      }
    )
    assert.equal(calls, 1)
    assert.equal(reads, 2)
    assert.equal(result.cts!.complete, false)
    assert.equal(result.cts!.exactRowRecording, "not_verified")
    assert.equal(result.cts!.importStatus, "not_checked")
    assert.equal(result.saveAvailable, false)
    if (["unit_changed", "fingerprint_changed", "language_changed"].includes(mode)) {
      assert.equal(result.status, "blocked")
      assert.equal(result.before, null)
      assert.equal(result.after, null)
      assert.deepEqual(result.changes, [])
      assert.equal(result.cts!.inspection, null)
      assert.equal(result.manualHandoff, null)
    } else if (["empty", "populated", "master_mismatch"].includes(mode)) {
      assert.equal(result.cts!.status, "observed")
      assert.equal(result.manualHandoff!.status, "manual_only")
      assert.equal(result.manualHandoff!.ctsPolicy, "not_verified")
    } else {
      assert.equal(result.manualHandoff, null)
      assert.notEqual(result.cts!.status, "observed")
    }
  }
  const stale = await previewConfigurationUnitText(
    { ...base, expectedReadFingerprint: "0".repeat(64) },
    "200",
    run,
    descriptionElement,
    descriptionDomain,
    async () => maintenanceDescriptor(),
    async () => assert.fail("stale unit skips CTS")
  )
  assert.equal(stale.cts!.status, "not_performed")
  assert.equal(stale.cts!.evidence.transportReaderInvocations, 0)
  const same = await previewConfigurationUnitText(
    { ...base, patch: { MSEHL: reference.text.data!.MSEHL } },
    "200",
    run,
    descriptionElement,
    descriptionDomain,
    async () => maintenanceDescriptor(),
    async () => unitCtsReceipt(reference)
  )
  assert.equal(same.status, "no_changes")
  assert.equal(same.manualHandoff, null)
  assert.equal(same.cts!.status, "observed")
})

test("unit reconciliation service reuses inspector without forwarding recursive controls", async () => {
  const backend = new MockBackend(),
    connection = backend.connectionDetails.bind(backend)
  backend.connectionDetails = (id) => ({ ...connection(id), client: "200", language: "ZH" })
  backend.runQuery = async (_id: string, sql: string, limit?: number) =>
    select(dataset(), sql, limit ?? 2)
  const service = new ToolService(backend)
  service.readDdicTransparentTable = async ({ objectName }) =>
    JSON.stringify(await table(objectName))
  service.readDdicDataElement = async () => JSON.stringify(await element())
  service.readDdicDomain = async () => JSON.stringify(await domain())
  const reference = await run(),
    textReconciliation = {
      baselineReadFingerprint: reference.readFingerprint,
      baselineUnit: reference.unit.data,
      baselineText: reference.text.data,
      patch: { MSEHL: "新标题" }
    },
    base = { ...input, language: "ZH", textReconciliation, transport: unitTransport }
  let calls = 0
  service.inspectConfigurationTransport = async (raw) => {
    calls++
    assert.deepEqual(raw, {
      connectionId: "w200",
      ...unitTransport,
      unitText: { unitKey: input.unitKey, language: "ZH" }
    })
    // The real inspector does these nested reads. No transport/reconciliation controls can re-enter it.
    const nested = JSON.parse(await service.readConfigurationUnit({ ...input, language: "ZH" }))
    assert.equal(nested.textReconciliation, undefined)
    const reply = unitCtsReceipt(reference)
    if (calls === 2) reply.keyRecording.unitReadFingerprint = "f".repeat(64)
    return JSON.stringify(reply)
  }
  const first = JSON.parse(await service.readConfigurationUnit(base))
  assert.equal(calls, 1)
  assert.equal(first.textReconciliation.status, "unchanged")
  assert.equal(first.textReconciliation.cts.status, "observed")
  assert.equal(first.textReconciliation.complete, false)
  const changed = JSON.parse(await service.readConfigurationUnit(base))
  assert.equal(calls, 2)
  assert.equal(changed.textReconciliation.status, "changed_during_read")
  assert.equal(changed.textReconciliation.changes, null)
  assert.equal(changed.textReconciliation.cts.inspection, null)
  const legacy = JSON.parse(
    await service.readConfigurationUnit({ ...input, language: "ZH", textReconciliation })
  )
  assert.equal(calls, 2)
  assert.equal(legacy.textReconciliation.cts.status, "not_verified")
  for (const raw of [
    { ...input, transport: unitTransport },
    { ...base, language: undefined },
    { ...base, transport: { ...unitTransport, ctsVerified: true } },
    { ...base, transport: { ...unitTransport, taskNumber: unitTransport.requestNumber } }
  ])
    await assert.rejects(service.readConfigurationUnit(raw))
  for (const raw of [
    {
      ...input,
      expectedReadFingerprint: reference.readFingerprint,
      patch: { MSEHL: "新标题" },
      transport: unitTransport
    },
    {
      ...input,
      expectedReadFingerprint: reference.readFingerprint,
      patch: { MSEHL: "新标题" },
      includeMaintenanceBoundary: true,
      transport: unitTransport
    }
  ])
    await assert.rejects(service.previewConfigurationUnitText(raw))
  assert.equal(calls, 2)
})

const maintenanceDescriptor = () => ({
  connectionId: "w200",
  sessionClient: "200",
  objectName: "T006A",
  definitionFingerprint: configurationUnitLayouts.T006A,
  descriptorFingerprint: "a".repeat(64),
  status: "partial",
  readOnly: true,
  saveAvailable: false,
  maintenanceRoute: {
    status: "source_attested",
    executable: false,
    sourceFingerprint: "b".repeat(64),
    route: {
      activityId: "SIMG_CFMENUOLMSOMSC",
      transaction: "CUNI",
      program: "SAPMUNIT",
      kind: "dialog_module_pool"
    },
    textMaintenanceBoundary: {
      objectName: "T006A",
      keyFields: ["MANDT", "SPRAS", "MSEHI"],
      patchFields: ["MSEHT", "MSEHL"],
      executable: false,
      wholeRowVersionAvailable: false,
      headlessRouteProved: false,
      atomicRollbackProved: false
    }
  }
})

test("optional text handoff reuses the descriptor and rechecks current values without expanding patch fields", async () => {
  const reference = await run(),
    raw = {
      ...input,
      expectedReadFingerprint: reference.readFingerprint,
      patch: { MSEHL: "新标题" },
      includeMaintenanceBoundary: true
    }
  let unitReads = 0,
    descriptors = 0
  const r = await previewConfigurationUnitText(
    raw,
    "200",
    async (request) => {
      unitReads++
      assert.ok(!("includeMaintenanceBoundary" in request))
      return run(request)
    },
    descriptionElement,
    descriptionDomain,
    async () => {
      descriptors++
      return maintenanceDescriptor()
    }
  )
  assert.equal(unitReads, 2)
  assert.equal(descriptors, 1)
  assert.equal(r.status, "draft")
  assert.equal(r.manualHandoff!.status, "manual_only")
  assert.deepEqual(r.manualHandoff!.key, { MANDT: "200", SPRAS: "1", MSEHI: input.unitKey })
  assert.deepEqual(r.manualHandoff!.patch, { MSEHL: "新标题" })
  assert.equal(r.manualHandoff!.before.MSEHT, r.manualHandoff!.after.MSEHT)
  assert.equal(r.manualHandoff!.ctsPolicy, "not_verified")
  assert.equal(r.executable, false)
  assert.equal(r.manualHandoff!.executable, false)
  const legacy = await previewConfigurationUnitText(
    { ...raw, includeMaintenanceBoundary: false },
    "200",
    run,
    descriptionElement,
    descriptionDomain,
    async () => {
      throw Error("must not read")
    }
  )
  assert.equal(legacy.status, "draft")
  assert.equal(legacy.manualHandoff, undefined)
})

test("text handoff cannot survive failed/cross-scope source evidence or stale target confirmation", async () => {
  const reference = await run(),
    raw = {
      ...input,
      expectedReadFingerprint: reference.readFingerprint,
      patch: { MSEHL: "新标题" },
      includeMaintenanceBoundary: true
    }
  for (const patch of [
    { connectionId: "w300" },
    { sessionClient: "300" },
    { objectName: "T006" },
    { readOnly: false },
    { saveAvailable: true },
    { definitionFingerprint: "0".repeat(64) },
    { maintenanceRoute: { ...maintenanceDescriptor().maintenanceRoute, executable: true } },
    {
      maintenanceRoute: {
        ...maintenanceDescriptor().maintenanceRoute,
        textMaintenanceBoundary: null
      }
    }
  ]) {
    const r = await previewConfigurationUnitText(
      raw,
      "200",
      run,
      descriptionElement,
      descriptionDomain,
      async () => ({ ...maintenanceDescriptor(), ...patch })
    )
    assert.equal(r.maintenanceBoundary!.status, "unreviewed")
    assert.equal(r.manualHandoff, null)
  }
  const unavailable = await previewConfigurationUnitText(
    raw,
    "200",
    run,
    descriptionElement,
    descriptionDomain,
    async () => {
      throw Error("read failed")
    }
  )
  assert.equal(unavailable.maintenanceBoundary!.status, "unavailable")
  assert.equal(unavailable.manualHandoff, null)
  let calls = 0
  const changed = await previewConfigurationUnitText(
    raw,
    "200",
    async (request) => {
      calls++
      const rows = dataset()
      if (calls === 2) rows.T006A[0]!.MSEHL = "并发改值"
      return run(request, rows)
    },
    descriptionElement,
    descriptionDomain,
    async () => maintenanceDescriptor()
  )
  assert.equal(changed.status, "blocked")
  assert.equal(changed.blockedReason, "READ_VERSION_CHANGED")
  assert.equal(changed.after, null)
  assert.equal(changed.manualHandoff, null)
  await assert.rejects(
    previewConfigurationUnitText(
      { ...raw, includeMaintenanceBoundary: "true" },
      "200",
      run,
      descriptionElement,
      descriptionDomain
    )
  )
})

test("text draft preserves omitted fields and keys, normalizes padding and never grants execution", async () => {
  const reference = await run()
  const request = {
    ...input,
    expectedReadFingerprint: reference.readFingerprint,
    patch: { MSEHL: " 新长标题 " }
  }
  const result = await draft(request)
  assert.equal(result.status, "draft")
  assert.equal(result.after!.MSEHL, "新长标题")
  assert.equal(result.after!.MSEHT, result.before!.MSEHT)
  for (const key of ["MANDT", "SPRAS", "MSEHI", "MSEH3", "MSEH6"])
    assert.equal(result.after![key], result.before![key])
  assert.deepEqual(result.changes, [{ field: "MSEHL", before: "中文长标题", after: "新长标题" }])
  assert.equal(result.executable, false)
  assert.equal(result.saveAvailable, false)
  assert.equal(result.validation.businessRules, "unknown")
  assert.equal(result.validation.ctsPolicy, "unknown")
  const noChange = await draft({ ...request, patch: { MSEHT: undefined, MSEHL: "中文长标题" } })
  assert.equal(noChange.status, "no_changes")
  assert.equal(noChange.after!.MSEHT, "短标题")
  const clear = await draft({ ...request, patch: { MSEHT: "" } })
  assert.equal(clear.after!.MSEHT, "")
  assert.equal(clear.after!.MSEHL, "中文长标题")
})

test("text draft blocks stale, missing and unavailable values without inventing a translation row", async () => {
  const reference = await run()
  const request = {
    ...input,
    expectedReadFingerprint: reference.readFingerprint,
    patch: { MSEHL: "标题" }
  }
  const stale = await draft({ ...request, expectedReadFingerprint: "0".repeat(64) })
  assert.equal(stale.blockedReason, "READ_VERSION_CHANGED")
  assert.equal(stale.before, null)
  assert.equal(stale.after, null)
  assert.deepEqual(stale.changes, [])
  const rows = dataset()
  rows.T006A = []
  const absent = await run(input, rows)
  const missing = await draft({ ...request, expectedReadFingerprint: absent.readFingerprint }, rows)
  assert.equal(missing.blockedReason, "TEXT_NOT_FOUND")
  assert.equal(missing.after, null)
  const failedRead = await run(input, undefined, async () => {
    throw new Error("HTTP 403")
  })
  const failed = await previewConfigurationUnitText(
    request,
    "200",
    async () => failedRead,
    descriptionElement,
    descriptionDomain
  )
  assert.equal(failed.status, "blocked")
  assert.equal(failed.blockedReason, "UNIT_UNAVAILABLE")
})

test("text draft rejects invalid patch/version/scope before metadata or value reads", async () => {
  const request = { ...input, expectedReadFingerprint: "a".repeat(64), patch: { MSEHL: "test" } }
  for (const [raw, client] of [
    [{ ...request, expectedReadFingerprint: undefined }, "200"],
    [{ ...request, client: "100" }, "200"],
    [{ ...request, connectionId: "other" }, "200"],
    [request, "100"],
    [{ ...request, patch: {} }, "200"],
    [{ ...request, patch: { MSEHL: undefined } }, "200"],
    ...[
      { MSEH3: "ABC" },
      { MANDT: "100" },
      { ANDEC: "1" },
      { MSEHT: "x".repeat(11) },
      { MSEHL: "x".repeat(31) },
      { MSEHL: "a\n" },
      { MSEHL: 1 }
    ].map((patch) => [{ ...request, patch }, "200"])
  ] as const) {
    let calls = 0
    const read = async () => {
      calls++
      throw new Error("unexpected read")
    }
    await assert.rejects(previewConfigurationUnitText(raw, client as string, read, read, read))
    assert.equal(calls, 0)
  }
})

test("text draft refuses description domain drift and routes through existing unit reads", async () => {
  const reference = await run()
  const request = {
    ...input,
    expectedReadFingerprint: reference.readFingerprint,
    patch: { MSEHL: "标题" }
  }
  let checks = 0
  await assert.rejects(
    previewConfigurationUnitText(request, "200", run, descriptionElement, async (name) => ({
      ...(await descriptionDomain(name)),
      fingerprint:
        name === "TEXT10" && ++checks === 2
          ? "0".repeat(64)
          : (await descriptionDomain(name)).fingerprint
    })),
    /TEXT_METADATA_UNVERIFIED/
  )
  const service = new ToolService(new MockBackend())
  let reads = 0
  service.readConfigurationUnit = async (raw) => {
    reads++
    return JSON.stringify(await run(raw))
  }
  service.readDdicDataElement = async ({ objectName }) =>
    JSON.stringify(await descriptionElement(objectName))
  service.readDdicDomain = async ({ objectName }) =>
    JSON.stringify(await descriptionDomain(objectName))
  const result = JSON.parse(await service.previewConfigurationUnitText(request))
  assert.equal(reads, 1)
  assert.equal(result.status, "draft")
  assert.equal(toolContracts.preview_configuration_unit_text.annotations.readOnlyHint, true)
  for (const profile of ["config", "full", "readonly"] as const)
    assert.ok(toolNamesForProfile(profile).includes("preview_configuration_unit_text"))
  for (const profile of ["dev", "ops"] as const)
    assert.ok(!toolNamesForProfile(profile).includes("preview_configuration_unit_text"))
})
