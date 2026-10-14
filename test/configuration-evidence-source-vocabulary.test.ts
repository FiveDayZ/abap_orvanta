import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import test from "node:test"
import ts from "typescript"
import { TOOL_NAMES } from "../src/tool-registry.js"

/**
 * The vocabulary of the caller-facing `sources` field in the configuration family.
 *
 * The field the caller reads is declared once, in `write-operation-receipts.ts`, as
 * `z.array(z.string().min(1).max(100)).max(20)`: a list of strings naming what answered. Four
 * configuration modules fill it, and the twelve labels they write name five different kinds of
 * thing - a registered tool, a tool with its argument baked into the string, an SAP table, a
 * `Z_ORVANTA_*` function module, and a bespoke stage label. A caller matching tool names against
 * this list reads `read_abap_table(DD03L)` as one too, and `TNRO` as a tool that does not exist.
 * Nothing declared the labels or their kinds, so nothing could tell the kinds apart.
 *
 * The declaration lives here rather than in `src/` because nothing at runtime reads it: the labels
 * the modules write are unchanged. Declaring them in the only reader keeps the vocabulary honest
 * without shipping a constant that no code consults.
 *
 * The same property name is also used for a disjoint, internal domain - `ReviewedReaderSource[]`
 * provenance records, and two bespoke fingerprint arrays - which no schema exposes. Those are
 * deliberately NOT declared here: `sources` in a table reader is a different field that happens to
 * share the name. The last test in this file keeps the two apart, so the declaration cannot be
 * "completed" by adding internal modules to it.
 */

type SourceKind = "tool" | "tool_with_argument" | "table" | "function_module" | "bespoke"

/**
 * The shapes a label can have, most specific first. Each rule is a claim about the label that can be
 * checked without consulting the declaration, which is what makes the kinds more than a restatement:
 * `tool` must be a registered tool, `table` must have SAP's four-character table spelling, and
 * `function_module` must carry the `Z_ORVANTA_` prefix this repository's helpers use.
 */
const SHAPE_RULES: ReadonlyArray<readonly [SourceKind, (label: string) => boolean]> = [
  ["tool_with_argument", (label) => /^[a-z][a-z0-9_]*\([A-Z][A-Z0-9_]*\)$/.test(label)],
  ["function_module", (label) => /^Z_ORVANTA_[A-Z0-9_]+$/.test(label)],
  ["table", (label) => /^[A-Z][A-Z0-9]{3}$/.test(label)],
  ["tool", (label) => /^[a-z][a-z0-9_]*$/.test(label) && TOOL_NAMES.includes(label)],
  // The shape rule is still exclusion - an identifier-shaped label that is none of the kinds above -
  // because `native_full_T006A` and `bounded_CTS_projection` are composed stage labels, not tables
  // and not tools, so calling them `table` or `tool` would be the defect this gate exists for. The
  // shape alone does not make the label true: `BESPOKE_ANCHORS` pins each one to the artefact it
  // names, and the tests below require that artefact to exist in the producing module.
  ["bespoke", (label) => /^[A-Za-z][A-Za-z0-9_]*$/.test(label)]
]

function classify(label: string): SourceKind | "other" {
  for (const [kind, matches] of SHAPE_RULES) if (matches(label)) return kind
  return "other"
}

/** Every caller-facing label the configuration family writes, with the kind it actually has. */
const DECLARED: ReadonlyArray<{ module: string; label: string; kind: SourceKind }> = Object.freeze([
  { module: "configuration-bc-command", label: "immutable_native_before", kind: "bespoke" },
  { module: "configuration-bc-command", label: "immutable_native_effects", kind: "bespoke" },
  {
    module: "configuration-number-range-receipt",
    label: "Z_ORVANTA_CFG_NR_READ",
    kind: "function_module"
  },
  { module: "configuration-number-range-receipt", label: "TNRO", kind: "table" },
  { module: "configuration-number-range-receipt", label: "NRIV", kind: "table" },
  { module: "configuration-object", label: "read_ddic_transparent_table", kind: "tool" },
  { module: "configuration-object", label: "read_abap_table(DD03L)", kind: "tool_with_argument" },
  { module: "configuration-object", label: "read_ddic_data_element", kind: "tool" },
  { module: "configuration-object", label: "read_ddic_domain", kind: "tool" },
  { module: "configuration-unit-native-safety", label: "native_full_T006A", kind: "bespoke" },
  { module: "configuration-unit-native-safety", label: "bounded_CTS_projection", kind: "bespoke" },
  {
    module: "configuration-unit-native-safety",
    label: "approved_user_client_locks",
    kind: "bespoke"
  }
])

