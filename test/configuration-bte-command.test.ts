import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  ConfigurationBteCommandCoordinator,
  configurationBteCommandStateSchema,
  type ConfigurationBteCommandPort
} from "../src/configuration-bte-command.js"
import { hashWriteInput } from "../src/write-operation-receipts.js"
import { configurationBteProtocolSourceVersion } from "../src/configuration-bte-protocol.js"

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const pins = {
  STATE: sha("state"),
  SAVE: sha("save"),
  RECOVER: sha("recover"),
  INCLUDE: sha("include"),
  BTE_PROTOCOL: configurationBteProtocolSourceVersion
}
function state(product = "ZTEST", active: "" | "X" = "", revision = 0) {
  const bytes = Buffer.from(`Synthetic fixture, not SAP EXPORT: ${product}/${active}/${revision}`)
  return {
    connectionId: "w200" as const,
    system: "GR2" as const,
    client: "200" as const,
    username: "WYS" as const,
    product,
    request: "GR2K923429" as const,
    task: "GR2K923430" as const,
    active,
    frame: bytes.toString("base64"),
    version: sha(bytes),
    protectedVersion: sha("protected rows and spaces"),
    ctsVersion: sha(revision ? "recorded keys retained" : "before CTS"),
    routeVersion: sha("route"),
    cacheVersion: sha(revision ? "invalidated" : "cache")
  }
}
async function setup() {
  // Retain synthetic evidence; never remove an existing workspace/cache file.
  const root = await mkdtemp(join(tmpdir(), "orv-bte-r80-"))
  let current = state()
  let currentPins = { ...pins }
  let invokes = 0
  let reads = 0
  const approvedIntentHashes: string[] = []
  const port: ConfigurationBteCommandPort = {
    acceptance: {
      pins: { ...pins },
      atomicSave: true,
      fullCtsReadback: true,
      frameCleanup: true,
      cacheUpdate: true,
      recovery: true,
      nativeMessageProtocol: true,
      approvedIntentHashes
    },
    async pins() {
      return { ...currentPins }
    },
    async state(product) {
      reads++
      return { ...current, product }
    },
    async invoke(intent) {
      invokes++
      current = state(intent.before.product, intent.desiredActive, 1)
      return {
        code: "COMMAND_COMMITTED",
        command: intent.command,
        operationId: intent.operationId,
        requestId: intent.requestId,
        committed: true,
        protectedState: "preserved",
        cts: "recorded",
        locks: "released",
        session: "clean",
        cache: "verified",
        protocol: {
          version: 1,
          operationId: intent.operationId,
          requestId: intent.requestId,
          command: intent.command,
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
          beginMarker: intent.requestId,
          endMarker: intent.requestId,
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
              text: "Synthetic protocol, not an SAP save result"
            }
          ]
        },
        after: { ...current }
      }
    }
  }
  const coordinator = new ConfigurationBteCommandCoordinator(root, port)
  async function prepare(id = "save-1", recoveryFrom?: string) {
    const result = await coordinator.prepare({
      operationId: id,
      expectedVersion: current.version,
      desiredActive: recoveryFrom ? "" : "X",
      product: current.product,
      acknowledgeConfigurationWrite: true,
      approvalHash: sha("synthetic explicit approval"),
      ...(recoveryFrom ? { recoveryFrom } : {})
    })
    approvedIntentHashes.push(result.intentHash)
    return result
  }
  return {
    root,
    port,
    coordinator,
    prepare,
    current: () => current,
    setState: (value: typeof current) => {
      current = value
    },
    setPins: (value: typeof pins) => {
      currentPins = value
    },
    invokes: () => invokes,
    reads: () => reads
  }
}

