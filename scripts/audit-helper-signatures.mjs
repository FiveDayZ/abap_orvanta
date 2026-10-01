import { readFileSync, readdirSync } from "node:fs"

/**
 * Pre-F8 signature audit for the repository helper body.
 *
 * Reads every static CALL FUNCTION in the canonical body and checks each parameter against the live
 * signature of that function module, obtained through the native ADT path. Why native: the MCP tool
 * `read_function_module_interface` is itself served by the helper, so it is unusable exactly when the
 * helper is broken - and a broken helper is when this audit matters most.
 *
 * The rule ABAP enforces inside CALL FUNCTION:
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
 * Usage:
 *   node scripts/audit-helper-signatures.mjs --signatures <dir>
 * where <dir> holds one get_abap_object_lines .txt per function module (native ADT reads).
 * The caller can produce that directory with the MCP batch runner; this script only reads it.
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
    "usage: node scripts/audit-helper-signatures.mjs --signatures <dir> [--canonical <file>]"
  )
  process.exit(2)
}
const canonicalPath = argValue(
  "--canonical",
  ".cache/repository-z_orvanta_mcp_dynpro_api-canonical.json"
)

const canonical = JSON.parse(readFileSync(canonicalPath, "utf8"))
const lines = canonical.lines

const callee = new Map()
for (const file of readdirSync(signatureDir).filter((f) => f.endsWith(".txt"))) {
  const text = readFileSync(`${signatureDir}/${file}`, "utf8")
  const nameMatch = text.match(/Source from ([A-Z0-9_]+)/)
  if (!nameMatch) continue
  const body = text.slice(text.indexOf("```abap"))
  const groups = { IMPORTING: [], EXPORTING: [], CHANGING: [], TABLES: [], VALUE_EXPORTING: [] }
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
    }
  }
  callee.set(nameMatch[1], groups)
}

const problems = []
let sites = 0
let checked = 0
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
    const p = l.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/)
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
  }
}

console.log(`call sites: ${sites} | parameters checked: ${checked} | callees: ${callee.size}`)
console.log(`problems: ${problems.length}`)
for (const p of problems) console.log("  " + p)
process.exit(problems.length === 0 ? 0 : 1)
