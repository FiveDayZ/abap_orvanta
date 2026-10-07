// Fixed read-only ECC 7.31 API; active dependency metadata read in w200, r74.
export const configurationBteMetadataApi = {
  functionName: "Z_ORVANTA_CFG_BTE_META",
  functionGroup: "ZORVANTA_BTE_CFG",
  remoteEnabled: true,
  updateTask: false,
  globalInterface: false,
  importParameters: [],
  changingParameters: [],
  exceptions: [],
  exportParameters: [
    {
      name: "EV_CODE",
      typeName: "CHAR40",
      optional: false,
      passByValue: true
    },
    {
      name: "EV_MESSAGE",
      typeName: "BAPI_MSG",
      optional: false,
      passByValue: true
    },
    {
      name: "EV_READ_ONLY",
      typeName: "XFELD",
      optional: false,
      passByValue: true
    },
    {
      name: "EV_FRESH",
      typeName: "XFELD",
      optional: false,
      passByValue: true
    }
  ],
  tableParameters: [
    {
      name: "ET_HEADER",
      typeName: "VIMDESC",
      optional: false,
      passByValue: false
    },
    {
      name: "ET_NAMTAB",
      typeName: "VIMNAMTAB",
      optional: false,
      passByValue: false
    },
    {
      name: "ET_EVENTS",
      typeName: "TVIMF",
      optional: false,
      passByValue: false
    }
  ],
  source: [
    "* 固定只读元数据；不调用产品维护、锁、CTS、提交或业务函数。",
    "  DATA: lt_header TYPE STANDARD TABLE OF vimdesc,",
    "        lt_namtab TYPE STANDARD TABLE OF vimnamtab,",
    "        lt_sellist TYPE STANDARD TABLE OF vimsellist,",
    "        lt_events TYPE STANDARD TABLE OF tvimf,",
    "        lt_events_after TYPE STANDARD TABLE OF tvimf,",
    "        ls_header TYPE vimdesc,",
    "        ls_directory TYPE tvdir,",
    "        ls_directory_after TYPE tvdir,",
    "        lv_rc TYPE sy-subrc,",
    "        lv_count TYPE i,",
    "        lx_error TYPE REF TO cx_root.",
    "",
    "  CLEAR: ev_code, ev_message, ev_read_only, ev_fresh.",
    "  REFRESH: et_header, et_namtab, et_events.",
    "  ev_read_only = 'X'.",
    "* SVIX 有原生缓存；返回观察值，不签发新鲜/锁内/可写许可。",
    "  ev_code = 'SCOPE_UNSUPPORTED'.",
    "  IF sy-sysid <> 'GR2' OR sy-mandt <> '200'.",
    "    ev_message = 'Only GR2 client 200 is supported.'.",
    "    RETURN.",
    "  ENDIF.",
    "",
    "  TRY.",
    "      CALL FUNCTION 'VIEW_AUTHORITY_CHECK'",
    "        EXPORTING",
    "          view_action = 'S'",
    "          view_name = 'TBE24'",
    "          no_warning_for_clientindep = 'X'",
    "        EXCEPTIONS",
    "          invalid_action = 1",
    "          no_authority = 2",
    "          no_clientindependent_authority = 3",
    "          table_not_found = 4",
    "          no_linedependent_authority = 5",
    "          error_message = 6",
    "          OTHERS = 7.",
    "      lv_rc = sy-subrc.",
    "      IF lv_rc <> 0.",
    "        IF lv_rc = 2 OR lv_rc = 3 OR lv_rc = 5.",
    "          ev_code = 'AUTHORIZATION_DENIED'.",
    "          ev_message = 'Standard TBE24 display authorization refused.'.",
    "        ELSEIF lv_rc = 4.",
    "          ev_code = 'ROUTE_UNSUPPORTED'.",
    "          ev_message =",
    "            'Standard authorization check did not find TBE24.'.",
    "        ELSE.",
    "          ev_code = 'NATIVE_METADATA_FAILED'.",
    "          ev_message = 'Standard display authorization check failed.'.",
    "        ENDIF.",
    "        IF lv_rc <> 0 AND sy-msgid IS NOT INITIAL.",
    "* INTO 仅构造返回文本，不弹出标准权限错误对话。",
    "          MESSAGE ID sy-msgid TYPE 'S' NUMBER sy-msgno",
    "            WITH sy-msgv1 sy-msgv2 sy-msgv3 sy-msgv4 INTO ev_message.",
    "        ENDIF.",
    "        RETURN.",
    "      ENDIF.",
    "",
    "      SELECT SINGLE * FROM tvdir INTO ls_directory",
    "        WHERE tabname = 'TBE24'.",
    "      IF sy-subrc <> 0 OR ls_directory-area <> 'BFTM'",
    "         OR ls_directory-liste <> '0090'",
    "         OR ls_directory-bastab <> 'X'",
    "         OR ls_directory-newgener <> space.",
    "        ev_code = 'ROUTE_UNSUPPORTED'.",
    "        ev_message =",
    "          'Registered TBE24 product route changed or is missing.'.",
    "        RETURN.",
    "      ENDIF.",
    "      SELECT * FROM tvimf INTO TABLE lt_events",
    "        WHERE tabname = 'TBE24'.",
    "      DESCRIBE TABLE lt_events LINES lv_count.",
    "      IF lv_count > 64.",
    "        ev_code = 'METADATA_LIMIT_EXCEEDED'.",
    "        ev_message =",
    "          'Maintenance event metadata exceeds the fixed bound.'.",
    "        RETURN.",
    "      ENDIF.",
    "      SORT lt_events BY tabname event.",
    "",
    "      CALL FUNCTION 'VIEW_GET_DDIC_INFO'",
    "        EXPORTING viewname = 'TBE24'",
    "        TABLES",
    "          sellist = lt_sellist",
    "          x_header = lt_header",
    "          x_namtab = lt_namtab",
    "        EXCEPTIONS",
    "          no_tvdir_entry = 1",
    "          table_not_found = 2",
    "          error_message = 3",
    "          OTHERS = 4.",
    "      IF sy-subrc <> 0.",
    "        ev_code = 'NATIVE_METADATA_FAILED'.",
    "        ev_message = 'Standard TBE24 control-block read failed.'.",
    "        IF sy-msgid IS NOT INITIAL.",
    "          MESSAGE ID sy-msgid TYPE 'S' NUMBER sy-msgno",
    "            WITH sy-msgv1 sy-msgv2 sy-msgv3 sy-msgv4 INTO ev_message.",
    "        ENDIF.",
    "        RETURN.",
    "      ENDIF.",
    "      DESCRIBE TABLE lt_header LINES lv_count.",
    "      IF lv_count <> 1.",
    "        ev_code = 'METADATA_INVALID'.",
    "        ev_message =",
    "          'Native metadata did not return exactly one header.'.",
    "        RETURN.",
    "      ENDIF.",
    "      READ TABLE lt_header INTO ls_header INDEX 1.",
    "      IF sy-subrc <> 0 OR ls_header-viewname <> 'TBE24'",
    "         OR ls_header-maintview <> 'TBE24'",
    "         OR ls_header-area <> ls_directory-area",
    "         OR ls_header-liste <> ls_directory-liste",
    "         OR ls_header-gendate <> ls_directory-gendate",
    "         OR ls_header-gentime <> ls_directory-gentime",
    "         OR ls_header-bastab <> 'X'",
    "         OR ls_header-texttab <> 'TBE24T'",
    "         OR ls_header-texttbexst <> 'X'.",
    "        ev_code = 'METADATA_INVALID'.",
    "        ev_message =",
    "          'Native header does not match the fixed product route.'.",
    "        RETURN.",
    "      ENDIF.",
    "      DESCRIBE TABLE lt_namtab LINES lv_count.",
    "      IF lv_count < 1 OR lv_count > 200.",
    "        ev_code = 'METADATA_LIMIT_EXCEEDED'.",
    "        ev_message =",
    "          'Native field control blocks are empty or over limit.'.",
    "        RETURN.",
    "      ENDIF.",
    "",
    "      SELECT SINGLE * FROM tvdir INTO ls_directory_after",
    "        WHERE tabname = 'TBE24'.",
    "      IF sy-subrc <> 0 OR ls_directory_after <> ls_directory.",
    "        ev_code = 'METADATA_CHANGED'.",
    "        ev_message = 'Maintenance directory changed during the read.'.",
    "        RETURN.",
    "      ENDIF.",
    "      SELECT * FROM tvimf INTO TABLE lt_events_after",
    "        WHERE tabname = 'TBE24'.",
    "      SORT lt_events_after BY tabname event.",
    "      IF lt_events_after <> lt_events.",
    "        ev_code = 'METADATA_CHANGED'.",
    "        ev_message = 'Maintenance events changed during the read.'.",
    "        RETURN.",
    "      ENDIF.",
    "      et_header[] = lt_header[].",
    "      et_namtab[] = lt_namtab[].",
    "      et_events[] = lt_events[].",
    "      ev_code = 'METADATA_READ_OK'.",
    "      ev_message =",
    "        'Read-only native metadata; cached values, not a write permit.'.",
    "    CATCH cx_root INTO lx_error.",
    "      REFRESH: et_header, et_namtab, et_events.",
    "      ev_code = 'NATIVE_METADATA_FAILED'.",
    "      ev_message = lx_error->get_text( ).",
    "  ENDTRY."
  ]
} as const

