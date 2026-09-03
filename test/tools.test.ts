import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  AdtBackend,
  addMessageClassEntries,
  buildSapDdicEnvelope,
  buildSapHelperEnvelope,
  buildRemoteFunctionEnvelope,
  buildSapRepositoryEnvelope,
  capabilityFailure,
  createObjectWithClient,
  createTestIncludeWithClient,
  deleteObjectWithClient,
  detectTypeFromUri,
  loadRevisionObjectStructure,
  lockTextElementsWithClient,
  mergeTextElementChanges,
  normalizeAdtUri,
  optimalSourceUri,
  preserveCookieSessionWithoutCsrf,
  parseSapHelperResponse,
  parseRemoteFunctionResponse,
  parseMessageClassXml,
  parseSapDdicResponse,
  parseSapRepositoryResponse,
  prepareCreateObjectRequest,
  readDictionaryObject,
  resolveEditableSourceTarget,
  replaceSourceWithClient,
  sanitizeObjectName,
  standaloneClientOptions,
  writeTextElementsWithClient
} from "../src/adt-backend.js"
import type { AbapObjectInfo } from "../src/backend.js"
import { InvocationReceiptStore } from "../src/invocation-receipts.js"
import { ToolService, extractMethod, validateReadOnlySql } from "../src/tools.js"
import { findAndReplaceSource } from "../src/source-edit.js"
import { MockBackend } from "./mock-backend.js"

const zclDemoSource = [
  "CLASS zcl_demo IMPLEMENTATION.",
  "  METHOD run.",
  "    WRITE 'HEADLESS'.",
  "  ENDMETHOD.",
  "ENDCLASS."
].join("\n")
const zclDemoFingerprint = createHash("sha256").update(zclDemoSource).digest("hex")

test("five headless tool paths preserve representative output behavior", async () => {
  const tools = new ToolService(new MockBackend())

  assert.equal(tools.getConnectedSystems(), "Connected SAP systems: w200")

  const search = await tools.searchObjects({
    pattern: "Z*DEMO",
    types: ["CLAS", "PROG"],
    connectionId: "w200"
  })
  assert.match(search, /Found 2 ABAP objects/)
  assert.match(search, /ADT: adt:\/\/w200\/sap\/bc\/adt\/oo\/classes\/zcl_demo/)

  const info = await tools.getObjectInfo({
    objectName: "ZCL_DEMO",
    objectType: "CLAS",
    connectionId: "w200"
  })
  assert.match(info, /Object Type: CLAS\/OC/)
  assert.match(info, /Total Lines: 5/)
  assert.match(info, /ZENH_DEMO \(line 3\)/)

  const lines = await tools.getObjectLines({
    objectName: "ZCL_DEMO",
    objectType: "CLAS",
    methodName: "RUN",
    connectionId: "w200"
  })
  assert.match(lines, /Method RUN/)
  assert.match(lines, /METHOD run\./)
  assert.match(lines, /WRITE 'HEADLESS'/)
  assert.match(lines, new RegExp(`Full Source SHA-256: ${zclDemoFingerprint}`))

  const tableInfo = await tools.getObjectInfo({
    objectName: "ZTABLE_DEMO",
    objectType: "TABL",
    connectionId: "w200"
  })
  assert.match(tableInfo, /Append structures: 1 \(custom fields present\)/)

  const tableLines = await tools.getObjectLines({
    objectName: "ZTABLE_DEMO",
    objectType: "TABL",
    startLine: 1,
    lineCount: 10,
    connectionId: "w200"
  })
  assert.match(tableLines, /MANDT: C\(3\) \[KEY\]/)
  assert.match(tableLines, /ZTABLE_DEMO_A \(2 fields\)/)

  const batch = await tools.getBatchLines({
    requests: [{ objectName: "ZREPORT_DEMO", startLine: 0, lineCount: 1 }],
    connectionId: "w200"
  })
  assert.match(batch, /Batch Lines Results \(1 objects\)/)
  assert.match(batch, /REPORT zreport_demo\./)
})

test("headless debugger tools expose deterministic bounded requests", async () => {
  const tools = new ToolService(new MockBackend())
  assert.match(
    await tools.debugSession({ connectionId: "w200", action: "start" }),
    /"state": "listening"/
  )
  assert.match(
    await tools.debugBreakpoint({
      connectionId: "w200",
      filePath: "adt://w200/sap/bc/adt/functions/groups/zcmcp_fg_1501/fmodules/zcmcp_fm_1501",
      lineNumbers: [12]
    }),
    /"verified": true/
  )
  const stack = JSON.parse(await tools.debugStack({ connectionId: "w200" })) as Array<{
    frameId: number
  }>
  assert.equal(stack[0]?.frameId, 1_000_000_000_000)
  assert.match(
    await tools.debugVariable({
      connectionId: "w200",
      frameId: stack[0]!.frameId,
      variableName: "IV_INPUT"
    }),
    /VALIDATION/
  )
  await assert.rejects(
    tools.debugStep({ connectionId: "w200", stepType: "jumpToLine", targetLine: 20 }),
    /jumpToLine is disabled/
  )
})

test("SAP helper status exposes readiness and server-side target rejection", async () => {
  const tools = new ToolService(new MockBackend())

  const ping = await tools.sapHelperStatus({ action: "ping", connectionId: "w200" })
  assert.match(ping, /Status: S/)
  assert.match(ping, /Code: READY/)
  assert.match(ping, /Version: 1\.0/)

  const rejected = await tools.sapHelperStatus({
    action: "validate_target",
    objectType: "CLAS",
    objectName: "CL_GUI_FRONTEND_SERVICES",
    connectionId: "w200"
  })
  assert.match(rejected, /Status: E/)
  assert.match(rejected, /Code: CUSTOMER_OBJECT_REQUIRED/)

  await assert.rejects(
    tools.sapHelperStatus({ action: "validate_target", connectionId: "w200" }),
    /requires objectType and objectName/
  )
})

test("message class XML entries preserve the ADT document contract", () => {
  const initial = `<?xml version="1.0" encoding="UTF-8"?>
<mc:messageClass xmlns:mc="http://www.sap.com/adt/MessageClass"
 xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZCMCP14"
 adtcore:description="Standalone messages" adtcore:language="EN"
 adtcore:masterLanguage="EN" adtcore:changedAt="2026-08-31T14:00:00Z">
 <adtcore:packageRef adtcore:name="ZPACKAGE"/>
</mc:messageClass>`
  const updated = addMessageClassEntries(initial, "ZCMCP14", [
    { number: "001", text: "Created & verified" },
    { number: "002", text: "Invalid input <&1>" }
  ])
  const parsed = parseMessageClassXml(updated)
  assert.equal(parsed.description, "Standalone messages")
  assert.equal(parsed.packageName, "ZPACKAGE")
  assert.equal(parsed.masterLanguage, "EN")
  assert.deepEqual(parsed.messages, [
    { number: "001", text: "Created & verified" },
    { number: "002", text: "Invalid input <&1>" }
  ])
  assert.match(updated, /messageclass\/zcmcp14\/messages\/001/)
})

test("legacy invalid message class XML falls back before creation", async () => {
  const backend = new AdtBackend([
    {
      id: "w200",
      url: "http://sap.example.test:8000",
      client: "200",
      language: "EN",
      username: "DEVELOPER",
      passwordEnv: "SAP_PASSWORD",
      allowUnauthorized: false
    }
  ])
  Object.assign(backend, {
    async withStatefulClient(
      _connectionId: string,
      callback: (client: unknown) => Promise<unknown>
    ) {
      return callback({
        async getObjectSource() {
          return "<html>legacy message-class endpoint</html>"
        }
      })
    }
  })
  let repositoryRequest: Parameters<AdtBackend["callSapRepository"]>[1] | undefined
  backend.callSapRepository = async (_connectionId, request) => {
    repositoryRequest = request
    return {
      status: "S",
      code: "MESSAGE_CLASS_CREATED",
      message: "verified",
      version: "1.2",
      header: {},
      dynproText: "",
      fields: [],
      flowLogic: [],
      params: [],
      transactions: [],
      guiAttributes: [],
      source: [
        "M|1|PACKAGE|ZABAP",
        "M|1|DESCRIPTION|ECC fallback",
        "M|1|MASTERLANG|E",
        "M|1|REQUEST|GR2K923421",
        "F|1|MSGNR|026",
        "F|1|TEXT|Fallback"
      ]
    }
  }

  const result = await backend.createMessageClass(
    "w200",
    "ZCMCP_MSG_0260",
    "ECC fallback",
    [{ number: "026", text: "Fallback" }],
    "ZABAP",
    "GR2K923421"
  )

  assert.equal(result.messageClass, "ZCMCP_MSG_0260")
  assert.equal(repositoryRequest?.operation, "CREATE_MESSAGE_CLASS")
})

test("SAP helper SOAP envelope escapes inputs and parses stable results", () => {
  const envelope = buildSapHelperEnvelope({
    operation: "VALIDATE_TARGET",
    objectType: "CLAS",
    objectName: "Z<DEMO&TEST"
  })
  assert.match(envelope, /<IV_OBJECT_NAME>Z&lt;DEMO&amp;TEST<\/IV_OBJECT_NAME>/)

  const result = parseSapHelperResponse(`<?xml version="1.0"?>
    <soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/">
      <soap-env:Body>
        <n0:Z_CODEX_MCP_EXECUTE.Response xmlns:n0="urn:sap-com:document:sap:rfc:functions">
          <EV_STATUS>S</EV_STATUS>
          <EV_CODE>READY</EV_CODE>
          <EV_MESSAGE>Codex MCP SAP helper is ready</EV_MESSAGE>
          <EV_VERSION>1.0</EV_VERSION>
        </n0:Z_CODEX_MCP_EXECUTE.Response>
      </soap-env:Body>
    </soap-env:Envelope>`)
  assert.deepEqual(result, {
    status: "S",
    code: "READY",
    message: "Codex MCP SAP helper is ready",
    version: "1.0"
  })
  assert.throws(
    () =>
      parseSapHelperResponse(`
        <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Body><soap:Fault><faultstring>Denied</faultstring></soap:Fault></soap:Body>
        </soap:Envelope>`),
    /SAP SOAP fault: Denied/
  )
})

test("remote function SOAP envelope and response keep scalar values bounded to declared outputs", () => {
  const envelope = buildRemoteFunctionEnvelope({
    functionName: "ZCMCP_FM_1501",
    inputParameters: { IV_INPUT: "A<&B" },
    outputParameters: [{ name: "EV_OUTPUT", kind: "scalar" }]
  })
  assert.match(envelope, /<n1:ZCMCP_FM_1501/)
  assert.match(envelope, /<IV_INPUT>A&lt;&amp;B<\/IV_INPUT>/)
  assert.deepEqual(
    parseRemoteFunctionResponse(
      `<Envelope><Body><ZCMCP_FM_1501.Response><EV_OUTPUT>MCP:VALIDATION</EV_OUTPUT><IGNORED>secret</IGNORED></ZCMCP_FM_1501.Response></Body></Envelope>`,
      [{ name: "EV_OUTPUT", kind: "scalar" }]
    ),
    { outputs: { EV_OUTPUT: "MCP:VALIDATION" } }
  )
  assert.deepEqual(
    parseRemoteFunctionResponse(
      `<soap-env:Envelope><soap-env:Body><soap-env:Fault><faultcode>soap-env:Server</faultcode><faultstring>Exception INVALID_INPUT raised</faultstring><detail><Name>INVALID_INPUT</Name></detail></soap-env:Fault></soap-env:Body></soap-env:Envelope>`,
      [{ name: "EV_OUTPUT", kind: "scalar" }]
    ),
    {
      outputs: {},
      fault: {
        code: "soap-env:Server",
        name: "INVALID_INPUT",
        message: "Exception INVALID_INPUT raised"
      }
    }
  )
})

test("remote function SOAP serializes and parses flat structures and bounded tables", () => {
  const envelope = buildRemoteFunctionEnvelope({
    functionName: "ZCMCP_FM_1801",
    inputParameters: {
      IS_REQUEST: { TYPE: "S", MESSAGE: "A<&B" },
      CT_ITEMS: [
        { TYPE: "S", MESSAGE: "First" },
        { TYPE: "W", MESSAGE: "Second" }
      ]
    },
    outputParameters: [
      { name: "ES_RESPONSE", kind: "structure", fields: ["TYPE", "MESSAGE"] },
      { name: "CT_ITEMS", kind: "table", fields: ["TYPE", "MESSAGE"] }
    ]
  })
  assert.match(envelope, /<IS_REQUEST><TYPE>S<\/TYPE><MESSAGE>A&lt;&amp;B<\/MESSAGE><\/IS_REQUEST>/)
  assert.match(envelope, /<CT_ITEMS><item><TYPE>S<\/TYPE><MESSAGE>First<\/MESSAGE><\/item>/)

  const result = parseRemoteFunctionResponse(
    `<Envelope><Body><ZCMCP_FM_1801.Response>
      <ES_RESPONSE><TYPE>S</TYPE><MESSAGE>MCP:VALIDATION</MESSAGE><IGNORED>hidden</IGNORED></ES_RESPONSE>
      <CT_ITEMS>
        <item><TYPE>S</TYPE><MESSAGE>ROW:First</MESSAGE><IGNORED>hidden</IGNORED></item>
        <item><TYPE>W</TYPE><MESSAGE>ROW:Second</MESSAGE></item>
      </CT_ITEMS>
    </ZCMCP_FM_1801.Response></Body></Envelope>`,
    [
      { name: "ES_RESPONSE", kind: "structure", fields: ["TYPE", "MESSAGE"] },
      { name: "CT_ITEMS", kind: "table", fields: ["TYPE", "MESSAGE"] }
    ]
  )
  assert.deepEqual(result, {
    outputs: {
      ES_RESPONSE: { TYPE: "S", MESSAGE: "MCP:VALIDATION" },
      CT_ITEMS: [
        { TYPE: "S", MESSAGE: "ROW:First" },
        { TYPE: "W", MESSAGE: "ROW:Second" }
      ]
    }
  })
})

