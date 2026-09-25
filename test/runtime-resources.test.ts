import assert from "node:assert/strict"
import test from "node:test"
import {
  collectFileSystemDirectory,
  collectUserSessions,
  collectWorkProcesses,
  collectWorkloadDirectory
} from "../src/runtime-resources.js"
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
 * The monitor function modules are not in the shared mock, so the double answers exactly the two
 * outputs these tools request and records every request so the call itself can be asserted.
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
  const { backend, calls } = double({
    WPLIST: [
      workProcessRow(),
      workProcessRow({ WP_NO: "2", WP_TYP: "BGD", WP_STATUS: "Run", WP_BNAME: "WF-BATCH" })
    ]
  })
  const result = await collectWorkProcesses(backend, "w200", {}, async () => workProcessDefinition)

  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.functionName, "TH_WPINFO")
  // No server filter means no SRVNAME import at all: the kernel's own default list is what is read.
  assert.deepEqual(calls[0]!.inputParameters, {})
  assert.deepEqual(calls[0]!.outputParameters, [
    { name: "WPLIST", kind: "table", fields: calls[0]!.outputParameters[0]!.fields }
  ])

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
  assert.equal(result.sources[0]!.method, "rfc_call")
  assert.deepEqual(result.queryWarnings, [])
  assert.ok(result.notes.some((note) => /No value is translated/.test(note)))
  assert.ok(result.notes.some((note) => /cannot restart, stop, debug or resubmit/.test(note)))
})

test("a server filter is passed verbatim and an unusable one is refused before SAP is touched", async () => {
  const { backend, calls } = double({ WPLIST: [workProcessRow()] })
  const filtered = await collectWorkProcesses(
    backend,
    "w200",
    { serverName: "  sapw200  " },
    async () => workProcessDefinition
  )
  assert.deepEqual(calls[0]!.inputParameters, { SRVNAME: "sapw200" })
  assert.equal(filtered.serverName, "sapw200")
  assert.equal(filtered.filters.serverName, "sapw200")

  await assert.rejects(
    () =>
      collectWorkProcesses(
        backend,
        "w200",
        { serverName: "S".repeat(41) },
        async () => workProcessDefinition
      ),
    /RUNTIME_RESOURCES_SCOPE_INVALID/
  )
  await assert.rejects(
    () =>
      collectWorkProcesses(
        backend,
        "w200",
        { serverName: "sap\u0000w200" },
        async () => workProcessDefinition
      ),
    /RUNTIME_RESOURCES_SCOPE_INVALID/
  )
  assert.equal(calls.length, 1)
})

test("a changed work process interface is refused instead of called", async () => {
  const { backend, calls } = double({ WPLIST: [workProcessRow()] })
  const result = await collectWorkProcesses(backend, "w200", {}, async () => ({
    ...workProcessDefinition,
    sourceFingerprint: "0".repeat(64)
  }))

  assert.equal(calls.length, 0)
  assert.equal(result.status, "unavailable")
  assert.equal(result.sources[0]!.code, "RUNTIME_RESOURCES_FUNCTION_UNVERIFIED")
  assert.deepEqual(result.queryWarnings, ["TH_WPINFO: RUNTIME_RESOURCES_FUNCTION_UNVERIFIED"])
})

