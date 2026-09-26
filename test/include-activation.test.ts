import assert from "node:assert/strict"
import test from "node:test"
import { activate as sdkActivate } from "abap-adt-api/build/api/activate.js"
import {
  AdtBackend,
  activateTarget,
  createObjectWithClient,
  inspectSourceWithClient,
  prepareCreateObjectRequest,
  referencedIncludeNames,
  replaceSourceWithClient
} from "../src/adt-backend.js"
import { hashSource } from "../src/source-preflight.js"
import { inactiveHttp } from "./inactive-http.js"

const objectUri = "/sap/bc/adt/programs/includes/ztest_top"
const fileUri = `adt://w200${objectUri}`
const mainUri = "/sap/bc/adt/programs/programs/ztest"
const oldSource = "DATA old TYPE c."
const newSource = "DATA replacement TYPE c."
const entry = (uri = objectUri) => ({
  "ioc:object": {
    "@_ioc:user": "OTHER",
    "@_ioc:deleted": "false",
    "ioc:ref": {
      "@_adtcore:uri": uri,
      "@_adtcore:name": "ZTEST_TOP",
      "@_adtcore:type": "PROG/I",
      "@_adtcore:parentUri": mainUri
    }
  }
})

/** A draft whose inventory entry names neither a `?context=` qualifier nor a parent URI - what w200
 * returns for a PROG/I draft, and the state in which no main program can be resolved locally. */
const entryWithoutContext = (uri = objectUri) => ({
  "ioc:object": {
    "@_ioc:user": "OTHER",
    "@_ioc:deleted": "false",
    "ioc:ref": {
      "@_adtcore:uri": uri,
      "@_adtcore:name": "ZTEST_TOP",
      "@_adtcore:type": "PROG/I",
      "@_adtcore:parentUri": ""
    }
  }
})

function fixture() {
  const state = {
    active: oldSource,
    draft: null as string | null,
    saves: 0,
    unlocks: 0,
    posts: [] as string[],
    failActivation: false,
    staleReadback: false
  }
  const client = {
    stateful: "stateful",
    httpClient: inactiveHttp(),
    async mainPrograms() {
      return [{ "adtcore:uri": mainUri }]
    },
    async lock() {
      return { LOCK_HANDLE: "test-lock", IS_LOCAL: "X", CORRNR: "" }
    },
    async unLock() {
      state.unlocks++
    },
    async getObjectSource(_uri: string, options: { version: string }) {
      return options.version === "inactive" ? (state.draft ?? state.active) : state.active
    },
    async setObjectSource(_uri: string, source: string) {
      state.saves++
      state.draft = source
    },
    async activate(name: string, uri: string, context: string, preaudit: boolean) {
      return sdkActivate(
        {
          async request(path: string, options: { body: string }) {
            assert.equal(path, "/sap/bc/adt/activation")
            state.posts.push(options.body)
            if (state.failActivation) throw new Error("HTTP 500 Main program  is not anymore valid")
            if (!state.staleReadback) {
              state.active = state.draft ?? state.active
              state.draft = null
            }
            return { status: 200, statusText: "OK", headers: {}, body: "" }
          }
        } as never,
        name,
        uri,
        context,
        preaudit
      )
    }
  }
  const replace = () =>
    replaceSourceWithClient(client as never, "w200", fileUri, oldSource, newSource)
  return { state, client, replace }
}

test("Include replacement serializes exactly one contextual target through the installed SDK", async () => {
  const { state, replace } = fixture()
  const result = await replace()
  assert.equal(result.activation.success, true)
  assert.equal(result.activeFingerprint, hashSource(newSource))
  assert.equal(result.saveSucceeded, true)
  assert.equal(state.saves, 1)
  assert.equal(state.posts.length, 1)
  assert.ok(state.posts[0]!.includes(`${objectUri}?context=${encodeURIComponent(mainUri)}`))
  assert.equal((state.posts[0]!.match(/<adtcore:objectReference /g) ?? []).length, 1)
})

test("valid empty inventory does not hide a different inactive source", async () => {
  const { state, client, replace } = fixture()
  state.draft = "DATA other_task TYPE c."
  const inspection = await inspectSourceWithClient(client as never, "w200", fileUri)
  assert.equal(inspection.inactiveSource, state.draft)
  await assert.rejects(replace(), /already has inactive SAP source/)
  assert.equal(state.saves, 0)
  assert.equal(state.unlocks, 1)
})

