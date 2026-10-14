import assert from "node:assert/strict"
import test from "node:test"
import {
  type SproCoreDeliveryManifest,
  type SproCoreDeliveryScenario,
  deliveryManifestProblems,
  imgConfigurationTools,
  isCompensatingWrite,
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
const registryMethod = new Map(
  loadVerificationRegistry().entries.map((entry) => [entry.tool, entry.method])
)
const verifiedTools = [...registryStatus.entries()]
  .filter(([, status]) => status === "verified")
  .map(([tool]) => tool)
const readOnlyTools = [...registryMethod.entries()]
  .filter(([, method]) => method === "read-only")
  .map(([tool]) => tool)
const writeTools = [...registryMethod.entries()]
  .filter(([, method]) => method === "controlled-write")
  .map(([tool]) => tool)
const facts = {
  allTools: TOOL_NAMES,
  profileTools: configProfileTools,
  profileNames,
  verifiedTools,
  readOnlyTools,
  writeTools
}

/**
 * The declarations a sound manifest needs: every delivered IMG tool no scenario explains. Derived
 * from the delivered list and both scenario arms rather than hand-written, so a fixture cannot
 * drift out of date.
 */
const supportingReadsFor = (
  delivered: readonly string[],
  scenarios: readonly SproCoreDeliveryScenario[]
) => {
  const explained = new Set(
    scenarios.flatMap((scenario) => [...scenario.flow, ...(scenario.failurePath ?? [])])
  )
  return delivered
    .filter((tool) => isImgConfigurationTool(tool) && !explained.has(tool))
    .map((tool) => ({ tool, reason: "supporting read of no published loop" }))
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
  supportingReads: supportingReadsFor(configProfileTools, []),
  boundaries: []
})

/** A change to the fixture that keeps its documentation declaration consistent with the rest. */
const withSurface = (
  manifest: SproCoreDeliveryManifest,
  changes: Partial<SproCoreDeliveryManifest>
): SproCoreDeliveryManifest => {
  const next = { ...manifest, ...changes }
  return {
    ...next,
    supportingReads: supportingReadsFor(next.requiredTools ?? [], next.scenarios ?? [])
  }
}

/** Drop a tool from the delivered surface, keeping the declaration consistent with it. */
const withoutTool = (manifest: SproCoreDeliveryManifest, tool: string): SproCoreDeliveryManifest =>
  withSurface(manifest, { requiredTools: manifest.requiredTools.filter((name) => name !== tool) })

/**
 * A scenario that closes a loop the surface can actually run: it writes, a read-only step observes
 * the write, and no reversing write sits in the happy path.
 */
const soundScenario = (): SproCoreDeliveryScenario => ({
  id: "unit-text",
  scope: "Existing T006A language row; MSEHT/MSEHL patch only.",
  flow: [
    "read_configuration_unit",
    "preview_configuration_unit_text",
    "apply_configuration_unit_text",
    "get_write_operation_status"
  ],
  failurePath: [],
  recovery: "Reconcile first; an authorized restoration is a new apply with fresh versions.",
  cts: "Explicit open Customizing request and child task."
})

/**
 * A happy path that satisfies the write/observation rules, so a case that means to break something
 * else is not reported twice.
 */
const appliedFlow = (extra: string[] = []): string[] => [
  ...extra,
  "apply_configuration_unit_text",
  "get_write_operation_status"
]

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
  const undelivered = "read_configuration_number_range"
  const notDelivered = withoutTool(soundManifest(), undelivered)
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
  const sound = withSurface(soundManifest(), { scenarios: [soundScenario()] })
  // Positive control: the fixture scenario passes, so the cases below fail on one field each.
  assert.deepEqual(deliveryManifestProblems(sound, facts), [])

  for (const field of ["scope", "recovery", "cts"] as const) {
    const manifest = withSurface(soundManifest(), {
      scenarios: [{ ...soundScenario(), [field]: "   " }]
    })
    assert.match(
      onlyProblem(deliveryManifestProblems(manifest, facts)),
      new RegExp(`declares no ${field}`)
    )
  }
})

test("a scenario with no id, a duplicate id or an empty flow is rejected", () => {
  const anonymous = withSurface(soundManifest(), {
    scenarios: [{ ...soundScenario(), id: "  " }]
  })
  assert.match(onlyProblem(deliveryManifestProblems(anonymous, facts)), /entry with no id/)

  const duplicated = withSurface(soundManifest(), {
    scenarios: [soundScenario(), { ...soundScenario(), flow: appliedFlow() }]
  })
  assert.match(
    onlyProblem(deliveryManifestProblems(duplicated, facts)),
    /id "unit-text" more than once/
  )

  const empty = withSurface(soundManifest(), { scenarios: [{ ...soundScenario(), flow: [] }] })
  assert.match(onlyProblem(deliveryManifestProblems(empty, facts)), /empty flow/)
})