test("an empty, invalid or unauthorized work process answer stays an explicit failure", async () => {
  const empty = await collectWorkProcesses(
    double({ WPLIST: [] }).backend,
    "w200",
    {},
    async () => workProcessDefinition
  )
  assert.equal(empty.status, "unavailable")
  assert.equal(empty.sources[0]!.status, "unavailable")
  assert.equal(empty.sources[0]!.code, "RUNTIME_RESOURCES_RESPONSE_EMPTY")
  assert.deepEqual(empty.workProcesses, [])

  const invalid = await collectWorkProcesses(
    double({ WPLIST: [{ WP_NO: { nested: "x" } } as unknown as SapStructureRow] }).backend,
    "w200",
    {},
    async () => workProcessDefinition
  )
  assert.equal(invalid.sources[0]!.status, "invalid")
  assert.equal(invalid.sources[0]!.code, "RUNTIME_RESOURCES_RESPONSE_INVALID")

  // DIR_LIST carries DEC and INT4 columns, so a numeric cell is the reader's own rendering of a
  // value rather than a malformed row; it is kept as text and never reinterpreted.
  const numeric = await collectWorkProcesses(
    double({ WPLIST: [{ WP_NO: 42, WP_TYP: "DIA" } as unknown as SapStructureRow] }).backend,
    "w200",
    {},
    async () => workProcessDefinition
  )
  assert.equal(numeric.status, "ok")
  assert.equal(numeric.workProcesses[0]!.raw.WP_NO, "42")

  const denied = await collectWorkProcesses(
    double({}, { name: "NOT_AUTHORIZED", code: "N", message: "no" }).backend,
    "w200",
    {},
    async () => workProcessDefinition
  )
  assert.equal(denied.sources[0]!.code, "RUNTIME_RESOURCES_NOT_AUTHORIZED")

  const failed = await collectWorkProcesses(
    double({}, { name: "SYSTEM_FAILURE", code: "S", message: "no" }).backend,
    "w200",
    {},
    async () => workProcessDefinition
  )
  assert.equal(failed.sources[0]!.code, "RUNTIME_RESOURCES_RFC_FAILED")
})

test("a longer work process list than the row cap is reported as partial", async () => {
  const rows = [1, 2, 3].map((index) =>
    workProcessRow({ WP_NO: String(index), WP_INDEX: String(index) })
  )
  const result = await collectWorkProcesses(
    double({ WPLIST: rows }).backend,
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

  await assert.rejects(
    () =>
      collectWorkProcesses(
        double({ WPLIST: rows }).backend,
        "w200",
        { maxRows: 0 },
        async () => workProcessDefinition
      ),
    /RUNTIME_RESOURCES_ROW_LIMIT_INVALID/
  )
  await assert.rejects(
    () =>
      collectWorkProcesses(
        double({ WPLIST: rows }).backend,
        "w200",
        { maxRows: 501 },
        async () => workProcessDefinition
      ),
    /RUNTIME_RESOURCES_ROW_LIMIT_INVALID/
  )
})

test("a session read asks only for the output this service can verify", async () => {
  const { backend, calls } = double({ USRLIST: [sessionRow()] })
  const result = await collectUserSessions(backend, "w200", {}, async () => sessionDefinition)

  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.functionName, "TH_USER_LIST")
  // LIST carries a type this service cannot verify, so it must never be requested.
  assert.equal(calls[0]!.outputParameters.length, 1)
  assert.equal(calls[0]!.outputParameters[0]!.name, "USRLIST")

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
  assert.ok(result.notes.some((note) => /LIST output is not read/.test(note)))
  assert.ok(result.notes.some((note) => /cannot terminate a session/.test(note)))
})

test("a user filter is applied in the service and stays visible in the answer", async () => {
  const { backend, calls } = double({
    USRLIST: [
      sessionRow({ TID: "1", BNAME: "WYS" }),
      sessionRow({ TID: "2", BNAME: "WYS", TCODE: "SE38" }),
      sessionRow({ TID: "3", BNAME: "OTHER" })
    ]
  })
  const result = await collectUserSessions(
    backend,
    "w200",
    { userName: "wys" },
    async () => sessionDefinition
  )

  // TH_USER_LIST has no user import, so the filter cannot be pushed down.
  assert.deepEqual(calls[0]!.inputParameters, {})
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
})

test("a session answer that matches nothing is empty, not a failure", async () => {
  const { backend } = double({ USRLIST: [sessionRow({ BNAME: "OTHER" })] })
  const result = await collectUserSessions(
    backend,
    "w200",
    { userName: "WYS" },
    async () => sessionDefinition
  )

  // The kernel answered: the tool reports an empty match rather than an unavailable read.
  assert.equal(result.status, "ok")
  assert.equal(result.matchedCount, 0)
  assert.equal(result.returnedCount, 0)
  assert.deepEqual(result.sessions, [])
  assert.deepEqual(result.queryWarnings, [])
})

