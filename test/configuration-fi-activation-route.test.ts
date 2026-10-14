import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  configurationFiActivationRouteSchema,
  inspectConfigurationFiActivationRoute,
  resolveFiActivationParameters
} from "../src/configuration-fi-activation-route.js"
import { configurationBteRouteLayouts } from "../src/configuration-bte-route.js"
import { configurationBteProductApi } from "../src/configuration-bte-product.js"
import { assertTableAllowed } from "../src/table-allowlist.js"
import { startHttpServer } from "../src/http.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"

function fixture() {
  const rows: Record<string, Record<string, string>[]> = {
    TSTC: [{ TCODE: "OB28", PGMNA: "", DYPNO: "0000" }],
    // Entirely local fixture; no SAP maintenance object is inferred from this name.
    TSTCP: [{ TCODE: "OB28", PARAM: "/*SM30 VIEWNAME=V_ORV_TEST;UPDATE=X;" }],
    TVDIR: [{ TABNAME: "V_ORV_TEST", AREA: "ZTEST", NEWGENER: "" }],
    TVIMF: [{ TABNAME: "V_ORV_TEST", EVENT: "01", FORMNAME: "CHECK_TEST" }]
  }
  const queries: string[] = [],
    backend = {
      runQuery: async (connectionId: string, sql: string, maximum = 2) => {
        assert.equal(connectionId, "w200")
        queries.push(sql)
        const match = /^SELECT (.+) FROM (\w+) WHERE (.+)$/.exec(sql)!
        assert.match(match[3]!, /^(TCODE = 'OB28'|TABNAME = 'V_ORV_TEST')$/)
        assert.equal(maximum, match[2] === "TVIMF" ? 65 : 2)
        return rows[match[2]!]!.map((row) =>
          Object.fromEntries(match[1]!.split(", ").map((field) => [field, row[field] ?? ""]))
        )
      },
      callRemoteFunction: async () => assert.fail("No maintenance, parser or RFC command")
    },
    readers = {
      table: async (objectName: string) => {
        const pin =
          configurationBteRouteLayouts[objectName as keyof typeof configurationBteRouteLayouts]
        return {
          connectionId: "w200",
          objectName,
          objectKind: "transparentTable",
          active: true,
          fingerprint: String(pin.fingerprint),
          definition: {
            tableClass: "TRANSP",
            fields: pin.fields.map((name) => ({
              name,
              key: (pin.keys as readonly string[]).includes(name)
            }))
          }
        }
      },
      definition: async (functionName: string) => {
        assert.equal(functionName, configurationBteProductApi.functionName)
        return {
          connectionId: "w200",
          functionName,
          functionGroup: configurationBteProductApi.functionGroup,
          remoteEnabled: false,
          updateTask: false,
          sourceFingerprint: configurationBteProductApi.source,
          interfaceFingerprint: configurationBteProductApi.interface
        }
      }
    }
  return { rows, queries, backend, readers }
}
const inspect = (value: ReturnType<typeof fixture>) =>
  inspectConfigurationFiActivationRoute(
    { connectionId: "w200" },
    "200",
    value.backend,
    value.readers
  )

test("FI route recognises only exact data parameters and refuses alternate commands or extra fields", () => {
  assert.deepEqual(resolveFiActivationParameters("/*SM30 VIEWNAME=V_ORV_TEST;UPDATE=X;"), {
    transaction: "SM30",
    viewName: "V_ORV_TEST",
    mode: "update"
  })
  for (const value of [
    "/*SE16 VIEWNAME=V_ORV_TEST;UPDATE=X;",
    "/*SM30 VIEWNAME=V_ORV_TEST;UPDATE=;",
    "/*SM30 VIEWNAME=V_ORV_TEST;UPDATE=X;UPDATE=X;",
    "/*SM30 VIEWNAME=V_ORV_TEST;UPDATE=X;EXECUTE=X;",
    "/*SM30 VIEWNAME=V_ORV_TEST;UPDATE=X;COMMAND=DELETE;",
    "/*SM30 VIEWNAME=V_ORV_TEST';UPDATE=X;",
    ""
  ])
    assert.equal(resolveFiActivationParameters(value), null)
})

test("FI route rechecks fixed OB28 metadata and never promotes a function group to a write route", async () => {
  const value = fixture(),
    result = await inspect(value)
  assert.equal(value.queries.length, 8)
  assert.equal(result.status, "maintenance_route_candidate")
  assert.equal(result.maintenance.functionGroup, "ZTEST")
  assert.equal(result.maintenance.targetTableRelationship, "not_verified")
  assert.equal(result.maintenance.generatedSourcesReviewed, false)
  assert.equal(result.standardApiCandidate.invoked, false)
  assert.equal(result.saveAvailable, false)
  assert.equal(result.writeAvailable, false)
  assert.equal(result.automaticRetry, false)
  assert.equal(result.coverage.atomicSnapshot, false)
  assert.match(result.readFingerprint, /^[a-f0-9]{64}$/)
  // The dedicated observer must not widen either public generic table reader's allowlist.
  assert.throws(() => assertTableAllowed("TSTCP"))
  assert.throws(() => assertTableAllowed("TVDIR"))
})

