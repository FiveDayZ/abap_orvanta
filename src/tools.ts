import { resolve } from "node:path"
import {
  prepareTransportDelivery,
  deliveryObjectSchema,
  inactiveTargetSchema
} from "./transport-delivery.js"
import {
  previewConfiguration,
  CONFIGURATION_TABLE,
  CONFIGURATION_MODE_DOMAIN
} from "./configuration-preview.js"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type { TransportRequest } from "abap-adt-api"
import type {
  ActivationMessageInfo,
  AbapObjectInfo,
  AtcFindingInfo,
  CreateObjectRequest,
  DumpInfo,
  MessageClassInfo,
  RemoteFunctionParameterShape,
  RemoteFunctionResult,
  RemoteFunctionValue,
  RevisionInfo,
  SapBackend,
  SapDdicOperation,
  SapDdicResult,
  SapGuiSection,
  SapRepositoryResult,
  SapStructureRow,
  TextElementInfo,
  TextElementObjectType,
  TraceEntryInfo,
  TraceRunInfo
} from "./backend.js"
import type { DebugStepRequest, DebugVariableRequest } from "./debug-manager.js"
import { writeDiscoveryExport, writeResourceExport } from "./export.js"
import type { InvocationReceiptStore, InvocationReservation } from "./invocation-receipts.js"
import { buildCapabilityReport } from "./capabilities.js"
import { collectSystemInfo } from "./system-info.js"
import { previewSourceChanges, sourcePreflightSchema } from "./source-preflight.js"
import type { z } from "zod"
import { rfcValueContract, validateRfcValue, type RfcValueContract } from "./rfc-values.js"
import { parseSimpleTableSelect, readAbapTable } from "./table-query.js"
import { checkFailure, checkQuality } from "./quality-checks.js"
import { collectWhereUsed, formatWhereUsed, type WhereUsedInput } from "./where-used.js"
import { formatSciResult, SCI_HELPER, SCI_HELPER_FINGERPRINT, type SciInput } from "./sci.js"
import {
  formatSciV2Result,
  SCI_V2_HELPER,
  SCI_V2_FINGERPRINT,
  sciTargetSchema,
  formatSciE2Result,
  SCI_E2_HELPER,
  SCI_E2_FINGERPRINT
} from "./sci-v2.js"
import {
  buildRuntimeDiagnosticReport,
  validateRuntimeDiagnosticInput,
  type RuntimeDiagnosticInput
} from "./runtime-diagnostics.js"

interface SearchInput {
  pattern: string
  types: string[]
  maxResults?: number | undefined
  connectionId: string
}

interface SapHelperInput {
  action: "ping" | "validate_target"
  objectType?: string | undefined
  objectName?: string | undefined
  connectionId: string
}

interface ReadScreenInput {
  programName: string
  screenNumber: string
  connectionId: string
}

interface UpsertScreenInput extends ReadScreenInput {
  description: string
  transportNumber: string
  header?: Record<string, string> | undefined
  fields: Array<Record<string, string>>
  flowLogic: string[]
  params?: Array<Record<string, string>> | undefined
}

interface ScreenComponentOperationInput {
  operation: "add" | "update" | "remove"
  name: string
  definition?: Record<string, string> | undefined
}

interface PatchScreenInput extends ReadScreenInput {
  expectedFingerprint: string
  transportNumber: string
  componentOperations?: ScreenComponentOperationInput[] | undefined
  description?: string | undefined
  header?: { NOLI?: string | undefined; NOCO?: string | undefined } | undefined
  flowLogic?: string[] | undefined
  params?: Array<Record<string, string>> | undefined
}

interface ScreenModuleReference {
  name: string
  event: "PBO" | "PAI" | "POH" | "POV" | "UNKNOWN"
  line: number
}

interface ScreenDefinition {
  connectionId: string
  programName: string
  screenNumber: string
  description: string
  header: Record<string, string>
  fields: Array<Record<string, string>>
  flowLogic: string[]
  params: Array<Record<string, string>>
  moduleReferences: ScreenModuleReference[]
  fingerprint: string
}

interface ProgramSourceUnit {
  objectName: string
  objectType: string
  sourceUri: string
  source: string
  depth: number
}

interface ProgramSourceFailure {
  includeName: string
  parentName: string
  reason: string
}

interface ProgramSourceGraph {
  units: ProgramSourceUnit[]
  failures: ProgramSourceFailure[]
  truncated: boolean
}

type GuiSectionName = keyof typeof GUI_SECTION_SPECS

interface ReadGuiDefinitionInput {
  programName: string
  connectionId: string
}

interface GuiRowOperationInput {
  section: GuiSectionName
  operation: "add" | "update" | "remove"
  key: Record<string, string>
  definition?: Record<string, string> | undefined
}

interface PatchGuiDefinitionInput extends ReadGuiDefinitionInput {
  expectedFingerprint: string
  transportNumber: string
  operations: GuiRowOperationInput[]
  adminPatch?:
    | {
        ACTCODE?: string | undefined
        MENCODE?: string | undefined
        PFKCODE?: string | undefined
        DEFAULTACT?: string | undefined
        DEFAULTPFK?: string | undefined
        MOD_LANGU?: string | undefined
      }
    | undefined
}

interface GuiDefinition {
  connectionId: string
  programName: string
  versionToken: string
  metadata: Record<string, string>
  admin: Record<string, string>
  sections: Record<GuiSectionName, Array<Record<string, string>>>
  fingerprint: string
}

const GUI_ADMIN_FIELDS = [
  "ACTCODE",
  "MENCODE",
  "PFKCODE",
  "DEFAULTACT",
  "DEFAULTPFK",
  "MOD_LANGU"
] as const

const GUI_SECTION_SPECS = {
  statuses: {
    kind: "STA",
    keys: ["CODE"],
    fields: ["CODE", "MODAL", "ACTCODE", "PFKCODE", "BUTCODE", "INT_NOTE", "CTXCODE"]
  },
  functions: {
    kind: "FUN",
    keys: ["CODE", "TEXTNO"],
    fields: [
      "CODE",
      "TEXTNO",
      "TYPE",
      "MODIF",
      "TEXT_TYPE",
      "TEXT_NAME",
      "ICON_ID",
      "FUN_TEXT",
      "ICON_TEXT",
      "INFO_TEXT",
      "PATH",
      "SFW_SWITCHID",
      "SFW_SHOWHIDE"
    ]
  },
  menus: {
    kind: "MEN",
    keys: ["CODE", "NO"],
    fields: ["CODE", "NO", "REF_TYPE", "REF_CODE", "REF_NO"]
  },
  menuTexts: {
    kind: "MTX",
    keys: ["CODE"],
    fields: [
      "CODE",
      "TEXT_TYPE",
      "TEXT_NAME",
      "INC_PROG",
      "INC_STATUS",
      "SFW_SWITCHID",
      "SFW_SHOWHIDE",
      "TEXT",
      "PATH",
      "INT_NOTE"
    ]
  },
  activeFunctions: {
    kind: "ACT",
    keys: ["CODE", "NO"],
    fields: ["CODE", "NO", "MENUCODE"]
  },
  buttons: {
    kind: "BUT",
    keys: ["PFK_CODE", "CODE", "NO"],
    fields: ["PFK_CODE", "CODE", "NO", "PFNO"]
  },
  pfKeys: {
    kind: "PFK",
    keys: ["CODE", "PFNO"],
    fields: ["CODE", "PFNO", "FUNCODE", "FUNNO"]
  },
  statusFunctions: {
    kind: "SET",
    keys: ["STATUS", "FUNCTION"],
    fields: ["STATUS", "FUNCTION"]
  },
  documentation: {
    kind: "DOC",
    keys: ["OBJ_TYPE", "OBJ_CODE", "SUB_CODE"],
    fields: ["OBJ_TYPE", "OBJ_CODE", "SUB_CODE", "MODAL", "NORM", "INT_NOTE"]
  },
  titles: {
    kind: "TIT",
    keys: ["CODE"],
    fields: ["CODE", "TEXT"]
  },
  buttonAssignments: {
    kind: "BIV",
    keys: ["OBJ_CODE", "SUB_CODE"],
    fields: ["OBJ_CODE", "SUB_CODE", "FCODE"]
  }
} as const satisfies Record<
  string,
  { kind: SapGuiSection; keys: readonly string[]; fields: readonly string[] }
>

interface CreateModulePoolInput {
  programName: string
  description: string
  packageName: string
  transportNumber: string
  source: string[]
  connectionId: string
}

interface DeleteModulePoolInput {
  programName: string
  packageName: string
  transportNumber: string
  connectionId: string
}

interface ReadTransactionInput {
  transactionCode: string
  connectionId: string
}

interface CreateTransactionInput extends ReadTransactionInput {
  programName: string
  screenNumber: string
  description: string
  packageName: string
  transportNumber: string
}

interface DeleteTransactionInput extends ReadTransactionInput {
  expectedProgramName: string
  expectedFingerprint?: string | undefined
  packageName: string
  transportNumber: string
}

interface CreateReportTransactionInput extends Omit<CreateTransactionInput, "screenNumber"> {
  variant?: string | undefined
}

interface FunctionParameterInput {
  name: string
  typeName: string
  optional?: boolean | undefined
  passByValue?: boolean | undefined
  description?: string | undefined
}

interface FunctionExceptionInput {
  name: string
  description?: string | undefined
}

interface ReadFunctionModuleInput {
  functionName: string
  includeExecutionSupport?: boolean | undefined
  connectionId: string
}

type StructureParameters = Record<string, Record<string, string>>
type TableParameters = Record<string, Array<Record<string, string>>>

interface TestRemoteFunctionModuleInput extends ReadFunctionModuleInput {
  inputParameters: Record<string, string>
  structureInputs?: StructureParameters | undefined
  tableInputs?: TableParameters | undefined
  expectedOutputs?: Record<string, string> | undefined
  expectedStructureOutputs?: StructureParameters | undefined
  expectedTableOutputs?: TableParameters | undefined
  expectedException?: string | undefined
  expectedInterfaceFingerprint?: string | undefined
  acknowledgePotentialSideEffects: true
}

interface InvokeCustomerFunctionModuleInput extends ReadFunctionModuleInput {
  requestId: string
  inputParameters?: Record<string, string> | undefined
  structureInputs?: StructureParameters | undefined
  tableInputs?: TableParameters | undefined
  expectedInterfaceFingerprint: string
  acknowledgePotentialSideEffects: true
}

interface GetCustomerFunctionCallStatusInput {
  requestId: string
  connectionId: string
}

interface FunctionExecutionParameter extends RemoteFunctionParameterShape {
  direction: "import" | "export" | "changing" | "table"
  typeName: string
  optional: boolean
  supported: boolean
  reason?: string | undefined
  maxCharacters?: number
  valueContract?: RfcValueContract
  fieldContracts?: Record<string, RfcValueContract>
}

interface ResolvedRemoteType {
  kind: "scalar" | "structure" | "table"
  fields: string[]
  maxCharacters?: number
  valueContract?: RfcValueContract
  fieldContracts?: Record<string, RfcValueContract>
}

interface FunctionExecutionContract {
  supported: boolean
  reasons: string[]
  parameters: FunctionExecutionParameter[]
}

interface PreparedRemoteFunctionCall {
  connectionId: string
  functionName: string
  definition: ReturnType<typeof functionModuleResult>
  contract: FunctionExecutionContract
  remoteInputs: Record<string, RemoteFunctionValue>
  outputShapes: RemoteFunctionParameterShape[]
  suppliedInputKinds: Map<string, RemoteFunctionParameterShape["kind"]>
  allowedOutputs: Map<string, FunctionExecutionParameter>
}

interface CreateFunctionModuleInput extends ReadFunctionModuleInput {
  functionGroup: string
  description: string
  remoteEnabled: boolean
  importParameters: FunctionParameterInput[]
  exportParameters: FunctionParameterInput[]
  changingParameters: FunctionParameterInput[]
  tableParameters: FunctionParameterInput[]
  exceptions: FunctionExceptionInput[]
  source: string[]
  packageName: string
  transportNumber: string
}

type FunctionParameterDirection = "import" | "export" | "changing" | "table"

type FunctionParameterPatch =
  | ({ operation: "add"; direction: FunctionParameterDirection } & FunctionParameterInput)
  | {
      operation: "rename"
      direction: FunctionParameterDirection
      name: string
      newName: string
    }
  | {
      operation: "update"
      direction: FunctionParameterDirection
      name: string
      typeName?: string | undefined
      optional?: boolean | undefined
      passByValue?: boolean | undefined
      description?: string | undefined
    }
  | { operation: "remove"; direction: FunctionParameterDirection; name: string }

type FunctionExceptionPatch =
  | { operation: "add"; name: string; description?: string | undefined }
  | { operation: "rename"; name: string; newName: string }
  | { operation: "update"; name: string; description: string }
  | { operation: "remove"; name: string }

interface PatchFunctionModuleInterfaceInput extends ReadFunctionModuleInput {
  functionGroup: string
  expectedInterfaceFingerprint: string
  expectedSourceFingerprint: string
  parameterOperations: FunctionParameterPatch[]
  exceptionOperations: FunctionExceptionPatch[]
  packageName: string
  transportNumber: string
  confirmation?: "DESTRUCTIVE_INTERFACE_CHANGE" | undefined
}

interface InspectRepositoryAssignmentInput {
  objectName: string
  objectType: "CLAS/OC" | "INTF/OI" | "FUGR/F" | "FUGR/FF" | "PROG/P" | "PROG/I" | "TRAN"
  connectionId: string
}

interface ReadMessageClassInput {
  messageClass: string
  connectionId: string
}

interface CreateMessageClassInput extends ReadMessageClassInput {
  description: string
  messages: Array<{ number: string; text: string }>
  packageName: string
  transportNumber: string
}

interface UpdateMessageClassInput extends ReadMessageClassInput {
  expectedVersion: string
  operations: Array<{
    operation: "add" | "update" | "remove"
    number: string
    text?: string | undefined
  }>
  packageName: string
  transportNumber: string
}

interface DeleteMessageClassInput extends ReadMessageClassInput {
  expectedVersion: string
  packageName: string
  transportNumber: string
  confirmation: "PERMANENT_DELETE"
}

interface ReadDdicInput {
  objectName: string
  connectionId: string
}

interface UpsertDdicInput extends ReadDdicInput {
  description: string
  packageName: string
  transportNumber: string
  expectedVersion?: string | undefined
}

interface UpsertDomainInput extends UpsertDdicInput {
  dataType: "CHAR" | "NUMC" | "DEC" | "DATS" | "TIMS"
  length: number
  decimals?: number | undefined
  lowercase?: boolean | undefined
  signFlag?: boolean | undefined
  valueTable?: string | undefined
  conversionExit?: string | undefined
  fixedValues?: Array<{ low: string; high?: string | undefined; description: string }> | undefined
}

interface UpsertDataElementInput extends UpsertDdicInput {
  domainName: string
  heading: string
  short: string
  medium: string
  long: string
}

interface UpsertStructureInput extends UpsertDdicInput {
  fields: Array<{ name: string; dataElement: string }>
}

interface CreateTransparentTableInput extends Omit<UpsertDdicInput, "expectedVersion"> {
  deliveryClass: "A" | "C" | "L" | "G" | "E" | "S" | "W"
  dataClass: "APPL0" | "APPL1" | "APPL2"
  dataBrowserMaintenance: "allowed" | "restricted" | "notAllowed"
  sizeCategory?: number | undefined
  fields: Array<{
    name: string
    dataElement: string
    key?: boolean | undefined
  }>
}

interface AppendTransparentTableFieldsInput extends ReadDdicInput {
  expectedVersion: string
  expectedFingerprint: string
  fields: Array<{ name: string; dataElement: string }>
  packageName: string
  transportNumber: string
}

type TransparentTableFieldChange =
  | { action: "remove"; fieldName: string }
  | { action: "rename"; fieldName: string; newName: string }
  | {
      action: "update"
      fieldName: string
      dataElement?: string | undefined
      key?: boolean | undefined
      notNull?: boolean | undefined
    }

interface PatchTransparentTableFieldsInput extends ReadDdicInput {
  expectedVersion: string
  expectedFingerprint: string
  changes: TransparentTableFieldChange[]
  packageName: string
  transportNumber: string
  confirmation: "DESTRUCTIVE_SCHEMA_CHANGE"
  acknowledgeDataLoss: true
}

interface UpsertTableTypeInput extends UpsertDdicInput {
  rowType: string
}

interface DeleteDdicInput extends ReadDdicInput {
  objectType: "DOMA" | "DTEL" | "STRU" | "TTYP" | "TABL"
  expectedVersion: string
  packageName: string
  transportNumber: string
  confirmation: "PERMANENT_DELETE"
  acknowledgeDataLoss?: boolean | undefined
}

interface ObjectInput {
  objectName: string
  objectType?: string | undefined
  connectionId: string
}

interface LinesInput extends ObjectInput {
  methodName?: string | undefined
  startLine?: number | undefined
  lineCount?: number | undefined
}

interface BatchInput {
  requests: Array<{
    objectName: string
    startLine?: number | undefined
    lineCount?: number | undefined
  }>
  connectionId: string
}

interface UriInput {
  uri: string
  startLine?: number | undefined
  lineCount?: number | undefined
  connectionId: string
}

interface SearchLinesInput {
  objectName: string
  searchTerm: string
  contextLines?: number | undefined
  connectionId: string
  isRegexp?: boolean | undefined
  maxObjects?: number | undefined
}

interface WorkspaceUriInput {
  objectName: string
  objectType: string
  connectionId: string
}

interface ObjectUrlInput {
  objectName: string
  objectType?: string | undefined
  connectionId: string
}

interface SystemInfoInput {
  connectionId: string
  includeComponents?: boolean | undefined
}

interface VersionHistoryInput extends ObjectInput {
  action?: "list_versions" | "get_version_source" | "compare_versions" | undefined
  versionNumber?: number | undefined
  version1?: number | undefined
  version2?: number | undefined
  maxVersions?: number | undefined
}

interface DiagnosticsInput {
  fileUri: string
}

interface ReplaceSourceInput {
  fileUri: string
  oldString: string
  newString: string
  transportNumber?: string | undefined
  expectedSourceFingerprint?: string | undefined
}

interface ActivateInput {
  url: string
}

interface CreateObjectInput extends CreateObjectRequest {
  connectionId: string
}

interface DeleteSourceObjectInput {
  objectType: "CLAS/OC" | "INTF/OI" | "PROG/P" | "PROG/I" | "FUGR/F" | "FUGR/I" | "FUGR/FF"
  objectName: string
  parentName?: string | undefined
  expectedFingerprint: string
  packageName: string
  transportNumber: string
  confirmation: "PERMANENT_DELETE"
  connectionId: string
}

interface CreateTestIncludeInput {
  className: string
  connectionId: string
}

interface ManageTextElementsInput {
  objectName: string
  objectType: TextElementObjectType
  action: "read" | "create" | "update"
  textElements?: TextElementInfo[] | undefined
  connectionId: string
}

interface DataQueryInput {
  sql?: string | undefined
  data?: unknown
  displayMode: "internal" | "ui" | "download_to_file"
  webviewId?: string | undefined
  connectionId: string
  title?: string | undefined
  maxRows?: number | undefined
  rowRange?: { start: number; end: number } | undefined
  sortColumns?: Array<{ column: string; direction: "asc" | "desc" }> | undefined
  filters?: Array<{ column: string; value: string }> | undefined
  resetSorting?: boolean | undefined
  resetFilters?: boolean | undefined
  filePath?: string | undefined
  fileType?: "xlsx" | "csv" | undefined
}

interface AtcInput {
  action?: "run_analysis" | "get_documentation" | "check_quality" | "precheck_atc" | undefined
  fileUris?: string[] | undefined
  includeAtc?: boolean | undefined
  maxFindings?: number | undefined
  acknowledgePotentialSideEffects?: true | undefined
  objectName?: string | undefined
  objectType?: string | undefined
  objectUri?: string | undefined
  connectionId?: string | undefined
  useActiveFile?: boolean | undefined
  scope?: "object" | "package" | "transport" | undefined
  docUri?: string | undefined
}

interface UnitTestInput {
  objectName: string
  connectionId: string
  outputFormat?: "text" | "json" | undefined
}

interface DumpInput {
  action: "list_dumps" | "analyze_dump"
  connectionId: string
  dumpId?: string | undefined
  maxResults?: number | undefined
  includeFullContent?: boolean | undefined
}

interface TraceInput {
  action: "list_runs" | "list_configurations" | "analyze_run" | "get_statements" | "get_hitlist"
  connectionId: string
  traceId?: string | undefined
  maxResults?: number | undefined
  includeDetails?: boolean | undefined
}

interface TransportInput {
  action:
    | "get_user_transports"
    | "get_transport_details"
    | "get_transport_objects"
    | "compare_transports"
    | "prepare_delivery"
  connectionId: string
  transportNumber?: string | undefined
  transportNumbers?: string[] | undefined
  user?: string | undefined
  expectedObjects?: z.input<typeof deliveryObjectSchema>[] | undefined
  inactiveTargets?: z.input<typeof inactiveTargetSchema>[] | undefined
}

interface DownloadInput {
  source: string
  target: string
  connectionId?: string | undefined
  objectType?: string | undefined
  overwrite?: boolean | undefined
}

interface DiscoveryInput {
  connectionId: string
}

interface DebugSessionInput {
  connectionId: string
  action?: "start" | "stop" | "status" | "precheck" | undefined
  debugUser?: string | undefined
  terminalMode?: boolean | undefined
}

interface DebugBreakpointInput {
  connectionId: string
  filePath: string
  lineNumbers: number[]
  condition?: string | undefined
  action?: "set" | "remove" | undefined
}

interface DebugStatusInput {
  connectionId: string
}

interface DebugStackInput extends DebugStatusInput {
  threadId?: number | undefined
}

interface DebugVariableInput extends DebugStatusInput {
  threadId?: number | undefined
  frameId: number
  variableName?: string | undefined
  expression?: string | undefined
  rowStart?: number | undefined
  rowCount?: number | undefined
  filter?: string | undefined
  scopeName?: string | undefined
  maxVariables?: number | undefined
  filterPattern?: string | undefined
  expandStructures?: boolean | undefined
  expandTables?: boolean | undefined
}

interface DebugStepInput extends DebugStatusInput {
  threadId?: number | undefined
  stepType: DebugStepRequest["stepType"]
  targetLine?: number | undefined
}

export class ToolService {
  private readonly exportRoot: string

  constructor(
    private readonly backend: SapBackend,
    exportRoot = process.env.ABAP_MCP_EXPORT_ROOT ?? process.cwd(),
    private readonly invocationReceipts?: InvocationReceiptStore | undefined
  ) {
    this.exportRoot = resolve(exportRoot)
  }

  getConnectedSystems(): string {
    const ids = this.backend.connectionIds()
    if (!ids.length) {
      return "No SAP systems are currently connected. User needs to configure a connection first."
    }
    return `Connected SAP systems: ${ids.join(", ")}`
  }

  async getCapabilityReport(input: { connectionId: string }): Promise<string> {
    return buildCapabilityReport(this.backend, input.connectionId)
  }

  async sapHelperStatus(input: SapHelperInput): Promise<string> {
    if (input.action === "validate_target" && (!input.objectType || !input.objectName)) {
      throw new Error("validate_target requires objectType and objectName")
    }
    const result = await this.backend.callSapHelper(input.connectionId, {
      operation: input.action === "ping" ? "PING" : "VALIDATE_TARGET",
      objectType: input.objectType,
      objectName: input.objectName
    })
    return (
      `SAP Helper Result\n` +
      `Connection: ${input.connectionId.toLowerCase()}\n` +
      `Status: ${result.status}\n` +
      `Code: ${result.code}\n` +
      `Message: ${result.message}\n` +
      `Version: ${result.version}`
    )
  }

  async readAbapScreen(input: ReadScreenInput): Promise<string> {
    return JSON.stringify(await this.readScreenDefinition(input), null, 2)
  }

