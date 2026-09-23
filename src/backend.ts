import type { TransportRequest, TransportsOfUser } from "abap-adt-api"
import type { SmartformRequest, SmartformResponse } from "./smartforms.js"
import type { WhereUsedRequestTrace } from "./where-used-request.js"
import type {
  DebugBreakpointInfo,
  DebugSessionInfo,
  DebugSessionRequest,
  DebugStackFrameInfo,
  DebugStepInfo,
  DebugStepRequest,
  DebugVariableInfo,
  DebugVariableRequest
} from "./debug-manager.js"

export interface TransportCleanupEntry {
  pgmid: string
  type: string
  name: string
  position: string
  wbType?: string | undefined
}

export interface AbapObjectInfo {
  name: string
  type: string
  description: string
  package: string
  systemType: "STANDARD" | "CUSTOM"
  uri: string
}

export interface ObjectTypeSearchResult {
  requestedType: string
  status: "available" | "unsupported" | "forbidden" | "timeout" | "error"
  objects: AbapObjectInfo[]
  reason?: string | undefined
}

export interface SourceResult {
  source: string
  uriUsed: string
  kind?: "source" | "dictionary"
  appendCount?: number
}

export interface SourceReadOptions {
  version?: "active"
}

export interface EnhancementInfo {
  name: string
  type: string
  version: string
  elementId: string
  fullname: string
  mode: string
  replacing: boolean
  startLine?: number | undefined
  startColumn?: number | undefined
  uri?: string | undefined
  positionUri?: string | undefined
  source?: string | undefined
  enhancedObject?:
    | {
        uri: string
        type: string
        name: string
      }
    | undefined
}

export interface ConnectionDetails {
  url: string
  client: string
  language: string
  username: string
  remoteFunctionAllowlist: string[]
}

export interface SapHelperRequest {
  /** PING, VALIDATE_TARGET and CAPABILITIES are probes. WRITE_FUNCTION_SOURCE and
   *  PATCH_FUNCTION_INTERFACE are the two write operations the base helper
   *  Z_ORVANTA_MCP_EXECUTE serves directly, because the native ADT lock/save path fails on this
   *  platform with HTTP 423 "invalid lock handle". On SAP_BASIS 7.31 PATCH_FUNCTION_INTERFACE
   *  reaches only the parameter documentation tables; it has no interface-parameter write path
   *  because RPY_FUNCTIONMODULE_UPDATE does not exist on that release. */
  operation:
    | "PING"
    | "VALIDATE_TARGET"
    | "CAPABILITIES"
    | "WRITE_FUNCTION_SOURCE"
    | "PATCH_FUNCTION_INTERFACE"
  objectType?: string | undefined
  objectName?: string | undefined
  /** Function group that must own the target object of a write operation. */
  program?: string | undefined
  packageName?: string | undefined
  transportNumber?: string | undefined
  /** Reviewed digest (lowercase sha256) the helper compares against the state it reads while
   *  holding the lock: the body digest for WRITE_FUNCTION_SOURCE, the interface fingerprint for
   *  PATCH_FUNCTION_INTERFACE. */
  expectedVersion?: string | undefined
  /** WRITE_FUNCTION_SOURCE: the complete replacement function body, without the
   *  FUNCTION/ENDFUNCTION boundaries. PATCH_FUNCTION_INTERFACE: the `kind|index|property|value`
   *  payload rows, lowercase kinds for the expected snapshot and uppercase kinds for the desired
   *  interface definition. */
  source?: string[] | undefined
}

export interface SapHelperResult {
  status: string
  code: string
  message: string
  version: string
  /**
   * IT_SOURCE rows returned with the reply. Only PATCH_FUNCTION_INTERFACE uses them: a rejected
   * patch answers with bounded `D|<section>|EXPECTED/ACTUAL` difference rows instead of a
   * truncated message, so the caller can name the exact mismatching field.
   */
  source?: string[] | undefined
}

