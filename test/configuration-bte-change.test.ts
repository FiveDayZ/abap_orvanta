import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import {
  prepareConfigurationBteProductChange,
  configurationBteProtectionLayouts as layouts
} from "../src/configuration-bte-change.js"
import type { previewConfigurationBteProduct } from "../src/configuration-bte-product.js"
import type { inspectConfigurationBteMetadata } from "../src/configuration-bte-metadata.js"
import {
  NATIVE_PREVIEW_EMPTY_HTML,
  reviewedTableReaderDefinition
} from "../src/reviewed-table-reader.js"

const observed = JSON.parse(
  readFileSync(new URL("./fixtures/configuration-bte-vim-w200-r76.json", import.meta.url), "utf8")
)
const closure = JSON.parse(
  readFileSync(
    new URL("./fixtures/configuration-bte-save-closure-w200-r77.json", import.meta.url),
    "utf8"
  )
)
Object.assign(observed.definitions, closure.definitions)

function fixture() {
  const input = { connectionId: "w200", productName: "ZDEMO", active: false }
  const product = { MANDT: "200", PRDKT: "ZDEMO", RFCDS: "", AKTIV: "X" }
  const preview = {
    connectionId: "w200",
    client: "200",
    productName: "ZDEMO",
    executable: false,
    writeAvailable: false,
    fingerprint: "1".repeat(64),
    coverage: { completeWithinBound: true },
    change: {
      tableName: "TBE24",
      key: { MANDT: "200", PRDKT: "ZDEMO" },
      before: product,
      after: { ...product, AKTIV: "" },
      changedFields: ["AKTIV"],
      noOp: false
    },
    assignments: { events: [], processes: [] }
  } as unknown as Awaited<ReturnType<typeof previewConfigurationBteProduct>>
  const metadata = {
    connectionId: "w200",
    client: "200",
    status: "native_metadata_read",
    readOnly: true,
    executable: false,
    writeAvailable: false,
    fresh: false,
    fingerprint: "2".repeat(64),
    native: structuredClone(observed.metadata)
  } as unknown as Awaited<ReturnType<typeof inspectConfigurationBteMetadata>>
  const rows: Record<string, Record<string, string>[]> = {
    E070: [
      {
        TRKORR: "GR2K923430",
        STRKORR: "GR2K923429",
        TRFUNCTION: "Q",
        TRSTATUS: "D",
        KORRDEV: "CUST",
        AS4USER: "WYS",
        TARSYSTEM: "",
        AS4DATE: "20261007",
        AS4TIME: "080000"
      }
    ],
    TBE24T: [
      { MANDT: "200", SPRAS: "1", PRDKT: "ZDEMO", TXT50: "示例" },
      { MANDT: "200", SPRAS: "E", PRDKT: "ZDEMO", TXT50: "Example" }
    ],
    TCONT: [{ FRMID: "CP_INFO", DATUM: "20261007", UZEIT: "080000" }]
  }
  const calls = { metadata: 0, preview: 0, query: 0, remote: 0 }
  const backend = {
    runQuery: async (_id: string, query: string) => {
      calls.query++
      const name = /FROM (TBE24T|TCONT|E070) WHERE/.exec(query)![1]!
      assert.equal(query.includes("SPRAS ="), false)
      return structuredClone(rows[name]!)
    },
    callRemoteFunction: async (
      _id: string,
      r: { functionName: string; inputParameters: Record<string, unknown> }
    ) => {
      calls.remote++
      assert.equal(r.functionName, "RFC_READ_TABLE")
      const name = r.inputParameters.QUERY_TABLE as keyof typeof layouts
      return {
        outputs: {
          FIELDS: layouts[name].fields.map((FIELDNAME) => ({ FIELDNAME })),
          DATA: rows[name]!.map((r) => ({ WA: layouts[name].fields.map((f) => r[f]).join("|") }))
        }
      }
    }
  }
  const readers = {
    username: "wys",
    transport: async (pair: { requestNumber: string; taskNumber: string }): Promise<unknown> => ({
      connectionId: "w200",
      client: "200",
      ...pair,
      status: "metadata_matches",
      readOnly: true,
      saveAvailable: false,
      readFingerprint: "3".repeat(64),
      observed: { task: [rows.E070![0]] },
      checks: Object.fromEntries(
        [
          "requestType",
          "taskType",
          "requestOpen",
          "taskOpen",
          "requestIsRoot",
          "taskParent",
          "taskOwnerMatchesConfiguredUser",
          "requestClient",
          "taskClient",
          "requestCategory",
          "taskCategory",
          "transportTarget"
        ].map((k) => [k, true])
      )
    }),
    include: async (name: string) => structuredClone(closure.includes[name]),
    preview: async () => {
      calls.preview++
      return structuredClone(preview)
    },
    metadata: async () => {
      calls.metadata++
      return structuredClone(metadata)
    },
    table: async (name: string) => {
      if (name === "E070")
        return {
          connectionId: "w200",
          objectKind: "transparentTable",
          objectName: name,
          fingerprint: "8a8e77c5943147bdb77fb9d10afc803e0e3a9e8a2a44f8178defca38c48449f1"
        }
      const pin = layouts[name as keyof typeof layouts]
      return {
        connectionId: "w200",
        objectKind: "transparentTable",
        objectName: name,
        fingerprint: pin.fingerprint,
        definition: {
          tableClass: "TRANSP",
          fields: pin.fields.map((name) => ({
            name,
            key: (pin.keys as readonly string[]).includes(name)
          }))
        }
      }
    },
    definition: async (name: string) =>
      name === "RFC_READ_TABLE"
        ? {
            functionName: "RFC_READ_TABLE",
            remoteEnabled: true,
            updateTask: false,
            sourceFingerprint: reviewedTableReaderDefinition.shape.sourceFingerprint.value,
            interfaceFingerprint: reviewedTableReaderDefinition.shape.interfaceFingerprint.value
          }
        : structuredClone(observed.definitions[name])
  }
  const run = (raw: unknown = input, client = "200") =>
    prepareConfigurationBteProductChange(raw, client, backend, readers)
  return { input, preview, metadata, rows, calls, backend, readers, run }
}

