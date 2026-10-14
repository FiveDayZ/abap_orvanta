import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import {
  attestConfigurationBteSaveIncludes,
  inspectConfigurationBteTaskSelection,
  configurationBteSavePathConstraints
} from "../src/configuration-bte-save-closure.js"
import { configurationTransportLayouts } from "../src/configuration-transport.js"
import {
  NATIVE_PREVIEW_EMPTY_HTML,
  reviewedTableReaderDefinition
} from "../src/reviewed-table-reader.js"

const observed = JSON.parse(
  readFileSync(
    new URL("./fixtures/configuration-bte-save-closure-w200-r77.json", import.meta.url),
    "utf8"
  )
)

test("actual reached includes attest from complete source bytes, not a caller-supplied hash", async () => {
  const calls: string[] = []
  const pins = await attestConfigurationBteSaveIncludes(async (name) => {
    calls.push(name)
    return structuredClone(observed.includes[name])
  })
  assert.equal(calls.length, 4)
  assert.equal(new Set(calls).size, 4)
  assert.equal(pins.LSTRDF50!.lineCount, 3336)
  assert.equal(configurationBteSavePathConstraints.nativeExecutionVerified, false)
})

test("include drift, wrong URI/version representation, scope and dictionary content reject", async () => {
  for (const patch of [
    { source: observed.includes.LSVIMF0U.source.replace("LOCAL:", "DATA:") },
    { source: observed.includes.LSVIMF0U.source + "\r\n" },
    { source: observed.includes.LSVIMF0U.source.replaceAll("\r\n", "\n") },
    { source: "", sourceFingerprint: observed.includes.LSVIMF0U.sourceFingerprint },
    { sourceUri: observed.includes.LSVIMF0U.sourceUri + "?version=inactive" },
    { objectName: "OTHER" },
    { connectionId: "w300" },
    { kind: "dictionary" }
  ]) {
    let calls = 0
    await assert.rejects(
      attestConfigurationBteSaveIncludes(async (name) => {
        calls++
        const record = structuredClone(observed.includes[name])
        return name === "LSVIMF0U" ? { ...record, ...patch } : record
      }),
      /SOURCE_UNVERIFIED/
    )
    assert.equal(calls, 4)
  }
  await assert.rejects(
    attestConfigurationBteSaveIncludes(async () => {
      throw Error("offline")
    }),
    /SOURCE_UNVERIFIED/
  )
})

test("actual CTS creation, unordered task selection and early release remain explicit blockers", () => {
  const source: string = observed.includes.LSTRDF50.source
  assert.match(
    source,
    /SELECT trkorr FROM e070 UP TO 1 ROWS INTO lv_task[\s\S]*?as4user\s*= sy-uname[\s\S]*?trfunction = lv_task_type[\s\S]*?ENDSELECT/
  )
  assert.match(source, /IF pv_task = space\.[\s\S]*?CALL FUNCTION 'TR_INSERT_NEW_COMM'/)
  const exit: string = observed.ctsExit.ranges[1].source.join("\n")
  assert.match(exit, /IF is_api_call-no_dbcommit NE 'X'[\s\S]*?CALL FUNCTION 'DB_COMMIT'/)
  assert.match(exit, /dequeue_trkorr_conditional ls_m-recording-task/)
  assert.equal(configurationBteSavePathConstraints.cts.requireUniqueExistingTask, true)
  assert.equal(
    configurationBteSavePathConstraints.cts.retainLocksThroughCallerCommitVerified,
    false
  )
  const call: string = observed.includes.LSVIMF0U.source
  assert.match(
    call,
    /LOCAL: vim_import_mode_active, vim_no_dialog, vim_import_testmode,[\s\S]*?vim_import_forcemode/
  )
  assert.match(call, /PERFORM vim_process_message/)
  assert(configurationBteSavePathConstraints.maintenance.saveMayLogErrorWithoutRaisingException)
})

function fixture() {
  const input = { requestNumber: "GR2K923429", taskNumber: "GR2K923430" }
  const task = {
    TRKORR: input.taskNumber,
    TRFUNCTION: "Q",
    TRSTATUS: "D",
    TARSYSTEM: "",
    KORRDEV: "CUST",
    AS4USER: "WYS",
    AS4DATE: "20261007",
    AS4TIME: "080000",
    STRKORR: input.requestNumber
  }
  const tasks = [task]
  const checks = Object.fromEntries(
    [
      "requestType",
      "taskType",
      "requestOpen",
      "taskOpen",
      "requestIsRoot",
      "taskParent",
      "taskOwnerMatchesConfiguredUser",
      "requestClient",
      "taskClient",
      "requestCategory",
      "taskCategory",
      "transportTarget"
    ].map((k) => [k, true])
  )
  const transport = {
    connectionId: "w200",
    client: "200",
    ...input,
    status: "metadata_matches",
    readOnly: true,
    saveAvailable: false,
    readFingerprint: "1".repeat(64),
    checks,
    observed: { task: [structuredClone(task)] }
  }
  const calls = { transport: 0, query: 0, remote: 0 }
  const backend = {
    runQuery: async (_id: string, query: string) => {
      calls.query++
      assert.match(query, /FROM E070 WHERE/)
      for (const [field, value] of [
        ["STRKORR", input.requestNumber],
        ["AS4USER", "WYS"],
        ["TRFUNCTION", "Q"],
        ["TRSTATUS", "D"]
      ])
        assert(query.includes(`${field} = '${value}'`))
      return structuredClone(tasks)
    },
    callRemoteFunction: async (
      _id: string,
      request: { functionName: string; inputParameters: Record<string, unknown> }
    ) => {
      calls.remote++
      assert.equal(request.functionName, "RFC_READ_TABLE")
      return {
        outputs: {
          FIELDS: Object.keys(task).map((FIELDNAME) => ({ FIELDNAME })),
          DATA: tasks.map((row) => ({ WA: Object.values(row).join("|") }))
        }
      }
    }
  }
  const readers = {
    transport: async () => {
      calls.transport++
      return structuredClone(transport)
    },
    table: async (): Promise<unknown> => ({
      connectionId: "w200",
      objectKind: "transparentTable",
      objectName: "E070",
      fingerprint: configurationTransportLayouts.E070
    }),
    definition: async () => ({
      functionName: "RFC_READ_TABLE",
      remoteEnabled: true,
      updateTask: false,
      sourceFingerprint: reviewedTableReaderDefinition.shape.sourceFingerprint.value,
      interfaceFingerprint: reviewedTableReaderDefinition.shape.interfaceFingerprint.value
    })
  }
  const run = (user = "wys", pair = input) =>
    inspectConfigurationBteTaskSelection(pair, user, backend, readers)
  return { input, task, tasks, transport, calls, backend, readers, run }
}

