import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { usageReferences as sdkUsageReferences } from "abap-adt-api/build/api/syntax.js"
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
  writeClientOptions,
  writeTextElementsWithClient
} from "../src/adt-backend.js"
import type { AbapObjectInfo, SapDdicResult } from "../src/backend.js"
import { toolContracts } from "../src/contracts.js"
import { InvocationReceiptStore } from "../src/invocation-receipts.js"
import { ToolService, extractMethod, validateReadOnlySql } from "../src/tools.js"
import { findAndReplaceSource } from "../src/source-edit.js"
import { MockBackend } from "./mock-backend.js"
import { PRODUCT_VERSION } from "../src/version.js"
import { inactiveHttp } from "./inactive-http.js"
import { listenOnUnblockedPort } from "./loopback-port.js"

const zclDemoSource = [
  "CLASS zcl_demo IMPLEMENTATION.",
  "  METHOD run.",
  "    WRITE 'HEADLESS'.",
  "  ENDMETHOD.",
  "ENDCLASS."
].join("\n")
const zclDemoFingerprint = createHash("sha256").update(zclDemoSource).digest("hex")

test("BAdI subtype validation lists every accepted repository subtype", () => {
  const result = toolContracts.search_badi_objects.inputSchema.types.safeParse(["BADI"])
  assert.equal(result.success, false)
  if (!result.success) {
    assert.equal(
      result.error.issues[0]?.message,
      "Expected one of SXSD/XD, SXCI/XI, ENHS/XS, or ENHO/XHB"
    )
  }
})

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

test("dynamic capability report uses only bounded read probes and covers every tool", async () => {
  const backend = new MockBackend()
  const connectionDetails = backend.connectionDetails.bind(backend)
  backend.connectionDetails = (connectionId) => ({
    ...connectionDetails(connectionId),
    url: "https://configured-user:configured-password@sap.example.invalid/"
  })
  const repositoryOperations: string[] = []
  const ddicOperations: string[] = []
  const callRepository = backend.callSapRepository.bind(backend)
  const callDdic = backend.callSapDdic.bind(backend)
  backend.callSapRepository = async (connectionId, request) => {
    repositoryOperations.push(request.operation)
    return callRepository(connectionId, request)
  }
  backend.callSapDdic = async (connectionId, request) => {
    ddicOperations.push(request.operation)
    return callDdic(connectionId, request)
  }

  const report = JSON.parse(
    await new ToolService(backend).getCapabilityReport({ connectionId: "W200" })
  ) as {
    productVersion: string
    connection: { id: string; baseUrl: string; client: string; language: string; username: string }
    readOnly: boolean
    safety: Record<string, boolean>
    helpers: Array<{ name: string; availability: string; protocolVersion?: string }>
    capabilities: Array<{
      id: string
      route: string
      toolNames: string[]
      observation: { availability: string }
    }>
  }

  assert.equal(report.productVersion, PRODUCT_VERSION)
  assert.deepEqual(report.connection, {
    id: "w200",
    baseUrl: "https://sap.example.invalid",
    client: "200",
    language: "EN",
    username: "DEVELOPER"
  })
  assert.equal(report.readOnly, true)
  assert.deepEqual(report.safety, {
    sapWritesInvoked: false,
    sapLocksCleared: false,
    automaticWriteRetry: false,
    automaticRollbackClaimed: false
  })
  assert.deepEqual(repositoryOperations, ["READ_MESSAGE_CLASS"])
  assert.deepEqual(ddicOperations, ["READ_DOMAIN"])
  assert.equal(report.helpers.find((helper) => helper.name === "base")?.protocolVersion, "1.0")
  assert.equal(
    report.capabilities.find((item) => item.id === "adt-repository-search")?.observation
      .availability,
    "available"
  )
  assert.equal(
    report.capabilities.find((item) => item.id === "repository-helper-message-update")?.observation
      .availability,
    "unknown"
  )
  assert.equal(
    report.capabilities.find((item) => item.id === "ddic-helper-controlled-delete")?.observation
      .availability,
    "available"
  )

  const reportedTools = report.capabilities.flatMap((item) => item.toolNames)
  assert.equal(new Set(reportedTools).size, reportedTools.length)
  assert.deepEqual(reportedTools.sort(), Object.keys(toolContracts).sort())
})

