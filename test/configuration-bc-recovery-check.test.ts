import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { ConfigurationBcBeforeStateStore } from "../src/configuration-bc-before-state-store.js"
import { configurationBcRecoveryCheckApi as api } from "../src/configuration-bc-recovery-check-api.js"
import {
  attestConfigurationBcRecoveryCheckApi,
  checkConfigurationBcRecovery,
  configurationBcRecoveryDependencies
} from "../src/configuration-bc-recovery-check.js"
import { configurationBcPreflightKeys } from "../src/configuration-bc-preflight.js"
import { configurationBcNativeLayouts } from "../src/configuration-bc-native-api.js"
import { configurationBcGuardLayouts } from "../src/configuration-bc-guard-api.js"
import { configurationBcStateTables } from "../src/configuration-bc-state-api.js"
import { stateFixture } from "./configuration-bc-state-fixture.js"

// Historical state replay with synthetic proof bytes; never SAP serialization acceptance.
async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "orvanta-bc-recovery-check-"))
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  t.after(() => rm(root, { recursive: true, force: true }))
  const state = await (await stateFixture()).invoke(),
    store = new ConfigurationBcBeforeStateStore(root)
  const captured = await store.capture(async () => state)
  const request = {
    connectionId: "w200",
    bcSetId: "EHS_CUNI_KNM",
    version: "N",
    requestNumber: "GR2K923429",
    taskNumber: "GR2K923430",
    operationId: "r55-check-001",
    beforeStateReference: captured.reference
  }
  const definition = {
    ...api,
    connectionId: "w200",
    updateTask: false,
    updateTaskMode: "",
    tableParameters: [],
    changingParameters: [],
    exceptions: [],
    source: [`FUNCTION ${api.functionName}.`, ...api.source, "ENDFUNCTION."],
    sourceFingerprint: "a".repeat(64),
    interfaceFingerprint: "b".repeat(64)
  }
  const proof = Buffer.from("synthetic-proof-only-not-an-ABAP-export")
  const seen: Record<string, number> = {}
  const native: Record<string, string> = {
    EV_CODE: "RECOVERY_CHECK_OK",
    EV_SYSTEM: "GR2",
    EV_CLIENT: "200",
    EV_USER: "WYS",
    EV_STATE_VERSION: state.versions.state,
    EV_LAYOUT_VERSION: state.layoutFingerprint,
    EV_ROW_COUNTS: configurationBcStateTables
      .map((name) => `${name}=${state.counts[name]};`)
      .join(""),
    EV_ROW_PROOFS: configurationBcPreflightKeys
      .map(({ tableName }, i) => {
        const n = (seen[tableName] = (seen[tableName] ?? 0) + 1)
        const sha = createHash("sha256").update(`synthetic row ${i}`).digest("hex")
        return `${i + 1}|${tableName}|${n <= (state.counts[tableName] ?? 0) ? "X" : " "}|${sha}|${sha}`
      })
      .join("\n"),
    EV_PROOF_BASE64: proof.toString("base64"),
    EV_PROOF_VERSION: createHash("sha256").update(proof).digest("hex"),
    EV_ROUNDTRIP: "X"
  }
  let calls = 0,
    definitions = 0,
    standards = 0,
    tables = 0
  let tablePatch = (_: { fingerprint: string }, _name: string) => {}
  let definitionPatch = (_: typeof definition) => {}
  let standardPatch = (
    _: { sourceFingerprint: string; interfaceFingerprint: string },
    _name: string
  ) => {}
  const readers = {
    definition: async () => {
      definitions++
      const v = structuredClone(definition)
      definitionPatch(v)
      return v
    },
    tableDefinition: async (name: string) => {
      tables++
      const v = { connectionId: "w200", objectName: name, fingerprint: state.layouts[name]! }
      tablePatch(v, name)
      return v
    },
    standardDefinition: async (name: string) => {
      standards++
      const pin =
        configurationBcRecoveryDependencies[
          name as keyof typeof configurationBcRecoveryDependencies
        ]
      assert.ok(pin)
      const v = {
        connectionId: "w200",
        functionName: name,
        sourceFingerprint: String(pin.source),
        interfaceFingerprint: String(pin.interface)
      }
      standardPatch(v, name)
      return v
    }
  }
  const backend = {
    callRemoteFunction: async (
      ...args: Parameters<Parameters<typeof checkConfigurationBcRecovery>[3]["callRemoteFunction"]>
    ) => {
      calls++
      assert.equal(args[0], "w200")
      assert.equal(args[1].functionName, api.functionName)
      assert.equal(args[1].inputParameters.IV_DATA_BASE64, state.buffer.data)
      assert.equal(args[1].inputParameters.IV_STATE_VERSION, state.versions.state)
      assert.deepEqual(
        args[1].outputParameters,
        api.exportParameters.map((p) => ({ name: p.name, kind: "scalar" }))
      )
      return { outputs: structuredClone(native) }
    }
  }
  return {
    root,
    request,
    captured,
    state,
    native,
    definition,
    backend,
    readers,
    store,
    invoke: (raw: unknown = request, binding = captured.binding) =>
      checkConfigurationBcRecovery(raw, binding, store, backend, readers),
    patchDefinition: (patch: typeof definitionPatch) => {
      definitionPatch = patch
    },
    patchStandard: (patch: typeof standardPatch) => {
      standardPatch = patch
    },
    patchTable: (patch: typeof tablePatch) => {
      tablePatch = patch
    },
    get tables() {
      return tables
    },
    get calls() {
      return calls
    },
    get definitions() {
      return definitions
    },
    get standards() {
      return standards
    }
  }
}

