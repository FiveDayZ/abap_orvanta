import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createMcpServer } from "../src/mcp.js"
import { ToolService } from "../src/tools.js"
import { InvocationReceiptStore } from "../src/invocation-receipts.js"
import { WriteOperationReceiptStore } from "../src/write-operation-receipts.js"
import { configurationNumberRangeReadApi as reader } from "../src/configuration-number-range-api.js"
import { configurationNumberRangeCommandDependencies as dependencies } from "../src/configuration-number-range-command.js"
import { configurationNumberRangeNativeTables as layouts } from "../src/configuration-number-range-native.js"
import {
  numberRangeScopeFunctions,
  numberRangeScopeIncludes
} from "../src/configuration-number-range-scope.js"
import { numberRangePreviewDomains } from "../src/configuration-number-range-preview.js"
import { MockBackend } from "./mock-backend.js"

const version = "a".repeat(64)
const selection = {
  connectionId: "w200",
  objectName: "ZORVCFGNR",
  subobject: "",
  year: "0000",
  intervalNumber: "02",
  maxIntervals: 100
}
const scopeSelection = {
  connectionId: "w200",
  objectName: "ZORVCFGNR",
  subobject: "",
  maxIntervals: 100
}
const row = (overrides = {}): Record<string, string> => ({
  CLIENT: "200",
  OBJECT: "ZORVCFGNR",
  SUBOBJECT: "",
  NRRANGENR: "02",
  TOYEAR: "0000",
  FROMNUMBER: "00000000000000000101",
  TONUMBER: "00000000000000000200",
  NRLEVEL: "00000000000000000000",
  EXTERNIND: "",
  ...overrides
})

