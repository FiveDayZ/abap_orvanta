#require -Version 7.0
<#
.SYNOPSIS
Exports the canonical DDIC helper body that scripts/bootstrap-sap-helper.ps1 would install.

.DESCRIPTION
Carrier #2 (D6-2B) has to put the helper's *canonical* source into SAP, because the deployed
1.10 carrier was assembled from an older body and therefore lacks UPSERT_LOCK_OBJECT and
DELETE_LOCK_OBJECT even though the bootstrap script has implemented both for a while. The
bootstrap script is the single source of truth for that body, so this script extracts it with the
PowerShell AST (calling New-DdicFunctionSource, which only builds strings - it never touches the
network, SAP, or the filesystem) and writes it as JSON for
scripts/generate-ddic-lock-carrier.mjs.

This script is READ-ONLY with respect to SAP. It does not connect, install, activate, deploy or
transport anything; the in-SAP report that carries this body is run by a human with F8.

.PARAMETER Out
JSON destination. Defaults to <repo>/.cache/ddic-helper-canonical.json, which is git-ignored
because it is a derived artifact that must be regenerated from the script at release time.
#>
[CmdletBinding()]
param(
    [string]$Out = (Join-Path $PSScriptRoot "..\.cache\ddic-helper-canonical.json"),

    # The capability payload records the package and the transport it was installed under, so the
    # extracted body depends on these inputs. Defaults mirror how packaging/windows/install-sap-helper.ps1
    # invokes the bootstrap script: it passes only -TransportNumber (GR2K923472 is the D6/T2 carrier)
    # and leaves -PackageName at its default. A different value here produces a different body, which
    # the carrier generator detects by comparing the self-description rows with the live helper.
    [string]$TransportNumber = "GR2K923472",
    [string]$TransportTask = "",
    [string]$PackageName = "ZABAP"
)

$ErrorActionPreference = "Stop"

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
        $node.Name -eq "New-DdicFunctionSource"
    }, $true)
if (-not $definition) { throw "New-DdicFunctionSource is not defined in $scriptPath" }

# New-DdicFunctionSource reads the bootstrap script's own parameters out of its parent scope
# ($PackageName, $TransportNumber, $TransportTask, ...), so materialise those names with the
# script's declared defaults before calling it. Only literal defaults are evaluated, and only the
# three inputs that shape the capability payload are overridden from this script's parameters.
$paramBlock = $ast.ParamBlock
# The loop below overwrites these names with the bootstrap script's own defaults (TransportNumber and
# TransportTask have none), so remember what this script was asked for first.
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

# The capability branch also interpolates script-level state that is computed from the marked table
# ($ddicCapabilityMinVersion / $ddicCapabilityMaxVersion). Skipping it would silently emit an empty
# version into the payload, so evaluate every top-level $ddic* assignment - those statements only
# derive values from the table and touch neither SAP nor the filesystem.
$capabilityStatements = 0
foreach ($statement in $ast.EndBlock.Statements) {
    if ($statement -isnot [System.Management.Automation.Language.AssignmentStatementAst]) { continue }
    if ($statement.Left.Extent.Text -notmatch '^\$ddic[A-Za-z0-9_]*$') { continue }
    Invoke-Expression $statement.Extent.Text | Out-Null
    $capabilityStatements++
}
if ($capabilityStatements -eq 0) {
    throw "no top-level \$ddic* assignment was evaluated; the capability table would be empty"
}
if (-not $ddicCapabilityMinVersion -or -not $ddicCapabilityMaxVersion) {
    throw "the capability table did not yield a min/max protocol version"
}

# Only the function definition is evaluated: no script body, no parameter binding, no side effects.
Invoke-Expression $definition.Extent.Text
$lines = @(New-DdicFunctionSource)
if ($lines.Count -lt 100) { throw "implausibly short body: $($lines.Count) lines" }

