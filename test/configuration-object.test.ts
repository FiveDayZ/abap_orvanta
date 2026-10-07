import assert from "node:assert/strict"
import test from "node:test"
import {
  describeConfigurationObject,
  configurationUnitMaintenanceSources,
  configurationUnitTextMaintenanceIncludes,
  configurationUnitTextMaintenanceFunctions,
  configurationUnitApiMaintenanceFunctions
} from "../src/configuration-object.js"
import { readFile } from "node:fs/promises"
import { configurationImgReaders, findConfigurationActivities } from "../src/configuration-img.js"
import { toolNamesForProfile } from "../src/tool-registry.js"
import { toolContracts } from "../src/contracts.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"
import { configurationUnitLayouts } from "../src/configuration-unit.js"

// Synthetic metadata only; these values do not assert the target system's T001 definition.
const input = { connectionId: "w200", objectName: "T001" }
const hash = "a".repeat(64)
const field = (name: string, position: number, key: boolean, dataElement: string) => ({
  name,
  position,
  key,
  dataElement,
  description: name
})
const table = () => ({
  ...input,
  objectKind: "transparentTable",
  fingerprint: hash,
  version: "20261002000000",
  packageName: "TEST",
  definition: {
    tableClass: "TRANSP",
    description: "Synthetic fixture",
    deliveryClass: "C",
    dataBrowserMaintenance: "allowed",
    fields: [
      field("MANDT", 1, true, "MANDT"),
      field("BUKRS", 2, true, "TEST_CHAR"),
      field("BUTXT", 3, false, "TEST_CHAR")
    ]
  }
})
const metadata = () => ({
  connectionId: "w200",
  tableName: "DD03L",
  status: "ok",
  readOnly: true,
  truncated: false,
  returnedCount: 3,
  data: ["BUTXT", "MANDT", "BUKRS"].map((name) => ({
    TABNAME: "T001",
    AS4LOCAL: "A",
    FIELDNAME: name,
    DATATYPE: name === "MANDT" ? "CLNT" : "CHAR",
    LENG: name === "MANDT" ? "000003" : "000004",
    DECIMALS: "000000"
  }))
})
const element = (name: string) => ({
  connectionId: "w200",
  objectKind: "dataElement",
  objectName: name,
  version: "1",
  fingerprint: hash,
  definition: { domainName: name }
})
const domain = (name: string) => ({
  connectionId: "w200",
  objectKind: "domain",
  objectName: name,
  version: "1",
  fingerprint: hash,
  definition: {
    dataType: name === "MANDT" ? "CLNT" : "CHAR",
    length: name === "MANDT" ? 3 : 4,
    decimals: 0,
    lowercase: false,
    conversionExit: "",
    valueTable: "",
    fixedValues: [{ low: "", high: "", description: "Initial" }]
  }
})
const describe = (
  raw: unknown = input,
  definition: (name: string) => Promise<unknown> = async () => table(),
  types: (query: unknown) => Promise<unknown> = async () => metadata(),
  elements: (name: string) => Promise<unknown> = async (name) => element(name),
  domains: (name: string) => Promise<unknown> = async (name) => domain(name)
) => describeConfigurationObject(raw, "200", definition, types, elements, domains)

async function maintenanceFixture(objectName: "T006" | "T006A" = "T006") {
  const proof = JSON.parse(
    await readFile(
      new URL(
        "../../docs/workspace-evidence/.doc/orvanta-configuration-maintenance-discovery-20261003-r15.json",
        import.meta.url
      ),
      "utf8"
    )
  )
  const img: Awaited<ReturnType<typeof findConfigurationActivities>> = JSON.parse(
    proof.calls.find(
      (c: { name: string; args: { objectName?: string } }) =>
        c.name === "find_configuration_activities" && c.args.objectName === objectName
    ).response
  )
  const raw = { ...input, objectName, includeImg: true, includeMaintenanceBoundary: true }
  const source = async (name: string) => ({
    connectionId: "w200",
    objectName: name,
    ...(configurationUnitMaintenanceSources[
      name as keyof typeof configurationUnitMaintenanceSources
    ] ??
      configurationUnitTextMaintenanceIncludes[
        name as keyof typeof configurationUnitTextMaintenanceIncludes
      ])
  })
  const run = (
    options: unknown = raw,
    readSource: (name: string) => Promise<unknown> = source,
    readImg = async () => img,
    readFunction?: (name: string) => Promise<unknown>
  ) =>
    describeConfigurationObject(
      options,
      "200",
      async () => ({ ...table(), objectName, fingerprint: configurationUnitLayouts[objectName] }),
      async () => ({
        ...metadata(),
        data: metadata().data.map((v) => ({ ...v, TABNAME: objectName }))
      }),
      async (name) => element(name),
      async (name) => domain(name),
      readImg,
      readSource,
      readFunction
    )
  return { raw, img, source, run }
}