/**
 * Helper self-description states.
 *
 * - `self-described`: the helper answered `CAPABILITIES` with a well-formed payload whose
 *   `HELPER|<funcname>` identity matches the probed helper.
 * - `operation-scoped`: the helper answered, but not with a usable `CAPABILITIES` payload.
 *   An un-upgraded helper rejects the unknown opcode with status `E` and code
 *   `OPERATION_NOT_SUPPORTED` (verified in `scripts/bootstrap-sap-helper.ps1`), so only the
 *   protocol version of the operation that was actually executed is known.
 * - `absent`: no structured helper response was received at all.
 */
export type SapHelperAttestation = "self-described" | "operation-scoped" | "absent"

export interface SapHelperCapabilities {
  helper: string
  minProtocol: string | null
  maxProtocol: string | null
  operations: Array<{ opcode: string; since: string; write: boolean }>
  scopes: Array<{ scope: string; enabled: boolean }>
  sourceHash: string | null
  packageName: string | null
  transport: string | null
  host: string | null
  observedAt: string
  attestation: SapHelperAttestation
  /**
   * Diagnosis for a non-`self-described` attestation (identity mismatch or probe failure).
   * Never a capability claim; absent for the plain operation-scoped fallback.
   */
  detail?: string | undefined
}

export type RemoteFunctionValue = string | SapStructureRow | SapStructureRow[]

export interface RemoteFunctionParameterShape {
  name: string
  kind: "scalar" | "structure" | "table"
  fields?: string[] | undefined
}

export interface RemoteFunctionRequest {
  functionName: string
  inputParameters: Record<string, RemoteFunctionValue>
  outputParameters: RemoteFunctionParameterShape[]
}

export interface RemoteFunctionResult {
  outputs: Record<string, RemoteFunctionValue>
  fault?:
    | {
        code: string
        name: string
        message: string
      }
    | undefined
}

export type SapRepositoryOperation =
  | "CAPABILITIES"
  | "READ_SCREEN"
  | "READ_CUSTOMER_EXIT_DEFINITION"
  | "READ_CUSTOMER_EXIT_PROJECT"
  | "READ_BTE_CONFIGURATION"
  | "READ_CLASSIC_BADI_DEFINITION"
  | "READ_ENHANCEMENT_IMPL"
  | "CREATE_HOOK_ENHANCEMENT"
  | "CREATE_BADI_ENHANCEMENT"
  | "UPDATE_HOOK_ENHANCEMENT"
  | "UPDATE_BADI_ENHANCEMENT"
  | "MANAGE_ENHANCEMENT_STATE"
  | "DELETE_ENHANCEMENT_IMPL"
  | "MANAGE_CLASSIC_BADI_IMPL"
  | "UPSERT_SCREEN"
  | "PATCH_SCREEN"
  | "READ_GUI_DEFINITION"
  | "PATCH_GUI_DEFINITION"
  | "CREATE_MODULE_POOL"
  | "DELETE_MODULE_POOL"
  | "CREATE_FUNCTION_GROUP"
  | "CREATE_FUNCTION_INCLUDE"
  | "READ_TRANSACTION"
  | "CREATE_TRANSACTION"
  | "DELETE_TRANSACTION"
  | "CREATE_REPORT_TRANSACTION"
  | "READ_FUNCTION_INTERFACE"
  | "CREATE_FUNCTION_MODULE"
  | "PATCH_FUNCTION_INTERFACE"
  // Served by the shared repository body. The service sends it to Z_ORVANTA_MCP_EXECUTE through
  // callSapHelper so that one helper deployment enables the operation; Z_ORVANTA_MCP_DYNPRO_API
  // dispatches the same opcode when the repository channel is used instead.
  | "WRITE_FUNCTION_SOURCE"
  | "INSPECT_REPOSITORY_ASSIGNMENT"
  | "READ_TEXT_ELEMENTS"
  | "MERGE_TEXT_ELEMENTS"
  | "READ_MESSAGE_CLASS"
  | "CREATE_MESSAGE_CLASS"
  | "UPDATE_MESSAGE_CLASS"
  | "DELETE_MESSAGE_CLASS"
  | "READ_TRANSPORT_DETAILS"
  // D7 first shape: SAPscript forms are read in-process by the shared repository body because
  // READ_FORM/READ_TEXT are not remote-enabled. Since 2.8 the body also accepts the form-specific
  // IMPORTING parameters, so the union and the helper capability table must gain the opcode together.
  | "READ_SAPSCRIPT_FORM"
  // D7 second shape: SmartStyles are read in-process by the same shared repository body. Form S
  // uses SSF_READ_STYLE (STXS* family), form P converts a legacy SAPscript style.
  | "READ_SMARTSTYLE"
  | "READ_ADOBE_FORM"

