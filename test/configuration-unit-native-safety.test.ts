import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"
import { configurationUnitApplyApi } from "../src/configuration-unit-apply-api.js"
import type { RemoteFunctionResult } from "../src/backend.js"
import {
  prepareNativeUnitStale,
  runApprovedNativeUnitStale,
  type NativeUnitSafetyReaders
} from "../src/configuration-unit-native-safety.js"
import { WriteOperationReceiptStore } from "../src/write-operation-receipts.js"
import { createServer } from "node:http"
import { once } from "node:events"
import { z } from "zod"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const proof = JSON.parse(
  await readFile(
    resolve(
      "docs/workspace-evidence/.doc/orvanta-unit-text-reconciliation-acceptance-20261004-r35-recheck.json"
    ),
    "utf8"
  )
)
const definition = JSON.parse(
  await readFile(
    resolve(
      "docs/workspace-evidence/.doc/orvanta-unit-text-apply-active-definition-20261004-r31.json"
    ),
    "utf8"
  )
)
const unit = proof.baseline
const cts = proof.cases[0].result.cts.observation
const input = {
  connectionId: "w200",
  unitKey: "KG",
  language: "ZH",
  requestNumber: "GR2K923429",
  taskNumber: "GR2K923430",
  operationId: "unit-native-stale-test"
}
const copy = <T>(value: T): T => structuredClone(value)
function readers(): NativeUnitSafetyReaders {
  return {
    readDefinition: async () => copy(definition),
    readUnit: async () => copy(unit),
    inspectTransport: async () => copy(cts),
    readLocks: async () => ({
      connectionId: "w200",
      client: "200",
      status: "ok",
      hasMore: false,
      entries: []
    })
  }
}
const rejected = (): RemoteFunctionResult => ({
  outputs: {
    EV_CODE: "TEXT_VERSION_CHANGED",
    EV_SYSTEM: "GR2",
    EV_CLIENT: "200",
    EV_USER: "WYS",
    EV_COMMITTED: "",
    EV_BEFORE_VERSION: "",
    EV_TEXT_VERSION: "",
    EV_TASK: "",
    EV_TABKEY: "",
    EV_MSGID: "",
    EV_MSGNO: "",
    ES_TEXT: Object.fromEntries(Object.keys(unit.apiSnapshot.data).map((key) => [key, ""]))
  }
})
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "orvanta-native-stale-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new WriteOperationReceiptStore(directory)
  const read = readers()
  const plan = await prepareNativeUnitStale(input, read)
  const grant = {
    scenario: "native_locked_stale_version",
    planFingerprint: plan.planFingerprint,
    acknowledgeOneNativeCall: true
  }
  return { store, read, plan, grant }
}

test("stale plan uses the actual native row and pins one no-value-change command", async () => {
  const result = await prepareNativeUnitStale(input, readers())
  assert.equal(result.inputParameters.IV_MSEHL, "千克")
  assert.equal(result.inputParameters.IV_SET_MSEHT, "")
  assert.equal(result.inputParameters.IV_MSEHT, "")
  assert.notEqual(result.inputParameters.IV_EXPECTED_VERSION, unit.apiSnapshot.textVersion)
  assert.match(result.inputParameters.IV_EXPECTED_VERSION, /^[a-f0-9]{64}$/)
  assert.equal(result.nativeInvoked, false)
  assert.equal(result.executionAuthorized, false)
  assert.equal(result.maximumNativeCalls, 1)
  assert.deepEqual(result.beforeText, unit.apiSnapshot.data)
})

test("other keys, fields, containers and hidden execute flags refuse before reads", async () => {
  for (const patch of [
    { unitKey: "LB" },
    { language: "EN" },
    { connectionId: "w300" },
    { requestNumber: "GR2K923472" },
    { taskNumber: "GR2K923431" },
    { execute: true },
    { patch: { MSEHL: "changed" } },
    { operationId: "unscoped" }
  ]) {
    let calls = 0
    await assert.rejects(
      prepareNativeUnitStale(
        { ...input, ...patch },
        {
          readDefinition: async () => {
            calls++
            return definition
          },
          readUnit: async () => unit,
          inspectTransport: async () => cts
        }
      )
    )
    assert.equal(calls, 0)
  }
})

