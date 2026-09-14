#requires -Version 7.0

[CmdletBinding()]
param(
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$NodeVersion = "24.8.0",
    [switch]$ReplaceExisting,
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$')]
    [string]$CandidateSuffix,
    [switch]$SkipRuntimeCheck
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$packageJson = Get-Content -Raw (Join-Path $projectRoot "package.json") | ConvertFrom-Json
$artifactName = "abap-mcp-standalone-$($packageJson.version)-win-x64"
if ($CandidateSuffix) { $artifactName += "-$CandidateSuffix" }
$releaseRoot = Join-Path $projectRoot "release"
$packageRoot = Join-Path $releaseRoot $artifactName
$zipPath = Join-Path $releaseRoot "$artifactName.zip"
$hashPath = "$zipPath.sha256"
$cacheRoot = Join-Path $projectRoot ".cache\node-$NodeVersion-win-x64"
$nodeArchive = Join-Path $cacheRoot "node-v$NodeVersion-win-x64.zip"
$nodeUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
$sumsUrl = "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt"

function Remove-ScopedPath([string]$Path, [string]$AllowedRoot) {
    $fullPath = [IO.Path]::GetFullPath($Path)
    $fullRoot = [IO.Path]::GetFullPath($AllowedRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $fullPath.StartsWith($fullRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove path outside $AllowedRoot`: $fullPath"
    }
    if (Test-Path -LiteralPath $fullPath) {
        Remove-Item -LiteralPath $fullPath -Recurse -Force
    }
}

New-Item -ItemType Directory -Force -Path $releaseRoot, $cacheRoot | Out-Null
if (-not $ReplaceExisting -and (@($packageRoot, $zipPath, $hashPath) | Where-Object { Test-Path -LiteralPath $_ })) {
    throw "Release already exists. Preserve it or explicitly use -ReplaceExisting after review."
}
Remove-ScopedPath $packageRoot $releaseRoot
Remove-Item -LiteralPath $zipPath, $hashPath -Force -ErrorAction SilentlyContinue

& npm.cmd run build
if ($LASTEXITCODE -ne 0) {
    throw "Build failed with exit code $LASTEXITCODE"
}

$sums = (Invoke-WebRequest -Uri $sumsUrl).Content
$archiveName = Split-Path -Leaf $nodeArchive
$checksumLine = ($sums -split "`n" | Where-Object { $_ -match "\s+$([regex]::Escape($archiveName))\s*$" } | Select-Object -First 1)
if (-not $checksumLine) {
    throw "Could not find $archiveName in Node.js SHASUMS256.txt"
}
$expectedNodeHash = ($checksumLine -split "\s+")[0].ToUpperInvariant()
$actualNodeHash = if (Test-Path -LiteralPath $nodeArchive) {
    (Get-FileHash -LiteralPath $nodeArchive -Algorithm SHA256).Hash
} else {
    ""
}
if ($actualNodeHash -ne $expectedNodeHash) {
    $partialArchive = "$nodeArchive.partial"
    Remove-Item -LiteralPath $partialArchive -Force -ErrorAction SilentlyContinue
    Invoke-WebRequest -Uri $nodeUrl -OutFile $partialArchive
    $downloadedHash = (Get-FileHash -LiteralPath $partialArchive -Algorithm SHA256).Hash
    if ($downloadedHash -ne $expectedNodeHash) {
        Remove-Item -LiteralPath $partialArchive -Force
        throw "Downloaded Node.js archive checksum mismatch. Expected $expectedNodeHash, got $downloadedHash"
    }
    Move-Item -LiteralPath $partialArchive -Destination $nodeArchive -Force
    $actualNodeHash = $downloadedHash
}
if ($actualNodeHash -ne $expectedNodeHash) {
    throw "Node.js archive checksum mismatch. Expected $expectedNodeHash, got $actualNodeHash"
}

$extractRoot = Join-Path $cacheRoot "extracted"
Remove-ScopedPath $extractRoot $cacheRoot
Expand-Archive -LiteralPath $nodeArchive -DestinationPath $extractRoot
$nodeRoot = Join-Path $extractRoot "node-v$NodeVersion-win-x64"

$runtimeRoot = Join-Path $packageRoot "runtime"
$appRoot = Join-Path $packageRoot "app"
New-Item -ItemType Directory -Force -Path $runtimeRoot, $appRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $nodeRoot "node.exe") -Destination $runtimeRoot
Copy-Item -LiteralPath (Join-Path $nodeRoot "LICENSE") -Destination (Join-Path $runtimeRoot "NODE-LICENSE.txt")

Copy-Item -LiteralPath (Join-Path $projectRoot "package.json") -Destination $appRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "package-lock.json") -Destination $appRoot
New-Item -ItemType Directory -Force -Path (Join-Path $appRoot "dist") | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot "dist\src") -Destination (Join-Path $appRoot "dist\src") -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot "ui") -Destination (Join-Path $appRoot "ui") -Recurse
New-Item -ItemType Directory -Force -Path (Join-Path $appRoot "scripts") | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot "scripts\probe.mjs") -Destination (Join-Path $appRoot "scripts")
Copy-Item -LiteralPath (Join-Path $projectRoot "scripts\bootstrap-sap-helper.ps1") -Destination (Join-Path $appRoot "scripts")

