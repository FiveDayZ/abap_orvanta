import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { parseRemoteFunctionResponse } from "../dist/src/adt-backend.js"
import { searchApplicationLogsSchema } from "../dist/src/application-logs.js"

const client = new Client({ name: "application-log-readonly-acceptance", version: "1" })
const startedAt = new Date().toISOString()
const evidence = { startedAt, readOnly: true, businessWrites: 0, cases: [], dedicatedCases: [] }
const { values } = parseArgs({
  options: {
    object: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    discover: { type: "boolean", default: false }
  }
})
if ((values.object || values.from || values.to) && !(values.object && values.from && values.to))
  throw new Error("Provide --object, --from and --to together for an existing log sample")
let sampleScope = values.object
  ? searchApplicationLogsSchema.parse({
      connectionId: "w200",
      object: values.object,
      fromSystemTime: values.from,
      toSystemTime: values.to,
      maxResults: 4
    })
  : undefined
async function call(name, args) {
  const result = await client.callTool({ name, arguments: { connectionId: "w200", ...args } })
  if (result.isError) throw new Error(result.content.find((part) => part.type === "text")?.text)
  return JSON.parse(result.content.find((part) => part.type === "text").text)
}
try {
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:4847/mcp")))
  evidence.server = client.getServerVersion()
  const legacy = evidence.server.version === "0.36.8"
  evidence.transportMode = legacy ? "legacy-numeric-entity-observation" : "decoded-json"
  const definition = await call("read_function_module_interface", {
    functionName: "Z_ORVANTA_LOG_READ"
  })
  assert.equal(definition.functionGroup, "ZORVANTA_LOG")
  assert.equal(definition.remoteEnabled, true)
  assert.equal(definition.updateTask, false)
  const source = definition.source.join("\n")
  assert.doesNotMatch(
    source,
    /^\s*(?:COMMIT|ROLLBACK|UPDATE|INSERT|MODIFY|CALL BADI|GET BADI|CREATE OBJECT)\b/im
  )
  assert.doesNotMatch(source, /BAL_DB_LOAD|BAL_DB_SAVE|BAL_LOG_REFRESH/i)
  assert.match(source, /UP TO lv_fetch ROWS/)
  assert.match(source, /ORDER BY lognumber/)
  evidence.definition = {
    sourceFingerprint: definition.sourceFingerprint,
    interfaceFingerprint: definition.interfaceFingerprint,
    lineCount: definition.source.length
  }
  const base = {
    version: "1",
    action: "SEARCH",
    client: "200",
    authenticatedUser: "WYS",
    readOnly: true
  }
  const unsupported = {
    ...base,
    status: "unsupported",
    code: "READ_ONLY_UNSUPPORTED",
    headers: [],
    messages: [],
    hasMore: false
  }
  const search = {
    IV_ACTION: "SEARCH",
    IV_OBJECT: "ORVANTA",
    IV_FROM: "2026-09-08T00:00:00",
    IV_TO: "2026-09-08T00:00:01"
  }
  const cases = [
    ["read-disabled", { IV_ACTION: "READ" }, { ...unsupported, action: "READ" }],
    ["zero-limit", { ...search, IV_LIMIT: "0" }, unsupported],
    ["over-limit", { ...search, IV_LIMIT: "51" }, unsupported],
    ["invalid-limit", { ...search, IV_LIMIT: "X" }, unsupported],
    ["invalid-date", { ...search, IV_FROM: "2026-02-30T00:00:00" }, unsupported],
    ["invalid-time", { ...search, IV_FROM: "2026-09-08T24:00:00" }, unsupported],
    ["partial-time", { ...search, IV_TO: "" }, unsupported],
    ["reversed-time", { ...search, IV_FROM: "2026-09-08T00:00:02" }, unsupported],
    ["over-24h", { ...search, IV_FROM: "2026-09-07T00:00:00" }, unsupported],
    ["wildcard", { ...search, IV_OBJECT: "*" }, unsupported],
    ["invalid-cursor", { ...search, IV_AFTER_LOG: "1" }, unsupported],
    ...["2026-09-08T00:00:00", "2026-09-07T00:00:01"].map((from) => [
      from.startsWith("2026-09-07") ? "exact-24h-empty" : "empty-search",
      { ...search, IV_FROM: from },
      {
        ...base,
        status: "ok",
        code: "OK",
        headers: [],
        messages: [],
        hasMore: false,
        fromSystemTime: from,
        toSystemTime: search.IV_TO
      }
    ])
  ]
  if (source.includes("iv_action = 'DISCOVER'")) {
    for (const [label, input] of [
      ["zero-limit", { IV_LIMIT: "0" }],
      ["over-limit", { IV_LIMIT: "21" }],
      ["invalid-limit", { IV_LIMIT: "X" }],
      ["object", { IV_OBJECT: "*" }],
      ["time", { IV_FROM: search.IV_FROM }],
      ["cursor", { IV_AFTER_LOG: "00000000000000000001" }],
      ["message", { IV_AFTER_MSG: "1" }],
      ["user", { IV_USER: "WYS" }],
      ["external", { IV_EXTERNAL: "TEST" }]
    ]) {
      cases.push([
        `discover-reject-${label}`,
        { IV_ACTION: "DISCOVER", ...input },
        { ...unsupported, action: "DISCOVER" }
      ])
    }
  }
  for (const [label, inputParameters, expected] of cases) {
    // Observe the old parser explicitly; this is not a claim that it returns usable JSON.
    const json = JSON.stringify(expected)
    const output = legacy ? json.replaceAll('"', "&#34;") : json
    const result = await call("test_remote_function_module", {
      functionName: "Z_ORVANTA_LOG_READ",
      inputParameters,
      expectedOutputs: { EV_RESULT: output },
      acknowledgePotentialSideEffects: true,
      operationId: `slg1-${Date.now()}-${label}`
    })
    assert.equal(result.status, "passed")
    const actual = result.outputs.EV_RESULT
    const decoded = legacy
      ? parseRemoteFunctionResponse(`<r><EV_RESULT>${actual}</EV_RESULT></r>`, [
          { name: "EV_RESULT", kind: "scalar" }
        ]).outputs.EV_RESULT
      : actual
    assert.deepEqual(JSON.parse(decoded), expected)
    evidence.cases.push({
      label,
      inputParameters,
      decodedOutput: JSON.parse(decoded),
      receiptHash: result.operationReceipt.receiptHash,
      status: "passed"
    })
  }
  const available = new Set((await client.listTools()).tools.map((tool) => tool.name))
  if (values.discover) {
    assert.ok(available.has("discover_application_logs"), "Running service lacks discovery tool")
    const discovery = await call("discover_application_logs", { maxResults: 20 })
    assert.equal(discovery.status, "ok")
    assert.equal(discovery.sampled, true)
    assert.ok(discovery.returnedCount <= 20)
    assert.equal(discovery.returnedCount, discovery.samples.length)
    let previous
    for (const sample of discovery.samples) {
      assert.deepEqual(Object.keys(sample).sort(), [
        "logNumber",
        "object",
        "subobject",
        "systemTime"
      ])
      if (previous) assert.ok(sample.logNumber < previous)
      previous = sample.logNumber
    }
    evidence.discovery = discovery
    if (!sampleScope && discovery.samples.length) {
      const sample = discovery.samples[0]
      const day = sample.systemTime.slice(0, 10)
      sampleScope = searchApplicationLogsSchema.parse({
        connectionId: "w200",
        object: sample.object,
        ...(sample.subobject ? { subobject: sample.subobject } : {}),
        fromSystemTime: `${day}T00:00:00`,
        toSystemTime: `${day}T23:59:59`,
        maxResults: 4
      })
    }
  }
  if (available.has("search_application_logs") && available.has("read_application_log")) {
    const scope = {
      object: search.IV_OBJECT,
      fromSystemTime: search.IV_FROM,
      toSystemTime: search.IV_TO,
      maxResults: 1
    }
    const empty = await call("search_application_logs", scope)
    assert.equal(empty.status, "ok")
    assert.deepEqual(empty.headers, [])
    assert.equal(empty.returnedCount, 0)
    assert.equal(empty.hasMore, false)
    assert.equal(empty.fromSystemTime, scope.fromSystemTime)
    assert.equal(empty.toSystemTime, scope.toSystemTime)
    evidence.dedicatedCases.push({ label: "empty-search", status: "passed", output: empty })
    const recent = await call("search_application_logs", { object: "ORVANTA", maxResults: 1 })
    assert.equal(recent.status, "ok")
    assert.equal(recent.readOnly, true)
    assert.equal(
      Date.parse(`${recent.toSystemTime}Z`) - Date.parse(`${recent.fromSystemTime}Z`),
      86400000
    )
    evidence.dedicatedCases.push({ label: "sap-default-24h", status: "passed", output: recent })
    const disabled = await call("read_application_log", { logNumber: "00000000000000000000" })
    assert.equal(disabled.status, "unavailable")
    assert.equal(disabled.code, "MESSAGE_READ_NOT_APPROVED")
    evidence.dedicatedCases.push({ label: "message-gate", status: "passed", output: disabled })
    for (const [label, changes] of [
      ["wildcard", { object: "*" }],
      ["zero-limit", { maxResults: 0 }],
      ["over-limit", { maxResults: 51 }],
      ["partial-time", { toSystemTime: undefined }],
      ["over-24h", { fromSystemTime: "2026-09-07T00:00:00" }],
      ["invalid-date", { fromSystemTime: "2026-02-30T00:00:00" }],
      ["invalid-cursor", { afterLogNumber: "1" }]
    ]) {
      const result = await client.callTool({
        name: "search_application_logs",
        arguments: { connectionId: "w200", ...scope, ...changes }
      })
      assert.equal(result.isError, true, `Dedicated route accepted ${label}`)
      evidence.dedicatedCases.push({ label, status: "passed" })
    }
    evidence.nonempty = { status: "not_run", reason: "Existing log object and time range required" }
    if (sampleScope) {
      const first = await call("search_application_logs", sampleScope)
      assert.equal(first.status, "ok")
      assert.equal(first.returnedCount, first.headers.length)
      evidence.nonempty = {
        scope: sampleScope,
        observedCount: first.headers.length,
        status: "insufficient_sample"
      }
      if (first.headers.length >= 3) {
        const pages = []
        let afterLogNumber
        for (let index = 0; index < 3; index++) {
          const page = await call("search_application_logs", {
            ...sampleScope,
            maxResults: 1,
            ...(afterLogNumber ? { afterLogNumber } : {})
          })
          assert.equal(page.status, "ok")
          assert.equal(page.returnedCount, 1)
          assert.deepEqual(page.headers, [first.headers[index]])
          if (index < 2 || first.headers.length > 3) assert.equal(page.hasMore, true)
          assert.equal(
            page.nextAfterLogNumber,
            page.hasMore ? page.headers[0].logNumber : undefined
          )
          pages.push(page.headers[0].logNumber)
          afterLogNumber = page.headers[0].logNumber
        }
        assert.equal(new Set(pages).size, 3)
        const header = first.headers[0]
        for (const key of ["subobject", "externalNumber", "username"]) {
          if (!header[key]) continue
          if (key === "externalNumber" && header[key].includes("[REDACTED]")) continue
          if (
            !searchApplicationLogsSchema.safeParse({ ...sampleScope, [key]: header[key] }).success
          )
            continue
          const filtered = await call("search_application_logs", {
            ...sampleScope,
            [key]: header[key]
          })
          assert.equal(filtered.status, "ok")
          assert.ok(filtered.headers.some((row) => row.logNumber === header.logNumber))
          assert.ok(filtered.headers.every((row) => row[key] === header[key]))
        }
        const tail = await call("search_application_logs", {
          ...sampleScope,
          afterLogNumber: "99999999999999999999"
        })
        assert.equal(tail.status, "ok")
        assert.deepEqual(tail.headers, [])
        assert.equal(tail.hasMore, false)
        evidence.nonempty.status = "pagination_and_filter_consistency_passed"
        // Store identifiers only, not external business identifiers or log text.
        evidence.nonempty.logNumbers = pages
      }
    }
  }
  evidence.status = "Partially Verified"
  evidence.remaining = [
    ...(evidence.nonempty?.status === "pagination_and_filter_consistency_passed"
      ? []
      : ["Nonempty headers and keyset pagination against existing authorized logs"]),
    "Independent SLG1 comparison; ADT data preview currently returns empty HTML",
    "Restricted SAP user and active BAdI restriction scenarios",
    ...(evidence.dedicatedCases.length ? [] : ["Dedicated MCP tools through the deployed service"]),
    "Message details remain disabled"
  ]
} catch (error) {
  evidence.status = "Failed"
  evidence.error = String(error)
  process.exitCode = 1
} finally {
  await client.close()
}
const output = new URL(
  `../../.doc/application-log-search-${startedAt.replace(/[:.]/g, "-")}.json`,
  import.meta.url
)
await writeFile(output, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" })
console.log(
  JSON.stringify({
    output: fileURLToPath(output),
    status: evidence.status,
    transportMode: evidence.transportMode,
    passed: evidence.cases.length,
    dedicatedPassed: evidence.dedicatedCases.length,
    nonempty: evidence.nonempty?.status,
    error: evidence.error
  })
)