/**
 * Modules that write the caller-facing field, including the one that writes it empty. The empty
 * array is declared rather than skipped: a module that stops filling the field is a change to the
 * vocabulary, and the module set has to be able to say so.
 */
const DECLARED_MODULES: readonly string[] = Object.freeze([
  "configuration-bc-command",
  "configuration-number-range-receipt",
  "configuration-number-range",
  "configuration-object",
  "configuration-unit-native-safety"
])

/**
 * What each bespoke label names, as an exact token in its producing module.
 *
 * `bespoke` is the only kind defined by exclusion, which makes the shape checkable but the label
 * itself unfalsifiable: a stage name invented wholesale passed as long as it was spelled like an
 * identifier, and a module that stopped producing the evidence a label names kept the label. Each
 * entry pins the label to the artefact it names, and the tests below look for that token in the
 * producing module's compiled source rather than in this table.
 *
 * Two spellings that a looser "the words appear somewhere in the module" rule would have accepted are
 * deliberately not used: `approved` also occurs in `runApprovedNativeUnitStale` (an unrelated probe)
 * and `immutable` also occurs in a recovery warning. A token present for the wrong reason makes a
 * gate read as evidence while proving nothing, so every anchor below is the artefact itself.
 */
const BESPOKE_ANCHORS: ReadonlyArray<{
  label: string
  module: string
  anchor: string
  names: string
}> = Object.freeze([
  {
    label: "immutable_native_before",
    module: "configuration-bc-command",
    anchor: "beforeStateReference",
    names: "the before-state reference the receipt carries"
  },
  {
    label: "immutable_native_effects",
    module: "configuration-bc-command",
    anchor: "effectsReference",
    names: "the effects reference the receipt carries"
  },
  {
    label: "native_full_T006A",
    module: "configuration-unit-native-safety",
    anchor: "SAP_GR2_200_full_T006A_row_v1",
    names: "the full-row version scope the module declares"
  },
  {
    label: "bounded_CTS_projection",
    module: "configuration-unit-native-safety",
    anchor: "bounded_trimmed_projection",
    names: "the bounded readback representation the module declares"
  },
  {
    label: "approved_user_client_locks",
    module: "configuration-unit-native-safety",
    anchor: "lockSchema",
    names: "the lock shape the module declares, with its client and username"
  }
])

type ModuleSources = { labels: Set<string>; literalSites: number; internalSites: number }

