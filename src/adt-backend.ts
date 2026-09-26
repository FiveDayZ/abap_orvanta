import {
  ADTClient,
  CreatableTypes,
  createSSLConfig,
  fromError,
  isClassStructure,
  isHttpError,
  objectPath,
  session_types,
  type AbapObjectStructure,
  type AdtLock,
  type CreatableTypeIds,
  type LogData,
  type NewObjectOptions,
  type NodeParents,
  type TransportRequest,
  type TransportTarget,
  type TransportsOfUser
} from "abap-adt-api"
import { createHash } from "node:crypto"
import { appendFileSync, renameSync, statSync } from "node:fs"
import { CUSTOMER_CLIENT, CUSTOMER_CONNECTION_ID } from "./customer-scope.js"
import { assertHelperOperationDeliverable } from "./helper-operation-limits.js"
import { InactiveInventoryError, readInactiveInventory } from "./inactive-inventory.js"
import { assertTableAllowed } from "./table-allowlist.js"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import type { AdtHTTP } from "abap-adt-api/build/AdtHTTP.js"
import type { RequestOptions } from "abap-adt-api/build/AdtHTTP.js"
import { createObject as createObjectRequest } from "abap-adt-api/build/api/objectcreator.js"
import { objectStructure as loadObjectStructure } from "abap-adt-api/build/api/objectstructure.js"
import { adtDiscovery } from "abap-adt-api/build/api/discovery.js"
import { objectEnhancements as requestObjectEnhancements } from "abap-adt-api/build/api/enhancements.js"
import { getObjectSource as requestObjectSource } from "abap-adt-api/build/api/objectcontents.js"
import {
  syntaxCheck as requestSyntaxCheck,
  usageReferences as requestUsageReferences
} from "abap-adt-api/build/api/syntax.js"
import { parse } from "abap-adt-api/build/utilities.js"
import { legacyWhereUsed, legacyWhereUsedPaths } from "./legacy-where-used.js"
import { whereUsedHttp, WhereUsedRequestError } from "./where-used-request.js"
import type { LegacyUsageReferences, TransportTableReader } from "./backend.js"
import {
  DEFAULT_OBJECT_TYPES,
  type ActivationInfo,
  type AbapObjectInfo,
  type AtcResultInfo,
  type ConnectionDetails,
  type CreateObjectRequest,
  type DebugBreakpointCommand,
  type DiagnosticInfo,
  type DiscoverySnapshotInfo,
  type DumpListInfo,
  type EnhancementInfo,
  type MessageClassCreationInfo,
  type MessageClassDeletionInfo,
  type MessageClassInfo,
  type MessageClassMutationInfo,
  type ObjectTypeSearchResult,
  type RevisionInfo,
  type RemoteFunctionRequest,
  type RemoteFunctionResult,
  type RemoteFunctionParameterShape,
  type SapHelperRequest,
  type SapHelperResult,
  type SapHelperCapabilities,
  type SapDdicRequest,
  type SapDdicResult,
  type SapRepositoryRequest,
  type SapRepositoryResult,
  type SapStructureRow,
  type SapBackend,
  type TransportCleanupEntry,
  type ExportResourceInfo,
  type ObjectCreationInfo,
  type SourceReadOptions,
  type SourceResult,
  type SourceMutationInfo,
  type SourceInspectionInfo,
  type TestIncludeCreationInfo,
  type TextElementInfo,
  type TextElementMutationInfo,
  type TextElementObjectType,
  type TextElementsInfo,
  type TraceConfigurationInfo,
  type TraceEntryInfo,
  type TraceRunInfo,
  type UnitTestAlertInfo,
  type UnitTestClassInfo,
  type UsageReferenceInfo,
  type UsageSnippetInfo,
  type UserTransportsListing
} from "./backend.js"
import type { ConnectionConfig } from "./config.js"
import { AtcStageError, executeNativeAtc, inspectNativeAtc } from "./native-atc.js"
import {
  HeadlessDebugManager,
  type DebugBreakpointInfo,
  type DebugSessionInfo,
  type DebugSessionRequest,
  type DebugStackFrameInfo,
  type DebugStepInfo,
  type DebugStepRequest,
  type DebugVariableInfo,
  type DebugVariableRequest
} from "./debug-manager.js"
import { findAndReplaceSource } from "./source-edit.js"
import {
  buildSmartformEnvelope,
  parseSmartformResponse,
  type SmartformRequest
} from "./smartforms.js"
import { runSapDataQuery } from "./data-query.js"
import { runScopedQueryFallback } from "./scoped-query.js"
import {
  mergeTextElementChanges,
  normalizeExistingTextElements,
  normalizeTextElements,
  textElementCategory,
  textElementIdTypeFromPoolId,
  textElementKey,
  TEXT_ELEMENT_ID_TYPES,
  type NormalizedTextElement,
  type TextElementIdType
} from "./text-elements.js"

const SOURCE_READ_TIMEOUT_MS = 30_000
const SYNTAX_CHECK_TIMEOUT_MS = 10_000
const ENHANCEMENT_READ_TIMEOUT_MS = 3_000

/**
 * E07T request-text reads for a transport listing.
 *
 * `E07T_MAX_ROWS` is the bound the CTS read path enforces; a chunk that returns exactly that many
 * rows is treated as truncated and split, because the read is ordered by TRKORR and a truncation
 * therefore drops the highest request numbers. `E07T_CHUNK_REQUESTS` is the starting chunk size: it
 * keeps the number of reads proportional to the listing rather than to the request count, while
 * leaving each bracket narrow enough that the split path is the exception.
 */
const E07T_MAX_ROWS = 500
const E07T_CHUNK_REQUESTS = 50

const XML_METADATA_TYPES = new Set([
  "MSAG/N",
  "XSLT/VT",
  "XSLT/XT",
  "STOB/ST",
  "HTTP",
  "SRVB/SVB",
  "SUSO/SO",
  "SUSO/B",
  "SUSC/SC",
  "AUTH",
  "SUSH",
  "DTEL/DE",
  "SIA6",
  "TTYP/DA",
  "TTYP/TT",
  "DOMA/DD",
  "DOMA/DO",
  "VIEW/DV",
  "VIEW/V",
  "SHLP/DH",
  "ENQU/DL",
  "PINF/PI",
  "NROB/NR"
])

const LEGACY_CLASS_CONTENT_TYPES = [
  "application/vnd.sap.adt.oo.classes.v4+xml",
  "application/vnd.sap.adt.oo.classes.v3+xml",
  "application/vnd.sap.adt.oo.classes.v2+xml",
  "application/vnd.sap.adt.oo.classes.v1+xml",
  "application/vnd.sap.adt.oo.classes+xml"
]

const LEGACY_CREATE_CONTENT_TYPES: Readonly<Partial<Record<CreatableTypeIds, readonly string[]>>> =
  {
    "CLAS/OC": [
      "application/vnd.sap.adt.oo.classes+xml; charset=utf-8",
      "application/vnd.sap.adt.oo.classes.v1+xml; charset=utf-8",
      "application/vnd.sap.adt.oo.classes.v2+xml; charset=utf-8",
      "application/vnd.sap.adt.oo.classes.v3+xml; charset=utf-8",
      "application/vnd.sap.adt.oo.classes.v4+xml; charset=utf-8"
    ],
    "INTF/OI": ["application/vnd.sap.adt.oo.interfaces+xml; charset=utf-8"],
    "PROG/P": [
      "application/vnd.sap.adt.programs.programs.v2+xml; charset=utf-8",
      "application/vnd.sap.adt.programs.programs+xml; charset=utf-8"
    ],
    "PROG/I": ["application/vnd.sap.adt.programs.includes+xml; charset=utf-8"],
    "FUGR/F": [
      "application/vnd.sap.adt.functions.groups.v3+xml; charset=utf-8",
      "application/vnd.sap.adt.functions.groups.v2+xml; charset=utf-8",
      "application/vnd.sap.adt.functions.groups.v1+xml; charset=utf-8",
      "application/vnd.sap.adt.functions.groups+xml; charset=utf-8"
    ],
    "FUGR/FF": ["application/vnd.sap.adt.functions.fmodules+xml; charset=utf-8"],
    "FUGR/I": [
      "application/vnd.sap.adt.functions.fincludes.v2+xml; charset=utf-8",
      "application/vnd.sap.adt.functions.fincludes+xml; charset=utf-8"
    ],
    "DDLS/DF": ["application/vnd.sap.adt.ddic.ddlsources+xml; charset=utf-8"],
    "DCLS/DL": ["application/vnd.sap.adt.acm.dclsources+xml; charset=utf-8"]
  }

interface ClientState {
  client: ADTClient
  login: Promise<void>
}

type AdtConnectionInput = Omit<ConnectionConfig, "remoteFunctionAllowlist"> & {
  remoteFunctionAllowlist?: string[] | undefined
}

/**
 * Number of requests a transport-organizer listing actually carries.
 *
 * Used only to decide whether the primary read produced anything: a listing with no request in any
 * target is indistinguishable from a document the parser could not read, and that ambiguity is what
 * hid the empty answer.
 */
function countTransportRequests(listing: TransportsOfUser): number {
  return [...listing.workbench, ...listing.customizing].reduce(
    (total, target) => total + target.modifiable.length + target.released.length,
    0
  )
}

export class AdtBackend implements SapBackend {
  private readonly configs = new Map<string, ConnectionConfig>()
  private readonly clients = new Map<string, ClientState>()
  private readonly debugger: HeadlessDebugManager

  constructor(
    connections: AdtConnectionInput[],
    private readonly passwordFor: (config: ConnectionConfig) => string | undefined = (config) =>
      process.env[config.passwordEnv]
  ) {
    for (const connection of connections) {
      this.configs.set(connection.id.toLowerCase(), {
        ...connection,
        remoteFunctionAllowlist: [...(connection.remoteFunctionAllowlist ?? [])]
      })
    }
    this.debugger = new HeadlessDebugManager({
      listenerClient: async (connectionId) => (await this.getClient(connectionId)).statelessClone,
      attachedClient: (connectionId) => this.createDebugClient(connectionId),
      username: (connectionId) => this.connectionDetails(connectionId).username
    })
  }

  connectionIds(): string[] {
    return [...this.configs.keys()]
  }

  connectionDetails(connectionId: string): ConnectionDetails {
    const config = this.configs.get(connectionId.toLowerCase())
    if (!config) throw new Error(`Connection not found: ${connectionId}`)
    return {
      url: config.url,
      client: config.client,
      language: config.language,
      username: config.username,
      remoteFunctionAllowlist: [...config.remoteFunctionAllowlist]
    }
  }

  async callSapHelper(connectionId: string, request: SapHelperRequest): Promise<SapHelperResult> {
    assertHelperOperationDeliverable("Z_ORVANTA_MCP_EXECUTE", request.operation)
    const config = this.configs.get(connectionId.toLowerCase())
    if (!config) throw new Error(`Connection not found: ${connectionId}`)
    const body = await postSapSoap(
      config,
      "http://www.sap.com/Z_ORVANTA_MCP_EXECUTE",
      buildSapHelperEnvelope(request),
      false,
      this.passwordFor(config)
    )
    return parseSapHelperResponse(body)
  }

  async callSmartform(connectionId: string, request: SmartformRequest) {
    const config = this.configs.get(connectionId.toLowerCase())
    if (!config) throw new Error(`Connection not found: ${connectionId}`)
    const body = await postSapSoap(
      config,
      "http://www.sap.com/Z_ORVANTA_SMARTFORM_API",
      buildSmartformEnvelope(request),
      false,
      this.passwordFor(config)
    )
    return parseSmartformResponse(body)
  }

  async callSapRepository(
    connectionId: string,
    request: SapRepositoryRequest
  ): Promise<SapRepositoryResult> {
    assertHelperOperationDeliverable("Z_ORVANTA_MCP_DYNPRO_API", request.operation)
    const config = this.configs.get(connectionId.toLowerCase())
    if (!config) throw new Error(`Connection not found: ${connectionId}`)
    const body = await postSapSoap(
      config,
      "http://www.sap.com/Z_ORVANTA_MCP_DYNPRO_API",
      buildSapRepositoryEnvelope(request),
      false,
      this.passwordFor(config)
    )
    return parseSapRepositoryResponse(body)
  }

  async callSapDdic(connectionId: string, request: SapDdicRequest): Promise<SapDdicResult> {
    assertHelperOperationDeliverable("Z_ORVANTA_MCP_DDIC_API", request.operation)
    const config = this.configs.get(connectionId.toLowerCase())
    if (!config) throw new Error(`Connection not found: ${connectionId}`)
    const body = await postSapSoap(
      config,
      "http://www.sap.com/Z_ORVANTA_MCP_DDIC_API",
      buildSapDdicEnvelope(request),
      false,
      this.passwordFor(config)
    )
    return parseSapDdicResponse(body)
  }

  /**
   * Probe one installed SAP helper for its `CAPABILITIES` self-description.
   *
   * Design note: the frozen protocol adds **no** `iv_expected_version` import parameter and
   * no `CHECK|EXPECTED` payload line (design revision R1). That parameter name already means
   * the caller's expected *object* version for optimistic concurrency in
   * `Z_ORVANTA_MCP_DDIC_API` and `Z_ORVANTA_MCP_DYNPRO_API`, so the minimum protocol required
   * by a capability is compared locally by the service.
   *
   * This method never throws: a helper that is unreachable is `absent`, and a helper that
   * answers without a usable self-description is `operation-scoped`. An un-upgraded helper
   * rejects the unknown opcode with status `E` / code `OPERATION_NOT_SUPPORTED` (verified in
   * `scripts/bootstrap-sap-helper.ps1`), which must degrade a capability report instead of
   * failing it.
   *
   * Two reply contracts are supported: the XML `EV_STATUS`/`EV_CODE`/`IT_SOURCE` helpers and the
   * `EV_RESULT` JSON helpers that carry the rows as `payload` (see
   * `HELPER_CAPABILITIES_CHANNELS`).
   */
  async probeHelperCapabilities(
    connectionId: string,
    helper: string
  ): Promise<SapHelperCapabilities> {
    const probed = helper.trim().toUpperCase()
    const observedAt = new Date().toISOString()
    const config = this.configs.get(connectionId.toLowerCase())
    if (!config) {
      return emptyHelperCapabilities(probed, observedAt, "absent", "Connection not found")
    }
    const channel = HELPER_CAPABILITIES_CHANNELS[probed]
    if (!channel) {
      return emptyHelperCapabilities(
        probed,
        observedAt,
        "absent",
        "No CAPABILITIES channel is defined for this helper"
      )
    }
    try {
      if (channel.reply === "json-envelope") {
        const response = await this.callRemoteFunction(connectionId, {
          functionName: probed,
          inputParameters: { IV_ACTION: "CAPABILITIES" },
          outputParameters: [{ name: "EV_RESULT", kind: "scalar" }]
        })
        traceHelperProbe(probed, "json-envelope", "", JSON.stringify(response))
        return jsonHelperCapabilitiesAttestation(response, probed, observedAt)
      }
      const body = await postSapSoap(
        config,
        channel.soapAction,
        channel.envelope(),
        false,
        this.passwordFor(config)
      )
      // Capture the reply before any verdict is derived from it. The identity check below reports "omitted
      // the HELPER identity line" both for a helper that stayed silent and for a reply this client could not
      // read, so only the raw body separates those cases. Enabled only by ABAP_MCP_HELPER_TRACE.
      traceHelperProbe(probed, "xml-rows", channel.soapAction, body)
      const response = parseHelperCapabilitiesResponse(body)
      if (response.status !== "S" || response.code.toUpperCase() !== "CAPABILITIES") {
        return emptyHelperCapabilities(probed, observedAt, "operation-scoped")
      }
      const payload = parseHelperCapabilitiesPayload(response.payload)
      const declared = payload.helper?.trim().toUpperCase()
      if (declared !== probed) {
        // A helper that answers under a different identity - or without any identity - must not
        // be evidence for this helper's capabilities. Keep the conservative fallback.
        return emptyHelperCapabilities(
          probed,
          observedAt,
          "operation-scoped",
          declared
            ? `Self-description declared helper ${declared} instead of ${probed}; ignored`
            : "Self-description omitted the HELPER identity line; ignored"
        )
      }
      return {
        helper: probed,
        minProtocol: payload.minProtocol,
        maxProtocol: payload.maxProtocol,
        operations: payload.operations,
        scopes: payload.scopes,
        sourceHash: payload.sourceHash,
        packageName: payload.packageName,
        transport: payload.transport,
        host: payload.host,
        observedAt,
        attestation: "self-described"
      }
    } catch (error) {
      return emptyHelperCapabilities(probed, observedAt, "absent", scrubHelperDetail(error))
    }
  }

  async callRemoteFunction(
    connectionId: string,
    request: RemoteFunctionRequest
  ): Promise<RemoteFunctionResult> {
    const config = this.configs.get(connectionId.toLowerCase())
    if (!config) throw new Error(`Connection not found: ${connectionId}`)
    const body = await postSapSoap(
      config,
      `http://www.sap.com/${request.functionName}`,
      buildRemoteFunctionEnvelope(request),
      true,
      this.passwordFor(config)
    )
    return parseRemoteFunctionResponse(
      body,
      request.outputParameters,
      ["RFC_READ_TABLE", "BBP_RFC_READ_TABLE"].includes(request.functionName)
    )
  }

  async searchObjects(
    connectionId: string,
    pattern: string,
    types: string[] | undefined,
    maxResults: number
  ): Promise<AbapObjectInfo[]> {
    const client = await this.getClient(connectionId)
    const results: AbapObjectInfo[] = []
    const searchTypes = types?.length ? types : [...DEFAULT_OBJECT_TYPES]

    for (const type of searchTypes) {
      try {
        const matches = await searchObjectsForType(client, pattern, type)
        for (const object of matches) {
          results.push(object)
          if (results.length >= maxResults) return results
        }
      } catch {
        // Current ABAP FS behavior skips object types unsupported by the target system.
      }
    }
    return results
  }

  async searchObjectTypes(
    connectionId: string,
    pattern: string,
    types: string[],
    maxResultsPerType: number
  ): Promise<ObjectTypeSearchResult[]> {
    const client = await this.getClient(connectionId)
    const results: ObjectTypeSearchResult[] = []
    for (const type of types) {
      try {
        const objects = (await searchObjectsForType(client, pattern, type)).slice(
          0,
          maxResultsPerType
        )
        results.push({ requestedType: type, status: "available", objects })
      } catch (error) {
        results.push({ requestedType: type, ...classifyObjectSearchFailure(error), objects: [] })
      }
    }
    return results
  }

  async readSource(
    connectionId: string,
    object: AbapObjectInfo,
    options?: SourceReadOptions
  ): Promise<SourceResult> {
    const client = await this.getClient(connectionId)
    const dictionary = await readDictionaryObject(client, object)
    if (dictionary) return dictionary

    const candidates: string[] = []
    const optimal = optimalSourceUri(object.type, object.uri)
    candidates.push(optimal)
    if (optimal !== object.uri) candidates.push(object.uri)

    let lastError: unknown
    for (const uri of candidates) {
      try {
        return {
          source: await readObjectSource(client, uri, options),
          uriUsed: uri
        }
      } catch (error) {
        if (error instanceof AdtRequestTimeoutError) throw error
        lastError = error
      }
    }

    try {
      const path = await client.findObjectPath(object.uri)
      const resolved = path.at(-1)?.["adtcore:uri"]
      if (resolved) {
        const uri = optimalSourceUri(object.type, resolved)
        return {
          source: await readObjectSource(client, uri, options),
          uriUsed: uri
        }
      }
    } catch (error) {
      if (error instanceof AdtRequestTimeoutError) throw error
      lastError = error
    }

    const fallback = await readDictionaryFallback(client, object)
    if (fallback) return fallback

    throw new Error(`Could not get source content: ${String(lastError)}`)
  }

  async readSourceByUri(connectionId: string, uri: string): Promise<SourceResult> {
    const client = await this.getClient(connectionId)
    const objectUri = normalizeAdtUri(uri, connectionId)
    const detectedType = detectTypeFromUri(objectUri)
    const candidates = [optimalSourceUri(detectedType, objectUri), objectUri].filter(
      (candidate, index, all) => all.indexOf(candidate) === index
    )
    let lastError: unknown

    for (const candidate of candidates) {
      try {
        return { source: await readObjectSource(client, candidate), uriUsed: candidate }
      } catch (error) {
        if (error instanceof AdtRequestTimeoutError) throw error
        lastError = error
      }
    }

    try {
      const path = await client.findObjectPath(objectUri)
      const resolved = path.at(-1)?.["adtcore:uri"]
      if (resolved) {
        const candidate = optimalSourceUri(detectedType, resolved)
        return { source: await readObjectSource(client, candidate), uriUsed: candidate }
      }
    } catch (error) {
      if (error instanceof AdtRequestTimeoutError) throw error
      lastError = error
    }

    throw new Error(`Could not get source content: ${String(lastError)}`)
  }

  async readEnhancements(
    connectionId: string,
    objectUri: string,
    includeSource = false
  ): Promise<EnhancementInfo[]> {
    const client = await this.getClient(connectionId)
    const sourceUri = objectUri.includes("/source/main")
      ? objectUri
      : `${objectUri.replace(/\/$/, "")}/source/main`
    try {
      const result = client.httpClient
        ? await withAdtStageTimeout(
            "ENHANCEMENT_READ_TIMEOUT",
            "enhancement metadata read",
            sourceUri,
            ENHANCEMENT_READ_TIMEOUT_MS,
            () =>
              requestObjectEnhancements(
                boundedAdtHttp(client.httpClient, ENHANCEMENT_READ_TIMEOUT_MS),
                sourceUri,
                undefined,
                includeSource
              )
          )
        : await client.objectEnhancements(sourceUri, undefined, includeSource)
      return result.implementations.flatMap((implementation) =>
        implementation.elements.map((element) => ({
          name: implementation.name,
          type: implementation.type,
          version: implementation.version,
          elementId: element.id,
          fullname: element.fullname,
          mode: element.mode,
          replacing: element.replacing,
          ...(element.position
            ? {
                startLine: element.position.startLine,
                startColumn: element.position.startColumn,
                positionUri: element.position.uri
              }
            : {}),
          ...(element.uri ? { uri: element.uri } : {}),
          ...(element.source === undefined ? {} : { source: element.source }),
          ...(implementation.enhancedObject
            ? { enhancedObject: implementation.enhancedObject }
            : {})
        }))
      )
    } catch (error) {
      throw capabilityFailure("enhancement metadata read", error)
    }
  }

  async usageReferences(
    connectionId: string,
    uri: string,
    line: number,
    character: number,
    source?: string
  ): Promise<UsageReferenceInfo[] | LegacyUsageReferences> {
    const client = await this.getClient(connectionId)
    const traced = whereUsedHttp(client.statelessClone.httpClient)
    let engine: "ADT_WHERE_USED" | "ADT_RIS_WHEREUSED" = "ADT_WHERE_USED"
    let references
    try {
      const target = normalizeAdtUri(uri, connectionId)
      const paths = new Set(
        (await adtDiscovery(traced.http)).flatMap((workspace) =>
          workspace.collection.map((collection) => collection.href)
        )
      )
      const modernReferences = "/sap/bc/adt/repository/informationsystem/usageReferences"
      if (!paths.has(modernReferences) && legacyWhereUsedPaths.every((path) => paths.has(path))) {
        engine = "ADT_RIS_WHEREUSED"
        const currentSource = source ?? (await this.readSourceByUri(connectionId, uri)).source
        const result = await legacyWhereUsed(traced.http, target, line, character, currentSource)
        return { ...result, requestTrace: traced.requests }
      }
      if (!paths.has(modernReferences)) {
        // The legacy route is advertised only in part, so neither engine is usable here. Calling
        // the modern endpoint blind would return a 404 that reads as "this platform has no
        // where-used at all", which hides both the route that was actually intended and the
        // endpoints that are missing. Name what is absent instead of probing what is not there.
        const missing = legacyWhereUsedPaths.filter((path) => !paths.has(path))
        throw new Error(
          `where-used capability unsupported-endpoint: neither the modern usageReferences endpoint nor the complete legacy RIS route is advertised on this connection; missing legacy endpoint(s): ${missing.join(", ")}`
        )
      }
      // SDK 8.4.3 omits the cursor when column is zero; supply the complete URI.
      references = await requestUsageReferences(traced.http, `${target}#start=${line},${character}`)
    } catch (error) {
      const last = traced.requests.at(-1)
      const message =
        last?.outcome === "timeout" || last?.outcome === "budget-exhausted"
          ? `where-used capability request-failed: ${last.stage} ${last.outcome} after ${last.elapsedMs}ms (request budget ${last.timeoutMs}ms); SAP cancellation is unconfirmed`
          : capabilityFailure("where-used", error).message
      throw new WhereUsedRequestError(message, traced.requests, engine, error)
    }
    return references.map((reference) => ({
      uri: reference.uri,
      objectIdentifier: reference.objectIdentifier,
      name: reference["adtcore:name"],
      type: reference["adtcore:type"],
      description: reference["adtcore:description"],
      packageName: reference.packageRef?.["adtcore:name"]
    }))
  }

  async usageReferenceSnippets(
    connectionId: string,
    references: UsageReferenceInfo[]
  ): Promise<UsageSnippetInfo[]> {
    if (references.some((reference) => reference.identifierKind === "ADT_RIS_URI"))
      throw new Error("Legacy RIS references do not support modern usage snippets.")
    const client = await this.getClient(connectionId)
    const snippets = await client.statelessClone.usageReferenceSnippets(
      references.map((reference) => ({ objectIdentifier: reference.objectIdentifier })) as never
    )
    return snippets.map((entry) => ({
      objectIdentifier: entry.objectIdentifier,
      snippets: entry.snippets.map((snippet) => ({
        line: snippet.uri.start?.line,
        content: snippet.content || snippet.matches || "No content"
      }))
    }))
  }

  async revisions(connectionId: string, objectUri: string): Promise<RevisionInfo[]> {
    const client = await this.getClient(connectionId)
    try {
      const structure = await loadRevisionObjectStructure(client, objectUri)
      // The library reads `str.metaData["adtcore:name"]` and follows the version feed link from the
      // structure. A structure without metadata cannot yield either, so report the same structured
      // state as a missing document rather than letting a TypeError escape.
      if (!structure || typeof structure !== "object" || !structure.metaData) {
        throw new VersionHistoryUnavailableError("VERSION_HISTORY_STRUCTURE_INCOMPLETE", {
          objectUri,
          cause: "ADT object structure carried no metadata block"
        })
      }
      return await client.revisions(structure)
    } catch (error) {
      throw revisionFailure(error, objectUri)
    }
  }

