import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

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
