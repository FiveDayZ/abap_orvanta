#requires -Version 7.0

param(
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$')]
    [string]$CandidateSuffix
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json).version
$artifactName = "orvanta-mcp-$version-win-x64"
if ($CandidateSuffix) { $artifactName += "-$CandidateSuffix" }
$root = Join-Path $env:TEMP ("abap-settings-package-" + [guid]::NewGuid())
$resolvedRoot = [IO.Path]::GetFullPath($root)
if (-not $resolvedRoot.StartsWith([IO.Path]::GetFullPath($env:TEMP).TrimEnd("\") + "\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "Test root must stay inside TEMP."
}
$packageRoot = Join-Path $root "Extracted Package"
$process = $null
try {
    $archivePath = Join-Path $projectRoot "release\$artifactName.zip"
    $expectedHash = ((Get-Content -Raw -LiteralPath "$archivePath.sha256").Trim() -split "\s+")[0]
    if ($expectedHash -notmatch "^[0-9a-fA-F]{64}$" -or (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $expectedHash) {
        throw "Release archive checksum verification failed."
    }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $packageRoot
    $configPath = Join-Path $packageRoot "connections.json"
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = "powershell.exe"
    $info.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $packageRoot 'open-settings.ps1')`" -NoBrowser"
    $info.WorkingDirectory = $packageRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.Environment["ABAP_MCP_STATE_DIR"] = Join-Path $root "state"
    $process = [Diagnostics.Process]::Start($info)
    $line = $process.StandardOutput.ReadLineAsync()
    if (-not $line.Wait(20000)) { throw "Packaged settings launcher did not become ready." }
    $url = [uri](($line.Result | ConvertFrom-Json).url)
    $base = $url.GetLeftPart([UriPartial]::Authority)
    $headers = @{ Authorization = "Bearer " + $url.Fragment.TrimStart("#"); Origin = $base }
    function Invoke-Settings([string]$Route, $Body) {
        Invoke-RestMethod "$base/api/$Route" -Method Post -Headers $headers -ContentType "application/json" -Body ($Body | ConvertTo-Json -Depth 8) -TimeoutSec 20
    }
    $state = Invoke-RestMethod "$base/api/state" -Headers $headers
    if ($state.version -ne $version) { throw "Wrong settings version." }
    foreach ($asset in @("/", "/app.js", "/style.css", "/icons/server.svg")) {
        if ((Invoke-WebRequest "$base$asset").StatusCode -ne 200) { throw "Missing browser asset: $asset" }
    }
    $connection = @{
        id = "portable"; url = "https://sap.example.invalid"; client = "200"; language = "EN"
        username = "VALIDATION"; passwordEnv = "ABAP_MCP_PACKAGE_UI"; allowUnauthorized = $false
        remoteFunctionAllowlist = @()
    }
    $saved = Invoke-Settings config @{ revision = $state.revision; connections = @($connection) }
    $null = Invoke-Settings password @{ connectionId = "portable"; password = "package-test-only" }
    $rawConfig = Get-Content $configPath -Raw
    if ($rawConfig.Contains("package-test-only")) { throw "Password was persisted." }
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    $listener.Stop()
    $started = Invoke-Settings start @{ port = $port }
    if (-not $started.state.service.running) { throw "Packaged settings did not start MCP." }
    $probe = & (Join-Path $packageRoot "runtime\node.exe") (Join-Path $packageRoot "app\scripts\probe.mjs") $started.state.service.url
    if ($LASTEXITCODE -ne 0 -or ($probe | ConvertFrom-Json).tools.Count -ne 121) { throw "MCP probe through settings failed." }
    $null = Invoke-Settings stop @{}
    $null = Invoke-Settings exit @{}
    if (-not $process.WaitForExit(15000) -or $process.ExitCode -ne 0) { throw "Settings launcher did not exit cleanly." }
    Write-Output "Settings package PASS: Windows PowerShell launcher, browser assets, config save, memory-only password, MCP start/121 tools/stop, settings exit."
} finally {
    if ($process -and -not $process.HasExited) {
        foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($process.Id)")) {
            Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue
        }
        $process.Kill()
        $process.WaitForExit()
    }
    if ($process) { $process.Dispose() }
    if (Test-Path -LiteralPath $resolvedRoot) { Remove-Item -LiteralPath $resolvedRoot -Recurse -Force }
}
