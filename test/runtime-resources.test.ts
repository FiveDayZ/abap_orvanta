import assert from "node:assert/strict"
import test from "node:test"
import {
  collectDbActivity,
  collectFileSystemDirectory,
  collectPerformanceSnapshot,
  collectUserSessions,
  collectWorkProcesses,
  collectWorkloadDirectory
} from "../src/runtime-resources.js"
import type { RuntimeHelperRead, RuntimeHelperReply } from "../src/runtime-resources.js"
import type { RemoteFunctionRequest, SapBackend } from "../src/backend.js"

const workProcessDefinition = {
  functionName: "TH_WPINFO",
  remoteEnabled: true,
  updateTask: false,
  sourceFingerprint: "cf3be4d651ae9af6f156fde4d8cf6ea3fd932102df575ae1d4908eae23e2ed16",
  interfaceFingerprint: "e5d7078c36abdbbe48cb23c47071e101f82320ec1723dbc7f93b7a4c8edc2f70"
}

const sessionDefinition = {
  functionName: "TH_USER_LIST",
  remoteEnabled: true,
  updateTask: false,
  sourceFingerprint: "1cc2a482e5e08b3edbe5ce921d8fe4c5ae4065b7088da7154d5aeadd006716dc",
  interfaceFingerprint: "8d88542a7b1793f646033e41bb96ffb59b27b4fb73d58190b4a9fc103e429a01"
}

const directoryDefinition = {
  functionName: "EPS2_GET_DIRECTORY_LISTING",
  remoteEnabled: true,
  updateTask: false,
  sourceFingerprint: "50a403b6ad5276063ac101178f612c19650e92f9a5610dfe9b8b19784fd7bde6",
  interfaceFingerprint: "3951eb2659cf3bf01fd74769262050bec5ffd84c83517b84d23f0725a0c3ebeb"
}

const workloadDirectoryDefinition = {
  functionName: "SWNC_GET_WORKLOAD_DIRECTORY",
  remoteEnabled: true,
  updateTask: false,
  sourceFingerprint: "80c9c534b86010b44769b225c0fb4795d85bdaa03c6c51504fd0db17f86171af",
  interfaceFingerprint: "cbf0f41e2155f4906dc0943db710fb03d158449a19a287482b01462a54919c4c"
}

type SapStructureRow = Record<string, string>

type Double = {
  backend: Pick<SapBackend, "callRemoteFunction">
  calls: RemoteFunctionRequest[]
}

/**
 * The workload-directory read still calls its function module itself, so it keeps the SOAP-RFC
 * double: the mock answers exactly the output that tool requests and records every request.
 */
function double(
  outputs: Record<string, unknown>,
  fault?: { name: string; code: string; message: string }
): Double {
  const calls: RemoteFunctionRequest[] = []
  const backend = {
    callRemoteFunction: async (_connection: string, request: RemoteFunctionRequest) => {
      calls.push(request)
      return fault ? { outputs, fault } : { outputs }
    }
  }
  return { backend: backend as unknown as Double["backend"], calls }
}

type HelperCall = { action: string; parameters: Record<string, string> }

type HelperDouble = {
  read: RuntimeHelperRead
  calls: HelperCall[]
}

/**
 * The helper-backed reads take their reader as a parameter, so the reader is the seam: this double
 * answers one reply and records the action and parameters the collector asked for. Values are built
 * as a plain JSON object, exactly as the helper's envelope arrives over MCP.
 */
function helper(
  reply: Record<string, unknown>,
  options: { unavailable?: string; reason?: string; throws?: unknown } = {}
): HelperDouble {
  const calls: HelperCall[] = []
  const read: RuntimeHelperRead = async (action, parameters) => {
    calls.push({ action, parameters })
    if ("throws" in options) throw options.throws
    if (options.unavailable !== undefined)
      return options.reason === undefined
        ? { unavailable: options.unavailable }
        : { unavailable: options.unavailable, reason: options.reason }
    return { reply: { status: "ok", code: "OK", ...reply } as RuntimeHelperReply }
  }
  return { read, calls }
}

/** A WPINFO row with only the fields these assertions read filled in; every field is a string. */
function workProcessRow(overrides: Record<string, string> = {}): SapStructureRow {
  return {
    WP_NO: "1",
    WP_ITYPE: "0",
    WP_TYP: "DIA",
    WP_PID: "12345",
    WP_ISTATUS: "0",
    WP_STATUS: "Wait",
    WP_IWAIT: "0",
    WP_WAITING: "",
    WP_SEM: "",
    WP_IRESTRT: "0",
    WP_RESTART: "",
    WP_DUMPS: "",
    WP_CPU: "0.00",
    WP_ELTIME: "00:01",
    WP_MANDT: "200",
    WP_BNAME: "WYS",
    WP_REPORT: "SAPLSM50",
    WP_IACTION: "0",
    WP_ACTION: "",
    WP_TABLE: "",
    WP_SERVER: "sapw200",
    WP_WAITINF: "",
    WP_WAITTIM: "",
    WP_SEMSTAT: "0",
    WP_INDEX: "1",
    ...overrides
  }
}

/** A USRINFO row with only the fields these assertions read filled in. */
function sessionRow(overrides: Record<string, string> = {}): SapStructureRow {
  return {
    TID: "1",
    MANDT: "200",
    BNAME: "WYS",
    TCODE: "SM04",
    TERM: "term01",
    ZEIT: "10:15:00",
    MASTER: "",
    TRACE: "0",
    EXTMODI: "0",
    INTMODI: "0",
    TYPE: "0",
    STAT: "0",
    PROTOCOL: "0",
    GUIVERSION: "7.30",
    RFC_TYPE: "",
    HOSTADDR: "10.0.0.1",
    ...overrides
  }
}

