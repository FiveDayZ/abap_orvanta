import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { helperCapabilityRoutes } from "../src/capabilities.js"

// Offline drift test for the CAPABILITIES self-description of the repository helper
// body in scripts/bootstrap-sap-helper.ps1. It only parses the generator text: no
// PowerShell is executed and no SAP system is contacted.

const scriptPath = "scripts/bootstrap-sap-helper.ps1"
const source = await readFile(scriptPath, "utf8")

interface Operation {
  opcode: string
  since: string
  mode: "R" | "W"
}

const sliceBetween = (start: string, end: string): string => {
  const from = source.indexOf(start)
  assert.ok(from >= 0, `missing anchor: ${start}`)
  const to = source.indexOf(end, from + start.length)
  assert.ok(to > from, `missing anchor: ${end}`)
  return source.slice(from + start.length, to)
}

const tableBlock = sliceBetween("# >>> ORVANTA-CAPABILITY-TABLE", "# <<< ORVANTA-CAPABILITY-TABLE")
const emissionBlock = sliceBetween(
  "# >>> ORVANTA-CAPABILITIES-SOURCE",
  "# <<< ORVANTA-CAPABILITIES-SOURCE"
)

const operations: Operation[] = [...tableBlock.matchAll(/"([A-Z0-9_]+)\|(\d+\.\d+)\|([RW])"/g)].map(
  (match) => ({
    opcode: String(match[1]),
    since: String(match[2]),
    mode: String(match[3]) as "R" | "W"
  })
)

// The repository CASE (second CASE iv_operation of the script, behind the anchors).
const caseStart = source.indexOf(
  '"  CASE iv_operation."',
  source.indexOf("# <<< ORVANTA-CAPABILITIES-SOURCE")
)
assert.ok(caseStart > 0, "repository CASE iv_operation not found")
const caseAbapLines: string[] = []
for (const rawLine of source.slice(caseStart).split("\n")) {
  const match = /^\s*"(.*?)",?\s*$/.exec(rawLine)
  if (!match) continue
  const abap = String(match[1])
  if (abap === "  ENDCASE.") break
  caseAbapLines.push(abap)
}

const caseOpcodes: string[] = []
const branchVersions = new Map<string, string[]>()
// A top-level WHEN clause can carry several opcodes ('X' OR 'Y'.) and can be continued on the
// following source line, so the whole clause is accumulated before its opcodes are read. The
// versions reported anywhere inside that clause belong to every opcode it names.
let clause: string | null = null
let clauseOpcodes: string[] = []
const closeClause = (): void => {
  if (clause === null) return
  clauseOpcodes = [...clause.matchAll(/'([A-Z0-9_]+)'/g)].map((match) => String(match[1]))
  for (const opcode of clauseOpcodes) {
    caseOpcodes.push(opcode)
    branchVersions.set(opcode, [])
  }
  clause = null
}
for (const abap of caseAbapLines) {
  if (/^    WHEN /.test(abap)) {
    closeClause()
    clause = abap.trim()
  } else if (clause !== null) {
    clause += ` ${abap.trim()}`
  }
  if (clause !== null && clause.endsWith(".")) closeClause()
  const version = /ev_version = '(\d+\.\d+)'/.exec(abap)
  if (version && clause === null) {
    for (const opcode of clauseOpcodes) branchVersions.get(opcode)?.push(String(version[1]))
  }
}
closeClause()

const compareVersions = (left: string, right: string): number => {
  const [leftMajor = 0, leftMinor = 0] = left.split(".").map(Number)
  const [rightMajor = 0, rightMinor = 0] = right.split(".").map(Number)
  return leftMajor - rightMajor || leftMinor - rightMinor
}
const sortedVersions = (versions: string[]): string[] => [...versions].sort(compareVersions)