test("a scenario flow may only run tools this surface delivers", () => {
  // The package denies every tool outside requiredTools, so a step the surface excludes is a step
  // the delivered service refuses: the flow would be published and unrunnable at the same time.
  const excludedTool = "read_configuration_bc_logs"
  const manifest = withSurface(withoutTool(soundManifest(), excludedTool), {
    excludedTools: [{ tool: excludedTool, reason: "M3 open" }],
    scenarios: [{ ...soundScenario(), flow: appliedFlow([excludedTool]) }]
  })
  assert.match(
    onlyProblem(deliveryManifestProblems(manifest, facts)),
    /would refuse a step of a flow the contract publishes/
  )

  const imaginary = withSurface(soundManifest(), {
    scenarios: [{ ...soundScenario(), flow: appliedFlow(["read_imaginary_configuration"]) }]
  })
  assert.match(
    onlyProblem(deliveryManifestProblems(imaginary, facts)),
    /no tool registry entry implements/
  )

  const repeated = withSurface(soundManifest(), {
    scenarios: [
      {
        ...soundScenario(),
        flow: [
          "apply_configuration_unit_text",
          "get_write_operation_status",
          "get_write_operation_status"
        ]
      }
    ]
  })
  assert.match(onlyProblem(deliveryManifestProblems(repeated, facts)), /twice in its flow/)
})

test("no published scenario runs the arm that reverses it", () => {
  const manifest = loadSproCoreDelivery()
  for (const scenario of manifest.scenarios) {
    assert.ok(Array.isArray(scenario.failurePath), `${scenario.id} declares no failurePath`)
    const flow = new Set(scenario.flow)
    for (const tool of scenario.flow) {
      assert.ok(
        !isCompensatingWrite(tool),
        `${scenario.id} runs the reversing tool ${tool} in its happy path`
      )
    }
    for (const tool of scenario.failurePath) {
      assert.ok(
        !flow.has(tool),
        `${scenario.id} declares ${tool} in both arms, so neither is the answer`
      )
    }
  }
  // The concrete case that motivated the split: the BC pilot's restore removes the ten rows the
  // apply inserts, so running it as step 12 of the happy path would reverse the loop.
  const bc = manifest.scenarios.find((scenario) => scenario.id === "bc-knm")
  assert.ok(bc, "the contract must publish the bc-knm loop")
  assert.ok(
    !bc.flow.includes("recover_configuration_bc_set"),
    "recover_configuration_bc_set must not be a happy-path step"
  )
  assert.deepEqual(bc.failurePath, ["recover_configuration_bc_set"])
  const declared = new Set((manifest.supportingReads ?? []).map((entry) => entry.tool))
  assert.ok(
    !declared.has("recover_configuration_bc_set"),
    "the scenario explains the reversing tool, so it is not a supporting read"
  )
})

test("a scenario must declare the arm that reverses it, apart from its happy path", () => {
  // A scenario without the field leaves the customer unable to tell whether a failure can be
  // reversed, so the omission is a problem rather than a default.
  const undeclared = withSurface(soundManifest(), {
    scenarios: [
      { ...soundScenario(), failurePath: undefined } as unknown as SproCoreDeliveryScenario
    ]
  })
  assert.match(onlyProblem(deliveryManifestProblems(undeclared, facts)), /declares no failurePath/)

  const repeated = withSurface(soundManifest(), {
    scenarios: [
      {
        ...soundScenario(),
        failurePath: ["recover_configuration_bc_set", "recover_configuration_bc_set"]
      }
    ]
  })
  assert.match(
    onlyProblem(deliveryManifestProblems(repeated, facts)),
    /lists recover_configuration_bc_set twice in its failurePath/
  )

  const imaginary = withSurface(soundManifest(), {
    scenarios: [{ ...soundScenario(), failurePath: ["recover_imaginary_configuration"] }]
  })
  assert.match(
    onlyProblem(deliveryManifestProblems(imaginary, facts)),
    /no tool registry entry implements/
  )

  // Dropping the tool from the surface also leaves it undelivered, which the coverage rule reports
  // separately, so this case looks for its own problem rather than for a single one.
  const notDelivered = withSurface(withoutTool(soundManifest(), "recover_configuration_bc_set"), {
    scenarios: [{ ...soundScenario(), failurePath: ["recover_configuration_bc_set"] }]
  })
  assert.match(
    problemMentioning(
      deliveryManifestProblems(notDelivered, facts),
      "in its failurePath, which this surface does not deliver"
    ),
    /failurePath/
  )

  const both = withSurface(soundManifest(), {
    scenarios: [{ ...soundScenario(), failurePath: ["apply_configuration_unit_text"] }]
  })
  assert.match(
    onlyProblem(deliveryManifestProblems(both, facts)),
    /does not say which arm it belongs to/
  )
})

