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
  // Refuses a token containing "/" that is not an ADT path this release can search, because searching
  // such a path would fabricate a "not found" for an object that may exist. A short code this release
  // does not list is passed through unchanged on purpose: it is still the caller's statement about the
  // object, and the search itself decides what it can answer.
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

/** One object entry as a transport reports it. */
export interface TransportEntry {
  pgmid: string
  type: string
  name: string
  /** Where the entry sits: the request itself, or the task that owns it. */
  container: string
}

/** A transport request as the promotion check reads it. */
export interface TransportFacts {
  owner: string
  /** CTS status: D/L are modifiable, R/O are released. */
  status: string
  entries: TransportEntry[]
}

/**
 * The reads a promotion check needs beyond the object comparison.
 *
 * Injected rather than taken from the backend because two of them are not plain backend calls: a
 * request's target system comes from its owner's transport list (the details document does not carry
 * it at all), and a connection's system id comes from the fingerprint-gated RFC_SYSTEM_INFO read.
 * Either can legitimately fail to answer, which the check reports as "not verified" rather than
 * guessing - the whole point of the check is to not tell someone their object is on its way when it
 * is queued for a different system.
 */
export interface PromotionReaders {
  transport(connectionId: string, transportNumber: string): Promise<TransportFacts>
  targetSystem(connectionId: string, transportNumber: string, owner: string): Promise<string | null>
  systemId(connectionId: string): Promise<string | null>
}

export interface PromoteObjectInput extends CompareSystemsInput {
  // `| undefined` because the tool input shape produces the key explicitly, and this repository
  // compiles with exactOptionalPropertyTypes.
  transportNumber?: string | undefined
}

export type PromotionVerdict =
  | "incomparable"
  | "already-identical"
  | "not-in-source-system"
  | "no-transport-named"
  | "request-not-found"
  | "not-in-request"
  | "request-targets-another-system"
  | "in-modifiable-request"
  | "in-released-request"

export interface PromotionReadiness {
  object: { type: string; name: string; searchTypes: string[] }
  from: LandscapeSide
  to: LandscapeSide
  comparison: LandscapeVerdict
  transport: {
    requested: string
    status: string | null
    owner: string | null
    targetSystem: string | null
    /** true/false once both the request's target and the target system's id are known, else null. */
    targetIsRequestedSystem: boolean | null
    /** Where the object sits in the request, or null when it is not recorded there. */
    container: string | null
  } | null
  verdict: PromotionVerdict
  checkedAt: string
  readOnly: true
  caveats: string[]
}

/** CTS statuses that still accept objects. R and O are released and no longer modifiable. */
const MODIFIABLE_TRANSPORT_STATUSES = ["D", "L"]

interface ContainerMatch {
  found: boolean
  container: string | null
  /** A same-named entry whose type is not the type asked for, reported rather than counted. */
  sameNameOtherType: string | null
}

/**
 * Where the object sits in the request, if it is there at all.
 *
 * The type must match as well as the name: a program and a class can carry the same name, and
 * counting a same-named entry of another type would answer "it is on its way" about an object that
 * is not. A same-named entry of a different type is reported so the caller can see why the answer is
 * "not in this request" instead of having to guess.
 */
function findContainer(
  facts: TransportFacts,
  objectType: string,
  objectName: string,
  searchTypes: readonly string[]
): ContainerMatch {
  const acceptedTypes = new Set(
    [objectType, ...searchTypes].map((type) => type.trim().toUpperCase())
  )
  let sameNameOtherType: string | null = null
  for (const entry of facts.entries) {
    if (entry.name.trim().toUpperCase() !== objectName) continue
    if (acceptedTypes.has(entry.type.trim().toUpperCase())) {
      return { found: true, container: entry.container, sameNameOtherType: null }
    }
    sameNameOtherType ??= `${entry.type} ${entry.name}`
  }
  return { found: false, container: null, sameNameOtherType }
}

/**
 * Answer "can this object be promoted to that system?" from reads only.
 *
 * It never promotes: releasing a request and importing it stay outside the service, and the verdict
 * vocabulary is built so the tool cannot imply otherwise. What it does answer are the three facts
 * the question turns on - whether the target already holds the same source, whether the object is
 * recorded in a request, and whether that request is aimed at the system the caller named.
 */
