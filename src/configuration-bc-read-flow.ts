import { z } from "zod"
import { configurationBcPreviewSourceVersion } from "./configuration-bc-preview.js"
import { configurationBcStateTables } from "./configuration-bc-state-api.js"

const versionOrigins = {
  source: "read_configuration_bc_native_snapshot.native.EV_SOURCE_VERSION",
  target: "read_configuration_bc_native_snapshot.native.EV_TARGET_VERSION",
  candidate: "preview_configuration_bc_native.candidateVersion",
  metadata: "inspect_configuration_bc_route.metadataVersion",
  guard: "read_configuration_bc_guard.guardVersion",
  cts: "read_configuration_bc_cts_snapshot.ctsVersion"
} as const
type Version = keyof typeof versionOrigins
const preflightVersions: Version[] = ["source", "target", "metadata", "candidate", "guard"]
const scope = { connectionId: "w200", bcSetId: "EHS_CUNI_KNM", version: "N" }
const transport = { requestNumber: "GR2K923429", taskNumber: "GR2K923430" }
const hex = z.string().regex(/^[a-f0-9]{64}$/)
const observation = z
  .object({
    ...Object.fromEntries(Object.entries(scope).map(([key, value]) => [key, z.literal(value)])),
    client: z.literal("200"),
    readOnly: z.literal(true),
    snapshot: z.literal(false)
  })
  .passthrough()

