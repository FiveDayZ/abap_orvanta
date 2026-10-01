/**
 * Mirror the evidence records the verification registry requires into the repository.
 *
 * Why this exists: `contracts/verification-registry.json` cites its records with the design's
 * literal paths - `.doc/code-update-*.md` and `.logs/mcp-incident-*.md`. `.logs` lives inside this
 * repository, but `.doc` is the workspace-level documentation root that AGENTS.md section 2 makes
 * authoritative for SAP records, so it sits *beside* the repository. `evidenceRoots` therefore
 * resolves those paths against the repository and then its parent, which works in the workspace and
 * cannot work in CI, where the parent is the runner's work directory.
 *
 * Rather than rewrite the registry's historical paths or stop checking them in CI, the cited records
 * are mirrored into `docs/workspace-evidence/` with their literal relative paths preserved, and that
 * directory is an evidence root. The `.doc` originals stay the authoritative copies; this is a
 * snapshot kept only so the evidence-existence guard stays falsifiable in a checkout.
 *
 * Usage:
 *   node scripts/mirror-workspace-evidence.mjs            # audit only, changes nothing
 *   node scripts/mirror-workspace-evidence.mjs --copy     # refresh the mirror
 *   node scripts/mirror-workspace-evidence.mjs --verify   # which candidate roots contain each path
 *
 * Refresh the mirror whenever an entry gains a new evidence record, or CI will reject the citation.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import {
  evidenceRoots,
  loadVerificationRegistry,
  repositoryRoot,
  resolveEvidencePath
} from "../dist/src/verification-registry.js"

// Statuses whose evidence the registry guard requires to exist. `unverified` is the honest default
// and cites nothing, so it is deliberately absent.
const REQUIRED_STATUSES = ["verified", "failed", "platform-unsupported"]
const mirrorRoot = join(repositoryRoot, "docs", "workspace-evidence")

const copy = process.argv.includes("--copy")
const verify = process.argv.includes("--verify")

const registry = loadVerificationRegistry()
const required = registry.entries.filter((entry) => REQUIRED_STATUSES.includes(entry.status))
const paths = [...new Set(required.map((entry) => entry.evidence).filter(Boolean))].sort()

console.log(`repositoryRoot : ${repositoryRoot}`)
console.log(`mirrorRoot     : ${mirrorRoot}`)
console.log(`evidenceRoots  : ${evidenceRoots.join(" | ")}`)
console.log(`entries needing evidence: ${required.length}, distinct paths: ${paths.length}`)
console.log("")

let notResolvable = 0
let copied = 0
let inMirror = 0
let repoInternalOnly = 0

for (const rel of paths) {
  if (verify) {
    const hits = evidenceRoots.filter((root) => existsSync(join(root, rel)))
    console.log(
      `${rel}\n    hits: ${hits.length === 0 ? "(none)" : hits.map((h) => relative(repositoryRoot, h) || ".").join(", ")}`
    )
  }

  const source = resolveEvidencePath({ evidence: rel })
  const target = join(mirrorRoot, rel)
  const mirrored = existsSync(target)
  // A mirror entry that exists but no longer matches its original is worse than a missing one: the
  // existence guard passes either way, so CI would validate whatever text was copied the first time
  // while the workspace holds something else. Records do get revised in place (this batch appended a
  // per-tool evidence section to its own record), so comparing content is what keeps the mirror a
  // snapshot of the original instead of a stale first copy.
  const stale =
    mirrored &&
    source !== undefined &&
    readFileSync(source, "utf8") !== readFileSync(target, "utf8")
  if (mirrored) inMirror += 1
  // A record already inside the repository needs no mirror to survive a checkout.
  if (existsSync(join(repositoryRoot, rel))) repoInternalOnly += 1

  if (!source) {
    notResolvable += 1
    console.log(`NOT RESOLVABLE  ${rel}`)
    continue
  }
  if (!mirrored || stale) {
    if (copy) {
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(source, target)
      copied += 1
      console.log(
        `${stale ? "refreshed" : "copied   "} ${rel}  <- ${relative(repositoryRoot, source)}`
      )
    } else if (!verify) {
      console.log(
        `${stale ? "would refresh" : "would copy"} ${rel}  <- ${relative(repositoryRoot, source)}`
      )
    }
  } else if (!verify) {
    console.log(`present  ${rel}`)
  }
}

console.log("")
console.log(
  `paths ${paths.length} | mirrored ${inMirror} | already inside repository ${repoInternalOnly} | copied ${copied} | not resolvable ${notResolvable}`
)
if (notResolvable > 0) {
  console.log("")
  console.log(
    "A citation whose record cannot be found anywhere is a real defect, not a mirror gap."
  )
  process.exitCode = 1
}
