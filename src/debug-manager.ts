import { randomUUID } from "node:crypto"
import type {
  ADTClient,
  DebugBreakpoint,
  DebugBreakpointError,
  Debuggee,
  DebugStack,
  DebugStackInfo,
  DebugVariable
} from "abap-adt-api"
import { fromError, isDebuggee, isDebuggerBreakpoint, isDebugListenerError } from "abap-adt-api"

export type HeadlessDebugState =
  | "idle"
  | "listening"
  | "attaching"
  | "paused"
  | "running"
  | "stopping"
  | "error"

export interface DebugSessionRequest {
  action: "start" | "stop" | "status"
  debugUser?: string | undefined
  terminalMode?: boolean | undefined
}

export interface DebugSessionInfo {
  connectionId: string
  state: HeadlessDebugState
  mode: "user"
  debugUser: string
  startedAt?: string | undefined
  lastActivity?: string | undefined
  breakpointCount: number
  debuggee?:
    | {
        program: string
        include: string
        line: number
        kind: string
      }
    | undefined
  lastError?: string | undefined
}

export interface DebugBreakpointRequest {
  action: "set" | "remove"
  fileUri: string
  sourceUri: string
  lineNumbers: number[]
  condition?: string | undefined
}

export interface DebugBreakpointInfo {
  fileUri: string
  sourceUri: string
  action: "set" | "remove"
  breakpoints: Array<{
    line: number
    verified: boolean
    id?: string | undefined
    message?: string | undefined
  }>
}

export interface DebugStackFrameInfo {
  frameId: number
  threadId: 1
  stackPosition: number
  program: string
  include: string
  line: number
  eventType: string
  eventName: string
  sourceUri: string
  systemProgram: boolean
}

export interface DebugVariableRequest {
  threadId: number
  frameId: number
  variableName?: string | undefined
  expression?: string | undefined
  rowStart: number
  rowCount: number
  scopeName?: string | undefined
  filter?: string | undefined
  maxVariables: number
  filterPattern?: string | undefined
  expandStructures: boolean
  expandTables: boolean
}

export interface DebugVariableInfo {
  frameId: number
  query?: string | undefined
  scopes?: string[] | undefined
  variables: Array<{
    id: string
    name: string
    declaredType: string
    actualType: string
    metaType: string
    value: string
    tableLines: number
    incomplete: boolean
  }>
  children?: DebugVariableInfo["variables"] | undefined
  rowStart?: number | undefined
  rowCount?: number | undefined
  totalRows?: number | undefined
}

export interface DebugStepRequest {
  threadId: number
  stepType: "continue" | "stepInto" | "stepOver" | "stepReturn" | "jumpToLine"
  targetLine?: number | undefined
}

export interface DebugStepInfo {
  state: "paused" | "listening"
  stepType: DebugStepRequest["stepType"]
  debuggeeEnded: boolean
  topFrame?: DebugStackFrameInfo | undefined
}

export interface DebugClientFactory {
  listenerClient(connectionId: string): Promise<ADTClient>
  attachedClient(connectionId: string): Promise<ADTClient>
  username(connectionId: string): string
}

interface StoredBreakpoint {
  fileUri: string
  sourceUri: string
  line: number
  condition?: string | undefined
  native: DebugBreakpoint
}

interface DebugRuntime {
  connectionId: string
  debugUser: string
  terminalId: string
  ideId: string
  listener: ADTClient
  state: HeadlessDebugState
  active: boolean
  startedAt: string
  lastActivity: string
  breakpoints: Map<string, StoredBreakpoint[]>
  loop?: Promise<void> | undefined
  attached?: ADTClient | undefined
  debuggee?: Debuggee | undefined
  stack?: DebugStackInfo | undefined
  lastError?: string | undefined
  releaseAttached?: (() => void) | undefined
  attachedReleased?: Promise<void> | undefined
}

const FRAME_BASE = 1_000_000_000_000
type ExecutableDebugStep = "stepContinue" | "stepInto" | "stepOver" | "stepReturn"

export class HeadlessDebugManager {
  private readonly sessions = new Map<string, DebugRuntime>()

  constructor(private readonly factory: DebugClientFactory) {}

