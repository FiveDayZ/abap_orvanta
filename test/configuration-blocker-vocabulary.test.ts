import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import test from "node:test"
import ts from "typescript"

/**
 * Ten configuration modules deliver a `blockers` field, and it does not mean the same thing in all of
 * them: nine report a matchable identifier a caller branches on, while `inspect_configuration_bc_impact`
 * - registered as a tool in `mcp.ts` - reports advice in full sentences that cannot be matched, and one
 * of the nine writes its identifiers in a different convention from the other eight. Nothing declared
 * that split, so a caller that matches an identifier on one tool silently matches a paragraph on
 * another, and a new module can add prose to a code field without anything failing.
 *
 * Renaming a delivered field needs explicit approval, so the split is declared here instead of being
 * changed, and this gate checks the declaration against the shipped modules in both directions: a
 * module that changes what it reports fails until the declaration follows, and a module that starts or
 * stops delivering the field fails until the declaration follows too.
 */
const DECLARED: { module: string; kind: "matchable_code" | "human_advice"; convention: string }[] =
  [
    { module: "configuration-bc-impact.js", kind: "human_advice", convention: "prose" },
    {
      module: "configuration-bc-preflight.js",
      kind: "matchable_code",
      convention: "SCREAMING_SNAKE_CASE"
    },
    {
      module: "configuration-bte-command-api.js",
      kind: "matchable_code",
      convention: "snake_case"
    },
    {
      module: "configuration-fi-activation-preview.js",
      kind: "matchable_code",
      convention: "SCREAMING_SNAKE_CASE"
    },
    {
      module: "configuration-fi-activation-route.js",
      kind: "matchable_code",
      convention: "SCREAMING_SNAKE_CASE"
    },
    {
      module: "configuration-fi-dependencies.js",
      kind: "matchable_code",
      convention: "SCREAMING_SNAKE_CASE"
    },
    {
      module: "configuration-fi-field-bridge.js",
      kind: "matchable_code",
      convention: "SCREAMING_SNAKE_CASE"
    },
    {
      module: "configuration-fi-formula-analysis.js",
      kind: "matchable_code",
      convention: "SCREAMING_SNAKE_CASE"
    },
    {
      module: "configuration-fi-formula.js",
      kind: "matchable_code",
      convention: "SCREAMING_SNAKE_CASE"
    },
    {
      module: "configuration-fi-rule.js",
      kind: "matchable_code",
      convention: "SCREAMING_SNAKE_CASE"
    }
  ]

const classify = (value: string) => {
  if (/^[A-Z][A-Z0-9_]*$/.test(value)) return "SCREAMING_SNAKE_CASE"
  if (/^[a-z][a-z0-9_]*$/.test(value)) return "snake_case"
  if (value.includes(" ")) return "prose"
  return "other"
}

// Members of the field's own array are the string literals that are elements of an array literal
// anywhere under it. A literal used in a comparison, such as `p.status === "policy_excluded"`, is not
// a member, so a plain text scan of the array would over-count it.
const arrayElementStrings = (node: ts.Node, out: string[]) => {
  if (ts.isArrayLiteralExpression(node))
    for (const element of node.elements) if (ts.isStringLiteral(element)) out.push(element.text)
  ts.forEachChild(node, (child) => arrayElementStrings(child, out))
}

// A push argument is a member by definition, whether it is a bare literal or a spread array.
const allStrings = (node: ts.Node, out: string[]) => {
  if (ts.isStringLiteral(node)) out.push(node.text)
  ts.forEachChild(node, (child) => allStrings(child, out))
}

const membersOf = (text: string, fileName: string) => {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true)
  const members: string[] = []
  let delivers = false
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "blockers" &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      delivers = true
      arrayElementStrings(node.initializer, members)
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "blockers" &&
      (node.expression.name.text === "push" || node.expression.name.text === "unshift")
    ) {
      delivers = true
      for (const argument of node.arguments) allStrings(argument, members)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { members, delivers }
}

test("the shape classifier distinguishes the three member shapes it is asked to judge", () => {
  // Without this the gate below could pass by classifying everything the same way.
  assert.equal(classify("FI_RULE_READ_UNAVAILABLE"), "SCREAMING_SNAKE_CASE")
  assert.equal(classify("native_message_protocol_not_closed"), "snake_case")
  assert.equal(classify("Review the generated maintenance events before activation."), "prose")
  assert.notEqual(classify("FI_RULE_READ_UNAVAILABLE"), classify("review this first"))
})

test("every module that delivers blockers is declared, and the declaration matches what it delivers", () => {
  const directory = new URL("../src/", import.meta.url)
  const observed = new Map<string, string[]>()
  for (const file of readdirSync(directory)) {
    if (!/^configuration-.*\.js$/.test(file)) continue
    const { members, delivers } = membersOf(readFileSync(new URL(file, directory), "utf8"), file)
    if (!delivers) continue
    assert.ok(members.length > 0, `${file} delivers blockers but no member could be read`)
    observed.set(file, [...new Set(members.map(classify))].sort())
  }

  const declaredNames = DECLARED.map((entry) => entry.module)
  assert.equal(new Set(declaredNames).size, declaredNames.length, "a module is declared twice")
  for (const module of observed.keys())
    assert.ok(
      declaredNames.includes(module),
      `${module} delivers blockers and is not declared, so nothing records what its members mean`
    )
  for (const entry of DECLARED) {
    const shapes = observed.get(entry.module)
    assert.ok(shapes, `${entry.module} is declared but no longer delivers blockers`)
    assert.deepEqual(
      shapes,
      [entry.convention],
      `${entry.module} declares ${entry.kind} in ${entry.convention} but delivers ${shapes.join("+")}`
    )
  }

  // The split is a counted fact rather than an accident: one result reports advice, and exactly one
  // result uses the second convention. Both counts come from the observation, not the declaration.
  const advice = [...observed]
    .filter(([, shapes]) => shapes.join() === "prose")
    .map(([file]) => file)
  const lowercase = [...observed]
    .filter(([, shapes]) => shapes.join() === "snake_case")
    .map(([file]) => file)
  assert.deepEqual(advice, ["configuration-bc-impact.js"])
  assert.deepEqual(lowercase, ["configuration-bte-command-api.js"])
  assert.equal(observed.size, DECLARED.length)
  assert.equal(DECLARED.filter((entry) => entry.kind === "human_advice").length, 1)
})
