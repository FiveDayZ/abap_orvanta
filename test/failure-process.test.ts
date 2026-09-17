import assert from "node:assert/strict"
import { fork, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

type Value = Record<string, any>

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abap-mcp-m3-"))
  const children: ChildProcess[] = []
  const clients: Client[] = []
  async function start() {
    const child = fork(new URL("./failure-worker.js", import.meta.url), [root], {
      stdio: ["ignore", "ignore", "inherit", "ipc"]
    })
    children.push(child)
    const [ready] = await once(child, "message", { signal: AbortSignal.timeout(10000) })
    assert.equal(ready.type, "ready")
    const client = new Client({ name: "m3-isolated", version: "0.35.0" })
    clients.push(client)
    const transport = new StreamableHTTPClientTransport(new URL(ready.url))
    await client.connect(transport as Parameters<Client["connect"]>[0])
    return { child, client }
  }
  async function stop(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, "exit", { signal: AbortSignal.timeout(10000) })
    child.kill("SIGKILL")
    await exited
  }
  return {
    start,
    stop,
    async calls() {
      try {
        return (await readFile(join(root, "calls.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
        throw error
      }
    },
    async close() {
      await Promise.all(children.map(stop))
      await Promise.all(clients.map((client) => client.close()))
      await rm(root, { recursive: true, force: true })
    }
  }
}

async function call(client: Client, name: string, args: Value = {}) {
  const result = await client.callTool({ name, arguments: { connectionId: "w200", ...args } })
  const text = (result.content as Array<{ type: string; text?: string }>)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
  const receiptText = text.split("\nOperation Receipt\n")[1]
  let data: Value = {}
  try {
    data = JSON.parse(text)
  } catch {
    /* Text errors retain their receipt footer. */
  }
  return {
    error: result.isError === true,
    text,
    data,
    receipt: receiptText ? (JSON.parse(receiptText) as Value) : (data.operationReceipt as Value)
  }
}

async function input(client: Client, value: string, operationId: string, requestId = operationId) {
  const metadata = await call(client, "read_function_module_interface", {
    functionName: "ZCMCP_FM_1501"
  })
  assert.equal(metadata.error, false)
  return {
    functionName: "ZCMCP_FM_1501",
    inputParameters: { IV_INPUT: value },
    acknowledgePotentialSideEffects: true,
    expectedInterfaceFingerprint: metadata.data.fingerprint,
    operationId,
    requestId
  }
}

test(
  "M3 invalid RFC input reports no invocation and no unknown business outcome",
  { timeout: 30000 },
  async () => {
    const f = await fixture()
    try {
      const { client } = await f.start()
      for (const name of ["test_remote_function_module", "invoke_customer_function_module"]) {
        const args = await input(client, "x".repeat(21), `invalid-${name}`)
        const result = await call(client, name, {
          ...args,
          expectedOutputs: { EV_OUTPUT: "unused" }
        })
        assert.equal(result.error, true)
        assert.match(result.text, /IV_INPUT exceeds 20 characters/)
        assert.equal(result.receipt.sapInvocationStarted, false)
        assert.equal(result.receipt.outcomeMayBeUnknown, false)
        const status = await call(client, "get_write_operation_status", {
          operationId: args.operationId
        })
        assert.equal(status.data.sapInvocationStarted, false)
        assert.equal(status.data.outcomeMayBeUnknown, false)
      }
      assert.equal((await f.calls()).length, 0)
    } finally {
      await f.close()
    }
  }
)

test(
  "M3 live cross-process owner cannot be recovered; killed owner remains protected",
  { timeout: 30000 },
  async () => {
    const f = await fixture()
    try {
      const first = await f.start()
      const second = await f.start()
      const args = await input(first.client, "HOLD", "held-operation", "held-request")
      const entered = once(first.child, "message", { signal: AbortSignal.timeout(10000) })
      const pending = call(first.client, "invoke_customer_function_module", args).catch(
        (error) => ({ error })
      )
      await entered
      const busy = await call(second.client, "invoke_customer_function_module", {
        ...args,
        operationId: "competing"
      })
      assert.equal(busy.data.status, "target_concurrency_conflict")
      const active = await call(second.client, "get_write_operation_status", {
        operationId: args.operationId
      })
      assert.equal(active.data.status, "in_progress")
      assert.equal((await call(second.client, "list_write_recovery_operations")).data.count, 0)
      const releaseArgs = {
        operationId: args.operationId,
        expectedReceiptHash: active.data.receiptHash,
        confirmation: "SAP_STATE_VERIFIED",
        reason: "Isolated test backend, no SAP target"
      }
      const denied = await call(second.client, "release_write_operation_lock", releaseArgs)
      assert.equal(denied.error, true)
      assert.match(denied.text, /owner process|still.*(active|progress)/i)
      assert.equal((await f.calls()).length, 1)
      await f.stop(first.child)
      await first.client.close()
      await pending
      const interrupted = await call(second.client, "get_write_operation_status", {
        operationId: args.operationId
      })
      assert.equal(interrupted.data.status, "interrupted")
      assert.equal(interrupted.data.sapInvocationStarted, true)
      assert.equal(interrupted.data.outcomeMayBeUnknown, true)
      const rfc = await call(second.client, "get_customer_function_call_status", {
        requestId: args.requestId
      })
      assert.equal(rfc.data.status, "outcome_unknown")
      const stale = await call(second.client, "release_write_operation_lock", {
        ...releaseArgs,
        expectedReceiptHash: "0".repeat(64)
      })
      assert.equal(stale.error, true)
      assert.match(stale.text, /Receipt hash changed/)
      const releases = await Promise.all(
        Array.from({ length: 2 }, () =>
          call(second.client, "release_write_operation_lock", {
            ...releaseArgs,
            expectedReceiptHash: interrupted.data.receiptHash
          })
        )
      )
      assert.equal(releases.filter((result) => !result.error).length, 1)
      const released = releases.find((result) => !result.error)!
      assert.equal(released.error, false)
      assert.equal(released.data.sapLockChanged, false)
      assert.equal(released.data.recoveryActionSapInvocationStarted, false)
      assert.doesNotMatch(released.data.manualRecovery, /local target lock is retained/)
      const replay = await call(second.client, "invoke_customer_function_module", {
        ...args,
        operationId: "after-recovery"
      })

      assert.equal(replay.data.status, "duplicate_blocked")
      assert.equal(replay.data.sapInvoked, false)
      assert.equal(replay.data.existingReceipt.status, "outcome_unknown")
      assert.equal((await f.calls()).length, 1)
    } finally {
      await f.close()
    }
  }
)

test(
  "M3 completed, conflicting and unknown RFC requests survive real service restart",
  { timeout: 30000 },
  async () => {
    const f = await fixture()
    try {
      const first = await f.start()
      const args = await input(first.client, "VALID", "completed", "persisted-request")
      const completed = await call(first.client, "invoke_customer_function_module", args)
      assert.equal(completed.error, false)
      assert.equal(completed.data.status, "completed")
      const duplicate = await call(first.client, "invoke_customer_function_module", args)
      assert.equal(duplicate.data.status, "duplicate_blocked")
      const conflict = await call(first.client, "invoke_customer_function_module", {
        ...args,
        inputParameters: { IV_INPUT: "OTHER" }
      })
      assert.equal(conflict.data.status, "operation_id_conflict")
      const failedArgs = await input(first.client, "NETWORK", "network", "unknown-request")
      const network = await call(first.client, "invoke_customer_function_module", failedArgs)
      assert.equal(network.error, true)
      assert.equal(network.receipt.outcomeMayBeUnknown, true)
      assert.equal(network.receipt.automaticRetry, false)
      await f.stop(first.child)
      const second = await f.start()
      const status = await call(second.client, "get_customer_function_call_status", {
        requestId: args.requestId
      })
      assert.equal(status.data.status, "completed")
      const repeated = await call(second.client, "invoke_customer_function_module", {
        ...args,
        operationId: "new-operation"
      })
      assert.equal(repeated.data.status, "duplicate_blocked")
      assert.equal(repeated.data.sapInvoked, false)
      const changed = await call(second.client, "invoke_customer_function_module", {
        ...args,
        operationId: "changed-operation",
        inputParameters: { IV_INPUT: "OTHER" }
      })
      assert.equal(changed.data.status, "request_id_conflict")
      const unknown = await call(second.client, "invoke_customer_function_module", {
        ...failedArgs,
        operationId: "new-network-operation"
      })
      assert.equal(unknown.data.status, "duplicate_blocked")
      assert.equal(unknown.data.existingReceipt.status, "outcome_unknown")
      assert.equal(unknown.data.sapInvoked, false)
      assert.equal((await f.calls()).length, 2)
    } finally {
      await f.close()
    }
  }
)

test(
  "M3 simultaneous duplicate requests across processes dispatch at most once",
  { timeout: 30000 },
  async () => {
    const f = await fixture()
    try {
      const first = await f.start()
      const second = await f.start()
      const args = await input(first.client, "SIMULTANEOUS", "same-operation", "same-request")
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          call(index % 2 ? first.client : second.client, "invoke_customer_function_module", args)
        )
      )
      assert.equal(results.filter((result) => result.data.status === "completed").length, 1)
      for (const result of results.filter((result) => result.data.status !== "completed")) {
        assert.equal(result.error, true)
        assert.ok(
          result.data.status === "duplicate_blocked" ||
            /protection could not be established/.test(result.text)
        )
      }
      assert.equal((await f.calls()).length, 1)
    } finally {
      await f.close()
    }
  }
)