test("drifting native body refuses preparation before table reads", async () => {
  const read = readers(),
    changed = copy(definition)
  changed.source.push("COMMIT WORK.")
  read.readDefinition = async () => changed
  read.readUnit = async () => {
    throw Error("UNEXPECTED_READ")
  }
  await assert.rejects(prepareNativeUnitStale(input, read), /NOT_ATTESTED/)
})

test("missing native snapshot, mismatched full-row version and reader scope refuse", async () => {
  for (const mutate of [
    (value: any) => {
      delete value.apiSnapshot
    },
    (value: any) => {
      value.apiSnapshot.data.MSEHL = "changed"
    },
    (value: any) => {
      value.client = "300"
    },
    (value: any) => {
      value.apiSnapshot.bodyFingerprint = "0".repeat(64)
    }
  ]) {
    const read = readers(),
      changed = copy(unit)
    mutate(changed)
    read.readUnit = async () => changed
    await assert.rejects(prepareNativeUnitStale(input, read), /FULL_ROW_UNVERIFIED/)
  }
})

test("wrong or truncated CTS projections cannot create a stale plan", async () => {
  for (const mutate of [
    (value: any) => {
      value.keyRecording.observed.taskE071K[0].TRKORR = "GR2K923429"
    },
    (value: any) => {
      value.checks.taskOpen = false
    },
    (value: any) => {
      value.keyRecording.status = "truncated"
    },
    (value: any) => {
      value.observed.task[0].AS4USER = "OTHER"
    }
  ]) {
    const read = readers(),
      changed = copy(cts)
    mutate(changed)
    read.inspectTransport = async () => changed
    await assert.rejects(prepareNativeUnitStale(input, read), /CTS_UNVERIFIED/)
  }
})

test("unavailable lock diagnostics remain explicit and do not authorize dispatch", async (t) => {
  const { read, store } = await fixture(t)
  read.readLocks = async () => {
    throw Error("HELPER_NOT_APPROVED")
  }
  const plan = await prepareNativeUnitStale(input, read)
  assert.ok(
    plan.locks.every((row) => row.status === "unavailable" && row.code === "HELPER_NOT_APPROVED")
  )
  let calls = 0
  await assert.rejects(
    runApprovedNativeUnitStale(
      plan,
      {
        scenario: "native_locked_stale_version",
        planFingerprint: plan.planFingerprint,
        acknowledgeOneNativeCall: true
      },
      read,
      {
        callRemoteFunction: async () => {
          calls++
          return rejected()
        }
      },
      store
    ),
    /LOCK_PRECONDITION_UNVERIFIED/
  )
  assert.equal(calls, 0)
})

test("wrong, absent, expired or broadened grants dispatch zero times", async (t) => {
  const { plan, grant, read, store } = await fixture(t)
  for (const supplied of [
    undefined,
    { ...grant, planFingerprint: "0".repeat(64) },
    { ...grant, maximumNativeCalls: 2 },
    { ...grant, acknowledgeOneNativeCall: false }
  ]) {
    let calls = 0
    await assert.rejects(
      runApprovedNativeUnitStale(
        plan,
        supplied,
        read,
        {
          callRemoteFunction: async () => {
            calls++
            return rejected()
          }
        },
        store
      )
    )
    assert.equal(calls, 0)
  }
  await assert.rejects(
    runApprovedNativeUnitStale(
      { ...plan, observedAt: "2000-01-01T00:00:00Z" },
      grant,
      read,
      { callRemoteFunction: async () => rejected() },
      store
    ),
    /EXPIRED/
  )
})

