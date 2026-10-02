import assert from "node:assert/strict"
import test from "node:test"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"

/**
 * R7-E (2026-10-02, live w200): two DDIC text values belong to SAP, not to the request, and asserting
 * equality on them turned completed writes into failure receipts.
 *
 * 1. A table's short text is stored inside the Dictionary text field's width. The live create sent the
 *    61-character description `ORVANTA R7 temporary table-conversion acceptance object` and SAP stored
 *    the 36-character prefix `ORVANTA R7 temporary table-conversio`; the table existed and was active,
 *    but the receipt said the verification had failed.
 * 2. A field description is SAP's text for the field's data element. The live patch re-pointed PAYLOAD
 *    from CHAR10 to INT4 and SAP stored `自然数`; the expectation still held the previous data element's
 *    `字符字段长度 = 10`, so an applied and activated patch was reported as failed.
 *
 * Evidence: `.cache/r7e-state/01-E1b-create-tmp-table-create_ddic_transparent_table-2026-10-02T15-24-10-780Z.json`,
 * `01-E2-patch-payload-int4-patch_ddic_transparent_table_fields-2026-10-02T15-24-54-799Z.json` and the
 * read-backs `01-E1c-readback-table-...json` / `01-E2b-readback-after-patch-...json`.
 *
 * These tests are the drift guard in both directions: the two SAP-owned texts must not fail a write
 * that landed, and every other divergence - including a field description on a field the caller did
 * NOT re-point - must still fail.
 */

const connectionId = "w200"
const description = "ORVANTA R7 temporary table-conversion acceptance object"
const storedDescription = description.slice(0, 36)

/** SAP truncates a table short text to its own Dictionary text field width. */
class TruncatingDescriptionBackend extends MockBackend {
  override async callSapDdic(
    connectionId: string,
    request: Parameters<MockBackend["callSapDdic"]>[1]
  ) {
    const result = await super.callSapDdic(connectionId, request)
    if (
      request.operation === "CREATE_TRANSPARENT_TABLE" &&
      typeof result.header.DDTEXT === "string"
    ) {
      result.header.DDTEXT = result.header.DDTEXT.slice(0, 36)
    }
    return result
  }
}

/** SAP stores a different text than the request asked for - a real divergence, not a normalisation. */
class DivergingDescriptionBackend extends MockBackend {
  override async callSapDdic(
    connectionId: string,
    request: Parameters<MockBackend["callSapDdic"]>[1]
  ) {
    const result = await super.callSapDdic(connectionId, request)
    if (request.operation === "CREATE_TRANSPARENT_TABLE") {
      result.header.DDTEXT = "Some other table entirely"
    }
    return result
  }
}

/**
 * SAP derives a re-pointed field's description from the new data element, and leaves every other
 * field's description alone unless the fixture says otherwise.
 */
class DerivedFieldTextBackend extends MockBackend {
  constructor(
    private readonly repointedField: string,
    private readonly divergingField?: string
  ) {
    super()
  }

  override async callSapDdic(
    connectionId: string,
    request: Parameters<MockBackend["callSapDdic"]>[1]
  ) {
    const result = await super.callSapDdic(connectionId, request)
    if (request.operation !== "PATCH_TRANSPARENT_TABLE_FIELDS") return result
    for (const field of result.fields ?? []) {
      if (field.FIELDNAME === this.repointedField) field.DDTEXT = "Natural number"
      if (this.divergingField && field.FIELDNAME === this.divergingField) {
        field.DDTEXT = "Diverged text"
      }
    }
    return result
  }
}

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    connectionId,
    objectName: "ZCMCP_TAB_FIDEL",
    description,
    deliveryClass: "A" as const,
    dataClass: "APPL0" as const,
    dataBrowserMaintenance: "allowed" as const,
    sizeCategory: 0,
    fields: [
      { name: "MANDT", dataElement: "MANDT", key: true },
      { name: "ID", dataElement: "CHAR10", key: true },
      { name: "PAYLOAD", dataElement: "CHAR10" }
    ],
    packageName: "ZABAP",
    transportNumber: "GR2K923472",
    ...overrides
  } as never
}

async function patchInput(service: ToolService, changes: unknown[]) {
  const read = JSON.parse(
    await service.readDdicTransparentTable({ connectionId, objectName: "ZCMCP_COMPLEX" })
  ) as { version: string; fingerprint: string }
  return {
    connectionId,
    objectName: "ZCMCP_COMPLEX",
    expectedVersion: read.version,
    expectedFingerprint: read.fingerprint,
    changes,
    packageName: "ZABAP",
    transportNumber: "GR2K923472",
    confirmation: "DESTRUCTIVE_SCHEMA_CHANGE",
    acknowledgeDataLoss: true
  } as never
}

test("a create whose short text SAP truncates is not reported as a failed verification", async () => {
  const service = new ToolService(new TruncatingDescriptionBackend())
  const created = JSON.parse(await service.createDdicTransparentTable(createInput())) as {
    definition: { description: string }
  }
  // The receipt reports what SAP stored, so the caller can see the normalisation instead of guessing.
  assert.equal(created.definition.description, storedDescription)
  assert.equal(created.definition.description.length, 36)
})

test("a patch that re-points a field at another data element is not failed by the derived text", async () => {
  const service = new ToolService(new DerivedFieldTextBackend("DIRECT_VALUE"))
  const result = JSON.parse(
    await service.patchDdicTransparentTableFields(
      await patchInput(service, [
        { action: "update", fieldName: "DIRECT_VALUE", dataElement: "CHAR40" }
      ])
    )
  ) as { definition: { fields: Array<{ name: string; dataElement: string; description: string }> } }
  const field = result.definition.fields.find((entry) => entry.name === "DIRECT_VALUE")
  assert.equal(field?.dataElement, "CHAR40")
  assert.equal(field?.description, "Natural number")
})

test("a create whose short text really differs still fails and names the surviving object", async () => {
  const service = new ToolService(new DivergingDescriptionBackend())
  await assert.rejects(service.createDdicTransparentTable(createInput()), (error: unknown) => {
    const message = String((error as Error).message)
    assert.match(message, /did not return the requested active definition/)
    assert.match(message, /definition\.description/)
    // The write landed; the receipt must name what is left on the target instead of only failing.
    assert.match(message, /exists on the target and was not rolled back/)
    assert.match(message, /active version \d{14} in package ZABAP with recorded request GR2K923472/)
    return true
  })
})

test("a field description the caller did not re-point is still verified exactly", async () => {
  const service = new ToolService(new DerivedFieldTextBackend("DIRECT_VALUE", "ID"))
  await assert.rejects(
    service.patchDdicTransparentTableFields(
      await patchInput(service, [
        { action: "update", fieldName: "DIRECT_VALUE", dataElement: "CHAR40" }
      ])
    ),
    /definition\.fields\[0\]\.description/
  )
})
