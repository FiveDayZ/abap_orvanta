import { z } from "zod"
import { configurationBcSetSchema } from "./configuration-bc-set.js"
import { configurationBcNativeSourcePins } from "./configuration-bc-native.js"

const inputSchema = configurationBcSetSchema.extend({
  connectionId: z.literal("w200"),
  bcSetId: z.literal("EHS_CUNI_KNM"),
  version: z.literal("N"),
  maxRecords: z.literal(50),
  maxValues: z.literal(100),
  maxDependencies: z.literal(32),
  includeRecordInventory: z.literal(true)
})
type Input = z.infer<typeof inputSchema>

/** Share only fixed BC Set source projections within one preflight, then freshly reattest them. */
export function configurationBcSourceScope(readFresh: (input: Input) => Promise<unknown>) {
  const entries = new Map<string, { input: Input; first: Promise<unknown> }>()
  let logicalReads = 0,
    reusedReads = 0,
    freshRechecks = 0,
    closed = false
  const attest = (input: Input, raw: unknown) => {
    const result = z
      .object({
        connectionId: z.literal(input.connectionId),
        client: z.literal("200"),
        bcSetId: z.literal(input.bcSetId),
        version: z.literal(input.version),
        objectName: z.literal(input.objectName),
        readOnly: z.literal(true),
        readFingerprint: z.literal(configurationBcNativeSourcePins[input.objectName]),
        recordInventory: z.object({
          complete: z.literal(true),
          fingerprint: z.literal("d9653312beab7ac191387dbd41ae7ee5e87e010a14d7b4c2432c08565c3aecce")
        }),
        coverage: z.object({
          truncated: z.literal(false),
          targetValueComparison: z.literal("not_performed")
        }),
        dependencies: z.array(z.never())
      })
      .safeParse(raw)
    if (!result.success) throw Error("CONFIGURATION_BC_PREFLIGHT_SOURCE_NOT_ATTESTED")
    return structuredClone(raw)
  }
  return {
    async read(raw: unknown) {
      if (closed) throw Error("CONFIGURATION_BC_PREFLIGHT_SOURCE_SCOPE_CLOSED")
      const input = inputSchema.parse(raw)
      logicalReads++
      let entry = entries.get(input.objectName)
      if (entry) reusedReads++
      else {
        entry = {
          input,
          first: Promise.resolve().then(async () =>
            attest(input, await readFresh(structuredClone(input)))
          )
        }
        entries.set(input.objectName, entry)
      }
      return structuredClone(await entry.first)
    },
    async verify() {
      if (closed) throw Error("CONFIGURATION_BC_PREFLIGHT_SOURCE_SCOPE_CLOSED")
      closed = true
      for (const entry of entries.values()) {
        await entry.first
        freshRechecks++
        // readFresh retains its own repeated table reads, layout checks and truncation guards.
        attest(entry.input, await readFresh(structuredClone(entry.input)))
      }
      return {
        scope: "one_preflight_fixed_bc_set_source_projections" as const,
        logicalReads,
        uniqueReads: entries.size,
        reusedReads,
        freshRechecks,
        physicalProjectionReads: entries.size + freshRechecks,
        completeFreshRecheck: true,
        targetRowsCached: false,
        ctsRowsCached: false,
        crossRequestReuse: false,
        lockedSnapshot: false
      }
    }
  }
}
