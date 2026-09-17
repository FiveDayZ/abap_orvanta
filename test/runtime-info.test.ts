import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RuntimeIdentity } from "../src/runtime-info.js"

test("runtime identity distinguishes candidate version, disk drift and immutable startup observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-runtime-identity-"))
  try {
    const source = join(root, "dist", "src")
    await mkdir(source, { recursive: true })
    await writeFile(join(source, "version.js"), 'export const PRODUCT_VERSION = "1.0.0"')
    await writeFile(join(root, "package.json"), '{"version":"1.0.0"}')
    await writeFile(join(root, "package-lock.json"), "{}")
    const identity = new RuntimeIdentity(source, "1.0.0")
    const first = await identity.report()
    assert.equal(first.status, "observed")
    assert.equal(first.sapStatus, "not_probed")
    const expected = first.startupArtifact.artifactFingerprint!
    assert.equal(
      (await identity.report({ expectedArtifactFingerprint: expected })).checks.expectedArtifact,
      "match"
    )
    assert.equal((await identity.report({ expectedVersion: "2.0.0" })).status, "mismatch")
    assert.equal(
      (await identity.report({ expectedArtifactFingerprint: "0".repeat(64) })).status,
      "mismatch"
    )
    await writeFile(join(source, "version.js"), 'export const PRODUCT_VERSION = "2.0.0"')
    await writeFile(join(root, "package.json"), '{"version":"2.0.0"}')
    const changed = await identity.report()
    assert.equal(changed.startupArtifact.artifactFingerprint, expected)
    assert.equal(changed.checks.diskSinceStartup, "mismatch")
    assert.equal(changed.checks.moduleAndPackageVersion, "mismatch")
    assert.equal(changed.restartRequired, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("missing identity metadata reports unavailable without leaking filesystem errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "orvanta-runtime-missing-"))
  try {
    const result = await new RuntimeIdentity(join(root, "missing")).report()
    assert.equal(result.status, "unavailable")
    assert.equal(result.startupArtifact.status, "unavailable")
    assert.ok(!JSON.stringify(result).includes(root))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
