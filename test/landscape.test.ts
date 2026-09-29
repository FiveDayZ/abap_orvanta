/**
 * OP3 landscape comparison.
 *
 * These tests exist to falsify the verdict vocabulary, not to exercise the plumbing: the ways a
 * comparison could lie are that a failed search becomes "absent", that two different programs become
 * "identical", and that an unreadable source becomes "different". Each has a test below.
 *
 * The fake supplies only the four read methods a comparison is allowed to use, so a future version of
 * `compareSystems` that reached for a write path would not compile against it.
 */

import assert from "node:assert/strict"
import test from "node:test"
import type { AbapObjectInfo, SourceResult } from "../src/backend.js"
import {
  compareSystems,
  resolveLandscapeSystem,
  type LandscapeReadBackend,
  type LandscapeSystem
} from "../src/landscape.js"

interface FakeSystem extends LandscapeSystem {
  /** Package the search reports for the object. */
  package?: string
  /** Active source text. */
  source?: string
  /** Names the repository search answers with; omitted means "no row for this name". */
  names?: string[]
  /** The repository search itself fails, which is not the same as a search miss. */
  searchFails?: boolean
  /** The object is found but its active source cannot be read. */
  sourceFails?: boolean
}

/**
 * `searches` records what each side was actually asked to search for, so a test can assert what
 * reached the backend rather than only what came back from it.
 */
function fakeBackend(
  systems: readonly FakeSystem[],
  searches: { connectionId: string; types: string[] }[] = []
): LandscapeReadBackend {
  const byId = new Map(systems.map((system) => [system.connectionId, system]))
  return {
    connectionIds: () => systems.map((system) => system.connectionId),
    connectionDetails: (connectionId: string) => {
      const system = byId.get(connectionId)
      if (!system) throw new Error(`Connection not found: ${connectionId}`)
      return {
        url: "https://sap.example.invalid",
        client: "200",
        language: "EN",
        username: "DEVELOPER",
        role: system.role,
        remoteFunctionAllowlist: []
      }
    },
    searchObjects: async (
      connectionId: string,
      _pattern: string,
      types: string[] | undefined
    ): Promise<AbapObjectInfo[]> => {
      const system = byId.get(connectionId)
      if (!system) throw new Error(`Connection not found: ${connectionId}`)
      searches.push({ connectionId, types: [...(types ?? [])] })
      if (system.searchFails) throw new Error(`repository search unavailable on ${connectionId}`)
      return (system.names ?? []).map((name) => ({
        name,
        type: "CLAS/OC",
        description: "",
        package: system.package ?? "$TMP",
        systemType: "CUSTOM",
        uri: `/sap/bc/adt/oo/classes/${name.toLowerCase()}`
      }))
    },
    readSource: async (connectionId: string, object: AbapObjectInfo): Promise<SourceResult> => {
      const system = byId.get(connectionId)
      if (!system) throw new Error(`Connection not found: ${connectionId}`)
      if (system.sourceFails) throw new Error(`source read failed on ${connectionId}`)
      return { source: system.source ?? "", uriUsed: object.uri }
    }
  }
}

const DEV: FakeSystem = { connectionId: "dev200", role: "DEV" }
const QAS: FakeSystem = { connectionId: "qas300", role: "QAS" }
const input = { objectType: "CLAS", objectName: "ZCL_ORDER", from: "DEV", to: "QAS" }

test("a system reference resolves by connection id first, then by role", () => {
  const systems: LandscapeSystem[] = [
    { connectionId: "dev200", role: "DEV" },
    { connectionId: "qas300", role: "QAS" },
    // A connection whose id is spelled like a role must stay addressable by that id.
    { connectionId: "prd", role: null }
  ]
  assert.deepEqual(resolveLandscapeSystem(systems, "QAS300"), {
    connectionId: "qas300",
    role: "QAS"
  })
  assert.equal(resolveLandscapeSystem(systems, "dev").connectionId, "dev200")
  assert.equal(resolveLandscapeSystem(systems, "prd").connectionId, "prd")
})

test("an ambiguous or unknown system reference is refused, never guessed", () => {
  const systems: LandscapeSystem[] = [
    { connectionId: "dev200", role: "DEV" },
    { connectionId: "dev400", role: "DEV" },
    { connectionId: "qas300", role: "QAS" }
  ]
  // Two development systems: picking the first one would silently compare against whichever the
  // operator happened to list first, so the candidates have to come back to the caller instead.
  assert.throws(
    () => resolveLandscapeSystem(systems, "DEV"),
    /Role DEV matches 2 connections \(dev200, dev400\); name one of them by connection id instead/
  )
  assert.throws(
    () => resolveLandscapeSystem(systems, "PRD"),
    /Unknown system reference: PRD\. Configured connections: dev200, dev400, qas300; declared roles: DEV, QAS/
  )
  assert.throws(() => resolveLandscapeSystem(systems, "  "), /A system reference is required/)
  assert.throws(
    () => resolveLandscapeSystem([{ connectionId: "dev200", role: null }], "DEV"),
    /no connection declares a role/
  )
})

test("identical active source is reported as identical, and a real difference as different", async () => {
  const same = await compareSystems(
    fakeBackend([
      { ...DEV, names: ["ZCL_ORDER"], source: "CLASS zcl_order DEFINITION.\nENDCLASS.\n" },
      { ...QAS, names: ["ZCL_ORDER"], source: "CLASS zcl_order DEFINITION.\nENDCLASS.\n" }
    ]),
    input
  )
  assert.equal(same.verdict, "identical-source")
  assert.equal(same.from.sourceHash, same.to.sourceHash)
  assert.equal(same.from.sourceLineCount, 3)
  assert.equal(same.readOnly, true)

  const different = await compareSystems(
    fakeBackend([
      { ...DEV, names: ["ZCL_ORDER"], source: "CLASS zcl_order DEFINITION.\nENDCLASS.\n" },
      {
        ...QAS,
        names: ["ZCL_ORDER"],
        source: "CLASS zcl_order DEFINITION.\n  METHODS old.\nENDCLASS.\n"
      }
    ]),
    input
  )
  assert.equal(different.verdict, "different-source")
  assert.notEqual(different.from.sourceHash, different.to.sourceHash)
  assert.equal(different.from.sourceLineCount, 3)
  assert.equal(different.to.sourceLineCount, 4)
})

