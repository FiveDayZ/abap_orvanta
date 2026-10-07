import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import {
  configurationUnitTextVersion,
  reconcileConfigurationUnitText
} from "../src/configuration-unit-reconcile.js"
import { repositoryRoot } from "../src/verification-registry.js"
import { writeOperationTarget } from "../src/mcp.js"

const evidence = (revision: string) =>
  JSON.parse(
    readFileSync(
      join(
        repositoryRoot,
        "docs/workspace-evidence/.doc",
        `orvanta-unit-text-apply-save-restore-acceptance-20261004-${revision}.json`
      ),
      "utf8"
    )
  )
const proof = evidence("r34"),
  uncertainProof = evidence("r33")
const clone = <T>(value: T): T => structuredClone(value)
const originalRequest = (p = proof) =>
  p.calls.find((call: { name: string }) => call.name === "apply_configuration_unit_text").args
const inputFor = (p = proof) => {
  const { connectionId, operationId, ...originalInput } = originalRequest(p)
  return {
    connectionId,
    operationId,
    originalInput,
    beforeText: clone(p.before.apiSnapshot.data),
    includeLocks: false
  }
}
function fixture(p = proof) {
  const input = inputFor(p),
    receipt = clone(p.saveReceipt),
    unit = clone(proof.afterSaveObserved),
    cts = clone(proof.ctsAfterSave)
  let reads = 0,
    receiptReads = 0,
    lockReads = 0
  const reconcile = (
    raw: unknown = input,
    options: {
      client?: string
      unit?: (index: number) => unknown
      cts?: unknown
      receipt?: (index: number) => unknown
      locks?: unknown
    } = {}
  ) =>
    reconcileConfigurationUnitText(
      raw,
      options.client ?? "200",
      "WYS",
      async () =>
        options.receipt ? options.receipt(++receiptReads) : (receiptReads++, clone(receipt)),
      async (value) => {
        assert.deepEqual(value, {
          connectionId: "w200",
          unitKey: "KG",
          language: "ZH",
          includeApiSnapshot: true
        })
        return options.unit ? options.unit(++reads) : (reads++, clone(unit))
      },
      async (value) => {
        reads++
        assert.deepEqual(value, {
          connectionId: "w200",
          requestNumber: "GR2K923429",
          taskNumber: "GR2K923430",
          unitText: { unitKey: "KG", language: "ZH" }
        })
        return clone(options.cts === undefined ? cts : options.cts)
      },
      async () => {
        lockReads++
        return clone(
          options.locks === undefined
            ? { connectionId: "w200", client: "200", status: "ok", hasMore: false, entries: [] }
            : options.locks
        )
      }
    )
  return {
    input,
    receipt,
    unit,
    cts,
    reconcile,
    counts: () => ({ reads, receiptReads, lockReads })
  }
}

test("GR2 fixed-width encoding matches four real native snapshots and the existing target identity", () => {
  for (const phase of ["before", "beforeEn", "afterSaveObserved", "finalZh"]) {
    const snapshot = proof[phase].apiSnapshot
    assert.equal(configurationUnitTextVersion(snapshot.data), snapshot.textVersion)
  }
  assert.equal(
    writeOperationTarget("apply_configuration_unit_text", originalRequest(), "").key,
    "CONFIG:T006A:200:KG"
  )
})

test("desired full row and retained CTS projection are observed without changing the original receipt", async () => {
  const f = fixture(),
    before = clone(f.receipt)
  const result = await f.reconcile()
  assert.equal(result.status, "observed_requested")
  assert.equal(result.cts.status, "target_projection_observed")
  assert.equal(result.cts.taskMatches, 1)
  assert.equal(result.cts.exactRowRecording, "not_verified")
  assert.equal(result.historicalOutcome.status, "receipt_completed")
  assert.deepEqual(result.originalReceipt, before)
  assert.deepEqual(f.receipt, before)
  assert.equal(result.receiptModified, false)
  assert.equal(result.automaticRetry, false)
  assert.equal(result.automaticRollback, false)
  assert.equal(result.evidence.unitReaderInvocations, 2)
  assert.deepEqual(f.counts(), { reads: 3, receiptReads: 2, lockReads: 0 })
})