test("a work process read lifts the row and keeps the untranslated row alongside it", async () => {
  const { read, calls } = helper({
    action: "WP_LIST",
    server: "sapw200",
    rows: [
      workProcessRow(),
      workProcessRow({ WP_NO: "2", WP_TYP: "BGD", WP_STATUS: "Run", WP_BNAME: "WF-BATCH" })
    ],
    truncated: false
  })
  const result = await collectWorkProcesses(read, "w200", {}, async () => workProcessDefinition)

  // The helper is the only route now, and it is asked for the opcode with the bounded limit.
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.action, "WP_LIST")
  // No server filter means no server value: the kernel's own default list is what is read.
  assert.deepEqual(calls[0]!.parameters, { IV_SERVER: "", IV_LIMIT: "200" })

  assert.equal(result.status, "ok")
  assert.equal(result.readOnly, true)
  assert.equal(result.returnedCount, 2)
  assert.equal(result.truncated, false)
  assert.equal(result.workProcesses[0]!.number, "1")
  assert.equal(result.workProcesses[0]!.status, "Wait")
  assert.equal(result.workProcesses[0]!.server, "sapw200")
  assert.equal(result.workProcesses[1]!.type, "BGD")
  // The value is reported as the kernel returned it, and the raw row keeps every field.
  assert.equal(result.workProcesses[0]!.raw.WP_STATUS, "Wait")
  assert.equal(result.interpretedFields.status, "WP_STATUS")
  assert.deepEqual(result.counts.byStatus, { Wait: 1, Run: 1 })
  assert.deepEqual(result.counts.byType, { DIA: 1, BGD: 1 })
  assert.equal(result.sources[0]!.table, "TH_WPINFO")
  assert.equal(result.sources[0]!.method, "helper")
  assert.equal(result.sources[0]!.code, undefined)
  assert.deepEqual(result.queryWarnings, [])
  assert.ok(result.notes.some((note) => /separately approved RUNTIME helper scope/.test(note)))
  assert.ok(result.notes.some((note) => /No value is translated/.test(note)))
  assert.ok(result.notes.some((note) => /cannot restart, stop, debug or resubmit/.test(note)))
})

test("a server filter is passed verbatim and an unusable one is refused before the helper is asked", async () => {
  const { read, calls } = helper({ action: "WP_LIST", server: "sapw200", rows: [workProcessRow()] })
  const filtered = await collectWorkProcesses(
    read,
    "w200",
    { serverName: "  sapw200  " },
    async () => workProcessDefinition
  )
  // Only the surrounding blanks are removed: the case belongs to the caller and is never rewritten
  // in the service, so the helper is asked for exactly the trimmed value.
  assert.deepEqual(calls[0]!.parameters, { IV_SERVER: "sapw200", IV_LIMIT: "200" })
  assert.equal(filtered.serverName, "sapw200")
  assert.equal(filtered.filters.serverName, "sapw200")
  // The helper TRANSLATEs its own copy to upper case before the kernel's SRVNAME import sees it,
  // and the answer says so - without claiming the value reported here was upper-cased.
  assert.ok(filtered.notes.some((note) => /upper-cases serverName/.test(note)))

  for (const serverName of ["S".repeat(41), "sap\u0000w200"]) {
    const refused = helper({ action: "WP_LIST", rows: [workProcessRow()] })
    await assert.rejects(
      () =>
        collectWorkProcesses(
          refused.read,
          "w200",
          { serverName },
          async () => workProcessDefinition
        ),
      /RUNTIME_RESOURCES_SCOPE_INVALID/
    )
    assert.equal(refused.calls.length, 0)
  }
  assert.equal(calls.length, 1)
})

test("a changed work process interface is refused instead of called", async () => {
  const { read, calls } = helper({ action: "WP_LIST", rows: [workProcessRow()] })
  const result = await collectWorkProcesses(read, "w200", {}, async () => ({
    ...workProcessDefinition,
    sourceFingerprint: "0".repeat(64)
  }))

  assert.equal(calls.length, 0)
  assert.equal(result.status, "unavailable")
  assert.equal(result.sources[0]!.code, "RUNTIME_RESOURCES_FUNCTION_UNVERIFIED")
  assert.deepEqual(result.queryWarnings, ["WP_LIST: RUNTIME_RESOURCES_FUNCTION_UNVERIFIED"])
})

test("an empty, invalid or failed work process answer stays an explicit failure", async () => {
  const empty = await collectWorkProcesses(
    helper({ action: "WP_LIST", rows: [] }).read,
    "w200",
    {},
    async () => workProcessDefinition
  )
  assert.equal(empty.status, "unavailable")
  assert.equal(empty.sources[0]!.status, "unavailable")
  assert.equal(empty.sources[0]!.code, "RUNTIME_RESOURCES_RESPONSE_EMPTY")
  assert.deepEqual(empty.workProcesses, [])

  // A row that is not a scalar map is a reply this service refuses rather than half-reads.
  const invalid = await collectWorkProcesses(
    helper({ action: "WP_LIST", rows: [{ WP_NO: { nested: "x" } }] }).read,
    "w200",
    {},
    async () => workProcessDefinition
  )
  assert.equal(invalid.sources[0]!.status, "invalid")
  assert.equal(invalid.sources[0]!.code, "RUNTIME_RESOURCES_RESPONSE_INVALID")

  // DIR_LIST carries DEC and INT4 columns, so a numeric cell is the reader's own rendering of a
  // value rather than a malformed row; it is kept as text and never reinterpreted.
  const numeric = await collectWorkProcesses(
    helper({ action: "WP_LIST", rows: [{ WP_NO: 42, WP_TYP: "DIA" }] }).read,
    "w200",
    {},
    async () => workProcessDefinition
  )
  assert.equal(numeric.status, "ok")
  assert.equal(numeric.workProcesses[0]!.raw.WP_NO, "42")
})

