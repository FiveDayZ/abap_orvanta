import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { configurationActivityLayouts } from "../src/configuration-activity.js"
import { configurationImgDetailLayouts } from "../src/configuration-img-details.js"
import { configurationImgReaders } from "../src/configuration-img.js"
import {
  configurationDocumentationTables,
  configurationDocumentationStructures,
  configurationDocumentationFunctions,
  configurationDocumentationSchema
} from "../src/configuration-documentation.js"
import { configurationUnitLayouts } from "../src/configuration-unit.js"
import { startHttpServer } from "../src/http.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"

// Synthetic headers, index and content; no claim about current SAP CUNI documentation.
const activityId = "SIMG_CFMENUOLMSOMSC"
const reference = "SIMGSIMG_CFMENUOLMSOMSC"
const pins: Record<string, string> = {
  ...configurationImgDetailLayouts,
  ...configurationActivityLayouts,
  ...configurationDocumentationTables,
  ...configurationDocumentationStructures,
  OBJS: "dc1667a4e14e0d69b372ef3a7704052d5456d0542b1d45390bb1a662a5723451",
  TSTC: "44e8612fb2a6250584d3c6800498b7c3dd4c33de3790fc13dc0c2793e1b2ce26"
}

async function fixture(t: TestContext) {
  const rows: Record<string, Record<string, string>[]> = {
    CUS_IMGACH: [
      { ACTIVITY: activityId, DOCU_ID: reference, ATTRIBUTES: "", C_ACTIVITY: "TEST_C", TCODE: "" }
    ],
    CUS_ACTOBJ: [
      {
        ACT_ID: "TEST_C",
        OBJECTTYPE: "T",
        OBJECTNAME: "CUNI",
        TCODE: "CUNI",
        SUBOBJNAME: "",
        VARIANT: "",
        TXN_NO_CON: "",
        IMG_POS: "1",
        SUPRESS_FL: ""
      }
    ],
    OBJS: [
      {
        OBJECTNAME: "CUNI",
        OBJECTTYPE: "T",
        TABNAME: "T006A",
        COVER: "",
        CANDIDATE: "",
        DDIC: "",
        PRIM_TABLE: "",
        VIEWGRANT: "",
        TAB_FILLED: ""
      }
    ],
    TSTC: [{ TCODE: "CUNI", PGMNA: "SAPMUNIT" }],
    T002: [{ LAISO: "ZH", SPRAS: "1" }],
    CUS_IMGACT: [{ ACTIVITY: activityId, SPRAS: "1", TEXT: "Synthetic activity title" }],
    DOKIL: [
      {
        ID: "HY",
        OBJECT: reference,
        LANGU: "1",
        TYP: "E",
        VERSION: "0002",
        TXTLINES: "00001",
        DOKSTATE: "A"
      }
    ]
  }
  const state = {
    queries: 0,
    nativeReads: 0,
    totalNativeReads: 0,
    mode: "",
    tables: [] as string[],
    definitions: {} as Record<string, number>,
    headerReads: 0
  }
  const names = ["MANDT", "SPRAS", "MSEHI", "MSEH3", "MSEH6", "MSEHT", "MSEHL"]
  const lengths = [3, 1, 3, 3, 6, 10, 30]
  const old = {
    table: ToolService.prototype.readDdicTransparentTable,
    structure: ToolService.prototype.readDdicStructure,
    function: ToolService.prototype.readFunctionModuleInterface,
    metadata: ToolService.prototype.readAbapTable
  }
  const definition = async ({ objectName }: { objectName: string }) => {
    state.definitions[objectName] = (state.definitions[objectName] ?? 0) + 1
    return JSON.stringify(
      objectName === "T006A"
        ? {
            connectionId: "w200",
            objectName,
            objectKind: "transparentTable",
            version: "1",
            fingerprint: configurationUnitLayouts.T006A,
            packageName: "TEST",
            definition: {
              tableClass: "TRANSP",
              description: "Synthetic text layout",
              deliveryClass: "C",
              dataBrowserMaintenance: "allowed",
              fields: names.map((name, i) => ({
                name,
                position: i + 1,
                key: i < 3,
                dataElement: "",
                description: name
              }))
            }
          }
        : {
            connectionId: "w200",
            objectName,
            objectKind:
              objectName in configurationDocumentationStructures ? "structure" : "transparentTable",
            active: true,
            fingerprint:
              state.mode === "layoutDrift" &&
              objectName === "T002" &&
              state.definitions[objectName]! > 1
                ? "0".repeat(64)
                : pins[objectName]
          }
    )
  }
  ToolService.prototype.readDdicTransparentTable = definition
  ToolService.prototype.readDdicStructure = definition
  ToolService.prototype.readFunctionModuleInterface = async ({ functionName }) => {
    const pin =
      configurationImgReaders.find((p) => p.functionName === functionName) ??
      configurationDocumentationFunctions[
        functionName as keyof typeof configurationDocumentationFunctions
      ]
    assert.ok(pin, functionName)
    return JSON.stringify({ ...pin, connectionId: "w200", functionName, updateTask: false })
  }
  ToolService.prototype.readAbapTable = async (raw) => {
    assert.equal((raw as { tableName: string }).tableName, "DD03L")
    return JSON.stringify({
      connectionId: "w200",
      tableName: "DD03L",
      status: "ok",
      readOnly: true,
      truncated: false,
      returnedCount: names.length,
      data: names.map((FIELDNAME, i) => ({
        TABNAME: "T006A",
        AS4LOCAL: "A",
        FIELDNAME,
        DATATYPE: ["CLNT", "LANG", "UNIT"][i] ?? "CHAR",
        LENG: String(lengths[i]),
        DECIMALS: "0"
      }))
    })
  }
  const backend = new MockBackend(),
    originalDetails = backend.connectionDetails.bind(backend)
  backend.connectionDetails = (id) => ({ ...originalDetails(id), client: "200", language: "ZH" })
  backend.runQuery = async (_id: string, sql: string, limit?: number) => {
    state.queries++
    const match = /^SELECT (.+) FROM (\w+) WHERE (.+)$/.exec(sql)!
    const table = match[2]!,
      fields = match[1]!.split(", "),
      filters = [...match[3]!.matchAll(/(\w+) = '((?:''|[^'])*)'/g)]
    state.tables.push(table)
    if (state.mode === "headerDenied" && table === "CUS_IMGACH") throw Error("HTTP 403")
    if (state.mode === "languageDenied" && table === "T002") throw Error("HTTP 403")
    let selected = (rows[table] ?? []).filter((r) =>
      filters.every((f) => r[f[1]!] === f[2]!.replaceAll("''", "'"))
    )
    if (table === "CUS_IMGACH" && state.mode === "headerDrift" && ++state.headerReads > 1)
      selected = selected.map((r) => ({ ...r, DOCU_ID: "SIMGCHANGED" }))
    if (table === "DOKIL" && state.mode === "indexDrift" && state.nativeReads)
      selected = selected.map((r) => ({ ...r, VERSION: "0003" }))
    return selected
      .slice(0, limit)
      .map((r) => Object.fromEntries(fields.map((f) => [f, r[f] ?? ""])))
  }
  backend.callRemoteFunction = async (_id, request) => {
    assert.equal(
      request.functionName,
      "DOCU_GET",
      "no fallback, value, allocator, writer or CTS dispatch"
    )
    state.nativeReads++
    state.totalNativeReads++
    assert.deepEqual(request.inputParameters, {
      ID: "HY",
      OBJECT: reference,
      LANGU: "1",
      TYP: "E",
      VERSION: "0002",
      VERSION_ACTIVE_OR_LAST: "L",
      EXTEND_EXCEPT: "",
      PRINT_PARAM_GET: "",
      LINE: []
    })
    if (state.mode === "contentDenied")
      return {
        outputs: {},
        fault: { code: "SOAP", name: "NOT_AUTHORIZED", message: "synthetic refusal" }
      }
    return {
      outputs: {
        HEAD: { TDOBJECT: "DSYS", TDNAME: reference, TDID: "HY", TDSPRAS: "1", TDVERSION: "00002" },
        DOKTYP: "E",
        LINE: [
          {
            TDFORMAT: "  ",
            TDLINE:
              state.mode === "bodyDrift" && state.nativeReads === 2
                ? "changed"
                : "  text <GL:link>  "
          }
        ]
      }
    }
  }
  const driverFile = process.env.ORVANTA_DOCUMENTATION_FIXTURE_MODULE
  const driver = driverFile ? await import(driverFile) : null
  const roots = driver
    ? await driver.fixtureRoots("documentation")
    : { stateRoot: await mkdtemp(join(tmpdir(), "orvanta-documentation-flow-")) }
  const server = driver
    ? await driver.openFixture(t, backend, roots.bcStateRoot)
    : await startHttpServer(backend, 0, roots.stateRoot)
  const client = new Client({ name: "documentation-flow", version: "1" })
  t.after(async () => {
    try {
      await client.close()
      await server.closeIfIdle()
      if (driver) await driver.retainFixture(t, server, roots.bcStateRoot, state)
    } finally {
      ToolService.prototype.readDdicTransparentTable = old.table
      ToolService.prototype.readDdicStructure = old.structure
      ToolService.prototype.readFunctionModuleInterface = old.function
      ToolService.prototype.readAbapTable = old.metadata
    }
  })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.mcpUrl)) as Parameters<Client["connect"]>[0]
  )
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args })
    assert.equal(result.isError, undefined)
    return JSON.parse((result.content as { text: string }[])[0]!.text)
  }
  const reset = (mode = "") => {
    state.mode = mode
    state.definitions = {}
    state.headerReads = 0
    state.nativeReads = 0
  }
  const link = (result: {
    nextRead: { tool: string; arguments: Record<string, unknown>; readOnly: boolean }
    readability: string
    content: { status: string }
  }) => {
    assert.equal(result.readability, "unknown")
    assert.equal(result.content.status, "unknown")
    assert.equal(result.nextRead.tool, "read_configuration_documentation")
    assert.equal(result.nextRead.readOnly, true)
    assert.deepEqual(result.nextRead.arguments, {
      connectionId: "w200",
      activityId,
      language: "ZH",
      maxLines: 200
    })
    assert.ok(configurationDocumentationSchema.safeParse(result.nextRead.arguments).success)
    return result.nextRead
  }
  return { rows, state, call, client, reset, link, roots }
}