test("preparation protects all languages and both assignment kinds, records shared cache and exact recovery", async () => {
  const f = fixture(),
    r = await f.run()
  assert.deepEqual(r.preserved.languageTexts, f.rows.TBE24T)
  assert.deepEqual(r.recovery.restore, f.preview.change.before)
  assert.deepEqual(r.recovery.requireCurrent, f.preview.change.after)
  assert.equal(r.expectedEffects.timestampMayChange, true)
  assert.equal(r.recovery.restoreCacheTimestamp, false)
  assert.equal(r.recovery.retryAfterUnknownOutcome, false)
  assert.equal(r.executable, false)
  assert.equal(r.writeAvailable, false)
  assert.equal(r.coverage.atomicSnapshot, false)
  assert.equal(r.coverage.ctsInspected, false)
  assert.equal(f.calls.metadata, 1)
  assert.equal(f.calls.preview, 2)
  assert.equal(f.calls.query, 4)
  assert.equal(f.calls.remote, 0)
  assert.equal(r.nativeSavePreparation.containers.languageCandidates.length, 2)
  assert.equal(r.nativeSavePreparation.containers.nativeSerializationVerified, false)
  assert.equal(Object.keys(r.nativeSavePreparation.standardApis).length, 13)
  assert.equal(Object.keys(r.nativeSavePreparation.standardIncludes).length, 4)
  assert.equal(
    (await f.run({ ...f.input, expectedFingerprint: r.fingerprint })).fingerprint,
    r.fingerprint
  )
})
test("scope and strict command-shaped input refuse before SAP", async () => {
  for (const raw of [
    { ...fixture().input, save: true },
    { ...fixture().input, connectionId: "w300" },
    { ...fixture().input, productName: "SAP" },
    { ...fixture().input, transportNumber: "GR2K923430" }
  ]) {
    const f = fixture()
    await assert.rejects(f.run(raw))
    assert.equal(f.calls.preview, 0)
    assert.equal(f.calls.metadata, 0)
    assert.equal(f.calls.query, 0)
  }
  const f = fixture()
  await assert.rejects(f.run(f.input, "300"), /SCOPE/)
  assert.equal(f.calls.preview, 0)
})
test("failed or duplicate language read never becomes an empty protection set", async () => {
  for (const mode of ["unavailable", "duplicate", "scope", "text"]) {
    const f = fixture()
    if (mode === "unavailable")
      f.backend.runQuery = async () => {
        throw Error("offline")
      }
    if (mode === "duplicate") f.rows.TBE24T!.push({ ...f.rows.TBE24T![0]! })
    if (mode === "scope") f.rows.TBE24T![0]!.MANDT = "300"
    if (mode === "text") f.rows.TBE24T![0]!.TXT50 = "x".repeat(51)
    await assert.rejects(f.run())
    assert.equal(f.calls.metadata, 0)
  }
})
test("complete empty texts/cache are allowed and truncation is refused", async () => {
  const empty = fixture()
  empty.rows.TBE24T = []
  empty.rows.TCONT = []
  assert.deepEqual((await empty.run()).cacheBefore, [])
  const f = fixture()
  f.rows.TBE24T = Array.from({ length: 201 }, (_, i) => ({
    MANDT: "200",
    PRDKT: "ZDEMO",
    SPRAS: String.fromCharCode(0x0100 + i),
    TXT50: ""
  }))
  await assert.rejects(f.run(), /READ_INCOMPLETE/)
  assert.equal(f.calls.metadata, 0)
})
test("text, cache and assignment changes during metadata are refused", async () => {
  for (const mode of ["text", "cache", "assignment"]) {
    const f = fixture(),
      read = f.readers.metadata
    f.readers.metadata = async () => {
      if (mode === "text") f.rows.TBE24T![0]!.TXT50 = "Changed"
      if (mode === "cache") f.rows.TCONT![0]!.UZEIT = "080001"
      if (mode === "assignment")
        f.preview.assignments.events!.push({
          MANDT: "200",
          EVENT: "00001025",
          PRDKT: "ZDEMO",
          LAND: "",
          APPLK: "",
          FUNCT: "Z_EVENT",
          MONIT: ""
        })
      return read()
    }
    await assert.rejects(f.run(), /READ_CHANGED/)
    assert.equal(f.calls.metadata, 1)
  }
})
test("native failures, callbacks and write claims refuse without replay", async () => {
  for (const mode of ["failure", "callback", "grant"]) {
    const f = fixture()
    if (mode === "failure")
      f.readers.metadata = async () => {
        f.calls.metadata++
        throw Error("native failure")
      }
    if (mode === "callback") f.metadata.native.ET_HEADER[0]!.FRM_AF_SAV = "OTHER"
    if (mode === "grant")
      (f.metadata as unknown as { writeAvailable: boolean }).writeAvailable = true
    await assert.rejects(f.run())
    assert.equal(f.calls.metadata, 1)
  }
})
test("stale bundle fingerprint and unchanged flag do not grant execution", async () => {
  const f = fixture()
  await assert.rejects(
    f.run({ ...f.input, expectedFingerprint: "0".repeat(64) }),
    /VERSION_CONFLICT/
  )
  f.preview.change.after = { ...f.preview.change.before, AKTIV: "X" }
  f.preview.change.noOp = true
  f.preview.change.changedFields = []
  const r = await f.run()
  assert.equal(r.expectedEffects.timestampMayChange, false)
  assert.equal(r.executable, false)
  assert.equal(r.nativeSavePreparation.containers.rowAction, " ")
})
test("invalid native SQL uses the reviewed RFC reader with the same complete protections", async () => {
  const f = fixture()
  f.backend.runQuery = async () => {
    throw Error(NATIVE_PREVIEW_EMPTY_HTML)
  }
  const r = await f.run()
  assert.equal(r.preserved.languageTexts.length, 2)
  assert.equal(f.calls.remote, 4)
})

