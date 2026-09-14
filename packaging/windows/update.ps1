#requires -Version 5.1

[CmdletBinding()]
param(
    [string]$InstallRoot = (Split-Path -Parent $MyInvocation.MyCommand.Path),
    [ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')]
    [string]$Repository = "FiveDayZ/abap_orvanta"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Get-SafeFullPath([string]$Path) {
    return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
}

function Assert-PathInside([string]$Path, [string]$AllowedRoot) {
    $fullPath = Get-SafeFullPath $Path
    $fullRoot = (Get-SafeFullPath $AllowedRoot) + [IO.Path]::DirectorySeparatorChar
    if (-not ($fullPath + [IO.Path]::DirectorySeparatorChar).StartsWith($fullRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing path outside the allowed root: $fullPath"
    }
    return $fullPath
}

function Remove-SafeTree([string]$Path, [string]$AllowedRoot) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $fullPath = Assert-PathInside $Path $AllowedRoot
    Remove-Item -LiteralPath $fullPath -Recurse -Force
}

function ConvertTo-OrvantaVersion([string]$Value) {
    $normalized = $Value.Trim()
    if ($normalized.StartsWith("v", [StringComparison]::OrdinalIgnoreCase)) {
        $normalized = $normalized.Substring(1)
    }
    if ($normalized -notmatch '^\d+\.\d+\.\d+$') {
        throw "Unsupported ORVANTA version: $Value"
    }
    return [Version]$normalized
}

function Get-GitHubHeaders {
    return @{
        Accept = "application/vnd.github+json"
        "User-Agent" = "ORVANTA-Windows-Updater"
        "X-GitHub-Api-Version" = "2022-11-28"
    }
}

function Assert-OrvantaStopped([string]$Root) {
    $runtimeNode = Get-SafeFullPath (Join-Path $Root "runtime\node.exe")
    try {
        $running = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
            $executable = if ($_.ExecutablePath) { Get-SafeFullPath $_.ExecutablePath } else { "" }
            $commandLine = [string]$_.CommandLine
            $executable -eq $runtimeNode -or
                ($commandLine.IndexOf($Root, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
                    $commandLine -match 'dist[\\/]src[\\/](index|settings-index)\.js')
        })
    } catch {
        throw "Could not verify whether ORVANTA is running. Close ORVANTA and retry. $($_.Exception.Message)"
    }
    if ($running.Count -gt 0) {
        $ids = ($running.ProcessId | Sort-Object) -join ", "
        throw "ORVANTA is still running (process: $ids). Stop the service and close the settings window, then retry."
    }
}

function Assert-ZipEntriesSafe([string]$ArchivePath, [string]$DestinationRoot) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        $rootPrefix = (Get-SafeFullPath $DestinationRoot) + [IO.Path]::DirectorySeparatorChar
        foreach ($entry in $archive.Entries) {
            $relative = $entry.FullName.Replace('/', [IO.Path]::DirectorySeparatorChar)
            if ([string]::IsNullOrWhiteSpace($relative) -or [IO.Path]::IsPathRooted($relative)) {
                throw "Release contains an invalid ZIP entry: $($entry.FullName)"
            }
            $destination = [IO.Path]::GetFullPath((Join-Path $DestinationRoot $relative))
            if (-not ($destination + [IO.Path]::DirectorySeparatorChar).StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Release contains a path outside its package root: $($entry.FullName)"
            }
            $unixType = (($entry.ExternalAttributes -shr 16) -band 0xF000)
            if ($unixType -eq 0xA000) {
                throw "Release contains an unsupported symbolic link: $($entry.FullName)"
            }
        }
    } finally {
        $archive.Dispose()
    }
}

