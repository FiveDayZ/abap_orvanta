import assert from "node:assert/strict"
import test from "node:test"
import {
  previewConfiguration as previewWithDomain,
  CONFIGURATION_MODE_DOMAIN,
  CONFIGURATION_MODE_FINGERPRINT,
  CONFIGURATION_TYPES,
  CONFIGURATION_DDIC,
  CONFIGURATION_TABLE
} from "../src/configuration-preview.js"
const domain = () => ({
  connectionId: "w200",
  objectKind: "domain",
  objectName: CONFIGURATION_MODE_DOMAIN,
  fingerprint: CONFIGURATION_MODE_FINGERPRINT,
  definition: {
    dataType: "CHAR",
    length: 1,
    decimals: 0,
    lowercase: false,
    conversionExit: "",
    valueTable: "",
    fixedValues: ["S", "E", ""].map((low) => ({ low, high: "" }))
  }
})
const previewWithTypes = (
  input: unknown,
  definition: () => Promise<unknown>,
  rows: (query: unknown) => Promise<unknown>,
  types: (query: unknown) => Promise<unknown>
) => previewWithDomain(input, definition, rows, types, async () => domain())
const typeResponse = (query: unknown) => {
  const value = query as { tableName: string; filters: Array<{ value: string }> }
  assert.equal(value.tableName, "DD04L")
  const item = CONFIGURATION_TYPES.find(([name]) => name === value.filters[0]!.value)!
  return {
    connectionId: "w200",
    tableName: "DD04L",
    status: "ok",
    readOnly: true,
    returnedCount: 1,
    truncated: false,
    data: [
      {
        ROLLNAME: item[0],
        DATATYPE: item[1],
        LENG: String(item[2]).padStart(6, "0"),
        DECIMALS: "000000",
        DOMNAME: item[3]
      }
    ]
  }
}
const previewConfiguration = (
  input: unknown,
  definition: () => Promise<unknown>,
  rows: (query: unknown) => Promise<unknown>
) => previewWithTypes(input, definition, rows, async (query) => typeResponse(query))
const definition = async () => ({
  objectName: CONFIGURATION_TABLE,
  fingerprint: CONFIGURATION_DDIC
})
const row = {
  MANDT: "200",
  WERKS: "TEST",
  ACTIVE: "",
  TPMODE: "",
  DATAB: "00000000",
  DATBI: "00000000",
  CFGVERS: "1",
  AENAM: "",
  AEDAT: "00000000",
  AEZET: "000000"
}
const input = { connectionId: "w200", plant: "TEST" }
const response = (data: unknown) => ({
  status: "ok",
  definitionFingerprint: CONFIGURATION_DDIC,
  truncated: false,
  data
})
test("configuration validates only actual domain values and normalizes a blank CHAR proposal", async () => {
  for (const value of ["S", "E", "", " "]) {
    const result = await previewConfiguration(
      { ...input, changes: { TPMODE: value } },
      definition,
      async () => response([row])
    )
    assert.ok("domainValueValidation" in result)
    assert.equal(result.domainValueValidation.status, "valid")
    assert.equal(result.domainValueValidation?.effectiveValue, value === " " ? "" : value)
    assert.deepEqual(result.domainMetadata.allowedValues, ["", "E", "S"])
    assert.equal(result.businessValidation, "not_verified")
    assert.equal(result.saveAvailable, false)
  }
})

test("configuration rejects unknown or lowercase mode proposals before business reads", async () => {
  for (const value of ["?", "s", "e", "X"]) {
    let reads = 0
    await assert.rejects(
      previewConfiguration({ ...input, changes: { TPMODE: value } }, definition, async () => {
        reads++
        return response([row])
      }),
      /DOMAIN_VALUE_INVALID/
    )
    assert.equal(reads, 0)
  }
})

test("configuration refuses domain drift, intervals, duplicates and missing fixed values", async () => {
  const good = domain()
  for (const candidate of [
    { ...good, fingerprint: "0".repeat(64) },
    { ...good, objectName: "OTHER" },
    { ...good, definition: { ...good.definition, conversionExit: "ALPHA" } },
    { ...good, definition: { ...good.definition, fixedValues: [] } },
    {
      ...good,
      definition: {
        ...good.definition,
        fixedValues: ["S", "S", ""].map((low) => ({ low, high: "" }))
      }
    },
    {
      ...good,
      definition: {
        ...good.definition,
        fixedValues: [
          { low: "E", high: "S" },
          { low: "S", high: "" },
          { low: "", high: "" }
        ]
      }
    }
  ]) {
    let reads = 0
    await assert.rejects(
      previewWithDomain(
        input,
        definition,
        async () => {
          reads++
          return response([row])
        },
        async (query) => typeResponse(query),
        async () => candidate
      ),
      /DOMAIN_UNAVAILABLE_OR_CHANGED/
    )
    assert.equal(reads, 0)
  }
})

test("configuration distinguishes an invalid current mode from a valid correction proposal", async () => {
  const badRow = { ...row, TPMODE: "?" }
  await assert.rejects(
    previewConfiguration(input, definition, async () => response([badRow])),
    /DOMAIN_VALUE_INVALID/
  )
  const result = await previewConfiguration(
    { ...input, changes: { TPMODE: "E" } },
    definition,
    async () => response([badRow])
  )
  assert.ok("domainValueValidation" in result)
  assert.equal(result.domainValueValidation.currentValueValid, false)
  assert.equal(result.domainValueValidation?.effectiveValue, "E")
  assert.deepEqual(result.differences, [{ field: "TPMODE", from: "?", to: "E" }])
  assert.equal(result.data?.TPMODE, "?")
})

