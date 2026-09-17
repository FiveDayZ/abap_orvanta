#requires -Version 7.0

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
$packageRoot = Join-Path $root "release/abap-mcp-standalone-$version-win-x64"
$output = [IO.Path]::GetFullPath((Join-Path $root ("../.doc/full-row-user-" + (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + [guid]::NewGuid().ToString("N").Substring(0,8))))
$temp = Join-Path $env:TEMP ("orvanta-full-row-" + [guid]::NewGuid())
$allowedTemp = [IO.Path]::GetFullPath($env:TEMP).TrimEnd("\") + "\"
if (-not [IO.Path]::GetFullPath($temp).StartsWith($allowedTemp, [StringComparison]::OrdinalIgnoreCase)) { throw "Invalid TEMP path." }
New-Item -ItemType Directory -Path $output, $temp | Out-Null
$report = [ordered]@{ startedAt=(Get-Date).ToString("o"); status="Failed"; version=$version; sapBusinessWrites=$false; existingServiceSwitched=$false }
$server = $null
$savedUrl = $env:ABAP_MCP_URL
$savedReport = $env:ORVANTA_FULL_ROW_REPORT
Push-Location $root
try {
    $archive = "$packageRoot.zip"
    $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
    $expected = ((Get-Content -LiteralPath "$archive.sha256" -Raw).Trim() -split "\s+")[0]
    if ($hash -ne $expected) { throw "Candidate ZIP checksum mismatch." }
    $report.archiveSha256 = $hash
    $report.archive = $archive
    # Execute an extracted copy of the checked archive, not the mutable staging directory.
    $copy = Join-Path $temp "package"
    Expand-Archive -LiteralPath $archive -DestinationPath $copy
    $node = Join-Path $copy "runtime/node.exe"
    & $node node_modules/typescript/bin/tsc *> (Join-Path $output "build.log")
    $report.buildExitCode = $LASTEXITCODE
    if ($LASTEXITCODE -ne 0) { throw "Local build failed." }
    & $node --test dist/test/table-query.test.js dist/test/table-query-compatibility.test.js dist/test/table-query-full-rows.test.js dist/test/data-query.test.js *> (Join-Path $output "tests.log")
    $report.testsExitCode = $LASTEXITCODE
    if ($LASTEXITCODE -ne 0) { throw "Local regression failed; see tests.log. No live query was run." }
    $config = Get-Content -LiteralPath (Join-Path $copy "connections.json") -Raw | ConvertFrom-Json
    if ($config.connections.Count -ne 1 -or $config.connections[0].id -ne "w200" -or $config.connections[0].client -ne "200") { throw "Unexpected candidate connection." }
    $connection = $config.connections[0]
    $secure = Read-Host "SAP password for $($connection.username)@w200 (memory only)" -AsSecureString
    $credential = [PSCredential]::new("unused", $secure)
    $password = $credential.GetNetworkCredential().Password
    if (-not $password) { throw "Password cannot be empty." }
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    $listener.Stop()
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $node
    $info.ArgumentList.Add((Join-Path $copy "app/dist/src/index.js"))
    $info.WorkingDirectory = $copy
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.Environment["ABAP_MCP_CONFIG"] = Join-Path $copy "connections.json"
    $info.Environment["ABAP_MCP_STATE_DIR"] = Join-Path $temp "state"
    $info.Environment["ABAP_MCP_PORT"] = "$port"
    $info.Environment[$connection.passwordEnv] = $password
    $server = [Diagnostics.Process]::Start($info)
    $info.Environment.Remove($connection.passwordEnv) | Out-Null
    $password = $null
    $credential = $null
    $secure = $null
    $ready = $server.StandardOutput.ReadLineAsync()
    if (-not $ready.Wait(20000) -or $ready.Result -ne "ORVANTA listening at http://127.0.0.1:$port/mcp") { throw "Isolated candidate did not become ready." }
    $env:ABAP_MCP_URL = "http://127.0.0.1:$port/mcp"
    $env:ORVANTA_FULL_ROW_REPORT = Join-Path $output "full-rows.json"
    & $node scripts/probe-full-row-query.mjs *> (Join-Path $output "probe.log")
    $report.liveExitCode = $LASTEXITCODE
    $report.fullRowsReport = $env:ORVANTA_FULL_ROW_REPORT
    if ($LASTEXITCODE -ne 0) { throw "Full-row query failed; see full-rows.json." }
    $live = Get-Content -LiteralPath $env:ORVANTA_FULL_ROW_REPORT -Raw | ConvertFrom-Json
    if ($live.status -ne "Passed" -or $live.valuesReturned -ne 550) { throw "Incomplete full-row evidence." }
    $report.status = "Passed"
} catch {
    $report.failure = $_.Exception.Message
    Write-Warning $report.failure
} finally {
    if ($server) {
        if (-not $server.HasExited) { $server.Kill() }
        $server.WaitForExit()
        $server.Dispose()
    }
    $env:ABAP_MCP_URL = $savedUrl
    $env:ORVANTA_FULL_ROW_REPORT = $savedReport
    Pop-Location
    $resolved = [IO.Path]::GetFullPath($temp)
    if ($resolved.StartsWith($allowedTemp, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
    $report.finishedAt = (Get-Date).ToString("o")
    $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $output "result.json") -Encoding utf8
    Write-Host "Result: $($report.status)"
    Write-Host "Report: $(Join-Path $output 'result.json')"
}
if ($report.status -ne "Passed") { exit 1 }
