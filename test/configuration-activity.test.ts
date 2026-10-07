import assert from "node:assert/strict"
import test from "node:test"
import { readConfigurationActivity } from "../src/configuration-activity.js"
import { configurationImgDetailLayouts } from "../src/configuration-img-details.js"
import {
  NATIVE_PREVIEW_EMPTY_HTML,
  reviewedTableReaderDefinition
} from "../src/reviewed-table-reader.js"
import { ToolService } from "../src/tools.js"
import { toolContracts } from "../src/contracts.js"
import { toolNamesForProfile } from "../src/tool-registry.js"
import { MockBackend } from "./mock-backend.js"

// Synthetic identifiers/data: these tests make no claims about actual SAP activity names.
const pins: Record<string, string> = {
  ...configurationImgDetailLayouts,
  CUS_IMGACH: "66dc39d4bb427dcd68ec903287450f811dcd71eee8933a11e322e14783b6af6a",
  CUS_ACTOBJ: "b07c51f5e069ebdd1814afd6f33b2d49bca96baa5f312399a8354c2be0b746a1"
}
const definition = async (objectName: string) => ({
  objectName,
  connectionId: "w200",
  objectKind: "transparentTable",
  active: true,
  fingerprint: pins[objectName]
})
const dataset = () => ({
  CUS_IMGACH: [
    {
      ACTIVITY: "TEST_IMG",
      DOCU_ID: "TEST_DOC",
      ATTRIBUTES: "",
      C_ACTIVITY: "TEST_C",
      TCODE: "TEST_T"
    }
  ],
  CUS_ACTOBJ: [
    {
      ACT_ID: "TEST_C",
      OBJECTNAME: "TEST_VIEW",
      OBJECTTYPE: "V",
      TCODE: "SM30",
      SUBOBJNAME: "",
      VARIANT: "",
      TXN_NO_CON: "",
      IMG_POS: "1",
      SUPRESS_FL: ""
    },
    {
      ACT_ID: "TEST_C",
      OBJECTNAME: "TEST_OTHER",
      OBJECTTYPE: "V",
      TCODE: "SM30",
      SUBOBJNAME: "",
      VARIANT: "",
      TXN_NO_CON: "",
      IMG_POS: "2",
      SUPRESS_FL: ""
    }
  ],
  T002: [
    { LAISO: "ZH", SPRAS: "1" },
    { LAISO: "EN", SPRAS: "E" }
  ],
  CUS_IMGACT: [{ ACTIVITY: "TEST_IMG", SPRAS: "1", TEXT: "活动标题" }],
  TNODE01R: [
    { NODE_ID: "LEAF", EXT_KEY: "", EXTENSION: "X", REF_TYPE: "COBJ", REF_OBJECT: "TEST_IMG" }
  ],
  TNODE01: [
    {
      TREE_ID: "TREE",
      NODE_ID: "LEAF",
      EXT_KEY: "",
      EXTENSION: "X",
      PARENT_ID: "",
      REFNODE_ID: "",
      REFTREE_ID: ""
    }
  ],
  TTREE: [{ ID: "TREE", EXT_KEY: "", TYPE: "TEST_TYPE", NODE_ID: "LEAF" }],
  TTREETYPE: [{ TREE_TYPE: "TEST_TYPE", ACTIVE: "X", DB_IDENT: "GENER", DB_TABLE: "TNODE01" }],
  TNODE01T: [
    { TREE_ID: "TREE", NODE_ID: "LEAF", EXT_KEY: "", EXTENSION: "X", SPRAS: "1", TEXT: "节点标题" }
  ]
})
const select = (rows: Record<string, Record<string, string>[]>, sql: string, limit: number) => {
  const match = /^SELECT (.+) FROM (\w+) WHERE (.+)$/.exec(sql)!
  const fields = match[1]!.split(", ")
  const filters = [...match[3]!.matchAll(/(\w+) = '([^']*)'/g)]
  return (rows[match[2]!] ?? [])
    .filter((row) => filters.every((f) => row[f[1]!] === f[2]))
    .slice(0, limit)
    .map((row) => Object.fromEntries(fields.map((f) => [f, row[f] ?? ""])))
}
const run = (
  rows = dataset(),
  readTable: (name: string) => Promise<unknown> = definition,
  query = async (sql: string, limit: number) => select(rows, sql, limit),
  raw: unknown = { connectionId: "w200", activityId: "TEST_IMG" },
  client = "200"
) =>
  readConfigurationActivity(
    raw,
    client,
    "ZH",
    {
      runQuery: async (_id, sql, limit) => query(sql, limit!),
      callRemoteFunction: async () => assert.fail("native success/auth failure must not call RFC")
    },
    readTable,
    async () => assert.fail("native reads need no RFC definition")
  )

