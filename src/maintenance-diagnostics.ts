import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import {
  diagnosticConnectionId,
  diagnosticTime,
  validateDiagnosticInterval
} from "./operational-logs.js"
import { redactDiagnosticText } from "./runtime-diagnostics.js"

export const MAINTENANCE_HELPER = "Z_ORVANTA_MAINT_READ"
export const MAINTENANCE_APPROVAL_FILE = "maintenance-diagnostic-approvals.json"
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const username = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]{1,12}$/)
const name = (max: number) =>
  z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_/]+$/)
    .max(max)
const key = z.string().regex(/^[A-Z0-9]{1,32}$/)
const baseInput = {
  connectionId: diagnosticConnectionId,
  username,
  operationId: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,64}$/)
    .optional()
}
export const searchSapLocksSchema = z
  .object({
    ...baseInput,
    tableName: name(30).optional(),
    lockObject: name(16).optional(),
    argument: z
      .string()
      .min(1)
      .max(150)
      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Control characters are not allowed")
      .optional(),
    maxResults: z.number().int().min(1).max(100).default(20)
  })
  .strict()
export const searchFailedUpdatesSchema = z
  .object({
    ...baseInput,
    fromSystemTime: diagnosticTime,
    toSystemTime: diagnosticTime,
    maxResults: z.number().int().min(1).max(100).default(20)
  })
  .strict()
export const readFailedUpdateSchema = z
  .object({
    ...baseInput,
    updateKey: key,
    expectedRevision: hash.optional()
  })
  .strict()

export const maintenanceApprovalsSchema = z
  .object({
    version: z.literal(1),
    connections: z
      .array(
        z
          .object({
            connectionId: diagnosticConnectionId,
            url: z.string().url(),
            client: z.string().regex(/^\d{3}$/),
            username,
            sourceFingerprint: hash,
            interfaceFingerprint: hash,
            enabledSources: z
              .array(z.enum(["SM12", "SM13"]))
              .min(1)
              .max(2)
          })
          .strict()
      )
      .max(50)
  })
  .strict()

const lockEntry = z
  .object({
    client: z.string().regex(/^\d{3}$/),
    username,
    tableName: name(30),
    lockObject: z.string().max(16),
    argument: z.string().max(150),
    mode: z.string().min(1).max(1),
    ownerSystemTime: diagnosticTime.nullable(),
    host: z.string().max(64),
    transaction: z.string().max(20)
  })
  .strict()
const updateEntry = z
  .object({
    updateKey: key,
    client: z.string().regex(/^\d{3}$/),
    username,
    systemTime: diagnosticTime,
    program: z.string().max(40),
    transaction: z.string().max(20),
    server: z.string().max(64),
    state: z.number().int().min(0).max(255),
    returnCode: z.number().int().min(-2147483648).max(2147483647)
  })
  .strict()
const moduleEntry = z
  .object({
    number: z.number().int().min(1),
    functionName: name(30),
    mode: z.string().max(1),
    returnCode: z.number().int()
  })
  .strict()
const errorEntry = z
  .object({
    number: z.number().int().min(1),
    functionName: z.string().max(30),
    program: z.string().max(40),
    line: z.number().int().min(0),
    messageClass: z.string().max(20),
    messageNumber: z.string().max(3),
    textUnavailable: z.literal(true)
  })
  .strict()
const envelope = z
  .object({
    version: z.literal("1"),
    client: z.string().regex(/^\d{3}$/),
    authenticatedUser: username,
    readOnly: z.literal(true),
    status: z.enum(["ok", "not_found", "forbidden", "unsupported"]),
    code: z.enum([
      "OK",
      "NOT_FOUND",
      "NO_AUTHORITY",
      "LIMIT_EXCEEDED",
      "DATA_CHANGED",
      "INVALID_INPUT",
      "READ_FAILED"
    ]),
    hasMore: z.boolean(),
    // Present only on the helper's CAPABILITIES self-description, which reuses this JSON
    // envelope but carries its payload rows in this array instead of an `it_source` table. The
    // key stays optional and the object stays `.strict()`: business replies never carry it, and
    // an unknown key is still rejected.
    payload: z.array(z.string()).optional()
  })
  .strict()