test("native frames reject noncanonical base64, wrong hashes and scope changes", () => {
  assert.ok(configurationBteCommandStateSchema.safeParse(state()).success)
  for (const patch of [
    { frame: state().frame + "\n" },
    { version: sha("different buffer") },
    { client: "300" },
    { username: "OTHER" },
    { request: "GR2K923472" },
    { product: "SAP" },
    { active: "1" },
    { unknown: true }
  ])
    assert.equal(
      configurationBteCommandStateSchema.safeParse({ ...state(), ...patch }).success,
      false
    )
})

test("one durable intent dispatches once; repeated IDs cannot replay it", async () => {
  const s = await setup(),
    prepared = await s.prepare()
  assert.equal(prepared.writeAvailable, false)
  const result = await s.coordinator.execute(prepared.operationId, prepared.intentHash)
  assert.equal(result.status, "committed")
  assert.equal(s.invokes(), 1)
  assert.equal(
    (await s.coordinator.execute(prepared.operationId, prepared.intentHash)).status,
    "duplicate"
  )
  assert.equal(s.invokes(), 1)
  const evidence = await readdir(join(s.root, "bte-command-evidence"))
  assert.ok(evidence.some((name) => name.endsWith("-intent.json")))
  assert.ok(evidence.some((name) => name.endsWith("-saved.json")))
})

test("absence of native acceptance does not invoke SAP or grant a write", async () => {
  const s = await setup(),
    prepared = await s.prepare()
  const port: ConfigurationBteCommandPort = {
    pins: s.port.pins,
    state: s.port.state,
    invoke: s.port.invoke
  }
  const coordinator = new ConfigurationBteCommandCoordinator(s.root, port)
  await assert.rejects(
    coordinator.execute(prepared.operationId, prepared.intentHash),
    /NATIVE_ACCEPTANCE_REQUIRED/
  )
  assert.equal(s.invokes(), 0)
  assert.equal((await coordinator.status(prepared.operationId)).status, "not_found")
})

for (const key of [
  "atomicSave",
  "fullCtsReadback",
  "frameCleanup",
  "cacheUpdate",
  "recovery",
  "nativeMessageProtocol"
] as const) {
  test(`native acceptance missing ${key} cannot be replaced by the r79 lock proof`, async () => {
    const s = await setup(),
      prepared = await s.prepare()
    if (key === "recovery") {
      assert.equal(
        (await s.coordinator.execute(prepared.operationId, prepared.intentHash)).status,
        "committed"
      )
      const recover = await s.prepare("recover-1", prepared.operationId)
      s.port.acceptance![key] = false
      await assert.rejects(
        s.coordinator.execute(recover.operationId, recover.intentHash),
        /NATIVE_ACCEPTANCE_REQUIRED/
      )
      assert.equal(s.invokes(), 1)
    } else {
      s.port.acceptance![key] = false
      await assert.rejects(
        s.coordinator.execute(prepared.operationId, prepared.intentHash),
        /NATIVE_ACCEPTANCE_REQUIRED/
      )
      assert.equal(s.invokes(), 0)
    }
  })
}

test("approval of another intent cannot authorize this change", async () => {
  const s = await setup(),
    prepared = await s.prepare()
  s.port.acceptance!.approvedIntentHashes = [sha("another approval")]
  await assert.rejects(
    s.coordinator.execute(prepared.operationId, prepared.intentHash),
    /BUSINESS_APPROVAL_REQUIRED/
  )
  assert.equal(s.invokes(), 0)
})

test("immutable intent cannot be prepared twice or executed with a different hash", async () => {
  const s = await setup(),
    prepared = await s.prepare()
  await assert.rejects(s.prepare(), { code: "EEXIST" })
  await assert.rejects(
    s.coordinator.execute(prepared.operationId, sha("altered")),
    /INTENT_CHANGED/
  )
  assert.equal(s.invokes(), 0)
})

