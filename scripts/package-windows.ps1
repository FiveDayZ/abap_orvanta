#requires -Version 7.0

[CmdletBinding()]
param(
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$NodeVersion = "24.8.0",
    [switch]$ReplaceExisting,
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$')]
    [string]$CandidateSuffix,
    [switch]$SkipRuntimeCheck,
    [switch]$AllowDirty
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$packageJson = Get-Content -Raw (Join-Path $projectRoot "package.json") | ConvertFrom-Json
$artifactName = "orvanta-mcp-$($packageJson.version)-win-x64"
if ($CandidateSuffix) { $artifactName += "-$CandidateSuffix" }
$releaseRoot = Join-Path $projectRoot "release"
$packageRoot = Join-Path $releaseRoot $artifactName
$zipPath = Join-Path $releaseRoot "$artifactName.zip"
$hashPath = "$zipPath.sha256"
$cacheRoot = Join-Path $projectRoot ".cache\node-$NodeVersion-win-x64"
$nodeArchive = Join-Path $cacheRoot "node-v$NodeVersion-win-x64.zip"
$nodeUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
$sumsUrl = "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt"

# 复现性前置检查：必须在创建任何产物目录之前完成，否则被拒绝时已经重写了 release/ 下的目录。
$sourceCommit = & git -C $projectRoot rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw "Cannot determine standalone source commit." }
$sourceStatus = @(& git -C $projectRoot status --porcelain --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw "Cannot determine standalone working tree state." }
if ($sourceStatus.Count -gt 0 -and -not $AllowDirty) {
    $preview = ($sourceStatus | Select-Object -First 10) -join "; "
    throw "Working tree has $($sourceStatus.Count) uncommitted change(s) and the artifact would not be reproducible from a commit: $preview. Commit or stash them first, or pass -AllowDirty to build an explicitly unreproducible artifact."
}

# 溯源前置检查：0.46.0 及其前的产物没有标签，事后只能靠 release/INDEX.md 猜版本（R-7）。
# 正式产物要求同名标签指向当前 HEAD：包内 BUILD-INFO.json 记录的提交因此可以用标签名复述，
# 而不是一个裸哈希。候选产物（-CandidateSuffix）不要求标签，它是明确的一次性构建。
$expectedTag = "v$($packageJson.version)"
if (-not $CandidateSuffix) {
    $tagCommit = & git -C $projectRoot rev-parse -q --verify "refs/tags/$expectedTag^{commit}"
    if ($LASTEXITCODE -ne 0 -or -not "$tagCommit".Trim()) {
        throw "Release $($packageJson.version) has no git tag $expectedTag. Tag the release commit first (git tag -a $expectedTag -m '<version>: <summary>') so the artifact can be traced back to a tag, or build a candidate with -CandidateSuffix."
    }
    if ("$tagCommit".Trim() -ne "$sourceCommit".Trim()) {
        throw "Git tag $expectedTag points at $("$tagCommit".Trim()) but HEAD is $("$sourceCommit".Trim()); the artifact would not be reproducible from the tag. Tag the current commit or package a candidate."
    }
}

# 版本号三处一致（docs/release-process.md §1）：version.ts 由包内 node 复核，package.json 是产物名与
# BUILD-INFO.json 的来源，package-lock.json 会被原样复制进 app/。锁文件曾停在 0.50.1 而产品号已到
# 0.50.15：归档里 app/package.json 与 app/package-lock.json 互相矛盾，而运行时校验只比对前两处，
# 所以这个问题一路放行到打包为止。判据只有一份，放在这里，且在任何产物目录创建之前。
$lockJson = Get-Content -Raw (Join-Path $projectRoot "package-lock.json") | ConvertFrom-Json -AsHashtable
$lockVersions = @($lockJson['version'], $lockJson['packages']['']['version'])
$lockMismatch = @($lockVersions | Where-Object { $_ -ne $packageJson.version })
if ($lockMismatch.Count -gt 0) {
    $lockLabel = (@($lockVersions | Sort-Object -Unique) -join " / ")
    throw "package-lock.json carries version $lockLabel but package.json is at $($packageJson.version). docs/release-process.md section 1 keeps one version across version.ts, package.json and both package-lock.json fields."
}

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

