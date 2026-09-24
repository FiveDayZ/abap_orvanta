import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import type { SapHelperCapabilities } from "../src/backend.js"
import { helperCapability, resolveHelperCapabilityRoute } from "../src/capabilities.js"
import { HELPER_CARRIER_PROGRAMS, helperDeploymentRemedy } from "../src/helper-carriers.js"
import { repositoryRoot } from "../src/verification-registry.js"

const DDIC_HELPER = "Z_ORVANTA_MCP_DDIC_API"

test("every recorded carrier program is the one its generator writes", () => {
  const generator = readFileSync(
    join(repositoryRoot, "scripts", "generate-ddic-lock-carrier.mjs"),
    "utf8"
  )
  const declared = /const PROGRAM = "([A-Z0-9_]+)"/.exec(generator)
  assert.ok(declared, "generate-ddic-lock-carrier.mjs must declare its PROGRAM")
  assert.equal(
    HELPER_CARRIER_PROGRAMS[DDIC_HELPER],
    declared[1],
    "a renamed carrier would otherwise be named in a remedy nobody can run"
  )
})

test("every repository carrier program is the one its generator writes", () => {
  const generator = readFileSync(
    join(repositoryRoot, "scripts", "generate-repository-carrier.mjs"),
    "utf8"
  )
  const targets = [
    ...generator.matchAll(/(Z_ORVANTA_MCP_[A-Z_]+):\s*\{\s*program:\s*"([A-Z0-9_]+)"/g)
  ]
  assert.ok(targets.length > 0, "generate-repository-carrier.mjs must declare its TARGETS")
  for (const match of targets) {
    const helper = match[1]
    const program = match[2]
    assert.ok(helper && program, "a carrier target must name both a helper and a program")
    assert.equal(
      HELPER_CARRIER_PROGRAMS[helper],
      program,
      `the remedy for ${helper} would name a carrier nobody can run`
    )
    // ABAP program names are capped at 30 characters, so a carrier that exceeded it could not be
    // created in SE38 at all - the remedy would send the operator to a nonexistent program.
    assert.ok(program.length <= 30, `carrier program name too long for SE38: ${program}`)
  }
  // The shared repository body still needs one carrier per function module: two entries, not one.
  assert.equal(targets.length, 2, "both repository helpers must have their own carrier")
})

test("a repository version shortfall names the repository carrier, not the DDIC one", () => {
  const remedy = helperDeploymentRemedy("Z_ORVANTA_MCP_EXECUTE", "2.8")
  assert.match(remedy, /ZORVANTA_MCP_EXEC_DEPLOY/)
  assert.match(remedy, /SE38/)
  assert.doesNotMatch(remedy, /ZORVANTA_MCP_DDIC_LOCK_DEPLOY/)
})

test("the remedy names the SAP-side step and states what does not work", () => {
  const remedy = helperDeploymentRemedy(DDIC_HELPER, "1.14")
  assert.match(remedy, /ZORVANTA_MCP_DDIC_LOCK_DEPLOY/)
  assert.match(remedy, /SE38/)
  assert.match(remedy, /1\.14/)
  // The mistake this exists to prevent: rebuilding the service and expecting SAP to change.
  assert.match(remedy, /cannot change the SAP-side helper protocol/)
})

test("a helper with no generated carrier gets no invented program name", () => {
  const remedy = helperDeploymentRemedy("Z_ORVANTA_MCP_UNKNOWN_API", "9.9")
  assert.doesNotMatch(remedy, /ZORVANTA_MCP_DDIC_LOCK_DEPLOY/)
  assert.match(remedy, /docs\/release-process\.md section 7/)
  assert.match(remedy, /9\.9/)
})

test("a version gap verdict carries the remedy, not only the shortfall", () => {
  const route = resolveHelperCapabilityRoute("ddic-helper-table-activation-resume", [
    "resume_ddic_table_activation"
  ])
  assert.equal(route.helper, DDIC_HELPER)
  const spec = helperCapability(route, {
    availability: "available",
    reason: "probe ok",
    evidence: { source: "read-probe", detail: "READY; protocol 1.12" },
    name: "ddic",
    protocolVersion: "1.12",
    attestation: {
      attestation: "self-described",
      helper: DDIC_HELPER,
      minProtocol: "1.2",
      maxProtocol: "1.12",
      operations: [],
      scopes: [],
      sourceHash: null,
      packageName: null,
      transport: null,
      host: null,
      observedAt: "2026-09-23T17:09:29+08:00"
    } satisfies SapHelperCapabilities
  })
  assert.equal(spec.observation.availability, "unsupported")
  assert.match(spec.observation.reason, /below the required capability version 1\.14/)
  assert.match(spec.observation.remedy ?? "", /ZORVANTA_MCP_DDIC_LOCK_DEPLOY/)
  assert.match(spec.observation.remedy ?? "", /cannot change the SAP-side helper protocol/)
})