test("a gate that never called the helper and a helper code are both transcribed verbatim", async () => {
  const unapproved = await collectWorkProcesses(
    helper({}, { unavailable: "HELPER_NOT_APPROVED", reason: "APPROVAL_FILE_MISSING" }).read,
    "w200",
    {},
    async () => workProcessDefinition
  )
  assert.equal(unapproved.status, "unavailable")
  assert.equal(unapproved.sources[0]!.status, "unavailable")
  assert.equal(unapproved.sources[0]!.code, "HELPER_NOT_APPROVED")
  assert.deepEqual(unapproved.queryWarnings, [
    "WP_LIST: HELPER_NOT_APPROVED reason=APPROVAL_FILE_MISSING"
  ])

  // The callee's own sub-return code and exception name travel with the helper's code: neither is
  // turned into a label this service invented.
  const denied = await collectWorkProcesses(
    helper({
      action: "WP_LIST",
      status: "forbidden",
      code: "NO_AUTHORITY",
      calleeSubrc: "1",
      calleeException: "NOT_AUTHORIZED"
    }).read,
    "w200",
    {},
    async () => workProcessDefinition
  )
  assert.equal(denied.sources[0]!.status, "unavailable")
  assert.equal(denied.sources[0]!.code, "NO_AUTHORITY")
  assert.deepEqual(denied.queryWarnings, [
    "WP_LIST: NO_AUTHORITY calleeSubrc=1 calleeException=NOT_AUTHORIZED"
  ])

  // A reader that throws is reported as an unavailable read, never propagated to the caller.
  const broken = await collectWorkProcesses(
    helper({}, { throws: new Error("socket closed") }).read,
    "w200",
    {},
    async () => workProcessDefinition
  )
  assert.equal(broken.status, "unavailable")
  assert.equal(broken.sources[0]!.code, "RUNTIME_RESOURCES_CALL_FAILED")
  assert.deepEqual(broken.queryWarnings, ["WP_LIST: RUNTIME_RESOURCES_CALL_FAILED (socket closed)"])
})

test("a longer work process list than the row cap is reported as partial", async () => {
  const rows = [1, 2, 3].map((index) =>
    workProcessRow({ WP_NO: String(index), WP_INDEX: String(index) })
  )
  const result = await collectWorkProcesses(
    helper({ action: "WP_LIST", rows, truncated: true }).read,
    "w200",
    { maxRows: 2 },
    async () => workProcessDefinition
  )

  assert.equal(result.status, "partial")
  assert.equal(result.truncated, true)
  assert.equal(result.returnedCount, 2)
  assert.equal(result.workProcesses.length, 2)
  assert.equal(result.rowLimit, 2)
  assert.equal(result.rowLimitRequested, 2)
  assert.ok(result.notes.some((note) => /the row cap is 2/.test(note)))

  // A helper that sent more rows than were asked for is partial even without its own truncation flag.
  const overrun = await collectWorkProcesses(
    helper({ action: "WP_LIST", rows, truncated: false }).read,
    "w200",
    { maxRows: 2 },
    async () => workProcessDefinition
  )
  assert.equal(overrun.status, "partial")
  assert.equal(overrun.truncated, true)

  for (const maxRows of [0, 501]) {
    const refused = helper({ action: "WP_LIST", rows })
    await assert.rejects(
      () =>
        collectWorkProcesses(refused.read, "w200", { maxRows }, async () => workProcessDefinition),
      /RUNTIME_RESOURCES_ROW_LIMIT_INVALID/
    )
    assert.equal(refused.calls.length, 0)
  }
})

test("a row limit the helper refuses is passed through and named in the answer", async () => {
  const { read, calls } = helper({
    action: "WP_LIST",
    status: "unsupported",
    code: "READ_ONLY_UNSUPPORTED"
  })
  const result = await collectWorkProcesses(
    read,
    "w200",
    { maxRows: 300 },
    async () => workProcessDefinition
  )

  // The service-side cap is wider than the helper's, so the request is sent and refused there.
  assert.deepEqual(calls[0]!.parameters, { IV_SERVER: "", IV_LIMIT: "300" })
  assert.equal(result.rowLimit, 300)
  assert.equal(result.status, "unavailable")
  assert.equal(result.sources[0]!.code, "READ_ONLY_UNSUPPORTED")
  assert.ok(result.notes.some((note) => /reads at most 200 rows per call/.test(note)))
})

test("a session read asks only for the output this service can verify", async () => {
  const { read, calls } = helper({
    action: "USER_LIST",
    kernelRowCount: "1",
    rows: [sessionRow()],
    truncated: false
  })
  const result = await collectUserSessions(read, "w200", {}, async () => sessionDefinition)

  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.action, "USER_LIST")
  assert.deepEqual(calls[0]!.parameters, { IV_LIMIT: "200" })

  assert.equal(result.status, "ok")
  assert.equal(result.returnedCount, 1)
  assert.equal(result.sessions[0]!.user, "WYS")
  assert.equal(result.sessions[0]!.transaction, "SM04")
  assert.equal(result.sessions[0]!.time, "10:15:00")
  assert.equal(result.interpretedFields.user, "BNAME")
  assert.equal(result.sessions[0]!.raw.BNAME, "WYS")
  assert.equal(result.filters.userName, null)
  assert.equal(result.filters.applied, "none")
  assert.equal(result.kernelRowCount, 1)
  assert.equal(result.matchedCount, 1)
  assert.equal(result.sources[0]!.method, "helper")
  assert.ok(result.notes.some((note) => /only USRLIST \(USRINFO\) is read/.test(note)))
  assert.ok(result.notes.some((note) => /cannot terminate a session/.test(note)))
})

test("a user filter is applied in the service and stays visible in the answer", async () => {
  const { read, calls } = helper({
    action: "USER_LIST",
    kernelRowCount: "3",
    rows: [
      sessionRow({ TID: "1", BNAME: "WYS" }),
      sessionRow({ TID: "2", BNAME: "WYS", TCODE: "SE38" }),
      sessionRow({ TID: "3", BNAME: "OTHER" })
    ],
    truncated: false
  })
  const result = await collectUserSessions(
    read,
    "w200",
    { userName: "wys" },
    async () => sessionDefinition
  )

  // TH_USER_LIST has no user import, so the filter cannot be pushed down to the helper.
  assert.deepEqual(calls[0]!.parameters, { IV_LIMIT: "200" })
  assert.equal(result.kernelRowCount, 3)
  assert.equal(result.matchedCount, 2)
  assert.equal(result.returnedCount, 2)
  assert.deepEqual(
    result.sessions.map((session) => session.sessionId),
    ["1", "2"]
  )
  assert.equal(result.filters.userName, "WYS")
  assert.equal(result.filters.applied, "service_side")
  assert.deepEqual(result.counts.byUser, { WYS: 2 })
  assert.ok(result.notes.some((note) => /applied in the service/.test(note)))
  assert.ok(result.notes.some((note) => /not "the user does not exist"/.test(note)))
  assert.ok(result.notes.some((note) => /before that\s+filter runs|before that/.test(note)))
})