async function fixture(t: TestContext, separateNumberState = false) {
  const root = await mkdtemp(join(tmpdir(), "orvanta-number-range-flow-"))
  const numberStateRoot = separateNumberState ? join(root, "number-state") : root
  const backend = new MockBackend()
  const state = {
    objectName: "ZORVCFGNR",
    rows: [
      row({
        NRRANGENR: "01",
        FROMNUMBER: "00000000000000000001",
        TONUMBER: "00000000000000000100"
      }),
      row()
    ],
    missingObject: false,
    unavailable: false,
    valueDrift: false,
    definitionDrift: false,
    layoutDrift: false,
    sourceDrift: false,
    missingApi: false,
    fault: false,
    code: "READ_OK",
    nativeVersion: version,
    queries: 0,
    nativeReads: 0,
    metadata: 0,
    definitions: 0
  }
  const properties: Record<string, string> = Object.fromEntries(
    layouts.TNRO.fields.map((name) => [name, ""])
  )
  Object.assign(properties, { OBJECT: state.objectName, DOMLEN: "NUMC20", NOIVBUFFER: "00000000" })
  const original = {
    object: ToolService.prototype.readNumberRangeObject,
    fn: ToolService.prototype.readFunctionModuleInterface,
    table: ToolService.prototype.readDdicTransparentTable,
    domain: ToolService.prototype.readDdicDomain,
    lines: ToolService.prototype.getObjectLines
  }
  ToolService.prototype.readNumberRangeObject = async () => {
    state.metadata++
    state.definitions++
    return JSON.stringify(
      state.missingObject
        ? {
            connectionId: "w200",
            objectName: state.objectName,
            objectType: "numberRangeObject",
            status: "not-found",
            exists: false,
            authoritative: true,
            readOnly: true
          }
        : {
            connectionId: "w200",
            objectKind: "numberRangeObject",
            objectName: state.objectName,
            version: "c".repeat(40),
            fingerprint:
              state.definitionDrift && state.definitions % 2 === 0 ? "d".repeat(64) : version,
            definition: { properties }
          }
    )
  }
  ToolService.prototype.readDdicTransparentTable = async ({ objectName }) => {
    state.metadata++
    const layout = layouts[objectName as keyof typeof layouts]
    assert.ok(layout, "Only TNRO/NRIV metadata is expected")
    return JSON.stringify({
      connectionId: "w200",
      objectName,
      objectKind: "transparentTable",
      fingerprint: state.layoutDrift ? version : layout.fingerprint,
      definition: { fields: layout.fields.map((name) => ({ name })) }
    })
  }
  ToolService.prototype.readFunctionModuleInterface = async ({ functionName }) => {
    state.metadata++
    if (functionName === reader.functionName) {
      if (state.missingApi) throw Error("OFFLINE_READER_MISSING")
      return JSON.stringify({
        ...reader,
        connectionId: "w200",
        updateTask: false,
        updateTaskMode: "",
        changingParameters: [],
        exceptions: [],
        sourceFingerprint: version,
        interfaceFingerprint: version,
        source:
          state.sourceDrift && state.nativeReads
            ? ["FUNCTION Z_ORVANTA_CFG_NR_READ.", "ENDFUNCTION."]
            : [`FUNCTION ${reader.functionName}.`, ...reader.source.split("\n"), "ENDFUNCTION."]
      })
    }
    const pin =
      numberRangeScopeFunctions[functionName as keyof typeof numberRangeScopeFunctions] ??
      dependencies[functionName as keyof typeof dependencies]
    assert.ok(pin, `Unexpected metadata: ${functionName}`)
    return JSON.stringify({
      functionName,
      remoteEnabled: false,
      updateTask: false,
      ...pin
    })
  }
  ToolService.prototype.readDdicDomain = async ({ objectName }) => {
    state.metadata++
    const pin = numberRangePreviewDomains[objectName as keyof typeof numberRangePreviewDomains]
    assert.ok(pin)
    return JSON.stringify({
      connectionId: "w200",
      objectName,
      objectKind: "domain",
      fingerprint: pin.fingerprint,
      definition: { dataType: pin.dataType, length: pin.length, decimals: 0, conversionExit: "" }
    })
  }
  ToolService.prototype.getObjectLines = async ({ objectName }) => {
    state.metadata++
    const pin = numberRangeScopeIncludes[objectName as keyof typeof numberRangeScopeIncludes]
    assert.ok(pin)
    return `Source from ${objectName} (lines 1-1 of 1, 1 lines retrieved):\nFull Source SHA-256: ${pin}\n/functions/groups/snr1/includes/${objectName.toLowerCase()}/source`
  }
  backend.runQuery = async (_connection, query) => {
    state.queries++
    assert.match(query, /FROM NRIV WHERE/)
    if (state.unavailable) throw Error("OFFLINE_READ_DENIED")
    return state.rows
      .filter((r) => !query.includes("NRRANGENR = '02'") || r.NRRANGENR === "02")
      .filter((r) => !query.includes("NRRANGENR = '01'") || r.NRRANGENR === "01")
      .map((r) => ({
        ...r,
        ...(state.valueDrift && state.queries % 2 === 0 ? { NRLEVEL: "00000000000000000001" } : {})
      }))
  }
  backend.callRemoteFunction = async (_connection, request) => {
    assert.equal(
      request.functionName,
      reader.functionName,
      "Writer/allocator/CTS must not dispatch"
    )
    state.nativeReads++
    assert.deepEqual(request.inputParameters, { IV_OBJECT: state.objectName, ET_INTERVALS: [] })
    return {
      outputs: {
        EV_CODE: state.code,
        EV_SYSTEM: "GR2",
        EV_CLIENT: "200",
        EV_VERSION: state.nativeVersion,
        ES_DEFINITION: properties,
        ET_INTERVALS: state.rows
      },
      ...(state.fault ? { fault: { code: "fixture", name: "fixture", message: "fixture" } } : {})
    }
  }
  const oldProfile = process.env.ABAP_MCP_TOOL_PROFILE
  const oldDeny = process.env.ABAP_MCP_TOOL_DENY
  const oldExportRoot = process.env.ABAP_MCP_EXPORT_ROOT
  const oldNumberStateRoot = process.env.ABAP_MCP_NUMBER_RANGE_STATE_ROOT
  process.env.ABAP_MCP_TOOL_PROFILE = "full"
  delete process.env.ABAP_MCP_TOOL_DENY
  process.env.ABAP_MCP_EXPORT_ROOT = root
  if (separateNumberState) process.env.ABAP_MCP_NUMBER_RANGE_STATE_ROOT = numberStateRoot
  else delete process.env.ABAP_MCP_NUMBER_RANGE_STATE_ROOT
  const server = createMcpServer(
    backend,
    new InvocationReceiptStore(root),
    new WriteOperationReceiptStore(root),
    undefined,
    root
  )
  const client = new Client({ name: "offline-number-range-flow", version: "1" })
  const [left, right] = InMemoryTransport.createLinkedPair()
  await server.connect(right)
  await client.connect(left)
  t.after(async () => {
    await client.close()
    await server.close()
    ToolService.prototype.readNumberRangeObject = original.object
    ToolService.prototype.readFunctionModuleInterface = original.fn
    ToolService.prototype.readDdicTransparentTable = original.table
    ToolService.prototype.readDdicDomain = original.domain
    ToolService.prototype.getObjectLines = original.lines
    if (oldProfile === undefined) delete process.env.ABAP_MCP_TOOL_PROFILE
    else process.env.ABAP_MCP_TOOL_PROFILE = oldProfile
    if (oldDeny === undefined) delete process.env.ABAP_MCP_TOOL_DENY
    else process.env.ABAP_MCP_TOOL_DENY = oldDeny
    if (oldExportRoot === undefined) delete process.env.ABAP_MCP_EXPORT_ROOT
    else process.env.ABAP_MCP_EXPORT_ROOT = oldExportRoot
    if (oldNumberStateRoot === undefined) delete process.env.ABAP_MCP_NUMBER_RANGE_STATE_ROOT
    else process.env.ABAP_MCP_NUMBER_RANGE_STATE_ROOT = oldNumberStateRoot
    t.diagnostic(
      `Retained offline receipts: ${root}; queries=${state.queries}; nativeReads=${state.nativeReads}`
    )
  })
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args })
    assert.notEqual(response.isError, true, JSON.stringify(response))
    return JSON.parse((response.content as { text: string }[])[0]!.text)
  }
  return { root, numberStateRoot, state, properties, client, call }
}