  async runQuery(
    connectionId: string,
    sql: string,
    maxRows: number,
    options?: { allowScopedFallback: boolean }
  ): Promise<Record<string, unknown>[]> {
    const client = await this.getClient(connectionId)
    try {
      return await runSapDataQuery(client.httpClient, sql, maxRows)
    } catch (error) {
      if (options?.allowScopedFallback === false) throw error
      const config = this.configs.get(connectionId.toLowerCase())
      if (
        !config ||
        config.id.toLowerCase() !== CUSTOMER_CONNECTION_ID ||
        config.client !== CUSTOMER_CLIENT
      )
        throw error
      return runScopedQueryFallback(sql, maxRows, config.client, error, (request) =>
        this.callRemoteFunction(connectionId, request)
      )
    }
  }

  /**
   * List one user's transport requests.
   *
   * The ADT transport-organizer list is asked first, but on ECC 7.31 it answers with a document
   * that carries no `tm:workbench/tm:target` grouping, so the client's parse yields nothing and the
   * tool reported "0 transport requests" for a user who demonstrably had several. An empty primary
   * result therefore falls back to the authoritative CTS tables - E070 for the requests and E07T
   * for their texts - both of which are read-only and in the D5-2 allowlist. `source` names the
   * answer that was used, so an empty list is never mistaken for a successful empty read.
   */
  async listUserTransports(
    connectionId: string,
    user: string,
    readTable?: TransportTableReader
  ): Promise<UserTransportsListing> {
    const owner = user.toUpperCase()
    const client = await this.getClient(connectionId)
    let primary: TransportsOfUser | undefined
    let primaryError: unknown
    try {
      primary = await client.userTransports(owner, true)
    } catch (error) {
      primaryError = error
    }
    if (primary && countTransportRequests(primary) > 0)
      return { ...primary, source: "adt-transport-organizer" }
    try {
      return {
        ...(await this.transportsFromCtsTables(connectionId, owner, readTable)),
        source: "cts-tables"
      }
    } catch (error) {
      // The fallback is the more reliable of the two reads, so when it fails the primary failure is
      // the one that explains why - unless there was none.
      throw capabilityFailure("transport-list", primaryError ?? error)
    }
  }

  /**
   * Rebuild the transport-organizer listing shape from the CTS tables.
   *
   * E070 holds one row per request/task; TRFUNCTION separates the workbench (K) from customizing (W)
   * and other kinds, and TRSTATUS separates modifiable (D) from released (R/L). Rows are grouped by
   * TARSYSTEM so the result matches the target-grouped shape the callers already consume, and E07T
   * supplies the short text that E070 does not carry.
   */
  private async transportsFromCtsTables(
    connectionId: string,
    owner: string,
    readTable?: TransportTableReader
  ): Promise<TransportsOfUser> {
    assertTableAllowed("E070")
    assertTableAllowed("E07T")
    // When the caller supplies the reviewed reader, the CTS read goes through it. `runQuery` alone
    // cannot carry this read on this system: its native ADT data-preview path answers HTML, so the
    // fallback used to fail and `create_transport_request` could not observe its own pre-change
    // state. Both reads keep the same projection and the same 500-row bound either way.
    const requests = readTable
      ? await readTable(
          connectionId,
          "E070",
          ["TRKORR", "TRFUNCTION", "TRSTATUS", "TARSYSTEM", "AS4USER", "AS4DATE", "AS4TIME"],
          [{ column: "AS4USER", operator: "EQ", value: owner }],
          500
        )
      : await this.runQuery(
          connectionId,
          `SELECT TRKORR, TRFUNCTION, TRSTATUS, TARSYSTEM, AS4USER, AS4DATE, AS4TIME FROM E070 WHERE AS4USER = '${owner.replaceAll("'", "''")}'`,
          500
        )
    // E07T holds one row per request and language. Two separate bounds lose descriptions here, and
    // both were observed on w200 rather than inferred:
    //   - an unfiltered read is capped at 500 rows in key order, and a user's request numbers sort
    //     past that bound, so every description came back empty even though E07T carried it;
    //   - one bracket over the whole TRKORR span a user's requests cover is still truncated at 500
    //     rows, and because E07T is keyed by TRKORR the truncation drops the HIGHEST numbers - which
    //     is exactly where that user's newest workbench requests live.
    // The span is therefore read in bounded chunks, and a chunk that comes back at the bound is
    // split and re-read, so a description is never lost to a truncation the caller cannot see. An
    // OPTIONS line is capped at 72 characters, which is why this is a range and not a TRKORR IN list.
    const texts = new Map<string, string>()
    if (requests.length) {
      const numbers = [
        ...new Set(
          requests.map((row) => String(row.TRKORR ?? "").trim()).filter((number) => number !== "")
        )
      ].sort()
      const queue: string[][] = []
      for (let index = 0; index < numbers.length; index += E07T_CHUNK_REQUESTS) {
        queue.push(numbers.slice(index, index + E07T_CHUNK_REQUESTS))
      }
      while (queue.length) {
        const chunk = queue.shift()
        const lowest = chunk?.[0]
        const highest = chunk?.[chunk.length - 1]
        if (!chunk?.length || lowest === undefined || highest === undefined) continue
        const descriptions = readTable
          ? await readTable(
              connectionId,
              "E07T",
              ["TRKORR", "LANGU", "AS4TEXT"],
              [
                { column: "TRKORR", operator: "GE", value: lowest },
                { column: "TRKORR", operator: "LE", value: highest }
              ],
              E07T_MAX_ROWS
            )
          : await this.runQuery(
              connectionId,
              `SELECT TRKORR, LANGU, AS4TEXT FROM E07T WHERE TRKORR >= '${lowest}' AND TRKORR <= '${highest}'`,
              E07T_MAX_ROWS
            )
        // Rows are ordered before the first description per request is chosen, so one request always
        // resolves to one text regardless of the language rows the range also returned.
        const ordered = [...descriptions].sort((left, right) =>
          `${String(left.TRKORR ?? "")}|${String(left.LANGU ?? "")}`.localeCompare(
            `${String(right.TRKORR ?? "")}|${String(right.LANGU ?? "")}`
          )
        )
        for (const row of ordered) {
          const number = String(row.TRKORR ?? "").trim()
          const description = String(row.AS4TEXT ?? "").trim()
          if (number && description && !texts.has(number)) texts.set(number, description)
        }
        if (descriptions.length >= E07T_MAX_ROWS && chunk.length > 1) {
          const middle = Math.ceil(chunk.length / 2)
          queue.unshift(chunk.slice(middle), chunk.slice(0, middle))
        }
      }
    }
    const workbench = new Map<string, TransportTarget>()
    const customizing = new Map<string, TransportTarget>()
    for (const row of requests) {
      const number = String(row.TRKORR ?? "").trim()
      if (!number) continue
      const target = String(row.TARSYSTEM ?? "").trim() || "LOCAL"
      const kind = String(row.TRFUNCTION ?? "")
        .trim()
        .toUpperCase()
      const status = String(row.TRSTATUS ?? "").trim()
      const released = /^[RL]$/.test(status.toUpperCase())
      const request: TransportRequest = {
        "tm:number": number,
        "tm:owner": String(row.AS4USER ?? "").trim() || owner,
        "tm:desc": texts.get(number) ?? "",
        "tm:status": status,
        "tm:uri": "",
        links: [],
        tasks: [],
        objects: []
      }
      // TRFUNCTION is not part of the requested projection's identity: K is workbench and
      // everything else is reported under customizing, which is the same split the ADT document
      // uses and keeps a caller's existing grouping stable.
      const bucket = kind === "K" ? workbench : customizing
      const entry = bucket.get(target) ?? {
        "tm:name": target,
        "tm:desc": target,
        modifiable: [],
        released: []
      }
      entry[released ? "released" : "modifiable"].push(request)
      bucket.set(target, entry)
    }
    return { workbench: [...workbench.values()], customizing: [...customizing.values()] }
  }

  async transportDetails(connectionId: string, transportNumber: string) {
    const client = await this.getClient(connectionId)
    try {
      const result = await client.transportDetails(transportNumber)
      if (
        result["tm:number"]?.toUpperCase() === transportNumber.toUpperCase() &&
        Array.isArray(result.objects) &&
        Array.isArray(result.tasks)
      ) {
        return result
      }
    } catch (error) {
      const failure = capabilityFailure("transport-details", error)
      if (!legacyRepositoryFallbackAvailable(failure)) throw failure
    }
    const result = await this.callSapRepository(connectionId, {
      operation: "READ_TRANSPORT_DETAILS",
      transportNumber
    })
    requireRepositoryResult(result, "transport detail read")
    return transportDetailsFromRepository(result.source, transportNumber)
  }

  async cleanupTransportEntries(
    connectionId: string,
    taskNumber: string,
    parentTransportNumber: string,
    entries: TransportCleanupEntry[]
  ): Promise<void> {
    await this.withStatefulClient(connectionId, async (client) => {
      const body = buildTransportCleanupRequest(taskNumber, parentTransportNumber, entries)
      await client.httpClient.request(
        `/sap/bc/adt/cts/transportrequests/${encodeURIComponent(taskNumber)}`,
        {
          method: "PUT",
          body,
          headers: {
            Accept: "application/vnd.sap.adt.transportorganizer.v1+xml",
            "Content-Type": "application/vnd.sap.adt.transportorganizer.v1+xml"
          }
        }
      )
    })
  }

  async inactiveObjectInventory(connectionId: string) {
    const client = await this.getClient(connectionId)
    return readInactiveInventory(client.statelessClone.httpClient)
  }

