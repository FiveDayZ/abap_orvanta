import { randomUUID } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const endpoint = new URL(process.env.ABAP_MCP_ENDPOINT || "http://127.0.0.1:4847/mcp")
const connectionId = required("ABAP_MCP_CONNECTION").toLowerCase()
const tableName = required("ABAP_MCP_DDIC_TABLE")
const initialDataElement = required("ABAP_MCP_DDIC_INITIAL_DATA_ELEMENT")
const replacementDataElement = required("ABAP_MCP_DDIC_REPLACEMENT_DATA_ELEMENT")
const packageName = required("ABAP_MCP_PACKAGE")
const transportNumber = required("ABAP_MCP_TRANSPORT")
const client = new Client({ name: "w200-ddic-table-lifecycle-validation", version: "0.34.0" })
const evidence = {
  productVersion: "0.34.0",
  endpoint: endpoint.href,
  connectionId,
  target: { tableName, initialDataElement, replacementDataElement, packageName, transportNumber },
  status: "failed",
  cleanupComplete: false,
  businessDataWritten: false,
  transportReleased: false
}
let tableCreated = false

if (process.env.ABAP_MCP_DDIC_DESTRUCTIVE_ACCEPTED !== "1") {
  throw new Error("ABAP_MCP_DDIC_DESTRUCTIVE_ACCEPTED=1 is required")
}

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value.toUpperCase()
}