export type SapStructureRow = Record<string, string>

export interface SapScreenComponentOperation {
  operation: "ADD" | "UPDATE" | "REMOVE"
  name: string
  definition?: SapStructureRow | undefined
}

export type SapGuiSection =
  | "STA"
  | "FUN"
  | "MEN"
  | "MTX"
  | "ACT"
  | "BUT"
  | "PFK"
  | "SET"
  | "DOC"
  | "TIT"
  | "BIV"

export interface SapGuiDefinitionPayload {
  expectedVersion: string
  admin: SapStructureRow
  sections: Record<SapGuiSection, SapStructureRow[]>
}

export interface SapRepositoryRequest {
  operation: SapRepositoryOperation
  objectType?: string | undefined
  objectName?: string | undefined
  program?: string | undefined
  screen?: string | undefined
  transaction?: string | undefined
  description?: string | undefined
  packageName?: string | undefined
  transportNumber?: string | undefined
  header?: SapStructureRow | undefined
  fields?: SapStructureRow[] | undefined
  flowLogic?: SapStructureRow[] | undefined
  params?: SapStructureRow[] | undefined
  componentOperations?: SapScreenComponentOperation[] | undefined
  guiDefinition?: SapGuiDefinitionPayload | undefined
  source?: string[] | undefined
  expectedVersion?: string | undefined
  /**
   * D7 selectors for the form/text/style reads.
   *
   * Each one is emitted only when a caller actually supplies it. A helper deployed before the 2.8
   * interface does not declare these IMPORTING parameters, and the shared body is reached through
   * one function module for every operation, so sending a selector unconditionally would put an
   * undeclared element in front of a 2.7 body for unrelated operations such as READ_SCREEN.
   */
  textStatus?: string | undefined
  textLanguage?: string | undefined
  textVersion?: string | undefined
  includeSource?: boolean | undefined
  /**
   * D7-4 selectors. Same rule as above: an absent value leaves the SOAP request unchanged.
   *
   * `styleMode` selects the storage family (S = STXS*, P = legacy SAPscript style), `styleActive`
   * selects the ACTIVE key column of the STXS* tables, `styleVariant` narrows to one variant, and
   * `includeCss` asks for the converted CSS body.
   */
  styleMode?: string | undefined
  styleActive?: string | undefined
  styleVariant?: string | undefined
  includeCss?: boolean | undefined
}

export interface SapRepositoryResult extends SapHelperResult {
  header: SapStructureRow
  dynproText: string
  fields: SapStructureRow[]
  flowLogic: SapStructureRow[]
  params: SapStructureRow[]
  transactions: SapStructureRow[]
  guiAttributes: SapStructureRow[]
  source: string[]
}

