import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { ToolService } from "../src/tools.js"
import { isMissing, observeWritePreChange } from "../src/write-prechange-evidence.js"
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

  // The lock-object family is a DDIC object kind like any other, and the pre-change gate must route
  // it through the DDIC reader. Before that was wired, an ENQU deletion threw "Unsupported DDIC
  // deletion type" before SAP was touched, and both upserts fell through to the program
  // observation, which reports a lock object or a search help as an absent repository object.
  const lockObjectDelete = await observeWritePreChange(
    "delete_ddic_object",
    { objectType: "ENQU", objectName: "EZLOCK_MISSING" },
    "w200",
    "enqu object EZLOCK_MISSING",
    backend,
    tools
  )
  assert.equal(lockObjectDelete.exists, false)
  assert.deepEqual(lockObjectDelete.sources, ["sap_ddic_read"])

  const lockObjectUpsert = await observeWritePreChange(
    "upsert_lock_object",
    { objectName: "EZLOCK_MISSING" },
    "w200",
    "lock object EZLOCK_MISSING",
    backend,
    tools
  )
  assert.equal(lockObjectUpsert.exists, false)
  assert.deepEqual(lockObjectUpsert.sources, ["sap_ddic_read"])

  // Number range objects are the fourth DDIC object kind this gate observes. Their version is a
  // 40-character SHA-1 definition digest rather than a 14-digit DDIC timestamp, so a target that fell
  // through to the generic program observation would report the object as absent and let a later write
  // claim a creation. Both directions are asserted for that reason.
  const numberRangeDelete = await observeWritePreChange(
    "delete_ddic_object",
    { objectType: "NROB", objectName: "ZNROMISS" },
    "w200",
    "number range object ZNROMISS",
    backend,
    tools
  )
  assert.equal(numberRangeDelete.exists, false)
  assert.deepEqual(numberRangeDelete.sources, ["sap_ddic_read"])

  const numberRangeUpsert = await observeWritePreChange(
    "upsert_number_range_object",
    { objectName: "ZNROMISS" },
    "w200",
    "number range object ZNROMISS",
    backend,
    tools
  )
  assert.equal(numberRangeUpsert.exists, false)
  assert.deepEqual(numberRangeUpsert.sources, ["sap_ddic_read"])

  const searchHelpUpsert = await observeWritePreChange(
    "upsert_search_help",
    { objectName: "ZSHLP_MISSING" },
    "w200",
    "search help ZSHLP_MISSING",
    backend,
    tools
  )
  assert.equal(searchHelpUpsert.exists, false)
  assert.deepEqual(searchHelpUpsert.sources, ["sap_ddic_read"])

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

test("pre-change observation labels an inactive source as inactive", async () => {
  const backend = new MockBackend()
  backend.inspectSource = async () => ({
    sourceUri: "/sap/bc/adt/oo/classes/zcl_demo/source/main",
    objectUri: "/sap/bc/adt/oo/classes/zcl_demo",
    objectName: "ZCL_DEMO",
    activeSource: "CLASS zcl_demo DEFINITION. ENDCLASS.",
    inactiveSource: "CLASS zcl_demo DEFINITION. DATA changed TYPE c. ENDCLASS."
  })

  const evidence = await observeWritePreChange(
    "abap_activate",
    { fileUri: "adt://w200/sap/bc/adt/oo/classes/zcl_demo/source/main" },
    "w200",
    "class ZCL_DEMO",
    backend,
    new ToolService(backend)
  )

  assert.equal(evidence.exists, true)
  assert.equal(evidence.active, false)
  assert.equal(
    evidence.fingerprint,
    createHash("sha256")
      .update("CLASS zcl_demo DEFINITION. DATA changed TYPE c. ENDCLASS.")
      .digest("hex")
  )
  assert.deepEqual(evidence.sources, ["inactive_source"])
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

/**
 * Regression for the 2026-09-22 10:56 incident: resuming an activation observed the target through
 * the generic ADT source search, which reported `exists: false` for a table that only exists as an
 * inactive definition, while the dedicated DDIC read the tool had just performed saw it.
 */
test("pre-change observation reads the DDIC definition when resuming an activation", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)

  const evidence = await observeWritePreChange(
    "resume_ddic_table_activation",
    { objectName: "T000" },
    "w200",
    "tabl object T000",
    backend,
    tools
  )

  assert.equal(evidence.exists, true)
  assert.equal(evidence.active, true)
  assert.deepEqual(evidence.sources, ["read_ddic_transparent_table"])
  assert.ok(!evidence.sources.includes("adt_object_search"))
  assert.ok(evidence.fingerprint, "the inactive definition fingerprint must be recorded")
})

