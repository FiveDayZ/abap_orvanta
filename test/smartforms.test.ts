import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { XMLParser } from "fast-xml-parser"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { startHttpServer } from "../src/http.js"
import { MockBackend } from "./mock-backend.js"
import {
  SmartformService,
  buildSmartformEnvelope,
  parseSmartformResponse,
  readSmartformSchema,
  createSmartformSchema,
  validateSmartformXml,
  type SmartformRequest,
  type SmartformResponse
} from "../src/smartforms.js"

// Protocol fixture only: not a SAP form and never sent to SAP.
const xml =
  '<sf:SMARTFORM xmlns:sf="urn:sap-com:SmartForms:2000:internal-structure"><TEXT>  中文 &amp; &lt;code&gt; &#x41;\n  </TEXT></sf:SMARTFORM>'
const input = {
  connectionId: "w200",
  formName: "ZSF_FIXTURE",
  language: "E",
  version: "saved" as const
}
const hash = "a".repeat(64)
function response(
  request: SmartformRequest,
  extra: Partial<SmartformResponse> = {}
): SmartformResponse {
  return {
    protocol: "1",
    status: "S",
    code: "OK",
    message: "",
    formName: request.formName,
    language: request.language,
    version: request.version,
    xml,
    fingerprint: hash,
    packageName: "$TMP",
    active: "X",
    inactive: request.action === "ACTIVATE" ? "" : "X",
    requestNumber: "",
    ...extra
  }
}
const localWrite = {
  ...input,
  version: undefined,
  packageName: "$TMP",
  operationId: "operation-1",
  xml
}
// Schema strictness is exercised independently; write inputs have no version.
const writeInput = {
  connectionId: input.connectionId,
  formName: input.formName,
  language: input.language,
  packageName: "$TMP",
  operationId: "operation-1",
  xml
}

test("Smartform schemas reject foreign objects, DTD, invalid namespaces and oversize UTF-8", () => {
  assert.equal(
    readSmartformSchema.parse({ ...input, formName: "zsf_fixture" }).formName,
    "ZSF_FIXTURE"
  )
  assert.equal(readSmartformSchema.parse({ ...input, formName: "SAP_FORM" }).formName, "SAP_FORM")
  assert.throws(() => createSmartformSchema.parse({ ...writeInput, formName: "SAP_FORM" }))
  assert.throws(() => createSmartformSchema.parse(localWrite))
  assert.throws(() => validateSmartformXml('<!DOCTYPE sf [<!ENTITY a "b">]>' + xml))
  assert.throws(() =>
    validateSmartformXml(xml.replace("urn:sap-com:SmartForms:2000:internal-structure", "urn:other"))
  )
  assert.throws(() => validateSmartformXml(xml + xml))
  assert.throws(() => validateSmartformXml(xml.replace("中文", "中".repeat(400000))))
})

test("Smartform root validation accepts document whitespace and PI but rejects extra content", () => {
  const formatted = '<?xml version="1.0"?>\r\n' + xml + "\r\n<?sap processing?>"
  validateSmartformXml(formatted)
  assert.throws(() => validateSmartformXml(xml + "<OTHER/>"))
  assert.throws(() => validateSmartformXml(xml + xml))
  assert.throws(() => validateSmartformXml(xml + "\n<![CDATA[ ]]>"))
  assert.throws(() => validateSmartformXml(xml + "\nprivate-text<?sap processing?>"))
})

test("Smartform validation accepts a leading BOM without changing the returned XML", async () => {
  const document = '\uFEFF<?xml version="1.0" encoding="utf-16"?>\r\n' + xml
  validateSmartformXml(document)
  const service = new SmartformService({
    callSmartform: async (_, request) => response(request, { xml: document })
  })
  assert.equal((await service.read(input)).xml, document)
  assert.throws(() => validateSmartformXml("\uFEFF" + document))
  assert.throws(() => validateSmartformXml(xml + "\uFEFF"))
})

