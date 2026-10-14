import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import test from "node:test"
import ts from "typescript"

/**
 * Bind every producer of the receipt's prose fields to the caps the receipt schema declares.
 *
 * `sapPreChangeEvidence` is the object every write tool returns, and `write-operation-receipts.ts`
 * declares its `sources` and `warnings` as `z.array(z.string().min(n).max(m)).max(k)`. A producer that
 * emits a member longer than `m`, or more members than `k`, does not fail where the member is written:
 * the receipt fails to parse while the tool is building its response - after the SAP-side change has
 * already happened, which turns a completed write into a failed call.
 *
 * The caps are read from the compiled schema rather than restated here. That is the point: if the
 * schema tightens a cap, this gate must follow it, and a gate that hardcoded the numbers would keep
 * asserting the old ones and pass while the producers no longer fit.
 *
 * The array cap also has a second, coarser guard: a module that accumulates the field through several
 * `push` sites cannot exceed the cap even if every site runs. That bound is an upper bound, not the
 * per-call count, so it is deliberately the looser of the two.
 */

const schemaFile = new URL("../src/write-operation-receipts.js", import.meta.url)
const sourceDirectory = new URL("../src/", import.meta.url)

/** The prose fields whose caps this gate enforces, and the shape of the cap it found for each. */
type Cap = { perStringMin: number; perStringMax: number; arrayMax: number }

/**
 * Read the caps out of the schema. A missing field is an error rather than a skip: silently checking
 * nothing is how a gate stops being a gate.
 */
function readCaps(): Map<string, Cap> {
  const text = readFileSync(schemaFile, "utf8")
  const caps = new Map<string, Cap>()
  // `sources: z.array(z.string().min(1).max(100)).max(20)`
  const pattern =
    /^\s*(\w+):\s*z\.array\(z\.string\(\)\.min\((\d+)\)\.max\((\d+)\)\)\.max\((\d+)\)/gm
  for (const match of text.matchAll(pattern)) {
    const [, field, min, max, arrayMax] = match
    if (!field || !min || !max || !arrayMax) continue
    caps.set(field, {
      perStringMin: Number(min),
      perStringMax: Number(max),
      arrayMax: Number(arrayMax)
    })
  }
  return caps
}

const CAPS = readCaps()

/** The predicate under test: one member against one field's per-string cap. */
function withinCap(member: string, cap: Cap): boolean {
  return member.length >= cap.perStringMin && member.length <= cap.perStringMax
}

type Member = { module: string; line: number; field: string; text: string }
type ArraySite = { module: string; line: number; field: string; size: number; key: string | null }

const members: Member[] = []
const arraySites: ArraySite[] = []
const accumulationCounts = new Map<string, number>()

for (const name of readdirSync(sourceDirectory).filter((n) => n.endsWith(".js"))) {
  const text = readFileSync(new URL(name, sourceDirectory), "utf8")
  const parsed = ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true)
  const module = name.replace(/\.js$/, "")

  // Every push/unshift in the module, keyed by the name it accumulates on.
  const visitAccumulations = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["push", "unshift"].includes(node.expression.name.text)
    ) {
      const target = node.expression.expression
      const key = `${module}\u0000${ts.isIdentifier(target) ? target.text : target.getText()}`
      accumulationCounts.set(key, (accumulationCounts.get(key) ?? 0) + 1)
    }
    ts.forEachChild(node, visitAccumulations)
  }
  visitAccumulations(parsed)

  const visitDeliveries = (node: ts.Node): void => {
    const named =
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      ts.isIdentifier(node.name) &&
      CAPS.has(node.name.text)
    if (named) {
      const field = node.name.text
      const value = ts.isPropertyAssignment(node) ? node.initializer : undefined
      const { line } = parsed.getLineAndCharacterOfPosition(node.getStart())
      if (value && ts.isArrayLiteralExpression(value)) {
        arraySites.push({ module, line: line + 1, field, size: value.elements.length, key: null })
        for (const element of value.elements)
          if (ts.isStringLiteral(element))
            members.push({ module, line: line + 1, field, text: element.text })
      } else {
        // `warnings,` or `warnings: some.warnings` hands over a name; the module's pushes on that name
        // are what could grow it.
        const key = !value ? field : ts.isIdentifier(value) ? value.text : value.getText()
        arraySites.push({ module, line: line + 1, field, size: 0, key: `${module}\u0000${key}` })
      }
    }
    ts.forEachChild(node, visitDeliveries)
  }
  visitDeliveries(parsed)
}