  async session(connectionId: string, request: DebugSessionRequest): Promise<DebugSessionInfo> {
    const id = connectionId.toLowerCase()
    if (request.action === "status") return this.status(id)
    if (request.action === "stop") {
      const runtime = this.sessions.get(id)
      if (runtime) await this.stopRuntime(runtime)
      return this.status(id)
    }

    if (request.terminalMode) {
      throw new Error("terminalMode is not supported; use current-user debugging")
    }
    if (this.sessions.has(id)) {
      throw new Error(`A debug session already exists for connection ${id}; stop it first`)
    }

    const configuredUser = this.factory.username(id).trim().toUpperCase()
    const debugUser = (request.debugUser || configuredUser).trim().toUpperCase()
    if (debugUser !== configuredUser) {
      throw new Error(
        `Refusing to debug user ${debugUser}; the standalone service only allows the configured SAP user ${configuredUser}`
      )
    }

    const listener = await this.factory.listenerClient(id)
    const terminalId = randomId()
    const ideId = randomId()
    let conflict
    try {
      conflict = await listener.debuggerListeners("user", terminalId, ideId, debugUser, true)
    } catch (error) {
      throw debuggerCapabilityFailure(error)
    }
    if (conflict) {
      throw new Error(
        `SAP debugger listener conflict: ${conflict.conflictText || conflict.localizedMessage?.text || conflict.message?.text || conflict.type}`
      )
    }

    const now = new Date().toISOString()
    const runtime: DebugRuntime = {
      connectionId: id,
      debugUser,
      terminalId,
      ideId,
      listener,
      state: "listening",
      active: true,
      startedAt: now,
      lastActivity: now,
      breakpoints: new Map()
    }
    this.sessions.set(id, runtime)
    runtime.loop = this.listen(runtime).catch((error) => {
      if (!runtime.active) return
      runtime.state = "error"
      runtime.lastError = errorText(error)
      runtime.lastActivity = new Date().toISOString()
      runtime.active = false
    })
    return this.status(id)
  }

  status(connectionId: string): DebugSessionInfo {
    const id = connectionId.toLowerCase()
    const runtime = this.sessions.get(id)
    if (!runtime) {
      return {
        connectionId: id,
        state: "idle",
        mode: "user",
        debugUser: this.factory.username(id).trim().toUpperCase(),
        breakpointCount: 0
      }
    }
    return {
      connectionId: id,
      state: runtime.state,
      mode: "user",
      debugUser: runtime.debugUser,
      startedAt: runtime.startedAt,
      lastActivity: runtime.lastActivity,
      breakpointCount: [...runtime.breakpoints.values()].reduce(
        (count, values) => count + values.length,
        0
      ),
      ...(runtime.debuggee
        ? {
            debuggee: {
              program: runtime.debuggee.PRG_CURR,
              include: runtime.debuggee.INCL_CURR,
              line: runtime.debuggee.LINE_CURR,
              kind: runtime.debuggee.DBGEE_KIND
            }
          }
        : {}),
      ...(runtime.lastError ? { lastError: runtime.lastError } : {})
    }
  }

