import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { startHttpServer } from "../src/http.js"
import { PRODUCT_VERSION } from "../src/version.js"
import { MockBackend } from "./mock-backend.js"

test("MVP metadata and source preview are read-only through the actual MCP transport", async () => {
  const state = await mkdtemp(join(tmpdir(), "orvanta-mvp-protocol-"))
  const backend = new MockBackend()
  const running = await startHttpServer(backend, 0, state)
  const client = new Client({ name: "mvp-protocol-test", version: "1.0.0" })
  const lastOperation = () => backend.lastRepositoryRequest?.operation
  try {
    const transport = new StreamableHTTPClientTransport(new URL(running.mcpUrl))
    await client.connect(transport as Parameters<Client["connect"]>[0])
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args })
      assert.notEqual(result.isError, true, JSON.stringify(result))
      return JSON.parse((result.content as Array<{ text: string }>)[0]!.text)
    }
    const runtime = await call("get_runtime_info", { expectedVersion: PRODUCT_VERSION })
    assert.equal(runtime.status, "observed")
    assert.equal(runtime.checks.expectedVersion, "match")
    assert.equal(runtime.sapStatus, "not_probed")
    assert.equal(lastOperation(), undefined)
    const mismatch = await call("get_runtime_info", { expectedVersion: "0.0.1" })
    assert.equal(mismatch.status, "mismatch")
    const fileUri = "adt://w200/sap/bc/adt/oo/classes/zcl_demo"
    const { activeSource } = await backend.inspectSource("w200", fileUri)
    const preview = await call("preview_source_changes", {
      changes: [
        {
          fileUri,
          oldString: activeSource,
          newString: activeSource + "\n* preview",
          packageName: "ZABAP",
          transportNumber: "GR2K923421"
        }
      ]
    })
    assert.equal(preview.status, "ready_for_review")
    assert.equal(preview.executionAuthorized, false)
    assert.equal((await backend.inspectSource("w200", fileUri)).activeSource, activeSource)
    assert.equal(lastOperation(), "INSPECT_REPOSITORY_ASSIGNMENT")
    const rejected = await client.callTool({
      name: "preview_source_changes",
      arguments: { changes: [] }
    })
    assert.equal(rejected.isError, true)
  } finally {
    await client.close()
    await running.close()
    await rm(state, { recursive: true, force: true })
  }
})
