import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { z } from "zod"
import { helperCapabilityRoutes } from "../src/capabilities.js"
import { toolContracts } from "../src/contracts.js"
import {
  mergeTextElementChanges,
  normalizeExistingTextElements,
  normalizeTextElements,
  TEXT_ELEMENT_ID_TYPES,
  textElementCategory,
  textElementIdTypeFromPoolId,
  textElementKey
} from "../src/text-elements.js"

/**
 * Selection texts (`TEXTPOOL` ID `S`) versus text symbols (`I`).
 *
 * The 2026-09-25 defect: `manage_text_elements` maintained text symbols only. A selection screen
 * label is an `S` row whose KEY is the selection screen element name (`P_WERKS`, `RB_CHK`, `S_SRC`),
 * so the three-character symbol rule rejected every one of them - the tool could not maintain a
 * screen element label at all, and a read that published `I` rows only made an existing `S` entry
 * invisible, so a caller could neither discover nor verify it.
 *
 * The kind is carried explicitly as `idType` (`SYMBOL` default, `SELECTION`), the two kinds are keyed
 * apart everywhere, and both halves of the rule - the service and the deployed helper - are read
 * here. Either half changing alone must fail this suite.
 */
const SCRIPT = "scripts/bootstrap-sap-helper.ps1"

/** The emitted ABAP of a generator block, comment lines skipped (see ddic-field-reference.test.ts). */
function abapOf(block: string): string {
  return block
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .flatMap((line) => {
      const first = /^\s*"([^"]*)"/.exec(line)
      return first ? [String(first[1])] : []
    })
    .join("\n")
}

/**
 * The kind crosses the payload as the idType name, so every helper field that carries it must be at
 * least as wide as the longest idType. `id_kind TYPE c LENGTH 8` truncated `SELECTION` to
 * `SELECTIO`, so a selection text write was rejected as `TEXT_ID_TYPE_INVALID` and a read published
 * an unknown kind - found by the 2026-09-25 runtime acceptance, after a local gate that had asserted
 * the eight-character width instead of the rule.
 */
