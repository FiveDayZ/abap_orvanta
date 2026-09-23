/**
 * S4 / R-8 verification registry: the evidence layer that keeps "capability says available" and
 * "actually observed to work" as two orthogonal, separately visible facts.
 *
 * R-20 is why this module exists. Four tools were reported `available` because the helper's
 * self-described protocol version satisfied the registry, while two of them had never run at all
 * and two had only ever failed. Availability was a *static inference* dressed up as an observation.
 * The registry therefore never computes availability: {@link VerificationStatus} is read from
 * evidence and is deliberately kept out of any availability verdict, so the two dimensions cannot
 * silently merge back into the defect this work removes.
 *
 * The honest default is `available` + `unverified`. That combination is normal, not a defect, and
 * nothing here may present `available` as "verified".
 *
 * PACKAGING CONSEQUENCE (deployment-visible, deliberate, not a bug).
 * Most evidence paths point at `.doc/...`, which is the workspace documentation root *beside* this
 * repository rather than inside it (see {@link evidenceRoots}). In a packaged release there is no
 * `.doc` directory next to the binary, so `existsSync` fails for those entries and every `verified`
 * claim degrades to `unverified` at runtime. That is the SAFE direction - the service under-claims
 * rather than over-claims, which is the whole point of this layer - so it is accepted behaviour.
 * The follow-up, deliberately not solved here, is either to package the evidence into the release
 * or to freeze verification status at authoring time. Do not "fix" this by dropping the existence
 * check: the check is what makes a `verified` claim falsifiable, and a registry that asserts
 * success it cannot demonstrate is the R-20 defect returning.
 */
import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Repository root, resolved from this module so callers never depend on the process cwd.
 *
 * The same module is executed from two layouts: `src/` under `tsx`/tests and `dist/src/` after
 * `npm run build`. The build emits into `dist/` and does not copy `contracts/`, so a single `..`
 * resolves to the repository root in the first layout but to `dist/` in the second - which made
 * `contracts/verification-registry.json` unfindable in the packaged/compiled form. Step up one
 * extra level whenever the parent directory is `dist`, the same rule `runtime-info.ts` uses.
 */
const moduleDirectory = dirname(fileURLToPath(import.meta.url))
export const repositoryRoot = resolve(
  moduleDirectory,
  basename(dirname(moduleDirectory)) === "dist" ? "../.." : ".."
)

/**
 * Roots an evidence path may be relative to, in resolution order.
 *
 * The design writes evidence paths as `.doc/code-update-*.md` and `.logs/mcp-incident-*.md`, but
 * only `.logs` lives inside this repository: `.doc` is the workspace-level documentation root that
 * AGENTS.md section 2 makes authoritative for SAP records, so it sits *beside* the repository. The
 * registry therefore keeps the design's literal paths and resolves them against the repository
 * first and the workspace root second, instead of rewriting them into paths the design does not
 * use. Evidence is still required to exist on disk - only the anchor is widened.
 */
export const evidenceRoots: readonly string[] = [repositoryRoot, resolve(repositoryRoot, "..")]

export const VERIFICATION_REGISTRY_PATH = join(
  repositoryRoot,
  "contracts",
  "verification-registry.json"
)

/**
 * How a tool's *availability* is decided. Exposed per entry because `protocol-only` is the R-20c
 * weakness: a verdict that rests on the helper's self-described version alone, with no pinned
 * opcode requirement to check it against. Residual `protocol-only` entries are meant to stay
 * countable in a report rather than disappear into prose.
 */
export type AvailabilityBasis =
  | "protocol+operations"
  | "protocol-only"
  | "native-adt"
  | "target-specific"

/**
 * What is actually known about a tool, independent of whether it is available.
 *
 * - `verified`   : a real call succeeded and an immutable record of it exists.
 * - `unverified` : no real call has been recorded. The default, and not an accusation.
 * - `failed`     : provably cannot succeed. See {@link FailureBasis} for which kind of proof.
 * - `blocked`    : cannot proceed for a reason outside the implementation (authorization, config).
 * - `platform-unsupported` : the target system itself does not offer the endpoint.
 */
