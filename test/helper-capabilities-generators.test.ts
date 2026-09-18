import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"
import { MAINTENANCE_HELPER } from "../src/maintenance-diagnostics.js"
import { OPERATIONAL_LOG_HELPER } from "../src/operational-logs.js"

// Offline drift test for the CAPABILITIES self-description of the two generators that are not
// part of scripts/bootstrap-sap-helper.ps1 (that one keeps its own suite in
// test/helper-capabilities-payload.test.ts):
//
//   scripts/maintenance-diagnostic-source.mjs -> Z_ORVANTA_MAINT_READ (3 CASE branches)
//   scripts/operational-log-source.mjs        -> Z_ORVANTA_OPS_READ    (up to 5 CASE branches)
//
// Only the generator text is parsed and the generated ABAP is rendered in memory: no
// PowerShell, no deploy script and no SAP system is executed or contacted.
//
// Unlike the repository helper these bodies have no `it_source` table. Their only response
// channel is the EV_RESULT JSON string, so the payload rows travel as the `payload` array of
// that same envelope. The envelope keeps `"version":"1"` and `"readOnly":true`, which are the
// values the service already validates (src/maintenance-diagnostics.ts, src/operational-logs.ts).

interface Operation {
  opcode: string
  since: string
  mode: "R" | "W"
  requires?: string
}

interface GeneratedVariant {
  label: string
  file: string
  helper: string
  lines: string[]
  features: { spool: boolean; parameters: boolean }
  /** Actions the body answers before `CASE iv_action` and therefore outside the CASE. */
  preCaseOpcodes: string[]
  packageName: string
  transport: string
}

const maintFile = "scripts/maintenance-diagnostic-source.mjs"
const opsFile = "scripts/operational-log-source.mjs"
const maintSource = await readFile(maintFile, "utf8")
const opsSource = await readFile(opsFile, "utf8")
const maintModule = await import(pathToFileURL(resolve(maintFile)).href)
const opsModule = await import(pathToFileURL(resolve(opsFile)).href)

const variants: GeneratedVariant[] = [
  {
    label: MAINTENANCE_HELPER,
    file: maintFile,
    helper: MAINTENANCE_HELPER,
    lines: maintModule.maintenanceDiagnosticSource as string[],
    features: { spool: false, parameters: false },
    preCaseOpcodes: [],
    packageName: "ZABAP",
    transport: "GR2K923472|GR2K923473"
  },
  {
    label: `${OPERATIONAL_LOG_HELPER} (base)`,
    file: opsFile,
    helper: OPERATIONAL_LOG_HELPER,
    lines: opsModule.operationalLogSource as string[],
    features: { spool: false, parameters: false },
    preCaseOpcodes: [],
    packageName: "ZABAP",
    transport: "GR2K923472|GR2K923473"
  },
  {
    label: `${OPERATIONAL_LOG_HELPER} (spool)`,
    file: opsFile,
    helper: OPERATIONAL_LOG_HELPER,
    lines: opsModule.operationalLogSpoolSource as string[],
    features: { spool: true, parameters: false },
    preCaseOpcodes: [],
    packageName: "ZABAP",
    transport: "GR2K923472|GR2K923473"
  },
  {
    label: `${OPERATIONAL_LOG_HELPER} (report parameters)`,
    file: opsFile,
    helper: OPERATIONAL_LOG_HELPER,
    lines: opsModule.operationalLogReportSource as string[],
    features: { spool: true, parameters: true },
    preCaseOpcodes: ["REPORT_PARAMETERS"],
    packageName: "ZABAP",
    transport: "GR2K923472|GR2K923473"
  }
]

const sliceBetween = (source: string, start: string, end: string): string => {
  const from = source.indexOf(start)
  assert.ok(from >= 0, `missing anchor: ${start}`)
  const to = source.indexOf(end, from + start.length)
  assert.ok(to > from, `missing anchor: ${end}`)
  return source.slice(from + start.length, to)
}

/**
 * The single opcode table of a generator, read from its marked block. `since` is the protocol
 * revision of the reply envelope the opcode's own branch answers with and `requires` names the
 * optional generator feature that compiles the branch in.
 */
