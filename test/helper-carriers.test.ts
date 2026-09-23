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

test("the remedy names the SAP-side step and states what does not work", () => {
  const remedy = helperDeploymentRemedy(DDIC_HELPER, "1.13")
  assert.match(remedy, /ZORVANTA_MCP_DDIC_LOCK_DEPLOY/)
  assert.match(remedy, /SE38/)
  assert.match(remedy, /1\.13/)
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
  assert.match(spec.observation.reason, /below the required capability version 1\.13/)
  assert.match(spec.observation.remedy ?? "", /ZORVANTA_MCP_DDIC_LOCK_DEPLOY/)
  assert.match(spec.observation.remedy ?? "", /cannot change the SAP-side helper protocol/)
})
