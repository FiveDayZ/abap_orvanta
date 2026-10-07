import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { ConfigurationBcBeforeStateStore } from "../src/configuration-bc-before-state-store.js"
import { prepareConfigurationBcCommand } from "../src/configuration-bc-command-preparation.js"
import {
  configurationBcEffectsApi as api,
  configurationBcEffectsScope
} from "../src/configuration-bc-effects-api.js"
import {
  attestConfigurationBcEffectsApi,
  readConfigurationBcEffects,
  configurationBcEffectsAllLayouts,
  configurationBcEffectsDependencies,
  configurationBcEffectsInclude
} from "../src/configuration-bc-effects.js"
import { configurationBcCtsApi } from "../src/configuration-bc-cts-api.js"
import { configurationBcPreflightKeys } from "../src/configuration-bc-preflight.js"
import { stateFixture } from "./configuration-bc-state-fixture.js"
import { hashWriteInput } from "../src/write-operation-receipts.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"
import { startHttpServer } from "../src/http.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

// Synthetic bytes exercise the adapter; they never prove SAP serialization or link-table reads.
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "orvanta-bc-effects-"))
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  t.after(() => rm(root, { recursive: true, force: true }))
  const state = await (await stateFixture()).invoke()
  const store = new ConfigurationBcBeforeStateStore(root)
  const captured = await store.capture(async () => state)
  const request = {
    connectionId: "w200",
    bcSetId: "EHS_CUNI_KNM",
    version: "N",
    requestNumber: "GR2K923429",
    taskNumber: "GR2K923430",
    operationId: "r58-read-effects-001",
    beforeStateReference: captured.reference
  }
  const def = (candidate: typeof api | typeof configurationBcCtsApi) => ({
    ...candidate,
    connectionId: "w200",
    updateTask: false,
    updateTaskMode: "",
    changingParameters: [],
    exceptions: [],
    source: [`FUNCTION ${candidate.functionName}.`, ...candidate.source, "ENDFUNCTION."],
    sourceFingerprint: "a".repeat(64),
    interfaceFingerprint: "b".repeat(64)
  })
  const definition = def(api)
  const bytes = Buffer.from("synthetic-only\0profile-links|中文|fixed spaces   ")
  const native: Record<string, string> = {
    EV_CODE: "EFFECTS_READ_OK",
    EV_SYSTEM: "GR2",
    EV_CLIENT: "200",
    EV_USER: "WYS",
    EV_REQUEST: "GR2K923429",
    EV_TASK: "GR2K923430",
    EV_CTS_VERSION: state.versions.cts,
    EV_SCOPE_VERSION: configurationBcEffectsScope,
    EV_EFFECTS_VERSION: createHash("sha256").update(bytes).digest("hex"),
    EV_ROW_COUNTS: "matched=2;records=3;headers=2;variables=1;links=0;",
    EV_PROFILE_COUNT: "3",
    EV_DATA_BASE64: bytes.toString("base64"),
    EV_DATA_BYTES: String(bytes.length),
    EV_ROUNDTRIP: "X"
  }
  let calls = 0,
    fault = false,
    definitionReads = 0,
    tableReads = 0,
    includeReads = 0
  let patchDefinition = (_name: string, _v: Record<string, unknown>) => {}
  let patchTable = (_name: string, _v: Record<string, unknown>) => {}
  let patchInclude = (_v: Record<string, unknown>) => {}
  const readers = {
    definition: async (name: string) => {
      definitionReads++
      let v: Record<string, unknown>
      if (name === api.functionName) v = structuredClone(definition)
      else if (name === configurationBcCtsApi.functionName) v = def(configurationBcCtsApi)
      else {
        const pin =
          configurationBcEffectsDependencies[
            name as keyof typeof configurationBcEffectsDependencies
          ]
        assert.ok(pin)
        v = {
          connectionId: "w200",
          functionName: name,
          updateTask: false,
          sourceFingerprint: pin.source,
          interfaceFingerprint: pin.interface
        }
      }
      patchDefinition(name, v)
      return v
    },
    table: async (name: string) => {
      tableReads++
      const v: Record<string, unknown> = {
        connectionId: "w200",
        objectName: name,
        objectKind: "transparentTable",
        fingerprint: configurationBcEffectsAllLayouts[name]!
      }
      patchTable(name, v)
      return v
    },
    include: async () => {
      includeReads++
      const v: Record<string, unknown> = { connectionId: "w200", ...configurationBcEffectsInclude }
      patchInclude(v)
      return v
    }
  }
  const backend = {
    callRemoteFunction: async (
      ...args: Parameters<Parameters<typeof readConfigurationBcEffects>[3]["callRemoteFunction"]>
    ) => {
      calls++
      assert.equal(args[0], "w200")
      assert.equal(args[1].functionName, api.functionName)
      assert.deepEqual(args[1].inputParameters, {
        IV_BC_SET: request.bcSetId,
        IV_VERSION: request.version,
        IV_REQUEST: request.requestNumber,
        IV_TASK: request.taskNumber,
        IV_CTS_VERSION: state.versions.cts
      })
      assert.deepEqual(
        args[1].outputParameters,
        api.exportParameters.map((p) => ({ name: p.name, kind: "scalar" }))
      )
      return {
        outputs: structuredClone(native),
        ...(fault
          ? {
              fault: {
                code: "SYNTHETIC",
                name: "TEST_FAULT",
                message: "synthetic SAP fault"
              }
            }
          : {})
      }
    }
  }
  return {
    root,
    store,
    state,
    backend,
    readers,
    definition,
    native,
    request,
    captured,
    bytes,
    invoke: (raw: unknown = request, binding = captured.binding) =>
      readConfigurationBcEffects(raw, binding, store, backend, readers),
    setDefinitionPatch: (v: typeof patchDefinition) => {
      patchDefinition = v
    },
    setTablePatch: (v: typeof patchTable) => {
      patchTable = v
    },
    setIncludePatch: (v: typeof patchInclude) => {
      patchInclude = v
    },
    setFault: () => {
      fault = true
    },
    get calls() {
      return calls
    },
    get definitionReads() {
      return definitionReads
    },
    get tableReads() {
      return tableReads
    },
    get includeReads() {
      return includeReads
    }
  }
}

