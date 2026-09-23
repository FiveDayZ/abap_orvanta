$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $projectRoot "scripts\bootstrap-sap-helper.ps1"
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
    $scriptPath,
    [ref]$tokens,
    [ref]$errors
)
if ($errors.Count -gt 0) {
    throw "bootstrap-sap-helper.ps1 has parser errors: $($errors -join '; ')"
}

$functionAst = $ast.Find(
    {
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq "ConvertFrom-SapSoapResponse"
    },
    $true
)
if (-not $functionAst) {
    throw "ConvertFrom-SapSoapResponse was not found"
}
Invoke-Expression $functionAst.Extent.Text

$assignmentFunctionAst = $ast.Find(
    {
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq "New-AssignmentInspectionProgram"
    },
    $true
)
if (-not $assignmentFunctionAst) {
    throw "New-AssignmentInspectionProgram was not found"
}
Invoke-Expression $assignmentFunctionAst.Extent.Text
$assignmentProgram = New-AssignmentInspectionProgram
$requiredAssignmentMarkers = @(
    "DYNPRO PROG PACKAGE",
    "DYNPRO TRAN PACKAGE",
    "TRANSPORT R3TR PROG ZCODEX_MCP_DYNPRO",
    "TRANSPORT LIMU DYNP ZCODEX_MCP_DYNPRO0100",
    "TRANSPORT SCREEN VIA R3TR PROG",
    "TRANSPORT R3TR TRAN ZCODEX_MCP_UI"
)
foreach ($marker in $requiredAssignmentMarkers) {
    if (-not ($assignmentProgram -match [regex]::Escape($marker))) {
        throw "Assignment inspection is missing marker: $marker"
    }
}
$longAssignmentLine = $assignmentProgram | Where-Object { $_.Length -gt 72 } | Select-Object -First 1
if ($longAssignmentLine) {
    throw "Assignment inspection line exceeds 72 characters: $longAssignmentLine"
}

