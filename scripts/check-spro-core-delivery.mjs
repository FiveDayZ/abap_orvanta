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
const problems = deliveryManifestProblems(manifest, {
  allTools: TOOL_NAMES,
  profileTools,
  profileNames
})

const registry = loadVerificationRegistry()
const statusByTool = new Map(registry.entries.map((entry) => [entry.tool, entry.status]))
const delivered = manifest.requiredTools ?? []
const imgImplemented = imgConfigurationTools(TOOL_NAMES)
const imgDelivered = delivered.filter((tool) => IMG_CONFIGURATION_TOOL_PATTERN.test(tool))
const excluded = manifest.excludedTools ?? []
const unverified = delivered.filter((tool) => statusByTool.get(tool) === "unverified")

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
