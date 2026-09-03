#requires -Version 7.0

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$packageJson = Get-Content -Raw (Join-Path $projectRoot "package.json") | ConvertFrom-Json
$packageRoot = Join-Path $projectRoot "release\abap-mcp-standalone-$($packageJson.version)-win-x64"
$testRoot = Join-Path $env:TEMP ("abap-mcp-codex-client-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()

$configPath = Join-Path $testRoot "connections.json"
$stdout = Join-Path $testRoot "service-out.log"
$stderr = Join-Path $testRoot "service-err.log"
@{
    connections = @(
        @{
            id = "codex"
            url = "https://sap.example.invalid"
            client = "200"
            language = "EN"
            username = "VALIDATION"
            passwordEnv = "UNSET_CODEX_CLIENT_PASSWORD"
            allowUnauthorized = $false
        }
    )
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath -Encoding utf8

$env:ABAP_MCP_CONFIG = $configPath
$env:ABAP_MCP_PORT = $port.ToString()
$node = Join-Path $packageRoot "runtime\node.exe"
$entry = Join-Path $packageRoot "app\dist\src\index.js"
$process = Start-Process -FilePath $node -ArgumentList $entry -WorkingDirectory $packageRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru

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

    $override = "mcp_servers.abap_fs.url=`"http://127.0.0.1:$port/mcp`""
    $prompt = "Call the abap_fs MCP tool get_connected_systems exactly once. Do not run shell commands. Return only the tool's text result."
    $events = & codex exec --json --skip-git-repo-check -C $projectRoot -c $override -c "mcp_servers.abap_fs_standalone.enabled=false" $prompt 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Codex CLI execution failed: $($events -join [Environment]::NewLine)"
    }
    $eventText = $events -join [Environment]::NewLine
    if ($eventText -notmatch "get_connected_systems" -or $eventText -notmatch "Connected SAP systems: codex") {
        throw "Codex CLI did not call the expected MCP tool or return its result."
    }
    Write-Host "Codex client MCP call PASS"
    $events
} finally {
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force
    }
    Remove-Item Env:ABAP_MCP_CONFIG, Env:ABAP_MCP_PORT -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