test("public documentation chain follows activity, optional mapping and descriptor through the exact bounded reader", async (t) => {
  const f = await fixture(t)
  const activity = await f.call("read_configuration_activity", {
    connectionId: "w200",
    activityId,
    language: " zh "
  })
  assert.equal(activity.nextRead.tool, "find_configuration_activities")
  assert.equal(activity.saveAvailable, false)
  const mapping = await f.call(activity.nextRead.tool, {
    ...activity.nextRead.arguments,
    includeDetails: true,
    language: "ZH"
  })
  const descriptor = await f.call(mapping.activities[0].nextRead.tool, {
    ...mapping.activities[0].nextRead.arguments,
    includeImg: true,
    language: "ZH"
  })
  assert.equal(f.state.nativeReads, 0)
  assert.ok(!f.state.tables.includes("DOKIL"))
  for (const documentation of [
    activity.documentation,
    mapping.activities[0].documentation,
    descriptor.img.activities[0].documentation
  ]) {
    f.reset()
    const next = f.link(documentation),
      result = await f.call(next.tool, next.arguments)
    assert.equal(result.status, "read")
    assert.equal(result.activityId, activityId)
    assert.equal(result.reference, reference)
    assert.equal(result.evidence.apiReads, 2)
    assert.deepEqual(result.lines, [{ TDFORMAT: "  ", TDLINE: "  text <GL:link>  " }])
    assert.match(result.contentFingerprint, /^[a-f0-9]{64}$/)
    assert.equal(result.coverage.contentTrust, "untrusted_documentation_data")
    assert.equal(result.coverage.languageFallback, false)
    assert.equal(result.saveAvailable, false)
  }
})

