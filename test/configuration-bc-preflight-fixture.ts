import { readFileSync } from "node:fs"
import { configurationBcNativeReadApi as configurationBcNativeApi } from "../src/configuration-bc-native-api.js"
import { configurationBcPreviewApi } from "../src/configuration-bc-preview-api.js"
import { configurationBcRouteApi } from "../src/configuration-bc-route-api.js"
import { configurationBcGuardApi } from "../src/configuration-bc-guard-api.js"
import { preflightConfigurationBcActivation } from "../src/configuration-bc-preflight.js"

// Historical real child responses are local replay fixtures, never live preflight evidence.
const load = (file: string, name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../docs/workspace-evidence/.doc/${file}`, import.meta.url), "utf8")
  ).calls.find(
    (c: { name: string; isError: boolean; data: { native?: unknown } }) =>
      c.name === name && !c.isError && c.data.native
  ).data
const historical = {
  snapshot: load(
    "orvanta-configuration-bc-guard-acceptance-20261005-r49-repair.json",
    "read_configuration_bc_native_snapshot"
  ),
  route: load(
    "orvanta-configuration-bc-guard-acceptance-20261005-r49-repair.json",
    "inspect_configuration_bc_route"
  ),
  guard: load(
    "orvanta-configuration-bc-guard-acceptance-20261005-r49-repair.json",
    "read_configuration_bc_guard"
  ),
  preview: load(
    "orvanta-configuration-bc-preview-acceptance-20261005-r46.json",
    "preview_configuration_bc_native"
  )
}
export function preflightFixture() {
  const data = structuredClone(historical),
    counts = { snapshot: 0, preview: 0, route: 0, guard: 0, definition: 0 }
  const input = {
    connectionId: "w200",
    bcSetId: "EHS_CUNI_KNM",
    version: "N",
    nativeSourceVersion: data.snapshot.native.EV_SOURCE_VERSION,
    nativeTargetVersion: data.snapshot.native.EV_TARGET_VERSION,
    nativeCandidateVersion: data.preview.candidateVersion,
    nativeMetadataVersion: data.route.metadataVersion,
    nativeGuardVersion: data.guard.guardVersion
  }
  const apis = [
    configurationBcNativeApi,
    configurationBcPreviewApi,
    configurationBcRouteApi,
    configurationBcGuardApi
  ]
  const definitions = Object.fromEntries(
    apis.map((api) => [
      api.functionName,
      {
        ...api,
        connectionId: "w200",
        updateTask: false,
        updateTaskMode: "",
        changingParameters: [],
        exceptions: [],
        sourceFingerprint: "a".repeat(64),
        interfaceFingerprint: "b".repeat(64),
        source: [`FUNCTION ${api.functionName}.`, ...api.source, "ENDFUNCTION."]
      }
    ])
  )
  const readers = {
    snapshot: async () => {
      counts.snapshot++
      return structuredClone(data.snapshot)
    },
    preview: async () => {
      counts.preview++
      return structuredClone(data.preview)
    },
    route: async () => {
      counts.route++
      return structuredClone(data.route)
    },
    guard: async () => {
      counts.guard++
      return structuredClone(data.guard)
    },
    definition: async (name: string) => {
      counts.definition++
      return structuredClone(definitions[name]!)
    }
  }
  return {
    data,
    input,
    counts,
    definitions,
    readers,
    invoke: (raw: unknown = input, client = "200") =>
      preflightConfigurationBcActivation(raw, client, readers)
  }
}