test("command preparation rechecks linked native effects while read labels grant no command permit", async (t) => {
  const f = await fixture(t),
    effects = await f.invoke(),
    captured = await f.store.captureEffects(
      f.captured.reference,
      f.captured.binding,
      async () => effects
    )
  let stateReads = 0,
    effectsReads = 0
  const value = await prepareConfigurationBcCommand(
    f.request,
    f.captured.binding,
    f.store,
    async () => {
      stateReads++
      return f.state
    },
    {
      reference: captured.reference,
      readCurrent: async () => {
        effectsReads++
        return { ...effects, operationId: "r61-current-read" }
      }
    }
  )
  assert.equal(stateReads, 1)
  assert.equal(effectsReads, 1)
  assert.equal(value.nativeEffectsRechecked, true)
  assert.equal(value.effectsBeforeState?.reference, captured.reference)
  assert.equal(value.effectsBeforeState?.beforeStateReference, f.captured.reference)
  assert.equal(value.executable, false)
  assert.equal(value.recoveryAvailable, false)
  assert.equal(value.lockedSnapshot, false)
  value.effectsBeforeState!.counts.records = 99
  assert.equal(
    (await f.store.readEffects(captured.reference, f.captured.binding)).effects.counts.records,
    3
  )
})

test("command preparation rejects missing and cross-linked effect evidence before either fresh reader", async (t) => {
  const f = await fixture(t),
    effects = await f.invoke(),
    captured = await f.store.captureEffects(
      f.captured.reference,
      f.captured.binding,
      async () => effects
    ),
    other = await f.store.capture(async () => ({ ...f.state, warning: "different evidence" }))
  let reads = 0
  const stateReader = async () => {
      reads++
      return f.state
    },
    effectsReader = async () => {
      reads++
      return effects
    }
  await assert.rejects(
    prepareConfigurationBcCommand(f.request, f.captured.binding, f.store, stateReader, {
      reference: "f".repeat(64),
      readCurrent: effectsReader
    }),
    /ENOENT/
  )
  await assert.rejects(
    prepareConfigurationBcCommand(
      { ...f.request, beforeStateReference: other.reference },
      f.captured.binding,
      f.store,
      stateReader,
      { reference: captured.reference, readCurrent: effectsReader }
    ),
    /EFFECTS_BINDING_INVALID/
  )
  await assert.rejects(
    prepareConfigurationBcCommand(
      f.request,
      { ...f.captured.binding, user: "OTHER" },
      f.store,
      stateReader,
      { reference: captured.reference, readCurrent: effectsReader }
    ),
    /BINDING_INVALID/
  )
  assert.equal(reads, 0)
})