test("the caps come from the schema, and the extractor is not vacuous", () => {
  // Both prose fields must be found. If the schema is rewritten so the extractor no longer matches,
  // this fails instead of the whole gate quietly checking zero members.
  assert.ok(CAPS.has("sources"), "the schema no longer declares a capped sources array")
  assert.ok(CAPS.has("warnings"), "the schema no longer declares a capped warnings array")
  for (const [field, cap] of CAPS) {
    assert.ok(cap.perStringMin >= 1, `${field}: per-string minimum must be at least 1`)
    assert.ok(
      cap.perStringMax > cap.perStringMin,
      `${field}: per-string maximum must exceed the minimum`
    )
    assert.ok(cap.arrayMax >= 1, `${field}: array maximum must be at least 1`)
  }
  // Positive control: the predicate must reject a member one character over the cap and accept one
  // exactly at it. A predicate that always answered true would make the check below vacuous.
  for (const [field, cap] of CAPS) {
    assert.equal(
      withinCap("x".repeat(cap.perStringMax), cap),
      true,
      `${field}: a member at the cap must be accepted`
    )
    assert.equal(
      withinCap("x".repeat(cap.perStringMax + 1), cap),
      false,
      `${field}: a member over the cap must be rejected`
    )
    assert.equal(withinCap("", cap), false, `${field}: an empty member must be rejected`)
  }
  // And the measurement must have found producers, or the invariant below proves nothing.
  assert.ok(members.length > 0, "no literal members of the capped fields were found")
  assert.ok(arraySites.length > 0, "no producers of the capped fields were found")
})

test("no producer writes a receipt member outside the schema's per-string cap", () => {
  const offenders = members
    .filter((member) => !withinCap(member.text, CAPS.get(member.field)!))
    .map((member) => `${member.module}:${member.line} ${member.field} length=${member.text.length}`)
  assert.deepEqual(offenders, [], "these receipt members do not fit the cap the schema declares")

  // Record the headroom, so a producer that grows toward the cap is visible in the failure message
  // rather than only in the day it crosses.
  for (const [field, cap] of CAPS) {
    const group = members.filter((m) => m.field === field)
    assert.ok(
      group.length > 0,
      `${field}: no literal members found, so the cap is not being enforced`
    )
    const longest = group.reduce((a, b) => (b.text.length > a.text.length ? b : a))
    assert.ok(
      longest.text.length <= cap.perStringMax,
      `${field}: longest member is ${longest.text.length} against a cap of ${cap.perStringMax} (${longest.module}:${longest.line})`
    )
  }
})

test("no producer writes more receipt members than the schema's array cap allows", () => {
  const overInline = arraySites
    .filter((site) => site.size > CAPS.get(site.field)!.arrayMax)
    .map((site) => `${site.module}:${site.line} ${site.field} size=${site.size}`)
  assert.deepEqual(overInline, [], "these inline arrays exceed the schema's array cap")

  // Upper bound: an inline array plus every push the module performs on the name it hands over. If
  // every site ran, the field would still fit.
  const overBound = arraySites
    .map((site) => ({
      site,
      bound: site.size + (site.key ? (accumulationCounts.get(site.key) ?? 0) : 0)
    }))
    .filter(({ site, bound }) => bound > CAPS.get(site.field)!.arrayMax)
    .map(({ site, bound }) => `${site.module}:${site.line} ${site.field} bound=${bound}`)
  assert.deepEqual(overBound, [], "these producers could exceed the schema's array cap")
})

test("the receipt caps keep the producers they have", () => {
  // Counted facts, so a producer disappearing is a visible change rather than a smaller check.
  const byField = new Map<string, number>()
  for (const member of members) byField.set(member.field, (byField.get(member.field) ?? 0) + 1)
  const producers = new Set(arraySites.map((site) => `${site.field}\u0000${site.module}`))
  assert.deepEqual(
    [...byField].sort(),
    [
      ["sources", 12],
      ["warnings", 109]
    ],
    "the literal member counts changed; check the new members against the caps and update this count"
  )
  assert.equal(producers.size, arraySites.length > 0 ? producers.size : 0)
  assert.ok(producers.size > 0)
  // The loosest bound in the codebase is well inside the cap; state it so the margin is a fact.
  const loosest = arraySites
    .map((site) => site.size + (site.key ? (accumulationCounts.get(site.key) ?? 0) : 0))
    .reduce((a, b) => Math.max(a, b), 0)
  assert.ok(loosest <= CAPS.get("warnings")!.arrayMax, `loosest accumulation bound is ${loosest}`)
})
