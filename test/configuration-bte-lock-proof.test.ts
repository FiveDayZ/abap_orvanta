import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  configurationBteLockProofApi as api,
  inspectConfigurationBteLockProof
} from "../src/configuration-bte-lock-proof.js"
import { configurationBteSavePathConstraints } from "../src/configuration-bte-save-closure.js"

const observed = JSON.parse(
  readFileSync(
    new URL("./fixtures/configuration-bte-lock-proof-w200-r78.json", import.meta.url),
    "utf8"
  )
)
const candidate = api.source.join("\n")

test("the deployment body fits SAP's RSSOURCE line width without truncation", () => {
  for (const [index, line] of api.source.entries())
    assert.ok(line.length <= 72, `Line ${index + 1} exceeds RSSOURCE CHAR72`)
})

function synthetic(counts = "1,2,1,1,2,1") {
  const retained = counts === "1,2,1,1,2,1"
  return {
    EV_CODE: retained ? "SCOPE_RETAINED" : "SCOPE_NOT_RETAINED",
    EV_MESSAGE: "Synthetic count response, not a SAP runtime result.",
    EV_COUNTS: counts,
    EV_RETAINED: retained ? "X" : "",
    EV_CLEAN: "X"
  }
}

test("a synthetic retained reference observation never grants CTS, session or BTE write safety", () => {
  const result = inspectConfigurationBteLockProof(synthetic())
  assert.deepEqual(result.requestCounts, [1, 2, 1])
  assert.deepEqual(result.taskCounts, [1, 2, 1])
  assert.equal(result.callerReferenceRetainedAfterOneNativeDequeue, true)
  assert.equal(result.cleanupObserved, true)
  assert.equal(result.ctsTransactionVerified, false)
  assert.equal(result.sessionCleanupVerified, false)
  assert.equal(result.writeAvailable, false)
  assert.equal(configurationBteSavePathConstraints.nativeExecutionVerified, false)
})

test("loss of either native caller reference remains a negative observation", () => {
  for (const counts of ["1,2,0,1,2,0", "1,2,0,1,2,1", "1,2,1,1,2,0"]) {
    const result = inspectConfigurationBteLockProof(synthetic(counts))
    assert.equal(result.callerReferenceRetainedAfterOneNativeDequeue, false)
    assert.equal(result.writeAvailable, false)
  }
})

test("cleanup errors, refusals, incomplete counts and extra owner data are never success evidence", () => {
  for (const patch of [
    { EV_CODE: "LOCK_CLEANUP_UNVERIFIED", EV_CLEAN: "" },
    { EV_CODE: "EXISTING_E070_LOCKS" },
    { EV_CODE: "LOCK_OWNER_CHANGED" },
    { EV_CODE: "PROBE_RUNNING" },
    { EV_CLEAN: "" },
    { EV_CLEAN: true },
    { EV_COUNTS: "1,2,1" },
    { EV_COUNTS: "1,2,2,1,2,1" },
    { EV_COUNTS: "0,2,1,1,2,1" },
    { EV_COUNTS: "1,1,1,1,2,1" },
    { EV_COUNTS: "1,2,1,1,2,1 " },
    { EV_MESSAGE: "X".repeat(221) },
    { GUSRVB: "caller supplied owner" },
    { writeAvailable: true }
  ])
    assert.throws(
      () => inspectConfigurationBteLockProof({ ...synthetic(), ...patch }),
      /BTE_LOCK_PROOF_UNVERIFIED/
    )
  assert.throws(() => inspectConfigurationBteLockProof(null), /BTE_LOCK_PROOF_UNVERIFIED/)
})

test("native status, flag and both count triples must agree", () => {
  for (const result of [
    { ...synthetic(), EV_CODE: "SCOPE_NOT_RETAINED" },
    { ...synthetic(), EV_RETAINED: "" },
    { ...synthetic("1,2,0,1,2,1"), EV_CODE: "SCOPE_RETAINED" },
    { ...synthetic("1,2,1,1,2,0"), EV_RETAINED: "X" }
  ])
    assert.throws(() => inspectConfigurationBteLockProof(result), /BTE_LOCK_PROOF_INCONSISTENT/)
})

