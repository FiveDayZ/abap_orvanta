import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { SourceMutationInfo } from "../src/backend.js"
import { startHttpServer } from "../src/http.js"
import {
  MAX_READBACK_ERROR,
  SourceSavedNotActivatedError,
  sourceWriteOutcome,
  sourceWriteOutcomeIsDetermined,
  sourceWriteRecoveryGuide,
  type SourceWriteOutcome
} from "../src/source-write-outcome.js"
import { hashWriteInput, WriteOperationReceiptStore } from "../src/write-operation-receipts.js"
import { MockBackend } from "./mock-backend.js"

// The incident of 2026-09-28 09:59 (ZCL_PMC_TP_REPACK, w200): the replacement removed a declaration
// the still-active version used, so the save landed as an inactive draft and the activation failed.
// Both fingerprints were read back in the same answer.
const ACTIVE_FINGERPRINT = "797b42c5970abcfd0f87814577a5cb2d21238cf1c8f040dd2a6406b2d95672a5"
const DRAFT_FINGERPRINT = "4796620e42026c48b209c20ea7cf3b27590ef706600e5aa8034c46ad566ef4eb"

const savedNotActivated: SourceWriteOutcome = {
  saveSucceeded: true,
  unlockSucceeded: true,
  activationAttempted: true,
  activationSucceeded: false,
  intendedFingerprint: DRAFT_FINGERPRINT,
  activeFingerprint: ACTIVE_FINGERPRINT,
  inactiveFingerprint: DRAFT_FINGERPRINT,
  readbackError: null
}

test("a saved but unactivated source is a determined outcome", () => {
  const result: SourceMutationInfo = {
    fileUri: "adt://w200/sap/bc/adt/oo/classes/zcl_pmc_tp_repack/source/main",
    sourceUri: "adt://w200/sap/bc/adt/oo/classes/zcl_pmc_tp_repack/source/main",
    objectName: "ZCL_PMC_TP_REPACK",
    oldLineCount: 3,
    newLineCount: 1,
    transportNumber: "GR2K923427",
    activation: {
      success: false,
      messages: [{ type: "E", line: 1, text: '字段 "LV_WM_INDEX" 未知', href: "" }],
      inactiveObjects: ["ZCL_PMC_TP_REPACK"]
    },
    sourceFingerprintBefore: ACTIVE_FINGERPRINT,
    sourceFingerprintAfter: DRAFT_FINGERPRINT,
    saveSucceeded: true,
    unlockSucceeded: true,
    activationAttempted: true,
    activationSucceeded: false,
    activeFingerprint: ACTIVE_FINGERPRINT,
    inactiveFingerprint: DRAFT_FINGERPRINT
  }
  const outcome = sourceWriteOutcome(result)
  assert.deepEqual(outcome, savedNotActivated)
  assert.equal(sourceWriteOutcomeIsDetermined(outcome), true)
})

test("every missing or contradictory read-back keeps the outcome unknown", () => {
  const cases: Array<[string, Partial<SourceWriteOutcome>]> = [
    ["the active source was never read", { readbackError: "socket hang up" }],
    ["no draft exists under the candidate", { inactiveFingerprint: null }],
    ["the candidate was never fingerprinted", { intendedFingerprint: null }],
    ["the draft differs from the candidate", { inactiveFingerprint: ACTIVE_FINGERPRINT }],
    ["the active version already holds the candidate", { activeFingerprint: DRAFT_FINGERPRINT }],
    ["the save did not succeed", { saveSucceeded: false }],
    ["the unlock failed", { unlockSucceeded: false }],
    ["activation succeeded", { activationSucceeded: true }]
  ]
  for (const [reason, override] of cases) {
    assert.equal(
      sourceWriteOutcomeIsDetermined({ ...savedNotActivated, ...override }),
      false,
      reason
    )
  }
  // `activationAttempted` is deliberately not part of the rule: it says what was tried, while the
  // three fingerprints say what SAP holds. A save that landed as a draft is just as determined when
  // the activation step never ran.
  assert.equal(
    sourceWriteOutcomeIsDetermined({ ...savedNotActivated, activationAttempted: null }),
    true
  )
  // A draft read that succeeded while the active read failed has one fingerprint only, which proves
  // nothing about the version that is live - the case the backend already labels readbackError.
  assert.equal(
    sourceWriteOutcomeIsDetermined({
      ...savedNotActivated,
      activeFingerprint: null,
      readbackError: "SOURCE_READBACK_UNAVAILABLE"
    }),
    false
  )
})

