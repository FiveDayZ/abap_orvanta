#requires -Version 7.0

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$suffix = "m8-" + (Get-Date -Format "yyyyMMdd-HHmmss")
$version = (Get-Content -LiteralPath (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
$name = "abap-mcp-standalone-$version-win-x64-$suffix"
$packageRoot = Join-Path $root "release/$name"
$sourceRoot = "$packageRoot-source"
$output = [IO.Path]::GetFullPath((Join-Path $root "../.doc/m8-candidate-$suffix"))
$pwsh = (Get-Process -Id $PID).Path
$report = [ordered]@{
    startedAt = (Get-Date).ToString("o")
    status = "Failed"
    candidateSuffix = $suffix
    version = $version
    testsExecuted = $false
    runtimeAcceptance = "Pending user execution"
    serviceSwitched = $false
    sapCalls = $false
    sourceScope = "Git-listed tracked/untracked build, test and documentation inputs; excludes runtime configuration, state, dependencies, cache and Git history."
    runningComparisonScope = "On-disk dist/src, ui, package.json, package-lock.json and runtime/node.exe; not process memory or dependency contents."
}
foreach ($path in @($output, $sourceRoot, $packageRoot, "$packageRoot.zip", "$sourceRoot.zip")) {
    if (Test-Path -LiteralPath $path) { throw "Output already exists: $path" }
}
New-Item -ItemType Directory -Path $output, $sourceRoot | Out-Null
try {
    $m7Path = [IO.Path]::GetFullPath((Join-Path $root "../.doc/m7-standalone-user-2026-09-10T06-22-27-378Z-61607c9e/result.json"))
    $m7 = Get-Content -LiteralPath $m7Path -Raw | ConvertFrom-Json
    if ($m7.status -ne "Passed" -or $m7.offline -or $m7.localVersion -ne $version) {
        throw "Approved M7 evidence does not match this candidate baseline."
    }
    $report.m7Evidence = [ordered]@{ path = $m7Path; sha256 = (Get-FileHash -LiteralPath $m7Path -Algorithm SHA256).Hash }
    $report.sourceCommit = (& git -C $root rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Cannot read Git HEAD." }
    $report.sourceStatus = @(& git -C $root status --porcelain --untracked-files=all)
    if ($LASTEXITCODE -ne 0) { throw "Cannot read Git status." }
    $files = @(& git -C $root ls-files --cached --others --exclude-standard)
    if ($LASTEXITCODE -ne 0) { throw "Cannot enumerate source files." }
    $sourceHashes = [ordered]@{}
    foreach ($file in ($files | Sort-Object -Unique)) {
        if ($file -notmatch '^(src/|test/|scripts/|docs/|contracts/|packaging/|ui/|package\.json$|package-lock\.json$|tsconfig\.json$|README\.md$|PRODUCT\.md$|connections\.example\.json$|\.gitignore$|\.prettierignore$|\.prettierrc\.json$|test-m[78]-.*\.cmd$)') {
            throw "Unclassified source file; review snapshot scope before packaging: $file"
        }
        $inputPath = Join-Path $root $file
        if (-not (Test-Path -LiteralPath $inputPath)) { continue }
        if ((Get-Item -LiteralPath $inputPath).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Source snapshot does not follow links: $file"
        }
        $destination = Join-Path $sourceRoot $file
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
        Copy-Item -LiteralPath $inputPath -Destination $destination
        $sourceHashes[$file] = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
    }
    $oldArchive = Join-Path $root "release/abap-mcp-standalone-$version-win-x64.zip"
    $oldHash = (Get-FileHash -LiteralPath $oldArchive -Algorithm SHA256).Hash
    $listener = @(Get-NetTCPConnection -LocalPort 4853 -State Listen -ErrorAction SilentlyContinue)
    $runningRoot = $null
    if ($listener.Count -eq 1 -and $listener[0].LocalAddress -eq "127.0.0.1") {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener[0].OwningProcess)"
        $report.runningProcess = [ordered]@{
            pid = $process.ProcessId
            createdAt = $process.CreationDate.ToString("o")
            executable = $process.ExecutablePath
        }
        $candidateRoot = Split-Path -Parent (Split-Path -Parent $process.ExecutablePath)
        if (Test-Path -LiteralPath (Join-Path $candidateRoot "app/dist/src/index.js")) {
            $runningRoot = $candidateRoot
        }
    }
    $report.sourceFileSha256 = $sourceHashes
    $sourceHashes | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $sourceRoot "SOURCE-FILES.json") -Encoding utf8
    [IO.Compression.ZipFile]::CreateFromDirectory($sourceRoot, "$sourceRoot.zip")
    $report.sourceArchive = "$sourceRoot.zip"
    $report.sourceArchiveSha256 = (Get-FileHash -LiteralPath "$sourceRoot.zip" -Algorithm SHA256).Hash
    "$($report.sourceArchiveSha256)  $name-source.zip" | Set-Content -LiteralPath "$sourceRoot.zip.sha256" -Encoding ascii

    $log = Join-Path $output "package.log"
    & $pwsh -NoLogo -NoProfile -File (Join-Path $root "scripts/package-windows.ps1") -CandidateSuffix $suffix -SkipRuntimeCheck *> $log
    $report.packageExitCode = $LASTEXITCODE
    $report.packageLog = $log
    if ($LASTEXITCODE -ne 0) { throw "Packaging failed; see $log" }

    # Fail closed if build inputs changed while the source snapshot was being packaged.
    foreach ($file in $sourceHashes.Keys) {
        if ((Get-FileHash -LiteralPath (Join-Path $root $file) -Algorithm SHA256).Hash -ne $sourceHashes[$file]) {
            throw "Source changed during packaging: $file"
        }
    }
    $currentFiles = @(& git -C $root ls-files --cached --others --exclude-standard |
        Where-Object { Test-Path -LiteralPath (Join-Path $root $_) } | Sort-Object -Unique)
    if ($LASTEXITCODE -ne 0 -or (Compare-Object @($sourceHashes.Keys) $currentFiles)) {
        throw "Source file inventory changed during packaging."
    }
    $report.sourceSnapshotMatchesAfterBuild = $true
    $manifest = Get-Content -LiteralPath (Join-Path $packageRoot "BUILD-INFO.json") -Raw | ConvertFrom-Json
    foreach ($entry in $manifest.fileSha256.PSObject.Properties) {
        if ((Get-FileHash -LiteralPath (Join-Path $packageRoot $entry.Name) -Algorithm SHA256).Hash -ne $entry.Value) {
            throw "Package manifest mismatch: $($entry.Name)"
        }
    }
    $report.manifestFilesMatched = @($manifest.fileSha256.PSObject.Properties).Count
    $comparison = @()
    if ($runningRoot) {
        foreach ($entry in $manifest.fileSha256.PSObject.Properties) {
            if ($entry.Name -notmatch '^(app/dist/src/|app/ui/|app/package(-lock)?\.json$|runtime/node\.exe$)') { continue }
            $path = Join-Path $runningRoot $entry.Name
            $hash = if (Test-Path -LiteralPath $path) { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash } else { $null }
            $comparison += [ordered]@{ file = $entry.Name; candidate = $entry.Value; runningDisk = $hash; equal = $hash -eq $entry.Value }
        }
    }
    $report.runningDiskComparison = $comparison
    $report.runningDiskComparisonAvailable = [bool]$runningRoot
    $report.archive = "$packageRoot.zip"
    $report.archiveBytes = (Get-Item -LiteralPath $report.archive).Length
    $report.archiveSha256 = (Get-FileHash -LiteralPath $report.archive -Algorithm SHA256).Hash
    $report.oldArchiveSha256Before = $oldHash
    $report.oldArchiveSha256After = (Get-FileHash -LiteralPath $oldArchive -Algorithm SHA256).Hash
    if ($oldHash -ne $report.oldArchiveSha256After) { throw "Protected old archive changed." }
    $report.status = "Partially Verified"
} catch {
    $report.failure = $_.Exception.Message
    Write-Warning $report.failure
} finally {
    $report.finishedAt = (Get-Date).ToString("o")
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $output "result.json") -Encoding utf8
    Write-Output "Result: $($report.status)"
    Write-Output "Candidate: $suffix"
    Write-Output "Report: $(Join-Path $output 'result.json')"
}
if ($report.status -eq "Failed") { exit 1 }