test("a session answer that matches nothing is empty, not a failure", async () => {
  const { read } = helper({
    action: "USER_LIST",
    kernelRowCount: "1",
    rows: [sessionRow({ BNAME: "OTHER" })]
  })
  const result = await collectUserSessions(
    read,
    "w200",
    { userName: "WYS" },
    async () => sessionDefinition
  )

  // The kernel answered: the tool reports an empty match rather than an unavailable read.
  assert.equal(result.status, "ok")
  assert.equal(result.matchedCount, 0)
  assert.equal(result.returnedCount, 0)
  assert.equal(result.kernelRowCount, 1)
  assert.deepEqual(result.sessions, [])
  assert.deepEqual(result.queryWarnings, [])
})

test("the row count falls back to the rows when the helper sent no count", async () => {
  const { read } = helper({ action: "USER_LIST", rows: [sessionRow(), sessionRow({ TID: "2" })] })
  const result = await collectUserSessions(read, "w200", {}, async () => sessionDefinition)

  assert.equal(result.kernelRowCount, 2)
  assert.equal(result.matchedCount, 2)
})

test("a longer session match than the row cap is reported as partial", async () => {
  const rows = [1, 2, 3].map((index) => sessionRow({ TID: String(index) }))
  const result = await collectUserSessions(
    helper({ action: "USER_LIST", kernelRowCount: "3", rows, truncated: true }).read,
    "w200",
    { maxRows: 2 },
    async () => sessionDefinition
  )

  assert.equal(result.status, "partial")
  assert.equal(result.truncated, true)
  assert.equal(result.kernelRowCount, 3)
  assert.equal(result.matchedCount, 3)
  assert.equal(result.returnedCount, 2)
  assert.equal(result.sessions.length, 2)
  assert.ok(result.notes.some((note) => /the row cap is 2/.test(note)))
})

test("a changed session interface or an unusable user name never reaches the helper", async () => {
  const changed = helper({ action: "USER_LIST", rows: [sessionRow()] })
  const result = await collectUserSessions(changed.read, "w200", {}, async () => ({
    ...sessionDefinition,
    interfaceFingerprint: "0".repeat(64)
  }))
  assert.equal(changed.calls.length, 0)
  assert.equal(result.sources[0]!.code, "RUNTIME_RESOURCES_FUNCTION_UNVERIFIED")
  assert.deepEqual(result.queryWarnings, ["USER_LIST: RUNTIME_RESOURCES_FUNCTION_UNVERIFIED"])

  const refused = helper({ action: "USER_LIST", rows: [sessionRow()] })
  await assert.rejects(
    () =>
      collectUserSessions(
        refused.read,
        "w200",
        { userName: "TOO-LONG-USER-NAME" },
        async () => sessionDefinition
      ),
    /RUNTIME_RESOURCES_SCOPE_INVALID/
  )
  assert.equal(refused.calls.length, 0)
})

/** An EPS2FILI row: the five fields DIR_LIST carries, as the helper returns them. */
function directoryRow(overrides: Record<string, string> = {}): SapStructureRow {
  return {
    NAME: "tran.log",
    SIZE: "4096",
    MTIM: "2026-09-25 10:00:00",
    OWNER: "wys",
    RC: "0000",
    ...overrides
  }
}

test("a directory listing lifts the kernel's own fields and keeps the raw row", async () => {
  const { read, calls } = helper({
    action: "DIR_LIST",
    directory: "/usr/sap/W200",
    fileCounter: "2",
    errorCounter: "0",
    rows: [
      directoryRow(),
      directoryRow({ NAME: "dev_w0", SIZE: "1024", RC: "0004", OWNER: "root" })
    ],
    truncated: false
  })
  const result = await collectFileSystemDirectory(
    read,
    "w200",
    { directory: "/usr/sap/W200" },
    async () => directoryDefinition
  )

  assert.equal(result.status, "ok")
  assert.equal(result.readOnly, true)
  assert.equal(result.returnedCount, 2)
  assert.equal(result.truncated, false)
  assert.equal(result.entries[0]!.name, "tran.log")
  assert.equal(result.entries[0]!.size, "4096")
  assert.equal(result.entries[0]!.modifiedAt, "2026-09-25 10:00:00")
  assert.equal(result.entries[0]!.owner, "wys")
  assert.equal(result.entries[0]!.returnCode, "0000")
  assert.equal(result.entries[0]!.raw.NAME, "tran.log")
  assert.deepEqual(result.counts.byReturnCode, { "0000": 1, "0004": 1 })
  assert.equal(result.directoryReported, "/usr/sap/W200")
  assert.deepEqual(result.kernelCounters, { files: "2", errors: "0" })
  assert.deepEqual(result.sources[0]!.table, "EPS2_GET_DIRECTORY_LISTING")
  assert.equal(result.sources[0]!.method, "helper")
  assert.deepEqual(result.queryWarnings, [])
  assert.ok(result.notes.some((note) => /File contents are never read/.test(note)))
  assert.ok(result.notes.some((note) => /No fileMask was given/.test(note)))

  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.action, "DIR_LIST")
  assert.deepEqual(calls[0]!.parameters, {
    IV_DIR: "/usr/sap/W200",
    IV_MASK: "",
    IV_LIMIT: "200"
  })
})

test("a file mask is passed through verbatim when one is given", async () => {
  const { read, calls } = helper({
    action: "DIR_LIST",
    directory: "/usr/sap/W200/work",
    rows: [directoryRow()]
  })
  const result = await collectFileSystemDirectory(
    read,
    "w200",
    { directory: "/usr/sap/W200/work", fileMask: "*.log" },
    async () => directoryDefinition
  )

  assert.deepEqual(calls[0]!.parameters, {
    IV_DIR: "/usr/sap/W200/work",
    IV_MASK: "*.log",
    IV_LIMIT: "200"
  })
  assert.deepEqual(result.filters, { directory: "/usr/sap/W200/work", fileMask: "*.log" })
  assert.ok(!result.notes.some((note) => /No fileMask was given/.test(note)))
})

