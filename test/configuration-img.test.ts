import assert from "node:assert/strict"
import test from "node:test"
import type { RemoteFunctionRequest, RemoteFunctionResult } from "../src/backend.js"
import {
  configurationImgReaders,
  findConfigurationActivities,
  resolveConfigurationMaintenanceObjects,
  readConfigurationTransactionActivities
} from "../src/configuration-img.js"
import { NATIVE_PREVIEW_EMPTY_HTML } from "../src/reviewed-table-reader.js"
import { ToolService } from "../src/tools.js"
import { toolContracts } from "../src/contracts.js"
import { toolNamesForProfile } from "../src/tool-registry.js"
import { MockBackend } from "./mock-backend.js"

const input = { connectionId: "w200", objectName: "T005" }
const hash = "a".repeat(64)
const table = (objectName: string) => ({
  connectionId: "w200",
  objectName,
  objectKind: "transparentTable",
  version: "1",
  fingerprint:
    objectName === "CUS_IMGACH"
      ? "66dc39d4bb427dcd68ec903287450f811dcd71eee8933a11e322e14783b6af6a"
      : hash,
  definition: { tableClass: "TRANSP" }
})
const reader = async (functionName: string) => ({
  ...configurationImgReaders.find((p) => p.functionName === functionName)!,
  connectionId: "w200",
  updateTask: false
})
// Synthetic activity identifiers; they are not candidate activities from SAP.
const row = (ACTIVITY: string) => ({
  ACTIVITY,
  DOCU_ID: "DOC",
  ATTRIBUTES: "ATTR",
  C_ACTIVITY: "CUSTOM",
  TCODE: "TEST",
  FUSER: "must-not-be-returned"
})
const run = (
  raw: unknown = input,
  result: RemoteFunctionResult = { outputs: { ACTIVITIES_FOUND: [] } },
  readFunction: (name: string) => Promise<unknown> = reader,
  readTable = async (name: string) => table(name),
  called = (_request: RemoteFunctionRequest) => {}
) =>
  findConfigurationActivities(
    raw,
    {
      callRemoteFunction: async (_connection, request) => {
        called(request)
        return result
      }
    },
    readFunction,
    readTable
  )

test("IMG navigation uses one exact S object, deduplicates and caps output without exposing audit fields", async () => {
  let calls = 0
  const result = await run(
    { connectionId: "W200", objectName: "t005", maxActivities: 1 },
    {
      outputs: { ACTIVITIES_FOUND: [row("TEST_B"), row("TEST_A"), row("TEST_A")] }
    },
    reader,
    async (name) => table(name),
    (request) => {
      calls++
      assert.deepEqual(request.inputParameters, { OBJECTNAME: "T005", OBJECTTYPE: "S" })
      assert.equal(request.functionName, "SCOUT_IMG_ACTIVITY_GET_W_OBJ")
    }
  )
  assert.equal(calls, 1)
  assert.equal(result.observedCount, 2)
  assert.equal(result.truncated, true)
  assert.equal(result.activities[0]!.activityId, "TEST_A")
  assert.equal(result.activities[0]!.title.status, "unknown")
  assert.equal(result.saveAvailable, false)
  assert.ok(!JSON.stringify(result).includes("must-not-be-returned"))
})

test("IMG scope and stale definition are refused before RFC", async () => {
  const never = () => {
    assert.fail("RFC must not run")
  }
  for (const raw of [
    { ...input, objectName: "USR02" },
    { ...input, objectName: "DD03L" },
    { ...input, maxActivities: 101 },
    { ...input, objectType: "T" },
    { ...input, expectedDefinitionFingerprint: "b".repeat(64) }
  ])
    await assert.rejects(run(raw, undefined, reader, undefined, never))
})

test("IMG reader, transitive dependency and header layout must match before RFC", async () => {
  for (const target of configurationImgReaders) {
    await assert.rejects(
      run(
        input,
        undefined,
        async (name) => ({
          ...(await reader(name)),
          sourceFingerprint:
            name === target.functionName ? hash : (await reader(name)).sourceFingerprint
        }),
        undefined,
        () => assert.fail("RFC must not run")
      ),
      /API_UNVERIFIED/
    )
  }
  await assert.rejects(
    run(
      input,
      undefined,
      reader,
      async (name) => ({ ...table(name), fingerprint: hash }),
      () => assert.fail("RFC must not run")
    ),
    /LAYOUT_UNVERIFIED/
  )
})

