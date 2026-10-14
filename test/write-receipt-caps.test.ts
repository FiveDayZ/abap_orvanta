import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import test from "node:test"
import ts from "typescript"

/**
 * Bind every producer of a capped receipt field to the cap the receipt schema declares.
 *
 * The receipt schemas cap seven fields. A producer that exceeds a cap does not fail where the value is
 * written: the receipt fails to parse while the tool is building its response - after the SAP-side
 * change has already happened, which turns a completed write into a failed call.
 *
 * The caps are read from the compiled schema rather than restated here, so tightening a cap moves the
 * gate with it. A gate that hardcoded the numbers would keep asserting the old ones and pass while the
 * producers no longer fit.
 *
 * Two of the seven fields have no statically measurable producer at all, and they are capped at forty
 * characters. Those producers cannot be checked by reading a literal, so they are **declared** below
 * and compared in both directions: a new producer must be declared, and a declaration that no longer
 * has a producer must be removed. Where the declaration names a self-bounding producer, the bound
 * itself is asserted against the cap from the schema. Declaring is weaker than measuring, and saying so
 * is the point - an undeclared gap would read as coverage.
 */

const SCHEMA_MODULE = "write-operation-receipts"
const schemaFile = new URL(`../src/${SCHEMA_MODULE}.js`, import.meta.url)
const sourceDirectory = new URL("../src/", import.meta.url)

type Cap = { kind: "array" | "scalar"; min: number; perStringMax: number; arrayMax: number | null }

/** Read every capped field out of the schema. A missing field is an error rather than a skip. */
function readCaps(): Map<string, Cap> {
  const text = readFileSync(schemaFile, "utf8")
  const caps = new Map<string, Cap>()
  const array = /^\s*(\w+):\s*z\.array\(z\.string\(\)\.min\((\d+)\)\.max\((\d+)\)\)\.max\((\d+)\)/gm
  const scalar = /^\s*(\w+):\s*z\.string\(\)\.min\((\d+)\)\.max\((\d+)\)/gm
  for (const match of text.matchAll(array)) {
    const [, field, min, perStringMax, arrayMax] = match
    if (!field || !min || !perStringMax || !arrayMax) continue
    caps.set(field, {
      kind: "array",
      min: Number(min),
      perStringMax: Number(perStringMax),
      arrayMax: Number(arrayMax)
    })
  }
  for (const match of text.matchAll(scalar)) {
    const [, field, min, perStringMax] = match
    if (!field || !min || !perStringMax || caps.has(field)) continue
    caps.set(field, {
      kind: "scalar",
      min: Number(min),
      perStringMax: Number(perStringMax),
      arrayMax: null
    })
  }
  return caps
}

const CAPS = readCaps()

/** The inventory of capped fields, so adding or dropping one is a visible change. */
const DECLARED_FIELDS: [
  field: string,
  kind: Cap["kind"],
  min: number,
  perStringMax: number,
  arrayMax: number | null
][] = [
  ["sources", "array", 1, 100, 20],
  ["warnings", "array", 1, 1000, 20],
  ["target", "scalar", 1, 500, null],
  ["preChangeSummary", "scalar", 1, 2000, null],
  ["recoveryGuide", "scalar", 1, 2000, null],
  ["errorCode", "scalar", 1, 40, null],
  ["errorName", "scalar", 1, 40, null]
]

/**
 * Every module that produces each capped field. Compared in both directions: a producer in an
 * undeclared module fails, and a declared module that stopped producing fails. Without this, a
 * producer added elsewhere would be checked by nothing.
 */