test("an empty directory is an ordinary answer, not a failure", async () => {
  const { read } = helper({ action: "DIR_LIST", directory: "/usr/sap/W200/empty", rows: [] })
  const result = await collectFileSystemDirectory(
    read,
    "w200",
    { directory: "/usr/sap/W200/empty" },
    async () => directoryDefinition
  )

  assert.equal(result.status, "ok")
  assert.equal(result.returnedCount, 0)
  assert.deepEqual(result.entries, [])
  assert.deepEqual(result.queryWarnings, [])
  assert.equal(result.sources[0]!.status, "ok")
  assert.equal(result.sources[0]!.code, undefined)
  assert.ok(
    result.notes.some((note) => /not evidence that the directory does not exist/.test(note))
  )
})

test("a listing that disagrees with the kernel's own counters says so", async () => {
  const { read } = helper({
    action: "DIR_LIST",
    directory: "/usr/sap/W200/other",
    fileCounter: "7",
    errorCounter: "2",
    rows: [directoryRow(), directoryRow({ NAME: "dev_w1" })]
  })
  const result = await collectFileSystemDirectory(
    read,
    "w200",
    { directory: "/usr/sap/W200" },
    async () => directoryDefinition
  )

  assert.equal(result.status, "ok")
  assert.ok(
    result.queryWarnings.some((warning) =>
      /FILE_COUNTER is 7 but the row list carried 2 entries/.test(warning)
    )
  )
  assert.ok(result.queryWarnings.some((warning) => /ERROR_COUNTER is 2/.test(warning)))
  assert.ok(
    result.notes.some((note) => /The kernel reported DIR_NAME=\/usr\/sap\/W200\/other/.test(note))
  )
})

test("a listing longer than the row cap is reported as partial", async () => {
  const rows = [1, 2, 3].map((index) => directoryRow({ NAME: `file-${index}` }))
  const result = await collectFileSystemDirectory(
    helper({ action: "DIR_LIST", fileCounter: "3", rows, truncated: true }).read,
    "w200",
    { directory: "/usr/sap/W200", maxRows: 2 },
    async () => directoryDefinition
  )

  assert.equal(result.status, "partial")
  assert.equal(result.truncated, true)
  assert.equal(result.returnedCount, 2)
  assert.equal(result.entries.length, 2)
  // A capped list is shorter than the kernel's count by construction, so it is not a disagreement.
  assert.deepEqual(result.queryWarnings, [])
  assert.ok(result.notes.some((note) => /the entries beyond the cap/.test(note)))
})

test("a changed directory interface never reaches the helper", async () => {
  const changed = helper({ action: "DIR_LIST", rows: [directoryRow()] })
  const result = await collectFileSystemDirectory(
    changed.read,
    "w200",
    { directory: "/tmp" },
    async () => ({
      ...directoryDefinition,
      interfaceFingerprint: "0".repeat(64)
    })
  )

  assert.equal(changed.calls.length, 0)
  assert.equal(result.sources[0]!.code, "RUNTIME_RESOURCES_FUNCTION_UNVERIFIED")
  assert.deepEqual(result.queryWarnings, ["DIR_LIST: RUNTIME_RESOURCES_FUNCTION_UNVERIFIED"])
})

test("an unusable path or mask is refused before the call", async () => {
  for (const directory of ["", "   ", "/usr/sap/../etc", `/${"a".repeat(200)}`, "/tmp\n/dev"]) {
    const refused = helper({ action: "DIR_LIST", rows: [directoryRow()] })
    await assert.rejects(
      () =>
        collectFileSystemDirectory(
          refused.read,
          "w200",
          { directory },
          async () => directoryDefinition
        ),
      /RUNTIME_RESOURCES_SCOPE_INVALID/
    )
    assert.equal(refused.calls.length, 0)
  }

  const longMask = helper({ action: "DIR_LIST", rows: [directoryRow()] })
  await assert.rejects(
    () =>
      collectFileSystemDirectory(
        longMask.read,
        "w200",
        { directory: "/tmp", fileMask: "a".repeat(41) },
        async () => directoryDefinition
      ),
    /RUNTIME_RESOURCES_SCOPE_INVALID/
  )
  assert.equal(longMask.calls.length, 0)
})

test("an unavailable or malformed directory answer stays an explicit failure", async () => {
  const denied = await collectFileSystemDirectory(
    helper({}, { unavailable: "SOURCE_NOT_APPROVED", reason: "RUNTIME" }).read,
    "w200",
    { directory: "/tmp" },
    async () => directoryDefinition
  )
  assert.equal(denied.status, "unavailable")
  assert.equal(denied.sources[0]!.code, "SOURCE_NOT_APPROVED")
  assert.deepEqual(denied.queryWarnings, ["DIR_LIST: SOURCE_NOT_APPROVED reason=RUNTIME"])

  const failed = await collectFileSystemDirectory(
    helper({ action: "DIR_LIST", status: "unsupported", code: "READ_ONLY_UNSUPPORTED" }).read,
    "w200",
    { directory: "/tmp" },
    async () => directoryDefinition
  )
  assert.equal(failed.status, "unavailable")
  assert.equal(failed.sources[0]!.code, "READ_ONLY_UNSUPPORTED")

  const malformed = await collectFileSystemDirectory(
    helper({ action: "DIR_LIST", directory: "/tmp" }).read,
    "w200",
    { directory: "/tmp" },
    async () => directoryDefinition
  )
  assert.equal(malformed.sources[0]!.status, "invalid")
  assert.equal(malformed.sources[0]!.code, "RUNTIME_RESOURCES_RESPONSE_INVALID")
})