# 出厂配置必须是占位符：真实主机/用户一旦进入发布物就是凭据与拓扑泄露。此处做独立于来源的最后一道闸门，
# 不论 connections.example.json 或中间产物此前被谁改写过，都不允许把非占位配置压进归档。
# 判据取结构化字段而非文本匹配：文本模式容易误伤端口和合法值。
# 归档前会再调用一次同一函数：判据只有一份，两个调用点不可能漂移。
function Assert-FactoryConfig([string]$ConfigPath) {
    $shippedConfig = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
    if ($shippedConfig.connections.Count -ne 1) {
        throw "Refusing to package connections.json: expected exactly one placeholder connection."
    }
    $shippedConnection = $shippedConfig.connections[0]
    if ($shippedConnection.id -ne "w200") {
        throw "Refusing to package connections.json: connection id must be the w200 placeholder."
    }
    if ($shippedConnection.username -ne "DEVELOPER") {
        throw "Refusing to package connections.json: username must be the DEVELOPER placeholder."
    }
    if ($shippedConnection.client -ne "200" -or $shippedConnection.language -ne "EN") {
        throw "Refusing to package connections.json: expected the client 200 / language EN placeholder."
    }
    if (([uri]$shippedConnection.url).Host -notlike "*.invalid") {
        throw "Refusing to package connections.json: host must be a reserved .invalid placeholder."
    }
    if ($shippedConnection.PSObject.Properties.Name -contains "password") {
        throw "Refusing to package connections.json: a password property must never be shipped."
    }
}

New-Item -ItemType Directory -Force -Path $releaseRoot, $cacheRoot | Out-Null

# 打包目录同时就是「可运行包根」：用户常直接从 release/<artifact>/ 启动服务实测，而那个实例会把
# 自己的真实连接配置写回 <packageRoot>\connections.json。若该写入落在「算完哈希」与「打 zip」之间，
# 产物会带着真实主机/用户出厂，且与包内 BUILD-INFO.json 的 fileSha256 不一致
# （2026-09-23 0.47.2 事件：BUILD-INFO 16:41:43 → 配置被改写 16:42:07 → zip 16:42:33）。
# 因此先要求该目录内没有正在运行的实例；归档前另有 Assert-PackagedFilesUnchanged 兜底复检。
$liveFromPackage = @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($packageRoot, [StringComparison]::OrdinalIgnoreCase) }
)
if ($liveFromPackage.Count -gt 0) {
    $liveLabel = ($liveFromPackage | Select-Object -First 5 | ForEach-Object { "$([IO.Path]::GetFileName($_.ExecutablePath))($($_.ProcessId))" }) -join ", "
    throw "A live instance is running from the package directory ($liveLabel). Stop it first: it rewrites $packageRoot\connections.json, so the artifact could ship a real connection while BUILD-INFO.json records a placeholder."
}

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
# 维护诊断批准文件工具：随包发布，操作者可自行取指纹并写批准文件（默认 dry-run），
# 放在 app\scripts 下以便按包内 node_modules 解析 MCP SDK。
Copy-Item -LiteralPath (Join-Path $projectRoot "scripts\prepare-maintenance-approval.mjs") -Destination (Join-Path $appRoot "scripts")

Push-Location $appRoot
try {
    & npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        throw "Production dependency installation failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}
$runtimePackageJson = [ordered]@{
    name = $packageJson.name
    version = $packageJson.version
    private = $true
    type = $packageJson.type
    description = $packageJson.description
    license = $packageJson.license
    engines = $packageJson.engines
    dependencies = $packageJson.dependencies
}
$runtimePackageJson | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $appRoot "package.json") -Encoding utf8

Copy-Item -LiteralPath (Join-Path $projectRoot "packaging\windows\start.ps1") -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "packaging\windows\start.cmd") -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "packaging\windows\configure-codex.ps1") -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "packaging\windows\install-sap-helper.ps1") -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "packaging\windows\setup.ps1") -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "packaging\windows\open-settings.ps1") -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "packaging\windows\open-settings.cmd") -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "packaging\windows\update.ps1") -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "packaging\windows\update.cmd") -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "connections.example.json") -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "packaging\windows\README.md") -Destination (Join-Path $packageRoot "README.md")
Copy-Item -LiteralPath (Join-Path $projectRoot "LICENSE") -Destination $packageRoot

$portableConfig = Get-Content -Raw -LiteralPath (Join-Path $projectRoot "connections.example.json") | ConvertFrom-Json
$portableConfig.connections[0].id = "w200"
$portableConfig.connections[0].passwordEnv = "ABAP_MCP_W200_PASSWORD"
$portableConfig | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $packageRoot "connections.json") -Encoding utf8

