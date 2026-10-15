/**
 * SPRO core delivery surface: the contract deciding which tools a delivered configuration service
 * exposes, plus the audit that keeps the contract and the implementation from drifting apart.
 *
 * `scripts/package-spro-core.mjs` turns `requiredTools` into `ABAP_MCP_TOOL_DENY` - every tool the
 * manifest does not name is denied - and `scripts/check-spro-core.mjs` compares the running surface
 * against the same list. The manifest, not the `config` profile, is therefore what a customer
 * receives, and nothing in `npm run verify` used to read it.
 *
 * The cost of that blind spot showed up on 2026-10-14: the server implemented 45 IMG configuration
 * tools, the manifest named 27 of them, and of the 18 omitted ones 13 were already `verified` in
 * `contracts/verification-registry.json` and all 18 were enabled by the `config` profile. The
 * capability existed, had been observed to work, and still never reached a delivered service - a
 * gap invisible in every profile, index and registry readout because it lived in neither.
 *
 * The rules below are deliberately one-sided. They fail a manifest that under-delivers, contradicts
 * itself or names something that does not exist, and they never create capability. Being on the
 * surface is not a claim of SAP acceptance: that stays per tool in the verification registry, so
 * the audit reports the unverified part of the surface instead of hiding it.
 *
 * That last point used to be prose only, and on 2026-10-15 the prose was wrong: `boundaries` claimed
 * five configuration tools were unverified and named four, while the registry left ten unverified -
 * including both BC write tools - and the file is copied into a candidate as `SPRO-CORE.json`. A
 * hand-written count had drifted from the registry with nothing able to notice. The surface now
 * declares the unaccepted part of itself in `unverifiedTools`, and this audit compares that
 * declaration with the registry in both directions: an undeclared gap is hidden acceptance, a
 * declared tool the registry verifies is a stale disclosure.
 *
 * `scenarios` had the same shape of hole one layer further out: the three published flows are the
 * only closed loops this surface promises, they ship inside the candidate, and every tool they name
 * outside `requiredTools` is denied by that very candidate. Nothing read the field, so an unusable
 * step, a duplicate flow or an unstated recovery would have reached the customer unremarked. The
 * audit now requires each scenario to state its scope, recovery and CTS, to have a unique non-empty
 * id and a non-empty flow, and to run only tools this surface delivers.
 *
 * Validating those flows produced a number worth acting on: 23 of the 45 delivered configuration
 * tools appear in a published flow, so 22 were delivered, several of them `verified`, and explained
 * by nothing in the artifact - a documentation gap, not a capability gap, but one no reader could
 * distinguish from an oversight. `supportingReads` now names each of them with the role it plays,
 * and the audit holds the classification complete in both directions: every delivered configuration
 * tool is either in a published flow or declared here, and a declared tool that later joins a flow
 * has to leave the list.
 *
 * Checking the flows against the tools' own descriptions found the next hole, and it was not a
 * wording problem. `bc-knm` - the one published loop that runs a write - ended its flow with
 * `recover_configuration_bc_set`, whose own description says it removes the ten rows the apply
 * inserts. Read literally, that loop applies the pilot and then removes what it applied, while the
 * same scenario's `recovery` text calls the restore a separate durable phase. A flat list of tool
 * names cannot say which arm a step belongs to, so the contract now declares the two arms apart:
 * `flow` is the happy path the customer runs, `failurePath` carries the reversing tools, and the
 * audit rejects a reversing write in `flow`, a tool declared in both arms, and a flow that writes
 * without a read-only step observing the result.
 *
 * The inventory document that reports which configuration tools are locally repairable, which wait
 * on SAP acceptance and which are blocked derived those four classes from a probe kept in an ignored
 * scratch directory. The numbers were right and the rules were written down, but "recomputable from
 * the machine sources below" was true on one machine only: a fresh clone could not reproduce them.
 * `classifyImgConfigurationTools` is that derivation as shipped code. The audit prints the four
 * classes and fails when they stop partitioning the IMG surface, when they stop agreeing with
 * `unverifiedTools`, or when a declared write-chain helper no longer belongs to any tool - and the
 * helpers that make a tool *blocked* are declared here instead of described in prose.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { repositoryRoot } from "./verification-registry.js"

/** The delivery contract shipped with a packaged SPRO core service as `SPRO-CORE.json`. */
export const SPRO_CORE_DELIVERY_PATH = join(repositoryRoot, "contracts", "spro-core-delivery.json")