  async exportResource(
    connectionId: string,
    source: string,
    objectType?: string
  ): Promise<ExportResourceInfo> {
    const id = connectionId.toLowerCase()
    const client = await this.getClient(id)
    const object = await this.resolveExportObject(id, source, objectType)
    const files = new Map<string, { relativePath: string; sourceUri: string; content: string }>()
    const failures: string[] = []
    const visitedParents = new Set<string>()

    const addFile = async (
      relativePath: string,
      sourceUri: string,
      load: () => Promise<string>
    ) => {
      if (files.has(sourceUri)) return
      if (files.size >= 2000) throw new Error("Export exceeds the 2000-file safety limit")
      try {
        files.set(sourceUri, { relativePath, sourceUri, content: await load() })
      } catch (error) {
        failures.push(`${sourceUri} (${errorText(error)})`)
      }
    }

    const addObject = async (item: AbapObjectInfo, base = "") => {
      const objectBase = exportPath(base, item.type, item.name)
      if (item.type.startsWith("CLAS") && !/\/includes\//i.test(item.uri)) {
        try {
          const structure = await client.objectStructure(item.uri)
          if (isClassStructure(structure) && structure.includes.length) {
            for (const include of structure.includes) {
              const sourceUri = include["abapsource:sourceUri"]
              await addFile(
                `${objectBase}/${safeExportSegment(include["class:includeType"])}.abap`,
                sourceUri,
                () => client.getObjectSource(sourceUri)
              )
            }
            return
          }
        } catch {
          // Older systems may not expose class metadata; use the normal source fallback.
        }
      }
      await addFile(
        `${objectBase}.abap`,
        item.uri,
        async () => (await this.readSource(id, item)).source
      )
    }

    const addParent = async (parentType: NodeParents, parentName: string, base: string) => {
      const parentKey = `${parentType}:${parentName}`
      if (visitedParents.has(parentKey)) return
      visitedParents.add(parentKey)
      const tree = await client.nodeContents(parentType, parentName, undefined, undefined, true)
      for (const node of tree.nodes) {
        if (!node.OBJECT_URI || !node.OBJECT_NAME) continue
        if (node.OBJECT_TYPE === parentType && node.OBJECT_NAME === parentName) continue
        const item: AbapObjectInfo = {
          name: node.OBJECT_NAME,
          type: node.OBJECT_TYPE,
          description: node.DESCRIPTION ?? "",
          package: parentType === "DEVC/K" ? parentName : object.package,
          systemType: /^[ZY]/.test(node.OBJECT_NAME) ? "CUSTOM" : "STANDARD",
          uri: node.OBJECT_URI.replace(/[?#].*$/, "")
        }
        if (node.OBJECT_TYPE === "DEVC/K") {
          await addParent(
            "DEVC/K",
            node.OBJECT_NAME,
            exportPath(base, node.OBJECT_TYPE, node.OBJECT_NAME)
          )
        } else if (node.OBJECT_TYPE === "PROG/P" || node.OBJECT_TYPE === "PROG/PI") {
          await addObject(item, base)
          await addParent(
            node.OBJECT_TYPE,
            node.OBJECT_NAME,
            exportPath(base, item.type, item.name)
          )
        } else if (node.OBJECT_TYPE === "FUGR/F") {
          await addParent("FUGR/F", node.OBJECT_NAME, exportPath(base, item.type, item.name))
        } else {
          await addObject(item, base)
        }
      }
    }

    const directUri = object.uri.replace(/[?#].*$/, "")
    if (/\/source\/|\/includes\//i.test(directUri)) {
      await addFile(
        `${safeExportSegment(object.name)}.abap`,
        directUri,
        async () => (await this.readSourceByUri(id, directUri)).source
      )
    } else if (object.type === "DEVC/K") {
      await addParent("DEVC/K", object.name, safeExportSegment(object.name))
    } else if (object.type === "PROG/P" || object.type === "PROG/PI") {
      await addObject(object)
    } else if (object.type === "FUGR/F") {
      await addParent("FUGR/F", object.name, safeExportSegment(object.name))
    } else {
      await addObject(object)
    }

    return { connectionId: id, source, files: [...files.values()], failures }
  }

  async discoverySnapshot(connectionId: string): Promise<DiscoverySnapshotInfo> {
    const client = await this.getClient(connectionId)
    const [discovery, coreDiscovery] = await Promise.all([
      client.adtDiscovery(),
      client.adtCoreDiscovery()
    ])
    const resAppClasses: Array<{ name: string; description: string }> = []
    let queryWarning: string | undefined
    try {
      for (const [baseClass, limit] of [
        ["CL_ADT_DISC_RES_APP_BASE", 500],
        ["CL_ADT_RES_APP_BASE", 100]
      ] as const) {
        const sql =
          `SELECT r~CLSNAME, t~DESCRIPT FROM SEOMETAREL AS r ` +
          `LEFT OUTER JOIN SEOCLASSTX AS t ON r~CLSNAME = t~CLSNAME AND t~LANGU = 'E' ` +
          `WHERE r~REFCLSNAME = '${baseClass}' AND r~RELTYPE = '2' AND r~VERSION = '1'`
        const result = await client.runQuery(sql, limit, true)
        for (const row of result.values as Array<Record<string, unknown>>) {
          const name = String(row.CLSNAME ?? "")
          if (name && !resAppClasses.some((item) => item.name === name)) {
            resAppClasses.push({ name, description: String(row.DESCRIPT ?? "") })
          }
        }
      }
    } catch (error) {
      queryWarning = `RES_APP class query unavailable: ${errorText(error)}`
    }
    return {
      workspaces: discovery.map((workspace) => ({
        title: workspace.title,
        collections: workspace.collection.map((collection) => ({
          href: collection.href,
          ...(collection.title ? { title: collection.title } : {}),
          templateLinks: collection.templateLinks.map((link) => ({
            rel: link.rel,
            template: link.template,
            ...(link.title ? { title: link.title } : {}),
            ...(link.type ? { type: link.type } : {})
          }))
        }))
      })),
      coreEntries: coreDiscovery.map((entry) => ({
        title: entry.title,
        href: entry.collection.href,
        collectionTitle: entry.collection.title,
        category: entry.collection.category
      })),
      resAppClasses,
      ...(queryWarning ? { queryWarning } : {})
    }
  }

  async diagnostics(connectionId: string, fileUri: string): Promise<DiagnosticInfo[]> {
    const client = await this.getClient(connectionId)
    try {
      const source = await this.readSourceByUri(connectionId, fileUri)
      return await withAdtStageTimeout(
        "SYNTAX_CHECK_TIMEOUT",
        "syntax check",
        source.uriUsed,
        SYNTAX_CHECK_TIMEOUT_MS,
        () =>
          requestSyntaxCheck(
            boundedAdtHttp(client.httpClient, SYNTAX_CHECK_TIMEOUT_MS),
            source.uriUsed,
            source.uriUsed,
            source.source
          )
      )
    } catch (error) {
      if (error instanceof AdtRequestTimeoutError) throw error
      throw capabilityFailure("syntax-diagnostics", error)
    }
  }

  async runAtc(connectionId: string, objectUri: string): Promise<AtcResultInfo> {
    const client = await this.getClient(connectionId)
    const config = this.configs.get(connectionId.toLowerCase())
    if (!config) throw new Error(`Connection not found: ${connectionId}`)
    try {
      const normalized = normalizeAdtUri(objectUri, connectionId)
      const targetUri = optimalSourceUri(detectTypeFromUri(normalized), normalized)
      return await executeNativeAtc(client, targetUri, config.atcVariant)
    } catch (error) {
      if (error instanceof AtcStageError) {
        throw new AtcStageError(error.stage, capabilityFailure("atc", error.cause))
      }
      throw capabilityFailure("atc", error)
    }
  }

  async inspectAtc(connectionId: string) {
    const client = await this.getClient(connectionId)
    try {
      return await inspectNativeAtc(
        client,
        this.configs.get(connectionId.toLowerCase())?.atcVariant
      )
    } catch (error) {
      throw new AtcStageError(
        "customizing",
        capabilityFailure("atc", error instanceof AtcStageError ? error.cause : error)
      )
    }
  }

  async atcDocumentation(connectionId: string, docUri: string): Promise<string> {
    const client = await this.getClient(connectionId)
    try {
      return String((await client.atcDocumentation(docUri)).body)
    } catch (error) {
      throw capabilityFailure("atc-documentation", error)
    }
  }

  async runUnitTests(connectionId: string, objectUri: string): Promise<UnitTestClassInfo[]> {
    const client = await this.getClient(connectionId)
    try {
      const classes = await client.unitTestRun(
        optimalSourceUri(detectTypeFromUri(objectUri), objectUri)
      )
      return classes.map((testClass) => ({
        name: testClass["adtcore:name"],
        alerts: testClass.alerts.map(mapUnitTestAlert),
        methods: testClass.testmethods.map((method) => ({
          name: method["adtcore:name"],
          executionTime: method.executionTime,
          alerts: method.alerts.map(mapUnitTestAlert)
        }))
      }))
    } catch (error) {
      const failure = capabilityFailure("abap-unit", error)
      const discovery = await describeDiscovery(client, "/sap/bc/adt/abapunit")
      throw new Error(`${failure.message}; ADT discovery: ${discovery}`)
    }
  }

  async replaceSource(
    connectionId: string,
    fileUri: string,
    oldString: string,
    newString: string,
    transportNumber?: string,
    expectedSourceFingerprint?: string,
    recoverInactiveSource?: boolean
  ): Promise<SourceMutationInfo> {
    return this.withStatefulClient(connectionId, (client) =>
      replaceSourceWithClient(
        client,
        connectionId,
        fileUri,
        oldString,
        newString,
        transportNumber,
        expectedSourceFingerprint,
        recoverInactiveSource
      )
    )
  }

  async inspectSource(connectionId: string, fileUri: string): Promise<SourceInspectionInfo> {
    return inspectSourceWithClient(await this.getClient(connectionId), connectionId, fileUri)
  }

  async activateSource(connectionId: string, fileUri: string): Promise<ActivationInfo> {
    return this.withStatefulClient(connectionId, async (client) => {
      const target = resolveEditableSourceTarget(fileUri, connectionId)
      const before = await inspectSourceWithClient(client, connectionId, fileUri)
      const expected = before.inactiveSource ?? before.activeSource
      const activation = await activateTarget(client, target.objectUri, target.objectName)
      if (activation.success) {
        const active = await client.getObjectSource(target.sourceUri, { version: "active" })
        if (active !== expected) {
          activation.success = false
          activation.messages.push({
            type: "E",
            line: 0,
            text: "ACTIVE_SOURCE_FINGERPRINT_MISMATCH: activate-only readback differs from the reviewed source.",
            href: target.sourceUri
          })
        }
      }
      return activation
    })
  }

  async createObject(
    connectionId: string,
    request: CreateObjectRequest
  ): Promise<ObjectCreationInfo> {
    const prepared = prepareCreateObjectRequest(connectionId, request)
    const language = this.configs.get(connectionId.toLowerCase())?.language ?? "EN"
    try {
      return await this.withStatefulClient(connectionId, (client) =>
        createObjectWithClient(client, prepared, language)
      )
    } catch (error) {
      const fallback =
        (prepared.objectType === "FUGR/F" && legacyFunctionGroupCreationUnavailable(error)) ||
        (prepared.objectType === "FUGR/I" && legacyFunctionIncludeCreationUnavailable(error))
      if (!fallback) throw error
    }

    const result = await this.callSapRepository(connectionId, {
      operation:
        prepared.objectType === "FUGR/I" ? "CREATE_FUNCTION_INCLUDE" : "CREATE_FUNCTION_GROUP",
      objectName: prepared.objectName,
      description: prepared.description,
      packageName: prepared.packageName,
      transportNumber: prepared.transportNumber,
      ...(prepared.objectType === "FUGR/I"
        ? {
            objectType: prepared.objectType,
            program: prepared.parentName,
            source: [`* ${prepared.description}`]
          }
        : {})
    })
    if (result.status !== "S") {
      throw new Error(
        `SAP repository helper rejected ${prepared.objectType} creation: ${result.code}: ${result.message}`
      )
    }
    return {
      connectionId: prepared.connectionId,
      objectType: prepared.objectType,
      objectName: prepared.objectName,
      description: prepared.description,
      packageName: prepared.packageName,
      parentName: prepared.parentName,
      transportNumber: prepared.transportNumber,
      objectUri: prepared.objectUri,
      workspaceUri: prepared.workspaceUri,
      activation: { success: true, messages: [], inactiveObjects: [] }
    }
  }

  async deleteObject(
    connectionId: string,
    object: AbapObjectInfo,
    transportNumber: string,
    expectedFingerprint: string
  ): Promise<string> {
    return this.withStatefulClient(connectionId, (client) =>
      deleteObjectWithClient(client, object, transportNumber, expectedFingerprint)
    )
  }

  async sourceObjectExists(connectionId: string, object: AbapObjectInfo): Promise<boolean> {
    const client = await this.getClient(connectionId)
    try {
      await client.getObjectSource(optimalSourceUri(object.type, object.uri))
      return true
    } catch (error) {
      if (isNotFoundError(error)) return false
      if (!/\bI::000 MODE SVP 200\b/i.test(errorText(error))) {
        throw new Error(`Could not verify source object deletion: ${errorText(error)}`)
      }
      try {
        const matches = await client.searchObject(
          object.name.toUpperCase(),
          object.type.split("/", 1)[0]
        )
        return matches.some((candidate) => {
          const record = candidate as unknown as Record<string, string | undefined>
          return record["adtcore:name"]?.toUpperCase() === object.name.toUpperCase()
        })
      } catch {
        throw new Error(`Could not verify source object deletion: ${errorText(error)}`)
      }
    }
  }

  async readMessageClass(connectionId: string, messageClass: string): Promise<MessageClassInfo> {
    const client = await this.getClient(connectionId)
    try {
      return await readMessageClassWithClient(client, connectionId.toLowerCase(), messageClass)
    } catch (error) {
      if (
        !legacyRepositoryFallbackAvailable(error) &&
        !/SAP returned invalid message class XML/i.test(errorText(error))
      ) {
        throw error
      }
    }
    const normalized = readableObjectName(messageClass)
    const result = await this.callSapRepository(connectionId, {
      operation: "READ_MESSAGE_CLASS",
      objectName: normalized
    })
    requireRepositoryResult(result, "message class read")
    return messageClassFromRepository(connectionId, normalized, result.source)
  }

  async createMessageClass(
    connectionId: string,
    messageClass: string,
    description: string,
    messages: Array<{ number: string; text: string }>,
    packageName: string,
    transportNumber: string
  ): Promise<MessageClassCreationInfo> {
    const language = this.configs.get(connectionId.toLowerCase())?.language ?? "EN"
    try {
      return await this.withStatefulClient(connectionId, (client) =>
        createMessageClassWithClient(
          client,
          connectionId.toLowerCase(),
          messageClass,
          description,
          messages,
          packageName,
          transportNumber,
          language
        )
      )
    } catch (error) {
      if (
        !legacyRepositoryFallbackAvailable(error) &&
        !/SAP returned invalid message class XML/i.test(errorText(error))
      ) {
        throw error
      }
    }
    const normalized = customerObjectName(messageClass, "messageClass", 20)
    const result = await this.callSapRepository(connectionId, {
      operation: "CREATE_MESSAGE_CLASS",
      objectName: normalized,
      description,
      packageName,
      transportNumber,
      source: serializeRepositoryRows(
        "F",
        messages.map((message) => ({ MSGNR: message.number, TEXT: message.text }))
      )
    })
    requireRepositoryResult(result, "message class creation")
    return {
      ...messageClassFromRepository(connectionId, normalized, result.source),
      transportNumber: repositoryPayloadRows(result.source, "M")[0]?.REQUEST || transportNumber,
      activation: { success: true, messages: [], inactiveObjects: [] }
    }
  }

  async updateMessageClass(
    connectionId: string,
    messageClass: string,
    expectedVersion: string,
    messages: Array<{ number: string; text: string }>,
    packageName: string,
    transportNumber: string
  ): Promise<MessageClassMutationInfo> {
    const normalized = customerObjectName(messageClass, "messageClass", 20)
    const result = await this.callSapRepository(connectionId, {
      operation: "UPDATE_MESSAGE_CLASS",
      objectName: normalized,
      packageName,
      transportNumber,
      expectedVersion,
      source: serializeRepositoryRows(
        "F",
        messages.map((message) => ({ MSGNR: message.number, TEXT: message.text }))
      )
    })
    requireRepositoryResult(result, "message class update")
    return {
      ...messageClassFromRepository(connectionId, normalized, result.source),
      transportNumber: repositoryPayloadRows(result.source, "M")[0]?.REQUEST || transportNumber
    }
  }

  async deleteMessageClass(
    connectionId: string,
    messageClass: string,
    expectedVersion: string,
    packageName: string,
    transportNumber: string
  ): Promise<MessageClassDeletionInfo> {
    const normalized = customerObjectName(messageClass, "messageClass", 20)
    const result = await this.callSapRepository(connectionId, {
      operation: "DELETE_MESSAGE_CLASS",
      objectName: normalized,
      packageName,
      transportNumber,
      expectedVersion
    })
    requireRepositoryResult(result, "message class deletion")
    return {
      connectionId: connectionId.toLowerCase(),
      messageClass: normalized,
      transportNumber: repositoryPayloadRows(result.source, "M")[0]?.REQUEST || transportNumber
    }
  }

  async createTestInclude(
    connectionId: string,
    className: string
  ): Promise<TestIncludeCreationInfo> {
    const normalizedClassName = customerObjectName(className, "className")
    return this.withStatefulClient(connectionId, (client) =>
      createTestIncludeWithClient(client, connectionId.toLowerCase(), normalizedClassName)
    )
  }

  async readTextElements(
    connectionId: string,
    objectName: string,
    objectType: TextElementObjectType
  ): Promise<TextElementsInfo> {
    const client = await this.getClient(connectionId)
    try {
      const adtResult = await readTextElementsWithClient(
        client,
        connectionId.toLowerCase(),
        objectName,
        objectType
      )
      if (objectType === "PROGRAM" || adtResult.textElements.length > 0) return adtResult
    } catch (error) {
      if (!legacyRepositoryFallbackAvailable(error)) throw error
    }
    const normalized = readableObjectName(objectName)
    const result = await this.callSapRepository(connectionId, {
      operation: "READ_TEXT_ELEMENTS",
      objectType: repositoryTextObjectType(objectType),
      objectName: normalized,
      program: normalized
    })
    requireRepositoryResult(result, "text element read")
    return textElementsFromRepository(connectionId, normalized, objectType, result.source)
  }

  async writeTextElements(
    connectionId: string,
    objectName: string,
    objectType: TextElementObjectType,
    action: "create" | "update",
    textElements: TextElementInfo[]
  ): Promise<TextElementMutationInfo> {
    try {
      return await this.withStatefulClient(connectionId, (client) =>
        writeTextElementsWithClient(
          client,
          connectionId.toLowerCase(),
          objectName,
          objectType,
          action,
          textElements
        )
      )
    } catch (error) {
      if (!legacyRepositoryFallbackAvailable(error)) throw error
    }
    const normalized = customerObjectName(objectName, "objectName")
    const requested = normalizeTextElements(textElements)
    const result = await this.callSapRepository(connectionId, {
      operation: "MERGE_TEXT_ELEMENTS",
      objectType: repositoryTextObjectType(objectType),
      objectName: normalized,
      program: normalized,
      source: serializeRepositoryRows(
        "T",
        requested.map((element) => ({
          ID: element.id,
          TYPE: element.idType,
          TEXT: element.text,
          MAXLENGTH: String(element.maxLength),
          ACTION: action.toUpperCase()
        }))
      )
    })
    requireRepositoryResult(result, "text element write")
    const verified = textElementsFromRepository(connectionId, normalized, objectType, result.source)
    return {
      ...verified,
      action,
      changedIds: requested.map((element) => element.id),
      transportNumber: repositoryPayloadRows(result.source, "M")[0]?.REQUEST ?? "",
      activation: { success: true, messages: [], inactiveObjects: [] }
    }
  }

  async listDumps(connectionId: string): Promise<DumpListInfo> {
    const client = await this.getClient(connectionId)
    try {
      const feeds = await client.feeds()
      if (!feeds.some((feed) => feed.href === "/sap/bc/adt/runtime/dumps")) {
        return { available: false, dumps: [] }
      }
      const result = await client.dumps()
      return {
        available: true,
        dumps: result.dumps.map((dump) => ({
          id: dump.id,
          errorType:
            dump.categories.find((category) => category.label === "ABAP runtime error")?.term ??
            "Unknown Error",
          text: dump.text
        }))
      }
    } catch (error) {
      throw capabilityFailure("runtime-dumps", error)
    }
  }

  async listTraceRuns(connectionId: string): Promise<TraceRunInfo[]> {
    const client = await this.getClient(connectionId)
    try {
      const result = await client.tracesList()
      return result.runs.map((run) => ({
        id: run.id,
        title: run.title,
        author: run.author,
        published: run.published,
        runtime: run.extendedData.runtime,
        host: run.extendedData.host,
        objectName: run.extendedData.objectName,
        runtimeAbap: run.extendedData.runtimeABAP,
        runtimeDatabase: run.extendedData.runtimeDatabase,
        runtimeSystem: run.extendedData.runtimeSystem,
        isAggregated: run.extendedData.isAggregated,
        stateValue: run.extendedData.state.value,
        stateText: run.extendedData.state.text,
        system: run.extendedData.system
      }))
    } catch (error) {
      throw capabilityFailure("abap-traces", error)
    }
  }

  async listTraceConfigurations(connectionId: string): Promise<TraceConfigurationInfo[]> {
    const client = await this.getClient(connectionId)
    try {
      const result = await client.tracesListRequests()
      return result.requests.map((request) => ({
        id: request.id,
        title: request.title,
        published: request.published,
        host: request.extendedData.host,
        admin: request.authors.find((author) => author.role === "admin")?.name ?? "Unknown",
        tracer: request.authors.find((author) => author.role === "trace")?.name ?? "Unknown",
        processType: request.extendedData.processType,
        objectType: request.extendedData.objectType,
        completedExecutions: request.extendedData.executions.completed,
        maximalExecutions: request.extendedData.executions.maximal,
        isAggregated: request.extendedData.isAggregated
      }))
    } catch (error) {
      throw capabilityFailure("abap-trace-configurations", error)
    }
  }

  async traceHitList(connectionId: string, traceId: string): Promise<TraceEntryInfo[]> {
    const client = await this.getClient(connectionId)
    try {
      const result = await client.tracesHitList(traceId, true)
      return result.entries.map((entry) => ({
        description: entry.description,
        hitCount: entry.hitCount,
        netTime: entry.traceEventNetTime.time,
        grossTime: entry.grossTime.time,
        program: entry.callingProgram?.name ?? "Unknown",
        context: entry.callingProgram?.context ?? "",
        ...(entry.callingProgram?.uri ? { uri: entry.callingProgram.uri } : {})
      }))
    } catch (error) {
      throw capabilityFailure("abap-trace-hit-list", error)
    }
  }

  async traceStatements(connectionId: string, traceId: string): Promise<TraceEntryInfo[]> {
    const client = await this.getClient(connectionId)
    try {
      const result = await client.tracesStatements(traceId, {
        withSystemEvents: true,
        withDetails: true
      })
      return result.statements.map((statement) => ({
        description: statement.description,
        hitCount: statement.hitCount,
        netTime: statement.traceEventNetTime.time,
        grossTime: statement.grossTime.time,
        callLevel: statement.callLevel,
        program: statement.callingProgram?.name ?? "Unknown",
        context: statement.callingProgram?.context ?? "",
        ...(statement.callingProgram?.uri ? { uri: statement.callingProgram.uri } : {})
      }))
    } catch (error) {
      throw capabilityFailure("abap-trace-statements", error)
    }
  }

  async debugSession(
    connectionId: string,
    request: DebugSessionRequest
  ): Promise<DebugSessionInfo> {
    return this.debugger.session(connectionId, request)
  }

  debugStatus(connectionId: string): DebugSessionInfo {
    return this.debugger.status(connectionId)
  }

  async debugBreakpoints(
    connectionId: string,
    request: DebugBreakpointCommand
  ): Promise<DebugBreakpointInfo> {
    const id = connectionId.toLowerCase()
    const target = resolveEditableSourceTarget(request.filePath, id)
    const lineNumbers = [...new Set(request.lineNumbers)]
    if (!lineNumbers.length || lineNumbers.length > 100) {
      throw new Error("lineNumbers must contain between 1 and 100 lines")
    }
    if (!lineNumbers.every((line) => Number.isSafeInteger(line) && line > 0)) {
      throw new Error("lineNumbers must contain positive integers")
    }
    const source = await this.readSourceByUri(id, target.sourceUri)
    const sourceLineCount = source.source.split(/\r?\n/).length
    const outsideSource = lineNumbers.find((line) => line > sourceLineCount)
    if (outsideSource) {
      throw new Error(
        `Breakpoint line ${outsideSource} exceeds the ${sourceLineCount}-line source file`
      )
    }
    return this.debugger.breakpoints(id, {
      action: request.action,
      fileUri: request.filePath,
      sourceUri: target.sourceUri,
      lineNumbers,
      ...(request.condition ? { condition: request.condition } : {})
    })
  }

  async debugStack(connectionId: string, threadId: number): Promise<DebugStackFrameInfo[]> {
    return this.debugger.stack(connectionId, threadId)
  }

  async debugVariables(
    connectionId: string,
    request: DebugVariableRequest
  ): Promise<DebugVariableInfo> {
    return this.debugger.variables(connectionId, request)
  }

  async debugStep(connectionId: string, request: DebugStepRequest): Promise<DebugStepInfo> {
    return this.debugger.step(connectionId, request)
  }

  async close(): Promise<void> {
    await this.debugger.close()
    await Promise.all(
      [...this.clients.values()].map(async (state) => {
        try {
          await state.login
          await state.client.logout()
        } catch {
          // Logout is best-effort during service shutdown.
        }
      })
    )
    this.clients.clear()
  }

  private async resolveExportObject(
    connectionId: string,
    source: string,
    objectType?: string
  ): Promise<AbapObjectInfo> {
    let uri = ""
    if (source.toLowerCase().startsWith("adt://")) {
      const parsed = new URL(source)
      if (parsed.hostname.toLowerCase() !== connectionId) {
        throw new Error(
          `source connection ${parsed.hostname.toLowerCase()} does not match connectionId ${connectionId}`
        )
      }
      uri = parsed.pathname
    } else if (source.startsWith("/sap/bc/adt/")) {
      uri = source
    }
    if (uri) {
      const type = objectType || detectTypeFromUri(uri)
      if (!type)
        throw new Error(`Could not determine object type for ${source}; provide objectType`)
      const name = exportNameFromUri(uri, type)
      return {
        name,
        type,
        description: "",
        package: "",
        systemType: /^[ZY]/.test(name) ? "CUSTOM" : "STANDARD",
        uri
      }
    }
    const matches = await this.searchObjects(
      connectionId,
      source,
      objectType ? [objectType] : undefined,
      5
    )
    const exact =
      matches.find((item) => item.name.toUpperCase() === source.toUpperCase()) ?? matches[0]
    if (!exact) {
      // The repository search answers nothing for a type this release cannot search, so this is a
      // failed lookup, never evidence that the object does not exist.
      throw new Error(
        `Object ${source}${objectType ? ` (${objectType})` : ""} not found by repository search; ` +
          `a search miss is not proof that the object does not exist`
      )
    }
    return exact
  }

  private async getClient(connectionId: string): Promise<ADTClient> {
    const id = connectionId.toLowerCase()
    const existing = this.clients.get(id)
    if (existing) {
      await existing.login
      return existing.client
    }

    const config = this.configs.get(id)
    if (!config) throw new Error(`Connection not found: ${connectionId}`)
    const password = this.passwordFor(config)
    if (!password) {
      throw new Error(`Password environment variable is not set: ${config.passwordEnv}`)
    }

    const options = standaloneClientOptions(config.allowUnauthorized)
    const client = new ADTClient(
      config.url,
      config.username,
      password,
      config.client,
      config.language,
      options
    )
    const login = (async () => {
      await client.login()
      await client.statelessClone.login()
    })()
    this.clients.set(id, { client, login })
    try {
      await login
      return client
    } catch (error) {
      this.clients.delete(id)
      throw error
    }
  }

  private async createDebugClient(connectionId: string): Promise<ADTClient> {
    const config = this.configs.get(connectionId.toLowerCase())
    if (!config) throw new Error(`Connection not found: ${connectionId}`)
    const password = this.passwordFor(config)
    if (!password) {
      throw new Error(`Password environment variable is not set: ${config.passwordEnv}`)
    }
    const client = new ADTClient(
      config.url,
      config.username,
      password,
      config.client,
      config.language,
      { ...standaloneClientOptions(config.allowUnauthorized), timeout: 7_200_000 }
    )
    await client.login()
    preserveCookieSessionWithoutCsrf(client)
    client.stateful = session_types.stateful
    await client.adtCoreDiscovery()
    return client
  }

  private async withStatefulClient<T>(
    connectionId: string,
    action: (client: ADTClient) => Promise<T>
  ): Promise<T> {
    const config = this.configs.get(connectionId.toLowerCase())
    if (!config) throw new Error(`Connection not found: ${connectionId}`)
    const password = this.passwordFor(config)
    if (!password) {
      throw new Error(`Password environment variable is not set: ${config.passwordEnv}`)
    }
    let requestDiagnostic = ""
    const client = new ADTClient(
      config.url,
      config.username,
      password,
      config.client,
      config.language,
      writeClientOptions(config.allowUnauthorized, (diagnostic) => {
        requestDiagnostic = diagnostic
      })
    )
    // ABAP FS establishes the ordinary ADT login first and only then opens the stateful session, and that is
    // what every recorded deployment used, so it stays the default. If SAP keeps answering the lock request
    // while refusing the write as "not locked", the switch may simply be arriving too late for the session SAP
    // created on the stateless login: ABAP_MCP_STATEFUL_FROM_LOGIN=1 asks for a stateful session from the login
    // request onwards as well. Read per call, so it can be flipped without a rebuild.
    if (process.env.ABAP_MCP_STATEFUL_FROM_LOGIN) client.stateful = session_types.stateful
    await client.login()
    preserveCookieSessionWithoutCsrf(client)
    client.stateful = session_types.stateful
    try {
      return await action(client)
    } catch (error) {
      throw new Error(`${errorText(error)}${requestDiagnostic ? `; ${requestDiagnostic}` : ""}`)
    } finally {
      await client.logout().catch(async () => client.dropSession().catch(() => undefined))
    }
  }
}

export async function deleteObjectWithClient(
  client: Pick<ADTClient, "lock" | "getObjectSource" | "deleteObject" | "unLock">,
  object: AbapObjectInfo,
  transportNumber: string,
  expectedFingerprint: string
): Promise<string> {
  let lock: AdtLock | undefined
  let deleted = false
  try {
    lock = await client.lock(object.uri, "MODIFY")
    const source = await client.getObjectSource(optimalSourceUri(object.type, object.uri), {
      version: "active"
    })
    const fingerprint = createHash("sha256").update(source).digest("hex")
    if (fingerprint !== expectedFingerprint.toLowerCase()) {
      throw new Error(
        `SOURCE_FINGERPRINT_CONFLICT: expected ${expectedFingerprint.toLowerCase()}, current ${fingerprint}`
      )
    }
    await client.deleteObject(object.uri, lock.LOCK_HANDLE, transportNumber)
    deleted = true
    return fingerprint
  } finally {
    if (lock && !deleted) {
      await client.unLock(object.uri, lock.LOCK_HANDLE).catch(() => undefined)
    }
  }
}

export function preserveCookieSessionWithoutCsrf(client: ADTClient): void {
  const httpClient = client.httpClient
  if (client.loggedin || !httpClient.ascookies()) return
  if (Object.prototype.hasOwnProperty.call(httpClient, "loggedin")) return

  // ECC 7.31 may authenticate with cookies but omit the CSRF response token.
  Object.defineProperty(httpClient, "loggedin", {
    configurable: true,
    get: () => httpClient.csrfToken !== "fetch" || httpClient.ascookies().length > 0
  })
}

export function buildSapHelperEnvelope(request: SapHelperRequest): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soapenv:Body>` +
    `<n1:Z_ORVANTA_MCP_EXECUTE xmlns:n1="urn:sap-com:document:sap:rfc:functions">` +
    `<IV_OPERATION>${encodeXml(request.operation)}</IV_OPERATION>` +
    `<IV_OBJECT_TYPE>${encodeXml(request.objectType ?? "")}</IV_OBJECT_TYPE>` +
    `<IV_OBJECT_NAME>${encodeXml(request.objectName ?? "")}</IV_OBJECT_NAME>` +
    // WRITE_FUNCTION_SOURCE and PATCH_FUNCTION_INTERFACE are the only helper operations that carry
    // a payload. The elements mirror the repository envelope one for one, so the shared repository
    // body sees the same package, request, expected version and IT_SOURCE rows it already reads for
    // its own writes.
    (request.operation === "WRITE_FUNCTION_SOURCE" ||
    request.operation === "PATCH_FUNCTION_INTERFACE"
      ? xmlElement("IV_PROGRAM", request.program ?? "") +
        xmlElement("IV_PACKAGE", request.packageName ?? "") +
        xmlElement("IV_REQUEST", request.transportNumber ?? "") +
        xmlElement("IV_EXPECTED_VERSION", request.expectedVersion ?? "") +
        xmlTable(
          "IT_SOURCE",
          (request.source ?? []).map((LINE) => ({ LINE }))
        )
      : "") +
    // RFC returns a TABLES parameter only when the caller sent it. Without this element the CAPABILITIES
    // reply of Z_ORVANTA_MCP_EXECUTE carries EV_STATUS/EV_CODE/EV_VERSION and no IT_SOURCE at all, so the
    // HELPER identity line never reaches the client and the helper looks un-upgraded. The working
    // repository and DDIC envelopes send an empty IT_SOURCE the same way.
    (request.operation === "CAPABILITIES" ? `<IT_SOURCE></IT_SOURCE>` : "") +
    `</n1:Z_ORVANTA_MCP_EXECUTE>` +
    `</soapenv:Body>` +
    `</soapenv:Envelope>`
  )
}

export function buildTransportCleanupRequest(
  taskNumber: string,
  parentTransportNumber: string,
  entries: TransportCleanupEntry[]
): string {
  const objects = entries
    .map(
      (entry) =>
        `<tm:abap_object tm:pgmid="${encodeXml(entry.pgmid)}" tm:type="${encodeXml(entry.type)}" tm:name="${encodeXml(entry.name)}"` +
        `${entry.wbType ? ` tm:wbtype="${encodeXml(entry.wbType)}"` : ""}` +
        ` tm:position="${encodeXml(entry.position)}"/>`
    )
    .join("")
  // A CTS entry belongs to a container: either the request itself or one of its tasks. SAP's own
  // transport-organizer document nests `tm:abap_object` inside the container that holds it, and a
  // PUT that lists an object under the wrong container is answered with 2xx while nothing is
  // removed - which is why the caller's post-check, not the HTTP status, is what catches it. The
  // objects therefore go inside the task whenever the caller names one that differs from the
  // request, and directly under the request only when the entry really lives there.
  const container =
    taskNumber === parentTransportNumber
      ? objects
      : `<tm:task tm:number="${encodeXml(taskNumber)}">${objects}</tm:task>`
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm" tm:useraction="removeobject" tm:number="${encodeXml(taskNumber)}">` +
    `<tm:request tm:number="${encodeXml(parentTransportNumber)}">${container}</tm:request>` +
    `</tm:root>`
  )
}

export function parseSapHelperResponse(body: string): SapHelperResult {
  const document = parse(body, { parseTagValue: false, trimValues: true })
  const fault = findXmlValue(document, "faultstring")
  if (fault) throw new Error(`SAP SOAP fault: ${fault}`)

  const result = {
    status: findXmlValue(document, "EV_STATUS") ?? "",
    code: findXmlValue(document, "EV_CODE") ?? "",
    message: findXmlValue(document, "EV_MESSAGE") ?? "",
    version: findXmlValue(document, "EV_VERSION") ?? "",
    // The helper returns IT_SOURCE only when it sent the table. PATCH_FUNCTION_INTERFACE uses it
    // for bounded difference rows on a rejected patch; every other operation ignores it.
    source: findXmlRows(document, "IT_SOURCE").map((row) => row.LINE ?? "")
  }
  if (!result.status || !result.code || !result.version) {
    throw new Error("SAP helper returned an incomplete SOAP response")
  }
  return result
}

export function buildRemoteFunctionEnvelope(request: RemoteFunctionRequest): string {
  if (!/^[A-Z][A-Z0-9_]{0,29}$/.test(request.functionName)) {
    throw new Error("Invalid remote function module name")
  }
  const parameters = Object.entries(request.inputParameters)
    .map(([name, value]) => {
      validateRemoteXmlName(name, "parameter")
      if (typeof value === "string") return xmlElement(name, value)
      if (Array.isArray(value)) {
        return xmlTable(
          name,
          value.map((row) => validatedRemoteRecord(row))
        )
      }
      return xmlRecord(name, validatedRemoteRecord(value))
    })
    .join("")
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soapenv:Body>` +
    `<n1:${request.functionName} xmlns:n1="urn:sap-com:document:sap:rfc:functions">` +
    parameters +
    `</n1:${request.functionName}>` +
    `</soapenv:Body>` +
    `</soapenv:Envelope>`
  )
}

export function parseRemoteFunctionResponse(
  body: string,
  outputParameters: RemoteFunctionParameterShape[],
  preserveTableReaderPadding = false
): RemoteFunctionResult {
  const document = parse(body, { parseTagValue: false, trimValues: true, htmlEntities: true })
  const rawDocument = preserveTableReaderPadding
    ? parse(body, { parseTagValue: false, trimValues: false, htmlEntities: true })
    : document
  const faultMessage = findXmlValue(document, "faultstring")
  if (faultMessage !== undefined) {
    return {
      outputs: {},
      fault: {
        code: findXmlValue(document, "faultcode") ?? "",
        name: findXmlValue(document, "Name") ?? "",
        message: faultMessage
      }
    }
  }
  return {
    outputs: Object.fromEntries(
      outputParameters.map((parameter) => {
        if (parameter.kind === "scalar") {
          return [parameter.name, findXmlValue(document, parameter.name) ?? ""]
        }
        if (parameter.kind === "structure") {
          return [
            parameter.name,
            filterRemoteRecord(findXmlRecord(document, parameter.name), parameter.fields ?? [])
          ]
        }
        return [
          parameter.name,
          findXmlRows(
            preserveTableReaderPadding && parameter.name === "DATA" ? rawDocument : document,
            parameter.name
          ).map((row) => filterRemoteRecord(row, parameter.fields ?? []))
        ]
      })
    )
  }
}

function validatedRemoteRecord(record: SapStructureRow): SapStructureRow {
  return Object.fromEntries(
    Object.entries(record).map(([name, value]) => {
      validateRemoteXmlName(name, "field")
      return [name, value]
    })
  )
}

function validateRemoteXmlName(name: string, kind: string): void {
  if (!/^[A-Z][A-Z0-9_]{0,29}$/.test(name)) {
    throw new Error(`Invalid remote function ${kind} name: ${name}`)
  }
}

function filterRemoteRecord(record: SapStructureRow, fields: string[]): SapStructureRow {
  return Object.fromEntries(fields.map((name) => [name, record[name] ?? ""]))
}

export function buildSapRepositoryEnvelope(request: SapRepositoryRequest): string {
  const source =
    request.operation === "UPSERT_SCREEN"
      ? serializeScreenPayload(request)
      : request.operation === "PATCH_SCREEN"
        ? serializeScreenPatchPayload(request)
        : request.operation === "PATCH_GUI_DEFINITION"
          ? serializeGuiDefinitionPayload(request)
          : request.operation === "ADD_OBJECTS_TO_TRANSPORT"
            ? serializeTransportObjectPayload(request)
            : (request.source ?? [])
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soapenv:Body>` +
    `<n1:Z_ORVANTA_MCP_DYNPRO_API xmlns:n1="urn:sap-com:document:sap:rfc:functions">` +
    xmlElement("IV_OPERATION", request.operation) +
    xmlElement("IV_OBJECT_TYPE", request.objectType ?? "") +
    xmlElement("IV_OBJECT_NAME", request.objectName ?? "") +
    xmlElement("IV_PROGRAM", request.program ?? "") +
    xmlElement("IV_SCREEN", request.screen ?? "") +
    xmlElement("IV_TRANSACTION", request.transaction ?? "") +
    xmlElement("IV_DESCRIPTION", request.description ?? "") +
    xmlElement("IV_PACKAGE", request.packageName ?? "") +
    xmlElement("IV_REQUEST", request.transportNumber ?? "") +
    xmlElement("IV_EXPECTED_VERSION", request.expectedVersion ?? "") +
    optionalRepositorySelectors(request) +
    xmlRecord("IS_HEADER", request.header ?? {}) +
    `<CT_FIELDS></CT_FIELDS>` +
    `<CT_FLOWLOGIC></CT_FLOWLOGIC>` +
    `<CT_PARAMS></CT_PARAMS>` +
    xmlTable(
      "IT_SOURCE",
      source.map((LINE) => ({ LINE }))
    ) +
    `<ET_TCODES></ET_TCODES>` +
    `<ET_GUI_ATTRIBUTES></ET_GUI_ATTRIBUTES>` +
    `</n1:Z_ORVANTA_MCP_DYNPRO_API>` +
    `</soapenv:Body>` +
    `</soapenv:Envelope>`
  )
}

/**
 * D7 selectors, emitted only when the request actually carries them.
 *
 * The shared repository body serves every operation through one function module, so a helper
 * deployed before the 2.8 interface would be handed an element it does not declare even on an
 * unrelated operation such as READ_SCREEN. An absent selector therefore leaves the SOAP request
 * unchanged instead of travelling as an empty element.
 */
function optionalRepositorySelectors(request: SapRepositoryRequest): string {
  const selectors: ReadonlyArray<readonly [string, string | undefined]> = [
    ["IV_TEXT_STATUS", request.textStatus],
    ["IV_TEXT_LANGUAGE", request.textLanguage],
    ["IV_TEXT_VERSION", request.textVersion],
    ["IV_INCLUDE_SOURCE", request.includeSource ? "X" : undefined],
    ["IV_STYLE_MODE", request.styleMode],
    ["IV_STYLE_ACTIVE", request.styleActive],
    ["IV_STYLE_VARIANT", request.styleVariant],
    ["IV_INCLUDE_CSS", request.includeCss ? "X" : undefined],
    ["IV_REQUEST_TYPE", request.requestType],
    ["IV_REQUEST_TEXT", request.requestText],
    ["IV_REQUEST_OWNER", request.requestOwner],
    ["IV_REQUEST_TARGET", request.requestTarget],
    ["IV_REQUEST_ALLOW_DUPLICATE", request.requestAllowDuplicate ? "X" : undefined],
    ["IV_ADD_REQUEST", request.addRequest]
  ]
  return selectors
    .filter((selector): selector is readonly [string, string] => selector[1] !== undefined)
    .map(([name, value]) => xmlElement(name, value))
    .join("")
}

/**
 * The flat CTS object rows travel as `O|<index>|<PROPERTY>|<value>` payload lines, the same channel
 * UPSERT_SCREEN uses for its dynpro rows. Only the four properties the helper accepts are emitted, so
 * a caller cannot smuggle audit fields such as AUTHOR or DEVCLASS into the SAP object entry.
 */
function serializeTransportObjectPayload(request: SapRepositoryRequest): string[] {
  const rows = request.transportObjects ?? []
  if (rows.length === 0) throw new Error("ADD_OBJECTS_TO_TRANSPORT requires at least one object")
  const payload: string[] = []
  rows.forEach((row, rowIndex) => {
    Object.entries(row).forEach(([name, value]) => {
      if (/\r|\n/.test(value)) {
        throw new Error("Transport object payload values must not contain line breaks")
      }
      const escapedValue = value.replaceAll("%", "%25").replaceAll("|", "%7C")
      const line = `O|${rowIndex + 1}|${name.toUpperCase()}|${escapedValue}`
      if (line.length > 255) {
        throw new Error("Transport object payload line exceeds ABAPTXT255")
      }
      payload.push(line)
    })
  })
  return payload
}

function serializeGuiDefinitionPayload(request: SapRepositoryRequest): string[] {
  const definition = request.guiDefinition
  if (!definition) throw new Error("PATCH_GUI_DEFINITION requires a complete GUI definition")
  const payload: string[] = []
  const append = (kind: string, index: number, name: string, value: string) => {
    if (/\r|\n/.test(value)) throw new Error("GUI definition values must not contain line breaks")
    const escapedValue = value.replaceAll("%", "%25").replaceAll("|", "%7C")
    const line = `${kind}|${index}|${name.toUpperCase()}|${escapedValue}`
    if (line.length > 255) throw new Error("GUI definition payload line exceeds ABAPTXT255")
    payload.push(line)
  }
  append("M", 1, "EXPECTED_VERSION", definition.expectedVersion)
  Object.entries(definition.admin).forEach(([name, value]) => append("ADM", 1, name, value))
  Object.entries(definition.sections).forEach(([kind, rows]) =>
    rows.forEach((row, index) =>
      Object.entries(row).forEach(([name, value]) => append(kind, index + 1, name, value))
    )
  )
  return payload
}

function serializeScreenPayload(request: SapRepositoryRequest): string[] {
  const payload: string[] = []
  const appendRows = (kind: "F" | "L" | "P", rows: SapStructureRow[]) => {
    rows.forEach((row, rowIndex) => {
      Object.entries(row).forEach(([name, value]) => {
        if (/\r|\n/.test(value)) {
          throw new Error(`Dynpro ${kind} payload values must not contain line breaks`)
        }
        const escapedValue = value.replaceAll("%", "%25").replaceAll("|", "%7C")
        const line = `${kind}|${rowIndex + 1}|${name.toUpperCase()}|${escapedValue}`
        if (line.length > 255) {
          throw new Error(`Dynpro ${kind} payload line exceeds ABAPTXT255`)
        }
        payload.push(line)
      })
    })
  }

  appendRows("F", request.fields ?? [])
  appendRows("L", request.flowLogic ?? [])
  appendRows("P", request.params ?? [])
  return payload
}

function serializeScreenPatchPayload(request: SapRepositoryRequest): string[] {
  const payload: string[] = []
  const append = (kind: string, index: number, name: string, value: string) => {
    if (/\r|\n/.test(value)) throw new Error("Dynpro patch values must not contain line breaks")
    const escapedValue = value.replaceAll("%", "%25").replaceAll("|", "%7C")
    const line = `${kind}|${index}|${name.toUpperCase()}|${escapedValue}`
    if (line.length > 255) throw new Error("Dynpro patch payload line exceeds ABAPTXT255")
    payload.push(line)
  }
  request.componentOperations?.forEach((operation, index) => {
    append("O", index + 1, "OP", operation.operation)
    append("O", index + 1, "NAME", operation.name)
    Object.entries(operation.definition ?? {}).forEach(([name, value]) =>
      append("O", index + 1, `FIELD_${name}`, value)
    )
  })
  if (request.description !== undefined) append("M", 1, "DESCRIPTION_PATCH", "X")
  if (request.header !== undefined) {
    append("M", 1, "HEADER_PATCH", "X")
    Object.entries(request.header).forEach(([name, value]) => append("H", 1, name, value))
  }
  if (request.flowLogic !== undefined) {
    append("M", 1, "FLOW_REPLACE", "X")
    request.flowLogic.forEach((row, index) => append("L", index + 1, "LINE", row.LINE ?? ""))
  }
  if (request.params !== undefined) {
    append("M", 1, "PARAMS_REPLACE", "X")
    request.params.forEach((row, index) =>
      Object.entries(row).forEach(([name, value]) => append("P", index + 1, name, value))
    )
  }
  return payload
}

export function parseSapRepositoryResponse(body: string): SapRepositoryResult {
  const document = parse(body, { parseTagValue: false, trimValues: true, htmlEntities: true })
  const fault = findXmlValue(document, "faultstring")
  if (fault) throw new Error(`SAP SOAP fault: ${fault}`)
  const result: SapRepositoryResult = {
    status: findXmlValue(document, "EV_STATUS") ?? "",
    code: findXmlValue(document, "EV_CODE") ?? "",
    message: findXmlValue(document, "EV_MESSAGE") ?? "",
    version: findXmlValue(document, "EV_VERSION") ?? "",
    header: findXmlRecord(document, "ES_HEADER"),
    dynproText: findXmlValue(document, "EV_DYNPROTEXT") ?? "",
    fields: findXmlRows(document, "CT_FIELDS"),
    flowLogic: findXmlRows(document, "CT_FLOWLOGIC"),
    params: findXmlRows(document, "CT_PARAMS"),
    transactions: findXmlRows(document, "ET_TCODES"),
    guiAttributes: findXmlRows(document, "ET_GUI_ATTRIBUTES"),
    source: findXmlRows(document, "IT_SOURCE").map((row) => row.LINE ?? "")
  }
  if (!result.status || !result.code || !result.version) {
    throw new Error("SAP repository helper returned an incomplete SOAP response")
  }
  return result
}

export function buildSapDdicEnvelope(request: SapDdicRequest): string {
  const source = serializeDdicPayload(request)
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soapenv:Body>` +
    `<n1:Z_ORVANTA_MCP_DDIC_API xmlns:n1="urn:sap-com:document:sap:rfc:functions">` +
    xmlElement("IV_OPERATION", request.operation) +
    xmlElement("IV_OBJECT_TYPE", "") +
    xmlElement("IV_OBJECT_NAME", request.objectName) +
    xmlElement("IV_PROGRAM", "") +
    xmlElement("IV_SCREEN", "") +
    xmlElement("IV_TRANSACTION", "") +
    xmlElement("IV_DESCRIPTION", request.description ?? "") +
    xmlElement("IV_PACKAGE", request.packageName ?? "") +
    xmlElement("IV_REQUEST", request.transportNumber ?? "") +
    xmlElement("IV_EXPECTED_VERSION", request.expectedVersion ?? "") +
    `<IS_HEADER></IS_HEADER>` +
    `<CT_FIELDS></CT_FIELDS>` +
    `<CT_FLOWLOGIC></CT_FLOWLOGIC>` +
    `<CT_PARAMS></CT_PARAMS>` +
    xmlTable(
      "IT_SOURCE",
      source.map((LINE) => ({ LINE }))
    ) +
    `<ET_TCODES></ET_TCODES>` +
    `<ET_GUI_ATTRIBUTES></ET_GUI_ATTRIBUTES>` +
    `</n1:Z_ORVANTA_MCP_DDIC_API>` +
    `</soapenv:Body>` +
    `</soapenv:Envelope>`
  )
}

export function serializeDdicPayload(request: SapDdicRequest): string[] {
  const payload: string[] = []
  const appendRows = (
    kind: "H" | "V" | "F" | "S1" | "S2" | "S3" | "L1" | "L2" | "N1" | "T1" | "T2" | "A1",
    rows: SapStructureRow[]
  ) => {
    rows.forEach((row, rowIndex) => {
      Object.entries(row).forEach(([name, value]) => {
        if (/\r|\n/.test(value)) throw new Error("DDIC payload values must not contain line breaks")
        const escapedValue = value.replaceAll("%", "%25").replaceAll("|", "%7C")
        const line = `${kind}|${rowIndex + 1}|${name.toUpperCase()}|${escapedValue}`
        if (line.length > 255) throw new Error("DDIC payload line exceeds ABAPTXT255")
        payload.push(line)
      })
    })
  }
  if (request.header) appendRows("H", [request.header])
  appendRows("V", request.fixedValues ?? [])
  appendRows("F", request.fields ?? [])
  // Search help child rows. DD31V (S1) and DD33V (S3) exist only for a collective search help, so an
  // elementary one leaves those two arrays empty. DD32P (S2) also applies to an elementary search
  // help, so a non-empty parameters array is normal for either kind.
  appendRows("S1", request.selectionMethods ?? [])
  appendRows("S2", request.parameters ?? [])
  appendRows("S3", request.fieldAssignments ?? [])
  // Lock object child rows. DD26V carries the locked tables (L1) and DD27P the locked fields (L2).
  // Both are two-character kinds, for the same reason as S1/S2/S3.
  appendRows("L1", request.lockTables ?? [])
  appendRows("L2", request.lockFields ?? [])
  // Number range object texts. TNROT carries the per-language long and short text (N1). The helper
  // requires contiguous, ascending row indexes, which is exactly what appendRows emits.
  appendRows("N1", request.numberRangeTexts ?? [])
  // Maintenance view rows. DD26V carries the base tables (T1) and DD27P the view fields (T2). Only
  // the caller-controlled columns travel: the helper writes VIEWNAME, TABPOS/OBJPOS and DDLANGUAGE
  // itself, and DD28V selection conditions are read-only for this service (T3 never appears here).
  appendRows("T1", request.baseTables ?? [])
  appendRows("T2", request.viewFields ?? [])
  // Append structure field rows (A1). They are written to the append structure itself; the helper
  // then activates the base table, which expands them into it. A two-character kind like S1/T1/N1.
  appendRows("A1", request.appendFields ?? [])
  return payload
}

export function parseSapDdicResponse(body: string): SapDdicResult {
  const document = parse(body, { parseTagValue: false, trimValues: true })
  const fault = findXmlValue(document, "faultstring")
  if (fault) throw new Error(`SAP SOAP fault: ${fault}`)
  const payload = parseDdicPayload(findXmlRows(document, "IT_SOURCE").map((row) => row.LINE ?? ""))
  const result: SapDdicResult = {
    status: findXmlValue(document, "EV_STATUS") ?? "",
    code: findXmlValue(document, "EV_CODE") ?? "",
    message: findXmlValue(document, "EV_MESSAGE") ?? "",
    version: findXmlValue(document, "EV_VERSION") ?? "",
    metadata: payload.metadata,
    packageName: payload.metadata.PACKAGE ?? "",
    objectVersion: payload.metadata.VERSION ?? "",
    recordedRequest: payload.metadata.REQUEST ?? "",
    header: payload.header,
    fixedValues: payload.fixedValues,
    fields: payload.fields,
    selectionMethods: payload.selectionMethods,
    parameters: payload.parameters,
    fieldAssignments: payload.fieldAssignments,
    lockTables: payload.lockTables,
    lockFields: payload.lockFields,
    numberRangeTexts: payload.numberRangeTexts,
    baseTables: payload.baseTables,
    viewFields: payload.viewFields,
    selectionConditions: payload.selectionConditions,
    warnings: payload.warnings
  }
  if (!result.status || !result.code || !result.version) {
    throw new Error("SAP DDIC helper returned an incomplete SOAP response")
  }
  return result
}

function parseDdicPayload(lines: string[]): {
  metadata: SapStructureRow
  header: SapStructureRow
  fixedValues: SapStructureRow[]
  fields: SapStructureRow[]
  selectionMethods: SapStructureRow[]
  parameters: SapStructureRow[]
  fieldAssignments: SapStructureRow[]
  lockTables: SapStructureRow[]
  lockFields: SapStructureRow[]
  numberRangeTexts: SapStructureRow[]
  baseTables: SapStructureRow[]
  viewFields: SapStructureRow[]
  selectionConditions: SapStructureRow[]
  warnings: SapStructureRow[]
} {
  const metadata: SapStructureRow = {}
  const header: SapStructureRow = {}
  const fixedValues: SapStructureRow[] = []
  const fields: SapStructureRow[] = []
  const selectionMethods: SapStructureRow[] = []
  const parameters: SapStructureRow[] = []
  const fieldAssignments: SapStructureRow[] = []
  const lockTables: SapStructureRow[] = []
  const lockFields: SapStructureRow[] = []
  const numberRangeTexts: SapStructureRow[] = []
  const baseTables: SapStructureRow[] = []
  const viewFields: SapStructureRow[] = []
  const selectionConditions: SapStructureRow[] = []
  const warnings: SapStructureRow[] = []
  for (const line of lines) {
    // S1/S2/S3 (search help), L1/L2 (lock object), N1 (number range object text) and T1/T2/T3
    // (maintenance view base tables / view fields / selection conditions) are two-character kinds,
    // so the kind alternation must be explicit.
    const match = line.match(/^(M|H|V|F|S1|S2|S3|L1|L2|N1|T1|T2|T3|W)\|(\d+)\|([A-Z0-9_]+)\|(.*)$/)
    if (!match?.[1] || !match[2] || !match[3]) {
      throw new Error(`SAP DDIC helper returned an invalid payload line: ${line}`)
    }
    const index = Number.parseInt(match[2], 10)
    if (index < 1) throw new Error(`SAP DDIC helper returned an invalid payload index: ${line}`)
    const value = (match[4] ?? "").replaceAll("%7C", "|").replaceAll("%25", "%")
    const kind = match[1]
    let target: SapStructureRow
    if (kind === "M") target = metadata
    else if (kind === "H") target = header
    else if (kind === "V") target = rowAt(fixedValues, index)
    else if (kind === "F") target = rowAt(fields, index)
    else if (kind === "S1") target = rowAt(selectionMethods, index)
    else if (kind === "S2") target = rowAt(parameters, index)
    else if (kind === "S3") target = rowAt(fieldAssignments, index)
    else if (kind === "L1") target = rowAt(lockTables, index)
    else if (kind === "L2") target = rowAt(lockFields, index)
    else if (kind === "T1") target = rowAt(baseTables, index)
    else if (kind === "T2") target = rowAt(viewFields, index)
    else if (kind === "T3") target = rowAt(selectionConditions, index)
    else target = rowAt(numberRangeTexts, index)
    target[match[3]] = value
  }
  // The inactive-definition path of the helper publishes the same object attributes under M that the
  // active path publishes under H (there they describe the version being read rather than the active
  // one), so M is a fallback source for H. H wins when both carry a key: an active read is
  // authoritative about the active version. Without this, an inactive read returned an empty
  // description/tableClass while SAP's own DD02L row carried TRANSP.
  for (const [key, value] of Object.entries(metadata)) {
    if (header[key] === undefined) header[key] = value
  }
  return {
    metadata,
    header,
    fixedValues,
    fields,
    selectionMethods,
    parameters,
    fieldAssignments,
    lockTables,
    lockFields,
    numberRangeTexts,
    baseTables,
    viewFields,
    selectionConditions,
    warnings
  }
}

function rowAt(rows: SapStructureRow[], index: number): SapStructureRow {
  while (rows.length < index) rows.push({})
  return rows[index - 1]!
}

/**
 * `CAPABILITIES` is served per helper endpoint, so the probe dispatches by the ABAP function
 * module name. `Z_ORVANTA_MCP_EXECUTE` and `Z_ORVANTA_MCP_DYNPRO_API` share the same generated
 * ABAP body; `Z_ORVANTA_MCP_DDIC_API` implements the opcode in a later delivery and currently
 * answers `OPERATION_NOT_SUPPORTED`, which degrades to `operation-scoped`.
 *
 * `Z_ORVANTA_MAINT_READ`, `Z_ORVANTA_OPS_READ` and `Z_ORVANTA_LOG_READ` own no source table and no
 * `EV_STATUS`/`EV_CODE`/`EV_VERSION` export: their only reply channel is the `EV_RESULT` JSON
 * string, so the same rows travel as its `payload` array (protocol design revision R3). They are
 * therefore asked through `callRemoteFunction`, the same client path their business reads use.
 * `Z_ORVANTA_LOG_READ` answers before its `CLEAR ev_result.` and is dispatched by the same
 * `IV_ACTION` input, so the probe shape is identical to the other two JSON helpers.
 *
 * `Z_ORVANTA_MCP_SCI_V2`/`_E2` are the same shape (design revision R6): they own no source table,
 * so their rows also travel as the `payload` array of one `EV_RESULT` JSON envelope and they are
 * asked through `callRemoteFunction`. A SCI helper that does not carry the R6 body yet exports no
 * `EV_RESULT`, answers `ev_status = 'E'`/`ev_code = 'INVALID_ACTION'` and is read back as an empty
 * string, which degrades to `operation-scoped` exactly like the other JSON helpers.
 */
/**
 * Operation codes an un-upgraded helper uses to refuse the `CAPABILITIES` opcode.
 *
 * `OPERATION_NOT_SUPPORTED` is the documented contract, but it is not the only one. The SCI
 * helpers reject an unknown action with `INVALID_ACTION` before any business validation, and an
 * older `Z_ORVANTA_LOG_READ` answers `READ_ONLY_UNSUPPORTED`. Every one of them means "this
 * deployed helper does not implement the opcode", never "the helper is missing", so they share
 * one degradation to `operation-scoped`. Classifying `INVALID_ACTION` as an unreadable reply
 * instead would attach a misleading "reported status E" note to a perfectly normal old helper,
 * and a fault carrying it would be reported as `absent`, i.e. as a helper that is not deployed.
 */
const UNIMPLEMENTED_OPCODE_CODE = /NOT_SUPPORTED|UNSUPPORTED|UNKNOWN_OPERATION|INVALID_ACTION/i

const HELPER_CAPABILITIES_CHANNELS: Record<
  string,
  { reply: "xml-rows"; soapAction: string; envelope: () => string } | { reply: "json-envelope" }
> = {
  Z_ORVANTA_MCP_EXECUTE: {
    reply: "xml-rows",
    soapAction: "http://www.sap.com/Z_ORVANTA_MCP_EXECUTE",
    envelope: () => buildSapHelperEnvelope({ operation: "CAPABILITIES" })
  },
  Z_ORVANTA_MCP_DYNPRO_API: {
    reply: "xml-rows",
    soapAction: "http://www.sap.com/Z_ORVANTA_MCP_DYNPRO_API",
    envelope: () => buildSapRepositoryEnvelope({ operation: "CAPABILITIES" })
  },
  Z_ORVANTA_MCP_DDIC_API: {
    reply: "xml-rows",
    soapAction: "http://www.sap.com/Z_ORVANTA_MCP_DDIC_API",
    envelope: () => buildSapDdicEnvelope({ operation: "CAPABILITIES", objectName: "" })
  },
  Z_ORVANTA_MAINT_READ: { reply: "json-envelope" },
  Z_ORVANTA_OPS_READ: { reply: "json-envelope" },
  Z_ORVANTA_LOG_READ: { reply: "json-envelope" },
  Z_ORVANTA_MCP_SCI_V2: { reply: "json-envelope" },
  Z_ORVANTA_MCP_SCI_E2: { reply: "json-envelope" }
}

export interface SapHelperCapabilitiesPayload {
  helper: string | null
  minProtocol: string | null
  maxProtocol: string | null
  operations: Array<{ opcode: string; since: string; write: boolean }>
  scopes: Array<{ scope: string; enabled: boolean }>
  sourceHash: string | null
  packageName: string | null
  transport: string | null
  transportTask: string | null
  host: string | null
  runtimeTime: string | null
  runtimeTimeZone: string | null
}

export function parseHelperCapabilitiesResponse(body: string): {
  status: string
  code: string
  message: string
  version: string
  payload: string[]
} {
  const document = parse(body, { parseTagValue: false, trimValues: true })
  const fault = findXmlValue(document, "faultstring")
  if (fault) throw new Error(`SAP SOAP fault: ${fault}`)
  return {
    status: (findXmlValue(document, "EV_STATUS") ?? "").trim().toUpperCase(),
    code: (findXmlValue(document, "EV_CODE") ?? "").trim(),
    message: findXmlValue(document, "EV_MESSAGE") ?? "",
    version: findXmlValue(document, "EV_VERSION") ?? "",
    payload: findXmlRows(document, "IT_SOURCE").map((row) => row.LINE ?? "")
  }
}

/**
 * Parse the frozen `CAPABILITIES` payload: one `KIND|...` line per fact, `|` separated with
 * `%`->`%25` and `|`->`%7C` escaping. Unknown or malformed lines are ignored so a newer
 * helper can add facts without breaking an older service. A `HELPER|` identity mismatch is
 * reported by the caller, not here.
 */
export function parseHelperCapabilitiesPayload(
  lines: readonly string[]
): SapHelperCapabilitiesPayload {
  const payload: SapHelperCapabilitiesPayload = {
    helper: null,
    minProtocol: null,
    maxProtocol: null,
    operations: [],
    scopes: [],
    sourceHash: null,
    packageName: null,
    transport: null,
    transportTask: null,
    host: null,
    runtimeTime: null,
    runtimeTimeZone: null
  }
  for (const rawLine of lines) {
    const fields = rawLine
      .trim()
      .split("|")
      .map((field) => field.trim().replaceAll("%7C", "|").replaceAll("%25", "%"))
    const kind = fields[0]?.toUpperCase()
    if (kind === "HELPER" && fields[1]) payload.helper = fields[1]
    else if (kind === "PROTOCOL" && fields[1]?.toUpperCase() === "MIN")
      payload.minProtocol = fields[2] ?? null
    else if (kind === "PROTOCOL" && fields[1]?.toUpperCase() === "MAX")
      payload.maxProtocol = fields[2] ?? null
    else if (kind === "OPERATION" && fields[1])
      payload.operations.push({
        opcode: fields[1],
        since: fields[2] ?? "",
        write: fields[3]?.toUpperCase() === "W"
      })
    else if (kind === "SCOPE" && fields[1])
      payload.scopes.push({ scope: fields[1], enabled: fields[2]?.toLowerCase() === "enabled" })
    else if (kind === "SOURCE" && fields[1]?.toUpperCase() === "HASH")
      payload.sourceHash = fields[2] ?? null
    else if (kind === "SOURCE" && fields[1]?.toUpperCase() === "PACKAGE")
      payload.packageName = fields[2] ?? null
    else if (kind === "SOURCE" && fields[1]?.toUpperCase() === "TRANSPORT") {
      payload.transport = fields[2] ?? null
      payload.transportTask = fields[3] ?? null
    } else if (kind === "RUNTIME" && fields[1]?.toUpperCase() === "HOST")
      payload.host = fields[2] ?? null
    else if (kind === "RUNTIME" && fields[1]?.toUpperCase() === "TIME") {
      payload.runtimeTime = fields[2] ?? null
      payload.runtimeTimeZone = fields[3] ?? null
    }
  }
  return payload
}

/**
 * A helper whose only reply channel is the `EV_RESULT` JSON string either described itself, does
 * not implement the opcode, or answered something this service must not read as a capability
 * claim. `detail` is present only for the third case, so a capability report can explain a
 * refused self-description without turning it into evidence.
 */
export type JsonHelperCapabilitiesReply =
  | { kind: "self-described"; payload: SapHelperCapabilitiesPayload }
  | { kind: "unsupported" }
  | { kind: "unusable"; detail: string }

const CAPABILITY_PROTOCOL_VERSION = /^\d+\.\d+$/
const CAPABILITY_OPCODE = /^[A-Z0-9_]+$/

function compareCapabilityProtocols(left: string, right: string): number {
  const [leftMajor = 0, leftMinor = 0] = left.split(".").map(Number)
  const [rightMajor = 0, rightMinor = 0] = right.split(".").map(Number)
  return leftMajor - rightMajor || leftMinor - rightMinor
}

/**
 * Decode the `EV_RESULT` JSON envelope of a helper that owns no `it_source` table
 * (`Z_ORVANTA_MAINT_READ`, `Z_ORVANTA_OPS_READ`; protocol design revision R3).
 *
 * The rows are read with the shared `parseHelperCapabilitiesPayload`, but unlike the XML path
 * the payload is then checked as a whole before any of it is trusted: a self-description that
 * omits its identity, declares an unparseable protocol, declares MIN above MAX, or lists an
 * operation outside the declared protocol range (or a malformed/duplicated operation row) is
 * refused instead of being partially believed. Unknown row kinds stay forward compatible and
 * are ignored, exactly like in the XML path.
 */
export function decodeJsonHelperCapabilitiesReply(
  raw: string,
  expectedHelper: string
): JsonHelperCapabilitiesReply {
  let document: unknown
  try {
    document = JSON.parse(raw)
  } catch {
    return { kind: "unusable", detail: "CAPABILITIES reply is not a JSON envelope" }
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return { kind: "unusable", detail: "CAPABILITIES reply is not a JSON object" }
  }
  const envelope = document as Record<string, unknown>
  const status = typeof envelope.status === "string" ? envelope.status.trim().toUpperCase() : ""
  const code = typeof envelope.code === "string" ? envelope.code.trim().toUpperCase() : ""
  if (status === "E" || UNIMPLEMENTED_OPCODE_CODE.test(code)) {
    return { kind: "unsupported" }
  }
  if (status !== "S" || code !== "CAPABILITIES") {
    return {
      kind: "unusable",
      detail: `CAPABILITIES reply reported status ${status || "EMPTY"} and code ${code || "EMPTY"}`
    }
  }
  const rows = envelope.payload
  if (!Array.isArray(rows) || rows.length === 0 || rows.some((row) => typeof row !== "string")) {
    return { kind: "unusable", detail: "CAPABILITIES reply carried no payload row array" }
  }
  const lines = rows as string[]
  const payload = parseHelperCapabilitiesPayload(lines)
  const declared = payload.helper?.trim().toUpperCase()
  if (declared !== expectedHelper) {
    return {
      kind: "unusable",
      detail: declared
        ? `Self-description declared helper ${declared} instead of ${expectedHelper}; ignored`
        : "Self-description omitted the HELPER identity line; ignored"
    }
  }
  if (
    !payload.minProtocol ||
    !payload.maxProtocol ||
    !CAPABILITY_PROTOCOL_VERSION.test(payload.minProtocol) ||
    !CAPABILITY_PROTOCOL_VERSION.test(payload.maxProtocol)
  ) {
    return {
      kind: "unusable",
      detail: `Self-description declared an unparseable protocol range ${payload.minProtocol ?? "EMPTY"}..${payload.maxProtocol ?? "EMPTY"}; ignored`
    }
  }
  if (compareCapabilityProtocols(payload.minProtocol, payload.maxProtocol) > 0) {
    return {
      kind: "unusable",
      detail: `Self-description declared PROTOCOL|MIN ${payload.minProtocol} above PROTOCOL|MAX ${payload.maxProtocol}; ignored`
    }
  }
  const opcodes = new Set<string>()
  for (const line of lines) {
    const fields = line.trim().split("|")
    if (fields[0]?.trim().toUpperCase() !== "OPERATION") continue
    const opcode = (fields[1] ?? "").trim().toUpperCase()
    const since = (fields[2] ?? "").trim()
    const mode = (fields[3] ?? "").trim().toUpperCase()
    if (
      fields.length !== 4 ||
      !CAPABILITY_OPCODE.test(opcode) ||
      !CAPABILITY_PROTOCOL_VERSION.test(since) ||
      (mode !== "R" && mode !== "W")
    ) {
      return {
        kind: "unusable",
        detail: `Self-description carried a malformed OPERATION row ${line.trim()}; ignored`
      }
    }
    if (opcodes.has(opcode)) {
      return {
        kind: "unusable",
        detail: `Self-description listed operation ${opcode} twice; ignored`
      }
    }
    opcodes.add(opcode)
    if (
      compareCapabilityProtocols(since, payload.minProtocol) < 0 ||
      compareCapabilityProtocols(since, payload.maxProtocol) > 0
    ) {
      return {
        kind: "unusable",
        detail: `Self-description listed operation ${opcode} since ${since} outside its declared protocol range ${payload.minProtocol}..${payload.maxProtocol}; ignored`
      }
    }
  }
  return { kind: "self-described", payload }
}

/**
 * Turn one `EV_RESULT` JSON reply into an attestation. This never throws: an unreachable helper
 * is `absent`, and a reachable helper that does not implement the opcode (an un-upgraded
 * maintenance/operational-log body answers an empty `EV_RESULT`) is `operation-scoped`, so a
 * capability report degrades instead of failing.
 */
function jsonHelperCapabilitiesAttestation(
  response: RemoteFunctionResult,
  probed: string,
  observedAt: string
): SapHelperCapabilities {
  if (response.fault) {
    const fault = scrubHelperDetail(
      `${response.fault.name || response.fault.code}: ${response.fault.message}`
    )
    return UNIMPLEMENTED_OPCODE_CODE.test(fault)
      ? emptyHelperCapabilities(probed, observedAt, "operation-scoped")
      : emptyHelperCapabilities(probed, observedAt, "absent", fault)
  }
  const raw = response.outputs.EV_RESULT
  if (typeof raw !== "string" || raw.trim() === "") {
    return emptyHelperCapabilities(probed, observedAt, "operation-scoped")
  }
  if (Buffer.byteLength(raw, "utf8") > 1024 * 1024) {
    return emptyHelperCapabilities(
      probed,
      observedAt,
      "operation-scoped",
      "CAPABILITIES reply exceeded 1 MiB"
    )
  }
  const decoded = decodeJsonHelperCapabilitiesReply(raw, probed)
  if (decoded.kind === "unsupported")
    return emptyHelperCapabilities(probed, observedAt, "operation-scoped")
  if (decoded.kind === "unusable") {
    return emptyHelperCapabilities(probed, observedAt, "operation-scoped", decoded.detail)
  }
  return {
    helper: probed,
    minProtocol: decoded.payload.minProtocol,
    maxProtocol: decoded.payload.maxProtocol,
    operations: decoded.payload.operations,
    scopes: decoded.payload.scopes,
    sourceHash: decoded.payload.sourceHash,
    packageName: decoded.payload.packageName,
    transport: decoded.payload.transport,
    host: decoded.payload.host,
    observedAt,
    attestation: "self-described"
  }
}

function emptyHelperCapabilities(
  helper: string,
  observedAt: string,
  attestation: SapHelperCapabilities["attestation"],
  detail?: string
): SapHelperCapabilities {
  return {
    helper,
    minProtocol: null,
    maxProtocol: null,
    operations: [],
    scopes: [],
    sourceHash: null,
    packageName: null,
    transport: null,
    host: null,
    observedAt,
    attestation,
    ...(detail ? { detail } : {})
  }
}

function scrubHelperDetail(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, "$1[REDACTED]@")
    .replace(/\b(password|token|cookie|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 200)
}

function xmlElement(name: string, value: string): string {
  return `<${name}>${encodeXml(value)}</${name}>`
}

function xmlRecord(name: string, record: Record<string, string>): string {
  const fields = Object.entries(record)
    .map(([key, value]) => xmlElement(key.toUpperCase(), value))
    .join("")
  return `<${name}>${fields}</${name}>`
}

function xmlTable(name: string, rows: Array<Record<string, string>>): string {
  return `<${name}>${rows.map((row) => xmlRecord("item", row)).join("")}</${name}>`
}

function findXmlRecord(value: unknown, localName: string): Record<string, string> {
  const node = findXmlNode(value, localName)
  return xmlNodeToRecord(node)
}

function findXmlRows(value: unknown, localName: string): Array<Record<string, string>> {
  const node = findXmlNode(value, localName)
  if (!node || typeof node !== "object") return []
  const item = Object.entries(node).find(
    ([key]) => key.split(":").at(-1)?.toUpperCase() === "ITEM"
  )?.[1]
  return (Array.isArray(item) ? item : item ? [item] : []).map(xmlNodeToRecord)
}

function findXmlNode(value: unknown, localName: string): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findXmlNode(item, localName)
      if (match !== undefined) return match
    }
    return undefined
  }
  if (!value || typeof value !== "object") return undefined
  for (const [key, child] of Object.entries(value)) {
    if (key.split(":").at(-1)?.toUpperCase() === localName.toUpperCase()) return child
    const match = findXmlNode(child, localName)
    if (match !== undefined) return match
  }
  return undefined
}

function xmlNodeToRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "#text")
      .map(([key, child]) => [
        key.split(":").at(-1)?.toUpperCase() ?? key.toUpperCase(),
        typeof child === "object" && child && "#text" in child
          ? String((child as { "#text": unknown })["#text"])
          : String(child ?? "")
      ])
  )
}

function findXmlValue(value: unknown, localName: string): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findXmlValue(item, localName)
      if (match !== undefined) return match
    }
    return undefined
  }
  if (!value || typeof value !== "object") return undefined
  for (const [key, child] of Object.entries(value)) {
    if (key.split(":").at(-1)?.toUpperCase() === localName.toUpperCase()) {
      if (typeof child === "string" || typeof child === "number") return String(child)
      if (child && typeof child === "object" && "#text" in child) {
        return String((child as { "#text": unknown })["#text"])
      }
    }
    const match = findXmlValue(child, localName)
    if (match !== undefined) return match
  }
  return undefined
}

function encodeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

async function postSapSoap(
  config: ConnectionConfig,
  soapAction: string,
  body: string,
  allowSoapFault = false,
  password?: string
): Promise<string> {
  if (!password) {
    throw new Error(`Password environment variable is not set: ${config.passwordEnv}`)
  }

  const endpoint = new URL("/sap/bc/soap/rfc", config.url)
  endpoint.searchParams.set("sap-client", config.client)
  endpoint.searchParams.set("sap-language", config.language)
  const request = endpoint.protocol === "https:" ? httpsRequest : httpRequest
  const authorization = Buffer.from(`${config.username}:${password}`, "utf8").toString("base64")

  return await new Promise<string>((resolve, reject) => {
    const outgoing = request(
      endpoint,
      {
        method: "POST",
        headers: {
          Accept: "text/xml",
          Authorization: `Basic ${authorization}`,
          "Content-Length": Buffer.byteLength(body, "utf8"),
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: soapAction
        },
        rejectUnauthorized: !config.allowUnauthorized
      },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on("data", (chunk: Buffer) => {
          size += chunk.length
          if (size > 10 * 1024 * 1024) {
            response.destroy(new Error("SAP SOAP response exceeded 10 MiB"))
            return
          }
          chunks.push(chunk)
        })
        response.on("error", reject)
        response.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf8")
          const status = response.statusCode ?? 0
          if (status < 200 || status >= 300) {
            if (allowSoapFault && /<(?:[\w-]+:)?Fault(?:\s|>)/i.test(responseBody)) {
              resolve(responseBody)
              return
            }
            const diagnostic = sanitizeDiagnosticBody(responseBody)
            reject(
              new Error(
                `SAP SOAP request returned HTTP ${status}${diagnostic ? `: ${diagnostic}` : ""}`
              )
            )
            return
          }
          resolve(responseBody)
        })
      }
    )
    outgoing.setTimeout(30_000, () => outgoing.destroy(new Error("SAP SOAP request timed out")))
    outgoing.on("error", reject)
    outgoing.end(body, "utf8")
  })
}

export function standaloneClientOptions(
  allowUnauthorized: boolean
): ReturnType<typeof createSSLConfig> {
  return {
    ...createSSLConfig(allowUnauthorized),
    headers: { "X-Requested-With": "XMLHttpRequest" }
  }
}

/**
 * ADT answered the object-structure request, but with no usable structure document.
 *
 * The version-history path needs that document twice: to resolve the object's name and version feed
 * link, and to derive the revision URL. When the body carries no root element the library's
 * `objectStructure` throws `Cannot read properties of undefined (reading 'adtcore:changedAt')`, which
 * is a client-side defect report masquerading as a server error. The 18:07 incident hit exactly that
 * on a transparent table whose only version was inactive: the caller saw an HTTP 500, could not tell
 * "no versions exist" from "this read is unavailable", and stopped before the pre-write checks it
 * still owed.
 *
 * This error carries the raw response facts so the tool can return a structured, actionable state
 * instead of a crash message.
 */
export class VersionHistoryUnavailableError extends Error {
  constructor(
    readonly code: string,
    readonly detail: {
      objectUri: string
      /** HTTP status of the structure request, when it completed. */
      httpStatus?: number
      contentType?: string
      bodyLength?: number
      bodyHead?: string
      cause: string
    }
  ) {
    super(
      `${code}: ADT returned no object structure document for ${detail.objectUri} ` +
        `(HTTP ${detail.httpStatus ?? "unknown"}, ${detail.bodyLength ?? "unknown"} bytes)`
    )
  }
}

/**
 * Turn a structure-document failure into `VersionHistoryUnavailableError`, reading the raw response
 * once for evidence. Never throws: an unreadable response only reduces the detail that is reported.
 */
async function describeUnavailableStructure(
  client: ADTClient,
  objectUri: string,
  error: unknown
): Promise<VersionHistoryUnavailableError> {
  let httpStatus: number | undefined
  let contentType: string | undefined
  let bodyLength: number | undefined
  let bodyHead: string | undefined
  try {
    const response = await client.httpClient.request(objectUri, {})
    httpStatus = response.status
    const header = response.headers?.["content-type"]
    contentType = header === undefined || header === null ? undefined : String(header)
    const body = String(response.body ?? "")
    bodyLength = body.length
    bodyHead = body.slice(0, 200)
  } catch (readError) {
    error = readError
  }
  // The library's parse already failed on this body, so classify what came back instead of guessing:
  // nothing at all, something that is not XML, or XML the parser could not root.
  const code =
    bodyLength === undefined
      ? "VERSION_HISTORY_STRUCTURE_UNREADABLE"
      : bodyLength === 0
        ? "VERSION_HISTORY_STRUCTURE_EMPTY"
        : /^\s*</.test(bodyHead ?? "")
          ? "VERSION_HISTORY_STRUCTURE_UNPARSEABLE"
          : "VERSION_HISTORY_STRUCTURE_NOT_XML"
  return new VersionHistoryUnavailableError(code, {
    objectUri,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(contentType === undefined ? {} : { contentType }),
    ...(bodyLength === undefined ? {} : { bodyLength }),
    ...(bodyHead === undefined ? {} : { bodyHead }),
    cause: errorText(error)
  })
}

/**
 * Pick a URI that can serve an ADT structure document.
 *
 * ADT search and object info return the repository-navigation URL
 * (`/sap/bc/adt/vit/wb/object_type/<kind>/object_name/<NAME>`) for DDIC objects. That URL is not a
 * structure resource: requesting it as one yields a body without a root element, which the library
 * then crashes on while reading `adtcore:changedAt`. The 18:07 incident hit this for a table, and a
 * control read proved the inactive state is not the cause - `DD02L` and an active Z table failed the
 * same way while a class worked. The canonical resource path comes from the type's creation path, so
 * use it whenever the resolved URI is only a navigation URL.
 */
export function structureUriFor(type: string, name: string, resolvedUri: string): string {
  if (!/\/sap\/bc\/adt\/vit\/wb\//i.test(resolvedUri)) return resolvedUri
  const canonical = objectPath(type as "DEVC/K", name)
  return canonical || resolvedUri
}

export async function loadRevisionObjectStructure(
  client: ADTClient,
  objectUri: string
): Promise<AbapObjectStructure> {
  try {
    return await client.objectStructure(objectUri)
  } catch (error) {
    // The library reads `adtcore:changedAt` off the root's attributes without checking that the
    // parse produced a root. Any TypeError from this call is that defect: report it as a structured
    // unavailable state with the raw response facts, never as an HTTP failure.
    if (error instanceof TypeError || error instanceof RangeError) {
      throw await describeUnavailableStructure(client, objectUri, error)
    }
    if (
      !/\/oo\/classes\//i.test(objectUri) ||
      !errorText(error).includes("No content handler found for content type")
    ) {
      throw error
    }

    let lastError: unknown = error
    for (const contentType of LEGACY_CLASS_CONTENT_TYPES) {
      const http = client.httpClient
      const legacyHttp = Object.create(http) as AdtHTTP
      legacyHttp.request = (url, options) =>
        http.request(url, {
          ...options,
          headers: { ...options?.headers, Accept: contentType }
        })
      try {
        return await loadObjectStructure(legacyHttp, objectUri)
      } catch (retryError) {
        if (retryError instanceof TypeError || retryError instanceof RangeError) {
          throw await describeUnavailableStructure(client, objectUri, retryError)
        }
        if (!errorText(retryError).includes("No content handler found for content type")) {
          throw retryError
        }
        lastError = retryError
      }
    }
    throw lastError
  }
}

export const SUPPORTED_CREATE_OBJECT_TYPES = [
  "CLAS/OC",
  "INTF/OI",
  "PROG/P",
  "PROG/I",
  "FUGR/F",
  "FUGR/FF",
  "FUGR/I",
  "DDLS/DF",
  "DCLS/DL"
] as const satisfies readonly CreatableTypeIds[]

type SupportedCreateObjectType = (typeof SUPPORTED_CREATE_OBJECT_TYPES)[number]

export interface PreparedCreateObjectRequest {
  connectionId: string
  objectType: SupportedCreateObjectType
  name: string
  objectName: string
  description: string
  packageName: string
  parentName: string
  transportNumber: string
  /** Initial source lines, already validated. Empty when the caller supplied none. */
  source: string[]
  objectUri: string
  workspaceUri: string
}

/**
 * Object types whose source can be seeded through the generic ADT source writer.
 *
 * `DDLS/DF` and `DCLS/DL` are excluded: their source is a DDL/DCL document with its own
 * serialisation, and `FUGR/F` has no source of its own (only its includes do). The remaining types
 * are all classic ABAP source containers whose initial text is exactly what the caller passes.
 */
const SOURCE_SEEDABLE_CREATE_OBJECT_TYPES: ReadonlySet<string> = new Set([
  "CLAS/OC",
  "INTF/OI",
  "PROG/P",
  "PROG/I",
  "FUGR/I",
  "FUGR/FF"
])

/** A single ABAP source line, as the ADT writer expects it. */
function initialSourceLines(objectName: string, source: unknown): string[] {
  if (source === undefined) return []
  if (!Array.isArray(source) || !source.every((line) => typeof line === "string")) {
    throw new Error("source must be an array of source lines")
  }
  if (!source.length) {
    throw new Error("source must contain at least one ABAP line when it is provided")
  }
  for (const line of source) {
    if (/[\r\n]/.test(line)) {
      throw new Error(
        "each source element must be a single line without embedded line breaks; pass one array element per line"
      )
    }
  }
  if (source.length > 100000) {
    throw new Error(`source has ${source.length} lines; the supported maximum is 100000`)
  }
  const totalLength = source.reduce((sum, line) => sum + line.length, 0)
  if (totalLength > 10_000_000) {
    throw new Error(`source is ${totalLength} characters; the supported maximum is 10000000`)
  }
  // A classic source container must carry its own identity statement, otherwise the read back after
  // activation cannot match the object SAP created and the create would report a false failure.
  const firstContentLine =
    source.find((line) => line.trim() && !line.trimStart().startsWith("*")) ?? ""
  if (!firstContentLine.trim()) {
    throw new Error(
      `source for ${objectName} contains no executable statement; refusing to seed a comment-only object`
    )
  }
  return [...source]
}

export function prepareCreateObjectRequest(
  connectionId: string,
  request: CreateObjectRequest
): PreparedCreateObjectRequest {
  const normalizedConnectionId = connectionId.trim().toLowerCase()
  const objectType = request.objectType.trim().toUpperCase()
  if (!SUPPORTED_CREATE_OBJECT_TYPES.includes(objectType as SupportedCreateObjectType)) {
    throw new Error(
      `Unsupported object type for standalone creation: ${request.objectType}. ` +
        `Supported types: ${SUPPORTED_CREATE_OBJECT_TYPES.join(", ")}.`
    )
  }
  const supportedType = objectType as SupportedCreateObjectType
  const type = CreatableTypes.get(supportedType)
  if (!type) throw new Error(`abap-adt-api does not support object type ${supportedType}`)

  const description = request.description.trim()
  if (!description || description.length > 60) {
    throw new Error("description must contain 1-60 characters")
  }

  const packageName = (request.packageName ?? "$TMP").trim().toUpperCase()
  if (packageName !== "$TMP") customerObjectName(packageName, "packageName", 30)

  const isFunctionChild = supportedType === "FUGR/FF" || supportedType === "FUGR/I"
  const parentName = isFunctionChild
    ? customerObjectName(request.parentName ?? "", "parentName", 26)
    : ""
  let name: string
  let objectName: string
  if (supportedType === "FUGR/I") {
    const suffix = request.name.trim().toUpperCase()
    if (!/^[A-Z][A-Z0-9_]{2}$/.test(suffix)) {
      throw new Error("FUGR/I name must be a three-character Include suffix such as TOP or F01")
    }
    objectName = `L${parentName}${suffix}`
    name = objectName
  } else {
    name = customerObjectName(request.name, "name", type.maxLen)
    objectName = name
  }

  const transportRequest = request.additionalOptions?.transportRequest
  if (transportRequest?.type === "new") {
    throw new Error(
      "Creating transport requests is not supported. Use $TMP or provide an existing transport request."
    )
  }
  const transportNumber = transportRequest?.number?.trim().toUpperCase() ?? ""
  if (transportRequest?.type === "existing" && !transportNumber) {
    throw new Error("An existing transport request requires a transport number")
  }
  if (transportNumber && !/^[A-Z0-9]{10}$/.test(transportNumber)) {
    throw new Error(`Invalid transport number: ${transportRequest?.number}`)
  }
  if (packageName === "$TMP" && transportNumber) {
    throw new Error("Local $TMP objects must not specify a transport request")
  }
  if (packageName !== "$TMP" && !transportNumber) {
    throw new Error(
      "A non-local package requires additionalOptions.transportRequest with type=existing and a transport number."
    )
  }

  const objectUri = objectPath(
    supportedType,
    name.toLowerCase(),
    (isFunctionChild ? parentName : "").toLowerCase()
  )
  if (!objectUri) throw new Error(`Could not determine the ADT URI for ${supportedType} ${name}`)

  const source = initialSourceLines(name, request.source)
  if (source.length && !SOURCE_SEEDABLE_CREATE_OBJECT_TYPES.has(supportedType)) {
    throw new Error(
      `source is not supported for ${supportedType}. Supported types: ` +
        `${[...SOURCE_SEEDABLE_CREATE_OBJECT_TYPES].join(", ")}.`
    )
  }
  return {
    connectionId: normalizedConnectionId,
    objectType: supportedType,
    name,
    objectName,
    description,
    packageName,
    parentName,
    transportNumber,
    source,
    objectUri,
    workspaceUri: `adt://${normalizedConnectionId}${objectUri}`
  }
}

