import type { TransportRequest, TransportsOfUser } from "abap-adt-api"
import { createHash } from "node:crypto"
import type {
  ActivationInfo,
  AbapObjectInfo,
  AtcResultInfo,
  ConnectionDetails,
  CreateObjectRequest,
  DebugBreakpointCommand,
  DiagnosticInfo,
  DiscoverySnapshotInfo,
  DumpListInfo,
  EnhancementInfo,
  ExportResourceInfo,
  MessageClassCreationInfo,
  MessageClassDeletionInfo,
  MessageClassInfo,
  MessageClassMutationInfo,
  ObjectCreationInfo,
  ObjectTypeSearchResult,
  RevisionInfo,
  RemoteFunctionRequest,
  RemoteFunctionResult,
  SapDdicRequest,
  SapDdicResult,
  SapHelperRequest,
  SapHelperResult,
  SapHelperCapabilities,
  SapRepositoryRequest,
  SapRepositoryResult,
  SapBackend,
  SourceResult,
  SourceMutationInfo,
  SourceInspectionInfo,
  TestIncludeCreationInfo,
  TextElementInfo,
  TextElementMutationInfo,
  TextElementObjectType,
  TextElementsInfo,
  TransportCleanupEntry,
  TraceConfigurationInfo,
  TraceEntryInfo,
  TraceRunInfo,
  UnitTestClassInfo,
  UsageReferenceInfo,
  UsageSnippetInfo,
  UserTransportsListing
} from "../src/backend.js"
import type {
  DebugSessionInfo,
  DebugSessionRequest,
  DebugStackFrameInfo,
  DebugStepInfo,
  DebugStepRequest,
  DebugVariableInfo,
  DebugVariableRequest
} from "../src/debug-manager.js"
import { findAndReplaceSource } from "../src/source-edit.js"
import { searchCodeOfAdtType } from "../src/object-types.js"
import { resolveEditableSourceTarget } from "../src/adt-backend.js"

const objects: AbapObjectInfo[] = [
  {
    name: "ZCL_DEMO",
    type: "CLAS/OC",
    description: "Standalone validation class",
    package: "ZVALIDATION",
    systemType: "CUSTOM",
    uri: "/sap/bc/adt/oo/classes/zcl_demo"
  },
  {
    name: "ZREPORT_DEMO",
    type: "PROG/P",
    description: "Standalone validation report",
    package: "ZVALIDATION",
    systemType: "CUSTOM",
    uri: "/sap/bc/adt/programs/programs/zreport_demo"
  },
  {
    name: "ZMODULE_POOL",
    type: "PROG/P",
    description: "Standalone Dynpro validation module pool",
    package: "ZVALIDATION",
    systemType: "CUSTOM",
    uri: "/sap/bc/adt/programs/programs/zmodule_pool"
  },
  {
    name: "ZTABLE_DEMO",
    type: "TABL/DT",
    description: "Standalone validation table",
    package: "ZVALIDATION",
    systemType: "CUSTOM",
    uri: "/sap/bc/adt/ddic/tables/ztable_demo"
  },
  {
    // A function module is the case that exposes the two-vocabulary trap: the repository search is
    // asked for `FUNC` and answers with the ADT path `FUGR/FF`, which the callers then hand back.
    // Without a row here the mock could not reproduce the false "object does not exist" answer that
    // `get_version_history` gave on w200 for a live function module (2026-09-25T00:37).
    name: "Z_FM_DEMO",
    type: "FUGR/FF",
    description: "Standalone validation function module",
    package: "ZVALIDATION",
    systemType: "CUSTOM",
    uri: "/sap/bc/adt/functions/groups/zfug_demo/fmodules/z_fm_demo"
  }
]

const sources = new Map([
  [
    "ZCL_DEMO",
    [
      "CLASS zcl_demo IMPLEMENTATION.",
      "  METHOD run.",
      "    WRITE 'HEADLESS'.",
      "  ENDMETHOD.",
      "ENDCLASS."
    ].join("\n")
  ],
  ["ZREPORT_DEMO", ["REPORT zreport_demo.", "WRITE 'OK'."].join("\n")],
  [
    "ZMODULE_POOL",
    [
      "PROGRAM zmodule_pool.",
      "DATA gv_name TYPE c LENGTH 40.",
      "MODULE status_0100 OUTPUT.",
      "ENDMODULE.",
      "MODULE user_command_0100 INPUT.",
      "ENDMODULE."
    ].join("\n")
  ]
])

/**
 * Match the way the real quick search does: the caller supplies a type token, the returned row
 * carries an ADT type path.
 *
 * The search accepts a path whose parent segment is its own search code (`CLAS/OC`, `PROG/P`,
 * `TABL/DT`), verified live on w200, but not the function-module path: the same call with `FUNC`
 * returned the function module while `FUGR/FF` returned nothing, and callers turned that emptiness
 * into "the object does not exist". Reproducing that asymmetry is the point of this helper — a
 * caller-side vocabulary mistake must fail here instead of passing as a successful lookup.
 */
function matchesSearchType(requestedToken: string, objectAdtType: string): boolean {
  const token = requestedToken.trim().toUpperCase()
  const objectCode = searchCodeOfAdtType(objectAdtType)
  if (objectCode === undefined) return false
  const requestedCode = searchCodeOfAdtType(token)
  if (requestedCode !== objectCode) return false
  return !token.includes("/") || token.split("/")[0] === objectCode
}

/**
 * SOAP entity decoding for stored helper payload rows. The helper sends source lines as they exist
 * in SAP, entity-escaped on the wire, and digests the unescaped lines - so a double that hashed the
 * escaped text would disagree with the service about the same body.
 */
function decodeHelperSoapText(value: string): string {
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

function payloadRows(
  kind: "M" | "F" | "T" | "C" | "A" | "S" | "I" | "H" | "B",
  rows: Array<Record<string, string>>
): string[] {
  const lines: string[] = []
  rows.forEach((row, rowIndex) => {
    Object.entries(row).forEach(([name, value]) => {
      lines.push(`${kind}|${rowIndex + 1}|${name}|${value}`)
    })
  })
  return lines
}

function mockNativeScreenField(field: Record<string, string>): Record<string, string> {
  return {
    FNAM: field.NAME ?? field.FNAM ?? "",
    TYPE: field.TYPE ?? "",
    STXT: field.TEXT ?? field.STXT ?? "",
    LINE: field.LINE ?? "",
    COLN: field.COLUMN ?? field.COLN ?? "",
    LENG: field.LENGTH ?? field.LENG ?? "",
    FMKY: field.PUSH_FCODE ?? field.FMKY ?? ""
  }
}

function parsePayloadRows(lines: string[], kind: "F" | "T"): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = []
  for (const line of lines) {
    const match = line.match(/^([FT])\|(\d+)\|([A-Z0-9_]+)\|(.*)$/)
    if (!match || match[1] !== kind) continue
    const index = Number.parseInt(match[2]!, 10)
    while (rows.length < index) rows.push({})
    rows[index - 1]![match[3]!] = (match[4] ?? "").replaceAll("%7C", "|").replaceAll("%25", "%")
  }
  return rows
}

function parseEnhancementPayload(
  lines: string[],
  kind: "M" | "H" | "B" | "F" | "S"
): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = []
  for (const line of lines) {
    // The enhancement payload format is KIND|INDEX|PROPERTY|VALUE for every kind, and the
    // seed below writes H/B/F rows with the same encoder. Parsing only M/S made every hook
    // and BAdI row invisible, so updates failed with *_NOT_FOUND against their own fixture.
    const match = line.match(/^([MHSBF])\|(\d+)\|([A-Z0-9_]+)\|(.*)$/)
    if (!match || match[1] !== kind) continue
    const index = Number.parseInt(match[2]!, 10)
    while (rows.length < index) rows.push({})
    rows[index - 1]![match[3]!] = (match[4] ?? "").replaceAll("%7C", "|").replaceAll("%25", "%")
  }
  return rows
}

function mockDdicResult(
  _kind:
    | "domain"
    | "dataElement"
    | "structure"
    | "transparentTable"
    | "tableType"
    | "searchHelp"
    | "lockObject"
    | "numberRangeObject",
  header: Record<string, string>,
  packageName: string
): SapDdicResult {
  return {
    status: "S",
    code: "DDIC_OBJECT_READ",
    message: "DDIC object read successfully",
    version: "1.7",
    metadata: {},
    packageName,
    objectVersion: "20260831120000",
    recordedRequest: "",
    header,
    fixedValues: [],
    fields: [],
    selectionMethods: [],
    parameters: [],
    fieldAssignments: [],
    lockTables: [],
    lockFields: [],
    numberRangeTexts: [],
    baseTables: [],
    viewFields: [],
    selectionConditions: [],
    warnings: []
  }
}

/**
 * The NUMC columns of DD31V/DD32P/DD33V, with the widths the live read-back shows
 * (.doc/code-update-20260920-135257.md: LENG "000010", SHLPSELPOS "00"). SAP stores the caller's text
 * zero-padded because the helper assigns it into the numeric component, so the fake has to pad too:
 * a fake that echoed the raw text would agree with the service's raw comparison and the padding bug
 * could never fail a test.
 */
const MOCK_SEARCH_HELP_NUMERIC_WIDTHS: Record<string, number> = {
  LENG: 6,
  DECIMALS: 6,
  OUTPUTLEN: 6,
  SHLPSELPOS: 2,
  SHLPLISPOS: 2
}

function padMockSearchHelpRows(rows: Record<string, string>[]): Record<string, string>[] {
  return rows.map((row) => {
    const padded: Record<string, string> = { ...row }
    for (const [column, width] of Object.entries(MOCK_SEARCH_HELP_NUMERIC_WIDTHS)) {
      const value = row[column]
      if (value === undefined || !/^\d+$/.test(value)) continue
      padded[column] = value.padStart(width, "0")
    }
    return padded
  })
}

function ddicKind(
  operation: SapDdicRequest["operation"]
):
  | "domain"
  | "dataElement"
  | "structure"
  | "transparentTable"
  | "tableType"
  | "lockObject"
  | "searchHelp"
  | "numberRangeObject" {
  if (operation.endsWith("DOMAIN")) return "domain"
  if (operation.endsWith("DATA_ELEMENT")) return "dataElement"
  if (operation.endsWith("STRUCTURE")) return "structure"
  if (operation.endsWith("TRANSPARENT_TABLE")) return "transparentTable"
  // Without this, UPSERT_LOCK_OBJECT fell through to tableType and the readback check compared an
  // object it never asked for, so the mock could not exercise the lock-object path at all.
  if (operation.endsWith("LOCK_OBJECT")) return "lockObject"
  // Same reasoning for the other two kinds that have their own read-back comparison: while they fell
  // through to tableType, UPSERT_SEARCH_HELP and UPSERT_NUMBER_RANGE_OBJECT could not run against
  // this fake at all, so their verification code had no test.
  if (operation.endsWith("SEARCH_HELP")) return "searchHelp"
  if (operation.endsWith("NUMBER_RANGE_OBJECT")) return "numberRangeObject"
  return "tableType"
}

/** The un-upgraded helper: it answers `OPERATION_NOT_SUPPORTED` for `CAPABILITIES`. */
function emptyMockHelperCapabilities(helper: string): SapHelperCapabilities {
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
    observedAt: new Date().toISOString(),
    attestation: "operation-scoped"
  }
}

export class MockBackend implements SapBackend {
  async callSmartform(
    _connectionId: string,
    _request: import("../src/smartforms.js").SmartformRequest
  ): Promise<import("../src/smartforms.js").SmartformResponse> {
    throw new Error("Smartform backend must be explicitly supplied by the test")
  }
  lastRepositoryRequest: SapRepositoryRequest | undefined
  lastHelperRequest: SapHelperRequest | undefined
  /**
   * 1.16 post-condition: a write is only complete once the saved definition is the active one. A
   * helper that answers this code saved the definition, could not prove it is active, and left an
   * inactive version behind - the exact shape of the 2026-09-25 false-success incident, where the
   * object kept its previous active version and the old code reported the write as completed. The
   * fake has to be able to produce it, or a test can never fail for the missing post-condition.
   */
  ddicWriteFailureCode: string | null = null
  /**
   * A DDIC read of an object that carries an inactive version. The helper's read requests
   * `state = 'M'`, so it cannot describe which version is active; metadata.INACTIVE stays unset to
   * model a helper that cannot describe the inactive definition either.
   */
  ddicReadFailure: { code: string; message: string } | null = null
  functionPatchReadbackMismatch = false
  /**
   * `WRITE_FUNCTION_SOURCE` answers success but SAP keeps the previous body. The service replaces a
   * function module body through the helper instead of the ADT PUT, so this proves the read-back
   * comparison still decides, and that a helper code alone is never taken as proof of the write.
   */
  functionWriteReadbackMismatch = false
  /** When true the ADT source write path fails, so a test can prove a write did not use it. */
  adtSourceWriteRefused = false
  /**
   * Reproduces a read-back whose stored source is not what was sent - SAP normalises and truncates
   * source on save, so the verification has to say which line disagreed instead of only that
   * something did.
   */
  functionCreateReadbackDropsSourceLine = false
  /** When true the helper answers FUNCTION_PATCH_SAVE_NOT_OBSERVED and changes nothing. */
  functionPatchHelperMismatch = false
  /** When true the applied interface patch also changes the stored implementation source rows. */
  functionPatchSourceMutation = false
  /**
   * The repository helper reports why a SmartStyle read failed only through the code it maps
   * SSF_READ_STYLE's sy-subrc to. The service must surface that code unchanged: flattening every
   * exception into STYLE_NOT_FOUND told the caller nothing it could act on, which is why a style
   * that simply had no active version looked identical to a style that does not exist.
   */
  smartstyleFailure: { code: string; message: string } | null = {
    code: "STYLE_NOT_FOUND",
    message: "Smart style does not exist"
  }
  private readonly enhancementImplementations = new Map<string, string[]>([
    [
      "ZENH_DEMO",
      [
        ...payloadRows("M", [
          {
            NAME: "ZENH_DEMO",
            TOOL: "HOOK_IMPL",
            SHORT_TEXT: "Demo hook implementation",
            ACTIVE: "X",
            INACTIVE: "",
            SAVED_INACTIVE: "",
            UNSAVED_INACTIVE: "",
            PACKAGE: "ZABAP",
            ORIGINAL_OBJECT_TYPE: "PROG",
            ORIGINAL_OBJECT_NAME: "SAPMV45A",
            MAIN_OBJECT_TYPE: "PROG",
            MAIN_OBJECT_NAME: "SAPMV45A",
            PROGRAM_NAME: "SAPMV45A"
          }
        ]),
        ...payloadRows("H", [
          {
            EXTID: "1",
            FULL_NAME:
              "\\PROGRAM=SAPMV45A\\FORM=USEREXIT_SAVE_DOCUMENT_PREPARE\\ENHANCEMENT-POINT=END",
            MODE: "S",
            SOURCE_COUNT: "2"
          }
        ]),
        ...payloadRows("S", [
          { HOOK_INDEX: "1", LINE_NUMBER: "1", LINE: "IF vbak-vbeln IS INITIAL." },
          { HOOK_INDEX: "1", LINE_NUMBER: "2", LINE: "ENDIF." }
        ])
      ]
    ]
  ])
  private readonly classicBadiImplementations = new Set(["ZME_PO_IMPL", "ZME_PO_OLD"])

