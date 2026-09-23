#requires -Version 7.0

[CmdletBinding()]
param(
    [int]$Port = 0,
    [string]$ResultPath = (Join-Path $env:TEMP "sap-ecc-fallback-validation-0260.json"),
    [string]$BaseUrl,
    [string]$Username
)

$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "MCP 0.26.0 ECC Fallback Validation"
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "get-base-connections.ps1")
$baseConnections = Get-BaseConnections -ProjectRoot $projectRoot
Assert-BaseConnectionsUsable -Info $baseConnections `
    -EndpointOverride $BaseUrl -UsernameOverride $Username
$sapBaseUrl = if ($BaseUrl) { $BaseUrl } else { $baseConnections.Connection.url }
$sapUsername = if ($Username) { $Username } else { $baseConnections.Connection.username }
$configPath = $baseConnections.Path
$stdout = Join-Path $env:TEMP "abap-mcp-0260-stdout.log"
$stderr = Join-Path $env:TEMP "abap-mcp-0260-stderr.log"
$probeStderr = Join-Path $env:TEMP "abap-mcp-0260-probe-stderr.log"
$securePassword = Read-Host "Password for $sapUsername" -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
$plainPassword = $null
$service = $null

function Invoke-RepositoryBootstrap {
    param(
        [Parameter(Mandatory)]
        [ValidateSet("RepairRepositoryApi", "DiagnoseRepositoryApi")]
        [string]$Action,

        [Parameter(Mandatory)]
        [Security.SecureString]$Password
    )

    $result = & (Join-Path $PSScriptRoot "bootstrap-sap-helper.ps1") `
        -BaseUrl $sapBaseUrl `
        -Username $sapUsername `
        -Client "200" `
        -Language "EN" `
        -Action $Action `
        -SecurePassword $Password `
        -PassThru
    if (
        -not $result -or
        $result.BootstrapExitCode -ne 0 -or
        $result.Error -or
        $result.SoapFault -or
        $result.ErrorMessage
    ) {
        $detail = @($result.Error, $result.SoapFault, $result.ErrorMessage) |
            Where-Object { $_ } |
            Select-Object -First 1
        throw "$Action failed: $detail"
    }
    return $result
}

function Test-RepositoryApiReady {
    param([string[]]$Writes)

    $normalized = @($Writes | ForEach-Object { ([string]$_ -replace '\s+', ' ').Trim() })
    return (
        @($normalized | Where-Object { $_ -eq "FUNCTION_EXISTS 0" }).Count -eq 1 -and
        @($normalized | Where-Object { $_ -eq "GENERATED X" }).Count -eq 1 -and
        @($normalized | Where-Object { $_ -eq "ACTIVE X" }).Count -eq 1 -and
        @($normalized | Where-Object { $_ -eq "SOURCE_SUBRC 0" }).Count -eq 1
    )
}

try {
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    if ([string]::IsNullOrEmpty($plainPassword)) { throw "Password cannot be empty." }
    Set-Location -LiteralPath $projectRoot
    npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE." }

    $repair = Invoke-RepositoryBootstrap -Action "RepairRepositoryApi" -Password $securePassword
    $repair | ConvertTo-Json -Depth 5

    $repositoryReady = $false
    $diagnostic = $null
    for ($attempt = 1; $attempt -le 10; $attempt++) {
        $diagnostic = Invoke-RepositoryBootstrap `
            -Action "DiagnoseRepositoryApi" `
            -Password $securePassword
        if (Test-RepositoryApiReady -Writes $diagnostic.Writes) {
            $repositoryReady = $true
            break
        }
        Start-Sleep -Seconds 1
    }
    if (-not $repositoryReady) {
        $state = @($diagnostic.Writes) -join "; "
        throw "Repository helper did not become callable after repair: $state"
    }
    Write-Host "Repository helper is generated, active, and source-readable."

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
            throw "0.26.0 service exited before health check: $(Get-Content -Raw $stderr -ErrorAction SilentlyContinue)"
        }
        try {
            $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2
            break
        }
        catch {}
    }
    if (-not $health) {
        throw "0.26.0 service did not start: $(Get-Content -Raw $stderr -ErrorAction SilentlyContinue)"
    }

    $resolvedResultPath = [IO.Path]::GetFullPath($ResultPath)
    Remove-Item -LiteralPath $resolvedResultPath, $probeStderr -Force -ErrorAction SilentlyContinue
    $probe = Start-Process -FilePath $node `
        -ArgumentList (Join-Path $PSScriptRoot "probe-ecc-fallback-wave.mjs") `
        -WorkingDirectory $projectRoot -Environment $processEnvironment -WindowStyle Hidden `
        -RedirectStandardOutput $resolvedResultPath -RedirectStandardError $probeStderr `
        -PassThru -Wait
    $resultText = Get-Content -Raw $resolvedResultPath -ErrorAction SilentlyContinue
    Write-Output $resultText
    Write-Host "`nResult: $resolvedResultPath"
    if ($probe.ExitCode -ne 0) {
        $probeError = Get-Content -Raw $probeStderr -ErrorAction SilentlyContinue
        $detail = if ([string]::IsNullOrWhiteSpace($probeError)) { $resultText } else { $probeError }
        throw "ECC fallback validation failed with exit code $($probe.ExitCode): $detail"
    }
}
finally {
    if ($service -and -not $service.HasExited) {
        Stop-Process -Id $service.Id -Force -ErrorAction SilentlyContinue
    }
    $plainPassword = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    Remove-Variable securePassword -ErrorAction SilentlyContinue
}