export async function createObjectWithClient(
  client: ADTClient,
  request: PreparedCreateObjectRequest,
  language: string
): Promise<ObjectCreationInfo> {
  const availableTypes = await client.loadTypes()
  const typeAdvertised = availableTypes.some(
    (type) => type.OBJECT_TYPE.toUpperCase() === request.objectType
  )
  if (!typeAdvertised && request.objectType !== "FUGR/I") {
    throw new Error(
      `SAP system does not advertise creation support for object type ${request.objectType}.`
    )
  }

  let validation
  try {
    validation = await client.validateNewObject(
      request.objectType === "FUGR/FF" || request.objectType === "FUGR/I"
        ? {
            objtype: request.objectType,
            objname: request.name,
            description: request.description,
            fugrname: request.parentName
          }
        : {
            objtype: request.objectType,
            objname: request.name,
            description: request.description,
            packagename: request.packageName
          }
    )
  } catch (error) {
    if (!legacyValidationUnavailable(error)) throw error
  }
  if (validation && !validation.success && (validation.SHORT_TEXT || validation.SEVERITY)) {
    throw new Error(validation.SHORT_TEXT || `SAP rejected ${request.objectType} ${request.name}`)
  }

  const options: NewObjectOptions = {
    objtype: request.objectType,
    name: request.name,
    parentName: request.parentName || request.packageName,
    parentPath: request.parentName
      ? objectPath("FUGR/F", request.parentName.toLowerCase(), "")
      : objectPath("DEVC/K", request.packageName.toLowerCase()),
    description: request.description,
    responsible: client.username.toUpperCase(),
    transport: request.transportNumber,
    language: language.toUpperCase(),
    masterLanguage: language.toUpperCase()
  }
  try {
    await createObjectWithLegacyContentTypeFallback(client, options)
  } catch (error) {
    throw capabilityFailure(`create-${request.objectType.toLowerCase().replace("/", "-")}`, error)
  }

  // The object exists in SAP from here on, so a later failure must name the step that failed and say
  // that the object itself was created. On 2026-09-26 00:53 a PROG/I probe reported only "created ...
  // but post-create verification failed" while the initial source had never been written, which left
  // "created but empty" and "not created" indistinguishable for the caller.
  let phase = "post-create verification"
  try {
    // Older ECC systems may index a successful create after this immediate lookup.
    await client.findObjectPath(request.objectUri)

    // Seed the initial source while this stateful session is already established. Writing it here
    // rather than through a separate replace_string_in_abap_object call avoids the cold-session lock
    // loss documented in replaceSourceWithClient: the create has already settled the session, so the
    // edit lock and the PUT share it.
    //
    // A freshly created object is NOT blank: SAP gives it an inactive template (a new program carries
    // one line). replaceSourceWithClient refuses to overwrite pre-existing inactive source, because
    // that guard exists to protect a REVIEWED draft -- and a draft produced microseconds ago by this
    // very operation has no reviewer. It is therefore released with the draft's exact fingerprint,
    // which is the evidence an operator would otherwise supply by hand, so the guard keeps its full
    // meaning for every other caller.
    if (request.source.length) {
      phase = "initial source write"
      const inspection = await inspectSourceWithClient(
        client,
        request.connectionId,
        request.workspaceUri
      )
      const draft = inspection.inactiveSource
      const currentSource = draft ?? inspection.activeSource
      await replaceSourceWithClient(
        client,
        request.connectionId,
        request.workspaceUri,
        currentSource,
        request.source.join("\n"),
        request.transportNumber,
        draft === null ? undefined : createHash("sha256").update(draft).digest("hex"),
        draft !== null
      )
    }

    phase = "activation"
    const activation = await activateTarget(client, request.objectUri, request.objectName)
    return {
      connectionId: request.connectionId,
      objectType: request.objectType,
      objectName: request.objectName,
      description: request.description,
      packageName: request.packageName,
      parentName: request.parentName,
      transportNumber: request.transportNumber,
      objectUri: request.objectUri,
      workspaceUri: request.workspaceUri,
      activation
    }
  } catch (error) {
    // One stable code per partial state: the object exists in SAP either way, and the caller must be
    // able to tell "created with the requested source" from "created empty" without parsing prose.
    const code =
      phase === "initial source write" ? "CREATE_SOURCE_NOT_WRITTEN" : "CREATE_VERIFICATION_FAILED"
    throw new Error(
      `${code}: ${request.objectName} was created in SAP, but ${phase} failed: ${errorText(error)}. ` +
        "The object exists; read it back before adopting or deleting it."
    )
  }
}

