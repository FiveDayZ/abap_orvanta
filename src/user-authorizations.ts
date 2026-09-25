import type { SapBackend } from "./backend.js"
import { ALLOWLIST_MAX_ROWS } from "./table-allowlist.js"
import {
  createReviewedTableReader,
  type ReviewedReaderSource,
  type ReviewedRow
} from "./reviewed-table-reader.js"

/**
 * Role, transaction and profile assignments, read from the three tables the operator approved on
 * 2026-09-25: `AGR_USERS` (role assignments per user), `AGR_TCODES` (transactions of a role) and
 * `UST04` (profile assignments of a user master record).
 *
 * This tool reports stored master data. It is **not** an authorization check: it never says that a
 * user is or is not authorized for something, and it does not resolve a role into its authorization
 * objects - `AGR_1251`, `AGR_1252`, `AGR_PROF`, `USOB*` and `UST10*` are not on the approved
 * allowlist, and an actual trace (SU53 / ST01) is the SAP-side helper's job. The stored flags
 * (`EXCLUDE`, `ORG_FLAG`, `COL_FLAG`, `DIRECT`, `INHERITED`) and the validity window
 * (`FROM_DAT` / `TO_DAT`) are returned verbatim; the tool never decides whether an assignment is
 * active today.
 *
 * Field selection comes from the DD03L evidence of w200: AGR_USERS 11 fields (93 characters),
 * AGR_TCODES 8 fields (91) and UST04 3 fields (27) - all far below the 512-character row the
 * reviewed reader can carry. Note that `UST04` holds only a user name and a profile name; the
 * password-bearing user master tables (`USR02`, `USR01`) are permanently forbidden.
 *
 * Read path: the shared reviewed reader - native data preview first, then the fingerprint-checked
 * `RFC_READ_TABLE` implementation only when the platform answers the observed empty HTML document.
 * No generic SQL fallback, no writes.
 */

export const USER_AUTHORIZATIONS_DEFAULT_ROWS = 200
/** Longest filter value: the role name is the widest of the three approved keys. */
export const USER_AUTHORIZATIONS_FILTER_LIMIT = 30

const TABLES = {
  AGR_USERS: [
    "MANDT",
    "AGR_NAME",
    "UNAME",
    "FROM_DAT",
    "TO_DAT",
    "EXCLUDE",
    "CHANGE_DAT",
    "CHANGE_TIM",
    "CHANGE_TST",
    "ORG_FLAG",
    "COL_FLAG"
  ],
  AGR_TCODES: ["MANDT", "AGR_NAME", "TYPE", "TCODE", "EXCLUDE", "DIRECT", "INHERITED", "FOLDER"],
  UST04: ["MANDT", "BNAME", "PROFILE"]
} as const
type Table = keyof typeof TABLES

function authorizationFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : ""
  if (text.startsWith("SAP_DATA_QUERY_RESPONSE_INVALID:")) return "SAP_DATA_QUERY_RESPONSE_INVALID"
  switch (text) {
    case "USER_AUTHORIZATIONS_SCOPE_INVALID":
    case "USER_AUTHORIZATIONS_FALLBACK_UNVERIFIED":
    case "USER_AUTHORIZATIONS_NOT_AUTHORIZED":
    case "USER_AUTHORIZATIONS_RFC_FAILED":
    case "USER_AUTHORIZATIONS_RESPONSE_INVALID":
    case "USER_AUTHORIZATIONS_RESPONSE_SCOPE_MISMATCH":
    case "USER_AUTHORIZATIONS_AMBIGUOUS_RESULT":
      return text
    default:
      return "USER_AUTHORIZATIONS_QUERY_FAILED"
  }
}

export type UserAuthorizationsOptions = {
  userName?: string | undefined
  roleName?: string | undefined
  profileName?: string | undefined
  includeRoleTransactions?: boolean | undefined
  includeProfiles?: boolean | undefined
  maxRows?: number | undefined
}