test("remote function backend preserves an HTTP 500 SOAP fault for assertion", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(500, { "Content-Type": "text/xml; charset=utf-8" })
    response.end(
      `<soap-env:Envelope><soap-env:Body><soap-env:Fault><faultcode>soap-env:Server</faultcode><faultstring>Exception INVALID_INPUT raised</faultstring><detail><Name>INVALID_INPUT</Name></detail></soap-env:Fault></soap-env:Body></soap-env:Envelope>`
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  process.env.ABAP_MCP_TEST_PASSWORD = "secret"
  try {
    const backend = new AdtBackend([
      {
        id: "test",
        url: `http://127.0.0.1:${port}`,
        client: "200",
        language: "EN",
        username: "test",
        passwordEnv: "ABAP_MCP_TEST_PASSWORD",
        allowUnauthorized: false
      }
    ])
    const result = await backend.callRemoteFunction("test", {
      functionName: "ZCMCP_FM_1501",
      inputParameters: { IV_INPUT: "" },
      outputParameters: [{ name: "EV_OUTPUT", kind: "scalar" }]
    })
    assert.equal(result.fault?.name, "INVALID_INPUT")
  } finally {
    delete process.env.ABAP_MCP_TEST_PASSWORD
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})

test("SAP SOAP helper uses a plain Basic-auth HTTP request outside the ADT session", async () => {
  const requests: Array<{ action: string; authorization: string; body: string }> = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      const action = String(request.headers.soapaction ?? "")
      requests.push({
        action,
        authorization: String(request.headers.authorization ?? ""),
        body: Buffer.concat(chunks).toString("utf8")
      })
      assert.equal(request.url, "/sap/bc/soap/rfc?sap-client=200&sap-language=EN")
      response.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" })
      const body = action.endsWith("Z_CODEX_MCP_EXECUTE")
        ? `<Envelope><Body><EV_STATUS>S</EV_STATUS><EV_CODE>READY</EV_CODE><EV_MESSAGE>OK</EV_MESSAGE><EV_VERSION>1.0</EV_VERSION></Body></Envelope>`
        : action.endsWith("Z_CODEX_MCP_DDIC_API")
          ? `<Envelope><Body><EV_STATUS>S</EV_STATUS><EV_CODE>DDIC_OBJECT_READ</EV_CODE><EV_MESSAGE>OK</EV_MESSAGE><EV_VERSION>1.2</EV_VERSION><IT_SOURCE><item><LINE>M|1|PACKAGE|SAP_BASIS</LINE></item><item><LINE>M|1|VERSION|20260831120000</LINE></item><item><LINE>H|1|DOMNAME|CHAR10</LINE></item></IT_SOURCE></Body></Envelope>`
          : `<Envelope><Body><EV_STATUS>S</EV_STATUS><EV_CODE>SCREEN_READ</EV_CODE><EV_MESSAGE>OK</EV_MESSAGE><EV_VERSION>1.1</EV_VERSION><ES_HEADER><PROG>ZDEMO</PROG></ES_HEADER><EV_DYNPROTEXT>Demo</EV_DYNPROTEXT><CT_FIELDS></CT_FIELDS><CT_FLOWLOGIC></CT_FLOWLOGIC><CT_PARAMS></CT_PARAMS><ET_TCODES></ET_TCODES><ET_GUI_ATTRIBUTES></ET_GUI_ATTRIBUTES></Body></Envelope>`
      response.end(body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  process.env.ABAP_MCP_TEST_PASSWORD = "secret"

  try {
    const backend = new AdtBackend([
      {
        id: "test",
        url: `http://127.0.0.1:${port}`,
        client: "200",
        language: "EN",
        username: "test",
        passwordEnv: "ABAP_MCP_TEST_PASSWORD",
        allowUnauthorized: false
      }
    ])
    assert.equal((await backend.callSapHelper("test", { operation: "PING" })).code, "READY")
    assert.equal(
      (
        await backend.callSapRepository("test", {
          operation: "READ_SCREEN",
          program: "ZDEMO",
          screen: "0100"
        })
      ).code,
      "SCREEN_READ"
    )
    assert.equal(
      (await backend.callSapDdic("test", { operation: "READ_DOMAIN", objectName: "CHAR10" })).header
        .DOMNAME,
      "CHAR10"
    )
    assert.deepEqual(
      requests.map(({ action, authorization }) => ({ action, authorization })),
      [
        {
          action: "http://www.sap.com/Z_CODEX_MCP_EXECUTE",
          authorization: "Basic dGVzdDpzZWNyZXQ="
        },
        {
          action: "http://www.sap.com/Z_CODEX_MCP_DYNPRO_API",
          authorization: "Basic dGVzdDpzZWNyZXQ="
        },
        {
          action: "http://www.sap.com/Z_CODEX_MCP_DDIC_API",
          authorization: "Basic dGVzdDpzZWNyZXQ="
        }
      ]
    )
    assert.match(requests[0]!.body, /<IV_OPERATION>PING<\/IV_OPERATION>/)
    assert.match(requests[1]!.body, /<IV_PROGRAM>ZDEMO<\/IV_PROGRAM>/)
    assert.match(requests[2]!.body, /<IV_OBJECT_NAME>CHAR10<\/IV_OBJECT_NAME>/)
  } finally {
    delete process.env.ABAP_MCP_TEST_PASSWORD
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})

test("repository helper SOAP separates public write rows from native read rows", () => {
  const envelope = buildSapRepositoryEnvelope({
    operation: "UPSERT_SCREEN",
    program: "ZMODULE_POOL",
    screen: "0100",
    description: "A&B",
    transportNumber: "W20K900001",
    header: { TYPE: "N", NOLI: "20" },
    fields: [{ TYPE: "TEMPLATE", NAME: "GV_NAME", TEXT: "Name <required> | 100%" }],
    flowLogic: [{ LINE: "PROCESS BEFORE OUTPUT." }]
  })
  assert.match(envelope, /<IV_DESCRIPTION>A&amp;B<\/IV_DESCRIPTION>/)
  assert.match(envelope, /<IT_SOURCE><item><LINE>F\|1\|TYPE\|TEMPLATE<\/LINE><\/item>/)
  assert.match(envelope, /<LINE>F\|1\|NAME\|GV_NAME<\/LINE>/)
  assert.match(envelope, /Name &lt;required&gt; %7C 100%25/)
  assert.match(envelope, /<LINE>L\|1\|LINE\|PROCESS BEFORE OUTPUT\.<\/LINE>/)
  assert.doesNotMatch(envelope, /IT_SCREEN_FIELDS/)
  assert.match(envelope, /<CT_FIELDS><\/CT_FIELDS>/)
  assert.doesNotMatch(envelope, /<CT_FIELDS><item>/)

  const result = parseSapRepositoryResponse(`
    <soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/">
      <soap-env:Body><Z_CODEX_MCP_EXECUTE.Response>
        <EV_STATUS>S</EV_STATUS><EV_CODE>SCREEN_READ</EV_CODE>
        <EV_MESSAGE>OK</EV_MESSAGE><EV_VERSION>1.1</EV_VERSION>
        <ES_HEADER><PROG>ZMODULE_POOL</PROG><DNUM>0100</DNUM></ES_HEADER>
        <EV_DYNPROTEXT>Demo</EV_DYNPROTEXT>
        <CT_FIELDS><item><FNAM>GV_NAME</FNAM><LINE>3</LINE></item></CT_FIELDS>
        <CT_FLOWLOGIC><item><LINE>PROCESS BEFORE OUTPUT.</LINE></item></CT_FLOWLOGIC>
        <CT_PARAMS></CT_PARAMS><ET_TCODES></ET_TCODES>
        <ET_GUI_ATTRIBUTES></ET_GUI_ATTRIBUTES>
      </Z_CODEX_MCP_EXECUTE.Response></soap-env:Body>
    </soap-env:Envelope>`)
  assert.equal(result.header.PROG, "ZMODULE_POOL")
  assert.equal(result.fields[0]?.FNAM, "GV_NAME")
  assert.deepEqual(result.flowLogic, [{ LINE: "PROCESS BEFORE OUTPUT." }])
})

test("repository helper SOAP serializes the message-class version guard", () => {
  const envelope = buildSapRepositoryEnvelope({
    operation: "UPDATE_MESSAGE_CLASS",
    objectName: "ZCMCP_MSG_0300",
    packageName: "ZABAP",
    transportNumber: "GR2K923421",
    expectedVersion: "20260903120000",
    source: ["F|1|MSGNR|001", "F|1|TEXT|Updated"]
  })
  assert.match(envelope, /<IV_EXPECTED_VERSION>20260903120000<\/IV_EXPECTED_VERSION>/)
  assert.match(envelope, /<LINE>F\|1\|MSGNR\|001<\/LINE>/)
  assert.match(envelope, /<LINE>F\|1\|TEXT\|Updated<\/LINE>/)
})

test("repository helper SOAP serializes explicit Dynpro patch operations", () => {
  const envelope = buildSapRepositoryEnvelope({
    operation: "PATCH_SCREEN",
    program: "ZMODULE_POOL",
    screen: "0100",
    transportNumber: "W20K900001",
    componentOperations: [
      {
        operation: "ADD",
        name: "GV_ACTIVE",
        definition: { NAME: "GV_ACTIVE", TYPE: "CHECK", LINE: "4" }
      }
    ],
    flowLogic: [{ LINE: "PROCESS BEFORE OUTPUT." }]
  })
  assert.match(envelope, /<LINE>O\|1\|OP\|ADD<\/LINE>/)
  assert.match(envelope, /<LINE>O\|1\|FIELD_NAME\|GV_ACTIVE<\/LINE>/)
  assert.match(envelope, /<LINE>M\|1\|FLOW_REPLACE\|X<\/LINE>/)
})

test("repository helper SOAP serializes a complete versioned GUI definition", () => {
  const envelope = buildSapRepositoryEnvelope({
    operation: "PATCH_GUI_DEFINITION",
    program: "ZMODULE_POOL",
    transportNumber: "W20K900001",
    guiDefinition: {
      expectedVersion: "20260902090000",
      admin: { ACTCODE: "000002", MOD_LANGU: "E" },
      sections: {
        STA: [{ CODE: "STATUS_0100", ACTCODE: "000002" }],
        FUN: [{ CODE: "SAVE", TEXTNO: "001", FUN_TEXT: "Save | 100%" }],
        MEN: [],
        MTX: [],
        ACT: [],
        BUT: [],
        PFK: [],
        SET: [{ STATUS: "STATUS_0100", FUNCTION: "SAVE" }],
        DOC: [],
        TIT: [{ CODE: "TITLE_0100", TEXT: "Main" }],
        BIV: []
      }
    }
  })
  assert.match(envelope, /<LINE>M\|1\|EXPECTED_VERSION\|20260902090000<\/LINE>/)
  assert.match(envelope, /<LINE>ADM\|1\|ACTCODE\|000002<\/LINE>/)
  assert.match(envelope, /<LINE>STA\|1\|CODE\|STATUS_0100<\/LINE>/)
  assert.match(envelope, /<LINE>FUN\|1\|FUN_TEXT\|Save %7C 100%25<\/LINE>/)
  assert.match(envelope, /<LINE>TIT\|1\|TEXT\|Main<\/LINE>/)
})

test("DDIC helper SOAP serializes definitions and parses metadata rows", () => {
  const envelope = buildSapDdicEnvelope({
    operation: "UPSERT_DOMAIN",
    objectName: "ZCODEX_DOMAIN",
    description: "A&B",
    packageName: "ZABAP",
    transportNumber: "GR2K923421",
    expectedVersion: "20260831120000",
    header: { DATATYPE: "CHAR", LENG: "10", CONVEXIT: "ALPHA" },
    fixedValues: [{ DOMVALUE_L: "A|B", DDTEXT: "100% ready" }]
  })
  assert.match(envelope, /<IV_EXPECTED_VERSION>20260831120000<\/IV_EXPECTED_VERSION>/)
  assert.match(envelope, /<LINE>H\|1\|DATATYPE\|CHAR<\/LINE>/)
  assert.match(envelope, /<LINE>V\|1\|DOMVALUE_L\|A%7CB<\/LINE>/)
  assert.match(envelope, /<LINE>V\|1\|DDTEXT\|100%25 ready<\/LINE>/)

  const result = parseSapDdicResponse(`
    <Envelope><Body><EV_STATUS>S</EV_STATUS><EV_CODE>DDIC_OBJECT_SAVED</EV_CODE>
      <EV_MESSAGE>OK</EV_MESSAGE><EV_VERSION>1.2</EV_VERSION>
      <IT_SOURCE>
        <item><LINE>M|1|PACKAGE|ZABAP</LINE></item>
        <item><LINE>M|1|VERSION|20260831123000</LINE></item>
        <item><LINE>M|1|REQUEST|GR2K923422</LINE></item>
        <item><LINE>H|1|DOMNAME|ZCODEX_DOMAIN</LINE></item>
        <item><LINE>H|1|DDTEXT|A%7CB</LINE></item>
        <item><LINE>V|1|DOMVALUE_L|A%25B</LINE></item>
      </IT_SOURCE></Body></Envelope>`)
  assert.equal(result.packageName, "ZABAP")
  assert.equal(result.objectVersion, "20260831123000")
  assert.equal(result.recordedRequest, "GR2K923422")
  assert.equal(result.header.DDTEXT, "A|B")
  assert.equal(result.fixedValues[0]?.DOMVALUE_L, "A%B")
})

test("Dynpro application tools validate customer scope and preserve structured rows", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)
  const screen = JSON.parse(
    await tools.readAbapScreen({
      programName: "ZMODULE_POOL",
      screenNumber: "100",
      connectionId: "w200"
    })
  ) as {
    screenNumber: string
    fingerprint: string
    fields: Array<Record<string, string>>
    moduleReferences: Array<{ name: string; event: string }>
  }
  assert.equal(screen.screenNumber, "0100")
  assert.match(screen.fingerprint, /^[a-f0-9]{64}$/)
  assert.equal(screen.fields[0]?.FNAM, "GV_NAME")
  assert.deepEqual(
    screen.moduleReferences.map(({ name, event }) => ({ name, event })),
    [
      { name: "STATUS_0100", event: "PBO" },
      { name: "USER_COMMAND_0100", event: "PAI" }
    ]
  )

  const validation = JSON.parse(
    await tools.validateDynproApplication({
      programName: "ZMODULE_POOL",
      screenNumber: "0100",
      connectionId: "w200"
    })
  ) as {
    status: string
    errors: unknown[]
    moduleDefinitions: unknown[]
    sourceCoverage: { complete: boolean; sources: unknown[] }
  }
  assert.equal(validation.status, "valid")
  assert.equal(validation.errors.length, 0)
  assert.equal(validation.moduleDefinitions.length, 2)
  assert.equal(validation.sourceCoverage.complete, true)
  assert.equal(validation.sourceCoverage.sources.length, 1)

  const patched = JSON.parse(
    await tools.patchAbapScreen({
      programName: "ZMODULE_POOL",
      screenNumber: "0100",
      expectedFingerprint: screen.fingerprint,
      transportNumber: "W20K900001",
      componentOperations: [
        {
          operation: "add",
          name: "GV_ACTIVE",
          definition: {
            TYPE: "CHECK",
            TEXT: "Active",
            LINE: "4",
            COLUMN: "10",
            LENGTH: "1"
          }
        },
        {
          operation: "update",
          name: "GV_NAME",
          definition: { TEXT: "Changed name", LINE: "3", COLUMN: "12", LENGTH: "30" }
        },
        { operation: "remove", name: "BTN_EXIT" }
      ],
      connectionId: "w200"
    })
  ) as {
    status: string
    fingerprint: string
    previousFingerprint: string
    fields: Array<Record<string, string>>
  }
  assert.equal(patched.status, "SCREEN_PATCHED")
  assert.equal(patched.previousFingerprint, screen.fingerprint)
  assert.notEqual(patched.fingerprint, screen.fingerprint)
  assert.deepEqual(
    patched.fields.map(({ FNAM }) => FNAM),
    ["GV_NAME", "GV_ACTIVE"]
  )
  assert.equal(backend.lastRepositoryRequest?.operation, "PATCH_SCREEN")

  await assert.rejects(
    tools.patchAbapScreen({
      programName: "ZMODULE_POOL",
      screenNumber: "0100",
      expectedFingerprint: screen.fingerprint,
      transportNumber: "W20K900001",
      componentOperations: [{ operation: "remove", name: "GV_ACTIVE" }],
      connectionId: "w200"
    }),
    /Screen fingerprint changed/
  )

  const latest = JSON.parse(
    await tools.readAbapScreen({
      programName: "ZMODULE_POOL",
      screenNumber: "0100",
      connectionId: "w200"
    })
  ) as { fingerprint: string }

  await assert.rejects(
    tools.patchAbapScreen({
      programName: "ZMODULE_POOL",
      screenNumber: "0100",
      expectedFingerprint: latest.fingerprint,
      transportNumber: "W20K900001",
      componentOperations: [],
      connectionId: "w200"
    }),
    /at least one explicit screen change/
  )

  await assert.rejects(
    tools.patchAbapScreen({
      programName: "ZMODULE_POOL",
      screenNumber: "0100",
      expectedFingerprint: latest.fingerprint,
      transportNumber: "W20K900001",
      componentOperations: [],
      header: { TYPE: "N" } as never,
      connectionId: "w200"
    }),
    /Unsupported screen header property/
  )

  await assert.rejects(
    tools.patchAbapScreen({
      programName: "ZMODULE_POOL",
      screenNumber: "0100",
      expectedFingerprint: latest.fingerprint,
      transportNumber: "W20K900001",
      componentOperations: [
        { operation: "remove", name: "GV_ACTIVE", definition: { TEXT: "invalid" } }
      ],
      connectionId: "w200"
    }),
    /definition is not valid for remove/
  )

  const rawScreen = await tools.readAbapScreen({
    programName: "ZMODULE_POOL",
    screenNumber: "100",
    connectionId: "w200"
  })
  assert.match(rawScreen, /"screenNumber": "0100"/)
  assert.match(rawScreen, /"FNAM": "GV_NAME"/)

  const saved = await tools.upsertAbapScreen({
    programName: "ZMODULE_POOL",
    screenNumber: "0100",
    description: "Demo",
    transportNumber: "W20K900001",
    fields: [{ NAME: "GV_NAME", TYPE: "TEMPLATE", FORMAT: "CHAR" }],
    flowLogic: ["PROCESS BEFORE OUTPUT."],
    connectionId: "w200"
  })
  assert.match(saved, /ABAP screen saved and verified/)
  assert.match(saved, /Fields: 1/)

  const modulePool = await tools.createModulePool({
    programName: "ZMODULE_POOL",
    description: "Demo",
    packageName: "ZPACKAGE",
    transportNumber: "W20K900001",
    source: ["PROGRAM zmodule_pool."],
    connectionId: "w200"
  })
  assert.match(modulePool, /Module pool created and verified/)

  const transaction = await tools.createTransactionCode({
    transactionCode: "ZMODULE_POOL_UI",
    programName: "ZMODULE_POOL",
    screenNumber: "0100",
    description: "Demo",
    packageName: "ZPACKAGE",
    transportNumber: "W20K900001",
    connectionId: "w200"
  })
  assert.match(transaction, /Dialog transaction created and verified/)

  const deletedTransaction = await tools.deleteTransactionCode({
    transactionCode: "ZMODULE_POOL_UI",
    expectedProgramName: "ZMODULE_POOL",
    packageName: "ZVALIDATION",
    transportNumber: "W20K900001",
    connectionId: "w200"
  })
  assert.match(deletedTransaction, /Dialog transaction deleted and absence verified/)
  assert.equal(backend.lastRepositoryRequest?.operation, "DELETE_TRANSACTION")

  const deletedModulePool = await tools.deleteModulePool({
    programName: "ZMODULE_POOL",
    packageName: "ZVALIDATION",
    transportNumber: "W20K900001",
    connectionId: "w200"
  })
  assert.match(deletedModulePool, /Module pool deleted and absence verified/)
  assert.equal(backend.lastRepositoryRequest?.operation, "DELETE_MODULE_POOL")

  await assert.rejects(
    tools.deleteTransactionCode({
      transactionCode: "ZMODULE_POOL_UI",
      expectedProgramName: "ZOTHER_PROGRAM",
      packageName: "ZVALIDATION",
      transportNumber: "W20K900001",
      connectionId: "w200"
    }),
    /Transaction program mismatch/
  )

  await assert.rejects(
    tools.deleteModulePool({
      programName: "ZMODULE_POOL",
      packageName: "ZOTHER_PACKAGE",
      transportNumber: "W20K900001",
      connectionId: "w200"
    }),
    /Module pool package or type mismatch/
  )

  const reportTransaction = await tools.createReportTransaction({
    transactionCode: "ZREPORT_UI",
    programName: "ZREPORT_DEMO",
    variant: "DEFAULT",
    description: "Report transaction",
    packageName: "ZPACKAGE",
    transportNumber: "W20K900001",
    connectionId: "w200"
  })
  assert.match(reportTransaction, /Report transaction created and verified/)
  assert.match(reportTransaction, /Variant: DEFAULT/)

  const standardMessages = JSON.parse(
    await tools.readAbapMessageClass({ messageClass: "00", connectionId: "w200" })
  ) as { objectKind: string; definition: { messages: Array<{ number: string }> } }
  assert.equal(standardMessages.objectKind, "messageClass")
  assert.equal(standardMessages.definition.messages[0]?.number, "001")

  const createdMessages = JSON.parse(
    await tools.createAbapMessageClass({
      messageClass: "ZCMCP14",
      description: "Standalone messages",
      messages: [
        { number: "001", text: "Created" },
        { number: "002", text: "Invalid input &1" }
      ],
      packageName: "ZPACKAGE",
      transportNumber: "W20K900001",
      connectionId: "w200"
    })
  ) as { status: string; recordedRequest: string }
  assert.equal(createdMessages.status, "MESSAGE_CLASS_CREATED")
  assert.equal(createdMessages.recordedRequest, "W20K900001")

  await assert.rejects(
    tools.createAbapMessageClass({
      messageClass: "00",
      description: "Standard",
      messages: [{ number: "001", text: "No" }],
      packageName: "ZPACKAGE",
      transportNumber: "W20K900001",
      connectionId: "w200"
    }),
    /Z\* or Y\*/
  )

  await assert.rejects(
    tools.readAbapScreen({
      programName: "SAPMSSY0",
      screenNumber: "0100",
      connectionId: "w200"
    }),
    /Z\* or Y\*/
  )
})

test("GUI definition tools preserve untouched native rows and reject stale fingerprints", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)
  const current = JSON.parse(
    await tools.readAbapGuiDefinition({ programName: "ZMODULE_POOL", connectionId: "w200" })
  ) as {
    fingerprint: string
    versionToken: string
    sections: { statuses: Array<Record<string, string>>; titles: Array<Record<string, string>> }
  }
  assert.match(current.fingerprint, /^[a-f0-9]{64}$/)
  assert.equal(current.versionToken, "20260902090000")
  assert.equal(current.sections.statuses[0]?.CODE, "STATUS_0100")

  const saved = JSON.parse(
    await tools.patchAbapGuiDefinition({
      programName: "ZMODULE_POOL",
      expectedFingerprint: current.fingerprint,
      transportNumber: "W20K900001",
      operations: [
        {
          section: "functions",
          operation: "add",
          key: { CODE: "AAA", TEXTNO: "001" },
          definition: { TYPE: "S", FUN_TEXT: "First" }
        },
        {
          section: "statusFunctions",
          operation: "add",
          key: { STATUS: "STATUS_0100", FUNCTION: "SAVE" }
        },
        {
          section: "titles",
          operation: "update",
          key: { CODE: "TITLE_0100" },
          definition: { TEXT: "Updated title" }
        },
        {
          section: "functions",
          operation: "add",
          key: { CODE: "SAVE", TEXTNO: "002" },
          definition: { TYPE: "E", FUN_TEXT: "Save", INFO_TEXT: "Save entry" }
        }
      ],
      connectionId: "w200"
    })
  ) as {
    previousFingerprint: string
    fingerprint: string
    sections: {
      statuses: Array<Record<string, string>>
      statusFunctions: Array<Record<string, string>>
      titles: Array<Record<string, string>>
    }
  }
  assert.equal(saved.previousFingerprint, current.fingerprint)
  assert.notEqual(saved.fingerprint, current.fingerprint)
  assert.equal(saved.sections.statuses[0]?.CODE, "STATUS_0100")
  assert.deepEqual(saved.sections.statusFunctions.at(-1), {
    STATUS: "STATUS_0100",
    FUNCTION: "SAVE"
  })
  assert.equal(saved.sections.titles[0]?.TEXT, "Updated title")
  assert.equal(backend.lastRepositoryRequest?.guiDefinition?.sections.FUN[0]?.CODE, "AAA")
  assert.equal(backend.lastRepositoryRequest?.guiDefinition?.sections.FUN.at(-1)?.MODIF, "")
  assert.equal(backend.lastRepositoryRequest?.guiDefinition?.sections.FUN.at(-1)?.TEXT_NAME, "")
  assert.equal(backend.lastRepositoryRequest?.guiDefinition?.expectedVersion, "20260902090000")

  await assert.rejects(
    tools.patchAbapGuiDefinition({
      programName: "ZMODULE_POOL",
      expectedFingerprint: current.fingerprint,
      transportNumber: "W20K900001",
      operations: [
        {
          section: "titles",
          operation: "remove",
          key: { CODE: "TITLE_0100" }
        }
      ],
      connectionId: "w200"
    }),
    /GUI definition fingerprint changed/
  )
})