test("dynamic capability report distinguishes unsupported endpoints from unknown probe failures", async () => {
  const backend = new MockBackend()
  backend.listTraceRuns = async () => {
    throw new Error("abap-traces capability unsupported-endpoint (HTTP 404)")
  }
  backend.runQuery = async () => {
    throw new Error("Request failed with status code 403")
  }

  const report = JSON.parse(
    await new ToolService(backend).getCapabilityReport({ connectionId: "w200" })
  ) as {
    capabilities: Array<{
      id: string
      observation: { availability: string; reason: string }
    }>
  }
  const capability = (id: string) => report.capabilities.find((item) => item.id === id)!

  assert.equal(capability("adt-runtime-traces").observation.availability, "unsupported")
  assert.match(capability("adt-runtime-traces").observation.reason, /HTTP 404/)
  assert.equal(capability("adt-data-preview").observation.availability, "unknown")
  assert.match(
    capability("adt-data-preview").observation.reason,
    /without proving endpoint absence/
  )
  // Native ATC is a platform boundary, not an unprobed state: this mock's discovery snapshot
  // advertises only the repository, so the Test Cockpit service is provably absent. Reporting
  // `unknown` here is what used to hide a permanent limitation, and unreadable `unknown` is the
  // thing this verdict replaced.
  assert.equal(capability("adt-quality").observation.availability, "platform_unsupported")
  // ABAP Unit is split out from native ATC, so it is judged on its own endpoint rather than
  // inheriting the ATC boundary.
  assert.equal(capability("adt-abap-unit").observation.availability, "platform_unsupported")
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
        <n0:Z_ORVANTA_MCP_EXECUTE.Response xmlns:n0="urn:sap-com:document:sap:rfc:functions">
          <EV_STATUS>S</EV_STATUS>
          <EV_CODE>READY</EV_CODE>
          <EV_MESSAGE>Codex MCP SAP helper is ready</EV_MESSAGE>
          <EV_VERSION>1.0</EV_VERSION>
        </n0:Z_ORVANTA_MCP_EXECUTE.Response>
      </soap-env:Body>
    </soap-env:Envelope>`)
  assert.deepEqual(result, {
    status: "S",
    code: "READY",
    message: "Codex MCP SAP helper is ready",
    version: "1.0",
    source: []
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

test("SAP helper response keeps the interface patch difference rows", () => {
  const result = parseSapHelperResponse(`<?xml version="1.0"?>
    <soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/">
      <soap-env:Body>
        <n0:Z_ORVANTA_MCP_EXECUTE.Response xmlns:n0="urn:sap-com:document:sap:rfc:functions">
          <EV_STATUS>E</EV_STATUS>
          <EV_CODE>FUNCTION_PATCH_SAVE_NOT_OBSERVED</EV_CODE>
          <EV_MESSAGE>Active function does not match the save</EV_MESSAGE>
          <EV_VERSION>2.0</EV_VERSION>
          <IT_SOURCE>
            <item><LINE>D|1|SECTION|EXPORT</LINE></item>
            <item><LINE>D|1|FIELD|PARAMETER</LINE></item>
          </IT_SOURCE>
        </n0:Z_ORVANTA_MCP_EXECUTE.Response>
      </soap-env:Body>
    </soap-env:Envelope>`)
  assert.equal(result.code, "FUNCTION_PATCH_SAVE_NOT_OBSERVED")
  assert.deepEqual(result.source, ["D|1|SECTION|EXPORT", "D|1|FIELD|PARAMETER"])
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
  await listenOnUnblockedPort(server)
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
      const body = action.endsWith("Z_ORVANTA_MCP_EXECUTE")
        ? `<Envelope><Body><EV_STATUS>S</EV_STATUS><EV_CODE>READY</EV_CODE><EV_MESSAGE>OK</EV_MESSAGE><EV_VERSION>1.0</EV_VERSION></Body></Envelope>`
        : action.endsWith("Z_ORVANTA_MCP_DDIC_API")
          ? `<Envelope><Body><EV_STATUS>S</EV_STATUS><EV_CODE>DDIC_OBJECT_READ</EV_CODE><EV_MESSAGE>OK</EV_MESSAGE><EV_VERSION>1.2</EV_VERSION><IT_SOURCE><item><LINE>M|1|PACKAGE|SAP_BASIS</LINE></item><item><LINE>M|1|VERSION|20260831120000</LINE></item><item><LINE>H|1|DOMNAME|CHAR10</LINE></item></IT_SOURCE></Body></Envelope>`
          : `<Envelope><Body><EV_STATUS>S</EV_STATUS><EV_CODE>SCREEN_READ</EV_CODE><EV_MESSAGE>OK</EV_MESSAGE><EV_VERSION>1.1</EV_VERSION><ES_HEADER><PROG>ZDEMO</PROG></ES_HEADER><EV_DYNPROTEXT>Demo</EV_DYNPROTEXT><CT_FIELDS></CT_FIELDS><CT_FLOWLOGIC></CT_FLOWLOGIC><CT_PARAMS></CT_PARAMS><ET_TCODES></ET_TCODES><ET_GUI_ATTRIBUTES></ET_GUI_ATTRIBUTES></Body></Envelope>`
      response.end(body)
    })
  })
  await listenOnUnblockedPort(server)
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
          action: "http://www.sap.com/Z_ORVANTA_MCP_EXECUTE",
          authorization: "Basic dGVzdDpzZWNyZXQ="
        },
        {
          action: "http://www.sap.com/Z_ORVANTA_MCP_DYNPRO_API",
          authorization: "Basic dGVzdDpzZWNyZXQ="
        },
        {
          action: "http://www.sap.com/Z_ORVANTA_MCP_DDIC_API",
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
      <soap-env:Body><Z_ORVANTA_MCP_EXECUTE.Response>
        <EV_STATUS>S</EV_STATUS><EV_CODE>SCREEN_READ</EV_CODE>
        <EV_MESSAGE>OK</EV_MESSAGE><EV_VERSION>1.1</EV_VERSION>
        <ES_HEADER><PROG>ZMODULE_POOL</PROG><DNUM>0100</DNUM></ES_HEADER>
        <EV_DYNPROTEXT>Demo</EV_DYNPROTEXT>
        <CT_FIELDS><item><FNAM>GV_NAME</FNAM><LINE>3</LINE></item></CT_FIELDS>
        <CT_FLOWLOGIC><item><LINE>PROCESS BEFORE OUTPUT.</LINE></item></CT_FLOWLOGIC>
        <CT_PARAMS></CT_PARAMS><ET_TCODES></ET_TCODES>
        <ET_GUI_ATTRIBUTES></ET_GUI_ATTRIBUTES>
      </Z_ORVANTA_MCP_EXECUTE.Response></soap-env:Body>
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

test("an inactive definition keeps the attributes the helper publishes under M", () => {
  // The helper describes an inactive version by publishing the object attributes under M (in that
  // path they describe the version being read, not the active one) while the active path uses H. The
  // 17:10 incident saw an empty tableClass for ZTPMC_TPRPI even though SAP's own DD02L row carries
  // TRANSP, because only H reached the header bag. M must now act as a fallback for H.
  const inactive = parseSapDdicResponse(`
    <Envelope><Body><EV_STATUS>S</EV_STATUS><EV_CODE>INACTIVE_VERSION_DESCRIBED</EV_CODE>
      <EV_MESSAGE>Inactive DDIC version described for inspection</EV_MESSAGE><EV_VERSION>1.10</EV_VERSION>
      <IT_SOURCE>
        <item><LINE>M|1|GOTSTATE|N</LINE></item>
        <item><LINE>M|1|INACTIVE|X</LINE></item>
        <item><LINE>M|1|TABNAME|ZTPMC_TPRPI</LINE></item>
        <item><LINE>M|1|DDTEXT|Transfer post-processing</LINE></item>
        <item><LINE>M|1|TABCLASS|TRANSP</LINE></item>
        <item><LINE>M|1|MAINFLAG|</LINE></item>
        <item><LINE>M|1|CONTFLAG|A</LINE></item>
        <item><LINE>F|1|FIELDNAME|MANDT</LINE></item>
      </IT_SOURCE></Body></Envelope>`)
  assert.equal(inactive.metadata.INACTIVE, "X")
  assert.equal(inactive.metadata.GOTSTATE, "N")
  assert.equal(inactive.header.TABCLASS, "TRANSP")
  assert.equal(inactive.header.CONTFLAG, "A")
  assert.equal(inactive.header.DDTEXT, "Transfer post-processing")
  assert.equal(inactive.header.TABNAME, "ZTPMC_TPRPI")
  // A value the active path publishes under H still wins when both groups carry the key.
  const active = parseSapDdicResponse(`
    <Envelope><Body><EV_STATUS>S</EV_STATUS><EV_CODE>DDIC_OBJECT_FOUND</EV_CODE>
      <EV_MESSAGE>OK</EV_MESSAGE><EV_VERSION>1.10</EV_VERSION>
      <IT_SOURCE>
        <item><LINE>M|1|TABCLASS|INTTAB</LINE></item>
        <item><LINE>H|1|TABCLASS|TRANSP</LINE></item>
      </IT_SOURCE></Body></Envelope>`)
  assert.equal(active.header.TABCLASS, "TRANSP")
  assert.equal(active.metadata.TABCLASS, "INTTAB")
})

/**
 * The 17:37 incident resumed from a read that could not report DD09V technical settings: the inactive
 * reply showed `dataClass ""` and `sizeCategory 0`, the approved definition required APPL1/1, and
 * activating the stored version unchanged would have persisted the incomplete state. The helper
 * publishes DD09V values only on the active path, so the resume tool must not read absence as fact.
 */
function inactiveTableResult(options: {
  fields?: Array<Record<string, unknown>>
  header?: Record<string, string>
  metadata?: Record<string, string>
  code?: string
}): SapDdicResult {
  return {
    status: "S",
    code: options.code ?? "INACTIVE_VERSION_DESCRIBED",
    message: "Inactive DDIC version described for inspection",
    version: "1.10",
    metadata: {
      GOTSTATE: "N",
      INACTIVE: "X",
      PACKAGE: "ZABAP",
      VERSION: "20260831120000",
      ...(options.metadata ?? {})
    },
    packageName: "ZABAP",
    objectVersion: "20260831120000",
    recordedRequest: "GR2K923427",
    header: {
      TABNAME: "ZTPMC_TPRPI",
      DDTEXT: "Transfer post-processing",
      TABCLASS: "TRANSP",
      CONTFLAG: "A",
      MAINFLAG: "",
      ...(options.header ?? {})
    },
    fixedValues: [],
    fields: (options.fields ?? [
      { FIELDNAME: "MANDT", POSITION: "0001", KEYFLAG: "X", ROLLNAME: "MANDT" },
      { FIELDNAME: "ID", POSITION: "0002", KEYFLAG: "", ROLLNAME: "CHAR10" }
    ]) as SapDdicResult["fields"],
    selectionMethods: [],
    parameters: [],
    fieldAssignments: [],
    lockTables: [],
    lockFields: [],
    numberRangeTexts: [],
    baseTables: [],
    viewFields: [],
    selectionConditions: [],
    warnings: []
  }
}

test("an inactive resume refuses while the helper cannot report technical settings", async () => {
  const backend = new MockBackend()
  const operations: string[] = []
  backend.callSapDdic = async (_connectionId, request) => {
    operations.push(request.operation)
    return inactiveTableResult({})
  }
  const tools = new ToolService(backend)
  const read = JSON.parse(
    await tools.readDdicTransparentTable({ connectionId: "w200", objectName: "ZTPMC_TPRPI" })
  ) as {
    status: string
    technicalSettingsReported: boolean
    definitionFingerprint: string
    definition: Record<string, unknown>
    warnings?: string[]
  }
  // The read must say the values are unreported rather than presenting client defaults as SAP facts.
  assert.equal(read.status, "inactive")
  assert.equal(read.technicalSettingsReported, false)
  assert.equal(read.definition.dataClass, "")
  assert.equal(read.definition.sizeCategory, 0)
  assert.match(String(read.warnings?.[0] ?? ""), /not reported by the deployed helper/i)

  operations.length = 0
  await assert.rejects(
    () =>
      tools.resumeDdicTableActivation({
        connectionId: "w200",
        objectName: "ZTPMC_TPRPI",
        expectedInactiveFingerprint: read.definitionFingerprint,
        packageName: "ZABAP",
        transportNumber: "GR2K923427",
        confirmation: "RESUME_INACTIVE_ACTIVATION"
      }),
    (error: Error) => {
      assert.match(error.message, /INACTIVE_TECHNICAL_SETTINGS_NOT_REPORTED/)
      assert.match(error.message, /could persist incomplete technical settings/)
      return true
    }
  )
  // Activation was not attempted: the guard runs before any resume call reaches SAP.
  assert.deepEqual(operations, ["READ_TRANSPARENT_TABLE"])
})

/**
 * 0.46.13 guard for the 10:26 incident.
 *
 * `read_ddic_transparent_table` on the inactive `ZTPMC_TPRPI` returned `definition.fields: []` while
 * DD03L held all 29 field rows with AS4LOCAL = 'N'. The deployed helper's inactive path took the
 * field rows from the active version's table, which is empty for an object that has no active
 * version. A transparent table or structure cannot have zero fields, so that read is not the stored
 * definition - and a fingerprint hashed over the empty list would authorise activating exactly the
 * partial state the caller is trying to verify.
 */
test("an inactive definition with no field rows refuses to issue an activation fingerprint", async () => {
  const backend = new MockBackend()
  backend.callSapDdic = async () => inactiveTableResult({ fields: [] })
  const read = JSON.parse(
    await new ToolService(backend).readDdicTransparentTable({
      connectionId: "w200",
      objectName: "ZTPMC_TPRPI"
    })
  ) as {
    status: string
    definition: Record<string, unknown>
    definitionIncomplete: boolean
    fieldsReported: number
    definitionFingerprint: string | null
    resumeTool?: string
    substitutes: string[]
    requiredAction: string
    automaticRetry: boolean
  }
  assert.equal(read.status, "inactive-definition-incomplete")
  assert.equal(read.definitionIncomplete, true)
  assert.equal(read.fieldsReported, 0)
  assert.equal(read.definition.fields instanceof Array, true)
  // No usable fingerprint and no resume hint may be published for a definition this read did not see.
  assert.equal(read.definitionFingerprint, null)
  assert.equal(read.resumeTool, undefined)
  // The substitutes name the read path that does show the stored rows, and the fix is stated.
  assert.ok(read.substitutes.some((item) => item.includes("DD03L")))
  assert.ok(read.substitutes.some((item) => item.includes("AS4LOCAL")))
  assert.match(read.requiredAction, /Deploy the current DDIC helper/)
  assert.equal(read.automaticRetry, false)
})

test("an inactive resume refuses a stored definition with no field rows", async () => {
  // The fingerprint gate cannot replace the field check: a hash over an empty field list matches
  // itself and would authorise activating the partial definition.
  const backend = new MockBackend()
  const operations: string[] = []
  backend.callSapDdic = async (_connectionId, request) => {
    operations.push(request.operation)
    return inactiveTableResult({ fields: [] })
  }
  await assert.rejects(
    () =>
      new ToolService(backend).resumeDdicTableActivation({
        connectionId: "w200",
        objectName: "ZTPMC_TPRPI",
        expectedInactiveFingerprint: "b".repeat(64),
        packageName: "ZABAP",
        transportNumber: "GR2K923427",
        confirmation: "RESUME_INACTIVE_ACTIVATION"
      }),
    (error: Error) => {
      assert.match(error.message, /INACTIVE_DEFINITION_INCOMPLETE/)
      assert.match(error.message, /read_abap_table\(DD03L/)
      return true
    }
  )
  assert.deepEqual(operations, ["READ_TRANSPARENT_TABLE"])
})

test("table field writes carry the DD03P reference pair, and an unpaired half is refused", async () => {
  // A quantity or currency field names the table and field holding its unit. DDIC activation refuses
  // such a field without them ("specify reference table and reference field"), verified live on
  // 2026-09-24, so the pair must reach the helper; and a lone half must fail here rather than be
  // dropped silently, because the caller would otherwise believe a unit reference was applied.
  const backend = new MockBackend()
  const requests: Array<{ operation: string; fields?: Array<Record<string, string>> }> = []
  // Delegate to the mock's own DDIC handler so the reply keeps the shape the create path expects;
  // this test records what the client sent, it does not restate the mock's reply.
  const original = backend.callSapDdic.bind(backend)
  backend.callSapDdic = async (connectionId, request) => {
    requests.push(
      request as unknown as { operation: string; fields?: Array<Record<string, string>> }
    )
    return original(connectionId, request)
  }
  const tools = new ToolService(backend)
  const base = {
    description: "reference probe",
    deliveryClass: "A" as const,
    dataClass: "APPL1" as const,
    dataBrowserMaintenance: "notAllowed" as const,
    packageName: "ZABAP",
    transportNumber: "GR2K923421",
    connectionId: "w200"
  }
  await tools.createDdicTransparentTable({
    ...base,
    objectName: "ZCMCP_TAB_REF",
    fields: [
      { name: "MANDT", dataElement: "MANDT", key: true },
      { name: "QTY", dataElement: "MENGE_D", referenceTable: "MARA", referenceField: "MEINS" }
    ]
  })
  const created = requests.find((request) => request.operation === "CREATE_TRANSPARENT_TABLE")
  assert.ok(created, "the create must reach the DDIC helper")
  const quantity = created.fields?.find((field) => field.FIELDNAME === "QTY")
  assert.equal(quantity?.REFTABLE, "MARA")
  assert.equal(quantity?.REFFIELD, "MEINS")

  requests.length = 0
  await assert.rejects(
    () =>
      tools.createDdicTransparentTable({
        ...base,
        objectName: "ZCMCP_TAB_REF",
        fields: [
          { name: "MANDT", dataElement: "MANDT", key: true },
          { name: "QTY", dataElement: "MENGE_D", referenceTable: "MARA" }
        ]
      }),
    /referenceTable and referenceField must be supplied together/
  )
  await assert.rejects(
    () =>
      tools.appendDdicTransparentTableFields({
        ...base,
        objectName: "ZCMCP_TAB_REF",
        expectedVersion: "20260924120000",
        expectedFingerprint: "a".repeat(64),
        fields: [{ name: "QTY2", dataElement: "MENGE_D", referenceField: "MEINS" }]
      }),
    /referenceTable and referenceField must be supplied together/
  )
  assert.deepEqual(requests, [], "an unpaired reference must be refused before any SAP call")
})

test("an inactive resume with settingsRepair writes the settings, activates, and verifies them", async () => {
  const backend = new MockBackend()
  const operations: string[] = []
  const repaired = inactiveTableResult({
    header: { TABART: "APPL1", TABKAT: "1", BUFALLOW: "N", PUFFERUNG: "" }
  })
  const active = {
    ...inactiveTableResult({
      header: { TABART: "APPL1", TABKAT: "1", BUFALLOW: "N", PUFFERUNG: "" },
      code: "DDIC_OBJECT_READ"
    }),
    metadata: { GOTSTATE: "A", PACKAGE: "ZABAP", VERSION: "20260831120000" }
  } as SapDdicResult
  const queue: SapDdicResult[] = []
  backend.callSapDdic = async (_connectionId, request) => {
    operations.push(request.operation)
    // An unexpected extra call is reported by the operation-list assertion rather than by a throw,
    // so the diff shows which call was made and in what order.
    return queue.shift() ?? inactiveTableResult({})
  }
  const tools = new ToolService(backend)
  const read = JSON.parse(
    await tools.readDdicTransparentTable({ connectionId: "w200", objectName: "ZTPMC_TPRPI" })
  ) as { definitionFingerprint: string }
  operations.length = 0
  queue.push(
    inactiveTableResult({}),
    inactiveTableResult({}),
    { ...inactiveTableResult({}), code: "DDIC_OBJECT_SAVED" },
    repaired,
    { ...inactiveTableResult({}), code: "DDIC_OBJECT_ACTIVATED" },
    active
  )
  const result = JSON.parse(
    await tools.resumeDdicTableActivation({
      connectionId: "w200",
      objectName: "ZTPMC_TPRPI",
      expectedInactiveFingerprint: read.definitionFingerprint,
      packageName: "ZABAP",
      transportNumber: "GR2K923427",
      confirmation: "RESUME_INACTIVE_ACTIVATION",
      settingsRepair: {
        dataClass: "APPL1",
        sizeCategory: 1,
        buffering: "notAllowed",
        logDataChanges: false,
        acknowledgeTechnicalSettingsChange: true
      }
    })
  ) as {
    status: string
    resumed: boolean
    technicalSettingsVerified: boolean
    technicalSettingsReported: boolean
    activatedFingerprint: string
    inactiveFingerprint: string
    technicalSettingsRepair: {
      technicalSettingsBefore: { dataClass: string; sizeCategory: number }
      technicalSettingsAfter: { dataClass: string; sizeCategory: number }
    }
    activeTechnicalSettings: { dataClass: string; sizeCategory: number }
    definitionResent: boolean
  }
  // The repair is written under the fingerprint that was read, then activation runs on the re-read
  // state, and the active read proves APPL1/1 survived instead of trusting the activation call.
  assert.deepEqual(operations, [
    "READ_TRANSPARENT_TABLE",
    "READ_TRANSPARENT_TABLE",
    "PATCH_TRANSPARENT_TABLE_SETTINGS",
    "READ_TRANSPARENT_TABLE",
    "RESUME_TABLE_ACTIVATION",
    "READ_TRANSPARENT_TABLE"
  ])
  assert.equal(result.resumed, true)
  assert.equal(result.technicalSettingsVerified, true)
  assert.equal(result.technicalSettingsReported, false)
  assert.equal(result.technicalSettingsRepair.technicalSettingsBefore.dataClass, "")
  assert.equal(result.technicalSettingsRepair.technicalSettingsAfter.dataClass, "APPL1")
  assert.equal(result.activeTechnicalSettings.dataClass, "APPL1")
  assert.equal(result.activeTechnicalSettings.sizeCategory, 1)
  assert.notEqual(result.activatedFingerprint, result.inactiveFingerprint)
  assert.equal(result.definitionResent, false)
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

  const transactionRead = JSON.parse(
    await tools.readTransactionCode({
      transactionCode: "ZMODULE_POOL_UI",
      connectionId: "w200"
    })
  ) as { fingerprint: string }
  assert.match(transactionRead.fingerprint, /^[a-f0-9]{64}$/)

  const standardTransactionRead = JSON.parse(
    await tools.readTransactionCode({ transactionCode: "VL02N", connectionId: "w200" })
  ) as { transactions: Array<{ TCODE: string }> }
  assert.equal(standardTransactionRead.transactions[0]?.TCODE, "VL02N")

  const deletedTransaction = await tools.deleteTransactionCode({
    transactionCode: "ZMODULE_POOL_UI",
    expectedProgramName: "ZMODULE_POOL",
    expectedFingerprint: transactionRead.fingerprint,
    packageName: "ZVALIDATION",
    transportNumber: "W20K900001",
    connectionId: "w200"
  })
  assert.match(deletedTransaction, /Transaction deleted and absence verified/)
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
    tools.deleteTransactionCode({
      transactionCode: "ZMODULE_POOL_UI",
      expectedProgramName: "ZMODULE_POOL",
      expectedFingerprint: "f".repeat(64),
      packageName: "ZVALIDATION",
      transportNumber: "W20K900001",
      connectionId: "w200"
    }),
    /TRANSACTION_FINGERPRINT_CONFLICT/
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

  await assert.rejects(
    tools.deleteAbapMessageClass({
      messageClass: "ZCMCP_MSG_0300",
      expectedVersion: "20260831140000",
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      confirmation: "PERMANENT_DELETE",
      connectionId: "w200"
    }),
    /VERSION_CONFLICT/
  )

  await assert.rejects(
    tools.deleteAbapMessageClass({
      messageClass: "ZCMCP_MSG_0300",
      expectedVersion: "20260903120000",
      packageName: "ZOTHER",
      transportNumber: "GR2K923421",
      confirmation: "PERMANENT_DELETE",
      connectionId: "w200"
    }),
    /PACKAGE_CONFLICT/
  )

  const deleted = JSON.parse(
    await tools.deleteAbapMessageClass({
      messageClass: "ZCMCP_MSG_0300",
      expectedVersion: "20260903120000",
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      confirmation: "PERMANENT_DELETE",
      connectionId: "w200"
    })
  ) as { status: string; previousVersion: string; previousFingerprint: string }
  assert.equal(deleted.status, "MESSAGE_CLASS_DELETED")
  assert.equal(deleted.previousVersion, "20260903120000")
  assert.match(deleted.previousFingerprint, /^[a-f0-9]{64}$/)
  await assert.rejects(
    tools.readAbapMessageClass({ messageClass: "ZCMCP_MSG_0300", connectionId: "w200" }),
    /MESSAGE_CLASS_NOT_FOUND/
  )
})

test("message class deletion fails when SAP readback still finds the object", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)
  await tools.createAbapMessageClass({
    messageClass: "ZCMCP_MSG_0320",
    description: "Delete verification",
    messages: [{ number: "001", text: "Still present" }],
    packageName: "ZABAP",
    transportNumber: "GR2K923421",
    connectionId: "w200"
  })
  backend.deleteMessageClass = async (
    connectionId,
    messageClass,
    _expectedVersion,
    _packageName,
    transportNumber
  ) => ({ connectionId, messageClass, transportNumber })

  await assert.rejects(
    tools.deleteAbapMessageClass({
      messageClass: "ZCMCP_MSG_0320",
      expectedVersion: "20260831140000",
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      confirmation: "PERMANENT_DELETE",
      connectionId: "w200"
    }),
    /MESSAGE_CLASS_DELETE_VERIFY_FAILED/
  )
})

test("source-object deletion accepts a local $TMP object and no transport", async () => {
  // Regression guard for the refusal that stranded every deployment carrier in $TMP. The shared
  // packageName() helper rejects $TMP because its eleven other callers create module pools,
  // transactions, screens and message classes -- objects SAP does require to be transportable, which
  // is why its wording mentions Dynpro application objects. deleteSourceObject used to route through
  // it, so no local program, include, class or interface could ever be deleted and the refusal named
  // a cause unrelated to the request. This asserts on the MESSAGE rather than the outcome, so it
  // still fails if the local-object rule is re-broken even when unrelated mock behaviour changes.
  const backend = new MockBackend()
  const tools = new ToolService(backend)
  await assert.rejects(
    tools.deleteSourceObject({
      objectType: "PROG/P",
      objectName: "ZORVANTA_SEED_PROBE",
      expectedFingerprint: "a".repeat(64),
      packageName: "$TMP",
      transportNumber: "",
      confirmation: "PERMANENT_DELETE",
      connectionId: "w200"
    }),
    (error: Error) => {
      assert.doesNotMatch(
        error.message,
        /Dynpro|transportable package/,
        "a $TMP source object must not be refused the way a Dynpro object is"
      )
      // The mock holds no such program, so the request must fail for that honest reason instead.
      assert.match(error.message, /does not exist|Could not find/i)
      return true
    }
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
        metadata: {},
        header: {},
        fixedValues: [],
        fields: [],
        selectionMethods: [],
        parameters: [],
        fieldAssignments: [],
        lockTables: [],
        lockFields: [],
        numberRangeTexts: [],
        baseTables: [],
        viewFields: [],
        selectionConditions: [],
        warnings: []
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
  for (const source of [["FUNCTION zcmcp_fm_1502."], ["  endfunction."]]) {
    const previousRequest = backend.lastRepositoryRequest
    await assert.rejects(
      tools.createFunctionModuleWithInterface({ ...input, source }),
      /only the function body/
    )
    assert.equal(backend.lastRepositoryRequest, previousRequest)
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

test("function module verification names the part of the definition SAP did not return", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)
  // A read-back that differs in one known place must say which place. Reporting only "did not return
  // the requested definition" makes a legitimate SAP normalisation and a real defect indistinguishable,
  // which is how this check was previously read as a false negative.
  backend.functionCreateReadbackDropsSourceLine = true
  const input = {
    functionName: "ZCMCP_FM_READBACK",
    functionGroup: "ZCMCP_FG_1501",
    description: "MCP read-back diagnostic",
    remoteEnabled: true,
    importParameters: [{ name: "IV_INPUT", typeName: "CHAR20" }],
    exportParameters: [{ name: "EV_OUTPUT", typeName: "CHAR40" }],
    changingParameters: [],
    tableParameters: [],
    exceptions: [],
    source: ["  CONCATENATE 'a' iv_input INTO ev_output.", "  CLEAR iv_input."],
    packageName: "ZABAP",
    transportNumber: "GR2K923421",
    connectionId: "w200"
  }
  await assert.rejects(
    tools.createFunctionModuleWithInterface(input),
    /source line 2 is absent from the saved source: "  CLEAR iv_input\."/
  )
  await assert.rejects(
    tools.createFunctionModuleWithInterface({ ...input, functionName: "ZCMCP_FM_READBACK2" }),
    /verification did not return the requested definition/
  )
})

test("function interface patch applies controlled operations and preserves implementation source", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)
  const current = JSON.parse(
    await tools.readFunctionModuleInterface({
      functionName: "ZCMCP_FM_1501",
      connectionId: "w200"
    })
  ) as {
    interfaceFingerprint: string
    sourceFingerprint: string
    source: string[]
  }
  const input = {
    functionName: "ZCMCP_FM_1501",
    functionGroup: "ZCMCP_FG_1501",
    expectedInterfaceFingerprint: current.interfaceFingerprint,
    expectedSourceFingerprint: current.sourceFingerprint,
    parameterOperations: [
      {
        operation: "add" as const,
        direction: "import" as const,
        name: "IV_TEMP",
        typeName: "CHAR10",
        description: "Temporary"
      },
      {
        operation: "rename" as const,
        direction: "import" as const,
        name: "IV_INPUT",
        newName: "IV_VALUE"
      },
      {
        operation: "update" as const,
        direction: "import" as const,
        name: "IV_VALUE",
        typeName: "CHAR40",
        optional: true,
        description: "Value"
      },
      {
        operation: "remove" as const,
        direction: "import" as const,
        name: "IV_TEMP"
      }
    ],
    exceptionOperations: [
      { operation: "add" as const, name: "TEMP_ERROR", description: "Temporary" },
      {
        operation: "rename" as const,
        name: "INVALID_INPUT",
        newName: "INPUT_INVALID"
      },
      { operation: "update" as const, name: "INPUT_INVALID", description: "Invalid value" },
      { operation: "remove" as const, name: "TEMP_ERROR" }
    ],
    packageName: "ZABAP",
    transportNumber: "GR2K923421",
    confirmation: "DESTRUCTIVE_INTERFACE_CHANGE" as const,
    connectionId: "w200"
  }

  await assert.rejects(
    tools.patchFunctionModuleInterface({ ...input, confirmation: undefined }),
    /DESTRUCTIVE_INTERFACE_CHANGE/
  )
  await assert.rejects(
    tools.patchFunctionModuleInterface({
      ...input,
      expectedSourceFingerprint: "0".repeat(64)
    }),
    /implementation source fingerprint changed/
  )

  const patched = JSON.parse(await tools.patchFunctionModuleInterface(input)) as {
    status: string
    helperCode: string
    helperVersion: string
    helperVerification: string
    previousInterfaceFingerprint: string
    previousSourceFingerprint: string
    interfaceFingerprint: string
    sourceFingerprint: string
    sourceWritePerformed: boolean
    interfaceWritePerformed: boolean
    interfaceWriteSupported: boolean
    interfaceWriteLimit: string
    parameterChangesApplied: boolean
    importParameters: Array<{
      name: string
      typeName: string
      optional: boolean
      description: string
    }>
    exceptions: Array<{ name: string; description: string }>
    source: string[]
  }
  assert.equal(patched.status, "FUNCTION_INTERFACE_PATCHED")
  assert.equal(patched.helperVersion, "2.0")
  assert.equal(patched.previousInterfaceFingerprint, current.interfaceFingerprint)
  assert.notEqual(patched.interfaceFingerprint, current.interfaceFingerprint)
  assert.equal(patched.previousSourceFingerprint, current.sourceFingerprint)
  assert.equal(patched.sourceFingerprint, current.sourceFingerprint)
  assert.deepEqual(patched.importParameters[0], {
    name: "IV_VALUE",
    typeName: "CHAR40",
    optional: true,
    passByValue: true,
    description: "Value"
  })
  assert.deepEqual(patched.exceptions, [{ name: "INPUT_INVALID", description: "Invalid value" }])
  assert.deepEqual(patched.source, current.source)
  assert.equal(patched.helperCode, "FUNCTION_INTERFACE_PATCHED")
  assert.equal(
    patched.helperVerification,
    "the helper compared its own read-back of the documentation tables; it cannot verify interface parameters on this platform"
  )
  assert.equal(patched.sourceWritePerformed, false)
  // The helper branch writes parameter documentation only on SAP_BASIS 7.31, so the response must
  // report the platform limit rather than a parameter write that never happened.
  assert.equal(patched.interfaceWritePerformed, false)
  assert.equal(patched.interfaceWriteSupported, false)
  assert.equal(patched.parameterChangesApplied, false)
  assert.equal(backend.lastHelperRequest?.operation, "PATCH_FUNCTION_INTERFACE")
  assert.equal(backend.lastHelperRequest?.objectName, "ZCMCP_FM_1501")
  assert.equal(backend.lastHelperRequest?.program, "ZCMCP_FG_1501")
  assert.equal(backend.lastHelperRequest?.packageName, "ZABAP")
  assert.equal(backend.lastHelperRequest?.transportNumber, "GR2K923421")
  assert.equal(backend.lastHelperRequest?.expectedVersion, current.interfaceFingerprint)
  assert.ok(backend.lastHelperRequest?.source?.some((line) => line.startsWith("m|")))
  assert.ok(backend.lastHelperRequest?.source?.some((line) => line.startsWith("s|")))
  assert.ok(
    backend.lastHelperRequest?.source?.includes(
      's|1|LINE|*"--------------------------------------------------------------------'
    )
  )
  assert.ok(!backend.lastHelperRequest?.source?.some((line) => line.includes("&#34;")))
  assert.ok(backend.lastHelperRequest?.source?.includes("i|1|DBFIELD|"))
  // RSEXP has no OPTIONAL component, so an exporting payload row must never name it.
  assert.ok(!backend.lastHelperRequest?.source?.includes("e|1|OPTIONAL|"))
})

// The helper's PATCH_FUNCTION_INTERFACE pre-write guard rebuilds the interface from the payload
// rows and compares it field by field with its own RPY_FUNCTIONMODULE_READ of the active module,
// so the expected snapshot must carry the helper's canonical property set for every direction
// instead of whatever subset one repository read happened to return. `RSEXP` has no `OPTIONAL`
// component (verified against SAP_BASIS 7.31), so the exporting direction never emits it.
test("function interface patch snapshots the canonical helper row set for every direction", async () => {
  const backend = new MockBackend()
  const modules = (backend as unknown as { functionModules: Map<string, string[]> }).functionModules
  modules.set("ZCMCP_FM_1501", [
    "M|1|FUNCTION_GROUP|ZCMCP_FG_1501",
    "M|1|SHORT_TEXT|MCP RFC validation",
    "M|1|REMOTE_ENABLED|X",
    "M|1|UPDATE_TASK|",
    "M|1|GLOBAL_INTERFACE|",
    // The read payload is deliberately partial: the table row carries no DBSTRUCT row and no
    // OPTIONAL row exists for the exporting direction (`RSEXP` has no such component). Only a
    // snapshot rebuilt from the parsed interface can carry the helper's full canonical row set.
    "I|1|PARAMETER|IV_INPUT",
    "I|1|TYP|CHAR20",
    "I|1|DBFIELD|",
    "I|1|OPTIONAL|",
    "I|1|PASSVALUE|X",
    "E|1|PARAMETER|EV_OUTPUT",
    "E|1|TYP|CHAR40",
    "E|1|DBFIELD|",
    "E|1|PASSVALUE|X",
    "T|1|PARAMETER|ET_ITEMS",
    "T|1|TYP|BAPIRET2",
    "T|1|DBSTRUCT|BAPIRET2",
    "T|1|OPTIONAL|X",
    "C|1|PARAMETER|CV_STATE",
    "C|1|TYP|CHAR1",
    "C|1|OPTIONAL|X",
    "C|1|PASSVALUE|X",
    "X|1|EXCEPTION|INVALID_INPUT",
    "X|1|TEXT|Input is invalid",
    'S|1|LINE|*"--------------------------------------------------------------------',
    'S|2|LINE|*"*Local Interface:',
    'S|3|LINE|*"--------------------------------------------------------------------',
    "S|4|LINE|  CONCATENATE 'MCP:' iv_input INTO ev_output."
  ])
  const tools = new ToolService(backend)
  const current = JSON.parse(
    await tools.readFunctionModuleInterface({
      functionName: "ZCMCP_FM_1501",
      connectionId: "w200"
    })
  ) as { interfaceFingerprint: string; sourceFingerprint: string }

  await tools.patchFunctionModuleInterface({
    functionName: "ZCMCP_FM_1501",
    functionGroup: "ZCMCP_FG_1501",
    expectedInterfaceFingerprint: current.interfaceFingerprint,
    expectedSourceFingerprint: current.sourceFingerprint,
    parameterOperations: [
      {
        operation: "add",
        direction: "import",
        name: "IV_TEMP",
        typeName: "CHAR10",
        passByValue: true
      }
    ],
    exceptionOperations: [],
    packageName: "ZABAP",
    transportNumber: "GR2K923421",
    connectionId: "w200"
  })

  const payload = backend.lastHelperRequest?.source ?? []
  const expected = payload.filter((line) => /^[a-z]\|/.test(line))
  const desired = payload.filter((line) => /^[A-Z]\|/.test(line))
  // Every parameter direction is present with the helper's canonical properties and order
  // (IMPORTING, EXPORTING, CHANGING, TABLES), exactly as the helper's own emitter writes them.
  assert.deepEqual(expected, [
    "m|1|FUNCTION_GROUP|ZCMCP_FG_1501",
    "m|1|SHORT_TEXT|MCP RFC validation",
    "m|1|REMOTE_ENABLED|X",
    "m|1|UPDATE_TASK|",
    "m|1|GLOBAL_INTERFACE|",
    "m|1|SOURCE_FORMAT|PLAIN",
    "m|1|SOURCE_LINES|4",
    "i|1|PARAMETER|IV_INPUT",
    "i|1|TYP|CHAR20",
    "i|1|DBFIELD|",
    "i|1|OPTIONAL|",
    "i|1|PASSVALUE|X",
    "e|1|PARAMETER|EV_OUTPUT",
    "e|1|TYP|CHAR40",
    "e|1|DBFIELD|",
    "e|1|PASSVALUE|X",
    "c|1|PARAMETER|CV_STATE",
    "c|1|TYP|CHAR1",
    "c|1|DBFIELD|",
    "c|1|OPTIONAL|X",
    "c|1|PASSVALUE|X",
    "t|1|PARAMETER|ET_ITEMS",
    "t|1|TYP|BAPIRET2",
    "t|1|DBSTRUCT|BAPIRET2",
    "t|1|OPTIONAL|X",
    "x|1|EXCEPTION|INVALID_INPUT",
    "x|1|TEXT|Input is invalid",
    's|1|LINE|*"--------------------------------------------------------------------',
    's|2|LINE|*"*Local Interface:',
    's|3|LINE|*"--------------------------------------------------------------------',
    "s|4|LINE|  CONCATENATE 'MCP:' iv_input INTO ev_output."
  ])
  // An exporting row must never carry OPTIONAL: RSEXP has no such field, and the helper rejects
  // the payload outright when a snapshot row names an unknown component.
  assert.ok(
    !expected.some((line) => /^e\|\d+\|OPTIONAL\|/.test(line)),
    "exporting snapshot rows must not name OPTIONAL"
  )
  // The snapshot is rebuilt from the parsed interface, so no metadata row may carry an interface
  // property and no row may name a property outside the helper's recognizer set.
  assert.deepEqual(
    payload.filter((line) => line.startsWith("m|")).map((line) => line.split("|")[2] ?? ""),
    [
      "FUNCTION_GROUP",
      "SHORT_TEXT",
      "REMOTE_ENABLED",
      "UPDATE_TASK",
      "GLOBAL_INTERFACE",
      "SOURCE_FORMAT",
      "SOURCE_LINES"
    ]
  )
  const known = new Set([
    "PARAMETER",
    "TYP",
    "DBFIELD",
    "DBSTRUCT",
    "OPTIONAL",
    "PASSVALUE",
    "TEXT",
    "EXCEPTION",
    "LINE",
    "LENGTH",
    "PART1",
    "PART2",
    "PART3",
    "PART4",
    "PART5"
  ])
  assert.deepEqual(
    payload
      .filter((line) => !line.startsWith("m|"))
      .map((line) => line.split("|")[2] ?? "")
      .filter((property) => !known.has(property)),
    []
  )
  // The desired definition is unchanged: EXPORTING keeps its four-row shape and TABLES keeps
  // DBSTRUCT, so the write-back still matches what the helper reads for an unchanged module.
  assert.ok(desired.includes("E|1|PARAMETER|EV_OUTPUT"))
  assert.ok(desired.includes("E|1|TYP|CHAR40"))
  assert.ok(desired.includes("E|1|PASSVALUE|X"))
  assert.ok(!desired.some((line) => /^E\|\d+\|OPTIONAL\|/.test(line)))
  assert.ok(desired.includes("T|1|DBSTRUCT|BAPIRET2"))
  // The implementation source rows are still carried on both halves, so the helper's own
  // "interface patch cannot change source" guard sees an unchanged body.
  assert.ok(expected.includes("s|4|LINE|  CONCATENATE 'MCP:' iv_input INTO ev_output."))
  assert.ok(desired.includes("S|4|LINE|  CONCATENATE 'MCP:' iv_input INTO ev_output."))
})

test("RFC interface patch rejects reference parameters before any source write", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)
  const current = JSON.parse(
    await tools.readFunctionModuleInterface({
      functionName: "ZCMCP_FM_1501",
      connectionId: "w200"
    })
  ) as { interfaceFingerprint: string; sourceFingerprint: string }
  let writes = 0
  backend.replaceSource = async () => {
    writes++
    throw new Error("Unexpected SAP source write")
  }
  for (const direction of ["import", "export", "changing"] as const) {
    await assert.rejects(
      tools.patchFunctionModuleInterface({
        functionName: "ZCMCP_FM_1501",
        functionGroup: "ZCMCP_FG_1501",
        expectedInterfaceFingerprint: current.interfaceFingerprint,
        expectedSourceFingerprint: current.sourceFingerprint,
        parameterOperations: [
          { operation: "add", direction, name: "P_REF", typeName: "CHAR20", passByValue: false }
        ],
        exceptionOperations: [],
        packageName: "ZABAP",
        transportNumber: "GR2K923421",
        connectionId: "w200"
      }),
      /Reference parameters are not allowed with RFC/
    )
  }
  assert.equal(writes, 0)
  assert.equal(backend.lastRepositoryRequest?.operation, "READ_FUNCTION_INTERFACE")
})

test("function interface patch reports exact helper readback differences", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)
  const current = JSON.parse(
    await tools.readFunctionModuleInterface({
      functionName: "ZCMCP_FM_1501",
      connectionId: "w200"
    })
  ) as { interfaceFingerprint: string; sourceFingerprint: string }
  backend.functionPatchHelperMismatch = true

  await assert.rejects(
    tools.patchFunctionModuleInterface({
      functionName: "ZCMCP_FM_1501",
      functionGroup: "ZCMCP_FG_1501",
      expectedInterfaceFingerprint: current.interfaceFingerprint,
      expectedSourceFingerprint: current.sourceFingerprint,
      parameterOperations: [
        {
          operation: "add",
          direction: "import",
          name: "IV_TEMP",
          typeName: "CHAR10",
          passByValue: true,
          description: "Temporary"
        }
      ],
      exceptionOperations: [],
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      connectionId: "w200"
    }),
    /FUNCTION_PATCH_SAVE_NOT_OBSERVED/
  )
})

test("a rejected helper patch preserves bounded difference evidence", async () => {
  const backend = new MockBackend()
  backend.functionPatchHelperMismatch = true
  const tools = new ToolService(backend)
  const current = JSON.parse(
    await tools.readFunctionModuleInterface({
      functionName: "ZCMCP_FM_1501",
      connectionId: "w200"
    })
  ) as { interfaceFingerprint: string; sourceFingerprint: string }
  await assert.rejects(
    tools.patchFunctionModuleInterface({
      functionName: "ZCMCP_FM_1501",
      functionGroup: "ZCMCP_FG_1501",
      expectedInterfaceFingerprint: current.interfaceFingerprint,
      expectedSourceFingerprint: current.sourceFingerprint,
      parameterOperations: [
        {
          operation: "add",
          direction: "import",
          name: "IV_TEMP",
          typeName: "CHAR10",
          passByValue: true
        }
      ],
      exceptionOperations: [],
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      connectionId: "w200"
    }),
    (error: Error) => {
      assert.match(error.message, /FUNCTION_PATCH_SAVE_NOT_OBSERVED/)
      assert.match(error.message, /D\|1\|SECTION\|DOCUMENTATION/)
      assert.match(error.message, /D\|1\|ROW\|2\nD\|1\|FIELD\|INDEX/)
      assert.match(error.message, /D\|1\|EXPECTED\|1\nD\|1\|ACTUAL\|2/)
      assert.doesNotMatch(error.message, /unrelated source/)
      const rows = error.message.split("\n").filter((line) => line.startsWith("D|"))
      assert.equal(rows.length, 49)
      assert.ok(rows.every((line) => line.length <= 255))
      return true
    }
  )
})

test("function interface patch rejects an implementation source that changed under the helper", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)
  const current = JSON.parse(
    await tools.readFunctionModuleInterface({
      functionName: "ZCMCP_FM_1501",
      connectionId: "w200"
    })
  ) as { interfaceFingerprint: string; sourceFingerprint: string }
  backend.functionPatchSourceMutation = true

  await assert.rejects(
    tools.patchFunctionModuleInterface({
      functionName: "ZCMCP_FM_1501",
      functionGroup: "ZCMCP_FG_1501",
      expectedInterfaceFingerprint: current.interfaceFingerprint,
      expectedSourceFingerprint: current.sourceFingerprint,
      parameterOperations: [
        {
          operation: "add",
          direction: "import",
          name: "IV_TEMP",
          typeName: "CHAR10",
          passByValue: true,
          description: "Temporary"
        }
      ],
      exceptionOperations: [],
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      connectionId: "w200"
    }),
    /implementationSourceFingerprint/
  )
})

test("scalar RFC inputs reject DDIC character overflow before test or invocation", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)
  const metadata = JSON.parse(
    await tools.readFunctionModuleInterface({
      connectionId: "w200",
      functionName: "ZCMCP_FM_1501",
      includeExecutionSupport: true
    })
  ) as { fingerprint: string }
  const common = {
    connectionId: "w200",
    functionName: "ZCMCP_FM_1501",
    inputParameters: { IV_INPUT: "x".repeat(21) },
    acknowledgePotentialSideEffects: true as const,
    expectedInterfaceFingerprint: metadata.fingerprint
  }
  await assert.rejects(
    tools.testRemoteFunctionModule({
      ...common,
      expectedOutputs: { EV_OUTPUT: `MCP:${"x".repeat(21)}` }
    }),
    /IV_INPUT exceeds 20 characters/
  )
  await assert.rejects(
    tools.invokeCustomerFunctionModule({
      ...common,
      requestId: "overflow"
    }),
    /IV_INPUT exceeds 20 characters/
  )
  assert.equal(backend.remoteFunctionCalls, 0)
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
  const createdTable = JSON.parse(
    await tools.readDdicTransparentTable({ objectName: "ZCMCP_TAB_0831", connectionId: "w200" })
  ) as { version: string; fingerprint: string }
  const appendedTable = JSON.parse(
    await tools.appendDdicTransparentTableFields({
      objectName: "ZCMCP_TAB_0831",
      expectedVersion: createdTable.version,
      expectedFingerprint: createdTable.fingerprint,
      fields: [{ name: "MESSAGE", dataElement: "BAPI_MSG" }],
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      connectionId: "w200"
    })
  ) as {
    status: string
    definition: { fields: Array<{ name: string; key: boolean; notNull: boolean }> }
  }
  assert.equal(appendedTable.status, "DDIC_OBJECT_SAVED")
  assert.deepEqual(appendedTable.definition.fields.at(-1), {
    name: "MESSAGE",
    position: 4,
    dataElement: "BAPI_MSG",
    description: "",
    key: false,
    notNull: false
  })
  await assert.rejects(
    tools.appendDdicTransparentTableFields({
      objectName: "ZCMCP_TAB_0831",
      expectedVersion: createdTable.version,
      expectedFingerprint: createdTable.fingerprint,
      fields: [{ name: "NEXT_FIELD", dataElement: "BAPI_MSG" }],
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      connectionId: "w200"
    }),
    /VERSION_CONFLICT/
  )
  const updatedTable = JSON.parse(
    await tools.readDdicTransparentTable({ objectName: "ZCMCP_TAB_0831", connectionId: "w200" })
  ) as { version: string; fingerprint: string }
  await assert.rejects(
    tools.appendDdicTransparentTableFields({
      objectName: "ZCMCP_TAB_0831",
      expectedVersion: updatedTable.version,
      expectedFingerprint: "0".repeat(64),
      fields: [{ name: "NEXT_FIELD", dataElement: "BAPI_MSG" }],
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      connectionId: "w200"
    }),
    /FINGERPRINT_CONFLICT/
  )
  await assert.rejects(
    tools.appendDdicTransparentTableFields({
      objectName: "ZCMCP_TAB_0831",
      expectedVersion: updatedTable.version,
      expectedFingerprint: updatedTable.fingerprint,
      fields: [{ name: "NEXT_FIELD", dataElement: "ZCMCP_MISSING_DE" }],
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      connectionId: "w200"
    }),
    /DDIC_OBJECT_NOT_FOUND/
  )
  await assert.rejects(
    tools.appendDdicTransparentTableFields({
      objectName: "ZCMCP_TAB_0831",
      expectedVersion: updatedTable.version,
      expectedFingerprint: updatedTable.fingerprint,
      fields: [{ name: "MESSAGE", dataElement: "BAPI_MSG" }],
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      connectionId: "w200"
    }),
    /already exists/
  )
  await assert.rejects(
    tools.appendDdicTransparentTableFields({
      objectName: "ZCMCP_TAB_0831",
      expectedVersion: updatedTable.version,
      expectedFingerprint: updatedTable.fingerprint,
      fields: [{ name: "MANDT", dataElement: "MANDT" }],
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      connectionId: "w200"
    }),
    /MANDT cannot be appended/
  )
  const patchedTable = JSON.parse(
    await tools.patchDdicTransparentTableFields({
      objectName: "ZCMCP_TAB_0831",
      expectedVersion: updatedTable.version,
      expectedFingerprint: updatedTable.fingerprint,
      changes: [
        { action: "remove", fieldName: "DESCRIPTION" },
        { action: "rename", fieldName: "MESSAGE", newName: "DETAIL" },
        {
          action: "update",
          fieldName: "DETAIL",
          dataElement: "ZCODEX_MCP_DE_0831",
          notNull: true
        }
      ],
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      confirmation: "DESTRUCTIVE_SCHEMA_CHANGE",
      acknowledgeDataLoss: true,
      connectionId: "w200"
    })
  ) as {
    version: string
    fingerprint: string
    definition: {
      fields: Array<{
        name: string
        position: number
        dataElement: string
        key: boolean
        notNull: boolean
      }>
    }
  }
  assert.deepEqual(patchedTable.definition.fields, [
    {
      name: "MANDT",
      position: 1,
      dataElement: "MANDT",
      description: "",
      key: true,
      notNull: true
    },
    {
      name: "VALUE",
      position: 2,
      dataElement: "ZCODEX_MCP_DE_0831",
      description: "",
      key: true,
      notNull: true
    },
    {
      name: "DETAIL",
      position: 3,
      dataElement: "ZCODEX_MCP_DE_0831",
      description: "",
      key: false,
      notNull: true
    }
  ])
  await assert.rejects(
    tools.patchDdicTransparentTableFields({
      objectName: "ZCMCP_TAB_0831",
      expectedVersion: patchedTable.version,
      expectedFingerprint: patchedTable.fingerprint,
      changes: [{ action: "remove", fieldName: "MANDT" }],
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      confirmation: "DESTRUCTIVE_SCHEMA_CHANGE",
      acknowledgeDataLoss: true,
      connectionId: "w200"
    }),
    /MANDT cannot be changed/
  )
  await assert.rejects(
    tools.patchDdicTransparentTableFields({
      objectName: "ZCMCP_TAB_0831",
      expectedVersion: patchedTable.version,
      expectedFingerprint: patchedTable.fingerprint,
      changes: [{ action: "update", fieldName: "DETAIL" }],
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      confirmation: "DESTRUCTIVE_SCHEMA_CHANGE",
      acknowledgeDataLoss: true,
      connectionId: "w200"
    }),
    /has no attributes/
  )
  await assert.rejects(
    tools.patchDdicTransparentTableFields({
      objectName: "ZCMCP_TAB_0831",
      expectedVersion: patchedTable.version,
      expectedFingerprint: patchedTable.fingerprint,
      changes: [{ action: "rename", fieldName: "DETAIL", newName: "VALUE" }],
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      confirmation: "DESTRUCTIVE_SCHEMA_CHANGE",
      acknowledgeDataLoss: true,
      connectionId: "w200"
    }),
    /already exists/
  )
  await assert.rejects(
    tools.patchDdicTransparentTableFields({
      objectName: "ZCMCP_TAB_0831",
      expectedVersion: patchedTable.version,
      expectedFingerprint: patchedTable.fingerprint,
      changes: [
        { action: "update", fieldName: "VALUE", key: false },
        { action: "update", fieldName: "DETAIL", key: true }
      ],
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      confirmation: "DESTRUCTIVE_SCHEMA_CHANGE",
      acknowledgeDataLoss: true,
      connectionId: "w200"
    }),
    /Key fields must be contiguous/
  )
  await assert.rejects(
    tools.patchDdicTransparentTableFields({
      objectName: "ZCMCP_TAB_0831",
      expectedVersion: patchedTable.version,
      expectedFingerprint: "0".repeat(64),
      changes: [{ action: "remove", fieldName: "DETAIL" }],
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      confirmation: "DESTRUCTIVE_SCHEMA_CHANGE",
      acknowledgeDataLoss: true,
      connectionId: "w200"
    }),
    /FINGERPRINT_CONFLICT/
  )
  await assert.rejects(
    tools.deleteDdicObject({
      objectType: "TABL",
      objectName: "ZCMCP_TAB_0831",
      expectedVersion: patchedTable.version,
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      confirmation: "PERMANENT_DELETE",
      connectionId: "w200"
    }),
    /acknowledgeDataLoss must be true/
  )
  const deletedTable = JSON.parse(
    await tools.deleteDdicObject({
      objectType: "TABL",
      objectName: "ZCMCP_TAB_0831",
      expectedVersion: patchedTable.version,
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      confirmation: "PERMANENT_DELETE",
      acknowledgeDataLoss: true,
      connectionId: "w200"
    })
  ) as { objectType: string; absenceVerified: boolean }
  assert.equal(deletedTable.objectType, "TABL")
  assert.equal(deletedTable.absenceVerified, true)
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

test("DDIC complex-table fields, technical settings, and native conversion recovery stay gated", async () => {
  const tools = new ToolService(new MockBackend())
  const initial = JSON.parse(
    await tools.readDdicTransparentTable({ objectName: "ZCMCP_COMPLEX", connectionId: "w200" })
  ) as {
    version: string
    fingerprint: string
    definition: {
      fields: Array<{ name: string; componentKind?: string; componentName?: string }>
    }
  }
  assert.deepEqual(
    initial.definition.fields.map((field) => [
      field.name,
      field.componentKind ?? "field",
      field.componentName ?? ""
    ]),
    [
      ["ID", "field", ""],
      [".INCLUDE", "include", "ZCMCP_INC"],
      ["INC_VALUE", "inherited", ""],
      ["DIRECT_VALUE", "field", ""],
      [".INCLU--AP", "append", "ZCMCP_APPEND"],
      ["APP_VALUE", "inherited", ""]
    ]
  )
  await assert.rejects(
    tools.patchDdicTransparentTableFields({
      objectName: "ZCMCP_COMPLEX",
      expectedVersion: initial.version,
      expectedFingerprint: initial.fingerprint,
      changes: [{ action: "rename", fieldName: "INC_VALUE", newName: "FORBIDDEN" }],
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      confirmation: "DESTRUCTIVE_SCHEMA_CHANGE",
      acknowledgeDataLoss: true,
      connectionId: "w200"
    }),
    /COMPONENT_FIELD_NOT_PATCHABLE: INC_VALUE belongs to an Include\/Append component \(ZCMCP_INC, ZCMCP_APPEND\)/
  )
  await tools.patchDdicTransparentTableFields({
    objectName: "ZCMCP_COMPLEX",
    expectedVersion: initial.version,
    expectedFingerprint: initial.fingerprint,
    changes: [{ action: "rename", fieldName: "DIRECT_VALUE", newName: "DIRECT_TEXT" }],
    packageName: "ZABAP",
    transportNumber: "GR2K923421",
    confirmation: "DESTRUCTIVE_SCHEMA_CHANGE",
    acknowledgeDataLoss: true,
    connectionId: "w200"
  })
  const patched = JSON.parse(
    await tools.readDdicTransparentTable({ objectName: "ZCMCP_COMPLEX", connectionId: "w200" })
  ) as { version: string; fingerprint: string }
  const appended = JSON.parse(
    await tools.appendDdicTransparentTableFields({
      objectName: "ZCMCP_COMPLEX",
      expectedVersion: patched.version,
      expectedFingerprint: patched.fingerprint,
      fields: [{ name: "LOCAL_NOTE", dataElement: "CHAR40" }],
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      connectionId: "w200"
    })
  ) as {
    version: string
    fingerprint: string
    definition: { fields: Array<{ name: string; componentKind?: string }> }
  }
  assert.deepEqual(
    appended.definition.fields.map((field) => field.name),
    ["ID", ".INCLUDE", "INC_VALUE", "DIRECT_TEXT", "LOCAL_NOTE", ".INCLU--AP", "APP_VALUE"]
  )
  const settings = JSON.parse(
    await tools.patchDdicTransparentTableSettings({
      objectName: "ZCMCP_COMPLEX",
      expectedVersion: appended.version,
      expectedFingerprint: appended.fingerprint,
      settings: { buffering: "generic", genericKeyFields: 1, logDataChanges: true },
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      confirmation: "TECHNICAL_SETTINGS_CHANGE",
      connectionId: "w200"
    })
  ) as { definition: { buffering: string; genericKeyFields: number; logDataChanges: boolean } }
  assert.equal(settings.definition.buffering, "generic")
  assert.equal(settings.definition.genericKeyFields, 1)
  assert.equal(settings.definition.logDataChanges, true)

  const conversion = JSON.parse(
    await tools.readDdicTableConversionStatus({ objectName: "ZCMCP_CONV", connectionId: "w200" })
  ) as { pending: boolean; worklistFingerprint: string; entryCount: number }
  assert.equal(conversion.pending, true)
  assert.equal(conversion.entryCount, 1)
  assert.match(conversion.worklistFingerprint, /^[a-f0-9]{64}$/)
  const recovered = JSON.parse(
    await tools.recoverDdicTableConversion({
      objectName: "ZCMCP_CONV",
      expectedWorklistFingerprint: conversion.worklistFingerprint,
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      confirmation: "RECOVER_NATIVE_TABLE_CONVERSION",
      acknowledgePotentialDataLoss: true,
      connectionId: "w200"
    })
  ) as {
    recovered: boolean
    automaticRetry: boolean
    automaticRollback: boolean
    lostValuesReconstructed: boolean
  }
  assert.equal(recovered.recovered, true)
  assert.equal(recovered.automaticRetry, false)
  assert.equal(recovered.automaticRollback, false)
  assert.equal(recovered.lostValuesReconstructed, false)
})

test("enhancement source inspection separates native metadata from factual source markers", async () => {
  const backend = new MockBackend()
  backend.readSource = async () => ({
    source: [
      "FORM userexit_save_document.",
      "CALL CUSTOMER-FUNCTION '001'.",
      "GET BADI lo_badi.",
      "CALL FUNCTION 'OPEN_FI_PERFORM_CS000010_E'.",
      "ENHANCEMENT-POINT z_demo SPOTS zes_demo.",
      "* CALL BADI ignored_comment."
    ].join("\n"),
    uriUsed: "/sap/bc/adt/programs/programs/zcl_demo/source/main"
  })
  const result = JSON.parse(
    await new ToolService(backend).inspectSourceEnhancements({
      objectName: "ZCL_DEMO",
      objectType: "CLAS",
      includeImplementationSource: true,
      connectionId: "w200"
    })
  ) as {
    metadata: {
      status: string
      implementationCount: number
      elementCount: number
      implementations: Array<{
        name: string
        type: string
        version: string
        elementId: string
        fullname: string
        mode: string
        replacing: boolean
        startLine: number
        startColumn: number
        positionUri: string
        sourceFingerprint: string
        enhancedObject: { uri: string; type: string; name: string }
      }>
    }
    sourceMarkers: Array<{ family: string; marker: string; line: number }>
    coverage: {
      activeEnhancementElementsInspected: boolean
      implementationAndElementMetadataPreserved: boolean
      positionCoordinatesZeroBased: boolean
      configurationInspected: boolean
      newBadiDefinitionInspected: boolean
      filterOrSwitchConfigurationInspected: boolean
      runtimeInspected: boolean
    }
  }

  assert.equal(result.metadata.status, "available")
  assert.equal(result.metadata.implementationCount, 1)
  assert.equal(result.metadata.elementCount, 1)
  assert.equal(result.metadata.implementations.length, 1)
  assert.deepEqual(result.metadata.implementations[0], {
    name: "ZENH_DEMO",
    type: "ENHO/XH",
    version: "active",
    elementId: "1",
    fullname: "\\PR:ZCL_DEMO\\SE:Z_DEMO\\EI",
    mode: "any",
    replacing: false,
    startLine: 3,
    startColumn: 0,
    uri: "/sap/bc/adt/enhancements/z_enh_demo",
    positionUri: "/sap/bc/adt/programs/programs/zcl_demo/source/main#start=4,0",
    source: "WRITE 'ENHANCEMENT'.",
    sourceFingerprint: createHash("sha256").update("WRITE 'ENHANCEMENT'.").digest("hex"),
    enhancedObject: {
      uri: "/sap/bc/adt/programs/programs/zcl_demo",
      type: "PROG/P",
      name: "ZCL_DEMO"
    }
  })
  assert.deepEqual(
    result.sourceMarkers.map(({ family, marker, line }) => ({ family, marker, line })),
    [
      { family: "user_exit", marker: "form_userexit", line: 1 },
      { family: "customer_exit", marker: "call_customer_function", line: 2 },
      { family: "badi", marker: "get_or_call_badi", line: 3 },
      { family: "bte", marker: "open_fi_perform", line: 4 },
      { family: "enhancement_framework", marker: "enhancement_point", line: 5 }
    ]
  )
  assert.equal(result.coverage.activeEnhancementElementsInspected, true)
  assert.equal(result.coverage.implementationAndElementMetadataPreserved, true)
  assert.equal(result.coverage.positionCoordinatesZeroBased, true)
  assert.equal(result.coverage.configurationInspected, false)
  assert.equal(result.coverage.newBadiDefinitionInspected, false)
  assert.equal(result.coverage.filterOrSwitchConfigurationInspected, false)
  assert.equal(result.coverage.runtimeInspected, false)
})

test("enhancement source inspection reports unavailable metadata without claiming zero implementations", async () => {
  const backend = new MockBackend()
  backend.readEnhancements = async () => {
    throw new Error("enhancement metadata read capability unsupported-endpoint (HTTP 404)")
  }
  const result = JSON.parse(
    await new ToolService(backend).inspectSourceEnhancements({
      objectName: "ZCL_DEMO",
      objectType: "CLAS",
      connectionId: "w200"
    })
  ) as {
    metadata: {
      status: string
      implementationCount: number | null
      elementCount: number | null
      implementations: unknown[]
    }
  }

  assert.equal(result.metadata.status, "unsupported")
  assert.equal(result.metadata.implementationCount, null)
  assert.equal(result.metadata.elementCount, null)
  assert.deepEqual(result.metadata.implementations, [])
})

test("enhancement implementation containers do not masquerade as empty source", async () => {
  const backend = new MockBackend()
  backend.searchObjects = async () => [
    {
      name: "ZLE_SHP_DELIVERY_PROC",
      type: "ENHO/XH",
      description: "Delivery implementation",
      package: "ZLE",
      systemType: "CUSTOM",
      uri: "/sap/bc/adt/enhancements/zle_shp_delivery_proc"
    }
  ]
  backend.readSource = async () => ({
    source: "",
    uriUsed: "/sap/bc/adt/enhancements/zle_shp_delivery_proc/source/main"
  })
  backend.readEnhancements = async () =>
    assert.fail("container metadata must not be read as source")

  const result = JSON.parse(
    await new ToolService(backend).inspectSourceEnhancements({
      objectName: "ZLE_SHP_DELIVERY_PROC",
      objectType: "ENHO",
      connectionId: "w200"
    })
  ) as {
    object: { sourceStatus: string; sourceFingerprint: string | null }
    metadata: { status: string; implementationCount: number | null }
    sourceMarkers: unknown[]
  }

  assert.equal(result.object.sourceStatus, "not_applicable")
  assert.equal(result.object.sourceFingerprint, null)
  assert.equal(result.metadata.status, "not_applicable")
  assert.equal(result.metadata.implementationCount, null)
  assert.deepEqual(result.sourceMarkers, [])
})

test("enhancement repository search preserves per-type availability", async () => {
  const backend = new MockBackend()
  backend.searchObjectTypes = async () => [
    {
      requestedType: "BADI",
      status: "available",
      objects: [
        {
          name: "ZBADI_DEMO",
          type: "BADI/OI",
          description: "Demo BAdI",
          package: "ZVALIDATION",
          systemType: "CUSTOM",
          uri: "/sap/bc/adt/enhancements/badi/zbadi_demo"
        }
      ]
    },
    {
      requestedType: "ENHS",
      status: "unsupported",
      objects: [],
      reason: "The SAP system does not expose repository search for this object type."
    }
  ]
  const result = JSON.parse(
    await new ToolService(backend).searchEnhancementObjects({
      pattern: "Z*",
      types: ["BADI", "ENHS"],
      connectionId: "w200"
    })
  ) as {
    results: Array<{
      requestedType: string
      repositoryKind: string
      status: string
      count: number | null
    }>
    summary: { availableTypeCount: number; unavailableTypeCount: number; objectCount: number }
    coverage: { classicVersusNewBadiDetermined: boolean }
  }

  assert.deepEqual(
    result.results.map(({ requestedType, repositoryKind, status, count }) => ({
      requestedType,
      repositoryKind,
      status,
      count
    })),
    [
      {
        requestedType: "BADI",
        repositoryKind: "badi_definition",
        status: "available",
        count: 1
      },
      {
        requestedType: "ENHS",
        repositoryKind: "enhancement_spot",
        status: "unsupported",
        count: null
      }
    ]
  )
  assert.deepEqual(result.summary, {
    requestedTypeCount: 2,
    availableTypeCount: 1,
    unavailableTypeCount: 1,
    objectCount: 1
  })
  assert.equal(result.coverage.classicVersusNewBadiDetermined, false)
})

test("customer exit repository search keeps SMOD and CMOD evidence separate", async () => {
  const backend = new MockBackend()
  backend.searchObjectTypes = async () => [
    {
      requestedType: "SMOD",
      status: "available",
      objects: [
        {
          name: "V45A0002",
          type: "SMOD",
          description: "Sample customer enhancement",
          package: "VA",
          systemType: "STANDARD",
          uri: "/sap/bc/adt/repository/informationsystem/object_type/smod/object_name/v45a0002"
        }
      ]
    },
    { requestedType: "CMOD", status: "available", objects: [] }
  ]
  const result = JSON.parse(
    await new ToolService(backend).searchCustomerExitObjects({
      pattern: "V45A*",
      connectionId: "w200"
    })
  ) as {
    results: Array<{
      requestedType: string
      repositoryKind: string
      status: string
      count: number | null
    }>
    summary: { availableTypeCount: number; unavailableTypeCount: number; objectCount: number }
    coverage: { componentsInspected: boolean; activationStatusInspected: boolean }
  }

  assert.deepEqual(
    result.results.map(({ requestedType, repositoryKind, status, count }) => ({
      requestedType,
      repositoryKind,
      status,
      count
    })),
    [
      {
        requestedType: "SMOD",
        repositoryKind: "customer_exit_definition",
        status: "available",
        count: 1
      },
      {
        requestedType: "CMOD",
        repositoryKind: "customer_exit_project",
        status: "available",
        count: 0
      }
    ]
  )
  assert.deepEqual(result.summary, {
    requestedTypeCount: 2,
    availableTypeCount: 2,
    unavailableTypeCount: 0,
    objectCount: 1
  })
  assert.equal(result.coverage.componentsInspected, false)
  assert.equal(result.coverage.activationStatusInspected, false)
})

test("customer exit definition read returns exact components and raw type codes", async () => {
  const backend = new MockBackend()
  const result = JSON.parse(
    await new ToolService(backend).readCustomerExitDefinition({
      enhancementName: "v45a0002",
      connectionId: "w200"
    })
  ) as {
    definition: {
      name: string
      description: string
      components: Array<{ typeCode: string; kind: string; member: string }>
    }
    summary: {
      componentCount: number
      functionExitCount: number
      screenExitCount: number
      menuExitCount: number
      unknownComponentCount: number
    }
    coverage: {
      componentMembershipInspected: boolean
      cmodProjectAssignmentsInspected: boolean
    }
  }

  assert.deepEqual(result.definition, {
    name: "V45A0002",
    description: "Predefine sold-to party",
    components: [
      { typeCode: "E", kind: "function_exit", member: "EXIT_SAPMV45A_002" },
      { typeCode: "S", kind: "screen_exit", member: "SAPMV45A_8309_SUB_B" },
      { typeCode: "C", kind: "menu_exit", member: "SAPMV45A+ZZ1" }
    ]
  })
  assert.deepEqual(result.summary, {
    componentCount: 3,
    functionExitCount: 1,
    screenExitCount: 1,
    menuExitCount: 1,
    unknownComponentCount: 0
  })
  assert.equal(result.coverage.componentMembershipInspected, true)
  assert.equal(result.coverage.cmodProjectAssignmentsInspected, false)
  assert.equal(backend.lastRepositoryRequest?.operation, "READ_CUSTOMER_EXIT_DEFINITION")
  assert.equal(backend.lastRepositoryRequest?.objectName, "V45A0002")
})

test("customer exit project read preserves raw status and exact assignments", async () => {
  const backend = new MockBackend()
  const result = JSON.parse(
    await new ToolService(backend).readCustomerExitProject({
      projectName: "zsd_exit",
      connectionId: "w200"
    })
  ) as {
    project: {
      name: string
      rawStatus: string
      changedBy: string
      changedOn: string
      assignments: Array<{ enhancementName: string; assignmentType: string }>
    }
    summary: { assignmentCount: number }
    coverage: {
      enhancementAssignmentsInspected: boolean
      rawProjectStatusInspected: boolean
      activationStateInterpreted: boolean
    }
  }

  assert.deepEqual(result.project, {
    name: "ZSD_EXIT",
    rawStatus: "A",
    changedBy: "DEVELOPER",
    changedOn: "20260916",
    assignments: [
      { enhancementName: "V45A0002", assignmentType: "" },
      { enhancementName: "V45A0003", assignmentType: "" }
    ]
  })
  assert.deepEqual(result.summary, { assignmentCount: 2 })
  assert.equal(result.coverage.enhancementAssignmentsInspected, true)
  assert.equal(result.coverage.rawProjectStatusInspected, true)
  assert.equal(result.coverage.activationStateInterpreted, false)
  assert.equal(backend.lastRepositoryRequest?.operation, "READ_CUSTOMER_EXIT_PROJECT")
  assert.equal(backend.lastRepositoryRequest?.objectName, "ZSD_EXIT")
})

test("customer function exit inspection resolves static calls and ZX includes", async () => {
  const backend = new MockBackend()
  const program = {
    name: "SAPMV45A",
    type: "PROG/P",
    description: "Sales document processing",
    package: "VA",
    systemType: "STANDARD" as const,
    uri: "/sap/bc/adt/programs/programs/sapmv45a"
  }
  const include = {
    name: "SAPMV45A_F01",
    type: "PROG/I",
    description: "Customer function calls",
    package: "VA",
    systemType: "STANDARD" as const,
    uri: "/sap/bc/adt/programs/includes/sapmv45a_f01"
  }
  const exitFunction = {
    name: "EXIT_SAPMV45A_001",
    type: "FUNC",
    description: "Customer function exit",
    package: "VA",
    systemType: "STANDARD" as const,
    uri: "/sap/bc/adt/functions/groups/v45a/fmodules/exit_sapmv45a_001"
  }
  backend.searchObjects = async (_connectionId, pattern) => {
    if (pattern.toUpperCase() === program.name) return [program]
    if (pattern.toUpperCase() === include.name) return [include]
    return []
  }
  backend.searchObjectTypes = async (_connectionId, pattern) => {
    if (pattern === exitFunction.name) {
      return [{ requestedType: "FUNC", status: "available", objects: [exitFunction] }]
    }
    return [
      {
        requestedType: "FUNC",
        status: "forbidden",
        objects: [],
        reason: "Function repository search is forbidden."
      }
    ]
  }
  backend.readSource = async (_connectionId, object) => {
    if (object.name === program.name) {
      return {
        source: "PROGRAM sapmv45a.\nINCLUDE SAPMV45A_F01.",
        uriUsed: program.uri + "/source/main"
      }
    }
    if (object.name === include.name) {
      return {
        source: [
          "FORM dispatch.",
          "  CALL CUSTOMER-FUNCTION",
          "    '001'",
          "    EXPORTING value = value.",
          "  CALL CUSTOMER-FUNCTION '002'.",
          "  CALL CUSTOMER-FUNCTION lv_exit.",
          "* CALL CUSTOMER-FUNCTION '999'.",
          "ENDFORM."
        ].join("\n"),
        uriUsed: include.uri + "/source/main"
      }
    }
    return {
      source: ["FUNCTION exit_sapmv45a_001.", "  INCLUDE ZXVVFU01.", "ENDFUNCTION."].join("\n"),
      uriUsed: exitFunction.uri + "/source/main"
    }
  }

  const result = JSON.parse(
    await new ToolService(backend).inspectCustomerFunctionExits({
      programName: "sapmv45a",
      connectionId: "w200"
    })
  ) as {
    sourceGraph: { complete: boolean; includeLimit: number; unitCount: number }
    functionExits: Array<{
      exitNumber: string
      expectedFunctionModule: string
      repositorySearch: { status: string; functionFound: boolean | null }
      functionSource: {
        status: string
        zxImplementationIncludes: string[]
      } | null
    }>
    unresolvedCalls: Array<{ unresolvedOperand: string | null }>
    summary: {
      callSiteCount: number
      staticCallSiteCount: number
      unresolvedCallSiteCount: number
      distinctStaticExitCount: number
      functionFoundCount: number
      zxImplementationIncludeCount: number
    }
    coverage: {
      cmodProjectAssignmentsInspected: boolean
      screenExitsInspected: boolean
      menuExitsInspected: boolean
    }
  }

  assert.equal(result.sourceGraph.complete, true)
  assert.equal(result.sourceGraph.includeLimit, 128)
  assert.equal(result.sourceGraph.unitCount, 2)
  assert.deepEqual(
    result.functionExits.map((entry) => ({
      exitNumber: entry.exitNumber,
      expectedFunctionModule: entry.expectedFunctionModule,
      status: entry.repositorySearch.status,
      functionFound: entry.repositorySearch.functionFound,
      zxIncludes: entry.functionSource?.zxImplementationIncludes ?? []
    })),
    [
      {
        exitNumber: "001",
        expectedFunctionModule: "EXIT_SAPMV45A_001",
        status: "available",
        functionFound: true,
        zxIncludes: ["ZXVVFU01"]
      },
      {
        exitNumber: "002",
        expectedFunctionModule: "EXIT_SAPMV45A_002",
        status: "forbidden",
        functionFound: null,
        zxIncludes: []
      }
    ]
  )
  assert.deepEqual(result.unresolvedCalls, [
    {
      objectName: "SAPMV45A_F01",
      objectType: "PROG/I",
      sourceUri: include.uri + "/source/main",
      line: 6,
      endLine: 6,
      statement: "CALL CUSTOMER-FUNCTION lv_exit.",
      exitNumber: null,
      unresolvedOperand: "lv_exit"
    }
  ])
  assert.deepEqual(result.summary, {
    callSiteCount: 3,
    staticCallSiteCount: 2,
    unresolvedCallSiteCount: 1,
    distinctStaticExitCount: 2,
    functionFoundCount: 1,
    zxImplementationIncludeCount: 1
  })
  assert.equal(result.coverage.cmodProjectAssignmentsInspected, false)
  assert.equal(result.coverage.screenExitsInspected, false)
  assert.equal(result.coverage.menuExitsInspected, false)
})

test("customer function exit inspection reads beyond the former 32-include boundary", async () => {
  const backend = new MockBackend()
  const program = {
    name: "SAPMV50A",
    type: "PROG/P",
    description: "Delivery processing",
    package: "VL",
    systemType: "STANDARD" as const,
    uri: "/sap/bc/adt/programs/programs/sapmv50a"
  }
  const includes = Array.from({ length: 40 }, (_, index) => {
    const name = `ZV50_TEST_${String(index + 1).padStart(2, "0")}`
    return {
      name,
      type: "PROG/I",
      description: "Test include",
      package: "ZTEST",
      systemType: "CUSTOM" as const,
      uri: `/sap/bc/adt/programs/includes/${name.toLowerCase()}`
    }
  })
  backend.searchObjects = async (_connectionId, pattern) => {
    const name = pattern.toUpperCase()
    if (name === program.name) return [program]
    const include = includes.find((candidate) => candidate.name === name)
    return include ? [include] : []
  }
  backend.searchObjectTypes = async () => [
    { requestedType: "FUNC", status: "available", objects: [] }
  ]
  backend.readSource = async (_connectionId, object) => ({
    source:
      object.name === program.name
        ? includes.map((include) => `INCLUDE ${include.name}.`).join("\n")
        : object.name === includes[39]!.name
          ? "CALL CUSTOMER-FUNCTION '001'."
          : "",
    uriUsed: object.uri + "/source/main"
  })

  const result = JSON.parse(
    await new ToolService(backend).inspectCustomerFunctionExits({
      programName: program.name,
      connectionId: "w200"
    })
  ) as {
    sourceGraph: { complete: boolean; includeLimit: number; unitCount: number; truncated: boolean }
    summary: { staticCallSiteCount: number }
  }

  assert.equal(result.sourceGraph.includeLimit, 128)
  assert.equal(result.sourceGraph.unitCount, 41)
  assert.equal(result.sourceGraph.truncated, false)
  assert.equal(result.sourceGraph.complete, true)
  assert.equal(result.summary.staticCallSiteCount, 1)
})

test("customer screen and menu exit inspection preserves independent evidence", async () => {
  const backend = new MockBackend()
  const callSapRepository = backend.callSapRepository.bind(backend)
  backend.callSapRepository = async (connectionId, request) => {
    if (request.operation === "READ_SCREEN" && request.screen === "0200") {
      throw new Error("HTTP 403 Forbidden")
    }
    const result = await callSapRepository(connectionId, request)
    if (request.operation === "READ_SCREEN") {
      result.flowLogic = [
        { LINE: "PROCESS BEFORE OUTPUT." },
        { LINE: "  CALL CUSTOMER-SUBSCREEN CUSTSCR1." },
        { LINE: "* CALL CUSTOMER-SUBSCREEN IGNORED." },
        { LINE: "PROCESS AFTER INPUT." },
        { LINE: "  CALL CUSTOMER-SUBSCREEN CUSTSCR1." }
      ]
    }
    if (request.operation === "READ_GUI_DEFINITION") {
      result.source.push(
        "FUN|2|CODE|+CUS",
        "FUN|2|TEXTNO|002",
        "FUN|2|FUN_TEXT|Customer action",
        "SET|2|STATUS|STATUS_0100",
        "SET|2|FUNCTION|+CUS"
      )
    }
    return result
  }

  const result = JSON.parse(
    await new ToolService(backend).inspectCustomerScreenMenuExits({
      programName: "sapmv45a",
      screenNumbers: ["0100", "0200", "0100"],
      connectionId: "w200"
    })
  ) as {
    screens: Array<{
      screenNumber: string
      status: string
      hookCount: number | null
      hooks: Array<{ area: string; line: number }>
    }>
    menu: {
      status: string
      definitionCount: number | null
      definitions: Array<{ code: string; functionText: string }>
      references: Array<{ section: string; field: string; code: string }>
    }
    summary: {
      screenInspectionStatus: string
      requestedScreenCount: number
      availableScreenCount: number
      unavailableScreenCount: number
      customerSubscreenHookCount: number
      menuDefinitionCount: number | null
    }
    coverage: {
      smodComponentsInspected: boolean
      cmodProjectAssignmentsInspected: boolean
      activationStatusInspected: boolean
      runtimeInspected: boolean
      screensInspected: boolean
      screenAbsenceEstablished: boolean
    }
  }

  assert.deepEqual(
    result.screens.map((screen) => ({
      screenNumber: screen.screenNumber,
      status: screen.status,
      hookCount: screen.hookCount,
      hooks: screen.hooks.map(({ area, line }) => ({ area, line }))
    })),
    [
      {
        screenNumber: "0100",
        status: "available",
        hookCount: 2,
        hooks: [
          { area: "CUSTSCR1", line: 2 },
          { area: "CUSTSCR1", line: 5 }
        ]
      },
      {
        screenNumber: "0200",
        status: "forbidden",
        hookCount: null,
        hooks: []
      }
    ]
  )
  assert.equal(result.menu.status, "available")
  assert.equal(result.menu.definitionCount, 1)
  assert.deepEqual(result.menu.definitions, [
    {
      code: "+CUS",
      textNumber: "002",
      functionText: "Customer action",
      iconText: "",
      infoText: ""
    }
  ])
  assert.deepEqual(result.menu.references, [
    { section: "statusFunctions", row: 1, field: "FUNCTION", code: "+CUS" }
  ])
  assert.deepEqual(result.summary, {
    screenInspectionStatus: "requested",
    requestedScreenCount: 2,
    availableScreenCount: 1,
    unavailableScreenCount: 1,
    customerSubscreenHookCount: 2,
    menuDefinitionCount: 1
  })
  assert.equal(result.coverage.smodComponentsInspected, false)
  assert.equal(result.coverage.cmodProjectAssignmentsInspected, false)
  assert.equal(result.coverage.activationStatusInspected, false)
  assert.equal(result.coverage.runtimeInspected, false)
  assert.equal(result.coverage.screensInspected, true)
  assert.equal(result.coverage.screenAbsenceEstablished, false)

  const noScreens = JSON.parse(
    await new ToolService(backend).inspectCustomerScreenMenuExits({
      programName: "sapmv45a",
      connectionId: "w200"
    })
  ) as {
    screens: unknown[]
    summary: { screenInspectionStatus: string; requestedScreenCount: number }
    coverage: { screensInspected: boolean; screenAbsenceEstablished: boolean }
  }
  assert.deepEqual(noScreens.screens, [])
  assert.equal(noScreens.summary.screenInspectionStatus, "not_requested")
  assert.equal(noScreens.summary.requestedScreenCount, 0)
  assert.equal(noScreens.coverage.screensInspected, false)
  assert.equal(noScreens.coverage.screenAbsenceEstablished, false)
})

test("BTE dispatcher search separates event and process evidence", async () => {
  const backend = new MockBackend()
  const patterns: string[] = []
  backend.searchObjectTypes = async (_connectionId, pattern) => {
    patterns.push(pattern)
    if (pattern.endsWith("_P")) {
      return [
        {
          requestedType: "FUNC",
          status: "unsupported",
          objects: [],
          reason: "Function repository search is unavailable."
        }
      ]
    }
    return [
      {
        requestedType: "FUNC",
        status: "available",
        objects: [
          {
            name: "OPEN_FI_PERFORM_00001030_E",
            type: "FUNC",
            description: "BTE event dispatcher",
            package: "BFIBL_PAYM",
            systemType: "STANDARD",
            uri: "/sap/bc/adt/functions/groups/open_fi_perform_00001030_e"
          },
          {
            name: "OPEN_FI_PERFORM_DEMO_E",
            type: "FUNC",
            description: "Alphanumeric BTE event dispatcher",
            package: "ZDEMO",
            systemType: "CUSTOM",
            uri: "/sap/bc/adt/functions/groups/open_fi_perform_demo_e"
          }
        ]
      }
    ]
  }
  const result = JSON.parse(
    await new ToolService(backend).searchBteDispatchers({
      eventPattern: "00001*",
      connectionId: "w200"
    })
  ) as {
    results: Array<{
      kind: string
      pattern: string
      status: string
      count: number | null
      objects: Array<{
        eventIdentifier: string | null
        eventNumber: string | null
        exactDispatcherName: boolean
      }>
    }>
    summary: {
      availableKindCount: number
      unavailableKindCount: number
      exactDispatcherCount: number
    }
    coverage: {
      dispatcherSearchOnly: boolean
      productsInspected: boolean
      handlerAssignmentsInspected: boolean
      runtimeInspected: boolean
    }
  }

  assert.deepEqual(patterns, ["OPEN_FI_PERFORM_00001*_E", "OPEN_FI_PERFORM_00001*_P"])
  assert.deepEqual(
    result.results.map(({ kind, status, count }) => ({ kind, status, count })),
    [
      { kind: "event", status: "available", count: 2 },
      { kind: "process", status: "unsupported", count: null }
    ]
  )
  assert.deepEqual(
    result.results[0]?.objects.map(({ eventIdentifier, eventNumber, exactDispatcherName }) => ({
      eventIdentifier,
      eventNumber,
      exactDispatcherName
    })),
    [
      {
        eventIdentifier: "00001030",
        eventNumber: "00001030",
        exactDispatcherName: true
      },
      { eventIdentifier: "DEMO", eventNumber: null, exactDispatcherName: true }
    ]
  )
  assert.deepEqual(result.summary, {
    requestedKindCount: 2,
    availableKindCount: 1,
    unavailableKindCount: 1,
    objectCount: 2,
    exactDispatcherCount: 2
  })
  assert.deepEqual(result.coverage, {
    dispatcherSearchOnly: true,
    productsInspected: false,
    handlerAssignmentsInspected: false,
    runtimeInspected: false
  })
})

test("BTE configuration read separates Event handlers and preserves raw activation", async () => {
  const backend = new MockBackend()
  const result = JSON.parse(
    await new ToolService(backend).readBteConfiguration({
      kind: "event",
      identifier: "cs000010",
      connectionId: "w200"
    })
  ) as {
    repositoryKind: string
    configuration: {
      kind: string
      identifier: string
      description: string
      sapHandlers: Array<Record<string, string>>
      customerHandlers: Array<Record<string, string>>
    }
    summary: {
      sapHandlerCount: number
      customerHandlerCount: number
      activeSapApplicationHandlerCount: number
      activeCustomerProductHandlerCount: number
    }
    coverage: {
      exactDefinitionRead: boolean
      sapApplicationAssignmentsInspected: boolean
      customerProductAssignmentsInspected: boolean
      rawActivationFlagsInspected: boolean
      executionOrderInterpreted: boolean
      runtimeInspected: boolean
    }
  }

  assert.equal(result.repositoryKind, "bte_event_configuration")
  assert.equal(result.configuration.kind, "event")
  assert.equal(result.configuration.identifier, "CS000010")
  assert.equal(result.configuration.description, "Credit status event")
  assert.deepEqual(result.configuration.sapHandlers, [
    {
      country: "",
      applicationIndicator: "CS",
      functionModule: "SAMPLE_INTERFACE_CS000010",
      product: "",
      applicationActiveRaw: "X",
      applicationText: "Credit Management",
      productActiveRaw: "",
      productText: "",
      productRfcDestination: ""
    }
  ])
  assert.deepEqual(result.configuration.customerHandlers, [
    {
      country: "",
      applicationIndicator: "CS",
      functionModule: "Z_BTE_CS000010",
      product: "ZBTE",
      applicationActiveRaw: "X",
      applicationText: "Credit Management",
      productActiveRaw: "X",
      productText: "Customer BTE handlers",
      productRfcDestination: ""
    }
  ])
  assert.deepEqual(result.summary, {
    sapHandlerCount: 1,
    customerHandlerCount: 1,
    activeSapApplicationHandlerCount: 1,
    activeCustomerProductHandlerCount: 1
  })
  assert.equal(result.coverage.exactDefinitionRead, true)
  assert.equal(result.coverage.sapApplicationAssignmentsInspected, true)
  assert.equal(result.coverage.customerProductAssignmentsInspected, true)
  assert.equal(result.coverage.rawActivationFlagsInspected, true)
  assert.equal(result.coverage.executionOrderInterpreted, false)
  assert.equal(result.coverage.runtimeInspected, false)
  assert.equal(backend.lastRepositoryRequest?.operation, "READ_BTE_CONFIGURATION")
  assert.equal(backend.lastRepositoryRequest?.objectType, "E")
  assert.equal(backend.lastRepositoryRequest?.objectName, "CS000010")
})

test("BTE configuration read keeps Process configuration independent", async () => {
  const backend = new MockBackend()
  const result = JSON.parse(
    await new ToolService(backend).readBteConfiguration({
      kind: "process",
      identifier: "crm0_200",
      connectionId: "w200"
    })
  ) as {
    repositoryKind: string
    configuration: {
      kind: string
      identifier: string
      sapHandlers: Array<Record<string, string>>
      customerHandlers: Array<Record<string, string>>
    }
    summary: { sapHandlerCount: number; customerHandlerCount: number }
  }

  assert.equal(result.repositoryKind, "bte_process_configuration")
  assert.equal(result.configuration.kind, "process")
  assert.equal(result.configuration.identifier, "CRM0_200")
  assert.deepEqual(result.configuration.sapHandlers, [])
  assert.equal(result.configuration.customerHandlers[0]?.functionModule, "Z_BTE_CRM0_200")
  assert.equal(result.configuration.customerHandlers[0]?.productActiveRaw, "")
  assert.equal(result.summary.sapHandlerCount, 0)
  assert.equal(result.summary.customerHandlerCount, 1)
  assert.equal(backend.lastRepositoryRequest?.objectType, "P")
  assert.equal(backend.lastRepositoryRequest?.objectName, "CRM0_200")
})

test("controlled CMOD workflow includes exact read evidence and human gates", async () => {
  const backend = new MockBackend()
  const result = JSON.parse(
    await new ToolService(backend).prepareEnhancementConfigurationWorkflow({
      kind: "cmod_project",
      targetName: "zsd_exit",
      desiredState: "active",
      enhancementNames: ["v45a0002"],
      packageName: "ZSD",
      transportNumber: "W20K900001",
      connectionId: "w200"
    })
  ) as {
    executionMode: string
    transaction: string
    readiness: string
    missingInputs: string[]
    currentState: {
      project: { status: string }
      definitions: Array<{ enhancementName: string; status: string; evidence: unknown }>
    }
    workflow: Array<{ phase: string; destructive: boolean }>
    controls: Record<string, boolean>
  }

  assert.equal(result.executionMode, "controlled_manual_workflow")
  assert.equal(result.transaction, "CMOD")
  assert.equal(result.readiness, "ready_for_human_execution")
  assert.deepEqual(result.missingInputs, [])
  assert.equal(result.currentState.project.status, "available")
  assert.equal(result.currentState.definitions[0]?.enhancementName, "V45A0002")
  assert.equal(result.currentState.definitions[0]?.status, "available")
  assert.ok(result.currentState.definitions[0]?.evidence)
  assert.equal(result.workflow.at(-1)?.phase, "acceptance")
  assert.equal(result.controls.sapWritePerformed, false)
  assert.equal(result.controls.humanConfirmationRequiredBeforeSave, true)
})

test("controlled FIBF workflow never treats product activation as an automatic write", async () => {
  const backend = new MockBackend()
  const result = JSON.parse(
    await new ToolService(backend).prepareEnhancementConfigurationWorkflow({
      kind: "fibf_event",
      targetName: "cs000010",
      desiredState: "active",
      productName: "zbte",
      functionModule: "z_bte_cs000010",
      applicationIndicator: "cs",
      transportNumber: "W20K900001",
      connectionId: "w200"
    })
  ) as {
    transaction: string
    readiness: string
    standardApiAssessment: { approvedHeadlessWriteApi: boolean; decision: string }
    currentState: { configuration: { status: string } }
    workflow: Array<{ phase: string; instruction: string }>
    controls: { activationPerformed: boolean; transportReleased: boolean }
  }

  assert.equal(result.transaction, "FIBF")
  assert.equal(result.readiness, "ready_for_human_execution")
  assert.equal(result.standardApiAssessment.approvedHeadlessWriteApi, false)
  assert.equal(result.standardApiAssessment.decision, "manual_workflow_required")
  assert.equal(result.currentState.configuration.status, "available")
  assert.match(
    result.workflow.find((step) => step.phase === "product")?.instruction ?? "",
    /other BTE assignments share the product/
  )
  assert.equal(result.controls.activationPerformed, false)
  assert.equal(result.controls.transportReleased, false)
})

test("controlled FI rule workflow reports mandatory manual-read inputs", async () => {
  const backend = new MockBackend()
  const result = JSON.parse(
    await new ToolService(backend).prepareEnhancementConfigurationWorkflow({
      kind: "fi_substitution",
      targetName: "zfi_sub_01",
      desiredState: "create_or_update",
      connectionId: "w200"
    })
  ) as {
    transaction: string
    readiness: string
    missingInputs: string[]
    currentState: { ruleConfiguration: { status: string } }
    workflow: Array<{ phase: string; instruction: string }>
    coverage: { configurationMutationAutomated: boolean; runtimeAcceptanceRequired: boolean }
  }

  assert.equal(result.transaction, "GGB1 / OBBH")
  assert.equal(result.readiness, "requires_input")
  assert.deepEqual(result.missingInputs, [
    "transportNumber",
    "applicationArea",
    "callupPoint",
    "organizationalUnit"
  ])
  assert.equal(result.currentState.ruleConfiguration.status, "manual_read_required")
  assert.match(
    result.workflow.find((step) => step.phase === "activation")?.instruction ?? "",
    /OBBH/
  )
  assert.equal(result.coverage.configurationMutationAutomated, false)
  assert.equal(result.coverage.runtimeAcceptanceRequired, true)
})

test("BAdI search distinguishes exact Classic and New repository subtypes", async () => {
  const backend = new MockBackend()
  backend.searchObjectTypes = async (_connectionId, _pattern, types) =>
    types.map((type) => {
      if (type === "SXCI/XI") {
        return {
          requestedType: type,
          status: "unsupported" as const,
          objects: [],
          reason: "Classic implementation search is unavailable."
        }
      }
      return {
        requestedType: type,
        status: "available" as const,
        objects: [
          {
            name: "ZBADI_" + type.replace("/", "_"),
            type,
            description: "BAdI repository object",
            package: "ZBADI",
            systemType: "CUSTOM" as const,
            uri: "/sap/bc/adt/repository/" + type.toLowerCase()
          }
        ]
      }
    })
  const result = JSON.parse(
    await new ToolService(backend).searchBadiObjects({
      pattern: "Z*",
      connectionId: "w200"
    })
  ) as {
    results: Array<{
      requestedType: string
      repositoryKind: string
      status: string
      count: number | null
    }>
    summary: {
      requestedTypeCount: number
      availableTypeCount: number
      unavailableTypeCount: number
      objectCount: number
    }
    coverage: {
      exactRepositorySubtypes: boolean
      classicDefinitionAndImplementationSeparated: boolean
      newBadiDefinitionInspected: boolean
      filtersOrMultipleUseInspected: boolean
      switchesOrActivationInspected: boolean
      runtimeInspected: boolean
    }
  }

  assert.deepEqual(
    result.results.map(({ requestedType, repositoryKind, status, count }) => ({
      requestedType,
      repositoryKind,
      status,
      count
    })),
    [
      {
        requestedType: "SXSD/XD",
        repositoryKind: "classic_badi_definition",
        status: "available",
        count: 1
      },
      {
        requestedType: "SXCI/XI",
        repositoryKind: "classic_badi_implementation",
        status: "unsupported",
        count: null
      },
      {
        requestedType: "ENHS/XS",
        repositoryKind: "enhancement_spot_container",
        status: "available",
        count: 1
      },
      {
        requestedType: "ENHO/XHB",
        repositoryKind: "new_badi_implementation",
        status: "available",
        count: 1
      }
    ]
  )
  assert.deepEqual(result.summary, {
    requestedTypeCount: 4,
    availableTypeCount: 3,
    unavailableTypeCount: 1,
    objectCount: 3
  })
  assert.equal(result.coverage.exactRepositorySubtypes, true)
  assert.equal(result.coverage.classicDefinitionAndImplementationSeparated, true)
  assert.equal(result.coverage.newBadiDefinitionInspected, false)
  assert.equal(result.coverage.filtersOrMultipleUseInspected, false)
  assert.equal(result.coverage.switchesOrActivationInspected, false)
  assert.equal(result.coverage.runtimeInspected, false)
})

test("Classic BAdI definition read returns interfaces, filters, classes, and raw activation", async () => {
  const backend = new MockBackend()
  const result = JSON.parse(
    await new ToolService(backend).readClassicBadiDefinition({
      definitionName: "me_process_po_cust",
      connectionId: "w200"
    })
  ) as {
    repositoryKind: string
    definition: {
      name: string
      description: string
      filterType: string
      filterDependent: boolean
      multipleUseRaw: string
      multipleUse: boolean
      interfaces: string[]
      implementationAssignments: Array<{
        implementationName: string
        filterValue: string
        activeRaw: string
        active: boolean
      }>
      classMappings: Array<{
        implementationName: string
        interfaceName: string
        implementationClass: string
      }>
    }
    summary: {
      interfaceCount: number
      implementationAssignmentCount: number
      distinctImplementationCount: number
      activeImplementationCount: number
      classMappingCount: number
    }
    coverage: {
      exactClassicDefinitionRead: boolean
      interfacesInspected: boolean
      filterAndMultipleUseAttributesInspected: boolean
      implementationAssignmentsInspected: boolean
      implementationClassesInspected: boolean
      rawActivationFlagsInspected: boolean
      newBadiInspected: boolean
      switchesInspected: boolean
      runtimeInspected: boolean
    }
  }

  assert.equal(result.repositoryKind, "classic_badi_definition")
  assert.equal(result.definition.name, "ME_PROCESS_PO_CUST")
  assert.equal(result.definition.description, "Purchase order processing")
  assert.equal(result.definition.filterType, "BUKRS")
  assert.equal(result.definition.filterDependent, true)
  assert.equal(result.definition.multipleUseRaw, "X")
  assert.equal(result.definition.multipleUse, true)
  assert.deepEqual(result.definition.interfaces, ["IF_EX_ME_PROCESS_PO_CUST"])
  assert.deepEqual(
    result.definition.implementationAssignments.map(
      ({ implementationName, filterValue, activeRaw, active }) => ({
        implementationName,
        filterValue,
        activeRaw,
        active
      })
    ),
    [
      {
        implementationName: "ZME_PO_IMPL",
        filterValue: "1000",
        activeRaw: "X",
        active: true
      },
      {
        implementationName: "ZME_PO_IMPL",
        filterValue: "2000",
        activeRaw: "X",
        active: true
      },
      {
        implementationName: "ZME_PO_OLD",
        filterValue: "",
        activeRaw: "",
        active: false
      }
    ]
  )
  assert.deepEqual(result.definition.classMappings, [
    {
      implementationName: "ZME_PO_IMPL",
      interfaceName: "IF_EX_ME_PROCESS_PO_CUST",
      implementationClass: "ZCL_IM_ME_PO"
    },
    {
      implementationName: "ZME_PO_OLD",
      interfaceName: "IF_EX_ME_PROCESS_PO_CUST",
      implementationClass: "ZCL_IM_ME_PO_OLD"
    }
  ])
  assert.deepEqual(result.summary, {
    interfaceCount: 1,
    implementationAssignmentCount: 3,
    distinctImplementationCount: 2,
    activeImplementationCount: 1,
    classMappingCount: 2
  })
  assert.equal(result.coverage.exactClassicDefinitionRead, true)
  assert.equal(result.coverage.interfacesInspected, true)
  assert.equal(result.coverage.filterAndMultipleUseAttributesInspected, true)
  assert.equal(result.coverage.implementationAssignmentsInspected, true)
  assert.equal(result.coverage.implementationClassesInspected, true)
  assert.equal(result.coverage.rawActivationFlagsInspected, true)
  assert.equal(result.coverage.newBadiInspected, false)
  assert.equal(result.coverage.switchesInspected, false)
  assert.equal(result.coverage.runtimeInspected, false)
  assert.equal(backend.lastRepositoryRequest?.operation, "READ_CLASSIC_BADI_DEFINITION")
  assert.equal(backend.lastRepositoryRequest?.objectName, "ME_PROCESS_PO_CUST")
})

test("SXCI table compatibility projection reads one exact Classic BAdI definition", async () => {
  const result = JSON.parse(
    await new ToolService(new MockBackend()).readAbapTable({
      connectionId: "w200",
      tableName: "SXCI",
      columns: ["EXIT_NAME", "IMP_NAME", "CLASS_NAME", "INTER_NAME"],
      filters: [{ column: "EXIT_NAME", operator: "EQ", value: "ME_PROCESS_PO_CUST" }],
      maxRows: 10
    })
  )

  assert.equal(result.status, "ok")
  assert.equal(result.method, "classic_badi_repository_helper")
  assert.equal(result.definitionSource, "classic_badi_repository_projection")
  assert.equal(result.compatibilityProjection, true)
  assert.equal(result.tableClassVerified, false)
  assert.equal(result.returnedCount, 2)
  assert.equal(result.truncated, false)
  assert.deepEqual(result.data, [
    {
      EXIT_NAME: "ME_PROCESS_PO_CUST",
      IMP_NAME: "ZME_PO_IMPL",
      CLASS_NAME: "ZCL_IM_ME_PO",
      INTER_NAME: "IF_EX_ME_PROCESS_PO_CUST"
    },
    {
      EXIT_NAME: "ME_PROCESS_PO_CUST",
      IMP_NAME: "ZME_PO_OLD",
      CLASS_NAME: "ZCL_IM_ME_PO_OLD",
      INTER_NAME: "IF_EX_ME_PROCESS_PO_CUST"
    }
  ])
})

test("SXCI table compatibility projection supports a bounded wildcard read", async () => {
  const backend = new MockBackend()
  backend.searchObjectTypes = async () => [
    {
      requestedType: "SXSD/XD",
      status: "available",
      objects: [
        {
          name: "ME_PROCESS_PO_CUST",
          type: "SXSD/XD",
          description: "Purchase order processing",
          package: "ME",
          systemType: "STANDARD",
          uri: "/sap/bc/adt/vit/wb/object_type/sxsdxd/object_name/ME_PROCESS_PO_CUST"
        }
      ]
    }
  ]
  const result = JSON.parse(
    await new ToolService(backend).readAbapTable({
      connectionId: "w200",
      tableName: "SXCI",
      columns: ["*"],
      maxRows: 1
    })
  )

  assert.equal(result.status, "ok")
  assert.deepEqual(result.columns, ["EXIT_NAME", "IMP_NAME", "CLASS_NAME", "INTER_NAME"])
  assert.equal(result.returnedCount, 1)
  assert.equal(result.truncated, true)
  assert.equal(result.data[0].IMP_NAME, "ZME_PO_IMPL")
})

test("Enhancement implementation read keeps every hook source with its owning hook", async () => {
  const result = JSON.parse(
    await new ToolService(new MockBackend()).readEnhancementImplementation({
      enhancementName: "zenh_demo",
      connectionId: "w200"
    })
  ) as {
    enhancementName: string
    packageName: string
    fingerprint: string
    definition: {
      active: boolean
      hasInactiveVersion: boolean
      hasSavedInactiveVersion: boolean
      hasUnsavedInactiveVersion: boolean
      hookImplementations: Array<{ fullName: string; source: string[] }>
    }
  }

  assert.equal(result.enhancementName, "ZENH_DEMO")
  assert.equal(result.packageName, "ZABAP")
  assert.equal(result.definition.active, true)
  assert.equal(result.definition.hasInactiveVersion, false)
  assert.equal(result.definition.hasSavedInactiveVersion, false)
  assert.equal(result.definition.hasUnsavedInactiveVersion, false)
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/)
  assert.deepEqual(result.definition.hookImplementations[0]?.source, [
    "IF vbak-vbeln IS INITIAL.",
    "ENDIF."
  ])
})

test("Enhancement hook lifecycle sends guarded payload and verifies create and delete readback", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)
  const created = JSON.parse(
    await tools.createEnhancementHookImplementation({
      enhancementName: "ZENH_NEW",
      description: "Order save validation",
      originalObjectType: "PROG",
      originalObjectName: "SAPMV45A",
      mainObjectType: "PROG",
      mainObjectName: "SAPMV45A",
      programName: "SAPMV45A",
      fullName: "\\PROGRAM=SAPMV45A\\FORM=USEREXIT_SAVE_DOCUMENT_PREPARE\\ENHANCEMENT-POINT=END",
      mode: "S",
      source: ["CHECK vbak-vbeln IS NOT INITIAL."],
      packageName: "ZABAP",
      transportNumber: "W20K900001",
      confirmation: "CREATE_ENHANCEMENT_IMPLEMENTATION",
      connectionId: "w200"
    })
  ) as {
    enhancementName: string
    fingerprint: string
    definition: { hookImplementations: Array<{ source: string[] }> }
  }

  assert.equal(created.enhancementName, "ZENH_NEW")
  assert.deepEqual(created.definition.hookImplementations[0]?.source, [
    "CHECK vbak-vbeln IS NOT INITIAL."
  ])
  assert.equal(backend.lastRepositoryRequest?.operation, "READ_ENHANCEMENT_IMPL")

  const deleted = JSON.parse(
    await tools.deleteEnhancementImplementation({
      enhancementName: "ZENH_NEW",
      expectedFingerprint: created.fingerprint,
      packageName: "ZABAP",
      transportNumber: "W20K900001",
      confirmation: "PERMANENT_DELETE",
      connectionId: "w200"
    })
  ) as { status: string; previousFingerprint: string }
  assert.equal(deleted.status, "ENHANCEMENT_IMPLEMENTATION_DELETED")
  assert.equal(deleted.previousFingerprint, created.fingerprint)
})

test("New BAdI and Classic BAdI create operations preserve implementation metadata", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)
  const newBadi = JSON.parse(
    await tools.createNewBadiImplementation({
      enhancementName: "ZENH_BADI_NEW",
      description: "PO validation",
      spotName: "ES_ME_PROCESS_PO",
      badiName: "ME_PROCESS_PO_CUST",
      implementationName: "ZENH_BADI_IMPL",
      implementationClass: "ZCL_IM_ME_PO_NEW",
      defaultImplementation: false,
      filters: [{ FILTER_NAME: "BUKRS", FILTER_CHAR_VALUE1: "1000" }],
      packageName: "ZABAP",
      transportNumber: "W20K900001",
      confirmation: "CREATE_ENHANCEMENT_IMPLEMENTATION",
      connectionId: "w200"
    })
  ) as {
    definition: {
      badiImplementations: Array<{
        implementationName: string
        implementationClass: string
      }>
      filters: Array<Record<string, string>>
    }
  }
  assert.equal(newBadi.definition.badiImplementations[0]?.implementationName, "ZENH_BADI_IMPL")
  assert.equal(newBadi.definition.badiImplementations[0]?.implementationClass, "ZCL_IM_ME_PO_NEW")
  assert.equal(newBadi.definition.filters[0]?.FILTER_CHAR_VALUE1, "1000")

  const classic = JSON.parse(
    await tools.manageClassicBadiImplementation({
      action: "create",
      implementationName: "ZME_PO_NEW",
      definitionName: "ME_PROCESS_PO_CUST",
      interfaceName: "IF_EX_ME_PROCESS_PO_CUST",
      implementationClass: "ZCL_IM_ME_PO_NEW",
      methods: [
        {
          methodName: "IF_EX_ME_PROCESS_PO_CUST~PROCESS_HEADER",
          source: ["METHOD if_ex_me_process_po_cust~process_header.", "ENDMETHOD."]
        }
      ],
      packageName: "ZABAP",
      transportNumber: "W20K900001",
      confirmation: "CLASSIC_BADI_IMPLEMENTATION_CHANGE",
      connectionId: "w200"
    })
  ) as { implementationName: string; fingerprint: string }
  assert.equal(classic.implementationName, "ZME_PO_NEW")
  assert.match(classic.fingerprint, /^[a-f0-9]{64}$/)
})

test("Enhancement hook update replaces one exact hook and verifies activated readback", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)
  const current = JSON.parse(
    await tools.readEnhancementImplementation({
      enhancementName: "ZENH_DEMO",
      connectionId: "w200"
    })
  ) as { fingerprint: string }
  const updated = JSON.parse(
    await tools.updateEnhancementHookImplementation({
      enhancementName: "ZENH_DEMO",
      expectedFingerprint: current.fingerprint,
      extId: "1",
      source: ["CHECK vbak-vbeln IS NOT INITIAL."],
      description: "Updated order validation",
      packageName: "ZABAP",
      transportNumber: "W20K900001",
      confirmation: "UPDATE_ENHANCEMENT_IMPLEMENTATION",
      connectionId: "w200"
    })
  ) as {
    previousFingerprint: string
    definition: {
      shortText: string
      active: boolean
      hasInactiveVersion: boolean
      hookImplementations: Array<{ extId: string; source: string[] }>
    }
  }

  assert.equal(updated.previousFingerprint, current.fingerprint)
  assert.equal(updated.definition.shortText, "Updated order validation")
  assert.equal(updated.definition.active, true)
  assert.equal(updated.definition.hasInactiveVersion, false)
  assert.deepEqual(updated.definition.hookImplementations[0]?.source, [
    "CHECK vbak-vbeln IS NOT INITIAL."
  ])
})

test("New BAdI update replaces class, filters, flags, and text", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)
  const created = JSON.parse(
    await tools.createNewBadiImplementation({
      enhancementName: "ZENH_BADI_UPDATE",
      description: "Initial PO validation",
      spotName: "ES_ME_PROCESS_PO",
      badiName: "ME_PROCESS_PO_CUST",
      implementationName: "ZENH_BADI_IMPL",
      implementationClass: "ZCL_IM_ME_PO_OLD",
      defaultImplementation: false,
      filters: [],
      packageName: "ZABAP",
      transportNumber: "W20K900001",
      confirmation: "CREATE_ENHANCEMENT_IMPLEMENTATION",
      connectionId: "w200"
    })
  ) as { fingerprint: string }
  const updated = JSON.parse(
    await tools.updateNewBadiImplementation({
      enhancementName: "ZENH_BADI_UPDATE",
      expectedFingerprint: created.fingerprint,
      implementationName: "ZENH_BADI_IMPL",
      implementationClass: "ZCL_IM_ME_PO_NEW",
      active: false,
      defaultImplementation: true,
      filters: [{ FILTER_NAME: "BUKRS", FILTER_CHAR_VALUE1: "2000" }],
      description: "Updated PO validation",
      packageName: "ZABAP",
      transportNumber: "W20K900001",
      confirmation: "UPDATE_ENHANCEMENT_IMPLEMENTATION",
      connectionId: "w200"
    })
  ) as {
    definition: {
      badiImplementations: Array<{
        implementationClass: string
        active: boolean
        defaultImplementation: boolean
        shortText: string
        filters: Array<Record<string, string>>
      }>
    }
  }
  const implementation = updated.definition.badiImplementations[0]

  assert.equal(implementation?.implementationClass, "ZCL_IM_ME_PO_NEW")
  assert.equal(implementation?.active, false)
  assert.equal(implementation?.defaultImplementation, true)
  assert.equal(implementation?.shortText, "Updated PO validation")
  assert.deepEqual(implementation?.filters, [{ FILTER_CHAR_VALUE1: "2000", FILTER_NAME: "BUKRS" }])
})

test("Enhancement state management activates or discards an inactive version", async () => {
  const backend = new MockBackend()
  backend.seedInactiveEnhancementVersion("ZENH_DEMO")
  const tools = new ToolService(backend)
  const current = JSON.parse(
    await tools.readEnhancementImplementation({
      enhancementName: "ZENH_DEMO",
      connectionId: "w200"
    })
  ) as { fingerprint: string; definition: { hasInactiveVersion: boolean } }
  assert.equal(current.definition.hasInactiveVersion, true)

  const changed = JSON.parse(
    await tools.manageEnhancementImplementationState({
      action: "discard_inactive",
      enhancementName: "ZENH_DEMO",
      expectedFingerprint: current.fingerprint,
      packageName: "ZABAP",
      transportNumber: "W20K900001",
      confirmation: "CHANGE_ENHANCEMENT_IMPLEMENTATION_STATE",
      connectionId: "w200"
    })
  ) as { status: string; definition: { active: boolean; hasInactiveVersion: boolean } }

  assert.equal(changed.status, "ENHANCEMENT_INACTIVE_VERSION_DISCARDED")
  assert.equal(changed.definition.active, true)
  assert.equal(changed.definition.hasInactiveVersion, false)
})

test("Enhancement Framework inspection separates explicit anchors from implicit candidates", async () => {
  const backend = new MockBackend()
  backend.readSource = async () => ({
    source: [
      "REPORT zdemo.",
      "ENHANCEMENT-POINT ep_one SPOTS es_demo STATIC.",
      "FORM calculate.",
      "  WRITE 'FORM'.",
      "ENDFORM.",
      "METHOD run.",
      "  ENHANCEMENT-SECTION sec_one SPOTS es_demo.",
      "    WRITE 'METHOD'.",
      "  END-ENHANCEMENT-SECTION.",
      "ENDMETHOD.",
      "ENHANCEMENT 1 zimpl.",
      "ENDENHANCEMENT.",
      "* ENHANCEMENT-POINT ignored SPOTS ignored."
    ].join("\n"),
    uriUsed: "/sap/bc/adt/programs/programs/zdemo/source/main"
  })
  const result = JSON.parse(
    await new ToolService(backend).inspectEnhancementFramework({
      objectName: "ZCL_DEMO",
      objectType: "CLAS",
      connectionId: "w200"
    })
  ) as {
    explicitAnchors: Array<{ kind: string; name: string; spots: string[]; line: number }>
    enhancementImplementations: Array<{ id: string; name: string; line: number }>
    implicitCandidates: Array<{
      kind: string
      line: number
      position: string
      routineKind?: string
      routineName?: string
    }>
    summary: {
      explicitAnchorCount: number
      enhancementImplementationCount: number
      routineCount: number
      implicitCandidateCount: number
    }
    coverage: {
      implicitCandidatesAreSourceDerived: boolean
      sapEnhancementEditorConfirmationRequired: boolean
      activationOrConfigurationInspected: boolean
      runtimeInspected: boolean
      standardRefactoringMayInvalidateCandidates: boolean
    }
  }

  assert.deepEqual(
    result.explicitAnchors.map(({ kind, name, spots, line }) => ({ kind, name, spots, line })),
    [
      { kind: "point", name: "EP_ONE", spots: ["ES_DEMO"], line: 2 },
      { kind: "section", name: "SEC_ONE", spots: ["ES_DEMO"], line: 7 }
    ]
  )
  assert.deepEqual(
    result.enhancementImplementations.map(({ id, name, line }) => ({ id, name, line })),
    [{ id: "1", name: "ZIMPL", line: 11 }]
  )
  assert.deepEqual(
    result.implicitCandidates.map(({ kind, line, position, routineKind, routineName }) => ({
      kind,
      line,
      position,
      ...(routineKind ? { routineKind, routineName } : {})
    })),
    [
      { kind: "source_start", line: 1, position: "before_line" },
      {
        kind: "routine_start",
        line: 3,
        position: "after_line",
        routineKind: "form",
        routineName: "CALCULATE"
      },
      {
        kind: "routine_end",
        line: 5,
        position: "before_line",
        routineKind: "form",
        routineName: "CALCULATE"
      },
      {
        kind: "routine_start",
        line: 6,
        position: "after_line",
        routineKind: "method",
        routineName: "RUN"
      },
      {
        kind: "routine_end",
        line: 10,
        position: "before_line",
        routineKind: "method",
        routineName: "RUN"
      },
      { kind: "source_end", line: 12, position: "after_line" }
    ]
  )
  assert.deepEqual(result.summary, {
    explicitAnchorCount: 2,
    enhancementImplementationCount: 1,
    routineCount: 2,
    implicitCandidateCount: 6
  })
  assert.equal(result.coverage.implicitCandidatesAreSourceDerived, true)
  assert.equal(result.coverage.sapEnhancementEditorConfirmationRequired, true)
  assert.equal(result.coverage.activationOrConfigurationInspected, false)
  assert.equal(result.coverage.runtimeInspected, false)
  assert.equal(result.coverage.standardRefactoringMayInvalidateCandidates, true)
})

test("FI rule exit inspection correlates catalog declarations with FORM implementations", async () => {
  const backend = new MockBackend()
  backend.readSource = async () => ({
    source: [
      "REPORT zreport_demo.",
      "FORM get_exit_titles TABLES exits STRUCTURE gb002.",
      "  EXITS-NAME = 'U100'.",
      "  EXITS-PARAM = C_EXIT_PARAM_NONE.",
      "  EXITS-TITLE = TEXT-100.",
      "  APPEND EXITS.",
      "  EXITS-NAME = 'U200'.",
      "  EXITS-PARAM = C_EXIT_PARAM_FIELD.",
      "  EXITS-TITLE = 'Field replacement'.",
      "  APPEND EXITS.",
      "ENDFORM.",
      "FORM u100.",
      "ENDFORM.",
      "FORM u300.",
      "ENDFORM.",
      "* EXITS-NAME = 'U999'."
    ].join("\n"),
    uriUsed: "/sap/bc/adt/programs/programs/zreport_demo/source/main"
  })
  const result = JSON.parse(
    await new ToolService(backend).inspectFicoRuleExitProgram({
      programName: "ZREPORT_DEMO",
      connectionId: "w200"
    })
  ) as {
    catalogRoutine: { found: boolean; startLine: number | null; endLine: number | null }
    catalogEntries: Array<{
      name: string | null
      parameterExpression: string | null
      titleExpression: string | null
      appendLine: number
      implementationFound: boolean
      implementationLine: number | null
    }>
    implementedExitForms: Array<{
      name: string
      line: number
      declaredInCatalog: boolean
    }>
    summary: {
      catalogEntryCount: number
      implementedExitFormCount: number
      matchedExitCount: number
      declarationWithoutImplementationCount: number
      implementationWithoutDeclarationCount: number
    }
    coverage: {
      ggb0ValidationRulesInspected: boolean
      ggb1SubstitutionRulesInspected: boolean
      ob28ActivationInspected: boolean
      obbhActivationInspected: boolean
      runtimeInspected: boolean
    }
  }

  assert.deepEqual(result.catalogRoutine, { found: true, startLine: 2, endLine: 11 })
  assert.deepEqual(result.catalogEntries, [
    {
      name: "U100",
      parameterExpression: "C_EXIT_PARAM_NONE",
      titleExpression: "TEXT-100",
      appendLine: 6,
      implementationFound: true,
      implementationLine: 12
    },
    {
      name: "U200",
      parameterExpression: "C_EXIT_PARAM_FIELD",
      titleExpression: "'Field replacement'",
      appendLine: 10,
      implementationFound: false,
      implementationLine: null
    }
  ])
  assert.deepEqual(result.implementedExitForms, [
    { name: "U100", line: 12, declaredInCatalog: true },
    { name: "U300", line: 14, declaredInCatalog: false }
  ])
  assert.deepEqual(result.summary, {
    catalogEntryCount: 2,
    implementedExitFormCount: 2,
    matchedExitCount: 1,
    declarationWithoutImplementationCount: 1,
    implementationWithoutDeclarationCount: 1
  })
  assert.equal(result.coverage.ggb0ValidationRulesInspected, false)
  assert.equal(result.coverage.ggb1SubstitutionRulesInspected, false)
  assert.equal(result.coverage.ob28ActivationInspected, false)
  assert.equal(result.coverage.obbhActivationInspected, false)
  assert.equal(result.coverage.runtimeInspected, false)
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

  const programWorkspace = await tools.getWorkspaceUri({
    objectName: "ZREPORT_DEMO",
    objectType: "PROG",
    connectionId: "w200"
  })
  assert.match(programWorkspace, /Type: PROG\/P/)
  assert.match(programWorkspace, /adt:\/\/w200\/sap\/bc\/adt\/programs\/programs\/zreport_demo/)

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
    line: 1,
    character: 6,
    searchTerm: "zcl_demo",
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

test("an ADT type path resolves like the search code it came from", async () => {
  const tools = new ToolService(new MockBackend())

  // The service prints `FUGR/FF` in its own results, so a caller hands that token back. Before the
  // shared vocabulary the search was given the path unchanged and the lookup answered "Could not
  // find ABAP object" for a live function module (w200, 2026-09-25T00:37).
  const history = await tools.getVersionHistory({
    objectName: "Z_FM_DEMO",
    objectType: "FUGR/FF",
    connectionId: "w200"
  })
  assert.match(history, /Version History for Z_FM_DEMO \(FUGR\/FF\)/)
  assert.doesNotMatch(history, /Could not find ABAP object/)

  // Every alias of the same object kind reaches the same row, and the search still works when given
  // the plain code instead of a path.
  for (const objectType of ["FUNC/FM", "FUNC"]) {
    const info = await tools.getObjectInfo({
      objectName: "Z_FM_DEMO",
      objectType,
      connectionId: "w200"
    })
    assert.doesNotMatch(info, /Could not find ABAP object/, `objectType ${objectType}`)
  }

  // The same translation covers the program families and the structures that share their search
  // code, so no alias may resolve to a different object than the code does.
  const report = await tools.searchObjects({
    pattern: "ZREPORT_DEMO",
    types: ["PROG/P"],
    connectionId: "w200"
  })
  assert.match(report, /Found 1 ABAP objects/)
})

test("a failed object lookup is not reported as proof of absence", async () => {
  const tools = new ToolService(new MockBackend())

  const missing = await tools.getVersionHistory({
    objectName: "Z_NOT_THERE",
    objectType: "FUGR/FF",
    connectionId: "w200"
  })
  // The repository search skips object types it cannot search, so an empty result is a failed
  // lookup. Answering "ensure it exists" turns that failure into a claim about SAP state.
  assert.doesNotMatch(missing, /ensure it exists/)
  assert.doesNotMatch(missing, /Could not find ABAP object/)
  assert.match(missing, /not evidence that the object has no versions or does not exist/)
  assert.match(missing, /Z_NOT_THERE \(FUGR\/FF\)/)
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
    sql: "SELECT WERKS, NAME1 FROM T001W",
    displayMode: "internal",
    connectionId: "w200",
    rowRange: { start: 0, end: 2 },
    filters: [{ column: "NAME1", value: "AL*" }],
    sortColumns: [{ column: "WERKS", direction: "asc" }]
  })
  const queryResult = JSON.parse(query) as {
    resultCount: number
    data: Array<{ WERKS: string }>
  }
  assert.equal(queryResult.resultCount, 2)
  assert.deepEqual(
    queryResult.data.map((row) => row.WERKS),
    ["1000", "3000"]
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
          if (uri.endsWith("/activation/inactiveobjects")) {
            calls.push("inactive")
            return inactiveHttp().request()
          }
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

test("unsupported enhancement endpoints remain unavailable instead of becoming empty results", async () => {
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
        // Real ADT failures reach capabilityFailure as AdtErrorException(status 500, err 404)
        // with an axios-style message, which is why capabilityFailure parses a trailing
        // "status code NNN" out of the message. A statusless Error is normalized to a plain
        // HTTP 500 and reported as request-failed, which the real client never produces:
        // against w200 this endpoint is classified unsupported on ECC 7.31.
        throw new Error("Request failed with status code 404: Unsupported on ECC 7.31")
      }
    },
    login: Promise.resolve()
  })

  await assert.rejects(
    backend.readEnhancements("w200", "/sap/bc/adt/programs/ztest"),
    /enhancement metadata read capability unsupported-endpoint/
  )
})

test("ADT enhancement reads preserve implementation, element, position, and enhanced-object metadata", async () => {
  const backend = backendWithInjectedClient()
  injectClient(backend, {
    async objectEnhancements(sourceUri: string, contextUri: undefined, includeSource: boolean) {
      assert.equal(sourceUri, "/sap/bc/adt/programs/ztest/source/main")
      assert.equal(contextUri, undefined)
      assert.equal(includeSource, true)
      return {
        implementations: [
          {
            name: "ZENH_TEST",
            type: "ENHO/XH",
            version: "active",
            elements: [
              {
                uri: "/sap/bc/adt/enhancements/zenh_test/elements/1",
                id: "1",
                fullname: "\\PR:ZTEST\\SE:Z_SECTION\\EI",
                mode: "any",
                replacing: true,
                source: "WRITE 'ACTIVE'.",
                position: {
                  uri: "/sap/bc/adt/programs/ztest/source/main#start=7,2",
                  startLine: 6,
                  startColumn: 2
                }
              }
            ],
            enhancedObject: {
              uri: "/sap/bc/adt/programs/programs/ztest",
              type: "PROG/P",
              name: "ZTEST"
            }
          }
        ]
      }
    }
  })

  assert.deepEqual(await backend.readEnhancements("w200", "/sap/bc/adt/programs/ztest", true), [
    {
      name: "ZENH_TEST",
      type: "ENHO/XH",
      version: "active",
      elementId: "1",
      fullname: "\\PR:ZTEST\\SE:Z_SECTION\\EI",
      mode: "any",
      replacing: true,
      startLine: 6,
      startColumn: 2,
      positionUri: "/sap/bc/adt/programs/ztest/source/main#start=7,2",
      uri: "/sap/bc/adt/enhancements/zenh_test/elements/1",
      source: "WRITE 'ACTIVE'.",
      enhancedObject: {
        uri: "/sap/bc/adt/programs/programs/ztest",
        type: "PROG/P",
        name: "ZTEST"
      }
    }
  ])
})

test("ADT enhancement object search reports each repository type independently", async () => {
  const backend = backendWithInjectedClient()
  injectClient(backend, {
    async searchObject(_pattern: string, type: string) {
      if (type === "ENHS") throw new Error("Request failed with status code 404")
      if (type === "BADII") throw new Error("Request failed with status code 403")
      return type === "BADI"
        ? [
            {
              "adtcore:name": "ZBADI_DEMO",
              "adtcore:type": "BADI/OI",
              "adtcore:description": "Demo BAdI",
              "adtcore:packageName": "ZVALIDATION",
              "adtcore:uri": "/sap/bc/adt/enhancements/badi/zbadi_demo"
            }
          ]
        : []
    }
  })

  const results = await backend.searchObjectTypes(
    "w200",
    "Z*",
    ["BADI", "ENHS", "BADII", "ENHO"],
    20
  )
  assert.deepEqual(
    results.map(({ requestedType, status, objects }) => ({
      requestedType,
      status,
      names: objects.map((object) => object.name)
    })),
    [
      { requestedType: "BADI", status: "available", names: ["ZBADI_DEMO"] },
      { requestedType: "ENHS", status: "unsupported", names: [] },
      { requestedType: "BADII", status: "forbidden", names: [] },
      { requestedType: "ENHO", status: "available", names: [] }
    ]
  )
})

test("source timeouts abort the ADT request and do not retry fallback URIs", async () => {
  const backend = backendWithInjectedClient()
  const requests: Array<{ url: string; timeout: number | undefined }> = []
  injectClient(backend, {
    httpClient: {
      async request(url: string, options: { timeout?: number }) {
        requests.push({ url, timeout: options.timeout })
        throw Object.assign(new Error("timeout of 30000ms exceeded"), { code: "ECONNABORTED" })
      }
    }
  })

  await assert.rejects(
    backend.readSourceByUri("w200", "adt://w200/sap/bc/adt/oo/classes/zcl_slow"),
    /SOURCE_READ_TIMEOUT: active source read timed out.*automatic retry was started/
  )
  assert.deepEqual(requests, [
    { url: "/sap/bc/adt/oo/classes/zcl_slow/source/main", timeout: 30_000 }
  ])
})

test("class diagnostics bound source and syntax requests independently", async () => {
  const backend = backendWithInjectedClient()
  const requests: Array<{ url: string; timeout: number | undefined }> = []
  injectClient(backend, {
    httpClient: {
      async request(url: string, options: { timeout?: number }) {
        requests.push({ url, timeout: options.timeout })
        if (url.endsWith("/source/main")) {
          return {
            body: "CLASS zcl_slow DEFINITION. ENDCLASS.",
            status: 200,
            statusText: "OK",
            headers: {}
          }
        }
        throw Object.assign(new Error("timeout of 10000ms exceeded"), { code: "ECONNABORTED" })
      }
    }
  })

  await assert.rejects(
    backend.diagnostics("w200", "adt://w200/sap/bc/adt/oo/classes/zcl_slow"),
    /SYNTAX_CHECK_TIMEOUT: syntax check timed out.*SAP-side cancellation is unconfirmed/
  )
  assert.deepEqual(requests, [
    { url: "/sap/bc/adt/oo/classes/zcl_slow/source/main", timeout: 30_000 },
    { url: "/sap/bc/adt/checkruns?reporters=abapCheckRun", timeout: 10_000 }
  ])
})

test("ADT write coordination locks, saves, unlocks, and activates the exact customer object", async () => {
  const calls: string[] = []
  let savedSource = "CLASS zcl_demo IMPLEMENTATION.\nENDCLASS."
  const client = {
    stateful: "stateful",
    httpClient: inactiveHttp(),
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
      return savedSource
    },
    async setObjectSource(_uri: string, source: string, _lockHandle: string, transport: string) {
      calls.push(`save:${transport}`)
      assert.match(source, /WRITE 'OK'/)
      savedSource = source
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
  assert.deepEqual(calls, [
    "lock",
    "read",
    "read",
    "save:W200K900001",
    "unlock",
    "activate",
    "read"
  ])
})

test("a function module source write locks the MAIN include it writes", async () => {
  const locked: string[] = []
  const unlocked: string[] = []
  let savedSource = "FUNCTION z_fm_demo.\nENDFUNCTION."
  const client = {
    stateful: "stateful",
    httpClient: inactiveHttp(),
    async lock(uri: string) {
      locked.push(uri)
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
      return savedSource
    },
    async setObjectSource(_uri: string, source: string) {
      savedSource = source
    },
    async unLock(uri: string) {
      unlocked.push(uri)
      return ""
    },
    async activate() {
      return { success: true, messages: [], inactive: [] }
    }
  }

  const result = await replaceSourceWithClient(
    client as never,
    "w200",
    "adt://w200/sap/bc/adt/functions/groups/zfug_demo/fmodules/z_fm_demo",
    "FUNCTION z_fm_demo.",
    "FUNCTION z_fm_demo.\n  WRITE 'OK'."
  )

  // SAP names the resource it refuses as "Resource MAIN <fm>": the function module's own URI is a
  // different ADT resource from the MAIN include its source is written to, and locking it left the
  // include unlocked. That refusal is on record for 2026-08-14, 2026-09-18 and 2026-09-25.
  assert.deepEqual(locked, [
    "/sap/bc/adt/functions/groups/zfug_demo/fmodules/z_fm_demo/source/main"
  ])
  assert.deepEqual(unlocked, locked)
  assert.equal(result.activation.success, true)
  assert.match(savedSource, /WRITE 'OK'/)
})

test("an ADT request trace reaches disk even when the diagnostic flag is off", async () => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-trace-"))
  const traceFlag = process.env.ABAP_MCP_ADT_TRACE
  const exportRoot = process.env.ABAP_MCP_EXPORT_ROOT
  const reported: string[] = []
  try {
    process.env.ABAP_MCP_EXPORT_ROOT = root
    delete process.env.ABAP_MCP_ADT_TRACE
    const options = writeClientOptions(true, (line) => reported.push(line))
    const put = {
      id: 7,
      request: {
        method: "PUT",
        uri: "/sap/bc/adt/functions/groups/zfug_demo/fmodules/z_fm_demo/source/main",
        params: { lockHandle: "raw-handle-must-not-be-logged" },
        headers: { cookie: "SAP_SESSIONID_GR2_200=secret" }
      },
      response: {
        statusCode: 423,
        body: "Resource MAIN Z_FM_DEMO is not locked (invalid lock handle: also-secret)",
        headers: {}
      },
      stateful: "stateful",
      duration: 15
    }
    options.debugCallback(put as never)

    const written = await readFile(join(root, "adt-trace.log"), "utf8")
    assert.match(written, /ADT-TRACE #7 PUT /)
    assert.match(written, /-> 423 stateful=stateful/)
    // The handle and the session cookie are what a diagnosis needs to correlate, and neither may be
    // written out: only short hashes reach the file.
    assert.match(written, /lockSent=sha256:/)
    assert.doesNotMatch(written, /raw-handle-must-not-be-logged/)
    assert.doesNotMatch(written, /also-secret/)
    assert.doesNotMatch(written, /SAP_SESSIONID_GR2_200=secret/)
    // The copy that rides the error message stays opt-in, so an ordinary failure stays short.
    assert.equal(
      reported.some((line) => line.startsWith("ADT-TRACE")),
      false
    )
    assert.ok(reported.some((line) => /returned HTTP 423/.test(line)))

    // Always-on tracing must not grow without limit on a long-lived service.
    await writeFile(join(root, "adt-trace.log"), "x".repeat(2_000_001))
    options.debugCallback(put as never)
    const rotated = await readFile(join(root, "adt-trace.log.1"), "utf8")
    const current = await readFile(join(root, "adt-trace.log"), "utf8")
    assert.equal(rotated.length, 2_000_001)
    assert.match(current, /ADT-TRACE #7 PUT /)
    assert.ok(current.length < 2_000_001)
  } finally {
    if (traceFlag === undefined) delete process.env.ABAP_MCP_ADT_TRACE
    else process.env.ABAP_MCP_ADT_TRACE = traceFlag
    if (exportRoot === undefined) delete process.env.ABAP_MCP_EXPORT_ROOT
    else process.env.ABAP_MCP_EXPORT_ROOT = exportRoot
    await rm(root, { recursive: true, force: true })
  }
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

test("creation accepts an optional seed source and rejects unusable source", () => {
  // Seeding the initial source in the create call is what makes creating a runnable report possible
  // at all: a separate replace_string_in_abap_object call can lose its edit lock on a cold stateful
  // ADT session and answer "Resource ... is not locked" even though it just took the lock.
  const seeded = prepareCreateObjectRequest("w200", {
    objectType: "PROG/P",
    name: "ZORVANTA_SEED_PROBE",
    description: "Seed source probe",
    packageName: "$TMP",
    source: ["REPORT zorvanta_seed_probe.", "", "START-OF-SELECTION.", "  WRITE: / 'ok'."]
  })
  assert.deepEqual(seeded.source, [
    "REPORT zorvanta_seed_probe.",
    "",
    "START-OF-SELECTION.",
    "  WRITE: / 'ok'."
  ])

  // Omitting source keeps the historical behaviour: create an empty object.
  assert.deepEqual(
    prepareCreateObjectRequest("w200", {
      objectType: "PROG/P",
      name: "ZORVANTA_SEED_PROBE",
      description: "No seed",
      packageName: "$TMP"
    }).source,
    []
  )

  const rejected: Array<[string, unknown, RegExp]> = [
    ["a non-array", "REPORT z.", /must be an array of source lines/],
    ["a non-string element", [1, 2], /must be an array of source lines/],
    ["an empty array", [], /at least one ABAP line/],
    [
      "an embedded newline",
      ["REPORT z.", "WRITE: / 'a'.\nWRITE: / 'b'."],
      /single line without embedded line breaks/
    ],
    ["a comment-only body", ["* nothing here"], /no executable statement/],
    ["blank lines only", ["", "   "], /no executable statement/]
  ]
  for (const [label, source, expected] of rejected) {
    assert.throws(
      () =>
        prepareCreateObjectRequest("w200", {
          objectType: "PROG/P",
          name: "ZORVANTA_SEED_PROBE",
          description: "Seed rejection",
          packageName: "$TMP",
          source: source as string[]
        }),
      expected,
      `expected source rejection for ${label}`
    )
  }

  // Types that own no plain ABAP source must refuse a seed rather than silently ignore it.
  for (const objectType of ["DDLS/DF", "DCLS/DL", "FUGR/F"]) {
    const request: Record<string, unknown> = {
      objectType,
      name: objectType === "FUGR/F" ? "ZFG_SEED" : "ZSEED_SOURCE",
      description: "Unseedable",
      packageName: "$TMP",
      source: ["REPORT zseed_source."]
    }
    assert.throws(
      () => prepareCreateObjectRequest("w200", request as never),
      /source is not supported for/,
      `expected ${objectType} to reject a seed source`
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
      httpClient: inactiveHttp(() => {
        calls.push("inactive")
        return []
      }),
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
          if (url.endsWith("/activation/inactiveobjects")) return inactiveHttp().request()
          calls.push({ url, contentType: options.headers?.["Content-Type"] ?? "" })
          return { body: "", status: 201, statusText: "Created", headers: {} }
        }
      },
      async findObjectPath() {
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
          if (_url.endsWith("/activation/inactiveobjects")) return inactiveHttp().request()
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
        : request.operation === "DELETE_MESSAGE_CLASS"
          ? ["M|1|REQUEST|GR2K923421"]
          : request.operation === "READ_MESSAGE_CLASS" ||
              request.operation === "CREATE_MESSAGE_CLASS"
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
  const deletedMessage = await backend.deleteMessageClass(
    "w200",
    "ZCMCP_MSG_026",
    "20260902170000",
    "ZABAP",
    "GR2K923421"
  )
  assert.equal(deletedMessage.transportNumber, "GR2K923421")

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
      "DELETE_MESSAGE_CLASS",
      "READ_TEXT_ELEMENTS",
      "MERGE_TEXT_ELEMENTS",
      "CREATE_FUNCTION_INCLUDE",
      "READ_TRANSPORT_DETAILS"
    ]
  )
  assert.equal(requests[3]?.objectType, "CLAS")
  assert.equal(requests[4]?.objectType, "FUGR")
  assert.equal(requests[5]?.program, "ZCMCP_FG_026")
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
          if (_url.endsWith("/activation/inactiveobjects")) return inactiveHttp().request()
          contentTypes.push(options.headers?.["Content-Type"] ?? "")
          return { body: "", status: 201, statusText: "Created", headers: {} }
        }
      },
      async mainPrograms() {
        return [{ "adtcore:uri": "/sap/bc/adt/functions/groups/zfg_legacy_create" }]
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
        httpClient: inactiveHttp(),
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
      httpClient: inactiveHttp(() => {
        calls.push("inactive")
        return []
      }),
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
      httpClient: inactiveHttp(),
      async mainPrograms() {
        return [{ "adtcore:uri": "/sap/bc/adt/functions/groups/zfg_demo" }]
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
        return savedSource || "FUNCTION-POOL zfg_demo."
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
    httpClient: inactiveHttp(),
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

test("native where-used sends a relative source URI and preserves column zero through the real SDK", async () => {
  const backend = backendWithInjectedClient()
  const requests: { path: string; uri: unknown; method: unknown }[] = []
  const http = {
    async request(path: string, options: { qs?: { uri?: string }; method?: string }) {
      requests.push({ path, uri: options.qs?.uri, method: options.method })
      return {
        body:
          path === "/sap/bc/adt/discovery"
            ? '<app:service><app:workspace><app:collection href="/sap/bc/adt/repository/informationsystem/usageReferences"/></app:workspace></app:service>'
            : '<usageReferences:usageReferenceResult xmlns:usageReferences="http://www.sap.com/adt/ris/usageReferences"><usageReferences:referencedObjects/></usageReferences:usageReferenceResult>',
        status: 200,
        headers: {}
      }
    }
  } as unknown as Parameters<typeof sdkUsageReferences>[0]
  injectClient(backend, {
    statelessClone: {
      httpClient: http
    }
  })
  const path = "/sap/bc/adt/programs/programs/zdemo/source/main"
  for (const [uri, line, column] of [
    [`adt://w200${path}`, 1, 0],
    [path, 3, 9]
  ] as const) {
    assert.deepEqual(await backend.usageReferences("w200", uri, line, column), [])
    assert.deepEqual(requests.at(-1), {
      path: "/sap/bc/adt/repository/informationsystem/usageReferences",
      uri: `${path}#start=${line},${column}`,
      method: "POST"
    })
  }
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

