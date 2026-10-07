import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { startHttpServer } from "../src/http.js"
import { ToolService } from "../src/tools.js"
import { writeOperationContext, writeOperationTarget } from "../src/mcp.js"
import { toolNamesForProfile } from "../src/tool-registry.js"
import {
  applyConfigurationUnitText,
  configurationUnitTextApplySchema
} from "../src/configuration-unit-apply.js"
import {
  configurationUnitApplyApi,
  attestConfigurationUnitApplyApi
} from "../src/configuration-unit-apply-api.js"
import type { RemoteFunctionResult } from "../src/backend.js"
import { MockBackend } from "./mock-backend.js"

const version = "a".repeat(64),
  afterVersion = "b".repeat(64)
const input = () => ({
  connectionId: "w200",
  unitKey: "kg",
  language: "ZH",
  expectedReadFingerprint: "c".repeat(64),
  expectedTextVersion: version,
  patch: { MSEHL: "新长描述" },
  requestNumber: "GR2K900001",
  taskNumber: "GR2K900002",
  operationId: "unit-apply-test-1",
  acknowledgeConfigurationWrite: true
})
const row = () => ({
  MANDT: "200",
  SPRAS: "1",
  MSEHI: "kg",
  MSEH3: "kg",
  MSEH6: "公斤",
  MSEHT: "公斤",
  MSEHL: "千克"
})
const definition = () => ({
  connectionId: "w200",
  functionName: configurationUnitApplyApi.functionName,
  remoteEnabled: true,
  updateTask: false,
  updateTaskMode: "",
  importParameters: [...configurationUnitApplyApi.importParameters],
  exportParameters: [...configurationUnitApplyApi.exportParameters],
  changingParameters: [],
  tableParameters: [],
  exceptions: [],
  sourceFingerprint: "d".repeat(64),
  interfaceFingerprint: "e".repeat(64),
  source: [
    `FUNCTION ${configurationUnitApplyApi.functionName}.`,
    ...configurationUnitApplyApi.source,
    "ENDFUNCTION."
  ]
})
const draft = () => ({
  status: "draft",
  unitKey: "kg",
  sapLanguage: "1",
  before: row(),
  after: { ...row(), MSEHL: input().patch.MSEHL },
  apiPrecondition: { status: "match", textVersion: version, lockedComparisonVerified: false }
})
const outputs = () => ({
  EV_CODE: "APPLIED",
  EV_SYSTEM: "GR2",
  EV_CLIENT: "200",
  EV_USER: "WYS",
  EV_COMMITTED: "X",
  EV_BEFORE_VERSION: version,
  EV_TEXT_VERSION: afterVersion,
  EV_TASK: input().taskNumber,
  EV_TABKEY: "2001kg ",
  EV_MSGID: "",
  EV_MSGNO: "000",
  ES_TEXT: draft().after
})
function fixture() {
  let calls = 0,
    marks = 0,
    reads = 0,
    definitions = 0
  const f = {
    response: { outputs: outputs() } as RemoteFunctionResult,
    input: input() as unknown,
    definition: definition() as unknown,
    draft: draft() as unknown,
    readback: {
      readFingerprint: "f".repeat(64),
      apiSnapshot: {
        status: "read",
        textVersion: afterVersion,
        data: draft().after
      }
    } as unknown,
    before: async () => {
      marks++
    },
    readDefinition: async () => {
      definitions++
      return f.definition
    },
    run: () =>
      applyConfigurationUnitText(
        f.input,
        "200",
        {
          callRemoteFunction: async (id, request) => {
            calls++
            assert.equal(marks, 1)
            assert.equal(id, "w200")
            assert.equal(request.functionName, configurationUnitApplyApi.functionName)
            assert.deepEqual(request.inputParameters, {
              IV_UNIT_KEY: "kg",
              IV_LANGUAGE: "1",
              IV_EXPECTED_VERSION: version,
              IV_SET_MSEHT: "",
              IV_MSEHT: "",
              IV_SET_MSEHL: "X",
              IV_MSEHL: "新长描述",
              IV_REQUEST: input().requestNumber,
              IV_TASK: input().taskNumber
            })
            return f.response
          }
        },
        f.readDefinition,
        async () => f.draft,
        async () => {
          reads++
          return f.readback
        },
        f.before
      ),
    counts: () => ({ calls, marks, reads, definitions })
  }
  return f
}

