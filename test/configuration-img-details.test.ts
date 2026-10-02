import assert from "node:assert/strict"
import test from "node:test"
import {
  configurationImgDetailLayouts,
  readConfigurationImgDetails
} from "../src/configuration-img-details.js"
import {
  NATIVE_PREVIEW_EMPTY_HTML,
  reviewedTableReaderDefinition
} from "../src/reviewed-table-reader.js"

// Synthetic linked structures and translations; no assertions about actual SAP titles.
const dataset = () => {
  const rows: Record<string, Record<string, string>[]> = {
    T002: [
      { SPRAS: "1", LAISO: "ZH" },
      { SPRAS: "E", LAISO: "EN" }
    ],
    CUS_IMGACT: [
      { SPRAS: "1", ACTIVITY: "TEST_A", TEXT: "测试活动" },
      { SPRAS: "E", ACTIVITY: "TEST_A", TEXT: "Test activity" }
    ],
    TTREE: [],
    TTREETYPE: []
  }
  for (const n of [1, 2]) {
    const table = `TNODE0${n}`
    const common = { TREE_ID: `TREE${n}`, EXT_KEY: "EXT", EXTENSION: "" }
    rows[table] = [
      { ...common, NODE_ID: `ROOT${n}`, PARENT_ID: "", REFNODE_ID: "", REFTREE_ID: "" },
      { ...common, NODE_ID: `LEAF${n}`, PARENT_ID: `ROOT${n}`, REFNODE_ID: "", REFTREE_ID: "" }
    ]
    rows[`${table}R`] = [
      { NODE_ID: `LEAF${n}`, EXT_KEY: "EXT", EXTENSION: "", REF_TYPE: "COBJ", REF_OBJECT: "TEST_A" }
    ]
    rows[`${table}T`] = rows[table]!.map((row) => ({
      ...row,
      SPRAS: "1",
      TEXT: row.NODE_ID!
    }))
    rows.TTREE!.push({ ID: `TREE${n}`, EXT_KEY: "EXT", TYPE: `TYPE${n}`, NODE_ID: `ROOT${n}` })
    rows.TTREETYPE!.push({ TREE_TYPE: `TYPE${n}`, ACTIVE: "X", DB_IDENT: "GENER", DB_TABLE: table })
  }
  return rows
}
const definition = async (name: string) => ({
  connectionId: "w200",
  objectName: name,
  objectKind: "transparentTable",
  active: true,
  fingerprint: configurationImgDetailLayouts[name as keyof typeof configurationImgDetailLayouts]
})
const select = (rows: ReturnType<typeof dataset>, sql: string, limit: number) => {
  const match = /^SELECT (.+) FROM (\w+) WHERE (.+)$/.exec(sql)!
  const fields = match[1]!.split(", ")
  const filters = [...match[3]!.matchAll(/(\w+) = '([^']*)'/g)]
  return (rows[match[2]!] ?? [])
    .filter((row) => filters.every((filter) => row[filter[1]!] === filter[2]))
    .slice(0, limit)
    .map((row) => Object.fromEntries(fields.map((field) => [field, row[field] ?? ""])))
}
const run = (
  rows = dataset(),
  language = "ZH",
  headers = [{ ACTIVITY: "TEST_A", DOCU_ID: "SIMG_TEST" }],
  readTable: (name: string) => Promise<unknown> = definition,
  query = async (sql: string, limit: number) => select(rows, sql, limit)
) =>
  readConfigurationImgDetails(
    "w200",
    "T006A",
    "200",
    language,
    headers,
    {
      runQuery: async (_connection, sql, limit) => query(sql, limit!),
      callRemoteFunction: async () => assert.fail("native success must not call RFC")
    },
    readTable,
    async () => assert.fail("native success must not inspect RFC")
  )

test("IMG details resolve actual language and retain distinct structures in root-to-leaf order", async () => {
  const rows = dataset()
  rows.TNODE01R!.push({ ...rows.TNODE01R![0]! })
  const result = await run(rows, " zh ")
  const activity = result.activities[0]!
  assert.equal(activity.title.text, "测试活动")
  assert.equal(activity.title.sapLanguage, "1")
  assert.equal(activity.title.fallbackUsed, false)
  assert.deepEqual(
    activity.path.variants.map((p) => p.nodes.map((n) => n.nodeId)),
    [
      ["ROOT1", "LEAF1"],
      ["ROOT2", "LEAF2"]
    ]
  )
  assert.equal(activity.path.complete, false)
  assert.equal(activity.path.scope, "physical_structures_only")
  assert.equal(activity.documentation.readability, "unknown")
  assert.equal(activity.documentation.content.status, "unknown")
  assert.equal((await run(rows, "EN")).activities[0]!.title.text, "Test activity")
  const missing = await run(rows, "DE")
  assert.ok("code" in missing)
  assert.equal(missing.code, "CONFIGURATION_IMG_DETAIL_LANGUAGE_NOT_FOUND")
  rows.CUS_IMGACT = []
  assert.equal((await run(rows)).activities[0]!.title.status, "not_found")
})

