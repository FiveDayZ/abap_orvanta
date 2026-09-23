import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
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

test("resume_ddic_table_activation stays registered against the DDIC helper at protocol 1.13", () => {
  assert.ok(TOOL_NAMES.includes(RESUME_TOOL), `${RESUME_TOOL} must stay registered`)
  const entry = registryEntry(RESUME_TOOL)
  assert.ok(entry, `${RESUME_TOOL} must have a registry entry`)
  assert.equal(entry.sapHelper, DDIC_HELPER)
  // R-20 raised this from 1.10: the operation the tool needs is RESUME_TABLE_ACTIVATION, and no
  // 1.10 helper delivers it, because 1.10 shipped the 35-character
  // RESUME_TRANSPARENT_TABLE_ACTIVATION that the helper's CHAR 32 IV_OPERATION truncated.
  // 2026-09-23 raised it again to 1.13: the 1.11/1.12 carriers could dispatch the name but had also
  // set lv_recover, so they answered WORKLIST_REQUIRED (no worklist) or ran DD_DB_CONVERTER and
  // returned - never the lv_resume activation. A 1.11 minimum advertised an unusable capability as
  // available, which is exactly what the 2026-09-23 incident hit.
  assert.equal(entry.minHelperProtocol, "1.13")
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

test("the helper resume arm activates without entering conversion recovery", async () => {
  // 2026-09-23 incident: resume_ddic_table_activation failed with WORKLIST_REQUIRED even though
  // read_ddic_table_conversion_status reported pending=false / entries=[] and the object was a
  // complete inactive definition. The resume dispatch arm also set lv_recover, so the operation
  // landed in the TBATG conversion-recovery block: with no worklist it answered WORKLIST_REQUIRED,
  // and with one it ran DD_DB_CONVERTER and RETURNed - the lv_resume activation arm (DD_TABL_ACT)
  // was dead code, and the capability was advertised as available the whole time.
  // Resolved against the package root, like the other source-reading guards in this suite (the
  // compiled test runs from dist/test, so a module-relative path would look under dist/scripts).
  const script = await readFile("scripts/bootstrap-sap-helper.ps1", "utf8")
  // Only the emitted ABAP string lines count as code. Reading quoted strings line by line (and
  // skipping comment lines) matters: a PowerShell comment may contain an ASCII double quote, and a
  // whole-file `"([^"]*)"` scan would then treat it as a string delimiter and misalign every
  // following match - which would make these assertions test the wrong text.
  const abapOf = (block: string): string =>
    block
      .split(/\r?\n/)
      .filter((line) => !/^\s*#/.test(line))
      .flatMap((line) => {
        const first = /^\s*"([^"]*)"/.exec(line)
        return first ? [String(first[1])] : []
      })
      .join("\n")

  const arm = /"    WHEN 'RESUME_TABLE_ACTIVATION'\."([\s\S]*?)"    WHEN '/.exec(script)
  assert.ok(arm?.[1], "the DDIC resume dispatch arm must exist")
  const armAbap = abapOf(arm[1])
  assert.match(armAbap, /lv_write = 'X'\. lv_resume = 'X'\./)
  assert.doesNotMatch(
    armAbap,
    /lv_recover/,
    "resume must not enter the TBATG conversion-recovery path: activating a saved inactive definition is not a conversion recovery"
  )

  // The recovery block must stay gated on lv_recover alone, so removing that flag from resume is
  // what keeps resume out of it. If this guard were ever widened to lv_resume, resume would fall
  // back into the broken path without the dispatch assertion above noticing.
  const recoveryGuard = /"  IF lv_recover = 'X'\."([\s\S]{0,600}?)WORKLIST_REQUIRED/.exec(script)
  assert.ok(recoveryGuard?.[1], "the conversion-recovery worklist guard must exist")
  assert.doesNotMatch(abapOf(recoveryGuard[1]), /lv_resume/)

  // Resume keeps its own activation arm, which is the only path that reaches DD_TABL_ACT for it.
  const activation = /"        IF lv_resume = 'X'\."([\s\S]*?)CALL FUNCTION 'DD_TABL_ACT'/.exec(
    script
  )
  assert.ok(activation?.[1], "the resume activation arm must call DD_TABL_ACT")
  assert.match(abapOf(activation[1]), /NO_INACTIVE_VERSION/)

  // Fixing the dispatch alone was not enough, and this chain check proved it: the resume arm sat
  // behind four earlier gates in the shared write path that all assume "a write submits a new
  // definition". Each one must exempt lv_resume or the operation still cannot run.
  const body = abapOf(script)

  // 1. The state='M' read finds only an inactive version - exactly the resume case. Without this
  //    exemption the flow either refused with INACTIVE_VERSION_EXISTS or, when no version token was
  //    supplied, ran DDIF_OBJECT_DELETE and deleted the very definition being resumed.
  const inactiveOnly = /IF lv_gotstate <> 'A'\.([\s\S]*?)ELSE\./.exec(body)
  assert.ok(inactiveOnly?.[1], "the inactive-version branch must exist")
  assert.match(inactiveOnly[1], /IF lv_resume = 'X'\.\s+lv_existing = 'X'\./)
  const resumeArm = /IF lv_resume = 'X'\.([\s\S]*?)ELSE\./.exec(body)
  assert.ok(resumeArm?.[1], "the resume exemption must be the first arm of that branch")
  assert.doesNotMatch(
    resumeArm[1],
    /DDIF_OBJECT_DELETE/,
    "resume must never run the inactive-object reset: it would delete the definition being activated"
  )

  // 2-4. The three write gates that assume a new definition is being submitted.
  assert.match(
    body,
    /AND lv_settings IS INITIAL AND lv_delete IS INITIAL\s+AND lv_resume IS INITIAL\./,
    "resume does not replace an existing table, so DDIC_OBJECT_EXISTS must exempt it"
  )
  assert.match(
    body,
    /IF lv_existing = 'X' AND iv_expected_version IS INITIAL\s+AND lv_resume IS INITIAL\./,
    "resume carries no active-version token, so EXPECTED_VERSION_REQUIRED must exempt it"
  )
  assert.match(
    body,
    /IF lv_existing = 'X'\s+AND iv_expected_version <> lv_current_version\s+AND lv_resume IS INITIAL\./,
    "resume cannot satisfy the 14-character active-version token comparison, so it must exempt it"
  )

  // The resume arm must also be exempt from the "a description is required" guard, exactly like
  // recovery: neither operation sends a new definition. Asserted on the emitted ABAP lines, so the
  // generator's PowerShell comments cannot satisfy it.
  assert.match(
    body,
    /AND lv_settings IS INITIAL AND lv_recover IS INITIAL\s+AND lv_resume IS INITIAL \)\./
  )
})

test("the resume call does not send a content fingerprint as the active-version token", async () => {
  // iv_expected_version is the ACTIVE version's timestamp token (AS4DATE + AS4TIME, 14 characters).
  // A resume has no active version and this service holds a 64-hex content fingerprint, so passing
  // one as the other can only ever produce VERSION_CONFLICT - which is why the resume call sends no
  // expectedVersion at all and keeps its stale-read protection on the fingerprint gate instead.
  const tools = await readFile("src/tools.ts", "utf8")
  const call = /operation: "RESUME_TABLE_ACTIVATION"([\s\S]*?)\n    \}\)/.exec(tools)
  assert.ok(call?.[1], "the resume helper call must exist")
  // The rationale is written as comments inside the call, so they must not satisfy the assertion.
  const codeOnly = call[1]
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n")
  assert.doesNotMatch(codeOnly, /expectedVersion/)
  assert.match(codeOnly, /transportNumber: ddicTransport\(/)
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
