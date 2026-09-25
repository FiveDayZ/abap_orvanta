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
  "RESUME_TABLE_ACTIVATION"
]

// Maintenance views are the second 1.11 DDIC family (D6-4): read, upsert and the delete that
// delete_ddic_object reaches through objectType VIEW.
const MAINTENANCE_VIEW_OPERATIONS = [
  "READ_MAINTENANCE_VIEW",
  "UPSERT_MAINTENANCE_VIEW",
  "DELETE_MAINTENANCE_VIEW"
]

const LOCK_OBJECT_WRITE_OPERATIONS = ["UPSERT_LOCK_OBJECT", "DELETE_LOCK_OBJECT"]

/**
 * The number range object operations of D6-3. They are in the same position as the lock object writes
 * were: the bootstrap script declares them (protocol 1.11) but no carrier has deployed them, so the
 * deployed 1.10 inventory above must keep them absent and their capability must be reported as
 * missing them rather than as available on the protocol version alone.
 */
const NUMBER_RANGE_OPERATIONS = [
  "READ_NUMBER_RANGE_OBJECT",
  "UPSERT_NUMBER_RANGE_OBJECT",
  "DELETE_NUMBER_RANGE_OBJECT"
]

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

test("a helper that attests the protocol but not the operation code is not reported as available", async () => {
  const report = await reportWithDdicOperations(DEPLOYED_OPERATIONS)

  // The defect this replaces: the helper self-describes 1.10, the registry minimum was 1.9, and the
  // version-only check called a capability available while some of its operations do not exist. The
  // verdict follows the helper's own operation list. The lock object kind keeps only its read here
  // (its write moved to the 1.16 group below), so the inventory rule is now demonstrated by the
  // delete capability, which is missing the three delete opcodes this 1.10 carrier never implemented.
  const lockObject = observation(report, "ddic-helper-lock-object")
  assert.equal(lockObject.availability, "available")
  assert.equal(lockObject.evidence.source, "version-and-operation-check")
  assert.deepEqual(lockObject.toolObservations, {
    read_lock_object: {
      availability: "available",
      requiredOperations: ["READ_LOCK_OBJECT"],
      missingOperations: []
    }
  })

  // The eight DDIC writes that save and activate a definition are one capability at 1.16, and the
  // version gate rejects them before the inventory is consulted. That is deliberate: the minimum does
  // not claim these opcodes are absent - it claims this helper cannot prove the save became active,
  // which is not something an operation list can express. The structure write is no longer one of
  // them: it moved to ddic-helper-structure-reference at 1.17, where its DD03P-REFTABLE/REFFIELD
  // inputs are the contract, so a 1.10 helper cannot serve it either - on the same version gate.
  const verifiedWrites = observation(report, "ddic-helper-write-activation-verified")
  assert.equal(verifiedWrites.availability, "unsupported")
  assert.equal(verifiedWrites.evidence.source, "version-check")
  assert.match(verifiedWrites.reason, /1\.10, which is below the required capability version 1\.16/)
  assert.equal(verifiedWrites.toolObservations, undefined)

  // delete_ddic_object dispatches one opcode per objectType, so only the routes whose helper-side
  // operation is missing report a gap: ENQU, NROB and VIEW. The other six stay usable.
  const controlledDelete = observation(report, "ddic-helper-controlled-delete")
  assert.equal(controlledDelete.availability, "partial")
  assert.match(
    controlledDelete.reason,
    /self-described protocol 1\.10, which satisfies minimum 1\.6/
  )
  assert.match(controlledDelete.reason, /delete_ddic_object needs DELETE_LOCK_OBJECT/)
  assert.match(controlledDelete.reason, /OPERATION_NOT_SUPPORTED/)
  assert.deepEqual(controlledDelete.toolObservations?.delete_ddic_object?.missingOperations, [
    "DELETE_LOCK_OBJECT",
    "DELETE_NUMBER_RANGE_OBJECT",
    "DELETE_MAINTENANCE_VIEW"
  ])
  assert.deepEqual(controlledDelete.toolObservations?.delete_ddic_object?.requiredOperations, [
    "DELETE_DOMAIN",
    "DELETE_DATA_ELEMENT",
    "DELETE_STRUCTURE",
    "DELETE_TRANSPARENT_TABLE",
    "DELETE_TABLE_TYPE",
    "DELETE_SEARCH_HELP",
    "DELETE_LOCK_OBJECT",
    "DELETE_NUMBER_RANGE_OBJECT",
    "DELETE_MAINTENANCE_VIEW"
  ])
  // The number range family is a capability of its own from protocol 1.11, so a 1.10 helper cannot
  // serve it at all: the version check, not the operation inventory, decides that verdict.
  const numberRange = observation(report, "ddic-helper-number-range-object")
  assert.equal(numberRange.availability, "unsupported")
  assert.equal(numberRange.evidence.source, "version-check")
  assert.match(numberRange.reason, /1\.10, which is below the required capability version 1\.11/)

  // Every other DDIC capability attests all of its operation codes and stays available.
  for (const id of [
    "ddic-helper-core",
    "ddic-helper-transparent-table",
    "ddic-helper-transparent-table-complex",
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

  // The resume tool is now rejected one gate earlier, on the protocol: R-20 raised its contract
  // minimum to 1.11 because RESUME_TABLE_ACTIVATION only exists from 1.11 (the 1.10 carrier shipped
  // the 35-character RESUME_TRANSPARENT_TABLE_ACTIVATION that its CHAR 32 IV_OPERATION truncated),
  // 2026-09-23 raised it again to 1.13 because 1.11/1.12 could dispatch the name but never resumed
  // anything, 2026-09-24 raised it to 1.14 because 1.13 reached the activation branch but called
  // DD_TABL_ACT with no protocol channel and never activated the table, and 2026-09-25 raised it to
  // 1.16 because 1.14/1.15 confirmed the resume by reading the active version only - the same blind
  // spot that let a refused DDIC write be reported as completed. A 1.10 helper therefore cannot serve
  // it, whatever its inventory says.
  const resume = observation(report, "ddic-helper-table-activation-resume")
  assert.equal(resume.availability, "unsupported")
  assert.equal(resume.evidence.source, "version-check")
  assert.match(resume.reason, /1\.10, which is below the required capability version 1\.16/)
  assert.equal(resume.toolObservations, undefined)

  // Exactly one capability is partial: the one whose inventory is missing operation codes the helper
  // otherwise satisfies by version. Nothing else moves - the 1.16 writes are unsupported on the
  // version gate rather than partial, because no opcode list could make them trustworthy.
  assert.deepEqual(partialIds(report), ["ddic-helper-controlled-delete"])
  assert.equal(report.summary.partial, 1)
  const baseline = await reportWithDdicOperations(null)
  assert.equal(baseline.summary.partial ?? 0, 0)
  assert.deepEqual(partialIds(baseline), [])
})

test("a helper that attests every required operation code is available", async () => {
  const report = await reportWithDdicOperations(
    [
      ...DEPLOYED_OPERATIONS,
      ...LOCK_OBJECT_WRITE_OPERATIONS,
      ...NUMBER_RANGE_OPERATIONS,
      ...MAINTENANCE_VIEW_OPERATIONS
    ],
    // 1.17 is the highest DDIC contract minimum: four rows - the structure write and the three
    // table-field writes - need a helper that both accepts and publishes DD03P-REFTABLE/REFFIELD,
    // because a quantity or currency component cannot activate without the pair and the write-back
    // verification asserts it. Below 1.17 the version gate decides those rows; 1.16 is the floor for
    // the resume and the eight activation-verified writes (1.11/1.12 routed the resume into
    // conversion recovery, 1.13 could not activate, and 1.14/1.15 confirmed an activation by reading
    // the active version only).
    "1.17"
  )

  const resume = observation(report, "ddic-helper-table-activation-resume")
  assert.equal(resume.availability, "available", resume.reason)
  assert.equal(resume.evidence.source, "version-and-operation-check")
  assert.deepEqual(resume.toolObservations?.resume_ddic_table_activation?.missingOperations, [])

  // Each DDIC kind's read keeps its own capability at its own lower minimum; the write it used to
  // share that group with is judged - and reported - in the 1.16 group instead.
  const lockObject = observation(report, "ddic-helper-lock-object")
  assert.equal(lockObject.availability, "available")
  assert.equal(lockObject.evidence.source, "version-and-operation-check")
  assert.deepEqual(lockObject.toolObservations, {
    read_lock_object: {
      availability: "available",
      requiredOperations: ["READ_LOCK_OBJECT"],
      missingOperations: []
    }
  })
  assert.equal(observation(report, "ddic-helper-controlled-delete").availability, "available")

  const verifiedWrites = observation(report, "ddic-helper-write-activation-verified")
  assert.equal(verifiedWrites.availability, "available", verifiedWrites.reason)
  assert.equal(verifiedWrites.evidence.source, "version-and-operation-check")
  assert.deepEqual(Object.keys(verifiedWrites.toolObservations ?? {}).sort(), [
    "patch_ddic_transparent_table_settings",
    "upsert_ddic_data_element",
    "upsert_ddic_domain",
    "upsert_ddic_table_type",
    "upsert_lock_object",
    "upsert_maintenance_view",
    "upsert_number_range_object",
    "upsert_search_help"
  ])
  assert.equal(
    Object.values(verifiedWrites.toolObservations ?? {}).every(
      (item) => item.missingOperations.length === 0
    ),
    true
  )

  // The structure write is its own capability at 1.17, and it is available here for the same reason
  // as the group above: the helper attests UPSERT_STRUCTURE and its protocol reaches 1.17.
  const structureWrite = observation(report, "ddic-helper-structure-reference")
  assert.equal(structureWrite.availability, "available", structureWrite.reason)
  assert.equal(structureWrite.evidence.source, "version-and-operation-check")
  assert.deepEqual(structureWrite.toolObservations, {
    upsert_ddic_structure: {
      availability: "available",
      requiredOperations: ["UPSERT_STRUCTURE"],
      missingOperations: []
    }
  })

  const numberRange = observation(report, "ddic-helper-number-range-object")
  assert.equal(numberRange.availability, "available")
  assert.equal(numberRange.evidence.source, "version-and-operation-check")
  assert.deepEqual(numberRange.toolObservations, {
    read_number_range_object: {
      availability: "available",
      requiredOperations: ["READ_NUMBER_RANGE_OBJECT"],
      missingOperations: []
    }
  })
  assert.equal(report.summary.partial, 0)
  // D6-4: the maintenance view family is available only when the helper attests its own 1.11 opcode,
  // exactly like the number range family above.
  const maintenanceView = observation(report, "ddic-helper-maintenance-view")
  assert.equal(maintenanceView.availability, "available")
  assert.equal(maintenanceView.evidence.source, "version-and-operation-check")
  assert.deepEqual(maintenanceView.toolObservations, {
    read_maintenance_view: {
      availability: "available",
      requiredOperations: ["READ_MAINTENANCE_VIEW"],
      missingOperations: []
    }
  })
})

test("a missing operation code alone makes its tool unsupported", async () => {
  // Falsification inside the suite: with the same helper identity and protocol but one operation
  // removed, only the capability that dispatches it changes verdict. The protocol is raised to the
  // highest DDIC contract minimum (1.17) so the operation inventory - not the version check - is what
  // decides the verdict.
  const report = await reportWithDdicOperations(
    DEPLOYED_OPERATIONS.filter((opcode) => opcode !== "RESUME_TABLE_ACTIVATION"),
    "1.17"
  )

  const resume = observation(report, "ddic-helper-table-activation-resume")
  assert.equal(resume.availability, "unsupported")
  assert.match(resume.reason, /attests none of the required operation codes/)
  assert.match(resume.reason, /resume_ddic_table_activation needs RESUME_TABLE_ACTIVATION/)
  assert.equal(observation(report, "ddic-helper-core").availability, "available")
  // The number range family is judged on its own operation inventory too, and a helper that published
  // none of its three operation codes attests *nothing* it needs, so its verdict is unsupported rather
  // than partial: the removal of one operation code alone decides the verdict.
  const numberRange = observation(report, "ddic-helper-number-range-object")
  assert.equal(numberRange.availability, "unsupported")
  assert.match(numberRange.reason, /attests none of the required operation codes/)
  // Two capabilities are partial here: the delete routes (three delete opcodes absent from this 1.10
  // inventory) and the 1.16 write group, whose five opcodes this fixture attests and whose three -
  // UPSERT_LOCK_OBJECT, UPSERT_NUMBER_RANGE_OBJECT, UPSERT_MAINTENANCE_VIEW - it never implemented.
  // The lock object kind itself stays available: only its read is left in that capability. The
  // structure write is not partial: it is its own 1.17 capability and its one opcode is attested.
  assert.equal(observation(report, "ddic-helper-lock-object").availability, "available")
  assert.deepEqual(partialIds(report), [
    "ddic-helper-controlled-delete",
    "ddic-helper-write-activation-verified"
  ])
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
    `The ${DDIC_HELPER} helper self-described protocol 1.6, which is below the required capability version 1.16.`
  )
  assert.equal(resume.toolObservations, undefined)
})

test("a 1.12 helper - the deployed one during the 2026-09-23 incident - cannot be reported as able to resume", async () => {
  // The incident's helper self-described protocol 1.12 and did attest RESUME_TABLE_ACTIVATION, so the
  // old 1.11 contract minimum made the capability read "available" while the operation could only
  // answer WORKLIST_REQUIRED (or run a conversion recovery). The contract minimum must reject it - as
  // it does at 1.16, where the resume must additionally prove the activation took effect.
  const report = await reportWithDdicOperations(
    [
      ...DEPLOYED_OPERATIONS,
      ...LOCK_OBJECT_WRITE_OPERATIONS,
      ...NUMBER_RANGE_OPERATIONS,
      ...MAINTENANCE_VIEW_OPERATIONS
    ],
    "1.12"
  )

  const resume = observation(report, "ddic-helper-table-activation-resume")
  assert.equal(resume.availability, "unsupported")
  assert.equal(resume.evidence.source, "version-check")
  assert.match(resume.reason, /1\.12, which is below the required capability version 1\.16/)
  // The inventory does attest the opcode here, so only the version gate can produce this verdict.
  assert.equal(resume.toolObservations, undefined)
  assert.ok(
    DEPLOYED_OPERATIONS.includes("RESUME_TABLE_ACTIVATION"),
    "the fixture must attest the opcode, or this test would pass for the wrong reason"
  )
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