test("IMG faults, malformed output and conflicting headers never become empty success", async () => {
  await assert.rejects(
    run(input, {
      outputs: {},
      fault: { code: "1", name: "NOT_USED_IN_IMG_ACTIVITIES", message: "root" }
    }),
    /RFC_FAILED: NOT_USED/
  )
  await assert.rejects(run(input, { outputs: {} }), /RESPONSE_INVALID/)
  await assert.rejects(
    run(input, {
      outputs: { ACTIVITIES_FOUND: [row("TEST"), { ...row("TEST"), TCODE: "OTHER" }] }
    }),
    /AMBIGUOUS_RESULT/
  )
  const empty = await run()
  assert.equal(empty.status, "partial")
  assert.equal(empty.observedCount, 0)
})

test("IMG rechecks API and object definitions after RFC", async () => {
  let count = 0
  await assert.rejects(
    run(input, undefined, async (name) => ({
      ...(await reader(name)),
      sourceFingerprint: ++count > 2 ? hash : (await reader(name)).sourceFingerprint
    })),
    /API_UNVERIFIED/
  )
  let definitions = 0
  await assert.rejects(
    run(input, undefined, reader, async (name) => ({
      ...table(name),
      version: name === "T005" && ++definitions > 1 ? "2" : "1"
    })),
    /DEFINITION_CHANGED/
  )
})

test("IMG service uses the existing metadata readers and config/full/readonly profiles", async () => {
  const backend = new MockBackend()
  backend.callRemoteFunction = async () => ({ outputs: { ACTIVITIES_FOUND: [row("TEST")] } })
  const service = new ToolService(backend)
  service.readFunctionModuleInterface = async ({ functionName }) =>
    JSON.stringify(await reader(functionName))
  service.readDdicTransparentTable = async ({ objectName }) => JSON.stringify(table(objectName))
  const result = JSON.parse(await service.findConfigurationActivities(input))
  assert.equal(result.activities[0].activityId, "TEST")
  for (const profile of ["config", "full", "readonly"] as const)
    assert.ok(toolNamesForProfile(profile).includes("find_configuration_activities"))
  for (const profile of ["dev", "ops"] as const)
    assert.ok(!toolNamesForProfile(profile).includes("find_configuration_activities"))
  assert.equal(toolContracts.find_configuration_activities.annotations.readOnlyHint, true)
})

// Synthetic registrations; the real unit maintenance object must be read from SAP.
const registration = (OBJECTNAME = "TEST_UNIT", OBJECTTYPE: "L" | "V" = "L") => ({
  OBJECTNAME,
  OBJECTTYPE,
  TABNAME: "T006" as const,
  COVER: "",
  CANDIDATE: "",
  DDIC: "",
  PRIM_TABLE: "X",
  VIEWGRANT: "",
  TAB_FILLED: ""
})
const mappingTable = async () => ({
  connectionId: "w200",
  objectName: "OBJS",
  objectKind: "transparentTable",
  fingerprint: "dc1667a4e14e0d69b372ef3a7704052d5456d0542b1d45390bb1a662a5723451"
})
const mappedInput = { connectionId: "w200", objectName: "T006", resolveMaintenanceObjects: true }
const mapping = (rows = [registration()]) => ({
  rows,
  fingerprint: hash,
  sources: [],
  warnings: []
})
const rfcReader = async () => ({
  functionName: "RFC_READ_TABLE",
  remoteEnabled: true,
  updateTask: false,
  sourceFingerprint: "7b9a603493673d26f75e555616b24d150e407ce03eff57e9c68f0b30b1ba0c2d",
  interfaceFingerprint: "d06cc5c1ce05960bde526ecf27e38606134146474cc8da19f93ac2abd3e48074"
})

