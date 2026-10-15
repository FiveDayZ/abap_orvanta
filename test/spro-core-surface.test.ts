import assert from "node:assert/strict"
import test from "node:test"
import {
  type SproCoreDeliveryManifest,
  type SproCoreDeliveryScenario,
  BC_WRITE_CHAIN_HELPERS,
  classifyImgConfigurationTools,
  deliveryManifestProblems,
  imgConfigurationTools,
  isCompensatingWrite,
  isImgConfigurationTool,
  loadSproCoreDelivery,
  unusedWriteChainHelpers
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

/**
 * The declarations a sound manifest needs for tools outside the IMG configuration family: every
 * delivered one the registry does not verify. Derived the same way as the family above, so this
 * fixture cannot drift out of date either.
 */
const unverifiedOutsideFor = (delivered: readonly string[]) =>
  delivered
    .filter((tool) => !isImgConfigurationTool(tool) && registryStatus.get(tool) !== "verified")
    .map((tool) => ({ tool, reason: "reads the service's own state and never contacts SAP" }))

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
  unverifiedOutsideConfiguration: unverifiedOutsideFor(configProfileTools),
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
    supportingReads: supportingReadsFor(next.requiredTools ?? [], next.scenarios ?? []),
    unverifiedOutsideConfiguration: unverifiedOutsideFor(next.requiredTools ?? [])
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

test("the contract states the CUNI pilot's size one way, so two sentences cannot disagree", () => {
  // The counts are prose and nothing derives them, so the only machine check available is that the
  // file does not say two different things about the same set. It once said nine tables in the
  // scenario scope and ten in a supportingReads reason.
  const manifest = loadSproCoreDelivery()
  assert.deepEqual(deliveryManifestProblems(manifest, facts), [])
  const disagreeing = structuredClone(manifest)
  const reason = disagreeing.supportingReads.find(
    (entry) => entry.tool === "read_configuration_bc_dependencies"
  )!
  assert.match(reason.reason, /nine-table/, "the fixture needs the sentence that states the count")
  reason.reason = reason.reason.replace("nine-table", "ten-table")
  assert.match(
    onlyProblem(deliveryManifestProblems(disagreeing, facts)),
    /the contract gives the CUNI member tables 2 different counts \(nine-table, ten-table\)/
  )
  // A count that is not a number word is not a count, so ordinary prose cannot trip the rule.
  const prose = structuredClone(manifest)
  prose.supportingReads[0]!.reason = "Read: describes one approved table and one exact row."
  assert.deepEqual(deliveryManifestProblems(prose, facts), [])
})

test("a count written in words no family lists fails instead of shipping unread", () => {
  // The families are a finite list of remembered phrases, so they only compare the counts someone
  // listed. This is the sentence that no family would have looked at.
  const manifest = loadSproCoreDelivery()
  assert.deepEqual(deliveryManifestProblems(manifest, facts), [])
  const unlisted = structuredClone(manifest)
  unlisted.supportingReads[0]!.reason = "Read: returns the pilot's ten records in one pass."
  assert.match(
    onlyProblem(deliveryManifestProblems(unlisted, facts)),
    /counts "ten records" in words no family covers and no idiom declares/
  )
  // Capitalising it does not make it prose either, so a sentence-initial count is still caught.
  const capitalised = structuredClone(manifest)
  capitalised.supportingReads[0]!.reason = "Read: returns Ten entries for the pilot."
  assert.match(
    onlyProblem(deliveryManifestProblems(capitalised, facts)),
    /counts "Ten entries" in words no family covers/
  )
  // A numeral that is not a count of the pilot is allowed because it is declared, and the declaration
  // has to keep matching the text: dropping the phrase makes the exemption itself the problem.
  const stale = structuredClone(manifest)
  const arms = stale.boundaries.findIndex((line) => line.includes("two arms"))
  assert.ok(arms >= 0, "the fixture needs the declared idiom to be present")
  const staleManifest = {
    ...stale,
    boundaries: stale.boundaries.map((line, index) =>
      index === arms ? line.replace("its two arms apart", "each arm") : line
    )
  }
  assert.match(
    onlyProblem(deliveryManifestProblems(staleManifest, facts)),
    /no longer says "two arms", which is declared as counting the scenario arms/
  )
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

test("the shipped contract also discloses the unverified tools outside the configuration family", () => {
  const manifest = loadSproCoreDelivery()
  const declared = (manifest.unverifiedOutsideConfiguration ?? []).map((entry) => entry.tool)
  // Read straight off the registry, like the family above, so this is checked against acceptance and
  // not against the audit that printed it. The audit used to name these tools in a line of output
  // and assert nothing about them, which is how a delivered tool reaches no acceptance unnoticed.
  const unverified = manifest.requiredTools.filter(
    (tool) => !isImgConfigurationTool(tool) && registryStatus.get(tool) !== "verified"
  )
  assert.deepEqual([...declared].sort(), [...unverified].sort())
  assert.ok(unverified.length >= 1, `expected at least 1, read ${unverified.length}`)
  assert.ok(declared.includes("list_write_recovery_operations"))
  for (const tool of declared) {
    assert.ok(!isImgConfigurationTool(tool), `${tool} belongs in unverifiedTools, not here`)
  }
  for (const entry of manifest.unverifiedOutsideConfiguration ?? []) {
    assert.ok(entry.reason.trim().length > 0, `${entry.tool} is disclosed without a reason`)
  }
})

test("a delivered tool outside the configuration family cannot reach no acceptance undisclosed", () => {
  // The premise is measured rather than restated, because this case asserts nothing unless the
  // fixture really does deliver a tool of another family that the registry leaves unverified. The
  // fixture delivers the whole profile, so the three the profile carries all appear here.
  const outside = configProfileTools.filter(
    (tool) => !isImgConfigurationTool(tool) && registryStatus.get(tool) !== "verified"
  )
  assert.deepEqual([...outside].sort(), [
    "get_abap_object_url",
    "list_write_recovery_operations",
    "release_write_operation_lock"
  ])
  // Positive control: the same call has to pass here and fail below, or the assertion has no teeth.
  assert.deepEqual(deliveryManifestProblems(soundManifest(), facts), [])

  const undisclosed = soundManifest()
  undisclosed.unverifiedOutsideConfiguration = []
  const problems = deliveryManifestProblems(undisclosed, facts)
  assert.equal(problems.length, outside.length)
  for (const tool of outside) {
    assert.match(
      problemMentioning(problems, `delivered tool ${tool} is not an IMG configuration tool`),
      /must be declared in unverifiedOutsideConfiguration/
    )
  }
})

test("a non-configuration disclosure that is stale, misplaced or unexplained is rejected", () => {
  const verified = "read_abap_table"
  assert.equal(registryStatus.get(verified), "verified")
  assert.ok(!isImgConfigurationTool(verified))
  const stale = soundManifest()
  stale.unverifiedOutsideConfiguration = [
    ...stale.unverifiedOutsideConfiguration,
    { tool: verified, reason: "left behind after the tool was verified" }
  ]
  assert.match(onlyProblem(deliveryManifestProblems(stale, facts)), /verifies it/)

  // The two families are not interchangeable: an IMG configuration tool declared here would escape
  // the comparison against the classification, which is the only thing that checks that family.
  const misplaced = soundManifest()
  const img = "read_configuration_number_range"
  assert.ok(isImgConfigurationTool(img))
  misplaced.unverifiedOutsideConfiguration = [
    ...misplaced.unverifiedOutsideConfiguration,
    { tool: img, reason: "belongs to the family above" }
  ]
  assert.match(
    onlyProblem(deliveryManifestProblems(misplaced, facts)),
    /belongs in unverifiedTools/
  )

  const undelivered = soundManifest()
  undelivered.requiredTools = undelivered.requiredTools.filter(
    (name) => name !== "list_write_recovery_operations"
  )
  assert.match(onlyProblem(deliveryManifestProblems(undelivered, facts)), /does not deliver/)

  // Blanking one reason, rather than replacing the list, keeps the other declarations intact so this
  // case reports the missing reason and nothing else.
  const unexplained = soundManifest()
  unexplained.unverifiedOutsideConfiguration = unexplained.unverifiedOutsideConfiguration.map(
    (entry) =>
      entry.tool === "list_write_recovery_operations" ? { ...entry, reason: "  " } : entry
  )
  assert.match(onlyProblem(deliveryManifestProblems(unexplained, facts)), /without a reason/)

  const anonymous = soundManifest()
  anonymous.unverifiedOutsideConfiguration = [
    ...anonymous.unverifiedOutsideConfiguration,
    { tool: "", reason: "no tool" }
  ]
  assert.match(onlyProblem(deliveryManifestProblems(anonymous, facts)), /entry with no tool/)
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

test("every IMG configuration tool classifies into exactly one kind of remaining work", () => {
  const manifest = loadSproCoreDelivery()
  const registry = loadVerificationRegistry().entries
  const classification = classifyImgConfigurationTools({
    tools: manifest.requiredTools,
    registry,
    scenarios: manifest.scenarios
  })
  const byDisposition = (disposition: string) =>
    classification.filter((entry) => entry.disposition === disposition).map((entry) => entry.tool)
  const local = byDisposition("local")
  const sap = byDisposition("sap-acceptance")
  const blocked = byDisposition("blocked")
  const closed = byDisposition("closed")

  // The universe is read off the surface the delivery audit itself enforces, not off a hand-written
  // list, and the four classes have to partition it: no tool twice, no tool missing.
  const imgDelivered = manifest.requiredTools.filter(isImgConfigurationTool)
  assert.deepEqual(
    classification.map((entry) => entry.tool).sort(),
    [...imgDelivered].sort(),
    "the classification must cover exactly the delivered IMG configuration tools"
  )
  assert.equal(new Set(classification.map((entry) => entry.tool)).size, classification.length)
  assert.equal(local.length + sap.length + blocked.length + closed.length, imgDelivered.length)

  // Counted facts. They are meant to move when an acceptance run lands, and a rule change that moved
  // a tool between classes has to be seen and written down rather than absorbed silently.
  assert.equal(local.length, 17, "expected 17 locally repairable tools")
  assert.equal(sap.length, 7, "expected 7 tools waiting on SAP acceptance")
  assert.equal(blocked.length, 3, "expected 3 blocked tools")
  assert.equal(closed.length, 18, "expected 18 tools a published scenario runs")

  // Each class has to hold something: a rule that quietly dumped every tool into one disposition
  // would still partition the surface, so the partition alone is not evidence of anything.
  for (const [name, members] of [
    ["local", local],
    ["sap-acceptance", sap],
    ["blocked", blocked],
    ["closed", closed]
  ] as const) {
    assert.ok(
      members.length > 0,
      `no IMG configuration tool classifies as ${name}, so the classes stopped discriminating`
    )
  }

  // The unaccepted half of the classification and the surface's own disclosure list describe the
  // same set, so they are compared in both directions rather than one.
  //
  // While nothing is excluded this is implied by the delivery rules, which already reject an
  // undeclared unverified tool and a declared verified one; it is written down because it becomes
  // load-bearing the moment a tool is excluded. The classification is taken over the delivered
  // surface, so an excluded tool drops out of it while `unverifiedTools` never mentioned it either -
  // but a classification taken over every implemented tool would disagree here, and this is the
  // assertion that would say so.
  assert.deepEqual([...sap, ...blocked].sort(), [...(manifest.unverifiedTools ?? [])].sort())

  // A declared write-chain helper has to belong to a real tool: a rename that emptied the set would
  // otherwise reclassify three blocked tools as work that only needs a run, and nothing would say so.
  assert.deepEqual(unusedWriteChainHelpers({ tools: TOOL_NAMES, registry }), [])
  for (const helper of BC_WRITE_CHAIN_HELPERS) {
    assert.ok(
      registry.some((entry) => entry.helper === helper && isImgConfigurationTool(entry.tool)),
      `${helper} is declared as a write-chain helper but no IMG configuration tool uses it`
    )
  }
})

test("the disposition rule separates a write chain from a helper that merely exists", () => {
  // A constructed specimen, because the shipped surface cannot show the discrimination on its own:
  // the one tool whose disposition the rule gets *differently* from `method` alone is a read-only
  // tool whose only implementation path is an undeployed write-chain helper.
  const scenarios: SproCoreDeliveryScenario[] = [
    {
      id: "specimen",
      scope: "specimen scope",
      flow: ["read_configuration_specimen_closed"],
      failurePath: [],
      recovery: "specimen recovery",
      cts: "specimen cts"
    }
  ]
  const tools = [
    "read_configuration_specimen_closed",
    "read_configuration_specimen_local",
    "read_configuration_specimen_verified_helper",
    "apply_configuration_specimen_write",
    "reconcile_configuration_specimen_write_chain",
    "read_configuration_specimen_waiting",
    "read_configuration_specimen_unknown"
  ]
  const registry = [
    { tool: tools[0]!, status: "verified", method: "read-only", helper: null },
    { tool: tools[1]!, status: "verified", method: "read-only", helper: null },
    // Verified wins over the helper: a write-chain helper on a tool the registry verifies is not
    // evidence that it is blocked, and reading the helper alone would say it was.
    {
      tool: tools[2]!,
      status: "verified",
      method: "read-only",
      helper: "Z_ORVANTA_CFG_BC_APPLY"
    },
    { tool: tools[3]!, status: "unverified", method: "controlled-write", helper: null },
    {
      tool: tools[4]!,
      status: "unverified",
      method: "read-only",
      helper: "Z_ORVANTA_CFG_BC_RECONCILE"
    },
    { tool: tools[5]!, status: "unverified", method: "read-only", helper: null }
    // tools[6] is deliberately absent from the registry: it cannot be verified.
  ]
  const disposition = new Map(
    classifyImgConfigurationTools({ tools, registry, scenarios }).map((entry) => [
      entry.tool,
      entry.disposition
    ])
  )
  assert.equal(disposition.get(tools[0]!), "closed", "a verified tool in a scenario is closed")
  assert.equal(
    disposition.get(tools[1]!),
    "local",
    "a verified tool outside every scenario is local"
  )
  assert.equal(
    disposition.get(tools[2]!),
    "local",
    "verification has to win over the helper, or a verified tool reads as blocked"
  )
  assert.equal(
    disposition.get(tools[3]!),
    "blocked",
    "an unverified controlled write is blocked whatever its helper"
  )
  // This is the case the rule exists for: `method` is read-only, so a rule that classified by
  // `method` alone would report it as waiting for acceptance rather than blocked.
  assert.equal(
    disposition.get(tools[4]!),
    "blocked",
    "an unverified read-only tool on a write-chain helper is blocked, not waiting"
  )
  assert.equal(
    disposition.get(tools[5]!),
    "sap-acceptance",
    "an unverified tool with no write-chain helper is waiting for acceptance"
  )
  assert.equal(
    disposition.get(tools[6]!),
    "sap-acceptance",
    "a tool the registry does not have cannot be verified, so it cannot be closed"
  )
  // The specimen proves the rule discriminates, so it is not a set of assertions that would pass
  // against any implementation that returned one disposition for everything.
  assert.equal(
    new Set(disposition.values()).size,
    4,
    "the specimen must reach all four dispositions"
  )
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
