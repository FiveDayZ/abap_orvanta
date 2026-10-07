import type { SapBackend } from "./backend.js"

export function assertConfigurationBcReadActive(signal: AbortSignal) {
  if (signal.aborted) throw Error("CONFIGURATION_BC_READ_CANCELLED")
}

/** One read request only. In-flight reads settle, but cannot publish or dispatch another read. */
export function configurationBcReadBackend(original: SapBackend, signal: AbortSignal): SapBackend {
  return new Proxy(original, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== "function") return value
      return (...args: unknown[]) => {
        assertConfigurationBcReadActive(signal)
        const result = Reflect.apply(value, target, args)
        if (result instanceof Promise)
          return Promise.resolve(result).then(
            (v) => {
              assertConfigurationBcReadActive(signal)
              return v
            },
            (error) => {
              assertConfigurationBcReadActive(signal)
              throw error
            }
          )
        assertConfigurationBcReadActive(signal)
        return result
      }
    }
  })
}
