#requires -Version 7.0

[CmdletBinding()]
param(
    [int]$Port = 0,
    [string]$ResultPath = (Join-Path $env:TEMP "sap-rfc-receipt-validation-0200.json")
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$baseConfigPath = Join-Path $projectRoot "packaging\windows\default-connections.json"
$testRoot = Join-Path $env:TEMP ("abap-mcp-0200-" + [guid]::NewGuid())
$configPath = Join-Path $testRoot "connections.json"
$stateRoot = Join-Path $testRoot "state"
$firstResultPath = Join-Path $testRoot "first.json"
$restartResultPath = Join-Path $testRoot "restart.json"
$probeStderr = Join-Path $testRoot "probe-stderr.log"
$securePassword = Read-Host "Password for wys" -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
$plainPassword = $null
$service = $null

function Start-McpValidationService {
    param(
        [string]$Node,
        [hashtable]$Environment,
        [string]$Stdout,
        [string]$Stderr
    )
    Remove-Item -LiteralPath $Stdout, $Stderr -Force -ErrorAction SilentlyContinue
    $process = Start-Process -FilePath $Node -ArgumentList "dist/src/index.js" `
        -WorkingDirectory $projectRoot -Environment $Environment -WindowStyle Hidden `
        -RedirectStandardOutput $Stdout -RedirectStandardError $Stderr -PassThru
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Milliseconds 250
        if ($process.HasExited) {
            throw "0.20.0 service exited before becoming healthy: $(Get-Content -Raw $Stderr -ErrorAction SilentlyContinue)"
        }
        try {
            $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2
            if ($health.status -eq "ok") { return $process }
        } catch {}
    }
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "0.20.0 service did not start: $(Get-Content -Raw $Stderr -ErrorAction SilentlyContinue)"
}

function Stop-McpValidationService {
    param([System.Diagnostics.Process]$Process)
    if ($Process -and -not $Process.HasExited) {
        Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
        $Process.WaitForExit(5000) | Out-Null
    }
}

function Invoke-ReceiptProbe {
    param(
        [string]$Node,
        [hashtable]$Environment,
        [string]$Stage,
        [string]$OutputPath
    )
    Remove-Item -LiteralPath $OutputPath, $probeStderr -Force -ErrorAction SilentlyContinue
    $probe = Start-Process -FilePath $Node `
        -ArgumentList @((Join-Path $PSScriptRoot "probe-rfc-receipt-validation.mjs"), "http://127.0.0.1:$Port/mcp", $Stage) `
        -WorkingDirectory $projectRoot -Environment $Environment -WindowStyle Hidden `
        -RedirectStandardOutput $OutputPath -RedirectStandardError $probeStderr -PassThru -Wait
    if ($probe.ExitCode -ne 0) {
        throw "RFC receipt $Stage probe failed with exit code $($probe.ExitCode): $(Get-Content -Raw $probeStderr -ErrorAction SilentlyContinue)"
    }
    return Get-Content -Raw -LiteralPath $OutputPath | ConvertFrom-Json
}

try {
    New-Item -ItemType Directory -Force -Path $testRoot, $stateRoot | Out-Null
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
    $node = (Get-Command node).Source
    $processEnvironment = @{
        ABAP_MCP_W200_PASSWORD = $plainPassword
        ABAP_MCP_CONFIG        = $configPath
        ABAP_MCP_PORT          = $Port.ToString()
        ABAP_MCP_STATE_DIR     = $stateRoot
    }

    $service = Start-McpValidationService -Node $node -Environment $processEnvironment `
        -Stdout (Join-Path $testRoot "first-stdout.log") -Stderr (Join-Path $testRoot "first-stderr.log")
    $first = Invoke-ReceiptProbe -Node $node -Environment $processEnvironment -Stage "first" `
        -OutputPath $firstResultPath
    Stop-McpValidationService $service
    $service = $null

    $service = Start-McpValidationService -Node $node -Environment $processEnvironment `
        -Stdout (Join-Path $testRoot "restart-stdout.log") -Stderr (Join-Path $testRoot "restart-stderr.log")
    $restart = Invoke-ReceiptProbe -Node $node -Environment $processEnvironment -Stage "restart" `
        -OutputPath $restartResultPath

    $result = [ordered]@{
        endpoint     = "http://127.0.0.1:$Port/mcp"
        connectionId = "w200"
        functionName = "ZCMCP_FM_1901"
        status       = "passed"
        first        = $first
        restart      = $restart
    }
    $resolvedResultPath = [IO.Path]::GetFullPath($ResultPath)
    $result | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $resolvedResultPath -Encoding utf8
    Get-Content -Raw -LiteralPath $resolvedResultPath
    Write-Host "`nResult: $resolvedResultPath"
}
finally {
    Stop-McpValidationService $service
    $plainPassword = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    Remove-Variable securePassword -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