# ---- invariants the carrier generator and the in-SAP report both rely on ------------------------
# New-DdicFunctionSource returns the function BODY; the FUNCTION/ENDFUNCTION wrapper is added when
# the installer builds the include payload. Carrier #2 reuses the wrapper spelling it reads live, so
# the body must be a body: assert that instead of asserting a header it does not have.
if ($lines[0].Trim() -match '^(FUNCTION|ENDFUNCTION)\b') {
    throw "expected a function body, but the first line is a wrapper: $($lines[0])"
}
if ($lines[-1].Trim() -match '^ENDFUNCTION\.$') {
    throw "the body already ends with ENDFUNCTION.; the wrapper would be duplicated"
}

# SAP transports function-group source in 72-column lines, and the installer's chunker splits every
# line into 20-character chunks while refusing a chunk that is entirely blank. Both rules are
# enforced here so an over-long or deeply indented line cannot reach the report.
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

# ---- capability table: the script's own declaration is the expectation -------------------------
$raw = Get-Content $scriptPath -Raw
$tableMatch = [regex]::Match(
    $raw, '(?s)>>> ORVANTA-DDIC-CAPABILITY-TABLE(.*?)<<< ORVANTA-DDIC-CAPABILITY-TABLE')
if (-not $tableMatch.Success) { throw "ORVANTA-DDIC-CAPABILITY-TABLE block not found" }
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
if ($operations.Count -eq 0) { throw "the DDIC capability table declares no operation" }
$declaredMax = ($operations | ForEach-Object { [version]$_.version } |
    Sort-Object | Select-Object -Last 1).ToString()

$body = $lines -join "`n"
if ($body -notmatch [regex]::Escape("PROTOCOL|MAX|$declaredMax")) {
    throw "the body does not publish PROTOCOL|MAX|$declaredMax, which the capability table implies"
}
foreach ($opcode in @("READ_LOCK_OBJECT", "UPSERT_LOCK_OBJECT", "DELETE_LOCK_OBJECT")) {
    if ($body -notmatch [regex]::Escape("OPERATION|$opcode")) {
        throw "the body no longer publishes a capability row for $opcode"
    }
    if ($body -notmatch [regex]::Escape("WHEN '$opcode'")) {
        throw "the body no longer dispatches $opcode"
    }
}
# The two write paths carrier #2 exists to deliver must be complete, not just declared.
foreach ($call in @("DDIF_ENQU_PUT", "DDIF_ENQU_ACTIVATE", "DDIF_OBJECT_DELETE")) {
    if ($body -notmatch [regex]::Escape("'$call'")) {
        throw "the body no longer calls $call, so a declared write path would have no implementation"
    }
}

$sha = (Get-FileHash -InputStream ([System.IO.MemoryStream]::new(
            [System.Text.Encoding]::UTF8.GetBytes($body))) -Algorithm SHA256).Hash.ToLower()

$document = [pscustomobject]@{
    helper               = "Z_ORVANTA_MCP_DDIC_API"
    functionGroup        = "ZORVANTA_MCP_CORE"
    package              = $PackageName
    transport            = $TransportNumber
    transportTask        = $TransportTask
    declaredMaxProtocol  = $declaredMax
    declaredOperations   = @($operations | ForEach-Object { $_.opcode })
    declaredOperationRows = @($operations)
    lineCount            = $lines.Count
    sourceSha256         = $sha
    bootstrapScript      = "scripts/bootstrap-sap-helper.ps1"
    lines                = $lines
}

$directory = Split-Path -Parent $Out
if ($directory -and -not (Test-Path $directory)) { New-Item -ItemType Directory -Path $directory | Out-Null }
Set-Content -Path $Out -Value ($document | ConvertTo-Json -Depth 5) -Encoding utf8

Write-Host "canonical DDIC helper body exported"
Write-Host "  lines      : $($lines.Count)"
Write-Host "  sha256     : $sha"
Write-Host "  maxProtocol: $declaredMax"
Write-Host "  operations : $($operations.Count) ($($operations.opcode -join ', '))"
Write-Host "  written to : $Out"
Write-Host "  no SAP connection, no install, no deploy: run the generated in-SAP report yourself (F8)"
