#require -Version 7.0
<#
.SYNOPSIS
Exports the canonical repository helper body that scripts/bootstrap-sap-helper.ps1 would install.

.DESCRIPTION
The repository helper family (Z_ORVANTA_MCP_EXECUTE / Z_ORVANTA_MCP_DYNPRO_API) lives in the
function group ZORVANTA_MCP_CORE, which is self-write protected: the MCP service may not rewrite its
own helper (a bad write would cost the service the ability to repair itself), so the 2.8 body has to
travel through an in-SAP carrier program that a human runs with F8
(docs/release-process.md section 7). That carrier needs the exact source the bootstrap script would
install, so this script extracts it and writes it as JSON for
scripts/generate-repository-carrier.mjs.

The body is built by New-InstallProgram -FunctionName <name>, which is pure string building: it
contains no SAP call, no filesystem write and no host output. It is not a standalone body builder
like New-DdicFunctionSource, so the definition text is evaluated with one injected statement that
captures the internal $repositoryFunctionSource variable before the function returns. The capture
happens after the function has built the body and before anything could reassign it.

This script is READ-ONLY with respect to SAP. It does not connect, install, activate, deploy or
transport anything; the in-SAP report that carries this body is run by a human with F8.

.PARAMETER FunctionName
The repository function module whose body to export. The two repository helpers share one body
source, parameterised by the function module name in its CAPABILITIES rows, so each one needs its
own extraction (and its own carrier).

.PARAMETER Out
JSON destination. Defaults to <repo>/.cache/repository-<function>-canonical.json, which is
git-ignored because it is a derived artifact that must be regenerated from the script at release time.

.PARAMETER TransportNumber
The transport the capability payload records. GR2K923472 is the authorised D6/T2 carrier request that
holds ZORVANTA_MCP_CORE; it is never released by this script or by the generated report.

.PARAMETER PackageName
Package the capability payload records. Defaults mirror how packaging/windows/install-sap-helper.ps1
invokes the bootstrap script.
#>
[CmdletBinding()]
param(
    [ValidateSet("Z_ORVANTA_MCP_EXECUTE", "Z_ORVANTA_MCP_DYNPRO_API")]
    [string]$FunctionName = "Z_ORVANTA_MCP_EXECUTE",

    [string]$Out = "",

    [string]$TransportNumber = "GR2K923472",
    [string]$TransportTask = "",
    [string]$PackageName = "ZABAP"
)

$ErrorActionPreference = "Stop"

if (-not $Out) {
    $Out = Join-Path $PSScriptRoot "..\.cache\repository-$($FunctionName.ToLower())-canonical.json"
}

$scriptPath = Join-Path $PSScriptRoot "bootstrap-sap-helper.ps1"
if (-not (Test-Path $scriptPath)) { throw "bootstrap script not found: $scriptPath" }

$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $scriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) {
    throw "bootstrap script has $($parseErrors.Count) parse error(s): $($parseErrors[0].Message)"
}

$definition = $ast.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq "New-InstallProgram"
    }, $true)
if (-not $definition) { throw "New-InstallProgram is not defined in $scriptPath" }

# New-InstallProgram reads the bootstrap script's own parameters out of its parent scope
# ($PackageName, $TransportNumber, $TransportTask, ...), so materialise those names with the script's
# declared defaults before calling it, exactly as export-ddic-helper-source.ps1 does.
$paramBlock = $ast.ParamBlock
$requestedPackageName = $PackageName
$requestedTransportNumber = $TransportNumber
$requestedTransportTask = $TransportTask
if ($paramBlock) {
    foreach ($parameter in $paramBlock.Parameters) {
        $parameterName = $parameter.Name.VariablePath.UserPath
        $parameterValue = $null
        if ($parameter.DefaultValue) {
            $parameterValue = Invoke-Expression $parameter.DefaultValue.Extent.Text
        }
        Set-Variable -Name $parameterName -Value $parameterValue -Scope Script
    }
}
$PackageName = $requestedPackageName
$TransportNumber = $requestedTransportNumber
$TransportTask = $requestedTransportTask

