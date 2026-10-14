import assert from "node:assert/strict"
import test from "node:test"
import {
  type SproCoreDeliveryManifest,
  type SproCoreDeliveryScenario,
  deliveryManifestProblems,
  imgConfigurationTools,
  isImgConfigurationTool,
  loadSproCoreDelivery
} from "../src/spro-core-delivery.js"
import { PROFILE_NAMES, TOOL_NAMES, toolNamesForProfile } from "../src/tool-registry.js"
import { loadVerificationRegistry } from "../src/verification-registry.js"

const profileNames = [...PROFILE_NAMES]
const configProfileTools = toolNamesForProfile("config")
const registryStatus = new Map(
  loadVerificationRegistry().entries.map((entry) => [entry.tool, entry.status])
)
const verifiedTools = [...registryStatus.entries()]
  .filter(([, status]) => status === "verified")
  .map(([tool]) => tool)
const facts = {
  allTools: TOOL_NAMES,
  profileTools: configProfileTools,
  profileNames,
  verifiedTools
}

/** A manifest that passes, so each case below can break exactly one thing. */
const soundManifest = (): SproCoreDeliveryManifest => ({
  format: 1,
  name: "spro-core-m1",
  profile: "config",
  connectionId: "w200",
  system: "GR2",
  client: "200",
  formalServiceAcceptance: "pending",
  requiredTools: [...configProfileTools],
  unverifiedTools: configProfileTools.filter(
    (tool) => isImgConfigurationTool(tool) && registryStatus.get(tool) !== "verified"
  ),
  excludedTools: [],
  scenarios: [],
  boundaries: []
})

/** A scenario that closes a loop the surface can actually run. */
const soundScenario = (): SproCoreDeliveryScenario => ({
  id: "unit-text",
  scope: "Existing T006A language row; MSEHT/MSEHL patch only.",
  flow: ["read_configuration_unit", "preview_configuration_unit_text"],
  recovery: "Reconcile first; an authorized restoration is a new apply with fresh versions.",
  cts: "Explicit open Customizing request and child task."
})

/** The single problem expected from a deliberately broken manifest. */
function onlyProblem(problems: string[]): string {
  assert.equal(problems.length, 1, `expected one problem, received ${JSON.stringify(problems)}`)
  return problems[0] ?? ""
}

function problemMentioning(problems: string[], needle: string): string {
  const hit = problems.find((problem) => problem.includes(needle))
  assert.ok(hit, `no problem mentions ${needle}: ${JSON.stringify(problems)}`)
  return hit ?? ""
}

test("the shipped delivery contract is coherent with the registry and the config profile", () => {
  const manifest = loadSproCoreDelivery()
  assert.deepEqual(deliveryManifestProblems(manifest, facts), [])
  assert.equal(manifest.format, 1)
  assert.equal(manifest.profile, "config")
  assert.equal(new Set(manifest.requiredTools).size, manifest.requiredTools.length)
})

test("the delivered surface covers every IMG configuration tool the config profile enables", () => {
  const manifest = loadSproCoreDelivery()
  const delivered = new Set(manifest.requiredTools)
  const excluded = new Set((manifest.excludedTools ?? []).map((entry) => entry.tool))
  const uncovered = imgConfigurationTools(TOOL_NAMES).filter(
    (tool) => configProfileTools.includes(tool) && !delivered.has(tool) && !excluded.has(tool)
  )
  assert.deepEqual(uncovered, [])
  // The surface is the platform identity/receipt tools plus the whole IMG configuration domain, so
  // a count that silently drops back to a subset has to fail here rather than in a package.
  const imgDelivered = manifest.requiredTools.filter(isImgConfigurationTool)
  const imgEnabled = imgConfigurationTools(configProfileTools)
  assert.deepEqual([...imgDelivered].sort(), [...imgEnabled].sort())
  assert.ok(
    manifest.requiredTools.length > imgDelivered.length,
    "the runtime identity tools must stay on the surface"
  )
})

test("the surface names tools that the registry can back", () => {
  const manifest = loadSproCoreDelivery()
  // Exposure is a capability statement, never an acceptance claim: every tool on the surface has a
  // registry entry, and the audit prints the unverified part of it instead of implying verified.
  const withoutEntry = manifest.requiredTools.filter((tool) => !registryStatus.has(tool))
  assert.deepEqual(withoutEntry, [])
})

test("the shipped contract discloses the unverified part of its own surface", () => {
  const manifest = loadSproCoreDelivery()
  const declared = new Set(manifest.unverifiedTools ?? [])
  // Read straight off the registry, so the disclosure is checked against acceptance and not against
  // the audit that produced it. The earlier hand-written boundary sentence claimed five tools and
  // named four; the registry leaves ten, including both BC write tools.
  const unverified = manifest.requiredTools.filter(
    (tool) => isImgConfigurationTool(tool) && registryStatus.get(tool) !== "verified"
  )
  assert.deepEqual([...declared].sort(), [...unverified].sort())
  assert.ok(unverified.length >= 10, `expected at least 10, read ${unverified.length}`)
  for (const tool of [
    "apply_configuration_bc_set",
    "recover_configuration_bc_set",
    "read_configuration_number_range",
    "read_configuration_bc_effects"
  ]) {
    assert.ok(declared.has(tool), `${tool} must be disclosed as unverified`)
  }
})