export async function collectUserAuthorizations(
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">,
  connectionId: string,
  options: UserAuthorizationsOptions,
  readDefinition: () => Promise<unknown>
) {
  const requested = Math.floor(options.maxRows ?? USER_AUTHORIZATIONS_DEFAULT_ROWS)
  if (!Number.isFinite(requested) || requested < 1) {
    throw new Error("USER_AUTHORIZATIONS_ROW_LIMIT_INVALID")
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
  const read = (table: Table, filters: ReviewedRow) => {
    for (const value of Object.values(filters)) {
      if (value.length > USER_AUTHORIZATIONS_FILTER_LIMIT) {
        throw new Error("USER_AUTHORIZATIONS_SCOPE_INVALID")
      }
    }
    return readTable({
      table,
      fields: TABLES[table],
      filters,
      maximum,
      filterLengthLimit: USER_AUTHORIZATIONS_FILTER_LIMIT,
      codePrefix: "USER_AUTHORIZATIONS_",
      mapError: authorizationFailure
    })
  }

  // One condition per call is all the reviewed reader supports, so the assignment read prefers the
  // user filter, then the role filter, and the two dependent tables keep their own single condition.
  const assignmentFilters: ReviewedRow = {}
  if (options.userName) assignmentFilters.UNAME = options.userName
  else if (options.roleName) assignmentFilters.AGR_NAME = options.roleName
  const assignmentRows = await read("AGR_USERS", assignmentFilters)

  const includeRoleTransactions = options.includeRoleTransactions ?? Boolean(options.roleName)
  const transactionFilters: ReviewedRow = options.roleName ? { AGR_NAME: options.roleName } : {}
  const transactionRows = includeRoleTransactions
    ? await read("AGR_TCODES", transactionFilters)
    : null

  const includeProfiles =
    options.includeProfiles ?? Boolean(options.userName || options.profileName)
  const profileFilters: ReviewedRow = options.profileName
    ? { PROFILE: options.profileName }
    : options.userName
      ? { BNAME: options.userName }
      : {}
  const profileRows = includeProfiles ? await read("UST04", profileFilters) : null

  const roleAssignments = (assignmentRows ?? []).map((row) => ({
    roleName: row.AGR_NAME!,
    userName: row.UNAME!,
    validFrom: row.FROM_DAT!,
    validTo: row.TO_DAT!,
    excluded: row.EXCLUDE!,
    changedOn: row.CHANGE_DAT!,
    changedAt: row.CHANGE_TIM!,
    changedAtTimestamp: row.CHANGE_TST!,
    organizationalFlag: row.ORG_FLAG!,
    collectiveFlag: row.COL_FLAG!
  }))
  const roleTransactions = (transactionRows ?? []).map((row) => ({
    roleName: row.AGR_NAME!,
    nodeType: row.TYPE!,
    transactionCode: row.TCODE!,
    excluded: row.EXCLUDE!,
    direct: row.DIRECT!,
    inherited: row.INHERITED!,
    folder: row.FOLDER!
  }))
  const profiles = (profileRows ?? []).map((row) => ({
    userName: row.BNAME!,
    profile: row.PROFILE!
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
  return {
    status,
    connectionId,
    readOnly: true,
    notAnAuthorizationCheck: true,
    filters: {
      userName: options.userName ?? null,
      roleName: options.roleName ?? null,
      profileName: options.profileName ?? null,
      includeRoleTransactions,
      includeProfiles
    },
    rowLimit: maximum,
    rowLimitRequested: requested,
    rowLimitApplied: requested > ALLOWLIST_MAX_ROWS,
    filterValueLimit: USER_AUTHORIZATIONS_FILTER_LIMIT,
    roleAssignments,
    roleTransactions,
    profiles,
    counts: {
      roleAssignments: roleAssignments.length,
      roleTransactions: roleTransactions.length,
      profiles: profiles.length
    },
    truncated: {
      roleAssignments: sources.find((item) => item.table === "AGR_USERS")?.status === "truncated",
      roleTransactions: sources.find((item) => item.table === "AGR_TCODES")?.status === "truncated",
      profiles: sources.find((item) => item.table === "UST04")?.status === "truncated"
    },
    notes: [
      "this is assignment master data, not an authorization check: the tool never states that a user " +
        "is or is not authorized, and it does not resolve a role into its authorization objects " +
        "(AGR_1251/AGR_1252/AGR_PROF/USOB*/UST10* are not on the approved allowlist; an actual trace " +
        "is the SU53/ST01 path on the SAP-side helper).",
      "EXCLUDE, ORG_FLAG, COL_FLAG, DIRECT and INHERITED are stored flags reported verbatim, and " +
        "TYPE is the stored node type; none of them is interpreted here.",
      "FROM_DAT and TO_DAT are the validity window stored in AGR_USERS, returned as stored - the " +
        "tool does not decide whether an assignment is active today.",
      "UST04 holds only the user name and the profile name of a user master record; the password-" +
        "bearing tables USR02 and USR01 are permanently forbidden and are never read.",
      includeRoleTransactions
        ? "AGR_TCODES was read"
        : "AGR_TCODES was not read: pass roleName (exact) or includeRoleTransactions to read a role's " +
          "transactions, because the reviewed reader supports one condition per call.",
      includeProfiles
        ? "UST04 was read"
        : "UST04 was not read: pass userName or profileName, or set includeProfiles, to read profile " +
          "assignments."
    ],
    sources,
    queryTimestamp: new Date().toISOString(),
    queryWarnings
  }
}