test("unit mapping reads only exact OBJS metadata with a sentinel bound and rechecks layout", async () => {
  let definitions = 0
  const result = await resolveConfigurationMaintenanceObjects(
    "w200",
    "T006",
    "200",
    {
      runQuery: async (_connection, sql, maxRows) => {
        assert.ok(sql.endsWith("FROM OBJS WHERE TABNAME = 'T006'"))
        assert.equal(maxRows, 17)
        assert.ok(!sql.includes("SELECT *"))
        return [registration(), registration()]
      },
      callRemoteFunction: async () => {
        assert.fail("native success must not call RFC")
      }
    },
    async () => {
      definitions++
      return mappingTable()
    },
    rfcReader
  )
  assert.equal(definitions, 2)
  assert.equal(result.rows.length, 1)
  assert.equal(result.sources[0]!.status, "ok")
  assert.equal(result.sources[0]!.method, "adt_query")
})

test("unit mapping scope and layout guards deny before querying SAP", async () => {
  const never = async () => {
    assert.fail("must not query")
  }
  const backend = { runQuery: never, callRemoteFunction: never }
  for (const [connection, tableName, client] of [
    ["w300", "T006", "200"],
    ["w200", "T005", "200"],
    ["w200", "T006", "000"]
  ])
    await assert.rejects(
      resolveConfigurationMaintenanceObjects(
        connection!,
        tableName!,
        client!,
        backend,
        never,
        rfcReader
      ),
      /SCOPE_UNSUPPORTED/
    )
  await assert.rejects(
    resolveConfigurationMaintenanceObjects(
      "w200",
      "T006",
      "200",
      backend,
      async () => ({ ...(await mappingTable()), fingerprint: hash }),
      rfcReader
    ),
    /LAYOUT_UNVERIFIED/
  )
})

test("unit mapping distinguishes truncated, cross-table, conflicting and denied reads from empty", async () => {
  for (const [rows, code] of [
    [Array.from({ length: 17 }, () => registration()), /LIMIT_EXCEEDED/],
    [[{ ...registration(), TABNAME: "T005" }], /SCOPE_MISMATCH/],
    [[registration(), { ...registration(), PRIM_TABLE: "" }], /AMBIGUOUS/]
  ] as const) {
    await assert.rejects(
      resolveConfigurationMaintenanceObjects(
        "w200",
        "T006",
        "200",
        {
          runQuery: async () => [...rows],
          callRemoteFunction: async () => {
            assert.fail("no RFC")
          }
        },
        mappingTable,
        rfcReader
      ),
      code
    )
  }
  await assert.rejects(
    resolveConfigurationMaintenanceObjects(
      "w200",
      "T006",
      "200",
      {
        runQuery: async () => {
          throw new Error("HTTP 403")
        },
        callRemoteFunction: async () => {
          assert.fail("403 must not fall back")
        }
      },
      mappingTable,
      rfcReader
    ),
    /QUERY_FAILED/
  )
})

test("unit mapping falls back only to the fingerprint-reviewed reader with exact field and row scope", async () => {
  let calls = 0
  const backend = {
    runQuery: async () => {
      throw new Error(NATIVE_PREVIEW_EMPTY_HTML)
    },
    callRemoteFunction: async (_connection: string, request: RemoteFunctionRequest) => {
      calls++
      assert.equal(request.functionName, "RFC_READ_TABLE")
      assert.equal(request.inputParameters.QUERY_TABLE, "OBJS")
      assert.equal(request.inputParameters.ROWCOUNT, "17")
      assert.deepEqual(request.inputParameters.OPTIONS, [{ TEXT: "TABNAME = 'T006'" }])
      const fields = request.inputParameters.FIELDS as { FIELDNAME: string }[]
      const values = registration() as Record<string, string>
      return {
        outputs: {
          FIELDS: fields,
          DATA: [{ WA: fields.map((f) => values[f.FIELDNAME]).join("|") }]
        }
      }
    }
  }
  const result = await resolveConfigurationMaintenanceObjects(
    "w200",
    "T006",
    "200",
    backend,
    mappingTable,
    rfcReader
  )
  assert.equal(calls, 1)
  assert.equal(result.rows[0]!.OBJECTTYPE, "L")
  assert.equal(result.sources[0]!.method, "rfc_read_table")
  await assert.rejects(
    resolveConfigurationMaintenanceObjects(
      "w200",
      "T006",
      "200",
      backend,
      mappingTable,
      async () => ({ ...(await rfcReader()), sourceFingerprint: hash })
    ),
    /FALLBACK_UNVERIFIED/
  )
  assert.equal(calls, 1)
})