test("a delivered tool the registry does not verify has to be declared", () => {
  const manifest = soundManifest()
  const tool = "read_configuration_number_range"
  assert.notEqual(registryStatus.get(tool), "verified")
  manifest.unverifiedTools = manifest.unverifiedTools.filter((name) => name !== tool)
  assert.match(
    onlyProblem(deliveryManifestProblems(manifest, facts)),
    new RegExp(`${tool} is delivered without a registry verification`)
  )
})

test("a declaration the registry verifies is a stale disclosure", () => {
  const manifest = soundManifest()
  const tool = "read_configuration_bc_set"
  assert.equal(registryStatus.get(tool), "verified")
  manifest.unverifiedTools = [...manifest.unverifiedTools, tool]
  assert.match(onlyProblem(deliveryManifestProblems(manifest, facts)), /verifies it/)
})

test("a declaration outside the delivered IMG surface is rejected", () => {
  const notDelivered = soundManifest()
  const undelivered = "read_configuration_number_range"
  notDelivered.requiredTools = notDelivered.requiredTools.filter((name) => name !== undelivered)
  assert.match(
    problemMentioning(
      deliveryManifestProblems(notDelivered, facts),
      `${undelivered}, which this surface does not deliver`
    ),
    /does not deliver/
  )

  const notImg = soundManifest()
  const platformTool = "read_abap_table"
  assert.ok(configProfileTools.includes(platformTool))
  assert.ok(!isImgConfigurationTool(platformTool))
  notImg.unverifiedTools = [...notImg.unverifiedTools, platformTool]
  assert.match(
    problemMentioning(
      deliveryManifestProblems(notImg, facts),
      `${platformTool}, which is not an IMG configuration tool`
    ),
    /not an IMG configuration tool/
  )

  const imaginary = soundManifest()
  imaginary.unverifiedTools = [...imaginary.unverifiedTools, "read_imaginary_configuration"]
  assert.match(
    problemMentioning(
      deliveryManifestProblems(imaginary, facts),
      "read_imaginary_configuration, which no tool registry entry implements"
    ),
    /no tool registry entry implements/
  )

  const duplicated = soundManifest()
  const repeated = duplicated.unverifiedTools[0] ?? ""
  duplicated.unverifiedTools = [...duplicated.unverifiedTools, repeated]
  assert.match(
    problemMentioning(
      deliveryManifestProblems(duplicated, facts),
      `unverifiedTools lists ${repeated} more than once`
    ),
    /more than once/
  )
})

test("a scenario must state its scope, recovery and CTS", () => {
  const sound = soundManifest()
  sound.scenarios = [soundScenario()]
  // Positive control: the fixture scenario passes, so the cases below fail on one field each.
  assert.deepEqual(deliveryManifestProblems(sound, facts), [])

  for (const field of ["scope", "recovery", "cts"] as const) {
    const manifest = soundManifest()
    manifest.scenarios = [{ ...soundScenario(), [field]: "   " }]
    assert.match(
      onlyProblem(deliveryManifestProblems(manifest, facts)),
      new RegExp(`declares no ${field}`)
    )
  }
})

test("a scenario with no id, a duplicate id or an empty flow is rejected", () => {
  const anonymous = soundManifest()
  anonymous.scenarios = [{ ...soundScenario(), id: "  " }]
  assert.match(onlyProblem(deliveryManifestProblems(anonymous, facts)), /entry with no id/)

  const duplicated = soundManifest()
  duplicated.scenarios = [
    soundScenario(),
    { ...soundScenario(), flow: ["read_configuration_unit"] }
  ]
  assert.match(
    onlyProblem(deliveryManifestProblems(duplicated, facts)),
    /id "unit-text" more than once/
  )

  const empty = soundManifest()
  empty.scenarios = [{ ...soundScenario(), flow: [] }]
  assert.match(onlyProblem(deliveryManifestProblems(empty, facts)), /empty flow/)
})

test("a scenario flow may only run tools this surface delivers", () => {
  // The package denies every tool outside requiredTools, so a step the surface excludes is a step
  // the delivered service refuses: the flow would be published and unrunnable at the same time.
  const excludedTool = "read_configuration_bc_logs"
  const manifest = soundManifest()
  manifest.requiredTools = manifest.requiredTools.filter((tool) => tool !== excludedTool)
  manifest.excludedTools = [{ tool: excludedTool, reason: "M3 open" }]
  manifest.scenarios = [{ ...soundScenario(), flow: [excludedTool] }]
  assert.match(
    onlyProblem(deliveryManifestProblems(manifest, facts)),
    /would refuse a step of a flow the contract publishes/
  )

  const imaginary = soundManifest()
  imaginary.scenarios = [{ ...soundScenario(), flow: ["read_imaginary_configuration"] }]
  assert.match(
    onlyProblem(deliveryManifestProblems(imaginary, facts)),
    /no tool registry entry implements/
  )

  const repeated = soundManifest()
  repeated.scenarios = [
    { ...soundScenario(), flow: ["read_configuration_unit", "read_configuration_unit"] }
  ]
  assert.match(onlyProblem(deliveryManifestProblems(repeated, facts)), /twice in its flow/)
})

