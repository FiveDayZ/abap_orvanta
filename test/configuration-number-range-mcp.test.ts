import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { startHttpServer } from "../src/http.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"
import { WriteOperationReceiptStore } from "../src/write-operation-receipts.js"
import {
  configurationNumberRangeReadApi as reader,
  configurationNumberRangeApplyApi as writer
} from "../src/configuration-number-range-api.js"
import {
  configurationNumberRangeCommandDependencies as dependencies,
  configurationNumberRangeCommandIncludes as includes
} from "../src/configuration-number-range-command.js"
import { configurationNumberRangeNativeTables as layouts } from "../src/configuration-number-range-native.js"
const version = "a".repeat(64),
  nextVersion = "b".repeat(64)
const input = (operationId = "number-mcp-create") => ({
  connectionId: "w200",
  objectName: "ZTESTNR",
  expectedVersion: version,
  action: "create",
  intervalNumber: "01",
  fromNumber: "00000000000000000001",
  toNumber: "00000000000000000100",
  external: false,
  operationId,
  acknowledgeConfigurationWrite: true,
  acknowledgeLocalClientOnly: true
})
type Row = Record<string, string>
const parse = (r: unknown) => {
  assert.ok(r && typeof r === "object" && "content" in r)
  return JSON.parse((r.content as { text: string }[])[0]!.text)
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "orvanta-number-mcp-")),
    backend = new MockBackend()
  let calls = 0,
    reads = 0,
    rows: Row[] = [],
    current = version
  const state = {
    missing: false,
    interrupted: false,
    includeRouteDrift: false,
    readCalls: 0,
    writeCalls: 0
  }
  const definition = Object.fromEntries(
    layouts.TNRO.fields.map((f) => [f, f === "OBJECT" ? "ZTESTNR" : f === "DOMLEN" ? "NUMC20" : ""])
  )
  const original = {
    function: ToolService.prototype.readFunctionModuleInterface,
    table: ToolService.prototype.readDdicTransparentTable,
    lines: ToolService.prototype.getObjectLines
  }
  ToolService.prototype.readFunctionModuleInterface = async (arg) => {
    reads++
    if (state.missing) throw Error("FUNCTION_READ_FAILED")
    const api =
      arg.functionName === reader.functionName
        ? reader
        : arg.functionName === writer.functionName
          ? writer
          : null
    if (api)
      return JSON.stringify({
        ...api,
        connectionId: "w200",
        updateTask: false,
        updateTaskMode: "",
        changingParameters: [],
        exceptions: [],
        sourceFingerprint: version,
        interfaceFingerprint: version,
        source: [`FUNCTION ${api.functionName}.`, ...api.source.split("\n"), "ENDFUNCTION."]
      })
    const pins = dependencies[arg.functionName as keyof typeof dependencies]
    assert.ok(pins)
    return JSON.stringify({
      functionName: arg.functionName,
      remoteEnabled: false,
      updateTask: false,
      ...pins
    })
  }
  ToolService.prototype.readDdicTransparentTable = async (arg) => {
    const l = layouts[arg.objectName as keyof typeof layouts]
    assert.ok(l)
    return JSON.stringify({
      connectionId: "w200",
      objectName: arg.objectName,
      objectKind: "transparentTable",
      fingerprint: l.fingerprint,
      definition: { fields: l.fields.map((name) => ({ name })) }
    })
  }
  ToolService.prototype.getObjectLines = async (arg) => {
    const pin = includes[arg.objectName as keyof typeof includes]
    assert.ok(pin)
    const uri =
      arg.objectName === "FSNR1CDC" && !state.includeRouteDrift
        ? "/programs/includes/fsnr1cdc/source"
        : `/functions/groups/snr1/includes/${arg.objectName.toLowerCase()}/source`
    return `Source from ${arg.objectName} (lines 1-1 of 1, 1 lines retrieved):\nFull Source SHA-256: ${pin}\n${uri}\n1: fixture`
  }
  backend.callRemoteFunction = async (_connection, request) => {
    calls++
    assert.deepEqual(request.inputParameters.ET_INTERVALS, [])
    if (request.functionName === reader.functionName) {
      state.readCalls++
      return {
        outputs: {
          EV_CODE: "READ_OK",
          EV_SYSTEM: "GR2",
          EV_CLIENT: "200",
          EV_VERSION: current,
          ES_DEFINITION: definition,
          ET_INTERVALS: rows
        }
      }
    }
    assert.equal(request.functionName, writer.functionName)
    state.writeCalls++
    assert.equal(
      (
        await new WriteOperationReceiptStore(root).status(
          "w200",
          String(request.inputParameters.IV_OBJECT) === "ZTESTNR" ? input().operationId : "invalid"
        )
      ).sapInvocationStarted,
      true
    )
    rows = [
      {
        CLIENT: "200",
        OBJECT: "ZTESTNR",
        SUBOBJECT: "",
        NRRANGENR: "01",
        TOYEAR: "0000",
        FROMNUMBER: input().fromNumber,
        TONUMBER: input().toNumber,
        NRLEVEL: "00000000000000000000",
        EXTERNIND: ""
      }
    ]
    current = nextVersion
    if (state.interrupted) throw Error("fixture interrupted after save")
    return {
      outputs: {
        EV_CODE: "SAVED_LOCAL_CLIENT",
        EV_SYSTEM: "GR2",
        EV_CLIENT: "200",
        EV_USER: "FIXTURE",
        EV_COMMITTED: "X",
        EV_BEFORE_VERSION: version,
        EV_VERSION: current,
        EV_SESSION_RESET: "X",
        EV_UNLOCKED: "X",
        EV_MSGID: "",
        EV_MSGNO: "",
        ES_ERROR: { MSGNR: "", TABLENAME: "", FIELDNAME: "", TABIX: "0" },
        ET_INTERVALS: rows
      }
    }
  }
  const running = await startHttpServer(backend, 0, root),
    client = new Client({ name: "configuration-number-range-public-test", version: "1" })
  const transport = new StreamableHTTPClientTransport(new URL(running.mcpUrl))
  await client.connect(transport as Parameters<Client["connect"]>[0])
  t.after(async () => {
    await client.close()
    await running.close()
    ToolService.prototype.readFunctionModuleInterface = original.function
    ToolService.prototype.readDdicTransparentTable = original.table
    ToolService.prototype.getObjectLines = original.lines
    await rm(root, { recursive: true, force: true })
  })
  return { client, state, root, counts: () => ({ calls, reads }) }
}
test("public number range tools expose strict schemas, correct risks and native version", async (t) => {
  const f = await fixture(t),
    listed = (await f.client.listTools()).tools
  const read = listed.find((t) => t.name === "read_configuration_number_range_api")!,
    write = listed.find((t) => t.name === "apply_configuration_number_range")!
  assert.equal(read.annotations?.readOnlyHint, true)
  assert.equal(write.annotations?.readOnlyHint, false)
  assert.equal(write.inputSchema.additionalProperties, false)
  assert.ok(write.inputSchema.required?.includes("operationId"))
  assert.equal(Object.keys(write.inputSchema.properties!).length, 11)
  const r = await f.client.callTool({
    name: read.name,
    arguments: { connectionId: "w200", objectName: "ZTESTNR" }
  })
  assert.notEqual(r.isError, true)
  assert.equal(parse(r).snapshot.EV_VERSION, version)
  assert.equal(f.state.writeCalls, 0)
})
test("public invalid number range commands never reach metadata or SAP", async (t) => {
  const f = await fixture(t)
  for (const args of [
    { ...input(), execute: true },
    { ...input(), connectionId: "w300" },
    { ...input(), acknowledgeConfigurationWrite: false },
    { ...input(), currentLevel: "1" },
    { ...input(), toNumber: input().fromNumber }
  ])
    assert.equal(
      (await f.client.callTool({ name: "apply_configuration_number_range", arguments: args }))
        .isError,
      true
    )
  assert.deepEqual(f.counts(), { calls: 0, reads: 0 })
})
test("public number range save has a durable receipt and same-operation replay dispatches once", async (t) => {
  const f = await fixture(t)
  const r = await f.client.callTool({
    name: "apply_configuration_number_range",
    arguments: input()
  })
  assert.notEqual(r.isError, true)
  assert.equal(parse(r).status, "completed")
  assert.equal(parse(r).operationReceipt.status, "completed")
  const duplicate = await f.client.callTool({
    name: "apply_configuration_number_range",
    arguments: input()
  })
  assert.equal(duplicate.isError, true)
  assert.equal(parse(duplicate).status, "protection_refused")
  assert.equal(f.state.writeCalls, 1)
})
test("public number range unknown after-save outcome stays failed, preserves readback and never retries", async (t) => {
  const f = await fixture(t)
  f.state.interrupted = true
  const r = await f.client.callTool({
    name: "apply_configuration_number_range",
    arguments: input()
  })
  assert.equal(r.isError, true)
  const body = parse(r)
  assert.equal(body.status, "unknown")
  assert.equal(body.operationReceipt.status, "failed")
  assert.equal(body.operationReceipt.outcomeMayBeUnknown, true)
  assert.equal(body.readback.EV_VERSION, nextVersion)
  assert.equal(body.failure.code, "CONFIGURATION_NR_TRANSPORT_FAILED")
  assert.match(body.failure.evidenceHash, /^[a-f0-9]{64}$/)
  const bypass = await f.client.callTool({
    name: "apply_configuration_number_range",
    arguments: {
      ...input("different-operation"),
      intervalNumber: "02",
      expectedVersion: nextVersion
    }
  })
  assert.equal(bypass.isError, true)
  assert.equal(parse(bypass).status, "protection_refused")
  assert.equal(f.state.writeCalls, 1)
  const reconciled = await f.client.callTool({
    name: "reconcile_configuration_number_range",
    arguments: { connectionId: "w200", objectName: "ZTESTNR", operationId: input().operationId }
  })
  const observation = parse(reconciled)
  assert.equal(observation.stateComparison, "changed_since_before")
  assert.equal(observation.outcomeMayBeUnknown, true)
  assert.equal(observation.operationReceipt.receiptHash, body.operationReceipt.receiptHash)
  assert.equal(f.state.writeCalls, 1)
})
test("public missing number range API refuses before native dispatch with an attributed receipt", async (t) => {
  const f = await fixture(t)
  f.state.missing = true
  const r = await f.client.callTool({
    name: "apply_configuration_number_range",
    arguments: input()
  })
  assert.equal(r.isError, true)
  assert.equal(parse(r).status, "declined")
  assert.equal(parse(r).operationReceipt.sapInvocationStarted, false)
  assert.equal(f.state.writeCalls, 0)
  assert.equal(f.counts().calls, 0)
  const reconciled = await f.client.callTool({
    name: "reconcile_configuration_number_range",
    arguments: { connectionId: "w200", objectName: "ZTESTNR", operationId: input().operationId }
  })
  assert.equal(parse(reconciled).status, "not_dispatched")
  assert.equal(f.counts().calls, 0)
})

test("public change-document Include route drift refuses without starting a SAP write", async (t) => {
  const f = await fixture(t)
  f.state.includeRouteDrift = true
  const r = await f.client.callTool({
    name: "apply_configuration_number_range",
    arguments: input()
  })
  const body = parse(r)
  assert.equal(r.isError, true)
  assert.equal(body.code, "CONFIGURATION_NR_INCLUDE_NOT_ATTESTED")
  assert.equal(body.operationReceipt.sapInvocationStarted, false)
  assert.equal(body.operationReceipt.outcomeMayBeUnknown, false)
  assert.equal(f.state.writeCalls, 0)
})