const textFunction = async (functionName: string) => {
  const pin =
    configurationUnitTextMaintenanceFunctions[
      functionName as keyof typeof configurationUnitTextMaintenanceFunctions
    ] ??
    configurationUnitApiMaintenanceFunctions[
      functionName as keyof typeof configurationUnitApiMaintenanceFunctions
    ]
  return {
    connectionId: "w200",
    functionName,
    ...pin,
    source: Array(pin.lineCount).fill("synthetic source")
  }
}

test("API-only boundary binds CTS/lock candidates without treating them as an executable maintenance route", async () => {
  const f = await maintenanceFixture("T006A"),
    calls: string[] = [],
    raw = { ...f.raw, includeTextMaintenanceBoundary: true, includeApiMaintenanceBoundary: true }
  const r = await f.run(
    raw,
    f.source,
    async () => f.img,
    async (name) => {
      calls.push(name)
      return textFunction(name)
    }
  )
  const b = r.maintenanceRoute
  assert.ok("route" in b)
  assert.equal(b.status, "source_attested")
  assert.equal(b.evidence.functionReaderInvocations, 22)
  assert.equal(b.evidence.functionReaderInvocationLimit, 22)
  assert.equal(b.evidence.sourceReaderInvocations, 12)
  assert.deepEqual(calls.slice(0, 11), calls.slice(11))
  assert.equal(b.apiMaintenanceBoundary!.executionMode, "api_only")
  assert.equal(b.apiMaintenanceBoundary!.functions.length, 5)
  assert.equal(b.apiMaintenanceBoundary!.status, "customer_adapter_required")
  assert.equal(b.apiMaintenanceBoundary!.guiAutomationAllowed, false)
  assert.equal(b.apiMaintenanceBoundary!.directSqlAllowed, false)
  assert.equal(b.apiMaintenanceBoundary!.atomicRollbackProved, false)
  assert.equal(b.apiMaintenanceBoundary!.runtimeExecuted, false)
  assert.equal(r.saveAvailable, false)
  assert.equal(r.capabilities.apply, false)
  const base = await f.run(
    { ...raw, includeApiMaintenanceBoundary: false },
    f.source,
    async () => f.img,
    textFunction
  )
  assert.ok("sourceFingerprint" in base.maintenanceRoute)
  assert.notEqual(b.sourceFingerprint, base.maintenanceRoute.sourceFingerprint)
  assert.notEqual(r.descriptorFingerprint, base.descriptorFingerprint)
  assert.equal(base.maintenanceRoute.evidence.functionReaderInvocations, 12)
  assert.equal(base.maintenanceRoute.apiMaintenanceBoundary, undefined)
})

test("every API candidate drift or read failure retracts the entire maintenance binding", async () => {
  const f = await maintenanceFixture("T006A"),
    raw = { ...f.raw, includeTextMaintenanceBoundary: true, includeApiMaintenanceBoundary: true }
  for (const candidate of Object.keys(configurationUnitApiMaintenanceFunctions)) {
    for (const mode of ["unreviewed", "changed", "unavailable"] as const) {
      let reads = 0
      const r = await f.run(
        raw,
        f.source,
        async () => f.img,
        async (name) => {
          const value = await textFunction(name)
          if (name !== candidate) return value
          reads++
          if (mode === "unavailable" && reads === 2) throw Error("read failed")
          return {
            ...value,
            ...(mode === "unreviewed" || reads === 2 ? { sourceFingerprint: "0".repeat(64) } : {})
          }
        }
      )
      const b = r.maintenanceRoute
      assert.ok("route" in b)
      assert.equal(b.status, mode)
      assert.equal(b.failedFunction, candidate)
      assert.equal(b.apiMaintenanceBoundary, null)
      assert.equal(b.textMaintenanceBoundary, null)
      assert.equal(b.sources, null)
      assert.equal(b.sourceFingerprint, null)
      assert.equal(b.route, null)
      assert.ok(b.evidence.functionReaderInvocations! <= 22)
    }
  }
})

