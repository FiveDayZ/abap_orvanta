import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import { resolveEditableSourceTarget } from "./adt-backend.js"
import { InactiveInventoryError } from "./inactive-inventory.js"
import { findAndReplaceSource } from "./source-edit.js"

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/i)
export const sourceChangeSchema = z.object({
  fileUri: z.string().max(1024),
  oldString: z.string().max(100_000),
  newString: z.string().max(100_000),
  packageName: z
    .string()
    .regex(/^(?:\$TMP|[A-Z0-9_\/]+)$/i)
    .max(30),
  transportNumber: z
    .string()
    .regex(/^[A-Z0-9]+$/i)
    .max(20)
    .optional(),
  expectedSourceFingerprint: fingerprint.optional()
})
export const sourcePreflightSchema = z.object({
  changes: z.array(sourceChangeSchema).min(1).max(10)
})

interface Assignment {
  packageName: string
  requestNumber: string
  taskNumber: string
  transportStatus: string
  active: boolean
}
interface AssignmentInput {
  connectionId: string
  objectName: string
  objectType: "CLAS/OC" | "INTF/OI" | "PROG/P" | "PROG/I" | "FUGR/F" | "FUGR/FF"
}

export async function previewSourceChanges(
  backend: SapBackend,
  input: z.input<typeof sourcePreflightSchema>,
  inspectAssignment: (input: AssignmentInput) => Promise<string>
) {
  const { changes } = sourcePreflightSchema.parse(input)
  const seen = new Set<string>()
  const targets = changes.map((change) => {
    let uri: URL
    try {
      uri = new URL(change.fileUri)
    } catch {
      throw new Error("Each fileUri must be an exact adt:// workspace URI")
    }
    if (
      uri.protocol !== "adt:" ||
      !uri.hostname ||
      uri.username ||
      uri.password ||
      uri.search ||
      uri.hash ||
      uri.port
    ) {
      throw new Error("Each fileUri must be an exact adt:// workspace URI")
    }
    const connectionId = uri.hostname.toLowerCase()
    backend.connectionDetails(connectionId)
    const target = resolveEditableSourceTarget(change.fileUri, connectionId)
    const identity = `${connectionId}:${target.sourceUri.toLowerCase()}`
    if (seen.has(identity)) throw new Error("Duplicate source target in change set")
    seen.add(identity)
    if (target.kind === "ddl-source" || target.kind === "dcl-source") {
      throw new Error("Source preflight currently covers classic ABAP source objects only")
    }
    return { change, connectionId, target }
  })
  const results: Array<Record<string, unknown>> = []
  for (const { change, connectionId, target } of targets) {
    let stage = "source_read"
    try {
      const source = await backend.inspectSource(connectionId, change.fileUri)
      const types = {
        class: "CLAS/OC",
        interface: "INTF/OI",
        program: "PROG/P",
        include: "PROG/I",
        "function-group": "FUGR/F",
        "function-group-include": "FUGR/F",
        "function-module": "FUGR/FF"
      } as const
      const kind = target.kind as keyof typeof types
      stage = "assignment_read"
      const assignment: Assignment = JSON.parse(
        await inspectAssignment({
          connectionId,
          objectType: types[kind],
          objectName:
            kind === "function-group-include" ? target.customerNames[0]! : target.objectName
        })
      )
      if (
        typeof assignment.packageName !== "string" ||
        typeof assignment.requestNumber !== "string" ||
        typeof assignment.taskNumber !== "string" ||
        typeof assignment.transportStatus !== "string" ||
        typeof assignment.active !== "boolean"
      ) {
        throw new Error("Incomplete assignment metadata")
      }
      stage = "comparison"
      const currentFingerprint = hashSource(source.activeSource)
      const blockers: string[] = []
      if (source.inactiveSource !== null) blockers.push("INACTIVE_SOURCE_EXISTS")
      if (!assignment.active) blockers.push("OBJECT_NOT_ACTIVE")
      if (assignment.packageName !== change.packageName.toUpperCase()) {
        blockers.push("PACKAGE_CONFLICT")
      }
      if (
        change.expectedSourceFingerprint &&
        change.expectedSourceFingerprint.toLowerCase() !== currentFingerprint
      ) {
        blockers.push("SOURCE_FINGERPRINT_CONFLICT")
      }
      if (assignment.packageName === "$TMP") {
        if (change.transportNumber) blockers.push("LOCAL_OBJECT_HAS_REQUESTED_TRANSPORT")
      } else if (
        !change.transportNumber ||
        ![assignment.requestNumber, assignment.taskNumber].includes(
          change.transportNumber.toUpperCase()
        ) ||
        assignment.transportStatus !== "D"
      ) {
        blockers.push("OPEN_TRANSPORT_ASSIGNMENT_NOT_CONFIRMED")
      }
      let proposed: string | undefined
      let replacementError: string | undefined
      try {
        proposed = findAndReplaceSource(source.activeSource, change.oldString, change.newString)
        if (proposed === source.activeSource) blockers.push("NO_SOURCE_CHANGE")
      } catch (error) {
        blockers.push("EXACT_REPLACEMENT_REJECTED")
        replacementError = error instanceof Error ? error.message : String(error)
      }
      results.push({
        fileUri: change.fileUri,
        objectName: source.objectName,
        observedAt: new Date().toISOString(),
        status: blockers.length ? "blocked" : "ready_for_review",
        blockers,
        assignment,
        activeFingerprint: currentFingerprint,
        proposedFingerprint: proposed === undefined ? null : hashSource(proposed),
        diff: proposed === undefined ? null : sourceDiff(source.activeSource, proposed),
        inactiveFingerprint:
          source.inactiveSource === null ? null : hashSource(source.inactiveSource),
        inactiveDiff:
          source.inactiveSource === null
            ? null
            : sourceDiff(source.activeSource, source.inactiveSource),
        ...(replacementError ? { replacementError } : {}),
        writePrecondition: {
          fileUri: change.fileUri,
          expectedSourceFingerprint: currentFingerprint,
          transportNumber: change.transportNumber ?? null
        }
      })
    } catch (error) {
      // Remote failures are not absence. Do not leak SOAP payloads or credentials.
      const inactiveDiagnostic =
        error instanceof InactiveInventoryError ? error.diagnostic() : undefined
      results.push({
        fileUri: change.fileUri,
        status: "unavailable",
        stage: inactiveDiagnostic ? "inactive_inventory" : stage,
        blockers: inactiveDiagnostic
          ? ["SOURCE_OR_ASSIGNMENT_READ_FAILED", "INACTIVE_INVENTORY_UNAVAILABLE"]
          : ["SOURCE_OR_ASSIGNMENT_READ_FAILED"],
        ...(inactiveDiagnostic ? { inactiveInventory: inactiveDiagnostic } : {}),
        httpStatus:
          inactiveDiagnostic === undefined
            ? (/(?:HTTP|status(?: code)?)\s+([45]\d\d)/i.exec(
                error instanceof Error ? error.message : ""
              )?.[1] ?? null)
            : null
      })
    }
  }
  return {
    status: results.every((result) => result.status === "ready_for_review")
      ? "ready_for_review"
      : "blocked",
    readOnly: true,
    atomic: false,
    executionAuthorized: false,
    sapLocksAcquired: false,
    planFingerprint: hashSource(JSON.stringify(changes)),
    objects: results,
    limitations: [
      "Observations are not a transaction snapshot or an authorization to write.",
      "Use expectedSourceFingerprint on each later write; SAP rechecks it under its native lock.",
      "Transport and package observations are not a reservation or a multi-object rollback guarantee.",
      "Diffs exceeding the display limit are marked truncated; inspect the complete sources before approval."
    ]
  }
}

export function hashSource(source: string): string {
  return createHash("sha256").update(source).digest("hex")
}

export function sourceDiff(before: string, after: string) {
  const oldLines = before.split(/\r?\n/)
  const newLines = after.split(/\r?\n/)
  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start])
    start++
  let oldEnd = oldLines.length
  let newEnd = newLines.length
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--
    newEnd--
  }
  const removed = oldLines.slice(start, oldEnd)
  const added = newLines.slice(start, newEnd)
  const beforeText = removed.slice(0, 100).join("\n")
  const afterText = added.slice(0, 100).join("\n")
  return {
    startLine: start + 1,
    removedLineCount: removed.length,
    addedLineCount: added.length,
    before: beforeText.slice(0, 16_000),
    after: afterText.slice(0, 16_000),
    truncated:
      removed.length > 100 ||
      added.length > 100 ||
      beforeText.length > 16_000 ||
      afterText.length > 16_000,
    lineEndingsOnly: before !== after && removed.length === 0 && added.length === 0
  }
}
