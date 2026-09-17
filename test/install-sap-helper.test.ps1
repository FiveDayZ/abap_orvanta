#requires -Version 7.0

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $projectRoot "packaging\windows\install-sap-helper.ps1"
$testRoot = Join-Path $env:TEMP ("abap-mcp-installer-" + [guid]::NewGuid())
$fakeRoot = Join-Path $testRoot "app\scripts"
$fakeBootstrap = Join-Path $fakeRoot "bootstrap-sap-helper.ps1"
$configPath = Join-Path $testRoot "connections.json"
$actionLog = Join-Path $testRoot "actions.log"
$password = ConvertTo-SecureString "validation-only" -AsPlainText -Force

function Assert-Throws {
    param([scriptblock]$Action, [string]$Pattern)

    try {
        & $Action
    } catch {
        if ($_.Exception.Message -notmatch $Pattern) {
            throw "Expected '$Pattern', received '$($_.Exception.Message)'"
        }
        return
    }
    throw "Expected an exception matching '$Pattern'."
}

function Get-Actions {
    if (-not (Test-Path -LiteralPath $actionLog)) {
        return @()
    }
    return @(Get-Content -LiteralPath $actionLog)
}

New-Item -ItemType Directory -Force -Path $fakeRoot | Out-Null
@'
param(
    [string]$BaseUrl,
    [string]$Username,
    [string]$Client,
    [string]$Language,
    [string]$Action,
    [string]$TransportNumber,
    [Security.SecureString]$SecurePassword,
    [switch]$AllowUnauthorized,
    [switch]$PassThru
)
if (-not $SecurePassword -or $SecurePassword.Length -eq 0 -or -not $PassThru) {
    throw "Secure pass-through contract was not used."
}
Add-Content -LiteralPath $env:ABAP_MCP_INSTALLER_ACTION_LOG -Value "$Action|$TransportNumber"
$ready = $env:ABAP_MCP_INSTALLER_HELPERS_READY -ne "0"
$writes = switch ($Action) {
    "DiagnoseHelperApis" {
        if ($ready) {
            @(
                "HELPER Z_ORVANTA_MCP_EXECUTE EXISTS 0",
                "STATE Z_ORVANTA_MCP_EXECUTE X",
                "HELPER Z_ORVANTA_MCP_DYNPRO_API EXISTS 0",
                "STATE Z_ORVANTA_MCP_DYNPRO_API X X",
                "HELPER Z_ORVANTA_MCP_DDIC_API EXISTS 0",
                "STATE Z_ORVANTA_MCP_DDIC_API X"
            )
        } else {
            @(
                "HELPER Z_ORVANTA_MCP_EXECUTE EXISTS 0",
                "STATE Z_ORVANTA_MCP_EXECUTE X X",
                "HELPER Z_ORVANTA_MCP_DYNPRO_API EXISTS 1",
                "HELPER Z_ORVANTA_MCP_DDIC_API EXISTS 1"
            )
        }
    }
    "DiagnoseFunctionGroup" { @("SUBRC     0") }
    "InspectAssignment" {
        @(
            "REQUEST $TransportNumber VALIDATION D K",
            "TASK GR2K923473 VALIDATION D S"
        )
    }
    "AssignPackageTransport" {
        @(
            "ASSIGNMENT_OK PACKAGE ZABAP",
            "REQUEST $TransportNumber",
            "TASK GR2K923473"
        )
    }
    default { @("COMPLETED $Action") }
}
[pscustomobject]@{
    Action = $Action
    Status = 200
    SoapFault = ""
    ErrorMessage = ""
    Writes = $writes
    BootstrapExitCode = 0
}
'@ | Set-Content -LiteralPath $fakeBootstrap -Encoding utf8

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
$config = @{
    connections = @(
        @{
            id = "W200"
            url = "http://127.0.0.1:$port"
            client = "200"
            language = "EN"
            username = "VALIDATION"
            passwordEnv = "ABAP_MCP_W200_PASSWORD"
            allowUnauthorized = $false
            remoteFunctionAllowlist = @()
        }
    )
}
$config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath -Encoding utf8
$env:ABAP_MCP_INSTALLER_ACTION_LOG = $actionLog

