import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { z } from "zod"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { toolContracts } from "../src/contracts.js"
import { startHttpServer } from "../src/http.js"
import { TOOL_NAMES, registryEntry } from "../src/tool-registry.js"
import { MockBackend } from "./mock-backend.js"

/**
 * 0.46.6 guard for the inactive-DDIC recovery tool.
 *
 * A caller that only has an inactive transparent-table definition must have exactly one way
 * forward: this tool, with the complete recovery contract. It must never be replaced by
 * `create_ddic_transparent_table` (which would re-send the definition) or by `abap_activate`
 * (which addresses source URIs, not a stored DDIC definition), and it must never disappear from
 * `tools/list` - a live session once reported it missing because the client's tool list was
 * stale, and that must stay distinguishable from a real registration gap.
 */

const RESUME_TOOL = "resume_ddic_table_activation"
const RESUME_CONFIRMATION = "RESUME_INACTIVE_ACTIVATION"
const DDIC_HELPER = "Z_ORVANTA_MCP_DDIC_API"
/** Inputs the recovery contract must publish, per the live incident hand-over. */
const REQUIRED_SCHEMA_KEYS = [
  "confirmation",
  "connectionId",
  "expectedInactiveFingerprint",
  "objectName",
  "operationId",
  "packageName",
  "settingsRepair",
  "transportNumber"
]
const REQUIRED_INPUTS = [
  "confirmation",
  "connectionId",
  "expectedInactiveFingerprint",
  "objectName",
  "packageName",
  "transportNumber"
]

function validInput(): Record<string, unknown> {
  return {
    connectionId: "w200",
    objectName: "ZTPMC_TPRPI",
    expectedInactiveFingerprint: "a".repeat(64),
    packageName: "ZABAP",
    transportNumber: "GR2K900001",
    confirmation: RESUME_CONFIRMATION
  }
}

test("resume_ddic_table_activation stays registered against the DDIC helper at protocol 1.10", () => {
  assert.ok(TOOL_NAMES.includes(RESUME_TOOL), `${RESUME_TOOL} must stay registered`)
  const entry = registryEntry(RESUME_TOOL)
  assert.ok(entry, `${RESUME_TOOL} must have a registry entry`)
  assert.equal(entry.sapHelper, DDIC_HELPER)
  assert.equal(entry.minHelperProtocol, "1.10")
  assert.equal(entry.route, "sap-helper-fallback")
  assert.equal(entry.annotations.readOnlyHint, false)
  assert.equal(entry.annotations.destructiveHint, true)

  // The recovery action is neither the create action nor a source activation: their registry
  // routes differ, so a substitution would fail this identity check.
  const create = registryEntry("create_ddic_transparent_table")
  assert.ok(create, "create_ddic_transparent_table must stay registered")
  assert.notEqual(create.minHelperProtocol, entry.minHelperProtocol)
  const activate = registryEntry("abap_activate")
  assert.ok(activate, "abap_activate must stay registered")
  assert.notEqual(activate.route, entry.route)
})

test("the resume contract publishes every recovery input", () => {
  const contract = toolContracts[RESUME_TOOL]
  const shape = contract.inputSchema as unknown as Record<string, z.ZodTypeAny>
  assert.deepEqual(Object.keys(shape).sort(), REQUIRED_SCHEMA_KEYS)
  const schema = z.object(shape)

  const parsed = schema.parse(validInput()) as Record<string, unknown>
  assert.equal(parsed.confirmation, RESUME_CONFIRMATION)

  // Required inputs are required: neither the fingerprint guard nor the package/transport
  // evidence may become optional, or the activation could run unguarded.
  for (const key of REQUIRED_INPUTS) {
    const incomplete = validInput()
    delete incomplete[key]
    assert.throws(() => schema.parse(incomplete), `${key} must stay required`)
  }

  // A wrong confirmation string and a malformed fingerprint are both rejected locally.
  assert.throws(() => schema.parse({ ...validInput(), confirmation: "PERMANENT_DELETE" }))
  assert.throws(() =>
    schema.parse({ ...validInput(), expectedInactiveFingerprint: "not-a-fingerprint" })
  )

  // The contract must keep saying that it does not re-send the definition.
  assert.match(contract.description, /does not send a new table definition/i)
  assert.match(contract.description, /RESUME_INACTIVE_ACTIVATION/)

  // The 17:37 incident needed a way to write the approved technical settings before activating.
  // `settingsRepair` is optional - omitting it must still be a valid call - but when it is used the
  // technical-settings change has to be acknowledged explicitly, and the contract must stay explicit
  // that verification happens against the active read.
  const optional = schema.parse(validInput())
  assert.equal("settingsRepair" in optional, false)
  assert.throws(() =>
    schema.parse({
      ...validInput(),
      settingsRepair: { dataClass: "APPL1", sizeCategory: 1 }
    })
  )
  const repaired = schema.parse({
    ...validInput(),
    settingsRepair: {
      dataClass: "APPL1",
      sizeCategory: 1,
      buffering: "notAllowed",
      logDataChanges: false,
      acknowledgeTechnicalSettingsChange: true
    }
  }) as { settingsRepair: Record<string, unknown> }
  assert.equal(repaired.settingsRepair.dataClass, "APPL1")
  assert.match(contract.description, /settingsRepair/)
  assert.match(contract.description, /technicalSettingsVerified/)
})

test("the HTTP tool list publishes the resume tool with its complete JSON schema", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "abap-mcp-resume-contract-"))
  const running = await startHttpServer(new MockBackend(), 0, stateRoot)
  const client = new Client({ name: "resume-contract-client", version: "0.1.0" })
  try {
    const transport = new StreamableHTTPClientTransport(new URL(running.mcpUrl))
    await client.connect(transport as Parameters<Client["connect"]>[0])
    const list = await client.listTools()
    const tool = list.tools.find((candidate) => candidate.name === RESUME_TOOL)
    assert.ok(tool, `${RESUME_TOOL} must be published in tools/list`)

    const schema = tool.inputSchema as {
      properties?: Record<string, unknown>
      required?: string[]
      additionalProperties?: boolean
    }
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), REQUIRED_SCHEMA_KEYS)
    assert.deepEqual([...(schema.required ?? [])].sort(), REQUIRED_INPUTS)
    assert.equal(schema.additionalProperties, false)
    assert.deepEqual(tool.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false
    })
    assert.equal(
      (schema.properties?.confirmation as { const?: string } | undefined)?.const,
      RESUME_CONFIRMATION
    )
    assert.equal(
      (schema.properties?.expectedInactiveFingerprint as { pattern?: string } | undefined)?.pattern,
      "^[a-f0-9]{64}$"
    )
  } finally {
    await client.close()
    await running.close()
    await rm(stateRoot, { recursive: true, force: true })
  }
})
