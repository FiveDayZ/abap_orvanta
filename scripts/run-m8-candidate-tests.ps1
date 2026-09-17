#requires -Version 7.0

param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$')]
    [string]$CandidateSuffix
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$output = Join-Path $projectRoot ("../.doc/m8-user-" + (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $output | Out-Null
$steps = @()
$status = "Failed"
$archive = $null
$archiveHash = $null
try {
    $version = (Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json).version
    $archive = Join-Path $projectRoot "release/abap-mcp-standalone-$version-win-x64-$CandidateSuffix.zip"
    $archiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
    foreach ($script in @("package-smoke.ps1", "settings-package-smoke.ps1", "package-checksum.test.ps1")) {
        $arguments = @("-NoLogo", "-NoProfile", "-File", (Join-Path $projectRoot "test/$script"))
        if ($script -ne "package-checksum.test.ps1") { $arguments += @("-CandidateSuffix", $CandidateSuffix) }
        $log = Join-Path $output "$script.log"
        & (Get-Process -Id $PID).Path @arguments *> $log
        $code = $LASTEXITCODE
        $steps += [ordered]@{ script = $script; exitCode = $code; log = [IO.Path]::GetFullPath($log) }
        Write-Host "$script exit=$code"
        if ($code -ne 0) { throw "Test failed; see $log. No automatic retry." }
    }
    $status = "Passed"
} catch {
    Write-Warning $_.Exception.Message
} finally {
    $path = Join-Path $output "result.json"
    [ordered]@{
        finishedAt = (Get-Date).ToString("o")
        status = $status
        candidateSuffix = $CandidateSuffix
        archive = $archive
        archiveSha256 = $archiveHash
        scope = "isolated-package-runtime-and-checksum"
        sapBusinessWrites = $false
        existingServiceSwitched = $false
        steps = $steps
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $path -Encoding utf8
    Write-Host "Result: $status"
    Write-Host "Report: $([IO.Path]::GetFullPath($path))"
}
if ($status -ne "Passed") { exit 1 }