test("real r33 unknown receipt stays unresolved when later restoration makes the current row original", async () => {
  const f = fixture(uncertainProof),
    old = clone(f.receipt)
  const result = await f.reconcile(f.input, { unit: () => clone(proof.finalZh) })
  assert.equal(result.status, "observed_original")
  assert.equal(result.historicalOutcome.status, "unresolved")
  assert.equal(result.historicalOutcome.outcomeMayBeUnknown, true)
  assert.deepEqual(result.originalReceipt, old)
  assert.equal(result.cts.status, "target_projection_observed")
})

test("matching requested description does not conceal changes to an omitted protected field", async () => {
  const f = fixture(),
    changed = clone(f.unit)
  changed.apiSnapshot.data.MSEH6 = "other"
  changed.apiSnapshot.textVersion = configurationUnitTextVersion(changed.apiSnapshot.data)
  const result = await f.reconcile(f.input, { unit: () => changed })
  assert.equal(result.status, "observed_conflicting")
  assert.equal(result.value.comparisonScope, "full_T006A_row")
})

test("missing or mismatched local receipt/input/target context is refused before all SAP reads", async () => {
  for (const change of [
    (v: any) => {
      v.originalInput.patch.MSEHL = "other"
    },
    (v: any) => {
      v.originalInput.unitKey = "kg"
    },
    (v: any) => {
      v.originalInput.language = "EN"
    },
    (v: any) => {
      v.operationId = "another-operation"
    },
    (v: any) => {
      v.originalInput.taskNumber = "GR2K923431"
    }
  ]) {
    const f = fixture(),
      input = clone(f.input)
    change(input)
    await assert.rejects(f.reconcile(input), /CONTEXT_MISMATCH/)
    assert.equal(f.counts().reads, 0)
  }
  const f = fixture()
  await assert.rejects(
    f.reconcile(f.input, { receipt: () => ({ status: "not_found" }) }),
    /RECEIPT_UNVERIFIED/
  )
  assert.equal(f.counts().reads, 0)
})

test("invented old rows, stale hashes and unsupported client fail before SAP reads", async () => {
  for (const field of ["MSEHL", "MSEH3", "SPRAS", "MANDT"]) {
    const f = fixture(),
      input = clone(f.input)
    input.beforeText[field] = field === "SPRAS" ? "E" : "bad"
    await assert.rejects(f.reconcile(input), /BEFORE_MISMATCH/)
    assert.equal(f.counts().reads, 0)
  }
  const f = fixture()
  await assert.rejects(f.reconcile(f.input, { client: "300" }), /SCOPE_UNSUPPORTED/)
  assert.equal(f.counts().receiptReads, 0)
})

test("empty patch, hidden writes and extra old-row fields remain strict input errors", async () => {
  for (const change of [
    (v: any) => {
      v.execute = true
    },
    (v: any) => {
      v.originalInput.patch = {}
    },
    (v: any) => {
      v.originalInput.patch.MSEH3 = "alias"
    },
    (v: any) => {
      v.beforeText.extra = "x"
    },
    (v: any) => {
      v.originalInput.requestNumber = v.originalInput.taskNumber
    }
  ]) {
    const f = fixture(),
      input = clone(f.input)
    change(input)
    await assert.rejects(f.reconcile(input))
    assert.equal(f.counts().receiptReads, 0)
    assert.equal(f.counts().reads, 0)
  }
})

test("changed, unsupported or false native snapshots cannot produce a stable current-value verdict", async () => {
  for (const mutate of [
    (v: any) => {
      v.apiSnapshot.status = "changed"
    },
    (v: any) => {
      v.apiSnapshot.bodyFingerprint = "a".repeat(64)
    },
    (v: any) => {
      v.apiSnapshot.textVersion = "a".repeat(64)
    },
    (v: any) => {
      v.text.sapLanguage = "E"
    },
    (v: any) => {
      v.evidence.valuesRechecked = false
    }
  ]) {
    const f = fixture(),
      value = clone(f.unit)
    mutate(value)
    const result = await f.reconcile(f.input, { unit: () => value })
    assert.equal(result.status, "unknown")
    assert.equal(result.value.current, null)
  }
  const f = fixture()
  const result = await f.reconcile(f.input, {
    unit: (index) => (index === 1 ? clone(f.unit) : clone(proof.finalZh))
  })
  assert.equal(result.value.status, "unknown")
})