export type SapDdicOperation =
  | "CAPABILITIES"
  | "READ_DOMAIN"
  | "UPSERT_DOMAIN"
  | "READ_DATA_ELEMENT"
  | "UPSERT_DATA_ELEMENT"
  | "READ_STRUCTURE"
  | "UPSERT_STRUCTURE"
  | "READ_TRANSPARENT_TABLE"
  | "CREATE_TRANSPARENT_TABLE"
  | "APPEND_TRANSPARENT_TABLE_FIELDS"
  | "PATCH_TRANSPARENT_TABLE_FIELDS"
  | "PATCH_TRANSPARENT_TABLE_SETTINGS"
  | "RECOVER_TABLE_CONVERSION"
  | "RESUME_TABLE_ACTIVATION"
  | "READ_TABLE_TYPE"
  | "UPSERT_TABLE_TYPE"
  | "DELETE_DOMAIN"
  | "DELETE_DATA_ELEMENT"
  | "DELETE_STRUCTURE"
  | "DELETE_TRANSPARENT_TABLE"
  | "DELETE_TABLE_TYPE"
  | "READ_SEARCH_HELP"
  | "UPSERT_SEARCH_HELP"
  | "DELETE_SEARCH_HELP"
  | "READ_LOCK_OBJECT"
  | "UPSERT_LOCK_OBJECT"
  | "DELETE_LOCK_OBJECT"
  | "READ_NUMBER_RANGE_OBJECT"
  | "UPSERT_NUMBER_RANGE_OBJECT"
  | "DELETE_NUMBER_RANGE_OBJECT"
  | "READ_MAINTENANCE_VIEW"
  | "UPSERT_MAINTENANCE_VIEW"
  | "DELETE_MAINTENANCE_VIEW"
  | "UPSERT_APPEND_STRUCTURE_FIELDS"

export interface SapDdicRequest {
  operation: SapDdicOperation
  objectName: string
  description?: string | undefined
  packageName?: string | undefined
  transportNumber?: string | undefined
  expectedVersion?: string | undefined
  header?: SapStructureRow | undefined
  fixedValues?: SapStructureRow[] | undefined
  fields?: SapStructureRow[] | undefined
  selectionMethods?: SapStructureRow[] | undefined
  parameters?: SapStructureRow[] | undefined
  fieldAssignments?: SapStructureRow[] | undefined
  lockTables?: SapStructureRow[] | undefined
  lockFields?: SapStructureRow[] | undefined
  /**
   * TNROT text rows of a number range object, keyed LANGU/TXT/TXTSHORT. The helper writes the row of
   * its own logon language in the initial create/update call and every other row with a follow-up
   * text update, so several languages may be sent at once. NROB carries no interval data: number
   * range intervals (NRIV) are out of scope for this service.
   */
  numberRangeTexts?: SapStructureRow[] | undefined
  /**
   * DD26V base tables of a maintenance view, keyed TABNAME/FORTABNAME/FORFIELD/FORDIR. The helper
   * sets VIEWNAME, TABPOS and DDLANGUAGE itself, so the service never sends those key columns.
   * The array is a complete replacement: DD_VIFD_PUT deletes the stored rows of the version it
   * writes before inserting these, so an omitted base table is removed.
   */
  baseTables?: SapStructureRow[] | undefined
  /**
   * DD27P view fields of a maintenance view, keyed TABNAME/FIELDNAME/VIEWFIELD. As with baseTables
   * this is a complete replacement; every other DD27P attribute is derived by the activation.
   */
  viewFields?: SapStructureRow[] | undefined
  /**
   * Field rows of an append structure, keyed FIELDNAME/ROLLNAME and optional type attributes. The
   * helper writes them to the append structure itself and then activates the base table, so the base
   * table's own DD03L rows are never written. The array is a complete replacement of the append
   * structure's field list. Only an append structure (tableClass APPEND) is accepted: the helper
   * rejects a base table name, because DD_TBFD_PUT replaces a table's whole field row set.
   */
  appendFields?: SapStructureRow[] | undefined
}