/** Public display only: never add these fields to native readers or immutable evidence. */
export function configurationBcReadFlow(name: string, text: string): string {
  const paths: Record<string, Record<string, string>> = {
    read_configuration_bc_native_snapshot: {
      source: "native.EV_SOURCE_VERSION",
      target: "native.EV_TARGET_VERSION"
    },
    preview_configuration_bc_native: {
      source: "nativeSourceVersion",
      target: "nativeTargetVersion",
      candidate: "candidateVersion"
    },
    inspect_configuration_bc_route: {
      source: "nativeSourceVersion",
      target: "nativeTargetVersion",
      metadata: "metadataVersion"
    },
    read_configuration_bc_guard: {
      source: "nativeSourceVersion",
      target: "nativeTargetVersion",
      metadata: "nativeMetadataVersion",
      guard: "guardVersion"
    },
    preflight_configuration_bc_activation: Object.fromEntries(
      preflightVersions.map((version) => [version, `versions.${version}`])
    ),
    read_configuration_bc_cts_snapshot: { cts: "ctsVersion" },
    read_configuration_bc_before_state: Object.fromEntries(
      [...preflightVersions, "cts", "state"].map((version) => [version, `versions.${version}`])
    ),
    read_configuration_bc_effects: { cts: "ctsVersion", effects: "effectsVersion" }
  }
  const versionSources = paths[name]
  if (!versionSources) return text
  const raw: unknown = JSON.parse(text)
  const result = observation.safeParse(raw)
  const value = (path: string): unknown =>
    path
      .split(".")
      .reduce<unknown>(
        (current, key) =>
          current && typeof current === "object"
            ? (current as Record<string, unknown>)[key]
            : undefined,
        raw
      )
  const versions = Object.fromEntries(
    Object.entries(versionSources).map(([version, path]) => [version, value(path)])
  )
  let supported =
    result.success &&
    Object.values(versions).every((version) => hex.safeParse(version).success) &&
    (versions.source === undefined || versions.source === configurationBcPreviewSourceVersion)
  if (name === "read_configuration_bc_native_snapshot") {
    const states = z.array(z.object({ mappingConflict: z.boolean() })).safeParse(value("states"))
    supported &&= states.success && !states.data.some((state) => state.mappingConflict)
  }
  if (name === "inspect_configuration_bc_route") {
    const members = z.array(z.object({ TABNAME: z.string() })).safeParse(value("members"))
    supported &&=
      members.success &&
      JSON.stringify(members.data.map((row) => row.TABNAME).sort()) ===
        JSON.stringify([...configurationBcStateTables].sort()) &&
      Array.isArray(value("methods")) &&
      (value("methods") as unknown[]).length === 0
  }
  if (["read_configuration_bc_before_state", "read_configuration_bc_effects"].includes(name)) {
    supported &&=
      Object.entries(transport).every(([key, expected]) => value(key) === expected) &&
      hex.safeParse(value("beforeStateReference")).success
  }
  if (name === "read_configuration_bc_effects")
    supported &&=
      hex.safeParse(value("effectsStateReference")).success &&
      value("profileCount") === 1 &&
      ["matched", "records", "headers", "variables", "links"].every(
        (key) => value(`counts.${key}`) === 0
      )
  if (!supported) return JSON.stringify({ ...(raw as object), readFlow: null }, null, 2)

  const read = (tool: string, needed: Version[] = [], withTransport = false) => {
    const arguments_: Record<string, unknown> = {
      ...scope,
      ...(withTransport ? transport : {})
    }
    const argumentSources: Record<string, string> = Object.fromEntries(
      Object.keys(arguments_).map((key) => [key, key in scope ? key : "fixed_KNM_scope"])
    )
    const requiredArguments: string[] = []
    for (const version of needed) {
      const key = `native${version[0]!.toUpperCase()}${version.slice(1)}Version`
      if (versions[version] === undefined) requiredArguments.push(key)
      else arguments_[key] = versions[version]
      argumentSources[key] = versionSources[version] ?? versionOrigins[version]
    }
    return {
      tool,
      arguments: arguments_,
      requiredArguments,
      argumentSources,
      readOnly: true,
      executable: false,
      saveAvailable: false,
      usableForWritePrecondition: false
    }
  }
  const nextReads: ReturnType<typeof read>[] = []
  switch (name) {
    case "read_configuration_bc_native_snapshot":
      nextReads.push(
        read("preview_configuration_bc_native", ["source", "target"]),
        read("inspect_configuration_bc_route", ["source", "target"]),
        read("read_configuration_bc_cts_snapshot", [], true)
      )
      break
    case "preview_configuration_bc_native":
      nextReads.push(
        read("inspect_configuration_bc_route", ["source", "target"]),
        read("preflight_configuration_bc_activation", preflightVersions)
      )
      break
    case "inspect_configuration_bc_route":
      nextReads.push(
        read("read_configuration_bc_guard", ["source", "target", "metadata"]),
        read("preflight_configuration_bc_activation", preflightVersions)
      )
      break
    case "read_configuration_bc_guard":
      nextReads.push(read("preflight_configuration_bc_activation", preflightVersions))
      break
    case "preflight_configuration_bc_activation":
      nextReads.push(
        read("read_configuration_bc_cts_snapshot", [], true),
        read("read_configuration_bc_before_state", [...preflightVersions, "cts"], true)
      )
      break
    case "read_configuration_bc_cts_snapshot":
      nextReads.push(
        read("read_configuration_bc_before_state", [...preflightVersions, "cts"], true)
      )
      break
    case "read_configuration_bc_before_state": {
      const effects = read("read_configuration_bc_effects", [], true)
      effects.arguments.beforeStateReference = value("beforeStateReference")
      effects.requiredArguments.push("operationId")
      effects.argumentSources.beforeStateReference = "beforeStateReference"
      effects.argumentSources.operationId = "caller_read_evidence_label"
      nextReads.push(effects)
      break
    }
  }
  return JSON.stringify(
    {
      ...(raw as object),
      readFlow: {
        versionSources,
        referenceSources:
          name === "read_configuration_bc_effects"
            ? {
                beforeStateReference: "beforeStateReference",
                effectsReference: "effectsStateReference"
              }
            : name === "read_configuration_bc_before_state"
              ? { beforeStateReference: "beforeStateReference" }
              : {},
        nextReads,
        readOnly: true,
        executable: false,
        saveAvailable: false,
        usableForWritePrecondition: false
      }
    },
    null,
    2
  )
}
