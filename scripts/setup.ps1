# === Antigravity Deck 中文版 -- 一键安装与更新 (Windows PowerShell) ===
# 用法: irm https://raw.githubusercontent.com/ooks37/Antigravity-Deck/main/scripts/setup.ps1 | iex

$ErrorActionPreference = "Stop"
$REPO        = "https://github.com/ooks37/Antigravity-Deck.git"
$REPO_API    = "https://api.github.com/repos/ooks37/Antigravity-Deck"
$INSTALL_DIR = Join-Path $env:LOCALAPPDATA "AntigravityDeck"

# --- 解析目标版本引用（优先环境变量 AG_DECK_REF，其次本仓库正式 Release，默认追踪 main 分支）---
function Get-LatestRef {
    if ($env:AG_DECK_REF) {
        return $env:AG_DECK_REF.Trim()
    }
    # 仅查询当前 fork 仓库自身发布的正式 Release，不回退到从上游同步过来的旧英文 tag
    try {
        $release = Invoke-RestMethod -Uri "$REPO_API/releases/latest" -TimeoutSec 10 2>$null
        if ($release.tag_name) { return $release.tag_name }
    } catch { }
    return "main"
}

Write-Host ""
Write-Host "  Antigravity Deck 中文版 -- 一键安装与更新" -ForegroundColor Cyan
Write-Host "  ==========================================" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  安装位置: $INSTALL_DIR" -ForegroundColor DarkGray
Write-Host ""

# --- 检查前置依赖 ---
$missing = @()

# Node.js
try {
    $nodeVer = (node --version 2>$null)
    $major = [int]($nodeVer -replace '^v(\d+).*', '$1')
    if ($major -lt 18) {
        Write-Host "  [!] 当前 Node.js 版本为 $nodeVer，需要 v18 及以上" -ForegroundColor Yellow
        $missing += "Node.js 18+"
    }
    else {
        Write-Host "  [OK] Node.js $nodeVer" -ForegroundColor Green
    }
}
catch {
    Write-Host "  [X] 未检测到 Node.js" -ForegroundColor Red
    $missing += "Node.js 18+"
}

# Git
try {
    $gitVer = (git --version 2>$null)
    Write-Host "  [OK] $gitVer" -ForegroundColor Green
}
catch {
    Write-Host "  [X] 未检测到 Git" -ForegroundColor Red
    $missing += "Git"
}

# cloudflared (可选 -- 仅公网远程穿透时需要)
$cfFound = $false
try {
    cloudflared --version 2>$null | Out-Null
    $cfFound = $true
}
catch { }

if (-not $cfFound) {
    $cfPaths = @(
        "C:\Program Files (x86)\cloudflared\cloudflared.exe",
        "C:\Program Files\cloudflared\cloudflared.exe"
    )
    foreach ($p in $cfPaths) {
        if (Test-Path $p) {
            $cfFound = $true
            break
        }
    }
}

if ($cfFound) {
    Write-Host "  [OK] cloudflared" -ForegroundColor Green
}
else {
    Write-Host "  [!] 未检测到 cloudflared（可选，仅公网远程穿透时需要）" -ForegroundColor Yellow
}

if ($missing.Count -gt 0) {
    Write-Host ""
    Write-Host "  缺少以下前置依赖:" -ForegroundColor Red
    foreach ($m in $missing) {
        switch ($m) {
            "Node.js 18+" {
                Write-Host "    -> 安装 Node.js: https://nodejs.org/" -ForegroundColor Yellow
            }
            "Git" {
                Write-Host "    -> 安装 Git: https://git-scm.com/" -ForegroundColor Yellow
            }
        }
    }
    Write-Host ""
    Write-Host "  请先安装缺失工具，然后重新运行此脚本。" -ForegroundColor Yellow
    Write-Host ""
    return
}

Write-Host ""

# === 检测安装/更新场景 ===
$scenario = "fresh"       # fresh | up-to-date | updated
$updatedFiles = @()
$targetRef = Get-LatestRef

