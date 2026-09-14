#requires -Version 7.0

[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9_-]+$')]
    [string]$ServerName = "orvanta",

    [ValidateRange(1024, 65535)]
    [int]$Port = 4847,

    [switch]$Force,
    [switch]$Remove
)

$ErrorActionPreference = "Stop"
$codex = (Get-Command codex -ErrorAction Stop).Source
$url = "http://127.0.0.1:$Port/mcp"

function Get-CodexServer {
    $result = & $codex mcp get $ServerName --json 2>$null
    if ($LASTEXITCODE -ne 0) {
        return $null
    }
    return ($result -join [Environment]::NewLine) | ConvertFrom-Json
}

$existing = Get-CodexServer
if ($Remove) {
    if ($existing) {
        & $codex mcp remove $ServerName
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to remove Codex MCP server: $ServerName"
        }
    }
    Write-Host "Codex MCP server removed: $ServerName"
    return
}

$existingUrl = $existing.transport.url
if ($existingUrl -eq $url) {
    Write-Host "Codex MCP server already configured: $ServerName -> $url"
    return
}
if ($existing -and -not $Force) {
    throw "Codex MCP server '$ServerName' already points to '$existingUrl'. Use -Force to replace it."
}
if ($existing) {
    & $codex mcp remove $ServerName
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to remove existing Codex MCP server: $ServerName"
    }
}

& $codex mcp add $ServerName --url $url
if ($LASTEXITCODE -ne 0) {
    throw "Failed to add Codex MCP server: $ServerName"
}

$verified = Get-CodexServer
if (-not $verified -or $verified.transport.type -ne "streamable_http" -or $verified.transport.url -ne $url) {
    throw "Codex MCP registration verification failed for $ServerName"
}
Write-Host "Codex MCP server configured: $ServerName -> $url"
