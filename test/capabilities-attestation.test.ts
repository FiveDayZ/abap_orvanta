import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import test from "node:test"
import { AdtBackend, parseHelperCapabilitiesPayload } from "../src/adt-backend.js"
import type { SapHelperCapabilities } from "../src/backend.js"
import { buildCapabilityReport } from "../src/capabilities.js"
import { parseConnections } from "../src/config.js"
import { MockBackend } from "./mock-backend.js"

const BASE_HELPER = "Z_ORVANTA_MCP_EXECUTE"
const REPOSITORY_HELPER = "Z_ORVANTA_MCP_DYNPRO_API"
const DDIC_HELPER = "Z_ORVANTA_MCP_DDIC_API"
const MAINTENANCE_HELPER = "Z_ORVANTA_MAINT_READ"
const OPERATIONAL_LOG_HELPER = "Z_ORVANTA_OPS_READ"
const APPLICATION_LOG_HELPER = "Z_ORVANTA_LOG_READ"
const SCI_V2_HELPER = "Z_ORVANTA_MCP_SCI_V2"
const SCI_E2_HELPER = "Z_ORVANTA_MCP_SCI_E2"

interface ReportShape {
  helpers: Array<{ name: string; availability: string; attestation?: unknown }>
  helperAttestation: SapHelperCapabilities[]
  capabilities: Array<{
    id: string
    observation: {
      availability: string
      reason: string
      evidence: { source: string; detail: string }
    }
  }>
  summary: Record<string, number>
}

async function buildReport(backend: MockBackend): Promise<ReportShape> {
  return JSON.parse(await buildCapabilityReport(backend, "w200")) as ReportShape
}

function capabilityObservation(report: ReportShape, id: string) {
  const capability = report.capabilities.find((item) => item.id === id)
  assert.ok(capability, `capability ${id} is missing from the report`)
  return capability.observation
}

const maintenanceCapability = (report: ReportShape) =>
  capabilityObservation(report, "maintenance-diagnostics")

const operationalLogCapability = (report: ReportShape) =>
  capabilityObservation(report, "operational-logs")

// The two approval-gated capability verdicts the maintenance and operational-log self-descriptions
// must not change while their helpers are un-upgraded.
const MAINTENANCE_REASON =
  "Requires separately deployed Z_ORVANTA_MAINT_READ in ZORVANTA_MAINT, matching source/interface approval and SAP display permissions. Local-only candidate: no helper deployment or live sample acceptance. No SAP unlock or update reprocessing; local receipts never prove SAP lock ownership."
const OPERATIONAL_LOG_REASON =
  "SM37 and SM21 require separately approved Z_ORVANTA_OPS_READ in ZORVANTA_LOG. Job details require SM37_DETAILS; spool text requires SP01 and the extended helper interface. The w200 spool branch has source/activation evidence but no runtime acceptance. No OTF/PDF, printing or variant values. Registration is not deployment or runtime proof."

function selfDescription(overrides: Partial<SapHelperCapabilities>): SapHelperCapabilities {
  return {
    helper: REPOSITORY_HELPER,
    minProtocol: "1.0",
    maxProtocol: "2.6",
    operations: [
      { opcode: "READ_MESSAGE_CLASS", since: "1.7", write: false },
      { opcode: "UPDATE_MESSAGE_CLASS", since: "1.8", write: true }
    ],
    scopes: [
      { scope: "SM37_DETAILS", enabled: true },
      { scope: "SP01", enabled: false }
    ],
    sourceHash: "b".repeat(64),
    packageName: "ZABAP",
    transport: "GR2K923472",
    host: "GR2/200",
    observedAt: "2026-09-17T12:00:00.000Z",
    attestation: "self-described",
    ...overrides
  }
}

test("an un-upgraded helper stays operation-scoped and keeps the previous capability wording", async () => {
  const report = await buildReport(new MockBackend())

  // Byte-for-byte equivalence with the pre-attestation report: the default mock helper does
  // not answer CAPABILITIES, exactly like the helpers installed on the target system today.
  const messageUpdate = capabilityObservation(report, "repository-helper-message-update")
  assert.equal(messageUpdate.availability, "unknown")
  assert.equal(
    messageUpdate.reason,
    "The read probe observed repository operation protocol 1.2; it does not prove whether capability version 1.8 is installed."
  )
  const dynproCore = capabilityObservation(report, "repository-helper-dynpro-core")
  assert.equal(dynproCore.availability, "available")
  assert.equal(
    dynproCore.reason,
    "The observed repository read protocol 1.2 satisfies minimum 1.1."
  )
  assert.equal(
    capabilityObservation(report, "ddic-helper-controlled-delete").availability,
    "available"
  )

  assert.deepEqual(
    report.helperAttestation.map((entry) => [entry.helper, entry.attestation]),
    [
      [BASE_HELPER, "operation-scoped"],
      [REPOSITORY_HELPER, "operation-scoped"],
      [DDIC_HELPER, "operation-scoped"],
      [MAINTENANCE_HELPER, "operation-scoped"],
      [OPERATIONAL_LOG_HELPER, "operation-scoped"],
      [APPLICATION_LOG_HELPER, "operation-scoped"],
      [SCI_V2_HELPER, "operation-scoped"],
      [SCI_E2_HELPER, "operation-scoped"]
    ]
  )
  assert.equal(report.helperAttestation.length, 8)
  assert.equal(report.helperAttestation[1]?.maxProtocol, null)
  assert.equal(report.helperAttestation[1]?.detail, undefined)
  // The JSON-payload helpers keep their unattested fallback too, and their approval-gated
  // capability verdicts are untouched by the new probes.
  assert.equal(report.helperAttestation[3]?.detail, undefined)
  assert.equal(report.helperAttestation[4]?.detail, undefined)
  assert.equal(maintenanceCapability(report).reason, MAINTENANCE_REASON)
  assert.equal(operationalLogCapability(report).reason, OPERATIONAL_LOG_REASON)
  // The bounded read-probe observations keep their previous shape.
  assert.equal("attestation" in (report.helpers[0] ?? {}), false)
  assert.equal("attestation" in (report.helpers[1] ?? {}), false)
})