/**
 * Naming convention marking a tool as part of the IMG/SPRO configuration surface: the
 * `*_configuration_*` verbs plus the BTE readers whose domain sits in the middle of the name.
 *
 * This is the *only* definition of the domain, and it is deliberately independent of the contract
 * file: a rule that took both sides from `requiredTools` could never notice a missing tool.
 */
export const IMG_CONFIGURATION_TOOL_PATTERN =
  /(?:^|_)configuration(?:_|$)|^read_bte_configuration$|^search_bte_dispatchers$/

export function isImgConfigurationTool(name: string): boolean {
  return IMG_CONFIGURATION_TOOL_PATTERN.test(name)
}

export function imgConfigurationTools(allTools: readonly string[]): string[] {
  return allTools.filter(isImgConfigurationTool)
}

/**
 * The helpers that implement the BC write pilot: apply, recover, and the read-only reconcile that
 * attests the same receipt. None of them was ever deployed to a SAP system, which is what makes the
 * three tools they serve *blocked* rather than merely unaccepted.
 *
 * That difference is invisible in `status` and `method` alone: `reconcile_configuration_bc_execution`
 * is `read-only` while its only implementation path is one of these helpers, so classifying by
 * `method` would file it under "waiting for acceptance". The list is declared here rather than left
 * as prose so it can be checked - every name below has to be the helper of a delivered IMG
 * configuration tool, and a rename that emptied it would otherwise silently reclassify three blocked
 * tools as work that only needs a run.
 */
export const BC_WRITE_CHAIN_HELPERS = [
  "Z_ORVANTA_CFG_BC_APPLY",
  "Z_ORVANTA_CFG_BC_RECOVER",
  "Z_ORVANTA_CFG_BC_RECONCILE"
] as const

/**
 * Where the work on one delivered IMG configuration tool actually stands. This is a statement about
 * this repository's own progress and never about SAP acceptance:
 *
 * - `blocked` - the registry does not verify it and the helper it needs was never deployed;
 * - `sap-acceptance` - the registry does not verify it, but nothing says it cannot be run;
 * - `local` - verified, and no published scenario explains it;
 * - `closed` - verified, and a published scenario runs it in one of its two arms.
 */
export type ImgConfigurationDisposition = "blocked" | "sap-acceptance" | "local" | "closed"

export interface ImgConfigurationClassification {
  tool: string
  disposition: ImgConfigurationDisposition
}

/**
 * The registry facts the classification reads, taken structurally rather than imported so a
 * constructed specimen can drive the rule. Every field is optional except the tool name: an entry
 * the registry does not have cannot be verified, which is exactly how the audit treats it.
 */
export interface ImgConfigurationRegistryEntry {
  tool: string
  status?: string
  method?: string
  helper?: string | null
}

export interface ImgConfigurationClassificationInput {
  tools: readonly string[]
  registry: readonly ImgConfigurationRegistryEntry[]
  scenarios: readonly SproCoreDeliveryScenario[]
}

/**
 * Both arms explain a tool: a reversing step declared in `failurePath` is documented by its scenario
 * even though the happy path never runs it.
 */
export function documentedByScenario(scenarios: readonly SproCoreDeliveryScenario[]): Set<string> {
  return new Set(
    scenarios.flatMap((scenario) => [
      ...(Array.isArray(scenario?.flow) ? scenario.flow : []),
      ...(Array.isArray(scenario?.failurePath) ? scenario.failurePath : [])
    ])
  )
}

/**
 * Classify every implemented IMG configuration tool into exactly one disposition. The four classes
 * are mutually exclusive and exhaustive by construction, and the audit checks that they stay so
 * against the surface it actually delivers.
 */