test("apply dispatches once after receipt gate and requires native row/version plus readback", async () => {
  const f = fixture(),
    r = await f.run()
  assert.equal(r.status, "applied")
  assert.equal(r.committed, true)
  assert.ok("textVersion" in r && "readbackVerified" in r)
  assert.equal(r.textVersion, afterVersion)
  assert.equal(r.readbackVerified, true)
  assert.deepEqual(f.counts(), { calls: 1, marks: 1, reads: 1, definitions: 3 })
})

for (const [name, patch] of Object.entries({
  "missing operation ID": { operationId: undefined },
  "missing write acknowledgment": { acknowledgeConfigurationWrite: undefined },
  "other connection": { connectionId: "w300" },
  "generic unit key": { unitKey: "K*" },
  "key whitespace": { unitKey: " kg" },
  "empty patch": { patch: {} },
  "undefined patch field": { patch: { MSEHL: undefined } },
  "clear description": { patch: { MSEHT: "" } },
  "whitespace description": { patch: { MSEHL: "  " } },
  "oversized description": { patch: { MSEHL: "汉".repeat(31) } },
  "control character": { patch: { MSEHL: "new\ntext" } },
  "alias edit": { patch: { MSEH3: "NEW" } },
  "same containers": { taskNumber: input().requestNumber },
  "foreign task": { taskNumber: "GR3K900002" },
  "no explicit language": { language: undefined },
  "legacy token as native token": { expectedTextVersion: "not a version" }
}))
  test(`apply rejects ${name} before any SAP read`, async () => {
    const f = fixture()
    f.input = { ...input(), ...patch }
    await assert.rejects(f.run())
    assert.deepEqual(f.counts(), { calls: 0, marks: 0, reads: 0, definitions: 0 })
  })

for (const [name, edit] of [
  ["source mutation", (d: ReturnType<typeof definition>) => d.source.splice(3, 0, "COMMIT WORK.")],
  [
    "wrong import",
    (d: ReturnType<typeof definition>) => {
      d.importParameters[0] = { ...d.importParameters[0]!, typeName: "CHAR3" }
    }
  ],
  [
    "duplicate import",
    (d: ReturnType<typeof definition>) => d.importParameters.push(d.importParameters[0]!)
  ],
  [
    "update-task wrapper",
    (d: ReturnType<typeof definition>) => {
      d.updateTask = true
    }
  ],
  [
    "nonremote wrapper",
    (d: ReturnType<typeof definition>) => {
      d.remoteEnabled = false
    }
  ],
  [
    "wrong header",
    (d: ReturnType<typeof definition>) => {
      d.source[0] = "FUNCTION Z_OTHER."
    }
  ]
] as const)
  test(`writer attestation blocks ${name}`, async () => {
    const f = fixture(),
      d = definition()
    edit(d)
    f.definition = d
    await assert.rejects(f.run(), /API_NOT_ATTESTED/)
    assert.equal(f.counts().calls, 0)
    assert.equal(f.counts().marks, 0)
  })

test("missing writer and active source drift never reach receipt dispatch mark", async () => {
  const absent = fixture()
  absent.definition = null
  await assert.rejects(absent.run(), /API_NOT_ATTESTED/)
  assert.equal(absent.counts().marks, 0)
  const drift = fixture()
  let reads = 0
  drift.readDefinition = async () => ({
    ...definition(),
    sourceFingerprint: (++reads === 1 ? "d" : "f").repeat(64)
  })
  await assert.rejects(drift.run(), /API_CHANGED/)
  assert.equal(drift.counts().calls, 0)
})
for (const [name, change] of Object.entries({
  "stale native version": {
    apiPrecondition: { ...draft().apiPrecondition, textVersion: "0".repeat(64) }
  },
  "blocked draft": { status: "blocked" },
  "wrong SAP language": { sapLanguage: "E" },
  "altered alias": { after: { ...draft().after, MSEH3: "BAD" } },
  "wrong client": { before: { ...row(), MANDT: "300" } }
}))
  test(`apply blocks ${name} before dispatch`, async () => {
    const f = fixture()
    f.draft = { ...draft(), ...change }
    await assert.rejects(f.run(), /PRECONDITION_FAILED/)
    assert.equal(f.counts().calls, 0)
    assert.equal(f.counts().marks, 0)
  })