# The CAPABILITIES branch interpolates script-level state derived from the marked capability table
# ($helperCapabilityMinVersion / $helperCapabilityMaxVersion). Skipping those assignments would emit
# an empty protocol into the payload, so evaluate every top-level $helper* assignment: they only
# derive values from the table and touch neither SAP nor the filesystem.
$capabilityStatements = 0
foreach ($statement in $ast.EndBlock.Statements) {
    if ($statement -isnot [System.Management.Automation.Language.AssignmentStatementAst]) { continue }
    if ($statement.Left.Extent.Text -notmatch '^\$helper[A-Za-z0-9_]*$') { continue }
    Invoke-Expression $statement.Extent.Text | Out-Null
    $capabilityStatements++
}
if ($capabilityStatements -eq 0) {
    throw "no top-level \$helper* assignment was evaluated; the capability table would be empty"
}
if (-not $helperCapabilityMinVersion -or -not $helperCapabilityMaxVersion) {
    throw "the capability table did not yield a min/max protocol version"
}

# Evaluate the function with one injected statement that captures the internal body variable. The
# injection point is the statement that consumes $repositoryFunctionSource (the `$functionSource = if
# ($usesRepositoryBody)` line), because the function returns before its closing brace and a capture
# placed there would never run. At that point the body is complete and still carries the
# ORVANTAHASHSLOT placeholders - the carrier generator substitutes them itself, exactly like the DDIC
# carrier does.
$definitionText = $definition.Extent.Text
$anchor = '$functionSource = if ($usesRepositoryBody)'
$anchorIndex = $definitionText.IndexOf($anchor)
if ($anchorIndex -lt 0) {
    throw "cannot locate the body consumption point in New-InstallProgram: $anchor"
}
$captured = 'orvantaRepositoryBodyCapture'
$injection = "Set-Variable -Name $captured -Value `$repositoryFunctionSource -Scope Script`n    "
$injectedText = $definitionText.Substring(0, $anchorIndex) + $injection +
$definitionText.Substring($anchorIndex)
Invoke-Expression $injectedText
$output = @(New-InstallProgram -FunctionName $FunctionName)
if ($null -eq $output -and -not (Get-Variable -Name $captured -Scope Script -ErrorAction SilentlyContinue)) {
    throw "New-InstallProgram produced no output; the injection point may have moved"
}
# $repositoryFunctionSource is an array of lines, but reading it through Get-Variable -ValueOnly
# hands the array back as one object: wrap it explicitly (a string value is split instead, so the
# extraction stays correct if the builder ever joins its lines).
$capturedValue = Get-Variable -Name $captured -Scope Script -ValueOnly
$lines = if ($capturedValue -is [string]) {
    @($capturedValue -split "`r?`n")
}
else {
    @($capturedValue)
}
if ($lines.Count -lt 100) { throw "implausibly short body: $($lines.Count) lines" }

# ---- invariants the carrier generator and the in-SAP report both rely on ------------------------
if ($lines[0].Trim() -match '^(FUNCTION|ENDFUNCTION)\b') {
    throw "expected a function body, but the first line is a wrapper: $($lines[0])"
}
if ($lines[-1].Trim() -match '^ENDFUNCTION\.$') {
    throw "the body already ends with ENDFUNCTION.; the wrapper would be duplicated"
}

# SAP transports function-group source in 72-column lines, and the installer's chunker splits every
# line into 20-character chunks while refusing a chunk that is entirely blank.
$overlong = @($lines | Where-Object { $_.Length -gt 72 })
if ($overlong.Count -gt 0) {
    throw "$($overlong.Count) line(s) exceed 72 characters, first: $($overlong[0])"
}
$blankRuns = @()
foreach ($line in $lines) {
    foreach ($match in [regex]::Matches($line, '\s{20,}')) {
        $blankRuns += "$($match.Value.Length) blanks before '$($line.Trim())'"
    }
    if ($line -match '^\s{20,}') { $blankRuns += "leading run: '$line'" }
}
if ($blankRuns.Count -gt 0) {
    throw "the installer's 20-character chunker cannot carry these lines: $($blankRuns[0])"
}

