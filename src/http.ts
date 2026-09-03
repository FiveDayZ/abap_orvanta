import { randomUUID } from "node:crypto"
import * as http from "node:http"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import type { SapBackend } from "./backend.js"
import { defaultInvocationStateRoot, InvocationReceiptStore } from "./invocation-receipts.js"
import { createMcpServer } from "./mcp.js"
import { WriteOperationReceiptStore } from "./write-operation-receipts.js"

export interface RunningServer {
  port: number
  mcpUrl: string
  close(): Promise<void>
}

export async function startHttpServer(
  backend: SapBackend,
  requestedPort = 4847,
  stateRoot = defaultInvocationStateRoot()
): Promise<RunningServer> {
  const transports = new Map<string, StreamableHTTPServerTransport>()
  const invocationReceipts = new InvocationReceiptStore(stateRoot)
  const writeReceipts = new WriteOperationReceiptStore(stateRoot)
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    if (url.pathname === "/health") {
      sendJson(response, 200, { status: "ok", server: "abap-mcp-standalone" })
      return
    }
    if (url.pathname !== "/mcp") {
      sendJson(response, 404, { error: "Not found" })
      return
    }

    const sessionId = request.headers["mcp-session-id"] as string | undefined
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
          await createMcpServer(backend, invocationReceipts, writeReceipts).connect(
            transport as Parameters<ReturnType<typeof createMcpServer>["connect"]>[0]
          )
        }
        if (!transport) {
          sendJson(response, 400, {
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Bad Request: No valid session ID provided"
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
      sendJson(response, 400, { error: "Invalid or missing session ID" })
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

  return {
    port: address.port,
    mcpUrl: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      await Promise.all([...transports.values()].map((transport) => transport.close()))
      await closeServer(server)
      await backend.close()
    }
  }
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

function isFetchBlockedPort(port: number): boolean {
  return port === 6000 || (port >= 6665 && port <= 6669) || port === 6697 || port === 10080
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