test("explicit fingerprint-bound recovery repairs and activates an inactive source", async () => {
  const { state, client } = fixture()
  const invalidClause = "WHERE bktxt = ls_item-srcno UP TO 5 ROWS."
  const correctedClause = "UP TO 5 ROWS WHERE bktxt = ls_item-srcno."
  state.draft = `${oldSource}\n${invalidClause}`

  const result = await replaceSourceWithClient(
    client as never,
    "w200",
    fileUri,
    invalidClause,
    correctedClause,
    undefined,
    hashSource(state.draft),
    true
  )

  assert.equal(result.activation.success, true)
  assert.equal(state.active, `${oldSource}\n${correctedClause}`)
  assert.equal(state.draft, null)
  assert.equal(state.saves, 1)
  assert.equal(state.posts.length, 1)
})

test("inactive source recovery requires its exact reviewed fingerprint", async () => {
  const { state, client } = fixture()
  state.draft = "DATA invalid TYPE c."

  await assert.rejects(
    replaceSourceWithClient(
      client as never,
      "w200",
      fileUri,
      "invalid",
      "valid",
      undefined,
      undefined,
      true
    ),
    /INACTIVE_SOURCE_RECOVERY_FINGERPRINT_REQUIRED/
  )
  await assert.rejects(
    replaceSourceWithClient(
      client as never,
      "w200",
      fileUri,
      "invalid",
      "valid",
      undefined,
      "0".repeat(64),
      true
    ),
    /SOURCE_FINGERPRINT_CONFLICT: inactive source changed since review/
  )
  assert.equal(state.saves, 0)
})

test("context-qualified inventory entries preserve even an unchanged inactive source", async () => {
  const { state, client, replace } = fixture()
  client.httpClient = inactiveHttp(() => [
    entry(`${objectUri}?context=${encodeURIComponent(mainUri)}`)
  ])
  await assert.rejects(replace(), /already has inactive SAP source/)
  assert.equal(state.saves, 0)
})

test("HTML inventory blocks inspection and writing instead of reporting absence", async () => {
  const { state, client, replace } = fixture()
  client.httpClient = {
    async request() {
      return {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
        body: "<html/>"
      }
    }
  }
  await assert.rejects(
    inspectSourceWithClient(client as never, "w200", fileUri),
    /INACTIVE_INVENTORY_RESPONSE_INVALID.*target=.*ztest_top.*mainProgram=.*ztest/
  )
  await assert.rejects(
    replace(),
    /INACTIVE_INVENTORY_RESPONSE_INVALID.*target=.*ztest_top.*mainProgram=.*ztest/
  )
  assert.equal(state.saves, 0)
  assert.equal(state.unlocks, 1)
})

test("unavailable target inactive read blocks saving even with a valid empty inventory", async () => {
  const { state, client, replace } = fixture()
  client.getObjectSource = async (_uri, options) => {
    if (options.version === "inactive") throw new Error("HTTP 404 inactive version unavailable")
    return oldSource
  }
  await assert.rejects(replace(), /inactive version unavailable/)
  assert.equal(state.saves, 0)
})

test("saved candidate survives activation HTTP 500 with fingerprints and no automatic retry", async () => {
  const { state, replace } = fixture()
  state.failActivation = true
  const result = await replace()
  assert.equal(result.saveSucceeded, true)
  assert.equal(result.unlockSucceeded, true)
  assert.equal(result.activationAttempted, true)
  assert.equal(result.activationSucceeded, false)
  assert.equal(result.activeFingerprint, hashSource(oldSource))
  assert.equal(result.inactiveFingerprint, hashSource(newSource))
  assert.match(result.activation.messages[0]!.text, /HTTP 500.*Main program/)
  assert.equal(state.saves, 1)
  assert.equal(state.posts.length, 1)
  assert.equal(state.draft, newSource)
})

test("HTTP success without matching active source is not replacement success", async () => {
  const { state, replace } = fixture()
  state.staleReadback = true
  const result = await replace()
  assert.equal(result.activation.success, false)
  assert.match(result.activation.messages[0]!.text, /ACTIVE_SOURCE_FINGERPRINT_MISMATCH/)
})