for (const drift of ["source", "row", "text", "route", "cts", "cache"] as const) {
  test(`${drift} drift rejects before dispatch without claiming an unknown write`, async () => {
    const s = await setup(),
      prepared = await s.prepare()
    if (drift === "source") s.setPins({ ...pins, INCLUDE: sha("changed") })
    else {
      const field = {
        row: "version",
        text: "protectedVersion",
        route: "routeVersion",
        cts: "ctsVersion",
        cache: "cacheVersion"
      }[drift]
      if (drift === "row") s.setState(state("ZTEST", "", 2))
      else s.setState({ ...s.current(), [field]: sha("changed") })
    }
    const result = await s.coordinator.execute(prepared.operationId, prepared.intentHash)
    assert.equal(result.status, "rejected")
    assert.equal(result.receipt.sapInvocationStarted, false)
    assert.equal(result.receipt.outcomeMayBeUnknown, false)
    assert.equal(s.invokes(), 0)
  })
}

test("source drift during preparation never creates a mixed-version intent", async () => {
  const s = await setup()
  const read = s.port.state
  s.port.state = async (product) => {
    s.setPins({ ...pins, SAVE: sha("new save") })
    return read(product)
  }
  await assert.rejects(s.prepare(), /API_CHANGED/)
  assert.equal(s.invokes(), 0)
})

test("a transport failure retains protection across restart and new operation IDs", async () => {
  const s = await setup(),
    prepared = await s.prepare()
  const invoke = s.port.invoke
  s.port.invoke = async (intent) => {
    await invoke(intent)
    throw Error("timeout after SAVE")
  }
  const result = await s.coordinator.execute(prepared.operationId, prepared.intentHash)
  assert.equal(result.status, "unknown")
  assert.equal(result.receipt.outcomeMayBeUnknown, true)
  assert.equal(result.receipt.localLockReleased, false)
  const restarted = new ConfigurationBteCommandCoordinator(s.root, s.port)
  const observation = await restarted.reconcile(prepared.operationId)
  assert.equal(observation.classification, "drift_or_unattributed")
  assert.equal(observation.historicalOutcomeChanged, false)
  assert.equal(observation.protectionReleased, false)
  assert.equal((await restarted.status(prepared.operationId)).outcomeMayBeUnknown, true)
  s.setState(state("ZOTHER"))
  const other = await s.prepare("new-id")
  assert.equal((await restarted.execute(other.operationId, other.intentHash)).status, "target_busy")
  assert.equal(s.invokes(), 1)
})

test("a successful message without persistence cannot complete a receipt", async () => {
  const s = await setup(),
    prepared = await s.prepare()
  const invoke = s.port.invoke
  s.port.invoke = async (intent) => {
    const reply = await invoke(intent)
    s.setState(state())
    return reply
  }
  const result = await s.coordinator.execute(prepared.operationId, prepared.intentHash)
  assert.equal(result.status, "unknown")
  assert.equal(
    (await s.coordinator.reconcile(prepared.operationId)).classification,
    "observed_before"
  )
  assert.equal((await s.coordinator.status(prepared.operationId)).outcomeMayBeUnknown, true)
  assert.equal(s.invokes(), 1)
})

for (const patch of [
  { committed: false },
  { locks: "unknown" },
  { session: "unknown" },
  { cache: "scheduled" },
  { cts: "unknown" },
  { protectedState: "unknown" },
  { operationId: "another-operation" },
  { requestId: sha("wrong request") },
  { command: "RECOVER" }
]) {
  test(`incomplete or wrongly bound native reply remains unknown: ${JSON.stringify(patch)}`, async () => {
    const s = await setup(),
      prepared = await s.prepare()
    const invoke = s.port.invoke
    s.port.invoke = async (intent) => ({
      ...((await invoke(intent)) as Record<string, unknown>),
      ...patch
    })
    const result = await s.coordinator.execute(prepared.operationId, prepared.intentHash)
    assert.equal(result.status, "unknown")
    assert.equal(result.receipt.localLockReleased, false)
    assert.equal(s.invokes(), 1)
  })
}

