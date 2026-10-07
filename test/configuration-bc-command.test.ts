import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { stateFixture } from "./configuration-bc-state-fixture.js"
import { ConfigurationBcBeforeStateStore } from "../src/configuration-bc-before-state-store.js"
import { ConfigurationBcExecutionStore } from "../src/configuration-bc-execution-store.js"
import { WriteOperationReceiptStore, hashWriteInput } from "../src/write-operation-receipts.js"
import {
  configurationBcEffectsApi,
  configurationBcEffectsScope
} from "../src/configuration-bc-effects-api.js"
import {
  configurationBcEffectsBodyFingerprint,
  configurationBcEffectsAllLayouts,
  configurationBcEffectsDependencies,
  configurationBcEffectsInclude,
  type ConfigurationBcEffectsEvidence
} from "../src/configuration-bc-effects.js"
import {
  configurationBcApplyApi,
  configurationBcRecoverApi,
  configurationBcReconcileApi,
  configurationBcOwnerInclude
} from "../src/configuration-bc-owner-api.js"
import { configurationBcRecordKernel } from "../src/configuration-bc-record-kernel.js"
import {
  configurationBcOwnerFunctionPins,
  configurationBcOwnerLayoutPins
} from "../src/configuration-bc-owner-pins.js"
import { configurationBcStateApi } from "../src/configuration-bc-state-api.js"
import { configurationBcRecoveryCheckApi } from "../src/configuration-bc-recovery-check-api.js"
import { configurationBcNativeReadApi } from "../src/configuration-bc-native-api.js"
import { configurationBcPreviewApi } from "../src/configuration-bc-preview-api.js"
import { configurationBcRouteApi } from "../src/configuration-bc-route-api.js"
import { configurationBcGuardApi } from "../src/configuration-bc-guard-api.js"
import { configurationBcCtsApi } from "../src/configuration-bc-cts-api.js"
import {
  executeConfigurationBcCommand,
  reconcileConfigurationBcExecution,
  configurationBcNativeReplySchema,
  type ConfigurationBcCommandEnvironment
} from "../src/configuration-bc-command.js"

const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex")
const apis = [
  configurationBcApplyApi,
  configurationBcRecoverApi,
  configurationBcReconcileApi,
  configurationBcStateApi,
  configurationBcRecoveryCheckApi,
  configurationBcEffectsApi,
  configurationBcNativeReadApi,
  configurationBcPreviewApi,
  configurationBcRouteApi,
  configurationBcGuardApi,
  configurationBcCtsApi
]

import { bcCommandFixture } from "./configuration-bc-command-fixture.js"

test("one durable intent/receipt dispatch, exact applied frame, duplicate never replayed, bound recovery", async (t) => {
  const f = await bcCommandFixture(t),
    applied = await f.apply()
  assert.equal(applied.status, "applied")
  assert.equal(applied.outcomeMayBeUnknown, false)
  const receipt = await f.env.receipts.status("w200", f.request.operationId)
  assert.equal(receipt.status, "completed")
  assert.equal(receipt.localLockReleased, true)
  assert.equal((await f.apply()).status, "protection_refused")
  assert.equal(f.calls.length, 1)
  const recovered = await f.recover(String(receipt.receiptHash))
  assert.equal(recovered.status, "recovered")
  assert.deepEqual(f.calls, [
    configurationBcApplyApi.functionName,
    configurationBcRecoverApi.functionName
  ])
  assert.equal(JSON.stringify(recovered).includes("FRAME_BASE64"), false)
})
test("twelve simultaneous operations dispatch at most once with the shared CUNI target", async (t) => {
  const f = await bcCommandFixture(t)
  const all = await Promise.all(Array.from({ length: 12 }, () => f.apply()))
  assert.equal(all.filter((r) => r.status === "applied").length, 1)
  assert.equal(f.calls.length, 1)
})
for (const [name, patch] of Object.entries({
  wrongActor: { EV_USER: "OTHER" },
  wrongReference: { EV_BEFORE_REFERENCE: "f".repeat(64) },
  badFrame: { EV_FRAME_VERSION: "f".repeat(64) },
  protectedChanged: { EV_PROTECTED: "unknown" },
  ctsChanged: { EV_CTS: "changed" },
  effectsChanged: { EV_EFFECTS: "changed" },
  locksHeld: { EV_LOCKS: "held" },
  protocolUnfinished: { EV_PROTOCOL: "started" },
  missingCommit: { EV_COMMIT: "unknown" },
  configurationPartial: { EV_CONFIGURATION: "other" }
}))
  test(`${name}: no success, target stays protected across new operationId`, async (t) => {
    const f = await bcCommandFixture(t)
    f.setReplyPatch((_n, r) => Object.assign(r, patch))
    assert.equal((await f.apply()).status, "unknown")
    const receipt = await f.env.receipts.status("w200", f.request.operationId)
    assert.equal(receipt.outcomeMayBeUnknown, true)
    assert.equal(receipt.localLockReleased, false)
    const second = await executeConfigurationBcCommand(
      "apply",
      { ...f.request, operationId: "r65-new-id-0002" },
      f.env
    )
    assert.equal(second.status, "protection_refused")
    assert.equal(f.calls.length, 1)
  })