test("failed receipt persistence stops the sole command", async () => {
  const f = fixture()
  f.before = async () => {
    throw Error("disk refused receipt")
  }
  await assert.rejects(f.run(), /disk refused/)
  assert.equal(f.counts().calls, 0)
})
test("native declined command returns blocked, not applied, and exposes no row/version", async () => {
  const f = fixture()
  f.response = {
    outputs: {
      ...outputs(),
      EV_CODE: "TEXT_VERSION_CHANGED",
      EV_COMMITTED: "",
      EV_BEFORE_VERSION: "",
      EV_TEXT_VERSION: "",
      EV_TASK: "",
      EV_TABKEY: "",
      ES_TEXT: Object.fromEntries(Object.keys(row()).map((key) => [key, ""]))
    }
  }
  const r = await f.run()
  assert.equal(r.status, "blocked")
  assert.equal(r.committed, false)
  assert.ok(!("data" in r))
  assert.ok(!("textVersion" in r))
  assert.equal(f.counts().reads, 0)
})
for (const [name, edit] of Object.entries({
  "unrecognized code": { EV_CODE: "COMMIT_UNCERTAIN" },
  "missing commit": { EV_COMMITTED: "" },
  "unchanged after version": { EV_TEXT_VERSION: version },
  "wrong task": { EV_TASK: "GR2K900003" },
  "generic key": { EV_TABKEY: "2001*" },
  "changed alias": { ES_TEXT: { ...draft().after, MSEH6: "BAD" } },
  "old before version": { EV_BEFORE_VERSION: "0".repeat(64) },
  "wrong response scope": { EV_CLIENT: "300" }
}))
  test(`post-dispatch ${name} remains uncertain with no retry`, async () => {
    const f = fixture()
    f.response = { outputs: { ...outputs(), ...edit } }
    await assert.rejects(f.run(), /OUTCOME_UNKNOWN/)
    assert.equal(f.counts().calls, 1)
  })
test("SOAP fault and post-commit readback mismatch remain uncertain", async () => {
  const fault = fixture()
  fault.response.fault = { code: "HTTP500", name: "Fault", message: "failure" }
  await assert.rejects(fault.run(), /OUTCOME_UNKNOWN/)
  const stale = fixture()
  stale.readback = { apiSnapshot: { status: "read", textVersion: version, data: row() } }
  await assert.rejects(stale.run(), /READBACK_UNCERTAIN/)
  assert.equal(stale.counts().calls, 1)
})
test("no-change is still confirmed by the locked native command; it records no CTS key", async () => {
  const f = fixture()
  f.draft = { ...draft(), status: "no_changes", before: draft().after }
  f.response = {
    outputs: {
      ...outputs(),
      EV_CODE: "NO_CHANGES",
      EV_COMMITTED: "",
      EV_TEXT_VERSION: version,
      EV_TASK: "",
      EV_TABKEY: ""
    }
  }
  f.readback = { apiSnapshot: { status: "read", textVersion: version, data: draft().after } }
  const r = await f.run()
  assert.equal(r.status, "no_changes")
  assert.equal(r.committed, false)
  assert.ok("exactKeyRecording" in r)
  assert.equal(r.exactKeyRecording, "not_performed")
  assert.equal(f.counts().calls, 1)
})
test("receipt target keeps case and serializes different languages of the same unit", () => {
  const a = writeOperationTarget("apply_configuration_unit_text", input(), "")
  const b = writeOperationTarget(
    "apply_configuration_unit_text",
    { ...input(), language: "EN" },
    ""
  )
  assert.equal(a.key, b.key)
  assert.notEqual(
    a.key,
    writeOperationTarget("apply_configuration_unit_text", { ...input(), unitKey: "KG" }, "").key
  )
  const context = JSON.parse(
    writeOperationContext("apply_configuration_unit_text", input(), new MockBackend())
      .preChangeSummary
  )
  assert.match(context.concurrencyGuard, /SAP full-row text version/)
  assert.equal(context.transportNumber, input().requestNumber)
  assert.equal(context.taskNumber, input().taskNumber)
})