export function classifyImgConfigurationTools(
  input: ImgConfigurationClassificationInput
): ImgConfigurationClassification[] {
  const entries = new Map(input.registry.map((entry) => [entry.tool, entry]))
  const documented = documentedByScenario(input.scenarios)
  const blockedHelpers = new Set<string>(BC_WRITE_CHAIN_HELPERS)
  return imgConfigurationTools(input.tools).map((tool) => {
    const entry = entries.get(tool)
    if (entry?.status === "verified") {
      return { tool, disposition: documented.has(tool) ? "closed" : "local" }
    }
    const blocked =
      entry?.method === "controlled-write" ||
      (typeof entry?.helper === "string" && blockedHelpers.has(entry.helper))
    return { tool, disposition: blocked ? "blocked" : "sap-acceptance" }
  })
}

/** The declared write-chain helpers that no implemented IMG configuration tool actually uses. */
export function unusedWriteChainHelpers(
  input: Pick<ImgConfigurationClassificationInput, "tools" | "registry">
): string[] {
  const used = new Set(
    input.registry
      .filter((entry) => isImgConfigurationTool(entry.tool))
      .map((entry) => (typeof entry.helper === "string" ? entry.helper : ""))
  )
  return BC_WRITE_CHAIN_HELPERS.filter((helper) => !used.has(helper))
}

/**
 * An implemented IMG configuration tool left out of the surface, with the reason it is left out.
 * Every omission has to be written down; silence is what this audit exists to remove.
 */
export interface SproCoreDeliveryExclusion {
  tool: string
  reason: string
}

/**
 * One delivered business closed loop: what it may touch (`scope`), the tool order that closes it
 * (`flow`), the arm that reverses it (`failurePath`), how it is undone (`recovery`) and what it
 * records in CTS (`cts`). A scenario is a promise the candidate has to be able to keep, so `flow`
 * may only name tools this surface delivers; the packaged service denies every tool the contract
 * leaves out.
 */
export interface SproCoreDeliveryScenario {
  id: string
  scope: string
  /**
   * The happy path, in order: the steps a caller runs when everything works. It never contains the
   * arm that reverses the change, because a published loop that undoes itself is worse than no loop.
   */
  flow: string[]
  /**
   * The tools that reverse this loop: run only when the change has to be undone or its outcome is
   * unknown. An empty list is a statement too — it says this loop has no rollback and a failed
   * change has to be handled by hand — so the field is declared rather than omitted.
   */
  failurePath: string[]
  recovery: string
  cts: string
}

/**
 * A write that reverses a change another tool made. Publishing one as a happy-path step would hand
 * the customer a flow that reverses itself, so the audit keeps them in the failure arm. The
 * vocabulary is name-based and therefore deliberately small: a new reversing tool has to be added
 * here, and the test that proves the rule fails until it is.
 */
const COMPENSATING_WRITE_PATTERN = /^(recover|undo|rollback|revert)_/

export function isCompensatingWrite(name: string): boolean {
  return COMPENSATING_WRITE_PATTERN.test(name)
}

/**
 * A delivered tool that no published scenario runs, with the reason it stands outside every flow.
 * Declaring it is the difference between "this surface documents 23 closed loops and says what the
 * other tools are for" and "22 tools are silently absent from everything the contract explains".
 *
 * The name is a requirement, not a label: the audit rejects an entry whose tool the registry
 * classifies as a write. Without that check this list is where a delivered write capability hides
 * from the scenario rules, which are the only thing that states a write's scope, recovery and CTS -
 * and the coverage loop below would *force* it to hide there, because a tool outside every scenario
 * has nowhere else to be declared. Like an exclusion, it is a statement about this contract, never
 * about SAP acceptance.
 */
export interface SproCoreDeliverySupportingRead {
  tool: string
  reason: string
}

/**
 * A delivered tool outside the IMG configuration family that the registry does not verify, with the
 * reason it is not. `unverifiedTools` is that family's disclosure and is compared against the
 * classification, so a tool of any other family has nowhere else to be accounted for: the audit used
 * to name it in a printed line, and a fact that is only printed is not a fact that is checked. Being
 * declared here is not a second kind of acceptance either - it is the disclosure of its absence.
 */
export interface SproCoreDeliveryUnverifiedDisclosure {
  tool: string
  reason: string
}

