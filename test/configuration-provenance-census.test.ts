import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync, readdirSync } from "node:fs"
import ts from "typescript"

/**
 * Provenance-shaped exports: the values a module publishes to say "this is the version or the
 * fingerprint of the artefact I deploy". The family has fourteen members, and it had two failure
 * modes that nothing looked at.
 *
 * One is an unread member. A `*SourceVersion` reads like a pin, but if nothing reads it, it pins
 * nothing: six members have no reader outside their own module, and four of those are read nowhere at
 * all - not even inside the module that defines them.
 *
 * The other is a member whose hash input disagrees with the live attestation. `configuration-bc-command.ts`
 * attests the two customer includes by comparing `normalize(live) === normalize(inc.source)` and
 * delivers `sha(normalize(live))`, where `normalize` trims each line's tail, joins on "\n" and trims
 * the whole text. The two unread `*SourceVersion` members hash `source.join("\r\n")` - raw CRLF, no
 * trimming - so they are not the value the attestation uses and cannot be swapped in for it. The
 * unread `configurationNumberRangeApiBodyFingerprint` normalises a third way again
 * (`replaceAll("\r\n", "\n").trim()`).
 *
 * The correlation is the point: the three members that hash the source text with something other than
 * the dominant unit-API-body normalisation are exactly the three that nobody reads. An unread value is
 * never forced to agree with the one that is read.
 *
 * Being unread is not by itself a defect, and the census does not treat it as one. Each of the four
 * members read nowhere is accounted for: three duplicate an attestation that runs by another route, and
 * the fourth hashes a deployment candidate that was never deployed, so there is nothing for it to pin.
 * None of the four is a coverage gap. What the census forbids is leaving that unstated - an unread pin
 * whose substance nothing checks would otherwise read exactly like one whose substance is checked twice.
 *
 * This test is the census. It extracts the family from the sources - a pattern narrow enough to miss a
 * member would be one-directionally blind - measures readership over the whole repository, and requires
 * every member with no reader to be declared with its hash idiom and the reason it has no reader.
 *
 * This file is excluded from its own census: it names the unread members, and a census that counted its
 * own declaration as a reader would make every declared-unread member look read.
 *
 * Readership is counted over code references, not over the member's name as text. A text census cannot
 * tell a reference from a mention, so one comment naming a member that nothing reads made it look read
 * and let it stay out of the declaration below with nothing turning red - a false available, in a gate
 * whose whole purpose is to surface exactly that. Measured: with the real reader renamed away and a
 * comment naming the member left in a third module, the text census reported one external reader and
 * passed, while the reference census reported none and reddened. The switch changed no member's measured
 * readership on the current sources, which is why it needed no declaration edits.
 */
const repoRoot = new URL("../../", import.meta.url)
const SELF = "configuration-provenance-census.test.ts"
const CENSUS_ROOTS = ["src", "test", "contracts", "scripts"] as const

/**
 * The provenance shapes. The suffix list is the family's whole naming convention, so a member added
 * under any of these suffixes is inside the census whether or not this file remembers it.
 */
const PROVENANCE_SHAPE =
  /^configuration\w*(SourceVersion|SourceHash|SourceFingerprint|BodyFingerprint)$/

/**
 * The boundary of the census above, and the reason it is a claim of its own. The provenance shape
 * deliberately excludes pin tables - a table of pins is not a fingerprint - and that exclusion lived
 * only in prose until it was measured. Measured: thirteen pin tables exist in the family, the
 * provenance shape matches none of them, and no pin table is left unreferenced.
 *
 * "No reader outside its own module" is not the defect this looks for. Both tables that are read only
 * inside their own module are consumed there - one is hashed into the protocol source version, the
 * other is indexed by object name - so their `export` is superfluous rather than dead, exactly as two
 * provenance members are. What would be a defect is a pin table referenced nowhere at all, and that is
 * the assertion with teeth.
 */
const PIN_SHAPE = /^configuration\w*Pins$/

/**
 * The pin tables read only inside the module that defines them, with the call that consumes them. The
 * anchor is derived from the member's own name, so a rename moves the anchor with it rather than
 * leaving a stale claim behind.
 */