test("Smartform XML errors distinguish size, declarations and syntax without exposing content", () => {
  assert.throws(
    () =>
      validateSmartformXml(
        '<sf:SMARTFORM xmlns:sf="private-namespace"><TEXT>private-text</TEXT></sf:SMARTFORM>'
      ),
    (error: Error) => {
      assert.match(error.message, /SMARTFORM_XML_ROOT_INVALID:/)
      assert.match(error.message, /"roots":\["sf:SMARTFORM"\]/)
      assert.match(error.message, /"attributes":\["@_xmlns:sf"\]/)
      assert.equal(error.message.includes("private-"), false)
      return true
    }
  )
  assert.throws(() => validateSmartformXml(""), /SMARTFORM_XML_INVALID: SYNTAX bytes=0/)
  assert.throws(
    () => validateSmartformXml('<!DOCTYPE sf [<!ENTITY a "private-text">]>' + xml),
    /SMARTFORM_XML_INVALID: FORBIDDEN_DECLARATION bytes=\d+$/
  )
  assert.throws(
    () => validateSmartformXml(xml.replace("中文", "中".repeat(400000))),
    /SMARTFORM_XML_INVALID: UTF8_LIMIT bytes=\d+$/
  )
  assert.throws(
    () => validateSmartformXml('<SMARTFORM private-text="one" private-text="two"/>'),
    /^Error: SMARTFORM_XML_INVALID: SYNTAX bytes=\d+ line=\d+ column=\d+ code=InvalidAttr first=3c unclosed=false$/
  )
})

test("Smartform SOAP round trip retains Unicode, entities, whitespace and literal line breaks", () => {
  const body = buildSmartformEnvelope({ ...input, action: "SAVE", xml })
  const parsed = new XMLParser({
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: false
  }).parse(body)
  assert.equal(parsed.Envelope.Body.Z_ORVANTA_SMARTFORM_API.IV_XML, xml)
  const result = response({ ...input, action: "READ" })
  const names = {
    protocol: "PROTOCOL",
    status: "STATUS",
    code: "CODE",
    message: "MESSAGE",
    formName: "FORMNAME",
    language: "LANGUAGE",
    version: "VERSION",
    xml: "XML",
    fingerprint: "FINGERPRINT",
    packageName: "PACKAGE",
    active: "ACTIVE",
    inactive: "INACTIVE",
    requestNumber: "REQUEST"
  } as const
  const escape = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  const envelope =
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><r:Z_ORVANTA_SMARTFORM_API.Response xmlns:r="urn:sap-com:document:sap:rfc:functions">' +
    Object.entries(names)
      .map(
        ([key, field]) => `<EV_${field}>${escape(result[key as keyof typeof names])}</EV_${field}>`
      )
      .join("") +
    "</r:Z_ORVANTA_SMARTFORM_API.Response></s:Body></s:Envelope>"
  assert.deepEqual(parseSmartformResponse(envelope), result)
  assert.deepEqual(parseSmartformResponse(envelope.replace("中文", "&#20013;&#x6587;")), result)
  const encodedXml = escape(result.xml)
  assert.equal(
    parseSmartformResponse(envelope.replace(encodedXml, encodedXml.replace("\n", "&#13;\n"))).xml,
    result.xml.replace("\n", "\r\n")
  )
  assert.deepEqual(
    parseSmartformResponse(
      envelope.replace(/&lt;/g, "&#60;").replace(/&gt;/g, "&#62;").replace(/&amp;/g, "&#38;")
    ),
    result
  )
  assert.deepEqual(
    parseSmartformResponse(
      envelope.replace(/&lt;/g, "&#x3C;").replace(/&gt;/g, "&#x3E;").replace(/&amp;/g, "&#x26;")
    ),
    result
  )
  const escapedField = envelope.replace(encodedXml, escape(encodedXml))
  assert.equal(parseSmartformResponse(escapedField).xml, encodedXml)
  assert.throws(() => validateSmartformXml(parseSmartformResponse(escapedField).xml))
  const forbiddenField = envelope.replace(encodedXml, escape("<!DOCTYPE sf>" + result.xml))
  assert.throws(
    () => validateSmartformXml(parseSmartformResponse(forbiddenField).xml),
    /FORBIDDEN_DECLARATION/
  )
  assert.throws(() => parseSmartformResponse(envelope.replace("<EV_PROTOCOL>1", "<EV_PROTOCOL>2")))
  assert.throws(() => parseSmartformResponse("<html>login</html>"))
})