function text(result) {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

function businessText(value) {
  return value.split("\nOperation Receipt\n", 1)[0].trim()
}

async function call(name, args, expectError = false) {
  const result = await client.callTool({ name, arguments: { connectionId, ...args } })
  const body = text(result)
  if (Boolean(result.isError) !== expectError) throw new Error(`${name}: ${body}`)
  return body
}

function parse(value) {
  return JSON.parse(businessText(value))
}

function operationId(action) {
  return `d340-${action}-${randomUUID()}`
}

async function readTable(expectMissing = false) {
  const result = await client.callTool({
    name: "read_ddic_transparent_table",
    arguments: { objectName: tableName, connectionId }
  })
  const body = text(result)
  if (expectMissing) {
    if (!result.isError || !/DDIC_OBJECT_NOT_FOUND|does not exist/i.test(body)) {
      throw new Error(`Could not prove ${tableName} is absent: ${body}`)
    }
    return null
  }
  if (result.isError) throw new Error(`read_ddic_transparent_table: ${body}`)
  return JSON.parse(body)
}

function settings(definition) {
  const { fields, ...rest } = definition
  return rest
}

async function deleteTable(cleanup) {
  const current = await readTable()
  const deleted = parse(
    await call("delete_ddic_object", {
      operationId: operationId(cleanup ? "cleanup" : "delete"),
      objectType: "TABL",
      objectName: tableName,
      expectedVersion: current.version,
      packageName,
      transportNumber,
      confirmation: "PERMANENT_DELETE",
      acknowledgeDataLoss: true
    })
  )
  if (!deleted.absenceVerified || deleted.operationReceipt?.status !== "completed") {
    throw new Error("Transparent-table deletion did not return verified absence and a receipt")
  }
  await readTable(true)
  tableCreated = false
  return deleted
}

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint))
  const capability = JSON.parse(await call("get_capability_report", {}))
  const ddicHelper = capability.helpers?.find((helper) => helper.name === "ddic")
  if (ddicHelper?.availability !== "available" || ddicHelper.protocolVersion !== "1.6") {
    throw new Error(
      `DDIC helper 1.6 is required; observed ${ddicHelper?.protocolVersion || "none"}`
    )
  }
  await readTable(true)
  for (const dataElement of [initialDataElement, replacementDataElement]) {
    const observed = JSON.parse(await call("read_ddic_data_element", { objectName: dataElement }))
    if (observed.objectName !== dataElement) {
      throw new Error(`Active data element verification failed: ${dataElement}`)
    }
  }

  const created = parse(
    await call("create_ddic_transparent_table", {
      operationId: operationId("create"),
      objectName: tableName,
      description: "Codex MCP 0.34 lifecycle validation",
      deliveryClass: "A",
      dataClass: "APPL0",
      dataBrowserMaintenance: "notAllowed",
      sizeCategory: 0,
      fields: [
        { name: "MANDT", dataElement: "MANDT", key: true },
        { name: "VALUE", dataElement: initialDataElement },
        { name: "REMOVE_ME", dataElement: initialDataElement }
      ],
      packageName,
      transportNumber
    })
  )
  if (created.operationReceipt?.status !== "completed") {
    throw new Error("Transparent-table creation receipt is incomplete")
  }
  tableCreated = true

  const beforeAppend = await readTable()
  const appended = parse(
    await call("append_ddic_transparent_table_fields", {
      operationId: operationId("append"),
      objectName: tableName,
      expectedVersion: beforeAppend.version,
      expectedFingerprint: beforeAppend.fingerprint,
      fields: [{ name: "RENAME_ME", dataElement: initialDataElement }],
      packageName,
      transportNumber
    })
  )
  if (appended.operationReceipt?.status !== "completed") {
    throw new Error("Transparent-table append receipt is incomplete")
  }
  const beforePatch = await readTable()
  const stale = await call(
    "patch_ddic_transparent_table_fields",
    {
      operationId: operationId("stale"),
      objectName: tableName,
      expectedVersion: beforeAppend.version,
      expectedFingerprint: beforeAppend.fingerprint,
      changes: [{ action: "rename", fieldName: "RENAME_ME", newName: "RENAMED" }],
      packageName,
      transportNumber,
      confirmation: "DESTRUCTIVE_SCHEMA_CHANGE",
      acknowledgeDataLoss: true
    },
    true
  )
  if (!/VERSION_CONFLICT|FINGERPRINT_CONFLICT/.test(stale)) {
    throw new Error("Stale transparent-table patch was not rejected")
  }

  const patched = parse(
    await call("patch_ddic_transparent_table_fields", {
      operationId: operationId("patch"),
      objectName: tableName,
      expectedVersion: beforePatch.version,
      expectedFingerprint: beforePatch.fingerprint,
      changes: [
        { action: "remove", fieldName: "REMOVE_ME" },
        { action: "rename", fieldName: "RENAME_ME", newName: "RENAMED" },
        {
          action: "update",
          fieldName: "RENAMED",
          dataElement: replacementDataElement,
          notNull: true
        },
        { action: "update", fieldName: "VALUE", key: true }
      ],
      packageName,
      transportNumber,
      confirmation: "DESTRUCTIVE_SCHEMA_CHANGE",
      acknowledgeDataLoss: true
    })
  )
  if (patched.operationReceipt?.status !== "completed") {
    throw new Error("Transparent-table patch receipt is incomplete")
  }
  const afterPatch = await readTable()
  if (
    JSON.stringify(settings(afterPatch.definition)) !==
    JSON.stringify(settings(beforePatch.definition))
  ) {
    throw new Error("Transparent-table settings changed during field patch")
  }
  const fields = afterPatch.definition.fields
  if (
    fields.length !== 3 ||
    fields[0]?.name !== "MANDT" ||
    fields[1]?.name !== "VALUE" ||
    fields[1]?.key !== true ||
    fields[2]?.name !== "RENAMED" ||
    fields[2]?.dataElement !== replacementDataElement ||
    fields[2]?.notNull !== true
  ) {
    throw new Error("Field remove, rename, key, type, or nullability readback is incorrect")
  }

  const deleted = await deleteTable(false)
  evidence.status = "passed"
  evidence.cleanupComplete = true
  evidence.helperVersion = ddicHelper.protocolVersion
  evidence.beforePatch = { version: beforePatch.version, fingerprint: beforePatch.fingerprint }
  evidence.afterPatch = {
    version: afterPatch.version,
    fingerprint: afterPatch.fingerprint,
    fields
  }
  evidence.receipts = {
    create: created.operationReceipt,
    append: appended.operationReceipt,
    patch: patched.operationReceipt,
    delete: deleted.operationReceipt
  }
  evidence.staleGuard = "passed"
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  if (tableCreated) {
    try {
      evidence.cleanup = await deleteTable(true)
      evidence.cleanupComplete = true
    } catch (error) {
      evidence.cleanup = { status: "failed", error: String(error) }
      evidence.cleanupComplete = false
      process.exitCode = 1
    }
  }
  await client.close().catch(() => undefined)
  console.log(JSON.stringify(evidence, null, 2))
}