const DECLARED_PRODUCER_MODULES: Record<string, string[]> = {
  sources: [
    "change-impact",
    "configuration-activity",
    "configuration-bc-audit",
    "configuration-bc-command",
    "configuration-bc-impact",
    "configuration-bc-set",
    "configuration-bte-change",
    "configuration-bte-product",
    "configuration-bte-route",
    "configuration-bte-save-closure",
    "configuration-documentation",
    "configuration-fi-activation-route",
    "configuration-fi-dependencies",
    "configuration-fi-formula",
    "configuration-fi-formula-analysis",
    "configuration-fi-rule",
    "configuration-fi-rule-discovery",
    "configuration-img",
    "configuration-img-details",
    "configuration-number-range",
    "configuration-number-range-receipt",
    "configuration-number-range-scope",
    "configuration-object",
    "configuration-transport",
    "configuration-unit",
    "configuration-unit-native-safety",
    "idoc-status",
    "log-correlation",
    "qrfc-queues",
    "role-authorizations",
    "runtime-resources",
    "server-facts",
    "system-info",
    "system-parameters",
    "tools",
    "trfc-error-entries",
    "user-authorizations",
    "write-prechange-evidence"
  ],
  warnings: [
    "adt-backend",
    "application-logs",
    "background-jobs",
    "change-impact",
    "configuration-activity",
    "configuration-bc-audit",
    "configuration-bc-command",
    "configuration-bc-compare",
    "configuration-bc-impact",
    "configuration-bc-set",
    "configuration-bte-change",
    "configuration-bte-metadata",
    "configuration-bte-product",
    "configuration-bte-route",
    "configuration-bte-save-closure",
    "configuration-compare",
    "configuration-documentation",
    "configuration-fi-activation-route",
    "configuration-fi-dependencies",
    "configuration-fi-formula",
    "configuration-fi-rule",
    "configuration-fi-rule-discovery",
    "configuration-img",
    "configuration-img-details",
    "configuration-number-range",
    "configuration-number-range-preview",
    "configuration-number-range-receipt",
    "configuration-number-range-scope",
    "configuration-object",
    "configuration-preview",
    "configuration-transport",
    "configuration-unit",
    "configuration-unit-native-safety",
    "configuration-unit-reconcile",
    "job-spool",
    "lock-delete",
    "log-correlation",
    "maintenance-diagnostics",
    "operational-logs",
    "report-parameters",
    "report-variants",
    "runtime-diagnostics",
    "tools",
    "transport-delivery",
    "transport-import",
    "transport-release",
    "where-used",
    "write-prechange-evidence"
  ],
  target: [
    "configuration-bc-command",
    "configuration-bc-preflight",
    "configuration-bc-preview",
    "configuration-bc-read-flow",
    "configuration-bc-state",
    "configuration-number-range-receipt",
    "configuration-transport",
    "configuration-unit-native-safety",
    "contracts",
    "mcp",
    "source-preflight",
    "tools",
    "where-used",
    "write-prechange-evidence"
  ],
  preChangeSummary: [
    "configuration-bc-command",
    "configuration-bte-command",
    "configuration-number-range-receipt",
    "configuration-unit-native-safety",
    "mcp",
    "write-operation-receipts"
  ],
  recoveryGuide: [
    "configuration-bc-command",
    "configuration-bte-command",
    "configuration-number-range-receipt",
    "configuration-unit-native-safety",
    "mcp",
    "write-operation-receipts"
  ],
  errorCode: ["write-operation-receipts"],
  errorName: ["write-operation-receipts"]
}

/**
 * Fields whose only producer bounds itself with an explicit `slice(0, cap)`. Declaring the module is
 * not enough for these: the cap is forty characters, the value comes from a thrown error, and the
 * bound is the single thing standing between an unusual error and an unparseable receipt. So the bound
 * is asserted, and asserted against the cap read from the schema.
 */
const SELF_BOUNDED_BY_SLICE = ["errorCode", "errorName"]

/** Literal members and literal values found per field, so a shrinking measurement is visible. */
const DECLARED_LITERAL_COUNTS: Record<string, number> = {
  sources: 12,
  warnings: 109,
  target: 7,
  preChangeSummary: 1,
  recoveryGuide: 4,
  errorCode: 0,
  errorName: 0
}

/** A zod chain is a schema declaration, not a producer. */
function isZodDeclaration(node: ts.Node | undefined): boolean {
  return node !== undefined && node.getText().startsWith("z.")
}

type Site = {
  module: string
  line: number
  field: string
  /** Set when the value is an array literal: how many members it holds. */
  arraySize: number | null
  /** Set when the value is a string or a flat template: the text whose length is capped. */
  literal: string | null
  /** For a non-literal value, the name the module accumulates on, if it is one. */
  accumulationKey: string | null
}

const sites: Site[] = []
const arrayMembers: { module: string; line: number; field: string; text: string }[] = []
const accumulationCounts = new Map<string, number>()

