import assert from "node:assert/strict"
import test from "node:test"
import type { SapHelperCapabilities } from "../src/backend.js"
import { buildCapabilityReport } from "../src/capabilities.js"
import { MockBackend } from "./mock-backend.js"

const DDIC_HELPER = "Z_ORVANTA_MCP_DDIC_API"

/**
 * The inventory the deployed DDIC helper self-described on 2026-09-21: protocol 1.10 with 24
 * operation codes. It deliberately lacks UPSERT_LOCK_OBJECT and DELETE_LOCK_OBJECT, which the
 * bootstrap script declares but the deployed carrier never implemented.
 */
const DEPLOYED_OPERATIONS = [
  "READ_DOMAIN",
  "UPSERT_DOMAIN",
  "READ_DATA_ELEMENT",
  "UPSERT_DATA_ELEMENT",
  "READ_STRUCTURE",
  "UPSERT_STRUCTURE",
  "READ_TABLE_TYPE",
  "UPSERT_TABLE_TYPE",
  "READ_TRANSPARENT_TABLE",
  "CREATE_TRANSPARENT_TABLE",
  "DELETE_DOMAIN",
  "DELETE_DATA_ELEMENT",
  "DELETE_STRUCTURE",
  "DELETE_TRANSPARENT_TABLE",
  "DELETE_TABLE_TYPE",
  "APPEND_TRANSPARENT_TABLE_FIELDS",
  "PATCH_TRANSPARENT_TABLE_FIELDS",
  "PATCH_TRANSPARENT_TABLE_SETTINGS",
  "RECOVER_TABLE_CONVERSION",
  "READ_SEARCH_HELP",
  "DELETE_SEARCH_HELP",
  "UPSERT_SEARCH_HELP",
  "READ_LOCK_OBJECT",
  "RESUME_TRANSPARENT_TABLE_ACTIVATION"
]

const LOCK_OBJECT_WRITE_OPERATIONS = ["UPSERT_LOCK_OBJECT", "DELETE_LOCK_OBJECT"]

interface ToolObservation {
  availability: string
  requiredOperations: string[]
  missingOperations: string[]
}

interface Observation {
  availability: string
  reason: string
  evidence: { source: string; detail: string }
  toolObservations?: Record<string, ToolObservation>
  disabledToolNames?: string[]
}

interface ReportShape {
  capabilities: Array<{ id: string; toolNames: string[]; observation: Observation }>
  summary: Record<string, number>
}

function ddicSelfDescription(
  operations: readonly string[],
  maxProtocol = "1.10"
): SapHelperCapabilities {
  return {
    helper: DDIC_HELPER,
    minProtocol: "1.2",
    maxProtocol,
    operations: operations.map((opcode) => ({
      opcode,
      since: "1.0",
      write: !opcode.startsWith("READ_")
    })),
    scopes: [],
    sourceHash: "a".repeat(64),
    packageName: "ZORVANTA_MCP_CORE",
    transport: "GR2K923472",
    host: "GR2/200",
    observedAt: "2026-09-21T06:00:00.000Z",
    attestation: "self-described"
  }
}

async function reportWithDdicOperations(
  operations: readonly string[] | null,
  maxProtocol = "1.10"
): Promise<ReportShape> {
  const backend = new MockBackend()
  if (operations !== null) {
    backend.helperCapabilities.set(DDIC_HELPER, ddicSelfDescription(operations, maxProtocol))
  }
  return JSON.parse(await buildCapabilityReport(backend, "w200")) as ReportShape
}

function observation(report: ReportShape, id: string): Observation {
  const capability = report.capabilities.find((item) => item.id === id)
  assert.ok(capability, `capability ${id} is missing from the report`)
  return capability.observation
}

/** The capabilities whose verdict is neither "everything works" nor "nothing works". */
const partialIds = (report: ReportShape): string[] =>
  report.capabilities
    .filter((item) => item.observation.availability === "partial")
    .map((item) => item.id)
    .sort()

