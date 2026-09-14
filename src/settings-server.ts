import { createHash, randomBytes } from "node:crypto"
import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { createServer, type IncomingMessage } from "node:http"
import { dirname, join, resolve } from "node:path"
import { z } from "zod"
import { AdtBackend } from "./adt-backend.js"
import type { SapBackend } from "./backend.js"
import { parseConnections, type ConnectionConfig } from "./config.js"
import { isFetchBlockedPort, startHttpServer, type RunningServer } from "./http.js"
import { PRODUCT_VERSION } from "./version.js"

class SettingsError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

const connectionInput = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    url: z
      .string()
      .max(2048)
      .url()
      .refine((value) => {
        const url = new URL(value)
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          (url.pathname === "/" || url.pathname === "")
        )
      }),
    client: z.string().regex(/^\d{3}$/),
    language: z.string().regex(/^[A-Za-z]{2}$/),
    username: z.string().trim().min(1).max(80),
    passwordEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/),
    allowUnauthorized: z.boolean().default(false),
    atcVariant: z.string().trim().min(1).max(100).optional(),
    remoteFunctionAllowlist: z
      .array(z.string().regex(/^[ZY][A-Za-z0-9_]{0,29}$/i))
      .max(100)
      .default([])
  })
  .strict()
const documentInput = z.object({ connections: z.array(connectionInput).max(50) }).strict()
const passwordInput = z
  .object({
    connectionId: z.string().max(40),
    password: z.string().max(1024)
  })
  .strict()
const revisionOf = (text: string) => createHash("sha256").update(text).digest("hex")

export interface SettingsOptions {
  configPath: string
  assetsPath: string
  stateRoot: string
  port?: number
  backendFactory?: (
    connections: ConnectionConfig[],
    passwordFor: (config: ConnectionConfig) => string | undefined
  ) => SapBackend
}