test("tampered parameters and changed evidence block before native call", async (t) => {
  const { plan, grant, read, store } = await fixture(t)
  const altered = copy(plan)
  altered.inputParameters.IV_MSEHL = "modified"
  let calls = 0
  const backend = {
    callRemoteFunction: async () => {
      calls++
      return rejected()
    }
  }
  await assert.rejects(
    runApprovedNativeUnitStale(altered, grant, read, backend, store),
    /PLAN_CHANGED/
  )
  const wrongBefore = copy(plan)
  wrongBefore.beforeText.MSEHL = "misleading review value"
  await assert.rejects(
    runApprovedNativeUnitStale(wrongBefore, grant, read, backend, store),
    /PLAN_CHANGED/
  )
  const moved = copy(definition)
  moved.sourceFingerprint = "f".repeat(64)
  read.readDefinition = async () => moved
  await assert.rejects(
    runApprovedNativeUnitStale(plan, grant, read, backend, store),
    /PLAN_CHANGED/
  )
  assert.equal(calls, 0)
})

test("valid rejection persists invocation evidence before its only bounded dispatch", async (t) => {
  const { plan, grant, read, store } = await fixture(t)
  let calls = 0
  const result = await runApprovedNativeUnitStale(
    plan,
    grant,
    read,
    {
      callRemoteFunction: async (connectionId, request) => {
        calls++
        assert.equal(connectionId, "w200")
        assert.equal(request.functionName, configurationUnitApplyApi.functionName)
        assert.deepEqual(request.inputParameters, plan.inputParameters)
        const receipt = await store.status("w200", input.operationId)
        assert.equal(receipt.sapInvocationStarted, true)
        assert.equal((receipt.sapPreChangeEvidence as any).version, plan.originalVersion)
        return rejected()
      }
    },
    store
  )
  assert.equal(calls, 1)
  assert.equal(result.status, "native_stale_rejection_verified")
  assert.equal(result.valueUnchanged, true)
  assert.equal(result.ctsProjectionUnchanged, true)
  assert.equal(result.locksRechecked, true)
  assert.equal((result.receipt as any).status, "completed")
  await assert.rejects(
    runApprovedNativeUnitStale(
      plan,
      grant,
      read,
      {
        callRemoteFunction: async () => {
          calls++
          return rejected()
        }
      },
      store
    ),
    /RECEIPT_REFUSED/
  )
  assert.equal(calls, 1)
})

test("lost native response remains unknown even when readonly observations match", async (t) => {
  const { plan, grant, read, store } = await fixture(t)
  const result = await runApprovedNativeUnitStale(
    plan,
    grant,
    read,
    {
      callRemoteFunction: async () => {
        throw Error("NETWORK_OUTCOME_UNCERTAIN")
      }
    },
    store
  )
  assert.equal(result.status, "unknown")
  assert.equal(result.firstCause, "NETWORK_OUTCOME_UNCERTAIN")
  assert.equal(result.valueUnchanged, true)
  assert.equal((result.receipt as any).outcomeMayBeUnknown, true)
  assert.equal(result.nativeCalls, 1)
  assert.equal(result.automaticRestore, false)
  assert.equal(result.automaticRetry, false)
})

test("unexpected native success or another refusal is never accepted as the stale sample", async (t) => {
  for (const code of [
    "APPLIED",
    "NO_CHANGES",
    "AUTHORIZATION_DENIED",
    "CTS_CONTAINER_INVALID",
    "COMMIT_UNCERTAIN"
  ]) {
    const { plan, grant, read, store } = await fixture(t)
    const reply = rejected()
    reply.outputs.EV_CODE = code
    const result = await runApprovedNativeUnitStale(
      plan,
      grant,
      read,
      { callRemoteFunction: async () => reply },
      store
    )
    assert.equal(result.status, "unknown")
    assert.equal(result.nativeCode, code)
    assert.equal((result.receipt as any).outcomeMayBeUnknown, true)
  }
})