if (Test-Path "$INSTALL_DIR\.git") {
    Push-Location $INSTALL_DIR

    # 确保 origin 指向当前 fork 仓库
    try { git remote set-url origin $REPO 2>$null | Out-Null } catch { }

    # 记录更新前 commit hash
    $hashBefore = (git rev-parse HEAD 2>$null)

    Write-Host "  [i] 检测到已有安装 -- 正在检查更新..." -ForegroundColor Cyan
    try {
        git fetch origin --tags --quiet 2>$null

        $targetRef = Get-LatestRef
        $targetHash = (git rev-parse --verify "refs/remotes/origin/$targetRef^{commit}" 2>$null)
        if (-not $targetHash) {
            $targetHash = (git rev-parse --verify "$targetRef^{commit}" 2>$null)
        }

        if ($targetHash -and ($hashBefore -eq $targetHash)) {
            $scenario = "up-to-date"
            Write-Host "  [OK] 已是最新版本 ($targetRef)" -ForegroundColor Green
        }
        else {
            Write-Host "  [i] 正在更新至 $targetRef..." -ForegroundColor Yellow

            $ErrorActionPreference = "Continue"
            git show-ref --verify --quiet "refs/remotes/origin/$targetRef" 2>$null
            $hasRemoteBranch = ($LASTEXITCODE -eq 0)
            if ($hasRemoteBranch) {
                git checkout -B $targetRef "origin/$targetRef" --quiet 2>$null
                if ($LASTEXITCODE -ne 0) {
                    git checkout $targetRef --quiet 2>$null
                }
            } else {
                git -c advice.detachedHead=false checkout $targetRef --quiet 2>$null
            }
            $ErrorActionPreference = "Stop"

            $hashAfter = (git rev-parse HEAD 2>$null)

            try {
                $updatedFiles = @(git diff --name-only $hashBefore $hashAfter 2>$null)
            } catch {
                $updatedFiles = @()
            }
            $scenario = "updated"

            Write-Host "  [OK] 已更新至 $targetRef" -ForegroundColor Green
        }
    }
    catch {
        Write-Host "  [!] 拉取更新失败（可能处于离线状态）-- 将继续使用当前版本" -ForegroundColor Yellow
        $scenario = "up-to-date"
    }

    Pop-Location
}
else {
    Write-Host "  [i] 首次安装 -- 正在克隆仓库..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $INSTALL_DIR | Out-Null
    git clone $REPO $INSTALL_DIR
    Push-Location $INSTALL_DIR
    $ErrorActionPreference = "Continue"
    git show-ref --verify --quiet "refs/remotes/origin/$targetRef" 2>$null
    $hasRemoteBranch = ($LASTEXITCODE -eq 0)
    if ($hasRemoteBranch) {
        git checkout -B $targetRef "origin/$targetRef" --quiet 2>$null
        if ($LASTEXITCODE -ne 0) {
            git checkout $targetRef --quiet 2>$null
        }
    } else {
        git -c advice.detachedHead=false checkout $targetRef --quiet 2>$null
    }
    $ErrorActionPreference = "Stop"
    Pop-Location
    Write-Host "  [OK] 已安装 $targetRef" -ForegroundColor Green
}

Push-Location $INSTALL_DIR

# === 按需安装依赖 ===
$needBackendDeps  = $false
$needFrontendDeps = $false

switch ($scenario) {
    "fresh" {
        $needBackendDeps  = $true
        $needFrontendDeps = $true
    }
    "updated" {
        if ($updatedFiles -contains "package.json" -or $updatedFiles -contains "package-lock.json") {
            $needBackendDeps = $true
        }
        $frontendPkgChanged = $updatedFiles | Where-Object {
            $_ -like "frontend/package.json" -or $_ -like "frontend/package-lock.json"
        }
        if ($frontendPkgChanged) {
            $needFrontendDeps = $true
        }

        Write-Host ""
        Write-Host "  本次更新变更摘要:" -ForegroundColor Cyan

        $beFiles  = @($updatedFiles | Where-Object { $_ -notlike "frontend/*" -and $_ -notlike "scripts/*" -and $_ -notlike "docs/*" -and $_ -notlike "electron/*" })
        $feFiles  = @($updatedFiles | Where-Object { $_ -like "frontend/*" })
        $elFiles  = @($updatedFiles | Where-Object { $_ -like "electron/*" })
        $scFiles  = @($updatedFiles | Where-Object { $_ -like "scripts/*" })
        $docFiles = @($updatedFiles | Where-Object { $_ -like "docs/*" })

        if ($beFiles.Count -gt 0)  { Write-Host "    后端:     $($beFiles.Count) 个文件" -ForegroundColor DarkGray }
        if ($feFiles.Count -gt 0)  { Write-Host "    前端:     $($feFiles.Count) 个文件" -ForegroundColor DarkGray }
        if ($elFiles.Count -gt 0)  { Write-Host "    Electron: $($elFiles.Count) 个文件" -ForegroundColor DarkGray }
        if ($scFiles.Count -gt 0)  { Write-Host "    脚本:     $($scFiles.Count) 个文件" -ForegroundColor DarkGray }
        if ($docFiles.Count -gt 0) { Write-Host "    文档:     $($docFiles.Count) 个文件" -ForegroundColor DarkGray }
    }
    "up-to-date" {
        if (-not (Test-Path "node_modules")) {
            $needBackendDeps = $true
        }
        if (-not (Test-Path "frontend/node_modules")) {
            $needFrontendDeps = $true
        }
    }
}

Write-Host ""

if ($needBackendDeps) {
    Write-Host "  [i] 正在安装后端依赖..." -ForegroundColor Cyan
    npm install
}
else {
    Write-Host "  [OK] 后端依赖无变更，跳过安装" -ForegroundColor Green
}

if ($needFrontendDeps) {
    Write-Host ""
    Write-Host "  [i] 正在安装前端依赖..." -ForegroundColor Cyan
    npm install --prefix frontend
}
else {
    Write-Host "  [OK] 前端依赖无变更，跳过安装" -ForegroundColor Green
}

# --- 初始化配置文件 ---
if (-not (Test-Path "settings.json")) {
    Copy-Item "settings.sample.json" "settings.json"
    Write-Host "  [OK] 已从模板生成 settings.json" -ForegroundColor Green
}

# === 启动服务 ===
Write-Host ""
Write-Host "  正在启动 Antigravity Deck..." -ForegroundColor Green
Write-Host ""

if ($cfFound) {
    node start-tunnel.js --quiet --build
} else {
    node start-tunnel.js --local --build
}