interface ParsedMessageClassXml {
  description: string
  packageName: string
  masterLanguage: string
  version: string
  messages: Array<{ number: string; text: string }>
}

export function parseMessageClassXml(source: string): ParsedMessageClassXml {
  const document = parse(source, {
    ignoreAttributes: false,
    parseAttributeValue: false,
    trimValues: false
  }) as Record<string, unknown>
  const root = document["mc:messageClass"] as Record<string, unknown> | undefined
  if (!root) throw new Error("SAP returned invalid message class XML")
  const packageRef = root["adtcore:packageRef"] as Record<string, unknown> | undefined
  const rawMessages = root["mc:messages"]
  const messageRows = Array.isArray(rawMessages) ? rawMessages : rawMessages ? [rawMessages] : []
  return {
    description: String(root["@_adtcore:description"] ?? ""),
    packageName: String(packageRef?.["@_adtcore:name"] ?? ""),
    masterLanguage: String(root["@_adtcore:masterLanguage"] ?? root["@_adtcore:language"] ?? ""),
    version: String(root["@_adtcore:changedAt"] ?? ""),
    messages: messageRows.map((row) => {
      const record = row as Record<string, unknown>
      return {
        number: String(record["@_mc:msgno"] ?? "").padStart(3, "0"),
        text: String(record["@_mc:msgtext"] ?? "")
      }
    })
  }
}

export function addMessageClassEntries(
  source: string,
  messageClass: string,
  messages: Array<{ number: string; text: string }>
): string {
  const closeTag = "</mc:messageClass>"
  const closeIndex = source.indexOf(closeTag)
  if (closeIndex < 0 || source.indexOf(closeTag, closeIndex + closeTag.length) >= 0) {
    throw new Error("SAP returned invalid message class XML")
  }
  const upperName = messageClass.toUpperCase()
  const lowerName = messageClass.toLowerCase()
  const entries = messages
    .map(
      ({ number, text }) =>
        `<mc:messages mc:msgno="${number}" mc:msgtext="${encodeXml(text)}" ` +
        `mc:selfexplainatory="false" mc:documented="false" ` +
        `mc:lastchangedby="" mc:lastmodified="" adtcore:name="">\n` +
        `  <atom:link href="/sap/bc/adt/vit/docu/object_type/NA/object_name/${upperName}${number}" ` +
        `rel="http://www.sap.com/adt/relations/longtext" xmlns:atom="http://www.w3.org/2005/Atom"/>\n` +
        `  <atom:link href="/sap/bc/adt/messageclass/${lowerName}/messages/${number}" ` +
        `rel="http://www.sap.com/adt/relations/messageclasses/messages" ` +
        `xmlns:atom="http://www.w3.org/2005/Atom"/>\n` +
        `</mc:messages>\n`
    )
    .join("")
  return `${source.slice(0, closeIndex)}${entries}${source.slice(closeIndex)}`
}

