import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  attestConfigurationBteProtocolSources,
  configurationBteProtocolSourceVersion,
  inspectConfigurationBteProtocol
} from "../src/configuration-bte-protocol.js"

const observed = JSON.parse(
  readFileSync(
    new URL("./fixtures/configuration-bte-protocol-w200-r80.json", import.meta.url),
    "utf8"
  )
)
const sha = (value: string) => createHash("sha256").update(value).digest("hex")
const binding = { operationId: "save-1", requestId: sha("save-1"), command: "SAVE" }
function report() {
  return {
    ...binding,
    version: 1,
    system: "GR2",
    client: "200",
    username: "WYS",
    sourceVersion: configurationBteProtocolSourceVersion,
    storage: "FILE",
    initialize: "ok",
    append: "ok",
    read: "ok",
    cleanup: "ok",
    entryCount: 0,
    beginMarker: binding.requestId,
    endMarker: binding.requestId,
    sizeVerified: true,
    fileBytes: 100,
    conversionVerified: true,
    compacted: false,
    truncated: false,
    reportedCount: 1,
    messages: [
      {
        sequence: 1,
        severity: " ",
        level: 4,
        messageClass: "PU",
        messageNumber: "000",
        language: "E",
        text: "  Synthetic log with original padding  "
      }
    ]
  }
}

test("five recorded interfaces and five full sources attest without invoking any API", async () => {
  const calls: string[] = []
  const result = await attestConfigurationBteProtocolSources({
    definition: async (name) => {
      calls.push(name)
      return observed.definitions[name]
    },
    include: async (name) => {
      calls.push(name)
      return observed.includes[name]
    }
  })
  assert.equal(calls.length, 10)
  assert.equal(new Set(calls).size, 10)
  assert.equal(result.sourceVersion, configurationBteProtocolSourceVersion)
  assert.equal(result.nativeExecutionVerified, false)
  assert.equal(result.writeAvailable, false)
  assert(result.unresolvedDependencies.includes("NATIVE_APPEND_FAILURE_COVERAGE"))
})

for (const drift of ["fingerprint", "body", "abi", "include", "uri", "mode", "unavailable"]) {
  test(`source attestation rejects ${drift} without trusting a claimed hash`, async () => {
    const f = structuredClone(observed)
    if (drift === "fingerprint") f.definitions.APPEND_PROTOCOL.sourceFingerprint = sha("drift")
    if (drift === "body") f.definitions.APPEND_PROTOCOL.source.push("COMMIT WORK.")
    if (drift === "abi") f.definitions.TR_READ_LOG.tableParameters[0].typeName = "OTHER"
    if (drift === "include") f.includes.LSLOGF03.source += "\n* changed"
    if (drift === "uri") f.includes.LSLOGTOP.sourceUri = "/other/source/main"
    if (drift === "mode") f.definitions.LCT_MESSAGE.remoteEnabled = true
    await assert.rejects(
      attestConfigurationBteProtocolSources({
        definition: async (name) => {
          if (drift === "unavailable") throw Error("source unavailable")
          return f.definitions[name]
        },
        include: async (name) => f.includes[name]
      }),
      /SOURCE_UNVERIFIED/
    )
  })
}

test("a bounded complete report preserves message text but cannot grant writes", () => {
  const value = inspectConfigurationBteProtocol(report(), binding)
  assert.equal(value.status, "complete_without_errors")
  assert.equal(value.report.messages[0]!.text, "  Synthetic log with original padding  ")
  assert.equal(value.firstError, null)
  assert.equal(value.writeAvailable, false)
  assert.equal(value.transactionVerified, false)
  assert.equal(value.automaticRetry, false)
})

for (const severity of ["E", "A", "P"]) {
  test(`${severity} before later success remains a failure with the original first message`, () => {
    const r = report()
    r.messages = [
      { ...r.messages[0]!, severity, text: "first cause" },
      { ...r.messages[0]!, sequence: 2, severity: "E", text: "second cause" },
      { ...r.messages[0]!, sequence: 3, severity: "S", text: "success" }
    ]
    r.reportedCount = 3
    const value = inspectConfigurationBteProtocol(r, binding)
    assert.equal(value.status, "errors_observed")
    assert.equal(value.firstError!.text, "first cause")
    assert.equal(value.errors.length, 2)
    assert.deepEqual(
      value.report.messages.map((m) => m.text),
      ["first cause", "second cause", "success"]
    )
  })
}

