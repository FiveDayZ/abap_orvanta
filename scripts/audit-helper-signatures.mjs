import { readFileSync, readdirSync } from "node:fs"

/**
 * Pre-F8 signature audit for the repository helper body.
 *
 * Reads every static CALL FUNCTION in the canonical body and checks each parameter against the live
 * signature of that function module, obtained through the native ADT path. Why native: the MCP tool
 * `read_function_module_interface` is itself served by the helper, so it is unusable exactly when the
 * helper is broken - and a broken helper is when this audit matters most.
 *
 * CHECK 1 - parameter category. The rule ABAP enforces inside CALL FUNCTION:
 *   caller EXPORTING  -> callee IMPORTING only
 *   caller IMPORTING  -> callee EXPORTING (this is how an output parameter is received)
 *   caller CHANGING   -> callee CHANGING
 *   caller TABLES     -> callee TABLES only
 * Passing an EXPORTING parameter under TABLES fails to compile. That is the defect the 2026-09-29 F8
 * reported for ET_MESSAGES.
 *
 * WHY caller EXPORTING IS NOT "callee IMPORTING or EXPORTING" (2026-10-01): this audit used to accept
 * a callee EXPORTING parameter supplied under the caller's EXPORTING, and that is exactly the bug it
 * then failed to catch. Supplying an output parameter in the caller's EXPORTING section only works
 * for a parameter passed BY VALUE; a by-reference callee EXPORTING parameter must be received in the
 * caller's IMPORTING section. The release arm passed TRINT_RELEASE_REQUEST's by-reference
 * ET_MESSAGES under EXPORTING, this audit reported "problems: 0", GENERATE accepted the body, and the
 * runtime then aborted with the short dump CALL_FUNCTION_PARM_UNKNOWN when the kernel looked the
 * parameter up among the callee's IMPORTING parameters. SAP's own callers receive such a parameter
 * under IMPORTING (TRINT_RELEASE_REQUEST -> TRINT_RELEASE_WITHOUT_TRANSP et_messages; and
 * BAPI_CTREQUEST_RELEASE -> BALW_BAPIRETURN_GET2 RETURN). The check below therefore requires a
 * callee EXPORTING parameter used under the caller's EXPORTING to be declared VALUE(...).
 *
 * CHECK 2 - actual-argument type and length (2026-10-04). A category-correct assignment can still be
 * rejected by the kernel: Z_ORVANTA_MCP_DYNPRO_API passed its own IV_DESCRIPTION, declared
 * TSTCT-TTEXT (AS4TEXT is CHAR 60, but TTEXT is CHAR 36), into a callee parameter declared TYPE
 * DYNPROTEXT (D020T-DTXT, CHAR 60). Every call site was category-correct, so CHECK 1 was green, and
 * the runtime then raised CALL_FUNCTION_CONFLICT_TYPE / the short dump CALL_FUNCTION_CONFLICT_TYPE
 * for the whole helper - which is what a wrong formal type costs: not one tool, every tool.
 *
 * CHECK 2 compares the two sides by their declared type text:
 *   - the formal's text comes from the callee's signature (`VALUE(X) TYPE DYNPROTEXT`);
 *   - the actual's text comes from the owner's own interface (a parameter of the helper) or from a
 *     DATA/TYPES declaration in the body;
 *   - equal text passes; two different dictionary references are a problem, because that is the pair
 *     that produced the runtime conflict above;
 *   - a difference that involves a built-in type (`C`, `C LENGTH 20`, `TABLE OF x`, `REF TO y`) is
 *     reported as a review line instead: those are converted rather than rejected, and calling them
 *     failures would bury the real ones;
 *   - `--ddic <file>` supplies the length evidence - `{"DYNPROTEXT":{"type":"C","length":60}}` - and
 *     clears a dictionary pair that resolves to the same type and length. Without an entry for a
 *     differing dictionary pair the audit keeps reporting it, deliberately: an unproven pair is the
 *     state the runtime rejected, and assuming compatibility is how the defect reached production.
 *
 * Usage:
 *   node scripts/audit-helper-signatures.mjs --signatures <dir> [--canonical <file>] [--ddic <file>]
 * where <dir> holds one get_abap_object_lines .txt per function module (native ADT reads), and the
 * owner interface is read from the signature of the function module named by <file> itself
 * (`repository-z_orvanta_mcp_dynpro_api-canonical.json` -> Z_ORVANTA_MCP_DYNPRO_API), overridable
 * with --owner. The caller can produce that directory with the MCP batch runner; this script only
 * reads it.
 */