test("the recovery guide names the repair call for a determined draft", () => {
  const determined = sourceWriteRecoveryGuide(savedNotActivated, "ZCL_PMC_TP_REPACK")
  assert.match(determined, /recoverInactiveSource=true/)
  assert.match(determined, /expectedSourceFingerprint/)
  assert.match(determined, new RegExp(DRAFT_FINGERPRINT))
  assert.match(determined, new RegExp(ACTIVE_FINGERPRINT))
  assert.doesNotMatch(determined, /reconcile the active and inactive source/)

  const unknown = sourceWriteRecoveryGuide(
    { ...savedNotActivated, readbackError: "socket hang up" },
    "ZCL_PMC_TP_REPACK"
  )
  assert.match(unknown, /did not receive a read-back/)
  assert.match(unknown, /Do not repeat the same replacement/)
  // The unknown branch must not send the caller to a draft whose existence it cannot prove.
  assert.doesNotMatch(unknown, /recoverInactiveSource=true/)
})

async function reservedReceipt(root: string, operationId: string) {
  const store = new WriteOperationReceiptStore(root, "source-write-outcome-instance")
  const reservation = await store.reserve({
    connectionId: "w200",
    toolName: "replace_string_in_abap_object",
    operationId,
    targetKey: "CLAS:ZCL_PMC_TP_REPACK",
    inputHash: hashWriteInput({ operationId, oldString: "x", newString: "y" }),
    preChangeSummary: '{"target":"class ZCL_PMC_TP_REPACK"}',
    recoveryGuide: "Read back class ZCL_PMC_TP_REPACK before retrying."
  })
  if (reservation.status !== "reserved") throw new Error("Missing reservation")
  await store.markSapInvocationStarted(reservation.reservation)
  return { store, reservation: reservation.reservation }
}