test("live repository parameter descriptions do not change the attested signature", async (t) => {
  const f = await setup(t)
  const live = {
    ...f.definition,
    importParameters: f.definition.importParameters.map((p) => ({ ...p, description: "" })),
    exportParameters: f.definition.exportParameters.map((p) => ({
      ...p,
      description: "Repository display text"
    }))
  }
  assert.deepEqual(attestConfigurationBcRecoveryCheckApi(live), {
    source: f.definition.sourceFingerprint,
    interface: f.definition.interfaceFingerprint
  })
  assert.throws(() =>
    attestConfigurationBcRecoveryCheckApi({
      ...live,
      importParameters: live.importParameters.map((p, i) =>
        i === 0 ? { ...p, optional: true } : p
      )
    })
  )
  assert.throws(() =>
    attestConfigurationBcRecoveryCheckApi({
      ...live,
      exportParameters: live.exportParameters.map((p, i) =>
        i === 0 ? { ...p, undocumentedControl: true } : p
      )
    })
  )
})

test("conversion check loads only immutable native before-state, brackets source checks and grants no recovery", async (t) => {
  const f = await setup(t),
    path = join(f.root, "configuration-bc-before-state", `${f.captured.reference}.json`),
    bytes = await readFile(path)
  const r = await f.invoke()
  assert.equal(f.calls, 1)
  assert.equal(f.definitions, 2)
  assert.equal(f.standards, 20)
  assert.equal(f.tables, 18)
  assert.equal(r.readOnly, true)
  assert.equal(r.nativeValueRoundtrip, true)
  for (const flag of [
    "executable",
    "snapshot",
    "recoveryAvailable",
    "currentStateRechecked",
    "missingRowDeletionExecuted",
    "ctsRecoveryChecked"
  ] as const)
    assert.equal(r[flag], false)
  assert.equal(r.rows.length, 19)
  assert.deepEqual(r.counts, f.state.counts)
  assert.equal("buffer" in r, false)
  assert.equal("data" in r.proof, false)
  assert.deepEqual(await readFile(path), bytes)
})

test("untrusted bytes, write flags, scope drift and foreign users cannot reach SAP", async (t) => {
  const f = await setup(t)
  for (const patch of [
    { dataBase64: "AAAA" },
    { allowWrite: true },
    { approved: true },
    { connectionId: "w300" },
    { taskNumber: "GR2K923492" },
    { beforeStateReference: "../escape" }
  ])
    await assert.rejects(f.invoke({ ...f.request, ...patch }))
  await assert.rejects(
    f.invoke(f.request, { ...f.captured.binding, user: "OTHER" }),
    /BINDING_INVALID/
  )
  await assert.rejects(f.invoke({ ...f.request, beforeStateReference: "c".repeat(64) }), /ENOENT/)
  assert.equal(f.calls, 0)
  assert.equal(f.definitions, 0)
  assert.equal(f.standards, 0)
})