test("command preparation rejects valid changed effect bytes and propagates fresh reader failure", async (t) => {
  const f = await fixture(t),
    effects = await f.invoke(),
    captured = await f.store.captureEffects(
      f.captured.reference,
      f.captured.binding,
      async () => effects
    ),
    changed = structuredClone(effects),
    bytes = Buffer.concat([Buffer.from(changed.buffer.data, "base64"), Buffer.from("changed")])
  changed.buffer.data = bytes.toString("base64")
  changed.buffer.bytes = bytes.length
  changed.effectsVersion = createHash("sha256").update(bytes).digest("hex")
  await assert.rejects(
    prepareConfigurationBcCommand(f.request, f.captured.binding, f.store, async () => f.state, {
      reference: captured.reference,
      readCurrent: async () => changed
    }),
    /EFFECTS_CHANGED/
  )
  await assert.rejects(
    prepareConfigurationBcCommand(f.request, f.captured.binding, f.store, async () => f.state, {
      reference: captured.reference,
      readCurrent: async () => {
        throw Error("fresh effects failed")
      }
    }),
    /fresh effects failed/
  )
  assert.deepEqual(
    (await f.store.readEffects(captured.reference, f.captured.binding)).effects,
    effects
  )
})

test("effects capture publishes immutable linked evidence and preserves format1 and concurrent capture", async (t) => {
  const f = await fixture(t),
    effects = await f.invoke()
  const oldFile = join(f.root, "configuration-bc-before-state", f.captured.reference + ".json")
  const before = await readFile(oldFile)
  const captures = await Promise.all(
    Array.from({ length: 4 }, () =>
      f.store.captureEffects(f.captured.reference, f.captured.binding, async () => effects)
    )
  )
  assert.equal(new Set(captures.map((v) => v.reference)).size, 1)
  const captured = captures[0]!
  assert.equal(captured.recoveryPermit, false)
  assert.equal(captured.executable, false)
  assert.equal(captured.snapshot, false)
  const result = await f.store.readEffects(captured.reference, f.captured.binding)
  assert.deepEqual(result.effects, effects)
  assert.deepEqual(result.state, f.state)
  assert.equal(result.beforeStateReference, f.captured.reference)
  assert.deepEqual(await readFile(oldFile), before)
  effects.buffer.data = "AAAA"
  assert.notEqual(
    (await f.store.readEffects(captured.reference, f.captured.binding)).effects.buffer.data,
    effects.buffer.data
  )
})