test("sole existing current-user Q/D task matches, but grants no lock, authenticated user or write proof", async () => {
  const f = fixture(),
    result = await f.run()
  assert.equal(result.status, "unique_existing_task_observed")
  assert.equal(result.standardRequestArgument, f.input.requestNumber)
  assert.equal(result.eligibleTasks[0]!.TRKORR, f.input.taskNumber)
  assert.equal(result.writeAvailable, false)
  assert.equal(result.authenticatedUserVerified, false)
  assert.equal(result.creationRaceExcluded, false)
  assert.equal(result.retainLocksThroughCommitVerified, false)
  assert.deepEqual(f.calls, { transport: 1, query: 1, remote: 0 })
})

test("multiple, absent or different eligible tasks cannot select or create one implicitly", async () => {
  for (const [mode, code] of [
    ["multiple", "TASK_SELECTION_AMBIGUOUS"],
    ["absent", "TASK_NOT_FOUND"],
    ["different", "TASK_SELECTION_MISMATCH"]
  ]) {
    const f = fixture()
    if (mode === "multiple") f.tasks.push({ ...f.task, TRKORR: "GR2K923431" })
    if (mode === "absent") f.tasks.length = 0
    if (mode === "different") f.task.TRKORR = "GR2K923431"
    await assert.rejects(f.run(), new RegExp(code!))
    assert.equal(f.calls.remote, 0)
  }
})

test("foreign, released, wrong type/client/category/request metadata refuses before reading candidates", async () => {
  for (const key of Object.keys(fixture().transport.checks)) {
    const f = fixture()
    f.transport.checks[key] = false
    await assert.rejects(f.run(), /TRANSPORT_UNVERIFIED/)
    assert.equal(f.calls.query, 0)
  }
  for (const patch of [
    { client: "300" },
    { requestNumber: "GR2K923400" },
    { readOnly: false },
    { saveAvailable: true },
    { status: "unknown" }
  ]) {
    const f = fixture()
    Object.assign(f.transport, patch)
    await assert.rejects(f.run(), /TRANSPORT_UNVERIFIED/)
    assert.equal(f.calls.query, 0)
  }
})

test("invalid user/transport identifiers, duplicate or out-of-scope candidates and changed DDIC fail closed", async () => {
  const user = fixture()
  await assert.rejects(user.run("WYS' OR 1=1"), /USER_UNVERIFIED/)
  await assert.rejects(
    user.run("wys", { ...user.input, taskNumber: user.input.requestNumber }),
    /TRANSPORT_SCOPE_UNSUPPORTED/
  )
  assert.equal(user.calls.transport, 0)
  for (const patch of [
    { AS4USER: "OTHER" },
    { STRKORR: "GR2K923000" },
    { TRSTATUS: "R" },
    { TRFUNCTION: "S" }
  ]) {
    const f = fixture()
    Object.assign(f.task, patch)
    await assert.rejects(f.run(), /^Error: BTE_SAVE_CLOSURE_RESPONSE_SCOPE_MISMATCH$/)
  }
  const duplicate = fixture()
  duplicate.tasks.push({ ...duplicate.task })
  await assert.rejects(duplicate.run(), /TASK_DUPLICATE/)
  const layout = fixture()
  layout.readers.table = async () => ({
    connectionId: "w200",
    objectKind: "transparentTable",
    objectName: "E070",
    fingerprint: "0".repeat(64)
  })
  await assert.rejects(layout.run(), /CTS_LAYOUT_UNVERIFIED/)
  assert.equal(layout.calls.query, 0)
})

test("truncation or unavailable reads never become an absent task; reviewed RFC fallback stays readonly", async () => {
  const f = fixture()
  f.tasks.length = 0
  for (let i = 0; i < 201; i++) f.tasks.push({ ...f.task, TRKORR: `GR2K${String(100000 + i)}` })
  await assert.rejects(f.run(), /TASK_READ_INCOMPLETE/)
  const offline = fixture()
  offline.backend.runQuery = async () => {
    throw Error("offline")
  }
  await assert.rejects(offline.run(), /TASK_READ_FAILED/)
  const fallback = fixture()
  fallback.backend.runQuery = async () => {
    throw Error(NATIVE_PREVIEW_EMPTY_HTML)
  }
  assert.equal((await fallback.run()).status, "unique_existing_task_observed")
  assert.equal(fallback.calls.remote, 1)
})
