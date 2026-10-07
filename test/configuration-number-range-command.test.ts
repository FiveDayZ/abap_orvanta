import assert from "node:assert/strict"
import test from "node:test"
import type { RemoteFunctionRequest, RemoteFunctionResult } from "../src/backend.js"
import {
  configurationNumberRangeReadApi as reader,
  configurationNumberRangeApplyApi as writer
} from "../src/configuration-number-range-api.js"
import {
  applyConfigurationNumberRange,
  attestConfigurationNumberRangeApi,
  configurationNumberRangeCommandDependencies,
  configurationNumberRangeCommandIncludes
} from "../src/configuration-number-range-command.js"

const version = "a".repeat(64),
  nextVersion = "b".repeat(64)
const number = (value: string) => value.padStart(20, "0")
const input = () => ({
  connectionId: "w200",
  objectName: "ZTESTNR",
  expectedVersion: version,
  action: "create",
  intervalNumber: "01",
  fromNumber: number("1"),
  toNumber: number("100"),
  external: false,
  operationId: "number-range-fixture",
  acknowledgeConfigurationWrite: true,
  acknowledgeLocalClientOnly: true
})
const definition = (kind: "read" | "apply") => {
  const api = kind === "read" ? reader : writer
  return {
    ...api,
    connectionId: "w200",
    updateTask: false,
    updateTaskMode: "",
    changingParameters: [],
    exceptions: [],
    sourceFingerprint: version,
    interfaceFingerprint: version,
    source: [`FUNCTION ${api.functionName}.`, ...api.source.split("\n"), "ENDFUNCTION."]
  }
}
const row = () => ({
  CLIENT: "200",
  OBJECT: "ZTESTNR",
  SUBOBJECT: "",
  NRRANGENR: "01",
  TOYEAR: "0000",
  FROMNUMBER: number("1"),
  TONUMBER: number("100"),
  NRLEVEL: "",
  EXTERNIND: ""
})
const snapshot = () => ({
  EV_CODE: "READ_OK",
  EV_SYSTEM: "GR2",
  EV_CLIENT: "200",
  EV_VERSION: version,
  ES_DEFINITION: {
    OBJECT: "ZTESTNR",
    DOMLEN: "NUMC20",
    YEARIND: "",
    BUFFER: "",
    DTELSOBJ: "",
    NRTAB: "",
    TEXTIND: "",
    RFCDEST: "",
    NRCHECKASCII: ""
  },
  ET_INTERVALS: [] as ReturnType<typeof row>[]
})
const reply = () => ({
  EV_CODE: "SAVED_LOCAL_CLIENT",
  EV_SYSTEM: "GR2",
  EV_CLIENT: "200",
  EV_USER: "FIXTURE",
  EV_COMMITTED: "X",
  EV_BEFORE_VERSION: version,
  EV_VERSION: nextVersion,
  EV_SESSION_RESET: "X",
  EV_UNLOCKED: "X",
  EV_MSGID: "",
  EV_MSGNO: "",
  ES_ERROR: { MSGNR: "", TABLENAME: "", FIELDNAME: "", TABIX: "0" },
  ET_INTERVALS: [row()]
})
function fixture() {
  let snapshots = 0,
    nativeCalls = 0,
    receiptStarts = 0,
    reads = 0
  let wire: RemoteFunctionRequest | null = null
  const before = snapshot(),
    after = { ...snapshot(), EV_VERSION: nextVersion, ET_INTERVALS: [row()] }
  const state = {
    before,
    after,
    output: reply(),
    throwNative: false,
    fault: undefined as RemoteFunctionResult["fault"],
    failReceipt: false,
    failReadback: false,
    sourceDrift: false,
    includeDrift: false,
    changeDocumentUriDrift: false,
    readDefinition: async (name: string): Promise<unknown> => {
      reads++
      if (name === reader.functionName) return definition("read")
      if (name === writer.functionName)
        return {
          ...definition("apply"),
          sourceFingerprint: state.sourceDrift && reads > 9 ? nextVersion : version
        }
      const pins =
        configurationNumberRangeCommandDependencies[
          name as keyof typeof configurationNumberRangeCommandDependencies
        ]
      return { functionName: name, remoteEnabled: false, updateTask: false, ...pins }
    },
    readInclude: async (name: string) => {
      const pin =
        configurationNumberRangeCommandIncludes[
          name as keyof typeof configurationNumberRangeCommandIncludes
        ]
      const uri =
        name === "FSNR1CDC" && !state.changeDocumentUriDrift
          ? "/programs/includes/fsnr1cdc/source"
          : `/functions/groups/snr1/includes/${name.toLowerCase()}/source`
      return `Source from ${name} (lines 1-1 of 1, 1 lines retrieved):\nFull Source SHA-256: ${state.includeDrift ? nextVersion : pin}\n${uri}\n1: fixture`
    },
    readSnapshot: async (): Promise<unknown> => {
      snapshots++
      if (snapshots === 1) return state.before
      if (state.failReadback) throw Error("readback unavailable")
      return state.after
    },
    beforeInvoke: async (operationId: string) => {
      assert.equal(operationId, "number-range-fixture")
      receiptStarts++
      if (state.failReceipt) throw Error("protected receipt unavailable")
    },
    backend: {
      callRemoteFunction: async (
        _connection: string,
        request: RemoteFunctionRequest
      ): Promise<RemoteFunctionResult> => {
        assert.equal(receiptStarts, 1)
        nativeCalls++
        wire = request
        if (state.throwNative) throw Error("transport interrupted")
        return { outputs: state.output, fault: state.fault }
      }
    },
    counts: () => ({ nativeCalls, receiptStarts, snapshots, reads, wire }),
    run: (raw: unknown = input(), client = "200") =>
      applyConfigurationNumberRange(
        raw,
        client,
        state.backend,
        state.readDefinition,
        state.readSnapshot,
        state.beforeInvoke,
        state.readInclude
      )
  }
  return state
}

