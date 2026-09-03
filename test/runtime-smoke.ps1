$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path $env:TEMP ("abap-mcp-runtime-" + [guid]::NewGuid())
$port = 4857
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null

$configPath = Join-Path $testRoot "connections.json"
$stdout = Join-Path $testRoot "stdout.log"
$stderr = Join-Path $testRoot "stderr.log"
$config = @{
    connections = @(
        @{
            id = "validation"
            url = "https://sap.example.invalid"
            client = "200"
            language = "EN"
            username = "VALIDATION"
            passwordEnv = "UNSET_VALIDATION_VARIABLE"
            allowUnauthorized = $false
        }
    )
}
$config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath -Encoding utf8

$beforeCode = @(Get-Process Code -ErrorAction SilentlyContinue).Id
$env:ABAP_MCP_CONFIG = $configPath
$env:ABAP_MCP_PORT = $port.ToString()
$node = (Get-Command node).Source
$process = Start-Process `
    -FilePath $node `
    -ArgumentList "dist/src/index.js" `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -PassThru

try {
    $health = $null
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 250
        try {
            $health = Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 2
            break
        } catch {}
    }
    if (-not $health) {
        throw "Service did not become healthy: $(Get-Content $stderr -Raw -ErrorAction SilentlyContinue)"
    }

    $probe = & $node (Join-Path $projectRoot "scripts/probe.mjs") "http://127.0.0.1:$port/mcp" 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Probe failed: $($probe -join [Environment]::NewLine)"
    }

    $afterCode = @(Get-Process Code -ErrorAction SilentlyContinue).Id
    $newCode = @($afterCode | Where-Object { $_ -notin $beforeCode })
    $children = @(
        Get-CimInstance Win32_Process -Filter "ParentProcessId = $($process.Id)" `
            -ErrorAction SilentlyContinue
    )
    $unexpectedChildren = @($children | Where-Object { $_.Name -ne "conhost.exe" })
    if ($newCode.Count -ne 0) {
        throw "Standalone service started $($newCode.Count) unexpected Code.exe process(es)."
    }
    if ($unexpectedChildren.Count -ne 0) {
        $names = ($unexpectedChildren.Name | Sort-Object -Unique) -join ", "
        throw "Standalone service started unexpected child process(es): $names"
    }

    Write-Host "Health       : $($health.status) / $($health.server)"
    Write-Host "Service PID  : $($process.Id)"
    Write-Host "Code.exe new : $($newCode.Count)"
    Write-Host "Child process: $($children.Count) system host, $($unexpectedChildren.Count) unexpected"
    $probe
} finally {
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force
    }
    Remove-Item Env:ABAP_MCP_CONFIG, Env:ABAP_MCP_PORT -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