test("read_smartstyle surfaces the helper's reason instead of one flattened code", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)
  const input = {
    connectionId: "w200",
    styleName: "ZTESTSTYLE1",
    mode: "S" as const,
    active: "A" as const,
    includeCss: false
  }

  // Live w200 evidence: ZTESTSTYLE1 exists but has no active version. The helper used to fold that,
  // a missing variant, and a missing style into one STYLE_NOT_FOUND, so the caller could not tell a
  // style that needs activating from a name that is simply wrong.
  backend.smartstyleFailure = {
    code: "STYLE_ACTIVE_NOT_FOUND",
    message: "Smart style has no active version"
  }
  await assert.rejects(tools.readSmartstyle(input), /STYLE_ACTIVE_NOT_FOUND/)

  backend.smartstyleFailure = {
    code: "STYLE_VARIANT_NOT_FOUND",
    message: "Smart style variant does not exist"
  }
  await assert.rejects(tools.readSmartstyle(input), /STYLE_VARIANT_NOT_FOUND/)

  backend.smartstyleFailure = {
    code: "STYLE_NOT_FOUND",
    message: "Smart style does not exist"
  }
  await assert.rejects(tools.readSmartstyle(input), /STYLE_NOT_FOUND/)
})

/**
 * SAP's ENQU convention prefixes a lock object with E, and this system already stores the customer
 * lock object EZPMCTP that read_lock_object returns. The 2026-09-24 18:05 incident had
 * upsert_lock_object refuse EZPMCTPRP on its name while the read side accepted EZPMCTP, so a caller
 * could inspect a lock object it was forbidden to write. The customer test has to survive the
 * relaxation, otherwise EMARA would become writable.
 */
