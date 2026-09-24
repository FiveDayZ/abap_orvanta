import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  HELPER_OPERATION_PARAMETERS,
  HELPER_OPERATIONS_BLOCKED_BY_PARAMETER_LENGTH,
  HelperOperationNotDeliverableError,
  OPERATION_PARAMETER_TYPE_LENGTHS,
  assertHelperOperationDeliverable,
  helperOperationParameter
} from "../src/helper-operation-limits.js"
import { TOOL_REGISTRY } from "../src/tool-registry.js"

/**
 * Every helper's `IV_OPERATION` is a fixed-length DDIC field, so a longer operation code is
 * truncated by the RFC layer and can never match the helper's `CASE iv_operation`.
 *
 * Regression guard for the 2026-09-22 10:56 incident: `resume_ddic_table_activation` sent
 * `RESUME_TRANSPARENT_TABLE_ACTIVATION` (35 characters) to a helper whose `IV_OPERATION` is
 * `BAPIRET2-PARAMETER` (CHAR 32), so SAP received `RESUME_TRANSPARENT_TABLE_ACTIVAT` and answered
 * `OPERATION_NOT_SUPPORTED: Unsupported DDIC operation` while the helper's own capability list
 * advertised the operation. Three repository-side operations were over the shared body's CHAR 30
 * limit for the same reason.
 *
 * The expectation below is deliberately NOT the local length table: the limit is derived from the
 * DDIC type the generator declares for each helper, so a wrong length in
 * `src/helper-operation-limits.ts` fails here instead of silently authorising a truncated opcode.
 */
const SCRIPT = "scripts/bootstrap-sap-helper.ps1"
const script = readFileSync(SCRIPT, "utf8")

const DDIC_HELPER = "Z_ORVANTA_MCP_DDIC_API"
/** Both deploy the same generated repository body, so both carry the same limit. */
const REPOSITORY_HELPERS = ["Z_ORVANTA_MCP_EXECUTE", "Z_ORVANTA_MCP_DYNPRO_API"]

/** The generator's own `IV_OPERATION` type decision, read from New-InstallProgram. */
function declaredOperationTypes(): Record<string, string> {
  const match =
    /\$operationDbField = if \(\$FunctionName -eq "([A-Z0-9_]+)"\) \{\s*"([A-Z0-9-]+)"\s*\}\s*else \{\s*"([A-Z0-9-]+)"\s*\}/.exec(
      script
    )
  assert.ok(match, "the generator must declare the IV_OPERATION DDIC type from one place")
  const [, ddicHelper = "", ddicType = "", otherType = ""] = match
  return {
    [ddicHelper]: ddicType,
    ...Object.fromEntries(REPOSITORY_HELPERS.map((helper) => [helper, otherType]))
  }
}

function sliceBetween(start: string, end: string): string {
  const from = script.indexOf(start)
  assert.ok(from >= 0, `missing anchor: ${start}`)
  const to = script.indexOf(end, from + start.length)
  assert.ok(to > from, `missing anchor: ${end}`)
  return script.slice(from + start.length, to)
}

