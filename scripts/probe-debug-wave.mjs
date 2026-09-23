import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const endpoint = new URL(process.env.ABAP_MCP_ENDPOINT || "http://127.0.0.1:4848/mcp")
const connectionId = process.env.ABAP_MCP_CONNECTION || "w200"
const baseUrl = (process.env.ABAP_MCP_SAP_BASE_URL || "https://sap.example.invalid:44300").replace(
  /\/$/,
  ""
)
const username = process.env.ABAP_MCP_SAP_USERNAME || "DEVELOPER"
const password = process.env.ABAP_MCP_W200_PASSWORD
const sapClient = process.env.ABAP_MCP_SAP_CLIENT || "200"
const language = process.env.ABAP_MCP_SAP_LANGUAGE || "EN"
const functionName = "ZCMCP_FM_1501"
const functionUri = "adt://w200/sap/bc/adt/functions/groups/zcmcp_fg_1501/fmodules/zcmcp_fm_1501"
const client = new Client({ name: "w200-debug-wave", version: "0.16.0" })

if (!password) throw new Error("ABAP_MCP_W200_PASSWORD is required")

function output(result) {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: { connectionId, ...args } })
  const text = output(result)
  if (result.isError) throw new Error(`${name}: ${text}`)
  return text
}

async function status() {
  return JSON.parse(await call("abap_debug_status", {}))
}

async function waitForState(expected, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let current
  do {
    current = await status()
    if (current.state === expected) return current
    if (current.state === "error") throw new Error(`Debugger listener failed: ${current.lastError}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  } while (Date.now() < deadline)
  throw new Error(`Timed out waiting for debugger state ${expected}; last state ${current?.state}`)
}

function sourceLines(response) {
  const match = response.match(/```abap\n([\s\S]*?)\n```/)
  if (!match) throw new Error("Could not parse the active function source")
  return match[1].split("\n")
}

function invokeSoap() {
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <n1:${functionName} xmlns:n1="urn:sap-com:document:sap:rfc:functions">
      <IV_INPUT>VALIDATION</IV_INPUT>
    </n1:${functionName}>
  </soapenv:Body>
</soapenv:Envelope>`
  return fetch(`${baseUrl}/sap/bc/soap/rfc?sap-client=${sapClient}&sap-language=${language}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`,
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: `urn:sap-com:document:sap:rfc:functions:${functionName}`
    },
    body: envelope,
    signal: AbortSignal.timeout(90_000)
  }).then(async (response) => ({
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    body: await response.text()
  }))
}