test("missing or ambiguous main programs never submit an activation request", async () => {
  for (const programs of [[], [{ "adtcore:uri": mainUri }, { "adtcore:uri": mainUri + "2" }]]) {
    const { state, client } = fixture()
    client.mainPrograms = async () => programs
    const result = await activateTarget(client as never, objectUri, "ZTEST_TOP")
    assert.equal(result.success, false)
    assert.equal(result.attempted, false)
    assert.equal(state.posts.length, 0)
    assert.match(result.messages[0]!.text, /INCLUDE_MAIN_PROGRAM_/)
  }
})

test("SAP-provided context disambiguates multiple main programs without adding other targets", async () => {
  const { state, client } = fixture()
  client.mainPrograms = async () => [{ "adtcore:uri": mainUri }, { "adtcore:uri": mainUri + "2" }]
  client.httpClient = inactiveHttp(() => [
    entry(`${objectUri}?context=${encodeURIComponent(mainUri)}`),
    entry("/sap/bc/adt/programs/includes/zunrelated")
  ])
  const result = await activateTarget(client as never, objectUri, "ZTEST_TOP")
  assert.equal(result.success, true)
  assert.equal(state.posts.length, 1)
  assert.ok(!state.posts[0]!.includes("zunrelated"))
})

test("inactive class activation uses the direct name and URI overload", async () => {
  const classUri = "/sap/bc/adt/oo/classes/zcl_test"
  const calls: unknown[][] = []
  let body = ""
  const client = {
    httpClient: inactiveHttp(() => [
      {
        "ioc:object": {
          "@_ioc:user": "OTHER",
          "@_ioc:deleted": "false",
          "ioc:ref": {
            "@_adtcore:uri": classUri,
            "@_adtcore:name": "ZCL_TEST",
            "@_adtcore:type": "CLAS/OC"
          }
        }
      }
    ]),
    async mainPrograms() {
      return []
    },
    async activate(name: string, uri: string, context: string | undefined, preaudit: boolean) {
      calls.push([name, uri, context, preaudit])
      return sdkActivate(
        {
          async request(path: string, options: { body: string }) {
            assert.equal(path, "/sap/bc/adt/activation")
            body = options.body
            return { status: 200, statusText: "OK", headers: {}, body: "" }
          }
        } as never,
        name,
        uri,
        context,
        preaudit
      )
    }
  }

  const result = await activateTarget(client as never, classUri, "ZCL_TEST")

  assert.equal(result.success, true)
  assert.deepEqual(calls, [["ZCL_TEST", classUri, undefined, true]])
  assert.match(body, /adtcore:uri="\/sap\/bc\/adt\/oo\/classes\/zcl_test"/)
  assert.doesNotMatch(body, /adtcore:(?:type|parentUri)=/)
})

test("real syntax errors are retained without force activation or another save", async () => {
  const { state, client, replace } = fixture()
  client.activate = async () =>
    ({
      success: false,
      messages: [{ type: "E", line: 25, shortText: 'Type "CHAR60" is unknown', href: objectUri }],
      inactive: []
    }) as never
  const result = await replace()
  assert.equal(result.saveSucceeded, true)
  assert.equal(result.activation.success, false)
  assert.equal(result.activation.messages[0]!.line, 25)
  assert.match(result.activation.messages[0]!.text, /CHAR60/)
  assert.equal(state.saves, 1)
})

test("activate-only verifies the draft without saving it again", async () => {
  for (const stale of [false, true]) {
    const { state, client } = fixture()
    state.draft = newSource
    state.staleReadback = stale
    const backend = new AdtBackend([])
    Object.defineProperty(backend, "withStatefulClient", {
      value: async (_id: string, operation: (client: unknown) => Promise<unknown>) =>
        operation(client)
    })
    const result = await backend.activateSource("w200", fileUri)
    assert.equal(result.success, !stale)
    assert.equal(state.saves, 0)
    assert.equal(state.posts.length, 1)
    if (stale) assert.match(result.messages[0]!.text, /ACTIVE_SOURCE_FINGERPRINT_MISMATCH/)
  }
})

test("duplicate inactive target contexts are never resolved by first-match selection", async () => {
  const { state, client } = fixture()
  client.httpClient = inactiveHttp(() => [
    entry(`${objectUri}?context=${encodeURIComponent(mainUri)}`),
    entry(`${objectUri}?context=${encodeURIComponent(mainUri + "2")}`)
  ])
  const result = await activateTarget(client as never, objectUri, "ZTEST_TOP")
  assert.equal(result.success, false)
  assert.equal(result.attempted, false)
  assert.equal(state.posts.length, 0)
  assert.match(result.messages[0]!.text, /INACTIVE_TARGET_CONTEXT_AMBIGUOUS/)
})

