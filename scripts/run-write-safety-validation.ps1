#requires -Version 7.0

[CmdletBinding()]
param(
    [switch]$ApproveWrite,
    [switch]$RecoverResidual,
    [string]$ProgramName = "ZCMCP_SAFE_0271",
    [string]$PackageName = "ZABAP",
    [string]$TransportNumber = "GR2K923421",
    [int]$Port = 0,
    [string]$ResultPath = (Join-Path $env:TEMP "sap-write-safety-validation-0271.json")
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "get-base-connections.ps1")
$baseConfigPath = Resolve-BaseConnectionsPath -ProjectRoot $projectRoot
$testRoot = Join-Path $env:TEMP ("abap-mcp-0271-" + [guid]::NewGuid())
$configPath = Join-Path $testRoot "connections.json"
$stateRoot = Join-Path $testRoot "state"
$stdout = Join-Path $env:TEMP "sap-write-safety-validation-0271-service.stdout.log"
$stderr = Join-Path $env:TEMP "sap-write-safety-validation-0271-service.stderr.log"
$probeStderr = Join-Path $env:TEMP "sap-write-safety-validation-0271-probe.stderr.log"
$plainPassword = $null
$passwordPointer = [IntPtr]::Zero
$service = $null

if (-not $ApproveWrite) {
    throw "-ApproveWrite is required for the exact temporary object and cleanup scope."
}
$ProgramName = $ProgramName.ToUpperInvariant()
$PackageName = $PackageName.ToUpperInvariant()
$TransportNumber = $TransportNumber.ToUpperInvariant()
if ($ProgramName -notmatch '^[ZY][A-Z0-9_]*$') { throw "ProgramName must be Z* or Y*." }
if ($PackageName -eq '$TMP') { throw "A transportable package is required." }
if ($TransportNumber -notmatch '^[A-Z0-9]{10}$') { throw "TransportNumber is invalid." }

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

    $securePassword = Read-Host "Password for $((Get-BaseConnections -ProjectRoot $projectRoot).Connection.username)@w200" -AsSecureString
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
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
        ABAP_MCP_W200_PASSWORD        = $plainPassword
        ABAP_MCP_CONFIG               = $configPath
        ABAP_MCP_PORT                 = $Port.ToString()
        ABAP_MCP_ENDPOINT             = "http://127.0.0.1:$Port/mcp"
        ABAP_MCP_STATE_DIR            = $stateRoot
        ABAP_MCP_CONNECTION           = "w200"
        ABAP_MCP_SAFETY_PROGRAM       = $ProgramName
        ABAP_MCP_PACKAGE              = $PackageName
        ABAP_MCP_TRANSPORT            = $TransportNumber
        ABAP_MCP_WRITE_SAFETY_ACCEPTED = "1"
        ABAP_MCP_SAFETY_RECOVER_RESIDUAL = if ($RecoverResidual) { "1" } else { "0" }
    }

    Remove-Item -LiteralPath $stdout, $stderr, $probeStderr -Force -ErrorAction SilentlyContinue
    $service = Start-Process -FilePath $node -ArgumentList "dist/src/index.js" `
        -WorkingDirectory $projectRoot -Environment $processEnvironment -WindowStyle Hidden `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru

    $health = $null
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        Start-Sleep -Milliseconds 250
        if ($service.HasExited) {
            throw "0.27.1 service exited before becoming healthy: $(Get-Content -Raw $stderr -ErrorAction SilentlyContinue)"
        }
        try {
            $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2
            if ($health.status -eq "ok") { break }
        }
        catch {}
    }
    if (-not $health -or $health.status -ne "ok") {
        throw "0.27.1 service did not become healthy: $(Get-Content -Raw $stderr -ErrorAction SilentlyContinue)"
    }

    $resolvedResultPath = [IO.Path]::GetFullPath($ResultPath)
    Remove-Item -LiteralPath $resolvedResultPath -Force -ErrorAction SilentlyContinue
    $probe = Start-Process -FilePath $node `
        -ArgumentList (Join-Path $PSScriptRoot "probe-write-safety-validation.mjs") `
        -WorkingDirectory $projectRoot -Environment $processEnvironment -WindowStyle Hidden `
        -RedirectStandardOutput $resolvedResultPath -RedirectStandardError $probeStderr -PassThru -Wait

    $resultText = Get-Content -Raw -LiteralPath $resolvedResultPath -ErrorAction SilentlyContinue
    Write-Output $resultText
    Write-Host "`nResult: $resolvedResultPath"
    if ($probe.ExitCode -ne 0) {
        $probeError = Get-Content -Raw -LiteralPath $probeStderr -ErrorAction SilentlyContinue
        $failureDetail = if ([string]::IsNullOrWhiteSpace($probeError)) { $resultText } else { $probeError }
        throw "Write-safety validation failed with exit code $($probe.ExitCode): $failureDetail"
    }
}
finally {
    Stop-ValidationService $service
    $plainPassword = $null
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
    Remove-Variable securePassword -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
