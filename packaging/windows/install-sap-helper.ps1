#requires -Version 7.0

[CmdletBinding()]
param(
    [ValidateSet("status", "preflight", "install", "upgrade", "repair")]
    [string]$Mode = "preflight",

    [ValidatePattern('^[A-Za-z0-9_-]+$')]
    [string]$ConnectionId = "w200",

    [string]$ConfigPath,

    [string]$BootstrapScriptPath,

    [Security.SecureString]$SecurePassword
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ConfigPath) {
    $ConfigPath = Join-Path $root "connections.json"
}
if (-not $BootstrapScriptPath) {
    $BootstrapScriptPath = Join-Path $root "app\scripts\bootstrap-sap-helper.ps1"
}

function Get-Connection {
    param([string]$Path, [string]$Id)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Connection configuration not found: $Path"
    }
    try {
        $config = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    } catch {
        throw "Invalid connection configuration: $($_.Exception.Message)"
    }
    if (-not $config.connections -or @($config.connections).Count -eq 0) {
        throw "Connection configuration must contain at least one connection."
    }

    $matches = @($config.connections | Where-Object { [string]$_.id -ieq $Id })
    if ($matches.Count -ne 1) {
        throw "Connection '$Id' was not found exactly once in $Path."
    }
    $connection = $matches[0]
    if ($connection.PSObject.Properties.Name -contains "password") {
        throw "Plaintext password properties are not allowed in connections.json."
    }
    if ([string]$connection.id -notmatch '^[A-Za-z0-9_-]+$') {
        throw "Invalid connection id: $($connection.id)"
    }
    $uri = $null
    if (
        -not [Uri]::TryCreate([string]$connection.url, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -notin @("http", "https")
    ) {
        throw "Connection URL must be an absolute HTTP or HTTPS URL."
    }
    if ([string]$connection.client -notmatch '^\d{3}$') {
        throw "SAP client must contain exactly three digits."
    }
    if ([string]$connection.language -notmatch '^[A-Za-z]{2}$') {
        throw "SAP language must contain exactly two letters."
    }
    if ([string]::IsNullOrWhiteSpace([string]$connection.username)) {
        throw "SAP username is required."
    }
    if ([string]$connection.passwordEnv -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
        throw "passwordEnv must be a valid environment variable name."
    }
    return [pscustomobject]@{ Config = $connection; Uri = $uri }
}

function Test-TcpEndpoint {
    param([Uri]$Uri, [int]$TimeoutMilliseconds = 5000)

    $port = if ($Uri.IsDefaultPort) {
        if ($Uri.Scheme -eq "https") { 443 } else { 80 }
    } else {
        $Uri.Port
    }
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $task = $client.ConnectAsync($Uri.DnsSafeHost, $port)
        if (-not $task.Wait($TimeoutMilliseconds)) {
            throw "Timed out after $TimeoutMilliseconds ms."
        }
        $null = $task.GetAwaiter().GetResult()
    } catch {
        throw "SAP endpoint is unreachable at $($Uri.Scheme)://$($Uri.Authority): $($_.Exception.GetBaseException().Message)"
    } finally {
        $client.Dispose()
    }
}

function Invoke-Bootstrap {
    param(
        [string]$Action,
        [object]$Connection,
        [Security.SecureString]$Password
    )

    $arguments = @{
        BaseUrl = [string]$Connection.url
        Username = [string]$Connection.username
        Client = [string]$Connection.client
        Language = [string]$Connection.language
        Action = $Action
        SecurePassword = $Password
        PassThru = $true
    }
    if ($Connection.allowUnauthorized -eq $true) {
        $arguments.AllowUnauthorized = $true
    }
    $result = & $BootstrapScriptPath @arguments
    if (-not $result) {
        throw "$Action returned no result."
    }
    if (
        $result.BootstrapExitCode -ne 0 -or
        $result.Error -or
        $result.SoapFault -or
        $result.ErrorMessage
    ) {
        $detail = @($result.Error, $result.SoapFault, $result.ErrorMessage) |
            Where-Object { $_ } |
            Select-Object -First 1
        throw "$Action failed: $detail"
    }
    return $result
}

