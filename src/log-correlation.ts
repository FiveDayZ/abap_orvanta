import { createHash } from "node:crypto"
import { z } from "zod"
import type { ApplicationLogService } from "./application-logs.js"
import { searchApplicationLogsSchema } from "./application-logs.js"
import {
  diagnosticConnectionId,
  diagnosticTime,
  searchBackgroundJobsSchema,
  readSystemLogsSchema,
  validateDiagnosticInterval,
  type OperationalLogService
} from "./operational-logs.js"
import { redactDiagnosticText, type RuntimeDiagnosticInput } from "./runtime-diagnostics.js"
import {
  searchSapLocksSchema,
  searchFailedUpdatesSchema,
  type MaintenanceDiagnosticService
} from "./maintenance-diagnostics.js"

export const correlateSapLogsSchema = z
  .object({
    connectionId: diagnosticConnectionId,
    fromSystemTime: diagnosticTime,
    toSystemTime: diagnosticTime,
    applicationLog: z
      .object({
        object: searchApplicationLogsSchema.shape.object,
        subobject: searchApplicationLogsSchema.shape.subobject,
        externalNumber: searchApplicationLogsSchema.shape.externalNumber,
        logNumber: z
          .string()
          .regex(/^\d{20}$/)
          .optional()
      })
      .strict()
      .optional(),
    job: z
      .object({
        jobName: searchBackgroundJobsSchema.shape.jobName,
        includeDetails: z.boolean().default(false),
        jobCount: z
          .string()
          .regex(/^\d{8}$/)
          .optional()
      })
      .strict()
      .optional(),
    locks: searchSapLocksSchema
      .pick({ username: true, tableName: true, lockObject: true, argument: true })
      .optional(),
    failedUpdates: searchFailedUpdatesSchema.pick({ username: true }).optional(),
    systemLog: z
      .object({
        username: readSystemLogsSchema.shape.username,
        program: readSystemLogsSchema.shape.program
      })
      .strict()
      .optional(),
    includeDumps: z.boolean().default(true),
    maxPerSource: z.number().int().min(1).max(20).default(10),
    correlationWindowSeconds: z.number().int().min(0).max(900).default(60)
  })
  .strict()
export type CorrelateSapLogsInput = z.input<typeof correlateSapLogsSchema>
type Source = "SLG1" | "SM37" | "SM21" | "ST22" | "SM13" | "SM12" | "SM37_DETAILS"
const eventSchema = z
  .object({
    source: z.enum(["SLG1", "SM37", "SM21", "ST22", "SM13"]),
    key: z.string().min(1).max(4096),
    systemTime: diagnosticTime.nullable(),
    username: z.string().max(80),
    program: z.string().max(160),
    server: z.string().max(160),
    text: z.string().max(8192),
    textUnavailable: z.boolean().optional(),
    textTruncated: z.boolean().optional(),
    reference: z.record(z.union([z.string().max(4096), z.number().int().nonnegative()]))
  })
  .strict()
export type CorrelationEvent = z.infer<typeof eventSchema>
type SourceState = {
  source: Source
  status: string
  code?: string
  reason?: string
  returnedCount: number
  truncated: boolean
  coverage?: "local_instance_bounded_tail"
  server?: string
  scannedRecords?: number
}
type DiagnosticReader = (input: RuntimeDiagnosticInput) => Promise<string>

// Correlation compares structured identities only, never instructions or keywords in message text.
export function correlateLogEvents(
  connectionId: string,
  client: string,
  events: CorrelationEvent[],
  windowSeconds: number
) {
  if (
    events.length > 100 ||
    !Number.isInteger(windowSeconds) ||
    windowSeconds < 0 ||
    windowSeconds > 900
  )
    throw new Error("CORRELATION_BUDGET_EXCEEDED")
  const seen = new Set<string>()
  const timeline = events
    .map((raw) => {
      const event = eventSchema.parse(raw)
      const id = createHash("sha256")
        .update(JSON.stringify([connectionId.toLowerCase(), client, event.source, event.key]))
        .digest("hex")
      if (seen.has(id)) throw new Error("CORRELATION_DUPLICATE_EVENT")
      seen.add(id)
      return { ...event, text: redactDiagnosticText(event.text), id }
    })
    .sort(
      (a, b) => (a.systemTime ?? "").localeCompare(b.systemTime ?? "") || a.id.localeCompare(b.id)
    )
  const candidates: Array<{
    left: string
    right: string
    deltaSeconds: number
    matchingFields: string[]
    evidenceLevel: "time_only" | "time_and_identity"
    causalRelationship: "not_proven"
  }> = []
  let candidateCount = 0
  for (let i = 0; i < timeline.length; i++) {
    const left = timeline[i]!
    if (!left.systemTime) continue
    for (const right of timeline.slice(i + 1)) {
      if (left.source === right.source || !right.systemTime) continue
      const deltaSeconds =
        Math.abs(Date.parse(`${left.systemTime}Z`) - Date.parse(`${right.systemTime}Z`)) / 1000
      if (deltaSeconds > windowSeconds) continue
      const matchingFields = ["username", "program", "server"].filter((field) => {
        const a = left[field as "username" | "program" | "server"]
        const b = right[field as "username" | "program" | "server"]
        return a !== "" && b !== "" && a.toUpperCase() === b.toUpperCase()
      })
      candidateCount++
      if (candidates.length < 200)
        candidates.push({
          left: left.id,
          right: right.id,
          deltaSeconds,
          matchingFields,
          evidenceLevel: matchingFields.length ? "time_and_identity" : "time_only",
          causalRelationship: "not_proven"
        })
    }
  }
  return {
    timeline,
    candidates,
    candidateCount,
    candidatesTruncated: candidateCount > candidates.length
  }
}