const replySchema = z.discriminatedUnion("action", [
  envelope.extend({ action: z.literal("LOCK_SEARCH"), entries: z.array(lockEntry).max(100) }),
  envelope.extend({ action: z.literal("UPDATE_SEARCH"), entries: z.array(updateEntry).max(100) }),
  envelope.extend({
    action: z.literal("UPDATE_DETAIL"),
    header: updateEntry.nullable(),
    modules: z.array(moduleEntry).max(200),
    errors: z.array(errorEntry).max(200)
  })
])
type Reply = z.infer<typeof replySchema>
type MetadataReader = (connectionId: string, functionName: string) => Promise<unknown>
type ReceiptReader = (connectionId: string, operationId: string) => Promise<unknown>

/**
 * Why a maintenance read stopped before touching SAP, and what an administrator has to change.
 *
 * The stable `code` alone cannot distinguish "no approval file at all" from "this connection is not
 * in it", and neither says which file the service actually read - the 2026-09-21 15:34 incident
 * read `HELPER_NOT_APPROVED` as "SAP-side approval missing" when the helper was in fact deployed
 * and only the local file was absent. `reason` and `expectedApprovalFile` exist so a caller can
 * tell a local gate from a deployment gap without reading this service's source.
 */
export type MaintenanceApprovalFailure = {
  code: "HELPER_NOT_APPROVED" | "SOURCE_NOT_APPROVED"
  reason: "APPROVAL_FILE_MISSING" | "CONNECTION_NOT_APPROVED" | "SOURCE_NOT_ENABLED"
  expectedApprovalFile: string
  requestedSource?: "SM12" | "SM13"
  approvedSources?: readonly ("SM12" | "SM13")[]
}

export function isFailedUpdate(state: number, returnCode: number) {
  // W200 TSKHINCL: aborted=253; error RCs 2..201, not scheduling RCs 241..255.
  return state === 253 || (returnCode >= 2 && returnCode <= 201)
}

export class MaintenanceDiagnosticService {
  constructor(
    private readonly backend: SapBackend,
    private readonly stateRoot: string,
    private readonly readDefinition: MetadataReader,
    private readonly readReceipt?: ReceiptReader
  ) {}