const argValue = (flag, fallback) => {
  const at = process.argv.indexOf(flag)
  if (at === -1) return fallback
  const value = process.argv[at + 1]
  return value === undefined || value.startsWith("--") ? fallback : value
}
const signatureDir = argValue("--signatures", undefined)
if (!signatureDir) {
  console.error(
    "usage: node scripts/audit-helper-signatures.mjs --signatures <dir> [--canonical <file>] [--ddic <file>] [--owner <FM>]"
  )
  process.exit(2)
}
const canonicalPath = argValue(
  "--canonical",
  ".cache/repository-z_orvanta_mcp_dynpro_api-canonical.json"
)
const ddicPath = argValue("--ddic", undefined)
const ownerArg = argValue("--owner", undefined)

/** The declared type text of one parameter line, e.g. `DYNPROTEXT`, `D020T-DTXT`, `C LENGTH 20`. */
const declaredType = (line) => {
  const m = line.match(/\b(?:TYPE|LIKE|STRUCTURE)\s+(.+)$/i)
  if (!m) return undefined
  const text = m[1]
    .replace(/\bDEFAULT\b[\s\S]*$/i, "")
    .replace(/\bOPTIONAL\b[\s\S]*$/i, "")
    .replace(/[.,]\s*$/, "")
    .trim()
  return text === "" ? undefined : text
}

/**
 * A dictionary reference is a data element (`DYNPROTEXT`) or a table field (`TSTCT-TTEXT`). Built-in
 * type names and constructed types are not references, and a difference involving them is a review
 * line rather than a failure.
 */
const isDictionaryReference = (text) =>
  /^[A-Z][A-Z0-9_]*(-[A-Z][A-Z0-9_]*)?$/i.test(text) &&
  !/^(ANY|C|D|F|I|N|P|T|X|STRING|XSTRING|NUMERIC|DATA|OBJECT|SIMPLE|TABLE|INDEX|STANDARD|SORTED|HASHED|LINE|REF|STRUCTURE|TYPE|LIKE)$/i.test(
    text
  )

/** Table-like, reference-like and generic formals are not compared: the kernel converts them. */
const isComparableType = (text) =>
  !/TABLE OF|INDEX TABLE|REF TO|LINE OF|STRUCTURE|^ANY$|^DATA$|^OBJECT$/i.test(text)

const canonical = JSON.parse(readFileSync(canonicalPath, "utf8"))
const lines = canonical.lines

const callee = new Map()
for (const file of readdirSync(signatureDir).filter((f) => f.endsWith(".txt"))) {
  const text = readFileSync(`${signatureDir}/${file}`, "utf8")
  const nameMatch = text.match(/Source from ([A-Z0-9_]+)/)
  if (!nameMatch) continue
  const body = text.slice(text.indexOf("```abap"))
  const groups = { IMPORTING: [], EXPORTING: [], CHANGING: [], TABLES: [], VALUE_EXPORTING: [] }
  const types = {
    IMPORTING: new Map(),
    EXPORTING: new Map(),
    CHANGING: new Map(),
    TABLES: new Map()
  }
  let current = null
  // These signature files are a page of the function's source, not a clean interface dump: the body
  // below the interface contains the callee's own CALL FUNCTION statements, whose parameter
  // assignments also look like `name = ...` lines. Reading past the interface therefore merged those
  // into the signature - which is how the by-reference check below first produced false positives on
  // IV_* imports. The interface ends at the first EXCEPTIONS (or ENDFUNCTION) after the groups start.
  let done = false
  for (const raw of body.split(/\r?\n/)) {
    const l = raw.trim()
    if (done) break
    const g = l.match(/^(IMPORTING|EXPORTING|CHANGING|TABLES)$/)
    if (g) {
      current = g[1]
      continue
    }
    if (/^EXCEPTIONS/.test(l) || /^ENDFUNCTION/.test(l) || /^FUNCTION /.test(l)) {
      current = null
      // Only stop once the interface has actually begun; these files lead with the FUNCTION line.
      if (groups.IMPORTING.length + groups.EXPORTING.length + groups.CHANGING.length > 0)
        done = true
      continue
    }
    if (!current) continue
    const p = l.match(/^VALUE\(([A-Za-z0-9_]+)\)|^([A-Za-z0-9_]+)/)
    if (p) {
      const param = (p[1] ?? p[2]).toUpperCase()
      groups[current].push(param)
      // A by-value EXPORTING parameter may be supplied in the caller's EXPORTING section; a
      // by-reference one may not, which is the distinction this audit now enforces.
      if (current === "EXPORTING" && p[1] !== undefined) groups.VALUE_EXPORTING.push(param)
      const declared = declaredType(l)
      if (declared) types[current].set(param, declared)
    }
  }
  callee.set(nameMatch[1], { ...groups, types })
}

