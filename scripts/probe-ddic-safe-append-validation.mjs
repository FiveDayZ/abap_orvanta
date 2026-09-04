import { randomUUID } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const endpoint = new URL(process.env.ABAP_MCP_ENDPOINT || "http://127.0.0.1:4847/mcp")
const connectionId = (process.env.ABAP_MCP_CONNECTION || "w200").toLowerCase()
const tableName = required("ABAP_MCP_DDIC_TABLE")
const fieldName = required("ABAP_MCP_DDIC_FIELD")
const dataElement = required("ABAP_MCP_DDIC_DATA_ELEMENT")
const initialDataElement = (process.env.ABAP_MCP_DDIC_INITIAL_DATA_ELEMENT || "BAPI_MSG")
  .trim()
  .toUpperCase()
const packageName = required("ABAP_MCP_PACKAGE")
const transportNumber = required("ABAP_MCP_TRANSPORT")
const createValidationTable = process.env.ABAP_MCP_DDIC_CREATE_VALIDATION_TABLE === "1"
const resumeValidation = process.env.ABAP_MCP_DDIC_RESUME_VALIDATION === "1"
const verifyAbsent = process.env.ABAP_MCP_DDIC_VERIFY_ABSENT === "1"
const previousVersion = resumeValidation ? required("ABAP_MCP_DDIC_PREVIOUS_VERSION") : ""
const previousFingerprint = resumeValidation
  ? required("ABAP_MCP_DDIC_PREVIOUS_FINGERPRINT").toLowerCase()
  : ""
const client = new Client({ name: "w200-ddic-safe-append-validation", version: "0.33.0" })
const evidence = {
  productVersion: "0.33.0",
  endpoint: endpoint.href,
  connectionId,
  target: { tableName, fieldName, dataElement, packageName, transportNumber },
  status: "failed",
  cleanup: "not-applicable-change-retained"
}

if (process.env.ABAP_MCP_DDIC_APPEND_ACCEPTED !== "1") {
  throw new Error("ABAP_MCP_DDIC_APPEND_ACCEPTED=1 is required")
}

