import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { z } from "zod"
import { toolContracts } from "../src/contracts.js"

/**
 * DD03P-REFTABLE/REFFIELD - the reference table and field of a quantity (QUAN) or currency (CURR)
 * component - is written by the service and by the deployed helper, and each side owns half of the
 * rule. The 2026-09-25 defect was that the two halves did not meet: the helper's generic field-row
 * arm allowed the pair for transparent tables only, and the service's structure shapes had no such
 * properties at all, so an activatable quantity component could not be expressed in a structure.
 *
 * This suite is the drift guard. It reads the generator script because that script is the only
 * source of the deployed helper: a helper that accepts the pair but never publishes it on a read
 * lets patch/append drop it (DDIF_TABL_PUT replaces the whole field row set), and a service shape
 * without the properties is what stops a caller asking for it in the first place. Either half
 * changing alone must fail here.
 */
const SCRIPT = "scripts/bootstrap-sap-helper.ps1"

/**
 * The emitted ABAP of a generator block, comment lines skipped.
 *
 * Reading quoted strings line by line matters: a PowerShell comment may contain an ASCII double
 * quote, so a whole-file `"([^"]*)"` scan would treat it as a delimiter and misalign every following
 * match, which would make these assertions test the wrong text.
 */
function abapOf(block: string): string {
  return block
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .flatMap((line) => {
      const first = /^\s*"([^"]*)"/.exec(line)
      return first ? [String(first[1])] : []
    })
    .join("\n")
}

function emittedLines(script: string, pattern: RegExp): string[] {
  return [...script.matchAll(pattern)].map((match) => String(match[0]))
}

test("the helper allows the reference pair on structure field rows, not only on table rows", async () => {
  const script = await readFile(SCRIPT, "utf8")
  const start = script.indexOf(`"          IF lv_property <> 'FIELDNAME'",`)
  assert.ok(start >= 0, "the generic field-property guard must exist")
  const rejectedAt = script.indexOf("PROPERTY_NOT_ALLOWED", start)
  assert.ok(rejectedAt > start, "the guard must keep rejecting unknown properties")
  const guard = abapOf(script.slice(start, rejectedAt))

  const pairAt = guard.indexOf("lv_property <> 'REFTABLE'")
  assert.ok(pairAt >= 0, "REFTABLE must be an allowed field property")
  assert.ok(
    guard.includes("lv_property <> 'REFFIELD'"),
    "REFFIELD must be an allowed field property"
  )
  // ... and it must sit OUTSIDE the table-only group. Inside it, a structure component is rejected
  // with PROPERTY_NOT_ALLOWED, which is exactly the defect this guards: the write is expressible in
  // SE11, needed by activation, and refused by the helper.
  const tableOnlyAt = guard.indexOf("lv_object_type <> 'TABL'")
  assert.ok(tableOnlyAt > pairAt, "the reference pair must be allowed for STRU as well as TABL")
  assert.ok(
    guard.indexOf("lv_property <> 'REFFIELD'") < tableOnlyAt,
    "the reference pair must be allowed for STRU as well as TABL"
  )
  // The remaining properties stay table-only: a structure has no key and no NOT NULL semantics.
  for (const property of ["KEYFLAG", "NOTNULL"]) {
    assert.ok(
      guard.indexOf(`lv_property <> '${property}'`) > tableOnlyAt,
      `${property} must stay a table-only field property`
    )
  }
})

test("the helper publishes the reference pair on every DDIC field read", async () => {
  const script = await readFile(SCRIPT, "utf8")
  // The active read arms: one LOOP over DD03P for structures and one for transparent tables. Both
  // must publish the pair, because both definitions are what a caller reads back before rewriting
  // the whole row set.
  const activeReads = emittedLines(
    script,
    // The ABAP text inside the PowerShell string carries its own indentation, so the match allows
    // for it rather than anchoring on the opening quote.
    /"\s*add_payload 'F' lv_index 'REFTABLE' ls_dd03p-reftable\."/g
  )
  assert.equal(
    activeReads.length,
    2,
    "the structure read and the transparent-table read must each publish REFTABLE"
  )
  assert.equal(
    emittedLines(script, /"\s*add_payload 'F' lv_index 'REFFIELD' ls_dd03p-reffield\."/g).length,
    2,
    "the structure read and the transparent-table read must each publish REFFIELD"
  )
  // The inactive arm builds the same rows from state = 'M' and must agree, or the two definitions a
  // caller can compare would be equal by construction on exactly the fields that differ.
  assert.equal(
    emittedLines(script, /"\s*add_payload 'F' lv_index 'REFTABLE' <ls_field>-reftable\."/g).length,
    1,
    "the inactive definition arm must publish REFTABLE"
  )
  assert.equal(
    emittedLines(script, /"\s*add_payload 'F' lv_index 'REFFIELD' <ls_field>-reffield\."/g).length,
    1,
    "the inactive definition arm must publish REFFIELD"
  )
})

