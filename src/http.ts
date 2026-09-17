import { randomUUID } from "node:crypto"
import * as http from "node:http"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import type { SapBackend } from "./backend.js"
import { defaultInvocationStateRoot, InvocationReceiptStore } from "./invocation-receipts.js"
import { createMcpServer } from "./mcp.js"
import { WriteOperationReceiptStore } from "./write-operation-receipts.js"
import { RuntimeIdentity } from "./runtime-info.js"
import { PRODUCT_VERSION } from "./version.js"

export interface RunningServer {
  port: number
  mcpUrl: string
  close(): Promise<void>
  closeIfIdle(): Promise<void>
}

export async function startHttpServer(
  backend: SapBackend,
  requestedPort = 4847,
  stateRoot = defaultInvocationStateRoot()
): Promise<RunningServer> {
  if (requestedPort !== 0 && isFetchBlockedPort(requestedPort)) {
    throw new Error("MCP_PORT_BLOCKED")
  }
  const transports = new Map<string, StreamableHTTPServerTransport>()
  const invocationReceipts = new InvocationReceiptStore(stateRoot)
  const writeReceipts = new WriteOperationReceiptStore(stateRoot)
  const runtimeIdentity = new RuntimeIdentity()
  let activeOperations = 0
  let accepting = true
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    if (url.pathname === "/health") {
      sendJson(response, 200, {
        status: "ok",
        server: "abap-mcp-standalone",
        version: PRODUCT_VERSION,
        startedAt: runtimeIdentity.startedAt
      })
      return
    }
    if (url.pathname !== "/mcp") {
      sendJson(response, 404, { error: "Not found" })
      return
    }

    const sessionId = request.headers["mcp-session-id"] as string | undefined
    if (!accepting) {
      sendJson(response, 503, { error: "Service is stopping" })
      return
    }
    try {
      if (request.method === "POST") {
        const body = await parseJsonBody(request)
        let transport = sessionId ? transports.get(sessionId) : undefined
        if (!transport && !sessionId && isInitializeRequest(body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              transports.set(id, transport!)
            }
          })
          transport.onclose = () => {
            if (transport?.sessionId) transports.delete(transport.sessionId)
          }
          // SDK 1.29 transport types are not exactOptionalPropertyTypes-clean,
          // although this is the SDK's matching server transport implementation.
          await createMcpServer(
            backend,
            invocationReceipts,
            writeReceipts,
            () => {
              if (!accepting) throw new Error("Service is stopping")
              activeOperations++
              return () => {
                activeOperations--
              }
            },
            stateRoot,
            runtimeIdentity
          ).connect(transport as Parameters<ReturnType<typeof createMcpServer>["connect"]>[0])
        }
        if (!transport) {
          sendJson(response, sessionId ? 404 : 400, {
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: sessionId
                ? "MCP session not found; initialize a new session"
                : "Bad Request: No valid session ID provided"
            },
            id: null
          })
          return
        }
        await transport.handleRequest(request, response, body)
        return
      }

      const transport = sessionId ? transports.get(sessionId) : undefined
      if ((request.method === "GET" || request.method === "DELETE") && transport) {
        await transport.handleRequest(request, response)
        return
      }
      sendJson(response, sessionId ? 404 : 400, {
        error: sessionId
          ? "MCP session not found; initialize a new session"
          : "Invalid or missing session ID"
      })
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, 500, { error: String(error) })
      }
    }
  })

  let address: ReturnType<typeof server.address>
  do {
    await listen(server, requestedPort)
    address = server.address()
    if (address && typeof address !== "string" && isFetchBlockedPort(address.port)) {
      await closeServer(server)
      address = null
    }
  } while (!address)
  if (!address || typeof address === "string") throw new Error("Could not determine server port")

  const running: RunningServer = {
    port: address.port,
    mcpUrl: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      await Promise.all([...transports.values()].map((transport) => transport.close()))
      await closeServer(server)
      await backend.close()
    },
    async closeIfIdle() {
      // Track tool completion, not SSE lifetime or a disconnected HTTP caller.
      if (activeOperations > 0) throw new Error("MCP_BUSY")
      accepting = false
      await running.close()
    }
  }
  return running
}

async function listen(server: http.Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", resolve)
  })
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
}

export function isFetchBlockedPort(port: number): boolean {
  // Node's bundled fetch/Undici bad-port list; applies to explicit and ephemeral listeners.
  return [
    1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
    103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
    512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
    995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
    6669, 6679, 6697, 10080
  ].includes(port)
}

async function parseJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const body = Buffer.concat(chunks).toString("utf8")
  return body ? JSON.parse(body) : {}
}

function sendJson(response: http.ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" })
  response.end(JSON.stringify(body))
}