export async function promoteObject(
  backend: LandscapeReadBackend,
  readers: PromotionReaders,
  input: PromoteObjectInput
): Promise<PromotionReadiness> {
  const comparison = await compareSystems(backend, input)
  const caveats = [...comparison.caveats]
  caveats.push(
    "This is a readiness check only: the service does not release the request and does not import " +
      "it, so a favourable verdict is not a promotion and is not proof that the target has the object."
  )

  const requested = (input.transportNumber ?? "").trim().toUpperCase()
  let facts: TransportFacts | null = null
  let readError: string | null = null
  if (requested) {
    try {
      facts = await readers.transport(comparison.from.connectionId, requested)
    } catch (error) {
      readError = messageOf(error)
    }
  }

  const targetSystem =
    facts && requested
      ? await readers
          .targetSystem(comparison.from.connectionId, requested, facts.owner)
          .catch(() => null)
      : null
  const targetSystemId =
    facts && targetSystem
      ? await readers.systemId(comparison.to.connectionId).catch(() => null)
      : null
  const match = facts
    ? findContainer(facts, input.objectType, comparison.object.name, comparison.object.searchTypes)
    : null
  const targetIsRequestedSystem =
    targetSystem && targetSystemId
      ? targetSystem.trim().toUpperCase() === targetSystemId.trim().toUpperCase()
      : null

  let verdict: PromotionVerdict
  if (comparison.verdict === "incomparable" || comparison.verdict === "found-in-both") {
    // Both of these mean the content comparison was not made: a search failed, or one side's active
    // source could not be read. `already-identical` is one of the answers that cannot be ruled out,
    // so the readiness question is not answered rather than answered favourably. The `comparison`
    // field keeps the precise cause, and the transport facts are still reported below.
    verdict = "incomparable"
  } else if (comparison.verdict === "identical-source") verdict = "already-identical"
  else if (
    comparison.verdict === "not-found-in-either" ||
    comparison.verdict === "found-in-to-only"
  ) {
    // Nothing can be promoted out of a system the search did not find the object in.
    verdict = "not-in-source-system"
  } else if (!requested) verdict = "no-transport-named"
  else if (!facts) verdict = "request-not-found"
  else if (!match?.found) verdict = "not-in-request"
  else if (targetIsRequestedSystem === false) verdict = "request-targets-another-system"
  else if (MODIFIABLE_TRANSPORT_STATUSES.includes((facts.status ?? "").trim().toUpperCase())) {
    verdict = "in-modifiable-request"
  } else verdict = "in-released-request"

  if (comparison.verdict === "found-in-both") {
    caveats.push(
      "The active source could not be read on at least one side, so the two systems' content was " +
        "not compared and the readiness question is left unanswered."
    )
  }
  if (verdict === "not-in-source-system") {
    caveats.push(
      `The repository search did not find the object on ${comparison.from.connectionId}, so there is ` +
        "nothing in that system to promote. A search miss is not proof of absence, which is what the " +
        "comparison above reports."
    )
  }

  if (readError) caveats.push(`Request ${requested} could not be read: ${readError}`)
  if (facts && match?.sameNameOtherType) {
    caveats.push(
      `Request ${requested} holds an entry named ${comparison.object.name} of a different type ` +
        `(${match.sameNameOtherType}); it was not counted as the object asked for.`
    )
  }
  if (facts && !targetSystem) {
    caveats.push(
      `The target system of request ${requested} could not be read from its owner's transport list, ` +
        `so it was not verified against ${comparison.to.connectionId}.`
    )
  }
  if (facts && targetSystem && !targetSystemId) {
    caveats.push(
      `The system id of ${comparison.to.connectionId} could not be read, so request ${requested} ` +
        `could not be verified as aimed at it.`
    )
  }
  if (verdict === "request-targets-another-system") {
    caveats.push(
      `Request ${requested} is aimed at ${targetSystem}, not at ${comparison.to.connectionId} ` +
        `(${targetSystemId}); releasing it would not deliver the object there.`
    )
  }
  if (verdict === "in-released-request") {
    caveats.push(
      `Request ${requested} is released (status ${facts?.status}), so its objects have been exported ` +
        "to its target and it can no longer take objects. Whether the target actually has the object " +
        "is what the comparison above reports."
    )
  }

  return {
    object: comparison.object,
    from: comparison.from,
    to: comparison.to,
    comparison: comparison.verdict,
    transport: requested
      ? {
          requested,
          status: facts?.status ?? null,
          owner: facts?.owner ?? null,
          targetSystem,
          targetIsRequestedSystem,
          container: match?.container ?? null
        }
      : null,
    verdict,
    checkedAt: new Date().toISOString(),
    readOnly: true,
    caveats
  }
}
