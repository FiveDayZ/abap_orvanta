import type { SapBackend } from "./backend.js"
import { ALLOWLIST_MAX_ROWS } from "./table-allowlist.js"
import {
  createReviewedTableReader,
  type ReviewedReaderSource,
  type ReviewedRow
} from "./reviewed-table-reader.js"

/**
 * Role to authorization-object resolution, from the tables the operator approved on 2026-09-28:
 * `AGR_1251` (the authorization objects, fields, LOW/HIGH values and stored flags a role grants),
 * `AGR_1252` (the organization-level values of that role, keyed by the variable name `VARBL`) and
 * `AGR_PROF` (the profile names a role generates, one row per language). Optionally the profile path
 * is expanded with `UST10S` (profile to authorization object and authorization name) and `UST10C`
 * (profile to subprofile), both keyed by the profile name rather than by the role.
 *
 * This tool reports **what is stored**, and that is the whole claim: it is not an authorization check,
 * it never says that a user is or is not authorized, it does not decide whether a role assignment is
 * active today, and it does not read a trace. `read_user_authorizations` in this same family reports
 * the assignment master data (which user holds which role, which transactions a role holds, which
 * profiles a user master record holds) and deliberately does not resolve the role side; this tool does
 * that and only that, so a caller wanting both reads both.
 *
 * Field selection comes from the DD03L evidence of w200 (2026-09-28 probes, re-read 2026-09-30):
 * AGR_1251 14 real fields (165 characters plus two `.INCLUDE` markers DD03L also reports),
 * AGR_1252 7 fields (159), AGR_PROF 5 fields (106), UST10S 5 fields (38), UST10C 4 fields (28) - every
 * one of them far below the 512-character row the reviewed reader can carry, so no table needs the
 * chunk-and-join treatment and no field of these tables is left out.
 *
 * Two deliberate limits, both stated in the answer:
 *
 * - `USOBT`/`USOBT_C` and `USOBX`/`USOBX_C` are not read here. They are the profile generator's
 *   customizing: which authorization object a **transaction** checks (`NAME` holds a transaction or
 *   report name such as `/ASU/MAINTAIN`, not a role) and which default values it proposes. Resolving
 *   them for one role would be one read per transaction of that role, which is a
 *   transaction-oriented question, not role resolution.
 * - This tool cannot prove that a role exists. `AGR_DEFINE` (the role definition itself) is not
 *   registered for reading, so a role name with no stored values answers with empty lists and says
 *   that it is empty rather than absent.
 *
 * Read path: the shared reviewed reader - native data preview first, then the fingerprint-checked
 * `RFC_READ_TABLE` implementation only when the platform answers the observed empty HTML document.
 * No generic SQL fallback, no writes.
 */

export const ROLE_AUTHORIZATIONS_DEFAULT_ROWS = 200
/** The role name is the widest filter this tool sends: AGR_NAME is CHAR 30 in every table it reads. */
export const ROLE_AUTHORIZATIONS_FILTER_LIMIT = 30

const TABLES = {
  AGR_1251: [
    "MANDT",
    "AGR_NAME",
    "COUNTER",
    "OBJECT",
    "FIELD",
    "LOW",
    "HIGH",
    "DELETED",
    "MODIFIED",
    "COPIED",
    "NEU",
    "AUTH",
    "VARIANT",
    "NODE"
  ],
  AGR_1252: ["MANDT", "AGR_NAME", "COUNTER", "VARBL", "LOW", "HIGH"],
  AGR_PROF: ["MANDT", "AGR_NAME", "LANGU", "PROFILE", "PTEXT"],
  UST10S: ["MANDT", "PROFN", "OBJCT", "AUTH", "AKTPS"],
  UST10C: ["MANDT", "PROFN", "SUBPROF", "AKTPS"]
} as const
type Table = keyof typeof TABLES

function roleAuthorizationFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : ""
  if (text.startsWith("SAP_DATA_QUERY_RESPONSE_INVALID:")) return "SAP_DATA_QUERY_RESPONSE_INVALID"
  switch (text) {
    case "ROLE_AUTHORIZATIONS_SCOPE_INVALID":
    case "ROLE_AUTHORIZATIONS_FALLBACK_UNVERIFIED":
    case "ROLE_AUTHORIZATIONS_NOT_AUTHORIZED":
    case "ROLE_AUTHORIZATIONS_RFC_FAILED":
    case "ROLE_AUTHORIZATIONS_RESPONSE_INVALID":
    case "ROLE_AUTHORIZATIONS_RESPONSE_SCOPE_MISMATCH":
    case "ROLE_AUTHORIZATIONS_AMBIGUOUS_RESULT":
      return text
    default:
      return "ROLE_AUTHORIZATIONS_QUERY_FAILED"
  }
}