  private async execute(
    connectionId: string,
    action: Reply["action"],
    parameters: Record<string, string>
  ): Promise<{ reply: Reply } | { failure: MaintenanceApprovalFailure }> {
    const connection = this.backend.connectionDetails(connectionId)
    const expectedApprovalFile = join(this.stateRoot, MAINTENANCE_APPROVAL_FILE)
    let document: unknown
    try {
      const bytes = await readFile(expectedApprovalFile)
      if (bytes.length > 65536) throw new Error("Approval too large")
      document = JSON.parse(bytes.toString("utf8"))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return {
          failure: {
            code: "HELPER_NOT_APPROVED",
            reason: "APPROVAL_FILE_MISSING",
            expectedApprovalFile
          }
        }
      throw new Error("MAINTENANCE_APPROVAL_INVALID")
    }
    const parsed = maintenanceApprovalsSchema.safeParse(document)
    if (!parsed.success) throw new Error("MAINTENANCE_APPROVAL_INVALID")
    const entries = parsed.data.connections.filter(
      (x) => x.connectionId.toLowerCase() === connectionId
    )
    if (entries.length > 1) throw new Error("MAINTENANCE_APPROVAL_DUPLICATE")
    const approval = entries[0]
    if (!approval)
      return {
        failure: {
          code: "HELPER_NOT_APPROVED",
          reason: "CONNECTION_NOT_APPROVED",
          expectedApprovalFile
        }
      }
    if (
      approval.url.replace(/\/$/, "") !== connection.url.replace(/\/$/, "") ||
      approval.client !== connection.client ||
      approval.username.toUpperCase() !== connection.username.toUpperCase()
    )
      throw new Error("MAINTENANCE_APPROVAL_CONNECTION_MISMATCH")
    const source = action === "LOCK_SEARCH" ? "SM12" : "SM13"
    if (!approval.enabledSources.includes(source))
      return {
        failure: {
          code: "SOURCE_NOT_APPROVED",
          reason: "SOURCE_NOT_ENABLED",
          expectedApprovalFile,
          requestedSource: source,
          approvedSources: approval.enabledSources
        }
      }
    const metadata = z
      .object({
        functionName: z.literal(MAINTENANCE_HELPER),
        functionGroup: z.literal("ZORVANTA_MAINT"),
        remoteEnabled: z.literal(true),
        updateTask: z.literal(false),
        sourceFingerprint: hash,
        interfaceFingerprint: hash
      })
      .safeParse(await this.readDefinition(connectionId, MAINTENANCE_HELPER))
    if (
      !metadata.success ||
      metadata.data.sourceFingerprint !== approval.sourceFingerprint ||
      metadata.data.interfaceFingerprint !== approval.interfaceFingerprint
    )
      throw new Error("MAINTENANCE_HELPER_FINGERPRINT_MISMATCH")
    const response = await this.backend.callRemoteFunction(connectionId, {
      functionName: MAINTENANCE_HELPER,
      inputParameters: { IV_ACTION: action, ...parameters },
      outputParameters: [{ name: "EV_RESULT", kind: "scalar" }]
    })
    const raw = response.outputs.EV_RESULT
    if (
      response.fault ||
      typeof raw !== "string" ||
      Buffer.byteLength(raw) > 512 * 1024 ||
      Object.keys(response.outputs).some((x) => x !== "EV_RESULT")
    )
      throw new Error("MAINTENANCE_RESPONSE_INVALID")
    let decoded: unknown
    try {
      decoded = JSON.parse(raw)
    } catch {
      throw new Error("MAINTENANCE_RESPONSE_INVALID")
    }
    const result = replySchema.safeParse(decoded)
    if (!result.success) throw new Error("MAINTENANCE_RESPONSE_INVALID")
    const reply = result.data
    if (
      reply.action !== action ||
      reply.client !== connection.client ||
      reply.authenticatedUser.toUpperCase() !== connection.username.toUpperCase()
    )
      throw new Error("MAINTENANCE_RESPONSE_SCOPE_MISMATCH")
    const carriesData =
      reply.action === "UPDATE_DETAIL"
        ? reply.header !== null || reply.modules.length > 0 || reply.errors.length > 0
        : reply.entries.length > 0
    const validCode =
      reply.status === "ok"
        ? reply.code === "OK"
        : reply.status === "forbidden"
          ? reply.code === "NO_AUTHORITY"
          : reply.status === "not_found"
            ? reply.code === "NOT_FOUND"
            : ["LIMIT_EXCEEDED", "DATA_CHANGED", "INVALID_INPUT", "READ_FAILED"].includes(
                reply.code
              )
    if (
      !validCode ||
      (reply.status !== "ok" && (carriesData || reply.hasMore)) ||
      (reply.action === "UPDATE_DETAIL" && reply.hasMore)
    )
      throw new Error("MAINTENANCE_RESPONSE_INVALID")
    return { reply }
  }

