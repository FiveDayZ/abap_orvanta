/**
 * One vocabulary for ABAP object types.
 *
 * The repository search (ADT quick search) takes short codes — `FUNC`, `PROG`, `CLAS`, `TABL`,
 * `FUGR`, … — while everything this service *returns* uses the ADT type path: the object list prints
 * `ZPMC_FM_TP_STOCK_CALC (FUGR/FF)`, every `adt://` URI and every write tool speaks `FUGR/FF` /
 * `PROG/P` / `CLAS/OC`. A caller that feeds a returned type back into a tool therefore hands the
 * search a path it cannot use.
 *
 * That is not a lookup failure, and it must never be reported as one. `searchObjects` skips a type
 * the target system cannot search (a per-type `catch`), so an unusable token yields an empty result
 * set, and callers turned that emptiness into a false absence claim. Verified on w200 at
 * 2026-09-25T00:37: `get_version_history` with `objectType: "FUGR/FF"` answered
 * "Could not find ABAP object: ZPMC_FM_TP_STOCK_CALC. Please check the object name and ensure it
 * exists.", while the identical call with `FUNC` returned that function module with type `FUGR/FF`
 * and version 1. The object never stopped existing; only the vocabulary differed.
 *
 * `searchTypeCode` is the single translation point: callers normalize the caller-supplied token
 * before searching, and a path-shaped token that is not a known alias is rejected loudly instead of
 * being laundered into "not found".
 */
import { DEFAULT_OBJECT_TYPES } from "./backend.js"

/** Historical aliases of a function module, as the write and workspace-URI paths already accept. */
export const FUNCTION_MODULE_TYPE_TOKENS: readonly string[] = ["FUGR/FF", "FUNC/FM", "FUNC"]

/**
 * ADT type path (or historical alias) -> the repository search code that finds that object kind.
 *
 * Every key is a token this service itself accepts elsewhere or prints in its own results, so a
 * caller can always pass back what it was given. `FUGR/I` is the function-group include, which the
 * repository search reaches as a program include.
 */
const SEARCH_TYPE_BY_ALIAS: Readonly<Record<string, string>> = {
  "FUNC/FM": "FUNC",
  "FUGR/FF": "FUNC",
  "CLAS/OC": "CLAS",
  "INTF/OI": "INTF",
  "PROG/P": "PROG",
  "PROG/I": "PROG",
  "FUGR/I": "PROG",
  "FUGR/F": "FUGR",
  "TABL/DT": "TABL",
  "TABL/DS": "TABL"
}

/** Every type token a search accepts: the search codes first, then the ADT paths of this release. */
export const SEARCHABLE_OBJECT_TYPE_TOKENS: readonly string[] = [
  ...DEFAULT_OBJECT_TYPES,
  ...Object.keys(SEARCH_TYPE_BY_ALIAS)
]

/**
 * Translate one caller-supplied object type to the code the repository search understands.
 *
 * A token that contains `/` is an ADT type path: it can never be a search code, so an unknown one is
 * a caller mistake or a type this release cannot search, and searching it would fabricate a "not
 * found". Anything else passes through unchanged, because a short code this release does not list is
 * still the caller's statement about the object and the search itself decides what it can answer.
 */
export function searchTypeCode(objectType: string): string {
  const token = objectType.trim().toUpperCase()
  const alias = SEARCH_TYPE_BY_ALIAS[token]
  if (alias) return alias
  if (token.includes("/")) {
    throw new Error(
      `UNSUPPORTED_OBJECT_TYPE: ${objectType} is not an object type this service can search, so ` +
        `searching it would report "not found" for an object that may exist. Pass a repository ` +
        `search code (${DEFAULT_OBJECT_TYPES.join(", ")}) or one of the ADT paths the search ` +
        `accepts (${Object.keys(SEARCH_TYPE_BY_ALIAS).join(", ")}).`
    )
  }
  return token
}

/** Translate a list of caller-supplied types, keeping the caller's order and dropping duplicates. */
export function searchTypeCodes(objectTypes: readonly string[]): string[] {
  return [...new Set(objectTypes.map((objectType) => searchTypeCode(objectType)))]
}

/** True when the token names a function module in any vocabulary the service accepts. */
export function isFunctionModuleType(objectType: string): boolean {
  return FUNCTION_MODULE_TYPE_TOKENS.includes(objectType.trim().toUpperCase())
}

/**
 * Which search code an ADT type path belongs to, without throwing.
 *
 * This is the reverse direction of `searchTypeCode`, for code that holds a type *reported by SAP*
 * (a search row, a URI) rather than a caller-supplied token, and must classify it instead of
 * rejecting the caller. The parent segment is the code for every family except function modules,
 * whose path is `FUGR/FF` while the search code is `FUNC`. Returns `undefined` for a path this
 * release has no search code for, so a caller can decide what that means instead of guessing.
 */
export function searchCodeOfAdtType(adtType: string): string | undefined {
  const token = adtType.trim().toUpperCase()
  const aliased = SEARCH_TYPE_BY_ALIAS[token]
  if (aliased) return aliased
  const [parent, child] = token.split("/")
  if (!child) return isSearchTypeCode(token) ? token : undefined
  return isSearchTypeCode(parent!) ? parent : undefined
}

/** True when the token is a repository search code of this release. */
export function isSearchTypeCode(token: string): boolean {
  return (DEFAULT_OBJECT_TYPES as readonly string[]).includes(token.trim().toUpperCase())
}