test("pre-change observation reports an inactive definition as inactive", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)
  const readResult = JSON.stringify({
    status: "inactive",
    active: false,
    fingerprint: "b".repeat(64),
    packageName: "ZPMC"
  })
  const stubbedTools = {
    readDdicTransparentTable: async () => readResult
  } as unknown as ToolService

  const evidence = await observeWritePreChange(
    "resume_ddic_table_activation",
    { objectName: "ZTPMC_TPRPI" },
    "w200",
    "tabl object ZTPMC_TPRPI",
    backend,
    stubbedTools
  )

  assert.equal(evidence.exists, true)
  assert.equal(evidence.active, false)
  assert.equal(evidence.fingerprint, "b".repeat(64))
  assert.equal(evidence.packageName, "ZPMC")
})

// A new CTS request and a new CTS object entry both have no source identity. Before these two
// branches existed they fell through to the generic ADT source observation, which threw "write
// target has no readable source identity": the gate then reported exists=null and both writes were
// refused before SAP was contacted, so the two 2.8 transport tools were unreachable.
test("a localised not-found is recognised as the target being absent", () => {
  // Live evidence from w200: the helper answers a missing function module with a code that says only
  // that the read failed and a message whose "does not exist" wording is localised. Creating a
  // function module therefore produced a receipt with an unexplained warning and an observation
  // downgraded to partial, even though "the target does not exist yet" is the normal state before
  // every create. The English patterns below never matched that message.
  assert.equal(
    isMissing(
      "Error: SAP repository helper rejected the operation: FUNCTION_READ_FAILED: 功能模块 Z_ORVANTA_DOES_NOT_EXIST_99 不存在"
    ),
    true
  )
  assert.equal(isMissing("Error: object 未找到"), true)
  assert.equal(isMissing("Error: FUNCTION_NOT_FOUND: Function module does not exist"), true)
  // A read that failed for a reason other than absence must stay an error: the code alone says
  // nothing about whether the object exists.
  assert.equal(isMissing("Error: FUNCTION_READ_FAILED: 没有权限"), false)
  assert.equal(isMissing("Error: RFC_ERROR_SYSTEM_FAILURE: connection reset"), false)
})

test("pre-change observation covers CTS request creation and object addition", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)

  const createMissing = await observeWritePreChange(
    "create_transport_request",
    { requestType: "K", description: "Nothing like this exists" },
    "w200",
    'new CTS request of type K described "Nothing like this exists"',
    backend,
    tools
  )
  assert.equal(createMissing.exists, false)
  assert.equal(createMissing.observationStatus, "complete")
  assert.deepEqual(createMissing.sources, ["list_user_transports"])

  // The retry guard is owner plus type plus description, and the mock holds one modifiable
  // workbench request owned by the calling user.
  const createExisting = await observeWritePreChange(
    "create_transport_request",
    { requestType: "K", description: "Mock W20K900001" },
    "w200",
    'new CTS request of type K described "Mock W20K900001"',
    backend,
    tools
  )
  assert.equal(createExisting.exists, true)
  assert.equal(createExisting.requestNumber, "W20K900001")

  // A customizing request must not be matched against the workbench category, or the observation
  // would report an existing request for a type that has none.
  const createWrongCategory = await observeWritePreChange(
    "create_transport_request",
    { requestType: "W", description: "Mock W20K900001" },
    "w200",
    'new CTS request of type W described "Mock W20K900001"',
    backend,
    tools
  )
  assert.equal(createWrongCategory.exists, false)

  const addMissing = await observeWritePreChange(
    "add_objects_to_transport",
    {
      requestNumber: "W20K900001",
      objects: [{ pgmid: "R3TR", object: "CLAS", objName: "ZCL_ABSENT" }]
    },
    "w200",
    "CTS request W20K900001 objects",
    backend,
    tools
  )
  assert.equal(addMissing.exists, false)
  assert.equal(addMissing.observationStatus, "complete")
  assert.match(String(addMissing.fingerprint), /^[a-f0-9]{64}$/)
  assert.deepEqual(addMissing.sources, ["transport_details"])

  // An entry that is already recorded means the call repeats an earlier one.
  const addExisting = await observeWritePreChange(
    "add_objects_to_transport",
    {
      requestNumber: "W20K900001",
      objects: [{ pgmid: "R3TR", object: "CLAS", objName: "ZCL_DEMO" }]
    },
    "w200",
    "CTS request W20K900001 objects",
    backend,
    tools
  )
  assert.equal(addExisting.exists, true)
  assert.equal(addExisting.active, true)

  // An unreadable request must stay a hard failure: exists=null throws before SAP is touched rather
  // than reporting the target as absent and letting the write claim a creation.
  await assert.rejects(
    observeWritePreChange(
      "add_objects_to_transport",
      {
        requestNumber: "W20K999999",
        objects: [{ pgmid: "R3TR", object: "CLAS", objName: "ZCL_DEMO" }]
      },
      "w200",
      "CTS request W20K999999 objects",
      backend,
      tools
    ),
    /could not establish whether/
  )
})
