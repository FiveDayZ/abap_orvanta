import assert from "node:assert/strict"
import test from "node:test"
import {
  ALLOWLIST_MAX_ROWS,
  ALLOWLIST_TIMEOUT_MS,
  TABLE_NOT_ALLOWED,
  TABLE_NEVER_ALLOWED,
  TABLE_PENDING_APPROVAL,
  TABLE_TIERS,
  assertTableAllowed,
  describeAllowlistRejection,
  isTableAllowed,
  listAllowedTables,
  normalizeAllowlistTableName
} from "../src/table-allowlist.js"

// D5-2 ruling W1/W2/W3: the allowlist is default-deny and also governs the existing
// read_abap_table path. These tests pin the ruling itself, not just the mechanics.

test("every registered tier entry is allowed", () => {
  const registered = [
    ...TABLE_TIERS.metadata,
    ...TABLE_TIERS.customizing,
    ...TABLE_TIERS.business,
    ...TABLE_TIERS.productRequired,
    ...TABLE_TIERS.indirectFormatReads
  ]
  assert.ok(registered.length > 0, "allowlist must not be empty")
  for (const name of registered) assert.equal(isTableAllowed(name), true, `${name} must be allowed`)
})

test("sensitive tables are never allowed and are named as such", () => {
  for (const name of TABLE_NEVER_ALLOWED) {
    assert.equal(isTableAllowed(name), false, `${name} must never be allowed`)
    assert.equal(
      describeAllowlistRejection(name),
      "never_allowed",
      `${name} must be classified as never_allowed`
    )
    assert.throws(() => assertTableAllowed(name), new RegExp(`^Error: ${TABLE_NOT_ALLOWED}:`))
  }
})

test("tables that are collected but not individually approved are rejected distinctly", () => {
  for (const name of TABLE_PENDING_APPROVAL) {
    assert.equal(isTableAllowed(name), false, `${name} must not be allowed yet`)
    assert.equal(describeAllowlistRejection(name), "pending_approval")
  }
})

test("ruling W2: KNA1 and LFA1 stay out of the allowlist", () => {
  for (const name of ["KNA1", "LFA1"]) {
    assert.equal(isTableAllowed(name), false, `${name} must not be allowed`)
    assert.notEqual(describeAllowlistRejection(name), null)
  }
})

test("default deny: an unknown table name is rejected", () => {
  assert.equal(isTableAllowed("ZZZ_UNKNOWN_TABLE"), false)
  assert.equal(describeAllowlistRejection("ZZZ_UNKNOWN_TABLE"), "not_allowlisted")
  assert.throws(() => assertTableAllowed("ZZZ_UNKNOWN_TABLE"), /TABLE_NOT_ALLOWED/)
})

test("lookup normalizes case and surrounding whitespace", () => {
  assert.equal(normalizeAllowlistTableName("  tfdirlike  "), "TFDIRLIKE")
  assert.equal(isTableAllowed("  t000 "), true)
  assert.equal(describeAllowlistRejection("usr02"), "never_allowed")
})

test("the allowlist snapshot is sorted and free of duplicates", () => {
  const listed = listAllowedTables()
  assert.deepEqual(listed, [...listed].sort())
  assert.equal(new Set(listed).size, listed.length)
})

test("ruling W4: row and timeout limits are the agreed values", () => {
  assert.equal(ALLOWLIST_MAX_ROWS, 500)
  assert.equal(ALLOWLIST_TIMEOUT_MS, 30_000)
})

test("ruling W3: read_abap_table rejects a sensitive table before touching SAP", async () => {
  const { readAbapTable } = await import("../src/table-query.js")
  let backendTouched = false
  const backend = {
    runQuery: async () => {
      backendTouched = true
      throw new Error("backend must not be reached")
    },
    callRemoteFunction: async () => {
      backendTouched = true
      throw new Error("backend must not be reached")
    }
  }
  await assert.rejects(
    () =>
      readAbapTable(
        { connectionId: "w200", tableName: "USR02", columns: ["BNAME"], maxRows: 1 },
        backend as never,
        async () => ({}),
        async () => ({})
      ),
    /TABLE_NOT_ALLOWED/
  )
  assert.equal(backendTouched, false, "a rejected table must never reach the backend")
})

// D-6: E07T was missing while E070/E071 were registered, so a request number could be read back
// but its short text could not - the one human-meaningful key when several requests exist.
test("D-6: the CTS text table E07T is registered beside E070 and E071", () => {
  for (const name of ["E070", "E071", "E07T"]) {
    assert.equal(isTableAllowed(name), true, `${name} must be allowed`)
    assert.equal(describeAllowlistRejection(name), null)
  }
  assert.ok(
    (TABLE_TIERS.metadata as readonly string[]).includes("E07T"),
    "E07T belongs to the metadata tier"
  )
})

test("D-6: E07T is neither sensitive nor pending approval", () => {
  assert.equal((TABLE_NEVER_ALLOWED as readonly string[]).includes("E07T"), false)
  assert.equal((TABLE_PENDING_APPROVAL as readonly string[]).includes("E07T"), false)
})

// D010INC is SAP's include directory. Registered 2026-09-26 with explicit user authorisation to
// replace the `/includes/<name>/mainprograms` resource this release does not implement, because ADT
// refuses to activate an include whose registered main program it cannot match. It is the only read
// path on this release that publishes that relation - the inactive inventory leaves an include's
// `parentObject` empty (w200, 2026-09-26 09:30). Pinned so a removal is deliberate and visible.
test("the include directory D010INC is registered as pure repository metadata", () => {
  assert.equal(isTableAllowed("D010INC"), true)
  assert.equal(describeAllowlistRejection("D010INC"), null)
  assert.ok(
    (TABLE_TIERS.metadata as readonly string[]).includes("D010INC"),
    "D010INC belongs to the metadata tier"
  )
  assert.equal((TABLE_NEVER_ALLOWED as readonly string[]).includes("D010INC"), false)
  assert.equal((TABLE_PENDING_APPROVAL as readonly string[]).includes("D010INC"), false)
})

// D7 spec §8.2: the helper already reads the SmartStyle, SAPscript and Adobe format tables inside
// ABAP. Registering them makes that existing read path auditable instead of invisible; it does not
// add a capability. The tier is pinned so a later removal is a deliberate, visible change.
test("D7 §8.2: the indirectly read form and text tables are registered", () => {
  const expected = [
    "STXSHEAD",
    "STXSPARA",
    "STXSCHAR",
    "STXSTAB",
    "STXH",
    "STXL",
    "FPLAYOUT",
    "FPLAYOUTT",
    "FPINTERFACE",
    "FPINTERFACET"
  ]
  assert.deepEqual([...TABLE_TIERS.indirectFormatReads].sort(), [...expected].sort())
  for (const name of expected) {
    assert.equal(isTableAllowed(name), true, `${name} must be allowed`)
    assert.equal(describeAllowlistRejection(name), null)
  }
})

test("D7 §8.2: registering the format tables does not widen the sensitive tier", () => {
  for (const name of TABLE_TIERS.indirectFormatReads) {
    assert.equal(
      (TABLE_NEVER_ALLOWED as readonly string[]).includes(name),
      false,
      `${name} must not be in the never-allowed tier`
    )
    assert.equal(
      (TABLE_PENDING_APPROVAL as readonly string[]).includes(name),
      false,
      `${name} must not be in the pending-approval tier`
    )
  }
})