for (const kind of ["body", "signature", "updateTask", "remote", "group"] as const)
  test(`native ${kind} drift fails before invocation`, async (t) => {
    const f = await setup(t)
    f.patchDefinition((v) => {
      if (kind === "body") v.source.splice(2, 0, "COMMIT WORK.")
      if (kind === "signature")
        v.importParameters = [
          ...v.importParameters,
          { ...v.importParameters[0]!, name: "IV_ALLOW_WRITE" }
        ] as typeof v.importParameters
      if (kind === "updateTask") v.updateTask = true
      if (kind === "remote") Object.assign(v, { remoteEnabled: false })
      if (kind === "group") Object.assign(v, { functionGroup: "OTHER" })
    })
    await assert.rejects(f.invoke())
    assert.equal(f.calls, 0)
  })

test("standard conversion source/interface drift and failed metadata reads block native dispatch", async (t) => {
  const f = await setup(t)
  for (const field of ["sourceFingerprint", "interfaceFingerprint"] as const) {
    f.patchStandard((v, name) => {
      if (name === "SCPR_CT_VALUE_CONV_EXT_INT_STR") v[field] = "c".repeat(64)
    })
    await assert.rejects(f.invoke(), /DEPENDENCY_NOT_ATTESTED/)
  }
  f.patchStandard(() => {
    throw Error("SAP metadata unavailable")
  })
  await assert.rejects(f.invoke(), /SAP metadata unavailable/)
  assert.equal(f.calls, 0)
})

test("changed DDIC definitions cannot reuse a stored before-state, before or after conversion", async (t) => {
  const f = await setup(t)
  f.patchTable((v, name) => {
    if (name === "T006") v.fingerprint = "c".repeat(64)
  })
  await assert.rejects(f.invoke(), /LAYOUT_NOT_ATTESTED/)
  assert.equal(f.calls, 0)
  f.patchTable((v, name) => {
    if (f.calls && name === "T006D") v.fingerprint = "c".repeat(64)
  })
  await assert.rejects(f.invoke(), /LAYOUT_NOT_ATTESTED/)
  assert.equal(f.calls, 1)
})

test("candidate or conversion code changes during invocation discard success", async (t) => {
  const f = await setup(t)
  f.patchDefinition((v) => {
    if (f.calls) v.interfaceFingerprint = "c".repeat(64)
  })
  await assert.rejects(f.invoke(), /API_CHANGED/)
  f.patchDefinition(() => {})
  f.patchStandard((v, name) => {
    if (f.calls > 1 && name === "VIEW_CONVERSION_OUTPUT") v.sourceFingerprint = "c".repeat(64)
  })
  await assert.rejects(f.invoke(), /DEPENDENCY_NOT_ATTESTED/)
  assert.equal(f.calls, 2)
})

for (const code of [
  "ROUNDTRIP_LOSSY",
  "DESCRIPTOR_UNSUPPORTED",
  "AUTHORIZATION_DENIED",
  "CONVERSION_FAILED",
  "ROW_SCOPE_INVALID"
])
  test(`native ${code} is preserved without retry or permissive fallback`, async (t) => {
    const f = await setup(t)
    f.native.EV_CODE = code
    await assert.rejects(f.invoke(), new RegExp(code))
    assert.equal(f.calls, 1)
  })

test("unknown native error text and SOAP faults are sanitized", async (t) => {
  const f = await setup(t)
  f.native.EV_CODE = "secret arbitrary error text"
  await assert.rejects(f.invoke(), /INVALID_RESPONSE/)
  await assert.rejects(
    checkConfigurationBcRecovery(
      f.request,
      f.captured.binding,
      f.store,
      {
        callRemoteFunction: async () => ({
          outputs: {},
          fault: { code: "SOAP", name: "SOAP fault", message: "secret" }
        })
      },
      f.readers
    ),
    /RECOVERY_CHECK_FAULT/
  )
})

for (const patch of [
  { EV_USER: "OTHER" },
  { EV_CLIENT: "300" },
  { EV_STATE_VERSION: "c".repeat(64) },
  { EV_LAYOUT_VERSION: "c".repeat(64) },
  { EV_ROW_COUNTS: "T006=19;" },
  { EV_ROUNDTRIP: "" },
  { EV_PROOF_BASE64: "!!!!" },
  { EV_PROOF_VERSION: "c".repeat(64) },
  { EV_UNEXPECTED_WRITE: "X" }
])
  test(`malformed or foreign output ${Object.keys(patch)[0]} is rejected`, async (t) => {
    const f = await setup(t)
    Object.assign(f.native, patch)
    await assert.rejects(f.invoke())
  })

