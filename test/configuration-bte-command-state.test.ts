import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import {
  configurationBteStateApi as api,
  configurationBteStateInclude as include,
  configurationBteCommandAvailability
} from "../src/configuration-bte-command-api.js"
import {
  attestConfigurationBteState,
  readConfigurationBteCommandState
} from "../src/configuration-bte-command-state.js"
import type { SapBackend } from "../src/backend.js"

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
function definition() {
  return {
    ...api,
    connectionId: "w200",
    updateTaskMode: "",
    sourceFingerprint: sha("synthetic function source"),
    interfaceFingerprint: sha("synthetic function ABI"),
    source: [`FUNCTION ${api.functionName}.`, ...api.source, "ENDFUNCTION."]
  }
}
function nativeInclude() {
  return {
    connectionId: "w200",
    objectName: include.includeName,
    kind: "source",
    source: include.source.join("\n")
  }
}
function output() {
  const bytes = Buffer.from("Synthetic state bytes; not a SAP runtime observation")
  return {
    EV_CODE: "STATE_READ",
    EV_SYSTEM: "GR2",
    EV_CLIENT: "200",
    EV_USER: "WYS",
    EV_PRODUCT: "ZTEST",
    EV_ACTIVE: "",
    EV_FRAME: bytes.toString("base64"),
    EV_VERSION: sha(bytes),
    EV_PROTECTED_VERSION: sha("full language and association rows"),
    EV_CTS_VERSION: sha("parent and task full CTS"),
    EV_ROUTE_VERSION: sha("route"),
    EV_CACHE_VERSION: sha("CP_INFO")
  }
}
function backend(outputs: Record<string, string> = output()) {
  let calls = 0
  const value: Pick<SapBackend, "callRemoteFunction"> = {
    async callRemoteFunction(connection, request) {
      calls++
      assert.equal(connection, "w200")
      assert.equal(request.functionName, api.functionName)
      assert.deepEqual(request.inputParameters, { IV_PRODUCT: "ZTEST" })
      return { outputs }
    }
  }
  return { value, calls: () => calls }
}
const readers = {
  definition: async () => definition(),
  include: async () => nativeInclude()
}

test("STATE candidate fits CHAR72 and has no native command, enqueue, GUI or commit", () => {
  for (const [index, line] of [...api.source, ...include.source].entries())
    assert.ok(line.length <= 72, `Source line ${index + 1} exceeds RSSOURCE CHAR72`)
  const code = include.source.filter((line) => !line.startsWith("*")).join("\n")
  assert.doesNotMatch(code, /\b(?:COMMIT|ROLLBACK|INSERT|UPDATE|MODIFY|DELETE)\b/i)
  assert.doesNotMatch(
    code,
    /CALL (?:TRANSACTION|SCREEN)|ENQUEUE_|DEQUEUE_|MAINTENANCE_NO_DIALOG|STARTING NEW TASK/i
  )
  assert.doesNotMatch(code, /\b(?:VALUE|NEW|COND|SWITCH|REDUCE|FILTER)\s*[#(]|\bDATA\s*\(/i)
  assert.equal(configurationBteCommandAvailability.nativeCommandSourceAvailable, false)
  assert.equal(configurationBteCommandAvailability.writeAvailable, false)
})

test("full native state includes both CTS containers, string keys, all languages and CP_INFO", () => {
  const code = include.source.join("\n")
  assert.match(code, /SELECT \* FROM e071 INTO TABLE s-objects/)
  assert.match(code, /SELECT \* FROM e071k INTO TABLE s-keys/)
  assert.match(code, /SELECT \* FROM e071k_str INTO TABLE s-string_keys/)
  assert.equal(
    (code.match(/WHERE trkorr = 'GR2K923429' OR trkorr = 'GR2K923430'/g) ?? []).length,
    3
  )
  assert.match(code, /WHERE frmid = 'CP_INFO'/)
  assert.match(code, /SORT s-texts BY mandt spras prdkt/)
  assert.match(code, /ls_protected = s-product\. CLEAR ls_protected-aktiv\./)
  assert.match(code, /AUTHORITY-CHECK OBJECT 'S_TABU_NAM'/)
})

test("complete STATE ABI and Include are attested; CRLF changes no code", async () => {
  const result = await attestConfigurationBteState(readers.definition, async () => ({
    ...nativeInclude(),
    source: include.source.join("\r\n") + "\r\n"
  }))
  assert.ok(result.STATE_INCLUDE)
})

for (const patch of [
  { remoteEnabled: false },
  { updateTask: true },
  { updateTaskMode: "V" },
  { functionGroup: "OTHER" },
  { globalInterface: true },
  { importParameters: [] },
  { exportParameters: [] },
  { changingParameters: [{ name: "EXTRA" }] },
  { source: [`FUNCTION ${api.functionName}.`, "COMMIT WORK.", "ENDFUNCTION."] }
]) {
  test(`ABI/source mismatch rejects before the sole read: ${JSON.stringify(patch)}`, async () => {
    const b = backend()
    await assert.rejects(
      readConfigurationBteCommandState("ZTEST", b.value, {
        ...readers,
        definition: async () => ({ ...definition(), ...patch })
      })
    )
    assert.equal(b.calls(), 0)
  })
}

test("an unchanged wrapper cannot hide a changed Include", async () => {
  const b = backend()
  await assert.rejects(
    readConfigurationBteCommandState("ZTEST", b.value, {
      ...readers,
      include: async () => ({
        ...nativeInclude(),
        source: nativeInclude().source + "\nCOMMIT WORK."
      })
    }),
    /API_UNVERIFIED/
  )
  assert.equal(b.calls(), 0)
})

test("read adapter invokes only STATE and validates the complete binary frame", async () => {
  const b = backend()
  const value = await readConfigurationBteCommandState("ZTEST", b.value, readers)
  assert.equal(value.product, "ZTEST")
  assert.equal(value.version, output().EV_VERSION)
  assert.equal(b.calls(), 1)
})

for (const patch of [
  { EV_CODE: "STATE_READ_FAILED" },
  { EV_SYSTEM: "GR3" },
  { EV_CLIENT: "300" },
  { EV_USER: "OTHER" },
  { EV_PRODUCT: "ZOTHER" },
  { EV_ACTIVE: "1" },
  { EV_FRAME: output().EV_FRAME + "\n" },
  { EV_VERSION: sha("wrong bytes") },
  { EV_PROTECTED_VERSION: "" },
  { EV_EXTRA: "unreviewed output" }
]) {
  test(`incomplete/scope-mismatched native state is not accepted: ${JSON.stringify(patch)}`, async () => {
    const b = backend({ ...output(), ...patch })
    await assert.rejects(readConfigurationBteCommandState("ZTEST", b.value, readers))
    assert.equal(b.calls(), 1)
  })
}

test("source identity drift during the read invalidates its result", async () => {
  const b = backend()
  let definitions = 0
  await assert.rejects(
    readConfigurationBteCommandState("ZTEST", b.value, {
      ...readers,
      definition: async () => {
        definitions++
        return { ...definition(), sourceFingerprint: sha(`source ${definitions}`) }
      }
    }),
    /API_CHANGED/
  )
  assert.equal(b.calls(), 1)
})

test("invalid product scope never reaches ABI or SAP reads", async () => {
  const b = backend()
  let metadata = 0
  await assert.rejects(
    readConfigurationBteCommandState("SAP", b.value, {
      definition: async () => {
        metadata++
        return definition()
      },
      include: readers.include
    })
  )
  assert.equal(metadata, 0)
  assert.equal(b.calls(), 0)
})
