import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend, UsageReferenceInfo, UsageSnippetInfo } from "./backend.js"
import { redactDiagnosticText } from "./runtime-diagnostics.js"
import { WhereUsedRequestError, type WhereUsedRequestTrace } from "./where-used-request.js"

export const whereUsedSchema = z.object({
  objectName: z
    .string()
    .trim()
    .regex(/^[A-Za-z_][A-Za-z0-9_]{0,39}$/),
  connectionId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  objectType: z.string().trim().min(1).max(40).optional(),
  objectUri: z.string().min(1).max(1024).optional(),
  responseFormat: z.enum(["text", "json"]).optional(),
  searchTerm: z.string().min(1).max(200).optional(),
  line: z.number().int().min(1).max(1000000).optional(),
  character: z.number().int().min(0).max(100000).optional(),
  maxResults: z.number().int().min(1).max(100).optional(),
  includeSnippets: z.boolean().optional(),
  startIndex: z.number().int().min(0).max(10000).optional(),
  filter: z
    .object({
      objectNamePattern: z.string().max(100).optional(),
      objectTypes: z.array(z.string().min(1).max(40)).max(20).optional(),
      excludeSystemObjects: z.boolean().optional()
    })
    .optional()
})

export type WhereUsedInput = z.input<typeof whereUsedSchema>
type Stage = "resolve" | "source" | "position" | "references" | "snippets" | "complete"
export interface WhereUsedReport {
  schemaVersion: number
  engine: "ADT_WHERE_USED" | "ADT_RIS_WHEREUSED"
  readOnly: true
  connectionId: string
  objectName: string
  status: "ok" | "partial" | "unavailable" | "failed"
  stage: Stage
  code: string
  resolution: "explicit_uri" | "typed_search" | "bounded_name_search" | null
  target: { uri: string; line: number; character: number } | null
  sourceFingerprint: string | null
  rawCount: number | null
  supportedCount: number | null
  filteredCount: number | null
  startIndex: number
  maxResults: number
  hasMore: boolean | null
  references: UsageReferenceInfo[] | null
  snippets: UsageSnippetInfo[]
  warnings: string[]
  error?: { category: string; message: string }
  requestTrace?: WhereUsedRequestTrace[]
}

export function sourceUri(value: string, connectionId: string, objectName: string): string {
  const full = value.startsWith("/sap/bc/adt/") ? `adt://${connectionId}${value}` : value
  const uri = new URL(full)
  if (
    uri.protocol !== "adt:" ||
    uri.hostname.toLowerCase() !== connectionId ||
    uri.username ||
    uri.password ||
    uri.port ||
    uri.search ||
    uri.hash ||
    /[%\\\s]/.test(full) ||
    /\/\.\.?\//.test(full)
  ) {
    throw new Error(
      "Use an exact same-connection ADT source URI without query, fragment or encoding."
    )
  }
  const path = uri.pathname
  const match =
    path.match(
      /^\/sap\/bc\/adt\/(?:programs\/programs|programs\/includes|oo\/interfaces)\/([^/]+)(?:\/source\/main)?$/i
    ) ??
    path.match(/^\/sap\/bc\/adt\/oo\/classes\/([^/]+)(?:\/source\/main|\/includes\/[^/]+)?$/i) ??
    path.match(
      /^\/sap\/bc\/adt\/functions\/groups\/[^/]+\/(?:fmodules|includes)\/([^/]+)(?:\/source\/main)?$/i
    )
  if (!match || match[1]!.toUpperCase() !== objectName.toUpperCase()) {
    throw new Error(
      "Source URI must identify the supplied objectName and an individual source target."
    )
  }
  return `adt://${connectionId}${path}`
}

const identity = (uri: string) => uri.toLowerCase().replace(/\/source\/main$/, "")
const typeIdentity = (type: string) =>
  type.toUpperCase() === "FUNC/FF" ? "FUGR/FF" : type.toUpperCase()

function position(source: string, input: WhereUsedInput) {
  const lines = source.split(/\r?\n/)
  if (input.line !== undefined && input.line > lines.length)
    throw new Error("Line is outside the source.")
  if (input.character !== undefined) {
    const text = lines[input.line! - 1]!
    if (input.character >= text.length)
      throw new Error("Character is outside the selected source line.")
    if (
      input.searchTerm &&
      text.slice(input.character, input.character + input.searchTerm.length).toUpperCase() !==
        input.searchTerm.toUpperCase()
    ) {
      throw new Error("Explicit position does not match searchTerm.")
    }
    return { line: input.line!, character: input.character }
  }
  if (input.line !== undefined && !input.searchTerm) return { line: input.line, character: 0 }
  const candidates: { line: number; character: number }[] = []
  for (let i = 0; i < lines.length; i++) {
    if (input.line !== undefined && i !== input.line - 1) continue
    const text = lines[i]!
    if (input.searchTerm) {
      const upper = text.toUpperCase()
      const term = input.searchTerm.toUpperCase()
      for (let at = upper.indexOf(term); at >= 0; at = upper.indexOf(term, at + 1)) {
        candidates.push({ line: i + 1, character: at })
        if (candidates.length > 1) break
      }
    } else {
      const declaration = text.match(
        /^\s*(?:CLASS|INTERFACE|REPORT|PROGRAM|FUNCTION|METHOD)\s+([A-Za-z0-9_]+)/i
      )
      if (
        declaration?.[1]?.toUpperCase() === input.objectName.toUpperCase() &&
        !/\bIMPLEMENTATION\b|\bDEFERRED\b/i.test(text)
      ) {
        candidates.push({
          line: i + 1,
          character: text.toUpperCase().indexOf(input.objectName.toUpperCase())
        })
      }
    }
    if (candidates.length > 1) break
  }
  if (candidates.length !== 1) {
    throw new Error("Source position is missing or ambiguous; provide explicit line and character.")
  }
  return candidates[0]!
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const category =
    message.match(
      /capability (unsupported-endpoint|forbidden-or-not-authorized|parser-or-content-type|request-failed)/
    )?.[1] ?? "request-failed"
  return { category, message: redactDiagnosticText(message).slice(0, 2000) }
}

