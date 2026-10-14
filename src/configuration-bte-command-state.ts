import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import { configurationUnitApiBody } from "./configuration-unit-api.js"
import {
  configurationBteStateApi,
  configurationBteStateInclude,
  configurationBteStateIncludeFingerprint
} from "./configuration-bte-command-api.js"
import { configurationBteCommandStateSchema } from "./configuration-bte-command.js"

const parameter = z.object({
  name: z.string(),
  typeName: z.string(),
  optional: z.boolean(),
  passByValue: z.boolean()
})
const definition = z.object({
  connectionId: z.literal("w200"),
  functionName: z.literal(configurationBteStateApi.functionName),
  functionGroup: z.literal(configurationBteStateApi.functionGroup),
  remoteEnabled: z.literal(true),
  updateTask: z.literal(false),
  updateTaskMode: z.literal(""),
  globalInterface: z.literal(false),
  importParameters: z.array(parameter),
  exportParameters: z.array(parameter),
  changingParameters: z.array(z.never()),
  tableParameters: z.array(z.never()),
  exceptions: z.array(z.never()),
  source: z.array(z.string()),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  interfaceFingerprint: z.string().regex(/^[a-f0-9]{64}$/)
})
function fail(code: string): never {
  throw Error(`BTE_STATE_${code}`)
}
const sorted = (entries: readonly unknown[]) =>
  JSON.stringify([...entries].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))

/** The whole private Include is pinned; an unchanged RFC wrapper alone is insufficient. */
export async function attestConfigurationBteState(
  readDefinition: () => Promise<unknown>,
  readInclude: () => Promise<unknown>
) {
  const d = definition.parse(await readDefinition())
  const include = z
    .object({
      connectionId: z.literal("w200"),
      objectName: z.literal(configurationBteStateInclude.includeName),
      source: z.string(),
      kind: z.literal("source")
    })
    .parse(await readInclude())
  const headers = d.source.filter((line) => /^\s*FUNCTION\s+/i.test(line))
  if (
    headers.length !== 1 ||
    headers[0]!.trim().toUpperCase() !== `FUNCTION ${d.functionName}.` ||
    sorted(d.importParameters) !== sorted(configurationBteStateApi.importParameters) ||
    sorted(d.exportParameters) !== sorted(configurationBteStateApi.exportParameters) ||
    configurationUnitApiBody(d.source) !==
      configurationUnitApiBody(configurationBteStateApi.source) ||
    createHash("sha256")
      .update(include.source.replace(/\r\n/g, "\n").replace(/\n+$/, ""))
      .digest("hex") !== configurationBteStateIncludeFingerprint
  )
    fail("API_UNVERIFIED")
  return {
    STATE_SOURCE: d.sourceFingerprint,
    STATE_INTERFACE: d.interfaceFingerprint,
    STATE_INCLUDE: configurationBteStateIncludeFingerprint
  }
}

/**
 * Private read adapter for a future approved deployment. Preparation reads an unlocked frame;
 * this is not an atomic snapshot or native SAVE acceptance. No generic table-reader fallback.
 */
export async function readConfigurationBteCommandState(
  product: string,
  backend: Pick<SapBackend, "callRemoteFunction">,
  readers: { definition: () => Promise<unknown>; include: () => Promise<unknown> }
) {
  z.string()
    .regex(/^[ZY][A-Z0-9_]{0,7}$/)
    .parse(product)
  const first = await attestConfigurationBteState(readers.definition, readers.include)
  const result = await backend.callRemoteFunction("w200", {
    functionName: configurationBteStateApi.functionName,
    inputParameters: { IV_PRODUCT: product },
    outputParameters: configurationBteStateApi.exportParameters.map((p) => ({
      name: p.name,
      kind: "scalar" as const
    }))
  })
  if (result.fault) fail("READ_FAILED")
  const output = z
    .object(
      Object.fromEntries(configurationBteStateApi.exportParameters.map((p) => [p.name, z.string()]))
    )
    .strict()
    .parse(result.outputs)
  if (
    output.EV_CODE !== "STATE_READ" ||
    output.EV_SYSTEM !== "GR2" ||
    output.EV_CLIENT !== "200" ||
    output.EV_USER !== "WYS" ||
    output.EV_PRODUCT !== product
  )
    fail("READ_UNVERIFIED")
  const second = await attestConfigurationBteState(readers.definition, readers.include)
  if (JSON.stringify(first) !== JSON.stringify(second)) fail("API_CHANGED")
  return configurationBteCommandStateSchema.parse({
    connectionId: "w200",
    system: output.EV_SYSTEM,
    client: output.EV_CLIENT,
    username: output.EV_USER,
    product: output.EV_PRODUCT,
    request: "GR2K923429",
    task: "GR2K923430",
    active: output.EV_ACTIVE,
    frame: output.EV_FRAME,
    version: output.EV_VERSION,
    protectedVersion: output.EV_PROTECTED_VERSION,
    ctsVersion: output.EV_CTS_VERSION,
    routeVersion: output.EV_ROUTE_VERSION,
    cacheVersion: output.EV_CACHE_VERSION
  })
}