export interface SproCoreDeliveryManifest {
  format: number
  name: string
  profile: string
  connectionId: string
  system: string
  client: string
  formalServiceAcceptance: string
  requiredTools: string[]
  /**
   * The delivered IMG configuration tools whose registry status is not `verified`, written down so
   * a candidate that ships this file cannot imply more acceptance than the registry supports.
   * Being declared here is not a second kind of acceptance: it is the disclosure of its absence.
   */
  unverifiedTools: string[]
  /**
   * The delivered tools outside the IMG configuration family whose registry status is not `verified`.
   * The family above cannot describe them, so without this list a delivered tool that reaches no
   * acceptance would be printed by the audit and asserted nowhere.
   */
  unverifiedOutsideConfiguration: SproCoreDeliveryUnverifiedDisclosure[]
  excludedTools: SproCoreDeliveryExclusion[]
  scenarios: readonly SproCoreDeliveryScenario[]
  /**
   * Every delivered IMG configuration tool that appears in no scenario flow, with the role it plays
   * instead. The scenarios publish the closed loops; this list accounts for the rest, so no
   * delivered configuration tool is left unexplained by the artifact the customer receives.
   */
  supportingReads: SproCoreDeliverySupportingRead[]
  boundaries: readonly string[]
}

/** The audit reads an untrusted file, so every field stays optional while it is validated. */
export type SproCoreDeliveryCandidate = Partial<SproCoreDeliveryManifest>

export function parseSproCoreDelivery(text: string): SproCoreDeliveryManifest {
  return JSON.parse(text) as SproCoreDeliveryManifest
}

export function loadSproCoreDelivery(
  path: string = SPRO_CORE_DELIVERY_PATH
): SproCoreDeliveryManifest {
  return parseSproCoreDelivery(readFileSync(path, "utf8"))
}

/** What the running build knows: the tools that exist and the tools the declared profile enables. */
export interface DeliverySurfaceFacts {
  allTools: readonly string[]
  profileTools: readonly string[]
  profileNames: readonly string[]
  /**
   * The tools `contracts/verification-registry.json` reports as `verified`. The registry decides
   * acceptance; the manifest may only disclose it, never widen it, so nothing here comes back from
   * the manifest itself.
   */
  verifiedTools: readonly string[]
  /**
   * The registry's own read/write classification, so the scenario rules can ask "is this step a
   * write, and does a read-only step observe it" without parsing tool names.
   */
  readOnlyTools: readonly string[]
  writeTools: readonly string[]
}

const SCOPE_COUNT_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20
}
/**
 * The counts the contract states in words, each with the phrase that identifies it. A word that is
 * not a number ("one exact rule") is skipped, so only real counts take part.
 */
const SCOPE_COUNT_FAMILIES: readonly { readonly describes: string; readonly pattern: RegExp }[] = [
  { describes: "the CUNI member tables", pattern: /([a-z]+)-table\b/g },
  { describes: "the CUNI fixed keys", pattern: /([a-z]+)-key\b/g },
  { describes: "the candidate rows", pattern: /([a-z]+) candidate rows\b/g },
  { describes: "the protected keys", pattern: /([a-z]+) protected keys\b/g },
  { describes: "the inserted rows", pattern: /([a-z]+) rows\b/g }
]

/**
 * Numerals the contract uses as plain English rather than as a count of the pilot. They cannot be told
 * from a count by shape - "one approved table" and "one record" are the same shape - so each is
 * declared with why it is not one, and any numeral that is neither inside a family nor one of these
 * fails the audit instead of being read as prose.
 */
const SCOPE_COUNT_IDIOMS: readonly { readonly phrase: string; readonly reason: string }[] = [
  { phrase: "two instances", reason: "counting comparison operands rather than the pilot" },
  { phrase: "two arms", reason: "counting the scenario arms rather than the pilot" }
]

/**
 * Every reason `manifest` would deliver the wrong surface. Empty means the manifest agrees with the
 * registry and profile it is describing. Problems are returned rather than thrown so both the
 * audit script and its tests can report all of them at once.
 */
