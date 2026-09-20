import assert from "node:assert/strict"
import test from "node:test"
import { ToolService } from "../src/tools.js"
import { parseRemoteFunctionResponse, parseSapRepositoryResponse } from "../src/adt-backend.js"
import { MockBackend } from "./mock-backend.js"

test("RFC SOAP numeric entities decode once in JSON, structures, tables and faults", () => {
  const encoded = "{&#34;text&#34;:&#34;&#x4e2d;&#25991; &amp;#34; &amp;lt;&#34;}"
  const json = '{"text":"\u4e2d\u6587 &#34; &lt;"}'
  const result = parseRemoteFunctionResponse(
    `<r><EV_RESULT>${encoded}</EV_RESULT><ES_DATA><TEXT>${encoded}</TEXT></ES_DATA>` +
      `<ET_DATA><item><TEXT>${encoded}</TEXT></item></ET_DATA></r>`,
    [
      { name: "EV_RESULT", kind: "scalar" },
      { name: "ES_DATA", kind: "structure", fields: ["TEXT"] },
      { name: "ET_DATA", kind: "table", fields: ["TEXT"] }
    ]
  )
  assert.deepEqual(result.outputs, {
    EV_RESULT: json,
    ES_DATA: { TEXT: json },
    ET_DATA: [{ TEXT: json }]
  })
  assert.equal(JSON.parse(result.outputs.EV_RESULT as string).text, "\u4e2d\u6587 &#34; &lt;")
  const fault = parseRemoteFunctionResponse(
    "<Fault><faultcode>Server</faultcode><faultstring>&#x4e2d;&#25991; &amp;#34;</faultstring></Fault>",
    []
  )
  assert.equal(fault.fault?.message, "\u4e2d\u6587 &#34;")
})

function chunkPayload(lines: string[]): string[] {
  const result = ["M|1|SOURCE_FORMAT|CHUNKS_V1", `M|1|SOURCE_LINES|${lines.length}`]
  lines.forEach((line, index) => {
    result.push(`S|${index + 1}|LENGTH|${line.length}`)
    for (let offset = 0; offset < line.length; offset += 60) {
      // Simulate CHAR255 transport stripping trailing spaces, not a JSON string transport.
      const part = line
        .slice(offset, offset + 60)
        .trimEnd()
        .replaceAll("%", "%25")
        .replaceAll("|", "%7C")
      result.push(`S|${index + 1}|PART${offset / 60 + 1}|${part}`)
    }
  })
  assert.ok(result.every((line) => line.length <= 255))
  return result
}

function longSourceBackend(
  lines: string[],
  changePayload?: (payload: string[]) => string[],
  numericEntities = false
) {
  const backend = new MockBackend()
  const original = backend.callSapRepository.bind(backend)
  backend.callSapRepository = async (id, request) => {
    const result = await original(id, request)
    if (request.operation !== "READ_FUNCTION_INTERFACE") return result
    assert.equal(request.objectType, "SRC1")
    const payload = chunkPayload(lines)
    const source = [
      ...result.source.filter((line) => !line.startsWith("S|")),
      ...(changePayload ? changePayload(payload) : payload)
    ]
    let xml = source
      .map(
        (line) =>
          `<item><LINE>${line.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</LINE></item>`
      )
      .join("")
    if (numericEntities) {
      xml = xml.replace(/[^\x00-\x7f]/g, (char) => `&#x${char.charCodeAt(0).toString(16)};`)
      xml = xml.replaceAll("&lt;", "&#60;").replaceAll("&gt;", "&#x3E;")
    }
    return {
      ...result,
      source: parseSapRepositoryResponse(
        `<r><EV_STATUS>S</EV_STATUS><EV_CODE>OK</EV_CODE><EV_VERSION>2.1</EV_VERSION><IT_SOURCE>${xml}</IT_SOURCE></r>`
      ).source
    }
  }
  return backend
}

test("function source chunks preserve 73-255 characters, escapes and boundary spaces", async () => {
  const lines = [
    "FUNCTION zcmcp_fm_1501.",
    "",
    "*".repeat(73),
    "&amp; &lt; &#38; &#x20; ".repeat(8),
    "A".repeat(59) + " " + "B".repeat(58) + "  " + "%7C|%25".repeat(10),
    " ".repeat(255),
    "*".repeat(255),
    "ENDFUNCTION."
  ]
  const result = JSON.parse(
    await new ToolService(longSourceBackend(lines)).readFunctionModuleInterface({
      functionName: "ZCMCP_FM_1501",
      connectionId: "w200"
    })
  )
  assert.deepEqual(result.source, lines)
})