/** The marked capability table is the single opcode inventory of its helper's body. */
const tableOpcodes = (block: string): string[] =>
  [...block.matchAll(/"([A-Z0-9_]+)\|/g)].map((match) => String(match[1]))

const ddicDeclared = tableOpcodes(
  sliceBetween("# >>> ORVANTA-DDIC-CAPABILITY-TABLE", "# <<< ORVANTA-DDIC-CAPABILITY-TABLE")
)
const repositoryDeclared = tableOpcodes(
  sliceBetween("# >>> ORVANTA-CAPABILITY-TABLE", "# <<< ORVANTA-CAPABILITY-TABLE")
)

function operationsSentFromSource(
  file: string
): { helper: string; operation: string; line: number }[] {
  const lines = readFileSync(file, "utf8").split("\n")
  const helpers: Record<string, string> = {
    callSapDdic: "Z_ORVANTA_MCP_DDIC_API",
    callSapRepository: "Z_ORVANTA_MCP_DYNPRO_API",
    callSapHelper: "Z_ORVANTA_MCP_EXECUTE"
  }
  const calls = Object.keys(helpers)
  const found: { helper: string; operation: string; line: number }[] = []
  lines.forEach((line, index) => {
    const match = /operation:\s*"([A-Z_]{4,})"/.exec(line)
    if (!match || !match[1]) return
    let helper: string | undefined
    for (let back = index; back >= 0 && index - back < 25; back--) {
      const call = calls.find((name) => (lines[back] ?? "").includes(`${name}(`))
      if (!call) continue
      helper = helpers[call]
      break
    }
    if (helper) found.push({ helper, operation: match[1], line: index + 1 })
  })
  return found
}

test("each helper's operation limit follows the DDIC type its generator declares", () => {
  const declared = declaredOperationTypes()
  for (const [helper, parameter] of Object.entries(HELPER_OPERATION_PARAMETERS)) {
    assert.equal(
      parameter.ddicType,
      declared[helper],
      `${helper} declares IV_OPERATION as ${declared[helper]} in ${SCRIPT}`
    )
    assert.equal(
      parameter.length,
      OPERATION_PARAMETER_TYPE_LENGTHS[parameter.ddicType],
      `${parameter.ddicType} is CHAR ${OPERATION_PARAMETER_TYPE_LENGTHS[parameter.ddicType]}`
    )
  }
  // The two limits must stay different: 31 or 32 characters is deliverable to the DDIC helper and
  // unreachable in the repository body.
  assert.notEqual(
    HELPER_OPERATION_PARAMETERS[DDIC_HELPER]?.length,
    HELPER_OPERATION_PARAMETERS["Z_ORVANTA_MCP_DYNPRO_API"]?.length
  )
})

test("every declared opcode fits the helper its body is deployed into", () => {
  assert.ok(repositoryDeclared.length > 20, "the repository capability table must parse")
  assert.ok(ddicDeclared.length > 10, "the DDIC capability table must parse")
  const bodies: Array<[string, readonly string[]]> = [
    ...REPOSITORY_HELPERS.map((helper): [string, readonly string[]] => [
      helper,
      repositoryDeclared
    ]),
    [DDIC_HELPER, ddicDeclared]
  ]
  for (const [helper, operations] of bodies) {
    const parameter = helperOperationParameter(helper)
    assert.ok(parameter, `${helper} must have an established IV_OPERATION type`)
    for (const operation of operations) {
      assert.ok(
        operation.length <= parameter.length,
        `${helper}: ${operation} (${operation.length}) exceeds ${parameter.ddicType} (CHAR ${parameter.length})`
      )
    }
  }
})

test("the truncated operations were renamed and are not documented as blocked", () => {
  // A listed blocked operation is a dead tool the capability report still calls available, and the
  // 0.46.14 `resume_ddic_table_activation` incident is exactly that failure. The list must stay
  // empty; the names below must exist as deliverable operations instead.
  assert.deepEqual(
    HELPER_OPERATIONS_BLOCKED_BY_PARAMETER_LENGTH,
    [],
    "no shipped operation may be recorded as undeliverable: rename it instead"
  )
  const renamed: Array<[string, string, string]> = [
    ["RESUME_TRANSPARENT_TABLE_ACTIVATION", DDIC_HELPER, "RESUME_TABLE_ACTIVATION"],
    ["READ_ENHANCEMENT_IMPLEMENTATION", "Z_ORVANTA_MCP_DYNPRO_API", "READ_ENHANCEMENT_IMPL"],
    ["DELETE_ENHANCEMENT_IMPLEMENTATION", "Z_ORVANTA_MCP_DYNPRO_API", "DELETE_ENHANCEMENT_IMPL"],
    ["MANAGE_CLASSIC_BADI_IMPLEMENTATION", "Z_ORVANTA_MCP_DYNPRO_API", "MANAGE_CLASSIC_BADI_IMPL"]
  ]
  for (const [oldName, helper, newName] of renamed) {
    const parameter = helperOperationParameter(helper)
    assert.ok(parameter, `${helper} must have an established IV_OPERATION type`)
    assert.ok(
      oldName.length > parameter.length,
      `${oldName} (${oldName.length}) is only a defect above ${parameter.length}`
    )
    assert.throws(
      () => assertHelperOperationDeliverable(helper, oldName),
      HelperOperationNotDeliverableError,
      `${oldName} must be refused instead of arriving truncated`
    )
    assert.ok(
      newName.length <= parameter.length,
      `${newName} (${newName.length}) must fit ${parameter.ddicType} (CHAR ${parameter.length})`
    )
    // The generator may still NAME a retired opcode in a comment that explains the rename (the DDIC
    // dispatcher does), so the check is that it is neither declared nor dispatched.
    assert.ok(!script.includes(`"${oldName}|`), `${oldName} must not stay in a capability table`)
    assert.ok(
      !script.includes(`WHEN '${oldName}'`),
      `${oldName} must not stay in a dispatcher CASE`
    )
    assert.ok(
      script.includes(`"${newName}`) || script.includes(`WHEN '${newName}'`),
      `${newName} must be declared in a capability table and dispatched`
    )
  }
  // The DDIC inventory is the one the deployed helper advertises: the truncated name must be gone
  // from the declared opcodes and the renamed one must be there.
  assert.ok(
    ddicDeclared.includes("RESUME_TABLE_ACTIVATION"),
    "the DDIC table must declare the resume opcode"
  )
  // The rename is itself the protocol change: RESUME_TABLE_ACTIVATION is introduced by the same
  // body that renames it, so its row records 1.11 and PROTOCOL|MAX derives to 1.11 from that row.
  // A |1.10| row would assert that some 1.10 helper delivers the renamed operation, which is false:
  // 1.10 shipped the 35-character name this guard refuses.
  const ddicTableText = sliceBetween(
    "# >>> ORVANTA-DDIC-CAPABILITY-TABLE",
    "# <<< ORVANTA-DDIC-CAPABILITY-TABLE"
  )
  assert.ok(
    ddicTableText.includes('"RESUME_TABLE_ACTIVATION|1.14|W"'),
    "the operation must be recorded as introduced at 1.14, the first helper that can actually resume"
  )
  assert.ok(
    !ddicTableText.includes('"RESUME_TABLE_ACTIVATION|1.11|W"'),
    "no helper ever delivered a working resume operation at 1.11 or 1.12"
  )
  assert.ok(
    !ddicTableText.includes('"RESUME_TABLE_ACTIVATION|1.10|W"'),
    "no helper ever delivered the renamed resume operation at 1.10"
  )
  assert.ok(
    repositoryDeclared.includes("READ_ENHANCEMENT_IMPL") &&
      repositoryDeclared.includes("DELETE_ENHANCEMENT_IMPL") &&
      repositoryDeclared.includes("MANAGE_CLASSIC_BADI_IMPL"),
    "the repository table must declare the renamed enhancement opcodes"
  )
})

test("every operation the service can send fits its helper parameter", () => {
  const violations: { helper: string; operation: string; tool: string }[] = []
  for (const entry of TOOL_REGISTRY) {
    const helper = entry.sapHelper
    if (!helper || !helperOperationParameter(helper)) continue
    for (const operation of entry.requiredHelperOperations ?? []) {
      const parameter = helperOperationParameter(helper)
      if (parameter && operation.length > parameter.length)
        violations.push({ helper, operation, tool: entry.name })
    }
  }
  for (const file of ["src/tools.ts", "src/adt-backend.ts"]) {
    for (const call of operationsSentFromSource(file)) {
      const parameter = helperOperationParameter(call.helper)
      if (parameter && call.operation.length > parameter.length)
        violations.push({
          helper: call.helper,
          operation: call.operation,
          tool: `${file}:${call.line}`
        })
    }
  }
  const unique = [
    ...new Map(
      violations.map((v) => [
        `${v.helper}|${v.operation}`,
        { helper: v.helper, operation: v.operation }
      ])
    ).values()
  ].sort((a, b) => `${a.helper}|${a.operation}`.localeCompare(`${b.helper}|${b.operation}`))
  const blocked = [...HELPER_OPERATIONS_BLOCKED_BY_PARAMETER_LENGTH]
    .map((entry) => ({ helper: entry.helper, operation: entry.operation }))
    .sort((a, b) => `${a.helper}|${a.operation}`.localeCompare(`${b.helper}|${b.operation}`))
  assert.deepEqual(
    unique,
    blocked,
    "an operation now exceeds its helper parameter, or a listed operation was fixed: update HELPER_OPERATIONS_BLOCKED_BY_PARAMETER_LENGTH"
  )
})

test("an undeliverable operation fails closed before SAP is contacted", () => {
  // The blocked list is empty by design, so the fail-closed path is exercised with the exact names
  // the guard exists to refuse rather than with a recorded defect.
  assert.throws(
    () =>
      assertHelperOperationDeliverable(
        "Z_ORVANTA_MCP_DYNPRO_API",
        "MANAGE_CLASSIC_BADI_IMPLEMENTATION"
      ),
    (error: unknown) => {
      assert.ok(error instanceof HelperOperationNotDeliverableError)
      assert.equal(error.helper, "Z_ORVANTA_MCP_DYNPRO_API")
      assert.equal(error.operation, "MANAGE_CLASSIC_BADI_IMPLEMENTATION")
      assert.equal(error.parameterLength, 30)
      assert.match(error.message, /HELPER_OPERATION_NOT_DELIVERABLE/)
      assert.match(error.message, /RS38L-NAME \(30 characters\)/)
      assert.match(error.message, /MANAGE_CLASSIC_BADI_IMPLEMENTA"/)
      assert.match(error.message, /was not sent and no SAP state changed/)
      return true
    }
  )
  // Helpers whose parameter type is not established locally keep working unchanged.
  assert.doesNotThrow(() =>
    assertHelperOperationDeliverable(
      "Z_ORVANTA_OPS_READ",
      "SOME_VERY_LONG_OPERATION_NAME_FOR_AN_OPS_HELPER"
    )
  )
})

test("the installer generates no operation that its own parameter would truncate", () => {
  // The end-to-end form of the guard: the generated bodies, not the tables, must fit. The DDIC
  // body is the sentinel for the CHAR 32 limit and the repository body for CHAR 30, and both are
  // counted so a parser that silently matches nothing cannot pass.
  const whenLiterals = (block: string): string[] =>
    [...block.matchAll(/WHEN '([A-Z0-9_]+)'/g)].map((match) => String(match[1]))
  const repositoryBody = sliceBetween(
    "$repositoryFunctionSource = @(",
    // This anchor marks the end of the repository body assignment. It moved on 2026-09-23 when the
    // body selector became `$usesRepositoryBody` (one shared predicate for the body AND the D7
    // interface parameters, so EXECUTE and DYNPRO_API can never disagree). Anchoring on the selector
    // line rather than on the FM name keeps this slice correct even though the predicate is no
    // longer a literal comparison here.
    "$functionSource = if ($usesRepositoryBody) {"
  )
  const ddicBody = sliceBetween(
    "function New-DdicFunctionSource {",
    "function New-InstallProgram {"
  )
  const repositoryOps = whenLiterals(repositoryBody)
  const ddicOps = whenLiterals(ddicBody)
  assert.ok(repositoryOps.length > 50, "the repository body CASE clauses must be parsed")
  assert.ok(ddicOps.length > 20, "the DDIC body CASE clauses must be parsed")
  for (const helper of REPOSITORY_HELPERS) {
    const parameter = helperOperationParameter(helper)
    assert.ok(parameter)
    for (const operation of repositoryOps) {
      assert.ok(
        operation.length <= parameter.length,
        `${helper}: dispatched ${operation} (${operation.length}) exceeds ${parameter.ddicType} (CHAR ${parameter.length})`
      )
    }
  }
  const ddicParameter = helperOperationParameter(DDIC_HELPER)
  assert.ok(ddicParameter)
  for (const operation of ddicOps) {
    assert.ok(
      operation.length <= ddicParameter.length,
      `${DDIC_HELPER}: dispatched ${operation} (${operation.length}) exceeds ${ddicParameter.ddicType} (CHAR ${ddicParameter.length})`
    )
  }
})
