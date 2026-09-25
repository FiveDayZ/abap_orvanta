import assert from "node:assert/strict"
import test from "node:test"
import { collectSystemParameters, SYSTEM_PARAMETERS_MAX_ROWS } from "../src/system-parameters.js"
import { collectServerFacts, reviewedServerInfoDefinition } from "../src/server-facts.js"
import { parseSapDataQueryResponse } from "../src/data-query.js"
import type { RemoteFunctionRequest, SapBackend } from "../src/backend.js"

const readerDefinition = {
  functionName: "RFC_READ_TABLE",
  remoteEnabled: true,
  updateTask: false,
  sourceFingerprint: "7b9a603493673d26f75e555616b24d150e407ce03eff57e9c68f0b30b1ba0c2d",
  interfaceFingerprint: "d06cc5c1ce05960bde526ecf27e38606134146474cc8da19f93ac2abd3e48074"
}

let emptyHtml: unknown
try {
  parseSapDataQueryResponse({ body: "", status: 200, headers: { "content-type": "text/html" } })
} catch (error) {
  emptyHtml = error
}

/** The approved tables are not in the shared mock, so this double stores rows per table. */
function double(rows: Record<string, string[][]>) {
  const requests: RemoteFunctionRequest[] = []
  const backend = {
    runQuery: async () => {
      throw emptyHtml
    },
    callRemoteFunction: async (_connection: string, request: RemoteFunctionRequest) => {
      requests.push(request)
      assert.equal(request.functionName, "RFC_READ_TABLE")
      const fields = request.inputParameters.FIELDS as { FIELDNAME: string }[]
      const table = String(request.inputParameters.QUERY_TABLE)
      return {
        outputs: {
          FIELDS: fields,
          DATA: (rows[table] ?? []).map((values) => ({ WA: values.join("|") }))
        }
      }
    }
  }
  return {
    backend: backend as unknown as Pick<SapBackend, "runQuery" | "callRemoteFunction">,
    requests
  }
}

const parameterRow = [
  "PROFILE",
  "rdisp/max_wprun_time",
  "300",
  "",
  " ",
  "Maximum work process run time",
  "",
  "",
  "SAP",
  "20250101",
  "120000"
]

test("system parameters map the approved columns and label the value column", async () => {
  const { backend, requests } = double({ TPFYPROPTY: [parameterRow], TPFHT: [] })
  const result = await collectSystemParameters(backend, "w200", {}, async () => readerDefinition)
  assert.equal(result.status, "ok")
  assert.equal(result.readOnly, true)
  assert.equal(result.rowLimit, 200)
  assert.equal(result.parameterCount, 1)
  assert.equal(result.parametersTruncated, false)
  assert.deepEqual(result.parameters[0], {
    objectName: "PROFILE",
    parameterName: "rdisp/max_wprun_time",
    value: "300",
    valueColumn: "STR",
    type: "",
    group: "",
    description: "Maximum work process run time",
    dynamic: "",
    operatingSystem: "",
    changedBy: "SAP",
    changedOn: "20250101",
    changedAt: "120000"
  })
  // The native preview failed with the observed empty HTML document, so the reviewed fallback ran for
  // both tables and nothing else did.
  assert.deepEqual(
    requests.map((request) => request.inputParameters.QUERY_TABLE),
    ["TPFYPROPTY", "TPFHT"]
  )
  assert.deepEqual(
    result.sources.map((source) => source.method),
    ["rfc_read_table", "rfc_read_table"]
  )
})

test("an over-long filter value is refused before SAP is called", async () => {
  const { backend, requests } = double({})
  await assert.rejects(
    collectSystemParameters(
      backend,
      "w200",
      { parameterName: "x".repeat(56) },
      async () => readerDefinition
    ),
    /SYSTEM_PARAMETERS_SCOPE_INVALID/
  )
  assert.equal(requests.length, 0, "the refusal must happen before any SAP call")
})

test("a bounded read reports truncation instead of a complete list", async () => {
  const rows = [parameterRow, [...parameterRow], [...parameterRow]]
  const { backend } = double({ TPFYPROPTY: rows, TPFHT: [] })
  const result = await collectSystemParameters(backend, "w200", { maxRows: 2 }, async () => ({
    ...readerDefinition
  }))
  assert.equal(result.status, "partial")
  assert.equal(result.parameterCount, 2)
  assert.equal(result.parametersTruncated, true)
})

test("the row limit is clamped to the approved allowlist ceiling", async () => {
  const { backend } = double({ TPFYPROPTY: [], TPFHT: [] })
  const result = await collectSystemParameters(backend, "w200", { maxRows: 5000 }, async () => ({
    ...readerDefinition
  }))
  assert.equal(result.rowLimit, SYSTEM_PARAMETERS_MAX_ROWS)
  assert.equal(result.rowLimitApplied, true)
})

test("an unreviewed reader is refused, and a reviewed one yields the kernel fields", async () => {
  const calls: string[] = []
  const backend = {
    callRemoteFunction: async (_connection: string, request: RemoteFunctionRequest) => {
      calls.push(request.functionName)
      return { outputs: { RFCSI_EXPORT: { RFCSYSID: "W20", RFCSAPRL: "731" } } }
    }
  } as unknown as Pick<SapBackend, "callRemoteFunction">
  const unreviewed = await collectServerFacts(backend, "w200", async () => readerDefinition)
  assert.equal(unreviewed.status, "unavailable")
  assert.equal(unreviewed.sources[0]!.code, "SERVER_FACTS_FALLBACK_UNVERIFIED")
  assert.equal(calls.length, 0, "an unreviewed function module must never be called")

  const reviewed = await collectServerFacts(backend, "w200", async () => ({
    functionName: "RFC_SYSTEM_INFO",
    remoteEnabled: true,
    updateTask: false,
    sourceFingerprint: reviewedServerInfoDefinition.shape.sourceFingerprint.value,
    interfaceFingerprint: reviewedServerInfoDefinition.shape.interfaceFingerprint.value
  }))
  assert.equal(reviewed.status, "ok")
  assert.equal(reviewed.systemId, "W20")
  assert.equal(reviewed.sapRelease, "731")
  assert.equal(reviewed.kernelRelease, "", "the mock does not report a kernel release")
  assert.deepEqual(calls, ["RFC_SYSTEM_INFO"])
  assert.match(reviewed.notes.join(" "), /RFCDATABS is returned verbatim only/)
})
