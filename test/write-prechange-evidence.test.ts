import assert from "node:assert/strict"
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
  assert.equal(sourceDelete.packageName, "ZVALIDATION")
  assert.match(String(sourceDelete.fingerprint), /^[a-f0-9]{64}$/)

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