test("transport loss after dispatch never leaks fault secrets and never sends another command", async (t) => {
  const f = await bcCommandFixture(t)
  f.setBeforeCall(async () => {
    throw Error("password=secret cookie=secret transport timeout")
  })
  const r = await f.apply()
  assert.equal(r.status, "unknown")
  assert.equal(JSON.stringify(r).includes("secret"), false)
  assert.equal((await f.apply()).status, "protection_refused")
  assert.equal(f.calls.length, 1)
})
test("standard or customer source drift refuses before SAP and releases only the local reservation", async (t) => {
  const f = await bcCommandFixture(t)
  f.setDefinitionPatch((name, v) => {
    if (name === "TRINT_DELETE_COMM_KEYS") v.sourceFingerprint = "f".repeat(64)
  })
  const r = await f.apply()
  assert.equal(r.status, "declined")
  assert.equal(r.sapInvocationStarted, false)
  assert.equal(f.calls.length, 0)
})
test("receipt pre-dispatch failure invokes no native command", async (t) => {
  const f = await bcCommandFixture(t)
  f.env.receipts.markSapInvocationStarted = async () => {
    throw Error("simulated fsync refusal")
  }
  assert.equal((await f.apply()).status, "declined")
  assert.equal(f.calls.length, 0)
})
test("native cleanup partial commit remains unknown and cannot be replayed or silently recovered", async (t) => {
  const f = await bcCommandFixture(t),
    a = await f.apply(),
    receipt = await f.env.receipts.status("w200", f.request.operationId)
  assert.equal(a.status, "applied")
  f.setReplyPatch((name, r) => {
    if (name === configurationBcRecoverApi.functionName) {
      r.EV_CODE = "CTS_CLEANUP_UNCERTAIN"
      r.EV_PHASE = "cts_cleanup"
      r.EV_CTS = "unknown"
    }
  })
  assert.equal((await f.recover(String(receipt.receiptHash))).status, "unknown")
  assert.equal((await f.recover(String(receipt.receiptHash))).status, "protection_refused")
  assert.equal(f.calls.length, 2)
})
test("read-only reconcile observes native commit while leaving receipt and target protection unchanged", async (t) => {
  const f = await bcCommandFixture(t)
  f.setBeforeCall(async () => {
    throw Error("timeout")
  })
  await f.apply()
  f.setBeforeCall(async () => {})
  const receipt = await f.env.receipts.status("w200", f.request.operationId)
  const r = await reconcileConfigurationBcExecution(
    {
      ...f.request,
      command: "apply",
      expectedReceiptHash: receipt.receiptHash,
      acknowledgeConfigurationWrite: undefined,
      acknowledgeIndependentProtocol: undefined,
      acknowledgeLocalActivationLinks: undefined,
      acknowledgeCtsRecording: undefined
    },
    f.env
  ).catch(() => null)
  // Strict schemas refuse even an omitted-by-undefined write acknowledgement property.
  assert.equal(r, null)
  const request = {
    connectionId: f.request.connectionId,
    bcSetId: f.request.bcSetId,
    version: f.request.version,
    requestNumber: f.request.requestNumber,
    taskNumber: f.request.taskNumber,
    operationId: f.request.operationId,
    beforeStateReference: f.request.beforeStateReference,
    effectsReference: f.request.effectsReference,
    command: "apply",
    expectedReceiptHash: receipt.receiptHash
  }
  const observed = await reconcileConfigurationBcExecution(request, f.env)
  assert.equal(observed.status, "native_commit_observed")
  assert.equal(observed.recoveryAvailable, false)
  assert.deepEqual(await f.env.receipts.status("w200", f.request.operationId), receipt)
  assert.equal((await f.apply()).status, "protection_refused")
})
test("unknown result cannot borrow an applied result's frame to authorize recovery", async (t) => {
  const f = await bcCommandFixture(t)
  await f.apply()
  const receipt = await f.env.receipts.status("w200", f.request.operationId)
  assert.equal((await f.recover("f".repeat(64))).status, "declined")
  assert.equal(f.calls.length, 1)
  const result = await f.env.executions.readAuthenticated(
    sha(f.request.operationId),
    "WYS",
    "result"
  )
  assert.ok(result.hash)
  assert.equal(receipt.status, "completed")
  await assert.rejects(
    f.env.executions.readAuthenticated(sha(f.request.operationId), "OTHER", "result"),
    /BINDING_INVALID/
  )
})
test("tampered immutable intent is rejected by digest before read-only native dispatch", async (t) => {
  const f = await bcCommandFixture(t)
  await f.apply()
  const path = join(
      f.root,
      "configuration-bc-executions",
      `${sha(f.request.operationId)}.intent.json`
    ),
    stored = JSON.parse(await readFile(path, "utf8"))
  stored.value.input.IV_STATE_BASE64 = "AAAA"
  await writeFile(path, JSON.stringify(stored))
  await assert.rejects(
    f.env.executions.readAuthenticated(sha(f.request.operationId), "WYS", "intent"),
    /BINDING_INVALID/
  )
})
test("public schema never accepts raw frames, arbitrary targets or omitted write acknowledgement", async (t) => {
  const f = await bcCommandFixture(t)
  for (const patch of [
    { restoreBytes: "AAAA" },
    { frameBase64: "AAAA" },
    { connectionId: "w300" },
    { bcSetId: "OTHER" },
    { acknowledgeConfigurationWrite: false }
  ])
    await assert.rejects(executeConfigurationBcCommand("apply", { ...f.request, ...patch }, f.env))
  assert.equal(f.calls.length, 0)
})

