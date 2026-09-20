import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"
import { SCI_E2_HELPER, SCI_V2_HELPER } from "../src/sci-v2.js"

// Offline drift test for the CAPABILITIES carrier of scripts/sci-carrier-source.mjs
// (Z_ORVANTA_MCP_SCI_V2 / Z_ORVANTA_MCP_SCI_E2, protocol revision R6).
//
// Only generator text is parsed and bodies are rendered in memory. No PowerShell, no deploy script
// and no SAP system is executed or contacted.
//
// What is frozen here and why:
//   - both archived bodies and their bodyLinesHash: they are the pre-carrier baselines, read from
//     w200 on 2026-09-18 and proved byte-identical to scripts/sci-v2-source.mjs /
//     scripts/sci-e2-source.mjs, which in turn is the _E2 text-substitution derivation of _V2;
//   - both rendered carriers, their line counts and their digests: the digest is the SHA-256 of the
//     body with the four ORVANTAHASHSLOT placeholders still in place, so it is the value the
//     deployed helper must report as SOURCE|HASH (the same recipe the deployed repository helper
//     already proves: restoring its four groups reproduces its own row);
//   - the interface pins: the live interface has NO EV_RESULT, so the carrier is a deployment
//     candidate whose interface delta is exactly one new EXPORTING scalar of type STRINGVAL.

const helperFile = "scripts/sci-carrier-source.mjs"
const evidenceFile = "scripts/helper-capabilities-evidence.mjs"
const SCI_V2_BODY_LINES = 234
const SCI_V2_BODY_HASH = "dbf10817bf3a228281e11c9d39555423d38d75685ad16fdeec12fecccfd2c29e"
const SCI_E2_BODY_LINES = 284
const SCI_E2_BODY_HASH = "2f2b1380470a23d1b2add6e21bb87dd545dbb5c4d69e956ec7bb626ab4a89bda"
const SCI_V2_CARRIER_LINES = 257
const SCI_V2_CARRIER_HASH = "c8dd4682e854f1ddc0933327a28c1c5276b415de0ae71d2ed541b3014d3efdbb"
const SCI_E2_CARRIER_LINES = 307
const SCI_E2_CARRIER_HASH = "1dda60c45e50782618a529585a5848a89e8cdb8b8adea7f5614091958dd22542"
const SCI_V2_SLOT_DIGEST = "fa352053dc503b420655eb095abf25d35752e46db46f59248026c7cc270b09e2"
const SCI_E2_SLOT_DIGEST = "fc7c64182b91c90df9159764bb84dd0b5d277c1f81724ccfd324f474fe4b1020"
const BRANCH_LINES = 23
const INSERTION_ANCHOR = "  CLEAR: ev_status, ev_code, ev_count, ev_objtype, ev_objname,"

interface ParameterPin {
  name: string
  typeName: string
}

interface HelperPin {
  functionName: string
  engineVersion: string
  functionGroup: string
  remoteEnabled: boolean
  importParameters: ParameterPin[]
  exportParameters: ParameterPin[]
  tableParameters: ParameterPin[]
}

const source = await readFile(helperFile, "utf8")
const module_ = await import(pathToFileURL(resolve(helperFile)).href)
const evidence = await import(pathToFileURL(resolve(evidenceFile)).href)
const v2Derivation = await import(pathToFileURL(resolve("scripts/sci-v2-source.mjs")).href)
const e2Derivation = await import(pathToFileURL(resolve("scripts/sci-e2-source.mjs")).href)

