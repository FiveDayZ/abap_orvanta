#!/usr/bin/env node
// Read-only audit of the SPRO core delivery surface contract. No SAP tool, credential, service
// start or file write: it only compares the contract against the compiled registry and profile.
import {
  IMG_CONFIGURATION_TOOL_PATTERN,
  classifyImgConfigurationTools,
  deliveryManifestProblems,
  imgConfigurationTools,
  loadSproCoreDelivery,
  unusedWriteChainHelpers
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
// The other family. This line used to be the only place such a tool appeared anywhere in the audit,
// so a delivered tool reaching no acceptance was named and never checked.
const unverifiedOutside = unverified.filter((tool) => !IMG_CONFIGURATION_TOOL_PATTERN.test(tool))
const declaredOutside = (manifest.unverifiedOutsideConfiguration ?? []).map((entry) => entry?.tool)

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
    `configuration tools declared in unverifiedTools, and ${declaredOutside.length} of ` +
    `${unverifiedOutside.length} unverified tools outside that family declared in ` +
    `unverifiedOutsideConfiguration`
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
// The four dispositions the inventory document reports, derived here rather than in an ignored
// scratch probe, so "recomputable from the machine sources" holds for a fresh clone. Which tools
// are blocked, waiting or done is a statement about this repository's progress, never about SAP.
//
// The universe is the DELIVERED surface, not every implemented tool: the document describes what a
// customer receives, and an excluded tool is accounted for by `excludedTools` with its own reason.
// Taking the implemented set instead would make the two accounts disagree the moment anything is
// excluded, which is exactly when the comparison below starts carrying weight.
const classification = classifyImgConfigurationTools({
  tools: delivered,
  registry: registry.entries,
  scenarios: manifest.scenarios ?? []
})
const countOf = (disposition) =>
  classification.filter((entry) => entry.disposition === disposition).length
const unaccepted = classification
  .filter((entry) => entry.disposition === "blocked" || entry.disposition === "sap-acceptance")
  .map((entry) => entry.tool)
console.log(
  `  IMG configuration disposition: local=${countOf("local")} sap=${countOf("sap-acceptance")} ` +
    `blocked=${countOf("blocked")} closed=${countOf("closed")} (of ${classification.length})`
)
// Every class has to hold something. A derivation that quietly collapsed every tool into one
// disposition would still partition the surface, so the sum alone is not evidence of anything.
for (const disposition of ["local", "sap-acceptance", "blocked", "closed"]) {
  if (countOf(disposition) === 0) {
    problems.push(
      `no IMG configuration tool classifies as ${disposition}, so the classification stopped ` +
        `distinguishing the four kinds of work it exists to report`
    )
  }
}
// The unaccepted half of the classification and the surface's own disclosure list describe the same
// set, so they are compared in both directions rather than one.
for (const tool of unaccepted) {
  if (!declared.includes(tool)) {
    problems.push(
      `IMG configuration tool ${tool} classifies as unaccepted but is not declared in ` +
        `unverifiedTools, so the surface implies an acceptance the registry does not support`
    )
  }
}
for (const tool of declared) {
  if (!unaccepted.includes(tool)) {
    problems.push(
      `unverifiedTools declares ${tool}, but the classification does not put it among the tools ` +
        `waiting on acceptance, so the disclosure is stale`
    )
  }
}
const orphanHelpers = unusedWriteChainHelpers({ tools: TOOL_NAMES, registry: registry.entries })
if (orphanHelpers.length > 0) {
  problems.push(
    `write-chain helper ${orphanHelpers.join(", ")} serves no implemented IMG configuration tool, ` +
      `so the tools it used to make blocked would silently read as waiting for acceptance`
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
