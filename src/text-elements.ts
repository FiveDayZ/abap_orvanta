import type { TextElementInfo } from "./backend.js"

/**
 * The two text pool entry kinds this service maintains.
 *
 * SAP keeps both kinds in one text pool and tells them apart by row ID: `I` rows are text symbols
 * whose KEY is exactly three characters, `S` rows are selection texts whose KEY is the name of a
 * selection screen element (PARAMETER, SELECT-OPTION, RADIOBUTTON), which is one to eight
 * characters. A selection screen label lives in the `S` row, so the symbol route cannot carry one:
 * the three-character symbol rule rejects every parameter name, which is why a caller could read
 * `I` rows only and any attempt to write `P_WERKS` came back as a rejected text symbol.
 */
export type TextElementIdType = "SYMBOL" | "SELECTION"

export interface NormalizedTextElement {
  idType: TextElementIdType
  id: string
  text: string
  maxLength: number
}

export const TEXT_ELEMENT_ID_TYPES: readonly TextElementIdType[] = ["SYMBOL", "SELECTION"]
export const DEFAULT_TEXT_ELEMENT_ID_TYPE: TextElementIdType = "SYMBOL"

/** The `TEXTPOOL-ID` each kind is stored under. */
const TEXT_POOL_IDS: Record<TextElementIdType, string> = { SYMBOL: "I", SELECTION: "S" }

/**
 * Selection texts are served by the ADT text element service with a 30-character limit (the
 * library's own `validateTextElements` refuses more), while a symbol entry carries up to 255. Both
 * routes must publish the same limit, so the stricter one wins: the repository helper writes the
 * text pool directly and could store more, but then the same entry would be unreadable through ADT
 * and SE38.
 */
const TEXT_LIMITS: Record<TextElementIdType, number> = { SYMBOL: 255, SELECTION: 30 }

const ID_PATTERNS: Record<TextElementIdType, RegExp> = {
  SYMBOL: /^[A-Z0-9_]{3}$/,
  SELECTION: /^[A-Z0-9_]{1,8}$/
}

const ID_RULES: Record<TextElementIdType, string> = {
  SYMBOL: "must contain exactly 3 characters",
  SELECTION: "must contain 1-8 valid selection screen element characters"
}

export function isTextElementIdType(value: unknown): value is TextElementIdType {
  return value === "SYMBOL" || value === "SELECTION"
}

/**
 * Normalize the entry kind. Absent means `SYMBOL`, so every caller written before selection texts
 * existed keeps its meaning.
 */
export function textElementIdType(value: unknown): TextElementIdType {
  if (value === undefined || value === null || value === "") return DEFAULT_TEXT_ELEMENT_ID_TYPE
  if (typeof value !== "string") throw new Error(`Invalid text element idType: ${String(value)}`)
  const normalized = value.trim().toUpperCase()
  if (isTextElementIdType(normalized)) return normalized
  throw new Error(
    `Invalid text element idType ${value}; expected ${TEXT_ELEMENT_ID_TYPES.join(" or ")}`
  )
}

/** The text pool row ID a kind is stored under (`TEXTPOOL-ID`). */
export function textPoolId(idType: TextElementIdType): string {
  return TEXT_POOL_IDS[idType]
}

/** The ADT text element category that serves a kind. */
export function textElementCategory(idType: TextElementIdType): "symbols" | "selections" {
  return idType === "SELECTION" ? "selections" : "symbols"
}

/**
 * Read the kind back from what SAP sent.
 *
 * The repository helper publishes the pool row ID it read (`I`/`S`); an older helper publishes
 * nothing, and then the entry is a symbol, because that is all such a helper ever addressed.
 */
export function textElementIdTypeFromPoolId(value: unknown): TextElementIdType {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase()
  if (normalized === "" || normalized === "I" || normalized === "SYMBOL") return "SYMBOL"
  if (normalized === "S" || normalized === "SELECTION") return "SELECTION"
  throw new Error(`SAP returned an unknown text element type: ${String(value)}`)
}

/**
 * Identity of a text pool entry. Symbols and selection texts share one namespace of keys in the
 * pool but are different entries, so every merge, verification and duplicate check keys on the
 * pair rather than on the key alone: `SRC` may legitimately exist as both a symbol and a selection
 * text, and collapsing them would let one silently overwrite the other.
 */