const INTERNAL_ONLY_PINS: ReadonlyArray<{ name: string; module: string; consumedBy: string }> = [
  Object.freeze({
    name: "configurationBteProtocolSourcePins",
    module: "configuration-bte-protocol.ts",
    consumedBy: "JSON.stringify"
  }),
  Object.freeze({
    name: "configurationFiDependencyPins",
    module: "configuration-fi-dependencies.ts",
    consumedBy: "Object.keys"
  })
]

/**
 * The hash idioms the family uses, as a closed vocabulary. Each member is classified from its own
 * initializer and the module's binding of the value it hashes, so a member that changes algorithm
 * fails here instead of drifting.
 */
type Idiom =
  | "unit-api-body"
  | "raw-crlf-source-join"
  | "crlf-to-lf-trim-source"
  | "literal-pin"
  | "pin-table-json"
const IDIOMS: readonly Idiom[] = [
  "unit-api-body",
  "raw-crlf-source-join",
  "crlf-to-lf-trim-source",
  "literal-pin",
  "pin-table-json"
]

/** The idioms that hash the source text with something other than the dominant normalisation. */
const NON_DOMINANT: readonly Idiom[] = ["raw-crlf-source-join", "crlf-to-lf-trim-source"]

/**
 * Every member with no reader outside its own module. `internalReads` is what separates a value that is
 * merely exported wider than it needs to be from one that nothing reads at all, and it is measured
 * rather than assumed. `reason` says what is true about the member today; it is not a claim that the
 * member is correct.
 *
 * A member read nowhere at all must also name, in `coveredBy`, the module and the token that attest the
 * same substance by another route - because "nothing reads this pin" and "nothing checks this artefact"
 * are different claims, and only the first one is measured by the census. Anchoring the second keeps the
 * verdict honest: a fully-unread pin whose substance is attested elsewhere is redundant, and one whose
 * substance is attested nowhere is a coverage gap, and the difference must be visible rather than
 * asserted in prose. A member that is still read inside its own module needs no anchor - the value is
 * used, only its `export` is wider than the use.
 */
const UNREAD: ReadonlyArray<{
  name: string
  module: string
  internalReads: number
  idiom: Idiom
  reason: string
  coveredBy?: { module: string; anchor: string }
}> = Object.freeze([
  {
    name: "configurationBcCtsBodyFingerprint",
    module: "configuration-bc-cts.ts",
    internalReads: 1,
    idiom: "unit-api-body",
    reason:
      "Read once inside its own module, into the receipt's bodyFingerprint. Only the export is unused; the value is not."
  },
  {
    name: "configurationBcRecoveryCheckBodyFingerprint",
    module: "configuration-bc-recovery-check.ts",
    internalReads: 1,
    idiom: "unit-api-body",
    reason:
      "Read once inside its own module, into the receipt's bodyFingerprint. Only the export is unused; the value is not."
  },
  {
    name: "configurationBcOwnerSourceVersion",
    module: "configuration-bc-owner-api.ts",
    internalReads: 0,
    idiom: "raw-crlf-source-join",
    reason:
      "Read nowhere. The artefact is still attested - configuration-bc-command.ts compares normalize(live) against normalize(inc.source) and throws CONFIGURATION_BC_OWNER_INCLUDE_NOT_ATTESTED - so this is a redundant pin, not a coverage gap. It hashes raw CRLF, which is not the value that attestation delivers, so it is also not interchangeable with it.",
    coveredBy: {
      module: "configuration-bc-command.ts",
      anchor: "CONFIGURATION_BC_OWNER_INCLUDE_NOT_ATTESTED"
    }
  },
  {
    name: "configurationBcRecordKernelSourceVersion",
    module: "configuration-bc-record-kernel.ts",
    internalReads: 0,
    idiom: "raw-crlf-source-join",
    reason:
      "Read nowhere. Attested by the same content-equality check as the owner include - the loop covers both customer includes and raises one throw for either - so the two members legitimately share one anchor. Redundant pin, and its raw-CRLF hash is not the delivered value.",
    coveredBy: {
      module: "configuration-bc-command.ts",
      anchor: "CONFIGURATION_BC_OWNER_INCLUDE_NOT_ATTESTED"
    }
  },
  {
    name: "configurationBteContextProofBodyFingerprint",
    module: "configuration-bte-context-proof.ts",
    internalReads: 0,
    idiom: "unit-api-body",
    reason:
      "Read nowhere, and written in the dominant idiom, so it looks like the fingerprints that a preflight consumes. It is not a pin of a deployed artefact at all: the module is a deployment candidate that was never deployed, its function module is referenced nowhere but its own definition, and no tool reaches it. The fingerprint is a specimen hash of that candidate, so there is nothing deployed for it to attest. The gate checks the function module is still unreferenced, so wiring the candidate up forces this verdict to be revisited.",
    coveredBy: { module: "configuration-bte-context-proof.ts", anchor: "Deployment candidate only" }
  },
  {
    name: "configurationNumberRangeApiBodyFingerprint",
    module: "configuration-number-range-api.ts",
    internalReads: 0,
    idiom: "crlf-to-lf-trim-source",
    reason:
      "Read nowhere, and the only member that is a function rather than a value - it takes the source as an argument, so it was never bound to an artefact. The number-range API bodies are attested by attestConfigurationNumberRangeApi instead, which compares the body through the dominant normalisation plus the function name, the FUNCTION/ENDFUNCTION markers and the ordered parameter lists. A redundant helper, not a coverage gap; it also normalises a third way, so it is not interchangeable with the attestation it duplicates.",
    coveredBy: {
      module: "configuration-number-range-command.ts",
      anchor: "configurationUnitApiBody(actual.source)"
    }
  }
])