test("effects store rejects identity changes, recomputed unsafe evidence, broken links and changed native bytes", async (t) => {
  const f = await fixture(t),
    effects = await f.invoke()
  let reads = 0
  await assert.rejects(
    f.store.captureEffects(
      f.captured.reference,
      { ...f.captured.binding, user: "OTHER" },
      async () => {
        reads++
        return effects
      }
    )
  )
  assert.equal(reads, 0)
  for (const patch of [
    { ...effects, ctsVersion: "f".repeat(64) },
    { ...effects, executable: true },
    { ...effects, counts: { ...effects.counts, records: 0 } },
    { ...effects, buffer: { ...effects.buffer, data: "AAAA" } }
  ])
    await assert.rejects(
      f.store.captureEffects(
        f.captured.reference,
        f.captured.binding,
        async () => patch as typeof effects
      )
    )
  const captured = await f.store.captureEffects(
    f.captured.reference,
    f.captured.binding,
    async () => effects
  )
  const file = join(f.root, "configuration-bc-before-state", captured.reference + ".json")
  const envelope = JSON.parse(await readFile(file, "utf8"))
  envelope.effects.buffer.recoveryPermit = true
  await writeFile(file, JSON.stringify(envelope))
  await assert.rejects(f.store.readEffects(captured.reference, f.captured.binding), /CORRUPT/)
  envelope.id = hashWriteInput({
    beforeStateReference: envelope.beforeStateReference,
    effects: envelope.effects
  })
  await writeFile(
    join(f.root, "configuration-bc-before-state", envelope.id + ".json"),
    JSON.stringify(envelope)
  )
  await assert.rejects(f.store.readEffects(envelope.id, f.captured.binding), /EVIDENCE_INVALID/)
  await rm(join(f.root, "configuration-bc-before-state", f.captured.reference + ".json"))
  await assert.rejects(f.store.readEffects(envelope.id, f.captured.binding), /ENOENT/)
})

test("public effects MCP exposes fixed readonly inputs, links immutable evidence and retracts failures", async (t) => {
  const f = await fixture(t),
    backend = new MockBackend()
  const old = {
    definition: ToolService.prototype.readFunctionModuleInterface,
    table: ToolService.prototype.readDdicTransparentTable,
    exportRoot: process.env.ABAP_MCP_EXPORT_ROOT
  }
  process.env.ABAP_MCP_EXPORT_ROOT = f.root
  ToolService.prototype.readFunctionModuleInterface = async ({ functionName }) =>
    JSON.stringify(await f.readers.definition(functionName))
  ToolService.prototype.readDdicTransparentTable = async ({ objectName }) =>
    JSON.stringify(await f.readers.table(objectName))
  const details = backend.connectionDetails.bind(backend)
  backend.connectionDetails = (id) => ({ ...details(id), client: "200", username: "wys" })
  backend.callRemoteFunction = f.backend.callRemoteFunction
  const historical = JSON.parse(
    readFileSync(
      new URL(
        "../../docs/workspace-evidence/.doc/orvanta-configuration-bc-effects-development-20261006-091423-r58.json",
        import.meta.url
      ),
      "utf8"
    )
  )
  // Reconstruct the historical source's CRLF bytes and verify their pinned raw-source digest.
  const source = /```abap\n([\s\S]*?)\n```/
    .exec(historical.descriptorFormFullSource.text)![1]!
    .replaceAll("\n", "\r\n")
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    configurationBcEffectsInclude.sourceFingerprint
  )
  backend.readSourceByUri = async (id, uri) => {
    assert.equal(id, "w200")
    assert.equal(uri, configurationBcEffectsInclude.sourceUri)
    return { source, uriUsed: uri }
  }
  backend.runQuery = async () => {
    throw Error("No query fallback")
  }
  backend.callSapHelper = async () => {
    throw Error("No helper fallback")
  }
  const server = await startHttpServer(backend, 0, f.root),
    client = new Client({ name: "effects-public-contract", version: "r60" })
  t.after(async () => {
    ToolService.prototype.readFunctionModuleInterface = old.definition
    ToolService.prototype.readDdicTransparentTable = old.table
    if (old.exportRoot === undefined) delete process.env.ABAP_MCP_EXPORT_ROOT
    else process.env.ABAP_MCP_EXPORT_ROOT = old.exportRoot
    await client.close()
    await server.closeIfIdle()
  })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.mcpUrl)) as Parameters<Client["connect"]>[0]
  )
  const tool = (await client.listTools()).tools.find(
    (v) => v.name === "read_configuration_bc_effects"
  )!
  assert(tool)
  assert.equal(tool.inputSchema.additionalProperties, false)
  assert.equal(tool.annotations?.readOnlyHint, true)
  assert.equal(tool.annotations?.destructiveHint, false)
  assert.deepEqual([...(tool.inputSchema.required ?? [])].sort(), Object.keys(f.request).sort())
  const call = (arguments_: Record<string, unknown>) =>
    client.callTool({ name: tool.name, arguments: arguments_ })
  const positive = await call(f.request)
  assert(!positive.isError)
  const value = JSON.parse((positive.content as { text: string }[])[0]!.text)
  assert.equal(value.buffer.recoveryPermit, false)
  assert.equal(value.snapshot, false)
  const persisted = await f.store.readEffects(value.effectsStateReference, f.captured.binding)
  assert.equal(persisted.effects.effectsVersion, value.effectsVersion)
  const calls = f.calls,
    metadata = f.definitionReads
  for (const patch of [
    { connectionId: "w300" },
    { execute: true },
    { buffer: "AAAA" },
    { tableName: "SCPRACTR" },
    { beforeStateReference: "../outside" }
  ])
    assert.equal((await call({ ...f.request, ...patch })).isError, true)
  assert.equal(f.calls, calls)
  assert.equal(f.definitionReads, metadata)
  const sourceReader = backend.readSourceByUri
  backend.readSourceByUri = async (id, uri) => ({
    ...(await sourceReader(id, uri)),
    uriUsed: "/sap/bc/adt/functions/groups/other/includes/other/source/main"
  })
  const wrongSource = await call(f.request)
  assert.equal(wrongSource.isError, true)
  assert(!JSON.stringify(wrongSource.content).includes('"effectsStateReference"'))
  assert.equal(f.calls, calls)
  backend.readSourceByUri = sourceReader
  f.native.EV_CODE = "KEY_SCOPE_INVALID"
  const rejected = await call(f.request)
  assert.equal(rejected.isError, true)
  assert(!JSON.stringify(rejected.content).includes('"effectsStateReference"'))
})

