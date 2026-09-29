import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { loadConnections, systemRoleSchema } from "../src/config.js"

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

test("a declared landscape role survives parsing, and the role vocabulary is the documented one", async () => {
  const root = await mkdtemp(join(tmpdir(), "abap-mcp-config-role-"))
  const path = join(root, "connections.json")
  const connection = {
    id: "w200",
    url: "https://sap.example.invalid",
    client: "200",
    language: "EN",
    username: "DEVELOPER",
    passwordEnv: "ABAP_MCP_TEST_PASSWORD",
    allowUnauthorized: false
  }
  try {
    // The value is named explicitly because it is the published vocabulary: docs/agent-client-setup.md
    // offers exactly DEV, QAS and PRD, and a fourth value added here without that document would be
    // a contract nobody was told about.
    assert.deepEqual(systemRoleSchema.options, ["DEV", "QAS", "PRD"])

    // This half is the one that would otherwise pass silently while being wrong. `connectionSchema` is
    // a plain z.object, so a key that is missing from the schema is stripped rather than rejected: a
    // declared role would read back as undefined with no error anywhere, and a cross-system tool would
    // then report that no connection carries the role the operator just wrote into the file.
    await writeFile(path, JSON.stringify({ connections: [{ ...connection, role: "QAS" }] }))
    const declared = await loadConnections(path)
    assert.equal(declared[0]?.role, "QAS")

    // Optional: a single-system install declares nothing and must keep loading unchanged.
    await writeFile(path, JSON.stringify({ connections: [connection] }))
    const undeclared = await loadConnections(path)
    assert.equal(undeclared[0]?.role, undefined)
    assert.equal(undeclared[0]?.id, "w200")

    // A misspelt role is rejected instead of being accepted as "some other system".
    await writeFile(path, JSON.stringify({ connections: [{ ...connection, role: "PROD" }] }))
    await assert.rejects(loadConnections(path), /Invalid enum value/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