test("a self-described helper at or above the required protocol is available with its source identity", async () => {
  const backend = new MockBackend()
  backend.helperCapabilities.set(REPOSITORY_HELPER, selfDescription({ maxProtocol: "2.6" }))
  const report = await buildReport(backend)

  const lifecycle = capabilityObservation(report, "repository-helper-enhancement-lifecycle")
  assert.equal(lifecycle.availability, "available")
  assert.equal(
    lifecycle.reason,
    `The ${REPOSITORY_HELPER} helper self-described protocol 2.6, which satisfies minimum 2.6.`
  )
  assert.match(lifecycle.evidence.detail, /self-described protocol 2\.6/)

  const attestation = report.helperAttestation[1]
  assert.equal(attestation?.attestation, "self-described")
  assert.equal(attestation?.sourceHash, "b".repeat(64))
  assert.equal(attestation?.packageName, "ZABAP")
  assert.equal(attestation?.transport, "GR2K923472")
  assert.equal(attestation?.host, "GR2/200")
  assert.deepEqual(attestation?.operations, [
    { opcode: "READ_MESSAGE_CLASS", since: "1.7", write: false },
    { opcode: "UPDATE_MESSAGE_CLASS", since: "1.8", write: true }
  ])
  assert.deepEqual(attestation?.scopes, [
    { scope: "SM37_DETAILS", enabled: true },
    { scope: "SP01", enabled: false }
  ])
  // An untouched helper keeps its fallback judgement.
  assert.equal(report.helperAttestation[0]?.attestation, "operation-scoped")
})

test("a self-described helper below the required protocol is unsupported instead of unknown", async () => {
  const backend = new MockBackend()
  backend.helperCapabilities.set(REPOSITORY_HELPER, selfDescription({ maxProtocol: "1.6" }))
  const report = await buildReport(backend)

  const messageUpdate = capabilityObservation(report, "repository-helper-message-update")
  assert.equal(messageUpdate.availability, "unsupported")
  assert.equal(
    messageUpdate.reason,
    `The ${REPOSITORY_HELPER} helper self-described protocol 1.6, which is below the required capability version 1.8.`
  )
  assert.equal(
    capabilityObservation(report, "repository-helper-gui-definition").availability,
    "available"
  )
  // DDIC is not probed in this delivery, so its operation-scoped judgement is unchanged.
  assert.equal(
    capabilityObservation(report, "ddic-helper-controlled-delete").availability,
    "available"
  )
})

test("an unreachable helper is absent and never fails the whole report", async () => {
  const backend = new MockBackend()
  backend.callSapRepository = async () => {
    throw new Error("Repository helper is not deployed")
  }
  backend.helperCapabilitiesUnreachable = true

  const report = await buildReport(backend)
  assert.equal(report.helperAttestation[1]?.attestation, "absent")
  assert.match(String(report.helperAttestation[1]?.detail), /CAPABILITIES/)

  const messageUpdate = capabilityObservation(report, "repository-helper-message-update")
  assert.equal(messageUpdate.availability, "unknown")
  assert.match(messageUpdate.reason, /Read-only probe failed without proving endpoint absence/)
})

test("a self-description under another helper identity is not used as evidence", async () => {
  const backend = new MockBackend()
  backend.helperCapabilities.set(
    REPOSITORY_HELPER,
    selfDescription({ helper: BASE_HELPER, maxProtocol: "2.6" })
  )
  const report = await buildReport(backend)

  const attestation = report.helperAttestation[1]
  assert.equal(attestation?.attestation, "operation-scoped")
  assert.match(String(attestation?.detail), /declared helper Z_ORVANTA_MCP_EXECUTE/)

  const lifecycle = capabilityObservation(report, "repository-helper-enhancement-lifecycle")
  assert.equal(lifecycle.availability, "unknown")
  assert.match(lifecycle.evidence.detail, /declared helper Z_ORVANTA_MCP_EXECUTE/)
})