test("public scope/projection to native version to preview uses exact parameters without a write", async (t) => {
  const f = await fixture(t)
  const scoped = await f.call("read_configuration_number_range_scope", scopeSelection)
  const projected = await f.call("read_configuration_number_range", selection)
  assert.equal(scoped.nativeVersionRead.tool, "read_configuration_number_range_api")
  assert.deepEqual(scoped.nativeVersionRead, projected.nativeVersionRead)
  assert.equal(projected.nativeVersionRead.versionSource, "snapshot.EV_VERSION")
  assert.equal(projected.saveAvailable, false)
  const native = await f.call(
    projected.nativeVersionRead.tool,
    projected.nativeVersionRead.arguments
  )
  assert.equal(native.snapshot.EV_VERSION, version)
  assert.notEqual(projected.readFingerprint, version)
  assert.deepEqual(native.intervalPreview.requiredArguments, ["changes"])
  assert.equal(native.intervalPreview.intervalSource, "snapshot.ET_INTERVALS[1]")
  assert.equal(native.intervalPreview.requiresNativeVersion, false)
  const draft = await f.call(native.intervalPreview.tool, {
    ...native.intervalPreview.arguments,
    changes: [
      {
        ...native.intervalPreview.changeTemplate,
        fromNumber: row().FROMNUMBER,
        toNumber: "00000000000000000250",
        external: false
      }
    ]
  })
  assert.equal(draft.status, "partial")
  assert.deepEqual(draft.findings, [])
  assert.equal(draft.saveAvailable, false)
  assert.equal(draft.usableForWritePrecondition, false)
  assert.notEqual(draft.preflightFingerprint, version)
  assert.equal(draft.projectedIntervals[1].currentLevel, row().NRLEVEL)
  assert.equal(f.state.queries, 10)
  assert.equal(f.state.nativeReads, 1)
  const tools = (await f.client.listTools()).tools
  for (const name of [
    "read_configuration_number_range",
    "read_configuration_number_range_scope",
    "read_configuration_number_range_api",
    "preview_configuration_number_range"
  ]) {
    const tool = tools.find((v) => v.name === name)!
    assert.equal(tool.annotations?.readOnlyHint, true)
    assert.equal(tool.inputSchema.additionalProperties, false)
  }
})

