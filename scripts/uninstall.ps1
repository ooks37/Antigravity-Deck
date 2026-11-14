# === Antigravity Deck 中文版 -- 一键卸载 (Windows PowerShell) ===
# 用法: irm https://raw.githubusercontent.com/ooks37/Antigravity-Deck/main/scripts/uninstall.ps1 | iex

$ErrorActionPreference = "SilentlyContinue"
$INSTALL_DIR = Join-Path $env:LOCALAPPDATA "AntigravityDeck"

Write-Host ""
Write-Host "  Antigravity Deck -- 卸载程序" -ForegroundColor Cyan
Write-Host "  ==============================" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  安装位置: $INSTALL_DIR" -ForegroundColor DarkGray
Write-Host ""

if (-not (Test-Path $INSTALL_DIR)) {
    Write-Host "  [i] 无需卸载 -- 未找到安装目录。" -ForegroundColor Yellow
    Write-Host ""
    return
}

# --- 终止占用安装目录的运行中进程 ---
Write-Host "  [i] 正在检查运行中的进程..." -ForegroundColor Cyan

$killed = @()

# Method 1: Find node processes whose command line references the install dir
$procs = Get-WmiObject Win32_Process -Filter "Name = 'node.exe'" 2>$null
foreach ($proc in $procs) {
    try {
        $cmdLine = $proc.CommandLine
        if ($cmdLine -and $cmdLine -like "*$INSTALL_DIR*") {
            Stop-Process -Id $proc.ProcessId -Force 2>$null
            $killed += $proc.ProcessId
            Write-Host "  [OK] 已终止 node.exe (PID $($proc.ProcessId))" -ForegroundColor Green
        }
    } catch { }
}

# Method 2: Kill child processes (next-server, cloudflared) referencing install dir
$allProcs = @("node.exe", "next-server.exe", "cloudflared.exe")
foreach ($procName in $allProcs) {
    $procs2 = Get-WmiObject Win32_Process -Filter "Name = '$procName'" 2>$null
    foreach ($proc in $procs2) {
        try {
            $cmdLine = $proc.CommandLine
            if ($cmdLine -and $cmdLine -like "*AntigravityDeck*") {
                if ($killed -notcontains $proc.ProcessId) {
                    Stop-Process -Id $proc.ProcessId -Force 2>$null
                    $killed += $proc.ProcessId
                    Write-Host "  [OK] 已终止 $procName (PID $($proc.ProcessId))" -ForegroundColor Green
                }
            }
        } catch { }
    }
}

# Method 3: Sysinternals handle.exe if available
$handleTool = $null
foreach ($path in @("handle64.exe", "handle.exe")) {
    if (Get-Command $path -ErrorAction SilentlyContinue) {
        $handleTool = $path
        break
    }
}

if ($handleTool) {
    Write-Host "  [i] 正在扫描占用文件句柄 (Sysinternals)..." -ForegroundColor DarkGray
    $output = & $handleTool $INSTALL_DIR -accepteula 2>$null
    $handlePids = $output | Select-String "pid: (\d+)" | ForEach-Object {
        $_.Matches[0].Groups[1].Value
    } | Sort-Object -Unique
    foreach ($procPid in $handlePids) {
        try {
            Stop-Process -Id ([int]$procPid) -Force 2>$null
            Write-Host "  [OK] 已终止 PID $procPid (via handle scan)" -ForegroundColor Green
        } catch { }
    }
}

if ($killed.Count -gt 0) {
    Write-Host "  [i] 等待进程退出..." -ForegroundColor DarkGray
    Start-Sleep -Seconds 2
} else {
    Write-Host "  [OK] 未发现运行中的进程" -ForegroundColor Green
}

Write-Host ""

# --- Make sure this shell is not CWD inside the install dir ---
if ((Get-Location).Path -like "$INSTALL_DIR*") {
    Set-Location $env:TEMP
}

# --- Delete the install directory ---
Write-Host "  [i] 正在删除 $INSTALL_DIR ..." -ForegroundColor Cyan

# Attempt 1: cmd /c rd -- bypasses PowerShell file locks
$rdArgs = '/c rd /s /q "' + $INSTALL_DIR + '"'
Start-Process "cmd.exe" -ArgumentList $rdArgs -Wait -WindowStyle Hidden
Start-Sleep -Seconds 1

if (-not (Test-Path $INSTALL_DIR)) {
    Write-Host "  [OK] Antigravity Deck 已卸载完成。" -ForegroundColor Green
    Write-Host ""
    return
}

# Attempt 2: robocopy mirror + rd
Write-Host "  [!] 尝试使用 robocopy 清空目录..." -ForegroundColor Yellow
$emptyDir = Join-Path $env:TEMP ("ag_empty_" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $emptyDir | Out-Null
$roboArgs = '"' + $emptyDir + '" "' + $INSTALL_DIR + '" /MIR /NFL /NDL /NJH /NJS /NC /NS /NP'
Start-Process "robocopy.exe" -ArgumentList $roboArgs -Wait -WindowStyle Hidden
Remove-Item -Recurse -Force $emptyDir -ErrorAction SilentlyContinue
$rdArgs2 = '/c rd /s /q "' + $INSTALL_DIR + '"'
Start-Process "cmd.exe" -ArgumentList $rdArgs2 -Wait -WindowStyle Hidden
Start-Sleep -Seconds 1

if (-not (Test-Path $INSTALL_DIR)) {
    Write-Host "  [OK] Antigravity Deck 已卸载完成。" -ForegroundColor Green
    Write-Host ""
    return
}

# Attempt 3: Schedule deletion on next reboot via registry
Write-Host "  [!] 文件仍被占用 -- 尝试安排在下次重启时自动删除..." -ForegroundColor Yellow
try {
    $regPath = "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager"
    $existing = (Get-ItemProperty -Path $regPath -Name "PendingFileRenameOperations" -ErrorAction SilentlyContinue).PendingFileRenameOperations
    $newEntry = "\??\$INSTALL_DIR", ""
    if ($existing) { $newEntry = $existing + $newEntry }
    Set-ItemProperty -Path $regPath -Name "PendingFileRenameOperations" -Value $newEntry -ErrorAction Stop
    Write-Host "  [OK] 已加入重启清理计划，重启系统后将自动删除该目录。" -ForegroundColor Green
    Write-Host "       请重启电脑以完成卸载。" -ForegroundColor DarkGray
} catch {
    Write-Host "  [!] 无法设置重启自动删除（请以管理员身份运行）。" -ForegroundColor Red
    Write-Host "      手动清理方式：关闭所有资源管理器与终端窗口后执行:" -ForegroundColor Yellow
    $manualCmd = 'cmd /c rd /s /q "' + $INSTALL_DIR + '"'
    Write-Host "      $manualCmd" -ForegroundColor White
}

Write-Host ""