export type VerificationStatus =
  | "verified"
  | "unverified"
  | "failed"
  | "blocked"
  | "platform-unsupported"

/**
 * Why a `failed` entry failed, which is the distinction R-20 forced.
 *
 * - `runtime`: a real call was made and returned a failure receipt. An observation.
 * - `static` : the call was never made, but it is *proven* impossible (e.g. the opcode exceeds the
 *   helper's `IV_OPERATION` parameter length). A proof.
 *
 * They are both certain to fail, and that is their shared, actionable conclusion - but their
 * evidence strength differs, so a report counts them apart. The `static` count measures the
 * "undetected dark area" of never-called-but-doomed tools, which is usually the more alarming
 * number. A `static` entry must NOT be upgraded to `verified` merely because the underlying defect
 * was fixed: it needs a real call, exactly like any other entry.
 */
export type FailureBasis = "runtime" | "static"

export type VerificationMethod = "read-only" | "controlled-write" | "none"

export interface VerificationEntry {
  /** Tool name; must exist in `contracts/tool-index.json`, exactly once. */
  tool: string
  /** Helper function module, or `null` for a native ADT route that needs no helper. */
  helper: string | null
  availabilityBasis: AvailabilityBasis
  /** Concrete SAP object/table/request used, reproducible; required for controlled writes. */
  verificationTarget: string | null
  method: VerificationMethod
  status: VerificationStatus
  /** Required when `status` is `failed`, `null` otherwise. */
  failureBasis: FailureBasis | null
  /** ISO timestamp of the most recent real attempt; `null` when nothing was ever attempted. */
  lastAttemptAt: string | null
  /** Repository-relative path to immutable evidence; required for `verified` and `failed`. */
  evidence: string | null
  notes: string
}

export interface VerificationRegistry {
  version: number
  updatedAt: string
  notes: string
  entries: VerificationEntry[]
}

export const AVAILABILITY_BASES: readonly AvailabilityBasis[] = [
  "protocol+operations",
  "protocol-only",
  "native-adt",
  "target-specific"
]

export const VERIFICATION_STATUSES: readonly VerificationStatus[] = [
  "verified",
  "unverified",
  "failed",
  "blocked",
  "platform-unsupported"
]

export const FAILURE_BASES: readonly FailureBasis[] = ["runtime", "static"]

export const VERIFICATION_METHODS: readonly VerificationMethod[] = [
  "read-only",
  "controlled-write",
  "none"
]

/** A single guard failure, naming the offending tool so a report is actionable. */
export interface VerificationViolation {
  tool: string
  field: string
  message: string
}

export interface ValidationOptions {
  /**
   * Resolve a repository-relative evidence path to an absolute one. Injectable so the
   * mutation test can assert the existence check is not vacuous without editing the real registry.
   */
  resolveEvidencePath?: (entry: VerificationEntry) => string
  /** Tool names the registry is required to cover. Derived from the tool index at validation time. */
  expectedTools?: readonly string[]
}

/**
 * Candidate absolute paths for an entry's evidence, in resolution order. Absolute paths are used
 * as-is; relative ones are tried against every {@link evidenceRoots} entry.
 */
export function evidenceCandidates(entry: VerificationEntry): string[] {
  const evidence = entry.evidence ?? ""
  if (isAbsolute(evidence)) return [evidence]
  return evidenceRoots.map((root) => join(root, evidence))
}

/** The first evidence path that exists on disk, or `undefined` when none of them does. */
export function resolveEvidencePath(entry: VerificationEntry): string | undefined {
  return evidenceCandidates(entry).find((candidate) => existsSync(candidate))
}

/**
 * Check one entry against every guard in the design, returning all violations rather than throwing
 * on the first: a registry is reviewed as a whole, and a caller fixing one fault at a time would
 * otherwise have to re-run the check per fault.
 *
 * `expectedTools`, when supplied, additionally checks the one-entry-per-tool completeness rule.
 */