  seedInactiveEnhancementVersion(name: string): void {
    const source = this.enhancementImplementations.get(name.toUpperCase())
    if (!source) throw new Error(`No enhancement implementation ${name}`)
    const metadata = parseEnhancementPayload(source, "M")[0] ?? {}
    metadata.INACTIVE = "X"
    metadata.SAVED_INACTIVE = "X"
    this.enhancementImplementations.set(name.toUpperCase(), [
      ...payloadRows("M", [metadata]),
      ...source.filter((line) => !line.startsWith("M|"))
    ])
  }
  private debugState: DebugSessionInfo = {
    connectionId: "w200",
    state: "idle",
    mode: "user",
    debugUser: "DEVELOPER",
    breakpointCount: 0
  }
  private readonly sourceByName = new Map(sources)
  private readonly functionAdtSources = new Map([
    [
      "ZCMCP_FM_1501",
      [
        "FUNCTION ZCMCP_FM_1501",
        "  IMPORTING",
        "    VALUE(IV_INPUT) TYPE CHAR20",
        "  EXPORTING",
        "    VALUE(EV_OUTPUT) TYPE CHAR40",
        "  EXCEPTIONS",
        "    INVALID_INPUT.",
        "",
        "  CONCATENATE 'MCP:' iv_input INTO ev_output.",
        "",
        "ENDFUNCTION."
      ].join("\n")
    ]
  ])
  private screen: {
    description: string
    header: Record<string, string>
    fields: Array<Record<string, string>>
    flowLogic: Array<Record<string, string>>
    params: Array<Record<string, string>>
  } = {
    description: "Mock screen",
    header: {
      PROG: "ZMODULE_POOL",
      DNUM: "0100",
      TYPE: "N",
      FNUM: "0002",
      NOLI: "0020",
      NOCO: "0080",
      SPRA: "E"
    },
    fields: [
      { FNAM: "GV_NAME", TYPE: "CHAR", LENG: "40", LINE: "0003", COLN: "0010" },
      { FNAM: "BTN_EXIT", TYPE: "PUSH", STXT: "Exit", LINE: "0005", COLN: "0010" }
    ],
    flowLogic: [
      { LINE: "PROCESS BEFORE OUTPUT." },
      { LINE: "  MODULE status_0100." },
      { LINE: "PROCESS AFTER INPUT." },
      { LINE: "  MODULE user_command_0100." }
    ],
    params: [] as Array<Record<string, string>>
  }
  private guiVersion = "20260902090000"
  private guiAdmin: Record<string, string> = {
    ACTCODE: "000001",
    MENCODE: "000001",
    PFKCODE: "000001",
    DEFAULTACT: "",
    DEFAULTPFK: "",
    MOD_LANGU: "E"
  }
  private guiSections: NonNullable<SapRepositoryRequest["guiDefinition"]>["sections"] = {
    STA: [
      {
        CODE: "STATUS_0100",
        MODAL: "",
        ACTCODE: "000001",
        PFKCODE: "000001",
        BUTCODE: "0001",
        INT_NOTE: "",
        CTXCODE: ""
      }
    ],
    FUN: [
      {
        CODE: "BACK",
        TEXTNO: "001",
        TYPE: "E",
        MODIF: "",
        TEXT_TYPE: "",
        TEXT_NAME: "",
        ICON_ID: "@0D@",
        FUN_TEXT: "Back",
        ICON_TEXT: "Back",
        INFO_TEXT: "Back",
        PATH: "",
        SFW_SWITCHID: "",
        SFW_SHOWHIDE: ""
      }
    ],
    MEN: [] as Array<Record<string, string>>,
    MTX: [] as Array<Record<string, string>>,
    ACT: [] as Array<Record<string, string>>,
    BUT: [] as Array<Record<string, string>>,
    PFK: [] as Array<Record<string, string>>,
    SET: [{ STATUS: "STATUS_0100", FUNCTION: "BACK" }],
    DOC: [] as Array<Record<string, string>>,
    TIT: [{ CODE: "TITLE_0100", TEXT: "Mock title" }],
    BIV: [] as Array<Record<string, string>>
  }
  private readonly textElementsByName = new Map<string, TextElementInfo[]>([
    ["ZREPORT_DEMO", [{ id: "001", text: "Existing text", maxLength: 20 }]]
  ])
  private readonly messageClasses = new Map<
    string,
    {
      description: string
      packageName: string
      version?: string
      messages: Array<{ number: string; text: string }>
    }
  >([
    [
      "00",
      {
        description: "System messages",
        packageName: "SABP",
        messages: [{ number: "001", text: "Mock standard message" }]
      }
    ]
  ])
  private readonly functionModules = new Map<string, string[]>([
    [
      "RFC_READ_TABLE",
      [
        "M|1|FUNCTION_GROUP|SDTX",
        "M|1|SHORT_TEXT|Read table by RFC",
        "M|1|REMOTE_ENABLED|X",
        "M|1|UPDATE_TASK|",
        "M|1|GLOBAL_INTERFACE|",
        "I|1|PARAMETER|QUERY_TABLE",
        "I|1|TYP|TABNAME",
        "I|1|OPTIONAL|",
        "I|1|PASSVALUE|X",
        "S|1|LINE|  SELECT * FROM (query_table)."
      ]
    ],
    [
      "ZCMCP_FM_1501",
      [
        "M|1|FUNCTION_GROUP|ZCMCP_FG_1501",
        "M|1|SHORT_TEXT|MCP RFC validation",
        "M|1|REMOTE_ENABLED|X",
        "M|1|UPDATE_TASK|",
        "M|1|GLOBAL_INTERFACE|",
        "I|1|PARAMETER|IV_INPUT",
        "I|1|TYP|CHAR20",
        "I|1|DBFIELD|",
        "I|1|OPTIONAL|",
        "I|1|PASSVALUE|X",
        "E|1|PARAMETER|EV_OUTPUT",
        "E|1|TYP|CHAR40",
        "E|1|DBFIELD|",
        "E|1|PASSVALUE|X",
        "X|1|EXCEPTION|INVALID_INPUT",
        "X|1|TEXT|Input is invalid",
        // w200 renders the SAP side read of the same function module like this: the interface is a
        // commented block between two `*"---` separators and the header line carries a trailing
        // period. The ADT view in `functionAdtSources` holds the same implementation body but plain
        // interface declarations, so the two views must not be treated as interchangeable text.
        "S|1|LINE|FUNCTION ZCMCP_FM_1501.",
        "S|2|LINE|*&#34;--------------------------------------------------------------------",
        "S|3|LINE|*&#34;*Local Interface:",
        "S|4|LINE|*&#34;  IMPORTING",
        "S|5|LINE|*&#34;     VALUE(IV_INPUT) TYPE  CHAR20",
        "S|6|LINE|*&#34;  EXPORTING",
        "S|7|LINE|*&#34;     VALUE(EV_OUTPUT) TYPE  CHAR40",
        "S|8|LINE|*&#34;  EXCEPTIONS",
        "S|9|LINE|*&#34;     INVALID_INPUT.",
        "S|10|LINE|*&#34;--------------------------------------------------------------------",
        "S|11|LINE|  CONCATENATE 'MCP:' iv_input INTO ev_output.",
        "S|12|LINE|ENDFUNCTION."
      ]
    ],
    [
      "ZCMCP_FM_1801",
      [
        "M|1|FUNCTION_GROUP|ZCMCP_FG_1501",
        "M|1|SHORT_TEXT|MCP structured RFC validation",
        "M|1|REMOTE_ENABLED|X",
        "M|1|UPDATE_TASK|",
        "M|1|GLOBAL_INTERFACE|",
        "I|1|PARAMETER|IS_REQUEST",
        "I|1|TYP|BAPIRET2",
        "I|1|OPTIONAL|",
        "I|1|PASSVALUE|X",
        "E|1|PARAMETER|ES_RESPONSE",
        "E|1|TYP|BAPIRET2",
        "E|1|PASSVALUE|X",
        "T|1|PARAMETER|CT_ITEMS",
        "T|1|DBSTRUCT|BAPIRET2",
        "T|1|OPTIONAL|X",
        "X|1|EXCEPTION|INVALID_INPUT",
        "X|1|TEXT|Input is invalid",
        "S|1|LINE|  ES_RESPONSE = IS_REQUEST."
      ]
    ],
    [
      "ZCMCP_FM_1901",
      [
        "M|1|FUNCTION_GROUP|ZCMCP_FG_1501",
        "M|1|SHORT_TEXT|MCP allowlisted RFC validation",
        "M|1|REMOTE_ENABLED|X",
        "M|1|UPDATE_TASK|",
        "M|1|GLOBAL_INTERFACE|",
        "I|1|PARAMETER|IT_ITEMS",
        "I|1|TYP|BAPIRET2_T",
        "I|1|OPTIONAL|",
        "I|1|PASSVALUE|X",
        "E|1|PARAMETER|ET_ITEMS",
        "E|1|TYP|BAPIRET2_T",
        "E|1|PASSVALUE|X",
        "X|1|EXCEPTION|INVALID_INPUT",
        "X|1|TEXT|Input is invalid",
        "S|1|LINE|  ET_ITEMS[] = IT_ITEMS[]."
      ]
    ],
    [
      "ZCMCP_FM_STRINGVAL",
      [
        "M|1|FUNCTION_GROUP|ZCMCP_FG_1501",
        "M|1|SHORT_TEXT|MCP domain-less element validation",
        "M|1|REMOTE_ENABLED|X",
        "M|1|UPDATE_TASK|",
        "M|1|GLOBAL_INTERFACE|",
        "I|1|PARAMETER|IV_INPUT",
        "I|1|TYP|STRINGVAL",
        "I|1|DBFIELD|",
        "I|1|OPTIONAL|",
        "I|1|PASSVALUE|X",
        "E|1|PARAMETER|EV_RESULT",
        "E|1|TYP|STRINGVAL",
        "E|1|DBFIELD|",
        "E|1|PASSVALUE|X",
        "S|1|LINE|  EV_RESULT = IV_INPUT."
      ]
    ],
    [
      "ZCMCP_FM_UNTYPED",
      [
        "M|1|FUNCTION_GROUP|ZCMCP_FG_1501",
        "M|1|SHORT_TEXT|MCP unresolved element validation",
        "M|1|REMOTE_ENABLED|X",
        "M|1|UPDATE_TASK|",
        "M|1|GLOBAL_INTERFACE|",
        "I|1|PARAMETER|IV_INPUT",
        "I|1|TYP|ZCMCP_UNTYPED",
        "I|1|DBFIELD|",
        "I|1|OPTIONAL|",
        "I|1|PASSVALUE|X",
        "S|1|LINE|  WRITE iv_input."
      ]
    ]
  ])
  remoteFunctionCalls = 0
  private readonly deletedSourceObjects = new Set<string>()
  private conversionEntries: Array<Record<string, unknown>> = [
    {
      OBJECT: "TABL",
      TABNAME: "ZCMCP_CONV",
      INDNAME: "",
      TGORDER: "",
      FCT: "CNV",
      EXECMODE: "B",
      SEVERITY: "",
      GDATE: "20260915",
      GUSER: "DEVELOPER"
    }
  ]
  private readonly ddicByKey = new Map<string, SapDdicResult>([
    ...[1, 20, 40].flatMap(
      (length): Array<[string, SapDdicResult]> => [
        [
          `READ_DATA_ELEMENT:CHAR${length}`,
          mockDdicResult(
            "dataElement",
            { ROLLNAME: `CHAR${length}`, DOMNAME: `CHAR${length}` },
            "SZS"
          )
        ],
        [
          `READ_DOMAIN:CHAR${length}`,
          mockDdicResult(
            "domain",
            { DOMNAME: `CHAR${length}`, DATATYPE: "CHAR", LENG: String(length) },
            "SZS"
          )
        ]
      ]
    ),
    [
      "READ_DOMAIN:CHAR10",
      mockDdicResult(
        "domain",
        { DOMNAME: "CHAR10", DDTEXT: "Character 10", DATATYPE: "CHAR", LENG: "10" },
        "$TMP"
      )
    ],
    [
      "READ_DATA_ELEMENT:BAPI_MSG",
      mockDdicResult(
        "dataElement",
        {
          ROLLNAME: "BAPI_MSG",
          DDTEXT: "Message text",
          DOMNAME: "TEXT220",
          REPTEXT: "Message",
          SCRTEXT_S: "Message",
          SCRTEXT_M: "Message",
          SCRTEXT_L: "Message"
        },
        "SAP_BASIS"
      )
    ],
    [
      "READ_DOMAIN:TEXT220",
      mockDdicResult("domain", { DOMNAME: "TEXT220", DATATYPE: "CHAR", LENG: "220" }, "SAP_BASIS")
    ],
    [
      "READ_DATA_ELEMENT:BAPI_MTYPE",
      mockDdicResult("dataElement", { ROLLNAME: "BAPI_MTYPE", DOMNAME: "CHAR1" }, "SAP_BASIS")
    ],
    [
      "READ_STRUCTURE:BAPIRET2",
      {
        ...mockDdicResult(
          "structure",
          { TABNAME: "BAPIRET2", DDTEXT: "Return parameter", TABCLASS: "INTTAB" },
          "SAP_BASIS"
        ),
        fields: [
          { FIELDNAME: "TYPE", POSITION: "1", ROLLNAME: "BAPI_MTYPE", DDTEXT: "Message type" },
          { FIELDNAME: "MESSAGE", POSITION: "2", ROLLNAME: "BAPI_MSG", DDTEXT: "Message text" }
        ]
      }
    ],
    [
      "READ_TRANSPARENT_TABLE:T000",
      {
        ...mockDdicResult(
          "transparentTable",
          {
            TABNAME: "T000",
            DDTEXT: "Clients",
            TABCLASS: "TRANSP",
            CONTFLAG: "S",
            MAINFLAG: "",
            TABKAT: "0",
            TABART: "APPL0",
            BUFALLOW: "N",
            PUFFERUNG: ""
          },
          "STRM"
        ),
        fields: [
          {
            FIELDNAME: "MANDT",
            POSITION: "1",
            ROLLNAME: "MANDT",
            DDTEXT: "Client",
            KEYFLAG: "X",
            NOTNULL: "X"
          },
          {
            FIELDNAME: "MTEXT",
            POSITION: "2",
            ROLLNAME: "MTEXT_D",
            DDTEXT: "Client name",
            KEYFLAG: "",
            NOTNULL: ""
          }
        ]
      }
    ],
    [
      "READ_TRANSPARENT_TABLE:TBATG",
      {
        ...mockDdicResult(
          "transparentTable",
          {
            TABNAME: "TBATG",
            DDTEXT: "Dictionary conversion worklist",
            TABCLASS: "TRANSP",
            CONTFLAG: "S",
            MAINFLAG: "",
            TABKAT: "0",
            TABART: "APPL0",
            BUFALLOW: "N",
            PUFFERUNG: ""
          },
          "SDTB"
        ),
        fields: [
          "OBJECT",
          "TABNAME",
          "INDNAME",
          "TGORDER",
          "FCT",
          "EXECMODE",
          "SEVERITY",
          "GDATE",
          "GUSER"
        ].map((FIELDNAME, index) => ({
          FIELDNAME,
          POSITION: String(index + 1),
          ROLLNAME: "CHAR20",
          KEYFLAG: index < 2 ? "X" : "",
          NOTNULL: index < 2 ? "X" : ""
        }))
      }
    ],
    [
      "READ_TRANSPARENT_TABLE:ZCMCP_CONV",
      {
        ...mockDdicResult(
          "transparentTable",
          {
            TABNAME: "ZCMCP_CONV",
            DDTEXT: "Conversion fixture",
            TABCLASS: "TRANSP",
            CONTFLAG: "A",
            MAINFLAG: "",
            TABKAT: "0",
            TABART: "APPL0",
            BUFALLOW: "N",
            PUFFERUNG: ""
          },
          "ZABAP"
        ),
        fields: [
          {
            FIELDNAME: "ID",
            POSITION: "1",
            ROLLNAME: "CHAR20",
            COMPTYPE: "E",
            KEYFLAG: "X",
            NOTNULL: "X"
          }
        ]
      }
    ],
    [
      "READ_TRANSPARENT_TABLE:ZCMCP_TYPED",
      {
        ...mockDdicResult(
          "transparentTable",
          {
            TABNAME: "ZCMCP_TYPED",
            DDTEXT: "Typed field fixture",
            TABCLASS: "TRANSP",
            CONTFLAG: "A",
            MAINFLAG: "",
            TABKAT: "0",
            TABART: "APPL0",
            BUFALLOW: "N",
            PUFFERUNG: ""
          },
          "ZABAP"
        ),
        fields: [
          {
            FIELDNAME: "ID",
            POSITION: "1",
            ROLLNAME: "CHAR20",
            COMPTYPE: "E",
            ADMINFIELD: "0",
            KEYFLAG: "X",
            NOTNULL: "X"
          },
          {
            FIELDNAME: "RAW_TEXT",
            POSITION: "2",
            ROLLNAME: "",
            COMPTYPE: "E",
            ADMINFIELD: "0",
            KEYFLAG: "",
            NOTNULL: ""
          }
        ]
      }
    ],
    [
      "READ_TRANSPARENT_TABLE:ZCMCP_COMPLEX",
      {
        ...mockDdicResult(
          "transparentTable",
          {
            TABNAME: "ZCMCP_COMPLEX",
            DDTEXT: "Complex layout fixture",
            TABCLASS: "TRANSP",
            CONTFLAG: "A",
            MAINFLAG: "",
            TABKAT: "1",
            TABART: "APPL0",
            BUFALLOW: "N",
            PUFFERUNG: "",
            SCHFELDANZ: "",
            PROTOKOLL: ""
          },
          "ZABAP"
        ),
        fields: [
          {
            FIELDNAME: "ID",
            POSITION: "1",
            ROLLNAME: "CHAR20",
            COMPTYPE: "E",
            ADMINFIELD: "0",
            KEYFLAG: "X",
            NOTNULL: "X"
          },
          {
            FIELDNAME: ".INCLUDE",
            POSITION: "2",
            PRECFIELD: "ZCMCP_INC",
            COMPTYPE: "S",
            ADMINFIELD: "0",
            KEYFLAG: "",
            NOTNULL: ""
          },
          {
            FIELDNAME: "INC_VALUE",
            POSITION: "3",
            ROLLNAME: "CHAR20",
            COMPTYPE: "E",
            ADMINFIELD: "1",
            KEYFLAG: "",
            NOTNULL: ""
          },
          {
            FIELDNAME: "DIRECT_VALUE",
            POSITION: "4",
            ROLLNAME: "CHAR20",
            COMPTYPE: "E",
            ADMINFIELD: "0",
            KEYFLAG: "",
            NOTNULL: ""
          },
          {
            FIELDNAME: ".INCLU--AP",
            POSITION: "5",
            PRECFIELD: "ZCMCP_APPEND",
            COMPTYPE: "S",
            ADMINFIELD: "0",
            KEYFLAG: "",
            NOTNULL: ""
          },
          {
            FIELDNAME: "APP_VALUE",
            POSITION: "6",
            ROLLNAME: "CHAR20",
            COMPTYPE: "E",
            ADMINFIELD: "1",
            KEYFLAG: "",
            NOTNULL: ""
          }
        ]
      }
    ],
    [
      "READ_TABLE_TYPE:BAPIRET2_T",
      mockDdicResult(
        "tableType",
        {
          TYPENAME: "BAPIRET2_T",
          DDTEXT: "Return parameters",
          ROWTYPE: "BAPIRET2",
          ROWKIND: "S",
          DATATYPE: "STRU",
          ACCESSMODE: "T",
          KEYDEF: "D",
          KEYKIND: "N"
        },
        "SAP_BASIS"
      )
    ],
    // Domain-less data elements: the helper's data-element branch returns no DATATYPE/LENG,
    // so their scalar type must come from the DD04L row fixture below.
    [
      "READ_DATA_ELEMENT:STRINGVAL",
      mockDdicResult("dataElement", { ROLLNAME: "STRINGVAL", DOMNAME: "" }, "SLDAPSYNC")
    ],
    [
      "READ_DATA_ELEMENT:ZCMCP_UNTYPED",
      mockDdicResult("dataElement", { ROLLNAME: "ZCMCP_UNTYPED", DOMNAME: "" }, "ZABAP")
    ],
    [
      "READ_TRANSPARENT_TABLE:DD04L",
      {
        ...mockDdicResult(
          "transparentTable",
          {
            TABNAME: "DD04L",
            DDTEXT: "Data elements",
            TABCLASS: "TRANSP",
            CONTFLAG: "S",
            MAINFLAG: "",
            TABKAT: "0",
            TABART: "APPL0",
            BUFALLOW: "N",
            PUFFERUNG: ""
          },
          "SAP_BASIS"
        ),
        fields: ["ROLLNAME", "AS4LOCAL", "DOMNAME", "DATATYPE", "LENG", "DECIMALS"].map(
          (FIELDNAME, index) => ({
            FIELDNAME,
            POSITION: String(index + 1),
            ROLLNAME: "CHAR30",
            KEYFLAG: index < 2 ? "X" : "",
            NOTNULL: index < 2 ? "X" : ""
          })
        )
      }
    ]
  ])