// A release without a `/mainprograms` handler (SAP_BASIS 7.31 answers HTTP 501, wrapped in a 404;
// observed on w200 2026-09-26 00:41/00:53) is the input the tests below share: the include is
// addressed by its own URI, so an unavailable reverse lookup must not decide anything.
async function unimplementedMainPrograms(): Promise<never> {
  throw new Error(
    "Request failed with status code 404; ADT GET /sap/bc/adt/programs/includes/ztest_top/mainprograms " +
      "returned HTTP 501; stateful=true"
  )
}

// The library keeps axios' message and puts SAP's request line only in the trace:
// `HttpClientException` carries "Request failed with status code 404" and no URI at all. A classifier
// that needs the URI to appear in the message therefore stops recognising the optional endpoint - the
// 2026-09-26 06:51 activation failure happened on a build that already contained the earlier fix,
// because that fix classified the endpoint by text.
async function bareUnimplementedMainPrograms(): Promise<never> {
  throw new Error("Request failed with status code 404")
}

test("an include stays observable and writable when the release has no main-program endpoint", async () => {
  const { state, client, replace } = fixture()
  client.mainPrograms = unimplementedMainPrograms

  const inspection = await inspectSourceWithClient(client as never, "w200", fileUri)
  assert.equal(inspection.activeSource, oldSource)
  assert.equal(inspection.objectName, "ZTEST_TOP")

  const result = await replace()
  assert.equal(result.saveSucceeded, true)
  assert.equal(state.saves, 1)
  assert.equal(result.activation.success, true)
  assert.equal(result.activeFingerprint, hashSource(newSource))
  // Activated by its own URI: no context can be invented for a lookup SAP does not implement.
  assert.equal(state.posts.length, 1)
  assert.ok(!state.posts[0]!.includes("context="))
})

test("an unavailable main-program endpoint still uses SAP's own inventory context for the draft", async () => {
  const { state, client } = fixture()
  client.mainPrograms = unimplementedMainPrograms
  client.httpClient = inactiveHttp(() => [
    entry(`${objectUri}?context=${encodeURIComponent(mainUri)}`)
  ])
  const result = await activateTarget(client as never, objectUri, "ZTEST_TOP")
  assert.equal(result.success, true)
  assert.equal(state.posts.length, 1)
  assert.ok(state.posts[0]!.includes(`${objectUri}?context=${encodeURIComponent(mainUri)}`))
})

test("a main-program lookup that really fails never becomes a silent activation", async () => {
  const { state, client } = fixture()
  client.mainPrograms = async () => {
    throw new Error(
      "ADT GET /sap/bc/adt/programs/includes/ztest_top/mainprograms returned HTTP 500; stateful=true"
    )
  }
  const result = await activateTarget(client as never, objectUri, "ZTEST_TOP")
  assert.equal(result.success, false)
  assert.equal(result.attempted, false)
  assert.equal(state.posts.length, 0)
  assert.match(result.messages[0]!.text, /HTTP 500/)
})
test("an unimplemented main-program endpoint never excuses an unreadable include source", async () => {
  const { client } = fixture()
  client.mainPrograms = unimplementedMainPrograms
  client.getObjectSource = async () => {
    throw new Error("HTTP 404 include source unavailable")
  }
  await assert.rejects(
    inspectSourceWithClient(client as never, "w200", fileUri),
    /include source unavailable/
  )
})

test("an include created without its requested source reports the partial state, not a bare failure", async () => {
  const request = prepareCreateObjectRequest("w200", {
    objectType: "PROG/I",
    name: "ZPROBE_INC",
    description: "include write capability probe",
    packageName: "$TMP",
    source: ["DATA gv_probe TYPE c LENGTH 1."]
  })
  await assert.rejects(
    createObjectWithClient(
      {
        username: "DEVELOPER",
        stateful: "stateful",
        async loadTypes() {
          return [{ OBJECT_TYPE: "PROG/I" }]
        },
        async validateNewObject() {
          return { success: true }
        },
        async createObject() {},
        async findObjectPath() {
          return []
        },
        httpClient: inactiveHttp(),
        async getObjectSource() {
          return ""
        },
        // The edit lock is refused, so the requested source never reaches SAP while the object exists.
        async lock() {
          throw new Error("HTTP 403 not authorized for this object")
        },
        mainPrograms: unimplementedMainPrograms
      } as never,
      request,
      "EN"
    ),
    /CREATE_SOURCE_NOT_WRITTEN: ZPROBE_INC was created in SAP, but initial source write failed/
  )
})

