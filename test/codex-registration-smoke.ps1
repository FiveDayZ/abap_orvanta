#requires -Version 7.0

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$packageJson = Get-Content -Raw (Join-Path $projectRoot "package.json") | ConvertFrom-Json
$packagedScript = Join-Path $projectRoot "release\abap-mcp-standalone-$($packageJson.version)-win-x64\configure-codex.ps1"
$scriptPath = if (Test-Path -LiteralPath $packagedScript) {
    $packagedScript
} else {
    Join-Path $projectRoot "packaging\windows\configure-codex.ps1"
}
$testHome = Join-Path $env:TEMP ("abap-mcp-codex-config-" + [guid]::NewGuid())
$previousCodexHome = $env:CODEX_HOME
New-Item -ItemType Directory -Force -Path $testHome | Out-Null
$env:CODEX_HOME = $testHome

try {
    & $scriptPath -ServerName "abap_fs_standalone" -Port 4847
    if ($LASTEXITCODE -ne 0) {
        throw "Initial Codex registration failed."
    }
    & $scriptPath -ServerName "abap_fs_standalone" -Port 4847
    if ($LASTEXITCODE -ne 0) {
        throw "Idempotent Codex registration failed."
    }

    $conflictRejected = $false
    try {
        & $scriptPath -ServerName "abap_fs_standalone" -Port 4850
    } catch {
        $conflictRejected = $_.Exception.Message -match "already points"
    }
    if (-not $conflictRejected) {
        throw "Codex registration must reject a conflicting URL without -Force."
    }

    & $scriptPath -ServerName "abap_fs_standalone" -Port 4850 -Force
    $registered = (& codex mcp get abap_fs_standalone --json) | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $registered.transport.url -ne "http://127.0.0.1:4850/mcp") {
        throw "Forced Codex registration was not persisted correctly."
    }

    & $scriptPath -ServerName "abap_fs_standalone" -Remove
    & codex mcp get abap_fs_standalone --json 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        throw "Codex MCP removal did not remove the test server."
    }
    Write-Host "Codex registration smoke PASS (isolated CODEX_HOME)"
} finally {
    if ($null -eq $previousCodexHome) {
        Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue
    } else {
        $env:CODEX_HOME = $previousCodexHome
    }
    Remove-Item -LiteralPath $testHome -Recurse -Force -ErrorAction SilentlyContinue
}