export const configurationBteMetadataLayouts = {
  VIMDESC: {
    fingerprint: "6a19361ba5ff0a8b035d1d7fc74f107d1a269c2be4789aea22a3cfc98939a0d5",
    fields: [
      "VIEWNAME",
      "MAINTVIEW",
      "AREA",
      "DEVCLASS",
      "TYPE",
      "LISTE",
      "DETAIL",
      "OCCURS",
      "CLTCODE",
      "BASTAB",
      "NEWGENER",
      "GENDATE",
      "GENTIME",
      "FLAG",
      "EXISTENCY",
      "SELECTION",
      "DDTEXT",
      "CLIDEP",
      "TEXTCLIDEP",
      "KEYLEN",
      "AFTER_KEYC",
      "TEXTKEYLEN",
      "AFT_TXTKC",
      "TABLEN",
      "AFTER_TABC",
      "TEXTTABLEN",
      "AFT_TXTTBC",
      "MAXTRKEYLN",
      "TRGKEYPOS",
      "MAXTRTXKLN",
      "TRTXGKPOS",
      "CUSTOMAUTH",
      "AUTHCLASS",
      "SUBSETFLAG",
      "RDONLYFLAG",
      "ADRNBRFLAG",
      "GUIDFLAG",
      "USREXIFLAG",
      "HIDDENFLAG",
      "DELMDTFLAG",
      "TEXTTBEXST",
      "PTFRKYEXST",
      "GENERICTRP",
      "GENERTXTRP",
      "FIELDORDER",
      "TEXTTAB",
      "ORIG_LANG",
      "SPRASFIELD",
      "SPRASFDPOS",
      "ROOTTAB",
      "GUI_PROG",
      "CURSETTING",
      "IMPORTABLE",
      "SCRFRMFLAG",
      "FPOOLNAME",
      "MAINFLAG",
      "FRM_BF_SAV",
      "FRM_AF_SAV",
      "FRM_BF_DEL",
      "FRM_AF_DEL",
      "FRM_ON_NEW",
      "FRM_AF_ORG",
      "FRM_BF_RPL",
      "FRM_AF_RPL",
      "FRM_RP_ORG",
      "FRM_RP_GET",
      "FRM_RP_UPD",
      "FRM_RP_CPL",
      "FRM_ON_ORG",
      "FRM_E071",
      "FRM_E071KS",
      "FRM_E071KA",
      "FRM_BF_END",
      "FRM_AF_ENQ",
      "FRM_BF_UDL",
      "FRM_AF_UDL",
      "FRM_BF_PRN",
      "FRM_AF_CHK",
      "FRM_AF_INI",
      "FRM_IN_DSS",
      "FRM_H_FLDS",
      "FRM_RP_POS",
      "FRM_TL_GET",
      "FRM_TL_ORG",
      "FRM_TL_UPD",
      "FRM_TLTEXT",
      "FRM_BF_ADR",
      "FRM_AF_DLM",
      "FRM_ON_AUT",
      "FRM_BF_ALV",
      "FRM_AF_UID",
      "FRM_AF_EDD"
    ]
  },
  VIMNAMTAB: {
    fingerprint: "bc839611952ddc5a2c49bab99125100b2f405f446b171f97e5e5b84f47e2e36e",
    fields: [
      "VIEWFIELD",
      "KEYFLAG",
      "POSITION",
      "READONLY",
      "LOWERCASE",
      "FLENGTH",
      "OUTPUTLEN",
      "SCRTEXT",
      "TABIX",
      "DOMNAME",
      "CHECKTABLE",
      "INTTYPE",
      "DATATYPE",
      "PRIMTABKEY",
      "CONVEXIT",
      "TEXTTABFLD",
      "DECIMALS",
      "SIGN",
      "LENG",
      "ROLLNAME",
      "PRTFRKYFLD",
      "BASTABNAME",
      "BASTABFLD",
      "TXTTABFLDN",
      "TEXTTABPOS",
      "TEXTFLDSEL",
      "MEMORYID",
      "REFTABLE",
      "REFFIELD",
      "REPTEXT",
      "SCRTEXT_S",
      "SCRTEXT_M",
      "SCRTEXT_L"
    ]
  },
  TVIMF: {
    fingerprint: "173d730f8fec4e6071723ac870a83f844d68ecfdfa4971c84efd1317f3ef2924",
    fields: ["TABNAME", "EVENT", "FORMNAME"]
  }
} as const

