# 潮线 tideline — 一键打包脚本
#
# 用法：pnpm package
#
# 流程：构建 NSIS 安装包 → 复制到 release/ → 计算 SHA256 → 把校验值写回
# docs/发布与签名.md 的「已打包安装包校验值」表格。
#
# 这是「每个版本收尾必须打包」约定的落地实现，避免每次手工敲四条命令。

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

try {
    # 用 .NET 显式按 UTF-8 读：Windows PowerShell 5.1 的 Get-Content 会按系统 ANSI 代码页
    # 解码无 BOM 的 UTF-8 文件，package.json 里的中文描述会被解成乱码并让 JSON 解析失败
    $pkgJson = [System.IO.File]::ReadAllText((Join-Path $root 'package.json'), (New-Object System.Text.UTF8Encoding($false)))
    $pkg = $pkgJson | ConvertFrom-Json
    $version = $pkg.version
    Write-Host "==> 版本 v$version" -ForegroundColor Cyan

    # 1. 构建安装包
    Write-Host '==> 1/4 构建 NSIS 安装包' -ForegroundColor Cyan
    pnpm tauri build --bundles nsis
    if ($LASTEXITCODE -ne 0) { throw "tauri build 失败（退出码 $LASTEXITCODE）" }

    $src = Join-Path $root "src-tauri\target\release\bundle\nsis\tideline_${version}_x64-setup.exe"
    if (-not (Test-Path $src)) { throw "找不到安装包：$src" }

    # 2. 复制到 release/
    Write-Host '==> 2/4 复制到 release/' -ForegroundColor Cyan
    $releaseDir = Join-Path $root 'release'
    New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
    $dest = Join-Path $releaseDir "tideline-$version-win64-setup.exe"
    Copy-Item -Force $src $dest

    # 3. 计算 SHA256
    Write-Host '==> 3/4 计算 SHA256' -ForegroundColor Cyan
    # 直接用 .NET 算，不依赖 Get-FileHash（部分子进程里 PowerShell 模块路径不完整时会找不到该 cmdlet）
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($dest)
    try {
        $hash = ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '')
    }
    finally {
        $stream.Dispose()
        $sha.Dispose()
    }
    $sizeMb = [math]::Round((Get-Item $dest).Length / 1MB, 2)

    # 4. 写回 docs/发布与签名.md 的校验值表
    Write-Host '==> 4/4 记录校验值到 docs/发布与签名.md' -ForegroundColor Cyan
    $docPath = Join-Path $root 'docs\发布与签名.md'
    if (-not (Test-Path $docPath)) { throw "找不到文档：$docPath" }

    # 单引号字符串里的反引号是普通字符，直接写进 Markdown 行模板
    $row = '| V{0} | `release/tideline-{0}-win64-setup.exe` | {1} MiB | `{2}` |' -f $version, $sizeMb, $hash
    $pattern = '^\| V' + [regex]::Escape($version) + '\s'

    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($line in [System.IO.File]::ReadAllLines($docPath)) { $lines.Add($line) }

    $target = -1
    $lastRow = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $pattern) { $target = $i }
        if ($lines[$i] -match '^\| V\d') { $lastRow = $i }
    }

    if ($target -ge 0) {
        $lines[$target] = $row
    }
    elseif ($lastRow -ge 0) {
        $lines.Insert($lastRow + 1, $row)
    }
    else {
        throw 'docs/发布与签名.md 里找不到「已打包安装包校验值」表格'
    }

    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines($docPath, $lines, $utf8)

    Write-Host ''
    Write-Host '打包完成' -ForegroundColor Green
    Write-Host "  安装包：$dest"
    Write-Host "  大小：  $sizeMb MiB"
    Write-Host "  SHA256：$hash"
}
finally {
    Pop-Location
}