function Get-HelperStatus {
    param([object]$Connection, [Security.SecureString]$Password)

    $apiResult = Invoke-Bootstrap "DiagnoseHelperApis" $Connection $Password
    $groupResult = Invoke-Bootstrap "DiagnoseFunctionGroup" $Connection $Password
    $writes = @($apiResult.Writes | ForEach-Object { ([string]$_ -replace '\s+', ' ').Trim() })
    $required = @(
        "Z_CODEX_MCP_EXECUTE",
        "Z_CODEX_MCP_DYNPRO_API",
        "Z_CODEX_MCP_DDIC_API"
    )
    $helpers = foreach ($name in $required) {
        $exists = @($writes | Where-Object { $_ -match "^HELPER $([regex]::Escape($name)) EXISTS 0$" }).Count -eq 1
        $stateLine = $writes | Where-Object { $_ -match "^STATE $([regex]::Escape($name))(?: |$)" } | Select-Object -First 1
        $stateParts = @([string]$stateLine -split ' ')
        $generated = $stateParts.Count -ge 3 -and $stateParts[2] -eq "X"
        $activeFlag = $stateParts.Count -ge 4 -and $stateParts[3] -eq "X"
        [pscustomobject]@{
            name = $name
            exists = $exists
            generated = $generated
            activeFlag = $activeFlag
            ready = $exists -and $generated
        }
    }
    $groupWrites = @($groupResult.Writes | ForEach-Object { ([string]$_ -replace '\s+', ' ').Trim() })
    $groupReady = @($groupWrites | Where-Object { $_ -match '^SUBRC 0$' }).Count -eq 1
    return [pscustomobject]@{
        ready = (@($helpers | Where-Object { -not $_.ready }).Count -eq 0 -and $groupReady)
        functionGroupReady = $groupReady
        helpers = @($helpers)
    }
}

if (-not (Test-Path -LiteralPath $BootstrapScriptPath -PathType Leaf)) {
    throw "Bundled SAP helper bootstrap not found: $BootstrapScriptPath"
}
$selected = Get-Connection -Path ([IO.Path]::GetFullPath($ConfigPath)) -Id $ConnectionId
Test-TcpEndpoint -Uri $selected.Uri

if (-not $SecurePassword) {
    if ([Console]::IsInputRedirected) {
        throw "A visible PowerShell 7 terminal is required for secure password input."
    }
    $SecurePassword = Read-Host "Password for $($selected.Config.username)@$($selected.Config.id)" -AsSecureString
}
if ($SecurePassword.Length -eq 0) {
    throw "Password cannot be empty."
}

$actions = switch ($Mode) {
    "install" { @("Install", "InstallRepositoryApi", "InstallDdicApi") }
    "upgrade" { @("Install", "RepairRepositoryApi", "RepairDdicApi") }
    "repair" { @("RepairInterface", "RepairRepositoryApi", "RepairDdicApi") }
    default { @() }
}
$operations = foreach ($action in $actions) {
    $result = Invoke-Bootstrap $action $selected.Config $SecurePassword
    [pscustomobject]@{ action = $action; writes = @($result.Writes) }
}
$status = Get-HelperStatus $selected.Config $SecurePassword
if ($Mode -eq "preflight" -and -not $status.ready) {
    $detail = $status | ConvertTo-Json -Depth 5 -Compress
    throw "SAP helper preflight failed because one or more bundled helper APIs are missing or not generated: $detail"
}
if ($actions.Count -gt 0 -and -not $status.ready) {
    throw "SAP helper $Mode completed without a ready post-install state."
}

[pscustomobject]@{
    productVersion = "0.26.0"
    mode = $Mode
    connectionId = ([string]$selected.Config.id).ToLowerInvariant()
    endpoint = "$($selected.Uri.Scheme)://$($selected.Uri.Authority)"
    operations = @($operations)
    status = $status
} | ConvertTo-Json -Depth 8