test("a customer lock object keeps SAP's E prefix and a standard one is still refused", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)
  const input = {
    connectionId: "w200",
    objectName: "EZPMCTPRP",
    description: "Upsert the reorganisation request lock",
    packageName: "ZABAP",
    transportNumber: "GR2K923472",
    header: { AGGTYPE: "E" },
    lockTables: [
      {
        TABNAME: "ZTPMC_TPRPH",
        FORTABNAME: "ZTPMC_TPRPH",
        FORFIELD: "",
        FORDIR: "",
        ENQMODE: "E"
      }
    ],
    lockFields: [
      {
        VIEWFIELD: "MANDT",
        TABNAME: "ZTPMC_TPRPH",
        FIELDNAME: "MANDT",
        ENQMODE: "E",
        ROLLNAME: "MANDT",
        KEYFLAG: "X",
        CHECKTABLE: ""
      }
    ]
  }

  await tools.upsertLockObject(input)

  // The optional E must not become a licence for standard lock objects.
  await assert.rejects(
    tools.upsertLockObject({ ...input, objectName: "EMARA" }),
    /customer lock object/
  )
  // And a bare customer name still works, so the E stays optional.
  await tools.upsertLockObject({ ...input, objectName: "ZPMCTPRP" })
})

/**
 * The 2026-09-24 20:46 incident tried to reconcile the unknown outcome of a failed lock object write
 * by reading the object back, and got a tool-level error: "Error invoking read_lock_object: ...:
 * DDIC_OBJECT_NOT_FOUND: DDIC object does not exist". The read had answered the question - the object
 * is not there - but it arrived as isError=true, which reads the same as a broken helper, so the
 * caller could not safely conclude that the earlier write had never reached SAP.
 *
 * A read that completes and finds nothing is a successful read. This asserts the caller-visible
 * answer is a parseable verdict, and that the relaxation did not swallow other failures.
 */
