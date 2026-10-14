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
import { configurationDocumentationSchema } from "../src/configuration-documentation.js"

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

test("IMG documentation nextRead uses the activity and verified ISO language without reading content", async () => {
  for (const [activityId, reference, supported] of [
    ["TEST_A", "SIMG_TEST", true],
    ["TEST_A", "", false],
    ["TEST_A", "OTHER", false],
    ["TEST_A", "SIMGbad", false],
    ["TEST_A", "SIMG" + "X".repeat(57), false],
    ["bad_activity", "SIMG_TEST", false]
  ] as const) {
    const result = await run(dataset(), " zh ", [{ ACTIVITY: activityId, DOCU_ID: reference }])
    const documentation = result.activities[0]!.documentation as unknown as {
      nextRead: { tool: string; arguments: unknown; readOnly: boolean } | null
      readability: string
      content: { status: string }
    }
    assert.equal(Boolean(documentation.nextRead), supported)
    assert.equal(documentation.readability, "unknown")
    assert.equal(documentation.content.status, "unknown")
    assert.ok(!result.sources.some((s) => ["DOKIL", "CUS_IMGACH"].includes(s.table)))
    if (documentation.nextRead) {
      assert.equal(documentation.nextRead.tool, "read_configuration_documentation")
      assert.equal(documentation.nextRead.readOnly, true)
      assert.deepEqual(documentation.nextRead.arguments, {
        connectionId: "w200",
        activityId,
        language: "ZH",
        maxLines: 200
      })
      assert.ok(
        configurationDocumentationSchema.safeParse(documentation.nextRead.arguments).success
      )
    }
  }
})

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

test("IMG explicit physical references retain source parents and resolve an exact target in another tree", async () => {
  const rows = dataset()
  rows.TNODE01![1]!.REFNODE_ID = "LEAF2"
  rows.TNODE01![1]!.REFTREE_ID = "TREE2"
  const activity = (await run(rows)).activities[0]!
  const variant = activity.path.variants[0]!
  assert.equal(variant.status, "read")
  assert.equal(variant.reason, null)
  assert.deepEqual(
    variant.nodes.map((node) => node.nodeId),
    ["ROOT1", "LEAF1"]
  )
  assert.equal(activity.title.text, "测试活动")
  const reference = variant.nodes[1]!.physicalReference as {
    status: string
    readOnly: boolean
    executable: boolean
    targets: { structureId: string; table: string; nodeId: string }[]
  }
  assert.equal(reference.status, "read")
  assert.equal(reference.readOnly, true)
  assert.equal(reference.executable, false)
  assert.deepEqual(
    reference.targets.map(({ structureId, table, nodeId }) => ({ structureId, table, nodeId })),
    [{ structureId: "TREE2", table: "TNODE02", nodeId: "LEAF2" }]
  )
  assert.equal(activity.path.variants[1]!.status, "read")
  assert.equal(activity.path.complete, false)
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
      reference ? "CONFIGURATION_IMG_DETAIL_REFERENCE_IDENTITY_INCOMPLETE" : "CYCLE_DETECTED"
    )
    if (reference)
      assert.deepEqual(
        result.activities[0]!.path.variants[0]!.nodes.map((node) => node.nodeId),
        ["ROOT1", "LEAF1"]
      )
    assert.equal(result.activities[0]!.path.variants[1]!.status, "read")
  }
  const rows = dataset()
  rows.TNODE01R!.unshift({ ...rows.TNODE01R![0]!, NODE_ID: "MISSING" })
  const surviving = (await run(rows)).activities[0]!.path
  assert.equal(surviving.issues[0]!.code, "CONFIGURATION_IMG_DETAIL_NODE_NOT_FOUND")
  assert.equal(surviving.variants.length, 2)
})

test("IMG tree references derive only the verified declared root when W_SUBNODES is set", async () => {
  const rows = dataset()
  rows.TNODE01![1]!.REFTREE_ID = "TREE2"
  rows.TNODE01![1]!.W_SUBNODES = "X"
  const variant = (await run(rows)).activities[0]!.path.variants[0]!
  assert.equal(variant.status, "read")
  const reference = variant.nodes[1]!.physicalReference as {
    targets: { nodeId: string; nodeSelection: string }[]
  }
  assert.equal(reference.targets[0]!.nodeId, "ROOT2")
  assert.equal(reference.targets[0]!.nodeSelection, "declared_root")
  rows.TNODE01![1]!.W_SUBNODES = ""
  assert.equal(
    (await run(rows)).activities[0]!.path.variants[0]!.reason,
    "CONFIGURATION_IMG_DETAIL_REFERENCE_IDENTITY_INCOMPLETE"
  )
})

