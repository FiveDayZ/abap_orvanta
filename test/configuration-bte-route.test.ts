import assert from "node:assert/strict"
import test from "node:test"
import {
  inspectConfigurationBteRoute,
  configurationBteRouteLayouts,
  resolveBteProductParameters
} from "../src/configuration-bte-route.js"
import { configurationBteProductApi } from "../src/configuration-bte-product.js"
import {
  NATIVE_PREVIEW_EMPTY_HTML,
  reviewedTableReaderDefinition
} from "../src/reviewed-table-reader.js"

function fixture() {
  const input = { connectionId: "w200", maxProducts: 2 }
  const rows: Record<string, Record<string, string>[]> = {
    TSTC: [{ TCODE: "BF24", PGMNA: "", DYPNO: "0000" }],
    TSTCP: [{ TCODE: "BF24", PARAM: "/*SM30 VIEWNAME=TBE24;UPDATE=X;" }],
    TVDIR: [
      Object.fromEntries(
        configurationBteRouteLayouts.TVDIR.fields.map((f) => [
          f,
          (
            {
              TABNAME: "TBE24",
              AREA: "BFTM",
              BASTAB: "X",
              NEWGENER: "",
              LISTE: "0090",
              TYPE: "1"
            } as Record<string, string>
          )[f] ?? ""
        ])
      )
    ],
    TVIMF: [{ TABNAME: "TBE24", EVENT: "01", FORMNAME: "CHECK_PRODUCT" }],
    TBE24: [
      { MANDT: "200", PRDKT: "ZDEMO", RFCDS: "", AKTIV: "" },
      { MANDT: "200", PRDKT: "OTHER", RFCDS: "", AKTIV: "X" }
    ]
  }
  const calls = { queries: [] as string[], native: [] as string[], metadata: 0 }
  const backend = {
    runQuery: async (_id: string, sql: string) => {
      assert.equal(_id, "w200")
      calls.queries.push(sql)
      const table = / FROM ([A-Z0-9_]+) WHERE /.exec(sql)![1]!
      assert.match(
        sql,
        table.startsWith("TSTC")
          ? /TCODE = 'BF24'$/
          : table === "TBE24"
            ? /MANDT = '200'$/
            : /TABNAME = 'TBE24'$/
      )
      return structuredClone(rows[table]!)
    },
    callRemoteFunction: async (
      _id: string,
      r: { functionName: string; inputParameters: Record<string, unknown> }
    ) => {
      calls.native.push(r.functionName)
      assert.equal(r.functionName, "RFC_READ_TABLE")
      const fields = (r.inputParameters.FIELDS as { FIELDNAME: string }[]).map((f) => f.FIELDNAME),
        name = r.inputParameters.QUERY_TABLE as string
      return {
        functionName: r.functionName,
        outputs: {
          FIELDS: fields.map((FIELDNAME) => ({ FIELDNAME })),
          DATA: rows[name]!.map((row) => ({ WA: fields.map((f) => row[f]).join("|") }))
        }
      }
    }
  }
  const readers: Record<
    "table" | "definition",
    (name: string) => Promise<Record<string, unknown>>
  > = {
    table: async (name) => {
      calls.metadata++
      const p = configurationBteRouteLayouts[name as keyof typeof configurationBteRouteLayouts]
      return {
        connectionId: "w200",
        objectName: name,
        objectKind: "transparentTable",
        fingerprint: p.fingerprint,
        definition: {
          tableClass: "TRANSP",
          fields: p.fields.map((name) => ({
            name,
            key: (p.keys as readonly string[]).includes(name)
          }))
        }
      }
    },
    definition: async (name) =>
      name === "RFC_READ_TABLE"
        ? Object.fromEntries(
            Object.entries(reviewedTableReaderDefinition.shape).map(([k, v]) => [
              k,
              (v as { value: unknown }).value
            ])
          )
        : {
            connectionId: "w200",
            functionName: configurationBteProductApi.functionName,
            functionGroup: configurationBteProductApi.functionGroup,
            sourceFingerprint: configurationBteProductApi.source,
            interfaceFingerprint: configurationBteProductApi.interface,
            remoteEnabled: false,
            updateTask: false
          }
  }
  const run = () => inspectConfigurationBteRoute(input, "200", backend, readers)
  return { input, rows, calls, backend, readers, run }
}