export async function readMessageClassWithClient(
  client: ADTClient,
  connectionId: string,
  messageClass: string
): Promise<MessageClassInfo> {
  const normalized = messageClass.trim().toUpperCase()
  const objectUri = `/sap/bc/adt/messageclass/${encodeURIComponent(normalized.toLowerCase())}`
  let source: string
  try {
    source = await client.getObjectSource(objectUri, { version: "active" })
  } catch (error) {
    throw capabilityFailure("message-class-read", error)
  }
  return { connectionId, messageClass: normalized, ...parseMessageClassXml(source) }
}

export async function createMessageClassWithClient(
  client: ADTClient,
  connectionId: string,
  messageClass: string,
  description: string,
  messages: Array<{ number: string; text: string }>,
  packageName: string,
  transportNumber: string,
  language: string
): Promise<MessageClassCreationInfo> {
  const normalized = customerObjectName(messageClass, "messageClass", 20)
  const normalizedPackage = customerObjectName(packageName, "packageName", 30)
  const normalizedTransport = transportNumber.trim().toUpperCase()
  const objectUri = `/sap/bc/adt/messageclass/${encodeURIComponent(normalized.toLowerCase())}`
  try {
    const existingSource = await client.getObjectSource(objectUri, { version: "active" })
    parseMessageClassXml(existingSource)
    throw new Error(`MESSAGE_CLASS_EXISTS: Existing message classes cannot be replaced`)
  } catch (error) {
    if (!isNotFoundError(error)) throw error
  }

  const options: NewObjectOptions = {
    objtype: "MSAG/N",
    name: normalized,
    parentName: normalizedPackage,
    parentPath: objectPath("DEVC/K", normalizedPackage),
    description,
    responsible: client.username.toUpperCase(),
    transport: normalizedTransport,
    language: language.toUpperCase(),
    masterLanguage: language.toUpperCase()
  }
  try {
    await client.createObject(options)
  } catch (error) {
    throw capabilityFailure("message-class-create", error)
  }

  let lock
  let operationError: unknown
  let selectedTransport = normalizedTransport
  try {
    const initialSource = await client.getObjectSource(objectUri)
    const initial = parseMessageClassXml(initialSource)
    if (initial.messages.length) {
      throw new Error("New SAP message class unexpectedly contains messages")
    }
    lock = await client.lock(objectUri, "MODIFY")
    selectedTransport = selectTransport(lock, normalizedTransport)
    await client.setObjectSource(
      objectUri,
      addMessageClassEntries(initialSource, normalized, messages),
      lock.LOCK_HANDLE,
      selectedTransport
    )
  } catch (error) {
    operationError = error
  }

  if (lock) {
    try {
      await client.unLock(objectUri, lock.LOCK_HANDLE)
    } catch (unlockError) {
      if (operationError) {
        throw new Error(
          `${errorText(operationError)}; SAP unlock also failed: ${errorText(unlockError)}`
        )
      }
      throw new Error(`Message class was saved but SAP unlock failed: ${errorText(unlockError)}`)
    }
  }
  if (operationError) {
    throw new Error(
      `${normalized} was created in SAP, but its messages were not saved: ${errorText(operationError)}`
    )
  }

  const activation = await activateTarget(client, objectUri, normalized)
  const verified = await readMessageClassWithClient(client, connectionId, normalized)
  if (
    verified.description !== description ||
    verified.packageName !== normalizedPackage ||
    JSON.stringify(verified.messages) !== JSON.stringify(messages)
  ) {
    throw new Error("SAP message class verification did not return the requested definition")
  }
  return { ...verified, transportNumber: selectedTransport, activation }
}

interface CapturedCreateRequest {
  url: string
  options: RequestOptions
}

async function captureCreateRequest(options: NewObjectOptions): Promise<CapturedCreateRequest> {
  let captured: CapturedCreateRequest | undefined
  const captureHttp = {
    username: options.responsible,
    async request(url: string, requestOptions: RequestOptions = {}) {
      captured = { url, options: requestOptions }
      return { body: "", status: 201, statusText: "Created", headers: {} }
    }
  } as unknown as AdtHTTP
  await createObjectRequest(captureHttp, { ...options })
  if (!captured) throw new Error("abap-adt-api did not produce an object creation request")
  return captured
}

async function createObjectWithLegacyContentTypeFallback(
  client: ADTClient,
  options: NewObjectOptions
): Promise<void> {
  try {
    await client.createObject(options)
    return
  } catch (error) {
    if (!legacyCreateContentTypeRejected(options.objtype, error)) throw error
  }

  const contentTypes = LEGACY_CREATE_CONTENT_TYPES[options.objtype] ?? []
  if (!contentTypes.length) {
    throw new Error(`No legacy creation content types are configured for ${options.objtype}`)
  }
  const captured = await captureCreateRequest(options)
  let lastError: unknown
  for (const contentType of contentTypes) {
    try {
      await client.httpClient.request(captured.url, {
        ...captured.options,
        headers: { ...captured.options.headers, "Content-Type": contentType }
      })
      return
    } catch (error) {
      lastError = error
      if (!legacyCreateContentTypeRejected(options.objtype, error)) throw error
    }
  }
  throw lastError
}

function legacyCreateContentTypeRejected(objectType: string, error: unknown): boolean {
  const message = errorText(error)
  if (message.includes("No content handler found for content type")) return true
  if (objectType === "FUGR/I" && /(?:status code|HTTP) (?:404|501)\b/i.test(message)) {
    return true
  }
  return (
    objectType === "FUGR/F" &&
    /ExceptionInvalidData|Data is invalid and could not be converted/i.test(message)
  )
}

function legacyValidationUnavailable(error: unknown): boolean {
  const message = errorText(error)
  return /(?:status code|HTTP) (?:404|501)\b/i.test(message)
}

function legacyFunctionGroupCreationUnavailable(error: unknown): boolean {
  const message = errorText(error)
  return (
    /create-fugr-f capability unsupported-endpoint \(HTTP (?:405|501)\)/i.test(message) ||
    /ADT POST .*functions\/groups.*HTTP (?:405|501)/i.test(message)
  )
}

function legacyFunctionIncludeCreationUnavailable(error: unknown): boolean {
  return /create-fugr-i capability unsupported-endpoint \(HTTP (?:404|405|501)\)/i.test(
    errorText(error)
  )
}

function legacyRepositoryFallbackAvailable(error: unknown): boolean {
  const message = errorText(error)
  return (
    /capability (?:unsupported-endpoint|parser-or-content-type)(?: \(HTTP (?:400|404|405|501)\))?/i.test(
      message
    ) ||
    /(?:status code|HTTP) (?:404|405|501)\b/i.test(message) ||
    /SAP returned no text-element lock handle|does not expose writable text elements through ADT/i.test(
      message
    )
  )
}

function requireRepositoryResult(result: SapRepositoryResult, operation: string): void {
  if (result.status !== "S") {
    throw new Error(
      `SAP repository helper rejected ${operation}: ${result.code}: ${result.message}`
    )
  }
}

function serializeRepositoryRows(kind: "F" | "T", rows: Array<Record<string, string>>): string[] {
  return rows.flatMap((row, index) =>
    Object.entries(row).map(([name, rawValue]) => {
      if (/\r|\n/.test(rawValue))
        throw new Error("Repository payload values must not contain line breaks")
      const value = rawValue.replaceAll("%", "%25").replaceAll("|", "%7C")
      const line = `${kind}|${index + 1}|${name.toUpperCase()}|${value}`
      if (line.length > 255) throw new Error("Repository payload line exceeds ABAPTXT255")
      return line
    })
  )
}

function repositoryPayloadRows(
  source: string[],
  kind: "M" | "F" | "T"
): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = []
  for (const line of source) {
    const match = line.match(/^([MFT])\|(\d+)\|([A-Z0-9_]+)\|(.*)$/)
    if (!match?.[1] || match[1] !== kind || !match[2] || !match[3]) continue
    const index = Number.parseInt(match[2], 10)
    if (index < 1)
      throw new Error(`SAP repository helper returned an invalid payload index: ${line}`)
    while (rows.length < index) rows.push({})
    rows[index - 1]![match[3]] = decodeRepositoryPayloadValue(
      (match[4] ?? "").replaceAll("%7C", "|").replaceAll("%25", "%")
    )
  }
  return rows
}

function decodeRepositoryPayloadValue(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16))
    )
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
}

function messageClassFromRepository(
  connectionId: string,
  messageClass: string,
  source: string[]
): MessageClassInfo {
  const metadata = repositoryPayloadRows(source, "M")[0] ?? {}
  return {
    connectionId: connectionId.toLowerCase(),
    messageClass,
    description: metadata.DESCRIPTION ?? "",
    packageName: metadata.PACKAGE ?? "",
    masterLanguage: metadata.MASTERLANG ?? "",
    version: metadata.VERSION ?? "",
    messages: repositoryPayloadRows(source, "F").map((row) => ({
      number: row.MSGNR ?? "",
      text: row.TEXT ?? ""
    }))
  }
}

function textElementsFromRepository(
  connectionId: string,
  objectName: string,
  objectType: TextElementObjectType,
  source: string[]
): TextElementsInfo {
  return {
    connectionId: connectionId.toLowerCase(),
    objectName,
    objectType,
    textElements: repositoryPayloadRows(source, "T").map((row) => ({
      id: row.ID ?? "",
      text: row.TEXT ?? "",
      // The helper publishes the pool row ID it read (`I` or `S`). A helper that predates selection
      // texts publishes `I` rows only, so an absent TYPE is the symbol kind either way.
      idType: textElementIdTypeFromPoolId(row.TYPE),
      maxLength: Number.parseInt(row.MAXLENGTH ?? "0", 10) || 0
    }))
  }
}

function transportDetailsFromRepository(source: string[], requested: string): TransportRequest {
  const metadata = repositoryPayloadRows(source, "M")[0] ?? {}
  const number = metadata.NUMBER ?? requested
  const objectRows = repositoryPayloadRows(source, "T")
  const transportObject = (row: Record<string, string>) => ({
    "tm:pgmid": row.PGMID ?? "",
    "tm:type": row.TYPE ?? "",
    "tm:name": row.NAME ?? "",
    "tm:dummy_uri": "",
    "tm:obj_info": row.OBJ_INFO ?? "",
    "tm:wbtype": row.WBTYPE ?? "",
    "tm:position": row.POSITION ?? ""
  })
  const tasks = repositoryPayloadRows(source, "F").map((row) => {
    const taskNumber = row.NUMBER ?? ""
    return {
      "tm:number": taskNumber,
      "tm:owner": row.OWNER ?? "",
      "tm:desc": row.DESC ?? "",
      "tm:status": row.STATUS ?? "",
      "tm:uri": "",
      links: [],
      objects: objectRows.filter((object) => object.TASK === taskNumber).map(transportObject)
    }
  })
  return {
    "tm:number": number,
    "tm:owner": metadata.OWNER ?? "",
    "tm:desc": metadata.DESC ?? "",
    "tm:status": metadata.STATUS ?? "",
    "tm:uri": "",
    links: [],
    objects: objectRows
      .filter((object) => !object.TASK || object.TASK === number)
      .map(transportObject),
    tasks
  }
}

function isNotFoundError(error: unknown): boolean {
  return /(?:status code|HTTP) 404\b|(?:object|resource|program|class|interface|function(?: module)?)\b.*\b(?:not found|does not exist)\b|未找到对象/i.test(
    errorText(error)
  )
}

export async function createTestIncludeWithClient(
  client: ADTClient,
  connectionId: string,
  className: string
): Promise<TestIncludeCreationInfo> {
  const normalizedClassName = customerObjectName(className, "className")
  const objectUri = `/sap/bc/adt/oo/classes/${normalizedClassName.toLowerCase()}`
  const before = await loadRevisionObjectStructure(client, objectUri)
  if (!isClassStructure(before)) throw new Error(`${normalizedClassName} is not an ABAP class`)
  if (before.includes.some((include) => include["class:includeType"] === "testclasses")) {
    throw new Error(`Test include already exists for ${normalizedClassName}`)
  }

  let lock
  try {
    lock = await client.lock(objectUri, "MODIFY")
  } catch (error) {
    throw capabilityFailure("lock", error)
  }
  let operationError: unknown
  let transportNumber = ""
  try {
    const lockedStructure = await loadRevisionObjectStructure(client, objectUri)
    if (
      isClassStructure(lockedStructure) &&
      lockedStructure.includes.some((include) => include["class:includeType"] === "testclasses")
    ) {
      throw new Error(`Test include already exists for ${normalizedClassName}`)
    }
    transportNumber = selectTransport(lock)
    await client.createTestInclude(normalizedClassName, lock.LOCK_HANDLE, transportNumber)
  } catch (error) {
    operationError = error
  }

  try {
    await client.unLock(objectUri, lock.LOCK_HANDLE)
  } catch (unlockError) {
    if (operationError) {
      throw new Error(
        `${errorText(operationError)}; SAP unlock also failed: ${errorText(unlockError)}`
      )
    }
    throw new Error(`Test include was created but unlock failed: ${errorText(unlockError)}`)
  }
  if (operationError) throw operationError

  try {
    const after = await loadRevisionObjectStructure(client, objectUri)
    if (!isClassStructure(after)) throw new Error("SAP returned a non-class structure")
    const testInclude = after.includes.find(
      (include) => include["class:includeType"] === "testclasses"
    )
    if (!testInclude) throw new Error("SAP class structure does not contain the new test include")
    const reportedSourceUri = testInclude["abapsource:sourceUri"] || "includes/testclasses"
    const sourceUri = reportedSourceUri.startsWith("/sap/bc/adt/")
      ? reportedSourceUri
      : `${objectUri}/${reportedSourceUri.replace(/^\/+/, "")}`
    return {
      connectionId,
      className: normalizedClassName,
      sourceUri,
      workspaceUri: `adt://${connectionId}${sourceUri}`,
      transportNumber,
      activation: await activateTarget(client, objectUri, normalizedClassName)
    }
  } catch (error) {
    throw new Error(
      `Test include for ${normalizedClassName} was created in SAP, but post-create verification failed: ${errorText(error)}`
    )
  }
}

interface TextElementTarget {
  objectName: string
  objectType: TextElementObjectType
  adtType: "PROG/P" | "CLAS/OC" | "FUGR/F"
  objectUri: string
  textElementsUri: string
}

function textElementTarget(
  objectName: string,
  objectType: TextElementObjectType,
  write: boolean
): TextElementTarget {
  const normalizedType = objectType.toUpperCase() as TextElementObjectType
  const normalizedName = write
    ? customerObjectName(objectName, "objectName")
    : readableObjectName(objectName)
  const mapping = {
    PROGRAM: { adtType: "PROG/P", segment: "programs/programs" },
    CLASS: { adtType: "CLAS/OC", segment: "oo/classes" },
    FUNCTION_GROUP: { adtType: "FUGR/F", segment: "functions/groups" }
  } as const
  const selected = mapping[normalizedType]
  if (!selected) throw new Error(`Unsupported text element object type: ${objectType}`)
  return {
    objectName: normalizedName,
    objectType: normalizedType,
    adtType: selected.adtType,
    objectUri: `/sap/bc/adt/${selected.segment}/${encodeURIComponent(normalizedName.toLowerCase())}`,
    textElementsUri: ADTClient.textElementsUrl(selected.adtType, normalizedName)
  }
}

function repositoryTextObjectType(objectType: TextElementObjectType): "PROG" | "CLAS" | "FUGR" {
  const mapping: Record<TextElementObjectType, "PROG" | "CLAS" | "FUGR"> = {
    PROGRAM: "PROG",
    CLASS: "CLAS",
    FUNCTION_GROUP: "FUGR"
  }
  return mapping[objectType]
}

function readableObjectName(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (
    !normalized ||
    normalized.length > 30 ||
    !/^(?:\/[A-Z0-9_]+\/)?[A-Z0-9_]+$/.test(normalized)
  ) {
    throw new Error("objectName is not a valid ABAP object name")
  }
  return normalized
}

/**
 * Read every text pool kind this service maintains.
 *
 * Both categories are read because a caller that asks for "the text elements" of a program needs to
 * see the selection texts too: they are the labels of its selection screen, and a read that returned
 * symbols only made an existing `S` entry invisible, so a caller could neither discover nor verify
 * it. Symbols and selection texts share keys but are different entries, so each element carries the
 * kind it came from.
 */
export async function readTextElementsWithClient(
  client: ADTClient,
  connectionId: string,
  objectName: string,
  objectType: TextElementObjectType
): Promise<TextElementsInfo> {
  const target = textElementTarget(objectName, objectType, false)
  await client.getObjectSource(optimalSourceUri(target.adtType, target.objectUri), {
    version: "active"
  })
  const textElements: TextElementInfo[] = []
  for (const idType of TEXT_ELEMENT_ID_TYPES) {
    const result = await client.getTextElements(target.textElementsUri, textElementCategory(idType))
    textElements.push(
      ...result.textElements.map((element) => ({
        id: element.id,
        text: element.text,
        idType,
        ...(element.maxLength === undefined ? {} : { maxLength: element.maxLength })
      }))
    )
  }
  return {
    connectionId,
    objectName: target.objectName,
    objectType: target.objectType,
    textElements
  }
}

export async function writeTextElementsWithClient(
  client: ADTClient,
  connectionId: string,
  objectName: string,
  objectType: TextElementObjectType,
  action: "create" | "update",
  textElements: TextElementInfo[]
): Promise<TextElementMutationInfo> {
  const target = textElementTarget(objectName, objectType, true)
  const requested = normalizeTextElements(textElements)
  // One write per category, because ADT serves (and replaces) each category as its own document.
  const categories = [...new Set(requested.map((element) => textElementCategory(element.idType)))]
  let lock: AdtLock
  try {
    lock = await lockTextElementsWithClient(client, target.textElementsUri)
  } catch (error) {
    throw capabilityFailure("text-elements-lock", error)
  }

  let operationError: unknown
  let selectedTransport = ""
  let merged: NormalizedTextElement[] = []
  try {
    selectedTransport = selectTransport(lock)
    for (const category of categories) {
      const idType: TextElementIdType = category === "selections" ? "SELECTION" : "SYMBOL"
      const existing = await client.getTextElements(target.textElementsUri, category)
      // The category document is replaced as a whole, so the requested changes are merged into what
      // the category currently holds - an unrelated symbol or selection text must survive a write
      // that never mentioned it.
      const mergedCategory = mergeTextElementChanges(
        normalizeExistingTextElements(existing.textElements).map((element) => ({
          ...element,
          idType
        })),
        requested.filter((element) => textElementCategory(element.idType) === category),
        action
      )
      await client.setTextElements(
        target.textElementsUri,
        category,
        mergedCategory.map((element) =>
          category === "symbols"
            ? { id: element.id, text: element.text, maxLength: element.maxLength }
            : { id: element.id, text: element.text }
        ),
        lock.LOCK_HANDLE,
        selectedTransport
      )
      merged = merged.concat(mergedCategory)
    }
  } catch (error) {
    operationError = error
  }

  try {
    await client.unLock(target.textElementsUri, lock.LOCK_HANDLE)
  } catch (unlockError) {
    if (operationError) {
      throw new Error(
        `${errorText(operationError)}; SAP unlock also failed: ${errorText(unlockError)}`
      )
    }
    throw new Error(`Text elements were saved but SAP unlock failed: ${errorText(unlockError)}`)
  }
  if (operationError) throw operationError

  const activation = await activateTarget(client, target.textElementsUri, target.objectName)
  const verified: TextElementInfo[] = []
  for (const category of categories) {
    const idType: TextElementIdType = category === "selections" ? "SELECTION" : "SYMBOL"
    const result = await client.getTextElements(target.textElementsUri, category)
    verified.push(
      ...result.textElements.map((element) => ({
        id: element.id,
        text: element.text,
        idType,
        ...(element.maxLength === undefined ? {} : { maxLength: element.maxLength })
      }))
    )
  }
  const verifiedByKey = new Map(verified.map((element) => [textElementKey(element), element]))
  for (const expected of merged) {
    const actual = verifiedByKey.get(textElementKey(expected))
    const textMatches = actual?.text === expected.text
    // A selection text has no declared length: ADT reports a length for symbols only, and the
    // caller's contract for a selection text is the label itself.
    const lengthMatches =
      expected.idType === "SELECTION" || actual?.maxLength === expected.maxLength
    if (!actual || !textMatches || !lengthMatches) {
      throw new Error(
        `Text elements were saved but verification failed for ${expected.idType} ${expected.id}`
      )
    }
  }
  return {
    connectionId,
    objectName: target.objectName,
    objectType: target.objectType,
    action,
    changedIds: requested.map((element) => element.id),
    transportNumber: selectedTransport,
    activation,
    textElements: verified
  }
}

export async function lockTextElementsWithClient(
  client: ADTClient,
  textElementsUri: string
): Promise<AdtLock> {
  const response = await client.httpClient.request(textElementsUri, {
    headers: {
      Accept:
        "application/*,application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result"
    },
    method: "POST",
    qs: { _action: "LOCK", accessMode: "MODIFY" }
  })
  const lock = findAdtLock(parse(response.body))
  if (!lock && response.status === 200 && response.body.length === 0) {
    throw new Error(
      "SAP returned no text-element lock handle. This system does not expose writable text elements through ADT; SAP GUI-only text maintenance cannot be automated by the headless service."
    )
  }
  if (!lock) {
    throw new Error(
      `SAP returned an unusable text-element lock response (HTTP ${response.status}, ${response.body.length} bytes)`
    )
  }
  return lock
}

function findAdtLock(value: unknown): AdtLock | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const lock = findAdtLock(item)
      if (lock) return lock
    }
    return undefined
  }
  if (!value || typeof value !== "object") return undefined

  const record = value as Record<string, unknown>
  const field = (name: string) => {
    const key = Object.keys(record).find(
      (candidate) => candidate.replace(/^@_/, "").split(":").pop()?.toUpperCase() === name
    )
    const raw = key ? record[key] : undefined
    if (typeof raw === "string" || typeof raw === "number") return String(raw)
    if (raw && typeof raw === "object" && "#text" in raw) {
      return String((raw as { "#text": unknown })["#text"])
    }
    return ""
  }
  const lockHandle = field("LOCK_HANDLE")
  if (lockHandle) {
    return {
      LOCK_HANDLE: lockHandle,
      CORRNR: field("CORRNR"),
      CORRUSER: field("CORRUSER"),
      CORRTEXT: field("CORRTEXT"),
      IS_LOCAL: field("IS_LOCAL"),
      IS_LINK_UP: field("IS_LINK_UP"),
      MODIFICATION_SUPPORT: field("MODIFICATION_SUPPORT")
    }
  }
  for (const child of Object.values(record)) {
    const lock = findAdtLock(child)
    if (lock) return lock
  }
  return undefined
}

function customerObjectName(value: string, field: string, maximum = 30): string {
  const normalized = value.trim().toUpperCase()
  if (!/^[ZY][A-Z0-9_]*$/.test(normalized)) {
    throw new Error(`${field} must be a Z* or Y* customer name`)
  }
  if (normalized.length > maximum) {
    throw new Error(`${field} exceeds the ${maximum}-character limit`)
  }
  return normalized
}

interface SourceTarget {
  sourceUri: string
  objectUri: string
  objectName: string
  customerNames: string[]
  kind:
    | "class"
    | "interface"
    | "program"
    | "include"
    | "function-group"
    | "function-module"
    | "function-group-include"
    | "ddl-source"
    | "dcl-source"
}

export async function replaceSourceWithClient(
  client: ADTClient,
  connectionId: string,
  fileUri: string,
  oldString: string,
  newString: string,
  transportNumber?: string,
  expectedSourceFingerprint?: string,
  recoverInactiveSource = false
): Promise<SourceMutationInfo> {
  const target = resolveEditableSourceTarget(fileUri, connectionId)
  if (expectedSourceFingerprint && !/^[a-f0-9]{64}$/i.test(expectedSourceFingerprint)) {
    throw new Error("expectedSourceFingerprint must be a SHA-256 fingerprint")
  }
  if (recoverInactiveSource && !expectedSourceFingerprint) {
    throw new Error(
      "INACTIVE_SOURCE_RECOVERY_FINGERPRINT_REQUIRED: expectedSourceFingerprint must identify the reviewed inactive source."
    )
  }
  if (client.stateful !== session_types.stateful) {
    throw new Error("SAP source replacement requires a dedicated stateful ADT session.")
  }

  // A stateful session can be established only on the first stateful request, which would leave an edit
  // lock taken before it orphaned in the earlier session: SAP then answers the PUT with "Resource ... is
  // not locked" even though the handle came from the lock it just issued. ABAP_MCP_STATEFUL_WARMUP=1 issues
  // one harmless read first, so the lock and the write share the session SAP has settled on. Default off,
  // and the call is the same inspection the write path performs again below.
  if (process.env.ABAP_MCP_STATEFUL_WARMUP) {
    await inspectSourceWithClient(client, connectionId, fileUri).catch(() => undefined)
  }

  let lock
  const lockUri = lockTargetUri(target.objectUri, target.sourceUri, target.kind)
  try {
    lock = await client.lock(lockUri, "MODIFY")
  } catch (error) {
    throw capabilityFailure("lock", error)
  }
  let operationError: unknown
  let selectedTransport = ""
  let sourceFingerprintBefore = ""
  let sourceFingerprintAfter = ""
  try {
    const inspection = await inspectSourceWithClient(client, connectionId, fileUri)
    const inactiveSource = inspection.inactiveSource
    if (inactiveSource !== null && !recoverInactiveSource) {
      throw new Error(
        `${target.objectName} already has inactive SAP source. Refusing to overwrite an existing inactive version by default. ` +
          "To repair the reviewed draft, set recoverInactiveSource=true and expectedSourceFingerprint to its exact SHA-256; otherwise activate or resolve it first."
      )
    }
    if (recoverInactiveSource && inactiveSource === null) {
      throw new Error(
        `INACTIVE_SOURCE_RECOVERY_NOT_AVAILABLE: ${target.objectName} has no inactive SAP source to repair.`
      )
    }
    let currentSource = inspection.activeSource
    if (recoverInactiveSource && inactiveSource !== null) currentSource = inactiveSource
    sourceFingerprintBefore = createHash("sha256").update(currentSource).digest("hex")
    if (
      expectedSourceFingerprint &&
      expectedSourceFingerprint.toLowerCase() !== sourceFingerprintBefore
    ) {
      throw new Error(
        `SOURCE_FINGERPRINT_CONFLICT: ${recoverInactiveSource ? "inactive" : "active"} source changed since review`
      )
    }
    const updatedSource = findAndReplaceSource(currentSource, oldString, newString)
    sourceFingerprintAfter = createHash("sha256").update(updatedSource).digest("hex")
    selectedTransport = selectTransport(lock, transportNumber)
    await client.setObjectSource(
      target.sourceUri,
      updatedSource,
      lock.LOCK_HANDLE,
      selectedTransport
    )
  } catch (error) {
    operationError = error
  }

  try {
    await client.unLock(lockUri, lock.LOCK_HANDLE)
  } catch (unlockError) {
    if (operationError) {
      throw new Error(
        `${errorText(operationError)}; SAP unlock also failed: ${errorText(unlockError)}`
      )
    }
    throw new Error(
      `SAP source was saved but unlock failed: ${errorText(unlockError)}; ` +
        JSON.stringify({
          saveSucceeded: true,
          unlockSucceeded: false,
          activationAttempted: false,
          activationSucceeded: false,
          sourceFingerprintBefore,
          sourceFingerprintAfter,
          automaticRetry: false,
          automaticRollback: false
        })
    )
  }
  if (operationError) throw operationError

  const activation = await activateTarget(client, target.objectUri, target.objectName)
  let activeFingerprint: string | null = null
  let inactiveFingerprint: string | null = null
  let readbackError: string | undefined
  try {
    const activeSource = await client.getObjectSource(target.sourceUri, { version: "active" })
    activeFingerprint = createHash("sha256").update(activeSource).digest("hex")
    if (!activation.success || activeFingerprint !== sourceFingerprintAfter) {
      const inspection = await inspectSourceWithClient(client, connectionId, fileUri)
      inactiveFingerprint =
        inspection.inactiveSource === null
          ? null
          : createHash("sha256").update(inspection.inactiveSource).digest("hex")
    }
    if (activation.success && activeFingerprint !== sourceFingerprintAfter) {
      activation.success = false
      activation.messages.push({
        type: "E",
        line: 0,
        text: "ACTIVE_SOURCE_FINGERPRINT_MISMATCH: active source does not match the saved candidate.",
        href: target.sourceUri
      })
    }
  } catch (error) {
    readbackError = errorText(error)
    activation.success = false
    activation.messages.push({
      type: "E",
      line: 0,
      text: `SOURCE_READBACK_UNAVAILABLE: ${readbackError}`,
      href: target.sourceUri
    })
  }
  return {
    fileUri,
    sourceUri: target.sourceUri,
    objectName: target.objectName,
    oldLineCount: lineCount(oldString),
    newLineCount: lineCount(newString),
    transportNumber: selectedTransport,
    activation,
    sourceFingerprintBefore,
    sourceFingerprintAfter,
    saveSucceeded: true,
    unlockSucceeded: true,
    activationAttempted: activation.attempted ?? false,
    activationSucceeded: activation.success,
    activeFingerprint,
    inactiveFingerprint,
    ...(readbackError ? { readbackError } : {})
  }
}

