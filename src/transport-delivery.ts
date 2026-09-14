import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import { sourceUri, whereUsedSchema } from "./where-used.js"

export const inactiveTargetSchema = z
  .object({
    objectName: whereUsedSchema.shape.objectName,
    objectUri: z.string().min(1).max(1024)
  })
  .strict()

const transportNumber = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{3}K[A-Z0-9]{6}$/)
const text = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[^\u0000-\u001f\u007f]*$/)
export const deliveryObjectSchema = z
  .object({
    pgmid: z.string().regex(/^[A-Z0-9_]{1,4}$/),
    type: z.string().regex(/^[A-Z0-9_]{1,4}$/),
    name: text(120)
      .min(1)
      .refine((s) => s === s.trim(), "Use the exact CTS object name")
  })
  .strict()
const inputSchema = z
  .object({
    connectionId: z.string().regex(/^[a-z0-9_-]{1,100}$/i),
    transportNumber,
    expectedObjects: z.array(deliveryObjectSchema).min(1).max(200),
    inactiveTargets: z.array(inactiveTargetSchema).max(100).default([])
  })
  .strict()
type ObjectKey = z.infer<typeof deliveryObjectSchema>
const key = (o: ObjectKey) => JSON.stringify([o.pgmid, o.type, o.name])
const objectSchema = z.object({
  "tm:pgmid": deliveryObjectSchema.shape.pgmid,
  "tm:type": deliveryObjectSchema.shape.type,
  "tm:name": deliveryObjectSchema.shape.name
})
const taskSchema = z.object({
  "tm:number": transportNumber,
  "tm:owner": text(12),
  "tm:status": text(20),
  objects: z.array(objectSchema).max(5000)
})
const requestSchema = taskSchema.extend({ tasks: z.array(taskSchema).max(100) })

export async function prepareTransportDelivery(
  backend: Pick<SapBackend, "transportDetails" | "inactiveObjectInventory">,
  raw: z.input<typeof inputSchema>
) {
  const input = inputSchema.parse(raw)
  if (new Set(input.expectedObjects.map(key)).size !== input.expectedObjects.length)
    throw new Error("TRANSPORT_DELIVERY_DUPLICATE_EXPECTATION")
  const connectionId = input.connectionId.toLowerCase()
  const identity = (value: string) => value.toLowerCase().replace(/\/source\/main$/, "")
  const targets = input.inactiveTargets.map((target) => ({
    objectName: target.objectName,
    uri: sourceUri(target.objectUri, connectionId, target.objectName).replace(
      `adt://${connectionId}`,
      ""
    )
  }))
  if (new Set(targets.map((target) => identity(target.uri))).size !== targets.length)
    throw new Error("TRANSPORT_DELIVERY_DUPLICATE_INACTIVE_TARGET")
  const request = requestSchema.parse(
    await backend.transportDetails(connectionId, input.transportNumber)
  )
  if (request["tm:number"] !== input.transportNumber)
    throw new Error("TRANSPORT_DELIVERY_SCOPE_MISMATCH")
  const containers = [request, ...request.tasks]
  if (new Set(containers.map((t) => t["tm:number"])).size !== containers.length)
    throw new Error("TRANSPORT_DELIVERY_DUPLICATE_CONTAINER")
  if (containers.reduce((sum, t) => sum + t.objects.length, 0) > 5000)
    throw new Error("TRANSPORT_DELIVERY_LIMIT_EXCEEDED")
  const actual = new Map<string, ObjectKey & { occurrences: string[] }>()
  for (const container of containers) {
    for (const item of container.objects) {
      const object = { pgmid: item["tm:pgmid"], type: item["tm:type"], name: item["tm:name"] }
      const id = key(object)
      const found = actual.get(id)
      if (found) found.occurrences.push(container["tm:number"])
      else actual.set(id, { ...object, occurrences: [container["tm:number"]] })
    }
  }
  const sorted = <T extends ObjectKey>(items: T[]) =>
    items.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
  const expectedKeys = new Set(input.expectedObjects.map(key))
  const entries = sorted([...actual.values()]).map((entry) => ({
    ...entry,
    occurrences: entry.occurrences.sort()
  }))
  const expected = sorted([...input.expectedObjects])
  const missing = expected.filter((entry) => !actual.has(key(entry)))
  const unexpected = entries.filter((entry) => !expectedKeys.has(key(entry)))
  const duplicates = entries.filter((entry) => entry.occurrences.length > 1)
  const headers = containers
    .map((t) => ({
      number: t["tm:number"],
      owner: t["tm:owner"],
      rawStatus: t["tm:status"],
      role: t === request ? "selected_request" : "returned_task"
    }))
    .sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0))
  let inactiveCheck: {
    status: "not_requested" | "observed" | "unavailable"
    code?: string
    transportOnlyRecords?: number
    targets: Array<{
      objectName: string
      uri: string
      status: "inactive_observed" | "not_in_returned_list"
      matches: unknown[]
    }>
  } = { status: "not_requested", targets: [] }
  if (targets.length) {
    try {
      if (!backend.inactiveObjectInventory) throw new Error("Reader unavailable")
      const inventory = await backend.inactiveObjectInventory(connectionId)
      inactiveCheck = {
        status: "observed",
        transportOnlyRecords: inventory.transportOnlyRecords,
        targets: targets.map((target) => {
          const matches = inventory.entries.filter(
            (entry) => identity(entry.uri) === identity(target.uri)
          )
          if (matches.some((entry) => entry.name.toUpperCase() !== target.objectName.toUpperCase()))
            throw new Error("Inactive target identity mismatch")
          return {
            ...target,
            status: matches.length ? "inactive_observed" : "not_in_returned_list",
            matches
          }
        })
      }
    } catch {
      inactiveCheck = { status: "unavailable", code: "INACTIVE_INVENTORY_UNAVAILABLE", targets: [] }
    }
  }
  return {
    connectionId,
    transportNumber: input.transportNumber,
    observedAt: new Date().toISOString(),
    readOnly: true,
    status: "partial",
    comparison: missing.length || unexpected.length ? "differences" : "exact_key_match",
    readyToRelease: "not_determined",
    headers,
    expected,
    objects: entries,
    missingFromObservedList: missing,
    unexpectedInObservedList: unexpected,
    duplicateOccurrences: duplicates,
    inactiveCheck: { ...inactiveCheck, requestedTargets: targets },
    fingerprint: createHash("sha256")
      .update(JSON.stringify({ connectionId, headers, expected, entries }))
      .digest("hex"),
    coverage: {
      source: "single_adt_transport_details_response",
      repositoryComplete: false,
      atomicSnapshot: false,
      inactiveObjects: targets.length ? "explicit_source_targets_only" : "not_checked",
      dependencies: "not_checked",
      tableKeys: "not_checked",
      otherRequests: "not_searched"
    },
    warnings: [
      "Exact CTS pgmid/type/name keys only; R3TR containers and LIMU subobjects are not treated as interchangeable.",
      "Missing means absent from the observed list, not unassigned or nonexistent in SAP.",
      "Duplicate occurrences may legitimately exist in parent and task lists; they are not automatically defects.",
      "An exact key match does not establish activation, dependency completeness, transportability or release readiness.",
      "No assignment, activation, request creation or release is performed. No SAP source is downloaded.",
      "Inactive checks use one session-visible ADT inventory, independently of CTS key comparison. Explicit source targets are not automatically mapped to transport objects.",
      "Not in the returned inactive list never proves active state or coverage of other users. Inactive observations are separate from the transport fingerprint."
    ]
  }
}
