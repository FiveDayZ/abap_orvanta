#requires -Version 7.0

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceSetup = Join-Path $projectRoot "packaging\windows\setup.ps1"
$testRoot = Join-Path $env:TEMP ("abap-mcp-setup-" + [guid]::NewGuid())
$setup = Join-Path $testRoot "setup.ps1"
$actionLog = Join-Path $testRoot "actions.log"
$passwordEnv = "ABAP_MCP_SETUP_TEST_PASSWORD"
$password = ConvertTo-SecureString "validation-only" -AsPlainText -Force

function Get-Actions {
    if (-not (Test-Path -LiteralPath $actionLog)) {
        return @()
    }
    return @(Get-Content -LiteralPath $actionLog)
}

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

New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
Copy-Item -LiteralPath $sourceSetup -Destination $setup
@{
    connections = @(
        @{
            id = "W200"
            url = "http://127.0.0.1:8000"
            client = "200"
            language = "EN"
            username = "VALIDATION"
            passwordEnv = $passwordEnv
            allowUnauthorized = $false
        }
    )
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $testRoot "connections.json") -Encoding utf8

@'
param(
    [string]$Mode,
    [string]$ConnectionId,
    [Security.SecureString]$SecurePassword
)
if ($env:ABAP_MCP_SETUP_FAIL_PREFLIGHT -eq "1") { throw "controlled preflight failure" }
if ($Mode -ne "preflight" -or $ConnectionId -ne "w200" -or -not $SecurePassword) {
    throw "Invalid preflight contract."
}
Add-Content -LiteralPath $env:ABAP_MCP_SETUP_ACTION_LOG -Value "preflight"
'{"status":{"ready":true}}'
'@ | Set-Content -LiteralPath (Join-Path $testRoot "install-sap-helper.ps1") -Encoding utf8

@'
param(
    [string]$ServerName,
    [int]$Port,
    [switch]$Force
)
if ($ServerName -ne "setup_test" -or $Port -ne 4947 -or -not $Force) {
    throw "Invalid Codex registration contract."
}
Add-Content -LiteralPath $env:ABAP_MCP_SETUP_ACTION_LOG -Value "codex"
'@ | Set-Content -LiteralPath (Join-Path $testRoot "configure-codex.ps1") -Encoding utf8

@'
param(
    [int]$Port,
    [switch]$PassThru
)
if ($Port -ne 4947 -or -not $PassThru) { throw "Invalid start contract." }
if ($env:ABAP_MCP_SETUP_TEST_PASSWORD -ne "validation-only") {
    throw "Selected connection password was not passed to the service process."
}
Add-Content -LiteralPath $env:ABAP_MCP_SETUP_ACTION_LOG -Value "start"
return 0
'@ | Set-Content -LiteralPath (Join-Path $testRoot "start.ps1") -Encoding utf8

$env:ABAP_MCP_SETUP_ACTION_LOG = $actionLog
Remove-Item Env:$passwordEnv -ErrorAction SilentlyContinue

try {
    $tokens = $null
    $errors = $null
    [Management.Automation.Language.Parser]::ParseFile(
        $sourceSetup,
        [ref]$tokens,
        [ref]$errors
    ) | Out-Null
    if ($errors.Count -gt 0) {
        throw "setup.ps1 has parser errors: $($errors -join '; ')"
    }
    $source = Get-Content -Raw -LiteralPath $sourceSetup
    if (-not $source.StartsWith("#requires -Version 7.0")) {
        throw "setup.ps1 must require PowerShell 7."
    }
    if ($source -match "powershell\.exe" -or $source -notmatch "Read-Host.+-AsSecureString") {
        throw "setup.ps1 must use a PowerShell 7 secure prompt."
    }

    & $setup -ConnectionId w200 -Port 4947 -ServerName setup_test -ForceCodex -SecurePassword $password
    if ((Get-Actions) -join "," -ne "preflight,codex,start") {
        throw "One-click setup invoked an unexpected sequence: $((Get-Actions) -join ',')"
    }
    if (-not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($passwordEnv, "Process"))) {
        throw "One-click setup did not clear the temporary password environment variable."
    }

    Remove-Item -LiteralPath $actionLog -Force
    & $setup -ConnectionId w200 -Port 4947 -ServerName setup_test -SkipCodex -SecurePassword $password
    if ((Get-Actions) -join "," -ne "preflight,start") {
        throw "SkipCodex invoked an unexpected sequence."
    }

    Remove-Item -LiteralPath $actionLog -Force
    $env:ABAP_MCP_SETUP_FAIL_PREFLIGHT = "1"
    Assert-Throws {
        & $setup -ConnectionId w200 -Port 4947 -ServerName setup_test -ForceCodex -SecurePassword $password
    } "controlled preflight failure"
    if (
        (Get-Actions).Count -ne 0 -or
        -not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($passwordEnv, "Process"))
    ) {
        throw "Failed preflight must not register Codex, start the service, or retain a password."
    }
    Remove-Item Env:ABAP_MCP_SETUP_FAIL_PREFLIGHT

    $configPath = Join-Path $testRoot "connections.json"
    $badConfig = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    $badConfig.connections[0] | Add-Member -NotePropertyName password -NotePropertyValue "must-not-be-read"
    $badConfig | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath -Encoding utf8
    Assert-Throws {
        & $setup -ConnectionId w200 -Port 4947 -SkipCodex -SecurePassword $password
    } "Plaintext password"

    Write-Host "Setup parser       : PASS"
    Write-Host "One-click sequence : PASS"
    Write-Host "Password cleanup   : PASS"
    Write-Host "Failure gate       : PASS"
} finally {
    Remove-Item Env:ABAP_MCP_SETUP_ACTION_LOG -ErrorAction SilentlyContinue
    Remove-Item Env:ABAP_MCP_SETUP_FAIL_PREFLIGHT -ErrorAction SilentlyContinue
    Remove-Item Env:$passwordEnv -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
