import { readFileSync } from "node:fs"

/**
 * Pre-F8 structural audit for the repository helper body.
 *
 * The signature and type audits cover parameter kinds and operand types. Neither covers the errors a
 * compiler reports for a structurally unbalanced program - an IF without its ENDIF, a LOOP left open,
 * a PERFORM whose FORM lives in an include this payload does not carry. Those abort GENERATE just as
 * hard, and they are decidable offline, so they belong in the same pre-F8 gate.
 *
 * Keywords are matched on the FIRST word of a statement, so `ELSEIF` is not read as `IF` and
 * `ENDIF` is not read as `IF`. Abbreviations (`ENDI.`, `ENDL.`) are not used by this payload and are
 * deliberately not accepted: an abbreviation this audit cannot see is worse than one it rejects.
 *
 * Usage: node scripts/audit-helper-blocks.mjs [canonical.json]
 */
const canonicalPath =
  process.argv[2] && !process.argv[2].startsWith("--")
    ? process.argv[2]
    : ".cache/repository-z_orvanta_mcp_dynpro_api-canonical.json"
const canonical = JSON.parse(readFileSync(canonicalPath, "utf8"))
const lines = canonical.lines

/** opener -> closer. Every block form this payload may use. */
const BLOCKS = {
  IF: "ENDIF",
  CASE: "ENDCASE",
  LOOP: "ENDLOOP",
  DO: "ENDDO",
  WHILE: "ENDWHILE",
  FORM: "ENDFORM",
  TRY: "ENDTRY",
  SELECT: "ENDSELECT",
  AT: "ENDAT",
  PROVIDE: "ENDPROVIDE",
  CLASS: "ENDCLASS",
  METHOD: "ENDMETHOD",
  FUNCTION: "ENDFUNCTION",
  MODULE: "ENDMODULE",
  DEFINE: "END-OF-DEFINITION"
}
const CLOSERS = new Set(Object.values(BLOCKS))
/** Statements that continue a block without opening or closing one. */
const CONTINUATIONS = new Set(["ELSE", "ELSEIF", "WHEN", "CATCH", "CLEANUP", "OTHERS", "ON"])

const stripComment = (line) => {
  const star = /^\s*\*/.test(line)
  if (star) return ""
  // A full-line comment is a `*` in column one; a trailing `"` comment is stripped.
  const quote = line.indexOf('"')
  return quote === -1 ? line : line.slice(0, quote)
}

const firstWord = (line) => {
  const m = /^\s*([A-Za-z][A-Za-z0-9_-]*)/.exec(line)
  return m ? m[1].toUpperCase() : ""
}

const stack = []
const problems = []
const formNames = new Set()
const performTargets = new Map()

/**
 * Split each source line into individual statements.
 *
 * ABAP allows several statements on one line - the payload really does write
 * `IF sy-subrc = 0. <lv_payload_component> = 'D'. ENDIF.` - so a line-based scanner sees the
 * opening IF and misses the closing ENDIF on the same line. Periods inside string literals are not
 * statement separators, so literals are skipped while splitting.
 */
const splitStatements = (line) => {
  const statements = []
  let current = ""
  let inString = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inString) {
      current += ch
      if (ch === "'") {
        if (line[i + 1] === "'") {
          current += line[i + 1]
          i++
          continue
        }
        inString = false
      }
      continue
    }
    if (ch === "'") {
      inString = true
      current += ch
      continue
    }
    if (ch === '"') break // trailing comment
    if (ch === ".") {
      statements.push(current)
      current = ""
      continue
    }
    current += ch
  }
  if (current.trim()) statements.push(current)
  return statements.map((s) => s.trim()).filter((s) => s !== "")
}

// Build a flat statement list with the line each statement started on. A statement may open on one
// line and close on a later one (a CALL FUNCTION spans lines but ends with one period), so the
// statements are accumulated across lines until the terminating period is seen.
const statements = []
{
  let buffer = ""
  let startLine = 0
  for (let i = 0; i < lines.length; i++) {
    const code = stripComment(lines[i])
    if (!code.trim()) continue
    if (buffer === "") startLine = i + 1
    buffer += (buffer === "" ? "" : " ") + code
    const parts = splitStatements(buffer)
    // splitStatements drops the final fragment when the buffer has no terminating period yet;
    // detect that by checking whether the raw buffer ends a statement.
    const endsWithPeriod = /\.\s*$/.test(code) || /'\s*\.\s*$/.test(code)
    if (endsWithPeriod) {
      for (const p of parts) statements.push({ text: p, line: startLine })
      buffer = ""
    } else if (parts.length > 1) {
      // Several complete statements, the last one still open.
      for (const p of parts.slice(0, -1)) statements.push({ text: p, line: startLine })
      buffer = parts[parts.length - 1]
      startLine = i + 1
    } else {
      buffer = parts[0] ?? buffer
    }
  }
  if (buffer.trim()) statements.push({ text: buffer.trim(), line: startLine })
}