export interface SapDdicResult extends SapHelperResult {
  metadata: SapStructureRow
  packageName: string
  objectVersion: string
  recordedRequest: string
  header: SapStructureRow
  fixedValues: SapStructureRow[]
  fields: SapStructureRow[]
  selectionMethods: SapStructureRow[]
  parameters: SapStructureRow[]
  fieldAssignments: SapStructureRow[]
  lockTables: SapStructureRow[]
  lockFields: SapStructureRow[]
  /**
   * TNROT rows (LANGU/TXT/TXTSHORT) read back for a number range object. Empty for every other kind.
   */
  numberRangeTexts: SapStructureRow[]
  /**
   * SAP check messages (INOER rows: MSGID/MSGTYPE/MSGNUMBER/MSGVAR1-4/TABLENAME/FIELDNAME/CRITCHANGE)
   * that NUMBER_RANGE_OBJECT_UPDATE reported while applying the change. A warning means the change was
   * applied but SAP flagged a consequence, e.g. an interval-affecting attribute change.
   */
  warnings: SapStructureRow[]
  /**
   * DD26V rows (DDLANGUAGE/VIEWNAME/TABNAME/TABPOS/FORTABNAME/FORFIELD/FORDIR) of a maintenance view.
   * Empty for every other kind.
   */
  baseTables: SapStructureRow[]
  /**
   * DD27P rows of a maintenance view: the identity columns (VIEWFIELD/TABNAME/FIELDNAME) plus the
   * attributes SAP derives from the base tables (KEYFLAG/ROLLNAME/DATATYPE/FLENGTH/DDTEXT/...).
   * Empty for every other kind.
   */
  viewFields: SapStructureRow[]
  /**
   * DD28V rows (selection conditions) of a maintenance view. Read-only: this service neither writes
   * nor deletes selection conditions, so the rows report what SAP already stored.
   */
  selectionConditions: SapStructureRow[]
}

export interface ExportFileInfo {
  relativePath: string
  sourceUri: string
  content: string
}

export interface ExportResourceInfo {
  connectionId: string
  source: string
  files: ExportFileInfo[]
  failures: string[]
}

export interface DiscoveryTemplateLinkInfo {
  rel: string
  template: string
  title?: string | undefined
  type?: string | undefined
}

export interface DiscoveryCollectionInfo {
  href: string
  title?: string | undefined
  templateLinks: DiscoveryTemplateLinkInfo[]
}

export interface DiscoveryWorkspaceInfo {
  title: string
  collections: DiscoveryCollectionInfo[]
}

export interface CoreDiscoveryInfo {
  title: string
  href: string
  collectionTitle: string
  category: string
}

export interface DiscoverySnapshotInfo {
  workspaces: DiscoveryWorkspaceInfo[]
  coreEntries: CoreDiscoveryInfo[]
  resAppClasses: Array<{ name: string; description: string }>
  queryWarning?: string | undefined
}

export interface UsageReferenceInfo {
  uri: string
  objectIdentifier: string
  identifierKind?: "ADT_RIS_URI"
  enclosingObjectName?: string
  name: string
  type?: string | undefined
  description?: string | undefined
  packageName?: string | undefined
}

export interface LegacyUsageReferences {
  engine: "ADT_RIS_WHEREUSED"
  references: UsageReferenceInfo[]
  relationshipTypes: Array<{ trobjtype: string; subtype: string; legacy_type: string }>
  requestTrace?: WhereUsedRequestTrace[]
}

export interface UsageSnippetInfo {
  objectIdentifier: string
  snippets: Array<{
    line?: number | undefined
    content: string
  }>
}

export interface RevisionInfo {
  uri: string
  date: string
  author: string
  version: string
  versionTitle: string
}

export interface DiagnosticInfo {
  uri: string
  line: number
  offset: number
  severity: string
  text: string
}

export interface AtcFindingInfo {
  objectName: string
  objectType: string
  messageTitle: string
  checkTitle: string
  checkId: string
  priority: number
  uri: string
  line: number
  character: number
  exemptionApproval: string
  docUri: string
}

export interface AtcResultInfo {
  variant: string
  findings: AtcFindingInfo[]
  execution?: {
    objectSetIsComplete: boolean
    requestedMaximumVerdicts: number
  }
}

export interface UnitTestAlertInfo {
  kind: string
  title: string
  details: string[]
}

export interface UnitTestClassInfo {
  name: string
  alerts: UnitTestAlertInfo[]
  methods: Array<{
    name: string
    executionTime?: number | null
    alerts: UnitTestAlertInfo[]
  }>
}

export interface ActivationMessageInfo {
  type: string
  line: number
  text: string
  href: string
}

export interface ActivationInfo {
  success: boolean
  messages: ActivationMessageInfo[]
  inactiveObjects: string[]
  attempted?: boolean
}