const definitions = module_.sciHelperDefinitions as Record<string, HelperPin>
const operations = module_.sciCapabilityOperations as {
  opcode: string
  since: string
  mode: "R" | "W"
}[]
const deployment = module_.sciCapabilityDeployment as {
  packageName: string
  transportRequest: string
  transportTask: string
}
const v2Archived = module_.sciV2ArchivedBody as string[]
const e2Archived = module_.sciE2ArchivedBody as string[]
const v2Carrier = module_.sciV2CarrierSource as string[]
const e2Carrier = module_.sciE2CarrierSource as string[]
const buildBranch = module_.buildSciCapabilityBranch as (functionName: string) => string[]
const injectCapabilityHash = module_.injectCapabilityHash as (lines: string[]) => string[]
const maxProtocol = module_.sciCapabilityMaxProtocol as string
const minProtocol = module_.sciCapabilityMinProtocol as string
const bodyLinesHash = evidence.bodyLinesHash as (lines: string[]) => string

const v2Branch = buildBranch(SCI_V2_HELPER)
const e2Branch = buildBranch(SCI_E2_HELPER)
const operationRows = operations.map(
  (entry) => `OPERATION|${entry.opcode}|${entry.since}|${entry.mode}`
)

const carriers = [
  {
    helper: SCI_V2_HELPER,
    archive: v2Archived,
    branch: v2Branch,
    carrier: v2Carrier,
    lines: SCI_V2_CARRIER_LINES,
    hash: SCI_V2_CARRIER_HASH
  },
  {
    helper: SCI_E2_HELPER,
    archive: e2Archived,
    branch: e2Branch,
    carrier: e2Carrier,
    lines: SCI_E2_CARRIER_LINES,
    hash: SCI_E2_CARRIER_HASH
  }
]

test("the generator declares both live SCI helpers and their single interface delta", () => {
  assert.deepEqual(Object.keys(definitions).sort(), [SCI_E2_HELPER, SCI_V2_HELPER])
  for (const helper of [SCI_V2_HELPER, SCI_E2_HELPER]) {
    const definition = definitions[helper] as HelperPin
    assert.equal(definition.functionName, helper)
    assert.equal(definition.functionGroup, "ZORVANTA_MCP_CORE")
    assert.equal(definition.remoteEnabled, true)
    assert.deepEqual(definition.importParameters, [
      { name: "IV_ACTION", typeName: "CHAR50" },
      { name: "IV_OBJECT_TYPE", typeName: "TROBJTYPE" },
      { name: "IV_OBJECT_NAME", typeName: "SOBJ_NAME" }
    ])
    assert.deepEqual(definition.tableParameters, [{ name: "ET_RESULTS", typeName: "BAPIRET2" }])
    // The CARRIER delta: the live interface has no EV_RESULT, so this scalar must be added as an
    // EXPORTING parameter of type STRINGVAL before either carrier body can be activated.
    assert.deepEqual(definition.exportParameters.at(-1), {
      name: "EV_RESULT",
      typeName: "STRINGVAL"
    })
    assert.equal(
      definition.exportParameters.filter((parameter) => parameter.name === "EV_RESULT").length,
      1
    )
    assert.equal(
      definition.exportParameters.filter((parameter) => parameter.typeName === "STRINGVAL").length,
      1
    )
  }
  // The two live interfaces differ only in EV_NESTED, which _E2 adds for its third SCI rule.
  const v2Names = (definitions[SCI_V2_HELPER] as HelperPin).exportParameters.map((p) => p.name)
  const e2Names = (definitions[SCI_E2_HELPER] as HelperPin).exportParameters.map((p) => p.name)
  assert.deepEqual(
    e2Names.filter((name) => !v2Names.includes(name)),
    ["EV_NESTED"]
  )
  assert.deepEqual(
    v2Names.filter((name) => !e2Names.includes(name)),
    []
  )
  assert.equal((definitions[SCI_V2_HELPER] as HelperPin).engineVersion, "2.0")
  assert.equal((definitions[SCI_E2_HELPER] as HelperPin).engineVersion, "3.0")
  assert.equal(deployment.packageName, "ZABAP")
  assert.equal(deployment.transportRequest, "GR2K923472")
  assert.equal(deployment.transportTask, "")
})