function moduleFiles(): string[] {
  return readdirSync(new URL("src/", repoRoot))
    .filter((name) => name.startsWith("configuration-") && name.endsWith(".ts"))
    .sort()
}

type Member = { name: string; module: string; idiom: Idiom; initializer: string }

/** Classify a member's hash idiom from its own initializer plus the module's binding of that value. */
function idiomOf(initializer: string, moduleText: string): Idiom {
  const flat = initializer.replace(/\s+/g, " ")
  if (flat.includes('replaceAll("\\r\\n", "\\n")')) return "crlf-to-lf-trim-source"
  if (flat.includes('.join("\\r\\n")')) return "raw-crlf-source-join"
  if (flat.includes("configurationUnitApiBody(")) return "unit-api-body"
  // `body` / `expectedBody` is bound to configurationUnitApiBody(...) in every module that uses it.
  if (
    /\.update\((?:body|expectedBody)\)/.test(flat) &&
    /configurationUnitApiBody\(/.test(moduleText)
  )
    return "unit-api-body"
  if (/^\s*"[0-9a-f]{64}"\s*$/.test(flat)) return "literal-pin"
  if (flat.includes("JSON.stringify(")) return "pin-table-json"
  throw new Error(`unclassified provenance idiom: ${flat.slice(0, 120)}`)
}

type ConfigurationExport = {
  name: string
  module: string
  initializer: string
  moduleText: string
}

/** Every exported binding in the configuration modules, with its initializer and the module's text. */
function configurationExports(): ConfigurationExport[] {
  const found: ConfigurationExport[] = []
  for (const file of moduleFiles()) {
    const moduleText = readFileSync(new URL(`src/${file}`, repoRoot), "utf8")
    const source = ts.createSourceFile(file, moduleText, ts.ScriptTarget.ES2022, true)
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue
      if (!statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue
      for (const declaration of statement.declarationList.declarations) {
        found.push({
          name: declaration.name.getText(),
          module: file,
          initializer: declaration.initializer?.getText() ?? "",
          moduleText
        })
      }
    }
  }
  return found
}

const CONFIGURATION_EXPORTS = configurationExports()

/** Every provenance-shaped export in the configuration modules, extracted rather than restated. */
function extractMembers(): Member[] {
  return CONFIGURATION_EXPORTS.filter((entry) => PROVENANCE_SHAPE.test(entry.name)).map(
    (entry) => ({
      name: entry.name,
      module: entry.module,
      idiom: idiomOf(entry.initializer, entry.moduleText),
      initializer: entry.initializer
    })
  )
}

type PinMember = { name: string; module: string; isTable: boolean }

/** Every pin-shaped export in the configuration modules, extracted rather than restated. */
function extractPinMembers(): PinMember[] {
  return CONFIGURATION_EXPORTS.filter((entry) => PIN_SHAPE.test(entry.name)).map((entry) => ({
    name: entry.name,
    module: entry.module,
    isTable: entry.initializer.trimStart().startsWith("{")
  }))
}

function censusFiles(): string[] {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(new URL(dir, repoRoot), { withFileTypes: true })) {
      const path = `${dir}${entry.name}`
      if (entry.isDirectory()) walk(`${path}/`)
      else if (/\.(ts|mjs|json)$/.test(entry.name)) files.push(path)
    }
  }
  for (const root of CENSUS_ROOTS) walk(`${root}/`)
  return files
}

