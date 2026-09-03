import type { TransportRequest, TransportsOfUser } from "abap-adt-api"
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

export interface AbapObjectInfo {
  name: string
  type: string
  description: string
  package: string
  systemType: "STANDARD" | "CUSTOM"
  uri: string
}

export interface SourceResult {
  source: string
  uriUsed: string
  kind?: "source" | "dictionary"
  appendCount?: number
}

export interface EnhancementInfo {
  name: string
  startLine: number
  uri?: string | undefined
  source?: string | undefined
}

export interface ConnectionDetails {
  url: string
  client: string
  language: string
  username: string
  remoteFunctionAllowlist: string[]
}

export interface SapHelperRequest {
  operation: "PING" | "VALIDATE_TARGET"
  objectType?: string | undefined
  objectName?: string | undefined
}

export interface SapHelperResult {
  status: string
  code: string
  message: string
  version: string
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
  | "READ_SCREEN"
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
  | "INSPECT_REPOSITORY_ASSIGNMENT"
  | "READ_TEXT_ELEMENTS"
  | "MERGE_TEXT_ELEMENTS"
  | "READ_MESSAGE_CLASS"
  | "CREATE_MESSAGE_CLASS"
  | "UPDATE_MESSAGE_CLASS"
  | "READ_TRANSPORT_DETAILS"

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
  | "READ_DOMAIN"
  | "UPSERT_DOMAIN"
  | "READ_DATA_ELEMENT"
  | "UPSERT_DATA_ELEMENT"
  | "READ_STRUCTURE"
  | "UPSERT_STRUCTURE"
  | "READ_TRANSPARENT_TABLE"
  | "CREATE_TRANSPARENT_TABLE"
  | "READ_TABLE_TYPE"
  | "UPSERT_TABLE_TYPE"
  | "DELETE_DOMAIN"
  | "DELETE_DATA_ELEMENT"
  | "DELETE_STRUCTURE"
  | "DELETE_TABLE_TYPE"

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
}

export interface SapDdicResult extends SapHelperResult {
  packageName: string
  objectVersion: string
  recordedRequest: string
  header: SapStructureRow
  fixedValues: SapStructureRow[]
  fields: SapStructureRow[]
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
  name: string
  type?: string | undefined
  description?: string | undefined
  packageName?: string | undefined
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
    executionTime: number
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
}

export interface SourceMutationInfo {
  fileUri: string
  sourceUri: string
  objectName: string
  oldLineCount: number
  newLineCount: number
  transportNumber: string
  activation: ActivationInfo
}

export interface CreateObjectRequest {
  objectType: string
  name: string
  description: string
  packageName?: string | undefined
  parentName?: string | undefined
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
  connectionIds(): string[]
  connectionDetails(connectionId: string): ConnectionDetails
  callSapHelper(connectionId: string, request: SapHelperRequest): Promise<SapHelperResult>
  callSapRepository(
    connectionId: string,
    request: SapRepositoryRequest
  ): Promise<SapRepositoryResult>
  callSapDdic(connectionId: string, request: SapDdicRequest): Promise<SapDdicResult>
  searchObjects(
    connectionId: string,
    pattern: string,
    types: string[] | undefined,
    maxResults: number
  ): Promise<AbapObjectInfo[]>
  readSource(connectionId: string, object: AbapObjectInfo): Promise<SourceResult>
  readSourceByUri(connectionId: string, uri: string): Promise<SourceResult>
  readEnhancements(
    connectionId: string,
    objectUri: string,
    includeSource?: boolean
  ): Promise<EnhancementInfo[]>
  usageReferences(
    connectionId: string,
    uri: string,
    line: number,
    character: number
  ): Promise<UsageReferenceInfo[]>
  usageReferenceSnippets(
    connectionId: string,
    references: UsageReferenceInfo[]
  ): Promise<UsageSnippetInfo[]>
  revisions(connectionId: string, objectUri: string): Promise<RevisionInfo[]>
  runQuery(connectionId: string, sql: string, maxRows: number): Promise<Record<string, unknown>[]>
  listUserTransports(connectionId: string, user: string): Promise<TransportsOfUser>
  transportDetails(connectionId: string, transportNumber: string): Promise<TransportRequest>
  exportResource(
    connectionId: string,
    source: string,
    objectType?: string
  ): Promise<ExportResourceInfo>
  discoverySnapshot(connectionId: string): Promise<DiscoverySnapshotInfo>
  diagnostics(connectionId: string, fileUri: string): Promise<DiagnosticInfo[]>
  runAtc(connectionId: string, objectUri: string): Promise<AtcResultInfo>
  atcDocumentation(connectionId: string, docUri: string): Promise<string>
  runUnitTests(connectionId: string, objectUri: string): Promise<UnitTestClassInfo[]>
  replaceSource(
    connectionId: string,
    fileUri: string,
    oldString: string,
    newString: string,
    transportNumber?: string
  ): Promise<SourceMutationInfo>
  activateSource(connectionId: string, fileUri: string): Promise<ActivationInfo>
  createObject(connectionId: string, request: CreateObjectRequest): Promise<ObjectCreationInfo>
  deleteObject(connectionId: string, object: AbapObjectInfo, transportNumber: string): Promise<void>
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