Push-Location $appRoot
try {
    & npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        throw "Production dependency installation failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

Copy-Item -LiteralPath (Join-Path $projectRoot "packaging\windows\start.ps1") -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "packaging\windows\start.cmd") -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "packaging\windows\configure-codex.ps1") -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "packaging\windows\install-sap-helper.ps1") -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "packaging\windows\setup.ps1") -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "packaging\windows\open-settings.ps1") -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "packaging\windows\open-settings.cmd") -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "packaging\windows\default-connections.json") -Destination (Join-Path $packageRoot "connections.json")
Copy-Item -LiteralPath (Join-Path $projectRoot "connections.example.json") -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "README.md") -Destination $packageRoot

# Runtime execution is optional only for preparation; the manifest records the missing check.
if (-not $SkipRuntimeCheck) {
    Push-Location $packageRoot
    try {
        $runtimeVersion = & (Join-Path $runtimeRoot "node.exe") --input-type=module -e "import { PRODUCT_VERSION } from './app/dist/src/version.js'; console.log(PRODUCT_VERSION)"
        if ($LASTEXITCODE -ne 0 -or $runtimeVersion -ne $packageJson.version) {
            throw "Packaged runtime version does not match package.json."
        }
    } finally {
        Pop-Location
    }
}
$sourceCommit = & git -C $projectRoot rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw "Cannot determine standalone source commit." }
$sourceStatus = @(& git -C $projectRoot status --porcelain --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw "Cannot determine standalone working tree state." }
$fileHashes = [ordered]@{}
Get-ChildItem -LiteralPath $packageRoot -File -Recurse |
    Where-Object { $_.FullName -notlike "*\node_modules\*" } |
    Sort-Object FullName |
    ForEach-Object {
        $relativePath = [IO.Path]::GetRelativePath($packageRoot, $_.FullName).Replace("\", "/")
        $fileHashes[$relativePath] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    }
$buildInfo = [ordered]@{
    product = $packageJson.name
    version = $packageJson.version
    candidateSuffix = $CandidateSuffix
    runtimeVersionCheck = $(if ($SkipRuntimeCheck) { "Skipped" } else { "Passed" })
    platform = "win-x64"
    nodeVersion = $NodeVersion
    nodeArchiveSha256 = $actualNodeHash
    sourceBaselineVersion = "2.7.0"
    sourceBaselineCommit = "0466e8ceea4e201335d74a7420ac894384f4a0e2"
    standaloneSourceCommit = "$sourceCommit".Trim()
    standaloneSourceDirty = $sourceStatus.Count -gt 0
    fileHashScope = "All packaged files except node_modules and BUILD-INFO.json; dependencies are pinned by app/package-lock.json."
    fileSha256 = $fileHashes
    builtAt = (Get-Date).ToString("yyyy-MM-ddTHH:mm:sszzz")
}
$buildInfo | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $packageRoot "BUILD-INFO.json") -Encoding utf8

Compress-Archive -Path (Join-Path $packageRoot "*") -DestinationPath $zipPath -CompressionLevel Optimal
$artifactHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
"$artifactHash  $([IO.Path]::GetFileName($zipPath))" | Set-Content -LiteralPath $hashPath -Encoding ascii

[pscustomobject]@{
    Package = $packageRoot
    Archive = $zipPath
    Sha256 = $artifactHash
    Node = "v$NodeVersion"
}
