#!/usr/bin/env node
// Read-only audit of the SPRO core delivery surface contract. No SAP tool, credential, service
// start or file write: it only compares the contract against the compiled registry and profile.
import {
  IMG_CONFIGURATION_TOOL_PATTERN,
  deliveryManifestProblems,
  imgConfigurationTools,
  loadSproCoreDelivery
} from "../dist/src/spro-core-delivery.js"
import { PROFILE_NAMES, TOOL_NAMES, toolNamesForProfile } from "../dist/src/tool-registry.js"
import { loadVerificationRegistry } from "../dist/src/verification-registry.js"

const manifest = loadSproCoreDelivery()
const profileNames = [...PROFILE_NAMES]
const profileTools =
  typeof manifest.profile === "string" && profileNames.includes(manifest.profile)
    ? toolNamesForProfile(manifest.profile)
    : []
const registry = loadVerificationRegistry()
const statusByTool = new Map(registry.entries.map((entry) => [entry.tool, entry.status]))
const verifiedTools = registry.entries
  .filter((entry) => entry.status === "verified")
  .map((entry) => entry.tool)
// The registry's own read/write split decides the scenario rules, so the audit asks it rather than
// inferring intent from tool names.
const readOnlyTools = registry.entries
  .filter((entry) => entry.method === "read-only")
  .map((entry) => entry.tool)
const writeTools = registry.entries
  .filter((entry) => entry.method === "controlled-write")
  .map((entry) => entry.tool)
const problems = deliveryManifestProblems(manifest, {
  allTools: TOOL_NAMES,
  profileTools,
  profileNames,
  verifiedTools,
  readOnlyTools,
  writeTools
})

const delivered = manifest.requiredTools ?? []
const imgImplemented = imgConfigurationTools(TOOL_NAMES)
const imgDelivered = delivered.filter((tool) => IMG_CONFIGURATION_TOOL_PATTERN.test(tool))
const excluded = manifest.excludedTools ?? []
const unverified = delivered.filter((tool) => statusByTool.get(tool) !== "verified")
const unverifiedImg = unverified.filter((tool) => IMG_CONFIGURATION_TOOL_PATTERN.test(tool))
const declared = manifest.unverifiedTools ?? []

console.log(
  `SPRO core delivery surface: ${delivered.length} tools for profile "${manifest.profile}"`
)
console.log(
  `  IMG configuration: ${imgDelivered.length} delivered, ${excluded.length} excluded, ` +
    `${imgImplemented.length} implemented by the registry`
)
console.log(
  `  unverified on the surface (${unverified.length}): ` +
    (unverified.length > 0 ? unverified.join(", ") : "none")
)
console.log(
  `  acceptance disclosure: ${declared.length} of ${unverifiedImg.length} unverified IMG ` +
    `configuration tools declared in unverifiedTools`
)
// Both arms count as explaining a tool: a reversing step declared in failurePath is documented by
// the scenario even though the happy path never runs it.
const scenarioTools = new Set(
  (manifest.scenarios ?? []).flatMap((scenario) => [
    ...(Array.isArray(scenario?.flow) ? scenario.flow : []),
    ...(Array.isArray(scenario?.failurePath) ? scenario.failurePath : [])
  ])
)
const covered = delivered.filter((tool) => scenarioTools.has(tool))
const supporting = manifest.supportingReads ?? []
const supportingTools = new Set(supporting.map((entry) => entry?.tool))
const uncoveredImg = imgDelivered.filter((tool) => !scenarioTools.has(tool))
console.log(
  `  scenario coverage: ${covered.length} of ${delivered.length} delivered tools appear in a ` +
    `published scenario, and ${supportingTools.size} of the ${uncoveredImg.length} IMG configuration ` +
    `tools outside every scenario are declared in supportingReads`
)
const unexplained = uncoveredImg.filter((tool) => !supportingTools.has(tool))
if (unexplained.length > 0) {
  // Informational: the completeness rule above already fails these; printing them names the work.
  console.log(`  neither in a scenario nor declared: ${unexplained.join(", ")}`)
}
// The two arms of every published loop, so a reader can see which steps run on success and which
// only when the change has to come back.
for (const scenario of manifest.scenarios ?? []) {
  const flow = Array.isArray(scenario?.flow) ? scenario.flow : []
  const writes = flow.filter((tool) => writeTools.includes(tool))
  const failurePath = Array.isArray(scenario?.failurePath) ? scenario.failurePath : []
  console.log(
    `  scenario ${String(scenario?.id)}: ${flow.length} happy-path steps ` +
      `(${writes.join(", ") || "no write"}), failure arm ` +
      `${failurePath.length > 0 ? failurePath.join(", ") : "none"}`
  )
}
for (const problem of problems) {
  console.log(`PROBLEM  ${problem}`)
}
if (problems.length > 0) {
  console.log("")
  console.log(
    `spro-core-delivery.json is not a coherent delivery surface: ${problems.length} problem(s)`
  )
  process.exitCode = 1
} else {
  console.log("OK: the contract covers every IMG configuration tool the profile enables")
}