test("API boundary rejects missing text boundary and unsupported scope before any SAP read", async () => {
  const never = async () => assert.fail("invalid API options must not read SAP")
  for (const raw of [
    { ...input, includeApiMaintenanceBoundary: true },
    {
      ...input,
      objectName: "T006",
      includeImg: true,
      includeMaintenanceBoundary: true,
      includeTextMaintenanceBoundary: true,
      includeApiMaintenanceBoundary: true
    },
    {
      ...input,
      objectName: "T006A",
      connectionId: "w300",
      includeImg: true,
      includeMaintenanceBoundary: true,
      includeTextMaintenanceBoundary: true,
      includeApiMaintenanceBoundary: true
    },
    { ...input, objectName: "T006A", includeImg: true, includeApiMaintenanceBoundary: "true" }
  ])
    await assert.rejects(describeConfigurationObject(raw, "200", never, never, never, never))
})

test("text maintenance binds translation screens, full-row update modes and dialog CTS without authorizing calls", async () => {
  const f = await maintenanceFixture("T006A"),
    calls: string[] = []
  const r = await f.run(
    { ...f.raw, includeTextMaintenanceBoundary: true },
    f.source,
    async () => f.img,
    async (name) => {
      calls.push(name)
      return textFunction(name)
    }
  )
  const b = r.maintenanceRoute
  assert.ok("route" in b)
  assert.equal(b.status, "source_attested")
  assert.equal(b.sources!.length, 6)
  assert.equal(b.evidence.sourceReaderInvocations, 12)
  assert.equal(b.evidence.functionReaderInvocations, 12)
  assert.deepEqual(calls.slice(0, 6), calls.slice(6))
  assert.equal(
    b.textMaintenanceBoundary!.functions.find((v) => v.functionName === "UPDATE_T006A")!.updateTask,
    true
  )
  assert.equal(
    b.textMaintenanceBoundary!.functions.find((v) => v.functionName === "INSERT_T006A")!
      .updateTaskMode,
    "1"
  )
  assert.equal(b.textMaintenanceBoundary!.translation.screen, "1000")
  assert.equal(b.textMaintenanceBoundary!.persistence.input, "full_T006A_rows")
  assert.equal(b.textMaintenanceBoundary!.cts.withDialog, "X")
  assert.equal(b.executable, false)
  assert.equal(r.saveAvailable, false)
})

test("text maintenance withholds all binding facts for wrong function mode/source or failed confirmations", async () => {
  const f = await maintenanceFixture("T006A"),
    raw = { ...f.raw, includeTextMaintenanceBoundary: true }
  for (const patch of [
    { connectionId: "w300" },
    { functionName: "OTHER" },
    { remoteEnabled: true },
    { sourceFingerprint: "0".repeat(64) },
    { interfaceFingerprint: "0".repeat(64) },
    { source: [] },
    { updateTaskMode: "X" },
    { updateTask: true }
  ]) {
    const r = await f.run(
      raw,
      f.source,
      async () => f.img,
      async (name) => ({ ...(await textFunction(name)), ...patch })
    )
    const b = r.maintenanceRoute
    assert.ok("route" in b)
    assert.equal(b.status, "unreviewed")
    assert.equal(b.sources, null)
    assert.equal(b.route, null)
    assert.equal(b.textMaintenanceBoundary, null)
    assert.equal(b.sourceFingerprint, null)
  }
  for (const mode of ["changed", "unavailable"]) {
    let reads = 0
    const r = await f.run(
      raw,
      f.source,
      async () => f.img,
      async (name) => {
        reads++
        if (reads === 7 && mode === "unavailable") throw Error("unavailable")
        return {
          ...(await textFunction(name)),
          ...(reads === 7 ? { sourceFingerprint: "0".repeat(64) } : {})
        }
      }
    )
    const b = r.maintenanceRoute
    assert.ok("route" in b)
    assert.equal(b.status, mode)
    assert.equal(b.textMaintenanceBoundary, null)
  }
  const noReader = await f.run(raw)
  assert.equal(noReader.maintenanceRoute.status, "unavailable")
  await assert.rejects(
    f.run({ ...raw, includeMaintenanceBoundary: false }),
    /TEXT_MAINTENANCE_SCOPE_UNSUPPORTED/
  )
  await assert.rejects(
    (await maintenanceFixture()).run({ ...raw, objectName: "T006" }),
    /TEXT_MAINTENANCE_SCOPE_UNSUPPORTED/
  )
})