test("Smartform read fails closed on wrong identity and helper errors", async () => {
  const wrong = new SmartformService({
    callSmartform: async (_, req) => response(req, { formName: "ZOTHER" })
  })
  await assert.rejects(wrong.read(input), /SCOPE_MISMATCH/)
  const unavailable = new SmartformService({
    callSmartform: async (_, req) => response(req, { status: "E", code: "NOT_AUTHORIZED" })
  })
  await assert.rejects(unavailable.read(input), /NOT_AUTHORIZED/)
})

test("save preserves both pre-change versions before the single write; stale input never writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "smartform-backup-"))
  const calls: string[] = []
  try {
    const service = new SmartformService(
      {
        callSmartform: async (_, req) => {
          calls.push(`${req.action}:${req.version}`)
          return response(req)
        }
      },
      root
    )
    const result = await service.write("SAVE", { ...writeInput, expectedFingerprint: hash })
    assert.deepEqual(calls, ["READ:saved", "READ:active", "SAVE:saved"])
    const backup = JSON.parse(await readFile(result.backupPath, "utf8"))
    assert.equal(backup.versions.length, 2)
    assert.equal(backup.versions[0].xml, xml)
    assert.equal(backup.versions[1].version, "active")
    await assert.rejects(
      service.write("SAVE", {
        ...writeInput,
        operationId: "stale",
        expectedFingerprint: "b".repeat(64)
      }),
      /PRECHANGE_MISMATCH/
    )
    assert.equal(calls.filter((entry) => entry.startsWith("SAVE")).length, 1)
    await assert.rejects(
      service.write("SAVE", { ...writeInput, expectedFingerprint: hash }),
      /EEXIST/
    )
    assert.equal(calls.filter((entry) => entry.startsWith("SAVE")).length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("unknown write result is not retried and retains its immutable backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "smartform-unknown-"))
  let writes = 0
  let marked = false
  try {
    const service = new SmartformService(
      {
        callSmartform: async (_, req) => {
          if (req.action !== "READ") {
            writes++
            assert.equal(marked, true)
            throw new Error("connection lost")
          }
          return response(req)
        }
      },
      root
    )
    await assert.rejects(
      service.write("SAVE", { ...writeInput, expectedFingerprint: hash }, async () => {
        marked = true
      }),
      /connection lost/
    )
    assert.equal(writes, 1)
    await assert.rejects(
      service.write("CREATE", {
        ...writeInput,
        packageName: "ZPACKAGE",
        operationId: "bad-transport"
      }),
      /TRANSPORT_REQUIRED/
    )
    assert.equal(writes, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("MCP create uses the dedicated route and blocks duplicate operation IDs before SAP invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "smartform-protocol-"))
  const backend = new MockBackend()
  let exists = false
  let writes = 0
  backend.callSmartform = async (_id: string, req: SmartformRequest) => {
    if (req.action === "READ" && !exists)
      return response(req, {
        status: "E",
        code: "NOT_FOUND",
        message: "Smart Form does not exist",
        xml: "",
        fingerprint: "",
        active: "",
        inactive: ""
      })
    if (req.action === "CREATE") {
      exists = true
      writes++
    }
    return response(req)
  }
  const running = await startHttpServer(backend, 0, root)
  const client = new Client({ name: "smartform-contract-test", version: "1" })
  try {
    const transport = new StreamableHTTPClientTransport(new URL(running.mcpUrl))
    await client.connect(transport as Parameters<Client["connect"]>[0])
    const first = await client.callTool({ name: "create_smartform", arguments: writeInput })
    assert.equal(first.isError, undefined)
    const duplicate = await client.callTool({ name: "create_smartform", arguments: writeInput })
    assert.equal(duplicate.isError, true)
    assert.match(JSON.stringify(duplicate), /duplicate_blocked/)
    assert.equal(writes, 1)
    const tools = (await client.listTools()).tools
    assert.equal(
      tools.find((tool) => tool.name === "read_smartform")?.annotations?.readOnlyHint,
      true
    )
    assert.equal(
      tools.find((tool) => tool.name === "save_smartform")?.annotations?.readOnlyHint,
      false
    )
  } finally {
    await client.close()
    await running.close()
    await rm(root, { recursive: true, force: true })
  }
})