export function textElementKey(element: {
  id: string
  idType?: TextElementIdType | undefined
}): string {
  return `${textElementIdType(element.idType)}:${element.id.trim().toUpperCase()}`
}

export function normalizeTextElementId(idType: TextElementIdType, value: string): string {
  const id = value.trim().toUpperCase()
  if (!ID_PATTERNS[idType].test(id)) {
    throw new Error(`Text ${idType.toLowerCase()} ID ${value} ${ID_RULES[idType]}`)
  }
  return id
}

/**
 * The single validation rule for every text element write, shared by the tool contract path and the
 * ADT path. A caller-supplied `maxLength` describes a symbol's declared length; a selection text
 * has no declared length, so it is refused there instead of being silently reinterpreted.
 */
export function normalizeTextElements(elements: TextElementInfo[]): NormalizedTextElement[] {
  if (!elements.length) throw new Error("textElements is required for create/update actions")
  const keys = new Set<string>()
  return elements.map((element) => {
    const idType = textElementIdType(element.idType)
    const id = normalizeTextElementId(idType, element.id)
    const key = `${idType}:${id}`
    if (keys.has(key)) throw new Error(`Duplicate text element: ${idType} ${id}`)
    keys.add(key)
    const limit = TEXT_LIMITS[idType]
    if (!element.text || element.text.length > limit) {
      throw new Error(`Text element ${idType} ${id} must contain 1-${limit} characters`)
    }
    if (idType === "SELECTION") {
      if (element.maxLength !== undefined && element.maxLength !== element.text.length) {
        throw new Error(
          `Text element SELECTION ${id} has no declared length; omit maxLength or set it to ${element.text.length}`
        )
      }
      return { idType, id, text: element.text, maxLength: element.text.length }
    }
    const maxLength = element.maxLength ?? Math.max(10, element.text.length)
    if (maxLength < element.text.length || maxLength > limit) {
      throw new Error(`Invalid maxLength for ${id}: expected ${element.text.length}-${limit}`)
    }
    return { idType, id, text: element.text, maxLength }
  })
}

/**
 * Merge requested entries into the existing pool for one action.
 *
 * `create` refuses an existing entry and `update` refuses a missing one, both by (kind, key): a
 * selection text that does not exist yet cannot be updated, and an unrelated symbol with the same
 * three characters must not be mistaken for it.
 */
export function mergeTextElementChanges(
  existing: TextElementInfo[],
  requested: TextElementInfo[],
  action: "create" | "update"
): NormalizedTextElement[] {
  const normalized = normalizeTextElements(requested)
  const byKey = new Map(
    normalizeExistingTextElements(existing).map((element) => [
      `${element.idType}:${element.id}`,
      element
    ])
  )
  for (const element of normalized) {
    const key = `${element.idType}:${element.id}`
    const exists = byKey.has(key)
    if (action === "create" && exists) {
      throw new Error(
        `Text element ${element.idType} ${element.id} already exists; use action=update`
      )
    }
    if (action === "update" && !exists) {
      throw new Error(
        `Text element ${element.idType} ${element.id} does not exist; use action=create`
      )
    }
    byKey.set(key, element)
  }
  return [...byKey.values()].sort(
    (left, right) => left.idType.localeCompare(right.idType) || left.id.localeCompare(right.id)
  )
}

/**
 * Normalize entries that came back from SAP.
 *
 * A read may legitimately omit the kind on entries written before this distinction existed, and the
 * text pool always carries it, so an absent kind means `SYMBOL`. Entries SAP returned without a key
 * are dropped rather than merged under an empty key.
 */
export function normalizeExistingTextElements(
  elements: TextElementInfo[]
): NormalizedTextElement[] {
  return elements
    .filter((element) => element.id.trim().length > 0)
    .map((element) => {
      const idType = textElementIdType(element.idType)
      const id = element.id.trim().toUpperCase()
      const limit = TEXT_LIMITS[idType]
      return {
        idType,
        id,
        text: element.text,
        maxLength:
          element.maxLength === undefined
            ? Math.max(10, Math.min(element.text.length, limit))
            : element.maxLength
      }
    })
}