test("a read of a missing DDIC object answers not-found instead of failing", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)

  const result = JSON.parse(
    await tools.readLockObject({ connectionId: "w200", objectName: "EZPMCTPRP" })
  ) as Record<string, unknown>
  assert.equal(result.status, "not-found")
  assert.equal(result.exists, false)
  assert.equal(result.authoritative, true)
  assert.equal(result.objectName, "EZPMCTPRP")
  assert.equal(result.objectType, "lockObject")
  assert.equal(result.version, null)
  assert.equal(result.fingerprint, null)

  // The same object type is still readable once it exists, so not-found is a verdict about this
  // object and not a blanket relaxation of the read path.
  await tools.upsertLockObject({
    connectionId: "w200",
    objectName: "EZPMCTPRP",
    description: "Upsert the reorganisation request lock",
    packageName: "ZABAP",
    transportNumber: "GR2K923472",
    header: { AGGTYPE: "E" },
    lockTables: [{ TABNAME: "ZTPMC_TPRPH", ENQMODE: "E" }],
    lockFields: [{ VIEWFIELD: "MANDT", TABNAME: "ZTPMC_TPRPH", FIELDNAME: "MANDT", ENQMODE: "E" }]
  })
  const found = JSON.parse(
    await tools.readLockObject({ connectionId: "w200", objectName: "EZPMCTPRP" })
  ) as Record<string, unknown>
  assert.notEqual(found.status, "not-found")

  // A malformed name is a caller error, not a missing object, and must still be reported as one.
  await assert.rejects(
    tools.readLockObject({ connectionId: "w200", objectName: "not a name!" }),
    /not a valid SAP Dictionary name/
  )
})

