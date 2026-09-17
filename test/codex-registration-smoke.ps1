#requires -Version 7.0

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$packageJson = Get-Content -Raw (Join-Path $projectRoot "package.json") | ConvertFrom-Json
$packagedScript = Join-Path $projectRoot "release\orvanta-mcp-$($packageJson.version)-win-x64\configure-codex.ps1"
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
    & codex mcp add abap_fs --url "http://127.0.0.1:4848/mcp"
    if ($LASTEXITCODE -ne 0) { throw "Could not seed legacy registration." }
    & codex mcp add abap_fs_standalone --url "http://127.0.0.1:4849/mcp"
    if ($LASTEXITCODE -ne 0) { throw "Could not seed standalone registration." }
    & $scriptPath -Port 4847
    if ($LASTEXITCODE -ne 0) {
        throw "Initial Codex registration failed."
    }
    & $scriptPath -ServerName "orvanta" -Port 4847
    if ($LASTEXITCODE -ne 0) {
        throw "Idempotent Codex registration failed."
    }

    $conflictRejected = $false
    try {
        & $scriptPath -ServerName "orvanta" -Port 4850
    } catch {
        $conflictRejected = $_.Exception.Message -match "already points"
    }
    if (-not $conflictRejected) {
        throw "Codex registration must reject a conflicting URL without -Force."
    }

    & $scriptPath -ServerName "orvanta" -Port 4850 -Force
    $registered = (& codex mcp get orvanta --json) | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $registered.transport.url -ne "http://127.0.0.1:4850/mcp") {
        throw "Forced Codex registration was not persisted correctly."
    }

    & $scriptPath -ServerName "orvanta" -Remove
    & codex mcp get orvanta --json 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        throw "Codex MCP removal did not remove the test server."
    }
    foreach ($legacy in @(@{name="abap_fs"; port=4848}, @{name="abap_fs_standalone"; port=4849})) {
        $entry = (& codex mcp get $legacy.name --json) | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0 -or $entry.transport.url -ne "http://127.0.0.1:$($legacy.port)/mcp") {
            throw "Legacy registration was changed."
        }
    }
    Write-Host "Codex registration smoke PASS (isolated CODEX_HOME)"
} finally {
    if ($null -eq $previousCodexHome) {
        Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue
    } else {
        $env:CODEX_HOME = $previousCodexHome
    }
    $resolvedHome = [IO.Path]::GetFullPath($testHome)
    $allowedRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd("\") + "\"
    if (-not $resolvedHome.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing cleanup outside TEMP."
    }
    Remove-Item -LiteralPath $resolvedHome -Recurse -Force -ErrorAction SilentlyContinue
}
