#requires -Version 7.0

param(
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$')]
    [string]$CandidateSuffix
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$packageJson = Get-Content -Raw (Join-Path $projectRoot "package.json") | ConvertFrom-Json
$artifactName = "orvanta-mcp-$($packageJson.version)-win-x64"
if ($CandidateSuffix) { $artifactName += "-$CandidateSuffix" }
$stagedPackageRoot = Join-Path $projectRoot "release\$artifactName"
$archivePath = "$stagedPackageRoot.zip"
$hashPath = "$archivePath.sha256"
$testRoot = Join-Path $env:TEMP ("abap-mcp-package-" + [guid]::NewGuid())
$allowedTempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd("\") + "\"
if (-not [IO.Path]::GetFullPath($testRoot).StartsWith($allowedTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Test directory must stay inside TEMP."
}

if (-not (Test-Path -LiteralPath $archivePath) -or -not (Test-Path -LiteralPath $hashPath)) {
    throw "Release archive or checksum file is missing."
}
$expectedHash = ((Get-Content -Raw $hashPath).Trim() -split "\s+")[0]
$actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
if ($expectedHash -notmatch "^[0-9a-fA-F]{64}$" -or $expectedHash -ne $actualHash) {
    throw "Release archive checksum verification failed."
}

$savedEnvironment = @{}
foreach ($name in @("ABAP_MCP_STATE_DIR", "ABAP_MCP_PORT", "UNSET_PORTABLE_VALIDATION_PASSWORD")) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}
$cmdTestRoot = $null
try {
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
$env:ABAP_MCP_STATE_DIR = Join-Path $testRoot "state"
$packageRoot = Join-Path $testRoot "Extracted Package"
Expand-Archive -LiteralPath $archivePath -DestinationPath $packageRoot
$buildInfo = Get-Content -Raw -LiteralPath (Join-Path $packageRoot "BUILD-INFO.json") | ConvertFrom-Json
$appPackage = Get-Content -Raw -LiteralPath (Join-Path $packageRoot "app\package.json") | ConvertFrom-Json
if ($buildInfo.version -ne $packageJson.version -or $appPackage.version -ne $packageJson.version) {
    throw "Source, manifest and packaged app versions must match."
}
if ($buildInfo.standaloneSourceCommit -notmatch "^[0-9a-f]{40}$" -or $buildInfo.standaloneSourceDirty -isnot [bool]) {
    throw "Standalone build provenance is missing."
}
if (Test-Path -LiteralPath (Join-Path $packageRoot "app\dist\test")) {
    throw "Production package must not ship compiled tests or failure workers."
}
$hashEntries = @($buildInfo.fileSha256.PSObject.Properties)
foreach ($required in @("app/dist/src/index.js", "app/dist/src/version.js", "app/scripts/bootstrap-sap-helper.ps1", "app/package-lock.json", "runtime/node.exe")) {
    if ($required -notin $hashEntries.Name) { throw "Missing manifest hash: $required" }
}
foreach ($entry in $hashEntries) {
    $file = [IO.Path]::GetFullPath((Join-Path $packageRoot $entry.Name))
    if (-not $file.StartsWith("$packageRoot$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)) {
        throw "Manifest path escapes package: $($entry.Name)"
    }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $entry.Value) {
        throw "Packaged file checksum mismatch: $($entry.Name)"
    }
}
foreach ($pair in @(
    @("scripts\bootstrap-sap-helper.ps1", "app\scripts\bootstrap-sap-helper.ps1"),
    @("dist\src\version.js", "app\dist\src\version.js"),
    @("package-lock.json", "app\package-lock.json")
)) {
    if ((Get-FileHash (Join-Path $projectRoot $pair[0])).Hash -ne (Get-FileHash (Join-Path $packageRoot $pair[1])).Hash) {
        throw "Package is stale relative to source: $($pair[0])"
    }
}
Write-Host "Package manifest: version $($buildInfo.version), $($hashEntries.Count) file hashes verified"
$packagedConfig = Join-Path $packageRoot "connections.json"
if (-not (Test-Path -LiteralPath $packagedConfig)) {
    throw "Release archive must contain connections.json."
}
$defaultConfig = Get-Content -Raw -LiteralPath $packagedConfig | ConvertFrom-Json
if ($defaultConfig.connections.Count -ne 1 -or $defaultConfig.connections[0].id -ne "w200") {
    throw "Release connections.json must contain the default w200 connection."
}
if ($defaultConfig.connections[0].PSObject.Properties.Name -contains "password") {
    throw "Release connections.json must not contain a password property."
}
$configPath = Join-Path $testRoot "connections.json"
$stdout = Join-Path $testRoot "stdout.log"
$stderr = Join-Path $testRoot "stderr.log"
$config = @{
    connections = @(
        @{
            id = "portable"
            url = "https://sap.example.invalid"
            client = "200"
            language = "EN"
            username = "VALIDATION"
            passwordEnv = "UNSET_PORTABLE_VALIDATION_PASSWORD"
            allowUnauthorized = $false
        }
    )
}
$config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath -Encoding utf8
Copy-Item -LiteralPath $configPath -Destination $packagedConfig

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()

$node = Join-Path $packageRoot "runtime\node.exe"
$probe = Join-Path $packageRoot "app\scripts\probe.mjs"
$launcher = Join-Path $packageRoot "start.ps1"
$cmdLauncher = Join-Path $packageRoot "start.cmd"
$codexConfigurer = Join-Path $packageRoot "configure-codex.ps1"
$helperInstaller = Join-Path $packageRoot "install-sap-helper.ps1"
$helperBootstrap = Join-Path $packageRoot "app\scripts\bootstrap-sap-helper.ps1"
$oneClickSetup = Join-Path $packageRoot "setup.ps1"
$oneClickUpdate = Join-Path $packageRoot "update.cmd"
$updateScript = Join-Path $packageRoot "update.ps1"
if (-not (Test-Path -LiteralPath $codexConfigurer)) {
    throw "configure-codex.ps1 is missing from the release archive."
}
if (-not (Test-Path -LiteralPath $helperInstaller) -or -not (Test-Path -LiteralPath $helperBootstrap)) {
    throw "SAP helper installer or bundled bootstrap is missing from the release archive."
}
if (-not (Test-Path -LiteralPath $oneClickSetup)) {
    throw "setup.ps1 is missing from the release archive."
}
if (-not (Test-Path -LiteralPath $oneClickUpdate) -or -not (Test-Path -LiteralPath $updateScript)) {
    throw "ORVANTA updater is missing from the release archive."
}
$launcherSource = Get-Content -Raw -LiteralPath $launcher
$cmdLauncherSource = Get-Content -Raw -LiteralPath $cmdLauncher
if (-not $launcherSource.StartsWith("#requires -Version 7.0")) {
    throw "start.ps1 must require PowerShell 7."
}
if ($launcherSource -match "powershell\.exe" -or $cmdLauncherSource -match "powershell\.exe") {
    throw "Launchers must not invoke Windows PowerShell 5.1."
}
$helperInstallerSource = Get-Content -Raw -LiteralPath $helperInstaller
if (-not $helperInstallerSource.StartsWith("#requires -Version 7.0") -or $helperInstallerSource -match "powershell\.exe") {
    throw "SAP helper installer must require PowerShell 7 and must not invoke Windows PowerShell 5.1."
}
$oneClickSetupSource = Get-Content -Raw -LiteralPath $oneClickSetup
if (-not $oneClickSetupSource.StartsWith("#requires -Version 7.0") -or $oneClickSetupSource -match "powershell\.exe") {
    throw "setup.ps1 must require PowerShell 7 and must not invoke Windows PowerShell 5.1."
}
$updateSource = Get-Content -Raw -LiteralPath $updateScript
if (-not $updateSource.StartsWith("#requires -Version 5.1") -or
    $updateSource -notmatch "releases/latest" -or
    $updateSource -notmatch "Get-FileHash" -or
    $updateSource -notmatch "Assert-OrvantaStopped") {
    throw "update.ps1 does not contain the required release, integrity and running-process gates."
}
if ($launcherSource -notmatch "Read-Host.+-AsSecureString" -or $launcherSource -notmatch "IsInputRedirected") {
    throw "start.ps1 must securely prompt for missing passwords and fail closed for redirected input."
}
$installerTestRoot = Join-Path $testRoot "installer"
$installerFakeRoot = Join-Path $installerTestRoot "app\scripts"
$installerFakeBootstrap = Join-Path $installerFakeRoot "bootstrap-sap-helper.ps1"
$installerConfig = Join-Path $installerTestRoot "connections.json"
New-Item -ItemType Directory -Force -Path $installerFakeRoot | Out-Null
@'
param(
    [string]$BaseUrl,
    [string]$Username,
    [string]$Client,
    [string]$Language,
    [string]$Action,
    [Security.SecureString]$SecurePassword,
    [switch]$AllowUnauthorized,
    [switch]$PassThru
)
if (-not $SecurePassword -or -not $PassThru) { throw "Secure pass-through contract missing." }
$writes = if ($Action -eq "DiagnoseHelperApis") {
    @(
        "HELPER Z_ORVANTA_MCP_EXECUTE EXISTS 0",
        "STATE Z_ORVANTA_MCP_EXECUTE X",
        "HELPER Z_ORVANTA_MCP_DYNPRO_API EXISTS 0",
        "STATE Z_ORVANTA_MCP_DYNPRO_API X X",
        "HELPER Z_ORVANTA_MCP_DDIC_API EXISTS 0",
        "STATE Z_ORVANTA_MCP_DDIC_API X"
    )
} else { @("SUBRC 0") }
[pscustomobject]@{
    Status = 200
    SoapFault = ""
    ErrorMessage = ""
    Writes = $writes
    BootstrapExitCode = 0
}
'@ | Set-Content -LiteralPath $installerFakeBootstrap -Encoding utf8
$installerListener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$installerListener.Start()
$installerPort = ([Net.IPEndPoint]$installerListener.LocalEndpoint).Port
@{
    connections = @(
        @{
            id = "package"
            url = "http://127.0.0.1:$installerPort"
            client = "200"
            language = "EN"
            username = "VALIDATION"
            passwordEnv = "ABAP_MCP_PACKAGE_PASSWORD"
            allowUnauthorized = $false
        }
    )
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $installerConfig -Encoding utf8
try {
    $installerPassword = ConvertTo-SecureString "validation-only" -AsPlainText -Force
    $installerResult = & $helperInstaller -Mode preflight -ConnectionId package -ConfigPath $installerConfig -BootstrapScriptPath $installerFakeBootstrap -SecurePassword $installerPassword | ConvertFrom-Json
    if (-not $installerResult.status.ready) {
        throw "Packaged SAP helper preflight did not report ready."
    }
} finally {
    $installerListener.Stop()
}
$nodeVersion = (& $node --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -ne "v$($buildInfo.nodeVersion)") {
    throw "Unexpected packaged Node.js version: $nodeVersion"
}

$beforeCode = @(Get-Process Code -ErrorAction SilentlyContinue).Id
$pwsh = (Get-Process -Id $PID).Path
$env:UNSET_PORTABLE_VALIDATION_PASSWORD = "validation-only"
$process = $null
try {
    $process = Start-Process -FilePath $pwsh -ArgumentList "-NoLogo", "-NoProfile", "-File", "`"$launcher`"", "-Port", $port -WorkingDirectory $packageRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $health = $null
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 250
        try {
            $health = Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 2
            break
        } catch {}
    }
    if (-not $health) {
        throw "Packaged service did not become healthy: $(Get-Content $stderr -Raw -ErrorAction SilentlyContinue)"
    }

    $probeOutput = & $node $probe "http://127.0.0.1:$port/mcp" 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Packaged MCP probe failed: $($probeOutput -join [Environment]::NewLine)"
    }
    $probeResult = ($probeOutput -join [Environment]::NewLine) | ConvertFrom-Json
    # Tool count comes from the packaged registry instead of a frozen number, so adding or
    # removing a tool cannot silently fail this smoke test (it used to assert 121 of 126).
    $registryUrl = "file:///" + (Join-Path $packageRoot "app\dist\src\tool-registry.js").Replace("\", "/")
    $packagedToolCount = & $node --input-type=module -e "const m = await import('$registryUrl'); console.log(m.TOOL_COUNT)"
    if ($LASTEXITCODE -ne 0 -or -not $packagedToolCount) {
        throw "Cannot read the packaged tool registry: $packagedToolCount"
    }
    $expectedToolCount = [int]("$packagedToolCount".Trim())
    if ($probeResult.tools.Count -ne $expectedToolCount -or "prepare_enhancement_configuration_workflow" -notin $probeResult.tools -or "search_sap_locks" -notin $probeResult.tools -or "search_failed_updates" -notin $probeResult.tools -or "read_failed_update" -notin $probeResult.tools -or "get_runtime_info" -notin $probeResult.tools -or "preview_source_changes" -notin $probeResult.tools -or "read_abap_table" -notin $probeResult.tools -or "read_ddic_table_conversion_status" -notin $probeResult.tools -or "patch_ddic_transparent_table_settings" -notin $probeResult.tools -or "recover_ddic_table_conversion" -notin $probeResult.tools -or "correlate_sap_logs" -notin $probeResult.tools -or "read_system_logs" -notin $probeResult.tools -or "read_background_job_log" -notin $probeResult.tools -or "search_background_jobs" -notin $probeResult.tools -or "discover_application_logs" -notin $probeResult.tools -or "search_application_logs" -notin $probeResult.tools -or "read_application_log" -notin $probeResult.tools -or "diagnose_sap_failure" -notin $probeResult.tools -or "run_sci_analysis" -notin $probeResult.tools -or "patch_function_module_interface" -notin $probeResult.tools -or
        @($probeResult.connected | Where-Object { $_.type -eq "text" -and $_.text -eq "Connected SAP systems: portable" }).Count -ne 1) {
        throw "Packaged MCP tool count, M1 tool or configured-system response is incorrect."
    }

    $afterCode = @(Get-Process Code -ErrorAction SilentlyContinue).Id
    $newCode = @($afterCode | Where-Object { $_ -notin $beforeCode })
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($process.Id)" -ErrorAction SilentlyContinue)
    $nodeChildren = @($children | Where-Object { $_.Name -eq "node.exe" })
    $unexpectedChildren = @($children | Where-Object { $_.Name -notin @("conhost.exe", "node.exe") })
    if ($nodeChildren.Count -ne 1) {
        throw "PowerShell 7 launcher did not start exactly one packaged Node.js process."
    }
    if ($newCode.Count -ne 0 -or $unexpectedChildren.Count -ne 0) {
        throw "Portable package started an editor or unexpected child process."
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        if ($archive.Entries.FullName -notcontains "connections.json") {
            throw "Release archive must contain connections.json."
        }
        foreach ($entry in @("install-sap-helper.ps1", "setup.ps1", "update.cmd", "update.ps1", "app/scripts/bootstrap-sap-helper.ps1")) {
            if ($archive.Entries.FullName -notcontains $entry) {
                throw "Release archive must contain $entry."
            }
        }
    } finally {
        $archive.Dispose()
    }

    Write-Host "Node         : $nodeVersion"
    Write-Host "Launcher     : PowerShell $($PSVersionTable.PSVersion) / start.ps1"
    Write-Host "Health       : $($health.status) / $($health.server)"
    Write-Host "Code.exe new : $($newCode.Count)"
    Write-Host "Child process: $($children.Count) allowed, $($unexpectedChildren.Count) unexpected"
    Write-Host "Archive SHA256: $actualHash"
    Write-Host "Helper preflight: ready (controlled backend)"
    $probeOutput
} finally {
    if ($process) {
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($process.Id)" -ErrorAction SilentlyContinue)
    foreach ($child in $children) {
        Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue
    }
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force
    }
    $process.WaitForExit()
    $process.Dispose()
    }
    Remove-Item -LiteralPath $packagedConfig -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}

$cmdTestRoot = Join-Path $env:TEMP ("abap-mcp-cmd-" + [guid]::NewGuid())
if (-not [IO.Path]::GetFullPath($cmdTestRoot).StartsWith($allowedTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "CMD test directory must stay inside TEMP."
}
New-Item -ItemType Directory -Force -Path $cmdTestRoot | Out-Null
$cmdPackageRoot = Join-Path $cmdTestRoot "Extracted Package"
Expand-Archive -LiteralPath $archivePath -DestinationPath $cmdPackageRoot
$env:ABAP_MCP_STATE_DIR = Join-Path $cmdTestRoot "state"
$cmdConfig = Join-Path $cmdPackageRoot "connections.json"
$cmdStdout = Join-Path $cmdTestRoot "stdout.log"
$cmdStderr = Join-Path $cmdTestRoot "stderr.log"
$config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $cmdConfig -Encoding utf8
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$cmdPort = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()
$env:ABAP_MCP_PORT = $cmdPort.ToString()
$cmdPath = Join-Path $cmdPackageRoot "start.cmd"
$cmdProcess = $null
try {
    $cmdProcess = Start-Process -FilePath $env:ComSpec -ArgumentList "/d", "/c", "`"$cmdPath`"" -WorkingDirectory $cmdPackageRoot -WindowStyle Hidden -RedirectStandardOutput $cmdStdout -RedirectStandardError $cmdStderr -PassThru
    $cmdHealth = $null
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 250
        try {
            $cmdHealth = Invoke-RestMethod "http://127.0.0.1:$cmdPort/health" -TimeoutSec 2
            break
        } catch {}
    }
    if (-not $cmdHealth) {
        throw "start.cmd did not launch the packaged service: $(Get-Content $cmdStderr -Raw -ErrorAction SilentlyContinue)"
    }
    $cmdChildren = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($cmdProcess.Id)" -ErrorAction SilentlyContinue)
    if (@($cmdChildren | Where-Object { $_.Name -eq "node.exe" }).Count -ne 1) {
        throw "start.cmd did not start exactly one packaged Node.js process."
    }
    Write-Host "CMD launcher : $($cmdHealth.status) / $($cmdHealth.server)"
} finally {
    if ($cmdProcess) {
    $cmdChildren = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($cmdProcess.Id)" -ErrorAction SilentlyContinue)
    foreach ($child in $cmdChildren) {
        Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue
    }
    if (-not $cmdProcess.HasExited) {
        try {
            $cmdProcess.Kill()
        } catch {
            # Killing the child can make cmd exit between the check and Kill.
            if (-not $cmdProcess.HasExited) { throw }
        }
    }
    $cmdProcess.WaitForExit()
    $cmdProcess.Dispose()
    }
    Remove-Item -LiteralPath $cmdTestRoot -Recurse -Force -ErrorAction SilentlyContinue
}
} finally {
    foreach ($name in $savedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], "Process")
    }
    foreach ($root in @($testRoot, $cmdTestRoot)) {
        if ($root -and (Test-Path -LiteralPath $root)) {
            $resolved = [IO.Path]::GetFullPath($root)
            if (-not $resolved.StartsWith($allowedTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Cleanup directory must stay inside TEMP."
            }
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
    }
}
