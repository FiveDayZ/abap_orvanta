import assert from "node:assert/strict"
import test from "node:test"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"

/**
 * D8-1: the Include/Append layout of a transparent table.
 *
 * The fixture `ZCMCP_COMPLEX` is a table that keeps its own direct fields between two components:
 *
 *   ID (direct key) | .INCLUDE -> ZCMCP_INC | INC_VALUE (inline copy) | DIRECT_VALUE (direct)
 *   | .INCLU--AP -> ZCMCP_APPEND | APP_VALUE (inline copy)
 *
 * `INC_VALUE` and `APP_VALUE` are verbatim copies of fields whose own definition lives under
 * `ZCMCP_INC` / `ZCMCP_APPEND`. Writing the table's row set does not write those components, so a
 * change aimed at them must be refused by name instead of being reported as "does not exist".
 */
const connectionId = "w200"
const objectName = "ZCMCP_COMPLEX"

async function readIdentity(service: ToolService) {
  const read = JSON.parse(await service.readDdicTransparentTable({ connectionId, objectName })) as {
    version: string
    fingerprint: string
  }
  assert.match(read.version, /^\d{14}$/)
  assert.match(read.fingerprint, /^[a-f0-9]{64}$/)
  return read
}

function patchInput(version: string, fingerprint: string, changes: unknown[]) {
  return {
    connectionId,
    objectName,
    expectedVersion: version,
    expectedFingerprint: fingerprint,
    changes: changes as never,
    packageName: "ZABAP",
    transportNumber: "GR2K923427",
    confirmation: "DESTRUCTIVE_SCHEMA_CHANGE",
    acknowledgeDataLoss: true
  } as never
}

test("a direct field of a table with components is patchable and the components are declared", async () => {
  const backend = new MockBackend()
  const service = new ToolService(backend)
  const { version, fingerprint } = await readIdentity(service)
  const result = JSON.parse(
    await service.patchDdicTransparentTableFields(
      patchInput(version, fingerprint, [
        { action: "update", fieldName: "DIRECT_VALUE", dataElement: "CHAR40" }
      ])
    )
  ) as { layoutComponents?: string[] }
  assert.deepEqual(result.layoutComponents, ["ZCMCP_INC", "ZCMCP_APPEND"])
})

test("a component-owned field is refused by name, before any write is attempted", async () => {
  const backend = new MockBackend()
  const writes: string[] = []
  const original = backend.callSapDdic.bind(backend)
  backend.callSapDdic = async (id, request) => {
    if (request.operation === "PATCH_TRANSPARENT_TABLE_FIELDS") writes.push(request.operation)
    return original(id, request)
  }
  const service = new ToolService(backend)
  const { version, fingerprint } = await readIdentity(service)
  for (const fieldName of ["INC_VALUE", "APP_VALUE"]) {
    await assert.rejects(
      service.patchDdicTransparentTableFields(
        patchInput(version, fingerprint, [{ action: "update", fieldName, dataElement: "CHAR40" }])
      ),
      new RegExp(
        `COMPONENT_FIELD_NOT_PATCHABLE: ${fieldName} belongs to an Include/Append component`
      )
    )
  }
  assert.deepEqual(writes, [])
})

test("renaming a direct field onto a component field name is refused", async () => {
  const backend = new MockBackend()
  const service = new ToolService(backend)
  const { version, fingerprint } = await readIdentity(service)
  await assert.rejects(
    service.patchDdicTransparentTableFields(
      patchInput(version, fingerprint, [
        { action: "rename", fieldName: "DIRECT_VALUE", newName: "APP_VALUE" }
      ])
    ),
    /Transparent table field already exists: APP_VALUE/
  )
})

test("appending a direct field declares the components it preserved", async () => {
  const backend = new MockBackend()
  const service = new ToolService(backend)
  const { version, fingerprint } = await readIdentity(service)
  const result = JSON.parse(
    await service.appendDdicTransparentTableFields({
      connectionId,
      objectName,
      expectedVersion: version,
      expectedFingerprint: fingerprint,
      fields: [{ name: "NEW_DIRECT", dataElement: "CHAR20" }],
      packageName: "ZABAP",
      transportNumber: "GR2K923427"
    } as never)
  ) as { layoutComponents?: string[] }
  assert.deepEqual(result.layoutComponents, ["ZCMCP_INC", "ZCMCP_APPEND"])
})

test("a direct field without an active data element is reported as not editable", async () => {
  const backend = new MockBackend()
  const service = new ToolService(backend)
  const read = JSON.parse(
    await service.readDdicTransparentTable({ connectionId, objectName: "ZCMCP_TYPED" })
  ) as { version: string; fingerprint: string }
  await assert.rejects(
    service.patchDdicTransparentTableFields({
      ...(patchInput(read.version, read.fingerprint, [
        { action: "update", fieldName: "RAW_TEXT", dataElement: "CHAR40" }
      ]) as Record<string, unknown>),
      objectName: "ZCMCP_TYPED"
    } as never),
    /FIELD_NOT_EDITABLE: RAW_TEXT exists in the layout/
  )
})

test("a table without components reports no layout components", async () => {
  const backend = new MockBackend()
  const service = new ToolService(backend)
  const read = JSON.parse(
    await service.readDdicTransparentTable({ connectionId, objectName: "ZCMCP_CONV" })
  ) as { version: string; fingerprint: string }
  const result = JSON.parse(
    await service.patchDdicTransparentTableFields({
      ...(patchInput(read.version, read.fingerprint, [
        { action: "update", fieldName: "ID", dataElement: "CHAR40" }
      ]) as Record<string, unknown>),
      objectName: "ZCMCP_CONV"
    } as never)
  ) as { layoutComponents?: string[] }
  assert.equal(result.layoutComponents, undefined)
})
