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

function repositoryCapability(report: ReportShape, id: string) {
  const capability = report.capabilities.find((item) => item.id === id)
  assert.ok(capability, `capability ${id} is missing from the report`)
  return capability.observation
}

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
  const messageUpdate = repositoryCapability(report, "repository-helper-message-update")
  assert.equal(messageUpdate.availability, "unknown")
  assert.equal(
    messageUpdate.reason,
    "The read probe observed repository operation protocol 1.2; it does not prove whether capability version 1.8 is installed."
  )
  const dynproCore = repositoryCapability(report, "repository-helper-dynpro-core")
  assert.equal(dynproCore.availability, "available")
  assert.equal(
    dynproCore.reason,
    "The observed repository read protocol 1.2 satisfies minimum 1.1."
  )
  assert.equal(
    repositoryCapability(report, "ddic-helper-controlled-delete").availability,
    "available"
  )

  assert.deepEqual(
    report.helperAttestation.map((entry) => [entry.helper, entry.attestation]),
    [
      [BASE_HELPER, "operation-scoped"],
      [REPOSITORY_HELPER, "operation-scoped"]
    ]
  )
  assert.equal(report.helperAttestation[1]?.maxProtocol, null)
  assert.equal(report.helperAttestation[1]?.detail, undefined)
  // The bounded read-probe observations keep their previous shape.
  assert.equal("attestation" in (report.helpers[0] ?? {}), false)
  assert.equal("attestation" in (report.helpers[1] ?? {}), false)
})

test("a self-described helper at or above the required protocol is available with its source identity", async () => {
  const backend = new MockBackend()
  backend.helperCapabilities.set(REPOSITORY_HELPER, selfDescription({ maxProtocol: "2.6" }))
  const report = await buildReport(backend)

  const lifecycle = repositoryCapability(report, "repository-helper-enhancement-lifecycle")
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

  const messageUpdate = repositoryCapability(report, "repository-helper-message-update")
  assert.equal(messageUpdate.availability, "unsupported")
  assert.equal(
    messageUpdate.reason,
    `The ${REPOSITORY_HELPER} helper self-described protocol 1.6, which is below the required capability version 1.8.`
  )
  assert.equal(
    repositoryCapability(report, "repository-helper-gui-definition").availability,
    "available"
  )
  // DDIC is not probed in this delivery, so its operation-scoped judgement is unchanged.
  assert.equal(
    repositoryCapability(report, "ddic-helper-controlled-delete").availability,
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

  const messageUpdate = repositoryCapability(report, "repository-helper-message-update")
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

  const lifecycle = repositoryCapability(report, "repository-helper-enhancement-lifecycle")
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
