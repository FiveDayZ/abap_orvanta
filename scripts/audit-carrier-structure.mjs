/**
 * Structural audit of a generated repository carrier's OWN control flow.
 *
 * Why this exists: `audit-helper-blocks.mjs` audits the payload - the helper body that gets written
 * into SAP. The carrier report around it is a separate ABAP program with its own IF/FORM/LOOP
 * structure, and since 2026-09-29 it also contains a rollback path (`FORM restore_previous_state`)
 * that runs only after a failure. That path is by construction never exercised by a successful
 * deployment, so the only way to know it is well formed is to read the generated program.
 *
 * The payload lines are embedded as string literals (`ls_new-line = '...'`), and a naive scanner
 * would read block keywords out of that text and report nonsense. They are therefore excluded, and
 * the remaining statements are tokenised with a literal-aware splitter because the carrier writes
 * several statements on one line (`IF lv_pool IS INITIAL. lv_pool = c_group. ENDIF.`) - the same
 * trap that made the 2026-09-29 payload auditor report 14 false problems before it was fixed.
 *
 * Usage: node scripts/audit-carrier-structure.mjs <carrier.abap>
 */

import { readFileSync } from "node:fs"

const path = process.argv[2]
if (!path || path.startsWith("--")) {
  console.error("usage: node scripts/audit-carrier-structure.mjs <carrier.abap>")
  process.exit(2)
}

const source = readFileSync(path, "utf8").replace(/\r\n/g, "\n")

/**
 * Split ABAP text into statements, honouring both comment forms and '...' literals.
 *
 * Line awareness matters: an ABAP `*` comment runs to the end of its physical line. Treating the
 * text as one flat character stream made a comment line without a trailing period swallow the code
 * after it, which merged `PERFORM` statements into the preceding comment and then reported phantom
 * "ENDIF closes nothing" pairs. The first version of this script did exactly that on a known-good
 * carrier, which is why it is validated against one before being trusted.
 */
function statementsOf(text) {
  const out = []
  let current = ""
  let inLiteral = false
  for (const line of text.split("\n")) {
    if (!inLiteral && /^\*/.test(line)) continue
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (inLiteral) {
        current += ch
        if (ch === "'") {
          if (line[i + 1] === "'") {
            current += "'"
            i++
          } else {
            inLiteral = false
          }
        }
        continue
      }
      if (ch === "'") {
        inLiteral = true
        current += ch
        continue
      }
      // A double quote starts a comment that ends with the physical line.
      if (ch === '"') break
      if (ch === ".") {
        out.push(current)
        current = ""
        continue
      }
      current += ch
    }
    current += " "
  }
  if (!inLiteral && current.trim()) out.push(current)
  return out.map((s) => s.trim()).filter(Boolean)
}

// The carrier's own code: everything that is not an embedded payload literal and not a comment.
const ownLines = []
const payloadLines = []
for (const [index, line] of source.split("\n").entries()) {
  if (/^\s*CLEAR ls_new\.\s*ls_new-line\s*=/.test(line) || /^\s*ls_new-line\s*=/.test(line)) {
    payloadLines.push(index + 1)
    continue
  }
  ownLines.push(line)
}
const ownText = ownLines.join("\n")
const statements = statementsOf(ownText)

const OPENERS = {
  IF: "ENDIF",
  CASE: "ENDCASE",
  LOOP: "ENDLOOP",
  DO: "ENDDO",
  WHILE: "ENDWHILE",
  FORM: "ENDFORM",
  SELECT: "ENDSELECT",
  TRY: "ENDTRY",
  AT: "ENDAT",
  MODULE: "ENDMODULE",
  FUNCTION: "ENDFUNCTION"
}
const CLOSERS = new Set(Object.values(OPENERS))

/** One statement's leading keyword, ignoring labels and leading punctuation. */
function keywordOf(statement) {
  const match = /^([A-Za-z][A-Za-z0-9_-]*)/.exec(statement)
  return match ? match[1].toUpperCase() : ""
}

const problems = []
const stack = []
const formNames = new Set()
const performTargets = []
let depth = 0
let maxDepth = 0

for (const statement of statements) {
  const keyword = keywordOf(statement)
  if (!keyword) continue

  if (keyword === "PERFORM") {
    const target = /^PERFORM\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(statement)
    if (target) performTargets.push(target[1].toUpperCase())
    continue
  }

  // `SELECT SINGLE`, `SELECT ... INTO TABLE`, `SELECT ... APPENDING` and `SELECT ... UP TO n ROWS`
  // followed by ENDSELECT are the loop form; the single-row forms are not blocks.
  if (keyword === "SELECT") {
    const single = /\bSINGLE\b/i.test(statement) || /\bINTO\s+TABLE\b/i.test(statement)
    const appending = /\bAPPENDING\b/i.test(statement)
    if (single || appending) continue
  }

  if (keyword === "FORM") {
    const name = /^FORM\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(statement)
    if (name) formNames.add(name[1].toUpperCase())
  }

  if (Object.hasOwn(OPENERS, keyword)) {
    stack.push({ keyword, closer: OPENERS[keyword] })
    depth++
    maxDepth = Math.max(maxDepth, depth)
    continue
  }

  if (CLOSERS.has(keyword)) {
    const top = stack.pop()
    if (!top) {
      problems.push(`${keyword} closes nothing`)
    } else if (top.closer !== keyword) {
      problems.push(`${top.keyword} expected ${top.closer} but found ${keyword}`)
    }
    depth--
    continue
  }
}

for (const open of stack) problems.push(`${open.keyword} is never closed`)
for (const target of new Set(performTargets)) {
  if (!formNames.has(target)) problems.push(`PERFORM ${target} has no FORM in this program`)
}

console.log(
  JSON.stringify(
    {
      file: path,
      carrierLines: source.split("\n").length,
      payloadLiteralLines: payloadLines.length,
      ownStatements: statements.length,
      forms: [...formNames].sort(),
      performTargets: [...new Set(performTargets)].sort(),
      maxNestingDepth: maxDepth,
      structuralProblems: problems
    },
    null,
    2
  )
)
process.exit(problems.length === 0 ? 0 : 1)
