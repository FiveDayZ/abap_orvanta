import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import { traceAdtRequest } from "../src/adt-backend.js"

// The exact handle and cookie the failed live attempts carried. Neither may ever reach the trace: only
// their short SHA-256 may, so the log can be read back without exposing a credential.
const HANDLE = "UFOtwAUqujqTBTH4OTdbzarCN3c="
const OTHER_HANDLE = "V/58/oQmmE2A5i3zsVumKHNECG0="
const COOKIE = "SAP_SESSIONID_GR2_200=abcdef123456; sap-usercontext=xyz"
const SET_COOKIE = ["SAP_SESSIONID_GR2_200=fedcba654321; path=/"]

const first = (pattern: RegExp, line: string | undefined): string | undefined =>
  String(line ?? "").match(pattern)?.[1]

function lockResponse(body: string) {
  return {
    id: 7,
    request: {
      method: "post",
      uri: "/sap/bc/adt/functions/groups/zorvanta_maint/fmodules/z_orvanta_maint_read",
      params: { _action: "LOCK", accessMode: "MODIFY" },
      headers: { Cookie: COOKIE }
    },
    response: {
      statusCode: 200,
      statusMessage: "OK",
      headers: { "set-cookie": SET_COOKIE },
      body
    },
    stateful: true,
    startTime: new Date(),
    duration: 12,
    clientId: 1
  }
}

function putResponse(lockHandle: string, body = "Resource MAIN is not locked") {
  return {
    id: 8,
    request: {
      method: "put",
      uri: "/sap/bc/adt/functions/groups/zorvanta_maint/fmodules/z_orvanta_maint_read/source/main",
      params: { lockHandle, corrNr: "GR2K923472" },
      headers: { Cookie: COOKIE }
    },
    response: { statusCode: 423, statusMessage: "Locked", headers: {}, body },
    stateful: true,
    startTime: new Date(),
    duration: 803,
    clientId: 1
  }
}

const issued = `<asx:abap><asx:values><DATA><LOCK_HANDLE>${HANDLE}</LOCK_HANDLE></DATA></asx:values></asx:abap>`

test("the ADT trace identifies the lock, the session and the handle without exposing either", async () => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-trace-"))
  const previousRoot = process.env.ABAP_MCP_EXPORT_ROOT
  process.env.ABAP_MCP_EXPORT_ROOT = root
  try {
    const lines: string[] = []
    traceAdtRequest(lockResponse(issued), (line) => lines.push(line))
    traceAdtRequest(putResponse(HANDLE), (line) => lines.push(line))
    assert.equal(lines.length, 2)

    const [lockLine = "", putLine = ""] = lines
    for (const line of lines) {
      assert.ok(!line.includes(HANDLE), "a lock handle must never be written out")
      assert.ok(!line.includes(OTHER_HANDLE), "no other handle may leak either")
      assert.ok(!line.includes("SAP_SESSIONID"), "a session cookie must never be written out")
      assert.ok(!line.includes(COOKIE), "no cookie value may leak")
      assert.match(line, /stateful=true/)
      assert.match(line, /requestSession=sha256:[a-f0-9]{12}/)
    }

    // The lock POST carries no handle yet, but SAP issues one in the XML response.
    assert.match(lockLine, /^ADT-TRACE #7 POST /)
    assert.match(lockLine, /lockIssued=sha256:[a-f0-9]{12}/)
    assert.doesNotMatch(lockLine, /lockSent=/)
    assert.match(lockLine, /responseSession=sha256:[a-f0-9]{12}/)

    // The PUT is where the failure lands, and the trace has to show the corrNr and the handle sent.
    assert.match(putLine, /^ADT-TRACE #8 PUT /)
    assert.match(putLine, /corrNr=GR2K923472/)
    assert.match(putLine, /-> 423 /)
    const sent = first(/lockSent=sha256:([a-f0-9]{12})/, putLine)
    assert.ok(sent, "the PUT must report the handle it sent")

    // Both requests ran in one SAP session: same request cookie, so the session is not the difference.
    assert.equal(
      first(/requestSession=(sha256:[a-f0-9]{12})/, lockLine),
      first(/requestSession=(sha256:[a-f0-9]{12})/, putLine)
    )

    // And the same handle SAP issued is the one that was sent back.
    assert.equal(first(/lockIssued=sha256:([a-f0-9]{12})/, lockLine), sent)

    // A handle that changed in flight would be visible: the two hashes then differ.
    const mutated: string[] = []
    traceAdtRequest(lockResponse(issued), (line) => mutated.push(line))
    traceAdtRequest(putResponse(OTHER_HANDLE), (line) => mutated.push(line))
    assert.notEqual(
      first(/lockIssued=sha256:([a-f0-9]{12})/, mutated[0]),
      first(/lockSent=sha256:([a-f0-9]{12})/, mutated[1])
    )

    // The point of the patch: the sequence survives in a file the operator can read afterwards.
    const log = await readFile(join(root, "adt-trace.log"), "utf8")
    const written = log.trimEnd().split("\n")
    assert.equal(written.length, 4, "every traced request must be appended, not overwritten")
    assert.match(String(written[0]), /^\d{4}-\d{2}-\d{2}T[\d:.]+Z ADT-TRACE #7 POST /)
    assert.match(String(written[3]), /ADT-TRACE #8 PUT /)
    assert.ok(!log.includes(HANDLE) && !log.includes("SAP_SESSIONID"))
  } finally {
    if (previousRoot === undefined) delete process.env.ABAP_MCP_EXPORT_ROOT
    else process.env.ABAP_MCP_EXPORT_ROOT = previousRoot
  }
})

test("the trace is off unless ABAP_MCP_ADT_TRACE is set", async () => {
  const source = await readFile(resolve("src/adt-backend.ts"), "utf8")
  assert.match(
    source,
    /if \(process\.env\.ABAP_MCP_ADT_TRACE\) traceAdtRequest\(data, report\)/,
    "the write client must gate the trace on the environment variable"
  )
  assert.match(source, /if \(data\.response\.statusCode < 400\) return/)
})
