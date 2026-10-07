import { createHash } from "node:crypto"
import { z } from "zod"
import {
  attestConfigurationBcNativeApi,
  configurationBcNativeBodyFingerprint,
  scopedSnapshot
} from "./configuration-bc-native.js"
import {
  attestConfigurationBcPreviewApi,
  configurationBcPreviewBodyFingerprint,
  configurationBcPreviewResponseSchema,
  configurationBcPreviewSourceVersion
} from "./configuration-bc-preview.js"
import {
  attestConfigurationBcRouteApi,
  configurationBcRouteResponseSchema
} from "./configuration-bc-route.js"
import {
  attestConfigurationBcGuardApi,
  configurationBcGuardKeys,
  configurationBcGuardResponseSchema,
  configurationBcGuardSchema
} from "./configuration-bc-guard.js"
import { configurationBcNativeLayouts } from "./configuration-bc-native-api.js"
import { configurationBcRouteApi } from "./configuration-bc-route-api.js"
import {
  configurationBcGuardApi,
  configurationBcGuardLayouts
} from "./configuration-bc-guard-api.js"
import { configurationUnitApiBody } from "./configuration-unit-api.js"

const hex = z.string().regex(/^[a-f0-9]{64}$/)
export const configurationBcPreflightSchema = configurationBcGuardSchema
  .extend({ nativeCandidateVersion: hex, nativeGuardVersion: hex })
  .strict()
const base = z.object({
  connectionId: z.literal("w200"),
  client: z.literal("200"),
  bcSetId: z.literal("EHS_CUNI_KNM"),
  version: z.literal("N"),
  readOnly: z.literal(true),
  snapshot: z.literal(false),
  activationAvailable: z.literal(false),
  bodyFingerprint: hex
})
const names = ["T006", "T006A", "T006B", "T006C", "T006D"] as const
export const configurationBcPreflightKeys = [
  ...names.flatMap((tableName) =>
    (["T006A", "T006B", "T006C"].includes(tableName) ? ["1", "D", "E"] : [null]).map(
      (language) => ({
        tableName,
        key: {
          MANDT: "200",
          ...(language === null ? {} : { SPRAS: language }),
          ...(tableName === "T006D"
            ? { DIMID: "PRESS" }
            : tableName === "T006B"
              ? { MSEH3: "KNM" }
              : tableName === "T006C"
                ? { MSEH6: "kN/m2" }
                : { MSEHI: "KNM" })
        } as Record<string, string>
      })
    )
  ),
  ...configurationBcGuardKeys
]
const members = [...new Set(configurationBcPreflightKeys.map((k) => k.tableName))].sort()
const bodyHash = (source: readonly string[]) =>
  createHash("sha256").update(configurationUnitApiBody(source)).digest("hex")
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]])
        )
      : v
  )
const same = (a: unknown, b: unknown, code: string) => {
  if (canonical(a) !== canonical(b)) throw Error(`CONFIGURATION_BC_PREFLIGHT_${code}`)
}
const matching = (row: Record<string, string>, key: Record<string, string>) =>
  Object.entries(key).every(([k, v]) => row[k]?.trimEnd() === v)
const rowsOf = (native: unknown, name: string) =>
  z.array(z.record(z.string())).parse(z.record(z.unknown()).parse(native)[`ET_${name}`])
const apis = [
  ["Z_ORVANTA_CFG_BC_READ", attestConfigurationBcNativeApi],
  ["Z_ORVANTA_CFG_BC_PREVIEW", attestConfigurationBcPreviewApi],
  [configurationBcRouteApi.functionName, attestConfigurationBcRouteApi],
  [configurationBcGuardApi.functionName, attestConfigurationBcGuardApi]
] as const