test("mapped IMG lookup follows actual L/V names, merges shared activities and records route faults", async () => {
  const calls: RemoteFunctionRequest[] = []
  let resolutions = 0
  const result = await findConfigurationActivities(
    mappedInput,
    {
      callRemoteFunction: async (_connection, request) => {
        calls.push(request)
        return request.inputParameters.OBJECTNAME === "TEST_BROKEN"
          ? {
              outputs: {},
              fault: { code: "1", name: "NOT_USED_IN_IMG_ACTIVITIES", message: "root" }
            }
          : { outputs: { ACTIVITIES_FOUND: [row("TEST_A")] } }
      }
    },
    reader,
    async (name) => table(name),
    async () => {
      resolutions++
      return mapping([registration(), registration("TEST_VIEW", "V"), registration("TEST_BROKEN")])
    }
  )
  assert.equal(resolutions, 2)
  assert.deepEqual(
    calls.map((c) => c.inputParameters),
    [
      { OBJECTNAME: "TEST_UNIT", OBJECTTYPE: "L" },
      { OBJECTNAME: "TEST_VIEW", OBJECTTYPE: "V" },
      { OBJECTNAME: "TEST_BROKEN", OBJECTTYPE: "L" }
    ]
  )
  assert.equal(result.activities.length, 1)
  assert.deepEqual(result.activities[0]!.maintenanceObjects, ["L:TEST_UNIT", "V:TEST_VIEW"])
  assert.equal(result.lookups[2]!.status, "unavailable")
  assert.equal(result.maintenanceObjectType, null)
  assert.equal(result.saveAvailable, false)
})

test("mapped IMG lookup rejects mapping changes and cannot resolve arbitrary configuration domains", async () => {
  let reads = 0
  await assert.rejects(
    findConfigurationActivities(
      mappedInput,
      { callRemoteFunction: async () => ({ outputs: { ACTIVITIES_FOUND: [row("TEST")] } }) },
      reader,
      async (name) => table(name),
      async () => ({ ...mapping(), fingerprint: ++reads === 1 ? hash : "b".repeat(64) })
    ),
    /MAPPING_CHANGED/
  )
  await assert.rejects(
    findConfigurationActivities(
      { ...mappedInput, objectName: "T005" },
      {
        callRemoteFunction: async () => {
          assert.fail("no RFC")
        }
      },
      reader,
      async () => {
        assert.fail("no definition read")
      },
      async () => mapping()
    ),
    /SCOPE_UNSUPPORTED/
  )
})

test("IMG service resolved mode uses the dedicated metadata scope and rejects another client", async () => {
  const backend = new MockBackend()
  backend.runQuery = async () => [registration()]
  backend.callRemoteFunction = async () => ({ outputs: { ACTIVITIES_FOUND: [row("TEST")] } })
  const service = new ToolService(backend)
  service.readDdicTransparentTable = async ({ objectName }) =>
    JSON.stringify(objectName === "OBJS" ? await mappingTable() : table(objectName))
  service.readFunctionModuleInterface = async ({ functionName }) =>
    JSON.stringify(await reader(functionName))
  assert.equal(
    JSON.parse(await service.findConfigurationActivities(mappedInput)).activities[0]
      .maintenanceObjects[0],
    "L:TEST_UNIT"
  )
  const details = backend.connectionDetails("w200")
  backend.connectionDetails = () => ({ ...details, client: "000" })
  backend.runQuery = async () => {
    assert.fail("must not query another client")
  }
  await assert.rejects(service.findConfigurationActivities(mappedInput), /SCOPE_UNSUPPORTED/)
})

const transactionTable = async (name: string) => ({
  ...table(name),
  fingerprint: (
    {
      TSTC: "44e8612fb2a6250584d3c6800498b7c3dd4c33de3790fc13dc0c2793e1b2ce26",
      CUS_ACTOBJ: "b07c51f5e069ebdd1814afd6f33b2d49bca96baa5f312399a8354c2be0b746a1",
      CUS_IMGACH: "66dc39d4bb427dcd68ec903287450f811dcd71eee8933a11e322e14783b6af6a"
    } as Record<string, string>
  )[name]
})
const transactionRows = (sql: string) =>
  sql.includes("FROM TSTC")
    ? [{ TCODE: "TEST_CODE", PGMNA: "TEST_PROGRAM" }]
    : sql.includes("FROM CUS_ACTOBJ")
      ? [{ ACT_ID: "TEST_CUSTOM", TCODE: "TEST_CODE" }]
      : [{ ...row("TEST_IMG"), C_ACTIVITY: "TEST_CUSTOM" }]

