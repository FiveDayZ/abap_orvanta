#requires -Version 5.1

[CmdletBinding()]
param([switch]$NoBrowser)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = Join-Path $root "runtime\node.exe"
$entry = Join-Path $root "app\dist\src\settings-index.js"
$process = $null
try {
    if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $entry)) {
        throw "The portable package is incomplete. Extract the entire ZIP before opening settings."
    }
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $node
    $startInfo.Arguments = '"' + $entry + '"'
    $startInfo.WorkingDirectory = $root
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.EnvironmentVariables["ABAP_MCP_CONFIG"] = Join-Path $root "connections.json"
    $startInfo.EnvironmentVariables["ABAP_MCP_EXPORT_ROOT"] = Join-Path $root "exports"
    # The browser address is read in memory. No access token or password is logged.
    $startInfo.EnvironmentVariables["ABAP_MCP_SETTINGS_PORT"] = "0"
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    $null = $process.Start()
    $lineTask = $process.StandardOutput.ReadLineAsync()
    if (-not $lineTask.Wait(15000)) { throw "Settings startup timed out." }
    $ready = $lineTask.Result | ConvertFrom-Json
    if ($ready.url -notmatch '^http://127\.0\.0\.1:\d+/#([a-f0-9]{64})$') {
        throw "The local settings service did not return a valid address."
    }
    if ($NoBrowser) {
        $ready | ConvertTo-Json -Compress
    } else {
        Start-Process -FilePath $ready.url | Out-Null
    }
    $process.WaitForExit()
} catch {
    if ($process -and -not $process.HasExited) { $process.Kill() }
    if ($NoBrowser) { throw }
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show("Could not open ORVANTA settings. Extract the full package to a writable folder and try again.", "ORVANTA") | Out-Null
    exit 1
} finally {
    if ($process) { $process.Dispose() }
}
