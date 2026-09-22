import assert from "node:assert/strict"
import test from "node:test"
import type { ADTClient } from "abap-adt-api"
import {
  VersionHistoryUnavailableError,
  capabilityFailure,
  loadRevisionObjectStructure,
  revisionFailure,
  structureUriFor
} from "../src/adt-backend.js"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"

/**
 * 0.46.12 guard for the 18:07 incident.
 *
 * `get_version_history` on a transparent table whose only version is inactive returned HTTP 500 with
 * "Cannot read properties of undefined (reading 'adtcore:changedAt')". The ADT object-structure
 * response had no root element, so the library's XML attribute read crashed on `undefined`, and the
 * wrapper reported that local defect as a server failure. The caller could not tell "this object has
 * no versions" from "this read is unavailable" and stopped one step before the pre-write checks it
 * still owed, so both halves matter: never crash, and never claim an HTTP fault that did not happen.
 */

const TABLE_URI = "/sap/bc/adt/ddic/tables/ztpmc_tprpi"

function fakeClient(objectStructure: () => Promise<unknown>, body: string, contentType: string) {
  return {
    objectStructure,
    httpClient: {
      request: async () => ({ status: 200, headers: { "content-type": contentType }, body })
    }
  } as unknown as ADTClient
}

function rootlessStructureError(): Error {
  return new TypeError("Cannot read properties of undefined (reading 'adtcore:changedAt')")
}

test("a structure document without a root element becomes a structured unavailable state", async () => {
  const cases = [
    { body: "", contentType: "text/html", code: "VERSION_HISTORY_STRUCTURE_EMPTY" },
    {
      body: "<html><body>Logon</body></html>",
      contentType: "text/html",
      code: "VERSION_HISTORY_STRUCTURE_UNPARSEABLE"
    },
    {
      body: "Service unavailable",
      contentType: "text/plain",
      code: "VERSION_HISTORY_STRUCTURE_NOT_XML"
    }
  ]
  for (const item of cases) {
    const client = fakeClient(
      async () => Promise.reject(rootlessStructureError()),
      item.body,
      item.contentType
    )
    await assert.rejects(
      () => loadRevisionObjectStructure(client, TABLE_URI),
      (error: unknown) => {
        assert.ok(
          error instanceof VersionHistoryUnavailableError,
          `expected VersionHistoryUnavailableError, got ${String(error)}`
        )
        assert.equal(error.code, item.code)
        assert.equal(error.detail.objectUri, TABLE_URI)
        assert.equal(error.detail.httpStatus, 200)
        assert.equal(error.detail.bodyLength, item.body.length)
        assert.match(error.detail.cause, /adtcore:changedAt/)
        // The message must describe what was read, not invent an HTTP failure.
        assert.doesNotMatch(error.message, /HTTP 500/)
        return true
      }
    )
  }
})

test("a structure that cannot be re-read still reports the parser defect", async () => {
  const client = {
    objectStructure: async () => Promise.reject(rootlessStructureError()),
    httpClient: {
      request: async () => {
        throw new Error("connection reset")
      }
    }
  } as unknown as ADTClient
  await assert.rejects(
    () => loadRevisionObjectStructure(client, TABLE_URI),
    (error: unknown) => {
      assert.ok(error instanceof VersionHistoryUnavailableError)
      assert.equal(error.code, "VERSION_HISTORY_STRUCTURE_UNREADABLE")
      assert.equal(error.detail.bodyLength, undefined)
      assert.match(error.detail.cause, /connection reset/)
      return true
    }
  )
})

test("a local parse crash is never reported as an HTTP status", () => {
  const failure = capabilityFailure("version-history", rootlessStructureError())
  assert.match(failure.message, /version-history capability parser-or-content-type/)
  assert.doesNotMatch(failure.message, /HTTP \d{3}/)
  // A plain error that merely carries a `status` property is not an HTTP exchange either: the
  // library's own wrapper defaults unknown failures to 500, which is how a local crash was once
  // reported as a server fault.
  const fabricated = Object.assign(new Error("Unauthorized"), { status: 401 })
  assert.doesNotMatch(capabilityFailure("version-history", fabricated).message, /HTTP \d{3}/)
  // A status the server actually reported keeps its category and code.
  const forbidden = capabilityFailure("version-history", new Error("Error 403: Forbidden"))
  assert.match(forbidden.message, /forbidden-or-not-authorized \(HTTP 403\)/)
})