const countOf = (text: string, needle: string) => text.split(needle).length - 1

const sourceCache = new Map<string, string>()
/**
 * A configuration module's source text. Read from the sources - the same universe the census extracts
 * members from - so a member and its anchor are always compared against one text. Reading the compiled
 * output instead was measured to change nothing for these anchors: this project does not set
 * `removeComments`, so even the comment anchor survives compilation.
 */
function sourceText(module: string): string {
  const cached = sourceCache.get(module)
  if (cached !== undefined) return cached
  const text = readFileSync(new URL(`src/${module}`, repoRoot), "utf8")
  sourceCache.set(module, text)
  return text
}

/**
 * Occurrences of a name as an Identifier node: a reference to the binding in code. A comment or a string
 * literal is not an identifier, so prose about a member is not a reader of it. Property keys are
 * identifiers but are not references to the binding, so they are excluded; the declaration's own name is
 * a binding and is subtracted separately in readership().
 */
function identifierCountsOf(text: string, fileName: string): Map<string, number> {
  const counts = new Map<string, number>()
  // A JSON file cannot reference a binding: a name in one is a string, not a read.
  if (!/\.(ts|mjs)$/.test(fileName)) return counts
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true)
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent
      const isKey =
        (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node
      if (!isKey) counts.set(node.text, (counts.get(node.text) ?? 0) + 1)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return counts
}

const identifierCache = new Map<string, Map<string, number>>()
function identifierCounts(path: string): Map<string, number> {
  const cached = identifierCache.get(path)
  if (cached !== undefined) return cached
  const counts = identifierCountsOf(readFileSync(new URL(path, repoRoot), "utf8"), path)
  identifierCache.set(path, counts)
  return counts
}

/**
 * Readership of a member: how many times its name is referenced in code, split into references inside
 * its own module and references anywhere else. The declaration itself is an occurrence, so it is
 * subtracted rather than counted as a read - counting it would report every member as read at least once.
 *
 * A read that went through a string would be invisible here, which errs towards "unread": such a member
 * is then required to be declared, so the census reddens instead of reporting coverage it cannot see.
 */
function readership(name: string, module: string): { internalReads: number; external: number } {
  let inModule = 0
  let external = 0
  for (const path of censusFiles()) {
    if (path.endsWith(SELF)) continue
    const occurrences = identifierCounts(path).get(name) ?? 0
    if (occurrences === 0) continue
    if (path === `src/${module}`) inModule += occurrences
    else external += occurrences
  }
  assert.ok(inModule >= 1, `${name} is not declared in its own module ${module}`)
  return { internalReads: inModule - 1, external }
}

const MEMBERS = extractMembers()
const UNREAD_NAMES = UNREAD.map((entry) => entry.name).sort()
const PIN_MEMBERS = extractPinMembers()
const PIN_NAMES = PIN_MEMBERS.map((member) => member.name).sort()
const INTERNAL_ONLY_PIN_NAMES = INTERNAL_ONLY_PINS.map((entry) => entry.name).sort()