test("unit SAVE audit binds only the observed transaction mapping and rechecked dialog sources", async () => {
  const f = await maintenanceFixture(),
    names: string[] = []
  let imgReads = 0
  const r = await f.run(
    f.raw,
    async (name) => {
      names.push(name)
      return f.source(name)
    },
    async () => {
      imgReads++
      return f.img
    }
  )
  const b = r.maintenanceRoute
  assert.ok("route" in b)
  assert.equal(b.status, "source_attested")
  assert.equal(b.route!.transaction, "CUNI")
  assert.equal(b.route!.program, "SAPMUNIT")
  assert.equal(b.route!.kind, "dialog_module_pool")
  assert.equal(b.sources!.length, 5)
  assert.equal(names.length, 10)
  assert.deepEqual(names.slice(0, 5), names.slice(5))
  assert.equal(imgReads, 2)
  assert.equal(b.evidence.mappingRechecked, true)
  assert.equal(b.executable, false)
  assert.equal(b.coverage.bcSetRouteBound, false)
  assert.equal(b.coverage.atomicRollbackProved, false)
  assert.equal(r.capabilities.apply, false)
  assert.equal(r.saveAvailable, false)
  let reads = 0
  const legacy = await f.run({ ...f.raw, includeMaintenanceBoundary: false }, async (name) => {
    reads++
    return f.source(name)
  })
  assert.equal(reads, 0)
  assert.equal(legacy.maintenanceRoute.status, "unknown")
})

test("unit SAVE evidence fails closed on source identity, truncation, drift, failures and mapping changes", async () => {
  const f = await maintenanceFixture()
  for (const patch of [
    { connectionId: "w300" },
    { objectName: "OTHER" },
    { sourceUri: "/other" },
    { sourceFingerprint: "0".repeat(64) },
    { lineCount: 1 }
  ]) {
    const r = await f.run(f.raw, async (name) => ({ ...(await f.source(name)), ...patch }))
    const b = r.maintenanceRoute
    assert.ok("route" in b)
    assert.equal(b.status, "unreviewed")
    assert.equal(b.route, null)
    assert.equal(b.observations, null)
    assert.equal(b.sourceFingerprint, null)
    assert.equal(b.evidence.sourceReaderInvocations, 1)
  }
  for (const mode of ["changed", "unavailable"]) {
    let reads = 0
    const r = await f.run(f.raw, async (name) => {
      reads++
      if (reads === 6 && mode === "unavailable") throw Error("unavailable")
      return {
        ...(await f.source(name)),
        ...(reads === 6 ? { sourceFingerprint: "0".repeat(64) } : {})
      }
    })
    const b = r.maintenanceRoute
    assert.ok("route" in b)
    assert.equal(b.status, mode)
    assert.equal(b.sources, null)
    assert.equal(b.mappingFingerprint, null)
    assert.equal(b.evidence.sourcesRechecked, false)
  }
  let calls = 0
  const drift = await f.run(f.raw, f.source, async () => {
    calls++
    return { ...f.img, ...(calls === 2 ? { definitionFingerprint: "b".repeat(64) } : {}) }
  })
  assert.equal(drift.maintenanceRoute.status, "changed")
  for (const img of [
    { ...f.img, truncated: true },
    { ...f.img, maintenanceObjects: [] },
    {
      ...f.img,
      lookups: f.img.lookups.map((v) => ({ ...v, transaction: { TCODE: "CUNI", PGMNA: "OTHER" } }))
    }
  ]) {
    let reads = 0
    const r = await f.run(
      f.raw,
      async (name) => {
        reads++
        return f.source(name)
      },
      async () => img
    )
    assert.equal(r.maintenanceRoute.status, "mapping_unresolved")
    assert.equal(reads, 0)
  }
})

test("unit SAVE audit rejects unscoped or hidden execution inputs before reading SAP", async () => {
  const never = async () => assert.fail("invalid scope must not read SAP")
  for (const raw of [
    { ...input, includeMaintenanceBoundary: true },
    {
      connectionId: "w300",
      objectName: "T006",
      includeImg: true,
      includeMaintenanceBoundary: true
    },
    { ...input, includeImg: true, includeMaintenanceBoundary: true },
    { ...input, includeMaintenanceBoundary: "true" },
    { ...input, execute: true }
  ])
    await assert.rejects(describeConfigurationObject(raw, "200", never, never, never, never))
})