/** Read each module's `sources` property positions, keeping the caller-facing and internal apart. */
function sourcesByModule(text: string, fileName: string): ModuleSources {
  const parsed = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true)
  const labels = new Set<string>()
  let literalSites = 0
  let internalSites = 0
  const visit = (node: ts.Node): void => {
    const named =
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "sources"
    if (named) {
      const value = ts.isPropertyAssignment(node) ? node.initializer : undefined
      if (value && ts.isArrayLiteralExpression(value)) {
        literalSites += 1
        for (const element of value.elements)
          if (ts.isStringLiteral(element)) labels.add(element.text)
      } else {
        // A shorthand `sources,` or a computed initializer delivers whatever a local variable holds:
        // the internal `ReviewedReaderSource[]` domain, which is not this vocabulary.
        internalSites += 1
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return { labels, literalSites, internalSites }
}

const sourceDirectory = new URL("../src/", import.meta.url)
const moduleFiles = readdirSync(sourceDirectory)
  .filter((name) => name.startsWith("configuration-") && name.endsWith(".js"))
  .sort()

const observed = new Map<string, ModuleSources>()
for (const name of moduleFiles)
  observed.set(
    name.replace(/\.js$/, ""),
    sourcesByModule(readFileSync(new URL(name, sourceDirectory), "utf8"), name)
  )

const moduleTextCache = new Map<string, string>()
/** The compiled source of one producing module, read once. */
function moduleText(module: string): string {
  const cached = moduleTextCache.get(module)
  if (cached !== undefined) return cached
  const text = readFileSync(new URL(`${module}.js`, sourceDirectory), "utf8")
  moduleTextCache.set(module, text)
  return text
}

test("the label classifier tells the five kinds apart", () => {
  // A classifier that answered one kind for everything would make the kind check below vacuous, so
  // each rule is pinned on a real label and two kinds are required to differ.
  assert.equal(classify("read_ddic_domain"), "tool")
  assert.equal(classify("read_abap_table(DD03L)"), "tool_with_argument")
  assert.equal(classify("TNRO"), "table")
  assert.equal(classify("Z_ORVANTA_CFG_NR_READ"), "function_module")
  assert.equal(classify("immutable_native_before"), "bespoke")
  assert.equal(classify("not a label"), "other")
  assert.notEqual(classify("TNRO"), classify("immutable_native_before"))
  assert.notEqual(classify("read_ddic_domain"), classify("read_abap_table(DD03L)"))
  // And the `tool` rule consults the registry rather than the spelling: a tool-shaped label that no
  // tool implements must not be reported as a tool.
  assert.ok(TOOL_NAMES.includes("read_ddic_domain"))
  assert.ok(!TOOL_NAMES.includes("immutable_native_before"))
  assert.equal(classify("read_imaginary_configuration_snapshot"), "bespoke")
})

test("the caller-facing sources vocabulary is declared, kinded, and gated in both directions", () => {
  const declared = new Map<string, { module: string; kind: SourceKind }>()
  for (const entry of DECLARED) {
    const key = `${entry.module}\u0000${entry.label}`
    assert.ok(!declared.has(key), `${entry.label} is declared twice for ${entry.module}`)
    declared.set(key, { module: entry.module, kind: entry.kind })
  }

  const emitted: string[] = []
  for (const [module, found] of observed)
    for (const label of found.labels) emitted.push(`${module}\u0000${label}`)

  const undeclared = emitted.filter((key) => !declared.has(key)).sort()
  assert.deepEqual(undeclared, [], "these sources labels are written by a module but not declared")
  const unused = [...declared.keys()].filter((key) => !emitted.includes(key)).sort()
  assert.deepEqual(unused, [], "these declared sources labels are written by no module")

  // The kind is checked against the label, not copied from the declaration: a label whose shape does
  // not match the kind it is declared with fails here even though both sides were edited together.
  for (const entry of DECLARED)
    assert.equal(
      classify(entry.label),
      entry.kind,
      `${entry.label} is declared as ${entry.kind} but has the shape of ${classify(entry.label)}`
    )

  // A module writing the field is itself a declared fact, so a new producer cannot appear silently.
  const writing = [...observed]
    .filter(([, found]) => found.literalSites > 0)
    .map(([module]) => module)
  assert.deepEqual(writing.sort(), [...DECLARED_MODULES].sort())
})

test("the internal sources domain is not folded into the caller-facing vocabulary", () => {
  // `sources` is also the name of an internal provenance array in this family. Those modules deliver
  // a variable, not a literal, and no schema exposes them, so declaring them here would state that a
  // caller can read something it cannot. A module may legitimately do both - configuration-number-range
  // writes the caller-facing field empty and also hands an internal array to a reader - so the rule is
  // about modules that deliver the field ONLY internally.
  const internalOnly = [...observed]
    .filter(([, found]) => found.internalSites > 0 && found.literalSites === 0)
    .map(([module]) => module)
  assert.ok(
    internalOnly.length > 0,
    "no internal-only sources site found: the separation check is vacuous"
  )
  for (const module of internalOnly)
    assert.ok(
      !DECLARED_MODULES.includes(module),
      `${module} delivers sources only as an internal value but is declared as a caller-facing producer`
    )
  const formula = observed.get("configuration-fi-formula")
  assert.ok(formula, "configuration-fi-formula must be among the scanned modules")
  assert.equal(
    formula.literalSites,
    0,
    "configuration-fi-formula must not write the caller-facing field"
  )
  assert.ok(
    formula.internalSites > 0,
    "configuration-fi-formula must deliver an internal sources value"
  )
  assert.ok(
    internalOnly.includes("configuration-fi-formula"),
    "configuration-fi-formula must be recognised as internal-only"
  )
})

test("the sources vocabulary keeps its size and kind distribution", () => {
  const byKind = new Map<SourceKind, number>()
  for (const entry of DECLARED) byKind.set(entry.kind, (byKind.get(entry.kind) ?? 0) + 1)
  assert.equal(
    DECLARED.length,
    12,
    "the sources vocabulary changed size; declare the label and update this count"
  )
  assert.equal(DECLARED_MODULES.length, 5, "the producing module set changed size")
  assert.deepEqual(
    [...byKind].sort(),
    [
      ["bespoke", 5],
      ["function_module", 1],
      ["table", 2],
      ["tool", 3],
      ["tool_with_argument", 1]
    ],
    "the kind distribution changed; a label moved between kinds"
  )
  // The one label that is not a bare tool name is the reason this vocabulary exists: keep it visible.
  assert.equal(DECLARED.filter((entry) => entry.kind === "tool_with_argument").length, 1)
  assert.equal(
    DECLARED.find((entry) => entry.kind === "tool_with_argument")?.label,
    "read_abap_table(DD03L)"
  )
})

test("every bespoke label names an artefact that exists in its producing module", () => {
  const bespoke = DECLARED.filter((entry) => entry.kind === "bespoke")
  // Both directions: a bespoke label without an anchor, and an anchor for a label that is not bespoke
  // or is gone, are each a declaration that no longer describes the vocabulary.
  assert.deepEqual(
    BESPOKE_ANCHORS.map((entry) => entry.label).sort(),
    bespoke.map((entry) => entry.label).sort(),
    "the anchor table and the bespoke labels disagree"
  )
  assert.equal(bespoke.length, 5, "the bespoke label count changed; anchor the new label")
  // Two labels naming the same artefact is not a declaration of two labels.
  assert.equal(
    new Set(BESPOKE_ANCHORS.map((entry) => entry.anchor)).size,
    BESPOKE_ANCHORS.length,
    "two bespoke labels are anchored to the same artefact"
  )
  for (const { label, module, anchor, names } of BESPOKE_ANCHORS) {
    const declared = DECLARED.find((entry) => entry.label === label)
    assert.equal(
      declared?.module,
      module,
      `${label} is anchored to ${module} but declared for ${declared?.module}`
    )
    assert.ok(
      moduleText(module).includes(anchor),
      `${label} names ${names}, but ${anchor} is not in ${module}`
    )
    // The anchor has to identify the module. A token that also occurs in a sibling producer would let
    // the label keep passing after the evidence moved, which is the failure this table exists to stop.
    for (const other of DECLARED_MODULES.filter((name) => name !== module))
      assert.equal(
        moduleText(other).includes(anchor),
        false,
        `${label}: ${anchor} also occurs in ${other}, so it does not identify ${module}`
      )
  }
  // Positive control: a token that names nothing is absent from every producer, so a table of invented
  // anchors cannot satisfy the loop above.
  for (const name of DECLARED_MODULES)
    assert.equal(
      moduleText(name).includes("bespoke_anchor_that_names_nothing"),
      false,
      `the anchor control must be absent from ${name}`
    )
})

test("the bespoke labels that name a declared literal are spelled from that literal", () => {
  // Two of the five anchors are more than a presence check: the module states the text the label is
  // built from. Reading the expected value out of the module is what makes a change to the target
  // table or the readback representation fail here, instead of leaving a label that no longer applies.
  const safety = moduleText("configuration-unit-native-safety")
  const target = /target:\s*"CONFIG:([A-Z0-9]+):/.exec(safety)
  assert.ok(target, "configuration-unit-native-safety no longer declares a CONFIG target literal")
  const table = target[1]
  assert.ok(table, "the target literal carries no table name")
  const fullRow = BESPOKE_ANCHORS.find((entry) => entry.label === "native_full_T006A")
  assert.ok(fullRow, "native_full_T006A is no longer anchored")
  assert.ok(
    fullRow.label.endsWith(`_${table}`),
    `${fullRow.label} must end with the table the module targets, which is ${table}`
  )
  const representation = /E071KReadback:\s*z\.literal\("([^"]+)"\)/.exec(safety)
  assert.ok(representation, "configuration-unit-native-safety no longer declares E071KReadback")
  const declared = representation[1]
  assert.ok(declared, "the E071KReadback literal is empty")
  const projection = BESPOKE_ANCHORS.find((entry) => entry.label === "bounded_CTS_projection")
  assert.ok(projection, "bounded_CTS_projection is no longer anchored")
  assert.equal(
    projection.anchor,
    declared,
    "the projection anchor must be the representation the module declares"
  )
  // The label's own words have to come from that declaration, not from somewhere else in the module.
  const words = declared.split("_")
  for (const word of ["bounded", "projection"])
    assert.ok(words.includes(word), `the declared representation does not carry the word ${word}`)
})
