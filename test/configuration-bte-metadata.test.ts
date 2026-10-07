import assert from "node:assert/strict"
import test from "node:test"
import type { SapBackend } from "../src/backend.js"
import type { inspectConfigurationBteRoute } from "../src/configuration-bte-route.js"
import {
  inspectConfigurationBteMetadata,
  configurationBteMetadataSchema
} from "../src/configuration-bte-metadata.js"
import {
  configurationBteMetadataApi as api,
  configurationBteMetadataLayouts as layouts,
  configurationBteMetadataPins as pins,
  configurationBteMetadataFieldContracts as contracts
} from "../src/configuration-bte-metadata-api.js"

function fixture() {
  const directory = {
    TABNAME: "TBE24",
    AREA: "BFTM",
    LISTE: "0090",
    DEVCLASS: "FIBF",
    TYPE: "1",
    DETAIL: "0000",
    GENDATE: "19970505",
    GENTIME: "142459"
  }
  const events = [{ TABNAME: "TBE24", EVENT: "02", FORMNAME: "CONTEXT_BUFFER_DELETE_CUS" }]
  const route = {
    connectionId: "w200",
    client: "200",
    status: "standard_product_maintenance_route_observed",
    fingerprint: "a".repeat(64),
    products: { complete: true },
    maintenance: { directory, events }
  }
  const rows = (name: keyof typeof layouts) =>
    Object.fromEntries(
      layouts[name].fields.map((f) => {
        const c = contracts[name][f as keyof (typeof contracts)[typeof name]] as {
          dataType: string
          length?: number
        }
        return [
          f,
          c.dataType === "INT4"
            ? "0"
            : c.dataType === "NUMC"
              ? "0".repeat(c.length!)
              : c.dataType === "DATS"
                ? "1997-05-05"
                : c.dataType === "TIMS"
                  ? "14:24:59"
                  : ""
        ]
      })
    )
  const header = {
    ...rows("VIMDESC"),
    VIEWNAME: "TBE24",
    MAINTVIEW: "TBE24",
    ...directory,
    BASTAB: "X",
    TEXTTAB: "TBE24T",
    TEXTTBEXST: "X",
    GENDATE: "1997-05-05",
    GENTIME: "14:24:59",
    FRM_AF_SAV: "CONTEXT_BUFFER_DELETE_CUS"
  }
  delete (header as Record<string, string>).TABNAME
  const output = {
    EV_CODE: "METADATA_READ_OK",
    EV_MESSAGE: "Read only",
    EV_READ_ONLY: "X",
    EV_FRESH: "",
    ET_HEADER: [header],
    ET_NAMTAB: [
      { ...rows("VIMNAMTAB"), VIEWFIELD: "PRDKT", BASTABNAME: "TBE24", BASTABFLD: "PRDKT" }
    ],
    ET_EVENTS: structuredClone(events)
  }
  const definition: Record<string, unknown> = {
    connectionId: "w200",
    ...api,
    remoteEnabled: true,
    updateTask: false,
    updateTaskMode: "",
    globalInterface: false,
    sourceFingerprint: pins.source,
    interfaceFingerprint: pins.interface
  }
  const calls = { native: 0, definitions: 0, routes: 0, layouts: 0 }
  const readers = {
    definition: async (name: string) => {
      calls.definitions++
      if (name === api.functionName) return structuredClone(definition)
      const p = pins.standard[name as keyof typeof pins.standard]
      return {
        connectionId: "w200",
        functionName: name,
        functionGroup: p.functionGroup,
        remoteEnabled: false,
        updateTask: false,
        updateTaskMode: "",
        sourceFingerprint: p.source,
        interfaceFingerprint: p.interface
      }
    },
    layout: async (name: keyof typeof layouts) => {
      calls.layouts++
      return {
        connectionId: "w200",
        objectName: name,
        objectKind: name === "TVIMF" ? "transparentTable" : "structure",
        fingerprint: layouts[name].fingerprint,
        definition: { fields: layouts[name].fields.map((name) => ({ name })) }
      }
    },
    route: async () => {
      calls.routes++
      return structuredClone(route) as unknown as Awaited<
        ReturnType<typeof inspectConfigurationBteRoute>
      >
    }
  }
  // The synthetic fixture exercises this tool's contract; SAP route reads have their own tests.
  const backend: Pick<SapBackend, "callRemoteFunction"> = {
    callRemoteFunction: async (id, r) => {
      calls.native++
      assert.equal(id, "w200")
      assert.equal(r.functionName, api.functionName)
      assert.deepEqual(r.inputParameters, { ET_HEADER: [], ET_NAMTAB: [], ET_EVENTS: [] })
      assert.equal(r.outputParameters.find((p) => p.name === "ET_HEADER")?.fields?.length, 92)
      return { functionName: r.functionName, outputs: structuredClone(output) }
    }
  }
  const run = () =>
    inspectConfigurationBteMetadata({ connectionId: "w200" }, "200", backend, readers)
  return { run, readers, backend, output, definition, route, calls }
}