function required(name) {
  const value = process.env[name]?.trim().toUpperCase()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function text(result) {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

async function call(name, args, expectError = false) {
  const result = await client.callTool({ name, arguments: args })
  const body = text(result)
  if (Boolean(result.isError) !== expectError) {
    throw new Error(`${name}: ${body}`)
  }
  return body
}

async function readTable() {
  const result = await client.callTool({
    name: "read_ddic_transparent_table",
    arguments: { objectName: tableName, connectionId }
  })
  return { result, body: text(result) }
}

function stableTableSettings(definition) {
  const { fields, ...settings } = definition
  return settings
}

function expectedValidationBaseline() {
  return {
    settings: {
      description: "Codex MCP 0.33 validation",
      tableClass: "TRANSP",
      deliveryClass: "A",
      dataBrowserMaintenance: "notAllowed",
      sizeCategory: 0,
      dataClass: "APPL0",
      buffering: "notAllowed"
    },
    fields: [
      {
        name: "MANDT",
        position: 1,
        dataElement: "MANDT",
        description: "Client",
        key: true,
        notNull: true
      },
      {
        name: "VALUE",
        position: 2,
        dataElement: initialDataElement,
        description: "Message Text",
        key: false,
        notNull: true
      }
    ]
  }
}

try {
  validation: {
    await client.connect(new StreamableHTTPClientTransport(endpoint))
    if (verifyAbsent) {
      const current = await readTable()
      if (!current.result.isError) {
        throw new Error(`${tableName} still exists after manual cleanup`)
      }
      if (!/DDIC_OBJECT_NOT_FOUND|does not exist/i.test(current.body)) {
        throw new Error(`Could not prove ${tableName} is absent: ${current.body}`)
      }
      evidence.status = "passed"
      evidence.cleanup = "confirmed-absent"
      evidence.sapWritesInvoked = false
      break validation
    }
    if (createValidationTable) {
      const current = await readTable()
      if (!current.result.isError) {
        throw new Error(`${tableName} already exists; refusing to overwrite it`)
      }
      if (!/DDIC_OBJECT_NOT_FOUND|does not exist/i.test(current.body)) {
        throw new Error(`Could not prove ${tableName} is absent: ${current.body}`)
      }
      const initialDataElementRead = JSON.parse(
        await call("read_ddic_data_element", {
          objectName: initialDataElement,
          connectionId
        })
      )
      if (initialDataElementRead.objectName !== initialDataElement) {
        throw new Error(`Active data element verification failed: ${initialDataElement}`)
      }
      const created = JSON.parse(
        await call("create_ddic_transparent_table", {
          operationId: `ddic-create-${randomUUID()}`,
          objectName: tableName,
          description: "Codex MCP 0.33 validation",
          deliveryClass: "A",
          dataClass: "APPL0",
          dataBrowserMaintenance: "notAllowed",
          sizeCategory: 0,
          fields: [
            { name: "MANDT", dataElement: "MANDT", key: true },
            { name: "VALUE", dataElement: initialDataElement }
          ],
          packageName,
          transportNumber,
          connectionId
        })
      )
      if (
        created.operationReceipt?.version !== 2 ||
        created.operationReceipt?.status !== "completed"
      ) {
        throw new Error("Validation-table creation did not return a completed version 2 receipt")
      }
      evidence.preparation = {
        status: "created",
        definition: created.definition,
        receipt: created.operationReceipt
      }
    }
    const before = JSON.parse(
      await call("read_ddic_transparent_table", { objectName: tableName, connectionId })
    )
    if (before.packageName !== packageName) throw new Error("Table package does not match approval")
    const fieldAlreadyExists = before.definition.fields.some((field) => field.name === fieldName)
    if (fieldAlreadyExists && !resumeValidation) {
      throw new Error(`${tableName}-${fieldName} already exists; refusing to overwrite it`)
    }

    let appended
    let after
    if (resumeValidation) {
      if (!fieldAlreadyExists) {
        throw new Error(`${tableName}-${fieldName} is missing; resume mode will not write it`)
      }
      if (before.version === previousVersion || before.fingerprint === previousFingerprint) {
        throw new Error("Current table does not differ from the recorded pre-append definition")
      }
      after = before
      evidence.appendOutcome = "observed-existing-after-prior-attempt"
    } else {
      appended = JSON.parse(
        await call("append_ddic_transparent_table_fields", {
          operationId: `ddic-append-${randomUUID()}`,
          objectName: tableName,
          expectedVersion: before.version,
          expectedFingerprint: before.fingerprint,
          fields: [{ name: fieldName, dataElement }],
          packageName,
          transportNumber,
          connectionId
        })
      )
      after = JSON.parse(
        await call("read_ddic_transparent_table", { objectName: tableName, connectionId })
      )
    }
    const expectedExisting = resumeValidation
      ? expectedValidationBaseline()
      : { settings: stableTableSettings(before.definition), fields: before.definition.fields }
    if (after.definition.fields.length !== expectedExisting.fields.length + 1) {
      throw new Error("Readback field count does not show exactly one appended field")
    }
    if (
      JSON.stringify(after.definition.fields.slice(0, -1)) !==
      JSON.stringify(expectedExisting.fields)
    ) {
      throw new Error("An existing transparent-table field changed during append")
    }
    if (
      JSON.stringify(stableTableSettings(after.definition)) !==
      JSON.stringify(expectedExisting.settings)
    ) {
      throw new Error("Transparent-table settings changed during append")
    }
    const added = after.definition.fields.at(-1)
    if (
      added?.name !== fieldName ||
      added?.dataElement !== dataElement ||
      added?.key !== false ||
      added?.notNull !== false
    ) {
      throw new Error("Appended field readback is not nullable and non-key as required")
    }
    if (!resumeValidation) {
      if (
        appended.operationReceipt?.version !== 2 ||
        appended.operationReceipt?.status !== "completed" ||
        appended.operationReceipt?.sapPreChangeEvidence?.fingerprint !== before.fingerprint
      ) {
        throw new Error("Version 2 write receipt does not contain the expected pre-change evidence")
      }
    }

    const stale = await call(
      "append_ddic_transparent_table_fields",
      {
        operationId: `ddic-stale-${randomUUID()}`,
        objectName: tableName,
        expectedVersion: resumeValidation ? previousVersion : before.version,
        expectedFingerprint: resumeValidation ? previousFingerprint : before.fingerprint,
        fields: [{ name: `${fieldName.slice(0, 24)}_STALE`, dataElement }],
        packageName,
        transportNumber,
        connectionId
      },
      true
    )
    if (!/VERSION_CONFLICT|FINGERPRINT_CONFLICT/.test(stale)) {
      throw new Error("Stale transparent-table definition was not rejected")
    }

    evidence.status = "passed"
    evidence.before = resumeValidation
      ? { version: previousVersion, fingerprint: previousFingerprint, source: "recorded-evidence" }
      : { version: before.version, fingerprint: before.fingerprint }
    evidence.after = {
      version: after.version,
      fingerprint: after.fingerprint,
      fieldCount: after.definition.fields.length,
      appendedField: added
    }
    evidence.receipt = appended?.operationReceipt ?? null
    if (resumeValidation) {
      evidence.receiptLimitation = "The completed receipt from the prior process is unavailable."
    }
    evidence.staleGuard = "passed"
  }
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  await client.close().catch(() => undefined)
  console.log(JSON.stringify(evidence, null, 2))
}
