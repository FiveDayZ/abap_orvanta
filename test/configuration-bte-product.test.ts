import assert from "node:assert/strict"
import test from "node:test"
import {
  previewConfigurationBteProduct,
  configurationBteProductApi,
  configurationBteProductDomains,
  configurationBteProductFields,
  configurationBteProductLayouts
} from "../src/configuration-bte-product.js"
import {
  NATIVE_PREVIEW_EMPTY_HTML,
  reviewedTableReaderDefinition
} from "../src/reviewed-table-reader.js"

function fixture() {
  const input = {
    connectionId: "w200",
    productName: "ZDEMO",
    active: true,
    maxAssignmentsPerKind: 3
  }
  const rows: Record<string, Record<string, string>[]> = {
    TBE24: [{ MANDT: "200", PRDKT: "ZDEMO", RFCDS: "", AKTIV: "" }],
    TBE34: [
      {
        MANDT: "200",
        EVENT: "00000900",
        PRDKT: "ZDEMO",
        LAND: "",
        APPLK: "",
        FUNCT: "Z_EVENT",
        MONIT: ""
      }
    ],
    TPS34: [
      {
        MANDT: "200",
        PROCS: "00001030",
        LAND: "",
        APPLK: "",
        FUNCT: "Z_PROCESS",
        PRDKT: "ZDEMO",
        MONIT: "X"
      }
    ]
  }
  const calls = { queries: 0, native: [] as string[], definitions: [] as string[] }
  const backend = {
    runQuery: async (_id: string, query: string) => {
      calls.queries++
      const name = /FROM (TBE24|TBE34|TPS34) WHERE/.exec(query)![1]!
      assert.match(query, /MANDT = '200' AND PRDKT = 'ZDEMO'$/)
      return structuredClone(rows[name]!)
    },
    callRemoteFunction: async (
      _id: string,
      request: { functionName: string; inputParameters: Record<string, unknown> }
    ) => {
      calls.native.push(request.functionName)
      assert.equal(request.functionName, "RFC_READ_TABLE")
      const name = request.inputParameters.QUERY_TABLE as keyof typeof configurationBteProductFields
      return {
        functionName: request.functionName,
        outputs: {
          FIELDS: configurationBteProductFields[name].map((FIELDNAME) => ({ FIELDNAME })),
          DATA: rows[name]!.map((row) => ({
            WA: configurationBteProductFields[name].map((key) => row[key]).join("|")
          }))
        }
      }
    }
  }
  const readers: Record<
    "table" | "domain" | "definition",
    (name: string) => Promise<Record<string, unknown>>
  > = {
    table: async (name: string) => ({
      connectionId: "w200",
      objectKind: "transparentTable",
      objectName: name,
      fingerprint:
        configurationBteProductLayouts[name as keyof typeof configurationBteProductLayouts],
      definition: {
        tableClass: "TRANSP",
        fields: configurationBteProductFields[
          name as keyof typeof configurationBteProductFields
        ].map((key) => ({
          name: key,
          key: (name === "TBE24"
            ? ["MANDT", "PRDKT"]
            : name === "TBE34"
              ? ["MANDT", "EVENT", "PRDKT", "LAND", "APPLK"]
              : ["MANDT", "PROCS", "LAND", "APPLK"]
          ).includes(key)
        }))
      }
    }),
    domain: async (name: string) => ({
      connectionId: "w200",
      objectKind: "domain",
      objectName: name,
      fingerprint:
        configurationBteProductDomains[name as keyof typeof configurationBteProductDomains]
    }),
    definition: async (name: string) => {
      calls.definitions.push(name)
      return name === "RFC_READ_TABLE"
        ? {
            functionName: name,
            remoteEnabled: true,
            updateTask: false,
            sourceFingerprint: reviewedTableReaderDefinition.shape.sourceFingerprint.value,
            interfaceFingerprint: reviewedTableReaderDefinition.shape.interfaceFingerprint.value
          }
        : {
            connectionId: "w200",
            functionName: name,
            functionGroup: "SVIM",
            remoteEnabled: false,
            updateTask: false,
            updateTaskMode: "",
            sourceFingerprint: configurationBteProductApi.source,
            interfaceFingerprint: configurationBteProductApi.interface
          }
    }
  }
  return {
    input,
    rows,
    calls,
    backend,
    readers,
    run: () => previewConfigurationBteProduct(input, "200", backend, readers)
  }
}

test("product preview includes both assignment kinds and changes only the activation flag", async () => {
  const f = fixture(),
    value = await f.run()
  assert.deepEqual(value.change.before, f.rows.TBE24![0])
  assert.deepEqual(value.change.after, { ...f.rows.TBE24![0], AKTIV: "X" })
  assert.deepEqual(value.assignments, { events: f.rows.TBE34, processes: f.rows.TPS34 })
  assert.equal(value.impact.assignmentCount, 2)
  assert.equal(value.impact.sharedProduct, true)
  assert.equal(value.executable, false)
  assert.equal(value.writeAvailable, false)
  assert.equal(value.standardApiCandidate.invoked, false)
  assert.equal(value.coverage.handlerInterfacesInspected, false)
  assert.equal(value.coverage.authorizedForWrite, false)
  assert.equal(f.calls.queries, 6)
  assert.deepEqual(f.calls.native, [])
  f.input.active = false
  const noOp = await f.run()
  assert.equal(noOp.change.noOp, true)
  assert.deepEqual(noOp.change.changedFields, [])
  assert.equal(noOp.fingerprint, value.fingerprint)
})