test("a failed search is incomparable, never absence, and a search miss is only a miss", async () => {
  // The distinction this guards: an unreachable system and a system without the object must not
  // produce the same answer, because only one of them is worth acting on.
  const unreachable = await compareSystems(
    fakeBackend([
      { ...DEV, names: ["ZCL_ORDER"], source: "CLASS zcl_order DEFINITION.\nENDCLASS.\n" },
      { ...QAS, searchFails: true }
    ]),
    input
  )
  assert.equal(unreachable.verdict, "incomparable")
  assert.equal(unreachable.to.status, "lookup-failed")
  assert.match(unreachable.to.note ?? "", /repository search unavailable on qas300/)

  const missingInTest = await compareSystems(
    fakeBackend([
      { ...DEV, names: ["ZCL_ORDER"], source: "CLASS zcl_order DEFINITION.\nENDCLASS.\n" },
      { ...QAS, names: [] }
    ]),
    input
  )
  // `from` is the system that has it and `to` is the system that does not, so the verdict names the
  // side the object was actually found in. The direction is asserted because getting it backwards
  // would tell an operator the object is missing from development when it is missing from test.
  assert.equal(missingInTest.verdict, "found-in-from-only")
  assert.equal(missingInTest.from.status, "found")
  assert.equal(missingInTest.to.status, "not-found")
  assert.ok(
    missingInTest.caveats.some((caveat) => /search miss is not proof/.test(caveat)),
    "a search miss must carry the caveat that it is not proof of absence"
  )

  const missingInBoth = await compareSystems(fakeBackend([DEV, QAS]), input)
  assert.equal(missingInBoth.verdict, "not-found-in-either")
})

test("an unreadable source stops at found-in-both instead of posing as a difference", async () => {
  const result = await compareSystems(
    fakeBackend([
      { ...DEV, names: ["ZCL_ORDER"], source: "CLASS zcl_order DEFINITION.\nENDCLASS.\n" },
      {
        ...QAS,
        names: ["ZCL_ORDER"],
        source: "CLASS zcl_order DEFINITION.\nENDCLASS.\n",
        sourceFails: true
      }
    ]),
    input
  )
  assert.equal(result.verdict, "found-in-both")
  assert.equal(result.to.status, "found")
  assert.equal(result.to.sourceHash, null)
  assert.match(result.to.note ?? "", /active source could not be read/)
  assert.equal(result.to.package, "$TMP")
})

test("comparing a system with itself, or with nothing to compare against, is refused", async () => {
  // Two references that resolve to one connection is a landscape misconfiguration; answering
  // "identical" would hide it behind a plausible-looking result.
  await assert.rejects(
    compareSystems(
      fakeBackend([
        { ...DEV, names: ["ZCL_ORDER"], source: "" },
        { ...QAS, names: ["ZCL_ORDER"], source: "" }
      ]),
      { ...input, from: "dev200", to: "DEV" }
    ),
    /both resolve to connection dev200; a landscape comparison needs two different systems/
  )
  await assert.rejects(
    compareSystems(fakeBackend([DEV]), input),
    /needs at least two configured connections; this service has 1/
  )
})

test("an ADT path this release cannot search is refused, an unlisted short code is passed through", async () => {
  // A token containing "/" is an ADT type path and can never be a search code, so searching it would
  // fabricate a "not found" for an object that may exist: it is refused before SAP is contacted.
  await assert.rejects(
    compareSystems(
      fakeBackend([
        { ...DEV, names: ["ZCL_ORDER"], source: "x" },
        { ...QAS, names: ["ZCL_ORDER"], source: "x" }
      ]),
      { ...input, objectType: "NOT/A_TYPE" }
    ),
    /UNSUPPORTED_OBJECT_TYPE: NOT\/A_TYPE is not an object type this service can search/
  )

  // A short code this release does not list is a different case and deliberately not rejected: it is
  // still the caller's statement about the object, and the search decides what it can answer. This
  // asserts the pass-through reaches both systems unchanged, which is the documented behaviour.
  const searches: { connectionId: string; types: string[] }[] = []
  await compareSystems(
    fakeBackend(
      [
        { ...DEV, names: ["ZCL_ORDER"], source: "x" },
        { ...QAS, names: ["ZCL_ORDER"], source: "x" }
      ],
      searches
    ),
    { ...input, objectType: "not_a_type" }
  )
  assert.equal(searches.length, 2)
  for (const search of searches) assert.deepEqual(search.types, ["NOT_A_TYPE"])
  assert.deepEqual(searches.map((search) => search.connectionId).sort(), ["dev200", "qas300"])
})

test("the role a connection declares is reported on both sides of the result", async () => {
  const result = await compareSystems(
    fakeBackend([
      { ...DEV, names: ["ZCL_ORDER"], source: "same" },
      { ...QAS, names: ["ZCL_ORDER"], source: "same" }
    ]),
    input
  )
  assert.equal(result.from.role, "DEV")
  assert.equal(result.to.role, "QAS")
  assert.equal(result.object.name, "ZCL_ORDER")
  assert.deepEqual(result.object.searchTypes, ["CLAS"])
})