test("GUI verification reports multiple native readback differences", async () => {
  const backend = new MockBackend()
  const callSapRepository = backend.callSapRepository.bind(backend)
  backend.callSapRepository = async (connectionId, request) => {
    const result = await callSapRepository(connectionId, request)
    if (request.operation === "PATCH_GUI_DEFINITION") {
      result.source = result.source.map((line) => {
        if (line === "FUN|2|FUN_TEXT|Save") return "FUN|2|FUN_TEXT|"
        if (line === "FUN|2|INFO_TEXT|Save entry") return "FUN|2|INFO_TEXT|Changed"
        return line
      })
    }
    return result
  }
  const tools = new ToolService(backend)
  const current = JSON.parse(
    await tools.readAbapGuiDefinition({ programName: "ZMODULE_POOL", connectionId: "w200" })
  ) as { fingerprint: string }

  await assert.rejects(
    tools.patchAbapGuiDefinition({
      programName: "ZMODULE_POOL",
      expectedFingerprint: current.fingerprint,
      transportNumber: "W20K900001",
      operations: [
        {
          section: "functions",
          operation: "add",
          key: { CODE: "SAVE", TEXTNO: "001" },
          definition: { TYPE: "", FUN_TEXT: "Save", INFO_TEXT: "Save entry" }
        }
      ],
      connectionId: "w200"
    }),
    (error: Error) => {
      assert.match(error.message, /definition\.sections\.functions\[1\]\.FUN_TEXT/)
      assert.match(error.message, /definition\.sections\.functions\[1\]\.INFO_TEXT/)
      return true
    }
  )
})

test("Dynpro validation follows bounded program includes and reports exact coverage", async () => {
  const backend = new MockBackend()
  const searchObjects = backend.searchObjects.bind(backend)
  const readSource = backend.readSource.bind(backend)
  backend.searchObjects = async (connectionId, pattern, types, maxResults) => {
    if (pattern.toUpperCase() === "ZMODULE_POOL_O01") {
      return [
        {
          name: "ZMODULE_POOL_O01",
          type: "PROG/I",
          description: "PBO and PAI modules",
          package: "ZVALIDATION",
          systemType: "CUSTOM",
          uri: "/sap/bc/adt/programs/includes/zmodule_pool_o01"
        }
      ]
    }
    return searchObjects(connectionId, pattern, types, maxResults)
  }
  backend.readSource = async (connectionId, object) => {
    if (object.name === "ZMODULE_POOL") {
      return {
        source: [
          "PROGRAM zmodule_pool.",
          "DATA gv_name TYPE c LENGTH 40.",
          "INCLUDE zmodule_pool_o01."
        ].join("\n"),
        uriUsed: `${object.uri}/source/main`
      }
    }
    if (object.name === "ZMODULE_POOL_O01") {
      return {
        source: [
          "MODULE status_0100 OUTPUT.",
          "  SET PF-STATUS 'STATUS_0100'.",
          "  SET TITLEBAR 'TITLE_0100'.",
          "ENDMODULE.",
          "MODULE user_command_0100 INPUT.",
          "ENDMODULE."
        ].join("\n"),
        uriUsed: `${object.uri}/source/main`
      }
    }
    return readSource(connectionId, object)
  }

  const validation = JSON.parse(
    await new ToolService(backend).validateDynproApplication({
      programName: "ZMODULE_POOL",
      screenNumber: "0100",
      connectionId: "w200"
    })
  ) as {
    status: string
    errors: unknown[]
    warnings: unknown[]
    guiReferences: Array<{ kind: string; name: string }>
    sourceCoverage: { complete: boolean; sources: Array<{ objectName: string; depth: number }> }
  }
  assert.equal(validation.status, "valid")
  assert.deepEqual(validation.errors, [])
  assert.deepEqual(validation.warnings, [])
  assert.deepEqual(validation.guiReferences, [
    { kind: "PF_STATUS", name: "STATUS_0100" },
    { kind: "TITLEBAR", name: "TITLE_0100" }
  ])
  assert.equal(validation.sourceCoverage.complete, true)
  assert.deepEqual(
    validation.sourceCoverage.sources.map(({ objectName, depth }) => ({ objectName, depth })),
    [
      { objectName: "ZMODULE_POOL", depth: 0 },
      { objectName: "ZMODULE_POOL_O01", depth: 1 }
    ]
  )
})

test("Dynpro validation exposes a missing include without claiming full coverage", async () => {
  const backend = new MockBackend()
  const readSource = backend.readSource.bind(backend)
  backend.readSource = async (connectionId, object) =>
    object.name === "ZMODULE_POOL"
      ? {
          source: ["PROGRAM zmodule_pool.", "INCLUDE zmissing_o01."].join("\n"),
          uriUsed: `${object.uri}/source/main`
        }
      : readSource(connectionId, object)

  const validation = JSON.parse(
    await new ToolService(backend).validateDynproApplication({
      programName: "ZMODULE_POOL",
      screenNumber: "0100",
      connectionId: "w200"
    })
  ) as {
    status: string
    errors: Array<{ code: string }>
    warnings: Array<{ code: string }>
    sourceCoverage: { complete: boolean; failures: Array<{ includeName: string }> }
  }
  assert.equal(validation.status, "invalid")
  assert.ok(validation.errors.some((error) => error.code === "MODULE_DEFINITION_MISSING"))
  assert.ok(validation.warnings.some((warning) => warning.code === "INCLUDE_SOURCE_UNAVAILABLE"))
  assert.equal(validation.sourceCoverage.complete, false)
  assert.equal(validation.sourceCoverage.failures[0]?.includeName, "ZMISSING_O01")
})

test("Dynpro validation rejects missing static PF-status and Titlebar definitions", async () => {
  const backend = new MockBackend()
  const readSource = backend.readSource.bind(backend)
  const callRepository = backend.callSapRepository.bind(backend)
  backend.readSource = async (connectionId, object) =>
    object.name === "ZMODULE_POOL"
      ? {
          source: [
            "PROGRAM zmodule_pool.",
            "DATA gv_name TYPE c LENGTH 40.",
            "MODULE status_0100 OUTPUT.",
            "  SET PF-STATUS 'MISSING_STATUS'.",
            "  SET TITLEBAR 'MISSING_TITLE'.",
            "ENDMODULE.",
            "MODULE user_command_0100 INPUT.",
            "ENDMODULE."
          ].join("\n"),
          uriUsed: `${object.uri}/source/main`
        }
      : readSource(connectionId, object)
  backend.callSapRepository = async (connectionId, request) => {
    const result = await callRepository(connectionId, request)
    if (request.operation === "READ_GUI_DEFINITION") {
      result.source = result.source.filter(
        (line) => !line.startsWith("STA|") && !line.startsWith("TIT|")
      )
    }
    return result
  }

  const validation = JSON.parse(
    await new ToolService(backend).validateDynproApplication({
      programName: "ZMODULE_POOL",
      screenNumber: "0100",
      connectionId: "w200"
    })
  ) as { status: string; errors: Array<{ code: string }> }
  assert.equal(validation.status, "invalid")
  assert.ok(validation.errors.some((error) => error.code === "PF_STATUS_NOT_FOUND"))
  assert.ok(validation.errors.some((error) => error.code === "TITLEBAR_NOT_FOUND"))
})

test("Dynpro validation decodes legacy SOAP base64 byte coordinates", async () => {
  const backend = new MockBackend()
  const callRepository = backend.callSapRepository.bind(backend)
  backend.callSapRepository = async (connectionId, request) => {
    const result = await callRepository(connectionId, request)
    if (request.operation === "READ_SCREEN") {
      result.fields[0] = { ...result.fields[0], LINE: "Aw==", COLN: "EQ==" }
    }
    return result
  }
  const validation = JSON.parse(
    await new ToolService(backend).validateDynproApplication({
      programName: "ZMODULE_POOL",
      screenNumber: "0100",
      connectionId: "w200"
    })
  ) as { status: string; errors: unknown[] }
  assert.equal(validation.status, "valid")
  assert.deepEqual(validation.errors, [])
})

test("report transaction and message class tools reject unsafe requests", async () => {
  const tools = new ToolService(new MockBackend())

  await assert.rejects(
    tools.createReportTransaction({
      transactionCode: "ZREPORT_BAD_VARIANT",
      programName: "ZREPORT_DEMO",
      variant: "INVALID VARIANT",
      description: "Invalid variant",
      packageName: "ZPACKAGE",
      transportNumber: "W20K900001",
      connectionId: "w200"
    }),
    /variant must contain/
  )
  await assert.rejects(
    tools.createReportTransaction({
      transactionCode: "SE38",
      programName: "ZREPORT_DEMO",
      description: "Standard transaction",
      packageName: "ZPACKAGE",
      transportNumber: "W20K900001",
      connectionId: "w200"
    }),
    /Z\* or Y\*/
  )
  await assert.rejects(
    tools.createReportTransaction({
      transactionCode: "ZREPORT_STANDARD",
      programName: "SAPMSSY0",
      description: "Standard report",
      packageName: "ZPACKAGE",
      transportNumber: "W20K900001",
      connectionId: "w200"
    }),
    /Z\* or Y\*/
  )
  await assert.rejects(
    tools.createAbapMessageClass({
      messageClass: "ZCMCP_DUPLICATE",
      description: "Duplicate numbers",
      messages: [
        { number: "001", text: "First" },
        { number: "001", text: "Second" }
      ],
      packageName: "ZPACKAGE",
      transportNumber: "W20K900001",
      connectionId: "w200"
    }),
    /Duplicate message number/
  )

  const createInput = {
    messageClass: "ZCMCP_EXISTS",
    description: "Existing message class",
    messages: [{ number: "001", text: "Created" }],
    packageName: "ZPACKAGE",
    transportNumber: "W20K900001",
    connectionId: "w200"
  }
  await tools.createAbapMessageClass(createInput)
  await assert.rejects(tools.createAbapMessageClass(createInput), /MESSAGE_CLASS_EXISTS/)
})

test("message class incremental update preserves untouched messages and enforces versions", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)
  await tools.createAbapMessageClass({
    messageClass: "ZCMCP_MSG_0300",
    description: "Lifecycle validation",
    messages: [
      { number: "001", text: "Keep" },
      { number: "002", text: "Replace" },
      { number: "003", text: "Remove" }
    ],
    packageName: "ZABAP",
    transportNumber: "GR2K923421",
    connectionId: "w200"
  })
  const updated = JSON.parse(
    await tools.updateAbapMessageClass({
      messageClass: "ZCMCP_MSG_0300",
      expectedVersion: "20260831140000",
      operations: [
        { operation: "update", number: "002", text: "Updated" },
        { operation: "remove", number: "003" },
        { operation: "add", number: "004", text: "Added" }
      ],
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      connectionId: "w200"
    })
  ) as { status: string; version: string; definition: { messages: unknown[] } }
  assert.equal(updated.status, "MESSAGE_CLASS_UPDATED")
  assert.equal(updated.version, "20260903120000")
  assert.deepEqual(updated.definition.messages, [
    { number: "001", text: "Keep" },
    { number: "002", text: "Updated" },
    { number: "004", text: "Added" }
  ])
  await assert.rejects(
    tools.updateAbapMessageClass({
      messageClass: "ZCMCP_MSG_0300",
      expectedVersion: "20260831140000",
      operations: [{ operation: "add", number: "005", text: "Stale" }],
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      connectionId: "w200"
    }),
    /VERSION_CONFLICT/
  )

  await assert.rejects(
    tools.updateAbapMessageClass({
      messageClass: "ZCMCP_MSG_0300",
      expectedVersion: "20260903120000",
      operations: [
        { operation: "remove", number: "001" },
        { operation: "remove", number: "002" },
        { operation: "remove", number: "004" }
      ],
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      connectionId: "w200"
    }),
    /MESSAGE_CLASS_EMPTY/
  )

  await assert.rejects(
    tools.updateAbapMessageClass({
      messageClass: "ZCMCP_MSG_0300",
      expectedVersion: "20260903120000",
      operations: [
        { operation: "update", number: "002", text: "First" },
        { operation: "remove", number: "002" }
      ],
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      connectionId: "w200"
    }),
    /Duplicate message operation/
  )
})

test("controlled source and DDIC deletion verify package, version, and absence", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)
  await assert.rejects(
    tools.deleteSourceObject({
      objectType: "CLAS/OC",
      objectName: "ZCL_DEMO",
      expectedFingerprint: "f".repeat(64),
      packageName: "ZVALIDATION",
      transportNumber: "GR2K923421",
      confirmation: "PERMANENT_DELETE",
      connectionId: "w200"
    }),
    /SOURCE_FINGERPRINT_CONFLICT/
  )
  assert.equal((await backend.searchObjects("w200", "ZCL_DEMO", ["CLAS"], 1)).length, 1)
  const deletedSource = JSON.parse(
    await tools.deleteSourceObject({
      objectType: "CLAS/OC",
      objectName: "ZCL_DEMO",
      expectedFingerprint: zclDemoFingerprint,
      packageName: "ZVALIDATION",
      transportNumber: "GR2K923421",
      confirmation: "PERMANENT_DELETE",
      connectionId: "w200"
    })
  ) as { absenceVerified: boolean; preDeleteFingerprint: string }
  assert.equal(deletedSource.absenceVerified, true)
  assert.match(deletedSource.preDeleteFingerprint, /^[a-f0-9]{64}$/)

  const created = JSON.parse(
    await tools.upsertDdicDomain({
      objectName: "ZCMCP_DOM_0300",
      description: "Delete validation",
      dataType: "CHAR",
      length: 10,
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      connectionId: "w200"
    })
  ) as { version: string }
  const deletedDdic = JSON.parse(
    await tools.deleteDdicObject({
      objectType: "DOMA",
      objectName: "ZCMCP_DOM_0300",
      expectedVersion: created.version,
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      confirmation: "PERMANENT_DELETE",
      connectionId: "w200"
    })
  ) as { absenceVerified: boolean; status: string }
  assert.deepEqual(deletedDdic, {
    connectionId: "w200",
    objectType: "DOMA",
    objectName: "ZCMCP_DOM_0300",
    packageName: "ZABAP",
    recordedRequest: "GR2K923421",
    status: "DDIC_OBJECT_DELETED",
    absenceVerified: true
  })

  await assert.rejects(
    tools.deleteSourceObject({
      objectType: "CLAS/OC",
      objectName: "ZREPORT_DEMO",
      expectedFingerprint: "a".repeat(64),
      packageName: "ZVALIDATION",
      transportNumber: "GR2K923421",
      confirmation: "WRONG" as "PERMANENT_DELETE",
      connectionId: "w200"
    }),
    /confirmation must be PERMANENT_DELETE/
  )
  await assert.rejects(
    tools.deleteDdicObject({
      objectType: "DOMA",
      objectName: "ZCMCP_DOM_0300",
      expectedVersion: created.version,
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      confirmation: "WRONG" as "PERMANENT_DELETE",
      connectionId: "w200"
    }),
    /confirmation must be PERMANENT_DELETE/
  )
})

