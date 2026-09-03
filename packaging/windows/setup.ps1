#requires -Version 7.0

[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9_-]+$')]
    [string]$ConnectionId = "w200",

    [ValidateRange(1024, 65535)]
    [int]$Port = 4847,

    [ValidatePattern('^[A-Za-z0-9_-]+$')]
    [string]$ServerName = "abap_fs_standalone",

    [switch]$ForceCodex,

    [switch]$SkipCodex,

    [Security.SecureString]$SecurePassword
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $root "connections.json"
$installerPath = Join-Path $root "install-sap-helper.ps1"
$configureCodexPath = Join-Path $root "configure-codex.ps1"
$startPath = Join-Path $root "start.ps1"

foreach ($path in @($configPath, $installerPath, $startPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required setup file not found: $path"
    }
}

try {
    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
} catch {
    throw "Invalid connection configuration: $($_.Exception.Message)"
}
$matches = @($config.connections | Where-Object { [string]$_.id -ieq $ConnectionId })
if ($matches.Count -ne 1) {
    throw "Connection '$ConnectionId' was not found exactly once in connections.json."
}
$connection = $matches[0]
if ($connection.PSObject.Properties.Name -contains "password") {
    throw "Plaintext password properties are not allowed in connections.json."
}
$passwordEnv = [string]$connection.passwordEnv
if ($passwordEnv -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
    throw "Invalid passwordEnv for connection '$($connection.id)': $passwordEnv"
}

$previousPassword = [Environment]::GetEnvironmentVariable($passwordEnv, "Process")
if (-not $SecurePassword) {
    if (-not [string]::IsNullOrEmpty($previousPassword)) {
        $SecurePassword = ConvertTo-SecureString $previousPassword -AsPlainText -Force
    } else {
        if ([Console]::IsInputRedirected) {
            throw "A visible PowerShell 7 terminal is required for secure password input."
        }
        $SecurePassword = Read-Host "Password for $($connection.username)@$($connection.id)" -AsSecureString
    }
}
if ($SecurePassword.Length -eq 0) {
    throw "Password cannot be empty."
}

try {
    Write-Host "[1/3] SAP helper preflight"
    & $installerPath -Mode preflight -ConnectionId $ConnectionId -SecurePassword $SecurePassword | Out-Host

    if ($SkipCodex) {
        Write-Host "[2/3] Codex registration skipped"
    } else {
        if (-not (Test-Path -LiteralPath $configureCodexPath -PathType Leaf)) {
            throw "Codex configuration script not found: $configureCodexPath"
        }
        Write-Host "[2/3] Codex MCP registration"
        & $configureCodexPath -ServerName $ServerName -Port $Port -Force:$ForceCodex
    }

    $credential = [PSCredential]::new("unused", $SecurePassword)
    $plainPassword = $credential.GetNetworkCredential().Password
    if ([string]::IsNullOrEmpty($plainPassword)) {
        throw "Password cannot be empty."
    }
    [Environment]::SetEnvironmentVariable($passwordEnv, $plainPassword, "Process")
    $plainPassword = $null
    $credential = $null

    Write-Host "[3/3] ABAP MCP service"
    $serviceExitCode = & $startPath -Port $Port -PassThru
    if ($serviceExitCode -ne 0) {
        throw "ABAP MCP service exited with code $serviceExitCode."
    }
} finally {
    [Environment]::SetEnvironmentVariable($passwordEnv, $previousPassword, "Process")
    $previousPassword = $null
    $SecurePassword = $null
}