export async function inspectSourceWithClient(
  client: ADTClient,
  connectionId: string,
  fileUri: string
): Promise<SourceInspectionInfo> {
  const target = resolveEditableSourceTarget(fileUri, connectionId)
  const activeSource = await client.getObjectSource(target.sourceUri, { version: "active" })
  // The main-program context only enriches the inactive-inventory error below. Reading an include
  // never needs it, and 7.31 does not implement `/mainprograms` (HTTP 501), so a failed or
  // unavailable lookup must not fail the observation: that made every include change unobservable
  // (w200 2026-09-26 00:41) even though the include source itself read fine.
  const contexts = await includeMainProgramContexts(client, target.objectUri)
    .then((resolution) => (resolution.status === "resolved" ? resolution.contexts : []))
    .catch(() => [])
  let inactive
  try {
    inactive = await inactiveObjectForTarget(client, target.objectUri)
  } catch (error) {
    if (error instanceof InactiveInventoryError) {
      throw error.withContext({
        targetUri: target.objectUri,
        ...(contexts.length === 1 ? { mainProgramUri: contexts[0] } : {})
      })
    }
    throw error
  }
  // A valid inventory can still omit a draft. Probe the target as well; read failures
  // remain unavailable, never evidence that an inactive version does not exist.
  const candidate = await client.getObjectSource(target.sourceUri, { version: "inactive" })
  const inactiveSource = inactive || candidate !== activeSource ? candidate : null
  return {
    sourceUri: target.sourceUri,
    objectUri: target.objectUri,
    objectName: target.objectName,
    activeSource,
    inactiveSource
  }
}

export function resolveEditableSourceTarget(fileUri: string, connectionId: string): SourceTarget {
  const normalized = normalizeAdtUri(fileUri, connectionId).replace(/[?#].*$/, "")
  const sourceUri = optimalSourceUri(detectTypeFromUri(normalized), normalized)
  const classMatch = sourceUri.match(/^(\/sap\/bc\/adt\/oo\/classes\/([^/]+))/i)
  if (classMatch?.[1] && classMatch[2]) {
    const objectName = decodeObjectName(classMatch[2])
    return customerSourceTarget({
      sourceUri,
      objectUri: classMatch[1],
      objectName,
      customerNames: [objectName],
      kind: "class"
    })
  }

  const objectUri = sourceUri.replace(/\/source\/main$/i, "")
  const interfaceMatch = objectUri.match(/^\/sap\/bc\/adt\/oo\/interfaces\/([^/]+)$/i)
  if (interfaceMatch?.[1]) {
    const objectName = decodeObjectName(interfaceMatch[1])
    return customerSourceTarget({
      sourceUri,
      objectUri,
      objectName,
      customerNames: [objectName],
      kind: "interface"
    })
  }

  const programMatch = objectUri.match(/^\/sap\/bc\/adt\/programs\/(programs|includes)\/([^/]+)$/i)
  if (programMatch?.[1] && programMatch[2]) {
    const objectName = decodeObjectName(programMatch[2])
    return customerSourceTarget({
      sourceUri,
      objectUri,
      objectName,
      customerNames: [objectName],
      kind: programMatch[1].toLowerCase() === "includes" ? "include" : "program"
    })
  }

  const functionMatch = objectUri.match(
    /^\/sap\/bc\/adt\/functions\/groups\/([^/]+)(?:\/(fmodules|includes)\/([^/]+))?$/i
  )
  if (functionMatch?.[1]) {
    const groupName = decodeObjectName(functionMatch[1])
    const childType = functionMatch[2]?.toLowerCase()
    const childName = functionMatch[3] ? decodeObjectName(functionMatch[3]) : ""
    if (childType && !childName) {
      throw new Error(`Could not determine the ABAP function source from ${fileUri}`)
    }
    return customerSourceTarget({
      sourceUri,
      objectUri,
      objectName: childName || groupName,
      customerNames: childType === "fmodules" ? [groupName, childName] : [groupName],
      kind:
        childType === "fmodules"
          ? "function-module"
          : childType === "includes"
            ? "function-group-include"
            : "function-group"
    })
  }

  for (const [pattern, kind] of [
    [/^\/sap\/bc\/adt\/ddic\/ddl\/sources\/([^/]+)$/i, "ddl-source"],
    [/^\/sap\/bc\/adt\/acm\/dcl\/sources\/([^/]+)$/i, "dcl-source"]
  ] as const) {
    const match = objectUri.match(pattern)
    if (!match?.[1]) continue
    const objectName = decodeObjectName(match[1])
    return customerSourceTarget({
      sourceUri,
      objectUri,
      objectName,
      customerNames: [objectName],
      kind
    })
  }

  throw new Error(
    `Unsupported ABAP source URI for controlled editing: ${fileUri}. ` +
      "Supported source objects: classes, interfaces, programs, includes, function groups, function modules, function-group includes, DDL sources, and DCL sources."
  )
}

function customerSourceTarget(target: SourceTarget): SourceTarget {
  for (const objectName of target.customerNames) {
    if (/^[ZY]/.test(objectName)) continue
    throw new Error(
      `Refusing state-changing operation for ${objectName}. ` +
        "Only Z* or Y* customer objects and customer-owned child sources are allowed."
    )
  }
  return target
}

function decodeObjectName(value: string): string {
  const objectName = decodeURIComponent(value).toUpperCase()
  if (!objectName) throw new Error("Could not determine the ABAP object name")
  return objectName
}

async function describeDiscovery(client: ADTClient, hrefPrefix: string): Promise<string> {
  try {
    const discovery = await client.adtDiscovery()
    const collections = discovery.flatMap((entry) => entry.collection)
    const advertised = collections.some(
      (collection) =>
        collection.href.startsWith(hrefPrefix) ||
        collection.templateLinks.some((link) => link.template.startsWith(hrefPrefix))
    )
    return advertised
      ? `${hrefPrefix} is advertised by the SAP server`
      : `${hrefPrefix} is not advertised by the SAP server`
  } catch (error) {
    return `capability discovery failed (${errorText(error)})`
  }
}

async function inactiveObjects(client: ADTClient) {
  try {
    const inventory = await readInactiveInventory(client.httpClient)
    return inventory.entries.map((entry) => ({
      object: {
        "adtcore:uri": entry.uri,
        "adtcore:name": entry.name,
        "adtcore:type": entry.type,
        "adtcore:parentUri": entry.parentUri ?? "",
        user: entry.user,
        deleted: entry.deleted
      }
    }))
  } catch (error) {
    if (error instanceof InactiveInventoryError) throw error
    throw capabilityFailure("inactive-object-check", error)
  }
}

async function inactiveObjectForTarget(client: ADTClient, objectUri: string) {
  const records = await inactiveObjects(client)
  const matches = records
    .map((record) => record.object)
    .filter((object) => sameObjectUri(object["adtcore:uri"], objectUri))
  if (matches.length > 1) {
    throw new Error(
      "INACTIVE_TARGET_CONTEXT_AMBIGUOUS: multiple inactive references match the target."
    )
  }
  return matches[0]
}

export async function activateTarget(
  client: ADTClient,
  objectUri: string,
  objectName: string
): Promise<ActivationInfo> {
  let attempted = false
  try {
    // Where the release implements `/mainprograms`, an include is activated through its main-program
    // context; where it does not (7.31 answers HTTP 501), the include is activated by its own URI and
    // SAP remains the authority on whether that is enough.
    const resolution = await includeMainProgramContexts(client, objectUri)
    const contexts = resolution.status === "resolved" ? resolution.contexts : []
    let inactive
    try {
      inactive = await inactiveObjectForTarget(client, objectUri)
    } catch (error) {
      if (error instanceof InactiveInventoryError) {
        throw error.withContext({
          targetUri: objectUri,
          ...(contexts.length === 1 ? { mainProgramUri: contexts[0] } : {})
        })
      }
      throw error
    }
    let context: string | undefined
    if (contexts.length) {
      const supplied = inactive
        ? new URL(inactive["adtcore:uri"], "https://sap.invalid").searchParams.get("context")
        : null
      context = supplied
        ? contexts.find((uri) => sameObjectUri(uri, supplied))
        : contexts.length === 1
          ? contexts[0]
          : undefined
      if (!context) {
        throw new Error(
          "INCLUDE_MAIN_PROGRAM_AMBIGUOUS: resolve the SAP main-program context before activation."
        )
      }
    } else if (isIncludeObjectUri(objectUri) && inactive) {
      // A release that implements `/mainprograms` always answered above; reaching here for an include
      // means the endpoint is unavailable (7.31 answers HTTP 501). SAP's own inactive inventory still
      // names the draft's main program, either as `.../includes/<include>?context=<main program>` or
      // as the entry's parent URI, so use whichever SAP supplied. `inactiveObjectForTarget` refuses
      // duplicate matches, so this is never a first-match guess, and nothing is invented when SAP
      // names no context at all.
      context = inventoryMainProgramContext(inactive)
    }
    attempted = true
    // The inactive inventory identifies the draft and, for includes, its parent context.
    // Keep that metadata out of the activation payload: older ECC releases can reject
    // the object-reference overload when it adds type or an empty parent URI.
    const result = await client
      .activate(objectName, objectUri, context, true)
      .catch((error: unknown) => {
        // Name the request that failed. `client.activate` posts one object reference to one generic
        // endpoint, and the library's failure text carries no URI at all, which is why the activation
        // failure of 2026-09-26 06:51 could not be attributed to a request by either the caller or a
        // later reader of the report.
        if (isMainProgramContextRejection(error)) {
          throw new Error(
            includeMainProgramUnresolvedMessage(objectUri, objectName, context, error)
          )
        }
        throw new Error(
          `POST /sap/bc/adt/activation for ${objectUri}` +
            `${context ? `?context=${context}` : ""} failed: ${errorText(error)}`
        )
      })
    const activation: ActivationInfo = {
      success: result.success,
      attempted,
      messages: result.messages.map((message) => ({
        type: message.type,
        line: message.line,
        text: message.shortText,
        href: message.href
      })),
      inactiveObjects: result.inactive
        .map((record) => record.object?.["adtcore:name"])
        .filter((name): name is string => Boolean(name))
    }
    return activation.success
      ? await activateProgramIncludes(client, objectUri, objectName, activation)
      : activation
  } catch (error) {
    return {
      success: false,
      attempted,
      messages: [
        {
          type: "E",
          line: 0,
          text: capabilityFailure("activation", error).message,
          href: objectUri
        }
      ],
      inactiveObjects: []
    }
  }
}

const INCLUDE_OBJECT_URI = /\/(?:programs|functions\/groups\/[^/]+)\/includes\/[^/]+$/i

function isIncludeObjectUri(objectUri: string): boolean {
  return INCLUDE_OBJECT_URI.test(objectUri)
}

const PROGRAM_OBJECT_URI = /\/programs\/programs\/[^/]+$/i

/**
 * `INCLUDE <name>.` in a program's own source. `INCLUDE STRUCTURE <ddic>` names a DDIC structure,
 * not a program include, and a quoted or `*`-prefixed tail is not code.
 */
const INCLUDE_STATEMENT = /^\s*INCLUDE\s+(?!STRUCTURE\b)([A-Za-z_][A-Za-z0-9_]*)/i

export function referencedIncludeNames(source: string): string[] {
  const names = new Set<string>()
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*\*.*$/, "").replace(/".*$/, "")
    const name = INCLUDE_STATEMENT.exec(line)?.[1]
    if (name) names.add(name.toUpperCase())
  }
  return [...names]
}

/**
 * Activating a program does not activate its includes: SAP activates exactly the objects the request
 * names. A program can therefore report "activated" while its include drafts stay inactive - the
 * silent inconsistency the 2026-09-26 06:51 probe exposed, where `replace_string_in_abap_object`
 * returned success and the include's active source was still the empty string, so the assembled
 * program would have lost the include's logic without reporting anything.
 *
 * The includes a program needs are the ones its own source names, and SAP's inactive inventory says
 * which of them still carry a draft. Those drafts are activated first - each by its own URI with this
 * program as the context, one object per request, the request shape proven on this release - and the
 * program is activated again so its load is generated from the include text that is now active. A
 * draft that still cannot be activated is reported as a failure naming it, and success is never
 * claimed for a program whose includes were not activated.
 *
 * A graph this function cannot read (source or inventory unavailable) does not turn a successful
 * activation into a failure, but it is never silent either: the caller is warned that whether the
 * includes are active was not established.
 */
async function activateProgramIncludes(
  client: ADTClient,
  objectUri: string,
  objectName: string,
  activation: ActivationInfo
): Promise<ActivationInfo> {
  if (!PROGRAM_OBJECT_URI.test(objectUri)) return activation
  const warn = (reason: string) =>
    activation.messages.push({
      type: "W",
      line: 0,
      text: `INCLUDE_GRAPH_UNVERIFIED: ${reason}. ${objectName} itself was activated; whether its includes are active was not established.`,
      href: objectUri
    })
  let source: string
  try {
    source = String(await client.getObjectSource(objectUri, { version: "active" }))
  } catch (error) {
    warn(`the include list of ${objectName} could not be read (${errorText(error)})`)
    return activation
  }
  const referenced = new Set(referencedIncludeNames(source))
  let drafts: { name: string; uri: string }[]
  try {
    drafts = (await inactiveObjects(client))
      .map((record) => record.object)
      .filter((object) => {
        if (!/^PROG\/I$/i.test(String(object["adtcore:type"] ?? ""))) return false
        const name = String(object["adtcore:name"] ?? "").toUpperCase()
        return (
          (name !== "" && referenced.has(name)) ||
          sameObjectUri(String(object["adtcore:parentUri"] ?? ""), objectUri)
        )
      })
      .map((object) => ({
        name: String(object["adtcore:name"] ?? ""),
        uri: String(object["adtcore:uri"] ?? "").replace(/[?#].*$/, "")
      }))
      .filter((draft) => draft.name !== "" && ADT_RESOURCE_URI.test(draft.uri))
  } catch (error) {
    warn(`SAP's inactive inventory could not be read (${errorText(error)})`)
    return activation
  }
  if (!drafts.length) return activation

  const stranded: string[] = []
  for (const draft of drafts) {
    try {
      const accepted = await client.activate(draft.name, draft.uri, objectUri, true)
      if (!accepted.success) stranded.push(draft.name)
    } catch {
      stranded.push(draft.name)
    }
  }
  if (stranded.length) {
    activation.success = false
    activation.messages.push({
      type: "E",
      line: 0,
      text:
        `INCLUDE_ACTIVATION_INCOMPLETE: ${objectName} is active, but the draft of ` +
        `${stranded.join(", ")} could not be activated, so the program runs the previously active ` +
        "include text. Activate those includes and activate the program again.",
      href: objectUri
    })
    return activation
  }
  let reactivated
  try {
    reactivated = await client.activate(objectName, objectUri, undefined, true)
  } catch (error) {
    activation.success = false
    activation.messages.push({
      type: "E",
      line: 0,
      text:
        `INCLUDE_ACTIVATION_INCOMPLETE: the includes ${drafts.map((draft) => draft.name).join(", ")} ` +
        `were activated, but activating ${objectName} again failed: ${errorText(error)}.`,
      href: objectUri
    })
    return activation
  }
  if (!reactivated.success) {
    activation.success = false
    activation.messages.push(
      ...reactivated.messages.map((message) => ({
        type: message.type,
        line: message.line,
        text: `INCLUDE_ACTIVATION_INCOMPLETE after activating its includes: ${message.shortText}`,
        href: message.href
      }))
    )
    return activation
  }
  activation.messages.push({
    type: "I",
    line: 0,
    text:
      `INCLUDE_GRAPH_ACTIVATED: activated ${drafts.length} include draft(s) ` +
      `(${drafts.map((draft) => draft.name).join(", ")}) and activated ${objectName} again, so its ` +
      "load is generated from the include text that is now active.",
    href: objectUri
  })
  return activation
}

/** A resource URI SAP itself can address, with no scheme, query or trailing slash. */
const ADT_RESOURCE_URI = /^\/sap\/bc\/adt\/[a-z0-9_/-]+$/i

/**
 * Status codes that mean "this release has no handler for the resource" rather than "the request
 * failed": SAP_BASIS 7.31 answers `/includes/<name>/mainprograms` with 501 and the canonical DDIC
 * path of every table with 404. One rule, one place - a caller may never treat one of these as a
 * fault while another treats it as an answer.
 */
function isUnsupportedEndpointStatus(status: number): boolean {
  return status === 404 || status === 405 || status === 501
}

/**
 * `/includes/<name>/mainprograms` is a convenience resource - it names the main program an include
 * belongs to. SAP_BASIS 7.31 does not implement it. The library reports that failure as a bare HTTP
 * status with no URI in it at all ("Request failed with status code 404", because `HttpClientException`
 * keeps axios' message while SAP's own text only reaches the trace), so the incident of 2026-09-26
 * 06:51 could not be diagnosed by reading the message. Classification therefore rests on the request
 * that was made rather than on what the message happens to say: this function asks exactly one
 * question of one URI, so an unsupported status identifies the missing endpoint by construction.
 * An include is addressed by its own URI, so an unavailable reverse lookup decides nothing about
 * reading, writing or activating it; every other failure (transport, authorization, SAP error) keeps
 * its meaning and still stops the caller.
 */
type MainProgramContexts = { status: "resolved"; contexts: string[] } | { status: "unavailable" }

async function includeMainProgramContexts(
  client: ADTClient,
  objectUri: string
): Promise<MainProgramContexts> {
  if (!isIncludeObjectUri(objectUri)) return { status: "resolved", contexts: [] }
  let programs
  try {
    programs = await client.mainPrograms(objectUri)
  } catch (error) {
    if (isUnsupportedEndpointStatus(reportedHttpStatus(error))) return { status: "unavailable" }
    throw new Error(`main-program lookup for ${objectUri} failed: ${errorText(error)}`)
  }
  const contexts = [...new Set(programs.map((program) => program["adtcore:uri"]))]
  if (!contexts.length || contexts.some((uri) => !ADT_RESOURCE_URI.test(uri))) {
    throw new Error("INCLUDE_MAIN_PROGRAM_UNAVAILABLE: no valid SAP main-program context.")
  }
  return { status: "resolved", contexts }
}

/**
 * SAP's inactive inventory names the main program of an include draft twice: as the `?context=`
 * qualifier on the draft's URI, and as `adtcore:parentUri`. Both are SAP's own answer, so either may
 * be used, and nothing is invented when SAP supplies neither.
 */
function inventoryMainProgramContext(entry: {
  "adtcore:uri": string
  "adtcore:parentUri"?: string
}): string | undefined {
  const qualifier = new URL(entry["adtcore:uri"], "https://sap.invalid").searchParams.get("context")
  for (const candidate of [qualifier, entry["adtcore:parentUri"]]) {
    if (candidate && ADT_RESOURCE_URI.test(candidate)) return candidate
  }
  return undefined
}

/**
 * SAP registers an include against the main program that pulls it in (`D010INC`). When such a
 * registration exists, activating the include with no `?context=` is refused with
 * "Main program <name> is not anymore valid for include <INCLUDE>" - and when no context was sent,
 * SAP echoes the missing value, which is why the message shows two spaces between "program" and
 * "is" (observed on w200, 2026-09-26 08:18). The same request succeeds for an include no program
 * references yet, because then SAP has no registration to validate against. That asymmetry is the
 * whole defect: the include is fine, the activation request was simply missing the main program.
 *
 * The wording is matched rather than the HTTP status because SAP answers this validation failure
 * with a plain 400-class error body; the phrase is stable and names the include it applies to.
 */
function isMainProgramContextRejection(error: unknown): boolean {
  return /Main program\s+is not anymore valid for include\b/i.test(errorText(error))
}

/**
 * Report an unresolved main-program context as the actionable gap it is, instead of forwarding SAP's
 * message: that message names the include but not what the caller must do, and the double space it
 * prints where the program name belongs reads like a formatting defect rather than a missing input.
 *
 * This is deliberately not a silent retry and not a guess. The service has four ways to learn the
 * main program - the release's `/mainprograms` resource (unimplemented on SAP_BASIS 7.31), the
 * context SAP puts on the inactive draft, the parent URI of the same inventory entry, and the
 * include list of a program being activated - and each of them is already consulted before the
 * request is sent. Reaching here means SAP itself knows a registration that none of those sources
 * revealed, so the honest answer is to say so and name the way out (activate the main program, which
 * resolves the include list from the program's own source, or activate the include together with it)
 * rather than to let the caller read a bare SAP string as an unexplained failure.
 */
function includeMainProgramUnresolvedMessage(
  objectUri: string,
  objectName: string,
  context: string | undefined,
  error: unknown
): string {
  const supplied = context
    ? `the request was sent with main program ${context}, which SAP did not accept`
    : "no main program context could be resolved, so the request carried the include URI alone"
  return (
    `INCLUDE_MAIN_PROGRAM_UNRESOLVED: SAP refused to activate ${objectName} because ${supplied}. ` +
    "SAP registers an include against the main program that includes it, and this release does not " +
    "publish that relation for the include (the `/includes/<name>/mainprograms` resource is " +
    "unimplemented here, and the inactive inventory named no context). Activate the main program " +
    "instead: its own source is read for its INCLUDE list and the drafts it names are activated " +
    `with that program as their context. SAP said: ${errorText(error)}`
  )
}

function sameObjectUri(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value
      .replace(/[?#].*$/, "")
      .replace(/\/$/, "")
      .replace(/\/source\/main$/i, "")
  return normalize(left).toLowerCase() === normalize(right).toLowerCase()
}

function selectTransport(lock: { CORRNR: string; IS_LOCAL: string }, requested?: string): string {
  const requestedNumber = requested?.trim().toUpperCase() ?? ""
  const lockedNumber = lock.CORRNR?.trim().toUpperCase() ?? ""
  if (requestedNumber && lockedNumber && requestedNumber !== lockedNumber) {
    throw new Error(
      `Object is locked to transport ${lockedNumber}; requested transport ${requestedNumber} cannot be used.`
    )
  }
  if (lock.IS_LOCAL === "X") return ""
  if (requestedNumber) return requestedNumber
  if (lockedNumber) return lockedNumber
  throw new Error(
    "SAP requires an explicit transport number for this object. Provide transportNumber; the standalone service will not create or choose a transport automatically."
  )
}

function lineCount(value: string): number {
  return value.length ? value.split(/\r?\n/).length : 0
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class AdtRequestTimeoutError extends Error {
  constructor(
    readonly code: string,
    stage: string,
    uri: string,
    timeoutMs: number,
    elapsedMs: number
  ) {
    super(
      `${code}: ${stage} timed out (budget ${timeoutMs}ms, elapsed ${elapsedMs}ms) for ${uri}; ` +
        "response body and line count are unavailable; the local HTTP request was aborted, " +
        "SAP-side cancellation is unconfirmed, and no automatic retry was started"
    )
    this.name = "AdtRequestTimeoutError"
  }
}

function boundedAdtHttp(http: AdtHTTP, timeoutMs: number): AdtHTTP {
  return {
    request(url: string, options: RequestOptions = {}) {
      const requestedTimeout = options.timeout
      return http.request(url, {
        ...options,
        timeout:
          requestedTimeout && requestedTimeout > 0
            ? Math.min(requestedTimeout, timeoutMs)
            : timeoutMs
      })
    }
  } as AdtHTTP
}

async function withAdtStageTimeout<T>(
  code: string,
  stage: string,
  uri: string,
  timeoutMs: number,
  action: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now()
  try {
    return await action()
  } catch (error) {
    if (!isTimeoutError(error)) throw error
    throw new AdtRequestTimeoutError(code, stage, uri, timeoutMs, Date.now() - startedAt)
  }
}

async function readObjectSource(
  client: ADTClient,
  uri: string,
  options?: SourceReadOptions
): Promise<string> {
  if (!client.httpClient) {
    return client.getObjectSource(uri, options?.version ? { version: options.version } : undefined)
  }
  return withAdtStageTimeout(
    "SOURCE_READ_TIMEOUT",
    "active source read",
    uri,
    SOURCE_READ_TIMEOUT_MS,
    () =>
      requestObjectSource(
        boundedAdtHttp(client.httpClient, SOURCE_READ_TIMEOUT_MS),
        uri,
        options?.version ? { version: options.version } : undefined
      )
  )
}

function isTimeoutError(error: unknown): boolean {
  const pending: unknown[] = [error]
  const seen = new Set<unknown>()
  while (pending.length) {
    const current = pending.shift()
    if (!current || seen.has(current)) continue
    seen.add(current)
    if (typeof current === "string") {
      if (/timeout|timed out|ECONNABORTED|ETIMEDOUT/i.test(current)) return true
      continue
    }
    if (typeof current !== "object") continue
    const record = current as Record<string, unknown>
    if (
      /ECONNABORTED|ETIMEDOUT/i.test(String(record.code ?? "")) ||
      /timeout|timed out/i.test(String(record.message ?? ""))
    ) {
      return true
    }
    pending.push(record.cause, record.parent)
  }
  return false
}

export function writeClientOptions(
  allowUnauthorized: boolean,
  report: (diagnostic: string) => void
): ReturnType<typeof createSSLConfig> & { debugCallback: (data: LogData) => void } {
  return {
    ...standaloneClientOptions(allowUnauthorized),
    debugCallback(data) {
      // The trace always reaches adt-trace.log. Every lock refusal on record (2026-08-14 11:39,
      // four attempts on 2026-09-18 09:18-10:48, 2026-09-25 01:03) was investigated without the request
      // sequence that names the cause, because the only copy was opt-in and switched off. The copy that
      // rides the error message back to the caller stays behind ABAP_MCP_ADT_TRACE, so an ordinary
      // failure still reads short and the file keeps the evidence.
      traceAdtRequest(data, process.env.ABAP_MCP_ADT_TRACE ? report : () => undefined)
      if (data.response.statusCode < 400) return
      const body = sanitizeDiagnosticBody(data.response.body ?? "")
      report(
        `ADT ${data.request.method} ${data.request.uri} returned HTTP ${data.response.statusCode}; stateful=${data.stateful}${body ? `; response=${body}` : ""}`
      )
    }
  }
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12)
}

function sessionFingerprint(headers: Record<string, unknown> | undefined): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(headers ?? {})) {
    const name = key.toLowerCase()
    if (name !== "cookie" && name !== "set-cookie") continue
    const list = Array.isArray(value) ? value.map((entry) => String(entry)) : [String(value ?? "")]
    for (const entry of list) {
      for (const pair of entry.split(/;\s*/)) {
        const separator = pair.indexOf("=")
        if (separator <= 0) continue
        const cookie = pair.slice(0, separator).trim()
        if (!/^SAP_SESSIONID/i.test(cookie)) continue
        parts.push(`${cookie}=${pair.slice(separator + 1).trim()}`)
      }
    }
  }
  // Hash only the session cookie (name plus value), never the whole Cookie header: a stateful handshake
  // alone adds cookies, so a changed header hash would prove nothing. The value is a credential, so only a
  // short SHA-256 is ever emitted.
  return parts.length ? `sha256:${shortHash(parts.join("|"))}` : "none"
}

/**
 * ADT write diagnosis that carries no secrets, enabled only by ABAP_MCP_ADT_TRACE. One line per ADT
 * request: method, URI, query (any lockHandle becomes a short SHA-256, never the handle itself), status,
 * session flag, short hashes of the request Cookie and of any response set-cookie - so two requests can be
 * shown to share one SAP session or not - and short hashes of the lock handle SAP issued and of the one
 * actually sent. Normal runs never reach this.
 */
export function traceAdtRequest(data: LogData, report: (line: string) => void): void {
  const params = Object.entries(data.request.params ?? {})
  const query = params
    .map(([key, value]) =>
      /^lockhandle$/i.test(key)
        ? `${key}=sha256:${shortHash(String(value))}`
        : `${key}=${String(value)}`
    )
    .join("&")
  const sent = params.find(([key]) => /^lockhandle$/i.test(key))?.[1]
  const responseBody = String(data.response.body ?? "")
  const issued = responseBody.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1]
  // SAP assigns the transport when it grants the lock. If that differs from the corrNr the write sends, the
  // save can be refused while the handle itself is perfectly valid, and the record count shows which objects
  // SAP believes it locked. Both are ordinary transport metadata, not credentials.
  const lockRequest = responseBody.match(/<CORRNR>([^<]*)<\/CORRNR>/)?.[1]
  const lockRecords = (responseBody.match(/<DATA>/g) ?? []).length
  // The lock result's own fields decide whether SAP considers the object really locked and modifiable, and they
  // had never been observed, so summarise them next to the handle.
  const lockFields = lockResponseFields(responseBody)
  const marks = [
    issued ? `lockIssued=sha256:${shortHash(issued)}` : "",
    sent ? `lockSent=sha256:${shortHash(String(sent))}` : "",
    lockRequest ? `lockCorrNr=${lockRequest}` : "",
    lockRecords ? `lockRecords=${lockRecords}` : "",
    lockFields ? `lockFields=${lockFields}` : ""
  ].filter(Boolean)
  const line =
    `ADT-TRACE #${data.id} ${String(data.request.method).toUpperCase()} ${data.request.uri}` +
    `${query ? `?${query}` : ""} -> ${data.response.statusCode} stateful=${data.stateful}` +
    ` requestSession=${sessionFingerprint(data.request.headers)}` +
    ` responseSession=${sessionFingerprint(data.response.headers)}` +
    ` csrf=${tokenFingerprint(data.request.headers)}/${tokenFingerprint(data.response.headers)}` +
    `${marks.length ? ` ${marks.join(" ")}` : ""} ${data.duration}ms`
  report(line)
  appendTraceLine(line)
}

/**
 * Summarise an ADT lock result: element names with short values kept as-is, anything long enough to be a handle
 * or a token reduced to "(long)", and empty elements skipped. The field names and flags are the point; no long
 * value is ever written out, so no handle or token can reach the log.
 */
function lockResponseFields(body: string): string {
  if (!/<LOCK_HANDLE>/.test(body)) return ""
  const fields: string[] = []
  const pattern = /<([A-Za-z_]+)>([^<]*)<\/\1>/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(body)) !== null) {
    const name = match[1] ?? ""
    const value = match[2] ?? ""
    if (/^LOCK_HANDLE$/i.test(name)) continue
    const text = value.trim()
    if (!text) continue
    fields.push(text.length > 12 ? `${name}=(long)` : `${name}=${text}`)
  }
  return fields.slice(0, 14).join(",")
}