test("direct IMG lookup returns actual language, physical node identity and multiple maintenance objects", async () => {
  const result = await run()
  assert.equal(result.header.status, "read")
  assert.ok("text" in result.title)
  assert.equal(result.title.text, "活动标题")
  assert.equal(result.title.sapLanguage, "1")
  assert.equal(result.title.fallbackUsed, false)
  assert.ok("variants" in result.path)
  assert.equal(result.path.variants[0]!.extension, "X")
  assert.equal(result.path.variants[0]!.nodes[0]!.nodeId, "LEAF")
  assert.equal(result.path.complete, false)
  assert.equal(result.maintenanceObjects.objects.length, 2)
  assert.equal(result.maintenanceObjects.objects[0]!.OBJECTNAME, "TEST_OTHER")
  assert.equal(result.maintenanceRoute.executionAvailable, false)
  assert.equal(result.saveAvailable, false)
  assert.equal(result.evidence.headerRechecked, true)
  assert.equal(
    (
      await run(undefined, undefined, undefined, {
        connectionId: "W200",
        activityId: " test_img ",
        language: "en"
      })
    ).title.status,
    "not_found"
  )
})

test("missing header preserves independently stored titles/nodes and never reports global absence", async () => {
  const rows = dataset()
  rows.CUS_IMGACH = []
  const result = await run(rows)
  assert.equal(result.header.status, "not_found")
  assert.ok("text" in result.title)
  assert.equal(result.title.text, "活动标题")
  assert.ok("variants" in result.path)
  assert.equal(result.path.variants.length, 1)
  assert.equal(result.maintenanceObjects.status, "header_not_found")
  assert.ok(!result.evidence.sources.some((s) => s.table === "CUS_ACTOBJ"))
  assert.equal(result.status, "partial")
})

test("invalid IDs/options and other systems/clients are rejected before metadata or query access", async () => {
  for (const raw of [
    { connectionId: "other", activityId: "TEST_IMG" },
    { connectionId: "w200", activityId: "X' OR 1=1" },
    { connectionId: "w200", activityId: "X".repeat(21) },
    { connectionId: "w200", activityId: "TEST_IMG", tableName: "USR02" },
    { connectionId: "w200", activityId: "TEST_IMG", language: "Z" }
  ])
    await assert.rejects(
      run(
        undefined,
        async () => assert.fail("no metadata"),
        async () => assert.fail("no query"),
        raw
      )
    )
  await assert.rejects(
    run(undefined, async () => assert.fail("no metadata"), undefined, undefined, "100"),
    /SCOPE_UNSUPPORTED/
  )
})

test("association limit/failure is explicit and retains the header/title", async () => {
  const rows = dataset()
  rows.CUS_ACTOBJ = Array.from({ length: 17 }, (_, i) => ({
    ...rows.CUS_ACTOBJ[0]!,
    OBJECTNAME: `TEST_${i}`
  }))
  const result = await run(rows)
  assert.equal(result.maintenanceObjects.code, "CONFIGURATION_ACTIVITY_LIMIT_EXCEEDED")
  assert.equal(result.maintenanceObjects.objects.length, 0)
  assert.ok("text" in result.title)
  assert.equal(result.title.text, "活动标题")
  assert.equal(result.header.status, "read")
  const refused = await run(undefined, undefined, async (sql, limit) => {
    if (sql.includes("FROM CUS_ACTOBJ")) throw new Error("HTTP 403")
    return select(dataset(), sql, limit)
  })
  assert.equal(refused.maintenanceObjects.status, "unavailable")
  assert.equal(refused.maintenanceObjects.code, "CONFIGURATION_ACTIVITY_QUERY_FAILED")
})