test("the table is the only opcode list for the repository CASE", () => {
  const declaredEntries = tableBlock.split("\n").filter((line) => line.trim().startsWith('"'))
  assert.equal(declaredEntries.length, operations.length, "every table line must parse")
  assert.equal(
    new Set(operations.map((operation) => operation.opcode)).size,
    operations.length,
    "duplicate opcode in the table"
  )
  assert.deepEqual([...caseOpcodes].sort(), operations.map((operation) => operation.opcode).sort())
  assert.match(emissionBlock, /^\s*"    WHEN 'CAPABILITIES'\."\s*,?\s*$/m)
  // The branch lines are spliced directly behind CASE iv_operation., so CAPABILITIES
  // is the first WHEN of the repository CASE.
  assert.match(source, /"  CASE iv_operation\."\s*\n\s*\) \+ \$capabilityBranchLines \+ @\(/)
})

test("the table matches the service-side SapRepositoryOperation union", async () => {
  // Independent expectation: the union the service already dispatches on. The table plus the
  // self-description opcode must cover exactly the same operations.
  const backendSource = await readFile("src/backend.ts", "utf8")
  const unionStart = backendSource.indexOf("export type SapRepositoryOperation =")
  const unionEnd = backendSource.indexOf("export type SapStructureRow", unionStart)
  assert.ok(unionStart > 0 && unionEnd > unionStart, "SapRepositoryOperation union not found")
  const serviceOpcodes = [
    ...backendSource.slice(unionStart, unionEnd).matchAll(/"([A-Z0-9_]+)"/g)
  ].map((match) => String(match[1]))
  assert.deepEqual(
    [...operations.map((operation) => operation.opcode), "CAPABILITIES"].sort(),
    [...serviceOpcodes].sort()
  )
})

test("every table sinceVersion is the highest ev_version of its own branch", () => {
  for (const operation of operations) {
    const versions = branchVersions.get(operation.opcode) ?? []
    assert.ok(versions.length > 0, `${operation.opcode} must report an ev_version`)
    assert.equal(operation.since, sortedVersions(versions).at(-1), operation.opcode)
  }
})