test("a repository-navigation URL is replaced by the canonical resource path", () => {
  // Live evidence (18:07 follow-up, read-only): ADT search returns
  // /sap/bc/adt/vit/wb/object_type/tabldt/object_name/DD02L for tables, and requesting it as an
  // object structure yields a body with no root element. A class, whose search URI is already a
  // resource, works, and both an active Z table and DD02L failed - so this is a URI defect for DDIC
  // objects, not an inactive-state defect.
  assert.equal(
    structureUriFor("TABL/DT", "DD02L", "/sap/bc/adt/vit/wb/object_type/tabldt/object_name/DD02L"),
    "/sap/bc/adt/ddic/tables/DD02L"
  )
  assert.equal(
    structureUriFor(
      "TABL/DT",
      "ZTPMC_BZWL",
      "/sap/bc/adt/vit/wb/object_type/tabldt/object_name/ZTPMC_BZWL"
    ),
    "/sap/bc/adt/ddic/tables/ZTPMC_BZWL"
  )
  // An already-canonical URI is left alone.
  assert.equal(
    structureUriFor("CLAS/OC", "CL_ABAP_TYPEDESCR", "/sap/bc/adt/oo/classes/cl_abap_typedescr"),
    "/sap/bc/adt/oo/classes/cl_abap_typedescr"
  )
  // Another creatable type is corrected the same way; only types with no creation path fall back.
  assert.equal(
    structureUriFor(
      "FUGR/F",
      "ZORVANTA",
      "/sap/bc/adt/vit/wb/object_type/fugr/object_name/ZORVANTA"
    ),
    "/sap/bc/adt/functions/groups/ZORVANTA"
  )
  assert.equal(
    structureUriFor("VIEW/DV", "ZVIEW", "/sap/bc/adt/vit/wb/object_type/viewdv/object_name/ZVIEW"),
    "/sap/bc/adt/vit/wb/object_type/viewdv/object_name/ZVIEW"
  )
})

test("a structure without the version feed relation is a structured unsupported answer", () => {
  const failure = revisionFailure(new Error("Revision URL not found for object DD02L"), TABLE_URI)
  assert.ok(failure instanceof VersionHistoryUnavailableError)
  assert.equal(failure.code, "VERSION_HISTORY_UNSUPPORTED_FOR_TYPE")
  assert.equal(failure.detail.objectUri, TABLE_URI)
  // An already-structured failure passes through, and any other failure keeps the capability text.
  const structured = new VersionHistoryUnavailableError("VERSION_HISTORY_STRUCTURE_EMPTY", {
    objectUri: TABLE_URI,
    cause: "x"
  })
  assert.equal(revisionFailure(structured, TABLE_URI), structured)
  assert.match(revisionFailure(new Error("boom"), TABLE_URI).message, /version-history capability/)
})

test("version history returns a structured state for an unreadable object", async () => {
  const backend = new MockBackend()
  const error = new VersionHistoryUnavailableError("VERSION_HISTORY_STRUCTURE_EMPTY", {
    objectUri: TABLE_URI,
    httpStatus: 200,
    contentType: "text/html",
    bodyLength: 0,
    bodyHead: "",
    cause: "Cannot read properties of undefined (reading 'adtcore:changedAt')"
  })
  backend.revisions = async () => {
    throw error
  }
  const result = JSON.parse(
    await new ToolService(backend).getVersionHistory({
      action: "list_versions",
      connectionId: "w200",
      objectName: "ZCL_DEMO",
      objectType: "CLAS/OC",
      maxVersions: 10
    })
  ) as {
    status: string
    code: string
    versionHistoryAvailable: boolean
    reason: string
    adt: { httpStatus: number | null; bodyLength: number | null }
    possibleCause: string
    substitutes: string[]
    automaticRetry: boolean
    cause: string
  }
  assert.equal(result.status, "unavailable")
  assert.equal(result.code, "VERSION_HISTORY_STRUCTURE_EMPTY")
  assert.equal(result.versionHistoryAvailable, false)
  assert.match(result.reason, /not evidence that the object has no versions/)
  assert.equal(result.adt.httpStatus, 200)
  assert.equal(result.adt.bodyLength, 0)
  // The reply must say what to use instead, so the pre-write check can still be completed.
  assert.match(result.possibleCause, /not a structure resource|no version feed/)
  assert.ok(result.substitutes.some((item) => item.includes("read_ddic_transparent_table")))
  assert.ok(result.substitutes.some((item) => item.includes("read_ddic_table_conversion_status")))
  assert.equal(result.automaticRetry, false)
  assert.match(result.cause, /adtcore:changedAt/)
})