/**
 * DD25V-ROOTTAB is derived by the ENQU activation, not copied from the request. Live w200 evidence,
 * 2026-09-24 23:20: operation repack-r1b1-create-ezpmctprp-20260924-04 sent header AGGTYPE=E and no
 * ROOTTAB, and SAP created and activated the object as version 20260924232006 with
 * DD25V-ROOTTAB = ZTPMC_TPRPH, the locked table. The service still reported "SAP DDIC verification
 * did not return the requested active definition" with status=failed and outcomeMayBeUnknown, because
 * it compared an invented empty root table against the value SAP had derived. The write had in fact
 * succeeded and activated; the false failure then blocked the dependent reorganisation work.
 *
 * So a caller who sends no root table must not be held to an empty one, and must be told the root
 * table SAP stored instead of the request echo that would report an empty one.
 */
test("a lock object create that sends no root table is not reported as a failed verification", async () => {
  const tools = new ToolService(new MockBackend())
  const created = JSON.parse(
    await tools.upsertLockObject({
      connectionId: "w200",
      objectName: "EZPMCTPRP",
      description: "Upsert the reorganisation request lock",
      packageName: "ZPMC",
      transportNumber: "GR2K923428",
      header: { AGGTYPE: "E" },
      lockTables: [{ TABNAME: "ZTPMC_TPRPH", FORTABNAME: "ZTPMC_TPRPH", ENQMODE: "E" }],
      lockFields: [{ VIEWFIELD: "MANDT", TABNAME: "ZTPMC_TPRPH", FIELDNAME: "MANDT", ENQMODE: "E" }]
    })
  ) as { definition: { rootTable: string; aggregationType: string }; rootTable: string }

  assert.equal(created.definition.rootTable, "ZTPMC_TPRPH")
  // The top-level copy reports what SAP stored, not the omitted request field.
  assert.equal(created.rootTable, "ZTPMC_TPRPH")
  assert.equal(created.definition.aggregationType, "E")
})