test("owner generated direct standard/helper calls satisfy actual w200 ABI, not guessed signatures", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/configuration-bc-owner-w200-r65.json", import.meta.url),
      "utf8"
    )
  )
  const known = new Map<string, Record<string, any>>(
    fixture.functions.map((d: any) => [d.functionName, d])
  )
  for (const [name, pin] of Object.entries(configurationBcOwnerFunctionPins)) {
    const actual = known.get(name)
    if (!actual) continue // Older dependency pins are covered by their existing reader tests.
    assert.deepEqual(
      {
        source: actual.sourceFingerprint,
        interface: actual.interfaceFingerprint,
        remoteEnabled: actual.remoteEnabled,
        updateTask: actual.updateTask
      },
      pin,
      `actual standard metadata ${name}`
    )
  }
  for (const api of apis)
    known.set(api.functionName, {
      ...api,
      tableParameters: "tableParameters" in api ? api.tableParameters : [],
      changingParameters: [],
      exceptions: []
    })
  const source = configurationBcOwnerInclude.source.filter((l) => !/^\s*["*]/.test(l)).join("\n")
  for (const call of source.matchAll(/CALL FUNCTION '([^']+)'([\s\S]*?)\./g)) {
    const def = known.get(call[1]!)
    assert.ok(def, `missing actual ABI ${call[1]}`)
    const sections = [
      ...call[2]!.matchAll(
        /\b(EXPORTING|IMPORTING|CHANGING|TABLES|EXCEPTIONS)\b([\s\S]*?)(?=\b(?:EXPORTING|IMPORTING|CHANGING|TABLES|EXCEPTIONS)\b|$)/g
      )
    ]
    const groups = {
      EXPORTING: "importParameters",
      IMPORTING: "exportParameters",
      CHANGING: "changingParameters",
      TABLES: "tableParameters"
    } as const
    const provided = new Set<string>()
    for (const section of sections) {
      if (section[1] === "EXCEPTIONS") continue
      const params = def[groups[section[1] as keyof typeof groups]] as { name: string }[]
      for (const m of section[2]!.matchAll(/\b([a-z_][a-z0-9_]*)\s*=/gi)) {
        const name = m[1]!.toUpperCase()
        provided.add(name)
        assert.ok(
          params.some((p) => p.name === name),
          `${call[1]} ${section[1]} ${name}`
        )
      }
    }
    for (const group of ["importParameters", "changingParameters", "tableParameters"])
      for (const p of def[group] ?? [])
        if (!p.optional) assert.ok(provided.has(p.name), `${call[1]} requires ${p.name}`)
  }
})
test("owner has one top-level config commit, isolated CTS cleanup, exact link ownership and no standard table SQL writes", () => {
  const s = configurationBcOwnerInclude.source.filter((l) => !/^\s*["*]/.test(l)).join("\n")
  assert.equal((s.match(/COMMIT WORK AND WAIT\./g) ?? []).length, 1)
  assert.ok(
    s.indexOf("COMMIT WORK AND WAIT.") < s.indexOf("CALL FUNCTION 'TRINT_DELETE_COMM_KEYS'")
  )
  assert.ok(s.indexOf("IF p_readonly = 'X'.") < s.indexOf("PERFORM orv_bc_records_stage"))
  assert.ok(s.includes("current_effect <> after_effect"))
  assert.ok(s.includes("lt_delta <> f_delta"))
  assert.ok(!/\b(?:MODIFY|INSERT|UPDATE|DELETE FROM)\s+(?:t006\w*|scpract\w*|e071\w*)\b/i.test(s))
  assert.ok(!/DEQUEUE_ALL|MAX\s*\(/i.test(s))
  assert.ok(s.includes("DELETE lt_keys INDEX sy-tabix. APPEND ls_key TO p_delta."))
  assert.equal(configurationBcNativeReplySchema.safeParse({ EV_CODE: "APPLIED" }).success, false)
})

for (const point of ["intent", "result", "completion"] as const)
  test(`${point} persistence failure: no unsafe dispatch or replay`, async (t) => {
    const f = await bcCommandFixture(t),
      publish = f.env.executions.publish.bind(f.env.executions)
    if (point === "completion")
      f.env.receipts.complete = async () => {
        throw Error("simulated completion fsync failure")
      }
    else
      f.env.executions.publish = async (id, kind, value) => {
        if (kind === point) throw Error("simulated immutable publication failure")
        return publish(id, kind, value)
      }
    const r = await f.apply()
    assert.equal(r.status, point === "intent" ? "declined" : "unknown")
    assert.equal(f.calls.length, point === "intent" ? 0 : 1)
    if (point !== "intent") {
      assert.equal((await f.apply()).status, "protection_refused")
      assert.equal(
        (await f.env.receipts.status("w200", f.request.operationId)).localLockReleased,
        false
      )
    }
  })