test("every published scenario runs only tools this surface delivers", () => {
  const manifest = loadSproCoreDelivery()
  const delivered = new Set(manifest.requiredTools)
  assert.ok(manifest.scenarios.length > 0, "the contract must publish at least one closed loop")
  for (const scenario of manifest.scenarios) {
    assert.ok(scenario.flow.length > 0, `${scenario.id} publishes no flow`)
    for (const tool of scenario.flow) {
      assert.ok(
        delivered.has(tool),
        `${scenario.id} runs ${tool}, which the delivered surface does not carry`
      )
    }
    for (const field of ["scope", "recovery", "cts"] as const) {
      assert.ok(scenario[field].trim().length > 0, `${scenario.id} states no ${field}`)
    }
  }
})

test("an IMG configuration tool that is neither delivered nor excluded fails the audit", () => {
  const tool = "read_configuration_bc_logs"
  const manifest = soundManifest()
  manifest.requiredTools = manifest.requiredTools.filter((name) => name !== tool)
  const problem = onlyProblem(deliveryManifestProblems(manifest, facts))
  assert.match(problem, new RegExp(`${tool} is implemented and enabled`))
})

test("excluding an IMG configuration tool requires a written reason", () => {
  const tool = "read_configuration_bc_logs"
  const manifest = soundManifest()
  manifest.requiredTools = manifest.requiredTools.filter((name) => name !== tool)
  manifest.excludedTools = [{ tool, reason: "   " }]
  assert.match(onlyProblem(deliveryManifestProblems(manifest, facts)), /without a reason/)
  manifest.excludedTools = [{ tool, reason: "M3-07 open" }]
  assert.deepEqual(deliveryManifestProblems(manifest, facts), [])
})

test("a tool cannot be both required and excluded", () => {
  const tool = "read_configuration_bc_logs"
  const manifest = soundManifest()
  manifest.excludedTools = [{ tool, reason: "M3-07 open" }]
  assert.match(onlyProblem(deliveryManifestProblems(manifest, facts)), /both required and excluded/)
})

test("duplicate, unknown and profile-excluded tools are each rejected", () => {
  const duplicated = soundManifest()
  duplicated.requiredTools = [...duplicated.requiredTools, "read_configuration_bc_logs"]
  assert.match(onlyProblem(deliveryManifestProblems(duplicated, facts)), /more than once/)

  const unknown = soundManifest()
  const imaginary = "read_imaginary_configuration"
  unknown.requiredTools = [...unknown.requiredTools, imaginary]
  assert.match(
    problemMentioning(deliveryManifestProblems(unknown, facts), imaginary),
    /no tool registry entry implements/
  )

  const devTool = "create_enhancement_hook_implementation"
  assert.ok(TOOL_NAMES.includes(devTool))
  assert.ok(!configProfileTools.includes(devTool))
  const notEnabled = soundManifest()
  notEnabled.requiredTools = [...notEnabled.requiredTools, devTool]
  assert.match(
    problemMentioning(deliveryManifestProblems(notEnabled, facts), devTool),
    /profile "config" does not enable/
  )
})

test("an exclusion of something that is not an IMG configuration tool is rejected", () => {
  const tool = "read_abap_table"
  assert.ok(configProfileTools.includes(tool))
  assert.ok(!isImgConfigurationTool(tool))
  const manifest = soundManifest()
  manifest.requiredTools = manifest.requiredTools.filter((name) => name !== tool)
  manifest.excludedTools = [{ tool, reason: "not part of the IMG surface" }]
  assert.match(
    onlyProblem(deliveryManifestProblems(manifest, facts)),
    /is not an IMG configuration tool/
  )
})

test("an unknown profile and an empty surface are rejected", () => {
  const noProfile = soundManifest()
  noProfile.profile = "img"
  assert.match(
    onlyProblem(deliveryManifestProblems(noProfile, { ...facts, profileNames: [] })),
    /is not one of/
  )

  const empty = soundManifest()
  empty.requiredTools = []
  // A surface that delivers nothing also has nothing to disclose.
  empty.unverifiedTools = []
  // An empty surface is not one mistake but two: nothing is delivered, and every IMG configuration
  // tool the profile enables then has no delivery decision either.
  const emptyProblems = deliveryManifestProblems(empty, facts)
  assert.match(problemMentioning(emptyProblems, "requiredTools is empty"), /requiredTools is empty/)
  assert.equal(emptyProblems.length, 1 + imgConfigurationTools(configProfileTools).length)
})