test("PROTOCOL|MIN and PROTOCOL|MAX are derived from the table", () => {
  const branchVersionList = [...branchVersions.values()].flat()
  const tableVersions = operations.map((operation) => operation.since)
  assert.equal(sortedVersions(tableVersions).at(-1), sortedVersions(branchVersionList).at(-1))
  assert.equal(sortedVersions(tableVersions)[0], sortedVersions(branchVersionList)[0])
  assert.match(emissionBlock, /ls_source-line = 'PROTOCOL\|MIN\|\$helperCapabilityMinVersion'\./)
  assert.match(emissionBlock, /ls_source-line = 'PROTOCOL\|MAX\|\$helperCapabilityMaxVersion'\./)
  assert.match(emissionBlock, /ev_version = '\$helperCapabilityMaxVersion'\./)
  assert.doesNotMatch(emissionBlock, /'PROTOCOL\|MAX\|\d/)
  const derivation = sliceBetween("$helperCapabilityVersions = ", "function New-InspectionProgram")
  assert.match(derivation, /\[version\]\$capabilityTableParts\[1\]/)
  assert.match(derivation, /Sort-Object -Descending/)
  assert.doesNotMatch(derivation, /"[0-9]+\.[0-9]"/, "no hand-written version constant")
})

test("the OPERATION rows are generated from the table", () => {
  assert.match(emissionBlock, /foreach \(\$capabilityOperation in \$helperCapabilityOperations\)/)
  assert.match(emissionBlock, /\$capabilityOperationParts = \$capabilityOperation -split "\\\|"/)
  assert.match(emissionBlock, /'OPERATION\|\$\(\$capabilityOperationParts\[0\]\)'/)
  assert.match(
    emissionBlock,
    /'\$\(\$capabilityOperationParts\[1\]\)\|\$\(\$capabilityOperationParts\[2\]\)'/
  )
  for (const operation of operations) {
    assert.match(operation.opcode, /^[A-Z0-9_]+$/)
    assert.match(operation.since, /^\d+\.\d+$/)
    assert.ok(operation.mode === "R" || operation.mode === "W")
    assert.equal(
      operation.mode === "R",
      /^(READ|INSPECT)_/.test(operation.opcode),
      `${operation.opcode} must be ${operation.mode}`
    )
  }
})

test("the payload rows keep their protocol shape", () => {
  const variables: Record<string, string> = {
    $FunctionName: "Z_ORVANTA_MCP_EXECUTE",
    $helperCapabilityMinVersion: "1.1",
    $helperCapabilityMaxVersion: "2.6",
    $capabilityPackageValue: "ZABAP",
    $capabilityTransportValue: "GR2K923472|GR2K999999"
  }
  const renderedRows = [...emissionBlock.matchAll(/ls_source-line = '([^']*)'\./g)].map((match) =>
    String(match[1]).replace(/\$[A-Za-z]+/g, (name) => variables[name] ?? name)
  )
  const rowFor = (key: string): string | undefined =>
    renderedRows.find((row) => row.startsWith(`${key}|`))
  for (const [key, segments] of [
    ["HELPER", 2],
    ["PROTOCOL|MIN", 3],
    ["PROTOCOL|MAX", 3],
    ["SOURCE|PACKAGE", 3],
    ["SOURCE|TRANSPORT", 4]
  ] as Array<[string, number]>) {
    const row = rowFor(key)
    assert.ok(row, `missing ${key} row`)
    assert.equal(row.split("|").length, segments, key)
  }
  // An empty transport task must still yield four fields.
  assert.equal(
    String(rowFor("SOURCE|TRANSPORT")).replace("GR2K923472|GR2K999999", "GR2K923472|").split("|")
      .length,
    4
  )
  assert.match(emissionBlock, /ls_source-line = 'HELPER\|\$FunctionName'\./)
  assert.doesNotMatch(emissionBlock, /HELPER\|Z_ORVANTA/)
  assert.match(emissionBlock, /@\(\[string\]\$TransportNumber, \[string\]\$TransportTask\)/)
  assert.match(emissionBlock, /\.Replace\("%", "%25"\)\.Replace\("\|", "%7C"\)/)
  assert.match(emissionBlock, /-join "\|"/)
})

test("the RUNTIME|TIME row converts the numeric sy-tzone to text first", () => {
  // Regression guard for the deployed GENERATE_ERROR 943/944: CONCATENATE only accepts
  // character-like operands (so sy-tzone cannot be passed directly) and WRITE ... TO
  // rejects STRING targets (so the offset must be assigned to a STRING work field).
  assert.doesNotMatch(emissionBlock, /CONCATENATE[^\n]*sy-tzone/)
  assert.doesNotMatch(emissionBlock, /WRITE sy-tzone TO/)
  const conversion = /^\s*"      ([A-Za-z0-9_]+) = sy-tzone\."\s*,?\s*$/m.exec(emissionBlock)
  assert.ok(conversion, "sy-tzone must be assigned to a character work field")
  const workField = String(conversion[1])
  assert.match(emissionBlock, new RegExp(`CONDENSE ${workField} NO-GAPS\\.`))
  assert.match(
    emissionBlock,
    new RegExp(`CONCATENATE 'RUNTIME\\|TIME' lv_payload_value ${workField}`)
  )
  const bodyStart = source.indexOf("$repositoryFunctionSource = @(")
  const bodyEnd = source.indexOf(
    '$functionSource = if ($FunctionName -eq "Z_ORVANTA_MCP_DDIC_API")'
  )
  assert.match(
    source.slice(bodyStart, bodyEnd),
    new RegExp(`DATA ${workField} TYPE string\\.`),
    `${workField} must be declared as STRING`
  )
})