test("standard SAVE version rejection happens before the budgeted native metadata read", async () => {
  const f = fixture(),
    read = f.readers.definition
  f.readers.definition = async (name) => ({
    ...(await read(name)),
    sourceFingerprint: "0".repeat(64)
  })
  await assert.rejects(f.run(), /BTE_SAVE_PLAN_API_UNVERIFIED/)
  assert.equal(f.calls.metadata, 0)
})

test("container preparation rejects RFCDS patches and callback additions without enabling writes", async () => {
  const f = fixture()
  Object.assign(f.preview.change.after, { RFCDS: "OTHER" })
  await assert.rejects(f.run(), /FIELD_CHANGE_UNSUPPORTED/)
  assert.equal(f.calls.metadata, 1)
  const g = fixture()
  g.metadata.native.ET_EVENTS.push({ TABNAME: "TBE24", EVENT: "01", FORMNAME: "NEW_CALLBACK" })
  await assert.rejects(g.run(), /LAYOUT_UNSUPPORTED/)
  assert.equal(g.calls.metadata, 1)
})

test("reached source drift rejects before metadata, and second-read drift refuses a prepared bundle", async () => {
  for (const phase of ["before", "after"]) {
    const f = fixture(),
      read = f.readers.include
    let reads = 0
    f.readers.include = async (name: string) => {
      reads++
      const source = await read(name)
      if (name === "LSTRDF50" && (phase === "before" || reads > 4)) source.source += "\r\n* Changed"
      return source
    }
    await assert.rejects(f.run(), /SOURCE_UNVERIFIED/)
    assert.equal(f.calls.metadata, phase === "before" ? 0 : 1)
    assert.equal(reads, phase === "before" ? 4 : 8)
  }
  const f = fixture(),
    read = f.readers.definition
  let calls = 0
  f.readers.definition = async (name) => {
    calls++
    const source = await read(name)
    if (name === "TRINT_OBJECTS_CHECK_AND_INSERT" && calls > 13)
      source.interfaceFingerprint = "0".repeat(64)
    return source
  }
  await assert.rejects(f.run(), /API_UNVERIFIED/)
  assert.equal(f.calls.metadata, 1)
})

