import type { TransportRequest, TransportsOfUser } from "abap-adt-api"
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
  MessageClassInfo,
  ObjectCreationInfo,
  RevisionInfo,
  RemoteFunctionRequest,
  RemoteFunctionResult,
  SapDdicRequest,
  SapDdicResult,
  SapHelperRequest,
  SapHelperResult,
  SapRepositoryRequest,
  SapRepositoryResult,
  SapBackend,
  SourceResult,
  SourceMutationInfo,
  TestIncludeCreationInfo,
  TextElementInfo,
  TextElementMutationInfo,
  TextElementObjectType,
  TextElementsInfo,
  TraceConfigurationInfo,
  TraceEntryInfo,
  TraceRunInfo,
  UnitTestClassInfo,
  UsageReferenceInfo,
  UsageSnippetInfo
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

function payloadRows(kind: "M" | "F" | "T", rows: Array<Record<string, string>>): string[] {
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

function mockDdicResult(
  _kind: "domain" | "dataElement" | "structure" | "transparentTable" | "tableType",
  header: Record<string, string>,
  packageName: string
): SapDdicResult {
  return {
    status: "S",
    code: "DDIC_OBJECT_READ",
    message: "DDIC object read successfully",
    version: "1.3",
    packageName,
    objectVersion: "20260831120000",
    recordedRequest: "",
    header,
    fixedValues: [],
    fields: []
  }
}

function ddicKind(
  operation: SapDdicRequest["operation"]
): "domain" | "dataElement" | "structure" | "transparentTable" | "tableType" {
  if (operation.endsWith("DOMAIN")) return "domain"
  if (operation.endsWith("DATA_ELEMENT")) return "dataElement"
  if (operation.endsWith("STRUCTURE")) return "structure"
  if (operation.endsWith("TRANSPARENT_TABLE")) return "transparentTable"
  return "tableType"
}

export class MockBackend implements SapBackend {
  lastRepositoryRequest: SapRepositoryRequest | undefined
  private debugState: DebugSessionInfo = {
    connectionId: "w200",
    state: "idle",
    mode: "user",
    debugUser: "DEVELOPER",
    breakpointCount: 0
  }
  private readonly sourceByName = new Map(sources)
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
    { description: string; packageName: string; messages: Array<{ number: string; text: string }> }
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
        "I|1|OPTIONAL|",
        "I|1|PASSVALUE|X",
        "E|1|PARAMETER|EV_OUTPUT",
        "E|1|TYP|CHAR40",
        "E|1|PASSVALUE|X",
        "X|1|EXCEPTION|INVALID_INPUT",
        "X|1|TEXT|Input is invalid",
        "S|1|LINE|  CONCATENATE 'MCP:' iv_input INTO ev_output."
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
    ]
  ])
  remoteFunctionCalls = 0
  private readonly ddicByKey = new Map<string, SapDdicResult>([
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
    return {
      status: "S",
      code: "TARGET_ALLOWED",
      message: "Customer object target is allowed",
      version: "1.0"
    }
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
    if (
      request.operation === "READ_FUNCTION_INTERFACE" ||
      request.operation === "CREATE_FUNCTION_MODULE"
    ) {
      const name = (request.objectName ?? "").toUpperCase()
      const existing = this.functionModules.get(name)
      if (request.operation === "READ_FUNCTION_INTERFACE" && !existing) {
        return this.repositoryError("FUNCTION_NOT_FOUND", "Function module does not exist")
      }
      if (request.operation === "CREATE_FUNCTION_MODULE" && existing) {
        return this.repositoryError("FUNCTION_EXISTS", "Function module already exists")
      }
      if (request.operation === "CREATE_FUNCTION_MODULE") {
        this.functionModules.set(name, [
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
        ])
      }
      return this.repositoryResult(
        request.operation === "READ_FUNCTION_INTERFACE"
          ? "FUNCTION_INTERFACE_READ"
          : "FUNCTION_MODULE_CREATED",
        request,
        this.functionModules.get(name)!
      )
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
    const readOperation = request.operation
      .replace("UPSERT", "READ")
      .replace("CREATE_TRANSPARENT_TABLE", "READ_TRANSPARENT_TABLE")
    const key = `${readOperation}:${request.objectName}`
    const existing = this.ddicByKey.get(key)
    if (request.operation.startsWith("READ")) {
      return existing
        ? structuredClone(existing)
        : {
            ...mockDdicResult("domain", {}, ""),
            status: "E",
            code: "DDIC_OBJECT_NOT_FOUND",
            message: "DDIC object does not exist"
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
    const kind = ddicKind(request.operation)
    const identity = {
      domain: { DOMNAME: request.objectName },
      dataElement: { ROLLNAME: request.objectName },
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
      fixedValues: request.fixedValues ?? [],
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
    return objects
      .filter((object) => regex.test(object.name))
      .filter((object) => !types?.length || types.some((type) => object.type.startsWith(type)))
      .slice(0, maxResults)
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
            startLine: 3,
            uri: "/sap/bc/adt/enhancements/z_enh_demo",
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
          CCNOCLIIND: "0"
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
    if (sql.toLowerCase().includes("from ttzcu")) {
      return [{ TZONESYS: "UTC+8", ZONERULE: "P0800", DSTRULE: "NONE", DESCRIPT: "China" }]
    }
    if (sql.includes("FROM ZDATA")) {
      return [
        { ID: "2", NAME: "BETA" },
        { ID: "1", NAME: "ALPHA" },
        { ID: "3", NAME: "ALPINE" }
      ]
    }
    return []
  }

  async listUserTransports(): Promise<TransportsOfUser> {
    return {
      workbench: [
        {
          "tm:name": "W20",
          "tm:desc": "Development",
          modifiable: [mockTransport("W20K900001", "ZCL_DEMO")],
          released: []
        }
      ],
      customizing: []
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

  async replaceSource(
    connectionId: string,
    fileUri: string,
    oldString: string,
    newString: string,
    transportNumber?: string
  ): Promise<SourceMutationInfo> {
    if (connectionId !== "w200") throw new Error(`Connection not found: ${connectionId}`)
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
      version: "20260831140000",
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
        "tm:obj_info": "Mock object"
      }
    ],
    tasks: []
  }
}