test("incomplete, absent and drifting public projections retract the next native call", async (t) => {
  const f = await fixture(t)
  const initialRows = f.state.rows
  for (const mode of [
    "missingObject",
    "missingInterval",
    "unavailable",
    "valueDrift",
    "definitionDrift",
    "truncated"
  ] as const) {
    f.state.queries = 0
    f.state.definitions = 0
    f.state.missingObject = mode === "missingObject"
    f.state.unavailable = mode === "unavailable"
    f.state.valueDrift = mode === "valueDrift"
    f.state.definitionDrift = mode === "definitionDrift"
    f.state.rows =
      mode === "missingInterval"
        ? initialRows.slice(0, 1)
        : mode === "truncated"
          ? [...initialRows, row({ NRRANGENR: "03" })]
          : initialRows
    for (const [name, args] of [
      [
        "read_configuration_number_range",
        { ...selection, intervalNumber: undefined, maxIntervals: 2 }
      ],
      ["read_configuration_number_range_scope", { ...scopeSelection, maxIntervals: 2 }]
    ] as const) {
      const result = await f.call(name, args)
      assert.equal(result.nativeVersionRead, null, mode)
      assert.equal(result.saveAvailable, false)
    }
  }
  assert.equal(f.state.nativeReads, 0)
})

async function seedNumberRangeUnknownReceipt(root: string, operationId: string) {
  const receipts = new WriteOperationReceiptStore(root)
  const reserved = await receipts.reserve({
    connectionId: "w200",
    toolName: "apply_configuration_number_range",
    operationId,
    targetKey: "CONFIG:NRIV:200:ZORVCFGNR",
    protectUnknownTarget: true,
    inputHash: version,
    preChangeSummary: "Offline complete before version",
    recoveryGuide: "Offline fixture only; no SAP dispatch."
  })
  assert.ok(reserved.status === "reserved")
  await receipts.recordPreChangeEvidence(reserved.reservation, {
    observedAt: new Date().toISOString(),
    target: "NRIV:ZORVCFGNR:200",
    exists: true,
    active: null,
    version,
    fingerprint: version,
    packageName: null,
    requestNumber: null,
    taskNumber: null,
    observationStatus: "complete",
    sources: ["offline-fixture"],
    warnings: []
  })
  await receipts.markSapInvocationStarted(reserved.reservation)
  await receipts.fail(reserved.reservation, Error("OFFLINE_UNKNOWN_FIXTURE"), 0)
  return receipts
}

test("public capture and detailed reconciliation preserve unknown with exact response-derived recheck", async (t) => {
  const f = await fixture(t)
  const selection = { connectionId: "w200", objectName: "ZORVCFGNR" }
  const uncaptured = await f.call("read_configuration_number_range_api", selection)
  assert.equal(uncaptured.stateReference, undefined)
  const captured = await f.call("read_configuration_number_range_api", {
    ...selection,
    captureState: true
  })
  assert.match(captured.stateReference.reference, /^[a-f0-9]{64}$/)
  assert.equal(captured.stateReference.stateVersion, version)
  const persisted = JSON.parse(
    await readFile(
      join(f.root, "configuration-number-range-state", `${captured.stateReference.reference}.json`),
      "utf8"
    )
  )
  assert.equal(persisted.reference, captured.stateReference.reference)
  assert.equal(persisted.snapshot.EV_VERSION, version)
  const operationId = "offline-field-comparison"
  const receipts = await seedNumberRangeUnknownReceipt(f.root, operationId)
  const before = JSON.stringify(await receipts.status("w200", operationId))
  f.state.nativeVersion = "b".repeat(64)
  f.state.rows[1]!.NRLEVEL = "00000000000000000001"
  const initialReads = f.state.nativeReads
  const first = await f.call("reconcile_configuration_number_range", {
    ...selection,
    operationId,
    includeFieldDifferences: true
  })
  assert.equal(f.state.nativeReads - initialReads, 2)
  assert.equal(first.fieldComparison.status, "different_fields")
  assert.deepEqual(
    first.fieldComparison.differences.map((change: { field: string }) => change.field),
    ["NRLEVEL"]
  )
  assert.equal(first.outcomeMayBeUnknown, true)
  const second = await f.call(first.readFlow.comparison.tool, first.readFlow.comparison.arguments)
  assert.equal(second.versionGuard.status, "match")
  assert.equal(f.state.nativeReads - initialReads, 4)
  assert.equal(JSON.stringify(await receipts.status("w200", operationId)), before)
  assert.equal(second.retryAvailable, false)
})