# Open SQL does not accept the ABAP string operator CP: a WHERE clause needs LIKE.
$sqlOpen = $false
$sqlOperatorErrors = @()
for ($i = 0; $i -lt $lines.Count; $i++) {
    $code = ($lines[$i] -replace "'[^']*'", "''").Trim()
    if (-not $sqlOpen -and $code -match '^(SELECT|DELETE\s+FROM|UPDATE|INSERT\s+INTO|MODIFY)\b') {
        $sqlOpen = $true
    }
    if ($sqlOpen -and $code -match '\bCP\b') {
        $sqlOperatorErrors += "line $($i + 1): $($lines[$i].Trim())"
    }
    if ($sqlOpen -and $code -match '\.$') { $sqlOpen = $false }
}
if ($sqlOperatorErrors.Count -gt 0) {
    throw "Open SQL cannot use CP (use LIKE): $($sqlOperatorErrors[0])"
}

# ---- canonical parameter interface --------------------------------------------------------------
# The 2.8 repository body uses parameters the 2.7 interface does not declare (IV_TEXT_STATUS and
# friends), so the carrier cannot only replace the body: it has to extend the function module's
# parameter interface first. That extension is expressed as the same installer statements the
# bootstrap script itself uses (`ls_import-parameter` / `ls_export-parameter` / `ls_tables-parameter`
# rows), which the generator turns into a merge against the live interface.
#
# The blocks are read from the script text rather than from a second injected capture: the statement
# that consumes them is one array literal spanning several hundred kilobytes, and PowerShell's AST does
# not report a containing statement for that region (only the whole function matches), so there is no
# reliable statement boundary to inject in front of. The blocks themselves are pure literal string
# arrays, and the shape of every extracted line is asserted below.
function Get-InterfaceBlockLines {
    param([string]$Text, [string]$Variable)
    $pattern = "\`$$Variable\s*=\s*if\s*\(\`$usesRepositoryBody\)\s*\{"
    $match = [regex]::Match($Text, $pattern)
    if (-not $match.Success) { throw "interface block not found in the bootstrap script: `$$Variable" }
    $index = $match.Index + $match.Length
    $depth = 1
    $end = $index
    while ($end -lt $Text.Length -and $depth -gt 0) {
        $character = $Text[$end]
        if ($character -eq '{') { $depth++ }
        elseif ($character -eq '}') { $depth-- }
        $end++
    }
    if ($depth -ne 0) { throw "unbalanced braces in `$$Variable" }
    $block = $Text.Substring($index, $end - $index - 1)
    $blockLines = @([regex]::Matches($block, '"([^"]*)"') | ForEach-Object { $_.Groups[1].Value })
    if ($blockLines.Count -eq 0) { throw "`$$Variable declares no statement" }
    foreach ($blockLine in $blockLines) {
        if ($blockLine -notmatch "^(CLEAR ls_(import|export|tables)\.|ls_(import|export|tables)-[a-z]+ = '[^']*'\.|APPEND ls_(import|export|tables) TO lt_(import|export|tables)\.)$") {
            throw "unexpected interface statement in `$$Variable`: $blockLine"
        }
        if ($blockLine.Contains('$')) {
            throw "interface statement contains a PowerShell variable and would not survive extraction: $blockLine"
        }
    }
    return $blockLines
}

