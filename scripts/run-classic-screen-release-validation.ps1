#requires -Version 7.0

[CmdletBinding()]
param(
    [string]$ResultPath = (Join-Path $env:TEMP "sap-classic-screen-validation-0250.json"),
    [string]$ReadyPath = (Join-Path $env:TEMP "sap-classic-screen-ready-0250.json"),
    [string]$CleanupSignalPath = (Join-Path $env:TEMP "sap-classic-screen-cleanup-0250.signal")
)

$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "MCP 0.25.0 Classic Screen Final"
$projectRoot = Split-Path -Parent $PSScriptRoot
$securePassword = Read-Host "Password for wys@w200" -AsSecureString

try {
    if ($securePassword.Length -eq 0) { throw "Password cannot be empty." }
    Set-Location -LiteralPath $projectRoot
    npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE." }

    & (Join-Path $PSScriptRoot "bootstrap-sap-helper.ps1") `
        -BaseUrl "http://192.168.88.26:8000" `
        -Username "wys" `
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