test("the provenance family is extracted from the sources, not from a remembered list", () => {
  // An extraction that silently found nothing would make every assertion below vacuous.
  assert.ok(MEMBERS.length > 0, "no provenance-shaped export was extracted")
  assert.equal(
    MEMBERS.length,
    14,
    `the provenance family changed size; classify the new member in UNREAD (or confirm it has a reader): ${MEMBERS.map((m) => m.name).join(", ")}`
  )
  // A shape that cannot admit an invented name cannot tell a real member from a fabricated one, so the
  // extraction above - not the shape - is what has teeth. The control makes that explicit.
  assert.equal(PROVENANCE_SHAPE.test("configurationBcNothingSourceVersion"), true)
  assert.equal(
    MEMBERS.some((m) => m.name === "configurationBcNothingSourceVersion"),
    false,
    "the fabricated control name must not be extracted from the sources"
  )
  // Every member is classified into the closed idiom vocabulary.
  for (const member of MEMBERS)
    assert.ok(IDIOMS.includes(member.idiom), `${member.name}: ${member.idiom}`)
})

test("every provenance member with no reader is declared, with the reason it has none", () => {
  const measured = MEMBERS.filter((member) => readership(member.name, member.module).external === 0)
    .map((member) => member.name)
    .sort()
  // Both directions: an undeclared unread member, and a declaration for a member that has since gained
  // a reader, are each a declaration that no longer describes the family.
  assert.deepEqual(
    measured,
    UNREAD_NAMES,
    "the unread declaration and the measured census disagree"
  )
  assert.equal(UNREAD_NAMES.length, 6, "the unread count changed; revisit the declarations")
  for (const entry of UNREAD) {
    assert.ok(entry.reason.trim().length > 0, `${entry.name} is declared unread without a reason`)
    const member = MEMBERS.find((m) => m.name === entry.name)
    assert.ok(member, `${entry.name} is declared but not extracted`)
    assert.equal(member.module, entry.module, `${entry.name} moved module`)
    // Measured, not assumed: this is what separates an over-wide export from a value nothing reads.
    assert.equal(
      readership(entry.name, entry.module).internalReads,
      entry.internalReads,
      `${entry.name} internal read count changed`
    )
    assert.equal(member.idiom, entry.idiom, `${entry.name} hash idiom changed; revisit its reason`)
  }
  // Every member outside the declaration must actually have a reader, so the census cannot be satisfied
  // by declaring nothing.
  for (const member of MEMBERS.filter((m) => !UNREAD_NAMES.includes(m.name)))
    assert.ok(
      readership(member.name, member.module).external > 0,
      `${member.name} has no reader and is not declared unread`
    )
})

test("the members that hash source text outside the dominant idiom are exactly the unread ones", () => {
  // The finding this census exists to surface, stated as a fact about the sources rather than a claim
  // in a comment: an unread value is never forced to agree with the one that is read.
  const nonDominant = MEMBERS.filter((member) => NON_DOMINANT.includes(member.idiom))
    .map((member) => member.name)
    .sort()
  assert.deepEqual(nonDominant, [
    "configurationBcOwnerSourceVersion",
    "configurationBcRecordKernelSourceVersion",
    "configurationNumberRangeApiBodyFingerprint"
  ])
  for (const name of nonDominant)
    assert.ok(
      UNREAD_NAMES.includes(name),
      `${name} hashes source outside the dominant idiom but is read`
    )
  // The dominant idiom is not exempt: one member using it is unread too, so "unread" is not merely a
  // restatement of "non-dominant".
  const dominantUnread = UNREAD.filter((entry) => entry.idiom === "unit-api-body")
  assert.equal(dominantUnread.length, 3, "the dominant-idiom unread members changed")
})