test("FI route unknown parameters never trigger directory, event or guessed generated-source reads", async () => {
  const value = fixture()
  value.rows.TSTCP![0]!.PARAM = "/*GGB0 OTHER=X;"
  const result = await inspect(value)
  assert.equal(value.queries.length, 4)
  assert.equal(result.transaction.recognised, null)
  assert.equal(result.maintenance.directory, null)
  assert.equal(result.maintenance.events, null)
  assert.equal(result.status, "maintenance_route_unconfirmed")
  assert.equal(result.saveAvailable, false)
})

test("FI route refuses row/metadata drift, truncation and wrong keys without confirmation or retries", async () => {
  for (const mode of ["wrong_key", "duplicate", "truncated", "changed", "401"]) {
    const value = fixture(),
      query = value.backend.runQuery
    let eventReads = 0
    value.backend.runQuery = async (connectionId, sql, maximum) => {
      if (sql.includes("FROM TVIMF ")) {
        eventReads++
        if (mode === "401") throw Error("SAP HTTP 401")
        if (mode === "truncated")
          return Array.from({ length: 65 }, (_, i) => ({
            TABNAME: "V_ORV_TEST",
            EVENT: String(i),
            FORMNAME: "F"
          }))
        if (mode === "wrong_key") return [{ TABNAME: "OTHER", EVENT: "01", FORMNAME: "F" }]
        if (mode === "duplicate") return [value.rows.TVIMF![0]!, value.rows.TVIMF![0]!]
        if (mode === "changed" && eventReads === 2) value.rows.TVIMF![0]!.FORMNAME = "OTHER"
      }
      return query(connectionId, sql, maximum)
    }
    await assert.rejects(inspect(value), /FI_ACTIVATION_ROUTE_/)
    assert.equal(eventReads, mode === "changed" ? 2 : 1)
  }
  const value = fixture(),
    table = value.readers.table
  let metadata = 0
  value.readers.table = async (name) => ({
    ...(await table(name)),
    fingerprint:
      ++metadata > 4
        ? "changed"
        : configurationBteRouteLayouts[name as keyof typeof configurationBteRouteLayouts]
            .fingerprint
  })
  await assert.rejects(inspect(value), /LAYOUT_UNVERIFIED/)
})

test("FI route rejects arbitrary selectors and other clients before SAP access", async () => {
  const value = fixture()
  for (const input of [
    { connectionId: "w300" },
    { connectionId: "w200", transaction: "OBBH" },
    { connectionId: "w200", viewName: "USR02" },
    { connectionId: "w200", save: true }
  ])
    assert.equal(configurationFiActivationRouteSchema.safeParse(input).success, false)
  await assert.rejects(
    inspectConfigurationFiActivationRoute(
      { connectionId: "w200" },
      "300",
      value.backend,
      value.readers
    ),
    /SCOPE_UNSUPPORTED/
  )
  assert.equal(value.queries.length, 0)
})

test("FI route public MCP dispatch reads only its derived metadata and rejects caller-selected targets", async (t) => {
  const value = fixture(),
    root = await mkdtemp(join(tmpdir(), "orvanta-fi-route-")),
    backend = new MockBackend(),
    oldTable = ToolService.prototype.readDdicTransparentTable,
    oldDefinition = ToolService.prototype.readFunctionModuleInterface
  backend.runQuery = value.backend.runQuery
  backend.callRemoteFunction = value.backend.callRemoteFunction
  ToolService.prototype.readDdicTransparentTable = async (input) =>
    JSON.stringify(await value.readers.table(input.objectName))
  ToolService.prototype.readFunctionModuleInterface = async (input) =>
    JSON.stringify(await value.readers.definition(input.functionName))
  const server = await startHttpServer(backend, 0, root),
    client = new Client({ name: "fi-route-read-test", version: "M2" })
  t.after(async () => {
    ToolService.prototype.readDdicTransparentTable = oldTable
    ToolService.prototype.readFunctionModuleInterface = oldDefinition
    await client.close()
    await server.closeIfIdle()
  })
  t.diagnostic(`Local MCP test receipts retained at ${root}`)
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.mcpUrl)) as Parameters<Client["connect"]>[0]
  )
  const name = "inspect_configuration_fi_activation_route",
    tool = (await client.listTools()).tools.find((entry) => entry.name === name)
  assert(tool)
  assert.equal(tool.annotations?.readOnlyHint, true)
  assert.equal(tool.inputSchema.additionalProperties, false)
  const reply = await client.callTool({ name, arguments: { connectionId: "w200" } })
  assert.equal(reply.isError, undefined)
  const result = JSON.parse((reply.content as { text: string }[])[0]!.text)
  assert.equal(result.maintenance.functionGroup, "ZTEST")
  assert.equal(result.saveAvailable, false)
  const queries = value.queries.length
  for (const patch of [{ transaction: "OBBH" }, { viewName: "USR02" }, { execute: true }])
    assert.equal(
      (await client.callTool({ name, arguments: { connectionId: "w200", ...patch } })).isError,
      true
    )
  assert.equal(value.queries.length, queries)
})