test("an endpoint that fails without naming itself still leaves the include writable and activatable", async () => {
  const { state, client, replace } = fixture()
  client.mainPrograms = bareUnimplementedMainPrograms

  const result = await replace()
  assert.equal(result.saveSucceeded, true)
  assert.equal(result.activation.success, true)
  assert.equal(state.saves, 1)
  assert.equal(result.activeFingerprint, hashSource(newSource))
  // Activated by its own URI: SAP named no context and none is invented.
  assert.equal(state.posts.length, 1)
  assert.ok(state.posts[0]!.includes(objectUri))
  assert.ok(!state.posts[0]!.includes("context="))
})

test("SAP's inventory parent URI is the main-program context when the lookup is unavailable", async () => {
  const { state, client } = fixture()
  client.mainPrograms = bareUnimplementedMainPrograms
  // The fixture entry carries no `?context=`, only `adtcore:parentUri`, which is the other place
  // SAP's own inactive inventory names an include draft's main program.
  client.httpClient = inactiveHttp(() => [entry(objectUri)])
  const result = await activateTarget(client as never, objectUri, "ZTEST_TOP")
  assert.equal(result.success, true)
  assert.equal(state.posts.length, 1)
  assert.ok(state.posts[0]!.includes(`${objectUri}?context=${encodeURIComponent(mainUri)}`))
})

test("an activation request that fails names the request it made", async () => {
  const { state, client } = fixture()
  client.mainPrograms = bareUnimplementedMainPrograms
  client.activate = async () => {
    throw new Error("Request failed with status code 500")
  }
  const result = await activateTarget(client as never, objectUri, "ZTEST_TOP")
  assert.equal(result.success, false)
  assert.equal(result.attempted, true)
  assert.equal(state.posts.length, 0)
  assert.match(result.messages[0]!.text, /POST \/sap\/bc\/adt\/activation for /)
  assert.match(result.messages[0]!.text, /HTTP 500/)
})

test("the include list is what the program's own source names", () => {
  assert.deepEqual(
    referencedIncludeNames(
      [
        "REPORT ztest_main.",
        "* INCLUDE zcommented.",
        'INCLUDE ztest_top.   " the top include',
        "INCLUDE STRUCTURE zs_ddic_structure.",
        "  include ztest_frm.",
        "INCLUDE ztest_top."
      ].join("\n")
    ),
    ["ZTEST_TOP", "ZTEST_FRM"]
  )
})

test("activating a program activates its include drafts first and the program again after them", async () => {
  const programUri = "/sap/bc/adt/programs/programs/ztest_main"
  const { state, client } = fixture()
  client.mainPrograms = bareUnimplementedMainPrograms
  client.httpClient = inactiveHttp(() => [entry(objectUri)])
  client.getObjectSource = async (uri: string, options: { version: string }) =>
    uri === programUri
      ? "REPORT ztest_main.\nINCLUDE ztest_top."
      : options.version === "inactive"
        ? (state.draft ?? state.active)
        : state.active

  const result = await activateTarget(client as never, programUri, "ZTEST_MAIN")

  assert.equal(result.success, true)
  // The program is activated as asked, its include draft is then activated with this program as the
  // context, and the program is activated once more so its load is generated from the include text
  // that is now active.
  assert.equal(state.posts.length, 3)
  assert.ok(state.posts[0]!.includes(programUri))
  assert.ok(state.posts[1]!.includes(objectUri))
  assert.ok(state.posts[1]!.includes(`?context=${encodeURIComponent(programUri)}`))
  assert.ok(state.posts[2]!.includes(programUri))
  assert.match(result.messages.map((message) => message.text).join("\n"), /INCLUDE_GRAPH_ACTIVATED/)
})