test("the append structure arm keeps accepting the reference pair on its own row kind", async () => {
  const script = await readFile(SCRIPT, "utf8")
  const rejectedAt = script.indexOf("'Append field property not allowed'")
  assert.ok(rejectedAt > 0, "the append field-property guard must exist")
  const start = script.lastIndexOf("IF lv_ap_property <> 'FIELDNAME'", rejectedAt)
  assert.ok(start >= 0 && start < rejectedAt, "the append property whitelist must exist")
  const guard = abapOf(script.slice(start, rejectedAt))
  // Append structures take their rows through their own arm (A1), which never reaches the generic
  // guard above, so this is a second place the same rule lives.
  assert.ok(guard.includes("lv_ap_property <> 'REFTABLE'"), "append rows must accept REFTABLE")
  assert.ok(guard.includes("lv_ap_property <> 'REFFIELD'"), "append rows must accept REFFIELD")
})

test("every space that writes a DD03P field row accepts the reference pair", () => {
  // The service half of the rule: the same schema property pair on each tool that writes field rows.
  // zod parses here rather than shape introspection, so a property that is present but unusable
  // (for example one that a stricter wrapper drops) fails the guard too.
  const writeInput = {
    packageName: "ZABAP",
    transportNumber: "GR2K923421",
    connectionId: "w200"
  }
  const component = {
    name: "QTY",
    dataElement: "MENGE_D",
    referenceTable: "MARA",
    referenceField: "MEINS"
  }

  // Every contract supplies a raw Zod shape and mcp.ts wraps it in a strict object before
  // registering the tool, so the guard registers it the same way. The strictness is the point: a
  // non-strict parse would accept and strip an undeclared referenceTable, which is exactly how the
  // property went missing from the structure schemas without anyone noticing.
  const validate = (schema: unknown, input: unknown) =>
    z
      .object(schema as z.ZodRawShape)
      .strict()
      .parse(input)

  validate(toolContracts.create_ddic_transparent_table.inputSchema, {
    ...writeInput,
    objectName: "ZCMCP_TAB_REF",
    description: "reference probe",
    deliveryClass: "A",
    dataClass: "APPL1",
    dataBrowserMaintenance: "notAllowed",
    fields: [{ name: "MANDT", dataElement: "MANDT", key: true }, component]
  })
  validate(toolContracts.upsert_ddic_structure.inputSchema, {
    ...writeInput,
    objectName: "ZCMCP_STRU_REF",
    description: "reference probe",
    fields: [{ name: "MATNR", dataElement: "MATNR" }, component]
  })
  validate(toolContracts.upsert_append_structure_fields.inputSchema, {
    connectionId: "w200",
    objectName: "ZCMCP_APPEND_REF",
    fields: [component],
    expectedVersion: "20260831120000"
  })
  validate(toolContracts.append_ddic_transparent_table_fields.inputSchema, {
    ...writeInput,
    objectName: "ZCMCP_TAB_REF",
    fields: [component],
    expectedVersion: "20260831120000",
    expectedFingerprint: "a".repeat(64)
  })
  validate(toolContracts.patch_ddic_transparent_table_fields.inputSchema, {
    ...writeInput,
    objectName: "ZCMCP_TAB_REF",
    expectedVersion: "20260831120000",
    expectedFingerprint: "a".repeat(64),
    changes: [
      { action: "update", fieldName: "QTY", referenceTable: "MARA", referenceField: "MEINS" }
    ],
    confirmation: "DESTRUCTIVE_SCHEMA_CHANGE",
    acknowledgeDataLoss: true
  })
})
