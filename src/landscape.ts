/**
 * Cross-system landscape reads (OP3).
 *
 * A landscape is a set of connections that play named roles (DEV/QAS/PRD). This module is the one
 * place that turns "compare what development has with what test has" into two ordinary reads
 * against two connections of the same backend. It contains no SAP call of its own and invents no
 * capability: a comparison can therefore only ever observe what a single-system read observes.
 *
 * Two rules shape the result vocabulary, and both exist to keep the answers falsifiable:
 *
 *  - A repository search miss is reported as a miss, never as absence. The service already refuses
 *    to conclude "this object does not exist" from an empty search (`tools.ts`, the same wording is
 *    used here), because a release can answer nothing for a type it cannot search. So the verdicts
 *    say `found-in-from-only`, not "missing in test".
 *  - Content is compared by the fingerprint of the active source, not by version numbers, which are
 *    per-system counters and would report a difference or a match that does not mean anything
 *    across systems. When either side's source cannot be read the verdict stops at
 *    `found-in-both` and says why, instead of treating an unreadable side as a difference.
 */

import { createHash } from "node:crypto"
import type { AbapObjectInfo, SapBackend } from "./backend.js"
import type { SystemRole } from "./config.js"
import { searchTypeCodes } from "./object-types.js"

/** One configured system as the landscape sees it. */
export interface LandscapeSystem {
  connectionId: string
  role: SystemRole | null
}

/**
 * The read surface a comparison needs.
 *
 * Narrower than `SapBackend` on purpose: it makes "this tool cannot write, lock or release anything"
 * a fact the compiler enforces rather than a promise in a description, and it lets a test supply
 * exactly this much backend instead of a full mock.
 */
export type LandscapeReadBackend = Pick<
  SapBackend,
  "connectionIds" | "connectionDetails" | "searchObjects" | "readSource"
>

/**
 * Every configured system, in configuration order.
 *
 * Order is configuration order rather than sorted, so an ambiguity error lists candidates in the
 * order the operator wrote them.
 */
export function landscapeSystems(backend: LandscapeReadBackend): LandscapeSystem[] {
  return backend.connectionIds().map((connectionId) => ({
    connectionId,
    role: backend.connectionDetails(connectionId).role ?? null
  }))
}

/**
 * Resolve a caller's system reference to exactly one configured connection.
 *
 * A connection id wins over a role, so a connection whose id happens to equal a role name stays
 * addressable by id. A role that matches more than one connection is an error rather than a silent
 * pick: "compare development with test" must not depend on which of two development systems was
 * configured first, and the error names the candidates so the caller can switch to connection ids.
 */
export function resolveLandscapeSystem(
  systems: readonly LandscapeSystem[],
  reference: string
): LandscapeSystem {
  const wanted = reference.trim()
  if (!wanted) throw new Error("A system reference is required")
  const byId = systems.find((system) => system.connectionId.toLowerCase() === wanted.toLowerCase())
  if (byId) return byId
  const role = wanted.toUpperCase()
  const byRole = systems.filter((system) => system.role === role)
  if (byRole.length === 1) return byRole[0]!
  if (byRole.length > 1) {
    throw new Error(
      `Role ${role} matches ${byRole.length} connections (${byRole
        .map((system) => system.connectionId)
        .join(", ")}); name one of them by connection id instead`
    )
  }
  const roles = [
    ...new Set(
      systems.map((system) => system.role).filter((item): item is SystemRole => item !== null)
    )
  ]
  throw new Error(
    `Unknown system reference: ${reference}. Configured connections: ${
      systems.map((system) => system.connectionId).join(", ") || "(none)"
    }${roles.length > 0 ? `; declared roles: ${roles.join(", ")}` : "; no connection declares a role"}`
  )
}

export interface CompareSystemsInput {
  objectType: string
  objectName: string
  from: string
  to: string
}

/** How one side of the comparison turned out. */
export interface LandscapeSide {
  requested: string
  connectionId: string
  role: SystemRole | null
  status: "found" | "not-found" | "lookup-failed"
  package: string | null
  uri: string | null
  sourceHash: string | null
  sourceLineCount: number | null
  note: string | null
}

export type LandscapeVerdict =
  | "incomparable"
  | "not-found-in-either"
  | "found-in-from-only"
  | "found-in-to-only"
  | "found-in-both"
  | "identical-source"
  | "different-source"

export interface CompareSystemsResult {
  object: { type: string; name: string; searchTypes: string[] }
  from: LandscapeSide
  to: LandscapeSide
  verdict: LandscapeVerdict
  comparedAt: string
  readOnly: true
  caveats: string[]
}

/** How many search rows a side may return before the exact-name match is looked for. */
const OBJECT_SEARCH_LIMIT = 50