test("public detailed missing before and unapproved capture scope cannot dispatch a reader", async (t) => {
  const f = await fixture(t)
  const operationId = "offline-missing-before"
  await seedNumberRangeUnknownReceipt(f.root, operationId)
  const missing = await f.call("reconcile_configuration_number_range", {
    connectionId: "w200",
    objectName: "ZORVCFGNR",
    operationId,
    includeFieldDifferences: true
  })
  assert.equal(missing.code, "BEFORE_SNAPSHOT_UNAVAILABLE")
  assert.equal(missing.snapshot, null)
  assert.equal(missing.fieldComparison, null)
  const response = await f.client.callTool({
    name: "read_configuration_number_range_api",
    arguments: { connectionId: "w200", objectName: "ZOTHER", captureState: true }
  })
  assert.equal(response.isError, true)
  assert.equal(f.state.nativeReads, 0)
  assert.equal(f.state.metadata, 0)
})

test("server number state root isolates snapshots while preserving the existing export root", async (t) => {
  const f = await fixture(t, true)
  const captured = await f.call("read_configuration_number_range_api", {
    connectionId: "w200",
    objectName: "ZORVCFGNR",
    captureState: true
  })
  const name = join("configuration-number-range-state", `${captured.stateReference.reference}.json`)
  const persisted = JSON.parse(await readFile(join(f.numberStateRoot, name), "utf8"))
  assert.equal(persisted.snapshot.EV_VERSION, version)
  await assert.rejects(readFile(join(f.root, name), "utf8"), { code: "ENOENT" })
  const operationId = "offline-separate-number-state"
  const receipts = await seedNumberRangeUnknownReceipt(f.root, operationId)
  const before = JSON.stringify(await receipts.status("w200", operationId))
  const result = await f.call("reconcile_configuration_number_range", {
    connectionId: "w200",
    objectName: "ZORVCFGNR",
    operationId,
    includeFieldDifferences: true
  })
  assert.equal(result.fieldComparison.status, "equal_fields")
  assert.equal(JSON.stringify(await receipts.status("w200", operationId)), before)
  assert.equal(result.outcomeMayBeUnknown, true)
  assert.equal(f.state.nativeReads, 3)
})

test("other objects, interval filters and annual scopes cannot link the fixed target", async (t) => {
  const f = await fixture(t)
  const filtered = await f.call("read_configuration_number_range", {
    ...selection,
    intervalNumber: "01"
  })
  assert.equal(filtered.status, "read")
  assert.equal(filtered.nativeVersionRead, null)
  f.state.objectName = "ZOTHER"
  f.properties.OBJECT = "ZOTHER"
  f.state.rows = f.state.rows.map((r) => ({ ...r, OBJECT: "ZOTHER" }))
  const other = await f.call("read_configuration_number_range", {
    ...selection,
    objectName: "ZOTHER"
  })
  assert.equal(other.nativeVersionRead, null)
  const native = await f.call("read_configuration_number_range_api", {
    connectionId: "w200",
    objectName: "ZOTHER"
  })
  assert.equal(native.intervalPreview, null)
  f.state.objectName = "ZORVCFGNR"
  f.properties.OBJECT = "ZORVCFGNR"
  f.properties.YEARIND = "X"
  f.state.rows = [row({ TOYEAR: "2026" })]
  const annual = await f.call("read_configuration_number_range_scope", scopeSelection)
  assert.equal(annual.status, "read")
  assert.equal(annual.nativeVersionRead, null)
})