  connectionIds(): string[] {
    return ["w200"]
  }

  connectionDetails(connectionId: string): ConnectionDetails {
    if (connectionId !== "w200") throw new Error(`Connection not found: ${connectionId}`)
    return {
      url: "https://sap.example.invalid",
      client: "200",
      language: "EN",
      username: "DEVELOPER",
      remoteFunctionAllowlist: ["ZCMCP_FM_1501", "ZCMCP_FM_1801", "ZCMCP_FM_1901"]
    }
  }

  async callSapHelper(connectionId: string, request: SapHelperRequest): Promise<SapHelperResult> {
    if (connectionId !== "w200") throw new Error(`Connection not found: ${connectionId}`)
    this.lastHelperRequest = request
    if (request.operation === "PING") {
      return {
        status: "S",
        code: "READY",
        message: "Codex MCP SAP helper is ready",
        version: "1.0"
      }
    }
    if (!request.objectName?.match(/^[ZY]/)) {
      return {
        status: "E",
        code: "CUSTOMER_OBJECT_REQUIRED",
        message: "Only Z* or Y* customer objects are allowed",
        version: "1.0"
      }
    }
    if (request.operation === "PATCH_FUNCTION_INTERFACE") {
      const name = (request.objectName ?? "").toUpperCase()
      const existing = this.functionModules.get(name)
      if (!existing) {
        return {
          status: "E",
          code: "FUNCTION_NOT_FOUND",
          message: "Function module does not exist",
          version: "2.0"
        }
      }
      // Mirrors the SAP helper: the desired rows arrive as the uppercase half of the payload and
      // replace the current parameter/documentation/source rows, while the metadata rows stay.
      // `functionPatchSourceMutation` injects a body change, so the service's own read-back sees
      // an implementation that no longer matches the reviewed source fingerprint.
      const applied = [
        ...existing.filter((line) => line.startsWith("M|")),
        ...(request.source ?? []).filter((line) => /^[IECTXS]\|/.test(line))
      ]
      const saved = this.functionPatchSourceMutation
        ? applied.map((line) =>
            line.includes("CONCATENATE 'MCP:' iv_input INTO ev_output.")
              ? line.replace("'MCP:'", "'CHANGED:'")
              : line
          )
        : applied
      if (!this.functionPatchHelperMismatch) this.functionModules.set(name, saved)
      return {
        status: this.functionPatchHelperMismatch ? "E" : "S",
        code: this.functionPatchHelperMismatch
          ? "FUNCTION_PATCH_SAVE_NOT_OBSERVED"
          : "FUNCTION_INTERFACE_PATCHED",
        message: this.functionPatchHelperMismatch
          ? "Active function does not match the save"
          : "Function interface patched and verified",
        version: "2.0",
        ...(this.functionPatchHelperMismatch
          ? { source: this.functionPatchHelperDifferences() }
          : {})
      }
    }
    if (request.operation === "WRITE_FUNCTION_SOURCE") {
      return this.writeFunctionSourceThroughHelper(request)
    }
    return {
      status: "S",
      code: "TARGET_ALLOWED",
      message: "Customer object target is allowed",
      version: "1.0"
    }
  }

  /** `WRITE_FUNCTION_SOURCE`: the helper replaces the implementation body and nothing else. */
  private writeFunctionSourceThroughHelper(request: SapHelperRequest): SapHelperResult {
    const name = (request.objectName ?? "").toUpperCase()
    const stored = this.functionModules.get(name)
    if (!stored) {
      return {
        status: "E",
        code: "FUNCTION_NOT_FOUND",
        message: "Function module does not exist",
        version: "2.7"
      }
    }
    const currentBody = this.storedFunctionBody(stored)
    if (
      request.expectedVersion &&
      createHash("sha256").update(currentBody.join("\n")).digest("hex") !== request.expectedVersion
    ) {
      return {
        status: "E",
        code: "VERSION_CONFLICT",
        message: "The active function implementation changed",
        version: "2.7"
      }
    }
    if (this.functionWriteReadbackMismatch) {
      // SAP accepts the save and keeps the previous body: the service must not report success.
      return {
        status: "S",
        code: "FUNCTION_SOURCE_WRITTEN",
        message: "Function source written",
        version: "2.7"
      }
    }
    const lines = this.storedFunctionSourceRows(stored)
    const { start, end } = this.storedFunctionBodyRange(lines)
    const sourceRows = stored.filter((line) => /^S\|\d+\|LINE\|/.test(line))
    const merged = [
      ...stored.filter((line) => !/^S\|/.test(line)),
      ...sourceRows.slice(0, start),
      ...(request.source ?? []).map((line) => `S|0|LINE|${line}`),
      ...sourceRows.slice(end)
    ].map((line, index) =>
      line.startsWith("S|") ? line.replace(/^S\|\d+\|/, `S|${index + 1}|`) : line
    )
    this.functionModules.set(name, merged)
    return {
      status: "S",
      code: "FUNCTION_SOURCE_WRITTEN",
      message: "Function source written and verified",
      version: "2.7"
    }
  }

  /**
   * Body line range of a stored function module payload. Mirrors the split the SAP side helper
   * performs: the implementation body starts after the second `*"---` interface separator and ends
   * before ENDFUNCTION. A second copy of that rule lives here on purpose - this stands in for SAP -
   * but it is the service side copy in `src/tools.ts` that owns the real boundary decision.
   */
  private storedFunctionSourceRows(stored: string[]): string[] {
    return stored
      .filter((line) => /^S\|\d+\|LINE\|/.test(line))
      .map((line) => decodeHelperSoapText(line.split("|").slice(3).join("|")))
  }