foreach ($functionName in @(
        "New-DdicFunctionSource",
        "New-DdicObjectDiagnosticProgram",
        "New-HelperApiDiagnosticProgram",
        "New-GuiApiInspectionProgram",
        "New-GuiObjectInspectionProgram",
        "New-InstallProgram",
        "New-RepositoryFunctionDiagnosticProgram"
    )) {
    $definition = $ast.Find(
        {
            param($node)
            $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
                $node.Name -eq $functionName
        },
        $true
    )
    if (-not $definition) {
        throw "$functionName was not found"
    }
    Invoke-Expression $definition.Extent.Text
}
# 脚本顶层先执行 $ddic* 赋值（min/max 版本等），函数在真实运行中读这些变量。只取函数定义会让
# 这些变量为空，生成的行会比真实运行短——0.46.8 的 R-16 修复因此漏掉了一条 74 字符的
# RESUME_TABLE_ACTIVATION 能力行（历史上名为 RESUME_TRANSPARENT_TABLE_ACTIVATION，35 字符），而 New-InstallProgram 在真实状态下会抛
# "Generated function source exceeds 72 characters"。这里复现真实状态，使该缺陷类无法再隐藏。
foreach ($statement in $ast.EndBlock.Statements) {
    if ($statement -isnot [Management.Automation.Language.AssignmentStatementAst]) { continue }
    if ($statement.Left.Extent.Text -notmatch '^\$ddic[A-Za-z0-9_]*$') { continue }
    Invoke-Expression $statement.Extent.Text | Out-Null
}
if (-not $ddicCapabilityMinVersion -or -not $ddicCapabilityMaxVersion) {
    throw "the DDIC capability table did not yield min/max protocol versions"
}
$PackageName = "ZABAP"
$TransportNumber = "GR2K923472"
$TransportTask = ""
$helperDiagnosticProgram = New-HelperApiDiagnosticProgram
$longHelperDiagnosticLine = $helperDiagnosticProgram | Where-Object { $_.Length -gt 72 } | Select-Object -First 1
if ($longHelperDiagnosticLine) {
    throw "Helper diagnostic line exceeds 72 characters: $longHelperDiagnosticLine"
}
foreach ($marker in @("Z_ORVANTA_MCP_EXECUTE", "Z_ORVANTA_MCP_DYNPRO_API", "Z_ORVANTA_MCP_DDIC_API", "zorvanta_mcp_bootstrap", "enlfdir-active")) {
    if (-not ($helperDiagnosticProgram -match [regex]::Escape($marker))) {
        throw "Helper diagnostic is missing marker: $marker"
    }
}
$diagnosticProgram = New-DdicObjectDiagnosticProgram
$guiInspectionProgram = New-GuiApiInspectionProgram
$guiObjectInspectionProgram = New-GuiObjectInspectionProgram
$longGuiInspectionLine = $guiInspectionProgram | Where-Object { $_.Length -gt 72 } | Select-Object -First 1
if ($longGuiInspectionLine) {
    throw "GUI API inspection line exceeds 72 characters: $longGuiInspectionLine"
}
$longGuiObjectLine = $guiObjectInspectionProgram | Where-Object { $_.Length -gt 72 } | Select-Object -First 1
if ($longGuiObjectLine) {
    throw "GUI object inspection line exceeds 72 characters: $longGuiObjectLine"
}
foreach ($marker in @(
        "RS_CUA_INTERNAL_FETCH",
        "SOURCE_ACTIVE",
        "SOURCE_INACTIVE",
        "RS_DELETE_PROGRAM",
        "DELETE_SOURCE",
        "lt_sta",
        "lt_fun",
        "lt_tit"
    )) {
    if (-not ($guiObjectInspectionProgram -match [regex]::Escape($marker))) {
        throw "GUI object inspection is missing marker: $marker"
    }
}
foreach ($marker in @(
        "RS_CUA_INTERNAL_FETCH",
        "RS_CUA_INTERNAL_WRITE",
        "DDIF_FIELDINFO_GET",
        "RSMPE_STAF",
        "RSMPE_TITT"
    )) {
    if (-not ($guiInspectionProgram -match [regex]::Escape($marker))) {
        throw "GUI API inspection is missing marker: $marker"
    }
}
$longDiagnosticLine = $diagnosticProgram | Where-Object { $_.Length -gt 72 } | Select-Object -First 1
if ($longDiagnosticLine) {
    throw "DDIC diagnostic line exceeds 72 characters: $longDiagnosticLine"
}
$repositoryDiagnosticProgram = New-RepositoryFunctionDiagnosticProgram
$longRepositoryDiagnosticLine = $repositoryDiagnosticProgram | Where-Object { $_.Length -gt 72 } | Select-Object -First 1
if ($longRepositoryDiagnosticLine) {
    throw "Repository diagnostic line exceeds 72 characters: $longRepositoryDiagnosticLine"
}
foreach ($marker in @("FUNCTION_EXISTS", "ENLFDIR_SUBRC", "SOURCE_LINES")) {
    if (-not ($repositoryDiagnosticProgram -match [regex]::Escape($marker))) {
        throw "Repository diagnostic is missing marker: $marker"
    }
}
foreach ($marker in @("DDIF_DD_CHECK", "DDIF_TABL_GET", "ls_dd09v-bufallow", "ls_dd03p-notnull")) {
    if (-not ($diagnosticProgram -match [regex]::Escape($marker))) {
        throw "DDIC diagnostic is missing marker: $marker"
    }
}
$ddicFunction = New-DdicFunctionSource
# 按“发布者”分别断言，而不是按总数：结构读取器走 DDIF_FIELDINFO_GET 的 <ls_field>（只发布
# DATATYPE/LENG），表读取器走 DD03P，且 0.46.3/0.46.4 起表读取器有活动与非活动两条路径，各自
# 发布 DATATYPE/LENG/COMPTYPE。原断言把总数硬编码为 2，新增非活动路径后必然失败（R-16）。
$fieldMetadataPublishers = @(
    @{ Property = "DATATYPE"; Publisher = "<ls_field>"; Expected = 1 },
    @{ Property = "DATATYPE"; Publisher = "ls_dd03p"; Expected = 2 },
    @{ Property = "LENG"; Publisher = "<ls_field>"; Expected = 1 },
    @{ Property = "LENG"; Publisher = "ls_dd03p"; Expected = 2 },
    @{ Property = "COMPTYPE"; Publisher = "ls_dd03p"; Expected = 2 }
)
foreach ($expected in $fieldMetadataPublishers) {
    $property = $expected.Property
    $component = $property.ToLower()
    $publisherField = $expected.Publisher
    $fieldLines = @($ddicFunction | Where-Object {
            $_ -match [regex]::Escape("add_payload 'F' lv_index '$property'") -and
            $_ -match [regex]::Escape("$publisherField-$component")
        })
    if ($fieldLines.Count -ne $expected.Expected) {
        throw "Field metadata publisher $publisherField must emit $property $($expected.Expected) time(s), found $($fieldLines.Count)"
    }
}
$ddicProgram = New-InstallProgram -FunctionName "Z_ORVANTA_MCP_DDIC_API"
$longDdicLine = $ddicProgram | Where-Object { $_.Length -gt 72 } | Select-Object -First 1
if ($longDdicLine) {
    throw "DDIC bootstrap line exceeds 72 characters: $longDdicLine"
}
# Also assert the source the chunker consumes: a >72 column body line makes New-InstallProgram throw
# in the real script state (that is the R-16 defect class), and this states it directly.
$longBodyLine = $ddicFunction | Where-Object { $_.Length -gt 72 } | Select-Object -First 1
if ($longBodyLine) {
    throw "DDIC function body line exceeds 72 characters: $longBodyLine"
}
foreach ($marker in @(
        "IV_EXPECTED_VERSION",
        "ls_import-dbfield = 'BAPIRET2-PARAMETER'",
        "Z_ORVANTA_MCP_DDIC_API",
        "ZORVANTA_MCP_CORE",
        "ORVANTA MCP controlled entry point",
        "DDIF_DOMA_PUT",
        "DDIF_DTEL_PUT",
        "DDIF_STATE_GET",
        "DDIF_OBJECT_DELETE",
        "DELETE_DOMAIN",
        "DELETE_DATA_ELEMENT",
        "DELETE_STRUCTURE",
        "DELETE_TABLE_TYPE",
        "DEPENDENCIES_EXIST",
        "DDIC_OBJECT_DELETED",
        "lv_state_type = 'TABL'",
        "DDIF_TABL_PUT",
        "READ_TRANSPARENT_TABLE",
        "CREATE_TRANSPARENT_TABLE",
        "APPEND_TRANSPARENT_TABLE_FIELDS",
        "PATCH_TRANSPARENT_TABLE_FIELDS",
        "PATCH_TRANSPARENT_TABLE_SETTINGS",
        "RECOVER_TABLE_CONVERSION",
        "DELETE_TRANSPARENT_TABLE",
        "UNSAFE_TABLE_CHANGE",
        "MANDT_CHANGE_FORBIDDEN",
        "KEY_ORDER_INVALID",
        "DUPLICATE_FIELD",
        "FIELD_ALREADY_EXISTS",
        "COMPLEX_COMPONENT_CHANGE_FORBIDDEN",
        "Include and Append components are immutable",
        "DD_TABL_ACT",
        "ACT_RES_TAB",
        "CONVERSION_ACTION",
        "DDIC_CONVERSION_PENDING",
        "DD_DB_CONVERTER",
        "WORKLIST_CONFLICT",
        "DDIC_CONVERSION_RECOVERED",
        "SCHFELDANZ",
        "PROTOKOLL",
        "PRECFIELD",
        "ADMINFIELD",
        "lt_dd03p[] = lt_current_dd03p[]",
        "ls_dd09v = ls_current_dd09v",
        "lv_append IS INITIAL",
        "Existing transparent tables cannot be replaced",
        "ls_dd09v-bufallow",
        "ls_dd09v-tabart",
        "ls_dd03p-keyflag",
        "DDIF_TTYP_PUT",
        "ls_dd04v-headlen",
        "ls_dd04v-scrlen1",
        "use_korrnum_immediatedly",
        # 2026-09-21 回移：线上帮手（1.10 载体）已修、脚本未跟的两处能力。缺了它们，
        # 非活动定义会发布活动版本表头，锁对象行缺 ENQMODE。
        "add_payload 'M' '1' 'DDTEXT' ls_current_dd02v-ddtext",
        "add_payload 'L1' lv_index 'ENQMODE' ls_dd26v-enqmode",
        # 对照组：活动路径仍必须读活动表头 ls_dd02v。
        "add_payload 'H' '1' 'DDTEXT' ls_dd02v-ddtext",
        "add_payload 'L2' lv_index 'ENQMODE' ls_dd27p-enqmode"
    )) {
    if (-not (($ddicProgram + $ddicFunction) -match [regex]::Escape($marker))) {
        throw "DDIC bootstrap is missing marker: $marker"
    }
}
$ddicFunctionText = $ddicFunction -join "`n"
if ($ddicFunctionText -notmatch "LOOP AT lt_dd03p ASSIGNING <ls_field>\.\r?\n\s+IF lv_append IS INITIAL AND lv_patch IS INITIAL\r?\n\s+AND lv_settings IS INITIAL\.\r?\n\s+<ls_field>-tabname = iv_object_name\.[\s\S]*?<ls_field>-comptype = 'E'\.") {
    throw "DDIC append must not rewrite existing field component metadata"
}
if (-not ($ddicFunction -match "ev_version = '1.7'")) {
    throw "DDIC helper 1.7 marker is missing"
}
if (-not ($ddicFunction -match "dd01v_wa = ls_current_dd01v")) {
    throw "DDIC bootstrap must keep the active domain separate from the requested definition"
}
$repositoryProgram = New-InstallProgram -FunctionName "Z_ORVANTA_MCP_DYNPRO_API"
$longRepositoryLine = $repositoryProgram | Where-Object { $_.Length -gt 72 } | Select-Object -First 1
if ($longRepositoryLine) {
    throw "Repository bootstrap line exceeds 72 characters: $longRepositoryLine"
}
$scriptText = Get-Content -Raw $scriptPath
$longReadStart = $scriptText.IndexOf("WHEN 'READ_FUNCTION_INTERFACE'.")
$longReadEnd = $scriptText.IndexOf("WHEN 'CREATE_FUNCTION_MODULE'.", $longReadStart)
$longReadBody = $scriptText.Substring($longReadStart, $longReadEnd - $longReadStart)
foreach ($marker in @(
    "DATA lt_fm_long_source TYPE rsfb_source.",
    "CALL FUNCTION 'RPY_FUNCTIONMODULE_READ_NEW'",
    "CHANGING new_source = lt_fm_long_source",
    "SOURCE_CLIENT_UPGRADE_REQUIRED",
    "SOURCE_LINE_TOO_LONG",
    "iv_object_type <> 'SRC1'",
    "'SOURCE_FORMAT' 'CHUNKS_V1'",
    "lv_fm_chunk_length = 60.",
    "lv_fm_long_line+lv_fm_source_offset(lv_fm_chunk_length)"
)) {
    if (-not $scriptText.Contains($marker)) {
        throw "Long function source read is missing: $marker"
    }
}
if ($longReadBody.Contains("CALL FUNCTION 'RPY_FUNCTIONMODULE_READ'") -or
    $longReadBody.Contains("ls_fm_source-line = lv_fm_long_line")) {
    throw "Long source must not pass through the 72-character source buffer"
}
$sourceClear = $longReadBody.IndexOf("REFRESH lt_fm_source.")
$sourceEmit = $longReadBody.IndexOf("emit_fm_payload.")
if ($sourceClear -lt 0 -or $sourceClear -gt $sourceEmit) {
    throw "Partial legacy source must be discarded before emitting long source"
}
foreach ($marker in @("Z_ORVANTA_MCP_DYNPRO_API", "FUNCTION_CREATE")) {
    if (-not ($repositoryProgram -match [regex]::Escape($marker))) {
        throw "Generated repository bootstrap is missing marker: $marker"
    }
}
if (-not ($repositoryProgram -match "FUNCTION_ACTIVATION_FLAG_ERROR")) {
    throw "Generated repository bootstrap must persist the active function flag"
}
# D7 interface extension (2026-09-23). The repository body is shared by Z_ORVANTA_MCP_EXECUTE and
# Z_ORVANTA_MCP_DYNPRO_API, so both are installed with the SAME interface: declaring the new
# parameters for only one of them would install a body that references fields its interface omits
# (GENERATE_ERROR 4902, the IV_EXPECTED_VERSION precedent). The DDIC helper uses a different body
# and must stay untouched, so the predicate must be "not the DDIC helper", never one FM name.
$executeProgram = New-InstallProgram -FunctionName "Z_ORVANTA_MCP_EXECUTE"
$repositoryParameterLines = @($repositoryProgram | Where-Object { $_ -match "ls_(import|export|tables)-parameter" })
$executeParameterLines = @($executeProgram | Where-Object { $_ -match "ls_(import|export|tables)-parameter" })
$ddicParameterLines = @($ddicProgram | Where-Object { $_ -match "ls_(import|export|tables)-parameter" })
if (($repositoryParameterLines -join "`n") -ne ($executeParameterLines -join "`n")) {
    throw "Z_ORVANTA_MCP_EXECUTE and Z_ORVANTA_MCP_DYNPRO_API share one body and must share one interface"
}
# Interface parameters that exist only on the repository helper (Z_ORVANTA_MCP_DYNPRO_API and the
# shared Z_ORVANTA_MCP_EXECUTE body). The DDIC helper is a separate body and must not grow them.
$repositoryOnlyParameters = @(
    "IV_TEXT_STATUS",
    "IV_TEXT_LANGUAGE",
    "IV_TEXT_VERSION",
    "IV_STYLE_VARIANT",
    "IV_STYLE_ACTIVE",
    "IV_STYLE_MODE",
    "IV_INCLUDE_SOURCE",
    "IV_INCLUDE_CSS",
    "IV_REQUEST_TYPE",
    "IV_REQUEST_TEXT",
    "IV_REQUEST_OWNER",
    "IV_REQUEST_TARGET",
    "IV_REQUEST_ALLOW_DUPLICATE",
    "ES_FORM_HEADER",
    "ES_TEXT_HEADER",
    "ES_STYLE_HEADER",
    "ES_SAPSCRIPT_STYLE_HEADER",
    "ET_FORM_LINES",
    "ET_FORM_PAGES",
    "ET_FORM_PAGE_WINDOWS",
    "ET_FORM_PARAGRAPHS",
    "ET_FORM_STRINGS",
    "ET_FORM_TABS",
    "ET_FORM_WINDOWS",
    "ET_FORM_VERSIONS",
    "ET_TEXT_HEADERS",
    "ET_STYLE_HEADERS",
    "ET_STYLE_PARAGRAPHS",
    "ET_STYLE_STRINGS",
    "ET_STYLE_TABSTOPS",
    "ET_STYLE_ITEMS_PARA",
    "ET_STYLE_ITEMS_STR",
    "ET_STYLE_ITEMS_TAB"
)
foreach ($name in $repositoryOnlyParameters) {
    if (-not ($repositoryParameterLines -match [regex]::Escape("'$name'"))) {
        throw "Repository interface extension is missing parameter: $name"
    }
    if ($ddicParameterLines -match [regex]::Escape("'$name'")) {
        throw "The DDIC helper must not declare the repository-only parameter: $name"
    }
}
# Every carrier below is a DDIC object that exists on the target system. Pinning the exact carrier
# keeps the pre-change verification traceable: each one was read from w200 before this generator was
# changed. The bare data element names match how SAP's own SSF_READ_STYLE types its parameters
# (I_STYLE_ACTIVE_FLAG :: TDACTIVATE, I_STYLE_VARIANT :: TDVARIANT). All new IMPORTING parameters
# must stay OPTIONAL so existing operations are unaffected.
$verifiedCarriers = [ordered]@{
    "IV_TEXT_STATUS"   = "ITCTA-TDSTATUS"
    "IV_TEXT_LANGUAGE" = "TDSPRAS"
    "IV_TEXT_VERSION"  = "THEAD-TDVERSION"
    "IV_STYLE_VARIANT" = "TDVARIANT"
    "IV_STYLE_ACTIVE"  = "TDACTIVATE"
    "IV_STYLE_MODE"    = "TDCHAR1"
    "IV_INCLUDE_SOURCE" = "TDCHAR1"
    "IV_INCLUDE_CSS"   = "TDCHAR1"
    # create_transport_request (D9-1). Every carrier below was read from w200 on 2026-09-23 as part of
    # the FM contract check: TRFUNCTION/AS4USER are E070 field data elements and TR_TARGET is the
    # E070-TARSYSTEM data element, while AS4TEXT is E07T-AS4TEXT. TRBOOLEAN is the type SAP itself
    # uses for TRINT_OBJECTS_CHECK_AND_INSERT-IV_WITH_DIALOG and TR_OBJECT_INSERT-IV_OLD_CALL.
    "IV_REQUEST_TYPE"  = "TRFUNCTION"
    "IV_REQUEST_TEXT"  = "AS4TEXT"
    "IV_REQUEST_OWNER" = "AS4USER"
    "IV_REQUEST_TARGET" = "TR_TARGET"
    "IV_REQUEST_ALLOW_DUPLICATE" = "TRBOOLEAN"
}
foreach ($name in $verifiedCarriers.Keys) {
    $declaration = "ls_import-parameter = '$name'."
    $index = -1
    for ($position = 0; $position -lt $repositoryProgram.Count; $position++) {
        if ($repositoryProgram[$position] -eq $declaration) { $index = $position; break }
    }
    if ($index -lt 0) {
        throw "Missing import declaration for $name"
    }
    $carrier = $verifiedCarriers[$name]
    if ($repositoryProgram[$index + 1] -ne "ls_import-dbfield = '$carrier'.") {
        throw "$name must be typed on the verified carrier $carrier"
    }
    if ($repositoryProgram[$index + 2] -ne "ls_import-optional = 'X'.") {
        throw "$name must stay OPTIONAL"
    }
}
if (-not ($scriptText -match "TRANSACTION_NOT_FOUND") -or
    -not ($scriptText -match "Transaction does not exist")) {
    throw "Repository helper must distinguish a missing transaction from a read failure"
}
if ($scriptText -match "MESSAGE_CLASS_READ_FAILED" -or
    $scriptText -match "Message class metadata does not exist") {
    throw "Repository helper must classify missing message-class metadata as not found"
}
if (($scriptText -match '"        CHANGING corrnumber') -or
    -not ($scriptText -match '"\s+EXPORTING corrnumber = lv_delete_corrnum"') -or
    -not ($scriptText -match '"\s+IMPORTING corrnumber = lv_delete_corrnum"')) {
    throw "RS_DELETE_PROGRAM must use its separate import and export parameters"
}
if (-not ($scriptText -match "Task record and repository absence verified") -or
    -not ($scriptText -match "Repository absent without a task record") -or
    -not ($scriptText -match "OR ls_e071-obj_name IS INITIAL")) {
    throw "Module-pool deletion must verify repository absence against the user task"
}
if (($scriptText -match '"          suppress_commit = ''X'' suppress_popup') -or
    -not ($scriptText -match '"\s+suppress_commit = space suppress_popup = ''X''"') -or
    -not ($scriptText -match '"\s+mass_delete_call = space with_cua = ''X''"')) {
    throw "RS_DELETE_PROGRAM must own its commit outside mass-delete mode"
}
$deleteProgramCall = $scriptText.IndexOf("CALL FUNCTION 'RS_DELETE_PROGRAM'")
$deleteProgramCommit = $scriptText.IndexOf('"      COMMIT WORK AND WAIT."', $deleteProgramCall)
$deleteProgramVerify = $scriptText.IndexOf('"      CLEAR: ls_tadir, ls_trdir."', $deleteProgramCall)
if ($deleteProgramCall -lt 0 -or $deleteProgramCommit -lt 0 -or
    $deleteProgramCommit -gt $deleteProgramVerify) {
    throw "RS_DELETE_PROGRAM deletion must commit before absence verification"
}
foreach ($marker in @(
        # D7 form/style reads (2026-09-23). Both opcodes must stay dispatched by the shared
        # repository body, and the style reads must keep calling these exact SAP APIs: the two
        # storage forms are never interchangeable, so a silent rename is a drift error.
        #
        # These markers are deliberately pinned to the DISPATCH statement and to the quoted payload
        # property names. A bare opcode such as READ_SMARTSTYLE also appears in the capability table
        # and in the interface lines, so it would keep this guard green after the branch itself was
        # renamed away - which is exactly the drift the guard exists to catch.
        "WHEN 'READ_SAPSCRIPT_FORM'.",
        "WHEN 'READ_SMARTSTYLE'.",
        "WHEN 'READ_ADOBE_FORM'.",
        "READ_FORM'",
        "READ_TEXT'",
        "SSF_READ_STYLE'",
        "SSF_READ_STYLE_ALL_VARIANTS'",
        "SSF_READ_SAPSCRIPT_STYLE'",
        "SSF_CONVERT_STYLE_TO_CSS'",
        "cl_fp_db_wrapper=>sel_lt_by_name_lang",
        "cl_fp_db_wrapper=>sel_xdp_by_name_lang",
        "cl_fp_wb_helper=>form_get_master_language",
        "SCMS_BASE64_ENCODE_STR",
        "ADOBE_FORM_NOT_FOUND",
        "'XDP_TRUNCATED'",
        "'STYLE_MODE'",
        "'CSS_STATUS'",
        "ev_version = '2.8'",
        # D9-1 create_transport_request (2026-09-23). The opcode must stay dispatched, and the branch
        # must keep using TR_INSERT_REQUEST_WITH_TASKS: TR_OBJECT_INSERT is NOT a substitute, because
        # it hard-codes iv_with_dialog = 'X' into TRINT_OBJECTS_CHECK_AND_INSERT, whose 'X' branch
        # calls POPUP_TO_CONFIRM_STEP (read from w200). The commit, the retry guard and the read-back
        # are the three properties the acceptance plan checks, so each is pinned separately.
        "WHEN 'CREATE_TRANSPORT_REQUEST'.",
        "CALL FUNCTION 'TR_INSERT_REQUEST_WITH_TASKS'",
        "COMMIT WORK AND WAIT.",
        "TRANSPORT_REQUEST_TYPE_REQUIRED",
        "TRANSPORT_REQUEST_TYPE_INVALID",
        "TRANSPORT_REQUEST_TEXT_REQUIRED",
        "TRANSPORT_REQUEST_EXISTS",
        "TRANSPORT_REQUEST_INSERT_FAILED",
        "TRANSPORT_REQUEST_ENQUEUE_FAILED",
        "TRANSPORT_REQUEST_NUMBER_MISSING",
        "TRANSPORT_REQUEST_NOT_PERSISTED",
        "'MATCHED_BY'",
        "'TASK_COUNT'",
        "DATA lv_d9_request_allow_dup TYPE trboolean.",
        "READ TEXTPOOL lv_textpool_program INTO lt_textpool",
        "INSERT TEXTPOOL lv_textpool_program FROM lt_textpool",
        "STATE 'A'",
        "RPY_MESSAGE_ID_READ",
        "RPY_MESSAGE_ID_INSERT",
        "RPY_TRANSACTION_INSERT",
        "RPY_TRANSACTION_DELETE",
        "RS_DELETE_PROGRAM",
        "DATA lv_report_variant TYPE tcvariant.",
        "transaction_type = 'R'",
        "variant = lv_report_variant",
        "CREATE_REPORT_TRANSACTION",
        "DELETE_TRANSACTION",
        "DELETE_MODULE_POOL",
        "TRANSPORT_TASK_NOT_FOUND",
        "lv_delete_corrnum = ls_task-trkorr",
        "DELETE REPORT iv_program STATE 'I'",
        "PATCH_SCREEN",
        "RPY_DYNPRO_READ'",
        "RPY_DYNPRO_INSERT'",
        "SCREEN_COMPONENT_EXISTS",
        "SCREEN_COMPONENT_NOT_FOUND",
        "SCREEN_PATCHED",
        "READ_MESSAGE_CLASS",
        "CREATE_MESSAGE_CLASS",
        "UPDATE_MESSAGE_CLASS",
        "MESSAGE_CLASS_UPDATED",
        "DELETE_MESSAGE_CLASS",
        "MESSAGE_CLASS_DELETED",
        "MESSAGE_CLASS_DELETE_VERIFY_FAILED",
        "DELETE FROM t100 WHERE arbgb = iv_object_name",
        "DELETE t100a FROM ls_message_info",
        "DELETE tadir FROM ls_message_tadir",
        "ASSIGN COMPONENT 'OBJFUNC' OF STRUCTURE ls_message_object",
        "iv_expected_version",
        "CREATE_FUNCTION_INCLUDE",
        "READ_TRANSPORT_DETAILS",
        "ls_transport_object-as4pos.",
        "RPY_FUNCTIONMODULE_READ",
        "RPY_FUNCTIONMODULE_INSERT",
        "EXPORTING funcname = lv_function_name",
        "parameter_docu = lt_fm_documentation",
        "AND iv_object_type = 'FUNC'",
        "RS_FUNCTION_POOL_INSERT",
        "ls_fm_documentation-stext = lv_payload_value",
        "kind = 'X'",
        "CREATE_FUNCTION_GROUP",
        "READ_FUNCTION_INTERFACE",
        "CREATE_FUNCTION_MODULE",
        "PATCH_FUNCTION_INTERFACE",
        "FUNCTION_INTERFACE_PATCHED",
        "FUNCTION_ADT_PATCH_NOT_OBSERVED",
        "ENQUEUE_ESFUNCTION",
        "lv_fm_lock_mode TYPE enqmode VALUE 'X'",
        "EXPORTING funcname = lv_function_name",
        "fu_modification_globals_init(SAPMS38L)",
        "do_read_docu_r3_new(SAPMS38L)",
        "do_update_docu_r3_new(SAPMS38L)",
        "FUNCTION_PATCH_SAVE_NOT_OBSERVED",
        "INSPECT_REPOSITORY_ASSIGNMENT",
        "lv_transport_object = 'CLAS'",
        "lv_transport_object = 'INTF'",
        "READ_GUI_DEFINITION",
        "PATCH_GUI_DEFINITION",
        "READ_CUSTOMER_EXIT_DEFINITION",
        "READ_CUSTOMER_EXIT_PROJECT",
        "READ_BTE_CONFIGURATION",
        "READ_CLASSIC_BADI_DEFINITION",
        "READ_ENHANCEMENT_IMPL",
        "CREATE_HOOK_ENHANCEMENT",
        "CREATE_BADI_ENHANCEMENT",
        "UPDATE_HOOK_ENHANCEMENT",
        "UPDATE_BADI_ENHANCEMENT",
        "MANAGE_ENHANCEMENT_STATE",
        "DELETE_ENHANCEMENT_IMPL",
        "MANAGE_CLASSIC_BADI_IMPL",
        "CUSTOMER_EXIT_DEFINITION_READ",
        "CUSTOMER_EXIT_PROJECT_READ",
        "BTE_CONFIGURATION_READ",
        "CLASSIC_BADI_DEFINITION_READ",
        "ENHANCEMENT_IMPLEMENTATION_READ",
        "HOOK_ENHANCEMENT_CREATED",
        "BADI_ENHANCEMENT_CREATED",
        "HOOK_ENHANCEMENT_UPDATED",
        "BADI_ENHANCEMENT_UPDATED",
        "ENHANCEMENT_IMPLEMENTATION_ACTIVATED",
        "ENHANCEMENT_INACTIVE_VERSION_DISCARDED",
        "ENHANCEMENT_IMPLEMENTATION_DELETED",
        "CLASSIC_BADI_IMPLEMENTATION_CHANGED",
        "SELECT * FROM modsap INTO TABLE lt_modsap",
        "SELECT * FROM modact INTO TABLE lt_modact",
        "SELECT SINGLE * FROM modattr INTO ls_modattr",
        "SELECT SINGLE * FROM tbe01 INTO ls_tbe01",
        "SELECT SINGLE * FROM tps01 INTO ls_tps01",
        "SELECT * FROM tbe31 INTO TABLE lt_tbe31",
        "SELECT * FROM tbe34 INTO TABLE lt_tbe34",
        "SELECT * FROM tps31 INTO TABLE lt_tps31",
        "SELECT * FROM tps34 INTO TABLE lt_tps34",
        "SELECT SINGLE * FROM tbe11 INTO ls_tbe11",
        "SELECT SINGLE * FROM tbe24 INTO ls_tbe24",
        "SELECT SINGLE * FROM sxs_attr INTO ls_sxs_attr",
        "SELECT * FROM sxs_inter INTO TABLE lt_sxs_inter",
        "SELECT * FROM sxc_exit INTO TABLE lt_sxc_exit",
        "SELECT SINGLE * FROM sxc_attr INTO ls_sxc_attr",
        "SELECT * FROM sxc_class INTO TABLE lt_sxc_class",
        "cl_enh_factory=>create_enhancement(",
        "cl_enh_tool_hook_impl=>tooltype",
        "cl_enh_tool_badi_impl=>tooltype",
        "lo_enh_hook->add_hook_impl(",
        "lo_enh_hook->modify_hook_impl(",
        "lo_enh_badi->add_implementation( ls_enh_badi )",
        "lo_enh_badi->delete_implementation( lv_enh_impl_name )",
        "has_inactive_version( )",
        "has_saved_inactive_version( )",
        "has_not_saved_inactive_version( )",
        "reset_to_active_version(",
        "CALL FUNCTION 'SXO_IMPL_CREATE'",
        "CALL FUNCTION 'SXO_IMPL_ACTIVE'",
        "CALL FUNCTION 'SXO_IMPL_DACTVE'",
        "CALL FUNCTION 'SXO_IMPL_DELETE'",
        "'HOOK_INDEX' lv_payload_index",
        "CHANGING devclass = lv_enh_devclass",
        "add_bte_application 'S' lv_payload_index ls_tbe31",
        "add_bte_product 'C' lv_payload_index ls_tps34",
        "add_repo_payload 'C' lv_payload_index 'TYPE'",
        "add_repo_payload 'A' lv_payload_index 'MEMBER'",
        "RS_CUA_INTERNAL_FETCH",
        "RS_CUA_INTERNAL_WRITE",
        "object_class = 'SCUA'",
        "transport_key = ls_gui_tr_key",
        "GUI_VERSION_CONFLICT",
        "ev_version = '1.5'",
        "ev_version = '1.6'",
        "ev_version = '1.7'",
        "ev_version = '1.8'",
        "ev_version = '1.9'",
        "ev_version = '2.0'",
        "ev_version = '2.2'",
        "ev_version = '2.3'",
        "ev_version = '2.4'",
        "ev_version = '2.6'",
        "FUNCTION_MODULE_CREATED",
        "REPOSITORY_ASSIGNMENT_READ",
        "ev_version = '1.3'",
        "ev_version = '1.4'",
        "ev_version = '1.2'"
    )) {
    if ($scriptText -notmatch [regex]::Escape($marker)) {
        throw "Repository function source is missing marker: $marker"
    }
}
$customerProgramGuard = $scriptText.IndexOf("IF iv_operation = 'UPSERT_SCREEN'")
$customerProgramGuardEnd = $scriptText.IndexOf("  ENDIF.", $customerProgramGuard)
if ($customerProgramGuard -lt 0 -or $customerProgramGuardEnd -lt 0) {
    throw "Customer program write guard is missing"
}
$customerProgramGuardBody = $scriptText.Substring(
    $customerProgramGuard,
    $customerProgramGuardEnd - $customerProgramGuard
)
if ($customerProgramGuardBody.Contains("READ_SCREEN") -or
    $customerProgramGuardBody.Contains("READ_GUI_DEFINITION")) {
    throw "Standard screen and GUI reads must not be restricted to Z or Y programs"
}
foreach ($marker in @(
        "OR iv_operation = 'PATCH_SCREEN'",
        "OR iv_operation = 'PATCH_GUI_DEFINITION'",
        "OR iv_operation = 'CREATE_MODULE_POOL'",
        "OR iv_operation = 'DELETE_MODULE_POOL'"
    )) {
    if (-not $customerProgramGuardBody.Contains($marker)) {
        throw "Customer program write guard is missing: $marker"
    }
}
$standardReadGuard = $scriptText.IndexOf("IF iv_operation = 'READ_SCREEN'")
$standardReadGuardEnd = $scriptText.IndexOf("  ENDIF.", $standardReadGuard)
if ($standardReadGuard -lt 0 -or $standardReadGuardEnd -lt 0) {
    throw "Standard screen and GUI read input guard is missing"
}
$standardReadGuardBody = $scriptText.Substring(
    $standardReadGuard,
    $standardReadGuardEnd - $standardReadGuard
)
foreach ($marker in @(
        "OR iv_operation = 'READ_GUI_DEFINITION'",
        "IF iv_program IS INITIAL.",
        "ev_code = 'PROGRAM_REQUIRED'."
    )) {
    if (-not $standardReadGuardBody.Contains($marker)) {
        throw "Standard screen and GUI read input guard is missing: $marker"
    }
}
$customerTransactionGuard = $scriptText.IndexOf("IF iv_operation = 'CREATE_TRANSACTION'")
$customerTransactionGuardEnd = $scriptText.IndexOf("  ENDIF.", $customerTransactionGuard)
if ($customerTransactionGuard -lt 0 -or $customerTransactionGuardEnd -lt 0) {
    throw "Customer transaction write guard is missing"
}
$customerTransactionGuardBody = $scriptText.Substring(
    $customerTransactionGuard,
    $customerTransactionGuardEnd - $customerTransactionGuard
)
if ($customerTransactionGuardBody.Contains("READ_TRANSACTION")) {
    throw "Standard transaction reads must not be restricted to Z or Y transactions"
}
foreach ($marker in @(
        "OR iv_operation = 'DELETE_TRANSACTION'",
        "OR iv_operation = 'CREATE_REPORT_TRANSACTION'",
        "ev_code = 'CUSTOMER_TRANSACTION_REQUIRED'."
    )) {
    if (-not $customerTransactionGuardBody.Contains($marker)) {
        throw "Customer transaction write guard is missing: $marker"
    }
}
$standardTransactionGuard = $scriptText.IndexOf("IF iv_operation = 'READ_TRANSACTION'.")
$standardTransactionGuardEnd = $scriptText.IndexOf("  ENDIF.", $standardTransactionGuard)
if ($standardTransactionGuard -lt 0 -or $standardTransactionGuardEnd -lt 0) {
    throw "Standard transaction read input guard is missing"
}
$standardTransactionGuardBody = $scriptText.Substring(
    $standardTransactionGuard,
    $standardTransactionGuardEnd - $standardTransactionGuard
)
foreach ($marker in @(
        "IF iv_transaction IS INITIAL.",
        "ev_code = 'TRANSACTION_REQUIRED'.",
        "ev_version = '1.2'."
    )) {
    if (-not $standardTransactionGuardBody.Contains($marker)) {
        throw "Standard transaction read input guard is missing: $marker"
    }
}
if ($scriptText -match "EXPORTING funcname = iv_object_name") {
    throw "Repository function source passes the generic object-name type to a function lock"
}
if ($scriptText -match "RS_FUNCTION_ACTIVATE") {
    throw "Repository function interface patch must not invoke the dialog-coupled activation API"
}
if ($scriptText -match "RS_WORKING_OBJECT_ACTIVATE") {
    throw "Repository function interface patch must use the direct FUNC activation API"
}
$patchCase = $scriptText.IndexOf("WHEN 'PATCH_FUNCTION_INTERFACE'")
$patchObserved = $scriptText.IndexOf("FUNCTION_ADT_PATCH_NOT_OBSERVED", $patchCase)
$patchDocRead = $scriptText.IndexOf("do_read_docu_r3_new(SAPMS38L)", $patchObserved)
$patchDocUpdate = $scriptText.IndexOf("do_update_docu_r3_new(SAPMS38L)", $patchDocRead)
$patchCommit = $scriptText.IndexOf("COMMIT WORK AND WAIT", $patchDocUpdate)
$patchReadback = $scriptText.IndexOf("CALL FUNCTION 'RPY_FUNCTIONMODULE_READ'", $patchCommit)
if ($patchCase -lt 0 -or $patchObserved -lt 0 -or $patchDocRead -lt 0 -or
    $patchDocUpdate -lt 0 -or $patchCommit -lt 0 -or $patchReadback -lt 0 -or
    $patchObserved -gt $patchDocRead -or $patchDocRead -gt $patchDocUpdate -or
    $patchDocUpdate -gt $patchCommit -or $patchCommit -gt $patchReadback) {
    throw "Function patch must verify ADT structure, update documentation, commit, then re-read"
}
$patchBody = $scriptText.Substring($patchCase, $patchReadback - $patchCase)
$nativeDocMerge = $patchBody.IndexOf("lt_fm_requested_documentation[] = lt_fm_documentation[].")
if ($nativeDocMerge -lt 0) {
    throw "Function patch must merge requested texts into the native post-ADT documentation rows"
}
$nativeDocBody = $patchBody.Substring($nativeDocMerge)
foreach ($marker in @(
    "lt_fm_documentation[] = lt_fm_current_documentation[].",
    "LOOP AT lt_fm_documentation ASSIGNING <ls_fm_documentation>.",
    "WITH KEY parameter = <ls_fm_documentation>-parameter",
    "kind = <ls_fm_documentation>-kind.",
    "DELETE lt_fm_requested_documentation INDEX sy-tabix.",
    "<ls_fm_documentation>-stext = ls_fm_documentation-stext.",
    "IF lt_fm_requested_documentation IS NOT INITIAL.",
    "FUNCTION_PATCH_DOCUMENTATION_MISMATCH"
)) {
    if (-not $nativeDocBody.Contains($marker)) {
        throw "Function patch native documentation merge is missing: $marker"
    }
}
if ($nativeDocBody -match '<ls_fm_documentation>-(index|kind|parameter)\s*=' -or
    $nativeDocBody -match 'SORT lt_fm_documentation') {
    throw "Function patch must preserve native documentation ordering, indices, and identity"
}
if ($patchBody -notmatch [regex]::Escape("lt_fm_source[] = lt_fm_current_source[].")) {
    throw "Function patch must preserve the active post-ADT source during documentation maintenance"
}
if ($patchBody -match [regex]::Escape("APPEND ls_fm_source TO lt_fm_source.")) {
    throw "Function patch must not rebuild active source from the pre-ADT snapshot payload"
}
if ($scriptText -match "CALL FUNCTION 'FUNCTION_SAVE'") {
    throw "Function patch must not invoke the dialog-coupled FUNCTION_SAVE API"
}
foreach ($section in @('IMPORT', 'EXPORT', 'CHANGING', 'TABLES', 'EXCEPTIONS', 'DOCUMENTATION', 'SOURCE')) {
    if (-not $scriptText.Contains("emit_fm_difference '$section'")) {
        throw "Function patch readback diagnostics missing section: $section"
    }
}
foreach ($marker in @(
    "DEFINE emit_fm_difference.",
    "DATA lv_fm_diff_text TYPE c LENGTH 60.",
    "'EXPECTED_ROWS'", "'ACTUAL_ROWS'", "'ROW'", "'FIELD'", "'EXPECTED'", "'ACTUAL'",
    "IF lt_fm_current_import[] <> lt_fm_import[]",
    "OR lt_fm_current_documentation[]",
    "OR lt_fm_current_source[] <> lt_fm_source[]"
)) {
    if (-not $scriptText.Contains($marker)) {
        throw "Function patch must retain strict readback checks and bounded evidence: $marker"
    }
}
foreach ($marker in @(
        "READ TEXTPOOL lv_textpool_program INTO lt_textpool",
        "INSERT TEXTPOOL lv_textpool_program FROM lt_textpool",
        "SELECT SINGLE * FROM t100a INTO ls_message_info",
        "SELECT * FROM t100 INTO TABLE lt_messages",
        "ls_message_tadir_input-object = 'MSAG'",
        "TR_RECORD_OBJ_CHANGE_TO_REQ",
        "INSERT t100a FROM ls_message_info",
        "INSERT t100 FROM TABLE lt_messages",
        "WHEN 'CLAS'",
        "WHILE strlen( lv_textpool_program ) < 30",
        "WHEN 'FUGR'",
        "CONCATENATE 'SAPL' iv_program",
        "SELECT * FROM e071 INTO TABLE lt_transport_objects",
        "ADD 1 TO lv_transport_task_index",
        "add_repo_payload 'F' lv_transport_task_index 'NUMBER'",
        "INSERT REPORT iv_object_name FROM it_source",
        "FUNCTION_INCLUDE_CREATED"
    )) {
    if ($scriptText -notmatch [regex]::Escape($marker)) {
        throw "ECC repository fallback is missing marker: $marker"
    }
}
if ($scriptText -match [regex]::Escape("add_repo_payload 'F' sy-tabix")) {
    throw "Transport task payload rows must use a stable task index"
}
if ($scriptText -notmatch '"InstallDdicApi"' -or
    $scriptText -notmatch '"RepairDdicApi"' -or
    $scriptText -notmatch '"DiagnoseDdicObject"' -or
    $scriptText -notmatch '"DiagnoseRepositoryApi"') {
    throw "DDIC install and repair actions must be available"
}
if ($scriptText -match [regex]::Escape("korrnum = ls_task-trkorr")) {
    throw "RS_CORR_INSERT must receive the parent Workbench request, not a user task"
}
if ($scriptText -match [regex]::Escape("object_class = 'ABAP' mode = 'M'")) {
    throw "GUI status transport recording must use the native SCUA object class"
}
if ($scriptText -match "ls_trdir-utime") {
    throw "ECC 7.31 TRDIR does not expose UTIME"
}
if ($scriptText -match "DATA lv_report_variant TYPE raldb_vari\.") {
    throw "RPY_TRANSACTION_INSERT VARIANT must use the exact TCVARIANT type"
}
if ($scriptText -match "strlen\( <ls_text_change>-id \)" -or
    $scriptText -notmatch [regex]::Escape("<ls_text_change>-id+3 IS NOT INITIAL")) {
    throw "TEXTPOOL keys must validate the three-character prefix instead of the fixed CHAR length"
}
if ($scriptText -match [regex]::Escape("TEXT_TRANSPORT_RECORD_FAILED") -or
    $scriptText -match [regex]::Escape("object_class = 'REPT'")) {
    throw "TEXTPOOL updates must reuse the existing open program assignment without mutating transport metadata"
}