/**
 * The relaxation above must not become a licence to stop checking a root table the caller did send,
 * and a refused verification has to name the field and both values: an anonymous "did not return the
 * requested active definition" costs one SAP round trip per disagreeing field, which is the pattern
 * that made this chain of faults surface one error at a time.
 */
test("a supplied root table is still verified and the mismatch names the field", async () => {
  class DivergedRootTableBackend extends MockBackend {
    override async callSapDdic(
      connectionId: string,
      request: Parameters<MockBackend["callSapDdic"]>[1]
    ) {
      const result = await super.callSapDdic(connectionId, request)
      if (typeof result.header.VIEWNAME === "string") result.header.ROOTTAB = "ZTPMC_OTHER"
      return result
    }
  }

  await assert.rejects(
    new ToolService(new DivergedRootTableBackend()).upsertLockObject({
      connectionId: "w200",
      objectName: "EZPMCTPRP",
      description: "Upsert the reorganisation request lock",
      packageName: "ZPMC",
      transportNumber: "GR2K923428",
      header: { AGGTYPE: "E", ROOTTAB: "ZTPMC_TPRPH" },
      lockTables: [{ TABNAME: "ZTPMC_TPRPH", ENQMODE: "E" }],
      lockFields: [{ VIEWFIELD: "MANDT", TABNAME: "ZTPMC_TPRPH", FIELDNAME: "MANDT" }]
    }),
    /definition\.rootTable: SAP stored "ZTPMC_OTHER" instead of "ZTPMC_TPRPH"/
  )
})