try {
    $tokens = $null
    $errors = $null
    [Management.Automation.Language.Parser]::ParseFile(
        $installer,
        [ref]$tokens,
        [ref]$errors
    ) | Out-Null
    if ($errors.Count -gt 0) {
        throw "install-sap-helper.ps1 has parser errors: $($errors -join '; ')"
    }
    $source = Get-Content -Raw -LiteralPath $installer
    if (-not $source.StartsWith("#requires -Version 7.0")) {
        throw "Installer must require PowerShell 7."
    }
    if ($source -match "powershell\.exe" -or $source -notmatch "Read-Host.+-AsSecureString") {
        throw "Installer must use the PowerShell 7 secure prompt contract."
    }

    $env:ABAP_MCP_INSTALLER_HELPERS_READY = "1"
    Remove-Item -LiteralPath $actionLog -Force -ErrorAction SilentlyContinue
    $preflightRaw = @(& $installer -Mode preflight -ConnectionId w200 -ConfigPath $configPath -BootstrapScriptPath $fakeBootstrap -SecurePassword $password)
    if ($preflightRaw.Count -ne 1) {
        throw "Preflight returned unexpected output: $($preflightRaw -join ' | ')"
    }
    $preflight = $preflightRaw[0] | ConvertFrom-Json
    if (-not $preflight.status.ready -or $preflight.mode -ne "preflight") {
        throw "Controlled preflight did not report a ready helper state."
    }
    $expectedVersion = (Get-Content -Raw (Join-Path $projectRoot "package.json") | ConvertFrom-Json).version
    if ($preflight.productVersion -ne $expectedVersion) {
        throw "Installer version mismatch: expected $expectedVersion, received $($preflight.productVersion)"
    }
    if ($preflight.status.helpers[0].activeFlag -or -not $preflight.status.helpers[0].generated) {
        throw "Legacy blank ACTIVE must remain informational when GENERATED is X."
    }
    if ((Get-Actions) -join "," -ne "DiagnoseHelperApis|,DiagnoseFunctionGroup|") {
        throw "Preflight invoked an unexpected action sequence."
    }

    $env:ABAP_MCP_INSTALLER_HELPERS_READY = "0"
    $status = & $installer -Mode status -ConnectionId w200 -ConfigPath $configPath -BootstrapScriptPath $fakeBootstrap -SecurePassword $password | ConvertFrom-Json
    if ($status.status.ready) {
        throw "Status mode must report missing helpers without claiming readiness."
    }
    Assert-Throws {
        & $installer -Mode preflight -ConnectionId w200 -ConfigPath $configPath -BootstrapScriptPath $fakeBootstrap -SecurePassword $password
    } "preflight failed"

    $env:ABAP_MCP_INSTALLER_HELPERS_READY = "1"
    $expectedModes = @{
        install = "Install|,InstallRepositoryApi|,InstallDdicApi|,DiagnoseHelperApis|,DiagnoseFunctionGroup|"
        upgrade = "Install|,RepairRepositoryApi|,RepairDdicApi|,DiagnoseHelperApis|,DiagnoseFunctionGroup|"
        repair = "RepairInterface|,RepairRepositoryApi|,RepairDdicApi|,DiagnoseHelperApis|,DiagnoseFunctionGroup|"
    }

    Remove-Item -LiteralPath $actionLog -Force -ErrorAction SilentlyContinue
    $transportUpgrade = & $installer -Mode upgrade -ConnectionId w200 -TransportNumber GR2K923472 -ConfigPath $configPath -BootstrapScriptPath $fakeBootstrap -SecurePassword $password | ConvertFrom-Json
    if (-not $transportUpgrade.status.ready) {
        throw "Transport-aware upgrade did not finish with a ready helper state."
    }
    $expectedTransportActions = @(
        "InspectAssignment|GR2K923472",
        "AssignPackageTransport|GR2K923472",
        "Install|GR2K923472",
        "RepairRepositoryApi|GR2K923472",
        "RepairDdicApi|GR2K923472",
        "DiagnoseHelperApis|GR2K923472",
        "DiagnoseFunctionGroup|GR2K923472"
    ) -join ","
    if ((Get-Actions) -join "," -ne $expectedTransportActions) {
        throw "Transport-aware upgrade invoked an unexpected action sequence."
    }
    foreach ($mode in $expectedModes.Keys) {
        Remove-Item -LiteralPath $actionLog -Force -ErrorAction SilentlyContinue
        $result = & $installer -Mode $mode -ConnectionId w200 -ConfigPath $configPath -BootstrapScriptPath $fakeBootstrap -SecurePassword $password | ConvertFrom-Json
        if (-not $result.status.ready) {
            throw "$mode did not finish with a ready helper state."
        }
        if ((Get-Actions) -join "," -ne $expectedModes[$mode]) {
            throw "$mode invoked an unexpected action sequence: $((Get-Actions) -join ',')"
        }
    }

    $badConfig = $config | ConvertTo-Json -Depth 5 | ConvertFrom-Json
    $badConfig.connections[0] | Add-Member -NotePropertyName password -NotePropertyValue "must-not-be-read"
    $badPath = Join-Path $testRoot "bad-connections.json"
    $badConfig | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $badPath -Encoding utf8
    Assert-Throws {
        & $installer -Mode status -ConnectionId w200 -ConfigPath $badPath -BootstrapScriptPath $fakeBootstrap -SecurePassword $password
    } "Plaintext password"

    Write-Host "Installer parser    : PASS"
    Write-Host "Controlled preflight: PASS"
    Write-Host "Mode action mapping : PASS"
    Write-Host "Plaintext rejection : PASS"
} finally {
    $listener.Stop()
    Remove-Item Env:ABAP_MCP_INSTALLER_ACTION_LOG -ErrorAction SilentlyContinue
    Remove-Item Env:ABAP_MCP_INSTALLER_HELPERS_READY -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
