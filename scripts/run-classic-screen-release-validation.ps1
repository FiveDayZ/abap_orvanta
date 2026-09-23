#requires -Version 7.0

[CmdletBinding()]
param(
    [string]$ResultPath = (Join-Path $env:TEMP "sap-classic-screen-validation-0250.json"),
    [string]$ReadyPath = (Join-Path $env:TEMP "sap-classic-screen-ready-0250.json"),
    [string]$CleanupSignalPath = (Join-Path $env:TEMP "sap-classic-screen-cleanup-0250.signal"),
    [string]$BaseUrl,
    [string]$Username
)

$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "MCP 0.25.0 Classic Screen Final"
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "get-base-connections.ps1")
$baseConnections = Get-BaseConnections -ProjectRoot $projectRoot
Assert-BaseConnectionsUsable -Info $baseConnections `
    -EndpointOverride $BaseUrl -UsernameOverride $Username
$sapBaseUrl = if ($BaseUrl) { $BaseUrl } else { $baseConnections.Connection.url }
$sapUsername = if ($Username) { $Username } else { $baseConnections.Connection.username }
$securePassword = Read-Host "Password for $sapUsername" -AsSecureString

try {
    if ($securePassword.Length -eq 0) { throw "Password cannot be empty." }
    Set-Location -LiteralPath $projectRoot
    npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE." }

    & (Join-Path $PSScriptRoot "bootstrap-sap-helper.ps1") `
        -BaseUrl $sapBaseUrl `
        -Username $sapUsername `
        -Client "200" `
        -Language "EN" `
        -Action "RepairRepositoryApi" `
        -ResultPath (Join-Path $env:TEMP "sap-repository-api-repair-0250-final.json") `
        -SecurePassword $securePassword

    & (Join-Path $PSScriptRoot "run-classic-screen-validation.ps1") `
        -EnableWrite `
        -ResultPath $ResultPath `
        -ReadyPath $ReadyPath `
        -CleanupSignalPath $CleanupSignalPath `
        -SecurePassword $securePassword
}
finally {
    $securePassword = $null
}
