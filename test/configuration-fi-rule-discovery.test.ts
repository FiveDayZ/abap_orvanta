import assert from "node:assert/strict"
import test from "node:test"
import {
  configurationFiRuleDiscoverySchema,
  findConfigurationFiRules
} from "../src/configuration-fi-rule-discovery.js"
import { configurationFiRuleLayouts } from "../src/configuration-fi-rule.js"
import {
  NATIVE_PREVIEW_EMPTY_HTML,
  reviewedTableReaderDefinition
} from "../src/reviewed-table-reader.js"
import { ToolService } from "../src/tools.js"
import { toolContracts } from "../src/contracts.js"
import { toolNamesForProfile } from "../src/tool-registry.js"
import { MockBackend } from "./mock-backend.js"

const input = { connectionId: "w200", maxRules: 2 }
const row = (VALID = "ZRULE", BOOLCLASS = "001") => ({ MANDT: "200", VALID, BOOLCLASS })
const table = () => ({
  connectionId: "w200",
  objectName: "GB93",
  objectKind: "transparentTable",
  active: true,
  fingerprint: configurationFiRuleLayouts.GB93
})
const noRfc = async () => {
  throw Error("Unexpected RFC execution")
}
const find = (query: () => Promise<Record<string, string>[]>) =>
  findConfigurationFiRules(
    input,
    "200",
    {
      runQuery: async (connectionId, sql, maximum) => {
        assert.equal(connectionId, "w200")
        assert.equal(sql, "SELECT MANDT, VALID, BOOLCLASS FROM GB93 WHERE MANDT = '200'")
        assert.equal(maximum, 3)
        return query()
      },
      callRemoteFunction: noRfc
    },
    async () => table(),
    noRfc
  )

test("FI discovery rechecks fixed client header identities without confusing row order with drift", async () => {
  let reads = 0
  const result = await find(async () =>
    ++reads === 1 ? [row("ZB"), row("ZA")] : [row("ZA"), row("ZB")]
  )
  assert.equal(reads, 2)
  assert.equal(result.status, "candidates")
  assert.deepEqual(
    result.candidates?.map((candidate) => candidate.ruleName),
    ["ZA", "ZB"]
  )
  assert(result.candidates?.every((candidate) => candidate.exactReadRequired))
  assert(result.readFingerprint)
  assert.equal(result.coverage.selectedHeaderProjectionComplete, true)
  assert.equal(result.coverage.formulas, "not_read")
  assert.equal(result.coverage.organizationAssignment, "not_read")
  assert.equal(result.saveAvailable, false)
  assert.equal(result.coverage.complete, false)
})

test("FI discovery preserves exact SAP names and flags names the exact-rule reader cannot accept", async () => {
  const result = await find(async () => [row("#RULE")])
  assert.equal(result.candidates?.[0]?.ruleName, "#RULE")
  assert.equal(result.candidates?.[0]?.exactReadSupported, false)
})

test("FI discovery distinguishes a confirmed empty result from first or confirmation read failure", async () => {
  const empty = await find(async () => [])
  assert.equal(empty.status, "no_selected_records")
  assert.deepEqual(empty.candidates, [])
  assert(empty.readFingerprint)
  const denied = await find(async () => {
    throw Error("HTTP 403")
  })
  assert.equal(denied.status, "unavailable")
  assert.equal(denied.candidates, null)
  assert.equal(denied.readFingerprint, null)
  let calls = 0
  const recheckFailed = await find(async () => {
    if (++calls === 2) throw Error("HTTP 403")
    return [row()]
  })
  assert.equal(recheckFailed.status, "unavailable")
  assert.equal(recheckFailed.candidates, null)
})

test("FI discovery never gives a truncated visible prefix a complete fingerprint", async () => {
  const bothTruncated = await find(async () => [row("ZA"), row("ZB"), row("ZC")])
  assert.equal(bothTruncated.status, "partial")
  assert.equal(bothTruncated.coverage.truncated, true)
  assert.equal(bothTruncated.coverage.selectedHeaderProjectionComplete, false)
  assert.equal(bothTruncated.readFingerprint, null)
  assert.equal(bothTruncated.candidates?.length, 2)
  let calls = 0
  const confirmationTruncated = await find(async () =>
    ++calls === 1 ? [row("ZA"), row("ZB")] : [row("ZA"), row("ZB"), row("ZC")]
  )
  assert.equal(confirmationTruncated.status, "partial")
  assert.equal(confirmationTruncated.readFingerprint, null)
  assert.equal(confirmationTruncated.coverage.selectedHeaderProjectionComplete, false)
})

test("FI discovery withdraws the whole candidate set on a changed name or boolean class", async () => {
  for (const changedRow of [row("OTHER"), row("ZRULE", "002")]) {
    let calls = 0
    const result = await find(async () => [++calls === 1 ? row() : changedRow])
    assert.equal(result.status, "changed")
    assert.equal(result.candidates, null)
    assert.equal(result.readFingerprint, null)
  }
})

