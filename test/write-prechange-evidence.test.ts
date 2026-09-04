import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { ToolService } from "../src/tools.js"
import { observeWritePreChange } from "../src/write-prechange-evidence.js"
import { MockBackend } from "./mock-backend.js"

test("pre-change observation covers repository, DDIC, message, and source targets", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)

  const repository = await observeWritePreChange(
    "delete_module_pool",
    { programName: "ZMODULE_POOL" },
    "w200",
    "program ZMODULE_POOL",
    backend,
    tools
  )
  assert.equal(repository.exists, true)
  assert.equal(repository.active, true)
  assert.equal(repository.packageName, "ZABAP")
  assert.equal(repository.requestNumber, "GR2K923421")
  assert.equal(repository.taskNumber, "GR2K923422")

  const ddic = await observeWritePreChange(
    "upsert_ddic_domain",
    { objectName: "ZDOMAIN_MISSING" },
    "w200",
    "domain object ZDOMAIN_MISSING",
    backend,
    tools
  )
  assert.equal(ddic.exists, false)
  assert.equal(ddic.observationStatus, "complete")

  const transparentTableRead = JSON.parse(
    await tools.readDdicTransparentTable({ objectName: "T000", connectionId: "w200" })
  ) as { fingerprint: string }
  const transparentTable = await observeWritePreChange(
    "append_ddic_transparent_table_fields",
    { objectName: "T000" },
    "w200",
    "tabl object T000",
    backend,
    tools
  )
  assert.equal(transparentTable.exists, true)
  assert.equal(transparentTable.packageName, "STRM")
  assert.equal(transparentTable.fingerprint, transparentTableRead.fingerprint)
  assert.deepEqual(transparentTable.sources, ["read_ddic_transparent_table"])
  const transparentTablePatch = await observeWritePreChange(
    "patch_ddic_transparent_table_fields",
    { objectName: "T000" },
    "w200",
    "tabl object T000",
    backend,
    tools
  )
  assert.equal(transparentTablePatch.exists, true)
  assert.equal(transparentTablePatch.fingerprint, transparentTableRead.fingerprint)

  const transparentTableDelete = await observeWritePreChange(
    "delete_ddic_object",
    { objectType: "TABL", objectName: "T000" },
    "w200",
    "tabl object T000",
    backend,
    tools
  )
  assert.equal(transparentTableDelete.exists, true)
  assert.equal(transparentTableDelete.packageName, "STRM")

  const message = await observeWritePreChange(
    "create_abap_message_class",
    { messageClass: "ZMESSAGE_MISSING" },
    "w200",
    "message class ZMESSAGE_MISSING",
    backend,
    tools
  )
  assert.equal(message.exists, false)

  await tools.createAbapMessageClass({
    messageClass: "ZMESSAGE_0300",
    description: "Evidence",
    messages: [{ number: "001", text: "Before" }],
    packageName: "ZABAP",
    transportNumber: "GR2K923421",
    connectionId: "w200"
  })
  const messageUpdate = await observeWritePreChange(
    "update_abap_message_class",
    { messageClass: "ZMESSAGE_0300" },
    "w200",
    "message class ZMESSAGE_0300",
    backend,
    tools
  )
  assert.equal(messageUpdate.exists, true)
  assert.equal(messageUpdate.packageName, "ZABAP")
  assert.equal(messageUpdate.version, "20260831140000")

  const messageDelete = await observeWritePreChange(
    "delete_abap_message_class",
    { messageClass: "ZMESSAGE_0300" },
    "w200",
    "message class ZMESSAGE_0300",
    backend,
    tools
  )
  assert.equal(messageDelete.exists, true)
  assert.equal(messageDelete.packageName, "ZABAP")
  assert.match(String(messageDelete.fingerprint), /^[a-f0-9]{64}$/)

  const source = await observeWritePreChange(
    "manage_text_elements",
    { objectName: "ZREPORT_DEMO", objectType: "PROGRAM" },
    "w200",
    "program ZREPORT_DEMO",
    backend,
    tools
  )
  assert.equal(source.exists, true)
  assert.equal(source.active, true)
  assert.equal(source.packageName, "ZABAP")
  assert.match(String(source.fingerprint), /^[a-f0-9]{64}$/)
  assert.match(source.observedAt, /^2026-/)

  const sourceDelete = await observeWritePreChange(
    "delete_abap_source_object",
    { objectName: "ZCL_DEMO", objectType: "CLAS/OC" },
    "w200",
    "class ZCL_DEMO",
    backend,
    tools
  )
  assert.equal(sourceDelete.exists, true)
  assert.equal(sourceDelete.packageName, "ZABAP")
  const sourceObject = (await backend.searchObjects("w200", "ZCL_DEMO", ["CLAS"], 1))[0]
  assert.ok(sourceObject)
  const sourceText = (await backend.readSource("w200", sourceObject)).source
  assert.equal(sourceDelete.fingerprint, createHash("sha256").update(sourceText).digest("hex"))

  const searchObjects = backend.searchObjects.bind(backend)
  backend.searchObjects = async (connectionId, pattern, types, maxResults) =>
    pattern === "LZCMCP_FG_0300F01"
      ? [
          {
            name: "LZCMCP_FG_0300F01",
            type: "PROG/I",
            description: "Technical Include",
            package: "ZABAP",
            systemType: "STANDARD",
            uri: "/sap/bc/adt/functions/groups/zcmcp_fg_0300/includes/lzcmcp_fg_0300f01"
          }
        ]
      : searchObjects(connectionId, pattern, types, maxResults)
  const readSource = backend.readSource.bind(backend)
  backend.readSource = async (connectionId, object) =>
    object.name === "LZCMCP_FG_0300F01"
      ? { source: "FORM example.\nENDFORM.", uriUsed: `${object.uri}/source/main` }
      : readSource(connectionId, object)
  const functionIncludeDelete = await observeWritePreChange(
    "delete_abap_source_object",
    { objectName: "F01", objectType: "FUGR/I", parentName: "ZCMCP_FG_0300" },
    "w200",
    "function include F01 in ZCMCP_FG_0300",
    backend,
    tools
  )
  assert.equal(functionIncludeDelete.exists, true)
  assert.equal(functionIncludeDelete.packageName, "ZABAP")
  assert.equal(functionIncludeDelete.requestNumber, "GR2K923421")
  assert.equal(functionIncludeDelete.taskNumber, "GR2K923422")
  assert.deepEqual(functionIncludeDelete.sources, [
    "adt_object_search",
    "active_source",
    "repository_assignment"
  ])
})