export function validateEntry(
  entry: VerificationEntry,
  options: ValidationOptions = {}
): VerificationViolation[] {
  const violations: VerificationViolation[] = []
  const fail = (field: string, message: string) =>
    violations.push({ tool: entry.tool, field, message })

  if (!entry.tool) fail("tool", "every entry must name a tool")
  if (options.expectedTools && !options.expectedTools.includes(entry.tool)) {
    fail("tool", `"${entry.tool}" is not in the tool index`)
  }

  if (!AVAILABILITY_BASES.includes(entry.availabilityBasis)) {
    fail("availabilityBasis", `"${entry.availabilityBasis}" is not a known availability basis`)
  }
  if (!VERIFICATION_STATUSES.includes(entry.status)) {
    fail("status", `"${entry.status}" is not a known verification status`)
  }
  if (!VERIFICATION_METHODS.includes(entry.method)) {
    fail("method", `"${entry.method}" is not a known method`)
  }

  // `failureBasis` is meaningful only for `failed`, and `failed` must always say which kind.
  if (entry.status === "failed") {
    if (entry.failureBasis === null) {
      fail("failureBasis", "status failed requires a failureBasis (runtime or static)")
    } else if (!FAILURE_BASES.includes(entry.failureBasis)) {
      fail("failureBasis", `"${entry.failureBasis}" is not a known failure basis`)
    }
  } else if (entry.failureBasis !== null) {
    fail(
      "failureBasis",
      `failureBasis must be null unless status is failed (status is ${entry.status})`
    )
  }

  // The two failure kinds must stay distinguishable. A `runtime` failure is an observation and
  // therefore has a timestamp; a `static` failure was never run and therefore must NOT have one.
  // Collapsing "never ran" into "ran" is precisely the inference-as-observation error.
  if (entry.failureBasis === "runtime" && entry.lastAttemptAt === null) {
    fail(
      "lastAttemptAt",
      "failureBasis runtime means a real call was made, so lastAttemptAt must not be null"
    )
  }
  if (entry.failureBasis === "static" && entry.lastAttemptAt !== null) {
    fail(
      "lastAttemptAt",
      "failureBasis static means the tool was never called, so lastAttemptAt must be null"
    )
  }

  // Evidence must be checkable, not merely present. A path that does not exist is an unverifiable
  // claim, so any *assertion* carries this requirement. `platform-unsupported` is included because
  // "the platform cannot do this" is itself a claim - and one that would otherwise quietly excuse a
  // tool from ever being verified, so it needs proof exactly as much as `verified` does.
  if (
    entry.status === "verified" ||
    entry.status === "failed" ||
    entry.status === "platform-unsupported"
  ) {
    if (entry.evidence === null || entry.evidence.trim() === "") {
      fail("evidence", `status ${entry.status} requires an evidence path`)
    } else {
      const exists = options.resolveEvidencePath
        ? existsSync(options.resolveEvidencePath(entry))
        : resolveEvidencePath(entry) !== undefined
      if (!exists) {
        fail(
          "evidence",
          `evidence file does not exist: ${entry.evidence} (tried ${evidenceCandidates(entry).join(", ")})`
        )
      }
    }
  }

  // An unverified entry asserts nothing: no evidence record may be attached and no attempt time
  // may be claimed, which is what stops "it is not verified" from quietly becoming "it ran at T".
  if (entry.status === "unverified") {
    if (entry.evidence !== null) {
      fail("evidence", "status unverified must carry evidence === null")
    }
    if (entry.lastAttemptAt !== null) {
      fail("lastAttemptAt", "status unverified must carry lastAttemptAt === null")
    }
  }

  // A controlled write cannot be described without naming what it was written to.
  if (entry.method === "controlled-write" && (entry.verificationTarget ?? "").trim() === "") {
    fail("verificationTarget", "method controlled-write requires a verificationTarget")
  }

  return violations
}

/**
 * Validate the whole registry: every entry plus the cross-entry rules that no single entry can
 * check - coverage of the tool index, no unknown tool names, and no duplicates.
 */
