import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  configurationFiActivationPreviewSchema,
  previewConfigurationFiActivation
} from "../src/configuration-fi-activation-preview.js"
import {
  configurationFiActivationDomain,
  configurationFiRuleFields,
  configurationFiRuleLayouts,
  configurationFiRuleSchema,
  readConfigurationFiRule
} from "../src/configuration-fi-rule.js"
import { startHttpServer } from "../src/http.js"
import { ToolService } from "../src/tools.js"
import { toolNamesForProfile } from "../src/tool-registry.js"
import { MockBackend } from "./mock-backend.js"

const readInput = configurationFiRuleSchema.parse({
  connectionId: "w200",
  kind: "fi_validation",
  ruleName: "ZRULE",
  companyCode: "1000",
  applicationArea: "FI",
  callupPoint: "0002"
})
type Table = keyof typeof configurationFiRuleFields
const noNative = async () => assert.fail("No native function, writer or parser invocation")
const row = (table: Table, extra: Record<string, string> = {}) => ({
  ...Object.fromEntries(configurationFiRuleFields[table].map((field) => [field, ""])),
  MANDT: "200",
  VALID: "ZRULE",
  BUKRS: "1000",
  EVENT: "0002",
  VALUSER: "FI",
  VALEVENT: "0002",
  BOOLCLASS: "009",
  RCLASS: "009",
  VALSEQNR: "001",
  ACTIV: "1",
  ...extra
})
function reader(
  query: (table: Table) => Promise<Record<string, string>[]> = async (table) => [row(table)]
) {
  const requests: unknown[] = []
  return {
    requests,
    read: async (input: typeof readInput) => {
      requests.push(input)
      return readConfigurationFiRule(
        input,
        "200",
        {
          runQuery: async (_id, sql, maximum) => {
            const match = /^SELECT (.+) FROM (\w+)/.exec(sql)!
            assert(["GB93", "GB931", "T001D", "GB31"].includes(match[2]!))
            assert.equal(maximum, match[2] === "GB931" ? 51 : 2)
            const rows = await query(match[2] as Table)
            return rows.map((value) =>
              Object.fromEntries(match[1]!.split(", ").map((field) => [field, value[field]!]))
            )
          },
          callRemoteFunction: noNative
        },
        async (objectName) => ({
          connectionId: "w200",
          objectName,
          objectKind: "transparentTable",
          fingerprint:
            configurationFiRuleLayouts[objectName as keyof typeof configurationFiRuleLayouts]
        }),
        async () => ({
          connectionId: "w200",
          objectName: "GVSACTIV",
          objectKind: "domain",
          fingerprint: configurationFiActivationDomain
        }),
        noNative
      )
    }
  }
}
const inputFor = (fingerprint: string) => ({
  connectionId: "w200",
  ruleName: "ZRULE",
  companyCode: "1000",
  applicationArea: "FI",
  callupPoint: "0002",
  expectedReadFingerprint: fingerprint,
  activationLevel: "2"
})

test("FI activation preview binds a fresh read and changes only ACTIV without write admission", async () => {
  const fixture = reader(),
    current = await fixture.read(readInput),
    input = inputFor(current.readFingerprint!),
    result = await previewConfigurationFiActivation(input, "200", fixture.read)
  assert.equal(result.status, "previewed")
  assert.equal(result.previewAvailable, true)
  assert.equal(result.before?.VALID, "ZRULE")
  assert.deepEqual(result.after, { ...result.before, ACTIV: "2" })
  assert.deepEqual(result.changes, [
    {
      table: "T001D",
      key: { MANDT: "200", BUKRS: "1000", EVENT: "0002" },
      field: "ACTIV",
      before: "1",
      after: "2"
    }
  ])
  assert.equal(result.levelMeaning?.after, "active_except_batch_input")
  assert.match(result.previewFingerprint!, /^[a-f0-9]{64}$/)
  assert.equal(result.saveAvailable, false)
  assert.equal(result.executionPreflight.writeAvailable, false)
  for (const blocker of current.executionPreflight.blockers)
    assert(result.executionPreflight.blockers.includes(blocker))
  assert.equal(result.recovery.available, false)
  assert.equal(result.recovery.ctsBeforeState, "not_read")
  assert.deepEqual(result.recovery.beforeAssignment, result.before)
  assert.deepEqual(fixture.requests, [readInput, readInput])
  const noop = await previewConfigurationFiActivation(
    { ...input, activationLevel: "1" },
    "200",
    fixture.read
  )
  assert.deepEqual(noop.changes, [])
  assert.equal(noop.saveAvailable, false)
  assert.notEqual(noop.previewFingerprint, result.previewFingerprint)
})

test("FI activation preview retracts stale plans and never treats a preview as a native version", async () => {
  let level = "1"
  const fixture = reader(async (table) => [row(table, table === "T001D" ? { ACTIV: level } : {})]),
    current = await fixture.read(readInput)
  level = "2"
  const result = await previewConfigurationFiActivation(
    inputFor(current.readFingerprint!),
    "200",
    fixture.read
  )
  assert.equal(result.status, "blocked")
  assert(result.blockers.includes("FI_ACTIVATION_READ_STALE"))
  assert.equal(result.before, null)
  assert.equal(result.after, null)
  assert.equal(result.changes, null)
  assert.equal(result.previewFingerprint, null)
  assert.equal(result.recovery.beforeAssignment, null)
})