test("effects read is one fixed dispatch with full source/layout bracketing and no permit", async (t) => {
  const f = await fixture(t),
    v = await f.invoke()
  assert.equal(f.calls, 1)
  assert.equal(f.tableReads, Object.keys(configurationBcEffectsAllLayouts).length * 2)
  assert.equal(f.includeReads, 2)
  assert.equal(f.definitionReads, (Object.keys(configurationBcEffectsDependencies).length + 2) * 2)
  assert.deepEqual(v.counts, { matched: 2, records: 3, headers: 2, variables: 1, links: 0 })
  assert.equal(v.profileCount, 3)
  assert.equal(v.buffer.data, f.bytes.toString("base64"))
  assert.equal(v.buffer.recoveryPermit, false)
  for (const flag of [
    "snapshot",
    "executable",
    "activationAvailable",
    "recoveryAvailable",
    "currentStateRechecked",
    "ctsRecoveryChecked"
  ] as const)
    assert.equal(v[flag], false)
})

for (const patch of [
  { connectionId: "w300" },
  { bcSetId: "OTHER" },
  { version: "A" },
  { requestNumber: "GR2K923472" },
  { taskNumber: "GR2K923492" },
  { tableName: "SCPRACTR" },
  { IV_CTS_VERSION: "a".repeat(64) },
  { buffer: "AAAA" },
  { execute: true },
  { beforeStateReference: "a".repeat(64) }
])
  test(`reject input ${Object.keys(patch)[0]} before native dispatch`, async (t) => {
    const f = await fixture(t)
    await assert.rejects(f.invoke({ ...f.request, ...patch }))
    assert.equal(f.calls, 0)
    assert.equal(f.definitionReads, 0)
  })

test("immutable state cannot be read under another authenticated user", async (t) => {
  const f = await fixture(t)
  await assert.rejects(f.invoke(f.request, { ...f.captured.binding, user: "OTHER" }))
  assert.equal(f.calls, 0)
})