test("fixed product route exposes events and existing supported products without executing maintenance", async () => {
  const f = fixture(),
    r = await f.run()
  assert.equal(r.status, "standard_product_maintenance_route_observed")
  assert.equal(r.maintenance.generatedFunctionCandidate, "TABLEPROC_BFTM")
  assert.deepEqual(r.maintenance.events, f.rows.TVIMF)
  assert.deepEqual(r.products.supportedCustomerProducts, [f.rows.TBE24![0]])
  assert.equal(r.products.complete, true)
  assert.equal(r.products.returnedCount, 2)
  assert.equal(r.writeAvailable, false)
  assert.equal(r.executable, false)
  assert.equal(r.maintenance.controlBlocksInspected, false)
  assert.equal(r.maintenance.commitOwnershipVerified, false)
  assert.equal(r.coverage.atomicSnapshot, false)
  assert.equal(f.calls.queries.length, 10)
  assert.equal(f.calls.native.length, 0)
})
test("parameter route rejects duplicate, foreign and extra controls instead of guessing SM30", () => {
  assert.deepEqual(resolveBteProductParameters("/*SM30 VIEWNAME=TBE24;UPDATE=X;"), {
    transaction: "SM30",
    tableName: "TBE24",
    mode: "update"
  })
  for (const p of [
    "SM30 VIEWNAME=TBE24;UPDATE=X;",
    "/*SM30 VIEWNAME=TBE34;UPDATE=X;",
    "/*SM30 VIEWNAME=TBE24;UPDATE=X;UPDATE=X;",
    "/*SM30 VIEWNAME=TBE24;UPDATE=X;SAPCLIENT=300;",
    "/*SM31 VIEWNAME=TBE24;UPDATE=X;",
    "/*SM30 VIEWNAME=TBE24;SHOW=X;",
    "/*SM30 VIEWNAME=TBE24;UPDATE=X;BAD"
  ])
    assert.equal(resolveBteProductParameters(p), null)
})
test("missing or nonstandard parameters retain observations but do not confirm a write route", async () => {
  for (const p of ["", "/*SM30 VIEWNAME=TBE34;UPDATE=X;"]) {
    const f = fixture()
    f.rows.TSTCP = p ? [{ TCODE: "BF24", PARAM: p }] : []
    const r = await f.run()
    assert.equal(r.status, "maintenance_route_unconfirmed")
    assert.equal(r.maintenance.generatedFunctionCandidate, null)
    assert.equal(r.transaction.recognised, null)
    assert.equal(r.products.supportedCustomerProducts.length, 1)
  }
})
test("a different pool, stale generation or missing directory cannot reuse the BFTM candidate", async () => {
  for (const patch of [{ AREA: "OTHER" }, { NEWGENER: "X" }, { BASTAB: "" }]) {
    const f = fixture()
    Object.assign(f.rows.TVDIR![0]!, patch)
    assert.equal((await f.run()).status, "maintenance_route_unconfirmed")
  }
  const f = fixture()
  f.rows.TVDIR = []
  assert.equal((await f.run()).maintenance.generatedFunctionCandidate, null)
})
test("truncated product inventory is explicitly partial even if the metadata route agrees", async () => {
  const f = fixture()
  f.rows.TBE24!.push({ MANDT: "200", PRDKT: "ZTHIRD", RFCDS: "", AKTIV: "" })
  const r = await f.run()
  assert.equal(r.products.complete, false)
  assert.equal(r.coverage.allProducts, false)
  assert.equal(r.products.returnedCount, 2)
  assert.equal(r.products.supportedCustomerProducts.length, 1)
  assert(r.sources.some((x) => x.table === "TBE24" && x.status === "truncated"))
})
test("callback truncation, duplicate callback keys and wrong response scope are refused", async () => {
  const a = fixture()
  a.rows.TVIMF = Array.from({ length: 65 }, (_, i) => ({
    TABNAME: "TBE24",
    EVENT: String(i),
    FORMNAME: "CHECK"
  }))
  await assert.rejects(a.run(), /BTE_ROUTE_LIMIT_EXCEEDED/)
  const b = fixture()
  b.rows.TVIMF!.push({ ...b.rows.TVIMF![0]! })
  await assert.rejects(b.run(), /BTE_ROUTE_DUPLICATE_KEY/)
  const c = fixture()
  c.rows.TVDIR![0]!.TABNAME = "TBE34"
  await assert.rejects(c.run(), /BTE_ROUTE_RESPONSE_SCOPE_MISMATCH/)
})
test("malformed product scope, duplicate keys or flag values cannot become an inventory", async () => {
  for (const patch of [{ MANDT: "300" }, { AKTIV: "?" }, { PRDKT: "" }]) {
    const f = fixture()
    Object.assign(f.rows.TBE24![0]!, patch)
    await assert.rejects(f.run(), /BTE_ROUTE_(RESPONSE_SCOPE_MISMATCH|PRODUCT_INVALID)/)
  }
  const f = fixture()
  f.rows.TBE24!.push({ ...f.rows.TBE24![0]! })
  await assert.rejects(f.run(), /BTE_ROUTE_DUPLICATE_KEY/)
})
test("closing layout and API checks detect drift before publishing a route", async () => {
  const a = fixture(),
    base = a.readers.table
  a.readers.table = async (name) => {
    const r = await base(name)
    if (a.calls.metadata > 6) r.fingerprint = "f".repeat(64)
    return r
  }
  await assert.rejects(a.run(), /BTE_ROUTE_LAYOUT_UNVERIFIED/)
  const b = fixture(),
    api = b.readers.definition
  b.readers.definition = async (name) => ({ ...(await api(name)), remoteEnabled: true })
  await assert.rejects(b.run(), /BTE_ROUTE_API_UNVERIFIED/)
})
test("inventory or callback drift between reads prevents a stable fingerprint", async () => {
  const f = fixture(),
    query = f.backend.runQuery
  f.backend.runQuery = async (id, sql) => {
    if (f.calls.queries.length === 9) f.rows.TBE24![0]!.AKTIV = "X"
    return query(id, sql)
  }
  await assert.rejects(f.run(), /BTE_ROUTE_READ_CHANGED/)
})
test("public controls and cross-client scope are rejected before any query", async () => {
  const f = fixture()
  for (const patch of [
    { connectionId: "w300" },
    { maxProducts: 1 },
    { maxProducts: 201 },
    { tableName: "TSTCP" },
    { transactionCode: "SM30" },
    { save: true }
  ])
    await assert.rejects(
      inspectConfigurationBteRoute({ ...f.input, ...patch }, "200", f.backend, f.readers)
    )
  await assert.rejects(
    inspectConfigurationBteRoute(f.input, "300", f.backend, f.readers),
    /BTE_ROUTE_SCOPE_UNSUPPORTED/
  )
  assert.equal(f.calls.metadata, 0)
  assert.equal(f.calls.queries.length, 0)
})
test("reviewed read RFC is the only fallback and cannot invoke the maintenance candidate", async () => {
  const f = fixture()
  f.backend.runQuery = async () => {
    throw Error(NATIVE_PREVIEW_EMPTY_HTML)
  }
  const r = await f.run()
  assert.equal(r.status, "standard_product_maintenance_route_observed")
  assert.equal(f.calls.native.length, 10)
  assert(f.calls.native.every((n) => n === "RFC_READ_TABLE"))
  assert(r.sources.every((s) => s.method === "rfc_read_table"))
})