test("row order is immaterial but field drift between two reads is refused", async () => {
  const f = fixture()
  f.rows.TBE34!.push({ ...f.rows.TBE34![0]!, EVENT: "00001030" })
  const query = f.backend.runQuery
  f.backend.runQuery = async (id, q) => {
    const r = await query(id, q)
    return f.calls.queries > 3 ? r.reverse() : r
  }
  await f.run()
  const g = fixture(),
    read = g.backend.runQuery
  g.backend.runQuery = async (id, q) => {
    const r = await read(id, q)
    if (g.calls.queries === 6) r[0]!.MONIT = ""
    return r
  }
  await assert.rejects(g.run(), /BTE_PRODUCT_READ_CHANGED/)
})

test("truncation never produces a complete product impact claim", async () => {
  for (const table of ["TBE34", "TPS34"]) {
    const f = fixture()
    f.input.maxAssignmentsPerKind = 2
    f.rows[table]!.push({
      ...f.rows[table]![0]!,
      [table === "TBE34" ? "EVENT" : "PROCS"]: "00001040"
    })
    f.rows[table]!.push({
      ...f.rows[table]![0]!,
      [table === "TBE34" ? "EVENT" : "PROCS"]: "00001050"
    })
    await assert.rejects(f.run(), /BTE_PRODUCT_LIMIT_EXCEEDED/)
  }
})

test("process product is not part of its authoritative key", async () => {
  const f = fixture()
  f.rows.TPS34!.push({ ...f.rows.TPS34![0]!, FUNCT: "Z_DIFFERENT" })
  await assert.rejects(f.run(), /BTE_PRODUCT_DUPLICATE_KEY/)
})

test("scope, controls and customer namespace are rejected before SAP is touched", async () => {
  for (const patch of [
    { connectionId: "w300" },
    { productName: "SAP" },
    { productName: "ZTOOLONG9" },
    { save: true },
    { tableName: "T001" },
    { maxAssignmentsPerKind: 201 }
  ]) {
    const f = fixture()
    await assert.rejects(
      previewConfigurationBteProduct({ ...f.input, ...patch }, "200", f.backend, f.readers)
    )
    assert.equal(f.calls.queries, 0)
    assert.deepEqual(f.calls.definitions, [])
  }
  const f = fixture()
  await assert.rejects(
    previewConfigurationBteProduct(f.input, "300", f.backend, f.readers),
    /SCOPE_UNSUPPORTED/
  )
  assert.equal(f.calls.queries, 0)
})

test("unknown flags, wrong scope and missing products do not produce a candidate", async () => {
  for (const [mutate, code] of [
    [
      (f: ReturnType<typeof fixture>) => {
        f.rows.TBE24![0]!.AKTIV = "1"
      },
      "FLAG_INVALID"
    ],
    [
      (f: ReturnType<typeof fixture>) => {
        f.rows.TPS34![0]!.MANDT = "300"
      },
      "RESPONSE_SCOPE_MISMATCH"
    ],
    [
      (f: ReturnType<typeof fixture>) => {
        f.rows.TBE24 = []
      },
      "NOT_FOUND"
    ]
  ] as const) {
    const f = fixture()
    mutate(f)
    await assert.rejects(f.run(), new RegExp("BTE_PRODUCT_" + code))
  }
})

test("DDIC and API changes are refused, including drift after the first data pass", async () => {
  for (const field of ["table", "domain", "definition"] as const) {
    const f = fixture(),
      reader = f.readers[field]
    let count = 0
    f.readers[field] = async (name) => {
      const value = await reader(name)
      if (++count > (field === "table" ? 3 : field === "domain" ? 2 : 1))
        return { ...value, fingerprint: "0".repeat(64), sourceFingerprint: "0".repeat(64) }
      return value
    }
    await assert.rejects(
      f.run(),
      new RegExp(
        "BTE_PRODUCT_" +
          (field === "table" ? "LAYOUT" : field === "domain" ? "DOMAIN" : "API") +
          "_UNVERIFIED"
      )
    )
    assert.equal(f.calls.queries, 3)
  }
})

test("an expected fingerprint binds the entire product and both assignment sets", async () => {
  const f = fixture(),
    result = await f.run()
  await previewConfigurationBteProduct(
    { ...f.input, expectedFingerprint: result.fingerprint },
    "200",
    f.backend,
    f.readers
  )
  f.rows.TPS34![0]!.FUNCT = "Z_CHANGED"
  await assert.rejects(
    previewConfigurationBteProduct(
      { ...f.input, expectedFingerprint: result.fingerprint },
      "200",
      f.backend,
      f.readers
    ),
    /BTE_PRODUCT_VERSION_CONFLICT/
  )
})

test("native empty HTML may use only the pinned read RFC; no maintenance function is invoked", async () => {
  const f = fixture()
  f.backend.runQuery = async () => {
    throw Error(NATIVE_PREVIEW_EMPTY_HTML)
  }
  const result = await f.run()
  assert.equal(result.sources.length, 6)
  assert(result.sources.every((x) => x.method === "rfc_read_table"))
  assert.deepEqual(f.calls.native, Array(6).fill("RFC_READ_TABLE"))
  assert.equal(f.calls.definitions.filter((x) => x === "RFC_READ_TABLE").length, 1)
  const g = fixture()
  g.backend.runQuery = f.backend.runQuery
  const read = g.readers.definition
  g.readers.definition = async (name) =>
    name === "RFC_READ_TABLE"
      ? { ...(await read(name)), sourceFingerprint: "0".repeat(64) }
      : read(name)
  await assert.rejects(g.run(), /BTE_PRODUCT_FALLBACK_UNVERIFIED/)
  assert.deepEqual(g.calls.native, [])
})