export function deliveryManifestProblems(
  manifest: SproCoreDeliveryCandidate,
  facts: DeliverySurfaceFacts
): string[] {
  const problems: string[] = []
  if (manifest.format !== 1) {
    problems.push(`format ${String(manifest.format)} is not the supported format 1`)
  }
  const profile = manifest.profile
  if (typeof profile !== "string" || profile.trim() === "") {
    problems.push("profile is not declared, so no tool surface can be resolved")
  } else if (!facts.profileNames.includes(profile)) {
    problems.push(`profile "${profile}" is not one of ${facts.profileNames.join(", ")}`)
  }
  const required = manifest.requiredTools ?? []
  const excluded = manifest.excludedTools ?? []
  if (required.length === 0) {
    problems.push("requiredTools is empty: the delivered service would expose no tool at all")
  }
  const known = new Set(facts.allTools)
  const enabled = new Set(facts.profileTools)
  const exclusions = new Map<string, string>()
  for (const exclusion of excluded) {
    exclusions.set(exclusion.tool, exclusion.reason ?? "")
  }
  const seen = new Set<string>()
  for (const tool of required) {
    if (seen.has(tool)) {
      problems.push(`requiredTools lists ${tool} more than once`)
    }
    seen.add(tool)
    if (!known.has(tool)) {
      problems.push(`requiredTools names ${tool}, which no tool registry entry implements`)
    } else if (!enabled.has(tool)) {
      problems.push(
        `requiredTools names ${tool}, which profile "${String(profile)}" does not enable`
      )
    }
    if (exclusions.has(tool)) {
      problems.push(`${tool} is both required and excluded, so the contract contradicts itself`)
    }
  }
  for (const [tool, reason] of exclusions) {
    if (!known.has(tool)) {
      problems.push(`excludedTools names ${tool}, which no tool registry entry implements`)
    } else if (!isImgConfigurationTool(tool)) {
      problems.push(`excludedTools names ${tool}, which is not an IMG configuration tool`)
    }
    if (reason.trim() === "") {
      problems.push(`excludedTools names ${tool} without a reason, so nothing records why`)
    }
  }
  // Acceptance disclosure. The registry is the only authority on `verified`; the manifest may not
  // widen it, and may not stay silent about a delivered tool it does not cover either.
  const verified = new Set(facts.verifiedTools)
  const declared = manifest.unverifiedTools ?? []
  const declaredTools = new Set<string>()
  for (const tool of declared) {
    if (declaredTools.has(tool)) {
      problems.push(`unverifiedTools lists ${tool} more than once`)
    }
    declaredTools.add(tool)
    if (!known.has(tool)) {
      problems.push(`unverifiedTools names ${tool}, which no tool registry entry implements`)
    } else if (!isImgConfigurationTool(tool)) {
      problems.push(`unverifiedTools names ${tool}, which is not an IMG configuration tool`)
    }
    if (!seen.has(tool)) {
      problems.push(`unverifiedTools names ${tool}, which this surface does not deliver`)
    }
    if (verified.has(tool)) {
      problems.push(
        `unverifiedTools names ${tool}, but contracts/verification-registry.json verifies it`
      )
    }
  }
  for (const tool of required) {
    if (!isImgConfigurationTool(tool) || verified.has(tool)) continue
    if (!declaredTools.has(tool)) {
      problems.push(
        `IMG configuration tool ${tool} is delivered without a registry verification and is not ` +
          `declared in unverifiedTools, so the surface implies acceptance it does not have`
      )
    }
  }
  // The same disclosure for every other family. A delivered tool that reaches no SAP acceptance and
  // is not an IMG configuration tool is invisible to the loop above, so it is declared here and
  // compared both ways: a new one cannot be delivered undisclosed, and a declaration cannot be left
  // behind once its tool is verified.
  const outsideDeclared = manifest.unverifiedOutsideConfiguration ?? []
  const outsideTools = new Set<string>()
  for (const entry of outsideDeclared) {
    const tool = typeof entry?.tool === "string" ? entry.tool : ""
    if (tool === "") {
      problems.push("unverifiedOutsideConfiguration contains an entry with no tool")
      continue
    }
    if (outsideTools.has(tool)) {
      problems.push(`unverifiedOutsideConfiguration lists ${tool} more than once`)
    }
    outsideTools.add(tool)
    if (!known.has(tool)) {
      problems.push(
        `unverifiedOutsideConfiguration names ${tool}, which no tool registry entry implements`
      )
    } else if (isImgConfigurationTool(tool)) {
      problems.push(
        `unverifiedOutsideConfiguration names ${tool}, which is an IMG configuration tool and ` +
          `belongs in unverifiedTools`
      )
    }
    if (!seen.has(tool)) {
      problems.push(
        `unverifiedOutsideConfiguration names ${tool}, which this surface does not deliver`
      )
    }
    if (verified.has(tool)) {
      problems.push(
        `unverifiedOutsideConfiguration names ${tool}, but contracts/verification-registry.json ` +
          `verifies it`
      )
    }
    if (typeof entry?.reason !== "string" || entry.reason.trim() === "") {
      problems.push(
        `unverifiedOutsideConfiguration names ${tool} without a reason, so nothing records why`
      )
    }
  }
  for (const tool of required) {
    if (isImgConfigurationTool(tool) || verified.has(tool)) continue
    if (!outsideTools.has(tool)) {
      problems.push(
        `delivered tool ${tool} is not an IMG configuration tool and has no registry verification, ` +
          `so unverifiedTools cannot describe it and it must be declared in ` +
          `unverifiedOutsideConfiguration`
      )
    }
  }
  for (const tool of imgConfigurationTools(facts.allTools)) {
    // A tool the declared profile cannot reach is outside this surface; the profile decides that,
    // not the manifest, so it is not a delivery problem.
    if (!enabled.has(tool)) continue
    if (seen.has(tool) || exclusions.has(tool)) continue
    problems.push(
      `IMG configuration tool ${tool} is implemented and enabled by profile "${String(profile)}" ` +
        `but is neither delivered in requiredTools nor excluded with a reason`
    )
  }
  // Scenario flows ship to the customer as the loops this surface promises to run, while the
  // packaged service refuses every tool outside requiredTools. Nothing else reads these fields, so
  // an unusable step or an unstated recovery would otherwise reach the customer unremarked.
  const reads = new Set(facts.readOnlyTools)
  const writes = new Set(facts.writeTools)
  const scenarioIds = new Set<string>()
  // Every tool a published scenario explains, in either arm. A reversing tool declared in
  // `failurePath` is explained by the scenario just as much as a happy-path step is, so the
  // documentation coverage below counts both and does not ask for it to be declared twice.
  const scenarioTools = new Set<string>()
  for (const entry of manifest.scenarios ?? []) {
    const scenario = (entry ?? {}) as Partial<SproCoreDeliveryScenario>
    const id = typeof scenario.id === "string" ? scenario.id.trim() : ""
    const label = id === "" ? "a scenario with no id" : `scenario "${id}"`
    if (id === "") {
      problems.push("scenarios contains an entry with no id, so no flow can be referred to")
    } else if (scenarioIds.has(id)) {
      problems.push(`scenarios lists the id "${id}" more than once`)
    }
    scenarioIds.add(id)
    for (const field of ["scope", "recovery", "cts"] as const) {
      const value = scenario[field]
      if (typeof value !== "string" || value.trim() === "") {
        problems.push(`${label} declares no ${field}, so that part of its contract is unstated`)
      }
    }
    const flow = Array.isArray(scenario.flow) ? scenario.flow : []
    if (flow.length === 0) {
      problems.push(`${label} has an empty flow, so it closes no loop`)
    }
    const steps = new Set<string>()
    for (const tool of flow) {
      if (steps.has(tool)) {
        problems.push(`${label} names ${tool} twice in its flow`)
      }
      steps.add(tool)
      scenarioTools.add(tool)
      if (!known.has(tool)) {
        problems.push(`${label} runs ${tool}, which no tool registry entry implements`)
      } else if (!seen.has(tool)) {
        problems.push(
          `${label} runs ${tool}, which this surface does not deliver, so the packaged service ` +
            `would refuse a step of a flow the contract publishes`
        )
      }
    }
    // A published closed loop is the milestone this project delivers: locate, read, preview, run the
    // official API, observe the result. A flow that never writes promises no such loop, and a flow
    // that writes and then stops never observes what it changed.
    if (flow.length > 0) {
      if (!flow.some((tool) => writes.has(tool))) {
        problems.push(
          `${label} publishes a closed loop whose flow never executes a write, so it is not the ` +
            `business loop this contract presents it as`
        )
      }
      const lastWrite = flow.reduce((at, tool, index) => (writes.has(tool) ? index : at), -1)
      if (lastWrite >= 0 && !flow.some((tool, index) => index > lastWrite && reads.has(tool))) {
        problems.push(
          `${label} runs ${String(flow[lastWrite])} as its last write and then no read-only step, ` +
            `so its flow never observes what the write changed`
        )
      }
    }
    // The two arms are separate fields because a flat list cannot say which one a step belongs to,
    // and the customer runs the happy path. A reversing write left in `flow` would be executed as
    // step N of a loop the contract publishes as its own success story.
    for (const tool of flow) {
      if (!isCompensatingWrite(tool) || reads.has(tool)) continue
      problems.push(
        `${label} runs ${tool} in its happy path, and that is the arm which reverses what the loop ` +
          `applies, so the published flow would undo itself; a reversing write belongs in failurePath`
      )
    }
    const failurePath = scenario.failurePath
    if (!Array.isArray(failurePath)) {
      problems.push(
        `${label} declares no failurePath, so the contract does not say whether its change can be ` +
          `reversed or has to be handled by hand`
      )
    } else {
      const reversal = new Set<string>()
      for (const tool of failurePath) {
        if (reversal.has(tool)) {
          problems.push(`${label} lists ${tool} twice in its failurePath`)
        }
        reversal.add(tool)
        scenarioTools.add(tool)
        if (!known.has(tool)) {
          problems.push(
            `${label} declares ${tool} in its failurePath, which no tool registry entry implements`
          )
        } else if (!seen.has(tool)) {
          problems.push(
            `${label} declares ${tool} in its failurePath, which this surface does not deliver`
          )
        }
        if (steps.has(tool)) {
          problems.push(
            `${label} runs ${tool} in its flow and also declares it in failurePath, so the ` +
              `contract does not say which arm it belongs to`
          )
        }
      }
    }
  }
  // Documentation coverage. The scenarios are the loops this contract publishes; a delivered IMG
  // configuration tool that appears in none of them is either explained here or invisible, and an
  // invisible tool reads as if the surface had nothing to say about it. Both directions are checked
  // so the list cannot rot: a tool that later joins a scenario has to leave the list again.
  const supporting = manifest.supportingReads ?? []
  const supportingTools = new Set<string>()
  for (const entry of supporting) {
    const tool = typeof entry?.tool === "string" ? entry.tool : ""
    if (tool === "") {
      problems.push("supportingReads contains an entry with no tool")
      continue
    }
    if (supportingTools.has(tool)) {
      problems.push(`supportingReads lists ${tool} more than once`)
    }
    supportingTools.add(tool)
    if (!known.has(tool)) {
      problems.push(`supportingReads names ${tool}, which no tool registry entry implements`)
    } else if (!seen.has(tool)) {
      problems.push(`supportingReads names ${tool}, which this surface does not deliver`)
    }
    // A write parked here would be described as a read by the field it is written in, and the
    // coverage loop below would require it: only a scenario states a write's scope, recovery and CTS,
    // so a delivered write capability that no scenario publishes is a gap, not a supporting read.
    if (writes.has(tool)) {
      problems.push(
        `supportingReads names ${tool}, which contracts/verification-registry.json classifies as a ` +
          `write, so it is not a supporting read; a delivered write capability has to be published ` +
          `in a scenario, which is the only place its scope, recovery and CTS are stated`
      )
    }
    if (typeof entry?.reason !== "string" || entry.reason.trim() === "") {
      problems.push(`supportingReads names ${tool} without a reason, so nothing records its role`)
    }
    if (scenarioTools.has(tool)) {
      problems.push(
        `supportingReads names ${tool}, which a published scenario already runs, so the contract ` +
          `describes it twice`
      )
    }
  }
  for (const tool of required) {
    if (!isImgConfigurationTool(tool) || scenarioTools.has(tool)) continue
    // A write cannot be documented by a supporting read, so its absence from every scenario is a gap
    // in the contract rather than a missing declaration: nothing else in this file states the scope a
    // write may touch, how it is undone, or what it records in CTS.
    if (writes.has(tool)) {
      problems.push(
        `IMG configuration tool ${tool} is delivered and writes, but appears in no published ` +
          `scenario, so nothing states the scope it may touch, how it is undone or what it records ` +
          `in CTS; a delivered write capability has to be published as a closed loop`
      )
      continue
    }
    if (supportingTools.has(tool)) continue
    problems.push(
      `IMG configuration tool ${tool} is delivered but appears in no published scenario and is not ` +
        `declared in supportingReads, so the contract explains nothing about it`
    )
  }
  // How large the one pilot that writes CUNI is gets stated in words - "fixed nine-table/nineteen-key
  // CUNI scope: ten candidate rows and nine protected keys". No field carries those counts and nothing
  // derives them, so a second sentence in this same file can disagree with the first and the registry's
  // own record of the run (nine tables there) cannot settle it. A count a reader cannot resolve is
  // worse than no count, so each family may be spelled exactly one way.
  const spelled = JSON.stringify(manifest)
  const familySpans: Array<{ readonly start: number; readonly end: number }> = []
  for (const { describes, pattern } of SCOPE_COUNT_FAMILIES) {
    const counts = new Map<number, string>()
    for (const match of spelled.matchAll(pattern)) {
      const value = SCOPE_COUNT_WORDS[match[1]!]
      if (value === undefined) continue
      const start = match.index!
      familySpans.push({ start, end: start + match[0].length })
      if (!counts.has(value)) counts.set(value, match[0])
    }
    if (counts.size > 1) {
      problems.push(
        `the contract gives ${describes} ${String(counts.size)} different counts ` +
          `(${[...counts.values()].join(", ")}), so a reader cannot tell how large the pilot is`
      )
    }
  }
  // The families above only compare the phrases someone remembered to list. A sentence that counts the
  // pilot in words no family covers - "ten records", "eight entries" - would then ship unread and could
  // contradict every count that is checked, so each numeral has to be either inside a family or inside
  // a declared idiom. Matching is case-insensitive: a sentence-initial "Ten records" is still a count.
  const usedIdioms = new Set<string>()
  for (const match of spelled.matchAll(/\b([A-Za-z]+)\b/g)) {
    const value = SCOPE_COUNT_WORDS[match[1]!.toLowerCase()]
    // A singular "one" is the English article here ("one exact internal unit key"), and a real count of
    // exactly one would be written the same way, so singular "one" is never read as a count.
    if (value === undefined || value < 2) continue
    const start = match.index!
    if (familySpans.some((span) => start >= span.start && start < span.end)) continue
    const tail = spelled.slice(start, start + 60)
    const idiom = SCOPE_COUNT_IDIOMS.find((entry) => tail.toLowerCase().startsWith(entry.phrase))
    if (idiom) {
      usedIdioms.add(idiom.phrase)
      continue
    }
    problems.push(
      `the contract counts "${/^([A-Za-z]+(?: [A-Za-z]+)?)/.exec(tail)![1]}" in words no family ` +
        `covers and no idiom declares, so it is never compared with the pilot's other counts`
    )
  }
  // An idiom that no longer appears has outlived its phrase, and leaving it declared would silently
  // excuse a future count written the same way. This only applies to a manifest that states the pilot's
  // counts at all: a candidate with no count sentence has no exemption to keep, and reporting its
  // missing idioms would drown the real problems of every minimal fixture.
  if (familySpans.length > 0) {
    for (const { phrase, reason } of SCOPE_COUNT_IDIOMS) {
      if (!usedIdioms.has(phrase))
        problems.push(
          `the contract no longer says "${phrase}", which is declared as ${reason}, so that ` +
            `declaration is stale`
        )
    }
  }
  return problems
}