test("number range API attestation rejects changed source, interface and execution mode", () => {
  for (const kind of ["read", "apply"] as const) {
    const valid = definition(kind)
    assert.equal(attestConfigurationNumberRangeApi(valid, kind).functionName, valid.functionName)
    for (const invalid of [
      { ...valid, remoteEnabled: false },
      { ...valid, updateTask: true },
      { ...valid, source: valid.source.map((line) => line.replace("'GR2'", "'GR3'")) },
      { ...valid, importParameters: valid.importParameters.map((p) => ({ ...p, optional: true })) },
      {
        ...valid,
        tableParameters: valid.tableParameters.map((p) => ({ ...p, typeName: "T006A" }))
      },
      { ...valid, source: [...valid.source, "FUNCTION Z_OTHER."] }
    ])
      assert.throws(() => attestConfigurationNumberRangeApi(invalid, kind), /NOT_ATTESTED/)
  }
})

test("invalid number range commands fail before metadata, receipts or SAP", async () => {
  for (const raw of [
    { ...input(), acknowledgeLocalClientOnly: false },
    { ...input(), acknowledgeConfigurationWrite: false },
    { ...input(), currentLevel: "1" },
    { ...input(), action: "delete" },
    { ...input(), fromNumber: number("100"), toNumber: number("100") },
    { ...input(), toNumber: "900719925474099312345" },
    { ...input(), connectionId: "w300" }
  ]) {
    const f = fixture()
    await assert.rejects(f.run(raw))
    assert.deepEqual(f.counts(), {
      nativeCalls: 0,
      receiptStarts: 0,
      snapshots: 0,
      reads: 0,
      wire: null
    })
  }
  const f = fixture()
  await assert.rejects(f.run(input(), "300"), /SCOPE_UNSUPPORTED/)
  assert.equal(f.counts().reads, 0)
})

