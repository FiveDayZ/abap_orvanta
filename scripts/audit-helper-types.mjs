import { readFileSync } from "node:fs"

/**
 * Pre-F8 type audit for the repository helper body.
 *
 * The 2026-09-29 F8 failed with:
 *   "LV_TR_RELEASE_SUBRC" must be a character-type data object (C, N, D, T or STRING)
 * at body line 6663, because `CONCATENATE ... lv_tr_release_subrc INTO ...` put an INT4 where ABAP
 * requires a character operand. The module was left without a body as a result.
 *
 * This audit resolves every variable used inside a CONCATENATE statement to the TYPE declared for it
 * in the body's own declaration block, and fails when that type is numeric. Only the declarations of
 * this body are consulted, so a same-named variable in another include cannot cause a false verdict.
 *
 * It also checks that every lv_/ls_/lt_ name referenced by the body has a declaration, which catches
 * the opposite mistake (a name that only exists in the author's head).
 *
 * Usage: node scripts/audit-helper-types.mjs [canonical.json]
 */
const canonicalPath =
  process.argv[2] && !process.argv[2].startsWith("--")
    ? process.argv[2]
    : ".cache/repository-z_orvanta_mcp_dynpro_api-canonical.json"
const canonical = JSON.parse(readFileSync(canonicalPath, "utf8"))
const lines = canonical.lines

// Declarations come in several shapes the payload actually uses, so this mirrors the proven
// collector in .cache/check-undeclared.mjs rather than a single-line regex:
//   DATA x TYPE t.        DATA: a TYPE t,        DATA: BEGIN OF ls_x,
//   TYPES: BEGIN OF ty_x, FIELD-SYMBOLS <fs>, CONSTANTS c_x TYPE t, STATICS s_x TYPE t.
// A single-line regex missed the continuation rows and reported 23 false "undeclared" names.
const declared = new Map()
const declaredNames = new Set()
for (const raw of lines) {
  const trimmed = raw.trim()
  const decl = /^\s*(DATA|STATICS|FIELD-SYMBOLS|CONSTANTS|TYPES|CLASS-DATA)\s*:?\s*(.*)$/i.exec(raw)
  if (!decl) continue
  const beginOf = /\bBEGIN\s+OF\s+([A-Za-z0-9_]+)/i.exec(decl[2])
  if (beginOf) declaredNames.add(beginOf[1].toLowerCase())
  for (const item of decl[2].split(/,\s*(?=[A-Za-z_<])/)) {
    const name = /^([A-Za-z0-9_<>]+)/.exec(item.trim())?.[1]
    if (!name || /^(BEGIN|END)$/i.test(name)) continue
    const key = name.replace(/[<>]/g, "").toLowerCase()
    declaredNames.add(key)
    // Record the TYPE when the item carries one, so numeric operands can be detected. The type may
    // contain a hyphen (`sy-subrc`, `sy-tabix`); without it the regex captured only `sy`, which is
    // not in the numeric set, and the audit silently passed a body carrying the very defect it
    // exists to catch (found by falsifying this gate on 2026-09-29).
    const type = /^\s*[A-Za-z0-9_<>]+\s+TYPE\s+([a-z0-9_-]+(?:\s+LENGTH\s+\d+)?)/i.exec(item.trim())
    if (type) declared.set(key, type[1].trim().toLowerCase())
  }
}
/** Types that ABAP refuses to use as a character operand. */
const NUMERIC = /^(i|int4|int8|p|f|dec|b|s|sy-subrc|sy-tabix|sy-index|sy-dbcnt|sy-msgno|n)$/i

const problems = []

for (let i = 0; i < lines.length; i++) {
  if (!/^\s*CONCATENATE\b/i.test(lines[i])) continue
  const stmt = [lines[i]]
  let j = i
  while (j < lines.length && !/\.\s*$/.test(lines[j])) {
    j++
    if (j < lines.length) stmt.push(lines[j])
  }
  const text = stmt.join(" ")
  for (const [name, kind] of declared) {
    if (!NUMERIC.test(kind)) continue
    const re = new RegExp(`(^|[^a-z0-9_])${name}([^a-z0-9_]|$)`, "i")
    if (re.test(text))
      problems.push(
        `body line ${i + 1}: CONCATENATE uses ${name} (TYPE ${kind}); convert it with WRITE ... TO <char> first`
      )
  }
}

const referenced = new Set()
for (const raw of lines) {
  // Skip the declaration rows themselves, or every declared name would look like a use.
  if (/^\s*(DATA|STATICS|FIELD-SYMBOLS|CONSTANTS|TYPES|CLASS-DATA)\s*:?\s/i.test(raw)) continue
  for (const m of raw.matchAll(/\b(lv_[a-z0-9_]+|ls_[a-z0-9_]+|lt_[a-z0-9_]+)\b/gi)) {
    referenced.add(m[1].toLowerCase())
  }
}
const undeclared = [...referenced].filter((name) => !declaredNames.has(name)).sort()

console.log(
  `declarations resolved: ${declared.size} | numeric-name uses in CONCATENATE: ${problems.length}`
)
for (const p of problems) console.log("  " + p)
console.log(`referenced lv_/ls_/lt_ names without a declaration: ${undeclared.length}`)
for (const u of undeclared) console.log("  " + u)

const failed = problems.length > 0 || undeclared.length > 0
console.log(failed ? "FAIL" : "PASS")
process.exit(failed ? 1 : 0)
