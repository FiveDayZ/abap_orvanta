import assert from "node:assert/strict"
import { type TestContext } from "node:test"
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

export async function bcCommandFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "orvanta-r65-bc-"))
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  t.after(() => rm(root, { recursive: true, force: true }))
  const state = await (await stateFixture()).invoke(),
    before = new ConfigurationBcBeforeStateStore(root)
  const saved = await before.capture(async () => state)
  const readRequest = {
    connectionId: "w200" as const,
    bcSetId: "EHS_CUNI_KNM" as const,
    version: "N" as const,
    requestNumber: "GR2K923429" as const,
    taskNumber: "GR2K923430" as const,
    operationId: "r65-read-effects-001",
    beforeStateReference: saved.reference
  }
  const bytes = Buffer.from("synthetic native effect proof; never a SAP runtime result")
  const effects: ConfigurationBcEffectsEvidence = {
    ...readRequest,
    system: "GR2",
    client: "200",
    user: "WYS",
    readOnly: true,
    snapshot: false,
    executable: false,
    activationAvailable: false,
    recoveryAvailable: false,
    currentStateRechecked: false,
    ctsRecoveryChecked: false,
    scopeVersion: configurationBcEffectsScope,
    ctsVersion: state.versions.cts,
    effectsVersion: sha(bytes),
    bodyFingerprint: configurationBcEffectsBodyFingerprint,
    counts: { matched: 0, records: 0, headers: 0, variables: 0, links: 0 },
    profileCount: 1,
    identities: [
      {
        functionName: configurationBcEffectsApi.functionName,
        source: "a".repeat(64),
        interface: "b".repeat(64)
      },
      {
        functionName: configurationBcCtsApi.functionName,
        source: "a".repeat(64),
        interface: "b".repeat(64)
      },
      {
        objectName: configurationBcEffectsInclude.objectName,
        objectType: configurationBcEffectsInclude.objectType,
        source: configurationBcEffectsInclude.sourceFingerprint
      },
      ...Object.entries(configurationBcEffectsDependencies).map(([functionName, v]) => ({
        functionName,
        ...v
      })),
      ...Object.entries(configurationBcEffectsAllLayouts).map(([tableName, fingerprint]) => ({
        tableName,
        fingerprint
      }))
    ],
    buffer: {
      data: bytes.toString("base64"),
      bytes: bytes.length,
      nativeRoundtrip: true,
      clientSideImportAvailable: false,
      recoveryPermit: false
    },
    blockedBy: []
  }
  const effect = await before.captureEffects(saved.reference, saved.binding, async () => effects)
  const receipts = new WriteOperationReceiptStore(root),
    executions = new ConfigurationBcExecutionStore(root)
  const request = {
    ...readRequest,
    operationId: "r65-apply-0001",
    effectsReference: effect.reference,
    acknowledgeConfigurationWrite: true as const,
    acknowledgeIndependentProtocol: true as const,
    acknowledgeLocalActivationLinks: true as const,
    acknowledgeCtsRecording: true as const
  }
  let patchDefinition = (_name: string, _data: Record<string, unknown>) => {}
  let patchReply = (_name: string, _data: Record<string, string>) => {}
  let beforeCall = async () => {}
  const calls: string[] = []
  const frame = Buffer.from("synthetic committed full native frame; only adapter testing")
  const env: ConfigurationBcCommandEnvironment = {
    binding: saved.binding,
    before,
    receipts,
    executions,
    readers: {
      definition: async (name) => {
        const api = apis.find((api) => api.functionName === name)
        const pin = configurationBcOwnerFunctionPins[name]
        const data: Record<string, unknown> = api
          ? {
              ...api,
              connectionId: "w200",
              updateTask: false,
              updateTaskMode: "",
              changingParameters: [],
              exceptions: [],
              tableParameters: "tableParameters" in api ? api.tableParameters : [],
              source: [`FUNCTION ${name}.`, ...api.source, "ENDFUNCTION."],
              sourceFingerprint: sha(api.source.join("\n")),
              interfaceFingerprint: sha(name)
            }
          : {
              connectionId: "w200",
              functionName: name,
              sourceFingerprint: pin!.source,
              interfaceFingerprint: pin!.interface,
              remoteEnabled: pin!.remoteEnabled,
              updateTask: pin!.updateTask
            }
        patchDefinition(name, data)
        return data
      },
      include: async (name) => {
        if (name === configurationBcRecordKernel.includeName)
          return [...configurationBcRecordKernel.source]
        if (name === configurationBcOwnerInclude.includeName)
          return [...configurationBcOwnerInclude.source]
        const fixture = JSON.parse(
          readFileSync(
            new URL("./fixtures/configuration-bc-owner-w200-r65.json", import.meta.url),
            "utf8"
          )
        )
        return fixture.includes[name] as string[]
      },
      table: async (name) => ({
        connectionId: "w200",
        objectName: name,
        fingerprint: configurationBcOwnerLayoutPins[name]
      })
    },
    backend: {
      callRemoteFunction: async (_connection, call) => {
        calls.push(call.functionName)
        if (call.functionName !== configurationBcReconcileApi.functionName) {
          const r = await receipts.status(
            "w200",
            String(call.inputParameters.IV_OPERATION_HASH) === sha(request.operationId)
              ? request.operationId
              : "r65-recover-0001"
          )
          assert.equal(r.sapInvocationStarted, true)
          const intent = await executions.readAuthenticated(
            String(call.inputParameters.IV_OPERATION_HASH),
            "WYS",
            "intent"
          )
          assert.deepEqual(intent.value.input, call.inputParameters)
        }
        await beforeCall()
        const recovery =
          call.functionName === configurationBcRecoverApi.functionName ||
          call.inputParameters.IV_COMMAND === "R"
        const data: Record<string, string> = {
          EV_CODE:
            call.functionName === configurationBcReconcileApi.functionName
              ? "RECONCILED"
              : recovery
                ? "RECOVERED"
                : "APPLIED",
          EV_SYSTEM: "GR2",
          EV_CLIENT: "200",
          EV_USER: "WYS",
          EV_OPERATION_HASH: String(call.inputParameters.IV_OPERATION_HASH),
          EV_BEFORE_REFERENCE: saved.reference,
          EV_COMMIT: "committed",
          EV_PHASE:
            call.functionName === configurationBcReconcileApi.functionName
              ? "observed"
              : "complete",
          EV_CONFIGURATION: recovery ? "before" : "candidate",
          EV_PROTECTED: "preserved",
          EV_CTS: recovery ? "before" : "recorded",
          EV_EFFECTS: recovery ? "before" : "recorded",
          EV_LOCKS: "released",
          EV_PROTOCOL: "complete",
          EV_ACT_ID: "A".repeat(32),
          EV_FRAME_BASE64: recovery ? "" : frame.toString("base64"),
          EV_FRAME_VERSION: sha(frame),
          EV_MSGID: "",
          EV_MSGNO: "",
          EV_MSGV1: "",
          EV_MSGV2: "",
          EV_MSGV3: "",
          EV_MSGV4: ""
        }
        patchReply(call.functionName, data)
        return { outputs: data }
      }
    }
  }
  return {
    root,
    request,
    env,
    calls,
    effects,
    setDefinitionPatch(v: typeof patchDefinition) {
      patchDefinition = v
    },
    setReplyPatch(v: typeof patchReply) {
      patchReply = v
    },
    setBeforeCall(v: typeof beforeCall) {
      beforeCall = v
    },
    apply: () => executeConfigurationBcCommand("apply", request, env),
    recover: async (receiptHash: string) =>
      executeConfigurationBcCommand(
        "recover",
        {
          ...readRequest,
          operationId: "r65-recover-0001",
          effectsReference: effect.reference,
          applyOperationId: request.operationId,
          applyReceiptHash: receiptHash,
          acknowledgeConfigurationWrite: true,
          acknowledgeIndependentProtocol: true,
          acknowledgeLocalActivationLinks: true,
          acknowledgeCtsKeyCleanup: true
        },
        env
      )
  }
}