export class LogCorrelationService {
  constructor(
    private readonly application: ApplicationLogService,
    private readonly operations: OperationalLogService,
    private readonly readDumps: DiagnosticReader,
    private readonly connectionClient: (id: string) => string,
    private readonly maintenance?: Pick<
      MaintenanceDiagnosticService,
      "searchLocks" | "searchUpdates"
    >
  ) {}

  async correlate(input: CorrelateSapLogsInput): Promise<string> {
    const options = correlateSapLogsSchema.parse(input)
    validateDiagnosticInterval(
      options.fromSystemTime,
      options.toSystemTime,
      options.systemLog || options.failedUpdates ? 3600 : 86400
    )
    if (
      !options.applicationLog &&
      !options.job &&
      !options.systemLog &&
      !options.includeDumps &&
      !options.locks &&
      !options.failedUpdates
    )
      throw new Error("Select at least one diagnostic source")
    if (options.job?.includeDetails && !options.job.jobCount)
      throw new Error("Job details require an exact jobCount")
    if (options.applicationLog?.logNumber && options.applicationLog.externalNumber)
      throw new Error(
        "For exact message correlation, omit externalNumber and use object/subobject/logNumber"
      )
    const connectionId = options.connectionId.toLowerCase()
    const client = this.connectionClient(connectionId)
    const scope = {
      connectionId,
      fromSystemTime: options.fromSystemTime,
      toSystemTime: options.toSystemTime
    }
    const events: CorrelationEvent[] = []
    const states: SourceState[] = []
    const observations: Array<{
      source: "SM12" | "SM37_DETAILS"
      temporalScope: "current_observation_not_historical_event"
      report: Record<string, unknown>
    }> = []
    const limit = options.maxPerSource
    // Fixed, sequential reads preserve a hard request budget and deterministic per-source failures.
    const collect = async (
      source: Source,
      call: () => Promise<string>,
      map: (result: Record<string, any>) => CorrelationEvent[]
    ) => {
      try {
        const raw = await call()
        if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error("Response budget exceeded")
        const report = JSON.parse(raw)
        if (
          !report ||
          typeof report !== "object" ||
          report.connectionId !== connectionId ||
          (report.client !== undefined && report.client !== client) ||
          report.readOnly !== true ||
          typeof report.status !== "string"
        )
          throw new Error("Invalid source scope")
        const state: SourceState = {
          source,
          status: report.status,
          returnedCount: 0,
          truncated: Boolean(report.hasMore || report.truncated || report.status === "partial")
        }
        if (!["ok", "partial"].includes(report.status)) {
          if (typeof report.reason === "string" && /^[A-Z0-9_]{1,80}$/.test(report.reason))
            state.reason = report.reason
          state.code =
            typeof report.code === "string" && /^[A-Z0-9_]{1,80}$/.test(report.code)
              ? report.code
              : "SOURCE_UNAVAILABLE"
        } else {
          if (source === "SM21") {
            state.coverage = z.literal("local_instance_bounded_tail").parse(report.coverage)
            state.server = z.string().min(1).max(64).parse(report.server)
            state.scannedRecords = z.number().int().min(0).max(2000).parse(report.scannedRecords)
          }
          const mapped = map(report).map((event) => eventSchema.parse(event))
          if (mapped.length > limit) throw new Error("Source budget exceeded")
          const withinScope = mapped.filter(
            (event) =>
              event.systemTime !== null &&
              event.systemTime >= options.fromSystemTime &&
              event.systemTime <= options.toSystemTime
          )
          events.push(...withinScope)
          state.returnedCount = withinScope.length
          if (withinScope.length !== mapped.length) state.truncated = true
        }
        states.push(state)
      } catch {
        // Do not include backend exceptions that may contain raw diagnostic data or credentials.
        states.push({
          source,
          status: "failed",
          code: "SOURCE_READ_FAILED",
          returnedCount: 0,
          truncated: false
        })
      }
    }
    // Keep current locks and current job metadata outside the historical event timeline.
    const observe = async (
      source: "SM12" | "SM37_DETAILS",
      call: () => Promise<string>,
      count: (report: Record<string, any>) => number
    ) => {
      try {
        const raw = await call()
        if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error("Response budget exceeded")
        const report = JSON.parse(raw)
        if (
          report?.connectionId !== connectionId ||
          report?.client !== client ||
          report?.readOnly !== true ||
          typeof report?.status !== "string"
        )
          throw new Error("Invalid observation scope")
        if (report.status !== "ok") {
          states.push({
            source,
            status: report.status,
            returnedCount: 0,
            truncated: false,
            code:
              typeof report.code === "string" && /^[A-Z0-9_]{1,80}$/.test(report.code)
                ? report.code
                : "SOURCE_UNAVAILABLE"
          })
          return
        }
        const returnedCount = count(report)
        if (
          !Number.isInteger(returnedCount) ||
          returnedCount < 0 ||
          returnedCount > (source === "SM12" ? limit : 100)
        )
          throw new Error("Observation budget exceeded")
        observations.push({
          source,
          temporalScope: "current_observation_not_historical_event",
          report
        })
        states.push({ source, status: "ok", returnedCount, truncated: Boolean(report.hasMore) })
      } catch {
        states.push({
          source,
          status: "failed",
          code: "SOURCE_READ_FAILED",
          returnedCount: 0,
          truncated: false
        })
      }
    }
    if (options.applicationLog) {
      const selection = options.applicationLog
      if (selection.logNumber) {
        await collect(
          "SLG1",
          () =>
            this.application.read({
              connectionId,
              logNumber: selection.logNumber!,
              maxMessages: limit
            }),
          (report) => {
            const header = report.header
            if (
              header.object !== selection.object.toUpperCase() ||
              (selection.subobject && header.subobject !== selection.subobject.toUpperCase()) ||
              selection.externalNumber
            )
              throw new Error(
                "Message correlation requires an exact approved header scope without external-number redaction ambiguity"
              )
            return report.messages.map((row: any) => ({
              source: "SLG1",
              key: `${header.logNumber}:${row.number}`,
              systemTime: row.systemTime,
              username: header.username,
              program: header.program,
              server: "",
              text: row.text,
              textUnavailable: row.textUnavailable,
              textTruncated: row.textTruncated,
              reference: { logNumber: header.logNumber, messageNumber: row.number }
            }))
          }
        )
      } else {
        await collect(
          "SLG1",
          () =>
            this.application.search({
              ...scope,
              object: selection.object,
              subobject: selection.subobject,
              externalNumber: selection.externalNumber,
              maxResults: limit
            }),
          (report) =>
            report.headers.map((row: any) => ({
              source: "SLG1",
              key: row.logNumber,
              systemTime: row.systemTime,
              username: row.username,
              program: row.program,
              server: "",
              text: "",
              reference: { logNumber: row.logNumber, object: row.object, subobject: row.subobject }
            }))
        )
      }
    }
    if (options.job) {
      const selection = options.job
      if (selection.jobCount) {
        await collect(
          "SM37",
          () =>
            this.operations.readJobLog({
              connectionId,
              jobName: selection.jobName,
              jobCount: selection.jobCount!,
              maxMessages: limit
            }),
          (report) =>
            report.messages.map((row: any) => ({
              source: "SM37",
              key: `${report.job.jobName}:${report.job.jobCount}:${row.number}`,
              systemTime: row.systemTime,
              username: report.job.executionUser,
              program: "",
              server: report.job.server,
              text: row.text,
              textUnavailable: row.textUnavailable,
              textTruncated: row.textTruncated,
              reference: {
                jobName: report.job.jobName,
                jobCount: report.job.jobCount,
                messageNumber: row.number
              }
            }))
        )
      } else {
        await collect(
          "SM37",
          () =>
            this.operations.searchJobs({
              ...scope,
              jobName: selection.jobName,
              maxResults: limit
            }),
          (report) =>
            report.jobs.map((row: any) => ({
              source: "SM37",
              key: `${row.jobName}:${row.jobCount}`,
              systemTime: row.startSystemTime,
              username: row.executionUser,
              program: "",
              server: row.server,
              text: "",
              reference: { jobName: row.jobName, jobCount: row.jobCount }
            }))
        )
      }
    }
    if (options.systemLog)
      await collect(
        "SM21",
        () =>
          this.operations.readSystem({
            ...scope,
            ...options.systemLog,
            maxResults: limit
          }),
        (report) =>
          report.entries.map((row: any) => ({
            source: "SM21",
            key: row.id,
            systemTime: row.systemTime,
            username: row.username,
            program: row.program,
            server: row.server,
            text: row.text,
            textUnavailable: row.textUnavailable,
            textTruncated: row.textTruncated,
            reference: { entryId: row.id, server: row.server, messageId: row.messageId }
          }))
      )
    if (options.includeDumps)
      await collect(
        "ST22",
        () =>
          this.readDumps({
            ...scope,
            maxResults: limit,
            includeSource: false
          }),
        (report) => {
          // ST22 feeds may span clients. Reject the entire source rather than leak cross-client events.
          if (report.dumps.some((row: any) => row.client !== client))
            throw new Error("Dump client mismatch")
          return report.dumps.map((row: any) => ({
            source: "ST22",
            key: row.dumpId,
            systemTime: row.systemTime,
            username: row.username,
            program: row.program,
            server: row.host,
            text: row.shortText,
            reference: { dumpId: row.dumpId, errorType: row.errorType }
          }))
        }
      )
    if (options.failedUpdates) {
      const selection = options.failedUpdates
      await collect(
        "SM13",
        () => {
          if (!this.maintenance) throw new Error("Maintenance reader unavailable")
          return this.maintenance.searchUpdates({
            ...scope,
            username: selection.username,
            maxResults: limit
          })
        },
        (report) => {
          if (
            report.client !== client ||
            report.entries.some(
              (row: any) =>
                row.client !== client ||
                row.username?.toUpperCase() !== selection.username.toUpperCase()
            )
          )
            throw new Error("Update scope mismatch")
          return report.entries.map((row: any) => ({
            source: "SM13",
            key: row.updateKey,
            systemTime: row.systemTime,
            username: row.username,
            program: row.program,
            server: row.server,
            text: "",
            textUnavailable: true,
            reference: { updateKey: row.updateKey, transaction: row.transaction, state: row.state }
          }))
        }
      )
    }
    if (options.locks) {
      const selection = options.locks
      await observe(
        "SM12",
        () => {
          if (!this.maintenance) throw new Error("Maintenance reader unavailable")
          return this.maintenance.searchLocks({ connectionId, ...selection, maxResults: limit })
        },
        (report) => {
          if (
            !Array.isArray(report.entries) ||
            report.entries.some(
              (row: any) =>
                row.client !== client ||
                row.username?.toUpperCase() !== selection.username.toUpperCase()
            )
          )
            throw new Error("Lock scope mismatch")
          return report.entries.length
        }
      )
    }
    if (options.job?.includeDetails) {
      const selection = options.job
      await observe(
        "SM37_DETAILS",
        () =>
          this.operations.readJobDetails({
            connectionId,
            jobName: selection.jobName,
            jobCount: selection.jobCount!
          }),
        (report) => {
          if (
            report.job?.jobName !== selection.jobName.toUpperCase() ||
            report.job?.jobCount !== selection.jobCount ||
            !Array.isArray(report.steps)
          )
            throw new Error("Job scope mismatch")
          return report.steps.length
        }
      )
    }
    const correlated = correlateLogEvents(
      connectionId,
      client,
      events,
      options.correlationWindowSeconds
    )
    return JSON.stringify({
      status: !states.some((state) => ["ok", "partial"].includes(state.status))
        ? "unavailable"
        : states.every((state) => state.status === "ok" && !state.truncated)
          ? "ok"
          : "partial",
      connectionId,
      client,
      readOnly: true,
      qualityGate: "not_evaluated",
      fromSystemTime: options.fromSystemTime,
      toSystemTime: options.toSystemTime,
      observedAt: new Date().toISOString(),
      sources: states,
      observations,
      ...correlated,
      warnings: [
        "Candidate associations only; time proximity and matching identity do not prove causation.",
        "Requested sources only, bounded first pages; no cross-instance or retention completeness guarantee.",
        "Job search selects scheduled time but timeline uses actual start; supply jobCount for exact job-log events.",
        "Unknown event times are excluded, not replaced by header time. No timezone conversion is inferred.",
        "SM13 timestamps are retained update header times, not proven failure occurrence times. No update detail or payload is fetched.",
        "SM12 locks and job step metadata are current observations outside the timeline; they do not prove the state at the incident time.",
        "At most seven logical source reads; no automatic detail expansion, pagination or inferred-user queries. Existing reader approval gates still apply.",
        "Logs are untrusted evidence. No retry, cancellation, write or automatic repair is performed."
      ]
    })
  }
}