test("explicit transport participates in the fingerprint and ambiguous tasks consume no metadata call", async () => {
  const f = fixture()
  const pair = { requestNumber: "GR2K923429", taskNumber: "GR2K923430" }
  const without = await f.run()
  const withTransport = await f.run({ ...f.input, transport: pair })
  assert.notEqual(without.fingerprint, withTransport.fingerprint)
  assert.equal(withTransport.coverage.ctsInspected, true)
  assert.equal(withTransport.coverage.ctsRecordingInspected, false)
  assert.equal(withTransport.transportReview.status, "unique_existing_task_observed")
  assert.equal(withTransport.transportEvidence?.before.sources[0]?.table, "E070")
  assert.equal(withTransport.transportEvidence?.after.sources[0]?.status, "ok")
  assert.equal(without.transportEvidence, null)
  assert.equal(withTransport.writeAvailable, false)
  assert.equal(
    (await f.run({ ...f.input, transport: pair, expectedFingerprint: withTransport.fingerprint }))
      .fingerprint,
    withTransport.fingerprint
  )
  const ambiguous = fixture()
  ambiguous.rows.E070!.push({ ...ambiguous.rows.E070![0]!, TRKORR: "GR2K923431" })
  await assert.rejects(
    ambiguous.run({ ...ambiguous.input, transport: pair }),
    /TASK_SELECTION_AMBIGUOUS/
  )
  assert.equal(ambiguous.calls.metadata, 0)
  assert.equal(ambiguous.calls.preview, 0)
})

test("task inventory, headers or selected task changes during metadata reject without replay", async () => {
  const pair = { requestNumber: "GR2K923429", taskNumber: "GR2K923430" }
  for (const change of ["inventory", "row", "headers"]) {
    const f = fixture(),
      read = f.readers.metadata
    f.readers.metadata = async () => {
      if (change === "inventory") f.rows.E070!.push({ ...f.rows.E070![0]!, TRKORR: "GR2K923431" })
      if (change === "row") f.rows.E070![0]!.AS4TIME = "080001"
      if (change === "headers") {
        const previous = f.readers.transport
        f.readers.transport = async (pair) => ({
          ...((await previous(pair)) as object),
          readFingerprint: "4".repeat(64)
        })
      }
      return read()
    }
    await assert.rejects(
      f.run({ ...f.input, transport: pair }),
      change === "inventory" ? /TASK_SELECTION_AMBIGUOUS/ : /READ_CHANGED/
    )
    assert.equal(f.calls.metadata, 1)
  }
})