test("repository descriptions and parameter ordering preserve the exact signature", async (t) => {
  const f = await fixture(t)
  const v = {
    ...f.definition,
    importParameters: [...f.definition.importParameters]
      .reverse()
      .map((p) => ({ ...p, description: "" })),
    exportParameters: f.definition.exportParameters.map((p) => ({ ...p, description: "只读" }))
  }
  assert.doesNotThrow(() => attestConfigurationBcEffectsApi(v))
  for (const patch of [
    { remoteEnabled: false },
    { updateTask: true },
    { updateTaskMode: "V1" },
    { changingParameters: [{ name: "WRITE" }] },
    { source: [...v.source, "COMMIT WORK."] },
    { importParameters: v.importParameters.map((p) => ({ ...p, optional: true })) },
    { exportParameters: v.exportParameters.map((p) => ({ ...p, passByValue: false })) }
  ])
    assert.throws(() => attestConfigurationBcEffectsApi({ ...v, ...patch }))
})

for (const target of [
  api.functionName,
  configurationBcCtsApi.functionName,
  ...Object.keys(configurationBcEffectsDependencies)
])
  test(`changed dependency ${target} prevents native dispatch`, async (t) => {
    const f = await fixture(t)
    f.setDefinitionPatch((name, v) => {
      if (name !== target) return
      if (target === api.functionName || target === configurationBcCtsApi.functionName)
        v.source = [...(v.source as string[]), "COMMIT WORK."]
      else v.sourceFingerprint = "f".repeat(64)
    })
    await assert.rejects(f.invoke())
    assert.equal(f.calls, 0)
  })

for (const name of ["SCPRACTR", "SCPRACTP", "SCPRACTX", "SCPRACTXL", "T006", "E071K"])
  test(`changed layout ${name} prevents native dispatch`, async (t) => {
    const f = await fixture(t)
    f.setTablePatch((n, v) => {
      if (n === name) v.fingerprint = "f".repeat(64)
    })
    await assert.rejects(f.invoke())
    assert.equal(f.calls, 0)
  })

test("standard FORM drift prevents dispatch even with unchanged function fingerprints", async (t) => {
  const f = await fixture(t)
  f.setIncludePatch((v) => {
    v.sourceFingerprint = "f".repeat(64)
  })
  await assert.rejects(f.invoke())
  assert.equal(f.calls, 0)
})

for (const phase of ["body", "include", "layout", "interface"])
  test(`discard ${phase} drift after call and never retry`, async (t) => {
    const f = await fixture(t)
    f.setDefinitionPatch((name, v) => {
      if (f.calls && name === api.functionName && phase === "body")
        v.source = [...(v.source as string[]), "COMMIT WORK."]
      if (f.calls && name === api.functionName && phase === "interface")
        v.interfaceFingerprint = "f".repeat(64)
    })
    f.setIncludePatch((v) => {
      if (f.calls && phase === "include") v.sourceFingerprint = "f".repeat(64)
    })
    f.setTablePatch((name, v) => {
      if (f.calls && name === "SCPRACTR" && phase === "layout") v.fingerprint = "f".repeat(64)
    })
    await assert.rejects(f.invoke())
    assert.equal(f.calls, 1)
  })

for (const patch of [
  { EV_USER: "OTHER" },
  { EV_SYSTEM: "GR3" },
  { EV_CLIENT: "300" },
  { EV_REQUEST: "GR2K923472" },
  { EV_TASK: "GR2K923492" },
  { EV_CTS_VERSION: "f".repeat(64) },
  { EV_SCOPE_VERSION: "f".repeat(64) },
  { EV_EFFECTS_VERSION: "f".repeat(64) },
  { EV_ROUNDTRIP: "" },
  { EV_DATA_BYTES: "0" },
  { EV_DATA_BYTES: "999999" },
  { EV_DATA_BASE64: "AAAA\n" },
  { EV_ROW_COUNTS: "matched=513;records=513;headers=0;variables=0;links=0;" },
  { EV_ROW_COUNTS: "matched=02;records=3;headers=2;variables=1;links=0;" },
  { EV_ROW_COUNTS: "matched=4;records=3;headers=2;variables=1;links=0;" },
  { EV_ROW_COUNTS: "records=3;matched=2;headers=2;variables=1;links=0;" },
  { EV_ROW_COUNTS: "matched=2;records=3;headers=2;variables=1;links=0" },
  { EV_PROFILE_COUNT: "33" },
  { EV_PROFILE_COUNT: "0" },
  { EV_PROFILE_COUNT: "4" },
  { EV_CODE: "READ_CHANGED" },
  { EV_CODE: "VERSION_CONFLICT" },
  { EV_CODE: "<untrusted message>" },
  { UNKNOWN: "1" }
])
  test(`reject response ${Object.entries(patch)[0]?.join("=")}`, async (t) => {
    const f = await fixture(t)
    Object.assign(f.native, patch)
    await assert.rejects(f.invoke())
    assert.equal(f.calls, 1)
  })