test("controlled source deletion resolves an empty ECC search package from TADIR", async () => {
  const backend = new MockBackend()
  const searchObjects = backend.searchObjects.bind(backend)
  backend.searchObjects = async (connectionId, pattern, types, maxResults) =>
    (await searchObjects(connectionId, pattern, types, maxResults)).map((object) =>
      object.name === "ZCL_DEMO" ? { ...object, package: "" } : object
    )

  const deleted = JSON.parse(
    await new ToolService(backend).deleteSourceObject({
      objectType: "CLAS/OC",
      objectName: "ZCL_DEMO",
      expectedFingerprint: zclDemoFingerprint,
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      confirmation: "PERMANENT_DELETE",
      connectionId: "w200"
    })
  ) as { absenceVerified: boolean; packageName: string }

  assert.equal(deleted.absenceVerified, true)
  assert.equal(deleted.packageName, "ZABAP")
  assert.equal(backend.lastRepositoryRequest?.objectType, "CLAS")
})

test("controlled deletion rejects wrong package, parent, and DDIC dependencies", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)

  await assert.rejects(
    tools.deleteSourceObject({
      objectType: "CLAS/OC",
      objectName: "ZCL_DEMO",
      expectedFingerprint: zclDemoFingerprint,
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      confirmation: "PERMANENT_DELETE",
      connectionId: "w200"
    }),
    /PACKAGE_CONFLICT/
  )

  const searchObjects = backend.searchObjects.bind(backend)
  backend.searchObjects = async (connectionId, pattern, types, maxResults) => {
    if (pattern === "ZCMCP_FM_0300" || pattern === "LZCMCP_FG_0300F01") {
      return [
        pattern === "ZCMCP_FM_0300"
          ? {
              name: "ZCMCP_FM_0300",
              type: "FUGR/FF",
              description: "Parent validation",
              package: "ZABAP",
              systemType: "CUSTOM",
              uri: "/sap/bc/adt/functions/groups/zcmcp_fg_actual/fmodules/zcmcp_fm_0300"
            }
          : {
              name: "LZCMCP_FG_0300F01",
              type: "PROG/I",
              description: "Technical Include",
              package: "ZABAP",
              systemType: "STANDARD",
              uri: "/sap/bc/adt/functions/groups/zcmcp_fg_0300/includes/lzcmcp_fg_0300f01"
            }
      ]
    }
    return searchObjects(connectionId, pattern, types, maxResults)
  }
  await assert.rejects(
    tools.deleteSourceObject({
      objectType: "FUGR/FF",
      objectName: "ZCMCP_FM_0300",
      parentName: "ZCMCP_FG_WRONG",
      expectedFingerprint: "a".repeat(64),
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      confirmation: "PERMANENT_DELETE",
      connectionId: "w200"
    }),
    /PARENT_CONFLICT/
  )

  const readSource = backend.readSource.bind(backend)
  backend.readSource = async (connectionId, object) =>
    object.name === "LZCMCP_FG_0300F01"
      ? { source: "FORM example.\nENDFORM.", uriUsed: `${object.uri}/source/main` }
      : readSource(connectionId, object)
  const deletedInclude = JSON.parse(
    await tools.deleteSourceObject({
      objectType: "FUGR/I",
      objectName: "F01",
      parentName: "ZCMCP_FG_0300",
      expectedFingerprint: createHash("sha256").update("FORM example.\nENDFORM.").digest("hex"),
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      confirmation: "PERMANENT_DELETE",
      connectionId: "w200"
    })
  ) as { objectName: string; parentName: string; absenceVerified: boolean }
  assert.deepEqual(deletedInclude, {
    connectionId: "w200",
    objectType: "FUGR/I",
    objectName: "LZCMCP_FG_0300F01",
    parentName: "ZCMCP_FG_0300",
    packageName: "ZABAP",
    transportNumber: "GR2K923421",
    preDeleteFingerprint: createHash("sha256").update("FORM example.\nENDFORM.").digest("hex"),
    absenceVerified: true,
    status: "SOURCE_OBJECT_DELETED"
  })

  const created = JSON.parse(
    await tools.upsertDdicDomain({
      objectName: "ZCMCP_DEP_0300",
      description: "Dependency validation",
      dataType: "CHAR",
      length: 10,
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      connectionId: "w200"
    })
  ) as { version: string }
  const callSapDdic = backend.callSapDdic.bind(backend)
  backend.callSapDdic = async (connectionId, request) => {
    if (request.operation === "DELETE_DOMAIN") {
      return {
        status: "E",
        code: "DEPENDENCIES_EXIST",
        message: "DDIC object is still referenced",
        version: "1.4",
        packageName: "ZABAP",
        objectVersion: created.version,
        recordedRequest: "",
        header: {},
        fixedValues: [],
        fields: []
      }
    }
    return callSapDdic(connectionId, request)
  }
  await assert.rejects(
    tools.deleteDdicObject({
      objectType: "DOMA",
      objectName: "ZCMCP_DEP_0300",
      expectedVersion: created.version,
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      confirmation: "PERMANENT_DELETE",
      connectionId: "w200"
    }),
    /DEPENDENCIES_EXIST/
  )

  const unverifiableBackend = new MockBackend()
  unverifiableBackend.sourceObjectExists = async () => true
  await assert.rejects(
    new ToolService(unverifiableBackend).deleteSourceObject({
      objectType: "CLAS/OC",
      objectName: "ZCL_DEMO",
      expectedFingerprint: zclDemoFingerprint,
      packageName: "ZVALIDATION",
      transportNumber: "GR2K923421",
      confirmation: "PERMANENT_DELETE",
      connectionId: "w200"
    }),
    /deletion verification still found/
  )
})

test("function module tools create, read, fingerprint, inspect, and reject unsafe inputs", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)
  const standard = JSON.parse(
    await tools.readFunctionModuleInterface({
      functionName: "RFC_READ_TABLE",
      connectionId: "w200"
    })
  ) as { functionName: string; remoteEnabled: boolean; fingerprint: string }
  assert.equal(standard.functionName, "RFC_READ_TABLE")
  assert.equal(standard.remoteEnabled, true)
  assert.match(standard.fingerprint, /^[a-f0-9]{64}$/)

  const input = {
    functionName: "ZCMCP_FM_1502",
    functionGroup: "ZCMCP_FG_1501",
    description: "MCP 0.15 RFC validation",
    remoteEnabled: true,
    importParameters: [{ name: "IV_INPUT", typeName: "CHAR20", passByValue: true }],
    exportParameters: [{ name: "EV_OUTPUT", typeName: "CHAR40", passByValue: true }],
    changingParameters: [],
    tableParameters: [{ name: "CT_ITEMS", typeName: "BAPIRET2" }],
    exceptions: [{ name: "INVALID_INPUT", description: "Input is invalid" }],
    source: ["  CONCATENATE 'MCP:' iv_input INTO ev_output."],
    packageName: "ZABAP",
    transportNumber: "GR2K923421",
    connectionId: "w200"
  }
  const created = JSON.parse(await tools.createFunctionModuleWithInterface(input)) as {
    status: string
    functionGroup: string
    importParameters: Array<{ name: string }>
  }
  assert.equal(created.status, "FUNCTION_MODULE_CREATED")
  assert.equal(created.functionGroup, "ZCMCP_FG_1501")
  assert.equal(created.importParameters[0]?.name, "IV_INPUT")
  assert.ok(backend.lastRepositoryRequest?.source?.includes("T|1|DBSTRUCT|BAPIRET2"))
  assert.ok(!backend.lastRepositoryRequest?.source?.includes("T|1|TYP|BAPIRET2"))

  const reread = JSON.parse(
    await tools.readFunctionModuleInterface({
      functionName: input.functionName,
      connectionId: "w200"
    })
  ) as { fingerprint: string; source: string[] }
  assert.ok(reread.source.includes(input.source[0]!))
  assert.match(reread.fingerprint, /^[a-f0-9]{64}$/)

  const assignment = JSON.parse(
    await tools.inspectRepositoryAssignment({
      objectName: input.functionName,
      objectType: "FUGR/FF",
      connectionId: "w200"
    })
  ) as { packageName: string; requestNumber: string; taskNumber: string }
  assert.equal(assignment.packageName, "ZABAP")
  assert.equal(assignment.requestNumber, "GR2K923421")
  assert.equal(assignment.taskNumber, "GR2K923422")
  assert.equal(backend.lastRepositoryRequest?.objectType, "FUNC")

  await tools.inspectRepositoryAssignment({
    objectName: input.functionGroup,
    objectType: "FUGR/F",
    connectionId: "w200"
  })
  assert.equal(backend.lastRepositoryRequest?.objectType, "FGRP")

  await assert.rejects(tools.createFunctionModuleWithInterface(input), /FUNCTION_EXISTS/)
  await assert.rejects(
    tools.createFunctionModuleWithInterface({ ...input, functionName: "RFC_READ_TABLE" }),
    /Z\* or Y\*/
  )
  await assert.rejects(
    tools.createFunctionModuleWithInterface({
      ...input,
      functionName: "ZCMCP_FM_DUP",
      exportParameters: [{ name: "IV_INPUT", typeName: "CHAR40" }]
    }),
    /Duplicate function interface name/
  )
  await assert.rejects(
    tools.createFunctionModuleWithInterface({
      ...input,
      functionName: "ZCMCP_FM_TYPE",
      importParameters: [{ name: "IV_INPUT", typeName: "TYPE STRING" }]
    }),
    /not a valid SAP Dictionary name/
  )
  await assert.rejects(
    tools.createFunctionModuleWithInterface({
      ...input,
      functionName: "ZCMCP_FM_TRAN",
      transportNumber: ""
    }),
    /existing 10-character SAP request or task/
  )
})

test("remote function test validates the active interface and exact outcomes", async () => {
  const tools = new ToolService(new MockBackend())
  const passed = JSON.parse(
    await tools.testRemoteFunctionModule({
      functionName: "ZCMCP_FM_1501",
      inputParameters: { IV_INPUT: "VALIDATION" },
      expectedOutputs: { EV_OUTPUT: "MCP:VALIDATION" },
      acknowledgePotentialSideEffects: true,
      connectionId: "w200"
    })
  ) as { status: string; outputs: Record<string, string> }
  assert.equal(passed.status, "passed")
  assert.equal(passed.outputs.EV_OUTPUT, "MCP:VALIDATION")

  const exception = JSON.parse(
    await tools.testRemoteFunctionModule({
      functionName: "ZCMCP_FM_1501",
      inputParameters: { IV_INPUT: "" },
      expectedException: "INVALID_INPUT",
      acknowledgePotentialSideEffects: true,
      connectionId: "w200"
    })
  ) as { status: string; expectedException: string }
  assert.equal(exception.status, "passed")
  assert.equal(exception.expectedException, "INVALID_INPUT")

  await assert.rejects(
    tools.testRemoteFunctionModule({
      functionName: "RFC_READ_TABLE",
      inputParameters: {},
      expectedOutputs: { DATA: "" },
      acknowledgePotentialSideEffects: true,
      connectionId: "w200"
    }),
    /Z\* or Y\*/
  )
  await assert.rejects(
    tools.testRemoteFunctionModule({
      functionName: "ZCMCP_FM_1501",
      inputParameters: { UNKNOWN: "X" },
      expectedOutputs: { EV_OUTPUT: "MCP:X" },
      acknowledgePotentialSideEffects: true,
      connectionId: "w200"
    }),
    /Unknown input parameter/
  )
  await assert.rejects(
    tools.testRemoteFunctionModule({
      functionName: "ZCMCP_FM_1501",
      inputParameters: { IV_INPUT: "VALIDATION" },
      expectedOutputs: { EV_OUTPUT: "WRONG" },
      acknowledgePotentialSideEffects: true,
      connectionId: "w200"
    }),
    /Output assertion failed/
  )

  const oversizedBackend = new MockBackend()
  oversizedBackend.callRemoteFunction = async () => ({
    outputs: { EV_OUTPUT: "X".repeat(4097) }
  })
  await assert.rejects(
    new ToolService(oversizedBackend).testRemoteFunctionModule({
      functionName: "ZCMCP_FM_1501",
      inputParameters: { IV_INPUT: "VALIDATION" },
      expectedOutputs: { EV_OUTPUT: "MCP:VALIDATION" },
      acknowledgePotentialSideEffects: true,
      connectionId: "w200"
    }),
    /outputs\.EV_OUTPUT exceeds 4096 characters/
  )
})

test("structured remote function validation resolves DDIC shapes and protects the interface", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)
  const metadata = JSON.parse(
    await tools.readFunctionModuleInterface({
      functionName: "ZCMCP_FM_1801",
      includeExecutionSupport: true,
      connectionId: "w200"
    })
  ) as {
    fingerprint: string
    executionSupport: {
      supported: boolean
      parameters: Array<{ name: string; kind: string; fields?: string[] }>
    }
  }
  assert.equal(metadata.executionSupport.supported, true)
  assert.deepEqual(
    metadata.executionSupport.parameters.map(({ name, kind }) => ({ name, kind })),
    [
      { name: "IS_REQUEST", kind: "structure" },
      { name: "ES_RESPONSE", kind: "structure" },
      { name: "CT_ITEMS", kind: "table" }
    ]
  )
  assert.deepEqual(metadata.executionSupport.parameters[0]?.fields, ["TYPE", "MESSAGE"])

  const passed = JSON.parse(
    await tools.testRemoteFunctionModule({
      functionName: "ZCMCP_FM_1801",
      inputParameters: {},
      structureInputs: { IS_REQUEST: { TYPE: "S", MESSAGE: "VALIDATION" } },
      tableInputs: {
        CT_ITEMS: [
          { TYPE: "S", MESSAGE: "First" },
          { TYPE: "W", MESSAGE: "Second" }
        ]
      },
      expectedStructureOutputs: {
        ES_RESPONSE: { TYPE: "S", MESSAGE: "MCP:VALIDATION" }
      },
      expectedTableOutputs: {
        CT_ITEMS: [
          { TYPE: "S", MESSAGE: "ROW:First" },
          { TYPE: "W", MESSAGE: "ROW:Second" }
        ]
      },
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true,
      connectionId: "w200"
    })
  ) as {
    status: string
    structureOutputs: Record<string, Record<string, string>>
    tableOutputs: Record<string, Array<Record<string, string>>>
  }
  assert.equal(passed.status, "passed")
  assert.equal(passed.structureOutputs.ES_RESPONSE?.MESSAGE, "MCP:VALIDATION")
  assert.equal(passed.tableOutputs.CT_ITEMS?.[1]?.MESSAGE, "ROW:Second")

  const callsBeforeRejections = backend.remoteFunctionCalls
  await assert.rejects(
    tools.testRemoteFunctionModule({
      functionName: "ZCMCP_FM_1801",
      inputParameters: {},
      structureInputs: { IS_REQUEST: { TYPE: "S", MESSAGE: "VALIDATION" } },
      expectedStructureOutputs: {
        ES_RESPONSE: { TYPE: "S", MESSAGE: "MCP:VALIDATION" }
      },
      acknowledgePotentialSideEffects: true,
      connectionId: "w200"
    }),
    /expectedInterfaceFingerprint is required/
  )
  await assert.rejects(
    tools.testRemoteFunctionModule({
      functionName: "ZCMCP_FM_1801",
      inputParameters: {},
      structureInputs: { IS_REQUEST: { UNKNOWN: "X" } },
      expectedStructureOutputs: { ES_RESPONSE: { MESSAGE: "MCP:X" } },
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true,
      connectionId: "w200"
    }),
    /Unknown field IS_REQUEST\.UNKNOWN/
  )
  await assert.rejects(
    tools.testRemoteFunctionModule({
      functionName: "ZCMCP_FM_1801",
      inputParameters: {},
      structureInputs: { IS_REQUEST: { TYPE: "S", MESSAGE: "VALIDATION" } },
      expectedStructureOutputs: { ES_RESPONSE: { MESSAGE: "MCP:VALIDATION" } },
      expectedInterfaceFingerprint: "0".repeat(64),
      acknowledgePotentialSideEffects: true,
      connectionId: "w200"
    }),
    /Function interface fingerprint changed/
  )
  assert.equal(backend.remoteFunctionCalls, callsBeforeRejections)

  const exception = JSON.parse(
    await tools.testRemoteFunctionModule({
      functionName: "ZCMCP_FM_1801",
      inputParameters: {},
      structureInputs: { IS_REQUEST: { TYPE: "E", MESSAGE: "" } },
      expectedException: "INVALID_INPUT",
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true,
      connectionId: "w200"
    })
  ) as { status: string; expectedException: string }
  assert.equal(exception.status, "passed")
  assert.equal(exception.expectedException, "INVALID_INPUT")
})

