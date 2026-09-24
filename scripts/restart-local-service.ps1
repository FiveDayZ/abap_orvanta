#requires -Version 7.2

<#
.SYNOPSIS
Restart the locally running ORVANTA MCP HTTP service so it loads a freshly built dist/.

.DESCRIPTION
The service keeps the SAP password only in its own process environment, so a restart needs the
password again. This prompts for it exactly like scripts/run-*-validation.ps1 do: the value never
leaves the process environment, is never written to disk and is cleared in the finally block.

`get_runtime_info` reports `restartRequired: true` whenever the compiled dist/ on disk no longer
matches the artifact the running process loaded, which is the signal this script answers.

.EXAMPLE
pwsh -File scripts/restart-local-service.ps1
pwsh -File scripts/restart-local-service.ps1 -Port 4849 -ConfigPath ..\.cache\orvanta-w200-connections.json
#>
[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 4848,

    # Local, git-ignored SAP connection config. Override when the service runs against another system.
    [string]$ConfigPath = (Join-Path (Split-Path -Parent $PSScriptRoot) ".cache\orvanta-w200-connections.json"),

    # Optional. When omitted the service keeps its own default (the working directory).
    [string]$ExportRoot
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$configPath = [IO.Path]::GetFullPath($ConfigPath)

if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "SAP connection config not found: $configPath"
}

$entryPoint = Join-Path $projectRoot "dist\src\index.js"
if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
    throw "Compiled entry point not found: $entryPoint. Run 'npm run build' first."
}

$connection = @((Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json).connections)[0]
if (-not $connection) {
    throw "SAP connection config declares no connection: $configPath"
}
$passwordEnv = [string]$connection.passwordEnv
if ($passwordEnv -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
    throw "Invalid passwordEnv in ${configPath}: $passwordEnv"
}

# A running instance holds a lock on its target keys, so stop it before starting the replacement.
$listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
foreach ($listener in $listeners) {
    $existing = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    Write-Host "Stopping $($existing.ProcessName) (pid $($listener.OwningProcess)) on port $Port"
    Stop-Process -Id $listener.OwningProcess -Force
}
if ($listeners.Count -gt 0) {
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Milliseconds 250
        if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { break }
    }
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
        throw "Port $Port is still held after stopping the previous instance."
    }
}

$logRoot = Join-Path $projectRoot ".logs"
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$stdout = Join-Path $logRoot "local-service-$Port.out.log"
$stderr = Join-Path $logRoot "local-service-$Port.err.log"
Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue

$securePassword = Read-Host "Password for $($connection.username)@$($connection.id)" -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
$service = $null
try {
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    if ([string]::IsNullOrEmpty($plainPassword)) { throw "Password cannot be empty." }

    $processEnvironment = @{
        $passwordEnv      = $plainPassword
        ABAP_MCP_CONFIG   = $configPath
        ABAP_MCP_PORT     = $Port.ToString()
    }
    if ($ExportRoot) {
        $processEnvironment["ABAP_MCP_EXPORT_ROOT"] = [IO.Path]::GetFullPath($ExportRoot)
    }

    Write-Host "Starting: $entryPoint"
    Write-Host "Config  : $configPath"
    Write-Host "Endpoint: http://127.0.0.1:$Port/mcp"
    $service = Start-Process -FilePath (Get-Command node).Source -ArgumentList "dist/src/index.js" `
        -WorkingDirectory $projectRoot -Environment $processEnvironment -WindowStyle Hidden `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
}
finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    $plainPassword = $null
    $securePassword = $null
    [Environment]::SetEnvironmentVariable($passwordEnv, $null, "Process")
}

for ($attempt = 0; $attempt -lt 80; $attempt++) {
    Start-Sleep -Milliseconds 250
    if ($service.HasExited) {
        throw "Service exited with code $($service.ExitCode) before listening: $(Get-Content -Raw $stderr -ErrorAction SilentlyContinue)"
    }
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
        Write-Host "ORVANTA listening at http://127.0.0.1:$Port/mcp (pid $($service.Id))"
        Write-Host "Logs: $stdout"
        exit 0
    }
}
throw "Service did not start listening on port $Port within 20 seconds. See $stderr"