/** A DB6PMHSD row: the columns this service lifts, as the helper's Open SQL returns them. */
function dbHistoryRow(overrides: Record<string, string> = {}): SapStructureRow {
  return {
    SYSID: "W200",
    COMPTIME: "20260930120000",
    PARTITN: "0",
    PL_D_LRS: "1000",
    DEADLOCKS: "0",
    LCK_WAITS: "3",
    BP_AV_RTM: "7",
    ...overrides
  }
}

/** A DB6PMHSB row, likewise trimmed to the columns these assertions read. */
function dbBufferPoolRow(overrides: Record<string, string> = {}): SapStructureRow {
  return {
    SYSID: "W200",
    COMPTIME: "20260930120000",
    PARTITN: "0",
    BP_NAME: "IBMDEFAULTBP",
    BP_SZ: "4096",
    PL_D_LRS: "900",
    ...overrides
  }
}

test("a database activity read lifts both tables and keeps every value untranslated", async () => {
  const { read, calls } = helper({
    action: "DB_ACTIVITY",
    systemId: "W200",
    historyRows: [dbHistoryRow()],
    bufferPoolRows: [dbBufferPoolRow()],
    truncated: false
  })
  const result = await collectDbActivity(read, "w200", {})

  assert.deepEqual(calls, [{ action: "DB_ACTIVITY", parameters: { IV_LIMIT: "200" } }])
  assert.equal(result.status, "ok")
  assert.equal(result.readOnly, true)
  // The helper's own SY-SYSID is where it ran - not a filter and not the rows' own system.
  assert.equal(result.systemId, "W200")
  assert.equal(result.filters.systemId, null)
  assert.equal(result.returnedCount, 2)
  assert.equal(result.counts.history, 1)
  assert.equal(result.counts.bufferPool, 1)
  assert.deepEqual(result.counts.bySystemId, { W200: 2 })

  assert.equal(result.historyRows[0]!.systemId, "W200")
  assert.equal(result.historyRows[0]!.compTime, "20260930120000")
  assert.equal(result.historyRows[0]!.poolDataLogicalReads, "1000")
  assert.equal(result.historyRows[0]!.lockWaits, "3")
  assert.equal(result.historyRows[0]!.raw.DEADLOCKS, "0")
  assert.equal(result.bufferPoolRows[0]!.bufferPoolName, "IBMDEFAULTBP")
  assert.equal(result.bufferPoolRows[0]!.bufferPoolSize, "4096")
  assert.equal(result.interpretedFields.historyRows.poolDataLogicalReads, "PL_D_LRS")
  assert.equal(result.interpretedFields.bufferPoolRows.bufferPoolName, "BP_NAME")

  assert.deepEqual(
    result.sources.map((source) => source.table),
    ["DB6PMHSD", "DB6PMHSB"]
  )
  assert.ok(result.sources.every((source) => source.method === "helper"))
  assert.deepEqual(
    result.sources.map((source) => source.returnedCount),
    [1, 1]
  )
  assert.deepEqual(result.queryWarnings, [])
  assert.ok(result.notes.some((note) => /no SYSID predicate was applied/.test(note)))
  assert.ok(result.notes.some((note) => /ORDER BY COMPTIME DESCENDING/.test(note)))
  assert.ok(
    result.notes.some((note) => /field texts behind those columns were not read/.test(note))
  )
})

test("an empty DB6 history is an empty list per table and not a failure", async () => {
  const { read } = helper({
    action: "DB_ACTIVITY",
    systemId: "W200",
    historyRows: [],
    bufferPoolRows: []
  })
  const result = await collectDbActivity(read, "w200", {})

  assert.equal(result.status, "ok")
  assert.equal(result.returnedCount, 0)
  assert.deepEqual(result.historyRows, [])
  assert.deepEqual(result.bufferPoolRows, [])
  assert.deepEqual(result.counts.bySystemId, {})
  assert.deepEqual(result.queryWarnings, [])
  assert.ok(result.notes.some((note) => /means the collector stored no history/.test(note)))
})

test("a truncated database activity answer is partial and names the cap", async () => {
  const { read } = helper({
    action: "DB_ACTIVITY",
    systemId: "W200",
    historyRows: [dbHistoryRow(), dbHistoryRow({ COMPTIME: "20260930130000" })],
    bufferPoolRows: [],
    truncated: true
  })
  const result = await collectDbActivity(read, "w200", { maxRows: 2 })

  assert.equal(result.status, "partial")
  assert.equal(result.truncated, true)
  assert.equal(result.returnedCount, 2)
  assert.equal(result.rowLimit, 2)
})

test("a failed database activity answer is carried by both sources", async () => {
  const { read } = helper({
    action: "DB_ACTIVITY",
    status: "forbidden",
    code: "NO_AUTHORITY",
    calleeSubrc: "1",
    calleeException: "NO_AUTHORITY"
  })
  const result = await collectDbActivity(read, "w200", {})

  assert.equal(result.status, "unavailable")
  assert.deepEqual(result.historyRows, [])
  assert.ok(result.sources.every((source) => source.code === "NO_AUTHORITY"))
  assert.ok(result.sources.every((source) => source.status === "unavailable"))
  assert.deepEqual(result.queryWarnings, [
    "DB_ACTIVITY: NO_AUTHORITY calleeSubrc=1 calleeException=NO_AUTHORITY"
  ])
})

test("a row limit above the helper's own cap is refused there and named in the answer", async () => {
  const { read, calls } = helper({
    action: "DB_ACTIVITY",
    status: "unsupported",
    code: "READ_ONLY_UNSUPPORTED"
  })
  const result = await collectDbActivity(read, "w200", { maxRows: 300 })

  assert.deepEqual(calls[0]!.parameters, { IV_LIMIT: "300" })
  assert.equal(result.rowLimit, 300)
  assert.ok(result.notes.some((note) => /reads at most 200 rows per table per call/.test(note)))
})

/** A SWNCSYSLOAD row, trimmed to the fields these assertions read. */
function performanceRow(overrides: Record<string, string> = {}): SapStructureRow {
  return {
    COMPONENT: "SAP_BASIS",
    PERIODTYPE: "D",
    PERIODSTRT: "20260925",
    FIRST_REC_DY: "19700101",
    FIRSTRECDY: "20260925",
    LASTRECDY: "20260925",
    COUNT: "12",
    RESPTI: "345",
    CPUTI: "67",
    CNT001: "1",
    ...overrides
  }
}