test("a changed protected row is rejected even when the helper claims success", async () => {
  const s = await setup(),
    prepared = await s.prepare()
  const invoke = s.port.invoke
  s.port.invoke = async (intent) => {
    const reply = (await invoke(intent)) as Record<string, unknown>
    return { ...reply, after: { ...s.current(), protectedVersion: sha("RFCDS changed") } }
  }
  assert.equal(
    (await s.coordinator.execute(prepared.operationId, prepared.intentHash)).status,
    "unknown"
  )
})

test("post-state survives a failing final read; reconciliation does not rewrite the failed receipt", async () => {
  const s = await setup(),
    prepared = await s.prepare()
  const read = s.port.state
  s.port.state = async (product) => {
    if (s.invokes()) throw Error("final read failed")
    return read(product)
  }
  assert.equal(
    (await s.coordinator.execute(prepared.operationId, prepared.intentHash)).status,
    "unknown"
  )
  s.port.state = read
  const observation = await s.coordinator.reconcile(prepared.operationId)
  assert.equal(observation.classification, "observed_after")
  assert.equal(observation.receipt.status, "failed")
  assert.equal(observation.receipt.outcomeMayBeUnknown, true)
  assert.equal(observation.protectionReleased, false)
  const recovery = s.coordinator.prepare({
    operationId: "recover-1",
    recoveryFrom: prepared.operationId,
    expectedVersion: s.current().version,
    desiredActive: "",
    product: "ZTEST",
    acknowledgeConfigurationWrite: true,
    approvalHash: sha("approve")
  })
  await assert.rejects(recovery, /RECOVERY_BINDING_MISMATCH/)
  assert.equal(s.invokes(), 1)
})

test("only an own completed SAVE and its exact post-state can authorize recovery; CTS is retained", async () => {
  const s = await setup(),
    prepared = await s.prepare()
  assert.equal(
    (await s.coordinator.execute(prepared.operationId, prepared.intentHash)).status,
    "committed"
  )
  const recorded = s.current().ctsVersion
  const recover = await s.prepare("recover-1", prepared.operationId)
  const result = await s.coordinator.execute(recover.operationId, recover.intentHash)
  assert.equal(result.status, "committed")
  if (result.status !== "committed") assert.fail()
  assert.equal(result.ctsCleanupPerformed, false)
  assert.equal(result.transportReleased, false)
  assert.equal(s.current().active, "")
  assert.equal(s.current().ctsVersion, recorded)
  assert.equal(s.invokes(), 2)
})

test("a recovery cannot itself be used as another SAVE receipt", async () => {
  const s = await setup(),
    prepared = await s.prepare()
  await s.coordinator.execute(prepared.operationId, prepared.intentHash)
  const recover = await s.prepare("recover-1", prepared.operationId)
  await s.coordinator.execute(recover.operationId, recover.intentHash)
  await assert.rejects(
    s.coordinator.prepare({
      operationId: "recover-2",
      recoveryFrom: "recover-1",
      expectedVersion: s.current().version,
      desiredActive: "X",
      product: "ZTEST",
      acknowledgeConfigurationWrite: true,
      approvalHash: sha("approve")
    }),
    /RECOVERY_BINDING_MISMATCH/
  )
})

test("same-request concurrent intents dispatch at most one command", async () => {
  const s = await setup(),
    a = await s.prepare("save-a"),
    b = await s.prepare("save-b")
  const results = await Promise.all([
    s.coordinator.execute(a.operationId, a.intentHash),
    s.coordinator.execute(b.operationId, b.intentHash)
  ])
  assert.equal(results.filter((r) => r.status === "committed").length, 1)
  assert.equal(s.invokes(), 1)
})