for (let index = 0; index < statements.length; index++) {
  const { text: code, line: lineNo } = statements[index]
  const word = firstWord(code)
  if (!word) continue

  // DEFINE ... END-OF-DEFINITION: the macro body is written with `&1` placeholders and may itself
  // contain IF/ENDIF pairs, so the macro body is skipped rather than balanced against the stack.
  if (word === "DEFINE") {
    const name = code.trim().split(/\s+/)[1]?.toUpperCase()
    let depth = 1
    let j = index + 1
    for (; j < statements.length; j++) {
      const inner = firstWord(statements[j].text)
      if (inner === "DEFINE") depth++
      if (inner === "END-OF-DEFINITION") {
        depth--
        if (depth === 0) break
      }
    }
    if (depth !== 0) problems.push(`body line ${lineNo}: DEFINE ${name} has no END-OF-DEFINITION`)
    if (name) formNames.add(`MACRO:${name}`)
    index = j
    continue
  }

  if (CONTINUATIONS.has(word)) continue

  if (Object.prototype.hasOwnProperty.call(BLOCKS, word)) {
    // `SELECT` is only a block when it is a loop. `SELECT SINGLE ...`, `SELECT ... INTO TABLE ...`
    // and `SELECT ... APPENDING ...` are single statements closed by their own period. `UP TO n ROWS`
    // is NOT in that list: `SELECT ... UP TO 1 ROWS ... ENDSELECT` is still a loop, and treating it
    // as a single statement left the ENDSELECT to close the wrong block (four false findings on a
    // body SAP had compiled - the third correction this heuristic needed, all found by comparing
    // against a body whose compilation is already proven).
    if (word === "SELECT") {
      const upper = code.toUpperCase()
      const singleRow =
        /\bSINGLE\b/.test(upper) || /\bINTO\s+TABLE\b/.test(upper) || /\bAPPENDING\b/.test(upper)
      if (singleRow) continue
    }
    stack.push({ word, line: lineNo })
    if (word === "FORM") {
      const name = code.trim().split(/\s+/)[1]?.toUpperCase()
      if (name) formNames.add(name)
    }
    continue
  }

  if (CLOSERS.has(word)) {
    const open = stack.pop()
    if (!open) {
      problems.push(`body line ${lineNo}: ${word} closes nothing`)
      continue
    }
    if (BLOCKS[open.word] !== word)
      problems.push(
        `body line ${lineNo}: ${word} closes ${open.word} opened at line ${open.line} (expected ${BLOCKS[open.word]})`
      )
    continue
  }

  // PERFORM target tracking: `PERFORM name.` / `PERFORM name USING ...`
  // A PERFORM may legitimately call a FORM that lives in another include of the same function group
  // (the payload does exactly that with SAP's own SAPMS38L helpers), so a missing local FORM is
  // REPORTED but is not a failure - only a structural problem is.
  if (word === "PERFORM") {
    const name = code.trim().split(/\s+/)[1]?.toUpperCase()
    if (name && !/^\(/.test(name)) {
      if (!performTargets.has(name)) performTargets.set(name, [])
      performTargets.get(name).push(lineNo)
    }
  }
}

for (const open of stack)
  problems.push(
    `body line ${open.line}: ${open.word} is never closed (expected ${BLOCKS[open.word]})`
  )

const missingForms = [...performTargets.entries()].filter(([name]) => !formNames.has(name))

console.log(`blocks balanced: ${stack.length === 0 ? "yes" : "NO"}`)
console.log(`FORM definitions: ${[...formNames].filter((f) => !f.startsWith("MACRO:")).length}`)
console.log(
  `PERFORM targets: ${performTargets.size}; without a FORM in this body: ${missingForms.length}`
)
console.log(`structural problems: ${problems.length}`)
for (const p of problems) console.log("  " + p)
for (const [name, at] of missingForms)
  console.log(
    `  note: PERFORM ${name} at body line(s) ${[...new Set(at)].join(", ")} resolves outside this body (legal, not a failure)`
  )

process.exit(problems.length === 0 ? 0 : 1)
