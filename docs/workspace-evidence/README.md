# Workspace evidence mirror

This directory is a **snapshot**, not a source of truth.

`contracts/verification-registry.json` cites the record behind every `verified`, `failed` and
`platform-unsupported` entry using the design's literal paths — `.doc/code-update-*.md`,
`.doc/*.json` and `.logs/mcp-incident-*.md`. `.logs` lives inside this repository. `.doc` does not:
it is the workspace-level documentation root that `AGENTS.md` section 2 makes authoritative for SAP
records, so it sits *beside* the repository.

`evidenceRoots` in `src/verification-registry.ts` resolves those paths against the repository, then
the workspace beside it, and then this directory. In the workspace the first two roots find every
record. In CI there is no workspace beside the checkout, so without this mirror a `.doc/...`
citation has no candidate at all — and the evidence-existence guard, which exists to keep the
verdicts falsifiable, could only have been kept green by weakening it.

So the cited records are mirrored here **with their literal relative paths preserved**, which is why
you see `.doc/` inside this directory. The registry is not rewritten and the guard is not disabled.

## Refreshing

```
npm run build
node scripts/mirror-workspace-evidence.mjs           # audit: what is cited, what would be copied
node scripts/mirror-workspace-evidence.mjs --copy    # copy anything not yet mirrored
node scripts/mirror-workspace-evidence.mjs --verify  # which candidate roots contain each path
```

Refresh it in the same batch as any registry change that cites a record not yet mirrored.
`--verify` is the check that matters: a path whose only hit is outside the repository will pass
locally and fail in CI.

## What must not happen here

- **Do not edit a mirrored record.** Fix the `.doc` original and re-run `--copy`; a hand-edited
  snapshot would disagree with the record the entry actually cites.
- **Do not add a citation that resolves only to this directory.** The mirror follows the registry,
  it does not justify it — an entry whose evidence exists nowhere but here has not been verified.
- The `.doc` originals remain authoritative. Nothing in this directory may be treated as the
  canonical SAP development record.