test("an altered original intent cannot acquire recovery authority from an old completed receipt", async () => {
  const s = await setup(),
    prepared = await s.prepare()
  await s.coordinator.execute(prepared.operationId, prepared.intentHash)
  const dir = join(s.root, "bte-command-evidence"),
    id = sha(prepared.operationId)
  const intentPath = join(dir, `${id}-intent.json`),
    savedPath = join(dir, `${id}-saved.json`)
  const intent = JSON.parse(await readFile(intentPath, "utf8"))
  intent.approvalHash = sha("altered approval")
  const saved = JSON.parse(await readFile(savedPath, "utf8"))
  saved.intentHash = hashWriteInput(intent)
  await writeFile(intentPath, JSON.stringify(intent))
  await writeFile(savedPath, JSON.stringify(saved))
  await assert.rejects(s.prepare("recover-1", prepared.operationId), /RECOVERY_BINDING_MISMATCH/)
  assert.equal(s.invokes(), 1)
})

test("unattested protocol versions reject before invocation", async () => {
  const s = await setup()
  s.setPins({ ...pins, BTE_PROTOCOL: sha("different protocol sources") })
  s.port.acceptance!.pins = { ...pins, BTE_PROTOCOL: sha("different protocol sources") }
  const prepared = await s.prepare()
  await assert.rejects(
    s.coordinator.execute(prepared.operationId, prepared.intentHash),
    /NATIVE_ACCEPTANCE_REQUIRED/
  )
  assert.equal(s.invokes(), 0)
})

test("E followed by success retains the first error and an unknown outcome across restart", async () => {
  const s = await setup(),
    prepared = await s.prepare(),
    invoke = s.port.invoke
  s.port.invoke = async (intent) => {
    const reply = (await invoke(intent)) as any
    reply.protocol.messages = [
      { ...reply.protocol.messages[0], sequence: 1, severity: "E", text: "first root cause" },
      { ...reply.protocol.messages[0], sequence: 2, severity: "A", text: "another failure" },
      { ...reply.protocol.messages[0], sequence: 3, severity: "S", text: "later success" }
    ]
    reply.protocol.reportedCount = 3
    reply.code = "COMMAND_FAILED"
    reply.committed = false
    return reply
  }
  const result = await s.coordinator.execute(prepared.operationId, prepared.intentHash)
  assert.equal(result.status, "unknown")
  if (result.status !== "unknown") assert.fail()
  assert.equal(result.protocolStatus, "errors_observed")
  assert.equal(result.firstError!.text, "first root cause")
  const evidencePath = join(
    s.root,
    "bte-command-evidence",
    `${sha(prepared.operationId)}-protocol.json`
  )
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"))
  assert.equal(evidence.intentHash, prepared.intentHash)
  assert.equal(evidence.errors.length, 2)
  assert.deepEqual(
    evidence.report.messages.map((m: any) => m.text),
    ["first root cause", "another failure", "later success"]
  )
  const restarted = new ConfigurationBteCommandCoordinator(s.root, s.port)
  assert.equal((await restarted.status(prepared.operationId)).outcomeMayBeUnknown, true)
  assert.equal(
    (await restarted.execute(prepared.operationId, prepared.intentHash)).status,
    "duplicate"
  )
  s.setState(state("ZOTHER"))
  const another = await s.prepare("another-command")
  assert.equal(
    (await restarted.execute(another.operationId, another.intentHash)).status,
    "target_busy"
  )
  assert.equal(s.invokes(), 1)
})

for (const patch of [
  { append: "unverified" },
  { cleanup: "failed" },
  { read: "failed" },
  { compacted: true },
  { entryCount: 1 }
]) {
  test(`incomplete protocol does not save a success receipt: ${JSON.stringify(patch)}`, async () => {
    const s = await setup(),
      prepared = await s.prepare(),
      invoke = s.port.invoke
    s.port.invoke = async (intent) => {
      const reply = (await invoke(intent)) as any
      Object.assign(reply.protocol, patch)
      return reply
    }
    const result = await s.coordinator.execute(prepared.operationId, prepared.intentHash)
    assert.equal(result.status, "unknown")
    if (result.status !== "unknown") assert.fail()
    assert.equal(result.protocolStatus, "incomplete")
    assert.equal(result.receipt.localLockReleased, false)
    assert.equal(s.invokes(), 1)
    const files = await readdir(join(s.root, "bte-command-evidence"))
    assert.equal(
      files.some((f) => f.endsWith("-saved.json")),
      false
    )
    assert.equal(
      files.some((f) => f.endsWith("-protocol.json")),
      true
    )
  })
}