export interface SourceMutationInfo {
  fileUri: string
  sourceUri: string
  objectName: string
  oldLineCount: number
  newLineCount: number
  transportNumber: string
  activation: ActivationInfo
  sourceFingerprintBefore?: string
  sourceFingerprintAfter?: string
  saveSucceeded?: boolean
  unlockSucceeded?: boolean
  activationAttempted?: boolean
  activationSucceeded?: boolean
  activeFingerprint?: string | null
  inactiveFingerprint?: string | null
  readbackError?: string
}

export interface SourceInspectionInfo {
  sourceUri: string
  objectUri: string
  objectName: string
  activeSource: string
  inactiveSource: string | null
}

export interface CreateObjectRequest {
  objectType: string
  name: string
  description: string
  packageName?: string | undefined
  parentName?: string | undefined
  /**
   * Optional initial source, written as part of the same create operation.
   *
   * Supplying it here rather than through a second `replace_string_in_abap_object` call is what makes
   * the create usable at all on ECC: the first stateful ADT request on a fresh session can leave its
   * edit lock orphaned, after which SAP answers the PUT with "Resource ... is not locked" even though
   * the handle came from the lock it just issued (see the note in `replaceSourceWithClient`). By the
   * time the object exists the session is already settled, so the initial source is written reliably.
   */
  source?: string[] | undefined
  additionalOptions?:
    | {
        serviceDefinition?: string | undefined
        bindingType?: string | undefined
        bindingCategory?: string | undefined
        softwareComponent?: string | undefined
        packageType?: string | undefined
        transportLayer?: string | undefined
        transportRequest?:
          | {
              type: "new" | "existing"
              number?: string | undefined
              description?: string | undefined
            }
          | undefined
      }
    | undefined
}

export interface ObjectCreationInfo {
  connectionId: string
  objectType: string
  objectName: string
  description: string
  packageName: string
  parentName: string
  transportNumber: string
  objectUri: string
  workspaceUri: string
  activation: ActivationInfo
}

export interface MessageClassInfo {
  connectionId: string
  messageClass: string
  description: string
  packageName: string
  masterLanguage: string
  version: string
  messages: Array<{ number: string; text: string }>
}

export interface MessageClassCreationInfo extends MessageClassInfo {
  transportNumber: string
  activation: ActivationInfo
}

export interface MessageClassMutationInfo extends MessageClassInfo {
  transportNumber: string
}

export interface MessageClassDeletionInfo {
  connectionId: string
  messageClass: string
  transportNumber: string
}

export interface TestIncludeCreationInfo {
  connectionId: string
  className: string
  sourceUri: string
  workspaceUri: string
  transportNumber: string
  activation: ActivationInfo
}

export type TextElementObjectType = "PROGRAM" | "CLASS" | "FUNCTION_GROUP"

export interface TextElementInfo {
  id: string
  text: string
  maxLength?: number | undefined
}

export interface TextElementsInfo {
  connectionId: string
  objectName: string
  objectType: TextElementObjectType
  textElements: TextElementInfo[]
}

export interface TextElementMutationInfo extends TextElementsInfo {
  action: "create" | "update"
  changedIds: string[]
  transportNumber: string
  activation: ActivationInfo
}

export interface DumpInfo {
  id: string
  errorType: string
  text: string
}

export interface DumpListInfo {
  available: boolean
  dumps: DumpInfo[]
}

export interface TraceRunInfo {
  id: string
  title: string
  author: string
  published: Date
  runtime: number
  host: string
  objectName: string
  runtimeAbap: number
  runtimeDatabase: number
  runtimeSystem: number
  isAggregated: boolean
  stateValue: string
  stateText: string
  system: string
}

export interface TraceConfigurationInfo {
  id: string
  title: string
  published: Date
  host: string
  admin: string
  tracer: string
  processType: string
  objectType: string
  completedExecutions: number
  maximalExecutions: number
  isAggregated: boolean
}

export interface TraceEntryInfo {
  description: string
  hitCount: number
  netTime: number
  grossTime: number
  callLevel?: number | undefined
  program: string
  context: string
  uri?: string | undefined
}