test("a performance snapshot echoes the unit the helper reported and lifts the row", async () => {
  const { read, calls } = helper({
    action: "PERF_SNAPSHOT",
    periodType: "D",
    periodStart: "20260925",
    timeUnit: "swnc-raw",
    rows: [performanceRow(), performanceRow({ COMPONENT: "SAP_BASIS", PERIODTYPE: "D" })],
    truncated: false
  })
  const result = await collectPerformanceSnapshot(read, "w200", {})

  assert.deepEqual(calls[0]!.parameters, { IV_PERIOD: "", IV_FROM: "", IV_LIMIT: "200" })
  assert.equal(result.status, "ok")
  assert.equal(result.readOnly, true)
  assert.equal(result.filters.periodType, null)
  assert.equal(result.filters.periodStart, null)
  assert.equal(result.periodType, "D")
  assert.equal(result.periodStart, "20260925")
  // The unit is the helper's own word and no divisor is applied to any value.
  assert.equal(result.timeUnit, "swnc-raw")
  assert.equal(result.returnedCount, 2)
  assert.deepEqual(result.counts.byComponent, { SAP_BASIS: 2 })
  assert.deepEqual(result.counts.byPeriodType, { D: 2 })
  assert.equal(result.rows[0]!.component, "SAP_BASIS")
  assert.equal(result.rows[0]!.responseTime, "345")
  assert.equal(result.rows[0]!.cpuTime, "67")
  assert.equal(result.rows[0]!.raw.CNT001, "1")
  assert.equal(result.interpretedFields.responseTime, "RESPTI")
  // CNT001..CNT009 are deliberately not lifted; they stay visible in the raw row only.
  assert.ok(!("cnt001" in result.interpretedFields))
  assert.equal(result.sources[0]!.table, "SWNC_COLLECTOR_GET_SYSTEMLOAD")
  assert.equal(result.sources[0]!.method, "helper")
  assert.deepEqual(result.queryWarnings, [])
  assert.ok(
    result.notes.some((note) => /applies no divisor, scaling or unit conversion/.test(note))
  )
  assert.ok(
    result.notes.some((note) => /SWNC_COLLECTOR_KERNEL_STAT and SWNC_COLLECTOR_STARTER/.test(note))
  )
  // Both defaults were left out, so the answer names the period the collector answered for.
  assert.ok(result.notes.some((note) => /No periodType was given/.test(note)))
  assert.ok(result.notes.some((note) => /No periodStart was given/.test(note)))
})

test("a requested period is sent to the helper and reported next to the helper's own echo", async () => {
  const { read, calls } = helper({
    action: "PERF_SNAPSHOT",
    periodType: "W",
    periodStart: "20260921",
    timeUnit: "swnc-raw",
    rows: [performanceRow({ PERIODTYPE: "W" })]
  })
  const result = await collectPerformanceSnapshot(read, "w200", {
    periodType: "W",
    periodStart: "20260921"
  })

  assert.deepEqual(calls[0]!.parameters, { IV_PERIOD: "W", IV_FROM: "20260921", IV_LIMIT: "200" })
  assert.equal(result.filters.periodType, "W")
  assert.equal(result.filters.periodStart, "20260921")
  assert.equal(result.periodType, "W")
  assert.ok(!result.notes.some((note) => /No periodType was given/.test(note)))
  assert.ok(!result.notes.some((note) => /No periodStart was given/.test(note)))
})

test("an unusable period shape is refused before the helper is asked", async () => {
  for (const options of [
    { periodType: "d" },
    { periodType: "DD" },
    { periodStart: "2026-09-25" },
    { periodStart: "2026092" }
  ]) {
    const refused = helper({ action: "PERF_SNAPSHOT", rows: [performanceRow()] })
    await assert.rejects(
      () => collectPerformanceSnapshot(refused.read, "w200", options),
      /RUNTIME_RESOURCES_SCOPE_INVALID/
    )
    assert.equal(refused.calls.length, 0)
  }
})

test("a truncated or failed performance snapshot is reported as such", async () => {
  const truncated = await collectPerformanceSnapshot(
    helper({
      action: "PERF_SNAPSHOT",
      periodType: "D",
      periodStart: "20260925",
      timeUnit: "swnc-raw",
      rows: [performanceRow(), performanceRow({ COMPONENT: "SAP_ABA" })],
      truncated: true
    }).read,
    "w200",
    { maxRows: 2 }
  )
  assert.equal(truncated.status, "partial")
  assert.equal(truncated.truncated, true)
  assert.equal(truncated.returnedCount, 2)
  assert.ok(truncated.notes.some((note) => /The answer is partial: the row cap is 2/.test(note)))

  const failed = await collectPerformanceSnapshot(
    helper({
      action: "PERF_SNAPSHOT",
      status: "not_found",
      code: "NOT_FOUND",
      calleeSubrc: "4",
      calleeException: "NO_DATA_FOUND"
    }).read,
    "w200",
    {}
  )
  assert.equal(failed.status, "unavailable")
  assert.equal(failed.sources[0]!.code, "NOT_FOUND")
  assert.deepEqual(failed.queryWarnings, [
    "PERF_SNAPSHOT: NOT_FOUND calleeSubrc=4 calleeException=NO_DATA_FOUND"
  ])
  assert.deepEqual(failed.rows, [])
})

/** A WORKLOAD_DIRECTORY row with the ten fields the reader lifts. */
function workloadDirectoryRow(overrides: Record<string, string> = {}): SapStructureRow {
  return {
    ASSIGNDSYS: "GR2",
    COMPONENT: "SAP_BASIS",
    PERIODTYPE: "D",
    PERIODSTRT: "2026-09-25",
    FIRSTRECDY: "2026-09-25",
    FIRSTRECTI: "00:01:02",
    LASTRECDY: "2026-09-25",
    LASTRECTI: "23:59:00",
    AGR_TZONE: "UTC+8",
    LONG_COMPONENT: "SAP_BASIS",
    ...overrides
  }
}

