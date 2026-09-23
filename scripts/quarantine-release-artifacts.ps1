<#
.SYNOPSIS
    Moves release artifacts outside the retention window into release/quarantine.

.DESCRIPTION
    The retention window was previously advisory only: package-windows.ps1 printed a
    warning and left every artifact in release/.  This script enforces the window by
    MOVING (never deleting) the stale artifacts, so the operation stays reversible and
    the release directory stops accumulating unpacked trees that carry live
    connections.json values.

    One "artifact" is the triple:
        <name>.zip  +  <name>.zip.sha256  +  <name>\  (unpacked tree)

    The newest $Keep artifacts (by zip LastWriteTime, then name) are retained.  Every
    other zip triple is quarantined, and so is every unpacked or legacy directory that
    no retained artifact owns.

    Run without -Apply to see the plan.  Run with -Apply to move the artifacts.

.PARAMETER ReleaseRoot
    release/ directory to prune.  Defaults to <repo>/release.

.PARAMETER Keep
    Number of newest artifacts to retain.  Defaults to 5, the window documented in
    scripts/package-windows.ps1.

.PARAMETER Apply
    Perform the moves.  Without it the script only reports the plan.

.EXAMPLE
    pwsh -File scripts/quarantine-release-artifacts.ps1
    pwsh -File scripts/quarantine-release-artifacts.ps1 -Apply
#>
[CmdletBinding()]
param(
    [string]$ReleaseRoot = (Join-Path $PSScriptRoot "..\release"),
    [int]$Keep = 5,
    [switch]$Apply
)

$ErrorActionPreference = "Stop"

if ($Keep -lt 0) { throw "Keep must be zero or greater." }

$releaseRootPath = (Resolve-Path -LiteralPath $ReleaseRoot).Path
$quarantineRoot = Join-Path $releaseRootPath "quarantine"
if (-not (Test-Path -LiteralPath $quarantineRoot)) {
    if ($Apply) {
        New-Item -ItemType Directory -Path $quarantineRoot | Out-Null
    }
}

# An artifact name is "orvanta-mcp-<version>-win-x64" (optionally with a candidate
# suffix).  Legacy names are kept because they also own unpacked trees.
$artifacts = @(
    Get-ChildItem -LiteralPath $releaseRootPath -File -Filter "*.zip" |
        Where-Object { $_.Name -notlike "*.sha256" } |
        Sort-Object -Property @{ Expression = "LastWriteTime"; Descending = $true },
            @{ Expression = "Name"; Descending = $false }
)

$retained = @($artifacts | Select-Object -First $Keep)
$stale = @($artifacts | Select-Object -Skip $Keep)

$retainedNames = [System.Collections.Generic.HashSet[string]]::new()
foreach ($item in $retained) {
    [void]$retainedNames.Add([IO.Path]::GetFileNameWithoutExtension($item.Name))
}

$plan = [System.Collections.Generic.List[object]]::new()

function Add-PlanEntry {
    param([string]$Path, [string]$Kind, [string]$Reason)

    if (-not (Test-Path -LiteralPath $Path)) { return }
    $plan.Add([pscustomobject]@{
            Path   = $Path
            Kind   = $Kind
            Reason = $Reason
        })
}

foreach ($item in $stale) {
    $artifactName = [IO.Path]::GetFileNameWithoutExtension($item.Name)
    Add-PlanEntry -Path $item.FullName -Kind "zip" -Reason "outside retention window ($Keep)"
    Add-PlanEntry -Path "$($item.FullName).sha256" -Kind "sha256" -Reason "checksum of a stale zip"
    Add-PlanEntry -Path (Join-Path $releaseRootPath $artifactName) -Kind "dir" -Reason "unpacked tree of a stale zip"
}

# Any remaining directory that is not quarantine, not owned by a retained artifact and
# not already planned is stale by definition (legacy m7-* trees, unpacked trees whose
# zip was deleted by hand, cancelled candidates).
$plannedPaths = [System.Collections.Generic.HashSet[string]]::new()
foreach ($entry in $plan) { [void]$plannedPaths.Add($entry.Path) }

foreach ($directory in Get-ChildItem -LiteralPath $releaseRootPath -Directory) {
    if ($directory.Name -eq "quarantine") { continue }
    if ($retainedNames.Contains($directory.Name)) { continue }
    if ($plannedPaths.Contains($directory.FullName)) { continue }
    $owner = Get-ChildItem -LiteralPath $releaseRootPath -File -Filter "$($directory.Name).zip" |
        Select-Object -First 1
    $reason = if ($owner) { "unpacked tree of a stale zip" } else { "no matching zip in release/" }
    Add-PlanEntry -Path $directory.FullName -Kind "dir" -Reason $reason
}

# A retained zip can also own a stale checksum file whose zip is gone.
foreach ($checksum in Get-ChildItem -LiteralPath $releaseRootPath -File -Filter "*.zip.sha256") {
    if ($plannedPaths.Contains($checksum.FullName)) { continue }
    $zipPath = $checksum.FullName -replace "\.sha256$", ""
    if (Test-Path -LiteralPath $zipPath) { continue }
    Add-PlanEntry -Path $checksum.FullName -Kind "sha256" -Reason "checksum without a zip"
}

Write-Output "release root : $releaseRootPath"
Write-Output "quarantine   : $quarantineRoot"
Write-Output "retention    : $Keep newest zip artifacts"
Write-Output ("retained     : {0}" -f (($retained | ForEach-Object { $_.Name }) -join ", "))
Write-Output ""

if ($plan.Count -eq 0) {
    Write-Output "Nothing to quarantine: release/ is already inside the retention window."
    exit 0
}

$plan | Select-Object Kind, Reason, @{ n = "Name"; e = { Split-Path $_.Path -Leaf } } |
    Format-Table -AutoSize | Out-String -Width 200 | Write-Output

if (-not $Apply) {
    Write-Output ("DRY RUN: {0} path(s) would move to quarantine. Re-run with -Apply." -f $plan.Count)
    exit 0
}

$moved = 0
$failed = [System.Collections.Generic.List[string]]::new()
foreach ($entry in $plan) {
    $destination = Join-Path $quarantineRoot (Split-Path $entry.Path -Leaf)
    try {
        if (Test-Path -LiteralPath $destination) {
            # Never overwrite a quarantined artifact: make the destination unique.
            $suffix = 1
            do {
                $candidate = "$destination.$suffix"
                $suffix++
            } while (Test-Path -LiteralPath $candidate)
            $destination = $candidate
        }
        Move-Item -LiteralPath $entry.Path -Destination $destination
        $moved++
    } catch {
        $failed.Add("$($entry.Path): $($_.Exception.Message)")
    }
}

Write-Output ("quarantined  : {0} path(s) -> {1}" -f $moved, $quarantineRoot)
if ($failed.Count -gt 0) {
    Write-Warning ("{0} path(s) could not be moved (in use?):`n{1}" -f $failed.Count, ($failed -join "`n"))
    exit 1
}

exit 0