# The 2.7 interface the body was written against is declared as a literal array in front of the
# repository extension block. A carrier that has to create the function module from scratch needs it:
# without IV_OPERATION the body cannot be generated at all. The installed helper concatenates it
# before $repositoryInterfaceImportLines, so the canonical keeps that order.
function Get-BaseImportBlockLines {
    param([string]$Text)
    $start = [regex]::Match($Text, '\$existingObjectLines\s*\+\s*@\(')
    if (-not $start.Success) { throw "base import block not found in the bootstrap script" }
    $from = $start.Index + $start.Length
    $stop = [regex]::Match($Text.Substring($from), '\)\s*\+\s*\$repositoryInterfaceImportLines')
    if (-not $stop.Success) { throw "base import block end not found in the bootstrap script" }
    $block = $Text.Substring($from, $stop.Index)
    $blockLines = @([regex]::Matches($block, '"([^"]*)"') | ForEach-Object { $_.Groups[1].Value })
    if ($blockLines.Count -eq 0) { throw "the base import block declares no statement" }
    $blockLines = @($blockLines | ForEach-Object { $_.Replace('$operationDbField', 'RS38L-NAME') })
    # The installer block closes every parameter with CLEAR, while the generator expects CLEAR to open
    # one. Normalise to the generator's shape so both blocks concatenate without a doubled CLEAR.
    while ($blockLines.Count -gt 0 -and $blockLines[-1] -eq 'CLEAR ls_import.') {
        $blockLines = @($blockLines[0..($blockLines.Count - 2)])
    }
    $blockLines = @('CLEAR ls_import.') + $blockLines
    foreach ($blockLine in $blockLines) {
        if ($blockLine -notmatch "^(CLEAR ls_import\.|ls_import-[a-z]+ = '[^']*'\.|APPEND ls_import TO lt_import\.)$") {
            throw "unexpected base interface statement: $blockLine"
        }
        if ($blockLine.Contains('$')) {
            throw "base interface statement still contains a PowerShell variable: $blockLine"
        }
    }
    return $blockLines
}

# The base export and table parameters sit in one literal block behind $repositoryInterfaceExportLines.
# They belong to the shared body just like the base imports, so the canonical needs them too.
function Get-BaseTailBlockLines {
    param([string]$Text)
    $start = [regex]::Match($Text, '\$repositoryInterfaceExportLines\s*\+\s*@\(')
    if (-not $start.Success) { throw "base export block not found in the bootstrap script" }
    $from = $start.Index + $start.Length
    $stop = [regex]::Match($Text.Substring($from), '\)\s*\+\s*\$repositoryInterfaceTableLines')
    if (-not $stop.Success) { throw "base export block end not found in the bootstrap script" }
    $block = $Text.Substring($from, $stop.Index)
    $blockLines = @([regex]::Matches($block, '"([^"]*)"') | ForEach-Object { $_.Groups[1].Value })
    if ($blockLines.Count -eq 0) { throw "the base export block declares no statement" }
    foreach ($blockLine in $blockLines) {
        if ($blockLine -notmatch "^(CLEAR ls_(export|tables)\.|ls_(export|tables)-[a-z]+ = '[^']*'\.|APPEND ls_(export|tables) TO lt_(export|tables)\.)$") {
            throw "unexpected base export statement: $blockLine"
        }
        if ($blockLine.Contains('$')) {
            throw "base export statement still contains a PowerShell variable: $blockLine"
        }
    }
    return $blockLines
}

# The installer concatenates one more import block between the repository extension and the base
# export parameters: $ddicImportLines, which declares IV_EXPECTED_VERSION for every helper (the DDIC
# body patches DDIC objects with it, the shared repository body uses it for optimistic concurrency).
# Leaving it out of the canonical made the carrier install a 56-parameter interface that its own
# body could not compile against -- GENERATE failed with "The field IV_EXPECTED_VERSION is unknown"
# even though the installed interface matched the canonical exactly. The live interface is the base
# and the carrier appends only what is missing, so a parameter absent from the canonical can never
# be added; the canonical has to carry every block the installer concatenates.
function Get-DdicImportBlockLines {
    param([string]$Text)
    $match = [regex]::Match(
        $Text, '(?s)\$ddicImportLines\s*=\s*@\((.*?)\)\s*\r?\n\s*\$sourceProgramLines')
    if (-not $match.Success) { throw "ddic import block not found in the bootstrap script" }
    $blockLines = @([regex]::Matches($match.Groups[1].Value, '"([^"]*)"') |
        ForEach-Object { $_.Groups[1].Value })
    if ($blockLines.Count -eq 0) { throw "the ddic import block declares no statement" }
    foreach ($blockLine in $blockLines) {
        if ($blockLine -notmatch "^(CLEAR ls_import\.|ls_import-[a-z]+ = '[^']*'\.|APPEND ls_import TO lt_import\.)$") {
            throw "unexpected ddic interface statement: $blockLine"
        }
        if ($blockLine.Contains('$')) {
            throw "ddic interface statement contains a PowerShell variable and would not survive extraction: $blockLine"
        }
    }
    return $blockLines
}

