import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { stageReleaseEvidence } from "../scripts/stage-release-evidence.mjs"

function fixture(reference = ".doc/observed.json", includeEvidence = true) {
  const root = mkdtempSync(join(tmpdir(), "orvanta-package-evidence-"))
  const source = join(root, "project")
  const output = join(root, "app")
  mkdirSync(join(source, "contracts"), { recursive: true })
  const registry = {
    entries: [
      { tool: "observed", status: "verified", evidence: reference },
      { tool: "pending", status: "unverified", evidence: null },
      { tool: "failed", status: "failed", evidence: reference }
    ]
  }
  writeFileSync(join(source, "contracts", "verification-registry.json"), JSON.stringify(registry))
  writeFileSync(
    join(source, "contracts", "tool-index.json"),
    JSON.stringify({ tools: registry.entries.map(({ tool }) => ({ name: tool })) })
  )
  if (includeEvidence) {
    const path = join(root, reference)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ result: "observed", retainedFailure: true }))
  }
  return { source, output, registry }
}

test("release evidence preserves original statuses and hashes only referenced records", () => {
  const { source, output, registry } = fixture()
  mkdirSync(join(source, "docs", "workspace-evidence", ".doc"), { recursive: true })
  writeFileSync(join(source, "docs", "workspace-evidence", ".doc", "unrelated.json"), "excluded")
  const manifest = stageReleaseEvidence(source, output)
  assert.equal(manifest.entryCount, 3)
  assert.equal(manifest.evidenceCount, 1)
  assert.deepEqual(
    JSON.parse(readFileSync(join(output, "contracts", "verification-registry.json"), "utf8")),
    registry
  )
  assert.equal(
    existsSync(join(output, "docs", "workspace-evidence", ".doc", "unrelated.json")),
    false
  )
  for (const file of manifest.files) {
    const bytes = readFileSync(join(output, file.path))
    assert.equal(bytes.length, file.size)
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256)
  }
  assert.throws(() => stageReleaseEvidence(source, output), /refusing to overwrite/)
})

test("missing or escaping evidence refuses staging before output is created", () => {
  for (const [reference, pattern] of [
    [".doc/observed.json", /evidence is missing/],
    ["../outside.json", /inside an evidence directory/],
    [".doc/../connections.json", /inside an evidence directory/],
    ["connections.json", /inside an evidence directory/]
  ]) {
    const { source, output } = fixture(reference, false)
    assert.throws(() => stageReleaseEvidence(source, output), pattern)
    assert.equal(existsSync(output), false)
  }
})

test("release evidence includes explicitly cited cache receipts without copying the cache", () => {
  const reference = ".cache/runtime-regression/observed.json"
  const { source, output } = fixture(reference)
  mkdirSync(join(source, ".cache", "private"), { recursive: true })
  writeFileSync(join(source, ".cache", "private", "connections.json"), "not-cited")
  const manifest = stageReleaseEvidence(source, output)
  assert.equal(manifest.evidenceCount, 1)
  assert.equal(existsSync(join(output, "docs", "workspace-evidence", reference)), true)
  assert.equal(existsSync(join(output, "docs", "workspace-evidence", ".cache", "private")), false)
})

test("mismatched registry and tool index refuses staging before output is created", () => {
  const { source, output } = fixture()
  writeFileSync(join(source, "contracts", "tool-index.json"), JSON.stringify({ tools: [] }))
  assert.throws(() => stageReleaseEvidence(source, output), /same tools/)
  assert.equal(existsSync(output), false)
})
