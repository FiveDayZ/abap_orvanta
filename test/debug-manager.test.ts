import assert from "node:assert/strict"
import test from "node:test"
import type { ADTClient, DebugBreakpoint, Debuggee } from "abap-adt-api"
import { HeadlessDebugManager } from "../src/debug-manager.js"

const sourceUri = "/sap/bc/adt/functions/groups/zcmcp_fg_1501/fmodules/zcmcp_fm_1501/source/main"

test("headless debug manager listens, attaches, reads state, steps, and cleans up", async () => {
  const listener = new ListenerClient()
  const attached = new AttachedClient()
  const manager = new HeadlessDebugManager({
    async listenerClient() {
      return listener as unknown as ADTClient
    },
    async attachedClient() {
      return attached as unknown as ADTClient
    },
    username() {
      return "DEVELOPER"
    }
  })

  const started = await manager.session("w200", { action: "start" })
  assert.equal(started.state, "listening")
  const breakpoint = await manager.breakpoints("w200", {
    action: "set",
    fileUri: "adt://w200/sap/bc/adt/functions/groups/zcmcp_fg_1501/fmodules/zcmcp_fm_1501",
    sourceUri,
    lineNumbers: [12],
    condition: "IV_INPUT IS NOT INITIAL"
  })
  assert.equal(breakpoint.breakpoints[0]?.verified, true)

  listener.push(debuggee())
  await waitFor(() => manager.status("w200").state === "paused")
  assert.equal(manager.status("w200").debuggee?.program, "SAPLZCMCP_FG_1501")

  const stack = await manager.stack("w200", 1)
  assert.equal(stack[0]?.frameId, 1_000_000_000_000)
  assert.equal(stack[0]?.eventName, "ZCMCP_FM_1501")

  const variable = await manager.variables("w200", {
    threadId: 1,
    frameId: stack[0]!.frameId,
    variableName: "IV_INPUT",
    rowStart: 0,
    rowCount: 50,
    maxVariables: 100,
    expandStructures: false,
    expandTables: false
  })
  assert.equal(variable.variables[0]?.value, "VALIDATION")
  await assert.rejects(
    manager.variables("w200", {
      threadId: 1,
      frameId: stack[0]!.frameId,
      expression: "IV_INPUT + 1",
      rowStart: 0,
      rowCount: 50,
      maxVariables: 100,
      expandStructures: false,
      expandTables: false
    }),
    /may contain only an ABAP identifier/
  )

  const stepped = await manager.step("w200", { threadId: 1, stepType: "stepOver" })
  assert.equal(stepped.state, "paused")
  const continued = await manager.step("w200", { threadId: 1, stepType: "continue" })
  assert.equal(continued.debuggeeEnded, true)
  assert.equal(manager.status("w200").state, "listening")

  await manager.close()
  assert.equal(manager.status("w200").state, "idle")
  assert.equal(listener.deletedListeners, 1)
  assert.equal(listener.deletedBreakpoints, 1)
  assert.equal(attached.loggedOut, true)
})

test("headless debug manager restricts user and unsupported control-flow modes", async () => {
  const listener = new ListenerClient()
  const manager = new HeadlessDebugManager({
    async listenerClient() {
      return listener as unknown as ADTClient
    },
    async attachedClient() {
      throw new Error("not expected")
    },
    username() {
      return "DEVELOPER"
    }
  })
  await assert.rejects(
    manager.session("w200", { action: "start", debugUser: "OTHER" }),
    /only allows the configured SAP user/
  )
  await assert.rejects(
    manager.session("w200", { action: "start", terminalMode: true }),
    /terminalMode is not supported/
  )
  await manager.close()
})

test("headless debug manager refuses ambiguous listener 404 without starting a session", async () => {
  const manager = new HeadlessDebugManager({
    async listenerClient() {
      return {
        async debuggerListeners() {
          throw new Error("Request failed with status code 404")
        }
      } as unknown as ADTClient
    },
    async attachedClient() {
      throw new Error("not expected")
    },
    username() {
      return "DEVELOPER"
    }
  })

  await assert.rejects(
    manager.session("w200", { action: "start" }),
    /debugger capability listener-not-found-ambiguous \(HTTP 404\)/
  )
  assert.equal(manager.status("w200").state, "idle")
})

test("debug manager precheck does not create or stop a session", async () => {
  let discoveryReads = 0
  const manager = new HeadlessDebugManager({
    async listenerClient() {
      return {
        async adtDiscovery() {
          discoveryReads++
          return [{ title: "Debugger", collection: [] }]
        }
      } as unknown as ADTClient
    },
    async attachedClient() {
      throw new Error("Must not attach")
    },
    username() {
      return "DEVELOPER"
    }
  })
  const result = await manager.session("W200", { action: "precheck" })
  assert.equal(result.precheck?.status, "not_advertised")
  assert.equal(result.precheck?.listenerStarted, false)
  assert.equal(manager.status("w200").state, "idle")
  assert.equal(discoveryReads, 1)
  await assert.rejects(
    manager.session("w200", { action: "precheck", debugUser: "OTHER" }),
    /only allows the configured SAP user/
  )
  assert.equal(discoveryReads, 1)
  await manager.close()
})