test("a protocol cannot bind another command or disappear from a successful reply", async () => {
  for (const change of ["request", "source", "absent"]) {
    const s = await setup(),
      prepared = await s.prepare(),
      invoke = s.port.invoke
    s.port.invoke = async (intent) => {
      const reply = (await invoke(intent)) as any
      if (change === "request") reply.protocol.requestId = sha("other request")
      else if (change === "source") reply.protocol.sourceVersion = sha("other version")
      else delete reply.protocol
      return reply
    }
    const result = await s.coordinator.execute(prepared.operationId, prepared.intentHash)
    assert.equal(result.status, "unknown")
    assert.equal(result.receipt.localLockReleased, false)
    assert.equal(s.invokes(), 1)
  }
})

for (const command of ["SAVE", "RECOVER"] as const) {
  test(`${command} cannot claim commitment when its protocol contains an earlier error`, async () => {
    const s = await setup()
    const original = await s.prepare()
    let prepared = original
    if (command === "RECOVER") {
      assert.equal(
        (await s.coordinator.execute(original.operationId, original.intentHash)).status,
        "committed"
      )
      prepared = await s.prepare("recover-1", original.operationId)
    }
    const invoke = s.port.invoke
    s.port.invoke = async (intent) => {
      const reply = (await invoke(intent)) as any
      reply.protocol.messages = [
        { ...reply.protocol.messages[0], severity: "E", text: "original native error" },
        { ...reply.protocol.messages[0], sequence: 2, severity: "S", text: "later success" }
      ]
      reply.protocol.reportedCount = 2
      // All other flags still claim successful commitment; the complete protocol must win.
      return reply
    }
    const result = await s.coordinator.execute(prepared.operationId, prepared.intentHash)
    assert.equal(result.status, "unknown")
    if (result.status !== "unknown") assert.fail()
    assert.equal(result.protocolStatus, "errors_observed")
    assert.equal(result.firstError!.text, "original native error")
    assert.equal(result.receipt.localLockReleased, false)
    await assert.rejects(
      readFile(join(s.root, "bte-command-evidence", `${sha(prepared.operationId)}-saved.json`)),
      { code: "ENOENT" }
    )
    assert.equal(
      (await s.coordinator.execute(prepared.operationId, prepared.intentHash)).status,
      "duplicate"
    )
    assert.equal(s.invokes(), command === "RECOVER" ? 2 : 1)
    if (command === "RECOVER")
      assert.equal((await s.coordinator.status(original.operationId)).status, "completed")
  })
}

test("an existing protocol artifact is never overwritten or replaced with a successful receipt", async () => {
  const s = await setup(),
    prepared = await s.prepare()
  const evidencePath = join(
    s.root,
    "bte-command-evidence",
    `${sha(prepared.operationId)}-protocol.json`
  )
  const preserved = '{"historicalEvidence":"retained verbatim"}\n'
  await writeFile(evidencePath, preserved, { flag: "wx" })
  const result = await s.coordinator.execute(prepared.operationId, prepared.intentHash)
  assert.equal(result.status, "unknown")
  assert.equal(result.receipt.localLockReleased, false)
  assert.equal(await readFile(evidencePath, "utf8"), preserved)
  const files = await readdir(join(s.root, "bte-command-evidence"))
  assert.equal(
    files.some((f) => f.endsWith("-saved.json")),
    false
  )
  assert.equal(s.invokes(), 1)
})