// Active deployed source/ABI and actual SOAP primitive shapes, w200 r74.
export const configurationBteMetadataPins = {
  source: "8fe403c426487d959a057b5bd368166baab3596c90b1a718e4ffedd6989fbad6",
  interface: "b498f6e907c84afbed3d5c913121fcea9e11c10102e5c4270e395d2125570307",
  standard: {
    VIEW_GET_DDIC_INFO: {
      functionGroup: "SVIX",
      source: "664862e585d40b9c861723e638889c498140dff3e6cac1ee005e534513c9210f",
      interface: "7257ed108a4ed78f0d38a458ee51c3c97feb5d68be781715c164cc843fb3dd7a"
    },
    VIEW_AUTHORITY_CHECK: {
      functionGroup: "SVIX",
      source: "7d4fd479dbeaead1bd179578506691a1991f9f8372948f86b997832c908c82aa",
      interface: "18ad8eee7711075432161fd6f58fd997a4d1a7e2702379024482512986c36ef1"
    }
  }
} as const

export const configurationBteMetadataFieldContracts = {
  VIMDESC: {
    VIEWNAME: {
      dataType: "CHAR",
      length: 30
    },
    MAINTVIEW: {
      dataType: "CHAR",
      length: 30
    },
    AREA: {
      dataType: "CHAR",
      length: 26
    },
    DEVCLASS: {
      dataType: "CHAR",
      length: 30
    },
    TYPE: {
      dataType: "CHAR",
      length: 1
    },
    LISTE: {
      dataType: "NUMC",
      length: 4
    },
    DETAIL: {
      dataType: "NUMC",
      length: 4
    },
    OCCURS: {
      dataType: "NUMC",
      length: 4
    },
    CLTCODE: {
      dataType: "CHAR",
      length: 20
    },
    BASTAB: {
      dataType: "CHAR",
      length: 1
    },
    NEWGENER: {
      dataType: "CHAR",
      length: 1
    },
    GENDATE: {
      dataType: "DATS"
    },
    GENTIME: {
      dataType: "TIMS"
    },
    FLAG: {
      dataType: "CHAR",
      length: 1
    },
    EXISTENCY: {
      dataType: "CHAR",
      length: 1
    },
    SELECTION: {
      dataType: "CHAR",
      length: 1
    },
    DDTEXT: {
      dataType: "CHAR",
      length: 60
    },
    CLIDEP: {
      dataType: "CHAR",
      length: 1
    },
    TEXTCLIDEP: {
      dataType: "CHAR",
      length: 1
    },
    KEYLEN: {
      dataType: "INT4"
    },
    AFTER_KEYC: {
      dataType: "INT4"
    },
    TEXTKEYLEN: {
      dataType: "INT4"
    },
    AFT_TXTKC: {
      dataType: "INT4"
    },
    TABLEN: {
      dataType: "INT4"
    },
    AFTER_TABC: {
      dataType: "INT4"
    },
    TEXTTABLEN: {
      dataType: "INT4"
    },
    AFT_TXTTBC: {
      dataType: "INT4"
    },
    MAXTRKEYLN: {
      dataType: "INT4"
    },
    TRGKEYPOS: {
      dataType: "INT4"
    },
    MAXTRTXKLN: {
      dataType: "INT4"
    },
    TRTXGKPOS: {
      dataType: "INT4"
    },
    CUSTOMAUTH: {
      dataType: "CHAR",
      length: 1
    },
    AUTHCLASS: {
      dataType: "NUMC",
      length: 2
    },
    SUBSETFLAG: {
      dataType: "CHAR",
      length: 1
    },
    RDONLYFLAG: {
      dataType: "CHAR",
      length: 1
    },
    ADRNBRFLAG: {
      dataType: "CHAR",
      length: 1
    },
    GUIDFLAG: {
      dataType: "CHAR",
      length: 1
    },
    USREXIFLAG: {
      dataType: "CHAR",
      length: 1
    },
    HIDDENFLAG: {
      dataType: "CHAR",
      length: 1
    },
    DELMDTFLAG: {
      dataType: "CHAR",
      length: 1
    },
    TEXTTBEXST: {
      dataType: "CHAR",
      length: 1
    },
    PTFRKYEXST: {
      dataType: "CHAR",
      length: 1
    },
    GENERICTRP: {
      dataType: "CHAR",
      length: 1
    },
    GENERTXTRP: {
      dataType: "CHAR",
      length: 1
    },
    FIELDORDER: {
      dataType: "CHAR",
      length: 1
    },
    TEXTTAB: {
      dataType: "CHAR",
      length: 30
    },
    ORIG_LANG: {
      dataType: "LANG",
      length: 1
    },
    SPRASFIELD: {
      dataType: "CHAR",
      length: 30
    },
    SPRASFDPOS: {
      dataType: "NUMC",
      length: 6
    },
    ROOTTAB: {
      dataType: "CHAR",
      length: 30
    },
    GUI_PROG: {
      dataType: "CHAR",
      length: 40
    },
    CURSETTING: {
      dataType: "CHAR",
      length: 1
    },
    IMPORTABLE: {
      dataType: "CHAR",
      length: 1
    },
    SCRFRMFLAG: {
      dataType: "CHAR",
      length: 1
    },
    FPOOLNAME: {
      dataType: "CHAR",
      length: 40
    },
    MAINFLAG: {
      dataType: "CHAR",
      length: 1
    },
    FRM_BF_SAV: {
      dataType: "CHAR",
      length: 30
    },
    FRM_AF_SAV: {
      dataType: "CHAR",
      length: 30
    },
    FRM_BF_DEL: {
      dataType: "CHAR",
      length: 30
    },
    FRM_AF_DEL: {
      dataType: "CHAR",
      length: 30
    },
    FRM_ON_NEW: {
      dataType: "CHAR",
      length: 30
    },
    FRM_AF_ORG: {
      dataType: "CHAR",
      length: 30
    },
    FRM_BF_RPL: {
      dataType: "CHAR",
      length: 30
    },
    FRM_AF_RPL: {
      dataType: "CHAR",
      length: 30
    },
    FRM_RP_ORG: {
      dataType: "CHAR",
      length: 30
    },
    FRM_RP_GET: {
      dataType: "CHAR",
      length: 30
    },
    FRM_RP_UPD: {
      dataType: "CHAR",
      length: 30
    },
    FRM_RP_CPL: {
      dataType: "CHAR",
      length: 30
    },
    FRM_ON_ORG: {
      dataType: "CHAR",
      length: 30
    },
    FRM_E071: {
      dataType: "CHAR",
      length: 30
    },
    FRM_E071KS: {
      dataType: "CHAR",
      length: 30
    },
    FRM_E071KA: {
      dataType: "CHAR",
      length: 30
    },
    FRM_BF_END: {
      dataType: "CHAR",
      length: 30
    },
    FRM_AF_ENQ: {
      dataType: "CHAR",
      length: 30
    },
    FRM_BF_UDL: {
      dataType: "CHAR",
      length: 30
    },
    FRM_AF_UDL: {
      dataType: "CHAR",
      length: 30
    },
    FRM_BF_PRN: {
      dataType: "CHAR",
      length: 30
    },
    FRM_AF_CHK: {
      dataType: "CHAR",
      length: 30
    },
    FRM_AF_INI: {
      dataType: "CHAR",
      length: 30
    },
    FRM_IN_DSS: {
      dataType: "CHAR",
      length: 30
    },
    FRM_H_FLDS: {
      dataType: "CHAR",
      length: 30
    },
    FRM_RP_POS: {
      dataType: "CHAR",
      length: 30
    },
    FRM_TL_GET: {
      dataType: "CHAR",
      length: 30
    },
    FRM_TL_ORG: {
      dataType: "CHAR",
      length: 30
    },
    FRM_TL_UPD: {
      dataType: "CHAR",
      length: 30
    },
    FRM_TLTEXT: {
      dataType: "CHAR",
      length: 30
    },
    FRM_BF_ADR: {
      dataType: "CHAR",
      length: 30
    },
    FRM_AF_DLM: {
      dataType: "CHAR",
      length: 30
    },
    FRM_ON_AUT: {
      dataType: "CHAR",
      length: 30
    },
    FRM_BF_ALV: {
      dataType: "CHAR",
      length: 30
    },
    FRM_AF_UID: {
      dataType: "CHAR",
      length: 30
    },
    FRM_AF_EDD: {
      dataType: "CHAR",
      length: 30
    }
  },
  VIMNAMTAB: {
    VIEWFIELD: {
      dataType: "CHAR",
      length: 30
    },
    KEYFLAG: {
      dataType: "CHAR",
      length: 1
    },
    POSITION: {
      dataType: "NUMC",
      length: 4
    },
    READONLY: {
      dataType: "CHAR",
      length: 1
    },
    LOWERCASE: {
      dataType: "CHAR",
      length: 1
    },
    FLENGTH: {
      dataType: "NUMC",
      length: 6
    },
    OUTPUTLEN: {
      dataType: "NUMC",
      length: 6
    },
    SCRTEXT: {
      dataType: "CHAR",
      length: 40
    },
    TABIX: {
      dataType: "INT4"
    },
    DOMNAME: {
      dataType: "CHAR",
      length: 30
    },
    CHECKTABLE: {
      dataType: "CHAR",
      length: 30
    },
    INTTYPE: {
      dataType: "CHAR",
      length: 1
    },
    DATATYPE: {
      dataType: "CHAR",
      length: 4
    },
    PRIMTABKEY: {
      dataType: "NUMC",
      length: 4
    },
    CONVEXIT: {
      dataType: "CHAR",
      length: 5
    },
    TEXTTABFLD: {
      dataType: "CHAR",
      length: 1
    },
    DECIMALS: {
      dataType: "NUMC",
      length: 6
    },
    SIGN: {
      dataType: "CHAR",
      length: 1
    },
    LENG: {
      dataType: "NUMC",
      length: 6
    },
    ROLLNAME: {
      dataType: "CHAR",
      length: 30
    },
    PRTFRKYFLD: {
      dataType: "CHAR",
      length: 1
    },
    BASTABNAME: {
      dataType: "CHAR",
      length: 30
    },
    BASTABFLD: {
      dataType: "CHAR",
      length: 30
    },
    TXTTABFLDN: {
      dataType: "CHAR",
      length: 30
    },
    TEXTTABPOS: {
      dataType: "NUMC",
      length: 6
    },
    TEXTFLDSEL: {
      dataType: "CHAR",
      length: 1
    },
    MEMORYID: {
      dataType: "CHAR",
      length: 20
    },
    REFTABLE: {
      dataType: "CHAR",
      length: 30
    },
    REFFIELD: {
      dataType: "CHAR",
      length: 30
    },
    REPTEXT: {
      dataType: "CHAR",
      length: 55
    },
    SCRTEXT_S: {
      dataType: "CHAR",
      length: 10
    },
    SCRTEXT_M: {
      dataType: "CHAR",
      length: 20
    },
    SCRTEXT_L: {
      dataType: "CHAR",
      length: 40
    }
  },
  TVIMF: {
    TABNAME: {
      dataType: "CHAR",
      length: 30
    },
    EVENT: {
      dataType: "CHAR",
      length: 2
    },
    FORMNAME: {
      dataType: "CHAR",
      length: 30
    }
  }
} as const