export function validateRegistry(
  registry: VerificationRegistry,
  options: ValidationOptions = {}
): VerificationViolation[] {
  const violations: VerificationViolation[] = []
  const seen = new Set<string>()

  for (const entry of registry.entries) {
    if (seen.has(entry.tool)) {
      violations.push({
        tool: entry.tool,
        field: "tool",
        message: `duplicate entry for "${entry.tool}"; each tool must appear exactly once`
      })
    }
    seen.add(entry.tool)
    violations.push(...validateEntry(entry, options))
  }

  if (options.expectedTools) {
    for (const tool of options.expectedTools) {
      if (!seen.has(tool)) {
        violations.push({
          tool,
          field: "tool",
          message: `tool "${tool}" from the tool index has no verification entry`
        })
      }
    }
  }

  return violations
}

export function parseVerificationRegistry(text: string): VerificationRegistry {
  const parsed = JSON.parse(text) as VerificationRegistry
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
    throw new Error("verification registry must be an object with an entries array")
  }
  return parsed
}

export function loadVerificationRegistry(
  path: string = VERIFICATION_REGISTRY_PATH
): VerificationRegistry {
  return parseVerificationRegistry(readFileSync(path, "utf8"))
}

/** Tool names the registry must cover, read from the tool index rather than hardcoded. */
export function toolIndexNames(path?: string): string[] {
  const indexPath = path ?? join(repositoryRoot, "contracts", "tool-index.json")
  const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as { tools: { name: string }[] }
  return parsed.tools.map((tool) => tool.name)
}

export function findVerificationEntry(
  registry: VerificationRegistry,
  tool: string
): VerificationEntry | undefined {
  return registry.entries.find((entry) => entry.tool === tool)
}

/** Status counts, with `failed` split by basis so the two evidence strengths stay separate. */
export interface VerificationTotals {
  verified: number
  unverified: number
  failed: number
  failedRuntime: number
  failedStatic: number
  blocked: number
  platformUnsupported: number
  total: number
}

export function verificationTotals(registry: VerificationRegistry): VerificationTotals {
  const totals: VerificationTotals = {
    verified: 0,
    unverified: 0,
    failed: 0,
    failedRuntime: 0,
    failedStatic: 0,
    blocked: 0,
    platformUnsupported: 0,
    total: registry.entries.length
  }
  for (const entry of registry.entries) {
    switch (entry.status) {
      case "verified":
        totals.verified++
        break
      case "unverified":
        totals.unverified++
        break
      case "failed":
        totals.failed++
        if (entry.failureBasis === "runtime") totals.failedRuntime++
        if (entry.failureBasis === "static") totals.failedStatic++
        break
      case "blocked":
        totals.blocked++
        break
      case "platform-unsupported":
        totals.platformUnsupported++
        break
    }
  }
  return totals
}

/**
 * How many tools are advertised as `available` while nothing has verified them.
 *
 * This number *is* the system's honesty metric and the R-20 regression indicator: it counts the
 * gap between what availability claims and what evidence supports, instead of letting one stand in
 * for the other. A large value is not a failure - the honest normal state is available +
 * unverified - but it should never be presented as if the tools had been verified.
 *
 * `available` is supplied by the caller (the capability report owns that verdict) so this function
 * can never be the place where availability is computed: it only *compares* the two dimensions.
 */
export function availabilityWithoutEvidence(
  available: readonly string[],
  registry: VerificationRegistry
): number {
  return available.filter((tool) => findVerificationEntry(registry, tool)?.status !== "verified")
    .length
}

/**
 * The same metric derived from the registry alone, for callers that have no capability report yet:
 * every entry is treated as available. This is the upper bound on the honesty gap - the number the
 * design wants visible - and it counts `available` + `unverified` as normal rather than as a fault.
 */
export function registryAvailabilityWithoutEvidence(registry: VerificationRegistry): number {
  return registry.entries.filter((entry) => entry.status !== "verified").length
}

/** Entries decided by the helper's protocol version alone: the residual R-20c weakness. */
export function protocolOnlyEntries(registry: VerificationRegistry): VerificationEntry[] {
  return registry.entries.filter((entry) => entry.availabilityBasis === "protocol-only")
}