test("a member read nowhere names the attestation covering its substance, and that anchor is real", () => {
  // "Nothing reads this pin" is measured by the census. "Nothing checks this artefact" is a different
  // claim, and it is the one that decides whether an unread pin is redundant or a coverage gap. Each
  // member read nowhere therefore names its covering anchor, and this test holds the anchor to the
  // sources instead of taking the reason's word for it.
  const fullyUnread = UNREAD.filter((entry) => entry.internalReads === 0)
  assert.equal(fullyUnread.length, 4, "the fully-unread count changed")
  // Both directions, so the anchor cannot be omitted where it is needed nor claimed where the value is
  // still in use.
  for (const entry of UNREAD)
    assert.equal(
      entry.coveredBy !== undefined,
      entry.internalReads === 0,
      `${entry.name}: an anchor is required exactly when nothing reads the member`
    )
  for (const entry of fullyUnread) {
    const covered = entry.coveredBy
    if (!covered) throw new Error(`${entry.name} is read nowhere but names no covering attestation`)
    assert.ok(
      sourceText(covered.module).includes(covered.anchor),
      `${entry.name}: ${covered.anchor} is not in ${covered.module}`
    )
    // The anchor must identify the module, else the evidence could move away and the verdict stay green.
    for (const other of moduleFiles())
      if (other !== covered.module)
        assert.equal(
          sourceText(other).includes(covered.anchor),
          false,
          `${entry.name}: ${covered.anchor} also appears in ${other}`
        )
  }
  // A table of anchors that nothing can falsify would pass every assertion above, so a fabricated anchor
  // must be absent from every configuration module.
  for (const other of moduleFiles())
    assert.equal(sourceText(other).includes("attestation_that_covers_nothing"), false)
})

test("the member that rests on an undeployed candidate is revisited when the candidate is wired up", () => {
  // One verdict is not "covered by an attestation" but "there is nothing to attest": the BTE context
  // proof is a deployment candidate. That verdict is only true while the candidate stays unreferenced, so
  // the candidate's function module name is derived from the module and required to appear exactly once -
  // its own definition. Registering the candidate would give the fingerprint something to pin, and this
  // gate turns red rather than leaving the verdict stale. The name is extracted, never restated.
  const candidate = "configuration-bte-context-proof.ts"
  const declared = /functionName:\s*"([A-Z0-9_]+)"/.exec(sourceText(candidate))
  const functionName = declared?.[1]
  if (functionName === undefined)
    throw new Error("the context-proof candidate declares no function module name")
  let occurrences = 0
  for (const path of censusFiles()) {
    if (path.endsWith(SELF)) continue
    occurrences += countOf(readFileSync(new URL(path, repoRoot), "utf8"), functionName)
  }
  assert.equal(
    occurrences,
    1,
    `${functionName} is now referenced outside its own definition; the fingerprint's verdict must be revisited`
  )
  // And the candidate marker the anchor points at is the module's own words, not this test's.
  assert.ok(sourceText(candidate).includes("Deployment candidate only"))
})

test("readership counts code references, so a mention in prose is not a reader", () => {
  // The census is only as good as this instrument. A text census cannot tell a reference from a mention,
  // so a single comment naming a member that nothing reads made it look read and let it stay out of the
  // declaration with nothing turning red - a false available. The specimen is built in memory rather
  // than by editing a module, so the control cannot leave the tree dirty.
  const entry = UNREAD.find((candidate) => candidate.internalReads === 0)
  if (!entry) throw new Error("no member read nowhere, so this control would be vacuous")
  const text = sourceText(entry.module)
  const before = identifierCountsOf(text, entry.module).get(entry.name) ?? 0
  assert.ok(before >= 1, `${entry.name} is not even declared in ${entry.module}`)

  const prose = `${text}\n// ${entry.name} is mentioned here.\nconst mentioned = "${entry.name}"\n`
  // Discriminating power first: if the specimen does not actually add a mention, the assertion below
  // proves nothing about the instrument.
  assert.ok(
    countOf(prose, entry.name) > countOf(text, entry.name),
    "the specimen adds no mention, so it cannot show that mentions are ignored"
  )
  assert.equal(
    identifierCountsOf(prose, entry.module).get(entry.name) ?? 0,
    before,
    `${entry.name}: a mention in a comment or a string literal was counted as a reader`
  )
  // A property key is an identifier but not a reference, so it is not a reader either.
  const keyOnly = `${text}\nconst keyed = { ${entry.name}: 1 }\n`
  assert.ok(
    countOf(keyOnly, entry.name) > countOf(text, entry.name),
    "the key specimen adds no occurrence, so it cannot show that keys are ignored"
  )
  assert.equal(
    identifierCountsOf(keyOnly, entry.module).get(entry.name) ?? 0,
    before,
    `${entry.name}: a property key was counted as a reader`
  )
  // And a real reference must still count, else "counts references" would be vacuous.
  const reference = `${text}\nconst probe = ${entry.name}\n`
  assert.equal(
    identifierCountsOf(reference, entry.module).get(entry.name) ?? 0,
    before + 1,
    `${entry.name}: a real code reference was not counted`
  )
})