test("the CAPABILITIES payload is parsed with pipe and percent unescaping", () => {
  const payload = parseHelperCapabilitiesPayload([
    "HELPER|Z_ORVANTA_MCP_DYNPRO_API",
    "PROTOCOL|MIN|1.0",
    "PROTOCOL|MAX|2.6",
    "OPERATION|READ_MESSAGE_CLASS|1.7|R",
    "OPERATION|UPDATE_MESSAGE_CLASS|1.8|W",
    "SCOPE|SM37_DETAILS|enabled",
    "SCOPE|SP01|disabled",
    `SOURCE|HASH|${"c".repeat(64)}`,
    "SOURCE|PACKAGE|Z%7CABAP%25X",
    "SOURCE|TRANSPORT|GR2K923472|GR2K923473",
    "RUNTIME|HOST|GR2/200",
    "RUNTIME|TIME|20260917120000|UTC",
    "FUTURE|UNKNOWN|ROW"
  ])
  assert.equal(payload.helper, "Z_ORVANTA_MCP_DYNPRO_API")
  assert.equal(payload.minProtocol, "1.0")
  assert.equal(payload.maxProtocol, "2.6")
  assert.deepEqual(payload.operations, [
    { opcode: "READ_MESSAGE_CLASS", since: "1.7", write: false },
    { opcode: "UPDATE_MESSAGE_CLASS", since: "1.8", write: true }
  ])
  assert.deepEqual(payload.scopes, [
    { scope: "SM37_DETAILS", enabled: true },
    { scope: "SP01", enabled: false }
  ])
  assert.equal(payload.packageName, "Z|ABAP%X")
  assert.equal(payload.transport, "GR2K923472")
  assert.equal(payload.transportTask, "GR2K923473")
  assert.equal(payload.host, "GR2/200")
  assert.equal(payload.runtimeTime, "20260917120000")
  assert.equal(payload.runtimeTimeZone, "UTC")
})

async function soapFixture(respond: (body: string) => string) {
  const requests: string[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8")
      requests.push(body)
      response.setHeader("Content-Type", "text/xml")
      response.end(respond(body))
    })
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address() as AddressInfo
  const config = parseConnections({
    connections: [
      {
        id: "w200",
        url: `http://127.0.0.1:${address.port}`,
        client: "200",
        language: "EN",
        username: "VALIDATION",
        passwordEnv: "ABAP_MCP_TEST_ATTESTATION",
        allowUnauthorized: false,
        remoteFunctionAllowlist: []
      }
    ]
  })
  return {
    backend: new AdtBackend(config, () => "memory-secret"),
    requests,
    close: () => new Promise<void>((done) => server.close(() => done()))
  }
}

function capabilitiesEnvelope(payloadLines: string[], status: string, code: string): string {
  const rows = payloadLines.map((line) => `<item><LINE>${line}</LINE></item>`).join("")
  return (
    `<?xml version="1.0"?>` +
    `<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soap-env:Body>` +
    `<n0:Z_ORVANTA_MCP_DYNPRO_API.Response xmlns:n0="urn:sap-com:document:sap:rfc:functions">` +
    `<EV_STATUS>${status}</EV_STATUS><EV_CODE>${code}</EV_CODE>` +
    `<EV_MESSAGE>ORVANTA helper capabilities</EV_MESSAGE><EV_VERSION>2.6</EV_VERSION>` +
    `<IT_SOURCE>${rows}</IT_SOURCE>` +
    `</n0:Z_ORVANTA_MCP_DYNPRO_API.Response></soap-env:Body></soap-env:Envelope>`
  )
}

test("the ADT probe reads the helper self-description without an expected-version parameter", async () => {
  const fixture = await soapFixture((body) =>
    capabilitiesEnvelope(
      [
        "HELPER|Z_ORVANTA_MCP_DYNPRO_API",
        "PROTOCOL|MIN|1.0",
        "PROTOCOL|MAX|2.6",
        "SOURCE|HASH|" + "d".repeat(64),
        "SOURCE|PACKAGE|ZABAP"
      ],
      "S",
      "CAPABILITIES"
    )
  )
  try {
    const result = await fixture.backend.probeHelperCapabilities("w200", REPOSITORY_HELPER)
    assert.equal(result.attestation, "self-described")
    assert.equal(result.maxProtocol, "2.6")
    assert.equal(result.packageName, "ZABAP")
    assert.equal(result.sourceHash, "d".repeat(64))
    // Design revision R1: iv_expected_version is not reused for protocol negotiation. The
    // repository helper already declares that parameter for optimistic concurrency, so the
    // probe leaves it empty instead of sending a version.
    assert.match(fixture.requests[0] ?? "", /<IV_OPERATION>CAPABILITIES<\/IV_OPERATION>/)
    assert.match(fixture.requests[0] ?? "", /<IV_EXPECTED_VERSION><\/IV_EXPECTED_VERSION>/)
  } finally {
    await fixture.close()
  }
})