test("a determined failure receipt reports the draft instead of an unknown outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "abap-mcp-source-outcome-"))
  try {
    const { store, reservation } = await reservedReceipt(root, "determined-failure")
    await store.fail(
      reservation,
      new SourceSavedNotActivatedError(
        "Source was saved to SAP but activation failed",
        savedNotActivated,
        sourceWriteRecoveryGuide(savedNotActivated, "ZCL_PMC_TP_REPACK")
      ),
      42
    )
    const failed = await store.status("w200", "determined-failure")
    assert.equal(failed.status, "failed")
    assert.equal(failed.sapInvocationStarted, true)
    assert.equal(failed.outcomeMayBeUnknown, false)
    assert.equal(failed.automaticRetry, false)
    assert.deepEqual(failed.postChangeObservation, savedNotActivated)
    assert.match(String(failed.manualRecovery), /recoverInactiveSource=true/)
    assert.match(String(failed.manualRecovery), new RegExp(DRAFT_FINGERPRINT))
    assert.doesNotMatch(String(failed.manualRecovery), /Read back class ZCL_PMC_TP_REPACK/)
    assert.doesNotMatch(String(failed.manualRecovery), /local target lock is retained/)

    // The same status is reported before and after the process forgets the operation, so the
    // determination has to live in the stored receipt rather than in memory.
    const reread = new WriteOperationReceiptStore(root, "another-instance")
    const again = await reread.status("w200", "determined-failure")
    assert.equal(again.outcomeMayBeUnknown, false)
    assert.deepEqual(again.postChangeObservation, savedNotActivated)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a failure without a read-back keeps the unknown outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "abap-mcp-source-outcome-"))
  try {
    const unknown = await reservedReceipt(root, "unread-failure")
    await unknown.store.fail(
      unknown.reservation,
      new Error("Request failed with status code 500"),
      5
    )
    const failed = await unknown.store.status("w200", "unread-failure")
    assert.equal(failed.outcomeMayBeUnknown, true)
    assert.equal(failed.postChangeObservation, undefined)
    assert.equal(failed.manualRecovery, "Read back class ZCL_PMC_TP_REPACK before retrying.")

    const partial = await reservedReceipt(root, "partial-failure")
    await partial.store.fail(
      partial.reservation,
      new SourceSavedNotActivatedError(
        "Source was saved to SAP but activation could not be verified",
        { ...savedNotActivated, activeFingerprint: null, readbackError: "socket hang up" },
        sourceWriteRecoveryGuide(savedNotActivated, "ZCL_PMC_TP_REPACK")
      ),
      7
    )
    const partialStatus = await partial.store.status("w200", "partial-failure")
    // Storage keeps the evidence, the flag keeps the uncertainty: a draft fingerprint without the
    // active one cannot prove which version is live.
    assert.equal(partialStatus.outcomeMayBeUnknown, true)
    assert.equal(
      (partialStatus.postChangeObservation as SourceWriteOutcome).inactiveFingerprint,
      DRAFT_FINGERPRINT
    )
    assert.equal(
      (partialStatus.postChangeObservation as SourceWriteOutcome).readbackError,
      "socket hang up"
    )
    assert.equal(partialStatus.manualRecovery, "Read back class ZCL_PMC_TP_REPACK before retrying.")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the stored read-back text is redacted and bounded, and never takes the receipt down", async () => {
  const base = {
    fileUri: "adt://w200/sap/bc/adt/programs/programs/zmodule_pool/source/main",
    sourceUri: "adt://w200/sap/bc/adt/programs/programs/zmodule_pool/source/main",
    objectName: "ZMODULE_POOL",
    oldLineCount: 1,
    newLineCount: 1,
    transportNumber: "",
    activation: { success: false, messages: [], inactiveObjects: [] },
    saveSucceeded: true
  }
  const outcome = sourceWriteOutcome({
    ...base,
    readbackError: `Authorization: Bearer abc123 ${"x".repeat(MAX_READBACK_ERROR + 500)}`
  })
  assert.equal(outcome.readbackError?.length, MAX_READBACK_ERROR)
  assert.doesNotMatch(String(outcome.readbackError), /abc123/)
  // An empty read-back error is "no error text", not a zero-length string the schema would reject.
  assert.equal(sourceWriteOutcome({ ...base, readbackError: "" }).readbackError, null)

  const root = await mkdtemp(join(tmpdir(), "abap-mcp-source-outcome-"))
  try {
    const { store, reservation } = await reservedReceipt(root, "long-readback-error")
    await store.fail(
      reservation,
      new SourceSavedNotActivatedError(
        "Source was saved to SAP but activation could not be verified",
        outcome,
        "Read back class ZCL_PMC_TP_REPACK before retrying."
      ),
      3
    )
    // Reading the receipt back is what the recovery layer needs; a value over the schema bound would
    // fail closed and strand the operation.
    const status = await store.status("w200", "long-readback-error")
    assert.equal(status.status, "failed")
    assert.equal(status.outcomeMayBeUnknown, true)
    assert.equal(
      (status.postChangeObservation as SourceWriteOutcome).readbackError?.length,
      MAX_READBACK_ERROR
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the tool answers a determined activation failure with the measured post-state", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "abap-mcp-source-outcome-http-"))
  const backend = new MockBackend()
  const fileUri = "adt://w200/sap/bc/adt/programs/programs/zmodule_pool/source/main"
  backend.replaceSource = async () =>
    ({
      fileUri,
      sourceUri: fileUri,
      objectName: "ZMODULE_POOL",
      oldLineCount: 1,
      newLineCount: 2,
      transportNumber: "GR2K923421",
      activation: {
        success: false,
        messages: [{ type: "E", line: 1, text: '字段 "LV_WM_INDEX" 未知', href: fileUri }],
        inactiveObjects: ["ZMODULE_POOL"],
        attempted: true
      },
      sourceFingerprintBefore: ACTIVE_FINGERPRINT,
      sourceFingerprintAfter: DRAFT_FINGERPRINT,
      saveSucceeded: true,
      unlockSucceeded: true,
      activationAttempted: true,
      activationSucceeded: false,
      activeFingerprint: ACTIVE_FINGERPRINT,
      inactiveFingerprint: DRAFT_FINGERPRINT
    }) satisfies SourceMutationInfo
  const running = await startHttpServer(backend, 0, stateRoot)
  const client = new Client({ name: "source-write-outcome-client", version: "0.1.0" })
  try {
    const transport = new StreamableHTTPClientTransport(new URL(running.mcpUrl))
    await client.connect(transport as Parameters<Client["connect"]>[0])
    const result = await client.callTool({
      name: "replace_string_in_abap_object",
      arguments: {
        fileUri,
        oldString: "PROGRAM zmodule_pool.",
        newString: "PROGRAM zmodule_pool.\n* repacked",
        operationId: "repack-activation",
        transportNumber: "GR2K923421"
      }
    })
    assert.equal(result.isError, true)
    const text = (result.content as Array<{ type: string; text?: string }>)
      .map((part) => part.text ?? "")
      .join("\n")
    assert.match(text, /activation failed or could not be verified for ZMODULE_POOL/)
    assert.match(text, /字段 "LV_WM_INDEX" 未知/)
    const receipt = JSON.parse(text.split("\nOperation Receipt\n")[1] ?? "{}") as Record<
      string,
      any
    >
    assert.equal(receipt.status, "failed")
    assert.equal(receipt.sapInvocationStarted, true)
    assert.equal(receipt.outcomeMayBeUnknown, false)
    assert.equal(receipt.automaticRetry, false)
    assert.equal(receipt.automaticRollback, false)
    assert.equal(receipt.localLockReleased, true)
    assert.equal(receipt.postChangeObservation.inactiveFingerprint, DRAFT_FINGERPRINT)
    assert.equal(receipt.postChangeObservation.activeFingerprint, ACTIVE_FINGERPRINT)
    assert.match(String(receipt.manualRecovery), /recoverInactiveSource=true/)
    assert.match(String(receipt.manualRecovery), new RegExp(DRAFT_FINGERPRINT))

    // The determination survives the tool call: a later status read answers the same, which is what
    // lets a caller stop reconciling a state the receipt already measured.
    const status = await client.callTool({
      name: "get_write_operation_status",
      arguments: { operationId: "repack-activation", connectionId: "w200" }
    })
    const statusBody = JSON.parse(
      (status.content as Array<{ type: string; text?: string }>)
        .map((part) => part.text ?? "")
        .join("\n")
    ) as Record<string, any>
    assert.equal(statusBody.status, "failed")
    assert.equal(statusBody.outcomeMayBeUnknown, false)
    assert.equal(statusBody.postChangeObservation.inactiveFingerprint, DRAFT_FINGERPRINT)
    assert.equal(statusBody.postChangeObservation.intendedFingerprint, DRAFT_FINGERPRINT)
    assert.equal(statusBody.postChangeObservation.activeFingerprint, ACTIVE_FINGERPRINT)
    assert.match(String(statusBody.manualRecovery), /recoverInactiveSource=true/)
  } finally {
    await client.close()
    await running.close()
    await rm(stateRoot, { recursive: true, force: true })
  }
})