test("FI activation preview refuses missing rule/steps/assignment and another assigned rule or class", async () => {
  for (const missingTable of ["GB93", "GB931", "T001D", "GB31"]) {
    const fixture = reader(async (table) => (table === missingTable ? [] : [row(table)])),
      current = await fixture.read(readInput),
      result = await previewConfigurationFiActivation(
        inputFor(current.readFingerprint!),
        "200",
        fixture.read
      )
    assert.equal(result.previewAvailable, false, missingTable)
    assert.equal(result.changes, null)
    assert.equal(result.previewFingerprint, null)
  }
  for (const [tableName, patch] of [
    ["T001D", { VALID: "OTHER" }],
    ["T001D", { ACTIV: "9" }],
    ["GB31", { RCLASS: "008" }]
  ] as const) {
    const fixture = reader(async (table) => [row(table, table === tableName ? patch : {})]),
      current = await fixture.read(readInput),
      result = await previewConfigurationFiActivation(
        inputFor(current.readFingerprint!),
        "200",
        fixture.read
      )
    assert.equal(result.status, "blocked")
    assert.equal(result.before, null)
    assert.equal(result.executionPreflight.writeAvailable, false)
  }
})

test("FI activation preview refuses failed, drifting and first/confirmation truncated reads", async () => {
  const expected = (await reader().read(readInput)).readFingerprint!
  for (const mode of ["failed", "changed", "first_truncated", "second_truncated"]) {
    let stepReads = 0,
      assignmentReads = 0
    const fixture = reader(async (table) => {
      if (table === "T001D") {
        assignmentReads++
        if (mode === "failed") throw Error("HTTP 403")
        if (mode === "changed" && assignmentReads > 1) return [row(table, { ACTIV: "2" })]
      }
      if (table === "GB931") {
        stepReads++
        if (mode === "first_truncated" || (mode === "second_truncated" && stepReads > 1))
          return Array.from({ length: 51 }, (_, index) =>
            row(table, { VALSEQNR: String(index + 1).padStart(3, "0") })
          )
      }
      return [row(table)]
    })
    const result = await previewConfigurationFiActivation(inputFor(expected), "200", fixture.read)
    assert.equal(result.status, "blocked", mode)
    assert.equal(result.previewFingerprint, null)
    assert.equal(result.changes, null)
    assert.equal(result.recovery.beforeAssignment, null)
    assert.equal(result.saveAvailable, false)
  }
})

test("FI activation input rejects extra writes, arbitrary scopes and missing/stale-shaped fingerprints before reads", async () => {
  const valid = inputFor("a".repeat(64))
  for (const patch of [
    { connectionId: "w300" },
    { kind: "fi_substitution" },
    { applicationArea: "CO" },
    { activationLevel: "X" },
    { expectedReadFingerprint: "old" },
    { expectedReadFingerprint: undefined },
    { save: true },
    { acknowledgeConfigurationWrite: true },
    { table: "T001Q" },
    { requestNumber: "ABCK000001" },
    { formula: "TRUE" }
  ])
    await assert.rejects(previewConfigurationFiActivation({ ...valid, ...patch }, "200", noNative))
  await assert.rejects(previewConfigurationFiActivation(valid, "300", noNative), /SCOPE/)
  assert.equal(configurationFiActivationPreviewSchema.safeParse(valid).success, true)
  await assert.rejects(
    previewConfigurationFiActivation(valid, "200", async () => ({
      ...(await reader().read(readInput)),
      companyCode: "2000"
    })),
    /READ_SCOPE_CHANGED/
  )
})

test("FI activation preview is callable through the public MCP SDK and rejects invalid input before dispatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-fi-activation-preview-")),
    fixture = reader(),
    current = await fixture.read(readInput),
    input = inputFor(current.readFingerprint!),
    oldRead = ToolService.prototype.readConfigurationFiRule,
    backend = new MockBackend()
  backend.callRemoteFunction = noNative
  backend.runQuery = noNative
  ToolService.prototype.readConfigurationFiRule = async (raw) =>
    JSON.stringify(await fixture.read(configurationFiRuleSchema.parse(raw)))
  const server = await startHttpServer(backend, 0, root),
    client = new Client({ name: "fi-activation-preview-test", version: "M2" })
  t.after(async () => {
    ToolService.prototype.readConfigurationFiRule = oldRead
    await client.close()
    await server.closeIfIdle()
  })
  t.diagnostic(`Local MCP test receipts retained at ${root}`)
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.mcpUrl)) as Parameters<Client["connect"]>[0]
  )
  const name = "preview_configuration_fi_activation",
    tool = (await client.listTools()).tools.find((candidate) => candidate.name === name)
  assert(tool)
  assert.equal(tool.annotations?.readOnlyHint, true)
  assert.equal(tool.annotations?.destructiveHint, false)
  assert.equal(tool.inputSchema.additionalProperties, false)
  assert(toolNamesForProfile("config").includes(name))
  assert(toolNamesForProfile("readonly").includes(name))
  const reply = await client.callTool({ name, arguments: input })
  assert.equal(reply.isError, undefined)
  const value = JSON.parse((reply.content as { text: string }[])[0]!.text)
  assert.equal(value.status, "previewed")
  assert.equal(value.saveAvailable, false)
  assert.equal(value.executionPreflight.writeAvailable, false)
  const calls = fixture.requests.length
  for (const patch of [
    { save: true },
    { connectionId: "w300" },
    { expectedReadFingerprint: "old" },
    { activationLevel: "3" }
  ])
    assert.equal((await client.callTool({ name, arguments: { ...input, ...patch } })).isError, true)
  assert.equal(fixture.requests.length, calls)
  const stale = await client.callTool({
    name,
    arguments: { ...input, expectedReadFingerprint: "b".repeat(64) }
  })
  assert.equal(stale.isError, undefined)
  assert.equal(JSON.parse((stale.content as { text: string }[])[0]!.text).status, "blocked")
})