test("the pin tables the provenance shape excludes are extracted by shape", () => {
  // The shape must not be narrower than the family it claims to cover. A pin-named export the pattern
  // misses would be invisible to every assertion here - this is how the r7 gate went one-directionally
  // blind - so the narrow extraction is compared against a net wide enough to catch any such name. This
  // comparison comes first on purpose: with the count assertion first, narrowing the shape tripped the
  // count and this guard - the one that names the actual defect - was never reached.
  const pinLike = CONFIGURATION_EXPORTS.map((entry) => entry.name)
    .filter((name) => /pin/i.test(name))
    .sort()
  assert.deepEqual(PIN_NAMES, pinLike, "the pin shape misses a pin-named export in the family")
  // An extraction that silently found nothing would make every assertion below vacuous.
  assert.equal(
    PIN_MEMBERS.length,
    13,
    `expected thirteen pin tables, extracted ${PIN_MEMBERS.length}`
  )
  // Positive control: this name is not in the sources, so an extraction reading the sources cannot
  // produce it.
  assert.ok(
    !PIN_NAMES.includes("configurationNothingPins"),
    "the extraction produced a name that is not in the sources"
  )
  // Every pin table is an object literal: that is what makes it a table rather than a fingerprint.
  assert.deepEqual(
    PIN_MEMBERS.filter((member) => !member.isTable).map((member) => member.name),
    [],
    "a pin-shaped export is not an object literal"
  )
  // The two censuses not overlapping is a measured fact, and it is measured where the failure actually
  // occurs: a pin table renamed into a provenance suffix makes extractMembers() throw "unclassified
  // provenance idiom" from idiomOf's closed vocabulary at module load, which is a louder and earlier
  // failure than an assertion here could be. Asserting it a second time in this test was measured to be
  // unreachable - the module throws before any test in this file runs - so it is not asserted twice.
})

test("no pin table is unreferenced, and the ones read only inside their own module say so", () => {
  // Two different claims, kept disjoint so each can fail on its own. A pin table referenced nowhere at
  // all pins nothing; a pin table read only inside its own module is consumed but over-exported. A
  // single set keyed on "no external reader" would merge them, and the dead case - the one that is
  // actually a defect - would then always trip the over-exported assertion first and never be named.
  const measured = (member: PinMember) => readership(member.name, member.module)
  const dead = PIN_MEMBERS.filter((member) => {
    const { internalReads, external } = measured(member)
    return internalReads + external === 0
  }).map((member) => member.name)
  assert.deepEqual(dead, [], "a pin table is referenced nowhere, so it pins nothing")

  const overExported = PIN_MEMBERS.filter((member) => {
    const { internalReads, external } = measured(member)
    return external === 0 && internalReads >= 1
  })
    .map((member) => member.name)
    .sort()
  assert.deepEqual(
    overExported,
    INTERNAL_ONLY_PIN_NAMES,
    "the pin tables read only inside their own module changed; account for the difference"
  )
  for (const entry of INTERNAL_ONLY_PINS) {
    const { internalReads, external } = readership(entry.name, entry.module)
    assert.equal(external, 0, `${entry.name} is declared internal-only but has an external reader`)
    assert.ok(
      internalReads >= 1,
      `${entry.name} is declared internal-only but is read nowhere, so it is dead rather than over-exported`
    )
    // The anchor is derived from the member's own name. Cross-module uniqueness follows from the
    // external count asserted above, so what is checked here is that the anchor names exactly one
    // consumption: an anchor matching twice would not say which call consumes the table.
    const anchor = `${entry.consumedBy}(${entry.name})`
    assert.equal(
      countOf(sourceText(entry.module), anchor),
      1,
      `${entry.name}: ${anchor} is not exactly once in ${entry.module}, so it does not name one consumption`
    )
  }
})