/** The callee's declared type for one parameter, looked up in the group the caller writes into. */
const formalType = (sig, section, param) => {
  const order =
    section === "EXPORTING"
      ? ["IMPORTING", "EXPORTING"]
      : section === "IMPORTING"
        ? ["EXPORTING", "CHANGING"]
        : section === "CHANGING"
          ? ["CHANGING"]
          : section === "TABLES"
            ? ["TABLES"]
            : []
  for (const group of order) {
    const text = sig.types[group]?.get(param)
    if (text) return text
  }
  return undefined
}

// The owner is the function module the canonical body belongs to. Its own parameters carry the type
// of every actual argument that is passed straight through, which is the pair that failed above.
const ownerName =
  ownerArg ??
  (canonicalPath.match(/repository-([A-Za-z0-9_]+)-canonical\.json$/) ?? [])[1]?.toUpperCase()
const ownerSig = ownerName ? callee.get(ownerName) : undefined
const ownerTypes = new Map()
if (ownerSig) {
  for (const group of ["IMPORTING", "EXPORTING", "CHANGING", "TABLES"]) {
    for (const [param, text] of ownerSig.types[group]) {
      if (!ownerTypes.has(param)) ownerTypes.set(param, text)
    }
  }
}

// Local declarations, so an actual that is not an owner parameter still has a declared type.
const bodyTypes = new Map()
for (const raw of lines) {
  const l = raw.trim()
  const decl = l.match(/^(?:DATA|TYPES|STATICS|CLASS-DATA|FIELD-SYMBOLS)\b:?\s*(.+)$/i)
  if (!decl) continue
  for (const fragment of decl[1].split(",")) {
    const f = fragment.trim()
    if (/^(BEGIN|END)\s+OF\b/i.test(f)) continue
    const m = f.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(?:TYPE|LIKE)\s+(.+?)[.,]?$/i)
    if (!m) continue
    const name = m[1].toUpperCase()
    const text = declaredType(`X TYPE ${m[2]}`)
    if (text && !bodyTypes.has(name)) bodyTypes.set(name, text)
  }
}

// Length evidence for dictionary types, supplied by the caller. Absent evidence is not treated as
// agreement: the runtime rejected the unproven pair, so this audit keeps reporting it.
const ddic = new Map()
if (ddicPath) {
  for (const [key, value] of Object.entries(JSON.parse(readFileSync(ddicPath, "utf8")))) {
    ddic.set(key.toUpperCase(), value)
  }
}