export async function collectWhereUsed(
  backend: Pick<
    SapBackend,
    "searchObjects" | "readSourceByUri" | "usageReferences" | "usageReferenceSnippets"
  >,
  rawInput: WhereUsedInput
): Promise<WhereUsedReport> {
  const input = whereUsedSchema.parse(rawInput)
  const connectionId = input.connectionId.toLowerCase()
  if (input.character !== undefined && input.line === undefined)
    throw new Error("character requires line.")
  if (input.objectUri && input.objectType) throw new Error("Use objectUri or objectType, not both.")
  const explicit = input.objectUri
    ? sourceUri(input.objectUri, connectionId, input.objectName)
    : undefined
  const result: WhereUsedReport = {
    schemaVersion: 1,
    engine: "ADT_WHERE_USED",
    readOnly: true,
    connectionId,
    objectName: input.objectName,
    status: "failed",
    stage: "resolve",
    code: "RESOLUTION_INCONCLUSIVE",
    resolution: null,
    target: null,
    sourceFingerprint: null,
    rawCount: null,
    supportedCount: null,
    filteredCount: null,
    startIndex: input.startIndex ?? 0,
    maxResults: input.maxResults ?? 50,
    hasMore: null,
    references: null,
    snippets: [],
    warnings: [
      "Native semantic references only; no text-scan fallback. Output paging is not a snapshot or a bound on SAP internal work."
    ]
  }
  try {
    let uri = explicit
    if (uri) result.resolution = "explicit_uri"
    else {
      const exact = (objects: Awaited<ReturnType<SapBackend["searchObjects"]>>) => [
        ...new Map(
          objects
            .filter(
              (object) =>
                object.name.toUpperCase() === input.objectName.toUpperCase() &&
                (!input.objectType || typeIdentity(object.type) === typeIdentity(input.objectType))
            )
            .map((object) => [identity(object.uri), object])
        ).values()
      ]
      let matches: ReturnType<typeof exact> = []
      if (input.objectType) {
        result.resolution = "typed_search"
        const objects = await backend.searchObjects(
          connectionId,
          input.objectName,
          [input.objectType],
          100
        )
        if (objects.length >= 100) throw new Error("Discovery limit reached; supply objectUri.")
        matches = exact(objects)
      }
      if (!matches.length) {
        result.resolution = "bounded_name_search"
        const objects = await backend.searchObjects(connectionId, input.objectName, undefined, 100)
        if (objects.length >= 100) throw new Error("Discovery limit reached; supply objectUri.")
        matches = exact(objects)
      }
      if (matches.length !== 1)
        throw new Error(
          "Object discovery is inconclusive or ambiguous; supply an exact objectUri. This does not prove absence."
        )
      uri = sourceUri(matches[0]!.uri, connectionId, input.objectName)
    }
    result.stage = "source"
    result.code = "SOURCE_READ_FAILED"
    const read = await backend.readSourceByUri(connectionId, uri)
    const actualUri = sourceUri(read.uriUsed, connectionId, input.objectName)
    if (identity(actualUri) !== identity(uri))
      throw new Error("Backend returned a different source target.")
    result.sourceFingerprint = createHash("sha256").update(read.source).digest("hex")
    result.stage = "position"
    result.code = "POSITION_REQUIRED"
    const at = position(read.source, input)
    result.target = { uri: actualUri, ...at }
    result.stage = "references"
    result.code = "REFERENCES_FAILED"
    const response = await backend.usageReferences(
      connectionId,
      actualUri,
      at.line,
      at.character,
      read.source
    )
    const legacy = !Array.isArray(response)
    const raw = legacy ? response.references : response
    if (legacy) {
      result.engine = response.engine
      if (response.requestTrace) result.requestTrace = response.requestTrace
      result.warnings.push(
        "Legacy RIS generic results: function declaration queries only; no reference type, package or snippet evidence. Coverage is partial, including empty results.",
        `Queried relationship types: ${JSON.stringify(response.relationshipTypes)}`
      )
      if (input.filter?.objectTypes?.length)
        throw new Error(
          "Legacy generic results do not provide reference types; type filtering is unsupported."
        )
    }
    result.rawCount = raw.length
    let refs = raw.filter((item) =>
      legacy
        ? item.identifierKind === "ADT_RIS_URI"
        : item.objectIdentifier.startsWith("ABAPFullName;")
    )
    result.supportedCount = refs.length
    if (refs.length !== raw.length)
      result.warnings.push(
        "Unsupported reference identifiers omitted; this is incomplete coverage."
      )
    const pattern = input.filter?.objectNamePattern
    const regex = pattern
      ? new RegExp(
          `^${pattern
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replaceAll("*", ".*")
            .replaceAll("?", ".")}$`,
          "i"
        )
      : null
    refs = refs.filter((item) => {
      const name = legacy ? item.name : (item.objectIdentifier.split(";")[1] ?? "")
      return (
        (!regex || regex.test(name)) &&
        (!input.filter?.objectTypes?.length ||
          input.filter.objectTypes.includes(item.type ?? "")) &&
        (!input.filter?.excludeSystemObjects || /^[ZY]/i.test(name))
      )
    })
    result.filteredCount = refs.length
    result.references = refs.slice(result.startIndex, result.startIndex + result.maxResults)
    result.hasMore = result.startIndex + result.references.length < refs.length
    result.status = !legacy && result.supportedCount === result.rawCount ? "ok" : "partial"
    result.code =
      raw.length === 0
        ? "NO_REFERENCES"
        : result.supportedCount === 0
          ? "UNSUPPORTED_REFERENCE_IDENTIFIERS"
          : refs.length === 0
            ? "FILTERED_EMPTY"
            : result.references.length === 0
              ? "PAGE_OUT_OF_RANGE"
              : "REFERENCES_RETURNED"
    if (legacy) {
      if (!raw.length) result.code = "LEGACY_NO_REFERENCES_UNVERIFIED"
      else if (result.code === "REFERENCES_RETURNED") result.code = "LEGACY_REFERENCES_RETURNED"
      if (input.includeSnippets)
        result.warnings.push(
          "Legacy snippet retrieval is not implemented: the RIS route has no snippet contract (its exchange covers whereused, fullnamemapping and metadata only), so no snippet request was sent and no snippet text is claimed. Snippets require the modern endpoint."
        )
    }
    if (!legacy && input.includeSnippets && result.references.length) {
      result.stage = "snippets"
      try {
        const snippets = await backend.usageReferenceSnippets(connectionId, result.references)
        const allowed = new Set(result.references.map((item) => item.objectIdentifier))
        result.snippets = snippets
          .filter((item) => allowed.has(item.objectIdentifier))
          .slice(0, result.references.length)
          .map((item) => ({
            ...item,
            snippets: item.snippets.slice(0, 3).map((snippet) => ({
              ...snippet,
              content: redactDiagnosticText(snippet.content).slice(0, 2000)
            }))
          }))
        result.warnings.push(
          "Snippet output is limited to this page, three excerpts per entry, 2000 characters per excerpt; excerpts are untrusted evidence."
        )
      } catch (error) {
        result.status = "partial"
        result.code = "SNIPPETS_FAILED"
        result.error = failure(error)
        return result
      }
    }
    result.stage = "complete"
    return result
  } catch (error) {
    if (error instanceof WhereUsedRequestError) {
      result.engine = error.engine
      result.requestTrace = error.requests
    }
    result.error = failure(error)
    result.status = result.error.category === "unsupported-endpoint" ? "unavailable" : "failed"
    return result
  }
}