test("both archived bodies are the frozen pre-carrier baselines", () => {
  assert.equal(v2Archived.length, SCI_V2_BODY_LINES)
  assert.equal(bodyLinesHash(v2Archived), SCI_V2_BODY_HASH)
  assert.equal(e2Archived.length, SCI_E2_BODY_LINES)
  assert.equal(bodyLinesHash(e2Archived), SCI_E2_BODY_HASH)
  for (const [helper, archive] of [
    [SCI_V2_HELPER, v2Archived],
    [SCI_E2_HELPER, e2Archived]
  ] as [string, string[]][]) {
    // Body-only form: it starts at the DATA declarations, ends at ENDTRY. and carries neither the
    // interface heading nor an ENDFUNCTION. wrapper nor a trailing blank line.
    assert.match(archive[0] ?? "", /^DATA /)
    assert.equal(archive.at(-1), "  ENDTRY.")
    assert.ok(!archive.some((line) => line.includes("ENDFUNCTION")))
    assert.ok(!archive.some((line) => line.trim() === ""), `${helper} keeps a trailing blank line`)
    // The CAPABILITIES branch may not have leaked into the archive, and the archive body still
    // predates the carrier: it never names the scalar the carrier writes.
    assert.ok(!archive.some((line) => line.includes("CAPABILITIES")))
    assert.ok(!archive.some((line) => line.includes("EV_RESULT")))
    // The archive holds exactly one business gate, and it is the insertion anchor.
    assert.equal(archive.filter((line) => line === INSERTION_ANCHOR).length, 1)
  }
  // The _E2 relationship is kept as a checked derivation, not as an assumed one: the literal
  // archives must still equal the bodies the two deployment sources derive.
  assert.equal(bodyLinesHash(v2Archived), bodyLinesHash(v2Derivation.sciV2Source as string[]))
  assert.equal(bodyLinesHash(e2Archived), bodyLinesHash(e2Derivation.sciE2Source as string[]))
})

test("the _E2 baseline is still derived from _V2 by text substitution", () => {
  const v2 = v2Derivation.sciV2Source as string[]
  const e2 = e2Derivation.sciE2Source as string[]
  // scripts/sci-e2-source.mjs derives _E2 from _V2 with `replace(before, after)` deltas that each
  // have to match exactly once; this asserts the derivation the carriers are pinned against.
  assert.equal(e2.length, SCI_E2_BODY_LINES)
  assert.equal(bodyLinesHash(e2), SCI_E2_BODY_HASH)
  assert.ok(e2.length > v2.length)
  assert.equal(e2.filter((line) => line === "  ENDTRY.").length, 1)
  // Nothing in the _E2 carrier may publish _V2's identity, and the derivation delta must still be
  // the one the pinned baseline was verified against.
  const derivedOnly = e2.filter((line) => !v2.includes(line))
  assert.ok(derivedOnly.some((line) => line.includes("ev_nested")))
  assert.ok(!e2.some((line) => line.includes(SCI_V2_HELPER)))
  assert.ok(!e2Carrier.some((line) => line.includes(SCI_V2_HELPER)))
})

test("each rendered carrier is exactly its archive plus one insertion", () => {
  for (const { helper, archive, branch, carrier, lines, hash } of carriers) {
    const insertion = archive.indexOf(INSERTION_ANCHOR)
    assert.ok(insertion >= 0, `${helper}: insertion anchor missing from the archived body`)
    const spliced = [...archive.slice(0, insertion), ...branch, ...archive.slice(insertion)]
    assert.equal(spliced.length, archive.length + branch.length)
    assert.equal(carrier.length, lines)
    assert.equal(carrier.length, archive.length + branch.length)
    // injectCapabilityHash only rewrites the SOURCE|HASH slots, so the two must agree exactly.
    assert.deepEqual(carrier, injectCapabilityHash(spliced))
    assert.equal(bodyLinesHash(carrier), hash)
    // Everything outside the insertion is byte-identical to the archive.
    const withoutBranch = [
      ...carrier.slice(0, insertion),
      ...carrier.slice(insertion + branch.length)
    ]
    assert.equal(withoutBranch.length, archive.length)
    for (let index = 0; index < archive.length; index += 1) {
      assert.equal(
        withoutBranch[index],
        archive[index],
        `${helper}: body drifted at line ${index + 1}`
      )
    }
  }
})