test("unit value route requires the reviewed layout, exact keys and client", async () => {
  const names = ["MANDT", "SPRAS", "MSEHI", "MSEH3", "MSEH6", "MSEHT", "MSEHL"]
  const lengths = [3, 1, 3, 3, 6, 10, 30]
  const definition = async () => ({
    ...table(),
    objectName: "T006A",
    fingerprint: configurationUnitLayouts.T006A,
    definition: {
      ...table().definition,
      fields: names.map((name, i) => field(name, i + 1, i < 3, ""))
    }
  })
  const types = async () => ({
    ...metadata(),
    returnedCount: names.length,
    data: names.map((name, i) => ({
      TABNAME: "T006A",
      AS4LOCAL: "A",
      FIELDNAME: name,
      DATATYPE: ["CLNT", "LANG", "UNIT"][i] ?? "CHAR",
      LENG: String(lengths[i]),
      DECIMALS: "0"
    }))
  })
  for (const [client, fingerprint, keyChange, expected] of [
    ["200", configurationUnitLayouts.T006A, false, true],
    ["100", configurationUnitLayouts.T006A, false, false],
    ["200", hash, false, false],
    ["200", configurationUnitLayouts.T006A, true, false]
  ] as const) {
    const result = await describeConfigurationObject(
      { connectionId: "w200", objectName: "T006A" },
      client,
      async () => {
        const value = await definition()
        return {
          ...value,
          fingerprint,
          definition: {
            ...value.definition,
            fields: value.definition.fields.map((f) => ({
              ...f,
              key: keyChange && f.name === "MSEHI" ? false : f.key
            }))
          }
        }
      },
      types,
      async (name) => element(name),
      async (name) => domain(name)
    )
    assert.equal(result.capabilities.readValues, expected)
    assert.equal(result.capabilities.apply, false)
    assert.equal(result.saveAvailable, false)
    if (expected) {
      assert.equal(result.valueRead.tool, "read_configuration_unit")
      assert.equal(result.valueRead.textDraft?.tool, "preview_configuration_unit_text")
      assert.equal(result.valueRead.textDraft?.executable, false)
    }
  }
})

test("descriptor IMG attachment is opt-in, scoped, fingerprinted and cannot grant maintenance", async () => {
  const unit = { ...input, objectName: "T006" }
  const unitTable = async () => ({ ...table(), ...unit })
  const unitMetadata = async () => ({
    ...metadata(),
    data: metadata().data.map((v) => ({ ...v, TABNAME: "T006" }))
  })
  const img = await findConfigurationActivities(
    unit,
    {
      callRemoteFunction: async () => ({ outputs: { ACTIVITIES_FOUND: [] } })
    },
    async (name) => ({
      ...configurationImgReaders.find((v) => v.functionName === name),
      connectionId: "w200",
      updateTask: false
    }),
    async (name) =>
      name === "CUS_IMGACH"
        ? {
            ...(await unitTable()),
            objectName: name,
            fingerprint: "66dc39d4bb427dcd68ec903287450f811dcd71eee8933a11e322e14783b6af6a"
          }
        : await unitTable()
  )
  let calls = 0
  const attach = async () => {
    calls++
    return img
  }
  const base = await describeConfigurationObject(
    unit,
    "200",
    unitTable,
    unitMetadata,
    async (name) => element(name),
    async (name) => domain(name),
    attach
  )
  assert.equal(calls, 0)
  const linked = await describeConfigurationObject(
    { ...unit, includeImg: true },
    "200",
    unitTable,
    unitMetadata,
    async (name) => element(name),
    async (name) => domain(name),
    attach
  )
  assert.equal(calls, 1)
  assert.equal(linked.img, img)
  assert.notEqual(linked.descriptorFingerprint, base.descriptorFingerprint)
  assert.equal(linked.saveAvailable, false)
  assert.equal(linked.capabilities.apply, false)
  assert.ok(linked.evidence.missing.includes("complete_img_paths"))
  await assert.rejects(
    describeConfigurationObject(
      { ...unit, includeImg: true },
      "200",
      unitTable,
      unitMetadata,
      async (name) => element(name),
      async (name) => domain(name),
      async () => ({ ...img, definitionFingerprint: "b".repeat(64) })
    ),
    /IMG_EVIDENCE_MISMATCH/
  )
  const never = async () => assert.fail("invalid options must not read SAP")
  for (const raw of [
    { ...input, includeImg: true },
    { ...unit, language: "EN" }
  ])
    await assert.rejects(
      describeConfigurationObject(raw, "200", never, never, never, never),
      /IMG_(SCOPE_UNSUPPORTED|OPTIONS_INVALID)/
    )
})