test("post-dispatch observation failure preserves the original first cause", async (t) => {
  const { plan, grant, read, store } = await fixture(t)
  const result = await runApprovedNativeUnitStale(
    plan,
    grant,
    read,
    {
      callRemoteFunction: async () => {
        read.readUnit = async () => {
          throw Error("POST_READ_FAILED")
        }
        throw Error("FIRST_NATIVE_ERROR")
      }
    },
    store
  )
  assert.equal(result.status, "unknown")
  assert.equal(result.firstCause, "FIRST_NATIVE_ERROR")
  assert.equal((result.receipt as any).outcomeMayBeUnknown, true)
})

test("scope or commit flags in an otherwise matching native refusal remain uncertain", async (t) => {
  for (const field of [
    "EV_COMMITTED",
    "EV_TASK",
    "EV_BEFORE_VERSION",
    "EV_SYSTEM",
    "EV_CLIENT",
    "EV_USER",
    "ES_TEXT"
  ]) {
    const { plan, grant, read, store } = await fixture(t)
    const reply = rejected()
    if (field === "ES_TEXT")
      (reply.outputs.ES_TEXT as Record<string, string>).MSEHL = "unexpected value"
    else reply.outputs[field] = "X"
    const result = await runApprovedNativeUnitStale(
      plan,
      grant,
      read,
      { callRemoteFunction: async () => reply },
      store
    )
    assert.equal(result.status, "unknown")
    assert.equal(result.nativeCalls, 1)
  }
})

test("readonly MCP preparation rejects older schemas without calling any SAP tool", async () => {
  const { prepareUnitStaleViaMcp } = await import(
    pathToFileURL(resolve("scripts/probe-unit-native-stale.mjs")).href
  )
  let calls = 0
  const client = {
    listTools: async () => ({
      tools: [
        "read_function_module_interface",
        "read_configuration_unit",
        "inspect_configuration_transport"
      ].map((name) => ({
        name,
        annotations: { readOnlyHint: true },
        inputSchema: { properties: {} }
      }))
    }),
    callTool: async () => {
      calls++
      throw Error("UNEXPECTED_DISPATCH")
    }
  }
  await assert.rejects(prepareUnitStaleViaMcp(client, input), /NATIVE_READER_SCHEMA_UNAVAILABLE/)
  assert.equal(calls, 0)
})

test("CLI endpoint cannot expose credentials or use a remote MCP service", async () => {
  const { validateUnitSafetyEndpoint } = await import(
    pathToFileURL(resolve("scripts/probe-unit-native-stale.mjs")).href
  )
  assert.equal(validateUnitSafetyEndpoint("http://127.0.0.1:1479/mcp").hostname, "127.0.0.1")
  for (const endpoint of [
    "http://localhost:4849/mcp",
    "http://example.com/mcp",
    "http://user:password@127.0.0.1/mcp",
    "http://127.0.0.1/mcp?token=x",
    "http://127.0.0.1/other"
  ])
    assert.throws(() => validateUnitSafetyEndpoint(endpoint), /ENDPOINT_INVALID/)
})

