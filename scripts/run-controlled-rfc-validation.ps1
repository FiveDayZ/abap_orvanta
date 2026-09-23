#requires -Version 7.0

[CmdletBinding()]
param(
    [int]$Port = 0,
    [string]$ResultPath = (Join-Path $env:TEMP "sap-controlled-rfc-validation-0190.json")
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "get-base-connections.ps1")
$baseConfigPath = Resolve-BaseConnectionsPath -ProjectRoot $projectRoot
$configPath = Join-Path $env:TEMP ("abap-mcp-0190-connections-" + [guid]::NewGuid() + ".json")
$stdout = Join-Path $env:TEMP "abap-mcp-0190-rfc-stdout.log"
$stderr = Join-Path $env:TEMP "abap-mcp-0190-rfc-stderr.log"
$probeStderr = Join-Path $env:TEMP "abap-mcp-0190-rfc-probe-stderr.log"
$securePassword = Read-Host "Password for $((Get-BaseConnections -ProjectRoot $projectRoot).Connection.username)" -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
$plainPassword = $null
$service = $null

try {
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    if ([string]::IsNullOrEmpty($plainPassword)) { throw "Password cannot be empty." }
    $config = Get-Content -Raw -LiteralPath $baseConfigPath | ConvertFrom-Json
    $config.connections[0] | Add-Member -NotePropertyName remoteFunctionAllowlist `
        -NotePropertyValue @("ZCMCP_FM_1901") -Force
    $config | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configPath -Encoding utf8

    if ($Port -eq 0) {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
        $listener.Start()
        $Port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
        $listener.Stop()
    }
    $processEnvironment = @{
        ABAP_MCP_W200_PASSWORD = $plainPassword
        ABAP_MCP_CONFIG        = $configPath
        ABAP_MCP_PORT          = $Port.ToString()
        ABAP_MCP_ENDPOINT      = "http://127.0.0.1:$Port/mcp"
    }
    $node = (Get-Command node).Source
    $service = Start-Process -FilePath $node -ArgumentList "dist/src/index.js" `
        -WorkingDirectory $projectRoot -Environment $processEnvironment -WindowStyle Hidden `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru

    $health = $null
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Milliseconds 250
        if ($service.HasExited) {
            throw "0.19.0 service exited before becoming healthy: $(Get-Content -Raw $stderr -ErrorAction SilentlyContinue)"
        }
        try {
            $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2
            break
        } catch {}
    }
    if (-not $health) {
        throw "0.19.0 service did not start: $(Get-Content -Raw $stderr -ErrorAction SilentlyContinue)"
    }

    $resolvedResultPath = [IO.Path]::GetFullPath($ResultPath)
    Remove-Item -LiteralPath $resolvedResultPath, $probeStderr -Force -ErrorAction SilentlyContinue
    $probe = Start-Process -FilePath $node -ArgumentList (Join-Path $PSScriptRoot "probe-controlled-rfc-validation.mjs") `
        -WorkingDirectory $projectRoot -Environment $processEnvironment -WindowStyle Hidden `
        -RedirectStandardOutput $resolvedResultPath -RedirectStandardError $probeStderr -PassThru -Wait
    $resultText = Get-Content -Raw $resolvedResultPath -ErrorAction SilentlyContinue
    Write-Output $resultText
    Write-Host "`nResult: $resolvedResultPath"
    if ($probe.ExitCode -ne 0) {
        $probeError = Get-Content -Raw $probeStderr -ErrorAction SilentlyContinue
        $failureDetail = if ([string]::IsNullOrWhiteSpace($probeError)) { $resultText } else { $probeError }
        throw "Controlled RFC validation failed with exit code $($probe.ExitCode): $failureDetail"
    }
}
finally {
    if ($service -and -not $service.HasExited) {
        Stop-Process -Id $service.Id -Force -ErrorAction SilentlyContinue
    }
    $plainPassword = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    Remove-Variable securePassword -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $configPath -Force -ErrorAction SilentlyContinue
}