for (const name of readdirSync(sourceDirectory).filter((n) => n.endsWith(".js"))) {
  const text = readFileSync(new URL(name, sourceDirectory), "utf8")
  const parsed = ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true)
  const module = name.replace(/\.js$/, "")

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

  const visitProducers = (node: ts.Node): void => {
    const named =
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      ts.isIdentifier(node.name) &&
      CAPS.has(node.name.text)
    if (named) {
      const field = node.name.text
      const value = ts.isPropertyAssignment(node) ? node.initializer : undefined
      const { line } = parsed.getLineAndCharacterOfPosition(node.getStart())
      if (isZodDeclaration(value)) {
        ts.forEachChild(node, visitProducers)
        return
      }
      const site: Site = {
        module,
        line: line + 1,
        field,
        arraySize: null,
        literal: null,
        accumulationKey: null
      }
      // Braces matter here: without them the `else` binds to the inner `if` inside the `for`, and every
      // non-array value silently goes uncounted.
      if (value && ts.isArrayLiteralExpression(value)) {
        site.arraySize = value.elements.length
        for (const element of value.elements)
          if (ts.isStringLiteral(element))
            arrayMembers.push({ module, line: line + 1, field, text: element.text })
      } else if (
        value &&
        (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))
      ) {
        site.literal = value.text
      } else {
        // `warnings,` or `warnings: some.warnings` hands over a name; the module's pushes on that name
        // are what could grow it.
        const key = !value ? field : ts.isIdentifier(value) ? value.text : value.getText()
        site.accumulationKey = `${module}\u0000${key}`
      }
      sites.push(site)
    }
    ts.forEachChild(node, visitProducers)
  }
  visitProducers(parsed)
}

const boundOf = (site: Site): number =>
  (site.arraySize ?? 0) +
  (site.accumulationKey ? (accumulationCounts.get(site.accumulationKey) ?? 0) : 0)

test("the caps come from the schema, and the extractor is not vacuous", () => {
  // The inventory is compared both ways: a new capped field must be declared here, and a declaration
  // must still correspond to a capped field. Otherwise a field added to the schema would be capped in
  // name only, checked by nothing.
  assert.deepEqual(
    [...CAPS].map(([field, cap]) => [field, cap.kind, cap.min, cap.perStringMax, cap.arrayMax]),
    DECLARED_FIELDS,
    "the schema's capped fields changed; declare the new one and check its producers"
  )
  for (const [field, cap] of CAPS) {
    assert.ok(cap.min >= 1, `${field}: minimum must be at least 1`)
    assert.ok(cap.perStringMax > cap.min, `${field}: maximum must exceed the minimum`)
    if (cap.kind === "array")
      assert.ok((cap.arrayMax ?? 0) >= 1, `${field}: array maximum must be at least 1`)
  }
  // Positive control: the predicate must reject a value one character over the cap and accept one
  // exactly at it. A predicate that always answered true would make every check below vacuous.
  const within = (value: string, cap: Cap) =>
    value.length >= cap.min && value.length <= cap.perStringMax
  for (const [field, cap] of CAPS) {
    assert.equal(
      within("x".repeat(cap.perStringMax), cap),
      true,
      `${field}: a value at the cap must be accepted`
    )
    assert.equal(
      within("x".repeat(cap.perStringMax + 1), cap),
      false,
      `${field}: a value over the cap must be rejected`
    )
    assert.equal(within("", cap), false, `${field}: an empty value must be rejected`)
  }
  assert.ok(sites.length > 0, "no producers of the capped fields were found")
  assert.ok(arrayMembers.length > 0, "no literal array members of the capped fields were found")
})

test("no producer writes a receipt member outside the schema's per-string cap", () => {
  const offenders = arrayMembers
    .filter((member) => {
      const cap = CAPS.get(member.field)!
      return member.text.length < cap.min || member.text.length > cap.perStringMax
    })
    .map((member) => `${member.module}:${member.line} ${member.field} length=${member.text.length}`)
  assert.deepEqual(offenders, [], "these receipt members do not fit the cap the schema declares")
})

test("no producer writes a capped scalar outside the schema's per-string cap", () => {
  const offenders = sites
    .filter((site) => site.literal !== null)
    .filter((site) => {
      const cap = CAPS.get(site.field)!
      return site.literal!.length < cap.min || site.literal!.length > cap.perStringMax
    })
    .map((site) => `${site.module}:${site.line} ${site.field} length=${site.literal!.length}`)
  assert.deepEqual(offenders, [], "these scalar values do not fit the cap the schema declares")

  // Record the headroom per field, so a value growing toward the cap is visible in the failure message
  // rather than only on the day it crosses.
  for (const [field, cap] of CAPS) {
    if (cap.kind !== "scalar") continue
    const measured = sites.filter((site) => site.field === field && site.literal !== null)
    const longest = measured.reduce<Site | null>(
      (a, b) => (b.literal!.length > (a?.literal!.length ?? -1) ? b : a),
      null
    )
    assert.ok(
      longest === null || longest.literal!.length <= cap.perStringMax,
      `${field}: longest literal is ${longest?.literal!.length} against a cap of ${cap.perStringMax}`
    )
  }
})