test("IMG reference chains distinguish the same node identifier in different trees and node tables", async () => {
  const rows = dataset()
  rows.TNODE01![1]!.REFNODE_ID = "LEAF1"
  rows.TNODE01![1]!.REFTREE_ID = "TREE2"
  rows.TNODE02!.push({
    ...rows.TNODE02![1]!,
    NODE_ID: "LEAF1",
    REFNODE_ID: "LEAF1",
    REFTREE_ID: "TREE3"
  })
  rows.TTREE!.push({ ID: "TREE3", EXT_KEY: "EXT", TYPE: "TYPE3", NODE_ID: "LEAF1" })
  rows.TTREETYPE!.push({
    TREE_TYPE: "TYPE3",
    ACTIVE: "X",
    DB_IDENT: "GENER",
    DB_TABLE: "TNODEIMG"
  })
  rows.TNODEIMG = [
    {
      TREE_ID: "TREE3",
      EXT_KEY: "EXT",
      EXTENSION: "",
      NODE_ID: "LEAF1",
      PARENT_ID: "",
      REFNODE_ID: "",
      REFTREE_ID: "",
      W_SUBNODES: ""
    }
  ]
  const variant = (await run(rows)).activities[0]!.path.variants[0]!
  assert.equal(variant.status, "read")
  const reference = variant.nodes[1]!.physicalReference as {
    targets: { structureId: string; table: string; nodeId: string }[]
  }
  assert.deepEqual(
    reference.targets.map(({ structureId, table, nodeId }) => [structureId, table, nodeId]),
    [
      ["TREE2", "TNODE02", "LEAF1"],
      ["TREE3", "TNODEIMG", "LEAF1"]
    ]
  )
  rows.TNODEIMG[0]!.REFNODE_ID = "LEAF1"
  rows.TNODEIMG[0]!.REFTREE_ID = "TREE1"
  const cycle = (await run(rows)).activities[0]!.path.variants[0]!
  assert.equal(cycle.reason, "CONFIGURATION_IMG_DETAIL_REFERENCE_CYCLE_DETECTED")
  assert.deepEqual(
    cycle.nodes.map((node) => node.nodeId),
    ["ROOT1", "LEAF1"]
  )
})

test("IMG physical references refuse missing, ambiguous, unsupported and cross-extension targets", async (t) => {
  const cases: [string, string, (rows: ReturnType<typeof dataset>) => void][] = [
    [
      "missing tree",
      "REFERENCE_TREE_NOT_FOUND",
      (rows) => {
        rows.TTREE!.pop()
      }
    ],
    [
      "missing node",
      "REFERENCE_NODE_NOT_FOUND",
      (rows) => {
        rows.TNODE02!.pop()
      }
    ],
    [
      "ambiguous tree",
      "AMBIGUOUS_RESULT",
      (rows) => {
        rows.TTREE!.push({ ...rows.TTREE![1]! })
      }
    ],
    [
      "ambiguous type",
      "AMBIGUOUS_RESULT",
      (rows) => {
        rows.TTREETYPE!.push({ ...rows.TTREETYPE![1]! })
      }
    ],
    [
      "ambiguous node",
      "AMBIGUOUS_RESULT",
      (rows) => {
        rows.TNODE02!.push({ ...rows.TNODE02![1]! })
      }
    ],
    [
      "inactive type",
      "REFERENCE_STRUCTURE_UNSUPPORTED",
      (rows) => {
        rows.TTREETYPE![1]!.ACTIVE = ""
      }
    ],
    [
      "other reader",
      "REFERENCE_STRUCTURE_UNSUPPORTED",
      (rows) => {
        rows.TTREETYPE![1]!.DB_IDENT = "OTHER"
      }
    ],
    [
      "arbitrary table",
      "REFERENCE_STRUCTURE_UNSUPPORTED",
      (rows) => {
        rows.TTREETYPE![1]!.DB_TABLE = "USR02"
      }
    ],
    [
      "different EXT_KEY",
      "REFERENCE_EXT_KEY_MISMATCH",
      (rows) => {
        rows.TTREE![1]!.EXT_KEY = "OTHER"
      }
    ],
    [
      "target extension",
      "REFERENCE_EXTENSION_UNSUPPORTED",
      (rows) => {
        rows.TTREE![1]!.EXTENSION = "X"
      }
    ],
    [
      "source tree extension",
      "REFERENCE_EXTENSION_UNSUPPORTED",
      (rows) => {
        rows.TTREE![0]!.EXTENSION = "X"
      }
    ],
    [
      "source node extension",
      "REFERENCE_EXTENSION_UNSUPPORTED",
      (rows) => {
        rows.TNODE01R![0]!.EXTENSION = "X"
        for (const table of ["TNODE01", "TNODE01T"])
          for (const row of rows[table]!) row.EXTENSION = "X"
      }
    ],
    [
      "invalid node ID",
      "REFERENCE_IDENTITY_INCOMPLETE",
      (rows) => {
        rows.TNODE01![1]!.REFNODE_ID = "BAD'ID"
      }
    ],
    [
      "missing declared root",
      "REFERENCE_NODE_ID_INVALID",
      (rows) => {
        rows.TNODE01![1]!.REFNODE_ID = ""
        rows.TNODE01![1]!.W_SUBNODES = "X"
        rows.TTREE![1]!.NODE_ID = ""
      }
    ]
  ]
  for (const [name, reason, change] of cases)
    await t.test(name, async () => {
      const rows = dataset()
      rows.TNODE01![1]!.REFNODE_ID = "LEAF2"
      rows.TNODE01![1]!.REFTREE_ID = "TREE2"
      change(rows)
      const activity = (await run(rows)).activities[0]!
      const source = activity.path.variants[0]!
      assert.equal(source.status, "partial")
      assert.equal(source.reason, `CONFIGURATION_IMG_DETAIL_${reason}`)
      assert.equal(activity.title.text, "测试活动")
      assert.deepEqual(
        source.nodes.map((node) => node.nodeId),
        ["ROOT1", "LEAF1"]
      )
      assert.equal(source.nodes[1]!.referenceTreeId, "TREE2")
    })
})