  private async context(connectionId: string, source: "SM12" | "SM13", operationId?: string) {
    const connection = this.backend.connectionDetails(connectionId)
    // Local operation protection is evidence about the caller, never a SAP lock identity.
    const receipt =
      operationId && this.readReceipt
        ? await this.readReceipt(connectionId, operationId)
        : undefined
    const receiptStatus = z.object({ status: z.string().max(64) }).safeParse(receipt)
    return {
      source,
      connectionId,
      client: connection.client,
      readOnly: true,
      observedAt: new Date().toISOString(),
      transactionSnapshot: false,
      ...(operationId
        ? {
            localOperation: {
              operationId,
              status: receiptStatus.success ? receiptStatus.data.status : "unavailable",
              scope: "local_mcp_receipt_only",
              provesSapLockOwnership: false
            }
          }
        : {}),
      warnings: [
        "No unlock, retry, delete, cancel or update processing is performed.",
        "Observations are not a transaction snapshot or proof of root cause.",
        "Lock arguments and log metadata may contain sensitive business identifiers."
      ]
    }
  }

  async searchLocks(input: z.input<typeof searchSapLocksSchema>) {
    const o = searchSapLocksSchema.parse(input)
    const id = o.connectionId.toLowerCase()
    const base = await this.context(id, "SM12", o.operationId)
    const result = await this.execute(id, "LOCK_SEARCH", {
      IV_USER: o.username.toUpperCase(),
      IV_TABLE: o.tableName?.toUpperCase() ?? "",
      IV_OBJECT: o.lockObject?.toUpperCase() ?? "",
      IV_ARGUMENT: o.argument ?? "",
      IV_LIMIT: String(o.maxResults)
    })
    if ("failure" in result)
      return JSON.stringify({ ...base, status: "unavailable", ...result.failure, entries: null })
    const r = result.reply
    if (r.action !== "LOCK_SEARCH") throw new Error("MAINTENANCE_RESPONSE_SCOPE_MISMATCH")
    if (r.entries.length > o.maxResults || (r.hasMore && r.entries.length !== o.maxResults))
      throw new Error("MAINTENANCE_RESPONSE_LIMIT")
    for (const row of r.entries) {
      if (
        row.client !== base.client ||
        row.username.toUpperCase() !== o.username.toUpperCase() ||
        (o.tableName && row.tableName !== o.tableName.toUpperCase()) ||
        (o.lockObject && row.lockObject !== o.lockObject.toUpperCase()) ||
        (o.argument !== undefined && row.argument !== o.argument)
      )
        throw new Error("MAINTENANCE_RESPONSE_SCOPE_MISMATCH")
    }
    return JSON.stringify({
      ...base,
      status: r.status,
      code: r.code,
      entries:
        r.status === "ok"
          ? r.entries.map((row) => ({
              ...row,
              argument: redactDiagnosticText(row.argument)
            }))
          : null,
      hasMore: r.hasMore,
      returnedCount: r.status === "ok" ? r.entries.length : null,
      coverage: "exact_user_current_client_native_selection",
      ownerTimeSemantics: "owner_identifier_time_not_proven_lock_acquisition_time",
      backendLimit:
        "Native ENQUEUE_READ has no row-limit parameter; selected result above 2000 is rejected after retrieval."
    })
  }