Assert-FactoryConfig (Join-Path $packageRoot "connections.json")

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
    # 正式产物的标签（候选产物为空）。它由上面的闸门保证指向 standaloneSourceCommit，
    # 因此产物自身就能说明"这是哪个发布版本"，不必再靠 release/INDEX.md 反查。
    sourceTag = $(if ($CandidateSuffix) { $null } else { $expectedTag })
    standaloneSourceDirty = $sourceStatus.Count -gt 0
    fileHashScope = "All packaged files except node_modules and BUILD-INFO.json; dependencies are pinned by app/package-lock.json."
    fileSha256 = $fileHashes
    builtAt = (Get-Date).ToString("yyyy-MM-ddTHH:mm:sszzz")
}
$buildInfo | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $packageRoot "BUILD-INFO.json") -Encoding utf8

# 收口闸门：哈希与归档之间不允许任何文件发生变化。哈希在 BUILD-INFO.json 之前算，归档在它之后，
# 中间这段时间里任何外部写入——最典型的是从本目录启动的服务改写 connections.json——都会让产物与包内
# fileSha256 不符，并且可能把真实配置带出厂。此处逐文件复检并复跑出厂配置判据，不一致即失败关闭。
$driftedFiles = @()
foreach ($relativePath in $fileHashes.Keys) {
    $absolutePath = Join-Path $packageRoot ($relativePath.Replace("/", [IO.Path]::DirectorySeparatorChar))
    if (-not (Test-Path -LiteralPath $absolutePath -PathType Leaf)) {
        $driftedFiles += "$relativePath (missing)"
        continue
    }
    if ((Get-FileHash -LiteralPath $absolutePath -Algorithm SHA256).Hash -ne $fileHashes[$relativePath]) {
        $driftedFiles += $relativePath
    }
}
if ($driftedFiles.Count -gt 0) {
    throw "Packaged files changed after they were hashed and before the archive was written: $($driftedFiles -join ', '). Something wrote into $packageRoot during packaging; re-run with no instance running from that directory."
}
Assert-FactoryConfig (Join-Path $packageRoot "connections.json")

Compress-Archive -Path (Join-Path $packageRoot "*") -DestinationPath $zipPath -CompressionLevel Optimal
$artifactHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
"$artifactHash  $([IO.Path]::GetFileName($zipPath))" | Set-Content -LiteralPath $hashPath -Encoding ascii

# 归档索引：release/ 目录不纳入版本控制，产物自身的权威溯源信息是包内 BUILD-INFO.json
# （含 standaloneSourceCommit / standaloneSourceDirty / fileSha256）与对应的 git 标签。
$indexPath = Join-Path $releaseRoot "INDEX.md"
if (-not (Test-Path -LiteralPath $indexPath)) {
    $header = @(
        "# ORVANTA 发布归档索引",
        "",
        "本文件由 scripts/package-windows.ps1 追加维护，位于 release/ 目录，不纳入版本控制。",
        "每个产物的权威溯源信息是包内 BUILD-INFO.json 与对应的 git 提交/标签；本索引只便于横向比对。",
        "",
        "| 构建时间 | 版本 | 产物 | SHA-256 | 提交 | 工作树 | Node |",
        "| --- | --- | --- | --- | --- | --- | --- |"
    )
    Set-Content -LiteralPath $indexPath -Value $header -Encoding utf8
}
$commitShort = "$sourceCommit".Trim()
if ($commitShort.Length -gt 7) { $commitShort = $commitShort.Substring(0, 7) }
$dirtyLabel = $(if ($sourceStatus.Count -gt 0) { "dirty($($sourceStatus.Count))" } else { "clean" })
$versionLabel = "$($packageJson.version)"
if ($CandidateSuffix) { $versionLabel += "-$CandidateSuffix" }
$indexRow = "| $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')) | $versionLabel | $([IO.Path]::GetFileName($zipPath)) | $artifactHash | $commitShort | $dirtyLabel | v$NodeVersion |"
Add-Content -LiteralPath $indexPath -Value $indexRow -Encoding utf8

$pruneScript = Join-Path $PSScriptRoot "quarantine-release-artifacts.ps1"
if (Test-Path -LiteralPath $pruneScript) {
    # 保留窗口不是建议而是动作：超出窗口的产物被移入 release/quarantine/（移动而非删除，
    # 保持可逆），同时清掉没有对应 zip 的散落解包目录与历史遗留目录。
    & $pruneScript -ReleaseRoot $releaseRoot -Keep 5 -Apply | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "release/ 保留窗口执行未能清空全部超窗产物；见上方 quarantine 输出。"
    }
} else {
    Write-Warning "未找到 scripts/quarantine-release-artifacts.ps1，跳过 release/ 保留窗口执行。"
}

[pscustomobject]@{
    Package = $packageRoot
    Archive = $zipPath
    Sha256 = $artifactHash
    Node = "v$NodeVersion"
}