$html = '<!DOCTYPE HTML><html><head><META HTTP-EQUIV="content-type"></head><body>Logon failed for client 200</body></html>'
$htmlError = $null
try {
    ConvertFrom-SapSoapResponse -ResponseBody $html -StatusCode 200 -ContentType "text/html"
}
catch {
    $htmlError = $_.Exception.Message
}
if ($htmlError -notmatch "HTML" -or $htmlError -notmatch "用户名、密码、SAP客户端") {
    throw "HTML response should produce an actionable authentication error: $htmlError"
}
if ($htmlError -match "META.*head") {
    throw "Raw XML parser errors must not leak for HTML responses"
}
if ($htmlError -notmatch "Logon failed for client 200" -or $htmlError -notmatch "响应字节") {
    throw "HTML response errors should include a bounded readable summary: $htmlError"
}

$mislabelledHtml = '<?xml version="1.0"?><head><META HTTP-EQUIV="content-type"></head><body>ICF error</body>'
$mislabelledError = $null
try {
    ConvertFrom-SapSoapResponse -ResponseBody $mislabelledHtml -StatusCode 500 -ContentType "text/xml"
}
catch {
    $mislabelledError = $_.Exception.Message
}
if ($mislabelledError -notmatch "HTML" -or $mislabelledError -notmatch "ICF error") {
    throw "Mislabelled malformed HTML should be diagnosed before XML parsing: $mislabelledError"
}

