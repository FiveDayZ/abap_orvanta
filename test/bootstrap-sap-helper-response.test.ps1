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
$helperDiagnosticProgram = New-HelperApiDiagnosticProgram
$longHelperDiagnosticLine = $helperDiagnosticProgram | Where-Object { $_.Length -gt 72 } | Select-Object -First 1
if ($longHelperDiagnosticLine) {
    throw "Helper diagnostic line exceeds 72 characters: $longHelperDiagnosticLine"
}
foreach ($marker in @("Z_CODEX_MCP_EXECUTE", "Z_CODEX_MCP_DYNPRO_API", "Z_CODEX_MCP_DDIC_API", "enlfdir-active")) {
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
$ddicProgram = New-InstallProgram -FunctionName "Z_CODEX_MCP_DDIC_API"
$longDdicLine = $ddicProgram | Where-Object { $_.Length -gt 72 } | Select-Object -First 1
if ($longDdicLine) {
    throw "DDIC bootstrap line exceeds 72 characters: $longDdicLine"
}
foreach ($marker in @(
        "IV_EXPECTED_VERSION",
        "ls_import-dbfield = 'BAPIRET2-PARAMETER'",
        "Z_CODEX_MCP_DDIC_API",
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
        "DELETE_TRANSPARENT_TABLE",
        "UNSAFE_TABLE_CHANGE",
        "MANDT_CHANGE_FORBIDDEN",
        "KEY_ORDER_INVALID",
        "DUPLICATE_FIELD",
        "FIELD_ALREADY_EXISTS",
        "COMPLEX_TABLE_UNSUPPORTED",
        "Tables with includes or appends are unsupported",
        "SELECT COUNT(*) FROM dd02l INTO lv_append_count",
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
        "use_korrnum_immediatedly"
    )) {
    if (-not (($ddicProgram + $ddicFunction) -match [regex]::Escape($marker))) {
        throw "DDIC bootstrap is missing marker: $marker"
    }
}
$ddicFunctionText = $ddicFunction -join "`n"
if ($ddicFunctionText -notmatch "LOOP AT lt_dd03p ASSIGNING <ls_field>\.\r?\n\s+IF lv_append IS INITIAL AND lv_patch IS INITIAL\.\r?\n\s+<ls_field>-tabname = iv_object_name\.[\s\S]*?<ls_field>-comptype = 'E'\.") {
    throw "DDIC append must not rewrite existing field component metadata"
}
if (-not ($ddicFunction -match "ev_version = '1.6'")) {
    throw "DDIC helper 1.6 marker is missing"
}
if (-not ($ddicFunction -match "dd01v_wa = ls_current_dd01v")) {
    throw "DDIC bootstrap must keep the active domain separate from the requested definition"
}
$repositoryProgram = New-InstallProgram -FunctionName "Z_CODEX_MCP_DYNPRO_API"
$longRepositoryLine = $repositoryProgram | Where-Object { $_.Length -gt 72 } | Select-Object -First 1
if ($longRepositoryLine) {
    throw "Repository bootstrap line exceeds 72 characters: $longRepositoryLine"
}
$scriptText = Get-Content -Raw $scriptPath
foreach ($marker in @("Z_CODEX_MCP_DYNPRO_API", "FUNCTION_CREATE")) {
    if (-not ($repositoryProgram -match [regex]::Escape($marker))) {
        throw "Generated repository bootstrap is missing marker: $marker"
    }
}
if (-not ($repositoryProgram -match "FUNCTION_ACTIVATION_FLAG_ERROR")) {
    throw "Generated repository bootstrap must persist the active function flag"
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
        "INSPECT_REPOSITORY_ASSIGNMENT",
        "lv_transport_object = 'CLAS'",
        "lv_transport_object = 'INTF'",
        "READ_GUI_DEFINITION",
        "PATCH_GUI_DEFINITION",
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

Write-Host "PASS: bootstrap SOAP response parsing and DDIC generator"