function Group-InterfaceBlockLines {
    param([string[]]$Lines, [string]$Kind)
    $grouped = @()
    $current = @()
    foreach ($line in $Lines) {
        if ($line -match "^CLEAR ls_$Kind\." -and $current.Count -gt 0) { continue }
        if ($line -match "^ls_$Kind-") { $current += $line }
        elseif ($line -match "^APPEND ls_$Kind TO ") { $current += $line; $grouped += , $current; $current = @() }
    }
    $result = @()
    foreach ($group in $grouped) { $result += @("CLEAR ls_$Kind.") + $group }
    return $result
}

$scriptText = Get-Content $scriptPath -Raw
$baseImportLines = @(Get-BaseImportBlockLines -Text $scriptText)
$baseTailLines = @(Get-BaseTailBlockLines -Text $scriptText)
$baseExportLines = @(Group-InterfaceBlockLines -Lines @($baseTailLines | Where-Object { $_ -match '^ls_export-|^APPEND ls_export |^CLEAR ls_export\.' }) -Kind 'export')
$baseTableLines = @(Group-InterfaceBlockLines -Lines @($baseTailLines | Where-Object { $_ -match '^ls_tables-|^APPEND ls_tables |^CLEAR ls_tables\.' }) -Kind 'tables')
$importLines = $baseImportLines +
    @(Get-InterfaceBlockLines -Text $scriptText -Variable 'repositoryInterfaceImportLines') +
    @(Get-DdicImportBlockLines -Text $scriptText)
$exportLines = $baseExportLines + @(Get-InterfaceBlockLines -Text $scriptText -Variable 'repositoryInterfaceExportLines')
$tableLines = $baseTableLines + @(Get-InterfaceBlockLines -Text $scriptText -Variable 'repositoryInterfaceTableLines')
if (($importLines.Count + $exportLines.Count + $tableLines.Count) -eq 0) {
    throw "the repository interface declared no parameter; the body cannot be deployed without it"
}
$interfaceParameters = @(
    @($importLines + $exportLines + $tableLines) |
    ForEach-Object { [regex]::Match($_, "-parameter\s*=\s*'([A-Z0-9_]+)'") } |
    Where-Object { $_.Success } | ForEach-Object { $_.Groups[1].Value }
)
if ($interfaceParameters.Count -eq 0) {
    throw "the repository interface lines declare no named parameter"
}
$duplicateParameters = @($interfaceParameters | Group-Object | Where-Object { $_.Count -gt 1 })
if ($duplicateParameters.Count -gt 0) {
    throw "the repository interface declares $($duplicateParameters[0].Name) more than once"
}
foreach ($interfaceLine in @($importLines + $exportLines + $tableLines)) {
    if ($interfaceLine.Length -gt 72) {
        throw "interface line exceeds 72 characters: $interfaceLine"
    }
}

# ---- capability table: the script's own declaration is the expectation -------------------------
$raw = Get-Content $scriptPath -Raw
$tableMatch = [regex]::Match(
    $raw, '(?s)>>> ORVANTA-CAPABILITY-TABLE(.*?)<<< ORVANTA-CAPABILITY-TABLE')
if (-not $tableMatch.Success) { throw "ORVANTA-CAPABILITY-TABLE block not found" }
$operations = @(
    [regex]::Matches($tableMatch.Groups[1].Value, '"([A-Z0-9_]+)\|(\d+\.\d+)\|([RW])"') |
    ForEach-Object {
        [pscustomobject]@{
            opcode  = $_.Groups[1].Value
            version = $_.Groups[2].Value
            access  = $_.Groups[3].Value
        }
    }
)
if ($operations.Count -eq 0) { throw "the repository capability table declares no operation" }
$declaredMax = ($operations | ForEach-Object { [version]$_.version } |
    Sort-Object | Select-Object -Last 1).ToString()