$soap = '<Envelope><Body><WRITES><item><ZEILE>READY</ZEILE></item></WRITES></Body></Envelope>'
$document = ConvertFrom-SapSoapResponse -ResponseBody $soap -StatusCode 200 -ContentType "text/xml"
if ($document.SelectSingleNode("//ZEILE").InnerText -ne "READY") {
    throw "Valid SOAP XML should remain parseable"
}

# 2026-09-23 r33 第 9 次 F8 实测：CONCATENATE 只接受字符型操作数（C/N/D/T/STRING），把 sy-subrc
# （INT4）或 I 直接当操作数会在 GENERATE 时报「LV_ACTIVATION_SUBRC 必须为字符型数据对象」。行长守卫
# 看不见这一类，因为它只在编译期暴露，而每次暴露的代价是一轮人工 F8。
# 只断言这一条：目标字段同时充当操作数是被允许的——生成器自己的分块累加
# （CONCATENATE lv_source_line '…' INTO lv_source_line RESPECTING BLANKS）就依赖它，且已随多个载体成功编译，
# 因此不得把它写成违规。
$numericTypePattern = '^(?:i|p|f|int8|decfloat16|decfloat34|sy-subrc)$'
# $repositoryFunctionSource 是 New-InstallProgram 的局部变量（不在脚本 EndBlock 里），
# 因此按名字在整个 AST 里找这条赋值语句，再在当前作用域求值取出原始正文。
$repositoryBodyStatement = $ast.FindAll(
    {
        param($node)
        $node -is [Management.Automation.Language.AssignmentStatementAst] -and
            $node.Left.Extent.Text -eq '$repositoryFunctionSource'
    },
    $true
) | Select-Object -First 1
if (-not $repositoryBodyStatement) {
    throw "the repository function body assignment was not found in bootstrap-sap-helper.ps1"
}
Invoke-Expression $repositoryBodyStatement.Extent.Text
if (-not $repositoryFunctionSource -or $repositoryFunctionSource.Count -lt 100) {
    throw "the repository function body did not load: $($repositoryFunctionSource.Count) line(s)"
}
foreach ($guarded in @(
        @{ Name = "Z_ORVANTA_MCP_DDIC_API"; Lines = $ddicFunction },
        @{ Name = "Z_ORVANTA_MCP_EXECUTE/Z_ORVANTA_MCP_DYNPRO_API"; Lines = $repositoryFunctionSource }
    )) {
    $guardedLines = @($guarded.Lines | Where-Object { $null -ne $_ })
    $numericNames = @($guardedLines | ForEach-Object {
            if ($_ -match '^\s*DATA\s+([A-Za-z_][A-Za-z0-9_]*)\s+TYPE\s+([A-Za-z0-9_-]+)\s*\.') {
                # 先取值再匹配类型：内层 -match 会覆盖 $Matches，直接读 $Matches[1] 会拿到空串。
                $declaredName = $Matches[1]
                $declaredType = $Matches[2]
                if ($declaredType.ToLower() -match $numericTypePattern) { $declaredName }
            }
        } | Where-Object { $_ })
    $pendingStatement = ""
    foreach ($line in $guardedLines) {
        $pendingStatement = if ($pendingStatement) { "$pendingStatement $line" } else { $line }
        if (-not $line.TrimEnd().EndsWith(".")) { continue }
        $statement = $pendingStatement.Trim()
        $pendingStatement = ""
        if ($statement -notmatch '^CONCATENATE\b') { continue }
        $intoMatch = [regex]::Match($statement, '\bINTO\s+([A-Za-z_][A-Za-z0-9_]*)')
        if (-not $intoMatch.Success) {
            throw "$($guarded.Name): CONCATENATE without an INTO target: $statement"
        }
        $operands = $statement.Substring(0, $intoMatch.Index)
        foreach ($numericName in $numericNames) {
            if ($operands -match "(?<![A-Za-z0-9_])$([regex]::Escape($numericName))(?![A-Za-z0-9_])") {
                throw "$($guarded.Name): CONCATENATE operand $numericName is numeric and must be converted with WRITE ... TO first: $statement"
            }
        }
    }
}