const readTable = (source: string, file: string): Operation[] => {
  const block = sliceBetween(
    source,
    "// >>> ORVANTA-CAPABILITY-TABLE",
    "// <<< ORVANTA-CAPABILITY-TABLE"
  )
  const entries = [
    ...block.matchAll(
      /opcode: "([A-Z0-9_]+)",\s*since: "(\d+\.\d+)",\s*mode: "([RW])"(?:,\s*requires: "([a-z]+)")?/g
    )
  ].map((match) => ({
    opcode: String(match[1]),
    since: String(match[2]),
    mode: String(match[3]) as "R" | "W",
    ...(match[4] ? { requires: String(match[4]) } : {})
  }))
  assert.ok(entries.length > 0, `${file}: capability table is empty or unparsable`)
  assert.equal(
    new Set(entries.map((entry) => entry.opcode)).size,
    entries.length,
    `${file}: duplicate opcode in the capability table`
  )
  return entries
}

const maintTable = readTable(maintSource, maintFile)
const opsTable = readTable(opsSource, opsFile)

/** The first WHEN..next WHEN slice of the CASE iv_action dispatcher for one generated body. */
const capabilityBranch = (variant: GeneratedVariant): string[] => {
  const start = variant.lines.findIndex((line) => line.trim() === "WHEN 'CAPABILITIES'.")
  assert.ok(start >= 0, `${variant.label}: CAPABILITIES WHEN not found`)
  const end = variant.lines.findIndex((line, index) => index > start && /^  WHEN '/.test(line))
  assert.ok(end > start, `${variant.label}: CAPABILITIES is not followed by another WHEN`)
  return variant.lines.slice(start, end)
}

/** Every payload row the branch appends as a literal (RUNTIME rows and SOURCE|HASH are built). */
const literalRows = (branch: string[]): string[] =>
  branch
    .map((line) => /^\s*APPEND '([^']*)' TO lt_capability\.$/.exec(line)?.[1])
    .filter((row): row is string => typeof row === "string")

const operationRows = (branch: string[]): Operation[] =>
  literalRows(branch)
    .filter((row) => row.startsWith("OPERATION|"))
    .map((row) => {
      const [, opcode = "", since = "", mode = ""] = row.split("|")
      return { opcode, since, mode: mode === "W" ? ("W" as const) : ("R" as const) }
    })

/**
 * The opcodes the generated body actually dispatches on: every CASE WHEN except CAPABILITIES
 * itself, which is the self-description.
 */
const caseOpcodes = (variant: GeneratedVariant): string[] => {
  const start = variant.lines.findIndex((line) => line.trim() === "CASE iv_action.")
  assert.ok(start >= 0, `${variant.label}: CASE iv_action not found`)
  const opcodes: string[] = []
  for (const line of variant.lines.slice(start + 1)) {
    if (line.trim() === "ENDCASE.") break
    const opcode = /^  WHEN '([A-Z0-9_]+)'\.$/.exec(line)?.[1]
    if (opcode && opcode !== "CAPABILITIES") opcodes.push(opcode)
  }
  assert.ok(opcodes.length > 0, `${variant.label}: no opcode after CAPABILITIES`)
  return opcodes
}

/**
 * The protocol revision the body's own reply envelope reports (`lv_json = '{"version":"1"'`),
 * written as x.y because that is the form PROTOCOL|MIN / PROTOCOL|MAX and the other helpers use.
 */
const envelopeProtocol = (variant: GeneratedVariant): string => {
  const match = /'{"version":"(\d+)"'/.exec(variant.lines.join("\n"))
  assert.ok(match, `${variant.label}: reply envelope version not found`)
  return `${String(match[1])}.0`
}

const hashGroups = (variant: GeneratedVariant): string[] => {
  const match =
    /'SOURCE\|HASH\|'\s+'([0-9a-f]{16})'\s+'([0-9a-f]{16})'\s+'([0-9a-f]{16})'\s+'([0-9a-f]{16})'/.exec(
      variant.lines.join("\n")
    )
  assert.ok(match, `${variant.label}: SOURCE|HASH row not found`)
  return match.slice(1).map(String)
}