test("changed or unreadable receipt during observation keeps all write conclusions unknown", async () => {
  for (const after of [
    null,
    { ...proof.saveReceipt, receiptHash: "a".repeat(64) },
    { ...proof.saveReceipt, status: "failed", outcomeMayBeUnknown: true }
  ]) {
    const f = fixture(),
      result = await f.reconcile(f.input, { receipt: (index) => (index === 1 ? f.receipt : after) })
    assert.equal(result.status, "unknown")
    assert.equal(result.evidence.receiptRechecked, false)
    assert.deepEqual(result.originalReceipt, f.receipt)
  }
})

test("missing, truncated, changed, released or wrong-scope CTS never becomes a successful observation", async () => {
  for (const mutate of [
    (v: any) => {
      v.status = "rejected"
    },
    (v: any) => {
      v.keyRecording.status = "truncated"
    },
    (v: any) => {
      v.taskNumber = "GR2K923431"
    },
    (v: any) => {
      v.keyRecording.target.sapLanguage = "E"
    },
    (v: any) => {
      delete v.checks.taskOpen
      v.checks.invented = true
    },
    (v: any) => {
      v.keyRecording.observed.taskE071K[0].TRKORR = "GR2K923431"
    },
    (v: any) => {
      v.keyRecording.readerLimits.maximumRowsPerProjection = 200
    }
  ]) {
    const f = fixture(),
      cts = clone(f.cts)
    mutate(cts)
    const result = await f.reconcile(f.input, { cts })
    assert.equal(result.status, "unknown")
    assert.equal(result.cts.status, "unknown")
    assert.equal(result.value.status, "observed_requested")
  }
})

test("absent projection is not no-write proof, and duplicate or parent keys remain explicit", async () => {
  const f = fixture(),
    absent = clone(f.cts)
  absent.keyRecording.observed.taskE071K = []
  const result = await f.reconcile(f.input, { cts: absent })
  assert.equal(result.cts.status, "target_projection_not_observed")
  assert.equal(result.historicalOutcome.status, "receipt_completed")
  const duplicate = clone(f.cts)
  duplicate.keyRecording.observed.taskE071K.push(
    clone(duplicate.keyRecording.observed.taskE071K[0])
  )
  assert.equal(
    (await f.reconcile(f.input, { cts: duplicate })).cts.status,
    "ambiguous_or_outside_task"
  )
  assert.equal((await f.reconcile(f.input, { cts: duplicate })).status, "unknown")
  const parent = clone(f.cts)
  parent.keyRecording.observed.requestE071K = [
    { ...parent.keyRecording.observed.taskE071K[0], TRKORR: "GR2K923429" }
  ]
  assert.equal(
    (await f.reconcile(f.input, { cts: parent })).cts.status,
    "ambiguous_or_outside_task"
  )
})

test("unavailable/truncated/wrong-user lock evidence is not treated as an empty lock list", async () => {
  for (const locks of [
    null,
    { status: "unavailable", code: "HELPER_NOT_APPROVED" },
    { connectionId: "w200", client: "200", status: "ok", hasMore: true, entries: [] },
    {
      connectionId: "w200",
      client: "200",
      status: "ok",
      hasMore: false,
      entries: [{ client: "200", username: "OTHER" }]
    }
  ]) {
    const f = fixture(),
      result = await f.reconcile({ ...f.input, includeLocks: true }, { locks })
    assert.equal(result.status, "unknown")
    assert.equal(result.locks.status, "unavailable")
    assert.equal(f.counts().lockReads, 3)
  }
  const f = fixture(),
    result = await f.reconcile({ ...f.input, includeLocks: true })
  assert.equal(result.status, "observed_requested")
  assert.equal(result.locks.status, "observed")
})

test("a reader failure retains its safe code, with no automatic retry or receipt modification", async () => {
  const f = fixture(),
    result = await f.reconcile(f.input, {
      unit: () => {
        throw Error("CONFIGURATION_UNIT_QUERY_FAILED")
      }
    })
  assert.equal(result.status, "unknown")
  assert.equal(
    result.evidence.observations.filter((o) => o.code === "CONFIGURATION_UNIT_QUERY_FAILED").length,
    2
  )
  assert.equal(result.receiptModified, false)
})
