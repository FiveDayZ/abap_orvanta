import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createMcpServer } from "../src/mcp.js"
import { configurationBcReadFlow } from "../src/configuration-bc-read-flow.js"
import { ToolService } from "../src/tools.js"
import { InvocationReceiptStore } from "../src/invocation-receipts.js"
import { WriteOperationReceiptStore, hashWriteInput } from "../src/write-operation-receipts.js"
import { ConfigurationBcBeforeStateStore } from "../src/configuration-bc-before-state-store.js"
import { prepareConfigurationBcCommand } from "../src/configuration-bc-command-preparation.js"
import { configurationBcStateApi } from "../src/configuration-bc-state-api.js"
import { configurationBcCtsApi } from "../src/configuration-bc-cts-api.js"
import {
  configurationBcEffectsApi,
  configurationBcEffectsScope
} from "../src/configuration-bc-effects-api.js"
import {
  configurationBcEffectsAllLayouts,
  configurationBcEffectsDependencies,
  configurationBcEffectsInclude
} from "../src/configuration-bc-effects.js"
import { preflightFixture } from "./configuration-bc-preflight-fixture.js"
import { stateFixture } from "./configuration-bc-state-fixture.js"
import { ctsFixture } from "./configuration-bc-cts-fixture.js"
import { MockBackend } from "./mock-backend.js"

const scope = { connectionId: "w200", bcSetId: "EHS_CUNI_KNM", version: "N" }
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex")
type ReadLink = {
  tool: string
  arguments: Record<string, unknown>
  requiredArguments: string[]
  argumentSources: Record<string, string>
}