test("the CAPABILITIES branch runs before the INVALID_ACTION gate and returns", () => {
  for (const { helper, branch, carrier } of carriers) {
    assert.equal(branch.length, BRANCH_LINES)
    assert.equal(branch[0], "  IF iv_action = 'CAPABILITIES'.")
    assert.equal(branch[1], "    CLEAR ev_result.")
    assert.equal(branch.at(-2), "    RETURN.")
    assert.equal(branch.at(-1), "  ENDIF.")
    // The SCI body rejects every action other than PRECHECK and RUN before doing any work, so the
    // self-description must be answered ahead of that gate - otherwise an older action list wins.
    const branchStart = carrier.indexOf(branch[0] ?? "")
    const invalidAction = carrier.findIndex((line) => line.includes("INVALID_ACTION"))
    const anchorIndex = carrier.indexOf(INSERTION_ANCHOR)
    assert.ok(branchStart >= 0, `${helper}: the branch is not in the rendered carrier`)
    assert.equal(
      anchorIndex,
      branchStart + branch.length,
      `${helper}: the archived gate must follow the branch unchanged`
    )
    assert.ok(invalidAction > branchStart, `${helper}: the INVALID_ACTION gate precedes the branch`)
    assert.equal(carrier[anchorIndex], INSERTION_ANCHOR, `${helper}: the archived gate moved`)
    assert.ok(
      carrier.findIndex((line) => line.includes("ev_engine = 'SCI'")) > branchStart,
      `${helper}: the SCI reply preset precedes the branch`
    )
  }
})

test("the branch carries the marked opcode table, the protocol range and the provenance rows", () => {
  for (const { helper, branch } of carriers) {
    const joined = branch.join("\n")
    assert.ok(joined.includes(`'"HELPER|${helper}",'`))
    assert.ok(joined.includes(`'"PROTOCOL|MIN|${minProtocol}",'`))
    assert.ok(joined.includes(`'"PROTOCOL|MAX|${maxProtocol}",'`))
    for (const row of operationRows) {
      assert.ok(joined.includes(`'"${row}",'`), `${helper}: branch is missing the row ${row}`)
    }
    assert.ok(joined.includes(`'"SOURCE|PACKAGE|${deployment.packageName}",'`))
    assert.ok(
      joined.includes(
        `'"SOURCE|TRANSPORT|${deployment.transportRequest}|${deployment.transportTask}",'`
      )
    )
    assert.ok(joined.includes("'\"RUNTIME|HOST|'"))
    // R3: the rows live in the envelope's own payload array, and the envelope stays version 1.
    assert.ok(joined.includes("'\"payload\":['"))
    assert.ok(joined.includes('\'{"version":"1","status":"S","code":"CAPABILITIES",\''))
    assert.ok(joined.includes('\'"message":"ORVANTA helper capabilities","readOnly":true,\''))
    assert.ok(joined.includes("CONCATENATE ev_result ']}' INTO ev_result."))
    // The carrier is the EV_RESULT scalar, so no row table may appear anywhere.
    assert.ok(!joined.includes("it_source"))
    assert.ok(!joined.includes("APPEND"))
  }
  // The two helpers publish the same rows except for their own identity.
  const normalise = (lines: string[]) =>
    lines.map((line) =>
      line.split(SCI_V2_HELPER).join("HELPER").split(SCI_E2_HELPER).join("HELPER")
    )
  assert.deepEqual(normalise(v2Branch), normalise(e2Branch))
})