test("an old helper answering OPERATION_NOT_SUPPORTED degrades to operation-scoped", async () => {
  const fixture = await soapFixture(() => capabilitiesEnvelope([], "E", "OPERATION_NOT_SUPPORTED"))
  try {
    const result = await fixture.backend.probeHelperCapabilities("w200", REPOSITORY_HELPER)
    assert.equal(result.attestation, "operation-scoped")
    assert.equal(result.maxProtocol, null)
    assert.equal(result.detail, undefined)
  } finally {
    await fixture.close()
  }
})

test("a self-description naming another helper is downgraded and explained", async () => {
  const fixture = await soapFixture(() =>
    capabilitiesEnvelope(["HELPER|Z_ORVANTA_MCP_EXECUTE", "PROTOCOL|MAX|2.6"], "S", "CAPABILITIES")
  )
  try {
    const result = await fixture.backend.probeHelperCapabilities("w200", REPOSITORY_HELPER)
    assert.equal(result.attestation, "operation-scoped")
    assert.match(String(result.detail), /declared helper Z_ORVANTA_MCP_EXECUTE/)
  } finally {
    await fixture.close()
  }
})

test("a SOAP fault degrades to absent instead of failing the probe", async () => {
  const fixture = await soapFixture(
    () =>
      `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
      `<soap:Body><soap:Fault><faultstring>Helper not available</faultstring></soap:Fault>` +
      `</soap:Body></soap:Envelope>`
  )
  try {
    const result = await fixture.backend.probeHelperCapabilities("w200", REPOSITORY_HELPER)
    assert.equal(result.attestation, "absent")
    assert.match(String(result.detail), /SAP SOAP fault: Helper not available/)
  } finally {
    await fixture.close()
  }
})

test("the base helper probe dispatches to the EXECUTE endpoint", async () => {
  const fixture = await soapFixture(() =>
    capabilitiesEnvelope(["HELPER|Z_ORVANTA_MCP_EXECUTE", "PROTOCOL|MAX|2.6"], "S", "CAPABILITIES")
  )
  try {
    const result = await fixture.backend.probeHelperCapabilities("w200", BASE_HELPER)
    assert.equal(result.attestation, "self-described")
    assert.match(fixture.requests[0] ?? "", /<n1:Z_ORVANTA_MCP_EXECUTE /)
    assert.match(fixture.requests[0] ?? "", /<IV_OPERATION>CAPABILITIES<\/IV_OPERATION>/)
    // The EXECUTE interface stays exactly as it was: no expected-version import parameter.
    assert.doesNotMatch(fixture.requests[0] ?? "", /IV_EXPECTED_VERSION/)
  } finally {
    await fixture.close()
  }
})

// --- Z_ORVANTA_MAINT_READ / Z_ORVANTA_OPS_READ: the EV_RESULT JSON payload contract ----------
//
// These two helpers own no `it_source` table and return no `ev_status`/`ev_code`/`ev_version`.
// Their only reply channel is the EV_RESULT JSON string, whose `payload` array carries the same
// rows as the bootstrap helpers (protocol design revision R3), so the probe goes through
// `callRemoteFunction` - the same client path their business reads use - and validates the rows
// as a whole before any of them is trusted.

const operationalLogOperations = [
  { opcode: "JOB_SPOOL", since: "1.0", write: false },
  { opcode: "JOB_DETAILS", since: "1.0", write: false },
  { opcode: "JOB_LOG", since: "1.0", write: false },
  { opcode: "JOB_SEARCH", since: "1.0", write: false },
  { opcode: "SYSTEM_READ", since: "1.0", write: false },
  { opcode: "REPORT_PARAMETERS", since: "1.0", write: false }
]

/** The rows `scripts/operational-log-source.mjs` emits, in the generator's own order. */
const operationalLogRows = (
  operations: Array<{ opcode: string; since: string; write: boolean }> = operationalLogOperations
) => [
  `HELPER|${OPERATIONAL_LOG_HELPER}`,
  "PROTOCOL|MIN|1.0",
  "PROTOCOL|MAX|1.0",
  ...operations.map(
    (operation) => `OPERATION|${operation.opcode}|${operation.since}|${operation.write ? "W" : "R"}`
  ),
  `SOURCE|HASH|${"e".repeat(64)}`,
  "SOURCE|PACKAGE|ZABAP",
  "SOURCE|TRANSPORT|GR2K923421|GR2K923422",
  // The generator escapes '%' before '|', the shared row parser unescapes '|' before '%'.
  "RUNTIME|HOST|GR2%7C200%251",
  "RUNTIME|TIME|20260917120000|7200"
]

const jsonCapabilitiesEnvelope = (functionName: string, result: string) =>
  `<?xml version="1.0"?>` +
  `<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/">` +
  `<soap-env:Body>` +
  `<n0:${functionName}.Response xmlns:n0="urn:sap-com:document:sap:rfc:functions">` +
  `<EV_RESULT>${result}</EV_RESULT>` +
  `</n0:${functionName}.Response></soap-env:Body></soap-env:Envelope>`

const capabilitiesJson = (payload: string[]) =>
  JSON.stringify({
    version: "1",
    status: "S",
    code: "CAPABILITIES",
    message: "ORVANTA helper capabilities",
    readOnly: true,
    payload
  })

function jsonSelfDescription(overrides: Partial<SapHelperCapabilities>): SapHelperCapabilities {
  return {
    helper: OPERATIONAL_LOG_HELPER,
    minProtocol: "1.0",
    maxProtocol: "1.0",
    operations: operationalLogOperations,
    scopes: [],
    sourceHash: "e".repeat(64),
    packageName: "ZABAP",
    transport: "GR2K923421",
    host: "GR2|200%1",
    observedAt: "2026-09-17T12:00:00.000Z",
    attestation: "self-described",
    ...overrides
  }
}

test("a helper that self-describes through the JSON payload is attested with its operations", async () => {
  const fixture = await soapFixture(() =>
    jsonCapabilitiesEnvelope(OPERATIONAL_LOG_HELPER, capabilitiesJson(operationalLogRows()))
  )
  try {
    const result = await fixture.backend.probeHelperCapabilities("w200", OPERATIONAL_LOG_HELPER)
    assert.equal(result.attestation, "self-described")
    assert.equal(result.helper, OPERATIONAL_LOG_HELPER)
    assert.equal(result.minProtocol, "1.0")
    assert.equal(result.maxProtocol, "1.0")
    assert.deepEqual(result.operations, operationalLogOperations)
    assert.deepEqual(result.scopes, [])
    assert.equal(result.sourceHash, "e".repeat(64))
    assert.equal(result.packageName, "ZABAP")
    assert.equal(result.transport, "GR2K923421")
    assert.equal(result.host, "GR2|200%1")
    // The probe is the same read-only RFC call the business tool makes: the action plus one
    // scalar EV_RESULT, with no extra parameter and no expected-version negotiation.
    assert.match(fixture.requests[0] ?? "", /<n1:Z_ORVANTA_OPS_READ /)
    assert.match(fixture.requests[0] ?? "", /<IV_ACTION>CAPABILITIES<\/IV_ACTION>/)
    assert.doesNotMatch(fixture.requests[0] ?? "", /IV_EXPECTED_VERSION/)
  } finally {
    await fixture.close()
  }
})

test("an un-upgraded JSON helper degrades to operation-scoped without failing or changing a verdict", async () => {
  let answer = ""
  const fixture = await soapFixture(() => jsonCapabilitiesEnvelope(OPERATIONAL_LOG_HELPER, answer))
  try {
    for (const [label, next] of [
      [
        "OPERATION_NOT_SUPPORTED reply",
        JSON.stringify({
          version: "1",
          status: "E",
          code: "OPERATION_NOT_SUPPORTED",
          message: "ORVANTA helper does not support this operation",
          readOnly: true
        })
      ],
      ["empty EV_RESULT (an old body returns before its dispatcher)", ""]
    ] as Array<[string, string]>) {
      answer = next
      const result = await fixture.backend.probeHelperCapabilities("w200", OPERATIONAL_LOG_HELPER)
      assert.equal(result.attestation, "operation-scoped", label)
      assert.equal(result.detail, undefined, label)
      assert.equal(result.maxProtocol, null, label)
      assert.deepEqual(result.operations, [], label)
    }
  } finally {
    await fixture.close()
  }

  // The report-level conclusion is byte-for-byte the pre-probe one.
  const report = await buildReport(new MockBackend())
  assert.equal(report.helperAttestation[4]?.attestation, "operation-scoped")
  assert.equal(operationalLogCapability(report).availability, "unknown")
  assert.equal(operationalLogCapability(report).reason, OPERATIONAL_LOG_REASON)
  assert.equal(maintenanceCapability(report).reason, MAINTENANCE_REASON)
})

test("a malformed or misidentified JSON self-description is refused as a whole", async () => {
  let answer = ""
  const fixture = await soapFixture(() => jsonCapabilitiesEnvelope(OPERATIONAL_LOG_HELPER, answer))
  const rows = operationalLogRows()
  const withRow = (index: number, row: string) =>
    rows.map((value, at) => (at === index ? row : value))
  const withoutRow = (index: number) => rows.filter((_, at) => at !== index)
  const cases: Array<[string, string[], RegExp]> = [
    [
      "identity mismatch",
      withRow(0, `HELPER|${BASE_HELPER}`),
      /declared helper Z_ORVANTA_MCP_EXECUTE/
    ],
    ["missing HELPER row", withoutRow(0), /omitted the HELPER identity/],
    ["unparseable protocol", withRow(1, "PROTOCOL|MIN|one"), /unparseable protocol range/],
    ["missing PROTOCOL|MAX", withoutRow(2), /unparseable protocol range/],
    ["MIN above MAX", withRow(1, "PROTOCOL|MIN|2.0"), /above PROTOCOL\|MAX/],
    [
      "operation outside the declared protocol range",
      withRow(3, "OPERATION|JOB_SPOOL|2.0|R"),
      /outside its declared protocol range/
    ],
    [
      "malformed operation mode",
      withRow(3, "OPERATION|JOB_SPOOL|1.0|X"),
      /malformed OPERATION row/
    ],
    [
      "duplicate operation",
      withRow(4, "OPERATION|JOB_SPOOL|1.0|R"),
      /listed operation JOB_SPOOL twice/
    ]
  ]
  try {
    for (const [label, payload, detail] of cases) {
      answer = capabilitiesJson(payload)
      const result = await fixture.backend.probeHelperCapabilities("w200", OPERATIONAL_LOG_HELPER)
      assert.equal(result.attestation, "operation-scoped", label)
      assert.match(String(result.detail), detail, label)
      // Nothing from a refused payload may survive into the attestation.
      assert.equal(result.maxProtocol, null, label)
      assert.deepEqual(result.operations, [], label)
      assert.equal(result.sourceHash, null, label)
    }
  } finally {
    await fixture.close()
  }
})

test("a JSON reply that is not a CAPABILITIES envelope is refused without throwing", async () => {
  let answer = ""
  const fixture = await soapFixture(() => jsonCapabilitiesEnvelope(OPERATIONAL_LOG_HELPER, answer))
  const cases: Array<[string, string, RegExp]> = [
    ["plain text", "ORVANTA helper", /not a JSON envelope/],
    [
      "business reply",
      JSON.stringify({ version: "1", status: "ok", code: "OK" }),
      /status OK and code OK/
    ],
    ["empty payload array", capabilitiesJson([]), /no payload row array/],
    [
      "payload that is not a row array",
      JSON.stringify({
        version: "1",
        status: "S",
        code: "CAPABILITIES",
        readOnly: true,
        payload: [1, 2]
      }),
      /no payload row array/
    ]
  ]
  try {
    for (const [label, next, detail] of cases) {
      answer = next
      const result = await fixture.backend.probeHelperCapabilities("w200", OPERATIONAL_LOG_HELPER)
      assert.equal(result.attestation, "operation-scoped", label)
      assert.match(String(result.detail), detail, label)
    }
  } finally {
    await fixture.close()
  }
})

test("the two JSON helpers are reported in helperAttestation without touching their verdicts", async () => {
  const backend = new MockBackend()
  backend.helperCapabilities.set(OPERATIONAL_LOG_HELPER, jsonSelfDescription({}))
  backend.helperCapabilities.set(
    MAINTENANCE_HELPER,
    jsonSelfDescription({
      helper: MAINTENANCE_HELPER,
      packageName: "",
      transport: "",
      operations: [
        { opcode: "LOCK_SEARCH", since: "1.0", write: false },
        { opcode: "UPDATE_SEARCH", since: "1.0", write: false },
        { opcode: "UPDATE_DETAIL", since: "1.0", write: false }
      ]
    })
  )
  const report = await buildReport(backend)

  assert.deepEqual(
    report.helperAttestation.map((entry) => [entry.helper, entry.attestation]),
    [
      [BASE_HELPER, "operation-scoped"],
      [REPOSITORY_HELPER, "operation-scoped"],
      [DDIC_HELPER, "operation-scoped"],
      [MAINTENANCE_HELPER, "self-described"],
      [OPERATIONAL_LOG_HELPER, "self-described"],
      [APPLICATION_LOG_HELPER, "operation-scoped"],
      [SCI_V2_HELPER, "operation-scoped"],
      [SCI_E2_HELPER, "operation-scoped"]
    ]
  )
  const maintenance = report.helperAttestation[3]
  assert.deepEqual(
    maintenance?.operations.map((operation) => operation.opcode),
    ["LOCK_SEARCH", "UPDATE_SEARCH", "UPDATE_DETAIL"]
  )
  assert.equal(maintenance?.packageName, "")
  const operationalLog = report.helperAttestation[4]
  assert.deepEqual(operationalLog?.operations, operationalLogOperations)
  assert.equal(operationalLog?.sourceHash, "e".repeat(64))

  // Neither verdict may follow the self-description: those reads are approval-gated, so the
  // report keeps its unchanged unknown observation and wording.
  assert.equal(maintenanceCapability(report).availability, "unknown")
  assert.equal(maintenanceCapability(report).reason, MAINTENANCE_REASON)
  assert.equal(operationalLogCapability(report).availability, "unknown")
  assert.equal(operationalLogCapability(report).reason, OPERATIONAL_LOG_REASON)
})

test("a JSON helper self-description under another identity is not used as evidence", async () => {
  const backend = new MockBackend()
  backend.helperCapabilities.set(
    OPERATIONAL_LOG_HELPER,
    jsonSelfDescription({ helper: BASE_HELPER })
  )
  const report = await buildReport(backend)

  const attestation = report.helperAttestation[4]
  assert.equal(attestation?.attestation, "operation-scoped")
  assert.match(String(attestation?.detail), /declared helper Z_ORVANTA_MCP_EXECUTE/)
  assert.equal(operationalLogCapability(report).reason, OPERATIONAL_LOG_REASON)
})

// --- Z_ORVANTA_LOG_READ: the application-log capability verdict ---------------------------------
//
// The application-log helper answers `CAPABILITIES` through the same `EV_RESULT` JSON envelope as
// the two helpers above, and its read tools are approval-gated, so this report performs no read on
// it: a matching self-description is the only fact that may move the `application-logs` verdict off
// `unknown`. Every other outcome keeps the pre-probe sentence byte for byte.

const APPLICATION_LOG_REASON =
  "Requires separately deployed, source/interface-pinned Z_ORVANTA_LOG_READ and local administrator approval; message reads need separate approval. Registration does not prove SLG1 access or read-only SAP behavior."

const applicationLogCapability = (report: ReportShape) =>
  capabilityObservation(report, "application-logs")

test("a matching Z_ORVANTA_LOG_READ self-description is available and keeps both approval caveats", async () => {
  const backend = new MockBackend()
  backend.helperCapabilities.set(
    APPLICATION_LOG_HELPER,
    jsonSelfDescription({
      helper: APPLICATION_LOG_HELPER,
      minProtocol: "1.0",
      maxProtocol: "2.6"
    })
  )
  const report = await buildReport(backend)

  const attestation = report.helperAttestation[5]
  assert.equal(attestation?.attestation, "self-described")
  assert.equal(attestation?.helper, APPLICATION_LOG_HELPER)

  const applicationLogs = applicationLogCapability(report)
  assert.equal(applicationLogs.availability, "available")
  // The verdict names the self-described protocol, and the two approvals stay in the same
  // sentence: a self-description is not an approval.
  assert.match(applicationLogs.reason, /Z_ORVANTA_LOG_READ helper self-described protocol 2\.6/)
  assert.match(applicationLogs.reason, /local administrator approval/)
  assert.match(applicationLogs.reason, /message reads need separate approval/)
  assert.equal(applicationLogs.evidence.source, "version-check")
  assert.match(applicationLogs.evidence.detail, /self-described protocol 2\.6/)
  assert.match(applicationLogs.evidence.detail, /lowest compatible 1\.0/)
  assert.match(applicationLogs.evidence.detail, /no approval-gated read probe was performed/)
})

test("a Z_ORVANTA_LOG_READ self-description under another helper identity is not used as evidence", async () => {
  const backend = new MockBackend()
  backend.helperCapabilities.set(
    APPLICATION_LOG_HELPER,
    jsonSelfDescription({ helper: OPERATIONAL_LOG_HELPER, maxProtocol: "2.6" })
  )
  const report = await buildReport(backend)

  const attestation = report.helperAttestation[5]
  assert.equal(attestation?.attestation, "operation-scoped")
  assert.match(String(attestation?.detail), /declared helper Z_ORVANTA_OPS_READ/)

  const applicationLogs = applicationLogCapability(report)
  assert.equal(applicationLogs.availability, "unknown")
  assert.equal(applicationLogs.reason, APPLICATION_LOG_REASON)
})

test("a self-described Z_ORVANTA_LOG_READ without a protocol is not used as evidence", async () => {
  const backend = new MockBackend()
  backend.helperCapabilities.set(
    APPLICATION_LOG_HELPER,
    jsonSelfDescription({ helper: APPLICATION_LOG_HELPER, maxProtocol: null })
  )
  const report = await buildReport(backend)

  // The identity matched, so the attestation itself is reported as self-described, but without a
  // protocol it states no capability and cannot move the verdict.
  assert.equal(report.helperAttestation[5]?.attestation, "self-described")
  assert.equal(report.helperAttestation[5]?.maxProtocol, null)

  const applicationLogs = applicationLogCapability(report)
  assert.equal(applicationLogs.availability, "unknown")
  assert.equal(applicationLogs.reason, APPLICATION_LOG_REASON)
})

test("a failed CAPABILITIES probe never reports the application-log capability as missing", async () => {
  const backend = new MockBackend()
  backend.helperCapabilitiesUnreachable = true
  const report = await buildReport(backend)

  // No read probe is performed for this helper, so a failed `CAPABILITIES` probe stays an honest
  // `absent` attestation - but the capability verdict is never turned into a missing endpoint.
  assert.equal(report.helperAttestation[5]?.attestation, "absent")
  assert.match(String(report.helperAttestation[5]?.detail), /CAPABILITIES/)

  const applicationLogs = applicationLogCapability(report)
  assert.equal(applicationLogs.availability, "unknown")
  assert.equal(applicationLogs.reason, APPLICATION_LOG_REASON)
  assert.equal(applicationLogs.evidence.source, "local-contract")
  assert.equal(applicationLogs.evidence.detail, "No target-specific operation was invoked")
})

test("an un-upgraded application-log helper keeps the previous application-log wording", async () => {
  const report = await buildReport(new MockBackend())

  assert.equal(report.helperAttestation[5]?.attestation, "operation-scoped")
  assert.equal(report.helperAttestation[5]?.maxProtocol, null)

  const applicationLogs = applicationLogCapability(report)
  assert.equal(applicationLogs.availability, "unknown")
  assert.equal(applicationLogs.reason, APPLICATION_LOG_REASON)
  assert.equal(applicationLogs.evidence.source, "local-contract")
})

// --- Z_ORVANTA_MCP_SCI_V2 / Z_ORVANTA_MCP_SCI_E2: report-only SCI attestation -------------------
//
// The two SCI helpers answer `CAPABILITIES` through the same EV_RESULT JSON envelope, but the
// capability report runs no SCI inspection: `scoped-sci-quality` needs an explicit customer target
// and rule profile. A matching self-description is therefore reported and nothing else - it must
// not move the SCI verdict off its unchanged unknown wording.

const SCI_REASON =
  "Requires a pinned SCI helper. Legacy uses Z_ORVANTA_MCP_SCI_API; explicit customer PROG/CLAS/FUGR targets use Z_ORVANTA_MCP_SCI_V2 (two rules). Explicit syntax_critical_sql profile uses Z_ORVANTA_MCP_SCI_E2 (adds nested SELECT only, not FAE). Not native ATC; discovery does not execute or attest helpers."

const sciCapability = (report: ReportShape) => capabilityObservation(report, "scoped-sci-quality")

test("the two SCI helpers are reported in helperAttestation without moving the SCI verdict", async () => {
  const backend = new MockBackend()
  backend.helperCapabilities.set(
    SCI_V2_HELPER,
    jsonSelfDescription({
      helper: SCI_V2_HELPER,
      minProtocol: "1.0",
      maxProtocol: "1.0",
      operations: [
        { opcode: "PRECHECK", since: "1.0", write: false },
        { opcode: "RUN", since: "1.0", write: false }
      ],
      sourceHash: "f".repeat(64)
    })
  )
  backend.helperCapabilities.set(
    SCI_E2_HELPER,
    jsonSelfDescription({
      helper: SCI_E2_HELPER,
      minProtocol: "1.0",
      maxProtocol: "1.0",
      operations: [
        { opcode: "PRECHECK", since: "1.0", write: false },
        { opcode: "RUN", since: "1.0", write: false }
      ],
      sourceHash: "0".repeat(64)
    })
  )
  const report = await buildReport(backend)

  const sciV2 = report.helperAttestation[6]
  assert.equal(sciV2?.helper, SCI_V2_HELPER)
  assert.equal(sciV2?.attestation, "self-described")
  assert.deepEqual(
    sciV2?.operations.map((operation) => [operation.opcode, operation.since, operation.write]),
    [
      ["PRECHECK", "1.0", false],
      ["RUN", "1.0", false]
    ]
  )
  const sciE2 = report.helperAttestation[7]
  assert.equal(sciE2?.helper, SCI_E2_HELPER)
  assert.equal(sciE2?.attestation, "self-described")
  assert.equal(sciE2?.sourceHash, "0".repeat(64))

  // Report-only: the SCI verdict keeps the pre-probe sentence and its local-contract evidence.
  assert.equal(sciCapability(report).availability, "unknown")
  assert.equal(sciCapability(report).reason, SCI_REASON)
  assert.equal(sciCapability(report).evidence.source, "local-contract")
})

test("an SCI self-description under another helper identity is not used as evidence", async () => {
  const backend = new MockBackend()
  backend.helperCapabilities.set(
    SCI_V2_HELPER,
    jsonSelfDescription({ helper: SCI_E2_HELPER, maxProtocol: "1.0" })
  )
  const report = await buildReport(backend)

  const attestation = report.helperAttestation[6]
  assert.equal(attestation?.attestation, "operation-scoped")
  assert.match(String(attestation?.detail), /declared helper Z_ORVANTA_MCP_SCI_E2/)
  // The identity guard never turns a refusal into a missing endpoint.
  assert.equal(sciCapability(report).availability, "unknown")
  assert.equal(sciCapability(report).reason, SCI_REASON)
})

test("an unreachable SCI helper keeps an honest absent attestation", async () => {
  const backend = new MockBackend()
  backend.helperCapabilitiesUnreachable = true
  const report = await buildReport(backend)

  assert.equal(report.helperAttestation[6]?.attestation, "absent")
  assert.match(String(report.helperAttestation[6]?.detail), /CAPABILITIES/)
  assert.equal(report.helperAttestation[7]?.attestation, "absent")
  assert.equal(sciCapability(report).availability, "unknown")
  assert.equal(sciCapability(report).reason, SCI_REASON)
})