test("configuration descriptor uses observed keys/types, deduplicates domain reads and never grants writes", async () => {
  const seen: string[] = []
  const result = await describe(
    input,
    async () => table(),
    async (raw) => {
      const query = raw as { tableName: string; filters: unknown[]; maxRows: number }
      assert.equal(query.tableName, "DD03L")
      assert.equal(query.maxRows, 65)
      assert.deepEqual(query.filters, [
        { column: "TABNAME", operator: "EQ", value: "T001" },
        { column: "AS4LOCAL", operator: "EQ", value: "A" }
      ])
      return metadata()
    },
    async (name) => element(name),
    async (name) => {
      seen.push(name)
      return domain(name)
    }
  )
  assert.deepEqual(seen, ["MANDT", "TEST_CHAR"])
  assert.deepEqual(result.primaryKey, ["MANDT", "BUKRS"])
  assert.deepEqual(result.businessKey, ["BUKRS"])
  assert.equal(result.clientDependency, "dependent")
  assert.equal(result.clientField, "MANDT")
  assert.equal(result.fields[1]!.dataType, "CHAR")
  assert.equal(result.fields[1]!.length, 4)
  assert.equal(result.fields[1]!.domainName, "TEST_CHAR")
  assert.equal(result.img.status, "unknown")
  assert.equal(result.transportPolicy.status, "unknown")
  assert.equal(result.status, "partial")
  assert.equal(result.saveAvailable, false)
  assert.equal(result.capabilities.apply, false)
  assert.equal(result.evidence.snapshot, false)
  assert.match(result.descriptorFingerprint, /^[a-f0-9]{64}$/)
})

test("configuration descriptor rejects forbidden, unapproved and non-customizing objects before SAP reads", async () => {
  let reads = 0
  const unexpectedRead = async () => {
    reads++
    throw new Error("unexpected SAP read")
  }
  for (const objectName of ["USR02", "NRIV", "DD03L", "ZTPMC_TPCFG"])
    await assert.rejects(
      describe({ ...input, objectName }, unexpectedRead),
      /TABLE_NOT_ALLOWED|CONFIGURATION_OBJECT_SCOPE_UNSUPPORTED/
    )
  await assert.rejects(describe({ ...input, transportNumber: "TEST" }, unexpectedRead))
  assert.equal(reads, 0)
})

test("configuration descriptor rejects stale versions and definition drift instead of returning a usable descriptor", async () => {
  await assert.rejects(
    describe({ ...input, expectedDefinitionFingerprint: "b".repeat(64) }),
    /DEFINITION_CHANGED/
  )
  let reads = 0
  await assert.rejects(
    describe(input, async () => ({
      ...table(),
      fingerprint: ++reads === 1 ? hash : "b".repeat(64)
    })),
    /DEFINITION_CHANGED/
  )
  await assert.rejects(
    describe(input, async () => ({ ...table(), active: false, status: "inactive" })),
    /INACTIVE/
  )
})

test("configuration descriptor refuses unavailable, truncated, duplicate or cross-object metadata", async () => {
  for (const patch of [
    { status: "unavailable", code: "TABLE_QUERY_NOT_AUTHORIZED" },
    { truncated: true },
    { connectionId: "other" },
    { returnedCount: 2 },
    { data: [] },
    { data: [metadata().data[0], metadata().data[0], metadata().data[2]] },
    { data: metadata().data.map((f) => ({ ...f, TABNAME: "T001W" })) }
  ])
    await assert.rejects(
      describe(
        input,
        async () => table(),
        async () => ({ ...metadata(), ...patch })
      )
    )
  await assert.rejects(
    describe(input, async () => {
      throw new Error("HTTP 403")
    }),
    /HTTP 403/
  )
  await assert.rejects(
    describe(
      input,
      async () => table(),
      async () => {
        throw new Error("HTTP 403")
      }
    ),
    /HTTP 403/
  )
})