test("IMG path cycles and unresolved references remain partial without discarding activity titles", async () => {
  for (const reference of [false, true]) {
    const rows = dataset()
    if (reference) rows.TNODE01![1]!.REFNODE_ID = "OTHER"
    else rows.TNODE01![1]!.PARENT_ID = "LEAF1"
    const result = await run(rows)
    assert.equal(result.activities[0]!.title.status, "read")
    assert.equal(
      result.activities[0]!.path.variants[0]!.reason,
      reference ? "CROSS_STRUCTURE_REFERENCE_UNRESOLVED" : "CYCLE_DETECTED"
    )
    assert.equal(result.activities[0]!.path.variants[1]!.status, "read")
  }
  const rows = dataset()
  rows.TNODE01R!.unshift({ ...rows.TNODE01R![0]!, NODE_ID: "MISSING" })
  const surviving = (await run(rows)).activities[0]!.path
  assert.equal(surviving.issues[0]!.code, "CONFIGURATION_IMG_DETAIL_NODE_NOT_FOUND")
  assert.equal(surviving.variants.length, 2)
})

test("IMG details distinguish sentinel truncation, cross-scope rows and layout drift", async () => {
  const rows = dataset()
  rows.TNODE01R = Array.from({ length: 17 }, () => ({ ...rows.TNODE01R![0]! }))
  assert.equal(
    (await run(rows)).activities[0]!.path.issues[0]!.code,
    "CONFIGURATION_IMG_DETAIL_LIMIT_EXCEEDED"
  )
  const wrong = await run(dataset(), "ZH", undefined, undefined, async (sql, limit) => {
    const values = select(dataset(), sql, limit)
    return sql.includes("FROM CUS_IMGACT")
      ? values.map((v) => ({ ...v, ACTIVITY: "WRONG" }))
      : values
  })
  const wrongTitle = wrong.activities[0]!.title
  assert.ok("code" in wrongTitle)
  assert.equal(wrongTitle.code, "CONFIGURATION_IMG_DETAIL_RESPONSE_SCOPE_MISMATCH")
  let calls = 0
  const changed = await run(dataset(), "ZH", undefined, async (name) => ({
    ...(await definition(name)),
    fingerprint:
      name === "T002" && ++calls > 1 ? "a".repeat(64) : (await definition(name)).fingerprint
  }))
  assert.ok("code" in changed)
  assert.equal(changed.code, "CONFIGURATION_IMG_DETAIL_LAYOUT_UNVERIFIED")
  assert.deepEqual(changed.activities, [])
})

test("IMG details enforce per-request read budget and depth ceiling", async () => {
  let reads = 0
  const result = await run(
    dataset(),
    "ZH",
    Array.from({ length: 100 }, (_, n) => ({ ACTIVITY: `TEST_${n}`, DOCU_ID: "" })),
    undefined,
    async (sql, limit) => {
      reads++
      return select(dataset(), sql, limit)
    }
  )
  assert.equal(reads, 96)
  assert.ok(JSON.stringify(result).includes("CONFIGURATION_IMG_DETAIL_READ_BUDGET_EXCEEDED"))
  const rows = dataset()
  const common = rows.TNODE01![1]!
  rows.TNODE01 = Array.from({ length: 34 }, (_, n) => ({
    ...common,
    NODE_ID: n === 0 ? "LEAF1" : `P${n}`,
    PARENT_ID: `P${n + 1}`
  }))
  const deep = await run(rows)
  assert.equal(deep.activities[0]!.path.variants[0]!.reason, "DEPTH_LIMIT_EXCEEDED")
  assert.equal(deep.activities[0]!.path.variants[0]!.nodes.length, 32)
})

test("IMG details refuse unapproved scope before reads and never bypass HTTP permission failure", async () => {
  const never = async () => assert.fail("scope guard must precede reads")
  for (const [connection, object, client] of [
    ["w300", "T006A", "200"],
    ["w200", "T005", "200"],
    ["w200", "T006", "000"]
  ])
    await assert.rejects(
      readConfigurationImgDetails(
        connection!,
        object!,
        client!,
        "EN",
        [],
        { runQuery: never, callRemoteFunction: never },
        never,
        never
      ),
      /SCOPE_UNSUPPORTED/
    )
  const denied = await run(dataset(), "ZH", undefined, undefined, async () => {
    throw new Error("HTTP 403")
  })
  assert.equal(denied.status, "unavailable")
  assert.deepEqual(denied.activities, [])
})

test("IMG empty-HTML fallback is pinned and permission faults stay unavailable", async () => {
  const result = await readConfigurationImgDetails(
    "w200",
    "T006",
    "200",
    "ZH",
    [],
    {
      runQuery: async () => {
        throw new Error(NATIVE_PREVIEW_EMPTY_HTML)
      },
      callRemoteFunction: async (_connection, request) => {
        assert.equal(request.functionName, "RFC_READ_TABLE")
        assert.equal(request.inputParameters.QUERY_TABLE, "T002")
        assert.equal(request.inputParameters.ROWCOUNT, "2")
        assert.deepEqual(request.inputParameters.OPTIONS, [{ TEXT: "LAISO = 'ZH'" }])
        return { outputs: {}, fault: { name: "NOT_AUTHORIZED", code: "5", message: "Denied" } }
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
  assert.ok("code" in result)
  assert.equal(result.code, "CONFIGURATION_IMG_DETAIL_NOT_AUTHORIZED")
  assert.deepEqual(result.activities, [])
})