test("numeric SOAP entities decode once before validating source chunk lengths", async () => {
  const lines = ["\u4e2d\u6587 < > &amp; &#38; &#x20; ".repeat(5), "*".repeat(100)]
  const result = JSON.parse(
    await new ToolService(longSourceBackend(lines, undefined, true)).readFunctionModuleInterface({
      functionName: "ZCMCP_FM_1501",
      connectionId: "w200"
    })
  )
  assert.deepEqual(result.source, lines)
})

for (const [datatype, length, comptype, supported] of [
  ["DATS", "8", "E", true],
  ["TIMS", "6", "E", true],
  ["CHAR", "12", "E", true],
  ["NUMC", "3", "E", true],
  ["INT4", "10", "E", true],
  ["STRG", "12", "E", false],
  ["CHAR", "12", "S", false],
  ["CHAR", "0", "E", false],
  ["DATS", "4", "E", false],
  ["", "", "", false]
] as const) {
  test(`direct DDIC field ${datatype}/${length}/${comptype} support=${supported}`, async () => {
    const { backend } = tableBackend()
    const original = backend.callSapDdic.bind(backend)
    backend.callSapDdic = async (id, request) => {
      const result = await original(id, request)
      return request.operation === "READ_TRANSPARENT_TABLE"
        ? {
            ...result,
            fields: [
              {
                FIELDNAME: "DIRECT_FIELD",
                ROLLNAME: "",
                DATATYPE: datatype,
                LENG: length,
                COMPTYPE: comptype
              }
            ]
          }
        : result
    }
    const metadata = JSON.parse(
      await new ToolService(backend).readFunctionModuleInterface({
        connectionId: "w200",
        functionName: "ZCMCP_FM_1801",
        includeExecutionSupport: true
      })
    )
    assert.equal(metadata.executionSupport.supported, supported)
  })
}

for (const [label, change] of [
  ["missing source line", (lines: string[]) => lines.filter((line) => !line.startsWith("S|"))],
  ["missing chunk", (lines: string[]) => lines.filter((line) => !line.startsWith("S|1|PART2|"))],
  [
    "duplicate chunk",
    (lines: string[]) => [...lines, lines.find((line) => line.startsWith("S|1|PART1|"))!]
  ],
  [
    "invalid length",
    (lines: string[]) =>
      lines.map((line) => (line.startsWith("S|1|LENGTH|") ? "S|1|LENGTH|256" : line))
  ],
  [
    "unknown format",
    (lines: string[]) => lines.map((line) => line.replace("CHUNKS_V1", "CHUNKS_V2"))
  ]
] as const) {
  test(`function source fails closed for ${label}`, async () => {
    await assert.rejects(
      new ToolService(longSourceBackend(["*".repeat(200)], change)).readFunctionModuleInterface({
        functionName: "ZCMCP_FM_1501",
        connectionId: "w200"
      })
    )
  })
}

test("the helper-backed interface patch accepts source lines wider than 72 columns", async () => {
  // The retired native ADT patch had to rewrite the ADT declaration and therefore rejected any
  // implementation line above 72 columns. The helper rebuilds the interface from RPY tables
  // inside SAP and never rewrites a source line, so a wide line is no longer a precondition.
  const backend = longSourceBackend(["*".repeat(100)])
  const tools = new ToolService(backend)
  const current = JSON.parse(
    await tools.readFunctionModuleInterface({
      functionName: "ZCMCP_FM_1501",
      connectionId: "w200"
    })
  )
  const patched = JSON.parse(
    await tools.patchFunctionModuleInterface({
      connectionId: "w200",
      functionName: "ZCMCP_FM_1501",
      functionGroup: current.functionGroup,
      expectedInterfaceFingerprint: current.interfaceFingerprint,
      expectedSourceFingerprint: current.sourceFingerprint,
      packageName: "ZABAP",
      transportNumber: "GR2K923421",
      parameterOperations: [
        {
          operation: "add",
          direction: "import",
          name: "IV_NEW",
          typeName: "CHAR20",
          optional: true,
          passByValue: true
        }
      ],
      exceptionOperations: []
    })
  ) as {
    status: string
    importParameters: Array<{ name: string }>
    source: string[]
  }
  assert.equal(patched.status, "FUNCTION_INTERFACE_PATCHED")
  assert.equal(
    patched.importParameters.some((parameter) => parameter.name === "IV_NEW"),
    true
  )
  assert.deepEqual(patched.source, current.source)
})