test("public documentation links retract for missing or unsupported references, unavailable language and metadata drift", async (t) => {
  const f = await fixture(t)
  for (const value of ["", "OTHER", "SIMGbad", "SIMG" + "X".repeat(57)]) {
    f.rows.CUS_IMGACH![0]!.DOCU_ID = value
    const result = await f.call("read_configuration_activity", { connectionId: "w200", activityId })
    assert.equal(result.documentation.nextRead, null)
    assert.equal(result.documentation.readability, "unknown")
  }
  f.rows.CUS_IMGACH![0]!.DOCU_ID = reference
  for (const mode of ["languageDenied", "layoutDrift"]) {
    f.reset(mode)
    const result = await f.call("read_configuration_activity", { connectionId: "w200", activityId })
    assert.equal(result.documentation.nextRead, undefined)
    assert.equal(result.evidence.details.status, "unavailable")
  }
  f.reset()
  const missingLanguage = await f.call("read_configuration_activity", {
    connectionId: "w200",
    activityId,
    language: "ZZ"
  })
  assert.equal(missingLanguage.documentation.nextRead, undefined)
  f.rows.CUS_IMGACH = []
  assert.equal(
    (await f.call("read_configuration_activity", { connectionId: "w200", activityId }))
      .documentation.status,
    "header_not_found"
  )
  assert.equal(f.state.nativeReads, 0)
})