class ListenerClient {
  deletedListeners = 0
  deletedBreakpoints = 0
  private queued: Debuggee | undefined
  private resolveListen: ((value: Debuggee | undefined) => void) | undefined

  async debuggerListeners() {
    return undefined
  }

  debuggerListen(): Promise<Debuggee | undefined> {
    if (this.queued) {
      const value = this.queued
      this.queued = undefined
      return Promise.resolve(value)
    }
    return new Promise((resolve) => {
      this.resolveListen = resolve
    })
  }

  push(value: Debuggee): void {
    if (this.resolveListen) {
      const resolve = this.resolveListen
      this.resolveListen = undefined
      resolve(value)
      return
    }
    this.queued = value
  }

  async debuggerSetBreakpoints(
    _mode: string,
    _terminalId: string,
    _ideId: string,
    clientId: string,
    values: Array<string | DebugBreakpoint>
  ) {
    return values.map((value, index) =>
      typeof value === "string"
        ? nativeBreakpoint(clientId, value, `BP${index + 1}`)
        : { ...value, id: value.id || `BP${index + 1}` }
    )
  }

  async debuggerDeleteBreakpoints() {
    this.deletedBreakpoints++
  }

  async debuggerDeleteListener() {
    this.deletedListeners++
    this.resolveListen?.(undefined)
    this.resolveListen = undefined
  }
}

class AttachedClient {
  loggedOut = false
  private stepCount = 0

  async debuggerAttach() {
    return {}
  }

  async debuggerSaveSettings() {
    return {}
  }

  async debuggerSetBreakpoints() {
    return []
  }

  async debuggerDeleteBreakpoints() {}

  async debuggerStackTrace() {
    return {
      isRfc: true,
      isSameSystem: true,
      serverName: "w200",
      stack: [
        {
          stackPosition: 0,
          stackType: "ABAP",
          stackUri: "/sap/bc/adt/debugger/stack/type/ABAP/position/0",
          programName: "SAPLZCMCP_FG_1501",
          includeName: "LZCMCP_FG_1501U01",
          line: 12 + this.stepCount,
          eventType: "FUNCTION",
          eventName: "ZCMCP_FM_1501",
          sourceType: "ABAP",
          systemProgram: false,
          isVit: false,
          uri: uriParts(sourceUri, 12 + this.stepCount)
        }
      ]
    }
  }

  async debuggerGoToStack() {}

  async debuggerVariables(names: string[]) {
    return names.map((name) => variable(name))
  }

  async debuggerChildVariables() {
    return { hierarchies: [], variables: [variable("IV_INPUT")] }
  }

  async debuggerStep(step: string) {
    if (step === "stepContinue") {
      throw Object.assign(new Error("Debuggee ended"), {
        properties: { "com.sap.adt.communicationFramework.subType": "debuggeeEnded" }
      })
    }
    this.stepCount++
    return {}
  }

  async logout() {
    this.loggedOut = true
  }

  async dropSession() {
    this.loggedOut = true
  }
}

function nativeBreakpoint(clientId: string, request: string, id: string): DebugBreakpoint {
  const [uri, lineText] = request.split("#start=")
  return {
    kind: "line",
    clientId,
    id,
    nonAbapFlavour: "",
    uri: uriParts(uri!, Number.parseInt(lineText!, 10)),
    type: "",
    name: ""
  }
}

function uriParts(uri: string, line: number) {
  return {
    uri,
    query: {},
    hashparms: {},
    range: { start: { line, column: 0 }, end: { line, column: 0 } }
  }
}

function variable(name: string) {
  return {
    ID: name,
    NAME: name,
    DECLARED_TYPE_NAME: "STRING",
    ACTUAL_TYPE_NAME: "STRING",
    KIND: "",
    INSTANTIATION_KIND: "",
    ACCESS_KIND: "",
    META_TYPE: "string",
    PARAMETER_KIND: "",
    VALUE: "VALIDATION",
    HEX_VALUE: "",
    READ_ONLY: "X",
    TECHNICAL_TYPE: "",
    LENGTH: 10,
    TABLE_BODY: "",
    TABLE_LINES: 0,
    IS_VALUE_INCOMPLETE: "",
    IS_EXCEPTION: "",
    INHERITANCE_LEVEL: 0,
    INHERITANCE_CLASS: ""
  }
}

function debuggee(): Debuggee {
  return {
    CLIENT: 200,
    DEBUGGEE_ID: "DEBUGGEE-1",
    TERMINAL_ID: "TERMINAL-1",
    IDE_ID: "IDE-1",
    DEBUGGEE_USER: "DEVELOPER",
    PRG_CURR: "SAPLZCMCP_FG_1501",
    INCL_CURR: "LZCMCP_FG_1501U01",
    LINE_CURR: 12,
    DBGEE_KIND: "RFC"
  } as Debuggee
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for debugger state")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