test("configuration descriptor reports absent and unsupported layouts before metadata reads", async () => {
  const unexpectedRead = async () => {
    throw new Error("unexpected metadata read")
  }
  await assert.rejects(
    describe(input, async () => ({ status: "not-found", exists: false }), unexpectedRead),
    /CONFIGURATION_OBJECT_NOT_FOUND/
  )
  for (const fields of [
    Array.from({ length: 65 }, (_, i) => field(`FIELD${i}`, i + 1, i === 0, "")),
    [field(".INCLUDE", 1, true, "")]
  ])
    await assert.rejects(
      describe(
        input,
        async () => ({ ...table(), definition: { ...table().definition, fields } }),
        unexpectedRead
      ),
      /LAYOUT_UNSUPPORTED/
    )
  await assert.rejects(
    describe(
      input,
      async () => table(),
      async () => ({
        status: "unavailable",
        code: "TABLE_QUERY_NOT_AUTHORIZED"
      })
    ),
    /TABLE_QUERY_NOT_AUTHORIZED/
  )
})

test("configuration descriptor detects domain identity/type drift and preserves read errors", async () => {
  for (const patch of [{ objectName: "OTHER" }, { connectionId: "other" }, { active: false }])
    await assert.rejects(
      describe(
        input,
        async () => table(),
        async () => metadata(),
        async (name) => element(name),
        async (name) => ({ ...domain(name), ...patch })
      )
    )
  await assert.rejects(
    describe(
      input,
      async () => table(),
      async () => metadata(),
      async (name) => element(name),
      async (name) => ({ ...domain(name), definition: { ...domain(name).definition, length: 9 } })
    ),
    /TYPE_MISMATCH/
  )
  await assert.rejects(
    describe(
      input,
      async () => table(),
      async () => metadata(),
      async () => {
        throw new Error("HTTP 403")
      }
    ),
    /HTTP 403/
  )
})

test("configuration descriptor derives client independence from types and does not invent validity rules", async () => {
  const result = await describe(
    input,
    async () => ({
      ...table(),
      definition: {
        ...table().definition,
        fields: [field("SPRAS", 1, true, ""), field("DATAB", 2, true, "")]
      }
    }),
    async () => ({
      ...metadata(),
      returnedCount: 2,
      data: [
        {
          TABNAME: "T001",
          AS4LOCAL: "A",
          FIELDNAME: "SPRAS",
          DATATYPE: "LANG",
          LENG: "1",
          DECIMALS: "0"
        },
        {
          TABNAME: "T001",
          AS4LOCAL: "A",
          FIELDNAME: "DATAB",
          DATATYPE: "DATS",
          LENG: "8",
          DECIMALS: "0"
        }
      ]
    })
  )
  assert.equal(result.clientDependency, "independent")
  assert.deepEqual(result.languageKeyFields, ["SPRAS"])
  assert.deepEqual(result.businessKey, ["SPRAS", "DATAB"])
  assert.equal(result.timeDependency.status, "unknown")
  assert.deepEqual(result.timeDependency.dateFields, ["DATAB"])
  assert.equal(result.fields[0]!.domainMetadataStatus, "unknown")
})

test("configuration tool is routed through the existing readers and limited to config/full/readonly profiles", async () => {
  const service = new ToolService(new MockBackend())
  const seen: string[] = []
  service.readDdicTransparentTable = async () => {
    seen.push("table")
    return JSON.stringify(table())
  }
  service.readAbapTable = async () => {
    seen.push("metadata")
    return JSON.stringify(metadata())
  }
  service.readDdicDataElement = async ({ objectName }) => JSON.stringify(element(objectName))
  service.readDdicDomain = async ({ objectName }) => JSON.stringify(domain(objectName))
  const result = JSON.parse(await service.describeConfigurationObject(input))
  assert.deepEqual(seen, ["table", "metadata", "table"])
  assert.equal(result.sessionClient, "200")
  for (const profile of ["config", "full", "readonly"] as const)
    assert.ok(toolNamesForProfile(profile).includes("describe_configuration_object"))
  for (const profile of ["dev", "ops"] as const)
    assert.ok(!toolNamesForProfile(profile).includes("describe_configuration_object"))
  assert.equal(toolContracts.describe_configuration_object.annotations.readOnlyHint, true)
})