test("allowlisted customer RFC invocation supports table-type parameters and receipts", async () => {
  const backend = new MockBackend()
  const receiptRoot = await mkdtemp(join(tmpdir(), "abap-mcp-rfc-receipts-"))
  const receipts = new InvocationReceiptStore(receiptRoot, "tools-test")
  const tools = new ToolService(backend, undefined, receipts)
  const metadata = JSON.parse(
    await tools.readFunctionModuleInterface({
      functionName: "ZCMCP_FM_1901",
      includeExecutionSupport: true,
      connectionId: "w200"
    })
  ) as {
    fingerprint: string
    executionSupport: {
      supported: boolean
      parameters: Array<{ name: string; direction: string; kind: string; fields?: string[] }>
    }
  }
  assert.equal(metadata.executionSupport.supported, true)
  assert.deepEqual(
    metadata.executionSupport.parameters.map(({ name, direction, kind }) => ({
      name,
      direction,
      kind
    })),
    [
      { name: "IT_ITEMS", direction: "import", kind: "table" },
      { name: "ET_ITEMS", direction: "export", kind: "table" }
    ]
  )

  const completed = JSON.parse(
    await tools.invokeCustomerFunctionModule({
      functionName: "ZCMCP_FM_1901",
      requestId: "test-1901-valid",
      tableInputs: {
        IT_ITEMS: [
          { TYPE: "S", MESSAGE: "FIRST" },
          { TYPE: "W", MESSAGE: "SECOND" }
        ]
      },
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true,
      connectionId: "w200"
    })
  ) as {
    status: string
    tableOutputs: Record<string, Array<Record<string, string>>>
    callReceipt: {
      requestId: string
      inputHash: string
      outputHash: string
      persistentState: string
    }
    automaticRetry: boolean
  }
  assert.equal(completed.status, "completed")
  assert.equal(completed.tableOutputs.ET_ITEMS?.[0]?.MESSAGE, "MCP:FIRST")
  assert.equal(completed.tableOutputs.ET_ITEMS?.[1]?.MESSAGE, "MCP:SECOND")
  assert.equal(completed.callReceipt.requestId, "test-1901-valid")
  assert.match(completed.callReceipt.inputHash, /^[a-f0-9]{64}$/)
  assert.match(completed.callReceipt.outputHash, /^[a-f0-9]{64}$/)
  assert.equal(completed.callReceipt.persistentState, "completed")
  assert.equal(completed.automaticRetry, false)

  const completedStatus = JSON.parse(
    await tools.getCustomerFunctionCallStatus({
      requestId: "test-1901-valid",
      connectionId: "w200"
    })
  ) as { status: string; outputHash: string }
  assert.equal(completedStatus.status, "completed")
  assert.equal(completedStatus.outputHash, completed.callReceipt.outputHash)

  const callsBeforeDuplicate = backend.remoteFunctionCalls
  const duplicate = JSON.parse(
    await tools.invokeCustomerFunctionModule({
      functionName: "ZCMCP_FM_1901",
      requestId: "test-1901-valid",
      tableInputs: {
        IT_ITEMS: [
          { TYPE: "S", MESSAGE: "FIRST" },
          { TYPE: "W", MESSAGE: "SECOND" }
        ]
      },
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true,
      connectionId: "w200"
    })
  ) as { status: string; sapInvoked: boolean }
  assert.equal(duplicate.status, "duplicate_blocked")
  assert.equal(duplicate.sapInvoked, false)
  assert.equal(backend.remoteFunctionCalls, callsBeforeDuplicate)

  const conflict = JSON.parse(
    await tools.invokeCustomerFunctionModule({
      functionName: "ZCMCP_FM_1901",
      requestId: "test-1901-valid",
      tableInputs: { IT_ITEMS: [{ TYPE: "S", MESSAGE: "CHANGED" }] },
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true,
      connectionId: "w200"
    })
  ) as { status: string; sapInvoked: boolean }
  assert.equal(conflict.status, "request_id_conflict")
  assert.equal(conflict.sapInvoked, false)
  assert.equal(backend.remoteFunctionCalls, callsBeforeDuplicate)

  const fault = JSON.parse(
    await tools.invokeCustomerFunctionModule({
      functionName: "ZCMCP_FM_1901",
      requestId: "test-1901-invalid",
      tableInputs: { IT_ITEMS: [] },
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true,
      connectionId: "w200"
    })
  ) as { status: string; fault: { name: string }; automaticRetry: boolean }
  assert.equal(fault.status, "fault")
  assert.equal(fault.fault.name, "INVALID_INPUT")
  assert.equal(fault.automaticRetry, false)

  const callsBeforeRejections = backend.remoteFunctionCalls
  await assert.rejects(
    tools.invokeCustomerFunctionModule({
      functionName: "ZCMCP_FM_1901",
      requestId: "test-1901-fingerprint",
      tableInputs: { IT_ITEMS: [{ TYPE: "S", MESSAGE: "FIRST" }] },
      expectedInterfaceFingerprint: "0".repeat(64),
      acknowledgePotentialSideEffects: true,
      connectionId: "w200"
    }),
    /Function interface fingerprint changed/
  )
  await assert.rejects(
    tools.invokeCustomerFunctionModule({
      functionName: "ZCMCP_FM_1901",
      requestId: "test-1901-field",
      tableInputs: { IT_ITEMS: [{ UNKNOWN: "X" }] },
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true,
      connectionId: "w200"
    }),
    /Unknown field IT_ITEMS\.UNKNOWN/
  )
  await assert.rejects(
    tools.invokeCustomerFunctionModule({
      functionName: "ZCMCP_FM_1901",
      requestId: "test-1901-rows",
      tableInputs: { IT_ITEMS: Array.from({ length: 201 }, () => ({})) },
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true,
      connectionId: "w200"
    }),
    /exceeds 200 rows/
  )
  await assert.rejects(
    tools.invokeCustomerFunctionModule({
      functionName: "ZCMCP_FM_1901",
      requestId: "contains spaces",
      tableInputs: { IT_ITEMS: [{ TYPE: "S", MESSAGE: "FIRST" }] },
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true,
      connectionId: "w200"
    }),
    /requestId must contain/
  )
  await assert.rejects(
    tools.invokeCustomerFunctionModule({
      functionName: "ZCMCP_FM_1901",
      requestId: "test-1901-duplicate",
      tableInputs: {
        IT_ITEMS: [{ TYPE: "S", MESSAGE: "FIRST" }],
        it_items: [{ TYPE: "W", MESSAGE: "SECOND" }]
      },
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true,
      connectionId: "w200"
    }),
    /Duplicate tableInputs parameter: IT_ITEMS/
  )
  assert.equal(backend.remoteFunctionCalls, callsBeforeRejections)

  const deniedBackend = new MockBackend()
  deniedBackend.connectionDetails = () => ({
    url: "https://sap.example.invalid",
    client: "200",
    language: "EN",
    username: "DEVELOPER",
    remoteFunctionAllowlist: []
  })
  await assert.rejects(
    new ToolService(deniedBackend, undefined, receipts).invokeCustomerFunctionModule({
      functionName: "ZCMCP_FM_1901",
      requestId: "test-1901-denied",
      tableInputs: { IT_ITEMS: [{ TYPE: "S", MESSAGE: "FIRST" }] },
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true,
      connectionId: "w200"
    }),
    /not listed in remoteFunctionAllowlist/
  )
  assert.equal(deniedBackend.remoteFunctionCalls, 0)

  const undeclaredFaultBackend = new MockBackend()
  undeclaredFaultBackend.callRemoteFunction = async () => ({
    outputs: {},
    fault: { code: "SOAP-ENV:Server", name: "SYSTEM_FAILURE", message: "Unexpected failure" }
  })
  await assert.rejects(
    new ToolService(undeclaredFaultBackend, undefined, receipts).invokeCustomerFunctionModule({
      functionName: "ZCMCP_FM_1901",
      requestId: "test-1901-system-fault",
      tableInputs: { IT_ITEMS: [{ TYPE: "S", MESSAGE: "FIRST" }] },
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true,
      connectionId: "w200"
    }),
    /not a declared function exception/
  )
  const unknownStatus = JSON.parse(
    await new ToolService(
      undeclaredFaultBackend,
      undefined,
      receipts
    ).getCustomerFunctionCallStatus({
      requestId: "test-1901-system-fault",
      connectionId: "w200"
    })
  ) as { status: string }
  assert.equal(unknownStatus.status, "outcome_unknown")

  const networkFailureBackend = new MockBackend()
  networkFailureBackend.callRemoteFunction = async () => {
    throw new Error("simulated network failure")
  }
  const networkFailureTools = new ToolService(networkFailureBackend, undefined, receipts)
  await assert.rejects(
    networkFailureTools.invokeCustomerFunctionModule({
      functionName: "ZCMCP_FM_1901",
      requestId: "test-1901-network-failure",
      tableInputs: { IT_ITEMS: [{ TYPE: "S", MESSAGE: "FIRST" }] },
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true,
      connectionId: "w200"
    }),
    /simulated network failure/
  )
  const networkFailureStatus = JSON.parse(
    await networkFailureTools.getCustomerFunctionCallStatus({
      requestId: "test-1901-network-failure",
      connectionId: "w200"
    })
  ) as { status: string }
  assert.equal(networkFailureStatus.status, "outcome_unknown")

  const receiptFailureBackend = new MockBackend()
  receiptFailureBackend.callRemoteFunction = async () => {
    throw new Error("original SAP network failure")
  }
  const receiptFailureStore = new InvocationReceiptStore(receiptRoot, "receipt-failure")
  receiptFailureStore.markOutcomeUnknown = async () => {
    throw new Error("receipt persistence failure")
  }
  await assert.rejects(
    new ToolService(
      receiptFailureBackend,
      undefined,
      receiptFailureStore
    ).invokeCustomerFunctionModule({
      functionName: "ZCMCP_FM_1901",
      requestId: "test-1901-receipt-write-failure",
      tableInputs: { IT_ITEMS: [{ TYPE: "S", MESSAGE: "FIRST" }] },
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true,
      connectionId: "w200"
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      assert.match(error.message, /original SAP network failure/)
      assert.match(error.message, /receipt persistence failure/)
      return true
    }
  )
  await rm(receiptRoot, { recursive: true, force: true })
})

test("DDIC tools read standard definitions and validate controlled customer writes", async () => {
  const tools = new ToolService(new MockBackend())
  const domain = JSON.parse(
    await tools.readDdicDomain({ objectName: "CHAR10", connectionId: "w200" })
  ) as Record<string, unknown>
  assert.equal(domain.objectKind, "domain")
  assert.equal(domain.version, "20260831120000")
  assert.match(String(domain.fingerprint), /^[a-f0-9]{64}$/)

  const dataElement = JSON.parse(
    await tools.readDdicDataElement({ objectName: "BAPI_MSG", connectionId: "w200" })
  ) as { definition: { domainName: string } }
  assert.equal(dataElement.definition.domainName, "TEXT220")

  const structure = JSON.parse(
    await tools.readDdicStructure({ objectName: "BAPIRET2", connectionId: "w200" })
  ) as { definition: { fields: unknown[] } }
  assert.equal(structure.definition.fields.length, 2)

  const transparentTable = JSON.parse(
    await tools.readDdicTransparentTable({ objectName: "T000", connectionId: "w200" })
  ) as {
    definition: {
      tableClass: string
      deliveryClass: string
      dataBrowserMaintenance: string
      buffering: string
      fields: Array<{ name: string; key: boolean }>
    }
  }
  assert.equal(transparentTable.definition.tableClass, "TRANSP")
  assert.equal(transparentTable.definition.deliveryClass, "S")
  assert.equal(transparentTable.definition.dataBrowserMaintenance, "notAllowed")
  assert.equal(transparentTable.definition.buffering, "notAllowed")
  assert.deepEqual(transparentTable.definition.fields[0], {
    name: "MANDT",
    position: 1,
    dataElement: "MANDT",
    description: "Client",
    key: true,
    notNull: true
  })

  const tableType = JSON.parse(
    await tools.readDdicTableType({ objectName: "BAPIRET2_T", connectionId: "w200" })
  ) as { definition: { rowType: string; accessMode: string } }
  assert.deepEqual(tableType.definition, {
    description: "Return parameters",
    rowType: "BAPIRET2",
    rowKind: "S",
    dataType: "STRU",
    accessMode: "T",
    keyDefinition: "D",
    keyKind: "N"
  })

  const savedDomain = await tools.upsertDdicDomain({
    objectName: "ZCODEX_MCP_DOM_0831",
    description: "Codex test domain",
    dataType: "CHAR",
    length: 10,
    fixedValues: [{ low: "A|B", description: "100% ready" }],
    packageName: "ZABAP",
    transportNumber: "GR2K923421",
    connectionId: "w200"
  })
  assert.match(savedDomain, /"recordedRequest": "GR2K923421"/)

  await tools.upsertDdicDataElement({
    objectName: "ZCODEX_MCP_DE_0831",
    description: "Codex test data element",
    domainName: "ZCODEX_MCP_DOM_0831",
    heading: "Codex value",
    short: "Value",
    medium: "Codex value",
    long: "Codex test value",
    packageName: "ZABAP",
    transportNumber: "GR2K923421",
    connectionId: "w200"
  })
  await tools.upsertDdicStructure({
    objectName: "ZCODEX_MCP_STR_0831",
    description: "Codex test structure",
    fields: [{ name: "VALUE", dataElement: "ZCODEX_MCP_DE_0831" }],
    packageName: "ZABAP",
    transportNumber: "GR2K923421",
    connectionId: "w200"
  })
  const savedTable = await tools.createDdicTransparentTable({
    objectName: "ZCMCP_TAB_0831",
    description: "Codex test transparent table",
    deliveryClass: "A",
    dataClass: "APPL0",
    dataBrowserMaintenance: "notAllowed",
    fields: [
      { name: "MANDT", dataElement: "MANDT", key: true },
      { name: "VALUE", dataElement: "ZCODEX_MCP_DE_0831", key: true },
      { name: "DESCRIPTION", dataElement: "BAPI_MSG" }
    ],
    packageName: "ZABAP",
    transportNumber: "GR2K923421",
    connectionId: "w200"
  })
  assert.match(savedTable, /"tableClass": "TRANSP"/)
  assert.match(savedTable, /"recordedRequest": "GR2K923421"/)
  assert.match(savedTable, /"name": "DESCRIPTION"[\s\S]*"notNull": true/)
  await tools.upsertDdicTableType({
    objectName: "ZCODEX_MCP_TT_0831",
    description: "Codex test table type",
    rowType: "ZCODEX_MCP_STR_0831",
    packageName: "ZABAP",
    transportNumber: "GR2K923421",
    connectionId: "w200"
  })

  await assert.rejects(
    tools.upsertDdicDomain({
      objectName: "CHAR10",
      description: "Not allowed",
      dataType: "CHAR",
      length: 10,
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      connectionId: "w200"
    }),
    /Z\* or Y\*/
  )
  await assert.rejects(
    tools.upsertDdicStructure({
      objectName: "ZCODEX_MCP_STR_0831",
      description: "Duplicate",
      fields: [
        { name: "VALUE", dataElement: "ZCODEX_MCP_DE_0831" },
        { name: "value", dataElement: "ZCODEX_MCP_DE_0831" }
      ],
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      connectionId: "w200"
    }),
    /Duplicate structure field/
  )
  await assert.rejects(
    tools.upsertDdicDomain({
      objectName: "ZCODEX_MCP_DOM_0831",
      description: "Missing version",
      dataType: "CHAR",
      length: 10,
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      connectionId: "w200"
    }),
    /EXPECTED_VERSION_REQUIRED/
  )
  await assert.rejects(
    tools.createDdicTransparentTable({
      objectName: "ZCODEX_MCP_TAB_0831",
      description: "Name too long",
      deliveryClass: "A",
      dataClass: "APPL0",
      dataBrowserMaintenance: "notAllowed",
      fields: [{ name: "MANDT", dataElement: "MANDT", key: true }],
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      connectionId: "w200"
    }),
    /must not exceed 16 characters/
  )
  await assert.rejects(
    tools.createDdicTransparentTable({
      objectName: "ZCMCP_BADKEY",
      description: "Bad key order",
      deliveryClass: "A",
      dataClass: "APPL0",
      dataBrowserMaintenance: "notAllowed",
      fields: [
        { name: "VALUE", dataElement: "BAPI_MSG" },
        { name: "ID", dataElement: "CHAR10", key: true }
      ],
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      connectionId: "w200"
    }),
    /Key fields must be contiguous/
  )
  await assert.rejects(
    tools.createDdicTransparentTable({
      objectName: "ZCMCP_BADMANDT",
      description: "Bad client field",
      deliveryClass: "A",
      dataClass: "APPL0",
      dataBrowserMaintenance: "notAllowed",
      fields: [{ name: "MANDT", dataElement: "MANDT" }],
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      connectionId: "w200"
    }),
    /MANDT must be the first key field/
  )
  await assert.rejects(
    tools.createDdicTransparentTable({
      objectName: "T000",
      description: "Not allowed",
      deliveryClass: "A",
      dataClass: "APPL0",
      dataBrowserMaintenance: "notAllowed",
      fields: [{ name: "MANDT", dataElement: "MANDT", key: true }],
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      connectionId: "w200"
    }),
    /Z\* or Y\*/
  )
})

test("read-only migration wave exposes URI, search, metadata and history behavior", async () => {
  const tools = new ToolService(new MockBackend())

  const direct = await tools.getObjectByUri({
    uri: "/sap/bc/adt/oo/classes/zcl_demo",
    startLine: 1,
    lineCount: 2,
    connectionId: "w200"
  })
  assert.match(direct, /Direct URI Access Successful/)
  assert.match(direct, /METHOD run\./)

  const search = await tools.searchObjectLines({
    objectName: "ZCL_DEMO",
    searchTerm: "WRITE",
    contextLines: 0,
    connectionId: "w200"
  })
  assert.match(search, /Base Source Matches \(1\)/)
  assert.match(search, /Enhancement Matches \(1\)/)

  const workspace = await tools.getWorkspaceUri({
    objectName: "ZCL_DEMO",
    objectType: "CLAS/OC",
    connectionId: "w200"
  })
  assert.match(workspace, /adt:\/\/w200\/sap\/bc\/adt\/oo\/classes\/zcl_demo/)

  const url = tools.getObjectUrl({
    objectName: "ZCL_DEMO",
    objectType: "CLAS/OC",
    connectionId: "w200"
  })
  assert.match(url, /Transaction: SE24/)
  assert.match(url, /sap-client=200/)

  const whereUsed = await tools.findWhereUsed({
    objectName: "ZCL_DEMO",
    connectionId: "w200",
    includeSnippets: true
  })
  assert.match(whereUsed, /ZREPORT_DEMO/)
  assert.match(whereUsed, /WRITE 'OK'/)

  const system = await tools.getSapSystemInfo({ connectionId: "w200" })
  assert.match(system, /Type: ECC/)
  assert.match(system, /Client: 200 \(Development\)/)
  assert.match(system, /UTC\+8/)

  const history = await tools.getVersionHistory({
    objectName: "ZCL_DEMO",
    objectType: "CLAS/OC",
    connectionId: "w200"
  })
  assert.match(history, /Total Versions: 1/)
  assert.match(history, /W200K900001/)
})

test("diagnostic wave is headless, bounded and read-only", async () => {
  const tools = new ToolService(new MockBackend())

  const diagnostics = await tools.getDiagnostics({
    fileUri: "adt://w200/sap/bc/adt/oo/classes/zcl_demo"
  })
  assert.match(diagnostics, /1 diagnostic/)
  assert.match(diagnostics, /WARNING Line 3, Col 5: Mock warning/)

  assert.match(tools.getAbapSqlSyntax(), /Only one read-only SELECT/)
  const query = await tools.executeDataQuery({
    sql: "SELECT ID, NAME FROM ZDATA",
    displayMode: "internal",
    connectionId: "w200",
    rowRange: { start: 0, end: 2 },
    filters: [{ column: "NAME", value: "AL*" }],
    sortColumns: [{ column: "ID", direction: "asc" }]
  })
  const queryResult = JSON.parse(query) as {
    resultCount: number
    data: Array<{ ID: string }>
  }
  assert.equal(queryResult.resultCount, 2)
  assert.deepEqual(
    queryResult.data.map((row) => row.ID),
    ["1", "3"]
  )
  await assert.rejects(
    tools.executeDataQuery({
      sql: "UPDATE ZDATA SET NAME = 'X'",
      displayMode: "internal",
      connectionId: "w200",
      rowRange: { start: 0, end: 1 }
    }),
    /Only read-only SELECT/
  )
  await assert.rejects(
    tools.executeDataQuery({
      sql: "SELECT ID FROM ZDATA",
      displayMode: "ui",
      connectionId: "w200"
    }),
    /does not support displayMode=ui/
  )
  assert.equal(
    validateReadOnlySql("SELECT TEXT FROM ZDATA WHERE TEXT = 'DELETE'"),
    "SELECT TEXT FROM ZDATA WHERE TEXT = 'DELETE'"
  )

  const atc = await tools.runAtcAnalysis({
    objectName: "ZCL_DEMO",
    connectionId: "w200"
  })
  assert.match(atc, /Check Variant: DEFAULT/)
  assert.match(atc, /Mock ATC finding/)
  const atcDoc = await tools.runAtcAnalysis({
    action: "get_documentation",
    connectionId: "w200",
    docUri: "/sap/bc/adt/atc/doc/mock"
  })
  assert.match(atcDoc, /Mock documentation/)

  const unit = await tools.runUnitTests({ objectName: "ZCL_DEMO", connectionId: "w200" })
  assert.match(unit, /ALL TESTS PASSED/)
  assert.match(unit, /Activation: not performed/)

  const dumps = await tools.analyzeDumps({ action: "list_dumps", connectionId: "w200" })
  assert.match(dumps, /OBJECTS_OBJREF_NOT_ASSIGNED/)
  const dump = await tools.analyzeDumps({
    action: "analyze_dump",
    connectionId: "w200",
    dumpId: "DUMP-1",
    includeFullContent: true
  })
  assert.match(dump, /Full Dump Content/)

  const traces = await tools.analyzeTraces({ action: "list_runs", connectionId: "w200" })
  assert.match(traces, /Mock trace/)
  const statements = await tools.analyzeTraces({
    action: "get_statements",
    connectionId: "w200",
    traceId: "/sap/bc/adt/runtime/traces/abaptraces/TRACE-1"
  })
  assert.match(statements, /METHOD RUN/)
})

test("controlled write wave performs exact replacement and activation through the backend", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)
  const fileUri = "adt://w200/sap/bc/adt/oo/classes/zcl_demo/source/main"

  const result = await tools.replaceStringInObject({
    fileUri,
    oldString: "  METHOD run.\n    WRITE 'HEADLESS'.\n  ENDMETHOD.",
    newString: "  METHOD run.\n    WRITE 'STANDALONE'.\n  ENDMETHOD.",
    transportNumber: "W200K900001"
  })
  assert.match(result, /Saved, unlocked, and activated ZCL_DEMO/)
  assert.match(result, /Transport: W200K900001/)

  const source = await backend.readSourceByUri("w200", fileUri)
  assert.match(source.source, /WRITE 'STANDALONE'/)
  assert.equal(await tools.activateObject({ url: fileUri }), `Activation successful for ${fileUri}`)
})

