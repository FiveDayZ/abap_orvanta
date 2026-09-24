import { resolve } from "node:path"
import { CUSTOMER_CONNECTION_ID } from "./customer-scope.js"
import { QUALITY_GATE_NOT_EVALUATED, QUALITY_GATE_REASON_NOT_RUN } from "./quality-gate.js"
import {
  cleanupTransportEntrySchema,
  prepareTransportDelivery,
  deliveryObjectSchema,
  inactiveTargetSchema,
  transportEntries,
  transportFingerprint
} from "./transport-delivery.js"
import {
  previewConfiguration,
  CONFIGURATION_TABLE,
  CONFIGURATION_MODE_DOMAIN
} from "./configuration-preview.js"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { VersionHistoryUnavailableError, structureUriFor } from "./adt-backend.js"
import type { TransportRequest } from "abap-adt-api"
import type {
  ActivationMessageInfo,
  AbapObjectInfo,
  AtcFindingInfo,
  CreateObjectRequest,
  DumpInfo,
  EnhancementInfo,
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
import {
  parseSimpleTableSelect,
  readAbapTable,
  selectedTableNames,
  tableQuerySchema
} from "./table-query.js"
import { assertTableAllowed, TABLE_ALLOWLIST_UNVERIFIABLE } from "./table-allowlist.js"
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

/**
 * D7-1: one SAPscript form read through the shared repository body.
 *
 * `version` is deliberately absent. The body answers a non-empty version with
 * `FORM_VERSION_UNSUPPORTED` because the single-version branch is not implemented, and a strict
 * schema that advertises an input the helper refuses would be a contract the tool cannot honour.
 */
interface ReadSapscriptFormInput {
  formName: string
  language?: string | undefined
  status?: string | undefined
  includeSource?: boolean | undefined
  connectionId: string
}

type SapscriptFormRow = Record<string, string>

interface SapscriptFormDefinition {
  connectionId: string
  objectName: string
  formStatus: string
  language: string
  tdname: string
  includeSource: boolean
  header: SapscriptFormRow
  textHeader: SapscriptFormRow
  formLines: SapscriptFormRow[]
  pages: SapscriptFormRow[]
  pageWindows: SapscriptFormRow[]
  windows: SapscriptFormRow[]
  paragraphs: SapscriptFormRow[]
  strings: SapscriptFormRow[]
  tabs: SapscriptFormRow[]
  source?: SapscriptFormRow[] | undefined
  counts: Record<string, number>
  returnedCount: number
  truncated: boolean
  fingerprint: string
}

interface ReadSmartstyleInput {
  styleName: string
  mode?: string | undefined
  active?: string | undefined
  variant?: string | undefined
  language?: string | undefined
  includeCss?: boolean | undefined
  connectionId: string
}

type SmartstyleRow = Record<string, string>

/**
 * `cssStatus` alone cannot distinguish "the caller did not ask for CSS" from "the conversion was
 * requested and failed", and conflating the two would report a gap as an absence.
 */
interface SmartstyleCss {
  mime: string
  body: string
  declaredLength: number | null
  lengthMatches: boolean
}

interface SmartstyleDefinition {
  connectionId: string
  objectName: string
  mode: string
  active: string
  variant: string
  language: string
  cssStatus: string
  header: SmartstyleRow
  paragraphs: SmartstyleRow[]
  strings: SmartstyleRow[]
  tabStops: SmartstyleRow[]
  variants: SmartstyleRow[]
  css?: SmartstyleCss | undefined
  counts: Record<string, number>
  returnedCount: number
  truncated: boolean
  fingerprint: string
}

interface ReadAdobeFormInput {
  formName: string
  language?: string | undefined
  connectionId: string
}

/**
 * The XDP travels as base64 because the payload channel carries characters only. `xdpLength` is the
 * byte length the helper found, which can exceed `xdpBytesReturned` when a very large layout was
 * capped; in that case the body is a prefix and `xdpSha256` is withheld rather than published for a
 * partial document.
 *
 * `interfaceAvailable` and `unsupported` are stated by the decoder, not read from the helper: the
 * Adobe interface and context read paths are not implemented, and an empty object would report a
 * gap as an absence.
 */
interface AdobeFormDefinition {
  connectionId: string
  objectName: string
  language: string
  masterLanguage: string
  state: string
  dirty: boolean
  id: string
  interfaceAvailable: false
  unsupported: string[]
  xdp: string
  xdpLength: number
  xdpBytesReturned: number
  truncated: boolean
  xdpSha256?: string | undefined
  fingerprint: string
}

interface CreateTransportRequestInput {
  connectionId: string
  requestType: string
  description: string
  owner?: string | undefined
  target?: string | undefined
  allowDuplicate?: boolean | undefined
  confirmation: string
}

/**
 * `created` separates "SAP created this request now" from "the retry guard matched an existing
 * request", because both are successful outcomes and reporting them identically would hide whether
 * anything was written. `matchedBy` names the fields the match used, so the caller can see that the
 * guard is a heuristic on owner, type, status and description rather than an external unique key.
 */
interface TransportRequestCreation {
  connectionId: string
  created: boolean
  requestNumber: string
  requestType: string
  status: string
  owner: string
  target: string
  description: string
  taskNumbers: string[]
  matchedBy?: string | undefined
}

interface AddObjectsToTransportInput {
  connectionId: string
  requestNumber: string
  objects: TransportObjectEntry[]
  confirmation: string
}

interface TransportObjectEntry {
  pgmid: string
  object: string
  objName: string
  language?: string | undefined
}

/**
 * `requestNumber` and `taskNumber` are SAP's own `ev_order`/`ev_task`, not an echo of the input: the
 * callee decides which task actually carries the entries, and the caller needs that key to read the
 * result back. `insertedCount` is counted from E071 after the commit, so a reported success always
 * has a persisted object entry behind it.
 */
interface TransportObjectAddition {
  connectionId: string
  requestNumber: string
  taskNumber: string
  objectCount: number
  insertedCount: number
  objects: TransportObjectEntry[]
  /**
   * The container the caller asked for, next to the one SAP actually recorded into.
   *
   * `TRINT_OBJECTS_CHECK_AND_INSERT` refuses to record an object that already belongs to another
   * open transport and reports the order and task it used instead, so the two can differ while the
   * call still succeeds. Reporting only the callee's numbers made that look like the requested
   * container had been used.
   */
  requestedRequestNumber: string
  recordedInRequestedContainer: boolean
  containerMismatch: {
    requested: string
    recordedIn: string
    task: string
    reason: string
  } | null
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

interface WriteFunctionModuleSourceInput extends ReadFunctionModuleInput {
  functionGroup: string
  expectedSourceFingerprint: string
  source: string[]
  packageName: string
  transportNumber: string
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

/**
 * Field-level append structure write. The append structure already exists, so there is no package or
 * transport argument: its TADIR entry and transport recording already exist. expectedVersion is
 * mandatory because an append structure always exists and must be updated against a known revision.
 */
interface UpsertAppendStructureFieldsInput {
  objectName: string
  fields: Array<{ name: string; dataElement: string }>
  expectedVersion: string
  connectionId: string
}

interface UpsertSearchHelpInput extends UpsertDdicInput {
  header?: Record<string, string> | undefined
  selectionMethods?: Array<Record<string, string>> | undefined
  parameters?: Array<Record<string, string>> | undefined
  fieldAssignments?: Array<Record<string, string>> | undefined
}

interface UpsertLockObjectInput extends UpsertDdicInput {
  header?: Record<string, string> | undefined
  lockTables?: Array<Record<string, string>> | undefined
  lockFields?: Array<Record<string, string>> | undefined
}

interface UpsertNumberRangeObjectInput extends UpsertDdicInput {
  /**
   * TNRO attribute values keyed by TNRO field name. Omitted fields keep the value already stored, so
   * an update is a partial patch and a create starts from an empty TNRO row.
   */
  properties?: Record<string, string> | undefined
  /** TNROT text rows. The helper logon language must be one of them, because SAP writes the first. */
  texts?: Array<{ language: string; text: string; shortText?: string | undefined }> | undefined
}

interface MaintenanceViewHeaderInput {
  /** DD25V-ROOTTAB. Defaults to the first base table, which is what the activation consumes. */
  rootTable?: string | undefined
  /** DD25V-VIEWGRANT: R, U or M. U/M only apply to a maintenance view. */
  viewGrant?: string | undefined
  /** DD25V-CUSTOMAUTH: one of A, C, L, G, E, S, W. */
  customAuth?: string | undefined
  /** DD25V-GLOBALFLAG: N or X. */
  globalFlag?: string | undefined
}

interface MaintenanceViewBaseTableInput {
  tableName: string
  /** DD26V-FORTABNAME: the table this one is joined to (omit for a single-table view). */
  foreignTable?: string | undefined
  /** DD26V-FORFIELD: the field of the join partner. */
  foreignField?: string | undefined
  /**
   * DD26V-FORDIR: the join direction. The legal value set of the FORDIR data element was not
   * established from this system's source, so the value is passed through to SAP's own activation
   * check instead of being restricted here; a rejected join rolls the whole operation back.
   */
  foreignDirection?: string | undefined
}

interface MaintenanceViewFieldInput {
  tableName: string
  fieldName: string
  /** DD27P-VIEWFIELD: the alias shown in the view. Defaults to the base field name. */
  viewField?: string | undefined
}

interface UpsertMaintenanceViewInput extends UpsertDdicInput {
  /** DD25V-DDTEXT. */
  baseTables: MaintenanceViewBaseTableInput[]
  viewFields: MaintenanceViewFieldInput[]
  header?: MaintenanceViewHeaderInput | undefined
}

/**
 * DD03P-REFTABLE/REFFIELD. A quantity or currency field names the table and field that carry its
 * unit, and DDIC activation refuses such a field without them; both halves travel together.
 */
interface DdicTableFieldReference {
  referenceTable?: string | undefined
  referenceField?: string | undefined
}

/** A table field row as the DDIC helper consumes it: payload keys plus the optional reference pair. */
type TransparentTableFieldRow = {
  FIELDNAME: string
  ROLLNAME: string
  KEYFLAG: string
  NOTNULL: string
  REFTABLE?: string
  REFFIELD?: string
}

interface CreateTransparentTableInput extends Omit<UpsertDdicInput, "expectedVersion"> {
  deliveryClass: "A" | "C" | "L" | "G" | "E" | "S" | "W"
  dataClass: "APPL0" | "APPL1" | "APPL2"
  dataBrowserMaintenance: "allowed" | "restricted" | "notAllowed"
  sizeCategory?: number | undefined
  fields: Array<
    {
      name: string
      dataElement: string
      key?: boolean | undefined
    } & DdicTableFieldReference
  >
}

interface AppendTransparentTableFieldsInput extends ReadDdicInput {
  expectedVersion: string
  expectedFingerprint: string
  fields: Array<{ name: string; dataElement: string } & DdicTableFieldReference>
  packageName: string
  transportNumber: string
}

type TransparentTableFieldChange =
  | { action: "remove"; fieldName: string }
  | { action: "rename"; fieldName: string; newName: string }
  | ({
      action: "update"
      fieldName: string
      dataElement?: string | undefined
      key?: boolean | undefined
      notNull?: boolean | undefined
    } & DdicTableFieldReference)

interface PatchTransparentTableFieldsInput extends ReadDdicInput {
  expectedVersion: string
  expectedFingerprint: string
  changes: TransparentTableFieldChange[]
  packageName: string
  transportNumber: string
  confirmation: "DESTRUCTIVE_SCHEMA_CHANGE"
  acknowledgeDataLoss: true
}

type TransparentTableBuffering =
  | "notAllowed"
  | "allowedButOff"
  | "singleRecord"
  | "generic"
  | "full"

interface PatchTransparentTableSettingsInput extends ReadDdicInput {
  expectedVersion: string
  expectedFingerprint: string
  settings: {
    dataClass?: "APPL0" | "APPL1" | "APPL2" | undefined
    sizeCategory?: number | undefined
    buffering?: TransparentTableBuffering | undefined
    genericKeyFields?: number | undefined
    logDataChanges?: boolean | undefined
  }
  packageName: string
  transportNumber: string
  confirmation: "TECHNICAL_SETTINGS_CHANGE"
}

interface RecoverDdicTableConversionInput extends ReadDdicInput {
  expectedWorklistFingerprint: string
  packageName: string
  transportNumber: string
  confirmation: "RECOVER_NATIVE_TABLE_CONVERSION"
  acknowledgePotentialDataLoss: true
}

interface ResumeDdicTableActivationInput extends ReadDdicInput {
  expectedInactiveFingerprint: string
  packageName: string
  transportNumber: string
  confirmation: "RESUME_INACTIVE_ACTIVATION"
  settingsRepair?:
    | (PatchTransparentTableSettingsInput["settings"] & {
        acknowledgeTechnicalSettingsChange: true
      })
    | undefined
}

interface UpsertTableTypeInput extends UpsertDdicInput {
  rowType: string
}

interface DeleteDdicInput extends ReadDdicInput {
  objectType: "DOMA" | "DTEL" | "STRU" | "TTYP" | "TABL" | "SHLP" | "ENQU" | "NROB" | "VIEW"
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

interface EnhancementInspectionInput extends ObjectInput {
  includeImplementationSource?: boolean | undefined
}

type EnhancementObjectType = "ENHC" | "ENHS" | "ENHO" | "BADI" | "BADII"

interface EnhancementObjectSearchInput {
  pattern: string
  types?: EnhancementObjectType[] | undefined
  maxResultsPerType?: number | undefined
  connectionId: string
}

type CustomerExitObjectType = "SMOD" | "CMOD"

interface CustomerExitObjectSearchInput {
  pattern: string
  types?: CustomerExitObjectType[] | undefined
  maxResultsPerType?: number | undefined
  connectionId: string
}

interface ReadCustomerExitDefinitionInput {
  enhancementName: string
  connectionId: string
}

interface ReadCustomerExitProjectInput {
  projectName: string
  connectionId: string
}

interface CustomerFunctionExitInspectionInput {
  programName: string
  connectionId: string
}

interface CustomerScreenMenuExitInspectionInput {
  programName: string
  screenNumbers?: string[] | undefined
  includeMenuExits?: boolean | undefined
  connectionId: string
}

type BteKind = "event" | "process"

interface BteDispatcherSearchInput {
  eventPattern?: string | undefined
  kinds?: BteKind[] | undefined
  maxResultsPerKind?: number | undefined
  connectionId: string
}

interface ReadBteConfigurationInput {
  kind: BteKind
  identifier: string
  connectionId: string
}

type EnhancementConfigurationWorkflowKind =
  | "cmod_project"
  | "fibf_event"
  | "fibf_process"
  | "fi_validation"
  | "fi_substitution"

interface EnhancementConfigurationWorkflowInput {
  kind: EnhancementConfigurationWorkflowKind
  targetName: string
  desiredState: "create_or_update" | "active" | "inactive" | "removed"
  enhancementNames?: string[] | undefined
  productName?: string | undefined
  functionModule?: string | undefined
  applicationIndicator?: string | undefined
  country?: string | undefined
  applicationArea?: string | undefined
  callupPoint?: string | undefined
  organizationalUnit?: string | undefined
  exitProgram?: string | undefined
  packageName?: string | undefined
  transportNumber?: string | undefined
  connectionId: string
}

type BadiRepositoryType = "SXSD/XD" | "SXCI/XI" | "ENHS/XS" | "ENHO/XHB"

interface BadiObjectSearchInput {
  pattern: string
  types?: BadiRepositoryType[] | undefined
  maxResultsPerType?: number | undefined
  connectionId: string
}

interface ReadClassicBadiDefinitionInput {
  definitionName: string
  connectionId: string
}

type TableQueryInput = z.infer<typeof tableQuerySchema>

interface ClassicBadiProjectionRow {
  EXIT_NAME: string
  IMP_NAME: string
  CLASS_NAME: string
  INTER_NAME: string
}

const classicBadiProjectionColumns = ["EXIT_NAME", "IMP_NAME", "CLASS_NAME", "INTER_NAME"] as const

interface ClassicBadiMethodInput {
  methodName: string
  source: string[]
}

interface ManageClassicBadiImplementationInput {
  action: "create" | "activate" | "deactivate" | "delete"
  implementationName: string
  definitionName: string
  interfaceName?: string | undefined
  implementationClass?: string | undefined
  methods?: ClassicBadiMethodInput[] | undefined
  filters?: Array<Record<string, string>> | undefined
  packageName: string
  transportNumber: string
  expectedFingerprint?: string | undefined
  confirmation: "CLASSIC_BADI_IMPLEMENTATION_CHANGE"
  connectionId: string
}

interface ReadEnhancementImplementationInput {
  enhancementName: string
  connectionId: string
}

interface CreateEnhancementHookInput extends ReadEnhancementImplementationInput {
  description: string
  originalObjectType: "PROG" | "CLAS" | "FUGR"
  originalObjectName: string
  mainObjectType: "PROG" | "CLAS" | "FUGR"
  mainObjectName: string
  programName: string
  fullName: string
  mode: "D" | "S"
  replacement?: boolean | undefined
  source: string[]
  packageName: string
  transportNumber: string
  confirmation: "CREATE_ENHANCEMENT_IMPLEMENTATION"
}

interface CreateNewBadiImplementationInput extends ReadEnhancementImplementationInput {
  description: string
  spotName: string
  badiName: string
  implementationName: string
  implementationClass: string
  defaultImplementation?: boolean | undefined
  filters?: Array<Record<string, string>> | undefined
  packageName: string
  transportNumber: string
  confirmation: "CREATE_ENHANCEMENT_IMPLEMENTATION"
}

interface UpdateEnhancementHookInput extends ReadEnhancementImplementationInput {
  expectedFingerprint: string
  extId: string
  source: string[]
  description?: string | undefined
  packageName: string
  transportNumber: string
  confirmation: "UPDATE_ENHANCEMENT_IMPLEMENTATION"
}

interface UpdateNewBadiImplementationInput extends ReadEnhancementImplementationInput {
  expectedFingerprint: string
  implementationName: string
  implementationClass: string
  active: boolean
  defaultImplementation: boolean
  filters: Array<Record<string, string>>
  description?: string | undefined
  packageName: string
  transportNumber: string
  confirmation: "UPDATE_ENHANCEMENT_IMPLEMENTATION"
}

interface ManageEnhancementImplementationStateInput extends ReadEnhancementImplementationInput {
  action: "activate" | "discard_inactive"
  expectedFingerprint: string
  packageName: string
  transportNumber: string
  confirmation: "CHANGE_ENHANCEMENT_IMPLEMENTATION_STATE"
}

interface DeleteEnhancementImplementationInput extends ReadEnhancementImplementationInput {
  expectedFingerprint: string
  packageName: string
  transportNumber: string
  confirmation: "PERMANENT_DELETE"
}

interface EnhancementFrameworkInspectionInput extends ObjectInput {}

interface FicoRuleExitProgramInput {
  programName: string
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
  recoverInactiveSource?: true | undefined
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

interface CleanupTransportEntriesInput {
  connectionId: string
  parentTransportNumber: string
  taskNumber: string
  entries: z.input<typeof cleanupTransportEntrySchema>[]
  expectedFingerprint: string
  confirmation: "REMOVE_CTS_ENTRIES"
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
    private readonly invocationReceipts?: InvocationReceiptStore | undefined,
    private readonly disabledToolNames: readonly string[] = []
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
    return buildCapabilityReport(
      this.backend,
      input.connectionId,
      this.disabledToolNames,
      this.readTransportTableRows.bind(this)
    )
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

  async readSapscriptForm(input: ReadSapscriptFormInput): Promise<string> {
    return JSON.stringify(await this.readSapscriptFormDefinition(input), null, 2)
  }

  async readSmartstyle(input: ReadSmartstyleInput): Promise<string> {
    return JSON.stringify(await this.readSmartstyleDefinition(input), null, 2)
  }

  async readAdobeForm(input: ReadAdobeFormInput): Promise<string> {
    return JSON.stringify(await this.readAdobeFormDefinition(input), null, 2)
  }

  /**
   * Create one modifiable CTS request through the shared SAP repository helper.
   *
   * The confirmation string is checked before any SAP call: an unconfirmed call must not reach the
   * system at all, so the check is the first statement and nothing above it touches the backend.
   */
  async createTransportRequest(input: CreateTransportRequestInput): Promise<string> {
    if (input.confirmation !== "CREATE_TRANSPORT_REQUEST") {
      throw new Error("confirmation must be CREATE_TRANSPORT_REQUEST")
    }
    const connectionId = input.connectionId.toLowerCase()
    const requestType = transportRequestType(input.requestType)
    const requestText = transportRequestText(input.description)
    const result = await this.backend.callSapRepository(connectionId, {
      operation: "CREATE_TRANSPORT_REQUEST",
      requestType,
      requestText,
      ...(input.owner ? { requestOwner: transportRequestOwner(input.owner) } : {}),
      ...(input.target ? { requestTarget: transportRequestTarget(input.target) } : {}),
      requestAllowDuplicate: input.allowDuplicate === true
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    const creation = transportRequestCreation(connectionId, requestType, requestText, result)
    return JSON.stringify(
      creation.created ? creation : await this.completeMatchedTransportRequest(creation),
      null,
      2
    )
  }

  /**
   * Fill a matched request's status, owner, target and task list from the CTS tables.
   *
   * The helper answers a duplicate with the matched request number and the match basis only, so a
   * caller used to receive an empty status, owner, target and task list for a request that plainly
   * has all four. E070 carries one row per request and one per task (`TRFUNCTION = 'S'`, with
   * `STRKORR` naming the request the task belongs to). The matched request number itself is never
   * changed, and a read-back that fails throws: an unread request must not be reported as an empty
   * one.
   */
  private async completeMatchedTransportRequest(
    creation: TransportRequestCreation
  ): Promise<TransportRequestCreation> {
    const header = (
      await this.readTransportTableRows(
        creation.connectionId,
        "E070",
        ["TRKORR", "TRFUNCTION", "TRSTATUS", "TARSYSTEM", "AS4USER"],
        [{ column: "TRKORR", operator: "EQ", value: creation.requestNumber }],
        1
      )
    )[0]
    const tasks = await this.readTransportTableRows(
      creation.connectionId,
      "E070",
      ["TRKORR"],
      [
        { column: "STRKORR", operator: "EQ", value: creation.requestNumber },
        { column: "TRFUNCTION", operator: "EQ", value: "S" }
      ],
      500
    )
    return {
      ...creation,
      status: creation.status || String(header?.TRSTATUS ?? "").trim(),
      owner: creation.owner || String(header?.AS4USER ?? "").trim(),
      target: creation.target || String(header?.TARSYSTEM ?? "").trim(),
      taskNumbers: creation.taskNumbers.length
        ? creation.taskNumbers
        : tasks
            .map((row) => String(row.TRKORR ?? "").trim())
            .filter((number) => number !== "")
            .sort()
    }
  }

  /**
   * Attach objects the service never wrote itself to an existing transport request or task.
   *
   * The confirmation string is checked first, before the backend is touched, and the object rows are
   * narrowed to the four properties SAP's own object entry accepts.
   */
  async addObjectsToTransport(input: AddObjectsToTransportInput): Promise<string> {
    if (input.confirmation !== "ADD_OBJECTS_TO_TRANSPORT") {
      throw new Error("confirmation must be ADD_OBJECTS_TO_TRANSPORT")
    }
    const connectionId = input.connectionId.toLowerCase()
    const requestNumber = transportRequestNumber(input.requestNumber)
    if (input.objects.length === 0) throw new Error("objects must contain at least one entry")
    if (input.objects.length > 20) throw new Error("objects must not contain more than 20 entries")
    const objects = input.objects.map((entry) => transportObjectEntry(entry))
    const transportObjects: SapStructureRow[] = objects.map((entry) => {
      const row: SapStructureRow = {
        PGMID: entry.pgmid,
        OBJECT: entry.object,
        OBJ_NAME: entry.objName
      }
      if (entry.language !== undefined) row.LANG = entry.language
      return row
    })
    const result = await this.backend.callSapRepository(connectionId, {
      operation: "ADD_OBJECTS_TO_TRANSPORT",
      addRequest: requestNumber,
      transportObjects
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    return JSON.stringify(
      transportObjectAddition(connectionId, requestNumber, objects, result),
      null,
      2
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

  private async readSapscriptFormDefinition(
    input: ReadSapscriptFormInput
  ): Promise<SapscriptFormDefinition> {
    const connectionId = input.connectionId.toLowerCase()
    const objectName = sapscriptFormName(input.formName)
    const result = await this.backend.callSapRepository(connectionId, {
      operation: "READ_SAPSCRIPT_FORM",
      objectName,
      textStatus: sapscriptFormStatus(input.status),
      ...repositoryLanguageSelector(input.language),
      includeSource: input.includeSource === true
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    return sapscriptFormDefinition(connectionId, objectName, result)
  }

  private async readSmartstyleDefinition(
    input: ReadSmartstyleInput
  ): Promise<SmartstyleDefinition> {
    const connectionId = input.connectionId.toLowerCase()
    const objectName = smartstyleName(input.styleName)
    const result = await this.backend.callSapRepository(connectionId, {
      operation: "READ_SMARTSTYLE",
      objectName,
      styleMode: smartstyleMode(input.mode),
      styleActive: smartstyleActive(input.active),
      styleVariant: smartstyleVariant(input.variant),
      ...repositoryLanguageSelector(input.language),
      includeCss: input.includeCss === true
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    return smartstyleDefinition(connectionId, objectName, result)
  }

  private async readAdobeFormDefinition(input: ReadAdobeFormInput): Promise<AdobeFormDefinition> {
    const connectionId = input.connectionId.toLowerCase()
    const objectName = adobeFormName(input.formName)
    const result = await this.backend.callSapRepository(connectionId, {
      operation: "READ_ADOBE_FORM",
      objectName,
      ...repositoryLanguageSelector(input.language)
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    return adobeFormDefinition(connectionId, objectName, result)
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
    const maxIncludes = 128
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
    const transactionCode = transactionCodeName(input.transactionCode)
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
    // A domain-bearing element is typed by its domain header; a domain-less element carries
    // the scalar type on DD04L itself, which the helper's data-element reply does not return.
    const domainName = element.header.DOMNAME?.trim()
    const scalarHeader = domainName
      ? await this.readRemoteDomainHeader(connectionId, domainName, typeName)
      : await this.readRemoteDataElementHeader(connectionId, typeName)
    if (element.header.ROLLNAME !== typeName) {
      throw new Error(`DDIC scalar ${typeName} resolved to another identity`)
    }
    if (
      fieldReference &&
      ![
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
      ].includes(scalarHeader.DATATYPE?.trim() ?? "")
    ) {
      throw new Error(`DDIC field data element ${typeName} is not a verified elementary type`)
    }
    return remoteScalarShape(scalarHeader, typeName)
  }

  /** Read one domain header and prove the reply still describes the requested domain. */
  private async readRemoteDomainHeader(
    connectionId: string,
    domainName: string,
    typeName: string
  ): Promise<Record<string, string>> {
    const domain = await this.backend.callSapDdic(connectionId, {
      operation: "READ_DOMAIN",
      objectName: domainName
    })
    requireDdicSuccess(domain)
    if (domain.header.DOMNAME !== domainName) {
      throw new Error(`DDIC scalar ${typeName} resolved to another identity`)
    }
    return domain.header
  }

  /**
   * Read the scalar type of a DDIC data element that has no domain from its own active DD04L
   * row. The DDIC helper's `READ_DATA_ELEMENT` reply carries names and texts only, so without
   * this read an empty DATATYPE would fail the value contract for every domain-less element
   * (for example STRINGVAL, DATATYPE STRG). A row that is missing, belongs to another element,
   * or names a domain keeps the element unresolved so the caller still reports an unverified
   * scalar type instead of accepting an unproven type.
   */
  private async readRemoteDataElementHeader(
    connectionId: string,
    typeName: string
  ): Promise<Record<string, string>> {
    const read = JSON.parse(
      await this.readAbapTable({
        connectionId,
        tableName: "DD04L",
        columns: ["ROLLNAME", "DOMNAME", "DATATYPE", "LENG", "DECIMALS"],
        filters: [
          { column: "ROLLNAME", operator: "EQ", value: typeName },
          { column: "AS4LOCAL", operator: "EQ", value: "A" }
        ],
        maxRows: 2
      })
    ) as { status?: string; returnedCount?: number; data?: Array<Record<string, unknown>> }
    const row = read.status === "ok" && read.returnedCount === 1 ? read.data?.[0] : undefined
    const datatype = String(row?.DATATYPE ?? "").trim()
    const length = String(row?.LENG ?? "").trim()
    const decimals = String(row?.DECIMALS ?? "").trim()
    if (
      !row ||
      String(row.ROLLNAME ?? "") !== typeName ||
      row.DOMNAME ||
      !datatype ||
      !length ||
      !decimals
    ) {
      throw new Error(`Unverified RFC scalar type for ${typeName}`)
    }
    return {
      ROLLNAME: typeName,
      DOMNAME: "",
      DATATYPE: datatype,
      LENG: length,
      DECIMALS: decimals
    }
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

    // PLATFORM LIMIT -- this call does NOT write interface parameters on SAP_BASIS 7.31.
    // The helper opcode PATCH_FUNCTION_INTERFACE has no parameter write path on this release:
    // RPY_FUNCTIONMODULE_UPDATE, the write-back API this method was originally built around, does
    // not exist here (verified: FUNCTION_READ_FAILED), and its wide-line alternatives
    // (RPY_FUNCTIONMODULE_READ_NEW / RPY_FUNCTIONMODULE_INSERT) expose NEW_SOURCE: RSFB_SOURCE,
    // which is a function-group-local type of SIFP that no external caller can declare. The
    // branch's only CALL FUNCTIONs are ENQUEUE_ESFUNCTION / RPY_FUNCTIONMODULE_READ /
    // DEQUEUE_ESFUNCTION and its only PERFORMs are SAPMS38L's fu_modification_globals_init /
    // do_read_docu_r3_new / do_update_docu_r3_new -- that is, it writes parameter DOCUMENTATION
    // only. The fingerprint checks and the read-back comparison below therefore prove that the
    // implementation source was left alone; they do NOT prove the parameters were applied. Apply
    // interface changes manually in SE37. See .logs/20260920-160422-...-missing-rpy-update.md.
    const result = await this.backend.callSapHelper(connectionId, {
      operation: "PATCH_FUNCTION_INTERFACE",
      objectName: functionName,
      program: functionGroup,
      packageName: requestedPackage,
      transportNumber: requestedTransport,
      expectedVersion: current.interfaceFingerprint,
      // Lowercase kinds are the expected snapshot the helper verifies under its own lock;
      // uppercase kinds are the desired definition written back. `serializeFunctionSnapshot`
      // returns the raw repository payload, i.e. the complete current state including every
      // documentation line and source row the helper re-reads, so unchanged parameters are
      // preserved byte for byte and an interface-only patch cannot alter the implementation.
      source: [
        ...serializeFunctionSnapshot(current).map((line) => line[0]!.toLowerCase() + line.slice(1)),
        ...serializeFunctionDefinition(desired)
      ]
    })
    const helperDifferences = (result.source ?? [])
      .filter((line) => /^D\|[1-7]\|/.test(line))
      .slice(0, 49)
      .map((line) => decodeSoapText(line).slice(0, 255))
    requireHelperSuccess(
      result.status,
      result.code,
      result.message +
        (helperDifferences.length
          ? `\nHelper readback differences:\n${helperDifferences.join("\n")}`
          : "")
    )
    // The helper channel returns only the four scalar EV_* values, so the write is verified the
    // same way write_function_module_source verifies one: read the object back from SAP.
    const activatedResult = await this.backend.callSapRepository(connectionId, {
      operation: "READ_FUNCTION_INTERFACE",
      objectType: "SRC1",
      objectName: functionName
    })
    requireRepositorySuccess(activatedResult.status, activatedResult.code, activatedResult.message)
    const saved = functionModuleResult(activatedResult, connectionId, functionName)
    const { source: _desiredSource, ...desiredInterface } = desired
    const { source: _savedSource, ...savedInterface } = functionDefinitionFromResult(saved)
    const verificationMismatches = [
      ["functionGroup", current.functionGroup, saved.functionGroup],
      ["shortText", current.shortText, saved.shortText],
      ["remoteMode", current.remoteMode, saved.remoteMode],
      ["updateTaskMode", current.updateTaskMode, saved.updateTaskMode],
      ["globalInterface", current.globalInterface, saved.globalInterface],
      ["interface", desiredInterface, savedInterface],
      // Named explicitly: an interface-only patch must leave the implementation byte-identical, so
      // a changed implementation fingerprint is the one mismatch an operator must see first.
      ["implementationSourceFingerprint", current.sourceFingerprint, saved.sourceFingerprint]
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
        helperCode: result.code,
        helperMessage: result.message,
        helperVersion: result.version,
        helperVerification:
          "the helper compared its own read-back of the documentation tables; it cannot verify interface parameters on this platform",
        status: result.code,
        packageName: input.packageName.trim().toUpperCase(),
        recordedRequest: input.transportNumber.trim().toUpperCase(),
        // False: the helper opcode writes parameter documentation only on SAP_BASIS 7.31. Reporting
        // true here would be a false success for the parameter changes the caller asked for.
        interfaceWritePerformed: false,
        interfaceWriteSupported: false,
        interfaceWriteLimit:
          "SAP_BASIS 7.31 has no headless interface-parameter write API: RPY_FUNCTIONMODULE_UPDATE does not exist and RSFB_SOURCE is a function-group-local type. Parameter additions, renames, and removals must be applied manually in SE37.",
        parameterChangesApplied: false,
        sourceMutation: null,
        sourceWritePerformed: false,
        destructiveChangeConfirmed: input.confirmation === "DESTRUCTIVE_INTERFACE_CHANGE",
        automaticRetry: false,
        automaticSapUnlock: false,
        transportReleased: false,
        functionDeleted: false
      },
      null,
      2
    )
  }

  /**
   * Replace the implementation body of an existing function module in place.
   *
   * The native ADT write path cannot do this on this platform: `replace_string_in_abap_object`
   * fails with HTTP 423 "Resource MAIN <function> is not locked (invalid lock handle)" for a
   * function module include. The shared helper body therefore performs the write inside SAP:
   * it reads the generated include, replaces only the region between the interface separator and
   * ENDFUNCTION., regenerates the function group, commits, and compares the read-back line by
   * line. The function module is never deleted and its interface is never touched.
   */
  async writeFunctionModuleSource(input: WriteFunctionModuleSourceInput): Promise<string> {
    const functionName = customerName(input.functionName, "functionName")
    const functionGroup = customerName(input.functionGroup, "functionGroup")
    const connectionId = input.connectionId.toLowerCase()
    if (!input.source.length) {
      throw new Error("A complete replacement function body is required")
    }
    // The body travels in the helper's IT_SOURCE table, whose rows are ABAPTXT255, so 255 is the
    // real transport limit; ABAP source lines above the classic 72 columns are legal.
    if (input.source.some((line) => line.length > 255)) {
      throw new Error(
        "Function body source lines must not exceed 255 characters; no write was started"
      )
    }
    const requestedBody = normalizeFunctionBody(input.source)
    if (!requestedBody.length) {
      throw new Error("A complete replacement function body is required")
    }
    const requestedBodyText = requestedBody.join("\n")
    const requestedBodyHash = functionBodyHash(requestedBody)

    const currentResult = await this.backend.callSapRepository(connectionId, {
      operation: "READ_FUNCTION_INTERFACE",
      objectType: "SRC1",
      objectName: functionName
    })
    requireRepositorySuccess(currentResult.status, currentResult.code, currentResult.message)
    const current = functionModuleResult(currentResult, connectionId, functionName)
    if (current.functionGroup !== functionGroup) {
      throw new Error(
        `Function group changed: expected ${functionGroup}, current ${current.functionGroup}`
      )
    }
    if (current.sourceFingerprint !== input.expectedSourceFingerprint.toLowerCase()) {
      throw new Error(
        `Function implementation source fingerprint changed: expected ${input.expectedSourceFingerprint.toLowerCase()}, current ${current.sourceFingerprint}`
      )
    }
    const currentBody = functionImplementationSource(current.source)
    const currentBodyHash = functionBodyHash(currentBody)

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

    const helperResult = await this.backend.callSapHelper(connectionId, {
      operation: "WRITE_FUNCTION_SOURCE",
      objectName: functionName,
      program: functionGroup,
      packageName: requestedPackage,
      transportNumber: requestedTransport,
      expectedVersion: currentBodyHash,
      source: requestedBody
    })
    requireRepositorySuccess(helperResult.status, helperResult.code, helperResult.message)

    const activatedResult = await this.backend.callSapRepository(connectionId, {
      operation: "READ_FUNCTION_INTERFACE",
      objectType: "SRC1",
      objectName: functionName
    })
    requireRepositorySuccess(activatedResult.status, activatedResult.code, activatedResult.message)
    const activated = functionModuleResult(activatedResult, connectionId, functionName)
    const activatedBody = functionImplementationSource(activated.source)
    const activatedBodyText = activatedBody.join("\n")
    const verificationMismatches = [
      ["functionGroup", functionGroup, activated.functionGroup],
      ["interfaceFingerprint", current.interfaceFingerprint, activated.interfaceFingerprint],
      ["body", requestedBodyText, activatedBodyText]
    ]
      .filter(([, expected, actual]) => JSON.stringify(expected) !== JSON.stringify(actual))
      .map(
        ([field, expected, actual]) =>
          `${field}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`
      )
    if (verificationMismatches.length) {
      throw new Error(
        `SAP function source verification did not return the requested replacement:\n${verificationMismatches.join("\n")}`
      )
    }

    return JSON.stringify(
      {
        ...activated,
        previousFingerprint: current.fingerprint,
        previousInterfaceFingerprint: current.interfaceFingerprint,
        previousSourceFingerprint: current.sourceFingerprint,
        previousBodyHash: currentBodyHash,
        bodyHash: requestedBodyHash,
        bodyLines: requestedBody.length,
        previousBodyLines: currentBody.length,
        requestedBodyAlreadyActive: requestedBodyText === currentBody.join("\n"),
        helperCode: helperResult.code,
        helperMessage: helperResult.message,
        helperVersion: helperResult.version,
        helperVerification: "the helper compared the read-back line by line",
        interfaceUnchanged: true,
        packageName: requestedPackage,
        recordedRequest: requestedTransport,
        automaticRetry: false,
        automaticSapUnlock: false,
        transportReleased: false,
        functionDeleted: false
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
      transportNumber: ddicTransport(input.packageName, input.transportNumber),
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

  async readSearchHelp(input: ReadDdicInput): Promise<string> {
    return this.readDdic(input, "READ_SEARCH_HELP", "searchHelp")
  }

  async upsertSearchHelp(input: UpsertSearchHelpInput): Promise<string> {
    const objectName = customerDdicName(input.objectName)
    validateDescription(input.description)
    const header = searchHelpHeader(input.header)
    const selectionMethods = searchHelpRows(input.selectionMethods, "selectionMethods")
    const parameters = searchHelpRows(input.parameters, "parameters")
    const fieldAssignments = searchHelpRows(input.fieldAssignments, "fieldAssignments")
    const result = await this.backend.callSapDdic(input.connectionId.toLowerCase(), {
      operation: "UPSERT_SEARCH_HELP",
      objectName,
      description: input.description,
      packageName: ddicPackageName(input.packageName),
      transportNumber: ddicTransport(input.packageName, input.transportNumber),
      expectedVersion: versionToken(input.expectedVersion),
      header,
      selectionMethods,
      parameters,
      fieldAssignments
    })
    return savedDdicResult(
      result,
      "searchHelp",
      objectName,
      input.packageName,
      input.connectionId,
      {
        description: input.description,
        issimple: header.ISSIMPLE === "X",
        selectionMethod: header.SELMETHOD ?? "",
        selectionMethodType: header.SELMTYPE ?? "",
        textTable: header.TEXTTAB ?? "",
        selectionExit: header.SELMEXIT ?? "",
        hotkey: header.HOTKEY ?? "",
        dialogType: header.DIALOGTYPE ?? "",
        selectionMethods,
        parameters,
        fieldAssignments
      }
    )
  }

  async readLockObject(input: ReadDdicInput): Promise<string> {
    return this.readDdic(input, "READ_LOCK_OBJECT", "lockObject")
  }

  async upsertLockObject(input: UpsertLockObjectInput): Promise<string> {
    const objectName = customerDdicName(input.objectName)
    validateDescription(input.description)
    const header = lockObjectHeader(input.header)
    const lockTables = lockObjectRows(input.lockTables, "lockTables")
    const lockFields = lockObjectRows(input.lockFields, "lockFields")
    const result = await this.backend.callSapDdic(input.connectionId.toLowerCase(), {
      operation: "UPSERT_LOCK_OBJECT",
      objectName,
      description: input.description,
      packageName: ddicPackageName(input.packageName),
      transportNumber: ddicTransport(input.packageName, input.transportNumber),
      expectedVersion: versionToken(input.expectedVersion),
      header,
      lockTables,
      lockFields
    })
    return savedDdicResult(
      result,
      "lockObject",
      objectName,
      input.packageName,
      input.connectionId,
      {
        description: input.description,
        aggregationType: header.AGGTYPE ?? "",
        rootTable: header.ROOTTAB ?? "",
        lockTables,
        lockFields
      }
    )
  }

  async readNumberRangeObject(input: ReadDdicInput): Promise<string> {
    return this.readDdic(input, "READ_NUMBER_RANGE_OBJECT", "numberRangeObject")
  }

  async upsertNumberRangeObject(input: UpsertNumberRangeObjectInput): Promise<string> {
    const objectName = numberRangeObjectName(input.objectName)
    validateDescription(input.description)
    const properties = numberRangeProperties(input.properties)
    const texts = numberRangeTexts(input.texts)
    const result = await this.backend.callSapDdic(input.connectionId.toLowerCase(), {
      operation: "UPSERT_NUMBER_RANGE_OBJECT",
      objectName,
      description: input.description,
      packageName: ddicPackageName(input.packageName),
      transportNumber: ddicTransport(input.packageName, input.transportNumber),
      expectedVersion: numberRangeObjectVersion(input.expectedVersion),
      header: properties,
      numberRangeTexts: texts
    })
    return savedNumberRangeObjectResult(
      result,
      objectName,
      input.packageName,
      input.connectionId,
      properties,
      texts.map((row) => ({
        language: row.LANGU ?? "",
        text: row.TXT ?? "",
        shortText: row.TXTSHORT ?? ""
      }))
    )
  }

  async readMaintenanceView(input: ReadDdicInput): Promise<string> {
    return this.readDdic(input, "READ_MAINTENANCE_VIEW", "maintenanceView")
  }

  async upsertMaintenanceView(input: UpsertMaintenanceViewInput): Promise<string> {
    const objectName = customerDdicName(input.objectName)
    validateDescription(input.description)
    const baseTables = maintenanceViewBaseTables(input.baseTables)
    const viewFields = maintenanceViewViewFields(input.viewFields)
    const header = maintenanceViewHeader(input.header, baseTables)
    const result = await this.backend.callSapDdic(input.connectionId.toLowerCase(), {
      operation: "UPSERT_MAINTENANCE_VIEW",
      objectName,
      description: input.description,
      packageName: ddicPackageName(input.packageName),
      transportNumber: ddicTransport(input.packageName, input.transportNumber),
      expectedVersion: versionToken(input.expectedVersion),
      header,
      baseTables,
      viewFields
    })
    return savedMaintenanceViewResult(
      result,
      objectName,
      input.packageName,
      input.connectionId,
      header,
      baseTables,
      viewFields
    )
  }

  async upsertAppendStructureFields(input: UpsertAppendStructureFieldsInput): Promise<string> {
    const objectName = customerDdicName(input.objectName)
    if (!input.fields.length) throw new Error("fields must contain at least one component")
    const names = new Set<string>()
    const fields = input.fields.map((field) => {
      const name = ddicFieldName(field.name)
      if (names.has(name)) throw new Error(`Duplicate append field: ${name}`)
      names.add(name)
      return { FIELDNAME: name, ROLLNAME: ddicName(field.dataElement, "dataElement") }
    })
    const result = await this.backend.callSapDdic(input.connectionId.toLowerCase(), {
      operation: "UPSERT_APPEND_STRUCTURE_FIELDS",
      objectName,
      expectedVersion: appendVersionToken(input.expectedVersion),
      appendFields: fields
    })
    return savedAppendStructureFieldsResult(result, objectName, input.connectionId, fields)
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
      transportNumber: ddicTransport(input.packageName, input.transportNumber),
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
      transportNumber: ddicTransport(input.packageName, input.transportNumber),
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
      transportNumber: ddicTransport(input.packageName, input.transportNumber),
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
      transportNumber: ddicTransport(input.packageName, input.transportNumber),
      expectedVersion,
      fields: appendedFields
    })
    const expectedResult = {
      ...current,
      fields: appendTransparentTableRawFields(current.fields, appendedFields)
    }
    const layoutComponents = transparentTableComponents(current.fields).map(
      (component) => component.name
    )
    return savedDdicResult(
      result,
      "transparentTable",
      objectName,
      packageName,
      connectionId,
      {
        ...ddicDefinition(expectedResult, "transparentTable")
      },
      // New direct fields are inserted before the first Append marker, so every component of the
      // existing layout survives untouched; the caller gets that list back instead of inferring it.
      layoutComponents.length ? { layoutComponents } : {}
    )
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
    const fields = applyTransparentTableRawFieldChanges(current.fields, input.changes)
    const layoutComponents = transparentTableComponents(current.fields).map(
      (component) => component.name
    )
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
      transportNumber: ddicTransport(input.packageName, input.transportNumber),
      expectedVersion,
      fields: serializeDdicTableFields(fields)
    })
    const expectedResult = { ...current, fields }
    return savedDdicResult(
      result,
      "transparentTable",
      objectName,
      packageName,
      connectionId,
      {
        ...ddicDefinition(expectedResult, "transparentTable")
      },
      // The components that were preserved byte-for-byte are declared explicitly, so a caller never
      // has to infer from the row set which parts of the layout it was not allowed to touch.
      layoutComponents.length ? { layoutComponents } : {}
    )
  }

  async patchDdicTransparentTableSettings(
    input: PatchTransparentTableSettingsInput
  ): Promise<string> {
    if (input.confirmation !== "TECHNICAL_SETTINGS_CHANGE") {
      throw new Error("confirmation must be TECHNICAL_SETTINGS_CHANGE")
    }
    const connectionId = input.connectionId.toLowerCase()
    const objectName = customerDdicTableName(input.objectName)
    const packageName = ddicPackageName(input.packageName)
    const { result, definition } = await this.applyTransparentTableSettingsPatch({
      connectionId,
      objectName,
      packageName,
      transportNumber: ddicTransport(input.packageName, input.transportNumber),
      settings: input.settings,
      expectedVersion: requiredVersionToken(input.expectedVersion),
      expectedFingerprint: requiredDdicFingerprint(input.expectedFingerprint)
    })
    return savedDdicResult(
      result,
      "transparentTable",
      objectName,
      packageName,
      connectionId,
      definition
    )
  }

  /**
   * Write DD09V technical settings for one table, guarded by package, version and definition
   * fingerprint. Shared by `patch_ddic_transparent_table_settings` and the settings repair step of
   * `resume_ddic_table_activation`, so both paths re-read and re-verify the same way.
   */
  private async applyTransparentTableSettingsPatch(input: {
    connectionId: string
    objectName: string
    packageName: string
    transportNumber: string
    settings: PatchTransparentTableSettingsInput["settings"]
    expectedVersion: string
    expectedFingerprint: string
  }): Promise<{ result: SapDdicResult; definition: Record<string, unknown> }> {
    const current = await this.backend.callSapDdic(input.connectionId, {
      operation: "READ_TRANSPARENT_TABLE",
      objectName: input.objectName
    })
    requireCurrentDdicDefinition(current, input.packageName, input.expectedVersion)
    const currentDefinition = ddicDefinition(current, "transparentTable")
    if (
      createHash("sha256").update(JSON.stringify(currentDefinition)).digest("hex") !==
      input.expectedFingerprint
    ) {
      throw new Error(
        "FINGERPRINT_CONFLICT: Transparent table definition changed since it was read"
      )
    }
    if (
      input.settings.buffering === undefined &&
      !["N", "A", "X"].includes(current.header.BUFALLOW ?? "")
    ) {
      throw new Error(
        "Current buffering allowance is not canonical; supply an explicit buffering setting"
      )
    }
    const finalSettings = mergeTransparentTableSettings(currentDefinition, input.settings)
    const result = await this.backend.callSapDdic(input.connectionId, {
      operation: "PATCH_TRANSPARENT_TABLE_SETTINGS",
      objectName: input.objectName,
      description: String(currentDefinition.description ?? ""),
      packageName: input.packageName,
      transportNumber: input.transportNumber,
      expectedVersion: input.expectedVersion,
      header: technicalSettingsHeader(finalSettings)
    })
    return { result, definition: { ...currentDefinition, ...finalSettings } }
  }

  async readDdicTableConversionStatus(input: ReadDdicInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const objectName = ddicName(input.objectName, "objectName")
    const result = JSON.parse(
      await this.readAbapTable({
        connectionId,
        tableName: "TBATG",
        columns: [
          "OBJECT",
          "TABNAME",
          "INDNAME",
          "TGORDER",
          "FCT",
          "EXECMODE",
          "SEVERITY",
          "GDATE",
          "GUSER"
        ],
        filters: [
          { column: "OBJECT", operator: "EQ", value: "TABL" },
          { column: "TABNAME", operator: "EQ", value: objectName }
        ],
        maxRows: 50
      })
    ) as {
      status?: string
      data?: Array<Record<string, unknown>>
      truncated?: boolean
      code?: string
      stage?: string
    }
    if (result.status !== "ok" || !Array.isArray(result.data)) {
      throw new Error(
        `Conversion worklist read failed: ${result.code ?? "unknown"}; stage=${result.stage ?? "unknown"}`
      )
    }
    if (result.truncated) throw new Error("Conversion worklist exceeds the 50-entry safety limit")
    const entries = result.data
      .map(normalizeConversionEntry)
      .sort((left, right) => conversionEntryKey(left).localeCompare(conversionEntryKey(right)))
    return JSON.stringify(
      {
        connectionId,
        objectName,
        pending: entries.length > 0,
        entryCount: entries.length,
        worklistFingerprint: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
        entries,
        readOnly: true,
        snapshot: false
      },
      null,
      2
    )
  }

  async recoverDdicTableConversion(input: RecoverDdicTableConversionInput): Promise<string> {
    if (
      input.confirmation !== "RECOVER_NATIVE_TABLE_CONVERSION" ||
      input.acknowledgePotentialDataLoss !== true
    ) {
      throw new Error(
        "confirmation must be RECOVER_NATIVE_TABLE_CONVERSION and acknowledgePotentialDataLoss must be true"
      )
    }
    const connectionId = input.connectionId.toLowerCase()
    const objectName = customerDdicTableName(input.objectName)
    const packageName = ddicPackageName(input.packageName)
    const before = JSON.parse(
      await this.readDdicTableConversionStatus({ connectionId, objectName })
    ) as {
      pending: boolean
      worklistFingerprint: string
      entries: Array<Record<string, string>>
    }
    if (!before.pending)
      throw new Error("No native TBATG conversion worklist exists for this table")
    if (before.worklistFingerprint !== input.expectedWorklistFingerprint.trim().toLowerCase()) {
      throw new Error("WORKLIST_CONFLICT: Native conversion state changed since it was read")
    }
    const result = await this.backend.callSapDdic(connectionId, {
      operation: "RECOVER_TABLE_CONVERSION",
      objectName,
      description: "Native table conversion recovery",
      packageName,
      transportNumber: ddicTransport(input.packageName, input.transportNumber),
      fields: before.entries
    })
    requireDdicSuccess(result)
    const after = JSON.parse(
      await this.readDdicTableConversionStatus({ connectionId, objectName })
    ) as { pending: boolean; worklistFingerprint: string; entries: unknown[] }
    if (after.pending) {
      throw new Error("CONVERSION_RECOVERY_INCOMPLETE: Native TBATG entries remain after recovery")
    }
    const active = JSON.parse(
      await this.readDdicTransparentTable({ connectionId, objectName })
    ) as Record<string, unknown>
    return JSON.stringify(
      {
        connectionId,
        objectName,
        status: result.code,
        recovered: true,
        previousWorklistFingerprint: before.worklistFingerprint,
        remainingWorklistFingerprint: after.worklistFingerprint,
        active,
        recordedRequest: result.recordedRequest,
        automaticRetry: false,
        automaticRollback: false,
        lostValuesReconstructed: false
      },
      null,
      2
    )
  }

  /**
   * Activates a transparent table whose definition is already stored but inactive, without sending a
   * new definition. This is the recovery path for a create or write that failed after DDIF_TABL_PUT
   * had already saved a non-active version (reported as DDIC_SAVE_FAILED with PHASE=inactive_saved).
   *
   * The stored definition is read back first, so the caller's expected fingerprint is verified
   * against what SAP actually holds before anything is activated; a mismatch aborts without touching
   * the object.
   */
  async resumeDdicTableActivation(input: ResumeDdicTableActivationInput): Promise<string> {
    if (input.confirmation !== "RESUME_INACTIVE_ACTIVATION") {
      throw new Error("confirmation must be RESUME_INACTIVE_ACTIVATION")
    }
    const connectionId = input.connectionId.toLowerCase()
    const objectName = customerDdicTableName(input.objectName)
    const packageName = ddicPackageName(input.packageName)
    const readStored = () =>
      this.backend.callSapDdic(connectionId, { operation: "READ_TRANSPARENT_TABLE", objectName })
    const stored = await readStored()
    if (stored.metadata.INACTIVE !== "X") {
      throw new Error(
        stored.status.toUpperCase() === "S"
          ? "NO_INACTIVE_VERSION: This table has no inactive version to resume"
          : `SAP DDIC helper rejected the operation: ${stored.code}: ${stored.message}`
      )
    }
    const definitionOf = (result: SapDdicResult) => ddicDefinition(result, "transparentTable")
    const fingerprintOf = (definition: Record<string, unknown>) =>
      createHash("sha256").update(JSON.stringify(definition)).digest("hex")
    const storedDefinition = definitionOf(stored)
    // The 10:26 incident showed the deployed helper's inactive path publishing no field rows at all,
    // which hashed a 29-field table to a field-less definition. Refuse before the fingerprint gate:
    // a fingerprint over an empty field list would authorise activating the partial state the caller
    // is verifying, and DD03L proves the rows exist.
    if (ddicFieldCount(storedDefinition) === 0) {
      throw new Error(
        `INACTIVE_DEFINITION_INCOMPLETE: the stored inactive version of ${objectName} reported 0 fields, so its definition cannot be verified and no activation fingerprint can be authorised. ` +
          "The installed DDIC helper publishes no field rows for an inactive definition (its inactive path reads the active version's fields); deploy the current helper body from scripts/bootstrap-sap-helper.ps1 first. " +
          "Read the physical rows with read_abap_table(DD03L, filters TABNAME and AS4LOCAL = 'N') to see the stored fields in the meantime. No activation was attempted."
      )
    }
    const storedFingerprint = fingerprintOf(storedDefinition)
    const expected = input.expectedInactiveFingerprint.trim().toLowerCase()
    if (storedFingerprint !== expected) {
      throw new Error(
        `INACTIVE_STATE_CONFLICT: The stored inactive definition changed since it was read (expected ${expected}, found ${storedFingerprint})`
      )
    }

    // The inactive path of the deployed helper publishes DD02V attributes but no DD09V technical
    // settings, and the 17:37 incident showed what that costs: the caller read dataClass "" and
    // sizeCategory 0 and could not tell "SAP stored nothing" from "this read cannot see it", then
    // faced activating the stored version unchanged. Activation is therefore gated on a technical
    // setting set this service can actually see and, when the caller supplies one, on re-writing it
    // first - never on a value that only looks empty.
    const settingsOf = (definition: Record<string, unknown>) => ({
      dataClass: String(definition.dataClass ?? ""),
      sizeCategory: Number(definition.sizeCategory ?? 0),
      buffering: String(definition.buffering ?? ""),
      logDataChanges: definition.logDataChanges === true
    })

    const reported = technicalSettingsReported(stored)
    const before = settingsOf(storedDefinition)
    const usable = /^APPL[012]$/.test(before.dataClass) && before.sizeCategory >= 1

    if (input.settingsRepair === undefined && !usable) {
      throw new Error(
        `${
          reported
            ? "INACTIVE_TECHNICAL_SETTINGS_INCOMPLETE"
            : "INACTIVE_TECHNICAL_SETTINGS_NOT_REPORTED"
        }: the stored inactive version of ${objectName} has dataClass "${before.dataClass || "<empty>"}" and sizeCategory ${before.sizeCategory}, so activating it could persist incomplete technical settings.${
          reported
            ? ""
            : " The deployed helper does not report DD09V technical settings for an inactive definition (its inactive payload carries DD02V attributes only), so this read cannot distinguish an empty DD09L row from an unreported one."
        } Pass settingsRepair with the approved dataClass/sizeCategory (plus acknowledgeTechnicalSettingsChange) to write them under this fingerprint before activating, or recreate the table. No activation was attempted.`
      )
    }

    let activeExpectedFingerprint = expected
    let after = before
    let repair: Record<string, unknown> | undefined
    if (input.settingsRepair !== undefined) {
      const { acknowledgeTechnicalSettingsChange, ...settings } = input.settingsRepair
      if (acknowledgeTechnicalSettingsChange !== true) {
        throw new Error("settingsRepair.acknowledgeTechnicalSettingsChange must be true")
      }
      if (!reported && settings.dataClass === undefined && settings.sizeCategory === undefined) {
        throw new Error(
          "settingsRepair must set dataClass and sizeCategory: this helper does not report the stored technical settings, so only an explicit value can be verified"
        )
      }
      if (!reported) {
        // Nothing about DD09L is visible, so a partial patch would silently write defaults for the
        // settings the caller did not mention (buffering off, change logging off) instead of
        // preserving them. Require the complete set so the repair states the approved definition.
        const missing = (
          ["dataClass", "sizeCategory", "buffering", "logDataChanges"] as const
        ).filter((key) => settings[key] === undefined)
        if (missing.length > 0) {
          throw new Error(
            `settingsRepair must supply the complete technical settings (${missing.join(", ")}): this helper does not report DD09V values for an inactive definition, so omitted settings would be written as defaults rather than preserved`
          )
        }
      }
      const patched = await this.applyTransparentTableSettingsPatch({
        connectionId,
        objectName,
        packageName,
        transportNumber: ddicTransport(input.packageName, input.transportNumber),
        settings,
        expectedVersion: requiredVersionToken(stored.objectVersion),
        expectedFingerprint: storedFingerprint
      })
      // The patch rewrites DD09L, so the stored definition and fingerprint change: re-read instead
      // of assuming, and gate activation on the state that now exists.
      const reread = await readStored()
      const rereadDefinition = definitionOf(reread)
      activeExpectedFingerprint = fingerprintOf(rereadDefinition)
      after = settingsOf(rereadDefinition)
      repair = {
        requested: settings,
        applyStatus: patched.result.code,
        fingerprintBefore: storedFingerprint,
        fingerprintAfter: activeExpectedFingerprint,
        technicalSettingsBefore: before,
        technicalSettingsAfter: after
      }
      const stillUnusable = !/^APPL[012]$/.test(after.dataClass) || after.sizeCategory < 1
      if (stillUnusable) {
        throw new Error(
          `INACTIVE_TECHNICAL_SETTINGS_INCOMPLETE: the technical-settings repair did not produce a usable dataClass/sizeCategory (found "${after.dataClass || "<empty>"}" / ${after.sizeCategory}); activation was not attempted`
        )
      }
    }

    const result = await this.backend.callSapDdic(connectionId, {
      operation: "RESUME_TABLE_ACTIVATION",
      objectName,
      description: "Resume inactive transparent table activation",
      packageName,
      transportNumber: ddicTransport(input.packageName, input.transportNumber)
      // No expectedVersion: the helper's iv_expected_version is the ACTIVE version's timestamp token
      // (AS4DATE + AS4TIME, 14 characters) used by the create/patch paths. A resume has no active
      // version to tokenise and this service holds a content fingerprint (64 hex characters), so the
      // two can never be equal - passing the fingerprint here only ever produced VERSION_CONFLICT on
      // a path that was unreachable anyway. Stale-read protection for the resume stays where it can
      // actually be evaluated: the expectedInactiveFingerprint gate above, which compares the
      // caller's fingerprint with the definition this call just re-read, plus the helper's own
      // NO_INACTIVE_VERSION guard.
    })
    requireDdicSuccess(result)
    const active = JSON.parse(
      await this.readDdicTransparentTable({ connectionId, objectName })
    ) as Record<string, unknown>
    // Verify what was activated instead of trusting the activation call: the resume operation sends
    // no definition, so the only proof that APPL1/1 survived is the active read.
    const activeDefinition = (active.definition ?? {}) as Record<string, unknown>
    const expectedSettings = input.settingsRepair === undefined ? before : after
    const activeSettings = {
      dataClass: String(activeDefinition.dataClass ?? ""),
      sizeCategory: Number(activeDefinition.sizeCategory ?? 0),
      buffering: String(activeDefinition.buffering ?? "")
    }
    const technicalSettingsVerified =
      active.status !== "inactive" &&
      activeSettings.dataClass === expectedSettings.dataClass &&
      activeSettings.sizeCategory === expectedSettings.sizeCategory
    const warnings = [
      ...(reported
        ? []
        : [
            "The deployed helper does not report DD09V technical settings for an inactive definition; the pre-activation values could not be read from SAP."
          ]),
      ...(technicalSettingsVerified
        ? []
        : [
            `The active version reports dataClass "${activeSettings.dataClass || "<empty>"}" and sizeCategory ${activeSettings.sizeCategory}, which does not match the expected "${expectedSettings.dataClass}" / ${expectedSettings.sizeCategory}.`
          ])
    ]
    return JSON.stringify(
      {
        connectionId,
        objectName,
        status: technicalSettingsVerified ? result.code : "ACTIVATED_TECHNICAL_SETTINGS_MISMATCH",
        resumed: true,
        expectedInactiveFingerprint: expected,
        inactiveFingerprint: storedFingerprint,
        activatedFingerprint: activeExpectedFingerprint,
        inactiveDefinition: storedDefinition,
        technicalSettingsReported: reported,
        technicalSettingsRepair: repair ?? null,
        technicalSettingsVerified,
        activeTechnicalSettings: activeSettings,
        activeVersion: result.objectVersion,
        active,
        recordedRequest: result.recordedRequest,
        definitionResent: false,
        automaticRetry: false,
        automaticRollback: false,
        ...(warnings.length > 0 ? { warnings } : {})
      },
      null,
      2
    )
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
      transportNumber: ddicTransport(input.packageName, input.transportNumber),
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
        : input.objectType === "NROB"
          ? numberRangeObjectName(input.objectName)
          : customerDdicName(input.objectName)
    const expectedPackage = ddicPackageName(input.packageName)
    const operation = {
      DOMA: "DELETE_DOMAIN",
      DTEL: "DELETE_DATA_ELEMENT",
      STRU: "DELETE_STRUCTURE",
      TABL: "DELETE_TRANSPARENT_TABLE",
      TTYP: "DELETE_TABLE_TYPE",
      SHLP: "DELETE_SEARCH_HELP",
      ENQU: "DELETE_LOCK_OBJECT",
      NROB: "DELETE_NUMBER_RANGE_OBJECT",
      VIEW: "DELETE_MAINTENANCE_VIEW"
    }[input.objectType] as SapDdicOperation
    const result = await this.backend.callSapDdic(input.connectionId.toLowerCase(), {
      operation,
      objectName,
      packageName: expectedPackage,
      transportNumber: ddicTransport(input.packageName, input.transportNumber),
      expectedVersion:
        input.objectType === "NROB"
          ? requiredNumberRangeObjectVersion(input.expectedVersion)
          : requiredVersionToken(input.expectedVersion)
    })
    requireDdicSuccess(result)
    // A number range deletion reports its outcome under payload keys that the parser mirrors into
    // header as a fallback for object attributes, so the strict "not one header row" test would reject
    // a correct deletion. Its absence proof is the object key never coming back, together with the
    // helper's own TNRO/TNROT read-back, which fails with NUMBER_RANGE_VERIFY_FAILED. A maintenance
    // view deletion has the same shape: it publishes PACKAGE/VERSION/REQUEST/TADIR_ENTRY_REMOVED, so
    // the absence proof is that VIEWNAME never comes back.
    const residueKey =
      input.objectType === "NROB" ? "OBJECT" : input.objectType === "VIEW" ? "VIEWNAME" : undefined
    const definitionResidue =
      residueKey === undefined
        ? Object.keys(result.header).length > 0
        : (result.header[residueKey] ?? "") !== ""
    if (definitionResidue) {
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
        absenceVerified: true,
        ...(input.objectType === "NROB"
          ? {
              numberRangeObject: {
                deletedVersion: result.objectVersion,
                recordedPackage: result.packageName,
                tadirEntryRemoved: result.metadata.TADIR_ENTRY_REMOVED === "X"
              }
            }
          : {}),
        ...(input.objectType === "VIEW"
          ? {
              maintenanceView: {
                deletedVersion: result.objectVersion,
                recordedPackage: result.packageName,
                tadirEntryRemoved: result.metadata.TADIR_ENTRY_REMOVED === "X"
              }
            }
          : {})
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
    // Older helpers answer a read of an inactive-only object with a bare INACTIVE_VERSION_EXISTS,
    // which reads like "unsupported" when the real problem is that the helper is stale. Translate it
    // into an actionable deployment message rather than letting the caller guess.
    if (result.code === "INACTIVE_VERSION_EXISTS" && result.metadata.INACTIVE !== "X") {
      const protocol = await this.ddicHelperProtocol(input.connectionId.toLowerCase())
      throw new Error(
        `INACTIVE_VERSION_UNREADABLE: ${objectName} has only an inactive version and the installed DDIC helper cannot describe it. ` +
          `The helper self-described protocol ${protocol ?? "unknown"}, below the 1.10 required to read an inactive definition ` +
          `(support exists in the packaged helper script but has not been deployed to SAP). ` +
          `This is a helper deployment gap, not a missing object, and not a reason to create the object again. ` +
          `Deploy the current helper, or inspect DD02L/DD03L read-only, before retrying.`
      )
    }
    requireDdicSuccess(result)
    // A read of an object that only has a non-active version returns that version's definition with
    // INACTIVE set, so the caller can inspect it and derive the fingerprint a resume needs instead of
    // being told only that an inactive version exists.
    if (result.metadata.INACTIVE === "X") {
      const definition = ddicDefinition(result, kind)
      // The 10:26 incident read a 29-field inactive table as `fields: []` while DD03L held all 29
      // rows with AS4LOCAL = 'N'. The deployed helper published DD02V attributes and DD09V settings
      // for the inactive definition but took the field rows from the active version, which does not
      // exist for an inactive-only object. A transparent table or structure always has at least one
      // field, so an empty list means this read did not see the stored definition - and a fingerprint
      // hashed over that empty list would authorise activating exactly the partial state the caller
      // is trying to inspect. Never offer it.
      if (kind === "transparentTable" || kind === "structure") {
        if (ddicFieldCount(definition) === 0) {
          return JSON.stringify(
            {
              connectionId: input.connectionId,
              objectName,
              status: "inactive-definition-incomplete",
              active: false,
              inactiveVersionDescribed: true,
              gotState: result.metadata.GOTSTATE ?? "",
              inactiveVersionAttributes: Object.fromEntries(
                Object.entries(result.metadata).filter(
                  ([key]) => key !== "INACTIVE" && key !== "GOTSTATE"
                )
              ),
              definition,
              fieldsReported: 0,
              definitionIncomplete: true,
              definitionFingerprint: null,
              technicalSettingsReported: technicalSettingsReported(result),
              reason:
                "SAP holds an inactive definition for this object, but the installed DDIC helper published no field rows for it, so this is not the stored definition: a transparent table or structure always has at least one field. No activation fingerprint is offered, because a hash over an empty field list would certify exactly the partial state this read is meant to verify.",
              likelyCause:
                "The deployed helper's inactive path reads the field rows from the active version of the object instead of the inactive one. For an object that has no active version the active field table is empty in SAP; for an object that has both, it would report the active fields as if they were inactive.",
              substitutes: [
                "read_abap_table(DD03L, filters TABNAME = <object> and AS4LOCAL = 'N') for the physical inactive field rows",
                "read_abap_table(DD02L, filters TABNAME = <object>) for the stored header state rows",
                "read_ddic_table_conversion_status for the native TBATG worklist"
              ],
              requiredAction:
                "Deploy the current DDIC helper body from scripts/bootstrap-sap-helper.ps1 and re-read this object; the resume tool also refuses to activate this state. No activation was attempted and no fingerprint was issued.",
              automaticRetry: false
            },
            null,
            2
          )
        }
      }
      return JSON.stringify(
        {
          connectionId: input.connectionId,
          objectName,
          status: "inactive",
          active: false,
          inactiveVersionDescribed: true,
          gotState: result.metadata.GOTSTATE ?? "",
          // The attributes the helper reported for the inactive version, exactly as sent, minus the
          // protocol keys. The 17:10 incident could not tell whether an empty tableClass came from
          // SAP or from the client dropping the rows the helper published; this makes that
          // distinguishable without a code change.
          inactiveVersionAttributes: Object.fromEntries(
            Object.entries(result.metadata).filter(
              ([key]) => key !== "INACTIVE" && key !== "GOTSTATE"
            )
          ),
          definition,
          definitionFingerprint: createHash("sha256")
            .update(JSON.stringify(definition))
            .digest("hex"),
          // False means the deployed helper published no DD09V technical settings for this inactive
          // definition, so definition.dataClass/sizeCategory are client defaults, not SAP facts. The
          // 17:37 incident read them as "the stored table has no data class" and was one step from
          // activating that state; activation now refuses unless the caller supplies the values.
          technicalSettingsReported: technicalSettingsReported(result),
          resumeTool: "resume_ddic_table_activation",
          notice:
            "This definition is stored but not active. Inspect it, then use resume_ddic_table_activation with expectedInactiveFingerprint set to definitionFingerprint to activate it. Do not call a create tool for this object." +
            (technicalSettingsReported(result)
              ? ""
              : " This helper does not report DD09V technical settings for an inactive definition, so dataClass/sizeCategory here are not SAP values: pass settingsRepair (dataClass, sizeCategory, acknowledgeTechnicalSettingsChange) to resume_ddic_table_activation if the approved definition requires values it cannot show."),
          ...(technicalSettingsReported(result)
            ? {}
            : {
                warnings: [
                  "dataClass/sizeCategory are not reported by the deployed helper for an inactive definition and must not be treated as stored values."
                ]
              })
        },
        null,
        2
      )
    }
    return JSON.stringify(ddicResult(result, kind, objectName, input.connectionId), null, 2)
  }

  /**
   * Best-effort read of the installed DDIC helper's self-described maximum protocol, used only to
   * explain why an operation is unavailable. Never throws: an unreadable report yields undefined so
   * the caller's message degrades to "unknown" rather than masking the original failure.
   */
  private async ddicHelperProtocol(connectionId: string): Promise<string | undefined> {
    try {
      const report = JSON.parse(await this.getCapabilityReport({ connectionId })) as {
        helperAttestation?: Array<{ helper?: string; maxProtocol?: string; minProtocol?: string }>
      }
      const entries = report.helperAttestation ?? []
      const ddic = entries.find((entry) => (entry.helper ?? "").includes("DDIC_API"))
      return ddic?.maxProtocol ?? ddic?.minProtocol
    } catch {
      return undefined
    }
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
            .map(
              (enhancement) =>
                `  - ${enhancement.name} (line ${enhancement.startLine === undefined ? "unknown" : enhancement.startLine})`
            )
            .join("\n")}`
        : "\n• Enhancements: No enhancements found"
    } catch (error) {
      const failure = classifyEnhancementFailure(error)
      enhancementInfo = `\n• Enhancements: Unavailable (${failure.status})`
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

    if (/^ENHO\/XH(?:B)?$/i.test(object.type)) {
      return (
        `${input.objectName} is an ENHO/XH enhancement implementation container, not a direct ABAP source body.\n` +
        "Source status: not_applicable\n" +
        "No source fingerprint is reported. Resolve and inspect the implementing class through the BAdI definition/implementation tools."
      )
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
            .map(
              (enhancement) =>
                `• ${enhancement.name} (line ${enhancement.startLine === undefined ? "unknown" : enhancement.startLine})`
            )
            .join(
              "\n"
            )}\nUse search tool to find enhancement code, or re-call this tool with the enhancement line range.`
        }
      } catch (error) {
        const failure = classifyEnhancementFailure(error)
        enhancementInfo = `\n\nEnhancement metadata unavailable (${failure.status}).`
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
      if (!source && /\/enhancements\//i.test(input.uri)) {
        return (
          `Direct URI Access Successful\nOriginal URI: ${input.uri}\nURI Used: ${uriUsed}\n` +
          "Source status: not_applicable\n" +
          "This enhancement repository container has no direct ABAP source body. Resolve and inspect its implementing class instead."
        )
      }
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

  async inspectSourceEnhancements(input: EnhancementInspectionInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const object = await this.findOne(connectionId, input.objectName, input.objectType)
    if (!object) {
      throw new Error(
        `Could not find ABAP source object: ${input.objectName}${input.objectType ? ` (${input.objectType})` : ""}.`
      )
    }

    const sourceResult = await this.backend.readSource(connectionId, object, { version: "active" })
    if (sourceResult.kind === "dictionary") {
      throw new Error(
        `Enhancement source inspection does not support Dictionary object ${object.name}.`
      )
    }

    const enhancementContainer = /^ENHO\/XH(?:B)?$/i.test(object.type)
    let metadata:
      | {
          status: "available"
          implementationCount: number
          elementCount: number
          implementations: Array<{
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
            sourceFingerprint?: string | undefined
            enhancedObject?:
              | {
                  uri: string
                  type: string
                  name: string
                }
              | undefined
          }>
        }
      | {
          status: "not_applicable" | "unsupported" | "forbidden" | "timeout" | "error"
          implementationCount: null
          elementCount: null
          implementations: []
          reason: string
        }
    if (enhancementContainer) {
      metadata = {
        status: "not_applicable",
        implementationCount: null,
        elementCount: null,
        implementations: [],
        reason:
          "ENHO/XH is an enhancement implementation container; its executable methods belong to implementing classes, not this URI's source/main."
      }
    } else
      try {
        const enhancements = await this.backend.readEnhancements(
          connectionId,
          sourceResult.uriUsed,
          input.includeImplementationSource ?? false
        )
        metadata = {
          status: "available",
          implementationCount: new Set(
            enhancements.map(
              (enhancement) =>
                `${enhancement.name}\u0000${enhancement.type}\u0000${enhancement.version}`
            )
          ).size,
          elementCount: enhancements.length,
          implementations: enhancements.map((enhancement) => ({
            name: enhancement.name,
            type: enhancement.type,
            version: enhancement.version,
            elementId: enhancement.elementId,
            fullname: enhancement.fullname,
            mode: enhancement.mode,
            replacing: enhancement.replacing,
            ...(enhancement.startLine === undefined ? {} : { startLine: enhancement.startLine }),
            ...(enhancement.startColumn === undefined
              ? {}
              : { startColumn: enhancement.startColumn }),
            ...(enhancement.uri ? { uri: enhancement.uri } : {}),
            ...(enhancement.positionUri ? { positionUri: enhancement.positionUri } : {}),
            ...(enhancement.source === undefined
              ? {}
              : {
                  source: enhancement.source,
                  sourceFingerprint: createHash("sha256").update(enhancement.source).digest("hex")
                }),
            ...(enhancement.enhancedObject ? { enhancedObject: enhancement.enhancedObject } : {})
          }))
        }
      } catch (error) {
        const failure = classifyEnhancementFailure(error)
        metadata = {
          status: failure.status,
          implementationCount: null,
          elementCount: null,
          implementations: [],
          reason: failure.reason
        }
      }

    return JSON.stringify(
      {
        connectionId,
        object: {
          name: object.name,
          type: object.type,
          package: object.package,
          systemType: object.systemType,
          uri: object.uri,
          sourceUri: sourceResult.uriUsed,
          sourceStatus:
            enhancementContainer && sourceResult.source.length === 0
              ? "not_applicable"
              : "available",
          sourceFingerprint:
            enhancementContainer && sourceResult.source.length === 0
              ? null
              : createHash("sha256").update(sourceResult.source).digest("hex")
        },
        metadata,
        sourceMarkers: enhancementContainer ? [] : enhancementSourceMarkers(sourceResult.source),
        coverage: {
          activeSourceOnly: !enhancementContainer,
          enhancementImplementationContainerRecognized: enhancementContainer,
          activeEnhancementElementsInspected: metadata.status === "available",
          implementationAndElementMetadataPreserved: metadata.status === "available",
          positionCoordinatesZeroBased: true,
          configurationInspected: false,
          newBadiDefinitionInspected: false,
          filterOrSwitchConfigurationInspected: false,
          runtimeInspected: false,
          limitations: [
            ...(enhancementContainer
              ? [
                  "ENHO/XH does not carry the implementing class method bodies in its direct source/main response."
                ]
              : []),
            "ADT enhancement metadata proves active source-code plug-in elements attached to this base source object; it does not prove a New BAdI definition, filter, switch, or runtime execution.",
            "Source markers do not prove that SMOD/CMOD, BTE, validation, or substitution configuration is active.",
            "Implicit enhancement candidate positions are not enumerated by this tool."
          ]
        }
      },
      null,
      2
    )
  }

  async searchEnhancementObjects(input: EnhancementObjectSearchInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const types = [
      ...new Set<EnhancementObjectType>(
        input.types?.length ? input.types : ["ENHC", "ENHS", "ENHO", "BADI", "BADII"]
      )
    ]
    const results = await this.backend.searchObjectTypes(
      connectionId,
      input.pattern,
      types,
      input.maxResultsPerType ?? 20
    )
    return JSON.stringify(
      {
        connectionId,
        pattern: input.pattern,
        results: results.map((result) => ({
          requestedType: result.requestedType,
          repositoryKind: enhancementRepositoryKind(result.requestedType),
          status: result.status,
          count: result.status === "available" ? result.objects.length : null,
          objects: result.objects,
          ...(result.reason ? { reason: result.reason } : {})
        })),
        summary: {
          requestedTypeCount: results.length,
          availableTypeCount: results.filter((result) => result.status === "available").length,
          unavailableTypeCount: results.filter((result) => result.status !== "available").length,
          objectCount: results.reduce((count, result) => count + result.objects.length, 0)
        },
        coverage: {
          repositorySearchOnly: true,
          classicVersusNewBadiDetermined: false,
          activationOrConfigurationInspected: false
        }
      },
      null,
      2
    )
  }

  async searchCustomerExitObjects(input: CustomerExitObjectSearchInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const types = [
      ...new Set<CustomerExitObjectType>(input.types?.length ? input.types : ["SMOD", "CMOD"])
    ]
    const results = await this.backend.searchObjectTypes(
      connectionId,
      input.pattern,
      types,
      input.maxResultsPerType ?? 20
    )
    return JSON.stringify(
      {
        connectionId,
        pattern: input.pattern,
        results: results.map((result) => ({
          requestedType: result.requestedType,
          repositoryKind: customerExitRepositoryKind(result.requestedType),
          status: result.status,
          count: result.status === "available" ? result.objects.length : null,
          objects: result.objects,
          ...(result.reason ? { reason: result.reason } : {})
        })),
        summary: {
          requestedTypeCount: results.length,
          availableTypeCount: results.filter((result) => result.status === "available").length,
          unavailableTypeCount: results.filter((result) => result.status !== "available").length,
          objectCount: results.reduce((count, result) => count + result.objects.length, 0)
        },
        coverage: {
          repositorySearchOnly: true,
          componentsInspected: false,
          projectAssignmentsInspected: false,
          activationStatusInspected: false
        }
      },
      null,
      2
    )
  }

  async readCustomerExitDefinition(input: ReadCustomerExitDefinitionInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const enhancementName = customerExitConfigurationName(input.enhancementName, "enhancementName")
    const result = await this.backend.callSapRepository(connectionId, {
      operation: "READ_CUSTOMER_EXIT_DEFINITION",
      objectName: enhancementName
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    const payload = customerExitConfigurationPayload(result.source)
    const components = payload.components.map((row) => ({
      typeCode: row.TYPE ?? "",
      kind: customerExitComponentKind(row.TYPE ?? ""),
      member: row.MEMBER ?? ""
    }))
    const definition = {
      name: payload.metadata.NAME ?? enhancementName,
      description: payload.metadata.DESCRIPTION ?? "",
      components
    }

    return JSON.stringify(
      {
        connectionId,
        repositoryKind: "customer_exit_definition",
        definition,
        fingerprint: createHash("sha256").update(JSON.stringify(definition)).digest("hex"),
        summary: {
          componentCount: components.length,
          functionExitCount: components.filter((component) => component.kind === "function_exit")
            .length,
          screenExitCount: components.filter((component) => component.kind === "screen_exit")
            .length,
          menuExitCount: components.filter((component) => component.kind === "menu_exit").length,
          unknownComponentCount: components.filter((component) => component.kind === "unknown")
            .length
        },
        coverage: {
          exactDefinitionRead: true,
          componentMembershipInspected: true,
          rawComponentTypePreserved: true,
          cmodProjectAssignmentsInspected: false,
          activationStatusInspected: false,
          customerImplementationsInspected: false,
          runtimeInspected: false
        }
      },
      null,
      2
    )
  }

  async readCustomerExitProject(input: ReadCustomerExitProjectInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const projectName = customerExitConfigurationName(input.projectName, "projectName")
    const result = await this.backend.callSapRepository(connectionId, {
      operation: "READ_CUSTOMER_EXIT_PROJECT",
      objectName: projectName
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    const payload = customerExitConfigurationPayload(result.source)
    const assignments = payload.assignments.map((row) => ({
      enhancementName: row.MEMBER ?? "",
      assignmentType: row.TYPE ?? ""
    }))
    const project = {
      name: payload.metadata.NAME ?? projectName,
      rawStatus: payload.metadata.STATUS ?? "",
      changedBy: payload.metadata.CHANGED_BY ?? "",
      changedOn: payload.metadata.CHANGED_ON ?? "",
      assignments
    }

    return JSON.stringify(
      {
        connectionId,
        repositoryKind: "customer_exit_project",
        packageName: payload.metadata.PACKAGE ?? "",
        project,
        fingerprint: createHash("sha256").update(JSON.stringify(project)).digest("hex"),
        summary: { assignmentCount: assignments.length },
        coverage: {
          exactProjectRead: true,
          enhancementAssignmentsInspected: true,
          rawProjectStatusInspected: true,
          activationStateInterpreted: false,
          componentImplementationsInspected: false,
          runtimeInspected: false
        }
      },
      null,
      2
    )
  }

  async inspectCustomerFunctionExits(input: CustomerFunctionExitInspectionInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const programName = input.programName.trim().toUpperCase()
    const object = await this.findOne(connectionId, programName, "PROG/P")
    if (!object || object.name.toUpperCase() !== programName) {
      throw new Error("Could not find exact ABAP main program: " + programName + ".")
    }

    const sourceGraph = await this.readProgramSourceGraph(connectionId, object)
    const callSites = sourceGraph.units.flatMap((unit) => customerFunctionCallSites(unit))
    const staticCalls = callSites.filter(
      (call): call is CustomerFunctionCallSite & { exitNumber: string } => call.exitNumber !== null
    )
    const dynamicCalls = callSites.filter((call) => call.exitNumber === null)
    const grouped = new Map<string, typeof staticCalls>()
    for (const call of staticCalls) {
      const sites = grouped.get(call.exitNumber) ?? []
      sites.push(call)
      grouped.set(call.exitNumber, sites)
    }

    const functionExits = await Promise.all(
      [...grouped.entries()].map(async ([exitNumber, sites]) => {
        const expectedFunctionModule = `EXIT_${programName}_${exitNumber}`
        if (expectedFunctionModule.length > 30) {
          return {
            exitNumber,
            expectedFunctionModule,
            callSites: sites,
            repositorySearch: {
              status: "error" as const,
              functionFound: null,
              object: null,
              reason:
                "The derived function-module name exceeds the 30-character ABAP function-module limit; resolution was not attempted."
            },
            functionSource: null
          }
        }

        const [search] = await this.backend.searchObjectTypes(
          connectionId,
          expectedFunctionModule,
          ["FUNC"],
          1
        )
        if (!search) {
          return {
            exitNumber,
            expectedFunctionModule,
            callSites: sites,
            repositorySearch: {
              status: "error" as const,
              functionFound: null,
              object: null,
              reason: "The repository search returned no status; absence was not established."
            },
            functionSource: null
          }
        }
        if (search.status !== "available") {
          return {
            exitNumber,
            expectedFunctionModule,
            callSites: sites,
            repositorySearch: {
              status: search.status,
              functionFound: null,
              object: null,
              ...(search.reason ? { reason: search.reason } : {})
            },
            functionSource: null
          }
        }

        const functionObject = search.objects.find(
          (candidate) => candidate.name.toUpperCase() === expectedFunctionModule
        )
        if (!functionObject) {
          return {
            exitNumber,
            expectedFunctionModule,
            callSites: sites,
            repositorySearch: {
              status: "available" as const,
              functionFound: false,
              object: null
            },
            functionSource: null
          }
        }

        try {
          const source = await this.backend.readSource(connectionId, functionObject, {
            version: "active"
          })
          const includes = programIncludeNames(source.source)
          return {
            exitNumber,
            expectedFunctionModule,
            callSites: sites,
            repositorySearch: {
              status: "available" as const,
              functionFound: true,
              object: functionObject
            },
            functionSource: {
              status: "available" as const,
              sourceUri: source.uriUsed,
              sourceFingerprint: createHash("sha256").update(source.source).digest("hex"),
              staticIncludes: includes,
              zxImplementationIncludes: includes.filter((name) => /^ZX[A-Z0-9_/$]*$/i.test(name))
            }
          }
        } catch (error) {
          const failure = classifyRepositoryEvidenceFailure(error, "function source")
          return {
            exitNumber,
            expectedFunctionModule,
            callSites: sites,
            repositorySearch: {
              status: "available" as const,
              functionFound: true,
              object: functionObject
            },
            functionSource: {
              status: failure.status,
              reason: failure.reason,
              staticIncludes: [],
              zxImplementationIncludes: []
            }
          }
        }
      })
    )

    return JSON.stringify(
      {
        connectionId,
        program: {
          name: object.name,
          type: object.type,
          package: object.package,
          systemType: object.systemType,
          uri: object.uri
        },
        sourceGraph: {
          complete: !sourceGraph.failures.length && !sourceGraph.truncated,
          includeLimit: 128,
          maxDepth: 8,
          unitCount: sourceGraph.units.length,
          units: sourceGraph.units.map(({ objectName, objectType, sourceUri, depth, source }) => ({
            objectName,
            objectType,
            sourceUri,
            depth,
            sourceFingerprint: createHash("sha256").update(source).digest("hex")
          })),
          failures: sourceGraph.failures,
          truncated: sourceGraph.truncated
        },
        functionExits,
        unresolvedCalls: dynamicCalls,
        summary: {
          callSiteCount: callSites.length,
          staticCallSiteCount: staticCalls.length,
          unresolvedCallSiteCount: dynamicCalls.length,
          distinctStaticExitCount: functionExits.length,
          functionFoundCount: functionExits.filter(
            (entry) => entry.repositorySearch.functionFound === true
          ).length,
          zxImplementationIncludeCount: functionExits.reduce(
            (count, entry) => count + (entry.functionSource?.zxImplementationIncludes.length ?? 0),
            0
          )
        },
        coverage: {
          activeSourceOnly: true,
          boundedStaticIncludeGraph: true,
          staticFunctionExitCallsInspected: true,
          exactFunctionModuleNamesResolved: true,
          zxImplementationIncludesInspectedWhenReadable: true,
          smodComponentsInspected: false,
          cmodProjectAssignmentsInspected: false,
          activationStatusInspected: false,
          screenExitsInspected: false,
          menuExitsInspected: false,
          runtimeInspected: false
        }
      },
      null,
      2
    )
  }

  async inspectCustomerScreenMenuExits(
    input: CustomerScreenMenuExitInspectionInput
  ): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const programName = input.programName.trim().toUpperCase()
    if (!/^[A-Z0-9_/$]{1,40}$/.test(programName)) {
      throw new Error("Invalid ABAP program name: " + input.programName)
    }
    const screenNumbers = [...new Set(input.screenNumbers ?? [])]
    const screenInspectionStatus = screenNumbers.length ? "requested" : "not_requested"
    const includeMenuExits = input.includeMenuExits ?? true
    if (!screenNumbers.length && !includeMenuExits) {
      throw new Error("At least one screenNumber or includeMenuExits=true is required.")
    }

    const screens = await Promise.all(
      screenNumbers.map(async (screenNumber) => {
        try {
          const result = await this.backend.callSapRepository(connectionId, {
            operation: "READ_SCREEN",
            program: programName,
            screen: screenNumber
          })
          requireRepositorySuccess(result.status, result.code, result.message)
          const screen = screenDefinition(connectionId, programName, screenNumber, result)
          const hooks = customerSubscreenHooks(screen.flowLogic)
          return {
            screenNumber,
            status: "available" as const,
            description: screen.description,
            fingerprint: screen.fingerprint,
            flowLineCount: screen.flowLogic.length,
            hookCount: hooks.length,
            hooks
          }
        } catch (error) {
          const failure = classifyRepositoryEvidenceFailure(error, "screen definition")
          return {
            screenNumber,
            status: failure.status,
            description: null,
            fingerprint: null,
            flowLineCount: null,
            hookCount: null,
            hooks: [],
            reason: failure.reason
          }
        }
      })
    )

    const menu = includeMenuExits
      ? await (async () => {
          try {
            const result = await this.backend.callSapRepository(connectionId, {
              operation: "READ_GUI_DEFINITION",
              program: programName
            })
            requireRepositorySuccess(result.status, result.code, result.message)
            const gui = guiDefinition(connectionId, programName, result)
            const evidence = customerMenuExitEvidence(gui)
            return {
              status: "available" as const,
              versionToken: gui.versionToken,
              fingerprint: gui.fingerprint,
              definitionCount: evidence.definitions.length,
              definitions: evidence.definitions,
              references: evidence.references
            }
          } catch (error) {
            const failure = classifyRepositoryEvidenceFailure(error, "GUI definition")
            return {
              status: failure.status,
              versionToken: null,
              fingerprint: null,
              definitionCount: null,
              definitions: [],
              references: [],
              reason: failure.reason
            }
          }
        })()
      : {
          status: "not_requested" as const,
          versionToken: null,
          fingerprint: null,
          definitionCount: null,
          definitions: [],
          references: []
        }

    return JSON.stringify(
      {
        connectionId,
        programName,
        screens,
        menu,
        summary: {
          screenInspectionStatus,
          requestedScreenCount: screens.length,
          availableScreenCount: screens.filter((screen) => screen.status === "available").length,
          unavailableScreenCount: screens.filter((screen) => screen.status !== "available").length,
          customerSubscreenHookCount: screens.reduce(
            (count, screen) => count + (screen.hookCount ?? 0),
            0
          ),
          menuDefinitionCount: menu.definitionCount
        },
        coverage: {
          activeScreenFlowLogicOnly: true,
          explicitScreenListOnly: true,
          screensInspected: screenNumbers.length > 0,
          screenAbsenceEstablished:
            screenNumbers.length > 0 && screens.every((screen) => screen.status === "available"),
          activeGuiDefinitionOnly: includeMenuExits,
          plusPrefixedMenuFunctionCodesInspected: includeMenuExits,
          smodComponentsInspected: false,
          cmodProjectAssignmentsInspected: false,
          activationStatusInspected: false,
          customerSubscreenImplementationsInspected: false,
          menuTextActivationInspected: false,
          runtimeInspected: false
        }
      },
      null,
      2
    )
  }

  async searchBteDispatchers(input: BteDispatcherSearchInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const kinds = [...new Set<BteKind>(input.kinds?.length ? input.kinds : ["event", "process"])]
    const eventPattern = input.eventPattern ?? "*"
    const results = await Promise.all(
      kinds.map(async (kind) => {
        const suffix = kind === "event" ? "E" : "P"
        const pattern = "OPEN_FI_PERFORM_" + eventPattern + "_" + suffix
        const [result] = await this.backend.searchObjectTypes(
          connectionId,
          pattern,
          ["FUNC"],
          input.maxResultsPerKind ?? 20
        )
        if (!result) {
          return {
            kind,
            pattern,
            status: "error" as const,
            count: null,
            objects: [],
            reason: "The repository search returned no status; absence was not established."
          }
        }
        return {
          kind,
          pattern,
          status: result.status,
          count: result.status === "available" ? result.objects.length : null,
          objects: result.objects.map((object) => {
            const match = /^OPEN_FI_PERFORM_([A-Z0-9_]+)_([EP])$/i.exec(object.name)
            const eventIdentifier = match?.[1]?.toUpperCase() ?? null
            return {
              ...object,
              eventIdentifier,
              eventNumber:
                eventIdentifier && /^\d+$/.test(eventIdentifier) ? eventIdentifier : null,
              exactDispatcherName: match?.[2]?.toUpperCase() === suffix
            }
          }),
          ...(result.reason ? { reason: result.reason } : {})
        }
      })
    )
    return JSON.stringify(
      {
        connectionId,
        eventPattern,
        results,
        summary: {
          requestedKindCount: results.length,
          availableKindCount: results.filter((result) => result.status === "available").length,
          unavailableKindCount: results.filter((result) => result.status !== "available").length,
          objectCount: results.reduce((count, result) => count + result.objects.length, 0),
          exactDispatcherCount: results.reduce(
            (count, result) =>
              count + result.objects.filter((object) => object.exactDispatcherName).length,
            0
          )
        },
        coverage: {
          dispatcherSearchOnly: true,
          productsInspected: false,
          handlerAssignmentsInspected: false,
          runtimeInspected: false
        }
      },
      null,
      2
    )
  }

  async readBteConfiguration(input: ReadBteConfigurationInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const identifier = input.identifier.trim().toUpperCase()
    if (!/^[A-Z0-9_]{1,8}$/.test(identifier)) {
      throw new Error("identifier must be an exact BTE Event or Process identifier.")
    }
    const result = await this.backend.callSapRepository(connectionId, {
      operation: "READ_BTE_CONFIGURATION",
      objectType: input.kind === "event" ? "E" : "P",
      objectName: identifier
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    const payload = bteConfigurationPayload(result.source)
    const sapHandlers = payload.sapHandlers
      .map(bteConfigurationHandler)
      .sort(compareBteConfigurationHandlers)
    const customerHandlers = payload.customerHandlers
      .map(bteConfigurationHandler)
      .sort(compareBteConfigurationHandlers)
    const configuration = {
      kind: input.kind,
      identifier: payload.metadata.IDENTIFIER ?? identifier,
      description: payload.metadata.DESCRIPTION ?? "",
      sapHandlers,
      customerHandlers
    }

    return JSON.stringify(
      {
        connectionId,
        repositoryKind:
          input.kind === "event" ? "bte_event_configuration" : "bte_process_configuration",
        configuration,
        fingerprint: createHash("sha256").update(JSON.stringify(configuration)).digest("hex"),
        summary: {
          sapHandlerCount: sapHandlers.length,
          customerHandlerCount: customerHandlers.length,
          activeSapApplicationHandlerCount: sapHandlers.filter(
            (handler) => handler.applicationActiveRaw === "X"
          ).length,
          activeCustomerProductHandlerCount: customerHandlers.filter(
            (handler) => handler.productActiveRaw === "X"
          ).length
        },
        coverage: {
          exactDefinitionRead: true,
          sapApplicationAssignmentsInspected: true,
          customerProductAssignmentsInspected: true,
          rawActivationFlagsInspected: true,
          handlerFunctionExistenceInspected: false,
          executionOrderInterpreted: false,
          runtimeInspected: false
        }
      },
      null,
      2
    )
  }

  async prepareEnhancementConfigurationWorkflow(
    input: EnhancementConfigurationWorkflowInput
  ): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const targetName = input.targetName.trim().toUpperCase()
    const commonMissing = input.transportNumber ? [] : ["transportNumber"]
    let currentState: Record<string, unknown>
    let requiredInputs: string[]
    let transaction: string
    let workflow: Array<Record<string, unknown>>

    if (input.kind === "cmod_project") {
      const projectName = customerExitConfigurationName(targetName, "targetName")
      const enhancementNames = [
        ...new Set(
          (input.enhancementNames ?? []).map((name) =>
            customerExitConfigurationName(name, "enhancementNames")
          )
        )
      ]
      const project = await controlledWorkflowRead(() =>
        this.readCustomerExitProject({ projectName, connectionId })
      )
      const definitions = await Promise.all(
        enhancementNames.map(async (enhancementName) => ({
          enhancementName,
          ...(await controlledWorkflowRead(() =>
            this.readCustomerExitDefinition({ enhancementName, connectionId })
          ))
        }))
      )
      currentState = { project, definitions }
      requiredInputs = [
        ...commonMissing,
        ...(input.desiredState === "create_or_update" && !enhancementNames.length
          ? ["enhancementNames"]
          : []),
        ...(project.status === "absent" && !input.packageName ? ["packageName"] : [])
      ]
      transaction = "CMOD"
      workflow = cmodConfigurationWorkflow(
        projectName,
        input.desiredState,
        enhancementNames,
        input.packageName,
        input.transportNumber
      )
    } else if (input.kind === "fibf_event" || input.kind === "fibf_process") {
      if (!/^[A-Z0-9_]{1,8}$/.test(targetName)) {
        throw new Error("targetName must be an exact BTE Event or Process identifier.")
      }
      const kind: BteKind = input.kind === "fibf_event" ? "event" : "process"
      const configuration = await controlledWorkflowRead(() =>
        this.readBteConfiguration({ kind, identifier: targetName, connectionId })
      )
      currentState = { configuration }
      requiredInputs = [
        ...commonMissing,
        ...(!input.productName ? ["productName"] : []),
        ...(!input.functionModule ? ["functionModule"] : [])
      ]
      transaction = "FIBF"
      workflow = fibfConfigurationWorkflow(
        kind,
        targetName,
        input.desiredState,
        input.productName?.trim().toUpperCase(),
        input.functionModule?.trim().toUpperCase(),
        input.applicationIndicator?.trim().toUpperCase(),
        input.country?.trim().toUpperCase(),
        input.transportNumber
      )
    } else {
      if (!/^[A-Z0-9_/$-]{1,40}$/.test(targetName)) {
        throw new Error("targetName must be an exact FI rule name.")
      }
      const exitProgram = input.exitProgram?.trim().toUpperCase()
      const exitEvidence = exitProgram
        ? await controlledWorkflowRead(() =>
            this.inspectFicoRuleExitProgram({ programName: exitProgram, connectionId })
          )
        : { status: "not_requested" as const }
      currentState = {
        ruleConfiguration: {
          status: "manual_read_required",
          reason:
            "The current GGB0/GGB1 rule and OB28/OBBH activation are not exposed by an approved headless maintenance API."
        },
        exitProgram: exitEvidence
      }
      requiredInputs = [
        ...commonMissing,
        ...(!input.applicationArea ? ["applicationArea"] : []),
        ...(!input.callupPoint ? ["callupPoint"] : []),
        ...(!input.organizationalUnit ? ["organizationalUnit"] : [])
      ]
      transaction = input.kind === "fi_validation" ? "GGB0 / OB28" : "GGB1 / OBBH"
      workflow = ficoRuleConfigurationWorkflow(
        input.kind,
        targetName,
        input.desiredState,
        input.applicationArea,
        input.callupPoint,
        input.organizationalUnit,
        exitProgram,
        input.transportNumber
      )
    }

    return JSON.stringify(
      {
        connectionId,
        kind: input.kind,
        targetName,
        desiredState: input.desiredState,
        executionMode: "controlled_manual_workflow",
        transaction,
        readiness: requiredInputs.length ? "requires_input" : "ready_for_human_execution",
        missingInputs: requiredInputs,
        standardApiAssessment: {
          approvedHeadlessWriteApi: false,
          decision: "manual_workflow_required",
          reason:
            "No complete, release-stable, screen-independent standard API has been approved for this configuration lifecycle. Partial or transaction-internal SAP functions are not treated as safe maintenance APIs."
        },
        currentState,
        workflow,
        controls: {
          sapWritePerformed: false,
          guiOpened: false,
          savePerformed: false,
          activationPerformed: false,
          generationPerformed: false,
          transportReleased: false,
          humanConfirmationRequiredBeforeSave: true,
          humanConfirmationRequiredBeforeActivationOrDeletion: true,
          stopConditions: [
            "The current SAP state differs from the preflight evidence.",
            "The requested package, Customizing request, or Workbench request is missing or not modifiable.",
            "SAP proposes direct standard-object modification, direct table maintenance, or an unexpected object scope.",
            "Authorization, lock, generation, syntax, or consistency checks report an error.",
            "The target is shared and the requested deactivation or deletion would affect unrelated assignments."
          ]
        },
        coverage: {
          preflightReadsAttempted: true,
          configurationMutationAutomated: false,
          manualTransactionExecutionRequired: true,
          postChangeReadbackRequired: true,
          runtimeAcceptanceRequired: true
        }
      },
      null,
      2
    )
  }

  async searchBadiObjects(input: BadiObjectSearchInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const types = [
      ...new Set<BadiRepositoryType>(
        input.types?.length ? input.types : ["SXSD/XD", "SXCI/XI", "ENHS/XS", "ENHO/XHB"]
      )
    ]
    const results = await this.backend.searchObjectTypes(
      connectionId,
      input.pattern,
      types,
      input.maxResultsPerType ?? 20
    )
    return JSON.stringify(
      {
        connectionId,
        pattern: input.pattern,
        results: results.map((result) => ({
          requestedType: result.requestedType,
          repositoryKind: badiRepositoryKind(result.requestedType),
          status: result.status,
          count: result.status === "available" ? result.objects.length : null,
          objects: result.objects,
          ...(result.reason ? { reason: result.reason } : {})
        })),
        summary: {
          requestedTypeCount: results.length,
          availableTypeCount: results.filter((result) => result.status === "available").length,
          unavailableTypeCount: results.filter((result) => result.status !== "available").length,
          objectCount: results.reduce((count, result) => count + result.objects.length, 0)
        },
        coverage: {
          exactRepositorySubtypes: true,
          classicDefinitionAndImplementationSeparated: true,
          newBadiDefinitionInspected: false,
          interfacesInspected: false,
          filtersOrMultipleUseInspected: false,
          switchesOrActivationInspected: false,
          runtimeInspected: false
        }
      },
      null,
      2
    )
  }

  async readClassicBadiDefinition(input: ReadClassicBadiDefinitionInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const definitionName = classicBadiDefinitionName(input.definitionName)
    const result = await this.backend.callSapRepository(connectionId, {
      operation: "READ_CLASSIC_BADI_DEFINITION",
      objectName: definitionName
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    const payload = classicBadiDefinitionPayload(result.source)
    const interfaces = payload.interfaces
      .map((row) => row.INTERFACE_NAME ?? "")
      .filter(Boolean)
      .sort()
    const implementationAssignments = payload.assignments
      .map((row) => ({
        implementationName: row.IMPLEMENTATION_NAME ?? "",
        filterValue: row.FILTER_VALUE ?? "",
        activeRaw: row.ACTIVE ?? "",
        active: row.ACTIVE === "X",
        description: row.DESCRIPTION ?? "",
        version: row.VERSION ?? "",
        masterLanguage: row.MASTER_LANGUAGE ?? "",
        layer: row.LAYER ?? "",
        packageName: row.PACKAGE ?? "",
        migrationEnhancement: row.MIGRATION_ENHANCEMENT ?? ""
      }))
      .sort(compareByJson)
    const classMappings = payload.classMappings
      .map((row) => ({
        implementationName: row.IMPLEMENTATION_NAME ?? "",
        interfaceName: row.INTERFACE_NAME ?? "",
        implementationClass: row.IMPLEMENTATION_CLASS ?? ""
      }))
      .sort(compareByJson)
    const definition = {
      name: payload.metadata.NAME ?? definitionName,
      description: payload.metadata.DESCRIPTION ?? "",
      version: payload.metadata.VERSION ?? "",
      filterType: payload.metadata.FILTER_TYPE ?? "",
      filterExtensionRaw: payload.metadata.FILTER_EXTENSION ?? "",
      filterDependent: Boolean(payload.metadata.FILTER_TYPE),
      multipleUseRaw: payload.metadata.MULTIPLE_USE ?? "",
      multipleUse: payload.metadata.MULTIPLE_USE === "X",
      packageName: payload.metadata.PACKAGE ?? "",
      masterLanguage: payload.metadata.MASTER_LANGUAGE ?? "",
      defaultClass: payload.metadata.DEFAULT_CLASS ?? "",
      exampleClass: payload.metadata.EXAMPLE_CLASS ?? "",
      checkClass: payload.metadata.CHECK_CLASS ?? "",
      internalRaw: payload.metadata.INTERNAL ?? "",
      migrationEnhancementSpot: payload.metadata.MIGRATION_ENHANCEMENT_SPOT ?? "",
      migrationBadiName: payload.metadata.MIGRATION_BADI_NAME ?? "",
      interfaces,
      implementationAssignments,
      classMappings
    }
    const activeImplementations = new Set(
      implementationAssignments
        .filter((assignment) => assignment.active)
        .map((assignment) => assignment.implementationName)
    )

    return JSON.stringify(
      {
        connectionId,
        repositoryKind: "classic_badi_definition",
        definition,
        fingerprint: createHash("sha256").update(JSON.stringify(definition)).digest("hex"),
        summary: {
          interfaceCount: interfaces.length,
          implementationAssignmentCount: implementationAssignments.length,
          distinctImplementationCount: new Set(
            implementationAssignments.map((assignment) => assignment.implementationName)
          ).size,
          activeImplementationCount: activeImplementations.size,
          classMappingCount: classMappings.length
        },
        coverage: {
          exactClassicDefinitionRead: true,
          interfacesInspected: true,
          filterAndMultipleUseAttributesInspected: true,
          implementationAssignmentsInspected: true,
          implementationClassesInspected: true,
          rawActivationFlagsInspected: true,
          newBadiInspected: false,
          switchesInspected: false,
          runtimeInspected: false
        }
      },
      null,
      2
    )
  }

  async manageClassicBadiImplementation(
    input: ManageClassicBadiImplementationInput
  ): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const implementationName = customerEnhancementName(
      input.implementationName,
      "implementationName",
      20
    )
    const definitionName = classicBadiDefinitionName(input.definitionName)
    const implementationClass = input.implementationClass
      ? customerEnhancementName(input.implementationClass, "implementationClass", 30)
      : undefined
    const interfaceName = input.interfaceName
      ? repositoryComponentName(input.interfaceName, "interfaceName", 30)
      : undefined
    if (input.action === "create" && (!implementationClass || !interfaceName)) {
      throw new Error("create requires definitionName, interfaceName, and implementationClass")
    }
    if (input.action === "create" && input.expectedFingerprint) {
      throw new Error("create does not accept expectedFingerprint")
    }
    if (
      input.action !== "create" &&
      (implementationClass || interfaceName || input.methods?.length || input.filters?.length)
    ) {
      throw new Error(`${input.action} does not accept create-only implementation fields`)
    }
    let previousFingerprint: string | undefined
    const definition = JSON.parse(
      await this.readClassicBadiDefinition({ definitionName, connectionId })
    ) as Record<string, unknown>
    const snapshot = classicBadiImplementationSnapshot(definition, implementationName)
    if (input.action === "create" && snapshot) {
      throw new Error("CLASSIC_BADI_IMPLEMENTATION_ALREADY_EXISTS")
    }
    if (input.action !== "create" && !snapshot) {
      throw new Error("CLASSIC_BADI_IMPLEMENTATION_NOT_FOUND")
    }
    previousFingerprint = snapshot ? stableFingerprint(snapshot) : undefined
    if (
      input.action !== "create" &&
      input.expectedFingerprint?.toLowerCase() !== previousFingerprint
    ) {
      throw new Error("CLASSIC_BADI_IMPLEMENTATION_STALE_FINGERPRINT")
    }
    const source = enhancementPayload({
      ACTION: input.action.toUpperCase(),
      DEFINITION_NAME: definitionName,
      INTERFACE_NAME: interfaceName ?? "",
      IMPLEMENTATION_CLASS: implementationClass ?? ""
    })
    appendEnhancementRows(source, "F", input.filters ?? [])
    ;(input.methods ?? []).forEach((method, methodIndex) => {
      appendEnhancementPayload(source, "N", methodIndex + 1, "METHOD_NAME", method.methodName)
      method.source.forEach((line, lineIndex) =>
        appendEnhancementPayload(source, "S", methodIndex + 1, String(lineIndex + 1), line)
      )
    })
    const result = await this.backend.callSapRepository(connectionId, {
      operation: "MANAGE_CLASSIC_BADI_IMPL",
      objectName: implementationName,
      objectType: input.action.toUpperCase(),
      packageName: input.packageName.toUpperCase(),
      transportNumber: transportNumber(input.transportNumber),
      expectedVersion: input.expectedFingerprint,
      source
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    const readbackDefinition = JSON.parse(
      await this.readClassicBadiDefinition({ definitionName, connectionId })
    ) as Record<string, unknown>
    const readback = classicBadiImplementationSnapshot(readbackDefinition, implementationName)
    if (input.action === "delete" && readback) {
      throw new Error("SAP reported success but the Classic BAdI implementation still exists")
    }
    if (input.action !== "delete" && !readback) {
      throw new Error("SAP reported success but the Classic BAdI implementation was not read back")
    }
    return JSON.stringify(
      {
        status: result.code,
        connectionId,
        action: input.action,
        implementationName,
        definitionName,
        previousFingerprint: previousFingerprint ?? null,
        fingerprint: readback ? stableFingerprint(readback) : null,
        implementation: readback ?? null,
        transportNumber: input.transportNumber.toUpperCase()
      },
      null,
      2
    )
  }

  async readEnhancementImplementation(input: ReadEnhancementImplementationInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const enhancementName = customerEnhancementName(input.enhancementName, "enhancementName")
    const result = await this.backend.callSapRepository(connectionId, {
      operation: "READ_ENHANCEMENT_IMPL",
      objectName: enhancementName
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    return JSON.stringify(enhancementImplementationResult(connectionId, result.source), null, 2)
  }

  async createEnhancementHookImplementation(input: CreateEnhancementHookInput): Promise<string> {
    return this.createEnhancementImplementation(input, "CREATE_HOOK_ENHANCEMENT")
  }

  async createNewBadiImplementation(input: CreateNewBadiImplementationInput): Promise<string> {
    return this.createEnhancementImplementation(input, "CREATE_BADI_ENHANCEMENT")
  }

  async updateEnhancementHookImplementation(input: UpdateEnhancementHookInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const enhancementName = customerEnhancementName(input.enhancementName, "enhancementName")
    const current = JSON.parse(
      await this.readEnhancementImplementation({ enhancementName, connectionId })
    ) as Record<string, unknown>
    assertEnhancementWriteSnapshot(current, input.expectedFingerprint, input.packageName)
    const definition = current.definition as Record<string, unknown>
    if (definition.tool !== "HOOK_IMPL") throw new Error("ENHANCEMENT_TOOL_TYPE_MISMATCH")
    if (definition.hasInactiveVersion === true) {
      throw new Error("ENHANCEMENT_INACTIVE_VERSION_EXISTS")
    }
    const hooks = definition.hookImplementations as Array<Record<string, unknown>>
    if (!hooks.some((hook) => hook.extId === input.extId)) {
      throw new Error("ENHANCEMENT_HOOK_NOT_FOUND")
    }
    const source = hookEnhancementUpdatePayload(input)
    const result = await this.backend.callSapRepository(connectionId, {
      operation: "UPDATE_HOOK_ENHANCEMENT",
      objectName: enhancementName,
      description: input.description,
      packageName: input.packageName.toUpperCase(),
      transportNumber: transportNumber(input.transportNumber),
      expectedVersion: input.expectedFingerprint.toLowerCase(),
      source
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    const saved = JSON.parse(
      await this.readEnhancementImplementation({ enhancementName, connectionId })
    ) as Record<string, unknown>
    const savedDefinition = saved.definition as Record<string, unknown>
    const savedHooks = savedDefinition.hookImplementations as Array<Record<string, unknown>>
    const savedHook = savedHooks.find((hook) => hook.extId === input.extId)
    if (!savedHook || !isDeepStrictEqual(savedHook.source, input.source)) {
      throw new Error("SAP reported success but the hook source was not read back")
    }
    if (input.description && savedDefinition.shortText !== input.description) {
      throw new Error("SAP reported success but the enhancement text was not read back")
    }
    return JSON.stringify(
      {
        status: result.code,
        previousFingerprint: current.fingerprint,
        ...saved,
        transportNumber: input.transportNumber.toUpperCase()
      },
      null,
      2
    )
  }

  async updateNewBadiImplementation(input: UpdateNewBadiImplementationInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const enhancementName = customerEnhancementName(input.enhancementName, "enhancementName")
    const implementationName = customerEnhancementName(
      input.implementationName,
      "implementationName"
    )
    const implementationClass = customerEnhancementName(
      input.implementationClass,
      "implementationClass",
      30
    )
    const current = JSON.parse(
      await this.readEnhancementImplementation({ enhancementName, connectionId })
    ) as Record<string, unknown>
    assertEnhancementWriteSnapshot(current, input.expectedFingerprint, input.packageName)
    const definition = current.definition as Record<string, unknown>
    if (definition.tool !== "BADI_IMPL") throw new Error("ENHANCEMENT_TOOL_TYPE_MISMATCH")
    if (definition.hasInactiveVersion === true) {
      throw new Error("ENHANCEMENT_INACTIVE_VERSION_EXISTS")
    }
    const implementations = definition.badiImplementations as Array<Record<string, unknown>>
    if (!implementations.some((item) => item.implementationName === implementationName)) {
      throw new Error("NEW_BADI_IMPLEMENTATION_NOT_FOUND")
    }
    const source = newBadiEnhancementUpdatePayload(input, implementationName, implementationClass)
    const result = await this.backend.callSapRepository(connectionId, {
      operation: "UPDATE_BADI_ENHANCEMENT",
      objectName: enhancementName,
      description: input.description,
      packageName: input.packageName.toUpperCase(),
      transportNumber: transportNumber(input.transportNumber),
      expectedVersion: input.expectedFingerprint.toLowerCase(),
      source
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    const saved = JSON.parse(
      await this.readEnhancementImplementation({ enhancementName, connectionId })
    ) as Record<string, unknown>
    const savedDefinition = saved.definition as Record<string, unknown>
    const savedImplementations = savedDefinition.badiImplementations as Array<
      Record<string, unknown>
    >
    const savedImplementation = savedImplementations.find(
      (item) => item.implementationName === implementationName
    )
    if (
      !savedImplementation ||
      savedImplementation.implementationClass !== implementationClass ||
      savedImplementation.active !== input.active ||
      savedImplementation.defaultImplementation !== input.defaultImplementation ||
      !isDeepStrictEqual(
        savedImplementation.filters,
        normalizedEnhancementFilters(input.filters)
      ) ||
      (input.description && savedImplementation.shortText !== input.description)
    ) {
      throw new Error("SAP reported success but the New BAdI update was not read back")
    }
    return JSON.stringify(
      {
        status: result.code,
        previousFingerprint: current.fingerprint,
        ...saved,
        transportNumber: input.transportNumber.toUpperCase()
      },
      null,
      2
    )
  }

  async manageEnhancementImplementationState(
    input: ManageEnhancementImplementationStateInput
  ): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const enhancementName = customerEnhancementName(input.enhancementName, "enhancementName")
    const current = JSON.parse(
      await this.readEnhancementImplementation({ enhancementName, connectionId })
    ) as Record<string, unknown>
    assertEnhancementWriteSnapshot(current, input.expectedFingerprint, input.packageName)
    const currentDefinition = current.definition as Record<string, unknown>
    if (input.action === "discard_inactive" && currentDefinition.hasInactiveVersion !== true) {
      throw new Error("ENHANCEMENT_NO_INACTIVE_VERSION")
    }
    const result = await this.backend.callSapRepository(connectionId, {
      operation: "MANAGE_ENHANCEMENT_STATE",
      objectName: enhancementName,
      objectType: input.action === "activate" ? "ACTIVATE" : "DISCARD_INACTIVE",
      packageName: input.packageName.toUpperCase(),
      transportNumber: transportNumber(input.transportNumber),
      expectedVersion: input.expectedFingerprint.toLowerCase()
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    const saved = JSON.parse(
      await this.readEnhancementImplementation({ enhancementName, connectionId })
    ) as Record<string, unknown>
    const savedDefinition = saved.definition as Record<string, unknown>
    if (savedDefinition.hasInactiveVersion === true) {
      throw new Error("SAP reported success but the inactive enhancement version remains")
    }
    if (input.action === "activate" && savedDefinition.active !== true) {
      throw new Error("SAP reported success but the enhancement is not active")
    }
    return JSON.stringify(
      {
        status: result.code,
        action: input.action,
        previousFingerprint: current.fingerprint,
        ...saved,
        transportNumber: input.transportNumber.toUpperCase()
      },
      null,
      2
    )
  }

  async deleteEnhancementImplementation(
    input: DeleteEnhancementImplementationInput
  ): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const enhancementName = customerEnhancementName(input.enhancementName, "enhancementName")
    const current = JSON.parse(
      await this.readEnhancementImplementation({ enhancementName, connectionId })
    ) as { fingerprint: string; packageName: string }
    if (current.fingerprint !== input.expectedFingerprint.toLowerCase()) {
      throw new Error("ENHANCEMENT_IMPLEMENTATION_STALE_FINGERPRINT")
    }
    if (current.packageName.toUpperCase() !== input.packageName.toUpperCase()) {
      throw new Error("ENHANCEMENT_IMPLEMENTATION_PACKAGE_MISMATCH")
    }
    const result = await this.backend.callSapRepository(connectionId, {
      operation: "DELETE_ENHANCEMENT_IMPL",
      objectName: enhancementName,
      packageName: input.packageName.toUpperCase(),
      transportNumber: transportNumber(input.transportNumber),
      expectedVersion: input.expectedFingerprint.toLowerCase()
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    try {
      await this.readEnhancementImplementation({ enhancementName, connectionId })
      throw new Error("SAP reported success but the enhancement implementation still exists")
    } catch (error) {
      if (!/ENHANCEMENT_IMPLEMENTATION_NOT_FOUND/.test(String(error))) throw error
    }
    return JSON.stringify(
      {
        status: "ENHANCEMENT_IMPLEMENTATION_DELETED",
        connectionId,
        enhancementName,
        previousFingerprint: current.fingerprint,
        transportNumber: input.transportNumber.toUpperCase()
      },
      null,
      2
    )
  }

  private async createEnhancementImplementation(
    input: CreateEnhancementHookInput | CreateNewBadiImplementationInput,
    operation: "CREATE_HOOK_ENHANCEMENT" | "CREATE_BADI_ENHANCEMENT"
  ): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const enhancementName = customerEnhancementName(input.enhancementName, "enhancementName")
    try {
      await this.readEnhancementImplementation({ enhancementName, connectionId })
      throw new Error("ENHANCEMENT_IMPLEMENTATION_ALREADY_EXISTS")
    } catch (error) {
      if (!/ENHANCEMENT_IMPLEMENTATION_NOT_FOUND/.test(String(error))) throw error
    }
    const source =
      operation === "CREATE_HOOK_ENHANCEMENT"
        ? hookEnhancementPayload(input as CreateEnhancementHookInput)
        : newBadiEnhancementPayload(input as CreateNewBadiImplementationInput)
    const result = await this.backend.callSapRepository(connectionId, {
      operation,
      objectName: enhancementName,
      description: input.description,
      packageName: input.packageName.toUpperCase(),
      transportNumber: transportNumber(input.transportNumber),
      source
    })
    requireRepositorySuccess(result.status, result.code, result.message)
    const saved = JSON.parse(
      await this.readEnhancementImplementation({ enhancementName, connectionId })
    ) as Record<string, unknown>
    return JSON.stringify(
      {
        status: result.code,
        ...saved,
        transportNumber: input.transportNumber.toUpperCase()
      },
      null,
      2
    )
  }

  async inspectEnhancementFramework(input: EnhancementFrameworkInspectionInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const object = await this.findOne(connectionId, input.objectName, input.objectType)
    if (!object) {
      throw new Error(
        `Could not find ABAP source object: ${input.objectName}${input.objectType ? ` (${input.objectType})` : ""}.`
      )
    }
    const sourceResult = await this.backend.readSource(connectionId, object, { version: "active" })
    if (sourceResult.kind === "dictionary") {
      throw new Error(
        `Enhancement Framework inspection does not support Dictionary object ${object.name}.`
      )
    }
    const inspection = inspectEnhancementFrameworkSource(sourceResult.source)
    return JSON.stringify(
      {
        connectionId,
        object: {
          name: object.name,
          type: object.type,
          package: object.package,
          systemType: object.systemType,
          uri: object.uri,
          sourceUri: sourceResult.uriUsed,
          sourceFingerprint: createHash("sha256").update(sourceResult.source).digest("hex")
        },
        ...inspection,
        coverage: {
          activeSourceOnly: true,
          implicitCandidatesAreSourceDerived: true,
          sapEnhancementEditorConfirmationRequired: true,
          activationOrConfigurationInspected: false,
          switchStateInspected: false,
          runtimeInspected: false,
          standardRefactoringMayInvalidateCandidates: true
        }
      },
      null,
      2
    )
  }

  async inspectFicoRuleExitProgram(input: FicoRuleExitProgramInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const object = await this.findOne(connectionId, input.programName, "PROG")
    if (!object || object.name.toUpperCase() !== input.programName.toUpperCase()) {
      throw new Error("Could not find exact ABAP program: " + input.programName + ".")
    }
    const sourceResult = await this.backend.readSource(connectionId, object, { version: "active" })
    if (sourceResult.kind === "dictionary") {
      throw new Error("FI rule exit inspection requires an ABAP program: " + object.name + ".")
    }
    return JSON.stringify(
      {
        connectionId,
        program: {
          name: object.name,
          type: object.type,
          package: object.package,
          systemType: object.systemType,
          uri: object.uri,
          sourceUri: sourceResult.uriUsed,
          sourceFingerprint: createHash("sha256").update(sourceResult.source).digest("hex")
        },
        ...inspectFicoRuleExitSource(sourceResult.source),
        coverage: {
          activeSourceOnly: true,
          exitCatalogInspected: true,
          formImplementationsInspected: true,
          ggb0ValidationRulesInspected: false,
          ggb1SubstitutionRulesInspected: false,
          ob28ActivationInspected: false,
          obbhActivationInspected: false,
          callupPointsOrPrerequisitesInspected: false,
          runtimeInspected: false
        }
      },
      null,
      2
    )
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
    let enhancementUnavailable = 0
    for (const object of objects) {
      try {
        const { source, uriUsed, kind } = await this.backend.readSource(connectionId, object)
        const matches = findLineMatches(source.split("\n"), input.searchTerm, !!input.isRegexp)
        let matchingEnhancements: Array<{ enhancement: EnhancementInfo; match: LineMatch }> = []
        let enhancementFailure: ReturnType<typeof classifyEnhancementFailure> | undefined
        try {
          const enhancements = await this.backend.readEnhancements(connectionId, uriUsed, true)
          matchingEnhancements = enhancements.flatMap((enhancement) => {
            if (!enhancement.source) return []
            return findLineMatches(
              enhancement.source.split("\n"),
              input.searchTerm,
              !!input.isRegexp
            ).map((match) => ({ enhancement, match }))
          })
        } catch (error) {
          enhancementFailure = classifyEnhancementFailure(error)
          enhancementUnavailable++
        }
        if (!matches.length && !matchingEnhancements.length && !enhancementFailure) continue

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
        if (enhancementFailure) {
          output += `Enhancement Metadata: Unavailable (${enhancementFailure.status})\n\n`
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
      if (enhancementUnavailable) {
        message = `No base-source matches for "${input.searchTerm}". Enhancement metadata was unavailable for ${enhancementUnavailable} object(s).`
      }
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
    const exactMatches = results.filter((object) => {
      const actualType = object.type.toUpperCase()
      const requestedTypeMatches =
        actualType === requestedType ||
        (!requestedType.includes("/") && actualType.startsWith(`${requestedType}/`))
      return (
        object.name.toUpperCase() === input.objectName.toUpperCase() &&
        (functionModule
          ? new Set(["FUGR/FF", "FUNC/FM", "FUNC"]).has(actualType)
          : functionGroupInclude
            ? actualType === requestedType ||
              actualType === "PROG" ||
              /^\/sap\/bc\/adt\/functions\/groups\/[^/]+\/fmodules\//i.test(object.uri)
            : requestedTypeMatches)
      )
    })
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
      // ADT search returns a repository-navigation URL for DDIC objects, which cannot serve an ADT
      // structure document; use the canonical resource path for those.
      const versionHistoryUri = structureUriFor(object.type, input.objectName, object.uri)
      const revisions = await this.backend.revisions(connectionId, versionHistoryUri)
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
      // An ADT structure document that carries no root element is a read that did not happen, not a
      // server failure: the 18:07 incident was reported as "HTTP 500" and left the caller unable to
      // tell "no versions" from "unavailable", one step before the pre-write checks it still owed.
      // Return a structured state that says which it is, and what to use instead.
      if (error instanceof VersionHistoryUnavailableError) {
        return JSON.stringify(
          {
            connectionId,
            objectName: input.objectName,
            objectType: object.type,
            objectUri: error.detail.objectUri,
            status: "unavailable",
            code: error.code,
            versionHistoryAvailable: false,
            reason:
              "ADT served no usable object structure document for this object, so the version list could not be resolved. This is not evidence that the object has no versions.",
            adt: {
              httpStatus: error.detail.httpStatus ?? null,
              contentType: error.detail.contentType ?? null,
              bodyLength: error.detail.bodyLength ?? null,
              bodyHead: error.detail.bodyHead ?? null
            },
            possibleCause: unsupportedEndpointCause(error),
            substitutes: [
              "read_ddic_transparent_table for the stored inactive definition and its fingerprint",
              "read_abap_table(DD02L/DD03L/TADIR/E071) for object state, ownership and transport membership",
              "read_ddic_table_conversion_status for the native TBATG worklist"
            ],
            automaticRetry: false,
            cause: error.detail.cause
          },
          null,
          2
        )
      }
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
      input.expectedSourceFingerprint,
      input.recoverInactiveSource
    )
    if (!result.activation.success) {
      throw new Error(
        `Source was saved to SAP but activation failed or could not be verified for ${result.objectName}. ` +
          `Do not repeat the same replacement. If the activation message identifies a source error, repair the reviewed draft with recoverInactiveSource=true and its inactiveFingerprint as expectedSourceFingerprint. ` +
          `For other activation failures, reconcile active/inactive source before using abap_activate on the approved object. ` +
          `${formatActivationFailure(result.activation.messages, result.activation.inactiveObjects)}\n` +
          JSON.stringify({
            saveSucceeded: result.saveSucceeded ?? true,
            unlockSucceeded: result.unlockSucceeded ?? true,
            activationAttempted: result.activationAttempted ?? null,
            activationSucceeded: result.activationSucceeded ?? false,
            intendedFingerprint: result.sourceFingerprintAfter ?? null,
            activeFingerprint: result.activeFingerprint ?? null,
            inactiveFingerprint: result.inactiveFingerprint ?? null,
            readbackError: result.readbackError ?? null,
            automaticRetry: false,
            automaticRollback: false
          })
      )
    }
    return (
      `Successfully ${input.recoverInactiveSource ? "repaired inactive source by replacing" : "replaced"} ${result.oldLineCount} line(s) with ${result.newLineCount} line(s) in ${result.fileUri}.\n` +
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
    // A source object may live in $TMP. Reusing the Dynpro package rule here refused every local
    // program, include, class and interface outright, so the local case is allowed and needs no
    // transport entry; every other package keeps the previous transport requirement.
    const expectedPackage = deletableSourcePackage(input.packageName)
    const transport = expectedPackage === "$TMP" ? "" : transportNumber(input.transportNumber)
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
              connectionId: CUSTOMER_CONNECTION_ID,
              objectName: CONFIGURATION_TABLE
            })
          ),
        async (query) => JSON.parse(await this.readAbapTable(query)),
        async (query) => JSON.parse(await this.readAbapTable(query)),
        async () =>
          JSON.parse(
            await this.readDdicDomain({
              connectionId: CUSTOMER_CONNECTION_ID,
              objectName: CONFIGURATION_MODE_DOMAIN
            })
          )
      ),
      null,
      2
    )
  }

  async readAbapTable(input: unknown, nativeFailure?: Error): Promise<string> {
    const parsed = tableQuerySchema.safeParse(input)
    if (parsed.success && parsed.data.tableName === "SXCI") {
      return this.readClassicBadiTableProjection(parsed.data)
    }
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

  /**
   * Read one allowlisted CTS table for the transport-list fallback through the reviewed table-query
   * path, which compensates for the native ADT data preview that answers HTML on this system.
   *
   * A failed read throws. `readAbapTable` reports failures as `status: "unavailable"` with
   * `data: null`, and returning that as an empty row set would report "this user has no transport
   * requests" for a read that never happened - the same substitution the transport fallback exists
   * to prevent.
   */
  async readTransportTableRows(
    connectionId: string,
    tableName: string,
    columns: string[],
    filters: { column: string; operator: "EQ" | "NE" | "LT" | "LE" | "GT" | "GE"; value: string }[],
    maxRows: number
  ): Promise<Record<string, string>[]> {
    const result = JSON.parse(
      await this.readAbapTable({ connectionId, tableName, columns, filters, maxRows })
    ) as { status?: string; code?: string; stage?: string; data?: unknown }
    if (result.status !== "ok" || !Array.isArray(result.data))
      throw new Error(
        `TRANSPORT_LIST_TABLE_READ_FAILED: ${result.code ?? "unknown"}; stage=${result.stage ?? "unknown"}`
      )
    return result.data as Record<string, string>[]
  }

  private async readClassicBadiTableProjection(input: TableQueryInput): Promise<string> {
    const connectionId = input.connectionId.toLowerCase()
    const allFields = input.columns.length === 1 && input.columns[0] === "*"
    const columns = allFields ? [...classicBadiProjectionColumns] : input.columns
    let stage = "repository_projection_validation"
    const base = {
      connectionId,
      tableName: input.tableName,
      columns,
      maxRows: input.maxRows,
      readOnly: true,
      order: "unspecified",
      clientHandling: "sap_session_default",
      snapshot: false,
      method: "classic_badi_repository_helper",
      definitionSource: "classic_badi_repository_projection",
      tableClassVerified: false,
      compatibilityProjection: true,
      projectionSourceTool: "read_classic_badi_definition"
    }
    const fail = (code: string) =>
      JSON.stringify(
        {
          ...base,
          status: "unavailable",
          stage,
          code,
          returnedCount: 0,
          truncated: null,
          data: null
        },
        null,
        2
      )

    if (
      input.columns.includes("*") !== allFields ||
      new Set(columns).size !== columns.length ||
      [...columns, ...input.filters.map((filter) => filter.column)].some(
        (name) =>
          !classicBadiProjectionColumns.includes(
            name as (typeof classicBadiProjectionColumns)[number]
          )
      )
    ) {
      return fail("TABLE_QUERY_FIELD_INVALID")
    }

    const exactDefinitionFilters = input.filters.filter(
      (filter) => filter.column === "EXIT_NAME" && filter.operator === "EQ"
    )
    if (exactDefinitionFilters.length > 1) return fail("TABLE_QUERY_FILTER_INVALID")

    let definitions: string[]
    let discoveryMayBeTruncated = false
    if (exactDefinitionFilters.length === 1) {
      definitions = [exactDefinitionFilters[0]!.value.toUpperCase()]
    } else {
      stage = "repository_definition_search"
      try {
        const [result] = await this.backend.searchObjectTypes(connectionId, "*", ["SXSD/XD"], 50)
        if (!result || result.status !== "available") {
          return fail("TABLE_QUERY_REPOSITORY_SEARCH_UNAVAILABLE")
        }
        definitions = [...new Set(result.objects.map((object) => object.name.toUpperCase()))]
        discoveryMayBeTruncated = definitions.length === 50
      } catch {
        return fail("TABLE_QUERY_REPOSITORY_SEARCH_UNAVAILABLE")
      }
    }

    stage = "repository_definition_read"
    const rows: ClassicBadiProjectionRow[] = []
    const fingerprints: string[] = []
    const seenRows = new Set<string>()
    try {
      for (const definitionName of definitions) {
        const result = JSON.parse(
          await this.readClassicBadiDefinition({ definitionName, connectionId })
        ) as {
          fingerprint: string
          definition: {
            name: string
            implementationAssignments: Array<{ implementationName: string }>
            classMappings: Array<{
              implementationName: string
              interfaceName: string
              implementationClass: string
            }>
          }
        }
        fingerprints.push(result.fingerprint)
        for (const assignment of result.definition.implementationAssignments) {
          const mappings = result.definition.classMappings.filter(
            (mapping) => mapping.implementationName === assignment.implementationName
          )
          const effectiveMappings = mappings.length
            ? mappings
            : [
                {
                  implementationName: assignment.implementationName,
                  interfaceName: "",
                  implementationClass: ""
                }
              ]
          for (const mapping of effectiveMappings) {
            const row: ClassicBadiProjectionRow = {
              EXIT_NAME: result.definition.name,
              IMP_NAME: assignment.implementationName,
              CLASS_NAME: mapping.implementationClass,
              INTER_NAME: mapping.interfaceName
            }
            const rowKey = JSON.stringify(row)
            if (seenRows.has(rowKey) || !matchesClassicBadiProjectionFilters(row, input.filters)) {
              continue
            }
            seenRows.add(rowKey)
            rows.push(row)
          }
        }
        if (rows.length > input.maxRows) break
      }
    } catch {
      return fail("TABLE_QUERY_REPOSITORY_READ_FAILED")
    }

    const definitionFingerprint = createHash("sha256")
      .update(JSON.stringify(fingerprints))
      .digest("hex")
    return JSON.stringify(
      {
        ...base,
        status: "ok",
        stage: "response_validation",
        definitionFingerprint,
        representation: "sap_repository_text",
        returnedCount: Math.min(rows.length, input.maxRows),
        truncated: rows.length > input.maxRows || discoveryMayBeTruncated,
        data: rows
          .slice(0, input.maxRows)
          .map((row) =>
            Object.fromEntries(
              columns.map((column) => [column, row[column as keyof ClassicBadiProjectionRow]])
            )
          )
      },
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
    assertQueryTablesAllowed(sql)
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
            qualityGate: QUALITY_GATE_NOT_EVALUATED,
            gateReason: QUALITY_GATE_REASON_NOT_RUN
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
      const transports = await this.backend.listUserTransports(
        connectionId,
        user,
        this.readTransportTableRows.bind(this)
      )
      let totalCount = 0
      // The source is part of the answer: an empty list from the ADT transport organizer and an
      // empty list from the CTS tables are different claims, and only the caller can decide whether
      // an empty result is plausible.
      let result = `Transport Requests for User: ${user}\nSource: ${transports.source}\n\n`
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
      return `${result}\nSummary: ${totalCount} transport requests for user ${user} (source: ${transports.source})`
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

  async cleanupTransportEntries(input: CleanupTransportEntriesInput): Promise<string> {
    if (input.confirmation !== "REMOVE_CTS_ENTRIES") {
      throw new Error("confirmation must be REMOVE_CTS_ENTRIES")
    }
    const connectionId = input.connectionId.toLowerCase()
    const parentTransportNumber = normalizeTransportNumber(input.parentTransportNumber)
    const taskNumber = normalizeTransportNumber(input.taskNumber)
    if (parentTransportNumber === taskNumber) {
      throw new Error("CTS_CLEANUP_TASK_REQUIRED: taskNumber must not be the parent request")
    }
    const entries = input.entries.map((entry) => cleanupTransportEntrySchema.parse(entry))
    const requestedKeys = entries.map(cleanupEntryKey)
    if (new Set(requestedKeys).size !== requestedKeys.length) {
      throw new Error("CTS_CLEANUP_DUPLICATE_ENTRY")
    }

    const before = await this.backend.transportDetails(connectionId, parentTransportNumber)
    assertTransportNumber(before["tm:number"], parentTransportNumber)
    if (before["tm:status"] !== "D") {
      throw new Error("CTS_CLEANUP_PARENT_NOT_MODIFIABLE")
    }
    const task = before.tasks.find(
      (candidate) => candidate["tm:number"].toUpperCase() === taskNumber
    )
    if (!task) throw new Error("CTS_CLEANUP_TASK_NOT_IN_PARENT")
    if (task["tm:status"] !== "D") throw new Error("CTS_CLEANUP_TASK_NOT_MODIFIABLE")

    const beforeFingerprint = transportFingerprint(before)
    if (beforeFingerprint !== input.expectedFingerprint.toLowerCase()) {
      throw new Error(
        `CTS_CLEANUP_STALE_FINGERPRINT: expected ${input.expectedFingerprint.toLowerCase()}, current ${beforeFingerprint}`
      )
    }
    const beforeEntries = transportEntries(before)
    const beforeHeaders = cleanupHeaderKeys(before)
    const selected = entries.map((entry) => {
      const matches = beforeEntries.filter(
        (candidate) =>
          candidate.containerNumber === taskNumber &&
          candidate.pgmid === entry.pgmid &&
          candidate.type === entry.type &&
          candidate.name === entry.name
      )
      if (matches.length !== 1) {
        throw new Error(
          matches.length ? "CTS_CLEANUP_ENTRY_AMBIGUOUS" : "CTS_CLEANUP_ENTRY_NOT_FOUND"
        )
      }
      const match = matches[0]!
      if (!match.position) throw new Error("CTS_CLEANUP_POSITION_UNAVAILABLE")
      if (match.position !== entry.position) throw new Error("CTS_CLEANUP_POSITION_MISMATCH")
      if (entry.wbType && entry.wbType !== match.wbType) {
        throw new Error("CTS_CLEANUP_WBTYPE_MISMATCH")
      }
      return match
    })
    const selectedKeys = new Set(selected.map(cleanupSnapshotKey))
    const expectedRemaining = beforeEntries
      .filter((entry) => !selectedKeys.has(cleanupSnapshotKey(entry)))
      .map(cleanupSnapshotKey)
      .sort()

    await this.backend.cleanupTransportEntries(
      connectionId,
      taskNumber,
      parentTransportNumber,
      selected.map((entry) => ({
        pgmid: entry.pgmid,
        type: entry.type,
        name: entry.name,
        position: entry.position,
        wbType: entry.wbType || undefined
      }))
    )

    const after = await this.backend.transportDetails(connectionId, parentTransportNumber)
    assertTransportNumber(after["tm:number"], parentTransportNumber)
    const afterTask = after.tasks.find(
      (candidate) => candidate["tm:number"].toUpperCase() === taskNumber
    )
    if (!afterTask) throw new Error("CTS_CLEANUP_POSTCHECK_TASK_MISSING")
    const afterEntries = transportEntries(after)
    if (!isDeepStrictEqual(cleanupHeaderKeys(after), beforeHeaders)) {
      throw new Error("CTS_CLEANUP_POSTCHECK_UNEXPECTED_CHANGE")
    }
    for (const entry of entries) {
      if (
        afterEntries.some(
          (candidate) =>
            candidate.containerNumber === taskNumber &&
            candidate.pgmid === entry.pgmid &&
            candidate.type === entry.type &&
            candidate.name === entry.name
        )
      ) {
        throw new Error("CTS_CLEANUP_POSTCHECK_ENTRY_REMAINS")
      }
    }
    const actualRemaining = afterEntries.map(cleanupSnapshotKey).sort()
    if (!isDeepStrictEqual(actualRemaining, expectedRemaining)) {
      throw new Error("CTS_CLEANUP_POSTCHECK_UNEXPECTED_CHANGE")
    }

    return JSON.stringify(
      {
        connectionId,
        parentTransportNumber,
        taskNumber,
        removedEntries: entries,
        beforeFingerprint,
        afterFingerprint: transportFingerprint(after),
        exactRemovalVerified: true,
        unrelatedEntriesUnchanged: true,
        repositoryObjectsChanged: false,
        relatedCtsKeyCleanup: "delegated_to_sap_transport_organizer",
        transportReleased: false,
        automaticRetry: false
      },
      null,
      2
    )
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

/**
 * D7-1 payload kinds, as the shared repository body emits them.
 *
 * `H` and `T` are single rows (the ITCTA form header and the THEAD text header); every other kind
 * is a table whose rows the body numbers from 1. The body resolves each row type's own components
 * through RTTI, so these keys are the real DDIC field names and includes arrive already resolved.
 */
const SAPSCRIPT_FORM_SECTIONS = {
  L: "formLines",
  P: "pages",
  W: "pageWindows",
  X: "windows",
  A: "paragraphs",
  S: "strings",
  B: "tabs",
  D: "source"
} as const

type SapscriptFormSectionName =
  (typeof SAPSCRIPT_FORM_SECTIONS)[keyof typeof SAPSCRIPT_FORM_SECTIONS]

/**
 * `source` alone can be empty for two different reasons, and the two must never be conflated:
 * a form with no ID_DEF text is a fact, while a failed READ_TEXT is a gap. The body reports which
 * one happened, and an unknown token is a drift error rather than a silent "not requested".
 */
function sapscriptSourceStatus(value: string): "not-requested" | "ok" | "failed" {
  if (value === "NOT_REQUESTED") return "not-requested"
  if (value === "OK") return "ok"
  if (value === "FAILED") return "failed"
  throw new Error(`SAP repository helper reported an unknown source status: ${value}`)
}

const SMARTSTYLE_SECTIONS = {
  A: "paragraphs",
  S: "strings",
  B: "tabStops",
  V: "variants"
} as const

type SmartstyleSectionName = (typeof SMARTSTYLE_SECTIONS)[keyof typeof SMARTSTYLE_SECTIONS]

function smartstyleCssStatus(value: string): "not-requested" | "ok" | "failed" {
  if (value === "NOT_REQUESTED") return "not-requested"
  if (value === "OK") return "ok"
  if (value === "FAILED") return "failed"
  throw new Error(`SAP repository helper reported an unknown CSS status: ${value}`)
}

/**
 * The CSS body travels through the same payload channel as the rows, so it arrives as chunks that
 * share one index per source line. Reassembly is by index and then in arrival order, and the
 * helper's own reported length is compared with the reassembled body: a mismatch is reported
 * instead of being returned as if it were the whole stylesheet.
 */
function smartstyleDefinition(
  connectionId: string,
  objectName: string,
  result: SapRepositoryResult
): SmartstyleDefinition {
  const metadata: SmartstyleRow = {}
  const header: SmartstyleRow = {}
  const sections: Record<SmartstyleSectionName, SmartstyleRow[]> = {
    paragraphs: [],
    strings: [],
    tabStops: [],
    variants: []
  }
  const cssChunks = new Map<number, string[]>()
  for (const line of result.source) {
    const match = line.match(/^([A-Z]+)\|(\d+)\|([A-Z0-9_]+)\|(.*)$/)
    if (!match?.[1] || !match[2] || !match[3]) {
      throw new Error(`SAP repository helper returned an invalid payload line: ${line}`)
    }
    const index = Number.parseInt(match[2], 10)
    if (index < 1) {
      throw new Error(`SAP repository helper returned an invalid payload index: ${line}`)
    }
    const value = (match[4] ?? "").replaceAll("%7C", "|").replaceAll("%25", "%")
    const kind = match[1]
    if (kind === "M") {
      metadata[match[3]] = value
      continue
    }
    if (kind === "H") {
      header[match[3]] = value
      continue
    }
    if (kind === "C") {
      const chunks = cssChunks.get(index)
      if (chunks) chunks.push(value)
      else cssChunks.set(index, [value])
      continue
    }
    const section = SMARTSTYLE_SECTIONS[kind as keyof typeof SMARTSTYLE_SECTIONS]
    if (!section) {
      throw new Error(`SAP repository helper returned an unknown style payload kind: ${line}`)
    }
    rowAtRepository(sections[section], index)[match[3]] = value
  }
  const cssStatus = smartstyleCssStatus(metadata.CSS_STATUS ?? "")
  const cssBody = [...cssChunks.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, chunks]) => chunks.join(""))
    .join("\n")
  const declaredLength =
    metadata.CSS_LENGTH === undefined
      ? Number.NaN
      : helperInteger(metadata.CSS_LENGTH, "CSS_LENGTH")
  const css: SmartstyleCss | undefined =
    cssStatus === "ok"
      ? {
          mime: metadata.CSS_MIME ?? "",
          body: cssBody,
          declaredLength: Number.isNaN(declaredLength) ? null : declaredLength,
          lengthMatches: !Number.isNaN(declaredLength) && declaredLength === cssBody.length
        }
      : undefined
  const content = {
    mode: metadata.STYLE_MODE ?? "",
    active: metadata.STYLE_ACTIVE ?? "",
    variant: metadata.STYLE_VARIANT ?? "",
    language: metadata.LANGUAGE ?? "",
    cssStatus,
    header,
    paragraphs: sections.paragraphs,
    strings: sections.strings,
    tabStops: sections.tabStops,
    variants: sections.variants,
    ...(css ? { css } : {})
  }
  const counts = {
    paragraphs: sections.paragraphs.length,
    strings: sections.strings.length,
    tabStops: sections.tabStops.length,
    variants: sections.variants.length
  }
  // As with the SAPscript form reader: the body applies no row cap of its own, so `truncated`
  // reports the absence of a limit that was never applied instead of implying one.
  return {
    connectionId: connectionId.toLowerCase(),
    objectName,
    ...content,
    counts,
    returnedCount: Object.values(counts).reduce((total, count) => total + count, 0),
    truncated: false,
    fingerprint: hashCanonicalJson(content)
  }
}

/**
 * The helper reports integer metadata - byte lengths and row counts - as decimal text. A SAP-side
 * `WRITE <number> TO <character field>` applies the calling user's number format, so any value of
 * 1000 or more can arrive grouped ("5,056"). `Number.parseInt` stops at that separator and returns
 * 5 without raising anything, which turns a formatting difference into a silently wrong count or
 * length rather than a visible failure. Accept a plain integer or a cleanly grouped one, and reject
 * anything else instead of guessing.
 */
function helperInteger(value: string | undefined, field: string): number {
  const text = (value ?? "").trim()
  if (!/^\d+$/.test(text) && !/^\d{1,3}(?:[.,\u00A0\u202F ]\d{3})+$/.test(text)) {
    throw new Error(`SAP repository helper did not report a valid ${field}: ${value ?? ""}`)
  }
  return Number.parseInt(text.replace(/\D/g, ""), 10)
}

/**
 * The helper returns the XDP as base64 chunks that share one index per source line, so reassembly
 * is by index and then in arrival order. The helper's own byte counts are cross-checked against the
 * decoded body: a disagreement is a drift error rather than a silently short layout.
 */
function adobeFormDefinition(
  connectionId: string,
  objectName: string,
  result: SapRepositoryResult
): AdobeFormDefinition {
  const metadata: Record<string, string> = {}
  const chunks = new Map<number, string[]>()
  for (const line of result.source) {
    const match = line.match(/^([A-Z]+)\|(\d+)\|([A-Z0-9_]+)\|(.*)$/)
    if (!match?.[1] || !match[2] || !match[3]) {
      throw new Error(`SAP repository helper returned an invalid payload line: ${line}`)
    }
    const index = Number.parseInt(match[2], 10)
    if (index < 1) {
      throw new Error(`SAP repository helper returned an invalid payload index: ${line}`)
    }
    const value = (match[4] ?? "").replaceAll("%7C", "|").replaceAll("%25", "%")
    if (match[1] === "M") {
      metadata[match[3]] = value
      continue
    }
    if (match[1] !== "Y") {
      throw new Error(`SAP repository helper returned an unknown Adobe payload kind: ${line}`)
    }
    const parts = chunks.get(index)
    if (parts) parts.push(value)
    else chunks.set(index, [value])
  }
  const base64 = [...chunks.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, parts]) => parts.join(""))
    .join("")
  const xdp = Buffer.from(base64, "base64")
  const xdpLength = helperInteger(metadata.XDP_LENGTH, "XDP_LENGTH")
  const xdpBytesReturned = helperInteger(metadata.XDP_RETURNED_LENGTH, "XDP_RETURNED_LENGTH")
  if (xdpBytesReturned !== xdp.length) {
    throw new Error(
      `SAP repository helper reported ${xdpBytesReturned} layout bytes but returned ${xdp.length}`
    )
  }
  const truncated = metadata.XDP_TRUNCATED === "X"
  const content = {
    language: metadata.LANGUAGE ?? "",
    masterLanguage: metadata.MASTER_LANGUAGE ?? "",
    state: metadata.STATE ?? "",
    dirty: metadata.DIRTY === "X",
    id: metadata.ID ?? "",
    interfaceAvailable: false as const,
    unsupported: ["interface", "context"],
    xdpLength,
    xdpBytesReturned,
    truncated
  }
  return {
    connectionId: connectionId.toLowerCase(),
    objectName,
    ...content,
    xdp: base64,
    ...(truncated ? {} : { xdpSha256: createHash("sha256").update(xdp).digest("hex") }),
    fingerprint: hashCanonicalJson(content)
  }
}

function sapscriptFormDefinition(
  connectionId: string,
  objectName: string,
  result: SapRepositoryResult
): SapscriptFormDefinition {
  const metadata: SapscriptFormRow = {}
  const header: SapscriptFormRow = {}
  const textHeader: SapscriptFormRow = {}
  const sections: Record<SapscriptFormSectionName, SapscriptFormRow[]> = {
    formLines: [],
    pages: [],
    pageWindows: [],
    windows: [],
    paragraphs: [],
    strings: [],
    tabs: [],
    source: []
  }
  for (const line of result.source) {
    const match = line.match(/^([A-Z]+)\|(\d+)\|([A-Z0-9_]+)\|(.*)$/)
    if (!match?.[1] || !match[2] || !match[3]) {
      throw new Error(`SAP repository helper returned an invalid payload line: ${line}`)
    }
    const index = Number.parseInt(match[2], 10)
    if (index < 1) {
      throw new Error(`SAP repository helper returned an invalid payload index: ${line}`)
    }
    const value = (match[4] ?? "").replaceAll("%7C", "|").replaceAll("%25", "%")
    const kind = match[1]
    if (kind === "M") {
      metadata[match[3]] = value
      continue
    }
    if (kind === "H") {
      header[match[3]] = value
      continue
    }
    if (kind === "T") {
      textHeader[match[3]] = value
      continue
    }
    const section = SAPSCRIPT_FORM_SECTIONS[kind as keyof typeof SAPSCRIPT_FORM_SECTIONS]
    if (!section) {
      throw new Error(`SAP repository helper returned an unknown form payload kind: ${line}`)
    }
    rowAtRepository(sections[section], index)[match[3]] = value
  }
  const includeSource = metadata.INCLUDE_SOURCE === "X"
  const content = {
    formStatus: metadata.FORM_STATUS ?? "",
    language: metadata.LANGUAGE ?? "",
    tdname: metadata.TDNAME ?? "",
    includeSource,
    sourceStatus: sapscriptSourceStatus(metadata.SOURCE_STATUS ?? ""),
    header,
    textHeader,
    formLines: sections.formLines,
    pages: sections.pages,
    pageWindows: sections.pageWindows,
    windows: sections.windows,
    paragraphs: sections.paragraphs,
    strings: sections.strings,
    tabs: sections.tabs
  }
  const counts = {
    formLines: sections.formLines.length,
    pages: sections.pages.length,
    pageWindows: sections.pageWindows.length,
    windows: sections.windows.length,
    paragraphs: sections.paragraphs.length,
    strings: sections.strings.length,
    tabs: sections.tabs.length
  }
  // The body appends every row READ_FORM returned and applies no cap of its own, so `truncated`
  // reports the absence of a limit that was never applied instead of implying one.
  return {
    connectionId: connectionId.toLowerCase(),
    objectName,
    ...content,
    ...(includeSource ? { source: sections.source } : {}),
    counts,
    returnedCount:
      Object.values(counts).reduce((total, count) => total + count, 0) +
      (includeSource ? sections.source.length : 0),
    truncated: false,
    fingerprint: hashCanonicalJson(content)
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

interface CustomerFunctionCallSite {
  objectName: string
  objectType: string
  sourceUri: string
  line: number
  endLine: number
  statement: string
  exitNumber: string | null
  unresolvedOperand: string | null
}

function customerFunctionCallSites(unit: ProgramSourceUnit): CustomerFunctionCallSite[] {
  return abapStatements(unit.source).flatMap((statement) => {
    const match = /\bCALL\s+CUSTOMER-FUNCTION\s+(?:'((?:''|[^'])*)'|([^\s.]+))/i.exec(
      statement.text
    )
    if (!match) return []
    const literal = match[1]?.replace(/''/g, "'")
    const exitNumber = literal && /^\d{3}$/.test(literal) ? literal : null
    return [
      {
        objectName: unit.objectName,
        objectType: unit.objectType,
        sourceUri: unit.sourceUri,
        line: statement.line,
        endLine: statement.endLine,
        statement: statement.text,
        exitNumber,
        unresolvedOperand: exitNumber ? null : (literal ?? match[2] ?? null)
      }
    ]
  })
}

function abapStatements(source: string): Array<{ line: number; endLine: number; text: string }> {
  const statements: Array<{ line: number; endLine: number; text: string }> = []
  let startLine = 0
  let parts: string[] = []
  const lines = source.split("\n")
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? ""
    if (/^\s*\*/.test(rawLine)) continue
    const line = stripAbapInlineComment(rawLine).trim()
    if (!line) continue
    if (!parts.length) startLine = index + 1
    parts.push(line)
    if (!abapStatementEnds(line)) continue
    statements.push({
      line: startLine,
      endLine: index + 1,
      text: parts.join(" ")
    })
    parts = []
  }
  if (parts.length) {
    statements.push({ line: startLine, endLine: lines.length, text: parts.join(" ") })
  }
  return statements
}

function stripAbapInlineComment(line: string): string {
  let inLiteral = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === "'") {
      if (inLiteral && line[index + 1] === "'") {
        index += 1
        continue
      }
      inLiteral = !inLiteral
    } else if (char === '"' && !inLiteral) {
      return line.slice(0, index)
    }
  }
  return line
}

function abapStatementEnds(line: string): boolean {
  let inLiteral = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === "'") {
      if (inLiteral && line[index + 1] === "'") {
        index += 1
        continue
      }
      inLiteral = !inLiteral
    }
  }
  return !inLiteral && /\.\s*$/.test(line)
}

function customerSubscreenHooks(flowLogic: string[]): Array<{
  area: string
  line: number
  endLine: number
  statement: string
}> {
  return abapStatements(flowLogic.join("\n")).flatMap((statement) => {
    const match = /\bCALL\s+CUSTOMER-SUBSCREEN\s+([A-Z][A-Z0-9_/$-]*)/i.exec(statement.text)
    if (!match?.[1]) return []
    return [
      {
        area: match[1].toUpperCase(),
        line: statement.line,
        endLine: statement.endLine,
        statement: statement.text
      }
    ]
  })
}

function customerMenuExitEvidence(gui: GuiDefinition): {
  definitions: Array<{
    code: string
    textNumber: string
    functionText: string
    iconText: string
    infoText: string
  }>
  references: Array<{
    section: GuiSectionName
    row: number
    field: string
    code: string
  }>
} {
  const definitions = gui.sections.functions
    .filter((row) => (row.CODE ?? "").startsWith("+"))
    .map((row) => ({
      code: row.CODE ?? "",
      textNumber: row.TEXTNO ?? "",
      functionText: row.FUN_TEXT ?? "",
      iconText: row.ICON_TEXT ?? "",
      infoText: row.INFO_TEXT ?? ""
    }))
  const referenceFields: Array<[GuiSectionName, string]> = [
    ["menus", "REF_CODE"],
    ["activeFunctions", "CODE"],
    ["buttons", "CODE"],
    ["pfKeys", "FUNCODE"],
    ["statusFunctions", "FUNCTION"],
    ["buttonAssignments", "FCODE"]
  ]
  const references = referenceFields.flatMap(([section, field]) =>
    gui.sections[section].flatMap((row, index) => {
      const code = row[field] ?? ""
      return code.startsWith("+") ? [{ section, row: index + 1, field, code }] : []
    })
  )
  return { definitions, references }
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

function cleanupEntryKey(entry: z.input<typeof cleanupTransportEntrySchema>): string {
  return JSON.stringify([entry.pgmid, entry.type, entry.name, entry.position])
}

function cleanupSnapshotKey(entry: ReturnType<typeof transportEntries>[number]): string {
  return JSON.stringify([
    entry.containerNumber,
    entry.pgmid,
    entry.type,
    entry.name,
    entry.position,
    entry.wbType
  ])
}

function cleanupHeaderKeys(transport: TransportRequest): string[] {
  return [transport, ...transport.tasks]
    .map((container) =>
      JSON.stringify([container["tm:number"], container["tm:owner"], container["tm:status"]])
    )
    .sort()
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
    `Tasks: ${transport.tasks.length}\n` +
    `Cleanup Fingerprint: ${transportFingerprint(transport)}\n\n`
  if (!entries.length) return `${result}No objects in this transport.\n`
  for (const entry of entries) {
    const object = entry.object as typeof entry.object & {
      "tm:position"?: string
      "tm:wbtype"?: string
    }
    const metadata = [
      object["tm:position"] ? `position=${object["tm:position"]}` : "position=unavailable",
      object["tm:wbtype"] ? `wbType=${object["tm:wbtype"]}` : "wbType=unavailable"
    ].join(" | ")
    result += `- ${object["tm:pgmid"]} ${object["tm:type"]} ${object["tm:name"]} - ${object["tm:obj_info"]} [${entry.source}; ${metadata}]\n`
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

function classifyEnhancementFailure(error: unknown): {
  status: "unsupported" | "forbidden" | "timeout" | "error"
  reason: string
} {
  const message = error instanceof Error ? error.message : String(error)
  if (/unsupported-endpoint|HTTP (?:404|405|501)\b/i.test(message)) {
    return {
      status: "unsupported",
      reason: "The SAP system does not expose a usable enhancement metadata endpoint."
    }
  }
  if (/forbidden|not.authorized|HTTP (?:401|403)\b/i.test(message)) {
    return {
      status: "forbidden",
      reason: "The SAP user is not authorized to read enhancement metadata."
    }
  }
  if (/timeout|timed out/i.test(message)) {
    return {
      status: "timeout",
      reason: "The enhancement metadata request timed out; absence was not established."
    }
  }
  return {
    status: "error",
    reason: "Enhancement metadata could not be read; absence was not established."
  }
}

function classifyRepositoryEvidenceFailure(
  error: unknown,
  subject = "repository evidence"
): {
  status: "unsupported" | "forbidden" | "timeout" | "error"
  reason: string
} {
  const message = error instanceof Error ? error.message : String(error)
  if (/unsupported-endpoint|HTTP (?:404|405|501)\b/i.test(message)) {
    return {
      status: "unsupported",
      reason: `The SAP system does not expose a usable ${subject} endpoint.`
    }
  }
  if (/forbidden|not.authorized|HTTP (?:401|403)\b/i.test(message)) {
    return {
      status: "forbidden",
      reason: `The SAP user is not authorized to read the ${subject}.`
    }
  }
  if (/timeout|timed out/i.test(message)) {
    return {
      status: "timeout",
      reason: `The ${subject} request timed out; content was not established.`
    }
  }
  return {
    status: "error",
    reason: `The ${subject} could not be read; content was not established.`
  }
}

async function controlledWorkflowRead(read: () => Promise<string>): Promise<{
  status: "available" | "absent" | "unsupported" | "forbidden" | "timeout" | "error"
  evidence?: unknown
  reason?: string
}> {
  try {
    return { status: "available", evidence: JSON.parse(await read()) as unknown }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/_NOT_FOUND\b|does not exist|could not find exact/i.test(message)) {
      return { status: "absent", reason: message }
    }
    const failure = classifyRepositoryEvidenceFailure(error, "configuration preflight evidence")
    return { status: failure.status, reason: failure.reason }
  }
}

function workflowStep(
  sequence: number,
  phase: string,
  instruction: string,
  evidenceRequired: string,
  destructive = false
): Record<string, unknown> {
  return { sequence, phase, instruction, evidenceRequired, destructive }
}

function cmodConfigurationWorkflow(
  projectName: string,
  desiredState: EnhancementConfigurationWorkflowInput["desiredState"],
  enhancementNames: string[],
  packageName: string | undefined,
  transportNumber: string | undefined
): Array<Record<string, unknown>> {
  const targetEnhancements = enhancementNames.length ? enhancementNames.join(", ") : "<required>"
  return [
    workflowStep(
      1,
      "preflight",
      `In SMOD, display every requested enhancement (${targetEnhancements}); verify its components and that no conflicting CMOD project owns it.`,
      "SMOD component list and conflict check"
    ),
    workflowStep(
      2,
      "edit",
      `Open CMOD project ${projectName}. Create it only if absent, using package ${packageName ?? "<required>"}; otherwise compare the displayed assignments with the preflight snapshot before editing.`,
      "Project header, package, current status, and current assignment list"
    ),
    workflowStep(
      3,
      "assignment",
      `Apply only the approved assignment delta for ${targetEnhancements}; do not remove unlisted assignments unless the approved target state explicitly requires it.`,
      "Before/after assignment list"
    ),
    workflowStep(
      4,
      "implementation",
      "Open each assigned component and confirm its customer include, subscreen, or menu function implementation is present and syntactically valid. Do not edit SAP standard includes.",
      "Implemented component list and syntax result"
    ),
    workflowStep(
      5,
      "save",
      `Save only to existing modifiable request/task ${transportNumber ?? "<required>"}; stop if SAP proposes another package, request, or standard object.`,
      "Recorded package and transport/task"
    ),
    workflowStep(
      6,
      "state",
      `Set project ${projectName} to desired state ${desiredState}. Activation, deactivation, or deletion requires a separate human confirmation after reviewing impact and generation messages.`,
      "CMOD status and all activation/generation messages",
      desiredState === "removed"
    ),
    workflowStep(
      7,
      "readback",
      "Run read_customer_exit_project again and compare project status and assignments with the approved target. Re-read every SMOD definition whose component set was used.",
      "Post-change fingerprints and exact assignment/status readback"
    ),
    workflowStep(
      8,
      "acceptance",
      "Run the affected transaction manually for Function, Screen, and Menu Exit paths as applicable, including one negative case and authorization check.",
      "Manual test inputs, expected/actual results, user, timestamp, and screenshots or logs"
    )
  ]
}

function fibfConfigurationWorkflow(
  kind: BteKind,
  identifier: string,
  desiredState: EnhancementConfigurationWorkflowInput["desiredState"],
  productName: string | undefined,
  functionModule: string | undefined,
  applicationIndicator: string | undefined,
  country: string | undefined,
  transportNumber: string | undefined
): Array<Record<string, unknown>> {
  const assignment = [
    `product ${productName ?? "<required>"}`,
    `function ${functionModule ?? "<required>"}`,
    `application ${applicationIndicator || "<blank or required by definition>"}`,
    `country ${country || "<blank or required by definition>"}`
  ].join(", ")
  return [
    workflowStep(
      1,
      "preflight",
      `In FIBF, display ${kind} ${identifier}, its sample interface, SAP application assignments, customer assignments, and product status; compare them with read_bte_configuration.`,
      "Definition, interface, product, and exact assignment snapshot"
    ),
    workflowStep(
      2,
      "handler_check",
      `Display ${functionModule ?? "<required>"} in SE37 and verify the active interface matches the ${kind} sample function. Do not execute the handler as part of configuration.`,
      "Active function interface comparison and syntax status"
    ),
    workflowStep(
      3,
      "product",
      `Maintain only product ${productName ?? "<required>"}. Before changing its active flag, confirm whether other BTE assignments share the product; stop if ${desiredState} would affect unrelated handlers.`,
      "Product active flag and complete dependent assignment list"
    ),
    workflowStep(
      4,
      "assignment",
      `Maintain the exact customer ${kind} assignment: ${identifier}, ${assignment}. Apply only the approved delta for desired state ${desiredState}.`,
      "Before/after assignment row"
    ),
    workflowStep(
      5,
      "save",
      `Save to existing modifiable Customizing request/task ${transportNumber ?? "<required>"}; do not use direct TBE*/TPS* table updates.`,
      "Recorded Customizing request/task"
    ),
    workflowStep(
      6,
      "readback",
      "Run read_bte_configuration again and compare the exact customer handler row plus raw product/application activation flags with the approved target.",
      "Post-change configuration fingerprint and exact handler row"
    ),
    workflowStep(
      7,
      "acceptance",
      `Trigger the real business flow that publishes ${kind} ${identifier}; verify handler call count, data contract, errors, commits, and coexistence with other active handlers.`,
      "Manual runtime trace or application log and resulting business data"
    )
  ]
}

function ficoRuleConfigurationWorkflow(
  kind: "fi_validation" | "fi_substitution",
  ruleName: string,
  desiredState: EnhancementConfigurationWorkflowInput["desiredState"],
  applicationArea: string | undefined,
  callupPoint: string | undefined,
  organizationalUnit: string | undefined,
  exitProgram: string | undefined,
  transportNumber: string | undefined
): Array<Record<string, unknown>> {
  const ruleTransaction = kind === "fi_validation" ? "GGB0" : "GGB1"
  const activationTransaction = kind === "fi_validation" ? "OB28" : "OBBH"
  return [
    workflowStep(
      1,
      "preflight",
      `In ${ruleTransaction}, select application area ${applicationArea ?? "<required>"} and display rule ${ruleName}; record every step, prerequisite, check/substitution, message, set, exit reference, and call-up point.`,
      "Complete rule definition and current generation status"
    ),
    workflowStep(
      2,
      "exit_check",
      exitProgram
        ? `Compare exit program ${exitProgram} with inspect_fico_rule_exit_program; verify every referenced exit is declared in GET_EXIT_TITLES and implemented with the required parameter type.`
        : "If the rule calls an ABAP exit, identify the configured exit program and verify its GET_EXIT_TITLES declaration, FORM implementation, parameter type, syntax, and authorization before continuing.",
      "Exit program, catalog entry, FORM implementation, and syntax result"
    ),
    workflowStep(
      3,
      "edit",
      `Apply only the approved ${kind === "fi_validation" ? "validation" : "substitution"} delta to ${ruleName}. Preserve unlisted steps and sequence; check rule syntax before save.`,
      "Before/after rule tree and successful syntax check"
    ),
    workflowStep(
      4,
      "save",
      `Save to existing modifiable request/task ${transportNumber ?? "<required>"}. Use the transaction's supported save and generation flow; run RGUGBR00 only when the system procedure explicitly requires regeneration.`,
      "Recorded request/task and generation log"
    ),
    workflowStep(
      5,
      "activation",
      `In ${activationTransaction}, maintain only organizational unit ${organizationalUnit ?? "<required>"}, call-up point ${callupPoint ?? "<required>"}, and rule ${ruleName} to desired state ${desiredState}. Confirm validity dates and activation level shown by SAP.`,
      "Before/after activation row, validity, and activation level",
      desiredState === "removed"
    ),
    workflowStep(
      6,
      "readback",
      `Reopen ${ruleTransaction} and ${activationTransaction}; independently compare the saved rule, generated state, and exact activation row with the approved target.`,
      "Post-change rule tree, generation status, and activation row"
    ),
    workflowStep(
      7,
      "acceptance",
      `Post or simulate representative FI documents at ${callupPoint ?? "<required>"}: one matching case, one non-matching case, one error path, and one authorization case. Verify messages or substituted values and persistence.`,
      "Manual test matrix, document keys, expected/actual results, and cleanup status"
    )
  ]
}

function enhancementRepositoryKind(type: string): string {
  return (
    {
      ENHC: "enhancement_composite",
      ENHS: "enhancement_spot",
      ENHO: "enhancement_implementation",
      BADI: "badi_definition",
      BADII: "badi_implementation"
    }[type] ?? "unknown"
  )
}

function customerExitRepositoryKind(type: string): string {
  return (
    {
      SMOD: "customer_exit_definition",
      CMOD: "customer_exit_project"
    }[type] ?? "unknown"
  )
}

function customerExitConfigurationName(value: string, fieldName: string): string {
  const normalized = value.trim().toUpperCase()
  if (!/^[A-Z0-9_/$]{1,30}$/.test(normalized)) {
    throw new Error(`${fieldName} must be an exact SAP Customer Exit name.`)
  }
  return normalized
}

function customerExitComponentKind(
  typeCode: string
): "function_exit" | "screen_exit" | "menu_exit" | "unknown" {
  switch (typeCode.trim().toUpperCase()) {
    case "E":
      return "function_exit"
    case "S":
      return "screen_exit"
    case "C":
      return "menu_exit"
    default:
      return "unknown"
  }
}

function customerExitConfigurationPayload(lines: string[]): {
  metadata: Record<string, string>
  components: Array<Record<string, string>>
  assignments: Array<Record<string, string>>
} {
  const metadata: Record<string, string> = {}
  const components: Array<Record<string, string>> = []
  const assignments: Array<Record<string, string>> = []
  for (const line of lines) {
    const match = line.match(/^([MCA])\|(\d+)\|([A-Z0-9_]+)\|(.*)$/)
    if (!match?.[1] || !match[2] || !match[3]) {
      throw new Error(
        `SAP repository helper returned an invalid Customer Exit payload line: ${line}`
      )
    }
    const index = Number.parseInt(match[2], 10)
    if (index < 1) {
      throw new Error(`SAP repository helper returned an invalid payload index: ${line}`)
    }
    const value = (match[4] ?? "").replaceAll("%7C", "|").replaceAll("%25", "%")
    const target =
      match[1] === "M"
        ? metadata
        : rowAtRepository(match[1] === "C" ? components : assignments, index)
    target[match[3]] = value
  }
  return { metadata, components, assignments }
}

function bteConfigurationPayload(lines: string[]): {
  metadata: Record<string, string>
  sapHandlers: Array<Record<string, string>>
  customerHandlers: Array<Record<string, string>>
} {
  const metadata: Record<string, string> = {}
  const sapHandlers: Array<Record<string, string>> = []
  const customerHandlers: Array<Record<string, string>> = []
  for (const line of lines) {
    const match = line.match(/^([MSC])\|(\d+)\|([A-Z0-9_]+)\|(.*)$/)
    if (!match?.[1] || !match[2] || !match[3]) {
      throw new Error(`SAP repository helper returned an invalid BTE payload line: ${line}`)
    }
    const index = Number.parseInt(match[2], 10)
    if (index < 1) {
      throw new Error(`SAP repository helper returned an invalid payload index: ${line}`)
    }
    const value = (match[4] ?? "").replaceAll("%7C", "|").replaceAll("%25", "%")
    const target =
      match[1] === "M"
        ? metadata
        : rowAtRepository(match[1] === "S" ? sapHandlers : customerHandlers, index)
    target[match[3]] = value
  }
  return { metadata, sapHandlers, customerHandlers }
}

function bteConfigurationHandler(row: Record<string, string>): {
  country: string
  applicationIndicator: string
  functionModule: string
  product: string
  applicationActiveRaw: string
  applicationText: string
  productActiveRaw: string
  productText: string
  productRfcDestination: string
} {
  return {
    country: row.COUNTRY ?? "",
    applicationIndicator: row.APPLICATION ?? "",
    functionModule: row.FUNCTION_MODULE ?? "",
    product: row.PRODUCT ?? "",
    applicationActiveRaw: row.APPLICATION_ACTIVE ?? "",
    applicationText: row.APPLICATION_TEXT ?? "",
    productActiveRaw: row.PRODUCT_ACTIVE ?? "",
    productText: row.PRODUCT_TEXT ?? "",
    productRfcDestination: row.PRODUCT_RFC_DESTINATION ?? ""
  }
}

function compareBteConfigurationHandlers(
  left: ReturnType<typeof bteConfigurationHandler>,
  right: ReturnType<typeof bteConfigurationHandler>
): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right))
}

function classicBadiDefinitionName(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (!/^[A-Z0-9_/$]{1,20}$/.test(normalized)) {
    throw new Error("definitionName must be an exact Classic BAdI definition name.")
  }
  return normalized
}

function matchesClassicBadiProjectionFilters(
  row: ClassicBadiProjectionRow,
  filters: TableQueryInput["filters"]
): boolean {
  return filters.every((filter) => {
    const value = row[filter.column as keyof ClassicBadiProjectionRow]
    const comparison = value.localeCompare(filter.value)
    switch (filter.operator) {
      case "EQ":
        return comparison === 0
      case "NE":
        return comparison !== 0
      case "LT":
        return comparison < 0
      case "LE":
        return comparison <= 0
      case "GT":
        return comparison > 0
      case "GE":
        return comparison >= 0
    }
  })
}

function classicBadiDefinitionPayload(lines: string[]): {
  metadata: Record<string, string>
  interfaces: Array<Record<string, string>>
  assignments: Array<Record<string, string>>
  classMappings: Array<Record<string, string>>
} {
  const metadata: Record<string, string> = {}
  const interfaces: Array<Record<string, string>> = []
  const assignments: Array<Record<string, string>> = []
  const classMappings: Array<Record<string, string>> = []
  for (const line of lines) {
    const match = line.match(/^([MIAC])\|(\d+)\|([A-Z0-9_]+)\|(.*)$/)
    if (!match?.[1] || !match[2] || !match[3]) {
      throw new Error(
        `SAP repository helper returned an invalid Classic BAdI payload line: ${line}`
      )
    }
    const index = Number.parseInt(match[2], 10)
    if (index < 1) {
      throw new Error(`SAP repository helper returned an invalid payload index: ${line}`)
    }
    const value = (match[4] ?? "").replaceAll("%7C", "|").replaceAll("%25", "%")
    const rows = match[1] === "I" ? interfaces : match[1] === "A" ? assignments : classMappings
    const target = match[1] === "M" ? metadata : rowAtRepository(rows, index)
    target[match[3]] = value
  }
  return { metadata, interfaces, assignments, classMappings }
}

function compareByJson(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right))
}

function badiRepositoryKind(type: string): string {
  return (
    {
      "SXSD/XD": "classic_badi_definition",
      "SXCI/XI": "classic_badi_implementation",
      "ENHS/XS": "enhancement_spot_container",
      "ENHO/XHB": "new_badi_implementation"
    }[type] ?? "unknown"
  )
}

function inspectEnhancementFrameworkSource(source: string): {
  explicitAnchors: Array<{
    kind: "point" | "section"
    name: string
    spots: string[]
    line: number
    statement: string
  }>
  enhancementImplementations: Array<{ id: string; name: string; line: number; statement: string }>
  implicitCandidates: Array<{
    kind: "source_start" | "source_end" | "routine_start" | "routine_end"
    line: number
    position: "before_line" | "after_line"
    routineKind?: "form" | "method" | "function" | "module"
    routineName?: string
  }>
  summary: {
    explicitAnchorCount: number
    enhancementImplementationCount: number
    routineCount: number
    implicitCandidateCount: number
  }
} {
  const lines = source.split("\n")
  const explicitAnchors: Array<{
    kind: "point" | "section"
    name: string
    spots: string[]
    line: number
    statement: string
  }> = []
  const enhancementImplementations: Array<{
    id: string
    name: string
    line: number
    statement: string
  }> = []
  const implicitCandidates: Array<{
    kind: "source_start" | "source_end" | "routine_start" | "routine_end"
    line: number
    position: "before_line" | "after_line"
    routineKind?: "form" | "method" | "function" | "module"
    routineName?: string
  }> = []
  const openRoutines: Array<{
    routineKind: "form" | "method" | "function" | "module"
    routineName: string
  }> = []
  let routineCount = 0
  let firstCodeLine = 0
  let lastCodeLine = 0

  lines.forEach((line, index) => {
    if (!line.trim() || /^\s*[*"]/.test(line)) return
    const lineNumber = index + 1
    if (!firstCodeLine) firstCodeLine = lineNumber
    lastCodeLine = lineNumber
    const statement = line.trim()
    const anchor =
      /^ENHANCEMENT-(POINT|SECTION)\s+([A-Z0-9_\/]+)\s+SPOTS\s+(.+?)\s*\.\s*(?:".*)?$/i.exec(
        statement
      )
    if (anchor) {
      explicitAnchors.push({
        kind: anchor[1]!.toLowerCase() as "point" | "section",
        name: anchor[2]!.toUpperCase(),
        spots: anchor[3]!
          .split(/[\s,]+/)
          .filter(Boolean)
          .map((spot) => spot.toUpperCase())
          .filter((spot) => spot !== "STATIC"),
        line: lineNumber,
        statement
      })
    }
    const implementation = /^ENHANCEMENT\s+(\d+)\s+([A-Z0-9_\/]+)\s*\./i.exec(statement)
    if (implementation) {
      enhancementImplementations.push({
        id: implementation[1]!,
        name: implementation[2]!.toUpperCase(),
        line: lineNumber,
        statement
      })
    }

    const routineStart = enhancementRoutineStart(statement)
    if (routineStart) {
      routineCount++
      openRoutines.push({
        routineKind: routineStart.routineKind,
        routineName: routineStart.routineName.toUpperCase()
      })
      implicitCandidates.push({
        kind: "routine_start",
        line: lineNumber,
        position: "after_line",
        routineKind: routineStart.routineKind,
        routineName: routineStart.routineName.toUpperCase()
      })
    }

    const routineEndKind = /^ENDFORM\s*\./i.test(statement)
      ? "form"
      : /^ENDMETHOD\s*\./i.test(statement)
        ? "method"
        : /^ENDFUNCTION\s*\./i.test(statement)
          ? "function"
          : /^ENDMODULE\s*\./i.test(statement)
            ? "module"
            : undefined
    if (routineEndKind) {
      let openIndex = -1
      for (let index = openRoutines.length - 1; index >= 0; index--) {
        if (openRoutines[index]!.routineKind === routineEndKind) {
          openIndex = index
          break
        }
      }
      if (openIndex >= 0) {
        const [routine] = openRoutines.splice(openIndex, 1)
        implicitCandidates.push({
          kind: "routine_end",
          line: lineNumber,
          position: "before_line",
          routineKind: routine!.routineKind,
          routineName: routine!.routineName
        })
      }
    }
  })

  if (firstCodeLine) {
    implicitCandidates.unshift({
      kind: "source_start",
      line: firstCodeLine,
      position: "before_line"
    })
    implicitCandidates.push({ kind: "source_end", line: lastCodeLine, position: "after_line" })
  }

  return {
    explicitAnchors,
    enhancementImplementations,
    implicitCandidates,
    summary: {
      explicitAnchorCount: explicitAnchors.length,
      enhancementImplementationCount: enhancementImplementations.length,
      routineCount,
      implicitCandidateCount: implicitCandidates.length
    }
  }
}

function enhancementRoutineStart(statement: string):
  | {
      routineKind: "form" | "method" | "function" | "module"
      routineName: string
    }
  | undefined {
  const patterns = [
    ["form", /^FORM\s+([A-Z0-9_\/~]+)\b/i],
    ["method", /^METHOD\s+([A-Z0-9_\/~]+)\s*\./i],
    ["function", /^FUNCTION\s+([A-Z0-9_\/~]+)\s*\./i],
    ["module", /^MODULE\s+([A-Z0-9_\/~]+)\s+(?:INPUT|OUTPUT)\s*\./i]
  ] as const
  for (const [routineKind, pattern] of patterns) {
    const match = pattern.exec(statement)
    if (match?.[1]) return { routineKind, routineName: match[1] }
  }
  return undefined
}

function inspectFicoRuleExitSource(source: string): {
  catalogRoutine: { found: boolean; startLine: number | null; endLine: number | null }
  catalogEntries: Array<{
    name: string | null
    parameterExpression: string | null
    titleExpression: string | null
    appendLine: number
    implementationFound: boolean
    implementationLine: number | null
  }>
  implementedExitForms: Array<{ name: string; line: number; declaredInCatalog: boolean }>
  summary: {
    catalogEntryCount: number
    implementedExitFormCount: number
    matchedExitCount: number
    declarationWithoutImplementationCount: number
    implementationWithoutDeclarationCount: number
  }
} {
  const lines = source.split("\n")
  const forms = new Map<string, number>()
  let catalogStart = -1
  let catalogEnd = -1
  let inCatalog = false
  let currentName: string | null = null
  let currentParameter: string | null = null
  let currentTitle: string | null = null
  const rawEntries: Array<{
    name: string | null
    parameterExpression: string | null
    titleExpression: string | null
    appendLine: number
  }> = []

  lines.forEach((line, index) => {
    if (!line.trim() || /^\s*[*"]/.test(line)) return
    const lineNumber = index + 1
    const statement = line.trim()
    const form = /^FORM\s+([A-Z0-9_\/]+)\b/i.exec(statement)
    if (form?.[1]) {
      const name = form[1].toUpperCase()
      forms.set(name, lineNumber)
      if (name === "GET_EXIT_TITLES") {
        inCatalog = true
        catalogStart = lineNumber
      }
    }
    if (!inCatalog) return
    if (/^ENDFORM\s*\./i.test(statement)) {
      catalogEnd = lineNumber
      inCatalog = false
      return
    }
    const assignment = /^EXITS-(NAME|PARAM|TITLE)\s*=\s*(.+?)\s*\.\s*(?:".*)?$/i.exec(statement)
    if (assignment) {
      const field = assignment[1]!.toUpperCase()
      const expression = assignment[2]!.trim()
      if (field === "NAME") currentName = abapLiteralOrExpression(expression)
      if (field === "PARAM") currentParameter = expression.toUpperCase()
      if (field === "TITLE") currentTitle = expression
      return
    }
    if (/^APPEND\s+EXITS\s*\./i.test(statement)) {
      rawEntries.push({
        name: currentName,
        parameterExpression: currentParameter,
        titleExpression: currentTitle,
        appendLine: lineNumber
      })
      currentName = null
      currentParameter = null
      currentTitle = null
    }
  })

  const declaredNames = new Set(
    rawEntries.flatMap((entry) => (entry.name ? [entry.name.toUpperCase()] : []))
  )
  const implementedExitForms = [...forms.entries()]
    .filter(
      ([name]) => name !== "GET_EXIT_TITLES" && (/^U\d+$/i.test(name) || declaredNames.has(name))
    )
    .map(([name, line]) => ({ name, line, declaredInCatalog: declaredNames.has(name) }))
  const catalogEntries = rawEntries.map((entry) => {
    const implementationLine = entry.name ? (forms.get(entry.name.toUpperCase()) ?? null) : null
    return {
      ...entry,
      implementationFound: implementationLine !== null,
      implementationLine
    }
  })
  const matchedExitCount = catalogEntries.filter((entry) => entry.implementationFound).length

  return {
    catalogRoutine: {
      found: catalogStart >= 0,
      startLine: catalogStart >= 0 ? catalogStart : null,
      endLine: catalogEnd >= 0 ? catalogEnd : null
    },
    catalogEntries,
    implementedExitForms,
    summary: {
      catalogEntryCount: catalogEntries.length,
      implementedExitFormCount: implementedExitForms.length,
      matchedExitCount,
      declarationWithoutImplementationCount: catalogEntries.length - matchedExitCount,
      implementationWithoutDeclarationCount: implementedExitForms.filter(
        (form) => !form.declaredInCatalog
      ).length
    }
  }
}

function abapLiteralOrExpression(expression: string): string {
  const literal = /^'((?:''|[^'])*)'$/.exec(expression)
  return (literal ? literal[1]!.replace(/''/g, "'") : expression).toUpperCase()
}

function enhancementSourceMarkers(source: string): Array<{
  family: "user_exit" | "customer_exit" | "bte" | "badi" | "enhancement_framework"
  marker: string
  line: number
  statement: string
}> {
  const patterns = [
    ["user_exit", "form_userexit", /^\s*FORM\s+USEREXIT_[A-Z0-9_]+\b/i],
    ["customer_exit", "call_customer_function", /^\s*CALL\s+CUSTOMER-FUNCTION\b/i],
    ["bte", "open_fi_perform", /\bOPEN_FI_PERFORM_[A-Z0-9_]+_[EP]\b/i],
    ["badi", "get_or_call_badi", /^\s*(?:GET|CALL)\s+BADI\b/i],
    ["badi", "classic_badi_factory", /\bCL_EXITHANDLER\s*=>\s*GET_INSTANCE\b/i],
    ["enhancement_framework", "enhancement_point", /^\s*ENHANCEMENT-POINT\s+[A-Z0-9_]+\b/i],
    ["enhancement_framework", "enhancement_section", /^\s*ENHANCEMENT-SECTION\s+[A-Z0-9_]+\b/i],
    ["enhancement_framework", "enhancement_implementation", /^\s*ENHANCEMENT\s+\d+\s+[A-Z0-9_]+\b/i]
  ] as const

  return source.split("\n").flatMap((line, index) => {
    if (/^\s*[*"]/.test(line)) return []
    return patterns.flatMap(([family, marker, pattern]) =>
      pattern.test(line) ? [{ family, marker, line: index + 1, statement: line.trim() }] : []
    )
  })
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

/**
 * How many field rows a DDIC definition carries.
 *
 * The 10:26 incident reported `fields: []` for an inactive table whose 29 DD03L rows were present,
 * so an empty list is a read that did not see the stored definition rather than a valid definition.
 * Callers must not issue an activation fingerprint over it.
 */
function ddicFieldCount(definition: Record<string, unknown>): number {
  const fields = definition.fields
  return Array.isArray(fields) ? fields.length : 0
}

/**
 * Explain a version-history read that ADT answered with an unsupported endpoint.
 *
 * ECC 7.31 serves no structure resource for DDIC objects, so the canonical table path answers HTTP
 * 404 for every table, active or inactive. Reporting that as a capability fault made the caller stop
 * one step before its pre-write checks, so name the resource, the status and the substitutes.
 */
function unsupportedEndpointCause(error: VersionHistoryUnavailableError): string {
  const status = error.detail.httpStatus
  if (status === 404 || status === 405 || status === 501) {
    return (
      `ADT answered the structure request for ${error.detail.objectUri} with HTTP ${status}: this ` +
      "release serves no structure resource (or no version feed) for that object type, so no version " +
      "list can be read here. ECC 7.31 does this for every DDIC table, active or inactive."
    )
  }
  return (
    "ADT served no structure document for the resource this tool resolved for the object. The " +
    "repository-navigation URL that search returns for DDIC objects is not a structure resource; " +
    "when the canonical resource path is used and still yields nothing, the object type may simply " +
    "expose no version feed."
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

/**
 * D5-2/S1：`execute_data_query` 的**主路径**（原生 ADT 数据预览）也必须过白名单。
 *
 * 在此之前只有 RFC 后备路径（`table-query.ts` 的 `read_abap_table`）检查白名单，主路径把调用方
 * SQL 直接交给 `runQuery`，于是同一张被拒的表换个工具名就能读到。这里在**任何 SAP 访问之前**
 * 判定，并且表名枚举不出来时同样拒绝：说不清读哪张表就不能判白名单，猜一张等于取消白名单。
 */
export function assertQueryTablesAllowed(sql: string): string[] {
  const tables = selectedTableNames(maskSqlStrings(sql))
  if (!tables) {
    throw new Error(
      `${TABLE_ALLOWLIST_UNVERIFIABLE}: the query's tables cannot be enumerated statically ` +
        "(dynamic table name, missing FROM, or a comma-joined table list). Rewrite it as " +
        "SELECT ... FROM <table> [JOIN <table>]; nothing was sent to SAP."
    )
  }
  for (const table of tables) assertTableAllowed(table)
  return tables
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

type DdicKind =
  | "domain"
  | "dataElement"
  | "structure"
  | "transparentTable"
  | "tableType"
  | "searchHelp"
  | "lockObject"
  | "numberRangeObject"
  | "maintenanceView"

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
    ...(kind === "structure"
      ? {
          // The helper's field-set fingerprint (SHA1 over the active field rows), published as
          // FINGERPRINT. Unlike `fingerprint` above, which hashes this projection and therefore cannot
          // be reproduced inside SAP, it changes when a field is added or removed, so it is the token to
          // pass back as expectedVersion for upsert_append_structure_fields. Falls back to the header
          // version when an older helper does not publish it.
          guardToken: result.metadata.FINGERPRINT ?? result.objectVersion
        }
      : {}),
    definition,
    ...(result.metadata.CONVERSION_ACTION
      ? {
          nativeConversion: {
            action: result.metadata.CONVERSION_ACTION,
            mode: result.metadata.CONVERSION_MODE ?? "",
            dataLossReported: result.metadata.CONVERSION_DATA_LOSS === "X"
          }
        }
      : {})
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
  if (kind === "searchHelp") {
    // DD31V/DD32P/DD33V rows are exposed as their raw DDIC property bags so the caller sees
    // SAP's own column names. The key columns (SHLPNAME, SHPOSITION, FLPOSITION) are never
    // returned as caller input; they are reconstructed from the object name and the row order.
    return {
      description: result.header.DDTEXT ?? "",
      issimple: result.header.ISSIMPLE === "X",
      selectionMethod: result.header.SELMETHOD ?? "",
      selectionMethodType: result.header.SELMTYPE ?? "",
      textTable: result.header.TEXTTAB ?? "",
      selectionExit: result.header.SELMEXIT ?? "",
      hotkey: result.header.HOTKEY ?? "",
      dialogType: result.header.DIALOGTYPE ?? "",
      selectionMethods: result.selectionMethods,
      parameters: result.parameters,
      fieldAssignments: result.fieldAssignments
    }
  }
  if (kind === "numberRangeObject") {
    const texts = numberRangeStoredTexts(result)
    const helperLanguage = result.metadata.LANGUAGE ?? ""
    return {
      // The text of the helper logon language when it has one, otherwise the first language read.
      description: (texts.find((row) => row.language === helperLanguage) ?? texts[0])?.text ?? "",
      helperLanguage,
      // Number range intervals (NRIV) are outside this service: the flag only reports whether SAP
      // already assigned numbers for the object, and no tool here writes or deletes an interval.
      intervalExists: result.metadata.INTERVAL_EXISTS === "X",
      // Every TNRO field, with SAP's trailing padding removed. An empty string means the field is
      // empty in TNRO, not that the field is absent from the definition.
      properties: numberRangeStoredProperties(result),
      texts,
      ...(result.warnings.length > 0
        ? { warnings: result.warnings.map((row) => ({ ...row })) }
        : {})
    }
  }
  if (kind === "lockObject") {
    // DD26V/DD27P rows are exposed as their raw DDIC property bags so the caller sees SAP's own
    // column names. The key columns (VIEWNAME, TABPOS, OBJPOS) are never returned as caller input;
    // they are reconstructed from the object name and the row order.
    return {
      description: result.header.DDTEXT ?? "",
      aggregationType: result.header.AGGTYPE ?? "",
      rootTable: result.header.ROOTTAB ?? "",
      lockTables: result.lockTables,
      lockFields: result.lockFields
    }
  }
  if (kind === "maintenanceView") {
    // DD26V/DD27P/DD28V rows are exposed as their raw DDIC property bags so the caller sees SAP's own
    // column names. The key columns (VIEWNAME, TABPOS, OBJPOS, DDLANGUAGE) are never caller input:
    // the helper derives them from the object name and the row order. Only the DD27P identity columns
    // and the alias are writable; every other attribute here is derived by the activation.
    return {
      description: result.header.DDTEXT ?? "",
      viewClass: result.header.VIEWCLASS ?? "",
      aggregationType: result.header.AGGTYPE ?? "",
      rootTable: result.header.ROOTTAB ?? "",
      viewGrant: result.header.VIEWGRANT ?? "",
      customAuth: result.header.CUSTOMAUTH ?? "",
      globalFlag: result.header.GLOBALFLAG ?? "",
      readOnly: result.header.READONLY === "X",
      maintenanceLanguage: result.header.MASTERLANG ?? "",
      baseTables: result.baseTables,
      viewFields: result.viewFields,
      // Read-only: this service neither writes nor deletes DD28V selection conditions.
      selectionConditions: result.selectionConditions
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
      // D6-5: for an append structure (tableClass "APPEND") this is the base table it is attached
      // to. Empty for a plain structure. Without it a caller cannot see the append relation at all.
      baseTable: result.header.SQLTAB ?? "",
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
    const buffering =
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
          : "notAllowed"
    return {
      description: result.header.DDTEXT ?? "",
      tableClass: result.header.TABCLASS ?? "",
      deliveryClass: result.header.CONTFLAG ?? "",
      dataBrowserMaintenance:
        maintenance === "X" ? "allowed" : maintenance === "R" ? "restricted" : "notAllowed",
      sizeCategory: numberValue(result.header.TABKAT),
      dataClass: result.header.TABART ?? "",
      buffering,
      genericKeyFields: buffering === "generic" ? numberValue(result.header.SCHFELDANZ) : 0,
      logDataChanges: result.header.PROTOKOLL === "X",
      fields: result.fields.map((field) => {
        const componentKind = ddicComponentKind(field)
        return {
          name: field.FIELDNAME ?? "",
          position: numberValue(field.POSITION),
          dataElement: field.ROLLNAME ?? "",
          description: field.DDTEXT ?? "",
          key: field.KEYFLAG === "X",
          notNull: field.NOTNULL === "X",
          ...(componentKind === "field"
            ? {}
            : {
                componentKind,
                componentName: field.PRECFIELD ?? "",
                componentType: field.COMPTYPE ?? "",
                originDepth: numberValue(field.ADMINFIELD),
                groupName: field.GROUPNAME ?? "",
                extensionClass: field.EXCLASS ?? ""
              })
        }
      })
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
  expectedDefinition: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): string {
  requireDdicSuccess(result)
  const identityField = {
    domain: "DOMNAME",
    dataElement: "ROLLNAME",
    structure: "TABNAME",
    transparentTable: "TABNAME",
    tableType: "TYPENAME",
    searchHelp: "SHLPNAME",
    lockObject: "VIEWNAME",
    numberRangeObject: "OBJECT",
    maintenanceView: "VIEWNAME"
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
      recordedRequest: result.recordedRequest,
      ...extra
    },
    null,
    2
  )
}

/**
 * DD26V base table rows of a maintenance view. The key columns (VIEWNAME, TABPOS, DDLANGUAGE) are
 * written by the helper from the object name and the row order, so the caller only supplies the base
 * table and its join to the root table. The array is a complete replacement: DD_VIFD_PUT deletes the
 * stored rows of the version it writes before inserting these, so an omitted base table is removed.
 */
function maintenanceViewBaseTables(rows: MaintenanceViewBaseTableInput[]): SapStructureRow[] {
  if (rows.length === 0) throw new Error("baseTables must contain at least one base table")
  return rows.map((row, index) => {
    const entry: SapStructureRow = {
      TABNAME: ddicName(row.tableName, `baseTables[${index}].tableName`)
    }
    if (row.foreignTable?.trim()) {
      entry.FORTABNAME = ddicName(row.foreignTable, `baseTables[${index}].foreignTable`)
    }
    if (row.foreignField?.trim()) entry.FORFIELD = ddicFieldName(row.foreignField)
    // FORDIR's legal value set was not established from this system's source, so the value is passed
    // through to SAP's activation check instead of being restricted here.
    if (row.foreignDirection?.trim()) {
      entry.FORDIR = row.foreignDirection.trim().toUpperCase()
    }
    return entry
  })
}

/**
 * DD27P view field rows. Only the identity columns (TABNAME/FIELDNAME) and the optional alias
 * (VIEWFIELD) are caller input: every other DD27P attribute is derived by the activation from the
 * base table. Complete replacement, exactly like the base tables.
 */
function maintenanceViewViewFields(rows: MaintenanceViewFieldInput[]): SapStructureRow[] {
  if (rows.length === 0) throw new Error("viewFields must contain at least one view field")
  return rows.map((row, index) => {
    const entry: SapStructureRow = {
      TABNAME: ddicName(row.tableName, `viewFields[${index}].tableName`),
      FIELDNAME: ddicFieldName(row.fieldName)
    }
    if (row.viewField?.trim()) entry.VIEWFIELD = ddicFieldName(row.viewField)
    return entry
  })
}

/**
 * The DD25V header properties a caller may control. VIEWNAME, VIEWCLASS ('C'), AGGTYPE ('V'),
 * DDLANGUAGE/MASTERLANG (the helper logon language), DDTEXT (the description) and every AS4* field
 * are set by the helper or by the activation and are rejected by the helper with PROPERTY_READ_ONLY.
 */
function maintenanceViewHeader(
  header: MaintenanceViewHeaderInput | undefined,
  baseTables: SapStructureRow[]
): SapStructureRow {
  const entry: SapStructureRow = {}
  // ROOTTAB is consumed by the activation but never derived from the base tables, so it must be set;
  // the first base table is the documented default.
  const rootTable = header?.rootTable?.trim()
  entry.ROOTTAB = rootTable
    ? ddicName(rootTable, "header.rootTable")
    : (baseTables[0]?.TABNAME ?? "")
  const viewGrant = header?.viewGrant?.trim().toUpperCase()
  if (viewGrant) {
    if (!["R", "U", "M"].includes(viewGrant)) {
      throw new Error("header.viewGrant must be R, U or M")
    }
    entry.VIEWGRANT = viewGrant
  }
  const customAuth = header?.customAuth?.trim().toUpperCase()
  if (customAuth) {
    if (!["A", "C", "L", "G", "E", "S", "W"].includes(customAuth)) {
      throw new Error("header.customAuth must be one of A, C, L, G, E, S, W")
    }
    entry.CUSTOMAUTH = customAuth
  }
  const globalFlag = header?.globalFlag?.trim().toUpperCase()
  if (globalFlag) {
    if (!["N", "X"].includes(globalFlag)) throw new Error("header.globalFlag must be N or X")
    entry.GLOBALFLAG = globalFlag
  }
  return entry
}

/**
 * Verifies the activated maintenance view the helper published and renders the tool result.
 *
 * The helper already read the active version back after its single COMMIT, so this is a second,
 * independent reading of the same evidence: the object key, the package, the 14-digit version token,
 * the recorded transport request, the view class and the root table must all agree, and the base
 * tables and view fields must come back in the requested order.
 */
/**
 * Verify the append structure write. The helper itself compares the stored field rows with the
 * request after activating the base table, so this only re-checks the envelope and the counts the
 * caller depends on. A missing base table or a field count that differs from the request means the
 * helper verification did not run or described another object, so it fails instead of reporting a
 * partial write as success.
 */
function savedAppendStructureFieldsResult(
  result: SapDdicResult,
  objectName: string,
  connectionId: string,
  fields: SapStructureRow[]
): string {
  requireDdicSuccess(result)
  const baseTable = String(result.metadata.BASE_TABLE ?? "").trim()
  if (!baseTable) {
    throw new Error("SAP DDIC verification did not return the append structure base table")
  }
  const fieldCount = numberValue(result.metadata.FIELD_COUNT)
  if (fieldCount !== fields.length) {
    throw new Error(
      `SAP DDIC verification reported ${fieldCount} append fields instead of ${fields.length}`
    )
  }
  return JSON.stringify(
    {
      objectName,
      connectionId,
      baseTable,
      tableClass: "APPEND",
      changed: result.metadata.CHANGED === "X",
      fieldCount,
      baseFieldCount: numberValue(result.metadata.BASE_FIELD_COUNT),
      fields: fields.map((field) => field.FIELDNAME ?? "")
    },
    null,
    2
  )
}

function savedMaintenanceViewResult(
  result: SapDdicResult,
  objectName: string,
  packageName: string,
  connectionId: string,
  header: SapStructureRow,
  baseTables: SapStructureRow[],
  viewFields: SapStructureRow[]
): string {
  requireDdicSuccess(result)
  if (result.header.VIEWNAME !== objectName) {
    throw new Error(`SAP DDIC verification returned another view: ${result.header.VIEWNAME}`)
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
  if (result.header.VIEWCLASS !== "C") {
    throw new Error(`SAP stored view class ${result.header.VIEWCLASS || "<empty>"} instead of C`)
  }
  if (result.header.ROOTTAB !== header.ROOTTAB) {
    throw new Error("SAP DDIC verification did not store the requested root table")
  }
  // DD26V-FORTABNAME names the table a base table is joined to. When the caller requests no join,
  // SAP fills it with the root table (for a single base table root and base table are the same), so
  // an omitted value must be compared as the root table instead of as an empty string. Comparing
  // the raw caller value rejected correct writes: runtime evidence 2026-09-22 stored
  // FORTABNAME = ZORV_MCP_T01 while the request had sent no foreign table.
  const rootTableName = String(header.ROOTTAB ?? "").trim()
  const pickBaseTable = (row: SapStructureRow): SapStructureRow => ({
    TABNAME: row.TABNAME ?? "",
    FORTABNAME: (row.FORTABNAME ?? "").trim() || rootTableName,
    FORFIELD: row.FORFIELD ?? "",
    FORDIR: row.FORDIR ?? ""
  })
  const pickViewField = (row: SapStructureRow): SapStructureRow => ({
    TABNAME: row.TABNAME ?? "",
    FIELDNAME: row.FIELDNAME ?? "",
    VIEWFIELD: row.VIEWFIELD ?? ""
  })
  const expectedBaseTables = baseTables.map(pickBaseTable)
  const actualBaseTables = result.baseTables.map(pickBaseTable)
  if (JSON.stringify(actualBaseTables) !== JSON.stringify(expectedBaseTables)) {
    throw new Error("SAP DDIC verification did not return the requested base tables")
  }
  const expectedViewFields = viewFields.map((row) => ({
    ...pickViewField(row),
    VIEWFIELD: row.VIEWFIELD ?? row.FIELDNAME ?? ""
  }))
  const actualViewFields = result.viewFields.map(pickViewField)
  if (JSON.stringify(actualViewFields) !== JSON.stringify(expectedViewFields)) {
    throw new Error("SAP DDIC verification did not return the requested view fields")
  }
  return JSON.stringify(
    {
      ...ddicResult(result, "maintenanceView", objectName, connectionId),
      status: result.code,
      recordedRequest: result.recordedRequest,
      activation: {
        actMode: result.metadata.ACT_MODE ?? "",
        getState: "M",
        // AUTH_CHK='X' suppresses SAP's immediate database adaptation, so a non-empty DBACT would mean
        // the object is active but its database representation is not; the helper fails closed on it.
        authCheck: result.metadata.AUTH_CHK ?? "",
        dbAct: result.metadata.DBACT ?? "",
        rc: result.metadata.ACT_RC ?? "",
        putState: result.metadata.PUT_STATE ?? "",
        // The positional DD_VIEW_PUT switch the helper actually used: XXX__ writes the header, the
        // base tables and the view fields and deliberately skips the selection conditions and the
        // technical settings.
        ctrlViewPut: result.metadata.CTRL_VIEW_PUT ?? ""
      }
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

/**
 * TNRO key field. The number range object name reaches SAP through objectName, never through a
 * property, so a caller cannot disagree with itself about the key.
 */
const NUMBER_RANGE_KEY_FIELD = "OBJECT"

/**
 * The TNRO attributes of a number range object, in DDIC field order, each with the data element that
 * documents it. Read live from TNRO on w200 (SAP_BASIS 7.31 SP04); no entry is inferred from a name.
 * Every one of them is writable through upsert_number_range_object except the OBJECT key.
 */
const NUMBER_RANGE_OBJECT_FIELDS = [
  "DTELSOBJ", // NRSOBJNAM - sub-object data element
  "NRTAB", // NRTAB - group table name
  "NRINTFLD", // NRINTNR - internal number range number field name
  "NREXTFLD", // NRINTNR - external number range number field name
  "NRFLD", // NRNRNAME - number range number field name
  "NRSOBJFLD", // NRNRSUBOBJ - sub-object field name in the number range table
  "NRELEFLD", // NRNRELEM - number range element field name
  "YEARIND", // NRYEARIND - expiry-year flag
  "DOMLEN", // NRLENDOM - number length domain (a domain name, not a length)
  "PERCENTAGE", // NRPERC - warning percentage
  "CODE", // NRCODE - CUA interface code
  "TEXTIND", // NRTEXTIND - text indicator display element
  "NRELTXTTAB", // NRELTXTTAB - element text table name
  "NRELTXTSOB", // NRELTXTOBJ - sub-object field in the element text table
  "NRELTXTELE", // NRELTXTELE - element field in the element text table
  "NRELTXTTXT", // NRELTXTTXT - text field in the element text table
  "NRELTXTLNG", // NRELTXTLNG - language field in the element text table
  "BUFFER", // NRBUFFER - buffer flag
  "NOIVBUFFER", // NRIVBUFFER - number of numbers to keep in the buffer
  "NONRSWAP", // NRSWAP - no rolling intervals
  "RFCDEST", // RFCDEST - logical destination
  "NRCHECKASCII" // NRCHECKASCII - check external intervals for non-ASCII characters
] as const

/** Every TNRO field, i.e. the writable attributes plus the key that objectName supplies. */
const NUMBER_RANGE_ALL_FIELDS: readonly string[] = [
  NUMBER_RANGE_KEY_FIELD,
  ...NUMBER_RANGE_OBJECT_FIELDS
]

/**
 * TNRO-OBJECT is the NROBJ domain, CHAR 10, and the helper accepts only A-Z, 0-9 and _ on top of
 * that, so a namespaced /Z.../ name is not a number range object name.
 */
function numberRangeObjectName(value: string): string {
  const normalized = customerDdicName(value)
  if (!/^[A-Z0-9_]+$/.test(normalized)) {
    throw new Error("objectName must use characters A-Z, 0-9 and _ only")
  }
  if (normalized.length > 10) {
    throw new Error(
      "Number range object objectName must not exceed 10 characters (TNRO-OBJECT is NROBJ)"
    )
  }
  return normalized
}

/**
 * The concurrency token of a number range object is a SHA1 digest over its whole stored definition.
 * TNRO has neither AS4DATE nor AS4TIME, so there is no modification timestamp to compare and the
 * 14-digit DDIC token of the other read tools does not exist for this object kind.
 */
function numberRangeObjectVersion(value?: string): string | undefined {
  const normalized = value?.trim().toUpperCase()
  if (!normalized) return undefined
  if (!/^[0-9A-F]{40}$/.test(normalized)) {
    throw new Error(
      "expectedVersion must be the 40-character definition digest returned by read_number_range_object"
    )
  }
  return normalized
}

function requiredNumberRangeObjectVersion(value: string): string {
  const normalized = numberRangeObjectVersion(value)
  if (!normalized) throw new Error("expectedVersion is required")
  return normalized
}

/** Validates caller-supplied TNRO attributes against the field list TNRO actually has. */
function numberRangeProperties(properties: Record<string, string> | undefined): SapStructureRow {
  if (!properties) return {}
  const normalized: SapStructureRow = {}
  for (const [name, value] of Object.entries(properties)) {
    const field = name.trim().toUpperCase()
    if (field === NUMBER_RANGE_KEY_FIELD) {
      throw new Error(`properties must not carry ${NUMBER_RANGE_KEY_FIELD}; objectName is the key`)
    }
    if (
      !NUMBER_RANGE_OBJECT_FIELDS.includes(field as (typeof NUMBER_RANGE_OBJECT_FIELDS)[number])
    ) {
      throw new Error(`properties carries a field that TNRO does not have: ${name}`)
    }
    if (typeof value !== "string") throw new Error(`properties.${field} must be a string`)
    if (/[\r\n]/.test(value)) throw new Error(`properties.${field} must not contain line breaks`)
    normalized[field] = value
  }
  return normalized
}

/** Validates caller-supplied TNROT text rows and keys them the way the 'N1' payload rows expect. */
function numberRangeTexts(
  texts: Array<{ language: string; text: string; shortText?: string | undefined }> | undefined
): SapStructureRow[] {
  if (!texts || texts.length === 0) return []
  if (texts.length > 20) throw new Error("texts must not carry more than 20 languages in one call")
  const seen = new Set<string>()
  return texts.map((entry) => {
    const language = entry.language.trim().toUpperCase()
    if (!/^[A-Z]$/.test(language)) {
      throw new Error(`texts language must be a one-character SAP language: ${entry.language}`)
    }
    if (seen.has(language)) throw new Error(`texts carries language ${language} more than once`)
    seen.add(language)
    if (!entry.text.trim()) throw new Error(`texts text is required for language ${language}`)
    validateTextLength(entry.text, 60, "texts text")
    validateTextLength(entry.shortText ?? "", 20, "texts shortText")
    return {
      LANGU: language,
      TXT: entry.text,
      ...(entry.shortText === undefined ? {} : { TXTSHORT: entry.shortText })
    }
  })
}

/** SAP pads character values to the DDIC width; that padding is never significant for TNRO. */
function normalizeDdicValue(value: string): string {
  return value.replace(/\s+$/u, "")
}

function numberRangeStoredProperties(result: SapDdicResult): Record<string, string> {
  const properties: Record<string, string> = {}
  for (const field of NUMBER_RANGE_ALL_FIELDS) {
    properties[field] = normalizeDdicValue(result.header[field] ?? "")
  }
  return properties
}

function numberRangeStoredTexts(
  result: SapDdicResult
): Array<{ language: string; text: string; shortText: string }> {
  return result.numberRangeTexts
    .map((row) => ({
      language: (row.LANGU ?? "").trim(),
      text: normalizeDdicValue(row.TXT ?? ""),
      shortText: normalizeDdicValue(row.TXTSHORT ?? "")
    }))
    .filter((row) => row.language !== "")
    .sort((left, right) =>
      left.language < right.language ? -1 : left.language > right.language ? 1 : 0
    )
}

/**
 * Verifies a number range write against what SAP stored.
 *
 * The version token is a SHA1 definition digest, so the 14-digit timestamp test of savedDdicResult
 * cannot apply here. The helper already proved the recorded request and the E071 row; this checks what
 * it cannot prove on its own: identity, package, digest shape, the attributes the caller sent, and
 * every text row the caller sent.
 */
function savedNumberRangeObjectResult(
  result: SapDdicResult,
  objectName: string,
  packageName: string,
  connectionId: string,
  sentProperties: SapStructureRow,
  sentTexts: Array<{ language: string; text: string; shortText: string }>
): string {
  requireDdicSuccess(result)
  const storedName = result.header[NUMBER_RANGE_KEY_FIELD] ?? ""
  if (storedName !== objectName) {
    throw new Error(
      `SAP number range verification returned another object: ${storedName || "<empty>"}`
    )
  }
  if (result.packageName !== packageName.trim().toUpperCase()) {
    throw new Error(
      `SAP number range verification returned package ${result.packageName || "<empty>"}`
    )
  }
  if (!/^[0-9A-F]{40}$/.test(result.objectVersion)) {
    throw new Error("SAP number range verification did not return a definition digest version")
  }
  if (!result.recordedRequest) {
    throw new Error(
      "SAP number range verification did not return the recorded transport request or task"
    )
  }
  const storedProperties = numberRangeStoredProperties(result)
  // TNRO-PERCENTAGE is a percentage carrying one decimal (SAP stores 10 percent as "10.0"), while a
  // caller sends the plain percentage "10". The raw text therefore never matches even though the
  // stored value is the requested one, which made every create with PERCENTAGE report a false
  // failure after the write had already committed (runtime evidence 2026-09-22: read-back showed
  // PERCENTAGE "10.0" for the accepted request). Compare that one field numerically; every other
  // field keeps the exact text comparison.
  const storedValueMatches = (
    field: string,
    stored: string | undefined,
    expected: string
  ): boolean => {
    if (stored === expected) return true
    if (field !== "PERCENTAGE") return false
    if (stored === undefined || stored.trim() === "" || expected.trim() === "") return false
    const storedNumber = Number(stored)
    const expectedNumber = Number(expected)
    return (
      Number.isFinite(storedNumber) &&
      Number.isFinite(expectedNumber) &&
      storedNumber === expectedNumber
    )
  }
  for (const [field, value] of Object.entries(sentProperties)) {
    // NUMBER_RANGE_OBJECT_UPDATE normalises a set TEXTIND flag to 'X' before it stores the row.
    const expected = field === "TEXTIND" && value.trim() !== "" ? "X" : normalizeDdicValue(value)
    if (!storedValueMatches(field, storedProperties[field], expected)) {
      throw new Error(`SAP number range verification did not store ${field}`)
    }
  }
  const storedTexts = numberRangeStoredTexts(result)
  for (const text of sentTexts) {
    const stored = storedTexts.find((row) => row.language === text.language)
    if (
      !stored ||
      stored.text !== normalizeDdicValue(text.text) ||
      (text.shortText !== "" && stored.shortText !== normalizeDdicValue(text.shortText))
    ) {
      throw new Error(`SAP number range verification did not store the ${text.language} text`)
    }
  }
  return JSON.stringify(
    {
      ...ddicResult(result, "numberRangeObject", objectName, connectionId),
      status: result.code,
      recordedRequest: result.recordedRequest,
      ...(result.warnings.length > 0
        ? { warnings: result.warnings.map((row) => ({ ...row })) }
        : {})
    },
    null,
    2
  )
}

function containsLineSequence(actual: string[], expected: string[]): boolean {
  if (!expected.length || expected.length > actual.length) return false
  return actual.some(
    (_line, start) =>
      start + expected.length <= actual.length &&
      expected.every((line, offset) => actual[start + offset] === line)
  )
}

/**
 * Keys the helper reports on failure so a caller can judge the outcome instead of
 * guessing. COMPENSATED is the important one: "N" means the failed call could not
 * restore the object and it may still be inconsistent.
 *
 * The activation keys cover a second failure shape found on 2026-09-23 and root-caused on
 * 2026-09-24: the 1.13 helper reached the real activation branch but called `DD_TABL_ACT` with no
 * protocol channel, so `ACT_RESULT` kept its line-121 initial value 8 with an empty ACT_RES_TAB and
 * subrc stayed 0 (8 is not a success flag), and the object still had no active version, so the call
 * died in the post-activation verification with nothing but VERIFY_FAILED. Those rows carry the
 * activation return code, the act_res_tab row count, and the action/mode/dataloss the helper saw,
 * so the next failure names its cause. The 1.14 helper calls DDIF_TABL_ACTIVATE, which opens the
 * protocol first and returns no ACT_RES_TAB by design: the rows stay, ACT_RC keeps its meaning as
 * DD_TABL_ACT's ACT_RESULT, and ACT_ROWS is expected to be 0 on both paths.
 */
const APPEND_FAILURE_DETAIL_KEYS = [
  "APPEND",
  "BASE_TABLE",
  "CHANGED",
  "COMPENSATED",
  "COMPENSATION_REQUIRED",
  "BASE_MISMATCH",
  "REMOVED_FIELDS",
  "EXPECTED_FIELDS",
  "ACTUAL_FIELDS",
  "ACT_RC",
  "ACT_SUBRC",
  "ACT_ROWS",
  "ACT_ACTION",
  "ACT_MODE",
  "ACT_DATALOSS",
  "GOTSTATE",
  "RESUME",
  "PHASE",
  "PUT_SUBRC"
]

function appendFailureDetail(result: SapDdicResult): string {
  const detail: Record<string, string> = {}
  for (const key of APPEND_FAILURE_DETAIL_KEYS) {
    const value = result.metadata[key]
    if (value) detail[key] = value
  }
  return Object.keys(detail).length === 0 ? "" : `; details=${JSON.stringify(detail)}`
}

function requireDdicSuccess(result: SapDdicResult): void {
  if (result.status.toUpperCase() !== "S") {
    const conversion = result.metadata.CONVERSION_ACTION
      ? `; nativeConversion=${JSON.stringify({
          action: result.metadata.CONVERSION_ACTION,
          mode: result.metadata.CONVERSION_MODE ?? "",
          dataLossReported: result.metadata.CONVERSION_DATA_LOSS === "X"
        })}`
      : ""
    throw new Error(
      `SAP DDIC helper rejected the operation: ${result.code}: ${result.message}${conversion}` +
        appendFailureDetail(result)
    )
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

/**
 * The append write accepts either the 14-digit header token or the helper's field-set fingerprint.
 * The header token cannot see a field-level change, because DD_TBFD_PUT writes DD03P rows and never
 * touches DD02V, so the fingerprint is the only token that detects a lost update on this operation.
 * Uppercased because the helper publishes HASH160 in upper case and compares the token literally.
 */
function appendVersionToken(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (/^\d{14}$/.test(normalized)) return normalized
  if (/^[0-9A-F]{40}$/.test(normalized)) return normalized
  throw new Error(
    "expectedVersion must be the 14-digit version or the 40-character fingerprint returned by read_ddic_structure"
  )
}

function ddicFieldName(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (!/^[A-Z][A-Z0-9_]{0,29}$/.test(normalized)) {
    throw new Error(`Invalid structure field name: ${value}`)
  }
  return normalized
}

function ddicPackageName(value: string): string {
  // $TMP is accepted deliberately. It is the correct home for throwaway test objects, and it
  // leaves no transport entry behind: test DDIC objects created in a transportable package have
  // already left TADIR residue in this system that needed manual SE03 cleanup. Objects here stay
  // local to this system and are never promoted, which is what a test object should be. Every
  // other package name is still validated as before.
  if (value.trim().toUpperCase() === "$TMP") return "$TMP"
  const normalized = ddicName(value, "packageName")
  return normalized
}

/**
 * DDIC writes in $TMP need no transport at all, exactly like the source-object case already
 * handled by deletableSourcePackage. Without this, allowing $TMP in ddicPackageName would be
 * inert: every $TMP write was still refused by the mandatory 10-character transport check, so
 * no caller could actually use the local package. Non-$TMP packages keep the original rule.
 */
function ddicTransport(packageName: string, value: string): string {
  return ddicPackageName(packageName) === "$TMP" ? "" : transportNumber(value)
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

/**
 * Header properties of a search help that SAP derives or controls. The helper rejects them too,
 * but refusing them here keeps the failure local and gives the caller a usable message.
 * Mirrors the 'H' whitelist the D6-1b carrier installed in Z_ORVANTA_MCP_DDIC_API.
 */
const SEARCH_HELP_DERIVED_HEADER_PROPERTIES = new Set([
  "SHLPNAME",
  "ACTFLAG",
  "AS4USER",
  "AS4DATE",
  "AS4TIME",
  "ATTACHEXI",
  "ELEMEXI",
  "NOFIELDS",
  "DDLANGUAGE"
])

/** Key columns of DD31V/DD32P/DD33V are reconstructed by the service from the row order. */
const SEARCH_HELP_KEY_PROPERTIES = new Set(["SHLPNAME", "SHPOSITION", "FLPOSITION"])

const SEARCH_HELP_MAX_CHILD_ROWS = 200

/**
 * Header properties DD25V derives from the object itself or from the caller's SAP session.
 * Mirrors the guard the D6-2 DDIC branch applies before assigning into ls_dd30v.
 */
const LOCK_OBJECT_DERIVED_HEADER_PROPERTIES = new Set([
  "LOCKOBJECT",
  "VIEWNAME",
  "ACTFLAG",
  "AS4USER",
  "AS4DATE",
  "AS4TIME",
  "DDLANGUAGE"
])

/** Key columns of DD26V/DD27P are reconstructed by the service from the row order. */
const LOCK_OBJECT_KEY_PROPERTIES = new Set(["VIEWNAME", "TABPOS", "OBJPOS", "FLPOSITION"])

const LOCK_OBJECT_MAX_CHILD_ROWS = 200

function lockObjectHeader(input: Record<string, string> | undefined): SapStructureRow {
  const header: SapStructureRow = {}
  for (const [property, value] of Object.entries(input ?? {})) {
    const name = property.trim().toUpperCase()
    if (!name) throw new Error("lock object header property names must not be empty")
    if (LOCK_OBJECT_DERIVED_HEADER_PROPERTIES.has(name)) {
      throw new Error(`lock object header property ${name} is derived or server-controlled`)
    }
    if (/\r|\n/.test(value)) {
      throw new Error(`lock object header property ${name} must not contain line breaks`)
    }
    header[name] = value
  }
  return header
}

function lockObjectRows(
  rows: Array<Record<string, string>> | undefined,
  label: string
): SapStructureRow[] {
  const source = rows ?? []
  if (source.length > LOCK_OBJECT_MAX_CHILD_ROWS) {
    throw new Error(`${label} must not exceed ${LOCK_OBJECT_MAX_CHILD_ROWS} rows`)
  }
  return source.map((row, index) => {
    const entry: SapStructureRow = {}
    for (const [property, value] of Object.entries(row)) {
      const name = property.trim().toUpperCase()
      if (!name) throw new Error(`${label}[${index}] property names must not be empty`)
      if (LOCK_OBJECT_KEY_PROPERTIES.has(name)) {
        throw new Error(`${label}[${index}] property ${name} is reconstructed by the service`)
      }
      if (/\r|\n/.test(value)) {
        throw new Error(`${label}[${index}] property ${name} must not contain line breaks`)
      }
      entry[name] = value
    }
    return entry
  })
}

function searchHelpHeader(input: Record<string, string> | undefined): SapStructureRow {
  const header: SapStructureRow = {}
  for (const [property, value] of Object.entries(input ?? {})) {
    const name = property.trim().toUpperCase()
    if (!name) throw new Error("search help header property names must not be empty")
    if (SEARCH_HELP_DERIVED_HEADER_PROPERTIES.has(name)) {
      throw new Error(`search help header property ${name} is derived or server-controlled`)
    }
    if (/\r|\n/.test(value)) {
      throw new Error(`search help header property ${name} must not contain line breaks`)
    }
    header[name] = value
  }
  if ("ISSIMPLE" in header) {
    header.ISSIMPLE = header.ISSIMPLE?.trim().toUpperCase() === "X" ? "X" : ""
  }
  return header
}

function searchHelpRows(
  rows: Array<Record<string, string>> | undefined,
  label: string
): SapStructureRow[] {
  const source = rows ?? []
  if (source.length > SEARCH_HELP_MAX_CHILD_ROWS) {
    throw new Error(`${label} must not exceed ${SEARCH_HELP_MAX_CHILD_ROWS} rows`)
  }
  return source.map((row, index) => {
    const entry: SapStructureRow = {}
    for (const [property, value] of Object.entries(row)) {
      const name = property.trim().toUpperCase()
      if (!name) throw new Error(`${label}[${index}] property names must not be empty`)
      if (SEARCH_HELP_KEY_PROPERTIES.has(name)) {
        throw new Error(`${label}[${index}] property ${name} is reconstructed by the service`)
      }
      if (/\r|\n/.test(value)) {
        throw new Error(`${label}[${index}] property ${name} must not contain line breaks`)
      }
      entry[name] = value
    }
    return entry
  })
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

/**
 * DD03P-REFTABLE/REFFIELD for a quantity or currency table field.
 *
 * Both halves must be supplied or neither. DDIC activation refuses a QUAN/CURR field that names no
 * unit ("specify reference table and reference field"), and a lone half names no usable reference,
 * so an unpaired half is a caller error rather than a silently ignored input. Verified live on
 * 2026-09-24: this is the only activation blocker once every field resolves to an active data
 * element.
 */
function tableFieldReference(field: DdicTableFieldReference): Record<string, string> {
  const referenceTable = field.referenceTable?.trim() ?? ""
  const referenceField = field.referenceField?.trim() ?? ""
  if (!referenceTable && !referenceField) return {}
  if (!referenceTable || !referenceField) {
    throw new Error(
      "referenceTable and referenceField must be supplied together: a quantity or currency field needs both, and neither half is usable alone"
    )
  }
  return {
    REFTABLE: ddicName(referenceTable, "referenceTable"),
    REFFIELD: ddicFieldName(referenceField)
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
      NOTNULL: "X",
      ...tableFieldReference(field)
    }
  })
}

function validateAppendedTransparentTableFields(
  input: AppendTransparentTableFieldsInput["fields"]
): TransparentTableFieldRow[] {
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
      NOTNULL: "",
      ...tableFieldReference(field)
    }
  })
}

interface TransparentTableTechnicalSettings {
  dataClass: "APPL0" | "APPL1" | "APPL2"
  sizeCategory: number
  buffering: TransparentTableBuffering
  genericKeyFields: number
  logDataChanges: boolean
}

function requiredDdicFingerprint(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("expectedFingerprint must be returned by read_ddic_transparent_table")
  }
  return normalized
}

/**
 * Which DD09V technical settings the helper actually published.
 *
 * The active path emits them as `H` rows (TABART/TABKAT/BUFALLOW/PUFFERUNG); the inactive path does
 * not emit them at all, so an empty `dataClass` there means "not reported by this helper", not
 * "empty in SAP". The distinction decides whether activation may proceed, so it is computed from
 * the raw payload keys rather than from the mapped, defaulted values.
 */
function technicalSettingsReported(result: SapDdicResult): boolean {
  return ["TABART", "TABKAT", "BUFALLOW", "PUFFERUNG"].some(
    (key) => key in result.header || key in result.metadata
  )
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

/**
 * The Include and Append components of a read transparent-table row set, in row order.
 *
 * A table that uses components stores them as pseudo-rows whose FIELDNAME starts with `.INCLU` and
 * whose PRECFIELD names the component. Those rows, and the verbatim inline copies of the component's
 * fields that follow them, belong to the component, not to the table: writing the table's own DD03L
 * row set replaces only the table's rows and leaves the component's own definition untouched, so a
 * change aimed at a component-owned field would either be lost or silently diverge. Inline copies are
 * told apart from the table's own fields by ADMINFIELD (1 versus 0), not by row position: a table may
 * keep its own direct fields between two components. Live example: base `ZXF_TEST2` carries
 * `.INCLU--AP` -> `ZXF_TEST2_APP` followed by the twelve inline copies of that append's fields.
 */
function transparentTableComponents(
  current: SapStructureRow[]
): { marker: string; name: string }[] {
  const components: { marker: string; name: string }[] = []
  const seen = new Set<string>()
  for (const field of current) {
    if (!isDdicComponentMarker(field)) continue
    const name = (field.PRECFIELD ?? "").trim().toUpperCase()
    if (name === "" || seen.has(name)) continue
    seen.add(name)
    components.push({ marker: field.FIELDNAME ?? "", name })
  }
  return components
}

function applyTransparentTableRawFieldChanges(
  current: SapStructureRow[],
  changes: TransparentTableFieldChange[]
): SapStructureRow[] {
  const fields = current.map((field) => ({ ...field }))
  const components = transparentTableComponents(current)
  const componentNames = components.map((component) => component.name)
  // A field that exists in the row set but is not a direct field of the table is component-owned:
  // refusing it by name is the difference between "does not exist" and "is owned by ZCMCP_APPEND".
  // A direct field that carries no active data element is reported as not editable by this tool
  // instead of being denied existence: on real customer tables most typed fields have no ROLLNAME.
  const unknownField = (fieldName: string): never => {
    const existing = fields.find((field) => field.FIELDNAME === fieldName)
    if (existing) {
      if (!isDirectDdicField(existing) && existing.ROLLNAME) {
        throw new Error(
          `COMPONENT_FIELD_NOT_PATCHABLE: ${fieldName} belongs to an Include/Append component ` +
            `(${componentNames.join(", ") || "<unnamed>"}); patch that component's own object instead`
        )
      }
      throw new Error(
        `FIELD_NOT_EDITABLE: ${fieldName} exists in the layout but is not a direct field with an ` +
          `active data element, so this tool cannot change it`
      )
    }
    throw new Error(`Transparent table field does not exist: ${fieldName}`)
  }
  for (const change of changes) {
    const fieldName = ddicFieldName(change.fieldName)
    if (fieldName === "MANDT") throw new Error("MANDT cannot be changed")
    const index = fields.findIndex(
      (field) => isDirectDdicField(field) && field.FIELDNAME === fieldName
    )
    if (index < 0) unknownField(fieldName)
    if (change.action === "remove") {
      fields.splice(index, 1)
      continue
    }
    if (change.action === "rename") {
      const newName = ddicFieldName(change.newName)
      if (newName === "MANDT") throw new Error("A field cannot be renamed to MANDT")
      if (newName === fieldName) throw new Error(`Field rename is a no-op: ${fieldName}`)
      if (fields.some((field, fieldIndex) => fieldIndex !== index && field.FIELDNAME === newName)) {
        throw new Error(`Transparent table field already exists: ${newName}`)
      }
      fields[index]!.FIELDNAME = newName
      continue
    }
    if (
      change.dataElement === undefined &&
      change.key === undefined &&
      change.notNull === undefined &&
      change.referenceTable === undefined &&
      change.referenceField === undefined
    ) {
      throw new Error(`Field update has no attributes: ${fieldName}`)
    }
    const field = fields[index]!
    const updated: SapStructureRow = {
      ...field,
      ROLLNAME:
        change.dataElement === undefined
          ? (field.ROLLNAME ?? "")
          : ddicName(change.dataElement, "dataElement"),
      KEYFLAG: change.key === undefined ? (field.KEYFLAG ?? "") : change.key ? "X" : "",
      NOTNULL: change.notNull === undefined ? (field.NOTNULL ?? "") : change.notNull ? "X" : "",
      ...tableFieldReference(change)
    }
    if (
      updated.ROLLNAME === field.ROLLNAME &&
      updated.KEYFLAG === field.KEYFLAG &&
      updated.NOTNULL === field.NOTNULL &&
      (updated.REFTABLE ?? "") === (field.REFTABLE ?? "") &&
      (updated.REFFIELD ?? "") === (field.REFFIELD ?? "")
    ) {
      throw new Error(`Field update is a no-op: ${fieldName}`)
    }
    fields[index] = updated
  }
  const physicalFields = fields.filter((field) => !isDdicComponentMarker(field))
  if (!physicalFields.length) throw new Error("A transparent table must retain at least one field")
  let nonKeySeen = false
  for (const field of physicalFields) {
    const key = field.KEYFLAG === "X"
    if (!key) nonKeySeen = true
    if (key && nonKeySeen) throw new Error("Key fields must be contiguous at the beginning")
    if (key && field.NOTNULL !== "X") {
      throw new Error(`Key field must be not null: ${field.FIELDNAME ?? "<unknown>"}`)
    }
  }
  fields.forEach((field, index) => {
    field.POSITION = String(index + 1)
  })
  if (JSON.stringify(fields) === JSON.stringify(current)) {
    throw new Error("Transparent table field patch does not change the active definition")
  }
  return fields
}

function serializeDdicTableFields(fields: SapStructureRow[]): SapStructureRow[] {
  const properties = [
    "FIELDNAME",
    "ROLLNAME",
    "KEYFLAG",
    "NOTNULL",
    "REFTABLE",
    "REFFIELD",
    "PRECFIELD",
    "COMPTYPE",
    "ADMINFIELD",
    "GROUPNAME",
    "EXCLASS"
  ]
  return fields.map((field) =>
    Object.fromEntries(
      properties
        .filter((property) => field[property] !== undefined)
        .map((property) => [property, field[property] ?? ""])
    )
  )
}

function appendTransparentTableRawFields(
  current: SapStructureRow[],
  appended: TransparentTableFieldRow[]
): SapStructureRow[] {
  const fields = current.map((field) => ({ ...field }))
  const appendIndex = fields.findIndex((field) => field.FIELDNAME?.startsWith(".INCLU--AP"))
  fields.splice(appendIndex < 0 ? fields.length : appendIndex, 0, ...appended)
  fields.forEach((field, index) => {
    field.POSITION = String(index + 1)
  })
  return fields
}

function isDdicComponentMarker(field: SapStructureRow): boolean {
  return (field.FIELDNAME ?? "").startsWith(".INCLU")
}

function isDirectDdicField(field: SapStructureRow): boolean {
  return (
    !isDdicComponentMarker(field) &&
    numberValue(field.ADMINFIELD) === 0 &&
    !!field.ROLLNAME &&
    (!field.COMPTYPE || field.COMPTYPE === "E")
  )
}

function ddicComponentKind(field: SapStructureRow): "field" | "include" | "append" | "inherited" {
  if ((field.FIELDNAME ?? "").startsWith(".INCLU--AP")) return "append"
  if (isDdicComponentMarker(field)) return "include"
  if (numberValue(field.ADMINFIELD) > 0) return "inherited"
  return "field"
}

function mergeTransparentTableSettings(
  current: Record<string, unknown>,
  patch: PatchTransparentTableSettingsInput["settings"]
): TransparentTableTechnicalSettings {
  const dataClass = patch.dataClass ?? current.dataClass
  if (!["APPL0", "APPL1", "APPL2"].includes(String(dataClass))) {
    throw new Error("Current data class is outside the supported technical-settings contract")
  }
  const sizeCategory = patch.sizeCategory ?? Number(current.sizeCategory)
  if (!Number.isInteger(sizeCategory) || sizeCategory < 0 || sizeCategory > 4) {
    throw new Error("sizeCategory must be an integer from 0 to 4")
  }
  const buffering = patch.buffering ?? current.buffering
  if (
    !["notAllowed", "allowedButOff", "singleRecord", "generic", "full"].includes(String(buffering))
  ) {
    throw new Error("Current buffering mode is outside the supported technical-settings contract")
  }
  const keyCount = Array.isArray(current.fields)
    ? current.fields.filter((value) => (value as Record<string, unknown>).key === true).length
    : 0
  const genericKeyFields =
    buffering === "generic" ? (patch.genericKeyFields ?? Number(current.genericKeyFields ?? 0)) : 0
  if (patch.genericKeyFields !== undefined && buffering !== "generic") {
    throw new Error("genericKeyFields is allowed only for generic buffering")
  }
  if (buffering === "generic" && (genericKeyFields < 1 || genericKeyFields > keyCount)) {
    throw new Error("genericKeyFields must be between 1 and the number of key fields")
  }
  const result: TransparentTableTechnicalSettings = {
    dataClass: dataClass as "APPL0" | "APPL1" | "APPL2",
    sizeCategory,
    buffering: buffering as TransparentTableBuffering,
    genericKeyFields,
    logDataChanges: patch.logDataChanges ?? current.logDataChanges === true
  }
  const previous = {
    dataClass: current.dataClass,
    sizeCategory: current.sizeCategory,
    buffering: current.buffering,
    genericKeyFields: Number(current.genericKeyFields ?? 0),
    logDataChanges: current.logDataChanges === true
  }
  if (JSON.stringify(result) === JSON.stringify(previous)) {
    throw new Error("Transparent table technical-settings patch is a no-op")
  }
  return result
}

function technicalSettingsHeader(settings: TransparentTableTechnicalSettings): SapStructureRow {
  const buffering = {
    notAllowed: { BUFALLOW: "N", PUFFERUNG: "" },
    allowedButOff: { BUFALLOW: "A", PUFFERUNG: "" },
    singleRecord: { BUFALLOW: "X", PUFFERUNG: "P" },
    generic: { BUFALLOW: "X", PUFFERUNG: "G" },
    full: { BUFALLOW: "X", PUFFERUNG: "X" }
  }[settings.buffering]
  return {
    TABART: settings.dataClass,
    TABKAT: String(settings.sizeCategory),
    ...buffering,
    SCHFELDANZ: settings.buffering === "generic" ? String(settings.genericKeyFields) : "",
    PROTOKOLL: settings.logDataChanges ? "X" : ""
  }
}

function normalizeConversionEntry(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    [
      "OBJECT",
      "TABNAME",
      "INDNAME",
      "TGORDER",
      "FCT",
      "EXECMODE",
      "SEVERITY",
      "GDATE",
      "GUSER"
    ].map((key) => [
      key,
      String(value[key] ?? "")
        .trim()
        .toUpperCase()
    ])
  )
}

function conversionEntryKey(value: Record<string, string>): string {
  return [
    value.OBJECT,
    value.TABNAME,
    value.INDNAME,
    value.TGORDER,
    value.FCT,
    value.EXECMODE,
    value.SEVERITY,
    value.GDATE,
    value.GUSER
  ].join("|")
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

/**
 * One parsed interface parameter as the payload serializers see it. `refField` is the raw
 * LIKEFIELD reference (`DBFIELD` for IMPORTING/EXPORTING/CHANGING, `DBSTRUCT` for TABLES) restored
 * from the raw read payload by `functionSnapshotFields`, because the comparable interface folds it
 * into `typeName` and the helper's own emitter writes it as its own row.
 */
interface SerializableFunctionParameter {
  name: string
  typeName: string
  optional?: boolean
  passByValue?: boolean
  description?: string
  refField?: string
}

/** Raw LIKEFIELD reference per `kind` and 1-based parameter index, taken from the read payload. */
function functionSnapshotFields(
  value: ReturnType<typeof functionModuleResult>
): Map<string, string> {
  const fields = new Map<string, string>()
  for (const line of value.snapshotPayload) {
    const parts = line.split("|")
    const kind = parts[0] ?? ""
    if (!/^[IECT]$/.test(kind) || parts[2] !== "DBFIELD") continue
    fields.set(`${kind}|${parts[1] ?? ""}`, parts.slice(3).join("|"))
  }
  return fields
}

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
    // The LIKEFIELD reference is folded into `typeName` for the comparable interface, so it is
    // deliberately not exposed as a separate key: `interfaceFingerprint` and the read-back
    // comparison stay exactly as they were. The expected snapshot restores the raw `DBFIELD` /
    // `DBSTRUCT` row from the read payload instead (see `functionSnapshotFields`).
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

/**
 * Canonical `kind|index|property|value` rows of the expected interface snapshot.
 *
 * Describes the payload shape the helper's `PATCH_FUNCTION_INTERFACE` guard parses: it rebuilds the
 * whole interface from the payload rows and compares it against its own `RPY_FUNCTIONMODULE_READ`
 * read of the active function module. NOTE: that guard validates and documents the interface; on
 * SAP_BASIS 7.31 the branch has no interface-parameter write path (see patchFunctionModuleInterface),
 * so these rows describe the *expected* snapshot, not a write that this platform performs.
 * Its own emitter writes a fixed property set per direction, and the comparison
 * runs over the complete `RSIMP`/`RSEXP`/`RSCHA`/`RSTBL` row, so a property the payload never
 * mentions keeps whatever value the surrounding row carries. Passing the repository read back
 * verbatim therefore only works while that read happens to carry exactly the same properties.
 *
 * Deriving the snapshot from the parsed interface instead makes the payload complete and
 * deterministic: every direction emits exactly the properties the helper's own emitter writes,
 * in the same order, so a property cannot silently disappear with the shape of one read.
 *
 * `OPTIONAL` is skipped for `E` because `RSEXP` has no such component and `LIKEFIELD`(DBFIELD),
 * `TYPES`, `CLASS`, `REF_CLASS`, `LINE_OF` and `TABLE_OF` carry no value through this interface,
 * so both sides leave them initial. `TEXT` is emitted only where the helper's own emitter writes
 * it: from the parameter documentation, i.e. never for an empty description.
 */
const functionSnapshotProperties: Record<
  FunctionParameterKind,
  ReadonlyArray<{ property: string; key: keyof SerializableFunctionParameter }>
> = {
  I: [
    { property: "PARAMETER", key: "name" },
    { property: "TYP", key: "typeName" },
    { property: "DBFIELD", key: "refField" },
    { property: "OPTIONAL", key: "optional" },
    { property: "PASSVALUE", key: "passByValue" },
    { property: "TEXT", key: "description" }
  ],
  E: [
    { property: "PARAMETER", key: "name" },
    { property: "TYP", key: "typeName" },
    { property: "DBFIELD", key: "refField" },
    { property: "PASSVALUE", key: "passByValue" },
    { property: "TEXT", key: "description" }
  ],
  C: [
    { property: "PARAMETER", key: "name" },
    { property: "TYP", key: "typeName" },
    { property: "DBFIELD", key: "refField" },
    { property: "OPTIONAL", key: "optional" },
    { property: "PASSVALUE", key: "passByValue" },
    { property: "TEXT", key: "description" }
  ],
  T: [
    { property: "PARAMETER", key: "name" },
    { property: "TYP", key: "typeName" },
    { property: "DBSTRUCT", key: "typeName" },
    { property: "OPTIONAL", key: "optional" },
    { property: "TEXT", key: "description" }
  ]
}

/**
 * Expected-snapshot rows for one parameter direction, built from the parsed interface with the
 * helper's canonical property set. Every defined property is emitted even when its value is
 * initial, so the helper's comparison sees the row the service intends instead of whatever shape
 * one repository read happened to return. `TEXT` (documentation) is emitted only for a non-empty
 * description, exactly as the helper's own emitter does; `DBFIELD`/`DBSTRUCT` falls back to the
 * read's raw LIKEFIELD row, and to an initial value when the read carried no value for it.
 */
function appendFunctionSnapshotParameters(
  payload: string[],
  kind: FunctionParameterKind,
  parameters: ReadonlyArray<SerializableFunctionParameter>,
  fields: Map<string, string>
): void {
  parameters.forEach((parameter, index) => {
    const indexText = String(index + 1)
    functionSnapshotProperties[kind].forEach(({ property, key }) => {
      const value =
        key === "refField" ? (fields.get(`${kind}|${indexText}`) ?? "") : (parameter[key] ?? "")
      if (typeof value === "boolean") {
        appendFunctionPayload(payload, kind, index + 1, property, value ? "X" : "")
        return
      }
      if (property === "TEXT" && value === "") return
      appendFunctionPayload(payload, kind, index + 1, property, value)
    })
  })
}

/**
 * Complete expected snapshot the helper compares under its own lock, as lowercase payload rows.
 *
 * Parameter rows are rebuilt from the parsed interface so that all four directions always carry
 * the helper's canonical properties; source rows are rebuilt from the parsed implementation so
 * the helper's own source comparison still matches. The `M|` rows come first, exactly as in a
 * repository read payload; the helper's pre-write guard ignores them, so they carry no interface
 * meaning and only keep the payload self-describing.
 */
function serializeFunctionSnapshot(value: ReturnType<typeof functionModuleResult>): string[] {
  const payload: string[] = []
  const metadata: ReadonlyArray<[string, string]> = [
    ["FUNCTION_GROUP", value.functionGroup],
    ["SHORT_TEXT", value.shortText],
    ["REMOTE_ENABLED", value.remoteMode],
    ["UPDATE_TASK", value.updateTaskMode],
    ["GLOBAL_INTERFACE", value.globalInterface ? "X" : ""],
    ["SOURCE_FORMAT", "PLAIN"],
    ["SOURCE_LINES", String(value.source.length)]
  ]
  metadata.forEach(([property, propertyValue]) =>
    appendFunctionPayload(payload, "M", 1, property, propertyValue)
  )
  const fields = functionSnapshotFields(value)
  appendFunctionSnapshotParameters(payload, "I", value.importParameters, fields)
  appendFunctionSnapshotParameters(payload, "E", value.exportParameters, fields)
  appendFunctionSnapshotParameters(payload, "C", value.changingParameters, fields)
  appendFunctionSnapshotParameters(payload, "T", value.tableParameters, fields)
  value.exceptions.forEach((exception, index) => {
    appendFunctionPayload(payload, "X", index + 1, "EXCEPTION", exception.name)
    if (exception.description !== "") {
      appendFunctionPayload(payload, "X", index + 1, "TEXT", exception.description)
    }
  })
  value.source.forEach((line, index) =>
    appendFunctionPayload(payload, "S", index + 1, "LINE", line)
  )
  return payload
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

/**
 * Normalize a caller-supplied replacement body exactly like the helper does before inserting it.
 *
 * Accepted input is either the body on its own or a complete function include: when the text
 * starts with `FUNCTION`, everything from the interface separator onwards is used; a trailing
 * `ENDFUNCTION.` line is always dropped, because the helper re-inserts the existing end of the
 * generated skeleton itself. Lines are right-trimmed and leading/trailing blank lines removed,
 * so the body hash is byte-identical on both sides.
 */
function normalizeFunctionBody(source: string[]): string[] {
  const lines = source.map((line) => line.trimEnd())
  let start = 0
  const firstNonBlank = lines.find((line) => line.trim() !== "") ?? ""
  if (/^FUNCTION\b/i.test(firstNonBlank.trim())) {
    const separators = lines
      .map((line, index) => (/^\*"-+$/.test(line.trim()) ? index : -1))
      .filter((index) => index >= 0)
    start = separators.length >= 2 ? separators[1]! + 1 : 0
  }
  let end = lines.length
  for (let index = lines.length - 1; index >= start; index -= 1) {
    if (/^ENDFUNCTION\./i.test(lines[index]!.trim())) {
      end = index
      break
    }
  }
  const body = lines.slice(start, end)
  while (body.length && body[0]!.trim() === "") body.shift()
  while (body.length && body.at(-1)!.trim() === "") body.pop()
  return body
}

/** Body digest convention shared with the helper: sha256 over the LF-joined body lines. */
function functionBodyHash(body: string[]): string {
  return createHash("sha256").update(body.join("\n")).digest("hex")
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

function enhancementPayload(metadata: Record<string, string>): string[] {
  const payload: string[] = []
  Object.entries(metadata).forEach(([name, value]) =>
    appendEnhancementPayload(payload, "M", 1, name, value)
  )
  return payload
}

function appendEnhancementRows(
  payload: string[],
  kind: string,
  rows: Array<Record<string, string>>
): void {
  rows.forEach((row, index) =>
    Object.entries(row).forEach(([name, value]) =>
      appendEnhancementPayload(payload, kind, index + 1, name, value)
    )
  )
}

function appendEnhancementPayload(
  payload: string[],
  kind: string,
  index: number,
  property: string,
  value: string
): void {
  const normalizedProperty = property.trim().toUpperCase()
  if (!/^[A-Z0-9_]+$/.test(normalizedProperty)) {
    throw new Error(`Invalid enhancement payload property: ${property}`)
  }
  const escaped = value.replaceAll("%", "%25").replaceAll("|", "%7C")
  const line = `${kind}|${index}|${normalizedProperty}|${escaped}`
  if (line.length > 255) throw new Error("Enhancement payload line exceeds ABAPTXT255")
  payload.push(line)
}

function hookEnhancementPayload(input: CreateEnhancementHookInput): string[] {
  if (input.source.some((line) => /^\s*(?:END)?ENHANCEMENT\b/i.test(line))) {
    throw new Error("source must contain only the enhancement body")
  }
  const payload = enhancementPayload({
    ORIGINAL_OBJECT_TYPE: input.originalObjectType,
    ORIGINAL_OBJECT_NAME: input.originalObjectName.toUpperCase(),
    MAIN_OBJECT_TYPE: input.mainObjectType,
    MAIN_OBJECT_NAME: input.mainObjectName.toUpperCase(),
    PROGRAM_NAME: input.programName.toUpperCase(),
    FULL_NAME: input.fullName,
    MODE: input.mode,
    REPLACEMENT: input.replacement ? "X" : ""
  })
  input.source.forEach((line, index) =>
    appendEnhancementPayload(payload, "S", index + 1, "LINE", line)
  )
  return payload
}

function newBadiEnhancementPayload(input: CreateNewBadiImplementationInput): string[] {
  const payload = enhancementPayload({
    SPOT_NAME: input.spotName.toUpperCase(),
    BADI_NAME: input.badiName.toUpperCase(),
    IMPLEMENTATION_NAME: customerEnhancementName(input.implementationName, "implementationName"),
    IMPLEMENTATION_CLASS: customerEnhancementName(
      input.implementationClass,
      "implementationClass",
      30
    ),
    DEFAULT_IMPLEMENTATION: input.defaultImplementation ? "X" : ""
  })
  appendEnhancementRows(payload, "F", input.filters ?? [])
  return payload
}

function hookEnhancementUpdatePayload(input: UpdateEnhancementHookInput): string[] {
  if (input.source.some((line) => /^\s*(?:END)?ENHANCEMENT\b/i.test(line))) {
    throw new Error("source must contain only the enhancement body")
  }
  const payload = enhancementPayload({ EXTID: input.extId })
  input.source.forEach((line, index) =>
    appendEnhancementPayload(payload, "S", index + 1, "LINE", line)
  )
  return payload
}

function newBadiEnhancementUpdatePayload(
  input: UpdateNewBadiImplementationInput,
  implementationName: string,
  implementationClass: string
): string[] {
  const payload = enhancementPayload({
    IMPLEMENTATION_NAME: implementationName,
    IMPLEMENTATION_CLASS: implementationClass,
    ACTIVE: input.active ? "X" : "",
    DEFAULT_IMPLEMENTATION: input.defaultImplementation ? "X" : ""
  })
  appendEnhancementRows(payload, "F", input.filters)
  return payload
}

function enhancementImplementationResult(connectionId: string, lines: string[]) {
  const metadata: Record<string, string> = {}
  const hookImplementations: Array<Record<string, string>> = []
  const badiImplementations: Array<Record<string, string>> = []
  const filters: Array<Record<string, string>> = []
  const sourceRows: Array<Record<string, string>> = []
  for (const line of lines) {
    const match = line.match(/^([MHBFNS])\|(\d+)\|([A-Z0-9_]+)\|(.*)$/)
    if (!match?.[1] || !match[2] || !match[3]) {
      throw new Error(`SAP repository helper returned an invalid enhancement payload line: ${line}`)
    }
    const index = Number.parseInt(match[2], 10)
    if (index < 1)
      throw new Error(`SAP repository helper returned an invalid payload index: ${line}`)
    const value = (match[4] ?? "").replaceAll("%7C", "|").replaceAll("%25", "%")
    const target =
      match[1] === "M"
        ? metadata
        : rowAtRepository(
            match[1] === "H"
              ? hookImplementations
              : match[1] === "B"
                ? badiImplementations
                : match[1] === "F"
                  ? filters
                  : sourceRows,
            index
          )
    target[match[3]] = value
  }
  const hookSources: string[][] = hookImplementations.map(() => [])
  for (const row of sourceRows) {
    const hookIndex = Number.parseInt(row.HOOK_INDEX ?? "", 10)
    const lineNumber = Number.parseInt(row.LINE_NUMBER ?? "", 10)
    if (
      !Number.isSafeInteger(hookIndex) ||
      hookIndex < 1 ||
      hookIndex > hookImplementations.length
    ) {
      throw new Error("SAP repository helper returned an invalid hook source owner")
    }
    if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) {
      throw new Error("SAP repository helper returned an invalid hook source line number")
    }
    hookSources[hookIndex - 1]![lineNumber - 1] = row.LINE ?? ""
  }
  const normalizedHooks = hookImplementations.map((row, index) => ({
    spotName: row.SPOT_NAME ?? "",
    programName: row.PROGRAM_NAME ?? "",
    extId: row.EXTID ?? "",
    id: row.ID ?? "",
    overwriteRaw: row.OVERWRITE ?? "",
    replacement: row.OVERWRITE === "X",
    methodRaw: row.METHOD ?? "",
    method: row.METHOD === "X",
    mode: row.MODE ?? "",
    fullName: row.FULL_NAME ?? "",
    parentFullName: row.PARENT_FULL_NAME ?? "",
    sourceCount: Number.parseInt(row.SOURCE_COUNT ?? "0", 10) || 0,
    source: hookSources[index] ?? []
  }))
  const normalizedBadis = badiImplementations.map((row) => {
    const implementationName = row.IMPL_NAME ?? ""
    return {
      spotName: row.SPOT_NAME ?? "",
      badiName: row.BADI_NAME ?? "",
      implementationName,
      implementationClass: row.IMPL_CLASS ?? "",
      activeRaw: row.ACTIVE ?? "",
      active: row.ACTIVE === "X",
      defaultRaw: row.IS_DEFAULT ?? "",
      defaultImplementation: row.IS_DEFAULT === "X",
      shortText: row.SHORT_TEXT ?? "",
      filters: normalizedEnhancementFilters(
        filters.filter(
          (filter) =>
            !filter.IMPLEMENTATION_NAME || filter.IMPLEMENTATION_NAME === implementationName
        )
      )
    }
  })
  const definition = {
    name: metadata.NAME ?? "",
    tool: metadata.TOOL ?? "",
    shortText: metadata.SHORT_TEXT ?? "",
    activeRaw: metadata.ACTIVE ?? "",
    active: metadata.ACTIVE === "X",
    inactiveRaw: metadata.INACTIVE ?? "",
    hasInactiveVersion: metadata.INACTIVE === "X",
    savedInactiveRaw: metadata.SAVED_INACTIVE ?? "",
    hasSavedInactiveVersion: metadata.SAVED_INACTIVE === "X",
    unsavedInactiveRaw: metadata.UNSAVED_INACTIVE ?? "",
    hasUnsavedInactiveVersion: metadata.UNSAVED_INACTIVE === "X",
    originalObjectType: metadata.ORIGINAL_OBJECT_TYPE ?? "",
    originalObjectName: metadata.ORIGINAL_OBJECT_NAME ?? "",
    mainObjectType: metadata.MAIN_OBJECT_TYPE ?? "",
    mainObjectName: metadata.MAIN_OBJECT_NAME ?? "",
    programName: metadata.PROGRAM_NAME ?? "",
    hookImplementations: normalizedHooks,
    badiImplementations: normalizedBadis,
    filters
  }
  return {
    connectionId,
    repositoryKind: "enhancement_implementation",
    enhancementName: definition.name,
    packageName: metadata.PACKAGE ?? "",
    definition,
    fingerprint: stableFingerprint(definition)
  }
}

function assertEnhancementWriteSnapshot(
  current: Record<string, unknown>,
  expectedFingerprint: string,
  packageName: string
): void {
  if (current.fingerprint !== expectedFingerprint.toLowerCase()) {
    throw new Error("ENHANCEMENT_IMPLEMENTATION_STALE_FINGERPRINT")
  }
  if (String(current.packageName).toUpperCase() !== packageName.toUpperCase()) {
    throw new Error("ENHANCEMENT_IMPLEMENTATION_PACKAGE_MISMATCH")
  }
}

function normalizedEnhancementFilters(
  filters: Array<Record<string, string>>
): Array<Record<string, string>> {
  return filters
    .map((filter) =>
      Object.fromEntries(
        Object.entries(filter)
          .filter(([name, value]) => name.toUpperCase() !== "IMPLEMENTATION_NAME" && value !== "")
          .map(([name, value]): [string, string] => [name.toUpperCase(), value])
          .sort(([left], [right]) => left.localeCompare(right))
      )
    )
    .sort(compareByJson)
}

function classicBadiImplementationSnapshot(
  result: Record<string, unknown>,
  implementationName: string
): Record<string, unknown> | undefined {
  const definition = result.definition as Record<string, unknown> | undefined
  const assignments = Array.isArray(definition?.implementationAssignments)
    ? (definition.implementationAssignments as Array<Record<string, unknown>>).filter(
        (row) => String(row.implementationName).toUpperCase() === implementationName
      )
    : []
  if (!assignments.length) return undefined
  const classMappings = Array.isArray(definition?.classMappings)
    ? (definition.classMappings as Array<Record<string, unknown>>).filter(
        (row) => String(row.implementationName).toUpperCase() === implementationName
      )
    : []
  return { assignments, classMappings }
}

function customerEnhancementName(value: string, fieldName: string, maxLength = 30): string {
  const normalized = value.trim().toUpperCase()
  if (!new RegExp(`^[ZY][A-Z0-9_/$]{0,${maxLength - 1}}$`).test(normalized)) {
    throw new Error(`${fieldName} must name a Z* or Y* customer object`)
  }
  return normalized
}

function repositoryComponentName(value: string, fieldName: string, maxLength: number): string {
  const normalized = value.trim().toUpperCase()
  if (!new RegExp(`^[A-Z0-9_/$]{1,${maxLength}}$`).test(normalized)) {
    throw new Error(`${fieldName} is not a valid SAP repository name`)
  }
  return normalized
}

function stableFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
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

function transactionCodeName(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (!/^[A-Z0-9_/$]{1,20}$/.test(normalized)) {
    throw new Error("transactionCode must be an exact SAP transaction name")
  }
  return normalized
}

/**
 * A form may live in the customer namespace or in a SAP namespace such as `/SAPSCRIPT/…`, and
 * reading a standard form is a legitimate reference read, so this normalizes and length-checks the
 * name instead of restricting it to the Z or Y customer namespace the way `customerName` does for
 * writes.
 */
function sapscriptFormName(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (!/^(?:[A-Z][A-Z0-9_]*|\/[A-Z0-9_]+\/[A-Z][A-Z0-9_]*)$/.test(normalized)) {
    throw new Error("formName must be an ABAP object name or a namespaced name")
  }
  if (normalized.length > 16) throw new Error("formName must not exceed 16 characters")
  return normalized
}

function sapscriptFormStatus(value: string | undefined): string {
  const normalized = (value ?? "").trim().toUpperCase()
  if (normalized !== "" && normalized !== "SAP" && normalized !== "CUS") {
    throw new Error('status must be "", "SAP" or "CUS"')
  }
  return normalized
}

function sapscriptFormLanguage(value: string | undefined): string {
  const normalized = (value ?? "").trim().toUpperCase()
  if (normalized !== "" && !/^[A-Z0-9]$/.test(normalized)) {
    throw new Error("language must be a single character")
  }
  return normalized
}

/**
 * The helper declares its language selectors optional, so an empty element would ask it to resolve a
 * language it was never given. The key is omitted unless a language was supplied, which leaves the
 * helper's own SY-LANGU default in force; this also keeps the SOAP request byte-identical for every
 * caller that does not name a language.
 */
function repositoryLanguageSelector(language: string | undefined): { textLanguage?: string } {
  const normalized = sapscriptFormLanguage(language)
  return normalized === "" ? {} : { textLanguage: normalized }
}

function smartstyleName(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (!/^(?:[A-Z][A-Z0-9_]*|\/[A-Z0-9_]+\/[A-Z][A-Z0-9_]*)$/.test(normalized)) {
    throw new Error("styleName must be an ABAP object name or a namespaced name")
  }
  if (normalized.length > 30) throw new Error("styleName must not exceed 30 characters")
  return normalized
}

function adobeFormName(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (!/^(?:[A-Z][A-Z0-9_]*|\/[A-Z0-9_]+\/[A-Z][A-Z0-9_]*)$/.test(normalized)) {
    throw new Error("formName must be an ABAP object name or a namespaced name")
  }
  if (normalized.length > 30) throw new Error("formName must not exceed 30 characters")
  return normalized
}

/**
 * The TRFUNCTION domain fixed values were read from w200 on 2026-09-23. Only K (workbench) and W
 * (customizing) create a request; S, R, X and Q describe tasks, and T belongs to the transport-of-
 * copies lifecycle, so none of them is accepted here.
 */
function transportRequestType(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (normalized !== "K" && normalized !== "W") {
    throw new Error("requestType must be K (workbench) or W (customizing)")
  }
  return normalized
}

function transportRequestText(value: string): string {
  const normalized = value.trim()
  if (normalized === "") throw new Error("description must not be empty")
  if (normalized.length > 60) throw new Error("description must not exceed 60 characters")
  if (/[\r\n]/.test(normalized)) throw new Error("description must not contain line breaks")
  return normalized
}

function transportRequestOwner(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (!/^[A-Z0-9_]{1,12}$/.test(normalized)) {
    throw new Error("owner must be a SAP user name of at most 12 characters")
  }
  return normalized
}

function transportRequestTarget(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (normalized.length > 10) throw new Error("target must not exceed 10 characters")
  if (/[\r\n|%]/.test(normalized)) throw new Error("target must not contain line breaks or | or %")
  return normalized
}

/**
 * The helper reports both outcomes as successful, so `created` is decoded from the CREATED payload
 * property rather than inferred from the status: a matched existing request and a freshly created
 * one must never look the same to a caller.
 */
function transportRequestCreation(
  connectionId: string,
  requestType: string,
  description: string,
  result: SapRepositoryResult
): TransportRequestCreation {
  const metadata: Record<string, string> = {}
  const taskNumbers: string[] = []
  for (const line of result.source) {
    const match = line.match(/^([A-Z]+)\|(\d+)\|([A-Z0-9_]+)\|(.*)$/)
    if (!match?.[1] || !match[2] || !match[3]) {
      throw new Error(`SAP repository helper returned an invalid payload line: ${line}`)
    }
    const value = (match[4] ?? "").replaceAll("%7C", "|").replaceAll("%25", "%")
    if (match[1] === "M") {
      metadata[match[3]] = value
      continue
    }
    if (match[1] !== "T" || match[3] !== "TRKORR") {
      throw new Error(`SAP repository helper returned an unknown transport payload kind: ${line}`)
    }
    taskNumbers.push(value)
  }
  const requestNumber = (metadata.TRKORR ?? "").trim()
  if (requestNumber === "") {
    throw new Error("SAP repository helper did not report a transport request number")
  }
  const created = metadata.CREATED === "X"
  if (!created && (metadata.MATCHED_BY ?? "") === "") {
    throw new Error("SAP repository helper reported neither a created nor a matched request")
  }
  return {
    connectionId: connectionId.toLowerCase(),
    created,
    requestNumber,
    requestType: metadata.TRFUNCTION ?? requestType,
    status: metadata.TRSTATUS ?? "",
    owner: metadata.AS4USER ?? "",
    target: metadata.TARSYSTEM ?? "",
    description: metadata.AS4TEXT ?? description,
    taskNumbers,
    ...(created ? {} : { matchedBy: metadata.MATCHED_BY ?? "" })
  }
}

function transportRequestNumber(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (normalized === "") throw new Error("requestNumber must not be empty")
  if (normalized.length > 20) throw new Error("requestNumber must not exceed 20 characters")
  if (/[\r\n|%]/.test(normalized)) {
    throw new Error("requestNumber must not contain line breaks or | or %")
  }
  return normalized
}

function transportObjectEntry(entry: TransportObjectEntry): TransportObjectEntry {
  const pgmid = transportObjectField(entry.pgmid, "pgmid", 10)
  const object = transportObjectField(entry.object, "object", 10)
  const objName = transportObjectField(entry.objName, "objName", 120)
  const language = (entry.language ?? "").trim().toUpperCase()
  if (language !== "" && !/^[A-Z]{1,2}$/.test(language)) {
    throw new Error("language must be a one or two character SAP language code")
  }
  return { pgmid, object, objName, ...(language === "" ? {} : { language }) }
}

/**
 * PGMID/OBJECT/OBJ_NAME are validated only for shape here. SAP owns the real domain values and
 * lengths, so an unusable object type must come back from the helper as an explicit error code
 * rather than being guessed at in the service.
 */
function transportObjectField(value: string, field: string, maxLength: number): string {
  const normalized = value.trim().toUpperCase()
  if (normalized === "") throw new Error(`${field} must not be empty`)
  if (normalized.length > maxLength) {
    throw new Error(`${field} must not exceed ${maxLength} characters`)
  }
  if (/[\r\n]/.test(normalized)) throw new Error(`${field} must not contain line breaks`)
  return normalized
}

function transportObjectAddition(
  connectionId: string,
  requestedRequestNumber: string,
  objects: TransportObjectEntry[],
  result: SapRepositoryResult
): TransportObjectAddition {
  const metadata: Record<string, string> = {}
  const reported: Record<number, Record<string, string>> = {}
  for (const line of result.source) {
    const match = line.match(/^([A-Z]+)\|(\d+)\|([A-Z0-9_]+)\|(.*)$/)
    if (!match?.[1] || !match[2] || !match[3]) {
      throw new Error(`SAP repository helper returned an invalid payload line: ${line}`)
    }
    const value = (match[4] ?? "").replaceAll("%7C", "|").replaceAll("%25", "%")
    if (match[1] === "M") {
      metadata[match[3]] = value
      continue
    }
    if (match[1] !== "T") {
      throw new Error(`SAP repository helper returned an unknown object payload kind: ${line}`)
    }
    const index = Number.parseInt(match[2], 10)
    reported[index] = { ...(reported[index] ?? {}), [match[3]]: value }
  }
  const insertedCount = helperInteger(metadata.INSERTED_COUNT, "INSERTED_COUNT")
  if (!Number.isInteger(insertedCount)) {
    throw new Error("SAP repository helper did not report the inserted object count")
  }
  const readBack = Object.keys(reported)
    .map((key) => Number.parseInt(key, 10))
    .sort((left, right) => left - right)
    .map((index) => reported[index] ?? {})
  if (readBack.length !== objects.length) {
    throw new Error("SAP repository helper did not echo every requested object")
  }
  for (let position = 0; position < objects.length; position++) {
    const row = readBack[position] ?? {}
    const requested = objects[position]
    if (!requested) throw new Error("SAP repository helper echoed an unexpected object row")
    if (
      (row.PGMID ?? "") !== requested.pgmid ||
      (row.OBJECT ?? "") !== requested.object ||
      (row.OBJ_NAME ?? "") !== requested.objName
    ) {
      throw new Error("SAP repository helper echoed a different object than the one requested")
    }
  }
  // The helper refuses before it reports when an object did not reach E071, so a lower count here
  // means the payload contradicts itself. It was parsed and then never compared, which left a
  // partial insert reportable as a clean success.
  if (insertedCount !== objects.length) {
    throw new Error(
      `SAP repository helper reported ${insertedCount} of ${objects.length} objects as inserted; a partial insert is not a success`
    )
  }
  const recordedRequest = (metadata.REQUEST ?? "").trim()
  const recordedTask = (metadata.TASK ?? "").trim()
  const requested = requestedRequestNumber.trim().toUpperCase()
  const recorded = recordedRequest.toUpperCase()
  // An empty report is a mismatch as well: the caller asked for one exact container, and a callee
  // that names none has not confirmed that container was used.
  const recordedInRequestedContainer = recorded !== "" && recorded === requested
  return {
    connectionId: connectionId.toLowerCase(),
    requestNumber: recordedRequest,
    taskNumber: recordedTask,
    objectCount: helperInteger(metadata.OBJECT_COUNT, "OBJECT_COUNT"),
    insertedCount,
    objects: readBack.map((row) => ({
      pgmid: row.PGMID ?? "",
      object: row.OBJECT ?? "",
      objName: row.OBJ_NAME ?? ""
    })),
    requestedRequestNumber: requested,
    recordedInRequestedContainer,
    containerMismatch: recordedInRequestedContainer
      ? null
      : {
          requested,
          recordedIn: recordedRequest,
          task: recordedTask,
          reason: recorded
            ? "SAP recorded the objects in a different transport container: an object that already belongs to another open transport is never moved, and TRINT_OBJECTS_CHECK_AND_INSERT reports the container it used instead. Re-read the reported container before releasing anything."
            : "SAP reported no transport container for the inserted objects, so the requested container is unconfirmed."
        }
  }
}

function smartstyleMode(value: string | undefined): string {
  const normalized = (value ?? "").trim().toUpperCase()
  if (normalized !== "" && normalized !== "S" && normalized !== "P") {
    throw new Error('mode must be "S" or "P"')
  }
  return normalized
}

function smartstyleActive(value: string | undefined): string {
  const normalized = (value ?? "").trim().toUpperCase()
  if (normalized !== "" && normalized !== "A" && normalized !== "I") {
    throw new Error('active must be "A" or "I"')
  }
  return normalized
}

function smartstyleVariant(value: string | undefined): string {
  const normalized = (value ?? "").trim().toUpperCase()
  if (normalized.length > 8) throw new Error("variant must not exceed 8 characters")
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

/**
 * Package validator for source-object DELETION, which must accept `$TMP`.
 *
 * Deliberately separate from `packageName()`. That helper rejects `$TMP` because its eleven other
 * callers create modules pools, transactions, screens and message classes -- objects SAP does require
 * to be transportable, so its wording about Dynpro application objects is accurate for them. A
 * program, include, class or interface may legitimately live in `$TMP`, and deleting one needs no
 * transport at all. Routing the local case through the shared helper made every `$TMP` source object
 * undeletable and explained the refusal with a cause unrelated to the request, which is what left the
 * deployment carriers stranded in `$TMP`. Non-local packages keep the original rule unchanged.
 */
function deletableSourcePackage(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (!normalized) throw new Error("packageName is required")
  return normalized === "$TMP" ? normalized : packageName(normalized)
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

/**
 * Same contract as `requireRepositorySuccess` for the base helper `Z_ORVANTA_MCP_EXECUTE`, whose
 * failures must not be reported as a repository-helper rejection.
 */
function requireHelperSuccess(status: string, code: string, message: string): void {
  if (status.toUpperCase() !== "S") {
    throw new Error(`SAP helper rejected the operation: ${code}: ${message}`)
  }
}