test("number range preflight refuses scope, use, overlap, duplicate and source drift before invocation", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.before.EV_VERSION = nextVersion
    },
    (f: ReturnType<typeof fixture>) => {
      f.before.ES_DEFINITION.BUFFER = "X"
    },
    (f: ReturnType<typeof fixture>) => {
      f.before.ES_DEFINITION.TEXTIND = "X"
    },
    (f: ReturnType<typeof fixture>) => {
      f.before.ET_INTERVALS = [{ ...row(), NRRANGENR: "02", NRLEVEL: number("2") }]
    },
    (f: ReturnType<typeof fixture>) => {
      f.before.ET_INTERVALS = [
        { ...row(), NRRANGENR: "02", FROMNUMBER: number("100"), TONUMBER: number("200") }
      ]
    },
    (f: ReturnType<typeof fixture>) => {
      f.before.ET_INTERVALS = [
        { ...row(), NRRANGENR: "02" },
        { ...row(), NRRANGENR: "02" }
      ]
    },
    (f: ReturnType<typeof fixture>) => {
      f.sourceDrift = true
    },
    (f: ReturnType<typeof fixture>) => {
      f.includeDrift = true
    }
  ]) {
    const f = fixture()
    change(f)
    await assert.rejects(f.run())
    assert.equal(f.counts().nativeCalls, 0)
    assert.equal(f.counts().receiptStarts, 0)
  }
})

test("number range create calls one attested API after its protected receipt and verifies the complete result", async () => {
  const f = fixture()
  const result = await f.run()
  assert.equal(result.status, "completed")
  assert.equal(result.transportPolicy, "local_client_only_not_recorded")
  assert.equal(result.outcomeMayBeUnknown, false)
  assert.equal(f.counts().nativeCalls, 1)
  assert.equal(f.counts().receiptStarts, 1)
  assert.equal(f.counts().wire!.functionName, writer.functionName)
  assert.deepEqual(f.counts().wire!.inputParameters, {
    IV_OBJECT: "ZTESTNR",
    IV_EXPECTED_VERSION: version,
    IV_ACTION: "I",
    IV_INTERVAL: "01",
    IV_FROM_NUMBER: number("1"),
    IV_TO_NUMBER: number("100"),
    IV_EXTERNAL: "",
    IV_ACK_LOCAL_ONLY: "X",
    ET_INTERVALS: []
  })
})

test("change-document Include uses the observed program route and refuses an unrelated group route", async () => {
  const actual = fixture()
  assert.equal((await actual.run()).status, "completed")
  const wrong = fixture()
  wrong.changeDocumentUriDrift = true
  await assert.rejects(wrong.run(), /CONFIGURATION_NR_INCLUDE_NOT_ATTESTED/)
  assert.equal(wrong.counts().nativeCalls, 0)
  assert.equal(wrong.counts().receiptStarts, 0)
})

test("number range comparisons preserve precision above the JavaScript safe integer limit", async () => {
  const f = fixture(),
    lower = "90071992547409931234",
    upper = "90071992547409931235"
  f.after.ET_INTERVALS = [{ ...row(), FROMNUMBER: lower, TONUMBER: upper }]
  f.output.ET_INTERVALS = f.after.ET_INTERVALS
  assert.equal(
    (await f.run({ ...input(), fromNumber: lower, toNumber: upper })).status,
    "completed"
  )
  assert.equal(f.counts().wire!.inputParameters.IV_FROM_NUMBER, lower)
})

test("number range create accepts SAP NUMC20 zero but never masks an allocated level", async () => {
  for (const level of ["", "0", number("0")]) {
    const f = fixture()
    f.after.ET_INTERVALS[0]!.NRLEVEL = level
    f.output.ET_INTERVALS[0]!.NRLEVEL = number("0")
    assert.equal((await f.run()).status, "completed")
  }
  const allocated = fixture()
  allocated.after.ET_INTERVALS[0]!.NRLEVEL = number("1")
  allocated.output.ET_INTERVALS[0]!.NRLEVEL = number("1")
  assert.equal((await allocated.run()).status, "unknown")
})

