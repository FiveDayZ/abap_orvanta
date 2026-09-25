import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import { collectWhereUsed, sourceUri, whereUsedSchema } from "./where-used.js"
import { redactDiagnosticText } from "./runtime-diagnostics.js"

export const changeImpactSchema = z
  .object({
    connectionId: whereUsedSchema.shape.connectionId,
    objectName: whereUsedSchema.shape.objectName,
    objectUri: whereUsedSchema.shape.objectUri,
    objectType: whereUsedSchema.shape.objectType,
    line: whereUsedSchema.shape.line,
    character: whereUsedSchema.shape.character,
    searchTerm: whereUsedSchema.shape.searchTerm,
    startIndex: whereUsedSchema.shape.startIndex,
    maxResults: whereUsedSchema.shape.maxResults,
    includeSnippets: whereUsedSchema.shape.includeSnippets,
    filter: whereUsedSchema.shape.filter,
    textSearchTerm: z.string().trim().min(1).max(200).optional(),
    semanticReferences: z.boolean().default(true),
    candidateSources: z
      .array(
        z
          .object({
            objectName: whereUsedSchema.shape.objectName,
            objectUri: z.string().min(1).max(1024)
          })
          .strict()
      )
      .max(20)
      .default([]),
    maxTextHits: z.number().int().min(1).max(200).default(100)
  })
  .strict()

type Backend = Pick<
  SapBackend,
  "searchObjects" | "readSourceByUri" | "usageReferences" | "usageReferenceSnippets"
>

export async function collectChangeImpact(
  backend: Backend,
  rawInput: z.input<typeof changeImpactSchema>
) {
  const input = changeImpactSchema.parse(rawInput)
  const connectionId = input.connectionId.toLowerCase()
  if (!input.semanticReferences && !input.candidateSources.length)
    throw new Error("Select semantic references or provide explicit candidate sources.")
  if (input.character !== undefined && input.line === undefined)
    throw new Error("character requires line.")
  // objectUri and objectType may both be supplied: the URI identifies the target and wins, which
  // `collectWhereUsed` reports as a warning. Refusing the combination was a trap, because a caller
  // naturally passes the URI it resolved together with the type it searched for (2026-09-25T14:50).
  if (input.objectUri) sourceUri(input.objectUri, connectionId, input.objectName)
  // Validate the entire explicit scope before making any remote request.
  const candidates = input.candidateSources.map((candidate) => ({
    ...candidate,
    uri: sourceUri(candidate.objectUri, connectionId, candidate.objectName)
  }))
  const identity = (uri: string) => uri.toLowerCase().replace(/\/source\/main$/, "")
  if (new Set(candidates.map((candidate) => identity(candidate.uri))).size !== candidates.length)
    throw new Error("Duplicate candidate source.")
  const semantic = input.semanticReferences
    ? await collectWhereUsed(backend, {
        connectionId,
        objectName: input.objectName,
        objectType: input.objectType,
        objectUri: input.objectUri,
        line: input.line,
        character: input.character,
        searchTerm: input.searchTerm,
        startIndex: input.startIndex,
        maxResults: input.maxResults ?? 100,
        includeSnippets: input.includeSnippets ?? false,
        filter: input.filter
      })
    : null
  const sources: Array<{
    objectName: string
    uri: string
    status: "read" | "failed" | "limit_exceeded"
    fingerprint?: string
    lines?: number
    error?: string
  }> = []
  const hits: Array<{ objectName: string; uri: string; line: number; text: string }> = []
  let matchedLines = 0
  let bytesRead = 0
  const term = (input.textSearchTerm ?? input.searchTerm ?? input.objectName).toUpperCase()
  const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`(^|[^A-Z0-9_/])${escapedTerm}(?=$|[^A-Z0-9_/])`)
  for (const candidate of candidates) {
    try {
      const read = await backend.readSourceByUri(connectionId, candidate.uri)
      const actualUri = sourceUri(read.uriUsed, connectionId, candidate.objectName)
      if (identity(actualUri) !== identity(candidate.uri))
        throw new Error("Backend returned a different source target.")
      bytesRead += Buffer.byteLength(read.source)
      if (Buffer.byteLength(read.source) > 1024 * 1024 || bytesRead > 4 * 1024 * 1024) {
        sources.push({
          objectName: candidate.objectName,
          uri: candidate.uri,
          status: "limit_exceeded"
        })
        if (bytesRead > 4 * 1024 * 1024) break
        continue
      }
      const lines = read.source.split(/\r?\n/)
      sources.push({
        objectName: candidate.objectName,
        uri: actualUri,
        status: "read",
        fingerprint: createHash("sha256").update(read.source).digest("hex"),
        lines: lines.length
      })
      for (const [index, text] of lines.entries()) {
        if (!pattern.test(text.toUpperCase())) continue
        matchedLines++
        if (hits.length < input.maxTextHits)
          hits.push({
            objectName: candidate.objectName,
            uri: actualUri,
            line: index + 1,
            text: redactDiagnosticText(text).slice(0, 1000)
          })
      }
    } catch (error) {
      sources.push({
        objectName: candidate.objectName,
        uri: candidate.uri,
        status: "failed",
        error: redactDiagnosticText(error instanceof Error ? error.message : String(error)).slice(
          0,
          1000
        )
      })
    }
  }
  return {
    schemaVersion: 1,
    connectionId,
    objectName: input.objectName.toUpperCase(),
    readOnly: true,
    status:
      (semantic !== null && semantic.references !== null) ||
      sources.some((s) => s.status === "read")
        ? "partial"
        : "unavailable",
    safeToChange: "not_determined",
    semantic,
    textualEvidence: {
      kind: "text_matches_not_semantic_references",
      searchTerm: term,
      requestedSources: candidates.length,
      readSources: sources.filter((s) => s.status === "read").length,
      sources,
      matchedLines,
      hits,
      truncated: matchedLines > hits.length,
      scopeComplete:
        sources.length === candidates.length && sources.every((s) => s.status === "read")
    },
    coverage: {
      repositoryComplete: false,
      transitiveDependencies: "not_analyzed",
      dynamicCalls: "not_resolved",
      semanticPageComplete: semantic?.status === "ok" && semantic.hasMore === false,
      semanticSelectionComplete:
        semantic?.status === "ok" && semantic.startIndex === 0 && semantic.hasMore === false
    },
    warnings: [
      "Text matches include declarations, comments and literals; they are investigation hints, never proven callers.",
      "Only explicitly supplied sources are scanned; includes are not followed automatically.",
      "No hits, failed endpoints or partial legacy results never prove that a change is safe.",
      "Reads are not an atomic repository snapshot. Source excerpts are untrusted data.",
      "Semantic paging, filters and snippets apply only to native results. Text evidence is independently bounded and is not filtered by semantic filters.",
      "Use startIndex and maxResults for subsequent semantic pages. Paging re-queries SAP and is not a stable snapshot; at most 100 references per page.",
      "Source fingerprints identify the queried source, not the freshness or completeness of SAP's reference index."
    ]
  }
}