test("a workload directory read lifts the row and asks for exactly that one table", async () => {
  const { backend, calls } = double({
    WORKLOAD_DIRECTORY: [
      workloadDirectoryRow(),
      workloadDirectoryRow({ PERIODTYPE: "W", PERIODSTRT: "2026-09-21" })
    ]
  })
  const directory = await collectWorkloadDirectory(
    backend,
    "w200",
    {},
    async () => workloadDirectoryDefinition
  )
  assert.equal(directory.status, "ok")
  assert.equal(directory.returnedCount, 2)
  assert.equal(directory.entries[0]!.periodType, "D")
  assert.equal(directory.entries[0]!.aggregationTimezone, "UTC+8")
  assert.equal(directory.entries[0]!.firstRecordTime, "00:01:02")
  assert.equal(directory.entries[0]!.raw.AGR_TZONE, "UTC+8")
  assert.deepEqual(directory.counts.byPeriodType, { D: 1, W: 1 })
  assert.deepEqual(directory.counts.byComponent, { SAP_BASIS: 2 })
  assert.equal(directory.collectorReportedEmpty, false)
  // Still the direct path: this one function module is called by the service itself.
  assert.equal(directory.sources[0]!.method, "rfc_call")
  assert.equal(calls[0]!.functionName, "SWNC_GET_WORKLOAD_DIRECTORY")
  assert.deepEqual(calls[0]!.inputParameters, {})
  assert.deepEqual(calls[0]!.outputParameters, [
    {
      name: "WORKLOAD_DIRECTORY",
      kind: "table",
      fields: [
        "ASSIGNDSYS",
        "COMPONENT",
        "PERIODTYPE",
        "PERIODSTRT",
        "FIRSTRECDY",
        "FIRSTRECTI",
        "LASTRECDY",
        "LASTRECTI",
        "AGR_TZONE",
        "LONG_COMPONENT"
      ]
    }
  ])
  assert.ok(directory.notes.some((note) => /not a performance snapshot/.test(note)))
})

test("an empty workload directory is an ordinary answer, not a failure", async () => {
  const directory = await collectWorkloadDirectory(
    double({ WORKLOAD_DIRECTORY: [] }).backend,
    "w200",
    {},
    async () => workloadDirectoryDefinition
  )
  assert.equal(directory.status, "ok")
  assert.equal(directory.returnedCount, 0)
  assert.equal(directory.collectorReportedEmpty, false)
  assert.deepEqual(directory.entries, [])
  assert.deepEqual(directory.queryWarnings, [])
  assert.ok(directory.notes.some((note) => /empty directory/.test(note)))
})

test("the kernel's own NO_DATA_FOUND is reported as an empty directory", async () => {
  const directory = await collectWorkloadDirectory(
    double({}, { name: "NO_DATA_FOUND", code: "N", message: "nothing collected" }).backend,
    "w200",
    {},
    async () => workloadDirectoryDefinition
  )
  assert.equal(directory.status, "ok")
  assert.equal(directory.collectorReportedEmpty, true)
  assert.equal(directory.sources[0]!.code, "NO_DATA_FOUND")
  assert.deepEqual(directory.queryWarnings, [])
  assert.ok(directory.notes.some((note) => /NO_DATA_FOUND/.test(note)))
})

test("any other workload directory fault stays an explicit failure", async () => {
  const denied = await collectWorkloadDirectory(
    double({}, { name: "NOT_AUTHORIZED", code: "N", message: "no" }).backend,
    "w200",
    {},
    async () => workloadDirectoryDefinition
  )
  assert.equal(denied.status, "unavailable")
  assert.equal(denied.collectorReportedEmpty, false)
  assert.equal(denied.sources[0]!.code, "RUNTIME_RESOURCES_NOT_AUTHORIZED")

  const failed = await collectWorkloadDirectory(
    double({}, { name: "UNKNOWN_ERROR", code: "U", message: "no" }).backend,
    "w200",
    {},
    async () => workloadDirectoryDefinition
  )
  assert.equal(failed.status, "unavailable")
  assert.equal(failed.sources[0]!.code, "RUNTIME_RESOURCES_RFC_FAILED")

  const malformed = await collectWorkloadDirectory(
    double({}).backend,
    "w200",
    {},
    async () => workloadDirectoryDefinition
  )
  assert.equal(malformed.sources[0]!.status, "invalid")
  assert.equal(malformed.sources[0]!.code, "RUNTIME_RESOURCES_RESPONSE_INVALID")
})

test("a longer workload directory than the row cap is reported as partial", async () => {
  const rows = [1, 2, 3].map((index) => workloadDirectoryRow({ PERIODSTRT: `2026-09-2${index}` }))
  const directory = await collectWorkloadDirectory(
    double({ WORKLOAD_DIRECTORY: rows }).backend,
    "w200",
    { maxRows: 2 },
    async () => workloadDirectoryDefinition
  )
  assert.equal(directory.status, "partial")
  assert.equal(directory.truncated, true)
  assert.equal(directory.returnedCount, 2)
  assert.equal(directory.rowLimit, 2)
})

test("a changed workload directory interface is refused before any call", async () => {
  const changed = await collectWorkloadDirectory(
    double({ WORKLOAD_DIRECTORY: [workloadDirectoryRow()] }).backend,
    "w200",
    {},
    async () => ({ ...workloadDirectoryDefinition, interfaceFingerprint: "0".repeat(64) })
  )
  assert.equal(changed.sources[0]!.code, "RUNTIME_RESOURCES_FUNCTION_UNVERIFIED")
  assert.equal(changed.status, "unavailable")

  const tooMany = double({ WORKLOAD_DIRECTORY: [workloadDirectoryRow()] })
  await assert.rejects(
    collectWorkloadDirectory(
      tooMany.backend,
      "w200",
      { maxRows: 501 },
      async () => workloadDirectoryDefinition
    ),
    /RUNTIME_RESOURCES_ROW_LIMIT_INVALID/
  )
  assert.equal(tooMany.calls.length, 0)
})