test("FI discovery rejects duplicate keys, invalid identities and rows from another client", async () => {
  for (const rows of [[row(), row()], [row("")], [row("TOO_LONG")], [{ ...row(), MANDT: "300" }]]) {
    const result = await find(async () => rows)
    assert.equal(result.status, "unavailable")
    assert.equal(result.candidates, null)
    assert(result.evidence.sources[0]?.code)
  }
})

test("FI discovery refuses unsupported scope and layout drift before exposing values", async () => {
  const backend = { runQuery: noRfc, callRemoteFunction: noRfc }
  for (const [connectionId, client] of [
    ["w300", "200"],
    ["w200", "300"]
  ] as const)
    await assert.rejects(
      findConfigurationFiRules({ ...input, connectionId }, client, backend, noRfc, noRfc),
      /FI_RULE_DISCOVERY_SCOPE_UNSUPPORTED/
    )
  await assert.rejects(
    findConfigurationFiRules(
      input,
      "200",
      backend,
      async () => ({ ...table(), active: false }),
      noRfc
    ),
    /FI_RULE_DISCOVERY_LAYOUT_UNVERIFIED/
  )
  let definitions = 0
  await assert.rejects(
    findConfigurationFiRules(
      input,
      "200",
      { runQuery: async () => [row()], callRemoteFunction: noRfc },
      async () => ({
        ...table(),
        fingerprint: ++definitions === 1 ? table().fingerprint : "changed"
      }),
      noRfc
    ),
    /FI_RULE_DISCOVERY_LAYOUT_UNVERIFIED/
  )
  for (const invalid of [
    { ...input, table: "USR02" },
    { ...input, fields: ["PASSWORD"] },
    { ...input, maxRules: 1 },
    { ...input, maxRules: 101 }
  ])
    assert.equal(configurationFiRuleDiscoverySchema.safeParse(invalid).success, false)
})

test("FI discovery fallback uses only the pinned reader and fixed table/client selection", async () => {
  let calls = 0
  const definition = {
    functionName: "RFC_READ_TABLE",
    remoteEnabled: true,
    updateTask: false,
    sourceFingerprint: "7b9a603493673d26f75e555616b24d150e407ce03eff57e9c68f0b30b1ba0c2d",
    interfaceFingerprint: "d06cc5c1ce05960bde526ecf27e38606134146474cc8da19f93ac2abd3e48074"
  }
  assert(reviewedTableReaderDefinition.safeParse(definition).success)
  const result = await findConfigurationFiRules(
    input,
    "200",
    {
      runQuery: async () => {
        throw Error(NATIVE_PREVIEW_EMPTY_HTML)
      },
      callRemoteFunction: async (_id, request) => {
        calls++
        assert.equal(request.functionName, "RFC_READ_TABLE")
        assert.equal(request.inputParameters.QUERY_TABLE, "GB93")
        assert.equal(request.inputParameters.ROWCOUNT, "3")
        assert.deepEqual(request.inputParameters.OPTIONS, [{ TEXT: "MANDT = '200'" }])
        return {
          outputs: {
            FIELDS: ["MANDT", "VALID", "BOOLCLASS"].map((FIELDNAME) => ({ FIELDNAME })),
            DATA: [{ WA: "200|ZRULE|001" }]
          }
        }
      }
    },
    async () => table(),
    async () => definition
  )
  assert.equal(calls, 2)
  assert.equal(result.status, "candidates")
  assert(result.evidence.sources.every((source) => source.method === "rfc_read_table"))
  let forbiddenCall = false
  const refused = await findConfigurationFiRules(
    input,
    "200",
    {
      runQuery: async () => {
        throw Error(NATIVE_PREVIEW_EMPTY_HTML)
      },
      callRemoteFunction: async () => {
        forbiddenCall = true
        return { outputs: {} }
      }
    },
    async () => table(),
    async () => ({ ...definition, sourceFingerprint: "changed" })
  )
  assert.equal(forbiddenCall, false)
  assert.equal(refused.status, "unavailable")
  assert.equal(refused.evidence.sources[0]?.code, "FI_RULE_DISCOVERY_FALLBACK_UNVERIFIED")
})

test("FI discovery public service returns candidates with read-only contract and configuration profiles", async () => {
  const backend = new MockBackend()
  backend.runQuery = async () => [row()]
  backend.callRemoteFunction = noRfc
  const service = new ToolService(backend)
  service.readDdicTransparentTable = async () => JSON.stringify(table())
  const result = JSON.parse(await service.findConfigurationFiRules(input))
  assert.equal(result.candidates[0].ruleName, "ZRULE")
  assert.equal(result.saveAvailable, false)
  assert.equal(backend.lastHelperRequest, undefined)
  assert.equal(toolContracts.find_configuration_fi_rules.annotations.readOnlyHint, true)
  for (const profile of ["config", "readonly"] as const)
    assert(toolNamesForProfile(profile).includes("find_configuration_fi_rules"))
})