const problems = []
const reviews = []
let sites = 0
let checked = 0
let typeChecked = 0
let typeUnresolved = 0
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^\s*CALL FUNCTION\s+'([A-Z0-9_]+)'/)
  if (!m) continue
  sites++
  const name = m[1]
  const sig = callee.get(name)
  if (!sig) {
    problems.push(`body line ${i + 1}: no signature read for ${name}`)
    continue
  }
  const block = [lines[i]]
  let j = i
  while (j < lines.length && !/\.\s*$/.test(lines[j])) {
    j++
    if (j < lines.length) block.push(lines[j])
  }
  let section = ""
  for (const raw of block.slice(1)) {
    const l = raw.trim()
    if (/^(IMPORTING|EXPORTING|CHANGING|TABLES)$/.test(l)) {
      section = l
      continue
    }
    if (/^EXCEPTIONS$/.test(l)) {
      section = "EXCEPTIONS"
      continue
    }
    const p = l.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)[.,]?$/)
    if (!p || section === "EXCEPTIONS" || section === "") continue
    const param = p[1].toUpperCase()
    checked++
    const where = [
      sig.IMPORTING.includes(param) && "IMPORTING",
      sig.EXPORTING.includes(param) && "EXPORTING",
      sig.CHANGING.includes(param) && "CHANGING",
      sig.TABLES.includes(param) && "TABLES"
    ].filter(Boolean)
    if (section === "TABLES") {
      if (!sig.TABLES.includes(param))
        problems.push(
          `body line ${i + 1}: ${name}: ${param} under TABLES, signature has it in ${where.join("/") || "no group"}`
        )
    } else if (section === "EXPORTING") {
      if (!sig.IMPORTING.includes(param) && !sig.EXPORTING.includes(param))
        problems.push(
          `body line ${i + 1}: ${name}: ${param} under EXPORTING, signature has it in ${where.join("/") || "no group"}`
        )
      else if (sig.EXPORTING.includes(param) && !sig.VALUE_EXPORTING.includes(param))
        problems.push(
          `body line ${i + 1}: ${name}: ${param} under EXPORTING but the callee declares it EXPORTING by reference - receive it under IMPORTING (by-value exports may stay here)`
        )
    } else if (section === "IMPORTING") {
      // The mirror image: an output parameter is received here, so the callee must declare it
      // EXPORTING (or CHANGING) - passing an INPUT under IMPORTING is a different mistake and worth
      // naming too, because the kernel resolves both directions by name.
      if (!sig.EXPORTING.includes(param) && !sig.CHANGING.includes(param))
        problems.push(
          `body line ${i + 1}: ${name}: ${param} under IMPORTING, signature has it in ${where.join("/") || "no group"}`
        )
    } else if (section === "CHANGING") {
      if (!sig.CHANGING.includes(param))
        problems.push(
          `body line ${i + 1}: ${name}: ${param} under CHANGING, signature has it in ${where.join("/") || "no group"}`
        )
    }

    // CHECK 2: the actual's declared type against the formal's.
    const actual = p[2]?.trim()
    if (!actual || /[()+]/.test(actual) || /^'/.test(actual)) continue
    const formal = formalType(sig, section, param)
    if (!formal || !isComparableType(formal)) continue
    const actualName = actual.toUpperCase()
    const actualType = ownerTypes.get(actualName) ?? bodyTypes.get(actualName)
    if (!actualType) {
      typeUnresolved++
      continue
    }
    typeChecked++
    if (actualType.toUpperCase() === formal.toUpperCase()) continue
    if (!isDictionaryReference(formal) || !isDictionaryReference(actualType)) {
      reviews.push(
        `body line ${i + 1}: ${name}: ${param} declared ${formal}, actual ${actual} declared ${actualType} - not both dictionary types, check by hand`
      )
      continue
    }
    const f = ddic.get(formal.toUpperCase())
    const a = ddic.get(actualType.toUpperCase())
    if (f && a) {
      if (f.type !== a.type || f.length !== a.length) {
        problems.push(
          `body line ${i + 1}: ${name}: ${param} declared ${formal} (${f.type} ${f.length}), actual ${actual} declared ${actualType} (${a.type} ${a.length}) - CALL_FUNCTION_CONFLICT_TYPE`
        )
      }
      continue
    }
    problems.push(
      `body line ${i + 1}: ${name}: ${param} declared ${formal}, actual ${actual} declared ${actualType} - two dictionary types, no --ddic entry proves they agree`
    )
  }
}

console.log(
  `call sites: ${sites} | parameters checked: ${checked} | callees: ${callee.size} | type checks: ${typeChecked} | actuals without a declared type: ${typeUnresolved}`
)
if (ownerName) {
  console.log(
    `owner interface: ${ownerName}${ownerSig ? "" : " (no signature read - type checks skipped)"}`
  )
}
console.log(`problems: ${problems.length}`)
for (const p of problems) console.log("  " + p)
console.log(`reviews: ${reviews.length}`)
for (const r of reviews) console.log("  " + r)
process.exit(problems.length === 0 ? 0 : 1)