  async upsertAbapScreen(input: UpsertScreenInput): Promise<string> {
    const programName = customerName(input.programName, "programName")
    const screenNumber = dynproNumber(input.screenNumber)
    if (!input.fields.length) throw new Error("fields must contain at least one RPY_DYFATC row")
    if (!input.flowLogic.length) throw new Error("flowLogic must contain at least one D022S line")
    const result = await this.backend.callSapRepository(input.connectionId.toLowerCase(), {
      operation: "UPSERT_SCREEN",
      program: programName,
      screen: screenNumber,
      description: input.description,
      transportNumber: transportNumber(input.transportNumber),
      header: input.header,
      fields: input.fields.map(uppercaseRecord),
      flowLogic: input.flowLogic.map((LINE) => ({ LINE })),
      params: input.params?.map(uppercaseRecord)
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    return (
      `ABAP screen saved and verified\n` +
      `Program: ${programName}\nScreen: ${screenNumber}\n` +
      `Fields: ${result.fields.length}\nFlow lines: ${result.flowLogic.length}\n` +
      `Transport: ${input.transportNumber}\nStatus: ${result.code}`
    )
  }

  async patchAbapScreen(input: PatchScreenInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const current = await this.readScreenDefinition(input)
    const expectedFingerprint = input.expectedFingerprint.toLowerCase()
    if (expectedFingerprint !== current.fingerprint) {
      throw new Error(
        `Screen fingerprint changed: expected ${expectedFingerprint}, current ${current.fingerprint}`
      )
    }
    const operations = input.componentOperations ?? []
    if (
      !operations.length &&
      input.description === undefined &&
      input.header === undefined &&
      input.flowLogic === undefined &&
      input.params === undefined
    ) {
      throw new Error("patch_abap_screen requires at least one explicit screen change")
    }
    if (operations.length > 100) throw new Error("componentOperations must not exceed 100 items")
    if (input.flowLogic && !input.flowLogic.length) {
      throw new Error("flowLogic must contain at least one D022S line")
    }
    const header = input.header ? screenHeaderPatch(input.header) : undefined

    const currentNames = new Set(
      current.fields.map(screenFieldName).filter((name): name is string => Boolean(name))
    )
    const touchedNames = new Set<string>()
    const componentOperations = operations.map((operation) => {
      const name = screenComponentName(operation.name)
      if (touchedNames.has(name)) {
        throw new Error(`Component ${name} has more than one operation in the same patch`)
      }
      touchedNames.add(name)
      const exists = currentNames.has(name)
      if (operation.operation === "add" && exists) {
        throw new Error(`Screen component already exists: ${name}`)
      }
      if (operation.operation !== "add" && !exists) {
        throw new Error(`Screen component does not exist: ${name}`)
      }
      if (
        (operation.operation === "add" || operation.operation === "update") &&
        !operation.definition
      ) {
        throw new Error(`${operation.operation} operation for ${name} requires definition`)
      }
      if (operation.operation === "remove" && operation.definition) {
        throw new Error(`definition is not valid for ${operation.operation} operations: ${name}`)
      }
      const definition = operation.definition ? uppercaseRecord(operation.definition) : undefined
      if (definition) {
        const definedName = definition.NAME ? screenComponentName(definition.NAME) : name
        if (definedName !== name) {
          throw new Error(
            `Component definition name ${definedName} does not match operation name ${name}`
          )
        }
        definition.NAME = name
        validatePublicScreenField(definition)
      }
      if (operation.operation === "add") currentNames.add(name)
      if (operation.operation === "remove") currentNames.delete(name)
      return {
        operation: operation.operation.toUpperCase() as "ADD" | "UPDATE" | "REMOVE",
        name,
        ...(definition ? { definition } : {})
      }
    })
    if (!currentNames.size) throw new Error("A Dynpro screen must retain at least one component")

    const result = await this.backend.callSapRepository(connectionId, {
      operation: "PATCH_SCREEN",
      program: current.programName,
      screen: current.screenNumber,
      transportNumber: transportNumber(input.transportNumber),
      componentOperations,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(header ? { header } : {}),
      ...(input.flowLogic ? { flowLogic: input.flowLogic.map((LINE) => ({ LINE })) } : {}),
      ...(input.params ? { params: input.params.map(uppercaseRecord) } : {})
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    const saved = screenDefinition(connectionId, current.programName, current.screenNumber, result)
    if (saved.fingerprint === current.fingerprint) {
      throw new Error("SAP reported success but the screen definition did not change")
    }
    return JSON.stringify(
      {
        status: "SCREEN_PATCHED",
        transportNumber: input.transportNumber.toUpperCase(),
        previousFingerprint: current.fingerprint,
        ...saved
      },
      null,
      2
    )
  }

  async validateDynproApplication(input: ReadScreenInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const screen = await this.readScreenDefinition(input)
    const object = await this.findOne(connectionId, screen.programName, "PROG/P")
    if (!object || object.name.toUpperCase() !== screen.programName) {
      throw new Error(`Module-pool program does not exist: ${screen.programName}`)
    }
    const sourceGraph = await this.readProgramSourceGraph(connectionId, object)
    const gui = await this.readGuiDefinition(input)
    const validation = validateDynproDefinition(screen, sourceGraph, gui)
    return JSON.stringify(
      {
        connectionId,
        programName: screen.programName,
        screenNumber: screen.screenNumber,
        fingerprint: screen.fingerprint,
        sourceUri: sourceGraph.units[0]?.sourceUri ?? object.uri,
        ...validation
      },
      null,
      2
    )
  }

  async readAbapGuiDefinition(input: ReadGuiDefinitionInput): Promise<string> {
    return JSON.stringify(await this.readGuiDefinition(input), null, 2)
  }

  async patchAbapGuiDefinition(input: PatchGuiDefinitionInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const current = await this.readGuiDefinition(input)
    const expectedFingerprint = input.expectedFingerprint.toLowerCase()
    if (expectedFingerprint !== current.fingerprint) {
      throw new Error(
        `GUI definition fingerprint changed: expected ${expectedFingerprint}, current ${current.fingerprint}`
      )
    }
    if (!input.operations.length) {
      throw new Error("patch_abap_gui_definition requires at least one explicit row operation")
    }
    const sections = structuredClone(current.sections)
    const admin = { ...current.admin }
    let changed = false

    if (input.adminPatch) {
      for (const [rawName, value] of Object.entries(input.adminPatch)) {
        if (value === undefined) continue
        const name = rawName.toUpperCase()
        if (!(GUI_ADMIN_FIELDS as readonly string[]).includes(name)) {
          throw new Error(`Unsupported GUI administration property: ${rawName}`)
        }
        validateGuiValue(name, value)
        if (admin[name] !== value) changed = true
        admin[name] = value
      }
    }

    const touched = new Set<string>()
    for (const operation of input.operations) {
      const spec = GUI_SECTION_SPECS[operation.section]
      if (!spec) throw new Error(`Unsupported GUI definition section: ${operation.section}`)
      const key = normalizeGuiRecord(operation.key, spec.keys, `${operation.section} key`)
      if (Object.keys(key).length !== spec.keys.length) {
        throw new Error(`${operation.section} key must contain exactly: ${spec.keys.join(", ")}`)
      }
      const operationId = `${operation.section}:${spec.keys.map((name) => key[name]).join("|")}`
      if (touched.has(operationId)) {
        throw new Error(`GUI row has more than one operation in the same patch: ${operationId}`)
      }
      touched.add(operationId)
      const rows = sections[operation.section]
      const matches = rows
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => spec.keys.every((name) => row[name] === key[name]))
      if (matches.length > 1)
        throw new Error(`GUI definition contains duplicate key: ${operationId}`)
      const existing = matches[0]
      if (operation.operation === "add" && existing) {
        throw new Error(`GUI row already exists: ${operationId}`)
      }
      if (operation.operation !== "add" && !existing) {
        throw new Error(`GUI row does not exist: ${operationId}`)
      }
      if (operation.operation === "remove") {
        if (operation.definition)
          throw new Error(`remove does not accept definition: ${operationId}`)
        rows.splice(existing!.index, 1)
        changed = true
        continue
      }
      const fields = spec.fields as readonly string[]
      const keys = spec.keys as readonly string[]
      const keyOnlySection = fields.every((field) => keys.includes(field))
      if (
        (!operation.definition || !Object.keys(operation.definition).length) &&
        !(operation.operation === "add" && keyOnlySection)
      ) {
        throw new Error(`${operation.operation} requires a non-empty definition: ${operationId}`)
      }
      const definition = normalizeGuiRecord(
        operation.definition ?? {},
        spec.fields,
        `${operation.section} definition`
      )
      for (const name of spec.keys) {
        if (definition[name] !== undefined && definition[name] !== key[name]) {
          throw new Error(`GUI row key ${name} cannot be changed: ${operationId}`)
        }
      }
      const blankRow = Object.fromEntries(spec.fields.map((name) => [name, ""]))
      const saved = { ...blankRow, ...(existing?.row ?? {}), ...key, ...definition }
      if (operation.operation === "add") {
        rows.push(saved)
        changed = true
      } else if (!isDeepStrictEqual(existing!.row, saved)) {
        rows[existing!.index] = saved
        changed = true
      }
    }
    if (!changed) throw new Error("GUI definition patch does not change the current definition")
    sortGuiSections(sections)
    const rowCount = Object.values(sections).reduce((sum, rows) => sum + rows.length, 0)
    if (rowCount > 2000) throw new Error("GUI definition exceeds the 2000-row write limit")

    const result = await this.backend.callSapRepository(connectionId, {
      operation: "PATCH_GUI_DEFINITION",
      program: current.programName,
      transportNumber: transportNumber(input.transportNumber),
      guiDefinition: {
        expectedVersion: current.versionToken,
        admin,
        sections: guiSectionsByKind(sections)
      }
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    const saved = guiDefinition(connectionId, current.programName, result)
    if (saved.fingerprint === current.fingerprint) {
      throw new Error("SAP reported success but the GUI definition did not change")
    }
    const expectedDefinition = { admin, sections }
    const savedDefinition = { admin: saved.admin, sections: saved.sections }
    if (!isDeepStrictEqual(savedDefinition, expectedDefinition)) {
      const mismatches = valueDifferences(expectedDefinition, savedDefinition)
      throw new Error(
        `SAP GUI definition verification does not match the requested patch:\n${mismatches.join("\n")}`
      )
    }
    return JSON.stringify(
      {
        status: "GUI_DEFINITION_PATCHED",
        transportNumber: input.transportNumber.toUpperCase(),
        previousFingerprint: current.fingerprint,
        ...saved
      },
      null,
      2
    )
  }

  private async readGuiDefinition(input: ReadGuiDefinitionInput): Promise<GuiDefinition> {
    const connectionId = input.connectionId.toLowerCase()
    const programName = customerName(input.programName, "programName")
    const result = await this.backend.callSapRepository(connectionId, {
      operation: "READ_GUI_DEFINITION",
      program: programName
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    return guiDefinition(connectionId, programName, result)
  }

  private async readScreenDefinition(input: ReadScreenInput): Promise<ScreenDefinition> {
    const connectionId = input.connectionId.toLowerCase()
    const programName = customerName(input.programName, "programName")
    const screenNumber = dynproNumber(input.screenNumber)
    const result = await this.backend.callSapRepository(connectionId, {
      operation: "READ_SCREEN",
      program: programName,
      screen: screenNumber
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    return screenDefinition(connectionId, programName, screenNumber, result)
  }

  private async readProgramSourceGraph(
    connectionId: string,
    rootObject: AbapObjectInfo
  ): Promise<ProgramSourceGraph> {
    const maxIncludes = 32
    const maxDepth = 8
    const rootSource = await this.backend.readSource(connectionId, rootObject)
    const graph: ProgramSourceGraph = {
      units: [
        {
          objectName: rootObject.name.toUpperCase(),
          objectType: rootObject.type,
          sourceUri: rootSource.uriUsed,
          source: rootSource.source,
          depth: 0
        }
      ],
      failures: [],
      truncated: false
    }
    const visited = new Set([rootObject.name.toUpperCase()])

    for (let cursor = 0; cursor < graph.units.length; cursor += 1) {
      const parent = graph.units[cursor]!
      for (const includeName of programIncludeNames(parent.source)) {
        if (visited.has(includeName)) continue
        visited.add(includeName)
        if (parent.depth >= maxDepth || graph.units.length - 1 >= maxIncludes) {
          graph.truncated = true
          continue
        }
        const include = await this.findOne(connectionId, includeName, "PROG/I")
        if (!include || include.name.toUpperCase() !== includeName) {
          graph.failures.push({
            includeName,
            parentName: parent.objectName,
            reason: "Include object was not found"
          })
          continue
        }
        try {
          const source = await this.backend.readSource(connectionId, include)
          graph.units.push({
            objectName: include.name.toUpperCase(),
            objectType: include.type,
            sourceUri: source.uriUsed,
            source: source.source,
            depth: parent.depth + 1
          })
        } catch (error) {
          graph.failures.push({
            includeName,
            parentName: parent.objectName,
            reason: String(error)
          })
        }
      }
    }
    return graph
  }

  async createModulePool(input: CreateModulePoolInput): Promise<string> {
    const programName = customerName(input.programName, "programName")
    if (!input.source.length) throw new Error("source must contain at least one ABAP line")
    const result = await this.backend.callSapRepository(input.connectionId.toLowerCase(), {
      operation: "CREATE_MODULE_POOL",
      program: programName,
      description: input.description,
      packageName: packageName(input.packageName),
      transportNumber: transportNumber(input.transportNumber),
      source: input.source
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    return (
      `Module pool created and verified\nProgram: ${programName}\n` +
      `Package: ${input.packageName.toUpperCase()}\nTransport: ${input.transportNumber}\n` +
      `Status: ${result.code}`
    )
  }

  async deleteModulePool(input: DeleteModulePoolInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const programName = customerName(input.programName, "programName")
    const expectedPackage = packageName(input.packageName)
    const result = await this.backend.callSapRepository(connectionId, {
      operation: "DELETE_MODULE_POOL",
      program: programName,
      packageName: expectedPackage,
      transportNumber: transportNumber(input.transportNumber)
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    return (
      `Module pool deleted and absence verified\nProgram: ${programName}\n` +
      `Package: ${expectedPackage}\nTransport: ${input.transportNumber.toUpperCase()}\n` +
      `Status: ${result.code}`
    )
  }

  async readTransactionCode(input: ReadTransactionInput): Promise<string> {
    const transactionCode = customerName(input.transactionCode, "transactionCode")
    const result = await this.backend.callSapRepository(input.connectionId.toLowerCase(), {
      operation: "READ_TRANSACTION",
      transaction: transactionCode
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    return JSON.stringify(transactionResult(input.connectionId, transactionCode, result), null, 2)
  }

  async createTransactionCode(input: CreateTransactionInput): Promise<string> {
    const transactionCode = customerName(input.transactionCode, "transactionCode")
    const programName = customerName(input.programName, "programName")
    const screenNumber = dynproNumber(input.screenNumber)
    const result = await this.backend.callSapRepository(input.connectionId.toLowerCase(), {
      operation: "CREATE_TRANSACTION",
      transaction: transactionCode,
      program: programName,
      screen: screenNumber,
      description: input.description,
      packageName: packageName(input.packageName),
      transportNumber: transportNumber(input.transportNumber)
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    return (
      `Dialog transaction created and verified\nTransaction: ${transactionCode}\n` +
      `Program: ${programName}\nScreen: ${screenNumber}\n` +
      `Package: ${input.packageName.toUpperCase()}\nTransport: ${input.transportNumber}\n` +
      `Status: ${result.code}`
    )
  }

  async deleteTransactionCode(input: DeleteTransactionInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const transactionCode = customerName(input.transactionCode, "transactionCode")
    const expectedProgramName = customerName(input.expectedProgramName, "expectedProgramName")
    const expectedPackage = packageName(input.packageName)
    const current = await this.backend.callSapRepository(connectionId, {
      operation: "READ_TRANSACTION",
      transaction: transactionCode
    })
    requireRepositorySuccess(current.status, current.code, current.message)
    const currentDefinition = transactionResult(connectionId, transactionCode, current)
    if (
      input.expectedFingerprint &&
      currentDefinition.fingerprint !== input.expectedFingerprint.toLowerCase()
    ) {
      throw new Error(
        `TRANSACTION_FINGERPRINT_CONFLICT: expected ${input.expectedFingerprint.toLowerCase()}, current ${currentDefinition.fingerprint}`
      )
    }
    const definition = current.transactions.find((row) => row.TCODE === transactionCode)
    if (!definition) throw new Error(`Transaction does not exist: ${transactionCode}`)
    if ((definition.PGMNA ?? "").toUpperCase() !== expectedProgramName) {
      throw new Error(
        `Transaction program mismatch: expected ${expectedProgramName}, current ${(definition.PGMNA ?? "").toUpperCase()}`
      )
    }
    const result = await this.backend.callSapRepository(connectionId, {
      operation: "DELETE_TRANSACTION",
      transaction: transactionCode,
      program: expectedProgramName,
      packageName: expectedPackage,
      transportNumber: transportNumber(input.transportNumber)
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    return (
      `Transaction deleted and absence verified\nTransaction: ${transactionCode}\n` +
      `Program: ${expectedProgramName}\nPackage: ${expectedPackage}\n` +
      `Transport: ${input.transportNumber.toUpperCase()}\nStatus: ${result.code}`
    )
  }

  async createReportTransaction(input: CreateReportTransactionInput): Promise<string> {
    const transactionCode = customerName(input.transactionCode, "transactionCode")
    const programName = customerName(input.programName, "programName")
    const variant = reportVariant(input.variant)
    validateDescription(input.description)
    const result = await this.backend.callSapRepository(input.connectionId.toLowerCase(), {
      operation: "CREATE_REPORT_TRANSACTION",
      transaction: transactionCode,
      program: programName,
      objectName: variant,
      description: input.description,
      packageName: packageName(input.packageName),
      transportNumber: transportNumber(input.transportNumber)
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    const created = result.transactions.find((row) => row.TCODE === transactionCode)
    if (!created) throw new Error("SAP report transaction verification returned another object")
    return (
      `Report transaction created and verified\nTransaction: ${transactionCode}\n` +
      `Program: ${programName}\nVariant: ${variant || "none"}\n` +
      `Package: ${input.packageName.toUpperCase()}\nTransport: ${input.transportNumber}\n` +
      `Status: ${result.code}`
    )
  }

  async readFunctionModuleInterface(input: ReadFunctionModuleInput): Promise<string> {
    const functionName = readableFunctionName(input.functionName)
    const result = await this.backend.callSapRepository(input.connectionId.toLowerCase(), {
      operation: "READ_FUNCTION_INTERFACE",
      objectType: "SRC1",
      objectName: functionName
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    const definition = functionModuleResult(result, input.connectionId.toLowerCase(), functionName)
    return JSON.stringify(
      {
        ...definition,
        ...(input.includeExecutionSupport
          ? {
              executionSupport: await this.resolveFunctionExecutionContract(
                input.connectionId.toLowerCase(),
                definition
              )
            }
          : {})
      },
      null,
      2
    )
  }

  async testRemoteFunctionModule(
    input: TestRemoteFunctionModuleInput,
    beforeInvoke?: () => Promise<void>
  ): Promise<string> {
    if (input.acknowledgePotentialSideEffects !== true) {
      throw new Error("acknowledgePotentialSideEffects must be true before invoking SAP code")
    }
    const functionName = customerName(input.functionName, "functionName")
    const inputs = boundedScalarParameters(input.inputParameters, "inputParameters")
    const structureInputs = boundedStructureParameters(
      input.structureInputs ?? {},
      "structureInputs"
    )
    const tableInputs = boundedTableParameters(input.tableInputs ?? {}, "tableInputs")
    const expectedOutputs = boundedScalarParameters(input.expectedOutputs ?? {}, "expectedOutputs")
    const expectedStructureOutputs = boundedStructureParameters(
      input.expectedStructureOutputs ?? {},
      "expectedStructureOutputs"
    )
    const expectedTableOutputs = boundedTableParameters(
      input.expectedTableOutputs ?? {},
      "expectedTableOutputs"
    )
    const expectedException = input.expectedException
      ? functionComponentName(input.expectedException, "expectedException")
      : ""
    const expectationCount =
      Object.keys(expectedOutputs).length +
      Object.keys(expectedStructureOutputs).length +
      Object.keys(expectedTableOutputs).length
    if (!!expectationCount === !!expectedException) {
      throw new Error("Provide output expectations or expectedException, but not both")
    }
    assertRemotePayloadSize(
      { inputs, structureInputs, tableInputs },
      "remote function input payload"
    )
    assertRemotePayloadSize(
      { expectedOutputs, expectedStructureOutputs, expectedTableOutputs },
      "remote function expected output payload"
    )

    const repository = await this.backend.callSapRepository(input.connectionId.toLowerCase(), {
      operation: "READ_FUNCTION_INTERFACE",
      objectType: "SRC1",
      objectName: functionName
    })
    requireRepositorySuccess(repository.status, repository.code, repository.message)
    const definition = functionModuleResult(
      repository,
      input.connectionId.toLowerCase(),
      functionName
    )
    if (!definition.remoteEnabled) throw new Error(`${functionName} is not remote-enabled`)
    if (definition.updateTask) throw new Error("Update-task function modules cannot be tested")
    const contract = await this.resolveFunctionExecutionContract(
      input.connectionId.toLowerCase(),
      definition
    )
    if (!contract.supported) {
      throw new Error(`Function interface is not supported: ${contract.reasons.join("; ")}`)
    }
    const complexPayload =
      Object.keys(structureInputs).length > 0 ||
      Object.keys(tableInputs).length > 0 ||
      Object.keys(expectedStructureOutputs).length > 0 ||
      Object.keys(expectedTableOutputs).length > 0
    if (input.expectedInterfaceFingerprint) {
      if (input.expectedInterfaceFingerprint.toLowerCase() !== definition.fingerprint) {
        throw new Error(
          `Function interface fingerprint changed: expected ${input.expectedInterfaceFingerprint.toLowerCase()}, current ${definition.fingerprint}`
        )
      }
    } else if (complexPayload) {
      throw new Error("expectedInterfaceFingerprint is required for structure or table payloads")
    }

    const allowedInputs = new Map(
      contract.parameters
        .filter(
          ({ direction }) =>
            direction === "import" || direction === "changing" || direction === "table"
        )
        .map((parameter) => [parameter.name, parameter])
    )
    const suppliedInputKinds = parameterKinds(inputs, structureInputs, tableInputs)
    for (const [name, kind] of suppliedInputKinds) {
      const parameter = allowedInputs.get(name)
      if (!parameter) throw new Error(`Unknown input parameter: ${name}`)
      if (parameter.kind !== kind) {
        throw new Error(`Input parameter ${name} requires ${parameter.kind}, received ${kind}`)
      }
    }
    for (const parameter of allowedInputs.values()) {
      if (
        parameter.direction !== "table" &&
        !parameter.optional &&
        !suppliedInputKinds.has(parameter.name)
      ) {
        throw new Error(`Required input parameter is missing: ${parameter.name}`)
      }
    }
    const allowedOutputs = new Map(
      contract.parameters
        .filter(
          ({ direction }) =>
            direction === "export" || direction === "changing" || direction === "table"
        )
        .map((parameter) => [parameter.name, parameter])
    )
    const expectedOutputKinds = parameterKinds(
      expectedOutputs,
      expectedStructureOutputs,
      expectedTableOutputs
    )
    for (const [name, kind] of expectedOutputKinds) {
      const parameter = allowedOutputs.get(name)
      if (!parameter) throw new Error(`Unknown output parameter: ${name}`)
      if (parameter.kind !== kind) {
        throw new Error(`Output parameter ${name} requires ${parameter.kind}, received ${kind}`)
      }
    }
    if (
      expectedException &&
      !definition.exceptions.some(({ name }) => name === expectedException)
    ) {
      throw new Error(`Expected exception is not declared by ${functionName}: ${expectedException}`)
    }

    const remoteInputs: Record<string, RemoteFunctionValue> = {
      ...inputs,
      ...structureInputs,
      ...tableInputs
    }
    for (const parameter of allowedInputs.values()) {
      if (parameter.direction === "table" && !(parameter.name in remoteInputs)) {
        remoteInputs[parameter.name] = []
      }
      const supplied = remoteInputs[parameter.name]
      if (supplied !== undefined) {
        validateRemoteFields(parameter, supplied, `input ${parameter.name}`)
      }
    }
    const outputShapes = [...allowedOutputs.values()].map(remoteParameterShape)
    await beforeInvoke?.()
    const result = await this.backend.callRemoteFunction(input.connectionId.toLowerCase(), {
      functionName,
      inputParameters: remoteInputs,
      outputParameters: outputShapes
    })
    if (result.fault) {
      const faultText = `${result.fault.name} ${result.fault.code} ${result.fault.message}`
      if (!expectedException || result.fault.name.trim().toUpperCase() !== expectedException) {
        throw new Error(`SAP SOAP fault: ${faultText.trim()}`)
      }
      return JSON.stringify(
        {
          status: "passed",
          connectionId: input.connectionId.toLowerCase(),
          functionName,
          interfaceFingerprint: definition.fingerprint,
          expectedException,
          fault: result.fault,
          sideEffectsAcknowledged: true
        },
        null,
        2
      )
    }
    if (expectedException) {
      throw new Error(`Expected SAP exception was not raised: ${expectedException}`)
    }
    const actual = splitRemoteOutputs(result.outputs, outputShapes)
    assertRemotePayloadSize(actual, "remote function response")
    assertExpectedRemoteOutputs(actual.scalars, expectedOutputs)
    assertExpectedRemoteOutputs(actual.structures, expectedStructureOutputs)
    assertExpectedRemoteOutputs(actual.tables, expectedTableOutputs)
    for (const parameter of allowedOutputs.values()) {
      validateRemoteFields(
        parameter,
        result.outputs[parameter.name]!,
        `output ${parameter.name}`,
        true
      )
    }
    return JSON.stringify(
      {
        status: "passed",
        connectionId: input.connectionId.toLowerCase(),
        functionName,
        interfaceFingerprint: definition.fingerprint,
        inputParameterNames: [...suppliedInputKinds.keys()],
        outputs: actual.scalars,
        structureOutputs: actual.structures,
        tableOutputs: actual.tables,
        expectedOutputs,
        expectedStructureOutputs,
        expectedTableOutputs,
        parameterShapes: contract.parameters,
        sideEffectsAcknowledged: true
      },
      null,
      2
    )
  }

  async invokeCustomerFunctionModule(
    input: InvokeCustomerFunctionModuleInput,
    beforeInvoke?: () => Promise<void>
  ): Promise<string> {
    const requestId = invocationRequestId(input.requestId)
    const prepared = await this.prepareRemoteFunctionCall(input, true)
    const receipts = this.requiredInvocationReceipts()
    const inputHash = remotePayloadHash(prepared.remoteInputs)
    const reservationResult = await receipts.reserve({
      connectionId: prepared.connectionId,
      functionName: prepared.functionName,
      requestId,
      interfaceFingerprint: prepared.definition.fingerprint,
      inputHash
    })
    if (reservationResult.status === "duplicate") {
      return JSON.stringify(
        {
          status: reservationResult.conflict ? "request_id_conflict" : "duplicate_blocked",
          connectionId: prepared.connectionId,
          functionName: prepared.functionName,
          requestId,
          existingReceipt: reservationResult.receipt,
          sapInvoked: false,
          automaticRetry: false
        },
        null,
        2
      )
    }
    const reservation = reservationResult.reservation
    const invokedAt = new Date().toISOString()
    const startedAt = Date.now()
    let result: RemoteFunctionResult
    try {
      await beforeInvoke?.()
      result = await this.backend.callRemoteFunction(prepared.connectionId, {
        functionName: prepared.functionName,
        inputParameters: prepared.remoteInputs,
        outputParameters: prepared.outputShapes
      })
    } catch (error) {
      return this.markOutcomeUnknownAndRethrow(receipts, reservation, Date.now() - startedAt, error)
    }
    const durationMs = Date.now() - startedAt

    if (result.fault) {
      const faultName = result.fault.name.trim().toUpperCase()
      if (!prepared.definition.exceptions.some(({ name }) => name === faultName)) {
        return this.markOutcomeUnknownAndRethrow(
          receipts,
          reservation,
          durationMs,
          new Error(
            `SAP SOAP fault is not a declared function exception: ${result.fault.code} ${result.fault.name} ${result.fault.message}`
          )
        )
      }
      const outputHash = remotePayloadHash(result.fault)
      const persistentReceipt = await receipts.complete(reservation, {
        state: "declared_fault",
        outputHash,
        durationMs,
        faultName
      })
      return JSON.stringify(
        {
          status: "fault",
          connectionId: prepared.connectionId,
          functionName: prepared.functionName,
          interfaceFingerprint: prepared.definition.fingerprint,
          fault: result.fault,
          callReceipt: {
            requestId,
            invokedAt,
            durationMs,
            inputHash,
            outputHash,
            persistentState: persistentReceipt.status
          },
          sideEffectsAcknowledged: true,
          automaticRetry: false
        },
        null,
        2
      )
    }

    let actual: ReturnType<typeof splitRemoteOutputs>
    try {
      actual = splitRemoteOutputs(result.outputs, prepared.outputShapes)
      assertRemotePayloadSize(actual, "remote function response")
      for (const parameter of prepared.allowedOutputs.values()) {
        validateRemoteFields(
          parameter,
          result.outputs[parameter.name]!,
          `output ${parameter.name}`,
          true
        )
      }
    } catch (error) {
      return this.markOutcomeUnknownAndRethrow(receipts, reservation, durationMs, error)
    }
    const outputHash = remotePayloadHash(actual)
    const persistentReceipt = await receipts.complete(reservation, {
      state: "completed",
      outputHash,
      durationMs
    })
    return JSON.stringify(
      {
        status: "completed",
        connectionId: prepared.connectionId,
        functionName: prepared.functionName,
        interfaceFingerprint: prepared.definition.fingerprint,
        inputParameterNames: [...prepared.suppliedInputKinds.keys()],
        outputs: actual.scalars,
        structureOutputs: actual.structures,
        tableOutputs: actual.tables,
        parameterShapes: prepared.contract.parameters,
        callReceipt: {
          requestId,
          invokedAt,
          durationMs,
          inputHash,
          outputHash,
          persistentState: persistentReceipt.status
        },
        sideEffectsAcknowledged: true,
        automaticRetry: false
      },
      null,
      2
    )
  }

  async getCustomerFunctionCallStatus(input: GetCustomerFunctionCallStatusInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    this.backend.connectionDetails(connectionId)
    const requestId = invocationRequestId(input.requestId)
    return JSON.stringify(
      await this.requiredInvocationReceipts().status(connectionId, requestId),
      null,
      2
    )
  }

  private requiredInvocationReceipts(): InvocationReceiptStore {
    if (!this.invocationReceipts) {
      throw new Error("Persistent customer RFC receipt storage is not configured")
    }
    return this.invocationReceipts
  }

  private async markOutcomeUnknownAndRethrow(
    receipts: InvocationReceiptStore,
    reservation: InvocationReservation,
    durationMs: number,
    originalError: unknown
  ): Promise<never> {
    try {
      await receipts.markOutcomeUnknown(reservation, durationMs)
    } catch (receiptError) {
      const originalMessage =
        originalError instanceof Error ? originalError.message : String(originalError)
      const receiptMessage =
        receiptError instanceof Error ? receiptError.message : String(receiptError)
      throw new AggregateError(
        [originalError, receiptError],
        `SAP outcome is unknown after: ${originalMessage}; persistent receipt update also failed: ${receiptMessage}`
      )
    }
    throw originalError
  }

  private async prepareRemoteFunctionCall(
    input: InvokeCustomerFunctionModuleInput,
    requireAllowlist: boolean
  ): Promise<PreparedRemoteFunctionCall> {
    if (input.acknowledgePotentialSideEffects !== true) {
      throw new Error("acknowledgePotentialSideEffects must be true before invoking SAP code")
    }
    const connectionId = input.connectionId.toLowerCase()
    const functionName = customerName(input.functionName, "functionName")
    if (
      requireAllowlist &&
      !this.backend.connectionDetails(connectionId).remoteFunctionAllowlist.includes(functionName)
    ) {
      throw new Error(
        `${functionName} is not listed in remoteFunctionAllowlist for connection ${connectionId}`
      )
    }
    const inputs = boundedScalarParameters(input.inputParameters ?? {}, "inputParameters")
    const structureInputs = boundedStructureParameters(
      input.structureInputs ?? {},
      "structureInputs"
    )
    const tableInputs = boundedTableParameters(input.tableInputs ?? {}, "tableInputs")
    assertRemotePayloadSize(
      { inputs, structureInputs, tableInputs },
      "remote function input payload"
    )

    const repository = await this.backend.callSapRepository(connectionId, {
      operation: "READ_FUNCTION_INTERFACE",
      objectType: "SRC1",
      objectName: functionName
    })
    requireRepositorySuccess(repository.status, repository.code, repository.message)
    const definition = functionModuleResult(repository, connectionId, functionName)
    if (!definition.remoteEnabled) throw new Error(`${functionName} is not remote-enabled`)
    if (definition.updateTask) throw new Error("Update-task function modules cannot be invoked")
    if (input.expectedInterfaceFingerprint.toLowerCase() !== definition.fingerprint) {
      throw new Error(
        `Function interface fingerprint changed: expected ${input.expectedInterfaceFingerprint.toLowerCase()}, current ${definition.fingerprint}`
      )
    }
    const contract = await this.resolveFunctionExecutionContract(connectionId, definition)
    if (!contract.supported) {
      throw new Error(`Function interface is not supported: ${contract.reasons.join("; ")}`)
    }

    const allowedInputs = new Map(
      contract.parameters
        .filter(
          ({ direction }) =>
            direction === "import" || direction === "changing" || direction === "table"
        )
        .map((parameter) => [parameter.name, parameter])
    )
    const suppliedInputKinds = parameterKinds(inputs, structureInputs, tableInputs)
    for (const [name, kind] of suppliedInputKinds) {
      const parameter = allowedInputs.get(name)
      if (!parameter) throw new Error(`Unknown input parameter: ${name}`)
      if (parameter.kind !== kind) {
        throw new Error(`Input parameter ${name} requires ${parameter.kind}, received ${kind}`)
      }
    }
    for (const parameter of allowedInputs.values()) {
      if (
        parameter.direction !== "table" &&
        !parameter.optional &&
        !suppliedInputKinds.has(parameter.name)
      ) {
        throw new Error(`Required input parameter is missing: ${parameter.name}`)
      }
    }

    const allowedOutputs = new Map(
      contract.parameters
        .filter(
          ({ direction }) =>
            direction === "export" || direction === "changing" || direction === "table"
        )
        .map((parameter) => [parameter.name, parameter])
    )
    const remoteInputs: Record<string, RemoteFunctionValue> = {
      ...inputs,
      ...structureInputs,
      ...tableInputs
    }
    for (const parameter of allowedInputs.values()) {
      if (parameter.direction === "table" && !(parameter.name in remoteInputs)) {
        remoteInputs[parameter.name] = []
      }
      const supplied = remoteInputs[parameter.name]
      if (supplied !== undefined) {
        validateRemoteFields(parameter, supplied, `input ${parameter.name}`)
      }
    }
    return {
      connectionId,
      functionName,
      definition,
      contract,
      remoteInputs,
      outputShapes: [...allowedOutputs.values()].map(remoteParameterShape),
      suppliedInputKinds,
      allowedOutputs
    }
  }

  private async resolveFunctionExecutionContract(
    connectionId: string,
    definition: ReturnType<typeof functionModuleResult>
  ): Promise<FunctionExecutionContract> {
    const parameterGroups = [
      ["import", definition.importParameters],
      ["export", definition.exportParameters],
      ["changing", definition.changingParameters],
      ["table", definition.tableParameters]
    ] as const
    const cache = new Map<string, Promise<ResolvedRemoteType>>()
    const resolveType = (typeName: string, table: boolean) => {
      const key = `${table ? "T" : "P"}:${typeName}`
      let pending = cache.get(key)
      if (!pending) {
        pending = this.resolveRemoteParameterType(connectionId, typeName, table)
        cache.set(key, pending)
      }
      return pending
    }
    const parameters: FunctionExecutionParameter[] = []
    for (const [direction, values] of parameterGroups) {
      for (const parameter of values) {
        try {
          const resolved = await resolveType(parameter.typeName, direction === "table")
          parameters.push({
            name: parameter.name,
            typeName: parameter.typeName,
            optional: parameter.optional,
            direction,
            kind: direction === "table" ? "table" : resolved.kind,
            ...(resolved.fields.length ? { fields: resolved.fields } : {}),
            ...(resolved.maxCharacters !== undefined
              ? { maxCharacters: resolved.maxCharacters }
              : {}),
            ...(resolved.valueContract ? { valueContract: resolved.valueContract } : {}),
            ...(resolved.fieldContracts ? { fieldContracts: resolved.fieldContracts } : {}),
            supported: true
          })
        } catch (error) {
          parameters.push({
            name: parameter.name,
            typeName: parameter.typeName,
            optional: parameter.optional,
            direction,
            kind: direction === "table" ? "table" : "structure",
            supported: false,
            reason: error instanceof Error ? error.message : String(error)
          })
        }
      }
    }
    const reasons = parameters
      .filter(({ supported }) => !supported)
      .map(({ name, reason }) => `${name}: ${reason}`)
    return { supported: reasons.length === 0, reasons, parameters }
  }

  private async resolveRemoteParameterType(
    connectionId: string,
    typeName: string,
    tableParameter: boolean
  ): Promise<ResolvedRemoteType> {
    if (typeName.includes("-")) {
      const parts = typeName.split("-")
      if (parts.length !== 2 || tableParameter) {
        throw new Error(`DDIC field reference ${typeName} must name one scalar component`)
      }
      const parent = ddicName(parts[0]!, "field reference parent")
      const component = functionComponentName(parts[1]!, "field reference component")
      const record = await this.readRemoteRecordType(connectionId, parent)
      requireDdicSuccess(record)
      if (
        record.header.TABNAME !== parent ||
        !["INTTAB", "TRANSP"].includes(record.header.TABCLASS ?? "")
      ) {
        throw new Error(`DDIC field reference ${typeName} resolved to a different record type`)
      }
      const fields = record.fields.filter((field) => field.FIELDNAME === component)
      if (fields.length !== 1) {
        throw new Error(`DDIC field reference ${typeName} must resolve to exactly one field`)
      }
      const field = fields[0]!
      if (field.COMPTYPE?.trim() && field.COMPTYPE.trim() !== "E") {
        throw new Error(`DDIC field reference ${typeName} is not elementary`)
      }
      const element = field.ROLLNAME?.trim()
      if (element) {
        return this.resolveRemoteScalarType(
          connectionId,
          ddicName(element, "field data element"),
          true
        )
      }
      if (!supportedDirectField(field)) {
        throw new Error(`DDIC field reference ${typeName} has an unsupported direct type`)
      }
      return remoteScalarShape(field, typeName)
    }
    const structure = await this.readRemoteRecordType(connectionId, typeName)
    if (structure.status.toUpperCase() === "S") {
      const fields = flatStructureFields(structure, typeName)
      return {
        kind: tableParameter ? "table" : "structure",
        fields,
        fieldContracts: await this.resolveRemoteFieldContracts(connectionId, structure)
      }
    }
    requireDdicNotFound(structure, typeName)
    const tableType = await this.backend.callSapDdic(connectionId, {
      operation: "READ_TABLE_TYPE",
      objectName: typeName
    })
    if (tableType.status.toUpperCase() === "S") {
      const rowType = tableType.header.ROWTYPE ?? ""
      if (!rowType) throw new Error(`Table type ${typeName} has no DDIC row type`)
      const rowStructure = await this.readRemoteRecordType(connectionId, rowType)
      requireDdicSuccess(rowStructure)
      return {
        kind: "table",
        fields: flatStructureFields(rowStructure, rowType),
        fieldContracts: await this.resolveRemoteFieldContracts(connectionId, rowStructure)
      }
    }
    requireDdicNotFound(tableType, typeName)
    if (tableParameter) throw new Error(`TABLES line type ${typeName} is not a flat DDIC structure`)
    return this.resolveRemoteScalarType(connectionId, typeName)
  }

  private async resolveRemoteFieldContracts(
    connectionId: string,
    record: SapDdicResult
  ): Promise<Record<string, RfcValueContract>> {
    const result: Record<string, RfcValueContract> = {}
    const elements = new Map<string, RfcValueContract>()
    for (const field of record.fields) {
      const name = field.FIELDNAME!
      // DD03P metadata is authoritative when complete; otherwise resolve the referenced element.
      if (field.DATATYPE?.trim() && field.LENG?.trim()) {
        result[name] = rfcValueContract(field, name)
      } else {
        const element = ddicName(field.ROLLNAME ?? "", "field data element")
        let contract = elements.get(element)
        if (!contract) {
          contract = (await this.resolveRemoteScalarType(connectionId, element)).valueContract!
          elements.set(element, contract)
        }
        result[name] = contract
      }
      if (["STRG", "SSTRING"].includes(result[name]!.dataType)) {
        throw new Error(`Structure field ${name} is not a flat fixed-length value`)
      }
    }
    return result
  }

  private async resolveRemoteScalarType(
    connectionId: string,
    typeName: string,
    fieldReference = false
  ): Promise<ResolvedRemoteType> {
    const element = await this.backend.callSapDdic(connectionId, {
      operation: "READ_DATA_ELEMENT",
      objectName: typeName
    })
    requireDdicSuccess(element)
    const domainName = element.header.DOMNAME?.trim()
    const scalar = domainName
      ? await this.backend.callSapDdic(connectionId, {
          operation: "READ_DOMAIN",
          objectName: domainName
        })
      : element
    requireDdicSuccess(scalar)
    if (
      element.header.ROLLNAME !== typeName ||
      (domainName && scalar.header.DOMNAME !== domainName)
    ) {
      throw new Error(`DDIC scalar ${typeName} resolved to another identity`)
    }
    if (
      fieldReference &&
      (![
        "CHAR",
        "NUMC",
        "DATS",
        "TIMS",
        "INT1",
        "INT2",
        "INT4",
        "DEC",
        "CURR",
        "QUAN",
        "FLTP"
      ].includes(scalar.header.DATATYPE?.trim() ?? "") ||
        element.header.ROLLNAME !== typeName ||
        (domainName && scalar.header.DOMNAME !== domainName))
    ) {
      throw new Error(`DDIC field data element ${typeName} is not a verified elementary type`)
    }
    return remoteScalarShape(scalar.header, typeName)
  }

  private async readRemoteRecordType(
    connectionId: string,
    typeName: string
  ): Promise<SapDdicResult> {
    const structure = await this.backend.callSapDdic(connectionId, {
      operation: "READ_STRUCTURE",
      objectName: typeName
    })
    if (structure.status.toUpperCase() === "S" || structure.code !== "OBJECT_TYPE_MISMATCH")
      return structure
    const table = await this.backend.callSapDdic(connectionId, {
      operation: "READ_TRANSPARENT_TABLE",
      objectName: typeName
    })
    requireDdicSuccess(table)
    if (table.header.TABCLASS !== "TRANSP" || table.header.TABNAME !== typeName) {
      throw new Error(`DDIC type ${typeName} did not resolve to its active transparent table`)
    }
    return table
  }

  async createFunctionModuleWithInterface(input: CreateFunctionModuleInput): Promise<string> {
    const functionName = customerName(input.functionName, "functionName")
    const functionGroup = customerName(input.functionGroup, "functionGroup")
    validateDescription(input.description)
    const definition = functionModuleDefinition(input)
    const result = await this.backend.callSapRepository(input.connectionId.toLowerCase(), {
      operation: "CREATE_FUNCTION_MODULE",
      objectName: functionName,
      program: functionGroup,
      objectType: input.remoteEnabled ? "R" : "",
      description: input.description,
      packageName: packageName(input.packageName),
      transportNumber: transportNumber(input.transportNumber),
      source: serializeFunctionDefinition(definition)
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    const saved = functionModuleResult(result, input.connectionId.toLowerCase(), functionName)
    const { source: requestedSource, ...requestedInterface } = definition
    if (
      saved.functionGroup !== functionGroup ||
      saved.shortText !== input.description ||
      saved.remoteEnabled !== input.remoteEnabled ||
      !matchesSubset(saved, requestedInterface) ||
      !containsLineSequence(saved.source, requestedSource)
    ) {
      throw new Error("SAP function module verification did not return the requested definition")
    }
    return JSON.stringify(
      {
        ...saved,
        status: result.code,
        packageName: input.packageName.trim().toUpperCase(),
        recordedRequest: input.transportNumber.trim().toUpperCase()
      },
      null,
      2
    )
  }

  async patchFunctionModuleInterface(input: PatchFunctionModuleInterfaceInput): Promise<string> {
    const functionName = customerName(input.functionName, "functionName")
    const functionGroup = customerName(input.functionGroup, "functionGroup")
    const connectionId = input.connectionId.toLowerCase()
    if (!input.parameterOperations.length && !input.exceptionOperations.length) {
      throw new Error("At least one function interface operation is required")
    }
    if (
      [...input.parameterOperations, ...input.exceptionOperations].some(
        ({ operation }) => operation !== "add"
      ) &&
      input.confirmation !== "DESTRUCTIVE_INTERFACE_CHANGE"
    ) {
      throw new Error(
        "confirmation must be DESTRUCTIVE_INTERFACE_CHANGE for rename, update, or remove"
      )
    }

    const currentResult = await this.backend.callSapRepository(connectionId, {
      operation: "READ_FUNCTION_INTERFACE",
      objectType: "SRC1",
      objectName: functionName
    })
    requireRepositorySuccess(currentResult.status, currentResult.code, currentResult.message)
    const current = functionModuleResult(currentResult, connectionId, functionName)
    if (current.source.some((line) => line.length > 72)) {
      throw new Error(
        "Function interface patch of source wider than 72 characters is not supported by the current write helper; no write was started"
      )
    }
    if (current.functionGroup !== functionGroup) {
      throw new Error(
        `Function group changed: expected ${functionGroup}, current ${current.functionGroup}`
      )
    }
    if (current.interfaceFingerprint !== input.expectedInterfaceFingerprint.toLowerCase()) {
      throw new Error(
        `Function interface fingerprint changed: expected ${input.expectedInterfaceFingerprint.toLowerCase()}, current ${current.interfaceFingerprint}`
      )
    }
    if (current.sourceFingerprint !== input.expectedSourceFingerprint.toLowerCase()) {
      throw new Error(
        `Function implementation source fingerprint changed: expected ${input.expectedSourceFingerprint.toLowerCase()}, current ${current.sourceFingerprint}`
      )
    }

    const desired = patchFunctionModuleDefinition(
      functionDefinitionFromResult(current),
      input.parameterOperations,
      input.exceptionOperations
    )
    if (
      desired.remoteEnabled &&
      [
        ...desired.importParameters,
        ...desired.exportParameters,
        ...desired.changingParameters
      ].some((parameter) => !parameter.passByValue)
    ) {
      throw new Error("Reference parameters are not allowed with RFC")
    }
    const requestedPackage = packageName(input.packageName)
    const requestedTransport = transportNumber(input.transportNumber)
    const assignmentResult = await this.backend.callSapRepository(connectionId, {
      operation: "INSPECT_REPOSITORY_ASSIGNMENT",
      objectType: "FUNC",
      objectName: functionName
    })
    requireRepositorySuccess(
      assignmentResult.status,
      assignmentResult.code,
      assignmentResult.message
    )
    const assignment = parseFunctionPayload(assignmentResult.source).metadata
    if (assignment.PARENT_OBJECT !== functionGroup) {
      throw new Error(
        `Function repository parent changed: expected ${functionGroup}, current ${assignment.PARENT_OBJECT || "none"}`
      )
    }
    if (assignment.PACKAGE !== requestedPackage) {
      throw new Error(
        `Function repository package changed: expected ${requestedPackage}, current ${assignment.PACKAGE || "none"}`
      )
    }
    if (![assignment.REQUEST, assignment.TASK].includes(requestedTransport)) {
      throw new Error(`Function module is not assigned to transport ${requestedTransport}`)
    }

    const workspaceUri = functionModuleWorkspaceUri(connectionId, functionGroup, functionName)
    const adtSource = await this.backend.readSourceByUri(connectionId, workspaceUri)
    const sourcePatch = functionInterfaceSourcePatch(functionName, desired, adtSource.source)
    const adtBodyFingerprint = createHash("sha256")
      .update(JSON.stringify(functionImplementationSource(adtSource.source.split(/\r?\n/))))
      .digest("hex")
    if (adtBodyFingerprint !== current.sourceFingerprint) {
      throw new Error(
        `Active ADT implementation source changed: expected ${current.sourceFingerprint}, current ${adtBodyFingerprint}`
      )
    }
    // Descriptions are repository metadata and do not change the ADT declaration.
    const sourceMutation =
      sourcePatch.oldHeader === sourcePatch.newHeader
        ? null
        : await this.backend.replaceSource(
            connectionId,
            workspaceUri,
            sourcePatch.oldHeader,
            sourcePatch.newHeader,
            requestedTransport,
            createHash("sha256").update(adtSource.source).digest("hex")
          )
    if (sourceMutation && !sourceMutation.activation.success) {
      throw new Error("Function interface source was saved but activation did not succeed")
    }

    const activatedSource = await this.backend.readSourceByUri(connectionId, workspaceUri)
    const activatedBodyFingerprint = createHash("sha256")
      .update(JSON.stringify(functionImplementationSource(activatedSource.source.split(/\r?\n/))))
      .digest("hex")
    if (activatedBodyFingerprint !== current.sourceFingerprint) {
      throw new Error(
        `Function implementation source changed during ADT interface patch: expected ${current.sourceFingerprint}, current ${activatedBodyFingerprint}`
      )
    }

    const result = await this.backend.callSapRepository(connectionId, {
      operation: "PATCH_FUNCTION_INTERFACE",
      objectName: functionName,
      program: functionGroup,
      packageName: requestedPackage,
      transportNumber: requestedTransport,
      expectedVersion: current.interfaceFingerprint,
      source: [
        ...serializeFunctionSnapshot(current).map((line) => line[0]!.toLowerCase() + line.slice(1)),
        ...serializeFunctionDefinition(desired)
      ]
    })
    const nativeDifferences = result.source
      .filter((line) => /^D\|[1-7]\|/.test(line))
      .slice(0, 49)
      .map((line) => decodeSoapText(line).slice(0, 255))
    requireRepositorySuccess(
      result.status,
      result.code,
      result.message +
        (nativeDifferences.length
          ? `\nNative readback differences:\n${nativeDifferences.join("\n")}`
          : "")
    )
    const saved = functionModuleResult(result, connectionId, functionName)
    const { source: _desiredSource, ...desiredInterface } = desired
    const { source: _savedSource, ...savedInterface } = functionDefinitionFromResult(saved)
    const verificationMismatches = [
      ["functionGroup", current.functionGroup, saved.functionGroup],
      ["shortText", current.shortText, saved.shortText],
      ["remoteMode", current.remoteMode, saved.remoteMode],
      ["updateTaskMode", current.updateTaskMode, saved.updateTaskMode],
      ["globalInterface", current.globalInterface, saved.globalInterface],
      ["interface", desiredInterface, savedInterface],
      ["sourceFingerprint", current.sourceFingerprint, saved.sourceFingerprint]
    ]
      .filter(([, expected, actual]) => JSON.stringify(expected) !== JSON.stringify(actual))
      .map(
        ([field, expected, actual]) =>
          `${field}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`
      )
    if (verificationMismatches.length) {
      throw new Error(
        `SAP function interface verification did not return the requested safe patch:\n${verificationMismatches.join("\n")}`
      )
    }
    return JSON.stringify(
      {
        ...saved,
        previousInterfaceFingerprint: current.interfaceFingerprint,
        previousSourceFingerprint: current.sourceFingerprint,
        helperVersion: result.version,
        status: result.code,
        packageName: input.packageName.trim().toUpperCase(),
        recordedRequest: input.transportNumber.trim().toUpperCase(),
        sourceMutation,
        sourceWritePerformed: sourceMutation !== null,
        destructiveChangeConfirmed: input.confirmation === "DESTRUCTIVE_INTERFACE_CHANGE",
        automaticRetry: false,
        automaticSapUnlock: false,
        transportReleased: false
      },
      null,
      2
    )
  }

  async inspectRepositoryAssignment(input: InspectRepositoryAssignmentInput): Promise<string> {
    const objectName = readableObjectName(input.objectName)
    const repositoryType = {
      "CLAS/OC": "CLAS",
      "INTF/OI": "INTF",
      "FUGR/F": "FGRP",
      "FUGR/FF": "FUNC",
      "PROG/P": "PROG",
      "PROG/I": "PROG",
      TRAN: "TRAN"
    }[input.objectType]
    const result = await this.backend.callSapRepository(input.connectionId.toLowerCase(), {
      operation: "INSPECT_REPOSITORY_ASSIGNMENT",
      objectType: repositoryType,
      objectName
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    const payload = parseFunctionPayload(result.source)
    return JSON.stringify(
      {
        connectionId: input.connectionId.toLowerCase(),
        objectName,
        objectType: input.objectType,
        parentObject: payload.metadata.PARENT_OBJECT ?? "",
        packageName: payload.metadata.PACKAGE ?? "",
        requestNumber: payload.metadata.REQUEST ?? "",
        taskNumber: payload.metadata.TASK ?? "",
        transportStatus: payload.metadata.TRANSPORT_STATUS ?? "",
        active: payload.metadata.ACTIVE === "X",
        generated: payload.metadata.GENERATED === "X",
        originalSystem: payload.metadata.ORIGINAL_SYSTEM ?? ""
      },
      null,
      2
    )
  }

  async readAbapMessageClass(input: ReadMessageClassInput): Promise<string> {
    const messageClass = readableMessageClass(input.messageClass)
    const result = await this.backend.readMessageClass(
      input.connectionId.toLowerCase(),
      messageClass
    )
    return JSON.stringify(messageClassResult(result), null, 2)
  }

  async createAbapMessageClass(input: CreateMessageClassInput): Promise<string> {
    const messageClass = customerMessageClass(input.messageClass)
    validateDescription(input.description)
    const messages = messageClassMessages(input.messages)
    const result = await this.backend.createMessageClass(
      input.connectionId.toLowerCase(),
      messageClass,
      input.description,
      messages,
      packageName(input.packageName),
      transportNumber(input.transportNumber)
    )
    if (!result.activation.success) {
      throw new Error(
        `Message class was saved but activation failed for ${messageClass}. ` +
          formatActivationFailure(result.activation.messages, result.activation.inactiveObjects)
      )
    }
    const saved = messageClassResult(result)
    if (
      saved.packageName !== input.packageName.trim().toUpperCase() ||
      !matchesSubset(saved.definition, { description: input.description, messages })
    ) {
      throw new Error("SAP message class verification did not return the requested definition")
    }
    return JSON.stringify(
      {
        ...saved,
        status: "MESSAGE_CLASS_CREATED",
        recordedRequest: result.transportNumber
      },
      null,
      2
    )
  }

  async updateAbapMessageClass(input: UpdateMessageClassInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const messageClass = customerMessageClass(input.messageClass)
    const expectedPackage = packageName(input.packageName)
    const current = await this.backend.readMessageClass(connectionId, messageClass)
    if (current.version !== input.expectedVersion.trim()) {
      throw new Error("VERSION_CONFLICT: Message class changed since it was read")
    }
    if (current.packageName !== expectedPackage) {
      throw new Error(
        `PACKAGE_CONFLICT: Message class belongs to ${current.packageName || "<empty>"}`
      )
    }
    const messages = applyMessageClassOperations(current.messages, input.operations)
    const result = await this.backend.updateMessageClass(
      connectionId,
      messageClass,
      current.version,
      messages,
      expectedPackage,
      transportNumber(input.transportNumber)
    )
    const saved = messageClassResult(result)
    if (
      saved.packageName !== expectedPackage ||
      JSON.stringify(saved.definition.messages) !== JSON.stringify(messages)
    ) {
      throw new Error(
        "SAP message class verification did not return the requested active definition"
      )
    }
    return JSON.stringify(
      {
        ...saved,
        status: "MESSAGE_CLASS_UPDATED",
        recordedRequest: result.transportNumber
      },
      null,
      2
    )
  }

  async deleteAbapMessageClass(input: DeleteMessageClassInput): Promise<string> {
    if (input.confirmation !== "PERMANENT_DELETE") {
      throw new Error("confirmation must be PERMANENT_DELETE")
    }
    const connectionId = input.connectionId.toLowerCase()
    const messageClass = customerMessageClass(input.messageClass)
    const expectedPackage = packageName(input.packageName)
    const current = await this.backend.readMessageClass(connectionId, messageClass)
    if (current.version !== input.expectedVersion.trim()) {
      throw new Error("VERSION_CONFLICT: Message class changed since it was read")
    }
    if (current.packageName !== expectedPackage) {
      throw new Error(
        `PACKAGE_CONFLICT: Message class belongs to ${current.packageName || "<empty>"}`
      )
    }
    const deleted = await this.backend.deleteMessageClass(
      connectionId,
      messageClass,
      current.version,
      expectedPackage,
      transportNumber(input.transportNumber)
    )
    try {
      await this.backend.readMessageClass(connectionId, messageClass)
    } catch (error) {
      if (isMessageClassNotFound(error)) {
        return JSON.stringify(
          {
            connectionId,
            objectKind: "messageClass",
            messageClass,
            previousVersion: current.version,
            previousFingerprint: messageClassResult(current).fingerprint,
            packageName: expectedPackage,
            recordedRequest: deleted.transportNumber,
            status: "MESSAGE_CLASS_DELETED"
          },
          null,
          2
        )
      }
      throw error
    }
    throw new Error("MESSAGE_CLASS_DELETE_VERIFY_FAILED: Message class still exists after delete")
  }

  async readDdicDomain(input: ReadDdicInput): Promise<string> {
    return this.readDdic(input, "READ_DOMAIN", "domain")
  }

  async upsertDdicDomain(input: UpsertDomainInput): Promise<string> {
    const objectName = customerDdicName(input.objectName)
    validateDescription(input.description)
    validateDomainDefinition(input)
    const fixedValues = input.fixedValues ?? []
    const result = await this.backend.callSapDdic(input.connectionId.toLowerCase(), {
      operation: "UPSERT_DOMAIN",
      objectName,
      description: input.description,
      packageName: ddicPackageName(input.packageName),
      transportNumber: transportNumber(input.transportNumber),
      expectedVersion: versionToken(input.expectedVersion),
      header: {
        DATATYPE: input.dataType,
        LENG: String(input.length),
        OUTPUTLEN: String(input.length),
        DECIMALS: String(input.decimals ?? 0),
        LOWERCASE: input.lowercase ? "X" : "",
        SIGNFLAG: input.signFlag ? "X" : "",
        ENTITYTAB: input.valueTable ? ddicName(input.valueTable, "valueTable") : "",
        CONVEXIT: input.conversionExit?.trim().toUpperCase() ?? ""
      },
      fixedValues: fixedValues.map((value) => ({
        DOMVALUE_L: value.low,
        DOMVALUE_H: value.high ?? "",
        DDTEXT: value.description
      }))
    })
    return savedDdicResult(result, "domain", objectName, input.packageName, input.connectionId, {
      description: input.description,
      dataType: input.dataType,
      length: input.length,
      outputLength: input.length,
      decimals: input.decimals ?? 0,
      lowercase: input.lowercase ?? false,
      signFlag: input.signFlag ?? false,
      valueTable: input.valueTable?.trim().toUpperCase() ?? "",
      conversionExit: input.conversionExit?.trim().toUpperCase() ?? "",
      fixedValues: fixedValues.map((value) => ({
        low: value.low,
        high: value.high ?? "",
        description: value.description
      }))
    })
  }

  async readDdicDataElement(input: ReadDdicInput): Promise<string> {
    return this.readDdic(input, "READ_DATA_ELEMENT", "dataElement")
  }

  async upsertDdicDataElement(input: UpsertDataElementInput): Promise<string> {
    const objectName = customerDdicName(input.objectName)
    validateDescription(input.description)
    validateTextLength(input.heading, 55, "heading")
    validateTextLength(input.short, 10, "short")
    validateTextLength(input.medium, 20, "medium")
    validateTextLength(input.long, 40, "long")
    const result = await this.backend.callSapDdic(input.connectionId.toLowerCase(), {
      operation: "UPSERT_DATA_ELEMENT",
      objectName,
      description: input.description,
      packageName: ddicPackageName(input.packageName),
      transportNumber: transportNumber(input.transportNumber),
      expectedVersion: versionToken(input.expectedVersion),
      header: {
        DOMNAME: ddicName(input.domainName, "domainName"),
        REPTEXT: input.heading,
        SCRTEXT_S: input.short,
        SCRTEXT_M: input.medium,
        SCRTEXT_L: input.long
      }
    })
    return savedDdicResult(
      result,
      "dataElement",
      objectName,
      input.packageName,
      input.connectionId,
      {
        description: input.description,
        domainName: input.domainName.trim().toUpperCase(),
        heading: input.heading,
        short: input.short,
        medium: input.medium,
        long: input.long
      }
    )
  }

  async readDdicStructure(input: ReadDdicInput): Promise<string> {
    return this.readDdic(input, "READ_STRUCTURE", "structure")
  }

  async upsertDdicStructure(input: UpsertStructureInput): Promise<string> {
    const objectName = customerDdicName(input.objectName)
    validateDescription(input.description)
    if (!input.fields.length) throw new Error("fields must contain at least one component")
    const names = new Set<string>()
    const fields = input.fields.map((field) => {
      const name = ddicFieldName(field.name)
      if (names.has(name)) throw new Error(`Duplicate structure field: ${name}`)
      names.add(name)
      return { FIELDNAME: name, ROLLNAME: ddicName(field.dataElement, "dataElement") }
    })
    const result = await this.backend.callSapDdic(input.connectionId.toLowerCase(), {
      operation: "UPSERT_STRUCTURE",
      objectName,
      description: input.description,
      packageName: ddicPackageName(input.packageName),
      transportNumber: transportNumber(input.transportNumber),
      expectedVersion: versionToken(input.expectedVersion),
      fields
    })
    return savedDdicResult(result, "structure", objectName, input.packageName, input.connectionId, {
      description: input.description,
      tableClass: "INTTAB",
      fields: fields.map((field, index) => ({
        name: field.FIELDNAME,
        position: index + 1,
        dataElement: field.ROLLNAME
      }))
    })
  }

  async readDdicTransparentTable(input: ReadDdicInput): Promise<string> {
    return this.readDdic(input, "READ_TRANSPARENT_TABLE", "transparentTable")
  }

  async createDdicTransparentTable(input: CreateTransparentTableInput): Promise<string> {
    const objectName = customerDdicTableName(input.objectName)
    validateDescription(input.description)
    const fields = validateTransparentTableFields(input.fields)
    const sizeCategory = input.sizeCategory ?? 0
    if (!Number.isInteger(sizeCategory) || sizeCategory < 0 || sizeCategory > 4) {
      throw new Error("sizeCategory must be an integer from 0 to 4")
    }
    const maintenanceFlag = {
      allowed: "X",
      restricted: "R",
      notAllowed: ""
    }[input.dataBrowserMaintenance]
    const result = await this.backend.callSapDdic(input.connectionId.toLowerCase(), {
      operation: "CREATE_TRANSPARENT_TABLE",
      objectName,
      description: input.description,
      packageName: ddicPackageName(input.packageName),
      transportNumber: transportNumber(input.transportNumber),
      header: {
        CONTFLAG: input.deliveryClass,
        MAINFLAG: maintenanceFlag,
        TABKAT: String(sizeCategory),
        TABART: input.dataClass,
        BUFALLOW: "N",
        PUFFERUNG: ""
      },
      fields
    })
    return savedDdicResult(
      result,
      "transparentTable",
      objectName,
      input.packageName,
      input.connectionId,
      {
        description: input.description,
        tableClass: "TRANSP",
        deliveryClass: input.deliveryClass,
        dataClass: input.dataClass,
        dataBrowserMaintenance: input.dataBrowserMaintenance,
        sizeCategory,
        buffering: "notAllowed",
        fields: fields.map((field, index) => ({
          name: field.FIELDNAME,
          position: index + 1,
          dataElement: field.ROLLNAME,
          key: field.KEYFLAG === "X",
          notNull: field.NOTNULL === "X"
        }))
      }
    )
  }

  async appendDdicTransparentTableFields(
    input: AppendTransparentTableFieldsInput
  ): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const objectName = customerDdicTableName(input.objectName)
    const packageName = ddicPackageName(input.packageName)
    const expectedVersion = requiredVersionToken(input.expectedVersion)
    const expectedFingerprint = input.expectedFingerprint.trim().toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(expectedFingerprint)) {
      throw new Error("expectedFingerprint must be returned by read_ddic_transparent_table")
    }
    const appendedFields = validateAppendedTransparentTableFields(input.fields)
    const current = await this.backend.callSapDdic(connectionId, {
      operation: "READ_TRANSPARENT_TABLE",
      objectName
    })
    requireDdicSuccess(current)
    if (current.packageName !== packageName) {
      throw new Error(`SAP DDIC verification returned package ${current.packageName || "<empty>"}`)
    }
    if (current.objectVersion !== expectedVersion) {
      throw new Error("VERSION_CONFLICT: DDIC object changed since it was read")
    }
    const currentDefinition = ddicDefinition(current, "transparentTable")
    const currentFingerprint = createHash("sha256")
      .update(JSON.stringify(currentDefinition))
      .digest("hex")
    if (currentFingerprint !== expectedFingerprint) {
      throw new Error(
        "FINGERPRINT_CONFLICT: Transparent table definition changed since it was read"
      )
    }
    const existingNames = new Set(
      current.fields.map((field) => (field.FIELDNAME ?? "").toUpperCase()).filter(Boolean)
    )
    for (const field of appendedFields) {
      if (existingNames.has(field.FIELDNAME)) {
        throw new Error(`Transparent table field already exists: ${field.FIELDNAME}`)
      }
      const dataElement = await this.backend.callSapDdic(connectionId, {
        operation: "READ_DATA_ELEMENT",
        objectName: field.ROLLNAME
      })
      requireDdicSuccess(dataElement)
      if (dataElement.header.ROLLNAME !== field.ROLLNAME) {
        throw new Error(`Active data element verification failed: ${field.ROLLNAME}`)
      }
    }
    const result = await this.backend.callSapDdic(connectionId, {
      operation: "APPEND_TRANSPARENT_TABLE_FIELDS",
      objectName,
      description: current.header.DDTEXT ?? "",
      packageName,
      transportNumber: transportNumber(input.transportNumber),
      expectedVersion,
      fields: appendedFields
    })
    const currentFields = (currentDefinition.fields ?? []) as Array<Record<string, unknown>>
    return savedDdicResult(result, "transparentTable", objectName, packageName, connectionId, {
      ...currentDefinition,
      fields: [
        ...currentFields,
        ...appendedFields.map((field, index) => ({
          name: field.FIELDNAME,
          position: currentFields.length + index + 1,
          dataElement: field.ROLLNAME,
          key: false,
          notNull: false
        }))
      ]
    })
  }

  async patchDdicTransparentTableFields(input: PatchTransparentTableFieldsInput): Promise<string> {
    if (input.confirmation !== "DESTRUCTIVE_SCHEMA_CHANGE" || input.acknowledgeDataLoss !== true) {
      throw new Error(
        "confirmation must be DESTRUCTIVE_SCHEMA_CHANGE and acknowledgeDataLoss must be true"
      )
    }
    if (!input.changes.length || input.changes.length > 32) {
      throw new Error("changes must contain 1-32 field changes")
    }
    const connectionId = input.connectionId.toLowerCase()
    const objectName = customerDdicTableName(input.objectName)
    const packageName = ddicPackageName(input.packageName)
    const expectedVersion = requiredVersionToken(input.expectedVersion)
    const expectedFingerprint = requiredDdicFingerprint(input.expectedFingerprint)
    const current = await this.backend.callSapDdic(connectionId, {
      operation: "READ_TRANSPARENT_TABLE",
      objectName
    })
    requireCurrentDdicDefinition(current, packageName, expectedVersion)
    const currentDefinition = ddicDefinition(current, "transparentTable")
    const currentFingerprint = createHash("sha256")
      .update(JSON.stringify(currentDefinition))
      .digest("hex")
    if (currentFingerprint !== expectedFingerprint) {
      throw new Error(
        "FINGERPRINT_CONFLICT: Transparent table definition changed since it was read"
      )
    }
    const currentFields = transparentTableFields(currentDefinition)
    if (
      currentFields.some((field) => !field.name || !field.dataElement || field.name === ".INCLUDE")
    ) {
      throw new Error("COMPLEX_TABLE_UNSUPPORTED: Tables with includes or appends are unsupported")
    }
    const fields = applyTransparentTableFieldChanges(currentFields, input.changes)
    const changedDataElements = new Set(
      input.changes.flatMap((change) =>
        change.action === "update" && change.dataElement !== undefined
          ? [ddicName(change.dataElement, "dataElement")]
          : []
      )
    )
    for (const dataElementName of changedDataElements) {
      const dataElement = await this.backend.callSapDdic(connectionId, {
        operation: "READ_DATA_ELEMENT",
        objectName: dataElementName
      })
      requireDdicSuccess(dataElement)
      if (dataElement.header.ROLLNAME !== dataElementName) {
        throw new Error(`Active data element verification failed: ${dataElementName}`)
      }
    }
    const result = await this.backend.callSapDdic(connectionId, {
      operation: "PATCH_TRANSPARENT_TABLE_FIELDS",
      objectName,
      description: String(currentDefinition.description ?? ""),
      packageName,
      transportNumber: transportNumber(input.transportNumber),
      expectedVersion,
      fields: fields.map((field) => ({
        FIELDNAME: field.name,
        ROLLNAME: field.dataElement,
        KEYFLAG: field.key ? "X" : "",
        NOTNULL: field.notNull ? "X" : ""
      }))
    })
    return savedDdicResult(result, "transparentTable", objectName, packageName, connectionId, {
      ...currentDefinition,
      fields: fields.map((field, index) => ({
        name: field.name,
        position: index + 1,
        dataElement: field.dataElement,
        key: field.key,
        notNull: field.notNull
      }))
    })
  }

  async readDdicTableType(input: ReadDdicInput): Promise<string> {
    return this.readDdic(input, "READ_TABLE_TYPE", "tableType")
  }

  async upsertDdicTableType(input: UpsertTableTypeInput): Promise<string> {
    const objectName = customerDdicName(input.objectName)
    validateDescription(input.description)
    const result = await this.backend.callSapDdic(input.connectionId.toLowerCase(), {
      operation: "UPSERT_TABLE_TYPE",
      objectName,
      description: input.description,
      packageName: ddicPackageName(input.packageName),
      transportNumber: transportNumber(input.transportNumber),
      expectedVersion: versionToken(input.expectedVersion),
      header: { ROWTYPE: ddicName(input.rowType, "rowType") }
    })
    return savedDdicResult(result, "tableType", objectName, input.packageName, input.connectionId, {
      description: input.description,
      rowType: input.rowType.trim().toUpperCase(),
      rowKind: "S",
      dataType: "STRU",
      accessMode: "T",
      keyDefinition: "D",
      keyKind: "N"
    })
  }

  async deleteDdicObject(input: DeleteDdicInput): Promise<string> {
    if (input.confirmation !== "PERMANENT_DELETE") {
      throw new Error("confirmation must be PERMANENT_DELETE")
    }
    if (input.objectType === "TABL" && input.acknowledgeDataLoss !== true) {
      throw new Error("acknowledgeDataLoss must be true when deleting a transparent table")
    }
    const objectName =
      input.objectType === "TABL"
        ? customerDdicTableName(input.objectName)
        : customerDdicName(input.objectName)
    const expectedPackage = ddicPackageName(input.packageName)
    const operation = {
      DOMA: "DELETE_DOMAIN",
      DTEL: "DELETE_DATA_ELEMENT",
      STRU: "DELETE_STRUCTURE",
      TABL: "DELETE_TRANSPARENT_TABLE",
      TTYP: "DELETE_TABLE_TYPE"
    }[input.objectType] as SapDdicOperation
    const result = await this.backend.callSapDdic(input.connectionId.toLowerCase(), {
      operation,
      objectName,
      packageName: expectedPackage,
      transportNumber: transportNumber(input.transportNumber),
      expectedVersion: requiredVersionToken(input.expectedVersion)
    })
    requireDdicSuccess(result)
    if (result.header && Object.keys(result.header).length > 0) {
      throw new Error("SAP DDIC deletion verification still returned an active definition")
    }
    return JSON.stringify(
      {
        connectionId: input.connectionId.toLowerCase(),
        objectType: input.objectType,
        objectName,
        packageName: expectedPackage,
        recordedRequest: result.recordedRequest,
        status: result.code,
        absenceVerified: true
      },
      null,
      2
    )
  }

  private async readDdic(
    input: ReadDdicInput,
    operation: SapDdicOperation,
    kind: DdicKind
  ): Promise<string> {
    const objectName = ddicName(input.objectName, "objectName")
    const result = await this.backend.callSapDdic(input.connectionId.toLowerCase(), {
      operation,
      objectName
    })
    requireDdicSuccess(result)
    return JSON.stringify(ddicResult(result, kind, objectName, input.connectionId), null, 2)
  }

  async searchObjects(input: SearchInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const objects = await this.backend.searchObjects(
      connectionId,
      input.pattern,
      input.types,
      input.maxResults ?? 20
    )
    if (!objects.length) return `No ABAP objects found matching pattern: ${input.pattern}`

    return (
      `Found ${objects.length} ABAP objects matching "${input.pattern}":\n\n` +
      objects
        .map(
          (object) =>
            `• ${object.name} (${object.type})\n` +
            `  ${object.description}\n` +
            `  Package: ${object.package}\n` +
            `  URI: ${object.uri}\n` +
            `  ADT: adt://${connectionId}${object.uri}`
        )
        .join("\n\n")
    )
  }

  async getObjectInfo(input: ObjectInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const object = await this.findOne(connectionId, input.objectName, input.objectType)
    if (!object) {
      return `Could not find ABAP object: ${input.objectName}. The object may not exist or may not be accessible.`
    }

    let totalLines = "Unknown"
    let uriUsed = "Not determined"
    let sourceKind: "source" | "dictionary" = "source"
    let appendCount = 0
    try {
      const result = await this.backend.readSource(connectionId, object)
      totalLines = result.source.split("\n").length.toString()
      uriUsed = result.uriUsed
      sourceKind = result.kind ?? "source"
      appendCount = result.appendCount ?? 0
    } catch {
      uriUsed = "Access failed"
    }

    if (sourceKind === "dictionary" && object.type.startsWith("TABL")) {
      return (
        `${input.objectName} (Database Table):\n` +
        `Type: ${object.type}\n` +
        `Description: ${object.description || "none"}\n` +
        `Package: ${object.package || "unknown"}\n` +
        `System Type: ${object.systemType}\n` +
        `Total lines: ${totalLines}\n` +
        `Append structures: ${appendCount}${appendCount ? " (custom fields present)" : ""}\n` +
        `URI: ${object.uri}`
      )
    }

    let enhancementInfo = "\n• Enhancements: Could not check enhancements"
    try {
      const enhancements = await this.backend.readEnhancements(connectionId, object.uri)
      enhancementInfo = enhancements.length
        ? `\n• Enhancements: ${enhancements.length} enhancement(s) found\n${enhancements
            .map((enhancement) => `  - ${enhancement.name} (line ${enhancement.startLine})`)
            .join("\n")}`
        : "\n• Enhancements: No enhancements found"
    } catch {
      // Preserve the source service's best-effort enhancement behavior.
    }

    return (
      `${input.objectName} Information:\n\n` +
      `• Object Type: ${object.type}\n` +
      `• Description: ${object.description || "No description available"}\n` +
      `• Package: ${object.package || "Unknown"}\n` +
      `• System Type: ${object.systemType}\n` +
      `• Total Lines: ${totalLines}\n` +
      `• URI: \`${object.uri || "Not available"}\`\n` +
      `• URI Used: \`${uriUsed}\`` +
      enhancementInfo
    )
  }

  async getObjectLines(input: LinesInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const object = await this.findOne(connectionId, input.objectName, input.objectType)
    if (!object) {
      const typeInfo = input.objectType ? ` of type ${input.objectType}` : ""
      return `Could not find ABAP object: ${input.objectName}${typeInfo}. The object may not exist or may not be accessible.`
    }

    try {
      const { source, uriUsed, kind } = await this.backend.readSource(connectionId, object, {
        version: "active"
      })
      const sourceFingerprint = createHash("sha256").update(source).digest("hex")
      const lines = source.split("\n")
      if (input.methodName && object.type.startsWith("CLAS")) {
        const method = extractMethod(lines, input.methodName)
        if (!method) {
          return (
            `Method ${input.methodName} NOT FOUND in class ${input.objectName}.\n` +
            "Tip: search this class with regex '^\\s*(CLASS-)?METHODS?\\s+\\w+' to list all method names."
          )
        }
        return (
          `Method ${input.methodName.toUpperCase()} from class ${input.objectName} ` +
          `(lines ${method.startLine}-${method.endLine} of ${lines.length}, ${method.code.length} method lines):\n\n` +
          `\`\`\`abap\n${method.code.join("\n")}\n\`\`\`\n\nFull Source SHA-256: ${sourceFingerprint}\nURI: ${uriUsed}`
        )
      }

      const startLine = input.startLine ?? 1
      const lineCount = input.lineCount ?? 50
      const startIndex = Math.max(0, startLine - 1)
      const endIndex = Math.min(startIndex + lineCount, lines.length)
      const selected = lines.slice(startIndex, endIndex)
      if (
        kind === "dictionary" &&
        (object.type.startsWith("TABL") || object.type.startsWith("TTYP"))
      ) {
        return (
          `Complete Table Structure for ${input.objectName} (lines ${startLine}-${endIndex} of ${lines.length}, ${selected.length} retrieved):\n\n` +
          selected.join("\n") +
          (endIndex < lines.length ? "\n\n(more lines available, request next range)" : "")
        )
      }
      let enhancementInfo = ""
      try {
        const enhancements = await this.backend.readEnhancements(connectionId, uriUsed)
        if (enhancements.length) {
          enhancementInfo = `\n\nEnhancements found: ${enhancements.length}\n${enhancements
            .map((enhancement) => `• ${enhancement.name} (line ${enhancement.startLine})`)
            .join(
              "\n"
            )}\nUse search tool to find enhancement code, or re-call this tool with the enhancement line range.`
        }
      } catch {
        // Enhancement metadata is optional for source reads.
      }
      return (
        `Source from ${input.objectName} (lines ${startLine}-${endIndex} of ${lines.length}, ${selected.length} lines retrieved):\n\n` +
        `\`\`\`abap\n${selected.join("\n").trim()}\n\`\`\`\n\n` +
        `Full Source SHA-256: ${sourceFingerprint}\n` +
        `URI: ${uriUsed}` +
        (endIndex < lines.length ? "\n(more lines available, request next range)" : "") +
        enhancementInfo
      )
    } catch (error) {
      return `Could not access content for ABAP object: ${input.objectName}. Error: ${String(error)}`
    }
  }

  async getBatchLines(input: BatchInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const results = await Promise.all(
      input.requests.map(async (request) => {
        try {
          const object = await this.findOne(connectionId, request.objectName)
          if (!object) return `### ${request.objectName}\nObject ${request.objectName} not found\n`
          const { source } = await this.backend.readSource(connectionId, object)
          const lines = source.split("\n")
          const startLine = request.startLine ?? 0
          const lineCount = request.lineCount ?? 10
          const selected = lines.slice(startLine, Math.min(startLine + lineCount, lines.length))
          return (
            `### ${request.objectName} (${selected.length} lines)\n` +
            `\`\`\`abap\n${selected.join("\n").trim()}\n\`\`\`\n`
          )
        } catch (error) {
          return `### ${request.objectName}\nError accessing ${request.objectName}: ${String(error)}\n`
        }
      })
    )
    return `Batch Lines Results (${input.requests.length} objects):\n\n${results.join("\n")}`
  }

  async getObjectByUri(input: UriInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    try {
      const { source, uriUsed } = await this.backend.readSourceByUri(connectionId, input.uri)
      if (!source) throw new Error("Source content is empty")
      const lines = source.split("\n")
      const startLine = Math.max(0, input.startLine ?? 0)
      const endLine = Math.min(startLine + (input.lineCount ?? 50), lines.length)
      const selected = lines.slice(startLine, endLine)
      return (
        `Direct URI Access Successful\n` +
        `Original URI: ${input.uri}\n` +
        `URI Used: ${uriUsed}\n` +
        `Lines: ${startLine}-${endLine} of ${lines.length} (${selected.length} retrieved)\n\n` +
        `\`\`\`abap\n${selected.join("\n").trim()}\n\`\`\``
      )
    } catch (error) {
      throw new Error(`Failed to access object by URI: ${String(error)}`)
    }
  }

  async searchObjectLines(input: SearchLinesInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const contextLines = Math.max(0, input.contextLines ?? 3)
    const maxObjects = Math.max(1, Math.min(10, input.maxObjects ?? 1))
    const objects = await this.backend.searchObjects(
      connectionId,
      input.objectName,
      undefined,
      maxObjects
    )
    if (!objects.length) return `Could not find ABAP object(s): ${input.objectName}.`

    let output = ""
    let baseMatches = 0
    let enhancementMatches = 0
    for (const object of objects) {
      try {
        const { source, uriUsed, kind } = await this.backend.readSource(connectionId, object)
        const matches = findLineMatches(source.split("\n"), input.searchTerm, !!input.isRegexp)
        const enhancements = await this.backend.readEnhancements(connectionId, uriUsed, true)
        const matchingEnhancements = enhancements.flatMap((enhancement) => {
          if (!enhancement.source) return []
          return findLineMatches(
            enhancement.source.split("\n"),
            input.searchTerm,
            !!input.isRegexp
          ).map((match) => ({ enhancement, match }))
        })
        if (!matches.length && !matchingEnhancements.length) continue

        output += `\n## ${object.name} (${kind === "dictionary" ? "Complete Table Structure" : object.type})\n\n`
        if (matches.length) {
          output += `Base Source Matches (${matches.length}):\n\n`
          output += renderMatches(source.split("\n"), matches, contextLines, kind !== "dictionary")
        }
        if (matchingEnhancements.length) {
          output += `Enhancement Matches (${matchingEnhancements.length}):\n\n`
          for (const { enhancement, match } of matchingEnhancements) {
            output += `Enhancement ${enhancement.name} - Line ${match.index + 1}:\n`
            output += renderMatches(enhancement.source!.split("\n"), [match], contextLines, true)
          }
        }
        output += `URI: ${uriUsed} (${source.split("\n").length} lines total)\n\n`
        baseMatches += matches.length
        enhancementMatches += matchingEnhancements.length
      } catch (error) {
        output += `Object ${object.name}: Error during search - ${String(error)}\n\n`
      }
    }

    if (!baseMatches && !enhancementMatches) {
      let message = `No matches for "${input.searchTerm}" in ${objects.length} object(s) matching: ${input.objectName}`
      if (maxObjects > 1) {
        message += `\n\nObjects searched:\n${objects.map((object) => `• ${object.name} (${object.type})`).join("\n")}`
      }
      return message
    }

    const total = baseMatches + enhancementMatches
    if (maxObjects > 1) {
      return (
        `Found ${total} matches for "${input.searchTerm}" across ${objects.length} objects matching ${input.objectName}:\n` +
        `Objects: ${objects.length}/${objects.length} | Base: ${baseMatches} | Enhancement: ${enhancementMatches}\n` +
        `\nObjects searched:\n${objects.map((object) => `• ${object.name} (${object.type})`).join("\n")}\n` +
        output
      )
    }
    return (
      `Found ${total} matches for "${input.searchTerm}" in ${input.objectName}:\n` +
      `Base: ${baseMatches} | Enhancement: ${enhancementMatches}\n\n${output}`
    )
  }

  async getWorkspaceUri(input: WorkspaceUriInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const requestedType = input.objectType.toUpperCase()
    const functionModule = new Set(["FUGR/FF", "FUNC/FM", "FUNC"]).has(requestedType)
    const functionGroupInclude = requestedType === "FUGR/I"
    const searchType = functionModule ? "FUNC" : functionGroupInclude ? "PROG" : requestedType
    const results = await this.backend.searchObjects(
      connectionId,
      input.objectName,
      [searchType],
      50
    )
    const exactMatches = results.filter(
      (object) =>
        object.name.toUpperCase() === input.objectName.toUpperCase() &&
        (functionModule
          ? new Set(["FUGR/FF", "FUNC/FM", "FUNC"]).has(object.type.toUpperCase())
          : functionGroupInclude
            ? object.type.toUpperCase() === requestedType ||
              object.type.toUpperCase() === "PROG" ||
              /^\/sap\/bc\/adt\/functions\/groups\/[^/]+\/fmodules\//i.test(object.uri)
            : object.type.toUpperCase() === requestedType)
    )
    if (!exactMatches.length) {
      throw new Error(
        `Failed to get workspace URI for ABAP object: Object ${input.objectName} (${input.objectType}) not found in connection ${connectionId}`
      )
    }
    if (exactMatches.length > 1) {
      throw new Error(
        `Failed to get workspace URI for ABAP object: Multiple objects found for ${input.objectName} (${input.objectType})`
      )
    }
    const object = exactMatches[0]!
    const adtUri = functionGroupInclude
      ? functionGroupIncludeUri(object.uri, input.objectName)
      : object.uri
    const workspaceUri = `adt://${connectionId}${adtUri}`
    return (
      `ABAP Object Workspace URI\n` +
      `Object: ${object.name}\n` +
      `Type: ${object.type}\n` +
      `Package: ${object.package || "unknown"}\n` +
      `Description: ${object.description || "none"}\n` +
      `ADT URI: ${adtUri}\n` +
      `Workspace URI: ${workspaceUri}\n` +
      `Use this URI with standalone ABAP MCP tools.`
    )
  }

  getObjectUrl(input: ObjectUrlInput): string {
    const connectionId = input.connectionId.toLowerCase()
    const objectType = input.objectType ?? "PROG/P"
    const details = this.backend.connectionDetails(connectionId)
    const transaction = transactionFor(objectType)
    const objectName =
      objectType === "CLAS/OC" || objectType === "CLAS/I"
        ? input.objectName.split(".")[0]!
        : input.objectName
    let baseUrl = details.url.replace(/\/sap\/bc\/adt.*$/i, "").replace(/\/$/, "")
    if (!/^https?:\/\//i.test(baseUrl)) baseUrl = `https://${baseUrl}`
    const url =
      `${baseUrl}/sap/bc/gui/sap/its/webgui?` +
      `%7etransaction=%2a${transaction.name}%20${transaction.field}%3d${objectName}%3bDYNP_OKCODE%3d${transaction.okcode}` +
      `&sap-client=${details.client}&sap-language=${details.language || "EN"}&saml2=disabled`
    return (
      `SAP GUI URL Generated Successfully\n` +
      `Object: ${input.objectName}\n` +
      `Type: ${objectType}\n` +
      `Connection: ${connectionId}\n` +
      `Transaction: ${transaction.name}\n` +
      `URL: ${url}`
    )
  }

  async findWhereUsed(input: WhereUsedInput): Promise<string> {
    const result = await collectWhereUsed(this.backend, input)
    return input.responseFormat === "json"
      ? JSON.stringify(result, null, 2)
      : formatWhereUsed(result)
  }

  async getSapSystemInfo(input: SystemInfoInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const details = this.backend.connectionDetails(connectionId)
    const info = await collectSystemInfo(this.backend, connectionId, details.client, async () =>
      JSON.parse(
        await this.readFunctionModuleInterface({ connectionId, functionName: "RFC_READ_TABLE" })
      )
    )
    const components = input.includeComponents ? info.softwareComponents : []
    const result = {
      ...info,
      currentClient: info.currentClient
        ? {
            ...info.currentClient,
            categoryCode: info.currentClient.category,
            changeProtectionCode: info.currentClient.changeProtection,
            changeProtectionScope: "Repository and cross-client Customizing",
            category: clientCategory(info.currentClient.category),
            changeProtection: changeProtection(info.currentClient.changeProtection)
          }
        : null,
      componentsIncluded: input.includeComponents ?? false,
      softwareComponents: components
    }
    let summary =
      `SAP System: ${connectionId.toUpperCase()}\n` +
      `- Status: ${result.status}\n` +
      `- Type: ${result.systemType}\n` +
      `- Release: ${result.sapRelease || "N/A"}\n`
    if (result.currentClient) {
      summary += `- Client: ${result.currentClient.clientNumber} (${result.currentClient.clientName})\n`
    }
    if (result.timezone) {
      summary += `- Timezone: ${result.timezone.timezone} (${result.timezone.description}), ${result.timezone.utcOffset} (standard time)`
      if (result.timezone.dstRule && result.timezone.dstRule !== "NONE")
        summary += `, DST rule: ${result.timezone.dstRule}`
      summary += "\n"
    }
    if (input.includeComponents && components.length) {
      summary += `- Components: ${components.length} returned${result.componentsComplete ? "" : " (incomplete)"}\n`
    }
    if (result.queryWarnings.length) {
      summary += `- Query warnings: ${result.queryWarnings.length}\n`
    }
    return `${summary}${JSON.stringify(result, null, 2)}`
  }

  async getVersionHistory(input: VersionHistoryInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const object = await this.findOne(connectionId, input.objectName, input.objectType)
    if (!object) {
      return ` Failed to get version history: Could not find ABAP object: ${input.objectName}. Please check the object name and ensure it exists.`
    }
    try {
      const revisions = await this.backend.revisions(connectionId, object.uri)
      const action = input.action ?? "list_versions"
      if (action === "get_version_source") {
        const number = input.versionNumber
        if (!number || number < 1 || number > revisions.length) {
          throw new Error(
            `Version ${number} not found. Available versions: 1 to ${revisions.length}`
          )
        }
        const revision = revisions[number - 1]!
        const source = (await this.backend.readSourceByUri(connectionId, revision.uri)).source
        return (
          `Source at Version #${number} of ${input.objectName} (${object.type})\n\n` +
          `Date: ${formatDate(revision.date)}\n` +
          `Author: ${revision.author || "Unknown"}\n` +
          `Transport: ${revision.version || "-"}\n` +
          `Title: ${revision.versionTitle || "-"}\n` +
          `Lines: ${source.split("\n").length}\n\n` +
          `\`\`\`abap\n${source}\n\`\`\``
        )
      }
      if (action === "compare_versions") {
        const first = input.version1
        const second = input.version2
        if (!first || first < 1 || first > revisions.length) {
          throw new Error(
            `Version ${first} not found. Available versions: 1 to ${revisions.length}`
          )
        }
        if (!second || second < 1 || second > revisions.length) {
          throw new Error(
            `Version ${second} not found. Available versions: 1 to ${revisions.length}`
          )
        }
        if (first === second) throw new Error(`Cannot compare version ${first} with itself`)
        const newer = revisions[first - 1]!
        const older = revisions[second - 1]!
        const [newerSource, olderSource] = await Promise.all([
          this.backend.readSourceByUri(connectionId, newer.uri),
          this.backend.readSourceByUri(connectionId, older.uri)
        ])
        return formatVersionComparison(
          input.objectName,
          object.type,
          first,
          second,
          newer,
          older,
          newerSource.source,
          olderSource.source
        )
      }
      const limited = revisions.slice(0, input.maxVersions ?? 20)
      if (!limited.length) {
        return `Version History for ${input.objectName} (${object.type})\n\nNo version history available for this object.`
      }
      let result =
        `Version History for ${input.objectName} (${object.type})\n` +
        `Total Versions: ${revisions.length}${limited.length < revisions.length ? ` (showing ${limited.length})` : ""}\n\n` +
        `| # | Date | Author | Transport | Title |\n` +
        `|---|------|--------|-----------|-------|\n`
      limited.forEach((revision, index) => {
        result += `| ${index + 1} | ${formatDate(revision.date)} | ${revision.author || "Unknown"} | ${revision.version || "-"} | ${revision.versionTitle || "-"} |\n`
      })
      return result
    } catch (error) {
      return ` Failed to get version history: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  async getDiagnostics(input: DiagnosticsInput): Promise<string> {
    let uri: URL
    try {
      uri = new URL(input.fileUri)
    } catch {
      throw new Error("Invalid fileUri. Use get_abap_object_workspace_uri to obtain an adt:// URI.")
    }
    if (uri.protocol !== "adt:" || !uri.hostname) {
      throw new Error("Invalid fileUri. Use get_abap_object_workspace_uri to obtain an adt:// URI.")
    }
    const diagnostics = await this.backend.diagnostics(uri.hostname.toLowerCase(), input.fileUri)
    if (!diagnostics.length) {
      return `No diagnostics found for ${input.fileUri}. The active SAP source has no syntax errors or warnings.`
    }
    const errors = diagnostics.filter((item) => /^E|ERROR$/i.test(item.severity)).length
    const warnings = diagnostics.filter((item) => /^W|WARNING$/i.test(item.severity)).length
    return (
      `Found ${diagnostics.length} diagnostic(s): ${errors} error(s), ${warnings} warning(s)\n\n` +
      diagnostics
        .map(
          (item) =>
            `${diagnosticSeverity(item.severity)} Line ${item.line + 1}, Col ${item.offset + 1}: ${item.text}`
        )
        .join("\n")
    )
  }

  async replaceStringInObject(input: ReplaceSourceInput): Promise<string> {
    const uri = parseWorkspaceUri(input.fileUri)
    const result = await this.backend.replaceSource(
      uri.hostname.toLowerCase(),
      input.fileUri,
      input.oldString,
      input.newString,
      input.transportNumber,
      input.expectedSourceFingerprint
    )
    if (!result.activation.success) {
      throw new Error(
        `Source was saved to SAP but activation failed for ${result.objectName}. The inactive source remains in SAP. ${formatActivationFailure(result.activation.messages, result.activation.inactiveObjects)}`
      )
    }
    return (
      `Successfully replaced ${result.oldLineCount} line(s) with ${result.newLineCount} line(s) in ${result.fileUri}.\n` +
      `Saved, unlocked, and activated ${result.objectName} in SAP.` +
      (result.sourceFingerprintBefore
        ? `\nSource SHA-256 before: ${result.sourceFingerprintBefore}\nIntended saved source SHA-256: ${result.sourceFingerprintAfter}`
        : "") +
      `${result.transportNumber ? `\nTransport: ${result.transportNumber}` : "\nTransport: local object"}`
    )
  }

  async previewSourceChanges(input: z.input<typeof sourcePreflightSchema>): Promise<string> {
    return JSON.stringify(
      await previewSourceChanges(this.backend, input, (assignment) =>
        this.inspectRepositoryAssignment(assignment)
      ),
      null,
      2
    )
  }

  async activateObject(input: ActivateInput): Promise<string> {
    const uri = parseWorkspaceUri(input.url)
    const result = await this.backend.activateSource(uri.hostname.toLowerCase(), input.url)
    if (!result.success) {
      throw new Error(
        `Activation failed for ${input.url}. ${formatActivationFailure(result.messages, result.inactiveObjects)}`
      )
    }
    return `Activation successful for ${input.url}`
  }

  async createObject(input: CreateObjectInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const result = await this.backend.createObject(connectionId, input)
    if (!result.activation.success) {
      throw new Error(
        `${result.objectName} was created in SAP but activation failed. ` +
          `${formatActivationFailure(result.activation.messages, result.activation.inactiveObjects)}`
      )
    }
    return (
      `ABAP Object Created Successfully\n` +
      `Object Type: ${result.objectType}\n` +
      `Name: ${result.objectName}\n` +
      `Description: ${result.description}\n` +
      `Package: ${result.packageName}\n` +
      `${result.parentName ? `Parent: ${result.parentName}\n` : ""}` +
      `Transport: ${result.transportNumber || "local object"}\n` +
      `Workspace URI: ${result.workspaceUri}\n` +
      `Status: created and activated`
    )
  }

  async deleteSourceObject(input: DeleteSourceObjectInput): Promise<string> {
    if (input.confirmation !== "PERMANENT_DELETE") {
      throw new Error("confirmation must be PERMANENT_DELETE")
    }
    const connectionId = input.connectionId.toLowerCase()
    const expectedPackage = packageName(input.packageName)
    const transport = transportNumber(input.transportNumber)
    const parentRequired = input.objectType === "FUGR/I" || input.objectType === "FUGR/FF"
    const parentName = input.parentName ? customerName(input.parentName, "parentName") : ""
    if (parentRequired && !parentName) {
      throw new Error(`${input.objectType} deletion requires parentName`)
    }
    if (!parentRequired && parentName) {
      throw new Error(`${input.objectType} deletion does not accept parentName`)
    }
    if (parentName.length > 26) {
      throw new Error("parentName must not exceed 26 characters")
    }
    const objectName = deletedSourceObjectName(input.objectType, input.objectName, parentName)
    const searchTypes =
      input.objectType === "FUGR/FF"
        ? ["FUNC"]
        : input.objectType === "FUGR/I"
          ? ["PROG"]
          : [input.objectType]

    const matches = await this.backend.searchObjects(connectionId, objectName, searchTypes, 20)
    const object = matches.find(
      (candidate) =>
        candidate.name.toUpperCase() === objectName &&
        deletedSourceTypeMatches(input.objectType, candidate.type)
    )
    if (!object) throw new Error(`ABAP object does not exist: ${input.objectType} ${objectName}`)
    if (parentName && !functionGroupChildOwnedBy(object.uri, parentName)) {
      throw new Error(`PARENT_CONFLICT: Object is not owned by ${parentName}`)
    }
    const customerTechnicalInclude =
      input.objectType === "FUGR/I" &&
      object.systemType !== "CUSTOM" &&
      functionGroupChildOwnedBy(object.uri, parentName)
    if (object.systemType !== "CUSTOM" && !customerTechnicalInclude) {
      throw new Error("Only Z* or Y* customer objects are allowed")
    }
    const actualPackage =
      object.package.trim().toUpperCase() ||
      (await this.sourceObjectPackage(connectionId, input.objectType, objectName, parentName))
    if (actualPackage !== expectedPackage) {
      throw new Error(`PACKAGE_CONFLICT: Object belongs to ${actualPackage || "<empty>"}`)
    }
    const preDeleteFingerprint = await this.backend.deleteObject(
      connectionId,
      object,
      transport,
      input.expectedFingerprint
    )
    if (await this.backend.sourceObjectExists(connectionId, object)) {
      throw new Error("SAP source deletion verification still found the object")
    }
    return JSON.stringify(
      {
        connectionId,
        objectType: input.objectType,
        objectName,
        parentName,
        packageName: expectedPackage,
        transportNumber: transport,
        preDeleteFingerprint,
        absenceVerified: true,
        status: "SOURCE_OBJECT_DELETED"
      },
      null,
      2
    )
  }

  private async sourceObjectPackage(
    connectionId: string,
    objectType: DeleteSourceObjectInput["objectType"],
    objectName: string,
    parentName: string
  ): Promise<string> {
    const assignmentType = objectType === "FUGR/I" ? "FUGR/F" : objectType
    const assignmentName = objectType === "FUGR/I" ? parentName : objectName
    const assignment = JSON.parse(
      await this.inspectRepositoryAssignment({
        connectionId,
        objectType: assignmentType,
        objectName: assignmentName
      })
    ) as { packageName?: unknown }
    return typeof assignment.packageName === "string"
      ? assignment.packageName.trim().toUpperCase()
      : ""
  }

  async createTestInclude(input: CreateTestIncludeInput): Promise<string> {
    const result = await this.backend.createTestInclude(
      input.connectionId.toLowerCase(),
      input.className
    )
    if (!result.activation.success) {
      throw new Error(
        `Test include for ${result.className} was created in SAP but activation failed. ` +
          `${formatActivationFailure(result.activation.messages, result.activation.inactiveObjects)}`
      )
    }
    return (
      `Test include created and activated for ${result.className}.\n` +
      `Workspace URI: ${result.workspaceUri}\n` +
      `Transport: ${result.transportNumber || "local object"}`
    )
  }

  async manageTextElements(input: ManageTextElementsInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    if (input.objectType === "PROGRAM") {
      return this.manageProgramTextElements(input, connectionId)
    }
    if (input.action === "read") {
      const result = await this.backend.readTextElements(
        connectionId,
        input.objectName,
        input.objectType
      )
      if (!result.textElements.length) {
        return (
          `Text Elements for ${result.objectName}\n` +
          `Object Type: ${result.objectType}\nTotal: 0\n\nNo text elements found.`
        )
      }
      return (
        `Text Elements for ${result.objectName}\n` +
        `Object Type: ${result.objectType}\nTotal: ${result.textElements.length}\n\n` +
        result.textElements.map(formatTextElement).join("\n")
      )
    }

    if (!input.textElements?.length) {
      throw new Error("textElements is required for create/update actions")
    }
    const result = await this.backend.writeTextElements(
      connectionId,
      input.objectName,
      input.objectType,
      input.action,
      input.textElements
    )
    if (!result.activation.success) {
      throw new Error(
        `Text elements were saved but activation failed for ${result.objectName}. ` +
          formatActivationFailure(result.activation.messages, result.activation.inactiveObjects)
      )
    }
    return (
      `Text Elements ${input.action === "create" ? "Created" : "Updated"}\n` +
      `Object: ${result.objectName}\nObject Type: ${result.objectType}\n` +
      `Changed IDs: ${result.changedIds.join(", ")}\n` +
      `Total after merge: ${result.textElements.length}\n` +
      `Transport: ${result.transportNumber || "local object"}\n` +
      `Status: saved, unlocked, activated, and verified`
    )
  }

  private async manageProgramTextElements(
    input: ManageTextElementsInput,
    connectionId: string
  ): Promise<string> {
    const write = input.action !== "read"
    const objectName = write
      ? customerName(input.objectName, "objectName")
      : readableObjectName(input.objectName)
    if (write && !input.textElements?.length) {
      throw new Error("textElements is required for create/update actions")
    }
    const requested = write ? validateProgramTextElements(input.textElements!) : []
    const result = await this.backend.callSapRepository(connectionId, {
      operation: write ? "MERGE_TEXT_ELEMENTS" : "READ_TEXT_ELEMENTS",
      objectType: "PROGRAM",
      program: objectName,
      source: write
        ? serializeRepositoryRows(
            "T",
            requested.map((element) => ({
              ID: element.id,
              TEXT: element.text,
              MAXLENGTH: String(element.maxLength ?? Math.max(10, element.text.length)),
              ACTION: input.action.toUpperCase()
            }))
          )
        : undefined
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    const payload = repositoryPayload(result.source)
    const textElements = payload.textRows.map((row) => ({
      id: row.ID ?? "",
      text: row.TEXT ?? "",
      maxLength: numberValue(row.MAXLENGTH)
    }))
    if (!write) {
      if (!textElements.length) {
        return `Text Elements for ${objectName}\nObject Type: PROGRAM\nTotal: 0\n\nNo text elements found.`
      }
      return (
        `Text Elements for ${objectName}\nObject Type: PROGRAM\nTotal: ${textElements.length}\n\n` +
        textElements.map(formatTextElement).join("\n")
      )
    }
    const changedIds = requested.map((element) => element.id)
    for (const changedId of changedIds) {
      if (!textElements.some((element) => element.id === changedId)) {
        throw new Error(`SAP text pool verification did not return ${changedId}`)
      }
    }
    return (
      `Text Elements ${input.action === "create" ? "Created" : "Updated"}\n` +
      `Object: ${objectName}\nObject Type: PROGRAM\n` +
      `Changed IDs: ${changedIds.join(", ")}\n` +
      `Total after merge: ${textElements.length}\n` +
      `Transport: ${payload.metadata.REQUEST || "existing assignment"}\nStatus: saved and verified`
    )
  }

  getAbapSqlSyntax(): string {
    return ABAP_SQL_GUIDE
  }

  async previewConfiguration(input: unknown): Promise<string> {
    return JSON.stringify(
      await previewConfiguration(
        input,
        async () =>
          JSON.parse(
            await this.readDdicTransparentTable({
              connectionId: "w200",
              objectName: CONFIGURATION_TABLE
            })
          ),
        async (query) => JSON.parse(await this.readAbapTable(query)),
        async (query) => JSON.parse(await this.readAbapTable(query)),
        async () =>
          JSON.parse(
            await this.readDdicDomain({
              connectionId: "w200",
              objectName: CONFIGURATION_MODE_DOMAIN
            })
          )
      ),
      null,
      2
    )
  }

  async readAbapTable(input: unknown, nativeFailure?: Error): Promise<string> {
    return JSON.stringify(
      await readAbapTable(
        input,
        this.backend,
        async (connectionId, tableName) =>
          JSON.parse(await this.readDdicTransparentTable({ connectionId, objectName: tableName })),
        async (connectionId, functionName) =>
          JSON.parse(await this.readFunctionModuleInterface({ connectionId, functionName })),
        nativeFailure
      ),
      null,
      2
    )
  }

  async executeDataQuery(input: DataQueryInput): Promise<string> {
    if (input.displayMode !== "internal") {
      throw new Error(
        `Standalone mode does not support displayMode=${input.displayMode}. Use displayMode=internal.`
      )
    }
    if (input.data !== undefined) {
      throw new Error(
        "Standalone mode does not accept direct data; provide a read-only SAP SQL query."
      )
    }
    if (input.webviewId || input.filePath || input.fileType) {
      throw new Error("Standalone mode does not support webviews or file export.")
    }
    if (input.resetSorting !== undefined || input.resetFilters !== undefined) {
      throw new Error(
        "resetSorting and resetFilters require editor webview state and are unsupported."
      )
    }
    if (!input.rowRange) {
      throw new Error("displayMode=internal requires rowRange.")
    }
    if (
      !Number.isInteger(input.rowRange.start) ||
      !Number.isInteger(input.rowRange.end) ||
      input.rowRange.start < 0 ||
      input.rowRange.end <= input.rowRange.start
    ) {
      throw new Error("rowRange must use integers with end > start >= 0.")
    }
    if (input.rowRange.end - input.rowRange.start > 1000) {
      throw new Error("rowRange cannot exceed 1000 rows.")
    }
    const sql = validateReadOnlySql(input.sql)
    const rowCap = Math.min(Math.floor(input.maxRows ?? 1000), 1000)
    let rawRows: Record<string, unknown>[]
    let fallback: Record<string, unknown> | undefined
    try {
      rawRows = await this.backend.runQuery(input.connectionId.toLowerCase(), sql, rowCap + 1)
    } catch (error) {
      const structured = parseSimpleTableSelect(sql)
      if (
        !(error instanceof Error) ||
        error.message !==
          "SAP_DATA_QUERY_RESPONSE_INVALID: expected XML data preview; HTTP 200; mediaType=text/html; root=unparsed; bytes=0. No empty result was inferred." ||
        !structured ||
        rowCap > 500
      )
        throw error
      const result = JSON.parse(
        await this.readAbapTable(
          {
            connectionId: input.connectionId,
            ...structured,
            maxRows: rowCap
          },
          error
        )
      )
      if (result.status !== "ok") {
        throw new Error(`SAP_TABLE_QUERY_FAILED: ${result.code}; stage=${result.stage}`)
      }
      rawRows = result.data
      fallback = {
        method: result.method,
        nativeCode: result.nativeCode,
        representation: result.representation,
        definitionFingerprint: result.definitionFingerprint,
        fieldMetadata: result.fieldMetadata,
        snapshot: false,
        truncated: result.truncated
      }
    }
    const truncated = fallback?.truncated === true || rawRows.length > rowCap
    const fetched = rawRows.slice(0, rowCap)
    const processed = applyDataOperations(fetched, input.filters ?? [], input.sortColumns ?? [])
    const data = processed.slice(input.rowRange.start, input.rowRange.end)
    return JSON.stringify(
      {
        mode: "internal",
        connectionId: input.connectionId.toLowerCase(),
        sql,
        rowCap,
        fetchedRows: fetched.length,
        processedRows: processed.length,
        resultCount: data.length,
        truncated,
        rowRange: input.rowRange,
        ...(fallback ? { querySource: fallback } : {}),
        data
      },
      null,
      2
    )
  }

  async runSciAnalysis(input: SciInput): Promise<string> {
    if (!["precheck", "run"].includes(input.action)) throw new Error("Invalid SCI action")
    if (input.profile !== undefined && input.profile !== "syntax_critical_sql") {
      throw new Error("Invalid SCI profile")
    }
    const target = input.target === undefined ? undefined : sciTargetSchema.parse(input.target)
    const extended = input.profile === "syntax_critical_sql"
    if (extended && !target) throw new Error("SCI profile requires an explicit target")
    const result = await this.testRemoteFunctionModule({
      connectionId: input.connectionId,
      functionName: extended ? SCI_E2_HELPER : target ? SCI_V2_HELPER : SCI_HELPER,
      inputParameters: {
        IV_ACTION: input.action === "precheck" ? "PRECHECK" : "RUN",
        ...(target ? { IV_OBJECT_TYPE: target.objectType, IV_OBJECT_NAME: target.objectName } : {})
      },
      expectedOutputs: { EV_ENGINE: "SCI", EV_VERSION: extended ? "3.0" : target ? "2.0" : "1.0" },
      expectedInterfaceFingerprint: extended
        ? SCI_E2_FINGERPRINT
        : target
          ? SCI_V2_FINGERPRINT
          : SCI_HELPER_FINGERPRINT,
      acknowledgePotentialSideEffects: input.acknowledgePotentialSideEffects
    })
    return extended
      ? formatSciE2Result(JSON.parse(result), input)
      : target
        ? formatSciV2Result(JSON.parse(result), input)
        : formatSciResult(JSON.parse(result), input)
  }

  async runAtcAnalysis(input: AtcInput): Promise<string> {
    const action = input.action ?? "run_analysis"
    if (!input.connectionId) throw new Error(`${action} requires connectionId.`)
    const connectionId = input.connectionId.toLowerCase()
    if (action === "precheck_atc") {
      if (
        input.objectName ||
        input.objectType ||
        input.objectUri ||
        input.fileUris ||
        input.docUri ||
        input.useActiveFile ||
        input.scope ||
        input.includeAtc
      ) {
        throw new Error("precheck_atc takes connectionId only; it does not execute object checks.")
      }
      try {
        return JSON.stringify(
          { connectionId, ...(await this.backend.inspectAtc(connectionId)) },
          null,
          2
        )
      } catch (error) {
        return JSON.stringify(
          {
            connectionId,
            engine: "ATC",
            endpoint: "/sap/bc/adt/atc/customizing",
            method: "GET",
            ...checkFailure(error),
            worklistCreationAttempted: false,
            runCreationAttempted: false,
            variantValidated: false,
            qualityGate: "not_evaluated"
          },
          null,
          2
        )
      }
    }
    if (action === "check_quality") {
      if (
        input.useActiveFile ||
        (input.scope && input.scope !== "object") ||
        input.objectName ||
        input.objectType ||
        input.objectUri ||
        input.docUri
      ) {
        throw new Error(
          "check_quality uses fileUris only; no name, editor, package or transport scope."
        )
      }
      return JSON.stringify(await checkQuality(this.backend, input), null, 2)
    }
    if (action === "get_documentation") {
      if (!input.docUri) throw new Error("get_documentation requires docUri.")
      const html = await this.backend.atcDocumentation(connectionId, input.docUri)
      return (
        `ATC Finding Documentation\nDoc URI: ${input.docUri}\nSystem: ${connectionId}\n\n` +
        stripHtml(html)
      )
    }
    if (input.useActiveFile) {
      throw new Error("Standalone mode has no active editor. Provide objectName or objectUri.")
    }
    if (input.scope && input.scope !== "object") {
      throw new Error(`ATC scope=${input.scope} is not supported; use scope=object.`)
    }

    let objectUri = input.objectUri
    if (!objectUri) {
      if (!input.objectName) throw new Error("run_analysis requires objectName or objectUri.")
      const object = await this.findOne(connectionId, input.objectName, input.objectType)
      if (!object) {
        throw new Error(
          `Could not find ABAP object: ${input.objectName}${input.objectType ? ` (${input.objectType})` : ""}.`
        )
      }
      objectUri = object.uri
    }
    const result = await this.backend.runAtc(connectionId, objectUri)
    return formatAtcResult(connectionId, objectUri, result.variant, result.findings)
  }

  async runUnitTests(input: UnitTestInput): Promise<string> {
    if (input.outputFormat && !["text", "json"].includes(input.outputFormat))
      throw new Error("Invalid Unit output format")
    const connectionId = input.connectionId.toLowerCase()
    const object = await this.findOne(connectionId, input.objectName)
    if (!object) throw new Error(`Could not find ABAP object: ${input.objectName}.`)
    const classes = (await this.backend.runUnitTests(connectionId, object.uri)).map((item) => ({
      ...item,
      methods: item.methods.map((method) => ({
        ...method,
        executionTime:
          typeof method.executionTime === "number" &&
          Number.isFinite(method.executionTime) &&
          method.executionTime >= 0
            ? method.executionTime
            : null
      }))
    }))
    let total = 0
    let passed = 0
    let failed = 0
    let totalTime = 0
    let completeTiming = true
    let classFailure = false
    let notExecuted = 0
    const classResults = []
    let details = ""
    for (const testClass of classes) {
      const classAlerts = testClass.alerts.filter((alert) => alert.kind !== "warning")
      const classPassed =
        classAlerts.length === 0 &&
        testClass.methods.length > 0 &&
        testClass.methods.every((method) =>
          method.alerts.every((alert) => alert.kind === "warning")
        )
      const classStatus =
        classAlerts.length ||
        testClass.methods.some((method) => method.alerts.some((alert) => alert.kind !== "warning"))
          ? "failed"
          : testClass.methods.length
            ? "passed"
            : "not_executed"
      if (classStatus === "not_executed") notExecuted++
      classResults.push({ ...testClass, status: classStatus })
      details += `\n[${classPassed ? "PASS" : classStatus === "not_executed" ? "NOT EXECUTED" : "FAIL"}] ${testClass.name}\n`
      for (const alert of testClass.alerts) details += `  ${formatTestAlert(alert)}\n`
      for (const method of testClass.methods) {
        total++
        if (method.executionTime === null) completeTiming = false
        else totalTime += method.executionTime
        const methodPassed = !method.alerts.some((alert) => alert.kind !== "warning")
        if (methodPassed) passed++
        else {
          failed++
        }
        const duration =
          method.executionTime === null ? "unknown" : `${method.executionTime.toFixed(3)}s`
        details += `  [${methodPassed ? "PASS" : "FAIL"}] ${method.name} (${duration})\n`
        for (const alert of method.alerts) details += `    ${formatTestAlert(alert)}\n`
      }
      if (!classPassed) classFailure = true
    }
    if (!classes.length) details = "\nNo test classes found in this object.\n"
    const allPassed = total > 0 && failed === 0 && !classFailure
    const status = allPassed
      ? "passed"
      : failed > 0 || classResults.some((item) => item.status === "failed")
        ? "failed"
        : classes.length
          ? "not_executed"
          : "no_tests"
    if (input.outputFormat === "json")
      return JSON.stringify(
        {
          connectionId,
          objectName: input.objectName,
          objectUri: object.uri,
          engine: "ABAP Unit",
          nativeAtc: false,
          status,
          total,
          passed,
          failed,
          notExecutedClasses: notExecuted,
          executionTime: completeTiming && total > 0 ? totalTime : null,
          classes: classResults,
          activationPerformed: false,
          evidence:
            "ADT-reported methods and alerts; assertion execution is not independently attested"
        },
        null,
        2
      )
    return (
      `Unit Test Results for ${input.objectName}\n` +
      `Status: ${status === "passed" ? "ALL TESTS PASSED" : status === "failed" ? "SOME TESTS FAILED" : status === "not_executed" ? "TESTS NOT EXECUTED" : "NO TESTS FOUND"}\n` +
      `Total: ${total} | Passed: ${passed} | Failed: ${failed}\n` +
      `Time: ${completeTiming && total > 0 ? `${totalTime.toFixed(3)}s` : "unknown"}\n` +
      `Activation: not performed by standalone service\n` +
      details
    )
  }

  async diagnoseSapFailure(
    input: RuntimeDiagnosticInput,
    receipt?: Record<string, unknown>
  ): Promise<string> {
    const options = validateRuntimeDiagnosticInput(input)
    if (options.operationId && (!receipt || receipt.status === "not_found")) {
      throw new Error("Write operation receipt not found; diagnostic correlation was not attempted")
    }
    const feed = await this.backend.listDumps(options.connectionId.toLowerCase())
    return JSON.stringify(buildRuntimeDiagnosticReport(options, feed, receipt), null, 2)
  }

  async analyzeDumps(input: DumpInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const result = await this.backend.listDumps(connectionId)
    if (!result.available) {
      return "Dumps not available: this SAP system does not expose runtime dumps through ADT."
    }
    if (input.action === "list_dumps") {
      if (!result.dumps.length) {
        return `No dumps found in system ${connectionId}.`
      }
      const maxResults = clampResultCount(input.maxResults, 20, 100)
      const dumps = result.dumps.slice(0, maxResults)
      return (
        `ABAP Runtime Dumps (${dumps.length} of ${result.dumps.length} total)\n` +
        `System: ${connectionId}\n\n` +
        dumps
          .map(
            (dump, index) =>
              `${index + 1}. ${dump.errorType}\n   Dump ID: ${dump.id}\n   Content Size: ${Math.round(dump.text.length / 1024)}KB`
          )
          .join("\n\n")
      )
    }
    if (!input.dumpId) throw new Error("analyze_dump requires dumpId.")
    const dump = result.dumps.find((candidate) => candidate.id === input.dumpId)
    if (!dump) {
      return `Dump not found: no dump with ID "${input.dumpId}" in system ${connectionId}.`
    }
    return formatDump(connectionId, dump, !!input.includeFullContent)
  }

  async analyzeTraces(input: TraceInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const maxResults = clampResultCount(input.maxResults, 20, 100)
    if (input.action === "list_configurations") {
      const configurations = await this.backend.listTraceConfigurations(connectionId)
      if (!configurations.length) {
        return `No trace configurations found in system ${connectionId}.`
      }
      return (
        `ABAP Trace Configurations (${Math.min(configurations.length, maxResults)} of ${configurations.length} total)\n` +
        `System: ${connectionId}\n\n` +
        configurations
          .slice(0, maxResults)
          .map(
            (configuration, index) =>
              `${index + 1}. ${configuration.title} (${configuration.id})\n` +
              `   Host: ${configuration.host} | Admin: ${configuration.admin} | Tracer: ${configuration.tracer}\n` +
              `   Process: ${configuration.processType} | Object: ${configuration.objectType}\n` +
              `   Completed: ${configuration.completedExecutions}/${configuration.maximalExecutions} | Detailed: ${!configuration.isAggregated}\n` +
              `   Published: ${configuration.published.toISOString()}`
          )
          .join("\n\n")
      )
    }

    const runs = await this.backend.listTraceRuns(connectionId)
    if (input.action === "list_runs") return formatTraceRuns(connectionId, runs, maxResults)
    if (!input.traceId) throw new Error(`${input.action} requires traceId.`)
    const run = runs.find((candidate) => candidate.id === input.traceId)
    if (!run) {
      return `Trace run not found: no trace run with ID "${input.traceId}" in system ${connectionId}.`
    }
    if (input.action === "analyze_run") return formatTraceRun(connectionId, run)
    const entries =
      input.action === "get_hitlist" || run.isAggregated
        ? await this.backend.traceHitList(connectionId, input.traceId)
        : await this.backend.traceStatements(connectionId, input.traceId)
    return formatTraceEntries(
      connectionId,
      input.traceId,
      input.action === "get_hitlist" || run.isAggregated ? "Hit List" : "Statements",
      entries
    )
  }

  async manageTransportRequests(input: TransportInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    if (input.action === "prepare_delivery") {
      if (!input.transportNumber || !input.expectedObjects)
        throw new Error("prepare_delivery requires transportNumber and expectedObjects")
      return JSON.stringify(
        await prepareTransportDelivery(this.backend, {
          connectionId,
          transportNumber: input.transportNumber,
          expectedObjects: input.expectedObjects,
          inactiveTargets: input.inactiveTargets
        }),
        null,
        2
      )
    }
    if (input.action === "get_user_transports") {
      const user = (
        input.user || this.backend.connectionDetails(connectionId).username
      ).toUpperCase()
      const transports = await this.backend.listUserTransports(connectionId, user)
      let totalCount = 0
      let result = `Transport Requests for User: ${user}\n\n`
      for (const category of ["workbench", "customizing", "transportofcopies"] as const) {
        const targets = transports[category as keyof typeof transports]
        if (!Array.isArray(targets) || !targets.length) continue
        result += `${category.toUpperCase()}\n`
        for (const target of targets) {
          result += `  Target: ${target["tm:name"]} - ${target["tm:desc"]}\n`
          for (const status of ["modifiable", "released"] as const) {
            if (!target[status]?.length) continue
            result += `    ${status.toUpperCase()}:\n`
            for (const transport of target[status]) {
              totalCount++
              result += `      - ${transport["tm:number"]} - ${transport["tm:owner"]} - ${transport["tm:desc"]}\n`
              result += `        Status: ${transport["tm:status"]} | Tasks: ${transport.tasks?.length || 0} | Objects: ${transport.objects?.length || 0}\n`
            }
          }
        }
        result += "\n"
      }
      return `${result}\nSummary: ${totalCount} transport requests for user ${user}`
    }

    if (input.action === "compare_transports") {
      const transportNumbers = input.transportNumbers?.map(normalizeTransportNumber)
      if (!transportNumbers || transportNumbers.length < 2) {
        throw new Error("At least 2 transport numbers are required for compare_transports action")
      }
      const transports = await Promise.all(
        transportNumbers.map((number) => this.backend.transportDetails(connectionId, number))
      )
      for (let index = 0; index < transports.length; index++) {
        assertTransportNumber(transports[index]!["tm:number"], transportNumbers[index]!)
      }
      return formatTransportComparison(transports)
    }

    if (!input.transportNumber) {
      throw new Error(`transportNumber is required for ${input.action} action`)
    }
    const transportNumber = normalizeTransportNumber(input.transportNumber)
    const transport = await this.backend.transportDetails(connectionId, transportNumber)
    assertTransportNumber(transport["tm:number"], transportNumber)
    return input.action === "get_transport_details"
      ? formatTransportDetails(transport)
      : formatTransportObjects(transport)
  }

  async downloadResource(input: DownloadInput): Promise<string> {
    let connectionId = input.connectionId?.toLowerCase()
    if (input.source.toLowerCase().startsWith("adt://")) {
      const parsed = new URL(input.source)
      if (!parsed.hostname) throw new Error(`Invalid ADT URI: ${input.source}`)
      connectionId ||= parsed.hostname.toLowerCase()
    }
    if (!connectionId) {
      throw new Error("connectionId is required when source is not a full adt:// URI")
    }
    const result = await this.backend.exportResource(connectionId, input.source, input.objectType)
    return writeResourceExport(result, input.target, input.overwrite ?? false)
  }

  async exportAdtDiscovery(input: DiscoveryInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const snapshot = await this.backend.discoverySnapshot(connectionId)
    return writeDiscoveryExport(connectionId, snapshot, this.exportRoot)
  }

  async debugSession(input: DebugSessionInput): Promise<string> {
    const result = await this.backend.debugSession(input.connectionId.toLowerCase(), {
      action: input.action ?? "start",
      ...(input.debugUser ? { debugUser: input.debugUser } : {}),
      ...(input.terminalMode !== undefined ? { terminalMode: input.terminalMode } : {})
    })
    return JSON.stringify(result, null, 2)
  }

  async debugBreakpoint(input: DebugBreakpointInput): Promise<string> {
    const result = await this.backend.debugBreakpoints(input.connectionId.toLowerCase(), {
      action: input.action ?? "set",
      filePath: input.filePath,
      lineNumbers: input.lineNumbers,
      ...(input.condition ? { condition: input.condition } : {})
    })
    return JSON.stringify(result, null, 2)
  }

  debugStatus(input: DebugStatusInput): string {
    return JSON.stringify(this.backend.debugStatus(input.connectionId.toLowerCase()), null, 2)
  }

  async debugStack(input: DebugStackInput): Promise<string> {
    const result = await this.backend.debugStack(
      input.connectionId.toLowerCase(),
      input.threadId ?? 1
    )
    return JSON.stringify(result, null, 2)
  }

  async debugVariable(input: DebugVariableInput): Promise<string> {
    const request: DebugVariableRequest = {
      threadId: input.threadId ?? 1,
      frameId: input.frameId,
      rowStart: input.rowStart ?? 0,
      rowCount: input.rowCount ?? 50,
      maxVariables: input.maxVariables ?? 100,
      expandStructures: input.expandStructures ?? false,
      expandTables: input.expandTables ?? false,
      ...(input.variableName ? { variableName: input.variableName } : {}),
      ...(input.expression ? { expression: input.expression } : {}),
      ...(input.filter ? { filter: input.filter } : {}),
      ...(input.scopeName ? { scopeName: input.scopeName } : {}),
      ...(input.filterPattern ? { filterPattern: input.filterPattern } : {})
    }
    const result = await this.backend.debugVariables(input.connectionId.toLowerCase(), request)
    return JSON.stringify(result, null, 2)
  }

  async debugStep(input: DebugStepInput): Promise<string> {
    const result = await this.backend.debugStep(input.connectionId.toLowerCase(), {
      threadId: input.threadId ?? 1,
      stepType: input.stepType,
      ...(input.targetLine !== undefined ? { targetLine: input.targetLine } : {})
    })
    return JSON.stringify(result, null, 2)
  }

  private async findOne(
    connectionId: string,
    objectName: string,
    objectType?: string
  ): Promise<AbapObjectInfo | undefined> {
    const results = await this.backend.searchObjects(
      connectionId,
      objectName,
      objectType ? [objectType] : undefined,
      1
    )
    return results[0]
  }
}

function screenDefinition(
  connectionId: string,
  programName: string,
  screenNumber: string,
  result: SapRepositoryResult
): ScreenDefinition {
  const flowLogic = result.flowLogic.map((row) => row.LINE ?? "")
  const definition = {
    description: result.dynproText,
    header: result.header,
    fields: result.fields,
    flowLogic,
    params: result.params
  }
  return {
    connectionId,
    programName,
    screenNumber,
    ...definition,
    moduleReferences: screenModuleReferences(flowLogic),
    fingerprint: hashCanonicalJson(definition)
  }
}

function transactionResult(
  connectionId: string,
  transactionCode: string,
  result: SapRepositoryResult
) {
  const metadata = repositoryPayload(result.source).metadata
  const definition = {
    transactions: result.transactions,
    guiAttributes: result.guiAttributes
  }
  return {
    connectionId: connectionId.toLowerCase(),
    transactionCode,
    packageName: metadata.PACKAGE ?? "",
    ...definition,
    fingerprint: hashCanonicalJson(definition)
  }
}

function guiDefinition(
  connectionId: string,
  programName: string,
  result: SapRepositoryResult
): GuiDefinition {
  const metadata: Record<string, string> = {}
  const admin: Record<string, string> = {}
  const sections = emptyGuiSections()
  const byKind = new Map(
    Object.entries(GUI_SECTION_SPECS).map(([name, spec]) => [spec.kind, name as GuiSectionName])
  )
  for (const line of result.source) {
    const match = line.match(/^([A-Z]+)\|(\d+)\|([A-Z0-9_]+)\|(.*)$/)
    if (!match?.[1] || !match[2] || !match[3]) {
      throw new Error(`SAP GUI helper returned an invalid payload line: ${line}`)
    }
    const index = Number.parseInt(match[2], 10)
    if (index < 1) throw new Error(`SAP GUI helper returned an invalid payload index: ${line}`)
    const property = match[3]
    const value = decodeSoapText((match[4] ?? "").replaceAll("%7C", "|").replaceAll("%25", "%"))
    if (match[1] === "M") {
      metadata[property] = value
      continue
    }
    if (match[1] === "ADM") {
      if (!(GUI_ADMIN_FIELDS as readonly string[]).includes(property)) {
        throw new Error(`SAP GUI helper returned an unknown ADM property: ${property}`)
      }
      admin[property] = value
      continue
    }
    const sectionName = byKind.get(match[1] as SapGuiSection)
    if (!sectionName) throw new Error(`SAP GUI helper returned an unknown section: ${match[1]}`)
    const spec = GUI_SECTION_SPECS[sectionName]
    if (!(spec.fields as readonly string[]).includes(property)) {
      throw new Error(`SAP GUI helper returned an unknown ${match[1]} property: ${property}`)
    }
    rowAtRepository(sections[sectionName], index)[property] = value
  }
  sortGuiSections(sections)
  const versionToken = metadata.VERSION ?? ""
  if (!/^\d{14}$/.test(versionToken)) {
    throw new Error("SAP GUI helper returned an invalid version token")
  }
  const definition = { admin, sections }
  return {
    connectionId,
    programName,
    versionToken,
    metadata,
    ...definition,
    fingerprint: hashCanonicalJson(definition)
  }
}

function emptyGuiSections(): Record<GuiSectionName, Array<Record<string, string>>> {
  return Object.fromEntries(
    Object.keys(GUI_SECTION_SPECS).map((name) => [name, [] as Array<Record<string, string>>])
  ) as unknown as Record<GuiSectionName, Array<Record<string, string>>>
}

function sortGuiSections(sections: Record<GuiSectionName, Array<Record<string, string>>>): void {
  for (const [name, rows] of Object.entries(sections)) {
    const keys = GUI_SECTION_SPECS[name as GuiSectionName].keys as readonly string[]
    rows.sort((left, right) => {
      for (const key of keys) {
        const leftValue = left[key] ?? ""
        const rightValue = right[key] ?? ""
        if (leftValue < rightValue) return -1
        if (leftValue > rightValue) return 1
      }
      return 0
    })
  }
}

function valueDifferences(
  expected: unknown,
  actual: unknown,
  path = "definition",
  limit = 20
): string[] {
  if (isDeepStrictEqual(expected, actual)) return []
  const differences: string[] = []
  const add = (difference: string): void => {
    if (differences.length < limit) differences.push(difference)
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      add(`${path}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
      return differences
    }
    if (expected.length !== actual.length) {
      add(`${path}.length: expected ${expected.length}, received ${actual.length}`)
    }
    for (let index = 0; index < Math.min(expected.length, actual.length); index += 1) {
      if (!isDeepStrictEqual(expected[index], actual[index])) {
        differences.push(
          ...valueDifferences(
            expected[index],
            actual[index],
            `${path}[${index}]`,
            limit - differences.length
          )
        )
        if (differences.length >= limit) break
      }
    }
    return differences
  }
  if (isPlainRecord(expected) && isPlainRecord(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()
    for (const key of keys) {
      if (!isDeepStrictEqual(expected[key], actual[key])) {
        differences.push(
          ...valueDifferences(
            expected[key],
            actual[key],
            `${path}.${key}`,
            limit - differences.length
          )
        )
        if (differences.length >= limit) break
      }
    }
    return differences
  }
  add(`${path}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
  return differences
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function guiSectionsByKind(
  sections: Record<GuiSectionName, Array<Record<string, string>>>
): Record<SapGuiSection, Array<Record<string, string>>> {
  return Object.fromEntries(
    Object.entries(GUI_SECTION_SPECS).map(([name, spec]) => [
      spec.kind,
      sections[name as GuiSectionName]
    ])
  ) as Record<SapGuiSection, Array<Record<string, string>>>
}

function normalizeGuiRecord(
  record: Record<string, string>,
  allowedFields: readonly string[],
  label: string
): Record<string, string> {
  const normalized: Record<string, string> = {}
  for (const [rawName, rawValue] of Object.entries(record)) {
    const name = rawName.toUpperCase()
    if (!allowedFields.includes(name)) throw new Error(`Unsupported ${label} property: ${rawName}`)
    validateGuiValue(name, rawValue)
    normalized[name] =
      name === "TEXT" || name.endsWith("_TEXT") || name === "INT_NOTE"
        ? rawValue
        : rawValue.toUpperCase()
  }
  return normalized
}

function validateGuiValue(name: string, value: string): void {
  if (/\r|\n/.test(value))
    throw new Error(`GUI definition property ${name} must not contain line breaks`)
  if (value.length > 132) throw new Error(`GUI definition property ${name} exceeds 132 characters`)
}

function hashCanonicalJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJson(value)))
    .digest("hex")
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJson(entry)])
    )
  }
  return value
}

function screenFieldName(field: Record<string, string>): string | undefined {
  const value = field.NAME ?? field.FNAM
  return value ? value.trim().toUpperCase() : undefined
}

function screenComponentName(value: string): string {
  const name = value.trim().toUpperCase()
  if (!/^[A-Z%][A-Z0-9_%.-]{0,131}$/.test(name)) {
    throw new Error(`Invalid Dynpro component name: ${value}`)
  }
  return name
}

function validatePublicScreenField(field: Record<string, string>): void {
  for (const [property, value] of Object.entries(field)) {
    if (!/^[A-Z][A-Z0-9_]{0,29}$/.test(property)) {
      throw new Error(`Invalid Dynpro component property: ${property}`)
    }
    if (/\r|\n/.test(value)) {
      throw new Error(`Dynpro component property ${property} must not contain line breaks`)
    }
  }
  for (const property of ["LINE", "COLUMN", "LENGTH", "HEIGHT", "VISLENGTH"]) {
    const value = field[property]
    if (value !== undefined && (!/^\d+$/.test(value) || Number.parseInt(value, 10) < 1)) {
      throw new Error(`Dynpro component ${property} must be a positive integer`)
    }
  }
}

function screenHeaderPatch(header: {
  NOLI?: string | undefined
  NOCO?: string | undefined
}): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [property, value] of Object.entries(header)) {
    if (value === undefined) continue
    if (property !== "NOLI" && property !== "NOCO") {
      throw new Error(`Unsupported screen header property: ${property}`)
    }
    if (!/^\d+$/.test(value) || Number.parseInt(value, 10) < 1) {
      throw new Error(`Screen header ${property} must be a positive integer`)
    }
    result[property] = value
  }
  return result
}

function screenModuleReferences(flowLogic: string[]): ScreenModuleReference[] {
  const references: ScreenModuleReference[] = []
  let event: ScreenModuleReference["event"] = "UNKNOWN"
  flowLogic.forEach((line, index) => {
    const normalized = line.trim().toUpperCase()
    if (/^PROCESS\s+BEFORE\s+OUTPUT\s*\./.test(normalized)) event = "PBO"
    else if (/^PROCESS\s+AFTER\s+INPUT\s*\./.test(normalized)) event = "PAI"
    else if (/^PROCESS\s+ON\s+HELP-REQUEST\s*\./.test(normalized)) event = "POH"
    else if (/^PROCESS\s+ON\s+VALUE-REQUEST\s*\./.test(normalized)) event = "POV"
    for (const match of line.matchAll(/\bMODULE\s+([A-Z][A-Z0-9_]*)/gi)) {
      if (match[1]) references.push({ name: match[1].toUpperCase(), event, line: index + 1 })
    }
  })
  return references
}

function validateDynproDefinition(
  screen: ScreenDefinition,
  sourceGraph: ProgramSourceGraph,
  gui: GuiDefinition
) {
  const errors: Array<{ code: string; message: string }> = []
  const warnings: Array<{ code: string; message: string }> = []
  const combinedSource = sourceGraph.units.map((unit) => unit.source).join("\n")
  const names = new Map<string, number>()
  for (const field of screen.fields) {
    const name = screenFieldName(field)
    if (!name) continue
    names.set(name, (names.get(name) ?? 0) + 1)
    const line = numericScreenProperty(field, "LINE")
    const column = numericScreenProperty(field, "COLN", "COLUMN")
    if (line !== undefined && line < 1) {
      errors.push({ code: "INVALID_COMPONENT_LINE", message: `${name} has invalid line ${line}` })
    }
    if (column !== undefined && column < 1) {
      errors.push({
        code: "INVALID_COMPONENT_COLUMN",
        message: `${name} has invalid column ${column}`
      })
    }
  }
  for (const [name, count] of names) {
    if (count > 1) {
      errors.push({
        code: "DUPLICATE_COMPONENT_NAME",
        message: `${name} occurs ${count} times in the native screen definition`
      })
    }
  }

  const definitions = new Map<string, Set<string>>()
  for (const match of combinedSource.matchAll(
    /^\s*MODULE\s+([A-Z][A-Z0-9_]*)\s+(INPUT|OUTPUT)\s*\./gim
  )) {
    const name = match[1]?.toUpperCase()
    const direction = match[2]?.toUpperCase()
    if (!name || !direction) continue
    const directions = definitions.get(name) ?? new Set<string>()
    directions.add(direction)
    definitions.set(name, directions)
  }
  for (const reference of screen.moduleReferences) {
    if (reference.event === "UNKNOWN") {
      errors.push({
        code: "MODULE_EVENT_UNKNOWN",
        message: `Module ${reference.name} at flow line ${reference.line} is not inside a PROCESS block`
      })
      continue
    }
    const expectedDirection = reference.event === "PBO" ? "OUTPUT" : "INPUT"
    const directions = definitions.get(reference.name)
    if (!directions?.has(expectedDirection)) {
      errors.push({
        code: "MODULE_DEFINITION_MISSING",
        message: `${reference.event} module ${reference.name} at flow line ${reference.line} has no ${expectedDirection} definition in the retrieved source graph`
      })
    }
  }
  for (const failure of sourceGraph.failures) {
    warnings.push({
      code: "INCLUDE_SOURCE_UNAVAILABLE",
      message: `${failure.includeName} referenced by ${failure.parentName} was not read: ${failure.reason}`
    })
  }
  if (sourceGraph.truncated) {
    warnings.push({
      code: "INCLUDE_SOURCE_LIMIT_REACHED",
      message: "Include traversal stopped at 32 includes or depth 8"
    })
  }
  for (const name of names.keys()) {
    if (
      /^(GV|GS|GT|P|S)_/.test(name) &&
      !new RegExp(`\\b${escapeRegExp(name)}\\b`, "i").test(combinedSource)
    ) {
      warnings.push({
        code: "CONVENTIONAL_PROGRAM_FIELD_NOT_FOUND",
        message: `${name} was not found in the retrieved main source`
      })
    }
  }
  const guiReferences = staticGuiReferences(combinedSource)
  const statusNames = new Set(gui.sections.statuses.map((row) => row.CODE).filter(Boolean))
  const titleNames = new Set(gui.sections.titles.map((row) => row.CODE).filter(Boolean))
  for (const reference of guiReferences) {
    const exists =
      reference.kind === "PF_STATUS"
        ? statusNames.has(reference.name)
        : titleNames.has(reference.name)
    if (!exists) {
      errors.push({
        code: reference.kind === "PF_STATUS" ? "PF_STATUS_NOT_FOUND" : "TITLEBAR_NOT_FOUND",
        message: `${reference.kind} ${reference.name} is referenced in source but missing from the active GUI definition`
      })
    }
  }
  return {
    status: errors.length ? "invalid" : warnings.length ? "valid_with_warnings" : "valid",
    fieldCount: screen.fields.length,
    flowLineCount: screen.flowLogic.length,
    moduleReferences: screen.moduleReferences,
    moduleDefinitions: [...definitions.entries()].map(([name, directions]) => ({
      name,
      directions: [...directions].sort()
    })),
    guiReferences,
    guiDefinition: {
      versionToken: gui.versionToken,
      fingerprint: gui.fingerprint,
      statusCount: gui.sections.statuses.length,
      titleCount: gui.sections.titles.length
    },
    sourceCoverage: {
      complete: !sourceGraph.failures.length && !sourceGraph.truncated,
      includeLimit: 32,
      maxDepth: 8,
      sources: sourceGraph.units.map(({ objectName, objectType, sourceUri, depth }) => ({
        objectName,
        objectType,
        sourceUri,
        depth
      })),
      failures: sourceGraph.failures
    },
    errors,
    warnings
  }
}

function programIncludeNames(source: string): string[] {
  const names = new Set<string>()
  for (const match of source.matchAll(
    /^\s*INCLUDE\s+([A-Z][A-Z0-9_/$]*)(?:\s+IF\s+FOUND)?\s*\./gim
  )) {
    if (match[1]) names.add(match[1].toUpperCase())
  }
  return [...names]
}

function staticGuiReferences(source: string): Array<{
  kind: "PF_STATUS" | "TITLEBAR"
  name: string
}> {
  const references: Array<{ kind: "PF_STATUS" | "TITLEBAR"; name: string }> = []
  for (const match of source.matchAll(/\bSET\s+PF-STATUS\s+'([^']+)'/gi)) {
    if (match[1]) references.push({ kind: "PF_STATUS", name: match[1].toUpperCase() })
  }
  for (const match of source.matchAll(/\bSET\s+TITLEBAR\s+'([^']+)'/gi)) {
    if (match[1]) references.push({ kind: "TITLEBAR", name: match[1].toUpperCase() })
  }
  return references
}

function numericScreenProperty(
  field: Record<string, string>,
  ...properties: string[]
): number | undefined {
  const value = properties.map((property) => field[property]).find((entry) => entry !== undefined)
  if (value === undefined || value === "") return undefined
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10)
  if (/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    const bytes = Buffer.from(value, "base64")
    if (bytes.length > 0 && bytes.length <= 4 && bytes.toString("base64") === value) {
      let result = 0
      for (const byte of bytes) result = result * 256 + byte
      return result
    }
  }
  return 0
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

interface ExtractedMethod {
  code: string[]
  startLine: number
  endLine: number
}

function normalizeTransportNumber(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (!/^[A-Z0-9]{10}$/.test(normalized)) {
    throw new Error(`Invalid transport number: ${value}`)
  }
  return normalized
}

function assertTransportNumber(actual: unknown, expected: string): void {
  if (typeof actual !== "string" || actual.toUpperCase() !== expected) {
    throw new Error(
      `Transport number mismatch: requested ${expected} but SAP returned ${typeof actual === "string" && actual ? actual : "no transport number"}. This ADT transport endpoint is not compatible with the target system.`
    )
  }
}

function formatTransportDetails(transport: TransportRequest): string {
  let result = `Transport Details: ${transport["tm:number"]}\n`
  result += `Number: ${transport["tm:number"]}\n`
  result += `Owner: ${transport["tm:owner"]}\n`
  result += `Description: ${transport["tm:desc"]}\n`
  result += `Status: ${transport["tm:status"]}\n`
  result += `Objects: ${transport.objects.length}\n\n`
  if (transport.tasks.length) {
    result += `Tasks (${transport.tasks.length}):\n`
    for (const task of transport.tasks) {
      result += `  - ${task["tm:number"]} - ${task["tm:owner"]} - ${task["tm:desc"]}\n`
      result += `    Status: ${task["tm:status"]} | Objects: ${task.objects.length}\n`
    }
    result += "\n"
  }
  if (transport.objects.length) {
    result += `Objects (${transport.objects.length}):\n`
    for (const object of transport.objects) {
      result += `  - ${object["tm:name"]} (${object["tm:type"]}) - ${object["tm:obj_info"]}\n`
    }
  }
  return result
}

function formatTransportObjects(transport: TransportRequest): string {
  const entries = [
    ...transport.objects.map((object) => ({ object, source: "main transport" })),
    ...transport.tasks.flatMap((task) =>
      task.objects.map((object) => ({ object, source: `task ${task["tm:number"]}` }))
    )
  ]
  let result =
    `Objects in Transport: ${transport["tm:number"]}\n` +
    `Main Owner: ${transport["tm:owner"]}\n` +
    `Description: ${transport["tm:desc"]}\n` +
    `Total Objects: ${entries.length} (main transport + all task objects)\n` +
    `Tasks: ${transport.tasks.length}\n\n`
  if (!entries.length) return `${result}No objects in this transport.\n`
  for (const entry of entries) {
    result += `- ${entry.object["tm:pgmid"]} ${entry.object["tm:type"]} ${entry.object["tm:name"]} - ${entry.object["tm:obj_info"]} [${entry.source}]\n`
  }
  return result
}

function formatTransportComparison(transports: TransportRequest[]): string {
  const objectMaps = transports.map((transport) => {
    const map = new Map<string, TransportRequest["objects"][number]>()
    for (const object of [
      ...transport.objects,
      ...transport.tasks.flatMap((task) => task.objects)
    ]) {
      map.set(`${object["tm:pgmid"]}.${object["tm:type"]}.${object["tm:name"]}`, object)
    }
    return map
  })
  const allKeys = new Set(objectMaps.flatMap((objects) => [...objects.keys()]))
  const common = [...allKeys].filter((key) => objectMaps.every((objects) => objects.has(key)))
  let result = `Transport Comparison: ${transports.map((item) => item["tm:number"]).join(" vs ")}\n\nSummary:\n`
  transports.forEach((transport, index) => {
    result += `  - ${transport["tm:number"]} (${transport["tm:owner"]}): ${objectMaps[index]!.size} objects\n`
  })
  result += `  Total Unique Objects: ${allKeys.size}\n\n`
  result += common.length
    ? `COMMON OBJECTS (${common.length}):\n${common.map((key) => `  - ${key}`).join("\n")}\n\n`
    : "COMMON OBJECTS: none\n\n"
  transports.forEach((transport, index) => {
    const unique = [...objectMaps[index]!.keys()].filter((key) =>
      objectMaps.some((objects, otherIndex) => otherIndex !== index && !objects.has(key))
    )
    result += `Unique to ${transport["tm:number"]} (${unique.length}):\n`
    result += unique.length ? `${unique.map((key) => `  - ${key}`).join("\n")}\n\n` : "  none\n\n"
  })
  return result
}

export function extractMethod(lines: string[], methodName: string): ExtractedMethod | undefined {
  const escaped = methodName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const start = new RegExp(`^\\s*METHOD\\s+${escaped}\\s*\\.`, "i")
  let startIndex = -1

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ""
    if (!/^\s*[*\"]/.test(line) && start.test(line)) {
      startIndex = index
      break
    }
  }
  if (startIndex < 0) return undefined

  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index] ?? ""
    if (!/^\s*[*\"]/.test(line) && /^\s*ENDMETHOD\s*\./i.test(line)) {
      return {
        code: lines.slice(startIndex, index + 1),
        startLine: startIndex + 1,
        endLine: index + 1
      }
    }
  }
  return undefined
}

interface LineMatch {
  index: number
  line: string
}

function findLineMatches(lines: string[], term: string, regexp: boolean): LineMatch[] {
  let matcher: (line: string) => boolean
  if (regexp) {
    try {
      const expression = new RegExp(term, "i")
      matcher = (line) => expression.test(line)
    } catch {
      matcher = (line) => line.toUpperCase().includes(term.toUpperCase())
    }
  } else {
    matcher = (line) => line.toUpperCase().includes(term.toUpperCase())
  }
  return lines.flatMap((line, index) => (matcher(line) ? [{ index, line }] : []))
}

function renderMatches(
  lines: string[],
  matches: LineMatch[],
  contextLines: number,
  abapFence: boolean
): string {
  let output = ""
  for (const match of matches) {
    const start = Math.max(0, match.index - contextLines)
    const end = Math.min(lines.length - 1, match.index + contextLines)
    output += `Line ${match.index + 1}:\n\`\`\`${abapFence ? "abap" : ""}\n`
    for (let index = start; index <= end; index++) {
      output += `${index === match.index ? "> " : "  "}${lines[index] ?? ""}\n`
    }
    output += "```\n\n"
  }
  return output
}

function functionGroupIncludeUri(searchUri: string, includeName: string): string {
  const match = searchUri.match(/^\/sap\/bc\/adt\/functions\/groups\/([^/]+)\//i)
  if (!match) return searchUri
  return `/sap/bc/adt/functions/groups/${match[1]}/includes/${encodeURIComponent(
    includeName.toLowerCase()
  )}`
}

function transactionFor(objectType: string): { name: string; field: string; okcode: string } {
  if (objectType === "CLAS/OC" || objectType === "CLAS/I") {
    return { name: "SE24", field: "SEOCLASS-CLSNAME", okcode: "WB_EXEC" }
  }
  if (new Set(["FUGR/FF", "FUNC/FM", "FUNC"]).has(objectType)) {
    return { name: "SE37", field: "RS38L-NAME", okcode: "WB_EXEC" }
  }
  return { name: "SE38", field: "RS38M-PROGRAMM", okcode: "STRT" }
}

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`, "i")
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value)
}

function clientCategory(value: string): string {
  return (
    {
      P: "Production",
      T: "Test",
      C: "Customizing",
      D: "Demo",
      E: "Education/Training",
      S: "SAP Reference",
      "": "Not Classified"
    }[value] ??
    value ??
    "Unknown"
  )
}

function changeProtection(value: string): string {
  return (
    {
      "1": "No changes to cross-client Customizing objects",
      "2": "No changes to Repository objects",
      "3": "No changes to Repository and cross-client Customizing objects",
      "": "Changes to Repository and cross-client Customizing allowed"
    }[value] ??
    value ??
    "Unknown"
  )
}

function formatDate(value: string): string {
  if (!value) return "Unknown"
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  })
}

function formatVersionComparison(
  objectName: string,
  objectType: string,
  first: number,
  second: number,
  newer: RevisionInfo,
  older: RevisionInfo,
  newerSource: string,
  olderSource: string
): string {
  const newerLines = newerSource.split("\n")
  const olderLines = olderSource.split("\n")
  const newerSet = new Set(newerLines.map((line) => line.trim()).filter(Boolean))
  const olderSet = new Set(olderLines.map((line) => line.trim()).filter(Boolean))
  const added = [...newerSet].filter((line) => !olderSet.has(line))
  const removed = [...olderSet].filter((line) => !newerSet.has(line))
  let result =
    `Version Comparison for ${objectName} (${objectType})\n` +
    `Version #${first} (newer) vs Version #${second} (older)\n\n` +
    `| | Version #${first} | Version #${second} |\n` +
    `|---|---|---|\n` +
    `| Date | ${formatDate(newer.date)} | ${formatDate(older.date)} |\n` +
    `| Author | ${newer.author || "Unknown"} | ${older.author || "Unknown"} |\n` +
    `| Transport | ${newer.version || "-"} | ${older.version || "-"} |\n` +
    `| Lines | ${newerLines.length} | ${olderLines.length} |\n\n` +
    `Change Summary: +${added.length} -${removed.length} (net ${newerLines.length - olderLines.length})\n\n`
  if (!added.length && !removed.length)
    return `${result}No differences found - versions are identical.\n`
  if (removed.length)
    result += `Removed:\n\`\`\`diff\n${removed
      .slice(0, 20)
      .map((line) => `- ${line}`)
      .join("\n")}\n\`\`\`\n`
  if (added.length)
    result += `Added:\n\`\`\`diff\n${added
      .slice(0, 20)
      .map((line) => `+ ${line}`)
      .join("\n")}\n\`\`\`\n`
  return result
}

const ABAP_SQL_GUIDE = `ABAP SQL Syntax and Safety Guide

Standalone execute_data_query rules:
- Only one read-only SELECT statement is accepted. Mutations, comments, and multiple statements are rejected.
- Use displayMode="internal" and provide rowRange. The service enforces a maximum fetch cap of 1000 rows.
- Use SAP Dictionary table and field names. Verify them with search/read tools before querying.
- Use ABAP Open SQL alias notation such as t~FIELD, not t.FIELD.
- Use single quotes for character literals. Escape a quote by doubling it.
- Use =, <>, <, <=, >, >=, LIKE, IN, BETWEEN, IS INITIAL, and IS NOT INITIAL as supported by the target release.
- ADT data preview applies the maxRows cap. Do not rely on UP TO n ROWS in the SQL text.
- ECC 7.31 does not support modern Open SQL host-variable @ syntax.
- read_abap_table accepts up to 1024 columns or ["*"], AND comparisons and at most 500 rows. Character-like filters, complete expanded DDIC metadata and verified RFC readers are required for fallback. Numeric output is preserved as SAP text, not converted to JavaScript numbers. Wide rows use <=512-character chunks joined by full primary keys and compared across two observations, with a 256-data-call budget. This is not a transaction snapshot; unsupported fields, overflow or changed rows fail without partial output.
- On the known empty-HTML error, execute_data_query can reuse that reader for SELECT * (or comma-separated plain fields) FROM one table WHERE field = 'value' [AND ...], with explicit maxRows <=500. No joins, aliases, expressions, OR, ORDER BY or numeric filters are translated. Original ADT errors for all other queries remain errors.
- Scoped fallback on w200/client 200: only when ADT returns the known empty HTML response, SELECT <fields or *> FROM ZTPMC_BZWL WHERE WERKS = '809P' can use Z_ORVANTA_MCP_QUERY_API. Allowed fields: MANDT, WERKS, ZPOSNR, ZPKGMATNR, ZPKGTYPE, ZPKGDESC. No joins, expressions, aliases, extra predicates or ORDER BY. SAP plant authorization still applies; all other queries retain the native error.

Example:
SELECT MANDT, MTEXT FROM T000 WHERE MANDT = '200'`

function diagnosticSeverity(value: string): string {
  const normalized = value.toUpperCase()
  if (normalized === "E" || normalized === "ERROR") return "ERROR"
  if (normalized === "W" || normalized === "WARNING") return "WARNING"
  if (normalized === "I" || normalized === "INFO") return "INFO"
  return normalized || "UNKNOWN"
}

export function validateReadOnlySql(sql: string | undefined): string {
  const query = sql?.replace(/^\uFEFF/, "").trim()
  if (!query) throw new Error("A SQL query is required.")
  const lexical = maskSqlStrings(query)
  if (/--|\/\*|\*\//.test(lexical)) {
    throw new Error("SQL comments are not accepted in standalone read-only mode.")
  }
  if (lexical.includes(";")) {
    throw new Error("Only one SQL statement is allowed; semicolons are not accepted.")
  }
  if (!/^SELECT\b/i.test(lexical.trim())) {
    throw new Error("Only read-only SELECT queries are allowed.")
  }
  const mutation = lexical.match(
    /\b(?:INSERT|UPDATE|DELETE|MODIFY|COMMIT|ROLLBACK|CALL|EXECUTE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\b/i
  )
  if (mutation) throw new Error(`Read-only query rejected keyword: ${mutation[0].toUpperCase()}.`)
  return query
}

function maskSqlStrings(sql: string): string {
  let result = ""
  let inString = false
  for (let index = 0; index < sql.length; index++) {
    const character = sql[index]!
    if (character === "'") {
      if (inString && sql[index + 1] === "'") {
        result += "  "
        index++
      } else {
        inString = !inString
        result += " "
      }
    } else {
      result += inString ? " " : character
    }
  }
  if (inString) throw new Error("SQL contains an unterminated string literal.")
  return result
}

function applyDataOperations(
  rows: Record<string, unknown>[],
  filters: Array<{ column: string; value: string }>,
  sorts: Array<{ column: string; direction: "asc" | "desc" }>
): Record<string, unknown>[] {
  let result = rows
  for (const filter of filters) {
    const pattern = wildcardToRegex(filter.value)
    result = result.filter((row) => pattern.test(stringValue(row[filter.column])))
  }
  if (!sorts.length) return result
  return [...result].sort((left, right) => {
    for (const sort of sorts) {
      const leftValue = stringValue(left[sort.column])
      const rightValue = stringValue(right[sort.column])
      const comparison = leftValue.localeCompare(rightValue, undefined, {
        numeric: true,
        sensitivity: "base"
      })
      if (comparison) return sort.direction === "asc" ? comparison : -comparison
    }
    return 0
  })
}

function formatAtcResult(
  connectionId: string,
  objectUri: string,
  variant: string,
  findings: AtcFindingInfo[]
): string {
  const errors = findings.filter((finding) => finding.priority === 1).length
  const warnings = findings.filter((finding) => finding.priority === 2).length
  const infos = findings.filter((finding) => finding.priority >= 3).length
  const exempted = findings.filter((finding) => finding.exemptionApproval).length
  const structured = findings.map((finding) => ({
    object: { name: finding.objectName, type: finding.objectType },
    finding: {
      messageTitle: finding.messageTitle,
      checkTitle: finding.checkTitle,
      checkId: finding.checkId,
      priority: finding.priority,
      priorityText: finding.priority === 1 ? "Error" : finding.priority === 2 ? "Warning" : "Info",
      location: {
        uri: finding.uri,
        line: finding.line + 1,
        character: finding.character + 1
      },
      hasExemption: !!finding.exemptionApproval,
      exemptionStatus: finding.exemptionApproval || null,
      docUri: finding.docUri || null
    }
  }))
  return (
    `ATC Analysis Complete\nTarget: ${objectUri}\nSystem: ${connectionId}\n` +
    `Check Variant: ${variant}\nFindings: ${findings.length} (${errors}E ${warnings}W ${infos}I, ${exempted} exempted)\n\n` +
    `Structured Findings Data:\n${JSON.stringify(
      {
        summary: { totalFindings: findings.length, errors, warnings, infos, exempted },
        findings: structured
      },
      null,
      2
    )}`
  )
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function formatTestAlert(alert: { kind: string; title: string; details: string[] }): string {
  return `${alert.kind}: ${alert.title}${alert.details.length ? ` - ${alert.details.join(" | ")}` : ""}`
}

function clampResultCount(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(maximum, Math.floor(value)))
}

function formatDump(connectionId: string, dump: DumpInfo, includeFullContent: boolean): string {
  let result =
    `ABAP Dump Analysis\nSystem: ${connectionId}\nDump ID: ${dump.id}\n` +
    `Error Type: ${dump.errorType}\nContent Size: ${Math.round(dump.text.length / 1024)}KB HTML\n`
  if (!dump.text) return `${result}No detailed content available\n`
  if (dump.text.includes("<table") || dump.text.includes("<tr")) result += "Contains tabular data\n"
  if (dump.text.includes("<pre>") || dump.text.includes("<code>"))
    result += "Contains code blocks\n"
  if (dump.text.includes("href")) result += "Contains navigation links\n"
  if (includeFullContent) result += `\nFull Dump Content:\n\`\`\`html\n${dump.text}\n\`\`\`\n`
  return result
}

function formatTraceRuns(connectionId: string, runs: TraceRunInfo[], maxResults: number): string {
  if (!runs.length) return `No trace runs found in system ${connectionId}.`
  const sorted = [...runs].sort(
    (left, right) => right.published.valueOf() - left.published.valueOf()
  )
  const selected = sorted.slice(0, maxResults)
  return (
    `ABAP Trace Runs (${selected.length} of ${runs.length} total)\nSystem: ${connectionId}\n\n` +
    selected
      .map((run, index) => {
        const total = run.runtimeAbap + run.runtimeDatabase + run.runtimeSystem || 1
        return (
          `${index + 1}. ${run.title} (${run.id})\n` +
          `   Object: ${run.objectName} | Author: ${run.author}\n` +
          `   Runtime: ${run.runtime}ms (ABAP: ${Math.round((run.runtimeAbap / total) * 100)}%, DB: ${Math.round((run.runtimeDatabase / total) * 100)}%, Sys: ${Math.round((run.runtimeSystem / total) * 100)}%)\n` +
          `   Published: ${run.published.toISOString()}\n` +
          `   Type: ${run.isAggregated ? "Aggregated" : "Detailed"}${run.stateValue === "E" ? " | ERROR STATE" : ""}`
        )
      })
      .join("\n\n")
  )
}

function formatTraceRun(connectionId: string, run: TraceRunInfo): string {
  const total = run.runtimeAbap + run.runtimeDatabase + run.runtimeSystem || 1
  const abap = Math.round((run.runtimeAbap / total) * 100)
  const database = Math.round((run.runtimeDatabase / total) * 100)
  const system = Math.round((run.runtimeSystem / total) * 100)
  let result =
    `ABAP Trace Run Analysis\nSystem: ${connectionId}\nTrace ID: ${run.id}\n` +
    `Title: ${run.title}\nPublished: ${run.published.toISOString()}\n\n` +
    `Performance Summary:\n- Total Runtime: ${run.runtime}ms\n- ABAP Runtime: ${run.runtimeAbap}ms (${abap}%)\n` +
    `- Database Runtime: ${run.runtimeDatabase}ms (${database}%)\n- System Runtime: ${run.runtimeSystem}ms (${system}%)\n\n` +
    `Execution Context:\n- Object: ${run.objectName}\n- Author: ${run.author}\n- Host: ${run.host}\n` +
    `- SAP System: ${run.system}\n- State: ${run.stateText} (${run.stateValue})\n` +
    `- Data Type: ${run.isAggregated ? "Aggregated Summary" : "Detailed Statements"}\n`
  if (run.stateValue === "E") result += "ERROR STATE: trace execution failed\n"
  if (database > 50) result += `Database bottleneck indicator: ${database}% database time\n`
  if (abap > 80) result += `ABAP intensive indicator: ${abap}% ABAP processing\n`
  if (run.runtime > 10000) result += `Long execution indicator: ${run.runtime}ms total\n`
  return result
}

function formatTraceEntries(
  connectionId: string,
  traceId: string,
  kind: "Hit List" | "Statements",
  entries: TraceEntryInfo[]
): string {
  if (!entries.length) return `No ${kind.toLowerCase()} data available for trace ${traceId}.`
  const maximum = kind === "Hit List" ? 15 : 20
  const sorted = [...entries].sort((left, right) => right.netTime - left.netTime)
  const totalNet = entries.reduce((sum, entry) => sum + entry.netTime, 0)
  const totalHits = entries.reduce((sum, entry) => sum + entry.hitCount, 0)
  return (
    `ABAP Trace ${kind} Analysis\nSystem: ${connectionId}\nTrace ID: ${traceId}\n` +
    `Total Entries: ${entries.length}\n\nTop Performance Hotspots:\n` +
    sorted
      .slice(0, maximum)
      .map(
        (entry, index) =>
          `${index + 1}. ${entry.description || "Unknown Operation"}\n` +
          `   Net: ${entry.netTime}ms | Gross: ${entry.grossTime}ms | Hits: ${entry.hitCount}` +
          `${entry.callLevel === undefined ? "" : ` | CallLevel: ${entry.callLevel}`}\n` +
          `   Program: ${entry.program}${entry.context ? ` (${entry.context})` : ""}` +
          `${entry.uri ? `\n   URI: ${entry.uri}` : ""}`
      )
      .join("\n\n") +
    `\n\nStatistics:\n- Total Net Time: ${totalNet}ms\n- Total Hits: ${totalHits}\n` +
    `- Average Time/Entry: ${Math.round(totalNet / entries.length)}ms\n`
  )
}

function parseWorkspaceUri(fileUri: string): URL {
  let uri: URL
  try {
    uri = new URL(fileUri)
  } catch {
    throw new Error("Invalid URI. Use get_abap_object_workspace_uri to obtain an adt:// URI.")
  }
  if (uri.protocol !== "adt:" || !uri.hostname) {
    throw new Error("Invalid URI. Use get_abap_object_workspace_uri to obtain an adt:// URI.")
  }
  return uri
}

function formatActivationFailure(
  messages: ActivationMessageInfo[],
  inactiveObjects: string[]
): string {
  const details = messages.map((message) => {
    const location = message.line > 0 ? ` line ${message.line}` : ""
    return `[${message.type || "ERROR"}]${location}: ${message.text}`
  })
  if (inactiveObjects.length) details.push(`Inactive objects: ${inactiveObjects.join(", ")}`)
  return details.length ? details.join("; ") : "SAP returned no activation details."
}

function formatTextElement(element: TextElementInfo): string {
  return `- ${element.id}: ${JSON.stringify(element.text)}${
    element.maxLength === undefined ? "" : ` (max: ${element.maxLength})`
  }`
}

type DdicKind = "domain" | "dataElement" | "structure" | "transparentTable" | "tableType"

function ddicResult(
  result: SapDdicResult,
  kind: DdicKind,
  objectName: string,
  connectionId: string
): Record<string, unknown> {
  const definition = ddicDefinition(result, kind)
  return {
    connectionId: connectionId.toLowerCase(),
    objectKind: kind,
    objectName,
    packageName: result.packageName,
    version: result.objectVersion,
    fingerprint: createHash("sha256").update(JSON.stringify(definition)).digest("hex"),
    definition
  }
}

function ddicDefinition(result: SapDdicResult, kind: DdicKind): Record<string, unknown> {
  if (kind === "domain") {
    return {
      description: result.header.DDTEXT ?? "",
      dataType: result.header.DATATYPE ?? "",
      length: numberValue(result.header.LENG),
      outputLength: numberValue(result.header.OUTPUTLEN),
      decimals: numberValue(result.header.DECIMALS),
      lowercase: result.header.LOWERCASE === "X",
      signFlag: result.header.SIGNFLAG === "X",
      valueTable: result.header.ENTITYTAB ?? "",
      conversionExit: result.header.CONVEXIT ?? "",
      fixedValues: result.fixedValues.map((value) => ({
        low: value.DOMVALUE_L ?? "",
        high: value.DOMVALUE_H ?? "",
        description: value.DDTEXT ?? ""
      }))
    }
  }
  if (kind === "dataElement") {
    return {
      description: result.header.DDTEXT ?? "",
      domainName: result.header.DOMNAME ?? "",
      heading: result.header.REPTEXT ?? "",
      short: result.header.SCRTEXT_S ?? "",
      medium: result.header.SCRTEXT_M ?? "",
      long: result.header.SCRTEXT_L ?? ""
    }
  }
  if (kind === "structure") {
    return {
      description: result.header.DDTEXT ?? "",
      tableClass: result.header.TABCLASS ?? "",
      fields: result.fields.map((field) => ({
        name: field.FIELDNAME ?? "",
        position: numberValue(field.POSITION),
        dataElement: field.ROLLNAME ?? "",
        description: field.DDTEXT ?? ""
      }))
    }
  }
  if (kind === "transparentTable") {
    const maintenance = result.header.MAINFLAG ?? ""
    return {
      description: result.header.DDTEXT ?? "",
      tableClass: result.header.TABCLASS ?? "",
      deliveryClass: result.header.CONTFLAG ?? "",
      dataBrowserMaintenance:
        maintenance === "X" ? "allowed" : maintenance === "R" ? "restricted" : "notAllowed",
      sizeCategory: numberValue(result.header.TABKAT),
      dataClass: result.header.TABART ?? "",
      buffering:
        result.header.BUFALLOW === "X"
          ? result.header.PUFFERUNG === "P"
            ? "singleRecord"
            : result.header.PUFFERUNG === "G"
              ? "generic"
              : result.header.PUFFERUNG === "X"
                ? "full"
                : "enabled"
          : result.header.BUFALLOW === "A"
            ? "allowedButOff"
            : "notAllowed",
      fields: result.fields.map((field) => ({
        name: field.FIELDNAME ?? "",
        position: numberValue(field.POSITION),
        dataElement: field.ROLLNAME ?? "",
        description: field.DDTEXT ?? "",
        key: field.KEYFLAG === "X",
        notNull: field.NOTNULL === "X"
      }))
    }
  }
  return {
    description: result.header.DDTEXT ?? "",
    rowType: result.header.ROWTYPE ?? "",
    rowKind: result.header.ROWKIND ?? "",
    dataType: result.header.DATATYPE ?? "",
    accessMode: result.header.ACCESSMODE ?? "",
    keyDefinition: result.header.KEYDEF ?? "",
    keyKind: result.header.KEYKIND ?? ""
  }
}

function savedDdicResult(
  result: SapDdicResult,
  kind: DdicKind,
  objectName: string,
  packageName: string,
  connectionId: string,
  expectedDefinition: Record<string, unknown>
): string {
  requireDdicSuccess(result)
  const identityField = {
    domain: "DOMNAME",
    dataElement: "ROLLNAME",
    structure: "TABNAME",
    transparentTable: "TABNAME",
    tableType: "TYPENAME"
  }[kind]
  if (result.header[identityField] !== objectName) {
    throw new Error(
      `SAP DDIC verification returned another object: ${result.header[identityField]}`
    )
  }
  if (result.packageName !== packageName.trim().toUpperCase()) {
    throw new Error(`SAP DDIC verification returned package ${result.packageName || "<empty>"}`)
  }
  if (!/^\d{14}$/.test(result.objectVersion)) {
    throw new Error("SAP DDIC verification did not return an active version token")
  }
  if (!result.recordedRequest) {
    throw new Error("SAP DDIC verification did not return the recorded transport request or task")
  }
  const definition = ddicDefinition(result, kind)
  if (!matchesSubset(definition, expectedDefinition)) {
    throw new Error("SAP DDIC verification did not return the requested active definition")
  }
  return JSON.stringify(
    {
      ...ddicResult(result, kind, objectName, connectionId),
      status: result.code,
      recordedRequest: result.recordedRequest
    },
    null,
    2
  )
}

function matchesSubset(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => matchesSubset(actual[index], value))
    )
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false
    return Object.entries(expected).every(([key, value]) =>
      matchesSubset((actual as Record<string, unknown>)[key], value)
    )
  }
  return actual === expected
}

function containsLineSequence(actual: string[], expected: string[]): boolean {
  if (!expected.length || expected.length > actual.length) return false
  return actual.some(
    (_line, start) =>
      start + expected.length <= actual.length &&
      expected.every((line, offset) => actual[start + offset] === line)
  )
}

function requireDdicSuccess(result: SapDdicResult): void {
  if (result.status.toUpperCase() !== "S") {
    throw new Error(`SAP DDIC helper rejected the operation: ${result.code}: ${result.message}`)
  }
}

function ddicName(value: string, field: string): string {
  const normalized = value.trim().toUpperCase()
  if (!/^(?:[A-Z0-9_][A-Z0-9_]*|\/[A-Z0-9_]+\/[A-Z0-9_]+)$/.test(normalized)) {
    throw new Error(`${field} is not a valid SAP Dictionary name`)
  }
  if (normalized.length > 30) throw new Error(`${field} must not exceed 30 characters`)
  return normalized
}

function customerDdicName(value: string): string {
  const normalized = ddicName(value, "objectName")
  if (!/^[ZY]/.test(normalized)) throw new Error("objectName must name a Z* or Y* customer object")
  return normalized
}

function customerDdicTableName(value: string): string {
  const normalized = customerDdicName(value)
  if (normalized.length > 16) {
    throw new Error("Transparent table objectName must not exceed 16 characters on ECC 7.31")
  }
  return normalized
}

function ddicFieldName(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (!/^[A-Z][A-Z0-9_]{0,29}$/.test(normalized)) {
    throw new Error(`Invalid structure field name: ${value}`)
  }
  return normalized
}

function ddicPackageName(value: string): string {
  if (value.trim().toUpperCase() === "$TMP") {
    throw new Error("A transportable package is required for DDIC objects")
  }
  const normalized = ddicName(value, "packageName")
  return normalized
}

function versionToken(value?: string): string | undefined {
  const normalized = value?.trim()
  if (!normalized) return undefined
  if (!/^\d{14}$/.test(normalized)) {
    throw new Error("expectedVersion must be the 14-digit token returned by a DDIC read tool")
  }
  return normalized
}

function requiredVersionToken(value: string): string {
  const normalized = versionToken(value)
  if (!normalized) throw new Error("expectedVersion is required")
  return normalized
}

function validateDescription(value: string): void {
  validateTextLength(value, 60, "description")
  if (!value.trim()) throw new Error("description is required")
}

function validateTextLength(value: string, maximum: number, field: string): void {
  if (value.length > maximum) throw new Error(`${field} must not exceed ${maximum} characters`)
}

function validateDomainDefinition(input: UpsertDomainInput): void {
  if (!Number.isInteger(input.length) || input.length < 1 || input.length > 255) {
    throw new Error("length must be an integer from 1 to 255")
  }
  const decimals = input.decimals ?? 0
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 14) {
    throw new Error("decimals must be an integer from 0 to 14")
  }
  if (input.dataType === "DATS" && input.length !== 8) throw new Error("DATS length must be 8")
  if (input.dataType === "TIMS" && input.length !== 6) throw new Error("TIMS length must be 6")
  if (input.dataType !== "DEC" && decimals !== 0) {
    throw new Error("decimals may only be set for DEC domains")
  }
  if (input.dataType === "DEC" && (input.length > 31 || decimals >= input.length)) {
    throw new Error("DEC length must be at most 31 and greater than decimals")
  }
  if (input.lowercase && input.dataType !== "CHAR") {
    throw new Error("lowercase is only valid for CHAR domains")
  }
  if (input.signFlag && input.dataType !== "DEC") {
    throw new Error("signFlag is only valid for DEC domains")
  }
  if (input.conversionExit) {
    const conversionExit = input.conversionExit.trim().toUpperCase()
    if (!/^[A-Z0-9_]{1,5}$/.test(conversionExit)) {
      throw new Error("conversionExit must contain 1-5 letters, digits, or underscores")
    }
  }
  if (input.valueTable) ddicName(input.valueTable, "valueTable")
  if (input.fixedValues?.length && !["CHAR", "NUMC"].includes(input.dataType)) {
    throw new Error("fixedValues are only supported for CHAR and NUMC domains")
  }
  const values = new Set<string>()
  for (const fixedValue of input.fixedValues ?? []) {
    validateTextLength(fixedValue.description, 60, "fixed value description")
    if (!fixedValue.low) throw new Error("fixed value low is required")
    if (fixedValue.low.length > input.length || (fixedValue.high?.length ?? 0) > input.length) {
      throw new Error("fixed value exceeds the domain length")
    }
    const key = `${fixedValue.low}\u0000${fixedValue.high ?? ""}`
    if (values.has(key)) throw new Error(`Duplicate fixed value: ${fixedValue.low}`)
    values.add(key)
  }
}

function validateTransparentTableFields(
  input: CreateTransparentTableInput["fields"]
): Array<Record<string, string>> {
  if (!input.length) throw new Error("fields must contain at least one table field")
  const names = new Set<string>()
  let nonKeySeen = false
  return input.map((field, index) => {
    const name = ddicFieldName(field.name)
    if (names.has(name)) throw new Error(`Duplicate transparent table field: ${name}`)
    names.add(name)
    const key = field.key ?? false
    if (!key) nonKeySeen = true
    if (key && nonKeySeen) throw new Error("Key fields must be contiguous at the beginning")
    if (name === "MANDT") {
      if (index !== 0 || !key || ddicName(field.dataElement, "dataElement") !== "MANDT") {
        throw new Error("MANDT must be the first key field and use data element MANDT")
      }
    }
    return {
      FIELDNAME: name,
      ROLLNAME: ddicName(field.dataElement, "dataElement"),
      KEYFLAG: key ? "X" : "",
      NOTNULL: "X"
    }
  })
}

function validateAppendedTransparentTableFields(
  input: AppendTransparentTableFieldsInput["fields"]
): Array<{ FIELDNAME: string; ROLLNAME: string; KEYFLAG: string; NOTNULL: string }> {
  if (!input.length) throw new Error("fields must contain at least one field to append")
  if (input.length > 32) throw new Error("No more than 32 fields may be appended per operation")
  const names = new Set<string>()
  return input.map((field) => {
    const name = ddicFieldName(field.name)
    if (name === "MANDT") throw new Error("MANDT cannot be appended to an existing table")
    if (names.has(name)) throw new Error(`Duplicate appended transparent table field: ${name}`)
    names.add(name)
    return {
      FIELDNAME: name,
      ROLLNAME: ddicName(field.dataElement, "dataElement"),
      KEYFLAG: "",
      NOTNULL: ""
    }
  })
}

interface TransparentTableFieldDefinition {
  name: string
  dataElement: string
  key: boolean
  notNull: boolean
}

function requiredDdicFingerprint(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("expectedFingerprint must be returned by read_ddic_transparent_table")
  }
  return normalized
}

function requireCurrentDdicDefinition(
  result: SapDdicResult,
  packageName: string,
  expectedVersion: string
): void {
  requireDdicSuccess(result)
  if (result.packageName !== packageName) {
    throw new Error(`SAP DDIC verification returned package ${result.packageName || "<empty>"}`)
  }
  if (result.objectVersion !== expectedVersion) {
    throw new Error("VERSION_CONFLICT: DDIC object changed since it was read")
  }
}

function transparentTableFields(
  definition: Record<string, unknown>
): TransparentTableFieldDefinition[] {
  if (!Array.isArray(definition.fields)) {
    throw new Error("SAP DDIC verification did not return transparent table fields")
  }
  return definition.fields.map((value) => {
    const field = value as Record<string, unknown>
    return {
      name: String(field.name ?? "").toUpperCase(),
      dataElement: String(field.dataElement ?? "").toUpperCase(),
      key: field.key === true,
      notNull: field.notNull === true
    }
  })
}

function applyTransparentTableFieldChanges(
  current: TransparentTableFieldDefinition[],
  changes: TransparentTableFieldChange[]
): TransparentTableFieldDefinition[] {
  const fields = current.map((field) => ({ ...field }))
  for (const change of changes) {
    const fieldName = ddicFieldName(change.fieldName)
    if (fieldName === "MANDT") throw new Error("MANDT cannot be changed")
    const index = fields.findIndex((field) => field.name === fieldName)
    if (index < 0) throw new Error(`Transparent table field does not exist: ${fieldName}`)
    if (change.action === "remove") {
      fields.splice(index, 1)
      continue
    }
    if (change.action === "rename") {
      const newName = ddicFieldName(change.newName)
      if (newName === "MANDT") throw new Error("A field cannot be renamed to MANDT")
      if (newName === fieldName) throw new Error(`Field rename is a no-op: ${fieldName}`)
      if (fields.some((field, fieldIndex) => fieldIndex !== index && field.name === newName)) {
        throw new Error(`Transparent table field already exists: ${newName}`)
      }
      fields[index]!.name = newName
      continue
    }
    if (
      change.dataElement === undefined &&
      change.key === undefined &&
      change.notNull === undefined
    ) {
      throw new Error(`Field update has no attributes: ${fieldName}`)
    }
    const field = fields[index]!
    const updated = {
      ...field,
      dataElement:
        change.dataElement === undefined
          ? field.dataElement
          : ddicName(change.dataElement, "dataElement"),
      key: change.key ?? field.key,
      notNull: change.notNull ?? field.notNull
    }
    if (
      updated.dataElement === field.dataElement &&
      updated.key === field.key &&
      updated.notNull === field.notNull
    ) {
      throw new Error(`Field update is a no-op: ${fieldName}`)
    }
    fields[index] = updated
  }
  if (!fields.length) throw new Error("A transparent table must retain at least one field")
  let nonKeySeen = false
  for (const field of fields) {
    if (!field.key) nonKeySeen = true
    if (field.key && nonKeySeen) throw new Error("Key fields must be contiguous at the beginning")
    if (field.key && !field.notNull) throw new Error(`Key field must be not null: ${field.name}`)
  }
  if (JSON.stringify(fields) === JSON.stringify(current)) {
    throw new Error("Transparent table field patch does not change the active definition")
  }
  return fields
}

function numberValue(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "0", 10)
  return Number.isNaN(parsed) ? 0 : parsed
}

function serializeRepositoryRows(kind: "F" | "T", rows: Array<Record<string, string>>): string[] {
  const payload: string[] = []
  rows.forEach((row, rowIndex) => {
    Object.entries(row).forEach(([name, value]) => {
      if (/\r|\n/.test(value))
        throw new Error("Repository payload values must not contain line breaks")
      const line = `${kind}|${rowIndex + 1}|${name.toUpperCase()}|${value.replaceAll("%", "%25").replaceAll("|", "%7C")}`
      if (line.length > 255) throw new Error("Repository payload line exceeds ABAPTXT255")
      payload.push(line)
    })
  })
  return payload
}

type FunctionParameterKind = "I" | "E" | "C" | "T"

interface FunctionModuleDefinition {
  remoteEnabled: boolean
  importParameters: Required<FunctionParameterInput>[]
  exportParameters: Required<FunctionParameterInput>[]
  changingParameters: Required<FunctionParameterInput>[]
  tableParameters: Required<FunctionParameterInput>[]
  exceptions: Array<{ name: string; description: string }>
  source: string[]
}

function functionModuleDefinition(input: CreateFunctionModuleInput): FunctionModuleDefinition {
  const names = new Set<string>()
  const parameters = (values: FunctionParameterInput[], kind: string) =>
    values.map((value) => {
      const name = functionComponentName(value.name, `${kind} parameter`)
      if (names.has(name)) throw new Error(`Duplicate function interface name: ${name}`)
      names.add(name)
      return {
        name,
        typeName: ddicName(value.typeName, `${kind} parameter typeName`),
        optional: value.optional ?? false,
        passByValue: value.passByValue ?? false,
        description: functionDescription(value.description, `${kind} parameter ${name}`)
      }
    })
  if (input.tableParameters.some((value) => value.passByValue)) {
    throw new Error("table parameters cannot be passed by value")
  }
  const exceptions = input.exceptions.map((value) => {
    const name = functionComponentName(value.name, "exception")
    if (names.has(name)) throw new Error(`Duplicate function interface name: ${name}`)
    names.add(name)
    const description = value.description ?? ""
    validateTextLength(description, 60, `exception ${name} description`)
    return { name, description }
  })
  if (!input.source.length) throw new Error("source must contain at least one ABAP line")
  const source = input.source.map((line) => {
    if (/\r|\n/.test(line)) throw new Error("Each source entry must contain exactly one ABAP line")
    if (/^\s*(?:FUNCTION|ENDFUNCTION)\b/i.test(line)) {
      throw new Error("source must contain only the function body, without FUNCTION/ENDFUNCTION")
    }
    if (line.length > 200)
      throw new Error("Function module source lines must not exceed 200 characters")
    return line
  })
  return {
    remoteEnabled: input.remoteEnabled,
    importParameters: parameters(input.importParameters, "import"),
    exportParameters: parameters(input.exportParameters, "export"),
    changingParameters: parameters(input.changingParameters, "changing"),
    tableParameters: parameters(input.tableParameters, "table"),
    exceptions,
    source
  }
}

function serializeFunctionDefinition(definition: FunctionModuleDefinition): string[] {
  const payload: string[] = []
  const append = (kind: FunctionParameterKind, rows: Required<FunctionParameterInput>[]) => {
    rows.forEach((row, index) => {
      appendFunctionPayload(payload, kind, index + 1, "PARAMETER", row.name)
      appendFunctionPayload(
        payload,
        kind,
        index + 1,
        kind === "T" ? "DBSTRUCT" : "TYP",
        row.typeName
      )
      if (kind !== "E") {
        appendFunctionPayload(payload, kind, index + 1, "OPTIONAL", row.optional ? "X" : "")
      }
      if (kind !== "T") {
        appendFunctionPayload(payload, kind, index + 1, "PASSVALUE", row.passByValue ? "X" : "")
      }
      appendFunctionPayload(payload, kind, index + 1, "TEXT", row.description ?? "")
    })
  }
  append("I", definition.importParameters)
  append("E", definition.exportParameters)
  append("C", definition.changingParameters)
  append("T", definition.tableParameters)
  definition.exceptions.forEach((row, index) => {
    appendFunctionPayload(payload, "X", index + 1, "EXCEPTION", row.name)
    appendFunctionPayload(payload, "X", index + 1, "TEXT", row.description)
  })
  definition.source.forEach((line, index) =>
    appendFunctionPayload(payload, "S", index + 1, "LINE", line)
  )
  return payload
}

function appendFunctionPayload(
  payload: string[],
  kind: FunctionParameterKind | "M" | "X" | "S",
  index: number,
  property: string,
  value: string
): void {
  const line = `${kind}|${index}|${property}|${value.replaceAll("%", "%25").replaceAll("|", "%7C")}`
  if (line.length > 255) throw new Error("Function interface payload line exceeds ABAPTXT255")
  payload.push(line)
}

function parseFunctionPayload(lines: string[]): {
  metadata: Record<string, string>
  imports: Array<Record<string, string>>
  exports: Array<Record<string, string>>
  changing: Array<Record<string, string>>
  tables: Array<Record<string, string>>
  exceptions: Array<Record<string, string>>
  source: Array<Record<string, string>>
} {
  const parsed = {
    metadata: {} as Record<string, string>,
    imports: [] as Array<Record<string, string>>,
    exports: [] as Array<Record<string, string>>,
    changing: [] as Array<Record<string, string>>,
    tables: [] as Array<Record<string, string>>,
    exceptions: [] as Array<Record<string, string>>,
    source: [] as Array<Record<string, string>>
  }
  for (const line of lines) {
    const match = line.match(/^([MIECTXS])\|(\d+)\|([A-Z0-9_]+)\|(.*)$/)
    if (!match?.[1] || !match[2] || !match[3]) {
      throw new Error(`SAP function helper returned an invalid payload line: ${line}`)
    }
    const index = Number.parseInt(match[2], 10)
    if (index < 1) throw new Error(`SAP function helper returned an invalid payload index: ${line}`)
    const decoded = (match[4] ?? "").replaceAll("%7C", "|").replaceAll("%25", "%")
    const value = match[1] === "S" && /^PART\d+$/.test(match[3]) ? decoded : decodeSoapText(decoded)
    const target =
      match[1] === "M"
        ? parsed.metadata
        : rowAtRepository(
            {
              I: parsed.imports,
              E: parsed.exports,
              C: parsed.changing,
              T: parsed.tables,
              X: parsed.exceptions,
              S: parsed.source
            }[match[1]]!,
            index
          )
    if (Object.hasOwn(target, match[3])) {
      throw new Error(`SAP function helper returned a duplicate payload property: ${line}`)
    }
    target[match[3]] = value
  }
  return parsed
}

function functionModuleResult(
  result: SapRepositoryResult,
  connectionId: string,
  functionName: string
) {
  const payload = parseFunctionPayload(result.source)
  if (payload.metadata.SOURCE_FORMAT) {
    if (
      payload.metadata.SOURCE_FORMAT !== "CHUNKS_V1" ||
      !/^[1-9]\d*$/.test(payload.metadata.SOURCE_LINES ?? "") ||
      Number(payload.metadata.SOURCE_LINES) !== payload.source.length
    ) {
      throw new Error("Function source format or line count is invalid")
    }
  }
  const parameter = (row: Record<string, string>) => ({
    name: row.PARAMETER ?? "",
    typeName: row.TYP || row.DBFIELD || row.DBSTRUCT || "",
    optional: row.OPTIONAL === "X",
    passByValue: row.PASSVALUE === "X",
    description: row.TEXT ?? ""
  })
  const definition = {
    remoteEnabled: !!payload.metadata.REMOTE_ENABLED,
    importParameters: payload.imports.map(parameter),
    exportParameters: payload.exports.map(parameter),
    changingParameters: payload.changing.map(parameter),
    tableParameters: payload.tables.map(parameter),
    exceptions: payload.exceptions.map((row) => ({
      name: row.EXCEPTION ?? "",
      description: row.TEXT ?? ""
    })),
    source: payload.source.map((row) => functionSourceLine(row, payload.metadata.SOURCE_FORMAT))
  }
  const interfaceDefinition = {
    remoteMode: payload.metadata.REMOTE_ENABLED ?? "",
    updateTaskMode: payload.metadata.UPDATE_TASK ?? "",
    globalInterface: payload.metadata.GLOBAL_INTERFACE === "X",
    ...definition,
    source: undefined
  }
  const interfaceFingerprint = createHash("sha256")
    .update(JSON.stringify(interfaceDefinition))
    .digest("hex")
  const sourceFingerprint = createHash("sha256")
    .update(JSON.stringify(functionImplementationSource(definition.source)))
    .digest("hex")
  const fingerprint = createHash("sha256").update(JSON.stringify(definition)).digest("hex")
  const response = {
    connectionId,
    functionName,
    functionGroup: payload.metadata.FUNCTION_GROUP ?? "",
    shortText: payload.metadata.SHORT_TEXT ?? "",
    remoteMode: payload.metadata.REMOTE_ENABLED ?? "",
    updateTask: payload.metadata.UPDATE_TASK === "X",
    updateTaskMode: payload.metadata.UPDATE_TASK ?? "",
    globalInterface: payload.metadata.GLOBAL_INTERFACE === "X",
    ...definition,
    fingerprint,
    interfaceFingerprint,
    sourceFingerprint
  }
  return Object.defineProperty(response, "snapshotPayload", {
    value: result.source.map((line) => decodeSoapText(line)),
    enumerable: false
  }) as typeof response & { snapshotPayload: string[] }
}

function functionSourceLine(row: Record<string, string>, format: string | undefined): string {
  if (!format) return row.LINE ?? ""
  if (format !== "CHUNKS_V1") throw new Error(`Unsupported function source format: ${format}`)
  if (!/^(0|[1-9]\d*)$/.test(row.LENGTH ?? "")) {
    throw new Error("Function source chunk length is missing or invalid")
  }
  const length = Number(row.LENGTH)
  if (length > 255) throw new Error("Function source line exceeds 255 characters")
  const count = Math.ceil(length / 60)
  if (Object.keys(row).length !== count + 1)
    throw new Error("Function source chunks are missing or contain unexpected properties")
  let source = ""
  for (let index = 1; index <= count; index++) {
    const part = row[`PART${index}`]
    const width = Math.min(60, length - source.length)
    if (part === undefined || part.length > width)
      throw new Error("Function source chunk is missing or exceeds its declared length")
    // CHAR payload transport trims trailing spaces; LENGTH restores exact chunk boundaries.
    source += part.padEnd(width, " ")
  }
  return source
}

function functionDefinitionFromResult(
  value: ReturnType<typeof functionModuleResult>
): FunctionModuleDefinition {
  return {
    remoteEnabled: value.remoteEnabled,
    importParameters: value.importParameters,
    exportParameters: value.exportParameters,
    changingParameters: value.changingParameters,
    tableParameters: value.tableParameters,
    exceptions: value.exceptions,
    source: value.source
  }
}

function serializeFunctionSnapshot(value: ReturnType<typeof functionModuleResult>): string[] {
  return [...value.snapshotPayload]
}

function patchFunctionModuleDefinition(
  current: FunctionModuleDefinition,
  parameterOperations: FunctionParameterPatch[],
  exceptionOperations: FunctionExceptionPatch[]
): FunctionModuleDefinition {
  const result: FunctionModuleDefinition = structuredClone(current)
  const rows = {
    import: result.importParameters,
    export: result.exportParameters,
    changing: result.changingParameters,
    table: result.tableParameters
  }
  for (const operation of parameterOperations) {
    const parameters = rows[operation.direction]
    const name = functionComponentName(operation.name, `${operation.direction} parameter`)
    const index = parameters.findIndex((parameter) => parameter.name === name)
    if (operation.operation === "add") {
      if (index >= 0) throw new Error(`Function parameter already exists: ${name}`)
      parameters.push(normalizedFunctionParameter(operation, operation.direction, name))
      continue
    }
    if (index < 0) throw new Error(`Function parameter does not exist: ${name}`)
    if (operation.operation === "remove") {
      parameters.splice(index, 1)
      continue
    }
    if (operation.operation === "rename") {
      parameters[index]!.name = functionComponentName(
        operation.newName,
        `${operation.direction} parameter newName`
      )
      continue
    }
    if (
      operation.typeName === undefined &&
      operation.optional === undefined &&
      operation.passByValue === undefined &&
      operation.description === undefined
    ) {
      throw new Error(`Function parameter update is empty: ${name}`)
    }
    const updated = {
      ...parameters[index]!,
      ...(operation.typeName === undefined
        ? {}
        : { typeName: ddicName(operation.typeName, `${operation.direction} parameter typeName`) }),
      ...(operation.optional === undefined ? {} : { optional: operation.optional }),
      ...(operation.passByValue === undefined ? {} : { passByValue: operation.passByValue }),
      ...(operation.description === undefined
        ? {}
        : {
            description: functionDescription(
              operation.description,
              `${operation.direction} parameter ${name}`
            )
          })
    }
    if (JSON.stringify(updated) === JSON.stringify(parameters[index])) {
      throw new Error(`Function parameter update is a no-op: ${name}`)
    }
    parameters[index] = updated
  }

  for (const operation of exceptionOperations) {
    const name = functionComponentName(operation.name, "exception")
    const index = result.exceptions.findIndex((exception) => exception.name === name)
    if (operation.operation === "add") {
      if (index >= 0) throw new Error(`Function exception already exists: ${name}`)
      result.exceptions.push({
        name,
        description: functionDescription(operation.description, `exception ${name}`)
      })
      continue
    }
    if (index < 0) throw new Error(`Function exception does not exist: ${name}`)
    if (operation.operation === "remove") {
      result.exceptions.splice(index, 1)
    } else if (operation.operation === "rename") {
      result.exceptions[index]!.name = functionComponentName(operation.newName, "exception newName")
    } else {
      const description = functionDescription(operation.description, `exception ${name}`)
      if (description === result.exceptions[index]!.description) {
        throw new Error(`Function exception update is a no-op: ${name}`)
      }
      result.exceptions[index]!.description = description
    }
  }

  validateFunctionDefinitionNames(result)
  if (result.tableParameters.some((value) => value.passByValue)) {
    throw new Error("table parameters cannot be passed by value")
  }
  if (JSON.stringify(result) === JSON.stringify(current)) {
    throw new Error("Function interface patch does not change the active definition")
  }
  return result
}

function normalizedFunctionParameter(
  input: FunctionParameterInput,
  direction: FunctionParameterDirection,
  name: string
): Required<FunctionParameterInput> {
  if (direction === "table" && input.passByValue) {
    throw new Error("table parameters cannot be passed by value")
  }
  return {
    name,
    typeName: ddicName(input.typeName, `${direction} parameter typeName`),
    optional: input.optional ?? false,
    passByValue: input.passByValue ?? false,
    description: functionDescription(input.description, `${direction} parameter ${name}`)
  }
}

function validateFunctionDefinitionNames(definition: FunctionModuleDefinition): void {
  const names = new Set<string>()
  for (const item of [
    ...definition.importParameters,
    ...definition.exportParameters,
    ...definition.changingParameters,
    ...definition.tableParameters,
    ...definition.exceptions
  ]) {
    if (names.has(item.name)) throw new Error(`Duplicate function interface name: ${item.name}`)
    names.add(item.name)
  }
}

function functionDescription(value: string | undefined, field: string): string {
  const description = value ?? ""
  validateTextLength(description, 60, `${field} description`)
  return description
}

function functionModuleWorkspaceUri(
  connectionId: string,
  functionGroup: string,
  functionName: string
): string {
  return (
    `adt://${connectionId}/sap/bc/adt/functions/groups/${functionGroup.toLowerCase()}` +
    `/fmodules/${functionName.toLowerCase()}`
  )
}

function functionInterfaceSourcePatch(
  functionName: string,
  definition: FunctionModuleDefinition,
  source: string
): { oldHeader: string; newHeader: string } {
  const lines = source.replaceAll("\r\n", "\n").split("\n")
  if (!new RegExp(`^FUNCTION\\s+${functionName}\\b`, "i").test(lines[0] ?? "")) {
    throw new Error(`Active ADT source does not start with FUNCTION ${functionName}`)
  }
  const end = lines.findIndex((line) => line.trimEnd().endsWith("."))
  if (end < 0) throw new Error("Active ADT function interface has no terminating period")
  return {
    oldHeader: lines.slice(0, end + 1).join("\n"),
    newHeader: renderFunctionInterfaceSource(functionName, definition)
  }
}

function renderFunctionInterfaceSource(
  functionName: string,
  definition: FunctionModuleDefinition
): string {
  const lines = [`FUNCTION ${functionName}`]
  const sections: Array<{ name: string; entries: string[] }> = [
    {
      name: "IMPORTING",
      entries: definition.importParameters.map((parameter) =>
        renderFunctionParameter(parameter, "TYPE")
      )
    },
    {
      name: "EXPORTING",
      entries: definition.exportParameters.map((parameter) =>
        renderFunctionParameter(parameter, "TYPE")
      )
    },
    {
      name: "CHANGING",
      entries: definition.changingParameters.map((parameter) =>
        renderFunctionParameter(parameter, "TYPE")
      )
    },
    {
      name: "TABLES",
      entries: definition.tableParameters.map((parameter) =>
        renderFunctionParameter(parameter, "LIKE")
      )
    },
    {
      name: "EXCEPTIONS",
      entries: definition.exceptions.map((exception) => exception.name)
    }
  ].filter((section) => section.entries.length)
  if (!sections.length) return `${lines[0]}.`
  sections.forEach((section) => {
    lines.push(`  ${section.name}`)
    lines.push(...section.entries.map((entry) => `    ${entry}`))
  })
  lines[lines.length - 1] += "."
  return lines.join("\n")
}

function renderFunctionParameter(
  parameter: Required<FunctionParameterInput>,
  typing: "TYPE" | "LIKE"
): string {
  const name = parameter.passByValue ? `VALUE(${parameter.name})` : parameter.name
  return `${name} ${typing} ${parameter.typeName}${parameter.optional ? " OPTIONAL" : ""}`
}

function functionImplementationSource(source: string[]): string[] {
  const separators = source
    .map((line, index) => (/^\*"-+$/.test(line.trim()) ? index : -1))
    .filter((index) => index >= 0)
  let start = separators.length >= 2 ? separators[1]! + 1 : 0
  if (!separators.length && /^FUNCTION\b/i.test(source[0] ?? "")) {
    const interfaceEnd = source.findIndex((line) => line.trimEnd().endsWith("."))
    start = interfaceEnd >= 0 ? interfaceEnd + 1 : 1
  }
  let end = source.length
  for (let index = source.length - 1; index >= start; index -= 1) {
    if (/^ENDFUNCTION\./i.test(source[index]!.trim())) {
      end = index
      break
    }
  }
  const body = source.slice(start, end >= start ? end : source.length)
  while (body[0]?.trim() === "") body.shift()
  while (body.at(-1)?.trim() === "") body.pop()
  return body
}

function decodeSoapText(value: string): string {
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

function functionComponentName(value: string, field: string): string {
  const normalized = value.trim().toUpperCase()
  if (!/^[A-Z][A-Z0-9_]{0,29}$/.test(normalized)) {
    throw new Error(`${field} name must contain 1-30 letters, digits, or underscores`)
  }
  return normalized
}

function invocationRequestId(value: string): string {
  const normalized = value.trim()
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(normalized)) {
    throw new Error(
      "requestId must contain 1-64 letters, digits, dots, underscores, colons, or hyphens"
    )
  }
  return normalized
}

function remotePayloadHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableRemoteValue(value)))
    .digest("hex")
}

function stableRemoteValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableRemoteValue)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableRemoteValue(child)])
  )
}

function boundedScalarParameters(
  values: Record<string, string>,
  field: string
): Record<string, string> {
  const entries = Object.entries(values)
  if (entries.length > 50) throw new Error(`${field} must not contain more than 50 parameters`)
  const result: Record<string, string> = {}
  let totalLength = 0
  for (const [rawName, value] of entries) {
    const name = functionComponentName(rawName, field)
    if (name in result) throw new Error(`Duplicate ${field} parameter: ${name}`)
    if (value.length > 4096) throw new Error(`${field}.${name} exceeds 4096 characters`)
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
      throw new Error(`${field}.${name} contains characters unsupported by XML 1.0`)
    }
    totalLength += value.length
    if (totalLength > 65_536) throw new Error(`${field} exceeds 65536 total characters`)
    result[name] = value
  }
  return result
}

function boundedStructureParameters(
  values: StructureParameters,
  field: string
): StructureParameters {
  const entries = Object.entries(values)
  if (entries.length > 50) throw new Error(`${field} must not contain more than 50 parameters`)
  const result: StructureParameters = {}
  for (const [rawName, value] of entries) {
    const name = functionComponentName(rawName, field)
    if (name in result) throw new Error(`Duplicate ${field} parameter: ${name}`)
    result[name] = boundedRemoteRecord(value, `${field}.${name}`)
  }
  return result
}

function boundedTableParameters(values: TableParameters, field: string): TableParameters {
  const entries = Object.entries(values)
  if (entries.length > 50) throw new Error(`${field} must not contain more than 50 parameters`)
  const result: TableParameters = {}
  for (const [rawName, rows] of entries) {
    const name = functionComponentName(rawName, field)
    if (name in result) throw new Error(`Duplicate ${field} parameter: ${name}`)
    if (rows.length > 200) throw new Error(`${field}.${name} exceeds 200 rows`)
    result[name] = rows.map((row, index) => boundedRemoteRecord(row, `${field}.${name}[${index}]`))
  }
  return result
}

const MAX_REMOTE_RECORD_FIELDS = 500

function boundedRemoteRecord(value: Record<string, string>, field: string): Record<string, string> {
  const entries = Object.entries(value)
  if (entries.length > MAX_REMOTE_RECORD_FIELDS) {
    throw new Error(`${field} must not contain more than ${MAX_REMOTE_RECORD_FIELDS} fields`)
  }
  return Object.fromEntries(
    entries.map(([name, text]) => {
      const normalized = functionComponentName(name, field)
      if (text.length > 4096) throw new Error(`${field}.${normalized} exceeds 4096 characters`)
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
        throw new Error(`${field}.${normalized} contains characters unsupported by XML 1.0`)
      }
      return [normalized, text]
    })
  )
}

function assertRemotePayloadSize(value: unknown, field: string): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 1024 * 1024) {
    throw new Error(`${field} exceeds 1 MiB`)
  }
}

function parameterKinds(
  scalars: Record<string, string>,
  structures: StructureParameters,
  tables: TableParameters
): Map<string, RemoteFunctionParameterShape["kind"]> {
  const result = new Map<string, RemoteFunctionParameterShape["kind"]>()
  const append = (names: string[], kind: RemoteFunctionParameterShape["kind"]) => {
    for (const name of names) {
      if (result.has(name)) throw new Error(`Parameter ${name} was supplied more than once`)
      result.set(name, kind)
    }
  }
  append(Object.keys(scalars), "scalar")
  append(Object.keys(structures), "structure")
  append(Object.keys(tables), "table")
  return result
}

function remoteParameterShape(parameter: FunctionExecutionParameter): RemoteFunctionParameterShape {
  return {
    name: parameter.name,
    kind: parameter.kind,
    ...(parameter.fields ? { fields: parameter.fields } : {})
  }
}

function validateRemoteFields(
  parameter: FunctionExecutionParameter,
  value: RemoteFunctionValue,
  field: string,
  output = false
): void {
  if (parameter.kind === "scalar") {
    if (typeof value !== "string") throw new Error(`${field} is not scalar`)
    if (parameter.valueContract)
      validateRfcValue(parameter.valueContract, value, parameter.name, output)
    return
  }
  const rows = Array.isArray(value) ? value : typeof value === "string" ? undefined : [value]
  if (!rows || (parameter.kind === "structure" && Array.isArray(value))) {
    throw new Error(`${field} does not match ${parameter.kind} parameter ${parameter.name}`)
  }
  const allowed = new Set(parameter.fields ?? [])
  for (const row of rows) {
    for (const name of Object.keys(row)) {
      if (!allowed.has(name)) throw new Error(`Unknown field ${parameter.name}.${name}`)
      const contract = parameter.fieldContracts?.[name]
      if (contract) validateRfcValue(contract, row[name]!, `${parameter.name}.${name}`, output)
    }
  }
}

function splitRemoteOutputs(
  outputs: Record<string, RemoteFunctionValue>,
  shapes: RemoteFunctionParameterShape[]
): {
  scalars: Record<string, string>
  structures: StructureParameters
  tables: TableParameters
} {
  const scalars: Record<string, string> = {}
  const structures: StructureParameters = {}
  const tables: TableParameters = {}
  for (const shape of shapes) {
    const value = outputs[shape.name]
    if (shape.kind === "scalar") {
      if (typeof value !== "string") throw new Error(`Output ${shape.name} is not scalar`)
      scalars[shape.name] = value
    } else if (shape.kind === "structure") {
      if (!value || typeof value === "string" || Array.isArray(value)) {
        throw new Error(`Output ${shape.name} is not a structure`)
      }
      structures[shape.name] = value
    } else {
      if (!Array.isArray(value)) throw new Error(`Output ${shape.name} is not a table`)
      tables[shape.name] = value
    }
  }
  return {
    scalars: boundedScalarParameters(scalars, "outputs"),
    structures: boundedStructureParameters(structures, "structureOutputs"),
    tables: boundedTableParameters(tables, "tableOutputs")
  }
}

function assertExpectedRemoteOutputs<T extends Record<string, unknown>>(
  actual: T,
  expected: T
): void {
  for (const [name, value] of Object.entries(expected)) {
    if (!isDeepStrictEqual(actual[name], value)) {
      throw new Error(
        `Output assertion failed for ${name}: expected ${JSON.stringify(value)}, received ${JSON.stringify(actual[name])}`
      )
    }
  }
}

function flatStructureFields(result: SapDdicResult, typeName: string): string[] {
  if (!result.fields.length) throw new Error(`Structure ${typeName} has no fields`)
  if (result.fields.length > MAX_REMOTE_RECORD_FIELDS) {
    throw new Error(`Structure ${typeName} exceeds ${MAX_REMOTE_RECORD_FIELDS} fields`)
  }
  const names = new Set<string>()
  return result.fields.map((field) => {
    const name = functionComponentName(field.FIELDNAME ?? "", `structure ${typeName} field`)
    if (names.has(name)) throw new Error(`Structure ${typeName} contains duplicate field ${name}`)
    names.add(name)
    const componentType = field.COMPTYPE?.trim()
    if (componentType && componentType !== "E") {
      throw new Error(`Structure ${typeName} field ${name} is not elementary`)
    }
    if (!field.ROLLNAME && !supportedDirectField(field)) {
      throw new Error(`Structure ${typeName} field ${name} is deep or has no data element`)
    }
    return name
  })
}

function remoteScalarShape(header: Record<string, string>, typeName: string): ResolvedRemoteType {
  const valueContract = rfcValueContract(header, typeName)
  if (["CHAR", "NUMC"].includes(header.DATATYPE?.trim().toUpperCase() ?? "")) {
    const length = Number(header.LENG)
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw new Error(`DDIC character length is invalid for ${typeName}`)
    }
    return { kind: "scalar", fields: [], maxCharacters: length, valueContract }
  }
  return { kind: "scalar", fields: [], valueContract }
}

function supportedDirectField(field: Record<string, string>): boolean {
  const length = Number(field.LENG)
  if (!Number.isSafeInteger(length) || length <= 0) return false
  switch (field.DATATYPE?.trim()) {
    case "DATS":
      return length === 8
    case "TIMS":
      return length === 6
    case "CHAR":
    case "NUMC":
      return length <= 1333
    case "INT1":
      return length === 3
    case "INT2":
      return length === 5
    case "INT4":
      return length === 10
    default:
      return false
  }
}

function requireDdicNotFound(result: SapDdicResult, objectName: string): void {
  if (!/NOT_FOUND|DOES_NOT_EXIST/i.test(`${result.code} ${result.message}`)) {
    throw new Error(
      `SAP DDIC type inspection failed for ${objectName}: ${result.code}: ${result.message}`
    )
  }
}

function readableFunctionName(value: string): string {
  const normalized = readableObjectName(value)
  if (normalized.length > 30) throw new Error("functionName must not exceed 30 characters")
  return normalized
}

function repositoryPayload(lines: string[]): {
  metadata: Record<string, string>
  fields: Array<Record<string, string>>
  textRows: Array<Record<string, string>>
} {
  const metadata: Record<string, string> = {}
  const fields: Array<Record<string, string>> = []
  const textRows: Array<Record<string, string>> = []
  for (const line of lines) {
    const match = line.match(/^([MFT])\|(\d+)\|([A-Z0-9_]+)\|(.*)$/)
    if (!match?.[1] || !match[2] || !match[3]) {
      throw new Error(`SAP repository helper returned an invalid payload line: ${line}`)
    }
    const index = Number.parseInt(match[2], 10)
    if (index < 1)
      throw new Error(`SAP repository helper returned an invalid payload index: ${line}`)
    const value = (match[4] ?? "").replaceAll("%7C", "|").replaceAll("%25", "%")
    const target =
      match[1] === "M" ? metadata : rowAtRepository(match[1] === "F" ? fields : textRows, index)
    target[match[3]] = value
  }
  return { metadata, fields, textRows }
}

function rowAtRepository(
  rows: Array<Record<string, string>>,
  index: number
): Record<string, string> {
  while (rows.length < index) rows.push({})
  return rows[index - 1]!
}

function messageClassResult(result: MessageClassInfo) {
  const definition = {
    description: result.description,
    masterLanguage: result.masterLanguage,
    messages: result.messages
  }
  return {
    connectionId: result.connectionId,
    objectKind: "messageClass" as const,
    messageClass: result.messageClass,
    packageName: result.packageName,
    version: result.version,
    fingerprint: createHash("sha256").update(JSON.stringify(definition)).digest("hex"),
    definition
  }
}

function readableMessageClass(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (
    !normalized ||
    normalized.length > 20 ||
    !/^(?:\/[A-Z0-9_]+\/)?[A-Z0-9_]+$/.test(normalized)
  ) {
    throw new Error("messageClass is not a valid SAP message class")
  }
  return normalized
}

function customerMessageClass(value: string): string {
  const normalized = readableMessageClass(value)
  if (!/^[ZY]/.test(normalized))
    throw new Error("messageClass must name a Z* or Y* customer object")
  return normalized
}

function isMessageClassNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /MESSAGE_CLASS_(?:NOT_FOUND|READ_FAILED)|message class (?:does not exist|was not found)/i.test(
    message
  )
}

function messageClassMessages(
  messages: Array<{ number: string; text: string }>
): Array<{ number: string; text: string }> {
  const numbers = new Set<string>()
  return messages.map((message) => {
    if (!/^\d{3}$/.test(message.number)) throw new Error("Message number must contain 3 digits")
    if (numbers.has(message.number)) throw new Error(`Duplicate message number: ${message.number}`)
    numbers.add(message.number)
    if (!message.text || message.text.length > 73) {
      throw new Error(`Message ${message.number} must contain 1-73 characters`)
    }
    return { number: message.number, text: message.text }
  })
}

function applyMessageClassOperations(
  current: Array<{ number: string; text: string }>,
  operations: Array<{
    operation: "add" | "update" | "remove"
    number: string
    text?: string | undefined
  }>
): Array<{ number: string; text: string }> {
  const messages = new Map(current.map((message) => [message.number, message.text]))
  const touched = new Set<string>()
  for (const operation of operations) {
    const number = operation.number.trim()
    if (!/^\d{3}$/.test(number)) throw new Error("Message number must contain 3 digits")
    if (touched.has(number)) throw new Error(`Duplicate message operation: ${number}`)
    touched.add(number)
    const exists = messages.has(number)
    if (operation.operation === "add" && exists) {
      throw new Error(`MESSAGE_ALREADY_EXISTS: ${number}`)
    }
    if (operation.operation !== "add" && !exists) {
      throw new Error(`MESSAGE_NOT_FOUND: ${number}`)
    }
    if (operation.operation === "remove") {
      if (operation.text !== undefined)
        throw new Error(`remove must not provide text for ${number}`)
      messages.delete(number)
      continue
    }
    if (!operation.text || operation.text.length > 73) {
      throw new Error(`Message ${number} must contain 1-73 characters`)
    }
    messages.set(number, operation.text)
  }
  if (messages.size === 0) {
    throw new Error("MESSAGE_CLASS_EMPTY: At least one message must remain")
  }
  return [...messages]
    .map(([number, text]) => ({ number, text }))
    .sort((a, b) => a.number.localeCompare(b.number))
}

function validateProgramTextElements(
  elements: TextElementInfo[]
): Array<Required<TextElementInfo>> {
  const ids = new Set<string>()
  return elements.map((element) => {
    const id = element.id.trim().toUpperCase()
    if (!/^[A-Z0-9_]{3}$/.test(id)) {
      throw new Error(`Text symbol ID ${element.id} must contain exactly 3 characters`)
    }
    if (ids.has(id)) throw new Error(`Duplicate text element ID: ${id}`)
    ids.add(id)
    if (!element.text || element.text.length > 255) {
      throw new Error(`Text element ${id} must contain 1-255 characters`)
    }
    const maxLength = element.maxLength ?? Math.max(10, element.text.length)
    if (maxLength < element.text.length || maxLength > 255) {
      throw new Error(`Invalid maxLength for ${id}: expected ${element.text.length}-255`)
    }
    return { id, text: element.text, maxLength }
  })
}

function reportVariant(value: string | undefined): string {
  if (!value) return ""
  const normalized = value.trim().toUpperCase()
  if (!/^[A-Z0-9_/$]{1,14}$/.test(normalized)) {
    throw new Error("variant must contain 1-14 valid SAP name characters")
  }
  return normalized
}

function readableObjectName(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (
    !normalized ||
    normalized.length > 40 ||
    !/^(?:\/[A-Z0-9_]+\/)?[A-Z0-9_]+$/.test(normalized)
  ) {
    throw new Error("objectName is not a valid ABAP object name")
  }
  return normalized
}

function customerName(value: string, field: string): string {
  const normalized = value.trim().toUpperCase()
  if (!/^[ZY][A-Z0-9_/$]{0,39}$/.test(normalized)) {
    throw new Error(`${field} must name a Z* or Y* customer object`)
  }
  return normalized
}

function deletedSourceObjectName(
  objectType: DeleteSourceObjectInput["objectType"],
  value: string,
  parentName: string
): string {
  if (objectType !== "FUGR/I") return customerName(value, "objectName")
  const normalized = readableObjectName(value)
  const fullName = /^[A-Z][A-Z0-9_]{2}$/.test(normalized)
    ? `L${parentName}${normalized}`
    : normalized
  if (!fullName.startsWith(`L${parentName}`)) {
    throw new Error(`PARENT_CONFLICT: Include is not owned by ${parentName}`)
  }
  return fullName
}

function deletedSourceTypeMatches(
  requested: DeleteSourceObjectInput["objectType"],
  actual: string
): boolean {
  const normalized = actual.toUpperCase()
  if (requested === "FUGR/FF") {
    return normalized === "FUGR/FF" || normalized === "FUNC/FM" || normalized === "FUNC"
  }
  if (requested === "FUGR/I") {
    return normalized === "FUGR/I" || normalized === "PROG/I" || normalized === "PROG"
  }
  return normalized === requested
}

function functionGroupChildOwnedBy(uri: string, parentName: string): boolean {
  const match = /\/functions\/groups\/([^/]+)\/(?:fmodules|includes)\//i.exec(uri)
  return !!match?.[1] && decodeURIComponent(match[1]).toUpperCase() === parentName
}

function dynproNumber(value: string): string {
  if (!/^\d{1,4}$/.test(value.trim())) throw new Error("screenNumber must contain 1-4 digits")
  return value.trim().padStart(4, "0")
}

function packageName(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (!normalized || normalized === "$TMP") {
    throw new Error("A transportable package is required for Dynpro application objects")
  }
  return normalized
}

function transportNumber(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (!/^[A-Z0-9]{10}$/.test(normalized)) {
    throw new Error("transportNumber must be an existing 10-character SAP request or task")
  }
  return normalized
}

function uppercaseRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key.toUpperCase(), value])
  )
}

function requireRepositorySuccess(status: string, code: string, message: string): void {
  if (status.toUpperCase() !== "S") {
    throw new Error(`SAP repository helper rejected the operation: ${code}: ${message}`)
  }
}