test("the SCOPE rows come from the scope table", () => {
  const scopeBlock = sliceBetween(
    "# <<< ORVANTA-CAPABILITY-TABLE",
    "function New-InspectionProgram"
  )
  assert.match(scopeBlock, /\$helperCapabilityScopes = @\(/)
  for (const match of scopeBlock.matchAll(/"([A-Z0-9_]+)\|(enabled|disabled)"/g)) {
    assert.match(String(match[1]), /^[A-Z0-9_]+$/)
  }
  assert.match(emissionBlock, /foreach \(\$capabilityScope in \$helperCapabilityScopes\)/)
  assert.match(emissionBlock, /ls_source-line = 'SCOPE\|\$capabilityScope'\./)
})

test("SOURCE|HASH is a reproducible placeholder substitution", () => {
  // The CONCATENATE that builds SOURCE|HASH| spans two source lines; start at its first line so
  // the placeholder *definitions* above it are not counted.
  const hashLines = emissionBlock.split("\n")
  const hashStart = hashLines.findIndex((line) => line.includes("CONCATENATE 'SOURCE|HASH|'"))
  assert.ok(hashStart >= 0, "SOURCE|HASH| statement not found")
  const hashRows = hashLines.slice(hashStart, hashStart + 2)
  assert.equal(hashRows.length, 2)
  // The statement reads the slots through PowerShell interpolation, so the literal
  // placeholders are defined above it and must stay 16 characters long each.
  const slots = [...emissionBlock.matchAll(/"(ORVANTAHASHSLOT\d)"/g)].map((match) =>
    String(match[1])
  )
  assert.deepEqual(slots, [
    "ORVANTAHASHSLOT1",
    "ORVANTAHASHSLOT2",
    "ORVANTAHASHSLOT3",
    "ORVANTAHASHSLOT4"
  ])
  assert.ok(
    slots.every((slot) => slot.length === 16),
    "placeholders must keep the hash length"
  )
  assert.match(hashRows.join("\n"), /\$capabilityHashSlots\[0\]/)
  assert.match(hashRows.join("\n"), /\$capabilityHashSlots\[3\]/)
  assert.match(emissionBlock, /CONCATENATE 'SOURCE\|HASH\|'/)
  assert.match(source, /\$capabilityHashInput = \$functionSource -join "`n"/)
  assert.match(source, /\[Text\.Encoding\]::UTF8\.GetBytes\(\$capabilityHashInput\)/)
  assert.match(source, /ToString\("x2"\)/)
  assert.match(source, /Substring\(\$capabilityHashIndex \* 16, 16\)/)
  // The hash must be injected before the source is chunked for upload.
  assert.ok(
    source.indexOf("$capabilitySourceHash = (") < source.indexOf("$sourceProgramLines = foreach"),
    "hash injection must happen before the upload chunking"
  )
})

test("the CAPABILITIES branch only uses character-like operands", () => {
  // ABAP CONCATENATE and `=` accept only character-like operands (C, N, D, T, STRING).
  // sy-tzone is numeric: using it directly raises GENERATE_ERROR 943 ("must be a
  // character-type data object") and WRITE ... TO raises GENERATE_ERROR 944 for STRING
  // targets. Both were observed on w200 and each left a helper without an active version.
  // The offset is therefore converted by assignment to a character work field.
  const abapLines = emissionBlock
    .split("\n")
    .map((line) => /^\s*"(.*?)",?\s*$/.exec(line)?.[1])
    .filter((line): line is string => typeof line === "string")
  assert.ok(abapLines.length > 0, "expected ABAP lines in the emission block")

  const systemFields = [
    ...new Set(
      abapLines.flatMap((line) =>
        [...line.matchAll(/\bsy-[a-z]+\b/g)].map((match) => String(match[0]))
      )
    )
  ].sort()
  assert.deepEqual(
    systemFields.filter(
      (field) => !["sy-datum", "sy-mandt", "sy-sysid", "sy-tzone", "sy-uzeit"].includes(field)
    ),
    [],
    "unexpected system field: only verified character-like fields may be used"
  )

  const tzoneLines = abapLines.filter((line) => /\bsy-tzone\b/.test(line))
  assert.equal(tzoneLines.length, 1, "sy-tzone must be used exactly once")
  const conversion = /^\s*([A-Za-z0-9_]+) = sy-tzone\.$/.exec(tzoneLines[0] ?? "")
  assert.ok(conversion, `sy-tzone must be converted by assignment, got: ${tzoneLines[0]}`)
  const workField = String(conversion?.[1])
  assert.match(emissionBlock, new RegExp(`CONDENSE ${workField} NO-GAPS\\.`))
  assert.match(
    emissionBlock,
    new RegExp(`CONCATENATE 'RUNTIME\\|TIME' lv_payload_value ${workField}`)
  )
  for (const line of abapLines) {
    if (/\bCONCATENATE\b/.test(line)) {
      assert.doesNotMatch(line, /\bsy-tzone\b/, "sy-tzone must never be a CONCATENATE operand")
    }
  }
})

test("the parameter list declares IV_EXPECTED_VERSION for every generated body", () => {
  // Z_ORVANTA_MCP_EXECUTE receives the shared repository body, which references
  // iv_expected_version. Declaring the parameter only for DYNPRO_API/DDIC made the parameter
  // list disagree with the body, so the EXECUTE install failed with GENERATE_ERROR 4902
  // ("The field IV_EXPECTED_VERSION is unknown").
  const repositoryBody = sliceBetween("$repositoryFunctionSource = @(", "$functionSource = if (")
  assert.match(repositoryBody, /\biv_expected_version\b/)
  const parameterList = sliceBetween("$ddicImportLines = ", "$sourceProgramLines = foreach")
  assert.match(parameterList, /ls_import-parameter = 'IV_EXPECTED_VERSION'\./)
  assert.doesNotMatch(parameterList, /FunctionName -eq/, "no function name may be excluded")
  assert.doesNotMatch(parameterList, /else \{/, "the declaration must not be conditional")
})

test("CAPABILITIES is a read-only self-description without version negotiation", () => {
  assert.match(emissionBlock, /ev_status = 'S'\./)
  assert.match(emissionBlock, /ev_code = 'CAPABILITIES'\./)
  assert.match(emissionBlock, /ev_message = 'ORVANTA helper capabilities'\./)
  assert.match(emissionBlock, /"      RETURN\."/)
  assert.doesNotMatch(emissionBlock, /iv_expected_version/)
  assert.doesNotMatch(emissionBlock, /CHECK\|EXPECTED/)
  assert.doesNotMatch(emissionBlock, /\b(INSERT|UPDATE|DELETE|MODIFY|COMMIT WORK|CALL FUNCTION)\b/)
  const order = [
    "'HELPER|",
    "'PROTOCOL|MIN|",
    "'PROTOCOL|MAX|",
    "OPERATION|",
    "'SCOPE|",
    "'SOURCE|HASH|",
    "'SOURCE|PACKAGE|",
    "'SOURCE|TRANSPORT|",
    "'RUNTIME|HOST'",
    "'RUNTIME|TIME'"
  ]
  let previous = -1
  for (const marker of order) {
    const index = emissionBlock.indexOf(marker)
    assert.ok(index > previous, `${marker} must follow the protocol order`)
    previous = index
  }
})

// --- Z_ORVANTA_MCP_DDIC_API, the second helper that carries the same protocol -------------
// Its sinceVersion values are contract minimums (the DDIC CASE only sets lv_object_type and
// lv_write flags, so a per-branch ev_version scan cannot derive them); they are therefore
// cross-checked against src/capabilities.ts instead of against the CASE.

const ddicTableBlock = sliceBetween(
  "# >>> ORVANTA-DDIC-CAPABILITY-TABLE",
  "# <<< ORVANTA-DDIC-CAPABILITY-TABLE"
)
const ddicEmissionBlock = sliceBetween(
  "# >>> ORVANTA-DDIC-CAPABILITIES-SOURCE",
  "# <<< ORVANTA-DDIC-CAPABILITIES-SOURCE"
)

const ddicOperations: Operation[] = [
  ...ddicTableBlock.matchAll(/"([A-Z0-9_]+)\|(\d+\.\d+)\|([RW])"/g)
].map((match) => ({
  opcode: String(match[1]),
  since: String(match[2]),
  mode: String(match[3]) as "R" | "W"
}))

const ddicOpcodes = ddicOperations.map((operation) => operation.opcode)

// The DDIC CASE is the first CASE iv_operation in the script (inside New-DdicFunctionSource).
const ddicCaseStart = source.indexOf('"  CASE iv_operation."')
assert.ok(ddicCaseStart > 0, "DDIC CASE iv_operation not found")
const ddicCaseAbapLines: string[] = []
for (const rawLine of source.slice(ddicCaseStart).split("\n")) {
  const match = /^\s*"(.*?)",?\s*$/.exec(rawLine)
  if (!match) continue
  const abap = String(match[1])
  if (abap === "  ENDCASE.") break
  ddicCaseAbapLines.push(abap)
}

test("the DDIC table is the only opcode list for the DDIC CASE", () => {
  const caseOpcodes: string[] = []
  for (const abap of ddicCaseAbapLines) {
    const when = /^\s{4}WHEN ('([A-Z0-9_]+)'\.)$/.exec(abap)
    if (!when) continue
    assert.doesNotMatch(abap, /\bOR\b/, `DDIC WHEN clause must be single-opcode: ${abap}`)
    caseOpcodes.push(String(when[2]))
  }
  assert.ok(caseOpcodes.length > 0, "no DDIC WHEN clauses found")
  assert.deepEqual(
    [...ddicOpcodes].sort(),
    [...caseOpcodes].sort(),
    "the DDIC table and the DDIC CASE must list the same opcodes"
  )
})

test("the DDIC table matches the service-side SapDdicOperation union", async () => {
  const backend = await readFile("src/backend.ts", "utf8")
  const unionStart = backend.indexOf("export type SapDdicOperation =")
  const unionEnd = backend.indexOf("export interface SapDdicRequest")
  assert.ok(unionStart > 0 && unionEnd > unionStart, "SapDdicOperation union not found")
  const unionMembers = [
    ...backend.slice(unionStart, unionEnd).matchAll(/\|\s*"([A-Z0-9_]+)"/g)
  ].map((match) => String(match[1]))
  assert.ok(unionMembers.length > 0, "union members not parsed")
  const serviceOpcodes = unionMembers.filter((member) => member !== "CAPABILITIES")
  assert.deepEqual(
    [...ddicOpcodes].sort(),
    [...serviceOpcodes].sort(),
    "the DDIC table must describe exactly the operations the service can request"
  )
  assert.ok(
    unionMembers.includes("CAPABILITIES"),
    "SapDdicOperation must accept the CAPABILITIES probe"
  )
})

test("the DDIC since values are the service contract minimums", async () => {
  // Read the routing the service actually uses instead of scraping helperCapability(...) literals
  // out of the source text: those literals no longer carry a version at all, because the helper
  // and the minimum protocol are now derived from the tool registry.
  const contractVersions = helperCapabilityRoutes()
    .filter((route) => route.id.startsWith("ddic-helper-"))
    .map((route) => route.minimumVersion)
  assert.ok(contractVersions.length > 0, "ddic-helper-* catalog entries not parsed")
  assert.deepEqual(
    [...new Set(ddicOperations.map((operation) => operation.since))].sort(),
    [...new Set(contractVersions)].sort(),
    "every DDIC sinceVersion must be a ddic-helper-* contract minimum"
  )
  const groupSizes: Record<string, number> = {}
  for (const operation of ddicOperations) {
    groupSizes[operation.since] = (groupSizes[operation.since] ?? 0) + 1
  }
  assert.deepEqual(groupSizes, {
    "1.11": 7,
    "1.12": 1,
    "1.2": 8,
    "1.5": 2,
    "1.6": 5,
    "1.7": 4,
    "1.8": 3,
    "1.9": 3
  })

  // Compare numerically: a lexicographic sort puts "1.9" after "1.10".
  const numeric = (version: string): number =>
    version.split(".").reduce((acc, part) => acc * 1000 + Number.parseInt(part, 10), 0)
  const versions = [...new Set(ddicOperations.map((operation) => operation.since))].sort(
    (left, right) => numeric(left) - numeric(right)
  )
  assert.equal(versions[0], "1.2", "PROTOCOL|MIN must derive to 1.2")
  // R-20: the renamed resume operation and the three number range object operations are the |1.11|
  // rows, so they alone raise PROTOCOL|MAX from 1.10 to 1.11 - a consequence of the table, not of a
  // hand-edited literal. The literals above are the frozen expectation of a table-derived count:
  // deleting a row from scripts/bootstrap-sap-helper.ps1 makes this assertion fail.
  // D6-5: UPSERT_APPEND_STRUCTURE_FIELDS is the single |1.12| row, so it alone raises PROTOCOL|MAX
  // from 1.11 to 1.12. A 1.11 helper does not know the opcode at all, which is exactly why
  // upsert_append_structure_fields declares protocol 1.12 and is reported unavailable on 1.11.
  assert.equal(versions[versions.length - 1], "1.12", "PROTOCOL|MAX must derive to 1.12")
})

test("the DDIC branch reuses the repository hash slots and names its own helper", () => {
  const slotsOf = (block: string): string[] =>
    [...block.matchAll(/"(ORVANTAHASHSLOT\d)"/g)].map((match) => String(match[1]))
  assert.deepEqual(
    slotsOf(ddicEmissionBlock),
    slotsOf(emissionBlock),
    "both bodies must carry byte-identical placeholders so New-InstallProgram substitutes both"
  )
  assert.match(ddicEmissionBlock, /'HELPER\|Z_ORVANTA_MCP_DDIC_API'/)
  assert.match(emissionBlock, /'HELPER\|\$FunctionName'/)
})

test("the DDIC branch is read-only and declares its own payload work fields", () => {
  assert.match(ddicEmissionBlock, /ev_status = 'S'\./)
  assert.match(ddicEmissionBlock, /ev_code = 'CAPABILITIES'\./)
  assert.match(ddicEmissionBlock, /"      RETURN\."/)
  assert.doesNotMatch(
    ddicEmissionBlock,
    /\b(INSERT|UPDATE|DELETE|MODIFY|COMMIT WORK|CALL FUNCTION)\b/
  )
  assert.doesNotMatch(ddicEmissionBlock, /\bWRITE\b/, "WRITE ... TO rejects STRING targets")
  const abapLines = [...ddicEmissionBlock.matchAll(/^\s*"(.*?)",?\s*$/gm)].map((match) =>
    String(match[1])
  )
  assert.ok(abapLines.length > 0, "no ABAP lines parsed from the DDIC branch")
  for (const abap of abapLines) {
    // Lines carrying a PowerShell interpolation ($(...)) are longer in the generator text than
    // in the generated ABAP, where each slot collapses to a 16-character placeholder. The
    // evaluated length is enforced by the generator's own 72-character throw and verified
    // offline against the generated body.
    if (!abap.includes("$(")) {
      assert.ok(abap.length <= 72, `generated DDIC line exceeds 72 characters: ${abap}`)
    }
    if (/\bCONCATENATE\b/.test(abap)) {
      assert.doesNotMatch(abap, /\bsy-tzone\b/, "sy-tzone must never be a CONCATENATE operand")
    }
  }
  assert.match(source, /"  DATA lv_payload_value TYPE string\."/)
  assert.match(source, /"  DATA lv_payload_index_text TYPE string\."/)
})