test("live full lock sources prove delegation to the kernel, not cumulative retention", () => {
  assert.equal(observed.sourceOnly, true)
  assert.equal(observed.nativeLockCalls, 0)
  assert.equal(observed.configurationWrites, 0)
  assert.equal(observed.metaCalls, 0)
  const enqueue = observed.functions.ENQUEUE_E_TRKORR.source.join("\n")
  const dequeue = observed.functions.DEQUEUE_E_TRKORR.source.join("\n")
  assert.match(enqueue, /VALUE\(_SCOPE\) DEFAULT '2'/)
  assert.match(enqueue, /__seqta_tab-gname = 'E070'/)
  assert.match(enqueue, /USING '1' __scope __wait ' ' 'E_TRKORR'/)
  assert.match(dequeue, /VALUE\(_SCOPE\) DEFAULT '3'/)
  assert.match(dequeue, /USING '2' __scope ' ' __synchron 'E_TRKORR'/)
  const implementation = observed.includes.LSENAF01.source
  assert.match(implementation, /CALL 'C_ENQUEUE'[\s\S]*?ID 'USTP' FIELD _scope/)
  assert.match(implementation, /ID 'OPCODE' FIELD '7'/)
  assert.match(implementation, /gv_kayak_active <> space and rc = 0/)
  const reader = observed.functions.ENQUEUE_READ.source.join("\n")
  assert.match(reader, /KEEPING LOGICAL UNIT OF WORK/)
  assert.match(reader, /ENQUEUE_READ_CALLS = ENQUEUE_READ_CALLS \+ 1/)
  assert.match(reader, /CALL FUNCTION 'RFC_CONNECTION_CLOSE'/)
  assert.match(reader, /IF ENQ-GUSE = 0\.[\s\S]*?ENQ-GUSR = SPACE/)
  assert.match(reader, /IF ENQ-GUSEVB = 0\.[\s\S]*?ENQ-GUSRVB = SPACE/)
  for (const record of Object.values(observed.includes) as {
    source: string
    sourceFingerprint: string
    lineCount: number
  }[]) {
    assert.equal(createHash("sha256").update(record.source).digest("hex"), record.sourceFingerprint)
    assert.equal(record.source.split("\n").length, record.lineCount)
  }
})

test("the candidate cannot accept caller-selected targets or export lock owner tokens", () => {
  assert.deepEqual(
    api.importParameters.map((p) => [p.name, p.typeName]),
    [["IV_CONFIRM", "CHAR40"]]
  )
  assert.equal(api.tableParameters.length, 0)
  assert.equal(api.updateTask, false)
  assert.match(candidate, /sy-sysid <> 'GR2' OR sy-mandt <> '200' OR sy-uname <> 'WYS'/)
  assert.match(candidate, /iv_confirm <> 'TEMPORARY_LOCK_PROBE_ONLY'/)
  assert.match(candidate, /lv_key = 'GR2K923429'/)
  assert.match(candidate, /lv_key = 'GR2K923430'/)
  assert(api.exportParameters.every((p) => !/OWNER|GUSR|LOCKS/.test(p.name)))
  assert.doesNotMatch(candidate, /\b(?:COMMIT WORK|ROLLBACK WORK|DB_COMMIT|DEQUEUE_ALL)\b(?!\.)/)
  const statements = candidate
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("*"))
    .join("\n")
  assert.doesNotMatch(statements, /\b(?:UPDATE|INSERT|DELETE|MODIFY|EXPORT TO MEMORY)\b/)
  assert.doesNotMatch(statements, /SET_ENQUEUE_OWNER|CALL TRANSACTION|CALL SCREEN/)
  assert.doesNotMatch(statements, /CFG_BTE_META|VIEW_MAINTENANCE|CP_INFO|BCSET|_scope = '1'/)
})

