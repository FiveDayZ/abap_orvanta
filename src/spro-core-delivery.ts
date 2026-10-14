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
 * An implemented IMG configuration tool left out of the surface, with the reason it is left out.
 * Every omission has to be written down; silence is what this audit exists to remove.
 */
export interface SproCoreDeliveryExclusion {
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
  excludedTools: SproCoreDeliveryExclusion[]
  scenarios: readonly unknown[]
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
}

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
  return problems
}