test("no producer writes more receipt members than the schema's array cap allows", () => {
  const arrayFields = [...CAPS].filter(([, cap]) => cap.kind === "array").map(([field]) => field)
  const overInline = sites
    .filter(
      (site) =>
        arrayFields.includes(site.field) && (site.arraySize ?? 0) > CAPS.get(site.field)!.arrayMax!
    )
    .map((site) => `${site.module}:${site.line} ${site.field} size=${site.arraySize}`)
  assert.deepEqual(overInline, [], "these inline arrays exceed the schema's array cap")

  // Upper bound: an inline array plus every push the module performs on the name it hands over. If
  // every site ran, the field would still fit. This is an upper bound, not a per-call count.
  const overBound = sites
    .filter((site) => arrayFields.includes(site.field))
    .filter((site) => boundOf(site) > CAPS.get(site.field)!.arrayMax!)
    .map((site) => `${site.module}:${site.line} ${site.field} bound=${boundOf(site)}`)
  assert.deepEqual(overBound, [], "these producers could exceed the schema's array cap")
})

test("every producer of a capped field is declared, and every declaration has a producer", () => {
  const measured = new Map<string, string[]>()
  for (const site of sites) {
    if (!measured.has(site.field)) measured.set(site.field, [])
    const list = measured.get(site.field)!
    if (!list.includes(site.module)) list.push(site.module)
  }
  for (const field of CAPS.keys()) {
    assert.deepEqual(
      (measured.get(field) ?? []).sort(),
      (DECLARED_PRODUCER_MODULES[field] ?? []).slice().sort(),
      `${field}: the modules that produce it changed; check the new producer against the cap and declare it`
    )
  }
  assert.deepEqual(
    Object.keys(DECLARED_PRODUCER_MODULES).sort(),
    [...CAPS.keys()].sort(),
    "every capped field must declare its producers, and no declaration may outlive its field"
  )
})

test("a producer that bounds itself with a slice uses the cap the schema declares", () => {
  for (const field of SELF_BOUNDED_BY_SLICE) {
    const cap = CAPS.get(field)
    assert.ok(cap, `${field}: declared self-bounded but no longer capped`)
    const modules = DECLARED_PRODUCER_MODULES[field] ?? []
    assert.ok(modules.length > 0, `${field}: declared self-bounded but has no producer`)
    const bounded = modules.some((module) => {
      const text = readFileSync(new URL(`${module}.js`, sourceDirectory), "utf8")
      // The field's value must be an explicit `slice(0, cap)` in the module that produces it.
      return new RegExp(`${field}:\\s*[^,;\\n}]*\\.slice\\(0,\\s*${cap.perStringMax}\\)`).test(text)
    })
    assert.ok(
      bounded,
      `${field}: no producer bounds it with slice(0, ${cap.perStringMax}); an unusual error value would not fit the cap`
    )
  }
})

test("the receipt caps keep the producers and literals they have", () => {
  // Counted facts, so a producer or literal disappearing is a visible change rather than a smaller
  // check that still passes.
  const literalCounts = new Map<string, number>()
  for (const member of arrayMembers)
    literalCounts.set(member.field, (literalCounts.get(member.field) ?? 0) + 1)
  for (const site of sites)
    if (site.literal !== null)
      literalCounts.set(site.field, (literalCounts.get(site.field) ?? 0) + 1)
  assert.deepEqual(
    [...CAPS.keys()].map((field) => [field, literalCounts.get(field) ?? 0]),
    Object.entries(DECLARED_LITERAL_COUNTS),
    "the literal counts changed; check the new values against the caps and update this count"
  )
  // The loosest array bound must stay inside the tightest array cap; state it so the margin is a fact.
  const loosest = sites.map(boundOf).reduce((a, b) => Math.max(a, b), 0)
  const tightestArrayCap = Math.min(
    ...[...CAPS.values()].filter((cap) => cap.kind === "array").map((cap) => cap.arrayMax!)
  )
  assert.ok(
    loosest <= tightestArrayCap,
    `loosest accumulation bound is ${loosest} against a cap of ${tightestArrayCap}`
  )
})

