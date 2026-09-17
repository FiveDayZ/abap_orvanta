#requires -Version 7.0

$ErrorActionPreference = "Stop"
$root = Join-Path $env:TEMP ("abap-package-checksum-" + [guid]::NewGuid())
$resolved = [IO.Path]::GetFullPath($root)
$tempPrefix = [IO.Path]::GetFullPath($env:TEMP).TrimEnd("\") + "\"
if (-not $resolved.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Fixture must stay inside TEMP."
}
try {
    $tests = New-Item -ItemType Directory -Path (Join-Path $root "test")
    $release = New-Item -ItemType Directory -Path (Join-Path $root "release")
    @{ version = "0.0.0" } | ConvertTo-Json | Set-Content (Join-Path $root "package.json")
    $archive = Join-Path $release.FullName "orvanta-mcp-0.0.0-win-x64.zip"
    # Invalid ZIP data must be rejected by the checksum gate, before extraction or execution.
    [IO.File]::WriteAllText($archive, "not a zip")
    foreach ($script in @("package-smoke.ps1", "settings-package-smoke.ps1")) {
        $copy = Join-Path $tests.FullName $script
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $script) -Destination $copy
        foreach ($checksum in @(("0" * 64), "invalid-checksum")) {
            Set-Content -LiteralPath "$archive.sha256" -Value $checksum
            $output = & (Get-Process -Id $PID).Path -NoLogo -NoProfile -File $copy 2>&1
            if ($LASTEXITCODE -eq 0 -or ($output | Out-String) -notmatch "Release archive checksum verification failed") {
                throw "$script failed to reject the archive at the checksum gate: $output"
            }
        }
    }
    Write-Output "Package checksum PASS: both entry points reject mismatched and malformed checksums before ZIP extraction (4 cases)."
} finally {
    if (Test-Path -LiteralPath $resolved) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
