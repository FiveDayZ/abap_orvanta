import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import {
  configurationBcCtsApi as api,
  configurationBcCtsDependencies as dependencies,
  configurationBcCtsLayouts as layouts
} from "../src/configuration-bc-cts-api.js"
import { readConfigurationBcCts } from "../src/configuration-bc-cts.js"
import { TOOL_NAMES } from "../src/tool-registry.js"
import { ctsFixture as fixture } from "./configuration-bc-cts-fixture.js"

test("CTS adapter preserves exact bytes and rechecks API, tables and complete results", async () => {
  const f = fixture(),
    result = await f.run()
  assert.deepEqual(f.calls, { native: 2, definition: 14, table: 10 })
  assert.equal(result.counts.stringKeys, 1)
  assert.equal(result.buffer.data, f.native.EV_DATA_BASE64)
  assert.equal(
    Buffer.from(result.buffer.data, "base64").subarray(6, 120).toString(),
    " ".repeat(114)
  )
  assert.equal(result.executable, false)
  assert.equal(result.snapshot, false)
  assert.equal(result.recoveryAvailable, false)
  assert.equal(result.buffer.recoveryPermit, false)
  assert.ok(TOOL_NAMES.includes("read_configuration_bc_cts_snapshot"))
})

for (const [field, value] of [
  ["connectionId", "w300"],
  ["requestNumber", "GR2K923472"],
  ["taskNumber", "GR2K923429"],
  ["bcSetId", "OTHER"],
  ["version", "M"],
  ["save", true]
] as const)
  test(`CTS scope refuses ${field} before native or metadata dispatch`, async () => {
    const f = fixture()
    await assert.rejects(
      readConfigurationBcCts({ ...f.input, [field]: value }, "200", "wys", f.backend, f.readers)
    )
    assert.deepEqual(f.calls, { native: 0, definition: 0, table: 0 })
  })

for (const [field, value] of [
  ["EV_DATA_BASE64", "%%%"],
  ["EV_DATA_BASE64", "YWJj\n"],
  ["EV_DATA_BYTES", "1"],
  ["EV_DATA_BYTES", "0"],
  ["EV_CTS_VERSION", "c".repeat(64)],
  ["EV_USER", "OTHER"],
  ["EV_TASK", "GR2K923431"],
  ["EV_KEY_COUNT", "257"],
  ["EV_KEY_COUNT", "01"],
  ["EV_CLIENT", "300"],
  ["EV_SYSTEM", "GR3"]
] as const)
  test(`CTS response refuses invalid ${field} without returning a buffer or retrying`, async () => {
    const f = fixture()
    f.native[field] = value
    await assert.rejects(f.run())
    assert.equal(f.calls.native, 1)
  })

for (const code of ["AUTHORIZATION_DENIED", "READ_CHANGED", "HEADER_SCOPE_INVALID", "unknown"])
  test(`CTS native ${code} retracts the result with no fallback`, async () => {
    const f = fixture()
    f.native.EV_CODE = code
    await assert.rejects(f.run(), new RegExp(code === "unknown" ? "INVALID_RESPONSE" : code))
    assert.equal(f.calls.native, 1)
  })

test("CTS complete-result drift includes changed counts even when the buffer is unchanged", async () => {
  const f = fixture(),
    remote = f.backend.callRemoteFunction
  f.backend.callRemoteFunction = async (connection, request) => {
    const response = await remote(connection, request)
    if (f.calls.native === 2) response.outputs.EV_STRING_KEY_COUNT = "0"
    return response
  }
  await assert.rejects(f.run(), /READ_CHANGED/)
})

test("changed bridge body and table/dependency identities prevent all native dispatch", async () => {
  for (const drift of ["body", "table", "dependency"]) {
    const f = fixture()
    if (drift === "body") f.definition.source.splice(2, 0, "COMMIT WORK.")
    else if (drift === "table")
      f.readers.table = async (name) => ({
        connectionId: "w200",
        objectName: name,
        objectKind: "transparentTable",
        fingerprint: "c".repeat(64)
      })
    else {
      const read = f.readers.definition
      f.readers.definition = async (name) => {
        const v = await read(name)
        return { ...v, sourceFingerprint: "c".repeat(64) }
      }
    }
    await assert.rejects(f.run())
    assert.equal(f.calls.native, 0)
  }
})

test("closing dependency failure retracts the opaque buffer after native reads", async () => {
  const f = fixture(),
    read = f.readers.definition
  f.readers.definition = async (name) => {
    if (f.calls.native === 2) throw Error("closing unavailable")
    return read(name)
  }
  await assert.rejects(f.run(), /closing unavailable/)
  assert.equal(f.calls.native, 2)
})

test("CTS deployment candidate has no mutation or dialog/session APIs and includes all raw key tables", () => {
  assert.ok(
    api.source.every((line) => line.length <= 72),
    "RPY insert uses RSSOURCE CHAR72"
  )
  const source = api.source.filter((line) => !line.startsWith('"')).join("\n")
  assert.doesNotMatch(
    source,
    /\b(COMMIT|ROLLBACK|ENQUEUE|DEQUEUE|CALL TRANSACTION|SUBMIT|DELETE FROM|UPDATE|MODIFY|INSERT)\b/i
  )
  assert.match(source, /TR_READ_REQUEST/)
  assert.match(source, /ls_request-keys_str/)
  assert.match(source, /extended_state/)
  assert.match(source, /TO DATA BUFFER/)
  assert.match(source, /lv_first <> lv_buffer/)
  assert.doesNotMatch(source, /\b(VALUE|NEW|COND|SWITCH|REDUCE|FILTER)\s*[#(]|@[a-z]|DATA\(/i)
})

test("CTS dependency pins match actual SAP interfaces rather than aggregate definition hashes", () => {
  const actual = JSON.parse(
    readFileSync(
      new URL(
        "../../docs/workspace-evidence/.doc/orvanta-configuration-bc-cts-standard-source-20261005-r51.json",
        import.meta.url
      ),
      "utf8"
    )
  )
  const calls = [
    ...actual.observations.standardCts.calls,
    ...actual.observations.dependencies.calls
  ]
  for (const [name, pin] of Object.entries(dependencies)) {
    // Hash helper identity was already attested by the r50 live native reader.
    if (name === "CALCULATE_HASH_FOR_RAW") continue
    const v = calls.find(
      (c: { functionName?: string; arguments?: { functionName?: string }; isError: boolean }) =>
        !c.isError && (c.functionName === name || c.arguments?.functionName === name)
    )?.data
    assert.ok(v, name)
    assert.equal(pin.source, v.sourceFingerprint, name)
    assert.equal(pin.interface, v.interfaceFingerprint, name)
    assert.equal(pin.remoteEnabled, v.remoteEnabled, name)
  }
  for (const [name, pin] of Object.entries(layouts)) {
    const v = actual.observations.types.calls.find(
      (c: { name: string; arguments: { objectName: string }; isError: boolean }) =>
        !c.isError && c.name === "read_ddic_transparent_table" && c.arguments.objectName === name
    )?.data
    assert.ok(v, name)
    assert.equal(pin, v.fingerprint, name)
  }
})
