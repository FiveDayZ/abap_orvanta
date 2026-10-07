import type { SapBackend } from "./backend.js"

const ddicReads = new Set([
  "READ_TRANSPARENT_TABLE",
  "READ_STRUCTURE",
  "READ_DATA_ELEMENT",
  "READ_DOMAIN",
  "READ_TABLE_TYPE"
])
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((key) => [key, v[key]])
        )
      : v
  )

/** One preflight only: share definitions, then independently re-read every raw result. */
export function configurationBcMetadataScope(original: SapBackend) {
  const entries = new Map<string, { read: () => Promise<unknown>; first: Promise<unknown> }>()
  let logicalReads = 0,
    reusedReads = 0,
    freshRechecks = 0,
    closed = false
  const share = async (method: string, args: unknown[], read: () => Promise<unknown>) => {
    if (closed) throw Error("CONFIGURATION_BC_PREFLIGHT_METADATA_SCOPE_CLOSED")
    logicalReads++
    const key = canonical([method, args])
    let entry = entries.get(key)
    if (entry) reusedReads++
    else {
      entry = { read, first: Promise.resolve().then(read) }
      entries.set(key, entry)
    }
    // A caller must not be able to alter a later attestation or the stored comparison baseline.
    return structuredClone(await entry.first)
  }
  const backend = new Proxy(original, {
    get(target, property) {
      if (property === "callSapDdic")
        return (connection: string, request: Parameters<SapBackend["callSapDdic"]>[1]) => {
          if (connection !== "w200" || !ddicReads.has(request.operation))
            return target.callSapDdic(connection, request)
          const copy = structuredClone(request)
          return share(property, [connection, copy], () => target.callSapDdic(connection, copy))
        }
      if (property === "callSapRepository")
        return (connection: string, request: Parameters<SapBackend["callSapRepository"]>[1]) => {
          if (connection !== "w200" || request.operation !== "READ_FUNCTION_INTERFACE")
            return target.callSapRepository(connection, request)
          const copy = structuredClone(request)
          return share(property, [connection, copy], () =>
            target.callSapRepository(connection, copy)
          )
        }
      if (property === "readSourceByUri")
        return (connection: string, uri: string) =>
          connection === "w200"
            ? share(property, [connection, uri], () => target.readSourceByUri(connection, uri))
            : target.readSourceByUri(connection, uri)
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    }
  })
  return {
    backend,
    async verify() {
      if (closed) throw Error("CONFIGURATION_BC_PREFLIGHT_METADATA_SCOPE_CLOSED")
      // Seal before refreshing: no new or reused definition may enter the closing observation.
      closed = true
      const list = [...entries.values()]
      for (let offset = 0; offset < list.length; offset += 4) {
        const settled = await Promise.allSettled(
          list.slice(offset, offset + 4).map(async (entry) => {
            const first = await entry.first
            freshRechecks++
            if (canonical(await entry.read()) !== canonical(first))
              throw Error("CONFIGURATION_BC_PREFLIGHT_METADATA_CHANGED")
          })
        )
        for (const result of settled) if (result.status === "rejected") throw result.reason
      }
      return {
        scope: "request_only_definitions_and_source" as const,
        logicalReads,
        uniqueReads: entries.size,
        reusedReads,
        freshRechecks,
        physicalReads: entries.size + freshRechecks,
        completeFreshRecheck: true,
        configurationRowsCached: false,
        ctsRowsCached: false,
        crossRequestReuse: false,
        lockedSnapshot: false
      }
    }
  }
}