  async searchUpdates(input: z.input<typeof searchFailedUpdatesSchema>) {
    const o = searchFailedUpdatesSchema.parse(input)
    validateDiagnosticInterval(o.fromSystemTime, o.toSystemTime, 3600)
    const id = o.connectionId.toLowerCase()
    const base = await this.context(id, "SM13", o.operationId)
    const result = await this.execute(id, "UPDATE_SEARCH", {
      IV_USER: o.username.toUpperCase(),
      IV_FROM: o.fromSystemTime,
      IV_TO: o.toSystemTime,
      IV_LIMIT: String(o.maxResults)
    })
    if ("failure" in result)
      return JSON.stringify({ ...base, status: "unavailable", ...result.failure, entries: null })
    const r = result.reply
    if (r.action !== "UPDATE_SEARCH") throw new Error("MAINTENANCE_RESPONSE_SCOPE_MISMATCH")
    if (r.entries.length > o.maxResults || (r.hasMore && r.entries.length !== o.maxResults))
      throw new Error("MAINTENANCE_RESPONSE_LIMIT")
    const seen = new Set<string>()
    for (const row of r.entries) {
      if (
        seen.has(row.updateKey) ||
        row.client !== base.client ||
        row.username.toUpperCase() !== o.username.toUpperCase() ||
        row.systemTime < o.fromSystemTime ||
        row.systemTime > o.toSystemTime ||
        !isFailedUpdate(row.state, row.returnCode)
      )
        throw new Error("MAINTENANCE_RESPONSE_SCOPE_MISMATCH")
      seen.add(row.updateKey)
    }
    return JSON.stringify({
      ...base,
      status: r.status,
      code: r.code,
      entries: r.status === "ok" ? r.entries : null,
      hasMore: r.hasMore,
      returnedCount: r.status === "ok" ? r.entries.length : null,
      selection: {
        username: o.username.toUpperCase(),
        fromSystemTime: o.fromSystemTime,
        toSystemTime: o.toSystemTime
      },
      timeSemantics: "VBHDR-VBDATE; SAP local time; no implicit UTC conversion",
      failurePredicate: "VBSTATE=253 OR VBRC between 2 and 201",
      coverage: "retained_failed_update_headers_current_client"
    })
  }

  async readUpdate(input: z.input<typeof readFailedUpdateSchema>) {
    const o = readFailedUpdateSchema.parse(input)
    const id = o.connectionId.toLowerCase()
    const base = await this.context(id, "SM13", o.operationId)
    const result = await this.execute(id, "UPDATE_DETAIL", {
      IV_USER: o.username.toUpperCase(),
      IV_KEY: o.updateKey
    })
    if ("failure" in result)
      return JSON.stringify({ ...base, status: "unavailable", ...result.failure, data: null })
    const r = result.reply
    if (r.action !== "UPDATE_DETAIL") throw new Error("MAINTENANCE_RESPONSE_SCOPE_MISMATCH")
    if (r.status !== "ok")
      return JSON.stringify({ ...base, status: r.status, code: r.code, data: null })
    if (
      !r.header ||
      r.header.updateKey !== o.updateKey ||
      r.header.client !== base.client ||
      r.header.username.toUpperCase() !== o.username.toUpperCase() ||
      !isFailedUpdate(r.header.state, r.header.returnCode)
    )
      throw new Error("MAINTENANCE_RESPONSE_SCOPE_MISMATCH")
    const modules = new Map(r.modules.map((x) => [x.number, x]))
    if (
      modules.size !== r.modules.length ||
      new Set(r.errors.map((x) => x.number)).size !== r.errors.length
    )
      throw new Error("MAINTENANCE_RESPONSE_DUPLICATE")
    for (const error of r.errors)
      if (
        !modules.has(error.number) ||
        (error.functionName && modules.get(error.number)!.functionName !== error.functionName)
      )
        throw new Error("MAINTENANCE_RESPONSE_MODULE_MISMATCH")
    const data = { header: r.header, modules: r.modules, errors: r.errors }
    const revision = createHash("sha256").update(JSON.stringify(data)).digest("hex")
    if (o.expectedRevision && revision !== o.expectedRevision)
      return JSON.stringify({ ...base, status: "unsupported", code: "DATA_CHANGED", data: null })
    return JSON.stringify({
      ...base,
      status: "ok",
      code: "OK",
      data,
      revision,
      errorText:
        "Message identifiers and source location only; encoded variables and VBDATA are not exposed.",
      correlationCandidates: {
        diagnose_sap_failure: {
          connectionId: id,
          username: r.header.username,
          program: r.header.program || null,
          systemTime: r.header.systemTime
        },
        search_background_jobs: {
          connectionId: id,
          username: r.header.username,
          jobName: null,
          systemTime: r.header.systemTime
        },
        executableArguments: false,
        causalLinkProven: false,
        note: "Choose an explicit SAP-local time window and exact job name before querying existing tools."
      }
    })
  }
}
