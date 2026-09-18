import assert from "node:assert/strict"
import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import { buildSapHelperEnvelope, traceHelperProbe } from "../src/adt-backend.js"

// Offline test for the opt-in helper-probe capture. It writes into a temporary directory and never
// contacts SAP. The capture exists because the probe reports the same verdict - "omitted the HELPER
// identity line" - both for a helper that answers without the line and for a reply this client could
// not read, and only the raw reply tells those two apart.

// The shape a healthy helper returns: the rows live in IT_SOURCE, which is exactly what
// parseHelperCapabilitiesResponse reads. The cookie fragment is present only to prove the capture
// redacts it.
const REPLY = [
  '<?xml version="1.0" encoding="utf-8"?>',
  "<soapenv:Envelope>",
  "<IT_SOURCE><item><LINE>HELPER|Z_ORVANTA_MCP_EXECUTE</LINE></item>",
  "<item><LINE>PROTOCOL|MIN|1.1</LINE></item>",
  "<item><LINE>PROTOCOL|MAX|2.6</LINE></item></IT_SOURCE>",
  "<COOKIE>SAP_SESSIONID_GR2_200=abcdef123456</COOKIE>",
  "</soapenv:Envelope>"
].join("\n")

const withRoot = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-helper-trace-"))
  const previousRoot = process.env.ABAP_MCP_EXPORT_ROOT
  const previousSwitch = process.env.ABAP_MCP_HELPER_TRACE
  process.env.ABAP_MCP_EXPORT_ROOT = root
  try {
    await run(root)
  } finally {
    if (previousRoot === undefined) delete process.env.ABAP_MCP_EXPORT_ROOT
    else process.env.ABAP_MCP_EXPORT_ROOT = previousRoot
    if (previousSwitch === undefined) delete process.env.ABAP_MCP_HELPER_TRACE
    else process.env.ABAP_MCP_HELPER_TRACE = previousSwitch
  }
}

test("the helper capture keeps the raw reply, including the identity row, without a session cookie", async () => {
  await withRoot(async (root) => {
    process.env.ABAP_MCP_HELPER_TRACE = "1"
    traceHelperProbe(
      "Z_ORVANTA_MCP_EXECUTE",
      "xml-rows",
      "http://www.sap.com/Z_ORVANTA_MCP_EXECUTE",
      REPLY
    )
    const log = await readFile(join(root, "helper-trace.log"), "utf8")
    assert.ok(!log.includes("abcdef123456"), "a session cookie value must never be written out")
    assert.match(log, /HELPER-PROBE helper=Z_ORVANTA_MCP_EXECUTE reply=xml-rows/)
    assert.match(log, /action=http:\/\/www\.sap\.com\/Z_ORVANTA_MCP_EXECUTE/)
    assert.match(log, /bytes=\d+/)
    assert.match(log, /sha256:[a-f0-9]{12}/)
    assert.match(log, /SAP_SESSIONID=<redacted>/)
    assert.ok(log.includes("</COOKIE>"), "redaction must not swallow the rest of the reply")
    // The decisive rows: a capture that carries the identity line proves the helper answered with it.
    assert.match(
      log,
      /HELPER-PROBE-BODY <IT_SOURCE><item><LINE>HELPER\|Z_ORVANTA_MCP_EXECUTE<\/LINE><\/item>/
    )
    assert.match(log, /HELPER-PROBE-BODY <item><LINE>PROTOCOL\|MIN\|1\.1<\/LINE><\/item>/)
    assert.match(log, /HELPER-PROBE-BODY <item><LINE>PROTOCOL\|MAX\|2\.6<\/LINE><\/item>/)
    // One record per source line, each with the timestamp appendTraceLine adds.
    const written = log.trimEnd().split("\n")
    assert.equal(written.length, REPLY.split("\n").length + 1, "every reply line must be appended")
    assert.match(String(written[0]), /^\d{4}-\d{2}-\d{2}T[\d:.]+Z HELPER-PROBE /)
  })
})

test("the helper capture is off unless ABAP_MCP_HELPER_TRACE is set", async () => {
  await withRoot(async (root) => {
    traceHelperProbe("Z_ORVANTA_MCP_EXECUTE", "xml-rows", "", REPLY)
    const absent = await stat(join(root, "helper-trace.log")).then(
      () => false,
      () => true
    )
    assert.ok(absent, "no trace file may appear while the switch is off")
  })
  const source = await readFile(resolve("src/adt-backend.ts"), "utf8")
  assert.match(
    source,
    /if \(!process\.env\.ABAP_MCP_HELPER_TRACE\) return/,
    "the capture must gate itself on the environment variable"
  )
  assert.match(
    source,
    /traceHelperProbe\(probed, "xml-rows", channel\.soapAction, body\)/,
    "the XML probe must capture the reply before deriving any verdict from it"
  )
})

test("the CAPABILITIES envelope sends the IT_SOURCE table its rows come back in", () => {
  // RFC echoes a TABLES parameter only when the caller sent it. Z_ORVANTA_MCP_EXECUTE answers CAPABILITIES
  // with the status fields and no IT_SOURCE element at all unless this is present, which is exactly the
  // reply captured on 2026-09-18 (823 bytes, not one table element in it).
  const probe = buildSapHelperEnvelope({ operation: "CAPABILITIES" })
  assert.match(probe, /<IV_OPERATION>CAPABILITIES<\/IV_OPERATION>/)
  assert.match(probe, /<IT_SOURCE><\/IT_SOURCE>/)
  // The guard keeps the change on the probe: no other operation gains an empty table.
  assert.doesNotMatch(
    buildSapHelperEnvelope({
      operation: "VALIDATE_TARGET",
      objectType: "CLAS",
      objectName: "ZDEMO"
    }),
    /IT_SOURCE/
  )
})