const KIND_FIELD_DECLARATIONS = [
  { name: "lv_text_entry_kind", pattern: /"  DATA lv_text_entry_kind TYPE c LENGTH (\d+)\./ },
  { name: "id_kind", pattern: /"    id_kind TYPE c LENGTH (\d+),/ }
]

function kindFieldWidthViolations(script: string): string[] {
  const longest = Math.max(...TEXT_ELEMENT_ID_TYPES.map((value) => value.length))
  const violations: string[] = []
  for (const declaration of KIND_FIELD_DECLARATIONS) {
    const match = declaration.pattern.exec(script)
    if (!match) {
      violations.push(`${declaration.name} declaration not found`)
      continue
    }
    if (Number(match[1]) < longest) {
      violations.push(`${declaration.name} must hold ${longest} characters, found ${match[1]}`)
    }
  }
  return violations
}

test("the text pool kind selects the row ID, its ID rule and its identity", () => {
  // The pool row ID is what SAP stores; the ADT category is how the other route addresses it.
  assert.equal(textElementCategory("SYMBOL"), "symbols")
  assert.equal(textElementCategory("SELECTION"), "selections")
  // A read carries the kind back, and an older helper that publishes nothing means a symbol.
  assert.equal(textElementIdTypeFromPoolId("I"), "SYMBOL")
  assert.equal(textElementIdTypeFromPoolId("S"), "SELECTION")
  assert.equal(textElementIdTypeFromPoolId("SYMBOL"), "SYMBOL")
  assert.equal(textElementIdTypeFromPoolId(undefined), "SYMBOL")
  assert.throws(() => textElementIdTypeFromPoolId("X"), /unknown text element type/)

  // Identity is the pair: a symbol and a selection text may legitimately share a key.
  assert.equal(textElementKey({ id: "src", idType: "SYMBOL" }), "SYMBOL:SRC")
  assert.equal(textElementKey({ id: "SRC", idType: "SELECTION" }), "SELECTION:SRC")
  assert.notEqual(
    textElementKey({ id: "SRC", idType: "SYMBOL" }),
    textElementKey({ id: "SRC", idType: "SELECTION" })
  )
})

test("selection texts take a screen element name and refuse a declared length", () => {
  assert.deepEqual(normalizeTextElements([{ id: "p_werks", text: "工厂", idType: "SELECTION" }]), [
    { idType: "SELECTION", id: "P_WERKS", text: "工厂", maxLength: 2 }
  ])
  // Absent kind keeps the meaning it had before selection texts existed.
  assert.deepEqual(normalizeTextElements([{ id: "001", text: "Text" }]), [
    { idType: "SYMBOL", id: "001", text: "Text", maxLength: 10 }
  ])
  assert.throws(
    () => normalizeTextElements([{ id: "P_WERKS_LANG", text: "x", idType: "SELECTION" }]),
    /1-8 valid selection screen element characters/
  )
  assert.throws(
    () => normalizeTextElements([{ id: "P-WERKS", text: "x", idType: "SELECTION" }]),
    /1-8 valid selection screen element characters/
  )
  // 30 characters is the limit the ADT text element service enforces for selection texts; a helper
  // write that stored more would produce an entry ADT and SE38 cannot read back.
  assert.throws(
    () => normalizeTextElements([{ id: "P_BUKRS", text: "x".repeat(31), idType: "SELECTION" }]),
    /must contain 1-30 characters/
  )
  assert.throws(
    () =>
      normalizeTextElements([
        { id: "P_BUKRS", text: "公司代码", idType: "SELECTION", maxLength: 40 }
      ]),
    /has no declared length/
  )
  // The same entry as a symbol keeps the 255-character rule and its declared length.
  assert.deepEqual(normalizeTextElements([{ id: "TXT", text: "x".repeat(200), maxLength: 255 }]), [
    { idType: "SYMBOL", id: "TXT", text: "x".repeat(200), maxLength: 255 }
  ])
})

test("merge keeps a symbol and a selection text with the same key apart", () => {
  const existing = [
    { id: "SRC", text: "SRC symbol", maxLength: 12, idType: "SYMBOL" as const },
    { id: "001", text: "Existing", maxLength: 20, idType: "SYMBOL" as const }
  ]
  const created = mergeTextElementChanges(
    existing,
    [{ id: "SRC", text: "源托盘", idType: "SELECTION" }],
    "create"
  )
  assert.deepEqual(created, [
    { idType: "SELECTION", id: "SRC", text: "源托盘", maxLength: 3 },
    { idType: "SYMBOL", id: "001", text: "Existing", maxLength: 20 },
    { idType: "SYMBOL", id: "SRC", text: "SRC symbol", maxLength: 12 }
  ])
  // The same key as another kind is a different entry: update refuses it, create accepts it.
  assert.throws(
    () =>
      mergeTextElementChanges(
        [{ id: "001", text: "Existing", maxLength: 20, idType: "SYMBOL" }],
        [{ id: "001", text: "Label", idType: "SELECTION" }],
        "update"
      ),
    /Text element SELECTION 001 does not exist/
  )
  assert.throws(
    () =>
      mergeTextElementChanges(
        existing,
        [{ id: "SRC", text: "duplicate", idType: "SYMBOL" }],
        "create"
      ),
    /Text element SYMBOL SRC already exists/
  )
})

test("a read that omits the kind is normalized as a symbol", () => {
  assert.deepEqual(normalizeExistingTextElements([{ id: "001", text: "Text", maxLength: 20 }]), [
    { idType: "SYMBOL", id: "001", text: "Text", maxLength: 20 }
  ])
  assert.deepEqual(normalizeExistingTextElements([{ id: "P_WERKS", text: "工厂" }]), [
    { idType: "SYMBOL", id: "P_WERKS", text: "工厂", maxLength: 10 }
  ])
})

test("the tool contract accepts the entry kind and keeps it optional", () => {
  const schema = toolContracts.manage_text_elements.inputSchema
  const validate = (input: unknown) =>
    z
      .object(schema as z.ZodRawShape)
      .strict()
      .parse(input)
  const base = {
    objectName: "ZREPORT_DEMO",
    objectType: "PROGRAM" as const,
    action: "create" as const,
    connectionId: "w200"
  }
  const parsed = validate({
    ...base,
    textElements: [
      { id: "P_WERKS", text: "工厂", idType: "SELECTION" },
      { id: "001", text: "Symbol" }
    ]
  }) as { textElements: Array<{ id: string; idType?: string }> }
  assert.equal(parsed.textElements[0]?.idType, "SELECTION")
  assert.equal(parsed.textElements[1]?.idType, undefined)
  assert.throws(() =>
    validate({ ...base, textElements: [{ id: "P_WERKS", text: "x", idType: "T" }] })
  )
})

// --- the deployed helper half of the rule -------------------------------------------------

test("the helper writes to the pool row ID the entry kind selects", async () => {
  const script = await readFile(SCRIPT, "utf8")
  const start = script.indexOf(`"    WHEN 'READ_TEXT_ELEMENTS' OR 'MERGE_TEXT_ELEMENTS'."`)
  assert.ok(start >= 0, "the text element branch must exist")
  const end = script.indexOf(`"    WHEN 'DELETE_MESSAGE_CLASS'."`, start)
  assert.ok(end > start, "the text element branch must end before the next operation")
  const branch = abapOf(script.slice(start, end))

  // The payload property is what makes the kind expressible at all.
  assert.match(branch, /WHEN 'TYPE'\./)
  assert.match(branch, /<ls_text_change>-id_kind = lv_payload_value\./)
  assert.match(script, /"  DATA lv_text_pool_id TYPE textpool-id\."/)
  assert.deepEqual(
    kindFieldWidthViolations(script),
    [],
    "a kind field is narrower than the longest idType"
  )
  // The guard has to reject the width that truncated the kind, not just accept today's number.
  assert.deepEqual(
    kindFieldWidthViolations(
      script.replace('"    id_kind TYPE c LENGTH 9,"', '"    id_kind TYPE c LENGTH 8,"')
    ),
    ["id_kind must hold 9 characters, found 8"]
  )
  assert.match(branch, /lv_text_pool_id = 'I'\./)
  assert.match(branch, /lv_text_pool_id = 'S'\./)
  assert.match(branch, /TEXT_ID_TYPE_INVALID/)

  // Per-kind ID rules: three characters for a symbol, one to eight for a selection text. The pool
  // key is eight characters wide and blank padded, so every test runs on its significant part.
  // The first deployed revision of this half read `<ls_text_change>-id+8` - an offset at the key's
  // own length, which is a syntax error that the ADT syntax check does not report and only GENERATE
  // catches (2026-09-25, one SE38/F8 round) - and applied `CN` to the whole padded key, which would
  // have rejected every ID shorter than eight characters at runtime.
  assert.match(branch, /lv_text_id_length = strlen\( <ls_text_change>-id \)\./)
  assert.match(branch, /IF lv_text_id_length <> 3\./)
  assert.match(branch, /-id\(lv_text_id_length\)/)
  assert.match(branch, /IF lv_text_id_length = 0\./)
  assert.match(branch, /Selection text ID must be 1-8 characters/)
  assert.doesNotMatch(branch, /<ls_text_change>-id\+\d/)

  // The lookup and the write follow the kind. A hard-coded `id = 'I'` is exactly the defect: it is
  // why a selection text could not be created and why an existing one was never found.
  assert.match(branch, /WITH KEY id = lv_text_pool_id/)
  assert.match(branch, /ls_textpool-id = lv_text_pool_id\./)
  assert.match(branch, /WHERE id = lv_text_pool_id/)
  assert.doesNotMatch(branch, /WITH KEY id = 'I'/)
  assert.doesNotMatch(branch, /ls_textpool-id = 'I'\./)
  assert.doesNotMatch(branch, /WHERE id = 'I' AND key =/)
})

test("the helper publishes both pool kinds on a read", async () => {
  const script = await readFile(SCRIPT, "utf8")
  const start = script.indexOf(`"    WHEN 'READ_TEXT_ELEMENTS' OR 'MERGE_TEXT_ELEMENTS'."`)
  const end = script.indexOf(`"    WHEN 'DELETE_MESSAGE_CLASS'."`, start)
  const branch = abapOf(script.slice(start, end))
  // A read that filtered `id = 'I'` hid every selection text from the caller.
  assert.match(branch, /LOOP AT lt_textpool INTO ls_textpool/)
  assert.match(branch, /WHERE id = 'I' OR id = 'S'\./)
  assert.match(branch, /lv_text_entry_kind = 'SELECTION'\./)
  assert.match(branch, /lv_text_entry_kind = 'SYMBOL'\./)
  assert.match(branch, /add_repo_payload 'T' lv_payload_index 'TYPE'/)
  // The whole-table INSERT is what preserves the rows this write did not mention; the read must
  // therefore stay ahead of it (it is the merge source).
  const readAt = branch.indexOf("READ TEXTPOOL lv_textpool_program INTO lt_textpool")
  const insertAt = branch.indexOf("INSERT TEXTPOOL lv_textpool_program FROM lt_textpool")
  assert.ok(readAt > 0 && insertAt > readAt, "the pool must be read before the whole-row write")
})

test("the helper capability rows and the service contract agree on the protocol floor", async () => {
  const script = await readFile(SCRIPT, "utf8")
  const rows = [
    ...script.matchAll(/"(READ_TEXT_ELEMENTS|MERGE_TEXT_ELEMENTS)\|(\d+\.\d+)\|([RW])"/g)
  ]
  assert.equal(rows.length, 2, "both text element opcodes must be in the capability table")
  const since = [...new Set(rows.map((row) => String(row[2])))]
  // The repository helper's protocol is one monotone revision and PROTOCOL|MAX is what the gate
  // compares, so this contract change must sit ABOVE the helper's previous maximum (2.11): a row
  // numbered below it would leave the gate unable to tell this body from one that cannot write
  // selection texts at all, and the capability report would call the tool available on the old body.
  assert.deepEqual(since, ["2.12"])
  const route = helperCapabilityRoutes().find(
    (item) => item.id === "repository-helper-text-elements"
  )
  assert.ok(route, "manage_text_elements needs its own capability group")
  assert.equal(route.minimumVersion, since[0])
  assert.deepEqual(route.toolNames, ["manage_text_elements"])
  // ... on the repository helper, and with the opcode inventory declared, so the verdict rests on
  // the helper actually listing these two operations and not on the protocol version alone.
  assert.deepEqual(
    route.requiredOperations.map((item) => [item.tool, [...item.operations].sort()]),
    [["manage_text_elements", ["MERGE_TEXT_ELEMENTS", "READ_TEXT_ELEMENTS"]]]
  )
})

test("the generated body keeps ABAP comment markers in column one", async () => {
  const script = await readFile(SCRIPT, "utf8")
  // `*` marks a comment in column one only; anywhere else it is the multiplication operator, so an
  // indented comment breaks the statement it sits in. The 2026-09-25 revision indented four comments
  // above the text change structure and GENERATE rejected the whole body with "no colon before
  // comma" on the comment's own line - while the 72-column limit, the declaration scan, the export
  // and the ADT syntax check all passed. This reads the emitter, so the next one fails before F8.
  assert.doesNotMatch(script, /^\s*"\s+\*/m)
  // Both places that hand a generated body to SAP carry the rule, next to the column limit.
  assert.match(script, /Generated function source indents a comment/)
  const columnRule = script.match(/if \(\$line -match '\^\\s\+\\\*'\) \{/g) ?? []
  assert.equal(columnRule.length, 2, "the column-one rule must sit at both generation sites")
})
