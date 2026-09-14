#requires -Version 7.0

[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 4847,

    [switch]$PassThru
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $root "connections.json"

if (-not (Test-Path -LiteralPath $configPath)) {
    $message = "缺少 connections.json。请恢复随包提供的配置文件，或从 connections.example.json 重新创建。"
    if ($PassThru) {
        throw $message
    }
    Write-Error $message
    exit 2
}

$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$temporaryPasswordVariables = [Collections.Generic.List[string]]::new()
foreach ($connection in $config.connections) {
    $passwordEnv = [string]$connection.passwordEnv
    if ($passwordEnv -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
        throw "Invalid passwordEnv for connection '$($connection.id)': $passwordEnv"
    }
    if ([string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($passwordEnv, "Process"))) {
        if ([Console]::IsInputRedirected) {
            throw "Password environment variable is not set: $passwordEnv"
        }
        $securePassword = Read-Host "Password for $($connection.username)@$($connection.id)" -AsSecureString
        $credential = [PSCredential]::new("unused", $securePassword)
        $plainPassword = $credential.GetNetworkCredential().Password
        if ([string]::IsNullOrEmpty($plainPassword)) {
            throw "Password cannot be empty for connection '$($connection.id)'."
        }
        [Environment]::SetEnvironmentVariable($passwordEnv, $plainPassword, "Process")
        $temporaryPasswordVariables.Add($passwordEnv)
        $plainPassword = $null
        $credential = $null
        $securePassword = $null
    }
}

$env:ABAP_MCP_CONFIG = $configPath
$env:ABAP_MCP_PORT = $Port.ToString()
$env:ABAP_MCP_EXPORT_ROOT = Join-Path $root "exports"

try {
    Write-Host "ORVANTA: http://127.0.0.1:$Port/mcp"
    & (Join-Path $root "runtime\node.exe") (Join-Path $root "app\dist\src\index.js")
    $serviceExitCode = $LASTEXITCODE
} finally {
    foreach ($passwordEnv in $temporaryPasswordVariables) {
        [Environment]::SetEnvironmentVariable($passwordEnv, $null, "Process")
    }
}
if ($PassThru) {
    return $serviceExitCode
}
exit $serviceExitCode