# 载荷顺序守卫（2026-09-23）。响应载荷写进 it_source，而 it_source 同时也是入参表：读分支必须
# 先 REFRESH it_source 丢掉请求载荷，再发射响应载荷。D7-4 曾把 REFRESH 放在 CSS 分片之后，会把
# 刚写好的正文整段清掉——标记守卫看不见（标记都还在），行长守卫也看不见，只有运行时才暴露，
# 而每次暴露的代价是一轮人工 F8。这里按分支断言顺序：首个载荷发射之前必须有一次 REFRESH。
$payloadEmitterPattern = '\b(?:add_repo_payload|add_repo_component|emit_d7_rows)\b'
foreach ($orderedBranch in @(
        @{ Op = "READ_SAPSCRIPT_FORM"; Code = "SAPSCRIPT_FORM_READ" },
        @{ Op = "READ_SMARTSTYLE"; Code = "SMARTSTYLE_READ" },
        @{ Op = "READ_ADOBE_FORM"; Code = "ADOBE_FORM_READ" },
        # A write branch reuses it_source as its request channel too, so the same invariant holds:
        # clear it before emitting the response payload, or the request leaks into the response.
        @{ Op = "CREATE_TRANSPORT_REQUEST"; Code = "TRANSPORT_REQUEST_CREATED" }
    )) {
    $bodyLines = @($repositoryFunctionSource | Where-Object { $null -ne $_ })
    $branchStart = -1
    for ($index = 0; $index -lt $bodyLines.Count; $index++) {
        if ($bodyLines[$index] -match "WHEN '$($orderedBranch.Op)'") { $branchStart = $index; break }
    }
    if ($branchStart -lt 0) {
        throw "the repository body does not dispatch $($orderedBranch.Op)"
    }
    $branchEnd = -1
    for ($index = $branchStart; $index -lt $bodyLines.Count; $index++) {
        if ($bodyLines[$index] -match "ev_code = '$($orderedBranch.Code)'") { $branchEnd = $index; break }
    }
    if ($branchEnd -lt 0) {
        throw "$($orderedBranch.Op) never reports $($orderedBranch.Code)"
    }
    $firstPayload = -1
    $lastRefreshBeforePayload = -1
    for ($index = $branchStart; $index -le $branchEnd; $index++) {
        $line = $bodyLines[$index]
        if ($firstPayload -lt 0) {
            if ($line -match $payloadEmitterPattern) {
                $firstPayload = $index
                continue
            }
            if ($line -match '^\s*REFRESH\s+it_source\s*\.') { $lastRefreshBeforePayload = $index }
        }
    }
    if ($firstPayload -lt 0) {
        throw "$($orderedBranch.Op) emits no response payload"
    }
    if ($lastRefreshBeforePayload -lt 0) {
        throw "$($orderedBranch.Op) emits response payload without clearing it_source first: the request payload would leak into the response"
    }
}

Write-Host "PASS: bootstrap SOAP response parsing and DDIC generator"