  async breakpoints(
    connectionId: string,
    request: DebugBreakpointRequest
  ): Promise<DebugBreakpointInfo> {
    const runtime = this.requireRuntime(connectionId)
    if (runtime.state === "error" || runtime.state === "stopping") {
      throw new Error(`Cannot manage breakpoints while debug session state is ${runtime.state}`)
    }
    const existing = runtime.breakpoints.get(request.fileUri) ?? []
    if (request.action === "remove") {
      const removing = existing.filter((item) => request.lineNumbers.includes(item.line))
      for (const item of removing) await this.deleteBreakpoint(runtime, item)
      const retained = existing.filter((item) => !request.lineNumbers.includes(item.line))
      if (retained.length) runtime.breakpoints.set(request.fileUri, retained)
      else runtime.breakpoints.delete(request.fileUri)
      this.touch(runtime)
      return {
        fileUri: request.fileUri,
        sourceUri: request.sourceUri,
        action: "remove",
        breakpoints: request.lineNumbers.map((line) => ({
          line,
          verified: removing.some((item) => item.line === line)
        }))
      }
    }

    if (request.condition && /[<>&"']/.test(request.condition)) {
      throw new Error("condition contains XML metacharacters unsupported by the SAP debugger API")
    }
    const desired = [
      ...existing.filter((item) => !request.lineNumbers.includes(item.line)),
      ...request.lineNumbers.map((line) => ({
        fileUri: request.fileUri,
        sourceUri: request.sourceUri,
        line,
        ...(request.condition ? { condition: request.condition } : {})
      }))
    ].sort((left, right) => left.line - right.line)
    const clientId = `24:standalone:${runtime.connectionId}:${request.sourceUri}`
    const requested = desired.map((item) => `${item.sourceUri}#start=${item.line}`)
    let native = await runtime.listener.debuggerSetBreakpoints(
      "user",
      runtime.terminalId,
      runtime.ideId,
      clientId,
      requested,
      runtime.debugUser,
      "external",
      false,
      false,
      request.sourceUri
    )
    const confirmed = native.filter(isDebuggerBreakpoint)
    if (request.condition) {
      const condition = request.condition
      native = await runtime.listener.debuggerSetBreakpoints(
        "user",
        runtime.terminalId,
        runtime.ideId,
        clientId,
        confirmed.map((item) =>
          request.lineNumbers.includes(item.uri.range.start.line) ? { ...item, condition } : item
        ),
        runtime.debugUser,
        "external",
        false,
        false,
        request.sourceUri
      )
    }
    const finalBreakpoints = native.filter(isDebuggerBreakpoint)
    const stored: StoredBreakpoint[] = desired.flatMap((item) => {
      const match = finalBreakpoints.find((value) => value.uri.range.start.line === item.line)
      return match ? [{ ...item, native: match }] : []
    })
    runtime.breakpoints.set(request.fileUri, stored)
    if (runtime.attached && stored.length) {
      await runtime.attached.debuggerSetBreakpoints(
        "user",
        runtime.terminalId,
        runtime.ideId,
        clientId,
        stored.map((item) => item.native),
        runtime.debugUser,
        "debugger",
        false,
        false,
        request.sourceUri
      )
    }
    this.touch(runtime)
    return {
      fileUri: request.fileUri,
      sourceUri: request.sourceUri,
      action: "set",
      breakpoints: request.lineNumbers.map((line) => {
        const match = stored.find((item) => item.line === line)
        const failure = native.find(
          (item): item is DebugBreakpointError =>
            !isDebuggerBreakpoint(item) && item.clientId === clientId
        )
        return {
          line,
          verified: Boolean(match),
          ...(match?.native.id ? { id: match.native.id } : {}),
          ...(!match && failure ? { message: failure.errorMessage } : {})
        }
      })
    }
  }

  async stack(connectionId: string, threadId: number): Promise<DebugStackFrameInfo[]> {
    if (threadId !== 1) throw new Error("The standalone debugger supports one thread (threadId=1)")
    const runtime = this.requirePaused(connectionId)
    runtime.stack = await runtime.attached!.debuggerStackTrace(false)
    this.touch(runtime)
    return mapStack(runtime.connectionId, runtime.stack.stack)
  }

  async variables(connectionId: string, request: DebugVariableRequest): Promise<DebugVariableInfo> {
    if (request.threadId !== 1) {
      throw new Error("The standalone debugger supports one thread (threadId=1)")
    }
    if (request.variableName && request.expression) {
      throw new Error("Provide variableName or expression, not both")
    }
    const runtime = this.requirePaused(connectionId)
    await this.selectFrame(runtime, request.frameId)
    const client = runtime.attached!
    const query = request.variableName || request.expression
    if (query && !isSafeVariableQuery(query)) {
      throw new Error(
        "Variable queries may contain only an ABAP identifier, components, object references, or a numeric table index"
      )
    }

    if (!query) {
      const root = await client.debuggerChildVariables(["@ROOT"])
      const scopes = root.hierarchies.map((item) => item.CHILD_NAME || item.CHILD_ID)
      let variables = root.variables
      if (request.scopeName) {
        const scope = root.hierarchies.find(
          (item) =>
            (item.CHILD_NAME || item.CHILD_ID).toUpperCase() === request.scopeName!.toUpperCase()
        )
        if (!scope) throw new Error(`Debug scope not found: ${request.scopeName}`)
        variables = (await client.debuggerChildVariables([scope.CHILD_ID])).variables
      }
      variables = filterVariables(variables, request.filterPattern).slice(0, request.maxVariables)
      this.touch(runtime)
      return {
        frameId: request.frameId,
        scopes,
        variables: variables.map(mapVariable)
      }
    }

    const variable = (await client.debuggerVariables([query]))[0]
    if (!variable) throw new Error(`Debug variable or expression not found: ${query}`)
    let children: DebugVariable[] = []
    let rowStart: number | undefined
    let rowCount: number | undefined
    if (variable.META_TYPE === "table" && request.expandTables) {
      const end = Math.min(variable.TABLE_LINES, request.rowStart + request.rowCount)
      const keys = Array.from(
        { length: Math.max(0, end - request.rowStart) },
        (_, index) => `${variable.ID.replace(/\[\]$/, "")}[${request.rowStart + index + 1}]`
      )
      children = keys.length ? await client.debuggerVariables(keys) : []
      if (request.filter) {
        const filter = request.filter.toUpperCase()
        children = children.filter((item) =>
          `${item.NAME} ${item.VALUE} ${item.ACTUAL_TYPE_NAME}`.toUpperCase().includes(filter)
        )
      }
      rowStart = request.rowStart
      rowCount = children.length
    } else if (variable.META_TYPE === "structure" && request.expandStructures) {
      children = (await client.debuggerChildVariables([variable.ID])).variables
    }
    children = filterVariables(children, request.filterPattern).slice(0, request.maxVariables)
    this.touch(runtime)
    return {
      frameId: request.frameId,
      query,
      variables: [mapVariable(variable)],
      ...(children.length ? { children: children.map(mapVariable) } : {}),
      ...(rowStart !== undefined ? { rowStart } : {}),
      ...(rowCount !== undefined ? { rowCount } : {}),
      ...(variable.META_TYPE === "table" ? { totalRows: variable.TABLE_LINES } : {})
    }
  }

  async step(connectionId: string, request: DebugStepRequest): Promise<DebugStepInfo> {
    if (request.threadId !== 1) throw new Error("The standalone debugger supports one thread")
    if (request.stepType === "jumpToLine" || request.targetLine !== undefined) {
      throw new Error("jumpToLine is intentionally disabled because it changes control flow")
    }
    const runtime = this.requirePaused(connectionId)
    const method: Record<
      Exclude<DebugStepRequest["stepType"], "jumpToLine">,
      ExecutableDebugStep
    > = {
      continue: "stepContinue",
      stepInto: "stepInto",
      stepOver: "stepOver",
      stepReturn: "stepReturn"
    }
    runtime.state = "running"
    this.touch(runtime)
    try {
      await runtime.attached!.debuggerStep(method[request.stepType])
      runtime.stack = await runtime.attached!.debuggerStackTrace(false)
      runtime.state = "paused"
      this.touch(runtime)
      const topFrame = mapStack(runtime.connectionId, runtime.stack.stack)[0]
      return {
        state: "paused",
        stepType: request.stepType,
        debuggeeEnded: false,
        ...(topFrame ? { topFrame } : {})
      }
    } catch (error) {
      if (!debuggeeEnded(error)) {
        runtime.state = "paused"
        throw error
      }
      await this.releaseDebuggee(runtime)
      runtime.state = "listening"
      this.touch(runtime)
      return { state: "listening", stepType: request.stepType, debuggeeEnded: true }
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((runtime) => this.stopRuntime(runtime)))
  }

  private async listen(runtime: DebugRuntime): Promise<void> {
    while (runtime.active) {
      const response = await runtime.listener.debuggerListen(
        "user",
        runtime.terminalId,
        runtime.ideId,
        runtime.debugUser,
        true,
        true
      )
      if (!runtime.active) break
      if (!response) continue
      if (isDebugListenerError(response)) {
        throw new Error(
          response.conflictText || response.localizedMessage?.text || response.message?.text
        )
      }
      if (!isDebuggee(response)) continue
      if (runtime.attached) {
        await this.resumeUnmanagedDebuggee(runtime, response)
        continue
      }
      await this.attach(runtime, response)
      if (runtime.attachedReleased) await runtime.attachedReleased
    }
  }

  private async attach(runtime: DebugRuntime, debuggee: Debuggee): Promise<void> {
    runtime.state = "attaching"
    runtime.debuggee = debuggee
    this.touch(runtime)
    const client = await this.factory.attachedClient(runtime.connectionId)
    runtime.attached = client
    let releaseAttached: (() => void) | undefined
    runtime.attachedReleased = new Promise<void>((resolve) => {
      releaseAttached = resolve
    })
    runtime.releaseAttached = releaseAttached
    try {
      await client.debuggerAttach("user", debuggee.DEBUGGEE_ID, runtime.debugUser, true)
      await client.debuggerSaveSettings({}).catch(() => undefined)
      for (const values of runtime.breakpoints.values()) {
        if (!values.length) continue
        await client.debuggerSetBreakpoints(
          "user",
          runtime.terminalId,
          runtime.ideId,
          `24:standalone:${runtime.connectionId}:${values[0]!.sourceUri}`,
          values.map((item) => item.native),
          runtime.debugUser,
          "debugger",
          false,
          false,
          values[0]!.sourceUri
        )
      }
      runtime.stack = await client.debuggerStackTrace(false)
      runtime.state = "paused"
      this.touch(runtime)
    } catch (error) {
      await this.releaseDebuggee(runtime)
      throw error
    }
  }

  private async resumeUnmanagedDebuggee(runtime: DebugRuntime, debuggee: Debuggee): Promise<void> {
    const client = await this.factory.attachedClient(runtime.connectionId)
    try {
      await client.debuggerAttach("user", debuggee.DEBUGGEE_ID, runtime.debugUser, true)
      while (true) await client.debuggerStep("stepContinue")
    } catch (error) {
      if (!debuggeeEnded(error)) throw error
    } finally {
      await client.logout().catch(() => client.dropSession().catch(() => undefined))
    }
  }

  private async selectFrame(runtime: DebugRuntime, frameId: number): Promise<void> {
    runtime.stack = await runtime.attached!.debuggerStackTrace(false)
    const index = frameId - FRAME_BASE
    const frame = Number.isSafeInteger(index) ? runtime.stack.stack[index] : undefined
    if (!frame) throw new Error(`Invalid frameId ${frameId}; call abap_debug_stack again`)
    if ("stackUri" in frame && frame.stackUri) {
      await runtime.attached!.debuggerGoToStack(frame.stackUri)
    } else {
      await runtime.attached!.debuggerGoToStack(frame.stackPosition)
    }
  }

  private async deleteBreakpoint(runtime: DebugRuntime, item: StoredBreakpoint): Promise<void> {
    await runtime.listener.debuggerDeleteBreakpoints(
      item.native,
      "user",
      runtime.terminalId,
      runtime.ideId,
      runtime.debugUser,
      "external"
    )
    if (runtime.attached) {
      await runtime.attached
        .debuggerDeleteBreakpoints(
          item.native,
          "user",
          runtime.terminalId,
          runtime.ideId,
          runtime.debugUser,
          "debugger"
        )
        .catch(() => undefined)
    }
  }

  private async releaseDebuggee(runtime: DebugRuntime): Promise<void> {
    const client = runtime.attached
    runtime.attached = undefined
    runtime.debuggee = undefined
    runtime.stack = undefined
    runtime.releaseAttached?.()
    runtime.releaseAttached = undefined
    runtime.attachedReleased = undefined
    if (client) await client.logout().catch(() => client.dropSession().catch(() => undefined))
  }

  private async stopRuntime(runtime: DebugRuntime): Promise<void> {
    runtime.state = "stopping"
    runtime.active = false
    this.touch(runtime)
    for (const values of runtime.breakpoints.values()) {
      for (const item of values) await this.deleteBreakpoint(runtime, item).catch(() => undefined)
    }
    runtime.breakpoints.clear()
    await runtime.listener
      .debuggerDeleteListener("user", runtime.terminalId, runtime.ideId, runtime.debugUser)
      .catch(() => undefined)
    if (runtime.attached) {
      const attached = runtime.attached
      const released = await completesWithin(
        attached.debuggerStep("stepContinue").then(
          () => true,
          () => true
        ),
        5_000
      )
      if (!released) await attached.dropSession().catch(() => undefined)
    }
    await this.releaseDebuggee(runtime)
    this.sessions.delete(runtime.connectionId)
  }

  private requireRuntime(connectionId: string): DebugRuntime {
    const id = connectionId.toLowerCase()
    const runtime = this.sessions.get(id)
    if (!runtime) throw new Error(`No active debug session for connection ${id}`)
    return runtime
  }

  private requirePaused(connectionId: string): DebugRuntime {
    const runtime = this.requireRuntime(connectionId)
    if (runtime.state !== "paused" || !runtime.attached) {
      throw new Error(`Debug session is not paused; current state is ${runtime.state}`)
    }
    return runtime
  }

  private touch(runtime: DebugRuntime): void {
    runtime.lastActivity = new Date().toISOString()
  }
}

function randomId(): string {
  return randomUUID().replaceAll("-", "").toUpperCase()
}

function mapStack(connectionId: string, stack: DebugStack[]): DebugStackFrameInfo[] {
  return stack.map((frame, index) => ({
    frameId: FRAME_BASE + index,
    threadId: 1,
    stackPosition: frame.stackPosition,
    program: frame.programName,
    include: String(frame.includeName),
    line: frame.line,
    eventType: frame.eventType,
    eventName: String(frame.eventName),
    sourceUri: `adt://${connectionId}${frame.uri.uri}`,
    systemProgram: frame.systemProgram
  }))
}

function mapVariable(variable: DebugVariable): DebugVariableInfo["variables"][number] {
  return {
    id: variable.ID,
    name: variable.NAME,
    declaredType: variable.DECLARED_TYPE_NAME,
    actualType: variable.ACTUAL_TYPE_NAME,
    metaType: variable.META_TYPE,
    value: variable.VALUE,
    tableLines: variable.TABLE_LINES,
    incomplete: variable.IS_VALUE_INCOMPLETE === "X"
  }
}

function filterVariables(variables: DebugVariable[], pattern?: string): DebugVariable[] {
  if (!pattern) return variables
  const regex = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", ".*")
      .replaceAll("?", ".")}$`,
    "i"
  )
  return variables.filter((item) => regex.test(item.NAME))
}

function isSafeVariableQuery(query: string): boolean {
  return /^[A-Z_%<>][A-Z0-9_%<>]*(?:->|=>|-)[A-Z0-9_%<>-]+(?:\[\d+\])?$|^[A-Z_%<>][A-Z0-9_%<>]*(?:\[\d+\])?$/i.test(
    query.trim()
  )
}

function debuggeeEnded(error: unknown): boolean {
  const value = error as {
    properties?: Record<string, unknown>
    message?: string
  }
  return (
    value.properties?.["com.sap.adt.communicationFramework.subType"] === "debuggeeEnded" ||
    /debuggee.*ended|debug session.*ended/i.test(value.message ?? "")
  )
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function debuggerCapabilityFailure(error: unknown): Error {
  const adtError = fromError(error)
  const reportedStatus =
    "status" in adtError ? adtError.status : "err" in adtError ? adtError.err : 0
  const message = adtError.message || String(error)
  const messageStatus = message.match(/(?:status code|error)\s+(\d{3})/i)?.[1]
  const parsedStatus = messageStatus ? Number.parseInt(messageStatus, 10) : 0
  const status = reportedStatus >= 500 && parsedStatus ? parsedStatus : reportedStatus
  let category = "request-failed"
  if (status === 401 || status === 403) category = "forbidden-or-not-authorized"
  else if (status === 404 || status === 405 || status === 501) category = "unsupported-endpoint"
  return new Error(
    `debugger capability ${category}${status ? ` (HTTP ${status})` : ""}: ${message}`
  )
}

async function completesWithin(promise: Promise<boolean>, milliseconds: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), milliseconds)
      })
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