test("number range update preserves the current level and cannot switch internal/external mode", async () => {
  const f = fixture()
  f.before.ET_INTERVALS = [{ ...row(), NRLEVEL: number("0") }]
  f.after.ET_INTERVALS = [{ ...row(), NRLEVEL: number("0"), TONUMBER: number("200") }]
  f.output.ET_INTERVALS = f.after.ET_INTERVALS
  assert.equal(
    (await f.run({ ...input(), action: "update", toNumber: number("200") })).status,
    "completed"
  )
  const denied = fixture()
  denied.before.ET_INTERVALS = [row()]
  await assert.rejects(denied.run({ ...input(), action: "update", external: true }), /MODE_SWITCH/)
  assert.equal(denied.counts().nativeCalls, 0)
})

test("a missing protected receipt prevents the number range command", async () => {
  const f = fixture()
  f.failReceipt = true
  await assert.rejects(f.run(), /receipt unavailable/)
  assert.equal(f.counts().nativeCalls, 0)
})

test("number range interrupted or inconsistent outcomes stay unknown and are never retried", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.throwNative = true
    },
    (f: ReturnType<typeof fixture>) => {
      f.failReadback = true
    },
    (f: ReturnType<typeof fixture>) => {
      f.output.EV_UNLOCKED = ""
    },
    (f: ReturnType<typeof fixture>) => {
      f.output.EV_SESSION_RESET = ""
    },
    (f: ReturnType<typeof fixture>) => {
      f.output.EV_SESSION_RESET = "not_required"
    },
    (f: ReturnType<typeof fixture>) => {
      f.output.EV_COMMITTED = "?"
    },
    (f: ReturnType<typeof fixture>) => {
      f.after.ES_DEFINITION.BUFFER = "X"
    },
    (f: ReturnType<typeof fixture>) => {
      f.after.ET_INTERVALS[0]!.TONUMBER = number("99")
    },
    (f: ReturnType<typeof fixture>) => {
      f.output.EV_VERSION = version
    }
  ]) {
    const f = fixture()
    change(f)
    const result = await f.run()
    assert.equal(result.status, "unknown")
    assert.equal(result.outcomeMayBeUnknown, true)
    assert.equal(result.retryAvailable, false)
    assert.equal(f.counts().nativeCalls, 1)
  }
})

test("native transport and SOAP faults retain the first safe cause when readback also fails", async () => {
  for (const soap of [false, true]) {
    const f = fixture()
    f.throwNative = !soap
    if (soap) f.fault = { code: "Server", name: "RFC", message: "Authorization: secret-token" }
    f.failReadback = true
    const observed = await f.run()
    assert.equal(observed.status, "unknown")
    assert.ok("failure" in observed)
    const failure = observed.failure as { stage: string; code: string; evidenceHash: string }
    assert.equal(failure.stage, "native_call")
    assert.equal(
      failure.code,
      soap ? "CONFIGURATION_NR_SOAP_FAULT" : "CONFIGURATION_NR_TRANSPORT_FAILED"
    )
    assert.match(failure.evidenceHash, /^[a-f0-9]{64}$/)
    assert.doesNotMatch(JSON.stringify(observed), /secret-token|Authorization:/)
    assert.equal(f.counts().nativeCalls, 1)
  }
})