  private storedFunctionBodyRange(lines: string[]): { start: number; end: number } {
    const separators = lines
      .map((line, index) => (/^\*"-+$/.test(line.trim()) ? index : -1))
      .filter((index) => index >= 0)
    const start = separators.length >= 2 ? separators[1]! + 1 : 0
    let end = lines.length
    for (let index = lines.length - 1; index >= start; index -= 1) {
      if (/^ENDFUNCTION\./i.test(lines[index]!.trim())) {
        end = index
        break
      }
    }
    return { start, end }
  }

  private storedFunctionBody(stored: string[]): string[] {
    const lines = this.storedFunctionSourceRows(stored)
    const { start, end } = this.storedFunctionBodyRange(lines)
    const body = lines.slice(start, end)
    while (body[0]?.trim() === "") body.shift()
    while (body.at(-1)?.trim() === "") body.pop()
    return body
  }

  /**
   * Bounded difference rows a rejected interface patch answers with. The row set is wider than the
   * 49 rows the service forwards, so a test can prove the service truncates and strips unrelated
   * payload rows such as source lines.
   */
  private functionPatchHelperDifferences(): string[] {
    return [
      "D|1|SECTION|DOCUMENTATION",
      "D|1|ROW|2",
      "D|1|FIELD|INDEX",
      "D|1|EXPECTED|1",
      "D|1|ACTUAL|2",
      "S|1|LINE|unrelated source must not be copied",
      `D|2|EXPECTED|${"x".repeat(300)}`,
      ...Array.from({ length: 60 }, () => "D|2|FIELD|BOUNDED")
    ]
  }

  /**
   * Self-descriptions returned by `probeHelperCapabilities`, keyed by helper function module
   * name. Empty by default: an un-upgraded helper answers `OPERATION_NOT_SUPPORTED`, so the
   * default mock reports `operation-scoped` and every capability conclusion stays exactly as
   * it was before the attestation feature existed.
   */
  helperCapabilities = new Map<string, SapHelperCapabilities>()

  /** When true, the `CAPABILITIES` probe fails as if the helper were unreachable (`absent`). */
  helperCapabilitiesUnreachable = false

  /**
   * Overrides the ADT discovery snapshot. The platform-boundary verdicts are derived from what the
   * target advertised, so a test that wants to prove they are measured rather than constant sets
   * this to a snapshot that does or does not expose the endpoint under test.
   */
  discoverySnapshotInfo: DiscoverySnapshotInfo | undefined

  async probeHelperCapabilities(
    connectionId: string,
    helper: string
  ): Promise<SapHelperCapabilities> {
    if (connectionId !== "w200") throw new Error(`Connection not found: ${connectionId}`)
    const probed = helper.trim().toUpperCase()
    if (this.helperCapabilitiesUnreachable) {
      return {
        ...emptyMockHelperCapabilities(probed),
        attestation: "absent",
        detail: `Helper ${probed} did not answer the CAPABILITIES probe`
      }
    }
    const declared = this.helperCapabilities.get(probed)
    if (!declared) return emptyMockHelperCapabilities(probed)
    // Returned verbatim: a declaration that names another helper stays visible so the
    // service-side identity guard can be exercised.
    return { ...declared, observedAt: new Date().toISOString() }
  }

  async callSapRepository(
    connectionId: string,
    request: SapRepositoryRequest
  ): Promise<SapRepositoryResult> {
    if (connectionId !== "w200") throw new Error(`Connection not found: ${connectionId}`)
    this.lastRepositoryRequest = request
    if (request.operation === "INSPECT_REPOSITORY_ASSIGNMENT") {
      return this.repositoryResult("REPOSITORY_ASSIGNMENT_READ", request, [
        "M|1|PARENT_OBJECT|ZCMCP_FG_1501",
        "M|1|PACKAGE|ZABAP",
        "M|1|REQUEST|GR2K923421",
        "M|1|TASK|GR2K923422",
        "M|1|TRANSPORT_STATUS|D",
        "M|1|ACTIVE|X",
        "M|1|GENERATED|X",
        "M|1|ORIGINAL_SYSTEM|GR2"
      ])
    }
    if (request.operation === "READ_CUSTOMER_EXIT_DEFINITION") {
      if (request.objectName !== "V45A0002") {
        return this.repositoryError(
          "CUSTOMER_EXIT_DEFINITION_NOT_FOUND",
          "SMOD enhancement definition does not exist"
        )
      }
      return this.repositoryResult("CUSTOMER_EXIT_DEFINITION_READ", request, [
        ...payloadRows("M", [{ NAME: "V45A0002", DESCRIPTION: "Predefine sold-to party" }]),
        ...payloadRows("C", [
          { TYPE: "E", MEMBER: "EXIT_SAPMV45A_002" },
          { TYPE: "S", MEMBER: "SAPMV45A_8309_SUB_B" },
          { TYPE: "C", MEMBER: "SAPMV45A+ZZ1" }
        ])
      ])
    }
    if (request.operation === "READ_CUSTOMER_EXIT_PROJECT") {
      if (request.objectName !== "ZSD_EXIT") {
        return this.repositoryError(
          "CUSTOMER_EXIT_PROJECT_NOT_FOUND",
          "CMOD enhancement project does not exist"
        )
      }
      return this.repositoryResult("CUSTOMER_EXIT_PROJECT_READ", request, [
        ...payloadRows("M", [
          { NAME: "ZSD_EXIT", STATUS: "A", CHANGED_BY: "DEVELOPER", CHANGED_ON: "20260916" }
        ]),
        ...payloadRows("A", [
          { TYPE: "", MEMBER: "V45A0002" },
          { TYPE: "", MEMBER: "V45A0003" }
        ])
      ])
    }
    if (request.operation === "READ_CLASSIC_BADI_DEFINITION") {
      if (request.objectName !== "ME_PROCESS_PO_CUST") {
        return this.repositoryError(
          "CLASSIC_BADI_DEFINITION_NOT_FOUND",
          "Classic BAdI definition does not exist"
        )
      }
      return this.repositoryResult("CLASSIC_BADI_DEFINITION_READ", request, [
        ...payloadRows("M", [
          {
            NAME: "ME_PROCESS_PO_CUST",
            DESCRIPTION: "Purchase order processing",
            VERSION: "000001",
            FILTER_TYPE: "BUKRS",
            FILTER_EXTENSION: "",
            MULTIPLE_USE: "X",
            PACKAGE: "ME",
            MASTER_LANGUAGE: "E",
            DEFAULT_CLASS: "CL_EX_ME_PROCESS_PO_CUST",
            EXAMPLE_CLASS: "CL_EXM_IM_ME_PROCESS_PO_CUST",
            CHECK_CLASS: "",
            INTERNAL: "",
            MIGRATION_ENHANCEMENT_SPOT: "",
            MIGRATION_BADI_NAME: ""
          }
        ]),
        ...payloadRows("I", [{ INTERFACE_NAME: "IF_EX_ME_PROCESS_PO_CUST" }]),
        ...payloadRows(
          "A",
          [
            {
              IMPLEMENTATION_NAME: "ZME_PO_IMPL",
              FILTER_VALUE: "1000",
              ACTIVE: "X",
              DESCRIPTION: "PO checks",
              VERSION: "000001",
              MASTER_LANGUAGE: "E",
              LAYER: "",
              MIGRATION_ENHANCEMENT: ""
            },
            {
              IMPLEMENTATION_NAME: "ZME_PO_IMPL",
              FILTER_VALUE: "2000",
              ACTIVE: "X",
              DESCRIPTION: "PO checks",
              VERSION: "000001",
              MASTER_LANGUAGE: "E",
              LAYER: "",
              MIGRATION_ENHANCEMENT: ""
            },
            {
              IMPLEMENTATION_NAME: "ZME_PO_OLD",
              FILTER_VALUE: "",
              ACTIVE: "",
              DESCRIPTION: "Inactive checks",
              VERSION: "000001",
              MASTER_LANGUAGE: "E",
              LAYER: "",
              MIGRATION_ENHANCEMENT: ""
            }
          ].filter((row) => this.classicBadiImplementations.has(row.IMPLEMENTATION_NAME))
        ),
        ...payloadRows(
          "C",
          [
            {
              IMPLEMENTATION_NAME: "ZME_PO_IMPL",
              INTERFACE_NAME: "IF_EX_ME_PROCESS_PO_CUST",
              IMPLEMENTATION_CLASS: "ZCL_IM_ME_PO"
            },
            {
              IMPLEMENTATION_NAME: "ZME_PO_OLD",
              INTERFACE_NAME: "IF_EX_ME_PROCESS_PO_CUST",
              IMPLEMENTATION_CLASS: "ZCL_IM_ME_PO_OLD"
            }
          ].filter((row) => this.classicBadiImplementations.has(row.IMPLEMENTATION_NAME))
        ),
        ...(this.classicBadiImplementations.has("ZME_PO_NEW")
          ? [
              ...payloadRows("A", [
                {
                  IMPLEMENTATION_NAME: "ZME_PO_NEW",
                  FILTER_VALUE: "",
                  ACTIVE: "X",
                  DESCRIPTION: "",
                  VERSION: "000001",
                  MASTER_LANGUAGE: "E",
                  LAYER: "",
                  MIGRATION_ENHANCEMENT: ""
                }
              ]),
              ...payloadRows("C", [
                {
                  IMPLEMENTATION_NAME: "ZME_PO_NEW",
                  INTERFACE_NAME: "IF_EX_ME_PROCESS_PO_CUST",
                  IMPLEMENTATION_CLASS: "ZCL_IM_ME_PO_NEW"
                }
              ])
            ]
          : [])
      ])
    }
    if (request.operation === "MANAGE_CLASSIC_BADI_IMPL") {
      const objectName = request.objectName ?? ""
      if (request.objectType === "CREATE") {
        this.classicBadiImplementations.add(objectName)
      } else if (request.objectType === "DELETE") {
        this.classicBadiImplementations.delete(objectName)
      }
      return this.repositoryResult("CLASSIC_BADI_IMPLEMENTATION_CHANGED", request, [])
    }
    if (request.operation === "READ_ENHANCEMENT_IMPL") {
      const source = this.enhancementImplementations.get(request.objectName ?? "")
      return source
        ? this.repositoryResult("ENHANCEMENT_IMPLEMENTATION_READ", request, source)
        : this.repositoryError(
            "ENHANCEMENT_IMPLEMENTATION_NOT_FOUND",
            "Enhancement implementation not found"
          )
    }
    if (
      request.operation === "CREATE_HOOK_ENHANCEMENT" ||
      request.operation === "CREATE_BADI_ENHANCEMENT"
    ) {
      const objectName = request.objectName ?? ""
      const requestSource = request.source ?? []
      const metadata = parseEnhancementPayload(requestSource, "M")
      const packageName = request.packageName ?? ""
      const source =
        request.operation === "CREATE_HOOK_ENHANCEMENT"
          ? [
              ...payloadRows("M", [
                {
                  NAME: objectName,
                  TOOL: "HOOK_IMPL",
                  SHORT_TEXT: request.description ?? "",
                  ACTIVE: "X",
                  INACTIVE: "",
                  SAVED_INACTIVE: "",
                  UNSAVED_INACTIVE: "",
                  PACKAGE: packageName,
                  ORIGINAL_OBJECT_TYPE: metadata[0]?.ORIGINAL_OBJECT_TYPE ?? "",
                  ORIGINAL_OBJECT_NAME: metadata[0]?.ORIGINAL_OBJECT_NAME ?? "",
                  MAIN_OBJECT_TYPE: metadata[0]?.MAIN_OBJECT_TYPE ?? "",
                  MAIN_OBJECT_NAME: metadata[0]?.MAIN_OBJECT_NAME ?? "",
                  PROGRAM_NAME: metadata[0]?.PROGRAM_NAME ?? ""
                }
              ]),
              ...payloadRows("H", [
                {
                  EXTID: "1",
                  FULL_NAME: metadata[0]?.FULL_NAME ?? "",
                  MODE: metadata[0]?.MODE ?? "",
                  SOURCE_COUNT: String(parseEnhancementPayload(requestSource, "S").length)
                }
              ]),
              ...parseEnhancementPayload(requestSource, "S").flatMap((row, index) =>
                payloadRows("S", [
                  { HOOK_INDEX: "1", LINE_NUMBER: String(index + 1), LINE: row.LINE ?? "" }
                ]).map((line) => line.replace(/^S\|1\|/, `S|${index + 1}|`))
              )
            ]
          : [
              ...payloadRows("M", [
                {
                  NAME: objectName,
                  TOOL: "BADI_IMPL",
                  SHORT_TEXT: request.description ?? "",
                  ACTIVE: "X",
                  INACTIVE: "",
                  SAVED_INACTIVE: "",
                  UNSAVED_INACTIVE: "",
                  PACKAGE: packageName,
                  SPOT_NAME: metadata[0]?.SPOT_NAME ?? ""
                }
              ]),
              ...payloadRows("B", [
                {
                  SPOT_NAME: metadata[0]?.SPOT_NAME ?? "",
                  BADI_NAME: metadata[0]?.BADI_NAME ?? "",
                  IMPL_NAME: metadata[0]?.IMPLEMENTATION_NAME ?? "",
                  IMPL_CLASS: metadata[0]?.IMPLEMENTATION_CLASS ?? "",
                  ACTIVE: "X",
                  IS_DEFAULT: metadata[0]?.DEFAULT_IMPLEMENTATION ?? "",
                  SHORT_TEXT: request.description ?? ""
                }
              ]),
              ...requestSource.filter((line) => line.startsWith("F|"))
            ]
      this.enhancementImplementations.set(objectName, source)
      return this.repositoryResult(
        request.operation === "CREATE_HOOK_ENHANCEMENT"
          ? "HOOK_ENHANCEMENT_CREATED"
          : "BADI_ENHANCEMENT_CREATED",
        request,
        []
      )
    }
    if (request.operation === "UPDATE_HOOK_ENHANCEMENT") {
      const objectName = request.objectName ?? ""
      const current = this.enhancementImplementations.get(objectName) ?? []
      const metadata = parseEnhancementPayload(current, "M")[0] ?? {}
      const hookRows = parseEnhancementPayload(current, "H")
      const updateMetadata = parseEnhancementPayload(request.source ?? [], "M")[0] ?? {}
      const extId = updateMetadata.EXTID ?? ""
      const hookIndex = hookRows.findIndex((row) => row.EXTID === extId)
      if (hookIndex < 0) return this.repositoryError("ENHANCEMENT_HOOK_NOT_FOUND", "Hook not found")
      const updateSource = parseEnhancementPayload(request.source ?? [], "S")
      hookRows[hookIndex]!.SOURCE_COUNT = String(updateSource.length)
      if (request.description) metadata.SHORT_TEXT = request.description
      metadata.ACTIVE = "X"
      metadata.INACTIVE = ""
      metadata.SAVED_INACTIVE = ""
      metadata.UNSAVED_INACTIVE = ""
      const otherSourceRows = parseEnhancementPayload(current, "S").filter(
        (row) => row.HOOK_INDEX !== String(hookIndex + 1)
      )
      const newSourceRows = updateSource.map((row, index) => ({
        HOOK_INDEX: String(hookIndex + 1),
        LINE_NUMBER: String(index + 1),
        LINE: row.LINE ?? ""
      }))
      this.enhancementImplementations.set(objectName, [
        ...payloadRows("M", [metadata]),
        ...payloadRows("H", hookRows),
        ...payloadRows("S", [...otherSourceRows, ...newSourceRows])
      ])
      return this.repositoryResult("HOOK_ENHANCEMENT_UPDATED", request, [])
    }
    if (request.operation === "UPDATE_BADI_ENHANCEMENT") {
      const objectName = request.objectName ?? ""
      const current = this.enhancementImplementations.get(objectName) ?? []
      const metadata = parseEnhancementPayload(current, "M")[0] ?? {}
      const implementations = parseEnhancementPayload(current, "B")
      const updateMetadata = parseEnhancementPayload(request.source ?? [], "M")[0] ?? {}
      const implementationName = updateMetadata.IMPLEMENTATION_NAME ?? ""
      const implementation = implementations.find((row) => row.IMPL_NAME === implementationName)
      if (!implementation) {
        return this.repositoryError("NEW_BADI_IMPLEMENTATION_NOT_FOUND", "BAdI not found")
      }
      implementation.IMPL_CLASS = updateMetadata.IMPLEMENTATION_CLASS ?? ""
      implementation.ACTIVE = updateMetadata.ACTIVE ?? ""
      implementation.IS_DEFAULT = updateMetadata.DEFAULT_IMPLEMENTATION ?? ""
      if (request.description) {
        metadata.SHORT_TEXT = request.description
        implementation.SHORT_TEXT = request.description
      }
      metadata.ACTIVE = "X"
      metadata.INACTIVE = ""
      metadata.SAVED_INACTIVE = ""
      metadata.UNSAVED_INACTIVE = ""
      const filters = parseEnhancementPayload(request.source ?? [], "F").map((row) => ({
        ...row,
        IMPLEMENTATION_NAME: implementationName
      }))
      this.enhancementImplementations.set(objectName, [
        ...payloadRows("M", [metadata]),
        ...payloadRows("B", implementations),
        ...payloadRows("F", filters)
      ])
      return this.repositoryResult("BADI_ENHANCEMENT_UPDATED", request, [])
    }
    if (request.operation === "MANAGE_ENHANCEMENT_STATE") {
      const objectName = request.objectName ?? ""
      const current = this.enhancementImplementations.get(objectName) ?? []
      const metadata = parseEnhancementPayload(current, "M")[0] ?? {}
      metadata.ACTIVE = "X"
      metadata.INACTIVE = ""
      metadata.SAVED_INACTIVE = ""
      metadata.UNSAVED_INACTIVE = ""
      this.enhancementImplementations.set(objectName, [
        ...payloadRows("M", [metadata]),
        ...current.filter((line) => !line.startsWith("M|"))
      ])
      return this.repositoryResult(
        request.objectType === "ACTIVATE"
          ? "ENHANCEMENT_IMPLEMENTATION_ACTIVATED"
          : "ENHANCEMENT_INACTIVE_VERSION_DISCARDED",
        request,
        []
      )
    }
    if (request.operation === "DELETE_ENHANCEMENT_IMPL") {
      this.enhancementImplementations.delete(request.objectName ?? "")
      return this.repositoryResult("ENHANCEMENT_IMPLEMENTATION_DELETED", request, [])
    }
    if (request.operation === "READ_BTE_CONFIGURATION") {
      if (request.objectType === "E" && request.objectName === "CS000010") {
        return this.repositoryResult("BTE_CONFIGURATION_READ", request, [
          ...payloadRows("M", [
            { IDENTIFIER: "CS000010", KIND: "E", DESCRIPTION: "Credit status event" }
          ]),
          ...payloadRows("S", [
            {
              COUNTRY: "",
              APPLICATION: "CS",
              FUNCTION_MODULE: "SAMPLE_INTERFACE_CS000010",
              APPLICATION_ACTIVE: "X",
              APPLICATION_TEXT: "Credit Management"
            }
          ]),
          ...payloadRows("C", [
            {
              COUNTRY: "",
              APPLICATION: "CS",
              FUNCTION_MODULE: "Z_BTE_CS000010",
              PRODUCT: "ZBTE",
              APPLICATION_ACTIVE: "X",
              APPLICATION_TEXT: "Credit Management",
              PRODUCT_ACTIVE: "X",
              PRODUCT_TEXT: "Customer BTE handlers",
              PRODUCT_RFC_DESTINATION: ""
            }
          ])
        ])
      }
      if (request.objectType === "P" && request.objectName === "CRM0_200") {
        return this.repositoryResult("BTE_CONFIGURATION_READ", request, [
          ...payloadRows("M", [{ IDENTIFIER: "CRM0_200", KIND: "P", DESCRIPTION: "CRM process" }]),
          ...payloadRows("C", [
            {
              COUNTRY: "",
              APPLICATION: "CRM",
              FUNCTION_MODULE: "Z_BTE_CRM0_200",
              PRODUCT: "ZCRM",
              APPLICATION_ACTIVE: "X",
              APPLICATION_TEXT: "CRM",
              PRODUCT_ACTIVE: "",
              PRODUCT_TEXT: "CRM integration",
              PRODUCT_RFC_DESTINATION: ""
            }
          ])
        ])
      }
      return this.repositoryError("BTE_DEFINITION_NOT_FOUND", "BTE definition does not exist")
    }
    if (
      request.operation === "READ_FUNCTION_INTERFACE" ||
      request.operation === "CREATE_FUNCTION_MODULE" ||
      request.operation === "PATCH_FUNCTION_INTERFACE"
    ) {
      const name = (request.objectName ?? "").toUpperCase()
      const existing = this.functionModules.get(name)
      if (request.operation === "READ_FUNCTION_INTERFACE" && !existing) {
        // Mirrors w200 exactly. The helper answers a missing function module with a code that says
        // only that the read failed and a message whose "does not exist" wording is localised, so a
        // mock that said FUNCTION_NOT_FOUND would hide the defect this shape caused.
        return this.repositoryError("FUNCTION_READ_FAILED", `功能模块 ${name} 不存在`)
      }
      if (request.operation === "CREATE_FUNCTION_MODULE" && existing) {
        return this.repositoryError("FUNCTION_EXISTS", "Function module already exists")
      }
      if (request.operation === "CREATE_FUNCTION_MODULE") {
        const stored = [
          `M|1|FUNCTION_GROUP|${request.program ?? ""}`,
          `M|1|SHORT_TEXT|${request.description ?? ""}`,
          `M|1|REMOTE_ENABLED|${request.objectType === "R" ? "X" : ""}`,
          "M|1|UPDATE_TASK|",
          "M|1|GLOBAL_INTERFACE|",
          `S|1|LINE|FUNCTION ${name}.`,
          ...(request.source ?? []).map((line) => {
            const parts = line.split("|")
            const index = Number.parseInt(parts[1] ?? "0", 10) + 1
            return parts[0] === "S" ? `S|${index}|${parts.slice(2).join("|")}` : line
          }),
          `S|${(request.source ?? []).filter((line) => line.startsWith("S|")).length + 2}|LINE|ENDFUNCTION.`
        ]
        // The last `S|` row that is not the closing ENDFUNCTION row is the last stored body line.
        // Dropping it stands in for the source SAP rewrites on save, so the read-back disagrees with
        // the request in exactly one known place.
        let body = -1
        if (this.functionCreateReadbackDropsSourceLine) {
          for (let index = stored.length - 2; index >= 0; index -= 1) {
            if (stored[index]!.startsWith("S|")) {
              body = index
              break
            }
          }
        }
        this.functionModules.set(
          name,
          stored.filter((_line, index) => index !== body)
        )
      }
      if (request.operation === "PATCH_FUNCTION_INTERFACE") {
        if (!existing) {
          return this.repositoryError("FUNCTION_NOT_FOUND", "Function module does not exist")
        }
        if (!this.functionPatchReadbackMismatch) {
          const metadata = existing.filter((line) => line.startsWith("M|"))
          const desired = (request.source ?? []).filter((line) => /^[IECTXS]\|/.test(line))
          this.functionModules.set(name, [...metadata, ...desired])
        }
      }
      const result = this.repositoryResult(
        request.operation === "READ_FUNCTION_INTERFACE"
          ? "FUNCTION_INTERFACE_READ"
          : request.operation === "CREATE_FUNCTION_MODULE"
            ? "FUNCTION_MODULE_CREATED"
            : "FUNCTION_INTERFACE_PATCHED",
        request,
        this.functionModules.get(name)!
      )
      return request.operation === "PATCH_FUNCTION_INTERFACE"
        ? { ...result, version: "2.0" }
        : result
    }
    if (request.operation === "READ_TEXT_ELEMENTS" || request.operation === "MERGE_TEXT_ELEMENTS") {
      const name = (request.program ?? "").toUpperCase()
      const existing = this.textElementsByName.get(name) ?? []
      if (request.operation === "MERGE_TEXT_ELEMENTS") {
        const merged = new Map(existing.map((element) => [element.id, element]))
        for (const row of parsePayloadRows(request.source ?? [], "T")) {
          const id = (row.ID ?? "").toUpperCase()
          const action = row.ACTION ?? ""
          if (action === "CREATE" && merged.has(id)) {
            return this.repositoryError("TEXT_ELEMENT_EXISTS", `Text element ${id} already exists`)
          }
          if (action === "UPDATE" && !merged.has(id)) {
            return this.repositoryError(
              "TEXT_ELEMENT_NOT_FOUND",
              `Text element ${id} does not exist`
            )
          }
          merged.set(id, {
            id,
            text: row.TEXT ?? "",
            maxLength: Number.parseInt(row.MAXLENGTH ?? "0", 10)
          })
        }
        this.textElementsByName.set(name, [...merged.values()])
      }
      const saved = this.textElementsByName.get(name) ?? existing
      return this.repositoryResult(
        request.operation === "READ_TEXT_ELEMENTS" ? "TEXT_ELEMENTS_READ" : "TEXT_ELEMENTS_SAVED",
        request,
        [
          ...payloadRows("M", [
            { PACKAGE: "ZVALIDATION", VERSION: "20260831140000", REQUEST: "W200K900001" }
          ]),
          ...payloadRows(
            "T",
            saved.map((element) => ({
              ID: element.id,
              TEXT: element.text,
              MAXLENGTH: String(element.maxLength ?? 0)
            }))
          )
        ]
      )
    }
    if (request.operation === "READ_SMARTSTYLE") {
      const failure = this.smartstyleFailure
      if (failure) return this.repositoryError(failure.code, failure.message)
    }
    if (
      request.operation === "READ_MESSAGE_CLASS" ||
      request.operation === "CREATE_MESSAGE_CLASS"
    ) {
      const name = (request.objectName ?? "").toUpperCase()
      const existing = this.messageClasses.get(name)
      if (request.operation === "READ_MESSAGE_CLASS" && !existing) {
        return this.repositoryError("MESSAGE_CLASS_NOT_FOUND", "Message class does not exist")
      }
      if (request.operation === "CREATE_MESSAGE_CLASS" && existing) {
        return this.repositoryError(
          "MESSAGE_CLASS_EXISTS",
          "Existing message classes cannot be replaced"
        )
      }
      if (request.operation === "CREATE_MESSAGE_CLASS") {
        const messages = parsePayloadRows(request.source ?? [], "F").map((row) => ({
          number: row.MSGNR ?? "",
          text: row.TEXT ?? ""
        }))
        this.messageClasses.set(name, {
          description: request.description ?? "",
          packageName: request.packageName ?? "",
          messages
        })
      }
      const saved = this.messageClasses.get(name)!
      return this.repositoryResult(
        request.operation === "READ_MESSAGE_CLASS" ? "MESSAGE_CLASS_READ" : "MESSAGE_CLASS_CREATED",
        request,
        [
          ...payloadRows("M", [
            {
              PACKAGE: saved.packageName,
              VERSION: "20260831140000",
              DESCRIPTION: saved.description,
              MASTERLANG: "E",
              REQUEST: request.transportNumber ?? ""
            }
          ]),
          ...payloadRows(
            "F",
            saved.messages.map((message) => ({ MSGNR: message.number, TEXT: message.text }))
          )
        ]
      )
    }
    if (request.operation === "READ_GUI_DEFINITION") {
      return this.guiResult("GUI_DEFINITION_READ", request)
    }
    if (request.operation === "PATCH_GUI_DEFINITION") {
      const definition = request.guiDefinition
      if (!definition)
        return this.repositoryError("GUI_PAYLOAD_REQUIRED", "GUI payload is required")
      if (definition.expectedVersion !== this.guiVersion) {
        return this.repositoryError(
          "GUI_VERSION_CONFLICT",
          "GUI definition changed since it was read"
        )
      }
      this.guiAdmin = structuredClone(definition.admin)
      this.guiSections = structuredClone(definition.sections)
      this.guiVersion = "20260902090100"
      return this.guiResult("GUI_DEFINITION_PATCHED", request)
    }
    if (request.operation === "DELETE_TRANSACTION") {
      return this.repositoryResult("TRANSACTION_DELETED", request, [])
    }
    if (request.operation === "DELETE_MODULE_POOL") {
      if (request.packageName !== "ZVALIDATION") {
        return this.repositoryError(
          "MODULE_POOL_ASSIGNMENT_MISMATCH",
          "Module pool package or type mismatch"
        )
      }
      return this.repositoryResult("MODULE_POOL_DELETED", request, [])
    }
    if (request.operation === "READ_SCREEN") {
      return this.screenResult("SCREEN_READ")
    }
    if (request.operation === "UPSERT_SCREEN") {
      this.screen = {
        description: request.description ?? "",
        header: { ...this.screen.header, ...(request.header ?? {}) },
        fields: (request.fields ?? []).map(mockNativeScreenField),
        flowLogic: structuredClone(request.flowLogic ?? []),
        params: structuredClone(request.params ?? [])
      }
      return this.screenResult("SCREEN_SAVED")
    }
    if (request.operation === "PATCH_SCREEN") {
      const fields = structuredClone(this.screen.fields)
      for (const operation of request.componentOperations ?? []) {
        const index = fields.findIndex((field) => field.FNAM === operation.name)
        if (operation.operation === "ADD") {
          fields.push(mockNativeScreenField(operation.definition ?? { NAME: operation.name }))
        } else if (operation.operation === "UPDATE") {
          fields[index] = {
            ...fields[index],
            ...mockNativeScreenField(operation.definition ?? { NAME: operation.name })
          }
        } else {
          fields.splice(index, 1)
        }
      }
      this.screen = {
        description:
          request.description === undefined ? this.screen.description : request.description,
        header: { ...this.screen.header, ...(request.header ?? {}) },
        fields,
        flowLogic:
          request.flowLogic === undefined
            ? this.screen.flowLogic
            : structuredClone(request.flowLogic),
        params: request.params === undefined ? this.screen.params : structuredClone(request.params)
      }
      return this.screenResult("SCREEN_PATCHED")
    }
    const header = {
      PROG: request.program ?? "ZMODULE_POOL",
      DNUM: request.screen ?? "0100",
      TYPE: "N",
      FNUM: "0002",
      MILI: "0001",
      MICO: "0001",
      MALI: "0020",
      MACO: "0080",
      SPRA: "E"
    }
    const fields = request.fields ?? [
      { FNAM: "GV_NAME", TYPE: "CHAR", LENG: "40", LINE: "0003", COLN: "0010" }
    ]
    return {
      status: "S",
      code:
        request.operation === "CREATE_MODULE_POOL"
          ? "MODULE_POOL_CREATED"
          : request.operation === "READ_TRANSACTION"
            ? "TRANSACTION_READ"
            : request.operation === "CREATE_REPORT_TRANSACTION"
              ? "REPORT_TRANSACTION_CREATED"
              : "TRANSACTION_CREATED",
      message: "Mock repository operation completed",
      version: "1.1",
      header,
      dynproText: request.description ?? "Mock screen",
      fields,
      flowLogic: request.flowLogic ?? [{ LINE: "PROCESS BEFORE OUTPUT." }],
      params: request.params ?? [],
      transactions:
        request.operation === "READ_TRANSACTION" ||
        request.operation === "CREATE_TRANSACTION" ||
        request.operation === "CREATE_REPORT_TRANSACTION"
          ? [
              {
                TCODE: request.transaction ?? "ZMODULE_POOL_UI",
                PGMNA: request.program ?? "ZMODULE_POOL",
                DYPNO: request.screen ?? ""
              }
            ]
          : [],
      guiAttributes: [],
      source: request.source ?? []
    }
  }

  private screenResult(code: string): SapRepositoryResult {
    return {
      status: "S",
      code,
      message: "Mock repository operation completed",
      version: "1.4",
      header: structuredClone(this.screen.header),
      dynproText: this.screen.description,
      fields: structuredClone(this.screen.fields),
      flowLogic: structuredClone(this.screen.flowLogic),
      params: structuredClone(this.screen.params),
      transactions: [],
      guiAttributes: [],
      source: []
    }
  }

  private guiResult(code: string, request: SapRepositoryRequest): SapRepositoryResult {
    const source: string[] = [
      `M|1|VERSION|${this.guiVersion}`,
      "M|1|AUTHOR|DEVELOPER",
      "M|1|LANGUAGE|E",
      "M|1|PACKAGE|ZVALIDATION"
    ]
    const append = (kind: string, rows: Array<Record<string, string>>) => {
      rows.forEach((row, index) =>
        Object.entries(row).forEach(([name, value]) =>
          source.push(
            `${kind}|${index + 1}|${name}|${value.replaceAll("%", "%25").replaceAll("|", "%7C")}`
          )
        )
      )
    }
    append("ADM", [this.guiAdmin])
    Object.entries(this.guiSections).forEach(([kind, rows]) => append(kind, rows))
    return {
      ...this.repositoryResult(code, request, source),
      version: "1.5"
    }
  }

  private repositoryResult(
    code: string,
    request: SapRepositoryRequest,
    source: string[]
  ): SapRepositoryResult {
    return {
      status: "S",
      code,
      message: "Mock repository operation completed",
      version: "1.2",
      header: {},
      dynproText: "",
      fields: [],
      flowLogic: [],
      params: [],
      transactions: [],
      guiAttributes: [],
      source
    }
  }

  private repositoryError(code: string, message: string): SapRepositoryResult {
    return {
      status: "E",
      code,
      message,
      version: "1.2",
      header: {},
      dynproText: "",
      fields: [],
      flowLogic: [],
      params: [],
      transactions: [],
      guiAttributes: [],
      source: []
    }
  }

  async callSapDdic(connectionId: string, request: SapDdicRequest): Promise<SapDdicResult> {
    if (connectionId !== "w200") throw new Error(`Connection not found: ${connectionId}`)
    if (request.operation === "RECOVER_TABLE_CONVERSION") {
      const existing = this.ddicByKey.get(`READ_TRANSPARENT_TABLE:${request.objectName}`)
      if (!existing) {
        return {
          ...mockDdicResult("transparentTable", {}, ""),
          status: "E",
          code: "DDIC_OBJECT_NOT_FOUND",
          message: "DDIC object does not exist"
        }
      }
      this.conversionEntries = []
      return {
        ...structuredClone(existing),
        code: "DDIC_CONVERSION_RECOVERED",
        message: "Native table conversion completed and verified",
        recordedRequest: request.transportNumber ?? ""
      }
    }
    const readOperation = request.operation
      .replace("UPSERT", "READ")
      .replace("CREATE_TRANSPARENT_TABLE", "READ_TRANSPARENT_TABLE")
      .replace("APPEND_TRANSPARENT_TABLE_FIELDS", "READ_TRANSPARENT_TABLE")
      .replace("PATCH_TRANSPARENT_TABLE_FIELDS", "READ_TRANSPARENT_TABLE")
      .replace("PATCH_TRANSPARENT_TABLE_SETTINGS", "READ_TRANSPARENT_TABLE")
      .replace("DELETE", "READ")
    const key = `${readOperation}:${request.objectName}`
    const existing = this.ddicByKey.get(key)
    if (request.operation.startsWith("READ")) {
      if (this.ddicReadFailure) {
        return {
          ...(existing ?? mockDdicResult(ddicKind(request.operation), {}, "")),
          status: "E",
          code: this.ddicReadFailure.code,
          message: this.ddicReadFailure.message,
          metadata: {}
        }
      }
      return existing
        ? structuredClone(existing)
        : {
            ...mockDdicResult("domain", {}, ""),
            status: "E",
            code: "DDIC_OBJECT_NOT_FOUND",
            message: "DDIC object does not exist"
          }
    }
    if (request.operation.startsWith("DELETE")) {
      if (!existing) {
        return {
          ...mockDdicResult("domain", {}, ""),
          status: "E",
          code: "DDIC_OBJECT_NOT_FOUND",
          message: "DDIC object does not exist"
        }
      }
      if (request.expectedVersion !== existing.objectVersion) {
        return {
          ...existing,
          status: "E",
          code: "VERSION_CONFLICT",
          message: "DDIC object changed since it was read"
        }
      }
      if (request.packageName !== existing.packageName) {
        return {
          ...existing,
          status: "E",
          code: "PACKAGE_CONFLICT",
          message: "DDIC object belongs to another package"
        }
      }
      this.ddicByKey.delete(key)
      return {
        ...mockDdicResult(ddicKind(request.operation), {}, request.packageName ?? ""),
        code: "DDIC_OBJECT_DELETED",
        message: "DDIC object deleted after dependency check",
        recordedRequest: request.transportNumber ?? ""
      }
    }
    if (request.operation === "CREATE_TRANSPARENT_TABLE" && existing) {
      return {
        ...existing,
        status: "E",
        code: "DDIC_OBJECT_EXISTS",
        message: "Existing transparent tables cannot be replaced"
      }
    }
    if (existing && !request.expectedVersion) {
      return {
        ...existing,
        status: "E",
        code: "EXPECTED_VERSION_REQUIRED",
        message: "Existing object requires version token"
      }
    }
    if (existing && request.expectedVersion !== existing.objectVersion) {
      return {
        ...existing,
        status: "E",
        code: "VERSION_CONFLICT",
        message: "DDIC object changed since it was read"
      }
    }
    if (!existing && request.expectedVersion) {
      return {
        ...mockDdicResult("domain", {}, ""),
        status: "E",
        code: "VERSION_CONFLICT",
        message: "Expected object version no longer exists"
      }
    }
    if (this.ddicWriteFailureCode) {
      // The definition was saved but never proven active: SAP keeps the previous active version and
      // an inactive version remains. Nothing in the store changes, which is what makes the old
      // "read the active version back" verification pass and report a completed write.
      return {
        ...(existing ?? mockDdicResult(ddicKind(request.operation), {}, request.packageName ?? "")),
        status: "E",
        code: this.ddicWriteFailureCode,
        message: "The saved definition is still not active",
        metadata: {
          PHASE: "activation_incomplete",
          ACT_RC: "4",
          ACT_SUBRC: "0",
          GOTSTATE: "M"
        }
      }
    }
    if (request.operation === "APPEND_TRANSPARENT_TABLE_FIELDS" && existing) {
      const fields = existing.fields.map((field) => ({ ...field }))
      const appendIndex = fields.findIndex((field) => field.FIELDNAME?.startsWith(".INCLU--AP"))
      fields.splice(appendIndex < 0 ? fields.length : appendIndex, 0, ...(request.fields ?? []))
      const saved: SapDdicResult = {
        ...existing,
        code: "DDIC_OBJECT_SAVED",
        message: "DDIC object saved activated and verified",
        objectVersion: "20260831130000",
        recordedRequest: request.transportNumber ?? "",
        fields: fields.map((field, index) => ({ ...field, POSITION: String(index + 1) }))
      }
      this.ddicByKey.set(key, saved)
      return structuredClone(saved)
    }
    if (request.operation === "PATCH_TRANSPARENT_TABLE_FIELDS" && existing) {
      const saved: SapDdicResult = {
        ...existing,
        code: "DDIC_OBJECT_SAVED",
        message: "DDIC object saved activated and verified",
        objectVersion: "20260831140000",
        recordedRequest: request.transportNumber ?? "",
        fields: (request.fields ?? []).map((field, index) => ({
          ...field,
          POSITION: String(index + 1)
        }))
      }
      this.ddicByKey.set(key, saved)
      return structuredClone(saved)
    }
    if (request.operation === "PATCH_TRANSPARENT_TABLE_SETTINGS" && existing) {
      const saved: SapDdicResult = {
        ...existing,
        code: "DDIC_OBJECT_SAVED",
        message: "DDIC object saved activated and verified",
        objectVersion: "20260831150000",
        recordedRequest: request.transportNumber ?? "",
        header: { ...existing.header, ...request.header }
      }
      this.ddicByKey.set(key, saved)
      return structuredClone(saved)
    }
    const kind = ddicKind(request.operation)
    // TNRO-NOIVBUFFER (NRIVBUFFER) is N 16, measured on w200 by the DD03L probe recorded in
    // .doc/code-update-20260922-140723.md. As with the search help columns above, the helper assigns
    // the caller's text into that numeric component, so SAP stores the padded value; the padding is
    // modelled here because the raw echo is exactly what hid the service's raw-text comparison.
    const numberRangeIdentity: Record<string, string> = { OBJECT: request.objectName }
    const numericBuffer = request.header?.NOIVBUFFER
    if (numericBuffer !== undefined && /^\d+$/.test(numericBuffer)) {
      numberRangeIdentity.NOIVBUFFER = numericBuffer.padStart(16, "0")
    }
    const identity = {
      domain: { DOMNAME: request.objectName },
      dataElement: { ROLLNAME: request.objectName },
      numberRangeObject: numberRangeIdentity,
      searchHelp: { SHLPNAME: request.objectName },
      lockObject: {
        // DD25V holds lock objects, and its identity column is VIEWNAME, not LOCKOBJECT.
        VIEWNAME: request.objectName,
        AGGTYPE: request.header?.AGGTYPE ?? "E",
        // DD25V-ROOTTAB is derived by the ENQU activation, it is not a copy of the request. Live w200
        // evidence 2026-09-24 23:20: creating EZPMCTPRP with no ROOTTAB in the header stored
        // ROOTTAB = ZTPMC_TPRPH, the locked table. A fake that left this unset made the service's
        // invented "" expectation agree with itself, which is how a false-negative verification
        // shipped with 862 green tests; the derivation is modelled here so the comparison can fail.
        // FORTABNAME handling for lock tables is deliberately NOT modelled: no live evidence
        // establishes what ENQU activation fills in, and the service only asserts row keys the caller
        // actually sent, so guessing here would invent SAP behaviour instead of testing it.
        ROOTTAB: request.header?.ROOTTAB || request.lockTables?.[0]?.TABNAME || ""
      },
      structure: { TABNAME: request.objectName, TABCLASS: "INTTAB" },
      transparentTable: { TABNAME: request.objectName, TABCLASS: "TRANSP" },
      tableType: {
        TYPENAME: request.objectName,
        ROWKIND: "S",
        DATATYPE: "STRU",
        ACCESSMODE: "T",
        KEYDEF: "D",
        KEYKIND: "N"
      }
    }[kind]
    const saved: SapDdicResult = {
      ...mockDdicResult(
        kind,
        { ...request.header, ...identity, DDTEXT: request.description ?? "" },
        request.packageName ?? ""
      ),
      code: "DDIC_OBJECT_SAVED",
      message: "DDIC object saved activated and verified",
      recordedRequest: request.transportNumber ?? "",
      // TNRO has neither AS4DATE nor AS4TIME, so a number range object's concurrency token is a
      // 40-character SHA1 digest over the stored definition, not the 14-digit timestamp every other
      // kind uses. Without this the fake answered the timestamp and the number range verification
      // rejected it before reaching the comparison under test.
      ...(kind === "numberRangeObject" ? { objectVersion: "A1B2C3D4E5".repeat(4) } : {}),
      fixedValues: request.fixedValues ?? [],
      // DD26V/DD27P rows travel the same way fields do, so a lock-object write has to echo them
      // back or the readback check compares a definition no caller ever sent.
      lockTables: request.lockTables ?? [],
      lockFields: request.lockFields ?? [],
      // DD31V/DD32P/DD33V rows travel the same way and come back zero-padded in SAP's numeric columns.
      selectionMethods: padMockSearchHelpRows(request.selectionMethods ?? []),
      parameters: padMockSearchHelpRows(request.parameters ?? []),
      fieldAssignments: padMockSearchHelpRows(request.fieldAssignments ?? []),
      numberRangeTexts: request.numberRangeTexts ?? [],
      fields: (request.fields ?? []).map((field, index) => ({
        ...field,
        POSITION: String(index + 1)
      }))
    }
    this.ddicByKey.set(key, saved)
    return structuredClone(saved)
  }

  async callRemoteFunction(
    connectionId: string,
    request: RemoteFunctionRequest
  ): Promise<RemoteFunctionResult> {
    if (connectionId !== "w200") throw new Error(`Connection not found: ${connectionId}`)
    this.remoteFunctionCalls++
    if (request.functionName === "ZCMCP_FM_1801") {
      const input = request.inputParameters.IS_REQUEST
      if (!input || typeof input === "string" || Array.isArray(input)) {
        throw new Error("Mock structure input is invalid")
      }
      if (!input.MESSAGE) {
        return {
          outputs: {},
          fault: {
            code: "soap-env:Server",
            name: "INVALID_INPUT",
            message: "Exception INVALID_INPUT raised"
          }
        }
      }
      const items = request.inputParameters.CT_ITEMS
      if (!Array.isArray(items)) throw new Error("Mock table input is invalid")
      return {
        outputs: {
          ES_RESPONSE: { ...input, MESSAGE: `MCP:${input.MESSAGE}` },
          CT_ITEMS: items.map((row) => ({ ...row, MESSAGE: `ROW:${row.MESSAGE ?? ""}` }))
        }
      }
    }
    if (request.functionName === "ZCMCP_FM_1901") {
      const items = request.inputParameters.IT_ITEMS
      if (!Array.isArray(items)) throw new Error("Mock table-type input is invalid")
      if (!items.length) {
        return {
          outputs: {},
          fault: {
            code: "soap-env:Server",
            name: "INVALID_INPUT",
            message: "Exception INVALID_INPUT raised"
          }
        }
      }
      return {
        outputs: {
          ET_ITEMS: items.map((row) => ({ ...row, MESSAGE: `MCP:${row.MESSAGE ?? ""}` }))
        }
      }
    }
    if (request.functionName !== "ZCMCP_FM_1501") throw new Error("Mock RFC does not exist")
    const input = request.inputParameters.IV_INPUT
    if (typeof input !== "string" || !input) {
      return {
        outputs: {},
        fault: {
          code: "soap-env:Server",
          name: "INVALID_INPUT",
          message: "Exception INVALID_INPUT raised"
        }
      }
    }
    return { outputs: { EV_OUTPUT: `MCP:${input}` } }
  }

  async searchObjects(
    connectionId: string,
    pattern: string,
    types: string[] | undefined,
    maxResults: number
  ): Promise<AbapObjectInfo[]> {
    if (connectionId !== "w200") throw new Error(`Connection not found: ${connectionId}`)
    const regex = new RegExp(
      `^${pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replaceAll("*", ".*")
        .replaceAll("?", ".")}$`,
      "i"
    )
    return (
      objects
        .filter((object) => regex.test(object.name))
        .filter((object) => !this.deletedSourceObjects.has(`${object.type}:${object.name}`))
        // The real quick search is asked for a search code (`FUNC`) and answers with ADT type paths
        // (`FUGR/FF`); a path it cannot search yields no rows, because the backend skips that type.
        // Reproducing the asymmetry is the point: matching the raw token made a caller-side
        // vocabulary mistake look like a successful lookup (live w200, 2026-09-25T00:37).
        .filter(
          (object) => !types?.length || types.some((type) => matchesSearchType(type, object.type))
        )
        .slice(0, maxResults)
    )
  }

  async searchObjectTypes(
    connectionId: string,
    pattern: string,
    types: string[],
    maxResultsPerType: number
  ): Promise<ObjectTypeSearchResult[]> {
    return Promise.all(
      types.map(async (type) => ({
        requestedType: type,
        status: "available" as const,
        objects: await this.searchObjects(connectionId, pattern, [type], maxResultsPerType)
      }))
    )
  }

  async readSource(_connectionId: string, object: AbapObjectInfo): Promise<SourceResult> {
    if (object.name === "ZTABLE_DEMO") {
      return {
        source:
          "Complete Table Structure for ZTABLE_DEMO:\nMAIN TABLE STRUCTURE:\nMANDT: C(3) [KEY]\nFIELD1: C(10)\nALL APPEND STRUCTURES (1):\n• ZTABLE_DEMO_A (2 fields)",
        uriUsed: "DD Tables Query",
        kind: "dictionary",
        appendCount: 1
      }
    }
    const source = this.sourceByName.get(object.name)
    if (!source) throw new Error(`No source for ${object.name}`)
    return { source, uriUsed: `${object.uri}/source/main` }
  }

  async readSourceByUri(_connectionId: string, uri: string): Promise<SourceResult> {
    if (uri.includes("/revisions/zcl_demo/1")) {
      return {
        source: this.sourceByName.get("ZCL_DEMO")!,
        uriUsed: uri
      }
    }
    const functionName = /\/fmodules\/([^/?]+)/i.exec(uri)?.[1]?.toUpperCase()
    const functionSource = functionName ? this.functionAdtSources.get(functionName) : undefined
    if (functionSource) return { source: functionSource, uriUsed: `${uri}/source/main` }
    const object = objects.find((candidate) => uri.includes(candidate.uri))
    if (!object) throw new Error(`No source for ${uri}`)
    return this.readSource("w200", object)
  }

  async readEnhancements(
    _connectionId: string,
    objectUri: string,
    includeSource = false
  ): Promise<EnhancementInfo[]> {
    return objectUri.includes("zcl_demo")
      ? [
          {
            name: "ZENH_DEMO",
            type: "ENHO/XH",
            version: "active",
            elementId: "1",
            fullname: "\\PR:ZCL_DEMO\\SE:Z_DEMO\\EI",
            mode: "any",
            replacing: false,
            startLine: 3,
            startColumn: 0,
            uri: "/sap/bc/adt/enhancements/z_enh_demo",
            positionUri: "/sap/bc/adt/programs/programs/zcl_demo/source/main#start=4,0",
            enhancedObject: {
              uri: "/sap/bc/adt/programs/programs/zcl_demo",
              type: "PROG/P",
              name: "ZCL_DEMO"
            },
            ...(includeSource ? { source: "WRITE 'ENHANCEMENT'." } : {})
          }
        ]
      : []
  }

  async usageReferences(): Promise<UsageReferenceInfo[]> {
    return [
      {
        uri: "/sap/bc/adt/programs/programs/zreport_demo",
        objectIdentifier: "ABAPFullName;ZREPORT_DEMO",
        name: "ZREPORT_DEMO",
        type: "PROG/P",
        description: "Standalone validation report",
        packageName: "ZVALIDATION"
      }
    ]
  }

  async usageReferenceSnippets(): Promise<UsageSnippetInfo[]> {
    return [
      {
        objectIdentifier: "ABAPFullName;ZREPORT_DEMO",
        snippets: [{ line: 2, content: "WRITE 'OK'." }]
      }
    ]
  }

  async revisions(): Promise<RevisionInfo[]> {
    return [
      {
        uri: "/sap/bc/adt/revisions/zcl_demo/1",
        date: "2026-08-26T08:00:00Z",
        author: "DEVELOPER",
        version: "W200K900001",
        versionTitle: "Validation"
      }
    ]
  }

  async runQuery(_connectionId: string, sql: string): Promise<Record<string, unknown>[]> {
    if (sql.includes("FROM T000")) {
      return [
        {
          MANDT: "200",
          MTEXT: "Development",
          CCCATEGORY: "T",
          LOGSYS: "W200CLNT200",
          CCNOCLIIND: ""
        }
      ]
    }
    if (sql.includes("FROM CVERS")) {
      return [
        { COMPONENT: "SAP_BASIS", RELEASE: "731", EXTRELEASE: "0004", COMP_TYPE: "S" },
        { COMPONENT: "SAP_APPL", RELEASE: "606", EXTRELEASE: "0010", COMP_TYPE: "S" }
      ]
    }
    if (sql.includes("FROM SVERS")) return [{ VERSION: "731" }]
    if (sql.includes("FROM TTZCU")) return [{ CLIENT: "200", TZONESYS: "UTC+8", FLAGACTIVE: "X" }]
    if (sql.includes("FROM TTZZT"))
      return [{ CLIENT: "200", LANGU: "E", TZONE: "UTC+8", DESCRIPT: "China" }]
    if (sql.includes("FROM TTZZ"))
      return [{ CLIENT: "200", TZONE: "UTC+8", ZONERULE: "P0800", DSTRULE: "NONE" }]
    if (sql.includes("FROM TTZR"))
      return [{ CLIENT: "200", ZONERULE: "P0800", UTCDIFF: "080000", UTCSIGN: "+" }]
    if (sql.includes("FROM TBATG")) return structuredClone(this.conversionEntries)
    // Active DD04L rows: only the domain-less STRINGVAL fixture is typed there, so the
    // domain-bearing fixtures prove the resolver still prefers the domain header.
    if (sql.includes("FROM DD04L")) {
      return sql.includes("'STRINGVAL'")
        ? [
            {
              ROLLNAME: "STRINGVAL",
              DOMNAME: "",
              DATATYPE: "STRG",
              LENG: "000000",
              DECIMALS: "000000"
            }
          ]
        : []
    }
    if (sql.includes("FROM ZDATA")) {
      return [
        { ID: "2", NAME: "BETA" },
        { ID: "1", NAME: "ALPHA" },
        { ID: "3", NAME: "ALPINE" }
      ]
    }
    // The D5-2 allowlist guards execute_data_query, so the filtering/sorting fixture has to read an
    // allowlisted table: T001W is in the allowlist, ZDATA above is not.
    if (sql.includes("FROM T001W")) {
      return [
        { WERKS: "2000", NAME1: "BETA PLANT" },
        { WERKS: "1000", NAME1: "ALPHA PLANT" },
        { WERKS: "3000", NAME1: "ALPINE PLANT" }
      ]
    }
    return []
  }

  async listUserTransports(): Promise<UserTransportsListing> {
    return {
      workbench: [
        {
          "tm:name": "W20",
          "tm:desc": "Development",
          modifiable: [mockTransport("W20K900001", "ZCL_DEMO")],
          released: []
        }
      ],
      customizing: [],
      source: "adt-transport-organizer"
    }
  }

  async transportDetails(
    _connectionId: string,
    transportNumber: string
  ): Promise<TransportRequest> {
    if (transportNumber === "W20K900001") return mockTransport(transportNumber, "ZCL_DEMO")
    if (transportNumber === "W20K900002") return mockTransport(transportNumber, "ZREPORT_DEMO")
    throw new Error(`Transport not found: ${transportNumber}`)
  }

  async cleanupTransportEntries(
    _connectionId: string,
    _taskNumber: string,
    _parentTransportNumber: string,
    _entries: TransportCleanupEntry[]
  ): Promise<void> {
    throw new Error("Transport cleanup is not configured in this mock")
  }

  async exportResource(
    connectionId: string,
    source: string,
    _objectType?: string
  ): Promise<ExportResourceInfo> {
    if (connectionId !== "w200") throw new Error(`Connection not found: ${connectionId}`)
    return {
      connectionId,
      source,
      files: [
        {
          relativePath: "CLAS_OC/ZCL_DEMO/main.abap",
          sourceUri: "/sap/bc/adt/oo/classes/zcl_demo/source/main",
          content: this.sourceByName.get("ZCL_DEMO") ?? ""
        }
      ],
      failures: []
    }
  }

  async discoverySnapshot(connectionId: string): Promise<DiscoverySnapshotInfo> {
    if (connectionId !== "w200") throw new Error(`Connection not found: ${connectionId}`)
    if (this.discoverySnapshotInfo) return this.discoverySnapshotInfo
    return {
      workspaces: [
        {
          title: "Repository",
          collections: [
            {
              href: "/sap/bc/adt/repository",
              title: "Repository",
              templateLinks: [
                {
                  rel: "http://www.sap.com/adt/relations/search",
                  template: "/sap/bc/adt/repository/informationsystem/search?query={query}"
                }
              ]
            }
          ]
        }
      ],
      coreEntries: [
        {
          title: "Core",
          href: "/sap/bc/adt/core",
          collectionTitle: "Core",
          category: "core"
        }
      ],
      resAppClasses: [{ name: "CL_ADT_RES_APP", description: "Mock resource app" }]
    }
  }

  async diagnostics(): Promise<DiagnosticInfo[]> {
    return [
      {
        uri: "/sap/bc/adt/oo/classes/zcl_demo/source/main",
        line: 2,
        offset: 4,
        severity: "W",
        text: "Mock warning"
      }
    ]
  }

  async runAtc(): Promise<AtcResultInfo> {
    return {
      variant: "DEFAULT",
      findings: [
        {
          objectName: "ZCL_DEMO",
          objectType: "CLAS/OC",
          messageTitle: "Mock ATC finding",
          checkTitle: "Mock check",
          checkId: "MOCK_CHECK",
          priority: 2,
          uri: "/sap/bc/adt/oo/classes/zcl_demo/source/main",
          line: 2,
          character: 4,
          exemptionApproval: "",
          docUri: "/sap/bc/adt/atc/doc/mock"
        }
      ]
    }
  }

  async inspectAtc(): Promise<import("../src/native-atc.js").AtcPrecheckInfo> {
    return {
      status: "metadata_available",
      stage: "customizing",
      engine: "ATC",
      endpoint: "/sap/bc/adt/atc/customizing",
      method: "GET",
      systemVariant: "DEFAULT",
      selectedVariant: "DEFAULT",
      variantSource: "system",
      variantValidated: false,
      worklistCreationAttempted: false,
      runCreationAttempted: false,
      qualityGate: "not_evaluated",
      gateReason: "not_run"
    }
  }

  async atcDocumentation(): Promise<string> {
    return "<h2>Mock documentation</h2><p>Use the exact finding context.</p>"
  }

  async runUnitTests(): Promise<UnitTestClassInfo[]> {
    return [
      {
        name: "LTC_DEMO",
        alerts: [],
        methods: [{ name: "TEST_RUN", executionTime: 0.012, alerts: [] }]
      }
    ]
  }

  async inspectSource(connectionId: string, fileUri: string): Promise<SourceInspectionInfo> {
    const target = resolveEditableSourceTarget(fileUri, connectionId)
    const result = await this.readSourceByUri(connectionId, fileUri)
    return {
      sourceUri: target.sourceUri,
      objectUri: target.objectUri,
      objectName: target.objectName,
      activeSource: result.source,
      inactiveSource: null
    }
  }

  async replaceSource(
    connectionId: string,
    fileUri: string,
    oldString: string,
    newString: string,
    transportNumber?: string,
    expectedSourceFingerprint?: string,
    _recoverInactiveSource?: boolean
  ): Promise<SourceMutationInfo> {
    if (connectionId !== "w200") throw new Error(`Connection not found: ${connectionId}`)
    if (this.adtSourceWriteRefused) {
      throw new Error("ADT source write refused by the test double")
    }
    if (expectedSourceFingerprint) {
      const source = await this.readSourceByUri(connectionId, fileUri)
      if (
        createHash("sha256").update(source.source).digest("hex") !==
        expectedSourceFingerprint.toLowerCase()
      ) {
        throw new Error("SOURCE_FINGERPRINT_CONFLICT")
      }
    }
    const functionName = /\/fmodules\/([^/?]+)/i.exec(fileUri)?.[1]?.toUpperCase()
    if (functionName) {
      const current = this.functionAdtSources.get(functionName)
      if (!current) throw new Error(`No source for ${fileUri}`)
      const replaced = findAndReplaceSource(current, oldString, newString)
      this.functionAdtSources.set(
        functionName,
        this.functionPatchSourceMutation
          ? replaced.replace(
              "  CONCATENATE 'MCP:' iv_input INTO ev_output.",
              "  CONCATENATE 'CHANGED:' iv_input INTO ev_output."
            )
          : replaced
      )
      return {
        fileUri,
        sourceUri: `${fileUri}/source/main`,
        objectName: functionName,
        oldLineCount: oldString ? oldString.split(/\r?\n/).length : 0,
        newLineCount: newString ? newString.split(/\r?\n/).length : 0,
        transportNumber: transportNumber ?? "",
        activation: { success: true, messages: [], inactiveObjects: [] }
      }
    }
    const object = objects.find((candidate) => fileUri.toLowerCase().includes(candidate.uri))
    if (!object) throw new Error(`No source for ${fileUri}`)
    if (!/^[ZY]/.test(object.name)) throw new Error("Only Z* or Y* customer objects are allowed")
    const current = this.sourceByName.get(object.name) ?? ""
    const updated = findAndReplaceSource(current, oldString, newString)
    this.sourceByName.set(object.name, updated)
    return {
      fileUri,
      sourceUri: `${object.uri}/source/main`,
      objectName: object.name,
      oldLineCount: oldString ? oldString.split(/\r?\n/).length : 0,
      newLineCount: newString ? newString.split(/\r?\n/).length : 0,
      transportNumber: transportNumber ?? "",
      activation: { success: true, messages: [], inactiveObjects: [] }
    }
  }

  async activateSource(connectionId: string, fileUri: string): Promise<ActivationInfo> {
    if (connectionId !== "w200") throw new Error(`Connection not found: ${connectionId}`)
    if (!fileUri.toLowerCase().includes("/z")) {
      throw new Error("Only Z* or Y* customer objects are allowed")
    }
    return { success: true, messages: [], inactiveObjects: [] }
  }

  async createObject(
    connectionId: string,
    request: CreateObjectRequest
  ): Promise<ObjectCreationInfo> {
    if (connectionId !== "w200") throw new Error(`Connection not found: ${connectionId}`)
    const name = request.name.trim().toUpperCase()
    if (!/^[ZY]/.test(name)) throw new Error("Only Z* or Y* customer objects are allowed")
    const packageName = (request.packageName ?? "$TMP").toUpperCase()
    const parentName = request.parentName?.toUpperCase() ?? ""
    const transportNumber = request.additionalOptions?.transportRequest?.number ?? ""
    const path =
      request.objectType === "CLAS/OC"
        ? `/sap/bc/adt/oo/classes/${name.toLowerCase()}`
        : `/sap/bc/adt/programs/programs/${name.toLowerCase()}`
    return {
      connectionId,
      objectType: request.objectType,
      objectName: name,
      description: request.description,
      packageName,
      parentName,
      transportNumber,
      objectUri: path,
      workspaceUri: `adt://${connectionId}${path}`,
      activation: { success: true, messages: [], inactiveObjects: [] }
    }
  }

  async deleteObject(
    connectionId: string,
    object: AbapObjectInfo,
    _transportNumber: string,
    expectedFingerprint: string
  ): Promise<string> {
    if (connectionId !== "w200") throw new Error(`Connection not found: ${connectionId}`)
    const source = await this.readSource(connectionId, object)
    const fingerprint = createHash("sha256").update(source.source).digest("hex")
    if (fingerprint !== expectedFingerprint.toLowerCase()) {
      throw new Error(
        `SOURCE_FINGERPRINT_CONFLICT: expected ${expectedFingerprint.toLowerCase()}, current ${fingerprint}`
      )
    }
    this.deletedSourceObjects.add(`${object.type}:${object.name}`)
    return fingerprint
  }

  async sourceObjectExists(connectionId: string, object: AbapObjectInfo): Promise<boolean> {
    if (connectionId !== "w200") throw new Error(`Connection not found: ${connectionId}`)
    return !this.deletedSourceObjects.has(`${object.type}:${object.name}`)
  }

  async readMessageClass(connectionId: string, messageClass: string): Promise<MessageClassInfo> {
    if (connectionId !== "w200") throw new Error(`Connection not found: ${connectionId}`)
    const normalized = messageClass.toUpperCase()
    const existing = this.messageClasses.get(normalized)
    if (!existing) throw new Error("MESSAGE_CLASS_NOT_FOUND: Message class does not exist")
    return {
      connectionId,
      messageClass: normalized,
      description: existing.description,
      packageName: existing.packageName,
      masterLanguage: "E",
      version: existing.version ?? "20260831140000",
      messages: existing.messages
    }
  }

  async createMessageClass(
    connectionId: string,
    messageClass: string,
    description: string,
    messages: Array<{ number: string; text: string }>,
    packageName: string,
    transportNumber: string
  ): Promise<MessageClassCreationInfo> {
    const normalized = messageClass.toUpperCase()
    if (this.messageClasses.has(normalized)) {
      throw new Error("MESSAGE_CLASS_EXISTS: Existing message classes cannot be replaced")
    }
    this.messageClasses.set(normalized, { description, packageName, messages })
    return {
      ...(await this.readMessageClass(connectionId, normalized)),
      transportNumber,
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
    const normalized = messageClass.toUpperCase()
    const existing = this.messageClasses.get(normalized)
    if (!existing) throw new Error("MESSAGE_CLASS_NOT_FOUND: Message class does not exist")
    if ((existing.version ?? "20260831140000") !== expectedVersion) {
      throw new Error("VERSION_CONFLICT: Message class changed since it was read")
    }
    if (existing.packageName !== packageName) {
      throw new Error("PACKAGE_CONFLICT: Message class belongs to another package")
    }
    this.messageClasses.set(normalized, {
      ...existing,
      version: "20260903120000",
      messages
    })
    return { ...(await this.readMessageClass(connectionId, normalized)), transportNumber }
  }

  async deleteMessageClass(
    connectionId: string,
    messageClass: string,
    expectedVersion: string,
    packageName: string,
    transportNumber: string
  ): Promise<MessageClassDeletionInfo> {
    const normalized = messageClass.toUpperCase()
    const existing = this.messageClasses.get(normalized)
    if (!existing) throw new Error("MESSAGE_CLASS_NOT_FOUND: Message class does not exist")
    if ((existing.version ?? "20260831140000") !== expectedVersion) {
      throw new Error("VERSION_CONFLICT: Message class changed since it was read")
    }
    if (existing.packageName !== packageName) {
      throw new Error("PACKAGE_CONFLICT: Message class belongs to another package")
    }
    this.messageClasses.delete(normalized)
    return { connectionId, messageClass: normalized, transportNumber }
  }

  async createTestInclude(
    connectionId: string,
    className: string
  ): Promise<TestIncludeCreationInfo> {
    if (connectionId !== "w200") throw new Error(`Connection not found: ${connectionId}`)
    const normalized = className.toUpperCase()
    if (!/^[ZY]/.test(normalized)) throw new Error("Only Z* or Y* customer objects are allowed")
    const sourceUri = `/sap/bc/adt/oo/classes/${normalized.toLowerCase()}/includes/testclasses`
    return {
      connectionId,
      className: normalized,
      sourceUri,
      workspaceUri: `adt://${connectionId}${sourceUri}`,
      transportNumber: "W200K900001",
      activation: { success: true, messages: [], inactiveObjects: [] }
    }
  }

  async readTextElements(
    connectionId: string,
    objectName: string,
    objectType: TextElementObjectType
  ): Promise<TextElementsInfo> {
    if (connectionId !== "w200") throw new Error(`Connection not found: ${connectionId}`)
    const normalized = objectName.toUpperCase()
    return {
      connectionId,
      objectName: normalized,
      objectType,
      textElements: [...(this.textElementsByName.get(normalized) ?? [])]
    }
  }

  async writeTextElements(
    connectionId: string,
    objectName: string,
    objectType: TextElementObjectType,
    action: "create" | "update",
    textElements: TextElementInfo[]
  ): Promise<TextElementMutationInfo> {
    if (connectionId !== "w200") throw new Error(`Connection not found: ${connectionId}`)
    const normalized = objectName.toUpperCase()
    if (!/^[ZY]/.test(normalized)) throw new Error("Only Z* or Y* customer objects are allowed")
    const existing = this.textElementsByName.get(normalized) ?? []
    const merged = new Map(existing.map((element) => [element.id, element]))
    for (const element of textElements) {
      merged.set(element.id.toUpperCase(), { ...element, id: element.id.toUpperCase() })
    }
    const result = [...merged.values()]
    this.textElementsByName.set(normalized, result)
    return {
      connectionId,
      objectName: normalized,
      objectType,
      action,
      changedIds: textElements.map((element) => element.id.toUpperCase()),
      transportNumber: "",
      activation: { success: true, messages: [], inactiveObjects: [] },
      textElements: result
    }
  }

  async listDumps(): Promise<DumpListInfo> {
    return {
      available: true,
      dumps: [
        {
          id: "DUMP-1",
          errorType: "OBJECTS_OBJREF_NOT_ASSIGNED",
          text: "<html><pre>Mock dump</pre></html>"
        }
      ]
    }
  }

  async listTraceRuns(): Promise<TraceRunInfo[]> {
    return [
      {
        id: "/sap/bc/adt/runtime/traces/abaptraces/TRACE-1",
        title: "Mock trace",
        author: "DEVELOPER",
        published: new Date("2026-08-27T01:00:00Z"),
        runtime: 100,
        host: "w200",
        objectName: "ZCL_DEMO",
        runtimeAbap: 60,
        runtimeDatabase: 30,
        runtimeSystem: 10,
        isAggregated: false,
        stateValue: "F",
        stateText: "Finished",
        system: "W20"
      }
    ]
  }

  async listTraceConfigurations(): Promise<TraceConfigurationInfo[]> {
    return [
      {
        id: "REQUEST-1",
        title: "Mock configuration",
        published: new Date("2026-08-27T00:00:00Z"),
        host: "w200",
        admin: "ADMIN",
        tracer: "DEVELOPER",
        processType: "RFC",
        objectType: "FUNCTION_MODULE",
        completedExecutions: 1,
        maximalExecutions: 1,
        isAggregated: false
      }
    ]
  }

  async traceHitList(): Promise<TraceEntryInfo[]> {
    return [
      {
        description: "SELECT",
        hitCount: 2,
        netTime: 30,
        grossTime: 35,
        program: "ZCL_DEMO",
        context: "RUN"
      }
    ]
  }

  async traceStatements(): Promise<TraceEntryInfo[]> {
    return [
      {
        description: "METHOD RUN",
        hitCount: 1,
        netTime: 40,
        grossTime: 50,
        callLevel: 1,
        program: "ZCL_DEMO",
        context: "RUN"
      }
    ]
  }

  async debugSession(
    connectionId: string,
    request: DebugSessionRequest
  ): Promise<DebugSessionInfo> {
    if (connectionId !== "w200") throw new Error(`Connection not found: ${connectionId}`)
    if (request.terminalMode) throw new Error("terminalMode is not supported")
    if (request.action === "precheck")
      return {
        ...this.debugState,
        precheck: {
          status: "not_advertised",
          readOnly: true,
          listenerStarted: false,
          executionValidated: false,
          discovery: {
            status: "returned",
            advertisedEndpoints: [],
            missingEndpoints: ["/sap/bc/adt/debugger/listeners"]
          },
          listenerCheck: { status: "not_attempted" }
        }
      }
    this.debugState = {
      connectionId,
      state:
        request.action === "stop"
          ? "idle"
          : request.action === "start"
            ? "listening"
            : this.debugState.state,
      mode: "user",
      debugUser: "DEVELOPER",
      breakpointCount: request.action === "stop" ? 0 : this.debugState.breakpointCount
    }
    return this.debugState
  }

  debugStatus(connectionId: string): DebugSessionInfo {
    if (connectionId !== "w200") throw new Error(`Connection not found: ${connectionId}`)
    return this.debugState
  }

  async debugBreakpoints(connectionId: string, request: DebugBreakpointCommand) {
    if (connectionId !== "w200") throw new Error(`Connection not found: ${connectionId}`)
    this.debugState = {
      ...this.debugState,
      breakpointCount:
        request.action === "set"
          ? request.lineNumbers.length
          : Math.max(0, this.debugState.breakpointCount - request.lineNumbers.length)
    }
    return {
      fileUri: request.filePath,
      sourceUri: request.filePath.replace(/^adt:\/\/w200/, ""),
      action: request.action,
      breakpoints: request.lineNumbers.map((line) => ({ line, verified: true }))
    }
  }

  async debugStack(connectionId: string, threadId: number): Promise<DebugStackFrameInfo[]> {
    if (connectionId !== "w200" || threadId !== 1) throw new Error("Invalid debug thread")
    return [
      {
        frameId: 1_000_000_000_000,
        threadId: 1,
        stackPosition: 0,
        program: "SAPLZCMCP_FG_1501",
        include: "LZCMCP_FG_1501U01",
        line: 12,
        eventType: "FUNCTION",
        eventName: "ZCMCP_FM_1501",
        sourceUri: "adt://w200/sap/bc/adt/functions/groups/zcmcp_fg_1501/fmodules/zcmcp_fm_1501",
        systemProgram: false
      }
    ]
  }

  async debugVariables(
    connectionId: string,
    request: DebugVariableRequest
  ): Promise<DebugVariableInfo> {
    if (connectionId !== "w200") throw new Error(`Connection not found: ${connectionId}`)
    return {
      frameId: request.frameId,
      ...(request.variableName ? { query: request.variableName } : {}),
      variables: [
        {
          id: "IV_INPUT",
          name: "IV_INPUT",
          declaredType: "STRING",
          actualType: "STRING",
          metaType: "string",
          value: "VALIDATION",
          tableLines: 0,
          incomplete: false
        }
      ]
    }
  }

  async debugStep(connectionId: string, request: DebugStepRequest): Promise<DebugStepInfo> {
    if (connectionId !== "w200") throw new Error(`Connection not found: ${connectionId}`)
    if (request.stepType === "jumpToLine") throw new Error("jumpToLine is disabled")
    return { state: "paused", stepType: request.stepType, debuggeeEnded: false }
  }

  async close(): Promise<void> {}
}

function mockTransport(number: string, objectName: string): TransportRequest {
  return {
    "tm:number": number,
    "tm:owner": "DEVELOPER",
    "tm:desc": `Mock ${number}`,
    "tm:status": "D",
    "tm:uri": `/sap/bc/adt/cts/transportrequests/${number}`,
    links: [],
    objects: [
      {
        "tm:pgmid": "R3TR",
        "tm:type": "CLAS",
        "tm:name": objectName,
        "tm:dummy_uri": "",
        "tm:obj_info": "Mock object",
        "tm:position": "000001",
        "tm:wbtype": "CLAS/OC"
      } as TransportRequest["objects"][number] & {
        "tm:position": string
        "tm:wbtype": string
      }
    ],
    tasks: []
  }
}
