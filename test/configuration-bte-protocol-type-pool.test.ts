import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import type { SapBackend } from "../src/backend.js"
import { readConfigurationBteProtocolTypePool as read } from "../src/configuration-bte-protocol-type-pool.js"

const observed = JSON.parse(
  readFileSync(
    new URL("./fixtures/configuration-bte-protocol-type-pool-w200-r83.json", import.meta.url),
    "utf8"
  )
)
const uri = "/sap/bc/adt/vit/wb/object_type/typedg/object_name/TRLOG"
const sha = (value: string) => createHash("sha256").update(value).digest("hex")
function fixture() {
  const f = structuredClone(observed)
  let calls = 0
  const request: unknown[] = []
  const backend = {
    connectionDetails: () => ({ client: "200" }),
    callRemoteFunction: async (...args: unknown[]) => {
      calls++
      request.push(args)
      return {
        outputs: {
          PROG_INF: { PROGNAME: "%_CTRLOG", PROG_TYPE: "T" },
          SOURCE_EXTENDED: [
            { LINE: "TYPE-POOL TRLOG." },
            { LINE: "  * Synthetic source for local tests only  " }
          ]
        }
      }
    }
  } as unknown as Pick<SapBackend, "connectionDetails" | "callRemoteFunction">
  return {
    f,
    backend,
    calls: () => calls,
    request,
    readers: {
      definition: async () => f.definition,
      structure: async (name: "RPY_PROG" | "ABAPTXT255") => f.structures[name]
    }
  }
}

test("TRLOG read pins active, unformatted source and preserves all returned row padding", async () => {
  const s = fixture()
  const result = await read("w200", `adt://w200${uri}`, s.backend, s.readers)
  assert.equal(s.calls(), 1)
  assert.deepEqual(s.request, [
    [
      "w200",
      {
        functionName: "RPY_PROGRAM_READ",
        inputParameters: {
          PROGRAM_NAME: "%_CTRLOG",
          WITH_INCLUDELIST: "",
          ONLY_SOURCE: "X",
          ONLY_TEXTS: "",
          READ_LATEST_VERSION: "",
          WITH_LOWERCASE: "X",
          SOURCE_EXTENDED: []
        },
        outputParameters: [
          { name: "PROG_INF", kind: "structure", fields: ["PROGNAME", "PROG_TYPE"] },
          { name: "SOURCE_EXTENDED", kind: "table", fields: ["LINE"] }
        ]
      }
    ]
  ])
  assert.equal(result.source, "TYPE-POOL TRLOG.\r\n  * Synthetic source for local tests only  ")
  assert.equal(result.sourceFingerprint, sha(result.source))
  assert.equal(result.nativeMessageProtocolVerified, false)
  assert.equal(result.writeAvailable, false)
})

test("another pool, client, connection or version cannot reach the source API", async () => {
  for (const [connection, path, client] of [
    ["w300", uri, "200"],
    ["w200", uri, "300"],
    ["w200", uri.replace("TRLOG", "SCPR"), "200"],
    ["w200", `adt://w300${uri}`, "200"],
    ["w200", `${uri}?version=inactive`, "200"],
    ["w200", `${uri}/../SCPR`, "200"]
  ]) {
    const s = fixture()
    s.backend.connectionDetails = () => ({ client }) as ReturnType<SapBackend["connectionDetails"]>
    await assert.rejects(read(connection!, path!, s.backend, s.readers), /SCOPE_INVALID/)
    assert.equal(s.calls(), 0)
  }
})

for (const drift of ["source", "abi", "mode", "structure", "unavailable"] as const) {
  test(`${drift} drift cannot hide behind a claimed fingerprint`, async () => {
    const s = fixture()
    if (drift === "source") s.f.definition.source.push("COMMIT WORK.")
    if (drift === "abi") s.f.definition.importParameters[0].optional = false
    if (drift === "mode") s.f.definition.updateTask = true
    if (drift === "structure") s.f.structures.ABAPTXT255.definition.fields[0].dataElement = "OTHER"
    if (drift === "unavailable")
      s.readers.definition = async () => {
        throw Error("unavailable")
      }
    await assert.rejects(read("w200", uri, s.backend, s.readers), /READER_UNVERIFIED/)
    assert.equal(s.calls(), 0)
  })
}

test("reader drift after source retrieval rejects that observation without repeating the read", async () => {
  const s = fixture()
  const invoke = s.backend.callRemoteFunction
  s.backend.callRemoteFunction = async (...args) => {
    const result = await invoke(...args)
    s.f.definition.interfaceFingerprint = sha("drift")
    return result
  }
  await assert.rejects(read("w200", uri, s.backend, s.readers), /READER_UNVERIFIED/)
  assert.equal(s.calls(), 1)
})

test("empty, malformed, truncated rows or a foreign program are never usable source", async () => {
  for (const outputs of [
    {},
    {
      PROG_INF: { PROGNAME: "%_CSCPR", PROG_TYPE: "T" },
      SOURCE_EXTENDED: [{ LINE: "TYPE-POOL TRLOG." }]
    },
    {
      PROG_INF: { PROGNAME: "%_CTRLOG", PROG_TYPE: " " },
      SOURCE_EXTENDED: [{ LINE: "TYPE-POOL TRLOG." }]
    },
    { PROG_INF: { PROGNAME: "%_CTRLOG", PROG_TYPE: "T" }, SOURCE_EXTENDED: [] },
    {
      PROG_INF: { PROGNAME: "%_CTRLOG", PROG_TYPE: "T" },
      SOURCE_EXTENDED: [{ LINE: "TYPE-POOL SCPR." }]
    },
    {
      PROG_INF: { PROGNAME: "%_CTRLOG", PROG_TYPE: "T" },
      SOURCE_EXTENDED: [{ LINE: "TYPE-POOL TRLOG.\n" }]
    },
    {
      PROG_INF: { PROGNAME: "%_CTRLOG", PROG_TYPE: "T" },
      SOURCE_EXTENDED: [{ LINE: "x".repeat(256) }]
    },
    {
      PROG_INF: { PROGNAME: "%_CTRLOG", PROG_TYPE: "T" },
      SOURCE_EXTENDED: Array.from({ length: 4097 }, () => ({ LINE: "TYPE-POOL TRLOG." }))
    }
  ]) {
    const s = fixture()
    s.backend.callRemoteFunction = async () =>
      ({ outputs }) as Awaited<ReturnType<SapBackend["callRemoteFunction"]>>
    await assert.rejects(
      read("w200", uri, s.backend, s.readers),
      /RESPONSE_UNVERIFIED|SOURCE_UNVERIFIED/
    )
  }
})

test("native source errors are surfaced and never retried", async () => {
  const s = fixture()
  let calls = 0
  s.backend.callRemoteFunction = async () => {
    calls++
    throw Error("SAP source access denied")
  }
  await assert.rejects(read("w200", uri, s.backend, s.readers), /SAP source access denied/)
  assert.equal(calls, 1)
})
