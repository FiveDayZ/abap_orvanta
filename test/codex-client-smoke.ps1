#requires -Version 7.0

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$packageJson = Get-Content -Raw (Join-Path $projectRoot "package.json") | ConvertFrom-Json
$archivePath = Join-Path $projectRoot "release\orvanta-mcp-$($packageJson.version)-win-x64.zip"
$testRoot = Join-Path $env:TEMP ("abap-mcp-codex-client-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
$packageRoot = Join-Path $testRoot "Extracted Package"
Expand-Archive -LiteralPath $archivePath -DestinationPath $packageRoot

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

$previousConfig = $env:ABAP_MCP_CONFIG
$previousPort = $env:ABAP_MCP_PORT
$env:ABAP_MCP_CONFIG = $configPath
$env:ABAP_MCP_PORT = $port.ToString()
$node = Join-Path $packageRoot "runtime\node.exe"
$entry = Join-Path $packageRoot "app\dist\src\index.js"
$process = Start-Process -FilePath $node -ArgumentList "`"$entry`"" -WorkingDirectory $packageRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru

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

    $override = "mcp_servers.orvanta.url=`"http://127.0.0.1:$port/mcp`""
    $prompt = "Call the orvanta MCP tool get_connected_systems exactly once. Do not run shell commands. Return only the tool's text result."
    $events = & codex exec --json --skip-git-repo-check -C $projectRoot -c $override -c "mcp_servers.orvanta.enabled=true" -c "mcp_servers.abap_fs.enabled=false" -c "mcp_servers.abap_fs_standalone.enabled=false" $prompt 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Codex CLI execution failed: $($events -join [Environment]::NewLine)"
    }
    $parsedEvents = @($events | ForEach-Object {
        try { "$_" | ConvertFrom-Json -ErrorAction Stop } catch {}
    })
    $calls = @($parsedEvents | Where-Object { $_.type -eq "item.completed" -and $_.item.type -eq "mcp_tool_call" })
    $expectedCalls = @($calls | Where-Object {
        $_.item.server -eq "orvanta" -and $_.item.tool -eq "get_connected_systems" -and
        $_.item.status -eq "completed" -and
        @($_.item.result.content | Where-Object { $_.type -eq "text" -and $_.text -eq "Connected SAP systems: codex" }).Count -eq 1
    })
    $commands = @($parsedEvents | Where-Object { $_.item.type -eq "command_execution" })
    if ($expectedCalls.Count -ne 1 -or $calls.Count -ne 1 -or $commands.Count -ne 0) {
        $events
        throw "Codex CLI did not call the expected MCP tool or return its result."
    }
    Write-Host "Codex client MCP call PASS"
    $events
} finally {
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force
    }
    $env:ABAP_MCP_CONFIG = $previousConfig
    $env:ABAP_MCP_PORT = $previousPort
    $resolvedRoot = [IO.Path]::GetFullPath($testRoot)
    $allowedRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd("\") + "\"
    if (-not $resolvedRoot.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing cleanup outside TEMP."
    }
    Remove-Item -LiteralPath $resolvedRoot -Recurse -Force -ErrorAction SilentlyContinue
}