export interface DebugBreakpointCommand {
  action: "set" | "remove"
  filePath: string
  lineNumbers: number[]
  condition?: string | undefined
}

export interface SapBackend {
  callSmartform(connectionId: string, request: SmartformRequest): Promise<SmartformResponse>
  connectionIds(): string[]
  connectionDetails(connectionId: string): ConnectionDetails
  callSapHelper(connectionId: string, request: SapHelperRequest): Promise<SapHelperResult>
  callSapRepository(
    connectionId: string,
    request: SapRepositoryRequest
  ): Promise<SapRepositoryResult>
  callSapDdic(connectionId: string, request: SapDdicRequest): Promise<SapDdicResult>
  /**
   * Probe one installed helper for its `CAPABILITIES` self-description.
   *
   * Implementations must not throw: an unreachable helper is `absent` and a helper that
   * answers without a usable self-description (an un-upgraded helper returns
   * `OPERATION_NOT_SUPPORTED`) is `operation-scoped`, so a capability report can never fail
   * as a whole because one helper is old.
   *
   * The frozen protocol carries no expected version: `iv_expected_version` already means the
   * caller's expected object version for optimistic concurrency in the DDIC and repository
   * helpers, so the service compares the required minimum protocol locally.
   */
  probeHelperCapabilities(connectionId: string, helper: string): Promise<SapHelperCapabilities>
  searchObjects(
    connectionId: string,
    pattern: string,
    types: string[] | undefined,
    maxResults: number
  ): Promise<AbapObjectInfo[]>
  searchObjectTypes(
    connectionId: string,
    pattern: string,
    types: string[],
    maxResultsPerType: number
  ): Promise<ObjectTypeSearchResult[]>
  readSource(
    connectionId: string,
    object: AbapObjectInfo,
    options?: SourceReadOptions
  ): Promise<SourceResult>
  readSourceByUri(connectionId: string, uri: string): Promise<SourceResult>
  inspectSource(connectionId: string, fileUri: string): Promise<SourceInspectionInfo>
  readEnhancements(
    connectionId: string,
    objectUri: string,
    includeSource?: boolean
  ): Promise<EnhancementInfo[]>
  usageReferences(
    connectionId: string,
    uri: string,
    line: number,
    character: number,
    source?: string
  ): Promise<UsageReferenceInfo[] | LegacyUsageReferences>
  usageReferenceSnippets(
    connectionId: string,
    references: UsageReferenceInfo[]
  ): Promise<UsageSnippetInfo[]>
  revisions(connectionId: string, objectUri: string): Promise<RevisionInfo[]>
  runQuery(
    connectionId: string,
    sql: string,
    maxRows: number,
    options?: { allowScopedFallback: boolean }
  ): Promise<Record<string, unknown>[]>
  listUserTransports(connectionId: string, user: string): Promise<TransportsOfUser>
  transportDetails(connectionId: string, transportNumber: string): Promise<TransportRequest>
  cleanupTransportEntries(
    connectionId: string,
    taskNumber: string,
    parentTransportNumber: string,
    entries: TransportCleanupEntry[]
  ): Promise<void>
  inactiveObjectInventory?(
    connectionId: string
  ): Promise<import("./inactive-inventory.js").InactiveInventory>
  exportResource(
    connectionId: string,
    source: string,
    objectType?: string
  ): Promise<ExportResourceInfo>
  discoverySnapshot(connectionId: string): Promise<DiscoverySnapshotInfo>
  diagnostics(connectionId: string, fileUri: string): Promise<DiagnosticInfo[]>
  runAtc(connectionId: string, objectUri: string): Promise<AtcResultInfo>
  inspectAtc(connectionId: string): Promise<import("./native-atc.js").AtcPrecheckInfo>
  atcDocumentation(connectionId: string, docUri: string): Promise<string>
  runUnitTests(connectionId: string, objectUri: string): Promise<UnitTestClassInfo[]>
  replaceSource(
    connectionId: string,
    fileUri: string,
    oldString: string,
    newString: string,
    transportNumber?: string,
    expectedSourceFingerprint?: string,
    recoverInactiveSource?: boolean
  ): Promise<SourceMutationInfo>
  activateSource(connectionId: string, fileUri: string): Promise<ActivationInfo>
  createObject(connectionId: string, request: CreateObjectRequest): Promise<ObjectCreationInfo>
  deleteObject(
    connectionId: string,
    object: AbapObjectInfo,
    transportNumber: string,
    expectedFingerprint: string
  ): Promise<string>
  sourceObjectExists(connectionId: string, object: AbapObjectInfo): Promise<boolean>
  readMessageClass(connectionId: string, messageClass: string): Promise<MessageClassInfo>
  createMessageClass(
    connectionId: string,
    messageClass: string,
    description: string,
    messages: Array<{ number: string; text: string }>,
    packageName: string,
    transportNumber: string
  ): Promise<MessageClassCreationInfo>
  updateMessageClass(
    connectionId: string,
    messageClass: string,
    expectedVersion: string,
    messages: Array<{ number: string; text: string }>,
    packageName: string,
    transportNumber: string
  ): Promise<MessageClassMutationInfo>
  deleteMessageClass(
    connectionId: string,
    messageClass: string,
    expectedVersion: string,
    packageName: string,
    transportNumber: string
  ): Promise<MessageClassDeletionInfo>
  createTestInclude(connectionId: string, className: string): Promise<TestIncludeCreationInfo>
  readTextElements(
    connectionId: string,
    objectName: string,
    objectType: TextElementObjectType
  ): Promise<TextElementsInfo>
  writeTextElements(
    connectionId: string,
    objectName: string,
    objectType: TextElementObjectType,
    action: "create" | "update",
    textElements: TextElementInfo[]
  ): Promise<TextElementMutationInfo>
  callRemoteFunction(
    connectionId: string,
    request: RemoteFunctionRequest
  ): Promise<RemoteFunctionResult>
  listDumps(connectionId: string): Promise<DumpListInfo>
  listTraceRuns(connectionId: string): Promise<TraceRunInfo[]>
  listTraceConfigurations(connectionId: string): Promise<TraceConfigurationInfo[]>
  traceHitList(connectionId: string, traceId: string): Promise<TraceEntryInfo[]>
  traceStatements(connectionId: string, traceId: string): Promise<TraceEntryInfo[]>
  debugSession(connectionId: string, request: DebugSessionRequest): Promise<DebugSessionInfo>
  debugStatus(connectionId: string): DebugSessionInfo
  debugBreakpoints(
    connectionId: string,
    request: DebugBreakpointCommand
  ): Promise<DebugBreakpointInfo>
  debugStack(connectionId: string, threadId: number): Promise<DebugStackFrameInfo[]>
  debugVariables(connectionId: string, request: DebugVariableRequest): Promise<DebugVariableInfo>
  debugStep(connectionId: string, request: DebugStepRequest): Promise<DebugStepInfo>
  close(): Promise<void>
}

export const DEFAULT_OBJECT_TYPES = [
  "FUNC",
  "CLAS",
  "TABL",
  "PROG",
  "INTF",
  "DTEL",
  "DDLS",
  "DOMA",
  "TTYP",
  // ADT media type for search helps is SHLP/DH; repository search uses the short code, matching
  // the DDIC delete tool's objectType enum and the DDIC helper's searchHelp objectKind.
  "SHLP",
  "ENQU",
  "MSAG",
  "FUGR",
  "DEVC",
  "TRAN",
  "VIEW",
  "SICF",
  "WDYN",
  "SPRX",
  "XSLT",
  "TRANSFORMATIONS",
  "SUSH",
  "SUSC",
  "PINF",
  "ENHC",
  "ENHO",
  "ENHS",
  "BADI",
  "BADII",
  "SAMC",
  "SAPC",
  "SFSW",
  "SFBF",
  "SFBS",
  "JOBD",
  "NROB",
  "SUSO",
  "BDEF",
  "SRVB"
] as const