test("real MCP registration advertises write schema and protects rejected/unknown dispatches with receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "unit-apply-protocol-"))
  const original = {
    definition: ToolService.prototype.readFunctionModuleInterface,
    read: ToolService.prototype.readConfigurationUnit,
    preview: ToolService.prototype.previewConfigurationUnitText
  }
  const backend = new MockBackend()
  let commands = 0,
    absent = true
  ToolService.prototype.readFunctionModuleInterface = async () =>
    JSON.stringify(absent ? null : definition())
  ToolService.prototype.readConfigurationUnit = async () =>
    JSON.stringify({
      readFingerprint: input().expectedReadFingerprint,
      apiSnapshot: { status: "read", textVersion: version, data: row() }
    })
  ToolService.prototype.previewConfigurationUnitText = async () => JSON.stringify(draft())
  backend.callRemoteFunction = async () => {
    commands++
    throw Error("lost SAP reply")
  }
  const running = await startHttpServer(backend, 0, root),
    client = new Client({ name: "unit-apply-tests", version: "1" })
  const parse = (r: Awaited<ReturnType<Client["callTool"]>>) =>
    (r.content as { type: string; text: string }[])
      .filter((v) => v.type === "text")
      .map((v) => v.text)
      .join("\n")
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(running.mcpUrl)) as Parameters<Client["connect"]>[0]
    )
    const listed = (await client.listTools()).tools.find(
      (t) => t.name === "apply_configuration_unit_text"
    )!
    assert.equal(listed.annotations?.readOnlyHint, false)
    assert.ok(listed.inputSchema.properties?.operationId)
    assert.ok(listed.inputSchema.properties?.expectedTextVersion)
    assert.ok(toolNamesForProfile("config").includes(listed.name))
    assert.ok(!toolNamesForProfile("readonly").includes(listed.name))
    const rejected = await client.callTool({ name: listed.name, arguments: input() })
    assert.equal(rejected.isError, true)
    assert.match(parse(rejected), /API_NOT_ATTESTED/)
    assert.equal(commands, 0)
    const status = JSON.parse(
      parse(
        await client.callTool({
          name: "get_write_operation_status",
          arguments: { connectionId: "w200", operationId: input().operationId }
        })
      )
    )
    assert.equal(status.sapInvocationStarted, false)
    assert.equal(status.outcomeMayBeUnknown, false)
    const duplicate = await client.callTool({ name: listed.name, arguments: input() })
    assert.match(parse(duplicate), /duplicate_blocked/)
    assert.equal(commands, 0)
    absent = false
    const unknown = await client.callTool({
      name: listed.name,
      arguments: { ...input(), operationId: "unit-apply-test-2" }
    })
    assert.equal(unknown.isError, true)
    assert.match(parse(unknown), /OUTCOME_UNKNOWN/)
    assert.equal(commands, 1)
    const unknownStatus = JSON.parse(
      parse(
        await client.callTool({
          name: "get_write_operation_status",
          arguments: { connectionId: "w200", operationId: "unit-apply-test-2" }
        })
      )
    )
    assert.equal(unknownStatus.sapInvocationStarted, true)
    assert.equal(unknownStatus.outcomeMayBeUnknown, true)
    await client.callTool({
      name: listed.name,
      arguments: { ...input(), operationId: "unit-apply-test-2" }
    })
    assert.equal(commands, 1)
  } finally {
    ToolService.prototype.readFunctionModuleInterface = original.definition
    ToolService.prototype.readConfigurationUnit = original.read
    ToolService.prototype.previewConfigurationUnitText = original.preview
    await client.close()
    await running.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("schema trims description only; active body is ECC candidate with no UI/generic writer", () => {
  assert.equal(
    configurationUnitTextApplySchema.parse({ ...input(), patch: { MSEHL: " 新长描述 " } }).patch
      .MSEHL,
    "新长描述"
  )
  const source = configurationUnitApplyApi.source.join("\n")
  assert.ok(
    configurationUnitApplyApi.source.every((line) => line.length <= 72),
    "the interface creation helper's RSSOURCE CHAR72 boundary must not truncate the candidate"
  )
  assert.equal((source.match(/^\s*COMMIT WORK AND WAIT\./gm) ?? []).length, 1)
  assert.doesNotMatch(source, /^\s*(UPDATE|MODIFY|INSERT|DELETE)\s+(T006A|T006)\b/gim)
  assert.doesNotMatch(
    source,
    /IN UPDATE TASK|CALL SCREEN|CALL TRANSACTION|PERFORM .* IN PROGRAM|@\w/
  )
  assert.match(source, /BYPASSING BUFFER/)
  assert.match(source, /'UPDATE_T006A'/)
  assert.match(source, /'TR_REQ_CHECK_KEY'/)
  assert.match(source, /'TRINT_APPEND_TO_COMM_ARRAYS'/)
  assert.doesNotThrow(() => attestConfigurationUnitApplyApi(definition()))
})