test("a helper that attests the protocol but not the operation code is not available", async () => {
  const report = await reportWithDdicOperations(DEPLOYED_OPERATIONS)

  // The defect this replaces: the helper self-describes 1.10, the registry minimum is 1.9, and the
  // version-only check called the lock-object capability available while neither of its write
  // operations exists. The verdict now follows the helper's own operation list.
  const lockObject = observation(report, "ddic-helper-lock-object")
  assert.equal(lockObject.availability, "partial")
  assert.equal(lockObject.evidence.source, "version-and-operation-check")
  assert.match(lockObject.reason, /self-described protocol 1\.10, which satisfies minimum 1\.9/)
  assert.match(lockObject.reason, /upsert_lock_object needs UPSERT_LOCK_OBJECT/)
  assert.match(lockObject.reason, /OPERATION_NOT_SUPPORTED/)
  assert.deepEqual(lockObject.toolObservations, {
    read_lock_object: {
      availability: "available",
      requiredOperations: ["READ_LOCK_OBJECT"],
      missingOperations: []
    },
    upsert_lock_object: {
      availability: "unsupported",
      requiredOperations: ["UPSERT_LOCK_OBJECT"],
      missingOperations: ["UPSERT_LOCK_OBJECT"]
    }
  })

  // delete_ddic_object dispatches one opcode per objectType, so only the ENQU route is missing:
  // the capability is partial and the other six routes stay usable.
  const controlledDelete = observation(report, "ddic-helper-controlled-delete")
  assert.equal(controlledDelete.availability, "partial")
  assert.deepEqual(controlledDelete.toolObservations?.delete_ddic_object?.missingOperations, [
    "DELETE_LOCK_OBJECT"
  ])
  assert.deepEqual(controlledDelete.toolObservations?.delete_ddic_object?.requiredOperations, [
    "DELETE_DOMAIN",
    "DELETE_DATA_ELEMENT",
    "DELETE_STRUCTURE",
    "DELETE_TRANSPARENT_TABLE",
    "DELETE_TABLE_TYPE",
    "DELETE_SEARCH_HELP",
    "DELETE_LOCK_OBJECT"
  ])

  // Every other DDIC capability attests all of its operation codes and stays available.
  for (const id of [
    "ddic-helper-core",
    "ddic-helper-transparent-table",
    "ddic-helper-transparent-table-complex",
    "ddic-helper-table-activation-resume",
    "ddic-helper-search-help"
  ]) {
    const entry = observation(report, id)
    assert.equal(entry.availability, "available", `${id}: ${entry.reason}`)
    assert.equal(entry.evidence.source, "version-and-operation-check")
    assert.equal(
      Object.values(entry.toolObservations ?? {}).every(
        (item) => item.missingOperations.length === 0
      ),
      true
    )
  }

  // Exactly the two capabilities that dispatch a missing operation are partial; nothing else moves.
  assert.deepEqual(partialIds(report), ["ddic-helper-controlled-delete", "ddic-helper-lock-object"])
  assert.equal(report.summary.partial, 2)
  const baseline = await reportWithDdicOperations(null)
  assert.equal(baseline.summary.partial ?? 0, 0)
  assert.deepEqual(partialIds(baseline), [])
})

test("a helper that attests every required operation code is available", async () => {
  const report = await reportWithDdicOperations([
    ...DEPLOYED_OPERATIONS,
    ...LOCK_OBJECT_WRITE_OPERATIONS
  ])

  const lockObject = observation(report, "ddic-helper-lock-object")
  assert.equal(lockObject.availability, "available")
  assert.equal(lockObject.evidence.source, "version-and-operation-check")
  assert.deepEqual(lockObject.toolObservations?.upsert_lock_object?.missingOperations, [])
  assert.equal(observation(report, "ddic-helper-controlled-delete").availability, "available")
  assert.equal(report.summary.partial, 0)
})

test("a missing operation code alone makes its tool unsupported", async () => {
  // Falsification inside the suite: with the same helper identity and protocol but one operation
  // removed, only the capability that dispatches it changes verdict.
  const report = await reportWithDdicOperations(
    DEPLOYED_OPERATIONS.filter((opcode) => opcode !== "RESUME_TRANSPARENT_TABLE_ACTIVATION")
  )

  const resume = observation(report, "ddic-helper-table-activation-resume")
  assert.equal(resume.availability, "unsupported")
  assert.match(resume.reason, /attests none of the required operation codes/)
  assert.match(
    resume.reason,
    /resume_ddic_table_activation needs RESUME_TRANSPARENT_TABLE_ACTIVATION/
  )
  assert.equal(observation(report, "ddic-helper-core").availability, "available")
  assert.deepEqual(partialIds(report), ["ddic-helper-controlled-delete", "ddic-helper-lock-object"])
  assert.equal(report.summary.partial, 2)
})

test("a helper below the required protocol stays unsupported on the version check", async () => {
  const report = await reportWithDdicOperations(
    [...DEPLOYED_OPERATIONS, ...LOCK_OBJECT_WRITE_OPERATIONS],
    "1.6"
  )

  const resume = observation(report, "ddic-helper-table-activation-resume")
  assert.equal(resume.availability, "unsupported")
  assert.equal(resume.evidence.source, "version-check")
  assert.equal(
    resume.reason,
    `The ${DDIC_HELPER} helper self-described protocol 1.6, which is below the required capability version 1.10.`
  )
  assert.equal(resume.toolObservations, undefined)
})

test("a helper without an operation inventory keeps the version-only verdict and says so", async () => {
  const report = await reportWithDdicOperations([])

  const lockObject = observation(report, "ddic-helper-lock-object")
  assert.equal(lockObject.availability, "available")
  assert.equal(lockObject.evidence.source, "version-check")
  assert.match(lockObject.evidence.detail, /the helper published no operation inventory/)
  assert.equal(lockObject.toolObservations, undefined)

  // No CAPABILITIES answer at all: the mock's read probe reports 1.2, so the pre-attestation
  // wording and verdict are untouched - an un-upgraded helper is never called unsupported.
  const unprobed = await reportWithDdicOperations(null)
  const unprobedLockObject = observation(unprobed, "ddic-helper-lock-object")
  assert.equal(unprobedLockObject.availability, "unknown")
  assert.equal(unprobedLockObject.evidence.source, "version-check")
  assert.match(
    unprobedLockObject.reason,
    /does not prove whether capability version 1\.9 is installed/
  )
  assert.match(unprobedLockObject.evidence.detail, /ddic observed operation protocol/)
})