test("pre-change observation treats an explicitly missing function module as absent", async () => {
  const backend = new MockBackend()
  const callSapRepository = backend.callSapRepository.bind(backend)
  backend.callSapRepository = async (connectionId, request) => {
    if (
      request.operation === "INSPECT_REPOSITORY_ASSIGNMENT" &&
      request.objectName === "ZCMCP_FM_MISSING"
    ) {
      const result = await callSapRepository(connectionId, request)
      return {
        ...result,
        status: "E",
        code: "REPOSITORY_OBJECT_NOT_FOUND",
        message: "Function module does not exist",
        source: []
      }
    }
    return callSapRepository(connectionId, request)
  }
  const evidence = await observeWritePreChange(
    "create_function_module_with_interface",
    { functionName: "ZCMCP_FM_MISSING", functionGroup: "ZCMCP_FG_0301" },
    "w200",
    "fugr/ff ZCMCP_FM_MISSING in ZCMCP_FG_0301",
    backend,
    new ToolService(backend)
  )

  assert.equal(evidence.exists, false)
  assert.equal(evidence.observationStatus, "complete")
  assert.deepEqual(evidence.warnings, [])
})

test("pre-change observation treats a missing transaction and assignment as absent", async () => {
  const backend = new MockBackend()
  const callSapRepository = backend.callSapRepository.bind(backend)
  backend.callSapRepository = async (connectionId, request) => {
    if (request.objectName === "ZCMCP_RPT_MISSING") {
      const result = await callSapRepository(connectionId, request)
      return {
        ...result,
        status: "E",
        code: "REPOSITORY_OBJECT_NOT_FOUND",
        message: "Repository object does not exist",
        source: []
      }
    }
    if (request.operation === "READ_TRANSACTION" && request.transaction === "ZCMCP_RPT_MISSING") {
      const result = await callSapRepository(connectionId, request)
      return {
        ...result,
        status: "E",
        code: "TRANSACTION_NOT_FOUND",
        message: "Transaction does not exist",
        transactions: [],
        guiAttributes: [],
        source: []
      }
    }
    return callSapRepository(connectionId, request)
  }
  const evidence = await observeWritePreChange(
    "create_report_transaction",
    { transactionCode: "ZCMCP_RPT_MISSING", programName: "ZCMCP_PRG_0320" },
    "w200",
    "transaction ZCMCP_RPT_MISSING",
    backend,
    new ToolService(backend)
  )

  assert.equal(evidence.exists, false)
  assert.equal(evidence.observationStatus, "complete")
  assert.deepEqual(evidence.sources, ["read_transaction_code", "repository_assignment"])
  assert.deepEqual(evidence.warnings, [])
})

test("source deletion observation reads a function module as FUNC source", async () => {
  const backend = new MockBackend()
  const searchObjects = backend.searchObjects.bind(backend)
  backend.searchObjects = async (connectionId, pattern, types, maxResults) => {
    if (pattern === "ZCMCP_FM_0301") {
      assert.deepEqual(types, ["FUNC"])
      return [
        {
          name: "ZCMCP_FM_0301",
          type: "FUGR/FF",
          description: "Lifecycle function",
          package: "",
          systemType: "CUSTOM",
          uri: "/sap/bc/adt/functions/groups/zcmcp_fg_0301/fmodules/zcmcp_fm_0301"
        }
      ]
    }
    return searchObjects(connectionId, pattern, types, maxResults)
  }
  const readSource = backend.readSource.bind(backend)
  backend.readSource = async (connectionId, object) =>
    object.name === "ZCMCP_FM_0301"
      ? {
          source: "FUNCTION zcmcp_fm_0301.\nENDFUNCTION.",
          uriUsed: `${object.uri}/source/main`
        }
      : readSource(connectionId, object)

  const evidence = await observeWritePreChange(
    "delete_abap_source_object",
    {
      objectType: "FUGR/FF",
      objectName: "ZCMCP_FM_0301",
      parentName: "ZCMCP_FG_0301"
    },
    "w200",
    "fugr/ff ZCMCP_FM_0301 in ZCMCP_FG_0301",
    backend,
    new ToolService(backend)
  )

  assert.equal(evidence.exists, true)
  assert.equal(evidence.packageName, "ZABAP")
  assert.equal(
    evidence.fingerprint,
    createHash("sha256").update("FUNCTION zcmcp_fm_0301.\nENDFUNCTION.").digest("hex")
  )
  assert.deepEqual(evidence.warnings, [])
})
