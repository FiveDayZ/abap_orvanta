#requires -Version 7.0

[CmdletBinding()]
param(
    [switch]$ApproveWrite,
    [switch]$FailureHandling,
    [ValidatePattern('^[ZY][A-Z0-9_]{0,29}$')]
    [string]$PackageName = "ZABAP",
    [ValidatePattern('^[A-Z0-9]{10}$')]
    [string]$TransportNumber = "GR2K923421",
    [int]$Port = 0,
    [string]$ResultPath = (Join-Path $env:TEMP "sap-function-interface-patch-0350.json"),
    [Security.SecureString]$SecurePassword
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$baseConfigPath = Join-Path $projectRoot "packaging\windows\default-connections.json"
$testRoot = Join-Path $env:TEMP ("abap-mcp-0350-" + [guid]::NewGuid())
$configPath = Join-Path $testRoot "connections.json"
$stateRoot = Join-Path $testRoot "state"
$stdout = Join-Path $testRoot "service.stdout.log"
$stderr = Join-Path $testRoot "service.stderr.log"
$probeStderr = Join-Path $testRoot "probe.stderr.log"
$plainPassword = $null
$passwordPointer = [IntPtr]::Zero
$service = $null
$validationPassed = $false
$resolvedResultPath = [IO.Path]::GetFullPath($ResultPath)
if (Test-Path -LiteralPath $resolvedResultPath) { throw "Result already exists: $resolvedResultPath" }

if (-not $ApproveWrite) {
    throw "-ApproveWrite is required for the exact approved 0.35.0 function-interface lifecycle."
}
if ($PackageName -eq '$TMP') { throw "PackageName must be transportable." }

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
    finally { Pop-Location }

    New-Item -ItemType Directory -Force -Path $testRoot, $stateRoot | Out-Null
    Copy-Item -LiteralPath $baseConfigPath -Destination $configPath
    if ($FailureHandling) {
        $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
        $connection = @($config.connections | Where-Object { $_.id -eq "w200" })
        if ($connection.Count -ne 1) { throw "Exactly one w200 connection is required." }
        $connection[0].remoteFunctionAllowlist = @("ZCMCP_FM_0350")
        $config | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configPath -Encoding utf8
    }
    if (-not $SecurePassword) {
        if ([Console]::IsInputRedirected) {
            throw "A visible PowerShell 7 terminal is required for secure password input."
        }
        $SecurePassword = Read-Host "Password for wys@w200" -AsSecureString
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
        ABAP_MCP_W200_PASSWORD = $plainPassword
        ABAP_MCP_CONFIG = $configPath
        ABAP_MCP_PORT = $Port.ToString()
        ABAP_MCP_ENDPOINT = "http://127.0.0.1:$Port/mcp"
        ABAP_MCP_STATE_DIR = $stateRoot
        ABAP_MCP_CONNECTION = "w200"
        ABAP_MCP_PACKAGE = $PackageName.ToUpperInvariant()
        ABAP_MCP_TRANSPORT = $TransportNumber.ToUpperInvariant()
        ABAP_MCP_FUNCTION_PATCH_ACCEPTED = "1"
    }

    Remove-Item -LiteralPath $stdout, $stderr, $probeStderr -Force -ErrorAction SilentlyContinue
    $service = Start-Process -FilePath $node -ArgumentList "dist/src/index.js" `
        -WorkingDirectory $projectRoot -Environment $processEnvironment -WindowStyle Hidden `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru

    $health = $null
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        Start-Sleep -Milliseconds 250
        if ($service.HasExited) {
            throw "0.35.0 service exited before becoming healthy: $(Get-Content -Raw $stderr -ErrorAction SilentlyContinue)"
        }
        try {
            $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2
            if ($health.status -eq "ok") { break }
        }
        catch {}
    }
    if (-not $health -or $health.status -ne "ok") {
        throw "0.35.0 service did not become healthy: $(Get-Content -Raw $stderr -ErrorAction SilentlyContinue)"
    }

    $probeArguments = @('"' + (Join-Path $PSScriptRoot "probe-function-interface-patch-validation.mjs") + '"')
    if ($FailureHandling) { $probeArguments += "--failure-handling" }
    $probe = Start-Process -FilePath $node `
        -ArgumentList $probeArguments `
        -WorkingDirectory $projectRoot -Environment $processEnvironment -WindowStyle Hidden `
        -RedirectStandardOutput $resolvedResultPath -RedirectStandardError $probeStderr `
        -PassThru -Wait

    $resultText = Get-Content -Raw -LiteralPath $resolvedResultPath -ErrorAction SilentlyContinue
    $evidence = $resultText | ConvertFrom-Json
    $evidence | Select-Object phase, status, cleanupComplete | Format-List
    Write-Host "`nResult: $resolvedResultPath"
    if ($probe.ExitCode -ne 0) {
        $probeError = Get-Content -Raw -LiteralPath $probeStderr -ErrorAction SilentlyContinue
        $failureDetail = if ([string]::IsNullOrWhiteSpace($probeError)) { $resultText } else { $probeError }
        throw "Function-interface patch validation failed with exit code $($probe.ExitCode): $failureDetail"
    }
    if ($evidence.status -ne "passed" -or $evidence.cleanupComplete -ne $true) {
        throw "Validation or cleanup was not confirmed."
    }
    $validationPassed = $true
}
finally {
    Stop-ValidationService $service
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
    $plainPassword = $null
    Remove-Variable SecurePassword -ErrorAction SilentlyContinue
    $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
    $tempPrefix = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedTestRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        -not ([IO.Path]::GetFileName($resolvedTestRoot)).StartsWith("abap-mcp-0350-")) {
        throw "Refusing cleanup outside the generated validation directory."
    }
    if ($validationPassed) {
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    } else {
        Write-Warning "Validation state and logs retained for manual inspection: $resolvedTestRoot"
    }
}