/**
 * Whether a CSRF token was carried, and whether SAP issued one, as a short SHA-256 or "none". This matters
 * because the service deliberately continues without a CSRF token when ECC 7.31 authenticates by cookie but
 * omits the token, and that is the one property of the request that a working Eclipse ADT session has and
 * this session may not. The token itself is a credential and is never written out.
 */
function tokenFingerprint(headers: Record<string, unknown> | undefined): string {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() !== "x-csrf-token") continue
    const text = Array.isArray(value) ? value.join("|") : String(value ?? "")
    return text ? `sha256:${shortHash(text)}` : "none"
  }
  return "none"
}

/**
 * The write client hands diagnostics to a single mutable string (the last line wins) and only surfaces it
 * when the operation fails, so a trace line would be lost. Append every line to adt-trace.log under
 * ABAP_MCP_EXPORT_ROOT, or the working directory when that is unset, so the whole lock/save/unlock
 * sequence can be read back afterwards. Tracing must never break a write, so file errors are ignored.
 *
 * The trace runs on every ADT request, not only when a diagnosis was asked for, so the file is rotated
 * at a fixed size and the previous one kept as adt-trace.log.1.
 */
function appendTraceLine(line: string, file = "adt-trace.log"): void {
  const entry = `${new Date().toISOString()} ${line}\n`
  for (const root of [process.env.ABAP_MCP_EXPORT_ROOT, process.cwd()]) {
    if (!root) continue
    const path = `${root}/${file}`
    try {
      try {
        if (statSync(path).size >= 2_000_000) renameSync(path, `${path}.1`)
      } catch {
        // no file yet, or it cannot be renamed: the append below reports the real problem
      }
      appendFileSync(path, entry)
      return
    } catch {
      // the configured export root may not exist yet; the working directory always does
    }
  }
}

/**
 * Raw CAPABILITIES reply capture, enabled only by ABAP_MCP_HELPER_TRACE and written to helper-trace.log.
 *
 * The probe compares the identity a helper declares with the identity that was probed, so a helper that
 * answers without the line and a reply this client cannot read produce the same verdict. Only the reply
 * itself tells them apart, and the standard ADT trace only covers ADT requests, not these SOAP calls. The
 * session cookies are redacted and tracing never breaks a probe.
 */
export function traceHelperProbe(
  helper: string,
  reply: string,
  soapAction: string,
  body: string
): void {
  if (!process.env.ABAP_MCP_HELPER_TRACE) return
  const text = String(body ?? "").replace(
    /(SAP_SESSIONID|MYSAPSSO2|sap-usercontext|Authorization)[^<>\s]*(=[^<>\s;]*)?/gi,
    "$1=<redacted>"
  )
  const compact = text.replace(/\s+/g, " ").slice(0, 300)
  appendTraceLine(
    `HELPER-PROBE helper=${helper} reply=${reply} action=${soapAction || "n/a"} bytes=${text.length} sha256:${shortHash(text)} head=${compact}`,
    "helper-trace.log"
  )
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed) appendTraceLine(`HELPER-PROBE-BODY ${trimmed}`, "helper-trace.log")
  }
}

/**
 * The URI an ADT edit locks: the object's own URI, the flow every recorded deployment used.
 *
 * A function module source write is **not** an ADT lock problem, and the lock target must not be read as
 * one. The 2026-09-18 trace (kept in .cache/verify-repo-4848-exports/adt-trace.log) holds 12 function
 * module source PUTs, all HTTP 423, across four function modules in three function groups - and 97
 * program source PUTs, all HTTP 200, including transported programs whose PUT carries a corrNr. The
 * function module runs include locks on both `.../fmodules/<fm>` and `.../fmodules/<fm>/source/main`
 * (each returns a handle), in one unchanged SAP session, with the handle SAP issued sent straight back
 * - and the PUT is refused anyway. Lock target, session continuity, handle round-trip, corrNr and
 * transport assignment are therefore all excluded; ADT on this 7.31 system refuses the function module
 * source PUT itself. A candidate fix that locked `.../source/main` for function modules was written and
 * falsified by that same trace on 2026-09-25, which is why the default is unchanged here.
 *
 * ABAP_MCP_LOCK_TARGET still selects a target for experiments: `source` locks the resource being written
 * (recorded as refused on 2026-09-18 11:15-11:33, same session, same handle), `fugr` locks the function
 * group (refused 2026-09-18 10:55), `object` is the default.
 */
function lockTargetUri(objectUri: string, sourceUri: string, kind?: string): string {
  const mode = process.env.ABAP_MCP_LOCK_TARGET
  if (mode === "fugr") {
    const group = objectUri.split(/\/fmodules\//i)[0]
    return group && group !== objectUri ? group : objectUri
  }
  if (mode === "source") return sourceUri || objectUri
  void kind
  return objectUri
}

function sanitizeDiagnosticBody(body: string): string {
  return body
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500)
}

function mapUnitTestAlert(alert: {
  kind: string
  title: string
  details: string[]
}): UnitTestAlertInfo {
  return { kind: alert.kind, title: alert.title, details: alert.details }
}

async function searchObjectsForType(
  client: ADTClient,
  pattern: string,
  type: string
): Promise<AbapObjectInfo[]> {
  const matches = await client.searchObject(pattern.toUpperCase(), type)
  return matches.flatMap((raw) => {
    const record = raw as unknown as Record<string, string | undefined>
    const name = record["adtcore:name"]
    const objectType = record["adtcore:type"]
    if (!name || !objectType) return []
    return [
      {
        name,
        type: objectType,
        description: record["adtcore:description"] ?? "",
        package: record["adtcore:packageName"] ?? "",
        systemType: /^[ZY]/.test(name) ? ("CUSTOM" as const) : ("STANDARD" as const),
        uri: record["adtcore:uri"] ?? ""
      }
    ]
  })
}

function classifyObjectSearchFailure(
  error: unknown
): Pick<ObjectTypeSearchResult, "status" | "reason"> {
  const failure = capabilityFailure("repository object search", error)
  if (/unsupported-endpoint/i.test(failure.message)) {
    return {
      status: "unsupported",
      reason: "The SAP system does not expose repository search for this object type."
    }
  }
  if (/forbidden-or-not-authorized/i.test(failure.message)) {
    return {
      status: "forbidden",
      reason: "The SAP user is not authorized to search this repository object type."
    }
  }
  if (/timeout|timed out/i.test(failure.message)) {
    return {
      status: "timeout",
      reason: "The repository object search timed out; absence was not established."
    }
  }
  return {
    status: "error",
    reason: "The repository object search failed; absence was not established."
  }
}

/**
 * The HTTP status an error actually carries.
 *
 * Only an error that carries a real HTTP exchange may contribute a status. `fromError` defaults
 * unknown failures to 500, so trusting it made every local defect look like a server fault - the
 * 18:07 incident was reported as "HTTP 500" for a client-side XML parse crash. A status named inside
 * the message is still accepted, because that is evidence the server said so.
 */
function reportedHttpStatus(error: unknown): number {
  if (isHttpError(error)) {
    const fromExchange = Number((error as { status?: unknown }).status ?? 0)
    if (fromExchange) return fromExchange
  }
  const named = errorText(error).match(/(?:status code|error)\s+(\d{3})/i)?.[1]
  return named ? Number.parseInt(named, 10) : 0
}

export function capabilityFailure(capability: string, error: unknown): Error {
  if (error instanceof InactiveInventoryError || error instanceof VersionHistoryUnavailableError) {
    return new Error(`${capability} capability parser-or-content-type: ${error.message}`)
  }
  // A TypeError/RangeError raised while reading a response is a defect on this side, not an HTTP
  // failure. The 18:07 incident was reported as "request-failed (HTTP 500)" because the library's
  // XML attribute read crashed on a structure document without a root element, which sent the caller
  // looking for a server fault that never happened. Never attribute a status to a local parse crash.
  if (error instanceof TypeError || error instanceof RangeError) {
    return new Error(`${capability} capability parser-or-content-type: ${errorText(error)}`)
  }
  const adtError = fromError(error)
  const message = adtError.message || String(error)
  const status = reportedHttpStatus(error)
  let category = "request-failed"
  if (status === 401 || status === 403) category = "forbidden-or-not-authorized"
  else if (isUnsupportedEndpointStatus(status)) category = "unsupported-endpoint"
  else if (/content handler|content[- ]type|parse|decode|validation/i.test(message)) {
    category = "parser-or-content-type"
  }
  return new Error(
    `${capability} capability ${category}${status ? ` (HTTP ${status})` : ""}: ${message}`
  )
}

/**
 * Map any failure of the version-history read to a stable, structured outcome.
 *
 * A structure document without the version feed relation means ADT offers no history for this
 * resource: that is an answer for the caller, not a request failure. Anything else keeps the
 * capability wording, and a local parse defect never acquires an HTTP status (see
 * `capabilityFailure`).
 */
export function revisionFailure(error: unknown, objectUri: string): Error {
  if (error instanceof VersionHistoryUnavailableError) return error
  const status = reportedHttpStatus(error)
  const unsupportedEndpoint =
    isUnsupportedEndpointStatus(status) || /No URI-Mapping defined/i.test(errorText(error))
  if (/Revision URL not found/i.test(errorText(error)) || unsupportedEndpoint) {
    // No version feed relation, or no handler for the resource at all, is an answer for the caller -
    // not a request failure. ECC 7.31 answers the canonical DDIC structure path
    // /sap/bc/adt/ddic/tables/<name> with HTTP 404 for every table, active or inactive (T000
    // included), and the library reports a resource it cannot map as "No URI-Mapping defined". The
    // caller must be able to tell that apart from a transport fault, so the status is recorded
    // instead of being formatted into a capability error string.
    return new VersionHistoryUnavailableError("VERSION_HISTORY_UNSUPPORTED_FOR_TYPE", {
      objectUri,
      ...(status ? { httpStatus: status } : {}),
      cause: errorText(error)
    })
  }
  return capabilityFailure("version-history", error)
}

export function optimalSourceUri(type: string, uri: string): string {
  if (XML_METADATA_TYPES.has(type)) return uri
  if (uri.endsWith("/source/main") || /\/oo\/classes\/[^/]+\/includes\//.test(uri)) return uri
  // The source service falls back to /source/main for unregistered types such as PROG/I.
  return `${uri.replace(/\/$/, "")}/source/main`
}

export function normalizeAdtUri(uri: string, connectionId: string): string {
  const trimmed = uri.trim()
  const prefix = `adt://${connectionId.toLowerCase()}`
  const normalized = trimmed.toLowerCase().startsWith(prefix)
    ? trimmed.slice(prefix.length)
    : trimmed
  if (!normalized.startsWith("/sap/bc/adt/")) {
    throw new Error(`Invalid ADT URI: ${uri}`)
  }
  return normalized
}

export function detectTypeFromUri(uri: string): string {
  if (/\/packages\//i.test(uri)) return "DEVC/K"
  if (/\/ddic\/tables\//i.test(uri)) return "TABL/TA"
  if (/\/ddic\/dataelements\//i.test(uri)) return "DTEL/DE"
  if (/\/ddic\/domains\//i.test(uri)) return "DOMA/DD"
  if (/\/ddic\/tabletypes\//i.test(uri)) return "TTYP/DA"
  if (/\/oo\/classes\//i.test(uri)) return "CLAS/OC"
  if (/\/oo\/interfaces\//i.test(uri)) return "INTF/OI"
  if (/\/programs\//i.test(uri)) return "PROG/P"
  if (/\/functions\/groups\//i.test(uri)) return "FUGR/F"
  if (/\/functions\//i.test(uri)) return "FUNC/FF"
  return ""
}

function exportNameFromUri(uri: string, type: string): string {
  const normalized = uri.replace(/[?#].*$/, "").replace(/\/source\/.*$/i, "")
  if (/\/includes\//i.test(normalized)) {
    return decodeURIComponent(normalized.split("/includes/").at(-1) ?? "").toUpperCase()
  }
  if (type === "FUNC/FF") {
    return decodeURIComponent(normalized.split("/fmodules/").at(-1) ?? "").toUpperCase()
  }
  const name = decodeURIComponent(normalized.split("/").filter(Boolean).at(-1) ?? "").toUpperCase()
  if (!name) throw new Error(`Could not determine object name from ${uri}`)
  return name
}

function exportPath(base: string, type: string, name: string): string {
  return [base, safeExportSegment(type.replace("/", "_")), safeExportSegment(name)]
    .filter(Boolean)
    .join("/")
}

function safeExportSegment(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
}

export interface DdicClient {
  getObjectSource(uri: string): Promise<string>
  runQuery(sql: string, rowNumber?: number, decode?: boolean): Promise<{ values: unknown[] }>
}

type QueryRow = Record<string, unknown>

export async function readDictionaryObject(
  client: DdicClient,
  object: AbapObjectInfo
): Promise<SourceResult | undefined> {
  if (object.type === "TTYP/DA" || object.type === "TTYP") {
    try {
      const source = await readTableType(client, object.name)
      return source
        ? {
            source: `Complete Structure for ${object.name} (Table Type from DD40L/DD40T):\n\n${source}`,
            uriUsed: "DD Tables Query",
            kind: "dictionary"
          }
        : undefined
    } catch {
      return undefined
    }
  }
  if (!object.type.startsWith("TABL")) return undefined

  let mainStructure = ""
  let uriUsed = "DD Tables Query"
  try {
    uriUsed = optimalSourceUri("TABL/TA", object.uri)
    mainStructure = await client.getObjectSource(uriUsed)
  } catch {
    try {
      mainStructure = await readTableFields(client, object.name)
    } catch {
      return undefined
    }
  }
  let appends: Array<{ name: string; fields: number }> = []
  try {
    appends = await readAppendStructures(client, object.name)
  } catch {
    // Append metadata is optional; preserve the main table structure.
  }
  let source =
    `Complete Table Structure for ${sanitizeObjectName(object.name)} (SE11-like, includes ALL append structures):\n` +
    ` Append Structures Found: ${appends.length}\n\n`
  if (mainStructure) source += `MAIN TABLE STRUCTURE:\n${mainStructure}\n`
  if (appends.length) {
    source += `\nALL APPEND STRUCTURES (${appends.length}):\n`
    source += appends.map((append) => `• ${append.name} (${append.fields} fields)`).join("\n")
    source += "\n"
  }
  return {
    source,
    uriUsed,
    kind: "dictionary",
    appendCount: appends.length
  }
}

async function readDictionaryFallback(
  client: DdicClient,
  object: AbapObjectInfo
): Promise<SourceResult | undefined> {
  let source = ""
  if (object.type === "DTEL/DE" || object.type === "DTEL") {
    source = await readDataElement(client, object.name)
  } else if (object.type === "DOMA/DD" || object.type === "DOMA") {
    source = await readDomain(client, object.name)
  }
  return source ? { source, uriUsed: "DD Tables Query", kind: "dictionary" } : undefined
}

export function sanitizeObjectName(name: string): string {
  const sanitized = name.trim().toUpperCase()
  if (!/^[A-Z0-9_/%]+$/.test(sanitized) || sanitized.length > 120) {
    throw new Error(`Invalid object name: ${name}`)
  }
  return sanitized
}

async function rows(client: DdicClient, sql: string, limit: number): Promise<QueryRow[]> {
  const result = await client.runQuery(sql, limit, true)
  return result.values as QueryRow[]
}

async function readTableType(client: DdicClient, name: string): Promise<string> {
  const safe = sanitizeObjectName(name)
  const result = await rows(
    client,
    `SELECT l~TYPENAME, l~ROWTYPE, l~ROWKIND, l~DATATYPE, l~LENG, l~DECIMALS, t~DDTEXT FROM DD40L AS l INNER JOIN DD40T AS t ON l~TYPENAME = t~TYPENAME WHERE l~TYPENAME = '${safe}' AND l~AS4LOCAL = 'A' AND t~DDLANGUAGE = 'E' AND t~AS4LOCAL = 'A'`,
    100
  )
  if (!result.length) return ""
  return (
    "Table Type from DD40L/DD40T:\n" +
    result
      .map((row) => {
        let text = `Type Name: ${value(row.TYPENAME)}\n`
        if (row.DDTEXT) text += `Description: ${value(row.DDTEXT)}\n`
        text += `Line Type (ROWTYPE): ${value(row.ROWTYPE)}\nRow Kind: ${value(row.ROWKIND)}\n`
        if (row.DATATYPE) {
          text += `Data Type: ${value(row.DATATYPE)}`
          if (row.LENG) text += `(${value(row.LENG)})`
          if (row.DECIMALS) text += ` DECIMALS ${value(row.DECIMALS)}`
          text += "\n"
        }
        return `${text}\n This is a table type that references line type ${value(row.ROWTYPE)}. To see the actual fields, query the line type structure.`
      })
      .join("")
  )
}

async function readTableFields(client: DdicClient, name: string): Promise<string> {
  const safe = sanitizeObjectName(name)
  const result = await rows(
    client,
    `SELECT TABNAME, FIELDNAME, ROLLNAME, DOMNAME, POSITION, KEYFLAG, MANDATORY, CHECKTABLE, INTTYPE, INTLEN, PRECFIELD, ROUTPUTLEN, DATATYPE, LENG, OUTPUTLEN, DECIMALS, DDTEXT, LOWERCASE, SIGNFLAG, LANGFLAG, VALEXI, ENTITYTAB, CONVEXIT FROM DD03M WHERE TABNAME = '${safe}' AND DDLANGUAGE = 'E' ORDER BY POSITION`,
    1000
  )
  if (!result.length) return ""
  return (
    "Fields from DD03M (Data Dictionary with Text):\n" +
    result
      .map((row) => {
        let text = `${value(row.FIELDNAME)}: ${value(row.INTTYPE || row.DATATYPE)}`
        if (row.INTLEN || row.LENG) text += `(${value(row.INTLEN || row.LENG)})`
        if (row.DECIMALS) text += ` DECIMALS(${value(row.DECIMALS)})`
        if (row.DDTEXT) text += ` - ${value(row.DDTEXT)}`
        if (row.ROLLNAME) text += ` [DE:${value(row.ROLLNAME)}]`
        if (row.DOMNAME) text += ` [DOM:${value(row.DOMNAME)}]`
        if (row.KEYFLAG === "X") text += " [KEY]"
        if (row.MANDATORY === "X") text += " [MANDATORY]"
        return text
      })
      .join("\n") +
    "\n"
  )
}

async function readAppendStructures(
  client: DdicClient,
  name: string
): Promise<Array<{ name: string; fields: number }>> {
  const safe = sanitizeObjectName(name)
  const result = await rows(
    client,
    `SELECT TABNAME, TABCLASS FROM DD02L WHERE SQLTAB = '${safe}' AND TABCLASS = 'APPEND' AND AS4LOCAL = 'A'`,
    100
  )
  return Promise.all(
    result.map(async (row) => {
      const appendName = sanitizeObjectName(value(row.TABNAME))
      try {
        const counts = await rows(
          client,
          `SELECT COUNT(*) AS CNT FROM DD03L WHERE TABNAME = '${appendName}' AND AS4LOCAL = 'A' AND FIELDNAME <> '.INCLUDE'`,
          1
        )
        return { name: appendName, fields: Number.parseInt(value(counts[0]?.CNT || 0), 10) }
      } catch {
        return { name: appendName, fields: 0 }
      }
    })
  )
}

async function readDataElement(client: DdicClient, name: string): Promise<string> {
  const safe = sanitizeObjectName(name)
  const result = await rows(
    client,
    `SELECT ROLLNAME, DOMNAME, DATATYPE, LENG, DECIMALS FROM DD04L WHERE ROLLNAME = '${safe}' AND AS4LOCAL = 'A'`,
    100
  )
  if (!result.length) return ""
  return (
    "Data Element from DD04L:\n" +
    result
      .map((row) => {
        let text = `Element: ${value(row.ROLLNAME)}\nDomain: ${value(row.DOMNAME)}\nData Type: ${value(row.DATATYPE)}(${value(row.LENG)})`
        if (row.DECIMALS) text += ` DECIMALS ${value(row.DECIMALS)}`
        return `${text}\n`
      })
      .join("")
  )
}

async function readDomain(client: DdicClient, name: string): Promise<string> {
  const safe = sanitizeObjectName(name)
  const result = await rows(
    client,
    `SELECT DOMNAME, DATATYPE, LENG, DECIMALS FROM DD01L WHERE DOMNAME = '${safe}' AND AS4LOCAL = 'A'`,
    10
  )
  if (!result.length) return ""
  const row = result[0]!
  let source = `Domain from DD01L:\nDomain: ${value(row.DOMNAME)}\nData Type: ${value(row.DATATYPE)}(${value(row.LENG)})`
  if (row.DECIMALS) source += ` DECIMALS ${value(row.DECIMALS)}`
  return `${source}\n`
}

function value(input: unknown): string {
  return input === undefined || input === null ? "" : String(input)
}