for (const [patch, blocker] of [
  [{ initialize: "not_initialized" }, "INITIALIZATION_FAILED"],
  [{ initialize: "failed" }, "INITIALIZATION_FAILED"],
  [{ entryCount: 1 }, "STALE_LOG"],
  [{ beginMarker: null }, "BOUNDARY_UNVERIFIED"],
  [{ endMarker: sha("other invocation") }, "BOUNDARY_UNVERIFIED"],
  [{ append: "failed" }, "APPEND_UNVERIFIED"],
  [{ append: "unverified" }, "APPEND_UNVERIFIED"],
  [{ read: "failed" }, "READ_FAILED"],
  [{ cleanup: "failed" }, "CLEANUP_UNVERIFIED"],
  [{ cleanup: "unverified" }, "CLEANUP_UNVERIFIED"],
  [{ sizeVerified: false }, "SIZE_UNVERIFIED"],
  [{ fileBytes: 0 }, "SIZE_UNVERIFIED"],
  [{ conversionVerified: false }, "CONVERSION_UNVERIFIED"],
  [{ compacted: true }, "TRUNCATED"],
  [{ truncated: true }, "TRUNCATED"],
  [{ reportedCount: 2 }, "COUNT_MISMATCH"],
  [{ messages: [], reportedCount: 0 }, "EMPTY_LOG"]
] as const) {
  test(`protocol rejects incomplete evidence: ${blocker} / ${JSON.stringify(patch)}`, () => {
    const value = inspectConfigurationBteProtocol({ ...report(), ...patch }, binding)
    assert.equal(value.status, "incomplete")
    assert(value.blockers.includes(blocker))
    assert.equal(value.writeAvailable, false)
  })
}

test("reordered, duplicate and unparsed rows cannot conceal an error", () => {
  for (const patch of [{ sequence: 2 }, { messageClass: " " }, { language: " " }]) {
    const r = report()
    Object.assign(r.messages[0]!, patch)
    assert.equal(inspectConfigurationBteProtocol(r, binding).status, "incomplete")
  }
  const r = report()
  r.messages.push({ ...r.messages[0]! })
  r.reportedCount = 2
  assert(inspectConfigurationBteProtocol(r, binding).blockers.includes("ORDER_UNVERIFIED"))
})

test("foreign identity, source versions and command bindings are refused", () => {
  for (const patch of [
    { operationId: "other" },
    { requestId: sha("other") },
    { command: "RECOVER" },
    { sourceVersion: sha("changed") },
    { system: "GR3" },
    { client: "300" },
    { username: "OTHER" },
    { storage: "MEMORY" },
    { storage: "DB" }
  ])
    assert.throws(
      () => inspectConfigurationBteProtocol({ ...report(), ...patch }, binding),
      /BTE_PROTOCOL_(BINDING_MISMATCH|SOURCE_CHANGED|RESPONSE_UNVERIFIED)/
    )
})

test("malformed, huge and unknown-severity reports fail before classification", () => {
  for (const raw of [
    null,
    { ...report(), reportedCount: -1 },
    { ...report(), fileBytes: 50000001 },
    { ...report(), unexpected: true },
    { ...report(), reportedCount: "1" },
    { ...report(), messages: Array.from({ length: 1001 }, () => report().messages[0]) },
    { ...report(), messages: [{ ...report().messages[0], severity: "X" }] },
    { ...report(), messages: [{ ...report().messages[0], text: "x".repeat(4097) }] },
    { ...report(), messages: [{ ...report().messages[0], messageNumber: "bad" }] }
  ])
    assert.throws(() => inspectConfigurationBteProtocol(raw, binding), /RESPONSE_UNVERIFIED/)
})

test("a read failure preserves already captured native root causes", () => {
  const r = report()
  r.read = "failed"
  r.messages[0]!.severity = "E"
  r.messages[0]!.text = "original error before read failure"
  const result = inspectConfigurationBteProtocol(r, binding)
  assert.equal(result.status, "incomplete")
  assert.equal(result.firstError!.text, "original error before read failure")
  assert.deepEqual(result.blockers, ["READ_FAILED"])
})
