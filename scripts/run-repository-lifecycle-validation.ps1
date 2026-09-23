#requires -Version 7.0

[CmdletBinding()]
param(
    [switch]$ApproveWrite,
    [int]$Port = 0,
    [string]$PackageName = "ZABAP",
    [string]$TransportNumber = "GR2K923421",
    [string]$ResultPath = (Join-Path $env:TEMP "sap-repository-lifecycle-validation-0320.json"),
    [Security.SecureString]$SecurePassword
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "get-base-connections.ps1")
$baseConfigPath = Resolve-BaseConnectionsPath -ProjectRoot $projectRoot
$testRoot = Join-Path $env:TEMP ("abap-mcp-0320-" + [guid]::NewGuid())
$configPath = Join-Path $testRoot "connections.json"
$stateRoot = Join-Path $testRoot "state"
$stdout = Join-Path $env:TEMP "sap-repository-lifecycle-0320-service.stdout.log"
$stderr = Join-Path $env:TEMP "sap-repository-lifecycle-0320-service.stderr.log"
$probeStderr = Join-Path $env:TEMP "sap-repository-lifecycle-0320-probe.stderr.log"
$plainPassword = $null
$passwordPointer = [IntPtr]::Zero
$service = $null

if (-not $ApproveWrite) {
    throw "-ApproveWrite is required for the approved 0.32.0 repository lifecycle objects."
}
if ($PackageName -notmatch '^[ZY][A-Z0-9_]{0,29}$' -or $PackageName -eq '$TMP') {
    throw "PackageName must be a transportable Z* or Y* package."
}
if ($TransportNumber -notmatch '^[A-Z0-9]{10}$') {
    throw "TransportNumber must be an existing ten-character request or task."
}

function Stop-ValidationService {
    param([System.Diagnostics.Process]$Process)
    if ($Process -and -not $Process.HasExited) {
        Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
        $Process.WaitForExit(5000) | Out-Null
    }
}

try {
    Push-Location $projectRoot
    try {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE." }
    }
    finally {
        Pop-Location
    }

    New-Item -ItemType Directory -Force -Path $testRoot, $stateRoot | Out-Null
    Copy-Item -LiteralPath $baseConfigPath -Destination $configPath
    if (-not $SecurePassword) {
        if ([Console]::IsInputRedirected) {
            throw "A visible PowerShell 7 terminal is required for secure password input."
        }
        $SecurePassword = Read-Host "Password for $((Get-BaseConnections -ProjectRoot $projectRoot).Connection.username)@w200" -AsSecureString
    }
    if ($SecurePassword.Length -eq 0) { throw "Password cannot be empty." }
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecurePassword)
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    if ([string]::IsNullOrEmpty($plainPassword)) { throw "Password cannot be empty." }

    if ($Port -eq 0) {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
        $listener.Start()
        $Port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
        $listener.Stop()
    }

    $node = (Get-Command node).Source
    $processEnvironment = @{
        ABAP_MCP_W200_PASSWORD                  = $plainPassword
        ABAP_MCP_CONFIG                         = $configPath
        ABAP_MCP_PORT                           = $Port.ToString()
        ABAP_MCP_ENDPOINT                       = "http://127.0.0.1:$Port/mcp"
        ABAP_MCP_STATE_DIR                      = $stateRoot
        ABAP_MCP_CONNECTION                     = "w200"
        ABAP_MCP_PACKAGE                        = $PackageName.ToUpperInvariant()
        ABAP_MCP_TRANSPORT                      = $TransportNumber.ToUpperInvariant()
        ABAP_MCP_REPOSITORY_LIFECYCLE_ACCEPTED  = "1"
    }

    Remove-Item -LiteralPath $stdout, $stderr, $probeStderr -Force -ErrorAction SilentlyContinue
    $service = Start-Process -FilePath $node -ArgumentList "dist/src/index.js" `
        -WorkingDirectory $projectRoot -Environment $processEnvironment -WindowStyle Hidden `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru

    $health = $null
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        Start-Sleep -Milliseconds 250
        if ($service.HasExited) {
            throw "0.32.0 service exited before becoming healthy: $(Get-Content -Raw $stderr -ErrorAction SilentlyContinue)"
        }
        try {
            $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2
            if ($health.status -eq "ok") { break }
        }
        catch {}
    }
    if (-not $health -or $health.status -ne "ok") {
        throw "0.32.0 service did not become healthy: $(Get-Content -Raw $stderr -ErrorAction SilentlyContinue)"
    }

    $resolvedResultPath = [IO.Path]::GetFullPath($ResultPath)
    Remove-Item -LiteralPath $resolvedResultPath -Force -ErrorAction SilentlyContinue
    $probe = Start-Process -FilePath $node `
        -ArgumentList (Join-Path $PSScriptRoot "probe-repository-lifecycle-validation.mjs") `
        -WorkingDirectory $projectRoot -Environment $processEnvironment -WindowStyle Hidden `
        -RedirectStandardOutput $resolvedResultPath -RedirectStandardError $probeStderr -PassThru -Wait

    $resultText = Get-Content -Raw -LiteralPath $resolvedResultPath -ErrorAction SilentlyContinue
    Write-Output $resultText
    Write-Host "`nResult: $resolvedResultPath"
    if ($probe.ExitCode -ne 0) {
        $probeError = Get-Content -Raw -LiteralPath $probeStderr -ErrorAction SilentlyContinue
        $failureDetail = if ([string]::IsNullOrWhiteSpace($probeError)) { $resultText } else { $probeError }
        throw "Repository lifecycle validation failed with exit code $($probe.ExitCode): $failureDetail"
    }
}
finally {
    Stop-ValidationService $service
    $plainPassword = $null
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
    Remove-Variable SecurePassword -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
