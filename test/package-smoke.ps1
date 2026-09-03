#requires -Version 7.0

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$packageJson = Get-Content -Raw (Join-Path $projectRoot "package.json") | ConvertFrom-Json
$artifactName = "abap-mcp-standalone-$($packageJson.version)-win-x64"
$stagedPackageRoot = Join-Path $projectRoot "release\$artifactName"
$archivePath = "$stagedPackageRoot.zip"
$hashPath = "$archivePath.sha256"
$testRoot = Join-Path $env:TEMP ("abap-mcp-package-" + [guid]::NewGuid())

if (-not (Test-Path -LiteralPath (Join-Path $stagedPackageRoot "runtime\node.exe"))) {
    throw "Packaged Node.js runtime not found. Run npm run package:windows first."
}
if (-not (Test-Path -LiteralPath $archivePath) -or -not (Test-Path -LiteralPath $hashPath)) {
    throw "Release archive or checksum file is missing."
}

New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
$packageRoot = Join-Path $testRoot "Extracted Package"
Expand-Archive -LiteralPath $archivePath -DestinationPath $packageRoot
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
if (-not (Test-Path -LiteralPath $codexConfigurer)) {
    throw "configure-codex.ps1 is missing from the release archive."
}
if (-not (Test-Path -LiteralPath $helperInstaller) -or -not (Test-Path -LiteralPath $helperBootstrap)) {
    throw "SAP helper installer or bundled bootstrap is missing from the release archive."
}
if (-not (Test-Path -LiteralPath $oneClickSetup)) {
    throw "setup.ps1 is missing from the release archive."
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
        "HELPER Z_CODEX_MCP_EXECUTE EXISTS 0",
        "STATE Z_CODEX_MCP_EXECUTE X",
        "HELPER Z_CODEX_MCP_DYNPRO_API EXISTS 0",
        "STATE Z_CODEX_MCP_DYNPRO_API X X",
        "HELPER Z_CODEX_MCP_DDIC_API EXISTS 0",
        "STATE Z_CODEX_MCP_DDIC_API X"
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
if ($LASTEXITCODE -ne 0 -or $nodeVersion -ne "v24.8.0") {
    throw "Unexpected packaged Node.js version: $nodeVersion"
}

$beforeCode = @(Get-Process Code -ErrorAction SilentlyContinue).Id
$pwsh = (Get-Process -Id $PID).Path
$env:UNSET_PORTABLE_VALIDATION_PASSWORD = "validation-only"
$process = Start-Process -FilePath $pwsh -ArgumentList "-NoLogo", "-NoProfile", "-File", "`"$launcher`"", "-Port", $port -WorkingDirectory $packageRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru

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
        throw "Packaged service did not become healthy: $(Get-Content $stderr -Raw -ErrorAction SilentlyContinue)"
    }

    $probeOutput = & $node $probe "http://127.0.0.1:$port/mcp" 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Packaged MCP probe failed: $($probeOutput -join [Environment]::NewLine)"
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

    $expectedHash = ((Get-Content -Raw $hashPath).Trim() -split "\s+")[0]
    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
    if ($expectedHash -ne $actualHash) {
        throw "Release archive checksum verification failed."
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        if ($archive.Entries.FullName -notcontains "connections.json") {
            throw "Release archive must contain connections.json."
        }
        foreach ($entry in @("install-sap-helper.ps1", "setup.ps1", "app/scripts/bootstrap-sap-helper.ps1")) {
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
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($process.Id)" -ErrorAction SilentlyContinue)
    foreach ($child in $children) {
        Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue
    }
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force
    }
    Remove-Item -LiteralPath $packagedConfig -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}

$cmdTestRoot = Join-Path $env:TEMP ("abap-mcp-cmd-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $cmdTestRoot | Out-Null
$cmdConfig = Join-Path $stagedPackageRoot "connections.json"
$defaultCmdConfig = [IO.File]::ReadAllBytes($cmdConfig)
$cmdStdout = Join-Path $cmdTestRoot "stdout.log"
$cmdStderr = Join-Path $cmdTestRoot "stderr.log"
$config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $cmdConfig -Encoding utf8
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$cmdPort = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()
$env:ABAP_MCP_PORT = $cmdPort.ToString()
$cmdPath = Join-Path $stagedPackageRoot "start.cmd"
$cmdProcess = Start-Process -FilePath $env:ComSpec -ArgumentList "/d", "/c", "`"$cmdPath`"" -WorkingDirectory $stagedPackageRoot -WindowStyle Hidden -RedirectStandardOutput $cmdStdout -RedirectStandardError $cmdStderr -PassThru

try {
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
    $cmdChildren = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($cmdProcess.Id)" -ErrorAction SilentlyContinue)
    foreach ($child in $cmdChildren) {
        Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue
    }
    if (-not $cmdProcess.HasExited) {
        Stop-Process -Id $cmdProcess.Id -Force
    }
    Remove-Item Env:ABAP_MCP_PORT -ErrorAction SilentlyContinue
    Remove-Item Env:UNSET_PORTABLE_VALIDATION_PASSWORD -ErrorAction SilentlyContinue
    [IO.File]::WriteAllBytes($cmdConfig, $defaultCmdConfig)
    Remove-Item -LiteralPath $cmdTestRoot -Recurse -Force -ErrorAction SilentlyContinue
}