test("object creation wave exposes headless create and test-include workflows", async () => {
  const tools = new ToolService(new MockBackend())
  const created = await tools.createObject({
    objectType: "CLAS/OC",
    name: "ZCL_CREATED",
    description: "Created without VS Code",
    packageName: "$TMP",
    connectionId: "w200"
  })
  assert.match(created, /ABAP Object Created Successfully/)
  assert.match(created, /Name: ZCL_CREATED/)
  assert.match(created, /Status: created and activated/)
  assert.match(created, /adt:\/\/w200\/sap\/bc\/adt\/oo\/classes\/zcl_created/)

  const testInclude = await tools.createTestInclude({
    className: "ZCL_DEMO",
    connectionId: "w200"
  })
  assert.match(testInclude, /created and activated for ZCL_DEMO/)
  assert.match(testInclude, /includes\/testclasses/)
  assert.match(testInclude, /W200K900001/)
})

test("text element wave reads and merges customer text symbols", async () => {
  const tools = new ToolService(new MockBackend())
  const initial = await tools.manageTextElements({
    objectName: "ZREPORT_DEMO",
    objectType: "PROGRAM",
    action: "read",
    connectionId: "w200"
  })
  assert.match(initial, /001: "Existing text" \(max: 20\)/)

  const created = await tools.manageTextElements({
    objectName: "ZREPORT_DEMO",
    objectType: "PROGRAM",
    action: "create",
    textElements: [{ id: "002", text: "Created text", maxLength: 20 }],
    connectionId: "w200"
  })
  assert.match(created, /Changed IDs: 002/)
  assert.match(created, /Total after merge: 2/)
  assert.match(created, /saved and verified/)
})

test("program text element helper rejects duplicate IDs and invalid create-update states", async () => {
  const tools = new ToolService(new MockBackend())
  await assert.rejects(
    tools.manageTextElements({
      objectName: "ZREPORT_DEMO",
      objectType: "PROGRAM",
      action: "create",
      textElements: [
        { id: "002", text: "First" },
        { id: "002", text: "Second" }
      ],
      connectionId: "w200"
    }),
    /Duplicate text element ID/
  )
  await assert.rejects(
    tools.manageTextElements({
      objectName: "ZREPORT_DEMO",
      objectType: "PROGRAM",
      action: "create",
      textElements: [{ id: "A", text: "Invalid" }],
      connectionId: "w200"
    }),
    /must contain exactly 3 characters/
  )
  await assert.rejects(
    tools.manageTextElements({
      objectName: "ZREPORT_DEMO",
      objectType: "PROGRAM",
      action: "create",
      textElements: [{ id: "001", text: "Already exists" }],
      connectionId: "w200"
    }),
    /TEXT_ELEMENT_EXISTS/
  )
  await assert.rejects(
    tools.manageTextElements({
      objectName: "ZREPORT_DEMO",
      objectType: "PROGRAM",
      action: "update",
      textElements: [{ id: "999", text: "Missing" }],
      connectionId: "w200"
    }),
    /TEXT_ELEMENT_NOT_FOUND/
  )
})

test("text element merge distinguishes create from update and preserves unrelated symbols", () => {
  const existing = [{ id: "001", text: "Existing", maxLength: 20 }]
  assert.deepEqual(mergeTextElementChanges(existing, [{ id: "002", text: "Created" }], "create"), [
    { id: "001", text: "Existing", maxLength: 20 },
    { id: "002", text: "Created", maxLength: 10 }
  ])
  assert.deepEqual(mergeTextElementChanges(existing, [{ id: "001", text: "Updated" }], "update"), [
    { id: "001", text: "Updated", maxLength: 10 }
  ])
  assert.throws(
    () => mergeTextElementChanges(existing, [{ id: "001", text: "Duplicate" }], "create"),
    /already exists/
  )
  assert.throws(
    () => mergeTextElementChanges(existing, [{ id: "002", text: "Missing" }], "update"),
    /does not exist/
  )
})

test("ADT text element write locks, merges, saves, unlocks, activates, and verifies", async () => {
  const calls: string[] = []
  let stored = [{ id: "001", text: "Existing", maxLength: 20 }]
  const result = await writeTextElementsWithClient(
    {
      httpClient: {
        async request(uri: string, options: { qs?: Record<string, string> }) {
          calls.push(`lock:${uri}`)
          assert.equal(options.qs?._action, "LOCK")
          return {
            body: `<abap><values><DATA><LOCK_HANDLE>LOCK</LOCK_HANDLE><CORRNR></CORRNR><IS_LOCAL>X</IS_LOCAL></DATA></values></abap>`,
            status: 200,
            statusText: "OK",
            headers: {}
          }
        }
      },
      async getTextElements() {
        calls.push("read")
        return { programName: "zreport_demo", textElements: stored }
      },
      async setTextElements(
        _uri: string,
        _category: string,
        elements: typeof stored,
        lockHandle: string,
        transport: string
      ) {
        calls.push(`save:${lockHandle}:${transport}`)
        stored = elements
      },
      async unLock() {
        calls.push("unlock")
      },
      async inactiveObjects() {
        calls.push("inactive")
        return []
      },
      async activate() {
        calls.push("activate")
        return { success: true, messages: [], inactive: [] }
      }
    } as never,
    "w200",
    "ZREPORT_DEMO",
    "PROGRAM",
    "create",
    [{ id: "002", text: "Created", maxLength: 10 }]
  )

  assert.equal(result.activation.success, true)
  assert.deepEqual(result.changedIds, ["002"])
  assert.deepEqual(result.textElements, stored)
  assert.deepEqual(calls, [
    "lock:/sap/bc/adt/textelements/programs/zreport_demo",
    "read",
    "save:LOCK:",
    "unlock",
    "inactive",
    "inactive",
    "activate",
    "read"
  ])
})

test("ADT text element write rejects standard objects before requesting a lock", async () => {
  let lockCalls = 0
  await assert.rejects(
    writeTextElementsWithClient(
      {
        httpClient: {
          async request() {
            lockCalls++
          }
        }
      } as never,
      "w200",
      "SAPMSSY0",
      "PROGRAM",
      "create",
      [{ id: "001", text: "Forbidden" }]
    ),
    /Z\* or Y\*/
  )
  assert.equal(lockCalls, 0)
})

test("legacy text element lock responses are parsed without exposing the handle", async () => {
  const lock = await lockTextElementsWithClient(
    {
      httpClient: {
        async request() {
          return {
            body: `<legacy><result><LOCK_HANDLE>PRIVATE</LOCK_HANDLE><CORRNR>W200K900001</CORRNR><IS_LOCAL></IS_LOCAL></result></legacy>`,
            status: 200,
            statusText: "OK",
            headers: {}
          }
        }
      }
    } as never,
    "/sap/bc/adt/textelements/programs/zreport_demo"
  )
  assert.equal(lock.LOCK_HANDLE, "PRIVATE")
  assert.equal(lock.CORRNR, "W200K900001")
})

test("empty legacy text element lock responses fail before a write", async () => {
  await assert.rejects(
    lockTextElementsWithClient(
      {
        httpClient: {
          async request() {
            return { body: "", status: 200, statusText: "OK", headers: {} }
          }
        }
      } as never,
      "/sap/bc/adt/textelements/programs/zreport_demo"
    ),
    /does not expose writable text elements through ADT/
  )
})

test("transport wave is read-only and covers list, details, objects, and comparison", async () => {
  const tools = new ToolService(new MockBackend())

  const list = await tools.manageTransportRequests({
    action: "get_user_transports",
    connectionId: "w200"
  })
  assert.match(list, /Transport Requests for User: DEVELOPER/)
  assert.match(list, /W20K900001/)

  const details = await tools.manageTransportRequests({
    action: "get_transport_details",
    connectionId: "w200",
    transportNumber: "w20k900001"
  })
  assert.match(details, /Transport Details: W20K900001/)
  assert.match(details, /ZCL_DEMO/)

  const objects = await tools.manageTransportRequests({
    action: "get_transport_objects",
    connectionId: "w200",
    transportNumber: "W20K900001"
  })
  assert.match(objects, /R3TR CLAS ZCL_DEMO/)

  const comparison = await tools.manageTransportRequests({
    action: "compare_transports",
    connectionId: "w200",
    transportNumbers: ["W20K900001", "W20K900002"]
  })
  assert.match(comparison, /Transport Comparison: W20K900001 vs W20K900002/)
  assert.match(comparison, /COMMON OBJECTS: none/)
  await assert.rejects(
    tools.manageTransportRequests({
      action: "get_transport_details",
      connectionId: "w200",
      transportNumber: "../invalid"
    }),
    /Invalid transport number/
  )

  const incompatibleBackend = new MockBackend()
  incompatibleBackend.transportDetails = async () =>
    ({ objects: [], tasks: [] }) as unknown as Awaited<ReturnType<MockBackend["transportDetails"]>>
  await assert.rejects(
    new ToolService(incompatibleBackend).manageTransportRequests({
      action: "get_transport_details",
      connectionId: "w200",
      transportNumber: "W20K900001"
    }),
    /SAP returned no transport number.*not compatible/
  )
})

