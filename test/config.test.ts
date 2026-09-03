import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { loadConnections } from "../src/config.js"

test("connection config normalizes and validates the customer RFC allowlist", async () => {
  const root = await mkdtemp(join(tmpdir(), "abap-mcp-config-"))
  const path = join(root, "connections.json")
  const connection = {
    id: "W200",
    url: "https://sap.example.invalid",
    client: "200",
    language: "EN",
    username: "DEVELOPER",
    passwordEnv: "ABAP_MCP_TEST_PASSWORD",
    allowUnauthorized: false
  }
  try {
    await writeFile(
      path,
      JSON.stringify({
        connections: [{ ...connection, remoteFunctionAllowlist: ["zcmcp_fm_1901", "Y_CUSTOM_RFC"] }]
      })
    )
    const loaded = await loadConnections(path)
    assert.equal(loaded[0]?.id, "w200")
    assert.deepEqual(loaded[0]?.remoteFunctionAllowlist, ["ZCMCP_FM_1901", "Y_CUSTOM_RFC"])

    await writeFile(
      path,
      JSON.stringify({
        connections: [
          { ...connection, remoteFunctionAllowlist: ["ZCMCP_FM_1901", "zcmcp_fm_1901"] }
        ]
      })
    )
    await assert.rejects(loadConnections(path), /Duplicate remote function/)

    await writeFile(
      path,
      JSON.stringify({
        connections: [{ ...connection, remoteFunctionAllowlist: ["RFC_READ_TABLE"] }]
      })
    )
    await assert.rejects(loadConnections(path), /Invalid/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