test("every operation is table-listed and read-only at protocol 1.0", () => {
  assert.equal(operations.length, 2)
  assert.deepEqual(
    operations.map((entry) => entry.opcode),
    ["PRECHECK", "RUN"]
  )
  for (const entry of operations) {
    assert.equal(entry.mode, "R", `${entry.opcode} must be read-only`)
    // R6: `since` is the JSON envelope's own revision ("version":"1"), never the SCI
    // rule-profile version the helper puts in ev_version.
    assert.equal(entry.since, "1.0", `${entry.opcode} must match the envelope version`)
  }
  assert.equal(minProtocol, "1.0")
  assert.equal(maxProtocol, "1.0")
  assert.equal(new Set(operations.map((entry) => entry.opcode)).size, operations.length)
  // The single opcode table lives in the marked block and nowhere else.
  assert.ok(source.includes("// >>> ORVANTA-CAPABILITY-TABLE"))
  assert.ok(source.includes("// <<< ORVANTA-CAPABILITY-TABLE"))
  assert.ok(source.includes("// >>> ORVANTA-CAPABILITIES-SOURCE"))
  assert.ok(source.includes("// <<< ORVANTA-CAPABILITIES-SOURCE"))
  assert.ok(source.includes("export const sciV2ArchivedBody = ["))
  assert.ok(source.includes("export const sciE2ArchivedBody = ["))
})

test("the SOURCE|HASH row is filled and self-consistent", () => {
  for (const { helper, archive, branch, carrier, hash } of carriers) {
    const joined = carrier.join("\n")
    assert.ok(!joined.includes("ORVANTAHASHSLOT"), "a hash slot was left unfilled")
    // The row is assembled from four 16-character literals over two CONCATENATE statements, so the
    // digest never appears contiguously and must be read back out of that row alone.
    const rowStart = joined.indexOf("SOURCE|HASH|")
    const firstInto = joined.indexOf("INTO", rowStart)
    const rowEnd = joined.indexOf("INTO", firstInto + 4)
    const row = joined.slice(rowStart, rowEnd)
    const groups = [...row.matchAll(/'([0-9a-f]{16})'/g)].map((match) => String(match[1]))
    assert.equal(groups.length, 4, `${helper}: expected four hash groups in the SOURCE|HASH row`)
    const written = groups.join("")
    const insertion = archive.indexOf(INSERTION_ANCHOR)
    const slotBearing = [...archive.slice(0, insertion), ...branch, ...archive.slice(insertion)]
    assert.equal(written, createHash("sha256").update(slotBearing.join("\n")).digest("hex"))
    assert.equal(written, hash === SCI_V2_CARRIER_HASH ? SCI_V2_SLOT_DIGEST : SCI_E2_SLOT_DIGEST)
    assert.ok(joined.includes("'\"SOURCE|HASH|' '"))
  }
})

test("the generated branches stay inside the ECC 7.31 source limits", () => {
  for (const { branch, carrier } of carriers) {
    // No new line may exceed the ABAP 72-character source limit, and neither frozen baseline has a
    // legacy over-length line, so the whole rendered carrier must stay within it.
    for (const line of branch) {
      assert.ok(line.length <= 72, `generated branch line exceeds 72 characters: ${line}`)
    }
    for (const line of carrier) {
      assert.ok(line.length <= 72, `generated carrier line exceeds 72 characters: ${line}`)
    }
    // No 7.40+ constructs and no state-changing or blocking statements in a self-description.
    const joined = branch.join("\n")
    for (const forbidden of ["@", "VALUE(", "DATA(", "COND ", "SWITCH ", "REDUCE ", "FILTER "]) {
      assert.ok(
        !joined.includes(forbidden),
        `forbidden 7.40+ construct in the branch: ${forbidden}`
      )
    }
    for (const forbidden of [
      "COMMIT WORK",
      "CALL FUNCTION",
      "INSERT ",
      "UPDATE ",
      "DELETE ",
      "MODIFY ",
      "WRITE "
    ]) {
      assert.ok(!joined.includes(forbidden), `branch must stay read-only: ${forbidden}`)
    }
  }
})
