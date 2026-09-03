#requires -Version 7.0

[CmdletBinding()]
param(
    [switch]$EnableWrite,
    [int]$Port = 0,
    [string]$ResultPath = (Join-Path $env:TEMP "sap-classic-screen-validation-0250.json"),
    [string]$ReadyPath = (Join-Path $env:TEMP "sap-classic-screen-ready-0250.json"),
    [string]$CleanupSignalPath = (Join-Path $env:TEMP "sap-classic-screen-cleanup-0250.signal"),
    [Security.SecureString]$SecurePassword
)

$ErrorActionPreference = "Stop"
if (-not $EnableWrite) {
    throw "-EnableWrite is required because this validation creates and deletes approved SAP objects."
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$baseConfigPath = Join-Path $projectRoot "packaging\windows\default-connections.json"
$configPath = Join-Path $env:TEMP ("abap-mcp-0250-connections-" + [guid]::NewGuid() + ".json")
$stdout = Join-Path $env:TEMP "abap-mcp-0250-stdout.log"
$stderr = Join-Path $env:TEMP "abap-mcp-0250-stderr.log"
$probeStderr = Join-Path $env:TEMP "abap-mcp-0250-probe-stderr.log"
$securePassword = if ($SecurePassword) {
    $SecurePassword
}
else {
    Read-Host "Password for wys@w200" -AsSecureString
}
$credential = [PSCredential]::new("unused", $securePassword)
$plainPassword = $credential.GetNetworkCredential().Password
$service = $null

try {
    if ([string]::IsNullOrEmpty($plainPassword)) { throw "Password cannot be empty." }
    Copy-Item -LiteralPath $baseConfigPath -Destination $configPath
    if ($Port -eq 0) {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
        $listener.Start()
        $Port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
        $listener.Stop()
    }

    Remove-Item -LiteralPath $ResultPath, $ReadyPath, $CleanupSignalPath, $probeStderr `
        -Force -ErrorAction SilentlyContinue
    $processEnvironment = @{
        ABAP_MCP_W200_PASSWORD = $plainPassword
        ABAP_MCP_CONFIG = $configPath
        ABAP_MCP_PORT = $Port.ToString()
        ABAP_MCP_ENDPOINT = "http://127.0.0.1:$Port/mcp"
        ABAP_MCP_CLASSIC_SCREEN_WRITE = "1"
        ABAP_MCP_CLASSIC_READY_PATH = [IO.Path]::GetFullPath($ReadyPath)
        ABAP_MCP_CLASSIC_CLEANUP_SIGNAL = [IO.Path]::GetFullPath($CleanupSignalPath)
    }
    $node = (Get-Command node).Source
    $service = Start-Process -FilePath $node -ArgumentList "dist/src/index.js" `
        -WorkingDirectory $projectRoot -Environment $processEnvironment -WindowStyle Hidden `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru

    $health = $null
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Milliseconds 250
        if ($service.HasExited) {
            throw "0.25.0 service exited before becoming healthy: $(Get-Content -Raw $stderr -ErrorAction SilentlyContinue)"
        }
        try {
            $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2
            break
        } catch {}
    }
    if (-not $health) {
        throw "0.25.0 service did not start: $(Get-Content -Raw $stderr -ErrorAction SilentlyContinue)"
    }

    $probe = Start-Process -FilePath $node `
        -ArgumentList (Join-Path $PSScriptRoot "probe-classic-screen-wave.mjs") `
        -WorkingDirectory $projectRoot -Environment $processEnvironment -WindowStyle Hidden `
        -RedirectStandardOutput $ResultPath -RedirectStandardError $probeStderr -PassThru
    Write-Host "Preparing ZCMCP_DYN_0250 / ZCMCP_0250..."
    while (-not $probe.HasExited -and -not (Test-Path -LiteralPath $ReadyPath)) {
        Start-Sleep -Milliseconds 500
    }
    if ($probe.HasExited) {
        $failure = Get-Content -Raw $probeStderr -ErrorAction SilentlyContinue
        throw "Classic-screen preparation failed with exit code $($probe.ExitCode): $failure"
    }
    Write-Host "Ready for SAP GUI validation. Evidence: $ReadyPath"
    Write-Host "Cleanup will start automatically after Codex creates: $CleanupSignalPath"
    $probe.WaitForExit()
    if ($probe.ExitCode -ne 0) {
        $failure = Get-Content -Raw $probeStderr -ErrorAction SilentlyContinue
        throw "Classic-screen validation failed with exit code $($probe.ExitCode): $failure"
    }
    Get-Content -Raw -LiteralPath $ResultPath
    Write-Host "Result: $ResultPath"
}
finally {
    if ($service -and -not $service.HasExited) {
        Stop-Process -Id $service.Id -Force -ErrorAction SilentlyContinue
    }
    $plainPassword = $null
    $credential = $null
    $securePassword = $null
    Remove-Item -LiteralPath $configPath -Force -ErrorAction SilentlyContinue
}
