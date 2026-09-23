#requires -Version 7.0

# 基础连接配置解析：优先使用未入库的 connections.local.json，缺失时回退到入库的出厂占位符。
# 占位符主机是保留域 *.invalid，直连只会得到误导性的 DNS 报错，因此调用方必须先看 IsPlaceholder 并显式拦下。
# 用法：. (Join-Path $PSScriptRoot "get-base-connections.ps1")

function Get-BaseConnections {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot
    )

    $localPath = Join-Path $ProjectRoot "packaging\windows\connections.local.json"
    $placeholderPath = Join-Path $ProjectRoot "packaging\windows\default-connections.json"
    $hasLocal = Test-Path -LiteralPath $localPath -PathType Leaf
    $resolvedPath = if ($hasLocal) { $localPath } else { $placeholderPath }
    if (-not (Test-Path -LiteralPath $resolvedPath -PathType Leaf)) {
        throw "SAP connection config not found: $resolvedPath"
    }

    $config = Get-Content -Raw -LiteralPath $resolvedPath | ConvertFrom-Json
    $connection = @($config.connections)[0]
    if (-not $connection) {
        throw "SAP connection config declares no connection: $resolvedPath"
    }

    [pscustomobject]@{
        Path          = $resolvedPath
        LocalPath     = $localPath
        IsPlaceholder = -not $hasLocal
        Connection    = $connection
    }
}

function Assert-BaseConnectionsUsable {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [pscustomobject]$Info,

        [string]$EndpointOverride,

        [string]$UsernameOverride
    )

    if (-not $Info.IsPlaceholder) { return }
    $hasExplicitTarget = (
        -not [string]::IsNullOrWhiteSpace($EndpointOverride) -and
        -not [string]::IsNullOrWhiteSpace($UsernameOverride)
    )
    if ($hasExplicitTarget) { return }

    $message = "No usable SAP connection configuration: '{0}' is the tracked factory placeholder " +
    "(host is a reserved .invalid domain), so connecting would fail with a misleading DNS error. " +
    "Create '{1}' with the real endpoint and username, or pass an explicit endpoint and username."
    throw ($message -f @($Info.Path, $Info.LocalPath))
}

function Resolve-BaseConnectionsPath {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot,

        [string]$EndpointOverride,

        [string]$UsernameOverride
    )

    $info = Get-BaseConnections -ProjectRoot $ProjectRoot
    Assert-BaseConnectionsUsable -Info $info `
        -EndpointOverride $EndpointOverride -UsernameOverride $UsernameOverride
    return $info.Path
}