test("headless export wave writes bounded local artifacts without editor state", async () => {
  const root = await mkdtemp(join(tmpdir(), "abap-mcp-export-"))
  const target = join(root, "download")
  const exportRoot = join(root, "new-exports-folder")
  const tools = new ToolService(new MockBackend(), exportRoot)
  try {
    const download = await tools.downloadResource({
      source: "adt://w200/sap/bc/adt/oo/classes/zcl_demo",
      target
    })
    assert.match(download, /Files: 1/)
    assert.match(
      await readFile(join(target, "CLAS_OC", "ZCL_DEMO", "main.abap"), "utf8"),
      /WRITE 'HEADLESS'/
    )
    await assert.rejects(
      tools.downloadResource({
        source: "ZCL_DEMO",
        objectType: "CLAS/OC",
        connectionId: "w200",
        target
      }),
      /Target already exists/
    )

    const discovery = await tools.exportAdtDiscovery({ connectionId: "w200" })
    assert.match(discovery, /Files created:/)
    const folder = (await readdir(exportRoot)).find((name) =>
      name.startsWith("adt-discovery_w200_")
    )
    assert.ok(folder)
    assert.match(await readFile(join(exportRoot, folder, "workspaces.md"), "utf8"), /Repository/)
    assert.match(
      await readFile(join(exportRoot, folder, "res-app-classes.md"), "utf8"),
      /CL_ADT_RES_APP/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("exact replacement rejects stale, duplicate, no-op, and nonblank empty matches", () => {
  assert.equal(findAndReplaceSource("A\r\nB", "A\nB", "C\nD"), "C\r\nD")
  assert.throws(() => findAndReplaceSource("A A", "A", "B"), /2 occurrences/)
  assert.throws(() => findAndReplaceSource("A", "B", "C"), /Could not find/)
  assert.throws(() => findAndReplaceSource("A", "A", "A"), /identical/)
  assert.throws(() => findAndReplaceSource("A", "", "B"), /completely blank/)
  assert.equal(findAndReplaceSource("", "", "REPORT zblank."), "REPORT zblank.")
})

test("method extraction ignores comments and uses 1-based line numbers", () => {
  const result = extractMethod(
    ["* METHOD RUN.", "METHOD run.", "  WRITE 'X'.", "ENDMETHOD."],
    "run"
  )
  assert.deepEqual(result, {
    code: ["METHOD run.", "  WRITE 'X'.", "ENDMETHOD."],
    startLine: 2,
    endLine: 4
  })
})

test("DDIC query names reject SQL metacharacters", () => {
  assert.equal(sanitizeObjectName("ztable_demo"), "ZTABLE_DEMO")
  assert.throws(() => sanitizeObjectName("ZTABLE' OR '1'='1"), /Invalid object name/)
})

test("DDIC table fallback formats fields and append metadata", async () => {
  const queries: string[] = []
  const client = {
    async getObjectSource() {
      throw new Error("No DDL source")
    },
    async runQuery(sql: string) {
      queries.push(sql)
      if (sql.includes("FROM DD03M")) {
        return {
          values: [
            {
              FIELDNAME: "MANDT",
              INTTYPE: "C",
              INTLEN: "3",
              KEYFLAG: "X",
              DDTEXT: "Client"
            }
          ]
        }
      }
      if (sql.includes("FROM DD02L")) {
        return { values: [{ TABNAME: "ZTABLE_DEMO_A" }] }
      }
      return { values: [{ CNT: "2" }] }
    }
  }
  const object: AbapObjectInfo = {
    name: "ZTABLE_DEMO",
    type: "TABL/DT",
    description: "Demo",
    package: "ZVALIDATION",
    systemType: "CUSTOM",
    uri: "/sap/bc/adt/ddic/tables/ztable_demo"
  }

  const result = await readDictionaryObject(client, object)
  assert.equal(result?.kind, "dictionary")
  assert.equal(result?.appendCount, 1)
  assert.match(result?.source ?? "", /MANDT: C\(3\) - Client \[KEY\]/)
  assert.match(result?.source ?? "", /ZTABLE_DEMO_A \(2 fields\)/)
  assert.equal(queries.length, 3)
})

test("real ADT include types resolve to source/main", () => {
  assert.equal(
    optimalSourceUri("PROG/I", "/sap/bc/adt/programs/includes/zinclude"),
    "/sap/bc/adt/programs/includes/zinclude/source/main"
  )
  assert.equal(
    optimalSourceUri("MSAG/N", "/sap/bc/adt/messageclass/zmsg"),
    "/sap/bc/adt/messageclass/zmsg"
  )
})

test("direct ADT URIs are normalized and typed without editor state", () => {
  assert.equal(
    normalizeAdtUri("adt://w200/sap/bc/adt/oo/classes/zcl_demo", "w200"),
    "/sap/bc/adt/oo/classes/zcl_demo"
  )
  assert.equal(detectTypeFromUri("/sap/bc/adt/oo/classes/zcl_demo"), "CLAS/OC")
  assert.throws(() => normalizeAdtUri("file:///tmp/zcl_demo", "w200"), /Invalid ADT URI/)
})

test("empty DDIC source remains a dictionary result", async () => {
  const client = {
    async getObjectSource() {
      return ""
    },
    async runQuery() {
      return { values: [] }
    }
  }
  const result = await readDictionaryObject(client, {
    name: "MARA",
    type: "TABL/DT",
    description: "",
    package: "",
    systemType: "STANDARD",
    uri: "/sap/bc/adt/vit/wb/object_type/tabldt/object_name/mara"
  })

  assert.equal(result?.kind, "dictionary")
  assert.match(result?.source ?? "", /Complete Table Structure for MARA/)
  assert.doesNotMatch(result?.source ?? "", /MAIN TABLE STRUCTURE/)
})

test("unsupported enhancement endpoints preserve no-result behavior", async () => {
  const backend = new AdtBackend([
    {
      id: "w200",
      url: "https://sap.example.invalid",
      client: "200",
      language: "EN",
      username: "VALIDATION",
      passwordEnv: "UNUSED_TEST_PASSWORD",
      allowUnauthorized: false
    }
  ])
  const state = backend as unknown as {
    clients: Map<
      string,
      {
        client: { objectEnhancements(): Promise<never> }
        login: Promise<void>
      }
    >
  }
  state.clients.set("w200", {
    client: {
      async objectEnhancements() {
        throw new Error("Unsupported on ECC 7.31")
      }
    },
    login: Promise.resolve()
  })

  assert.deepEqual(await backend.readEnhancements("w200", "/sap/bc/adt/programs/ztest"), [])
})

test("ADT write coordination locks, saves, unlocks, and activates the exact customer object", async () => {
  const calls: string[] = []
  let inactiveChecks = 0
  const client = {
    stateful: "stateful",
    async inactiveObjects() {
      inactiveChecks++
      return inactiveChecks <= 2
        ? []
        : [
            {
              object: {
                "adtcore:uri": "/sap/bc/adt/oo/classes/zcl_demo",
                "adtcore:type": "CLAS/OC",
                "adtcore:name": "ZCL_DEMO",
                "adtcore:parentUri": "",
                user: "DEVELOPER",
                deleted: false
              }
            }
          ]
    },
    async lock() {
      calls.push("lock")
      return {
        LOCK_HANDLE: "secret-lock",
        CORRNR: "W200K900001",
        CORRUSER: "",
        CORRTEXT: "",
        IS_LOCAL: "",
        IS_LINK_UP: "",
        MODIFICATION_SUPPORT: ""
      }
    },
    async getObjectSource() {
      calls.push("read")
      return "CLASS zcl_demo IMPLEMENTATION.\nENDCLASS."
    },
    async setObjectSource(_uri: string, source: string, _lockHandle: string, transport: string) {
      calls.push(`save:${transport}`)
      assert.match(source, /WRITE 'OK'/)
    },
    async unLock() {
      calls.push("unlock")
      return ""
    },
    async activate() {
      calls.push("activate")
      return { success: true, messages: [], inactive: [] }
    }
  }

  const result = await replaceSourceWithClient(
    client as never,
    "w200",
    "adt://w200/sap/bc/adt/oo/classes/zcl_demo/source/main",
    "CLASS zcl_demo IMPLEMENTATION.",
    "CLASS zcl_demo IMPLEMENTATION.\n  WRITE 'OK'."
  )
  assert.equal(result.activation.success, true)
  assert.deepEqual(calls, ["lock", "read", "save:W200K900001", "unlock", "activate"])
})

test("ADT source deletion compares the fingerprint while holding the SAP lock", async () => {
  const calls: string[] = []
  const object: AbapObjectInfo = {
    name: "ZCL_DEMO",
    type: "CLAS/OC",
    description: "Delete validation",
    package: "ZVALIDATION",
    systemType: "CUSTOM",
    uri: "/sap/bc/adt/oo/classes/zcl_demo"
  }
  const client = {
    async lock() {
      calls.push("lock")
      return { LOCK_HANDLE: "secret-lock" }
    },
    async getObjectSource(uri: string, options?: { version?: string }) {
      calls.push(`read:${uri}`)
      assert.equal(options?.version, "active")
      return zclDemoSource
    },
    async deleteObject(_uri: string, _lockHandle: string, transport: string) {
      calls.push(`delete:${transport}`)
    },
    async unLock() {
      calls.push("unlock")
    }
  }

  await assert.rejects(
    deleteObjectWithClient(client as never, object, "GR2K923421", "f".repeat(64)),
    /SOURCE_FINGERPRINT_CONFLICT/
  )
  assert.deepEqual(calls, ["lock", "read:/sap/bc/adt/oo/classes/zcl_demo/source/main", "unlock"])

  calls.length = 0
  assert.equal(
    await deleteObjectWithClient(client as never, object, "GR2K923421", zclDemoFingerprint),
    zclDemoFingerprint
  )
  assert.deepEqual(calls, [
    "lock",
    "read:/sap/bc/adt/oo/classes/zcl_demo/source/main",
    "delete:GR2K923421"
  ])
})

test("source deletion verification accepts legacy not-found responses and falls back to search", async () => {
  const object = {
    name: "ZCMCP_PRG_0301",
    type: "PROG/P",
    description: "Lifecycle program",
    package: "ZABAP",
    systemType: "CUSTOM" as const,
    uri: "/sap/bc/adt/programs/programs/zcmcp_prg_0301"
  }
  const direct = backendWithInjectedClient()
  injectClient(direct, {
    getObjectSource: async () => {
      throw new Error("Object ZCMCP_PRG_0301 not found")
    }
  })
  assert.equal(await direct.sourceObjectExists("w200", object), false)

  const fallback = backendWithInjectedClient()
  injectClient(fallback, {
    getObjectSource: async () => {
      throw new Error("I::000 MODE SVP 200")
    },
    searchObject: async () => []
  })
  assert.equal(await fallback.sourceObjectExists("w200", object), false)
})

test("controlled edit policy covers customer source families and rejects standard ownership", () => {
  const cases = [
    ["adt://w200/sap/bc/adt/oo/classes/zcl_demo/source/main", "class", "ZCL_DEMO"],
    ["adt://w200/sap/bc/adt/oo/classes/zcl_demo/includes/testclasses", "class", "ZCL_DEMO"],
    ["adt://w200/sap/bc/adt/oo/interfaces/zif_demo", "interface", "ZIF_DEMO"],
    ["adt://w200/sap/bc/adt/programs/programs/zdemo", "program", "ZDEMO"],
    ["adt://w200/sap/bc/adt/programs/includes/zdemo_f01", "include", "ZDEMO_F01"],
    ["adt://w200/sap/bc/adt/functions/groups/zfg_demo", "function-group", "ZFG_DEMO"],
    [
      "adt://w200/sap/bc/adt/functions/groups/zfg_demo/fmodules/zfm_demo",
      "function-module",
      "ZFM_DEMO"
    ],
    [
      "adt://w200/sap/bc/adt/functions/groups/zfg_demo/includes/lzfg_demotop",
      "function-group-include",
      "LZFG_DEMOTOP"
    ],
    ["adt://w200/sap/bc/adt/ddic/ddl/sources/zddl_demo", "ddl-source", "ZDDL_DEMO"],
    ["adt://w200/sap/bc/adt/acm/dcl/sources/zdcl_demo", "dcl-source", "ZDCL_DEMO"]
  ] as const

  for (const [uri, kind, objectName] of cases) {
    const target = resolveEditableSourceTarget(uri, "w200")
    assert.equal(target.kind, kind)
    assert.equal(target.objectName, objectName)
  }

  for (const uri of [
    "adt://w200/sap/bc/adt/oo/classes/cl_standard",
    "adt://w200/sap/bc/adt/programs/programs/sapmstandard",
    "adt://w200/sap/bc/adt/programs/includes/lzfg_demotop",
    "adt://w200/sap/bc/adt/functions/groups/standard/fmodules/zfm_demo",
    "adt://w200/sap/bc/adt/functions/groups/zfg_demo/fmodules/standard",
    "adt://w200/sap/bc/adt/ddic/tables/ztable"
  ]) {
    assert.throws(
      () => resolveEditableSourceTarget(uri, "w200"),
      /Only Z\* or Y\*|Unsupported ABAP source URI/
    )
  }
  assert.throws(
    () =>
      resolveEditableSourceTarget("adt://other/sap/bc/adt/oo/classes/zcl_wrong_connection", "w200"),
    /Invalid ADT URI/
  )
})

test("controlled edit policy rejects standard source before requesting an SAP lock", async () => {
  let lockCalls = 0
  await assert.rejects(
    replaceSourceWithClient(
      {
        stateful: "stateful",
        async lock() {
          lockCalls++
          throw new Error("must not be called")
        }
      } as never,
      "w200",
      "adt://w200/sap/bc/adt/oo/classes/cl_standard/source/main",
      "CLASS cl_standard DEFINITION.",
      "CLASS cl_standard DEFINITION PUBLIC."
    ),
    /Only Z\* or Y\*/
  )
  assert.equal(lockCalls, 0)
})

test("controlled creation policy covers source families and rejects unsafe requests", () => {
  const localCases = [
    ["CLAS/OC", "ZCL_CREATE", undefined],
    ["INTF/OI", "ZIF_CREATE", undefined],
    ["PROG/P", "ZCREATE", undefined],
    ["PROG/I", "ZCREATE_F01", undefined],
    ["FUGR/F", "ZFG_CREATE", undefined],
    ["FUGR/FF", "ZFM_CREATE", "ZFG_CREATE"],
    ["FUGR/I", "TOP", "ZFG_CREATE"],
    ["DDLS/DF", "ZDDL_CREATE", undefined],
    ["DCLS/DL", "ZDCL_CREATE", undefined]
  ] as const
  for (const [objectType, name, parentName] of localCases) {
    const prepared = prepareCreateObjectRequest("W200", {
      objectType,
      name,
      description: "Creation policy test",
      packageName: "$TMP",
      ...(parentName ? { parentName } : {})
    })
    assert.equal(prepared.connectionId, "w200")
    assert.match(prepared.workspaceUri, /^adt:\/\/w200\/sap\/bc\/adt\//)
  }
  assert.equal(
    prepareCreateObjectRequest("w200", {
      objectType: "FUGR/I",
      name: "TOP",
      description: "Technical include",
      parentName: "ZFG_CREATE"
    }).objectName,
    "LZFG_CREATETOP"
  )

  for (const request of [
    { objectType: "CLAS/OC", name: "CL_STANDARD", description: "Standard" },
    {
      objectType: "FUGR/FF",
      name: "ZFM_CREATE",
      description: "Standard parent",
      parentName: "SAPLSTANDARD"
    },
    { objectType: "TABL/DT", name: "ZTABLE", description: "Unsupported structured DDIC" },
    {
      objectType: "CLAS/OC",
      name: "ZCL_CREATE",
      description: "Missing transport",
      packageName: "ZPACKAGE"
    },
    {
      objectType: "CLAS/OC",
      name: "ZCL_CREATE",
      description: "New transport",
      packageName: "ZPACKAGE",
      additionalOptions: { transportRequest: { type: "new" as const, description: "No" } }
    }
  ]) {
    assert.throws(
      () => prepareCreateObjectRequest("w200", request),
      /Z\* or Y\*|Unsupported object type|requires.*existing|Creating transport requests/
    )
  }
})

test("ADT object creation validates capability, creates, verifies, and activates", async () => {
  const calls: string[] = []
  const request = prepareCreateObjectRequest("w200", {
    objectType: "CLAS/OC",
    name: "ZCL_CREATE",
    description: "Standalone class"
  })
  const result = await createObjectWithClient(
    {
      username: "DEVELOPER",
      async loadTypes() {
        calls.push("types")
        return [{ OBJECT_TYPE: "CLAS/OC" }]
      },
      async validateNewObject() {
        calls.push("validate")
        return { success: true }
      },
      async createObject(options: { name: string }) {
        calls.push(`create:${options.name}`)
      },
      async findObjectPath() {
        calls.push("verify")
        return [{ "adtcore:uri": "/sap/bc/adt/oo/classes/zcl_create" }]
      },
      async inactiveObjects() {
        calls.push("inactive")
        return []
      },
      async activate() {
        calls.push("activate")
        return { success: true, messages: [], inactive: [] }
      }
    } as never,
    request,
    "EN"
  )

  assert.equal(result.objectName, "ZCL_CREATE")
  assert.equal(result.activation.success, true)
  assert.deepEqual(calls, [
    "types",
    "validate",
    "create:ZCL_CREATE",
    "verify",
    "inactive",
    "inactive",
    "activate"
  ])
})

test("ADT object creation retries a concrete media type and tolerates legacy index delay", async () => {
  const calls: Array<{ url: string; contentType: string }> = []
  const request = prepareCreateObjectRequest("w200", {
    objectType: "CLAS/OC",
    name: "ZCL_LEGACY_CREATE",
    description: "Legacy class"
  })
  const result = await createObjectWithClient(
    {
      username: "DEVELOPER",
      async loadTypes() {
        return [{ OBJECT_TYPE: "CLAS/OC" }]
      },
      async validateNewObject() {
        return { success: true }
      },
      async createObject() {
        throw new Error("No content handler found for content type 'application/*'")
      },
      httpClient: {
        async request(url: string, options: { headers?: Record<string, string> }) {
          calls.push({ url, contentType: options.headers?.["Content-Type"] ?? "" })
          return { body: "", status: 201, statusText: "Created", headers: {} }
        }
      },
      async findObjectPath() {
        return []
      },
      async inactiveObjects() {
        return []
      },
      async activate() {
        return { success: true, messages: [], inactive: [] }
      }
    } as never,
    request,
    "EN"
  )

  assert.equal(result.activation.success, true)
  assert.deepEqual(calls, [
    {
      url: "/sap/bc/adt/oo/classes",
      contentType: "application/vnd.sap.adt.oo.classes+xml; charset=utf-8"
    }
  ])
})

test("legacy ECC function group creation retries v3 conversion failure with v2", async () => {
  const contentTypes: string[] = []
  const request = prepareCreateObjectRequest("w200", {
    objectType: "FUGR/F",
    name: "ZFG_LEGACY_CREATE",
    description: "Legacy function group"
  })
  const result = await createObjectWithClient(
    {
      username: "DEVELOPER",
      async loadTypes() {
        return [{ OBJECT_TYPE: "FUGR/F" }]
      },
      async validateNewObject() {
        return { success: false }
      },
      async createObject() {
        throw new Error("HTTP 400 ExceptionInvalidData: Data is invalid and could not be converted")
      },
      httpClient: {
        async request(_url: string, options: { headers?: Record<string, string> }) {
          const contentType = options.headers?.["Content-Type"] ?? ""
          contentTypes.push(contentType)
          if (contentType.includes("groups.v3+xml")) {
            throw new Error(
              "HTTP 400 ExceptionInvalidData: Data is invalid and could not be converted"
            )
          }
          return { body: "", status: 201, statusText: "Created", headers: {} }
        }
      },
      async findObjectPath() {
        return []
      },
      async inactiveObjects() {
        return []
      },
      async activate() {
        return { success: true, messages: [], inactive: [] }
      }
    } as never,
    request,
    "EN"
  )

  assert.equal(result.activation.success, true)
  assert.deepEqual(contentTypes, [
    "application/vnd.sap.adt.functions.groups.v3+xml; charset=utf-8",
    "application/vnd.sap.adt.functions.groups.v2+xml; charset=utf-8"
  ])
})

test("legacy ECC function group creation falls back to the repository helper on HTTP 405", async () => {
  const backend = new AdtBackend([
    {
      id: "w200",
      url: "http://sap.example.test:8000",
      client: "200",
      language: "EN",
      username: "DEVELOPER",
      passwordEnv: "SAP_PASSWORD",
      allowUnauthorized: false
    }
  ])
  let repositoryRequest: Parameters<AdtBackend["callSapRepository"]>[1] | undefined
  Object.assign(backend, {
    async withStatefulClient() {
      throw new Error(
        "create-fugr-f capability unsupported-endpoint (HTTP 405): " +
          "ADT POST /sap/bc/adt/functions/groups returned HTTP 405"
      )
    }
  })
  backend.callSapRepository = async (_connectionId, request) => {
    repositoryRequest = request
    return {
      status: "S",
      code: "FUNCTION_GROUP_CREATED",
      message: "Function group created and verified",
      version: "1.3",
      header: {},
      dynproText: "",
      fields: [],
      flowLogic: [],
      params: [],
      transactions: [],
      guiAttributes: [],
      source: []
    }
  }

  const result = await backend.createObject("w200", {
    objectType: "FUGR/F",
    name: "ZCMCP_FG_1501",
    description: "MCP 0.15 function validation",
    packageName: "ZABAP",
    additionalOptions: {
      transportRequest: { type: "existing", number: "GR2K923421" }
    }
  })

  assert.equal(result.activation.success, true)
  assert.deepEqual(repositoryRequest, {
    operation: "CREATE_FUNCTION_GROUP",
    objectName: "ZCMCP_FG_1501",
    description: "MCP 0.15 function validation",
    packageName: "ZABAP",
    transportNumber: "GR2K923421"
  })
})

test("legacy ECC repository fallbacks cover messages, texts, Includes, and transport details", async () => {
  const backend = new AdtBackend([
    {
      id: "w200",
      url: "http://sap.example.test:8000",
      client: "200",
      language: "EN",
      username: "DEVELOPER",
      passwordEnv: "SAP_PASSWORD",
      allowUnauthorized: false
    }
  ])
  const requests: Array<Parameters<AdtBackend["callSapRepository"]>[1]> = []
  Object.assign(backend, {
    async getClient() {
      return {
        async getObjectSource() {
          return "<html>legacy endpoint response</html>"
        },
        async getTextElements() {
          return { textElements: [] }
        },
        async transportDetails() {
          return { objects: [], tasks: [] }
        }
      }
    },
    async withStatefulClient() {
      throw new Error("create-fugr-i capability unsupported-endpoint (HTTP 501)")
    }
  })
  backend.callSapRepository = async (_connectionId, request) => {
    requests.push(request)
    const source =
      request.operation === "READ_TRANSPORT_DETAILS"
        ? [
            "M|1|NUMBER|GR2K923421",
            "M|1|OWNER|WYS",
            "M|1|DESC|MCP transport",
            "M|1|STATUS|D",
            "F|1|NUMBER|GR2K923422",
            "F|1|OWNER|WYS",
            "F|1|DESC|Developer task",
            "F|1|STATUS|D",
            "T|1|TASK|GR2K923422",
            "T|1|PGMID|R3TR",
            "T|1|TYPE|PROG",
            "T|1|NAME|ZCMCP_DEMO",
            "T|1|OBJ_INFO|"
          ]
        : request.operation === "READ_MESSAGE_CLASS" || request.operation === "CREATE_MESSAGE_CLASS"
          ? [
              "M|1|PACKAGE|ZABAP",
              "M|1|VERSION|20260902170000",
              "M|1|DESCRIPTION|MCP messages",
              "M|1|MASTERLANG|E",
              "M|1|REQUEST|GR2K923421",
              "F|1|MSGNR|001",
              "F|1|TEXT|Validation &#38;1 &#x3E; &#34;quoted&#34;"
            ]
          : request.operation === "READ_TEXT_ELEMENTS" ||
              request.operation === "MERGE_TEXT_ELEMENTS"
            ? [
                "M|1|PACKAGE|ZABAP",
                "M|1|VERSION|20260902170000",
                "M|1|REQUEST|GR2K923422",
                "T|1|ID|001",
                "T|1|TEXT|Fallback text",
                "T|1|MAXLENGTH|20"
              ]
            : ["M|1|PACKAGE|ZABAP", "M|1|REQUEST|GR2K923422"]
    return {
      status: "S",
      code: `${request.operation}_OK`,
      message: "verified",
      version: "1.7",
      header: {},
      dynproText: "",
      fields: [],
      flowLogic: [],
      params: [],
      transactions: [],
      guiAttributes: [],
      source
    }
  }

  const message = await backend.readMessageClass("w200", "ZCMCP_MSG_026")
  assert.equal(message.messages[0]?.text, 'Validation &1 > "quoted"')
  const createdMessage = await backend.createMessageClass(
    "w200",
    "ZCMCP_MSG_026",
    "MCP messages",
    [{ number: "001", text: "Validation" }],
    "ZABAP",
    "GR2K923421"
  )
  assert.equal(createdMessage.activation.success, true)

  const classTexts = await backend.readTextElements("w200", "ZCL_CMCP_026", "CLASS")
  assert.equal(classTexts.textElements[0]?.id, "001")
  const groupTexts = await backend.writeTextElements(
    "w200",
    "ZCMCP_FG_026",
    "FUNCTION_GROUP",
    "create",
    [{ id: "001", text: "Fallback text", maxLength: 20 }]
  )
  assert.equal(groupTexts.transportNumber, "GR2K923422")

  const include = await backend.createObject("w200", {
    objectType: "FUGR/I",
    name: "F01",
    parentName: "ZCMCP_FG_026",
    description: "ECC fallback Include",
    packageName: "ZABAP",
    additionalOptions: { transportRequest: { type: "existing", number: "GR2K923421" } }
  })
  assert.equal(include.objectName, "LZCMCP_FG_026F01")

  const transport = await backend.transportDetails("w200", "GR2K923421")
  assert.equal(transport.tasks[0]?.objects[0]?.["tm:name"], "ZCMCP_DEMO")
  assert.deepEqual(
    requests.map((request) => request.operation),
    [
      "READ_MESSAGE_CLASS",
      "CREATE_MESSAGE_CLASS",
      "READ_TEXT_ELEMENTS",
      "MERGE_TEXT_ELEMENTS",
      "CREATE_FUNCTION_INCLUDE",
      "READ_TRANSPORT_DETAILS"
    ]
  )
  assert.equal(requests[2]?.objectType, "CLAS")
  assert.equal(requests[3]?.objectType, "FUGR")
  assert.equal(requests[4]?.program, "ZCMCP_FG_026")
})

test("legacy ECC function group creation does not retry an arbitrary HTTP 400", async () => {
  const contentTypes: string[] = []
  const request = prepareCreateObjectRequest("w200", {
    objectType: "FUGR/F",
    name: "ZFG_INVALID_CREATE",
    description: "Invalid function group"
  })

  await assert.rejects(
    createObjectWithClient(
      {
        username: "DEVELOPER",
        async loadTypes() {
          return [{ OBJECT_TYPE: "FUGR/F" }]
        },
        async validateNewObject() {
          return { success: false }
        },
        async createObject() {
          throw new Error("No content handler found for content type 'application/*'")
        },
        httpClient: {
          async request(_url: string, options: { headers?: Record<string, string> }) {
            contentTypes.push(options.headers?.["Content-Type"] ?? "")
            throw new Error("HTTP 400: Package is invalid")
          }
        }
      } as never,
      request,
      "EN"
    ),
    /Package is invalid/
  )
  assert.deepEqual(contentTypes, ["application/vnd.sap.adt.functions.groups.v3+xml; charset=utf-8"])
})

test("legacy ECC function include creation tries the v2 media type first", async () => {
  const contentTypes: string[] = []
  const request = prepareCreateObjectRequest("w200", {
    objectType: "FUGR/I",
    name: "F01",
    parentName: "ZFG_LEGACY_CREATE",
    description: "Function include"
  })
  const result = await createObjectWithClient(
    {
      username: "DEVELOPER",
      async loadTypes() {
        return [{ OBJECT_TYPE: "FUGR/F" }]
      },
      async findObjectPath() {
        return []
      },
      async validateNewObject() {
        return { success: true }
      },
      async createObject() {
        throw new Error(
          "Request failed with status code 404; ADT POST /functions/includes returned HTTP 501"
        )
      },
      httpClient: {
        async request(_url: string, options: { headers?: Record<string, string> }) {
          contentTypes.push(options.headers?.["Content-Type"] ?? "")
          return { body: "", status: 201, statusText: "Created", headers: {} }
        }
      },
      async inactiveObjects() {
        return []
      },
      async activate() {
        return { success: true, messages: [], inactive: [] }
      }
    } as never,
    request,
    "EN"
  )

  assert.equal(result.activation.success, true)
  assert.deepEqual(contentTypes, [
    "application/vnd.sap.adt.functions.fincludes.v2+xml; charset=utf-8"
  ])
})

test("ADT object creation continues when legacy validation is empty or unavailable", async () => {
  for (const validateNewObject of [
    async () => ({ success: false }),
    async () => {
      throw new Error("ADT POST /sap/bc/adt/functions/validation returned HTTP 501")
    }
  ]) {
    const request = prepareCreateObjectRequest("w200", {
      objectType: "FUGR/F",
      name: "ZFG_LEGACY_CREATE",
      description: "Legacy function group"
    })
    const result = await createObjectWithClient(
      {
        username: "DEVELOPER",
        async loadTypes() {
          return [{ OBJECT_TYPE: "FUGR/F" }]
        },
        validateNewObject,
        async createObject() {},
        async findObjectPath() {
          return []
        },
        async inactiveObjects() {
          return []
        },
        async activate() {
          return { success: true, messages: [], inactive: [] }
        }
      } as never,
      request,
      "EN"
    )
    assert.equal(result.activation.success, true)
  }
})

test("test include creation locks, creates, unlocks, verifies, and activates", async () => {
  const calls: string[] = []
  let structureReads = 0
  const result = await createTestIncludeWithClient(
    {
      async objectStructure() {
        structureReads++
        calls.push(`structure:${structureReads}`)
        return {
          objectUrl: "/sap/bc/adt/oo/classes/zcl_demo",
          metaData: { "class:visibility": "public" },
          includes:
            structureReads < 3
              ? []
              : [
                  {
                    "class:includeType": "testclasses",
                    "abapsource:sourceUri": "includes/testclasses"
                  }
                ]
        }
      },
      async lock() {
        calls.push("lock")
        return {
          LOCK_HANDLE: "secret-lock",
          CORRNR: "W200K900001",
          IS_LOCAL: "",
          CORRUSER: "",
          CORRTEXT: "",
          IS_LINK_UP: "",
          MODIFICATION_SUPPORT: ""
        }
      },
      async createTestInclude() {
        calls.push("create")
      },
      async unLock() {
        calls.push("unlock")
        return ""
      },
      async inactiveObjects() {
        calls.push("inactive")
        return []
      },
      async activate() {
        calls.push("activate")
        return { success: true, messages: [], inactive: [] }
      }
    } as never,
    "w200",
    "ZCL_DEMO"
  )

  assert.equal(result.transportNumber, "W200K900001")
  assert.match(result.workspaceUri, /includes\/testclasses$/)
  assert.deepEqual(calls, [
    "structure:1",
    "lock",
    "structure:2",
    "create",
    "unlock",
    "structure:3",
    "inactive",
    "inactive",
    "activate"
  ])
})

test("test include creation rejects an existing include before requesting a lock", async () => {
  let lockCalls = 0
  await assert.rejects(
    createTestIncludeWithClient(
      {
        async objectStructure() {
          return {
            metaData: { "class:visibility": "public" },
            includes: [{ "class:includeType": "testclasses" }]
          }
        },
        async lock() {
          lockCalls++
        }
      } as never,
      "w200",
      "ZCL_DEMO"
    ),
    /already exists/
  )
  assert.equal(lockCalls, 0)
})

test("customer function-group technical include uses its Z owner policy", async () => {
  let savedSource = ""
  const result = await replaceSourceWithClient(
    {
      stateful: "stateful",
      async inactiveObjects() {
        return []
      },
      async lock() {
        return {
          LOCK_HANDLE: "secret-lock",
          CORRNR: "",
          CORRUSER: "",
          CORRTEXT: "",
          IS_LOCAL: "X",
          IS_LINK_UP: "",
          MODIFICATION_SUPPORT: ""
        }
      },
      async getObjectSource() {
        return "FUNCTION-POOL zfg_demo."
      },
      async setObjectSource(_uri: string, source: string) {
        savedSource = source
      },
      async unLock() {
        return ""
      },
      async activate() {
        return { success: true, messages: [], inactive: [] }
      }
    } as never,
    "w200",
    "adt://w200/sap/bc/adt/functions/groups/zfg_demo/includes/lzfg_demotop",
    "FUNCTION-POOL zfg_demo.",
    "FUNCTION-POOL zfg_demo.\n* customer include"
  )

  assert.match(savedSource, /customer include/)
  assert.equal(result.objectName, "LZFG_DEMOTOP")
  assert.equal(result.activation.success, true)
})

test("ADT write coordination unlocks after save failure", async () => {
  let unlocked = false
  const client = {
    stateful: "stateful",
    async inactiveObjects() {
      return []
    },
    async lock() {
      return {
        LOCK_HANDLE: "secret-lock",
        CORRNR: "",
        CORRUSER: "",
        CORRTEXT: "",
        IS_LOCAL: "X",
        IS_LINK_UP: "",
        MODIFICATION_SUPPORT: ""
      }
    },
    async getObjectSource() {
      return "REPORT zdemo."
    },
    async setObjectSource() {
      throw new Error("save failed")
    },
    async unLock() {
      unlocked = true
      return ""
    }
  }

  await assert.rejects(
    replaceSourceWithClient(
      client as never,
      "w200",
      "adt://w200/sap/bc/adt/programs/programs/zdemo/source/main",
      "REPORT zdemo.",
      "REPORT zdemo.\nWRITE 'X'."
    ),
    /save failed/
  )
  assert.equal(unlocked, true)
})

test("ADT write coordination identifies lock endpoint failures", async () => {
  await assert.rejects(
    replaceSourceWithClient(
      {
        stateful: "stateful",
        async lock() {
          throw new Error("Request failed with status code 403")
        }
      } as never,
      "w200",
      "adt://w200/sap/bc/adt/programs/programs/zdemo/source/main",
      "REPORT zdemo.",
      "REPORT zdemo.\nWRITE 'X'."
    ),
    /lock capability forbidden-or-not-authorized \(HTTP 403\)/
  )
})

test("legacy ECC write sessions stay logged in when login returns cookies without CSRF", () => {
  const httpClient = {
    csrfToken: "fetch",
    ascookies: () => "SAP_SESSIONID_W20_200=validation"
  }
  const client = {
    get loggedin() {
      return "loggedin" in httpClient
        ? (httpClient as typeof httpClient & { loggedin: boolean }).loggedin
        : httpClient.csrfToken !== "fetch"
    },
    httpClient
  }

  assert.equal(client.loggedin, false)
  preserveCookieSessionWithoutCsrf(client as never)
  assert.equal(client.loggedin, true)
})

test("all standalone ADT clients identify requests like the original ABAP FS", () => {
  assert.deepEqual(standaloneClientOptions(false).headers, {
    "X-Requested-With": "XMLHttpRequest"
  })
})

test("legacy ECC class revisions retry metadata with an explicit ADT content type", async () => {
  const accepted: string[] = []
  const classXml = `<?xml version="1.0" encoding="UTF-8"?>
<class:class xmlns:class="http://www.sap.com/adt/oo/classes"
  xmlns:adtcore="http://www.sap.com/adt/core"
  xmlns:atom="http://www.w3.org/2005/Atom"
  adtcore:name="ZCL_DEMO" adtcore:type="CLAS/OC" class:visibility="public">
  <class:include class:includeType="main" adtcore:name="ZCL_DEMO" adtcore:type="CLAS/I">
    <atom:link href="/sap/bc/adt/oo/classes/zcl_demo/versions"
      rel="http://www.sap.com/adt/relations/versions" type="application/atom+xml;type=feed"/>
    <atom:link href="/sap/bc/adt/oo/classes/zcl_demo/source/main"
      rel="http://www.sap.com/adt/relations/source" type="text/plain"/>
  </class:include>
</class:class>`
  const client = {
    async objectStructure() {
      throw new Error("No content handler found for content type '*/*'")
    },
    httpClient: {
      async request(_url: string, options?: { headers?: Record<string, string> }) {
        const accept = options?.headers?.Accept ?? ""
        accepted.push(accept)
        if (accept.endsWith("v4+xml")) {
          throw new Error(`No content handler found for content type '${accept}'`)
        }
        return { body: classXml, status: 200, statusText: "OK", headers: {} }
      }
    }
  }

  const structure = await loadRevisionObjectStructure(
    client as never,
    "/sap/bc/adt/oo/classes/zcl_demo"
  )

  assert.equal(structure.metaData["adtcore:name"], "ZCL_DEMO")
  assert.deepEqual(accepted, [
    "application/vnd.sap.adt.oo.classes.v4+xml",
    "application/vnd.sap.adt.oo.classes.v3+xml"
  ])
})

test("ABAP Unit 403 reports whether the legacy server advertises the endpoint", async () => {
  const backend = backendWithInjectedClient()
  injectClient(backend, {
    async unitTestRun() {
      throw new Error("Request failed with status code 403")
    },
    async adtDiscovery() {
      return [{ title: "Core", collection: [] }]
    }
  })

  await assert.rejects(
    backend.runUnitTests("w200", "/sap/bc/adt/oo/classes/zcl_testee"),
    /not advertised by the SAP server/
  )
})

test("wrapped legacy endpoint errors retain their real capability category", () => {
  assert.match(
    capabilityFailure("atc", new Error("Request failed with status code 404")).message,
    /unsupported-endpoint \(HTTP 404\)/
  )
})

function backendWithInjectedClient(): AdtBackend {
  return new AdtBackend([
    {
      id: "w200",
      url: "https://sap.example.invalid",
      client: "200",
      language: "EN",
      username: "VALIDATION",
      passwordEnv: "UNUSED_TEST_PASSWORD",
      allowUnauthorized: false
    }
  ])
}

function injectClient(backend: AdtBackend, client: object): void {
  const state = backend as unknown as {
    clients: Map<string, { client: object; login: Promise<void> }>
  }
  state.clients.set("w200", { client, login: Promise.resolve() })
}