export type RoleAuthorizationsOptions = {
  roleName: string
  includeProfileObjects?: boolean | undefined
  maxRows?: number | undefined
}

export async function collectRoleAuthorizations(
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  connectionId: string,
  options: RoleAuthorizationsOptions,
  readDefinition: () => Promise<unknown>
) {
  const requested = Math.floor(options.maxRows ?? ROLE_AUTHORIZATIONS_DEFAULT_ROWS)
  if (!Number.isFinite(requested) || requested < 1) {
    throw new Error("ROLE_AUTHORIZATIONS_ROW_LIMIT_INVALID")
  }
  // Refused before SAP is touched: an empty name would be sent as `AGR_NAME = ''` and would answer
  // with an empty list that looks like "the role grants nothing" rather than "no name was given".
  const roleName = options.roleName
  if (roleName.trim().length === 0 || roleName.length > ROLE_AUTHORIZATIONS_FILTER_LIMIT) {
    throw new Error("ROLE_AUTHORIZATIONS_SCOPE_INVALID")
  }
  const maximum = Math.min(requested, ALLOWLIST_MAX_ROWS)
  const sources: ReviewedReaderSource[] = []
  const queryWarnings: string[] = []
  const readTable = createReviewedTableReader(
    backend,
    connectionId,
    readDefinition,
    sources,
    queryWarnings
  )
  const read = async (table: Table, filters: ReviewedRow) => {
    for (const value of Object.values(filters)) {
      if (value.length > ROLE_AUTHORIZATIONS_FILTER_LIMIT) {
        throw new Error("ROLE_AUTHORIZATIONS_SCOPE_INVALID")
      }
    }
    const sourceIndex = sources.length
    const rows = await readTable({
      table,
      fields: TABLES[table],
      filters,
      maximum,
      filterLengthLimit: ROLE_AUTHORIZATIONS_FILTER_LIMIT,
      codePrefix: "ROLE_AUTHORIZATIONS_",
      mapError: roleAuthorizationFailure
    })
    return { rows, source: sources[sourceIndex]! }
  }

  // One condition per call is all the reviewed reader supports, and the role name is the key of all
  // three role-side tables, so each of them needs its own call.
  const roleFilter: ReviewedRow = { AGR_NAME: roleName }
  const valuesRead = await read("AGR_1251", roleFilter)
  const levelsRead = await read("AGR_1252", roleFilter)
  const profilesRead = await read("AGR_PROF", roleFilter)

  const profiles = (profilesRead.rows ?? []).map((row) => ({
    language: row.LANGU!,
    profile: row.PROFILE!,
    text: row.PTEXT!
  }))
  // The profile path is keyed by the profile name, so it is one pair of reads per distinct profile
  // (AGR_PROF stores one row per language, which must not multiply the reads).
  const distinctProfiles = [...new Set(profiles.map((row) => row.profile).filter((name) => name))]

  // Read one profile after another rather than in parallel: the reads share one connection and one
  // source list, and a caller reading the answer sees them in the role's own profile order.
  const includeProfileObjects = options.includeProfileObjects ?? false
  const profileObjects: {
    profile: string
    objects: { authorizationObject: string; authorizationName: string; status: string }[]
    subprofiles: { subprofile: string; status: string }[]
    truncated: { objects: boolean; subprofiles: boolean }
  }[] = []
  if (includeProfileObjects) {
    for (const profile of distinctProfiles) {
      const objects = await read("UST10S", { PROFN: profile })
      const subprofiles = await read("UST10C", { PROFN: profile })
      profileObjects.push({
        profile,
        objects: (objects.rows ?? []).map((row) => ({
          authorizationObject: row.OBJCT!,
          authorizationName: row.AUTH!,
          status: row.AKTPS!
        })),
        subprofiles: (subprofiles.rows ?? []).map((row) => ({
          subprofile: row.SUBPROF!,
          status: row.AKTPS!
        })),
        truncated: {
          objects: objects.source.status === "truncated",
          subprofiles: subprofiles.source.status === "truncated"
        }
      })
    }
  }

  // The resolution proper: one entry per authorization object, one entry per field, and the stored
  // values in the order SAP returned them. Grouping happens here rather than in the answer's reader so
  // that a caller can see how many rows the field really carries.
  const objects = new Map<string, Map<string, Record<string, string>[]>>()
  for (const row of valuesRead.rows ?? []) {
    const object = row.OBJECT!
    const field = row.FIELD!
    if (!objects.has(object)) objects.set(object, new Map())
    const fields = objects.get(object)!
    if (!fields.has(field)) fields.set(field, [])
    fields.get(field)!.push({
      low: row.LOW!,
      high: row.HIGH!,
      counter: row.COUNTER!,
      deleted: row.DELETED!,
      modified: row.MODIFIED!,
      copied: row.COPIED!,
      new: row.NEU!,
      authorizationName: row.AUTH!,
      variant: row.VARIANT!,
      node: row.NODE!
    })
  }
  const authorizationObjects = [...objects].map(([object, fields]) => ({
    object,
    fields: [...fields].map(([field, values]) => ({ field, values }))
  }))
  const authorizationValues = authorizationObjects.reduce(
    (total, entry) => total + entry.fields.reduce((sum, field) => sum + field.values.length, 0),
    0
  )
  const organizationLevels = (levelsRead.rows ?? []).map((row) => ({
    variable: row.VARBL!,
    low: row.LOW!,
    high: row.HIGH!,
    counter: row.COUNTER!
  }))

  const failed = sources.filter(
    (item) => item.status === "unavailable" || item.status === "invalid"
  )
  const truncatedSources = sources.filter((item) => item.status === "truncated")
  const status =
    failed.length === sources.length
      ? "unavailable"
      : failed.length || truncatedSources.length
        ? "partial"
        : "ok"
  const truncated = (source: ReviewedReaderSource) => source.status === "truncated"
  return {
    status,
    connectionId,
    readOnly: true,
    notAnAuthorizationCheck: true,
    filters: { roleName, includeProfileObjects },
    rowLimit: maximum,
    rowLimitRequested: requested,
    rowLimitApplied: requested > ALLOWLIST_MAX_ROWS,
    filterValueLimit: ROLE_AUTHORIZATIONS_FILTER_LIMIT,
    authorizationObjects,
    organizationLevels,
    profiles,
    profileObjects: includeProfileObjects ? profileObjects : null,
    counts: {
      authorizationObjects: authorizationObjects.length,
      authorizationFields: authorizationObjects.reduce(
        (total, entry) => total + entry.fields.length,
        0
      ),
      authorizationValues,
      organizationLevels: organizationLevels.length,
      profiles: profiles.length,
      profileObjects: profileObjects.reduce((total, entry) => total + entry.objects.length, 0),
      profileSubprofiles: profileObjects.reduce(
        (total, entry) => total + entry.subprofiles.length,
        0
      )
    },
    truncated: {
      authorizationValues: truncated(valuesRead.source),
      organizationLevels: truncated(levelsRead.source),
      profiles: truncated(profilesRead.source),
      profileObjects: profileObjects.some(
        (entry) => entry.truncated.objects || entry.truncated.subprofiles
      )
    },
    notes: [
      "this is stored authorization master data, not an authorization check: the tool never states " +
        "that a user is or is not authorized, and it does not decide whether the role assignment is " +
        "valid today (AGR_USERS owns the validity window, read by read_user_authorizations).",
      "objects, fields, LOW/HIGH, VARBL and the profile names are returned as stored and are never " +
        "interpreted: '*' stays a wildcard, and DELETED, MODIFIED, COPIED, NEU and the profile status " +
        "AKTPS are stored flags reported verbatim rather than evaluated.",
      "USOBT/USOBT_C and USOBX/USOBX_C are deliberately not read: their NAME holds a transaction " +
        "name rather than a role, so resolving them is one read per transaction and answers a " +
        "transaction-oriented question instead of role resolution.",
      "an empty answer means no stored authorization value was found for that role name; AGR_DEFINE " +
        "is not registered for reading, so this tool cannot prove that a role does not exist.",
      includeProfileObjects
        ? "profileObjects names the authorization objects and subprofiles each profile of AGR_PROF " +
          "carries; it is the profile's object list (UST10S/UST10C), not its field values - those " +
          "are the AGR_1251 values above."
        : "the profile path (UST10S/UST10C) was not read: pass includeProfileObjects to expand " +
          "AGR_PROF's profiles into the authorization objects and subprofiles they carry."
    ],
    sources,
    queryTimestamp: new Date().toISOString(),
    queryWarnings
  }
}