test("configuration preserves domain read errors instead of reporting missing configuration", async () => {
  let reads = 0
  await assert.rejects(
    previewWithDomain(
      input,
      definition,
      async () => {
        reads++
        return response([row])
      },
      async (query) => typeResponse(query),
      async () => {
        throw new Error("HTTP 403")
      }
    ),
    /HTTP 403/
  )
  assert.equal(reads, 0)
})
test("configuration verifies ten bounded active type reads before reading business data", async () => {
  const seen: string[] = []
  const result = await previewWithTypes(
    input,
    definition,
    async () => {
      assert.equal(seen.length, 10)
      return response([row])
    },
    async (query) => {
      const q = query as { maxRows: number; filters: unknown[] }
      assert.equal(q.maxRows, 2)
      assert.deepEqual(q.filters[1], { column: "AS4LOCAL", operator: "EQ", value: "A" })
      const result = typeResponse(query)
      seen.push(result.data[0]!.ROLLNAME)
      return result
    }
  )
  assert.equal(new Set(seen).size, 10)
  assert.equal(result.typeMetadataValidation, "matched")
  assert.match(result.typeMetadataFingerprint, /^[a-f0-9]{64}$/)
})

test("configuration type drift blocks reads even when the table fingerprint is unchanged", async () => {
  for (const patch of [
    { DATATYPE: "NUMC" },
    { LENG: "000002" },
    { DECIMALS: "000001" },
    { DOMNAME: "OTHER" },
    { ROLLNAME: "OTHER" }
  ]) {
    let businessReads = 0
    await assert.rejects(
      previewWithTypes(
        input,
        definition,
        async () => {
          businessReads++
          return response([row])
        },
        async (query) => {
          const result = typeResponse(query)
          return { ...result, data: [{ ...result.data[0]!, ...patch }] }
        }
      ),
      /TYPE_METADATA_CHANGED/
    )
    assert.equal(businessReads, 0)
  }
})

test("configuration missing, duplicate, partial and forbidden type metadata fail closed", async () => {
  for (const patch of [
    { status: "unavailable" },
    { truncated: true },
    { data: [] },
    { returnedCount: 2 },
    { connectionId: "other" },
    { data: [{ ROLLNAME: "MANDT" }] }
  ]) {
    let businessReads = 0
    await assert.rejects(
      previewWithTypes(
        input,
        definition,
        async () => {
          businessReads++
          return response([row])
        },
        async (query) => ({ ...typeResponse(query), ...patch })
      ),
      /TYPE_METADATA_UNAVAILABLE/
    )
    assert.equal(businessReads, 0)
  }
})
test("configuration preview preserves omitted and audit fields without saving", async () => {
  const result = await previewConfiguration(
    { ...input, changes: { ACTIVE: "X" } },
    definition,
    async (query) => {
      assert.deepEqual((query as { filters: unknown }).filters, [
        { column: "MANDT", operator: "EQ", value: "200" },
        { column: "WERKS", operator: "EQ", value: "TEST" }
      ])
      return response([row])
    }
  )
  assert.equal(result.saveAvailable, false)
  assert.deepEqual(result.differences, [{ field: "ACTIVE", from: "", to: "X" }])
  assert.deepEqual(result.data, row)
})
test("configuration invalid proposals are rejected before reads", async () => {
  for (const changes of [
    { MANDT: "100" },
    { CFGVERS: "2" },
    { AENAM: "OTHER" },
    { TPMODE: "SHADOW" },
    { DATAB: "20260230" }
  ]) {
    await assert.rejects(
      previewConfiguration(
        { ...input, changes },
        async () => {
          throw new Error("unexpected read")
        },
        async () => response([row])
      ),
      (e) => !String(e).includes("unexpected read")
    )
  }
})
test("configuration distinguishes missing and unavailable and rejects partial rows", async () => {
  assert.equal(
    (await previewConfiguration(input, definition, async () => response([]))).status,
    "not_found"
  )
  assert.equal(
    (
      await previewConfiguration(input, definition, async () => ({
        status: "unavailable",
        truncated: null,
        data: null
      }))
    ).status,
    "unavailable"
  )
  for (const result of [
    response([row, row]),
    response([{ ...row, MANDT: "100" }]),
    { ...response([row]), truncated: true },
    { ...response([row]), definitionFingerprint: "changed" },
    response([{ MANDT: "200", WERKS: "TEST" }])
  ])
    await assert.rejects(previewConfiguration(input, definition, async () => result))
})
test("configuration stale fingerprint does not return a usable preview", async () => {
  const result = await previewConfiguration(
    { ...input, expectedRowFingerprint: "a".repeat(64) },
    definition,
    async () => response([row])
  )
  assert.equal(result.status, "changed")
  assert.equal(result.data, null)
  assert.equal(result.differences, null)
})
test("configuration refuses reversed effective dates and metadata drift", async () => {
  await assert.rejects(
    previewConfiguration(
      { ...input, changes: { DATAB: "20260911", DATBI: "20260910" } },
      definition,
      async () => response([row])
    ),
    /DATE_RANGE/
  )
  await assert.rejects(
    previewConfiguration(
      input,
      async () => ({ objectName: CONFIGURATION_TABLE, fingerprint: "changed" }),
      async () => {
        throw new Error("unexpected row read")
      }
    ),
    (e) => !String(e).includes("unexpected row read")
  )
})