test("a longer session match than the row cap is reported as partial", async () => {
  const rows = [1, 2, 3].map((index) => sessionRow({ TID: String(index) }))
  const result = await collectUserSessions(
    double({ USRLIST: rows }).backend,
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

test("a changed session interface or an unusable user name never reaches SAP", async () => {
  const changed = double({ USRLIST: [sessionRow()] })
  const result = await collectUserSessions(changed.backend, "w200", {}, async () => ({
    ...sessionDefinition,
    interfaceFingerprint: "0".repeat(64)
  }))
  assert.equal(changed.calls.length, 0)
  assert.equal(result.sources[0]!.code, "RUNTIME_RESOURCES_FUNCTION_UNVERIFIED")
  assert.deepEqual(result.queryWarnings, ["TH_USER_LIST: RUNTIME_RESOURCES_FUNCTION_UNVERIFIED"])

  const refused = double({ USRLIST: [sessionRow()] })
  await assert.rejects(
    () =>
      collectUserSessions(
        refused.backend,
        "w200",
        { userName: "TOO-LONG-USER-NAME" },
        async () => sessionDefinition
      ),
    /RUNTIME_RESOURCES_SCOPE_INVALID/
  )
  assert.equal(refused.calls.length, 0)
})

/** An EPS2FILI row: the five fields DIR_LIST carries, as the reader returns them. */
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
  const { backend, calls } = double({
    DIR_NAME: "/usr/sap/W200",
    FILE_COUNTER: "2",
    ERROR_COUNTER: "0",
    DIR_LIST: [
      directoryRow(),
      directoryRow({ NAME: "dev_w0", SIZE: "1024", RC: "0004", OWNER: "root" })
    ]
  })
  const result = await collectFileSystemDirectory(
    backend,
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
  assert.deepEqual(result.queryWarnings, [])
  assert.ok(result.notes.some((note) => /File contents are never read/.test(note)))
  assert.ok(result.notes.some((note) => /No fileMask was given/.test(note)))

  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.functionName, "EPS2_GET_DIRECTORY_LISTING")
  assert.deepEqual(calls[0]!.inputParameters, { IV_DIR_NAME: "/usr/sap/W200" })
  assert.deepEqual(calls[0]!.outputParameters, [
    { name: "DIR_NAME", kind: "scalar" },
    { name: "FILE_COUNTER", kind: "scalar" },
    { name: "ERROR_COUNTER", kind: "scalar" },
    { name: "DIR_LIST", kind: "table", fields: ["NAME", "SIZE", "MTIM", "OWNER", "RC"] }
  ])
})

test("a file mask is passed through verbatim when one is given", async () => {
  const { backend, calls } = double({ DIR_LIST: [directoryRow()] })
  const result = await collectFileSystemDirectory(
    backend,
    "w200",
    { directory: "/usr/sap/W200/work", fileMask: "*.log" },
    async () => directoryDefinition
  )

  assert.deepEqual(calls[0]!.inputParameters, {
    IV_DIR_NAME: "/usr/sap/W200/work",
    FILE_MASK: "*.log"
  })
  assert.deepEqual(result.filters, { directory: "/usr/sap/W200/work", fileMask: "*.log" })
  assert.ok(!result.notes.some((note) => /No fileMask was given/.test(note)))
})

test("an empty directory is an ordinary answer, not a failure", async () => {
  const { backend, calls } = double({ DIR_LIST: [], DIR_NAME: "/usr/sap/W200/empty" })
  const result = await collectFileSystemDirectory(
    backend,
    "w200",
    { directory: "/usr/sap/W200/empty" },
    async () => directoryDefinition
  )

  assert.equal(calls.length, 1)
  assert.equal(result.status, "ok")
  assert.equal(result.returnedCount, 0)
  assert.deepEqual(result.entries, [])
  assert.deepEqual(result.queryWarnings, [])
  assert.equal(result.sources[0]!.code, undefined)
  assert.ok(
    result.notes.some((note) => /not evidence that the directory does not exist/.test(note))
  )
})

test("a listing that disagrees with the kernel's own counters says so", async () => {
  const { backend } = double({
    DIR_NAME: "/usr/sap/W200/other",
    FILE_COUNTER: "7",
    ERROR_COUNTER: "2",
    DIR_LIST: [directoryRow(), directoryRow({ NAME: "dev_w1" })]
  })
  const result = await collectFileSystemDirectory(
    backend,
    "w200",
    { directory: "/usr/sap/W200" },
    async () => directoryDefinition
  )

  assert.equal(result.status, "ok")
  assert.ok(
    result.queryWarnings.some((warning) =>
      /FILE_COUNTER is 7 but DIR_LIST carried 2 entries/.test(warning)
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
    double({ DIR_LIST: rows, FILE_COUNTER: "3" }).backend,
    "w200",
    { directory: "/usr/sap/W200", maxRows: 2 },
    async () => directoryDefinition
  )

  assert.equal(result.status, "partial")
  assert.equal(result.truncated, true)
  assert.equal(result.returnedCount, 2)
  assert.equal(result.entries.length, 2)
  assert.deepEqual(result.queryWarnings, [])
  assert.ok(result.notes.some((note) => /the entries beyond the cap/.test(note)))
})

test("a changed directory interface never reaches SAP", async () => {
  const changed = double({ DIR_LIST: [directoryRow()] })
  const result = await collectFileSystemDirectory(
    changed.backend,
    "w200",
    { directory: "/tmp" },
    async () => ({
      ...directoryDefinition,
      interfaceFingerprint: "0".repeat(64)
    })
  )

  assert.equal(changed.calls.length, 0)
  assert.equal(result.sources[0]!.code, "RUNTIME_RESOURCES_FUNCTION_UNVERIFIED")
  assert.deepEqual(result.queryWarnings, [
    "EPS2_GET_DIRECTORY_LISTING: RUNTIME_RESOURCES_FUNCTION_UNVERIFIED"
  ])
})

test("an unusable path or mask is refused before the call", async () => {
  for (const directory of ["", "   ", "/usr/sap/../etc", `/${"a".repeat(200)}`, "/tmp\n/dev"]) {
    const refused = double({ DIR_LIST: [directoryRow()] })
    await assert.rejects(
      () =>
        collectFileSystemDirectory(
          refused.backend,
          "w200",
          { directory },
          async () => directoryDefinition
        ),
      /RUNTIME_RESOURCES_SCOPE_INVALID/
    )
    assert.equal(refused.calls.length, 0)
  }

  const longMask = double({ DIR_LIST: [directoryRow()] })
  await assert.rejects(
    () =>
      collectFileSystemDirectory(
        longMask.backend,
        "w200",
        { directory: "/tmp", fileMask: "a".repeat(41) },
        async () => directoryDefinition
      ),
    /RUNTIME_RESOURCES_SCOPE_INVALID/
  )
  assert.equal(longMask.calls.length, 0)
})

test("an unauthorized or malformed directory answer stays an explicit failure", async () => {
  const denied = await collectFileSystemDirectory(
    double({}, { name: "NOT_AUTHORIZED", code: "N", message: "no" }).backend,
    "w200",
    { directory: "/tmp" },
    async () => directoryDefinition
  )
  assert.equal(denied.status, "unavailable")
  assert.equal(denied.sources[0]!.code, "RUNTIME_RESOURCES_NOT_AUTHORIZED")

  const failed = await collectFileSystemDirectory(
    double({}, { name: "SYSTEM_FAILURE", code: "S", message: "no" }).backend,
    "w200",
    { directory: "/tmp" },
    async () => directoryDefinition
  )
  assert.equal(failed.sources[0]!.code, "RUNTIME_RESOURCES_RFC_FAILED")

  const malformed = await collectFileSystemDirectory(
    double({ DIR_NAME: "/tmp" }).backend,
    "w200",
    { directory: "/tmp" },
    async () => directoryDefinition
  )
  assert.equal(malformed.sources[0]!.status, "invalid")
  assert.equal(malformed.sources[0]!.code, "RUNTIME_RESOURCES_RESPONSE_INVALID")
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