test("a reversing write in the happy path is rejected", () => {
  const manifest = withSurface(soundManifest(), {
    scenarios: [
      {
        ...soundScenario(),
        flow: appliedFlow(),
        failurePath: ["recover_configuration_bc_set"]
      }
    ]
  })
  assert.deepEqual(deliveryManifestProblems(manifest, facts), [])
  // Positive control: declaring the reversing tool in the failure arm is sound. Putting it back into
  // the happy path is what has to fail, and it fails on that alone.
  const reversed = withSurface(soundManifest(), {
    scenarios: [
      {
        ...soundScenario(),
        flow: ["recover_configuration_bc_set", ...appliedFlow()],
        failurePath: []
      }
    ]
  })
  assert.match(onlyProblem(deliveryManifestProblems(reversed, facts)), /would undo itself/)
})

test("a flow that never writes, or writes without observing, is not a closed loop", () => {
  const readOnly = withSurface(soundManifest(), {
    scenarios: [{ ...soundScenario(), flow: ["read_configuration_unit"], failurePath: [] }]
  })
  assert.match(onlyProblem(deliveryManifestProblems(readOnly, facts)), /never executes a write/)

  const unobserved = withSurface(soundManifest(), {
    scenarios: [{ ...soundScenario(), flow: ["apply_configuration_unit_text"], failurePath: [] }]
  })
  assert.match(
    onlyProblem(deliveryManifestProblems(unobserved, facts)),
    /never observes what the write changed/
  )

  // A write observed only before it happens is not observed at all.
  const before = withSurface(soundManifest(), {
    scenarios: [
      {
        ...soundScenario(),
        flow: ["get_write_operation_status", "apply_configuration_unit_text"],
        failurePath: []
      }
    ]
  })
  assert.match(
    onlyProblem(deliveryManifestProblems(before, facts)),
    /never observes what the write changed/
  )
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

test("the shipped contract accounts for every delivered configuration tool", () => {
  const manifest = loadSproCoreDelivery()
  const flow = new Set(manifest.scenarios.flatMap((scenario) => scenario.flow))
  // Both arms explain a tool: the reversing step of the BC pilot is documented by its scenario even
  // though the happy path never runs it, so it is not also a supporting read.
  const explained = new Set([
    ...flow,
    ...manifest.scenarios.flatMap((scenario) => scenario.failurePath)
  ])
  const declared = new Map(
    (manifest.supportingReads ?? []).map((entry) => [entry.tool, entry.reason])
  )
  // Read off the delivered list and the scenarios, so the coverage number is checked against the
  // contract's own content rather than against the sentence that reports it. 22 of the 45
  // configuration tools are happy-path steps, one more is the BC failure arm, and the remaining 22
  // are documented as supporting reads; before that field existed nobody reading the artifact could
  // tell the difference between the two.
  const inFlow = manifest.requiredTools.filter(
    (tool) => isImgConfigurationTool(tool) && flow.has(tool)
  )
  const inAScenario = manifest.requiredTools.filter(
    (tool) => isImgConfigurationTool(tool) && explained.has(tool)
  )
  const outside = manifest.requiredTools.filter(
    (tool) => isImgConfigurationTool(tool) && !explained.has(tool)
  )
  assert.deepEqual([...declared.keys()].sort(), [...outside].sort())
  assert.equal(inFlow.length, 22, `expected 22 configuration tools in a published happy path`)
  assert.equal(inAScenario.length, 23, `expected 23 configuration tools in a published scenario`)
  assert.equal(outside.length, 22, `expected 22 configuration tools outside every scenario`)
  assert.equal(inAScenario.length + outside.length, 45)
  for (const tool of [
    "read_configuration_bc_logs",
    "search_bte_dispatchers",
    "preview_configuration"
  ]) {
    assert.ok(declared.has(tool), `${tool} must be documented as a supporting read`)
    assert.ok((declared.get(tool) ?? "").trim().length > 20, `${tool} needs a real reason`)
  }
})

test("a delivered configuration tool that no flow explains has to be declared", () => {
  const tool = "read_configuration_bc_logs"
  const manifest = soundManifest()
  manifest.supportingReads = manifest.supportingReads.filter((entry) => entry.tool !== tool)
  assert.match(
    onlyProblem(deliveryManifestProblems(manifest, facts)),
    new RegExp(`${tool} is delivered but appears in no published scenario`)
  )
})

test("declaring a tool a flow already runs, twice, or without a reason is rejected", () => {
  // The flow runs it, so calling it a supporting read would describe it twice. Added after the
  // manifest is otherwise sound, because the fixture derives the list from the flows.
  const tool = "read_configuration_unit"
  const inFlow = withSurface(soundManifest(), { scenarios: [soundScenario()] })
  assert.deepEqual(deliveryManifestProblems(inFlow, facts), [])
  inFlow.supportingReads = [
    ...inFlow.supportingReads,
    { tool, reason: "claims to stand outside every flow while one runs it" }
  ]
  assert.match(
    onlyProblem(deliveryManifestProblems(inFlow, facts)),
    /already runs, so the contract describes it twice/
  )

  const duplicated = soundManifest()
  const repeated = duplicated.supportingReads[0] ?? { tool: "", reason: "" }
  duplicated.supportingReads = [...duplicated.supportingReads, repeated]
  assert.match(
    problemMentioning(deliveryManifestProblems(duplicated, facts), repeated.tool),
    /more than once/
  )

  const noReason = soundManifest()
  const first = noReason.supportingReads[0]
  assert.ok(first)
  noReason.supportingReads = [
    { tool: first.tool, reason: "  " },
    ...noReason.supportingReads.slice(1)
  ]
  assert.match(
    problemMentioning(deliveryManifestProblems(noReason, facts), first.tool),
    /without a reason/
  )
})

test("a supporting read outside the delivered surface or the tool registry is rejected", () => {
  // Deliberately stale: the tool leaves the surface while its declaration stays, which is exactly
  // the drift the field has to catch. Dropping both is the case tested just above.
  const undelivered = "read_configuration_documentation"
  const base = soundManifest()
  const outside: SproCoreDeliveryManifest = {
    ...base,
    requiredTools: base.requiredTools.filter((name) => name !== undelivered)
  }
  assert.match(
    problemMentioning(
      deliveryManifestProblems(outside, facts),
      `${undelivered}, which this surface does not deliver`
    ),
    /does not deliver/
  )

  const imaginary = soundManifest()
  imaginary.supportingReads = [
    ...imaginary.supportingReads,
    { tool: "read_imaginary_configuration", reason: "invented" }
  ]
  assert.match(
    problemMentioning(deliveryManifestProblems(imaginary, facts), "read_imaginary_configuration"),
    /no tool registry entry implements/
  )

  const anonymous = soundManifest()
  anonymous.supportingReads = [...anonymous.supportingReads, { tool: "", reason: "no name" }]
  assert.match(
    onlyProblem(deliveryManifestProblems(anonymous, facts)),
    /supportingReads contains an entry with no tool/
  )
})

test("an IMG configuration tool that is neither delivered nor excluded fails the audit", () => {
  const tool = "read_configuration_bc_logs"
  const manifest = withoutTool(soundManifest(), tool)
  const problem = onlyProblem(deliveryManifestProblems(manifest, facts))
  assert.match(problem, new RegExp(`${tool} is implemented and enabled`))
})

test("excluding an IMG configuration tool requires a written reason", () => {
  const tool = "read_configuration_bc_logs"
  const manifest = withSurface(withoutTool(soundManifest(), tool), {
    excludedTools: [{ tool, reason: "   " }]
  })
  assert.match(onlyProblem(deliveryManifestProblems(manifest, facts)), /without a reason/)
  assert.deepEqual(
    deliveryManifestProblems(
      withSurface(manifest, { excludedTools: [{ tool, reason: "M3-07 open" }] }),
      facts
    ),
    []
  )
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
  const manifest = withSurface(withoutTool(soundManifest(), tool), {
    excludedTools: [{ tool, reason: "not part of the IMG surface" }]
  })
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

  // A surface that delivers nothing also has nothing to disclose or to document.
  const empty = withSurface(soundManifest(), { requiredTools: [], unverifiedTools: [] })
  // An empty surface is not one mistake but two: nothing is delivered, and every IMG configuration
  // tool the profile enables then has no delivery decision either.
  const emptyProblems = deliveryManifestProblems(empty, facts)
  assert.match(problemMentioning(emptyProblems, "requiredTools is empty"), /requiredTools is empty/)
  assert.equal(emptyProblems.length, 1 + imgConfigurationTools(configProfileTools).length)
})