test("one fixed native metadata call returns cached control blocks, never a write permit", async () => {
  const f = fixture(),
    r = await f.run()
  assert.equal(f.calls.native, 1)
  assert.equal(f.calls.routes, 2)
  assert.equal(r.readOnly, true)
  assert.equal(r.fresh, false)
  assert.equal(r.executable, false)
  assert.equal(r.writeAvailable, false)
  assert.equal(r.coverage.atomicSnapshot, false)
  assert.equal(r.native.ET_HEADER[0]!.FRM_AF_SAV, "CONTEXT_BUFFER_DELETE_CUS")
  assert.match(r.fingerprint, /^[a-f0-9]{64}$/)
})
test("client and strict schema reject arbitrary objects, actions and target systems before SAP", async () => {
  const f = fixture()
  for (const input of [
    { connectionId: "w300" },
    { connectionId: "w200", viewName: "TBE34" },
    { connectionId: "w200", save: true },
    { connectionId: "w200", productName: "ZDEMO" }
  ])
    assert.throws(() => configurationBteMetadataSchema.parse(input))
  await assert.rejects(
    inspectConfigurationBteMetadata({ connectionId: "w200" }, "300", f.backend, f.readers),
    /SCOPE_UNSUPPORTED/
  )
  assert.equal(f.calls.native, 0)
})
test("source, ABI and update-task drift block the call", async () => {
  for (const patch of [
    { sourceFingerprint: "b".repeat(64) },
    { interfaceFingerprint: "b".repeat(64) },
    { source: ["COMMIT WORK."] },
    { updateTask: true },
    { updateTaskMode: "1" },
    { exportParameters: [] }
  ]) {
    const f = fixture()
    Object.assign(f.definition, patch)
    await assert.rejects(f.run(), /API_UNVERIFIED/)
    assert.equal(f.calls.native, 0)
  }
})
test("standard dependency drift blocks the call", async () => {
  const f = fixture(),
    old = f.readers.definition
  f.readers.definition = async (n) => ({
    ...(await old(n)),
    ...(n === "VIEW_AUTHORITY_CHECK" ? { sourceFingerprint: "b".repeat(64) } : {})
  })
  await assert.rejects(f.run(), /STANDARD_API_UNVERIFIED/)
  assert.equal(f.calls.native, 0)
})
test("field layout drift blocks the call", async () => {
  const f = fixture(),
    old = f.readers.layout
  f.readers.layout = async (n) => ({ ...(await old(n)), definition: { fields: [] } })
  await assert.rejects(f.run(), /LAYOUT_UNVERIFIED/)
  assert.equal(f.calls.native, 0)
})
test("unconfirmed or truncated route blocks the call", async () => {
  for (const patch of [
    { status: "maintenance_route_unconfirmed" },
    { products: { complete: false } }
  ]) {
    const f = fixture()
    Object.assign(f.route, patch)
    await assert.rejects(f.run(), /ROUTE_UNVERIFIED/)
    assert.equal(f.calls.native, 0)
  }
})
test("native authority refusal and fault are never retried", async () => {
  const f = fixture()
  f.output.EV_CODE = "AUTHORIZATION_DENIED"
  await assert.rejects(f.run(), /AUTHORIZATION_DENIED/)
  assert.equal(f.calls.native, 1)
  const g = fixture()
  g.backend.callRemoteFunction = async (r) => {
    g.calls.native++
    return {
      functionName: r,
      outputs: {},
      fault: { code: "ERROR", name: "ERROR", message: "native fault" }
    }
  }
  await assert.rejects(g.run(), /NATIVE_FAULT/)
  assert.equal(g.calls.native, 1)
})
test("unexpected status and unsafe flags are refused", async () => {
  for (const patch of [{ EV_CODE: "WRITE_OK" }, { EV_FRESH: "X" }, { EV_READ_ONLY: "" }]) {
    const f = fixture()
    Object.assign(f.output, patch)
    await assert.rejects(f.run(), /RESPONSE_INVALID/)
    assert.equal(f.calls.native, 1)
  }
})
test("complete primitive payload rejects missing, foreign or invalid fields", async () => {
  for (const patch of [
    { KEYLEN: "2147483648" },
    { GENDATE: "invalid" },
    { LISTE: "XY" },
    { EXTRA: "value" }
  ]) {
    const f = fixture()
    Object.assign(f.output.ET_HEADER[0]!, patch)
    await assert.rejects(f.run(), /RESPONSE_INVALID/)
  }
  const f = fixture()
  delete (f.output.ET_HEADER[0]! as Record<string, string>).AREA
  await assert.rejects(f.run(), /RESPONSE_INVALID/)
})
test("header identity, generation and related text table must agree", async () => {
  for (const patch of [
    { VIEWNAME: "TBE34" },
    { TEXTTAB: "TBE34T" },
    { GENDATE: "1997-05-06" },
    { GENTIME: "14:24:58" },
    { AREA: "OTHER" }
  ]) {
    const f = fixture()
    Object.assign(f.output.ET_HEADER[0]!, patch)
    await assert.rejects(f.run(), /HEADER_MISMATCH/)
  }
})
test("native events must equal registered events", async () => {
  const f = fixture()
  f.output.ET_EVENTS[0]!.FORMNAME = "DIFFERENT"
  await assert.rejects(f.run(), /EVENT_MISMATCH/)
})
test("foreign, mislabelled or duplicate fields are refused", async () => {
  for (const patch of [{ BASTABNAME: "TBE34" }, { TEXTTABFLD: "X" }, { VIEWFIELD: "" }]) {
    const f = fixture()
    Object.assign(f.output.ET_NAMTAB[0]!, patch)
    await assert.rejects(f.run(), /FIELD_SCOPE_INVALID/)
  }
  const f = fixture()
  f.output.ET_NAMTAB.push({ ...f.output.ET_NAMTAB[0]! })
  await assert.rejects(f.run(), /DUPLICATE_FIELD/)
})
test("bounds reject excess rows", async () => {
  const f = fixture()
  f.output.ET_NAMTAB = Array.from({ length: 201 }, () => ({ ...f.output.ET_NAMTAB[0]! }))
  await assert.rejects(f.run(), /RESPONSE_INVALID/)
})
test("metadata changes after call are detected without replay", async () => {
  const f = fixture(),
    old = f.readers.definition
  f.readers.definition = async (n) => {
    const d = await old(n)
    return { ...d, ...(f.calls.native ? { sourceFingerprint: "b".repeat(64) } : {}) }
  }
  await assert.rejects(f.run(), /STANDARD_API_UNVERIFIED/)
  assert.equal(f.calls.native, 1)
})
test("route changes after call are detected without replay", async () => {
  const f = fixture(),
    old = f.readers.route
  f.readers.route = async () => {
    const r = await old()
    if (f.calls.native) r.fingerprint = "b".repeat(64)
    return r
  }
  await assert.rejects(f.run(), /READ_CHANGED/)
  assert.equal(f.calls.native, 1)
})