test("a program whose include draft stays inactive is never reported as activated", async () => {
  const programUri = "/sap/bc/adt/programs/programs/ztest_main"
  const { client } = fixture()
  client.mainPrograms = bareUnimplementedMainPrograms
  client.httpClient = inactiveHttp(() => [entry(objectUri)])
  client.getObjectSource = async () => "REPORT ztest_main.\nINCLUDE ztest_top."
  client.activate = async (_name: string, uri: string) =>
    ({ success: !uri.includes("/includes/"), messages: [], inactive: [] }) as never

  const result = await activateTarget(client as never, programUri, "ZTEST_MAIN")

  assert.equal(result.success, false)
  assert.match(result.messages[0]!.text, /INCLUDE_ACTIVATION_INCOMPLETE/)
  assert.match(result.messages[0]!.text, /ZTEST_TOP/)
})

test("a program whose include graph cannot be read is warned about, not silently accepted", async () => {
  const programUri = "/sap/bc/adt/programs/programs/ztest_main"
  const { client } = fixture()
  client.getObjectSource = async () => {
    throw new Error("Request failed with status code 403")
  }

  const result = await activateTarget(client as never, programUri, "ZTEST_MAIN")

  assert.equal(result.success, true)
  assert.match(result.messages[0]!.text, /INCLUDE_GRAPH_UNVERIFIED/)
})

// SAP registers an include against the main program that pulls it in (D010INC). Once such a
// registration exists, activating the include with no context is refused with
// "Main program  is not anymore valid for include <INCLUDE>" - the double space is SAP echoing the
// value that was never supplied. The same request succeeds while no program references the include,
// because then there is no registration to validate against. That asymmetry is the w200 defect of
// 2026-09-26 08:18: the include was writable, the activation simply had no main program to send.
//
// This release publishes no way to ask an include for its main program (the `/includes/<name>/
// mainprograms` resource is unimplemented), so the service must report the gap and the way out
// instead of forwarding a message that names neither.
test("SAP's refusal to activate an include without a main program is reported as the resolution gap", async () => {
  const { client } = fixture()
  // The release has no `/mainprograms`, and the inventory entry carries no context and no parent
  // URI, which is what w200 actually returns for a PROG/I draft.
  client.mainPrograms = bareUnimplementedMainPrograms
  client.httpClient = inactiveHttp(() => [entryWithoutContext(objectUri)])
  client.activate = async () => {
    throw new Error(
      "Request failed with status code 400; Main program  is not anymore valid for include ZTEST_TOP"
    )
  }

  const result = await activateTarget(client as never, objectUri, "ZTEST_TOP")

  assert.equal(result.success, false)
  assert.equal(result.attempted, true)
  assert.match(result.messages[0]!.text, /INCLUDE_MAIN_PROGRAM_UNRESOLVED/)
  // The remedy names the path that works here, and SAP's own wording is preserved as evidence.
  assert.match(result.messages[0]!.text, /Activate the main program/)
  assert.match(result.messages[0]!.text, /not anymore valid for include/)
  // No context was invented for the failed request.
  assert.doesNotMatch(result.messages[0]!.text, /which SAP did not accept/)
})

test("a context that SAP rejects is reported together with the context that was sent", async () => {
  const { state, client } = fixture()
  // The inventory names a parent URI, so a context is resolvable - and SAP still refuses it.
  client.mainPrograms = bareUnimplementedMainPrograms
  client.httpClient = inactiveHttp(() => [entry(objectUri)])
  client.activate = async () => {
    throw new Error("Main program  is not anymore valid for include ZTEST_TOP")
  }

  const result = await activateTarget(client as never, objectUri, "ZTEST_TOP")

  assert.equal(result.success, false)
  assert.match(result.messages[0]!.text, /INCLUDE_MAIN_PROGRAM_UNRESOLVED/)
  assert.match(
    result.messages[0]!.text,
    new RegExp(`the request was sent with main program ${mainUri}`)
  )
  assert.equal(state.posts.length, 0)
})

test("an include that no program references still activates with a bare URI", async () => {
  const { state, client } = fixture()
  client.mainPrograms = bareUnimplementedMainPrograms
  // The regression guard for the discriminating control case: ZPMC_TP_PROBE_INC2 in the report had
  // no main program and activated successfully, and that must keep working.
  state.draft = newSource

  const result = await activateTarget(client as never, objectUri, "ZTEST_TOP")

  assert.equal(result.success, true)
  assert.equal(result.attempted, true)
  assert.equal(state.posts.length, 1)
  assert.ok(!state.posts[0]!.includes("context="))
})