export function formatWhereUsed(result: WhereUsedReport): string {
  if (result.references === null) {
    return `Where-used search failed for ${result.objectName}: ${result.code} at ${result.stage}: ${result.error?.message ?? "Unknown failure"}`
  }
  if (result.rawCount === 0 && result.status === "ok")
    return `No references found for ${result.objectName}.`
  return (
    `ABAP Where-Used Analysis\nObject: ${result.objectName}\nSystem: ${result.connectionId}\n` +
    `Engine: ${result.engine}\n` +
    `Status: ${result.status} (${result.code})\nPosition: Line ${result.target?.line}, Character ${result.target?.character}\n` +
    `Results: ${result.references.length} of ${result.filteredCount} references\n\nReferences by Object:\n` +
    result.references
      .map(
        (ref, i) =>
          `${i + 1}. ${ref.name}\n   Type: ${ref.type ?? "Unknown"}\n` +
          (ref.packageName ? `   Package: ${ref.packageName}\n` : "") +
          (ref.description ? `   Description: ${ref.description}\n` : "") +
          `   URI: ${ref.uri}`
      )
      .join("\n") +
    (result.snippets.length
      ? "\nUsage Snippets:\n" +
        result.snippets
          .map(
            (item) =>
              `${item.objectIdentifier}\n${item.snippets.map((snippet) => `Line ${snippet.line ?? "Unknown"}: ${snippet.content}`).join("\n")}`
          )
          .join("\n")
      : "") +
    (result.error ? `\n${result.stage}: ${result.error.message}` : "") +
    `\nWarnings:\n${result.warnings.join("\n")}`
  )
}