test("actual loopback MCP preparation makes only the five pinned reader calls", async () => {
  const { prepareUnitStaleViaMcp } = await import(
    pathToFileURL(resolve("scripts/probe-unit-native-stale.mjs")).href
  )
  const sdk = new McpServer({ name: "native-safety-reader-fixture", version: "1" })
  const calls: string[] = []
  const add = (name: string, schema: z.ZodRawShape, value: unknown) =>
    sdk.registerTool(
      name,
      {
        inputSchema: schema,
        annotations: { readOnlyHint: true }
      },
      async () => {
        calls.push(name)
        return { content: [{ type: "text", text: JSON.stringify(value) }] }
      }
    )
  add(
    "read_function_module_interface",
    { connectionId: z.literal("w200"), functionName: z.literal("Z_ORVANTA_CFG_UNIT_APPLY") },
    definition
  )
  add(
    "read_configuration_unit",
    {
      connectionId: z.literal("w200"),
      unitKey: z.literal("KG"),
      language: z.literal("ZH"),
      includeApiSnapshot: z.literal(true)
    },
    unit
  )
  add(
    "inspect_configuration_transport",
    {
      connectionId: z.literal("w200"),
      requestNumber: z.literal("GR2K923429"),
      taskNumber: z.literal("GR2K923430"),
      unitText: z.object({ unitKey: z.literal("KG"), language: z.literal("ZH") }).strict()
    },
    cts
  )
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => "unit-native-safety-loopback"
  })
  await sdk.connect(transport as Parameters<McpServer["connect"]>[0])
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    await transport.handleRequest(
      request,
      response,
      chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined
    )
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const client = new Client({ name: "native-safety-preparation-test", version: "1" })
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${address.port}/mcp`)
      ) as Parameters<Client["connect"]>[0]
    )
    const result = await prepareUnitStaleViaMcp(client, input)
    assert.equal(result.executionAuthorized, false)
    assert.equal(result.nativeInvoked, false)
    assert.deepEqual(calls, [
      "read_function_module_interface",
      "read_configuration_unit",
      "inspect_configuration_transport",
      "read_configuration_unit",
      "read_function_module_interface"
    ])
    assert.ok(result.locks.every((row: any) => row.status === "not_requested"))
  } finally {
    await client.close()
    await sdk.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("receipt persistence failure prevents dispatch and leaves SAP invocation false", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "orvanta-native-stale-persistence-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  class FailingStore extends WriteOperationReceiptStore {
    override async markSapInvocationStarted(): Promise<void> {
      throw Error("RECEIPT_PERSISTENCE_FAILED")
    }
  }
  const store = new FailingStore(directory),
    read = readers(),
    plan = await prepareNativeUnitStale(input, read)
  let calls = 0
  const result = await runApprovedNativeUnitStale(
    plan,
    {
      scenario: "native_locked_stale_version",
      planFingerprint: plan.planFingerprint,
      acknowledgeOneNativeCall: true
    },
    read,
    {
      callRemoteFunction: async () => {
        calls++
        return rejected()
      }
    },
    store
  )
  assert.equal(calls, 0)
  assert.equal((result.receipt as any).sapInvocationStarted, false)
  assert.equal((result.receipt as any).outcomeMayBeUnknown, false)
  assert.equal(result.firstCause, "RECEIPT_PERSISTENCE_FAILED")
})

test("native failure text is preserved by hash while a later read failure cannot replace it", async (t) => {
  const { createHash } = await import("node:crypto")
  const { plan, grant, read, store } = await fixture(t)
  const first = Error("HTTP 500: real first transport failure")
  const result = await runApprovedNativeUnitStale(
    plan,
    grant,
    read,
    {
      callRemoteFunction: async () => {
        read.readDefinition = async () => {
          throw Error("LATER_READ_FAILED")
        }
        throw first
      }
    },
    store
  )
  assert.equal(
    (result.receipt as any).errorHash,
    createHash("sha256").update(String(first)).digest("hex")
  )
  assert.equal(result.firstCause, "NATIVE_SAFETY_OBSERVATION_UNAVAILABLE")
  assert.equal(result.nativeCalls, 1)
})

test("changed CTS after a genuine rejection keeps the receipt unknown", async (t) => {
  const { plan, grant, read, store } = await fixture(t)
  const changed = copy(cts)
  changed.observed.task[0].AS4TIME = "123456"
  const result = await runApprovedNativeUnitStale(
    plan,
    grant,
    read,
    {
      callRemoteFunction: async () => {
        read.inspectTransport = async () => changed
        return rejected()
      }
    },
    store
  )
  assert.equal(result.status, "unknown")
  assert.equal(result.valueUnchanged, true)
  assert.equal(result.ctsProjectionUnchanged, false)
  assert.equal((result.receipt as any).outcomeMayBeUnknown, true)
})
