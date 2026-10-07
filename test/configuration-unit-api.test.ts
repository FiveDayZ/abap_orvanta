import assert from "node:assert/strict"
import test from "node:test"
import {
  configurationUnitReadApi,
  readConfigurationUnitApiSnapshot
} from "../src/configuration-unit-api.js"
import { configurationUnitLayouts } from "../src/configuration-unit.js"
import type { RemoteFunctionResult } from "../src/backend.js"

const row = {
  MANDT: "200",
  SPRAS: "1",
  MSEHI: "kg ",
  MSEH3: "kg ",
  MSEH6: "kg    ",
  MSEHT: "短标题       ",
  MSEHL: "中文长标题                         "
}
const definition = () => ({
  connectionId: "w200",
  functionName: configurationUnitReadApi.functionName,
  remoteEnabled: true,
  updateTask: false,
  updateTaskMode: "",
  importParameters: [...configurationUnitReadApi.importParameters],
  exportParameters: [...configurationUnitReadApi.exportParameters],
  changingParameters: [],
  tableParameters: [],
  exceptions: [],
  source: [
    `FUNCTION ${configurationUnitReadApi.functionName}.`,
    '*" generated interface',
    ...configurationUnitReadApi.source,
    "ENDFUNCTION."
  ],
  sourceFingerprint: "a".repeat(64),
  interfaceFingerprint: "b".repeat(64)
})
const outputs = () => ({
  EV_CODE: "READ",
  EV_SYSTEM: "GR2",
  EV_CLIENT: "200",
  EV_TEXT_VERSION: "c".repeat(64),
  ES_TEXT: { ...row }
})
const table = () => ({
  connectionId: "w200",
  objectName: "T006A",
  objectKind: "transparentTable",
  active: true,
  fingerprint: configurationUnitLayouts.T006A
})
const run = (
  response: RemoteFunctionResult = { outputs: outputs() },
  readDefinition: () => Promise<unknown> = async () => definition(),
  readTable: () => Promise<unknown> = async () => table()
) => {
  let calls = 0
  return readConfigurationUnitApiSnapshot(
    "w200",
    "200",
    "kg",
    "1",
    {
      callRemoteFunction: async (id, request) => {
        assert.equal(id, "w200")
        assert.equal(request.functionName, configurationUnitReadApi.functionName)
        assert.deepEqual(request.inputParameters, { IV_UNIT_KEY: "kg", IV_LANGUAGE: "1" })
        calls++
        assert.equal(calls, 1)
        return response
      }
    },
    readDefinition,
    readTable
  )
}

test("native API retains fixed-width row and opaque SAP version with bounded attestation", async () => {
  const result = await run()
  assert.equal(result.status, "read")
  assert.deepEqual(result.data, row)
  assert.equal(result.textVersion, "c".repeat(64))
  assert.equal(result.saveAvailable, false)
  assert.deepEqual(result.evidence, {
    functionReaderInvocations: 2,
    functionReaderInvocationLimit: 2,
    apiInvocations: 1,
    apiInvocationLimit: 1
  })
})
for (const [name, edit] of [
  [
    "write inserted",
    (v: ReturnType<typeof definition>) => {
      v.source.splice(3, 0, "COMMIT WORK.")
    }
  ],
  [
    "wrong function header",
    (v: ReturnType<typeof definition>) => {
      v.source[0] = "FUNCTION Z_OTHER."
    }
  ],
  [
    "wrong import type",
    (v: ReturnType<typeof definition>) => {
      v.importParameters = v.importParameters.map((p) => ({
        ...p,
        typeName: "CHAR3"
      })) as typeof v.importParameters
    }
  ],
  [
    "duplicate parameter",
    (v: ReturnType<typeof definition>) => {
      v.importParameters.push(v.importParameters[0]!)
    }
  ],
  [
    "update task",
    (v: ReturnType<typeof definition>) => {
      v.updateTask = true
    }
  ],
  [
    "not remotable",
    (v: ReturnType<typeof definition>) => {
      v.remoteEnabled = false
    }
  ]
] as const)
  test(`API refuses ${name} before invocation`, async () => {
    const changed = definition()
    edit(changed)
    const result = await run(undefined, async () => changed)
    assert.equal(result.code, "API_NOT_ATTESTED")
    assert.equal(result.evidence.apiInvocations, 0)
    assert.equal(result.textVersion, null)
  })
