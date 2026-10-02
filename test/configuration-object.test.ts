import assert from "node:assert/strict"
import test from "node:test"
import { describeConfigurationObject } from "../src/configuration-object.js"
import { toolNamesForProfile } from "../src/tool-registry.js"
import { toolContracts } from "../src/contracts.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"

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