test("public documentation chain preserves no-details behavior and refuses header failures and strict invalid inputs", async (t) => {
  const f = await fixture(t)
  const mapping = await f.call("find_configuration_activities", {
    connectionId: "w200",
    objectName: "T006A",
    resolveMaintenanceObjects: true
  })
  assert.equal(mapping.activities[0].documentation, undefined)
  assert.ok(
    !f.state.tables.some(
      (table) =>
        table === "T002" || table === "CUS_IMGACT" || table.startsWith("TNODE") || table === "DOKIL"
    )
  )
  for (const mode of ["headerDenied", "headerDrift"]) {
    f.reset(mode)
    const result = await f.client.callTool({
      name: "read_configuration_activity",
      arguments: { connectionId: "w200", activityId }
    })
    assert.equal(result.isError, true)
    assert.match(
      (result.content as { text: string }[])[0]!.text,
      mode === "headerDrift" ? /HEADER_CHANGED/ : /QUERY_FAILED/
    )
  }
  f.reset()
  const before = f.state.queries
  for (const patch of [
    { documentId: reference },
    { activityId: reference },
    { language: "Z" },
    { maxLines: 401 },
    { maxLines: 0 },
    { unexpected: true }
  ]) {
    assert.equal(
      (
        await f.client.callTool({
          name: "read_configuration_documentation",
          arguments: { connectionId: "w200", activityId, ...patch }
        })
      ).isError,
      true
    )
  }
  assert.equal(f.state.queries, before)
  assert.equal(f.state.nativeReads, 0)
})

test("public documentation content discards permissions, growth and body/index drift without persisting display links", async (t) => {
  const f = await fixture(t)
  const next = f.link(
    (await f.call("read_configuration_activity", { connectionId: "w200", activityId }))
      .documentation
  )
  const historical = f.roots.bcStateRoot
    ? await readFile(
        join(
          f.roots.bcStateRoot,
          "configuration-bc-before-state/7a1bf66782df664fff5532c1097000f2ca0c5177974ab2b8141baa5948baa51a.json"
        )
      )
    : null
  for (const mode of ["contentDenied", "bodyDrift", "indexDrift", "limit"]) {
    f.reset(mode)
    f.rows.DOKIL![0]!.TXTLINES = mode === "limit" ? "00201" : "00001"
    const result = await f.call(next.tool, next.arguments)
    assert.equal(
      result.status,
      mode === "contentDenied" ? "unavailable" : mode === "limit" ? "limit_exceeded" : "changed"
    )
    assert.equal(result.lines, null)
    assert.equal(result.contentFingerprint, null)
    assert.equal(result.saveAvailable, false)
    if (mode === "limit") assert.equal(f.state.nativeReads, 0)
    if (mode === "contentDenied")
      assert.equal(result.code, "CONFIGURATION_DOCUMENTATION_NOT_AUTHORIZED")
  }
  if (historical)
    assert.deepEqual(
      await readFile(
        join(
          f.roots.bcStateRoot,
          "configuration-bc-before-state/7a1bf66782df664fff5532c1097000f2ca0c5177974ab2b8141baa5948baa51a.json"
        )
      ),
      historical
    )
})