/**
 * Every path that can put an arbitrary value into a capped error-identity field, and the guard that
 * keeps the value non-empty. `max(40)` is not the whole requirement: the schema also demands `min(1)`,
 * so a bound that only truncates still fails. An empty `error.name` or an empty errno passes the cap
 * and violates the minimum, and the receipt becomes unparseable after the SAP-side change landed -
 * the same late failure the cap gate exists to prevent. These guards are the reason the two fields are
 * safe today, and nothing was checking them.
 */
const NON_EMPTY_GUARDS: { field: string; pattern: RegExp; guard: string; guardFree: string }[] = [
  {
    field: "errorName",
    pattern: /error instanceof Error && error\.name \? error\.name : "([^"]+)"/,
    guard: 'the `error.name ? … : "NonError"` fallback',
    guardFree: 'const name = error instanceof Error ? error.name : "NonError";'
  },
  {
    field: "errorCode",
    pattern: /typeof code === "string" && code \? \{ errorCode: code\.slice\(0, \d+\) \}/,
    guard: 'the `typeof code === "string" && code` truthiness guard',
    guardFree: '...(typeof code === "string" ? { errorCode: code.slice(0, 40) } : {})'
  }
]

/** The caller-facing pattern is the only declaration of the error-code charset, and it embeds the cap. */
const CALLER_ERROR_CODE_PATTERN = /\.regex\(\/(\^\[A-Z\]\[A-Z0-9_\]\{0,(\d+)\}\$)\/\)/

test("every path into a capped error-identity field keeps the value non-empty", () => {
  const text = readFileSync(schemaFile, "utf8")
  for (const { field, pattern, guard, guardFree } of NON_EMPTY_GUARDS) {
    const cap = CAPS.get(field)
    assert.ok(
      cap,
      `${field}: guarded here but no longer capped; remove the guard or restore the cap`
    )
    assert.ok(
      cap.min >= 1,
      `${field}: the guard exists to satisfy min(1); the schema no longer requires it`
    )
    const match = pattern.exec(text)
    assert.ok(
      match,
      `${field}: ${guard} is gone - an empty value would pass the cap and fail the minimum`
    )
    // A fallback literal must itself be a legal value: non-empty and inside the cap.
    const fallback = match[1]
    if (fallback !== undefined)
      assert.ok(
        fallback.length >= cap.min && fallback.length <= cap.perStringMax,
        `${field}: the fallback literal is ${fallback.length} characters against ${cap.min}..${cap.perStringMax}`
      )
    // Positive control: the pattern must reject the same construct with the guard removed, otherwise it
    // would match anything and prove nothing.
    assert.equal(
      pattern.test(guardFree),
      false,
      `${field}: the guard pattern is not discriminating - it also matches the guard-free form`
    )
  }
})

test("the caller-facing error-code pattern agrees with the schema's cap", () => {
  const cap = CAPS.get("errorCode")
  assert.ok(cap, "errorCode is no longer capped; the caller-facing bound has nothing to agree with")
  const match = CALLER_ERROR_CODE_PATTERN.exec(readFileSync(schemaFile, "utf8"))
  assert.ok(
    match,
    "the caller-facing error-code pattern is gone; a caller-supplied code is no longer bounded"
  )
  const source = match[1]
  const bound = match[2]
  assert.ok(source, "the caller-facing pattern source was not captured")
  assert.ok(bound, "the caller-facing pattern carries no bound")
  // The cap comes from the schema, the bound from the pattern: two declarations, one requirement. This
  // is what makes tightening the cap fail until the pattern follows, instead of drifting silently.
  assert.equal(
    Number(bound) + 1,
    cap.perStringMax,
    `the pattern allows ${Number(bound) + 1} characters while the schema caps the field at ${cap.perStringMax}`
  )
  // The control runs the pattern exactly as the source writes it, not a restated copy of it, so a
  // charset change fails here too - a copy would keep passing while the real pattern widened.
  const accepts = new RegExp(source)
  const atCap = `A${"B".repeat(cap.perStringMax - 1)}`
  assert.equal(atCap.length, cap.perStringMax, "the specimen must be exactly the cap length")
  assert.equal(
    accepts.test(atCap),
    true,
    "the pattern must accept a code of exactly the cap length"
  )
  assert.equal(
    accepts.test(`${atCap}B`),
    false,
    "the pattern must reject a code one character over the cap"
  )
  assert.equal(accepts.test(""), false, "the pattern must reject an empty code")
  assert.equal(accepts.test("a"), false, "the pattern must reject a lowercase code")
})
