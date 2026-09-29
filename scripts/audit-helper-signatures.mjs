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
 *   caller EXPORTING  -> callee IMPORTING and EXPORTING   (both are legal in one section)
 *   caller CHANGING   -> callee CHANGING
 *   caller TABLES     -> callee TABLES only
 * Passing an EXPORTING parameter under TABLES fails to compile. That is the defect the 2026-09-29 F8
 * reported for ET_MESSAGES.
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
  const groups = { IMPORTING: [], EXPORTING: [], CHANGING: [], TABLES: [] }
  let current = null
  for (const raw of body.split(/\r?\n/)) {
    const l = raw.trim()
    const g = l.match(/^(IMPORTING|EXPORTING|CHANGING|TABLES)$/)
    if (g) {
      current = g[1]
      continue
    }
    if (/^EXCEPTIONS$/.test(l) || /^ENDFUNCTION/.test(l) || /^FUNCTION /.test(l)) {
      current = null
      continue
    }
    if (!current) continue
    const p = l.match(/^VALUE\(([A-Za-z0-9_]+)\)|^([A-Za-z0-9_]+)/)
    if (p) groups[current].push((p[1] ?? p[2]).toUpperCase())
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