// Four historical child responses are replayed; CTS/state/effects use real adapters with
// synthetic native bytes. This proves public wiring/persistence, never a SAP business result.
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "orvanta-knm-read-flow-"))
  t.diagnostic(`Retained offline evidence: ${root}`)
  const p = preflightFixture(),
    s = await stateFixture(),
    c = ctsFixture(),
    backend = new MockBackend()
  const original = {
    snapshot: ToolService.prototype.readConfigurationBcNativeSnapshot,
    preview: ToolService.prototype.previewConfigurationBcNative,
    route: ToolService.prototype.inspectConfigurationBcRoute,
    guard: ToolService.prototype.readConfigurationBcGuard,
    definition: ToolService.prototype.readFunctionModuleInterface,
    table: ToolService.prototype.readDdicTransparentTable,
    exportRoot: process.env.ABAP_MCP_EXPORT_ROOT
  }
  process.env.ABAP_MCP_EXPORT_ROOT = root
  ToolService.prototype.readConfigurationBcNativeSnapshot = async () =>
    JSON.stringify(await p.readers.snapshot())
  ToolService.prototype.previewConfigurationBcNative = async () =>
    JSON.stringify(await p.readers.preview())
  ToolService.prototype.inspectConfigurationBcRoute = async () =>
    JSON.stringify(await p.readers.route())
  ToolService.prototype.readConfigurationBcGuard = async () =>
    JSON.stringify(await p.readers.guard())
  const state = {
    username: "wys",
    missingStateApi: false,
    stateDrift: false,
    stateCode: "STATE_READ_OK",
    effectsCode: "EFFECTS_READ_OK",
    effectsCounts: "matched=0;records=0;headers=0;variables=0;links=0;",
    effectsProfiles: "1",
    sourceDrift: false,
    metadata: 0,
    nativeCalls: [] as string[]
  }
  const definition = (api: typeof configurationBcCtsApi | typeof configurationBcEffectsApi) => ({
    ...api,
    connectionId: "w200",
    updateTask: false,
    updateTaskMode: "",
    changingParameters: [],
    exceptions: [],
    sourceFingerprint: "a".repeat(64),
    interfaceFingerprint: "b".repeat(64),
    source: [`FUNCTION ${api.functionName}.`, ...api.source, "ENDFUNCTION."]
  })
  ToolService.prototype.readFunctionModuleInterface = async ({ functionName }) => {
    state.metadata++
    if (functionName === configurationBcStateApi.functionName) {
      if (state.missingStateApi) throw Error("OFFLINE_STATE_API_MISSING")
      return JSON.stringify(s.definition)
    }
    if (functionName === configurationBcCtsApi.functionName)
      return JSON.stringify(definition(configurationBcCtsApi))
    if (functionName === configurationBcEffectsApi.functionName)
      return JSON.stringify(definition(configurationBcEffectsApi))
    const existing = p.definitions[functionName]
    if (existing) return JSON.stringify(existing)
    const pin =
      configurationBcEffectsDependencies[
        functionName as keyof typeof configurationBcEffectsDependencies
      ]
    assert.ok(pin, `Unexpected metadata: ${functionName}`)
    return JSON.stringify({
      connectionId: "w200",
      functionName,
      updateTask: false,
      ...pin,
      sourceFingerprint: pin.source,
      interfaceFingerprint: pin.interface
    })
  }
  ToolService.prototype.readDdicTransparentTable = async ({ objectName }) => {
    state.metadata++
    const fingerprint = configurationBcEffectsAllLayouts[objectName]
    assert.ok(fingerprint)
    return JSON.stringify({
      connectionId: "w200",
      objectName,
      objectKind: "transparentTable",
      fingerprint
    })
  }
  const details = backend.connectionDetails.bind(backend)
  backend.connectionDetails = (id) => ({
    ...details(id),
    client: "200",
    username: state.username
  })
  const historical = JSON.parse(
    readFileSync(
      new URL(
        "../../docs/workspace-evidence/.doc/orvanta-configuration-bc-effects-development-20261006-091423-r58.json",
        import.meta.url
      ),
      "utf8"
    )
  )
  const source = /```abap\n([\s\S]*?)\n```/
    .exec(historical.descriptorFormFullSource.text)![1]!
    .replaceAll("\n", "\r\n")
  assert.equal(sha(source), configurationBcEffectsInclude.sourceFingerprint)
  backend.readSourceByUri = async (id, uri) => {
    state.metadata++
    assert.equal(id, "w200")
    assert.equal(uri, configurationBcEffectsInclude.sourceUri)
    return { source: state.sourceDrift ? `${source}\r\n` : source, uriUsed: uri }
  }
  const effectsBytes = Buffer.from("offline native effects only\0spaces   ")
  backend.callRemoteFunction = async (id, request) => {
    assert.equal(id, "w200")
    state.nativeCalls.push(request.functionName)
    if (request.functionName === configurationBcCtsApi.functionName) {
      assert.deepEqual(request.inputParameters, {
        IV_BC_SET: scope.bcSetId,
        IV_VERSION: scope.version,
        IV_REQUEST: c.input.requestNumber,
        IV_TASK: c.input.taskNumber
      })
      return { outputs: structuredClone(c.native) }
    }
    if (request.functionName === configurationBcStateApi.functionName) {
      const outputs = { ...s.native, EV_CODE: state.stateCode }
      if (
        state.stateDrift &&
        state.nativeCalls.filter((name) => name === request.functionName).length % 2 === 0
      ) {
        const changed = Buffer.from("different valid synthetic native state")
        Object.assign(outputs, {
          EV_DATA_BASE64: changed.toString("base64"),
          EV_DATA_BYTES: String(changed.length),
          EV_STATE_VERSION: sha(changed)
        })
      }
      return { outputs }
    }
    assert.equal(
      request.functionName,
      configurationBcEffectsApi.functionName,
      "No write/CTS dispatch"
    )
    assert.deepEqual(request.inputParameters, {
      IV_BC_SET: scope.bcSetId,
      IV_VERSION: scope.version,
      IV_REQUEST: c.input.requestNumber,
      IV_TASK: c.input.taskNumber,
      IV_CTS_VERSION: c.native.EV_CTS_VERSION
    })
    return {
      outputs: {
        EV_CODE: state.effectsCode,
        EV_SYSTEM: "GR2",
        EV_CLIENT: "200",
        EV_USER: "WYS",
        EV_REQUEST: c.input.requestNumber,
        EV_TASK: c.input.taskNumber,
        EV_CTS_VERSION: c.native.EV_CTS_VERSION!,
        EV_SCOPE_VERSION: configurationBcEffectsScope,
        EV_EFFECTS_VERSION: sha(effectsBytes),
        EV_ROW_COUNTS: state.effectsCounts,
        EV_PROFILE_COUNT: state.effectsProfiles,
        EV_DATA_BASE64: effectsBytes.toString("base64"),
        EV_DATA_BYTES: String(effectsBytes.length),
        EV_ROUNDTRIP: "X"
      }
    }
  }
  backend.runQuery = async () => {
    throw Error("No SQL fallback")
  }
  backend.callSapHelper = async () => {
    throw Error("No generic helper/write fallback")
  }
  const receipts = new WriteOperationReceiptStore(root)
  const server = createMcpServer(
    backend,
    new InvocationReceiptStore(root),
    receipts,
    undefined,
    root
  )
  const client = new Client({ name: "knm-public-read-flow", version: "offline" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  t.after(async () => {
    ToolService.prototype.readConfigurationBcNativeSnapshot = original.snapshot
    ToolService.prototype.previewConfigurationBcNative = original.preview
    ToolService.prototype.inspectConfigurationBcRoute = original.route
    ToolService.prototype.readConfigurationBcGuard = original.guard
    ToolService.prototype.readFunctionModuleInterface = original.definition
    ToolService.prototype.readDdicTransparentTable = original.table
    if (original.exportRoot === undefined) delete process.env.ABAP_MCP_EXPORT_ROOT
    else process.env.ABAP_MCP_EXPORT_ROOT = original.exportRoot
    await client.close()
    await server.close()
  })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const listed = (await client.listTools()).tools
  const call = (name: string, arguments_: Record<string, unknown>) =>
    client.callTool({ name, arguments: arguments_ })
  const read = async (name: string, arguments_: Record<string, unknown>) => {
    const response = await call(name, arguments_)
    assert.equal(response.isError, undefined, JSON.stringify(response.content))
    return JSON.parse((response.content as { text: string }[])[0]!.text)
  }
  const next = (result: { readFlow: { nextReads: ReadLink[] } }, tool: string) => {
    const link = result.readFlow.nextReads.find((entry) => entry.tool === tool)!
    assert.ok(link)
    const contract = listed.find((entry) => entry.name === tool)!
    assert.equal(contract.inputSchema.additionalProperties, false)
    assert.equal(contract.annotations?.readOnlyHint, true)
    assert.deepEqual(
      [...Object.keys(link.arguments), ...link.requiredArguments].sort(),
      [...(contract.inputSchema.required ?? [])].sort()
    )
    assert.deepEqual(
      Object.keys(link.argumentSources).sort(),
      [...(contract.inputSchema.required ?? [])].sort()
    )
    return link
  }
  return {
    root,
    p,
    s,
    c,
    state,
    read,
    call,
    next,
    receipts,
    store: new ConfigurationBcBeforeStateStore(root),
    effectsInput: (reference: string) => ({
      ...c.input,
      operationId: "offline-effects-read-001",
      beforeStateReference: reference
    })
  }
}

test("eight public KNM reads wire exact versions and immutable references without changing stored hashes", async (t) => {
  const f = await fixture(t)
  const native = await f.read("read_configuration_bc_native_snapshot", scope)
  assert.equal(native.readFlow.versionSources.source, "native.EV_SOURCE_VERSION")
  assert.deepEqual(f.state.nativeCalls, [], "descriptors cannot dispatch the next read")
  assert.equal(f.p.counts.snapshot, 1)
  assert.equal(f.p.counts.preview, 0)
  assert.equal(f.p.counts.route, 0)
  assert.equal(f.p.counts.guard, 0)
  const previewLink = f.next(native, "preview_configuration_bc_native")
  assert.equal(previewLink.arguments.nativeTargetVersion, native.native.EV_TARGET_VERSION)
  const preview = await f.read(previewLink.tool, previewLink.arguments)
  const routeLink = f.next(native, "inspect_configuration_bc_route")
  const route = await f.read(routeLink.tool, routeLink.arguments)
  const guardLink = f.next(route, "read_configuration_bc_guard")
  assert.equal(guardLink.arguments.nativeMetadataVersion, route.metadataVersion)
  const guard = await f.read(guardLink.tool, guardLink.arguments)
  const preflightLink = f.next(guard, "preflight_configuration_bc_activation")
  assert.deepEqual(preflightLink.requiredArguments, ["nativeCandidateVersion"])
  assert.equal(
    preflightLink.argumentSources.nativeCandidateVersion,
    "preview_configuration_bc_native.candidateVersion"
  )
  const preflight = await f.read(preflightLink.tool, {
    ...preflightLink.arguments,
    nativeCandidateVersion: preview.candidateVersion
  })
  f.next(preview, "preflight_configuration_bc_activation")
  f.next(route, "preflight_configuration_bc_activation")
  const ctsLink = f.next(preflight, "read_configuration_bc_cts_snapshot")
  const cts = await f.read(ctsLink.tool, ctsLink.arguments)
  const beforeLink = f.next(preflight, "read_configuration_bc_before_state")
  assert.deepEqual(beforeLink.requiredArguments, ["nativeCtsVersion"])
  const ctsBeforeLink = f.next(cts, "read_configuration_bc_before_state")
  assert.equal(ctsBeforeLink.arguments.nativeCtsVersion, cts.ctsVersion)
  assert.equal(ctsBeforeLink.requiredArguments.length, 5)
  const before = await f.read(beforeLink.tool, {
    ...beforeLink.arguments,
    nativeCtsVersion: cts.ctsVersion
  })
  const {
    readFlow: _beforeFlow,
    beforeStateReference,
    beforeStatePersistence: _persistence,
    ...rawState
  } = before
  assert.equal(hashWriteInput(rawState), beforeStateReference)
  assert.equal("readFlow" in rawState.cts, false, "public display must never enter captured CTS")
  const envelope = JSON.parse(
    await readFile(
      join(f.root, "configuration-bc-before-state", `${beforeStateReference}.json`),
      "utf8"
    )
  )
  assert.deepEqual(envelope.state, rawState)
  const effectsLink = f.next(before, "read_configuration_bc_effects")
  assert.deepEqual(effectsLink.requiredArguments, ["operationId"])
  assert.equal(effectsLink.arguments.beforeStateReference, beforeStateReference)
  assert.equal("operationId" in effectsLink.arguments, false)
  const request = { ...effectsLink.arguments, operationId: "offline-effects-read-001" }
  const effects = await f.read(effectsLink.tool, request)
  assert.deepEqual(effects.readFlow.nextReads, [])
  assert.deepEqual(effects.readFlow.referenceSources, {
    beforeStateReference: "beforeStateReference",
    effectsReference: "effectsStateReference"
  })
  assert.equal(effects.readFlow.executable, false)
  assert.equal(effects.readFlow.usableForWritePrecondition, false)
  const {
    readFlow: _effectsFlow,
    effectsStateReference,
    effectsStatePersistence: _effectsPersistence,
    ...rawEffects
  } = effects
  assert.equal(hashWriteInput({ beforeStateReference, effects: rawEffects }), effectsStateReference)
  const binding = {
    connectionId: "w200",
    bcSetId: "EHS_CUNI_KNM",
    version: "N",
    requestNumber: "GR2K923429",
    taskNumber: "GR2K923430",
    system: "GR2",
    client: "200",
    user: "WYS"
  } as const
  const stored = await f.store.readEffects(effectsStateReference, binding)
  assert.deepEqual(stored.effects, rawEffects)
  const prepared = await prepareConfigurationBcCommand(
    request,
    binding,
    f.store,
    async () => rawState,
    {
      reference: effectsStateReference,
      readCurrent: async () => rawEffects
    }
  )
  assert.equal(prepared.nativeEffectsRechecked, true)
  assert.equal(prepared.executable, false)
  assert.equal(prepared.beforeState.reference, beforeStateReference)
  assert.deepEqual(f.state.nativeCalls, [
    configurationBcCtsApi.functionName,
    configurationBcCtsApi.functionName,
    configurationBcCtsApi.functionName,
    configurationBcCtsApi.functionName,
    configurationBcStateApi.functionName,
    configurationBcStateApi.functionName,
    configurationBcCtsApi.functionName,
    configurationBcCtsApi.functionName,
    configurationBcEffectsApi.functionName
  ])
})

test("unsupported source, alias mapping and method/member routes publish no usable read flow", async (t) => {
  const f = await fixture(t)
  f.p.data.snapshot.native.EV_SOURCE_VERSION = "f".repeat(64)
  assert.equal((await f.read("read_configuration_bc_native_snapshot", scope)).readFlow, null)
  f.p.data.snapshot.native.EV_SOURCE_VERSION = f.p.input.nativeSourceVersion
  f.p.data.snapshot.states[0].mappingConflict = true
  assert.equal((await f.read("read_configuration_bc_native_snapshot", scope)).readFlow, null)
  f.p.data.route.methods.push({ METHOD: "AFTER_IMP", METHODNAME: "UNSUPPORTED" })
  const input = {
    ...scope,
    nativeSourceVersion: f.p.input.nativeSourceVersion,
    nativeTargetVersion: f.p.input.nativeTargetVersion
  }
  assert.equal((await f.read("inspect_configuration_bc_route", input)).readFlow, null)
  f.p.data.route.methods = []
  f.p.data.route.members.pop()
  assert.equal((await f.read("inspect_configuration_bc_route", input)).readFlow, null)
  assert.deepEqual(f.state.nativeCalls, [])
})

test("strict scope, extra fields and missing versions are refused before any reader or native dispatch", async (t) => {
  const f = await fixture(t)
  const reads = [
    ["read_configuration_bc_native_snapshot", scope],
    [
      "preview_configuration_bc_native",
      {
        ...scope,
        nativeSourceVersion: f.p.input.nativeSourceVersion,
        nativeTargetVersion: f.p.input.nativeTargetVersion
      }
    ],
    [
      "inspect_configuration_bc_route",
      {
        ...scope,
        nativeSourceVersion: f.p.input.nativeSourceVersion,
        nativeTargetVersion: f.p.input.nativeTargetVersion
      }
    ],
    [
      "read_configuration_bc_guard",
      {
        ...scope,
        nativeSourceVersion: f.p.input.nativeSourceVersion,
        nativeTargetVersion: f.p.input.nativeTargetVersion,
        nativeMetadataVersion: f.p.input.nativeMetadataVersion
      }
    ],
    ["preflight_configuration_bc_activation", f.p.input],
    ["read_configuration_bc_cts_snapshot", f.c.input],
    ["read_configuration_bc_before_state", f.s.input],
    ["read_configuration_bc_effects", f.effectsInput("f".repeat(64))]
  ] as const
  for (const [name, input] of reads) {
    for (const patch of [
      { connectionId: "w300" },
      { version: "C" },
      { buffer: "AAAA" },
      { acknowledgeConfigurationWrite: true }
    ])
      assert.equal((await f.call(name, { ...input, ...patch })).isError, true)
    const missing = { ...input } as Record<string, unknown>
    delete missing[Object.keys(input).find((key) => key.startsWith("native")) ?? "bcSetId"]
    assert.equal((await f.call(name, missing)).isError, true)
  }
  assert.equal(f.state.metadata, 0)
  assert.deepEqual(f.state.nativeCalls, [])
  assert.deepEqual(Object.values(f.p.counts), [0, 0, 0, 0, 0])
})

test("missing API, version drift and native refusal retract the complete before-state and next reads", async (t) => {
  const f = await fixture(t)
  f.state.missingStateApi = true
  const missing = await f.call("read_configuration_bc_before_state", f.s.input)
  assert.equal(missing.isError, true)
  assert.match(JSON.stringify(missing.content), /OFFLINE_STATE_API_MISSING/)
  assert.deepEqual(f.state.nativeCalls, [])
  f.state.missingStateApi = false
  f.state.stateDrift = true
  const drift = await f.call("read_configuration_bc_before_state", f.s.input)
  assert.equal(drift.isError, true)
  assert.match(JSON.stringify(drift.content), /STATE_READ_CHANGED/)
  assert.ok(!JSON.stringify(drift.content).includes("readFlow"))
  f.state.stateDrift = false
  f.state.stateCode = "VERSION_CONFLICT"
  const refused = await f.call("read_configuration_bc_before_state", f.s.input)
  assert.equal(refused.isError, true)
  assert.ok(!JSON.stringify(refused.content).includes("beforeStateReference"))
})

test("effects require original identity/reference and source attestation before native dispatch", async (t) => {
  const f = await fixture(t)
  const before = await f.read("read_configuration_bc_before_state", f.s.input)
  const input = f.effectsInput(before.beforeStateReference)
  const nativeCount = f.state.nativeCalls.length
  for (const patch of [
    { beforeStateReference: "f".repeat(64) },
    { requestNumber: "GR2K923472" },
    { beforeStateReference: "../outside" }
  ])
    assert.equal(
      (await f.call("read_configuration_bc_effects", { ...input, ...patch })).isError,
      true
    )
  f.state.username = "other"
  const wrongUser = await f.call("read_configuration_bc_effects", input)
  assert.equal(wrongUser.isError, true)
  assert.match(JSON.stringify(wrongUser.content), /BEFORE_STATE_BINDING_INVALID/)
  f.state.username = "wys"
  f.state.sourceDrift = true
  const changed = await f.call("read_configuration_bc_effects", input)
  assert.equal(changed.isError, true)
  assert.ok(!JSON.stringify(changed.content).includes("effectsStateReference"))
  assert.equal(f.state.nativeCalls.length, nativeCount)
  f.state.sourceDrift = false
  f.state.effectsCode = "KEY_SCOPE_INVALID"
  const refused = await f.call("read_configuration_bc_effects", input)
  assert.equal(refused.isError, true)
  assert.ok(!JSON.stringify(refused.content).includes("readFlow"))
})

test("valid effects with existing rows retain evidence but expose no usable reference wiring", async (t) => {
  const f = await fixture(t)
  const before = await f.read("read_configuration_bc_before_state", f.s.input)
  f.state.effectsCounts = "matched=1;records=1;headers=1;variables=0;links=0;"
  f.state.effectsProfiles = "2"
  const effects = await f.read(
    "read_configuration_bc_effects",
    f.effectsInput(before.beforeStateReference)
  )
  assert.match(effects.effectsStateReference, /^[a-f0-9]{64}$/)
  assert.equal(effects.counts.records, 1)
  assert.equal(effects.readFlow, null)
  assert.equal(effects.executable, false)
  assert.equal(effects.recoveryAvailable, false)
})

test("public read wiring preserves an unknown command receipt and target protection", async (t) => {
  const f = await fixture(t)
  const identity = {
    connectionId: "w200",
    toolName: "apply_configuration_bc_set",
    operationId: "offline-unknown-original",
    targetKey: "CONFIG:BC:CUNI:200",
    inputHash: "a".repeat(64),
    preChangeSummary: "synthetic receipt only",
    recoveryGuide: "preserve unknown; no replay",
    protectUnknownTarget: true
  }
  const reserved = await f.receipts.reserve(identity)
  assert.equal(reserved.status, "reserved")
  if (reserved.status !== "reserved") throw Error("Missing offline reservation")
  await f.receipts.markSapInvocationStarted(reserved.reservation)
  await f.receipts.fail(reserved.reservation, Error("synthetic unknown"), 1)
  const status = await f.receipts.status("w200", identity.operationId)
  assert.equal(status.outcomeMayBeUnknown, true)
  const bytes = await readFile(reserved.reservation.receiptPath)
  const before = await f.read("read_configuration_bc_before_state", f.s.input)
  const effects = await f.read(
    "read_configuration_bc_effects",
    f.effectsInput(before.beforeStateReference)
  )
  assert.equal(effects.readFlow.usableForWritePrecondition, false)
  assert.deepEqual(await readFile(reserved.reservation.receiptPath), bytes)
  assert.deepEqual(await f.receipts.status("w200", identity.operationId), status)
  const blocked = await f.receipts.reserve({ ...identity, operationId: "offline-no-replay" })
  assert.equal(blocked.status, "target_busy")
})

test("other BC reads and unrelated results remain byte-for-byte unchanged", () => {
  const text = '{ "readOnly": true, "readFingerprint": "projection-only" }\n'
  assert.equal(configurationBcReadFlow("read_configuration_bc_set", text), text)
  assert.equal(configurationBcReadFlow("read_configuration_unit", text), text)
})