export async function startSettingsServer(options: SettingsOptions) {
  const configPath = resolve(options.configPath)
  const token = randomBytes(32).toString("hex")
  const passwords = new Map<string, { value: string; identity: string }>()
  const identityOf = (config: ConnectionConfig) =>
    JSON.stringify([
      config.id,
      config.url,
      config.username,
      config.client,
      config.language,
      config.allowUnauthorized,
      config.passwordEnv,
      config.atcVariant,
      config.remoteFunctionAllowlist
    ])
  const passwordFor = (config: ConnectionConfig) => {
    const stored = passwords.get(config.id)
    return stored?.identity === identityOf(config) ? stored.value : undefined
  }
  const createBackend =
    options.backendFactory ??
    ((connections, passwordFor) => new AdtBackend(connections, passwordFor))
  let service: RunningServer | undefined
  let activeConnections: ConnectionConfig[] = []
  let busy = false
  let origin = ""
  let configIssue = ""
  const events: { time: string; message: string }[] = []
  const event = (message: string) => {
    events.unshift({ time: new Date().toISOString(), message })
    events.splice(20)
  }

  async function readConfig() {
    let raw = ""
    try {
      raw = await readFile(configPath, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    const document = raw
      ? documentInput.parse(JSON.parse(raw.replace(/^\uFEFF/, "")))
      : { connections: [] }
    const connections = document.connections.length ? parseConnections(document) : []
    return { revision: revisionOf(raw), connections }
  }

  async function state() {
    let config = { revision: "", connections: [] as ConnectionConfig[] }
    configIssue = ""
    try {
      config = await readConfig()
    } catch {
      configIssue = "配置文件无法读取或格式不兼容，原文件未修改。请先检查配置文件。"
    }
    return {
      version: PRODUCT_VERSION,
      configPath,
      stateRoot: resolve(options.stateRoot),
      configIssue,
      ...config,
      credentials: config.connections
        .filter((connection) => passwordFor(connection))
        .map((connection) => connection.id),
      service: {
        running: Boolean(service),
        connectionIds: activeConnections.map((connection) => connection.id),
        port: service?.port ?? null,
        url: service?.mcpUrl ?? null
      },
      events
    }
  }

  async function save(input: unknown) {
    const body = z
      .object({ revision: z.string(), connections: z.array(connectionInput).max(50) })
      .strict()
      .parse(input)
    const connections = body.connections.length
      ? parseConnections({ connections: body.connections })
      : []
    if (
      service &&
      activeConnections.some(
        (active) =>
          JSON.stringify(active) !==
          JSON.stringify(connections.find((connection) => connection.id === active.id))
      )
    )
      throw new SettingsError(409, "该连接正在被 MCP 服务使用，请先停止服务再修改或删除。")
    await mkdir(dirname(configPath), { recursive: true })
    let lock
    try {
      lock = await open(`${configPath}.settings-lock`, "wx")
    } catch {
      throw new SettingsError(409, "配置正在编辑或存在遗留保护锁，请核对其他配置窗口。")
    }
    const temporary = `${configPath}.${randomBytes(8).toString("hex")}.tmp`
    try {
      const previous = await readConfig()
      if (body.revision !== previous.revision)
        throw new SettingsError(409, "配置已被其他窗口修改，请刷新后重试。")
      const file = await open(temporary, "wx", 0o600)
      try {
        await file.writeFile(JSON.stringify({ connections }, null, 2) + "\n", "utf8")
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, configPath)
      // Credentials are bound to the entire saved connection, never just its label.
      for (const old of previous.connections) {
        if (JSON.stringify(old) !== JSON.stringify(connections.find((item) => item.id === old.id)))
          passwords.delete(old.id)
      }
      event("连接配置已保存")
    } finally {
      await rm(temporary, { force: true })
      await lock.close()
      await rm(`${configPath}.settings-lock`, { force: true })
    }
  }

  async function action(path: string, input: unknown) {
    if (path === "/api/config") return save(input)
    if (path === "/api/exit") {
      if (service) throw new SettingsError(409, "请先停止 MCP 服务，再关闭配置中心。")
      passwords.clear()
      return
    }
    if (path === "/api/password") {
      const body = passwordInput.parse(input)
      if (activeConnections.some((connection) => connection.id === body.connectionId))
        throw new SettingsError(409, "该连接正在被 MCP 服务使用，请先停止服务再替换密码。")
      const { connections } = await readConfig()
      const connection = connections.find((connection) => connection.id === body.connectionId)
      if (!connection) throw new SettingsError(404, "连接不存在。")
      if (body.password)
        passwords.set(body.connectionId, { value: body.password, identity: identityOf(connection) })
      else passwords.delete(body.connectionId)
      event(body.password ? "本次密码已设置（仅内存）" : "本次密码已清除")
      return
    }
    if (path === "/api/start") {
      if (service) throw new SettingsError(409, "服务已由本界面启动。")
      const { port, connectionIds } = z
        .object({
          port: z.number().int().min(1024).max(65535),
          connectionIds: z.array(z.string().min(1).max(40)).min(1).max(50).optional()
        })
        .strict()
        .parse(input)
      if (isFetchBlockedPort(port))
        throw new SettingsError(400, "该端口被浏览器限制，请选择其他端口。")
      const { connections } = await readConfig()
      if (!connections.length) throw new SettingsError(400, "请先添加并保存连接。")
      // Older clients omit the selection; only credential-ready connections are eligible.
      const ids =
        connectionIds ?? connections.filter(passwordFor).map((connection) => connection.id)
      if (!ids.length) throw new SettingsError(400, "请选择本次启用的连接并设置密码。")
      if (
        new Set(ids).size !== ids.length ||
        ids.some((id) => !connections.some((c) => c.id === id))
      )
        throw new SettingsError(400, "启用列表包含重复或不存在的连接，请刷新后重试。")
      const enabled = connections.filter((connection) => ids.includes(connection.id))
      const missing = enabled.filter((connection) => !passwordFor(connection))
      if (missing.length)
        throw new SettingsError(
          400,
          `请为本次启用的连接设置密码：${missing.map((c) => c.id).join("、")}。`
        )
      const backend = createBackend(enabled, passwordFor)
      try {
        service = await startHttpServer(backend, port, options.stateRoot)
      } catch (error) {
        await backend.close()
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE")
          throw new SettingsError(409, "端口已被占用，请选择其他端口。现有服务未停止。")
        throw error
      }
      activeConnections = enabled
      event(`MCP 服务已启动：${enabled.map((connection) => connection.id).join("、")}`)
      return
    }
    if (path === "/api/stop") {
      if (!service) throw new SettingsError(409, "本界面没有正在运行的服务。")
      try {
        await service.closeIfIdle()
      } catch (error) {
        if ((error as Error).message === "MCP_BUSY")
          throw new SettingsError(409, "仍有 MCP 操作正在执行，暂不能停止。请稍后重试。")
        throw error
      }
      service = undefined
      activeConnections = []
      event("MCP 服务已停止")
      return
    }
    if (path === "/api/test") {
      const { connectionId } = z
        .object({ connectionId: z.string().max(40) })
        .strict()
        .parse(input)
      const { connections } = await readConfig()
      const connection = connections.find((item) => item.id === connectionId)
      if (!connection) throw new SettingsError(404, "连接不存在。")
      if (!passwordFor(connection)) throw new SettingsError(400, "请先输入本次密码。")
      const backend = createBackend([connection], passwordFor)
      let adt = false
      let helper = false
      try {
        try {
          await backend.discoverySnapshot(connectionId)
          adt = true
        } catch {
          /* Report no SAP error body or credentials. */
        }
        try {
          const result = await backend.callSapHelper(connectionId, { operation: "PING" })
          helper = result.status === "S"
        } catch {
          /* A missing helper is not a failed ADT login. */
        }
      } finally {
        await backend.close()
      }
      event(adt ? "SAP ADT 连接测试通过" : "SAP ADT 连接测试未通过")
      return { adt, helper }
    }
    throw new SettingsError(404, "接口不存在。")
  }

  const assets: Record<string, [string, string]> = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/style.css": ["style.css", "text/css; charset=utf-8"]
  }
  for (const name of [
    "server",
    "plus",
    "trash-2",
    "copy",
    "play",
    "square",
    "refresh-cw",
    "shield-check"
  ]) {
    assets[`/icons/${name}.svg`] = [`icons/${name}.svg`, "image/svg+xml"]
  }
  const server = createServer(async (request, response) => {
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    }
    for (const [key, value] of Object.entries(headers)) response.setHeader(key, value)
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
      response.end(JSON.stringify(body))
    }
    try {
      if (
        request.headers.host !== new URL(origin).host ||
        (request.headers.origin && request.headers.origin !== origin) ||
        request.headers["sec-fetch-site"] === "cross-site"
      )
        throw new SettingsError(403, "仅允许本机配置页面访问。")
      const path = new URL(request.url ?? "/", origin).pathname
      if (assets[path] && request.method === "GET") {
        const [file, contentType] = assets[path]
        response.writeHead(200, { "Content-Type": contentType })
        response.end(await readFile(join(options.assetsPath, file)))
        return
      }
      if (request.headers.authorization !== `Bearer ${token}`)
        throw new SettingsError(401, "配置会话已失效，请重新打开配置中心。")
      if (path === "/api/state" && request.method === "GET") {
        json(200, await state())
        return
      }
      if (request.method !== "POST") throw new SettingsError(405, "不支持此操作。")
      if (
        request.headers.origin !== origin ||
        request.headers["content-type"] !== "application/json"
      )
        throw new SettingsError(403, "请求来源或格式不正确。")
      const input = await bodyJson(request)
      if (busy) throw new SettingsError(409, "另一项操作正在进行，请稍后重试。")
      busy = true
      try {
        const result = await action(path, input)
        json(200, { state: await state(), result: result ?? null })
        if (path === "/api/exit") server.close()
      } finally {
        busy = false
      }
    } catch (error) {
      if (!response.headersSent) {
        json(
          error instanceof SettingsError ? error.status : error instanceof z.ZodError ? 400 : 500,
          {
            error:
              error instanceof SettingsError
                ? error.message
                : error instanceof z.ZodError
                  ? "配置格式不正确。请检查地址、三位客户端、两位语言及连接标识；不要在地址中填写密码。"
                  : "操作未完成。请检查配置文件权限、连接设置和网络；原始错误内容未返回浏览器。"
          }
        )
      } else response.end()
    }
  })
  server.requestTimeout = 20_000
  await new Promise<void>((done, reject) => {
    server.once("error", reject)
    server.listen(options.port ?? 4851, "127.0.0.1", done)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Settings address unavailable")
  origin = `http://127.0.0.1:${address.port}`
  event("配置中心已就绪")
  return {
    url: `${origin}/#${token}`,
    origin,
    async close() {
      if (service) await service.closeIfIdle()
      service = undefined
      activeConnections = []
      passwords.clear()
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done()))
      )
    }
  }
}

async function bodyJson(request: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk)
    if (size > 128 * 1024) throw new SettingsError(413, "提交内容过大。")
    chunks.push(Buffer.from(chunk))
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new SettingsError(400, "提交内容不是有效 JSON。")
  }
}