const SEARCH_MISS_CAVEAT =
  "A repository search miss is not proof that the object does not exist: a release can answer " +
  "nothing for a type it cannot search. Verify the exact name and type with search_abap_objects " +
  "before concluding anything about that system."

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Observe one object on one system: whether the repository search returns it, in which package, and
 * the fingerprint of its active source.
 *
 * The two failure modes are kept apart on purpose. A search that throws means "this comparison
 * could not be made"; a search that returns other rows means "this system's search did not offer
 * that name". Collapsing them would let an unreachable system look like a system without the
 * object, which is the answer someone would act on.
 */
async function observeSide(
  backend: LandscapeReadBackend,
  system: LandscapeSystem,
  requested: string,
  searchTypes: readonly string[],
  objectName: string
): Promise<LandscapeSide> {
  const side: LandscapeSide = {
    requested,
    connectionId: system.connectionId,
    role: system.role,
    status: "not-found",
    package: null,
    uri: null,
    sourceHash: null,
    sourceLineCount: null,
    note: null
  }
  let matches: AbapObjectInfo[]
  try {
    matches = await backend.searchObjects(
      system.connectionId,
      objectName,
      [...searchTypes],
      OBJECT_SEARCH_LIMIT
    )
  } catch (error) {
    return {
      ...side,
      status: "lookup-failed",
      note: `the repository search failed: ${messageOf(error)}`
    }
  }
  const object = matches.find(
    (candidate) => candidate.name.trim().toUpperCase() === objectName.toUpperCase()
  )
  if (!object) {
    return {
      ...side,
      note: `the repository search returned ${matches.length} row(s) for this type, none named ${objectName}`
    }
  }
  const found: LandscapeSide = {
    ...side,
    status: "found",
    package: object.package.trim() || null,
    uri: object.uri
  }
  try {
    // Active source, because the question is what that system would compile and run today.
    const source = await backend.readSource(system.connectionId, object, { version: "active" })
    return {
      ...found,
      sourceHash: createHash("sha256").update(source.source, "utf8").digest("hex"),
      sourceLineCount: source.source === "" ? 0 : source.source.split(/\r?\n/).length
    }
  } catch (error) {
    return {
      ...found,
      note: `the object was found but its active source could not be read: ${messageOf(error)}`
    }
  }
}

function verdictOf(from: LandscapeSide, to: LandscapeSide): LandscapeVerdict {
  if (from.status === "lookup-failed" || to.status === "lookup-failed") return "incomparable"
  if (from.status === "not-found" && to.status === "not-found") return "not-found-in-either"
  if (from.status === "not-found") return "found-in-to-only"
  if (to.status === "not-found") return "found-in-from-only"
  if (from.sourceHash !== null && to.sourceHash !== null) {
    return from.sourceHash === to.sourceHash ? "identical-source" : "different-source"
  }
  return "found-in-both"
}

/**
 * Compare one object between two configured systems.
 *
 * Both sides are read the same way and in the same call, so a caller cannot compare a cached
 * observation of one system with a fresh one of another.
 */
export async function compareSystems(
  backend: LandscapeReadBackend,
  input: CompareSystemsInput
): Promise<CompareSystemsResult> {
  const systems = landscapeSystems(backend)
  if (systems.length < 2) {
    throw new Error(
      `compare_systems needs at least two configured connections; this service has ${systems.length}. ` +
        "Add the second system to connections.json first."
    )
  }
  const from = resolveLandscapeSystem(systems, input.from)
  const to = resolveLandscapeSystem(systems, input.to)
  if (from.connectionId === to.connectionId) {
    // Not a harmless no-op: two roles resolving to one connection is a landscape misconfiguration,
    // and answering "identical" would hide it behind a plausible-looking result.
    throw new Error(
      `"${input.from}" and "${input.to}" both resolve to connection ${from.connectionId}; ` +
        "a landscape comparison needs two different systems."
    )
  }
  const objectName = input.objectName.trim().toUpperCase()
  if (!objectName) throw new Error("objectName is required")
  // Throws for a type token the shared vocabulary does not know, which is how a caller learns the
  // accepted values instead of receiving an empty comparison for a type that cannot be searched.
  const searchTypes = searchTypeCodes([input.objectType])

  const [fromSide, toSide] = await Promise.all([
    observeSide(backend, from, input.from, searchTypes, objectName),
    observeSide(backend, to, input.to, searchTypes, objectName)
  ])
  const verdict = verdictOf(fromSide, toSide)
  const caveats: string[] = []
  if (fromSide.status !== "found" || toSide.status !== "found") caveats.push(SEARCH_MISS_CAVEAT)
  if (verdict === "identical-source") {
    caveats.push(
      "Identical fingerprints mean the two systems hold the same active source text. They do not " +
        "mean the two systems are configured alike, nor that either object is active and consistent."
    )
  }

  return {
    object: { type: input.objectType.trim().toUpperCase(), name: objectName, searchTypes },
    from: fromSide,
    to: toSide,
    verdict,
    comparedAt: new Date().toISOString(),
    readOnly: true,
    caveats
  }
}