test("IMG reference response scope, permission and layout failures retain honest partial results", async () => {
  const rows = dataset()
  rows.TNODE01![1]!.REFNODE_ID = "TARGET2"
  rows.TNODE01![1]!.REFTREE_ID = "TREE2"
  rows.TNODE02!.push({ ...rows.TNODE02![0]!, NODE_ID: "TARGET2" })
  for (const fault of ["wrong_tree", "denied"] as const) {
    const result = await run(rows, "ZH", undefined, undefined, async (sql, limit) => {
      if (
        sql.includes("FROM TNODE02 WHERE TREE_ID = 'TREE2'") &&
        sql.includes("NODE_ID = 'TARGET2'")
      ) {
        if (fault === "denied") throw new Error("HTTP 403")
        return select(rows, sql, limit).map((row) => ({ ...row, TREE_ID: "WRONG" }))
      }
      return select(rows, sql, limit)
    })
    const activity = result.activities[0]!
    assert.equal(
      activity.path.variants[0]!.reason,
      fault === "denied"
        ? "CONFIGURATION_IMG_DETAIL_QUERY_FAILED"
        : "CONFIGURATION_IMG_DETAIL_RESPONSE_SCOPE_MISMATCH"
    )
    assert.equal(activity.title.status, "read")
    assert.equal(activity.path.variants[1]!.status, "read")
  }
  let definitions = 0
  const drift = await run(rows, "ZH", undefined, async (name) => ({
    ...(await definition(name)),
    fingerprint:
      name === "TNODE02" && ++definitions === 2
        ? "a".repeat(64)
        : (await definition(name)).fingerprint
  }))
  assert.ok("code" in drift)
  assert.equal(drift.code, "CONFIGURATION_IMG_DETAIL_LAYOUT_UNVERIFIED")
  assert.deepEqual(drift.activities, [])
})

test("IMG reference depth and shared read budget stop expansion after retaining source variants", async () => {
  const rows = dataset()
  rows.TNODE01![1]!.REFNODE_ID = "R0"
  rows.TNODE01![1]!.REFTREE_ID = "TREE1"
  for (let n = 0; n < 33; n++)
    rows.TNODE01!.push({
      ...rows.TNODE01![1]!,
      NODE_ID: `R${n}`,
      REFNODE_ID: `R${n + 1}`
    })
  const depth = (await run(rows)).activities[0]!.path.variants[0]!
  assert.equal(depth.reason, "CONFIGURATION_IMG_DETAIL_REFERENCE_DEPTH_LIMIT_EXCEEDED")
  assert.equal((depth.nodes[1]!.physicalReference as { targets: unknown[] }).targets.length, 32)
  const many = dataset()
  many.TNODE01![1]!.REFNODE_ID = "SAME"
  many.TNODE01![1]!.REFTREE_ID = "TREE3"
  for (let n = 3; n < 36; n++) {
    many.TTREE!.push({ ID: `TREE${n}`, EXT_KEY: "EXT", TYPE: "TYPE2", NODE_ID: "SAME" })
    many.TNODE02!.push({
      ...many.TNODE02![1]!,
      TREE_ID: `TREE${n}`,
      NODE_ID: "SAME",
      REFNODE_ID: "SAME",
      REFTREE_ID: `TREE${n + 1}`
    })
  }
  let reads = 0
  const budget = await run(many, "ZH", undefined, undefined, async (sql, limit) => {
    reads++
    return select(many, sql, limit)
  })
  assert.equal(reads, 96)
  const activity = budget.activities[0]!
  assert.equal(activity.title.status, "read")
  assert.equal(activity.path.variants[0]!.reason, "CONFIGURATION_IMG_DETAIL_READ_BUDGET_EXCEEDED")
  for (const variant of activity.path.variants) assert.equal(variant.nodes.length, 2)
  assert.equal(activity.path.variants[1]!.status, "read")
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