function Assert-PackageManifest([string]$PackageRoot, [Version]$ExpectedVersion) {
    $manifestPath = Join-Path $PackageRoot "BUILD-INFO.json"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Release is missing BUILD-INFO.json."
    }
    try {
        $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    } catch {
        throw "Release BUILD-INFO.json is invalid: $($_.Exception.Message)"
    }
    if ($manifest.product -ne "abap-mcp-standalone" -or
        $manifest.platform -ne "win-x64" -or
        (ConvertTo-OrvantaVersion ([string]$manifest.version)) -ne $ExpectedVersion) {
        throw "Release manifest identity does not match ORVANTA $ExpectedVersion for Windows x64."
    }
    $hashEntries = @($manifest.fileSha256.PSObject.Properties)
    if ($hashEntries.Count -eq 0) {
        throw "Release manifest does not contain file hashes."
    }
    foreach ($entry in $hashEntries) {
        $relative = [string]$entry.Name
        $path = Assert-PathInside (Join-Path $PackageRoot $relative) $PackageRoot
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Release manifest file is missing: $relative"
        }
        $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
        if ($actual -ne ([string]$entry.Value).ToUpperInvariant()) {
            throw "Release manifest hash mismatch: $relative"
        }
    }
    foreach ($required in @(
        "app\package.json",
        "app\dist\src\index.js",
        "runtime\node.exe",
        "start.ps1",
        "open-settings.cmd",
        "update.cmd",
        "update.ps1"
    )) {
        if (-not (Test-Path -LiteralPath (Join-Path $PackageRoot $required) -PathType Leaf)) {
            throw "Release is missing required file: $required"
        }
    }
    $appPackage = Get-Content -Raw -LiteralPath (Join-Path $PackageRoot "app\package.json") | ConvertFrom-Json
    if ((ConvertTo-OrvantaVersion ([string]$appPackage.version)) -ne $ExpectedVersion) {
        throw "Release application version does not match $ExpectedVersion."
    }
    return $manifest
}

$root = Get-SafeFullPath $InstallRoot
$parent = Split-Path -Parent $root
if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    throw "ORVANTA installation directory was not found: $root"
}
$currentManifestPath = Join-Path $root "BUILD-INFO.json"
if (-not (Test-Path -LiteralPath $currentManifestPath -PathType Leaf)) {
    throw "BUILD-INFO.json was not found. Run this updater from an extracted ORVANTA Windows package."
}
$currentManifest = Get-Content -Raw -LiteralPath $currentManifestPath | ConvertFrom-Json
$currentVersion = ConvertTo-OrvantaVersion ([string]$currentManifest.version)

[Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
Write-Host "ORVANTA $currentVersion - checking GitHub Releases..."
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases/latest" -Headers (Get-GitHubHeaders) -UseBasicParsing
if ($release.draft -or $release.prerelease) {
    throw "GitHub returned a draft or prerelease instead of a stable release."
}
$latestVersion = ConvertTo-OrvantaVersion ([string]$release.tag_name)
if ($latestVersion -le $currentVersion) {
    Write-Host "Already up to date: ORVANTA $currentVersion"
    return
}

$archiveName = "abap-mcp-standalone-$latestVersion-win-x64.zip"
$checksumName = "$archiveName.sha256"
$archiveAsset = @($release.assets | Where-Object { $_.name -ceq $archiveName })
$checksumAsset = @($release.assets | Where-Object { $_.name -ceq $checksumName })
if ($archiveAsset.Count -ne 1 -or $checksumAsset.Count -ne 1) {
    throw "Release $($release.tag_name) does not contain the required Windows package and SHA-256 file."
}

Assert-OrvantaStopped $root

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("orvanta-update-" + [guid]::NewGuid().ToString("N"))
$downloadRoot = Join-Path $tempRoot "download"
$stageRoot = Join-Path $tempRoot "stage"
$archivePath = Join-Path $downloadRoot $archiveName
$checksumPath = Join-Path $downloadRoot $checksumName
$backupRoot = Join-Path $parent (".orvanta-update-backup-$currentVersion-" + [guid]::NewGuid().ToString("N"))
$managedPaths = @(
    "app", "runtime", "docs", "README.md", "LICENSE", "BUILD-INFO.json", "connections.example.json",
    "start.ps1", "start.cmd", "configure-codex.ps1", "install-sap-helper.ps1",
    "setup.ps1", "open-settings.ps1", "open-settings.cmd", "update.ps1"
)
$backedUp = [Collections.Generic.List[string]]::new()
$installed = [Collections.Generic.List[string]]::new()
$updateCompleted = $false
$rollbackCompleted = $false

try {
    New-Item -ItemType Directory -Force -Path $downloadRoot, $stageRoot, $backupRoot | Out-Null
    Write-Host "Downloading ORVANTA $latestVersion..."
    $headers = Get-GitHubHeaders
    Invoke-WebRequest -Uri $archiveAsset[0].browser_download_url -Headers $headers -OutFile $archivePath -UseBasicParsing
    Invoke-WebRequest -Uri $checksumAsset[0].browser_download_url -Headers $headers -OutFile $checksumPath -UseBasicParsing

    $checksumText = (Get-Content -Raw -LiteralPath $checksumPath).Trim()
    $checksumPattern = '^(?<hash>[0-9A-Fa-f]{64})\s+\*?' + [regex]::Escape($archiveName) + '$'
    if ($checksumText -notmatch $checksumPattern) {
        throw "Release checksum file is malformed or names a different archive."
    }
    $expectedHash = $Matches.hash.ToUpperInvariant()
    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
    if ($actualHash -ne $expectedHash) {
        throw "Downloaded release SHA-256 mismatch."
    }

    Assert-ZipEntriesSafe $archivePath $stageRoot
    [IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $stageRoot)
    $null = Assert-PackageManifest $stageRoot $latestVersion

    Write-Host "Installing ORVANTA $latestVersion..."
    foreach ($relative in $managedPaths) {
        $currentPath = Join-Path $root $relative
        if (Test-Path -LiteralPath $currentPath) {
            $backupPath = Join-Path $backupRoot $relative
            $backupParent = Split-Path -Parent $backupPath
            New-Item -ItemType Directory -Force -Path $backupParent | Out-Null
            Move-Item -LiteralPath $currentPath -Destination $backupPath
            $backedUp.Add($relative)
        }
    }
    foreach ($relative in $managedPaths) {
        $stagedPath = Join-Path $stageRoot $relative
        if (Test-Path -LiteralPath $stagedPath) {
            $targetPath = Join-Path $root $relative
            $targetParent = Split-Path -Parent $targetPath
            New-Item -ItemType Directory -Force -Path $targetParent | Out-Null
            Move-Item -LiteralPath $stagedPath -Destination $targetPath
            $installed.Add($relative)
        }
    }

    $installedManifest = Get-Content -Raw -LiteralPath (Join-Path $root "BUILD-INFO.json") | ConvertFrom-Json
    if ((ConvertTo-OrvantaVersion ([string]$installedManifest.version)) -ne $latestVersion) {
        throw "Installed version verification failed."
    }
    $updateCompleted = $true
    Write-Host "Updated ORVANTA $currentVersion -> $latestVersion"
    Write-Host "connections.json, exports, and the external state directory were preserved."
    Write-Host "SAP helpers were not installed or upgraded."
} catch {
    $failure = $_
    if ($backedUp.Count -gt 0) {
        foreach ($relative in $installed) {
            $targetPath = Join-Path $root $relative
            if (Test-Path -LiteralPath $targetPath) {
                $safeTarget = Assert-PathInside $targetPath $root
                Remove-Item -LiteralPath $safeTarget -Recurse -Force
            }
        }
        foreach ($relative in $backedUp) {
            $backupPath = Join-Path $backupRoot $relative
            if (Test-Path -LiteralPath $backupPath) {
                $targetPath = Join-Path $root $relative
                $targetParent = Split-Path -Parent $targetPath
                New-Item -ItemType Directory -Force -Path $targetParent | Out-Null
                Move-Item -LiteralPath $backupPath -Destination $targetPath
            }
        }
    }
    $rollbackCompleted = $true
    throw "ORVANTA update failed; the previous installation was kept or restored. $($failure.Exception.Message)"
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-SafeTree $tempRoot ([IO.Path]::GetTempPath())
    }
    if (($updateCompleted -or $rollbackCompleted) -and (Test-Path -LiteralPath $backupRoot)) {
        Remove-SafeTree $backupRoot $parent
    }
}