// Lines that were already longer than the 72-character ABAP source limit before the CAPABILITIES
// branch existed. The module owns that list (it throws on any other longer line); this suite
// independently asserts that exactly these legacy comments exceed the limit.
const legacyOverLengthComments = [
  "* No direct RFC table bypass: exact current-client job and SHOW checked above.",
  "* Reject configured alternate authorization modes before any customer exit.",
  "* Use the SAP spool permission path; job display is not spool authorization.",
  "* Clear saved list memory before rendering, including reused RFC sessions."
]

test("the CAPABILITIES branch is the first WHEN of the action dispatcher", () => {
  for (const variant of variants) {
    const caseAt = variant.lines.findIndex((line) => line.trim() === "CASE iv_action.")
    assert.ok(caseAt >= 0, `${variant.label}: CASE iv_action not found`)
    assert.equal(
      variant.lines[caseAt + 1]?.trim(),
      "WHEN 'CAPABILITIES'.",
      `${variant.label}: CAPABILITIES must be the first WHEN`
    )
    const branch = capabilityBranch(variant)
    // The branch answers and returns; it must never fall through into the read logic.
    assert.equal(branch.at(-1)?.trim(), "RETURN.", `${variant.label}: branch must end with RETURN`)
    assert.equal(
      branch.filter((line) => line.trim() === "RETURN.").length,
      1,
      `${variant.label}: single RETURN path`
    )
    assert.equal(
      branch.at(-2)?.trim(),
      "CONCATENATE lv_capability lv_capabilities ']}' INTO ev_result."
    )
  }
})

test("CAPABILITIES is reachable without caller input, validation or business authority", () => {
  // A self-description that sits behind the request gate is unreachable: the maintenance helper
  // requires IV_USER and an ADMIN/UADM authority check, the operational helper requires an exact
  // job key and date window for most actions.
  const maintLines = variants[0]?.lines ?? []
  const gateAt = maintLines.findIndex((line) => line.trim() === "IF iv_action <> 'CAPABILITIES'.")
  const maintCaseAt = maintLines.findIndex((line) => line.trim() === "CASE iv_action.")
  assert.ok(gateAt > 0 && gateAt < maintCaseAt, "maintenance gate must skip CAPABILITIES")
  assert.ok(
    maintLines.slice(gateAt, maintCaseAt).some((line) => line.includes("ENDIF.")),
    "maintenance gate must be closed before the CASE"
  )
  for (const variant of variants.filter((item) => item.file === opsFile)) {
    const guard = variant.lines.findIndex(
      (line) => line.trim() === "IF iv_action <> 'CAPABILITIES'"
    )
    const caseAt = variant.lines.findIndex((line) => line.trim() === "CASE iv_action.")
    assert.ok(guard > 0 && guard < caseAt, `${variant.label}: guard must pass CAPABILITIES`)
  }
  for (const variant of variants) {
    assert.doesNotMatch(
      capabilityBranch(variant).join("\n"),
      /\biv_[a-z_]+\b/,
      `${variant.label}: the self-description must not depend on request input`
    )
  }
})