test("fault and transport rejection cannot trigger a second native dispatch", async (t) => {
  const f = await fixture(t)
  f.setFault()
  await assert.rejects(f.invoke(), /CONFIGURATION_BC_EFFECTS_FAULT/)
  assert.equal(f.calls, 1)
})

test("zero matched records still capture the current profile; empty tables are valid", async (t) => {
  const f = await fixture(t)
  f.native.EV_ROW_COUNTS = "matched=0;records=0;headers=0;variables=0;links=0;"
  f.native.EV_PROFILE_COUNT = "1"
  assert.deepEqual((await f.invoke()).counts, {
    matched: 0,
    records: 0,
    headers: 0,
    variables: 0,
    links: 0
  })
})

test("generated ECC source has fixed native keys and only the four read dependencies", () => {
  assert.equal(configurationBcPreflightKeys.length, 19)
  const source = api.source.join("\n")
  assert.deepEqual(
    [...new Set([...source.matchAll(/CALL FUNCTION '([^']+)'/g)].map((m) => m[1]))].sort(),
    [
      "Z_ORVANTA_CFG_BC_CTS",
      "SCPR_HI_KEY_TO_ACTKEY",
      "CALCULATE_HASH_FOR_RAW",
      "SCMS_BASE64_ENCODE_STR"
    ].sort()
  )
  assert.ok(
    api.source.every((line) => line.length <= 72),
    "RSSOURCE line overflow"
  )
  assert.doesNotMatch(
    source,
    /\b(COMMIT WORK|ROLLBACK WORK|INSERT INTO|MODIFY\s+\w+|UPDATE\s+\w+|DELETE FROM|ENQUEUE_|DEQUEUE_|ACTIVAT|SIMULAT)\b/i
  )
  assert.doesNotMatch(source, /\b(DATA\(|VALUE\s*\(|NEW\s*\(|COND\s*\(|@\w+)/i)
  assert.doesNotMatch(source, /CONCATENATE\s+\w+\s+INTO/i)
  assert.match(source, /lv_count <> 19[\s\S]+FOR ALL ENTRIES IN lt_scope/)
  assert.match(source, /lv_profiles = 0 OR lv_profiles > 32[\s\S]+FOR ALL ENTRIES IN lt_profiles/)
  assert.equal((source.match(/UP TO 513 ROWS/g) ?? []).length, 5)
  assert.equal((source.match(/lv_count > 512/g) ?? []).length, 5)
  assert.match(source, /SORT lt_records BY client tablename tabrecnumb/)
  assert.match(source, /ls_full_record <> ls_record/)
  assert.match(source, /ls_scope-tabkey <> lv_expected/)
  assert.match(source, /lv_type NA 'CN'/)
  assert.match(source, /DO 2 TIMES[\s\S]+lv_first <> lv_buffer/)
  assert.match(source, /lv_roundtrip <> lv_buffer/)
  for (const { tableName, key } of configurationBcPreflightKeys)
    for (const [field, value] of Object.entries(key))
      assert.ok(
        source.includes(`ls_${tableName.toLowerCase()}-${field.toLowerCase()} = '${value}'.`)
      )
})