for (const kind of [
  "lostRow",
  "duplicateRow",
  "reordered",
  "lossy",
  "presence",
  "noncanonicalBase64"
] as const)
  test(`proof ${kind} cannot establish a recovery-value result`, async (t) => {
    const f = await setup(t),
      rows = f.native.EV_ROW_PROOFS!.split("\n")
    if (kind === "lostRow") rows.pop()
    if (kind === "duplicateRow") rows[1] = rows[0]!
    if (kind === "reordered") [rows[0], rows[1]] = [rows[1]!, rows[0]!]
    if (kind === "lossy") {
      const p = rows[0]!.split("|")
      p[4] = "c".repeat(64)
      rows[0] = p.join("|")
    }
    if (kind === "presence") {
      const p = rows[0]!.split("|")
      p[2] = p[2] === "X" ? " " : "X"
      rows[0] = p.join("|")
    }
    if (kind === "noncanonicalBase64") f.native.EV_PROOF_BASE64 += "\n"
    f.native.EV_ROW_PROOFS = rows.join("\n")
    await assert.rejects(f.invoke())
  })

test("field list generation preserves DDIC order with valid single or multiple ABAP operands", () => {
  const layouts = { ...configurationBcNativeLayouts, ...configurationBcGuardLayouts }
  const source = api.source.join("\n")
  const cases = /CASE lv_index\.([\s\S]*?)ENDCASE\./.exec(source)![1]!
  for (const [i, { tableName }] of configurationBcPreflightKeys.entries()) {
    const branch = new RegExp(`WHEN ${i + 1}\\.([\\s\\S]*?)(?=WHEN |$)`).exec(cases)![1]!
    const assignment = /lv_expected = '([^']*)'\./.exec(branch)
    let fields: string
    if (assignment) fields = assignment[1]!
    else {
      const concatenate = /CONCATENATE([\s\S]*?)INTO lv_expected\./.exec(branch)![1]!
      const operands = [...concatenate.matchAll(/'([^']*)'/g)].map((m) => m[1]!)
      // The native compiler rejects CONCATENATE with a single source operand.
      assert.ok(operands.length >= 2, tableName)
      fields = operands.join("")
    }
    assert.equal(fields, layouts[tableName as keyof typeof layouts].fields.join(","))
  }
})

test("candidate has a closed read/conversion call graph and rejects data drift before conversion", () => {
  const source = api.source.join("\n")
  for (const banned of [
    /^\s*(?:FUNCTION|ENDFUNCTION)\b/im,
    /\bCOMMIT\b/i,
    /\bROLLBACK\b/i,
    /\b(?:UPDATE|MODIFY|INSERT|DELETE)\s+/i,
    /\bCALL\s+(?:SCREEN|TRANSACTION)\b/i,
    /\bENQUEUE_/i,
    /\bDEQUEUE_/i,
    /CALL FUNCTION\s+\(/i,
    /\b(?:ACTIVATE|ONE_TABLE_LOAD|SCPR_HI_|VIEW_MARK_WRITE)\b/i
  ])
    assert.doesNotMatch(source, banned)
  const calls = [...source.matchAll(/CALL FUNCTION '([^']+)'/g)].map((m) => m[1]!)
  assert.ok(calls.every((name) => name in configurationBcRecoveryDependencies))
  assert.ok(source.indexOf("ROW_SCOPE_INVALID") < source.indexOf("SCPR_CT_VALUE_CONVERT_INT_EXT"))
  assert.ok(source.indexOf("AUTHORITY-CHECK") < source.indexOf("FROM DATA BUFFER"))
  assert.ok(source.includes("lv_names <> lv_expected"))
  assert.ok(source.includes("IF lv_before <> lv_after."))
  assert.ok(source.includes("values_in_int_format = space"))
  assert.equal(api.source.filter((line) => line.startsWith("    WHEN ")).length, 28)
  assert.equal(api.source.filter((line) => line.length > 72).length, 0)
  assert.ok(
    [...api.importParameters, ...api.exportParameters].every(
      (p) => p.typeName === "STRING" && p.passByValue && !p.optional
    )
  )
})