/**
 * TNRO-NOIVBUFFER (NRIVBUFFER) is N 16, measured on w200 by the DD03L probe recorded in
 * .doc/code-update-20260922-140723.md. The helper assigns the caller's text into that numeric
 * component, so SAP stores "1000" as "0000000000001000" and the read-back publishes the padded text.
 * The verification compared the raw text, so a write that committed correctly was reported as a
 * failure. This is the same shape as TNRO-PERCENTAGE, fixed on 2026-09-22 while this field was left
 * behind; the padding tolerance is deliberately limited to the two numeric fields, because a plain
 * "007" against a stored "7" is still a difference in a character field.
 */
test("a number range write accepts the zero padding SAP stores in NOIVBUFFER", async () => {
  const input = {
    connectionId: "w200",
    objectName: "ZPMC_NR01",
    description: "Reorganisation request numbers",
    packageName: "ZPMC",
    transportNumber: "GR2K923428",
    properties: { NOIVBUFFER: "1000", PERCENTAGE: "10" }
  }
  const created = JSON.parse(
    await new ToolService(new MockBackend()).upsertNumberRangeObject(input)
  ) as {
    definition: { properties: Record<string, string> }
  }
  // The reported value is SAP's stored text, not the request echo.
  assert.equal(created.definition.properties.NOIVBUFFER, "0000000000001000")

  // A stored value that denotes another number must still be refused.
  class DivergedBufferBackend extends MockBackend {
    override async callSapDdic(
      connectionId: string,
      request: Parameters<MockBackend["callSapDdic"]>[1]
    ) {
      const result = await super.callSapDdic(connectionId, request)
      if (typeof result.header.OBJECT === "string") result.header.NOIVBUFFER = "0000000000002000"
      return result
    }
  }
  await assert.rejects(
    new ToolService(new DivergedBufferBackend()).upsertNumberRangeObject(input),
    /did not store NOIVBUFFER/
  )
})

/**
 * The DD31V/DD32P/DD33V numeric columns are NUMC, and the helper assigns the caller's text into the
 * component, so SAP stores the value zero-padded: the live read-back recorded in
 * .doc/code-update-20260920-135257.md shows LENG "000010" and SHLPSELPOS "00" for rows written as 10
 * and 1. Comparing the raw caller text rejected stored values that were the requested ones. The
 * expectation is padded to the width SAP itself reported, so no column width is assumed here.
 */
test("a search help write accepts the zero padding SAP stores in the DD32P numeric columns", async () => {
  const input = {
    connectionId: "w200",
    objectName: "ZPMC_SHLP1",
    description: "Reorganisation request search help",
    packageName: "ZPMC",
    transportNumber: "GR2K923428",
    header: { SELMETHOD: "ZTPMC_TPRPH", DIALOGTYPE: "D" },
    selectionMethods: [],
    parameters: [
      {
        FIELDNAME: "REQID",
        ROLLNAME: "ZPMCEL_TP_REQ_ID",
        LENG: "10",
        DECIMALS: "0",
        OUTPUTLEN: "10",
        SHLPSELPOS: "1",
        SHLPLISPOS: "1"
      }
    ],
    fieldAssignments: []
  }
  const created = JSON.parse(await new ToolService(new MockBackend()).upsertSearchHelp(input)) as {
    definition: { parameters: Array<Record<string, string>> }
  }
  assert.equal(created.definition.parameters[0]?.LENG, "000010")
  assert.equal(created.definition.parameters[0]?.SHLPSELPOS, "01")

  // Padding to a common width must not turn a different number into a match.
  class DivergedParameterBackend extends MockBackend {
    override async callSapDdic(
      connectionId: string,
      request: Parameters<MockBackend["callSapDdic"]>[1]
    ) {
      const result = await super.callSapDdic(connectionId, request)
      const parameter = result.parameters[0]
      if (parameter) parameter.LENG = "000020"
      return result
    }
  }
  await assert.rejects(
    new ToolService(new DivergedParameterBackend()).upsertSearchHelp(input),
    /definition\.parameters\[0\]\.LENG: SAP stored "000020" instead of "000010"/
  )
})

/**
 * The mirror image of the false-negative family. Every check above makes the service stop rejecting a
 * write SAP really performed; this one makes it stop accepting a write SAP never activated. A helper
 * below 1.16 verified a save by reading the *active* version with state = 'A', which succeeds even
 * when the activation was refused, because the object was already active (live w200 evidence:
 * .logs/mcp-incident-20260925-001201-upsert-lock-object-false-success, where EZPMCTPRP kept version
 * 20260924232006 and gained a leftover inactive version while the receipt said completed).
 *
 * The 1.16 helper adds the missing post-condition and answers DDIC_ACTIVATION_INCOMPLETE with the
 * activation diagnostics. The service must report that as a failure and must carry the diagnostics
 * through, otherwise the caller is back to guessing whether the object was changed at all.
 */
test("a write the helper could not prove active is reported as a failure, not a completed save", async () => {
  const backend = new MockBackend()
  backend.ddicWriteFailureCode = "DDIC_ACTIVATION_INCOMPLETE"
  const tools = new ToolService(backend)

  await assert.rejects(
    tools.upsertLockObject({
      connectionId: "w200",
      objectName: "EZPMCTPRP",
      description: "Upsert the reorganisation request lock",
      packageName: "ZPMC",
      transportNumber: "GR2K923428",
      header: { AGGTYPE: "E" },
      lockTables: [{ TABNAME: "ZTPMC_TPRPH", ENQMODE: "E" }],
      lockFields: [{ VIEWFIELD: "MANDT", TABNAME: "ZTPMC_TPRPH", FIELDNAME: "MANDT" }]
    }),
    (error: unknown) => {
      const message = String(error)
      assert.match(message, /DDIC_ACTIVATION_INCOMPLETE/)
      // The state the caller has to act on, not only the fact that something failed.
      assert.match(message, /keeps its previous active version/)
      assert.match(message, /inactive version/)
      // The helper's diagnostics survive: GOTSTATE 'M' is what proves a pending version remains.
      assert.match(message, /"GOTSTATE":"M"/)
      assert.match(message, /"ACT_RC":"4"/)
      return true
    }
  )
})

/**
 * The read half of the same incident. A read of an object that carries an inactive version answers
 * INACTIVE_VERSION_EXISTS from the helper, whose test is `DDIF_*_GET state = 'M'` returning
 * gotstate <> 'A'. That proves an inactive version exists and says nothing about the active one, yet
 * the service used to answer "has only an inactive version" and to quote a protocol comparison that
 * never ran ("protocol 1.15, below the 1.10 required"). EZPMCTPRP was still active when that message
 * was produced, so the wording sent the reader after a missing object instead of a pending version.
 */
test("an unreadable inactive version does not claim the object has only an inactive version", async () => {
  const backend = new MockBackend()
  backend.ddicReadFailure = {
    code: "INACTIVE_VERSION_EXISTS",
    message: "Inactive DDIC version must be resolved"
  }

  await assert.rejects(
    new ToolService(backend).readLockObject({ connectionId: "w200", objectName: "EZPMCTPRP" }),
    (error: unknown) => {
      const message = String(error)
      assert.match(message, /INACTIVE_VERSION_PENDING/)
      assert.match(message, /Inactive DDIC version must be resolved/)
      assert.match(message, /does not mean the object is inactive/)
      // The two invented claims must not come back.
      assert.doesNotMatch(message, /has only an inactive version/)
      assert.doesNotMatch(message, /below the 1\.10/)
      return true
    }
  )
})