/** Request-local composition only. No reuse across requests, locked snapshot or execution permit. */
export async function preflightConfigurationBcActivation(
  raw: unknown,
  client: string,
  readers: {
    snapshot: () => Promise<unknown>
    preview: () => Promise<unknown>
    route: () => Promise<unknown>
    guard: () => Promise<unknown>
    definition: (name: string) => Promise<unknown>
  }
) {
  const input = configurationBcPreflightSchema.parse(raw)
  if (client !== "200") throw Error("CONFIGURATION_BC_PREFLIGHT_SCOPE_UNSUPPORTED")
  if (input.nativeSourceVersion !== configurationBcPreviewSourceVersion)
    throw Error("CONFIGURATION_BC_PREFLIGHT_SOURCE_NOT_ATTESTED")
  const attest = async () => {
    const results = await Promise.allSettled(
      apis.map(async ([name, parse]) => ({
        functionName: name,
        ...parse(await readers.definition(name))
      }))
    )
    return results.map((r) => {
      if (r.status === "rejected") throw r.reason
      return r.value
    })
  }
  const definitions = await attest()
  let user: string | undefined
  const bind = (native: {
    EV_USER: string
    EV_SOURCE_VERSION: string
    EV_TARGET_VERSION: string
  }) => {
    user ??= native.EV_USER
    if (
      native.EV_USER !== user ||
      native.EV_SOURCE_VERSION !== input.nativeSourceVersion ||
      native.EV_TARGET_VERSION !== input.nativeTargetVersion
    )
      throw Error("CONFIGURATION_BC_PREFLIGHT_BINDING_INVALID")
  }
  const snapshot = async () => {
    const raw = await readers.snapshot(),
      envelope = base.extend({ saveAvailable: z.literal(false) }).parse(raw)
    same(envelope.bodyFingerprint, configurationBcNativeBodyFingerprint, "BODY_CHANGED")
    const native = scopedSnapshot(z.object({ native: z.unknown() }).parse(raw).native)
    bind(native)
    if ([...native.ET_T006B, ...native.ET_T006C].some((row) => row.MSEHI?.trimEnd() !== "KNM"))
      throw Error("CONFIGURATION_BC_PREFLIGHT_ALIAS_CONFLICT")
    return native
  }
  const route = async () => {
    const raw = await readers.route(),
      v = base
        .extend({
          executable: z.literal(false),
          methodExecutionAvailable: z.literal(false),
          metadataVersion: hex,
          methods: z.array(z.never()),
          methodSources: z.array(z.never()),
          native: configurationBcRouteResponseSchema
        })
        .parse(raw)
    same(v.bodyFingerprint, bodyHash(configurationBcRouteApi.source), "BODY_CHANGED")
    bind(v.native)
    same(v.metadataVersion, input.nativeMetadataVersion, "VERSION_CONFLICT")
    same(v.native.EV_METADATA_VERSION, input.nativeMetadataVersion, "VERSION_CONFLICT")
    same(v.native.ET_OBJS.map((r) => r.TABNAME).sort(), members, "MEMBERS_INVALID")
    if (
      v.native.ET_OBJM.length ||
      v.native.ET_OBJH[0]!.OBJECTNAME !== "CUNI" ||
      v.native.ET_OBJH[0]!.OBJECTTYPE !== "T" ||
      v.native.ET_OBJH[0]!.CLIDEP !== "X" ||
      v.native.ET_OBJH[0]!.LANGDEP !== "X" ||
      v.native.ET_OBJS.some((r) => r.OBJECTNAME !== "CUNI" || r.OBJECTTYPE !== "T")
    )
      throw Error("CONFIGURATION_BC_PREFLIGHT_ROUTE_UNSUPPORTED")
    return v.native
  }
  const guard = async () => {
    const raw = await readers.guard(),
      v = base
        .extend({
          executable: z.literal(false),
          methodExecutionAvailable: z.literal(false),
          guardVersion: hex,
          native: configurationBcGuardResponseSchema
        })
        .parse(raw)
    same(v.bodyFingerprint, bodyHash(configurationBcGuardApi.source), "BODY_CHANGED")
    bind(v.native)
    same(v.guardVersion, input.nativeGuardVersion, "VERSION_CONFLICT")
    same(v.native.EV_GUARD_VERSION, input.nativeGuardVersion, "VERSION_CONFLICT")
    same(v.native.EV_METADATA_VERSION, input.nativeMetadataVersion, "VERSION_CONFLICT")
    for (const [name, layout] of Object.entries(configurationBcGuardLayouts)) {
      const rows = v.native[`ET_${name}` as keyof typeof v.native] as Record<string, string>[]
      const expected = configurationBcGuardKeys.filter((k) => k.tableName === name),
        seen = new Set<string>()
      for (const row of rows) {
        const key = canonical(layout.keys.map((k) => row[k]?.trimEnd()))
        if (!expected.some((k) => matching(row, k.key)) || seen.has(key))
          throw Error("CONFIGURATION_BC_PREFLIGHT_KEY_INVALID")
        seen.add(key)
      }
    }
    return v.native
  }
  const before = await snapshot(),
    routeBefore = await route(),
    guardBefore = await guard()
  const rawPreview = await readers.preview(),
    preview = base
      .extend({
        executable: z.literal(false),
        saveAvailable: z.literal(false),
        simulation: z.literal(false),
        candidateVersion: hex,
        policy: z.literal("CREATE_INITIAL_OR_UPDATE_USE"),
        clientMapping: z.object({ source: z.literal("001"), target: z.literal("200") }),
        languagePolicy: z.object({
          sourcePlaceholder: z.literal("D"),
          selected: z.tuple([z.literal("1"), z.literal("D"), z.literal("E")]),
          approvedForActivation: z.literal(false)
        }),
        native: configurationBcPreviewResponseSchema
      })
      .parse(rawPreview)
  same(preview.bodyFingerprint, configurationBcPreviewBodyFingerprint, "BODY_CHANGED")
  bind(preview.native)
  same(preview.candidateVersion, input.nativeCandidateVersion, "VERSION_CONFLICT")
  same(preview.native.EV_CANDIDATE_VERSION, input.nativeCandidateVersion, "VERSION_CONFLICT")
  const entries = preview.native.EV_DIFFERENCES.split(";")
  if (entries.pop() !== "") throw Error("CONFIGURATION_BC_PREFLIGHT_DIFF_INVALID")
  let index = 0
  const rows = configurationBcPreflightKeys.map(({ tableName, key }) => {
    const related = tableName in configurationBcGuardLayouts
    const native = related ? guardBefore : before
    const values = rowsOf(native, tableName).find((row) => matching(row, key)) ?? null
    if (related)
      return {
        tableName,
        key,
        role: "preserve" as const,
        presence: values ? "present" : "missing",
        action: "preserve",
        before: values,
        after: values,
        differences: []
      }
    const name = tableName as (typeof names)[number]
    const candidateRows = preview.native[`ET_${name}`]
    if (
      candidateRows.some((row) => name !== "T006D" && row.MSEHI !== "KNM") ||
      candidateRows.some(
        (row) =>
          !configurationBcPreflightKeys.some((k) => k.tableName === name && matching(row, k.key))
      ) ||
      new Set(candidateRows.map((row) => canonical(Object.keys(key).map((k) => row[k])))).size !==
        candidateRows.length
    )
      throw Error("CONFIGURATION_BC_PREFLIGHT_KEY_INVALID")
    const position = candidateRows.findIndex((row) => matching(row, key)),
      after = candidateRows[position]
    if (!after) throw Error("CONFIGURATION_BC_PREFLIGHT_KEY_MISSING")
    const differences = configurationBcNativeLayouts[name].fields.map((field) => {
      const prefix = `${name}:${position + 1}:${field}:`,
        entry = entries[index++]
      if (!entry?.startsWith(prefix)) throw Error("CONFIGURATION_BC_PREFLIGHT_DIFF_INVALID")
      const status = z.enum(["NEW", "CHG", "EQL"]).parse(entry.slice(prefix.length))
      if ((!values && status !== "NEW") || (values && status === "NEW"))
        throw Error("CONFIGURATION_BC_PREFLIGHT_DIFF_INVALID")
      return {
        field,
        status,
        before: values?.[field] ?? null,
        after: after[field]!,
        comparisonOrigin: "sap_typed_field_comparison" as const
      }
    })
    return {
      tableName,
      key,
      role: "candidate" as const,
      presence: values ? "present" : "missing",
      action: !values
        ? "create"
        : differences.some((d) => d.status === "CHG")
          ? "change"
          : "unchanged",
      before: values,
      after,
      differences
    }
  })
  if (index !== entries.length) throw Error("CONFIGURATION_BC_PREFLIGHT_DIFF_INVALID")
  same(await snapshot(), before, "TARGET_CHANGED")
  same(await route(), routeBefore, "ROUTE_CHANGED")
  same(await guard(), guardBefore, "GUARD_CHANGED")
  same(await attest(), definitions, "API_CHANGED")
  return {
    ...input,
    client,
    system: "GR2",
    user,
    readOnly: true,
    executable: false,
    activationAvailable: false,
    simulation: false,
    methodExecutionAvailable: false,
    snapshot: false,
    versionOrigin: "sap_sha256_native_data_buffer",
    versions: {
      source: input.nativeSourceVersion,
      target: input.nativeTargetVersion,
      candidate: input.nativeCandidateVersion,
      metadata: input.nativeMetadataVersion,
      guard: input.nativeGuardVersion
    },
    scope: {
      object: "CUNI",
      tableCount: 9,
      keyCount: 19,
      candidateKeys: 11,
      protectionKeys: 8,
      allCuniKeys: false
    },
    policy: preview.policy,
    clientMapping: preview.clientMapping,
    languagePolicy: preview.languagePolicy,
    rows,
    apiIdentities: definitions,
    evidence: {
      readerInvocations: { snapshot: 2, preview: 1, route: 2, guard: 2 },
      apiIdentityReads: 8,
      native: { before, candidate: preview.native, route: routeBefore, guard: guardBefore }
    },
    blockers: [
      "ACTIVATION_COMMAND_NOT_IMPLEMENTED",
      "STANDARD_CHAIN_AND_COMMIT_DEPENDENCIES_NOT_ATTESTED",
      "BUSINESS_WRITE_APPROVAL_REQUIRED",
      "CUSTOMIZING_TASK_AND_RECOVERY_NOT_BOUND"
    ],
    warning:
      "Nineteen fixed keys only. Sequential repeated observations are not a locked snapshot. Candidate USE/client/language choices are hypothetical, not activation approval. Full SAP native versions bind typed fields; display strings cannot reproduce their precision. Missing protection rows remain missing. No activation, simulation, GUI, methods, configuration/CTS/log writes, commit or recovery is called."
  }
}