test("transaction route follows TCODE and ACT_ID rather than OBJECTNAME, with bounded projections", async () => {
  const queries: string[] = []
  const result = await readConfigurationTransactionActivities(
    "w200",
    "T006",
    "200",
    "TEST_CODE",
    {
      runQuery: async (_connection, sql, maximum) => {
        queries.push(sql)
        assert.equal(maximum, sql.includes("FROM TSTC") ? 2 : 17)
        assert.ok(!sql.includes("OBJECTNAME"))
        return sql.includes("FROM CUS_ACTOBJ")
          ? [...transactionRows(sql), ...transactionRows(sql)]
          : transactionRows(sql)
      },
      callRemoteFunction: async () => {
        assert.fail("native success must not call RFC")
      }
    },
    transactionTable,
    rfcReader
  )
  assert.equal(queries.length, 3)
  assert.ok(queries[1]!.endsWith("WHERE TCODE = 'TEST_CODE'"))
  assert.ok(queries[2]!.endsWith("WHERE C_ACTIVITY = 'TEST_CUSTOM'"))
  assert.equal(result.rows[0]!.ACTIVITY, "TEST_IMG")
  assert.equal(result.transaction.PGMNA, "TEST_PROGRAM")
  assert.ok(!JSON.stringify(result.rows).includes("must-not-be-returned"))
})

test("transaction route refuses missing transactions, truncation, scope drift and changed layouts", async () => {
  for (const [target, replacement, code] of [
    ["TSTC", [], /NOT_FOUND/],
    ["CUS_ACTOBJ", [{ ACT_ID: "TEST_CUSTOM", TCODE: "OTHER" }], /SCOPE_MISMATCH/],
    [
      "CUS_ACTOBJ",
      Array.from({ length: 17 }, () => ({ ACT_ID: "TEST_CUSTOM", TCODE: "TEST_CODE" })),
      /LIMIT_EXCEEDED/
    ],
    ["CUS_IMGACH", [{ ...row("TEST_IMG"), C_ACTIVITY: "WRONG" }], /SCOPE_MISMATCH/]
  ] as const)
    await assert.rejects(
      readConfigurationTransactionActivities(
        "w200",
        "T006",
        "200",
        "TEST_CODE",
        {
          runQuery: async (_connection, sql) =>
            sql.includes(`FROM ${target}`) ? [...replacement] : transactionRows(sql),
          callRemoteFunction: async () => {
            assert.fail("no RFC")
          }
        },
        transactionTable,
        rfcReader
      ),
      code
    )
  let definitions = 0
  await assert.rejects(
    readConfigurationTransactionActivities(
      "w200",
      "T006",
      "200",
      "TEST_CODE",
      {
        runQuery: async (_connection, sql) => transactionRows(sql),
        callRemoteFunction: async () => {
          assert.fail("no RFC")
        }
      },
      async (name) => ({
        ...(await transactionTable(name)),
        fingerprint: ++definitions > 3 ? hash : (await transactionTable(name)).fingerprint
      }),
      rfcReader
    ),
    /LAYOUT_UNVERIFIED/
  )
})

test("T registrations use transaction metadata callbacks and never the object-name RFC route", async () => {
  const registered = { ...registration("TEST_CODE"), OBJECTTYPE: "T" as const }
  const result = await findConfigurationActivities(
    mappedInput,
    {
      callRemoteFunction: async () => {
        assert.fail("T objects must not use the name lookup")
      }
    },
    reader,
    async (name) => table(name),
    async () => ({ ...mapping(), rows: [registered] }),
    async (name) => {
      assert.equal(name, "TEST_CODE")
      return {
        rows: [{ ...row("TEST_IMG"), C_ACTIVITY: "TEST_CUSTOM" }],
        sources: [],
        warnings: [],
        transaction: { TCODE: name, PGMNA: "TEST_PROGRAM" },
        method: "transaction_metadata_join"
      }
    }
  )
  assert.deepEqual(result.activities[0]!.maintenanceObjects, ["T:TEST_CODE"])
  assert.equal(result.lookups[0]!.method, "transaction_metadata_join")
})