test("native snapshots retain versions but withhold preview for missing, duplicate or unsupported intervals", async (t) => {
  const f = await fixture(t)
  const args = { connectionId: "w200", objectName: "ZORVCFGNR" }
  for (const rows of [[], [row(), row()], [row({ TOYEAR: "2026" })], [row({ FROMNUMBER: "1" })]]) {
    f.state.rows = rows
    const result = await f.call("read_configuration_number_range_api", args)
    assert.equal(result.snapshot.EV_VERSION, version)
    assert.equal(result.intervalPreview, null)
  }
  f.state.rows = [row()]
  for (const [field, value] of [
    ["BUFFER", "X"],
    ["NOIVBUFFER", "00000001"],
    ["DOMLEN", "CHAR4"],
    ["RFCDEST", "OTHER"]
  ]) {
    const previous = f.properties[field!]!
    f.properties[field!] = value!
    assert.equal((await f.call("read_configuration_number_range_api", args)).intervalPreview, null)
    f.properties[field!] = previous
  }
})

test("failed native attestation or read cannot expose a version or usable preview link", async (t) => {
  const f = await fixture(t)
  for (const mode of [
    "missingApi",
    "layoutDrift",
    "sourceDrift",
    "fault",
    "changed",
    "limited",
    "unauthorized"
  ] as const) {
    f.state.missingApi = mode === "missingApi"
    f.state.layoutDrift = mode === "layoutDrift"
    f.state.sourceDrift = mode === "sourceDrift"
    f.state.fault = mode === "fault"
    f.state.nativeReads = 0
    f.state.code =
      mode === "changed"
        ? "READ_CHANGED"
        : mode === "limited"
          ? "INTERVAL_LIMIT_EXCEEDED"
          : mode === "unauthorized"
            ? "AUTHORIZATION_DENIED"
            : "READ_OK"
    const response = await f.client.callTool({
      name: "read_configuration_number_range_api",
      arguments: { connectionId: "w200", objectName: "ZORVCFGNR" }
    })
    assert.equal(response.isError, true, mode)
    assert.ok(!JSON.stringify(response.content).includes('"intervalPreview"'), mode)
    assert.ok(!JSON.stringify(response.content).includes(version), mode)
    if (mode === "missingApi" || mode === "layoutDrift") assert.equal(f.state.nativeReads, 0)
  }
})

test("strict public inputs reject forged preview versions and hidden mutations before any read", async (t) => {
  const f = await fixture(t)
  const preview = {
    ...scopeSelection,
    year: "0000",
    changes: [
      {
        action: "update",
        intervalNumber: "02",
        fromNumber: row().FROMNUMBER,
        toNumber: row().TONUMBER,
        external: false
      }
    ]
  }
  for (const [name, args] of [
    ["read_configuration_number_range", { ...selection, execute: true }],
    ["read_configuration_number_range_scope", { ...scopeSelection, intervalNumber: "02" }],
    [
      "read_configuration_number_range_api",
      { connectionId: "w200", objectName: "ZORVCFGNR", expectedVersion: version }
    ],
    ["preview_configuration_number_range", { ...preview, expectedVersion: version }],
    ["preview_configuration_number_range", { ...preview, expectedReadFingerprint: version }],
    ["preview_configuration_number_range", { ...preview, intervalNumber: "02" }],
    ["preview_configuration_number_range", { ...preview, acknowledgeConfigurationWrite: true }],
    [
      "preview_configuration_number_range",
      { ...preview, changes: [{ ...preview.changes[0], currentLevel: "0" }] }
    ]
  ] as const) {
    const response = await f.client.callTool({ name, arguments: args })
    assert.equal(response.isError, true)
  }
  assert.equal(f.state.metadata, 0)
  assert.equal(f.state.queries, 0)
  assert.equal(f.state.nativeReads, 0)
})