test("invalid native replies, update rejection, cleanup and readback failures are attributable", async () => {
  const cases = [
    [
      "CONFIGURATION_NR_REPLY_INVALID",
      (f: ReturnType<typeof fixture>) => {
        f.output.EV_CLIENT = "300"
      }
    ],
    [
      "CONFIGURATION_NR_NATIVE_REFUSED",
      (f: ReturnType<typeof fixture>) => {
        f.output.EV_CODE = "UPDATE_FAILED"
        f.output.EV_COMMITTED = "?"
        f.failReadback = true
      }
    ],
    [
      "CONFIGURATION_NR_CLEANUP_UNCONFIRMED",
      (f: ReturnType<typeof fixture>) => {
        f.output.EV_UNLOCKED = ""
        f.failReadback = true
      }
    ],
    [
      "CONFIGURATION_NR_READBACK_FAILED",
      (f: ReturnType<typeof fixture>) => {
        f.failReadback = true
      }
    ],
    [
      "CONFIGURATION_NR_READBACK_INVALID",
      (f: ReturnType<typeof fixture>) => {
        f.after.EV_CLIENT = "300"
      }
    ],
    [
      "CONFIGURATION_NR_RESULT_MISMATCH",
      (f: ReturnType<typeof fixture>) => {
        f.after.ET_INTERVALS[0]!.TONUMBER = number("99")
      }
    ]
  ] as const
  for (const [code, change] of cases) {
    const f = fixture()
    change(f)
    const observed = await f.run()
    assert.equal(observed.status, "unknown")
    assert.ok("failure" in observed)
    assert.equal((observed.failure as { code: string }).code, code)
    assert.equal(f.counts().nativeCalls, 1)
  }
})

test("native stale rejection retains its code and a valid no-change command requires matching readback", async () => {
  const stale = fixture()
  Object.assign(stale.output, {
    EV_CODE: "VERSION_CHANGED",
    EV_COMMITTED: "",
    EV_VERSION: "",
    EV_SESSION_RESET: "not_required",
    ET_INTERVALS: []
  })
  assert.equal((await stale.run()).status, "declined")
  const unchanged = fixture()
  unchanged.before.ET_INTERVALS = [row()]
  unchanged.after = unchanged.before
  Object.assign(unchanged.output, {
    EV_CODE: "NO_CHANGES",
    EV_COMMITTED: "",
    EV_VERSION: version,
    EV_SESSION_RESET: "not_required"
  })
  assert.equal((await unchanged.run({ ...input(), action: "update" })).status, "no_changes")
  const wrongReply = fixture()
  wrongReply.before.ET_INTERVALS = [row()]
  wrongReply.after = wrongReply.before
  Object.assign(wrongReply.output, {
    EV_CODE: "NO_CHANGES",
    EV_COMMITTED: "",
    EV_VERSION: version,
    EV_SESSION_RESET: "not_required",
    ET_INTERVALS: [{ ...row(), TONUMBER: number("99") }]
  })
  assert.equal((await wrongReply.run({ ...input(), action: "update" })).status, "unknown")
})

test("a native authorization refusal is distinguished from an interrupted call", async () => {
  const f = fixture()
  f.after = f.before
  Object.assign(f.output, {
    EV_CODE: "AUTHORIZATION_DENIED",
    EV_COMMITTED: "",
    EV_BEFORE_VERSION: "",
    EV_VERSION: "",
    EV_SESSION_RESET: "not_required",
    EV_UNLOCKED: "not_required",
    ET_INTERVALS: []
  })
  assert.equal((await f.run()).status, "declined")
  assert.equal(f.counts().nativeCalls, 1)
})

test("number range deployment candidates contain no direct standard-table writes, allocator or GUI fallback", () => {
  const sources = reader.source + "\n" + writer.source
  for (const line of sources.split("\n"))
    assert.ok(line.length <= 72, "RPY_FUNCTIONMODULE_INSERT RSSOURCE must not truncate candidates")
  assert.doesNotMatch(sources, /\b(?:UPDATE|INSERT|DELETE|MODIFY)\s+(?:FROM\s+)?(?:NRIV|TNRO)\b/i)
  assert.doesNotMatch(
    sources,
    /NUMBER_GET_NEXT|CALL\s+TRANSACTION|CALL\s+SCREEN|POPUP|DEQUEUE_ALL|\bVALUE\s*\(/i
  )
  assert.doesNotMatch(reader.source, /COMMIT WORK|ROLLBACK WORK|NUMBER_RANGE_INTERVAL_UPDATE/i)
  const supported = new Set([
    ...Object.keys(configurationNumberRangeCommandDependencies),
    reader.functionName
  ])
  for (const match of sources.matchAll(/CALL FUNCTION '([^']+)'/g))
    assert.ok(supported.has(match[1]!))
})