let breakpointLine
let sessionStarted = false
let breakpointSet = false
let soapPromise
let stage = "connect-mcp"

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint))
  stage = "read-baseline"
  const before = JSON.parse(await call("read_function_module_interface", { functionName }))
  const assignmentBefore = JSON.parse(
    await call("inspect_repository_assignment", {
      objectName: functionName,
      objectType: "FUGR/FF"
    })
  )
  const source = await call("get_object_by_uri", {
    uri: functionUri,
    startLine: 0,
    lineCount: 2000
  })
  const lines = sourceLines(source)
  const breakpointIndex = lines.findIndex((line) => /IF\s+iv_input\s+IS\s+INITIAL/i.test(line))
  if (breakpointIndex < 0) throw new Error("Could not locate the approved validation statement")
  breakpointLine = breakpointIndex + 1

  stage = "start-debug-session"
  await call("abap_debug_session", { action: "start" })
  sessionStarted = true
  stage = "set-breakpoint"
  const breakpoint = JSON.parse(
    await call("abap_debug_breakpoint", {
      action: "set",
      filePath: functionUri,
      lineNumbers: [breakpointLine]
    })
  )
  if (!breakpoint.breakpoints?.[0]?.verified) {
    throw new Error(`SAP did not verify breakpoint line ${breakpointLine}`)
  }
  breakpointSet = true

  stage = "invoke-soap-and-wait"
  soapPromise = invokeSoap()
  const paused = await waitForState("paused")
  const stack = JSON.parse(await call("abap_debug_stack", { threadId: 1 }))
  if (!stack.length) throw new Error("Paused debugger returned an empty stack")
  const variable = JSON.parse(
    await call("abap_debug_variable", {
      threadId: 1,
      frameId: stack[0].frameId,
      variableName: "IV_INPUT"
    })
  )
  const inputValue = variable.variables?.[0]?.value
  if (inputValue !== "VALIDATION") {
    throw new Error(`Unexpected IV_INPUT value: ${inputValue}`)
  }

  const stepped = JSON.parse(await call("abap_debug_step", { threadId: 1, stepType: "stepOver" }))
  if (stepped.state !== "paused") throw new Error("stepOver did not return to paused state")
  const continued = JSON.parse(await call("abap_debug_step", { threadId: 1, stepType: "continue" }))
  const soap = await soapPromise
  soapPromise = undefined
  const outputMatch = soap.body.match(
    /<(?:\w+:)?EV_OUTPUT(?:\s[^>]*)?>(.*?)<\/(?:\w+:)?EV_OUTPUT>/is
  )
  const actualOutput = (outputMatch?.[1] || "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
  if (soap.status !== 200 || actualOutput !== "MCP:VALIDATION") {
    throw new Error(`SOAP validation failed with HTTP ${soap.status} and output ${actualOutput}`)
  }

  await call("abap_debug_breakpoint", {
    action: "remove",
    filePath: functionUri,
    lineNumbers: [breakpointLine]
  })
  breakpointSet = false
  await call("abap_debug_session", { action: "stop" })
  sessionStarted = false

  const after = JSON.parse(await call("read_function_module_interface", { functionName }))
  const assignmentAfter = JSON.parse(
    await call("inspect_repository_assignment", {
      objectName: functionName,
      objectType: "FUGR/FF"
    })
  )
  const sourceUnchanged = before.fingerprint === after.fingerprint
  const assignmentUnchanged = JSON.stringify(assignmentBefore) === JSON.stringify(assignmentAfter)
  if (!sourceUnchanged || !assignmentUnchanged) {
    throw new Error("Read-only debugger validation changed source or repository assignment")
  }

  stage = "complete"
  console.log(
    JSON.stringify(
      {
        endpoint: endpoint.href,
        connectionId,
        functionName,
        breakpoint: { line: breakpointLine, verified: true, removed: true },
        paused: {
          state: paused.state,
          program: paused.debuggee?.program,
          include: paused.debuggee?.include,
          line: paused.debuggee?.line
        },
        stack: { frames: stack.length, top: stack[0] },
        variable: { name: "IV_INPUT", value: inputValue },
        stepOver: { state: stepped.state, topFrame: stepped.topFrame },
        continue: continued,
        soap: { status: soap.status, contentType: soap.contentType, actualOutput },
        safety: {
          sourceFingerprintBefore: before.fingerprint,
          sourceFingerprintAfter: after.fingerprint,
          sourceUnchanged,
          assignmentUnchanged,
          sessionStopped: true
        }
      },
      null,
      2
    )
  )
} catch (error) {
  console.log(
    JSON.stringify(
      {
        endpoint: endpoint.href,
        connectionId,
        functionName,
        status: "failed",
        stage,
        error: error instanceof Error ? error.message : String(error),
        safety: {
          soapInvoked: Boolean(soapPromise),
          breakpointSet,
          sessionStarted
        }
      },
      null,
      2
    )
  )
  process.exitCode = 1
} finally {
  if (soapPromise) soapPromise.catch(() => undefined)
  if (breakpointSet && breakpointLine) {
    await call("abap_debug_breakpoint", {
      action: "remove",
      filePath: functionUri,
      lineNumbers: [breakpointLine]
    }).catch(() => undefined)
  }
  if (sessionStarted) {
    const current = await status().catch(() => undefined)
    if (current?.state === "paused") {
      await call("abap_debug_step", { threadId: 1, stepType: "continue" }).catch(() => undefined)
    }
    await call("abap_debug_session", { action: "stop" }).catch(() => undefined)
  }
  await client.close()
}
