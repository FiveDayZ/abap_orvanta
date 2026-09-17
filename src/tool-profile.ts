import {
  PROFILE_NAMES,
  TOOL_NAMES,
  toolNamesForProfile,
  type ProfileName
} from "./tool-registry.js"

export interface ToolProfileState {
  /** Resolved profile name. */
  profile: ProfileName
  /** Raw `ABAP_MCP_TOOL_PROFILE` value, or null when the default was used. */
  requested: string | null
  source: "environment" | "default"
  denied: readonly string[]
  enabled: readonly string[]
  disabled: readonly string[]
}

export interface ToolProfileSummary {
  profile: ProfileName
  source: "environment" | "default"
  requested: string | null
  enabledCount: number
  disabledCount: number
  denied: readonly string[]
}

export const TOOL_PROFILE_ENV = "ABAP_MCP_TOOL_PROFILE"
export const TOOL_DENY_ENV = "ABAP_MCP_TOOL_DENY"
export const DEFAULT_TOOL_PROFILE: ProfileName = "full"

/**
 * Resolve the exposed tool surface from the environment.
 *
 * `ABAP_MCP_TOOL_PROFILE` selects a profile (`full` by default, so an unconfigured service
 * keeps exposing every tool exactly as before). `ABAP_MCP_TOOL_DENY` removes individual
 * tools on top of the profile. Both values are validated here and fail loudly: a typo in a
 * deny list would otherwise leave a tool silently enabled, which is the opposite of what a
 * safety switch is for.
 */
export function resolveToolProfile(env: NodeJS.ProcessEnv = process.env): ToolProfileState {
  const requested = env[TOOL_PROFILE_ENV]?.trim() || null
  const profile = (requested ?? DEFAULT_TOOL_PROFILE) as ProfileName
  if (!PROFILE_NAMES.includes(profile)) {
    throw new Error(
      `${TOOL_PROFILE_ENV} must be one of ${PROFILE_NAMES.join(", ")}; received "${requested}"`
    )
  }
  const denied = parseToolDenyList(env[TOOL_DENY_ENV])
  const unknown = denied.filter((name) => !TOOL_NAMES.includes(name))
  if (unknown.length > 0) {
    throw new Error(`${TOOL_DENY_ENV} contains unknown tool names: ${unknown.join(", ")}`)
  }
  const enabled = toolNamesForProfile(profile).filter((name) => !denied.includes(name))
  const enabledSet = new Set(enabled)
  return {
    profile,
    requested,
    source: requested ? "environment" : "default",
    denied,
    enabled,
    disabled: TOOL_NAMES.filter((name) => !enabledSet.has(name))
  }
}

export function parseToolDenyList(value: string | undefined): string[] {
  if (!value) return []
  const names = value
    .split(/[\s,;]+/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
  return [...new Set(names)].sort()
}

export function toolProfileSummary(state: ToolProfileState): ToolProfileSummary {
  return {
    profile: state.profile,
    source: state.source,
    requested: state.requested,
    enabledCount: state.enabled.length,
    disabledCount: state.disabled.length,
    denied: state.denied
  }
}