function tableBackend(
  options: { error?: string; tableError?: boolean; complex?: boolean; wrongClass?: boolean } = {}
) {
  const backend = new MockBackend()
  const original = backend.callSapDdic.bind(backend)
  const operations: string[] = []
  backend.callSapDdic = async (id, request) => {
    operations.push(request.operation)
    if (request.objectName !== "BAPIRET2") return original(id, request)
    const structure = await original(id, { operation: "READ_STRUCTURE", objectName: "BAPIRET2" })
    if (request.operation === "READ_STRUCTURE")
      return {
        ...structure,
        status: "E",
        code: options.error ?? "OBJECT_TYPE_MISMATCH",
        message: "Not a structure"
      }
    if (request.operation === "READ_TRANSPARENT_TABLE")
      return {
        ...structure,
        status: options.tableError ? "E" : "S",
        code: options.tableError ? "NO_AUTHORITY" : "TABLE_READ",
        header: { ...structure.header, TABCLASS: options.wrongClass ? "VIEW" : "TRANSP" },
        fields: options.complex ? [{ FIELDNAME: ".INCLUDE", ROLLNAME: "" }] : structure.fields
      }
    throw new Error(`Unexpected fallback ${request.operation}`)
  }
  return { backend, operations }
}

test("flat transparent records resolve for structures and TABLES, and execute with exact shapes", async () => {
  const { backend, operations } = tableBackend()
  const tools = new ToolService(backend)
  const metadata = JSON.parse(
    await tools.readFunctionModuleInterface({
      connectionId: "w200",
      functionName: "ZCMCP_FM_1801",
      includeExecutionSupport: true
    })
  )
  assert.equal(metadata.executionSupport.supported, true)
  assert.ok(operations.includes("READ_TRANSPARENT_TABLE"))
  const result = JSON.parse(
    await tools.testRemoteFunctionModule({
      connectionId: "w200",
      functionName: "ZCMCP_FM_1801",
      inputParameters: {},
      structureInputs: { IS_REQUEST: { TYPE: "S", MESSAGE: "TEST" } },
      tableInputs: { CT_ITEMS: [{ TYPE: "S", MESSAGE: "ITEM" }] },
      expectedStructureOutputs: { ES_RESPONSE: { TYPE: "S", MESSAGE: "MCP:TEST" } },
      expectedTableOutputs: { CT_ITEMS: [{ TYPE: "S", MESSAGE: "ROW:ITEM" }] },
      expectedInterfaceFingerprint: metadata.fingerprint,
      acknowledgePotentialSideEffects: true
    })
  )
  assert.equal(result.status, "passed")
})

test("DDIC table types also accept a verified transparent-table row type", async () => {
  const { backend } = tableBackend()
  const metadata = JSON.parse(
    await new ToolService(backend).readFunctionModuleInterface({
      connectionId: "w200",
      functionName: "ZCMCP_FM_1901",
      includeExecutionSupport: true
    })
  )
  assert.equal(metadata.executionSupport.supported, true)
  assert.deepEqual(
    metadata.executionSupport.parameters.map((parameter: { kind: string; fields: string[] }) => ({
      kind: parameter.kind,
      fields: parameter.fields
    })),
    [
      { kind: "table", fields: ["TYPE", "MESSAGE"] },
      { kind: "table", fields: ["TYPE", "MESSAGE"] }
    ]
  )
})

for (const options of [
  { error: "NO_AUTHORITY" },
  { tableError: true },
  { complex: true },
  { wrongClass: true }
]) {
  test(`transparent row type rejects unsafe fallback ${JSON.stringify(options)}`, async () => {
    const { backend, operations } = tableBackend(options)
    const metadata = JSON.parse(
      await new ToolService(backend).readFunctionModuleInterface({
        connectionId: "w200",
        functionName: "ZCMCP_FM_1801",
        includeExecutionSupport: true
      })
    )
    assert.equal(metadata.executionSupport.supported, false)
    if (options.error) assert.equal(operations.includes("READ_TRANSPARENT_TABLE"), false)
  })
}