test("failed acquisition never adds a cleanup reference; cleanup inspects owners before claiming clean", () => {
  assert.match(
    candidate,
    /IF sy-subrc <> 0\.[\s\S]*?ev_code = 'LOCK_ACQUIRE_FAILED'[\s\S]*?EXIT\.[\s\S]*?ENDIF\.[\s\S]*?ADD 1 TO lv_acquired/
  )
  assert.match(candidate, /DO lv_acquired TIMES\.[\s\S]*?_scope = '2' _synchron = 'X'/)
  assert.match(candidate, /ls_lock-gusevb > 0 AND\s+ls_lock-gusrvb = lv_update_owner/)
  assert.match(
    candidate,
    /IF lv_cleanup_failed = 'X'\.[\s\S]*?ev_code = 'LOCK_CLEANUP_UNVERIFIED'[\s\S]*?RETURN\.[\s\S]*?ENDIF\.[\s\S]*?ev_clean = 'X'/
  )
  assert.match(candidate, /lv_number <> lv_lines/)
  assert.match(candidate, /IF lv_lines <> 0\.[\s\S]*?ev_code = 'EXISTING_E070_LOCKS'/)
})

test("native table save skips frame cleanup and can return success after uncounted updates", () => {
  assert.match(observed.includes.BFTM.source, /INCLUDE LBFTMF00/)
  assert.match(observed.includes.BFTM.source, /INCLUDE LBFTMUXX/)
  assert.match(observed.includes.LBFTMUXX.source, /INCLUDE LBFTMU02\. *"TABLEPROC_BFTM/)
  assert.match(observed.includes.LBFTMF00.source, /INCLUDE LSVIMFTX/)
  assert.match(observed.functions.TABLEPROC_BFTM.source.join("\n"), /PERFORM TABLEPROC/)
  const generic = observed.includes.LSVIMFTX.source
  const tableproc = generic.slice(generic.indexOf("FORM  tableproc."))
  assert.match(tableproc, /WHEN save\.[\s\S]*?PERFORM prepare_saving/)
  assert.match(tableproc, /IF sy-subrc EQ 0\.[\s\S]*?PERFORM table_db_upd/)
  assert.doesNotMatch(tableproc, /before_leaving_frame_function|before_leaving_ext/)
  assert.match(generic, /UPDATE \(x_header-maintview\) FROM TABLE <mod_elem_tab>\.[\s\S]*?ENDIF/)
  assert.match(generic, /CLEAR: <status>-upd_flag,[\s\S]*?MESSAGE s018\(sv\)/)
  assert.match(observed.includes.LSVIMF11.source, /CALL FUNCTION 'VIEW_RESET_LANGUAGES'/)
  assert.match(observed.includes.LSVIMF11.source, /CALL FUNCTION 'DEQUEUE_E_TRKORR'/)
  assert.match(observed.includes.LSVIMF12.source, /PERFORM BEFORE_LEAVING_FRAME_FUNCTION/)
  assert.equal(configurationBteSavePathConstraints.maintenance.requireAllExitCleanupProof, true)
})

test("both task creation APIs commit internally and the update header can roll back", () => {
  for (const name of ["TRINT_INSERT_NEW_COMM", "TRINT_INSERT_NEW_COMM_WITH_NAM"])
    assert.match(observed.functions[name].source.join("\n"), /CALL FUNCTION 'DB_COMMIT'/)
  assert.match(observed.functions.TRINT_UPDATE_COMM_HEADER.source.join("\n"), /ROLLBACK WORK/)
  assert.equal(configurationBteSavePathConstraints.cts.creationPathsMustBeExcludedUnderLock, true)
  assert.equal(
    configurationBteSavePathConstraints.cts.retainLocksThroughCallerCommitVerified,
    false
  )
})