test("the opcode table is the only opcode list for its dispatcher", () => {
  const tables = new Map([
    [maintFile, maintTable],
    [opsFile, opsTable]
  ])
  for (const variant of variants) {
    const table = tables.get(variant.file) ?? []
    const expectedRows = table.filter(
      (entry) =>
        (entry.requires !== "spool" || variant.features.spool) &&
        (entry.requires !== "parameters" || variant.features.parameters)
    )
    const rows = operationRows(capabilityBranch(variant))
    assert.deepEqual(
      rows,
      expectedRows.map(({ opcode, since, mode }) => ({ opcode, since, mode })),
      `${variant.label}: OPERATION rows must come from the table`
    )
    // The CASE serves the table opcodes; REPORT_PARAMETERS is answered before the CASE.
    assert.deepEqual(
      [...caseOpcodes(variant)].sort(),
      rows
        .map((row) => row.opcode)
        .filter((opcode) => !variant.preCaseOpcodes.includes(opcode))
        .sort(),
      `${variant.label}: table opcodes must equal the CASE opcodes`
    )
    for (const opcode of variant.preCaseOpcodes) {
      assert.match(
        variant.lines.join("\n"),
        new RegExp(`^IF iv_action = '${opcode}'\\.$`, "m"),
        `${variant.label}: ${opcode} is claimed but not served before the CASE`
      )
    }
    if (!variant.features.parameters) {
      assert.deepEqual(
        rows.filter((row) => row.opcode === "REPORT_PARAMETERS"),
        [],
        `${variant.label}: REPORT_PARAMETERS must not be advertised`
      )
    }
  }
  // The emission block reads the table instead of naming opcodes again.
  const maintEmission = sliceBetween(
    maintSource,
    "// >>> ORVANTA-CAPABILITIES-SOURCE",
    "// <<< ORVANTA-CAPABILITIES-SOURCE"
  )
  const opsEmission = sliceBetween(
    opsSource,
    "// >>> ORVANTA-CAPABILITIES-SOURCE",
    "// <<< ORVANTA-CAPABILITIES-SOURCE"
  )
  assert.match(maintEmission, /maintenanceDiagnosticOperations\.map\(/)
  assert.match(opsEmission, /operations\.map\(/)
  for (const [file, emission] of [
    [maintFile, maintEmission],
    [opsFile, opsEmission]
  ] as Array<[string, string]>) {
    assert.doesNotMatch(emission, /OPERATION\|[A-Z]/, `${file}: no second opcode list`)
  }
})

test("the table names the helper the service probes", () => {
  for (const variant of variants) {
    const rows = literalRows(capabilityBranch(variant))
    assert.equal(rows[0], `HELPER|${variant.helper}`, `${variant.label}: HELPER row`)
  }
  // The function module name comes from the definition constant, never from a second literal.
  for (const [file, source] of [
    [maintFile, maintSource],
    [opsFile, opsSource]
  ] as Array<[string, string]>) {
    assert.doesNotMatch(
      sliceBetween(
        source,
        "// >>> ORVANTA-CAPABILITIES-SOURCE",
        "// <<< ORVANTA-CAPABILITIES-SOURCE"
      ),
      /HELPER\|Z_ORVANTA/,
      `${file}: the helper name must be interpolated`
    )
  }
  assert.equal(maintModule.maintenanceHelperDefinition.functionName, MAINTENANCE_HELPER)
  assert.equal(opsModule.operationalLogFunctionName, OPERATIONAL_LOG_HELPER)
})

test("each table sinceVersion is the protocol revision the body reports", () => {
  for (const variant of variants) {
    const version = envelopeProtocol(variant)
    const rows = operationRows(capabilityBranch(variant))
    for (const row of rows) {
      assert.match(row.since, /^\d+\.\d+$/, `${variant.label}: ${row.opcode} sinceVersion`)
      assert.equal(row.since, version, `${variant.label}: ${row.opcode} sinceVersion`)
      assert.equal(row.mode, "R", `${variant.label}: these helpers are read-only`)
    }
    for (const entry of variant.file === maintFile ? maintTable : opsTable) {
      assert.equal(entry.since, version, `${variant.label}: table sinceVersion`)
    }
  }
})

test("PROTOCOL|MIN and PROTOCOL|MAX are derived from the operation rows", () => {
  const compare = (left: string, right: string): number => {
    const [leftMajor = 0, leftMinor = 0] = left.split(".").map(Number)
    const [rightMajor = 0, rightMinor = 0] = right.split(".").map(Number)
    return leftMajor - rightMajor || leftMinor - rightMinor
  }
  for (const variant of variants) {
    const rows = literalRows(capabilityBranch(variant))
    const versions = operationRows(capabilityBranch(variant))
      .map((row) => row.since)
      .sort(compare)
    const min = rows.find((row) => row.startsWith("PROTOCOL|MIN|"))
    const max = rows.find((row) => row.startsWith("PROTOCOL|MAX|"))
    assert.equal(min, `PROTOCOL|MIN|${versions[0]}`, `${variant.label}: PROTOCOL|MIN`)
    assert.equal(max, `PROTOCOL|MAX|${versions.at(-1)}`, `${variant.label}: PROTOCOL|MAX`)
  }
  for (const [file, source] of [
    [maintFile, maintSource],
    [opsFile, opsSource]
  ] as Array<[string, string]>) {
    const emission = sliceBetween(
      source,
      "// >>> ORVANTA-CAPABILITIES-SOURCE",
      "// <<< ORVANTA-CAPABILITIES-SOURCE"
    )
    assert.match(emission, /versions\[0\]|maintenanceDiagnosticMinProtocol/)
    assert.match(emission, /versions\.at\(-1\)|maintenanceDiagnosticMaxProtocol/)
    assert.doesNotMatch(emission, /'PROTOCOL\|MIN\|\d/)
    assert.doesNotMatch(emission, /'PROTOCOL\|MAX\|\d/)
  }
  const maintDerivation = sliceBetween(
    maintSource,
    "// <<< ORVANTA-CAPABILITY-TABLE",
    "// <<< ORVANTA-CAPABILITIES-SOURCE"
  )
  assert.doesNotMatch(maintDerivation, /"\d+\.\d+"/, "no hand-written version constant")
})

test("the payload rows keep their protocol shape and order", () => {
  for (const variant of variants) {
    const branch = capabilityBranch(variant)
    const rows = literalRows(branch)
    const rowFor = (prefix: string): string | undefined =>
      rows.find((row) => row.startsWith(prefix))
    for (const [prefix, fields] of [
      ["HELPER|", 2],
      ["PROTOCOL|MIN|", 3],
      ["PROTOCOL|MAX|", 3],
      ["SOURCE|PACKAGE|", 3],
      ["SOURCE|TRANSPORT|", 4]
    ] as Array<[string, number]>) {
      const row = rowFor(prefix)
      assert.ok(row, `${variant.label}: missing ${prefix} row`)
      assert.equal(row.split("|").length, fields, `${variant.label}: ${prefix} fields`)
    }
    for (const row of operationRows(branch)) {
      assert.match(row.opcode, /^[A-Z0-9_]+$/, `${variant.label}: opcode shape`)
      assert.equal(
        rows.filter((candidate) => candidate.startsWith(`OPERATION|${row.opcode}|`)).length,
        1,
        `${variant.label}: ${row.opcode} must be described once`
      )
    }
    assert.equal(rowFor("SOURCE|PACKAGE|"), `SOURCE|PACKAGE|${variant.packageName}`)
    if (variant.transport === "") {
      // Forward guard: a variant whose deployment is not recorded yet (the maintenance helper's
      // old state) must still emit the four protocol fields. No variant is in that state today -
      // Z_ORVANTA_MAINT_READ and Z_ORVANTA_OPS_READ are both deployed under
      // GR2K923472|GR2K923473 - so this keeps the contract covered for the next helper.
      assert.equal(rowFor("SOURCE|TRANSPORT|"), "SOURCE|TRANSPORT||")
      assert.equal(rowFor("SOURCE|TRANSPORT|")?.split("|").length, 4)
    } else {
      assert.equal(rowFor("SOURCE|TRANSPORT|"), `SOURCE|TRANSPORT|${variant.transport}`)
      assert.equal(rowFor("SOURCE|TRANSPORT|")?.split("|").length, 4)
    }
    // Every payload row is appended exactly once.
    const appends = branch.filter((line) => /^\s*APPEND .* TO lt_capability\.$/.test(line)).length
    assert.equal(
      appends,
      rows.length + 3,
      `${variant.label}: SOURCE|HASH, RUNTIME|HOST and RUNTIME|TIME must be appended too`
    )
    const order = [
      "'HELPER|",
      "'PROTOCOL|MIN|",
      "'PROTOCOL|MAX|",
      "OPERATION|",
      "'SOURCE|HASH|",
      "'SOURCE|PACKAGE|",
      "'SOURCE|TRANSPORT|",
      "'RUNTIME|HOST|",
      "'RUNTIME|TIME|"
    ]
    let previous = -1
    for (const marker of order) {
      const index = branch.join("\n").indexOf(marker)
      assert.ok(index > previous, `${variant.label}: ${marker} must follow the protocol order`)
      previous = index
    }
    assert.match(branch.join("\n"), /CONCATENATE sy-sysid sy-mandt INTO lv_capability_value/)
    assert.match(branch.join("\n"), /CONCATENATE sy-datum sy-uzeit INTO lv_capability_value\./)
  }
})

test("SOURCE|HASH is a reproducible placeholder substitution", () => {
  const slots = ["ORVANTAHASHSLOT1", "ORVANTAHASHSLOT2", "ORVANTAHASHSLOT3", "ORVANTAHASHSLOT4"]
  for (const variant of variants) {
    let text = variant.lines.join("\n")
    const groups = hashGroups(variant)
    assert.equal(groups.length, 4, `${variant.label}: four hash slots`)
    groups.forEach((group, index) => {
      assert.match(group, /^[0-9a-f]{16}$/, `${variant.label}: lowercase hex slot`)
      const slot = slots[index] ?? ""
      assert.equal(text.split(group).length, 2, `${variant.label}: ${slot} must appear once`)
      text = text.replace(group, slot)
    })
    assert.equal(
      createHash("sha256").update(text, "utf8").digest("hex"),
      groups.join(""),
      `${variant.label}: SOURCE|HASH must be the SHA-256 of the body with its slots in place`
    )
    for (const slot of slots) {
      assert.equal(slot.length, 16, "placeholders must keep the hash length")
    }
  }
  for (const [file, source] of [
    [maintFile, maintSource],
    [opsFile, opsSource]
  ] as Array<[string, string]>) {
    assert.match(source, /createHash\("sha256"\)\.update\(lines\.join\("\\n"\), "utf8"\)/)
    assert.match(source, /digest\("hex"\)/)
    assert.match(
      source,
      /text\.replaceAll\(slot, digest\.slice\(index \* 16, index \* 16 \+ 16\)\)/
    )
    assert.match(source, /\(operation\) => `OPERATION\|/)
  }
})

test("the CAPABILITIES branch only uses character-like operands and declares its fields", () => {
  // ABAP CONCATENATE accepts only character-like operands (C, N, D, T, STRING) and WRITE ... TO
  // rejects STRING targets. sy-tzone is numeric, so it is converted by assignment into a STRING
  // work field first; passing it to CONCATENATE raised GENERATE_ERROR 943 on w200 and using
  // WRITE ... TO with a STRING target raised 944.
  // sy-tabix is only read in the IF condition that separates the JSON rows, never passed to
  // CONCATENATE or WRITE, so it is safe alongside the character-like fields.
  const allowedSystemFields = [
    "sy-datum",
    "sy-mandt",
    "sy-sysid",
    "sy-tabix",
    "sy-tzone",
    "sy-uzeit"
  ]
  for (const variant of variants) {
    const branch = capabilityBranch(variant)
    const systemFields = [
      ...new Set(
        branch.flatMap((line) =>
          [...line.matchAll(/\bsy-[a-z]+\b/g)].map((match) => String(match[0]))
        )
      )
    ].sort()
    assert.deepEqual(
      systemFields.filter((field) => !allowedSystemFields.includes(field)),
      [],
      `${variant.label}: only verified character-like system fields may be used`
    )
    for (const line of branch) {
      if (/\bCONCATENATE\b/.test(line) || /\bWRITE\b/.test(line)) {
        assert.doesNotMatch(
          line,
          /\bsy-tabix\b/,
          `${variant.label}: sy-tabix must never be a CONCATENATE or WRITE operand`
        )
      }
    }
    const tzoneLines = branch.filter((line) => /\bsy-tzone\b/.test(line))
    assert.equal(tzoneLines.length, 1, `${variant.label}: sy-tzone must be used exactly once`)
    const conversion = /^\s*([A-Za-z0-9_]+) = sy-tzone\.$/.exec(tzoneLines[0] ?? "")
    assert.ok(conversion, `${variant.label}: sy-tzone must be converted by assignment`)
    const workField = String(conversion?.[1])
    assert.match(branch.join("\n"), new RegExp(`CONDENSE ${workField} NO-GAPS\\.`))
    assert.match(
      branch.join("\n"),
      new RegExp(`CONCATENATE 'RUNTIME\\|TIME\\|' lv_capability_value '\\|' ${workField}`)
    )
    for (const line of branch) {
      if (/\bCONCATENATE\b/.test(line)) {
        assert.doesNotMatch(line, /\bsy-tzone\b/, "sy-tzone must never be a CONCATENATE operand")
      }
    }
    assert.doesNotMatch(branch.join("\n"), /\bWRITE\b/, `${variant.label}: no WRITE statement`)
    // Every work field the branch uses is declared in the body before the CASE.
    const body = variant.lines.join("\n")
    const caseAt = body.indexOf("CASE iv_action.")
    for (const [declaration, type] of [
      ["lt_capability", "TYPE STANDARD TABLE OF string"],
      ["lv_capability", "TYPE string"],
      ["lv_capabilities", "TYPE string"],
      ["lv_capability_value", "TYPE string"],
      [workField, "TYPE string"]
    ] as Array<[string, string]>) {
      const declared = new RegExp(`\\b${declaration} ${type}[,.]`).exec(body)
      assert.ok(declared, `${variant.label}: ${declaration} must be declared as ${type}`)
      assert.ok(
        (declared?.index ?? body.length) < caseAt,
        `${variant.label}: ${declaration} must be declared before the dispatcher`
      )
    }
  }
})

test("every generated line is at most 72 characters", () => {
  for (const variant of variants) {
    if (variant.file === maintFile) {
      assert.deepEqual(
        variant.lines.filter((line) => line.length > 72),
        [],
        `${variant.label}: no line may exceed the ABAP source limit`
      )
    } else {
      const over = variant.lines.filter((line) => line.length > 72)
      for (const line of over) {
        assert.ok(
          legacyOverLengthComments.includes(line),
          `${variant.label}: new over-length line exceeds 72 characters: ${line}`
        )
        assert.match(line, /^\*/, "only legacy comment lines may exceed the limit")
      }
    }
    assert.deepEqual(
      capabilityBranch(variant).filter((line) => line.length > 72),
      [],
      `${variant.label}: the CAPABILITIES branch must fit the ABAP source limit`
    )
  }
  assert.deepEqual(
    opsModule.operationalOverLengthComments,
    legacyOverLengthComments,
    "the generator's exception list must stay the documented one"
  )
})

test("CAPABILITIES is a read-only self-description without negotiation or scope claims", () => {
  for (const variant of variants) {
    const branch = capabilityBranch(variant)
    const text = branch.join("\n")
    // The reply reuses this helper's own EV_RESULT envelope with the frozen values the service
    // already validates; no new status/code vocabulary is introduced.
    assert.equal(literalRows(branch)[1], `PROTOCOL|MIN|${envelopeProtocol(variant)}`)
    assert.match(text, /'\{"version":"1","status":"S",'/)
    assert.match(text, /'"code":"CAPABILITIES",'/)
    assert.match(text, /'"message":"ORVANTA helper capabilities",'/)
    assert.match(text, /'"readOnly":true,"payload":\['/)
    assert.deepEqual(
      [...new Set([...text.matchAll(/\b(ev_[a-z_]+)\b/g)].map((match) => String(match[1])))],
      ["ev_result"],
      `${variant.label}: only the existing EV_RESULT reply channel is written`
    )
    assert.doesNotMatch(
      text,
      /\b(INSERT|UPDATE|DELETE|MODIFY|COMMIT|ROLLBACK|CALL|PERFORM|AUTHORITY-CHECK|ENQUEUE|DEQUEUE|SUBMIT|SELECT|OPEN DATASET)\b/,
      `${variant.label}: the branch must be read-only and must not reach business logic`
    )
    assert.doesNotMatch(text, /iv_expected_version|CHECK\|EXPECTED/)
    assert.doesNotMatch(text, /\|W"/, `${variant.label}: no write operation may be advertised`)
    // Scope approvals for these helpers live in the local approval files
    // (maintenance-diagnostic-approvals.json / operational-log-approvals.json enabledSources),
    // so the generated body has no authoritative scope table to publish.
    assert.doesNotMatch(text, /'SCOPE\|/, `${variant.label}: no scope rows without scope data`)
  }
  // No import parameter was added for the new opcode.
  assert.deepEqual(
    maintModule.maintenanceHelperDefinition.importParameters.map(
      (parameter: { name: string }) => parameter.name
    ),
    [
      "IV_ACTION",
      "IV_USER",
      "IV_TABLE",
      "IV_OBJECT",
      "IV_ARGUMENT",
      "IV_FROM",
      "IV_TO",
      "IV_KEY",
      "IV_LIMIT"
    ]
  )
  assert.deepEqual(
    maintModule.maintenanceHelperDefinition.exportParameters.map(
      (parameter: { name: string }) => parameter.name
    ),
    ["EV_RESULT"]
  )
})