$body = $lines -join "`n"
if ($body -notmatch [regex]::Escape("PROTOCOL|MAX|$declaredMax")) {
    throw "the body does not publish PROTOCOL|MAX|$declaredMax, which the capability table implies"
}
if ($body -notmatch [regex]::Escape("HELPER|$FunctionName")) {
    throw "the body does not self-describe as HELPER|$FunctionName"
}
# Every declared operation must be both published and dispatched: a declared-but-unreachable opcode
# is exactly the failure mode the carrier exists to fix.
$undeclared = @()
foreach ($operation in $operations) {
    if ($body -notmatch [regex]::Escape("OPERATION|$($operation.opcode)")) {
        $undeclared += "$($operation.opcode) (no capability row)"
        continue
    }
    # A single-opcode scan would miss the operations the repository CASE serves through shared
    # clauses: a multi-opcode `WHEN 'X' OR 'Y'.` or a WHEN continued on the next line, which is how
    # UPDATE_BADI_ENHANCEMENT is dispatched (bootstrap script line 7604: `  OR 'UPDATE_BADI_...'.`).
    # The capability table lists those explicitly for the same reason, so accept a WHEN or an OR
    # continuation clause that names the opcode instead of requiring a dedicated arm.
    if ($body -notmatch "(WHEN|OR)\s+'$([regex]::Escape($operation.opcode))'") {
        $undeclared += "$($operation.opcode) (no CASE arm)"
    }
}
if ($undeclared.Count -gt 0) {
    throw "the body does not implement $($undeclared.Count) declared operation(s): $($undeclared[0])"
}
# The write paths this carrier delivers must be implemented, not only advertised.
foreach ($call in @("TR_INSERT_REQUEST_WITH_TASKS", "TRINT_OBJECTS_CHECK_AND_INSERT")) {
    if ($body -notmatch [regex]::Escape("'$call'")) {
        throw "the body no longer calls $call, so a declared transport write path has no implementation"
    }
}

$sha = (Get-FileHash -InputStream ([System.IO.MemoryStream]::new(
            [System.Text.Encoding]::UTF8.GetBytes($body))) -Algorithm SHA256).Hash.ToLower()

$document = [pscustomobject]@{
    helper                = $FunctionName
    functionGroup         = "ZORVANTA_MCP_CORE"
    package               = $PackageName
    transport             = $TransportNumber
    transportTask         = $TransportTask
    declaredMaxProtocol   = $declaredMax
    declaredOperations    = @($operations | ForEach-Object { $_.opcode })
    declaredOperationRows = @($operations)
    lineCount             = $lines.Count
    sourceSha256          = $sha
    bootstrapScript       = "scripts/bootstrap-sap-helper.ps1"
    interfaceLines        = [pscustomobject]@{
        import     = $importLines
        export     = $exportLines
        tables     = $tableLines
        parameters = $interfaceParameters
    }
    lines                 = $lines
}

$directory = Split-Path -Parent $Out
if ($directory -and -not (Test-Path $directory)) { New-Item -ItemType Directory -Path $directory | Out-Null }
Set-Content -Path $Out -Value ($document | ConvertTo-Json -Depth 5) -Encoding utf8

Write-Host "canonical repository helper body exported"
Write-Host "  helper     : $FunctionName"
Write-Host "  lines      : $($lines.Count)"
Write-Host "  sha256     : $sha"
Write-Host "  maxProtocol: $declaredMax"
Write-Host "  operations : $($operations.Count)"
Write-Host "  interface  : $($interfaceParameters.Count) parameter(s) - $($importLines.Count) import /" `
    "$($exportLines.Count) export / $($tableLines.Count) tables statement(s)"
Write-Host "  written to : $Out"
Write-Host "  no SAP connection, no install, no deploy: run the generated in-SAP report yourself (F8)"
