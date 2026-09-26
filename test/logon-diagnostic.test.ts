import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { capabilityFailure, classifyObjectSearchFailure } from "../src/adt-backend.js"
import type { AbapObjectInfo } from "../src/backend.js"
import { startHttpServer } from "../src/http.js"
import {
  LOGON_REJECTED,
  annotateLogonRejection,
  describesLogonRejection,
  isLogonRejection,
  logonDiagnostic
} from "../src/logon-diagnostic.js"
import { MockBackend } from "./mock-backend.js"

/**
 * Incident 2026-09-26 10:40: the SAP user's logon data was refused, so every ADT call and the SOAP
 * RFC channel answered HTTP 401 for about two minutes. The service reported a bare "Request failed
 * with status code 401" for an object creation, an ADT source read and a SOAP ping alike, and the
 * caller had to infer from a separate probe that no object, name or permission change could help.
 * Worse, the classifiers that saw the 401 filed it as "the SAP user is not authorized" - a false
 * statement about the target that reads like a request problem instead of a credential problem.
 *
 * These tests hold the distinction: a rejected logon is named as one, carries the actionable cause,
 * and never becomes an authorization or capability verdict about the object.
 */

/** The live w200 SOAP wording (trimmed, entities decoded), the strongest available evidence. */
const SOAP_LOGON_FAILURE =
  "Error: SAP SOAP request returned HTTP 401: Logon Error Message 登录失败 调用 URL " +
  "http://192.168.88.26:8000/sap/bc/soap/rfc 终止因为登录数据出错。 执行客户端 200，用户 wys 和语言 ZH 的登录。 " +
  "错误代码: ICF-LE-http-c:200-l:1-T:1-C:3-U:5-P:5-L:3 HTTP 401 - Unauthorized"

function logonError(): Error {
  return Object.assign(new Error("Request failed with status code 401"), { status: 401 })
}

function forbiddenError(): Error {
  return Object.assign(new Error("Error 403: Forbidden"), { status: 403 })
}

test("only SAP's own logon wording counts as a rejected logon", () => {
  for (const text of [
    SOAP_LOGON_FAILURE,
    "Request failed with status code 401",
    "ADT GET /sap/bc/adt/programs/programs/zpmc_tp_split returned HTTP 401",
    "Logon data incorrect"
  ]) {
    assert.equal(describesLogonRejection(text), true, text)
  }
  for (const text of [
    "Error 403: Forbidden",
    "syntax-diagnostics capability forbidden-or-not-authorized (HTTP 403): denied",
    // A bare "Unauthorized" is ordinary authorization text, and a status property is not evidence:
    // the ADT library also defaults unknown failures to 500, which once made a local parse crash
    // look like a server fault.
    "Unauthorized",
    "Cannot read properties of undefined (reading 'adtcore:changedAt')"
  ]) {
    assert.equal(describesLogonRejection(text), false, text)
  }
})

test("a 403 stays an authorization answer and is never reported as a logon rejection", () => {
  assert.equal(isLogonRejection(401, "denied"), true)
  assert.equal(isLogonRejection(403, "denied"), false)
  assert.equal(isLogonRejection(0, SOAP_LOGON_FAILURE), true)
  assert.equal(isLogonRejection(500, "Cannot read properties of undefined"), false)
})

test("the diagnosis is appended once, names the connection and the actionable cause", () => {
  const annotated = annotateLogonRejection(
    "Error invoking create_object_programmatically: Request failed with status code 401",
    "w200"
  )
  assert.match(
    annotated,
    /^Error invoking create_object_programmatically: Request failed with status code 401\n\nSAP_LOGON_REJECTED: /
  )
  assert.match(annotated, /for connection "w200"/)
  assert.match(annotated, /passwordEnv/)
  assert.match(annotated, /whether the SAP user is locked/)
  assert.equal(annotated.split(LOGON_REJECTED).length - 1, 1)

  const untouched = "Error invoking read_smartform: Error 403: Forbidden"
  assert.equal(annotateLogonRejection(untouched, "w200"), untouched)
  assert.match(logonDiagnostic(), /SAP refused the logon itself/)
})

test("capability failures separate a rejected logon from a missing authorization", () => {
  const logon = capabilityFailure("syntax-diagnostics", logonError())
  assert.match(logon.message, /syntax-diagnostics capability logon-rejected \(HTTP 401\)/)
  assert.doesNotMatch(logon.message, /forbidden-or-not-authorized/)

  const forbidden = capabilityFailure("syntax-diagnostics", forbiddenError())
  assert.match(
    forbidden.message,
    /syntax-diagnostics capability forbidden-or-not-authorized \(HTTP 403\)/
  )

  // The established invariant stays: a status the library invented for a local defect is neither an
  // HTTP status nor a logon rejection.
  const fabricated = capabilityFailure(
    "version-history",
    Object.assign(new Error("Cannot read properties of undefined"), { status: 401 })
  )
  assert.doesNotMatch(fabricated.message, /HTTP \d{3}/)
  assert.doesNotMatch(fabricated.message, /logon-rejected/)
})

test("a rejected logon never becomes a repository-search authorization verdict", () => {
  const logon = classifyObjectSearchFailure(logonError())
  assert.equal(logon.status, "error")
  assert.match(logon.reason ?? "", /SAP refused the logon/)
  assert.match(logon.reason ?? "", /absence was not established/)

  const forbidden = classifyObjectSearchFailure(forbiddenError())
  assert.equal(forbidden.status, "forbidden")
  assert.match(forbidden.reason ?? "", /not authorized to search/)
})

/** A backend that answers reads the way w200 did during the 10:40 outage. */
class LogonRejectingBackend extends MockBackend {
  override async searchObjects(): Promise<AbapObjectInfo[]> {
    throw logonError()
  }
}

class ForbiddenBackend extends MockBackend {
  override async searchObjects(): Promise<AbapObjectInfo[]> {
    throw forbiddenError()
  }
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? []
  return content.map((item) => item.text ?? "").join("\n")
}

async function callObjectInfo(backend: MockBackend): Promise<{ isError: boolean; text: string }> {
  const stateRoot = await mkdtemp(join(tmpdir(), "abap-mcp-logon-state-"))
  const running = await startHttpServer(backend, 0, stateRoot)
  const client = new Client({ name: "logon-diagnostic-test", version: "0.1.0" })
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(running.mcpUrl)) as Parameters<Client["connect"]>[0]
    )
    const result = await client.callTool({
      name: "get_abap_object_info",
      arguments: { connectionId: "w200", objectName: "ZPMC_TP_SPLIT", objectType: "PROG/P" }
    })
    return { isError: result.isError === true, text: textOf(result) }
  } finally {
    await client.close()
    await running.close()
    await rm(stateRoot, { recursive: true, force: true })
  }
}

test("a rejected logon reaches the caller through the tool surface, a 403 does not", async () => {
  const logon = await callObjectInfo(new LogonRejectingBackend())
  assert.equal(logon.isError, true)
  assert.match(logon.text, /^Error invoking get_abap_object_info: /)
  assert.match(logon.text, /status code 401/)
  assert.match(logon.text, /SAP_LOGON_REJECTED: SAP refused the logon itself/)
  assert.match(logon.text, /for connection "w200"/)
  assert.match(logon.text, /passwordEnv/)
  assert.match(logon.text, /restart the service/)

  const forbidden = await callObjectInfo(new ForbiddenBackend())
  assert.equal(forbidden.isError, true)
  assert.match(forbidden.text, /403/)
  assert.doesNotMatch(forbidden.text, /SAP_LOGON_REJECTED/)
})