test("header/layout changes are refused; permission failures never become not found or trigger RFC", async () => {
  let headers = 0
  await assert.rejects(
    run(undefined, undefined, async (sql, limit) => {
      const result = select(dataset(), sql, limit)
      if (sql.includes("FROM CUS_IMGACH") && ++headers === 2) result[0]!.C_ACTIVITY = "CHANGED"
      return result
    }),
    /HEADER_CHANGED/
  )
  let definitions = 0
  await assert.rejects(
    run(undefined, async (name) => ({
      ...(await definition(name)),
      fingerprint: name === "CUS_IMGACH" && ++definitions === 2 ? "a".repeat(64) : pins[name]
    })),
    /LAYOUT_UNVERIFIED/
  )
  await assert.rejects(
    run(undefined, undefined, async () => {
      throw new Error("HTTP 403")
    }),
    /QUERY_FAILED/
  )
})

test("unavailable language remains explicit while verified associations survive", async () => {
  const result = await run(undefined, undefined, undefined, {
    connectionId: "w200",
    activityId: "TEST_IMG",
    language: "ZZ"
  })
  assert.equal(result.title.status, "unavailable")
  assert.ok("code" in result.title)
  assert.equal(result.title.code, "CONFIGURATION_IMG_DETAIL_LANGUAGE_NOT_FOUND")
  assert.equal(result.header.status, "read")
  assert.equal(result.maintenanceObjects.status, "read")
})

test("reviewed RFC fallback remains exact and bounded, not a generic table read", async () => {
  const rows = dataset()
  let calls = 0
  const result = await readConfigurationActivity(
    { connectionId: "w200", activityId: "TEST_IMG" },
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
        const where = (p.OPTIONS as { TEXT: string }[]).map((o) => o.TEXT).join(" ")
        const found = select(
          rows,
          `SELECT ${fields.join(", ")} FROM ${p.QUERY_TABLE} WHERE ${where}`,
          Number(p.ROWCOUNT)
        )
        assert.ok(Number(p.ROWCOUNT) <= 17)
        return {
          outputs: {
            FIELDS: fields.map((FIELDNAME) => ({ FIELDNAME })),
            DATA: found.map((r) => ({ WA: fields.map((f) => r[f]).join("|") }))
          }
        }
      }
    },
    definition,
    async () => ({
      functionName: "RFC_READ_TABLE",
      remoteEnabled: true,
      updateTask: false,
      sourceFingerprint: reviewedTableReaderDefinition.shape.sourceFingerprint.value,
      interfaceFingerprint: reviewedTableReaderDefinition.shape.interfaceFingerprint.value
    })
  )
  assert.ok(calls > 0)
  assert.ok("text" in result.title)
  assert.equal(result.title.text, "活动标题")
  assert.equal(result.evidence.sources[0]!.method, "rfc_read_table")
})

test("service and readonly/config/full profiles expose the dedicated activity contract", async () => {
  const backend = new MockBackend()
  const original = backend.connectionDetails.bind(backend)
  backend.connectionDetails = (id) => ({ ...original(id), client: "200", language: "ZH" })
  backend.runQuery = async (_id: string, sql: string, limit?: number) =>
    select(dataset(), sql, limit ?? 17)
  const service = new ToolService(backend)
  service.readDdicTransparentTable = async ({ objectName }) =>
    JSON.stringify(await definition(objectName))
  const result = JSON.parse(
    await service.readConfigurationActivity({ connectionId: "w200", activityId: "TEST_IMG" })
  )
  assert.equal(result.title.text, "活动标题")
  assert.equal(toolContracts.read_configuration_activity.annotations.readOnlyHint, true)
  for (const p of ["full", "config", "readonly"] as const)
    assert.ok(toolNamesForProfile(p).includes("read_configuration_activity"))
  for (const p of ["dev", "ops"] as const)
    assert.ok(!toolNamesForProfile(p).includes("read_configuration_activity"))
})