for (const kind of ["source", "interface", "layout"] as const)
  test(`API discards row/version after ${kind} drift`, async () => {
    let definitions = 0,
      tables = 0
    const result = await run(
      undefined,
      async () => {
        const v = definition()
        if (++definitions === 2 && kind !== "layout")
          v[kind === "source" ? "sourceFingerprint" : "interfaceFingerprint"] = "d".repeat(64)
        return v
      },
      async () => ({
        ...table(),
        fingerprint:
          ++tables === 2 && kind === "layout" ? "d".repeat(64) : configurationUnitLayouts.T006A
      })
    )
    assert.equal(result.code, "API_OR_DDIC_CHANGED")
    assert.equal(result.data, null)
    assert.equal(result.textVersion, null)
  })
for (const [name, edit] of [
  [
    "wrong client",
    (v: ReturnType<typeof outputs>) => {
      v.EV_CLIENT = "300"
    }
  ],
  [
    "wrong SID",
    (v: ReturnType<typeof outputs>) => {
      v.EV_SYSTEM = "GR3"
    }
  ],
  [
    "wrong unit",
    (v: ReturnType<typeof outputs>) => {
      v.ES_TEXT.MSEHI = "KG"
    }
  ],
  [
    "wrong language",
    (v: ReturnType<typeof outputs>) => {
      v.ES_TEXT.SPRAS = "E"
    }
  ],
  [
    "invalid version",
    (v: ReturnType<typeof outputs>) => {
      v.EV_TEXT_VERSION = "1"
    }
  ],
  [
    "oversized text",
    (v: ReturnType<typeof outputs>) => {
      v.ES_TEXT.MSEHL = "x".repeat(31)
    }
  ],
  [
    "control character",
    (v: ReturnType<typeof outputs>) => {
      v.ES_TEXT.MSEHL = "\n"
    }
  ],
  [
    "unknown code",
    (v: ReturnType<typeof outputs>) => {
      v.EV_CODE = "SAVED"
    }
  ]
] as const)
  test(`API refuses ${name} response`, async () => {
    const v = outputs()
    edit(v)
    const result = await run({ outputs: v })
    assert.equal(result.code, "API_RESPONSE_INVALID")
    assert.equal(result.data, null)
    assert.equal(result.textVersion, null)
  })
test("SAP rejection and declared fault never expose row/version", async () => {
  const v = outputs()
  v.EV_CODE = "AUTHORIZATION_DENIED"
  assert.equal((await run({ outputs: v })).code, "AUTHORIZATION_DENIED")
  const result = await run({
    outputs: outputs(),
    fault: { name: "FAIL", code: "FAIL", message: "original fault" }
  })
  assert.equal(result.code, "API_DECLARED_FAULT")
  assert.equal(result.data, null)
  assert.equal(result.textVersion, null)
})
test("metadata and transport failures retain original error rather than fabricate a snapshot", async () => {
  await assert.rejects(
    run(undefined, async () => {
      throw Error("FUNCTION_READ_FAILED: missing")
    }),
    /FUNCTION_READ_FAILED: missing/
  )
  await assert.rejects(
    readConfigurationUnitApiSnapshot(
      "w200",
      "200",
      "kg",
      "1",
      {
        callRemoteFunction: async () => {
          throw Error("network failure")
        }
      },
      async () => definition(),
      async () => table()
    ),
    /network failure/
  )
})
test("invalid target/key/language rejected before any dependency read", async () => {
  const noRead = async () => assert.fail("invalid input must not touch SAP")
  for (const [id, client, key, language] of [
    ["w300", "300", "kg", "1"],
    ["w200", "200", "kg", "ZH"],
    ["w200", "200", " kg", "1"],
    ["w200", "200", "kg ", "1"],
    ["w200", "200", "|", "1"],
    ["w200", "200", "", "1"]
  ])
    await assert.rejects(
      readConfigurationUnitApiSnapshot(
        id!,
        client!,
        key!,
        language!,
        { callRemoteFunction: noRead },
        noRead,
        noRead
      )
    )
})
test("unverified DDIC blocks all function reads and calls", async () => {
  for (const edit of [{ active: false }, { fingerprint: "f".repeat(64) }, { status: "inactive" }]) {
    const result = await run(
      undefined,
      async () => assert.fail("no function read"),
      async () => ({ ...table(), ...edit })
    )
    assert.equal(result.code, "DDIC_UNVERIFIED")
    assert.equal(result.evidence.apiInvocations, 0)
  }
})
